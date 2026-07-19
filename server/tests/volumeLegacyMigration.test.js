const test = require("node:test");
const assert = require("node:assert/strict");
const {
  buildFallbackVolumesFromLegacy,
  normalizeVolumeDraftInput,
  parseLegacyStructuredOutline,
} = require("../dist/services/novel/volume/volumePlanUtils.js");
const {
  mergeChapterDetail,
} = require("../dist/services/novel/volume/volumeGenerationHelpers.js");
const {
  containsInternalQualityCodes,
} = require("../../shared/dist/types/chapterTaskSheetQuality.js");

test("legacy structured outline migration upgrades old volume payloads into normalized v2 volumes and merges arc signals", () => {
  const structuredOutline = JSON.stringify({
    volumes: [{
      volumeTitle: "旧第一卷",
      summary: "旧卷摘要",
      chapters: [{
        order: 1,
        title: "旧第1章",
        summary: "旧章摘要",
        purpose: "建立压迫",
      }],
    }],
  });
  const volumes = buildFallbackVolumesFromLegacy("novel-1", {
    structuredOutline,
    arcPlans: [{
      externalRef: "1",
      title: "卷一起势",
      objective: "主角第一次完成反压",
      phaseLabel: "起势",
      hookTarget: "更强敌人即将入场",
      rawPlanJson: JSON.stringify({
        climax: "卷末反压成立",
        openPayoffs: ["伏笔A"],
      }),
    }],
  });

  assert.equal(volumes.length, 1);
  assert.equal(volumes[0].novelId, "novel-1");
  assert.equal(volumes[0].title, "旧第一卷");
  assert.equal(volumes[0].mainPromise, "主角第一次完成反压");
  assert.equal(volumes[0].escalationMode, "起势");
  assert.equal(volumes[0].climax, "卷末反压成立");
  assert.deepEqual(volumes[0].openPayoffs, ["伏笔A"]);
  assert.equal(volumes[0].chapters[0].chapterOrder, 1);
  assert.equal(volumes[0].chapters[0].purpose, "建立压迫");
});

test("legacy chapter-only projects fall back to synthesized volume skeletons instead of staying half-migrated", () => {
  const volumes = buildFallbackVolumesFromLegacy("novel-legacy", {
    outline: "一个被压制的小人物逐步反压。",
    chapters: [
      {
        order: 1,
        title: "第1章",
        expectation: "主角开局被压制",
        targetWordCount: 3000,
        conflictLevel: 75,
        revealLevel: 10,
        mustAvoid: "不要解释过多世界观",
        taskSheet: "先立压迫",
      },
      {
        order: 2,
        title: "第2章",
        expectation: "主角第一次试探反击",
        targetWordCount: 3200,
        conflictLevel: 80,
        revealLevel: 20,
        mustAvoid: "不要直接赢",
        taskSheet: "试探反压",
      },
    ],
  });

  assert.equal(volumes.length, 1);
  assert.equal(volumes[0].title, "第1卷");
  assert.equal(volumes[0].mainPromise, "主角开局被压制");
  assert.equal(volumes[0].chapters.length, 2);
  assert.equal(volumes[0].chapters[0].summary, "主角开局被压制");
  assert.equal(volumes[0].chapters[1].taskSheet, "试探反压");
});

test("parseLegacyStructuredOutline accepts flat chapter arrays and turns them into a single normalized volume", () => {
  const parsed = parseLegacyStructuredOutline(JSON.stringify([
    {
      order: 1,
      title: "第1章",
      summary: "开局压迫",
    },
    {
      order: 2,
      title: "第2章",
      summary: "第一次试探反压",
    },
  ]));

  assert.equal(parsed.length, 1);
  assert.equal(parsed[0].title, "第1卷");
  assert.equal(parsed[0].chapters.length, 2);
  assert.equal(parsed[0].chapters[1].chapterOrder, 2);
});

