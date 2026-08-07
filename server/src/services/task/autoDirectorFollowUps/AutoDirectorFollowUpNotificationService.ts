import type {
  AutoDirectorAction,
  AutoDirectorChannelNotificationPayload,
  AutoDirectorEventType,
  AutoDirectorFollowUpReason,
} from "@ai-novel/shared/types/autoDirectorFollowUp";
import type { DirectorAutoApprovalPointCode } from "@ai-novel/shared/types/autoDirectorApproval";
import type { NovelWorkflowCheckpoint } from "@ai-novel/shared/types/novelWorkflow";
import { prisma } from "../../../db/prisma";
import { DingTalkNotifier } from "./DingTalkNotifier";
import { WeComNotifier } from "./WeComNotifier";
import {
  getAutoDirectorChannelSettings,
  type AutoDirectorChannelSettings,
} from "../../settings/AutoDirectorChannelSettingsService";
import {
  buildAutoDirectorEvent,
  detectAutoDirectorEventType,
  deriveAutoDirectorFollowUpState,
  type AutoDirectorEventWorkflowSnapshot,
} from "./autoDirectorFollowUpEventBuilder";
import { resolveAutoDirectorFollowUpReason } from "./autoDirectorFollowUpReasonResolver";
import { extractBlockedAutoDirectorValidationResult } from "./autoDirectorFollowUpValidationResult";

// 触发站内红点的"需处理/关注"事件；progress_changed 是推进噪声，不惊扰红点。
const IN_APP_ATTENTION_EVENT_TYPES: ReadonlySet<string> = new Set([
  "auto_director.approval_required",
  "auto_director.auto_approved",
  "auto_director.exception",
  "auto_director.recovered",
  "auto_director.completed",
]);

/**
 * 判断通知写入失败是否属于"可容忍的 schema/infra 漂移"——即只影响红点/外部渠道
 * 这类非致命记录，绝不应因此打崩自动导演续跑。
 *
 * 已知类别：
 *  - P2021：表不存在（db push 建库、无 SQL 迁移的场景）
 *  - P2022：列不存在（本次产线事故根因：readAt 后加进 schema 但产库未再 push）
 *  - P2023：列数据不一致
 *  - P2009：查询解析失败（schema 漂移）
 *  - P1001 及 "can't reach database server"：DB 短暂不可达
 *  - "does not exist / no such column / no such table"：底层驱动抛出的 schema 漂移
 *
 * 站内红点与外部渠道通知都是"尽力而为"（best-effort）：写失败只丢一条提醒，
 * 不应让一条非本质的红点记录把整本书的自动导演标记 failed（详见
 * NovelWorkflowRuntimeService.resumePendingAutoDirectorTasks 的恢复失败分支）。
 */
function isTolerableNotificationWriteError(error: unknown): boolean {
  if (!error || typeof error !== "object") {
    return false;
  }
  const code = "code" in error ? (error as { code?: string }).code : undefined;
  if (
    code === "P2021"
    || code === "P2022"
    || code === "P2023"
    || code === "P1001"
    || code === "P2009"
  ) {
    return true;
  }
  const message = "message" in error ? String((error as { message?: unknown }).message ?? "") : "";
  return /does not exist in the current database/i.test(message)
    || /no such column/i.test(message)
    || /no such table/i.test(message)
    || /can't reach database server/i.test(message);
}

function parseExecutionScopeLabel(seedPayloadJson: string | null | undefined): string | null {
  if (!seedPayloadJson?.trim()) {
    return null;
  }
  try {
    const parsed = JSON.parse(seedPayloadJson) as {
      autoExecution?: {
        scopeLabel?: unknown;
      };
    };
    return typeof parsed.autoExecution?.scopeLabel === "string" && parsed.autoExecution.scopeLabel.trim()
      ? parsed.autoExecution.scopeLabel.trim()
      : null;
  } catch {
    return null;
  }
}

function parseReplacementTaskId(seedPayloadJson: string | null | undefined): string | null {
  if (!seedPayloadJson?.trim()) {
    return null;
  }
  try {
    const parsed = JSON.parse(seedPayloadJson) as {
      replacementTaskId?: unknown;
    };
    return typeof parsed.replacementTaskId === "string" && parsed.replacementTaskId.trim()
      ? parsed.replacementTaskId.trim()
      : null;
  } catch {
    return null;
  }
}

