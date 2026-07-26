/**
 * 有声书模块 review 修复回归（2026-07 全模块 review）。
 *
 * 覆盖：
 *  1. reconcileParent 两处终态写必须 CAS（updateMany + status in running/queued）——
 *     否则 cancelTask 落的 cancelled 会被迟到的子回调覆写成 succeeded/failed
 *  2. resumePendingTasks / resumeTask / markPendingTasksForManualRecovery 不得抹除 cancelRequestedAt
 *  3. watchdog 翻 fail 续生成子任务后必须 finalizeContinueChild 收口父
 *  4. continueParentTask 先 CAS 抢占父再做破坏性 wipe / 建子
 *  5. appendFailedContinueChapters 乐观 CAS 防 progressJson 丢更新
 *  6. PatrolAgent P2 读 annotationsJson 真源（parseAnnotations 纯函数）+ P3 尊重 outputDir
 *
 * DB 层行为依赖真 audiobookTask 表，记 Manual-required；此处用 source-contract
 * （对齐 audiobookContinueTask.test.js 既有风格）锁住关键代码形态 + dist 纯函数测。
 */
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const taskServiceSrc = fs.readFileSync(
  path.join(__dirname, "../src/services/audiobook/AudiobookTaskService.ts"),
  "utf8",
);
const patrolSrc = fs.readFileSync(
  path.join(__dirname, "../src/services/audiobook/ops/agents/PatrolAgent.ts"),
  "utf8",
);

// ── 1. reconcileParent 终态写 CAS ──

