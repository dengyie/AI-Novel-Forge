import { useEffect, useMemo } from "react";
import { useMutation } from "@tanstack/react-query";
import type { DirectorContinuationMode } from "@ai-novel/shared/types/novelDirector";
import type { AutoDirectorAction, AutoDirectorMutationActionCode } from "@ai-novel/shared/types/autoDirectorFollowUp";
import type { DirectorBookAutomationAction } from "@ai-novel/shared/types/directorRuntime";
import { continueNovelWorkflow } from "@/api/novelWorkflow";
import { archiveTask, cancelTask, retryTask } from "@/api/tasks";
import { executeAutoDirectorFollowUpAction } from "@/api/autoDirectorFollowUps";
import { queryKeys } from "@/api/queryKeys";
import { toast } from "@/components/ui/toast";
import { useDirectorChapterTitleRepair } from "@/hooks/useDirectorChapterTitleRepair";
import { useNovelWorkspaceQueries } from "../hooks/novelEdit/useNovelWorkspaceQueries";
import { isNovelWorkspaceFlowTab, tabFromScope, type NovelWorkspaceFlowTab } from "../novelWorkspaceNavigation";
import { resolveInternalNavigationTarget } from "@/lib/internalNavigation";
import { resolveDirectorContinueMode, resolveWorkflowContinuationFeedback } from "@/lib/novelWorkflowContinuation";
import { getDirectorCockpitActionHref, getDirectorCockpitContinuationMode, isDirectorCockpitContinuationAction } from "@/lib/directorCockpitActions";
import { getCandidateSelectionLink } from "@/lib/novelWorkflowTaskUi";
import { syncAutoDirectorTaskCache } from "@/lib/taskQueryCache";
import { useStructuredOutlineWorkspaceStore } from "../stores/useStructuredOutlineWorkspaceStore";
import { useNovelDirectorTaskController } from "../hooks/novelEdit/useNovelDirectorTaskController";

function resolveDirectorConsistencyIssue(input: {
  checkpointType: string | null | undefined;
  characterCount: number;
  chapterCount: number;
}): "missing_characters" | "missing_chapters" | null {
  if (input.checkpointType !== "chapter_batch_ready") {
    return null;
  }
  if (input.characterCount === 0) {
    return "missing_characters";
  }
  if (input.chapterCount === 0) {
    return "missing_chapters";
  }
  return null;
}

