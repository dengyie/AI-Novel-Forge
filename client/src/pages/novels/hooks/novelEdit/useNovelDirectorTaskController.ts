import { useEffect, useMemo, useRef } from "react";
import { useQuery } from "@tanstack/react-query";
import type { DirectorSessionState } from "@ai-novel/shared/types/novelDirector";
import type { DirectorTaskSnapshot } from "@ai-novel/shared/types/directorRuntime";
import { getDirectorTaskSnapshot } from "@/api/novelDirector";
import { getTaskDetail } from "@/api/tasks";
import { getAutoDirectorFollowUpDetail } from "@/api/autoDirectorFollowUps";
import { queryKeys } from "@/api/queryKeys";
import { toast } from "@/components/ui/toast";
import { useDirectorRealtimeStore } from "@/store/directorRealtimeStore";
import { useNovelWorkspaceQueries } from "./useNovelWorkspaceQueries";
import { tabFromDirectorDisplayStage, tabFromDirectorProgress } from "../../novelWorkspaceNavigation";
import { resolveChapterTitleWarning } from "@/lib/directorTaskNotice";
import { resolveAutoExecutionScopeLabel } from "../../novelEditTakeover.shared";
import { shouldPreserveRequestedDirectorTaskId } from "../../novelEditAutomationStatus";
import { resolveCanonicalDirectorTask } from "../../automation/directorTaskSelection";

function takeoverDismissStorageKey(novelId: string): string {
  return `novel-edit:takeover-dismissed:${novelId}`;
}

function resolveActiveStructuredOutlineChapterId(snapshot: DirectorTaskSnapshot | null): string {
  if (!snapshot) {
    return "";
  }
  const activeRuntimeStep = snapshot.runtime?.steps.find((step) => (
    step.idempotencyKey === snapshot.activeStep?.idempotencyKey
  ));
  if (
    activeRuntimeStep?.nodeKey === "structured_outline.chapter_detail_bundle"
    && activeRuntimeStep.targetType === "chapter"
    && activeRuntimeStep.targetId?.trim()
  ) {
    return activeRuntimeStep.targetId.trim();
  }
  const latestStructuredChapterStep = [...(snapshot.runtime?.steps ?? [])].reverse().find((step) => (
    step.nodeKey === "structured_outline.chapter_detail_bundle"
    && step.status === "running"
    && step.targetType === "chapter"
    && step.targetId?.trim()
  ));
  return latestStructuredChapterStep?.targetId?.trim() ?? "";
}

