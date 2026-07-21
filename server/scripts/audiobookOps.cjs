#!/usr/bin/env node
/**
 * audiobook:ops CLI 入口（H 计划 §12-H）。
 *
 *   pnpm --filter @ai-novel/server audiobook:ops -- run <profile> [--novel <id>] [--pack-root <path>...] [--auto-fix] [--dry-run]
 *   pnpm --filter @ai-novel/server audiobook:ops -- list [--limit N]
 *   pnpm --filter @ai-novel/server audiobook:ops -- show <runId> [--report]
 *   pnpm --filter @ai-novel/server audiobook:ops -- cancel <runId>
 *
 * 退出码：patrol_only 见 issues 时 exit 2；其余 0；参数错 64；内部错 70。
 */
const path = require("node:path");
const { opsRunService } = require("../dist/services/audiobook/ops/OpsRunService");

function parseArgs(argv) {
  const [cmd, ...rest] = argv;
  const opts = { extra: [] };
  for (let i = 0; i < rest.length; i += 1) {
    const arg = rest[i];
    const next = rest[i + 1];
    if (arg === "--novel") { opts.novelId = next; i += 1; continue; }
    if (arg === "--auto-fix") { opts.autoFix = true; continue; }
    if (arg === "--dry-run") { opts.dryRun = true; continue; }
    if (arg === "--pack-root") { (opts.packRoots ||= []).push(next); i += 1; continue; }
    if (arg === "--asset-id") { (opts.assetIds ||= []).push(next); i += 1; continue; }
    if (arg === "--limit") { opts.limit = Number(next); i += 1; continue; }
    if (arg === "--report") { opts.report = true; continue; }
    opts.extra.push(arg);
  }
  return { cmd, opts };
}

async function main() {
  const { cmd, opts } = parseArgs(process.argv.slice(2));

  if (cmd === "run") {
    const profile = opts.extra[0];
    if (!profile || !["full", "library_only", "patrol_only", "ear_auto", "library_ai_fill"].includes(profile)) {
      console.error("用法: audiobook:ops run <profile=full|library_only|patrol_only|ear_auto|library_ai_fill> [--novel <id>] [--pack-root <path>...] [--auto-fix] [--dry-run]");
      process.exit(64);
    }
    const created = opsRunService.createRun({
      profile,
      novelId: opts.novelId ?? null,
      packRoots: opts.packRoots ?? null,
      assetIds: opts.assetIds ?? null,
      autoFix: opts.autoFix === true,
      dryRun: opts.dryRun === true,
    });
    console.log(JSON.stringify(created, null, 2));
    if (created.duplicateOfRunId) {
      console.error(`(命中短窗去重，已有 run=${created.duplicateOfRunId})`);
      process.exit(0);
    }
    // 等待 run 完成（轮询 status）
    for (;;) {
      await new Promise((r) => setTimeout(r, 200));
      const run = opsRunService.getRun(created.runId);
      if (!run) { console.error("run 消失"); process.exit(70); }
      if (run.status === "succeeded" || run.status === "failed" || run.status === "cancelled") {
        console.log(JSON.stringify({ runId: run.id, status: run.status, finishedAt: run.finishedAt }, null, 2));
        const report = opsRunService.getReport(created.runId);
        if (report) console.log(JSON.stringify(report, null, 2));
        if (profile === "patrol_only" && report?.patrol && !report.patrol.clean) process.exit(2);
        process.exit(run.status === "failed" ? 70 : 0);
      }
    }
  }

  if (cmd === "list") {
    const data = opsRunService.listRuns(opts.limit ?? 50);
    console.log(JSON.stringify(data, null, 2));
    process.exit(0);
  }

  if (cmd === "show") {
    const runId = opts.extra[0];
    if (!runId) { console.error("缺少 runId"); process.exit(64); }
    const run = opsRunService.getRun(runId);
    if (!run) { console.error("Ops Run 不存在"); process.exit(64); }
    console.log(JSON.stringify(run, null, 2));
    if (opts.report) {
      const report = opsRunService.getReport(runId);
      console.log(JSON.stringify(report, null, 2));
    }
    process.exit(0);
  }

  if (cmd === "cancel") {
    const runId = opts.extra[0];
    if (!runId) { console.error("缺少 runId"); process.exit(64); }
    const run = opsRunService.cancel(runId);
    console.log(JSON.stringify(run, null, 2));
    process.exit(0);
  }

  console.error("用法: audiobook:ops run|list|show|cancel ...");
  process.exit(64);
}

main().catch((err) => {
  console.error(err?.stack || err?.message || String(err));
  process.exit(70);
});
