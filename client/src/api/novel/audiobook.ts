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
  AudiobookVoiceLibraryMatchesResult,
  AudiobookVoiceReadinessAssessInput,
  AudiobookVoiceReadinessJob,
  AudiobookVoiceReadinessJobActiveErrorData,
  AudiobookVoiceReadinessPrepareInput,
  AudiobookVoiceReadinessPrepareResult,
  AudiobookVoiceReadinessSummary,
  AudiobookWorkspaceBootstrap,
  AudiobookWorkspaceOverviewRequest,
  AudiobookWorkspaceOverviewResult,
  CharacterVoicePreviewAsset,
  CharacterVoicePreviewGenerateInput,
  CharacterVoicePreviewGenerateResult,
  CharacterVoicePreviewAdoptCandidateInput,
  CharacterVoiceAdoptPreviewAsCloneInput,
  CharacterVoiceAdoptPreviewAsCloneResult,
  CreateAudiobookTaskInput,
  VoiceAsset,
  VoiceAssetBindCharacterResult,
  VoiceAssetKind,
  VoiceAssetListResult,
  VoiceAssetStatus,
  VoiceDesignRewriteInput,
  VoiceDesignRewriteResult,
} from "@ai-novel/shared/types/audiobook";
import { API_AUTH_TOKEN, API_BASE_URL } from "@/lib/constants";
import { apiClient } from "../client";
import { parseReadinessJobActiveError } from "./parseReadinessJobActiveError";

export { parseReadinessJobActiveError };

export type ListVoiceLibraryParams = {
  status?: VoiceAssetStatus | VoiceAssetStatus[];
  kind?: VoiceAssetKind | VoiceAssetKind[];
  tag?: string;
  q?: string;
  limit?: number;
  offset?: number;
};

export type ImportVoiceLibraryFileInput = {
  sourcePath: string;
  slug: string;
  displayName: string;
  kind?: VoiceAssetKind;
  /** 禁止 approved；仅 draft/archived/deprecated */
  status?: Exclude<VoiceAssetStatus, "approved">;
  tags?: string[];
  sampleText?: string | null;
  designPrompt?: string | null;
  license: {
    source: string;
    rights: string;
    notes?: string | null;
    url?: string | null;
  };
  packId?: string | null;
  overwrite?: boolean;
};

export type ImportVoiceLibrarySeedPackInput = {
  packRoot?: string;
  /** 禁止 approved */
  forceStatus?: Exclude<VoiceAssetStatus, "approved"> | null;
  overwrite?: boolean;
};

function joinCsvParam(value?: string | string[]): string | undefined {
  if (value == null) return undefined;
  if (Array.isArray(value)) {
    const parts = value.map((item) => item.trim()).filter(Boolean);
    return parts.length ? parts.join(",") : undefined;
  }
  const single = value.trim();
  return single || undefined;
}

/** 全站 VoiceAsset 库列表（UI 绑库默认只拉 approved + clone_ref）。 */
export async function listVoiceLibrary(params: ListVoiceLibraryParams = {}) {
  const { data } = await apiClient.get<ApiResponse<VoiceAssetListResult>>(
    "/novels/audiobook/voice-library",
    {
      params: {
        status: joinCsvParam(params.status),
        kind: joinCsvParam(params.kind),
        tag: params.tag?.trim() || undefined,
        q: params.q?.trim() || undefined,
        limit: params.limit,
        offset: params.offset,
      },
    },
  );
  return data;
}

export async function getVoiceLibraryAsset(assetId: string) {
  const { data } = await apiClient.get<ApiResponse<VoiceAsset>>(
    `/novels/audiobook/voice-library/${encodeURIComponent(assetId)}`,
  );
  return data;
}

/** 将 approved clone_ref 绑到角色（服务端写路径 + ttsVoiceAssetId）。 */
export async function bindVoiceLibraryAsset(
  novelId: string,
  characterId: string,
  voiceAssetId: string,
) {
  const { data } = await apiClient.post<ApiResponse<VoiceAssetBindCharacterResult>>(
    `/novels/${novelId}/characters/${characterId}/voice-library/bind`,
    { voiceAssetId },
  );
  return data;
}

