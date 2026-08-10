import { randomUUID } from "node:crypto";
import { prisma } from "../../../db/prisma";
import { acquireHighMemoryReservation } from "../highMemoryReservation";
import { AppError } from "../../../middleware/errorHandler";
import type { NovelWorkflowCheckpoint, NovelWorkflowStage } from "@ai-novel/shared/types/novelWorkflow";
import { buildNovelCreateResumeTarget, appendMilestone, defaultWorkflowTitle, mergeSeedPayload, parseMilestones, parseResumeTarget, parseSeedPayload, stringifyResumeTarget } from "./novelWorkflow.shared";
import {
  BootstrapWorkflowInput,
  SyncWorkflowStageInput,
  defaultProgressForStage,
  isPreNovelAutoDirectorCandidateTask,
  isTaskCancellationRequested,
  resolveCheckpointItemLabelFromRow,
  resolveCheckpointStageFromRow,
  stageLabel,
} from "./novelWorkflow.helpers";
import { buildRestoreTaskToCheckpointResult } from "./novelWorkflowCheckpoint";
import { applyDirectorLlmOverride, type DirectorWorkflowSeedPayload } from "../director/runtime/novelDirectorHelpers";
import type { DirectorLLMOptions } from "@ai-novel/shared/types/novelDirector";
import {
  NovelWorkflowStoreService,
  type NovelWorkflowRecoveryTaskSnapshot,
} from "./NovelWorkflowStoreService";
import { StartupWorkflowRecoveryService } from "./recovery/StartupWorkflowRecoveryService";
import { WorkflowRetryService } from "./recovery/WorkflowRetryService";
import {
  WorkflowTaskOwnershipLostError,
  type WorkflowTaskOwnershipSnapshot,
} from "./ownership/WorkflowTaskOwnership";

type WorkflowRow = Awaited<ReturnType<typeof prisma.novelWorkflowTask.findUnique>>;
type WorkflowTaskUpdateData = Parameters<
  NovelWorkflowStoreService["updateWorkflowTaskWithOwnership"]
>[0]["data"];

interface AutoDirectorNovelCreationClaim {
  status: "claimed" | "attached" | "in_progress";
  task: WorkflowRow;
}

export class NovelWorkflowApplicationService {
  private readonly startupRecoveryService: StartupWorkflowRecoveryService;
  private readonly workflowRetryService: WorkflowRetryService;

  constructor(private readonly workflow: NovelWorkflowStoreService) {
    this.startupRecoveryService = new StartupWorkflowRecoveryService(workflow);
    this.workflowRetryService = new WorkflowRetryService(workflow);
  }

  private async getNovelTitle(novelId: string): Promise<string | null> {
    return this.workflow.getNovelTitle(novelId);
  }

  private async bootstrapTaskInner(input: BootstrapWorkflowInput) {
    if (input.novelId?.trim() && input.forceNew !== true) {
      const visibleRows = await this.workflow.getVisibleRowsByNovelId(input.novelId.trim(), input.lane);
      const active = visibleRows.find((row) => ["queued", "running", "waiting_approval"].includes(row.status as string));
      if (active) {
        return active;
      }
      const latest = visibleRows[0];
      if (latest) {
        return latest;
      }
    }

    if (
      !input.novelId?.trim()
      && input.forceNew !== true
      && input.lane === "auto_director"
    ) {
      const candidate = await this.workflow.findLatestPreNovelAutoDirectorCandidate();
      if (candidate) {
        return candidate;
      }
    }

    return this.workflow.createWorkflow({
      ...input,
      novelId: input.novelId?.trim() || null,
    });
  }

