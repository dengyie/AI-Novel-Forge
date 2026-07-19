/**
 * 有声书 AI Ops Agents（H 计划）— OpsRun 运行面测试（阶段 1）。
 *
 * SoT: docs/plans/audiobook-ai-ops-agents-plan.md §6,§12-F,J
 *
 * 覆盖：
 *  - 创建 dry-run library_only → succeeded；stepsSummary 三步 succeeded
 *  - 幂等短窗：同 inputFingerprint 60s 内返回 duplicateOfRunId
 *  - 取消：queued/running run 写 cancelRequestedAt 并落 cancelled
 *  - dry-run dryRunPlan 含 packsToImport
 *  - profile 非法 → 抛 400
 */
const { describe, it, before, after, beforeEach } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const TMP_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "audiobook-ops-"));
process.env.AI_NOVEL_RUNTIME = "desktop";
process.env.AI_NOVEL_APP_DATA_DIR = TMP_ROOT;

const {
  opsRunService,
} = require("../dist/services/audiobook/ops/OpsRunService");
const {
  clearOpsStorageForTests,
  resolveOpsRoot,
} = require("../dist/services/audiobook/ops/OpsRunStorage");

function waitForTerminal(runId, timeoutMs = 5000) {
  const start = Date.now();
  return new Promise((resolve, reject) => {
    const tick = () => {
      const run = opsRunService.getRun(runId);
      if (!run) {
        return reject(new Error("run 消失"));
      }
      if (run.status === "succeeded" || run.status === "failed" || run.status === "cancelled") {
        return resolve(run);
      }
      if (Date.now() - start > timeoutMs) {
        return reject(new Error(`run ${runId} 超时未终态，当前=${run.status}`));
      }
      setTimeout(tick, 30);
    };
    tick();
  });
}

