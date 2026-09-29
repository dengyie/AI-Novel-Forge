import { waitForServerHealth, stopOwnedServerProcess } from "./serverLifecycle";
import { spawn } from "node:child_process";
import net from "node:net";
import path from "node:path";
import { utilityProcess } from "electron";
import { appendDesktopLog, logDesktopError } from "./logging";
import {
  resolveDesktopAppDataDir,
  resolveDesktopResourcesDir,
  resolvePackagedServerEntry,
  resolveWorkspaceRoot,
} from "./paths";

type DesktopServerMode = "external" | "managed";

const DESKTOP_SQLITE_DATABASE_URL = "file:./dev.db";

export interface DesktopServerHandle {
  mode: DesktopServerMode;
  port: number;
  stop: () => Promise<void>;
}

interface ManagedDesktopProcess {
  hasExited: () => boolean;
  stop: () => Promise<void>;
}

function resolveServerMode(isPackaged: boolean): DesktopServerMode {
  const rawMode = process.env.AI_NOVEL_DESKTOP_SERVER_MODE?.trim().toLowerCase();
  if (rawMode === "external" || rawMode === "managed") {
    return rawMode;
  }
  return isPackaged ? "managed" : "external";
}

function resolveConfiguredPort(): number | undefined {
  const parsed = Number(process.env.AI_NOVEL_SERVER_PORT ?? process.env.PORT ?? "");
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return undefined;
  }
  return Math.floor(parsed);
}

function resolveExternalServerPort(): number {
  return resolveConfiguredPort() ?? 3000;
}

async function resolveManagedServerPort(): Promise<number> {
  const configuredPort = resolveConfiguredPort();
  if (configuredPort) {
    return configuredPort;
  }

  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : null;
      server.close((error) => {
        if (error) {
          reject(error);
          return;
        }
        if (typeof port !== "number" || port <= 0) {
          reject(new Error("Failed to allocate a free loopback port for the desktop server."));
          return;
        }
        resolve(port);
      });
    });
  });
}

export async function resolveDesktopServerPort(options: { isPackaged: boolean }): Promise<number> {
  const mode = resolveServerMode(options.isPackaged);
  return mode === "external" ? resolveExternalServerPort() : resolveManagedServerPort();
}

function appendProcessOutput(
  stream: NodeJS.ReadableStream | null,
  source: string,
  level: "info" | "error",
): void {
  if (!stream) {
    return;
  }

  stream.on("data", (chunk) => {
    const message = Buffer.isBuffer(chunk) ? chunk.toString("utf8") : String(chunk);
    const lines = message
      .split(/\r?\n/)
      .map((line) => line.trimEnd())
      .filter(Boolean);
    for (const line of lines) {
      appendDesktopLog(source, line, level);
    }
  });
}

function startWorkspaceManagedServer(port: number): ManagedDesktopProcess {
  const appDataDir = resolveDesktopAppDataDir();
  const command = process.execPath;
  const args = [process.env.AI_NOVEL_SERVER_ENTRY?.trim()
    ? path.resolve(process.env.AI_NOVEL_SERVER_ENTRY.trim())
    : path.join(resolveWorkspaceRoot(), "server", "dist", "app.js")];
  const cwd = process.env.AI_NOVEL_SERVER_ENTRY?.trim()
    ? resolveWorkspaceRoot()
    : path.join(resolveWorkspaceRoot(), "server");
  const child = spawn(command, args, {
    cwd,
    env: {
      ...process.env,
      ELECTRON_RUN_AS_NODE: "1",
      AI_NOVEL_RUNTIME: "desktop",
      AI_NOVEL_APP_DATA_DIR: appDataDir,
      PORT: String(port),
      HOST: "127.0.0.1",
      ALLOW_LAN: "false",
    },
    stdio: ["ignore", "pipe", "pipe", "ipc"],
    windowsHide: true,
  });

  appendProcessOutput(child.stdout, "desktop.server.stdout", "info");
  appendProcessOutput(child.stderr, "desktop.server.stderr", "error");
  let spawnFailed = false;
  child.on("error", (error) => {
    if (child.pid == null) spawnFailed = true;
    logDesktopError("desktop.server.process", error);
  });
  child.on("exit", (code, signal) => {
    appendDesktopLog(
      "desktop.server.process",
      `Workspace-managed desktop server exited with code=${code ?? "null"} signal=${signal ?? "none"}.`,
      code === 0 ? "info" : "warn",
    );
  });

  const hasExited = () => spawnFailed || child.exitCode !== null || child.signalCode !== null;
  let stopping: Promise<void> | null = null;
  return {
    hasExited,
    stop: () => stopping ??= stopOwnedServerProcess({
      events: child, hasExited,
      terminate: () => {
        if (child.connected) child.send({ type: "ai-novel:shutdown" });
        else child.kill();
      },
      forceKill: () => { child.kill("SIGKILL"); },
    }).catch((error) => {
      stopping = null;
      throw error;
    }),
  };
}

