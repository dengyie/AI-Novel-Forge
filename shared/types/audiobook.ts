import type { LLMProvider } from "./llm";
import type { TaskTokenUsageSummary } from "./task";

/** 固化 MiMo 预置音色（产品 SoT）。 */
export const MIMO_TTS_PRESET_VOICES = [
  "冰糖",
  "茉莉",
  "苏打",
  "白桦",
  "Mia",
  "Chloe",
  "Milo",
  "Dean",
] as const;

export type MimoTtsPresetVoice = (typeof MIMO_TTS_PRESET_VOICES)[number];

export const DEFAULT_AUDIOBOOK_NARRATOR_VOICE: MimoTtsPresetVoice = "茉莉";

export const DEFAULT_AUDIOBOOK_NARRATOR_STYLE =
  "知性、清楚、温和，适合说明和旁白。声音明亮，语速中等，像产品演示里的温和讲解。";

export const AUDIOBOOK_CHUNK_MAX_CHARS = 550;

/**
 * 章内 chunk 硬拼接时的语义停顿（毫秒）。
 * 实际接缝静音 ≈ 模型自带尾/头静音 + 下表插入值。
 * 取值偏保守，优先消除「贴肉」听感。
 */
export const AUDIOBOOK_GAP_MS = {
  /** 同一说话人续读（长旁白被切块） */
  sameSpeaker: 180,
  /** 旁白 ↔ 角色 */
  narratorCharacter: 420,
  /** 不同角色对白 */
  characterCharacter: 320,
  /** 短句（≤ shortUtteranceChars）额外加成 */
  shortUtteranceBonus: 120,
  /** 触发短句加成的字数阈值 */
  shortUtteranceChars: 15,
  /** 章与章之间 */
  betweenChapters: 700,
} as const;

export type AudiobookTaskStatus =
  | "queued"
  | "running"
  | "succeeded"
  | "failed"
  | "cancelled";

export type AudiobookScopeMode = "chapter" | "range" | "full";

export type AudiobookSpeakerKind = "narrator" | "character";

/**
 * 段级语境表演开关。
 * - off：完全沿用角色卡静态 style/design（默认）
 * - characters：仅角色对白注入 delivery
 * - all：角色 + 旁白轻量 delivery
 */
export type DeliveryStyleMode = "off" | "characters" | "all";

export const DELIVERY_STYLE_MODES = ["off", "characters", "all"] as const;

export function isDeliveryStyleMode(value: string): value is DeliveryStyleMode {
  return (DELIVERY_STYLE_MODES as readonly string[]).includes(value);
}

export type DeliveryIntensity = "low" | "mid" | "high";
export type DeliveryVocalEffort = "whisper" | "soft" | "normal" | "raised" | "strained";
export type DeliveryRate = "slow" | "measured" | "normal" | "fast" | "rushed";
export type DeliveryPitchMove = "lowered" | "stable" | "lifted" | "cracked";

/**
 * 段级表演结构化字段（Core 必填倾向 + Extended 可空）。
 * 不写回 Character；仅存于 annotations 段。
 */
export interface AudiobookSegmentDelivery {
  primaryEmotion: string;
  intensity: DeliveryIntensity;
  surfaceTone: string;
  intent: string;
  vocalEffort: DeliveryVocalEffort;
  rate: DeliveryRate;
  maskOrLeak?: string | null;
  secondaryTraits?: string[];
  addresseeRelation?: string | null;
  subtext?: string | null;
  sceneSpace?: string | null;
  scenePressure?: string | null;
  pitchMove?: DeliveryPitchMove | null;
  pauseBreath?: string | null;
  articulation?: string | null;
  nonverbalCue?: string | null;
  continuityFrom?: string | null;
  rawFactors?: string[];
  /** 模型成稿句；须过 validateDeliveryLine 才采用，否则服务端 compile */
  deliveryLine?: string | null;
}

/** 角色 TTS 模态：预置 / 文案设计 / 参考音频克隆。旁白仅 preset。 */
export type AudiobookTtsMode = "preset" | "design" | "clone";

export const AUDIOBOOK_TTS_MODES = ["preset", "design", "clone"] as const;

export const MIMO_TTS_MODELS = {
  preset: "mimo-v2.5-tts",
  design: "mimo-v2.5-tts-voicedesign",
  clone: "mimo-v2.5-tts-voiceclone",
} as const;

export function isAudiobookTtsMode(value: string): value is AudiobookTtsMode {
  return (AUDIOBOOK_TTS_MODES as readonly string[]).includes(value);
}

