#!/usr/bin/env node
/**
 * review-chapter.cjs — 对指定章节跑 true-review 收口的可复用 CLI。
 *
 * 用法：
 *   node scripts/review-chapter.cjs <novelId> <chapterId> [options]
 *
 * 选项：
 *   --host <addr>     server 地址（默认 127.0.0.1）
 *   --port <num>      server 端口（优先 CLI arg，其次 $PORT 环境变量，默认 3001）
 *   --no-wait         只发 POST 不轮询 DB（默认会轮询等结果）
 *   --db <path>       DB 路径（默认 /data/ainovel/app/ai-novel/server/dev.db）
 *   --timeout <sec>   等待 review 落库的超时秒数（默认 300）
 *
 * 示例：
 *   node scripts/review-chapter.cjs cmsf6nvcs00ccfu9kiqze9agf cmsf8ray80242fu9ko3btthgu
 *   node scripts/review-chapter.cjs <novelId> <chapterId> --host 127.0.0.1 --port 3001 --no-wait
 *
 * 背景：
 *   - review 是同步 HTTP 但实际是长 LLM 任务（约 3 分钟），结果异步写入 DB。
 *   - 必须直连 server，不能走代理（Privoxy 会 503）。Node 原生 http 天然不走代理。
 *   - auth open 免 token（生产 env 无 API_AUTH_TOKEN）。
 */
"use strict";

const http = require("http");
const path = require("path");

// ── 解析参数 ──────────────────────────────────────────────
const argv = process.argv.slice(2);
if (argv.length < 2) {
  console.error("用法: node scripts/review-chapter.cjs <novelId> <chapterId> [options]");
  process.exit(1);
}
const novelId = argv[0];
const chapterId = argv[1];

let host = "127.0.0.1";
let port;
let portSource = "default";
let wait = true;
let dbPath = "/data/ainovel/app/ai-novel/server/dev.db";
let timeoutSec = 300;

for (let i = 2; i < argv.length; i++) {
  const a = argv[i];
  if (a === "--host") host = argv[++i];
  else if (a === "--port") { port = parseInt(argv[++i], 10); portSource = "cli-arg"; }
  else if (a === "--no-wait") wait = false;
  else if (a === "--db") dbPath = argv[++i];
  else if (a === "--timeout") timeoutSec = parseInt(argv[++i], 10);
  else { console.error(`未知参数: ${a}`); process.exit(1); }
}

// 端口解析优先级：--port CLI arg > $PORT 环境变量（存在且为数字端口）> 默认 3001。
if (port === undefined) {
  const envPort = Number(process.env.PORT);
  if (process.env.PORT !== undefined && Number.isInteger(envPort) && envPort > 0 && envPort <= 65535) {
    port = envPort;
    portSource = "PORT-env";
  } else {
    port = 3001;
    portSource = "default";
  }
}

// ── 发送 review POST（原生 http，不走代理） ────────────────
function sendReview() {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({});
    const req = http.request(
      {
        hostname: host,
        port,
        path: `/api/novels/${novelId}/chapters/${chapterId}/review`,
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(body),
        },
      },
      (res) => {
        let data = "";
        res.on("data", (chunk) => (data += chunk));
        res.on("end", () => {
          resolve({ statusCode: res.statusCode, body: data });
        });
      },
    );
    req.on("error", reject);
    req.write(body);
    req.end();
  });
}

// ── 打开只读 sqlite（优先脚本旁 / server node_modules 的 better-sqlite3） ──
function openDb() {
  let Database;
  try {
    Database = require(path.resolve(
      path.dirname(dbPath),
      "node_modules/better-sqlite3/lib/database.js",
    ));
  } catch {
    // fallback: 尝试 server node_modules
    Database = require(path.resolve(
      path.dirname(require.main?.filename || __dirname),
      "../node_modules/better-sqlite3/lib/database.js",
    ));
  }
  return new Database(dbPath, { readonly: true });
}

// ── 读取章节当前快照（chapterStatus + generationState） ──
function readDbState() {
  let db;
  try {
    db = openDb();
  } catch (e) {
    throw new Error(`无法打开 DB（${dbPath}）: ${e.message}`);
  }
  try {
    const row = db
      .prepare("SELECT chapterStatus st, generationState gs FROM Chapter WHERE id=?")
      .get(chapterId);
    return row ? { chapterStatus: row.st, generationState: row.gs } : null;
  } finally {
    db.close();
  }
}

