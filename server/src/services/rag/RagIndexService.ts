import { replaceIndexedChunks } from "./indexing/persistence";
import { SourceDocumentAssembler } from "./indexing/source";
import type { RagIndexJob } from "@prisma/client";
import { prisma } from "../../db/prisma";
import { ragConfig } from "../../config/rag";
import { getRagEmbeddingSettings } from "../settings/RagSettingsService";
import { EmbeddingService } from "./EmbeddingService";
import { VectorStoreService } from "./VectorStoreService";
import { RagContextualChunkService } from "./RagContextualChunkService";
import { resolveEmbeddingChunkTokenBudget } from "./embeddingModelLimits";
import type { RagJobStatus, RagJobType, RagOwnerType } from "./types";
import type { RagPreChunk } from "./chunkFacets";
import {
  enqueueIndexJob,
  syncDocumentIndexStatus,
  collectReindexOwners,
  enqueueReindexOwners,
  type ReindexScope,
} from "./indexing";
import { runWithConcurrency } from "./utils";

export class RagJobCancelledError extends Error {
  constructor() {
    super("RAG job cancelled.");
    this.name = "RagJobCancelledError";
  }
}

export interface RagJobProgressSnapshot {
  stage:
    | "queued"
    | "loading_source"
    | "chunking"
    | "embedding"
    | "ensuring_collection"
    | "deleting_existing"
    | "upserting_vectors"
    | "writing_metadata"
    | "completed"
    | "cancelled"
    | "failed";
  label: string;
  detail?: string;
  current?: number;
  total?: number;
  percent: number;
  documents?: number;
  chunks?: number;
  updatedAt: string;
}

interface RagJobPayloadRecord extends Record<string, unknown> {
  progress?: RagJobProgressSnapshot;
  preChunks?: RagPreChunk[];
}

export interface RagJobSummaryRecord {
  id: string;
  tenantId: string;
  jobType: RagJobType;
  ownerType: RagOwnerType;
  ownerId: string;
  status: RagJobStatus;
  attempts: number;
  maxAttempts: number;
  runAfter: Date;
  lastError: string | null;
  createdAt: Date;
  updatedAt: Date;
  progress?: RagJobProgressSnapshot;
}

export class RagIndexService {
  constructor(
    private readonly embeddingService: EmbeddingService,
    private readonly vectorStoreService: VectorStoreService,
    private readonly contextualChunkService: RagContextualChunkService = new RagContextualChunkService(),
  ) {}

