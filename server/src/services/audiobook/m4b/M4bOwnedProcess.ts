import fs from "node:fs";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execute = promisify(execFile);

export interface OwnedM4bProcess { pid: number; partPath: string }

/** Only records received from a registered worker are accepted. Revalidate the
 * unique output argument immediately before signalling to exclude PID reuse.
 */
export async function stopOwnedM4bProcess(record: OwnedM4bProcess): Promise<void> {
  try {
    const command = process.platform === "win32"
      ? (await execute("powershell.exe", ["-NoProfile", "-Command",
        `(Get-CimInstance Win32_Process -Filter 'ProcessId = ${record.pid}').CommandLine`], { timeout: 2_000 })).stdout
      : (await execute("ps", ["-p", String(record.pid), "-o", "args="], { timeout: 2_000 })).stdout;
    if (!command.includes(record.partPath)) return;
    if (process.platform === "win32") {
      await execute("taskkill", ["/PID", String(record.pid), "/T", "/F"], { timeout: 2_000 });
    } else {
      process.kill(-record.pid, "SIGKILL");
    }
    const deadline = Date.now() + 2_000;
    let alive = true;
    while (Date.now() < deadline) {
      try { process.kill(process.platform === "win32" ? record.pid : -record.pid, 0); }
      catch { alive = false; break; }
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    if (alive) throw new Error("Owned M4b process group did not exit after termination");
    // Unique part belongs to this now-stopped attempt, never the canonical audio.
    fs.rmSync(record.partPath, { force: true });
  } catch (error) {
    // ps returns 1 for a process that already exited. Other failures must not
    // silently release the lease while the external encoder may still be alive.
    const code = (error as { code?: string | number }).code;
    if (code !== "ESRCH" && code !== 1) throw error;
  }
}
