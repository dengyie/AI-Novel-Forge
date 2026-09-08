# m4b Root-Cause Recovery Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use evidence-driven-bugfix and isolated branch-bound worktrees. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Prevent healthy m4b encodes from being killed, stale encoders from overwriting newer audiobook generations, and process restarts or concurrent books from making m4b delivery unreliable or overloading the shared host.

**Architecture:** Keep `audiobookM4b` responsible for ffmpeg process mechanics and bounded process concurrency. Keep `AudiobookTaskService` responsible for persisted m4b operation ownership and recovery scheduling. Startup recovery must discover persisted m4b work even though the parent audiobook task is already `succeeded`; every destructive publish or database settle must prove current operation ownership.

**Tech Stack:** TypeScript, Node.js child processes, Prisma/SQLite-compatible JSON projections, Node test runner.

## Global Constraints

- Work only on isolated `codex/*` branches; never edit the protected `main` worktree.
- Establish a failing automated regression test before each root-cause fix.
- Default global ffmpeg concurrency is `1`; configuration may increase it only with a validated positive integer.
- Host `global_oom` is external to the application. This work reduces amplification and recovery gaps; it must not claim to eliminate host-level OOM.
- Do not add a schema migration unless persisted `resultJson.m4b` cannot provide atomic operation ownership under existing Prisma update semantics.
- Do not merge, push, deploy, or touch production in this phase.

---

### Task 1: Independent Stall Observation

**Files:**
- Modify: `server/src/services/audiobook/audiobookM4b.ts`
- Test: `server/tests/audiobookM4bStallWatchdog.test.js`

**Interfaces:**
- Consumes: `runFfmpeg({ stallTimeoutMs, onProgress, partPath })`
- Produces: unchanged public `encodeFullBookM4b()` contract with independent progress-report and stall-observation state

- [ ] Add a deterministic regression test in which progress sampling observes growth immediately before the watchdog deadline and the encoder then remains idle for a full stall window.
- [ ] Run the focused test against `a423ca83` and record the expected premature-kill failure.
- [ ] Replace the shared byte baseline with watchdog-owned `lastObservedBytes` and `lastGrowthAt` state; progress reporting may read bytes but cannot mutate watchdog state.
- [ ] Verify first-byte absence, continuous growth, and full-window stagnation behavior.
- [ ] Run focused tests, server typecheck/build, and `git diff --check`.

### Task 2: Persisted m4b Operation Ownership

**Files:**
- Modify: `server/src/services/audiobook/AudiobookTaskService.ts`
- Modify as required for pre-publish fencing: `server/src/services/audiobook/audiobookM4b.ts`
- Test: a focused `server/tests/audiobookM4b*Ownership*.test.js`

**Interfaces:**
- Consumes: parent task `resultJson`, reprocess/continue/redo scheduling paths, m4b encoder pre-publish hook
- Produces: persisted unique operation id and ownership checks before canonical rename and terminal settle

- [ ] Add a deterministic regression test where operation A starts, operation B supersedes it, and A finishes last.
- [ ] Run the test against `a423ca83` and record that A can publish or settle over B.
- [ ] Persist a unique operation id when an encode is scheduled and invalidate/supersede it on reprocess, continue, or redo.
- [ ] Require the same operation id immediately before canonical artifact publication and before result/label settlement.
- [ ] Verify stale success, stale failure, and stale cancellation cannot mutate B while B can complete normally.
- [ ] Run focused tests, server typecheck/build, and `git diff --check`.

### Task 3: Restart-Recoverable Bounded m4b Work

**Files:**
- Modify: `server/src/services/audiobook/AudiobookTaskService.ts`
- Modify: `server/src/services/audiobook/audiobookM4b.ts`
- Modify: `server/src/services/task/RecoveryTaskService.ts`
- Modify: `server/src/app.ts`
- Test: focused restart, concurrency, permit-release, and orphan-identity tests under `server/tests/`

**Interfaces:**
- Consumes: persisted `resultJson.m4b.status`, startup recovery initialization, ffmpeg child pid/process identity
- Produces: awaited recovery scheduling, process-wide bounded executor, identity-checked orphan cleanup

- [ ] Add failing tests proving succeeded parents with `m4b.status=encoding` are omitted by current recovery and two task directories can spawn simultaneously.
- [ ] Persist enough scheduling state to rediscover interrupted m4b work after restart without replaying full audiobook synthesis.
- [ ] Extend startup recovery to await and report m4b recovery scheduling failures explicitly.
- [ ] Put ffmpeg execution behind a FIFO bounded permit pool; default concurrency is one and permits are released on success, failure, abort, and spawn error.
- [ ] Replace broad `pgrep -f taskDir` cleanup with verified ffmpeg pid/run identity and await cleanup before rescheduling.
- [ ] Run focused tests, server typecheck/build, and `git diff --check`.

### Task 4: Integration And Contract Review

**Files:**
- Merge the three task scopes into `codex/integrate-m4b-root-causes`
- Update: `docs/wiki/workflows/` or `docs/wiki/debugging/` with the durable ownership/recovery contract
- Update when user-visible: `docs/releases/release-notes.md` and `README.md`

**Interfaces:**
- Consumes: task commits from the three isolated agents
- Produces: one coherent operation state machine: `scheduled -> encoding -> ready|failed`, fenced by operation id and recoverable after restart

- [ ] Review every child diff and its red/green evidence before integration.
- [ ] Resolve shared-file conflicts by preserving one operation state owner and one queue owner; remove duplicate helpers and compatibility wrappers.
- [ ] Add an integration regression covering supersession while queued and restart recovery without duplicate ffmpeg spawn.
- [ ] Update durable wiki knowledge and user-facing release notes using the repository workflows.
- [ ] Run focused m4b tests, server typecheck, server build, fast server suite, and `git diff --check`.
- [ ] Commit the integrated phase; do not merge into `beta` or `main` without a separate promotion decision.

## Acceptance Criteria

- A progress callback cannot shorten the true stall window.
- Only the current persisted m4b operation may rename the canonical file or settle DB state.
- A server restart can rediscover interrupted m4b work whose parent task is already succeeded.
- Different books do not run more than one ffmpeg concurrently by default.
- Queue permits and child resources are released on all terminal paths.
- Orphan cleanup cannot target an unrelated process merely because its command line contains a task directory.
- Verification passes without modifying the protected main worktree or production environment.
