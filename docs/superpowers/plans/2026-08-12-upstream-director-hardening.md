# Upstream Director Hardening Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 将上游审查中确认有价值的完成态投影修复按本仓契约手工移植，并修复当前主线在 command lease 丢失时错误取消新 worker pipeline 的生产级 P1。

**Architecture:** 保持本仓统一章节 runtime、Prompt Registry、Context Broker、workflow task ownership CAS 和质量债继续链不变。租约丢失只使旧执行器失去写入资格，不得触碰已经可能被新执行器复用的 pipeline；正常任务取消仍允许清理本任务 pipeline。完成态 UI 只在 task 已经进入终态时优先使用 task checkpoint/progress，运行态和质量债仍沿用现有 runtime projection/facts。

**Tech Stack:** TypeScript, Node.js `node:test`, pnpm workspace, Prisma-backed workflow task state, shared TypeScript contracts.

## Global Constraints

- 当前基线是 `main` `c47c26539800ac1fd4637d552abd9f68f4b607f1`；不要 merge 或整批 cherry-pick 上游 `2458bad1b259937be3c34d513d623664f2373fb8`。
- 上游 fork 是 `https://github.com/dengyie/AI-Novel-Forge.git`；上游是 `https://github.com/ExplosiveCoderflome/AI-Novel-Writing-Assistant.git`，两者无可用公共祖先，移植必须按当前文件和契约手工完成。
- 不得新增 keyword/regex 意图路由，不得绕过 Prompt Registry、Context Broker 或统一章节 runtime。
- 不得把 `local_patch_plan`、`continue_with_warning`、`patchable_obligation_gap`、`draft_obligation_unmet`、可恢复 repair failure 或 `defer_and_continue` 升级成全局 stop/replan。
- 所有 task/runtime/UI 状态必须继续以 workflow task + ownership-fenced runtime 为事实源，不能新增并行状态源。
- 旧 worker 失去 lease、attempt 或 ownershipVersion 后，禁止旧 worker 写 task projection、发送通知、合并旧 seed、继续 cleanup 或取消新 worker 的 pipeline。
- 正常 task cancel/cancelRequested 的现有 pipeline 清理语义必须保留；只对明确的 command lease-loss abort 改变清理行为。
- 源文件维持现有模块边界；本次不扩张超过 700 行的文件职责，不新增泛化 `utils/shared/helpers` 文件。
- 本次为内部可靠性修复，不更新 `README.md` 或 `docs/releases/release-notes.md`；如新增稳定架构知识，只更新已有 `docs/wiki/workflows/auto-director-runtime.md`，不得把计划文档写成 changelog。

## Upstream Decision Record

| 上游提交 | 决定 | 依据 |
| --- | --- | --- |
| `24e67993` `fix(director): prioritize completed task projection` | 手工移植 | 本仓仍可能在 `task.status=succeeded` / `workflow_completed` 时被滞后的 runtime projection 覆盖进度和 current action；但本仓 shared 类型已迁到 `shared/types/directorRuntime.ts`，且保留 `budgetLedgerSummary`，原提交不能直接 cherry-pick。 |
| `473dd3d3` `fix(director): preserve takeover chapter range` | 不移植 | 本仓 `novelDirectorTakeoverExecution.ts` 已有 `normalizeContinueExistingAutoExecutionPlan`，并已有真实回归测试锁定范围；原提交同时将 `scheduleBackgroundRun` 改为 fire-and-forget、删除 abort signal、把部分章节接管改为 `production_experience_required`，会破坏本仓取消/恢复/统一章节 runtime 语义。 |
| `2c22a865` `fix(simple-creation): reuse shared director continuation` | 仅借鉴，另立产品任务 | 涉及 `DirectorContinuationMode`、简易创作 API/UI、full-book autopilot 重新绑定和旧服务删除；直接移植会改变产品入口与章节主链，不属于本次 P1 修复。 |
| `bb0b8285` `fix(simple-creation): continue remaining chapters in shelf` | 拒绝直接移植 | 新增独立 `SimpleCreationProductionService` 和 shelf API/路由，后续提交又删除并改用共享 continuation；直接拿该提交会引入已被上游替代的兼容门面。 |
| `28f85766` / `84ad7c58` director risk governance | 仅借鉴，另立架构任务 | 大量重排 `NovelPipelineExecutor`、command lease、risk policy、issue governance、Prompt Registry、migration 和 UI；需先对比本仓已有 ownership CAS/质量债规则，不能整批覆盖。 |
| `3fa9bee5` workspace navigation | 拒绝本次移植 | 纯 UI 导航/展示变更，与当前 runtime P1 无关，且可能删除本仓仍用于恢复/任务中心的入口。 |
| `32055464` / `4426fb6e` / `2458bad1` | 禁止 cherry-pick | 产品入口、风险治理、desktop release 和大规模模块迁移的合并提交，变更面远超本仓生产硬化范围。 |

