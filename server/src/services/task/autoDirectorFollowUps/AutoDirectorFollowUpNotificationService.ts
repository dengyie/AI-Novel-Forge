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

function extractErrorCode(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null) {
    return undefined;
  }
  return "code" in error ? String((error as { code?: unknown }).code) : undefined;
}

function extractErrorMessage(error: unknown): string {
  if (typeof error === "object" && error !== null && "message" in error) {
    const message = (error as { message?: unknown }).message;
    if (typeof message === "string" && message.trim()) {
      return message.trim();
    }
  }
  return String(error);
}

/**
 * 判断通知写入失败的"可容忍"类别——即只影响红点/外部渠道这类非致命记录，
 * 绝不因此打崩自动导演续跑。容忍并不等于无差别吞错：吞噬路径都会打 console.warn
 * 留下可观测痕迹（P2023/P2009 这类真实数据缺陷尤其要靠告警暴露）。
 *
 * 已知类别（按成因区分，不要混为一谈）：
 *  - schema 漂移，自愈：P2021 表不存在、P2022 列不存在、底层驱动抛出的
 *    "does not exist / no such column / no such table"。根因多为 db push 建库后
 *    再加 schema 字段未回填（见 runtimeMigrations REQUIRED_COLUMN_BACKFILLS），
 *    属自愈、丢了这条记录不影响推进。
 *  - 瞬时基础设施：P1001 及 "can't reach database server"——DB 短暂不可达，
 *    重启/重试后即可恢复，同样不应把整本书标 failed。
 *  - 潜在数据 bug（容忍但掩盖，须告警）：P2023 列数据不一致、P2009 查询解析失败。
 *    容忍是为了不因个别坏数据打崩续跑，但很可能对应真实缺陷，必须可观测。
 *
 * 站内红点与外部渠道通知都是"尽力而为"（best-effort）：写失败只丢一条提醒，
 * 不应让一条非本质的红点记录把整本书的自动导演标记 failed（详见
 * NovelWorkflowRuntimeService.resumePendingAutoDirectorTasks 的恢复失败分支）。
 */
function isTolerableNotificationWriteError(error: unknown): boolean {
  if (!error || typeof error !== "object") {
    return false;
  }
  const code = extractErrorCode(error);
  if (
    code === "P2021"
    || code === "P2022"
    || code === "P2023"
    || code === "P1001"
    || code === "P2009"
  ) {
    return true;
  }
  const message = extractErrorMessage(error);
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

  private static readonly DISABLED_CHANNEL_SETTINGS: AutoDirectorChannelSettings = {
    baseUrl: "",
    dingtalk: { webhookUrl: "", callbackToken: "", operatorMapJson: "", eventTypes: [] },
    wecom: { webhookUrl: "", callbackToken: "", operatorMapJson: "", eventTypes: [] },
  };

  /**
   * 读渠道配置，遇可容忍的 schema/infra 错误时降级为"全部渠道禁用"，
   * 避免打崩续跑流程。站内红点仍在后文独立尝试写入。
   */
  private async readChannelSettingsForNotification(): Promise<AutoDirectorChannelSettings> {
    try {
      return await getAutoDirectorChannelSettings();
    } catch (error) {
      if (isTolerableNotificationWriteError(error)) {
        console.warn(
          `[auto-director.notification] channel settings unavailable (${extractErrorCode(error) ?? "unknown"}): ${extractErrorMessage(error)}; external channels disabled`,
        );
        return AutoDirectorFollowUpNotificationService.DISABLED_CHANNEL_SETTINGS;
      }
      throw error;
    }
  }

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
    const channelSettings = await this.readChannelSettingsForNotification();
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
    const channelSettings = await this.readChannelSettingsForNotification();
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
        console.warn(
          `[auto-director.notification] notification log write swallowed (${extractErrorCode(error) ?? "unknown"}): channel=${input.channelType} event=${input.eventType} task=${input.taskId} ${extractErrorMessage(error)}`,
        );
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
        console.warn(
          `[auto-director.notification] in-app unread write swallowed (${extractErrorCode(error) ?? "unknown"}): event=${input.eventType} task=${input.taskId} ${extractErrorMessage(error)}`,
        );
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
