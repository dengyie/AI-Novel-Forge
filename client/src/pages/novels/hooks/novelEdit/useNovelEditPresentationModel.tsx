import { BOOK_ANALYSIS_SECTIONS } from "@ai-novel/shared/types/bookAnalysis";
import type { QuickCharacterCreatePayload } from "../../components/characterPanel.utils";
import type { ChapterExecutionStrategy } from "../../chapterExecution.utils";
import { useNovelWorkspaceQueries } from "./useNovelWorkspaceQueries";
import { buildNovelEditPlanningTabs } from "../../novelEditPlanningTabs";
import NovelExistingProjectTakeoverDialog from "../../components/NovelExistingProjectTakeoverDialog";
import { canCancelDirectorTask } from "@/lib/novelWorkflowTaskUi";
import { resolveTakeoverDialogContextTaskId } from "../../novelEditAutomationStatus";
import { patchNovelBasicForm } from "../../novelBasicInfo.shared";
import { applyVolumeChapterBatch } from "../../volumePlan.utils";
import type { NovelEditViewProps } from "../../components/NovelEditView.types";
import { useNovelDirectorTaskController } from "./useNovelDirectorTaskController";
import { useNovelDirectorTaskActions } from "../../automation/directorTaskActions";
import { useNovelTaskDrawerController } from "./useNovelTaskDrawerController";
import { useNovelPipelineController } from "./useNovelPipelineController";