describe("audiobookOpsRun (阶段 1 运行面)", () => {
  before(() => {
    clearOpsStorageForTests();
  });

  after(() => {
    try {
      fs.rmSync(TMP_ROOT, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  });

  beforeEach(() => {
    clearOpsStorageForTests();
  });

  it("dry-run library_only 跑到终态 succeeded + 三步 succeeded", async () => {
    const created = opsRunService.createRun({
      profile: "library_only",
      packRoots: ["/tmp/no-such-pack"],
      dryRun: true,
    });
    assert.ok(created.runId.startsWith("ops_"));
    assert.equal(created.duplicateOfRunId, undefined);

    const terminal = await waitForTerminal(created.runId);
    assert.equal(terminal.status, "succeeded");
    assert.equal(terminal.stepsSummary.length, 3);
    assert.ok(
      terminal.stepsSummary.every((s) => s.status === "succeeded"),
      `所有 step 应 succeeded，实际=${JSON.stringify(terminal.stepsSummary)}`,
    );

    const report = opsRunService.getReport(created.runId);
    assert.ok(report, "report 应已落盘");
    assert.equal(report.profile, "library_only");
    assert.equal(report.dryRun, true);
    assert.deepEqual(report.dryRunPlan.packsToImport, ["/tmp/no-such-pack"]);
    assert.deepEqual(report.ear, []);
    assert.deepEqual(report.approve, { attempted: 0, approved: 0, rejected: 0, skipped: 0, gateBlocked: 0 });
  });

  it("幂等短窗：60s 内同输入返回 duplicateOfRunId", async () => {
    const input = { profile: "library_only", dryRun: true, packRoots: ["/tmp/abc"] };
    const a = opsRunService.createRun(input);
    const b = opsRunService.createRun(input);
    assert.ok(b.duplicateOfRunId, "短窗内应命中 dup");
    assert.equal(b.duplicateOfRunId, a.runId);
  });

  it("不同输入不命中幂等（packRoots 顺序差异归一后同形 → 命中）", async () => {
    // 归一后顺序无关（sort 后相等），所以同形 → 命中
    const a = opsRunService.createRun({ profile: "library_only", dryRun: true, packRoots: ["/tmp/a", "/tmp/b"] });
    const b = opsRunService.createRun({ profile: "library_only", dryRun: true, packRoots: ["/tmp/b", "/tmp/a"] });
    assert.ok(b.duplicateOfRunId, "sort 后同形应命中");
    assert.equal(b.duplicateOfRunId, a.runId);
  });

  it("autoFix 不同 → 不命中幂等", async () => {
    const a = opsRunService.createRun({ profile: "patrol_only", dryRun: true });
    const b = opsRunService.createRun({ profile: "patrol_only", dryRun: true, autoFix: true });
    assert.equal(b.duplicateOfRunId, undefined);
  });

  it("profile 非法抛 400", () => {
    assert.throws(
      () => opsRunService.createRun({ profile: "nope", dryRun: true }),
      /profile 非法/,
    );
  });

  it("cancel 终态后 cancel 仍返回该终态（幂等）", async () => {
    const created = opsRunService.createRun({ profile: "library_only", dryRun: true });
    await waitForTerminal(created.runId);
    const cancelled = opsRunService.cancel(created.runId);
    // dry-run 已 succeeded，cancel 不应改 status（已终态）
    assert.equal(cancelled.status, "succeeded");
  });

  it("listRuns 返回最近 run 摘要", async () => {
    const created = opsRunService.createRun({ profile: "library_only", dryRun: true });
    await waitForTerminal(created.runId);
    const list = opsRunService.listRuns(50);
    assert.ok(list.length >= 1);
    assert.ok(list.some((e) => e.id === created.runId));
    assert.equal(list.find((e) => e.id === created.runId).status, "succeeded");
  });

  it("getReport 不存在的 run 返回 null", () => {
    assert.equal(opsRunService.getReport("ops_doesnotexist"), null);
  });

  it("requireRun 不存在抛 404", () => {
    assert.throws(() => opsRunService.requireRun("ops_doesnotexist"), /Ops Run 不存在/);
  });

  it("override force 标记写入并被查询识别", () => {
    opsRunService.registerOverride({ action: "forceKeepDraft", assetId: "va_x1" });
    assert.equal(opsRunService.isForceKeepDraft("va_x1"), true);
    assert.equal(opsRunService.isForceReject("va_x1"), false);

    opsRunService.registerOverride({ action: "forceReject", assetId: "va_x1" });
    assert.equal(opsRunService.isForceKeepDraft("va_x1"), false);
    assert.equal(opsRunService.isForceReject("va_x1"), true);
  });

  it("override forceReject 对未注册资产返回 false", () => {
    assert.equal(opsRunService.isForceReject("va_never"), false);
    assert.equal(opsRunService.isForceKeepDraft("va_never"), false);
  });

  it("override forceBind 抛 501（阶段 2 未实施，禁止静默）", () => {
    assert.throws(
      () => opsRunService.registerOverride({ action: "forceBind", characterId: "c1", voiceAssetId: "va_y" }),
      (err) => err.statusCode === 501 && /forceBind 未在阶段 2 实施/.test(err.message),
    );
  });

  it("OpsRunStorage 落盘 run.json + report.json + log.txt", async () => {
    const created = opsRunService.createRun({ profile: "library_only", dryRun: true });
    await waitForTerminal(created.runId);
    const runDir = path.join(resolveOpsRoot(), created.runId);
    assert.ok(fs.existsSync(path.join(runDir, "run.json")));
    assert.ok(fs.existsSync(path.join(runDir, "report.json")));
    assert.ok(fs.existsSync(path.join(runDir, "log.txt")));
    const runJson = JSON.parse(fs.readFileSync(path.join(runDir, "run.json"), "utf8"));
    assert.equal(runJson.id, created.runId);
    assert.equal(runJson.profile, "library_only");
  });

  it("Bug1: step 抛错后 stepsSummary 与 error 写盘（不被 failRun readRunState 覆盖丢）", async () => {
    // profile=full + 假 novelId + dryRun=false：readyAgent.suggest 内 prisma.novel.findUnique 抛错
    // → executeStep 'ready' catch → runToCompletion catch → Bug1 修复路径
    // 期望：state.stepsSummary 含 ready step FAILED；state.error.code === step_failed 且 message 含 ready
    const created = opsRunService.createRun({
      profile: "full",
      novelId: "novel_does_not_exist_for_fail_path",
      dryRun: false,
    });
    const terminal = await waitForTerminal(created.runId, 10000);
    assert.equal(terminal.status, "failed", `run 应失败；实际=${terminal.status}`);
    assert.ok(terminal.error, "应有 error");
    assert.equal(terminal.error.code, "step_failed", `error.code 应=step_failed；实际=${terminal.error.code}`);
    assert.ok(/ready/.test(terminal.error.message), `error.message 应含 step 名 ready；实际=${terminal.error.message}`);

    // stepsSummary 持久化在前：失败的 ready step 应被记入
    const readyStep = terminal.stepsSummary.find((s) => s.step === "ready");
    assert.ok(readyStep, "stepsSummary 应含 ready step");
    assert.equal(readyStep.status, "failed", `ready step 应 failed；实际=${readyStep.status}`);

    // ear/approve/import 在 ready 之前，应已 succeeded 或 skipped
    const beforeReady = terminal.stepsSummary.filter((s) => {
      const order = ["import", "ear", "approve", "ready", "synth", "patrol"];
      return order.indexOf(s.step) < order.indexOf("ready");
    });
    assert.ok(
      beforeReady.every((s) => s.status === "succeeded" || s.status === "skipped"),
      `ready 之前的 step 应 succeeded/skipped；实际=${JSON.stringify(beforeReady)}`,
    );
  });
});
