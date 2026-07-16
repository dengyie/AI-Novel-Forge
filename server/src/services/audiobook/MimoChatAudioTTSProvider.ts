import fs from "node:fs";
import {
  DEFAULT_AUDIOBOOK_NARRATOR_STYLE,
  MIMO_TTS_MODELS,
  isAudiobookTtsMode,
  isMimoTtsPresetVoice,
  type AudiobookTtsMode,
  type MimoTtsPresetVoice,
} from "@ai-novel/shared/types/audiobook";
import type { LLMProvider } from "@ai-novel/shared/types/llm";
import { prisma } from "../../db/prisma";
import {
  getProviderEnvApiKey,
  isBuiltInProvider,
  providerRequiresApiKey,
  resolveProviderBaseUrl,
} from "../../llm/providers";
import { AppError } from "../../middleware/errorHandler";
import { isMissingAudiobookTaskTableError } from "./audiobookErrors";
import { checkVoiceRefAudioPath } from "./voiceRefPath";

export interface MimoTtsSynthesizeInput {
  /** 旁白/对白正文（assistant 侧） */
  text: string;
  /**
   * 合成模态。缺省 preset。
   * - preset: audio.voice = 预置名
   * - design: user = designPrompt，禁止 audio.voice
   * - clone: audio.voice = data:audio/<mime>;base64,...（mime 随参考文件）
   */
  mode?: AudiobookTtsMode | null;
  /** preset 预置 voice id；design/clone 可空 */
  voice?: string | null;
  /** preset/clone 的 style（user）；design 时被 designPrompt 覆盖 */
  style?: string | null;
  /** design 模式音色描述（user content） */
  designPrompt?: string | null;
  /** clone：参考音频 base64（无 DataURL 前缀）；与 refAudioPath 二选一 */
  refAudioBase64?: string | null;
  /** clone：参考音频文件路径（服务端读盘） */
  refAudioPath?: string | null;
  /** 音频格式，默认 wav */
  format?: "wav" | "mp3";
  signal?: AbortSignal;
  /** 用于解析 CPA baseURL / key 的 LLM provider，默认 openai */
  provider?: LLMProvider;
  /** 覆盖默认模型（一般不传，按 mode 选） */
  model?: string;
}

export interface MimoTtsSynthesizeResult {
  audioBase64: string;
  format: string;
  voice: string;
  model: string;
  mode: AudiobookTtsMode;
  raw?: unknown;
}

export interface MimoTtsRequestBody {
  model: string;
  messages: Array<{ role: "user" | "assistant"; content: string }>;
  audio: { format: string; voice?: string };
  stream: false;
}

const DEFAULT_PROVIDER: LLMProvider = "openai";
const REQUEST_TIMEOUT_MS = Math.max(
  10_000,
  Number(process.env.AUDIOBOOK_MIMO_TTS_TIMEOUT_MS ?? 120_000) || 120_000,
);
const MAX_REF_AUDIO_BYTES = Math.max(
  64 * 1024,
  Number(process.env.AUDIOBOOK_CLONE_REF_MAX_BYTES ?? 8 * 1024 * 1024) || 8 * 1024 * 1024,
);

/** 单次上游合成端点（CPA 主链 + 可选 fufu 等 fallback）。 */
export type MimoTtsEndpoint = {
  /** 稳定短名，用于日志/错误（非密钥） */
  id: string;
  baseURL: string;
  /** 缺省时沿用主链 resolveApiKey */
  apiKey?: string | null;
};

/**
 * 解析 AUDIOBOOK_MIMO_TTS_FALLBACK_BASE_URLS：
 * 逗号/换行分隔的 OpenAI-compatible baseURL（不含 /chat/completions）。
 * 保留原始槽位顺序与重复项，供 keys 按位对齐；去重在 resolve 时按原 index 跳过。
 * 例：https://fufu.iqach.top/v1,http://127.0.0.1:18080/v1
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

/** 5xx / 429 / 超时(504) / 取消以外的瞬时失败可换端点；4xx 客户端错误不换。 */
export function isRetryableMimoTtsStatus(statusCode: number): boolean {
  if (statusCode === 408) {
    // 任务 cancel → 408；不重试。仅网络超时在 synthesize 内映射 504。
    return false;
  }
  if (statusCode === 429) return true;
  if (statusCode === 504) return true;
  if (statusCode >= 500) return true;
  return false;
}

/** 失败日志用：不带密钥，仅 endpoint id + 状态/短消息。 */
export function summarizeMimoTtsEndpointFailure(input: {
  endpointId: string;
  error: unknown;
}): string {
  const { endpointId, error } = input;
  if (error instanceof AppError) {
    return `[mimo-tts] endpoint ${endpointId} failed status=${error.statusCode}: ${error.message.slice(0, 180)}`;
  }
  const msg = error instanceof Error ? error.message : String(error);
  return `[mimo-tts] endpoint ${endpointId} failed: ${msg.slice(0, 180)}`;
}