/** 人物卡 ↔ VoiceAsset 对靠：单角色 top-N 候选（approved clone_ref + 打分理由 + 占用标注）。 */
export async function listVoiceLibraryMatches(
  novelId: string,
  characterId: string,
  topN?: number,
): Promise<ApiResponse<AudiobookVoiceLibraryMatchesResult>> {
  const query = typeof topN === "number" && Number.isFinite(topN) ? `?topN=${topN}` : "";
  const { data } = await apiClient.get<ApiResponse<AudiobookVoiceLibraryMatchesResult>>(
    `/novels/${novelId}/characters/${characterId}/voice-library/matches${query}`,
  );
  return data;
}

/** 服务端路径导入（allowlist）；不可 status=approved。 */
export async function importVoiceLibraryFile(body: ImportVoiceLibraryFileInput) {
  const { data } = await apiClient.post<ApiResponse<VoiceAsset>>(
    "/novels/audiobook/voice-library/import-file",
    body,
  );
  return data;
}

/** 种子包导入（默认 draft；禁 forceStatus=approved）。 */
export async function importVoiceLibrarySeedPack(body: ImportVoiceLibrarySeedPackInput = {}) {
  const { data } = await apiClient.post<
    ApiResponse<{
      packId: string;
      imported: VoiceAsset[];
      skipped: Array<{ slug: string; reason: string }>;
      failed: Array<{ slug: string; reason: string }>;
    }>
  >("/novels/audiobook/voice-library/import-seed-pack", body);
  return data;
}

/** 人耳批准 / 改状态；升 approved 时可选带 approve token header。 */
export async function setVoiceLibraryAssetStatus(
  assetId: string,
  status: VoiceAssetStatus,
  options?: { approveToken?: string | null },
) {
  const headers: Record<string, string> = {};
  const token = options?.approveToken?.trim();
  if (token) {
    headers["X-Voice-Library-Approve-Token"] = token;
  }
  const { data } = await apiClient.patch<ApiResponse<VoiceAsset>>(
    `/novels/audiobook/voice-library/${encodeURIComponent(assetId)}/status`,
    { status },
    { headers },
  );
  return data;
}

/** 签发库资产试听短时 URL（供 <audio>）。 */
export async function issueVoiceLibraryAssetMediaUrl(assetId: string): Promise<string> {
  const { data } = await apiClient.post<ApiResponse<AudiobookMediaAccessResult>>(
    `/novels/audiobook/voice-library/${encodeURIComponent(assetId)}/media-access`,
  );
  const path = data.data?.urlPath;
  if (!path) {
    return buildVoiceLibraryAssetAudioUrl(assetId);
  }
  const base = API_BASE_URL.replace(/\/$/, "");
  if (path.startsWith("http://") || path.startsWith("https://")) {
    return path;
  }
  return `${base}${path.startsWith("/") ? path : `/${path}`}`;
}

export function buildVoiceLibraryAssetAudioUrl(assetId: string): string {
  const base = API_BASE_URL.replace(/\/$/, "");
  return `${base}/novels/audiobook/voice-library/${encodeURIComponent(assetId)}/audio`;
}

/** design rewrite 候选（不写角色卡）。 */
export async function rewriteCharacterVoiceDesign(
  novelId: string,
  characterId: string,
  body: VoiceDesignRewriteInput = {},
) {
  const { data } = await apiClient.post<ApiResponse<VoiceDesignRewriteResult>>(
    `/novels/${novelId}/characters/${characterId}/voice-design/rewrite`,
    body,
  );
  return data;
}

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

/** 选书页 bulk 态势（禁 N× assess；服务端截断 50）。 */
export async function postAudiobookWorkspaceOverview(body: AudiobookWorkspaceOverviewRequest) {
  const { data } = await apiClient.post<ApiResponse<AudiobookWorkspaceOverviewResult>>(
    "/novels/audiobook/workspace-overview",
    body,
  );
  return data;
}

export async function getAudiobookVoiceReadiness(
  novelId: string,
  params: AudiobookVoiceReadinessAssessInput = {},
) {
  const { data } = await apiClient.get<ApiResponse<AudiobookVoiceReadinessSummary>>(
    `/novels/${novelId}/audiobook/voice-readiness`,
    {
      params: params.characterIds?.length
        ? { characterIds: params.characterIds.join(",") }
        : undefined,
    },
  );
  return data;
}