  private parseJobPayload(payloadJson: string | null): RagJobPayloadRecord {
    if (!payloadJson) {
      return {};
    }
    try {
      const parsed = JSON.parse(payloadJson) as unknown;
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        return {};
      }
      return parsed as RagJobPayloadRecord;
    } catch {
      return {};
    }
  }

  private createProgressSnapshot(input: Omit<RagJobProgressSnapshot, "updatedAt">): RagJobProgressSnapshot {
    return {
      ...input,
      percent: Math.min(1, Math.max(0, Number.isFinite(input.percent) ? input.percent : 0)),
      updatedAt: new Date().toISOString(),
    };
  }

  private async assertJobNotCancelled(jobId: string): Promise<void> {
    const job = await prisma.ragIndexJob.findUnique({
      where: { id: jobId },
      select: { status: true },
    });
    if (!job) {
      throw new Error("RAG job not found.");
    }
    if (job.status === "cancelled") {
      throw new RagJobCancelledError();
    }
  }

  private async updateJobProgress(jobId: string, progress: Omit<RagJobProgressSnapshot, "updatedAt">): Promise<void> {
    const record = await prisma.ragIndexJob.findUnique({
      where: { id: jobId },
      select: { payloadJson: true },
    });
    if (!record) {
      return;
    }
    const payload = this.parseJobPayload(record.payloadJson);
    payload.progress = this.createProgressSnapshot(progress);
    await prisma.ragIndexJob.update({
      where: { id: jobId },
      data: {
        payloadJson: JSON.stringify(payload),
      },
    });
  }

  private serializeJob(job: RagIndexJob): RagJobSummaryRecord {
    const payload = this.parseJobPayload(job.payloadJson);
    return {
      id: job.id,
      tenantId: job.tenantId,
      jobType: job.jobType as RagJobType,
      ownerType: job.ownerType as RagOwnerType,
      ownerId: job.ownerId,
      status: job.status as RagJobStatus,
      attempts: job.attempts,
      maxAttempts: job.maxAttempts,
      runAfter: job.runAfter,
      lastError: job.lastError,
      createdAt: job.createdAt,
      updatedAt: job.updatedAt,
      progress: payload.progress,
    };
  }

  private async embedTextsInBatches(
    texts: string[],
    onProgress?: (payload: { processed: number; total: number }) => Promise<void>,
  ): Promise<{ vectors: number[][]; provider: string; model: string }> {
    if (texts.length === 0) {
      return { vectors: [], provider: ragConfig.embeddingProvider, model: ragConfig.embeddingModel };
    }
    const batchSize = ragConfig.embeddingBatchSize;
    const concurrency = ragConfig.embeddingConcurrency;
    const vectors: number[][] = new Array(texts.length);
    let provider = ragConfig.embeddingProvider;
    let model = ragConfig.embeddingModel;
    let processed = 0;
    let lastReportPercent = 0;

    const batches: { start: number; texts: string[] }[] = [];
    for (let cursor = 0; cursor < texts.length; cursor += batchSize) {
      batches.push({ start: cursor, texts: texts.slice(cursor, cursor + batchSize) });
    }

    await runWithConcurrency(batches, concurrency, async (batch) => {
      const result = await this.embeddingService.embedTexts(batch.texts);
      provider = result.provider;
      model = result.model;
      for (let i = 0; i < result.vectors.length; i += 1) {
        vectors[batch.start + i] = result.vectors[i];
      }
      processed += batch.texts.length;

      if (onProgress) {
        const percent = texts.length > 0 ? processed / texts.length : 1;
        if (percent - lastReportPercent >= 0.03 || processed >= texts.length) {
          lastReportPercent = percent;
          await onProgress({ processed: Math.min(processed, texts.length), total: texts.length });
        }
      }
    });

    return { vectors, provider, model };
  }

  private readonly sourceAssembler = new SourceDocumentAssembler();

  private async deleteOwnerChunks(
    ownerType: RagOwnerType,
    ownerId: string,
    tenantId: string,
    jobId?: string,
  ): Promise<{ deleted: number }> {
    if (jobId) {
      await this.assertJobNotCancelled(jobId);
    }
    const existing = await prisma.knowledgeChunk.findMany({
      where: { tenantId, ownerType, ownerId },
      select: { id: true },
    });
    if (existing.length === 0) {
      return { deleted: 0 };
    }
    if (jobId) {
      await this.updateJobProgress(jobId, {
        stage: "deleting_existing",
        label: "清理旧索引",
        detail: `正在删除 ${existing.length} 条旧分块。`,
        current: existing.length,
        total: existing.length,
        documents: 0,
        chunks: existing.length,
        percent: 0.8,
      });
    }
    const ids = existing.map((item) => item.id);
    await prisma.knowledgeChunk.updateMany({ where: { id: { in: ids } }, data: { indexedAt: null } });
    await this.vectorStoreService.deletePoints(ids);
    await prisma.knowledgeChunk.deleteMany({
      where: { tenantId, ownerType, ownerId },
    });
    return { deleted: existing.length };
  }

  private async upsertOwnerChunks(
    ownerType: RagOwnerType,
    ownerId: string,
    tenantId: string,
    jobId: string,
  ): Promise<{ chunks: number }> {
    await this.assertJobNotCancelled(jobId);
    await this.updateJobProgress(jobId, {
      stage: "loading_source",
      label: "读取文档",
      detail: "正在读取知识库文档内容。",
      documents: 0,
      chunks: 0,
      percent: 0.05,
    });
    const jobPayload = this.parseJobPayload((await prisma.ragIndexJob.findUnique({
      where: { id: jobId },
      select: { payloadJson: true },
    }))?.payloadJson ?? null);
    const docs = await this.sourceAssembler.loadSourceDocuments(ownerType, ownerId, tenantId, jobPayload);
    if (ownerType === "knowledge_document") {
      const currentSourceVersionId = docs[0]?.metadata?.activeVersionId ?? null;
      const superseded = jobPayload.sourceVersionId && currentSourceVersionId
        && jobPayload.sourceVersionId !== currentSourceVersionId;
      const indexedSourceVersionId = superseded ? jobPayload.sourceVersionId : currentSourceVersionId;
      await prisma.ragIndexJob.update({ where: { id: jobId }, data: {
        payloadJson: JSON.stringify({ ...jobPayload, indexedSourceVersionId }),
      } });
      // A delayed older request must not overwrite a newer version's custom chunks.
      if (superseded) return { chunks: 0 };
    }
    await this.assertJobNotCancelled(jobId);
    if (docs.length === 0) {
      await this.updateJobProgress(jobId, {
        stage: "deleting_existing",
        label: "清理旧索引",
        detail: "当前没有可索引内容，正在清理旧索引。",
        documents: 0,
        chunks: 0,
        percent: 0.3,
      });
      await this.deleteOwnerChunks(ownerType, ownerId, tenantId, jobId);
      await this.updateJobProgress(jobId, {
        stage: "completed",
        label: "索引完成",
        detail: "没有可索引内容，旧索引已清理。",
        documents: 0,
        chunks: 0,
        percent: 1,
      });
      return { chunks: 0 };
    }

    const embeddingSettings = await getRagEmbeddingSettings();
    const embeddingTokenBudget = resolveEmbeddingChunkTokenBudget(
      embeddingSettings.embeddingProvider,
      embeddingSettings.embeddingModel,
    );

    // 知识库文档索引时，预加载角色候选名用于 chunk facet 自动提取
    // KnowledgeDocument 没有直接 novelId，取该租户下所有角色名做关键词匹配（数量有限，代价可忽略）
    let knownCharacterNames: string[] = [];
    if (ownerType === "knowledge_document") {
      const chars = await prisma.character.findMany({
        select: { name: true },
        take: 300,
        orderBy: { updatedAt: "desc" },
      });
      knownCharacterNames = chars.map((c) => c.name).filter((n) => n.length >= 2);
    }

    const candidates = this.sourceAssembler.buildChunkCandidates(docs, embeddingSettings.embeddingProvider, embeddingSettings.embeddingModel, {
      maxTokens: embeddingTokenBudget,
      knownCharacterNames,
    });
    await this.updateJobProgress(jobId, {
      stage: "chunking",
      label: "切分分块",
      detail: `已读取 ${docs.length} 份文档，生成 ${candidates.length} 个分块。`,
      current: candidates.length,
      total: candidates.length,
      documents: docs.length,
      chunks: candidates.length,
      percent: 0.15,
    });
    await this.contextualChunkService.applyToCandidates({
      candidates,
      documentsByOwner: this.sourceAssembler.buildContextualDocumentMap(docs),
    });
    const splitTexts = candidates.map((item) => item.searchText ?? item.chunkText);
    await this.assertJobNotCancelled(jobId);
    const embedding = await this.embedTextsInBatches(splitTexts, async ({ processed, total }) => {
      await this.updateJobProgress(jobId, {
        stage: "embedding",
        label: "生成向量",
        detail: `已生成 ${processed}/${total} 个向量（${ragConfig.embeddingConcurrency} 并发）。`,
        current: processed,
        total,
        documents: docs.length,
        chunks: total,
        percent: 0.15 + (total > 0 ? (processed / total) * 0.5 : 0),
      });
    });
    await this.assertJobNotCancelled(jobId);
    for (const candidate of candidates) {
      candidate.embedProvider = embedding.provider;
      candidate.embedModel = embedding.model;
    }
    if (candidates.length === 0) {
      await this.updateJobProgress(jobId, {
        stage: "deleting_existing",
        label: "清理旧索引",
        detail: "切分后没有可写入的分块，正在清理旧索引。",
        documents: docs.length,
        chunks: 0,
        percent: 0.3,
      });
      await this.deleteOwnerChunks(ownerType, ownerId, tenantId, jobId);
      await this.updateJobProgress(jobId, {
        stage: "completed",
        label: "索引完成",
        detail: "切分后没有可写入的分块。",
        documents: docs.length,
        chunks: 0,
        percent: 1,
      });
      return { chunks: 0 };
    }
    if (embedding.vectors.length !== candidates.length) {
      throw new Error("RAG embedding 数量与 chunk 数量不一致。");
    }

    const vectorSize = embedding.vectors[0]?.length ?? 0;
    await this.updateJobProgress(jobId, {
      stage: "ensuring_collection",
      label: "校验集合",
      detail: `正在校验向量集合，目标维度 ${vectorSize}。`,
      current: candidates.length,
      total: candidates.length,
      documents: docs.length,
      chunks: candidates.length,
      percent: 0.7,
    });
    await this.assertJobNotCancelled(jobId);
    await this.vectorStoreService.ensureCollection(vectorSize);

    // 读取旧 chunk id，但先不删除 — 保持旧数据可检索直到新数据写入完成
    const oldChunks = await prisma.knowledgeChunk.findMany({
      where: { tenantId, ownerType, ownerId },
      select: { id: true },
    });
    const oldIds = oldChunks.map((item) => item.id);
    await this.assertJobNotCancelled(jobId);

    await this.updateJobProgress(jobId, {
      stage: "upserting_vectors",
      label: "写入向量库",
      detail: `正在向 Qdrant 写入 ${candidates.length} 个分块（${ragConfig.qdrantUpsertConcurrency} 并发）。`,
      current: candidates.length,
      total: candidates.length,
      documents: docs.length,
      chunks: candidates.length,
      percent: 0.8,
    });
    await this.assertJobNotCancelled(jobId);

    await replaceIndexedChunks(this.vectorStoreService, candidates, embedding.vectors, oldIds);

    await this.updateJobProgress(jobId, {
      stage: "completed",
      label: "索引完成",
      detail: `索引已完成，共 ${candidates.length} 个分块。`,
      current: candidates.length,
      total: candidates.length,
      documents: docs.length,
      chunks: candidates.length,
      percent: 1,
    });
    return { chunks: candidates.length };
  }

  async enqueueOwnerJob(
    jobType: RagJobType,
    ownerType: RagOwnerType,
    ownerId: string,
    options?: {
      tenantId?: string;
      payload?: Record<string, unknown>;
      runAfter?: Date;
      maxAttempts?: number;
    },
  ) {
    return enqueueIndexJob(jobType, ownerType, ownerId, options);
  }

  async enqueueUpsert(ownerType: RagOwnerType, ownerId: string, tenantId?: string) {
    return this.enqueueOwnerJob("upsert", ownerType, ownerId, { tenantId });
  }

  async enqueueDelete(ownerType: RagOwnerType, ownerId: string, tenantId?: string) {
    return this.enqueueOwnerJob("delete", ownerType, ownerId, { tenantId });
  }

  async enqueueReindex(scope: ReindexScope, id?: string, tenantId?: string) {
    const owners = await collectReindexOwners(scope, id);
    const jobs = await enqueueReindexOwners(
      owners,
      (owner, options) => this.enqueueOwnerJob("rebuild", owner.ownerType, owner.ownerId, options),
      { tenantId },
    );
    return {
      scope,
      id: id ?? null,
      count: jobs.length,
      jobs,
    };
  }

  async getNextRunnableJob(): Promise<RagIndexJob | null> {
    return prisma.ragIndexJob.findFirst({
      where: {
        status: "queued",
        runAfter: { lte: new Date() },
      },
      orderBy: [{ runAfter: "asc" }, { createdAt: "asc" }],
    });
  }

  async updateJobStatus(jobId: string, payload: {
    status: RagJobStatus;
    attempts?: number;
    runAfter?: Date;
    lastError?: string | null;
  }) {
    const current = await prisma.ragIndexJob.findUnique({
      where: { id: jobId },
      select: { status: true, payloadJson: true },
    });
    if (!current) {
      throw new Error("RAG job not found.");
    }
    if (current.status === "cancelled" && payload.status !== "cancelled") {
      return prisma.ragIndexJob.findUnique({
        where: { id: jobId },
      }) as Promise<RagIndexJob>;
    }

    const job = await prisma.ragIndexJob.update({
      where: { id: jobId },
      data: {
        status: payload.status,
        attempts: payload.attempts,
        runAfter: payload.runAfter,
        lastError: payload.lastError,
      },
    });
    if (payload.status === "queued") {
      await this.updateJobProgress(job.id, {
        stage: "queued",
        label: payload.lastError ? "等待重试" : "等待执行",
        detail: payload.lastError ? `任务已重新排队：${payload.lastError}` : "索引任务已进入队列。",
        percent: 0,
      });
    } else if (payload.status === "running") {
      await this.updateJobProgress(job.id, {
        stage: "loading_source",
        label: "开始处理",
        detail: "索引 worker 已开始处理任务。",
        percent: 0.02,
      });
    } else if (payload.status === "succeeded") {
      await this.updateJobProgress(job.id, {
        stage: "completed",
        label: "索引完成",
        detail: "索引任务已完成。",
        percent: 1,
      });
    } else if (payload.status === "cancelled") {
      const progress = this.parseJobPayload(current.payloadJson).progress;
      await this.updateJobProgress(job.id, {
        stage: "cancelled",
        label: "任务已取消",
        detail: payload.lastError ?? "索引任务已取消。",
        current: progress?.current,
        total: progress?.total,
        documents: progress?.documents,
        chunks: progress?.chunks,
        percent: progress?.percent ?? 0,
      });
    } else if (payload.status === "failed") {
      await this.updateJobProgress(job.id, {
        stage: "failed",
        label: "索引失败",
        detail: payload.lastError ?? "索引任务失败。",
        percent: 1,
      });
    }
    await syncDocumentIndexStatus(
      job.ownerType as RagOwnerType,
      job.ownerId,
      payload.status,
      job.jobType as RagJobType,
      job.id,
    );
    return job;
  }

  async listJobs(limit = 100, status?: RagJobStatus) {
    return prisma.ragIndexJob.findMany({
      where: status ? { status } : {},
      orderBy: [{ updatedAt: "desc" }, { createdAt: "desc" }],
      take: Math.min(Math.max(limit, 1), 500),
    });
  }

  async listJobSummaries(limit = 100, status?: RagJobStatus): Promise<RagJobSummaryRecord[]> {
    const jobs = await this.listJobs(limit, status);
    return jobs.map((job) => this.serializeJob(job));
  }

  async processJob(job: RagIndexJob): Promise<{ chunks: number }> {
    await getRagEmbeddingSettings();
    await this.assertJobNotCancelled(job.id);
    const tenantId = job.tenantId || ragConfig.defaultTenantId;
    const ownerType = job.ownerType as RagOwnerType;
    const jobType = job.jobType as RagJobType;
    if (jobType === "delete") {
      await this.updateJobProgress(job.id, {
        stage: "deleting_existing",
        label: "清理旧索引",
        detail: "正在删除现有知识库索引。",
        percent: 0.4,
      });
      const result = await this.deleteOwnerChunks(ownerType, job.ownerId, tenantId, job.id);
      await this.updateJobProgress(job.id, {
        stage: "completed",
        label: "索引完成",
        detail: result.deleted > 0 ? `已删除 ${result.deleted} 条旧分块。` : "没有需要删除的旧分块。",
        current: result.deleted,
        total: result.deleted,
        chunks: result.deleted,
        percent: 1,
      });
      return { chunks: 0 };
    }
    return this.upsertOwnerChunks(ownerType, job.ownerId, tenantId, job.id);
  }

}
