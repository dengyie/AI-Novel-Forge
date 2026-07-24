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
 * 段通道（先于说话人）：决定是否出声与默认 renderPolicy。
 * 缺省时由 speakerKind 推断 speech|narration。
 */
export type AudiobookSegmentKind =
  | "speech"
  | "narration"
  | "typed"
  | "chat"
  | "on_screen"
  | "phone"
  | "broadcast"
  | "inner"
  | "quote_read"
  | "sfx_cue";

export const AUDIOBOOK_SEGMENT_KINDS = [
  "speech",
  "narration",
  "typed",
  "chat",
  "on_screen",
  "phone",
  "broadcast",
  "inner",
  "quote_read",
  "sfx_cue",
] as const;

export function isAudiobookSegmentKind(value: string): value is AudiobookSegmentKind {
  return (AUDIOBOOK_SEGMENT_KINDS as readonly string[]).includes(value);
}

/**
 * 合成策略。
 * - tts：正常合成
 * - tts_neutral：中性旁白（屏幕字可选）
 * - skip：不进 TTS（手机打字默认）
 * - beep：占位音（二期）
 */
export type AudiobookRenderPolicy = "tts" | "tts_neutral" | "skip" | "beep";

export const AUDIOBOOK_RENDER_POLICIES = ["tts", "tts_neutral", "skip", "beep"] as const;

export function isAudiobookRenderPolicy(value: string): value is AudiobookRenderPolicy {
  return (AUDIOBOOK_RENDER_POLICIES as readonly string[]).includes(value);
}

/** 任务级质量标记（succeeded 仍可能带 degraded flags） */
export type AudiobookQualityFlag =
  | "cast_ok"
  | "cast_degraded"
  | "narrator_fallback"
  | "low_quote_coverage"
  | "high_unresolved";

export const AUDIOBOOK_QUALITY_FLAGS = [
  "cast_ok",
  "cast_degraded",
  "narrator_fallback",
  "low_quote_coverage",
  "high_unresolved",
] as const;

/**
 * 段级语境表演开关。
 * - off：完全沿用角色卡静态 style/design
 * - characters：仅角色对白注入 delivery
 * - all：角色 + 旁白轻量 delivery
 *
 * 默认约定（勿混）：
 * - 工作台 UI 默认 characters（成书听感）
 * - createTask API / resolveDeliveryStyleMode 代码默认 off；可用 env AUDIOBOOK_DELIVERY_STYLE_MODE 覆盖
 * - 固定试听 / 一键就绪只用角色基线，不走 delivery
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
  /** 全站 VoiceAsset.id（library clone）。 */
  ttsVoiceAssetId?: string | null;
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
  /**
   * 通道种类；缺省由 speakerKind 推断（character→speech, narrator→narration）。
   * typed/chat/on_screen 等用于决定是否 skip 合成。
   */
  segmentKind?: AudiobookSegmentKind | null;
  /**
   * 合成策略；缺省：typed/chat/on_screen/sfx_cue → skip，其余 tts。
   * expandSegmentsToChunkJobs 过滤非 tts* 段。
   */
  renderPolicy?: AudiobookRenderPolicy | null;
  /** 审计：通道线索（「微信气泡」「输入框」） */
  channelHint?: string | null;
  /** diarize 置信度 0–1；规则装配可空 */
  diarizeConfidence?: number | null;
  /** 对齐 rule span 的 id 列表（审计） */
  quoteSpanIds?: string[] | null;
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
  /**
   * 标注时 speaker 未匹配角色卡，已强制旁白音色出声。
   * 仅审计/UI/质量警告；合成仍走旁白 voice。
   */
  speakerUnresolved?: boolean;
  /** 模型原始 speaker 名（未匹配时保留，便于补 alias） */
  unresolvedSpeakerName?: string | null;
}

