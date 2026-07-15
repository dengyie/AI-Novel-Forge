import type { ApiResponse } from "@ai-novel/shared/types/api";
import type { LLMProvider } from "@ai-novel/shared/types/llm";
import type {
  AudiobookChapterReprocessMode,
  AudiobookPrecheckResult,
  AudiobookScopeMode,
  AudiobookTaskAnnotationsView,
  AudiobookTaskDetail,
  AudiobookTaskSummary,
  AudiobookVoiceCatalogItem,
  AudiobookVoicePlanApplyInput,
  AudiobookVoicePlanApplyResult,
  AudiobookVoicePlanSuggestInput,
  AudiobookVoicePlanSuggestResult,
  AudiobookVoicePreviewInput,
  AudiobookVoicePreviewResult,
  AudiobookWorkspaceBootstrap,
  CreateAudiobookTaskInput,
} from "@ai-novel/shared/types/audiobook";
import { API_AUTH_TOKEN, API_BASE_URL } from "@/lib/constants";
import { apiClient } from "../client";

export async function listAudiobookVoices() {
  const { data } = await apiClient.get<ApiResponse<AudiobookVoiceCatalogItem[]>>("/novels/audiobook/voices");
  return data;
}

/** 有声书页首屏：不含章节正文的轻量 bootstrap。 */
export async function getAudiobookWorkspace(novelId: string) {
  const { data } = await apiClient.get<ApiResponse<AudiobookWorkspaceBootstrap>>(
    `/novels/${novelId}/audiobook/workspace`,
  );
  return data;
}

export async function suggestAudiobookVoicePlan(
  novelId: string,
  payload: AudiobookVoicePlanSuggestInput = {},
) {
  const { data } = await apiClient.post<ApiResponse<AudiobookVoicePlanSuggestResult>>(
    `/novels/${novelId}/audiobook/voice-plan/suggest`,
    payload,
  );
  return data;
}

export async function applyAudiobookVoicePlan(
  novelId: string,
  payload: AudiobookVoicePlanApplyInput,
) {
  const { data } = await apiClient.post<ApiResponse<AudiobookVoicePlanApplyResult>>(
    `/novels/${novelId}/audiobook/voice-plan/apply`,
    payload,
  );
  return data;
}

export async function previewAudiobookVoice(
  novelId: string,
  payload: AudiobookVoicePreviewInput,
) {
  const { data } = await apiClient.post<ApiResponse<AudiobookVoicePreviewResult>>(
    `/novels/${novelId}/audiobook/voice-preview`,
    payload,
  );
  return data;
}

export async function precheckAudiobookTask(
  novelId: string,
  payload: Omit<CreateAudiobookTaskInput, "novelId">,
) {
  const { data } = await apiClient.post<ApiResponse<AudiobookPrecheckResult>>(
    `/novels/${novelId}/audiobook/precheck`,
    payload,
  );
  return data;
}

export async function createAudiobookTask(
  novelId: string,
  payload: Omit<CreateAudiobookTaskInput, "novelId"> & {
    provider?: LLMProvider;
    model?: string;
    temperature?: number;
  },
) {
  const { data } = await apiClient.post<ApiResponse<AudiobookTaskDetail>>(
    `/novels/${novelId}/audiobook/tasks`,
    payload,
  );
  return data;
}

export async function listAudiobookTasks(novelId: string) {
  const { data } = await apiClient.get<ApiResponse<AudiobookTaskSummary[]>>(
    `/novels/${novelId}/audiobook/tasks`,
  );
  return data;
}

export async function getAudiobookTask(novelId: string, taskId: string) {
  const { data } = await apiClient.get<ApiResponse<AudiobookTaskDetail>>(
    `/novels/${novelId}/audiobook/tasks/${taskId}`,
  );
  return data;
}

export async function cancelAudiobookTask(novelId: string, taskId: string) {
  const { data } = await apiClient.post<ApiResponse<AudiobookTaskDetail>>(
    `/novels/${novelId}/audiobook/tasks/${taskId}/cancel`,
  );
  return data;
}

