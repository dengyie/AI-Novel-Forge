/**
 * L1 Frontend — TextNormalizer（空壳 / M4）
 *
 * 定位（借鉴 CosyVoice `text_normalize`）：
 *   - 一处收口所有「TTS 合成文本」的读音替换 / TN 规则；
 *   - 正文落库文本不动，仅改传给引擎的 `SynthesisRequest.text`；
 *   - 作用于 chunk 文本（split 之后、sanitize 之前）。
 *
 * 现状：**首个 milestone 只保留 hook 位**，`normalizeTtsChunkText` 为纯透传。
 *   - 后续可在此接入：
 *       · 用户级读音词典（人名/术语正音）；
 *       · 数字/英文/单位归一（e.g. `100km/h` → `一百千米每小时`）；
 *       · 破折号/省略号折叠；
 *       · 方言字段辅助（若 VoiceProfile.dialectHint 命中）。
 *
 * 契约：入 `null/undefined/""` 归一为 `""`；否则返回**去除首尾空白后**的文本。
 *   —— 与旧行为一致（旧 `expandSegmentsToChunkJobs` 中 sanitize 前的 `splitTextForTts`
 *      产物已 trim，pass-through 也不影响 fingerprint）。
 */

export interface TextNormalizeContext {
  /** 语言/方言提示（未来预留）；当前忽略。 */
  languageHint?: string | null;
  /** 说话人 key（未来读音词典按角色分域时用）；当前忽略。 */
  speakerKey?: string | null;
}

/**
 * TTS chunk 文本归一（透传）。
 *
 * @param text 已 split 但未 sanitize 的 chunk 文本
 * @param _ctx 归一上下文（当前透传，为未来读音/方言预留）
 */
export function normalizeTtsChunkText(
  text: string | null | undefined,
  _ctx?: TextNormalizeContext,
): string {
  if (text == null) return "";
  return String(text);
}