test("volume plan write edges strip internal quality codes from taskSheet", () => {
  const dirty = "推进资源危机；payoff_missing_progress；draft_obligation_unmet 后收尾。";
  const draft = normalizeVolumeDraftInput("novel-sanitize", [{
    title: "第一卷",
    summary: "卷摘要",
    mainPromise: "反压成立",
    escalationMode: "压迫升级",
    protagonistChange: "从退让到反压",
    climax: "卷末反压",
    nextVolumeHook: "更强敌人",
    chapters: [{
      title: "第1章",
      summary: "开局压迫",
      taskSheet: dirty,
    }],
  }]);
  assert.equal(draft.length, 1);
  const draftSheet = draft[0].chapters[0].taskSheet;
  assert.ok(draftSheet);
  assert.equal(containsInternalQualityCodes(draftSheet), false);
  assert.match(draftSheet, /资源危机/);
  assert.match(draftSheet, /收尾/);

  const legacy = buildFallbackVolumesFromLegacy("novel-sanitize-legacy", {
    outline: "被压制的小人物逐步反压。",
    chapters: [{
      order: 1,
      title: "第1章",
      expectation: "主角开局被压制",
      taskSheet: dirty,
    }],
  });
  assert.equal(legacy.length, 1);
  const legacySheet = legacy[0].chapters[0].taskSheet;
  assert.ok(legacySheet);
  assert.equal(containsInternalQualityCodes(legacySheet), false);
  assert.match(legacySheet, /资源危机/);

  // codes-only residue collapses to null on plan normalize path
  const emptied = normalizeVolumeDraftInput("novel-sanitize-empty", [{
    title: "第一卷",
    summary: "卷摘要",
    mainPromise: "反压成立",
    escalationMode: "压迫升级",
    protagonistChange: "从退让到反压",
    climax: "卷末反压",
    nextVolumeHook: "更强敌人",
    chapters: [{
      title: "第1章",
      summary: "开局压迫",
      taskSheet: "payoff_missing_progress replan_required",
    }],
  }]);
  assert.equal(emptied[0].chapters[0].taskSheet, null);
});

test("mergeChapterDetail sanitizes generated taskSheet before merge write", () => {
  const now = new Date(0).toISOString();
  const document = {
    novelId: "novel-sanitize-merge",
    workspaceVersion: "v2",
    activeVersionId: null,
    activeVersionNumber: null,
    strategy: null,
    volumes: [{
      id: "volume-1",
      novelId: "novel-sanitize-merge",
      order: 1,
      title: "第一卷",
      summary: "卷摘要",
      mainPromise: "反压",
      escalationMode: "升级",
      protagonistChange: "变化",
      climax: "高潮",
      nextVolumeHook: "钩子",
      openPayoffs: [],
      closedPayoffs: [],
      chapters: [{
        id: "chapter-1",
        volumeId: "volume-1",
        chapterOrder: 1,
        title: "第1章",
        summary: "开局",
        purpose: null,
        turningPoint: null,
        emotionalBeat: null,
        endingHook: null,
        mustAvoid: null,
        targetWordCount: 3000,
        conflictLevel: 50,
        conflictLevelSource: "ai",
        revealLevel: 10,
        payoffRefs: [],
        taskSheet: "旧合同",
        taskSheetType: null,
        chapterId: null,
      }],
      createdAt: now,
      updatedAt: now,
    }],
    beatSheets: [],
    rebalanceResults: [],
    createdAt: now,
    updatedAt: now,
  };

  const merged = mergeChapterDetail({
    document,
    targetVolumeId: "volume-1",
    targetChapterId: "chapter-1",
    detailMode: "full",
    generatedDetail: {
      taskSheet: "推进资源危机；payoff_missing_progress；draft_obligation_unmet 后收尾。",
    },
  });
  const sheet = merged.volumes[0].chapters[0].taskSheet;
  assert.ok(sheet);
  assert.equal(containsInternalQualityCodes(sheet), false);
  assert.match(sheet, /资源危机/);
  assert.match(sheet, /收尾/);
});

test("sanitize never re-persists codes-only residue (generate path contract)", () => {
  const {
    sanitizeChapterTaskSheetForPersistence,
  } = require("../../shared/dist/types/chapterTaskSheetQuality.js");
  assert.equal(
    sanitizeChapterTaskSheetForPersistence("payoff_missing_progress replan_required"),
    null,
  );
  assert.equal(
    sanitizeChapterTaskSheetForPersistence("推进资源危机；payoff_missing_progress 后收尾。")?.includes("payoff_"),
    false,
  );
  // generate return contract: never `?? original.trim()` — empty string is the safe fallback
  assert.equal(
    sanitizeChapterTaskSheetForPersistence("draft_obligation_unmet") ?? "",
    "",
  );
});

test("volumeGenerationHelpers generate/preserve must not fall back to unsanitized taskSheet", () => {
  const fs = require("node:fs");
  const path = require("node:path");
  const helpersSrc = fs.readFileSync(
    path.join(__dirname, "../src/services/novel/volume/volumeGenerationHelpers.ts"),
    "utf8",
  );
  assert.doesNotMatch(
    helpersSrc,
    /\?\?\s*(?:existingChapter\.taskSheet|generated\.output\.taskSheet)\.trim\(\)/,
    "must not re-persist unsanitized taskSheet via ?? original.trim()",
  );
  assert.match(
    helpersSrc,
    /sanitizeChapterTaskSheetForPersistence\(generated\.output\.taskSheet\)\s*\?\?\s*""/,
    "LLM generate path should map codes-only to empty string, not original",
  );
  assert.match(
    helpersSrc,
    /codes-only residue → null: fall through and regenerate/,
    "preserve path should skip codes-only sheets and regenerate",
  );
});

