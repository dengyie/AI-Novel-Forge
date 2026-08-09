import { buildDirectorBudgetLedgerSummary } from "../../novel/qualityLoopBudget";
import type {
  DirectorWorkflowSeedPayload,
} from "../../novel/director/runtime/novelDirectorHelpers";
import {
  parseSeedPayload,
} from "../../novel/workflow/novelWorkflow.shared";
import type {
  AutoDirectorChannelDeliveryStatus,
  AutoDirectorFollowUpDetail,
  AutoDirectorFollowUpItem,
  AutoDirectorFollowUpListInput,
  AutoDirectorFollowUpListResponse,
  AutoDirectorFollowUpOverview,
} from "@ai-novel/shared/types/autoDirectorFollowUp";
import {
  AUTO_DIRECTOR_CHANNEL_TYPES,
} from "@ai-novel/shared/types/autoDirectorFollowUp";
import { prisma } from "../../../db/prisma";
import { NovelWorkflowService } from "../../novel/workflow/NovelWorkflowService";
import { NovelWorkflowTaskAdapter } from "../adapters/NovelWorkflowTaskAdapter";
import {
  getArchivedTaskIds,
  isTaskArchived,
} from "../taskArchive";
import { getAutoDirectorChannelSettings } from "../../settings/AutoDirectorChannelSettingsService";
import {
  buildAvailableReasons,
  buildAvailableSections,
  buildAvailableStatuses,
  buildCounters,
  buildMilestones,
  buildSectionCounters,
  buildSummaryCounters,
  compareFollowUpItems,
  decorateDetailActions,
  getReplacementTaskId,
  matchesItemFilters,
  matchesRowScopeFilters,
  normalizeWorkflowRow,
  projectAutoApprovalRecordItem,
  projectFollowUpItem,
  type FollowUpWorkflowRow,
  type RawFollowUpWorkflowRow,
} from "./autoDirectorFollowUpProjection";
import { loadRecentAutoDirectorAutoApprovalRecords } from "./autoDirectorAutoApprovalAudit";
import {
  extractErrorCode,
  extractErrorMessage,
  isTolerableNotificationError,
} from "./autoDirectorFollowUpErrorTolerance";

export class AutoDirectorFollowUpService {
  readonly workflowService = new NovelWorkflowService();

  private readonly workflowTaskAdapter = new NovelWorkflowTaskAdapter();

  async getOverview(): Promise<AutoDirectorFollowUpOverview> {
    const rows = await this.loadRows({ heal: false });
    const knownTaskIds = new Set(rows.map((row) => row.id));
    const taskById = new Map(rows.map((row) => [row.id, row]));
    const channelSettings = await getAutoDirectorChannelSettings();
    const taskItems = rows
      .map((row) => projectFollowUpItem(row, knownTaskIds, channelSettings))
      .filter((item): item is AutoDirectorFollowUpItem => Boolean(item));
    const autoApprovalItems = await this.loadAutoApprovalItems(rows, taskById);
    const items = taskItems.concat(autoApprovalItems);

    return {
      totalCount: items.length,
      countersByReason: buildCounters(items),
      countersBySection: buildSectionCounters(items),
    };
  }

  async list(input: AutoDirectorFollowUpListInput = {}): Promise<AutoDirectorFollowUpListResponse> {
    const rows = await this.loadRows();
    const knownTaskIds = new Set(rows.map((row) => row.id));
    const taskById = new Map(rows.map((row) => [row.id, row]));
    const channelSettings = await getAutoDirectorChannelSettings();
    const scopedRows = rows.filter((row) => matchesRowScopeFilters(row, input));
    const scopedTaskItems = scopedRows
      .map((row) => projectFollowUpItem(row, knownTaskIds, channelSettings))
      .filter((item): item is AutoDirectorFollowUpItem => Boolean(item));
    const scopedItems = scopedTaskItems.concat(await this.loadAutoApprovalItems(scopedRows, taskById));
    const filteredItems = scopedItems
      .filter((item) => matchesItemFilters(item, input))
      .sort(compareFollowUpItems);

    const page = Math.max(1, input.page ?? 1);
    const pageSize = Math.max(1, input.pageSize ?? 20);
    const start = (page - 1) * pageSize;

    return {
      items: filteredItems.slice(start, start + pageSize),
      countersByReason: buildCounters(filteredItems),
      countersBySection: buildSectionCounters(filteredItems),
      summaryCounters: buildSummaryCounters(scopedRows, filteredItems),
      availableFilters: {
        sections: buildAvailableSections(scopedItems),
        reasons: buildAvailableReasons(filteredItems),
        statuses: buildAvailableStatuses(filteredItems),
        channelTypes: [...AUTO_DIRECTOR_CHANNEL_TYPES],
      },
      pagination: {
        page,
        pageSize,
        total: filteredItems.length,
      },
    };
  }

