const test = require("node:test");
const assert = require("node:assert/strict");

const { prisma } = require("../dist/db/prisma.js");
const {
  ChapterRepairFinalizer,
} = require("../dist/services/novel/runtime/repair/application/ChapterRepairFinalizer.js");

const SCORE_70 = {
  coherence: 70,
  repetition: 70,
  pacing: 70,
  voice: 70,
  engagement: 70,
  overall: 70,
};
const SCORE_92 = {
  coherence: 92,
  repetition: 92,
  pacing: 92,
  voice: 92,
  engagement: 92,
  overall: 92,
};

// baseline 正文：干净、以句号收束，避免触发 prose_truncation / prose_verbatim_repeat
// （这两个是 L0 critical，会强制 decideRepairContentAdoption discard，干扰字数门测试）。
const BASELINE_CONTENT = "这是修复之前的基线正文，长度足够且以句号收束，不会被文风探测器误判。";

/**
 * 生成指定字数的干净中文正文（不含空白计数）：每句内容互不相同、以句号收束，
 * 既不触发 prose_truncation（不以非终态标点结尾），也不触发 prose_verbatim_repeat
 * （没有任一规范化句子重复 ≥3 次）。这样文风探测器返回 0 个 L0 blocking code，
 * 字数门测试才不会被 prose 检测干扰。
 *
 * 注意：countContentCharacters 统计的是去空白后字符数，中文字符按 1 计。
 */
function buildContent(charCount) {
  const variants = [
    "山脊上风声渐紧",
    "他低头看了一眼脚下",
    "远处灯火明灭不定",
    "她侧耳听了一会儿",
    "石阶上落满了枯叶",
    "钟声又响了一遍",
    "雾气从谷底漫上来",
    "他想起很久以前的事",
  ];
  const out = [];
  let len = 0;
  let i = 1;
  while (len < charCount + 40) {
    const v = variants[i % variants.length];
    const s = `第${i}段，${v}，这段文字刻意写得各不相同以免触发重复检测。`;
    out.push(s);
    len += s.replace(/\s/g, "").length;
    i += 1;
  }
  let text = `${out.join("")}。`;
  if (!/[。！？!?]$/.test(text)) {
    text += "。";
  }
  return text;
}

function makeFindFirst(overrides = {}) {
  return async () => ({
    id: "chapter-1",
    order: 5,
    content: BASELINE_CONTENT,
    contentRevision: 7,
    repairHistory: null,
    riskFlags: null,
    qualityScore: 70,
    continuityScore: 70,
    characterScore: 70,
    pacingScore: 70,
    mustAvoid: null,
    targetWordCount: 12000,
    novel: { storyWorldSliceJson: null, storyWorldSliceOverridesJson: null },
    ...overrides,
  });
}

test("RED-1: candidate 字数低于 target×0.6 时不得 adopt（字数硬门拦截）", async () => {
  const originalFindFirst = prisma.chapter.findFirst;
  const originalUpdate = prisma.chapter.update;
  const originalUpdateMany = prisma.chapter.updateMany;
  const originalTransaction = prisma.$transaction;
  const frames = [];
  let committedInput = null;

  try {
    prisma.chapter.findFirst = makeFindFirst();
    prisma.chapter.update = async () => ({});
    prisma.chapter.updateMany = async () => ({ count: 1 });
    // mock 掉 adopt 后写库路径，避免打到真 DB（当前未实现字数门时，
    // 短候选会被 adopt 并走到 persistChapterQualityScores → 真表报错干扰断言）。
    prisma.$transaction = async (cb) => cb({
      chapter: {
        update: async () => ({}),
        updateMany: async () => ({ count: 1 }),
        findFirst: async () => ({ contentRevision: 8 }),
      },
      qualityReport: { create: async () => ({}) },
    });

    // candidate review 给高分，证明字数门独立于 LLM 分数：即便 LLM 打 92，
    // 字数不足也必须拦截（与 generate 路径 under_hard 压分到 49 同语义）。
    // baseline（BASELINE_CONTENT）给 70，candidate 给 92，确保 decideRepairContentAdoption
    // 在没有字数门时会走 adopt —— 这样拦截只能来自字数门，不被分数决策抢功。
    const shortCandidate = buildContent(3000);
    const finalizer = new ChapterRepairFinalizer({
      contentCommitService: {
        commit: async (input) => {
          committedInput = input;
          return {
            novelId: input.novelId,
            chapterId: input.chapterId,
            content: input.content,
            contentRevision: 8,
          };
        },
      },
      artifactSyncService: { syncChapterArtifacts: async () => undefined },
      reviewChapterAfterRepair: async (_novelId, _chapterId, options) => ({
        score: options.content === shortCandidate ? SCORE_92 : SCORE_70,
        issues: [],
      }),
      resolveAuditIssues: async () => undefined,
    });

    // target=12000, hardMin=7200。candidate=3000 字 → under_hard。
    await finalizer.finalize({
      novelId: "novel-1",
      chapterId: "chapter-1",
      baselineContentRevision: 7,
      options: { repairMode: "light_repair" },
      content: shortCandidate,
      helpers: { writeFrame: (frame) => frames.push(frame) },
    });

    // 核心断言：短候选绝不被写入。
    assert.equal(committedInput, null, "字数 under_hard 的候选不得进入 commit（不得写新正文）");
    // run_status 终帧须体现字数事实（actual/target/hardMin），证明拦截由字数门触发，
    // 而非普通分数 discard。注：discard 的 run status 沿用既有语义记 "succeeded"
    // （运行本身完成，候选被客观拒绝），故这里只断言 message 内容，不强求 status。
    const last = frames.at(-1);
    assert.ok(last, "必须产出 run_status 终帧");
    assert.ok(
      /未采纳/.test(last.message) && /字数|篇幅|硬下限/.test(last.message),
      `run_status message 须说明字数不足未采纳，实际：${last.message}`,
    );
    assert.ok(
      /3000|3072|30\d{2}/.test(last.message),
      `message 须含候选实际字数事实，实际：${last.message}`,
    );
    assert.ok(
      /12000/.test(last.message) && /7200/.test(last.message),
      `message 须含目标 12000 与硬下限 7200，实际：${last.message}`,
    );
  } finally {
    prisma.chapter.findFirst = originalFindFirst;
    prisma.chapter.update = originalUpdate;
    prisma.chapter.updateMany = originalUpdateMany;
    prisma.$transaction = originalTransaction;
  }
});

