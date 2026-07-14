import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  DEFAULT_AUDIOBOOK_NARRATOR_STYLE,
  DEFAULT_AUDIOBOOK_NARRATOR_VOICE,
  MIMO_TTS_VOICE_CATALOG,
  type AudiobookChapterReprocessMode,
  type AudiobookScopeMode,
  type AudiobookTaskAnnotationsView,
  type AudiobookTaskSummary,
} from "@ai-novel/shared/types/audiobook";
import type { Character } from "@ai-novel/shared/types/novel";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import {
  cancelAudiobookTask,
  createAudiobookTask,
  getAudiobookAnnotations,
  issueAudiobookMediaUrl,
  listAudiobookTasks,
  precheckAudiobookTask,
  reprocessAudiobookChapter,
} from "@/api/novel/audiobook";
import SelectControl from "@/components/common/SelectControl";

interface ChapterOption {
  id: string;
  order: number;
  title: string;
}

interface NovelAudiobookPanelProps {
  novelId: string;
  chapters: ChapterOption[];
  characters: Character[];
  narratorVoice?: string | null;
  narratorStyle?: string | null;
  onNarratorChange?: (patch: { audiobookNarratorVoice?: string; audiobookNarratorStyle?: string }) => void;
  onSaveNarrator?: () => void;
  isSavingNarrator?: boolean;
}

function statusLabel(status: AudiobookTaskSummary["status"]): string {
  if (status === "queued") return "排队中";
  if (status === "running") return "运行中";
  if (status === "succeeded") return "已完成";
  if (status === "failed") return "失败";
  return "已取消";
}

function statusVariant(status: AudiobookTaskSummary["status"]): "default" | "secondary" | "destructive" | "outline" {
  if (status === "running") return "default";
  if (status === "failed") return "destructive";
  if (status === "queued") return "secondary";
  return "outline";
}

