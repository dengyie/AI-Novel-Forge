const test = require("node:test");
const assert = require("node:assert/strict");

const {
  assessChineseProse,
  isEnglishHeavyProse,
} = require("../dist/utils/chineseProseGate.js");

test("assessChineseProse accepts normal Chinese chapter prose", () => {
  const text = "林舟推开门，夜风带着潮气扑面而来。他握紧信纸，低声说：“今晚必须过去。”".repeat(40);
  const result = assessChineseProse(text);
  assert.equal(result.ok, true);
  assert.ok(result.cjkCount > 200);
});

test("assessChineseProse rejects English meta markers", () => {
  const text = "We need to write the next scene carefully. Must produce more tension.";
  const result = assessChineseProse(text);
  assert.equal(result.ok, false);
  assert.equal(result.reason, "english_meta_marker");
  assert.ok(result.metaMarker);
});

test("assessChineseProse rejects english-heavy drafts", () => {
  const text = "However the protagonist walked across the street and thought about the plan again. ".repeat(8);
  const result = assessChineseProse(text);
  assert.equal(result.ok, false);
  assert.ok(["english_meta_marker", "english_heavy"].includes(result.reason));
  assert.equal(isEnglishHeavyProse(text), true);
});

test("assessChineseProse rejects long drafts with insufficient CJK", () => {
  const text = "abcdefghijklmnopqrstuvwxyz ".repeat(50);
  const result = assessChineseProse(text);
  assert.equal(result.ok, false);
  assert.ok(["english_heavy", "insufficient_cjk"].includes(result.reason));
});

test("assessChineseProse rejects empty text", () => {
  const result = assessChineseProse("   ");
  assert.equal(result.ok, false);
  assert.equal(result.reason, "empty");
});