function buildAutoApprovalNotificationCopy(checkpointType: NovelWorkflowCheckpoint): {
  cardTitle: string;
  reasonLabel: string;
} {
  if (checkpointType === "replan_required") {
    return {
      cardTitle: "AI 已记录重规划提醒并继续推进",
      reasonLabel: "重规划提醒已记录",
    };
  }
  return {
    cardTitle: "AI 已自动通过并继续推进",
    reasonLabel: "最近自动通过",
  };
}

function resolveReasonInput(input: AutoDirectorEventWorkflowSnapshot) {
  return {
    status: input.status,
    checkpointType: input.checkpointType,
    pendingManualRecovery: input.pendingManualRecovery,
    executionScopeLabel: parseExecutionScopeLabel(input.seedPayloadJson),
    replacementTaskId: parseReplacementTaskId(input.seedPayloadJson),
    validationResult: extractBlockedAutoDirectorValidationResult(input.seedPayloadJson),
  };
}

export class AutoDirectorFollowUpNotificationService {
  private readonly dingTalkNotifier = new DingTalkNotifier();

  private readonly weComNotifier = new WeComNotifier();

  async handleTaskTransition(input: {
    before: AutoDirectorEventWorkflowSnapshot | null;
    after: AutoDirectorEventWorkflowSnapshot | null;
  }): Promise<void> {
    if (!input.after?.id) {
      return;
    }
    const before = deriveAutoDirectorFollowUpState(input.before);
    const after = deriveAutoDirectorFollowUpState(input.after);
    const eventType = detectAutoDirectorEventType({
      before,
      after,
      afterStatus: input.after.status ?? null,
    });
    if (!after || !eventType) {
      return;
    }

    const occurredAt = input.after.updatedAt ?? new Date();
    const event = buildAutoDirectorEvent({
      eventType,
      after,
      occurredAt,
    });
    const channelSettings = await getAutoDirectorChannelSettings();
    await this.notifyDingTalk({
      event,
      after: input.after,
      channelSettings,
    });
    await this.notifyWeCom({
      event,
      after: input.after,
      channelSettings,
    });
    await this.recordInAppUnread({
      eventType: event.eventType,
      taskId: event.taskId,
      summary: event.summary,
      stage: event.stage,
      reason: event.reason,
      novelTitle: input.after.novel?.title?.trim() ?? null,
      occurredAt,
    });
  }

  async notifyAutoApproved(input: {
    taskId: string;
    novelId: string | null;
    novelTitle: string;
    checkpointType: NovelWorkflowCheckpoint;
    checkpointSummary?: string | null;
    approvalPointCode: DirectorAutoApprovalPointCode;
    approvalPointLabel: string;
    stage?: string | null;
    summary: string;
    occurredAt: Date;
  }): Promise<void> {
    const copy = buildAutoApprovalNotificationCopy(input.checkpointType);
    const after = {
      taskId: input.taskId,
      novelId: input.novelId,
      novelTitle: input.novelTitle,
      summary: input.summary,
      reason: "auto_approval_completed" as const,
      reasonLabel: copy.reasonLabel,
      availableMutationActions: [],
      stage: input.stage ?? null,
      checkpointType: input.checkpointType,
      checkpointSummary: input.checkpointSummary ?? null,
      progressBucket: null,
      executionScopeLabel: null,
    };
    const event = buildAutoDirectorEvent({
      eventType: "auto_director.auto_approved",
      after,
      occurredAt: input.occurredAt,
    });
    const channelSettings = await getAutoDirectorChannelSettings();
    const snapshot: AutoDirectorEventWorkflowSnapshot = {
      id: input.taskId,
      novelId: input.novelId,
      status: "running",
      currentStage: input.stage ?? null,
      checkpointType: input.checkpointType,
      checkpointSummary: input.checkpointSummary ?? null,
      currentItemLabel: input.summary,
      pendingManualRecovery: false,
      updatedAt: input.occurredAt,
      novel: {
        title: input.novelTitle,
      },
    };
    await this.notifyDingTalk({
      event,
      after: snapshot,
      channelSettings,
      cardTitle: copy.cardTitle,
      reasonLabel: copy.reasonLabel,
      availableActions: [],
    });
    await this.notifyWeCom({
      event,
      after: snapshot,
      channelSettings,
      cardTitle: copy.cardTitle,
      reasonLabel: copy.reasonLabel,
      availableActions: [],
    });
    await this.recordInAppUnread({
      eventType: event.eventType,
      taskId: event.taskId,
      summary: input.summary,
      stage: input.stage ?? null,
      reason: "auto_approval_completed",
      novelTitle: input.novelTitle ?? null,
      occurredAt: input.occurredAt,
    });
  }

