const test = require("node:test");
const assert = require("node:assert/strict");

const {
  isMustOnPageCharacter,
  isIntentionalOffscreenCharacter,
  selectMustOnPageAppearanceLabels,
  selectOffscreenDeferLabels,
  isSoftOffscreenCharacterAppearanceMissing,
  isHardCharacterAppearanceMissing,
  extractCharacterNameFromAppearanceLabel,
  collectRequiredAppearanceNames,
  MUST_ON_PAGE_ABSENCE_SPAN_THRESHOLD,
} = require("../dist/prompting/prompts/novel/characterAppearanceObligation.js");

test("planned chapter order is must_on_page", () => {
  const guide = {
    name: "林逸",
    plannedChapterOrders: [12],
    shouldPreferAppearance: false,
    isCoreInVolume: false,
    absenceRisk: "info",
    absenceSpan: 0,
  };
  assert.equal(isMustOnPageCharacter(guide, 12), true);
  assert.equal(isIntentionalOffscreenCharacter(guide, 12), false);
  assert.equal(isMustOnPageCharacter(guide, 13), false);
});

test("core high-risk long absence is must_on_page; warn prefer is offscreen", () => {
  const longAbsence = {
    name: "焰尾",
    plannedChapterOrders: [],
    shouldPreferAppearance: true,
    isCoreInVolume: true,
    absenceRisk: "high",
    absenceSpan: MUST_ON_PAGE_ABSENCE_SPAN_THRESHOLD,
  };
  const warnPrefer = {
    name: "配角甲",
    plannedChapterOrders: [20],
    shouldPreferAppearance: true,
    isCoreInVolume: true,
    absenceRisk: "warn",
    absenceSpan: 1,
  };
  assert.equal(isMustOnPageCharacter(longAbsence, 15), true);
  assert.equal(isMustOnPageCharacter(warnPrefer, 15), false);
  assert.equal(isIntentionalOffscreenCharacter(warnPrefer, 15), true);
});

test("select labels split must_on_page vs defer", () => {
  const guides = [
    {
      name: "林逸",
      plannedChapterOrders: [5],
      shouldPreferAppearance: true,
      isCoreInVolume: true,
      absenceRisk: "high",
      absenceSpan: 0,
    },
    {
      name: "春桃",
      plannedChapterOrders: [9],
      shouldPreferAppearance: true,
      isCoreInVolume: false,
      absenceRisk: "warn",
      absenceSpan: 1,
    },
  ];
  const must = selectMustOnPageAppearanceLabels(guides, 5);
  const defer = selectOffscreenDeferLabels(guides, 5);
  assert.ok(must.some((item) => item.includes("林逸")));
  assert.ok(defer.some((item) => item.includes("春桃") && item.includes("可延后")));
});

test("soft offscreen missing detector", () => {
  assert.equal(isSoftOffscreenCharacterAppearanceMissing({
    kind: "character_appearance",
    summary: "春桃未出场（可延后出场/offscreen）",
    evidence: "他章计划",
  }), true);
  assert.equal(isSoftOffscreenCharacterAppearanceMissing({
    kind: "character_appearance",
    summary: "林逸（must_on_page；已缺席 3 章）未出场",
    evidence: "正文无林逸",
  }), false);
});

test("hard appearance missing uses required contract names without marker text", () => {
  assert.equal(extractCharacterNameFromAppearanceLabel("林逸（must_on_page；本章计划出场）"), "林逸");
  assert.deepEqual(
    collectRequiredAppearanceNames(["林逸（must_on_page）", "焰尾（must_on_page；已缺席 3 章）"]),
    ["林逸", "焰尾"],
  );
  assert.equal(isHardCharacterAppearanceMissing({
    kind: "character_appearance",
    summary: "林逸未出场。",
    evidence: "正文无林逸",
    requiredCharacterAppearances: ["林逸（must_on_page；已缺席 3 章，须本场可见）"],
  }), true);
  assert.equal(isHardCharacterAppearanceMissing({
    kind: "character_appearance",
    summary: "春桃未出场（可延后出场/offscreen）",
    evidence: "他章计划",
    requiredCharacterAppearances: ["林逸（must_on_page）"],
  }), false);
  assert.equal(isHardCharacterAppearanceMissing({
    kind: "character_appearance",
    summary: "路人甲未出场。",
    requiredCharacterAppearances: [],
  }), false);
});
