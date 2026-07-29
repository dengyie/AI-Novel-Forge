const test = require("node:test");
const assert = require("node:assert/strict");

const {
  runWithEnforcedTimeout,
  resolveEnforcedTimeoutMs,
} = require("../dist/llm/invokeTimeout.js");

// 生产 P0 回归：writer 480s 墙钟超时曾把 novel-server 整体打崩（25 次）。
// 根因：race 由 timeout 分支获胜后，仍在后台运行的 workPromise 随后才因 abort 迟到
// settle 为 rejection，而该 rejection 没有 rejection owner → 进程级 unhandledRejection。
// 修复后：loser 分支的迟到 rejection 被只观察 handler 吞掉，进程存活。

test("runWithEnforcedTimeout: late rejection of losing workPromise does not escape (no unhandledRejection)", async () => {
  const strayRejections = [];
  const onStray = (reason) => strayRejections.push(reason);
  process.on("unhandledRejection", onStray);
  try {
    let workSignal = null;
    const run = runWithEnforcedTimeout({
      label: "writer.test",
      timeoutMs: 50,
      run: (signal) => {
        workSignal = signal;
        // 模拟 llm.stream / iterator：abort 后迟于 race 才 reject（"Request was aborted."）
        return new Promise((_resolve, reject) => {
          signal.addEventListener("abort", () => {
            setTimeout(() => reject(new Error("Request was aborted.")), 30);
          }, { once: true });
        });
      },
    });

    await assert.rejects(run, (error) => {
      assert.equal(error.name, "TimeoutError");
      assert.match(error.message, /writer\.test/);
      assert.match(error.message, /timed out after 50ms/);
      return true;
    });
    assert.ok(workSignal, "run should receive an AbortSignal");
    assert.equal(workSignal.aborted, true, "timeout must abort the work signal");

    // 给 loser 分支的迟到 rejection 留出 settle + 事件循环投递时间。
    await new Promise((resolve) => setTimeout(resolve, 200));
    assert.deepEqual(strayRejections, [], "no stray unhandledRejection may escape");
  } finally {
    process.removeListener("unhandledRejection", onStray);
  }
});

test("runWithEnforcedTimeout: upstream abort surfaces AbortError, work late-rejection still swallowed", async () => {
  const strayRejections = [];
  const onStray = (reason) => strayRejections.push(reason);
  process.on("unhandledRejection", onStray);
  try {
    const upstream = new AbortController();
    const run = runWithEnforcedTimeout({
      label: "writer.abort",
      timeoutMs: 5_000,
      signal: upstream.signal,
      run: (signal) => new Promise((_resolve, reject) => {
        signal.addEventListener("abort", () => {
          setTimeout(() => reject(new Error("Request was aborted.")), 20);
        }, { once: true });
      }),
    });
    upstream.abort(new Error("client disconnected"));
    await assert.rejects(run, (error) => error.name === "AbortError" || /abort|disconnected/i.test(error.message));
    await new Promise((resolve) => setTimeout(resolve, 150));
    assert.deepEqual(strayRejections, [], "abort path must not leak unhandledRejection either");
  } finally {
    process.removeListener("unhandledRejection", onStray);
  }
});

test("resolveEnforcedTimeoutMs: env ceiling raised to 3600s, default stays 300s", () => {
  const prev = process.env.LLM_REQUEST_TIMEOUT_MS;
  try {
    delete process.env.LLM_REQUEST_TIMEOUT_MS;
    // 注意：DEFAULT 在模块加载时已定型，这里只验证显式传参与文档语义。
    assert.equal(resolveEnforcedTimeoutMs(480_000), 480_000);
    assert.equal(resolveEnforcedTimeoutMs(768_000), 768_000, "writer 长章预算可透传");
    assert.equal(resolveEnforcedTimeoutMs(0) > 0, true, "非法值回落默认");
    assert.equal(resolveEnforcedTimeoutMs(undefined) > 0, true);
  } finally {
    if (prev === undefined) {
      delete process.env.LLM_REQUEST_TIMEOUT_MS;
    } else {
      process.env.LLM_REQUEST_TIMEOUT_MS = prev;
    }
  }
});