  async bootstrapTask(input: BootstrapWorkflowInput, ownership?: WorkflowTaskOwnershipSnapshot) {
    if (input.workflowTaskId?.trim()) {
      const existing = ownership
        ? await this.workflow.getTaskByIdWithoutHealing(input.workflowTaskId.trim())
        : await this.workflow.getTaskById(input.workflowTaskId.trim());
      if (existing) {
        if (existing.lane !== input.lane) {
          if (ownership) {
            throw new WorkflowTaskOwnershipLostError(ownership.taskId);
          }
          throw new AppError("Workflow task lane mismatch.", 409, {
            taskId: existing.id,
            existingLane: existing.lane,
            requestedLane: input.lane,
          });
        }
        if (input.novelId?.trim() && existing.novelId !== input.novelId.trim()) {
          if (ownership) {
            throw new WorkflowTaskOwnershipLostError(ownership.taskId);
          }
          if (isPreNovelAutoDirectorCandidateTask(existing)) {
            return existing;
          }
          const attached = await this.attachNovelToTask(existing.id, input.novelId.trim());
          if (input.seedPayload) {
            const data: WorkflowTaskUpdateData = {
              seedPayloadJson: mergeSeedPayload(attached.seedPayloadJson, input.seedPayload),
              heartbeatAt: new Date(),
            };
            return ownership
              ? this.workflow.updateWorkflowTaskWithOwnership({ before: attached, ownership, data })
              : this.workflow.updateTaskWithRetry({ where: { id: attached.id }, data });
          }
          return attached;
        }
        if (input.seedPayload) {
          const data: WorkflowTaskUpdateData = {
            seedPayloadJson: mergeSeedPayload(existing.seedPayloadJson, input.seedPayload),
            heartbeatAt: new Date(),
          };
          return ownership
            ? this.workflow.updateWorkflowTaskWithOwnership({ before: existing, ownership, data })
            : this.workflow.updateTaskWithRetry({ where: { id: existing.id }, data });
        }
        return existing;
      }
      if (ownership) {
        throw new WorkflowTaskOwnershipLostError(ownership.taskId);
      }
    }

    if (input.forceNew === true) {
      return this.bootstrapTaskInner(input);
    }

    const scopeKey = `${input.lane}:${input.novelId?.trim() || "pre_novel"}`;
    const ownerId = `workflow-bootstrap:${process.pid}:${randomUUID()}`;
    const reservation = await acquireHighMemoryReservation({
      namespace: "novel-workflow-bootstrap",
      scopeKey,
      ownerId,
      ttlMs: 5_000,
      metadata: { lane: input.lane, novelId: input.novelId?.trim() || null },
    });
    if (!reservation.acquired) {
      // A lock holder is either about to create the shared task or has just released it.
      // Give that short critical section a chance to commit before the final re-read.
      await new Promise((resolve) => setTimeout(resolve, 75));
      return this.bootstrapTaskInner(input);
    }
    try {
      return await this.bootstrapTaskInner(input);
    } finally {
      await reservation.handle.release();
    }
  }

  async attachNovelToTask(taskId: string, novelId: string, stage: NovelWorkflowStage = "project_setup") {
    const existing = await this.workflow.getTaskById(taskId);
    if (!existing) {
      throw new AppError("Workflow task not found.", 404);
    }
    const novelTitle = await this.getNovelTitle(novelId);
    const claimed = await this.workflow.updateTaskManyWithRetry({
      where: {
        id: taskId,
        OR: [{ novelId: null }, { novelId }],
      },
      data: {
        novelId,
        title: novelTitle ?? existing.title,
        progress: Math.max(existing.progress, defaultProgressForStage(stage)),
        currentStage: stageLabel(stage),
        currentItemKey: existing.lane === "auto_director"
          ? (existing.currentItemKey ?? "novel_create")
          : stage,
        currentItemLabel: existing.lane === "auto_director"
          ? (existing.currentItemLabel ?? "正在创建小说项目")
          : (stage === "project_setup" ? "小说项目已创建" : (existing.currentItemLabel ?? "已恢复小说主任务")),
        resumeTargetJson: stringifyResumeTarget(this.workflow.buildResumeTarget({
          taskId,
          novelId,
          lane: existing.lane,
          stage,
        })),
        heartbeatAt: new Date(),
      },
    });
    const latest = await this.workflow.getTaskByIdWithoutHealing(taskId);
    if (!latest) {
      throw new AppError("Workflow task not found.", 404);
    }
    if (claimed.count === 0 && latest.novelId !== novelId) {
      return latest;
    }
    return latest;
  }

