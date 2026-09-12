# pxed Production Remediation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task with verification checkpoints.

**Goal:** Prevent a host-level OOM from turning `novel-server` into a persistent 502, guarantee that the deployed Prisma runtime matches the server build, and make every future exit diagnosable from one timestamped incident record.

**Architecture:** Keep the existing Supervisor and GitHub Actions deployment model. Add a bounded restart policy and an application preflight contract, make the Prisma artifact self-describing and verify it before restart, and collect process/OOM/deployment fingerprints at the cutover and startup boundaries. Treat readiness as a separate recovery signal: liveness may be 200 while readiness reports the failed domain.

**Tech Stack:** Bash, Supervisor, GitHub Actions, Node.js 20, Prisma 7, SQLite, existing Node test runner, existing pxed health endpoints.

## Global Constraints

- Production host is pxed; canonical public URL is `https://ainovel.mangoqwq.com`.
- Production data is under `/data/ainovel`; `/personal/pxed` is the persistent control plane and symlink compatibility layer.
- Never run destructive database commands; no reset, truncate, drop, or delete of live data.
- Do not run TypeScript compilation on pxed; builds and Prisma generation run in CI.
- Main worktree is protected; implementation starts from the existing feature worktree and promotes through `beta` before `main`.
- Do not claim recovery, passing tests, or production health without fresh command output.
- User-facing changes require the repository release-note workflow before commit/push; durable runtime rules require the project wiki and canonical Obsidian entry update.

## Workstream A: Availability and OOM Recovery

### Files

- Modify: `server/src/app.ts` and the existing startup/shutdown module only if the preflight or readiness state needs a stable hook.
- Modify: `scripts/deploy/pxed-remote-cutover.sh` for Supervisor policy validation and post-restart observation.
- Modify: `docs/deploy/pxed-tag-deploy.md` for the new restart and recovery contract.
- Create or modify: an owned script under `scripts/ops/` for read-only OOM/process snapshots if the existing guard logic cannot be extended without mixing responsibilities.
- Create: focused tests under `server/tests/` for startup preflight/readiness behavior where application code changes.

### Contract

- `novel-server` must be `RUNNING` after a deployment or the cutover must fail with a rollback hint.
- Supervisor must retry an unexpected exit with bounded backoff and bounded attempts; it must not create an unbounded restart loop during a host memory crisis.
- `/api/health` remains the liveness signal.
- `/api/health/ready` remains 503 while a startup recovery domain is failed or pending.
- Cutover must record `oom_kill` counter, cgroup memory usage/limit/events, Supervisor status, and the server PID before and after restart.

### Steps

- [ ] Capture a failing evidence fixture from the current incident: Supervisor `SIGKILL`, OOM counter delta, missing `:3001`, and nginx 502. Store it in the plan or test fixture without copying secrets.
- [ ] Add a focused test for the desired bounded-restart policy and health observation. The test must cover an unexpected exit, a successful restart, and the retry limit.
- [ ] Update the control-plane Supervisor template or cutover validation so `autorestart=true`, `startsecs` remains at least 5, and `startretries` is finite. Preserve `stopasgroup=true` and `killasgroup=true`.
- [ ] Add a restart backoff that does not overlap multiple `novel-server` processes. The cutover must issue one restart command and let Supervisor own retries.
- [ ] Add a cutover postcondition that checks `supervisorctl status novel-server`, `127.0.0.1:3001/api/health`, `127.0.0.1:3000/api/health`, and `/api/health/ready`; emit all response bodies and process metadata on failure.
- [ ] Add a read-only OOM snapshot command that identifies the top RSS processes and the current cgroup counters. It must not kill, renice, or mutate processes.
- [ ] Run targeted server tests and shell syntax checks locally. Do not deploy until the Prisma workstream also passes its preflight.
- [ ] On pxed, take a verified DB snapshot and control-plane backup, then apply only the Supervisor/control-plane change. Verify file existence and byte size before restart.
- [ ] Restart once, observe for at least 10 minutes, and record health, ready, PID, RSS, and OOM counter deltas at 0, 30, 60, 180, 300, and 600 seconds. Abort further production changes if the counter rises or the process restarts again.

## Workstream B: Prisma Artifact and Runtime Consistency

### Files

- Modify: `.github/workflows/deploy-pxed.yml` to generate a manifest and run a runtime-model probe against the exact CI artifact.
- Modify: `scripts/deploy/pxed-remote-cutover.sh` to validate the manifest, unpack the client atomically, and run a pre-start probe before restarting Supervisor.
- Create: `scripts/deploy/prisma-runtime-probe.cjs` as a small read-only probe that loads `@prisma/client` from the server package and checks `AudiobookTask.m4bGenerationToken` in `_runtimeDataModel`.
- Create: `server/tests/prismaRuntimeProbe.test.js` for missing model/field, matching field, and malformed manifest cases.
- Modify: `docs/deploy/pxed-tag-deploy.md` with the artifact identity and probe contract.

### Contract

- CI emits one Prisma artifact from the same checkout/build as `server/dist`.
- The artifact manifest contains the deploy SHA, Prisma client package version, schema SHA, generated schema SHA, and a required field marker for `AudiobookTask.m4bGenerationToken`.
- The remote script refuses to restart when the manifest is missing, mismatched, or the runtime probe cannot see the required field.
- The probe must not query or mutate the production database; it only loads generated client metadata.
- The server process starts only after the new client directory and server dist are both in place.

