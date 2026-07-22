const { spawn } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const serverRoot = path.resolve(__dirname, "..");
const testsRoot = path.join(serverRoot, "tests");
const distRoot = path.join(serverRoot, "dist");

const integrationTests = new Set([
  "directorTaskFactInspection.test.js",
  "directorWorkflowStepModules.test.js",
  "dramaPipelineContract.test.js",
  "novelDirectorPipelineRuntime.test.js",
  "novelDirectorRetry.test.js",
  "novelWorkflowRuntime.test.js",
  "p0bRealPrismaChain.test.js",
  "prompting-governance.test.js",
  "prompting.test.js",
  "promptWorkbench.test.js",
  "ragCompatibilityBootstrap.test.js",
  "runtimeMigrations.test.js",
  // real sqlite + prisma:push — slow; not part of fast suite
  "taskRetentionRunOnce.test.js",
  "taskRetentionNullNovelOrphan.test.js",
  "novelDeleteCascade.test.js",
]);

function listTestFiles(directory) {
  return fs.readdirSync(directory, { withFileTypes: true })
    .flatMap((entry) => {
      const fullPath = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        return listTestFiles(fullPath);
      }
      return entry.isFile() && entry.name.endsWith(".test.js") ? [fullPath] : [];
    })
    .sort((left, right) => left.localeCompare(right));
}

function selectTestFiles(mode) {
  const allFiles = listTestFiles(testsRoot);
  if (mode === "integration") {
    return allFiles.filter((file) => integrationTests.has(path.basename(file)));
  }
  if (mode === "fast") {
    return allFiles.filter((file) => !integrationTests.has(path.basename(file)));
  }
  if (mode === "all") {
    return allFiles;
  }
  throw new Error(`Unknown test mode: ${mode}`);
}

/**
 * 防陈旧 dist 假失败：若对应 dist 下 .js 落后于 src .ts，拒绝开跑。
 * 跳过：SKIP_DIST_FRESHNESS=1 或 --skip-dist-check。
 * 不用单一 dist/app.js 作锚点——tsc incremental 可能不触碰它。
 */
function assertDistFreshness() {
  if (process.env.SKIP_DIST_FRESHNESS === "1" || process.argv.includes("--skip-dist-check")) {
    return;
  }
  if (!fs.existsSync(distRoot)) {
    console.error(
      "[run-tests] dist/ 不存在。请先：pnpm --filter @ai-novel/shared build && pnpm run build",
    );
    process.exit(1);
  }
  const srcRoot = path.join(serverRoot, "src");
  const stale = [];
  function walk(dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
        continue;
      }
      if (!entry.name.endsWith(".ts") || entry.name.endsWith(".d.ts")) {
        continue;
      }
      const rel = path.relative(srcRoot, full);
      const distJs = path.join(distRoot, rel.replace(/\.ts$/, ".js"));
      if (!fs.existsSync(distJs)) {
        continue;
      }
      const srcM = fs.statSync(full).mtimeMs;
      const distM = fs.statSync(distJs).mtimeMs;
      if (srcM > distM + 1000) {
        stale.push(path.relative(serverRoot, full));
      }
    }
  }
  walk(srcRoot);
  if (!fs.existsSync(path.join(distRoot, "app.js"))) {
    console.error(
      "[run-tests] dist/app.js 缺失。请先：pnpm --filter @ai-novel/shared build && pnpm run build",
    );
    process.exit(1);
  }
  if (stale.length > 0) {
    const sample = stale.slice(0, 8).join("\n  ");
    console.error(
      `[run-tests] dist 不新鲜（${stale.length} 个 src 新于对应 dist .js）。\n`
        + "  直接跑陈旧 dist 会产生假失败。请先：\n"
        + "    pnpm --filter @ai-novel/shared build && pnpm run build\n"
        + "  或临时跳过：SKIP_DIST_FRESHNESS=1 / --skip-dist-check\n"
        + `  示例：\n  ${sample}${stale.length > 8 ? "\n  ..." : ""}`,
    );
    process.exit(1);
  }
}

const mode = process.argv[2] ?? "fast";
const files = selectTestFiles(mode);

if (files.length === 0) {
  console.error(`No tests selected for mode ${mode}.`);
  process.exit(1);
}

assertDistFreshness();