  async claimAutoDirectorNovelCreation(taskId: string, input: {
    itemLabel: string;
    progress: number;
  }): Promise<AutoDirectorNovelCreationClaim> {
    const existing = await this.workflow.getTaskByIdWithoutHealing(taskId);
    if (!existing) {
      throw new AppError("Workflow task not found.", 404);
    }
    if (existing.lane !== "auto_director") {
      throw new AppError("Only auto director workflow tasks can claim novel creation.", 400);
    }
    if (existing.novelId) {
      return {
        status: "attached",
        task: existing,
      };
    }

    const now = new Date();
    const claimed = await this.workflow.updateTaskManyWithRetry({
      where: {
        id: taskId,
        lane: "auto_director",
        novelId: null,
        OR: [
          { currentItemKey: null },
          { currentItemKey: "auto_director" },
          { currentItemKey: { startsWith: "candidate_" } },
          {
            status: {
              in: ["failed", "cancelled"],
            },
          },
        ],
      },
      data: {
        status: "running",
        startedAt: existing.startedAt ?? now,
        finishedAt: null,
        heartbeatAt: now,
        progress: Math.max(existing.progress ?? 0, input.progress),
        currentStage: stageLabel("auto_director"),
        currentItemKey: "novel_create",
        currentItemLabel: input.itemLabel,
        checkpointType: null,
        checkpointSummary: null,
        lastError: null,
        cancelRequestedAt: null,
      },
    });

    const latest = await this.workflow.getTaskByIdWithoutHealing(taskId);
    if (!latest) {
      throw new AppError("Workflow task not found.", 404);
    }
    if (latest.novelId) {
      return {
        status: "attached",
        task: latest,
      };
    }
    return {
      status: claimed.count > 0 ? "claimed" : "in_progress",
      task: latest,
    };
  }

  async markTaskRunning(taskId: string, input: {
    stage: NovelWorkflowStage;
    itemLabel: string;
    itemKey?: string | null;
    progress?: number;
    clearCheckpoint?: boolean;
    chapterId?: string | null;
    volumeId?: string | null;
    seedPayload?: Record<string, unknown>;
  }, ownership?: WorkflowTaskOwnershipSnapshot) {
    const existing = ownership
      ? await this.workflow.getTaskByIdWithoutHealing(taskId)
      : await this.workflow.getTaskById(taskId);
    if (!existing) {
      if (ownership) {
        throw new WorkflowTaskOwnershipLostError(ownership.taskId);
      }
      throw new AppError("Workflow task not found.", 404);
    }
    if (isTaskCancellationRequested(existing)) {
      if (ownership) {
        throw new WorkflowTaskOwnershipLostError(ownership.taskId);
      }
      throw new AppError("WORKFLOW_TASK_CANCELLED", 409);
    }
    const resumeTarget = this.workflow.buildResumeTarget({
      taskId,
      novelId: existing.novelId,
      lane: existing.lane,
      stage: input.stage,
      chapterId: input.chapterId,
      volumeId: input.volumeId,
    });
    const data: WorkflowTaskUpdateData = {
        status: "running",
        startedAt: existing.startedAt ?? new Date(),
        finishedAt: null,
        heartbeatAt: new Date(),
        pendingManualRecovery: false,
        currentStage: stageLabel(input.stage),
        currentItemKey: input.itemKey ?? input.stage,
        currentItemLabel: input.itemLabel,
        progress: Math.max(existing.progress, input.progress ?? defaultProgressForStage(input.stage)),
        checkpointType: input.clearCheckpoint ? null : existing.checkpointType,
        checkpointSummary: input.clearCheckpoint ? null : existing.checkpointSummary,
        resumeTargetJson: stringifyResumeTarget(resumeTarget),
        seedPayloadJson: input.seedPayload
          ? mergeSeedPayload(existing.seedPayloadJson, input.seedPayload)
          : existing.seedPayloadJson,
        lastError: null,
        cancelRequestedAt: null,
      };
    return ownership
      ? this.workflow.updateWorkflowTaskWithOwnership({ before: existing, ownership, data })
      : this.workflow.updateWorkflowTaskWithNotifications({ before: existing, data });
  }