/** 章级表演质量指标（annotate 后写入，供 UI / 听测门禁） */
export interface AudiobookDeliveryChapterStats {
  segmentCount: number;
  characterSegmentCount: number;
  narratorSegmentCount: number;
  /** 最终保留 delivery 的段数（角色 + 旁白） */
  deliveryApplied: number;
  /** 角色段中最终保留 delivery 的段数 */
  characterDeliveryApplied: number;
  /** 旁白段中最终保留 delivery 的段数（mode=all） */
  narratorDeliveryApplied: number;
  /** 模型给了 delivery 但 normalize/适用失败被剥掉的段数 */
  deliveryPeeled: number;
  /**
   * 采用率 0–1。
   * 有角色段时：characterDeliveryApplied / characterSegmentCount（不把旁白计入分子/分母）。
   * 全旁白章时：narratorDeliveryApplied / narratorSegmentCount。
   */
  deliveryApplyRate: number;
  /** resolve 后 style/designPrompt 平均长度 */
  avgResolvedUserLen: number;
  /** expand 后 chunk 数 / 段数；>1 表示被切碎 */
  mergeChunkMultiplier?: number | null;
  /** 标注时未匹配角色卡、强制旁白出声的段数 */
  unresolvedSpeakerCount?: number;
  /** 未匹配原始名（去重，最多约 8 个，供警告/UI） */
  unresolvedSpeakerNames?: string[];
}

/**
 * 章级通道/分轨质量（rule span + diarize 后写入）。
 * 与 deliveryStats 正交：先 cast，再表演。
 */
export interface AudiobookDiarizeChapterStats {
  quoteSpanCount: number;
  /** 已落入 speech/phone/broadcast/quote_read，或已正确 skip 的 typed/chat/on_screen */
  quoteCoveredCount: number;
  /** covered / span；span=0 时为 1 */
  quoteCoverage: number;
  /** 应出声 quote 覆盖率（不含通道 skip 类 span） */
  spokenQuoteCoverage: number;
  spokenQuoteSpanCount: number;
  spokenQuoteCoveredCount: number;
  typedSkippedCount: number;
  chatSkippedCount: number;
  onScreenSkippedCount: number;
  speechCharacterCount: number;
  narrationCount: number;
  unresolvedSpeakerCount: number;
  /** 整章旁白兜底（LLM/装配失败） */
  wholeChapterNarratorFallback: boolean;
  /** 综合门禁 */
  castOk: boolean;
  failReasons?: string[];
  /**
   * 装配来源：
   * - llm：块均来自 LLM（可含章内分块拼接）
   * - llm_rules_hybrid：部分块 LLM + 失败块规则补齐
   * - rules：整章 L1 规则
   * - narrator_fallback：整章旁白
   */
  assemblySource?: "llm" | "llm_rules_hybrid" | "rules" | "narrator_fallback" | null;
}

export interface AudiobookChapterAnnotation {
  chapterId: string;
  chapterOrder: number;
  chapterTitle: string;
  segments: AudiobookDialogueSegment[];
  annotatedAt?: string | null;
  /**
   * 硬失败/整章回退等用户可见错误。
   * 不得把「已用规则装配成功」写进本字段——那类诊断用 assemblyNote。
   * 门禁 isWholeChapterNarratorFallback **不**再把非空 error 当旁白回退。
   */
  error?: string | null;
  /**
   * 非致命装配说明（如 LLM 失败后 L1 规则成功、ops 注入来源）。
   * 进 qualityWarnings，不触发 narrator_fallback。
   */
  assemblyNote?: string | null;
  /**
   * LLM 未覆盖全章正文时 true（旧路径单窗截断；或分块失败且无规则补洞时）。
   * 分块 diarize/annotate 覆盖全章（含失败块规则补齐）则为 false。
   * UI 勿再写死「正文截断 28k」。
   */
  contentTruncated?: boolean;
  /** 段级表演统计；mode=off 时也可有零值 */
  deliveryStats?: AudiobookDeliveryChapterStats | null;
  /** 通道/分轨质量；缺省表示旧任务未计算 */
  diarizeStats?: AudiobookDiarizeChapterStats | null;
  /**
   * 整章旁白回退标记。门禁只认本字段 / diarizeStats 同名字段，不认 error 字符串。
   * buildNarratorOnlyAnnotation 恒 true。
   */
  wholeChapterNarratorFallback?: boolean;
  /**
   * 标注时生效的 deliveryStyleMode 快照。
   * resume 时若与任务 progressJson 不一致，应 reannotate 而非盲用旧段。
   */
  deliveryStyleMode?: DeliveryStyleMode | null;
  /**
   * 标注时章节正文 sha1 前 16 hex（trim + \n 归一后）。
   * resume 时与当前 chapter.content 不一致则 reannotate，避免改稿后盲用旧音。
   */
  contentSha1?: string | null;
  /**
   * 装配来源（与 diarizeStats.assemblySource 对齐的顶层快照）。
   * inject / 运维脚本应优先读本字段；旧注解可能仅有 diarizeStats。
   */
  assemblySource?: "llm" | "llm_rules_hybrid" | "rules" | "narrator_fallback" | null;
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
   * 段级语境表演模式。
   * 缺省：服务端 resolveDeliveryStyleMode → 代码默认 off，env AUDIOBOOK_DELIVERY_STYLE_MODE 可覆盖。
   * 工作台 UI 会显式传 characters（与 API 默认不同）。固定试听/readiness 不走本字段。
   */
  deliveryStyleMode?: DeliveryStyleMode;
  /**
   * 续生成路径专用：显式指定要纳入任务的章节 id 子集。
   * schemaMode 三选一仍需填（仅作合法性占位），precheck 命中本字段时直接按 id 子集解析，
   * 跳过 chapterId/range 派生。前端建任务表单不暴露本字段。
   */
  explicitChapterIds?: string[];
}

