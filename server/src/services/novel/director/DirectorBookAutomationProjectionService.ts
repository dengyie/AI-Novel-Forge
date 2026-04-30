import type {
  DirectorBookAutomationProjection,
  DirectorBookAutomationStatus,
  DirectorBookAutomationTimelineItem,
  DirectorPolicyMode,
  DirectorRuntimeProjection,
} from "@ai-novel/shared/types/directorRuntime";
import { prisma } from "../../../db/prisma";
import { loadPersistentDirectorRuntimeProjection } from "./novelDirectorRuntimeProjection";

type RuntimeProjectionLoader = (taskId: string) => Promise<DirectorRuntimeProjection | null>;

function parseJsonOrNull<T>(value: string | null | undefined): T | null {
  if (!value?.trim()) {
    return null;
  }
  try {
    return JSON.parse(value) as T;
  } catch {
    return null;
  }
}

function toIso(value: Date | string | null | undefined): string {
  if (!value) {
    return new Date(0).toISOString();
  }
  if (value instanceof Date) {
    return value.toISOString();
  }
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? new Date(0).toISOString() : parsed.toISOString();
}

function timestampOf(value: string | null | undefined): number {
  if (!value) {
    return 0;
  }
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? timestamp : 0;
}

function commandLabel(commandType: string): string {
  const labels: Record<string, string> = {
    confirm_candidate: "确认开书方向",
    continue: "继续自动导演",
    resume_from_checkpoint: "从进度点恢复",
    retry: "重试自动导演",
    takeover: "接管这本书",
    repair_chapter_titles: "修复章节标题",
    cancel: "取消自动导演",
  };
  return labels[commandType] ?? commandType;
}

function commandStatusLabel(status: string): string {
  const labels: Record<string, string> = {
    queued: "排队中",
    leased: "准备执行",
    running: "执行中",
    succeeded: "完成",
    failed: "失败",
    cancelled: "已取消",
    stale: "需要恢复",
  };
  return labels[status] ?? status;
}

function workflowStatusToBookStatus(status: string | null | undefined): DirectorBookAutomationStatus {
  if (status === "queued") {
    return "queued";
  }
  if (status === "running") {
    return "running";
  }
  if (status === "waiting_approval") {
    return "waiting_approval";
  }
  if (status === "failed") {
    return "failed";
  }
  if (status === "cancelled") {
    return "cancelled";
  }
  if (status === "succeeded") {
    return "completed";
  }
  return "idle";
}

function runtimeStatusToBookStatus(status: DirectorRuntimeProjection["status"]): DirectorBookAutomationStatus {
  if (status === "waiting_approval") {
    return "waiting_approval";
  }
  if (status === "blocked") {
    return "blocked";
  }
  if (status === "failed") {
    return "failed";
  }
  if (status === "running") {
    return "running";
  }
  if (status === "completed") {
    return "completed";
  }
  return "idle";
}

function extractRunMode(seedPayloadJson: string | null | undefined): string | null {
  const seedPayload = parseJsonOrNull<Record<string, unknown>>(seedPayloadJson);
  if (!seedPayload) {
    return null;
  }
  const direct = seedPayload.runMode;
  if (typeof direct === "string") {
    return direct;
  }
  const directorInput = seedPayload.directorInput;
  if (directorInput && typeof directorInput === "object") {
    const value = (directorInput as { runMode?: unknown }).runMode;
    if (typeof value === "string") {
      return value;
    }
  }
  const directorSession = seedPayload.directorSession;
  if (directorSession && typeof directorSession === "object") {
    const value = (directorSession as { runMode?: unknown }).runMode;
    if (typeof value === "string") {
      return value;
    }
  }
  return null;
}

function buildWhereByNovelOrTask(novelId: string, taskIds: string[]) {
  const uniqueTaskIds = Array.from(new Set(taskIds.filter(Boolean)));
  if (uniqueTaskIds.length === 0) {
    return { novelId };
  }
  return {
    OR: [
      { novelId },
      { taskId: { in: uniqueTaskIds } },
    ],
  };
}