function TaskAudioControls(props: { novelId: string; task: AudiobookTaskSummary }) {
  const { novelId, task } = props;
  const [audioUrl, setAudioUrl] = useState<string | null>(null);
  const [error, setError] = useState("");
  const canPlay = task.status === "succeeded" || Boolean(task.fullAudioPath);

  useEffect(() => {
    let cancelled = false;
    if (!canPlay) {
      setAudioUrl(null);
      return;
    }
    void (async () => {
      try {
        const url = await issueAudiobookMediaUrl(novelId, task.id, { resource: "full" });
        if (!cancelled) {
          setAudioUrl(url);
          setError("");
        }
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : "无法签发音频地址。");
          setAudioUrl(null);
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [canPlay, novelId, task.id, task.updatedAt]);

  if (!canPlay) {
    return null;
  }

  return (
    <div className="mt-3 space-y-2">
      {error ? <div className="text-sm text-destructive">{error}</div> : null}
      {audioUrl ? (
        <>
          <div className="flex flex-wrap gap-2">
            <Button asChild size="sm" variant="outline">
              <a href={audioUrl} target="_blank" rel="noreferrer">
                播放/下载全书
              </a>
            </Button>
          </div>
          <audio className="w-full" controls preload="none" src={audioUrl} />
        </>
      ) : (
        <div className="text-sm text-muted-foreground">正在准备音频地址…</div>
      )}
    </div>
  );
}

function TaskAnnotationsPanel(props: {
  novelId: string;
  task: AudiobookTaskSummary;
  onReprocessed: () => void;
  onMessage: (text: string) => void;
}) {
  const { novelId, task, onReprocessed, onMessage } = props;
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [busyChapterId, setBusyChapterId] = useState<string | null>(null);
  const [view, setView] = useState<AudiobookTaskAnnotationsView | null>(null);

  const terminal = task.status === "succeeded" || task.status === "failed" || task.status === "cancelled";

  async function loadAnnotations() {
    setLoading(true);
    try {
      const response = await getAudiobookAnnotations(novelId, task.id);
      setView(response.data ?? null);
      if (!response.data) {
        onMessage("暂无标注结果。");
      }
    } catch (error) {
      onMessage(error instanceof Error ? error.message : "加载标注失败。");
    } finally {
      setLoading(false);
    }
  }

  async function handleToggle() {
    const next = !open;
    setOpen(next);
    if (next && !view) {
      await loadAnnotations();
    }
  }

  async function handleReprocess(chapterId: string, mode: AudiobookChapterReprocessMode) {
    if (!terminal) {
      onMessage("任务运行中，请先等待完成或取消后再重做章节。");
      return;
    }
    setBusyChapterId(chapterId);
    try {
      await reprocessAudiobookChapter(novelId, task.id, chapterId, mode);
      onMessage(mode === "reannotate" ? "已排队：重标并重合成该章。" : "已排队：按现有标注重合成该章。");
      setOpen(false);
      setView(null);
      onReprocessed();
    } catch (error) {
      onMessage(error instanceof Error ? error.message : "章节重做失败。");
    } finally {
      setBusyChapterId(null);
    }
  }

  return (
    <div className="mt-3 space-y-3">
      <Button size="sm" variant="outline" onClick={() => void handleToggle()} disabled={loading}>
        {loading ? "加载标注..." : open ? "收起标注" : "查看标注"}
      </Button>
      {open ? (
        <div className="max-h-72 space-y-2 overflow-y-auto rounded-xl border border-border/70 bg-muted/20 p-3">
          {!view || view.annotations.length === 0 ? (
            <div className="text-sm leading-6 text-muted-foreground">
              尚无标注数据（任务未完成标注或已清空）。
            </div>
          ) : (
            view.annotations.map((annotation) => (
              <div
                key={annotation.chapterId}
                className="rounded-lg border border-border/70 bg-background p-3"
              >
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div className="text-sm font-medium text-foreground">
                    第 {annotation.chapterOrder} 章 {annotation.chapterTitle}
                    <span className="ml-2 text-xs font-normal text-muted-foreground">
                      {annotation.segments.length} 段
                    </span>
                  </div>
                  {terminal ? (
                    <div className="flex flex-wrap gap-2">
                      <Button
                        size="sm"
                        variant="outline"
                        disabled={busyChapterId === annotation.chapterId}
                        onClick={() => void handleReprocess(annotation.chapterId, "resynthesize")}
                      >
                        重合成
                      </Button>
                      <Button
                        size="sm"
                        variant="outline"
                        disabled={busyChapterId === annotation.chapterId}
                        onClick={() => void handleReprocess(annotation.chapterId, "reannotate")}
                      >
                        重标+合成
                      </Button>
                    </div>
                  ) : null}
                </div>
                {annotation.error ? (
                  <div className="mt-2 text-xs leading-5 text-amber-800">回退：{annotation.error}</div>
                ) : null}
                <div className="mt-2 space-y-1">
                  {annotation.segments.slice(0, 6).map((segment) => (
                    <div
                      key={`${annotation.chapterId}-${segment.index}`}
                      className="text-xs leading-5 text-muted-foreground"
                    >
                      <span className="font-medium text-foreground">
                        [{segment.speakerLabel}/{segment.voice}]
                      </span>
                      {" "}
                      {segment.text.length > 80 ? `${segment.text.slice(0, 80)}…` : segment.text}
                    </div>
                  ))}
                  {annotation.segments.length > 6 ? (
                    <div className="text-xs text-muted-foreground">
                      …另有 {annotation.segments.length - 6} 段
                    </div>
                  ) : null}
                </div>
              </div>
            ))
          )}
          {view?.qualityWarnings?.length ? (
            <div className="rounded-lg border border-amber-200/80 bg-amber-50/70 p-3 text-xs leading-6 text-amber-900">
              {view.qualityWarnings.join("；")}
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

export default function NovelAudiobookPanel(props: NovelAudiobookPanelProps) {
  const {
    novelId,
    chapters,
    characters,
    narratorVoice,
    narratorStyle,
    onNarratorChange,
    onSaveNarrator,
    isSavingNarrator,
  } = props;

  const queryClient = useQueryClient();
  const [scopeMode, setScopeMode] = useState<AudiobookScopeMode>("chapter");
  const [chapterId, setChapterId] = useState(chapters[0]?.id ?? "");
  const [startOrder, setStartOrder] = useState(String(chapters[0]?.order ?? 1));
  const [endOrder, setEndOrder] = useState(String(chapters[chapters.length - 1]?.order ?? 1));
  const [overrideVoice, setOverrideVoice] = useState("");
  const [message, setMessage] = useState("");

  const sortedChapters = useMemo(
    () => [...chapters].sort((a, b) => a.order - b.order),
    [chapters],
  );

  const missingVoiceCharacters = useMemo(
    () => characters.filter((character) => !character.ttsVoice?.trim()),
    [characters],
  );

  const tasksQuery = useQuery({
    queryKey: ["novel-audiobook-tasks", novelId],
    queryFn: async () => {
      const response = await listAudiobookTasks(novelId);
      return response.data ?? [];
    },
    refetchInterval: (query) => {
      const items = query.state.data ?? [];
      return items.some((item) => item.status === "queued" || item.status === "running") ? 4000 : false;
    },
  });

  const precheckMutation = useMutation({
    mutationFn: async () => {
      const payload = buildCreatePayload();
      const response = await precheckAudiobookTask(novelId, payload);
      return response.data;
    },
    onSuccess: (data) => {
      if (!data) {
        setMessage("预检无结果。");
        return;
      }
      if (data.ok) {
        setMessage(`预检通过：${data.chapterCount} 章，角色音色 ${data.characterVoices.length} 个。`);
      } else {
        const missing = data.missingVoices.map((item) => item.characterName).join("、");
        const blocking = data.blockingErrors.join("；");
        setMessage([
          missing ? `缺音色：${missing}` : "",
          blocking || "",
        ].filter(Boolean).join(" | ") || "预检未通过。");
      }
    },
    onError: (error) => {
      setMessage(error instanceof Error ? error.message : "预检失败。");
    },
  });

  const createMutation = useMutation({
    mutationFn: async () => {
      const payload = buildCreatePayload();
      const response = await createAudiobookTask(novelId, payload);
      return response.data;
    },
    onSuccess: async (data) => {
      setMessage(data ? `任务已创建：${data.title}` : "任务已创建。");
      await queryClient.invalidateQueries({ queryKey: ["novel-audiobook-tasks", novelId] });
    },
    onError: (error) => {
      setMessage(error instanceof Error ? error.message : "创建任务失败。");
    },
  });

  const cancelMutation = useMutation({
    mutationFn: async (taskId: string) => {
      const response = await cancelAudiobookTask(novelId, taskId);
      return response.data;
    },
    onSuccess: async () => {
      setMessage("取消请求已提交。");
      await queryClient.invalidateQueries({ queryKey: ["novel-audiobook-tasks", novelId] });
    },
    onError: (error) => {
      setMessage(error instanceof Error ? error.message : "取消失败。");
    },
  });

  function buildCreatePayload() {
    const narrator = overrideVoice.trim() || undefined;
    return {
      scopeMode,
      chapterId: scopeMode === "chapter" ? (chapterId || undefined) : undefined,
      startChapterOrder: scopeMode === "range" ? Number(startOrder) : undefined,
      endChapterOrder: scopeMode === "range" ? Number(endOrder) : undefined,
      narratorVoice: narrator,
    };
  }

  return (
    <section className="space-y-4 border-t border-border/60 pt-4">
      <div className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
        <div className="min-w-0 space-y-1">
          <div className="text-sm font-semibold text-foreground">生成有声书</div>
          <div className="text-sm leading-6 text-muted-foreground">
            多角色 TTS（CPA → MiMo）。请先在「角色准备」配置预置音色，并设置旁白默认音色。
          </div>
        </div>
        <Badge
          className="shrink-0"
          variant={missingVoiceCharacters.length > 0 ? "destructive" : "outline"}
        >
          {missingVoiceCharacters.length > 0
            ? `${missingVoiceCharacters.length} 个角色缺音色`
            : "角色音色齐全"}
        </Badge>
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <div className="space-y-2 rounded-xl border border-border/70 bg-muted/20 p-4">
          <div className="text-sm font-medium text-foreground">小说默认旁白</div>
          <div className="text-xs leading-5 text-muted-foreground">保存后供后续任务默认继承。</div>
          <SelectControl
            className="w-full rounded-md border bg-background p-2 text-sm"
            value={narratorVoice?.trim() || DEFAULT_AUDIOBOOK_NARRATOR_VOICE}
            onChange={(event) => onNarratorChange?.({ audiobookNarratorVoice: event.target.value })}
          >
            {MIMO_TTS_VOICE_CATALOG.map((item) => (
              <option key={item.id} value={item.id}>
                {item.label}{item.description ? ` · ${item.description}` : ""}
              </option>
            ))}
          </SelectControl>
          <textarea
            className="min-h-[72px] w-full rounded-md border bg-background p-2 text-sm leading-6"
            value={narratorStyle ?? DEFAULT_AUDIOBOOK_NARRATOR_STYLE}
            onChange={(event) => onNarratorChange?.({ audiobookNarratorStyle: event.target.value })}
            placeholder="旁白 style（user 消息）"
          />
          {onSaveNarrator ? (
            <Button size="sm" variant="outline" onClick={onSaveNarrator} disabled={isSavingNarrator}>
              {isSavingNarrator ? "保存中..." : "保存旁白设置"}
            </Button>
          ) : null}
        </div>

        <div className="space-y-2 rounded-xl border border-border/70 bg-muted/20 p-4">
          <div className="text-sm font-medium text-foreground">任务范围</div>
          <div className="text-xs leading-5 text-muted-foreground">选择单章、章节范围或全书后预检并创建任务。</div>
          <SelectControl
            className="w-full rounded-md border bg-background p-2 text-sm"
            value={scopeMode}
            onChange={(event) => setScopeMode(event.target.value as AudiobookScopeMode)}
          >
            <option value="chapter">单章</option>
            <option value="range">章节范围</option>
            <option value="full">全书</option>
          </SelectControl>
          {scopeMode === "chapter" ? (
            <SelectControl
              className="w-full rounded-md border bg-background p-2 text-sm"
              value={chapterId}
              onChange={(event) => setChapterId(event.target.value)}
            >
              {sortedChapters.map((chapter) => (
                <option key={chapter.id} value={chapter.id}>
                  {`第 ${chapter.order} 章 ${chapter.title}`}
                </option>
              ))}
            </SelectControl>
          ) : null}
          {scopeMode === "range" ? (
            <div className="flex gap-2">
              <Input
                type="number"
                min={1}
                value={startOrder}
                onChange={(event) => setStartOrder(event.target.value)}
                placeholder="起始 order"
              />
              <Input
                type="number"
                min={1}
                value={endOrder}
                onChange={(event) => setEndOrder(event.target.value)}
                placeholder="结束 order"
              />
            </div>
          ) : null}
          <div className="text-xs leading-5 text-muted-foreground">本次任务旁白覆盖（可选）</div>
          <SelectControl
            className="w-full rounded-md border bg-background p-2 text-sm"
            value={overrideVoice}
            onChange={(event) => setOverrideVoice(event.target.value)}
          >
            <option value="">使用小说默认旁白</option>
            {MIMO_TTS_VOICE_CATALOG.map((item) => (
              <option key={item.id} value={item.id}>
                {item.label}{item.description ? ` · ${item.description}` : ""}
              </option>
            ))}
          </SelectControl>
        </div>
      </div>

      {missingVoiceCharacters.length > 0 ? (
        <div className="rounded-xl border border-amber-200/80 bg-amber-50/70 p-3 text-sm leading-6 text-amber-900">
          请先到「角色准备」为以下角色选择 MiMo 预置音色：
          {" "}
          {missingVoiceCharacters.map((character) => character.name).join("、")}
        </div>
      ) : null}

      <div className="flex flex-wrap gap-2">
        <Button
          size="sm"
          variant="outline"
          disabled={precheckMutation.isPending || sortedChapters.length === 0}
          onClick={() => precheckMutation.mutate()}
        >
          {precheckMutation.isPending ? "预检中..." : "预检"}
        </Button>
        <Button
          size="sm"
          disabled={
            createMutation.isPending
            || sortedChapters.length === 0
            || missingVoiceCharacters.length > 0
          }
          onClick={() => createMutation.mutate()}
        >
          {createMutation.isPending ? "创建中..." : "生成有声书"}
        </Button>
      </div>

      {message ? (
        <div className="rounded-xl border border-border/70 bg-muted/20 px-4 py-3 text-sm leading-6 text-muted-foreground">
          {message}
        </div>
      ) : null}

      <div className="space-y-3">
        <div className="text-sm font-medium text-foreground">最近任务</div>
        {(tasksQuery.data ?? []).length === 0 ? (
          <div className="rounded-xl border border-dashed border-border/70 bg-background p-4 text-sm leading-6 text-muted-foreground">
            暂无有声书任务。完成音色配置后，可先预检再生成。
          </div>
        ) : (
          <div className="space-y-3">
            {(tasksQuery.data ?? []).slice(0, 8).map((task) => (
              <div
                key={task.id}
                className="rounded-xl border border-border/70 bg-background p-4"
              >
                <div className="flex flex-wrap items-center gap-2">
                  <div className="text-sm font-medium text-foreground">{task.title}</div>
                  <Badge variant={statusVariant(task.status)}>{statusLabel(task.status)}</Badge>
                  <span className="text-xs text-muted-foreground">
                    {task.progress}%
                    {task.currentItemLabel ? ` · ${task.currentItemLabel}` : ""}
                  </span>
                </div>
                {task.lastError ? (
                  <div className="mt-2 text-sm text-destructive">{task.lastError}</div>
                ) : null}
                {task.status === "succeeded" && task.currentItemLabel?.includes("旁白回退") ? (
                  <div className="mt-2 text-xs leading-5 text-amber-800">
                    {task.currentItemLabel}
                  </div>
                ) : null}
                <div className="mt-3 flex flex-wrap gap-2">
                  {(task.status === "queued" || task.status === "running") ? (
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={cancelMutation.isPending}
                      onClick={() => cancelMutation.mutate(task.id)}
                    >
                      取消
                    </Button>
                  ) : null}
                </div>
                <TaskAudioControls novelId={novelId} task={task} />
                <TaskAnnotationsPanel
                  novelId={novelId}
                  task={task}
                  onMessage={setMessage}
                  onReprocessed={() => {
                    void queryClient.invalidateQueries({ queryKey: ["novel-audiobook-tasks", novelId] });
                  }}
                />
              </div>
            ))}
          </div>
        )}
      </div>
    </section>
  );
}
