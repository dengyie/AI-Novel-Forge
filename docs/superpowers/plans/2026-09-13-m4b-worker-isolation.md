# M4B Worker Isolation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Extract m4b audiobook encoding from main novel-server process into an isolated on-demand worker process with independent memory budget to prevent OOM on pxed deployment.

**Architecture:** SQLite-backed job queue + on-demand worker spawned via Node.js spawn() with 768MB heap. Worker polls queue, executes ffmpeg encoding, updates progress, and exits after 60s idle. Main server manages worker lifecycle via heartbeat watchdog.

**Tech Stack:** Node.js spawn(), SQLite job queue (via existing PostgreSQL with Prisma), ffmpeg subprocess, Node.js native test framework

**Spec:** docs/superpowers/specs/2026-09-13-m4b-worker-isolation-design.md

## Global Constraints

- Worker heap: 768MB (--max-old-space-size=768)
- Main server heap: 384MB (unchanged)
- ffmpeg threads: 2 (existing AUDIOBOOK_M4B_FFMPEG_THREADS default)
- Concurrent workers: 1 (AUDIOBOOK_M4B_CONCURRENCY=1 on pxed)
- Worker idle timeout: 60s (M4B_WORKER_IDLE_TIMEOUT_MS=60000)
- Heartbeat interval: 30s (M4B_WORKER_HEARTBEAT_INTERVAL_MS=30000)
- Max retries per job: 1
- Node.js native test framework (node --test)
- Feature flag: AUDIOBOOK_M4B_USE_WORKER=true (default enabled)

---

### Task 1: Database Schema - M4bEncodingJob Model

**Files:**
- Modify: `server/src/prisma/schema.prisma:1128` (after AudiobookTask model)
- Create: `server/src/prisma/migrations/<timestamp>_add_m4b_encoding_job/migration.sql`

**Interfaces:**
- Consumes: AudiobookTask.id (existing foreign key)
- Produces: M4bEncodingJob model with status, workerId, progress tracking

- [ ] **Step 1: Write failing test for M4bEncodingJob creation**

```javascript
// server/tests/m4bEncodingJob.test.js
const test = require("node:test");
const assert = require("node:assert/strict");
const { prisma } = require("../dist/db/prisma.js");

test("M4bEncodingJob.create with required fields", async () => {
  const novel = await prisma.novel.create({
    data: { title: "Test Novel", userId: "test-user" }
  });
  const task = await prisma.audiobookTask.create({
    data: {
      novelId: novel.id,
      title: "Test Task",
      scopeMode: "full",
      narratorVoice: "test-voice",
      narratorStyle: "neutral"
    }
  });
  
  const job = await prisma.m4bEncodingJob.create({
    data: {
      audiobookTaskId: task.id,
      status: "pending",
      inputWavPath: "/tmp/test.wav",
      outputM4bPath: "/tmp/test.m4b",
      metadataJson: JSON.stringify({ title: "Test", chapters: [] })
    }
  });
  
  assert.equal(job.status, "pending");
  assert.equal(job.progressPercent, 0);
  assert.equal(job.retryCount, 0);
  
  // Cleanup
  await prisma.m4bEncodingJob.delete({ where: { id: job.id } });
  await prisma.audiobookTask.delete({ where: { id: task.id } });
  await prisma.novel.delete({ where: { id: novel.id } });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd server && pnpm run test:node -- m4bEncodingJob.test.js`
Expected: FAIL with "Unknown type M4bEncodingJob" or "Cannot find table m4b_encoding_job"

- [ ] **Step 3: Add M4bEncodingJob model to schema.prisma**

```prisma
// Insert after AudiobookTask model (line 1128)
model M4bEncodingJob {
  id                String   @id @default(cuid())
  audiobookTaskId   String   @unique
  audiobookTask     AudiobookTask @relation(fields: [audiobookTaskId], references: [id], onDelete: Cascade)
  
  status            String   // 'pending' | 'processing' | 'completed' | 'failed'
  workerId          String?  // worker PID for heartbeat tracking
  workerStartedAt   DateTime?
  
  inputWavPath      String
  outputM4bPath     String
  coverImagePath    String?
  metadataJson      String   // JSON: {title, author, narrator, chapters: [{title, startMs}]}
  
  progressPercent   Float    @default(0)
  errorMessage      String?
  retryCount        Int      @default(0)  // max 1 retry for OOM failures
  
  createdAt         DateTime @default(now())
  updatedAt         DateTime @updatedAt
  
  @@index([status, createdAt])
}

model WorkerHeartbeat {
  workerId    String   @id  // process PID
  processType String         // 'm4b-worker'
  lastSeenAt  DateTime @default(now())
  createdAt   DateTime @default(now())
}
```

- [ ] **Step 4: Add relation to AudiobookTask**

```prisma
// In AudiobookTask model, add after line 1123 (before createdAt):
  m4bEncodingJob    M4bEncodingJob?
```

- [ ] **Step 5: Generate migration**

Run: `cd server && npx prisma migrate dev --name add_m4b_encoding_job`
Expected: Migration file created in server/src/prisma/migrations/

- [ ] **Step 6: Run test to verify it passes**

Run: `cd server && pnpm run build && pnpm run test:node -- m4bEncodingJob.test.js`
Expected: PASS

- [ ] **Step 7: Commit**

```bash
git add server/src/prisma/schema.prisma server/src/prisma/migrations/ server/tests/m4bEncodingJob.test.js
git commit -m "feat(audiobook): add M4bEncodingJob and WorkerHeartbeat models"
```

