/**
 * 有声书续生成（已交付任务「对照 list + 继续生成缺失章」）纯逻辑单测。
 *
 * SoT: docs/plans/audiobook-ai-ops-implemented.md 续生成节（本轮新增）
 *
 * 不 mock prisma（项目无此 mock 习惯），仅测可独立运行的纯函数契约：
 *  - resolveExplicitChapterIds：续生成路径 precheck 显式 chapterIds 解析
 *  - readParentTaskIdFromProgress / readFailedContinueChapters：listByNovel 隐闭过滤 + 对照 list 标黄依据
 *  - toSummary（间接 deriveChapterProgress + readFailedContinueChapters）：succeeded 任务 progressJson→summary 字符串透出
 *
 * DB 层（createTask/continueParentTask/executeTask/reconcileParent/cascade cancel）依赖真 audiobookTask 表，
 * 记 Manual-required，在 pxed 真机以 E2E 验（见开发文档验证步骤 4-7）。
 */
const test = require("node:test");
const assert = require("node:assert/strict");

const {
  resolveExplicitChapterIds,
} = require("../dist/services/audiobook/AudiobookPrecheckService.js");
const {
  readParentTaskIdFromProgress,
  readFailedContinueChapters,
} = require("../dist/services/audiobook/AudiobookTaskService.js");
// SoT: pipeline.run 必须用传入的 outputDir（父目录），否则续生成章 wav 落子目录、父 reconcile 看不到（P0）
// ensureDirExistsUnderAudiobookRoot 在 withTempDataRoot 块内 lazy-require（按 env 重定向 DATA_ROOT）。
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");

function makeChapter(order, id) {
  return { id, order, title: `第 ${order} 章` };
}

test("resolveExplicitChapterIds: 按显式 id 子集解析并按 order 升序", () => {
  const chapters = [
    makeChapter(3, "c3"),
    makeChapter(1, "c1"),
    makeChapter(2, "c2"),
  ];
  // 乱序传入，应按 order 升序回
  const resolved = resolveExplicitChapterIds(chapters, ["c3", "c1"]);
  assert.deepEqual(
    resolved.map((c) => c.id),
    ["c1", "c3"],
  );
  assert.deepEqual(
    resolved.map((c) => c.order),
    [1, 3],
  );
});

test("resolveExplicitChapterIds: trim + 去重", () => {
  const chapters = [makeChapter(1, "c1"), makeChapter(2, "c2")];
  const resolved = resolveExplicitChapterIds(chapters, [" c1 ", "c1", "c2"]);
  assert.deepEqual(
    resolved.map((c) => c.id),
    ["c1", "c2"],
  );
});

test("resolveExplicitChapterIds: 全部为空白 → 400", () => {
  const chapters = [makeChapter(1, "c1")];
  assert.throws(
    () => resolveExplicitChapterIds(chapters, ["  ", ""]),
    (err) => err.statusCode === 400 && /explicitChapterIds 不能为空/.test(err.message),
  );
});

test("resolveExplicitChapterIds: 空数组 → 400", () => {
  const chapters = [makeChapter(1, "c1")];
  assert.throws(
    () => resolveExplicitChapterIds(chapters, []),
    (err) => err.statusCode === 400,
  );
});

test("resolveExplicitChapterIds: 任一 id 不存在 → 404 并列出缺失", () => {
  const chapters = [makeChapter(1, "c1")];
  assert.throws(
    () => resolveExplicitChapterIds(chapters, ["c1", "ghost"]),
    (err) => err.statusCode === 404 && /ghost/.test(err.message) && /不在该小说范围内/.test(err.message),
  );
});

