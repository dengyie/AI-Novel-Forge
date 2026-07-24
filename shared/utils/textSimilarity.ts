/**
 * 长文本相似度通用工具：normalize → n-gram → jaccard。
 *
 * 同源消费点（默认 n=7）：
 * - server/src/services/novel/NovelContinuationService（续写 anti-copy）
 * - server/src/services/novel/runtime/openingDiversity（章首多样性）
 *
 * 注意：server/src/services/title/titleGeneration.shared.ts 的相似度用的是 bigram(n=2) +
 * normalizeTitle 口径，与本工具 normalize（去空白+标点）不一致，故未合并到此处；
 * 若将来需统一 title 相似口径，需先评估 normalize 差异对命中的影响，不可直接复用。
 */

const DEFAULT_NGRAM_SIZE = 7;

/**
 * 归一化后允许参与相似度比较的最小长度。低于此长度（多为标点/数字/极短语）会被
 * `buildNGramSet` 压成单 gram，jaccard 极易虚高（如人名/短词偶同即 1.0），故两处
 * 消费点（续写防复刻、章首多样性）对 target 与 snippet 均以此长度为下限过滤。
 */
export const MIN_NORMALIZED_SIMILARITY_LEN = 8;

/**
 * 去空白与中英文标点后返回纯文字序列，供 n-gram 切分。
 * 中英文句读、引号、括号、换行、常见标点全部移除；不做分词。
 */
export function normalizeForSimilarity(text: string): string {
  return text
    .replace(/\s+/g, "")
    .replace(/[，。！？；：、""''（）《》【】\[\]\(\)!?,.:;'"`~\-_/\\|@#$%^&*+=<>]/g, "")
    .trim();
}

/**
 * 归一化长度是否足够参与相似度比较（避免短串压成单 gram 误报高相似）。
 * 两处消费点统一调用，确保「同 length 过滤」口径一致：原检测与改写后复检同一下限。
 */
export function hasSufficientSimilarityLength(text: string): boolean {
  return normalizeForSimilarity(text).length >= MIN_NORMALIZED_SIMILARITY_LEN;
}

/**
 * 将文本切为长度 n 的字符 n-gram 集合（去重）。
 * 规格：
 * - 归一化后为空 → 空集
 * - 归一化后长度 <= n → 单元素集合（整段作为一个 gram）
 * 默认 n=7（比 n=5 更严：让常见短句不再仅凭 5 字滑窗即判相似，减少虚高）。
 */
export function buildNGramSet(source: string, n: number = DEFAULT_NGRAM_SIZE): Set<string> {
  const normalized = normalizeForSimilarity(source);
  if (!normalized) {
    return new Set<string>();
  }
  if (normalized.length <= n) {
    return new Set<string>([normalized]);
  }
  const grams = new Set<string>();
  for (let i = 0; i <= normalized.length - n; i += 1) {
    grams.add(normalized.slice(i, i + n));
  }
  return grams;
}

/**
 * 两个 n-gram 集合的 jaccard 相似度：|A∩B| / |A∪B|。
 * 任一为空集 → 0（避免用空集放大虚假相似）。
 * 与 NovelContinuationService.jaccardSimilarity 行为一致。
 */
export function jaccardSimilarity(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) {
    return 0;
  }
  let intersection = 0;
  for (const item of a) {
    if (b.has(item)) {
      intersection += 1;
    }
  }
  const union = a.size + b.size - intersection;
  return union === 0 ? 0 : intersection / union;
}