### Steps

- [ ] Write the failing probe tests first. Assert that a generated client with no `AudiobookTask.m4bGenerationToken` is rejected and the matching client is accepted.
- [ ] Implement the probe with an explicit JSON result: `ok`, `clientPath`, `clientVersion`, `model`, `field`, and `reason`. Exit nonzero when `ok` is false.
- [ ] In CI, compute hashes from `server/src/prisma/schema.prisma`, `prisma.config.ts`, `server/dist`, and the generated `.prisma/client`; package the manifest beside the tarball.
- [ ] Validate the tarball contents before upload. Require `.prisma/client/schema.prisma`, runtime JS files, and the manifest field marker.
- [ ] In the remote cutover, verify the SHA and checksum before promotion, atomically replace the complete generated client directory, then run the probe from the live server package.
- [ ] Write probe output into the cutover snapshot metadata. If it fails, leave the old `dist` and client available for manual rollback and do not restart.
- [ ] Add a startup log containing the probe fingerprint so a future shared stdout file can be tied to the exact client generation.
- [ ] Run the focused probe tests, server fast tests touching audiobook recovery, and the CI artifact packaging path locally or in Actions before production use.

## Workstream C: Incident Observability and Log Attribution

### Files

- Modify: `scripts/deploy/pxed-remote-cutover.sh` to create a deployment/incident metadata file.
- Modify: `scripts/ops/` OOM guard or add an owned watcher script so it records only evidence, not remediation, for `novel-server` exits.
- Modify: Supervisor control-plane logging configuration to rotate or instance-scope `novel-server` stdout/stderr without changing application log semantics.
- Modify: `docs/wiki/architecture/process-global-error-handling.md` and `docs/wiki/workflows/startup-recovery-readiness.md` with durable rules.
- Modify: canonical Obsidian `Note/Infra/pxed ai-novel 部署与运维.md` in its existing troubleshooting/current-state sections; do not create a timestamped orphan note.

### Contract

- Every launch records deploy SHA, PID, start time, Prisma fingerprint, Node flags, and Supervisor status.
- Every unexpected exit records exit signal/status, last health result, OOM counter delta, cgroup event counters, and top RSS processes.
- Application logs keep liveness, readiness, and failed recovery domains distinguishable.
- Historical append-only logs remain available, but new evidence is bounded and searchable by PID and launch ID.

### Steps

- [ ] Define a launch ID format using UTC timestamp plus PID and write it at startup and cutover.
- [ ] Add a bounded JSON metadata record for each launch/exit. Redact environment values and never write tokens, cookies, or full `.env` content.
- [ ] Add log rotation or per-instance file naming with a retention limit that is safe for the local overlay disk. Verify rotation does not write to the NAS `.logs` symlink.
- [ ] Add a test/parser check that an exit record can be joined to its corresponding OOM counter sample and Supervisor PID.
- [ ] Document the diagnosis sequence: public health -> nginx -> `:3001` -> Supervisor -> launch metadata -> OOM counters -> Prisma probe.
- [ ] Update both repository wiki and canonical Obsidian entry after the runtime rule is implemented, then run `python3 .local/bin/scan-stale-docs` from the vault root.

## Production Recovery Sequence

- [ ] Verify the current DB backup asset and its size; do not touch the database schema during service recovery.
- [ ] Run the Prisma probe against the currently installed client and save the result. If it fails, deploy the artifact-consistency fix before starting a long-lived service.
- [ ] Apply the bounded Supervisor restart policy and start `novel-server` once through `supervisorctl -c /personal/pxed/supervisord.conf start novel-server`.
- [ ] Verify local liveness/readiness, nginx origin health, and public liveness/readiness. A 200 liveness with 503 readiness must be reported as degraded, not healthy.
- [ ] Check SQLite task counts and active `auto_director` work before any subsequent cutover; do not resume or cancel tasks as part of this incident plan.
- [ ] Observe the service through the full window defined in Workstream A and compare OOM counters before declaring production stable.

## Verification and Promotion Gates

- [ ] Shell checks: `bash -n scripts/deploy/pxed-remote-cutover.sh` and every new script.
- [ ] Focused Node checks: `node --test server/tests/prismaRuntimeProbe.test.js` plus the existing audiobook recovery tests affected by the runtime field.
- [ ] Server checks: the repository fast suite after the relevant source changes.
- [ ] CI checks: Gate, artifact packaging, and a dry-run/fixture execution of the remote cutover validation.
- [ ] Beta checks: merge the feature branch into `beta`, run integration tests and deployment-script checks, and verify no active director task is interrupted.
- [ ] Production checks: backup existence/size, local health, nginx health, public health, ready state, PID stability, RSS trend, and unchanged OOM counter.
- [ ] Only after all gates pass, update release notes/README when the change is user-visible, commit the phase, and promote `beta` to `main` according to the repository workflow.

## Rollback

- If the Prisma probe fails before restart, leave the current service untouched and use the snapshot metadata to repair the artifact.
- If the service fails after restart but the old dist/client is known good, restore the saved `dist`, control-plane launcher, and complete Prisma client directory from the pre-cutover snapshot, then restart once.
- Do not restore or overwrite `dev.db` unless a separate data-integrity incident is proven, the backup is verified, and explicit approval is obtained for that destructive recovery step.
- If OOM recurs during observation, stop production feature deployment and reduce/ isolate competing resident processes through a separately approved host-capacity change.

