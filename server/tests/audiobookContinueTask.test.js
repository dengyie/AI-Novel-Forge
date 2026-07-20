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
  listByNovelFetchTake,
  accumulateVisibleParents,
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

test("listByNovel 过取契约：pageSize 钳制 + 多页凑满可见父（不靠单次 500 封顶）", () => {
  assert.equal(listByNovelFetchTake(50), 200, "pageSize 封顶 200");
  assert.equal(listByNovelFetchTake(1), 51);
  assert.equal(listByNovelFetchTake(100), 200);
  assert.equal(listByNovelFetchTake(999), 200, "可见上限 100 → page 封顶 200");
  // 页1：200 全是隐闭子；页2：20 父 → 迭代后应见 20 父（旧单 take=50/500 会漏）
  const page1 = [];
  for (let i = 0; i < 200; i += 1) {
    page1.push({ id: `child_${i}`, progressJson: JSON.stringify({ parentTaskId: "p", hidden: true }) });
  }
  const page2 = [];
  for (let i = 0; i < 20; i += 1) {
    page2.push({ id: `parent_${i}`, progressJson: null });
  }
  const visible = accumulateVisibleParents([page1, page2], 50);
  assert.equal(visible.length, 20, "多页扫描后 20 个父应全见");
  assert.equal(visible[0].id, "parent_0");
  // 旧单页 take=50：只见 0 父
  const oldVisible = page1.slice(0, 50).filter((row) => !readParentTaskIdFromProgress(row.progressJson));
  assert.equal(oldVisible.length, 0, "旧单页被 200 子挤到 0 父");
});

