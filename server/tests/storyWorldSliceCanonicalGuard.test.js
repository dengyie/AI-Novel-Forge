const test = require("node:test");
const assert = require("node:assert/strict");
const {
  applyCanonicalStoryWorldSliceGuard,
  buildStructureOnlyStoryWorldSliceFallback,
  HIGH_CONFIDENCE_INVENTED_TERMS,
  stripInventedTermsFromText,
  buildAllowedProperNames,
} = require("../dist/services/novel/storyWorldSlice/storyWorldSliceCanonicalGuard.js");
const {
  normalizeStoryWorldSlice,
  STORY_WORLD_SLICE_SCHEMA_VERSION,
  parseStoryWorldSlice,
} = require("../dist/services/novel/storyWorldSlice/storyWorldSlicePersistence.js");
const {
  resolveSettingQualityPolicy,
  DEFAULT_SETTING_QUALITY_POLICY,
  resolveStoryWorldSliceLockModeFromPolicy,
} = require("@ai-novel/shared/types/settingQualityPolicy");
const {
  resolveStoryWorldSliceLockMode,
} = require("@ai-novel/shared/types/storyWorldSlice");

function buildStructuredWorld() {
  return {
    profile: {
      summary: "现实都市下的商业和人际压力。",
      identity: "现实都市",
      tone: "克制压抑",
      themes: ["租房", "阶层压力"],
      coreConflict: "人在现实压力下如何守住关系与尊严",
    },
    rules: {
      summary: "世界遵循现实商业和社会规则。",
      axioms: [{
        id: "rule-reality",
        name: "现实规则优先",
        summary: "一切机会和冲突都必须能落回现实社会机制。",
        cost: "任何突破都要付出现实代价。",
        boundary: "不能靠超自然力量解决问题。",
        enforcement: "社会评价和资源分配会持续回收代价。",
      }],
      taboo: ["不要脱离现实基础"],
      sharedConsequences: ["错误决策会反噬角色关系"],
    },
    factions: [{
      id: "faction-market",
      name: "市场逐利派",
      position: "利益优先",
      doctrine: "先活下来再谈体面",
      goals: ["争夺稀缺资源"],
      methods: ["压价", "结盟"],
      representativeForceIds: ["force-lesheng"],
    }],
    forces: [{
      id: "force-lesheng",
      name: "乐圣公司",
      type: "company",
      factionId: "faction-market",
      summary: "控制关键商业资源的强势公司。",
      baseOfPower: "资本和渠道",
      currentObjective: "巩固市场优势",
      pressure: "用资源卡位和利益交换迫使角色让步。",
      leader: "林总",
      narrativeRole: "外部高压来源",
    }],
    locations: [{
      id: "location-office",
      name: "核心办公区",
      terrain: "city_office",
      summary: "商业竞争最直接的主舞台。",
      narrativeFunction: "承接职场冲突和资源交换。",
      risk: "人情与利益捆绑，失误会被放大。",
      entryConstraint: "必须有业务或关系入口",
      exitCost: "离开会失去机会和信息",
      controllingForceIds: ["force-lesheng"],
    }],
    relations: {
      forceRelations: [],
      locationControls: [],
    },
    metadata: {
      schemaVersion: 1,
      seededFrom: null,
      lastBackfilledAt: null,
      lastGeneratedAt: null,
      lastSectionGenerated: null,
    },
  };
}

function buildBindingSupport() {
  return {
    compatibleConflicts: ["资源卡位冲突"],
    highPressureForces: ["乐圣公司高压"],
    recommendedEntryPoints: ["核心办公区入职"],
    forbiddenCombinations: ["超自然外挂开局"],
  };
}

function buildCleanSlice() {
  const structure = buildStructuredWorld();
  return normalizeStoryWorldSlice({
    raw: {
      coreWorldFrame: "现实都市中，乐圣公司与租房压力交织。",
      pressureSources: ["乐圣公司：用资源卡位迫使角色让步"],
      mysterySources: ["市场规则下的灰色地带"],
      conflictCandidates: ["资源卡位冲突"],
      activeElements: [{
        id: "el-1",
        label: "乐圣资源卡位",
        type: "pressure",
        summary: "用渠道优势压人",
      }],
    },
    storyId: "novel-1",
    worldId: "world-1",
    sourceWorldUpdatedAt: "2026-07-01T00:00:00.000Z",
    storyInputDigest: "digest-1",
    builtFromStructuredData: true,
    builderMode: "runtime",
    structure,
    bindingSupport: buildBindingSupport(),
    overrides: {},
  });
}

