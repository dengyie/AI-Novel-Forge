/**
 * 阶段3：matchLibraryAssetsTopN / collectLibraryAssetCandidates 对靠链路打分测试。
 * 覆盖：topN 截断、speaker 去重保留最高分、占用标注(includeOccupiedSpeakers)、
 * gender/cluster/narrator/scope 门禁与单选 matchLibraryAsset 一致。
 */
const test = require("node:test");
const assert = require("node:assert/strict");

const {
  matchLibraryAsset,
  matchLibraryAssetsTopN,
  collectLibraryAssetCandidates,
  speakerKeyFromTags,
} = require("../dist/services/audiobook/audiobookVoicePlanner.js");

function asset(id, tags, extra = {}) {
  return {
    id,
    slug: `slug-${id}`,
    displayName: id,
    status: "approved",
    kind: "clone_ref",
    tags,
    ...extra,
  };
}

const MALE_LEAD = asset("va_male_lead", ["male", "lead", "scope-zh"]);
const FEMALE_LEAD = asset("va_female_lead", ["female", "lead", "scope-zh"]);
const MALE_CAST = asset("va_male_cast", ["male", "cast", "scope-zh"]);
const NARRATOR = asset("va_narrator", ["narrator", "scope-zh"]);
const EN_LEAD = asset("va_en_lead", ["male", "lead", "scope-en"]);
const DRAFT_LEAD = asset("va_draft", ["male", "lead"], { status: "draft" });

test("matchLibraryAssetsTopN returns sorted top-N candidates under hard cap", () => {
  const assets = [FEMALE_LEAD, MALE_CAST, MALE_LEAD, NARRATOR, EN_LEAD];
  const ranked = matchLibraryAssetsTopN({
    genderBucket: "male",
    cluster: "lead",
    assets,
    topN: 2,
  });
  // lead 门禁：仅 male-lead 通过（male-cast soft for lead? lead↔cast软兼容：lead 取 cast 视为软命中也通过）
  // 但 lead exact (35) > soft cast_for_lead (22)，故 male_lead 排第一，male_cast 软命中第二
  assert.ok(ranked.length >= 1);
  assert.equal(ranked[0].asset.id, "va_male_lead");
  assert.ok(ranked.length <= 2);
  // 排序：分数降序
  for (let i = 1; i < ranked.length; i++) {
    assert.ok(ranked[i - 1].score >= ranked[i].score);
  }
});

test("top-N default 8 when topN omitted/illegal", () => {
  const assets = [];
  for (let i = 0; i < 12; i++) {
    assets.push(asset(`va${i}`, ["male", "lead", "scope-zh"]));
  }
  // 同 speaker 去重：无 speaker: 标签 → 退回 asset:id 作 speakerKey，每个唯一
  const ranked = matchLibraryAssetsTopN({
    genderBucket: "male",
    cluster: "lead",
    assets,
  });
  assert.equal(ranked.length, 8);
  const illegal = matchLibraryAssetsTopN({
    genderBucket: "male",
    cluster: "lead",
    assets,
    topN: -3,
  });
  assert.equal(illegal.length, 8);
  const capped = matchLibraryAssetsTopN({
    genderBucket: "male",
    cluster: "lead",
    assets,
    topN: 99,
  });
  // topN=99 → 硬顶 32；库仅 12 通过 → slice(0,32) 返回 12
  assert.equal(capped.length, 12);
});

test("same speaker multi-clip only highest score kept in candidates (dedupe)", () => {
  const speaker = "speaker:sp-ffmpeg";
  const aHigh = asset("va_hi", ["male", "lead", "scope-zh", speaker]);
  const aLow = asset("va_lo", ["male", "lead", "scope-zh", "cast_for_lead_fallback", speaker]);
  // 两条同 speaker；aHigh exact lead (35) 高于 aLow
  // 但 aLow 也带 lead，exact 35，同分 → slug 排序 slug-va_hi < slug-va_lo → hi 第一
  const ranked = matchLibraryAssetsTopN({
    genderBucket: "male",
    cluster: "lead",
    assets: [aLow, aHigh],
    topN: 5,
  });
  // 同 speaker 去重保留最高分一条
  assert.equal(ranked.length, 1);
  assert.equal(ranked[0].asset.id, "va_hi");
});