  async markTaskWaitingApproval(taskId: string, input: {
    stage: NovelWorkflowStage;
    itemLabel: string;
    itemKey?: string | null;
    progress?: number;
    clearCheckpoint?: boolean;
    checkpointType?: NovelWorkflowCheckpoint | null;
    checkpointSummary?: string | null;
    chapterId?: string | null;
    volumeId?: string | null;
    seedPayload?: Record<string, unknown>;
  }, ownership?: WorkflowTaskOwnershipSnapshot) {
    const existing = ownership
      ? await this.workflow.getTaskByIdWithoutHealing(taskId)
      : await this.workflow.getTaskById(taskId);
    if (!existing) {
      if (ownership) {
        throw new WorkflowTaskOwnershipLostError(ownership.taskId);
      }
      throw new AppError("Workflow task not found.", 404);
    }
    if (isTaskCancellationRequested(existing)) {
      if (ownership) {
        throw new WorkflowTaskOwnershipLostError(ownership.taskId);
      }
      throw new AppError("WORKFLOW_TASK_CANCELLED", 409);
    }
    const resumeTarget = this.workflow.buildResumeTarget({
      taskId,
      novelId: existing.novelId,
      lane: existing.lane,
      stage: input.stage,
      chapterId: input.chapterId,
      volumeId: input.volumeId,
    });
    const data: WorkflowTaskUpdateData = {
        status: "waiting_approval",
        finishedAt: null,
        heartbeatAt: new Date(),
        currentStage: stageLabel(input.stage),
        currentItemKey: input.itemKey ?? input.stage,
        currentItemLabel: input.itemLabel,
        progress: Math.max(existing.progress, input.progress ?? defaultProgressForStage(input.stage)),
        checkpointType: input.clearCheckpoint
          ? null
          : (input.checkpointType ?? existing.checkpointType),
        checkpointSummary: input.clearCheckpoint
          ? null
          : (input.checkpointSummary ?? existing.checkpointSummary),
        resumeTargetJson: stringifyResumeTarget(resumeTarget),
        seedPayloadJson: input.seedPayload
          ? mergeSeedPayload(existing.seedPayloadJson, input.seedPayload)
          : existing.seedPayloadJson,
        lastError: null,
        cancelRequestedAt: null,
      };
    return ownership
      ? this.workflow.updateWorkflowTaskWithOwnership({ before: existing, ownership, data })
      : this.workflow.updateWorkflowTaskWithNotifications({ before: existing, data });
  }

  async markTaskFailed(
    taskId: string,
    message: string,
    patch?: Partial<SyncWorkflowStageInput>,
    ownership?: WorkflowTaskOwnershipSnapshot,
  ) {
    const existing = ownership
      ? await this.workflow.getTaskByIdWithoutHealing(taskId)
      : await this.workflow.getTaskById(taskId);
    if (!existing) {
      if (ownership) {
        throw new WorkflowTaskOwnershipLostError(ownership.taskId);
      }
      return null;
    }
    if (isTaskCancellationRequested(existing)) {
      if (ownership) {
        throw new WorkflowTaskOwnershipLostError(ownership.taskId);
      }
      return existing;
    }
    const stage = patch?.stage ?? "auto_director";
    const resumeTarget = parseResumeTarget(existing.resumeTargetJson) ?? this.workflow.buildResumeTarget({
      taskId,
      novelId: existing.novelId,
      lane: existing.lane,
      stage,
      chapterId: patch?.chapterId,
      volumeId: patch?.volumeId,
    });
    const data: WorkflowTaskUpdateData = {
        status: "failed",
        finishedAt: new Date(),
        heartbeatAt: new Date(),
        currentStage: patch?.stage ? stageLabel(patch.stage) : existing.currentStage,
        currentItemKey: patch?.itemKey ?? existing.currentItemKey,
        currentItemLabel: patch?.itemLabel ?? existing.currentItemLabel,
        checkpointType: patch?.checkpointType ?? existing.checkpointType,
        checkpointSummary: patch?.checkpointSummary ?? existing.checkpointSummary,
        resumeTargetJson: stringifyResumeTarget(resumeTarget),
        lastError: message.trim(),
      };
    return ownership
      ? this.workflow.updateWorkflowTaskWithOwnership({ before: existing, ownership, data })
      : this.workflow.updateWorkflowTaskWithNotifications({ before: existing, data });
  }