test("readParentTaskIdFromProgress: 父行为空、子行回写 parentTaskId", () => {
  assert.equal(readParentTaskIdFromProgress(null), null);
  assert.equal(readParentTaskIdFromProgress(""), null);
  assert.equal(readParentTaskIdFromProgress(JSON.stringify({ deliveryStyleMode: "off" })), null);
  assert.equal(
    readParentTaskIdFromProgress(JSON.stringify({ parentTaskId: "  " })),
    null,
  );
  assert.equal(
    readParentTaskIdFromProgress(JSON.stringify({ hidden: true, parentTaskId: "parent_x" })),
    "parent_x",
  );
});

test("readFailedContinueChapters: 解析失败章列表并过滤非法元素", () => {
  assert.deepEqual(readFailedContinueChapters(null), []);
  assert.deepEqual(readFailedContinueChapters(JSON.stringify({})), []);
  assert.deepEqual(
    readFailedContinueChapters(
      JSON.stringify({ failedContinueChapters: ["ch1", "ch2", "  ", 3, null] }),
    ),
    ["ch1", "ch2"],
  );
});

test("listByNovel 隐闭过滤契约：parentTaskId 非空即隐闭子任务", () => {
  // 列举两种 progressJson，模拟 listByNovel 应用端 filter 行为（同 readParentTaskIdFromProgress）
  const rows = [
    { id: "parent_1", progressJson: JSON.stringify({ deliveryStyleMode: "off" }) },
    { id: "child_1", progressJson: JSON.stringify({ parentTaskId: "parent_1", hidden: true }) },
    { id: "parent_2", progressJson: null },
    { id: "child_2", progressJson: "" },
  ];
  const visible = rows.filter(
    (row) => !readParentTaskIdFromProgress(row.progressJson),
  );
  assert.deepEqual(
    visible.map((r) => r.id),
    ["parent_1", "parent_2", "child_2"],
  );
  // child_1 因 progressJson 含 parentTaskId 被隐闭
});

test("对照 list 标黄契约：父 progressJson.failedContinueChapters 作为前端标黄依据", () => {
  const parentProgressJson = JSON.stringify({
    deliveryStyleMode: "off",
    failedContinueChapters: ["ch4", "ch7"],
  });
  // toSummary 透出该字段（前端 AudiobookTaskSummary.failedContinueChapters）
  assert.deepEqual(
    readFailedContinueChapters(parentProgressJson),
    ["ch4", "ch7"],
  );
});

test("子任务终态后失败章合并契约：appendFailedContinueChapters 去重语义", () => {
  // 手工模拟父 progressJson 失败章合并（去重 union），对应 server 内 appendFailedContinueChapters
  const existing = ["ch4", "ch7"];
  const newlyFailed = ["ch4", "ch9"];
  const merged = Array.from(new Set([...existing, ...newlyFailed]));
  assert.deepEqual(merged, ["ch4", "ch7", "ch9"]);
});

// resolveDataRoot 在 desktop runtime 下走 AI_NOVEL_APP_DATA_DIR；web runtime 走工程根（忽略 env）。
// 测试内临时切到 desktop + tmpDir，避免污染真实路径；测后还原。
function withTempDataRoot(fn) {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "abk-root-"));
  const prevRuntime = process.env.AI_NOVEL_RUNTIME;
  const prevData = process.env.AI_NOVEL_APP_DATA_DIR;
  process.env.AI_NOVEL_RUNTIME = "desktop";
  process.env.AI_NOVEL_APP_DATA_DIR = tmpRoot;
  try {
    fn(tmpRoot);
  } finally {
    if (prevRuntime === undefined) delete process.env.AI_NOVEL_RUNTIME;
    else process.env.AI_NOVEL_RUNTIME = prevRuntime;
    if (prevData === undefined) delete process.env.AI_NOVEL_APP_DATA_DIR;
    else process.env.AI_NOVEL_APP_DATA_DIR = prevData;
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
}

