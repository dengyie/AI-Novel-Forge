# Startup Recovery Readiness Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Keep HTTP readiness false until startup recovery settles, preserve per-domain recovery failures as degraded state, and clean up listeners/workers if startup cannot complete.

**Architecture:** `RecoveryTaskService` fans out independent recovery domains with `Promise.allSettled`, records the failed domains, and resolves after every domain has either completed or failed. A small process-level readiness state is owned by the health route and updated by `startServer`; `/api/health/ready` returns 503 while recovery is pending or degraded. Startup cleanup stops the already-started services and closes the HTTP listener on initialization failure.

**Tech Stack:** TypeScript, Express, Node.js HTTP server, Prisma, Node test runner.

## Global Constraints

- Do not modify m4b generation tokens or artifact-lock implementation.
- Do not declare the server ready while startup recovery is pending or degraded.
- One recovery domain failure must not prevent the other domains from completing.
- Preserve the existing `waitUntilReady()` contract for recovery API routes.

---

### Task 1: Add failing recovery and readiness tests

**Files:**
- Modify: `server/tests/recoveryBootstrapConcurrency.test.js`
- Create: `server/tests/startupReadiness.test.js`

**Interfaces:**
- Consume the current `RecoveryTaskService.initializePendingRecoveries()` and health router.
- Lock the expected `allSettled` outcome, readiness transitions, and failure cleanup contract before implementation.

- [ ] **Step 1: Write tests for per-domain failure isolation and outcome reporting**

  Make one injected recovery domain reject, release the remaining gate, and assert the initialization promise resolves with a degraded result while all six domain functions were invoked.

- [ ] **Step 2: Write tests for health readiness pending/degraded/ready responses**

  Exercise `/ready` with a stubbed database query while readiness is pending, failed, and ready; assert 503 for pending/degraded and 200 only for ready.

- [ ] **Step 3: Write a startup failure cleanup regression test**

  Use a controlled startup dependency that rejects after `listen()` and assert the returned startup failure closes the listener and stops started services.

- [ ] **Step 4: Run the new tests and confirm they fail**

  Run `pnpm -C server build && node --test server/tests/recoveryBootstrapConcurrency.test.js server/tests/startupReadiness.test.js`.

  Expected: the new assertions fail because recovery currently rejects via `Promise.all`, health readiness ignores recovery state, and startup failure has no cleanup path.

### Task 2: Implement degraded recovery and readiness gating

**Files:**
- Modify: `server/src/services/task/RecoveryTaskService.ts:75-111`
- Modify: `server/src/routes/health.ts:1-55`
- Modify: `server/src/app.ts:325-489`

**Interfaces:**
- `RecoveryTaskService.initializePendingRecoveries(): Promise<RecoveryInitializationResult>` resolves after all domains settle and exposes failed domain names.
- `setHealthReadiness(state)` lets app startup publish `starting`, `ready`, or `degraded` without coupling the health route to app internals.

- [ ] **Step 1: Replace fail-fast fan-out with allSettled**

  Name each recovery promise, await `Promise.allSettled`, log each rejected domain, store a stable result on the shared initialization promise, and keep `waitUntilReady()` resolving after settlement.

- [ ] **Step 2: Gate `/api/health/ready` on recovery state and database reachability**

  Return 503 with a non-ready status while startup recovery is pending or degraded; retain the existing DB 503 response when recovery is ready but the DB probe fails.

- [ ] **Step 3: Publish startup states and clean up failed startup**

  Set readiness to starting before listening, ready only after recovery settles with no failures, and degraded when any domain failed. Keep the HTTP listener and all services in a local cleanup path if initialization throws unexpectedly.

- [ ] **Step 4: Run focused tests and confirm they pass**

  Run `pnpm -C server build && node --test server/tests/recoveryBootstrapConcurrency.test.js server/tests/startupReadiness.test.js server/tests/authMiddleware.test.js`.

### Task 3: Review scope and commit

**Files:**
- Modify: `docs/releases/release-notes.md` only if the readiness behavior is user-visible.
- Modify: `README.md` only if the latest update surface requires the same user-visible entry.

- [ ] **Step 1: Inspect the final diff and run `git diff --check`**

- [ ] **Step 2: Run the relevant verification already covering the changed recovery contract**

- [ ] **Step 3: Commit the isolated phase**

  Use `git add` for only the startup readiness/recovery files and commit with `fix(server): harden startup recovery readiness`.
