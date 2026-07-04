const { execFileSync } = require("child_process");
const path = require("path");

const repoRoot = path.resolve(__dirname, "..", "..").toLowerCase();
const currentPid = process.pid;
const parentPid = process.ppid;
// posix 进程组 kill 必须排除自身所在的进程组，否则会 SIGTERM 自己和整个 dev:api 启动链。
// Node 没有 process.getpgid API，下面 readPosixNodeProcesses 会从 ps 表里查自身 pid 对应
// 的 pgid 回填到 currentPgid（main 调用时再解析）。
let currentPgid = null;
const optOut = String(process.env.AI_NOVEL_SKIP_DEV_SINGLETON || "").trim();
const powershellPath = process.env.SystemRoot
  ? path.join(process.env.SystemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe")
  : "powershell.exe";

function normalizeCommandLine(value) {
  return String(value || "").toLowerCase().replace(/\\/g, "/");
}

function isTargetProcess(processInfo) {
  if (!processInfo) {
    return false;
  }
  const pid = Number(processInfo.ProcessId);
  const processParentPid = Number(processInfo.ParentProcessId);
  if (pid === currentPid || pid === parentPid || processParentPid === currentPid || processParentPid === parentPid) {
    return false;
  }

  const commandLine = normalizeCommandLine(processInfo.CommandLine);
  if (!commandLine.includes(repoRoot.replace(/\\/g, "/"))) {
    return false;
  }

  return (
    commandLine.includes("ts-node-dev")
    && commandLine.includes("src/app.ts")
  );
}

function readWindowsNodeProcesses() {
  const command = [
    "$ErrorActionPreference = 'Stop';",
    "Get-CimInstance Win32_Process -Filter \"name = 'node.exe'\"",
    "| Select-Object ProcessId,ParentProcessId,CommandLine",
    "| ConvertTo-Json -Compress",
  ].join(" ");

  const output = execFileSync(
    powershellPath,
    ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", command],
    { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
  ).trim();

  if (!output) {
    return [];
  }

  const parsed = JSON.parse(output);
  return Array.isArray(parsed) ? parsed : [parsed];
}

function stopWindowsProcesses(processes) {
  const targetIds = processes
    .filter(isTargetProcess)
    .map((item) => Number(item.ProcessId))
    .filter((pid) => Number.isInteger(pid) && pid > 0);

  if (targetIds.length === 0) {
    return 0;
  }

  const quotedIds = targetIds.join(",");
  execFileSync(
    powershellPath,
    [
      "-NoProfile",
      "-ExecutionPolicy",
      "Bypass",
      "-Command",
      `Stop-Process -Id ${quotedIds} -Force -ErrorAction SilentlyContinue`,
    ],
    { stdio: "ignore" },
  );

  return targetIds.length;
}

// macOS/Linux 分支：ps 列 pid/ppid/pgid/command，按 repoRoot+ts-node-dev+src/app.ts
// 命中僵尸，kill 整进程组（负 PID）连带 pnpm 根，避免 --respawn 死循环把子进程杀了
// 又被父进程立刻拉起。Win 分支只 Stop-Process 单 PID，posix 必须整组才彻底。
function readPosixNodeProcesses() {
  const output = execFileSync("ps", ["-eo", "pid,ppid,pgid,command"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });

  const lines = String(output || "").split("\n");
  lines.shift(); // 表头
  const rows = [];
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    // pid/ppid/pgid 三段数值后接一个空格，剩下的整段是 command（含空格）
    const match = trimmed.match(/^(\d+)\s+(\d+)\s+(\d+)\s+(.*)$/);
    if (!match) continue;
    rows.push({
      ProcessId: Number(match[1]),
      ParentProcessId: Number(match[2]),
      ProcessGroupId: Number(match[3]),
      CommandLine: match[4],
    });
  }
  return rows;
}

function stopPosixProcesses(processes) {
  const targets = processes
    .filter(isTargetProcess)
    .map((item) => ({
      pid: Number(item.ProcessId),
      pgid: Number(item.ProcessGroupId),
    }))
    .filter((t) => Number.isInteger(t.pid) && t.pid > 0 && Number.isInteger(t.pgid));

  // 去重 pgid，杀整组。跳过 pgid<=0（守护进程/孤儿组）和 pgid===自身（误杀自己）
  // —— 自身组里 pnpm 根的 `pnpm dev` 是这次启动的发起者，不能杀。
  const groupIds = new Set();
  for (const t of targets) {
    if (t.pgid > 0 && t.pgid !== currentPgid) {
      groupIds.add(t.pgid);
    }
  }
  if (groupIds.size === 0) {
    return 0;
  }

  let stopped = 0;
  for (const pgid of groupIds) {
    try {
      process.kill(-pgid, "SIGTERM");
      stopped += 1;
    } catch (error) {
      // ESRCH 进程组已退出；EACCES 无权限——都静默，不阻断本次 dev 启动
      if (error && error.code !== "ESRCH" && error.code !== "EACCES") {
        throw error;
      }
    }
  }
  return stopped;
}

function main() {
  if (optOut === "1" || optOut.toLowerCase() === "true") {
    return;
  }

  try {
    const processes = process.platform === "win32"
      ? readWindowsNodeProcesses()
      : readPosixNodeProcesses();
    if (process.platform !== "win32") {
      // 解析自身 pgid：Node 无 process.getpgid，从 ps 表里找 ProcessId===currentPid 的行。
      const selfRow = processes.find((p) => Number(p.ProcessId) === currentPid)
        || processes.find((p) => Number(p.ProcessGroupId) > 0 && Number(p.ParentProcessId) === parentPid);
      if (selfRow && Number.isFinite(Number(selfRow.ProcessGroupId))) {
        currentPgid = Number(selfRow.ProcessGroupId);
      }
    }
    const stoppedCount = process.platform === "win32"
      ? stopWindowsProcesses(processes)
      : stopPosixProcesses(processes);
    if (stoppedCount > 0) {
      console.log(`[dev-server] stopped ${stoppedCount} stale server dev process group(s).`);
    }
  } catch (error) {
    console.warn(`[dev-server] skipped stale process cleanup: ${error.message}`);
  }
}

main();
