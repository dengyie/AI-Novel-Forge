import { prisma } from "../../db/prisma";
import { ragWorkerManager } from "../../runtime/RagWorkerManager";

/**
 * 主进程侧 RAG 访问面（pxed 防 OOM Phase 3）。
 *
 * RAG 重 import 树（+85MB heap）已整体移入 rag worker 子进程。主进程不再
 * import services/rag 任何子模块——此文件是唯一出口，只含：
 * - RagClient（IPC-RPC，RagWorkerManager 所有）
 * - retrieval trace retention（仅 prisma 轻操作，留主进程）
 * - 入队类操作的 DB 直写（worker 轮询即取走）
 *
 * 消费方（chat / novelReadTools / novel 服务等）统一改从这里 import
 * `ragMain`，检索走 `retrieval.buildContextBlock(...)`（失败降级空串）。
 */

/** 全量重建的 owner 展开（reindex "all"）——与 routes/rag.ts 的逐 scope 展开共用 DB 直查。 */
export async function collectAllReindexOwners(): Promise<Array<{ ownerType: string; ownerId: string }>> {
  const owners: Array<{ ownerType: string; ownerId: string }> = [];
  const push = (ownerType: string, ownerId: string) => owners.push({ ownerType, ownerId });
  const novelIds = (await prisma.novel.findMany({ select: { id: true } })).map((item) => item.id);
  for (const novelId of novelIds) {
    push("novel", novelId);
    push("bible", novelId);
  }
  const [chapters, summaries, facts, characters, timelines] = await Promise.all([
    prisma.chapter.findMany({ where: { novelId: { in: novelIds } }, select: { id: true } }),
    prisma.chapterSummary.findMany({ where: { novelId: { in: novelIds } }, select: { chapterId: true } }),
    prisma.consistencyFact.findMany({ where: { novelId: { in: novelIds } }, select: { id: true } }),
    prisma.character.findMany({ where: { novelId: { in: novelIds } }, select: { id: true } }),
    prisma.characterTimeline.findMany({ where: { novelId: { in: novelIds } }, select: { id: true } }),
  ]);
  chapters.forEach((item) => push("chapter", item.id));
  summaries.forEach((item) => push("chapter_summary", item.chapterId));
  facts.forEach((item) => push("consistency_fact", item.id));
  characters.forEach((item) => push("character", item.id));
  timelines.forEach((item) => push("character_timeline", item.id));
  (await prisma.world.findMany({ select: { id: true } })).forEach((item) => push("world", item.id));
  (await prisma.worldPropertyLibrary.findMany({ select: { id: true } })).forEach((item) => push("world_library_item", item.id));
  return owners;
}

/** 轻量入队/状态更新面：仅 DB 写，不触碰 RAG 类（worker 轮询即取走）。 */
export const ragJobQueue = {
  async enqueueOwnerJob(
    jobType: "rebuild" | "upsert" | "delete",
    ownerType: string,
    ownerId: string,
    options?: {
      tenantId?: string;
      payload?: Record<string, unknown>;
      runAfter?: Date;
      maxAttempts?: number;
    },
  ): Promise<{ id: string }> {
    const { ragConfig } = await import("../../config/rag");
    const existing = await prisma.ragIndexJob.findFirst({
      where: {
        tenantId: options?.tenantId ?? ragConfig.defaultTenantId,
        jobType,
        // ownerType 为 schema enum；调用方传的字符串均来自 RAG_OWNER_TYPES 集合，
        // 运行时值一致，此处用断言避免主进程为类型引 RAG types 树。
        ownerType: ownerType as never,
        ownerId,
        status: { in: ["queued", "running"] },
      },
      orderBy: { createdAt: "desc" },
    });
    if (existing) {
      return existing;
    }
    const now = new Date();
    const created = await prisma.ragIndexJob.create({
      data: {
        tenantId: options?.tenantId ?? ragConfig.defaultTenantId,
        jobType,
        ownerType: ownerType as never,
        ownerId,
        status: "queued",
        attempts: 0,
        maxAttempts: options?.maxAttempts ?? ragConfig.workerMaxAttempts,
        runAfter: options?.runAfter ?? now,
        payloadJson: JSON.stringify({
          ...(options?.payload ?? {}),
          progress: { stage: "queued", label: "等待执行", detail: "索引任务已进入队列。", percent: 0, updatedAt: now.toISOString() },
        }),
      },
    });
    ragWorkerManager.kickPoll();
    return created;
  },

  async enqueueUpsert(ownerType: string, ownerId: string, tenantId?: string) {
    return this.enqueueOwnerJob("upsert", ownerType, ownerId, { tenantId });
  },

  async enqueueDelete(ownerType: string, ownerId: string, tenantId?: string) {
    return this.enqueueOwnerJob("delete", ownerType, ownerId, { tenantId });
  },

  async updateJobStatus(jobId: string, payload: {
    status: "queued" | "running" | "succeeded" | "failed" | "cancelled";
    lastError?: string | null;
  }): Promise<void> {
    await prisma.ragIndexJob.update({
      where: { id: jobId },
      data: {
        status: payload.status,
        ...(payload.lastError !== undefined ? { lastError: payload.lastError } : {}),
        updatedAt: new Date(),
      },
    });
  },
};

/** 轻量健康探测：子进程在场才探 embedding/qdrant；不在场返回 degraded。 */
export async function ragHealthCheck(): Promise<{
  ok: boolean;
  worker: { alive: boolean; pid: number | null };
  embedding: { ok: boolean; detail?: string } | null;
  qdrant: { ok: boolean; detail?: string } | null;
}> {
  const worker = ragWorkerManager.status();
  if (!worker.alive) {
    return {
      ok: false,
      worker,
      embedding: null,
      qdrant: null,
    };
  }
  const result = await ragWorkerManager.client.healthCheck();
  return {
    ok: result?.ok ?? false,
    worker,
    embedding: result?.embedding ?? null,
    qdrant: result?.qdrant ?? null,
  };
}
export const ragMain = {
  /** 检索代理（RagClient）：所有 buildContextBlock/retrieve/retrieveByFacet 调用走这里。 */
  retrieval: ragWorkerManager.client,
  /** 入队/状态更新（仅 DB 写）：enqueueUpsert / enqueueDelete / enqueueOwnerJob / updateJobStatus。 */
  jobs: ragJobQueue,
  /** 健康探测（经 IPC 到 rag worker 子进程）。 */
  ragHealthCheck,
  /** 子进程按需拉起（入队后立即唤醒，避免等 15s poll）。 */
  kickWorker: () => ragWorkerManager.kickPoll(),
  /** 设置关闭 RAG 时安全停止当前子进程；重新启用由 kickWorker 按需拉起。 */
  disableWorker: () => ragWorkerManager.disable(),
  /**
   * 检索轨迹保留（仅 prisma 定时清理，无重依赖）——留主进程运行。
   * 动态 import RagRetrievalTraceRetention（其只依赖 prisma+ragConfig，不引重树）。
   */
  retrievalTraceRetention: {
    async start(): Promise<void> {
      const { RagRetrievalTraceRetention } = await import("./RagRetrievalTraceRetention");
      if (!traceRetentionSingleton) {
        traceRetentionSingleton = new RagRetrievalTraceRetention();
      }
      traceRetentionSingleton.start();
    },
    stop: (): void => {
      traceRetentionSingleton?.stop();
    },
  },
};

let traceRetentionSingleton: { start(): void; stop(): void } | null = null;
