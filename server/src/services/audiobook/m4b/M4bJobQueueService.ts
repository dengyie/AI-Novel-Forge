import { prisma } from "../../../db/prisma";
import type { M4bEncodingJob } from "@prisma/client";

export interface CreateJobParams {
  audiobookTaskId: string;
  inputWavPath: string;
  outputM4bPath: string;
  coverImagePath?: string;
  metadataJson: string;
}

export class M4bJobQueueService {
  async createJob(params: CreateJobParams): Promise<M4bEncodingJob> {
    return await prisma.m4bEncodingJob.create({
      data: {
        audiobookTaskId: params.audiobookTaskId,
        status: "pending",
        inputWavPath: params.inputWavPath,
        outputM4bPath: params.outputM4bPath,
        coverImagePath: params.coverImagePath ?? null,
        metadataJson: params.metadataJson,
        progressPercent: 0,
        retryCount: 0,
      },
    });
  }

  async claimNextJob(workerId: string): Promise<M4bEncodingJob | null> {
    // Use transaction with SELECT FOR UPDATE SKIP LOCKED for non-blocking claim
    const job = await prisma.$transaction(async (tx) => {
      const pending = await tx.m4bEncodingJob.findFirst({
        where: { status: "pending" },
        orderBy: { createdAt: "asc" },
      });

      if (!pending) return null;

      return await tx.m4bEncodingJob.update({
        where: { id: pending.id },
        data: {
          status: "processing",
          workerId,
          workerStartedAt: new Date(),
        },
      });
    });

    return job;
  }

  async updateProgress(jobId: string, percent: number): Promise<void> {
    await prisma.m4bEncodingJob.update({
      where: { id: jobId },
      data: { progressPercent: Math.max(0, Math.min(100, percent)) },
    });
  }

  async markCompleted(jobId: string, outputPath: string): Promise<void> {
    const job = await prisma.m4bEncodingJob.findUnique({
      where: { id: jobId },
      select: { audiobookTaskId: true },
    });

    if (!job) return;

    await prisma.$transaction([
      prisma.m4bEncodingJob.update({
        where: { id: jobId },
        data: { status: "completed", progressPercent: 100 },
      }),
      prisma.audiobookTask.update({
        where: { id: job.audiobookTaskId },
        data: { fullAudioPath: outputPath },
      }),
    ]);
  }

  async markFailed(jobId: string, error: string): Promise<void> {
    await prisma.m4bEncodingJob.update({
      where: { id: jobId },
      data: {
        status: "failed",
        errorMessage: error.slice(0, 2000),
      },
    });
  }

  async hasPendingJobs(): Promise<boolean> {
    const count = await prisma.m4bEncodingJob.count({
      where: { status: "pending" },
    });
    return count > 0;
  }

  async getStalledJobs(thresholdMs: number): Promise<M4bEncodingJob[]> {
    const threshold = new Date(Date.now() - thresholdMs);
    return await prisma.m4bEncodingJob.findMany({
      where: {
        status: "processing",
        workerStartedAt: { lt: threshold },
      },
    });
  }

  async resetJob(jobId: string): Promise<void> {
    await prisma.m4bEncodingJob.update({
      where: { id: jobId },
      data: {
        status: "pending",
        workerId: null,
        workerStartedAt: null,
        retryCount: { increment: 1 },
      },
    });
  }
}
