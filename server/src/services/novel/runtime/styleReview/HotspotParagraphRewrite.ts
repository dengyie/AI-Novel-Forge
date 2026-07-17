import {
  detectProseQuality,
  type ProseQualityIssueCode,
} from "../proseQuality/ProseQualityDetector";

export type ParagraphSlice = {
  index: number;
  text: string;
  start: number;
  end: number;
};

export const DEFAULT_HOTSPOT_MIN_RUN = 3;
export const DEFAULT_MAX_HOTSPOTS = 4;
/** 采纳候选时允许 residual risk 略高于 baseline 的容差（风格分噪声）。 */
export const HOTSPOT_RISK_EPSILON = 5;
/** 相对 baseline 可见长度塌缩阈值：低于该比例丢弃（防删段）。 */
export const HOTSPOT_MIN_LENGTH_RATIO = 0.5;

const HARD_PRONOUN_CODES: ReadonlySet<string> = new Set([
  "prose_pronoun_subject_stack",
  "prose_pronoun_density",
]);

const HARD_REGRESSION_CODES: ReadonlySet<ProseQualityIssueCode | string> = new Set([
  "prose_system_hud",
  "prose_truncation",
  "prose_verbatim_repeat",
  "prose_placeholder_leak",
  "sot_banned_term",
  "sot_must_avoid_leak",
]);

/**
 * 按空行切叙事段。index 为段序号（0-based），start/end 为原文半开区间。
 * 连续空行合并；首尾空白段丢弃。
 */
export function splitNarrativeParagraphs(content: string): ParagraphSlice[] {
  const normalized = content.replace(/\r\n/g, "\n");
  if (!normalized.trim()) {
    return [];
  }
  const slices: ParagraphSlice[] = [];
  // 用 split 保留边界：按 \n\n+ 分段，并手动算 start。
  let index = 0;
  let cursor = 0;
  const parts = normalized.split(/\n{2,}/);
  for (let i = 0; i < parts.length; i += 1) {
    const part = parts[i];
    // 在原文中定位：从 cursor 起找 part（允许前置 \n）
    const found = normalized.indexOf(part, cursor);
    if (found < 0) {
      continue;
    }
    const text = part;
    // 空段（仅空白）跳过，不占 index——调用方按「有正文的段」改写
    if (text.trim().length === 0) {
      cursor = found + part.length;
      continue;
    }
    slices.push({
      index,
      text,
      start: found,
      end: found + text.length,
    });
    index += 1;
    cursor = found + text.length;
  }
  return slices;
}