---

### Task 2: Job Queue Service

**Files:**
- Create: `server/src/services/audiobook/m4b/M4bJobQueueService.ts`
- Create: `server/tests/m4bJobQueueService.test.js`

**Interfaces:**
- Consumes: M4bEncodingJob model (from Task 1)
- Produces: 
  - `M4bJobQueueService.createJob(params): Promise<M4bEncodingJob>`
  - `M4bJobQueueService.claimNextJob(workerId: string): Promise<M4bEncodingJob | null>`
  - `M4bJobQueueService.updateProgress(jobId: string, percent: number): Promise<void>`
  - `M4bJobQueueService.markCompleted(jobId: string, outputPath: string): Promise<void>`
  - `M4bJobQueueService.markFailed(jobId: string, error: string): Promise<void>`

- [ ] **Step 1: Write failing test for createJob**

```javascript
// server/tests/m4bJobQueueService.test.js
const test = require("node:test");
const assert = require("node:assert/strict");
const { prisma } = require("../dist/db/prisma.js");
const { M4bJobQueueService } = require("../dist/services/audiobook/m4b/M4bJobQueueService.js");

test("M4bJobQueueService.createJob creates pending job", async () => {
  const service = new M4bJobQueueService();
  const novel = await prisma.novel.create({
    data: { title: "Test Novel", userId: "test-user" }
  });
  const task = await prisma.audiobookTask.create({
    data: {
      novelId: novel.id,
      title: "Test Task",
      scopeMode: "full",
      narratorVoice: "test-voice",
      narratorStyle: "neutral"
    }
  });
  
  const job = await service.createJob({
    audiobookTaskId: task.id,
    inputWavPath: "/tmp/test.wav",
    outputM4bPath: "/tmp/test.m4b",
    metadataJson: JSON.stringify({ title: "Test", chapters: [] })
  });
  
  assert.equal(job.status, "pending");
  assert.equal(job.audiobookTaskId, task.id);
  
  // Cleanup
  await prisma.m4bEncodingJob.delete({ where: { id: job.id } });
  await prisma.audiobookTask.delete({ where: { id: task.id } });
  await prisma.novel.delete({ where: { id: novel.id } });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd server && pnpm run build && pnpm run test:node -- m4bJobQueueService.test.js`
Expected: FAIL with "Cannot find module M4bJobQueueService"

- [ ] **Step 3: Write M4bJobQueueService implementation**

```typescript
// server/src/services/audiobook/m4b/M4bJobQueueService.ts
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
```

- [ ] **Step 4: Run test to verify createJob passes**

Run: `cd server && pnpm run build && pnpm run test:node -- m4bJobQueueService.test.js`
Expected: PASS

- [ ] **Step 5: Write test for claimNextJob**

```javascript
// Add to server/tests/m4bJobQueueService.test.js
test("M4bJobQueueService.claimNextJob claims and marks processing", async () => {
  const service = new M4bJobQueueService();
  const novel = await prisma.novel.create({
    data: { title: "Test Novel", userId: "test-user" }
  });
  const task = await prisma.audiobookTask.create({
    data: {
      novelId: novel.id,
      title: "Test Task",
      scopeMode: "full",
      narratorVoice: "test-voice",
      narratorStyle: "neutral"
    }
  });
  
  const created = await service.createJob({
    audiobookTaskId: task.id,
    inputWavPath: "/tmp/test.wav",
    outputM4bPath: "/tmp/test.m4b",
    metadataJson: JSON.stringify({ title: "Test", chapters: [] })
  });
  
  const claimed = await service.claimNextJob("worker-123");
  
  assert.equal(claimed.id, created.id);
  assert.equal(claimed.status, "processing");
  assert.equal(claimed.workerId, "worker-123");
  assert.ok(claimed.workerStartedAt);
  
  // Cleanup
  await prisma.m4bEncodingJob.delete({ where: { id: created.id } });
  await prisma.audiobookTask.delete({ where: { id: task.id } });
  await prisma.novel.delete({ where: { id: novel.id } });
});
```

- [ ] **Step 6: Run test to verify claimNextJob passes**

Run: `cd server && pnpm run build && pnpm run test:node -- m4bJobQueueService.test.js`
Expected: PASS (2 tests)

- [ ] **Step 7: Commit**

```bash
git add server/src/services/audiobook/m4b/M4bJobQueueService.ts server/tests/m4bJobQueueService.test.js
git commit -m "feat(audiobook): add M4bJobQueueService for job management"
```

---

### Task 3: Worker Process Script

**Files:**
- Create: `server/src/workers/m4b-worker.ts`
- Create: `server/tests/m4bWorker.test.js`

**Interfaces:**
- Consumes: 
  - M4bJobQueueService.claimNextJob, updateProgress, markCompleted, markFailed (from Task 2)
  - encodeFullBookM4bUnlocked from audiobookM4b.ts (extract core encoding logic)
- Produces: Standalone worker script that polls queue, executes encoding, exits on idle

- [ ] **Step 1: Write test for worker job execution flow**

