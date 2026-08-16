import fs from "fs";
import path from "path";
import { resolveLogsRoot } from "../runtime/appPaths";
import { resolveLogRetentionConfig, rotateLogFileIfNeeded } from "../platform/logging/logRetention";

const LOG_TRUE_VALUES = new Set(["1", "true", "on", "yes"]);
const LOG_FALSE_VALUES = new Set(["0", "false", "off", "no"]);

let cachedLogPath: string | null | undefined;
let cachedRepairLogPath: string | null | undefined;
let announcedLogPath: string | null = null;
let announcedRepairLogPath: string | null = null;

function toJsonSafeValue(value: unknown): unknown {
  if (value == null) {
    return value;
  }
  if (
    typeof value === "string"
    || typeof value === "number"
    || typeof value === "boolean"
  ) {
    return value;
  }
  if (typeof value === "bigint") {
    return value.toString();
  }
  if (value instanceof Error) {
    return {
      name: value.name,
      message: value.message,
      stack: value.stack ?? null,
    };
  }
  if (Array.isArray(value)) {
    return value.map((entry) => toJsonSafeValue(entry));
  }
  if (typeof value === "object") {
    const seen = new WeakSet<object>();
    const visit = (current: unknown): unknown => {
      if (current == null) {
        return current;
      }
      if (
        typeof current === "string"
        || typeof current === "number"
        || typeof current === "boolean"
      ) {
        return current;
      }
      if (typeof current === "bigint") {
        return current.toString();
      }
      if (current instanceof Error) {
        return {
          name: current.name,
          message: current.message,
          stack: current.stack ?? null,
        };
      }
      if (Array.isArray(current)) {
        return current.map((entry) => visit(entry));
      }
      if (typeof current === "object") {
        if (seen.has(current)) {
          return "[Circular]";
        }
        seen.add(current);
        return Object.fromEntries(
          Object.entries(current as Record<string, unknown>).map(([key, entry]) => {
            return [key, visit(entry)];
          }),
        );
      }
      return String(current);
    };
    return visit(value);
  }
  return String(value);
}

function shouldWriteLlmFileLog(): boolean {
  const raw = process.env.LLM_DEBUG_FILE_LOG?.trim().toLowerCase();
  if (raw && LOG_FALSE_VALUES.has(raw)) {
    return false;
  }
  if (raw && LOG_TRUE_VALUES.has(raw)) {
    return true;
  }
  return process.env.NODE_ENV !== "production";
}

function resolveDefaultLogsDir(): string {
  return resolveLogsRoot();
}

