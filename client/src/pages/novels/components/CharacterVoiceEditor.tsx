import { useEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  DEFAULT_AUDIOBOOK_NARRATOR_STYLE,
  MIMO_TTS_VOICE_CATALOG,
  type CharacterVoicePreviewAsset,
  type CharacterVoicePreviewStatus,
} from "@ai-novel/shared/types/audiobook";
import {
  generateCharacterVoicePreview,
  getCharacterVoicePreview,
  issueCharacterVoicePreviewMediaUrl,
} from "@/api/novel/audiobook";
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
  ttsSpeakerAliases: string;
};

export type CharacterVoiceEditorField = keyof CharacterVoiceEditorForm;

interface CharacterVoiceEditorProps {
  novelId: string;
  characterId: string;
  characterName: string;
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
    form,
    saved,
    onChange,
    onSave,
    isSaving = false,
  } = props;

  const queryClient = useQueryClient();
  const formVoice = useMemo(
    () => resolveCharacterVoiceBinding(form),
    [form.ttsMode, form.ttsVoice, form.ttsDesignPrompt, form.ttsRefAudioPath],
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

  const [previewAudioUrl, setPreviewAudioUrl] = useState<string | null>(null);
  const [previewLabel, setPreviewLabel] = useState("");
  const [previewMessage, setPreviewMessage] = useState("");
  const [previewDurationSec, setPreviewDurationSec] = useState<number | null>(null);
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
      const response = await generateCharacterVoicePreview(novelId, characterId, {});
      return response.data as CharacterVoicePreviewAsset;
    },
    onSuccess: async (data) => {
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
        const durationText = previewDurationSec != null
          ? `约 ${previewDurationSec.toFixed(1)} 秒`
          : "时长待解析";
        setPreviewMessage(
          data.status === "ready"
            ? `试听已写入角色卡（${durationText}），正在播放。`
            : `试听已生成（${durationText}）。`,
        );
      } catch (error) {
        setPreviewMessage(error instanceof Error ? error.message : "试听已生成，但播放失败。");
      }
    },
    onError: (error) => {
      setPreviewMessage(error instanceof Error ? error.message : "生成试听失败。");
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
      onChange("ttsRefAudioBase64", result);
      if (resolveCharacterVoiceMode(form.ttsMode) !== "clone") {
        onChange("ttsMode", "clone");
      }
    };
    reader.readAsDataURL(file);
  }

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
              title={generateGate.ok ? `为 ${characterName} 生成固定试听` : generateGate.reason}
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
                onClick={() => onChange("ttsMode", option.value as CharacterVoiceMode)}
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
          </div>
        ) : null}

        {mode === "clone" ? (
          <div className="space-y-2 rounded-md border border-dashed p-2">
            <p className="text-xs leading-5 text-muted-foreground">
              上传参考 WAV/音频（base64 随角色保存落盘）。已绑定路径：
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