function buildDirtySlice() {
  const structure = buildStructuredWorld();
  return normalizeStoryWorldSlice({
    raw: {
      coreWorldFrame: "脱序者在城市游走，残渣流失改写规则。",
      pressureSources: [
        "脱序者压迫普通人",
        "乐圣公司：用资源卡位迫使角色让步",
      ],
      mysterySources: ["本源残响体的低语", "市场规则下的灰色地带"],
      conflictCandidates: ["失序渗漏扩散", "资源卡位冲突"],
      activeElements: [
        {
          id: "el-bad",
          label: "脱序者",
          type: "entity",
          summary: "残渣流失带来的怪物",
        },
        {
          id: "el-ok",
          label: "乐圣卡位",
          type: "pressure",
          summary: "渠道压力",
        },
      ],
      suggestedStoryAxes: ["名噬回声主线"],
      recommendedEntryPoints: ["可用性黑市券开局"],
    },
    storyId: "novel-1",
    worldId: "world-1",
    sourceWorldUpdatedAt: "2026-07-01T00:00:00.000Z",
    storyInputDigest: "digest-dirty",
    builtFromStructuredData: true,
    builderMode: "runtime",
    structure,
    bindingSupport: buildBindingSupport(),
    overrides: {},
  });
}

// --- Policy ---

test("settingQualityPolicy defaults to off with no canonical lock", () => {
  const policy = resolveSettingQualityPolicy(null);
  assert.equal(policy.mode, "off");
  assert.equal(policy.canonicalSliceLock, false);
  assert.equal(resolveStoryWorldSliceLockModeFromPolicy(policy), "theme_invent");
  assert.deepEqual(DEFAULT_SETTING_QUALITY_POLICY.mode, "off");
});

test("settingQualityPolicy enforce enables canonical lock by default", () => {
  const policy = resolveSettingQualityPolicy({ mode: "enforce" });
  assert.equal(policy.mode, "enforce");
  assert.equal(policy.canonicalSliceLock, true);
  assert.equal(resolveStoryWorldSliceLockModeFromPolicy(policy), "canonical");
});

test("settingQualityPolicy invalid payload falls back to off", () => {
  const policy = resolveSettingQualityPolicy({ mode: "nope" });
  assert.equal(policy.mode, "off");
});

test("resolveStoryWorldSliceLockMode treats missing as theme_invent", () => {
  assert.equal(resolveStoryWorldSliceLockMode(undefined), "theme_invent");
  assert.equal(resolveStoryWorldSliceLockMode(null), "theme_invent");
  assert.equal(resolveStoryWorldSliceLockMode("canonical"), "canonical");
});

// --- v1 compatibility ---

test("parseStoryWorldSlice accepts v1 metadata without lockMode", () => {
  const raw = JSON.stringify({
    storyId: "n1",
    worldId: "w1",
    coreWorldFrame: "frame",
    appliedRules: [],
    activeForces: [],
    activeLocations: [],
    activeElements: [],
    conflictCandidates: [],
    pressureSources: [],
    mysterySources: [],
    suggestedStoryAxes: [],
    recommendedEntryPoints: [],
    forbiddenCombinations: [],
    storyScopeBoundary: "",
    metadata: {
      schemaVersion: STORY_WORLD_SLICE_SCHEMA_VERSION,
      builtAt: "2026-01-01T00:00:00.000Z",
      sourceWorldUpdatedAt: "2026-01-01T00:00:00.000Z",
      storyInputDigest: "x",
      builtFromStructuredData: true,
      builderMode: "runtime",
    },
  });
  const parsed = parseStoryWorldSlice(raw);
  assert.ok(parsed);
  assert.equal(parsed.metadata.lockMode, undefined);
  assert.equal(parsed.metadata.schemaVersion, 1);
});

// --- Gold samples: invented terms strip ---

test("gold: high-confidence invented terms are listed", () => {
  assert.ok(HIGH_CONFIDENCE_INVENTED_TERMS.includes("脱序者"));
  assert.ok(HIGH_CONFIDENCE_INVENTED_TERMS.includes("残渣流失"));
});

test("gold: strip invented terms from free text", () => {
  const allowed = new Set(["乐圣公司"]);
  const { text, violations } = stripInventedTermsFromText(
    "脱序者逼近乐圣公司门口，残渣流失加速",
    allowed,
  );
  assert.equal(text.includes("脱序者"), false);
  assert.equal(text.includes("残渣流失"), false);
  assert.match(text, /乐圣公司/);
  assert.ok(violations.some((v) => v.includes("脱序者")));
});