  private resolveAvailableActions(input: AutoDirectorEventWorkflowSnapshot): AutoDirectorAction[] {
    const resolved = resolveAutoDirectorFollowUpReason(resolveReasonInput(input));
    return resolved?.availableActions ?? [];
  }

  private async notifyDingTalk(input: {
    event: ReturnType<typeof buildAutoDirectorEvent>;
    after: AutoDirectorEventWorkflowSnapshot;
    channelSettings: AutoDirectorChannelSettings;
    cardTitle?: string;
    reasonLabel?: string | null;
    availableActions?: AutoDirectorAction[];
  }) {
    const channelConfig = input.channelSettings.dingtalk;
    if (!this.dingTalkNotifier.isEnabled(channelConfig)) {
      return;
    }
    if (!this.isEventEnabledForChannel(channelConfig.eventTypes, input.event.eventType)) {
      return;
    }
    const reasonResolved = resolveAutoDirectorFollowUpReason(resolveReasonInput(input.after));
    const payload = this.dingTalkNotifier.buildPayload({
      event: input.event,
      taskId: input.after.id,
      novelId: input.after.novelId,
      novelTitle: input.after.novel?.title?.trim() || input.after.id,
      reasonLabel: input.reasonLabel ?? reasonResolved?.reasonLabel ?? null,
      checkpointSummary: input.after.checkpointSummary ?? null,
      stage: input.after.currentStage,
      availableActions: input.availableActions ?? this.resolveAvailableActions(input.after),
      channelConfig,
      baseUrl: input.channelSettings.baseUrl,
      cardTitle: input.cardTitle,
    });

    let responseStatus = null;
    let responseBody = null;
    let deliveredAt = null;
    let status: "delivered" | "failed" = "failed";
    let target: string | null = null;

    try {
      const delivered = await this.dingTalkNotifier.deliver(payload, channelConfig);
      target = delivered.target;
      responseStatus = delivered.status;
      responseBody = delivered.body;
      if (typeof delivered.status === "number" && delivered.status >= 200 && delivered.status < 300) {
        status = "delivered";
        deliveredAt = new Date();
      }
    } catch (error) {
      responseBody = error instanceof Error ? error.message : "delivery_failed";
    }

    await this.recordNotificationLog({
      eventId: input.event.eventId,
      eventType: input.event.eventType,
      taskId: input.after.id,
      channelType: "dingtalk",
      target,
      payload,
      responseBody,
      responseStatus,
      deliveredAt,
      status,
    });
  }

