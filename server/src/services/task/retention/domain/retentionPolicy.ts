import type { TaskRetentionConfig } from "../../../../config/taskRetention";

export const TERMINAL_WORKFLOW_STATUSES = ["succeeded", "failed", "cancelled"] as const;
export const TERMINAL_PIPELINE_STATUSES = ["succeeded", "failed", "cancelled"] as const;
export const ACTIVE_WORKFLOW_STATUSES = ["queued", "running", "waiting_approval"] as const;
export const ACTIVE_AGENT_STATUSES = ["queued", "running", "waiting_approval"] as const;
export const SUPERSEDE_LANE = "auto_director";
export const NULL_NOVEL_BUCKET = "__none__";

export interface TaskRetentionRow {
  id: string;
  novelId: string | null;
  status: string;
  finishedAt: Date | null;
  updatedAt: Date;
}

export interface SupersededCandidateRow {
  id: string;
  novelId: string | null;
  lane: string;
  status: string;
  finishedAt: Date | null;
  updatedAt: Date;
}

export interface GenerationJobSupersedeRow {
  id: string;
  novelId: string | null;
  status: string;
  finishedAt: Date | null;
  updatedAt: Date;
}

export function selectDeletableTaskIds(
  rows: TaskRetentionRow[],
  now: Date,
  cfg: TaskRetentionConfig,
): string[] {
  const nowMs = now.getTime();
  const succeededCutoffMs = cfg.succeededDays * 24 * 60 * 60 * 1000;
  const failedCutoffMs = cfg.failedDays * 24 * 60 * 60 * 1000;

  const buckets = new Map<string, TaskRetentionRow[]>();
  for (const row of rows) {
    const key = row.novelId ?? NULL_NOVEL_BUCKET;
    let bucket = buckets.get(key);
    if (!bucket) {
      bucket = [];
      buckets.set(key, bucket);
    }
    bucket.push(row);
  }

  const deletable: string[] = [];

  for (const bucket of buckets.values()) {
    bucket.sort((a, b) => {
      const aTime = a.finishedAt?.getTime() ?? a.updatedAt.getTime();
      const bTime = b.finishedAt?.getTime() ?? b.updatedAt.getTime();
      // id tiebreaker keeps the deletion set deterministic when batch tasks
      // share an identical timestamp.
      return bTime - aTime || a.id.localeCompare(b.id);
    });

    for (let i = 0; i < bucket.length; i++) {
      if (i < cfg.keepPerNovel) continue;
      const row = bucket[i];
      const effectiveTime = row.finishedAt?.getTime() ?? row.updatedAt.getTime();
      const ageMs = nowMs - effectiveTime;
      if (row.status === "failed") {
        if (ageMs > failedCutoffMs) deletable.push(row.id);
      } else if (ageMs > succeededCutoffMs) {
        deletable.push(row.id);
      }
    }
  }

  return deletable;
}

/**
 * 选出“被取代的死任务”——同一 (novelId, lane=auto_director) 桶内已有活跃任务接管时，
 * 桶内所有终态旧任务即视为已被取代，可清理。
 */
export function selectSupersededTaskIds(
  rows: SupersededCandidateRow[],
  now: Date,
  cfg: { supersededMinAgeMs: number },
): string[] {
  const nowMs = now.getTime();
  const activeStatuses = new Set<string>(ACTIVE_WORKFLOW_STATUSES);
  const terminalStatuses = new Set<string>(TERMINAL_WORKFLOW_STATUSES);

  const buckets = new Map<string, SupersededCandidateRow[]>();
  for (const row of rows) {
    if (row.lane !== SUPERSEDE_LANE) {
      continue;
    }
    const key = `${row.novelId ?? NULL_NOVEL_BUCKET}::${row.lane}`;
    let bucket = buckets.get(key);
    if (!bucket) {
      bucket = [];
      buckets.set(key, bucket);
    }
    bucket.push(row);
  }

  const deletable: string[] = [];
  for (const bucket of buckets.values()) {
    const hasActive = bucket.some((row) => activeStatuses.has(row.status));
    if (!hasActive) {
      continue;
    }
    for (const row of bucket) {
      if (!terminalStatuses.has(row.status)) {
        continue;
      }
      const effectiveTime = row.finishedAt?.getTime() ?? row.updatedAt.getTime();
      if (nowMs - effectiveTime < cfg.supersededMinAgeMs) {
        continue;
      }
      deletable.push(row.id);
    }
  }

  return deletable.sort((a, b) => a.localeCompare(b));
}

const ACTIVE_PIPELINE_STATUSES = ["queued", "running", "waiting_approval"] as const;
const TERMINAL_PIPELINE_STATUSES_SET = new Set<string>(TERMINAL_PIPELINE_STATUSES);

/**
 * 选出“被取代的终态 GenerationJob”。活跃判定同时认 GenerationJob 自身活跃态和
 * 同 novel 的 auto_director 接管；无活跃接管的桶不会被清理。
 */
export function selectSupersededGenerationJobIds(
  rows: GenerationJobSupersedeRow[],
  activeNovelIds: ReadonlySet<string>,
  now: Date,
  cfg: { supersededMinAgeMs: number },
): string[] {
  const nowMs = now.getTime();
  const activeStatuses = new Set<string>(ACTIVE_PIPELINE_STATUSES);

  const buckets = new Map<string, GenerationJobSupersedeRow[]>();
  for (const row of rows) {
    const key = row.novelId ?? NULL_NOVEL_BUCKET;
    let bucket = buckets.get(key);
    if (!bucket) {
      bucket = [];
      buckets.set(key, bucket);
    }
    bucket.push(row);
  }

  const deletable: string[] = [];
  for (const [novelKey, bucket] of buckets) {
    const hasActivePipeline = bucket.some((row) => activeStatuses.has(row.status));
    const hasActiveTakeover = novelKey !== NULL_NOVEL_BUCKET && activeNovelIds.has(novelKey);
    if (!hasActivePipeline && !hasActiveTakeover) {
      continue;
    }
    for (const row of bucket) {
      if (!TERMINAL_PIPELINE_STATUSES_SET.has(row.status)) {
        continue;
      }
      const effectiveTime = row.finishedAt?.getTime() ?? row.updatedAt.getTime();
      if (nowMs - effectiveTime < cfg.supersededMinAgeMs) {
        continue;
      }
      deletable.push(row.id);
    }
  }

  return deletable.sort((a, b) => a.localeCompare(b));
}
