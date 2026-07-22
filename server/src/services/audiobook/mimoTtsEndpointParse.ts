/**
 * MiMo TTS fallback 端点解析纯函数（无 DB / settings 依赖）。
 * 供 MimoChatAudioTTSProvider 与 AudiobookTtsTransportSettingsService 共用，避免循环 import。
 */

/**
 * 解析 AUDIOBOOK_MIMO_TTS_FALLBACK_BASE_URLS：
 * 逗号/换行分隔的 OpenAI-compatible baseURL（不含 /chat/completions）。
 * 保留原始槽位顺序与重复项，供 keys 按位对齐；去重在 resolve 时按原 index 跳过。
 */
export function parseMimoTtsFallbackBaseUrls(raw: string | null | undefined): string[] {
  if (!raw?.trim()) {
    return [];
  }
  const out: string[] = [];
  for (const part of raw.split(/[\n,]+/)) {
    const trimmed = part.trim().replace(/\/+$/, "");
    if (!trimmed) continue;
    out.push(trimmed);
  }
  return out;
}

/**
 * 解析 AUDIOBOOK_MIMO_TTS_FALLBACK_API_KEYS：与 fallback baseURL 按位对齐；
 * 空位 / 缺项 = 沿用主链 key。
 */
export function parseMimoTtsFallbackApiKeys(raw: string | null | undefined): Array<string | null> {
  if (raw == null) {
    return [];
  }
  // 保留空槽位以与 baseURL 对齐（"sk-a,,sk-b"）
  return raw.split(",").map((part) => {
    const trimmed = part.trim();
    return trimmed ? trimmed : null;
  });
}
