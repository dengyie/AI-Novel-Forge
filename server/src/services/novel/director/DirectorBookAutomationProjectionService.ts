import type {
  DirectorBookAutomationProjection,
  DirectorBookAutomationStatus,
  DirectorBookAutomationTimelineItem,
  DirectorPolicyMode,
  DirectorRuntimeProjection,
} from "@ai-novel/shared/types/directorRuntime";
import { getDirectorNodeDisplayLabel } from "@ai-novel/shared/types/directorRuntime";
import { prisma } from "../../../db/prisma";
import { loadPersistentDirectorRuntimeProjection } from "./novelDirectorRuntimeProjection";
import { directorArtifactLedgerQueryService } from "./runtime/DirectorArtifactLedgerQueryService";
import { directorUsageTelemetryQueryService } from "./runtime/DirectorUsageTelemetryQueryService";
import {
  buildAutomationSummary,
  buildDetail,
  buildDisplayState,
  buildFocusNovel,
  buildHeadline,
  buildPrimaryAction,
  buildSecondaryActions,
  buildUserHeadline,
  buildUserReason,
  buildWhereByNovelOrTask,
  commandLabel,
  commandStatusLabel,
  extractCircuitBreaker,
  extractRunMode,
  mapStepForUsage,
  parseJsonOrNull,
  runtimeStatusToBookStatus,
  timestampOf,
  toIso,
  workflowStatusToBookStatus,
} from "./DirectorBookAutomationProjectionModel";

type RuntimeProjectionLoader = (taskId: string) => Promise<DirectorRuntimeProjection | null>;

export class DirectorBookAutomationProjectionService {
  constructor(
    private readonly runtimeProjectionLoader: RuntimeProjectionLoader = loadPersistentDirectorRuntimeProjection,
  ) {}

  async getProjection(novelId: string): Promise<DirectorBookAutomationProjection> {
    const novel = await prisma.novel.findUnique({
      where: { id: novelId },
      select: {
        id: true,
        title: true,
      },
    });
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
    const taskIds = Array.from(new Set(
      [latestTask?.id, latestRun?.taskId].filter((value): value is string => Boolean(value)),
    ));
    const whereByNovelOrTask = buildWhereByNovelOrTask(novelId, taskIds);
    const runtimeTaskId = latestTask?.id ?? latestRun?.taskId ?? null;

    const [
      runtimeProjection,
      commands,
      events,
      steps,
      approvalRecords,
      artifactSummary,
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
      directorArtifactLedgerQueryService.getBookSummary(novelId),
    ]);
    const usageTelemetry = await directorUsageTelemetryQueryService.getBookUsage({
      novelId,
      taskIds,
      steps: steps.map(mapStepForUsage),
    });

    const activeCommandCount = commands.filter((item) => item.status === "running" || item.status === "leased").length;
    const pendingCommandCount = commands.filter((item) => item.status === "queued").length;
    const autoApprovalRecordCount = approvalRecords.length;
    const policyMode = runtimeProjection?.policyMode
      ?? parseJsonOrNull<{ mode?: DirectorPolicyMode }>(latestRun?.policyJson)?.mode
      ?? null;
    const circuitBreaker = extractCircuitBreaker(latestTask?.seedPayloadJson);
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
    const displayState = buildDisplayState(status);
    const requiresUserAction = circuitBreaker?.status === "open"
      || status === "waiting_approval"
      || status === "waiting_recovery"
      || status === "blocked"
      || status === "failed";
    const blockedReason = status === "waiting_recovery"
      ? latestTask?.lastError ?? runtimeProjection?.blockedReason ?? null
      : runtimeProjection?.blockedReason ?? (status === "failed" ? latestTask?.lastError ?? null : null);
    const headline = buildHeadline({ status, runtimeProjection, task: latestTask });
    const detail = buildDetail({ status, runtimeProjection, task: latestTask });
    const userHeadline = buildUserHeadline({ status, task: latestTask });
    const userReason = buildUserReason({
      status,
      runtimeProjection,
      task: latestTask,
      blockedReason,
      detail,
    });
    const primaryAction = buildPrimaryAction({
      novelId,
      status,
      task: latestTask ? { id: latestTask.id, checkpointType: latestTask.checkpointType } : null,
    });
    const secondaryActions = buildSecondaryActions({
      novelId,
      status,
      taskId: latestTask?.id ?? runtimeTaskId,
    });
    const updatedAt = [
      latestTask?.updatedAt,
      latestRun?.updatedAt,
      commands[0]?.updatedAt,
      events[0]?.occurredAt,
      steps[0]?.updatedAt,
      approvalRecords[0]?.createdAt,
      usageTelemetry.recentUsage[0]?.recordedAt,
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
        durationMs: step.finishedAt
          ? Math.max(0, step.finishedAt.getTime() - step.startedAt.getTime())
          : null,
        usage: usageTelemetry.stepUsage.find((usage) => usage.stepIdempotencyKey === step.idempotencyKey) ?? null,
      })),
      ...usageTelemetry.recentUsage.slice(0, 8).map((usage) => ({
        id: `usage:${usage.id}`,
        type: "usage" as const,
        title: `AI 用量：${getDirectorNodeDisplayLabel({
          label: usage.promptAssetKey,
          nodeKey: usage.nodeKey,
          fallback: "推进步骤",
        })}`,
        detail: usage.promptAssetKey
          ? `${usage.promptAssetKey}${usage.promptVersion ? `@${usage.promptVersion}` : ""}`
          : usage.model ?? usage.provider,
        status: usage.status,
        taskId: usage.taskId,
        runId: usage.runId,
        nodeKey: usage.nodeKey,
        occurredAt: usage.recordedAt,
        durationMs: usage.durationMs,
        usage,
        attributionStatus: usage.attributionStatus,
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
      focusNovel: buildFocusNovel({
        id: novelId,
        title: novel?.title,
      }),
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
      displayState,
      runMode: extractRunMode(latestTask?.seedPayloadJson),
      policyMode,
      headline,
      userHeadline,
      detail,
      userReason,
      currentStage: latestTask?.currentStage ?? runtimeProjection?.currentNodeKey ?? null,
      currentLabel: latestTask?.currentItemLabel ?? runtimeProjection?.currentLabel ?? null,
      requiresUserAction,
      blockedReason,
      nextActionLabel: runtimeProjection?.nextActionLabel ?? null,
      primaryAction,
      secondaryActions,
      automationSummary: buildAutomationSummary({
        activeCommandCount,
        pendingCommandCount,
        artifactSummary,
        autoApprovalRecordCount,
        usageSummary: usageTelemetry.summary,
      }),
      progressSummary: runtimeProjection?.progressSummary ?? null,
      artifactSummary,
      usageSummary: usageTelemetry.summary,
      recentUsage: usageTelemetry.recentUsage,
      stepUsage: usageTelemetry.stepUsage,
      promptUsage: usageTelemetry.promptUsage,
      circuitBreaker,
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
