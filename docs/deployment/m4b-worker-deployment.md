# M4B Worker Deployment Guide

## Overview

The m4b worker isolates audiobook encoding from the main novel-server process to prevent OOM issues on memory-constrained hosts like pxed. When enabled (`AUDIOBOOK_M4B_USE_WORKER=true`, default), the pipeline enqueues an `M4bEncodingJob` and returns immediately; an on-demand child process (`dist/workers/m4b-worker.js`, 768MB heap) claims the job, runs ffmpeg, updates progress, and exits after 60s idle.

## Pre-deployment Checklist

- [ ] Database migration applied: `npx prisma migrate deploy` (Postgres on pxed)
- [ ] Server built with worker script: `pnpm run build`
- [ ] Verify `server/dist/workers/m4b-worker.js` exists
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
- Worker process: 768MB heap (`--max-old-space-size`)
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
   supervisorctl restart novel-server
   ```

4. **Verify Worker Spawns**
   - Trigger audiobook generation
   - Check logs: `tail -f storage/logs/m4b-worker-*.log`
   - Verify process: `ps aux | grep m4b-worker`

## Monitoring

### Check Job Queue

```sql
SELECT id, status, progress_percent, retry_count, created_at
FROM "M4bEncodingJob"
WHERE status IN ('pending', 'processing')
ORDER BY created_at;
```

### Check Active Workers

```sql
SELECT * FROM "WorkerHeartbeat" WHERE process_type = 'm4b-worker';
```

### Check Stalled Jobs

```sql
SELECT * FROM "M4bEncodingJob"
WHERE status = 'processing'
  AND worker_started_at < now() - interval '5 minutes';
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
   UPDATE "M4bEncodingJob"
   SET status = 'pending', "workerId" = NULL, "workerStartedAt" = NULL
   WHERE status = 'processing';
   ```

## Troubleshooting

### Worker Not Spawning

- Check `server/dist/workers/m4b-worker.js` exists
- Verify `AUDIOBOOK_M4B_USE_WORKER=true`
- Check server logs for `[M4bWorkerManager]` spawn errors

### Worker Dies Immediately

- Check worker log: `storage/logs/m4b-worker-*.log`
- Verify Prisma client generated: `ls node_modules/.prisma/client`
- Check database connection string

### Jobs Stuck in Processing

- Watchdog resets after 2 minutes (dead worker → retry once; second failure → `failed`)
- Manual reset: see "Reset Stuck Jobs" above
- Check if worker process zombified: `ps aux | grep m4b-worker`

### m4b Not Delivered After Worker Completion

- The full m4b route serves the file from disk (`full-book.m4b` in the task dir), not from DB
- Check job status in queue; `failed` jobs carry `errorMessage` with the ffmpeg stderr tail

### OOM Still Occurring

- Verify only 1 worker running: `ps aux | grep m4b-worker | wc -l`
- Check main server not using old code path (verify feature flag)
- Reduce ffmpeg threads: `AUDIOBOOK_M4B_FFMPEG_THREADS=1`

## Success Metrics

- Main server RSS stays <400MB during encoding
- Worker spawns on-demand (not persistent)
- Worker exits after 60s idle
- No OOM kills in `dmesg | grep oom` for 7 days