function buildHeadline(input: {
  status: DirectorBookAutomationStatus;
  runtimeProjection: DirectorRuntimeProjection | null;
  task: {
    currentItemLabel?: string | null;
    checkpointSummary?: string | null;
    lastError?: string | null;
  } | null;
}): string {
  if (input.status === "waiting_recovery") {
    return "等待恢复自动导演";
  }
  if (input.runtimeProjection?.headline?.trim()) {
    return input.runtimeProjection.headline.trim();
  }
  if (input.status === "queued") {
    return "AI 自动导演已排队";
  }
  if (input.status === "running") {
    const label = input.task?.currentItemLabel?.trim();
    return label ? `AI 正在推进：${label}` : "AI 正在推进这本书";
  }
  if (input.status === "waiting_approval") {
    return "等待你的确认";
  }
  if (input.status === "blocked") {
    return "自动导演已暂停";
  }
  if (input.status === "failed") {
    return "自动导演遇到问题";
  }
  if (input.status === "cancelled") {
    return "自动导演已取消";
  }
  if (input.status === "completed") {
    return "自动导演完成最近一次推进";
  }
  return "这本书还没有自动导演记录";
}

function buildDetail(input: {
  status: DirectorBookAutomationStatus;
  runtimeProjection: DirectorRuntimeProjection | null;
  task: {
    checkpointSummary?: string | null;
    lastError?: string | null;
    currentItemLabel?: string | null;
  } | null;
}): string | null {
  if (input.status === "waiting_recovery") {
    return input.task?.lastError?.trim() || "后台执行中断后保留了进度点，确认恢复后会从最近进展继续。";
  }
  if (input.runtimeProjection?.detail?.trim()) {
    return input.runtimeProjection.detail.trim();
  }
  if (input.task?.checkpointSummary?.trim()) {
    return input.task.checkpointSummary.trim();
  }
  if (input.status === "failed") {
    return input.task?.lastError?.trim() || "查看执行详情后可选择恢复或重试。";
  }
  if (input.status === "idle") {
    return "可以从 AI 自动导演开始，让系统根据这本书的资产推荐下一步。";
  }
  return input.task?.currentItemLabel?.trim() ?? null;
}

function buildAutomationSummary(input: {
  activeCommandCount: number;
  pendingCommandCount: number;
  artifactSummary: DirectorBookAutomationProjection["artifactSummary"];
  autoApprovalRecordCount: number;
}): string {
  const parts: string[] = [];
  if (input.activeCommandCount > 0) {
    parts.push(`${input.activeCommandCount} 个动作执行中`);
  }
  if (input.pendingCommandCount > 0) {
    parts.push(`${input.pendingCommandCount} 个动作排队中`);
  }
  if (input.autoApprovalRecordCount > 0) {
    parts.push(`${input.autoApprovalRecordCount} 个确认由 AI 自动处理`);
  }
  if (input.artifactSummary.activeCount > 0) {
    parts.push(`${input.artifactSummary.activeCount} 个可用产物`);
  }
  if (input.artifactSummary.staleCount > 0) {
    parts.push(`${input.artifactSummary.staleCount} 个产物需复核`);
  }
  if (input.artifactSummary.repairTicketCount > 0) {
    parts.push(`${input.artifactSummary.repairTicketCount} 个修复项`);
  }
  if (input.artifactSummary.protectedUserContentCount > 0) {
    parts.push(`${input.artifactSummary.protectedUserContentCount} 个用户内容受保护`);
  }
  return parts.length > 0 ? parts.join("，") : "暂无自动化动作";
}

export class DirectorBookAutomationProjectionService {
  constructor(
    private readonly runtimeProjectionLoader: RuntimeProjectionLoader = loadPersistentDirectorRuntimeProjection,
  ) {}

