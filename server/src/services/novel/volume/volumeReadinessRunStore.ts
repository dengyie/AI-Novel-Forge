/**
 * Volume Readiness run 持久化：内存索引 + JSON 快照落盘。
 * 进程启动时 hydrate 最近 runs；resume 可跳过已完成章。
 */

import { promises as fs } from "node:fs";
import path from "node:path";
import type {
  VolumeReadinessActionFilter,
  VolumeReadinessChapterPlan,
  VolumeReadinessSummary,
  VolumeReadinessVerdict,
} from "./volumeReadinessPolicy";

export type VolumeReadinessRunStatus =
  | "planned"
  | "running"
  | "completed"
  | "cancelled"
  | "failed";

export type VolumeReadinessChapterOutcome =
  | "kept"
  | "re_reviewed"
  | "re_review_incomplete"
  | "repair_adopted"
  | "repair_incomplete"
  | "repair_discarded"
  | "repair_plateau"
  | "polished"
  | "polish_incomplete"
  | "skipped_locked"
  | "failed"
  | "budget_skipped"
  | "dry_run"
  | "cancelled"
  | "already_done";

export interface VolumeReadinessRunBudget {
  maxChapters: number;
  maxHeavyRewrites: number;
  maxLlmCalls: number;
  maxWallMinutes: number;
}

export interface VolumeReadinessChapterRunResult {
  chapterId: string;
  chapterOrder: number;
  title: string | null;
  verdictBefore: VolumeReadinessVerdict;
  verdictAfter: VolumeReadinessVerdict | null;
  outcome: VolumeReadinessChapterOutcome;
  message?: string | null;
  startedAt: string;
  finishedAt: string | null;
  /**
   * 同章 incomplete 累计次数（results 同章覆盖时靠此字段续算；
   * 达 maxIncompleteRetries 后 executor escalate kept）。
   */
  attemptCount?: number;
}

export interface VolumeReadinessRunRecord {
  runId: string;
  novelId: string;
  volumeOrder: number | null;
  fromOrder: number;
  toOrder: number;
  /** volume 窗来源（workspace / fallback / explicit from-to）；旧快照可能缺 */
  rangeSource?: "volume_workspace" | "fallback_20" | "explicit" | null;
  dryRun: boolean;
  actionFilter: VolumeReadinessActionFilter[];
  budget: VolumeReadinessRunBudget;
  status: VolumeReadinessRunStatus;
  cancelRequested: boolean;
  plan: VolumeReadinessChapterPlan[];
  planSummary: VolumeReadinessSummary;
  results: VolumeReadinessChapterRunResult[];
  finalSummary: VolumeReadinessSummary | null;
  error: string | null;
  createdAt: string;
  updatedAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  llmCallsUsed: number;
  heavyRewritesUsed: number;
  chaptersActed: number;
  /**
   * 累计 wall 已用毫秒（跨 resume 累加）。
   * executor 每 execute 开始读此值，结束写回。
   * 旧快照缺省视为 0。
   */
  wallMsUsed?: number;
}

const runsById = new Map<string, VolumeReadinessRunRecord>();
const runsByNovel = new Map<string, string[]>();
/** 同 novel 同时只允许一个 live（非 dry）run 在执行。 */
const activeNovelRuns = new Map<string, string>();

let hydratePromise: Promise<void> | null = null;

function nowIso(): string {
  return new Date().toISOString();
}

