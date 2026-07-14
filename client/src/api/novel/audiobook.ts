import type { ApiResponse } from "@ai-novel/shared/types/api";
import type { LLMProvider } from "@ai-novel/shared/types/llm";
import type {
  AudiobookPrecheckResult,
  AudiobookScopeMode,
  AudiobookTaskDetail,
  AudiobookTaskSummary,
  AudiobookVoiceCatalogItem,
  CreateAudiobookTaskInput,
} from "@ai-novel/shared/types/audiobook";
import { API_AUTH_TOKEN, API_BASE_URL } from "@/lib/constants";
import { apiClient } from "../client";

export async function listAudiobookVoices() {
  const { data } = await apiClient.get<ApiResponse<AudiobookVoiceCatalogItem[]>>("/novels/audiobook/voices");
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

export interface AudiobookMediaAccessResult {
  urlPath: string;
  access: string | null;
  expiresAt: number | null;
}

/** 服务端签发短时 access，拼成可给 <audio>/<a> 用的完整 URL */
export async function issueAudiobookMediaUrl(
  novelId: string,
  taskId: string,
  resource: { resource: "full" } | { resource: "chapter"; chapterId: string },
): Promise<string> {
  const { data } = await apiClient.post<ApiResponse<AudiobookMediaAccessResult>>(
    `/novels/${novelId}/audiobook/tasks/${taskId}/media-access`,
    resource.resource === "full"
      ? { resource: "full" }
      : { resource: "chapter", chapterId: resource.chapterId },
  );
  const path = data.data?.urlPath;
  if (!path) {
    // 回退：open 模式裸路径
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

export type { AudiobookScopeMode, AudiobookTaskDetail, AudiobookTaskSummary, AudiobookPrecheckResult };
