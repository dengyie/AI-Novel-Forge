import { useEffect, useMemo } from "react";
import { useMutation } from "@tanstack/react-query";
import { backfillNovelCharacterResources, confirmCharacterResourceProposal, extractChapterResources, rejectCharacterResourceProposal } from "@/api/novel";
import { queryKeys } from "@/api/queryKeys";
import { toast } from "@/components/ui/toast";
import { useSSE } from "@/hooks/useSSE";
import { useNovelCharacterMutations } from "../useNovelCharacterMutations";
import { useNovelEditChapterRuntime } from "../useNovelEditChapterRuntime";
import { useNovelEditMutations } from "../useNovelEditMutations";
import { useNovelEditInitialization } from "../useNovelEditInitialization";
import { useVolumeVersionControl } from "../useVolumeVersionControl";
import { useNovelWorkspaceQueries } from "./useNovelWorkspaceQueries";
import { syncNovelWorkflowStageSilently, workflowStageFromTab } from "../../novelWorkflow.client";
import { isNovelWorkspaceFlowTab, tabFromDirectorDisplayStage } from "../../novelWorkspaceNavigation";
import { useStructuredOutlineWorkspaceStore } from "../../stores/useStructuredOutlineWorkspaceStore";
import { buildVolumePlanningReadiness, buildOutlinePreviewFromVolumes, buildStructuredPreviewFromVolumes } from "../../volumePlan.utils";
import { useNovelDirectorTaskController } from "./useNovelDirectorTaskController";
import { useNovelDirectorTaskActions } from "../../automation/directorTaskActions";
import { useNovelTaskDrawerController } from "./useNovelTaskDrawerController";

