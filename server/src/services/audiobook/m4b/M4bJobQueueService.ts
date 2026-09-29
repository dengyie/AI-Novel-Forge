import { settleCurrentM4bTask } from "./M4bTaskSettlement";
import fs from "node:fs";
import { randomUUID } from "node:crypto";
import { prisma } from "../../../db/prisma";
import type { M4bEncodingJob, Prisma } from "@prisma/client";

export interface CreateJobParams {
  audiobookTaskId: string;
  generationToken: string;
  inputWavPath: string;
  outputM4bPath: string;
  coverImagePath?: string;
  metadataJson: string;
}

function ownership(job: M4bEncodingJob) {
  return { id: job.id, status: "processing", leaseToken: job.leaseToken, generationToken: job.generationToken };
}

async function lockCurrentTask(tx: Prisma.TransactionClient, taskId: string, generationToken: string) {
  const locked = await tx.audiobookTask.updateMany({
    where: { id: taskId, m4bGenerationToken: generationToken, cancelRequestedAt: null,
      status: { in: ["running", "succeeded"] } },
    data: { m4bGenerationToken: generationToken },
  });
  return locked.count > 0;
}

export class M4bJobQueueService {
  async createJob(params: CreateJobParams): Promise<M4bEncodingJob> {
    return prisma.$transaction(async (tx) => {
      if (!await lockCurrentTask(tx, params.audiobookTaskId, params.generationToken)) throw new Error("M4B generation is no longer current");
      return tx.m4bEncodingJob.create({ data: { ...params, status: "pending" } });
    });
  }

  async requeueJobForTask(params: CreateJobParams): Promise<M4bEncodingJob> {
    return prisma.$transaction(async (tx) => {
      if (!await lockCurrentTask(tx, params.audiobookTaskId, params.generationToken)) throw new Error("M4B generation is no longer current");
      const current = await tx.m4bEncodingJob.findUniqueOrThrow({ where: { audiobookTaskId: params.audiobookTaskId } });
      if (current.generationToken === params.generationToken && ["pending", "processing"].includes(current.status)) return current;
      return tx.m4bEncodingJob.update({
        where: { audiobookTaskId: params.audiobookTaskId },
        data: { ...params, status: "pending", workerId: null, workerStartedAt: null,
          leaseToken: null, lastProgressAt: null, progressPercent: 0, errorMessage: null, retryCount: 0 },
      });
    });
  }

  async claimNextJob(workerId: string): Promise<M4bEncodingJob | null> {
    const oldest = await prisma.m4bEncodingJob.findFirst({
      where: { status: "pending" }, orderBy: { createdAt: "asc" },
    });
    if (!oldest) return null;
    const leaseToken = randomUUID();
    const claimed = await prisma.m4bEncodingJob.updateMany({
      where: { id: oldest.id, status: "pending", generationToken: oldest.generationToken },
      data: { status: "processing", workerId, leaseToken, workerStartedAt: new Date(), lastProgressAt: new Date() },
    });
    if (!claimed.count) return null;
    return prisma.m4bEncodingJob.findFirst({ where: { id: oldest.id, leaseToken } });
  }

  async isCurrent(job: M4bEncodingJob): Promise<boolean> {
    if (!job.generationToken || !job.leaseToken) return false;
    return (await prisma.m4bEncodingJob.count({ where: {
      ...ownership(job), audiobookTask: { m4bGenerationToken: job.generationToken,
        cancelRequestedAt: null, status: { in: ["running", "succeeded"] } },
    } })) > 0;
  }

  async updateProgress(job: M4bEncodingJob, percent: number): Promise<void> {
    await prisma.m4bEncodingJob.updateMany({ where: ownership(job),
      data: { progressPercent: Math.max(0, Math.min(100, percent)), lastProgressAt: new Date() } });
  }

  /** The task row write lock serializes publication with every persisted generation rotation.
   * Lock order is task -> job. No encoding or external IO belongs in this short transaction.
   */
  async publish(job: M4bEncodingJob, partPath: string, signal?: AbortSignal): Promise<void> {
    if (!job.generationToken || !job.leaseToken) throw new Error("M4B ownership is missing");
    const generationToken = job.generationToken;
    await prisma.$transaction(async (tx) => {
      if (!await lockCurrentTask(tx, job.audiobookTaskId, generationToken)) throw new Error("M4B generation is no longer current");
      const lease = await tx.m4bEncodingJob.updateMany({ where: ownership(job),
        data: { status: "completed", progressPercent: 100 } });
      if (!lease.count || signal?.aborted) throw new Error("M4B worker lease was revoked");
      // Synchronous rename happens while both DB write locks remain held. A rotation
      // either precedes the guarded write (reject) or follows commit (then wipes output).
      fs.renameSync(partPath, job.outputM4bPath);
      await settleCurrentM4bTask(tx, job.audiobookTaskId, generationToken);
    });
  }

  async markFailed(job: M4bEncodingJob, error: string): Promise<void> {
    if (!job.generationToken) return;
    const generationToken = job.generationToken;
    await prisma.$transaction(async (tx) => {
      if (!await lockCurrentTask(tx, job.audiobookTaskId, generationToken)) {
        await tx.m4bEncodingJob.updateMany({ where: ownership(job),
          data: { status: "failed", errorMessage: "M4B generation is no longer current" } });
        return;
      }
      const changed = await tx.m4bEncodingJob.updateMany({ where: ownership(job),
        data: { status: "failed", errorMessage: error.slice(0, 2000) } });
      if (changed.count) await settleCurrentM4bTask(tx, job.audiobookTaskId, generationToken);
    });
  }

  async hasPendingJobs(): Promise<boolean> {
    return (await prisma.m4bEncodingJob.count({ where: { status: "pending" } })) > 0;
  }

  async getStalledJobs(thresholdMs: number): Promise<M4bEncodingJob[]> {
    return prisma.m4bEncodingJob.findMany({ where: {
      status: "processing", lastProgressAt: { lt: new Date(Date.now() - thresholdMs) },
    } });
  }

  async resetJob(job: M4bEncodingJob): Promise<void> {
    if (!job.generationToken) return;
    const generationToken = job.generationToken;
    await prisma.$transaction(async (tx) => {
      if (!await lockCurrentTask(tx, job.audiobookTaskId, generationToken)) {
        await tx.m4bEncodingJob.updateMany({ where: ownership(job),
          data: { status: "failed", errorMessage: "M4B generation is no longer current" } });
        return;
      }
      const changed = await tx.m4bEncodingJob.updateMany({ where: ownership(job), data: {
        status: job.retryCount < 1 ? "pending" : "failed", workerId: null,
        workerStartedAt: null, leaseToken: null, lastProgressAt: null,
        retryCount: { increment: 1 }, errorMessage: "M4B worker stopped before completion",
      } });
      if (changed.count) await settleCurrentM4bTask(tx, job.audiobookTaskId, generationToken);
    });
  }

  async recoverJobsForWorker(workerId: string): Promise<{ requeued: number; failed: number }> {
    const jobs = await prisma.m4bEncodingJob.findMany({ where: { status: "processing", workerId } });
    let requeued = 0; let failed = 0;
    for (const job of jobs) {
      await this.resetJob(job);
      if (job.retryCount < 1) requeued++; else failed++;
    }
    return { requeued, failed };
  }
}