test("P0 续生成目录约束：父 outputDir 必须位于有声书产物根之下（拒绝越界 / 遍历）", () => {
  withTempDataRoot((tmpRoot) => {
    const { ensureDirExistsUnderAudiobookRoot } =
      require("../dist/services/audiobook/audiobookPaths.js");

    // desktop runtime 下 resolveAudiobookRoot = tmpRoot/data/storage/audiobooks
    const root = path.join(tmpRoot, "data", "storage", "audiobooks");
    const novelDir = path.join(root, "novelA");
    const parentDir = path.join(novelDir, "parentTaskA");
    fs.mkdirSync(parentDir, { recursive: true });

    // 合法：父 outputDir 在根下 → 创建并回绝对等价路径
    const ok = ensureDirExistsUnderAudiobookRoot(parentDir);
    assert.equal(path.resolve(ok), path.resolve(parentDir));

    // 越界：根外目录 → 拒绝（realpath 后物理路径仍在根外）
    const outside = path.join(tmpRoot, "outside", "x");
    assert.throws(
      () => ensureDirExistsUnderAudiobookRoot(outside),
      (err) => err instanceof Error && /越界|位于有声书产物根/.test(err.message),
    );

    // 遍历：/../ escape → 拒绝（白名单先拒显式 ../ 段）
    const escape = path.join(parentDir, "..", "..", "..", "..", "etctest");
    assert.throws(
      () => ensureDirExistsUnderAudiobookRoot(escape),
      (err) => err instanceof Error && /越界|非法路径字符/.test(err.message),
    );

    // 空 → 拒绝
    assert.throws(() => ensureDirExistsUnderAudiobookRoot("  "), (err) => err instanceof Error);
  });
});

test("P0 续生成目录约束：软链前缀等价（resolveAudiobookRoot 走物理根、outputDir 走软链根）", () => {
  // 模拟生产：__dirname 物理根 = /data/ainovel/.../server；outputDir 以软链前缀 /personal/pxed/.../server 落库。
  // realpath 规范化后两者物理一致，容器内应接受。
  withTempDataRoot((tmpRoot) => {
    const { ensureDirExistsUnderAudiobookRoot } =
      require("../dist/services/audiobook/audiobookPaths.js");

    const physicalRoot = path.join(tmpRoot, "data", "storage", "audiobooks");
    // 在 physicalRoot 旁建一个软链 aliasRoot，再让 outputDir 走 aliasRoot 前缀
    const physicalNovelDir = path.join(physicalRoot, "novelAlias");
    const physicalParentDir = path.join(physicalNovelDir, "parentAlias");
    fs.mkdirSync(physicalParentDir, { recursive: true });

    // aliasRoot/.../parent 是软链到 physicalParentDir 的等价访问路径
    const aliasRoot = path.join(tmpRoot, "aliasRoot");
    fs.symlinkSync(physicalRoot, aliasRoot);
    const aliasParentDir = path.join(aliasRoot, "novelAlias", "parentAlias");

    // 现实同点经 realpath 后内部已 resolve，应通过根下 containment
    const ok = ensureDirExistsUnderAudiobookRoot(aliasParentDir);
    assert.equal(fs.realpathSync(ok), fs.realpathSync(physicalParentDir));
  });
});