export function resolveMimoTtsEndpointChain(input: {
  primaryBaseURL: string;
  primaryApiKey: string;
  fallbackBaseUrlsRaw?: string | null;
  fallbackApiKeysRaw?: string | null;
}): MimoTtsEndpoint[] {
  const primaryBase = input.primaryBaseURL.trim().replace(/\/+$/, "");
  if (!primaryBase) {
    return [];
  }
  const chain: MimoTtsEndpoint[] = [
    {
      id: "primary",
      baseURL: primaryBase,
      apiKey: input.primaryApiKey,
    },
  ];
  const fallbackUrls = parseMimoTtsFallbackBaseUrls(
    input.fallbackBaseUrlsRaw ?? process.env.AUDIOBOOK_MIMO_TTS_FALLBACK_BASE_URLS,
  );
  const fallbackKeys = parseMimoTtsFallbackApiKeys(
    input.fallbackApiKeysRaw ?? process.env.AUDIOBOOK_MIMO_TTS_FALLBACK_API_KEYS,
  );
  const seen = new Set([primaryBase.toLowerCase()]);
  let fallbackOrdinal = 0;
  fallbackUrls.forEach((baseURL, index) => {
    const key = baseURL.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    fallbackOrdinal += 1;
    const explicitKey = fallbackKeys[index] ?? null;
    chain.push({
      id: `fallback-${fallbackOrdinal}`,
      baseURL,
      apiKey: explicitKey,
    });
  });
  return chain;
}

/** 仅 APIKey 表缺失时兜底；与 AudiobookTask 表无关，但 Prisma 缺表码相同 */
function isMissingApiKeyTableError(error: unknown): boolean {
  return isMissingAudiobookTaskTableError(error)
    || (
      typeof error === "object"
      && error !== null
      && "code" in error
      && (error as { code?: string }).code === "P2021"
    );
}

async function resolveApiKey(provider: LLMProvider): Promise<string | undefined> {
  try {
    const dbSecret = await prisma.aPIKey.findUnique({ where: { provider } });
    if (dbSecret?.isActive && dbSecret.key?.trim()) {
      return dbSecret.key.trim();
    }
  } catch (error) {
    if (!isMissingApiKeyTableError(error)) {
      throw error;
    }
  }

  const envKey = getProviderEnvApiKey(provider);
  if (envKey) {
    return envKey;
  }

  if (!providerRequiresApiKey(provider)) {
    return undefined;
  }

  return undefined;
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

  // 部分网关可能把 base64 放在 content
  if (typeof message.content === "string" && message.content.trim().startsWith("UklGR")) {
    return message.content.trim();
  }

  return null;
}

function resolveMode(input: MimoTtsSynthesizeInput): AudiobookTtsMode {
  const raw = input.mode?.trim();
  if (!raw) {
    return "preset";
  }
  if (!isAudiobookTtsMode(raw)) {
    throw new AppError(`不支持的 TTS 模态「${raw}」。`, 400);
  }
  return raw;
}

function stripDataUrlPrefix(value: string): string {
  const trimmed = value.trim();
  const match = /^data:audio\/[a-z0-9.+-]+;base64,(.+)$/i.exec(trimmed);
  return match ? match[1].replace(/\s+/g, "") : trimmed.replace(/\s+/g, "");
}

export type CloneRefAudioPayload = {
  base64: string;
  /** DataURL 内 audio/* 子类型，如 wav / mpeg / ogg */
  mimeSubtype: string;
};

/**
 * 根据路径扩展名与文件魔数推断 clone 参考音频 mime 子类型。
 * 优先魔数（RIFF/ID3/OggS），扩展名兜底；未知则 wav。
 */
export function resolveCloneRefMimeSubtype(input: {
  filePath?: string | null;
  bytes?: Buffer | null;
}): string {
  const bytes = input.bytes;
  if (bytes && bytes.length >= 12) {
    const head4 = bytes.subarray(0, 4).toString("ascii");
    if (head4 === "RIFF") {
      return "wav";
    }
    if (head4 === "OggS") {
      return "ogg";
    }
    if (head4 === "fLaC") {
      return "flac";
    }
    // ID3 标签或 MPEG frame sync
    if (
      head4.startsWith("ID3")
      || (bytes[0] === 0xff && (bytes[1] & 0xe0) === 0xe0)
    ) {
      return "mpeg";
    }
  }

  const ext = (input.filePath ?? "").split(".").pop()?.toLowerCase() ?? "";
  if (ext === "wav" || ext === "wave") return "wav";
  if (ext === "mp3" || ext === "mpeg") return "mpeg";
  if (ext === "ogg" || ext === "oga") return "ogg";
  if (ext === "flac") return "flac";
  if (ext === "m4a" || ext === "mp4") return "mp4";
  return "wav";
}

