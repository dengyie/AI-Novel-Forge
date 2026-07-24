/**
 * SynthesisRequest —— L2 SynthesisBuilder → L3 TtsEngine 的唯一合成请求契约。
 *
 * 设计纪律：
 *   - 单一职责：一条请求 = 一段连续音频 = 一次 TTS 调用
 *   - 不包含段拆分逻辑（拆分由 Chunker 负责，输出多个 Request）
 *   - 不包含 delivery 覆盖的合并（合并由 SynthesisBuilder 负责，产出单一 Request）
 *   - 不包含 speaker 解析（解析由 VoiceResolver 负责，产出 VoiceProfile）
 *   - 不包含文本清洗（清洗由 TextNormalizer 负责）
 *   - Engine 只需「读」请求，不改任何字段
 *
 * SoT: docs/plans/audiobook-synthesis-layering-refactor-design.md §4.2
 */

import type { AudiobookTtsMode } from "@ai-novel/shared/types/audiobook";
import type { VoiceProfile } from "../voice/voiceProfile";

/**
 * 单次合成的完整请求。
 * 包含文本内容 + 说话人音色 + delivery 样式。
 */
export interface SynthesisRequest {
  /** 唯一标识（用于日志/缓存/调试） */
  requestId: string;
  /** 待合成文本（已清洗/正则化，不含 XML 标记） */
  text: string;
  /** 说话人音色契约（由 VoiceResolver 解析产出） */
  voiceProfile: VoiceProfile;
  /**
   * Delivery 样式覆盖（可选）。
   * 合并逻辑由 SynthesisBuilder 负责：baseStyle/baseDesignPrompt + delivery → 最终样式。
   * Engine 不处理优先级冲突，只应用最终合并结果。
   */
  delivery: DeliveryOverride | null;
  /** 引擎内部参数（如温度/采样率）由 MimoTtsEngine 适配器注入 */
  engineParams?: EngineInternalParams;
}

/**
 * Delivery 覆盖参数（已合并 baseStyle/baseDesignPrompt）。
 * Engine 应用这些参数到 TTS API。
 */
export interface DeliveryOverride {
  style?: string;
  designPrompt?: string;
}

/**
 * 引擎内部参数（由适配器注入，不在 L1/L2 契约内）。
 * 例如：temperature, top_p, sample_rate 等。
 */
export interface EngineInternalParams {
  [key: string]: unknown;
}

/**
 * 合成结果（由 L3 TtsEngine 产出，传回 L2）。
 */
export interface SynthesisResult {
  /** 对应的 request ID */
  requestId: string;
  /** 合成音频数据（格式由引擎约定，通常是 WAV/PCM） */
  audio: Buffer;
  /** 音频时长（秒） */
  duration: number;
  /** 可选的元数据（采样率/声道数等） */
  metadata?: AudioMetadata;
}

/**
 * 音频元数据。
 */
export interface AudioMetadata {
  sampleRate: number;
  channels: number;
  bitsPerSample?: number;
}
