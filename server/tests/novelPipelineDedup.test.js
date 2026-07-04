const test = require("node:test");
const assert = require("node:assert/strict");

const {
  selectPrimaryPipelineJob,
  buildStaleRecoverablePipelineJobWhere,
  buildPipelineLeaseClaimWhere,
} = require("../dist/services/novel/pipelineJobDedup.js");

test("selectPrimaryPipelineJob keeps the most progressed job when preferred job is stale", () => {
  const selected = selectPrimaryPipelineJob([
    { id: "job-progressed", completedCount: 4, progress: 0.45 },
    { id: "job-stale", completedCount: 1, progress: 0.1 },
  ], "job-stale");

  assert.equal(selected.id, "job-progressed");
});

test("selectPrimaryPipelineJob keeps the preferred job when progress is tied", () => {
  const selected = selectPrimaryPipelineJob([
    { id: "job-newer", completedCount: 2, progress: 0.25 },
    { id: "job-linked", completedCount: 2, progress: 0.25 },
  ], "job-linked");

  assert.equal(selected.id, "job-linked");
});

test("buildStaleRecoverablePipelineJobWhere uses now (not cutoff) for the lease-expiry branch", () => {
  const now = new Date("2026-07-05T12:00:00.000Z");
  const cutoff = new Date(now.getTime() - 180_000);
  const where = buildStaleRecoverablePipelineJobWhere({ cutoff, now });

  const leaseBranch = where.OR.find((clause) => clause.leaseExpiresAt);
  // 回归守卫：租约分支必须以 now 为基准，而非 cutoff。若用 cutoff，租约到期恢复会比
  // 心跳超时恒晚一个 staleThreshold，租约分支永远沦为冗余（P2#1）。
  assert.deepEqual(leaseBranch, { leaseExpiresAt: { lt: now } });

  const heartbeatBranch = where.OR.find(
    (clause) => clause.heartbeatAt && clause.heartbeatAt.lt,
  );
  assert.deepEqual(heartbeatBranch, { heartbeatAt: { lt: cutoff } });
});

test("buildPipelineLeaseClaimWhere only claims unclaimed or expired leases", () => {
  const now = new Date("2026-07-05T12:00:00.000Z");
  const where = buildPipelineLeaseClaimWhere({ jobId: "job-1", now });

  assert.equal(where.id, "job-1");
  assert.deepEqual(where.status, { in: ["queued", "running"] });
  assert.equal(where.cancelRequestedAt, null);
  assert.deepEqual(where.OR, [
    { leaseExpiresAt: null },
    { leaseExpiresAt: { lt: now } },
  ]);
});
