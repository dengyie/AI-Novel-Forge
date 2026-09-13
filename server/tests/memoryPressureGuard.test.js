const test = require("node:test");
const assert = require("node:assert/strict");

const {
  __testHooks,
} = require("../dist/runtime/memoryPressureGuard.js");

test("memoryPressureGuard ticks only GC after idle threshold", () => {
  const { triggerTick, setState } = __testHooks;
  // 测试运行器无 --expose-gc，注入 stub 验证空闲判定路径
  const originalGc = global.gc;
  global.gc = () => {};
  try {
    setState({ lastActivityAt: Date.now(), gcCalls: [] });
    // 刚活动：不 GC
    triggerTick();
    assert.equal(setState({}).gcCalls.length, 0);
    // 模拟空闲超过 IDLE_AFTER_MS：GC
    setState({ lastActivityAt: Date.now() - 10 * 60 * 1000 });
    triggerTick();
    assert.equal(setState({}).gcCalls.length, 1);
  } finally {
    if (originalGc) global.gc = originalGc;
  }
});

test("memoryPressureGuard gcOnce works without expose-gc", () => {
  const { triggerTick, setState } = __testHooks;
  setState({ lastActivityAt: Date.now() - 10 * 60 * 1000, gcCalls: [] });
  // global.gc 缺失时静默跳过，不抛错
  const originalGc = global.gc;
  delete global.gc;
  try {
    triggerTick();
  } finally {
    if (originalGc) global.gc = originalGc;
  }
  assert.equal(setState({}).gcCalls.length, 0);
});
