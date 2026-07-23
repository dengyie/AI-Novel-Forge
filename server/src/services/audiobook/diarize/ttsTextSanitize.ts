/**
 * TTS 文本卫生：短句补句末标点、丢弃空/纯标点，避免 MiMo 400。
 */

const TRAILING_INCOMPLETE = /[，、,;；：:\s]+$/u;
const HAS_TERMINAL = /[。！？…!?.」』"”]$/u;
const ONLY_PUNCT = /^[\s\p{P}\p{S}]+$/u;

/**
 * 规范化单段/单 chunk 合成文本。
 * - trim
 * - 空或纯标点 → null（调用方 drop）
 * - 以逗号/顿号等收尾且无句末标点 → 换成句号
 */
export function sanitizeTtsChunkText(text: string | null | undefined): string | null {
  let t = (text ?? "").replace(/\r\n/g, "\n").trim();
  if (!t) return null;
  if (ONLY_PUNCT.test(t)) return null;

  if (TRAILING_INCOMPLETE.test(t) && !HAS_TERMINAL.test(t.replace(TRAILING_INCOMPLETE, ""))) {
    t = t.replace(TRAILING_INCOMPLETE, "");
    if (!t) return null;
    if (!HAS_TERMINAL.test(t)) {
      t = `${t}。`;
    }
  } else if (t.length <= 24 && !HAS_TERMINAL.test(t) && !/[，、,]$/u.test(t)) {
    // 极短且无任何收尾：补句号，降低不完整句 400
    if (/[一-鿿A-Za-z0-9]/.test(t)) {
      t = `${t}。`;
    }
  }

  t = t.trim();
  if (!t || ONLY_PUNCT.test(t)) return null;
  return t;
}