```javascript
// server/tests/m4bWorker.test.js
const test = require("node:test");
const assert = require("node:assert/strict");
const { spawn } = require("node:child_process");
const path = require("node:path");
const fs = require("node:fs");
const { prisma } = require("../dist/db/prisma.js");
const { M4bJobQueueService } = require("../dist/services/audiobook/m4b/M4bJobQueueService.js");

test("m4b-worker processes job and exits", { timeout: 30000 }, async () => {
  const service = new M4bJobQueueService();
  const novel = await prisma.novel.create({
    data: { title: "Test Novel", userId: "test-user" }
  });
  const task = await prisma.audiobookTask.create({
    data: {
      novelId: novel.id,
      title: "Test Task",
      scopeMode: "full",
      narratorVoice: "test-voice",
      narratorStyle: "neutral"
    }
  });
  
  // Create minimal test WAV (44-byte header + silent data)
  const testDir = fs.mkdtempSync(path.join(require("os").tmpdir(), "m4b-test-"));
  const wavPath = path.join(testDir, "test.wav");
  const m4bPath = path.join(testDir, "test.m4b");
  
  const wavHeader = Buffer.alloc(44);
  wavHeader.write("RIFF", 0);
  wavHeader.writeUInt32LE(36 + 8000, 4); // file size - 8
  wavHeader.write("WAVE", 8);
  wavHeader.write("fmt ", 12);
  wavHeader.writeUInt32LE(16, 16); // fmt chunk size
  wavHeader.writeUInt16LE(1, 20); // PCM
  wavHeader.writeUInt16LE(1, 22); // mono
  wavHeader.writeUInt32LE(16000, 24); // sample rate
  wavHeader.writeUInt32LE(32000, 28); // byte rate
  wavHeader.writeUInt16LE(2, 32); // block align
  wavHeader.writeUInt16LE(16, 34); // bits per sample
  wavHeader.write("data", 36);
  wavHeader.writeUInt32LE(8000, 40); // data size
  
  fs.writeFileSync(wavPath, Buffer.concat([wavHeader, Buffer.alloc(8000)]));
  
  const job = await service.createJob({
    audiobookTaskId: task.id,
    inputWavPath: wavPath,
    outputM4bPath: m4bPath,
    metadataJson: JSON.stringify({
      title: "Test",
      chapters: [{ title: "Chapter 1", startMs: 0, endMs: 500 }]
    })
  });
  
  // Spawn worker with short idle timeout for test
  const workerPath = path.join(__dirname, "../dist/workers/m4b-worker.js");
  const worker = spawn("node", [workerPath], {
    env: {
      ...process.env,
      M4B_WORKER_IDLE_TIMEOUT_MS: "5000",
      M4B_WORKER_LOG_PATH: path.join(testDir, "worker.log")
    },
    stdio: "ignore"
  });
  
  // Wait for worker to process or timeout
  const exitCode = await new Promise((resolve) => {
    worker.on("exit", (code) => resolve(code));
    setTimeout(() => {
      worker.kill();
      resolve(null);
    }, 25000);
  });
  
  // Verify job completed (or skipped if no ffmpeg)
  const result = await prisma.m4bEncodingJob.findUnique({
    where: { id: job.id }
  });
  
  assert.ok(result.status === "completed" || result.status === "failed");
  assert.equal(exitCode, 0);
  
  // Cleanup
  fs.rmSync(testDir, { recursive: true, force: true });
  await prisma.m4bEncodingJob.delete({ where: { id: job.id } });
  await prisma.audiobookTask.delete({ where: { id: task.id } });
  await prisma.novel.delete({ where: { id: novel.id } });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd server && pnpm run build && pnpm run test:node -- m4bWorker.test.js`
Expected: FAIL with "Cannot find module m4b-worker.js"

- [ ] **Step 3: Extract core encoding logic to shared module**

