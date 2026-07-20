const test = require("node:test");
const assert = require("node:assert/strict");

const {
  SOP_BANNED_TERMS,
  countBannedTermsFromStyleTone,
  extractBannedTermsFromStyleTone,
  extractBannedTermsFromStyleToneSafe,
} = require("@ai-novel/shared/types/styleToneBannedTerms");

// SOP 常驻集（vault §2 锁定的机械度量隐喻族）。守卫不靠 prompt 自觉声明。
const SOP_SET = [...SOP_BANNED_TERMS];

test("extractBannedTermsFromStyleTone always unions SOP set (even on empty input)", () => {
  const fromEmpty = extractBannedTermsFromStyleTone("");
  const fromNull = extractBannedTermsFromStyleTone(null);
  for (const term of SOP_SET) {
    assert.ok(fromEmpty.includes(term), `空 styleTone 仍含 SOP 词 ${term}`);
    assert.ok(fromNull.includes(term), `null styleTone 仍含 SOP 词 ${term}`);
  }
});

test("extractBannedTermsFromStyleTone extracts 禁『X/Y』族 declared terms", () => {
  // 《原世界》styleTone 实际形态（vault 取证）：禁『称重/过秤』族机械度量隐喻概括压迫
  const terms = extractBannedTermsFromStyleTone(
    "龙族气质：人味、被推、日常锚；禁『称重/过秤』族机械度量隐喻概括压迫。",
  );
  assert.ok(terms.includes("称重"), "应抽到 称重（族称分词后）");
  assert.ok(terms.includes("过秤"), "应抽到 过秤（族称分词后）");
  // SOP 常驻仍并集
  assert.ok(terms.includes("放上秤"));
  assert.ok(terms.includes("称人斤两"));
  assert.ok(terms.includes("货架标签"));
  // 称重/过秤 不重复
  assert.equal(terms.filter((t) => t === "称重").length, 1);
});

test("extractBannedTermsFromStyleTone handles 禁「X」/禁\"X\" forms and 分词", () => {
  // 禁「X」与禁"X" 双形态,且禁「系统面板/龙傲天」族称按斜杠分词
  const terms = extractBannedTermsFromStyleTone("禁「系统面板/龙傲天」且禁\"机械开局\"");
  assert.ok(terms.includes("系统面板"));
  assert.ok(terms.includes("龙傲天"));
  assert.ok(terms.includes("机械开局"));
});

test("extractBannedTermsFromStyleTone does not extract allowed-tone words", () => {
  // 「可用性评估」「协衡署」「源痕」「异兽」「半棋子」是允许口径，不是禁词。
  // styleTone 里若仅在描述允许口径（非「禁 X」标记），不应被抽进 bannedTerms。
  const terms = extractBannedTermsFromStyleTone(
    "允许口径：可用性评估、协衡署、源痕、异兽、协/衡、半棋子。",
  );
  assert.equal(terms.includes("可用性评估"), false, "可用性评估 是允许口径, 不进禁词表");
  assert.equal(terms.includes("协衡署"), false);
  assert.equal(terms.includes("源痕"), false);
  // SOP 常驻不影响（不含这些允许词的子串）
  for (const term of SOP_SET) {
    assert.equal(terms.includes("可用性评估"), false);
  }
});

test("extractBannedTermsFromStyleTone does not false-positive on reverse-reference phrasing", () => {
  // 「可用『称重』的反面」式合法表述：抽到「称重」是真禁词, SOP 常驻已含;
  // 但本测关键在 SOP 子串扫正文时,「可用性评估」不分btc 卡到 称重。
  // 这里只验证抽取层不会把整段非禁词标记文本当子串扫。
  const terms = extractBannedTermsFromStyleTone("一些和禁词无关的日常描述,没有禁字标记。");
  // 没显式禁词声明 → 仅 SOP 常驻集
  assert.equal(terms.length, SOP_SET.length);
  assert.deepEqual([...terms].sort(), [...SOP_SET].sort());
});

test("extractBannedTermsFromStyleToneSafe reads from prisma-like novel row", () => {
  const safeHit = extractBannedTermsFromStyleToneSafe({ styleTone: "禁『称重』族" });
  assert.ok(safeHit.includes("称重"));
  const safeNull = extractBannedTermsFromStyleToneSafe(null);
  for (const term of SOP_SET) {
    assert.ok(safeNull.includes(term));
  }
  const safeUndefined = extractBannedTermsFromStyleToneSafe(undefined);
  for (const term of SOP_SET) {
    assert.ok(safeUndefined.includes(term));
  }
  // novel 存在但 styleTone 字段为 null/undefined → SOP 常驻
  const safeEmptyNovel = extractBannedTermsFromStyleToneSafe({ styleTone: null });
  assert.equal(safeEmptyNovel.length, SOP_SET.length);
});

test("countBannedTermsFromStyleTone reports SOP floor even on empty styleTone", () => {
  // 空 styleTone + SOP 常驻 = SOP 表长度（非 0），用于 readiness / 限流 warn
  assert.equal(countBannedTermsFromStyleTone(null), SOP_SET.length);
  assert.equal(countBannedTermsFromStyleTone({}), SOP_SET.length);
  assert.ok(countBannedTermsFromStyleTone({ styleTone: "禁『称重』" }) >= SOP_SET.length);
});

test("SOP_BANNED_TERMS excludes dual-use allowed-tone stems to avoid false positives", () => {
  // 守卫常驻 SOP 表严格避开 vault 允许口径泛词:不含 评估/可用/协衡/源痕/异兽/半棋子
  const sopString = SOP_SET.join(",");
  assert.equal(sopString.includes("评估"), false);
  assert.equal(sopString.includes("可用"), false);
  assert.equal(sopString.includes("协衡"), false);
  assert.equal(sopString.includes("源痕"), false);
  assert.equal(sopString.includes("异兽"), false);
  // 称人斤两 / 放上秤 / 货架标签 是长复合, 字面命中率低不误伤
  assert.ok(SOP_SET.includes("称人斤两"));
  assert.ok(SOP_SET.includes("放上秤"));
  assert.ok(SOP_SET.includes("货架标签"));
});
