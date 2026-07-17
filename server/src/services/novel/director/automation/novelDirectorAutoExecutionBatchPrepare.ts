/**
 * Surgical next-window prepare for auto-execution batch roll.
 *
 * Unlike runDirectorStructuredOutlinePhase, this path:
 * - does NOT bootstrap / rewrite seed
 * - does NOT recordCheckpoint(chapter_batch_ready) (would pause the loop)
 * - returns expanded range + autoExecution so runtime can continue the loop
 *
 * Cross-ref: phases/novelDirectorStructuredOutlinePhase.ts (minimal logic copy; shared helper extraction is P2).
 */
import type { VolumePlanDocument } from "@ai-novel/shared/types/novel";
import {
  isFullBookAutopilotRunMode,
  type DirectorAutoExecutionState,
} from "@ai-novel/shared/types/novelDirector";
import {
  buildQualityFeedbackWindowSummary,
  extractQualityFeedbackFromRiskFlags,
  QUALITY_FEEDBACK_PREPARE_SUMMARY_CHARS,
} from "@ai-novel/shared/types/qualityFeedback";
import type { NovelVolumeService } from "../../volume/NovelVolumeService";
import {
  hasDirectorSyncedChapterExecutionContext,
  normalizeDirectorAutoExecutionPlan,
  type DirectorAutoExecutionChapterRef,
  type DirectorAutoExecutionRange,
} from "./novelDirectorAutoExecution";
import {
  applyExpandRangeBatchRoll,
  collectNotExecutableOrdersInBatchWindow,
  type PrepareNextAutoExecutionBatchInput,
  type PrepareNextAutoExecutionBatchResult,
  type WorkspaceChapterPlanSlice,
} from "./novelDirectorAutoExecutionBatchRollRuntime";
import {
  resolveStructuredOutlineRecoveryCursor,
  type StructuredOutlineDetailMode,
  type StructuredOutlineRecoveryCursor,
} from "../recovery/novelDirectorStructuredOutlineRecovery";
import { resetDirectorDownstreamChapterState } from "../recovery/novelDirectorDownstreamReset";
import { DIRECTOR_PROGRESS } from "../projections/novelDirectorProgress";

export type PrepareNextAutoExecutionBatchDeps = {
  volumeService: Pick<
    NovelVolumeService,
    "getVolumes" | "generateVolumes" | "updateVolumesWithOptions" | "syncVolumeChaptersWithOptions"
  >;
  novelContextService: {
    listChapters: (novelId: string) => Promise<DirectorAutoExecutionChapterRef[]>;
  };
  characterDynamicsService?: {
    rebuildDynamics: (novelId: string, options?: { sourceType?: string }) => Promise<unknown>;
  };
  /** Best-effort progress; failures must not block prepare. */
  onProgress?: (label: string, progress: number) => Promise<void>;
};

function buildBatchPrepareCursorKey(cursor: StructuredOutlineRecoveryCursor): string {
  return [
    cursor.step,
    cursor.volumeId ?? "",
    cursor.chapterId ?? "",
    cursor.detailMode ?? "",
    cursor.beatKey ?? "",
    cursor.preparedVolumeIds.length,
    cursor.selectedChapters.length,
    cursor.completedChapterCount,
    cursor.totalChapterCount,
    cursor.completedDetailSteps,
    cursor.totalDetailSteps,
  ].join("|");
}

function findMissingSelectedChapterOrders(
  selectedOrders: number[],
  range: { startOrder: number; endOrder: number },
): number[] {
  const selected = new Set(selectedOrders);
  const missing: number[] = [];
  for (let order = range.startOrder; order <= range.endOrder; order += 1) {
    if (!selected.has(order)) {
      missing.push(order);
    }
  }
  return missing;
}

/**
 * Flatten VolumePlanDocument chapter plans for prepare canEnter hard-gate merge.
 * Boundary/contract fields live on workspace plan; execution truth on listChapters.
 */
function buildWorkspaceChapterPlanByOrder(
  workspace: VolumePlanDocument,
): Map<number, WorkspaceChapterPlanSlice> {
  return new Map(
    (workspace.volumes ?? []).flatMap((volume) =>
      (volume.chapters ?? []).map((chapter) => [
        chapter.chapterOrder,
        {
          chapterOrder: chapter.chapterOrder,
          chapterId: chapter.chapterId,
          id: chapter.id,
          title: chapter.title,
          summary: chapter.summary,
          purpose: chapter.purpose,
          exclusiveEvent: chapter.exclusiveEvent,
          endingState: chapter.endingState,
          nextChapterEntryState: chapter.nextChapterEntryState,
          conflictLevel: chapter.conflictLevel,
          revealLevel: chapter.revealLevel,
          targetWordCount: chapter.targetWordCount,
          mustAvoid: chapter.mustAvoid,
          taskSheet: chapter.taskSheet,
          sceneCards: chapter.sceneCards,
          volumeId: chapter.volumeId ?? volume.id,
          payoffRefs: chapter.payoffRefs,
        } satisfies WorkspaceChapterPlanSlice,
      ] as const),
    ),
  );
}

