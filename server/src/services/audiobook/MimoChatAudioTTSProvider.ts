import {
  DEFAULT_AUDIOBOOK_NARRATOR_STYLE,
  isMimoTtsPresetVoice,
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

export interface MimoTtsSynthesizeInput {
  /** 旁白/对白正文（assistant 侧） */
  text: string;
  /** MiMo 预置 voice id */
  voice: string;
  /** 音色描述，放在 user 消息 */
  style?: string | null;
  /** 音频格式，默认 wav */
  format?: "wav" | "mp3";
  signal?: AbortSignal;
  /** 用于解析 CPA baseURL / key 的 LLM provider，默认 openai */
  provider?: LLMProvider;
  model?: string;
}

export interface MimoTtsSynthesizeResult {
  audioBase64: string;
  format: string;
  voice: string;
  model: string;
  raw?: unknown;
}

const DEFAULT_MIMO_TTS_MODEL = process.env.AUDIOBOOK_MIMO_TTS_MODEL?.trim() || "mimo-v2.5-tts";
const DEFAULT_PROVIDER: LLMProvider = "openai";
const REQUEST_TIMEOUT_MS = Math.max(
  10_000,
  Number(process.env.AUDIOBOOK_MIMO_TTS_TIMEOUT_MS ?? 120_000) || 120_000,
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

/**
 * MiMo TTS via CPA OpenAI-compatible chat-audio:
 * POST /v1/chat/completions
 * messages: [{role:user, content: style}, {role:assistant, content: spoken text}]
 * audio: { format, voice }
 * response: choices[0].message.audio.data (base64)
 */
export class MimoChatAudioTTSProvider {
  readonly providerId = "mimo-chat-audio";

  async synthesize(input: MimoTtsSynthesizeInput): Promise<MimoTtsSynthesizeResult> {
    const text = input.text?.trim();
    if (!text) {
      throw new AppError("TTS 文本不能为空。", 400);
    }

    const voice = input.voice?.trim();
    if (!voice) {
      throw new AppError("TTS voice 不能为空。", 400);
    }
    if (!isMimoTtsPresetVoice(voice)) {
      throw new AppError(`音色「${voice}」不在 MiMo 预置表中。`, 400);
    }

    const style = (input.style?.trim() || DEFAULT_AUDIOBOOK_NARRATOR_STYLE);
    const format = input.format ?? "wav";
    const llmProvider = input.provider ?? DEFAULT_PROVIDER;
    const model = input.model?.trim() || DEFAULT_MIMO_TTS_MODEL;

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
    const body = {
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
        throw new AppError(`MiMo TTS 请求失败 (${response.status}): ${message}`, 502);
      }

      const audioBase64 = extractAudioBase64(payload);
      if (!audioBase64) {
        throw new AppError("MiMo TTS 响应缺少 message.audio.data。", 502);
      }

      return {
        audioBase64,
        format,
        voice,
        model,
        raw: payload,
      };
    } catch (error) {
      if (error instanceof AppError) {
        throw error;
      }
      if (error instanceof Error && (error.name === "AbortError" || /aborted/i.test(error.message))) {
        // 408 Request Timeout：避免非标准 499 被网关/客户端误判
        throw new AppError("MiMo TTS 请求已取消或超时。", 408);
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