// ── 轮询 DB 等待 review 终态落库 ──────────────────────────
// before 必须在 POST /review 之前读取：POST 是同步全链路，响应返回时 DB 已写终态，
// 若 POST 返回后再读 before，会把终态当 baseline，`row !== before` 恒不成立 → 必走
// 300s 超时分支。拿到终态后轮询很快命中：状态相对 before 有变化，或已到 complete/needs_repair。
function pollDB(before) {
  const db = openDb();
  const start = Date.now();
  const intervalMs = 5000;

  return new Promise((resolve) => {
    const timer = setInterval(() => {
      const row = db
        .prepare("SELECT chapterStatus st, generationState gs FROM Chapter WHERE id=?")
        .get(chapterId);
      const elapsed = Math.round((Date.now() - start) / 1000);

      if (!row) {
        console.error(`[轮询] 章节 ${chapterId} 不存在`);
        clearInterval(timer);
        db.close();
        resolve({ error: "chapter not found" });
        return;
      }

      const changedFromBefore = row.st !== before.chapterStatus
        || row.gs !== before.generationState;
      const isTerminal = row.st === "completed" || row.st === "needs_repair";

      // 命中终态，或状态相对 POST 前基线有变化，即 review 判定已落库
      if (changedFromBefore || isTerminal) {
        console.log(`[轮询] 终态 (${elapsed}s): ${row.st}/${row.gs}`);
        clearInterval(timer);
        db.close();
        resolve({ status: row.st, generationState: row.gs, elapsedSec: elapsed });
        return;
      }

      if (elapsed >= timeoutSec) {
        console.log(`[轮询] 超时 ${timeoutSec}s，状态未变: ${row.st}/${row.gs}`);
        clearInterval(timer);
        db.close();
        resolve({ timeout: true, status: row.st, generationState: row.gs, elapsedSec: elapsed });
      }
    }, intervalMs);
  });
}

// ── 主流程 ────────────────────────────────────────────────
async function main() {
  console.log(`\n=== review-chapter CLI ===`);
  console.log(`novelId:   ${novelId}`);
  console.log(`chapterId: ${chapterId}`);
  console.log(`target:    http://${host}:${port}（端口来源: ${portSource}）`);
  console.log(`wait:      ${wait}`);

  // before 快照必须在 POST 之前落定（POST 同步返回时 DB 已写终态，见 pollDB 注释）。
  let before;
  try {
    before = readDbState();
  } catch (e) {
    console.error(`[错误] ${e.message}`);
    process.exit(1);
  }
  if (!before) {
    console.error(`[错误] 章节 ${chapterId} 不存在于数据库，无法 review。`);
    process.exit(1);
  }
  console.log(`\n[轮询] POST 前状态: ${before.chapterStatus}/${before.generationState}`);

  console.log(`\n[1/2] 发送 POST /review ...`);
  let resp;
  try {
    resp = await sendReview();
  } catch (e) {
    console.error(`[错误] 请求失败: ${e.message}`);
    console.error(`        确认 server 在 ${host}:${port} 运行 (ps aux | grep 'node dist/app.js')`);
    process.exit(1);
  }

  console.log(`  HTTP ${resp.statusCode}`);
  let parsed;
  try {
    parsed = JSON.parse(resp.body);
  } catch {
    console.log(`  响应非 JSON（前 200 字）: ${resp.body.slice(0, 200)}`);
  }

  if (parsed?.success) {
    const d = parsed.data;
    if (d?.score) {
      console.log(`  score: overall=${d.score.overall} coherence=${d.score.coherence} repetition=${d.score.repetition} pacing=${d.score.pacing} voice=${d.score.voice} engagement=${d.score.engagement}`);
    }
    if (d?.issues?.length) {
      console.log(`  issues (${d.issues.length}):`);
      for (const is of d.issues) {
        console.log(`    [${is.severity}/${is.category || is.code || "?"}] ${is.message || is.description || JSON.stringify(is).slice(0, 120)}`);
      }
    }
  } else {
    console.error(`  review 返回 success=false: ${resp.body.slice(0, 300)}`);
  }

  if (!wait) {
    console.log(`\n[完成] --no-wait 模式，请自行回探 DB 确认最终状态。`);
    process.exit(0);
  }

  console.log(`\n[2/2] 轮询 DB 等待终态落库（超时 ${timeoutSec}s）...`);
  const result = await pollDB(before);
  if (result?.status) {
    console.log(`\n=== 最终结果 ===`);
    console.log(`chapterStatus:    ${result.status}`);
    console.log(`generationState:  ${result.generationState}`);
    console.log(`耗时:             ${result.elapsedSec}s`);
    if (result.status === "completed") {
      console.log(`✅ 收口成功`);
    } else if (result.status === "needs_repair") {
      console.log(`⚠️  判定 needs_repair，请查看 issues 修复后重跑`);
    } else {
      console.log(`ℹ️  状态: ${result.status}`);
    }
  } else if (result?.timeout) {
    console.log(`\n⏱  轮询超时，review 可能仍在后台生成。稍后回探 DB。`);
  } else {
    console.log(`\n❌ 轮询失败: ${result?.error || "未知"}`);
  }
  process.exit(0);
}

main();
