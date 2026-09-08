const test = require("node:test");
const assert = require("node:assert/strict");

// code-review #4/#5 backlog：
//   (4) D3 持久化失败兜底的 catch 块此前没有集成测试覆盖——只测了纯函数
//       buildNonSettingDebtStubUpdate 的返回值，没验证真正落到 prisma.chapter.update
//       的 where/data 形参（recordAssessment 抛错后两条对称 stub 路径各自写什么）。
//   (5) setting-debt 与非 setting-debt 两条 stub 落库重复逻辑抽 persistStubRiskFlags。
// 这里同时收口：把 stub 落库抽成可注入 prisma 的 helper，对其断言 prisma 调用形参，
// 等价于「recordAssessment 失败路径」的集成覆盖（helper 内部 update 抛错 = 模拟主路径失败）。
//
// 契约（与 PipelineChapterQualityPolicy.ts 现有两条 stub 路径一一对应）：
//   - setting-debt：写 { riskFlags, chapterStatus: "needs_repair" }（有债须置 needs_repair）
//   - 非 setting-debt：写 { riskFlags }（不动 chapterStatus，误置 needs_repair 会误伤无债章）
//   - 二次落库失败仅记日志、不重抛（主路径已在 fail-open 兜底，再抛会污染上层）

const { persistStubRiskFlags } = require(
  "../dist/services/novel/pipeline/quality/PipelineChapterQualityPolicy.js",
);

/** 捕获式 prisma：收集 chapter.update 调用形参；可令 update 抛错模拟主路径失败。 */
function makeCapturingPrisma({ updateThrows = false } = {}) {
  const calls = [];
  return {
    calls,
    chapter: {
      update: async (input) => {
        calls.push(input);
        if (updateThrows) {
          throw new Error("simulated primary persist failure");
        }
        return { id: input.where?.id ?? "x" };
      },
    },
  };
}

const baseCtx = {
  jobId: "job-1",
  novelId: "novel-1",
  chapterId: "chapter-42",
  chapterOrder: 7,
  memoryRiskFlags: JSON.stringify({ qualityLoop: { rootCauseCode: "test" } }),
  expectedContentRevision: 9,
};

test("RED-1 (setting-debt): 写 riskFlags 且置 chapterStatus=needs_repair", async () => {
  const prisma = makeCapturingPrisma();
  await persistStubRiskFlags({
    ...baseCtx,
    settingDebtBlocksProcessed: true,
    prisma,
  });

  assert.equal(prisma.calls.length, 1, "setting-debt 须触发一次 stub update");
  const call = prisma.calls[0];
  assert.deepEqual(call.where, { id: "chapter-42" });
  assert.equal(call.data.riskFlags, baseCtx.memoryRiskFlags);
  assert.equal(
    call.data.chapterStatus,
    "needs_repair",
    "setting-debt 路径须置 needs_repair（有债须修）",
  );
});

test("RED-2 (非 setting-debt): 写 riskFlags 且不动 chapterStatus", async () => {
  const prisma = makeCapturingPrisma();
  await persistStubRiskFlags({
    ...baseCtx,
    settingDebtBlocksProcessed: false,
    prisma,
  });

  assert.equal(prisma.calls.length, 1, "非 setting-debt 须触发一次 stub update");
  const call = prisma.calls[0];
  assert.deepEqual(call.where, { id: "chapter-42" });
  assert.equal(call.data.riskFlags, baseCtx.memoryRiskFlags);
  assert.equal(
    call.data.chapterStatus,
    undefined,
    "非 setting-debt 不应误置 needs_repair（无债误伤）",
  );
});

test("RED-3 (非 setting-debt 缺 riskFlags): 不写（buildNonSettingDebtStubUpdate 返回 null）", async () => {
  const prisma = makeCapturingPrisma();
  await persistStubRiskFlags({
    ...baseCtx,
    memoryRiskFlags: null,
    settingDebtBlocksProcessed: false,
    prisma,
  });
  assert.equal(prisma.calls.length, 0, "缺 riskFlags 时非 setting-debt 路径不应写库");
});

test("RED-4 (二次落库失败): stub update 抛错仅记日志、不重抛", async () => {
  const prisma = makeCapturingPrisma({ updateThrows: true });
  // 不论哪条路径，helper 内部 update 抛错都应被吞掉——主路径已在 fail-open 兜底，
  // 再抛会污染上层调用方。这里断言「await 不抛」即可。
  await assert.doesNotReject(() =>
    persistStubRiskFlags({
      ...baseCtx,
      settingDebtBlocksProcessed: true,
      prisma,
    }),
  );
  await assert.doesNotReject(() =>
    persistStubRiskFlags({
      ...baseCtx,
      settingDebtBlocksProcessed: false,
      prisma,
    }),
  );
  assert.equal(prisma.calls.length, 2, "两条路径各尝试一次 update（即使都抛错）");
});
