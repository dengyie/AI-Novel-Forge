import fs from "node:fs";
import path from "node:path";
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
import { resolveVoiceRefRoot } from "./audiobookPaths";

export interface MimoTtsSynthesizeInput {
  /** 旁白/对白正文（assistant 侧） */
  text: string;
  /**
   * 合成模态。缺省 preset。
   * - preset: audio.voice = 预置名
   * - design: user = designPrompt，禁止 audio.voice
   * - clone: audio.voice = data:audio/wav;base64,...
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

function isPathInside(parent: string, target: string): boolean {
  const parentResolved = path.resolve(parent);
  const targetResolved = path.resolve(target);
  const rel = path.relative(parentResolved, targetResolved);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

function loadRefAudioBase64(input: MimoTtsSynthesizeInput): string {
  if (input.refAudioBase64?.trim()) {
    const bare = stripDataUrlPrefix(input.refAudioBase64);
    if (!bare) {
      throw new AppError("clone 参考音频 base64 为空。", 400);
    }
    const approxBytes = Math.floor((bare.length * 3) / 4);
    if (approxBytes > MAX_REF_AUDIO_BYTES) {
      throw new AppError(`clone 参考音频过大（>${MAX_REF_AUDIO_BYTES} bytes）。`, 400);
    }
    return bare;
  }

  const refPath = input.refAudioPath?.trim();
  if (!refPath) {
    throw new AppError("clone 模式需要 refAudioPath 或 refAudioBase64。", 400);
  }
  if (refPath.includes("\0") || refPath.includes("..")) {
    throw new AppError("clone 参考音频路径非法。", 400);
  }
  // 强制限制在 voice-refs 根目录内，防路径穿越读任意文件
  const voiceRefRoot = resolveVoiceRefRoot();
  const absoluteRef = path.resolve(refPath);
  if (!isPathInside(voiceRefRoot, absoluteRef)) {
    throw new AppError("clone 参考音频路径越界（必须位于 voice-refs 目录）。", 400);
  }
  if (!fs.existsSync(absoluteRef)) {
    throw new AppError(`clone 参考音频不存在：${refPath}`, 400);
  }
  const stat = fs.statSync(absoluteRef);
  if (!stat.isFile()) {
    throw new AppError("clone 参考音频路径不是文件。", 400);
  }
  if (stat.size <= 0) {
    throw new AppError("clone 参考音频为空文件。", 400);
  }
  if (stat.size > MAX_REF_AUDIO_BYTES) {
    throw new AppError(`clone 参考音频过大（>${MAX_REF_AUDIO_BYTES} bytes）。`, 400);
  }
  return fs.readFileSync(absoluteRef).toString("base64");
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

  // clone
  const refBare = loadRefAudioBase64(input);
  const style = input.style?.trim() || DEFAULT_AUDIOBOOK_NARRATOR_STYLE;
  return {
    model,
    messages: [
      { role: "user", content: style },
      { role: "assistant", content: text },
    ],
    audio: {
      format,
      voice: `data:audio/wav;base64,${refBare}`,
    },
    stream: false,
  };
}

/**
 * MiMo TTS via CPA OpenAI-compatible chat-audio:
 * POST /v1/chat/completions
 * 三模态：preset / design / clone（见 buildMimoTtsRequestBody）
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

    const url = `${baseURL.replace(/\/$/, "")}/chat/completions`;

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
        // 4xx 客户端/鉴权类不伪装 502；5xx/其它保持 502 以便重试
        const statusCode = response.status >= 400 && response.status < 500
          ? response.status
          : 502;
        throw new AppError(`MiMo TTS 请求失败 (${response.status}): ${message}`, statusCode);
      }

      const audioBase64 = extractAudioBase64(payload);
      if (!audioBase64) {
        throw new AppError("MiMo TTS 响应缺少 message.audio.data。", 502);
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
        // 外部取消（任务 cancel）与本地超时分开：取消不重试，超时可重试
        if (input.signal?.aborted) {
          throw new AppError("MiMo TTS 请求已取消。", 408);
        }
        throw new AppError("MiMo TTS 请求超时。", 504);
      }
      throw new AppError(
        `MiMo TTS 调用异常：${error instanceof Error ? error.message : String(error)}`,
        502,
      );
    } finally {
      clearTimeout(timeout);
      input.signal?.removeEventListener("abort", onExternalAbort);
    }
  }
}

export const mimoChatAudioTTSProvider = new MimoChatAudioTTSProvider();
