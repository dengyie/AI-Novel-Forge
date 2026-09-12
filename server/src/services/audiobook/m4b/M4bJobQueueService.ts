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
    // 原子 claim：updateMany 带守卫条件单语句翻转状态，避免 findFirst+update
    // 事务的持锁窗口（SQLite 下并发写锁竞争放大为 SQLITE_BUSY/P2024）。
    // SQLite 无 updateMany 的 returning，先取最老 pending 的 id 再守卫式更新，
    // 更新数为 0 说明已被其他 worker 领走，返回 null 等待下一轮。
    const oldest = await prisma.m4bEncodingJob.findFirst({
      where: { status: "pending" },
      orderBy: { createdAt: "asc" },
      select: { id: true },
    });
    if (!oldest) return null;

    const claimed = await prisma.m4bEncodingJob.updateMany({
      where: { id: oldest.id, status: "pending" },
      data: {
        status: "processing",
        workerId,
        workerStartedAt: new Date(),
      },
    });
    if (claimed.count === 0) return null;

    return await prisma.m4bEncodingJob.findUniqueOrThrow({
      where: { id: oldest.id },
    });
  }

  async updateProgress(jobId: string, percent: number): Promise<void> {
    await prisma.m4bEncodingJob.update({
      where: { id: jobId },
      data: { progressPercent: Math.max(0, Math.min(100, percent)) },
    });
  }

  async markCompleted(jobId: string): Promise<void> {
    // 只更新 job 行；m4b 交付路由以磁盘文件为准（resolveFullBookM4bPath），
    // 不写 AudiobookTask.fullAudioPath——该字段既有语义固定指向 full-book.wav，
    // 被 /audio/full 的 streamWavFile 消费，写入 m4b 路径会破坏 WAV 播放。
    await prisma.m4bEncodingJob.update({
      where: { id: jobId },
      data: { status: "completed", progressPercent: 100 },
    });
  }

  /** 同任务重跑时 audiobookTaskId 唯一约束冲突（P2002），重置已有 job 重新入队。 */
  async requeueJobForTask(params: CreateJobParams): Promise<M4bEncodingJob> {
    return await prisma.m4bEncodingJob.update({
      where: { audiobookTaskId: params.audiobookTaskId },
      data: {
        status: "pending",
        workerId: null,
        workerStartedAt: null,
        inputWavPath: params.inputWavPath,
        outputM4bPath: params.outputM4bPath,
        coverImagePath: params.coverImagePath ?? null,
        metadataJson: params.metadataJson,
        progressPercent: 0,
        errorMessage: null,
        retryCount: 0,
      },
    });
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