export function useNovelPipelineController(
  workspace: ReturnType<typeof useNovelWorkspaceQueries>,
  director: ReturnType<typeof useNovelDirectorTaskController>,
  directorActions: ReturnType<typeof useNovelDirectorTaskActions>,
  taskDrawer: ReturnType<typeof useNovelTaskDrawerController>,
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
    activeAutoDirectorArtifactSignature, activeAutoDirectorWorkspaceSignature, dismissTakeover, isTakeoverDismissed, openAuditIssueIds,
  } = director;
  const {
    openAutoDirectorTaskCenter, invalidateAutoDirectorTaskState, invalidateWorkspaceDataForTabs, invalidateVisibleWorkspaceData, alignToAutoDirectorResumeTarget, continueAutoDirectorMutation,
    continueAutoExecutionMutation, continueProjectedDirectorActionMutation, executeFollowUpActionMutation, consistencyIssue, reviewScope, reviewTab,
    openReviewStage, openCandidateSelection, openChapterExecution, openQualityRepair, openChapterTitleRepair, handleTaskDrawerProjectionAction,
    handleDrawerFollowUpAction, chapterTitleRepairMutation, retryableAutoDirectorTask, retryAutoDirectorWithCurrentModelMutation, retryAutoDirectorWithTaskModelMutation, cancelAutoDirectorMutation,
    archiveCompletedAutoDirectorMutation,
  } = directorActions;
  const {
    takeover, taskDrawerActions,
  } = taskDrawer;
  useNovelEditInitialization({
    detail: novelDetailQuery.data?.data,
    chapters,
    characters,
    baseCharacters,
    basicForm,
    selectedCharacter,
    selectedChapterId,
    selectedCharacterId,
    selectedBaseCharacterId,
    sourceNovelBookAnalysisOptions,
    sourceBookAnalysesLoading: sourceBookAnalysesQuery.isLoading,
    sourceBookAnalysesFetching: sourceBookAnalysesQuery.isFetching,
    hydrateVolumeDraftFromDetail: !shouldLoadVolumeWorkspace,
    setBasicForm,
    setVolumeDraft,
    setPipelineForm,
    setSelectedChapterId,
    setSelectedCharacterId,
    setSelectedBaseCharacterId,
    setCharacterForm,
  });

  useEffect(() => {
    const workspace = volumeWorkspaceQuery.data?.data;
    if (!workspace) {
      return;
    }
    setVolumeDraft(workspace.volumes ?? []);
    setVolumeStrategyPlan(workspace.strategyPlan ?? null);
    setVolumeCritiqueReport(workspace.critiqueReport ?? null);
    setVolumeBeatSheets(workspace.beatSheets ?? []);
    setVolumeRebalanceDecisions(workspace.rebalanceDecisions ?? []);
  }, [volumeWorkspaceQuery.data?.data]);

  useEffect(() => {
    if (!id) {
      return;
    }
    useStructuredOutlineWorkspaceStore.getState().patchWorkspace(id, {
      selectedVolumeId: selectedVolumeId || undefined,
      selectedChapterId: selectedChapterId || undefined,
    });
  }, [id, selectedChapterId, selectedVolumeId]);

  useEffect(() => {
    if (!id || activeTab !== "structured" || !activeStructuredOutlineChapterId) {
      return;
    }
    const targetVolume = normalizedVolumeDraft.find((volume) => (
      volume.chapters.some((chapter) => (
        chapter.id === activeStructuredOutlineChapterId
        || chapter.chapterId === activeStructuredOutlineChapterId
      ))
    ));
    if (!targetVolume) {
      return;
    }
    const currentWorkspace = useStructuredOutlineWorkspaceStore.getState().workspaces[id];
    if (
      currentWorkspace?.selectedChapterId === activeStructuredOutlineChapterId
      && currentWorkspace.selectedVolumeId === targetVolume.id
      && currentWorkspace.selectedBeatKey === "all"
    ) {
      return;
    }
    useStructuredOutlineWorkspaceStore.getState().patchWorkspace(id, {
      selectedVolumeId: targetVolume.id,
      selectedChapterId: activeStructuredOutlineChapterId,
      selectedBeatKey: "all",
    });
  }, [activeStructuredOutlineChapterId, activeTab, id, normalizedVolumeDraft]);

  useEffect(() => {
    if (!id) {
      return;
    }
    if (
      activeAutoDirectorTask
      && (
        activeAutoDirectorTask.status === "queued"
        || activeAutoDirectorTask.status === "running"
        || activeAutoDirectorTask.status === "waiting_approval"
      )
    ) {
      return;
    }
    const labels: Record<string, string> = {
      basic: "项目设定已打开",
      story_macro: "故事宏观规划已打开",
      character: "角色准备已打开",
      outline: "卷战略 / 卷骨架已打开",
      structured: "节奏 / 拆章已打开",
      chapter: selectedChapter ? `正在查看第${selectedChapter.order}章执行面板` : "章节执行已打开",
      pipeline: "质量修复 / 流水线已打开",
    };
    void syncNovelWorkflowStageSilently({
      novelId: id,
      stage: workflowStageFromTab(activeTab),
      itemLabel: labels[activeTab] ?? "小说主流程已打开",
      chapterId: activeTab === "chapter" ? selectedChapterId || undefined : undefined,
      volumeId: activeTab === "structured" || activeTab === "outline" ? selectedVolumeId || undefined : undefined,
      status: "waiting_approval",
    });
  }, [activeAutoDirectorTask, activeTab, id, selectedChapter?.order, selectedChapterId, selectedVolumeId]);

  useEffect(() => {
    if (!id || !activeAutoDirectorTask || !activeAutoDirectorRefreshSignature) {
      autoDirectorRefreshSignatureRef.current = activeAutoDirectorRefreshSignature;
      return;
    }
    if (!autoDirectorRefreshSignatureRef.current) {
      autoDirectorRefreshSignatureRef.current = activeAutoDirectorRefreshSignature;
      return;
    }
    if (autoDirectorRefreshSignatureRef.current === activeAutoDirectorRefreshSignature) {
      return;
    }
    autoDirectorRefreshSignatureRef.current = activeAutoDirectorRefreshSignature;
    void invalidateAutoDirectorTaskState(activeAutoDirectorTask.id);
  }, [activeAutoDirectorRefreshSignature, activeAutoDirectorTask, id, queryClient]);

  useEffect(() => {
    if (!id || !activeAutoDirectorTask || !activeAutoDirectorWorkspaceSignature) {
      autoDirectorWorkspaceSignatureRef.current = activeAutoDirectorWorkspaceSignature;
      return;
    }
    if (!autoDirectorWorkspaceSignatureRef.current) {
      autoDirectorWorkspaceSignatureRef.current = activeAutoDirectorWorkspaceSignature;
      return;
    }
    if (autoDirectorWorkspaceSignatureRef.current === activeAutoDirectorWorkspaceSignature) {
      return;
    }
    autoDirectorWorkspaceSignatureRef.current = activeAutoDirectorWorkspaceSignature;
    const recommendedTab = tabFromDirectorDisplayStage(activeDirectorSnapshot?.displayState.stageKey ?? null);
    void invalidateWorkspaceDataForTabs([
      isNovelWorkspaceFlowTab(activeTab) ? activeTab : null,
      recommendedTab,
      workflowCurrentTab,
    ]);
  }, [
    activeAutoDirectorTask,
    activeAutoDirectorWorkspaceSignature,
    activeDirectorSnapshot?.displayState.stageKey,
    activeTab,
    id,
    workflowCurrentTab,
  ]);

  useEffect(() => {
    if (!id || !activeAutoDirectorTask || !activeAutoDirectorArtifactSignature) {
      autoDirectorArtifactSignatureRef.current = activeAutoDirectorArtifactSignature;
      return;
    }
    if (!autoDirectorArtifactSignatureRef.current) {
      autoDirectorArtifactSignatureRef.current = activeAutoDirectorArtifactSignature;
      return;
    }
    if (autoDirectorArtifactSignatureRef.current === activeAutoDirectorArtifactSignature) {
      return;
    }
    autoDirectorArtifactSignatureRef.current = activeAutoDirectorArtifactSignature;
    void invalidateVisibleWorkspaceData();
  }, [activeAutoDirectorArtifactSignature, activeAutoDirectorTask, id, queryClient, selectedChapterId]);

  const outlineText = useMemo(
    () => buildOutlinePreviewFromVolumes(normalizedVolumeDraft),
    [normalizedVolumeDraft],
  );
  const structuredDraftText = useMemo(
    () => buildStructuredPreviewFromVolumes(normalizedVolumeDraft),
    [normalizedVolumeDraft],
  );
  const draftVolumeDocument = useMemo(() => ({
    novelId: id,
    workspaceVersion: "v2" as const,
    volumes: normalizedVolumeDraft,
    strategyPlan: volumeStrategyPlan,
    critiqueReport: volumeCritiqueReport,
    beatSheets: volumeBeatSheets,
    rebalanceDecisions: volumeRebalanceDecisions,
    readiness: buildVolumePlanningReadiness({
      volumes: normalizedVolumeDraft,
      strategyPlan: volumeStrategyPlan,
      beatSheets: volumeBeatSheets,
    }),
    derivedOutline: outlineText,
    derivedStructuredOutline: structuredDraftText,
    source: savedVolumeWorkspace?.source ?? "volume",
    activeVersionId: savedVolumeWorkspace?.activeVersionId ?? null,
  }), [
    id,
    normalizedVolumeDraft,
    outlineText,
    savedVolumeWorkspace?.activeVersionId,
    savedVolumeWorkspace?.source,
    structuredDraftText,
    volumeBeatSheets,
    volumeCritiqueReport,
    volumeRebalanceDecisions,
    volumeStrategyPlan,
  ]);

  const invalidateNovelDetail = async () => {
    await queryClient.invalidateQueries({ queryKey: queryKeys.novels.detail(id) });
    await queryClient.invalidateQueries({ queryKey: queryKeys.novels.volumeWorkspace(id) });
    await queryClient.invalidateQueries({ queryKey: queryKeys.novels.qualityReport(id) });
    await queryClient.invalidateQueries({ queryKey: queryKeys.novels.qualityDebt(id) });
    await queryClient.invalidateQueries({ queryKey: queryKeys.novels.latestStateSnapshot(id) });
    await queryClient.invalidateQueries({ queryKey: ["novels", "payoff-ledger", id] });
    await queryClient.invalidateQueries({ queryKey: queryKeys.novels.worldSlice(id) });
    await queryClient.invalidateQueries({ queryKey: queryKeys.novels.characterDynamicsOverview(id) });
    await queryClient.invalidateQueries({ queryKey: queryKeys.novels.characterCandidates(id) });
    await queryClient.invalidateQueries({ queryKey: queryKeys.novels.characterCastOptions(id) });
    await queryClient.invalidateQueries({ queryKey: queryKeys.novels.characterRelations(id) });
    await queryClient.invalidateQueries({ queryKey: queryKeys.novels.characterResources(id) });
    await queryClient.invalidateQueries({ queryKey: ["novels", "chapter-plan", id] });
    await queryClient.invalidateQueries({ queryKey: ["novels", "chapter-audit-reports", id] });
    await queryClient.invalidateQueries({ queryKey: ["novels", "chapter-timeline", id] });
    await queryClient.invalidateQueries({ queryKey: ["novels", "state-snapshots", id] });
  };

  const invalidateCharacterResourceViews = async () => {
    await queryClient.invalidateQueries({ queryKey: queryKeys.novels.characterResources(id) });
    if (selectedChapterId) {
      await queryClient.invalidateQueries({
        queryKey: queryKeys.novels.characterResourceContext(id, selectedChapterId),
      });
    }
    await queryClient.invalidateQueries({ queryKey: queryKeys.novels.latestStateSnapshot(id) });
    await queryClient.invalidateQueries({ queryKey: ["novels", "state-snapshots", id] });
  };

  const confirmCharacterResourceProposalMutation = useMutation({
    mutationFn: (proposalId: string) => confirmCharacterResourceProposal(id, proposalId),
    onSuccess: async () => {
      await invalidateCharacterResourceViews();
      toast.success("资源变更已确认，后续写作会参考它。");
    },
    onError: (error) => {
      toast.error(error instanceof Error ? error.message : "确认资源变更失败。");
    },
  });

  const rejectCharacterResourceProposalMutation = useMutation({
    mutationFn: (proposalId: string) => rejectCharacterResourceProposal(id, proposalId),
    onSuccess: async () => {
      await invalidateCharacterResourceViews();
      toast.success("资源变更已忽略。");
    },
    onError: (error) => {
      toast.error(error instanceof Error ? error.message : "忽略资源变更失败。");
    },
  });

  const extractChapterResourcesMutation = useMutation({
    mutationFn: async () => {
      if (!selectedChapterId) {
        throw new Error("请先选择要复查资源的章节。");
      }
      return extractChapterResources(id, selectedChapterId, {
        provider: llm.provider,
        model: llm.model,
      });
    },
    onSuccess: async (response) => {
      await invalidateCharacterResourceViews();
      const committedCount = response.data?.committed.length ?? 0;
      const pendingCount = response.data?.pendingReview.length ?? 0;
      if (pendingCount > 0) {
        toast.success(`已复查本章资源，${pendingCount} 个变更需要你判断。`);
        return;
      }
      toast.success(committedCount > 0
        ? `已复查本章资源，${committedCount} 个变更会用于后续写作。`
        : "已复查本章资源，未发现需要更新的关键资源。");
    },
    onError: (error) => {
      toast.error(error instanceof Error ? error.message : "复查本章资源失败。");
    },
  });

  const backfillCharacterResourcesMutation = useMutation({
    mutationFn: () => backfillNovelCharacterResources(id, {
      provider: llm.provider,
      model: llm.model,
      limit: 3,
    }),
    onSuccess: async (response) => {
      await invalidateCharacterResourceViews();
      const scanned = response.data?.scannedChapterCount ?? 0;
      const committed = response.data?.committedCount ?? 0;
      const pending = response.data?.pendingReviewCount ?? 0;
      toast.success(pending > 0
        ? `已回填最近 ${scanned} 章资源，${pending} 条变化需要你判断。`
        : `已回填最近 ${scanned} 章资源，${committed} 条变化会用于后续写作。`);
    },
    onError: (error) => {
      toast.error(error instanceof Error ? error.message : "回填角色资源失败。");
    },
  });

  const chapterSSE = useSSE({
    onRunStatus: (payload) => {
      if ((payload.phase === "finalizing" || payload.phase === "completed") && payload.message) {
        setChapterOperationMessage(payload.message);
      }
    },
    onDone: async () => {
      await invalidateNovelDetail();
      setActiveChapterStream(null);
    },
  });
  const bibleSSE = useSSE({ onDone: invalidateNovelDetail });
  const beatsSSE = useSSE({ onDone: invalidateNovelDetail });
  const repairSSE = useSSE({
    onRunStatus: (payload) => {
      if ((payload.phase === "finalizing" || payload.phase === "completed") && payload.message) {
        setChapterOperationMessage(payload.message);
      }
    },
    onDone: async (fullContent) => {
      setRepairAfterContent(fullContent);
      await invalidateNovelDetail();
      setActiveRepairStream(null);
    },
  });

  // SSE 错误（含 120s 静默看门狗）必须在章节主链路可见：
  // 否则看门狗触发后用户只看到转圈停了，不知道为什么停、能否重试。
  // 参照 WorldGenerator 的 analyzeStream.error → toast 模式。
  useEffect(() => {
    if (!chapterSSE.error) {
      return;
    }
    setActiveChapterStream(null);
    setChapterOperationMessage(`章节生成中断：${chapterSSE.error}已生成的内容会保留，可重新发起本章写作。`);
    toast.error(`章节生成中断：${chapterSSE.error}`);
  }, [chapterSSE.error]);

  useEffect(() => {
    if (!repairSSE.error) {
      return;
    }
    setActiveRepairStream(null);
    setChapterOperationMessage(`章节修复中断：${repairSSE.error}可先查看当前修复结果，再决定是否重试。`);
    toast.error(`章节修复中断：${repairSSE.error}`);
  }, [repairSSE.error]);

  useEffect(() => {
    if (bibleSSE.error) {
      toast.error(`写作圣经生成中断：${bibleSSE.error}`);
    }
  }, [bibleSSE.error]);

  useEffect(() => {
    if (beatsSSE.error) {
      toast.error(`剧情节拍生成中断：${beatsSSE.error}`);
    }
  }, [beatsSSE.error]);

  const {
    saveBasicMutation,
    saveOutlineMutation,
    saveStructuredMutation,
    optimizeOutlineMutation,
    optimizeStructuredMutation,
    syncStructuredChaptersMutation,
    createChapterMutation,
    runPipelineMutation,
    reviewMutation,
    hookMutation,
  } = useNovelEditMutations({
    id,
    basicForm,
    hasCharacters,
    outlineText,
    outlineOptimizeInstruction,
    setOutlineOptimizePreview,
    setOutlineOptimizeMode,
    setOutlineOptimizeSourceText,
    structuredDraftText,
    structuredOptimizeInstruction,
    setStructuredOptimizePreview,
    setStructuredOptimizeMode,
    setStructuredOptimizeSourceText,
    volumeDocument: draftVolumeDocument,
    llm,
    pipelineForm,
    selectedChapterId,
    chapterCount: novelDetailQuery.data?.data?.chapters?.length ?? 0,
    setActiveTab,
    setSelectedChapterId,
    setCurrentJobId,
    setPipelineMessage,
    setStructuredMessage,
    setReviewResult,
    queryClient,
    invalidateNovelDetail,
  });

  const {
    characterTimelineQuery,
    syncTimelineMutation,
    syncAllTimelineMutation,
    evolveCharacterMutation,
    generateVisibleProfileMutation,
    applyVisibleProfileMutation,
    generateBatchVisibleProfilesMutation,
    applyBatchVisibleProfilesMutation,
    worldCheckMutation,
    saveCharacterMutation,
    importBaseCharacterMutation,
    quickCreateCharacterMutation,
    deleteCharacterMutation,
    generateSupplementalCharacterMutation,
    applySupplementalCharacterMutation,
  } = useNovelCharacterMutations({
    id,
    selectedCharacterId,
    selectedBaseCharacter,
    characters,
    pipelineForm,
    llm,
    characterForm,
    quickCharacterForm,
    queryClient,
    setCharacterMessage,
    setSelectedCharacterId,
    setQuickCharacterForm,
  });

  const {
    volumeMessage,
    volumeVersions,
    selectedVersionId,
    setSelectedVersionId,
    diffResult,
    impactResult,
    createDraftVersionMutation,
    activateVersionMutation,
    freezeVersionMutation,
    diffMutation,
    analyzeDraftImpactMutation,
    analyzeVersionImpactMutation,
    loadSelectedVersionToDraft,
  } = useVolumeVersionControl({
    novelId: id,
    draftDocument: draftVolumeDocument,
    setDraftVolumes: setVolumeDraft,
    setStrategyPlan: setVolumeStrategyPlan,
    setCritiqueReport: setVolumeCritiqueReport,
    setBeatSheets: setVolumeBeatSheets,
    setRebalanceDecisions: setVolumeRebalanceDecisions,
    queryClient,
    invalidateNovelDetail,
  });

  const goToCharacterTab = () => setActiveTab("character");
  const goToStructuredTab = () => setActiveTab("structured");
  const {
    generateChapterPlanMutation,
    replanChapterMutation,
    fullAuditMutation,
    reviewActionKind,
    runChapterReview,
    handleGenerateSelectedChapter,
    handleAbortChapterStream,
    handleAbortRepair,
    chapterExecutionActions,
  } = useNovelEditChapterRuntime({
    novelId: id,
    llm,
    selectedChapterId,
    selectedChapter,
    chapterStrategy,
    reviewResult,
    openAuditIssueIds,
    queryClient,
    invalidateNovelDetail,
    setChapterOperationMessage,
    setReviewResult,
    setRepairBeforeContent,
    setRepairAfterContent,
    setActiveChapterStream,
    setActiveRepairStream,
    chapterSSE,
    repairSSE,
  });

  return {
    outlineText, structuredDraftText, draftVolumeDocument, invalidateNovelDetail, invalidateCharacterResourceViews, confirmCharacterResourceProposalMutation,
    rejectCharacterResourceProposalMutation, extractChapterResourcesMutation, backfillCharacterResourcesMutation, chapterSSE, bibleSSE, beatsSSE,
    repairSSE, saveBasicMutation, saveOutlineMutation, saveStructuredMutation, optimizeOutlineMutation, optimizeStructuredMutation,
    syncStructuredChaptersMutation, createChapterMutation, runPipelineMutation, reviewMutation, hookMutation, characterTimelineQuery,
    syncTimelineMutation, syncAllTimelineMutation, evolveCharacterMutation, generateVisibleProfileMutation, applyVisibleProfileMutation, generateBatchVisibleProfilesMutation,
    applyBatchVisibleProfilesMutation, worldCheckMutation, saveCharacterMutation, importBaseCharacterMutation, quickCreateCharacterMutation, deleteCharacterMutation,
    generateSupplementalCharacterMutation, applySupplementalCharacterMutation, volumeMessage, volumeVersions, selectedVersionId, setSelectedVersionId,
    diffResult, impactResult, createDraftVersionMutation, activateVersionMutation, freezeVersionMutation, diffMutation,
    analyzeDraftImpactMutation, analyzeVersionImpactMutation, loadSelectedVersionToDraft, goToCharacterTab, goToStructuredTab, generateChapterPlanMutation,
    replanChapterMutation, fullAuditMutation, reviewActionKind, runChapterReview, handleGenerateSelectedChapter, handleAbortChapterStream,
    handleAbortRepair, chapterExecutionActions,
  };
}
