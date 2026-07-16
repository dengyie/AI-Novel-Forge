import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type {
  AudiobookVoiceReadinessJob,
  AudiobookVoiceReadinessSummary,
  CharacterVoiceReadinessAction,
  CharacterVoiceReadinessItem,
  CharacterVoicePreviewStatus,
} from "@ai-novel/shared/types/audiobook";
import {
  cancelAudiobookVoiceReadinessJob,
  generateCharacterVoicePreview,
  getAudiobookVoiceReadiness,
  getAudiobookVoiceReadinessJob,
  parseReadinessJobActiveError,
  prepareAudiobookVoiceReadiness,
} from "@/api/novel/audiobook";
import { queryKeys } from "@/api/queryKeys";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { resolveCharacterVoicePreviewBadge } from "./characterAssetWorkspace.helpers";

const JOB_STORAGE_PREFIX = "ainovel.voiceReadinessJob.";

function jobStorageKey(novelId: string): string {
  return `${JOB_STORAGE_PREFIX}${novelId}`;
}

function readStoredJobId(novelId: string): string | null {
  try {
    const value = sessionStorage.getItem(jobStorageKey(novelId))?.trim();
    return value || null;
  } catch {
    return null;
  }
}

function writeStoredJobId(novelId: string, jobId: string | null): void {
  try {
    if (!jobId) {
      sessionStorage.removeItem(jobStorageKey(novelId));
      return;
    }
    sessionStorage.setItem(jobStorageKey(novelId), jobId);
  } catch {
    // ignore private mode
  }
}

function actionLabel(action: CharacterVoiceReadinessAction): string {
  if (action === "apply_plan") return "补音色";
  if (action === "generate_preview") return "生成试听";
  if (action === "manual_clone") return "需上传 clone";
  if (action === "fix_invalid") return "修复配置";
  return "就绪";
}

function actionVariant(
  action: CharacterVoiceReadinessAction,
): "default" | "secondary" | "destructive" | "outline" {
  if (action === "none") return "outline";
  if (action === "manual_clone" || action === "fix_invalid") return "destructive";
  if (action === "generate_preview") return "secondary";
  return "default";
}

function jobStatusLabel(status: AudiobookVoiceReadinessJob["status"]): string {
  if (status === "queued") return "排队中";
  if (status === "running") return "运行中";
  if (status === "succeeded") return "已完成";
  if (status === "failed") return "失败";
  return "已取消";
}

function isActiveJob(job: AudiobookVoiceReadinessJob | null | undefined): boolean {
  return Boolean(job && (job.status === "queued" || job.status === "running"));
}

export type AudiobookVoiceReadinessSectionProps = {
  novelId: string;
  /** 用于播放试听的回调（面板共享 audio 槽） */
  onPlayCharacter: (input: {
    characterId: string;
    characterName: string;
    previewStatus: CharacterVoicePreviewStatus;
  }) => void;
  playPending?: boolean;
  onMessage?: (message: string) => void;
  /**
   * workspace bootstrap 注入的 active job（刷新后服务端仍在跑时优先于空 sessionStorage）。
   * 仅作 seed，不覆盖用户本地已跟踪的 jobId。
   */
  bootstrapActiveJobId?: string | null;
  /** 父面板消费 readiness 的 voice 门禁 / 徽章（D18 SoT） */
  onReadinessChange?: (summary: AudiobookVoiceReadinessSummary | null) => void;
};

/**
 * 有声书工作台就绪看板（D18 SoT = readiness.items）。
 * 一键就绪 / job 轮询 / 单角色固化试听；不负责 suggest 规划草稿区。
 */