export interface AudiobookCharacterVoiceConfig {
  characterId: string;
  characterName: string;
  /** 缺省视为 preset（兼容旧数据）。 */
  ttsMode?: AudiobookTtsMode | null;
  /** preset：预置音色名；design/clone 可空。 */
  ttsVoice?: string | null;
  ttsStyle?: string | null;
  /** design：音色设计文案（user content）。 */
  ttsDesignPrompt?: string | null;
  /** clone：参考音频相对/绝对路径（服务端可读）。 */
  ttsRefAudioPath?: string | null;
  /** 说话人别名（称呼/外号），用于标注 speakerName 归一。 */
  speakerAliases?: string[] | null;
  /** 角色卡声线描述（roster 摘要；不进合成）。 */
  voiceTexture?: string | null;
  /** 角色卡性格一句（roster 摘要；不进合成）。 */
  personality?: string | null;
}

export interface AudiobookNarratorConfig {
  voice: string;
  style: string;
}

export interface AudiobookDialogueSegment {
  index: number;
  speakerKind: AudiobookSpeakerKind;
  /** 旁白为 null；角色为 Character.id */
  characterId?: string | null;
  /** 展示名：旁白 / 角色名 */
  speakerLabel: string;
  text: string;
  /** 合成模态；缺省 preset。 */
  ttsMode?: AudiobookTtsMode | null;
  /** preset 的预置名；design 可空；clone 不用作预置名。 */
  voice: string;
  /**
   * preset/clone：最终注入 MiMo user 的 style；
   * design：可保留 base 供审计，合成以 designPrompt 为准。
   */
  style?: string | null;
  /** design：最终 user（音色 + 表演）；preset/clone 透传角色卡原值。 */
  designPrompt?: string | null;
  /** clone 模式参考音频路径。 */
  refAudioPath?: string | null;
  /** 角色卡/旁白基线 style（审计；preset 合成前参与 compile）。 */
  baseStyle?: string | null;
  /** design 模式：角色卡原始 design（审计；合成时与表演合并）。 */
  baseDesignPrompt?: string | null;
  /** 结构化表演；null = 无表演或已剥除。 */
  delivery?: AudiobookSegmentDelivery | null;
  /**
   * 合并桶：emotion族|intensity|vocalEffort|rate。
   * canMerge 用此字段（及音色字段），不用全文 style 字符串。
   */
  deliveryMergeKey?: string | null;
}

export interface AudiobookChapterAnnotation {
  chapterId: string;
  chapterOrder: number;
  chapterTitle: string;
  segments: AudiobookDialogueSegment[];
  annotatedAt?: string | null;
  error?: string | null;
}

export interface CreateAudiobookTaskInput {
  novelId: string;
  scopeMode: AudiobookScopeMode;
  /** scopeMode=chapter 时必填 */
  chapterId?: string;
  /** scopeMode=range 时使用章节 order */
  startChapterOrder?: number;
  endChapterOrder?: number;
  /** 覆盖小说默认旁白音色 */
  narratorVoice?: string;
  /** 覆盖小说默认旁白 style */
  narratorStyle?: string;
  provider?: LLMProvider;
  model?: string;
  temperature?: number;
  /**
   * 为 true 时：createTask 在 voice 通过后额外要求全书角色卡试听均为 ready。
   * 默认 false；扫描范围与音色门禁一致（全书角色，不按章节收窄）。
   */
  requireReadyPreview?: boolean;
  /**
   * 段级语境表演模式。缺省由服务端解析（代码默认 off，env AUDIOBOOK_DELIVERY_STYLE_MODE 可覆盖）。
   * 听测前请保持 off，勿污染固定试听/readiness 基线。
   */
  deliveryStyleMode?: DeliveryStyleMode;
}

export interface AudiobookPrecheckMissingVoice {
  characterId: string;
  characterName: string;
  reason: string;
}

export interface AudiobookPrecheckPreviewItem {
  characterId: string;
  characterName: string;
  previewStatus: CharacterVoicePreviewStatus;
  reason?: string | null;
}

/** 仅针对 voice 已 configured 的角色统计试听就绪；不进入 precheck.ok。 */
export interface AudiobookPrecheckPreview {
  ready: number;
  stale: number;
  missing: number;
  /** 无 configured 角色时 true；否则全部 ready */
  ok: boolean;
  /** 非 ready 的 configured 角色（控制 payload） */
  items: AudiobookPrecheckPreviewItem[];
}

