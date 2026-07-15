const test = require("node:test");
const assert = require("node:assert/strict");

const {
  extractSotBannedTermsFromJsonBlob,
  extractSotBannedTermsFromNovel,
  SOT_BANNED_TERMS_JSON_KEY,
} = require("@ai-novel/shared/types/sotBannedTerms");

test("extractSotBannedTermsFromJsonBlob reads sotBannedTerms array", () => {
  const terms = extractSotBannedTermsFromJsonBlob(JSON.stringify({
    [SOT_BANNED_TERMS_JSON_KEY]: ["称重", "可用性评估"],
  }));
  assert.deepEqual(terms, ["称重", "可用性评估"]);
});

test("extractSotBannedTermsFromNovel unions overrides and slice", () => {
  const terms = extractSotBannedTermsFromNovel({
    storyWorldSliceOverridesJson: JSON.stringify({ sotBannedTerms: ["称重"] }),
    storyWorldSliceJson: JSON.stringify({ sotBannedTerms: ["裂空斩", "称重"] }),
  });
  assert.ok(terms.includes("称重"));
  assert.ok(terms.includes("裂空斩"));
  assert.equal(terms.filter((t) => t === "称重").length, 1);
});

test("extractSotBannedTermsFromNovel empty on missing", () => {
  assert.deepEqual(extractSotBannedTermsFromNovel(null), []);
  assert.deepEqual(extractSotBannedTermsFromNovel({}), []);
});