/**
 * 在已交付父任务上续跑一个隐闭子任务，补齐缺失章。
 * chapterIds 必须是父任务 chapterIdsJson 内当前未就绪的章；超出会被拒。
 */
export interface ContinueAudiobookTaskInput {
  parentTaskId: string;
  chapterIds: string[];
  mode?: "resynthesize";
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
  /**
   * 逐章生成进度（顺序与 chapterIds 一致；ready 以磁盘 chapter.wav 为准并 reconcile，
   * 其余以管线实时 emit 为准）。totalChunks=0 表示该章尚未标注，前端显示「等待中」。
   * 纯展示增量，与 progress/completedChapterCount/readyChapterIds 不重复计数。
   */
  chapterProgress?: Array<{
    chapterId: string;
    status: "pending" | "annotating" | "synthesizing" | "merging" | "ready" | "failed";
    completedChunks: number;
    totalChunks: number;
    detail?: string;
  }>;
  outputDir?: string | null;
  fullAudioPath?: string | null;
  /** 全书 WAV 是否可交付（磁盘 full-book.wav 存在）。 */
  fullAudioReady?: boolean;
  /** 全书 m4b 状态：ready 才展示下载；skipped/failed 仅提示。 */
  m4bStatus?: "ready" | "skipped" | "failed" | null;
  /** 成功后是否已清理 chunk-*.wav（章 wav / 全书仍保留）。 */
  chunksPruned?: boolean;
  /**
   * 续生成失败章 id：子任务执行失败时写入父 progressJson，前端对照 list 据此标黄
   * 「上次续生成失败」+ 仍可再点「生成」重试。空或缺失=无续生成失败记录。
   */
  failedContinueChapters?: string[];
  /**
   * 续生成子任务回写的父 id；父任务的 summary 上该字段保持空。
   * listByNovel 应用端据此过滤隐闭子任务，前端列表只看见父行。
   */
  parentTaskId?: string;
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
export type AudiobookVoicePlanStrategy =
  | "auto"
  | "preset_only"
  | "prefer_design"
  /** 优先匹配全站 approved VoiceAsset（clone）；无匹配再回退 design/preset */
  | "prefer_library"
  /** Brief+规则预筛后走 LLM 选库（仅返回候选 assetId）；失败回退规则 match */
  | "prefer_library_ai";

export const AUDIOBOOK_VOICE_PLAN_STRATEGIES = [
  "auto",
  "preset_only",
  "prefer_design",
  "prefer_library",
  "prefer_library_ai",
] as const;

export function isAudiobookVoicePlanStrategy(
  value: string,
): value is AudiobookVoicePlanStrategy {
  return (AUDIOBOOK_VOICE_PLAN_STRATEGIES as readonly string[]).includes(value);
}

/** 音色分簇（规划分配维，非听感证明）：主角 / 主角团 / 路人 / 旁白 */
export type AudiobookVoiceCluster = "lead" | "cast" | "extra" | "narrator";

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
  /**
   * clone 时必有：全站 VoiceAsset.id（仅 approved 可建议/apply）。
   * 客户端禁止写 ttsRefAudioPath；apply 服务端 resolve 绑库。
   */
  ttsVoiceAssetId?: string | null;
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
  /** 分簇（prefer_design 用；可选兼容字段） */
  cluster?: AudiobookVoiceCluster;
  /** 当前已绑定摘要 */
  currentBinding?: {
    ttsMode?: string | null;
    ttsVoice?: string | null;
    ttsDesignPrompt?: string | null;
    ttsVoiceAssetId?: string | null;
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
  /** 旁白等占用的预置，角色 preset 池剔除 */
  reservedPresets?: string[];
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
    /** ttsMode=clone 且带 ttsVoiceAssetId 的库推荐项 */
    cloneCount: number;
    overwriteCount: number;
    /** reason 含 collision:soft 的 design 项（prompt 启发式，非听感证明） */
    softCollisionCount: number;
    /** reason 含 slot:override 的 design 项 */
    slotOverrideCount: number;
    /** onlyMissing 时已绑定 design 无结构化标签、用卡字段推断占槽 */
    seedInferredCount: number;
    /** design 文案平均长度（可选观测） */
    designPromptAvgLen?: number;
    /** reason 含 archetype: 的 design 项 */
    archetypeHitCount?: number;
  };
}

