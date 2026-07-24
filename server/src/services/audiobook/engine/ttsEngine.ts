/**
 * TtsEngine —— L3 引擎层的统一合成端口（= CosyVoice model.tts 的引擎无关抽象）。
 *
 * 设计纪律（对照 CosyVoice `model.tts(**model_input)`）：
 *   - Engine 对 mode **几乎**无感：SynthesisRequest 已由 L1 SynthesisBuilder 按 mode 组装好，
 *     Engine 只需把请求映射到各自协议（MiMo chat-audio / 未来 CosyVoice gRPC 等）。
 *   - 「几乎」= mode→model 映射允许 Engine 内部读 mode（preset→mimo-v2.5-tts 等），
 *     但**不在 Engine 层做 delivery/style 合并**——那是 SynthesisBuilder 的事。
 *   - fingerprintKey 返回引擎身份字符串（含 model 版本），用于缓存指纹（消灭 P-5）。
 *
 * SoT: docs/plans/audiobook-synthesis-layering-refactor-design.md §5
 */

import type { SynthesisRequest, SynthesisResult } from "./synthesisRequest";

/** 引擎标识。未来扩引擎只在此处加成员。 */
export type TtsEngineId = "mimo";

/**
 * 单个 TTS 引擎的统一端口。
 *
 * 实现约束：
 * - synthesize 不得修改 SynthesisRequest 字段（只读）
 * - 失败时抛 AppError（statusCode 决定是否可重试）
 * - 取消通过 opts.signal（AbortSignal）
 */
export interface TtsEngine {
  /** 引擎标识（日志/注册/选择用） */
  readonly id: TtsEngineId;

  /**
   * 缓存指纹的引擎身份部分。
   * 包含 engineId + model 版本；同一引擎的不同 model（preset/design/clone）
   * 可能返回不同 key（因为 model string 不同）。
   *
   * 约定：变了 = 旧缓存应失效。
   */
  fingerprintKey(req: SynthesisRequest): string;

  /**
   * 执行一次合成（对应 CosyVoice 的 `model.tts(**model_input)`）。
   *
   * @returns 合成结果（音频 buffer + 元数据）
   * @throws AppError - 可重试 5xx/504/429；不可重试 4xx/408
   */
  synthesize(
    req: SynthesisRequest,
    opts?: SynthesizeOpts,
  ): Promise<SynthesisResult>;
}

export interface SynthesizeOpts {
  signal?: AbortSignal;
  /** 超时毫秒。引擎有自己的默认；调用方可覆盖。 */
  timeoutMs?: number;
}