## File Map

### Task 1: Lease-loss pipeline cleanup fence

**Files:**
- Modify: `server/src/services/novel/director/automation/domain/AutoExecutionOwnershipFence.ts:1-215`
- Modify: `server/tests/autoExecutionOwnershipFence.test.js`（在 ownership loss 测试组中增加 signal reason 场景）
- Reference only: `server/src/services/novel/director/commands/DirectorCommandLeaseGuard.ts:1-42`

**Interfaces:**
- Consumes: `AbortSignal.reason`, `DirectorCommandLeaseLostError.code === "DIRECTOR_COMMAND_LEASE_LOST"`, existing `novelService.cancelPipelineJob` port.
- Produces: `AutoExecutionOwnershipFence.assertActive()` 在 lease-loss abort 下抛 `AutoExecutionOwnershipLostError`，但不调用 `cancelPipelineJob`；task cancelled/cancelRequested 路径仍调用现有 cleanup。

- [ ] **Step 1: Write the failing regression tests.**

在 `server/tests/autoExecutionOwnershipFence.test.js` 增加以下两个测试。第一个复现当前 P1：旧 worker 持有 `job-reused`，command lease 丢失后 signal 被 abort，旧 fence 必须不能取消该 job。第二个锁定正常取消不被改变：任务已经是 `cancelled` 时仍会调用 cleanup。

```js
const { DirectorCommandLeaseLostError } = require(
  "../dist/services/novel/director/commands/DirectorCommandLeaseGuard.js",
);

test("command lease loss does not cancel a pipeline job that may be reused by the replacement worker", { concurrency: false }, async () => {
  const controller = new AbortController();
  controller.abort(new DirectorCommandLeaseLostError("command-1", "worker-a:slot-1"));
  let cancelCalls = 0;
  const fence = new AutoExecutionOwnershipFence({
    workflowService: {
      getTaskByIdWithoutHealing: async () => task(),
    },
    novelService: {
      cancelPipelineJob: async () => { cancelCalls += 1; },
    },
  }, "task-1", controller.signal, "job-reused", commandExecution());

  await assert.rejects(
    () => fence.assertActive(),
    (error) => error?.code === "AUTO_EXECUTION_OWNERSHIP_LOST",
  );
  assert.equal(cancelCalls, 0);
});

test("task cancellation still cancels the owned pipeline job", { concurrency: false }, async () => {
  let cancelCalls = 0;
  const fence = new AutoExecutionOwnershipFence({
    workflowService: {
      getTaskByIdWithoutHealing: async () => task({ status: "cancelled" }),
    },
    novelService: {
      cancelPipelineJob: async () => { cancelCalls += 1; },
    },
  }, "task-1", undefined, "job-cancelled");

  await assert.rejects(
    () => fence.assertActive(),
    (error) => error?.code === "AUTO_EXECUTION_OWNERSHIP_LOST",
  );
  assert.equal(cancelCalls, 1);
});
```

- [ ] **Step 2: Run the focused tests and verify the first test fails before implementation.**

Run:

```bash
pnpm --filter @ai-novel/shared build
pnpm --filter @ai-novel/server build
node --test server/tests/autoExecutionOwnershipFence.test.js
```

Expected before the fix: the new lease-loss test fails because `cancelPipelineJob("job-reused")` is called once. The normal cancellation test must remain passing.