  async getDetail(taskId: string, options: { heal?: boolean } = {}): Promise<AutoDirectorFollowUpDetail | null> {
    if (await isTaskArchived("novel_workflow", taskId)) {
      return null;
    }

    if (options.heal !== false) {
      await this.workflowService.healAutoDirectorTaskState(taskId);
    }

    const rawRow = await prisma.novelWorkflowTask.findUnique({
      where: { id: taskId },
      include: {
        novel: {
          select: {
            title: true,
          },
        },
      },
    }) as RawFollowUpWorkflowRow | null;
    const row = rawRow ? normalizeWorkflowRow(rawRow) : null;
    if (!row) {
      return null;
    }

    const knownTaskIds = new Set([row.id]);
    const replacementTaskId = getReplacementTaskId(row.seedPayloadJson);
    if (replacementTaskId) {
      const replacement = await prisma.novelWorkflowTask.findUnique({
        where: { id: replacementTaskId },
        select: { id: true },
      });
      if (replacement) {
        knownTaskIds.add(replacement.id);
      }
    }
    const item = projectFollowUpItem(row, knownTaskIds, await getAutoDirectorChannelSettings());
    if (!item) {
      return null;
    }

    const task = await this.workflowTaskAdapter.detail(taskId, {
      heal: options.heal,
    });
    if (!task) {
      return null;
    }

    const originDetailUrl = `/tasks?kind=novel_workflow&id=${taskId}`;
    const candidateSelectionUrl = item.availableActions.some((action) => action.code === "go_candidate_selection")
      ? task.sourceRoute
      : null;
    const replanUrl = item.availableActions.some((action) => action.code === "go_replan")
      ? task.sourceRoute
      : null;
    const budgetLedgerSummary = buildDirectorBudgetLedgerSummary(
      parseSeedPayload<DirectorWorkflowSeedPayload>(row.seedPayloadJson)?.autoExecution,
    );

    return {
      directorTaskId: taskId,
      taskId,
      reasonLabel: item.reasonLabel,
      priority: item.priority,
      followUpSummary: item.followUpSummary,
      checkpointSummary: row.checkpointSummary,
      blockingReason: item.blockingReason,
      nextStepSuggestion: task.nextActionLabel ?? task.resumeAction ?? item.availableActions[0]?.label ?? null,
      validationSummary: item.validationSummary ?? null,
      currentModel: item.currentModel,
      riskNote: null,
      originDetailUrl,
      replanUrl,
      candidateSelectionUrl,
      availableActions: decorateDetailActions({
        actions: item.availableActions,
        originDetailUrl,
        candidateSelectionUrl,
        replanUrl,
      }),
      milestones: buildMilestones(row),
      channelDeliveries: await this.getRecentChannelDeliveries(taskId),
      task,
      budgetLedgerSummary,
    };
  }

  private async getRecentChannelDeliveries(taskId: string): Promise<AutoDirectorChannelDeliveryStatus[]> {
    try {
      const rows = await prisma.autoDirectorFollowUpNotificationLog.findMany({
        where: {
          taskId,
          // 站内红点（inapp）行不在外部渠道送达列表里呈现（它们不是授权 webhook 投递）。
          channelType: {
            not: "inapp",
          },
        },
        orderBy: [{ createdAt: "desc" }, { id: "desc" }],
        take: 10,
      });
      const latestByChannel = new Map<string, typeof rows[number]>();
      for (const row of rows) {
        if (!latestByChannel.has(row.channelType)) {
          latestByChannel.set(row.channelType, row);
        }
      }
      return Array.from(latestByChannel.values()).map((row) => ({
        channelType: row.channelType === "wecom" ? "wecom" : "dingtalk",
        status: row.status === "delivered" ? "delivered" : (row.status === "pending" ? "pending" : "failed"),
        deliveredAt: row.deliveredAt?.toISOString() ?? null,
        responseStatus: row.responseStatus ?? null,
        eventType: row.eventType as AutoDirectorChannelDeliveryStatus["eventType"],
        target: row.target ?? null,
      }));
    } catch (error) {
      if (isTolerableNotificationError(error)) {
        console.warn(
          `[auto-director.notification] delivery status read degraded (${extractErrorCode(error) ?? "unknown"}): ${extractErrorMessage(error)}`,
        );
        return [];
      }
      throw error;
    }
  }

