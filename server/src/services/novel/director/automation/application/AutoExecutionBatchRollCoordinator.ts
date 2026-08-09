import type {
  DirectorAutoExecutionState,
  DirectorConfirmRequest,
} from "@ai-novel/shared/types/novelDirector";
import {
  normalizeConsecutiveBatchRolls,
  type DirectorAutoExecutionRange,
} from "../novelDirectorAutoExecution";
import { syncAutoExecutionTaskState } from "../novelDirectorAutoExecutionCheckpointRuntime";
import {
  applyExpandRangeBatchRoll,
  type BatchRollDecision,
  type BatchRollHaltItemKey,
} from "../novelDirectorAutoExecutionBatchRollRuntime";
import type { NovelDirectorAutoExecutionRuntimeDeps } from "../novelDirectorAutoExecutionRuntimePorts";
import type { AutoExecutionOwnershipFence } from "../domain/AutoExecutionOwnershipFence";

function withPersistedBatchRollCount(
  autoExecution: DirectorAutoExecutionState,
  consecutiveBatchRolls: number,
): DirectorAutoExecutionState {
  return {
    ...autoExecution,
    consecutiveBatchRolls: normalizeConsecutiveBatchRolls(consecutiveBatchRolls),
  };
}

function resolveBatchRollHaltItemKey(
  decision: BatchRollDecision,
  fallback: BatchRollHaltItemKey = "batch_roll",
): BatchRollHaltItemKey {
  return decision.haltItemKey ?? fallback;
}

export class AutoExecutionBatchRollCoordinator {
  constructor(private readonly deps: NovelDirectorAutoExecutionRuntimeDeps) {}

  private isBatchRollEnabled(): boolean {
    if (this.deps.enableBatchRoll === false) {
      return false;
    }
    return typeof this.deps.resolveBatchRoll === "function";
  }

