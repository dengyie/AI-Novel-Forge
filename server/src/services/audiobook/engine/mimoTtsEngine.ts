/**
 * MimoTtsEngine —— L3 引擎适配器：把现 `MimoChatAudioTTSProvider` 收进 `TtsEngine` 端口。
 *
 * 设计纪律（对照 docs/plans/audiobook-synthesis-layering-refactor-design.md §5）：
 *   - **逐字转发**：synthesize 把 SynthesisRequest 解包成 `MimoTtsSynthesizeInput`，
 *     转交单例 provider。mode→model 映射已被内化到本 adapter（见 `fingerprintKey`）。
 *   - **不在 Engine 层做 delivery 合并**：合并归 M3 SynthesisBuilder；本 adapter 只做
 *     `delivery?.style ?? voiceProfile.baseStyle` 这种**机械选取**，不写优先级规则。
 *   - 取消经 opts.signal；失败抛 AppError（statusCode 决定可重试性，沿用 provider 语义）。
 *   - 合成路径与旧三处直连**逐字节等价**（同 `buildMimoTtsRequestBody` 纯函数），即 M2 golden。
 *
 * M2 阶段三处直连改走 `getEngine("mimo").synthesize(req)`（AudiobookPipelineService /
 * AudiobookVoiceAssetService 预览两处）；M5 起 SynthesisRequest 由 VoiceResolver/SynthesisBuilder
 * 正经产出，`legacySynthesisRequestToSynthesisRequest` 过渡桥随之删除。
 */

import {
  MIMO_TTS_MODELS,
  type AudiobookTtsMode,
} from "@ai-novel/shared/types/audiobook";
import type { LLMProvider } from "@ai-novel/shared/types/llm";
import { mimoChatAudioTTSProvider } from "../MimoChatAudioTTSProvider";
import { parseWavInfo } from "../audiobookWav";
import type { SynthesisRequest, SynthesisResult } from "./synthesisRequest";
import type { TtsEngine, SynthesizeOpts } from "./ttsEngine";

/**
 * 从 base64 WAV 计算音频时长（秒）。
 * 与 AudiobookVoiceAssetService.wavDurationMsFromBase64 行为等价，但按秒返回；
 * 解析失败/无 byteRate 时返回 0（沿用旧语义，避免抛出破坏 golden 对照）。
 */
function wavDurationSecondsFromBase64(base64: string): number {
  try {
    const match = /^data:audio\/([a-z0-9.+-]+);base64,(.+)$/i.exec(base64.trim());
    const bare = (match ? match[2] : base64).replace(/\s+/g, "");
    const buf = Buffer.from(bare, "base64");
    const info = parseWavInfo(buf);
    if (info.byteRate <= 0) return 0;
    return info.dataSize / info.byteRate;
  } catch {
    return 0;
  }
}

/**
 * SynthesisRequest → Provider 输入的机械解包。
 * - delivery 覆盖优先于 voiceProfile 基线（base）字段
 * - 不在端口连接处写任何 mode→style 的优先级规则；那是 M3 的事
 */
export function synthesisRequestToMimoInput(
  req: SynthesisRequest,
  opts?: SynthesizeOpts,
): {
  text: string;
  mode?: AudiobookTtsMode;
  voice?: string | null;
  style?: string | null;
  designPrompt?: string | null;
  refAudioPath?: string | null;
  format?: "wav" | "mp3";
  provider?: LLMProvider;
  signal?: AbortSignal;
} {
  const vp = req.voiceProfile;
  const style = req.delivery?.style ?? vp.baseStyle;
  const designPrompt = req.delivery?.designPrompt ?? vp.baseDesignPrompt;
  const provider = (req.engineParams?.provider as LLMProvider | undefined) ?? undefined;
  return {
    text: req.text,
    mode: vp.mode,
    voice: vp.voice,
    style: style ?? undefined,
    designPrompt: designPrompt ?? undefined,
    refAudioPath: vp.refAudioPath,
    format: "wav",
    provider,
    signal: opts?.signal,
  };
}

export class MimoTtsEngine implements TtsEngine {
  readonly id = "mimo" as const;

  /** 缓存指纹的引擎身份：engineId + 按 mode 解析出的 model 版本。M6 进 chunk layout hash。 */
  fingerprintKey(req: SynthesisRequest): string {
    const model = MIMO_TTS_MODELS[req.voiceProfile.mode] ?? "unknown";
    return `${this.id}:${model}`;
  }

  async synthesize(
    req: SynthesisRequest,
    opts?: SynthesizeOpts,
  ): Promise<SynthesisResult> {
    const mimoInput = synthesisRequestToMimoInput(req, opts);
    const result = await mimoChatAudioTTSProvider.synthesize(mimoInput);
    return {
      requestId: req.requestId,
      audio: Buffer.from(result.audioBase64, "base64"),
      duration: wavDurationSecondsFromBase64(result.audioBase64),
    };
  }
}

/** 单例。由 `registerBuiltInEngines` 在启动时注入 registry。 */
export const mimoTtsEngine = new MimoTtsEngine();