  /**
   * 站内未读红点计数。仅统计 channelType="inapp" 且 readAt IS NULL 的行。
   * 外部渠道（dingtalk/wecom）行 readAt 恒为 NULL，但 channelType 过滤排除了它们。
   * 表缺失 / 列缺失（schema 漂移，如 readAt 未回填）/ DB 不可用时安全返回 0
   * （首次部署 / 迁移过渡期），不因个别红点记录打崩跟进中心接口。
   */
  async getUnreadCount(): Promise<{ unreadCount: number }> {
    try {
      const unreadCount = await prisma.autoDirectorFollowUpNotificationLog.count({
        where: {
          channelType: "inapp",
          readAt: null,
        },
      });
      return { unreadCount };
    } catch (error) {
      if (isTolerableNotificationError(error)) {
        console.warn(
          `[auto-director.notification] unread count read degraded (${extractErrorCode(error) ?? "unknown"}): ${extractErrorMessage(error)}`,
        );
        return { unreadCount: 0 };
      }
      throw error;
    }
  }

  /**
   * 将全部站内未读通知标为已读（readAt = now）。
   * 用户在打开跟进中心页面或点击红点后调用该接口。
   * 返回本次标记的行数（语义上 = 清除的红点数）。
   */
  async markAllNotificationsRead(): Promise<{ updated: number }> {
    try {
      const result = await prisma.autoDirectorFollowUpNotificationLog.updateMany({
        where: {
          channelType: "inapp",
          readAt: null,
        },
        data: {
          readAt: new Date(),
        },
      });
      return { updated: result.count };
    } catch (error) {
      if (isTolerableNotificationError(error)) {
        console.warn(
          `[auto-director.notification] mark read degraded (${extractErrorCode(error) ?? "unknown"}): ${extractErrorMessage(error)}`,
        );
        return { updated: 0 };
      }
      throw error;
    }
  }

  private async loadAutoApprovalItems(
    rows: FollowUpWorkflowRow[],
    taskById: ReadonlyMap<string, FollowUpWorkflowRow>,
  ): Promise<AutoDirectorFollowUpItem[]> {
    const novelIds = rows
      .map((row) => row.novelId)
      .filter((novelId): novelId is string => Boolean(novelId?.trim()));
    const records = await loadRecentAutoDirectorAutoApprovalRecords(novelIds);
    return records
      .filter((record) => {
        const parentTask = taskById.get(record.taskId);
        if (!parentTask) return true;
        return parentTask.status !== "succeeded" && parentTask.status !== "cancelled";
      })
      .map((record) => projectAutoApprovalRecordItem({
        ...record,
        novel: taskById.get(record.taskId)?.novel ?? null,
      }, taskById));
  }

  private async loadRows(options: { heal?: boolean } = {}): Promise<FollowUpWorkflowRow[]> {
    const archivedIds = await getArchivedTaskIds("novel_workflow");
    const rows = await this.fetchRows(archivedIds);
    if (options.heal === false) {
      return rows;
    }
    const healed = await Promise.all(
      rows.map((row) => this.workflowService.healAutoDirectorTaskState(row.id, row)),
    );
    if (!healed.some(Boolean)) {
      return rows;
    }
    return this.fetchRows(archivedIds);
  }

  private async fetchRows(archivedIds: string[]): Promise<FollowUpWorkflowRow[]> {
    const rawRows = await prisma.novelWorkflowTask.findMany({
      where: {
        lane: "auto_director",
        ...(archivedIds.length > 0
          ? {
            id: {
              notIn: archivedIds,
            },
          }
          : {}),
      },
      select: {
        id: true,
        novelId: true,
        lane: true,
        title: true,
        status: true,
        currentStage: true,
        currentItemKey: true,
        currentItemLabel: true,
        checkpointType: true,
        checkpointSummary: true,
        resumeTargetJson: true,
        seedPayloadJson: true,
        milestonesJson: true,
        pendingManualRecovery: true,
        attemptCount: true,
        lastError: true,
        finishedAt: true,
        updatedAt: true,
        novel: {
          select: {
            title: true,
          },
        },
      },
      orderBy: [{ updatedAt: "desc" }, { id: "desc" }],
    }) as RawFollowUpWorkflowRow[];

    return rawRows
      .map((row) => normalizeWorkflowRow(row))
      .filter((row): row is FollowUpWorkflowRow => Boolean(row));
  }
}