  /**
   * When remaining=0, optionally expand/reenter instead of workflow_completed.
   * Returns null if caller should recordCompletedCheckpoint; otherwise new range/state to continue loop.
   * consecutiveBatchRolls is hydrated from state at runFromReady entry and persisted on every
   * expand / reenter / halt path so resume cannot reset the MAX=8 fuse.
   */
  async tryBatchRollOnRangeExhausted(input: {
    taskId: string;
    novelId: string;
    request: DirectorConfirmRequest;
    range: DirectorAutoExecutionRange;
    autoExecution: DirectorAutoExecutionState;
    consecutiveBatchRolls: number;
    ownershipFence?: AutoExecutionOwnershipFence;
  }): Promise<{
    range: DirectorAutoExecutionRange;
    autoExecution: DirectorAutoExecutionState;
    consecutiveBatchRolls: number;
    decision: BatchRollDecision;
  } | null> {
    await input.ownershipFence?.assertActive();
    if (!this.isBatchRollEnabled() || !this.deps.resolveBatchRoll) {
      return null;
    }
    const decision = await this.deps.resolveBatchRoll({
      novelId: input.novelId,
      range: input.range,
      autoExecution: input.autoExecution,
      consecutiveBatchRolls: input.consecutiveBatchRolls,
      request: input.request,
      settingQualityMode: input.request.settingQualityMode === "advisory"
        || input.request.settingQualityMode === "enforce"
        ? input.request.settingQualityMode
        : "off",
    });
    if (decision.kind === "completed_scope") {
      return null;
    }
    const nextRolls = normalizeConsecutiveBatchRolls(input.consecutiveBatchRolls + 1);
    if (decision.kind === "halt_for_review") {
      const haltItemKey = resolveBatchRollHaltItemKey(decision);
      const haltedState = withPersistedBatchRollCount({
        ...input.autoExecution,
        pipelineJobId: null,
        pipelineStatus: null,
      }, nextRolls);
      await input.ownershipFence?.assertActive();
      await this.deps.workflowService.markTaskFailed(
        input.taskId,
        decision.reason,
        {
          // Batch-roll halt is execution/supervisor scope, not quality_repair ticket.
          stage: "chapter_execution",
          itemKey: haltItemKey,
          itemLabel: "批续窗暂停",
          checkpointType: "chapter_batch_ready",
          checkpointSummary: decision.reason,
          chapterId: input.autoExecution.nextChapterId ?? input.range.firstChapterId,
          progress: 0.98,
        },
      );
      await syncAutoExecutionTaskState(this.deps, {
        taskId: input.taskId,
        novelId: input.novelId,
        request: input.request,
        range: input.range,
        autoExecution: haltedState,
        isBackgroundRunning: false,
        resumeStage: "pipeline",
        ownershipFence: input.ownershipFence,
      });
      // Signal stop without completed checkpoint: throw a soft control via special decision
      return {
        range: input.range,
        autoExecution: haltedState,
        consecutiveBatchRolls: nextRolls,
        decision,
      };
    }
    if (decision.kind === "expand_range" && decision.nextRange) {
      const chapters = await this.deps.novelContextService.listChapters(input.novelId);
      const nextRange = decision.nextRange;
      const persistedInWindow = chapters.filter((chapter) => (
        chapter.order >= nextRange.startOrder && chapter.order <= nextRange.endOrder
      ));
      // P2-1: workspace readiness can mark a window prepared while execution-table
      // rows still lag. Expanding into an empty persisted window would thrash the
      // loop (remaining stays 0 / missing-order errors) instead of surfacing halt.
      if (persistedInWindow.length === 0) {
        const emptyReason = (
          `下一可执行窗第 ${nextRange.startOrder}-${nextRange.endOrder} 章合同在大纲区已就绪，`
          + "但执行表尚无对应章节行，禁止空窗 expand。请先 sync 执行合同或走 reenter 细化。"
        );
        const haltedState = withPersistedBatchRollCount({
          ...input.autoExecution,
          pipelineJobId: null,
          pipelineStatus: null,
        }, nextRolls);
        await input.ownershipFence?.assertActive();
        await this.deps.workflowService.markTaskFailed(
          input.taskId,
          emptyReason,
          {
            stage: "chapter_execution",
            itemKey: "batch_roll_empty_expand",
            itemLabel: "批续窗空窗拦截",
            checkpointType: "chapter_batch_ready",
            checkpointSummary: emptyReason,
            chapterId: input.autoExecution.nextChapterId ?? input.range.firstChapterId,
            progress: 0.97,
          },
        );
        await syncAutoExecutionTaskState(this.deps, {
          taskId: input.taskId,
          novelId: input.novelId,
          request: input.request,
          range: input.range,
          autoExecution: haltedState,
          isBackgroundRunning: false,
          resumeStage: "pipeline",
          ownershipFence: input.ownershipFence,
        });
        return {
          range: input.range,
          autoExecution: haltedState,
          consecutiveBatchRolls: nextRolls,
          decision: {
            kind: "halt_for_review",
            haltItemKey: "batch_roll_empty_expand",
            reason: emptyReason,
            nextRange,
          },
        };
      }
      const expanded = applyExpandRangeBatchRoll({
        previousState: withPersistedBatchRollCount(input.autoExecution, nextRolls),
        nextRange,
        chapters,
      });
      const expandedState = withPersistedBatchRollCount(expanded.autoExecution, nextRolls);
      await syncAutoExecutionTaskState(this.deps, {
        taskId: input.taskId,
        novelId: input.novelId,
        request: input.request,
        range: expanded.range,
        autoExecution: expandedState,
        isBackgroundRunning: true,
        resumeStage: "pipeline",
        ownershipFence: input.ownershipFence,
      });
      return {
        range: expanded.range,
        autoExecution: expandedState,
        consecutiveBatchRolls: nextRolls,
        decision,
      };
    }
    if (decision.kind === "reenter_structured_outline" && decision.nextRange) {
      if (!this.deps.prepareNextAutoExecutionBatch) {
        const haltedState = withPersistedBatchRollCount({
          ...input.autoExecution,
          pipelineJobId: null,
          pipelineStatus: null,
        }, nextRolls);
        await input.ownershipFence?.assertActive();
        await this.deps.workflowService.markTaskFailed(
          input.taskId,
          `批续窗需要细化第 ${decision.nextRange.startOrder}-${decision.nextRange.endOrder} 章，但未配置 prepareNextAutoExecutionBatch。`,
          {
            stage: "structured_outline",
            itemKey: "batch_roll_outline",
            itemLabel: "批续窗待细化",
            checkpointType: "chapter_batch_ready",
            checkpointSummary: decision.reason,
            progress: 0.92,
          },
        );
        await syncAutoExecutionTaskState(this.deps, {
          taskId: input.taskId,
          novelId: input.novelId,
          request: input.request,
          range: input.range,
          autoExecution: haltedState,
          isBackgroundRunning: false,
          resumeStage: "pipeline",
          ownershipFence: input.ownershipFence,
        });
        return {
          range: input.range,
          autoExecution: haltedState,
          consecutiveBatchRolls: nextRolls,
          decision: {
            ...decision,
            kind: "halt_for_review",
            haltItemKey: decision.haltItemKey ?? "batch_roll_outline",
          },
        };
      }
      await input.ownershipFence?.assertActive();
      const prepared = await this.deps.prepareNextAutoExecutionBatch({
        novelId: input.novelId,
        taskId: input.taskId,
        decision,
        previousState: withPersistedBatchRollCount(input.autoExecution, nextRolls),
        previousRange: input.range,
        request: input.request,
      });
      const preparedState = withPersistedBatchRollCount(prepared.autoExecution, nextRolls);
      await syncAutoExecutionTaskState(this.deps, {
        taskId: input.taskId,
        novelId: input.novelId,
        request: input.request,
        range: prepared.range,
        autoExecution: preparedState,
        isBackgroundRunning: true,
        resumeStage: "pipeline",
        ownershipFence: input.ownershipFence,
      });
      return {
        range: prepared.range,
        autoExecution: preparedState,
        consecutiveBatchRolls: nextRolls,
        decision,
      };
    }
    return null;
  }
}