test("F10-norm: normalizeVolumeDraftInput backfills a non-empty volume id when id is missing/undefined (createLocalId fallback)", () => {
  // F10-backlog 改了 DraftableVolume 类型(id?: string|null)收 cast,但没补 normalize 反填单测。
  // 此测锁第 259 行 `volume.id?.trim() || createLocalId(...)`:缺 id 键/undefined 输入必反填
  // 非空 id(`<novelId>-volume-<uuid>`),防未来有人改坏反填顺序(如丢 createLocalId 兜底或
  // 先用 index 派生导致多卷冲突)。
  //
  // 取证真实契约:volumeInputSchema.id = z.string().trim().min(1).optional()——`.optional()` 只
  // 放行"缺键/undefined",**不**放行空白串/null(trim 后 min(1) 失败)。故 normalize 第 259 行的
  // `|| createLocalId` 兜底**只在 id 缺失/undefined** 时触发;空白/null 在 schema parse 阶被拦,
  // 不到反填。下方第 3 段 assert.throws 锁这一层界;第 1/2 段锁反填正路。
  const baseVolume = {
    title: "测试卷",
    mainPromise: "主线承诺",
    escalationMode: "起势",
    protagonistChange: "主角转变",
    climax: "卷末高潮",
    nextVolumeHook: "下卷钩子",
    chapters: [
      { chapterOrder: 1, title: "第1章", summary: "章摘要" },
    ],
  };

  // 1) 缺 id 键 → 反填非空字符串,形如 <novelId>-volume-<uuid>。
  const volumesMissing = normalizeVolumeDraftInput("novel-x", [{ ...baseVolume }]);
  assert.equal(volumesMissing.length, 1);
  assert.equal(typeof volumesMissing[0].id, "string");
  assert.ok(volumesMissing[0].id.length > 0, "缺 id 必反填非空字符串");
  assert.ok(volumesMissing[0].id.startsWith("novel-x-volume-"), "反填 id 用 <novelId>-volume- 前缀 + uuid");

  // 2) 显式 undefined（同缺键）→ 同样反填。
  const volumesUndefined = normalizeVolumeDraftInput("novel-x", [{ ...baseVolume, id: undefined }]);
  assert.ok(volumesUndefined[0].id.length > 0, "undefined id 必反填非空");
  assert.ok(volumesUndefined[0].id.startsWith("novel-x-volume-"), "undefined id 反填用 createLocalId");

  // 3) createLocalId 用 randomUUID,两次缺 id 输入得不同 id（唯一性,防 index/counter 派生
  //    导致跨调用偶发冲突污染 VolumePlan 主键）。
  assert.notEqual(volumesMissing[0].id, volumesUndefined[0].id, "两次反填必唯一(createLocalId=uuid)");

  // 4) 空白串 / null 不达反填——schema.parse 阶即被 `.trim().min(1).optional()` 拦。
  //    锁层界:有人若宽 schema(把 `.optional()` 改 `.nullable().optional()` 或去 min(1))放行
  //    空白,null/空就会流入 normalize 主体,届时反填需兜住——此 throws 在 schema 拦截有效时
  //    绿;schema 被放宽而反填未同步加固时,本断言会提醒补反填空白分支。
  assert.throws(
    () => normalizeVolumeDraftInput("novel-x", [{ ...baseVolume, id: "   " }]),
    /id|Too small|min/i,
    "空白串 id 在 schema 阶被拦,不到反填(契约:optional 不放行 min<1)",
  );
  assert.throws(
    () => normalizeVolumeDraftInput("novel-x", [{ ...baseVolume, id: null }]),
    /id|expected/i,
    "null id 在 schema 阶被拦(契约:optional 不放行 null)",
  );
});

test("F10-norm: presence of an explicit non-empty id disables createLocalId backfill (negative control)", () => {
  // 负控:有 id 时不走 createLocalId,反填被跳过——确保 `|| createLocalId` 短路语义不被
  // 改成"无条件 createLocalId 覆盖既有 id"（那会破坏持久化卷的稳定 id 链）。
  const volumes = normalizeVolumeDraftInput("novel-x", [{
    title: "测试卷",
    mainPromise: "主线承诺",
    escalationMode: "起势",
    protagonistChange: "主角转变",
    climax: "卷末高潮",
    nextVolumeHook: "下卷钩子",
    id: "v-stable-id",
    chapters: [{ chapterOrder: 1, title: "第1章", summary: "章摘要" }],
  }]);
  assert.equal(volumes[0].id, "v-stable-id");
  assert.ok(!volumes[0].id.startsWith("novel-x-volume-"), "显式 id 必保留不被 createLocalId 覆盖");
});
