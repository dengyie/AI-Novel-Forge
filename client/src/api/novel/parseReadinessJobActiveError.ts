import type { ApiResponse } from "@ai-novel/shared/types/api";
import type { AudiobookVoiceReadinessJobActiveErrorData } from "@ai-novel/shared/types/audiobook";

/**
 * 解析 prepare 409（READINESS_JOB_ACTIVE）。
 * 拦截器把 axios 错误归一为 ApiHttpError：status + details(=response.data)。
 * 路由特殊形状：{ success:false, error, data:{ code, activeJobId } }。
 * 兜底：全局 AppError 会把对象放在 details 字段；亦兼容 raw axios response。
 */
export function parseReadinessJobActiveError(
  error: unknown,
): AudiobookVoiceReadinessJobActiveErrorData | null {
  const err = error as {
    status?: number;
    details?: unknown;
    response?: { status?: number; data?: unknown };
  } | null | undefined;

  const status = err?.status ?? err?.response?.status;
  if (status !== 409) {
    return null;
  }

  const body = (err?.details ?? err?.response?.data) as
    | (ApiResponse<AudiobookVoiceReadinessJobActiveErrorData> & {
      details?: AudiobookVoiceReadinessJobActiveErrorData | unknown;
    })
    | AudiobookVoiceReadinessJobActiveErrorData
    | null
    | undefined;

  if (!body || typeof body !== "object") {
    return null;
  }

  const candidates: unknown[] = [
    (body as ApiResponse<AudiobookVoiceReadinessJobActiveErrorData>).data,
    (body as { details?: unknown }).details,
    body,
  ];

  for (const candidate of candidates) {
    if (
      candidate
      && typeof candidate === "object"
      && (candidate as AudiobookVoiceReadinessJobActiveErrorData).code === "READINESS_JOB_ACTIVE"
      && typeof (candidate as AudiobookVoiceReadinessJobActiveErrorData).activeJobId === "string"
    ) {
      return candidate as AudiobookVoiceReadinessJobActiveErrorData;
    }
  }
  return null;
}