test("includeOccupiedSpeakers: occupied speaker not hidden in top-N, speakerOccupied flagged", () => {
  const speaker = "speaker:sp-busy";
  const a = asset("va_busy", ["male", "lead", "scope-zh", speaker]);
  const b = asset("va_free", ["male", "lead", "scope-zh", "speaker:sp-free"]);
  const ranked = matchLibraryAssetsTopN({
    genderBucket: "male",
    cluster: "lead",
    assets: [b, a],
    usedSpeakerKeys: new Set(["speaker:sp-busy"]),
    topN: 5,
  });
  // 默认 collect(includeOccupiedSpeakers=false) 会排除 busy；但 matchLibraryAssetsTopN 内部传 true
  // 故 busy 仍出现且 speakerOccupied=true
  const busy = ranked.find((c) => c.asset.id === "va_busy");
  assert.ok(busy, "occupied speaker candidate must appear in top-N (not silently hidden)");
  assert.equal(busy.speakerOccupied, true);
  const free = ranked.find((c) => c.asset.id === "va_free");
  assert.ok(free);
  assert.equal(free.speakerOccupied, false);
});

test("matchLibraryAsset single-select still excludes occupied speaker (batch plan semantics)", () => {
  const speaker = "speaker:sp-x";
  const a = asset("va_x", ["male", "lead", "scope-zh", speaker]);
  const b = asset("va_other", ["male", "lead", "scope-zh", "speaker:sp-other"]);
  // 单选：usedSpeakerKeys 含 sp-x → a 被排除，应选 b
  const hit = matchLibraryAsset({
    genderBucket: "male",
    cluster: "lead",
    assets: [a, b],
    usedAssetIds: new Set(),
    usedSpeakerKeys: new Set([speaker]),
  });
  assert.ok(hit);
  assert.equal(hit.asset.id, "va_other");

  // 未传 usedSpeakerKeys → a 可选
  const hitA = matchLibraryAsset({
    genderBucket: "male",
    cluster: "lead",
    assets: [a, b],
    usedAssetIds: new Set(),
  });
  // 同分用 slug 稳定排序：slug-va_other < slug-va_x → single 取 va_other
  assert.ok(hitA);
  assert.equal(hitA.asset.id, "va_other");
});

test("gating parity: top-N first candidate equals matchLibraryAsset single result", () => {
  const assets = [FEMALE_LEAD, MALE_CAST, MALE_LEAD];
  const single = matchLibraryAsset({
    genderBucket: "male",
    cluster: "lead",
    assets,
    usedAssetIds: new Set(),
  });
  const topRanked = matchLibraryAssetsTopN({
    genderBucket: "male",
    cluster: "lead",
    assets,
    topN: 5,
  });
  assert.ok(single);
  assert.ok(topRanked.length >= 1);
  assert.equal(topRanked[0].asset.id, single.asset.id);
  assert.equal(topRanked[0].score, single.score);
});

test("narrator cluster rejects gender-only / non-narrator candidates", () => {
  const ranked = matchLibraryAssetsTopN({
    genderBucket: "male",
    cluster: "narrator",
    assets: [MALE_LEAD, NARRATOR, MALE_CAST],
    topN: 5,
  });
  assert.equal(ranked.length, 1);
  assert.equal(ranked[0].asset.id, "va_narrator");
  assert.equal(ranked[0].cluster, "exact");
});

test("scope-en candidate excluded under default scope-zh preferredScopes", () => {
  const ranked = matchLibraryAssetsTopN({
    genderBucket: "male",
    cluster: "lead",
    assets: [MALE_LEAD, EN_LEAD],
    topN: 5,
  });
  assert.equal(ranked.length, 1);
  assert.equal(ranked[0].asset.id, "va_male_lead");
  assert.equal(ranked[0].scope, "hit");
});

test("draft status never enters candidates", () => {
  const ranked = matchLibraryAssetsTopN({
    genderBucket: "male",
    cluster: "lead",
    assets: [MALE_LEAD, DRAFT_LEAD],
    topN: 5,
  });
  assert.equal(ranked.length, 1);
  assert.equal(ranked[0].asset.id, "va_male_lead");
});

test("collectLibraryAssetCandidates includeOccupiedSpeakers false excludes occupied speaker; true keeps", () => {
  const speaker = "speaker:sp-y";
  const a = asset("va_y", ["male", "lead", "scope-zh", speaker]);
  const off = collectLibraryAssetCandidates({
    genderBucket: "male",
    cluster: "lead",
    assets: [a],
    usedSpeakerKeys: new Set([speaker]),
    includeOccupiedSpeakers: false,
  });
  assert.equal(off.length, 0);

  const on = collectLibraryAssetCandidates({
    genderBucket: "male",
    cluster: "lead",
    assets: [a],
    usedSpeakerKeys: new Set([speaker]),
    includeOccupiedSpeakers: true,
  });
  assert.equal(on.length, 1);
  assert.equal(on[0].speakerOccupied, true);
});

test("speakerKeyFromTags stable for None", () => {
  assert.equal(speakerKeyFromTags([], null), "");
  assert.equal(speakerKeyFromTags(["male"], null), "");
  assert.equal(speakerKeyFromTags(undefined, ""), "");
  // 有 id 无 speaker 标签 → asset:id
  assert.equal(speakerKeyFromTags(["male"], "va123"), "asset:va123");
});