export interface AudiobookVoicePlanApplyItem {
  characterId: string;
  ttsMode: AudiobookTtsMode;
  ttsVoice?: string | null;
  ttsStyle?: string | null;
  ttsDesignPrompt?: string | null;
  /** clone 时必填：仅服务端 approved VoiceAsset.id，禁止客户端 path */
  ttsVoiceAssetId?: string | null;
  speakerAliases?: string[] | null;
}

export interface AudiobookVoicePlanApplyInput {
  items: AudiobookVoicePlanApplyItem[];
  /** 已绑定是否覆盖；默认 false 跳过已配置 */
  overwrite?: boolean;
}

export interface AudiobookVoicePlanApplyResult {
  novelId: string;
  applied: Array<{
    characterId: string;
    characterName: string;
    ttsMode: string;
    ttsVoiceAssetId?: string | null;
  }>;
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
  /** 可选样例句；默认系统鉴声句库。 */
  text?: string;
  /**
   * 同配置连抽次数。默认 3（听感主路径）；1 = 旧行为立即写 preview.wav。
   * 上限 5。candidates>1 时不覆盖已有 ready preview，须再调 adopt-candidate。
   */
  candidates?: number;
  /**
   * candidates>1 时是否自动把工程初选 winner 写入正式 preview。
   * prepare/job 默认 true；交互 UI 默认 false（等人耳选）。
   */
  autoAdoptWinner?: boolean;
}

export interface CharacterVoicePreviewCandidate {
  id: string;
  index: number;
  durationMs: number;
  /** 相对路径；播放前需 media-access 或带 access query */
  audioUrl: string | null;
  audioBase64?: string | null;
  /** 是否被工程初选 / 人耳 adopt 为正式 preview */
  selected?: boolean;
}

export interface CharacterVoicePreviewGenerateResult {
  characterId: string;
  characterName: string;
  ttsMode: AudiobookTtsMode;
  voice?: string | null;
  sampleText: string;
  format: "wav";
  candidates: CharacterVoicePreviewCandidate[];
  /** 已写入正式 preview 时非 null（candidates=1 或 autoAdoptWinner） */
  adopted: CharacterVoicePreviewAsset | null;
  /** 工程初选 winner 的 candidate id（未人耳确认时仅供参考） */
  suggestedCandidateId?: string | null;
}

export interface CharacterVoicePreviewAdoptCandidateInput {
  candidateId: string;
}

/**
 * 将「选优后的正式 preview」升格为 clone 身份锚（Design→Clone）。
 * 禁止半绑定：必须有与当前配置指纹一致的 ready preview（stale 拒绝）。
 */
export interface CharacterVoiceAdoptPreviewAsCloneInput {
  /**
   * 可选：先采用该候选再升格；不传则要求当前 preview 已 ready。
   * 多抽未 adopt 时客户端应传此字段或先走 adopt-candidate。
   */
  candidateId?: string;
  /**
   * 升格后是否立刻用 clone 再合成 1 条对照试听并写入 preview（默认 false，避免静默打上游）。
   * 对照失败不回滚 clone 绑定，contrastPreview 为 null。
   */
  regeneratePreviewUnderClone?: boolean;
  /** 对照句；默认沿用当前 preview 样例或句库。 */
  contrastText?: string;
}