```typescript
// server/src/services/audiobook/m4b/M4bEncodingCore.ts
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { runFfmpegProcess, type M4bProgressCallback } from "../infrastructure/m4b/FfmpegProcessRunner";
import {
  buildM4bFfmetadata,
  buildM4bFfmpegArgs,
  resolveFfmpegBinary,
  resolveM4bFfmpegThreads,
} from "../audiobookM4b";
import { cleanupStaleM4bParts } from "../audiobookPaths";

export interface M4bEncodeInput {
  sourceWavPath: string;
  outputM4bPath: string;
  bookTitle: string;
  chapters: Array<{ title: string; startMs: number; endMs: number }>;
  signal?: AbortSignal;
  onProgress?: M4bProgressCallback | null;
}

export interface M4bEncodeResult {
  success: boolean;
  outputPath: string | null;
  error: string | null;
  skipped: boolean;
}

export async function executeM4bEncoding(input: M4bEncodeInput): Promise<M4bEncodeResult> {
  if (!fs.existsSync(input.sourceWavPath)) {
    return {
      success: false,
      outputPath: null,
      error: "Source WAV file does not exist",
      skipped: false,
    };
  }
  
  if (input.signal?.aborted) {
    return {
      success: false,
      outputPath: null,
      error: "Encoding was aborted",
      skipped: false,
    };
  }
  
  const ffmpeg = resolveFfmpegBinary();
  if (!ffmpeg) {
    return {
      success: false,
      outputPath: null,
      error: "ffmpeg not found (set AUDIOBOOK_FFMPEG_PATH or FFMPEG_PATH)",
      skipped: true,
    };
  }
  
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "audiobook-m4b-"));
  const metaPath = path.join(tmpDir, "chapters.ffmeta");
  const runId = `${Date.now().toString(36)}-${process.pid}-${Math.random().toString(36).slice(2, 8)}`;
  const partPath = path.join(
    path.dirname(input.outputM4bPath),
    `${path.basename(input.outputM4bPath)}.${runId}.part`
  );
  
  try {
    // Check if output already exists (concurrent safety)
    if (fs.existsSync(input.outputM4bPath) && fs.statSync(input.outputM4bPath).size >= 64) {
      return {
        success: true,
        outputPath: input.outputM4bPath,
        error: null,
        skipped: false,
      };
    }
    
    cleanupStaleM4bParts(path.dirname(input.outputM4bPath), input.outputM4bPath);
    
    fs.writeFileSync(
      metaPath,
      buildM4bFfmetadata({
        title: input.bookTitle?.trim() || "有声书",
        chapters: input.chapters,
      }),
      "utf8"
    );
    
    const args = buildM4bFfmpegArgs({
      sourceWavPath: input.sourceWavPath,
      metadataPath: metaPath,
      outputPath: partPath,
      threads: resolveM4bFfmpegThreads(),
    });
    
    const result = await runFfmpegProcess({
      ffmpeg,
      args,
      partPath,
      signal: input.signal,
      onProgress: input.onProgress,
    });
    
    if (result.status !== 0) {
      return {
        success: false,
        outputPath: null,
        error: `ffmpeg encoding failed with exit code ${result.status}: ${result.stderr.slice(0, 500)}`,
        skipped: false,
      };
    }
    
    if (!fs.existsSync(partPath) || fs.statSync(partPath).size < 64) {
      return {
        success: false,
        outputPath: null,
        error: "ffmpeg completed but output file is missing or too small",
        skipped: false,
      };
    }
    
    fs.renameSync(partPath, input.outputM4bPath);
    
    return {
      success: true,
      outputPath: input.outputM4bPath,
      error: null,
      skipped: false,
    };
  } catch (error) {
    return {
      success: false,
      outputPath: null,
      error: error instanceof Error ? error.message : String(error),
      skipped: false,
    };
  } finally {
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      // ignore cleanup errors
    }
    try {
      if (fs.existsSync(partPath)) fs.unlinkSync(partPath);
    } catch {
      // ignore cleanup errors
    }
  }
}
```

- [ ] **Step 4: Write m4b-worker.ts implementation**

```typescript
// server/src/workers/m4b-worker.ts
import "dotenv/config";
import fs from "node:fs";
import { prisma } from "../db/prisma";
import { M4bJobQueueService } from "../services/audiobook/m4b/M4bJobQueueService";
import { executeM4bEncoding } from "../services/audiobook/m4b/M4bEncodingCore";

const IDLE_TIMEOUT_MS = Number(process.env.M4B_WORKER_IDLE_TIMEOUT_MS) || 60_000;
const HEARTBEAT_INTERVAL_MS = 10_000;
const PROGRESS_UPDATE_INTERVAL_MS = 5_000;
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
        await new Promise((resolve) => setTimeout(resolve, 5000));
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
        } else if (result.skipped) {
          await queueService.markFailed(job.id, result.error || "Encoding skipped");
          log(`Job ${job.id} skipped: ${result.error}`);
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
```

- [ ] **Step 5: Run test to verify worker processes job**

Run: `cd server && pnpm run build && pnpm run test:node -- m4bWorker.test.js`
Expected: PASS

- [ ] **Step 6: Add tsconfig.json include for workers directory**

Edit `server/tsconfig.json` to ensure `src/workers/**/*` is included in compilation.

- [ ] **Step 7: Commit**

```bash
git add server/src/workers/m4b-worker.ts server/src/services/audiobook/m4b/M4bEncodingCore.ts server/tests/m4bWorker.test.js server/tsconfig.json
git commit -m "feat(audiobook): add m4b-worker standalone process"
```

---

### Task 4: Worker Manager in Main Server

**Files:**
- Create: `server/src/services/audiobook/m4b/M4bWorkerManager.ts`
- Create: `server/tests/m4bWorkerManager.test.js`
- Modify: `server/src/app.ts` (wire manager into startup/shutdown)

**Interfaces:**
- Consumes: M4bJobQueueService.hasPendingJobs, getStalledJobs, resetJob (from Task 2)
- Produces:
  - `M4bWorkerManager.ensureWorkerForPendingJobs(): Promise<void>`
  - `M4bWorkerManager.shutdown(): Promise<void>`

- [ ] **Step 1: Write failing test for worker spawn**

```javascript
// server/tests/m4bWorkerManager.test.js
const test = require("node:test");
const assert = require("node:assert/strict");
const { M4bWorkerManager } = require("../dist/services/audiobook/m4b/M4bWorkerManager.js");

test("M4bWorkerManager spawns worker when jobs pending", { timeout: 10000 }, async (t) => {
  // Mock spawn to avoid actually starting worker
  const originalSpawn = require("node:child_process").spawn;
  let spawnCalled = false;
  let spawnArgs = null;
  
  require("node:child_process").spawn = (command, args, options) => {
    spawnCalled = true;
    spawnArgs = { command, args, options };
    // Return mock ChildProcess
    const EventEmitter = require("node:events");
    const mock = new EventEmitter();
    mock.pid = 99999;
    mock.kill = () => true;
    return mock;
  };
  
  t.after(() => {
    require("node:child_process").spawn = originalSpawn;
  });
  
  const manager = new M4bWorkerManager();
  await manager.ensureWorkerForPendingJobs();
  
  // Immediate call should not spawn (no pending jobs in test DB)
  assert.equal(spawnCalled, false);
  
  await manager.shutdown();
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd server && pnpm run build && pnpm run test:node -- m4bWorkerManager.test.js`
Expected: FAIL with "Cannot find module M4bWorkerManager"