function formatDatePart(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function formatTimestampPart(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  const hours = String(date.getHours()).padStart(2, "0");
  const minutes = String(date.getMinutes()).padStart(2, "0");
  const seconds = String(date.getSeconds()).padStart(2, "0");
  return `${year}-${month}-${day}T${hours}-${minutes}-${seconds}`;
}

function resolveSessionLogPath(kind: "llm" | "llm-repair"): string | null {
  if (kind === "llm" && cachedLogPath !== undefined) {
    return cachedLogPath;
  }
  if (kind === "llm-repair" && cachedRepairLogPath !== undefined) {
    return cachedRepairLogPath;
  }

  const explicitPath = kind === "llm"
    ? process.env.RUN_WITH_LOG_LLM_PATH?.trim()
    : process.env.RUN_WITH_LOG_LLM_REPAIR_PATH?.trim();
  if (explicitPath) {
    const resolved = path.resolve(explicitPath);
    if (kind === "llm") {
      cachedLogPath = resolved;
    } else {
      cachedRepairLogPath = resolved;
    }
    return resolved;
  }

  const parentLogPath = process.env.RUN_WITH_LOG_PATH?.trim();
  if (parentLogPath) {
    const resolvedParent = path.resolve(parentLogPath);
    const resolved = resolvedParent.endsWith(".log")
      ? resolvedParent.replace(/\.log$/u, kind === "llm" ? ".llm.jsonl" : ".llm-repair.jsonl")
      : `${resolvedParent}.${kind}.jsonl`;
    if (kind === "llm") {
      cachedLogPath = resolved;
    } else {
      cachedRepairLogPath = resolved;
    }
    return resolved;
  }

  const now = new Date();
  const sessionDir = path.join(resolveDefaultLogsDir(), formatDatePart(now));
  const baseName = `${formatTimestampPart(now)}-server`;
  const resolved = path.join(sessionDir, `${baseName}.${kind}.jsonl`);
  if (kind === "llm") {
    cachedLogPath = resolved;
  } else {
    cachedRepairLogPath = resolved;
  }
  return resolved;
}

/**
 * E4：append 失败时降级到 stderr 的 entry 摘要。只取定位维度，不输出 payload（可能很大）。
 * entry 形状见 buildFileLogBlock（debugLogging.ts）：{timestamp,event,requestId,method,
 * provider,model,taskType,promptMeta,latencyMs,error}。
 */
function summarizeEntryForFallback(entry: unknown): Record<string, unknown> | null {
  if (!entry || typeof entry !== "object") {
    return null;
  }
  const record = entry as Record<string, unknown>;
  const promptMeta = record.promptMeta;
  const promptId = (promptMeta && typeof promptMeta === "object"
    ? (promptMeta as Record<string, unknown>).promptId
    : undefined) ?? record.taskType;
  const summary: Record<string, unknown> = {};
  if (typeof record.timestamp === "string") summary.timestamp = record.timestamp;
  if (typeof record.event === "string") summary.event = record.event;
  if (typeof record.method === "string") summary.method = record.method;
  if (typeof record.provider === "string") summary.provider = record.provider;
  if (typeof record.model === "string") summary.model = record.model;
  if (typeof record.taskType === "string") summary.taskType = record.taskType;
  if (promptId !== undefined) summary.promptId = promptId;
  if (typeof record.requestId === "string") summary.requestId = record.requestId;
  if (typeof record.latencyMs === "number") summary.latencyMs = record.latencyMs;
  if (record.error != null) summary.error = record.error;
  return Object.keys(summary).length > 0 ? summary : null;
}

function appendSessionLog(kind: "llm" | "llm-repair", entry: unknown): void {
  if (!shouldWriteLlmFileLog()) {
    return;
  }

  const logPath = resolveSessionLogPath(kind);
  if (!logPath) {
    return;
  }

  try {
    fs.mkdirSync(path.dirname(logPath), { recursive: true });
    rotateLogFileIfNeeded(logPath, resolveLogRetentionConfig());
    fs.appendFileSync(logPath, `${JSON.stringify(toJsonSafeValue(entry))}\n`, "utf8");
    const announced = kind === "llm" ? announcedLogPath : announcedRepairLogPath;
    if (announced !== logPath) {
      if (kind === "llm") {
        announcedLogPath = logPath;
      } else {
        announcedRepairLogPath = logPath;
      }
      console.info(`[llm.debug] writing dedicated ${kind} log to ${logPath}`);
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.warn(`[llm.debug] failed to append dedicated ${kind} log: ${message}`);
    // E4：append 失败（如 pxed errno -122 EDQUOT）时降级到 stderr，把 entry 关键字段
    // 输出，避免 llm.jsonl 写不进去时 planner 调用全无记录、可观测性丢失。
    // 不输出完整 payload（可能很大），只输出定位维度。
    try {
      const summary = summarizeEntryForFallback(entry);
      if (summary) {
        console.warn(`[llm.debug] ${kind} log fallback summary: ${JSON.stringify(summary)}`);
      }
    } catch {
      // 降级本身失败不得再引发副作用。
    }
  }
}

export function appendLlmSessionLog(entry: unknown): void {
  appendSessionLog("llm", entry);
}

export function appendLlmRepairSessionLog(entry: unknown): void {
  appendSessionLog("llm-repair", entry);
}

export function getLlmSessionLogPath(): string | null {
  if (!shouldWriteLlmFileLog()) {
    return null;
  }
  return resolveSessionLogPath("llm");
}

export function getLlmRepairSessionLogPath(): string | null {
  if (!shouldWriteLlmFileLog()) {
    return null;
  }
  return resolveSessionLogPath("llm-repair");
}
