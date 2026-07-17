import { useEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { ApiResponse } from "@ai-novel/shared/types/api";
import {
  DEFAULT_AUDIOBOOK_NARRATOR_STYLE,
  MIMO_TTS_VOICE_CATALOG,
  type CharacterVoicePreviewAsset,
  type CharacterVoicePreviewCandidate,
  type CharacterVoicePreviewGenerateResult,
  type CharacterVoicePreviewStatus,
  type VoiceAsset,
} from "@ai-novel/shared/types/audiobook";
import {
  adoptCharacterVoicePreviewAsClone,
  adoptCharacterVoicePreviewCandidate,
  bindVoiceLibraryAsset,
  generateCharacterVoicePreview,
  getCharacterVoicePreview,
  issueCharacterVoicePreviewMediaUrl,
  listVoiceLibrary,
  rewriteCharacterVoiceDesign,
} from "@/api/novel/audiobook";
import type { NovelDetailResponse } from "@/api/novel/shared";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  createObjectUrlSlot,
  decodeBase64AudioToObjectUrl,
  inspectWavAudioBase64,
  resolveLocalAudioSrc,
  tryAutoPlayAudio,
} from "@/lib/audiobookVoiceAudio";
import { queryKeys } from "@/api/queryKeys";
import {
  CHARACTER_VOICE_MODE_OPTIONS,
  buildCharacterVoiceModeSwitchPatches,
  canGenerateCharacterVoicePreview,
  findMimoVoiceCatalogItem,
  isCharacterVoiceFormDirty,
  resolveCharacterVoiceBinding,
  resolveCharacterVoiceMode,
  resolveCharacterVoicePreviewBadge,
  type CharacterVoiceFormSlice,
  type CharacterVoiceMode,
} from "./characterAssetWorkspace.helpers";

export type CharacterVoiceEditorForm = {
  ttsMode: "preset" | "design" | "clone" | "";
  ttsVoice: string;
  ttsStyle: string;
  ttsDesignPrompt: string;
  ttsRefAudioPath: string;
  ttsRefAudioBase64: string;
  ttsVoiceAssetId: string;
  ttsSpeakerAliases: string;
};

export type CharacterVoiceEditorField = keyof CharacterVoiceEditorForm;

interface CharacterVoiceEditorProps {
  novelId: string;
  characterId: string;
  characterName: string;
  /** 角色卡 role/castRole：用于 lead 引导 Design→Clone（extra 不误导） */
  castRole?: string | null;
  role?: string | null;
  form: CharacterVoiceEditorForm;
  saved?: CharacterVoiceFormSlice | null;
  onChange: (field: CharacterVoiceEditorField, value: string) => void;
  /** 音色改完后就近保存；不传则仍依赖下方「保存角色资产」。 */
  onSave?: () => void;
  isSaving?: boolean;
}

const ZH_PRESETS = MIMO_TTS_VOICE_CATALOG.filter((item) => item.locale === "zh");
const EN_PRESETS = MIMO_TTS_VOICE_CATALOG.filter((item) => item.locale === "en");

function modeButtonClass(active: boolean): string {
  return active
    ? "border-primary bg-primary/10 text-foreground shadow-sm"
    : "border-border/70 bg-background text-muted-foreground hover:border-primary/40 hover:bg-muted/30";
}

function presetChipClass(active: boolean): string {
  return active
    ? "border-primary bg-primary/15 text-foreground shadow-sm"
    : "border-border/70 bg-background hover:border-primary/40 hover:bg-muted/25";
}

function PresetVoiceGrid(props: {
  items: typeof MIMO_TTS_VOICE_CATALOG;
  selectedVoice: string;
  onSelect: (voiceId: string) => void;
  showDescription: boolean;
}) {
  const { items, selectedVoice, onSelect, showDescription } = props;
  return (
    <div className="grid gap-2 sm:grid-cols-2">
      {items.map((item) => {
        const active = selectedVoice === item.id;
        return (
          <button
            key={item.id}
            type="button"
            className={`rounded-lg border px-3 py-2 text-left transition ${presetChipClass(active)}`}
            onClick={() => onSelect(item.id)}
          >
            <div className="flex items-center gap-2">
              <span className="text-sm font-medium">{item.label}</span>
              {active ? <Badge variant="secondary">已选</Badge> : null}
            </div>
            {showDescription && item.description ? (
              <div className="mt-0.5 text-[11px] text-muted-foreground">{item.description}</div>
            ) : null}
          </button>
        );
      })}
    </div>
  );
}

function statusBadgeVariant(status: CharacterVoicePreviewStatus | null | undefined): "outline" | "secondary" | "destructive" {
  if (status === "ready") {
    return "outline";
  }
  if (status === "stale") {
    return "secondary";
  }
  return "destructive";
}