// process isolation 防跨测试污染；none 仅用于 integration / 显式 TEST_ISOLATION=none。
const isolation = process.env.TEST_ISOLATION
  ?? (mode === "fast" ? "process" : "none");
const concurrencyRaw = process.env.TEST_CONCURRENCY;
const concurrency = concurrencyRaw
  ? Math.max(1, Number.parseInt(concurrencyRaw, 10) || 1)
  : Math.min(Math.max(os.cpus().length || 2, 2), 8);
// 单文件超时（秒）；open-handle 挂死靠 force-exit + kill 兜底
const fileTimeoutMs = Math.max(
  5_000,
  (Number.parseInt(process.env.TEST_FILE_TIMEOUT_MS || "120000", 10) || 120_000),
);

function runOneFile(file) {
  return new Promise((resolve) => {
    const nodeArgs = ["--test", "--test-force-exit"];
    if (isolation === "process") {
      // 单文件仍声明 isolation，避免文件内子测试共享污染；但每次只传 1 个文件，
      // 杜绝 300+ 文件一次 argv + process isolation 挂死。
      nodeArgs.push("--test-isolation=process");
      nodeArgs.push("--test-concurrency=1");
    }
    nodeArgs.push(file);
    const child = spawn(process.execPath, nodeArgs, {
      cwd: serverRoot,
      stdio: "inherit",
      env: process.env,
    });
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) {
        return;
      }
      settled = true;
      console.error(
        `[run-tests] TIMEOUT ${path.relative(serverRoot, file)} after ${fileTimeoutMs}ms — killing`,
      );
      try {
        child.kill("SIGKILL");
      } catch {
        // ignore
      }
      resolve({ file, code: 124 });
    }, fileTimeoutMs);
    child.on("error", (err) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      console.error(`[run-tests] spawn error ${path.relative(serverRoot, file)}: ${err.message}`);
      resolve({ file, code: 1 });
    });
    child.on("exit", (code, signal) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      const exitCode = signal ? 1 : (code ?? 1);
      resolve({ file, code: exitCode });
    });
  });
}

/**
 * 有界并发池：同时最多 concurrency 个单文件 node --test。
 * 比「一次 spawn 塞 24/309 文件」稳——挂死最多拖一个文件，由 fileTimeout 杀。
 */
async function runPool(allFiles) {
  console.error(
    `[run-tests] mode=${mode} files=${allFiles.length} isolation=${isolation} concurrency=${concurrency} fileTimeoutMs=${fileTimeoutMs}`,
  );
  let next = 0;
  let failed = 0;
  let passed = 0;
  let timedOut = 0;
  const failures = [];

  async function worker() {
    while (true) {
      const i = next;
      next += 1;
      if (i >= allFiles.length) {
        return;
      }
      const file = allFiles[i];
      const rel = path.relative(serverRoot, file);
      const result = await runOneFile(file);
      if (result.code === 0) {
        passed += 1;
      } else {
        failed += 1;
        if (result.code === 124) {
          timedOut += 1;
        }
        failures.push({ file: rel, code: result.code });
        console.error(`[run-tests] FAIL ${rel} (exit=${result.code})`);
      }
      if ((i + 1) % 25 === 0 || i + 1 === allFiles.length) {
        console.error(
          `[run-tests] progress ${Math.min(i + 1, allFiles.length)}/${allFiles.length} pass=${passed} fail=${failed}`,
        );
      }
    }
  }

  const workers = Array.from({ length: Math.min(concurrency, allFiles.length) }, () => worker());
  await Promise.all(workers);

  console.error(
    `[run-tests] done pass=${passed} fail=${failed} timeout=${timedOut} total=${allFiles.length}`,
  );
  if (failures.length > 0) {
    console.error("[run-tests] failures:");
    for (const f of failures) {
      console.error(`  ${f.code}\t${f.file}`);
    }
  }
  return failed > 0 ? 1 : 0;
}

if (isolation === "none") {
  // 兼容 integration：单次聚合（旧行为），无 isolation
  const { spawnSync } = require("node:child_process");
  const result = spawnSync(process.execPath, ["--test", ...files], {
    cwd: serverRoot,
    stdio: "inherit",
    env: process.env,
  });
  process.exit(result.status ?? 1);
}

runPool(files).then((code) => process.exit(code));
