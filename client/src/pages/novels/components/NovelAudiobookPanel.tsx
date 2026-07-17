import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ChevronDown } from "lucide-react";
import {
  DEFAULT_AUDIOBOOK_NARRATOR_STYLE,
  DEFAULT_AUDIOBOOK_NARRATOR_VOICE,
  MIMO_TTS_VOICE_CATALOG,
  type AudiobookChapterReprocessMode,
  type AudiobookScopeMode,
  type AudiobookTaskAnnotationsView,
  type AudiobookTaskSummary,
  type AudiobookVoicePlanItem,
  type AudiobookVoiceReadinessSummary,
  type CharacterVoicePreviewStatus,
  type DeliveryStyleMode,
} from "@ai-novel/shared/types/audiobook";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { toast } from "@/components/ui/toast";
import {
  applyAudiobookVoicePlan,
  cancelAudiobookTask,
  createAudiobookTask,
  getAudiobookAnnotations,
  issueAudiobookMediaUrl,
  issueCharacterVoicePreviewMediaUrl,
  listAudiobookTasks,
  precheckAudiobookTask,
  previewAudiobookVoice,
  reprocessAudiobookChapter,
  suggestAudiobookVoicePlan,
} from "@/api/novel/audiobook";
import { queryKeys } from "@/api/queryKeys";
import SelectControl from "@/components/common/SelectControl";
import {
  createObjectUrlSlot,
  decodeBase64AudioToObjectUrl,
  inspectWavAudioBase64,
  tryAutoPlayAudio,
} from "@/lib/audiobookVoiceAudio";
import {
  resolveCharacterVoiceBinding,
} from "./characterAssetWorkspace.helpers";
import AudiobookVoiceReadinessSection from "./AudiobookVoiceReadinessSection";

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
  voicePreviewStatus?: CharacterVoicePreviewStatus | null;
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
  /** workspace bootstrap 的 active readiness job，传给就绪看板 seed */
  bootstrapActiveJobId?: string | null;
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

function isActiveAudiobookTask(status: AudiobookTaskSummary["status"]): boolean {
  return status === "queued" || status === "running";
}

function taskSummaryMeta(task: AudiobookTaskSummary): string {
  const parts = [`${task.progress}%`];
  if (task.currentItemLabel) {
    parts.push(task.currentItemLabel);
  }
  const readyCount = task.readyChapterIds?.length ?? 0;
  if (readyCount > 0) {
    parts.push(`已可播 ${readyCount}/${task.chapterCount} 章`);
  }
  return parts.join(" · ");
}

/**
 * 默认展开策略（纯函数）：
 * - 有运行中/排队：只自动展开列表中最新一条 active（slice 顺序假定新→旧）
 * - 无 active：只展开最新一条（index 0），其余折叠
 * 多 active 时避免同时挂多张重交付卡。
 */
