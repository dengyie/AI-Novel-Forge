import { useEffect, useMemo, useRef, useState } from "react";
import { useMutation } from "@tanstack/react-query";
import {
  DEFAULT_AUDIOBOOK_NARRATOR_STYLE,
  MIMO_TTS_VOICE_CATALOG,
  type AudiobookTtsMode,
} from "@ai-novel/shared/types/audiobook";
import { previewAudiobookVoice } from "@/api/novel/audiobook";
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
import {
  CHARACTER_VOICE_MODE_OPTIONS,
  canPreviewCharacterVoice,
  findMimoVoiceCatalogItem,
  isCharacterVoiceFormDirty,
  resolveCharacterVoiceBinding,
  resolveCharacterVoiceMode,
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

  const formVoice = useMemo(
    () => resolveCharacterVoiceBinding(form),
    [form.ttsMode, form.ttsVoice, form.ttsDesignPrompt, form.ttsRefAudioPath],
  );
  const savedVoice = useMemo(() => resolveCharacterVoiceBinding(saved), [saved]);
  const dirty = useMemo(() => isCharacterVoiceFormDirty(form, saved), [form, saved]);
  const previewGate = useMemo(
    () => canPreviewCharacterVoice(form),
    [form.ttsMode, form.ttsVoice, form.ttsDesignPrompt, form.ttsRefAudioPath, form.ttsRefAudioBase64],
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
        setPreviewMessage("试听已生成；若未自动播放，请点播放键。");
      }
    });
    return () => {
      cancelled = true;
    };
  }, [previewAudioUrl]);

  const previewMutation = useMutation({
    mutationFn: async () => {
      const gate = canPreviewCharacterVoice(form);
      if (!gate.ok) {
        throw new Error(gate.reason);
      }
      const nextMode = resolveCharacterVoiceMode(form.ttsMode);
      const response = await previewAudiobookVoice(novelId, {
        characterId,
        ttsMode: nextMode as AudiobookTtsMode,
        ttsVoice: form.ttsVoice.trim() || null,
        ttsStyle: form.ttsStyle.trim() || null,
        ttsDesignPrompt: form.ttsDesignPrompt.trim() || null,
      });
      return response.data;
    },
    onSuccess: (data) => {
      if (!data?.audioBase64) {
        setPreviewAudioUrl(previewUrlSlotRef.current.set(null));
        setPreviewDurationSec(null);
        setPreviewMessage("试听无音频返回。");
        return;
      }
      try {
        const inspection = inspectWavAudioBase64(data.audioBase64);
        if (!inspection.isWav || inspection.reason) {
          throw new Error(inspection.reason || "试听音频无效。");
        }
        const nextUrl = decodeBase64AudioToObjectUrl(data.audioBase64, "audio/wav");
        setPreviewAudioUrl(previewUrlSlotRef.current.set(nextUrl));
        setPreviewLabel(formVoice.detailLabel);
        setPreviewDurationSec(inspection.durationSec);
        const durationText = inspection.durationSec != null
          ? `约 ${inspection.durationSec.toFixed(1)} 秒`
          : "时长待解析";
        setPreviewMessage(`试听已生成（${durationText}），正在尝试自动播放。`);
      } catch (error) {
        setPreviewAudioUrl(previewUrlSlotRef.current.set(null));
        setPreviewDurationSec(null);
        setPreviewMessage(error instanceof Error ? error.message : "试听音频解码失败。");
      }
    },
    onError: (error) => {
      setPreviewMessage(error instanceof Error ? error.message : "试听失败。");
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
            {dirty ? <Badge variant="secondary">未保存</Badge> : null}
          </div>
          <div className="text-xs leading-5 text-muted-foreground">
            当前：{formVoice.detailLabel}
            {dirty && savedVoice.detailLabel !== formVoice.detailLabel
              ? ` · 已保存：${savedVoice.detailLabel}`
              : ""}
          </div>
          <div className="text-xs leading-5 text-muted-foreground">
            预置可直接试听；设计需有描述；克隆须保存参考音后服务端试听，未保存时可本地听参考轨。
            改完音色后请点「保存音色」写入角色卡（侧边栏/有声书面板只读已保存绑定）。
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
              variant="outline"
              disabled={previewMutation.isPending || !previewGate.ok}
              title={previewGate.ok ? `试听 ${characterName}` : previewGate.reason}
              onClick={() => previewMutation.mutate()}
            >
              {previewMutation.isPending ? "试听生成中..." : "试听音色"}
            </Button>
          </div>
          {!previewGate.ok ? (
            <div className="max-w-[18rem] text-right text-[11px] leading-4 text-muted-foreground">
              {previewGate.reason}
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
                  已选择新参考音频（未保存）。可先本地试听，保存角色后才能服务端克隆试听。
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
