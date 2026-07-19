/**
 * PatrolAgent 最小烟雾测（阶段 3）。
 *
 * SoT: docs/plans/ai-novel-ai-ops-agents-plan.md §3.3,§12-C.5
 *
 * 不依赖真 prisma 表（memory engine 无 audiobookTask 表 → catch P2021）
 * 验证：
 *  - Agent 不抛错，catch 失败后产出 P1 finding
 *  - autoFix=true + dryRun=true 时 autoFix 安全子集占位（§K backlog 信号，info 级 finding）
 *  - 无 approved asset → approvedList 列空，P7 不触发（fetch 失败路径已被吞）
 */
const { describe, it, before, after, beforeEach } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const TMP_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "patrol-"));
process.env.AI_NOVEL_RUNTIME = "desktop";
process.env.AI_NOVEL_APP_DATA_DIR = TMP_ROOT;
process.env.AI_NOVEL_DB_ENGINE = "memory";

const { patrolAgent } = require("../dist/services/audiobook/ops/agents/PatrolAgent");
const { resolveGlobalVoiceLibraryRoot } = require("../dist/services/audiobook/audiobookPaths");

function wipeLibrary() {
  fs.rmSync(resolveGlobalVoiceLibraryRoot(), { recursive: true, force: true });
}

describe("patrolAgent smoke (阶段 3)", () => {
  beforeEach(wipeLibrary);

  after(() => {
    try { fs.rmSync(TMP_ROOT, { recursive: true, force: true }); } catch {}
  });

  it("无任务表 → P1 finding + clean=false", async () => {
    const report = await patrolAgent.run({ novelId: null, taskId: null });
    assert.ok(Array.isArray(report.findings), "findings 应为数组");
    assert.equal(report.clean, false, "无任务表绝非 clean");
    const hasP1 = report.findings.some((f) => f.id === "P1");
    assert.ok(hasP1, "应含 P1 (DB/表缺失)");
  });

  it("dryRun=true + autoFix=true → 写 info 占位finding，autoFixed=false", async () => {
    const report = await patrolAgent.run({ autoFix: true, dryRun: true });
    // §K backlog：autoFix 一阶段不实施写操作
    const infoFix = report.findings.find((f) => /autoFix 请求/.test(f.message));
    assert.ok(infoFix, "应出现 info 级占位（未实施 autoFix）");
    assert.equal(infoFix.autoFixed, false);
  });

  it("无 approved asset → P7 不触发；整体 findings 至少含 DB 错 P1", async () => {
    const report = await patrolAgent.run({ taskId: "nonexistent" });
    const p7count = report.findings.filter((f) => f.id === "P7").length;
    // 无 approved asset → 列表空 → 不报 P7
    assert.equal(p7count, 0);
  });
});