test("RED-2: candidate 字数 ≥ hardMin 时正常走 adopt（回归保护）", async () => {
  const originalFindFirst = prisma.chapter.findFirst;
  const originalUpdate = prisma.chapter.update;
  const originalUpdateMany = prisma.chapter.updateMany;
  const originalTransaction = prisma.$transaction;
  let committedInput = null;

  try {
    prisma.chapter.findFirst = makeFindFirst();
    // adopt 后路径会写库（persistChapterQualityScores 走 $transaction，
    // recordAssessment 走 chapter.update/updateMany）；mock 掉避免打真 DB。
    prisma.chapter.update = async () => ({});
    prisma.chapter.updateMany = async () => ({ count: 1 });
    prisma.$transaction = async (cb) => cb({
      chapter: {
        update: async () => ({}),
        updateMany: async () => ({ count: 1 }),
        findFirst: async () => ({ contentRevision: 8 }),
      },
      qualityReport: { create: async () => ({}) },
    });
    // target=12000, hardMin=7200。candidate=8000 字 ≥ hardMin → 不拦截，正常 adopt。
    const longEnough = buildContent(8000);
    const finalizer = new ChapterRepairFinalizer({
      contentCommitService: {
        commit: async (input) => {
          committedInput = input;
          return {
            novelId: input.novelId,
            chapterId: input.chapterId,
            content: input.content,
            contentRevision: 8,
          };
        },
      },
      artifactSyncService: { syncChapterArtifacts: async () => undefined },
      // baseline 分数低于 candidate，确保 decideRepairContentAdoption 走 adopt。
      reviewChapterAfterRepair: async (_n, _c, options) => ({
        score: options.content === longEnough ? SCORE_92 : SCORE_70,
        issues: [],
      }),
      resolveAuditIssues: async () => undefined,
    });

    await finalizer.finalize({
      novelId: "novel-1",
      chapterId: "chapter-1",
      baselineContentRevision: 7,
      options: { repairMode: "heavy_repair" },
      content: longEnough,
      helpers: { writeFrame: () => undefined },
    });

    assert.ok(committedInput, "字数达 hardMin 的候选应正常进入 commit");
    assert.equal(committedInput.content, longEnough);
  } finally {
    prisma.chapter.findFirst = originalFindFirst;
    prisma.chapter.update = originalUpdate;
    prisma.chapter.updateMany = originalUpdateMany;
    prisma.$transaction = originalTransaction;
  }
});

test("RED-3: targetWordCount 缺失时不报错、不拦截（兼容无合同章节）", async () => {
  const originalFindFirst = prisma.chapter.findFirst;
  const originalUpdate = prisma.chapter.update;
  const originalUpdateMany = prisma.chapter.updateMany;
  const originalTransaction = prisma.$transaction;
  let committedInput = null;

  try {
    prisma.chapter.findFirst = makeFindFirst({ targetWordCount: null });
    prisma.chapter.update = async () => ({});
    prisma.chapter.updateMany = async () => ({ count: 1 });
    prisma.$transaction = async (cb) => cb({
      chapter: {
        update: async () => ({}),
        updateMany: async () => ({ count: 1 }),
        findFirst: async () => ({ contentRevision: 8 }),
      },
      qualityReport: { create: async () => ({}) },
    });
    // 无 targetWordCount → 无字数门，即便很短也应正常 adopt（不抛错）。
    const shortContent = buildContent(500);
    const finalizer = new ChapterRepairFinalizer({
      contentCommitService: {
        commit: async (input) => {
          committedInput = input;
          return {
            novelId: input.novelId,
            chapterId: input.chapterId,
            content: input.content,
            contentRevision: 8,
          };
        },
      },
      artifactSyncService: { syncChapterArtifacts: async () => undefined },
      // baseline 分数低于 candidate，确保 adopt 发生。
      reviewChapterAfterRepair: async (_n, _c, options) => ({
        score: options.content === shortContent ? SCORE_92 : SCORE_70,
        issues: [],
      }),
      resolveAuditIssues: async () => undefined,
    });

    await finalizer.finalize({
      novelId: "novel-1",
      chapterId: "chapter-1",
      baselineContentRevision: 7,
      options: { repairMode: "heavy_repair" },
      content: shortContent,
      helpers: { writeFrame: () => undefined },
    });

    assert.ok(committedInput, "无 targetWordCount 时不应被字数门拦截");
  } finally {
    prisma.chapter.findFirst = originalFindFirst;
    prisma.chapter.update = originalUpdate;
    prisma.chapter.updateMany = originalUpdateMany;
    prisma.$transaction = originalTransaction;
  }
});
