import { useMemo, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { DirectorDashboardMode } from "@ai-novel/shared/types/directorRuntime";
import type { NovelExportDownloadFormat, NovelExportScope } from "@ai-novel/shared/types/novelExport";
import type { PipelineRepairMode, PipelineRunMode, VolumeBeatSheet, VolumeCritiqueReport, VolumePlan, VolumeRebalanceDecision, VolumeStrategyPlan } from "@ai-novel/shared/types/novel";
import type { LLMSelectorValue } from "@/components/common/LLMSelector";
import { getBaseCharacterList } from "@/api/character";
import { flattenGenreTreeOptions, getGenreTree } from "@/api/genre";
import { getDirectorBookAutomationProjection } from "@/api/novelDirector";
import { getActiveAutoDirectorTask } from "@/api/novelWorkflow";
import { getChapterTimeline, getChapterResourceContext, getChapterAuditReports, getChapterPlan, getChapterStateSnapshot, getLatestStateSnapshot, getNovelCharacterResources, getNovelPayoffLedger, getNovelDetail, downloadNovelExport, getNovelPipelineJob, getNovelVolumeWorkspace, getNovelQualityReport, getNovelQualityDebt } from "@/api/novel";
import { flattenStoryModeTreeOptions, getStoryModeTree } from "@/api/storyMode";
import { getWorldList } from "@/api/world";
import { queryKeys } from "@/api/queryKeys";
import { toast } from "@/components/ui/toast";
import { useLLMStore } from "@/store/llmStore";
import { buildWorldInjectionSummary } from "../../novelEdit.utils";
import type { ChapterExecutionBackgroundActivity } from "../../components/chapterExecution.shared";
import type { ChapterExecutionStrategy } from "../../chapterExecution.utils";
import { useNovelContinuationSources } from "../useNovelContinuationSources";
import { useNovelWorldSlice } from "../useNovelWorldSlice";
import { useNovelStoryMacro } from "../useNovelStoryMacro";
import { useNovelVolumePlanning } from "../useNovelVolumePlanning";
import { useNovelEditWorkflow } from "../useNovelEditWorkflow";
import type { ChapterReviewResult } from "../../chapterPlanning.shared";
import type { NovelEditTakeoverState } from "../../components/NovelEditView.types";
import { isNovelWorkspaceFlowTab } from "../../novelWorkspaceNavigation";

function mapDashboardModeToTakeoverMode(mode: DirectorDashboardMode | null | undefined): NovelEditTakeoverState["mode"] | null {
  switch (mode) {
    case "running":
    case "queued":
    case "completed":
      return "running";
    case "waiting_user":
      return "waiting";
    case "recovering":
      return "action_required";
    case "failed":
      return "failed";
    case "idle":
      return "loading";
    default:
      return null;
  }
}

function parsePipelineBackgroundActivities(payload: string | null | undefined): ChapterExecutionBackgroundActivity[] {
  if (!payload?.trim()) {
    return [];
  }
  try {
    const parsed = JSON.parse(payload) as {
      backgroundSync?: {
        activities?: Array<{
          kind?: unknown;
          status?: unknown;
          chapterId?: unknown;
          chapterOrder?: unknown;
          chapterTitle?: unknown;
          updatedAt?: unknown;
          error?: unknown;
        }>;
      };
    };
    return (parsed.backgroundSync?.activities ?? [])
      .flatMap((item) => {
        if (!item || typeof item !== "object") {
          return [];
        }
        const kind = item.kind;
        const status = item.status;
        if (
          (kind !== "character_dynamics" && kind !== "state_snapshot" && kind !== "payoff_ledger" && kind !== "character_resources")
          || (status !== "running" && status !== "failed")
          || typeof item.chapterId !== "string"
          || !item.chapterId.trim()
          || typeof item.updatedAt !== "string"
          || !item.updatedAt.trim()
        ) {
          return [];
        }
        const activity: ChapterExecutionBackgroundActivity = {
          kind,
          status,
          chapterId: item.chapterId.trim(),
          chapterOrder: typeof item.chapterOrder === "number" ? item.chapterOrder : undefined,
          chapterTitle: typeof item.chapterTitle === "string" && item.chapterTitle.trim() ? item.chapterTitle.trim() : undefined,
          updatedAt: item.updatedAt.trim(),
          error: typeof item.error === "string" && item.error.trim() ? item.error.trim() : null,
        };
        return [activity];
      })
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
  } catch {
    return [];
  }
}

function createDownload(blob: Blob, fileName: string): void {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = fileName;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(url);
}
import { DEFAULT_ESTIMATED_CHAPTER_COUNT, createDefaultNovelBasicFormState } from "../../novelBasicInfo.shared";
import { buildVolumeSyncPreview, type ExistingOutlineChapter, type VolumeSyncOptions } from "../../volumePlan.utils";

export function useNovelWorkspaceQueries() {
  const { id = "" } = useParams();
  const navigate = useNavigate();
  const llm = useLLMStore();
  const queryClient = useQueryClient();
  const {
    activeTab,
    setActiveTab,
    directorTaskId,
    setDirectorTaskId,
    selectedChapterId,
    setSelectedChapterId,
    selectedVolumeId,
    setSelectedVolumeId,
    workflowTaskId,
    taskPanelOpen,
    clearTaskPanelOpen,
  } = useNovelEditWorkflow(id);
  const [isTaskDrawerOpen, setIsTaskDrawerOpen] = useState(false);
  const [autoOpenedFailedTaskId, setAutoOpenedFailedTaskId] = useState("");
  const [retryOverride, setRetryOverride] = useState<LLMSelectorValue>({
    provider: llm.provider,
    model: llm.model,
    temperature: llm.temperature,
  });
  const [basicForm, setBasicForm] = useState(() => createDefaultNovelBasicFormState());
  const [volumeDraft, setVolumeDraft] = useState<VolumePlan[]>([]);
  const [volumeStrategyPlan, setVolumeStrategyPlan] = useState<VolumeStrategyPlan | null>(null);
  const [volumeCritiqueReport, setVolumeCritiqueReport] = useState<VolumeCritiqueReport | null>(null);
  const [volumeBeatSheets, setVolumeBeatSheets] = useState<VolumeBeatSheet[]>([]);
  const [volumeRebalanceDecisions, setVolumeRebalanceDecisions] = useState<VolumeRebalanceDecision[]>([]);
  const [volumeGenerationMessage, setVolumeGenerationMessage] = useState("");
  const [outlineOptimizeInstruction, setOutlineOptimizeInstruction] = useState("");
  const [outlineOptimizePreview, setOutlineOptimizePreview] = useState("");
  const [outlineOptimizeMode, setOutlineOptimizeMode] = useState<"full" | "selection">("full");
  const [outlineOptimizeSourceText, setOutlineOptimizeSourceText] = useState("");
  const [structuredOptimizeInstruction, setStructuredOptimizeInstruction] = useState("");
  const [structuredOptimizePreview, setStructuredOptimizePreview] = useState("");
  const [structuredOptimizeMode, setStructuredOptimizeMode] = useState<"full" | "selection">("full");
  const [structuredOptimizeSourceText, setStructuredOptimizeSourceText] = useState("");
  const [volumeSyncOptions, setVolumeSyncOptions] = useState<VolumeSyncOptions>({
    preserveContent: true,
    applyDeletes: false,
  });
  const [currentJobId, setCurrentJobId] = useState("");
  const [pipelineForm, setPipelineForm] = useState({
    startOrder: 1,
    endOrder: DEFAULT_ESTIMATED_CHAPTER_COUNT,
    maxRetries: 1,
    runMode: "fast" as PipelineRunMode,
    autoReview: true,
    autoRepair: true,
    skipCompleted: true,
    qualityThreshold: 75,
    repairMode: "light_repair" as PipelineRepairMode,
  });
  const [reviewResult, setReviewResult] = useState<ChapterReviewResult | null>(null);
  const [pipelineMessage, setPipelineMessage] = useState("");
  const [structuredMessage, setStructuredMessage] = useState("");
  const [chapterOperationMessage, setChapterOperationMessage] = useState("");
  const [chapterStrategy, setChapterStrategy] = useState<ChapterExecutionStrategy>({ runMode: "fast", wordSize: "medium", conflictLevel: 60, pace: "balanced", aiFreedom: "medium" });
  const [activeChapterStream, setActiveChapterStream] = useState<{ chapterId: string; chapterLabel: string } | null>(null);
  const [activeRepairStream, setActiveRepairStream] = useState<{ chapterId: string; chapterLabel: string } | null>(null);
  const [isDirectorExitActionExpanded, setIsDirectorExitActionExpanded] = useState(false);
  const [dismissedTakeoverSignature, setDismissedTakeoverSignature] = useState("");
  const [characterMessage, setCharacterMessage] = useState("");
  const [repairBeforeContent, setRepairBeforeContent] = useState("");
  const [repairAfterContent, setRepairAfterContent] = useState("");
  const [selectedCharacterId, setSelectedCharacterId] = useState("");
  const [selectedBaseCharacterId, setSelectedBaseCharacterId] = useState("");
  const [quickCharacterForm, setQuickCharacterForm] = useState({
    name: "",
    role: "主角",
  });
  const [characterForm, setCharacterForm] = useState({
    name: "",
    role: "",
    gender: "unknown" as "male" | "female" | "other" | "unknown",
    personality: "",
    background: "",
    development: "",
    appearance: "",
    physique: "",
    attireStyle: "",
    signatureDetail: "",
    voiceTexture: "",
    ttsMode: "preset" as "preset" | "design" | "clone" | "",
    ttsVoice: "",
    ttsStyle: "",
    ttsDesignPrompt: "",
    ttsRefAudioPath: "",
    ttsRefAudioBase64: "",
    ttsVoiceAssetId: "",
    ttsSpeakerAliases: "",
    presenceImpression: "",
    currentState: "",
    currentGoal: "",
  });
  const shouldLoadVolumeWorkspace = activeTab === "outline" || activeTab === "structured";
  const shouldLoadStoryMacro = activeTab === "story_macro";
  const shouldLoadWorldSlice = activeTab === "basic";
  const shouldLoadQualityReport = activeTab === "pipeline";
  const shouldLoadLatestState = activeTab === "chapter" || activeTab === "pipeline";
  const shouldLoadPayoffLedger = activeTab === "structured" || activeTab === "chapter" || activeTab === "pipeline";
  const shouldLoadCharacterResources = activeTab === "character" || activeTab === "chapter" || activeTab === "pipeline";
  const shouldLoadChapterContext = activeTab === "chapter" && Boolean(selectedChapterId);
  const shouldLoadChapterTimeline = activeTab === "chapter" && Boolean(selectedChapterId);

  const novelDetailQuery = useQuery({
    queryKey: queryKeys.novels.detail(id),
    queryFn: () => getNovelDetail(id),
    enabled: Boolean(id),
  });
  const qualityReportQuery = useQuery({
    queryKey: queryKeys.novels.qualityReport(id),
    queryFn: () => getNovelQualityReport(id),
    enabled: Boolean(id && shouldLoadQualityReport),
  });
  const qualityDebtQuery = useQuery({
    queryKey: queryKeys.novels.qualityDebt(id),
    queryFn: () => getNovelQualityDebt(id),
    enabled: Boolean(id && shouldLoadQualityReport),
  });
  const volumeWorkspaceQuery = useQuery({
    queryKey: queryKeys.novels.volumeWorkspace(id),
    queryFn: () => getNovelVolumeWorkspace(id),
    enabled: Boolean(id && shouldLoadVolumeWorkspace),
  });
  const latestStateSnapshotQuery = useQuery({
    queryKey: queryKeys.novels.latestStateSnapshot(id),
    queryFn: () => getLatestStateSnapshot(id),
    enabled: Boolean(id && shouldLoadLatestState),
  });
  const chapterStateSnapshotQuery = useQuery({
    queryKey: queryKeys.novels.chapterStateSnapshot(id, selectedChapterId || "none"),
    queryFn: () => getChapterStateSnapshot(id, selectedChapterId),
    enabled: Boolean(id && selectedChapterId),
  });
  const payoffLedgerChapterOrder = useMemo(() => {
    const orders = novelDetailQuery.data?.data?.chapters?.map((chapter) => chapter.order) ?? [];
    return orders.length > 0 ? Math.max(...orders) : undefined;
  }, [novelDetailQuery.data?.data?.chapters]);
  const payoffLedgerQuery = useQuery({
    queryKey: queryKeys.novels.payoffLedger(id, payoffLedgerChapterOrder),
    queryFn: () => getNovelPayoffLedger(id, payoffLedgerChapterOrder),
    enabled: Boolean(id && shouldLoadPayoffLedger),
  });
  const characterResourcesQuery = useQuery({
    queryKey: queryKeys.novels.characterResources(id),
    queryFn: () => getNovelCharacterResources(id),
    enabled: Boolean(id && shouldLoadCharacterResources),
  });
  const chapterResourceContextQuery = useQuery({
    queryKey: queryKeys.novels.characterResourceContext(id, selectedChapterId || "none"),
    queryFn: () => getChapterResourceContext(id, selectedChapterId),
    enabled: Boolean(id && shouldLoadChapterContext),
  });
  const chapterTimelineQuery = useQuery({
    queryKey: queryKeys.novels.chapterTimeline(id, selectedChapterId || "none"),
    queryFn: () => getChapterTimeline(id, selectedChapterId),
    enabled: Boolean(id && shouldLoadChapterTimeline),
  });
  const activeAutoDirectorTaskQuery = useQuery({
    queryKey: queryKeys.novels.autoDirectorTask(id),
    queryFn: () => getActiveAutoDirectorTask(id),
    enabled: Boolean(id),
    refetchInterval: (query) => {
      const task = query.state.data?.data;
      return task && (task.status === "queued" || task.status === "running" || task.status === "waiting_approval")
        ? 4000
        : false;
    },
  });
  const bookAutomationQuery = useQuery({
    queryKey: queryKeys.novels.directorBookAutomation(id),
    queryFn: () => getDirectorBookAutomationProjection(id),
    enabled: Boolean(id),
    retry: false,
    refetchInterval: (query) => {
      const status = query.state.data?.data?.projection.status;
      return status === "queued" || status === "running" || status === "waiting_approval" ? 4000 : false;
    },
  });
  const chapterPlanQuery = useQuery({
    queryKey: queryKeys.novels.chapterPlan(id, selectedChapterId || "none"),
    queryFn: () => getChapterPlan(id, selectedChapterId),
    enabled: Boolean(id && shouldLoadChapterContext),
  });
  const chapterAuditReportsQuery = useQuery({
    queryKey: queryKeys.novels.chapterAuditReports(id, selectedChapterId || "none"),
    queryFn: () => getChapterAuditReports(id, selectedChapterId),
    enabled: Boolean(id && shouldLoadChapterContext),
  });
  const baseCharacterListQuery = useQuery({
    queryKey: queryKeys.baseCharacters.all,
    queryFn: () => getBaseCharacterList(),
  });
  const worldListQuery = useQuery({
    queryKey: queryKeys.worlds.all,
    queryFn: getWorldList,
  });
  const genreTreeQuery = useQuery({
    queryKey: queryKeys.genres.all,
    queryFn: getGenreTree,
  });
  const storyModeTreeQuery = useQuery({
    queryKey: queryKeys.storyModes.all,
    queryFn: getStoryModeTree,
  });
  const genreOptions = useMemo(() => flattenGenreTreeOptions(genreTreeQuery.data?.data ?? []), [genreTreeQuery.data?.data]);
  const storyModeOptions = useMemo(
    () => flattenStoryModeTreeOptions(storyModeTreeQuery.data?.data ?? []),
    [storyModeTreeQuery.data?.data],
  );

  const {
    sourceBookAnalysesQuery,
    sourceNovelOptions,
    sourceKnowledgeOptions,
    sourceNovelBookAnalysisOptions,
  } = useNovelContinuationSources(id, {
    writingMode: basicForm.writingMode,
    continuationSourceType: basicForm.continuationSourceType,
    sourceNovelId: basicForm.sourceNovelId,
    sourceKnowledgeDocumentId: basicForm.sourceKnowledgeDocumentId,
  });

  const { tab: storyMacroTab } = useNovelStoryMacro({
    novelId: id,
    enabled: shouldLoadStoryMacro,
    llm,
  });
  const {
    worldSliceMessage,
    novelWorldView,
    novelWorldSyncDiff,
    worldSliceView,
    isLoadingNovelWorld,
    isImportingNovelWorld,
    isGeneratingNovelWorld,
    isCreatingManualNovelWorld,
    isSavingNovelWorldToLibrary,
    isLoadingNovelWorldSyncDiff,
    isSyncingNovelWorld,
    isRefreshingWorldSlice,
    isSavingWorldSliceOverrides,
    importNovelWorld,
    createManualNovelWorld,
    generateNovelWorld,
    saveNovelWorldToLibrary,
    syncNovelWorld,
    refreshWorldSlice,
    saveWorldSliceOverrides,
  } = useNovelWorldSlice({
    novelId: id,
    enabled: shouldLoadWorldSlice,
    llm,
    queryClient,
    onNovelWorldImported: (worldId) => setBasicForm((prev) => ({ ...prev, worldId })),
  });
  const pipelineJobQuery = useQuery({
    queryKey: queryKeys.novels.pipelineJob(id, currentJobId || "none"),
    queryFn: () => getNovelPipelineJob(id, currentJobId),
    enabled: Boolean(id && currentJobId),
    refetchInterval: (query) => {
      const status = query.state.data?.data?.status;
      if (status === "queued" || status === "running") {
        return 1500;
      }
      return false;
    },
  });
  const exportNovelMutation = useMutation({
    mutationFn: async (input: {
      format: NovelExportDownloadFormat;
      scope: NovelExportScope;
      novelTitle: string;
    }) => {
      const exported = await downloadNovelExport(id, input.format, input.scope, input.novelTitle);
      return {
        ...exported,
        scope: input.scope,
        format: input.format,
      };
    },
    onSuccess: ({ blob, fileName, scope }) => {
      createDownload(blob, fileName);
      toast.success(scope === "full" ? "整本书导出已开始。" : "当前步骤导出已开始。");
    },
    onError: (error) => {
      toast.error(error instanceof Error ? error.message : "导出失败。");
    },
  });

  const chapters = useMemo(() => novelDetailQuery.data?.data?.chapters ?? [], [novelDetailQuery.data?.data?.chapters]);
  const outlineSyncChapters = useMemo<ExistingOutlineChapter[]>(
    () => chapters.map((chapter) => ({
      id: chapter.id,
      order: chapter.order,
      title: chapter.title,
      content: chapter.content ?? "",
      expectation: chapter.expectation ?? "",
      targetWordCount: chapter.targetWordCount ?? null,
      conflictLevel: chapter.conflictLevel ?? null,
      revealLevel: chapter.revealLevel ?? null,
      mustAvoid: chapter.mustAvoid ?? null,
      taskSheet: chapter.taskSheet ?? null,
    })),
    [chapters],
  );
  const selectedChapter = useMemo(
    () => chapters.find((item) => item.id === selectedChapterId),
    [chapters, selectedChapterId],
  );
  const characters = novelDetailQuery.data?.data?.characters ?? [];
  const baseCharacters = baseCharacterListQuery.data?.data ?? [];
  const selectedCharacter = useMemo(
    () => characters.find((item) => item.id === selectedCharacterId),
    [characters, selectedCharacterId],
  );
  const selectedBaseCharacter = useMemo(
    () => baseCharacters.find((item) => item.id === selectedBaseCharacterId),
    [baseCharacters, selectedBaseCharacterId],
  );
  const exportNovelTitle = useMemo(
    () => basicForm.title.trim() || novelDetailQuery.data?.data?.title?.trim() || id,
    [basicForm.title, novelDetailQuery.data?.data?.title, id],
  );
  const currentExportScope = isNovelWorkspaceFlowTab(activeTab) ? activeTab : null;
  const importedBaseCharacterIds = useMemo(
    () => new Set(
      characters
        .map((item) => item.baseCharacterId)
        .filter((item): item is string => Boolean(item)),
    ),
    [characters],
  );
  const hasCharacters = characters.length > 0;
  const savedVolumeWorkspace = volumeWorkspaceQuery.data?.data ?? null;
  const {
    normalizedVolumeDraft,
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
    isGeneratingStrategy,
    isCritiquingStrategy,
    isGeneratingSkeleton,
    isGeneratingBeatSheet,
    isGeneratingChapterList,
    generatingChapterListVolumeId,
    generatingChapterListBeatKey,
    generatingChapterListMode,
    isGeneratingChapterDetail,
    isGeneratingChapterDetailBundle,
    generatingChapterDetailMode,
    generatingChapterDetailChapterId,
    startStrategyGeneration,
    startStrategyCritique,
    startSkeletonGeneration,
    startBeatSheetGeneration,
    startChapterListGeneration,
    startChapterDetailGeneration,
    startChapterDetailBundleGeneration,
    handleVolumeFieldChange,
    handleOpenPayoffsChange,
    handleAddVolume,
    handleRemoveVolume,
    handleMoveVolume,
    handleChapterFieldChange,
    handleChapterNumberChange,
    handleChapterPayoffRefsChange,
    handleAddChapter,
    handleRemoveChapter,
    handleMoveChapter,
  } = useNovelVolumePlanning({
    novelId: id,
    hasCharacters,
    llm,
    estimatedChapterCount: basicForm.estimatedChapterCount,
    volumeDraft,
    strategyPlan: volumeStrategyPlan,
    critiqueReport: volumeCritiqueReport,
    beatSheets: volumeBeatSheets,
    rebalanceDecisions: volumeRebalanceDecisions,
    savedWorkspace: savedVolumeWorkspace,
    setVolumeDraft,
    setStrategyPlan: setVolumeStrategyPlan,
    setCritiqueReport: setVolumeCritiqueReport,
    setBeatSheets: setVolumeBeatSheets,
    setRebalanceDecisions: setVolumeRebalanceDecisions,
    setVolumeGenerationMessage,
    setStructuredMessage,
  });
  const volumeSyncPreview = useMemo(
    () => buildVolumeSyncPreview(normalizedVolumeDraft, outlineSyncChapters, volumeSyncOptions),
    [normalizedVolumeDraft, outlineSyncChapters, volumeSyncOptions],
  );
  const coreCharacterCount = useMemo(
    () => characters.filter((item) => /主角|反派/.test(item.role)).length,
    [characters],
  );
  const bible = novelDetailQuery.data?.data?.bible;
  const plotBeats = novelDetailQuery.data?.data?.plotBeats ?? [];
  const maxOrder = useMemo(
    () => chapters.reduce((max, chapter) => Math.max(max, chapter.order), 1),
    [chapters],
  );
  const worldInjectionSummary = useMemo(
    () => buildWorldInjectionSummary(novelDetailQuery.data?.data?.world),
    [novelDetailQuery.data?.data?.world],
  );
  const qualitySummary = qualityReportQuery.data?.data?.summary;
  const chapterQualityReport = useMemo(() => (qualityReportQuery.data?.data?.chapterReports ?? []).find((item) => item.chapterId === selectedChapterId), [qualityReportQuery.data?.data?.chapterReports, selectedChapterId]);
  const chapterPlan = chapterPlanQuery.data?.data ?? null;
  const chapterTimeline = chapterTimelineQuery.data?.data ?? null;
  const latestStateSnapshot = latestStateSnapshotQuery.data?.data ?? null;
  const chapterStateSnapshot = chapterStateSnapshotQuery.data?.data ?? null;
  const payoffLedger = payoffLedgerQuery.data?.data ?? null;
  const characterResources = characterResourcesQuery.data?.data?.items ?? [];
  const pendingCharacterResourceProposals = characterResourcesQuery.data?.data?.pendingProposals ?? [];
  const chapterResourceContext = chapterResourceContextQuery.data?.data ?? null;
  const chapterAuditReports = chapterAuditReportsQuery.data?.data ?? [];
  const pipelineBackgroundActivities = useMemo(
    () => parsePipelineBackgroundActivities(pipelineJobQuery.data?.data?.payload ?? null),
    [pipelineJobQuery.data?.data?.payload],
  );
  const hasValidatedActiveAutoDirectorTask = activeAutoDirectorTaskQuery.isFetchedAfterMount;
  const latestAutoDirectorTask = hasValidatedActiveAutoDirectorTask
    ? activeAutoDirectorTaskQuery.data?.data ?? null
    : null;

  return {
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
  };
}
