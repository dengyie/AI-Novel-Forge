# M4B Encoding Worker Isolation Design

**Date:** 2026-09-13  
**Status:** Approved  
**Context:** pxed OOM mitigation - isolate m4b audiobook encoding from main novel-server process

## Problem Statement

Current state: m4b audiobook encoding runs in the main novel-server process via `audiobookM4b.ts`. Each encoding operation reads an entire book's WAV file (~1.5GB for 10-hour audiobooks) and spawns ffmpeg for AAC re-encoding, causing RSS peaks of 285-319 MiB. Combined with Prisma, SQLite, and LLM request buffers, this contributes to OOM events on pxed (4GB shared memory, zero swap).

**Root cause identified (2026-09-04):** Stopping ainovel immediately stopped OOM growth, proving the issue is project-internal, not host-level resource contention.

**Goal:** Extract m4b encoding into an independent on-demand worker process that:
- Only runs when encoding is needed (idle most of the time)
- Has isolated memory budget (768MB heap, independent of main server's 384MB)
- Cannot crash or OOM the main server
- Survives main server restarts (persistent task queue)

## Architecture Overview

**Pattern:** SQLite-backed job queue + on-demand worker pool

### Components

1. **M4bEncodingJob table** (new Prisma model): Persistent task queue in SQLite
2. **M4bWorkerManager** (main server): Spawns/monitors worker processes, heartbeat watchdog
3. **m4b-worker.ts** (standalone script): Polls queue, executes ffmpeg, updates progress, exits when idle

### Key Design Decisions

| Decision | Rationale |
|----------|-----------|
| SQLite queue vs IPC socket | Decouples worker from main server lifecycle; tasks persist across restarts |
| Spawn worker on-demand vs always-on daemon | Matches user requirement "平时不用不要开的"; conserves memory when no encoding needed |
| No Supervisor management | Worker is transient (60s idle timeout); main server owns lifecycle via spawn() |
| 768MB worker heap vs shared 384MB | Encoding needs headroom for large WAV files; isolation prevents main server OOM |
| Single worker default | pxed's 4GB constraint; AUDIOBOOK_M4B_CONCURRENCY=1 avoids parallel 768MB processes |

## Data Model

### New Prisma Schema

```prisma
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

**Relation:** `AudiobookTask` gains `m4bEncodingJob M4bEncodingJob?` (one-to-one, cascade delete)

## Component Design

### 1. M4bWorkerManager (Main Server)

**Location:** `server/src/services/audiobook/m4bWorkerManager.ts`

**Responsibilities:**
- Start worker when `M4bEncodingJob` has pending tasks and no active workers
- Heartbeat watchdog: check worker liveness every 30s
- Restart failed workers (max 1 retry per job to prevent OOM loops)

**Key methods:**
```typescript
class M4bWorkerManager {
  private activeWorkers = new Map<number, ChildProcess>(); // PID → process

  async ensureWorkerForPendingJobs(): Promise<void>;
  private spawnWorker(): ChildProcess;
  private startHeartbeatWatchdog(): void;
  private handleStalledJobs(): Promise<void>;
  async shutdown(): Promise<void>;
}
```

**Worker spawn:**
```typescript
spawn('node', [
  '--max-old-space-size=768',
  '--max-semi-space-size=16',
  'dist/m4b-worker.js'
], {
  env: {
    ...process.env,
    M4B_WORKER_ID: `${process.pid}`,
    M4B_WORKER_LOG_PATH: `storage/logs/m4b-worker-${process.pid}.log`
  },
  stdio: ['ignore', logFileStream, logFileStream],
  detached: false
});
```

**Heartbeat watchdog (every 30s):**
1. Query `M4bEncodingJob WHERE status='processing' AND workerStartedAt < now() - 2 minutes`
2. For each stalled job:
   - Check if `workerId` process exists (`process.kill(pid, 0)`)
   - If dead: reset `status='pending', workerId=null`, spawn new worker
   - If alive but no progress: send SIGTERM → wait 5s → SIGKILL, reset job

### 2. m4b-worker.ts (Standalone Process)

**Location:** `server/src/workers/m4b-worker.ts`

**Lifecycle:**
1. Initialize Prisma client, register heartbeat (`WorkerHeartbeat.upsert`)
2. Poll loop: query pending jobs, claim with row lock, execute encoding
3. Update progress every 5s during ffmpeg execution
4. On completion: write result back to `AudiobookTask.fullAudioPath`, mark job `completed`
5. If no pending jobs for 60s: `process.exit(0)`

**Key logic:**
```typescript
async function pollAndExecute() {
  while (true) {
    const job = await claimNextJob(); // SELECT FOR UPDATE SKIP LOCKED
    if (!job) {
      if (await waitForJobOrTimeout(60_000)) continue;
      else break; // idle timeout, exit
    }
    
    try {
      await executeEncoding(job);
      await markCompleted(job.id);
    } catch (err) {
      await markFailed(job.id, err.message);
    }
    
    await updateHeartbeat();
  }
  
  process.exit(0);
}
```

**Encoding execution:**
- Parse `metadataJson` → ffmpeg metadata flags
- Call existing `encodeFullBookM4b()` logic (moved from main service)
- Parse ffmpeg stderr for progress: `time=01:23:45.67` → percentage
- Update `M4bEncodingJob.progressPercent` every 5s

### 3. Integration with AudiobookService

**Current flow (to be modified):**
```typescript
// server/src/services/audiobook/audiobookService.ts
async finalizeAudiobook(taskId: string) {
  // ... merge chapter WAVs ...
  await encodeFullBookM4b(taskDir, metadata); // ❌ runs in main process
  await this.prisma.audiobookTask.update({
    data: { fullAudioPath: m4bPath }
  });
}
```

**New flow:**
```typescript
async finalizeAudiobook(taskId: string) {
  // ... merge chapter WAVs ...
  
  // Create encoding job instead of blocking
  await this.prisma.m4bEncodingJob.create({
    data: {
      audiobookTaskId: taskId,
      status: 'pending',
      inputWavPath: mergedWavPath,
      outputM4bPath: outputM4bPath,
      coverImagePath: coverPath,
      metadataJson: JSON.stringify(metadata)
    }
  });
  
  // Trigger worker manager to check for pending jobs
  await this.m4bWorkerManager.ensureWorkerForPendingJobs();
  
  // AudiobookTask.fullAudioPath will be set by worker when completed
}
```

## Data Flow

### Normal Encoding Flow

```
[AudiobookService] Chapter synthesis complete
  ↓
[AudiobookService.finalizeAudiobook()] Create M4bEncodingJob (status=pending)
  ↓
[M4bWorkerManager.ensureWorkerForPendingJobs()] Check active workers
  ↓ (if no worker running)
[M4bWorkerManager] spawn('node dist/m4b-worker.js')
  ↓
[Worker] Start, register heartbeat (WorkerHeartbeat.upsert)
  ↓
[Worker] SELECT * FROM M4bEncodingJob WHERE status='pending' FOR UPDATE SKIP LOCKED
  ↓
[Worker] UPDATE status='processing', workerId=<PID>, workerStartedAt=now()
  ↓
[Worker] Parse metadataJson, call encodeFullBookM4b()
  ↓
[Worker] Every 5s: parse ffmpeg progress, update progressPercent
  ↓
[Worker] Encoding complete: UPDATE status='completed'
  ↓
[Worker] UPDATE AudiobookTask.fullAudioPath = outputM4bPath
  ↓
[Worker] Poll next job (if none for 60s → exit(0))
```

### Failure Recovery Flow

**Worker OOM crash:**
```
[Worker] Encoding large book → RSS exceeds 768MB → SIGKILL (exit 137)
  ↓
[Watchdog] Detects workerId process dead + job status='processing'
  ↓
[Watchdog] Check job.retryCount < 1
  ↓
[Watchdog] UPDATE status='pending', workerId=null, retryCount++
  ↓
[Watchdog] Spawn new worker (retry once)
  ↓
(If fails again → status='failed', errorMessage='Max retries exceeded')
```

**Main server restart:**
```
[Main Server] Crashes or restart
  ↓
(Worker continues encoding, unaffected)
  ↓
[Worker] Completes job, updates DB, exits
  ↓
[Main Server] Restarts, M4bWorkerManager initializes
  ↓
[M4bWorkerManager] Checks for orphaned 'processing' jobs (workerStartedAt > 2min ago)
  ↓
[M4bWorkerManager] Verifies workerId processes still exist (via kill(pid, 0))
  ↓
(If worker alive → let it continue | If dead → reset to 'pending')
```

## Error Handling

### Error Classification

| Error Type | Worker Behavior | Main Server Behavior | Retry? |
|------------|----------------|---------------------|--------|
| ffmpeg encoding failure (exit ≠ 0) | Mark `status='failed'`, log stderr, continue to next job | Store errorMessage in AudiobookTask, notify user | No (manual intervention) |
| Worker OOM (SIGKILL) | Process dies immediately | Watchdog resets job to `pending`, increments retryCount | Yes (1 retry max) |
| SQLite lock timeout (SQLITE_BUSY) | Catch, wait 1s, retry up to 3 times | N/A | Yes (internal retry) |
| Worker stalled (no heartbeat) | N/A | SIGTERM → 5s wait → SIGKILL, reset job | Yes (1 retry max) |
| Output file corruption | Check file size > 0 before marking completed | If size = 0, mark failed | No |

### Retry Policy

- **Max retries per job:** 1 (tracked in `M4bEncodingJob.retryCount`)
- **Rationale:** OOM failures are usually deterministic (book too large). Retrying once catches transient issues (e.g., concurrent memory spike from LLM). Infinite retries would cause crash loops.
- **After max retries:** Mark `status='failed'`, set `errorMessage='Encoding failed after 1 retry (likely OOM)'`

### Resource Limits

| Resource | Limit | Enforcement |
|----------|-------|-------------|
| Worker heap | 768MB (--max-old-space-size) | Node.js flag |
| Worker semi-space | 16MB (--max-semi-space-size) | Node.js flag |
| ffmpeg threads | 2 (default from resolveM4bFfmpegThreads) | Existing logic |
| Concurrent workers | 1 (AUDIOBOOK_M4B_CONCURRENCY) | M4bWorkerManager cap |
| Idle timeout | 60s (no pending jobs) | Worker self-exit |
| Heartbeat timeout | 2 minutes (no progress update) | Watchdog SIGTERM/SIGKILL |

## Migration Strategy

### Phase 1: Schema Migration
1. Add `M4bEncodingJob` and `WorkerHeartbeat` models to `prisma/schema.prisma`
2. Generate migration: `npx prisma migrate dev --name add_m4b_encoding_job`
3. Deploy migration to pxed (via `scripts/deploy/prisma-runtime-probe.cjs` validation)

### Phase 2: Code Changes
1. Create `server/src/workers/m4b-worker.ts` (standalone script)
2. Create `server/src/services/audiobook/m4bWorkerManager.ts`
3. Refactor `audiobookM4b.ts`: extract core encoding logic to shared module
4. Modify `audiobookService.ts`: replace direct `encodeFullBookM4b()` call with job creation
5. Wire `M4bWorkerManager` into `app.ts` startup/shutdown lifecycle

### Phase 3: Deployment
1. Build: `cd server && npx tsc`
2. Push to pxed: `git push origin main`, trigger deploy-pxed.yml
3. Cutover: `scripts/deploy/pxed-remote-cutover.sh` (includes runtime probe)
4. Verify: Check `supervisorctl status novel-server`, test audiobook generation, monitor logs

### Rollback Plan
- Keep `audiobookM4b.ts` original logic intact (rename functions, don't delete)
- Add feature flag `AUDIOBOOK_M4B_USE_WORKER=true` (default enabled)
- If critical failure: set flag to `false`, restart server (falls back to in-process encoding)

## Testing Strategy

### Unit Tests
- `m4bWorkerManager.spec.ts`: Mock spawn(), verify worker lifecycle (start, heartbeat, shutdown)
- `m4b-worker.spec.ts`: Mock Prisma, test job claim logic, progress updates, error handling

### Integration Tests
- Create test job in SQLite, spawn real worker, verify completion
- Simulate worker crash (send SIGKILL), verify watchdog resets job
- Test idle timeout: create no jobs, verify worker exits after 60s

### Production Validation
1. Generate small audiobook (1-chapter test book)
2. Monitor `storage/logs/m4b-worker-<PID>.log` for errors
3. Query `SELECT * FROM M4bEncodingJob` to verify status transitions
4. Check RSS: `ps aux | grep novel-server` (should stay <400MB during encoding)

## Observability

### Logs
- **Worker logs:** `storage/logs/m4b-worker-<PID>.log` (ffmpeg progress, errors)
- **Main server logs:** M4bWorkerManager events (worker start/stop, watchdog actions)

### Metrics (existing pipeline)
- `M4bEncodingJob.progressPercent` exposed via `/api/audiobook/tasks/:id/progress`
- `M4bEncodingJob.status` shown in task center UI

### Debugging
- List active workers: `SELECT * FROM WorkerHeartbeat WHERE processType='m4b-worker'`
- Check stalled jobs: `SELECT * FROM M4bEncodingJob WHERE status='processing' AND workerStartedAt < now() - 5 minutes`
- Kill specific worker: `kill <workerId>` (watchdog will handle recovery)

## Configuration

### Environment Variables (server)
```bash
# Worker pool size (default 1, max recommended 2 on pxed)
AUDIOBOOK_M4B_CONCURRENCY=1

# Worker idle timeout in ms (default 60000)
M4B_WORKER_IDLE_TIMEOUT_MS=60000

# Heartbeat check interval in ms (default 30000)
M4B_WORKER_HEARTBEAT_INTERVAL_MS=30000

# Feature flag (default true)
AUDIOBOOK_M4B_USE_WORKER=true
```

### Environment Variables (worker)
Set by M4bWorkerManager on spawn, not user-configurable:
```bash
M4B_WORKER_ID=<PID>
M4B_WORKER_LOG_PATH=storage/logs/m4b-worker-<PID>.log
```

## Risk Mitigation

| Risk | Mitigation |
|------|-----------|
| Worker OOM still crashes host | Worker gets 768MB heap; host has 4GB total. Single worker uses <20% memory budget, leaving 3GB+ for main server + OS. |
| SQLite lock contention | Use `FOR UPDATE SKIP LOCKED` for job claim (non-blocking). Main server writes are rare (job creation only). |
| Zombie workers after deploy | Watchdog detects stale heartbeats, kills orphaned processes. `M4bWorkerManager.shutdown()` sends SIGTERM to all active workers. |
| Lost jobs during power loss | SQLite is durable; jobs in 'pending' or 'processing' status are retried on next startup. Partial m4b files are overwritten on retry. |
| ffmpeg version mismatch | Worker inherits PATH from main server (same ffmpeg binary). No additional dependencies needed. |

## Success Criteria

- [ ] Main server RSS stays <400MB during m4b encoding (no spikes to 800MB+)
- [ ] Worker process spawns on-demand, exits after 60s idle (verify with `ps aux`)
- [ ] Encoding job survives main server restart (query DB before/after restart)
- [ ] Failed encoding retries once, then marks failed (check `retryCount` in DB)
- [ ] No OOM events on pxed for 7 days after deployment (check `dmesg | grep oom`)

## Future Enhancements (Out of Scope)

- Multiple worker types (image generation, TTS) using same queue pattern
- Remote worker on separate host (requires network IPC instead of spawn)
- Progress streaming via WebSocket (currently polling-based)
- Worker auto-scaling based on queue depth (not needed for current load)

## Related Documents

- [[pxed ai-novel 部署与运维]] — Deployment runbook
- [[ainovel 生产安全与可用性加固经验]] — Context on OOM history
- `docs/wiki/debugging/pxed-prisma-oom-recovery.md` — Prisma runtime consistency rules

## Deployment

See: `docs/deployment/m4b-worker-deployment.md`
