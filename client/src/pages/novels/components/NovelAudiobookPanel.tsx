import { useEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  DEFAULT_AUDIOBOOK_NARRATOR_STYLE,
  DEFAULT_AUDIOBOOK_NARRATOR_VOICE,
  MIMO_TTS_VOICE_CATALOG,
  type AudiobookChapterReprocessMode,
  type AudiobookScopeMode,
  type AudiobookTaskAnnotationsView,
  type AudiobookTaskSummary,
  type AudiobookTtsMode,
  type AudiobookVoicePlanItem,
} from "@ai-novel/shared/types/audiobook";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import {
  applyAudiobookVoicePlan,
  cancelAudiobookTask,
  createAudiobookTask,
  getAudiobookAnnotations,
  issueAudiobookMediaUrl,
  listAudiobookTasks,
  precheckAudiobookTask,
  previewAudiobookVoice,
  reprocessAudiobookChapter,
  suggestAudiobookVoicePlan,
} from "@/api/novel/audiobook";
import { queryKeys } from "@/api/queryKeys";
import SelectControl from "@/components/common/SelectControl";
import {
  decodeBase64AudioToObjectUrl,
  replaceObjectUrl,
  tryAutoPlayAudio,
} from "@/lib/audiobookVoiceAudio";
import {
  resolveCharacterVoiceBinding,
  resolveCharacterVoiceMode,
} from "./characterAssetWorkspace.helpers";

interface ChapterOption {
  id: string;
  order: number;
  title: string;
}

/** 面板只需音色相关字段；workspace 投影与完整角色均可（null 兼容）。 */
type AudiobookPanelCharacter = {
  id: string;
  name: string;
  gender?: string | null;
  castRole?: string | null;
  role?: string | null;
  ttsMode?: string | null;
  ttsVoice?: string | null;
  ttsStyle?: string | null;
  ttsDesignPrompt?: string | null;
  ttsRefAudioPath?: string | null;
  ttsSpeakerAliases?: string | null;
};

interface NovelAudiobookPanelProps {
  novelId: string;
  chapters: ChapterOption[];
  characters: AudiobookPanelCharacter[];
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

/** 与小说 export 一致：blob 触发本地下载，不走远程拷贝旁路。 */
function triggerBlobDownload(blob: Blob, fileName: string): void {
  const objectUrl = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = objectUrl;
  anchor.download = fileName;
  anchor.rel = "noreferrer";
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  // 延迟 revoke，避免部分浏览器下载未启动就失效
  window.setTimeout(() => URL.revokeObjectURL(objectUrl), 30_000);
}

function withDownloadParam(url: string): string {
  try {
    const parsed = new URL(url, window.location.origin);
    parsed.searchParams.set("download", "1");
    return parsed.toString();
  } catch {
    return url.includes("?") ? `${url}&download=1` : `${url}?download=1`;
  }
}

/**
 * 通过 fetch 拉取媒体并带进度回调（大文件）。
 * access 在 query 中，无需额外 header。
 */
async function fetchMediaBlob(
  url: string,
  onProgress?: (loaded: number, total: number | null) => void,
  signal?: AbortSignal,
): Promise<Blob> {
  const response = await fetch(withDownloadParam(url), {
    method: "GET",
    credentials: "same-origin",
    signal,
  });
  if (!response.ok) {
    throw new Error(`下载失败（HTTP ${response.status}）`);
  }
  const totalHeader = response.headers.get("Content-Length");
  const total = totalHeader ? Number(totalHeader) : NaN;
  const knownTotal = Number.isFinite(total) && total > 0 ? total : null;

  if (!response.body || !onProgress) {
    return response.blob();
  }

  const reader = response.body.getReader();
  const chunks: BlobPart[] = [];
  let loaded = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }
    if (value) {
      chunks.push(value);
      loaded += value.byteLength;
      onProgress(loaded, knownTotal);
    }
  }
  const contentType = response.headers.get("Content-Type") || "application/octet-stream";
  return new Blob(chunks, { type: contentType });
}