export interface CharacterVoiceAdoptPreviewAsCloneResult {
  characterId: string;
  characterName: string;
  ttsMode: "clone";
  ttsRefAudioPath: string;
  /** 升格来源 preview 路径（拷贝源） */
  sourcePreviewPath: string;
  /** design 文案保留供审计（mode 已是 clone） */
  retainedDesignPrompt: string | null;
  preview: CharacterVoicePreviewAsset;
  /** 若请求 regenerate 且成功，为 clone 模式下的新 preview；否则 null */
  contrastPreview: CharacterVoicePreviewAsset | null;
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
  ttsVoiceAssetId?: string | null;
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
  /** library clone 时填充 */
  ttsVoiceAssetId?: string | null;
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
  /** 每角色多抽次数，默认 3，上限 5 */
  candidatesPerCharacter?: number;
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
    candidatesPerCharacter?: number;
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

/** POST /novels/audiobook/workspace-overview 请求体 */
export interface AudiobookWorkspaceOverviewRequest {
  novelIds: string[];
}

/**
 * 列表级 readiness 摘要。
 * 与工作台 assess 同源聚合字段，但 clone ref **不做磁盘 probe**。
 */
export interface AudiobookWorkspaceOverviewReadiness {
  voiceOk: boolean;
  voiceConfigured: number;
  characterTotal: number;
  previewReady: number;
  previewMissing: number;
  previewStale: number;
  /** 仅作辅信息；列表主「可生成」看 voiceOk */
  readyForWorkbench: boolean;
  narratorValid: boolean;
}

export interface AudiobookWorkspaceOverviewLatestTask {
  id: string;
  status: AudiobookTaskStatus;
  progress: number;
  /** 仅当廉价可得时填充；overview 禁止 50× 磁盘 stat */
  fullAudioReady?: boolean;
  m4bStatus?: string | null;
  updatedAt: string;
}

/** 选书页态势：一本小说的轻量摘要 */
export interface AudiobookWorkspaceNovelOverview {
  novelId: string;
  readiness: AudiobookWorkspaceOverviewReadiness | null;
  latestTask: AudiobookWorkspaceOverviewLatestTask | null;
  /**
   * 内存 readiness job 是否 active。best-effort：
   * 进程重启 / 非本实例 → 可能 false，前端不得当错误。
   */
  activeReadinessJob: boolean;
}

export interface AudiobookWorkspaceOverviewResult {
  items: AudiobookWorkspaceNovelOverview[];
  /** novelIds 超过上限时截断前 50 */
  truncated?: boolean;
}

// ---------------------------------------------------------------------------
// 全站 VoiceAsset 库（Milestone A）：JSON registry + voice-refs/global
// ---------------------------------------------------------------------------

export type VoiceAssetKind = "clone_ref" | "design_prompt" | "preset_alias";
export const VOICE_ASSET_KINDS = ["clone_ref", "design_prompt", "preset_alias"] as const;
export function isVoiceAssetKind(value: string): value is VoiceAssetKind {
  return (VOICE_ASSET_KINDS as readonly string[]).includes(value);
}

export type VoiceAssetStatus = "draft" | "approved" | "archived" | "deprecated";
export const VOICE_ASSET_STATUSES = ["draft", "approved", "archived", "deprecated"] as const;
export function isVoiceAssetStatus(value: string): value is VoiceAssetStatus {
  return (VOICE_ASSET_STATUSES as readonly string[]).includes(value);
}

export type VoiceAssetBackendTarget = "mimo_chat_audio" | "kokoro" | "other";

export interface VoiceAssetLicense {
  source: string;
  rights: string;
  notes?: string | null;
  url?: string | null;
}

export interface VoiceAssetPrimaryFile {
  path: string;
  sha256: string;
  bytes: number;
  format: "wav";
  sampleRate?: number | null;
  durationSec?: number | null;
  channels?: number | null;
}

/** 人耳审核轻量字段；升 approved 前 clone_ref 须有 heardAt，且与当前 primaryFile.sha256 一致。 */
export interface VoiceAssetReview {
  /** ISO 时间：库级音频曾被拉取/播放 */
  heardAt?: string | null;
  heardBy?: string | null;
  /** 试听时 primaryFile.sha256；文件覆盖后与当前 sha 不一致则须重听 */
  heardSha256?: string | null;
}

export interface VoiceAsset {
  id: string;
  slug: string;
  displayName: string;
  kind: VoiceAssetKind;
  status: VoiceAssetStatus;
  tags: string[];
  sampleText?: string | null;
  designPrompt?: string | null;
  presetVoice?: string | null;
  license: VoiceAssetLicense;
  backendTargets: VoiceAssetBackendTarget[];
  primaryFile?: VoiceAssetPrimaryFile | null;
  packId?: string | null;
  /** 可选审核状态（E：人耳） */
  review?: VoiceAssetReview | null;
  createdAt: string;
  updatedAt: string;
}

export interface VoiceAssetListQuery {
  status?: VoiceAssetStatus | VoiceAssetStatus[];
  kind?: VoiceAssetKind | VoiceAssetKind[];
  tag?: string;
  q?: string;
  /** 默认 200，硬顶 500；非有限数回落默认 */
  limit?: number;
  /** 0-based；非有限数按 0 */
  offset?: number;
}

export interface VoiceAssetListResult {
  items: VoiceAsset[];
  total: number;
}

export interface VoiceAssetImportFromFileInput {
  sourcePath: string;
  slug: string;
  displayName: string;
  kind?: VoiceAssetKind;
  status?: VoiceAssetStatus;
  tags?: string[];
  sampleText?: string | null;
  designPrompt?: string | null;
  license: VoiceAssetLicense;
  backendTargets?: VoiceAssetBackendTarget[];
  packId?: string | null;
  overwrite?: boolean;
}

export interface VoiceAssetImportPackInput {
  packRoot?: string;
  forceStatus?: VoiceAssetStatus | null;
  overwrite?: boolean;
}

export interface VoiceAssetImportPackResult {
  packId: string;
  imported: VoiceAsset[];
  skipped: Array<{ slug: string; reason: string }>;
  failed: Array<{ slug: string; reason: string }>;
}

export interface VoiceAssetBindCharacterInput {
  voiceAssetId: string;
}

export interface VoiceAssetBindCharacterResult {
  novelId: string;
  characterId: string;
  voiceAssetId: string;
  ttsMode: "clone";
  ttsRefAudioPath: string;
}

export interface VoiceAssetSetStatusInput {
  status: VoiceAssetStatus;
}

// ---------------------------------------------------------------------------
// 人物卡 ↔ VoiceAsset 对靠链路：单角色 top-N 候选
// ---------------------------------------------------------------------------

/** 对靠候选命中维（与 matchLibraryAssetsTopN 对齐，供 UI 展示打分理由） */
export interface VoiceLibraryMatchDimensions {
  /** 候选在该角色 gender 桶上的命中：hit/open/miss */
  gender: "hit" | "open" | "miss";
  /** cluster 命中：exact/soft/open/weak/none */
  cluster: "exact" | "soft" | "open" | "weak" | "none";
  /** scope 命中：hit/open/miss */
  scope: "hit" | "open" | "miss";
}

/** 单条对靠候选；仅 approved clone_ref */
export interface AudiobookVoiceLibraryMatchItem {
  voiceAssetId: string;
  slug: string;
  displayName: string;
  /** 打分（越高越靠前） */
  score: number;
  /** 中文可读打分理由（bits） */
  reason: string;
  dimensions: VoiceLibraryMatchDimensions;
  /** 该资产是否已被本书其他角色绑定（assetId 或同 speaker） */
  occupiedBy: string[] | null;
  /**
   * speaker/slot 已占但允许人工覆盖：false=未占可放心选；true=占用工具标注。
   * 不作为硬门禁，仅 UI 提示。
   */
  speakerOccupied: boolean;
}

export interface AudiobookVoiceLibraryMatchesResult {
  novelId: string;
  characterId: string;
  /** 推断 gender 桶（用于 UI 展示理由上下文） */
  genderBucket: "male" | "female" | "unknown";
  /** 推断分簇 */
  cluster: "lead" | "cast" | "extra" | "narrator";
  candidates: AudiobookVoiceLibraryMatchItem[];
  /** 被门禁排除的候选计数（调试/提示用） */
  excludedCount: number;
}

export interface VoiceDesignRewriteInput {
  /** 可选：覆盖当前角色卡草稿描述作为 rewrite 输入 */
  currentDesignPrompt?: string | null;
  /** 额外约束（语速/情绪等） */
  notes?: string | null;
  provider?: string | null;
  model?: string | null;
}

export interface VoiceDesignRewriteResult {
  designPrompt: string;
  tags: string[];
  source: "llm" | "rule_fallback";
  /** 未写入角色卡；仅候选 */
  applied: false;
  /** rule_fallback 时可选原因（可观测，非密钥） */
  fallbackReason?: string | null;
}