export function useNovelDirectorTaskActions(
  workspace: ReturnType<typeof useNovelWorkspaceQueries>,
  director: ReturnType<typeof useNovelDirectorTaskController>,
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
  const {
    activeDirectorTask, activeAutoDirectorTask, bookAutomationProjection, requestedDirectorTaskId, requestedDirectorTaskQuery, requestedDirectorTask,
    visibleDirectorTask, displayAutoDirectorTask, actionTargetDirectorTaskId, selectedDirectorTaskId, activeDirectorSession, chapterPendingCharacterResourceProposals,
    visibleAutoExecutionScopeLabel, activeAutoExecutionScopeLabel, activeChapterTitleWarning, directorTaskSnapshotQuery, activeDirectorSnapshot, activeStructuredOutlineChapterId,
    activeDirectorRuntimeSnapshot, activeDirectorRuntimeProjection, activeDirectorDashboardView, activeDirectorRuntimeHardBlocked, activeDirectorRuntimeBlockedReason, activeAutoDirectorFollowUpQuery,
    activeAutoDirectorFollowUp, workflowCurrentTab, autoDirectorRefreshSignatureRef, autoDirectorArtifactSignatureRef, autoDirectorWorkspaceSignatureRef, activeAutoDirectorRefreshSignature,
    activeAutoDirectorArtifactSignature, activeAutoDirectorWorkspaceSignature, dismissTakeover, isTakeoverDismissed, openAuditIssueIds, takeoverDismissStorageKey,
  } = director;
  const openAutoDirectorTaskCenter = (directorTaskId?: string) => {
    const targetId = directorTaskId || actionTargetDirectorTaskId || activeAutoDirectorTask?.id;
    if (targetId) {
      navigate(`/tasks?kind=novel_workflow&id=${targetId}`);
      return;
    }
    navigate("/tasks");
  };
  const invalidateAutoDirectorTaskState = async (taskId?: string) => {
    const invalidations: Array<Promise<unknown>> = [
      queryClient.invalidateQueries({ queryKey: queryKeys.novels.autoDirectorTask(id) }),
      queryClient.invalidateQueries({ queryKey: queryKeys.novels.directorBookAutomation(id) }),
      queryClient.invalidateQueries({ queryKey: queryKeys.tasks.overview }),
      queryClient.invalidateQueries({ queryKey: queryKeys.tasks.recoveryCandidates }),
    ];
    if (taskId) {
      invalidations.push(
        queryClient.invalidateQueries({ queryKey: queryKeys.tasks.detail("novel_workflow", taskId) }),
        queryClient.invalidateQueries({ queryKey: queryKeys.tasks.directorTaskSnapshot(taskId) }),
        queryClient.invalidateQueries({ queryKey: queryKeys.tasks.directorRuntime(taskId) }),
        queryClient.invalidateQueries({ queryKey: queryKeys.autoDirectorFollowUps.detail(taskId) }),
      );
    }
    await Promise.allSettled(invalidations);
  };
  const invalidateWorkspaceDataForTabs = async (tabs: Array<NovelWorkspaceFlowTab | null | undefined>) => {
    const invalidations: Array<Promise<unknown>> = [];
    const targetTabs = new Set(tabs.filter((tab): tab is NovelWorkspaceFlowTab => Boolean(tab)));
    if (targetTabs.has("basic")) {
      invalidations.push(
        queryClient.invalidateQueries({ queryKey: queryKeys.novels.detail(id) }),
        queryClient.invalidateQueries({ queryKey: queryKeys.novels.worldSlice(id) }),
      );
    }
    if (targetTabs.has("story_macro")) {
      invalidations.push(
        queryClient.invalidateQueries({ queryKey: queryKeys.novels.storyMacro(id) }),
        queryClient.invalidateQueries({ queryKey: queryKeys.novels.storyMacroState(id) }),
      );
    }
    if (targetTabs.has("character")) {
      invalidations.push(
        queryClient.invalidateQueries({ queryKey: queryKeys.novels.detail(id) }),
        queryClient.invalidateQueries({ queryKey: queryKeys.novels.characterCastOptions(id) }),
        queryClient.invalidateQueries({ queryKey: queryKeys.novels.characterDynamicsOverview(id) }),
        queryClient.invalidateQueries({ queryKey: queryKeys.novels.characterRelations(id) }),
        queryClient.invalidateQueries({ queryKey: queryKeys.novels.characterCandidates(id) }),
        queryClient.invalidateQueries({ queryKey: queryKeys.novels.characterResources(id) }),
      );
    }
    if (targetTabs.has("outline") || targetTabs.has("structured")) {
      invalidations.push(queryClient.invalidateQueries({ queryKey: queryKeys.novels.volumeWorkspace(id) }));
    }
    if (targetTabs.has("structured")) {
      invalidations.push(queryClient.invalidateQueries({ queryKey: queryKeys.novels.payoffLedger(id, payoffLedgerChapterOrder) }));
    }
    if (targetTabs.has("chapter")) {
      invalidations.push(
        queryClient.invalidateQueries({ queryKey: queryKeys.novels.detail(id) }),
        queryClient.invalidateQueries({ queryKey: queryKeys.novels.latestStateSnapshot(id) }),
        queryClient.invalidateQueries({ queryKey: queryKeys.novels.payoffLedger(id, payoffLedgerChapterOrder) }),
        queryClient.invalidateQueries({ queryKey: queryKeys.novels.characterResources(id) }),
      );
      if (selectedChapterId) {
        invalidations.push(
          queryClient.invalidateQueries({ queryKey: queryKeys.novels.characterResourceContext(id, selectedChapterId) }),
          queryClient.invalidateQueries({ queryKey: queryKeys.novels.chapterTimeline(id, selectedChapterId) }),
          queryClient.invalidateQueries({ queryKey: queryKeys.novels.chapterPlan(id, selectedChapterId) }),
          queryClient.invalidateQueries({ queryKey: queryKeys.novels.chapterAuditReports(id, selectedChapterId) }),
        );
      }
    }
    if (targetTabs.has("pipeline")) {
      invalidations.push(
        queryClient.invalidateQueries({ queryKey: queryKeys.novels.qualityReport(id) }),
        queryClient.invalidateQueries({ queryKey: queryKeys.novels.qualityDebt(id) }),
        queryClient.invalidateQueries({ queryKey: queryKeys.novels.latestStateSnapshot(id) }),
        queryClient.invalidateQueries({ queryKey: queryKeys.novels.payoffLedger(id, payoffLedgerChapterOrder) }),
        queryClient.invalidateQueries({ queryKey: queryKeys.novels.characterResources(id) }),
      );
    }
    await Promise.allSettled(invalidations);
  };
  const invalidateVisibleWorkspaceData = async () => {
    await invalidateWorkspaceDataForTabs([isNovelWorkspaceFlowTab(activeTab) ? activeTab : null]);
  };
  const alignToAutoDirectorResumeTarget = (task = visibleDirectorTask) => {
    const target = task?.resumeTarget;
    if (!target?.stage) {
      return;
    }
    setActiveTab(target.stage);
    if (target.chapterId) {
      setSelectedChapterId(target.chapterId);
    }
    if (target.volumeId) {
      setSelectedVolumeId(target.volumeId);
    }
  };
  const continueAutoDirectorMutation = useMutation({
    mutationFn: async (input?: { directorTaskId?: string }) => {
      const targetTaskId = input?.directorTaskId || actionTargetDirectorTaskId;
      const targetTask = targetTaskId === visibleDirectorTask?.id ? visibleDirectorTask : activeAutoDirectorTask;
      if (!targetTaskId) {
        throw new Error("当前没有可继续的自动导演任务。");
      }
      return continueNovelWorkflow(targetTaskId, {
        continuationMode: resolveDirectorContinueMode(targetTask),
      });
    },
    onSuccess: async (response, input) => {
      const targetTaskId = input?.directorTaskId || actionTargetDirectorTaskId;
      const targetTask = targetTaskId === visibleDirectorTask?.id ? visibleDirectorTask : activeAutoDirectorTask;
      setDirectorTaskId(response.data?.taskId ?? targetTaskId);
      void invalidateAutoDirectorTaskState(response.data?.taskId ?? targetTaskId);
      const feedback = resolveWorkflowContinuationFeedback(response.data, {
        mode: resolveDirectorContinueMode(targetTask),
      });
      if (feedback.tone === "error") {
        toast.error(feedback.message);
        return;
      }
      alignToAutoDirectorResumeTarget(targetTask);
      toast.success(feedback.message);
    },
    onError: (error) => {
      const message = error instanceof Error ? error.message : "继续自动导演失败。";
      toast.error(message);
    },
  });
  const continueAutoExecutionMutation = useMutation({
    // UI 主路径只发 auto_execute_range；废弃 skip_quality_repair 不得从编辑页露出
    mutationFn: async (input?: { directorTaskId?: string; continuationMode?: "auto_execute_range" }) => {
      const targetTaskId = input?.directorTaskId || actionTargetDirectorTaskId;
      if (!targetTaskId) {
        throw new Error("当前没有可继续自动执行的自动导演任务。");
      }
      return continueNovelWorkflow(targetTaskId, {
        continuationMode: input?.continuationMode ?? "auto_execute_range",
      });
    },
    onSuccess: async (response, input) => {
      const targetTaskId = input?.directorTaskId || actionTargetDirectorTaskId;
      const targetTask = targetTaskId === visibleDirectorTask?.id ? visibleDirectorTask : activeAutoDirectorTask;
      setDirectorTaskId(response.data?.taskId ?? targetTaskId);
      void invalidateAutoDirectorTaskState(response.data?.taskId ?? targetTaskId);
      const feedback = resolveWorkflowContinuationFeedback(response.data, {
        mode: input?.continuationMode ?? "auto_execute_range",
        scopeLabel: activeAutoExecutionScopeLabel,
      });
      if (feedback.tone === "error") {
        toast.error(feedback.message);
        return;
      }
      alignToAutoDirectorResumeTarget(targetTask);
      toast.success(feedback.message);
    },
    onError: (error) => {
      const message = error instanceof Error ? error.message : `继续自动执行${activeAutoExecutionScopeLabel}失败。`;
      toast.error(message);
    },
  });
  const continueProjectedDirectorActionMutation = useMutation({
    mutationFn: async (input: {
      taskId: string;
      mode?: DirectorContinuationMode;
    }) => continueNovelWorkflow(
      input.taskId,
      input.mode ? { continuationMode: input.mode } : undefined,
    ),
    onSuccess: async (response, input) => {
      setDirectorTaskId(response.data?.taskId ?? input.taskId);
      void invalidateAutoDirectorTaskState(response.data?.taskId ?? input.taskId);
      const feedback = resolveWorkflowContinuationFeedback(response.data, {
        mode: input.mode,
        scopeLabel: activeAutoExecutionScopeLabel,
      });
      if (feedback.tone === "error") {
        toast.error(feedback.message);
        return;
      }
      alignToAutoDirectorResumeTarget(input.taskId === visibleDirectorTask?.id ? visibleDirectorTask : activeAutoDirectorTask);
      toast.success(feedback.message);
    },
    onError: (error, input) => {
      const message = error instanceof Error
        ? error.message
        : input.mode === "auto_execute_range"
          ? `继续自动执行${activeAutoExecutionScopeLabel}失败。`
          : "继续自动导演失败。";
      toast.error(message);
    },
  });
  const executeFollowUpActionMutation = useMutation({
    mutationFn: async (input: {
      directorTaskId?: string;
      actionCode: AutoDirectorMutationActionCode;
    }) => {
      const targetTaskId = input.directorTaskId || actionTargetDirectorTaskId;
      if (!targetTaskId) {
        throw new Error("当前没有可执行的动作。");
      }
      return executeAutoDirectorFollowUpAction(targetTaskId, {
        actionCode: input.actionCode,
        idempotencyKey: `${targetTaskId}:${input.actionCode}:${Date.now()}`,
      });
    },
    onSuccess: async (response, input) => {
      const result = response.data;
      if (result?.task) {
        syncAutoDirectorTaskCache(queryClient, id, result.task);
      }
      setDirectorTaskId(result?.directorTaskId ?? result?.taskId ?? input.directorTaskId ?? actionTargetDirectorTaskId);
      await invalidateAutoDirectorTaskState(result?.directorTaskId ?? result?.taskId ?? input.directorTaskId ?? actionTargetDirectorTaskId);
      if (result?.code === "failed" || result?.code === "forbidden") {
        toast.error(result.message);
        return;
      }
      toast.success(result?.message ?? "已执行动作。");
    },
    onError: (error) => {
      toast.error(error instanceof Error ? error.message : "执行动作失败。");
    },
  });
  const consistencyIssue = useMemo(
    () => resolveDirectorConsistencyIssue({
      checkpointType: activeAutoDirectorTask?.checkpointType,
      characterCount: characters.length,
      chapterCount: chapters.length,
    }),
    [activeAutoDirectorTask?.checkpointType, chapters.length, characters.length],
  );
  const reviewScope = activeDirectorSession?.reviewScope ?? null;
  const reviewTab = useMemo(() => tabFromScope(reviewScope), [reviewScope]);
  const openReviewStage = () => {
    if (!reviewTab) {
      return;
    }
    setActiveTab(reviewTab);
    setIsTaskDrawerOpen(false);
  };
  const openCandidateSelection = (directorTaskId = actionTargetDirectorTaskId || activeAutoDirectorTask?.id || "") => {
    if (!directorTaskId) {
      return;
    }
    navigate(getCandidateSelectionLink(directorTaskId));
  };
  const openChapterExecution = (task = visibleDirectorTask) => {
    if (task?.resumeTarget?.chapterId) {
      setSelectedChapterId(task.resumeTarget.chapterId);
    }
    setActiveTab("chapter");
    setIsTaskDrawerOpen(false);
  };
  const openQualityRepair = (task = visibleDirectorTask) => {
    if (task?.resumeTarget?.chapterId) {
      setSelectedChapterId(task.resumeTarget.chapterId);
    }
    setActiveTab("pipeline");
    setIsTaskDrawerOpen(false);
  };
  const openChapterTitleRepair = (showToast = false) => {
    const targetVolumeId = activeChapterTitleWarning?.volumeId ?? activeAutoDirectorTask?.resumeTarget?.volumeId ?? "";
    setActiveTab("structured");
    setSelectedVolumeId(targetVolumeId);
    setSelectedChapterId("");
    useStructuredOutlineWorkspaceStore.getState().patchWorkspace(id, {
      selectedVolumeId: targetVolumeId || undefined,
      selectedChapterId: "",
      selectedBeatKey: "all",
    });
    setIsTaskDrawerOpen(false);
    if (!showToast) {
      return;
    }
    toast.success(targetVolumeId ? "已定位到当前卷拆章，可直接修复标题。" : "已切到节奏 / 拆章，可直接修复标题。");
  };
  const handleTaskDrawerProjectionAction = (action: DirectorBookAutomationAction) => {
    if (!bookAutomationProjection) {
      return;
    }
    const taskId = action.commandPayload?.taskId
      ?? action.target.taskId
      ?? bookAutomationProjection.latestTask?.id
      ?? activeAutoDirectorTask?.id;
    if (taskId && isDirectorCockpitContinuationAction(action)) {
      continueProjectedDirectorActionMutation.mutate({
        taskId,
        mode: getDirectorCockpitContinuationMode(action),
      });
      return;
    }
    if (action.type === "confirm_candidate") {
      openCandidateSelection(taskId);
      return;
    }
    if (action.type === "open_chapter") {
      openChapterExecution(taskId === visibleDirectorTask?.id ? visibleDirectorTask : undefined);
      return;
    }
    if (action.type === "open_quality_repair") {
      openQualityRepair(taskId === visibleDirectorTask?.id ? visibleDirectorTask : undefined);
      return;
    }
    if (action.type === "open_details") {
      openAutoDirectorTaskCenter(taskId);
      return;
    }
    setIsTaskDrawerOpen(false);
    navigate(getDirectorCockpitActionHref(bookAutomationProjection, action));
  };
  const handleDrawerFollowUpAction = (action: AutoDirectorAction) => {
    if (action.kind === "navigation") {
      const targetUrl = action.targetUrl?.trim() || visibleDirectorTask?.sourceRoute || activeAutoDirectorTask?.sourceRoute || "";
      const internalTarget = resolveInternalNavigationTarget(targetUrl);
      if (internalTarget) {
        setIsTaskDrawerOpen(false);
        navigate(internalTarget);
        return;
      }
      if (/^https?:\/\//i.test(targetUrl)) {
        window.location.assign(targetUrl);
      }
      return;
    }
    executeFollowUpActionMutation.mutate(
      {
        directorTaskId: activeAutoDirectorFollowUp?.directorTaskId ?? actionTargetDirectorTaskId,
        actionCode: (action.executorActionCode ?? action.code) as AutoDirectorMutationActionCode,
      },
    );
  };
  const chapterTitleRepairMutation = useDirectorChapterTitleRepair({
    navigateOnSuccess: false,
    onAfterStart: () => {
      openChapterTitleRepair(false);
    },
  });
  const retryableAutoDirectorTask = useMemo(() => {
    if (displayAutoDirectorTask && (displayAutoDirectorTask.status === "failed" || displayAutoDirectorTask.status === "cancelled")) {
      return displayAutoDirectorTask;
    }
    if (activeAutoDirectorTask && (activeAutoDirectorTask.status === "failed" || activeAutoDirectorTask.status === "cancelled")) {
      return activeAutoDirectorTask;
    }
    return null;
  }, [activeAutoDirectorTask, displayAutoDirectorTask]);
  const retryAutoDirectorWithCurrentModelMutation = useMutation({
    mutationFn: async () => {
      if (!retryableAutoDirectorTask?.id) {
        throw new Error("当前没有可重试的自动导演任务。");
      }
      return retryTask("novel_workflow", retryableAutoDirectorTask.id, {
        llmOverride: {
          provider: llm.provider,
          model: llm.model,
          temperature: llm.temperature,
        },
        resume: true,
      });
    },
    onSuccess: async (response) => {
      syncAutoDirectorTaskCache(queryClient, id, response.data);
      void invalidateAutoDirectorTaskState(response.data?.id ?? retryableAutoDirectorTask?.id);
      setIsTaskDrawerOpen(true);
      toast.success(`已切换到 ${llm.provider} / ${llm.model} 并重新启动自动导演。`);
    },
    onError: (error) => {
      const message = error instanceof Error ? error.message : "切换当前模型重试失败。";
      toast.error(message);
    },
  });
  const retryAutoDirectorWithTaskModelMutation = useMutation({
    mutationFn: async () => {
      if (!retryableAutoDirectorTask?.id) {
        throw new Error("当前没有可重试的自动导演任务。");
      }
      return retryTask("novel_workflow", retryableAutoDirectorTask.id, { resume: true });
    },
    onSuccess: async (response) => {
      syncAutoDirectorTaskCache(queryClient, id, response.data);
      void invalidateAutoDirectorTaskState(response.data?.id ?? retryableAutoDirectorTask?.id);
      setIsTaskDrawerOpen(true);
      toast.success("自动导演已按任务原模型重新启动。");
    },
    onError: (error) => {
      const message = error instanceof Error ? error.message : "按原模型重试失败。";
      toast.error(message);
    },
  });
  const cancelAutoDirectorMutation = useMutation({
    mutationFn: async (targetTaskId?: string) => {
      const taskId = targetTaskId || displayAutoDirectorTask?.id || activeAutoDirectorTask?.id;
      if (!taskId) {
        throw new Error("当前没有可取消的自动导演任务。");
      }
      return cancelTask("novel_workflow", taskId, { via: "novel_edit_auto_director" });
    },
    onSuccess: async (response, targetTaskId) => {
      setIsDirectorExitActionExpanded(false);
      syncAutoDirectorTaskCache(queryClient, id, response.data);
      void invalidateAutoDirectorTaskState(response.data?.id ?? targetTaskId ?? displayAutoDirectorTask?.id ?? activeAutoDirectorTask?.id);
      toast.success("已取消自动导演任务。");
    },
    onError: (error) => {
      const message = error instanceof Error ? error.message : "取消自动导演失败。";
      toast.error(message);
    },
  });
  const archiveCompletedAutoDirectorMutation = useMutation({
    mutationFn: async (targetTaskId?: string) => {
      const taskId = targetTaskId || displayAutoDirectorTask?.id;
      if (!taskId) {
        throw new Error("当前没有可收起的自动导演完成记录。");
      }
      return archiveTask("novel_workflow", taskId);
    },
    onSuccess: async (_response, targetTaskId) => {
      setIsDirectorExitActionExpanded(false);
      await invalidateAutoDirectorTaskState(targetTaskId ?? displayAutoDirectorTask?.id);
      toast.success("已收起这次自动导演完成提醒。");
    },
    onError: (error) => {
      const message = error instanceof Error ? error.message : "收起自动导演完成提醒失败。";
      toast.error(message);
    },
  });
  useEffect(() => {
    setRetryOverride({
      provider: llm.provider,
      model: llm.model,
      temperature: llm.temperature,
    });
  }, [activeAutoDirectorTask?.id, llm.model, llm.provider, llm.temperature]);
  useEffect(() => {
    if (activeAutoDirectorTask?.status !== "failed") {
      if (autoOpenedFailedTaskId) {
        setAutoOpenedFailedTaskId("");
      }
      return;
    }
    if (!activeAutoDirectorTask.id || activeAutoDirectorTask.id === autoOpenedFailedTaskId) {
      return;
    }
    setIsTaskDrawerOpen(true);
    setAutoOpenedFailedTaskId(activeAutoDirectorTask.id);
  }, [activeAutoDirectorTask?.id, activeAutoDirectorTask?.status, autoOpenedFailedTaskId]);
  useEffect(() => {
    if (!taskPanelOpen || !displayAutoDirectorTask?.id) {
      return;
    }
    setIsTaskDrawerOpen(true);
  }, [displayAutoDirectorTask?.id, taskPanelOpen]);
  useEffect(() => {
    if (!activeAutoDirectorTask) {
      setIsDirectorExitActionExpanded(false);
      setDismissedTakeoverSignature("");
      window.sessionStorage.removeItem(takeoverDismissStorageKey(id));
      return;
    }
    if (
      activeAutoDirectorTask.status !== "queued"
      && activeAutoDirectorTask.status !== "running"
      && activeAutoDirectorTask.status !== "waiting_approval"
    ) {
      setIsDirectorExitActionExpanded(false);
    }
  }, [activeAutoDirectorTask, id]);
  useEffect(() => {
    if (!id || !activeAutoDirectorRefreshSignature) {
      return;
    }
    const storedDismissedSignature = window.sessionStorage.getItem(takeoverDismissStorageKey(id)) ?? "";
    setDismissedTakeoverSignature(storedDismissedSignature);
  }, [activeAutoDirectorRefreshSignature, id]);

  return {
    openAutoDirectorTaskCenter, invalidateAutoDirectorTaskState, invalidateWorkspaceDataForTabs, invalidateVisibleWorkspaceData, alignToAutoDirectorResumeTarget, continueAutoDirectorMutation,
    continueAutoExecutionMutation, continueProjectedDirectorActionMutation, executeFollowUpActionMutation, consistencyIssue, reviewScope, reviewTab,
    openReviewStage, openCandidateSelection, openChapterExecution, openQualityRepair, openChapterTitleRepair, handleTaskDrawerProjectionAction,
    handleDrawerFollowUpAction, chapterTitleRepairMutation, retryableAutoDirectorTask, retryAutoDirectorWithCurrentModelMutation, retryAutoDirectorWithTaskModelMutation, cancelAutoDirectorMutation,
    archiveCompletedAutoDirectorMutation,
  };
}