  async markTaskFailedForRecovery(
    taskId: string,
    message: string,
    expectedState: NovelWorkflowRecoveryTaskSnapshot,
  ) {
    return this.startupRecoveryService.markFailed(taskId, message, expectedState);
  }

  async cancelTask(taskId: string, row: WorkflowRow = null) {
    const existing = row ?? await this.workflow.getTaskByIdWithoutHealing(taskId);
    if (!existing) {
      throw new AppError("Task not found.", 404);
    }
    if (existing.status === "cancelled") {
      return existing;
    }
    if (!["queued", "running", "waiting_approval"].includes(existing.status)) {
      throw new AppError("Task is no longer cancellable.", 409);
    }
    const now = new Date();
    const claimed = await this.workflow.updateTaskManyWithRetry({
      where: {
        id: taskId,
        status: existing.status,
        cancelRequestedAt: existing.cancelRequestedAt,
        updatedAt: existing.updatedAt,
        attemptCount: existing.attemptCount,
      },
      data: {
        status: "cancelled",
        cancelRequestedAt: now,
        finishedAt: now,
        heartbeatAt: now,
      },
    });
    if (claimed.count === 0) {
      const latest = await this.workflow.getTaskByIdWithoutHealing(taskId);
      if (latest?.status === "cancelled") {
        return latest;
      }
      throw new AppError("Task state changed before cancellation was accepted.", 409);
    }
    const next = await this.workflow.getTaskByIdWithoutHealing(taskId);
    if (next) {
      await this.workflow.notifyAutoDirectorTaskTransition({ before: existing, after: next });
    }
    return next;
  }

  /**
   * 统一重试认领点（唯一 attemptCount 自增处）。
   *
   * 单次条件 updateMany 防竞态 + 幂等：只有仍处 failed/cancelled、未被人工标记恢复、
   * 无取消请求、且 attemptCount 仍等于读取时值的行才被认领并自增一次。
   * P3 retention 自动重试与人工重试并发时只有一个生效，绝不双重自增。
   *
   * 返回认领后的完整行（含 novel，供通知）；行不存在抛 404；条件不满足
   * （已被并发认领/已人工介入/状态已翻回活跃）返回 null，调用方据此跳过 continue。
   */
  async retryTask(taskId: string, row: WorkflowRow = null) {
    return this.workflowRetryService.retry(taskId, row);
  }

  async markRetryDispatchFailed(
    taskId: string,
    claimedAttemptCount: number,
    error: unknown,
  ) {
    return this.workflowRetryService.markDispatchFailed(taskId, claimedAttemptCount, error);
  }

  async restoreTaskToCheckpoint(
    taskId: string,
    row = null as Awaited<ReturnType<typeof prisma.novelWorkflowTask.findUnique>> | null,
  ) {
    const existing = row ?? await this.workflow.getTaskByIdWithoutHealing(taskId);
    const restored = existing
      ? buildRestoreTaskToCheckpointResult({
        taskId,
        existing,
        buildResumeTarget: (params) => this.workflow.buildResumeTarget(params),
      })
      : null;
    if (!existing || !restored) {
      return existing;
    }
    return this.workflow.updateWorkflowTaskWithNotifications({
      before: existing,
      data: restored.data,
    });
  }

