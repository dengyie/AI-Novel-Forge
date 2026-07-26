import { useMemo } from "react";
import type { DirectorDashboardMode } from "@ai-novel/shared/types/directorRuntime";
import { toast } from "@/components/ui/toast";
import { useNovelWorkspaceQueries } from "./useNovelWorkspaceQueries";
import type { NovelEditTakeoverState, NovelTaskDrawerState } from "../../components/NovelEditView.types";
import { tabFromScope } from "../../novelWorkspaceNavigation";
import { canCancelDirectorTask } from "@/lib/novelWorkflowTaskUi";
import { buildContinueAutoExecutionActionLabel, buildTakeoverDescription, buildTakeoverTitle, formatTakeoverCheckpoint, resolveAutoExecutionScopeLabel } from "../../novelEditTakeover.shared";
import { canArchiveCompletedAutoDirectorTask, resolveAutomationActionText, resolveTakeoverModeFromAutomation } from "../../novelEditAutomationStatus";
import { useNovelDirectorTaskController } from "./useNovelDirectorTaskController";
import { useNovelDirectorTaskActions } from "../../automation/directorTaskActions";

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

export function useNovelTaskDrawerController(
  workspace: ReturnType<typeof useNovelWorkspaceQueries>,
  director: ReturnType<typeof useNovelDirectorTaskController>,
  directorActions: ReturnType<typeof useNovelDirectorTaskActions>,
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
  const takeover = useMemo<NovelEditTakeoverState | null>(() => {
    const task = displayAutoDirectorTask;
    if (!task) {
      return null;
    }
    const consistencyIssue = resolveDirectorConsistencyIssue({
      checkpointType: task.checkpointType,
      characterCount: characters.length,
      chapterCount: chapters.length,
    });
    const dashboardView = activeDirectorSnapshot?.dashboardView ?? null;
    const mode = mapDashboardModeToTakeoverMode(dashboardView?.mode)
      ?? resolveTakeoverModeFromAutomation({
      task,
      projection: bookAutomationProjection,
    });
    const automationActionText = resolveAutomationActionText({
      task,
      projection: bookAutomationProjection,
    });
    const novelTitle = novelDetailQuery.data?.data?.title?.trim() || task.title?.trim() || "当前项目";
    const reviewScope = activeDirectorSession?.reviewScope ?? null;
    const autoExecutionScopeLabel = resolveAutoExecutionScopeLabel(task);
    const actions: NonNullable<NovelEditTakeoverState["actions"]> = [];
    if (activeChapterTitleWarning) {
      actions.push({
        label: chapterTitleRepairMutation.isPending && chapterTitleRepairMutation.pendingTaskId === task.id
          ? "AI 修复中..."
          : activeChapterTitleWarning.label,
        onClick: () => {
          if (hasUnsavedVolumeDraft) {
            toast.error("当前拆章工作区还有未保存修改，请先保存工作区，再发起 AI 修复标题。");
            return;
          }
          chapterTitleRepairMutation.startRepair(task);
        },
        variant: mode === "failed" ? "default" : "outline",
        disabled: chapterTitleRepairMutation.isPending,
      });
    }
    const reviewTab = tabFromScope(reviewScope);
    if (
      mode === "waiting"
      && task.checkpointType === "candidate_selection_required"
    ) {
      actions.push({
        label: "去确认书级方向",
        onClick: () => openCandidateSelection(task.id),
        variant: "default",
      });
    } else if (
      (mode === "waiting" || mode === "action_required")
      && reviewTab
      && reviewTab !== activeTab
      && task.checkpointType !== "chapter_batch_ready"
    ) {
      actions.push({
        label: "去当前审核阶段",
        onClick: () => setActiveTab(reviewTab),
        variant: "outline",
      });
    }
    if (task.pendingManualRecovery) {
      actions.push({
        label: continueAutoDirectorMutation.isPending ? "继续中..." : "继续自动导演",
        onClick: () => continueAutoDirectorMutation.mutate({ directorTaskId: task.id }),
        variant: "default",
        disabled: continueAutoDirectorMutation.isPending,
      });
    } else if (mode === "waiting" && task.checkpointType === "chapter_batch_ready") {
      actions.push({
        label: buildContinueAutoExecutionActionLabel(autoExecutionScopeLabel, continueAutoExecutionMutation.isPending),
        onClick: () => continueAutoExecutionMutation.mutate({ directorTaskId: task.id }),
        variant: "default",
        disabled: continueAutoExecutionMutation.isPending,
      });
      actions.push({
        label: "进入章节执行",
        onClick: () => {
          if (task.resumeTarget?.chapterId) {
            setSelectedChapterId(task.resumeTarget.chapterId);
          }
          setActiveTab("chapter");
        },
        variant: "outline",
      });
    } else if (mode === "waiting" && task.checkpointType === "workflow_completed") {
      actions.push({
        label: "进入章节执行",
        onClick: () => openChapterExecution(task),
        variant: "default",
      });
    } else if (mode === "action_required" && task.checkpointType === "replan_required") {
      // 质量债主路径：先打开修复；禁止策略化 skip_quality_repair
      actions.push({
        label: "打开质量修复",
        onClick: () => openQualityRepair(task),
        variant: "default",
      });
      actions.push({
        label: continueAutoDirectorMutation.isPending ? "继续中..." : "继续自动导演",
        onClick: () => continueAutoDirectorMutation.mutate({ directorTaskId: task.id }),
        variant: "outline",
        disabled: continueAutoDirectorMutation.isPending,
      });
    } else if (mode === "waiting") {
      actions.push({
        label: continueAutoDirectorMutation.isPending ? "继续中..." : "继续自动导演",
        onClick: () => continueAutoDirectorMutation.mutate({ directorTaskId: task.id }),
        variant: "default",
        disabled: continueAutoDirectorMutation.isPending,
      });
    }
    if (mode === "failed" && task.checkpointType === "chapter_batch_ready") {
      actions.push({
        label: buildContinueAutoExecutionActionLabel(autoExecutionScopeLabel, continueAutoExecutionMutation.isPending),
        onClick: () => continueAutoExecutionMutation.mutate({ directorTaskId: task.id }),
        variant: "default",
        disabled: continueAutoExecutionMutation.isPending,
      });
      actions.push({
        label: "打开质量修复",
        onClick: () => openQualityRepair(task),
        variant: "outline",
      });
    }
    if (consistencyIssue) {
      actions.push({
        label: continueAutoDirectorMutation.isPending ? "修复中..." : "补齐导演产物",
        onClick: () => continueAutoDirectorMutation.mutate({ directorTaskId: task.id }),
        variant: "default",
        disabled: continueAutoDirectorMutation.isPending,
      });
      if (consistencyIssue === "missing_characters") {
        actions.push({
          label: "去角色准备",
          onClick: () => setActiveTab("character"),
          variant: "outline",
        });
      }
    } else if (task.checkpointType === "chapter_batch_ready" && mode !== "waiting") {
      actions.push({
        label: "进入章节执行",
        onClick: () => {
          if (task.resumeTarget?.chapterId) {
            setSelectedChapterId(task.resumeTarget.chapterId);
          }
          setActiveTab("chapter");
        },
        variant: mode === "running" ? "outline" : "default",
      });
    }
    const canCancelTask = canCancelDirectorTask(task);
    if (canCancelTask) {
      if (task.status === "failed") {
        actions.push({
          label: cancelAutoDirectorMutation.isPending ? "取消中..." : "取消任务",
          onClick: () => cancelAutoDirectorMutation.mutate(task.id),
          variant: "destructive",
          disabled: cancelAutoDirectorMutation.isPending,
        });
      } else if (isDirectorExitActionExpanded) {
        actions.push({
          label: "继续导演",
          onClick: () => setIsDirectorExitActionExpanded(false),
          variant: "outline",
          disabled: cancelAutoDirectorMutation.isPending,
        });
        actions.push({
          label: cancelAutoDirectorMutation.isPending ? "退出中..." : "退出导演模式",
          onClick: () => cancelAutoDirectorMutation.mutate(task.id),
          variant: "destructive",
          disabled: cancelAutoDirectorMutation.isPending,
        });
      } else {
        actions.push({
          label: "退出导演模式",
          onClick: () => setIsDirectorExitActionExpanded(true),
          variant: "destructive",
          disabled: cancelAutoDirectorMutation.isPending,
        });
      }
    } else if (
      task.status === "failed"
      || task.status === "cancelled"
    ) {
      actions.push({
        label: "收起此提醒",
        onClick: dismissTakeover,
        variant: "secondary",
      });
    } else if (canArchiveCompletedAutoDirectorTask(task)) {
      actions.push({
        label: archiveCompletedAutoDirectorMutation.isPending ? "收起中..." : "完成并收起",
        onClick: () => archiveCompletedAutoDirectorMutation.mutate(task.id),
        variant: "secondary",
        disabled: archiveCompletedAutoDirectorMutation.isPending,
      });
    } else if (task.status === "waiting_approval") {
      actions.push({
        label: "收起此提醒",
        onClick: dismissTakeover,
        variant: "secondary",
      });
    }
    actions.push({
      label: "执行详情",
      onClick: () => setIsTaskDrawerOpen(true),
      variant: mode === "running" ? "outline" : "secondary",
    });

    return {
      mode,
      title: consistencyIssue === "missing_characters"
        ? `《${novelTitle}》导演产物未补齐角色准备`
        : consistencyIssue === "missing_chapters"
          ? `《${novelTitle}》导演产物未连接到章节执行区`
          : task.pendingManualRecovery
            ? `《${novelTitle}》等待从检查点恢复`
          : buildTakeoverTitle({
            mode,
            novelTitle,
            checkpointType: task.checkpointType,
            scopeLabel: autoExecutionScopeLabel,
          }),
      description: consistencyIssue === "missing_characters"
        ? "任务记录显示已完成开书交接，但当前项目里还没有角色资产，所以角色准备和章节执行都不完整。可以直接补齐导演产物，系统会继续修复。"
        : consistencyIssue === "missing_chapters"
          ? "任务记录显示前几章已经可开写，但当前章节执行区还是空的，说明导演产物还没有完整落库。可以直接补齐导演产物继续修复。"
          : task.pendingManualRecovery
            ? "任务已停在当前进度。你可以查看执行详情，再从最近进度点继续。"
          : buildTakeoverDescription({
            mode,
            checkpointType: task.checkpointType,
            reviewScope,
            scopeLabel: autoExecutionScopeLabel,
          }),
      progress: typeof dashboardView?.progressPercent === "number"
        ? dashboardView.progressPercent
        : task.progress,
      currentAction: consistencyIssue === "missing_characters"
        ? "检测到角色准备仍为空，当前导演结果需要继续补齐。"
        : consistencyIssue === "missing_chapters"
          ? "检测到章节执行区为空，当前导演结果需要继续同步章节资源。"
          : task.pendingManualRecovery
            ? (
              task.blockingReason?.trim()
              || task.recoveryHint?.trim()
              || task.lastError?.trim()
              || "任务已暂停，等待从最近检查点恢复。"
            )
          : dashboardView?.currentAction?.trim()
            ? dashboardView.currentAction.trim()
          : activeDirectorSnapshot?.displayState.currentAction?.trim()
            ? activeDirectorSnapshot.displayState.currentAction.trim()
          : automationActionText
            ? automationActionText
          : mode === "running" && task.checkpointType === "chapter_batch_ready" && task.currentItemLabel?.includes("已暂停")
            ? `正在继续自动执行${autoExecutionScopeLabel}`
            : task.currentItemLabel ?? null,
      checkpointLabel: consistencyIssue
        ? "导演产物待补齐"
        : task.pendingManualRecovery
          ? "等待恢复"
        : mode === "running" && task.checkpointType === "chapter_batch_ready"
          ? `${autoExecutionScopeLabel}自动执行中`
          : formatTakeoverCheckpoint(task.checkpointType, task),
      taskId: task.id,
      actions,
    };
  }, [
    activeAutoDirectorTask,
    activeChapterTitleWarning,
    activeDirectorSnapshot?.dashboardView,
    activeDirectorSnapshot?.displayState.currentAction,
    activeDirectorSession,
    activeTab,
    archiveCompletedAutoDirectorMutation,
    bookAutomationProjection,
    chapters.length,
    chapterTitleRepairMutation,
    characters.length,
    cancelAutoDirectorMutation,
    continueAutoDirectorMutation,
    continueAutoExecutionMutation,
    dismissTakeover,
    hasUnsavedVolumeDraft,
    isDirectorExitActionExpanded,
    novelDetailQuery.data?.data?.title,
    openCandidateSelection,
    openQualityRepair,
    displayAutoDirectorTask,
    setActiveTab,
    setSelectedChapterId,
  ]);
  const taskDrawerActions = useMemo<NovelTaskDrawerState["actions"]>(() => {
    const task = displayAutoDirectorTask;
    if (!task) {
      return [];
    }
    const actions: NovelTaskDrawerState["actions"] = [];
    if (activeChapterTitleWarning) {
      actions.push({
        label: chapterTitleRepairMutation.isPending && chapterTitleRepairMutation.pendingTaskId === task.id
          ? "AI 修复中..."
          : activeChapterTitleWarning.label,
        onClick: () => {
          if (hasUnsavedVolumeDraft) {
            toast.error("当前拆章工作区还有未保存修改，请先保存工作区，再发起 AI 修复标题。");
            return;
          }
          chapterTitleRepairMutation.startRepair(task);
        },
        variant: "default",
        disabled: chapterTitleRepairMutation.isPending,
      });
    }
    if (consistencyIssue) {
      actions.push({
        label: continueAutoDirectorMutation.isPending ? "补齐中..." : "补齐导演产物",
        onClick: () => continueAutoDirectorMutation.mutate({ directorTaskId: task.id }),
        variant: "default",
        disabled: continueAutoDirectorMutation.isPending,
      });
      if (consistencyIssue === "missing_characters") {
        actions.push({
          label: "去角色准备",
          onClick: () => {
            setActiveTab("character");
            setIsTaskDrawerOpen(false);
          },
          variant: "outline",
        });
      }
    } else if (task.pendingManualRecovery) {
      actions.push({
        label: continueAutoDirectorMutation.isPending ? "继续中..." : "继续自动导演",
        onClick: () => continueAutoDirectorMutation.mutate({ directorTaskId: task.id }),
        variant: "default",
        disabled: continueAutoDirectorMutation.isPending,
      });
    } else if (
      task.status === "waiting_approval"
      && task.checkpointType === "chapter_batch_ready"
    ) {
      const autoExecutionScopeLabel = resolveAutoExecutionScopeLabel(task);
      actions.push({
        label: buildContinueAutoExecutionActionLabel(autoExecutionScopeLabel, continueAutoExecutionMutation.isPending),
        onClick: () => continueAutoExecutionMutation.mutate({ directorTaskId: task.id }),
        variant: "default",
        disabled: continueAutoExecutionMutation.isPending,
      });
      actions.push({
        label: "进入章节执行",
        onClick: () => openChapterExecution(task),
        variant: "outline",
      });
    } else if (task.status === "waiting_approval" && task.checkpointType === "candidate_selection_required") {
      actions.push({
        label: "去确认书级方向",
        onClick: () => openCandidateSelection(task.id),
        variant: "default",
      });
    } else if (task.status === "waiting_approval" && task.checkpointType === "replan_required") {
      // 质量债主路径：先打开修复；禁止策略化 skip_quality_repair
      actions.push({
        label: "打开质量修复",
        onClick: () => openQualityRepair(task),
        variant: "default",
      });
      actions.push({
        label: continueAutoDirectorMutation.isPending ? "继续中..." : "继续自动导演",
        onClick: () => continueAutoDirectorMutation.mutate({ directorTaskId: task.id }),
        variant: "outline",
        disabled: continueAutoDirectorMutation.isPending,
      });
    } else if (
      task.status === "waiting_approval"
      && reviewTab
      && task.checkpointType !== "chapter_batch_ready"
    ) {
      actions.push({
        label: "去当前审核阶段",
        onClick: openReviewStage,
        variant: "default",
      });
      actions.push({
        label: continueAutoDirectorMutation.isPending ? "继续中..." : "继续自动导演",
        onClick: () => continueAutoDirectorMutation.mutate({ directorTaskId: task.id }),
        variant: "outline",
        disabled: continueAutoDirectorMutation.isPending,
      });
    } else if ((task.status === "failed" || task.status === "cancelled") && task.checkpointType === "chapter_batch_ready") {
      const autoExecutionScopeLabel = resolveAutoExecutionScopeLabel(task);
      actions.push({
        label: buildContinueAutoExecutionActionLabel(autoExecutionScopeLabel, continueAutoExecutionMutation.isPending),
        onClick: () => continueAutoExecutionMutation.mutate({ directorTaskId: task.id }),
        variant: "default",
        disabled: continueAutoExecutionMutation.isPending,
      });
      actions.push({
        label: "打开质量修复",
        onClick: () => openQualityRepair(task),
        variant: "outline",
      });
    } else if (task.checkpointType === "chapter_batch_ready" || task.checkpointType === "workflow_completed") {
      actions.push({
        label: "进入章节执行",
        onClick: () => openChapterExecution(task),
        variant: "default",
      });
    }

    if (canCancelDirectorTask(task)) {
      actions.push({
        label: cancelAutoDirectorMutation.isPending ? "取消中..." : "取消任务",
        onClick: () => cancelAutoDirectorMutation.mutate(task.id),
        variant: "destructive",
        disabled: cancelAutoDirectorMutation.isPending,
      });
    }
    return actions;
  }, [
    activeChapterTitleWarning,
    cancelAutoDirectorMutation,
    chapterTitleRepairMutation,
    consistencyIssue,
    continueAutoDirectorMutation,
    continueAutoExecutionMutation,
    displayAutoDirectorTask,
    hasUnsavedVolumeDraft,
    openCandidateSelection,
    openReviewStage,
    openChapterExecution,
    openQualityRepair,
    reviewTab,
    setActiveTab,
  ]);

  return {
    takeover, taskDrawerActions,
  };
}