test("gold: legal pressure sentence is not stripped", () => {
  const structure = buildStructuredWorld();
  const allowed = buildAllowedProperNames(structure, ["澄湾", "岚桥"]);
  const legal = "乐圣公司用资源卡位和利益交换迫使角色让步，核心办公区人情与利益捆绑。";
  const { text, violations } = stripInventedTermsFromText(legal, allowed);
  assert.equal(violations.length, 0);
  assert.equal(text, legal);
});

test("canonical guard strips invented lore and keeps registered force pressure", () => {
  const structure = buildStructuredWorld();
  const dirty = buildDirtySlice();
  const result = applyCanonicalStoryWorldSliceGuard({
    slice: dirty,
    structure,
    lockMode: "canonical",
  });
  assert.equal(result.stripped, true);
  assert.equal(result.ok, false);
  assert.ok(result.violations.length > 0);
  assert.equal(result.slice.coreWorldFrame.includes("脱序者"), false);
  assert.equal(result.slice.coreWorldFrame.includes("残渣流失"), false);
  assert.ok(
    result.slice.pressureSources.some((p) => p.includes("乐圣")),
    "registered force pressure retained",
  );
  assert.equal(
    result.slice.activeElements.some((el) => el.label.includes("脱序")),
    false,
  );
  assert.equal(result.slice.metadata.lockMode, "canonical");
  assert.ok((result.slice.metadata.inventViolations ?? []).length > 0);
});

test("theme_invent guard does not strip invented terms", () => {
  const structure = buildStructuredWorld();
  const dirty = buildDirtySlice();
  const result = applyCanonicalStoryWorldSliceGuard({
    slice: dirty,
    structure,
    lockMode: "theme_invent",
  });
  assert.equal(result.stripped, false);
  assert.equal(result.ok, true);
  assert.equal(result.violations.length, 0);
  assert.match(result.slice.coreWorldFrame, /脱序者/);
  assert.equal(result.slice.metadata.lockMode, "theme_invent");
});

test("canonical guard never throws and always returns usable slice", () => {
  const structure = buildStructuredWorld();
  const clean = buildCleanSlice();
  const result = applyCanonicalStoryWorldSliceGuard({
    slice: clean,
    structure,
    lockMode: "canonical",
  });
  assert.equal(typeof result.slice.storyId, "string");
  assert.equal(result.slice.metadata.schemaVersion, STORY_WORLD_SLICE_SCHEMA_VERSION);
  assert.ok(Array.isArray(result.slice.pressureSources));
});

test("structure-only fallback clears free invention lists", () => {
  const structure = buildStructuredWorld();
  const dirty = buildDirtySlice();
  const guarded = applyCanonicalStoryWorldSliceGuard({
    slice: dirty,
    structure,
    lockMode: "canonical",
  });
  const fallback = buildStructureOnlyStoryWorldSliceFallback(guarded.slice, structure);
  assert.equal(fallback.metadata.lockMode, "canonical");
  assert.ok((fallback.metadata.inventViolations ?? []).some((v) => v.includes("fallback")));
  assert.equal(fallback.mysterySources.length, 0);
  assert.ok(fallback.activeElements.every((el) => !el.label.includes("脱序")));
  // still consumable
  assert.ok(fallback.coreWorldFrame.length > 0);
});

test("mode=off path: normalize without lockMode matches pre-feature shape keys", () => {
  const structure = buildStructuredWorld();
  const slice = normalizeStoryWorldSlice({
    raw: {
      coreWorldFrame: "现实都市压力",
      pressureSources: ["乐圣高压"],
    },
    storyId: "novel-off",
    worldId: "world-1",
    sourceWorldUpdatedAt: "2026-07-01T00:00:00.000Z",
    storyInputDigest: "d-off",
    builtFromStructuredData: true,
    builderMode: "runtime",
    structure,
    bindingSupport: buildBindingSupport(),
    overrides: { requiredForceIds: ["force-lesheng"] },
  });
  assert.equal(slice.metadata.lockMode, undefined);
  assert.equal(slice.metadata.inventViolations, undefined);
  assert.equal(slice.metadata.schemaVersion, 1);
  assert.ok(slice.activeForces.some((f) => f.id === "force-lesheng"));
});
