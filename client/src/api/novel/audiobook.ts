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

/** 给 <audio> 用的鉴权头（若配置了 token） */
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