  private async notifyWeCom(input: {
    event: ReturnType<typeof buildAutoDirectorEvent>;
    after: AutoDirectorEventWorkflowSnapshot;
    channelSettings: AutoDirectorChannelSettings;
    cardTitle?: string;
    reasonLabel?: string | null;
    availableActions?: AutoDirectorAction[];
  }) {
    const channelConfig = input.channelSettings.wecom;
    if (!this.weComNotifier.isEnabled(channelConfig)) {
      return;
    }
    if (!this.isEventEnabledForChannel(channelConfig.eventTypes, input.event.eventType)) {
      return;
    }
    const reasonResolved = resolveAutoDirectorFollowUpReason(resolveReasonInput(input.after));
    const payload = this.weComNotifier.buildPayload({
      event: input.event,
      taskId: input.after.id,
      novelId: input.after.novelId,
      novelTitle: input.after.novel?.title?.trim() || input.after.id,
      reasonLabel: input.reasonLabel ?? reasonResolved?.reasonLabel ?? null,
      checkpointSummary: input.after.checkpointSummary ?? null,
      stage: input.after.currentStage,
      availableActions: input.availableActions ?? this.resolveAvailableActions(input.after),
      channelConfig,
      baseUrl: input.channelSettings.baseUrl,
      cardTitle: input.cardTitle,
    });

    let responseStatus = null;
    let responseBody = null;
    let deliveredAt = null;
    let status: "delivered" | "failed" = "failed";
    let target: string | null = null;

    try {
      const delivered = await this.weComNotifier.deliver(payload, channelConfig);
      target = delivered.target;
      responseStatus = delivered.status;
      responseBody = delivered.body;
      if (typeof delivered.status === "number" && delivered.status >= 200 && delivered.status < 300) {
        status = "delivered";
        deliveredAt = new Date();
      }
    } catch (error) {
      responseBody = error instanceof Error ? error.message : "delivery_failed";
    }

    await this.recordNotificationLog({
      eventId: input.event.eventId,
      eventType: input.event.eventType,
      taskId: input.after.id,
      channelType: "wecom",
      target,
      payload,
      responseBody,
      responseStatus,
      deliveredAt,
      status,
    });
  }

  private async recordNotificationLog(input: {
    eventId: string;
    eventType: AutoDirectorEventType;
    taskId: string;
    channelType: "dingtalk" | "wecom";
    target: string | null;
    payload: AutoDirectorChannelNotificationPayload;
    responseBody: string | null;
    responseStatus: number | null;
    deliveredAt: Date | null;
    status: "delivered" | "failed";
  }) {
    try {
      await prisma.autoDirectorFollowUpNotificationLog.create({
        data: {
          eventId: input.eventId,
          eventType: input.eventType,
          taskId: input.taskId,
          channelType: input.channelType,
          target: input.target,
          requestPayload: JSON.stringify(input.payload),
          responseBody: input.responseBody,
          responseStatus: input.responseStatus,
          attemptCount: 1,
          deliveredAt: input.deliveredAt,
          status: input.status,
        },
      });
    } catch (error) {
      if (isTolerableNotificationWriteError(error)) {
        return;
      }
      throw error;
    }
  }

  /**
   * 站内红点：仅在"需处理/关注"事件发生时落一条 channelType="inapp" 未读记录。
   * readAt NULL = 未读 → GET /unread 计数来自这里；用户打开跟进中心后 markAllNotificationsRead 置 readAt。
   * progress 推进噪声不写，避免红点常亮；外部渠道 dingtalk/wecom 配置与否都独立记录，互不阻塞。
   */
  private async recordInAppUnread(input: {
    eventType: AutoDirectorEventType;
    taskId: string;
    summary: string;
    stage: string | null;
    reason: AutoDirectorFollowUpReason | null;
    novelTitle: string | null;
    occurredAt: Date;
  }): Promise<void> {
    if (!IN_APP_ATTENTION_EVENT_TYPES.has(input.eventType)) {
      return;
    }
    const eventId = `${input.taskId}:${input.eventType}:${input.occurredAt.toISOString()}:${Math.random().toString(36).slice(2, 8)}`;
    const requestPayload = JSON.stringify({
      summary: input.summary,
      stage: input.stage,
      reason: input.reason,
      novelTitle: input.novelTitle,
    });
    try {
      await prisma.autoDirectorFollowUpNotificationLog.create({
        data: {
          eventId,
          eventType: input.eventType,
          taskId: input.taskId,
          channelType: "inapp",
          target: null,
          requestPayload,
          responseBody: null,
          responseStatus: null,
          attemptCount: 1,
          deliveredAt: input.occurredAt,
          status: "delivered",
          readAt: null,
        },
      });
    } catch (error) {
      if (isTolerableNotificationWriteError(error)) {
        return;
      }
      throw error;
    }
  }

  private isEventEnabledForChannel(eventTypes: string[] | undefined, eventType: AutoDirectorEventType): boolean {
    const subscribed = new Set((eventTypes ?? []).map((item) => item.trim()).filter(Boolean));
    if (subscribed.size === 0) {
      return eventType !== "auto_director.progress_changed";
    }
    return subscribed.has(eventType);
  }
}