function startPackagedManagedServer(port: number): ManagedDesktopProcess {
  const child = utilityProcess.fork(resolvePackagedServerEntry(), [], {
    cwd: resolveDesktopResourcesDir(),
    env: {
      ...process.env,
      NODE_ENV: "production",
      AI_NOVEL_RUNTIME: "desktop",
      AI_NOVEL_APP_DATA_DIR: resolveDesktopAppDataDir(),
      AI_NOVEL_DATABASE_MODE: "sqlite",
      DATABASE_URL: DESKTOP_SQLITE_DATABASE_URL,
      PORT: String(port),
      HOST: "127.0.0.1",
      ALLOW_LAN: "false",
      RAG_ENABLED: process.env.RAG_ENABLED?.trim() || "false",
    },
    stdio: "pipe",
    serviceName: "AI Novel Local Server",
  });

  let hasExited = false;
  child.on("spawn", () => {
    appendDesktopLog("desktop.server.process", `Packaged desktop server spawned with pid=${child.pid ?? "unknown"}.`);
  });
  child.on("error", (error) => {
    logDesktopError("desktop.server.process", error);
  });
  child.on("exit", (code) => {
    hasExited = true;
    appendDesktopLog(
      "desktop.server.process",
      `Packaged desktop server exited with code=${code}.`,
      code === 0 ? "info" : "warn",
    );
  });
  appendProcessOutput(child.stdout, "desktop.server.stdout", "info");
  appendProcessOutput(child.stderr, "desktop.server.stderr", "error");

  let stopping: Promise<void> | null = null;
  return {
    hasExited: () => hasExited,
    stop: () => stopping ??= stopOwnedServerProcess({
      events: child, hasExited: () => hasExited,
      terminate: () => { child.postMessage({ type: "ai-novel:shutdown" }); },
      forceKill: () => { if (child.pid != null) process.kill(child.pid, "SIGKILL"); },
    }).catch((error) => {
      stopping = null;
      throw error;
    }),
  };
}

async function startManagedServer(port: number, isPackaged: boolean): Promise<DesktopServerHandle> {
  const managedProcess = isPackaged
    ? startPackagedManagedServer(port)
    : startWorkspaceManagedServer(port);

  try {
    await waitForServerHealth(port, 45_000, managedProcess.hasExited);
    appendDesktopLog("desktop.server.process", `Desktop server is ready at http://127.0.0.1:${port}/api/health/ready.`);
  } catch (error) {
    await managedProcess.stop();
    throw error;
  }

  return {
    mode: "managed",
    port,
    stop: async () => managedProcess.stop(),
  };
}

export async function startDesktopServer(options: { isPackaged: boolean; port?: number }): Promise<DesktopServerHandle> {
  const mode = resolveServerMode(options.isPackaged);

  if (mode === "external") {
    const port = options.port ?? resolveExternalServerPort();
    await waitForServerHealth(port, 45_000);
    return {
      mode,
      port,
      stop: async () => undefined,
    };
  }

  const port = options.port ?? await resolveManagedServerPort();
  return startManagedServer(port, options.isPackaged);
}