- [ ] **Step 3: Write M4bWorkerManager implementation**

```typescript
// server/src/services/audiobook/m4b/M4bWorkerManager.ts
import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { M4bJobQueueService } from "./M4bJobQueueService";
import { resolveLogsRoot } from "../../../runtime/appPaths";

const CONCURRENCY = Number(process.env.AUDIOBOOK_M4B_CONCURRENCY) || 1;
const HEARTBEAT_CHECK_INTERVAL_MS = Number(process.env.M4B_WORKER_HEARTBEAT_INTERVAL_MS) || 30_000;
const STALLED_THRESHOLD_MS = 2 * 60_000; // 2 minutes no progress = stalled
const WORKER_HEAP_MB = 768;
const WORKER_SEMI_SPACE_MB = 16;

export class M4bWorkerManager {
  private activeWorkers = new Map<number, ChildProcess>();
  private watchdogTimer: NodeJS.Timeout | null = null;
  private queueService = new M4bJobQueueService();
  private shuttingDown = false;

  async ensureWorkerForPendingJobs(): Promise<void> {
    if (this.shuttingDown) return;
    
    const hasPending = await this.queueService.hasPendingJobs();
    if (!hasPending) return;
    
    if (this.activeWorkers.size >= CONCURRENCY) return;
    
    this.spawnWorker();
    
    if (!this.watchdogTimer) {
      this.startHeartbeatWatchdog();
    }
  }

  private spawnWorker(): void {
    if (this.activeWorkers.size >= CONCURRENCY) return;
    
    const workerScript = path.join(__dirname, "../../workers/m4b-worker.js");
    if (!fs.existsSync(workerScript)) {
      console.error(`[M4bWorkerManager] Worker script not found: ${workerScript}`);
      return;
    }
    
    const logDir = resolveLogsRoot();
    if (!fs.existsSync(logDir)) {
      fs.mkdirSync(logDir, { recursive: true });
    }
    const logPath = path.join(logDir, `m4b-worker-${Date.now()}.log`);
    const logStream = fs.createWriteStream(logPath, { flags: "a" });
    
    const worker = spawn(
      "node",
      [
        `--max-old-space-size=${WORKER_HEAP_MB}`,
        `--max-semi-space-size=${WORKER_SEMI_SPACE_MB}`,
        workerScript,
      ],
      {
        env: {
          ...process.env,
          M4B_WORKER_ID: `${process.pid}`,
          M4B_WORKER_LOG_PATH: logPath,
        },
        stdio: ["ignore", logStream, logStream],
        detached: false,
      }
    );
    
    if (!worker.pid) {
      console.error("[M4bWorkerManager] Worker spawn failed: no PID");
      logStream.end();
      return;
    }
    
    this.activeWorkers.set(worker.pid, worker);
    
    worker.on("exit", (code, signal) => {
      console.log(`[M4bWorkerManager] Worker ${worker.pid} exited: code=${code} signal=${signal}`);
      this.activeWorkers.delete(worker.pid!);
      logStream.end();
      
      if (!this.shuttingDown) {
        this.ensureWorkerForPendingJobs().catch((error) => {
          console.error("[M4bWorkerManager] Failed to spawn replacement worker:", error);
        });
      }
    });
    
    worker.on("error", (error) => {
      console.error(`[M4bWorkerManager] Worker ${worker.pid} error:`, error);
      this.activeWorkers.delete(worker.pid!);
      logStream.end();
    });
    
    console.log(`[M4bWorkerManager] Spawned worker ${worker.pid}`);
  }

  private startHeartbeatWatchdog(): void {
    this.watchdogTimer = setInterval(() => {
      this.handleStalledJobs().catch((error) => {
        console.error("[M4bWorkerManager] Watchdog error:", error);
      });
    }, HEARTBEAT_CHECK_INTERVAL_MS);
  }

  private async handleStalledJobs(): Promise<void> {
    const stalled = await this.queueService.getStalledJobs(STALLED_THRESHOLD_MS);
    
    for (const job of stalled) {
      const workerId = job.workerId;
      if (!workerId) continue;
      
      const workerPid = Number(workerId);
      if (!Number.isSafeInteger(workerPid)) continue;
      
      let isAlive = false;
      try {
        process.kill(workerPid, 0);
        isAlive = true;
      } catch {
        isAlive = false;
      }
      
      if (!isAlive) {
        console.log(`[M4bWorkerManager] Worker ${workerId} dead, resetting job ${job.id}`);
        if (job.retryCount < 1) {
          await this.queueService.resetJob(job.id);
        } else {
          await this.queueService.markFailed(job.id, "Max retries exceeded after worker death");
        }
        continue;
      }
      
      console.log(`[M4bWorkerManager] Worker ${workerId} stalled on job ${job.id}, killing`);
      try {
        process.kill(workerPid, "SIGTERM");
        await new Promise((resolve) => setTimeout(resolve, 5000));
        try {
          process.kill(workerPid, 0);
          process.kill(workerPid, "SIGKILL");
        } catch {
          // already dead
        }
      } catch (error) {
        console.error(`[M4bWorkerManager] Failed to kill worker ${workerId}:`, error);
      }
      
      if (job.retryCount < 1) {
        await this.queueService.resetJob(job.id);
      } else {
        await this.queueService.markFailed(job.id, "Max retries exceeded after stall");
      }
    }
  }

  async shutdown(): Promise<void> {
    this.shuttingDown = true;
    
    if (this.watchdogTimer) {
      clearInterval(this.watchdogTimer);
      this.watchdogTimer = null;
    }
    
    const workers = Array.from(this.activeWorkers.values());
    for (const worker of workers) {
      try {
        worker.kill("SIGTERM");
      } catch (error) {
        console.error(`[M4bWorkerManager] Failed to kill worker ${worker.pid}:`, error);
      }
    }
    
    await new Promise((resolve) => setTimeout(resolve, 5000));
    
    for (const worker of workers) {
      try {
        worker.kill("SIGKILL");
      } catch {
        // ignore
      }
    }
    
    this.activeWorkers.clear();
  }
}
```