export async function getAudiobookAnnotations(novelId: string, taskId: string) {
  const { data } = await apiClient.get<ApiResponse<AudiobookTaskAnnotationsView>>(
    `/novels/${novelId}/audiobook/tasks/${taskId}/annotations`,
  );
  return data;
}

export async function reprocessAudiobookChapter(
  novelId: string,
  taskId: string,
  chapterId: string,
  mode: AudiobookChapterReprocessMode,
) {
  const { data } = await apiClient.post<ApiResponse<AudiobookTaskDetail>>(
    `/novels/${novelId}/audiobook/tasks/${taskId}/chapters/${chapterId}/reprocess`,
    { mode },
  );
  return data;
}

export interface AudiobookMediaAccessResult {
  urlPath: string;
  access: string | null;
  expiresAt: number | null;
}

/** 服务端签发短时 access，拼成可给 <audio>/<a> 用的完整 URL */
export async function issueAudiobookMediaUrl(
  novelId: string,
  taskId: string,
  resource:
    | { resource: "full" }
    | { resource: "full_m4b" }
    | { resource: "chapter"; chapterId: string },
): Promise<string> {
  const body = resource.resource === "full"
    ? { resource: "full" as const }
    : resource.resource === "full_m4b"
      ? { resource: "full_m4b" as const }
      : { resource: "chapter" as const, chapterId: resource.chapterId };
  const { data } = await apiClient.post<ApiResponse<AudiobookMediaAccessResult>>(
    `/novels/${novelId}/audiobook/tasks/${taskId}/media-access`,
    body,
  );
  const path = data.data?.urlPath;
  if (!path) {
    if (resource.resource === "full_m4b") {
      return buildAudiobookFullM4bUrl(novelId, taskId);
    }
    if (resource.resource === "chapter") {
      return buildAudiobookChapterAudioUrl(novelId, taskId, resource.chapterId);
    }
    return buildAudiobookFullAudioUrl(novelId, taskId);
  }
  const base = API_BASE_URL.replace(/\/$/, "");
  if (path.startsWith("http://") || path.startsWith("https://")) {
    return path;
  }
  return `${base}${path.startsWith("/") ? path : `/${path}`}`;
}

export function buildAudiobookFullAudioUrl(novelId: string, taskId: string): string {
  const base = API_BASE_URL.replace(/\/$/, "");
  return `${base}/novels/${encodeURIComponent(novelId)}/audiobook/tasks/${encodeURIComponent(taskId)}/audio/full`;
}

export function buildAudiobookFullM4bUrl(novelId: string, taskId: string): string {
  const base = API_BASE_URL.replace(/\/$/, "");
  return `${base}/novels/${encodeURIComponent(novelId)}/audiobook/tasks/${encodeURIComponent(taskId)}/audio/full.m4b`;
}

export function buildAudiobookChapterAudioUrl(
  novelId: string,
  taskId: string,
  chapterId: string,
): string {
  const base = API_BASE_URL.replace(/\/$/, "");
  return `${base}/novels/${encodeURIComponent(novelId)}/audiobook/tasks/${encodeURIComponent(taskId)}/audio/chapters/${encodeURIComponent(chapterId)}`;
}

/**
 * @deprecated 原生 <audio>/<a> 无法带自定义 header；请用 issueAudiobookMediaUrl。
 * 保留给 fetch(blob) 场景。
 */
export function audiobookAudioRequestHeaders(): Record<string, string> {
  if (!API_AUTH_TOKEN) {
    return {};
  }
  return {
    "X-API-Token": API_AUTH_TOKEN,
    Authorization: `Bearer ${API_AUTH_TOKEN}`,
  };
}

export type {
  AudiobookScopeMode,
  AudiobookTaskDetail,
  AudiobookTaskSummary,
  AudiobookPrecheckResult,
  AudiobookTaskAnnotationsView,
  AudiobookChapterReprocessMode,
};
