import { prisma } from "../../../db/prisma";
import type { RagOwnerType } from "../types";

export type ReindexScope = "novel" | "world" | "all";

export interface ReindexOwner {
  ownerType: RagOwnerType;
  ownerId: string;
}

export interface EnqueueReindexOptions {
  tenantId?: string;
  concurrency?: number;
}

export type ReindexOwnerEnqueuer<T> = (
  owner: ReindexOwner,
  options: { tenantId?: string },
) => Promise<T>;

export const DEFAULT_REINDEX_ENQUEUE_CONCURRENCY = 4;

function collectRows<T extends { id: string }>(
  owners: Map<string, ReindexOwner>,
  ownerType: RagOwnerType,
  rows: T[],
): void {
  for (const row of rows) {
    owners.set(`${ownerType}:${row.id}`, { ownerType, ownerId: row.id });
  }
}

/**
 * Expand a reindex scope using only the DB-facing owner ids. This module must
 * stay independent from the worker-side RAG service tree because routes and
 * the main process use it without loading embedding or vector-store code.
 */
export async function collectReindexOwners(
  scope: ReindexScope,
  id?: string,
): Promise<ReindexOwner[]> {
  const owners = new Map<string, ReindexOwner>();

  if (scope === "novel" || scope === "all") {
    const novelIds = scope === "novel" && id
      ? [id]
      : (await prisma.novel.findMany({ select: { id: true } })).map((item) => item.id);

    for (const novelId of novelIds) {
      owners.set(`novel:${novelId}`, { ownerType: "novel", ownerId: novelId });
      owners.set(`bible:${novelId}`, { ownerType: "bible", ownerId: novelId });
    }

    if (novelIds.length > 0) {
      const [chapters, summaries, facts, characters, timelines] = await Promise.all([
        prisma.chapter.findMany({ where: { novelId: { in: novelIds } }, select: { id: true } }),
        prisma.chapterSummary.findMany({ where: { novelId: { in: novelIds } }, select: { chapterId: true } }),
        prisma.consistencyFact.findMany({ where: { novelId: { in: novelIds } }, select: { id: true } }),
        prisma.character.findMany({ where: { novelId: { in: novelIds } }, select: { id: true } }),
        prisma.characterTimeline.findMany({ where: { novelId: { in: novelIds } }, select: { id: true } }),
      ]);
      collectRows(owners, "chapter", chapters);
      for (const row of summaries) {
        owners.set(`chapter_summary:${row.chapterId}`, {
          ownerType: "chapter_summary",
          ownerId: row.chapterId,
        });
      }
      collectRows(owners, "consistency_fact", facts);
      collectRows(owners, "character", characters);
      collectRows(owners, "character_timeline", timelines);
    }
  }

  if (scope === "world" || scope === "all") {
    const worldIds = scope === "world" && id
      ? [id]
      : (await prisma.world.findMany({ select: { id: true } })).map((item) => item.id);
    for (const worldId of worldIds) {
      owners.set(`world:${worldId}`, { ownerType: "world", ownerId: worldId });
    }

    const library = await prisma.worldPropertyLibrary.findMany({
      where: scope === "world" && id ? { sourceWorldId: id } : {},
      select: { id: true },
    });
    collectRows(owners, "world_library_item", library);
  }

  if (scope === "all") {
    const documents = await prisma.knowledgeDocument.findMany({
      where: { status: { not: "archived" } },
      select: { id: true },
    });
    collectRows(owners, "knowledge_document", documents);
  }

  return Array.from(owners.values());
}

export async function collectAllReindexOwners(): Promise<ReindexOwner[]> {
  return collectReindexOwners("all");
}

/**
 * Enqueue owner jobs through a small bounded pool. The old callers created one
 * promise per owner, which could turn a full reindex into a DB write burst.
 */
export async function enqueueReindexOwners<T>(
  owners: readonly ReindexOwner[],
  enqueue: ReindexOwnerEnqueuer<T>,
  options: EnqueueReindexOptions = {},
): Promise<T[]> {
  if (owners.length === 0) {
    return [];
  }

  const requestedConcurrency = Number.isFinite(options.concurrency)
    ? Math.floor(options.concurrency as number)
    : DEFAULT_REINDEX_ENQUEUE_CONCURRENCY;
  const concurrency = Math.max(1, Math.min(requestedConcurrency, owners.length));
  const jobs = new Array<T>(owners.length);
  let nextIndex = 0;
  let failed = false;
  let firstError: unknown;

  async function worker(): Promise<void> {
    while (!failed) {
      const index = nextIndex;
      nextIndex += 1;
      if (index >= owners.length) {
        return;
      }
      try {
        jobs[index] = await enqueue(owners[index], { tenantId: options.tenantId });
      } catch (error) {
        failed = true;
        firstError = error;
        return;
      }
    }
  }

  await Promise.all(Array.from({ length: concurrency }, () => worker()));
  if (failed) {
    throw firstError;
  }
  return jobs;
}