- [ ] **Step 3: Implement the minimal reason-aware cleanup.**

Import `DirectorCommandLeaseLostError` from `../../commands/DirectorCommandLeaseGuard` (relative to `automation/domain`). Add a private predicate or local check that recognizes the explicit lease-loss reason by class or stable code:

```ts
function isCommandLeaseLossAbort(signal?: AbortSignal): boolean {
  const reason = signal?.reason as { code?: unknown } | undefined;
  return reason instanceof DirectorCommandLeaseLostError
    || reason?.code === "DIRECTOR_COMMAND_LEASE_LOST";
}
```

Change only `failOwnershipWithPipelineCancellation()` so the pipeline id is cleared for lease loss while remaining intact for ordinary cancellation:

```ts
private async failOwnershipWithPipelineCancellation(): Promise<never> {
  this.lost = true;
  const pipelineJobId = isCommandLeaseLossAbort(this.signal)
    ? null
    : this.pipelineJobId;
  if (pipelineJobId) {
    await this.deps.novelService.cancelPipelineJob(pipelineJobId);
  }
  throw new AutoExecutionOwnershipLostError(this.taskId, pipelineJobId);
}
```

Do not catch cleanup errors, do not turn lease loss into task failure, and do not modify `loseOwnership()` or the ownership CAS path. The old runner must stop; the replacement worker owns any reused job.

- [ ] **Step 4: Run the focused ownership and command-context tests.**

Run:

```bash
pnpm --filter @ai-novel/shared build
pnpm --filter @ai-novel/server build
node --test server/tests/autoExecutionOwnershipFence.test.js server/tests/directorCommandExecutionContext.test.js server/tests/pendingReviewAutoPromotionRuntime.test.js server/tests/stateCommitService.test.js
```

Expected: all tests pass; specifically lease-loss cleanup count is `0`, task cancellation cleanup count is `1`, CAS-miss cleanup remains `0`, and infrastructure errors still propagate unchanged.

- [ ] **Step 5: Commit the isolated phase.**

Before committing, run `git diff --check` and inspect only the files listed in Task 1. Commit with:

```bash
git add server/src/services/novel/director/automation/domain/AutoExecutionOwnershipFence.ts server/tests/autoExecutionOwnershipFence.test.js
git commit -m "fix: avoid cancelling reused pipeline after lease loss"
```

### Task 2: Completed task projection precedence

**Files:**
- Modify: `shared/types/directorRuntime.ts` near `DirectorDashboardProgressSource`
- Modify: `server/src/services/novel/director/projections/DirectorDashboardViewBuilder.ts:206-275`
- Modify: `server/src/services/novel/director/projections/DirectorDisplayStateBuilder.ts:152-190`
- Modify: `server/tests/directorDashboardViewBuilder.test.js`
- Modify: `server/tests/directorDisplayStateBuilder.test.js`

**Interfaces:**
- Consumes: existing `DirectorDashboardMode`, `DirectorDisplayMode`, `DashboardTaskLike`, `SnapshotTaskLike`, task `progress`, `currentItemLabel`, `checkpointSummary`.
- Produces: new `DirectorDashboardProgressSource` value `"task_final"`; completed views prefer task terminal facts without altering running/waiting/recovering/quality-debt branches.

- [ ] **Step 1: Write the failing dashboard regression test.**

Extend `buildView()` fixtures in `server/tests/directorDashboardViewBuilder.test.js` with a completed task and stale projection:

```js
test("completed dashboard prefers task terminal facts over a trailing runtime projection", () => {
  const view = buildView({
    task: {
      status: "succeeded",
      progress: 1,
      currentStage: "质量修复",
      currentItemKey: "quality_repair",
      currentItemLabel: "第 11-12 章自动执行完成",
      checkpointType: "workflow_completed",
      checkpointSummary: "本轮章节执行、审核与修复已完成。",
    },
    projection: {
      status: "completed",
      currentLabel: "同步角色资源状态完成。",
      requiresUserAction: false,
      policyMode: "auto_safe_scope",
      updatedAt: "2026-08-09T13:10:13.612Z",
      lastEventSummary: "同步角色资源状态完成。",
      recentEvents: [],
      progressBreakdown: { totalPercent: 32, activeJobProgress: 1 },
    },
    displayState: {
      ...baseDisplayState,
      mode: "completed",
      currentAction: "同步角色资源状态完成。",
      progressPercent: 32,
      isLiveRunning: false,
    },
    activeStep: null,
    latestCommand: null,
  });

  assert.equal(view.mode, "completed");
  assert.equal(view.progressPercent, 100);
  assert.equal(view.progressSource, "task_final");
  assert.equal(view.currentAction, "第 11-12 章自动执行完成");
});
```

Add a display-state regression to `server/tests/directorDisplayStateBuilder.test.js` with `status: "succeeded"`, `checkpointType: "workflow_completed"`, `factSummary.allStepsCompleted: true`, stale projection label, and assert `currentAction` is the task label or checkpoint summary rather than the stale projection label. Keep the existing test that prevents premature completion when facts are incomplete.

- [ ] **Step 2: Run the new tests before implementation.**

Run:

```bash
pnpm --filter @ai-novel/shared build
pnpm --filter @ai-novel/server build
node --test server/tests/directorDashboardViewBuilder.test.js server/tests/directorDisplayStateBuilder.test.js
```

Expected: the dashboard test fails with the stale projection progress/action (`32` and `同步角色资源状态完成。`), while existing tests remain passing.

- [ ] **Step 3: Add the shared source discriminator.**

In `shared/types/directorRuntime.ts`, add `"task_final"` to the existing `DirectorDashboardProgressSource` union. Do not delete or rename `budgetLedgerSummary`, and do not edit `shared/types/director/dashboard.ts` unless the compiler proves it is the active exported contract; the current builder imports from `@ai-novel/shared/types/directorRuntime`.

- [ ] **Step 4: Apply completed-only precedence in the dashboard builder.**

At the top of `buildProgress()` after `const taskPercent = progressFromTask(...)`, add:

```ts
if (input.mode === "completed" && taskPercent !== null) {
  return { percent: taskPercent, source: "task_final" };
}
```

In `buildCurrentAction()`, before the generic fallback branch, add:

```ts
if (input.mode === "completed") {
  return input.task.currentItemLabel?.trim()
    || input.task.checkpointSummary?.trim()
    || input.displayState.currentAction
    || input.projection?.currentLabel?.trim()
    || null;
}
```

The completed branch must not use `projection.progressBreakdown.totalPercent` before task final progress. Running mode remains `task_live`, then worker live, then chapter facts; waiting mode remains checkpoint-based.

- [ ] **Step 5: Apply completed-only precedence in the display-state builder.**

At the beginning of `buildCurrentAction()` add:

```ts
if (input.mode === "completed") {
  return (
    input.task.currentItemLabel?.trim()
    || input.task.checkpointSummary?.trim()
    || input.factStep?.progress.label?.trim()
    || "本轮自动导演已完成"
  );
}
```

This is deterministic post-processing of already-structured task/runtime state, not AI decision logic. Do not alter `buildMode()` precedence or mark a task completed merely because `progress === 1`; existing fact/checkpoint guards stay authoritative.

- [ ] **Step 6: Run projection tests and type/build checks.**

Run:

```bash
pnpm --filter @ai-novel/shared build
pnpm --filter @ai-novel/server build
node --test server/tests/directorDashboardViewBuilder.test.js server/tests/directorDisplayStateBuilder.test.js server/tests/directorBookAutomationProjection.test.js
```

Expected: all focused projection tests pass, including the stale trailing sync event regression and the existing incomplete-facts guard.

- [ ] **Step 7: Commit the isolated phase.**

Run `git diff --check`, inspect the diff for accidental removal of budget ledger fields, then commit:

```bash
git add shared/types/directorRuntime.ts server/src/services/novel/director/projections/DirectorDashboardViewBuilder.ts server/src/services/novel/director/projections/DirectorDisplayStateBuilder.ts server/tests/directorDashboardViewBuilder.test.js server/tests/directorDisplayStateBuilder.test.js
git commit -m "fix: prefer terminal task facts in director projections"
```

