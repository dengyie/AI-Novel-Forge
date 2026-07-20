/**
 * 书级禁词（C 方案，源世界系）：从 `Novel.styleTone` 自然语言字段抽取禁词清单，
 * 与「固定 SOP 禁词表（vault §2 锁定族）」取并集。
 *
 * 与 sotBannedTerms.ts 的关系：
 *  - sotBannedTerms 走 storyWorldSlice(Overrides)Json.sotBannedTerms 这条**结构化**通道
 *    （用户在故事世界元数据里显式填的禁词数组，已经是干净的 string[]）。
 *  - 本文件走 Novel.styleTone 这条**自然语言**通道（如「禁『称重/过秤』族机械度量隐喻」），
 *    需要从「禁 X」标记里抽取禁词短语。
 *
 * 抽取口径（推荐 B 变体）：
 *  1. 正则从 styleTone 里抽「禁『X』 / 禁"X" / 禁「X」 / 禁止X / 禁 X」标记下的 X；
 *     对「禁『称重/过秤』」这种族称再按 /[/／、，;；]+/ 分词。
 *  2. 与固定 SOP_BANNED_TERMS 常量取并集（守卫不靠 prompt 自觉，常驻兜底）。
 *  3. **不**把整段 styleTone 当子串扫，避免误伤「可用『称重』的反面」式合法表述。
 *
 * 不新增 DB 列；空 styleTone = 仅 SOP 常驻集（守卫仍工作）。
 *
 * 误伤边界：SOP 表严格避开 vault 允许口径词（可用性评估/协衡署/源痕/异兽/协/衡/半棋子）——
 * 它们不含 SOP 任何子串，scanTermListLeak 归一后 indexOf 不会命中。
 */

/**
 * 固定 SOP 禁词表（vault §2 锁定的机械度量隐喻族）。
 *
 * 只放「高确信、单义、不会在正常叙述里合法出现」的短词。「称重/过秤」二字进表是因为
 * vault 把「称重/过秤」族机械度量隐喻概括压迫写法定为禁的——允许口径「可用性评估」
 * 不含「称重」二字，故不会误伤。若监管 poll 发现「称重」二字误伤面大，可收窄为 SOP
 * 子集仅含零误伤长复合（称人斤两/放上秤/货架标签），把 称重/过秤 降为「仅 styleTone
 * 显式声明时入表」——抽常量便于一行改（见 backlog）。
 *
 * 【】HUD 不进表——已由 prose_system_hud 规则（ProseQualityDetector.ts:90/95/159/449）
 * 扫，重复会叠 finding。系统面板/血统天选/龙傲天开局是开局禁，进规划层对手面守卫
 * （detectOpponentLineViolation），不进正文 SOP 表（正文里出现「龙傲天」可能是
 * 角色吐槽用语，字面扫会误伤）。
 */
export const SOP_BANNED_TERMS = [
  "称重",
  "过秤",
  "放上秤",
  "称人斤两",
  "货架标签",
] as const;

function uniqueTerms(values: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of values) {
    const term = String(raw ?? "").trim();
    if (term.length < 2 || seen.has(term)) {
      continue;
    }
    seen.add(term);
    out.push(term);
  }
  return out;
}

/**
 * 从「禁 X」标记里分词。对「称重/过秤」「系统面板、龙傲天」这类被一次性声明的族，
 * 按斜杠/顿号/逗号/分号拆成独立词条。
 */
function tokenizeDeclaredTerms(raw: string): string[] {
  return raw
    .split(/[/／、，;；,]+/g)
    .map((piece) => piece.trim())
    .filter((piece) => piece.length >= 2);
}

/**
 * 从 styleTone 自然语言字段抽取「显式禁用声明」标记下的禁词。
 *
 * 覆盖四种标点形态：
 *  - 全角单引号：禁『X』（vault 《原世界》styleTone 实际用的形态：禁『称重/过秤』族）
 *  - 全角双引号：禁「X」
 *  - 半角引号：禁"X" / 禁'X'
 *  - 无引号直跟：禁止X / 禁 X（到标点/空白止，2–20 字符）
 */
function extractDeclaredBannedTerms(styleTone: string): string[] {
  const terms: string[] = [];
  // 仅匹配「禁」字开头的禁用声明，避免「可用性评估」式合法表述被误抽。
  const patterns: RegExp[] = [
    /禁『([^』]{1,30})』/g,
    /禁「([^」]{1,30})」/g,
    /禁"([^"]{1,30})"/g,
    /禁'([^']{1,30})'/g,
    /禁止(\S{2,20})/g,
    /禁\s(\S{2,20})/g,
  ];
  for (const pattern of patterns) {
    let match: RegExpExecArray | null;
    pattern.lastIndex = 0;
    while ((match = pattern.exec(styleTone)) !== null) {
      terms.push(...tokenizeDeclaredTerms(match[1]));
    }
  }
  return terms;
}

/**
 * 从 Novel.styleTone 抽取书级禁词清单 = SOP 常驻集 ∪ 显式声明抽取集。
 *
 * 空 styleTone → SOP 常驻集（守卫不靠 prompt 自觉）。
 */
export function extractBannedTermsFromStyleTone(
  styleTone: string | null | undefined,
): string[] {
  const sopTerms = SOP_BANNED_TERMS.map((term) => String(term));
  if (!styleTone?.trim()) {
    return uniqueTerms(sopTerms);
  }
  const declared = extractDeclaredBannedTerms(styleTone);
  return uniqueTerms([...sopTerms, ...declared]);
}

export type NovelStyleToneSource = {
  styleTone?: string | null;
};

/**
 * 对称 extractSotBannedTermsFromNovel：从 prisma novel row 直接喂入。
 * novel=null/undefined 或 styleTone 缺省 → SOP 常驻集。
 */
export function extractBannedTermsFromStyleToneSafe(
  novel: NovelStyleToneSource | null | undefined,
): string[] {
  if (!novel) {
    return extractBannedTermsFromStyleTone(null);
  }
  return extractBannedTermsFromStyleTone(novel.styleTone);
}

/**
 * 空表可观测：词条数量。空 styleTone + SOP 常驻 = SOP 表长度（非 0）。
 * 用于 readiness / 限流 warn。
 */
export function countBannedTermsFromStyleTone(
  novel: NovelStyleToneSource | null | undefined,
): number {
  return extractBannedTermsFromStyleToneSafe(novel).length;
}