export interface AudiobookPrecheckResult {
  ok: boolean;
  novelId: string;
  scopeMode: AudiobookScopeMode;
  chapterIds: string[];
  chapterCount: number;
  narrator: AudiobookNarratorConfig;
  characterVoices: AudiobookCharacterVoiceConfig[];
  missingVoices: AudiobookPrecheckMissingVoice[];
  /** 非预置音色等硬失败原因（与 missingVoices 一并决定 ok） */
  blockingErrors: string[];
  warnings: string[];
  /** 固定试听就绪报告（软）；create 可选 requireReadyPreview 硬拦 preview.ok */
  preview: AudiobookPrecheckPreview;
}

export interface AudiobookTaskSummary {
  id: string;
  novelId: string;
  novelTitle: string;
  title: string;
  status: AudiobookTaskStatus;
  progress: number;
  scopeMode: AudiobookScopeMode;
  currentStage?: string | null;
  currentItemKey?: string | null;
  currentItemLabel?: string | null;
  attemptCount: number;
  maxAttempts: number;
  lastError?: string | null;
  chapterCount: number;
  completedChapterCount: number;
  /**
   * 已落盘 chapter.wav、可立即播放/下载的章节 id（生成中即可用，不必等全书）。
   * 顺序与任务 chapterIds 一致子集。
   */
  readyChapterIds?: string[];
  outputDir?: string | null;
  fullAudioPath?: string | null;
  /** 全书 WAV 是否可交付（磁盘 full-book.wav 存在）。 */
  fullAudioReady?: boolean;
  /** 全书 m4b 状态：ready 才展示下载；skipped/failed 仅提示。 */
  m4bStatus?: "ready" | "skipped" | "failed" | null;
  /** 成功后是否已清理 chunk-*.wav（章 wav / 全书仍保留）。 */
  chunksPruned?: boolean;
  createdAt: string;
  updatedAt: string;
  startedAt?: string | null;
  finishedAt?: string | null;
  heartbeatAt?: string | null;
  tokenUsage?: TaskTokenUsageSummary | null;
}

export interface AudiobookTaskDetail extends AudiobookTaskSummary {
  chapterIds: string[];
  narratorVoice: string;
  narratorStyle: string;
  provider?: string | null;
  model?: string | null;
  cancelRequestedAt?: string | null;
  summary?: string | null;
  annotationsJson?: string | null;
  progressJson?: string | null;
  resultJson?: string | null;
  meta: Record<string, unknown>;
}

/** 查看任务标注结果（调试 / 失败章重做） */
export interface AudiobookTaskAnnotationsView {
  taskId: string;
  novelId: string;
  status: AudiobookTaskStatus;
  annotations: AudiobookChapterAnnotation[];
  qualityWarnings: string[];
}

export type AudiobookChapterReprocessMode = "reannotate" | "resynthesize";

export interface ReprocessAudiobookChapterInput {
  mode: AudiobookChapterReprocessMode;
  chapterId: string;
}

export interface AudiobookVoiceCatalogItem {
  id: string;
  label: string;
  locale: "zh" | "en";
  description?: string;
}

export const MIMO_TTS_VOICE_CATALOG: AudiobookVoiceCatalogItem[] = [
  { id: "冰糖", label: "冰糖", locale: "zh", description: "活泼少女" },
  { id: "茉莉", label: "茉莉", locale: "zh", description: "知性女声" },
  { id: "苏打", label: "苏打", locale: "zh", description: "阳光少年" },
  { id: "白桦", label: "白桦", locale: "zh", description: "成熟男声" },
  { id: "Mia", label: "Mia", locale: "en" },
  { id: "Chloe", label: "Chloe", locale: "en" },
  { id: "Milo", label: "Milo", locale: "en" },
  { id: "Dean", label: "Dean", locale: "en" },
];

export function isMimoTtsPresetVoice(value: string): value is MimoTtsPresetVoice {
  return (MIMO_TTS_PRESET_VOICES as readonly string[]).includes(value);
}

/** 人物卡 → 音色资产规划：策略 */
export type AudiobookVoicePlanStrategy = "auto" | "preset_only" | "prefer_design";