function generateRunId(): string {
  return `vrr_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
}

function touchNovelIndex(novelId: string, runId: string): void {
  const list = runsByNovel.get(novelId) ?? [];
  if (!list.includes(runId)) {
    list.unshift(runId);
  }
  runsByNovel.set(novelId, list.slice(0, 50));
}

export function resolveVolumeReadinessStoreDir(): string {
  const fromEnv = process.env.VOLUME_READINESS_RUN_DIR?.trim();
  if (fromEnv) {
    return fromEnv;
  }
  return path.join(process.cwd(), ".data", "volume-readiness-runs");
}

function isPersistEnabled(): boolean {
  return process.env.VOLUME_READINESS_RUN_PERSIST !== "0";
}

function isRunRecord(value: unknown): value is VolumeReadinessRunRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const rec = value as Record<string, unknown>;
  return typeof rec.runId === "string"
    && typeof rec.novelId === "string"
    && typeof rec.status === "string"
    && Array.isArray(rec.plan)
    && Array.isArray(rec.results);
}

/**
 * 从磁盘加载最近 runs 到内存（幂等）。
 * 启动 / 首次 get 时调用；测试可 reset 后跳过。
 */
export async function hydrateVolumeReadinessRunsFromDisk(limit = 100): Promise<number> {
  if (!isPersistEnabled()) {
    return 0;
  }
  const dir = resolveVolumeReadinessStoreDir();
  let entries: string[];
  try {
    entries = await fs.readdir(dir);
  } catch {
    return 0;
  }
  const files = entries
    .filter((name) => name.startsWith("vrr_") && name.endsWith(".json"))
    .sort()
    .reverse()
    .slice(0, Math.max(1, limit));

  let loaded = 0;
  for (const fileName of files) {
    try {
      const raw = await fs.readFile(path.join(dir, fileName), "utf8");
      const parsed: unknown = JSON.parse(raw);
      if (!isRunRecord(parsed)) {
        continue;
      }
      if (runsById.has(parsed.runId)) {
        continue;
      }
      // 进程重启后 running 视为可 re-enter：降为 planned，保留 results 作断点
      if (parsed.status === "running") {
        parsed.status = "planned";
        parsed.startedAt = null;
      }
      // 旧快照 planSummary 可能缺 needsPolish 等字段
      parsed.planSummary = normalizePlanSummary(parsed.planSummary);
      if (parsed.finalSummary) {
        parsed.finalSummary = normalizePlanSummary(parsed.finalSummary);
      }
      if (typeof parsed.wallMsUsed !== "number") {
        parsed.wallMsUsed = 0;
      }
      runsById.set(parsed.runId, parsed);
      touchNovelIndex(parsed.novelId, parsed.runId);
      loaded += 1;
    } catch {
      // skip corrupt
    }
  }
  return loaded;
}

export function ensureVolumeReadinessRunsHydrated(): Promise<void> {
  if (!isPersistEnabled()) {
    return Promise.resolve();
  }
  if (!hydratePromise) {
    hydratePromise = hydrateVolumeReadinessRunsFromDisk()
      .then(() => undefined)
      .catch(() => undefined);
  }
  return hydratePromise;
}

function normalizePlanSummary(summary: VolumeReadinessSummary | null | undefined): VolumeReadinessSummary {
  return {
    total: summary?.total ?? 0,
    publishReady: summary?.publishReady ?? 0,
    needsReReview: summary?.needsReReview ?? 0,
    needsPatch: summary?.needsPatch ?? 0,
    needsPolish: summary?.needsPolish ?? 0,
    needsHeavy: summary?.needsHeavy ?? 0,
    needsManual: summary?.needsManual ?? 0,
    publishReadyRatio: summary?.publishReadyRatio ?? 0,
  };
}

export function createVolumeReadinessRun(input: {
  novelId: string;
  volumeOrder?: number | null;
  fromOrder: number;
  toOrder: number;
  rangeSource?: "volume_workspace" | "fallback_20" | "explicit" | null;
  dryRun: boolean;
  actionFilter: VolumeReadinessActionFilter[];
  budget: VolumeReadinessRunBudget;
  plan: VolumeReadinessChapterPlan[];
  planSummary: VolumeReadinessSummary;
}): VolumeReadinessRunRecord {
  const createdAt = nowIso();
  const run: VolumeReadinessRunRecord = {
    runId: generateRunId(),
    novelId: input.novelId,
    volumeOrder: input.volumeOrder ?? null,
    fromOrder: input.fromOrder,
    toOrder: input.toOrder,
    rangeSource: input.rangeSource ?? null,
    dryRun: input.dryRun,
    actionFilter: input.actionFilter,
    budget: { ...input.budget },
    status: "planned",
    cancelRequested: false,
    plan: input.plan,
    planSummary: normalizePlanSummary(input.planSummary),
    results: [],
    finalSummary: null,
    error: null,
    createdAt,
    updatedAt: createdAt,
    startedAt: null,
    finishedAt: null,
    llmCallsUsed: 0,
    heavyRewritesUsed: 0,
    chaptersActed: 0,
    wallMsUsed: 0,
  };
  runsById.set(run.runId, run);
  touchNovelIndex(run.novelId, run.runId);
  void persistRunSnapshot(run).catch(() => undefined);
  return cloneRun(run);
}

export function getVolumeReadinessRun(runId: string): VolumeReadinessRunRecord | null {
  const run = runsById.get(runId);
  return run ? cloneRun(run) : null;
}

export function listVolumeReadinessRuns(
  novelId: string,
  limit = 20,
): VolumeReadinessRunRecord[] {
  const ids = runsByNovel.get(novelId) ?? [];
  return ids
    .slice(0, Math.max(1, limit))
    .map((id) => runsById.get(id))
    .filter((run): run is VolumeReadinessRunRecord => Boolean(run))
    .map(cloneRun);
}

/**
 * 同 novel 是否已有 live（非 dry）running 在飞。
 * dryRun 不占 flight。
 */
export function findActiveLiveRunForNovel(novelId: string): VolumeReadinessRunRecord | null {
  const activeId = activeNovelRuns.get(novelId);
  if (activeId) {
    const active = runsById.get(activeId);
    if (active && active.status === "running" && !active.dryRun) {
      return cloneRun(active);
    }
    if (!active || active.status !== "running") {
      activeNovelRuns.delete(novelId);
    }
  }
  const ids = runsByNovel.get(novelId) ?? [];
  for (const id of ids) {
    const run = runsById.get(id);
    if (!run || run.dryRun) {
      continue;
    }
    if (run.status === "running") {
      return cloneRun(run);
    }
  }
  return null;
}

/**
 * 同 novel 是否已有 live（非 dry）planned/running —— createRun 互斥用。
 * 防止两个 create 同时 planned 再抢 execute。
 */
export function findOpenLiveRunForNovel(novelId: string): VolumeReadinessRunRecord | null {
  const active = findActiveLiveRunForNovel(novelId);
  if (active) {
    return active;
  }
  const ids = runsByNovel.get(novelId) ?? [];
  for (const id of ids) {
    const run = runsById.get(id);
    if (!run || run.dryRun) {
      continue;
    }
    if (run.status === "planned" || run.status === "running") {
      return cloneRun(run);
    }
  }
  return null;
}

export function tryClaimNovelRunFlight(novelId: string, runId: string): boolean {
  const existing = activeNovelRuns.get(novelId);
  if (existing && existing !== runId) {
    const other = runsById.get(existing);
    if (other && other.status === "running" && !other.dryRun) {
      return false;
    }
  }
  activeNovelRuns.set(novelId, runId);
  return true;
}

export function releaseNovelRunFlight(novelId: string, runId: string): void {
  if (activeNovelRuns.get(novelId) === runId) {
    activeNovelRuns.delete(novelId);
  }
}

export function updateVolumeReadinessRun(
  runId: string,
  patch: Partial<
    Pick<
      VolumeReadinessRunRecord,
      | "status"
      | "cancelRequested"
      | "results"
      | "finalSummary"
      | "error"
      | "startedAt"
      | "finishedAt"
      | "llmCallsUsed"
      | "heavyRewritesUsed"
      | "chaptersActed"
      | "plan"
      | "planSummary"
      | "wallMsUsed"
      | "rangeSource"
    >
  >,
): VolumeReadinessRunRecord | null {
  const run = runsById.get(runId);
  if (!run) {
    return null;
  }
  Object.assign(run, patch, { updatedAt: nowIso() });
  if (patch.planSummary) {
    run.planSummary = normalizePlanSummary(patch.planSummary);
  }
  if (patch.finalSummary) {
    run.finalSummary = normalizePlanSummary(patch.finalSummary);
  }
  if (
    patch.status === "completed"
    || patch.status === "cancelled"
    || patch.status === "failed"
  ) {
    releaseNovelRunFlight(run.novelId, runId);
  }
  void persistRunSnapshot(run).catch(() => undefined);
  return cloneRun(run);
}

export function requestVolumeReadinessRunCancel(runId: string): VolumeReadinessRunRecord | null {
  const run = runsById.get(runId);
  if (!run) {
    return null;
  }
  run.cancelRequested = true;
  run.updatedAt = nowIso();
  if (run.status === "planned") {
    run.status = "cancelled";
    run.finishedAt = run.updatedAt;
    releaseNovelRunFlight(run.novelId, runId);
  }
  void persistRunSnapshot(run).catch(() => undefined);
  return cloneRun(run);
}

export function appendVolumeReadinessChapterResult(
  runId: string,
  result: VolumeReadinessChapterRunResult,
  counters?: Partial<Pick<VolumeReadinessRunRecord, "llmCallsUsed" | "heavyRewritesUsed" | "chaptersActed">>,
): VolumeReadinessRunRecord | null {
  const run = runsById.get(runId);
  if (!run) {
    return null;
  }
  // 同章只保留最后一次结果（resume 重写）
  const existingIdx = run.results.findIndex((item) => item.chapterId === result.chapterId);
  if (existingIdx >= 0) {
    run.results[existingIdx] = result;
  } else {
    run.results.push(result);
  }
  if (counters) {
    if (typeof counters.llmCallsUsed === "number") {
      run.llmCallsUsed = counters.llmCallsUsed;
    }
    if (typeof counters.heavyRewritesUsed === "number") {
      run.heavyRewritesUsed = counters.heavyRewritesUsed;
    }
    if (typeof counters.chaptersActed === "number") {
      run.chaptersActed = counters.chaptersActed;
    }
  }
  run.updatedAt = nowIso();
  void persistRunSnapshot(run).catch(() => undefined);
  return cloneRun(run);
}

/** 已有终态 outcome 的章（resume 跳过）。failed 可重试。 */
export function getCompletedChapterIds(run: VolumeReadinessRunRecord): Set<string> {
  // incomplete / skipped_locked / failed 可 resume 重试；discard/plateau/budget 终态
  const terminal = new Set([
    "kept",
    "re_reviewed",
    "repair_adopted",
    "repair_discarded",
    "repair_plateau",
    "polished",
    "budget_skipped",
    "dry_run",
    "already_done",
  ]);
  const ids = new Set<string>();
  for (const result of run.results) {
    if (terminal.has(result.outcome)) {
      ids.add(result.chapterId);
    }
  }
  return ids;
}

function cloneRun(run: VolumeReadinessRunRecord): VolumeReadinessRunRecord {
  return {
    ...run,
    actionFilter: [...run.actionFilter],
    budget: { ...run.budget },
    plan: run.plan.map((item) => ({
      ...item,
      reasons: [...item.reasons],
      signals: { ...item.signals },
    })),
    planSummary: normalizePlanSummary(run.planSummary),
    results: run.results.map((item) => ({ ...item })),
    finalSummary: run.finalSummary ? normalizePlanSummary(run.finalSummary) : null,
    wallMsUsed: typeof run.wallMsUsed === "number" ? run.wallMsUsed : 0,
    rangeSource: run.rangeSource ?? null,
  };
}

async function persistRunSnapshot(run: VolumeReadinessRunRecord): Promise<void> {
  if (!isPersistEnabled()) {
    return;
  }
  const dir = resolveVolumeReadinessStoreDir();
  await fs.mkdir(dir, { recursive: true });
  const filePath = path.join(dir, `${run.runId}.json`);
  await fs.writeFile(filePath, JSON.stringify(run), "utf8");
}

/** 测试用：清空内存 store 与 flight。 */
export function resetVolumeReadinessRunStoreForTests(): void {
  runsById.clear();
  runsByNovel.clear();
  activeNovelRuns.clear();
  hydratePromise = null;
}

/** 测试用：直接注入一条 run（不经 create）。 */
export function seedVolumeReadinessRunForTests(run: VolumeReadinessRunRecord): void {
  runsById.set(run.runId, run);
  touchNovelIndex(run.novelId, run.runId);
}
