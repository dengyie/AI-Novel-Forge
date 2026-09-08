const test = require("node:test");
const assert = require("node:assert/strict");

// 经 node --test 打 dist/。本模块是纯构造 seam（无 prisma/无网络），测试注入捕获式
// log 与 exit，断言两条全局 handler 的行为契约：
//   - unhandledRejection：结构化记录 reason+stack，**继续运行**（不退出）
//   - uncaughtException：结构化记录 message+stack，**exit(1)**（继续运行不安全，但留栈）
//   - 非 Error reason / 缺栈：取兜底文案，handler 自身绝不抛
const {
  createGlobalErrorHandlers,
} = require("../dist/services/globalErrorHandler.js");

/** 收集式 log：把每条 (message, meta) 推进数组，供断言。 */
function makeCapturingLog() {
  const calls = [];
  return {
    log: (message, meta) => {
      calls.push({ message, meta });
    },
    calls,
  };
}

test("RED-1: handleUnhandledRejection 记录 reason+栈，且不调用 exit（继续运行）", () => {
  const { log, calls } = makeCapturingLog();
  let exitCode = null;
  const handlers = createGlobalErrorHandlers({
    log,
    exit: (code) => {
      exitCode = code;
    },
  });

  const reason = new Error("上游流中断：Upstream request failed");
  handlers.handleUnhandledRejection(reason, Promise.resolve());

  assert.equal(calls.length, 1, "unhandledRejection 须记录一次");
  const entry = calls[0];
  assert.ok(/unhandledRejection/i.test(entry.message), `message 须标明 unhandledRejection，实际：${entry.message}`);
  assert.ok(entry.meta && typeof entry.meta === "object", "须带结构化 meta");
  assert.match(String(entry.meta.reasonMessage ?? ""), /上游流中断/, "meta.reasonMessage 须含 reason 文案");
  assert.ok(
    typeof entry.meta.reasonStack === "string" && entry.meta.reasonStack.length > 0,
    "meta.reasonStack 须为非空字符串（来自 Error.stack）",
  );
  assert.equal(exitCode, null, "unhandledRejection 不得退出进程（继续运行）");
});

test("RED-2: handleUncaughtException 记录 message+栈，并 exit(1)", () => {
  const { log, calls } = makeCapturingLog();
  let exitCode = null;
  const handlers = createGlobalErrorHandlers({
    log,
    exit: (code) => {
      exitCode = code;
    },
  });

  const err = new Error("事件循环状态可能已损坏");
  handlers.handleUncaughtException(err);

  assert.equal(calls.length, 1, "uncaughtException 须记录一次");
  const entry = calls[0];
  assert.ok(/uncaughtException/i.test(entry.message), `message 须标明 uncaughtException，实际：${entry.message}`);
  assert.ok(entry.meta && typeof entry.meta === "object", "须带结构化 meta");
  assert.match(String(entry.meta.message ?? ""), /事件循环状态/, "meta.message 须含 error 文案");
  assert.ok(
    typeof entry.meta.stack === "string" && entry.meta.stack.length > 0,
    "meta.stack 须为非空字符串",
  );
  assert.equal(exitCode, 1, "uncaughtException 须 exit(1)（留栈后退出，supervisor 接力重启）");
});

test("RED-3: 非 Error reason 与缺栈不抛、兜底文案（handler 自身绝不崩）", () => {
  const { log, calls } = makeCapturingLog();
  const handlers = createGlobalErrorHandlers({ log, exit: () => {} });

  // 逃逸的 rejection 常常不是 Error 实例（字符串、裸对象、undefined）。
  assert.doesNotThrow(() => handlers.handleUnhandledRejection("a bare string reason", Promise.resolve()));
  assert.doesNotThrow(() => handlers.handleUnhandledRejection(undefined, Promise.resolve()));
  assert.doesNotThrow(() => handlers.handleUncaughtException(null));
  assert.doesNotThrow(() => handlers.handleUncaughtException({ weird: "plain object" }));

  assert.equal(calls.length, 4, "四次调用各记录一次");
  // 裸字符串 reason：reasonMessage 取 String(reason)，reasonStack 兜底为 <no stack> 之类。
  const strEntry = calls[0];
  assert.match(String(strEntry.meta.reasonMessage ?? ""), /bare string/, "裸字符串 reason 须落到 reasonMessage");
  assert.ok(
    typeof strEntry.meta.reasonStack === "string",
    "reasonStack 须始终为字符串（兜底，不得 undefined）",
  );
  // 缺栈时给出明确占位，运维一眼看出「这条没栈」而非空白。
  const noStackEntry = calls[1]; // undefined reason
  assert.ok(
    /no stack|无栈|<no stack>/i.test(String(noStackEntry.meta.reasonStack)),
    `缺栈须兜底占位，实际：${noStackEntry.meta.reasonStack}`,
  );
});
