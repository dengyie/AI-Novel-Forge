/**
 * 进程级全局错误兜底（NET，不替换既有 per-point `.catch` 防线）。
 *
 * 背景：生产 novel-server 历史上出现「无声 exit-1」——supervisord 记 `exit status 1; not expected`，
 * 但 server.err.log 里既无 unhandledRejection 也无 uncaughtException 栈。根因是整个进程
 * **没有**注册任何全局 handler：任何逃逸的 promise rejection（未来新增/重构漏掉一处 `.catch`，
 * 或落在「rethrow 后又 fire-and-forget」的缝里）都会走 Node 20 默认 `--unhandled-rejections=throw`
 * → exit 1 → 不留栈地被 supervisor 盲拉重启。本模块补上这层观测网：
 *
 * - `unhandledRejection`：多为异步逻辑 bug（逃逸的 rejection），非堆损坏 → 结构化记录后**继续运行**，
 *   风险低于在长跑+持 DB 锁/生成 lease/CAS revision 的进程上中途崩。
 * - `uncaughtException`：事件循环状态可能已损坏（Node 官方明确警告继续运行不安全）→
 *   结构化记录后 **exit(1)**，把「无声死」变「有声死」，supervisor autorestart 接力（行为不变，仅可诊断）。
 *
 * 设计为纯构造 seam（不在此直接 `process.on`），便于 TDD：测试注入捕获式 log/exit 断言契约，
 * 注册胶水留在 app.ts 的 bootstrap() 顶部（早于 startServer()，兜住 boot 期逃逸）。
 * 复用既有 `logPipelineError` 风格（`[pipeline]` 前缀写 stderr），运维 grep 一致。
 */

export interface GlobalErrorHandlerContext {
  /** 结构化记录入口；签名对齐 novelCoreShared.logPipelineError(message, meta?)。 */
  log: (message: string, meta?: Record<string, unknown>) => void;
  /** 进程退出；测试注入捕获，生产传 process.exit。 */
  exit?: (code: number) => void;
}

export interface GlobalErrorHandlers {
  handleUnhandledRejection: (reason: unknown, promise: Promise<unknown>) => void;
  handleUncaughtException: (error: unknown) => void;
}

const NO_STACK = "<no stack>";

function describeReason(reason: unknown): { reasonMessage: string; reasonStack: string } {
  if (reason instanceof Error) {
    return {
      reasonMessage: reason.message,
      reasonStack: typeof reason.stack === "string" && reason.stack.length > 0 ? reason.stack : NO_STACK,
    };
  }
  if (reason === undefined || reason === null) {
    return { reasonMessage: String(reason), reasonStack: NO_STACK };
  }
  if (typeof reason === "object") {
    const message = String((reason as { message?: unknown }).message ?? reason);
    const stack = (reason as { stack?: unknown }).stack;
    return {
      reasonMessage: message,
      reasonStack: typeof stack === "string" && stack.length > 0 ? stack : NO_STACK,
    };
  }
  return { reasonMessage: String(reason), reasonStack: NO_STACK };
}

function describeError(error: unknown): { message: string; stack: string } {
  if (error instanceof Error) {
    return {
      message: error.message,
      stack: typeof error.stack === "string" && error.stack.length > 0 ? error.stack : NO_STACK,
    };
  }
  if (typeof error === "object" && error !== null) {
    const message = String((error as { message?: unknown }).message ?? error);
    const stack = (error as { stack?: unknown }).stack;
    return {
      message,
      stack: typeof stack === "string" && stack.length > 0 ? stack : NO_STACK,
    };
  }
  return { message: String(error), stack: NO_STACK };
}

export function createGlobalErrorHandlers(ctx: GlobalErrorHandlerContext): GlobalErrorHandlers {
  const log = ctx.log;
  const exit = ctx.exit;

  return {
    handleUnhandledRejection(reason: unknown, _promise: Promise<unknown>): void {
      try {
        const { reasonMessage, reasonStack } = describeReason(reason);
        log("unhandledRejection: 逃逸的 promise rejection 已被全局网兜住（记录后继续运行）", {
          reasonMessage,
          reasonStack,
        });
      } catch {
        // handler 自身绝不抛（否则又一条 uncaught）。最后兜底：尽力写一行。
        try {
          log("unhandledRejection: 记录失败（reason 描述抛错）");
        } catch {
          /* 静默 */
        }
      }
      // 继续：不退出。
    },

    handleUncaughtException(error: unknown): void {
      try {
        const { message, stack } = describeError(error);
        log("uncaughtException: 同步异常已损坏事件循环，记录后 exit(1)（supervisor 接力重启）", {
          message,
          stack,
        });
      } catch {
        try {
          log("uncaughtException: 记录失败（error 描述抛错）");
        } catch {
          /* 静默 */
        }
      }
      // 留栈后退出。继续运行不安全（Node 官方），且本仓长跑+共享可变状态会写脏。
      if (typeof exit === "function") {
        exit(1);
      }
    },
  };
}
