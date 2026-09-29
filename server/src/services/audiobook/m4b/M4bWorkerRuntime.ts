import { setTimeout as delay } from "node:timers/promises";
import { prisma } from "../../../db/prisma";
import type { M4bEncodingJob } from "@prisma/client";
import { M4bJobQueueService } from "./M4bJobQueueService";
import { executeM4bEncoding } from "./M4bEncodingCore";

const POLL_MS = 1_000;

export async function executeWorkerJob(job: M4bEncodingJob, shutdownSignal: AbortSignal): Promise<void> {
  const queue = new M4bJobQueueService();
  const controller = new AbortController();
  const abort = () => controller.abort();
  shutdownSignal.addEventListener("abort", abort, { once: true });
  if (shutdownSignal.aborted) abort();
  let checking = false;
  const check = async () => {
    if (checking) return;
    checking = true;
    try { if (!await queue.isCurrent(job)) abort(); }
    catch { abort(); } // loss of ownership visibility must stop external work
    finally { checking = false; }
  };
  const timer = setInterval(() => { void check(); }, POLL_MS);
  try {
    await check();
    if (controller.signal.aborted) throw new Error("M4b generation cancelled");
    const metadata = JSON.parse(job.metadataJson);
    if (!metadata || !Array.isArray(metadata.chapters)) throw new Error("Invalid M4b metadata");
    let previousBytes = 0;
    const result = await executeM4bEncoding({
      sourceWavPath: job.inputWavPath, outputM4bPath: job.outputM4bPath,
      bookTitle: metadata.title, chapters: metadata.chapters,
      signal: controller.signal,
      onProcess: (pid, partPath) => {
        if (process.connected) process.send?.({ type: "m4b-owned-process", pid, partPath }, () => undefined);
      },
      publish: (partPath) => queue.publish(job, partPath, controller.signal),
      onProgress: ({ partBytes }) => {
        if (partBytes <= previousBytes) return;
        previousBytes = partBytes;
        void queue.updateProgress(job, Math.min(95, partBytes / 104857.6)).catch(abort);
      },
    });
    if (!result.success) throw new Error(result.error ?? "M4b encoding failed");
  } catch (error) {
    // On process shutdown manager recovers the lease after ffmpeg has stopped.
    if (!shutdownSignal.aborted) await queue.markFailed(job, error instanceof Error ? error.message : String(error));
  } finally {
    clearInterval(timer);
    shutdownSignal.removeEventListener("abort", abort);
  }
}

export async function runM4bWorker(signal: AbortSignal, workerId = String(process.pid)): Promise<void> {
  const queue = new M4bJobQueueService();
  const idleMs = Math.max(100, Number(process.env.M4B_WORKER_IDLE_TIMEOUT_MS) || 60_000);
  const heartbeat = () => prisma.workerHeartbeat.upsert({ where: { workerId },
    create: { workerId, processType: "m4b-worker", lastSeenAt: new Date() }, update: { lastSeenAt: new Date() } });
  await heartbeat();
  const timer = setInterval(() => { void heartbeat().catch(() => undefined); }, 10_000);
  let lastJobAt = Date.now();
  try {
    while (!signal.aborted) {
      const job = await queue.claimNextJob(workerId);
      if (job) {
        await executeWorkerJob(job, signal);
        lastJobAt = Date.now();
      } else {
        if (Date.now() - lastJobAt >= idleMs) break;
        await delay(Math.min(POLL_MS, idleMs), undefined, { signal }).catch(() => undefined);
      }
    }
  } finally {
    clearInterval(timer);
    await prisma.workerHeartbeat.deleteMany({ where: { workerId } });
  }
}
