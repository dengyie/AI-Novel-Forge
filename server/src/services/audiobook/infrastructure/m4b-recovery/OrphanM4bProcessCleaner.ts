import * as childProcess from "node:child_process";

/**
 * 从一份 POSIX 进程表中选出正在写指定 taskDir m4b part 的 PPID=1 孤儿根进程。
 * 路径按完整目录段匹配，避免 task-1 误中 task-10；显式 ffmpeg wrapper 也视为入口。
 */
export function selectOrphanM4bPids(
  psOutput: string,
  taskDir: string,
  selfPid = process.pid,
  configuredFfmpegPath = process.env.AUDIOBOOK_FFMPEG_PATH?.trim()
    || process.env.FFMPEG_PATH?.trim()
    || null,
): number[] {
  const target = taskDir.trim().replace(/[\\/]+$/, "");
  if (!target) return [];
  const result: number[] = [];
  for (const line of psOutput.split("\n")) {
    const match = /^\s*(\d+)\s+(\d+)\s+(.+?)\s*$/.exec(line);
    if (!match) continue;
    const pid = Number(match[1]);
    const ppid = Number(match[2]);
    const command = match[3];
    if (!Number.isInteger(pid) || pid <= 0 || pid === selfPid || ppid !== 1) continue;
    const executable = command.split(/\s+/, 1)[0].split(/[\\/]/).pop() ?? "";
    const isConfiguredWrapper = Boolean(
      configuredFfmpegPath && command.includes(configuredFfmpegPath),
    );
    if (executable !== "ffmpeg" && !isConfiguredWrapper) continue;
    const targetsTaskDir = command.includes(`${target}/`) || command.includes(`${target}\\`);
    if (!targetsTaskDir || !command.includes("full-book.m4b") || !command.includes(".part")) continue;
    result.push(pid);
  }
  return result;
}
const ORPHAN_EXIT_WAIT_MS = 2_000;
const ORPHAN_EXIT_POLL_MS = 50;

/** 单轮启动恢复只抓一次进程表；Windows 无 POSIX ps，返回空快照并依赖代际 fence。 */
export async function captureOrphanM4bProcessSnapshot(): Promise<string | null> {
  if (process.platform === "win32") {
    console.warn(
      "[audiobook] orphan m4b process scan skipped on Windows; generation fencing remains active",
    );
    return "";
  }
  const { error, stdout } = await new Promise<{ error: Error | null; stdout: string }>((resolve) => {
    childProcess.execFile("ps", ["-axo", "pid=,ppid=,command="], { timeout: 5_000 }, (psError, psStdout) => {
      resolve({
        error: psError,
        stdout: typeof psStdout === "string" ? psStdout : String(psStdout ?? ""),
      });
    });
  });
  if (error) {
    console.warn("[audiobook] capture orphan m4b process snapshot failed", error.message);
    return null;
  }
  return stdout;
}

async function revalidatePid(
  pid: number,
  taskDir: string,
  configuredFfmpegPath: string | null,
): Promise<"match" | "mismatch" | "unknown"> {
  const { error, stdout } = await new Promise<{ error: Error | null; stdout: string }>((resolve) => {
    childProcess.execFile(
      "ps",
      ["-p", String(pid), "-o", "pid=,ppid=,command="],
      { timeout: 2_000 },
      (psError, psStdout) => {
        resolve({
          error: psError,
          stdout: typeof psStdout === "string" ? psStdout : String(psStdout ?? ""),
        });
      },
    );
  });
  if (!error) {
    return selectOrphanM4bPids(stdout, taskDir, process.pid, configuredFfmpegPath).includes(pid)
      ? "match"
      : "mismatch";
  }
  try {
    process.kill(pid, 0);
    return "unknown";
  } catch (probeError) {
    return (probeError as NodeJS.ErrnoException).code === "ESRCH" ? "mismatch" : "unknown";
  }
}

function signalProcessTree(pid: number): number | null {
  if (process.platform !== "win32") {
    try {
      // 新编码器的 pid 同时是独立进程组 id；杀组可连 wrapper 后代一起回收。
      process.kill(-pid, "SIGKILL");
      return -pid;
    } catch {
      // 兼容进程组隔离上线前的 legacy ffmpeg，回落到直接 PID。
    }
  }
  try {
    process.kill(pid, "SIGKILL");
    return pid;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ESRCH" ? null : pid;
  }
}

/**
 * 清理指定任务目录的孤儿编码器。复用快照时，SIGKILL 前仍逐 PID 重查身份，防 PID
 * 复用误杀；身份或退出无法确认时返回 false，让恢复域保持 degraded 而非盲目重启。
 */
export async function killOrphanM4bFfmpeg(
  taskDir: string,
  processSnapshot?: string | null,
): Promise<boolean> {
  const stdout = processSnapshot === undefined
    ? await captureOrphanM4bProcessSnapshot()
    : processSnapshot;
  if (stdout == null) {
    console.warn("[audiobook] killOrphanM4bFfmpeg ps 失败", taskDir);
    return false;
  }
  const configuredFfmpegPath = process.env.AUDIOBOOK_FFMPEG_PATH?.trim()
    || process.env.FFMPEG_PATH?.trim()
    || null;
  const pids = selectOrphanM4bPids(stdout, taskDir, process.pid, configuredFfmpegPath);
  const pendingTargets = new Map<number, number>();
  const verificationBlocked: number[] = [];
  for (const pid of pids) {
    const validation = await revalidatePid(pid, taskDir, configuredFfmpegPath);
    if (validation === "mismatch") continue;
    if (validation === "unknown") {
      verificationBlocked.push(pid);
      continue;
    }
    const signalTarget = signalProcessTree(pid);
    if (signalTarget != null) pendingTargets.set(signalTarget, pid);
  }
  if (pendingTargets.size === 0 && verificationBlocked.length === 0) return true;
  if (pendingTargets.size > 0) {
    console.warn(
      `[audiobook] 已请求清理 ${pendingTargets.size} 个孤儿 ffmpeg（写 ${taskDir} 的 m4b part）`,
      Array.from(pendingTargets.values()).join(","),
    );
  }
  if (verificationBlocked.length > 0) {
    console.warn("[audiobook] 孤儿 ffmpeg 身份复核失败，拒绝盲目 SIGKILL", {
      taskDir,
      pids: verificationBlocked,
    });
  }

  const deadline = Date.now() + ORPHAN_EXIT_WAIT_MS;
  while (pendingTargets.size > 0 && Date.now() < deadline) {
    for (const signalTarget of pendingTargets.keys()) {
      try {
        process.kill(signalTarget, 0);
      } catch (probeError) {
        if ((probeError as NodeJS.ErrnoException).code === "ESRCH") pendingTargets.delete(signalTarget);
      }
    }
    if (pendingTargets.size === 0) return verificationBlocked.length === 0;
    await new Promise((resolve) => setTimeout(
      resolve,
      Math.min(ORPHAN_EXIT_POLL_MS, Math.max(1, deadline - Date.now())),
    ));
  }

  if (pendingTargets.size > 0) {
    console.warn("[audiobook] 孤儿 ffmpeg 退出等待超时", {
      taskDir,
      timeoutMs: ORPHAN_EXIT_WAIT_MS,
      pids: Array.from(pendingTargets.values()),
    });
    return false;
  }
  return verificationBlocked.length === 0;
}