export function useNovelEditPresentationModel(
  workspace: ReturnType<typeof useNovelWorkspaceQueries>,
  director: ReturnType<typeof useNovelDirectorTaskController>,
  directorActions: ReturnType<typeof useNovelDirectorTaskActions>,
  taskDrawer: ReturnType<typeof useNovelTaskDrawerController>,
  pipeline: ReturnType<typeof useNovelPipelineController>,
): NovelEditViewProps {
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
  const {
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
  } = pipeline;
  const renderTakeoverEntry = (
    step: "basic" | "story_macro" | "character" | "outline" | "structured" | "chapter" | "pipeline",
    variant: "default" | "outline" | "secondary" = "default",
  ) => {
    const takeoverContextTaskId = resolveTakeoverDialogContextTaskId({
      directorTaskId,
      activeAutoDirectorTask,
      projection: bookAutomationProjection,
    });

    return (
      <NovelExistingProjectTakeoverDialog
        novelId={id}
        basicForm={basicForm}
        genreOptions={genreOptions}
        storyModeOptions={storyModeOptions}
        worldOptions={worldListQuery.data?.data ?? []}
        triggerVariant={variant}
        defaultEntryStep={step}
        workflowTaskId={takeoverContextTaskId}
      />
    );
  };

  const { basicTab, outlineTab, structuredTab } = buildNovelEditPlanningTabs({
    id,
    basicForm,
    genreOptions,
    storyModeOptions,
    worldOptions: worldListQuery.data?.data ?? [],
    sourceNovelOptions,
    sourceKnowledgeOptions,
    sourceNovelBookAnalysisOptions,
    isLoadingSourceNovelBookAnalyses: sourceBookAnalysesQuery.isLoading,
    availableBookAnalysisSections: [...BOOK_ANALYSIS_SECTIONS],
    novelWorldView,
    novelWorldSyncDiff,
    worldSliceView,
    worldSliceMessage,
    isLoadingNovelWorld,
    isImportingNovelWorld,
    isGeneratingNovelWorld,
    isCreatingManualNovelWorld,
    isSavingNovelWorldToLibrary,
    isLoadingNovelWorldSyncDiff,
    isSyncingNovelWorld,
    isRefreshingWorldSlice,
    isSavingWorldSliceOverrides,
    onBasicFormChange: (patch) => setBasicForm((prev) => patchNovelBasicForm(prev, patch)),
    onSaveBasic: () => saveBasicMutation.mutate(),
    onImportNovelWorld: importNovelWorld,
    onCreateManualNovelWorld: createManualNovelWorld,
    onGenerateNovelWorld: generateNovelWorld,
    onSaveNovelWorldToLibrary: saveNovelWorldToLibrary,
    onSyncNovelWorld: syncNovelWorld,
    onRefreshWorldSlice: refreshWorldSlice,
    onSaveWorldSliceOverrides: saveWorldSliceOverrides,
    isSavingBasic: saveBasicMutation.isPending,
    projectQuickStart: undefined,
    basicDirectorTakeoverEntry: undefined,
    storyMacroDirectorTakeoverEntry: undefined,
    outlineDirectorTakeoverEntry: undefined,
    structuredDirectorTakeoverEntry: undefined,
    worldInjectionSummary,
    hasCharacters,
    hasUnsavedVolumeDraft,
    generationNotice,
    readiness,
    volumeCountGuidance,
    customVolumeCountEnabled,
    customVolumeCountInput,
    onCustomVolumeCountEnabledChange,
    onCustomVolumeCountInputChange,
    onApplyCustomVolumeCount,
    onRestoreSystemRecommendedVolumeCount,
    strategyPlan: volumeStrategyPlan,
    critiqueReport: volumeCritiqueReport,
    isGeneratingStrategy,
    onGenerateStrategy: startStrategyGeneration,
    isCritiquingStrategy,
    onCritiqueStrategy: startStrategyCritique,
    isGeneratingSkeleton,
    onGenerateSkeleton: startSkeletonGeneration,
    onGoToCharacterTab: goToCharacterTab,
    onGoToStructuredTab: goToStructuredTab,
    latestStateSnapshot,
    payoffLedger,
    characterResources,
    outlineText,
    structuredDraftText,
    volumes: normalizedVolumeDraft,
    onVolumeFieldChange: handleVolumeFieldChange,
    onOpenPayoffsChange: handleOpenPayoffsChange,
    onAddVolume: handleAddVolume,
    onRemoveVolume: handleRemoveVolume,
    onMoveVolume: handleMoveVolume,
    onSaveOutline: () => saveOutlineMutation.mutate(),
    isSavingOutline: saveOutlineMutation.isPending,
    volumeMessage: volumeGenerationMessage || volumeMessage,
    volumeVersions,
    selectedVersionId,
    onSelectedVersionChange: setSelectedVersionId,
    onCreateDraftVersion: () => createDraftVersionMutation.mutate(),
    isCreatingDraftVersion: createDraftVersionMutation.isPending,
    onLoadSelectedVersionToDraft: loadSelectedVersionToDraft,
    onActivateVersion: () => activateVersionMutation.mutate(),
    isActivatingVersion: activateVersionMutation.isPending,
    onFreezeVersion: () => freezeVersionMutation.mutate(),
    isFreezingVersion: freezeVersionMutation.isPending,
    onLoadVersionDiff: () => diffMutation.mutate(),
    isLoadingVersionDiff: diffMutation.isPending,
    diffResult,
    onAnalyzeDraftImpact: () => analyzeDraftImpactMutation.mutate(),
    isAnalyzingDraftImpact: analyzeDraftImpactMutation.isPending,
    onAnalyzeVersionImpact: () => analyzeVersionImpactMutation.mutate(),
    isAnalyzingVersionImpact: analyzeVersionImpactMutation.isPending,
    impactResult,
    beatSheets: volumeBeatSheets,
    rebalanceDecisions: volumeRebalanceDecisions,
    isGeneratingBeatSheet,
    onGenerateBeatSheet: startBeatSheetGeneration,
    isGeneratingChapterList,
    generatingChapterListVolumeId,
    generatingChapterListBeatKey,
    generatingChapterListMode,
    onGenerateChapterList: startChapterListGeneration,
    isGeneratingChapterDetail,
    isGeneratingChapterDetailBundle,
    generatingChapterDetailMode,
    generatingChapterDetailChapterId,
    onGenerateChapterDetail: startChapterDetailGeneration,
    onGenerateChapterDetailBundle: startChapterDetailBundleGeneration,
    syncPreview: volumeSyncPreview,
    syncOptions: volumeSyncOptions,
    onSyncOptionsChange: (patch) => setVolumeSyncOptions((prev) => ({ ...prev, ...patch })),
    onApplySync: (options) => syncStructuredChaptersMutation.mutate(options),
    isApplyingSync: syncStructuredChaptersMutation.isPending,
    syncMessage: structuredMessage,
    chapters: outlineSyncChapters,
    onChapterFieldChange: handleChapterFieldChange,
    onChapterNumberChange: handleChapterNumberChange,
    onChapterPayoffRefsChange: handleChapterPayoffRefsChange,
    onAddChapter: handleAddChapter,
    onRemoveChapter: handleRemoveChapter,
    onMoveChapter: handleMoveChapter,
    onApplyBatch: (patch) => {
      setVolumeDraft((prev) => applyVolumeChapterBatch(prev, patch));
    },
    onSaveStructured: () => saveStructuredMutation.mutate(),
    isSavingStructured: saveStructuredMutation.isPending,
  });
  const chapterTab = {
    novelId: id,
    worldInjectionSummary,
    hasCharacters,
    chapters,
    selectedChapterId,
    selectedChapter,
    onSelectChapter: setSelectedChapterId,
    onGoToCharacterTab: goToCharacterTab,
    onCreateChapter: () => createChapterMutation.mutate(),
    isCreatingChapter: createChapterMutation.isPending,
    chapterOperationMessage,
    strategy: chapterStrategy,
    onStrategyChange: (field: "runMode" | "wordSize" | "conflictLevel" | "pace" | "aiFreedom", value: string | number) =>
      setChapterStrategy((prev) => ({ ...prev, [field]: value } as ChapterExecutionStrategy)),
    onApplyStrategy: chapterExecutionActions.applyStrategy,
    isApplyingStrategy: chapterExecutionActions.isPatchingChapter,
    onGenerateSelectedChapter: handleGenerateSelectedChapter,
    onRewriteChapter: chapterExecutionActions.rewriteChapter,
    onExpandChapter: chapterExecutionActions.expandChapter,
    onCompressChapter: chapterExecutionActions.compressChapter,
    onSummarizeChapter: chapterExecutionActions.summarizeChapter,
    onGenerateTaskSheet: chapterExecutionActions.generateTaskSheet,
    onGenerateSceneCards: chapterExecutionActions.generateSceneCards,
    onGenerateChapterPlan: () => generateChapterPlanMutation.mutate(),
    onReplanChapter: () => replanChapterMutation.mutate(),
    onRunFullAudit: () => runChapterReview("full_audit"),
    onCheckContinuity: chapterExecutionActions.checkContinuity,
    onCheckCharacterConsistency: chapterExecutionActions.checkCharacterConsistency,
    onCheckPacing: chapterExecutionActions.checkPacing,
    onAutoRepair: chapterExecutionActions.autoRepair,
    onStrengthenConflict: chapterExecutionActions.strengthenConflict,
    onEnhanceEmotion: chapterExecutionActions.enhanceEmotion,
    onUnifyStyle: chapterExecutionActions.unifyStyle,
    onAddDialogue: chapterExecutionActions.addDialogue,
    onAddDescription: chapterExecutionActions.addDescription,
    isGeneratingTaskSheet: chapterExecutionActions.isGeneratingTaskSheet,
    isGeneratingSceneCards: chapterExecutionActions.isGeneratingSceneCards,
    isSummarizingChapter: chapterExecutionActions.isSummarizingChapter,
    reviewActionKind,
    repairActionKind: chapterExecutionActions.repairActionKind,
    generationActionKind: chapterExecutionActions.generationActionKind,
    isReviewingChapter: fullAuditMutation.isPending,
    isRepairingChapter: repairSSE.isStreaming,
    reviewResult,
    replanRecommendation: reviewResult?.replanRecommendation ?? null,
    lastReplanResult: replanChapterMutation.data?.data ?? null,
    chapterPlan,
    latestStateSnapshot,
    chapterStateSnapshot,
    chapterTimeline,
    isLoadingChapterTimeline: chapterTimelineQuery.isLoading || chapterTimelineQuery.isFetching,
    chapterResourceContext,
    isLoadingChapterResourceContext: chapterResourceContextQuery.isLoading || chapterResourceContextQuery.isFetching,
    resourceWorkflowMode: activeDirectorSession ? ("auto_director" as const) : ("manual" as const),
    pendingCharacterResourceProposals: chapterPendingCharacterResourceProposals,
    onExtractChapterResources: () => extractChapterResourcesMutation.mutate(),
    isExtractingChapterResources: extractChapterResourcesMutation.isPending,
    onConfirmCharacterResourceProposal: (proposalId: string) => confirmCharacterResourceProposalMutation.mutate(proposalId),
    onRejectCharacterResourceProposal: (proposalId: string) => rejectCharacterResourceProposalMutation.mutate(proposalId),
    confirmingCharacterResourceProposalId: confirmCharacterResourceProposalMutation.isPending
      ? confirmCharacterResourceProposalMutation.variables ?? ""
      : "",
    rejectingCharacterResourceProposalId: rejectCharacterResourceProposalMutation.isPending
      ? rejectCharacterResourceProposalMutation.variables ?? ""
      : "",
    chapterAuditReports,
    backgroundSyncActivities: pipelineBackgroundActivities,
    isGeneratingChapterPlan: generateChapterPlanMutation.isPending,
    isReplanningChapter: replanChapterMutation.isPending,
    isRunningFullAudit: fullAuditMutation.isPending && reviewActionKind === "full_audit",
    chapterQualityReport,
    chapterRuntimePackage: chapterSSE.runtimePackage,
    repairStreamContent: repairSSE.content,
    isRepairStreaming: repairSSE.isStreaming,
    repairStreamingChapterId: activeRepairStream?.chapterId ?? null,
    repairStreamingChapterLabel: activeRepairStream?.chapterLabel ?? null,
    repairRunStatus: repairSSE.latestRun,
    onAbortRepair: handleAbortRepair,
    streamContent: chapterSSE.content,
    isStreaming: chapterSSE.isStreaming,
    streamingChapterId: activeChapterStream?.chapterId ?? null,
    streamingChapterLabel: activeChapterStream?.chapterLabel ?? null,
    chapterRunStatus: chapterSSE.latestRun,
    onAbortStream: handleAbortChapterStream,
    directorTakeoverEntry: undefined,
  };
  const pipelineTab = { novelId: id, worldInjectionSummary, hasCharacters, onGoToCharacterTab: goToCharacterTab, pipelineForm, onPipelineFormChange: (field: "startOrder" | "endOrder" | "maxRetries" | "runMode" | "autoReview" | "autoRepair" | "skipCompleted" | "qualityThreshold" | "repairMode", value: number | boolean | string) => setPipelineForm((prev) => ({ ...prev, [field]: value } as typeof prev)), maxOrder, onGenerateBible: () => void bibleSSE.start(`/novels/${id}/bible/generate`, { provider: llm.provider, model: llm.model, temperature: 0.6 }), onAbortBible: bibleSSE.abort, isBibleStreaming: bibleSSE.isStreaming, bibleStreamContent: bibleSSE.content, onGenerateBeats: () => void beatsSSE.start(`/novels/${id}/beats/generate`, { provider: llm.provider, model: llm.model, targetChapters: pipelineForm.endOrder }), onAbortBeats: beatsSSE.abort, isBeatsStreaming: beatsSSE.isStreaming, beatsStreamContent: beatsSSE.content, onRunPipeline: (patch?: Partial<typeof pipelineForm>) => runPipelineMutation.mutate(patch), isRunningPipeline: runPipelineMutation.isPending, pipelineMessage, pipelineJob: pipelineJobQuery.data?.data, chapters, selectedChapterId, onSelectedChapterChange: setSelectedChapterId, onReviewChapter: () => reviewMutation.mutate(), isReviewing: reviewMutation.isPending, onRepairChapter: () => { setRepairBeforeContent(selectedChapter?.content ?? ""); setRepairAfterContent(""); setActiveRepairStream(selectedChapter ? { chapterId: selectedChapter.id, chapterLabel: `第${selectedChapter.order}章 ${selectedChapter.title || "未命名章节"}` } : null); void repairSSE.start(`/novels/${id}/chapters/${selectedChapterId}/repair`, { provider: llm.provider, model: llm.model, reviewIssues: reviewResult?.issues ?? [], auditIssueIds: openAuditIssueIds }); }, isRepairing: repairSSE.isStreaming, onGenerateHook: () => hookMutation.mutate(), isGeneratingHook: hookMutation.isPending, reviewResult, repairBeforeContent, repairAfterContent, repairStreamContent: repairSSE.content, isRepairStreaming: repairSSE.isStreaming, onAbortRepair: handleAbortRepair, qualitySummary, chapterReports: qualityReportQuery.data?.data?.chapterReports ?? [], qualityDebtBoard: qualityDebtQuery.data?.data ?? null, qualityDebtBoardStatus: qualityDebtQuery.data?.data ? "ready" : qualityDebtQuery.isError ? "error" : (qualityDebtQuery.isLoading || qualityDebtQuery.isPending) ? "loading" : "idle", qualityDebtBoardError: qualityDebtQuery.error instanceof Error ? qualityDebtQuery.error.message : qualityDebtQuery.isError ? "请求失败" : null, bible, plotBeats };
  const characterTab = {
    novelId: id,
    llmProvider: llm.provider,
    llmModel: llm.model,
    characterMessage,
    quickCharacterForm,
    onQuickCharacterFormChange: (field: "name" | "role", value: string) =>
      setQuickCharacterForm((prev) => ({ ...prev, [field]: value })),
    onQuickCreateCharacter: (payload: QuickCharacterCreatePayload) => quickCreateCharacterMutation.mutate(payload),
    isQuickCreating: quickCreateCharacterMutation.isPending,
    onGenerateSupplementalCharacters: generateSupplementalCharacterMutation.mutateAsync,
    isGeneratingSupplementalCharacters: generateSupplementalCharacterMutation.isPending,
    onApplySupplementalCharacter: applySupplementalCharacterMutation.mutateAsync,
    isApplyingSupplementalCharacter: applySupplementalCharacterMutation.isPending,
    characters,
    coreCharacterCount,
    baseCharacters,
    selectedBaseCharacterId,
    onSelectedBaseCharacterChange: setSelectedBaseCharacterId,
    selectedBaseCharacter,
    importedBaseCharacterIds,
    onImportBaseCharacter: () => importBaseCharacterMutation.mutate(),
    isImportingBaseCharacter: importBaseCharacterMutation.isPending,
    selectedCharacterId,
    onSelectedCharacterChange: setSelectedCharacterId,
    onDeleteCharacter: (characterId: string) => deleteCharacterMutation.mutate(characterId),
    isDeletingCharacter: deleteCharacterMutation.isPending,
    deletingCharacterId: deleteCharacterMutation.variables ?? "",
    onSyncTimeline: () => syncTimelineMutation.mutate(),
    isSyncingTimeline: syncTimelineMutation.isPending,
    onSyncAllTimeline: () => syncAllTimelineMutation.mutate(),
    isSyncingAllTimeline: syncAllTimelineMutation.isPending,
    onEvolveCharacter: () => evolveCharacterMutation.mutate(),
    isEvolvingCharacter: evolveCharacterMutation.isPending,
    onGenerateVisibleProfile: (userGuidance?: string) => generateVisibleProfileMutation.mutate(userGuidance),
    isGeneratingVisibleProfile: generateVisibleProfileMutation.isPending,
    visibleProfileSuggestion: generateVisibleProfileMutation.data?.data ?? null,
    onApplyVisibleProfile: () => applyVisibleProfileMutation.mutate(),
    isApplyingVisibleProfile: applyVisibleProfileMutation.isPending,
    onGenerateBatchVisibleProfiles: (userGuidance?: string) => generateBatchVisibleProfilesMutation.mutate(userGuidance),
    isGeneratingBatchVisibleProfiles: generateBatchVisibleProfilesMutation.isPending,
    batchVisibleProfileResult: generateBatchVisibleProfilesMutation.data?.data ?? null,
    onApplyBatchVisibleProfiles: () => applyBatchVisibleProfilesMutation.mutate(),
    isApplyingBatchVisibleProfiles: applyBatchVisibleProfilesMutation.isPending,
    onWorldCheck: () => worldCheckMutation.mutate(),
    isCheckingWorld: worldCheckMutation.isPending,
    selectedCharacter,
    characterResources,
    pendingCharacterResourceCount: pendingCharacterResourceProposals.length,
    onBackfillCharacterResources: () => backfillCharacterResourcesMutation.mutate(),
    isBackfillingCharacterResources: backfillCharacterResourcesMutation.isPending,
    characterForm,
    onCharacterFormChange: (field: keyof typeof characterForm, value: string) =>
      setCharacterForm((prev) => ({ ...prev, [field]: value })),
    onSaveCharacter: () => saveCharacterMutation.mutate(),
    isSavingCharacter: saveCharacterMutation.isPending,
    timelineEvents: characterTimelineQuery.data?.data ?? [],
  };

  const activeStepTakeoverEntry = renderTakeoverEntry(
    activeTab === "story_macro"
      ? "story_macro"
      : activeTab === "character"
        ? "character"
        : activeTab === "outline"
          ? "outline"
          : activeTab === "structured"
            ? "structured"
            : activeTab === "chapter"
              ? "chapter"
              : activeTab === "pipeline"
                ? "pipeline"
                : "basic",
  );
  const exportVariables = exportNovelMutation.variables;
  const isExportingCurrentMarkdown = exportNovelMutation.isPending
    && exportVariables?.scope === currentExportScope
    && exportVariables?.format === "markdown";
  const isExportingCurrentJson = exportNovelMutation.isPending
    && exportVariables?.scope === currentExportScope
    && exportVariables?.format === "json";
  const isExportingCurrentTxt = exportNovelMutation.isPending
    && exportVariables?.scope === currentExportScope
    && exportVariables?.format === "txt";
  const isExportingFullMarkdown = exportNovelMutation.isPending
    && exportVariables?.scope === "full"
    && exportVariables?.format === "markdown";
  const isExportingFullJson = exportNovelMutation.isPending
    && exportVariables?.scope === "full"
    && exportVariables?.format === "json";
  const isExportingFullTxt = exportNovelMutation.isPending
    && exportVariables?.scope === "full"
    && exportVariables?.format === "txt";

  return {
    id,
    activeTab,
    workflowCurrentTab,
    onActiveTabChange: setActiveTab,
    exportControls: {
        canExportCurrentStep: Boolean(currentExportScope),
        isExportingCurrentTxt,
        isExportingCurrentMarkdown,
        isExportingCurrentJson,
        isExportingFullTxt,
        isExportingFullMarkdown,
        isExportingFullJson,
        onExportCurrent: (format) => {
          if (!currentExportScope) {
            return;
          }
          exportNovelMutation.mutate({
            format,
            scope: currentExportScope,
            novelTitle: exportNovelTitle,
          });
        },
        onExportFull: (format) => {
          exportNovelMutation.mutate({
            format,
            scope: "full",
            novelTitle: exportNovelTitle,
          });
        },
      },
    basicTab,
    storyMacroTab,
    outlineTab,
    structuredTab,
    chapterTab,
    pipelineTab,
    characterTab,
    takeover: isTakeoverDismissed ? null : takeover,
    activeStepTakeoverEntry,
    taskDrawer: {
        open: isTaskDrawerOpen,
        onOpenChange: (open) => {
          setIsTaskDrawerOpen(open);
          if (!open && taskPanelOpen) {
            clearTaskPanelOpen();
          }
        },
        task: displayAutoDirectorTask,
        snapshot: activeDirectorSnapshot,
        runtimeSnapshot: activeDirectorRuntimeSnapshot,
        projection: displayAutoDirectorTask?.status === "cancelled" ? null : bookAutomationProjection,
        currentUiModel: {
          provider: llm.provider,
          model: llm.model,
          temperature: llm.temperature,
        },
        actions: taskDrawerActions,
        onProjectionAction: handleTaskDrawerProjectionAction,
        followUp: activeAutoDirectorFollowUp,
        onFollowUpAction: handleDrawerFollowUpAction,
        executingFollowUpAction: executeFollowUpActionMutation.isPending,
        runtimeHardBlocked: activeDirectorRuntimeHardBlocked,
        runtimeBlockedReason: activeDirectorRuntimeBlockedReason,
        overrideModel: retryOverride,
        onOverrideModelChange: setRetryOverride,
        onRetryWithOverrideModel: () => retryAutoDirectorWithCurrentModelMutation.mutate(),
        retryWithOverrideModelPending: retryAutoDirectorWithCurrentModelMutation.isPending,
        canRetryWithOverrideModel: Boolean(retryOverride.provider && retryOverride.model.trim()),
        onRetryWithTaskModel: () => retryAutoDirectorWithTaskModelMutation.mutate(),
        retryWithTaskModelPending: retryAutoDirectorWithTaskModelMutation.isPending,
        capabilities: {
          availableActions: taskDrawerActions.length > 0,
          availableFollowUps: Boolean(activeAutoDirectorFollowUp),
          canAdjustRuntimePolicy: Boolean(activeDirectorRuntimeSnapshot && displayAutoDirectorTask),
          canInspectManualEditImpact: Boolean(displayAutoDirectorTask),
          canRetryWithOverrideModel: Boolean(displayAutoDirectorTask && (displayAutoDirectorTask.status === "failed" || displayAutoDirectorTask.status === "cancelled")),
          canCancel: Boolean(displayAutoDirectorTask && canCancelDirectorTask(displayAutoDirectorTask)),
          canArchive: Boolean(displayAutoDirectorTask && (displayAutoDirectorTask.status === "succeeded" || displayAutoDirectorTask.status === "failed" || displayAutoDirectorTask.status === "cancelled")),
        },
        resourceProposals: pendingCharacterResourceProposals,
        onOpenResourceProposalSource: (proposal) => {
          if (proposal.chapterId) {
            setSelectedChapterId(proposal.chapterId);
            setActiveTab("chapter");
          } else {
            setActiveTab("character");
          }
          setIsTaskDrawerOpen(false);
        },
        onConfirmResourceProposal: (proposalId) => confirmCharacterResourceProposalMutation.mutate(proposalId),
        onRejectResourceProposal: (proposalId) => rejectCharacterResourceProposalMutation.mutate(proposalId),
        confirmingResourceProposalId: confirmCharacterResourceProposalMutation.isPending
          ? confirmCharacterResourceProposalMutation.variables ?? ""
          : "",
        rejectingResourceProposalId: rejectCharacterResourceProposalMutation.isPending
          ? rejectCharacterResourceProposalMutation.variables ?? ""
          : "",
        onOpenFullTaskCenter: openAutoDirectorTaskCenter,
      },
  };
}