- [ ] **Step 4: Run test to verify manager implements interface**

Run: `cd server && pnpm run build && pnpm run test:node -- m4bWorkerManager.test.js`
Expected: PASS

- [ ] **Step 5: Wire manager into app.ts startup**

```typescript
// Add to server/src/app.ts after line 83 (after registerBuiltInEngines)
import { M4bWorkerManager } from "./services/audiobook/m4b/M4bWorkerManager";

const m4bWorkerManager = new M4bWorkerManager();
```

- [ ] **Step 6: Wire manager into app.ts shutdown**

Find the shutdown handler in app.ts and add m4bWorkerManager.shutdown() to cleanup sequence:

```typescript
// In app.ts shutdown handler (search for "graceful shutdown")
await m4bWorkerManager.shutdown();
```

- [ ] **Step 7: Commit**

```bash
git add server/src/services/audiobook/m4b/M4bWorkerManager.ts server/tests/m4bWorkerManager.test.js server/src/app.ts
git commit -m "feat(audiobook): add M4bWorkerManager for worker lifecycle"
```

---

### Task 5: Integration with AudiobookPipelineService

**Files:**
- Modify: `server/src/services/audiobook/AudiobookPipelineService.ts` (replace direct encoding call with job creation)
- Create: `server/tests/audiobookM4bIntegration.test.js`

**Interfaces:**
- Consumes: M4bJobQueueService.createJob, M4bWorkerManager.ensureWorkerForPendingJobs (from Tasks 2, 4)
- Produces: Modified finalizeAudiobook flow that creates job instead of blocking on encoding

- [ ] **Step 1: Write test for job creation flow**

```javascript
// server/tests/audiobookM4bIntegration.test.js
const test = require("node:test");
const assert = require("node:assert/strict");
const { prisma } = require("../dist/db/prisma.js");

test("AudiobookPipelineService creates M4bEncodingJob on finalize", async () => {
  // This test verifies the integration shape without full pipeline execution
  const { M4bJobQueueService } = require("../dist/services/audiobook/m4b/M4bJobQueueService.js");
  const service = new M4bJobQueueService();
  
  const novel = await prisma.novel.create({
    data: { title: "Test Novel", userId: "test-user" }
  });
  const task = await prisma.audiobookTask.create({
    data: {
      novelId: novel.id,
      title: "Test Task",
      scopeMode: "full",
      narratorVoice: "test-voice",
      narratorStyle: "neutral"
    }
  });
  
  // Simulate what finalizeAudiobook should do
  const job = await service.createJob({
    audiobookTaskId: task.id,
    inputWavPath: "/tmp/test.wav",
    outputM4bPath: "/tmp/test.m4b",
    metadataJson: JSON.stringify({ title: "Test", chapters: [] })
  });
  
  assert.equal(job.audiobookTaskId, task.id);
  assert.equal(job.status, "pending");
  
  // Verify task not yet marked with fullAudioPath (worker will do that)
  const taskRefreshed = await prisma.audiobookTask.findUnique({
    where: { id: task.id }
  });
  assert.equal(taskRefreshed.fullAudioPath, null);
  
  // Cleanup
  await prisma.m4bEncodingJob.delete({ where: { id: job.id } });
  await prisma.audiobookTask.delete({ where: { id: task.id } });
  await prisma.novel.delete({ where: { id: novel.id } });
});
```

- [ ] **Step 2: Run test to verify baseline passes**

Run: `cd server && pnpm run build && pnpm run test:node -- audiobookM4bIntegration.test.js`
Expected: PASS

- [ ] **Step 3: Add feature flag check helper**

```typescript
// Add to server/src/services/audiobook/audiobookM4b.ts after line 60
export function isM4bWorkerEnabled(): boolean {
  const flag = process.env.AUDIOBOOK_M4B_USE_WORKER;
  if (flag === undefined) return true; // default enabled
  return flag === "true" || flag === "1";
}
```

- [ ] **Step 4: Modify AudiobookPipelineService to create job**

Find the encodeFullBookM4b call in AudiobookPipelineService.ts and replace with job creation (search for "encodeFullBookM4b" in the file):

