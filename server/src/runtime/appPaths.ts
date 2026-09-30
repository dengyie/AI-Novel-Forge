import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export type AppRuntimeMode = "web" | "desktop";

const APP_NAME = "AI-Novel-Writing-Assistant-v2";
const SERVER_ROOT = path.resolve(__dirname, "..", "..");
const WORKSPACE_ROOT = path.resolve(SERVER_ROOT, "..");

function resolveConfiguredAppDataDir(): string | null {
  const configuredDir = process.env.AI_NOVEL_APP_DATA_DIR?.trim();
  return configuredDir ? path.resolve(configuredDir) : null;
}

function resolveDefaultDesktopAppDataDir(): string {
  const localAppData = process.env.LOCALAPPDATA?.trim();
  if (localAppData) {
    return path.join(localAppData, APP_NAME);
  }

  const appData = process.env.APPDATA?.trim();
  if (appData) {
    return path.join(appData, APP_NAME);
  }

  if (process.platform === "darwin") {
    return path.join(os.homedir(), "Library", "Application Support", APP_NAME);
  }

  return path.join(os.homedir(), `.${APP_NAME}`);
}

export function resolveAppRuntimeMode(): AppRuntimeMode {
  return process.env.AI_NOVEL_RUNTIME?.trim().toLowerCase() === "desktop" ? "desktop" : "web";
}

export function resolveAppDataRoot(): string {
  return resolveConfiguredAppDataDir() ?? resolveDefaultDesktopAppDataDir();
}

export function resolveServerRoot(): string {
  return SERVER_ROOT;
}

export function resolveWorkspaceRoot(): string {
  return WORKSPACE_ROOT;
}

export function resolveClientDistPath(): string | null {
  const dir = path.join(resolveWorkspaceRoot(), "client", "dist");
  return fs.existsSync(path.join(dir, "index.html")) ? dir : null;
}

/** Desktop 保持 app-data/data；Web 显式数据目录同时约束媒体与相对 SQLite 路径。 */
export function resolveDataRoot(): string {
  return resolveAppRuntimeMode() === "desktop"
    ? path.join(resolveAppDataRoot(), "data")
    : resolveConfiguredAppDataDir() ?? resolveServerRoot();
}

/**
 * Web 运行模式下若显式配置 AI_NOVEL_APP_DATA_DIR（如容器挂载 /data），
 * logs 与 generated-images 一并落到该根下，保证容器重建后数据不丢；
 * 未配置时保持旧行为（workspace/.logs、serverRoot/storage）。
 */
export function resolveLogsRoot(): string {
  if (resolveAppRuntimeMode() === "desktop") {
    return path.join(resolveAppDataRoot(), "logs");
  }
  const configuredDir = resolveConfiguredAppDataDir();
  return configuredDir
    ? path.join(configuredDir, "logs")
    : path.join(resolveWorkspaceRoot(), ".logs");
}

export function resolveGeneratedImagesRoot(): string {
  if (resolveAppRuntimeMode() === "desktop") {
    return path.join(resolveAppDataRoot(), "storage", "generated-images");
  }
  const configuredDir = resolveConfiguredAppDataDir();
  return configuredDir
    ? path.join(configuredDir, "storage", "generated-images")
    : path.join(resolveServerRoot(), "storage", "generated-images");
}

export function resolveDatabaseFilePath(filePath: string): string {
  const baseDir = resolveDataRoot();
  return path.isAbsolute(filePath) ? filePath : path.resolve(baseDir, filePath);
}