### Task 3: Cross-path verification and durable boundary note

**Files:**
- Modify only if needed: `docs/wiki/workflows/auto-director-runtime.md`
- Test commands only: no new compatibility facade or duplicate service.

**Interfaces:**
- Consumes: Task 1 and Task 2 commits.
- Produces: evidence that cancel, retry, lease takeover, recovery, completed projection, quality debt continuation, Prompt Registry and unified chapter runtime contracts remain intact.

- [ ] **Step 1: Inspect the final diff and verify no upstream release files entered.**

Run:

```bash
git diff --name-status main...HEAD
git diff --check
git diff --name-only main...HEAD | rg 'desktop/package.json|server/src/prisma|prompting|client/src/pages/novels/simpleCreation' && exit 1 || true
```

Expected changed files are limited to the Task 1/2 files, plus an explicit auto-director wiki boundary note only if the implementation clarified a durable rule. No migration, release metadata, simple-creation service, risk policy route, or UI navigation file belongs in this branch.

- [ ] **Step 2: Run the complete relevant server fast suite.**

Run:

```bash
pnpm --filter @ai-novel/shared build
pnpm --filter @ai-novel/server prisma:generate
pnpm --filter @ai-novel/server build
TEST_CONCURRENCY=1 pnpm --filter @ai-novel/server test:node
```

Expected: shared build, Prisma generate, server build, and the full fast suite pass with zero failures and zero timeouts. If the full suite is unavailable, report the exact command and residual gap; do not claim production readiness.

- [ ] **Step 3: Verify the actual ownership state machine.**

The final test evidence must explicitly cover this sequence:

```text
old worker lease lost
  -> AbortSignal.reason = DIRECTOR_COMMAND_LEASE_LOST
  -> old fence throws AUTO_EXECUTION_OWNERSHIP_LOST
  -> old fence performs no pipeline cleanup and no projection/notification
  -> replacement worker can continue/reuse the pipeline job

user/task cancellation
  -> task status cancelled or cancelRequestedAt set
  -> owned pipeline cleanup runs once
  -> task remains cancelled; no retry/recovery is synthesized by this fence
```

- [ ] **Step 4: Record residual work instead of widening this patch.**

Do not implement these in this branch: atomic auto-confirm character candidate promotion (`AutoExecutionRangeRunner.ts:566` / `CharacterDynamicsMutationService.ts:737`), proposal/canonical/version post-transaction failure handling (`ExistingProposalCommitService.ts:198` / `PendingReviewAutoPromotionService.ts:334`), long-file `TaskRetentionService.ts` split, or upstream risk-governance/simple-creation product changes. Record them as separate follow-up tasks with their own failing tests and branch boundaries.

## Acceptance Criteria

- [ ] A lease-loss abort never cancels a pipeline job by id; normal task cancellation still does.
- [ ] Ownership CAS misses still stop stale writes without notification, retry, cleanup, or task failure conversion.
- [ ] Completed dashboard progress source is `task_final` and completed current action comes from task terminal facts before trailing runtime projection.
- [ ] Incomplete-facts tasks are not marked completed by this change.
- [ ] No new prompt, model fallback, keyword routing, Context Broker bypass, chapter runtime fork, or UI/task/runtime second state source is introduced.
- [ ] Shared build, Prisma generate, server build, focused tests, and full fast suite pass.
- [ ] Main worktree remains untouched and clean; implementation lives only on `codex/upstream-director-hardening` until separately reviewed and merged.

## Self-Review Notes

- All upstream candidates were checked against the actual current file paths and imports; direct `git apply --check` fails for both `473dd3d3` and `24e67993` because the fork has diverged file boundaries, so neither is a safe raw cherry-pick.
- The plan does not copy the upstream removal of abort propagation or the upstream fire-and-forget scheduling change; those are explicitly incompatible with the current cancellation and command lease contract.
- The plan keeps local quality debt as chapter-level continuation guidance and does not route it into global `replan_required`.