async function syncPreparedChapterExecutionContext(input: {
  novelId: string;
  workspace: VolumePlanDocument;
  targetVolumeId: string;
  targetChapterId: string;
  volumeService: PrepareNextAutoExecutionBatchDeps["volumeService"];
}): Promise<void> {
  const targetVolume = input.workspace.volumes.find((volume) => volume.id === input.targetVolumeId);
  const targetChapter = targetVolume?.chapters.find((chapter) => chapter.id === input.targetChapterId);
  if (!targetChapter) {
    return;
  }
  if (!targetChapter.taskSheet?.trim() && !targetChapter.sceneCards?.trim()) {
    return;
  }

  await input.volumeService.syncVolumeChaptersWithOptions(input.novelId, {
    volumes: input.workspace.volumes,
    preserveContent: true,
    applyDeletes: false,
    executionContractChapterRange: {
      startOrder: targetChapter.chapterOrder,
      endOrder: targetChapter.chapterOrder,
    },
  }, {
    emitEvent: false,
    syncPayoffLedger: false,
  });
}

async function persistOutlineVolumeSnapshot(input: {
  novelId: string;
  taskId: string;
  workspace: VolumePlanDocument;
  itemKey: "beat_sheet" | "chapter_list";
  scope: "beat_sheet" | "chapter_list";
  volumeId?: string | null;
  volumeService: PrepareNextAutoExecutionBatchDeps["volumeService"];
}): Promise<VolumePlanDocument> {
  return input.volumeService.updateVolumesWithOptions(input.novelId, input.workspace, {
    emitEvent: false,
    syncPayoffLedger: false,
    memoryTelemetry: {
      taskId: input.taskId,
      stage: "structured_outline",
      itemKey: input.itemKey,
      scope: input.scope,
      entrypoint: "auto_director_batch_prepare",
      volumeId: input.volumeId,
    },
  });
}

function workspaceHasTitleInRange(
  workspace: VolumePlanDocument,
  range: { startOrder: number; endOrder: number },
): boolean {
  return workspace.volumes.some((volume) =>
    (volume.chapters ?? []).some((chapter) => {
      const order = chapter.chapterOrder;
      return order >= range.startOrder
        && order <= range.endOrder
        && Boolean(chapter.title?.trim());
    }),
  );
}

/**
 * A4：批续窗 prepare 时把上一窗 quality feedback 投影成 ≤500 字摘要，
 * 写入 qualityDebtSummaries（source=quality_loop），由 applyExpandRangeBatchRoll 跨窗保留。
 * fail-open：任何解析失败不影响批续。
 */
function withPriorWindowQualityDebtSummary(input: {
  previousState: DirectorAutoExecutionState;
  previousRange: DirectorAutoExecutionRange;
  chapters: DirectorAutoExecutionChapterRef[];
}): DirectorAutoExecutionState {
  try {
    const startOrder = Math.max(1, Math.round(input.previousRange.startOrder ?? 1));
    const endOrder = Math.max(startOrder, Math.round(input.previousRange.endOrder ?? startOrder));
    const packets = input.chapters
      .filter((chapter) => chapter.order >= startOrder && chapter.order <= endOrder)
      .flatMap((chapter) => extractQualityFeedbackFromRiskFlags(chapter.riskFlags ?? null));
    const summary = buildQualityFeedbackWindowSummary(
      packets,
      QUALITY_FEEDBACK_PREPARE_SUMMARY_CHARS,
    ).trim();
    if (!summary) {
      return input.previousState;
    }
    const debtEntry: NonNullable<DirectorAutoExecutionState["qualityDebtSummaries"]>[number] = {
      chapterOrder: endOrder,
      reason: summary,
      source: "quality_loop",
      deferredAt: new Date().toISOString(),
    };
    return {
      ...input.previousState,
      qualityDebtSummaries: [
        ...(input.previousState.qualityDebtSummaries ?? []),
        debtEntry,
      ].slice(-40),
    };
  } catch {
    return input.previousState;
  }
}

/**
 * Prepare the next auto-execution batch window (detail + sync) without pausing for approval.
 */