function maxPronounSubjectRun(paragraph: string): number {
  // 与 L0 对齐：句级「他/她」起句连续 run；对话行/引号起句不计入。
  const sentences = Array.from(paragraph.matchAll(/[^。！？!?]+[。！？!?]?/gu))
    .map((m) => m[0].trim())
    .filter(Boolean);
  let maxRun = 0;
  let run = 0;
  for (const sentence of sentences) {
    if (/^[「『“"]/u.test(sentence)) {
      run = 0;
      continue;
    }
    // 整行对话感：以引号/说白主导
    if (/^[「『“"]/u.test(sentence) || /^(?:“|「)/u.test(sentence)) {
      run = 0;
      continue;
    }
    if (/^[他她]/u.test(sentence)) {
      run += 1;
      maxRun = Math.max(maxRun, run);
    } else {
      run = 0;
    }
  }
  return maxRun;
}

/**
 * 选出句首他/她连续 run ≥ minRun 的热点段，按 run 降序截断 maxHotspots。
 * 默认 minRun=3（早于 L0 hard=4 介入，给段落改写机会）。
 */
export function selectPronounHotspotParagraphs(
  content: string,
  options?: { minRun?: number; maxHotspots?: number },
): ParagraphSlice[] {
  const minRun = options?.minRun ?? DEFAULT_HOTSPOT_MIN_RUN;
  const maxHotspots = options?.maxHotspots ?? DEFAULT_MAX_HOTSPOTS;
  const slices = splitNarrativeParagraphs(content);
  const ranked = slices
    .map((slice) => ({ slice, run: maxPronounSubjectRun(slice.text) }))
    .filter((item) => item.run >= minRun)
    .sort((a, b) => b.run - a.run || a.slice.index - b.slice.index)
    .slice(0, Math.max(0, maxHotspots))
    .map((item) => item.slice)
    // 下游按原文顺序改写，避免后段 index 因前段文本长度变化错位
    .sort((a, b) => a.index - b.index);
  return ranked;
}

/**
 * 用 replacements 替换指定段落 index 的正文，保留段间分隔（空行结构按 split 重建）。
 * 未知 index 忽略。
 */
export function stitchParagraphs(
  original: string,
  replacements: Array<{ index: number; text: string }>,
): string {
  const slices = splitNarrativeParagraphs(original);
  if (slices.length === 0) {
    return original;
  }
  const byIndex = new Map(replacements.map((item) => [item.index, item.text]));
  // 重建：用原文在相邻段之间的 gap（含空行）拼接，替换 text 时保持 gap。
  let out = "";
  let cursor = 0;
  for (const slice of slices) {
    // 段前 gap
    if (slice.start > cursor) {
      out += original.slice(cursor, slice.start);
    }
    const nextText = byIndex.has(slice.index) ? byIndex.get(slice.index)! : slice.text;
    out += nextText;
    cursor = slice.end;
  }
  if (cursor < original.length) {
    out += original.slice(cursor);
  }
  return out;
}

export type HotspotScore = {
  riskScore: number;
  blockingPronoun: boolean;
  lengthDelta: number;
  hardRegression: boolean;
  /** 句首他/她最大连续 run（与 L0 hard=4 可不同；热点 minRun=3 也算 blocking）。 */
  pronounRun: number;
};

/**
 * 基于 detectProseQuality 的确定性打分（无 LLM），供 pick / 单测复用。
 * baselineVisibleLength 用于 lengthDelta（相对基线可见长）。
 *
 * 注意：L0 stack hard=4，但热点介入 minRun=3——run∈[3,3] 时 prose 可能无 stack finding，
 * 仍须把 pronounRun≥DEFAULT_HOTSPOT_MIN_RUN 视为 blocking，否则 pick 永远「无改善」。
 */
export function scoreTextForHotspotPick(
  text: string,
  baselineVisibleLength: number,
): HotspotScore {
  const prose = detectProseQuality(text);
  const codes = new Set(prose.findings.map((f) => f.code));
  const pronounRun = maxPronounSubjectRun(text);
  const blockingPronoun =
    prose.findings.some((f) => HARD_PRONOUN_CODES.has(f.code))
    || pronounRun >= DEFAULT_HOTSPOT_MIN_RUN;
  const hardRegression = prose.findings.some(
    (f) =>
      HARD_REGRESSION_CODES.has(f.code)
      || (f.severity === "critical" && !HARD_PRONOUN_CODES.has(f.code)),
  );
  // 合成 risk：硬回归优先顶到高分；pronoun hard 次之；热点 run≥3 抬中分。
  let riskScore = 0;
  if (hardRegression) {
    riskScore = Math.max(riskScore, 90);
  }
  if (codes.has("prose_pronoun_subject_stack")) {
    riskScore = Math.max(riskScore, 55);
  }
  if (codes.has("prose_pronoun_density")) {
    riskScore = Math.max(riskScore, 45);
  }
  if (codes.has("prose_pronoun_density_soft")) {
    riskScore = Math.max(riskScore, 25);
  }
  // 热点 run 尚未达 L0 hard 时也抬分，供 riskBetter 比较。
  if (pronounRun >= DEFAULT_HOTSPOT_MIN_RUN) {
    riskScore = Math.max(riskScore, 20 + pronounRun * 10);
  }
  if (prose.findings.length > 0 && riskScore === 0) {
    riskScore = Math.min(40, 10 + prose.findings.length * 5);
  }
  const visible = text.replace(/\s+/g, "").length;
  return {
    riskScore,
    blockingPronoun,
    lengthDelta: visible - baselineVisibleLength,
    hardRegression,
    pronounRun,
  };
}

export function pickBetterStyleCandidate(input: {
  baseline: string;
  candidates: string[];
  score: (text: string) => HotspotScore;
}): { content: string; adoptedIndex: number | null; reason: string } {
  const baselineScore = input.score(input.baseline);
  const baselineVisible = input.baseline.replace(/\s+/g, "").length;
  let best: {
    content: string;
    adoptedIndex: number;
    score: HotspotScore;
  } | null = null;

  for (let i = 0; i < input.candidates.length; i += 1) {
    const candidate = input.candidates[i];
    if (!candidate || !candidate.trim()) {
      continue;
    }
    const score = input.score(candidate);
    const candidateVisible = candidate.replace(/\s+/g, "").length;
    // 字数塌缩
    if (
      baselineVisible > 0
      && candidateVisible < baselineVisible * HOTSPOT_MIN_LENGTH_RATIO
    ) {
      continue;
    }
    // 硬回归（HUD / sot / critical 非 pronoun）
    if (score.hardRegression) {
      continue;
    }
    // 未改善 pronoun 且 risk 升高 → 丢
    const pronounImproved =
      baselineScore.blockingPronoun && !score.blockingPronoun;
    const riskOk = score.riskScore <= baselineScore.riskScore + HOTSPOT_RISK_EPSILON;
    const riskBetter = score.riskScore < baselineScore.riskScore;
    if (!pronounImproved && !riskBetter && score.blockingPronoun === baselineScore.blockingPronoun) {
      // 完全无改善
      if (score.riskScore >= baselineScore.riskScore) {
        continue;
      }
    }
    if (!riskOk && !pronounImproved) {
      continue;
    }
    // 若 baseline 有 blocking pronoun，候选仍 blocking 且 risk 不降 → 丢
    if (baselineScore.blockingPronoun && score.blockingPronoun && !riskBetter) {
      continue;
    }

    if (
      !best
      || score.riskScore < best.score.riskScore
      || (
        score.riskScore === best.score.riskScore
        && Number(score.blockingPronoun) < Number(best.score.blockingPronoun)
      )
    ) {
      best = { content: candidate, adoptedIndex: i, score };
    }
  }

  if (!best) {
    return {
      content: input.baseline,
      adoptedIndex: null,
      reason: "no_candidate_improved",
    };
  }
  return {
    content: best.content,
    adoptedIndex: best.adoptedIndex,
    reason: best.score.blockingPronoun === false && baselineScore.blockingPronoun
      ? "pronoun_cleared"
      : "risk_improved",
  };
}