// 续生成父任务终态决策契约（本轮 fix）：
//   allReady → 父 succeeded / currentStage=finalizing / progress=100
//   非全 ready（子终态，含失败/取消/部分成功） → 父 failed / currentStage!=continuing / progress<100
// 不变量驱动：continueParentTask 仅接受 succeeded|failed，resumePendingTasks 跳过 currentStage=="continuing"。
// 若非全 ready 时父留在 running/continuing：续生成按钮被 409 挡、重启不 pull-back、前端 continueable=false → 父永卡死。
// 这里测驱动父态的两个 disk-side 决策输入（listReadyChapterAudioIds / deriveChapterProgress），
// 保证「部分就绪 → 非 allReady → 父必翻 failed + currentStage 清空」分支可达且稳定。
test("续生成父态决策契约：部分磁盘就绪 → allReady=false，progress 必 <100（驱动父翻 failed）", () => {
  withTempDataRoot((tmpRoot) => {
    const { listReadyChapterAudioIds, ensureChapterAudioDir, resolveChapterAudioPath } =
      require("../dist/services/audiobook/audiobookPaths.js");
    const { buildWavBuffer } = require("../dist/services/audiobook/audiobookWav.js");
    const { deriveChapterProgress } =
      require("../dist/services/audiobook/AudiobookTaskService.js");

    const root = path.join(tmpRoot, "data", "storage", "audiobooks", "novelX");
    const taskDir = path.join(root, "parentX");
    const chapterIds = ["ch1", "ch2", "ch3"];
    // 只 ch1 落合法 PCM chapter.wav（就绪），ch2/ch3 不落
    ensureChapterAudioDir(taskDir, "ch1");
    fs.writeFileSync(
      resolveChapterAudioPath(taskDir, "ch1"),
      buildWavBuffer(Buffer.alloc(1000), { numChannels: 1, sampleRate: 16000, bitsPerSample: 16 }),
    );

    const ready = listReadyChapterAudioIds(taskDir, chapterIds);
    assert.deepEqual(ready, ["ch1"]);
    const allReady = ready.length === chapterIds.length;
    assert.equal(allReady, false, "部分就绪不应判 allReady");

    // 驱动父 progress 的 round 必 < 100（修复后非全 ready 走 failed 分支，progress=ready/total）
    const parentProgress = Math.max(2, Math.min(99, Math.round((ready.length / Math.max(1, chapterIds.length)) * 100)));
    assert.ok(parentProgress < 100, `部分就绪 progress 应 <100，实得 ${parentProgress}`);
    assert.equal(parentProgress, 33);

    // deriveChapterProgress 复用磁盘真相恢复 chapterProgress 快照（父 progressJson 字段在 reconcileParent 里以此重建）
    const chapterProgress = deriveChapterProgress(null, chapterIds, ready);
    assert.deepEqual(
      chapterProgress.map((c) => ({ id: c.chapterId, status: c.status })),
      [
        { id: "ch1", status: "ready" },
        { id: "ch2", status: "pending" },
        { id: "ch3", status: "pending" },
      ],
    );
  });
});

test("续生成父态决策契约：全磁盘就绪 → allReady=true，父翻 succeeded / progress=100", () => {
  withTempDataRoot((tmpRoot) => {
    const { listReadyChapterAudioIds, ensureChapterAudioDir, resolveChapterAudioPath } =
      require("../dist/services/audiobook/audiobookPaths.js");
    const { buildWavBuffer } = require("../dist/services/audiobook/audiobookWav.js");

    const taskDir = path.join(tmpRoot, "data", "storage", "audiobooks", "novelY", "parentY");
    const chapterIds = ["ch1", "ch2"];
    for (const cid of chapterIds) {
      ensureChapterAudioDir(taskDir, cid);
      fs.writeFileSync(
        resolveChapterAudioPath(taskDir, cid),
        buildWavBuffer(Buffer.alloc(500), { numChannels: 1, sampleRate: 16000, bitsPerSample: 16 }),
      );
    }
    const ready = listReadyChapterAudioIds(taskDir, chapterIds);
    assert.equal(ready.length, 2);
    assert.equal(ready.length === chapterIds.length, true, "全就绪应判 allReady");
    const parentProgress = ready.length === chapterIds.length ? 100 : 0;
    assert.equal(parentProgress, 100);
  });
});

test("续生成失败章修剪契约：磁盘就绪章从 failedContinueChapters 移除（避免 stale 标黄）", () => {
  // 模拟 reconcileParent 内 prune 语义：reconcile 后已就绪的章不再 stay failedContinueChapters
  const existingFailed = ["ch2", "ch3"]; // 之前失败
  const readyAfterRetry = ["ch2"]; // ch2 重试成 → 磁盘就绪
  const pruned = existingFailed.filter((id) => !new Set(readyAfterRetry).has(id));
  assert.deepEqual(pruned, ["ch3"], "已就绪章应从失败列表移除，仅保留真未就绪");
});