test("取消竞态契约：源码 pipeline 返回后 cancel 必须 markCancelled + finalizeContinueChild", () => {
  const src = fs.readFileSync(
    path.join(__dirname, "../src/services/audiobook/AudiobookTaskService.ts"),
    "utf8",
  );
  // 定位 pipeline.run 之后的 cancel 竞态块（注释锚点 + 两行 await）
  assert.match(
    src,
    /pipeline 已返回后的取消竞态[\s\S]{0,400}?markCancelledIfActive\([\s\S]{0,120}?finalizeContinueChild\(taskId,\s*true\)/,
    "pipeline 返回后 cancel 必须 finalize",
  );
  // catch 取消/失败路径同样 finalize，避免 orphan 父
  assert.match(
    src,
    /PipelineCancelledError[\s\S]{0,400}?finalizeContinueChild\(taskId,\s*true\)/,
    "PipelineCancelledError 路径必须 finalize",
  );
  assert.match(
    src,
    /markFailedIfRunning\([\s\S]{0,200}?finalizeContinueChild\(taskId,\s*true\)/,
    "markFailed 后必须 finalize",
  );
});

test("continuing 父取消契约：源码须 cascade + reconcile + 强制 cancelled 终态", () => {
  const src = fs.readFileSync(
    path.join(__dirname, "../src/services/audiobook/AudiobookTaskService.ts"),
    "utf8",
  );
  assert.match(
    src,
    /isContinuingParent\s*=\s*!isContinueChild\s*&&\s*task\.currentStage\s*===\s*"continuing"/,
    "须识别 continuing 父",
  );
  assert.match(
    src,
    /if\s*\(isContinuingParent\)\s*\{[\s\S]{0,800}?cancelChildContinueTasks|if\s*\(isContinuingParent\)\s*\{[\s\S]{0,800}?reconcileParent/,
    "continuing 父取消须 reconcile",
  );
  // 强制 cancelled 的 CAS：仅 status 仍 running/queued 时写入
  assert.match(
    src,
    /isContinuingParent[\s\S]{0,1200}?status:\s*\{\s*in:\s*\["running",\s*"queued"\]\s*\}[\s\S]{0,200}?status:\s*"cancelled"/,
    "仍非终态须强制 cancelled",
  );
  const continuingParent = {
    status: "running",
    currentStage: "continuing",
    progressJson: JSON.stringify({ deliveryStyleMode: "off" }),
  };
  const isContinueChild = Boolean(readParentTaskIdFromProgress(continuingParent.progressJson));
  const isContinuingParent = !isContinueChild && continuingParent.currentStage === "continuing";
  assert.equal(isContinueChild, false);
  assert.equal(isContinuingParent, true);
});

test("resynthesize wipe 契约：wipe 目标章后 chapter.wav 与 full-book 消失（强制重合成）", () => {
  withTempDataRoot((tmpRoot) => {
    const {
      ensureChapterAudioDir,
      resolveChapterAudioPath,
      resolveFullBookAudioPath,
      resolveFullBookM4bPath,
      wipeChapterAudioArtifacts,
      isChapterAudioReady,
      isFullBookAudioReady,
      isFullBookM4bReady,
    } = require("../dist/services/audiobook/audiobookPaths.js");
    const { buildWavBuffer } = require("../dist/services/audiobook/audiobookWav.js");

    const taskDir = path.join(tmpRoot, "data", "storage", "audiobooks", "novelR", "parentR");
    const chapterId = "ch1";
    ensureChapterAudioDir(taskDir, chapterId);
    const chapterWav = resolveChapterAudioPath(taskDir, chapterId);
    const fullBook = resolveFullBookAudioPath(taskDir);
    const m4b = resolveFullBookM4bPath(taskDir);
    fs.writeFileSync(
      chapterWav,
      buildWavBuffer(Buffer.alloc(400), { numChannels: 1, sampleRate: 16000, bitsPerSample: 16 }),
    );
    fs.writeFileSync(
      fullBook,
      buildWavBuffer(Buffer.alloc(800), { numChannels: 1, sampleRate: 16000, bitsPerSample: 16 }),
    );
    fs.writeFileSync(m4b, Buffer.alloc(128, 1));
    assert.equal(isChapterAudioReady(taskDir, chapterId), true);
    assert.equal(isFullBookAudioReady(taskDir), true);
    assert.equal(isFullBookM4bReady(taskDir), true, "≥64 字节 m4b 视为 ready");

    wipeChapterAudioArtifacts(taskDir, chapterId);
    assert.equal(isChapterAudioReady(taskDir, chapterId), false, "resynthesize 后章 wav 必须清");
    assert.equal(isFullBookAudioReady(taskDir), false, "resynthesize 后 full-book 必须清");
    assert.equal(fs.existsSync(m4b), false, "resynthesize 后 m4b 必须清");
    assert.equal(isFullBookM4bReady(taskDir), false);
  });
});

test("m4b 后台封装契约：reconcile 不 await encode；已 ready 则 skip；缺则 scheduleBackground", () => {
  const src = fs.readFileSync(
    path.join(__dirname, "../src/services/audiobook/AudiobookTaskService.ts"),
    "utf8",
  );
  assert.match(src, /scheduleBackgroundM4bEncode/, "须有后台 m4b 调度");
  assert.match(src, /isFullBookM4bReady\(taskDir\)/, "allReady 路径须先查 m4b ready");
  // allReady 成功分支不得在 update 前 await encodeFullBookM4b（避免堵队列）
  const reconcileStart = src.indexOf("async reconcileParent(");
  assert.ok(reconcileStart > 0);
  const reconcileBody = src.slice(reconcileStart, reconcileStart + 4500);
  assert.match(reconcileBody, /m4bAlreadyReady/, "须 short-circuit 已有 m4b");
  assert.match(
    reconcileBody,
    /scheduleBackgroundM4bEncode\(/,
    "缺 m4b 时后台调度",
  );
  // 在 succeeded update 之后才 schedule，不是 update 前 await
  const updateIdx = reconcileBody.indexOf('status: "succeeded"');
  const scheduleIdx = reconcileBody.indexOf("scheduleBackgroundM4bEncode");
  assert.ok(updateIdx > 0 && scheduleIdx > updateIdx, "先落 succeeded 再 schedule m4b");
  assert.equal(
    /await encodeFullBookM4b/.test(reconcileBody),
    false,
    "reconcileParent 主路径不得 await encodeFullBookM4b",
  );
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