export async function prepareAudiobookVoiceReadiness(
  novelId: string,
  payload: AudiobookVoiceReadinessPrepareInput = {},
) {
  // 409 READINESS_JOB_ACTIVE 由 parseReadinessJobActiveError 程序化接管，不弹全局 toast
  const { data } = await apiClient.post<ApiResponse<AudiobookVoiceReadinessPrepareResult>>(
    `/novels/${novelId}/audiobook/voice-readiness/prepare`,
    payload,
    { silentErrorStatuses: [409] },
  );
  return data;
}

export async function getAudiobookVoiceReadinessJob(novelId: string, jobId: string) {
  const { data } = await apiClient.get<ApiResponse<AudiobookVoiceReadinessJob>>(
    `/novels/${novelId}/audiobook/voice-readiness/jobs/${jobId}`,
  );
  return data;
}

export async function cancelAudiobookVoiceReadinessJob(novelId: string, jobId: string) {
  const { data } = await apiClient.post<ApiResponse<AudiobookVoiceReadinessJob>>(
    `/novels/${novelId}/audiobook/voice-readiness/jobs/${jobId}/cancel`,
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

/** @deprecated 产品路径请用 generateCharacterVoicePreview / issueCharacterVoicePreviewMediaUrl。 */
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

/** 基于已保存音色生成角色卡固定试听资产。 */
export async function generateCharacterVoicePreview(
  novelId: string,
  characterId: string,
  payload: CharacterVoicePreviewGenerateInput = {},
) {
  const { data } = await apiClient.post<ApiResponse<CharacterVoicePreviewGenerateResult>>(
    `/novels/${novelId}/characters/${characterId}/voice-preview/generate`,
    payload,
  );
  return data;
}

/** 采用多抽试听候选为正式 preview。 */
export async function adoptCharacterVoicePreviewCandidate(
  novelId: string,
  characterId: string,
  payload: CharacterVoicePreviewAdoptCandidateInput,
) {
  const { data } = await apiClient.post<ApiResponse<CharacterVoicePreviewAsset>>(
    `/novels/${novelId}/characters/${characterId}/voice-preview/adopt-candidate`,
    payload,
  );
  return data;
}

/** Design→Clone：选优 preview 升格为 clone 身份锚。 */
export async function adoptCharacterVoicePreviewAsClone(
  novelId: string,
  characterId: string,
  payload: CharacterVoiceAdoptPreviewAsCloneInput = {},
) {
  const { data } = await apiClient.post<ApiResponse<CharacterVoiceAdoptPreviewAsCloneResult>>(
    `/novels/${novelId}/characters/${characterId}/voice-preview/adopt-preview-clone`,
    payload,
  );
  return data;
}

/** 查询角色卡固定试听状态（不触发 TTS）。 */
export async function getCharacterVoicePreview(novelId: string, characterId: string) {
  const { data } = await apiClient.get<ApiResponse<CharacterVoicePreviewAsset>>(
    `/novels/${novelId}/characters/${characterId}/voice-preview`,
  );
  return data;
}

/** 签发角色固定试听的短时播放 URL（供 <audio>）。 */
export async function issueCharacterVoicePreviewMediaUrl(
  novelId: string,
  characterId: string,
): Promise<string> {
  const { data } = await apiClient.post<ApiResponse<AudiobookMediaAccessResult>>(
    `/novels/${novelId}/characters/${characterId}/voice-preview/media-access`,
  );
  const path = data.data?.urlPath;
  if (!path) {
    return buildCharacterVoicePreviewAudioUrl(novelId, characterId);
  }
  const base = API_BASE_URL.replace(/\/$/, "");
  if (path.startsWith("http://") || path.startsWith("https://")) {
    return path;
  }
  return `${base}${path.startsWith("/") ? path : `/${path}`}`;
}

export function buildCharacterVoicePreviewAudioUrl(novelId: string, characterId: string): string {
  const base = API_BASE_URL.replace(/\/$/, "");
  return `${base}/novels/${encodeURIComponent(novelId)}/characters/${encodeURIComponent(characterId)}/voice-preview/audio`;
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

export async function continueAudiobookTask(
  novelId: string,
  taskId: string,
  payload: { chapterIds: string[]; mode?: "resynthesize" },
) {
  const { data } = await apiClient.post<ApiResponse<AudiobookTaskDetail>>(
    `/novels/${novelId}/audiobook/tasks/${taskId}/continue`,
    payload,
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
  AudiobookVoiceReadinessSummary,
  AudiobookVoiceReadinessJob,
  AudiobookVoiceReadinessPrepareInput,
  AudiobookVoiceReadinessJobActiveErrorData,
};