  async restoreTaskToCheckpointForRecovery(
    taskId: string,
    expectedState: NovelWorkflowRecoveryTaskSnapshot,
  ) {
    return this.startupRecoveryService.restoreCheckpoint(taskId, expectedState);
  }

  async applyAutoDirectorLlmOverride(
    taskId: string,
    llmOverride: Pick<DirectorLLMOptions, "provider" | "model" | "temperature">,
    row: WorkflowRow = null,
  ) {
    const existing = row ?? await this.workflow.getTaskByIdWithoutHealing(taskId);
    if (!existing) {
      throw new AppError("Workflow task not found.", 404);
    }
    if (existing.lane !== "auto_director") {
      return existing;
    }
    const seedPayload = parseSeedPayload<DirectorWorkflowSeedPayload>(existing.seedPayloadJson);
    const nextSeedPayload = applyDirectorLlmOverride(seedPayload, llmOverride);
    if (!nextSeedPayload) {
      throw new AppError("当前自动导演任务缺少可覆盖的模型上下文。", 400);
    }
    return this.workflow.updateTaskWithRetry({
      where: { id: taskId },
      data: {
        seedPayloadJson: JSON.stringify(nextSeedPayload),
        heartbeatAt: new Date(),
      },
    });
  }

  async continueTask(taskId: string) {
    const existing = await this.workflow.getTaskById(taskId);
    if (!existing) {
      throw new AppError("Task not found.", 404);
    }
    if (isTaskCancellationRequested(existing)) {
      throw new AppError("WORKFLOW_TASK_CANCELLED", 409);
    }
    return this.workflow.updateWorkflowTaskWithNotifications({
      before: existing,
      data: {
        heartbeatAt: new Date(),
        pendingManualRecovery: false,
        status: existing.status === "queued" ? "running" : existing.status,
      },
    });
  }

  async requeueTaskForRecovery(
    taskId: string,
    message: string,
    expectedState: NovelWorkflowRecoveryTaskSnapshot,
  ) {
    return this.startupRecoveryService.requeue(taskId, message, expectedState);
  }

  async recordCandidateSelectionRequired(taskId: string, input: {
    seedPayload?: Record<string, unknown>;
    summary: string;
  }) {
    const existing = await this.workflow.getTaskById(taskId);
    if (!existing) {
      throw new AppError("Workflow task not found.", 404);
    }
    if (isTaskCancellationRequested(existing)) {
      throw new AppError("WORKFLOW_TASK_CANCELLED", 409);
    }
    return this.workflow.updateWorkflowTaskWithNotifications({
      before: existing,
      data: {
        status: "waiting_approval",
        currentStage: stageLabel("auto_director"),
        currentItemKey: "auto_director",
        currentItemLabel: "等待确认书级方向",
        checkpointType: "candidate_selection_required",
        checkpointSummary: input.summary,
        resumeTargetJson: stringifyResumeTarget(buildNovelCreateResumeTarget(taskId, "director")),
        progress: Math.max(existing.progress, defaultProgressForStage("auto_director")),
        heartbeatAt: new Date(),
        seedPayloadJson: input.seedPayload
          ? mergeSeedPayload(existing.seedPayloadJson, input.seedPayload)
          : existing.seedPayloadJson,
        milestonesJson: appendMilestone(existing.milestonesJson, "candidate_selection_required", input.summary),
      },
    });
  }

  async recordRewriteSnapshotMilestone(taskId: string, input: {
    summary: string;
  }) {
    const existing = await this.workflow.getTaskById(taskId);
    if (!existing) {
      throw new AppError("Workflow task not found.", 404);
    }
    if (isTaskCancellationRequested(existing)) {
      throw new AppError("WORKFLOW_TASK_CANCELLED", 409);
    }
    return this.workflow.updateTaskWithRetry({
      where: { id: taskId },
      data: {
        heartbeatAt: new Date(),
        milestonesJson: JSON.stringify([
          ...parseMilestones(existing.milestonesJson),
          {
            checkpointType: "rewrite_snapshot_created",
            summary: input.summary,
            createdAt: new Date().toISOString(),
          },
        ]),
      },
    });
  }