function loadRefAudioPayload(input: MimoTtsSynthesizeInput): CloneRefAudioPayload {
  if (input.refAudioBase64?.trim()) {
    const raw = input.refAudioBase64.trim();
    const dataUrlMatch = /^data:audio\/([a-z0-9.+-]+);base64,(.+)$/i.exec(raw);
    const bare = dataUrlMatch
      ? dataUrlMatch[2].replace(/\s+/g, "")
      : stripDataUrlPrefix(raw);
    if (!bare) {
      throw new AppError("clone 参考音频 base64 为空。", 400);
    }
    const approxBytes = Math.floor((bare.length * 3) / 4);
    if (approxBytes > MAX_REF_AUDIO_BYTES) {
      throw new AppError(`clone 参考音频过大（>${MAX_REF_AUDIO_BYTES} bytes）。`, 400);
    }
    const mimeSubtype = dataUrlMatch?.[1]?.toLowerCase()
      || resolveCloneRefMimeSubtype({ bytes: Buffer.from(bare, "base64") });
    return { base64: bare, mimeSubtype };
  }

  const refPath = input.refAudioPath?.trim();
  if (!refPath) {
    throw new AppError("clone 模式需要 refAudioPath 或 refAudioBase64。", 400);
  }
  const checked = checkVoiceRefAudioPath(refPath);
  if (!checked.ok) {
    throw new AppError(checked.reason, 400);
  }
  const absoluteRef = checked.absolutePath;
  const stat = fs.statSync(absoluteRef);
  if (stat.size > MAX_REF_AUDIO_BYTES) {
    throw new AppError(`clone 参考音频过大（>${MAX_REF_AUDIO_BYTES} bytes）。`, 400);
  }
  const bytes = fs.readFileSync(absoluteRef);
  const mimeSubtype = resolveCloneRefMimeSubtype({ filePath: absoluteRef, bytes });
  return {
    base64: bytes.toString("base64"),
    mimeSubtype,
  };
}

/**
 * 构建 MiMo chat-audio 请求体（纯函数，便于单测）。
 * 协议锚点见产品 SoT / TTS 经验：
 * - preset: user=style, assistant=text, audio.voice=预置名
 * - design: user=designPrompt, assistant=text, 禁止 audio.voice
 * - clone: user=style, assistant=text, audio.voice=DataURL
 */
export function buildMimoTtsRequestBody(input: MimoTtsSynthesizeInput): MimoTtsRequestBody {
  const text = input.text?.trim();
  if (!text) {
    throw new AppError("TTS 文本不能为空。", 400);
  }

  const mode = resolveMode(input);
  const format = input.format ?? "wav";
  const model = input.model?.trim() || MIMO_TTS_MODELS[mode];

  if (mode === "preset") {
    const voice = input.voice?.trim();
    if (!voice) {
      throw new AppError("preset 模式 TTS voice 不能为空。", 400);
    }
    if (!isMimoTtsPresetVoice(voice)) {
      throw new AppError(`音色「${voice}」不在 MiMo 预置表中。`, 400);
    }
    const style = input.style?.trim() || DEFAULT_AUDIOBOOK_NARRATOR_STYLE;
    return {
      model,
      messages: [
        { role: "user", content: style },
        { role: "assistant", content: text },
      ],
      audio: {
        format,
        voice: voice as MimoTtsPresetVoice,
      },
      stream: false,
    };
  }

  if (mode === "design") {
    const designPrompt = input.designPrompt?.trim() || input.style?.trim();
    if (!designPrompt) {
      throw new AppError("design 模式需要 ttsDesignPrompt（音色描述）。", 400);
    }
    return {
      model,
      messages: [
        { role: "user", content: designPrompt },
        { role: "assistant", content: text },
      ],
      audio: { format },
      stream: false,
    };
  }

  // clone：DataURL mime 与参考文件一致（mp3/ogg 不得写死 audio/wav）
  const ref = loadRefAudioPayload(input);
  const style = input.style?.trim() || DEFAULT_AUDIOBOOK_NARRATOR_STYLE;
  return {
    model,
    messages: [
      { role: "user", content: style },
      { role: "assistant", content: text },
    ],
    audio: {
      format,
      voice: `data:audio/${ref.mimeSubtype};base64,${ref.base64}`,
    },
    stream: false,
  };
}

