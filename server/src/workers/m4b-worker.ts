import "dotenv/config";
import fs from "node:fs";
import { prisma } from "../db/prisma";
import { M4bJobQueueService } from "../services/audiobook/m4b/M4bJobQueueService";
import { executeM4bEncoding } from "../services/audiobook/m4b/M4bEncodingCore";

const IDLE_TIMEOUT_MS = Number(process.env.M4B_WORKER_IDLE_TIMEOUT_MS) || 60_000;
const HEARTBEAT_INTERVAL_MS = 10_000;
const PROGRESS_UPDATE_INTERVAL_MS = 5_000;
const POLL_INTERVAL_MS = 5_000;
const WORKER_ID = process.env.M4B_WORKER_ID || `${process.pid}`;
const LOG_PATH = process.env.M4B_WORKER_LOG_PATH;

function log(message: string) {
  const timestamp = new Date().toISOString();
  const line = `[${timestamp}] [worker-${WORKER_ID}] ${message}\n`;
  if (LOG_PATH) {
    try {
      fs.appendFileSync(LOG_PATH, line);
    } catch {
      console.error(line.trim());
    }
  } else {
    console.log(line.trim());
  }
}

async function registerHeartbeat() {
  try {
    await prisma.workerHeartbeat.upsert({
      where: { workerId: WORKER_ID },
      create: {
        workerId: WORKER_ID,
        processType: "m4b-worker",
        lastSeenAt: new Date(),
      },
      update: {
        lastSeenAt: new Date(),
      },
    });
  } catch (error) {
    log(`Heartbeat update failed: ${error instanceof Error ? error.message : String(error)}`);
  }
}

async function pollAndExecute() {
  const queueService = new M4bJobQueueService();
  let lastJobAt = Date.now();
  let heartbeatTimer: NodeJS.Timeout | null = null;

  heartbeatTimer = setInterval(() => {
    registerHeartbeat().catch(() => {});
  }, HEARTBEAT_INTERVAL_MS);

  try {
    await registerHeartbeat();
    log("Worker started, polling for jobs");

    while (true) {
      const job = await queueService.claimNextJob(WORKER_ID);

      if (!job) {
        const idleMs = Date.now() - lastJobAt;
        if (idleMs >= IDLE_TIMEOUT_MS) {
          log(`No pending jobs for ${Math.round(idleMs / 1000)}s, exiting`);
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
        continue;
      }

      lastJobAt = Date.now();
      log(`Claimed job ${job.id} for task ${job.audiobookTaskId}`);

      try {
        let metadata: { title: string; chapters: Array<{ title: string; startMs: number; endMs: number }> };
        try {
          metadata = JSON.parse(job.metadataJson);
        } catch {
          await queueService.markFailed(job.id, "Invalid metadata JSON");
          log(`Job ${job.id} failed: invalid metadata`);
          continue;
        }

        let lastProgressUpdate = Date.now();
        const result = await executeM4bEncoding({
          sourceWavPath: job.inputWavPath,
          outputM4bPath: job.outputM4bPath,
          bookTitle: metadata.title,
          chapters: metadata.chapters,
          onProgress: (progress) => {
            const now = Date.now();
            if (now - lastProgressUpdate >= PROGRESS_UPDATE_INTERVAL_MS) {
              const percent = Math.min(95, (progress.partBytes / (10 * 1024 * 1024)) * 100);
              queueService.updateProgress(job.id, percent).catch(() => {});
              lastProgressUpdate = now;
            }
          },
        });

        if (result.success) {
          await queueService.markCompleted(job.id, result.outputPath!);
          log(`Job ${job.id} completed: ${result.outputPath}`);
        } else {
          await queueService.markFailed(job.id, result.error || "Unknown error");
          log(`Job ${job.id} failed: ${result.error}`);
        }
      } catch (error) {
        const errorMsg = error instanceof Error ? error.message : String(error);
        await queueService.markFailed(job.id, errorMsg);
        log(`Job ${job.id} failed with exception: ${errorMsg}`);
      }

      await registerHeartbeat();
    }
  } finally {
    if (heartbeatTimer) clearInterval(heartbeatTimer);
    try {
      await prisma.workerHeartbeat.delete({ where: { workerId: WORKER_ID } });
    } catch {
      // ignore cleanup errors
    }
    await prisma.$disconnect();
  }
}

pollAndExecute()
  .then(() => {
    log("Worker exiting normally");
    process.exit(0);
  })
  .catch((error) => {
    log(`Worker crashed: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  });
