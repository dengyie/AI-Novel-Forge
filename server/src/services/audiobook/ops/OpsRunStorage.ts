/**
 * OpsRun 持久化：storage/audiobook-ops/{runId}/* JSON 文件 IO（§12-C.2）。
 *
 * 非 Prisma：与 VoiceAsset registry 一致，零迁移。
 * - {runId}/run.json      生命周期 + stepsSummary
 * - {runId}/report.json   完整 OpsRunReport
 * - {runId}/log.txt       append 顺序日志
 * - {runId}/steps/{name}.json  每步产物（ear/ready/synth/patrol）
 */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { resolveDataRoot } from "../../../runtime/appPaths";
import type {
  OpsRunInput,
  OpsRunReport,
  OpsRunStatus,
  OpsRunStepName,
  OpsRunStepSummary,
} from "@ai-novel/shared/types/audiobookOps";

const OPS_DIR_NAME = "audiobook-ops";

export function resolveOpsRoot(): string {
  return path.join(resolveDataRoot(), "storage", OPS_DIR_NAME);
}

export function resolveRunDir(runId: string): string {
  if (!runId || !/^[A-Za-z0-9_-]+$/.test(runId)) {
    throw new Error(`非法 runId: ${runId}`);
  }
  return path.join(resolveOpsRoot(), runId);
}

export function resolveRunJson(runId: string): string {
  return path.join(resolveRunDir(runId), "run.json");
}

export function resolveReportJson(runId: string): string {
  return path.join(resolveRunDir(runId), "report.json");
}

export function resolveLogPath(runId: string): string {
  return path.join(resolveRunDir(runId), "log.txt");
}

export function resolveStepPath(runId: string, step: OpsRunStepName): string {
  return path.join(resolveRunDir(runId), "steps", `${step}.json`);
}

export function newRunId(): string {
  return `ops_${crypto.randomBytes(8).toString("hex")}`;
}

export function computeInputFingerprint(input: OpsRunInput): string {
  const canonical = JSON.stringify({
    profile: input.profile,
    novelId: input.novelId ?? null,
    packRoots: (input.packRoots ?? []).filter(Boolean).map((p) => p.trim()).sort(),
    assetIds: (input.assetIds ?? []).filter(Boolean).map((s) => s.trim()).sort(),
    autoFix: input.autoFix === true,
    dryRun: input.dryRun === true,
  });
  return crypto.createHash("sha256").update(canonical).digest("hex");
}

export interface StoredRunState {
  id: string;
  profile: OpsRunInput["profile"];
  input: OpsRunInput;
  inputFingerprint: string;
  status: OpsRunStatus;
  startedAt: string;
  finishedAt: string | null;
  cancelRequestedAt: string | null;
  currentStep: OpsRunStepName | null;
  stepsSummary: OpsRunStepSummary[];
  reportPath: string;
  error: { code: string; message: string } | null;
}

export function ensureRunDir(runId: string): string {
  const dir = resolveRunDir(runId);
  fs.mkdirSync(dir, { recursive: true });
  fs.mkdirSync(path.join(dir, "steps"), { recursive: true });
  return dir;
}

function writeJsonAtomic(filePath: string, value: unknown): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tmp = `${filePath}.part`;
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2), "utf8");
  fs.renameSync(tmp, filePath);
}

export function writeRunState(state: StoredRunState): void {
  writeJsonAtomic(resolveRunJson(state.id), state);
}

export function readRunState(runId: string): StoredRunState | null {
  const file = resolveRunJson(runId);
  if (!fs.existsSync(file)) {
    return null;
  }
  try {
    return JSON.parse(fs.readFileSync(file, "utf8")) as StoredRunState;
  } catch {
    return null;
  }
}

export function writeReport(runId: string, report: OpsRunReport): void {
  writeJsonAtomic(resolveReportJson(runId), report);
}

export function readReport(runId: string): OpsRunReport | null {
  const file = resolveReportJson(runId);
  if (!fs.existsSync(file)) {
    return null;
  }
  try {
    return JSON.parse(fs.readFileSync(file, "utf8")) as OpsRunReport;
  } catch {
    return null;
  }
}

export function writeStepPayload(runId: string, step: OpsRunStepName, payload: unknown): void {
  writeJsonAtomic(resolveStepPath(runId, step), payload);
}

export function appendRunLog(runId: string, line: string): void {
  const file = resolveLogPath(runId);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, `${new Date().toISOString()} ${line}\n`, "utf8");
}

/** 扫所有 run.json 返回 StoredRunState[]，按 startedAt 降序。 */
export function listRunStates(limit = 50): StoredRunState[] {
  const root = resolveOpsRoot();
  if (!fs.existsSync(root)) {
    return [];
  }
  const entries: StoredRunState[] = [];
  for (const name of fs.readdirSync(root)) {
    const runJson = path.join(root, name, "run.json");
    if (!fs.existsSync(runJson)) {
      continue;
    }
    try {
      entries.push(JSON.parse(fs.readFileSync(runJson, "utf8")) as StoredRunState);
    } catch {
      continue;
    }
  }
  entries.sort((a, b) => (a.startedAt < b.startedAt ? 1 : -1));
  return entries.slice(0, limit);
}

/** 启动时回收 stale run：status=running 且 startedAt 超过 staleMs → 标 failed(stale_run)。 */
export function reapStaleRuns(staleMs: number): number {
  const root = resolveOpsRoot();
  if (!fs.existsSync(root)) {
    return 0;
  }
  const now = Date.now();
  let reaped = 0;
  for (const name of fs.readdirSync(root)) {
    const runJson = path.join(root, name, "run.json");
    if (!fs.existsSync(runJson)) {
      continue;
    }
    let state: StoredRunState | null = null;
    try {
      state = JSON.parse(fs.readFileSync(runJson, "utf8")) as StoredRunState;
    } catch {
      continue;
    }
    if (!state || state.status !== "running") {
      continue;
    }
    const startedAtMs = Date.parse(state.startedAt || "");
    if (!Number.isFinite(startedAtMs)) {
      continue;
    }
    if (now - startedAtMs > staleMs) {
      state.status = "failed";
      state.finishedAt = new Date().toISOString();
      state.error = { code: "stale_run", message: "running 超时回收（进程可能崩溃）" };
      try {
        writeRunState(state);
        reaped += 1;
      } catch {
        /* ignore */
      }
    }
  }
  return reaped;
}

export function clearOpsStorageForTests(): void {
  fs.rmSync(resolveOpsRoot(), { recursive: true, force: true });
}