function formatDownloadBytes(bytes: number): string {
  if (bytes < 1024) {
    return `${bytes} B`;
  }
  if (bytes < 1024 * 1024) {
    return `${(bytes / 1024).toFixed(1)} KB`;
  }
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function TaskAudioControls(props: {
  novelId: string;
  task: AudiobookTaskSummary;
  chapters: ChapterOption[];
}) {
  const { novelId, task, chapters } = props;
  const [fullUrl, setFullUrl] = useState<string | null>(null);
  const [m4bUrl, setM4bUrl] = useState<string | null>(null);
  const [chapterUrls, setChapterUrls] = useState<Record<string, string>>({});
  const [selectedChapterId, setSelectedChapterId] = useState<string>("");
  const [busyDownload, setBusyDownload] = useState<string | null>(null);
  const [downloadProgress, setDownloadProgress] = useState<{
    key: string;
    loaded: number;
    total: number | null;
  } | null>(null);
  const [error, setError] = useState("");
  const [issuing, setIssuing] = useState(false);
  /** 稳定 media-access 缓存：不因 task.updatedAt / 4s 轮询重签打断播放 */
  const mediaCacheRef = useRef<{
    taskId: string;
    fullUrl: string | null;
    m4bUrl: string | null;
    chapterUrls: Record<string, string>;
  }>({ taskId: "", fullUrl: null, m4bUrl: null, chapterUrls: {} });

  // 以服务端盘面探测为准，不把 status=succeeded 当作文件存在
  const readyChapterIds = task.readyChapterIds ?? [];
  const readyChapterKey = readyChapterIds.join(",");
  const fullAudioReady = Boolean(task.fullAudioReady);
  const m4bReady = task.m4bStatus === "ready";
  const hasProgressiveChapters = readyChapterIds.length > 0;
  const showDelivery = fullAudioReady || m4bReady || hasProgressiveChapters;

  const chapterTitleById = useMemo(() => {
    const map = new Map<string, string>();
    for (const chapter of chapters) {
      map.set(chapter.id, `第 ${chapter.order} 章 ${chapter.title}`);
    }
    return map;
  }, [chapters]);

  const orderedReadyChapters = useMemo(() => {
    const orderMap = new Map(chapters.map((item) => [item.id, item.order]));
    return [...readyChapterIds].sort((a, b) => (orderMap.get(a) ?? 0) - (orderMap.get(b) ?? 0));
  }, [chapters, readyChapterIds]);

  useEffect(() => {
    if (orderedReadyChapters.length === 0) {
      setSelectedChapterId("");
      return;
    }
    if (!selectedChapterId || !orderedReadyChapters.includes(selectedChapterId)) {
      setSelectedChapterId(orderedReadyChapters[orderedReadyChapters.length - 1]);
    }
  }, [orderedReadyChapters, selectedChapterId]);

  // 稳定签发：不依赖 task.updatedAt，避免 4s 轮询打断 <audio>
  // 仅在 taskId / 就绪集合 / 选中章 变化时补签缺失 URL
  useEffect(() => {
    let cancelled = false;
    if (mediaCacheRef.current.taskId !== task.id) {
      mediaCacheRef.current = {
        taskId: task.id,
        fullUrl: null,
        m4bUrl: null,
        chapterUrls: {},
      };
    }

    if (!showDelivery) {
      mediaCacheRef.current.fullUrl = null;
      mediaCacheRef.current.m4bUrl = null;
      mediaCacheRef.current.chapterUrls = {};
      setFullUrl(null);
      setM4bUrl(null);
      setChapterUrls({});
      setIssuing(false);
      return;
    }

    void (async () => {
      setIssuing(true);
      try {
        const cache = mediaCacheRef.current;
        const nextChapterUrls: Record<string, string> = { ...cache.chapterUrls };
        for (const key of Object.keys(nextChapterUrls)) {
          if (!orderedReadyChapters.includes(key)) {
            delete nextChapterUrls[key];
          }
        }

        if (
          selectedChapterId
          && orderedReadyChapters.includes(selectedChapterId)
          && !nextChapterUrls[selectedChapterId]
        ) {
          nextChapterUrls[selectedChapterId] = await issueAudiobookMediaUrl(novelId, task.id, {
            resource: "chapter",
            chapterId: selectedChapterId,
          });
        }

        let nextFull = cache.fullUrl;
        let nextM4b = cache.m4bUrl;
        if (fullAudioReady && !nextFull) {
          nextFull = await issueAudiobookMediaUrl(novelId, task.id, { resource: "full" });
        }
        if (!fullAudioReady) {
          nextFull = null;
        }
        if (m4bReady && !nextM4b) {
          nextM4b = await issueAudiobookMediaUrl(novelId, task.id, { resource: "full_m4b" }).catch(
            () => null,
          );
        }
        if (!m4bReady) {
          nextM4b = null;
        }

        cache.fullUrl = nextFull;
        cache.m4bUrl = nextM4b;
        cache.chapterUrls = nextChapterUrls;

        if (!cancelled) {
          setChapterUrls(nextChapterUrls);
          setFullUrl(nextFull);
          setM4bUrl(nextM4b);
          setError("");
        }
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : "无法签发音频地址。");
        }
      } finally {
        if (!cancelled) {
          setIssuing(false);
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [
    fullAudioReady,
    m4bReady,
    novelId,
    orderedReadyChapters,
    readyChapterKey,
    selectedChapterId,
    showDelivery,
    task.id,
  ]);

  if (!showDelivery) {
    return null;
  }

  const m4bHint = m4bReady
    ? "优先下载 m4b（含章节目录，体积更小）。WAV 为无损兜底。"
    : task.m4bStatus === "skipped"
      ? "本任务未封装 m4b（环境可能缺少 ffmpeg），请下载 WAV。"
      : task.m4bStatus === "failed"
        ? "m4b 封装失败，请下载 WAV。"
        : fullAudioReady
          ? "全书 WAV 已可下载；m4b 仅在封装成功后提供。"
          : "章节音频已就绪，可先按章试听/下载；全书完成后提供汇总交付。";

  const selectedChapterUrl = selectedChapterId ? chapterUrls[selectedChapterId] ?? null : null;
  // 全书就绪时：顶部播全书；章节区始终可单独播选中章
  const fullPlayerUrl = fullUrl;
  const chapterPlayerUrl = selectedChapterUrl;
  const primaryDownloadLabel = m4bReady ? "下载 m4b（推荐）" : fullAudioReady ? "下载全书 WAV" : null;

  async function downloadMedia(
    key: string,
    resolveUrl: () => Promise<string>,
    fileName: string,
  ): Promise<void> {
    setBusyDownload(key);
    setError("");
    setDownloadProgress({ key, loaded: 0, total: null });
    const controller = new AbortController();
    try {
      const url = await resolveUrl();
      const blob = await fetchMediaBlob(
        url,
        (loaded, total) => {
          setDownloadProgress({ key, loaded, total });
        },
        controller.signal,
      );
      triggerBlobDownload(blob, fileName);
    } catch (err) {
      if ((err as { name?: string })?.name === "AbortError") {
        return;
      }
      setError(err instanceof Error ? err.message : "下载失败。");
    } finally {
      setBusyDownload(null);
      setDownloadProgress(null);
    }
  }

  async function handlePrimaryDownload() {
    if (m4bReady) {
      await downloadMedia(
        "primary",
        async () => m4bUrl ?? issueAudiobookMediaUrl(novelId, task.id, { resource: "full_m4b" }),
        `audiobook-${task.id}-full.m4b`,
      );
      return;
    }
    if (fullAudioReady) {
      await downloadMedia(
        "primary",
        async () => fullUrl ?? issueAudiobookMediaUrl(novelId, task.id, { resource: "full" }),
        `audiobook-${task.id}-full.wav`,
      );
    }
  }

  async function handleWavDownload() {
    await downloadMedia(
      "wav",
      async () => fullUrl ?? issueAudiobookMediaUrl(novelId, task.id, { resource: "full" }),
      `audiobook-${task.id}-full.wav`,
    );
  }

  async function handleChapterDownload(chapterId: string) {
    await downloadMedia(
      `chapter:${chapterId}`,
      async () => chapterUrls[chapterId]
        ?? issueAudiobookMediaUrl(novelId, task.id, { resource: "chapter", chapterId }),
      `audiobook-${task.id}-${chapterId}.wav`,
    );
  }

  const activeProgress = downloadProgress && busyDownload === downloadProgress.key
    ? downloadProgress
    : null;
  const progressPercent = activeProgress && activeProgress.total
    ? Math.min(100, Math.round((activeProgress.loaded / activeProgress.total) * 100))
    : null;

  return (
    <div className="mt-3 space-y-3 rounded-xl border border-border/70 bg-muted/15 p-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="text-sm font-medium text-foreground">交付</div>
        <div className="text-xs text-muted-foreground">
          浏览器下载 / 试听 · 与小说导出一致 · 不经 SSH
        </div>
      </div>
      {error ? <div className="text-sm text-destructive">{error}</div> : null}

      {primaryDownloadLabel || fullAudioReady || m4bReady ? (
        <div className="flex flex-wrap gap-2">
          {primaryDownloadLabel ? (
            <Button
              size="sm"
              disabled={busyDownload === "primary"}
              onClick={() => void handlePrimaryDownload()}
            >
              {busyDownload === "primary" ? "下载中…" : primaryDownloadLabel}
            </Button>
          ) : null}
          {m4bReady && fullAudioReady ? (
            <Button
              size="sm"
              variant="outline"
              disabled={busyDownload === "wav"}
              onClick={() => void handleWavDownload()}
            >
              {busyDownload === "wav" ? "下载中…" : "下载全书 WAV"}
            </Button>
          ) : null}
          {fullPlayerUrl ? (
            <Button asChild size="sm" variant="outline">
              <a href={fullPlayerUrl} target="_blank" rel="noreferrer">
                新窗口播放全书
              </a>
            </Button>
          ) : null}
        </div>
      ) : null}

      {activeProgress ? (
        <div className="space-y-1.5">
          <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-muted-foreground">
            <span>正在下载到本地…</span>
            <span>
              {formatDownloadBytes(activeProgress.loaded)}
              {activeProgress.total
                ? ` / ${formatDownloadBytes(activeProgress.total)}`
                : ""}
              {progressPercent != null ? ` · ${progressPercent}%` : ""}
            </span>
          </div>
          <div className="h-2 overflow-hidden rounded-full bg-muted">
            <div
              className="h-full rounded-full bg-primary transition-[width] duration-150"
              style={{
                width: progressPercent != null
                  ? `${progressPercent}%`
                  : activeProgress.loaded > 0
                    ? "35%"
                    : "8%",
              }}
            />
          </div>
        </div>
      ) : null}

      {fullPlayerUrl ? (
        <div className="space-y-1">
          <div className="text-xs text-muted-foreground">全书试听</div>
          <audio className="w-full" controls preload="none" src={fullPlayerUrl} />
        </div>
      ) : showDelivery && issuing && !hasProgressiveChapters ? (
        <div className="text-sm text-muted-foreground">正在准备音频地址…</div>
      ) : null}

      {hasProgressiveChapters ? (
        <div className="space-y-2">
          <div className="text-xs leading-5 text-muted-foreground">
            已可播章节 {readyChapterIds.length}/{task.chapterCount}
            {task.status === "running" || task.status === "queued"
              ? "（生成中即可按章试听/下载，无需等全书）"
              : ""}
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <SelectControl
              className="min-w-[12rem] flex-1 rounded-md border bg-background p-2 text-sm"
              value={selectedChapterId}
              onChange={(event) => setSelectedChapterId(event.target.value)}
            >
              {orderedReadyChapters.map((chapterId) => (
                <option key={chapterId} value={chapterId}>
                  {chapterTitleById.get(chapterId) ?? chapterId}
                </option>
              ))}
            </SelectControl>
            <Button
              size="sm"
              variant="outline"
              disabled={!selectedChapterId || busyDownload === `chapter:${selectedChapterId}`}
              onClick={() => {
                if (selectedChapterId) {
                  void handleChapterDownload(selectedChapterId);
                }
              }}
            >
              {busyDownload === `chapter:${selectedChapterId}` ? "下载中…" : "下载本章 WAV"}
            </Button>
          </div>
          {chapterPlayerUrl ? (
            <div className="space-y-1">
              <div className="text-xs text-muted-foreground">本章试听</div>
              <audio className="w-full" controls preload="none" src={chapterPlayerUrl} />
            </div>
          ) : issuing ? (
            <div className="text-sm text-muted-foreground">正在准备章节音频地址…</div>
          ) : null}
        </div>
      ) : null}

      <p className="text-xs text-muted-foreground">{m4bHint}</p>
      {task.chunksPruned ? (
        <p className="text-xs text-muted-foreground">中间 chunk 已清理，章 WAV / 全书文件仍可下载。</p>
      ) : null}
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
  const [voicePlanItems, setVoicePlanItems] = useState<AudiobookVoicePlanItem[]>([]);
  const [voicePlanOverwrite, setVoicePlanOverwrite] = useState(false);
  const [previewAudioUrl, setPreviewAudioUrl] = useState<string | null>(null);
  const [previewLabel, setPreviewLabel] = useState("");
  const previewAudioRef = useRef<HTMLAudioElement | null>(null);

  useEffect(() => {
    return () => {
      if (previewAudioUrl) {
        URL.revokeObjectURL(previewAudioUrl);
      }
    };
  }, [previewAudioUrl]);

  useEffect(() => {
    if (!previewAudioUrl) {
      return;
    }
    void tryAutoPlayAudio(previewAudioRef.current);
  }, [previewAudioUrl]);

  const sortedChapters = useMemo(
    () => [...chapters].sort((a, b) => a.order - b.order),
    [chapters],
  );

  const characterVoiceRows = useMemo(
    () => characters.map((character) => {
      const binding = resolveCharacterVoiceBinding(character);
      return { character, binding };
    }),
    [characters],
  );

  const missingVoiceCharacters = useMemo(
    () => characterVoiceRows.filter((row) => !row.binding.ready).map((row) => row.character),
    [characterVoiceRows],
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

  const suggestVoiceMutation = useMutation({
    mutationFn: async (mode: "missing" | "rebalance") => {
      const overwriteMode = mode === "rebalance";
      setVoicePlanOverwrite(overwriteMode);
      const response = await suggestAudiobookVoicePlan(novelId, {
        onlyMissing: !overwriteMode,
        strategy: "auto",
      });
      return { data: response.data, overwriteMode };
    },
    onSuccess: ({ data, overwriteMode }) => {
      const items = data?.items ?? [];
      setVoicePlanItems(items);
      if (!data || items.length === 0) {
        setMessage(
          data?.skipped?.length
            ? `无需规划：${data.skipped.length} 个角色已绑定或已跳过。`
            : "未生成音色规划（可能没有角色）。",
        );
        return;
      }
      setMessage(
        `${overwriteMode ? "重新差异化" : "补齐缺失"}规划 ${items.length} 项：preset ${data.summary.presetCount} / design ${data.summary.designCount}${
          overwriteMode ? "（写入时将覆盖已绑定）" : ""
        }。`,
      );
    },
    onError: (error) => {
      setMessage(error instanceof Error ? error.message : "音色规划失败。");
    },
  });

  const applyVoiceMutation = useMutation({
    mutationFn: async () => {
      if (voicePlanItems.length === 0) {
        throw new Error("请先生成音色规划。");
      }
      const response = await applyAudiobookVoicePlan(novelId, {
        overwrite: voicePlanOverwrite,
        items: voicePlanItems.map((item) => ({
          characterId: item.characterId,
          ttsMode: item.ttsMode,
          ttsVoice: item.ttsVoice,
          ttsStyle: item.ttsStyle,
          ttsDesignPrompt: item.ttsDesignPrompt,
          speakerAliases: item.speakerAliases,
        })),
      });
      return response.data;
    },
    onSuccess: async (data) => {
      setMessage(
        data
          ? `已写入 ${data.applied.length} 个角色音色，跳过 ${data.skipped.length}。角色卡缓存已刷新。`
          : "音色已写入。",
      );
      setVoicePlanItems([]);
      setVoicePlanOverwrite(false);
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: queryKeys.novels.detail(novelId) }),
        queryClient.invalidateQueries({ queryKey: queryKeys.novels.characters(novelId) }),
        queryClient.invalidateQueries({ queryKey: queryKeys.novels.audiobookWorkspace(novelId) }),
      ]);
    },
    onError: (error) => {
      setMessage(error instanceof Error ? error.message : "写入音色失败。");
    },
  });

  type VoicePreviewTarget =
    | { kind: "plan"; item: AudiobookVoicePlanItem }
    | { kind: "character"; character: AudiobookPanelCharacter };

  const previewVoiceMutation = useMutation({
    mutationFn: async (target: VoicePreviewTarget) => {
      if (target.kind === "plan") {
        const item = target.item;
        const response = await previewAudiobookVoice(novelId, {
          characterId: item.characterId,
          ttsMode: item.ttsMode,
          ttsVoice: item.ttsVoice,
          ttsStyle: item.ttsStyle,
          ttsDesignPrompt: item.ttsDesignPrompt,
        });
        return {
          label: `${item.characterName} · ${item.ttsMode}${item.ttsVoice ? `/${item.ttsVoice}` : ""}`,
          characterName: item.characterName,
          data: response.data,
        };
      }

      const character = target.character;
      const mode = resolveCharacterVoiceMode(character.ttsMode);
      const binding = resolveCharacterVoiceBinding(character);
      if (!binding.ready) {
        throw new Error(`${character.name} 尚未配置完整音色，无法试听。`);
      }
      const response = await previewAudiobookVoice(novelId, {
        characterId: character.id,
        ttsMode: mode as AudiobookTtsMode,
        ttsVoice: character.ttsVoice ?? null,
        ttsStyle: character.ttsStyle ?? null,
        ttsDesignPrompt: character.ttsDesignPrompt ?? null,
      });
      return {
        label: `${character.name} · ${binding.detailLabel}`,
        characterName: character.name,
        data: response.data,
      };
    },
    onSuccess: ({ label, characterName, data }) => {
      if (!data?.audioBase64) {
        setMessage("试听无音频。");
        return;
      }
      setPreviewAudioUrl((prev) =>
        replaceObjectUrl(prev, decodeBase64AudioToObjectUrl(data.audioBase64, "audio/wav")),
      );
      setPreviewLabel(label);
      setMessage(`试听已生成并尝试播放：${characterName}`);
    },
    onError: (error) => {
      setMessage(error instanceof Error ? error.message : "试听失败。");
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
            多角色 TTS（CPA → MiMo）。可先「自动规划音色」写入角色卡，再设旁白并生成。
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

      <div className="space-y-3 rounded-xl border border-border/70 bg-muted/20 p-4">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div>
            <div className="text-sm font-medium text-foreground">人物卡 → 音色资产</div>
            <div className="text-xs leading-5 text-muted-foreground">
              一眼看清谁已配/谁缺配；可先「自动规划」再写入角色卡，或对已绑定角色直接试听。
            </div>
          </div>
          <div className="flex flex-wrap gap-2">
            <Button
              size="sm"
              variant="outline"
              disabled={suggestVoiceMutation.isPending || characters.length === 0}
              onClick={() => suggestVoiceMutation.mutate("missing")}
            >
              {suggestVoiceMutation.isPending ? "规划中..." : "补齐缺失音色"}
            </Button>
            <Button
              size="sm"
              variant="outline"
              disabled={suggestVoiceMutation.isPending || characters.length === 0}
              onClick={() => suggestVoiceMutation.mutate("rebalance")}
            >
              重新差异化
            </Button>
            <Button
              size="sm"
              disabled={
                applyVoiceMutation.isPending
                || voicePlanItems.length === 0
              }
              onClick={() => applyVoiceMutation.mutate()}
            >
              {applyVoiceMutation.isPending
                ? "写入中..."
                : `写入规划（${voicePlanItems.length}${voicePlanOverwrite ? "·覆盖" : ""}）`}
            </Button>
          </div>
        </div>

        {characterVoiceRows.length > 0 ? (
          <div className="max-h-52 space-y-1 overflow-y-auto rounded-lg border border-border/60 bg-background p-2">
            <div className="px-2 py-1 text-xs font-medium text-muted-foreground">
              当前绑定（{characterVoiceRows.length - missingVoiceCharacters.length}/{characterVoiceRows.length} 已就绪）
            </div>
            {characterVoiceRows.map(({ character, binding }) => (
              <div
                key={character.id}
                className="flex flex-wrap items-center justify-between gap-2 rounded-md px-2 py-1.5 text-sm"
              >
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-medium text-foreground">{character.name}</span>
                    <Badge variant={binding.ready ? "outline" : "destructive"}>
                      {binding.ready ? binding.shortLabel : "缺音色"}
                    </Badge>
                    <span className="text-xs text-muted-foreground">{binding.modeLabel}</span>
                  </div>
                  <div className="text-xs leading-5 text-muted-foreground">{binding.detailLabel}</div>
                </div>
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={previewVoiceMutation.isPending || !binding.ready}
                  onClick={() => previewVoiceMutation.mutate({ kind: "character", character })}
                >
                  试听
                </Button>
              </div>
            ))}
          </div>
        ) : (
          <div className="rounded-lg border border-dashed px-3 py-4 text-xs text-muted-foreground">
            暂无角色。请先在人物卡建角，再回到这里规划/试听。
          </div>
        )}

        {voicePlanItems.length > 0 ? (
          <div className="max-h-56 space-y-2 overflow-y-auto rounded-lg border border-border/60 bg-background p-2">
            <div className="px-2 py-1 text-xs font-medium text-muted-foreground">
              待写入规划（{voicePlanItems.length}）{voicePlanOverwrite ? " · 将覆盖已绑定" : " · 仅补齐缺失"}
            </div>
            {voicePlanItems.map((item) => (
              <div
                key={item.characterId}
                className="flex flex-wrap items-start justify-between gap-2 rounded-md px-2 py-1.5 text-sm"
              >
                <div className="min-w-0 flex-1">
                  <div className="font-medium text-foreground">
                    {item.characterName}
                    <span className="ml-2 text-xs font-normal text-muted-foreground">
                      {item.ttsMode}
                      {item.ttsVoice ? ` · ${item.ttsVoice}` : ""}
                      {` · 重要度 ${item.importance}`}
                    </span>
                  </div>
                  <div className="text-xs leading-5 text-muted-foreground">
                    {item.reason}
                    {item.ttsMode === "design" && item.ttsDesignPrompt
                      ? ` · ${item.ttsDesignPrompt.slice(0, 80)}${item.ttsDesignPrompt.length > 80 ? "…" : ""}`
                      : ""}
                  </div>
                </div>
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={previewVoiceMutation.isPending}
                  onClick={() => previewVoiceMutation.mutate({ kind: "plan", item })}
                >
                  试听
                </Button>
              </div>
            ))}
          </div>
        ) : null}
        {previewAudioUrl ? (
          <div className="space-y-1">
            <div className="text-xs text-muted-foreground">试听：{previewLabel}</div>
            <audio ref={previewAudioRef} controls autoPlay src={previewAudioUrl} className="w-full" />
          </div>
        ) : null}
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
                    {(task.readyChapterIds?.length ?? 0) > 0
                      ? ` · 已可播 ${task.readyChapterIds!.length}/${task.chapterCount} 章`
                      : ""}
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
                <TaskAudioControls novelId={novelId} task={task} chapters={sortedChapters} />
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
