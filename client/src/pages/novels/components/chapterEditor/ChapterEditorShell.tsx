import { useEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import type {
  ChapterEditorDiagnosticCard,
  ChapterEditorOperation,
  ChapterEditorRecommendedTask,
  ChapterEditorRevisionScope,
  ChapterEditorTargetRange,
} from "@ai-novel/shared/types/novel";
import { createNovelSnapshot, previewChapterAiRevision, updateNovelChapter } from "@/api/novel";
import { queryKeys } from "@/api/queryKeys";
import { toast } from "@/components/ui/toast";
import { useLLMStore } from "@/store/llmStore";
import ChapterEditorDirectorPanel from "./ChapterEditorDirectorPanel";
import ChapterEditorSidebar from "./ChapterEditorSidebar";
import ChapterTextEditor from "./ChapterTextEditor";
import SelectionAIFloatingToolbar from "./SelectionAIFloatingToolbar";
import type {
  ChapterEditorSelectionRange,
  ChapterEditorSessionState,
  ChapterEditorShellProps,
  SelectionToolbarPosition,
} from "./chapterEditorTypes";
import {
  CHAPTER_EDITOR_OPERATION_LABELS,
  applyCandidateToContent,
  buildAiRevisionRequest,
  countEditorWords,
  getSaveStatusLabel,
  isChapterContentConflictError,
  normalizeChapterContent,
  resolveChapterContentSync,
} from "./chapterEditorUtils";

const EMPTY_SESSION: ChapterEditorSessionState = {
  sessionId: "",
  scope: "selection",
  targetRange: {
    from: 0,
    to: 0,
    text: "",
  },
  candidates: [],
  activeCandidateId: null,
  status: "idle",
  viewMode: "block",
};

function toSelectionFromRange(
  content: string,
  range?: Pick<ChapterEditorTargetRange, "from" | "to"> | null,
): ChapterEditorSelectionRange | null {
  if (!range) {
    return null;
  }
  if (range.from < 0 || range.to <= range.from || range.to > content.length) {
    return null;
  }
  const text = content.slice(range.from, range.to);
  if (!text.trim()) {
    return null;
  }
  return {
    from: range.from,
    to: range.to,
    text,
  };
}

export default function ChapterEditorShell(props: ChapterEditorShellProps) {
  const {
    novelId,
    chapter,
    workspace,
    workspaceStatus,
    onBack,
    onOpenVersionHistory,
  } = props;
  const llm = useLLMStore();
  const queryClient = useQueryClient();
  const lastPreviewRequestRef = useRef<ReturnType<typeof buildAiRevisionRequest> | null>(null);
  const normalizedChapterContent = useMemo(() => normalizeChapterContent(chapter?.content ?? ""), [chapter?.content]);
  const chapterIdRef = useRef(chapter?.id);
  const contentDraftRef = useRef(normalizedChapterContent);
  const savedContentRef = useRef(normalizedChapterContent);
  /** CAS 冲突后下一次服务端回流必须保留本地 draft */
  const preserveLocalDraftOnSyncRef = useRef(false);

  const [contentDraft, setContentDraft] = useState(normalizedChapterContent);
  const [savedContent, setSavedContent] = useState(normalizedChapterContent);
  const [saveStatus, setSaveStatus] = useState<"idle" | "saving" | "saved" | "error">("idle");
  const [selection, setSelection] = useState<ChapterEditorSelectionRange | null>(null);
  const [selectionToolbarPosition, setSelectionToolbarPosition] = useState<SelectionToolbarPosition | null>(null);
  const [session, setSession] = useState<ChapterEditorSessionState>(EMPTY_SESSION);
  const [revisionScope, setRevisionScope] = useState<ChapterEditorRevisionScope>("selection");
  const [revisionInstruction, setRevisionInstruction] = useState("");
  const [selectedDiagnosticId, setSelectedDiagnosticId] = useState<string | null>(null);

  useEffect(() => {
    contentDraftRef.current = contentDraft;
  }, [contentDraft]);

  useEffect(() => {
    savedContentRef.current = savedContent;
  }, [savedContent]);

  useEffect(() => {
    const nextContent = normalizedChapterContent;
    const chapterChanged = chapterIdRef.current !== chapter?.id;
    const decision = resolveChapterContentSync({
      chapterChanged,
      nextServerContent: nextContent,
      currentDraft: contentDraftRef.current,
      currentSaved: savedContentRef.current,
      preserveLocalDraft: preserveLocalDraftOnSyncRef.current,
    });
    chapterIdRef.current = chapter?.id;
    preserveLocalDraftOnSyncRef.current = false;

    if (decision.action === "keep_local_draft") {
      // 仅对齐 saved 基线到服务器，保留本地未保存正文，避免 CAS 冲突后丢稿
      setSavedContent(decision.serverContent);
      savedContentRef.current = decision.serverContent;
      setSaveStatus("error");
      return;
    }

    setContentDraft(decision.content);
    setSavedContent(decision.content);
    contentDraftRef.current = decision.content;
    savedContentRef.current = decision.content;
    setSaveStatus("idle");
    setSelection(null);
    setSelectionToolbarPosition(null);
    setSession(EMPTY_SESSION);
    setRevisionInstruction("");
    setRevisionScope("selection");
    lastPreviewRequestRef.current = null;
  }, [chapter?.id, normalizedChapterContent]);

  useEffect(() => {
    if (!workspace) {
      setSelectedDiagnosticId(null);
      return;
    }
    if (selectedDiagnosticId && !workspace.diagnosticCards.some((card) => card.id === selectedDiagnosticId)) {
      setSelectedDiagnosticId(null);
    }
  }, [selectedDiagnosticId, workspace]);

  const isDirty = contentDraft !== savedContent;
  const wordCount = useMemo(() => countEditorWords(contentDraft), [contentDraft]);
  const activeCandidate = useMemo(
    () => session.candidates?.find((candidate) => candidate.id === session.activeCandidateId) ?? null,
    [session.activeCandidateId, session.candidates],
  );
  const selectedDiagnosticCard = useMemo(
    () => workspace?.diagnosticCards.find((card) => card.id === selectedDiagnosticId) ?? null,
    [selectedDiagnosticId, workspace],
  );
  const selectedDiagnosticSelection = useMemo(
    () => toSelectionFromRange(contentDraft, selectedDiagnosticCard?.anchorRange ?? null),
    [contentDraft, selectedDiagnosticCard?.anchorRange],
  );
  const recommendedTaskSelection = useMemo(
    () => toSelectionFromRange(contentDraft, workspace?.recommendedTask?.anchorRange ?? null),
    [contentDraft, workspace?.recommendedTask?.anchorRange],
  );

  const invalidateChapterQueries = async () => {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: queryKeys.novels.detail(novelId) }),
      queryClient.invalidateQueries({ queryKey: queryKeys.novels.chapterEditorWorkspace(novelId, chapter?.id ?? "none") }),
      queryClient.invalidateQueries({ queryKey: queryKeys.novels.snapshots(novelId) }),
      chapter?.id
        ? queryClient.invalidateQueries({ queryKey: queryKeys.novels.chapterPlan(novelId, chapter.id) })
        : Promise.resolve(),
      chapter?.id
        ? queryClient.invalidateQueries({ queryKey: queryKeys.novels.chapterAuditReports(novelId, chapter.id) })
        : Promise.resolve(),
      queryClient.invalidateQueries({ queryKey: queryKeys.novels.latestStateSnapshot(novelId) }),
    ]);
  };

  const saveMutation = useMutation({
    mutationFn: async (nextContent: string) => {
      if (!chapter) {
        throw new Error("当前未选中章节。");
      }
      return updateNovelChapter(
        novelId,
        chapter.id,
        {
          content: nextContent,
          expectedContentRevision: chapter.contentRevision ?? 0,
        },
        { silentErrorStatuses: [409] },
      );
    },
    onMutate: () => {
      setSaveStatus("saving");
    },
    onSuccess: async (_response, nextContent) => {
      setSavedContent(nextContent);
      setSaveStatus("saved");
      await invalidateChapterQueries();
      toast.success("章节正文已保存。");
    },
    onError: async (error) => {
      setSaveStatus("error");
      if (isChapterContentConflictError(error)) {
        // 保留本地 draft：invalidate 回流时只更新 saved 基线
        preserveLocalDraftOnSyncRef.current = true;
        await invalidateChapterQueries();
        toast.error("正文已被其他来源更新。本地修改已保留，请对照后重试保存。");
        return;
      }
      toast.error(error instanceof Error ? error.message : "章节保存失败。");
    },
  });

  const previewMutation = useMutation({
    mutationFn: async (request: ReturnType<typeof buildAiRevisionRequest>) => {
      if (!chapter) {
        throw new Error("当前未选中章节。");
      }
      return previewChapterAiRevision(novelId, chapter.id, request);
    },
    onMutate: (request) => {
      lastPreviewRequestRef.current = request;
      const label = request.source === "freeform"
        ? (request.scope === "chapter" ? "正在生成整章自然语言修正方案" : "正在按你的意见改写片段")
        : request.presetOperation
          ? `正在生成${CHAPTER_EDITOR_OPERATION_LABELS[request.presetOperation]}方案`
          : "正在生成修正方案";
      setSession((current) => ({
        ...current,
        status: "loading",
        requestLabel: label,
        customInstruction: request.instruction,
        scope: request.scope,
        targetRange: request.selection ?? {
          from: 0,
          to: contentDraft.length,
          text: contentDraft,
        },
        candidates: [],
        activeCandidateId: null,
        errorMessage: undefined,
      }));
    },
    onSuccess: (response) => {
      const data = response.data;
      if (!data) {
        setSession((current) => ({
          ...current,
          status: "error",
          errorMessage: "AI 未返回改写结果，请重试。",
        }));
        return;
      }
      setSession((current) => ({
        ...data,
        status: "ready",
        viewMode: "block",
        requestLabel: current.requestLabel,
        errorMessage: undefined,
      }));
      setSelection(null);
      setSelectionToolbarPosition(null);
    },
    onError: (error) => {
      setSession((current) => ({
        ...current,
        status: "error",
        errorMessage: error instanceof Error ? error.message : "AI 修正失败，请重试。",
      }));
    },
  });

  const acceptMutation = useMutation({
    mutationFn: async () => {
      if (!chapter || !activeCandidate || !session.targetRange) {
        throw new Error("当前没有可应用的候选版本。");
      }
      const label = `chapter-editor:${chapter.order}:${session.scope}:${Date.now()}`;
      const nextContent = applyCandidateToContent(contentDraft, session.targetRange, activeCandidate.content);
      // 先 CAS 写正文，成功后再建快照，避免 409 留下无对应正文变更的 orphan snapshot
      try {
        await updateNovelChapter(
          novelId,
          chapter.id,
          {
            content: nextContent,
            expectedContentRevision: chapter.contentRevision ?? 0,
          },
          { silentErrorStatuses: [409] },
        );
      } catch (error) {
        // 冲突时把候选合并结果挂到 error 上，onError 写入 draft，避免丢候选
        if (isChapterContentConflictError(error)) {
          (error as Error & { localCandidateContent?: string }).localCandidateContent = nextContent;
        }
        throw error;
      }
      try {
        await createNovelSnapshot(novelId, {
          triggerType: "manual",
          label: `${label}:post-accept`,
        });
      } catch (snapshotError) {
        console.warn("[chapter-editor] snapshot after accept failed", snapshotError);
      }
      return nextContent;
    },
    onSuccess: async (nextContent) => {
      setContentDraft(nextContent);
      setSavedContent(nextContent);
      contentDraftRef.current = nextContent;
      savedContentRef.current = nextContent;
      setSaveStatus("saved");
      setSession(EMPTY_SESSION);
      setRevisionInstruction("");
      await invalidateChapterQueries();
      toast.success("已应用候选版本（冲突安全写入后已创建快照）。");
    },
    onError: async (error) => {
      if (isChapterContentConflictError(error)) {
        const localCandidate = (error as Error & { localCandidateContent?: string }).localCandidateContent;
        if (typeof localCandidate === "string") {
          setContentDraft(localCandidate);
          contentDraftRef.current = localCandidate;
        }
        preserveLocalDraftOnSyncRef.current = true;
        await invalidateChapterQueries();
        toast.error("正文已被其他来源更新。本地候选合并结果已保留在编辑器中，请对照后重试保存。");
        return;
      }
      toast.error(error instanceof Error ? error.message : "应用候选版本失败。");
    },
  });

  const previewPayload = session.status === "loading" && session.targetRange?.text
    ? {
      mode: "loading" as const,
      from: session.targetRange.from,
      to: session.targetRange.to,
      originalText: session.targetRange.text,
    }
    : session.status === "ready" && activeCandidate && session.targetRange
      ? {
        mode: session.viewMode,
        from: session.targetRange.from,
        to: session.targetRange.to,
        diffChunks: activeCandidate.diffChunks,
        originalText: session.targetRange.text,
        candidateText: activeCandidate.content,
      }
      : null;

  if (!chapter) {
    return (
      <div className="rounded-3xl border border-dashed border-border/70 bg-muted/10 p-10 text-center text-sm text-muted-foreground">
        请选择一个章节后开始编辑正文。
      </div>
    );
  }

  const getSelectionTarget = (
    overrideSelection?: ChapterEditorSelectionRange | null,
    task?: ChapterEditorRecommendedTask | null,
  ) => overrideSelection
    ?? selection
    ?? selectedDiagnosticSelection
    ?? toSelectionFromRange(contentDraft, task?.anchorRange ?? null)
    ?? recommendedTaskSelection
    ?? null;

  const runRevision = (
    source: "preset" | "freeform",
    scope: ChapterEditorRevisionScope,
    options?: {
      presetOperation?: ChapterEditorOperation;
      instruction?: string;
      selectionOverride?: ChapterEditorSelectionRange | null;
      task?: ChapterEditorRecommendedTask | null;
    },
  ) => {
    const resolvedSelection = scope === "selection"
      ? getSelectionTarget(options?.selectionOverride, options?.task)
      : null;

    if (scope === "selection" && !resolvedSelection) {
      toast.error("请先选中正文片段，或先从问题卡定位到对应片段。");
      return;
    }

    const request = buildAiRevisionRequest({
      source,
      scope,
      presetOperation: options?.presetOperation,
      instruction: options?.instruction,
      selection: resolvedSelection,
      content: contentDraft,
      provider: llm.provider,
      model: llm.model,
      temperature: llm.temperature,
    });
    previewMutation.mutate(request);
  };

  const handleRunOperation = (operation: ChapterEditorOperation, customInstruction?: string) => {
    runRevision(
      operation === "custom" ? "freeform" : "preset",
      "selection",
      {
        presetOperation: operation === "custom" ? undefined : operation,
        instruction: customInstruction,
        selectionOverride: selection,
      },
    );
  };

  const handleRegenerate = () => {
    if (!lastPreviewRequestRef.current) {
      return;
    }
    previewMutation.mutate(lastPreviewRequestRef.current);
  };

  const handleReject = () => {
    setSession(EMPTY_SESSION);
  };

  const handleFocusDiagnostic = (card: ChapterEditorDiagnosticCard) => {
    if (selectedDiagnosticId === card.id) {
      setSelectedDiagnosticId(null);
      return;
    }
    setSelectedDiagnosticId(card.id);
    setSelection(null);
    setSelectionToolbarPosition(null);
  };

  const handleRunDiagnostic = (card: ChapterEditorDiagnosticCard) => {
    setSelectedDiagnosticId(card.id);
    runRevision("preset", card.recommendedScope, {
      presetOperation: card.recommendedAction,
      selectionOverride: toSelectionFromRange(contentDraft, card.anchorRange ?? null),
    });
  };

  const handleRunRecommended = () => {
    if (!workspace?.recommendedTask) {
      return;
    }
    runRevision("preset", workspace.recommendedTask.recommendedScope, {
      presetOperation: workspace.recommendedTask.recommendedAction,
      task: workspace.recommendedTask,
    });
  };

  const handleRunSelectedDiagnostic = () => {
    if (!selectedDiagnosticCard) {
      return;
    }
    handleRunDiagnostic(selectedDiagnosticCard);
  };

  const handleRunFreeform = () => {
    runRevision("freeform", revisionScope, {
      instruction: revisionInstruction.trim(),
    });
  };

  const currentTargetDescription = revisionScope === "chapter"
    ? "整章正文"
    : selection
      ? "你手动选中的正文片段"
      : selectedDiagnosticCard?.paragraphLabel
        ? `${selectedDiagnosticCard.paragraphLabel} 对应片段`
        : workspace?.recommendedTask?.paragraphLabel
          ? `${workspace.recommendedTask.paragraphLabel} 对应片段`
          : "尚未选中片段";
  const canRunSelectionRevision = Boolean(getSelectionTarget());
  const headerSaveLabel = getSaveStatusLabel(saveStatus, isDirty);
  const gridClassName = "xl:grid-cols-[320px_minmax(0,1fr)_400px]";

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-4">
      <div className={`grid min-h-0 flex-1 gap-4 overflow-hidden ${gridClassName}`}>
        <ChapterEditorSidebar
          chapter={chapter}
          workspace={workspace}
          workspaceStatus={workspaceStatus}
          wordCount={wordCount}
          saveStatusLabel={headerSaveLabel}
          isDirty={isDirty}
          isSaving={saveMutation.isPending}
          selectedDiagnosticId={selectedDiagnosticId}
          onBack={onBack}
          onOpenVersionHistory={onOpenVersionHistory}
          onSave={() => saveMutation.mutate(contentDraft)}
          onFocusDiagnostic={handleFocusDiagnostic}
          onRunDiagnostic={handleRunDiagnostic}
        />

        <div className="relative min-h-0 overflow-hidden">
          <ChapterTextEditor
            value={contentDraft}
            readOnly={session.status !== "idle"}
            onChange={(next) => {
              setContentDraft(next);
              setSaveStatus("idle");
            }}
            onSelectionChange={(nextSelection, position) => {
              setSelection(nextSelection);
              setSelectionToolbarPosition(position);
              if (nextSelection) {
                setSelectedDiagnosticId(null);
              }
            }}
            preview={previewPayload}
            focusRange={session.status === "idle"
              ? selection
                ? { from: selection.from, to: selection.to }
                : selectedDiagnosticCard?.anchorRange ?? null
              : null}
          />
          <SelectionAIFloatingToolbar
            visible={Boolean(selection && session.status === "idle")}
            position={selectionToolbarPosition}
            disabled={previewMutation.isPending}
            onRunOperation={handleRunOperation}
          />
        </div>

        <div className="min-h-0 overflow-hidden">
          <ChapterEditorDirectorPanel
            workspace={workspace}
            workspaceStatus={workspaceStatus}
            selectedDiagnosticCard={selectedDiagnosticCard}
            session={session}
            activeCandidate={activeCandidate}
            revisionScope={revisionScope}
            revisionInstruction={revisionInstruction}
            canRunSelectionRevision={canRunSelectionRevision}
            currentTargetDescription={currentTargetDescription}
            isGenerating={previewMutation.isPending}
            isApplying={acceptMutation.isPending}
            onInstructionChange={setRevisionInstruction}
            onScopeChange={setRevisionScope}
            onRunRecommended={handleRunRecommended}
            onRunSelectedDiagnostic={handleRunSelectedDiagnostic}
            onRunFreeform={handleRunFreeform}
            onSelectCandidate={(candidateId) => setSession((current) => ({ ...current, activeCandidateId: candidateId }))}
            onChangeViewMode={(mode) => setSession((current) => ({ ...current, viewMode: mode }))}
            onAccept={() => acceptMutation.mutate()}
            onReject={handleReject}
            onRegenerate={handleRegenerate}
          />
        </div>
      </div>
    </div>
  );
}
