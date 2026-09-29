import { AppError } from "../../../../middleware/errorHandler";

export function throwIfMimoTtsCancelled(signal?: AbortSignal): void {
  if (signal?.aborted) throw new AppError("MiMo TTS 请求已取消。", 408);
}

export function extractAudioBase64(payload: unknown): string | null {
  if (!payload || typeof payload !== "object") {
    return null;
  }
  const root = payload as Record<string, unknown>;
  const choices = root.choices;
  if (!Array.isArray(choices) || choices.length === 0) {
    return null;
  }
  const first = choices[0] as Record<string, unknown> | undefined;
  const message = first?.message as Record<string, unknown> | undefined;
  if (!message) {
    return null;
  }

  const audio = message.audio as Record<string, unknown> | undefined;
  if (audio && typeof audio.data === "string" && audio.data.trim()) {
    return audio.data.trim();
  }

  // 部分网关可能把 base64 放在 content；仅当可解码为合法 PCM WAV 时采信，避免错误文本恰好以 UklGR 开头被误当音频
  if (typeof message.content === "string" && message.content.trim().startsWith("UklGR")) {
    const bare = message.content.trim();
    try {
      const buf = Buffer.from(bare, "base64");
      const head4 = buf.subarray(0, 4).toString("ascii");
      if (head4 === "RIFF" && buf.toString("ascii", 8, 12) === "WAVE") {
        return bare;
      }
    } catch {
      // 解码失败则不采信
    }
  }

  return null;
}


/** 单次 HTTP 请求及响应解码；端点选择、重试与熔断由 provider 持有。 */
export async function requestMimoTtsAudio(params: {
  body: object;
  input: { signal?: AbortSignal };
  endpoint: { id: string; baseURL: string };
  apiKey: string;
  requestTimeoutMs: number;
}): Promise<{ audioBase64: string; raw: unknown }> {
  const { body, input, endpoint, apiKey } = params;
  const url = `${endpoint.baseURL.replace(/\/$/, "")}/chat/completions`;

  throwIfMimoTtsCancelled(input.signal);
  const controller = new AbortController();
  const timeoutMs = Math.max(10_000, params.requestTimeoutMs);
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  const onExternalAbort = () => controller.abort();
  input.signal?.addEventListener("abort", onExternalAbort);

  try {
    const response = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });

    const rawText = await response.text();
    let payload: unknown = null;
    try {
      payload = rawText ? JSON.parse(rawText) : null;
    } catch {
      payload = { raw: rawText };
    }

    if (!response.ok) {
      const message = typeof payload === "object" && payload && "error" in payload
        ? JSON.stringify((payload as { error: unknown }).error)
        : rawText.slice(0, 400);
      // 保留上游状态，供应用层决定重试、换端和限流熔断。
      const statusCode = response.status >= 400 && response.status < 600
        ? response.status
        : 502;
      throw new AppError(
        `MiMo TTS 请求失败 [${endpoint.id}] (${response.status}): ${message}`,
        statusCode,
      );
    }

    throwIfMimoTtsCancelled(input.signal);
    const audioBase64 = extractAudioBase64(payload);
    if (!audioBase64) {
      throw new AppError(
        `MiMo TTS 响应缺少 message.audio.data [${endpoint.id}]。`,
        502,
      );
    }

    return { audioBase64, raw: payload };
  } catch (error) {
    throwIfMimoTtsCancelled(input.signal);
    if (error instanceof AppError) {
      throw error;
    }
    const aborted = error instanceof Error
      && (error.name === "AbortError" || /aborted/i.test(error.message));
    if (aborted) {
      // 外部取消（任务 cancel）与本地超时分开：取消不重试，超时可换端/重试
      if (input.signal?.aborted) {
        throw new AppError("MiMo TTS 请求已取消。", 408);
      }
      throw new AppError(`MiMo TTS 请求超时 [${endpoint.id}]。`, 504);
    }
    throw new AppError(
      `MiMo TTS 调用异常 [${endpoint.id}]：${error instanceof Error ? error.message : String(error)}`,
      502,
    );
  } finally {
    clearTimeout(timeout);
    input.signal?.removeEventListener("abort", onExternalAbort);
  }
}