export async function prepareNextAutoExecutionBatch(
  deps: PrepareNextAutoExecutionBatchDeps,
  input: PrepareNextAutoExecutionBatchInput,
): Promise<PrepareNextAutoExecutionBatchResult> {
  const { novelId, taskId, decision, previousState, previousRange, request } = input;

  if (decision.kind !== "reenter_structured_outline") {
    throw new Error(
      `prepareNextAutoExecutionBatch 仅接受 reenter_structured_outline，收到 ${decision.kind}。`,
    );
  }
  const nextRange = decision.nextRange;
  if (!nextRange) {
    throw new Error("prepareNextAutoExecutionBatch 缺少 decision.nextRange。");
  }
  if (!request) {
    throw new Error("prepareNextAutoExecutionBatch 缺少 request（provider/model/runMode 不可达）。");
  }
  // previousRange is required by the type for debt/window continuity; refuse rewind.
  if (
    previousRange
    && Number.isFinite(previousRange.endOrder)
    && nextRange.startOrder <= previousRange.endOrder
  ) {
    throw new Error(
      `批续窗 prepare 拒绝回卷：nextRange ${nextRange.startOrder}-${nextRange.endOrder} 未严格位于 previousRange 末尾 ${previousRange.endOrder} 之后。`,
    );
  }

  const baseWorkspace = await deps.volumeService.getVolumes(novelId);
  if (!baseWorkspace.volumes?.length) {
    throw new Error("批续窗 prepare 时 workspace 无可用卷规划。");
  }

  const plan = normalizeDirectorAutoExecutionPlan({
    mode: "chapter_range",
    startOrder: nextRange.startOrder,
    endOrder: nextRange.endOrder,
    autoReview: previousState.autoReview ?? true,
    autoRepair: previousState.autoRepair ?? true,
    artifactSyncMode: previousState.artifactSyncMode,
  });

  const reportProgress = async (label: string, progress: number) => {
    if (!deps.onProgress) {
      return;
    }
    try {
      await deps.onProgress(label, progress);
    } catch {
      // best-effort
    }
  };

  // full_book_autopilot: JIT — do not pre-generate chapter_detail; titles must already exist.
  // Still hard-gate canEnterExecution (shared collect) so incomplete contracts cannot silent-expand.
  if (isFullBookAutopilotRunMode(request.runMode)) {
    if (!workspaceHasTitleInRange(baseWorkspace, nextRange)) {
      throw new Error(
        `懒规划模式仍缺第 ${nextRange.startOrder}-${nextRange.endOrder} 章标题骨架，无法批续。`,
      );
    }
    await reportProgress(
      `批续窗：懒规划直扩第 ${nextRange.startOrder}-${nextRange.endOrder} 章`,
      DIRECTOR_PROGRESS.chapterSync,
    );
    const chapters = await deps.novelContextService.listChapters(novelId);
    const chapterByOrder = new Map(chapters.map((chapter) => [chapter.order, chapter] as const));
    const workspaceChapterByOrder = buildWorkspaceChapterPlanByOrder(baseWorkspace);
    const selectedChapterOrders: number[] = [];
    for (let order = nextRange.startOrder; order <= nextRange.endOrder; order += 1) {
      selectedChapterOrders.push(order);
    }
    const notExecutableOrders = collectNotExecutableOrdersInBatchWindow({
      novelId,
      selectedChapterOrders,
      chapterByOrder,
      workspaceChapterByOrder,
      qualityMode: "full_book_autopilot",
    });
    if (notExecutableOrders.length > 0) {
      throw new Error(
        `批续窗懒规划第 ${nextRange.startOrder}-${nextRange.endOrder} 章合同不可执行（第 ${notExecutableOrders.slice(0, 5).join("、")} 章 canEnterExecution=false），不能静默 expand。`,
      );
    }
    return applyExpandRangeBatchRoll({
      previousState: withPriorWindowQualityDebtSummary({
        previousState,
        previousRange,
        chapters,
      }),
      nextRange,
      chapters,
    });
  }

  let workspace = baseWorkspace;
  let previousCursorKey: string | null = null;

  while (true) {
    const recoveryCursor = resolveStructuredOutlineRecoveryCursor({
      workspace,
      plan,
    });
    const cursorKey = buildBatchPrepareCursorKey(recoveryCursor);
    if (cursorKey === previousCursorKey) {
      throw new Error(
        `批续窗 prepare 恢复游标未推进（step=${recoveryCursor.step}），请检查章节规划生成结果后重试。`,
      );
    }
    previousCursorKey = cursorKey;

    if (recoveryCursor.step === "beat_sheet") {
      const targetVolume = workspace.volumes.find((volume) => volume.id === recoveryCursor.volumeId);
      if (!targetVolume) {
        throw new Error("批续窗 prepare 缺少待生成节奏板的目标卷。");
      }
      await reportProgress(
        `批续窗：生成第 ${targetVolume.sortOrder} 卷节奏板`,
        DIRECTOR_PROGRESS.beatSheet,
      );
      workspace = await deps.volumeService.generateVolumes(novelId, {
        provider: request.provider,
        model: request.model,
        temperature: request.temperature,
        scope: "beat_sheet",
        targetVolumeId: targetVolume.id,
        draftWorkspace: workspace,
        taskId,
        entrypoint: "auto_director",
      });
      workspace = await persistOutlineVolumeSnapshot({
        novelId,
        taskId,
        workspace,
        itemKey: "beat_sheet",
        scope: "beat_sheet",
        volumeId: targetVolume.id,
        volumeService: deps.volumeService,
      });
      continue;
    }

    if (recoveryCursor.step === "chapter_list") {
      const targetVolume = workspace.volumes.find((volume) => volume.id === recoveryCursor.volumeId);
      if (!targetVolume) {
        throw new Error("批续窗 prepare 缺少待拆章的目标卷。");
      }
      await reportProgress(
        `批续窗：生成第 ${targetVolume.sortOrder} 卷章节列表`,
        DIRECTOR_PROGRESS.chapterList,
      );
      workspace = await deps.volumeService.generateVolumes(novelId, {
        provider: request.provider,
        model: request.model,
        temperature: request.temperature,
        scope: "chapter_list",
        targetVolumeId: targetVolume.id,
        draftWorkspace: workspace,
        taskId,
        entrypoint: "auto_director",
        persistIntermediateDocuments: true,
        onIntermediateDocument: async (event) => {
          workspace = event.document;
        },
      });
      workspace = await persistOutlineVolumeSnapshot({
        novelId,
        taskId,
        workspace,
        itemKey: "chapter_list",
        scope: "chapter_list",
        volumeId: targetVolume.id,
        volumeService: deps.volumeService,
      });
      continue;
    }

    if (recoveryCursor.step === "chapter_detail_bundle") {
      const targetDetailMode = recoveryCursor.detailMode as StructuredOutlineDetailMode | null;
      if (
        !recoveryCursor.chapterId
        || !recoveryCursor.volumeId
        || !targetDetailMode
        || recoveryCursor.nextChapterIndex == null
      ) {
        throw new Error("批续窗 prepare 缺少章节细化所需游标。");
      }
      const targetVolumeId = recoveryCursor.volumeId;
      const targetChapterId = recoveryCursor.chapterId;
      const chapterOrdinal = recoveryCursor.nextChapterIndex + 1;
      const total = Math.max(recoveryCursor.totalChapterCount, 1);
      await reportProgress(
        `批续窗：细化第 ${chapterOrdinal}/${total} 章`,
        DIRECTOR_PROGRESS.chapterDetailStart
          + (DIRECTOR_PROGRESS.chapterDetailDone - DIRECTOR_PROGRESS.chapterDetailStart)
            * Math.min(1, recoveryCursor.completedDetailSteps / Math.max(recoveryCursor.totalDetailSteps, 1)),
      );
      workspace = await deps.volumeService.generateVolumes(novelId, {
        provider: request.provider,
        model: request.model,
        temperature: request.temperature,
        scope: "chapter_detail",
        targetVolumeId,
        targetChapterId,
        detailMode: targetDetailMode,
        chapterTaskSheetQualityMode: "ai_copilot",
        draftWorkspace: workspace,
        taskId,
        entrypoint: "auto_director",
      });
      workspace = await deps.volumeService.updateVolumesWithOptions(novelId, workspace, {
        volumeUpdateReason: "chapter_execution_contract_refined",
        syncPayoffLedger: false,
        memoryTelemetry: {
          taskId,
          stage: "structured_outline",
          itemKey: "chapter_detail_bundle",
          scope: "chapter_detail",
          entrypoint: "auto_director_batch_prepare",
          volumeId: targetVolumeId,
          chapterId: targetChapterId,
        },
      });
      await syncPreparedChapterExecutionContext({
        novelId,
        workspace,
        targetVolumeId,
        targetChapterId,
        volumeService: deps.volumeService,
      });
      continue;
    }

    if (recoveryCursor.step === "chapter_sync" || recoveryCursor.step === "completed") {
      break;
    }

    throw new Error(`批续窗 prepare 遇到未知恢复步骤：${String(recoveryCursor.step)}`);
  }

  await reportProgress(
    `批续窗：同步第 ${nextRange.startOrder}-${nextRange.endOrder} 章执行合同`,
    DIRECTOR_PROGRESS.chapterSync,
  );

  const persistedOutlineWorkspace = await deps.volumeService.updateVolumesWithOptions(novelId, workspace, {
    volumeUpdateReason: "chapter_execution_contract_refined",
    syncPayoffLedger: false,
    memoryTelemetry: {
      taskId,
      stage: "structured_outline",
      itemKey: "chapter_sync",
      scope: "structured_outline",
      entrypoint: "auto_director_batch_prepare",
    },
  });

  await deps.volumeService.syncVolumeChaptersWithOptions(novelId, {
    volumes: persistedOutlineWorkspace.volumes,
    preserveContent: true,
    applyDeletes: false,
    executionContractChapterRange: nextRange,
  }, {
    emitEvent: false,
    syncPayoffLedger: false,
  });

  if (deps.characterDynamicsService) {
    await deps.characterDynamicsService.rebuildDynamics(novelId, {
      sourceType: "rebuild_projection",
    }).catch((error) => {
      console.warn(
        `[director.batch_prepare] event=character_dynamics_rebuild_failed taskId=${taskId} novelId=${novelId} error=${JSON.stringify(error instanceof Error ? error.message : String(error))}`,
      );
    });
  }

  const syncCursor = resolveStructuredOutlineRecoveryCursor({
    workspace: persistedOutlineWorkspace,
    plan,
  });
  const selectedChapters = syncCursor.selectedChapters;
  if (selectedChapters.length === 0) {
    throw new Error(
      `批续窗 prepare 未能准备出可执行章节（目标第 ${nextRange.startOrder}-${nextRange.endOrder} 章）。`,
    );
  }
  const selectedChapterOrders = selectedChapters
    .map((chapter) => chapter.chapterOrder)
    .sort((left, right) => left - right);
  const missingOrders = findMissingSelectedChapterOrders(selectedChapterOrders, nextRange);
  if (missingOrders.length > 0) {
    throw new Error(
      `批续窗 prepare 缺少第 ${missingOrders.slice(0, 5).join("、")} 章，不能进入第 ${nextRange.startOrder}-${nextRange.endOrder} 章执行。`,
    );
  }

  await resetDirectorDownstreamChapterState(novelId, nextRange);

  const chapters = await deps.novelContextService.listChapters(novelId);
  if (chapters.length === 0) {
    throw new Error("批续窗 prepare 已细化，但章节资源没有成功同步到执行区。");
  }

  const chapterByOrder = new Map(chapters.map((chapter) => [chapter.order, chapter] as const));
  // Soft row/sync presence: execution-table must have rows with at least synced fields.
  const missingExecutionContextOrders = selectedChapterOrders.filter((order) => {
    const chapter = chapterByOrder.get(order);
    return !chapter || !hasDirectorSyncedChapterExecutionContext(chapter);
  });
  if (missingExecutionContextOrders.length > 0) {
    throw new Error(
      `批续窗第 ${missingExecutionContextOrders.slice(0, 5).join("、")} 章缺少已同步的执行上下文，不能进入章节执行。`,
    );
  }

  // Hard gate: shared collect (plan ⊕ exec merge) — same path as full_book lazy expand.
  const workspaceChapterByOrder = buildWorkspaceChapterPlanByOrder(persistedOutlineWorkspace);
  const assessQualityMode = isFullBookAutopilotRunMode(request.runMode)
    ? "full_book_autopilot" as const
    : "ai_copilot" as const;
  const notExecutableOrders = collectNotExecutableOrdersInBatchWindow({
    novelId,
    selectedChapterOrders,
    chapterByOrder,
    workspaceChapterByOrder,
    qualityMode: assessQualityMode,
  });
  if (notExecutableOrders.length > 0) {
    throw new Error(
      `批续窗 prepare 后第 ${notExecutableOrders.slice(0, 5).join("、")} 章 canEnterExecution=false（合同边界/任务单/场景卡未齐），不能进入章节执行。`,
    );
  }

  // Forbidden side effects intentionally omitted:
  // - recordCheckpoint(chapter_batch_ready)
  // - workflow_completed
  // Runtime continues autoExecutionLoop after this return.

  return applyExpandRangeBatchRoll({
    previousState: withPriorWindowQualityDebtSummary({
      previousState,
      previousRange,
      chapters,
    }),
    nextRange,
    chapters,
  });
}
