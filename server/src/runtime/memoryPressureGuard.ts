import v8 from "node:v8";
import { logMemoryUsage } from "./memoryTelemetry";

/**
 * 内存压力守卫（pxed 防 OOM）。
 *
 * 背景：pxed 宿主与其他租户共享，global OOM 按 badness（≈ rss + oom_score_adj）
 * 选杀对象。novel-server RSS 恒为容器内第一（~310-330MB，第二名 python3 仅 98MB），
 * 因此每次宿主压力都会命中本进程。V8 默认不把空闲堆还给 OS（VmHWM > VmRSS 恒成立），
 * 本守卫在进程空闲期主动 GC + 触发 V8 reduce-memory-use，把 RSS 打回低水位。
 *
 * 生效前提：run-server.sh 以 `NODE_OPTIONS="--expose-gc"` 启动（cutover 模板维护）。
 * 无 expose-gc 时本守卫只记录遥测，不做任何 GC（`global.gc` 缺失时静默跳过）。
 *
 * 触发条件：距上次活动（请求/长任务）≥ IDLE_AFTER_MS。
 * pxed 生产实测：空闲期 heapUsed 稳定在 ~175MB，若再叠加 heap 天花板条件则永远达不到、
 * GC 永不触发（2026-09-13 10:30 击杀后取证：6 tick 零 GC）。活动上报由 app.ts 全局
 * 中间件接线（noteMemoryGuardActivity），空闲判定即足够代表「业务不在途」——
 * m4b 编码在独立子进程，不占主进程堆。
 */

const GUARD_INTERVAL_MS = 60_000;
const IDLE_AFTER_MS = 90_000;

function mb(bytes: number): number {
  return Math.round((bytes / 1024 / 1024) * 10) / 10;
}

let lastActivityAt = Date.now();
let guardTimer: NodeJS.Timeout | null = null;

/** 测试钩子：注入 lastActivityAt / 收集 gcOnce 调用 / 手动触发 tick。 */
const testHooks = {
  gcCalls: [] as string[],
  triggerTick: (): void => guardTick(),
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  setState(patch: { lastActivityAt?: number; gcCalls?: string[] }): any {
    if (patch.lastActivityAt !== undefined) {
      lastActivityAt = patch.lastActivityAt;
    }
    if (patch.gcCalls !== undefined) {
      testHooks.gcCalls = patch.gcCalls;
    }
    return { lastActivityAt, gcCalls: testHooks.gcCalls };
  },
};

export const __testHooks = testHooks;

/** 业务侧活动上报点：任何 LLM 调用/长任务开始结束时调用，推迟 GC 时机。 */
export function noteMemoryGuardActivity(): void {
  lastActivityAt = Date.now();
}

function gcOnce(): void {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const maybeGc = (global as any).gc as (() => void) | undefined;
  if (typeof maybeGc !== "function") {
    return;
  }
  testHooks.gcCalls.push("gc");
  // 两段式：先常规 GC 回收代际垃圾，再触发 V8 的 shrink 标志压缩堆并二次回收，
  // 这一组在他处（如 heap 快照前收缩）是标准组合。
  v8.setFlagsFromString("--expose_gc");
  maybeGc();
  v8.setFlagsFromString("--reduce-memory-use");
  maybeGc();
  v8.setFlagsFromString("--no-reduce-memory-use");
}

function guardTick(): void {
  const memory = process.memoryUsage();
  const idleForMs = Date.now() - lastActivityAt;

  if (idleForMs >= IDLE_AFTER_MS) {
    gcOnce();
  }

  const after = process.memoryUsage();
  logMemoryUsage({
    event: "guard_tick",
    component: "memoryPressureGuard",
    scope: `idleForMs=${idleForMs} gc=${typeof (global as Record<string, unknown>).gc === "function"}`,
  });
  // logMemoryUsage 没有 rssDelta 字段，直接补一行关键差值，保持单行可 grep。
  console.info(
    `[memory][guard] rssBeforeMb=${mb(memory.rss)} rssAfterMb=${mb(after.rss)} ` +
      `heapUsedMb=${mb(after.heapUsed)} hwmMb=${mb(v8.getHeapStatistics().used_heap_size)}`,
  );
}

/** 启动守卫定时器（幂等）。app.ts 启动序列调用。 */
export function startMemoryPressureGuard(): void {
  if (guardTimer) {
    return;
  }
  guardTimer = setInterval(guardTick, GUARD_INTERVAL_MS);
  guardTimer.unref();
  console.info(
    `[memory][guard] started intervalMs=${GUARD_INTERVAL_MS} idleAfterMs=${IDLE_AFTER_MS} ` +
      `exposeGc=${typeof (global as Record<string, unknown>).gc === "function"}`,
  );
}

export function stopMemoryPressureGuard(): void {
  if (guardTimer) {
    clearInterval(guardTimer);
    guardTimer = null;
  }
}
