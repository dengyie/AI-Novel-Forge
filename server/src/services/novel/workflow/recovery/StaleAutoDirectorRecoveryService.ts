import type { NovelWorkflowStoreService } from "../NovelWorkflowStoreService";
import { parseResumeTarget, stringifyResumeTarget } from "../novelWorkflow.shared";
import {
  STALE_AUTO_DIRECTOR_RUNNING_MESSAGE,
  isAutoResumableStaleAutoDirectorTask,
  isStaleAutoDirectorRunningTask,
} from "./staleAutoDirectorRecoveryPolicy";

export interface StaleAutoDirectorResumePort {
  enqueueContinueCommand(taskId: string, input: {
    continuationMode: "resume";
    forceResume: true;
  }, options: {
    expectedTaskState: {
      status: "running";
      updatedAt: Date;
      heartbeatAt: Date | null;
      currentItemKey: string | null;
    };
  }): Promise<unknown>;
}

export interface StaleAutoDirectorRecoveryCandidate {
  id?: string;
  lane?: string | null;
  novelId?: string | null;
  status?: string | null;
  progress?: number | null;
  currentStage?: string | null;
  currentItemKey?: string | null;
  currentItemLabel?: string | null;
  checkpointType?: string | null;
  checkpointSummary?: string | null;
  pendingManualRecovery?: boolean | null;
  cancelRequestedAt?: Date | null;
  heartbeatAt?: Date | null;
  updatedAt?: Date | null;
  seedPayloadJson?: string | null;
  resumeTargetJson?: string | null;
}

/**
 * stale 自动导演恢复应用服务。
 *
 * 恢复成功只表示 continue command 已持久化创建或幂等复用，并完成命令接受流程。
 * queued、心跳和错误清理由命令服务单点投影；任何 enqueue 失败都保留原任务诊断与
 * 下一轮恢复资格，避免 healing 与 command 两个写者竞争状态。
 */
export class StaleAutoDirectorRecoveryService {
  constructor(
    private readonly workflow: NovelWorkflowStoreService,
    private readonly resumePort: StaleAutoDirectorResumePort | null,
  ) {}

  async heal(taskId: string, row: StaleAutoDirectorRecoveryCandidate | null = null): Promise<boolean> {
    const candidate = row ?? await this.workflow.getTaskByIdWithoutHealing(taskId);
    if (!candidate || !isStaleAutoDirectorRunningTask(candidate)) {
      return false;
    }
    const existing = await this.workflow.getTaskByIdWithoutHealing(taskId);
    if (!existing || !isStaleAutoDirectorRunningTask(existing)) {
      return false;
    }

    if (this.resumePort && isAutoResumableStaleAutoDirectorTask(existing)) {
      if (!(existing.updatedAt instanceof Date)) {
        return false;
      }
      try {
        await this.resumePort.enqueueContinueCommand(taskId, {
          continuationMode: "resume",
          forceResume: true,
        }, {
          expectedTaskState: {
            status: "running",
            updatedAt: existing.updatedAt,
            heartbeatAt: existing.heartbeatAt ?? null,
            currentItemKey: existing.currentItemKey ?? null,
          },
        });
        return true;
      } catch (error) {
        console.warn("[auto-director.heal] auto-resume enqueue failed", {
          taskId,
          reason: error instanceof Error ? error.message : String(error),
        });
        return false;
      }
    }

    const resumeTarget = parseResumeTarget(existing.resumeTargetJson) ?? this.workflow.buildResumeTarget({
      taskId,
      novelId: existing.novelId,
      lane: existing.lane ?? "auto_director",
      stage: "auto_director",
    });
    const result = await this.workflow.updateTaskManyWithRetry({
      where: {
        id: taskId,
        lane: "auto_director",
        status: "running",
        currentItemKey: existing.currentItemKey ?? null,
        pendingManualRecovery: false,
        cancelRequestedAt: null,
        heartbeatAt: existing.heartbeatAt ?? null,
        ...(existing.updatedAt ? { updatedAt: existing.updatedAt } : {}),
      },
      data: {
        status: "failed",
        finishedAt: new Date(),
        heartbeatAt: new Date(),
        resumeTargetJson: stringifyResumeTarget(resumeTarget),
        lastError: STALE_AUTO_DIRECTOR_RUNNING_MESSAGE,
      },
    });
    if (result.count === 0) {
      return false;
    }
    const after = await this.workflow.getTaskByIdWithoutHealing(taskId);
    if (after) {
      await this.workflow.notifyAutoDirectorTaskTransition({
        before: {
          id: existing.id ?? taskId,
          novelId: existing.novelId ?? null,
          lane: existing.lane ?? "auto_director",
          status: existing.status ?? "running",
          progress: existing.progress ?? null,
          currentStage: existing.currentStage ?? null,
          checkpointType: existing.checkpointType ?? null,
          checkpointSummary: existing.checkpointSummary ?? null,
          currentItemLabel: existing.currentItemLabel ?? null,
          pendingManualRecovery: existing.pendingManualRecovery ?? false,
          updatedAt: existing.updatedAt ?? new Date(0),
          seedPayloadJson: existing.seedPayloadJson ?? null,
        },
        after,
      });
    }
    return true;
  }
}
