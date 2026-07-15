import type {
  RuntimeAuditIssue,
  RuntimeAuditReport,
} from "@ai-novel/shared/types/chapterRuntime";

export type ProseQualityIssueCode =
  | "prose_negative_flip"
  | "prose_dash_or_ellipsis"
  | "prose_period_stutter"
  | "prose_long_paragraph"
  | "prose_verbatim_repeat"
  | "prose_truncation"
  | "prose_ai_self_reference"
  | "prose_placeholder_leak"
  | "prose_engineering_term_leak"
  | "sot_banned_term"
  | "sot_must_avoid_leak";

export interface ProseQualityFinding {
  code: ProseQualityIssueCode;
  severity: RuntimeAuditIssue["severity"];
  line: number;
  column: number;
  message: string;
  excerpt: string;
  fixSuggestion: string;
}

export interface ProseQualityReport {
  findings: ProseQualityFinding[];
  hasBlockingFindings: boolean;
}

/** 可选 SoT/mustAvoid 词表；默认空，不改变既有 prose_* 行为。 */
export interface ProseQualityDetectOptions {
  bannedTerms?: string[] | null;
  mustAvoidTerms?: string[] | null;
}

export interface ProseQualityAuditReportInput {
  novelId: string;
  chapterId: string;
  report: ProseQualityReport;
  now?: Date;
}

interface TextSegment {
  text: string;
  line: number;
}

const MAX_FINDINGS_PER_CODE = 8;
const MAX_TOTAL_FINDINGS = 40;

/** 破折号/省略号密度：每千字命中数超过该值才记 medium 质量债（仍不 hard-block）。 */
export const PROSE_DASH_ELLIPSIS_DENSITY_SOFT_PER_1K = 3.5;
/** 极稀疏时不记 finding，避免正常网文节奏被刷屏。 */
export const PROSE_DASH_ELLIPSIS_DENSITY_IGNORE_BELOW_PER_1K = 1.2;

const TERMINAL_PUNCTUATION = /[。！？!?”"」』）)】》…]$/u;
const NEGATIVE_FLIP_PATTERN = /(?:不是|并非|并不是|不算|不能说是|没有|不再是)[^。！？；;\n]{1,36}?[，,、]?\s*(?:而是|却是|反而是|更像是|只是)[^。！？；;\n]{1,36}/gu;
const DASH_OR_ELLIPSIS_PATTERN = /——|—|--|……|…{2,}|\.{3,}/gu;
const AI_SELF_REFERENCE_PATTERN = /作为(?:一名|一个)?(?:AI|人工智能|语言模型)|我是(?:AI|人工智能|语言模型)|我无法(?:继续)?(?:创作|生成|提供|完成)|我不能(?:继续)?(?:创作|生成|提供|完成)|无法满足(?:该|这个)?请求|不能协助|as an AI|I (?:am|cannot|can't)[^。！？.!?\n]{0,40}AI/iu;
const PLACEHOLDER_PATTERN = /TODO|TBD|待补充|此处省略|省略若干|略写|占位|PLACEHOLDER|\{\{[^}]{0,80}\}\}|\[[^\]]{0,40}待补[^\]]{0,40}\]/iu;
const ENGINEERING_TERM_STRONG_PATTERN = /细纲|情节点|卷纲|功能标签|目标情绪|字数目标|章首钩子|章尾钩子|任务描述|任务单|scene\s*card|prompt|schema|runtime\s*package|上下文包|系统提示词|修复指令/iu;
const ENGINEERING_TERM_SOFT_PATTERN = /本章|下一章|读者|伏笔|前文|后文|剧情推进|人物弧光|爽点|节奏点|钩子/u;

/**
 * 正文机械 L0：既有 prose_* + 可选 SoT/mustAvoid（sot_*）。
 * options 缺省或词表空时行为与历史 detectProseQuality(content) 一致。
 */