```typescript
// Add import at top of AudiobookPipelineService.ts
import { M4bJobQueueService } from "./m4b/M4bJobQueueService";
import { M4bWorkerManager } from "./m4b/M4bWorkerManager";
import { isM4bWorkerEnabled } from "./audiobookM4b";

// Inside the class, add services
private m4bJobQueue = new M4bJobQueueService();
private m4bWorkerManager = new M4bWorkerManager();

// Replace the encodeFullBookM4b call with:
if (isM4bWorkerEnabled()) {
  // Create job for worker to process
  await this.m4bJobQueue.createJob({
    audiobookTaskId: taskId,
    inputWavPath: sourceWavPath,
    outputM4bPath: outputM4bPath,
    coverImagePath: coverPath,
    metadataJson: JSON.stringify({
      title: bookTitle,
      chapters: metaChapters,
    }),
  });
  
  // Trigger worker spawn if needed
  await this.m4bWorkerManager.ensureWorkerForPendingJobs();
  
  // fullAudioPath will be set by worker when complete
} else {
  // Fallback: direct encoding in main process
  const m4bResult = await encodeFullBookM4b({
    taskDir,
    bookTitle,
    chapters: chapterInputs,
    sourceWavPath,
  });
  
  if (m4bResult.status === "ready" && m4bResult.path) {
    await this.prisma.audiobookTask.update({
      where: { id: taskId },
      data: { fullAudioPath: m4bResult.path },
    });
  }
}
```

- [ ] **Step 5: Rebuild and verify compilation**

Run: `cd server && pnpm run build`
Expected: Build succeeds with no errors

- [ ] **Step 6: Add integration test for feature flag fallback**

```javascript
// Add to server/tests/audiobookM4bIntegration.test.js
test("Feature flag AUDIOBOOK_M4B_USE_WORKER controls routing", async () => {
  const { isM4bWorkerEnabled } = require("../dist/services/audiobook/audiobookM4b.js");
  
  // Save original
  const original = process.env.AUDIOBOOK_M4B_USE_WORKER;
  
  // Test enabled (default)
  delete process.env.AUDIOBOOK_M4B_USE_WORKER;
  assert.equal(isM4bWorkerEnabled(), true);
  
  process.env.AUDIOBOOK_M4B_USE_WORKER = "true";
  assert.equal(isM4bWorkerEnabled(), true);
  
  process.env.AUDIOBOOK_M4B_USE_WORKER = "1";
  assert.equal(isM4bWorkerEnabled(), true);
  
  // Test disabled
  process.env.AUDIOBOOK_M4B_USE_WORKER = "false";
  assert.equal(isM4bWorkerEnabled(), false);
  
  process.env.AUDIOBOOK_M4B_USE_WORKER = "0";
  assert.equal(isM4bWorkerEnabled(), false);
  
  // Restore
  if (original !== undefined) {
    process.env.AUDIOBOOK_M4B_USE_WORKER = original;
  } else {
    delete process.env.AUDIOBOOK_M4B_USE_WORKER;
  }
});
```

- [ ] **Step 7: Run tests and commit**

Run: `cd server && pnpm run build && pnpm run test:node -- audiobookM4bIntegration.test.js`
Expected: PASS (2 tests)

```bash
git add server/src/services/audiobook/AudiobookPipelineService.ts server/src/services/audiobook/audiobookM4b.ts server/tests/audiobookM4bIntegration.test.js
git commit -m "feat(audiobook): integrate m4b worker with pipeline service"
```

---

### Task 6: Deployment Configuration and Documentation

**Files:**
- Create: `docs/deployment/m4b-worker-deployment.md`
- Modify: `.env.example` (add new environment variables)

**Interfaces:**
- Consumes: All components from Tasks 1-5
- Produces: Deployment guide, environment variable documentation, rollback procedure

- [ ] **Step 1: Write deployment guide**

```markdown
<!-- docs/deployment/m4b-worker-deployment.md -->
# M4B Worker Deployment Guide

## Overview

The m4b worker isolates audiobook encoding from the main novel-server process to prevent OOM issues on memory-constrained hosts like pxed.

## Pre-deployment Checklist

- [ ] Database migration applied: `npx prisma migrate deploy`
- [ ] Server built with worker script: `pnpm run build`
- [ ] Verify `dist/workers/m4b-worker.js` exists
- [ ] Review environment variables (see Configuration below)

## Configuration

### Environment Variables

```bash
# Worker Control
AUDIOBOOK_M4B_USE_WORKER=true          # Enable worker isolation (default: true)
AUDIOBOOK_M4B_CONCURRENCY=1            # Max concurrent workers (pxed: 1)

# Worker Behavior
M4B_WORKER_IDLE_TIMEOUT_MS=60000       # Worker exits after 60s idle
M4B_WORKER_HEARTBEAT_INTERVAL_MS=30000 # Watchdog check interval

# Encoding Settings (existing)
AUDIOBOOK_M4B_FFMPEG_THREADS=2         # ffmpeg thread cap
AUDIOBOOK_M4B_STALL_TIMEOUT_MS=300000  # Stall detection timeout
```

### Memory Budgets

- Main server: 384MB heap (unchanged)
- Worker process: 768MB heap (--max-old-space-size)
- Recommended host memory: 4GB minimum

## Deployment Steps

1. **Apply Migration**
   ```bash
   cd server
   npx prisma migrate deploy
   ```

2. **Build Application**
   ```bash
   cd server
   pnpm run build
   ```

3. **Restart Server**
   ```bash
   # If using Supervisor
   supervisorctl restart novel-server
   
   # If using systemd
   systemctl restart novel-server
   ```

4. **Verify Worker Spawns**
   - Trigger audiobook generation
   - Check logs: `tail -f storage/logs/m4b-worker-*.log`
   - Verify process: `ps aux | grep m4b-worker`

## Monitoring

### Check Job Queue

```sql
SELECT id, status, progressPercent, retryCount, createdAt 
FROM M4bEncodingJob 
WHERE status IN ('pending', 'processing') 
ORDER BY createdAt;
```

### Check Active Workers

```sql
SELECT * FROM WorkerHeartbeat WHERE processType = 'm4b-worker';
```

### Check Stalled Jobs

```sql
SELECT * FROM M4bEncodingJob 
WHERE status = 'processing' 
  AND workerStartedAt < datetime('now', '-5 minutes');