function resolveTaskCardDefaultOpen(
  tasks: AudiobookTaskSummary[],
  taskId: string,
  index: number,
): boolean {
  const firstActive = tasks.find((item) => isActiveAudiobookTask(item.status));
  if (firstActive) {
    return firstActive.id === taskId;
  }
  return index === 0;
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
    <div className="mt-3 space-y-3 rounded-xl border border-primary/25 bg-primary/5 p-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="text-sm font-medium text-foreground">在线试听</div>
        <div className="text-xs text-muted-foreground">
          网页内直接播放 · 无需下载 · 不经 SSH
        </div>
      </div>
      {error ? <div className="text-sm text-destructive">{error}</div> : null}

      {fullPlayerUrl ? (
        <div className="space-y-2 rounded-lg border border-border/70 bg-background p-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="text-sm font-medium text-foreground">全书在线听</div>
            <Button asChild size="sm" variant="outline">
              <a href={fullPlayerUrl} target="_blank" rel="noreferrer">
                新窗口打开
              </a>
            </Button>
          </div>
          <audio className="w-full" controls preload="metadata" src={fullPlayerUrl} />
          <p className="text-xs text-muted-foreground">
            点播放键即可听；大文件首次缓冲可能需几秒。
          </p>
        </div>
      ) : showDelivery && issuing && !hasProgressiveChapters ? (
        <div className="text-sm text-muted-foreground">正在准备在线播放地址…</div>
      ) : null}

      {hasProgressiveChapters ? (
        <div className="space-y-2 rounded-lg border border-border/70 bg-background p-3">
          <div className="text-sm font-medium text-foreground">按章在线听</div>
          <div className="text-xs leading-5 text-muted-foreground">
            已可播 {readyChapterIds.length}/{task.chapterCount} 章
            {task.status === "running" || task.status === "queued"
              ? "（生成中即可听，无需等全书）"
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
              <audio className="w-full" controls preload="metadata" src={chapterPlayerUrl} />
            </div>
          ) : issuing ? (
            <div className="text-sm text-muted-foreground">正在准备章节播放地址…</div>
          ) : null}
        </div>
      ) : null}

      {(primaryDownloadLabel || fullAudioReady || m4bReady) ? (
        <div className="space-y-2 border-t border-border/60 pt-3">
          <div className="text-xs font-medium text-muted-foreground">下载到本地（可选）</div>
          <div className="flex flex-wrap gap-2">
            {primaryDownloadLabel ? (
              <Button
                size="sm"
                variant="outline"
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
          </div>
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

      <p className="text-xs text-muted-foreground">{m4bHint}</p>
      {task.chunksPruned ? (
        <p className="text-xs text-muted-foreground">中间 chunk 已清理，章 WAV / 全书文件仍可在线听与下载。</p>
      ) : null}
    </div>
  );
}

function RecentAudiobookTaskCard(props: {
  novelId: string;
  task: AudiobookTaskSummary;
  chapters: ChapterOption[];
  defaultOpen: boolean;
  cancelPending: boolean;
  onCancel: (taskId: string) => void;
  onMessage: (text: string) => void;
  onReprocessed: () => void;
}) {
  const {
    novelId,
    task,
    chapters,
    defaultOpen,
    cancelPending,
    onCancel,
    onMessage,
    onReprocessed,
  } = props;
  const [open, setOpen] = useState(defaultOpen);
  const active = isActiveAudiobookTask(task.status);
  /**
   * 交付控件：展开后本卡片生命周期内保留（折叠用 hidden，不 unmount），
   * 避免收起/再展开打断 <audio> 与 media 签发缓存。
   * 未展开过的卡片不预挂载，避免多任务同时签发。
   */
  const [deliveryMounted, setDeliveryMounted] = useState(defaultOpen);

  useEffect(() => {
    if (defaultOpen) {
      setOpen(true);
      setDeliveryMounted(true);
    }
  }, [defaultOpen, task.id]);

  useEffect(() => {
    if (open) {
      setDeliveryMounted(true);
    }
  }, [open]);

  return (
    <details
      className="group rounded-xl border border-border/70 bg-background p-4"
      open={open}
      onToggle={(event) => setOpen(event.currentTarget.open)}
    >
      <summary className="cursor-pointer list-none [&::-webkit-details-marker]:hidden">
        <div className="flex flex-wrap items-start justify-between gap-2">
          <div className="min-w-0 flex-1 space-y-1">
            <div className="flex flex-wrap items-center gap-2">
              <div className="text-sm font-medium text-foreground">{task.title}</div>
              <Badge variant={statusVariant(task.status)}>{statusLabel(task.status)}</Badge>
              {active ? (
                <Button
                  size="sm"
                  variant="outline"
                  className="h-7"
                  disabled={cancelPending}
                  onClick={(event) => {
                    event.preventDefault();
                    event.stopPropagation();
                    onCancel(task.id);
                  }}
                >
                  取消
                </Button>
              ) : null}
            </div>
            <div className="text-xs leading-5 text-muted-foreground">
              {taskSummaryMeta(task)}
            </div>
            {task.lastError ? (
              <div className="line-clamp-2 text-sm text-destructive" title={task.lastError}>
                {task.lastError}
              </div>
            ) : null}
            {task.status === "succeeded" && task.currentItemLabel?.includes("旁白回退") ? (
              <div className="text-xs leading-5 text-amber-800">
                {task.currentItemLabel}
              </div>
            ) : null}
          </div>
          <div className="flex shrink-0 items-center gap-2 text-xs text-muted-foreground">
            <span className="group-open:hidden">展开交付/标注</span>
            <span className="hidden group-open:inline">收起详情</span>
            <ChevronDown className="h-4 w-4 transition-transform duration-200 group-open:rotate-180" />
          </div>
        </div>
      </summary>

      {deliveryMounted ? (
        <div className={open ? undefined : "hidden"} aria-hidden={!open}>
          <TaskAudioControls novelId={novelId} task={task} chapters={chapters} />
        </div>
      ) : null}
      {open ? (
        <TaskAnnotationsPanel
          novelId={novelId}
          task={task}
          onMessage={onMessage}
          onReprocessed={onReprocessed}
        />
      ) : null}
    </details>
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
  const [expandedChapterIds, setExpandedChapterIds] = useState<Record<string, boolean>>({});

  const terminal = task.status === "succeeded" || task.status === "failed" || task.status === "cancelled";

  async function loadAnnotations() {
    setLoading(true);
    try {
      const response = await getAudiobookAnnotations(novelId, task.id);
      setView(response.data ?? null);
      setExpandedChapterIds({});
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
                  {(() => {
                    const expanded = Boolean(expandedChapterIds[annotation.chapterId]);
                    const visible = expanded
                      ? annotation.segments
                      : annotation.segments.slice(0, 6);
                    return (
                      <>
                        {visible.map((segment) => {
                          const emotion = segment.delivery?.primaryEmotion;
                          const intensity = segment.delivery?.intensity;
                          const styleHint = segment.style?.includes("本句表演")
                            || segment.style?.includes("本句叙述")
                            || segment.designPrompt?.includes("表演指令")
                            ? "已注入表演"
                            : null;
                          return (
                            <div
                              key={`${annotation.chapterId}-${segment.index}`}
                              className="text-xs leading-5 text-muted-foreground"
                            >
                              <span className="font-medium text-foreground">
                                [{segment.speakerLabel}{segment.speakerUnresolved ? " · 未匹配旁白" : ""}/{segment.voice}]
                              </span>
                              {emotion ? (
                                <span className="ml-1 text-violet-700">
                                  {emotion}
                                  {intensity ? `/${intensity}` : ""}
                                </span>
                              ) : null}
                              {styleHint ? (
                                <span className="ml-1 text-emerald-700">{styleHint}</span>
                              ) : null}
                              {" "}
                              {segment.text.length > 80 ? `${segment.text.slice(0, 80)}…` : segment.text}
                            </div>
                          );
                        })}
                        {annotation.segments.length > 6 ? (
                          <button
                            type="button"
                            className="text-xs text-primary underline-offset-2 hover:underline"
                            onClick={() =>
                              setExpandedChapterIds((prev) => ({
                                ...prev,
                                [annotation.chapterId]: !prev[annotation.chapterId],
                              }))
                            }
                          >
                            {expanded
                              ? "收起段列表"
                              : `展开全部 ${annotation.segments.length} 段`}
                          </button>
                        ) : null}
                      </>
                    );
                  })()}
                  {annotation.deliveryStats ? (
                    <div className="pt-1 text-[11px] leading-5 text-muted-foreground">
                      表演：角色 {annotation.deliveryStats.characterDeliveryApplied ?? annotation.deliveryStats.deliveryApplied}
                      /{annotation.deliveryStats.characterSegmentCount}
                      {(annotation.deliveryStats.narratorDeliveryApplied ?? 0) > 0
                        ? ` · 旁白 ${annotation.deliveryStats.narratorDeliveryApplied}/${annotation.deliveryStats.narratorSegmentCount ?? 0}`
                        : ""}
                      {annotation.deliveryStats.deliveryPeeled > 0
                        ? ` · 剥除 ${annotation.deliveryStats.deliveryPeeled}`
                        : ""}{(annotation.deliveryStats.unresolvedSpeakerCount ?? 0) > 0
                        ? ` · 未匹配 ${annotation.deliveryStats.unresolvedSpeakerCount}`
                        : ""}
                      {annotation.contentTruncated ? " · 正文截断 28k" : ""}
                    </div>
                  ) : annotation.contentTruncated ? (
                    <div className="pt-1 text-[11px] leading-5 text-amber-800">正文截断 28k</div>
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
    bootstrapActiveJobId,
  } = props;

  const queryClient = useQueryClient();
  const [scopeMode, setScopeMode] = useState<AudiobookScopeMode>("chapter");
  const [chapterId, setChapterId] = useState(chapters[0]?.id ?? "");
  const [startOrder, setStartOrder] = useState(String(chapters[0]?.order ?? 1));
  const [endOrder, setEndOrder] = useState(String(chapters[chapters.length - 1]?.order ?? 1));
  const [overrideVoice, setOverrideVoice] = useState("");
  const [message, setMessage] = useState("");
  const [voicePlanItems, setVoicePlanItems] = useState<AudiobookVoicePlanItem[]>([]);
  const [expandedPlanDesignIds, setExpandedPlanDesignIds] = useState<Record<string, boolean>>({});
  const [voicePlanOverwrite, setVoicePlanOverwrite] = useState(false);
  /** D8：可选全量试听硬门禁（默认关，仅 voice 硬拦） */
  const [requireReadyPreview, setRequireReadyPreview] = useState(false);
  /** 段级语境表演；默认 characters（成书听感）。固定试听/就绪仍只用角色基线。 */
  const [deliveryStyleMode, setDeliveryStyleMode] = useState<DeliveryStyleMode>("characters");
  /** D18 SoT：就绪看板回传；create 门禁 / 缺音色 banner 优先用它 */
  const [readinessSummary, setReadinessSummary] = useState<AudiobookVoiceReadinessSummary | null>(null);
  const [previewAudioUrl, setPreviewAudioUrl] = useState<string | null>(null);
  const [previewLabel, setPreviewLabel] = useState("");
  const [previewDurationSec, setPreviewDurationSec] = useState<number | null>(null);
  const previewAudioRef = useRef<HTMLAudioElement | null>(null);
  const previewUrlSlotRef = useRef(createObjectUrlSlot());
  const handleReadinessChange = useCallback((summary: AudiobookVoiceReadinessSummary | null) => {
    setReadinessSummary(summary);
  }, []);

  useEffect(() => {
    const slot = previewUrlSlotRef.current;
    return () => {
      slot.clear();
    };
  }, []);

  useEffect(() => {
    if (!previewAudioUrl) {
      return;
    }
    let cancelled = false;
    void tryAutoPlayAudio(previewAudioRef.current).then((result) => {
      if (cancelled) {
        return;
      }
      if (result.durationSec != null) {
        setPreviewDurationSec(result.durationSec);
      }
      if (result.error) {
        setMessage(result.error);
        return;
      }
      if (!result.played) {
        setMessage((prev) => prev || "试听已生成；若未自动播放，请点播放键。");
      }
    });
    return () => {
      cancelled = true;
    };
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

  /**
   * D18 SoT：create 门禁 / 缺音色 banner 优先 readiness.items（含 invalid/clone 文件缺失），
   * readiness 未返回前回退本地 binding.ready。
   */
  const missingVoiceCharacters = useMemo(() => {
    if (readinessSummary?.items?.length) {
      return readinessSummary.items
        .filter((item) => item.voiceBindingStatus !== "configured")
        .map((item) => {
          const character = characters.find((row) => row.id === item.characterId);
          return {
            id: item.characterId,
            name: character?.name ?? item.characterName,
          };
        });
    }
    return characterVoiceRows
      .filter((row) => !row.binding.ready)
      .map((row) => ({ id: row.character.id, name: row.character.name }));
  }, [readinessSummary, characters, characterVoiceRows]);

  const voiceGateBlocked = readinessSummary
    ? !readinessSummary.voiceOk
    : missingVoiceCharacters.length > 0;

  /** requireReadyPreview 开启时，试听未就绪也禁止创建 */
  const previewGateBlocked = Boolean(
    requireReadyPreview
    && readinessSummary
    && readinessSummary.previewOk === false,
  );

  const tasksQuery = useQuery({
    queryKey: queryKeys.novels.audiobookTasks(novelId),
    queryFn: async () => {
      const response = await listAudiobookTasks(novelId);
      return response.data ?? [];
    },
    refetchInterval: (query) => {
      const items = query.state.data ?? [];
      return items.some((item) => item.status === "queued" || item.status === "running") ? 4000 : false;
    },
  });

  const invalidateTasksAndOverview = useCallback(async () => {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: queryKeys.novels.audiobookTasks(novelId) }),
      queryClient.invalidateQueries({ queryKey: queryKeys.novels.audiobookWorkspaceOverviewPrefix }),
    ]);
  }, [novelId, queryClient]);

  const precheckMutation = useMutation({
    mutationFn: async () => {
      const payload = buildCreatePayload();
      const response = await precheckAudiobookTask(novelId, payload);
      return response.data;
    },
    onSuccess: (data) => {
      if (!data) {
        toast.error("预检无结果。");
        setMessage("预检无结果。");
        return;
      }
      const preview = data.preview;
      const previewSoft = preview
        ? `试听 ready ${preview.ready}/缺 ${preview.missing}/过期 ${preview.stale}${
            preview.ok ? "" : "（软提示，默认不拦生成）"
          }`
        : "";
      if (data.ok) {
        const detail = [
          `预检通过：${data.chapterCount} 章，角色音色 ${data.characterVoices.length} 个。`,
          previewSoft,
        ].filter(Boolean).join(" ");
        toast.success("预检通过");
        setMessage(detail);
      } else {
        const missing = data.missingVoices.map((item) => item.characterName).join("、");
        const blocking = data.blockingErrors.join("；");
        const detail = [
          missing ? `缺音色：${missing}` : "",
          blocking || "",
          previewSoft,
        ].filter(Boolean).join(" | ") || "预检未通过。";
        toast.error(missing ? `预检未通过：缺音色` : "预检未通过");
        setMessage(detail);
      }
    },
    onError: (error) => {
      const text = error instanceof Error ? error.message : "预检失败。";
      toast.error(text);
      setMessage(text);
    },
  });

  const createMutation = useMutation({
    mutationFn: async () => {
      const payload = buildCreatePayload();
      const response = await createAudiobookTask(novelId, payload);
      return response.data;
    },
    onSuccess: async (data) => {
      toast.success(data ? `任务已创建：${data.title}` : "任务已创建。");
      setMessage("");
      await invalidateTasksAndOverview();
    },
    onError: (error) => {
      const text = error instanceof Error ? error.message : "创建任务失败。";
      toast.error(text);
      setMessage(text);
    },
  });

  const cancelMutation = useMutation({
    mutationFn: async (taskId: string) => {
      const response = await cancelAudiobookTask(novelId, taskId);
      return response.data;
    },
    onSuccess: async () => {
      toast.success("取消请求已提交。");
      setMessage("");
      await invalidateTasksAndOverview();
    },
    onError: (error) => {
      const text = error instanceof Error ? error.message : "取消失败。";
      toast.error(text);
      setMessage(text);
    },
  });

  const suggestVoiceMutation = useMutation({
    mutationFn: async (mode: "missing" | "rebalance") => {
      const overwriteMode = mode === "rebalance";
      setVoicePlanOverwrite(overwriteMode);
      // 补齐缺失：auto 在有 approved 库时对 lead/cast/narrator 可推荐 clone；
      // 重新差异化：prefer_design 拉高身份音色区分度（不注入库）
      const response = await suggestAudiobookVoicePlan(novelId, {
        onlyMissing: !overwriteMode,
        strategy: overwriteMode ? "prefer_design" : "auto",
      });
      return { data: response.data, overwriteMode };
    },
    onSuccess: ({ data, overwriteMode }) => {
      const items = data?.items ?? [];
      setVoicePlanItems(items);
      setExpandedPlanDesignIds({});
      if (!data || items.length === 0) {
        const text = data?.skipped?.length
          ? `无需规划：${data.skipped.length} 个角色已绑定或已跳过。`
          : "未生成音色规划（可能没有角色）。";
        toast.success(text);
        setMessage(text);
        return;
      }
      const cloneCount = data.summary.cloneCount ?? 0;
      const obsBits = [
        data.summary.slotOverrideCount ? `override ${data.summary.slotOverrideCount}` : "",
        data.summary.softCollisionCount ? `soft ${data.summary.softCollisionCount}` : "",
        data.summary.seedInferredCount ? `seed推断 ${data.summary.seedInferredCount}` : "",
        cloneCount ? `库clone ${cloneCount}` : "",
      ].filter(Boolean);
      const detail = `${overwriteMode ? "重新差异化" : "补齐缺失"}规划 ${items.length} 项：preset ${data.summary.presetCount} / design ${data.summary.designCount} / clone ${cloneCount}${
        obsBits.length ? `（${obsBits.join(" / ")}）` : ""
      }${
        overwriteMode ? "（写入时将覆盖已绑定）" : ""
      }${
        cloneCount > 0 ? "。clone 项将经服务端 bind 写库资产（需已批准）。" : "。"
      }`;
      toast.success(
        `${overwriteMode ? "重新差异化" : "补齐缺失"}规划 ${items.length} 项（clone ${cloneCount}）`,
      );
      setMessage(detail);
    },
    onError: (error) => {
      const text = error instanceof Error ? error.message : "音色规划失败。";
      toast.error(text);
      setMessage(text);
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
          // clone 必须透传 assetId；服务端 bind 禁止客户端 path
          ttsVoiceAssetId: item.ttsVoiceAssetId ?? null,
          speakerAliases: item.speakerAliases,
        })),
      });
      return response.data;
    },
    onSuccess: async (data) => {
      const text = data
        ? `已写入 ${data.applied.length} 个角色音色，跳过 ${data.skipped.length}。角色卡缓存已刷新。`
        : "音色已写入。";
      toast.success(text);
      setMessage("");
      setVoicePlanItems([]);
      setExpandedPlanDesignIds({});
      setVoicePlanOverwrite(false);
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: queryKeys.novels.detail(novelId) }),
        queryClient.invalidateQueries({ queryKey: queryKeys.novels.characters(novelId) }),
        queryClient.invalidateQueries({ queryKey: queryKeys.novels.audiobookWorkspace(novelId) }),
        queryClient.invalidateQueries({ queryKey: queryKeys.novels.audiobookVoiceReadiness(novelId) }),
        queryClient.invalidateQueries({ queryKey: queryKeys.novels.audiobookWorkspaceOverviewPrefix }),
      ]);
    },
    onError: (error) => {
      const text = error instanceof Error ? error.message : "写入音色失败。";
      toast.error(text);
      setMessage(text);
    },
  });

  type VoicePreviewTarget =
    | { kind: "plan"; item: AudiobookVoicePlanItem }
    | { kind: "character"; character: AudiobookPanelCharacter };

  const previewVoiceMutation = useMutation({
    mutationFn: async (target: VoicePreviewTarget) => {
      // 规划草稿：未写入角色卡，ephemeral 预览（禁止带 characterId，否则会固化）
      if (target.kind === "plan") {
        const item = target.item;
        const response = await previewAudiobookVoice(novelId, {
          ttsMode: item.ttsMode,
          ttsVoice: item.ttsVoice,
          ttsStyle: item.ttsStyle,
          ttsDesignPrompt: item.ttsDesignPrompt,
        });
        return {
          mode: "ephemeral" as const,
          label: `${item.characterName} · 规划草稿 · ${item.ttsMode}${
            item.ttsMode === "clone" && item.ttsVoiceAssetId
              ? `·库/${item.ttsVoiceAssetId.slice(0, 10)}`
              : item.ttsVoice
                ? `/${item.ttsVoice}`
                : ""
          }`,
          characterName: item.characterName,
          data: response.data,
        };
      }

      // 已绑定角色：只读角色卡固定试听（生成在就绪看板 / 角色台）
      const character = target.character;
      const binding = resolveCharacterVoiceBinding(character);
      if (!binding.ready) {
        throw new Error(`${character.name} 尚未配置完整音色。请在本台「一键就绪」补齐，或到角色台精修。`);
      }
      const status = character.voicePreviewStatus;
      if (status !== "ready" && status !== "stale") {
        throw new Error(`${character.name} 尚无固定试听。请在本台「生成试听 / 一键就绪」后再播放。`);
      }
      const mediaUrl = await issueCharacterVoicePreviewMediaUrl(novelId, character.id);
      return {
        mode: "asset" as const,
        label: `${character.name} · ${binding.detailLabel}${status === "stale" ? " · 过期" : ""}`,
        characterName: character.name,
        mediaUrl,
        status,
      };
    },
    onSuccess: (result) => {
      if (result.mode === "asset") {
        setPreviewAudioUrl(previewUrlSlotRef.current.set(result.mediaUrl));
        setPreviewDurationSec(null);
        setPreviewLabel(result.label);
        setMessage(
          result.status === "stale"
            ? `正在播放 ${result.characterName} 的旧版试听（配置已变，可在本台重新生成）。`
            : `正在播放 ${result.characterName} 的固定试听。`,
        );
        return;
      }

      const { label, characterName, data } = result;
      if (!data?.audioBase64) {
        setPreviewAudioUrl(previewUrlSlotRef.current.set(null));
        setPreviewDurationSec(null);
        setMessage("规划草稿试听无音频。");
        return;
      }
      try {
        const inspection = inspectWavAudioBase64(data.audioBase64);
        if (!inspection.isWav || inspection.reason) {
          throw new Error(inspection.reason || "试听音频无效。");
        }
        const nextUrl = decodeBase64AudioToObjectUrl(data.audioBase64, "audio/wav");
        setPreviewAudioUrl(previewUrlSlotRef.current.set(nextUrl));
        setPreviewLabel(label);
        setPreviewDurationSec(inspection.durationSec);
        const durationText = inspection.durationSec != null
          ? `约 ${inspection.durationSec.toFixed(1)} 秒`
          : "时长待解析";
        setMessage(`规划草稿试听已生成（${durationText}，未写入角色卡）：${characterName}`);
      } catch (error) {
        setPreviewAudioUrl(previewUrlSlotRef.current.set(null));
        setPreviewDurationSec(null);
        setMessage(error instanceof Error ? error.message : "试听音频解码失败。");
      }
    },
    onError: (error) => {
      setMessage(error instanceof Error ? error.message : "播放试听失败。");
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
      requireReadyPreview: requireReadyPreview || undefined,
      // 始终显式发送，含 off，避免服务端 env 默认覆盖 UI 选择
      deliveryStyleMode,
    };
  }

  return (
    <div className="space-y-8">
      {/* 1. 准备音色与试听 */}
      <section id="ab-prepare" className="scroll-mt-20 space-y-4 rounded-xl border border-border/70 bg-muted/20 p-4">
        <div className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
          <div className="min-w-0 space-y-1">
            <div className="text-sm font-semibold text-foreground">1. 准备音色与试听</div>
            <div className="text-sm leading-6 text-muted-foreground">
              多角色 TTS（CPA → MiMo）。一键补齐音色与固定试听；分簇重规划在下方高级区。
            </div>
          </div>
          <Badge
            className="shrink-0"
            variant={voiceGateBlocked ? "destructive" : "outline"}
          >
            {voiceGateBlocked
              ? `${missingVoiceCharacters.length || readinessSummary?.voiceMissing || "?"} 个角色缺/无效音色`
              : "角色音色齐全"}
          </Badge>
        </div>

        <AudiobookVoiceReadinessSection
          novelId={novelId}
          bootstrapActiveJobId={bootstrapActiveJobId}
          playPending={previewVoiceMutation.isPending}
          onMessage={(text) => {
            // ReadinessSection 终态已 toast；这里只接明细/进度条，空串清栏
            setMessage(text);
          }}
          onReadinessChange={handleReadinessChange}
          onPlayCharacter={({ characterId, characterName, previewStatus }) => {
            const character = characters.find((item) => item.id === characterId);
            if (!character) {
              setMessage(`找不到角色：${characterName}`);
              return;
            }
            previewVoiceMutation.mutate({
              kind: "character",
              character: {
                ...character,
                voicePreviewStatus: previewStatus,
              },
            });
          }}
        />

        <details className="rounded-xl border border-border/70 bg-background/60 p-3">
          <summary className="cursor-pointer list-none text-sm font-medium text-foreground [&::-webkit-details-marker]:hidden">
            <span className="inline-flex items-center gap-2">
              <ChevronDown className="h-4 w-4 text-muted-foreground" />
              音色规划（高级）
            </span>
            <div className="mt-1 pl-6 text-xs font-normal leading-5 text-muted-foreground">
              一键就绪已覆盖缺音色；分簇重规划时展开
            </div>
          </summary>
          <div className="mt-3 space-y-3 border-t border-border/60 pt-3">
            <div className="text-xs leading-5 text-muted-foreground">
              「重新差异化」按分簇规划：主角/主角团 VoiceDesign（拉开槽位），路人/旁白走预置簇；特征只读角色卡、不读正文；写入后请一键就绪/生成试听。规划草稿临时试听不固化角色卡。
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
                variant="outline"
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
                          {item.ttsMode === "clone" && item.ttsVoiceAssetId
                            ? ` · 库/${item.ttsVoiceAssetId.slice(0, 10)}`
                            : item.ttsVoice
                              ? ` · ${item.ttsVoice}`
                              : ""}
                          {` · 重要度 ${item.importance}`}
                        </span>
                      </div>
                      <div className="text-xs leading-5 text-muted-foreground">
                        {item.reason}
                        {item.ttsMode === "design" && item.ttsDesignPrompt ? (
                          <>
                            {" · "}
                            {expandedPlanDesignIds[item.characterId] || item.ttsDesignPrompt.length <= 100
                              ? item.ttsDesignPrompt
                              : `${item.ttsDesignPrompt.slice(0, 100)}…`}
                            {item.ttsDesignPrompt.length > 100 ? (
                              <button
                                type="button"
                                className="ml-1 text-[11px] text-primary underline-offset-2 hover:underline"
                                onClick={() =>
                                  setExpandedPlanDesignIds((prev) => ({
                                    ...prev,
                                    [item.characterId]: !prev[item.characterId],
                                  }))
                                }
                              >
                                {expandedPlanDesignIds[item.characterId] ? "收起" : "展开全文"}
                              </button>
                            ) : null}
                          </>
                        ) : null}
                      </div>
                      {item.ttsMode === "design"
                        && (item.reason.includes("texture:card-dropped")
                          || item.reason.includes("texture:card-partial")
                          || item.reason.includes("slot:override")) ? (
                        <div className="mt-0.5 text-[11px] leading-4 text-amber-800 dark:text-amber-200">
                          {item.reason.includes("texture:card-dropped")
                            ? "卡面声线与分配槽冲突，未能写入 design；试听后可手改角色卡。"
                            : item.reason.includes("texture:card-partial")
                              ? "卡面声线仅部分并入 design（已去掉与槽位对立的词）。"
                              : "槽位已为防撞改写；有卡面声线时会尽量锁定质感维。"}
                        </div>
                      ) : null}
                    </div>
                    <Button
                      size="sm"
                      variant="ghost"
                      disabled={previewVoiceMutation.isPending}
                      onClick={() => previewVoiceMutation.mutate({ kind: "plan", item })}
                    >
                      试听规划草稿
                    </Button>
                  </div>
                ))}
              </div>
            ) : (
              <div className="rounded-lg border border-dashed px-3 py-3 text-xs text-muted-foreground">
                暂无待写入规划。常用路径：上方「一键就绪」；需要人工挑音色时再用本区规划。
              </div>
            )}
            {previewAudioUrl ? (
              <div className="space-y-1">
                <div className="text-xs text-muted-foreground">
                  试听：{previewLabel}
                  {previewDurationSec != null ? ` · ${previewDurationSec.toFixed(1)}s` : ""}
                </div>
                <audio ref={previewAudioRef} controls preload="auto" src={previewAudioUrl} className="w-full" />
              </div>
            ) : null}
          </div>
        </details>
      </section>

      {/* 2. 旁白与生成 */}
      <section id="ab-create" className="scroll-mt-20 space-y-4 rounded-xl border border-border/70 bg-primary/5 p-4 pb-24 lg:pb-4">
        <div className="space-y-1">
          <div className="text-sm font-semibold text-foreground">2. 旁白与生成</div>
          <div className="text-sm leading-6 text-muted-foreground">
            设旁白、范围与表演模式后预检/生成。单章任务也需全书角色音色齐。
          </div>
        </div>

        <div className="grid gap-4 lg:grid-cols-2">
          <div className="space-y-2 rounded-xl border border-border/70 bg-background/60 p-4">
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

          <div className="space-y-2 rounded-xl border border-border/70 bg-background/60 p-4">
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

        {voiceGateBlocked && missingVoiceCharacters.length > 0 ? (
          <div className="rounded-xl border border-amber-200/80 bg-amber-50/70 p-3 text-sm leading-6 text-amber-900">
            以下角色缺音色或配置无效，可用上方「一键就绪」或「音色规划」补齐：
            {" "}
            {missingVoiceCharacters.map((character) => character.name).join("、")}
          </div>
        ) : null}

        <label className="flex cursor-pointer items-start gap-2 rounded-xl border border-border/70 bg-background/60 px-3 py-2 text-xs leading-5 text-muted-foreground">
          <input
            type="checkbox"
            className="mt-0.5"
            checked={requireReadyPreview}
            onChange={(event) => setRequireReadyPreview(event.target.checked)}
          />
          <span>
            <span className="font-medium text-foreground">要求全员固定试听 ready</span>
            （可选硬门禁：create 时若试听有缺/过期则拒绝；默认只硬拦缺音色。
            过期可播旧版，合成任务不强制 ready。）
          </span>
        </label>

        <div className="space-y-2 rounded-xl border border-border/70 bg-background/60 px-3 py-2">
          <div className="text-xs font-medium text-foreground">段级语境表演</div>
          <div className="text-xs leading-5 text-muted-foreground">
            默认「角色对白表演」：成书对白会带语境指令。固定试听/一键就绪只用角色基线声线，
            <span className="font-medium text-foreground">不等于成书完整听感</span>
            。关表演或改模式后需「重标+合成」才生效。
          </div>
          <SelectControl
            className="w-full rounded-md border bg-background p-2 text-sm"
            value={deliveryStyleMode}
            onChange={(event) => setDeliveryStyleMode(event.target.value as DeliveryStyleMode)}
          >
            <option value="characters">角色对白表演（推荐）</option>
            <option value="off">关闭（仅身份基线，像念字）</option>
            <option value="all">角色 + 旁白轻量叙述</option>
          </SelectControl>
        </div>

        <div className="hidden flex-wrap gap-2 lg:flex">
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
              || voiceGateBlocked
              || previewGateBlocked
            }
            onClick={() => createMutation.mutate()}
          >
            {createMutation.isPending ? "创建中..." : "生成有声书"}
          </Button>
        </div>

        {message ? (
          <div className="rounded-xl border border-border/70 bg-background/80 px-4 py-3 text-sm leading-6 text-muted-foreground">
            {message}
          </div>
        ) : null}

        {/* 移动 fixed 生成条：与 MobileSiteShell 底栏同款 offset；桌面不渲染 */}
        <div
          className="fixed inset-x-0 z-30 border-t border-border/70 bg-background/95 px-3 py-2 shadow-lg backdrop-blur supports-[backdrop-filter]:bg-background/90 lg:hidden"
          style={{ bottom: "calc(4.25rem + env(safe-area-inset-bottom))" }}
        >
          <div className="mx-auto flex max-w-4xl flex-wrap items-center gap-2">
            <Badge
              className="shrink-0 text-[10px]"
              variant={voiceGateBlocked ? "destructive" : previewGateBlocked ? "secondary" : "outline"}
            >
              {voiceGateBlocked
                ? "缺音色"
                : previewGateBlocked
                  ? "试听未齐"
                  : "可生成"}
            </Badge>
            <Button
              size="sm"
              variant="outline"
              className="flex-1"
              disabled={precheckMutation.isPending || sortedChapters.length === 0}
              onClick={() => precheckMutation.mutate()}
            >
              {precheckMutation.isPending ? "预检中..." : "预检"}
            </Button>
            <Button
              size="sm"
              className="flex-1"
              disabled={
                createMutation.isPending
                || sortedChapters.length === 0
                || voiceGateBlocked
                || previewGateBlocked
              }
              onClick={() => createMutation.mutate()}
            >
              {createMutation.isPending ? "创建中..." : "生成有声书"}
            </Button>
          </div>
        </div>
      </section>

      {/* 3. 任务与交付 */}
      <section id="ab-tasks" className="scroll-mt-20 space-y-3 rounded-xl border border-border/70 bg-background p-4 pb-28 lg:pb-4">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="text-sm font-semibold text-foreground">3. 任务与交付</div>
          {(tasksQuery.data ?? []).length > 0 ? (
            <div className="text-xs text-muted-foreground">
              仅最新运行中一条默认展开；无运行中时展开最新一条
            </div>
          ) : null}
        </div>
        {(tasksQuery.data ?? []).length === 0 ? (
          <div className="rounded-xl border border-dashed border-border/70 bg-muted/10 p-4 text-sm leading-6 text-muted-foreground">
            暂无有声书任务。完成音色配置后，可先预检再生成。
          </div>
        ) : (
          <div className="space-y-2">
            {(tasksQuery.data ?? []).slice(0, 8).map((task, index, tasks) => (
              <RecentAudiobookTaskCard
                key={task.id}
                novelId={novelId}
                task={task}
                chapters={sortedChapters}
                defaultOpen={resolveTaskCardDefaultOpen(tasks, task.id, index)}
                cancelPending={cancelMutation.isPending}
                onCancel={(taskId) => cancelMutation.mutate(taskId)}
                onMessage={setMessage}
                onReprocessed={() => {
                  void Promise.all([
                    queryClient.invalidateQueries({
                      queryKey: queryKeys.novels.audiobookTasks(novelId),
                    }),
                    queryClient.invalidateQueries({
                      queryKey: queryKeys.novels.audiobookWorkspaceOverviewPrefix,
                    }),
                  ]);
                }}
              />
            ))}
          </div>
        )}
      </section>
    </div>
  );
}