test("reconcileParent: 不再有无 CAS 的 prisma.audiobookTask.update 终态写", () => {
  const start = taskServiceSrc.indexOf("async reconcileParent(");
  assert.ok(start > 0, "reconcileParent 必须存在");
  const end = taskServiceSrc.indexOf("\n  }", taskServiceSrc.indexOf("status: \"failed\"", start));
  const body = taskServiceSrc.slice(start, end);
  // 终态写必须走 updateMany（可带 CAS where），不允许裸 update
  assert.ok(
    !/prisma\.audiobookTask\.update\(/.test(body),
    "reconcileParent 内不得出现无 CAS 的 prisma.audiobookTask.update()",
  );
  // succeeded 与 failed 两个分支都要有 status in (running, queued) 的 CAS 谓词
  const casCount = (body.match(/status:\s*\{\s*in:\s*\["running",\s*"queued"\]\s*\}/g) || []).length;
  assert.ok(casCount >= 2, `reconcileParent 应有 ≥2 处 CAS 谓词，实际 ${casCount}`);
  // succeeded 分支 CAS 落空必须 return，不得继续调度后台 m4b
  assert.ok(
    /claimed\.count === 0/.test(body),
    "succeeded 分支必须检查 claimed.count 并在落空时返回",
  );
});

// ── 2. cancelRequestedAt 不被恢复路径抹除 ──

test("resumePendingTasks: 不清 cancelRequestedAt，且已请求取消的行走 markCancelledIfActive", () => {
  const start = taskServiceSrc.indexOf("async resumePendingTasks(");
  const end = taskServiceSrc.indexOf("async resumeTask(", start);
  const body = taskServiceSrc.slice(start, end);
  assert.ok(
    !/cancelRequestedAt:\s*null/.test(body),
    "resumePendingTasks 不得把 cancelRequestedAt 清空（会复活用户取消过的任务）",
  );
  assert.ok(
    /markCancelledIfActive/.test(body),
    "已请求取消的行应替执行器 ack 落 cancelled",
  );
  // 孤儿 continuing 父收口：无活子时 reconcile + force terminal
  assert.ok(
    /countLiveContinueChildren/.test(body) && /forceContinueParentTerminal/.test(body),
    "无活子的 continuing 父必须被收口（reconcile + forceContinueParentTerminal）",
  );
  // reconcileParent 必须有自己的 catch，否则它抛错时 forceContinueParentTerminal 被跳过，
  // 兜底形同虚设（兜底存在的唯一理由就是接住 reconcile 抛错）
  const reconcileIdx = body.indexOf("this.reconcileParent(");
  const forceIdx = body.indexOf("this.forceContinueParentTerminal(");
  assert.ok(reconcileIdx > 0 && forceIdx > reconcileIdx, "force 兜底应排在 reconcile 之后");
  assert.ok(
    /catch\s*\(reconcileError\)/.test(body.slice(reconcileIdx, forceIdx)),
    "reconcileParent 与 forceContinueParentTerminal 之间必须有独立 catch",
  );
});

test("resumeTask: 拒绝已请求取消 / continuing 父，且不清 cancelRequestedAt", () => {
  const start = taskServiceSrc.indexOf("async resumeTask(");
  const end = taskServiceSrc.indexOf("private removeFromQueue(", start);
  const body = taskServiceSrc.slice(start, end);
  assert.ok(
    !/cancelRequestedAt:\s*null/.test(body),
    "resumeTask 不得清 cancelRequestedAt",
  );
  assert.ok(
    /task\.cancelRequestedAt/.test(body),
    "resumeTask 必须检查 cancelRequestedAt 并拒绝",
  );
  assert.ok(
    /currentStage === "continuing"/.test(body),
    "resumeTask 必须拒绝 continuing 父（无自身流水线）",
  );
});

test("markPendingTasksForManualRecovery: where 排除已请求取消的行且不清 cancelRequestedAt", () => {
  const start = taskServiceSrc.indexOf("async markPendingTasksForManualRecovery(");
  const end = taskServiceSrc.indexOf("async resumePendingTasks(", start);
  const body = taskServiceSrc.slice(start, end);
  // data 块（不跨 {}）内不得出现 cancelRequestedAt——where 里的 cancelRequestedAt: null 过滤是合法的
  assert.ok(
    !/data:\s*\{[^{}]*cancelRequestedAt/.test(body),
    "markPendingTasksForManualRecovery 的 data 不得清 cancelRequestedAt",
  );
  assert.ok(
    /where:[\s\S]*?cancelRequestedAt:\s*null/.test(body),
    "查询与更新的 where 必须过滤 cancelRequestedAt=null",
  );
});

// ── 3. watchdog 翻 fail 子任务后收口父 ──

test("runWatchdogTick: markFailedIfRunning 命中后对续生成子调 finalizeContinueChild", () => {
  const start = taskServiceSrc.indexOf("private async runWatchdogTick(");
  const body = taskServiceSrc.slice(start);
  assert.ok(
    /readParentTaskIdFromProgress\(row\.progressJson\)/.test(body),
    "watchdog 必须识别续生成子任务",
  );
  assert.ok(
    /finalizeContinueChild\(row\.id,\s*true\)/.test(body),
    "watchdog 翻 fail 子任务后必须 finalizeContinueChild 收口父，否则父永久卡 continuing",
  );
  // HIGH-3：翻 fail 只改 DB 行，pipeline 还活着（慢 TTS = 误判）。不 abort 则僵尸子
  // 继续往父目录写 wav，onProgress CAS 静默落空，成功路径 reconcileParent 命中 0 行，
  // 盘上真章永远反映不进父 progressJson。abort 必须排在收口父之前。
  const abortIdx = body.indexOf("this.activeControllers.get(row.id)?.abort()");
  const finalizeIdx = body.indexOf("finalizeContinueChild(row.id");
  assert.ok(abortIdx > 0, "watchdog 翻 fail 后必须 abort 该任务的 AbortController（防僵尸子）");
  assert.ok(abortIdx < finalizeIdx, "abort 必须排在 finalizeContinueChild 之前");
  // abort 只在 CAS 真命中时执行——否则会误杀已被 cancel/其它路径收走的任务
  assert.ok(
    body.indexOf("failedCount > 0") > 0 && body.indexOf("failedCount > 0") < abortIdx,
    "abort 必须在 failedCount > 0 分支内（CAS 落空说明这行不归 watchdog 管）",
  );
});

test("markFailedIfRunning 返回命中行数（watchdog 依据它决定是否收口父）", () => {
  const start = taskServiceSrc.indexOf("private async markFailedIfRunning(");
  const end = taskServiceSrc.indexOf("startWatchdog(", start);
  const body = taskServiceSrc.slice(start, end);
  assert.ok(/Promise<number>/.test(body), "markFailedIfRunning 应返回 Promise<number>");
  assert.ok(/return claimed\.count/.test(body), "应返回 claimed.count");
});

// ── 4. continueParentTask 先抢占后破坏 ──

test("continueParentTask: CAS 抢占父在 wipe/建子之前，落空即 409", () => {
  const start = taskServiceSrc.indexOf("async continueParentTask(");
  const end = taskServiceSrc.indexOf("async reconcileParent(", start);
  const body = taskServiceSrc.slice(start, end);

  const casIdx = body.indexOf('status: { in: ["succeeded", "failed"] }');
  const wipeIdx = body.indexOf("wipeChapterAudioArtifacts");
  const createIdx = body.indexOf("prisma.audiobookTask.create");
  assert.ok(casIdx > 0 && wipeIdx > 0 && createIdx > 0, "三个关键点都应存在");
  assert.ok(casIdx < wipeIdx, "CAS 抢占必须在破坏性 wipe 之前（双提交防双 wipe）");
  assert.ok(casIdx < createIdx, "CAS 抢占必须在建子之前（双提交防双子）");
  // wipe 必须在 create 之后：wipe 先跑则 create 失败时回滚把父放回 succeeded，
  // 声称全书可播而音频已删
  assert.ok(
    createIdx < wipeIdx,
    "破坏性 wipe 必须排在建子之后（回滚路径不得回滚到已被删的磁盘状态）",
  );
  // MEDIUM-3 fix: progress baseline 在 CAS 之前预算（listReadyChapterAudioIds - requestedIds），
  // 原「post-wipe 后算」断言不再适用——新断言：baseline 计算必须在 CAS 之前
  const readyIdx = body.indexOf("listReadyChapterAudioIds");
  assert.ok(readyIdx > 0 && readyIdx < casIdx, "progress baseline 必须在 CAS 之前预算");
  // 预算逻辑已抽成纯函数 computeContinueParentBaseline（数值行为见下方 dist 单测），
  // 这里只守调用点：必须在 CAS 之前算完，且把 wipe 语义如实传下去
  const baselineIdx = body.indexOf("computeContinueParentBaseline(");
  assert.ok(baselineIdx > 0 && baselineIdx < casIdx, "baseline 纯函数必须在 CAS 之前调用");
  assert.ok(
    /wipesRequested:\s*input\.mode === "resynthesize"/.test(body),
    "mode=resynthesize 才会 wipe 被点名章，baseline 必须据此扣减",
  );
  assert.ok(
    /claimedParent\.count === 0/.test(body),
    "抢占落空必须拒绝（409），不得继续",
  );
  assert.ok(
    /releaseParentOnFailure/.test(body),
    "建子失败必须回滚父状态，否则父卡 continuing 无人收口",
  );
});

// ── 5. appendFailedContinueChapters 乐观 CAS ──

test("appendFailedContinueChapters: updateMany where progressJson 原值 + 重试", () => {
  const start = taskServiceSrc.indexOf("async function appendFailedContinueChapters(");
  const end = taskServiceSrc.indexOf("type ChapterProgressEntry", start);
  const body = taskServiceSrc.slice(start, end);
  assert.ok(
    /progressJson:\s*parent\.progressJson/.test(body),
    "必须用读到的 progressJson 原值做 CAS 谓词",
  );
  assert.ok(/for\s*\(let attempt/.test(body), "CAS 落空必须重读重试");
  assert.ok(
    !/prisma\.audiobookTask\.update\(\s*\{\s*where:\s*\{\s*id:/.test(body),
    "不得裸 update（丢更新）",
  );
});

// ── 6. PatrolAgent P2/P3 ──

test("PatrolAgent P2: 从 annotationsJson 读 speakerUnresolved，不再读 progressJson.chapterAnnotations", () => {
  assert.ok(
    !/progress\.chapterAnnotations/.test(patrolSrc),
    "progressJson.chapterAnnotations 全仓无写入方，读它 = P2 恒不触发",
  );
  assert.ok(
    /annotationsJson/.test(patrolSrc),
    "P2 必须读 annotationsJson 列（AudiobookPipelineService 写回的真源）",
  );
});

test("PatrolAgent P3: 目录取址尊重 outputDir（续生成子 wav 落父目录）", () => {
  assert.ok(
    /task\.outputDir\?\.trim\(\)\s*\|\|\s*resolveAudiobookTaskDir/.test(patrolSrc),
    "P3 必须 outputDir 优先，否则续生成子任务全章假阳性",
  );
});

// ── dist 纯函数：parseAnnotations ──

const { parseAnnotations } = require("../dist/services/audiobook/ops/agents/PatrolAgent.js");

test("parseAnnotations: 标准 annotationsJson 解析为 chapterId→segments", () => {
  const json = JSON.stringify([
    {
      chapterId: "c1",
      segments: [{ speakerUnresolved: true }, { speakerUnresolved: false }],
    },
    { chapterId: "c2", segments: [] },
  ]);
  const map = parseAnnotations(json);
  assert.equal(map.size, 2);
  assert.equal(map.get("c1").some((s) => s.speakerUnresolved === true), true);
  assert.equal(map.get("c2").length, 0);
});

test("parseAnnotations: 坏 JSON / 非数组 / 空串安全降级为空 map", () => {
  assert.equal(parseAnnotations(null).size, 0);
  assert.equal(parseAnnotations("").size, 0);
  assert.equal(parseAnnotations("{not json").size, 0);
  assert.equal(parseAnnotations(JSON.stringify({ chapterId: "c1" })).size, 0);
  // 缺 chapterId 的条目跳过
  assert.equal(parseAnnotations(JSON.stringify([{ segments: [] }])).size, 0);
});

// ── dist 纯函数：computeContinueParentBaseline ──
//
// 上面第 4 组只能断言「baseline 在 CAS 之前算」这类代码形状；代码顺序对 ≠ 算出来的数对。
// 这一组把生产实测值固化下来，免得下次改动只能靠打生产、烧真 TTS 配额来验。

const {
  computeContinueParentBaseline,
} = require("../dist/services/audiobook/AudiobookTaskService.js");

test("computeContinueParentBaseline: 生产实测 2 章续 1 章 = 50", () => {
  // 2026-07-26 生产任务 cms1rikzm004rei9khfpad2a0：2 章父，resynthesize ch24，
  // 201 返回后第一拍快照 running@50。ready 2 − wipe 1 = 1/2。
  assert.equal(
    computeContinueParentBaseline({
      preWipeReadyIds: ["chA", "chB"],
      requestedIds: ["chB"],
      totalChapterCount: 2,
      wipesRequested: true,
    }),
    50,
  );
  // 同一批章但 mode≠resynthesize（补生成缺章）：ready 不扣减，2/2 → 上限 95
  assert.equal(
    computeContinueParentBaseline({
      preWipeReadyIds: ["chA", "chB"],
      requestedIds: ["chB"],
      totalChapterCount: 2,
      wipesRequested: false,
    }),
    95,
  );
});

test("computeContinueParentBaseline: floor 2 —— 父在跑，进度条不得看着像没启动", () => {
  // 单章书重做唯一那章：ready 清零 → 0% 会被前端读成「没启动」
  assert.equal(
    computeContinueParentBaseline({
      preWipeReadyIds: ["chA"],
      requestedIds: ["chA"],
      totalChapterCount: 1,
      wipesRequested: true,
    }),
    2,
  );
  // 全书重做同理
  assert.equal(
    computeContinueParentBaseline({
      preWipeReadyIds: ["chA", "chB", "chC"],
      requestedIds: ["chA", "chB", "chC"],
      totalChapterCount: 3,
      wipesRequested: true,
    }),
    2,
  );
  // 读盘失败降级（preWipeReadyIds=[]）也落 floor，不抛
  assert.equal(
    computeContinueParentBaseline({
      preWipeReadyIds: [],
      requestedIds: ["chA"],
      totalChapterCount: 4,
      wipesRequested: true,
    }),
    2,
  );
  // totalChapterCount=0 不得除零/NaN
  assert.equal(
    computeContinueParentBaseline({
      preWipeReadyIds: [],
      requestedIds: [],
      totalChapterCount: 0,
      wipesRequested: true,
    }),
    2,
  );
});

test("computeContinueParentBaseline: 上限 95 —— 仍在跑就不能显示 100", () => {
  // 100 章只重做 1 章：99/100 → 99 会被裁到 95；真正的 100 只由 reconcileParent 落
  const ids = Array.from({ length: 100 }, (_, i) => `ch${i}`);
  assert.equal(
    computeContinueParentBaseline({
      preWipeReadyIds: ids,
      requestedIds: ["ch0"],
      totalChapterCount: 100,
      wipesRequested: true,
    }),
    95,
  );
});

test("computeContinueParentBaseline: requestedIds 不在 ready 集内不影响结果", () => {
  // 补生成从未产出过的章：ready 集里本就没有它们，扣减是 no-op
  assert.equal(
    computeContinueParentBaseline({
      preWipeReadyIds: ["chA", "chB"],
      requestedIds: ["chC", "chD"],
      totalChapterCount: 4,
      wipesRequested: true,
    }),
    50,
  );
});