/** 单角色建议（不落库，apply 时写 Character 字段） */
export interface AudiobookVoicePlanItem {
  characterId: string;
  characterName: string;
  ttsMode: AudiobookTtsMode;
  /** preset 时必有 */
  ttsVoice?: string | null;
  ttsStyle?: string | null;
  /** design 时必有 */
  ttsDesignPrompt?: string | null;
  /** 建议说话人别名（可空） */
  speakerAliases?: string[] | null;
  /** 是否覆盖已有绑定 */
  wouldOverwrite: boolean;
  /** 规划理由（中文短句） */
  reason: string;
  /** 推断性别桶 */
  genderBucket: "male" | "female" | "unknown";
  /** 推断声线年龄桶 */
  ageBucket: "youth" | "adult" | "elder" | "unknown";
  /** 重要性 0–100，越高越优先差异化 */
  importance: number;
  /** 当前已绑定摘要 */
  currentBinding?: {
    ttsMode?: string | null;
    ttsVoice?: string | null;
    ttsDesignPrompt?: string | null;
  } | null;
}

export interface AudiobookVoicePlanSuggestInput {
  /** 仅规划未绑定角色；默认 true */
  onlyMissing?: boolean;
  /** 限定角色 id；空=全书角色 */
  characterIds?: string[];
  strategy?: AudiobookVoicePlanStrategy;
  /** 同 preset 重要角色数超过该值后改 design；默认 1 */
  maxImportantPerPreset?: number;
}

export interface AudiobookVoicePlanSuggestResult {
  novelId: string;
  strategy: AudiobookVoicePlanStrategy;
  items: AudiobookVoicePlanItem[];
  skipped: Array<{ characterId: string; characterName: string; reason: string }>;
  summary: {
    total: number;
    planned: number;
    presetCount: number;
    designCount: number;
    overwriteCount: number;
  };
}

export interface AudiobookVoicePlanApplyItem {
  characterId: string;
  ttsMode: AudiobookTtsMode;
  ttsVoice?: string | null;
  ttsStyle?: string | null;
  ttsDesignPrompt?: string | null;
  speakerAliases?: string[] | null;
}

export interface AudiobookVoicePlanApplyInput {
  items: AudiobookVoicePlanApplyItem[];
  /** 已绑定是否覆盖；默认 false 跳过已配置 */
  overwrite?: boolean;
}

export interface AudiobookVoicePlanApplyResult {
  novelId: string;
  applied: Array<{ characterId: string; characterName: string; ttsMode: string }>;
  skipped: Array<{ characterId: string; characterName: string; reason: string }>;
}

export interface AudiobookVoicePreviewInput {
  characterId?: string;
  ttsMode?: AudiobookTtsMode;
  ttsVoice?: string | null;
  ttsStyle?: string | null;
  ttsDesignPrompt?: string | null;
  /** 试听文本，默认短句 */
  text?: string;
}

export interface AudiobookVoicePreviewResult {
  characterId?: string | null;
  characterName?: string | null;
  ttsMode: AudiobookTtsMode;
  voice?: string | null;
  audioBase64: string;
  format: "wav";
  sampleText: string;
}

/** 角色卡固定试听资产状态。 */
export type CharacterVoicePreviewStatus = "missing" | "ready" | "stale";

export interface CharacterVoicePreviewGenerateInput {
  /** 可选样例句；默认系统短句。 */
  text?: string;
}

export interface CharacterVoicePreviewAsset {
  characterId: string;
  characterName: string;
  status: CharacterVoicePreviewStatus;
  ttsMode: AudiobookTtsMode;
  voice?: string | null;
  sampleText: string | null;
  fingerprint: string | null;
  currentFingerprint: string;
  generatedAt: string | null;
  /** SPA 可直接用于 <audio src> 的相对路径（需带鉴权时由客户端再签 media-access）。 */
  audioUrl: string | null;
  /** 生成接口可选带回，便于首播；status 查询默认 null。 */
  audioBase64?: string | null;
  format: "wav";
}

/** 有声书工作台首屏：不含章节正文 / bible / plotBeats。 */
export interface AudiobookWorkspaceChapterOption {
  id: string;
  order: number;
  title: string;
}

export interface AudiobookWorkspaceCharacter {
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
  ttsPreviewAudioPath?: string | null;
  ttsPreviewSampleText?: string | null;
  ttsPreviewFingerprint?: string | null;
  ttsPreviewGeneratedAt?: string | null;
  voicePreviewStatus?: CharacterVoicePreviewStatus | null;
}

/** 与 precheck 对齐的音色绑定状态 */
export type CharacterVoiceBindingStatus = "configured" | "missing" | "invalid";

/**
 * 建议动作 — 纯函数可由 binding+mode+preview 推出，无 IO。
 * prepare 失败不回写为另一 action；失败在 job item.error。
 */
export type CharacterVoiceReadinessAction =
  | "none"
  | "apply_plan"
  | "generate_preview"
  | "manual_clone"
  | "fix_invalid";

