import type { LLMProvider } from "@ai-novel/shared/types/llm";

/**
 * writer 单次 LLM 调用的墙钟预算工厂（D1 重构）。
 *
 * 背景：旧公式用单一常量 WRITER_CHARS_PER_SECOND=25 对 gemini-3.7-flash-high（经 cpa 实测
 * ~13.5 字/秒）乐观 1.85×，整章 draft 8000 字预算仅 512s，生产流到 81% 撞墙。短续写 probe
 * （~1500 字）全部 floor 兜底通过，掩盖了长样本才触发的欠配——这是「短 probe 全过、长 draft 挂」
 * 的方法论根因。
 *
 * 重构口径（产品铁律：只调超时预算，不调字数下限/节奏）：
 * - 吞吐按 model 维度登记实测值。生产 gemini/deepseek 实际都走 provider="openai"（CPA 统一出口），
 *   靠 model 字符串区分，故主键用 model 而非 provider（provider 维度会把 gemini/deepseek 混成一档）。
 * - 未知 model 回落保守默认（不乐观于已知最慢模型），避免新接入模型重蹈撞墙覆辙。
 * - floor/ceiling/headroom 沿用旧值，保持短章不退化、长章有上限的语义不变。
 */
const WRITER_TIMEOUT_MIN_MS = 480_000;
const WRITER_TIMEOUT_MAX_MS = 1_500_000;
const WRITER_TIMEOUT_HEADROOM = 1.6;

/**
 * 实测吞吐登记表（字/秒）。新增模型须登记实测值，不得沿用乐观默认。
 * - gemini-3.7-flash-high：2026-08-16 pxed 生产栈 + cpa 三层同步验证实测 ~13.5 字/秒。
 * - deepseek-v4-pro：注释记录 ~15-20 tok/s（CJK 1 tok≈1-2 字），取保守下限 15 字/秒。
 */
const WRITER_MODEL_CHARS_PER_SECOND: Record<string, number> = {
  "gemini-3.7-flash-high": 13.5,
  "deepseek-v4-pro": 15,
};

/**
 * 未知 model 的回落吞吐。必须保守（不乐观于已知最慢模型 gemini 13.5），让新模型在登记实测值前
 * 走偏慢预算，宁可早超时被 transport retry 接管，也不重蹈乐观撞墙。
 */
const WRITER_FALLBACK_CHARS_PER_SECOND = 13.5;

function resolveModelCharsPerSecond(model?: string): number {
  if (typeof model === "string" && WRITER_MODEL_CHARS_PER_SECOND[model] != null) {
    return WRITER_MODEL_CHARS_PER_SECOND[model];
  }
  return WRITER_FALLBACK_CHARS_PER_SECOND;
}

export function resolveWriterTimeoutMs(input: {
  targetWordCount?: number | null;
  provider?: LLMProvider;
  model?: string;
}): number {
  const target = typeof input.targetWordCount === "number" && Number.isFinite(input.targetWordCount)
    ? Math.max(0, input.targetWordCount)
    : 0;
  if (target <= 0) {
    return WRITER_TIMEOUT_MIN_MS;
  }
  const charsPerSecond = resolveModelCharsPerSecond(input.model);
  const estimated = (target / charsPerSecond) * 1000 * WRITER_TIMEOUT_HEADROOM;
  return Math.min(
    WRITER_TIMEOUT_MAX_MS,
    Math.max(WRITER_TIMEOUT_MIN_MS, Math.ceil(estimated)),
  );
}

export const WRITER_TIMEOUT_CONSTANTS = {
  MIN_MS: WRITER_TIMEOUT_MIN_MS,
  MAX_MS: WRITER_TIMEOUT_MAX_MS,
  HEADROOM: WRITER_TIMEOUT_HEADROOM,
  MODEL_CHARS_PER_SECOND: WRITER_MODEL_CHARS_PER_SECOND,
  FALLBACK_CHARS_PER_SECOND: WRITER_FALLBACK_CHARS_PER_SECOND,
} as const;
