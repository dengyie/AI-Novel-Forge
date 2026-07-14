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

export type AudiobookTaskStatus =
  | "queued"
  | "running"
  | "succeeded"
  | "failed"
  | "cancelled";

export type AudiobookScopeMode = "chapter" | "range" | "full";

export type AudiobookSpeakerKind = "narrator" | "character";

export interface AudiobookCharacterVoiceConfig {
  characterId: string;
  characterName: string;
  ttsVoice: string;
  ttsStyle?: string | null;
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
  voice: string;
  style?: string | null;
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
}

export interface AudiobookPrecheckMissingVoice {
  characterId: string;
  characterName: string;
  reason: string;
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
  outputDir?: string | null;
  fullAudioPath?: string | null;
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