  async getProjection(novelId: string): Promise<DirectorBookAutomationProjection> {
    const latestTask = await prisma.novelWorkflowTask.findFirst({
      where: {
        novelId,
        lane: "auto_director",
      },
      orderBy: { updatedAt: "desc" },
      select: {
        id: true,
        title: true,
        status: true,
        progress: true,
        currentStage: true,
        currentItemKey: true,
        currentItemLabel: true,
        checkpointType: true,
        checkpointSummary: true,
        pendingManualRecovery: true,
        lastError: true,
        seedPayloadJson: true,
        updatedAt: true,
      },
    });
    const latestRun = await prisma.directorRun.findFirst({
      where: { novelId },
      orderBy: { updatedAt: "desc" },
      select: {
        id: true,
        taskId: true,
        policyJson: true,
        updatedAt: true,
      },
    });
    const taskIds = [latestTask?.id, latestRun?.taskId].filter((value): value is string => Boolean(value));
    const whereByNovelOrTask = buildWhereByNovelOrTask(novelId, taskIds);
    const runtimeTaskId = latestTask?.id ?? latestRun?.taskId ?? null;

    const [
      runtimeProjection,
      commands,
      events,
      steps,
      approvalRecords,
      activeArtifactCount,
      staleArtifactCount,
      protectedUserContentCount,
      repairTicketCount,
    ] = await Promise.all([
      runtimeTaskId ? this.runtimeProjectionLoader(runtimeTaskId) : Promise.resolve(null),
      prisma.directorRunCommand.findMany({
        where: whereByNovelOrTask,
        orderBy: { updatedAt: "desc" },
        take: 12,
        select: {
          id: true,
          taskId: true,
          novelId: true,
          commandType: true,
          status: true,
          errorMessage: true,
          createdAt: true,
          updatedAt: true,
          startedAt: true,
          finishedAt: true,
        },
      }),
      prisma.directorEvent.findMany({
        where: whereByNovelOrTask,
        orderBy: { occurredAt: "desc" },
        take: 16,
        select: {
          id: true,
          runId: true,
          taskId: true,
          novelId: true,
          type: true,
          nodeKey: true,
          artifactType: true,
          summary: true,
          affectedScope: true,
          severity: true,
          occurredAt: true,
        },
      }),
      prisma.directorStepRun.findMany({
        where: whereByNovelOrTask,
        orderBy: { updatedAt: "desc" },
        take: 10,
        select: {
          idempotencyKey: true,
          runId: true,
          taskId: true,
          novelId: true,
          nodeKey: true,
          label: true,
          status: true,
          error: true,
          startedAt: true,
          finishedAt: true,
          updatedAt: true,
        },
      }),
      prisma.autoDirectorAutoApprovalRecord.findMany({
        where: { novelId },
        orderBy: { createdAt: "desc" },
        take: 10,
        select: {
          id: true,
          taskId: true,
          approvalPointLabel: true,
          checkpointSummary: true,
          summary: true,
          stage: true,
          scopeLabel: true,
          createdAt: true,
        },
      }),
      prisma.directorArtifact.count({
        where: {
          novelId,
          status: "active",
        },
      }),
      prisma.directorArtifact.count({
        where: {
          novelId,
          status: "stale",
        },
      }),
      prisma.directorArtifact.count({
        where: {
          novelId,
          protectedUserContent: true,
        },
      }),
      prisma.directorArtifact.count({
        where: {
          novelId,
          artifactType: "repair_ticket",
          status: { not: "rejected" },
        },
      }),
    ]);

    const activeCommandCount = commands.filter((item) => item.status === "running" || item.status === "leased").length;
    const pendingCommandCount = commands.filter((item) => item.status === "queued").length;
    const autoApprovalRecordCount = approvalRecords.length;
    const artifactSummary = {
      activeCount: activeArtifactCount,
      staleCount: staleArtifactCount,
      protectedUserContentCount,
      repairTicketCount,
    };
    const policyMode = runtimeProjection?.policyMode
      ?? parseJsonOrNull<{ mode?: DirectorPolicyMode }>(latestRun?.policyJson)?.mode
      ?? null;
    const taskStatus = latestTask?.pendingManualRecovery
      ? "waiting_recovery"
      : workflowStatusToBookStatus(latestTask?.status);
    const runtimeStatus = runtimeProjection ? runtimeStatusToBookStatus(runtimeProjection.status) : "idle";
    const status: DirectorBookAutomationStatus = latestTask?.pendingManualRecovery
      ? "waiting_recovery"
      : activeCommandCount > 0
        ? "running"
        : pendingCommandCount > 0 && runtimeStatus === "idle"
          ? "queued"
          : runtimeStatus !== "idle"
            ? runtimeStatus
            : taskStatus;
    const requiresUserAction = status === "waiting_approval"
      || status === "waiting_recovery"
      || status === "blocked"
      || status === "failed";
    const blockedReason = status === "waiting_recovery"
      ? latestTask?.lastError ?? runtimeProjection?.blockedReason ?? null
      : runtimeProjection?.blockedReason ?? (status === "failed" ? latestTask?.lastError ?? null : null);
    const updatedAt = [
      latestTask?.updatedAt,
      latestRun?.updatedAt,
      commands[0]?.updatedAt,
      events[0]?.occurredAt,
      steps[0]?.updatedAt,
      approvalRecords[0]?.createdAt,
    ]
      .map(toIso)
      .sort((left, right) => timestampOf(right) - timestampOf(left))[0]
      ?? new Date().toISOString();

    const timeline: DirectorBookAutomationTimelineItem[] = [
      ...events.map((event) => ({
        id: `event:${event.id}`,
        type: "event" as const,
        title: event.summary,
        detail: event.affectedScope,
        status: event.type,
        taskId: event.taskId,
        runId: event.runId,
        nodeKey: event.nodeKey,
        artifactType: event.artifactType,
        severity: event.severity as DirectorBookAutomationTimelineItem["severity"],
        occurredAt: toIso(event.occurredAt),
      })),
      ...commands.map((command) => ({
        id: `command:${command.id}`,
        type: "command" as const,
        title: commandLabel(command.commandType),
        detail: command.errorMessage,
        status: commandStatusLabel(command.status),
        taskId: command.taskId,
        commandType: command.commandType,
        occurredAt: toIso(command.finishedAt ?? command.startedAt ?? command.updatedAt ?? command.createdAt),
      })),
      ...steps.map((step) => ({
        id: `step:${step.idempotencyKey}`,
        type: "step" as const,
        title: step.label,
        detail: step.error,
        status: step.status,
        taskId: step.taskId,
        runId: step.runId,
        nodeKey: step.nodeKey,
        occurredAt: toIso(step.finishedAt ?? step.updatedAt ?? step.startedAt),
      })),
      ...approvalRecords.map((record) => ({
        id: `approval:${record.id}`,
        type: "approval" as const,
        title: `AI 自动确认：${record.approvalPointLabel}`,
        detail: record.summary || record.checkpointSummary || record.scopeLabel,
        status: record.stage,
        taskId: record.taskId,
        occurredAt: toIso(record.createdAt),
      })),
      ...(latestTask ? [{
        id: `task:${latestTask.id}`,
        type: "task" as const,
        title: latestTask.currentItemLabel?.trim() || latestTask.title,
        detail: latestTask.checkpointSummary || latestTask.lastError,
        status: latestTask.status,
        taskId: latestTask.id,
        occurredAt: toIso(latestTask.updatedAt),
      }] : []),
    ]
      .sort((left, right) => timestampOf(right.occurredAt) - timestampOf(left.occurredAt))
      .slice(0, 24);

    return {
      novelId,
      latestTask: latestTask
        ? {
          id: latestTask.id,
          title: latestTask.title,
          status: latestTask.status,
          progress: latestTask.progress,
          currentStage: latestTask.currentStage,
          currentItemKey: latestTask.currentItemKey,
          currentItemLabel: latestTask.currentItemLabel,
          checkpointType: latestTask.checkpointType,
          checkpointSummary: latestTask.checkpointSummary,
          pendingManualRecovery: latestTask.pendingManualRecovery,
          lastError: latestTask.lastError,
          updatedAt: toIso(latestTask.updatedAt),
        }
        : null,
      latestRunId: latestRun?.id ?? runtimeProjection?.runId ?? null,
      status,
      runMode: extractRunMode(latestTask?.seedPayloadJson),
      policyMode,
      headline: buildHeadline({ status, runtimeProjection, task: latestTask }),
      detail: buildDetail({ status, runtimeProjection, task: latestTask }),
      currentStage: latestTask?.currentStage ?? runtimeProjection?.currentNodeKey ?? null,
      currentLabel: latestTask?.currentItemLabel ?? runtimeProjection?.currentLabel ?? null,
      requiresUserAction,
      blockedReason,
      nextActionLabel: runtimeProjection?.nextActionLabel ?? null,
      automationSummary: buildAutomationSummary({
        activeCommandCount,
        pendingCommandCount,
        artifactSummary,
        autoApprovalRecordCount,
      }),
      progressSummary: runtimeProjection?.progressSummary ?? null,
      artifactSummary,
      activeCommandCount,
      pendingCommandCount,
      autoApprovalRecordCount,
      latestEventAt: events[0] ? toIso(events[0].occurredAt) : null,
      updatedAt,
      runtimeProjection,
      timeline,
    };
  }
}