export default function AudiobookVoiceReadinessSection(props: AudiobookVoiceReadinessSectionProps) {
  const {
    novelId,
    onPlayCharacter,
    playPending,
    onMessage,
    bootstrapActiveJobId,
    onReadinessChange,
  } = props;
  const queryClient = useQueryClient();
  const [activeJobId, setActiveJobId] = useState<string | null>(() => {
    const stored = readStoredJobId(novelId);
    return stored || bootstrapActiveJobId?.trim() || null;
  });

  useEffect(() => {
    const stored = readStoredJobId(novelId);
    if (stored) {
      setActiveJobId(stored);
      return;
    }
    const boot = bootstrapActiveJobId?.trim() || null;
    if (boot) {
      writeStoredJobId(novelId, boot);
      setActiveJobId(boot);
      return;
    }
    setActiveJobId(null);
  }, [novelId, bootstrapActiveJobId]);

  const readinessQuery = useQuery({
    queryKey: queryKeys.novels.audiobookVoiceReadiness(novelId),
    queryFn: async () => {
      const response = await getAudiobookVoiceReadiness(novelId);
      if (!response.data) {
        throw new Error(response.error || response.message || "就绪评估为空。");
      }
      return response.data;
    },
    enabled: Boolean(novelId),
    staleTime: 15_000,
  });

  useEffect(() => {
    onReadinessChange?.(readinessQuery.data ?? null);
  }, [readinessQuery.data, onReadinessChange]);

  const jobQuery = useQuery({
    queryKey: queryKeys.novels.audiobookVoiceReadinessJob(novelId, activeJobId ?? ""),
    queryFn: async () => {
      if (!activeJobId) {
        return null;
      }
      const response = await getAudiobookVoiceReadinessJob(novelId, activeJobId);
      return response.data ?? null;
    },
    enabled: Boolean(novelId && activeJobId),
    refetchInterval: (query) => {
      const job = query.state.data;
      if (!job) {
        return false;
      }
      return job.status === "queued" || job.status === "running" ? 1500 : false;
    },
    retry: false,
  });

  useEffect(() => {
    if (!activeJobId) {
      return;
    }
    if (jobQuery.isError) {
      writeStoredJobId(novelId, null);
      setActiveJobId(null);
      onMessage?.("就绪任务已丢失（可能服务重启），请重新一键就绪。");
      return;
    }
    const job = jobQuery.data;
    if (!job) {
      return;
    }
    if (isActiveJob(job)) {
      writeStoredJobId(novelId, job.id);
      return;
    }
    // 终态：清 storage、刷 readiness/workspace
    writeStoredJobId(novelId, null);
    void Promise.all([
      queryClient.invalidateQueries({ queryKey: queryKeys.novels.audiobookVoiceReadiness(novelId) }),
      queryClient.invalidateQueries({ queryKey: queryKeys.novels.audiobookWorkspace(novelId) }),
      queryClient.invalidateQueries({ queryKey: queryKeys.novels.characters(novelId) }),
      queryClient.invalidateQueries({ queryKey: queryKeys.novels.detail(novelId) }),
    ]);
    const summary = job.summary;
    const tail = summary
      ? `写入音色 ${summary.appliedVoice} · 生成试听 ${summary.generatedPreview} · 跳过 ${summary.skipped} · 失败 ${summary.failed}`
      : "";
    if (job.status === "succeeded") {
      onMessage?.(`一键就绪完成。${tail}`);
    } else if (job.status === "cancelled") {
      onMessage?.(`一键就绪已取消。${tail}`);
    } else if (job.status === "failed") {
      onMessage?.(job.lastError ? `一键就绪失败：${job.lastError}` : `一键就绪失败。${tail}`);
    }
    setActiveJobId(null);
  }, [
    activeJobId,
    jobQuery.data,
    jobQuery.isError,
    novelId,
    onMessage,
    queryClient,
  ]);

  const prepareMutation = useMutation({
    mutationFn: async () => {
      const response = await prepareAudiobookVoiceReadiness(novelId, {
        fillMissingVoice: true,
        generatePreview: true,
        regenerateStale: true,
        planStrategy: "auto",
      });
      return response.data?.job ?? null;
    },
    onSuccess: (job) => {
      if (!job) {
        onMessage?.("就绪任务创建无返回。");
        return;
      }
      const active = job.status === "queued" || job.status === "running";
      if (active) {
        writeStoredJobId(novelId, job.id);
        setActiveJobId(job.id);
        void queryClient.invalidateQueries({
          queryKey: queryKeys.novels.audiobookVoiceReadinessJob(novelId, job.id),
        });
        onMessage?.("一键就绪已启动，正在串行补齐音色与试听…");
        return;
      }
      // 即时终态：不进 job 轮询，直接刷看板
      writeStoredJobId(novelId, null);
      void Promise.all([
        queryClient.invalidateQueries({ queryKey: queryKeys.novels.audiobookVoiceReadiness(novelId) }),
        queryClient.invalidateQueries({ queryKey: queryKeys.novels.audiobookWorkspace(novelId) }),
        queryClient.invalidateQueries({ queryKey: queryKeys.novels.characters(novelId) }),
      ]);
      const summary = job.summary;
      const tail = summary
        ? `写入音色 ${summary.appliedVoice} · 生成试听 ${summary.generatedPreview} · 跳过 ${summary.skipped} · 失败 ${summary.failed}`
        : "";
      if (job.status === "succeeded") {
        onMessage?.(tail ? `一键就绪完成。${tail}` : "当前无需操作，就绪任务已即时完成。");
      } else if (job.status === "failed") {
        onMessage?.(job.lastError ? `一键就绪失败：${job.lastError}` : `一键就绪失败。${tail}`);
      } else {
        onMessage?.(`一键就绪已结束（${job.status}）。${tail}`);
      }
    },
    onError: (error) => {
      const active = parseReadinessJobActiveError(error);
      if (active?.activeJobId) {
        writeStoredJobId(novelId, active.activeJobId);
        setActiveJobId(active.activeJobId);
        onMessage?.("已有进行中的就绪任务，改为跟踪该任务。");
        return;
      }
      onMessage?.(error instanceof Error ? error.message : "启动一键就绪失败。");
    },
  });

  const cancelMutation = useMutation({
    mutationFn: async (jobId: string) => {
      const response = await cancelAudiobookVoiceReadinessJob(novelId, jobId);
      return response.data;
    },
    onSuccess: (job) => {
      if (job) {
        void queryClient.setQueryData(
          queryKeys.novels.audiobookVoiceReadinessJob(novelId, job.id),
          job,
        );
      }
      onMessage?.("已请求取消就绪任务。");
    },
    onError: (error) => {
      onMessage?.(error instanceof Error ? error.message : "取消就绪任务失败。");
    },
  });

  const generateOneMutation = useMutation({
    mutationFn: async (item: CharacterVoiceReadinessItem) => {
      if (item.voiceBindingStatus !== "configured") {
        throw new Error(`${item.characterName} 音色未就绪，无法生成试听。`);
      }
      const response = await generateCharacterVoicePreview(novelId, item.characterId);
      return { item, data: response.data };
    },
    onSuccess: async ({ item }) => {
      onMessage?.(`已生成 ${item.characterName} 的固定试听。`);
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: queryKeys.novels.audiobookVoiceReadiness(novelId) }),
        queryClient.invalidateQueries({ queryKey: queryKeys.novels.audiobookWorkspace(novelId) }),
        queryClient.invalidateQueries({
          queryKey: queryKeys.novels.characterVoicePreview(novelId, item.characterId),
        }),
      ]);
    },
    onError: (error) => {
      onMessage?.(error instanceof Error ? error.message : "生成试听失败。");
    },
  });

  const summary: AudiobookVoiceReadinessSummary | undefined = readinessQuery.data;
  const job = jobQuery.data;
  const jobActive = isActiveJob(job) || (Boolean(activeJobId) && !jobQuery.isError && jobQuery.isFetching && !job);
  const items = summary?.items ?? [];

  const attention = useMemo(
    () => items.filter((item) => item.action !== "none").slice(0, 8),
    [items],
  );

  function handlePrepareClick(): void {
    const ok = window.confirm(
      [
        "将为缺失音色自动规划写入，并为缺失/过期试听串行生成固定音频（可能较久）。",
        "已就绪角色跳过。clone 需人工上传参考音频的角色会跳过。",
        "与正在运行的全书合成任务可能争用 TTS 配额。",
        "是否继续？",
      ].join("\n"),
    );
    if (!ok) {
      return;
    }
    prepareMutation.mutate();
  }

  return (
    <div className="space-y-3 rounded-xl border border-border/70 bg-muted/20 p-4">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0 space-y-1">
          <div className="text-sm font-medium text-foreground">音色与试听就绪</div>
          <div className="text-xs leading-5 text-muted-foreground">
            固定试听可在本台一键/单角色生成并写入角色卡；角色台可精修单卡。
            播放只读磁盘，不触发 TTS。
          </div>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button
            size="sm"
            disabled={
              prepareMutation.isPending
              || jobActive
              || readinessQuery.isLoading
            }
            onClick={handlePrepareClick}
          >
            {prepareMutation.isPending || jobActive ? "就绪中..." : "一键就绪"}
          </Button>
          {activeJobId && jobActive ? (
            <Button
              size="sm"
              variant="outline"
              disabled={cancelMutation.isPending}
              onClick={() => cancelMutation.mutate(activeJobId)}
            >
              {cancelMutation.isPending ? "取消中..." : "取消就绪"}
            </Button>
          ) : null}
          <Button
            size="sm"
            variant="ghost"
            disabled={readinessQuery.isFetching}
            onClick={() => {
              void readinessQuery.refetch();
            }}
          >
            刷新
          </Button>
        </div>
      </div>

      {summary ? (
        <div className="flex flex-wrap gap-2 text-xs">
          <Badge variant={summary.voiceOk ? "outline" : "destructive"}>
            音色 {summary.voiceConfigured}/{summary.characterTotal}
            {summary.voiceMissing ? ` · 缺 ${summary.voiceMissing}` : ""}
            {summary.voiceInvalid ? ` · 无效 ${summary.voiceInvalid}` : ""}
          </Badge>
          <Badge variant={summary.previewOk ? "outline" : "secondary"}>
            试听 ready {summary.previewReady}
            {summary.previewStale ? ` · 过期 ${summary.previewStale}` : ""}
            {summary.previewMissing ? ` · 缺 ${summary.previewMissing}` : ""}
          </Badge>
          <Badge variant={summary.narrator.valid ? "outline" : "destructive"}>
            旁白 {summary.narrator.valid ? summary.narrator.voice : "无效"}
          </Badge>
          <Badge variant={summary.readyForWorkbench ? "outline" : "secondary"}>
            {summary.readyForWorkbench ? "工作台就绪" : "尚有缺口"}
          </Badge>
        </div>
      ) : readinessQuery.isLoading ? (
        <div className="text-xs text-muted-foreground">正在评估就绪状态…</div>
      ) : readinessQuery.isError ? (
        <div className="text-xs text-destructive">
          就绪评估失败：
          {readinessQuery.error instanceof Error
            ? readinessQuery.error.message
            : "未知错误"}
        </div>
      ) : null}

      {job && isActiveJob(job) ? (
        <div className="rounded-lg border border-border/60 bg-background px-3 py-2 text-xs leading-5 text-muted-foreground">
          <div className="flex flex-wrap items-center gap-2">
            <Badge variant="secondary">{jobStatusLabel(job.status)}</Badge>
            <span>{job.progress}%</span>
            {job.currentLabel ? <span>· {job.currentLabel}</span> : null}
          </div>
          {job.currentCharacterName ? (
            <div className="mt-1">当前角色：{job.currentCharacterName}</div>
          ) : null}
        </div>
      ) : null}

      {attention.length > 0 && !jobActive ? (
        <div className="text-[11px] leading-4 text-muted-foreground">
          待处理：
          {attention
            .map((item) => `${item.characterName}（${actionLabel(item.action)}）`)
            .join("、")}
          {items.filter((item) => item.action !== "none").length > attention.length
            ? "…"
            : ""}
        </div>
      ) : null}

      {items.length > 0 ? (
        <div className="max-h-64 space-y-1 overflow-y-auto rounded-lg border border-border/60 bg-background p-2">
          <div className="px-2 py-1 text-xs font-medium text-muted-foreground">
            角色就绪表（{items.length}）
          </div>
          {items.map((item) => {
            const previewBadge = resolveCharacterVoicePreviewBadge(item.previewStatus);
            const canPlay = item.previewStatus === "ready" || item.previewStatus === "stale";
            const canGenerate = item.voiceBindingStatus === "configured";
            const generating =
              generateOneMutation.isPending
              && generateOneMutation.variables?.characterId === item.characterId;
            return (
              <div
                key={item.characterId}
                className="flex flex-wrap items-center justify-between gap-2 rounded-md px-2 py-1.5 text-sm"
              >
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-medium text-foreground">{item.characterName}</span>
                    <Badge
                      variant={
                        item.voiceBindingStatus === "configured"
                          ? "outline"
                          : "destructive"
                      }
                    >
                      {item.voiceDetailLabel}
                    </Badge>
                    <Badge
                      variant={
                        previewBadge.tone === "ready"
                          ? "outline"
                          : previewBadge.tone === "stale"
                            ? "secondary"
                            : "destructive"
                      }
                    >
                      {previewBadge.label}
                    </Badge>
                    <Badge variant={actionVariant(item.action)}>
                      {actionLabel(item.action)}
                    </Badge>
                  </div>
                  {item.previewStatus === "stale" ? (
                    <div className="text-[11px] leading-4 text-amber-800/90">
                      配置已变，可播旧版；建议重新生成。
                    </div>
                  ) : null}
                  {item.reason && item.voiceBindingStatus !== "configured" ? (
                    <div className="text-[11px] leading-4 text-muted-foreground">
                      {item.reason}
                    </div>
                  ) : null}
                </div>
                <div className="flex flex-wrap gap-1">
                  <Button
                    size="sm"
                    variant="ghost"
                    disabled={playPending || !canPlay || jobActive}
                    title={
                      canPlay
                        ? "播放角色卡固定试听"
                        : "尚无固定试听，请先生成"
                    }
                    onClick={() =>
                      onPlayCharacter({
                        characterId: item.characterId,
                        characterName: item.characterName,
                        previewStatus: item.previewStatus,
                      })}
                  >
                    播放
                  </Button>
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={
                      !canGenerate
                      || generating
                      || jobActive
                      || generateOneMutation.isPending
                    }
                    onClick={() => generateOneMutation.mutate(item)}
                  >
                    {generating ? "生成中..." : "生成试听"}
                  </Button>
                </div>
              </div>
            );
          })}
        </div>
      ) : summary && summary.characterTotal === 0 ? (
        <div className="rounded-lg border border-dashed px-3 py-4 text-xs text-muted-foreground">
          暂无角色卡；对白将仅使用旁白音色。可先在人物卡建角。
        </div>
      ) : null}
    </div>
  );
}