export function detectProseQuality(
  content: string,
  options: ProseQualityDetectOptions = {},
): ProseQualityReport {
  const segments = buildTextSegments(content);
  const findings: ProseQualityFinding[] = [];
  const counts = new Map<ProseQualityIssueCode, number>();

  const addFinding = (finding: ProseQualityFinding) => {
    if (findings.length >= MAX_TOTAL_FINDINGS) {
      return;
    }
    const currentCount = counts.get(finding.code) ?? 0;
    if (currentCount >= MAX_FINDINGS_PER_CODE) {
      return;
    }
    const duplicated = findings.some((existing) => (
      existing.code === finding.code
      && existing.line === finding.line
      && existing.excerpt === finding.excerpt
    ));
    if (duplicated) {
      return;
    }
    counts.set(finding.code, currentCount + 1);
    findings.push(finding);
  };

  for (const segment of segments) {
    scanNegativeFlip(segment, addFinding);
    scanAiSelfReference(segment, addFinding);
    scanPlaceholderLeak(segment, addFinding);
    scanEngineeringTermLeak(segment, addFinding);
    scanPeriodStutter(segment, addFinding);
    scanLongParagraph(segment, addFinding);
  }

  // 破折号/省略号：按全文密度轻量 pass，不逐句硬刷、不升 critical。
  scanDashOrEllipsisDensity(content, segments, addFinding);

  scanVerbatimRepeat(segments, addFinding);
  scanTruncation(content, segments, addFinding);

  // SoT / mustAvoid：high，默认词表空不触发。
  scanTermListLeak(segments, normalizeTermList(options.bannedTerms), "sot_banned_term", addFinding);
  scanTermListLeak(segments, normalizeTermList(options.mustAvoidTerms), "sot_must_avoid_leak", addFinding);

  return {
    findings,
    hasBlockingFindings: findings.some((finding) => (
      finding.severity === "high" || finding.severity === "critical"
    )),
  };
}

/** 将 mustAvoid 原文或词表规范为 ≥2 字去重词。 */
export function normalizeProseQualityTermList(
  terms: string | string[] | null | undefined,
): string[] {
  if (terms == null) {
    return [];
  }
  if (typeof terms === "string") {
    return uniqueTerms(terms.split(/[\n；;，,、|/]+/g));
  }
  return uniqueTerms(terms.flatMap((term) => String(term).split(/[\n；;，,、|/]+/g)));
}

function normalizeTermList(terms: string[] | null | undefined): string[] {
  return normalizeProseQualityTermList(terms ?? []);
}

function uniqueTerms(values: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of values) {
    const term = raw.trim();
    if (term.length < 2 || seen.has(term)) {
      continue;
    }
    seen.add(term);
    out.push(term);
  }
  return out;
}

function scanTermListLeak(
  segments: TextSegment[],
  terms: string[],
  code: "sot_banned_term" | "sot_must_avoid_leak",
  addFinding: (finding: ProseQualityFinding) => void,
): void {
  if (terms.length === 0) {
    return;
  }
  for (const segment of segments) {
    for (const term of terms) {
      const index = segment.text.indexOf(term);
      if (index < 0 || isInsideQuote(segment.text, index)) {
        continue;
      }
      addFinding({
        code,
        severity: "high",
        line: segment.line,
        column: index + 1,
        message: code === "sot_banned_term"
          ? `正文命中 SoT 禁词「${term}」。`
          : `正文泄漏 mustAvoid 项「${term}」。`,
        excerpt: formatExcerpt(segment.text),
        fixSuggestion: code === "sot_banned_term"
          ? "删除或改写禁词，保持与世界观/SoT 一致。"
          : "删除或改写 mustAvoid 泄漏，避免合同禁止项进入正文。",
      });
    }
  }
}

export function buildProseQualityAuditReport(
  input: ProseQualityAuditReportInput,
): RuntimeAuditReport | null {
  if (input.report.findings.length === 0) {
    return null;
  }
  const createdAt = (input.now ?? new Date()).toISOString();
  const reportId = `prose-quality:${input.novelId}:${input.chapterId}`;
  const issues = input.report.findings.map<RuntimeAuditIssue>((finding, index) => ({
    id: `${reportId}:${index + 1}:${finding.code}`,
    reportId,
    auditType: "mode_fit",
    severity: finding.severity,
    code: finding.code,
    description: finding.message,
    evidence: `第 ${finding.line} 行：${finding.excerpt}`,
    fixSuggestion: finding.fixSuggestion,
    status: "open",
    createdAt,
    updatedAt: createdAt,
  }));

  return {
    id: reportId,
    novelId: input.novelId,
    chapterId: input.chapterId,
    auditType: "mode_fit",
    overallScore: scoreFindings(input.report.findings),
    summary: `正文自然度/退化检测发现 ${issues.length} 个问题。`,
    legacyScoreJson: null,
    issues,
    createdAt,
    updatedAt: createdAt,
  };
}