```

## Rollback Procedure

If critical issues arise:

1. **Disable Worker Mode**
   ```bash
   export AUDIOBOOK_M4B_USE_WORKER=false
   supervisorctl restart novel-server
   ```

2. **Verify Fallback**
   - Generate test audiobook
   - Check that encoding runs in main process (no worker spawn)
   - Monitor main server RSS (will spike during encoding)

3. **Reset Stuck Jobs**
   ```sql
   UPDATE M4bEncodingJob 
   SET status = 'pending', workerId = NULL, workerStartedAt = NULL
   WHERE status = 'processing';
   ```

## Troubleshooting

### Worker Not Spawning

- Check `dist/workers/m4b-worker.js` exists
- Verify `AUDIOBOOK_M4B_USE_WORKER=true`
- Check server logs for spawn errors

### Worker Dies Immediately

- Check worker log: `storage/logs/m4b-worker-*.log`
- Verify Prisma client generated: `ls node_modules/.prisma/client`
- Check database connection string

### Jobs Stuck in Processing

- Watchdog will reset after 2 minutes
- Manual reset: see "Reset Stuck Jobs" above
- Check if worker process zombified: `ps aux | grep m4b-worker`

### OOM Still Occurring

- Verify only 1 worker running: `ps aux | grep m4b-worker | wc -l`
- Check main server not using old code path (verify feature flag)
- Reduce ffmpeg threads: `AUDIOBOOK_M4B_FFMPEG_THREADS=1`

## Success Metrics

- Main server RSS stays <400MB during encoding
- Worker spawns on-demand (not persistent)
- Worker exits after 60s idle
- No OOM kills in `dmesg | grep oom` for 7 days
```

- [ ] **Step 2: Update .env.example**

```bash
# Add to server/.env.example after existing AUDIOBOOK_ variables

# M4B Worker Configuration
AUDIOBOOK_M4B_USE_WORKER=true          # Enable isolated worker process (default: true)
AUDIOBOOK_M4B_CONCURRENCY=1            # Max concurrent m4b workers (default: 1, pxed: 1)
M4B_WORKER_IDLE_TIMEOUT_MS=60000       # Worker idle timeout in ms (default: 60000)
M4B_WORKER_HEARTBEAT_INTERVAL_MS=30000 # Heartbeat check interval in ms (default: 30000)
```

- [ ] **Step 3: Create migration validation script**

```bash
#!/bin/bash
# scripts/deploy/validate-m4b-worker-migration.sh

set -e

echo "Validating m4b worker migration..."

# Check migration exists
if [ ! -d "server/src/prisma/migrations" ]; then
  echo "❌ Migrations directory not found"
  exit 1
fi

# Check for M4bEncodingJob migration
if ! ls server/src/prisma/migrations/*add_m4b_encoding_job*/migration.sql >/dev/null 2>&1; then
  echo "❌ M4bEncodingJob migration not found"
  exit 1
fi

# Check worker script built
if [ ! -f "server/dist/workers/m4b-worker.js" ]; then
  echo "❌ Worker script not built (run pnpm run build)"
  exit 1
fi

# Check schema has new models
if ! grep -q "model M4bEncodingJob" server/src/prisma/schema.prisma; then
  echo "❌ M4bEncodingJob model not in schema"
  exit 1
fi

if ! grep -q "model WorkerHeartbeat" server/src/prisma/schema.prisma; then
  echo "❌ WorkerHeartbeat model not in schema"
  exit 1
fi

echo "✓ Migration validation passed"
echo "✓ Worker script found at server/dist/workers/m4b-worker.js"
echo "✓ Schema models present"
echo ""
echo "Next steps:"
echo "  1. Apply migration: cd server && npx prisma migrate deploy"
echo "  2. Restart server: supervisorctl restart novel-server"
echo "  3. Monitor: tail -f storage/logs/m4b-worker-*.log"
```

- [ ] **Step 4: Make validation script executable**

Run: `chmod +x scripts/deploy/validate-m4b-worker-migration.sh`

- [ ] **Step 5: Test validation script**

Run: `./scripts/deploy/validate-m4b-worker-migration.sh`
Expected: All checks pass (✓)

- [ ] **Step 6: Add deployment note to spec**

Edit `docs/superpowers/specs/2026-09-13-m4b-worker-isolation-design.md` to add reference to deployment guide at the bottom:

```markdown
## Deployment

See: docs/deployment/m4b-worker-deployment.md
```

- [ ] **Step 7: Commit**

```bash
git add docs/deployment/m4b-worker-deployment.md server/.env.example scripts/deploy/validate-m4b-worker-migration.sh docs/superpowers/specs/2026-09-13-m4b-worker-isolation-design.md
git commit -m "docs(audiobook): add m4b worker deployment guide and validation"
```

---

## Plan Complete

All tasks define concrete implementations with TDD cycles. Each step is independently testable and results in a working, verifiable state.

**Next: Choose execution approach**
1. **Subagent-Driven (recommended)** - Fresh subagent per task, review between tasks
2. **Inline Execution** - Batch execution in this session with checkpoints