export default function CharacterVoiceEditor(props: CharacterVoiceEditorProps) {
  const {
    novelId,
    characterId,
    characterName,
    castRole,
    role,
    form,
    saved,
    onChange,
    onSave,
    isSaving = false,
  } = props;

  const queryClient = useQueryClient();
  const formVoice = useMemo(
    () => resolveCharacterVoiceBinding(form),
    [form.ttsMode, form.ttsVoice, form.ttsDesignPrompt, form.ttsRefAudioPath, form.ttsVoiceAssetId],
  );
  const savedVoice = useMemo(() => resolveCharacterVoiceBinding(saved), [saved]);
  const dirty = useMemo(() => isCharacterVoiceFormDirty(form, saved), [form, saved]);
  const generateGate = useMemo(
    () => canGenerateCharacterVoicePreview({ form, saved }),
    [form, saved],
  );
  const mode = resolveCharacterVoiceMode(form.ttsMode);
  const selectedPreset = findMimoVoiceCatalogItem(form.ttsVoice);
  const hasLocalCloneDraft = Boolean(form.ttsRefAudioBase64?.trim());
  const localCloneSrc = hasLocalCloneDraft
    ? resolveLocalAudioSrc(form.ttsRefAudioBase64)
    : "";
  const boundAssetId = form.ttsVoiceAssetId?.trim() || "";
  const LIBRARY_PAGE = 50;
  const [libraryKeyword, setLibraryKeyword] = useState("");
  const [debouncedLibraryKeyword, setDebouncedLibraryKeyword] = useState("");
  const [libraryPages, setLibraryPages] = useState(1);
  const [rewriteNotes, setRewriteNotes] = useState("");
  const [rewriteCandidate, setRewriteCandidate] = useState<string | null>(null);
  const [rewriteMeta, setRewriteMeta] = useState<string>("");

  useEffect(() => {
    const timer = window.setTimeout(() => {
      setDebouncedLibraryKeyword(libraryKeyword.trim());
      setLibraryPages(1);
    }, 300);
    return () => window.clearTimeout(timer);
  }, [libraryKeyword]);

  const libraryLimit = Math.min(500, LIBRARY_PAGE * libraryPages);
  const libraryQueryKey = queryKeys.novels.voiceLibrary(
    `approved-clone_ref:q=${debouncedLibraryKeyword}:limit=${libraryLimit}`,
  );

  const libraryQuery = useQuery({
    queryKey: libraryQueryKey,
    queryFn: async () => {
      const response = await listVoiceLibrary({
        status: "approved",
        kind: "clone_ref",
        q: debouncedLibraryKeyword || undefined,
        limit: libraryLimit,
        offset: 0,
      });
      return {
        items: (response.data?.items ?? []) as VoiceAsset[],
        total: response.data?.total ?? 0,
      };
    },
    enabled: Boolean(novelId && characterId && mode === "clone"),
    staleTime: 60_000,
  });
  const libraryItems = libraryQuery.data?.items ?? [];
  const libraryTotal = libraryQuery.data?.total ?? libraryItems.length;
  const selectedLibraryAsset = useMemo(
    () => libraryItems.find((item) => item.id === boundAssetId) ?? null,
    [libraryItems, boundAssetId],
  );

  const [previewAudioUrl, setPreviewAudioUrl] = useState<string | null>(null);
  const [previewLabel, setPreviewLabel] = useState("");
  const [previewMessage, setPreviewMessage] = useState("");
  const [previewDurationSec, setPreviewDurationSec] = useState<number | null>(null);
  const [candidates, setCandidates] = useState<CharacterVoicePreviewCandidate[]>([]);
  const [suggestedCandidateId, setSuggestedCandidateId] = useState<string | null>(null);
  /** 多抽后尚未写入正式 preview 的会话态；采用任一候选后清空，避免误锁旧 formal。 */
  const [pendingMultiDraw, setPendingMultiDraw] = useState(false);
  const previewAudioRef = useRef<HTMLAudioElement | null>(null);
  const previewUrlSlotRef = useRef(createObjectUrlSlot());

  const previewQuery = useQuery({
    queryKey: queryKeys.novels.characterVoicePreview(novelId, characterId),
    queryFn: async () => {
      const response = await getCharacterVoicePreview(novelId, characterId);
      return response.data as CharacterVoicePreviewAsset;
    },
    enabled: Boolean(novelId && characterId),
    staleTime: 15_000,
  });

  const assetStatus = previewQuery.data?.status ?? null;
  const previewBadge = resolveCharacterVoicePreviewBadge(assetStatus);
  const canPlay = assetStatus === "ready" || assetStatus === "stale";

  useEffect(() => {
    const slot = previewUrlSlotRef.current;
    return () => {
      slot.clear();
    };
  }, []);

  useEffect(() => {
    previewUrlSlotRef.current.clear();
    setPreviewAudioUrl(null);
    setPreviewLabel("");
    setPreviewMessage("");
    setPreviewDurationSec(null);
    setCandidates([]);
    setSuggestedCandidateId(null);
    setPendingMultiDraw(false);
  }, [characterId]);

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
        setPreviewMessage(result.error);
        return;
      }
      if (!result.played) {
        setPreviewMessage("试听已就绪；若未自动播放，请点播放键。");
      }
    });
    return () => {
      cancelled = true;
    };
  }, [previewAudioUrl]);

  async function playFromAsset(asset?: CharacterVoicePreviewAsset | null) {
    if (asset?.audioBase64) {
      const inspection = inspectWavAudioBase64(asset.audioBase64);
      if (!inspection.isWav || inspection.reason) {
        throw new Error(inspection.reason || "试听音频无效。");
      }
      const nextUrl = decodeBase64AudioToObjectUrl(asset.audioBase64, "audio/wav");
      setPreviewAudioUrl(previewUrlSlotRef.current.set(nextUrl));
      setPreviewDurationSec(inspection.durationSec);
      setPreviewLabel(savedVoice.detailLabel || formVoice.detailLabel);
      return;
    }
    const mediaUrl = await issueCharacterVoicePreviewMediaUrl(novelId, characterId);
    setPreviewAudioUrl(previewUrlSlotRef.current.set(mediaUrl));
    setPreviewDurationSec(null);
    setPreviewLabel(savedVoice.detailLabel || formVoice.detailLabel);
  }

  const generateMutation = useMutation({
    mutationFn: async () => {
      const gate = canGenerateCharacterVoicePreview({ form, saved });
      if (!gate.ok) {
        throw new Error(gate.reason);
      }
      const response = await generateCharacterVoicePreview(novelId, characterId, {
        candidates: 3,
        autoAdoptWinner: false,
      });
      return response.data as CharacterVoicePreviewGenerateResult;
    },
    onSuccess: async (data) => {
      setCandidates(data.candidates ?? []);
      setSuggestedCandidateId(data.suggestedCandidateId ?? null);
      const multiPending =
        !data.adopted
        && Array.isArray(data.candidates)
        && data.candidates.length > 1;
      setPendingMultiDraw(multiPending);
      if (data.adopted) {
        queryClient.setQueryData(
          queryKeys.novels.characterVoicePreview(novelId, characterId),
          data.adopted,
        );
      }
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: queryKeys.novels.detail(novelId) }),
        queryClient.invalidateQueries({ queryKey: queryKeys.novels.characters(novelId) }),
        queryClient.invalidateQueries({ queryKey: queryKeys.novels.audiobookWorkspace(novelId) }),
        queryClient.invalidateQueries({
          queryKey: queryKeys.novels.characterVoicePreview(novelId, characterId),
        }),
      ]);
      try {
        const playTarget = data.adopted
          ?? (data.candidates[0]
            ? {
                characterId: data.characterId,
                characterName: data.characterName,
                status: "ready" as const,
                ttsMode: data.ttsMode,
                voice: data.voice ?? null,
                sampleText: data.sampleText,
                fingerprint: null,
                currentFingerprint: "",
                generatedAt: null,
                audioUrl: data.candidates[0].audioUrl,
                audioBase64: data.candidates[0].audioBase64 ?? null,
                format: "wav" as const,
              }
            : null);
        if (playTarget) {
          await playFromAsset(playTarget);
        }
        const durationText =
          data.candidates[0]?.durationMs
            ? `约 ${(data.candidates[0].durationMs / 1000).toFixed(1)} 秒`
            : "时长待解析";
        setPreviewMessage(
          data.adopted
            ? `试听已写入角色卡（${durationText}），正在播放。`
            : `已多抽 ${data.candidates.length} 条候选（${durationText}），请点选采用后再锁定克隆。`,
        );
      } catch (error) {
        setPreviewMessage(error instanceof Error ? error.message : "试听已生成，但播放失败。");
      }
    },
    onError: (error) => {
      setPreviewMessage(error instanceof Error ? error.message : "生成试听失败。");
    },
  });

  const adoptMutation = useMutation({
    mutationFn: async (candidateId: string) => {
      const response = await adoptCharacterVoicePreviewCandidate(novelId, characterId, {
        candidateId,
      });
      return response.data as CharacterVoicePreviewAsset;
    },
    onSuccess: async (data) => {
      setCandidates((prev) => prev.map((c) => ({ ...c, selected: false })));
      setPendingMultiDraw(false);
      queryClient.setQueryData(
        queryKeys.novels.characterVoicePreview(novelId, characterId),
        data,
      );
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: queryKeys.novels.detail(novelId) }),
        queryClient.invalidateQueries({ queryKey: queryKeys.novels.characters(novelId) }),
        queryClient.invalidateQueries({ queryKey: queryKeys.novels.audiobookWorkspace(novelId) }),
      ]);
      try {
        await playFromAsset(data);
        setPreviewMessage("已采用所选候选并写入角色卡。");
      } catch (error) {
        setPreviewMessage(error instanceof Error ? error.message : "已采用，但播放失败。");
      }
    },
    onError: (error) => {
      setPreviewMessage(error instanceof Error ? error.message : "采用候选失败。");
    },
  });

  const roleBlob = `${castRole || ""} ${role || ""} ${characterName || ""}`.toLowerCase();
  const isLeadish =
    castRole === "protagonist"
    || /主角|男主|女主|protagonist|heroine/.test(roleBlob);
  const isExtraish =
    castRole === "extra"
    || /路人|龙套|extra|crowd/.test(roleBlob);
  const showLockCloneGuide = isLeadish || (!isExtraish && mode === "design");
  const canLockClone =
    showLockCloneGuide
    && canPlay
    && assetStatus === "ready"
    && !pendingMultiDraw
    && !dirty
    && resolveCharacterVoiceMode(form.ttsMode) !== "clone";
  const lockCloneBlockReason = dirty
    ? "请先保存当前音色配置再锁定"
    : pendingMultiDraw
      ? "请先点选「采用」将多抽候选写入正式试听，再锁定克隆"
      : assetStatus !== "ready"
        ? "需要 ready 正式试听才能锁定（过期/缺失请重新生成并采用）"
        : resolveCharacterVoiceMode(form.ttsMode) === "clone"
          ? "已是克隆模式"
          : "copy 正式 preview → ref.wav，ttsMode=clone";

  const lockCloneMutation = useMutation({
    mutationFn: async (opts?: { regenerate?: boolean; candidateId?: string }) => {
      if (pendingMultiDraw && !opts?.candidateId) {
        throw new Error("请先采用多抽候选，再锁定为克隆身份。");
      }
      if (assetStatus !== "ready" && !opts?.candidateId) {
        throw new Error("升格需要 ready 正式试听；请重新生成并采用候选。");
      }
      const response = await adoptCharacterVoicePreviewAsClone(novelId, characterId, {
        candidateId: opts?.candidateId,
        regeneratePreviewUnderClone: Boolean(opts?.regenerate),
      });
      const data = response.data;
      if (!data) {
        throw new Error("锁定克隆身份失败：服务端未返回结果。");
      }
      return data;
    },
    onSuccess: async (data) => {
      // 服务端已写 clone+ref；同步表单 + novel detail 缓存，避免「未保存」假脏与错误清空 ref
      onChange("ttsMode", "clone");
      onChange("ttsRefAudioPath", data.ttsRefAudioPath || "");
      onChange("ttsRefAudioBase64", "");
      onChange("ttsVoiceAssetId", "");
      onChange("ttsVoice", "");
      setPendingMultiDraw(false);
      setCandidates([]);
      queryClient.setQueryData(
        queryKeys.novels.characterVoicePreview(novelId, characterId),
        data.contrastPreview || data.preview,
      );
      queryClient.setQueryData<ApiResponse<NovelDetailResponse>>(
        queryKeys.novels.detail(novelId),
        (prev) => {
          if (!prev?.data?.characters) return prev;
          return {
            ...prev,
            data: {
              ...prev.data,
              characters: prev.data.characters.map((c) =>
                c.id === characterId
                  ? {
                      ...c,
                      ttsMode: "clone",
                      ttsRefAudioPath: data.ttsRefAudioPath || null,
                      ttsVoiceAssetId: null,
                      ttsVoice: null,
                      ttsDesignPrompt: data.retainedDesignPrompt ?? c.ttsDesignPrompt,
                    }
                  : c,
              ),
            },
          };
        },
      );
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: queryKeys.novels.detail(novelId) }),
        queryClient.invalidateQueries({ queryKey: queryKeys.novels.characters(novelId) }),
        queryClient.invalidateQueries({ queryKey: queryKeys.novels.audiobookWorkspace(novelId) }),
        queryClient.invalidateQueries({
          queryKey: queryKeys.novels.characterVoicePreview(novelId, characterId),
        }),
      ]);
      setPreviewMessage(
        data.contrastPreview
          ? "已锁定克隆身份，并生成对照试听（长书防漂）。"
          : "已锁定克隆身份。配置变更后旧试听会过期，建议再生成一条对照。",
      );
      try {
        await playFromAsset(data.contrastPreview || data.preview);
      } catch {
        // ignore play errors after lock
      }
    },
    onError: (error) => {
      setPreviewMessage(error instanceof Error ? error.message : "锁定克隆身份失败。");
    },
  });

  const playMutation = useMutation({
    mutationFn: async () => {
      if (!canPlay) {
        throw new Error("尚无试听资产，请先生成试听。");
      }
      let asset = previewQuery.data;
      if (!asset || asset.status === "missing") {
        const response = await getCharacterVoicePreview(novelId, characterId);
        asset = response.data as CharacterVoicePreviewAsset;
      }
      if (!asset || asset.status === "missing") {
        throw new Error("尚无试听资产，请先生成试听。");
      }
      await playFromAsset(asset);
      return asset;
    },
    onSuccess: (asset) => {
      if (asset.status === "stale") {
        setPreviewMessage("正在播放旧版试听（配置已变更，建议重新生成）。");
        return;
      }
      setPreviewMessage("正在播放已保存的试听资产。");
    },
    onError: (error) => {
      setPreviewMessage(error instanceof Error ? error.message : "播放试听失败。");
    },
  });

  function handleCloneFile(file: File | undefined) {
    if (!file) {
      return;
    }
    const reader = new FileReader();
    reader.onload = () => {
      const result = typeof reader.result === "string" ? reader.result : "";
      // 本地上传覆盖库绑定：保存时 base64 优先，服务端会清 assetId
      onChange("ttsRefAudioBase64", result);
      onChange("ttsVoiceAssetId", "");
      if (resolveCharacterVoiceMode(form.ttsMode) !== "clone") {
        onChange("ttsMode", "clone");
      }
    };
    reader.readAsDataURL(file);
  }

  function applyVoiceMode(nextMode: CharacterVoiceMode) {
    const patches = buildCharacterVoiceModeSwitchPatches(nextMode, form.ttsMode);
    if (patches.ttsMode != null) onChange("ttsMode", patches.ttsMode);
    if (patches.ttsVoiceAssetId != null) onChange("ttsVoiceAssetId", patches.ttsVoiceAssetId);
    if (patches.ttsRefAudioPath != null) onChange("ttsRefAudioPath", patches.ttsRefAudioPath);
    if (patches.ttsRefAudioBase64 != null) onChange("ttsRefAudioBase64", patches.ttsRefAudioBase64);
  }

  const bindLibraryMutation = useMutation({
    mutationFn: async (voiceAssetId: string) => {
      const id = voiceAssetId.trim();
      if (!id) {
        throw new Error("请选择库音色。");
      }
      const response = await bindVoiceLibraryAsset(novelId, characterId, id);
      const data = response.data;
      if (!data?.voiceAssetId) {
        throw new Error("绑库失败：服务端未返回资产 id。");
      }
      return data;
    },
    onSuccess: async (data) => {
      onChange("ttsMode", "clone");
      onChange("ttsRefAudioPath", data.ttsRefAudioPath || "");
      onChange("ttsVoiceAssetId", data.voiceAssetId || "");
      onChange("ttsRefAudioBase64", "");
      onChange("ttsVoice", "");
      onChange("ttsDesignPrompt", "");
      setPreviewMessage(`已绑定库音色 ${data.voiceAssetId.slice(0, 12)}…，可生成试听。`);
      queryClient.setQueryData<ApiResponse<NovelDetailResponse>>(
        queryKeys.novels.detail(novelId),
        (prev) => {
          if (!prev?.data?.characters) return prev;
          return {
            ...prev,
            data: {
              ...prev.data,
              characters: prev.data.characters.map((c) =>
                c.id === characterId
                  ? {
                      ...c,
                      ttsMode: "clone",
                      ttsRefAudioPath: data.ttsRefAudioPath || null,
                      ttsVoiceAssetId: data.voiceAssetId,
                      ttsVoice: null,
                      ttsDesignPrompt: null,
                    }
                  : c,
              ),
            },
          };
        },
      );
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: queryKeys.novels.detail(novelId) }),
        queryClient.invalidateQueries({ queryKey: queryKeys.novels.characters(novelId) }),
        queryClient.invalidateQueries({ queryKey: queryKeys.novels.audiobookWorkspace(novelId) }),
        queryClient.invalidateQueries({
          queryKey: queryKeys.novels.characterVoicePreview(novelId, characterId),
        }),
      ]);
    },
    onError: (error) => {
      setPreviewMessage(error instanceof Error ? error.message : "绑库失败。");
    },
  });

  const rewriteDesignMutation = useMutation({
    mutationFn: async () => {
      const response = await rewriteCharacterVoiceDesign(novelId, characterId, {
        currentDesignPrompt: form.ttsDesignPrompt?.trim() || null,
        notes: rewriteNotes.trim() || null,
      });
      const data = response.data;
      if (!data?.designPrompt?.trim()) {
        throw new Error("rewrite 未返回有效 designPrompt。");
      }
      return data;
    },
    onSuccess: (data) => {
      setRewriteCandidate(data.designPrompt);
      setRewriteMeta(
        `来源 ${data.source}${data.tags?.length ? ` · tags: ${data.tags.join(", ")}` : ""}（未写入角色卡）`,
      );
      setPreviewMessage("design 候选已生成，可预览后点「应用到表单」。");
    },
    onError: (error) => {
      setPreviewMessage(error instanceof Error ? error.message : "design rewrite 失败。");
    },
  });

  return (
    <div className="space-y-3 rounded-xl border border-border/70 bg-muted/15 p-3">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0 space-y-1">
          <div className="flex flex-wrap items-center gap-2">
            <div className="text-sm font-medium">有声书音色</div>
            <Badge variant={formVoice.ready ? "outline" : "destructive"}>
              {formVoice.ready ? "可生成" : "缺配置"}
            </Badge>
            <Badge variant="secondary">{formVoice.modeLabel}</Badge>
            <Badge variant={statusBadgeVariant(assetStatus)} title={previewBadge.label}>
              {previewBadge.label}
            </Badge>
            {dirty ? <Badge variant="secondary">未保存</Badge> : null}
          </div>
          <div className="text-xs leading-5 text-muted-foreground">
            当前：{formVoice.detailLabel}
            {dirty && savedVoice.detailLabel !== formVoice.detailLabel
              ? ` · 已保存：${savedVoice.detailLabel}`
              : ""}
          </div>
          <div className="text-xs leading-5 text-muted-foreground">
            试听是角色卡固定资产：本卡可精修后保存并生成；全书批量请到有声书工作台「一键就绪」。
            播放只读磁盘不打上游。配置变更后旧试听可播但会过期。
          </div>
        </div>
        <div className="flex shrink-0 flex-col items-stretch gap-1 sm:items-end">
          <div className="flex flex-wrap justify-end gap-2">
            {onSave ? (
              <Button
                type="button"
                size="sm"
                variant={dirty ? "default" : "outline"}
                disabled={isSaving || !dirty}
                title={dirty ? "将当前音色配置写入角色卡" : "音色无未保存改动"}
                onClick={onSave}
              >
                {isSaving ? "保存中..." : dirty ? "保存音色" : "已保存"}
              </Button>
            ) : null}
            <Button
              type="button"
              size="sm"
              variant="default"
              disabled={generateMutation.isPending || !generateGate.ok}
              title={generateGate.ok ? `为 ${characterName} 多抽 3 条试听` : generateGate.reason}
              onClick={() => generateMutation.mutate()}
            >
              {generateMutation.isPending
                ? "生成中..."
                : assetStatus === "ready" || assetStatus === "stale"
                  ? "重新生成"
                  : "生成试听"}
            </Button>
            <Button
              type="button"
              size="sm"
              variant="outline"
              disabled={playMutation.isPending || !canPlay}
              title={canPlay ? `播放 ${characterName} 已保存试听` : "请先生成试听"}
              onClick={() => playMutation.mutate()}
            >
              {playMutation.isPending ? "加载中..." : "播放试听"}
            </Button>
          </div>
          {!generateGate.ok ? (
            <div className="max-w-[18rem] text-right text-[11px] leading-4 text-muted-foreground">
              {generateGate.reason}
            </div>
          ) : null}
          {assetStatus === "stale" ? (
            <div className="max-w-[18rem] text-right text-[11px] leading-4 text-amber-700 dark:text-amber-400">
              配置已变，可播旧版；建议重新生成。
            </div>
          ) : null}
          {showLockCloneGuide && resolveCharacterVoiceMode(form.ttsMode) !== "clone" ? (
            <div className="max-w-[20rem] space-y-1 text-right">
              <div className="text-[11px] leading-4 text-muted-foreground">
                {isLeadish
                  ? "主角建议：将选优试听锁定为克隆身份，长书跨章不漂。"
                  : "可将选优试听升格为克隆身份（可选）。"}
              </div>
              <Button
                type="button"
                size="sm"
                variant={isLeadish ? "default" : "outline"}
                disabled={lockCloneMutation.isPending || !canLockClone}
                title={lockCloneBlockReason}
                onClick={() => lockCloneMutation.mutate({ regenerate: false })}
              >
                {lockCloneMutation.isPending ? "锁定中..." : "锁定为克隆身份"}
              </Button>
              {!canLockClone && !lockCloneMutation.isPending ? (
                <div className="text-[11px] leading-4 text-amber-700 dark:text-amber-400">
                  {lockCloneBlockReason}
                </div>
              ) : null}
            </div>
          ) : null}
          {resolveCharacterVoiceMode(form.ttsMode) === "clone"
          && (form.ttsRefAudioPath || form.ttsVoiceAssetId) ? (
            <div className="max-w-[18rem] text-right text-[11px] leading-4 text-muted-foreground">
              {form.ttsVoiceAssetId
                ? `已绑库克隆（${form.ttsVoiceAssetId.slice(0, 12)}…）。`
                : "已绑定克隆参考（长书身份锚）。"}
            </div>
          ) : null}
        </div>
      </div>

      {previewMessage ? (
        <div className="text-xs text-muted-foreground">{previewMessage}</div>
      ) : null}
      {previewAudioUrl ? (
        <div className="space-y-1">
          <div className="text-xs text-muted-foreground">
            试听：{previewLabel || formVoice.detailLabel}
            {previewDurationSec != null ? ` · ${previewDurationSec.toFixed(1)}s` : ""}
            {previewQuery.data?.generatedAt
              ? ` · 生成于 ${new Date(previewQuery.data.generatedAt).toLocaleString()}`
              : ""}
          </div>
          
      {candidates.length > 1 ? (
        <div className="space-y-2 rounded-lg border border-border/60 bg-background/60 p-2">
          <div className="text-xs font-medium text-muted-foreground">
            多抽候选（工程建议 {suggestedCandidateId || "—"}，请人耳选）
          </div>
          <div className="flex flex-wrap gap-2">
            {candidates.map((c) => (
              <div key={c.id} className="flex items-center gap-1 rounded-md border border-border/50 px-2 py-1">
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  onClick={() => {
                    if (c.audioBase64) {
                      void playFromAsset({
                        characterId,
                        characterName,
                        status: "ready",
                        ttsMode: "preset",
                        voice: null,
                        sampleText: null,
                        fingerprint: null,
                        currentFingerprint: "",
                        generatedAt: null,
                        audioUrl: c.audioUrl,
                        audioBase64: c.audioBase64,
                        format: "wav",
                      });
                    }
                  }}
                >
                  听 {c.id}
                  {c.durationMs > 0 ? ` · ${(c.durationMs / 1000).toFixed(1)}s` : ""}
                  {c.id === suggestedCandidateId ? " · 建议" : ""}
                </Button>
                <Button
                  type="button"
                  size="sm"
                  variant={c.selected ? "default" : "secondary"}
                  disabled={adoptMutation.isPending}
                  onClick={() => adoptMutation.mutate(c.id)}
                >
                  采用
                </Button>
              </div>
            ))}
          </div>
        </div>
      ) : null}
<audio ref={previewAudioRef} controls preload="auto" src={previewAudioUrl} className="w-full" />
        </div>
      ) : null}

      <div className="space-y-2 rounded-lg border border-border/70 bg-background p-3">
        <div className="text-sm font-medium text-foreground">配置方式</div>
        <div className="grid gap-2 sm:grid-cols-3">
          {CHARACTER_VOICE_MODE_OPTIONS.map((option) => {
            const active = mode === option.value;
            return (
              <button
                key={option.value}
                type="button"
                className={`rounded-lg border px-3 py-2 text-left transition ${modeButtonClass(active)}`}
                onClick={() => applyVoiceMode(option.value)}
              >
                <div className="text-sm font-medium text-foreground">{option.label}</div>
                <div className="mt-0.5 text-[11px] leading-4 text-muted-foreground">{option.helper}</div>
              </button>
            );
          })}
        </div>

        {mode === "preset" ? (
          <div className="space-y-2">
            <div className="text-xs font-medium text-muted-foreground">中文预置</div>
            <PresetVoiceGrid
              items={ZH_PRESETS}
              selectedVoice={form.ttsVoice}
              onSelect={(voiceId) => onChange("ttsVoice", voiceId)}
              showDescription
            />
            <div className="text-xs font-medium text-muted-foreground">英文预置</div>
            <PresetVoiceGrid
              items={EN_PRESETS}
              selectedVoice={form.ttsVoice}
              onSelect={(voiceId) => onChange("ttsVoice", voiceId)}
              showDescription={false}
            />
            {selectedPreset ? (
              <div className="text-xs text-muted-foreground">
                当前预置：{selectedPreset.label}
                {selectedPreset.description ? ` · ${selectedPreset.description}` : ""}
                {selectedPreset.locale === "en" ? " · EN" : " · 中文"}
              </div>
            ) : (
              <div className="text-xs text-destructive">尚未选择预置音色（将阻断有声书生成）。</div>
            )}
          </div>
        ) : null}

        {mode === "design" ? (
          <div className="space-y-2">
            <textarea
              className="min-h-[88px] w-full rounded-md border bg-background p-2 text-sm"
              placeholder="音色设计描述（如：青年男性，声线沉稳略沙哑，语速中等，适合冷硬独白）"
              value={form.ttsDesignPrompt}
              onChange={(event) => onChange("ttsDesignPrompt", event.target.value)}
            />
            <div className="text-xs text-muted-foreground">
              描述越具体，试听与成书越稳。可写年龄感、性别倾向、语速、情绪底色。
            </div>
            <div className="space-y-2 rounded-md border border-dashed p-2">
              <div className="text-xs font-medium text-foreground">AI 重写设计描述</div>
              <Input
                className="h-9 text-sm"
                placeholder="可选额外约束（语速/情绪/场景…）"
                value={rewriteNotes}
                onChange={(event) => setRewriteNotes(event.target.value)}
              />
              <div className="flex flex-wrap gap-2">
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  disabled={rewriteDesignMutation.isPending}
                  onClick={() => rewriteDesignMutation.mutate()}
                >
                  {rewriteDesignMutation.isPending ? "生成中..." : "生成候选"}
                </Button>
                {rewriteCandidate ? (
                  <Button
                    type="button"
                    size="sm"
                    onClick={() => {
                      onChange("ttsDesignPrompt", rewriteCandidate);
                      setPreviewMessage("已应用 design 候选到表单（请再保存角色）。");
                    }}
                  >
                    应用到表单
                  </Button>
                ) : null}
              </div>
              {rewriteCandidate ? (
                <div className="space-y-1">
                  <div className="text-[11px] text-muted-foreground">{rewriteMeta}</div>
                  <div className="max-h-28 overflow-y-auto rounded border bg-background p-2 text-xs leading-5">
                    {rewriteCandidate}
                  </div>
                </div>
              ) : null}
            </div>
          </div>
        ) : null}

        {mode === "clone" ? (
          <div className="space-y-3 rounded-md border border-dashed p-2">
            <div className="space-y-2">
              <div className="text-xs font-medium text-foreground">从全站音色库绑定</div>
              <p className="text-xs leading-5 text-muted-foreground">
                仅列出 approved 的 clone_ref。点选即写入角色（无需再点「保存音色」）；路径由服务端写，客户端不提交参考音路径。
                {boundAssetId
                  ? ` 当前：${selectedLibraryAsset
                    ? `${selectedLibraryAsset.displayName}（${selectedLibraryAsset.slug}）`
                    : boundAssetId}`
                  : " 当前未绑库。"}
              </p>
              <Input
                className="h-9 text-sm"
                placeholder="检索库音色 slug / 名称 / tag…"
                value={libraryKeyword}
                onChange={(event) => setLibraryKeyword(event.target.value)}
              />
              {libraryQuery.isLoading ? (
                <div className="text-xs text-muted-foreground">加载库音色…</div>
              ) : null}
              {libraryQuery.isError ? (
                <div className="text-xs text-destructive">
                  库列表加载失败：
                  {libraryQuery.error instanceof Error
                    ? libraryQuery.error.message
                    : "未知错误"}
                </div>
              ) : null}
              {!libraryQuery.isLoading && !libraryQuery.isError && libraryItems.length === 0 ? (
                <div className="text-xs text-muted-foreground">
                  {debouncedLibraryKeyword
                    ? "无匹配 approved 库音色。"
                    : "暂无 approved 库音色。请先人耳批准 seed/import 资产后再绑库。"}
                </div>
              ) : null}
              {!libraryQuery.isLoading && !libraryQuery.isError && libraryTotal > 0 ? (
                <div className="text-[11px] text-muted-foreground">
                  匹配 {libraryTotal} 条 · 已展示 {libraryItems.length}
                </div>
              ) : null}
              {libraryItems.length > 0 ? (
                <div className="grid max-h-48 gap-2 overflow-y-auto sm:grid-cols-2">
                  {libraryItems.map((asset) => {
                    const active = boundAssetId === asset.id;
                    const tags = asset.tags.slice(0, 4).join(" · ");
                    return (
                      <button
                        key={asset.id}
                        type="button"
                        disabled={bindLibraryMutation.isPending}
                        className={`rounded-lg border px-3 py-2 text-left transition ${presetChipClass(active)}`}
                        title={`${asset.id} · ${asset.slug}`}
                        onClick={() => {
                          if (active) return;
                          bindLibraryMutation.mutate(asset.id);
                        }}
                      >
                        <div className="flex items-center gap-2">
                          <span className="text-sm font-medium">{asset.displayName}</span>
                          {active ? <Badge variant="secondary">已绑</Badge> : null}
                        </div>
                        <div className="mt-0.5 text-[11px] text-muted-foreground">
                          {asset.slug}
                          {tags ? ` · ${tags}` : ""}
                        </div>
                      </button>
                    );
                  })}
                </div>
              ) : null}
              {!libraryQuery.isLoading
                && !libraryQuery.isError
                && libraryTotal > libraryItems.length
                && libraryLimit < 500 ? (
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  disabled={libraryQuery.isFetching}
                  onClick={() => setLibraryPages((pages) => pages + 1)}
                >
                  加载更多
                </Button>
              ) : null}
              {bindLibraryMutation.isPending ? (
                <div className="text-xs text-muted-foreground">正在绑定库音色…</div>
              ) : null}
            </div>

            <div className="space-y-2 border-t border-border/50 pt-2">
              <div className="text-xs font-medium text-foreground">或上传本地参考音</div>
              <p className="text-xs leading-5 text-muted-foreground">
                上传 WAV/音频（base64 随角色保存落盘，会覆盖库绑定）。已落盘路径：
                {form.ttsRefAudioPath ? ` ${form.ttsRefAudioPath}` : " 无"}
              </p>
              <input
                type="file"
                accept="audio/*,.wav,.mp3,.ogg"
                className="block w-full text-sm"
                onChange={(event) => handleCloneFile(event.target.files?.[0])}
              />
              {hasLocalCloneDraft ? (
                <div className="space-y-1">
                  <p className="text-xs text-muted-foreground">
                    已选择新参考音频（未保存）。可先本地听参考轨；保存后再生成固定试听。
                  </p>
                  {localCloneSrc ? (
                    <audio controls src={localCloneSrc} className="w-full" />
                  ) : null}
                </div>
              ) : null}
            </div>
          </div>
        ) : null}

        <textarea
          className="min-h-[72px] w-full rounded-md border bg-background p-2 text-sm"
          placeholder={`有声书说话 style（默认可参考：${DEFAULT_AUDIOBOOK_NARRATOR_STYLE.slice(0, 24)}…）`}
          value={form.ttsStyle}
          onChange={(event) => onChange("ttsStyle", event.target.value)}
        />
        <Input
          placeholder="说话人别名（外号/称呼，顿号或逗号分隔，如：远哥、小远）"
          value={form.ttsSpeakerAliases}
          onChange={(event) => onChange("ttsSpeakerAliases", event.target.value)}
        />
      </div>
    </div>
  );
}