export function useNovelDirectorTaskController(
  workspace: ReturnType<typeof useNovelWorkspaceQueries>,
) {
  const {
    id, navigate, llm, queryClient, activeTab, setActiveTab,
    directorTaskId, setDirectorTaskId, selectedChapterId, setSelectedChapterId, selectedVolumeId, setSelectedVolumeId,
    workflowTaskId, taskPanelOpen, clearTaskPanelOpen, isTaskDrawerOpen, setIsTaskDrawerOpen, autoOpenedFailedTaskId,
    setAutoOpenedFailedTaskId, retryOverride, setRetryOverride, basicForm, setBasicForm, volumeDraft,
    setVolumeDraft, volumeStrategyPlan, setVolumeStrategyPlan, volumeCritiqueReport, setVolumeCritiqueReport, volumeBeatSheets,
    setVolumeBeatSheets, volumeRebalanceDecisions, setVolumeRebalanceDecisions, volumeGenerationMessage, setVolumeGenerationMessage, outlineOptimizeInstruction,
    setOutlineOptimizeInstruction, outlineOptimizePreview, setOutlineOptimizePreview, outlineOptimizeMode, setOutlineOptimizeMode, outlineOptimizeSourceText,
    setOutlineOptimizeSourceText, structuredOptimizeInstruction, setStructuredOptimizeInstruction, structuredOptimizePreview, setStructuredOptimizePreview, structuredOptimizeMode,
    setStructuredOptimizeMode, structuredOptimizeSourceText, setStructuredOptimizeSourceText, volumeSyncOptions, setVolumeSyncOptions, currentJobId,
    setCurrentJobId, pipelineForm, setPipelineForm, reviewResult, setReviewResult, pipelineMessage,
    setPipelineMessage, structuredMessage, setStructuredMessage, chapterOperationMessage, setChapterOperationMessage, chapterStrategy,
    setChapterStrategy, activeChapterStream, setActiveChapterStream, activeRepairStream, setActiveRepairStream, isDirectorExitActionExpanded,
    setIsDirectorExitActionExpanded, dismissedTakeoverSignature, setDismissedTakeoverSignature, characterMessage, setCharacterMessage, repairBeforeContent,
    setRepairBeforeContent, repairAfterContent, setRepairAfterContent, selectedCharacterId, setSelectedCharacterId, selectedBaseCharacterId,
    setSelectedBaseCharacterId, quickCharacterForm, setQuickCharacterForm, characterForm, setCharacterForm, shouldLoadVolumeWorkspace,
    shouldLoadStoryMacro, shouldLoadWorldSlice, shouldLoadQualityReport, shouldLoadLatestState, shouldLoadPayoffLedger, shouldLoadCharacterResources,
    shouldLoadChapterContext, shouldLoadChapterTimeline, novelDetailQuery, qualityReportQuery, qualityDebtQuery, volumeWorkspaceQuery,
    latestStateSnapshotQuery, chapterStateSnapshotQuery, payoffLedgerChapterOrder, payoffLedgerQuery, characterResourcesQuery, chapterResourceContextQuery,
    chapterTimelineQuery, activeAutoDirectorTaskQuery, bookAutomationQuery, chapterPlanQuery, chapterAuditReportsQuery, baseCharacterListQuery,
    worldListQuery, genreTreeQuery, storyModeTreeQuery, genreOptions, storyModeOptions, sourceBookAnalysesQuery,
    sourceNovelOptions, sourceKnowledgeOptions, sourceNovelBookAnalysisOptions, storyMacroTab, worldSliceMessage, novelWorldView,
    novelWorldSyncDiff, worldSliceView, isLoadingNovelWorld, isImportingNovelWorld, isGeneratingNovelWorld, isCreatingManualNovelWorld,
    isSavingNovelWorldToLibrary, isLoadingNovelWorldSyncDiff, isSyncingNovelWorld, isRefreshingWorldSlice, isSavingWorldSliceOverrides, importNovelWorld,
    createManualNovelWorld, generateNovelWorld, saveNovelWorldToLibrary, syncNovelWorld, refreshWorldSlice, saveWorldSliceOverrides,
    pipelineJobQuery, exportNovelMutation, chapters, outlineSyncChapters, selectedChapter, characters,
    baseCharacters, selectedCharacter, selectedBaseCharacter, exportNovelTitle, currentExportScope, importedBaseCharacterIds,
    hasCharacters, savedVolumeWorkspace, normalizedVolumeDraft, hasUnsavedVolumeDraft, generationNotice, readiness,
    volumeCountGuidance, customVolumeCountEnabled, customVolumeCountInput, onCustomVolumeCountEnabledChange, onCustomVolumeCountInputChange, onApplyCustomVolumeCount,
    onRestoreSystemRecommendedVolumeCount, isGeneratingStrategy, isCritiquingStrategy, isGeneratingSkeleton, isGeneratingBeatSheet, isGeneratingChapterList,
    generatingChapterListVolumeId, generatingChapterListBeatKey, generatingChapterListMode, isGeneratingChapterDetail, isGeneratingChapterDetailBundle, generatingChapterDetailMode,
    generatingChapterDetailChapterId, startStrategyGeneration, startStrategyCritique, startSkeletonGeneration, startBeatSheetGeneration, startChapterListGeneration,
    startChapterDetailGeneration, startChapterDetailBundleGeneration, handleVolumeFieldChange, handleOpenPayoffsChange, handleAddVolume, handleRemoveVolume,
    handleMoveVolume, handleChapterFieldChange, handleChapterNumberChange, handleChapterPayoffRefsChange, handleAddChapter, handleRemoveChapter,
    handleMoveChapter, volumeSyncPreview, coreCharacterCount, bible, plotBeats, maxOrder,
    worldInjectionSummary, qualitySummary, chapterQualityReport, chapterPlan, chapterTimeline, latestStateSnapshot,
    chapterStateSnapshot, payoffLedger, characterResources, pendingCharacterResourceProposals, chapterResourceContext, chapterAuditReports,
    pipelineBackgroundActivities, hasValidatedActiveAutoDirectorTask, latestAutoDirectorTask,
  } = workspace;
  const activeDirectorTask = latestAutoDirectorTask?.status === "cancelled"
    ? null
    : latestAutoDirectorTask;
  const activeAutoDirectorTask = activeDirectorTask;
  const bookAutomationProjection = bookAutomationQuery.data?.data?.projection ?? null;
  const requestedDirectorTaskId = resolveCanonicalDirectorTask({
    directorTaskId,
    requestedTask: null,
    activeTask: activeAutoDirectorTask,
    projection: bookAutomationProjection,
  }).requestedTaskId;
  const requestedDirectorTaskQuery = useQuery({
    queryKey: queryKeys.tasks.detail("novel_workflow", requestedDirectorTaskId || "none"),
    queryFn: () => getTaskDetail("novel_workflow", requestedDirectorTaskId),
    enabled: Boolean(requestedDirectorTaskId),
    retry: false,
  });
  const requestedDirectorTask = requestedDirectorTaskQuery.data?.data ?? null;
  const canonicalDirectorTask = useMemo(
    () => resolveCanonicalDirectorTask({
      directorTaskId,
      requestedTask: requestedDirectorTask,
      activeTask: activeAutoDirectorTask,
      projection: bookAutomationProjection,
    }),
    [activeAutoDirectorTask, bookAutomationProjection, directorTaskId, requestedDirectorTask],
  );
  const visibleDirectorTask = canonicalDirectorTask.visibleTask;
  const displayAutoDirectorTask = visibleDirectorTask;
  const actionTargetDirectorTaskId = visibleDirectorTask?.id ?? "";
  const selectedDirectorTaskId = visibleDirectorTask?.id ?? requestedDirectorTaskId;
  useEffect(() => {
    if (!id || !activeAutoDirectorTaskQuery.isSuccess) {
      return;
    }
    const canonicalDirectorTaskId = activeAutoDirectorTask?.id ?? "";
    if (!canonicalDirectorTaskId && taskPanelOpen && directorTaskId) {
      return;
    }
    if (directorTaskId && !requestedDirectorTaskQuery.isFetched) {
      return;
    }
    if (shouldPreserveRequestedDirectorTaskId({
      directorTaskId,
      requestedTask: requestedDirectorTask,
    })) {
      return;
    }
    if (directorTaskId === canonicalDirectorTaskId) {
      return;
    }
    setDirectorTaskId(canonicalDirectorTaskId);
  }, [
    activeAutoDirectorTask?.id,
    activeAutoDirectorTaskQuery.isSuccess,
    directorTaskId,
    id,
    requestedDirectorTask,
    requestedDirectorTaskQuery.isFetched,
    setDirectorTaskId,
    taskPanelOpen,
  ]);
  useEffect(() => {
    if (!id || !activeAutoDirectorTaskQuery.isSuccess) {
      return;
    }
    useDirectorRealtimeStore.getState().setFromAutoDirectorTask(id, activeAutoDirectorTask);
  }, [id, activeAutoDirectorTask, activeAutoDirectorTaskQuery.isSuccess]);
  const activeDirectorSession = useMemo(() => {
    if (
      !activeAutoDirectorTask
      || (
        activeAutoDirectorTask.status !== "queued"
        && activeAutoDirectorTask.status !== "running"
        && activeAutoDirectorTask.status !== "waiting_approval"
      )
    ) {
      return null;
    }
    const raw = activeAutoDirectorTask?.meta.directorSession;
    if (!raw || typeof raw !== "object") {
      return null;
    }
    return raw as DirectorSessionState;
  }, [activeAutoDirectorTask]);
  const chapterPendingCharacterResourceProposals = useMemo(
    () => pendingCharacterResourceProposals.filter((proposal) => !selectedChapterId || proposal.chapterId === selectedChapterId),
    [pendingCharacterResourceProposals, selectedChapterId],
  );
  const visibleAutoExecutionScopeLabel = resolveAutoExecutionScopeLabel(visibleDirectorTask);
  const activeAutoExecutionScopeLabel = visibleAutoExecutionScopeLabel;
  const activeChapterTitleWarning = useMemo(
    () => resolveChapterTitleWarning(displayAutoDirectorTask),
    [displayAutoDirectorTask],
  );
  const directorTaskSnapshotQuery = useQuery({
    queryKey: queryKeys.tasks.directorTaskSnapshot(selectedDirectorTaskId || "none"),
    queryFn: () => getDirectorTaskSnapshot(selectedDirectorTaskId),
    enabled: Boolean(selectedDirectorTaskId),
    retry: false,
    refetchInterval: () => (
      displayAutoDirectorTask && (
        displayAutoDirectorTask.status === "queued"
        || displayAutoDirectorTask.status === "running"
        || displayAutoDirectorTask.status === "waiting_approval"
      )
        ? 4000
        : false
    ),
  });
  const activeDirectorSnapshot = directorTaskSnapshotQuery.data?.data?.snapshot ?? null;
  const activeStructuredOutlineChapterId = useMemo(
    () => resolveActiveStructuredOutlineChapterId(activeDirectorSnapshot),
    [activeDirectorSnapshot],
  );
  const activeDirectorRuntimeSnapshot = activeDirectorSnapshot?.runtime ?? null;
  const activeDirectorRuntimeProjection = activeDirectorSnapshot?.projection ?? null;
  const activeDirectorDashboardView = activeDirectorSnapshot?.dashboardView ?? null;
  const activeDirectorRuntimeHardBlocked = activeDirectorDashboardView?.mode === "failed"
    || activeDirectorDashboardView?.mode === "recovering"
    || (
      activeDirectorDashboardView?.mode !== "running"
      && activeDirectorRuntimeProjection?.status === "blocked"
    );
  const activeDirectorRuntimeBlockedReason = activeDirectorDashboardView?.userActionReason?.trim()
    || activeDirectorRuntimeProjection?.blockedReason?.trim()
    || activeDirectorRuntimeProjection?.detail?.trim()
    || null;
  const activeAutoDirectorFollowUpQuery = useQuery({
    queryKey: queryKeys.autoDirectorFollowUps.detail(selectedDirectorTaskId || "none"),
    queryFn: () => getAutoDirectorFollowUpDetail(selectedDirectorTaskId),
    enabled: Boolean(selectedDirectorTaskId),
    retry: false,
    refetchInterval: () => (
      displayAutoDirectorTask && (
        displayAutoDirectorTask.status === "queued"
        || displayAutoDirectorTask.status === "running"
        || displayAutoDirectorTask.status === "waiting_approval"
      )
        ? 4000
        : false
    ),
  });
  const activeAutoDirectorFollowUp = activeAutoDirectorFollowUpQuery.data?.data ?? null;
  const workflowCurrentTab = useMemo(
    () => {
      const displayStageTab = tabFromDirectorDisplayStage(activeDirectorSnapshot?.displayState.stageKey ?? null);
      if (displayStageTab) {
        return displayStageTab;
      }
      return tabFromDirectorProgress({
        currentStage: activeAutoDirectorTask?.currentStage,
        currentItemKey: activeAutoDirectorTask?.currentItemKey,
        checkpointType: activeAutoDirectorTask?.checkpointType,
        reviewScope: activeDirectorSession?.reviewScope ?? null,
        status: activeAutoDirectorTask?.status,
      });
    },
    [
      activeDirectorSnapshot?.displayState.stageKey,
      activeAutoDirectorTask?.checkpointType,
      activeAutoDirectorTask?.currentItemKey,
      activeAutoDirectorTask?.currentStage,
      activeDirectorSession?.reviewScope,
      activeAutoDirectorTask?.status,
    ],
  );
  const autoDirectorRefreshSignatureRef = useRef("");
  const autoDirectorArtifactSignatureRef = useRef("");
  const autoDirectorWorkspaceSignatureRef = useRef("");
  const activeAutoDirectorRefreshSignature = useMemo(() => {
    if (!activeAutoDirectorTask) {
      return "";
    }
    return [
      activeAutoDirectorTask.id,
      activeAutoDirectorTask.status,
      activeAutoDirectorTask.pendingManualRecovery ? "manual_recovery" : "",
      activeAutoDirectorTask.currentStage ?? "",
      activeAutoDirectorTask.currentItemKey ?? "",
      activeAutoDirectorTask.checkpointType ?? "",
    ].join("|");
  }, [
    activeAutoDirectorTask,
    activeAutoDirectorTask?.checkpointType,
    activeAutoDirectorTask?.currentItemKey,
    activeAutoDirectorTask?.currentStage,
    activeAutoDirectorTask?.id,
    activeAutoDirectorTask?.pendingManualRecovery,
    activeAutoDirectorTask?.status,
  ]);
  const activeAutoDirectorArtifactSignature = useMemo(() => {
    if (!activeAutoDirectorTask) {
      return "";
    }
    const milestoneCount = Array.isArray(activeAutoDirectorTask.meta?.milestones)
      ? activeAutoDirectorTask.meta.milestones.length
      : 0;
    return [
      activeAutoDirectorTask.status,
      activeAutoDirectorTask.checkpointType ?? "",
      activeAutoDirectorTask.meta?.directorSession && typeof activeAutoDirectorTask.meta.directorSession === "object"
        ? JSON.stringify((activeAutoDirectorTask.meta.directorSession as { phase?: unknown }).phase ?? "")
        : "",
      milestoneCount,
    ].join("|");
  }, [
    activeAutoDirectorTask,
    activeAutoDirectorTask?.checkpointType,
    activeAutoDirectorTask?.meta,
    activeAutoDirectorTask?.status,
  ]);
  const activeAutoDirectorWorkspaceSignature = useMemo(() => {
    if (!activeAutoDirectorTask || !activeDirectorSnapshot) {
      return "";
    }
    const latestEvent = activeDirectorSnapshot.recentEvents.at(-1);
    const progressBreakdown = activeDirectorSnapshot.projection?.progressBreakdown;
    return [
      activeAutoDirectorTask.id,
      activeAutoDirectorTask.status,
      activeDirectorSnapshot.displayState.stageKey,
      activeDirectorSnapshot.currentFactStepId ?? "",
      activeDirectorSnapshot.displayState.progressPercent,
      progressBreakdown?.planningPercent ?? "",
      progressBreakdown?.chapterExecutionPercent ?? "",
      progressBreakdown?.qualityRepairPercent ?? "",
      progressBreakdown?.activeJobProgress ?? "",
      latestEvent?.eventId ?? "",
      activeDirectorSnapshot.artifacts.length,
      activeDirectorSnapshot.task.currentItemKey ?? "",
      activeDirectorSnapshot.task.checkpointType ?? "",
    ].join("|");
  }, [activeAutoDirectorTask, activeDirectorSnapshot]);
  const dismissTakeover = () => {
    if (!activeAutoDirectorRefreshSignature) {
      return;
    }
    setIsDirectorExitActionExpanded(false);
    setDismissedTakeoverSignature(activeAutoDirectorRefreshSignature);
    window.sessionStorage.setItem(
      takeoverDismissStorageKey(id),
      activeAutoDirectorRefreshSignature,
    );
    toast.success("已收起这条导演接管提醒。需要时仍可从执行详情继续处理。");
  };
  const isTakeoverDismissed = Boolean(
    activeAutoDirectorRefreshSignature
    && dismissedTakeoverSignature
    && dismissedTakeoverSignature === activeAutoDirectorRefreshSignature,
  );
  const openAuditIssueIds = useMemo(
    () => chapterAuditReports.flatMap((report) => report.issues.filter((issue) => issue.status === "open").map((issue) => issue.id)),
    [chapterAuditReports],
  );

  return {
    activeDirectorTask, activeAutoDirectorTask, bookAutomationProjection, requestedDirectorTaskId, requestedDirectorTaskQuery, requestedDirectorTask,
    visibleDirectorTask, displayAutoDirectorTask, actionTargetDirectorTaskId, selectedDirectorTaskId, activeDirectorSession, chapterPendingCharacterResourceProposals,
    visibleAutoExecutionScopeLabel, activeAutoExecutionScopeLabel, activeChapterTitleWarning, directorTaskSnapshotQuery, activeDirectorSnapshot, activeStructuredOutlineChapterId,
    activeDirectorRuntimeSnapshot, activeDirectorRuntimeProjection, activeDirectorDashboardView, activeDirectorRuntimeHardBlocked, activeDirectorRuntimeBlockedReason, activeAutoDirectorFollowUpQuery,
    activeAutoDirectorFollowUp, workflowCurrentTab, autoDirectorRefreshSignatureRef, autoDirectorArtifactSignatureRef, autoDirectorWorkspaceSignatureRef, activeAutoDirectorRefreshSignature,
    activeAutoDirectorArtifactSignature, activeAutoDirectorWorkspaceSignature, dismissTakeover, isTakeoverDismissed, openAuditIssueIds, takeoverDismissStorageKey,
  };
}