function buildTextSegments(content: string): TextSegment[] {
  const lines = content.replace(/\r\n/g, "\n").split("\n");
  const segments: TextSegment[] = [];
  let inFence = false;
  lines.forEach((line, index) => {
    const trimmed = line.trim();
    if (/^(```|~~~)/u.test(trimmed)) {
      inFence = !inFence;
      return;
    }
    if (inFence || trimmed.length === 0 || trimmed.startsWith(">")) {
      return;
    }
    segments.push({
      text: line,
      line: index + 1,
    });
  });
  return segments;
}

function scanNegativeFlip(
  segment: TextSegment,
  addFinding: (finding: ProseQualityFinding) => void,
): void {
  for (const match of segment.text.matchAll(NEGATIVE_FLIP_PATTERN)) {
    const index = match.index ?? 0;
    if (isInsideQuote(segment.text, index) || /不是[^。！？；;\n]{1,16}就是/u.test(match[0])) {
      continue;
    }
    // 中文网文「不是 A，而是 B」常见对比叙述：保留质量债信号，但降为 medium，
    // 避免单条命中 → hasBlockingFindings → needs_repair 误伤正常章节（同破折号门禁策略）。
    addFinding({
      code: "prose_negative_flip",
      severity: "medium",
      line: segment.line,
      column: index + 1,
      message: "正文出现高频 AI 式否定翻转句，容易显得概念化、模板化。",
      excerpt: formatExcerpt(match[0]),
      fixSuggestion: "改成具体动作、感官细节或角色判断，避免用“不是 A，而是 B”解释主题。",
    });
  }
}

export function measureDashOrEllipsisDensity(content: string): {
  matchCount: number;
  charCount: number;
  perThousand: number;
} {
  const plain = content.replace(/\s+/g, "");
  const charCount = plain.length;
  const matches = content.match(DASH_OR_ELLIPSIS_PATTERN) ?? [];
  const matchCount = matches.length;
  const perThousand = charCount <= 0 ? 0 : (matchCount * 1000) / charCount;
  return { matchCount, charCount, perThousand };
}

function scanDashOrEllipsisDensity(
  content: string,
  segments: TextSegment[],
  addFinding: (finding: ProseQualityFinding) => void,
): void {
  const density = measureDashOrEllipsisDensity(content);
  if (density.matchCount === 0) {
    return;
  }
  // 稀疏合法节奏：不记 finding。
  if (density.perThousand < PROSE_DASH_ELLIPSIS_DENSITY_IGNORE_BELOW_PER_1K) {
    return;
  }
  // 中等密度：只记一条 low 摘要；高密度：medium 样例行 + 不升 high/critical。
  const highDensity = density.perThousand >= PROSE_DASH_ELLIPSIS_DENSITY_SOFT_PER_1K;
  const severity: RuntimeAuditIssue["severity"] = highDensity ? "medium" : "low";
  const sampleSegments = segments
    .filter((segment) => {
      DASH_OR_ELLIPSIS_PATTERN.lastIndex = 0;
      return DASH_OR_ELLIPSIS_PATTERN.test(segment.text);
    })
    .slice(0, highDensity ? 3 : 1);

  if (sampleSegments.length === 0) {
    addFinding({
      code: "prose_dash_or_ellipsis",
      severity,
      line: 1,
      column: 1,
      message: highDensity
        ? `破折号/省略号密度偏高（约 ${density.perThousand.toFixed(1)}/千字），节奏偏模型化。`
        : `正文含少量破折号/省略号（约 ${density.perThousand.toFixed(1)}/千字），可择机改写。`,
      excerpt: formatExcerpt(content.slice(0, 80)),
      fixSuggestion: "优先用动作停顿、句读或人物反应替代机械标点堆叠。",
    });
    return;
  }

  for (const segment of sampleSegments) {
    DASH_OR_ELLIPSIS_PATTERN.lastIndex = 0;
    const match = segment.text.match(DASH_OR_ELLIPSIS_PATTERN);
    addFinding({
      code: "prose_dash_or_ellipsis",
      severity,
      line: segment.line,
      column: (match?.index ?? 0) + 1,
      message: highDensity
        ? `破折号/省略号密度偏高（约 ${density.perThousand.toFixed(1)}/千字），容易形成模型化停顿。`
        : "正文使用破折号或省略号，可改写为更自然的停顿（轻量提示）。",
      excerpt: formatExcerpt(segment.text),
      fixSuggestion: "改写为自然的动作停顿、句读或人物反应，减少机械标点制造的情绪。",
    });
  }
}

function scanAiSelfReference(
  segment: TextSegment,
  addFinding: (finding: ProseQualityFinding) => void,
): void {
  const match = segment.text.match(AI_SELF_REFERENCE_PATTERN);
  if (!match || match.index == null || isInsideQuote(segment.text, match.index)) {
    return;
  }
  addFinding({
    code: "prose_ai_self_reference",
    severity: "critical",
    line: segment.line,
    column: match.index + 1,
    message: "正文泄漏 AI 身份、拒绝话术或模型说明。",
    excerpt: formatExcerpt(segment.text),
    fixSuggestion: "删除 AI 自述和拒绝话术，改成符合角色与场景的正文叙述。",
  });
}

function scanPlaceholderLeak(
  segment: TextSegment,
  addFinding: (finding: ProseQualityFinding) => void,
): void {
  const match = segment.text.match(PLACEHOLDER_PATTERN);
  if (!match || match.index == null || isInsideQuote(segment.text, match.index)) {
    return;
  }
  addFinding({
    code: "prose_placeholder_leak",
    severity: "critical",
    line: segment.line,
    column: match.index + 1,
    message: "正文包含占位、待补或省略提示。",
    excerpt: formatExcerpt(segment.text),
    fixSuggestion: "补成完整可读的剧情内容，不能把占位符留给读者。",
  });
}

function scanEngineeringTermLeak(
  segment: TextSegment,
  addFinding: (finding: ProseQualityFinding) => void,
): void {
  const strongMatch = segment.text.match(ENGINEERING_TERM_STRONG_PATTERN);
  if (strongMatch?.index != null && !isInsideQuote(segment.text, strongMatch.index)) {
    addFinding({
      code: "prose_engineering_term_leak",
      severity: "high",
      line: segment.line,
      column: strongMatch.index + 1,
      message: "正文泄漏任务单、细纲、提示词或运行态工程词。",
      excerpt: formatExcerpt(segment.text),
      fixSuggestion: "删去工程词和写作指令，把信息改写成角色行动、环境变化或叙事结果。",
    });
    return;
  }

  const softMatch = segment.text.match(ENGINEERING_TERM_SOFT_PATTERN);
  if (softMatch?.index != null && !isInsideQuote(segment.text, softMatch.index)) {
    addFinding({
      code: "prose_engineering_term_leak",
      severity: "medium",
      line: segment.line,
      column: softMatch.index + 1,
      message: "正文出现偏创作说明的元叙事词，可能削弱沉浸感。",
      excerpt: formatExcerpt(segment.text),
      fixSuggestion: "把面向作者或读者的说明转成故事内部可见的行动、结果或信息差。",
    });
  }
}

function scanPeriodStutter(
  segment: TextSegment,
  addFinding: (finding: ProseQualityFinding) => void,
): void {
  if (lineLooksLikeDialogue(segment.text)) {
    return;
  }
  const matches = Array.from(segment.text.matchAll(/[^。！？!?]{1,8}[。！？!?]/gu))
    .map((match) => match[0])
    .filter((sentence) => visibleLength(sentence) <= 8);
  if (matches.length < 6) {
    return;
  }
  addFinding({
    code: "prose_period_stutter",
    severity: "medium",
    line: segment.line,
    column: 1,
    message: "正文连续使用过短句号，节奏显得碎裂和机械。",
    excerpt: formatExcerpt(matches.slice(0, 6).join("")),
    fixSuggestion: "合并部分短句，并用动作链、视线转移或心理承接形成更自然的段落节奏。",
  });
}

function scanLongParagraph(
  segment: TextSegment,
  addFinding: (finding: ProseQualityFinding) => void,
): void {
  if (visibleLength(segment.text) <= 220) {
    return;
  }
  addFinding({
    code: "prose_long_paragraph",
    severity: "medium",
    line: segment.line,
    column: 1,
    message: "正文段落过长，阅读节奏和移动端可读性下降。",
    excerpt: formatExcerpt(segment.text),
    fixSuggestion: "按动作转折、信息揭示或情绪变化拆成更短段落。",
  });
}

function scanVerbatimRepeat(
  segments: TextSegment[],
  addFinding: (finding: ProseQualityFinding) => void,
): void {
  for (let index = 1; index < segments.length; index += 1) {
    const previous = normalizeRepeatText(segments[index - 1].text);
    const current = normalizeRepeatText(segments[index].text);
    if (previous.length >= 8 && previous === current) {
      addFinding({
        code: "prose_verbatim_repeat",
        severity: "critical",
        line: segments[index].line,
        column: 1,
        message: "正文出现相邻段落复读。",
        excerpt: formatExcerpt(segments[index].text),
        fixSuggestion: "删除重复段落，保留信息推进更明确的一版。",
      });
    }
  }

  const sentenceMap = new Map<string, { sentence: string; line: number; count: number }>();
  for (const segment of segments) {
    for (const sentence of splitSentences(stripQuotedText(segment.text))) {
      const normalized = normalizeRepeatText(sentence);
      if (normalized.length < 12) {
        continue;
      }
      const item = sentenceMap.get(normalized) ?? {
        sentence,
        line: segment.line,
        count: 0,
      };
      item.count += 1;
      sentenceMap.set(normalized, item);
    }
  }
  for (const item of sentenceMap.values()) {
    if (item.count >= 3) {
      addFinding({
        code: "prose_verbatim_repeat",
        severity: "critical",
        line: item.line,
        column: 1,
        message: "正文多次重复同一句或高度相同的句子。",
        excerpt: formatExcerpt(item.sentence),
        fixSuggestion: "保留一次有效表达，其余位置改成新的动作、反应或信息推进。",
      });
    }
  }
}

function scanTruncation(
  content: string,
  segments: TextSegment[],
  addFinding: (finding: ProseQualityFinding) => void,
): void {
  const trimmed = content.trim();
  if (visibleLength(trimmed) < 80 || TERMINAL_PUNCTUATION.test(trimmed)) {
    return;
  }
  const lastSegment = segments[segments.length - 1];
  addFinding({
    code: "prose_truncation",
    severity: "critical",
    line: lastSegment?.line ?? 1,
    column: Math.max(1, (lastSegment?.text.length ?? trimmed.length) - 20),
    message: "正文结尾缺少完整句读，疑似生成中断或被截断。",
    excerpt: formatExcerpt(lastSegment?.text ?? trimmed),
    fixSuggestion: "补齐结尾句、动作结果和章节收束，确认正文不是半句停在输出末尾。",
  });
}

function splitSentences(text: string): string[] {
  return Array.from(text.matchAll(/[^。！？!?]+[。！？!?]/gu)).map((match) => match[0]);
}

function normalizeRepeatText(text: string): string {
  return text
    .replace(/[「」『』“”‘’"'（）()[\]【】《》<>]/gu, "")
    .replace(/\s+/gu, "")
    .trim();
}

function stripQuotedText(text: string): string {
  return text
    .replace(/「[^」]*」/gu, "")
    .replace(/『[^』]*』/gu, "")
    .replace(/“[^”]*”/gu, "")
    .replace(/"[^"]*"/gu, "");
}

function isInsideQuote(text: string, index: number): boolean {
  const pairs: Array<[string, string]> = [
    ["「", "」"],
    ["『", "』"],
    ["“", "”"],
    ["\"", "\""],
    ["'", "'"],
  ];
  return pairs.some(([open, close]) => {
    const before = text.slice(0, index);
    const openIndex = before.lastIndexOf(open);
    if (openIndex < 0) {
      return false;
    }
    const closeIndex = text.indexOf(close, openIndex + open.length);
    return closeIndex >= index;
  });
}

function lineLooksLikeDialogue(text: string): boolean {
  const trimmed = text.trim();
  return /^["“「『]/u.test(trimmed) || /[」』”"]$/u.test(trimmed);
}

function visibleLength(text: string): number {
  return text.replace(/\s+/gu, "").length;
}

function formatExcerpt(text: string): string {
  const normalized = text.replace(/\s+/gu, " ").trim();
  return normalized.length > 120 ? `${normalized.slice(0, 117)}...` : normalized;
}

function scoreFindings(findings: ProseQualityFinding[]): number {
  const penalty = findings.reduce((total, finding) => {
    switch (finding.severity) {
      case "critical":
        return total + 18;
      case "high":
        return total + 12;
      case "medium":
        return total + 6;
      case "low":
        return total + 3;
      default:
        return total;
    }
  }, 0);
  return Math.max(30, 100 - penalty);
}