  async recordCheckpoint(taskId: string, input: {
    stage: NovelWorkflowStage;
    checkpointType: NovelWorkflowCheckpoint;
    checkpointSummary: string;
    itemLabel: string;
    chapterId?: string | null;
    volumeId?: string | null;
    progress?: number;
    seedPayload?: Record<string, unknown>;
  }, ownership?: WorkflowTaskOwnershipSnapshot) {
    const existing = ownership
      ? await this.workflow.getTaskByIdWithoutHealing(taskId)
      : await this.workflow.getTaskById(taskId);
    if (!existing) {
      if (ownership) {
        throw new WorkflowTaskOwnershipLostError(ownership.taskId);
      }
      throw new AppError("Workflow task not found.", 404);
    }
    if (isTaskCancellationRequested(existing)) {
      if (ownership) {
        throw new WorkflowTaskOwnershipLostError(ownership.taskId);
      }
      throw new AppError("WORKFLOW_TASK_CANCELLED", 409);
    }
    const resumeTarget = this.workflow.buildResumeTarget({
      taskId,
      novelId: existing.novelId,
      lane: existing.lane,
      stage: input.stage,
      chapterId: input.chapterId,
      volumeId: input.volumeId,
    });
    const data: WorkflowTaskUpdateData = {
        status: input.checkpointType === "workflow_completed" ? "succeeded" : "waiting_approval",
        progress: input.progress ?? defaultProgressForStage(input.stage),
        currentStage: stageLabel(input.stage),
        currentItemKey: input.stage,
        currentItemLabel: input.itemLabel,
        checkpointType: input.checkpointType,
        checkpointSummary: input.checkpointSummary,
        resumeTargetJson: stringifyResumeTarget(resumeTarget),
        heartbeatAt: new Date(),
        finishedAt: input.checkpointType === "workflow_completed" ? new Date() : null,
        seedPayloadJson: input.seedPayload
          ? mergeSeedPayload(existing.seedPayloadJson, input.seedPayload)
          : existing.seedPayloadJson,
        milestonesJson: appendMilestone(existing.milestonesJson, input.checkpointType, input.checkpointSummary),
        lastError: null,
      };
    return ownership
      ? this.workflow.updateWorkflowTaskWithOwnership({ before: existing, ownership, data })
      : this.workflow.updateWorkflowTaskWithNotifications({ before: existing, data });
  }

  async syncStageByNovelId(novelId: string, input: SyncWorkflowStageInput) {
    const task = await this.bootstrapTask({
      novelId,
      lane: "manual_create",
    });
    const resumeTarget = this.workflow.buildResumeTarget({
      taskId: task.id,
      novelId,
      lane: task.lane,
      stage: input.stage,
      chapterId: input.chapterId,
      volumeId: input.volumeId,
    });
    return this.workflow.updateTaskWithRetry({
      where: { id: task.id },
      data: {
        status: input.status ?? "waiting_approval",
        progress: input.progress ?? Math.max(task.progress, defaultProgressForStage(input.stage)),
        currentStage: stageLabel(input.stage),
        currentItemKey: input.itemKey ?? input.stage,
        currentItemLabel: input.itemLabel,
        checkpointType: input.checkpointType ?? task.checkpointType,
        checkpointSummary: input.checkpointSummary ?? task.checkpointSummary,
        resumeTargetJson: stringifyResumeTarget(resumeTarget),
        heartbeatAt: new Date(),
        milestonesJson: input.checkpointType && input.checkpointSummary
          ? appendMilestone(task.milestonesJson, input.checkpointType, input.checkpointSummary)
          : task.milestonesJson,
      },
    });
  }
}