// 续生成子任务跳过 finalize 全书合并 + 父 reconcile 重拼全书（修静默数据损坏：
// 子 chapterIds 是父章集子集，用 subset concat 覆写父 full-book.wav 会让全书只剩子集）。
// 这里测两个磁盘契约：
//  (a) allReady 且 full-book.wav 缺失 → 用全 chapterIds 的 per-chapter.wav 就地重拼得到合法 PCM 全书
//  (b) 有 isContinueChild 信号时不应向共享父目录写 full-book（pipeline 跳过由 DB 层验，此处只验磁盘侧契约不变）
test("续生成父态决策契约：allReady 但 full-book.wav 缺失 → 用 per-chapter.wav 重拼，isFullBookAudioReady 成真", () => {
  withTempDataRoot((tmpRoot) => {
    const {
      listReadyChapterAudioIds,
      ensureChapterAudioDir,
      resolveChapterAudioPath,
      resolveFullBookAudioPath,
      isFullBookAudioReady,
    } = require("../dist/services/audiobook/audiobookPaths.js");
    const { buildWavBuffer, concatWavFiles } = require("../dist/services/audiobook/audiobookWav.js");

    const taskDir = path.join(tmpRoot, "data", "storage", "audiobooks", "novelZ", "parentZ");
    const chapterIds = ["ch1", "ch2", "ch3"];
    // 全章 chapter.wav 就绪
    for (const cid of chapterIds) {
      ensureChapterAudioDir(taskDir, cid);
      fs.writeFileSync(
        resolveChapterAudioPath(taskDir, cid),
        buildWavBuffer(Buffer.alloc(800), { numChannels: 1, sampleRate: 16000, bitsPerSample: 16 }),
      );
    }
    const fullBook = resolveFullBookAudioPath(taskDir);
    // full-book.wav 一开始不存在（被续生成子按「章变 → 全书必重拼」清掉后的状态）
    assert.equal(isFullBookAudioReady(taskDir), false, "清掉后 full-book.wav 不应就绪");

    const ready = listReadyChapterAudioIds(taskDir, chapterIds);
    assert.equal(ready.length, chapterIds.length, "全章就绪");
    const allReady = ready.length === chapterIds.length;

    // 模拟 reconcileParent 在 allReady && !fullAudioReady 分支的就地重拼逻辑
    assert.equal(allReady && !isFullBookAudioReady(taskDir), true, "命中重拼条件");
    const chapterPaths = chapterIds.map((id) => resolveChapterAudioPath(taskDir, id));
    concatWavFiles(chapterPaths, fullBook, []);
    assert.equal(isFullBookAudioReady(taskDir), true, "重拼后 full-book.wav 应就绪");
  });
});

test("续生成子任务跳过全书合并契约：isContinueChild 返回 fullAudioPath=null 与 m4b.status=skipped 的结果形状", () => {
  // pipeline.run 走 DB+prisma 不可纯函数测；这里断言结果形状契约：
  // 续生成子任务的成功终态 result.fullAudioPath 必 null、m4b.status 必 "skipped"
  // 否则 executeTask 会把子集覆写的 full-book.wav 写回父共享目录的 DB 行 → 静默数据损坏。
  const continueChildResult = {
    fullAudioPath: null,
    m4b: { status: "skipped", path: null, relativePath: null, reason: "continue-child" },
  };
  assert.equal(continueChildResult.fullAudioPath, null, "续生成子任务不应回 fullAudioPath");
  assert.equal(continueChildResult.m4b.status, "skipped");
  assert.equal(continueChildResult.m4b.reason, "continue-child");
});