export interface CharacterVoiceReadinessItem {
  characterId: string;
  characterName: string;
  castRole?: string | null;
  gender?: string | null;
  voiceBindingStatus: CharacterVoiceBindingStatus;
  ttsMode: AudiobookTtsMode;
  ttsVoice?: string | null;
  voiceDetailLabel: string;
  previewStatus: CharacterVoicePreviewStatus;
  previewGeneratedAt?: string | null;
  action: CharacterVoiceReadinessAction;
  blocksTask: boolean;
  blocksReadyPreview: boolean;
  reason?: string | null;
}

export interface AudiobookVoiceReadinessSummary {
  novelId: string;
  characterTotal: number;
  voiceConfigured: number;
  voiceMissing: number;
  voiceInvalid: number;
  previewReady: number;
  previewStale: number;
  previewMissing: number;
  voiceOk: boolean;
  previewOk: boolean;
  readyForWorkbench: boolean;
  narrator: AudiobookNarratorConfig & { valid: boolean };
  items: CharacterVoiceReadinessItem[];
  warnings: string[];
  blockingErrors: string[];
}

export interface AudiobookVoiceReadinessAssessInput {
  characterIds?: string[];
}

export interface AudiobookVoiceReadinessPrepareInput {
  characterIds?: string[];
  fillMissingVoice?: boolean;
  generatePreview?: boolean;
  regenerateStale?: boolean;
  planStrategy?: AudiobookVoicePlanStrategy;
  previewText?: string;
}

export type AudiobookVoiceReadinessJobStatus =
  | "queued"
  | "running"
  | "succeeded"
  | "failed"
  | "cancelled";

export type AudiobookVoiceReadinessJobItemStatus =
  | "pending"
  | "running"
  | "skipped"
  | "succeeded"
  | "failed";

export interface AudiobookVoiceReadinessJobItem {
  characterId: string;
  characterName: string;
  status: AudiobookVoiceReadinessJobItemStatus;
  phase: "voice" | "preview" | "idle";
  error?: string | null;
  previewStatusAfter?: CharacterVoicePreviewStatus | null;
}

export interface AudiobookVoiceReadinessJob {
  id: string;
  novelId: string;
  status: AudiobookVoiceReadinessJobStatus;
  progress: number;
  currentCharacterId?: string | null;
  currentCharacterName?: string | null;
  currentLabel?: string | null;
  createdAt: string;
  updatedAt: string;
  startedAt?: string | null;
  finishedAt?: string | null;
  cancelRequested: boolean;
  options: {
    fillMissingVoice: boolean;
    generatePreview: boolean;
    regenerateStale: boolean;
    planStrategy: AudiobookVoicePlanStrategy;
    characterIds?: string[];
    previewText?: string;
  };
  items: AudiobookVoiceReadinessJobItem[];
  summary?: {
    appliedVoice: number;
    generatedPreview: number;
    skipped: number;
    failed: number;
  } | null;
  lastError?: string | null;
}

export interface AudiobookVoiceReadinessPrepareResult {
  job: AudiobookVoiceReadinessJob;
}

/** POST prepare 409 的 data 形状（不改全局 ApiResponse） */
export interface AudiobookVoiceReadinessJobActiveErrorData {
  code: "READINESS_JOB_ACTIVE";
  activeJobId: string;
}

export interface AudiobookWorkspaceBootstrapReadiness {
  voiceOk: boolean;
  previewOk: boolean;
  readyForWorkbench: boolean;
  voiceConfigured: number;
  voiceMissing: number;
  voiceInvalid: number;
  previewReady: number;
  previewStale: number;
  previewMissing: number;
  characterTotal: number;
  narratorValid: boolean;
  attentionItems: Array<{
    characterId: string;
    characterName: string;
    action: CharacterVoiceReadinessAction;
    previewStatus: CharacterVoicePreviewStatus;
    voiceBindingStatus: CharacterVoiceBindingStatus;
  }>;
  activeReadinessJobId?: string | null;
}

export interface AudiobookWorkspaceBootstrap {
  novelId: string;
  title: string;
  audiobookNarratorVoice: string | null;
  audiobookNarratorStyle: string | null;
  chapters: AudiobookWorkspaceChapterOption[];
  characters: AudiobookWorkspaceCharacter[];
  chapterCount: number;
  characterCount: number;
  /** 路由组装的就绪摘要；工作台徽章 SoT */
  readiness?: AudiobookWorkspaceBootstrapReadiness;
}