/**
 * MiMo TTS via OpenAI-compatible chat-audio:
 * POST {baseURL}/chat/completions
 * 三模态：preset / design / clone（见 buildMimoTtsRequestBody）
 *
 * 多后端：主链 = LLM provider baseURL（通常 CPA）；
 * 可选 AUDIOBOOK_MIMO_TTS_FALLBACK_BASE_URLS（fufu 等）在 5xx/429/504 时换端点。
 * 每端点内仍可被 pipeline 的 synthesizeChunkWithRetry 再包一层。
 */
export class MimoChatAudioTTSProvider {
  readonly providerId = "mimo-chat-audio";

  async synthesize(input: MimoTtsSynthesizeInput): Promise<MimoTtsSynthesizeResult> {
    const mode = resolveMode(input);
    const body = buildMimoTtsRequestBody(input);
    const llmProvider = input.provider ?? DEFAULT_PROVIDER;

    const resolvedBaseURL = isBuiltInProvider(llmProvider)
      ? resolveProviderBaseUrl(llmProvider)
      : resolveProviderBaseUrl("openai");
    const baseURL = resolvedBaseURL?.trim();
    if (!baseURL) {
      throw new AppError(
        "未配置 LLM/CPA baseURL，无法调用 MiMo TTS。请配置对应 provider 的 base URL。",
        400,
      );
    }

    const apiKey = await resolveApiKey(isBuiltInProvider(llmProvider) ? llmProvider : "openai")
      ?? await resolveApiKey("openai")
      ?? await resolveApiKey("deepseek");

    if (!apiKey) {
      throw new AppError("未配置可用的 CPA/LLM API Key，无法调用 MiMo TTS。", 400);
    }

    const endpoints = resolveMimoTtsEndpointChain({
      primaryBaseURL: baseURL,
      primaryApiKey: apiKey,
    });
    if (endpoints.length === 0) {
      throw new AppError("未解析到可用的 MiMo TTS 端点。", 400);
    }

    let lastError: unknown;
    for (let index = 0; index < endpoints.length; index += 1) {
      const endpoint = endpoints[index];
      const endpointKey = (endpoint.apiKey?.trim() || apiKey).trim();
      if (!endpointKey) {
        lastError = new AppError(`MiMo TTS 端点 ${endpoint.id} 缺少 API Key。`, 400);
        continue;
      }
      try {
        return await this.synthesizeOnce({
          body,
          mode,
          input,
          endpoint,
          apiKey: endpointKey,
        });
      } catch (error) {
        lastError = error;
        if (input.signal?.aborted) {
          throw error instanceof AppError
            ? error
            : new AppError("MiMo TTS 请求已取消。", 408);
        }
        if (error instanceof AppError && !isRetryableMimoTtsStatus(error.statusCode)) {
          throw error;
        }
        // 还有下一端点则换后端；否则抛最后错误
        if (index < endpoints.length - 1) {
          const next = endpoints[index + 1];
          console.warn(
            `${summarizeMimoTtsEndpointFailure({ endpointId: endpoint.id, error })}; trying ${next.id}`,
          );
          continue;
        }
        throw error;
      }
    }

    throw lastError instanceof AppError
      ? lastError
      : new AppError("MiMo TTS 合成失败。", 502);
  }

  private async synthesizeOnce(params: {
    body: MimoTtsRequestBody;
    mode: AudiobookTtsMode;
    input: MimoTtsSynthesizeInput;
    endpoint: MimoTtsEndpoint;
    apiKey: string;
  }): Promise<MimoTtsSynthesizeResult> {
    const { body, mode, input, endpoint, apiKey } = params;
    const url = `${endpoint.baseURL.replace(/\/$/, "")}/chat/completions`;

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
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
        // 4xx 客户端/鉴权类不伪装 502；5xx/其它保持 502 以便重试/换端
        const statusCode = response.status >= 400 && response.status < 500
          ? response.status
          : 502;
        throw new AppError(
          `MiMo TTS 请求失败 [${endpoint.id}] (${response.status}): ${message}`,
          statusCode,
        );
      }

      const audioBase64 = extractAudioBase64(payload);
      if (!audioBase64) {
        throw new AppError(
          `MiMo TTS 响应缺少 message.audio.data [${endpoint.id}]。`,
          502,
        );
      }

      const voiceLabel = mode === "preset"
        ? (input.voice?.trim() || "")
        : mode === "design"
          ? "design"
          : "clone";

      return {
        audioBase64,
        format: input.format ?? "wav",
        voice: voiceLabel,
        model: body.model,
        mode,
        raw: payload,
      };
    } catch (error) {
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
}

export const mimoChatAudioTTSProvider = new MimoChatAudioTTSProvider();
