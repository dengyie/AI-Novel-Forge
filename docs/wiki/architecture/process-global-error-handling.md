# 进程级全局错误兜底

## 背景

生产 novel-server（supervisord 托管）历史上多次出现「无声 exit-1」：supervisor 记 `exit status 1; not expected` 并盲拉重启，但 `server.err.log` / `server.out.log` 全量 grep `uncaughtException|unhandledRejection|UnhandledPromiseRejection|originated either` 命中 **0 行**——崩溃不留任何栈，无从定位真正的逃逸点。

排查排除了所有常见原因：非 OOM（进程 VmHWM 远低于宿主 free，dmesg 无相关 kill）、非信号（supervisor 记 `not expected` 而非 `terminated by SIGTERM`）、非 bootstrap/shutdown 的显式 `process.exit(1)`（崩溃间隔期服务正常服务）。

根因是**进程级兜底为零**：整个 `server/src` 没有注册任何 `process.on("unhandledRejection")` / `process.on("uncaughtException")`。代码在每个调用点都纪律性地 `.catch`，两个中心聚合层（`capturePromptStream`、`streamToSSE`）都吞并迭代器 rejection——但这只是 per-point 防线。一旦未来新增代码或重构漏掉一处 `.catch`，或落在「rethrow 后又 fire-and-forget」的缝里，逃逸的 promise rejection 就走 Node 20 默认 `--unhandled-rejections=throw` → exit 1 → 不留栈地被 supervisor 盲拉。

**正是「无 handler」让崩溃无声**：没有谁把它写进日志。

## 决策

补一层**进程级观测网（NET）**：注册全局 `unhandledRejection` 与 `uncaughtException` handler，把「无声死」变「有声死」，并对逃逸的 promise rejection 做 last-resort 收口。

两条 handler 行为**不对称**，这是关键决策，不是随意为之：

- `unhandledRejection`：结构化记录后**继续运行**。逃逸的 rejection 多为异步逻辑 bug（漏掉的 `.catch`），不是堆损坏；在一个长跑、持 DB 锁 / 生成 lease / CAS revision 的进程上因一次异步逻辑 bug 而中途崩，代价高于继续运行。这也对齐 Node 社区主流默认（`--unhandled-rejections=warn`）。
- `uncaughtException`：结构化记录留栈后 **exit(1)**。同步异常意味着事件循环状态可能已损坏（Node 官方明确警告继续运行不安全）；本仓长跑 + 共享可变状态，继续跑会写出脏状态。**但这次会留下栈**，supervisor 仍 autorestart（行为不变，只是可诊断）。

这是 NET（进程级网 + 末路收口），**不替换**既有 per-point `.catch` 防线——两者互补：per-point `.catch` 是正常路径的错误归属；全局网只兜真正逃逸的漏网之鱼。

## 当前规则

- **唯一注册点**：`app.ts` 的 `bootstrap()` 顶部，在 `await startServer()` **之前**。确保 boot 期任何逃逸也被兜住。`require.main` 守卫下 `bootstrap()` 只走一次，无需去重 listener。
- **实现是可测试的纯构造 seam**：`services/globalErrorHandler.ts` 导出 `createGlobalErrorHandlers(ctx)`，**不**在此直接 `process.on`。注册胶水（`process.on(...)`）留在 `app.ts`，纯行为契约留在测试里覆盖（注入捕获式 `log` / `exit`，不碰真进程）。
- **日志通道复用 `logPipelineError`**（`services/novel/novelCoreShared.ts`），写 `[pipeline]` 前缀到 stderr——与既有管线错误 grep 口径一致。结构化 meta：rejection 记 `{ reasonMessage, reasonStack }`，exception 记 `{ message, stack }`。
- **handler 自身绝不抛**：描述 reason/error 时取兜底（裸字符串 / undefined / null / 裸对象 → `String(reason)`，缺栈 → `"<no stack>"`），整体包 try/catch，最末兜底写一行也不抛——否则又一条 uncaught 把观测网自己打死。
- **不触碰 graceful shutdown**：SIGTERM/SIGINT → `started.close()` → exit 0/1 的语义保持不变。`uncaughtException` 的 exit(1) 是独立的末路收口，不与 shutdown 路径竞争。
- **不为了「日志好看」删既有 `.catch`**：per-point `.catch` 是正常错误归属，必须在；全局网只在漏网时兜底。反过来，看到全局网记录到某条 unhandledRejection，**根因是补回漏掉的 per-point `.catch`**，不是依赖全局网常态化吞错。

## 示例

- **推荐**：新增 fire-and-forget async 仍显式 `.catch(error => logPipelineError(...))` 把错误归属到具体业务点；全局网只在真的漏写时兜底，并留下栈供定位那个漏写的点。
- **禁止**：把全局网当「懒得写 `.catch`」的借口——那会让每条逃逸都走进程级兜底，日志噪声淹没真问题，且 rejection 发生点到记录点之间的上下文已丢失。
- **禁止**：把 `uncaughtException` 改成「记录后继续」。Node 官方明确警告不安全；本仓共享可变状态会写脏。

## 失败模式

- **未来某次崩溃 supervisor 又记 `exit status 1; not expected`**：这正是观测网起作用的时刻。立刻 `grep -nE "unhandledRejection|uncaughtException" /personal/pxed/server.err.log | tail`，现在应能看到带栈的 `[pipeline] …` 行（修复前为 0 行）→ 定位真正逃逸点 → 补回那里的 per-point `.catch`。若长时间无崩溃也无新 unhandled 行，说明当前触发源已消除，且全局网就位防未来。
- **误判「全局网没记录 = 没问题」**：若日志无 unhandled 行但进程仍重启，复查是否别的 exit 路径（shutdown 超时、bootstrap 失败、外部信号、OOM），不要假设全局网失效。
- **不能用来掩盖问题的短期手段**：把 `uncaughtException` 的 exit(1) 注释掉以「止住重启」——那等于回到无声死，且继续写脏状态。

## 相关模块

- `server/src/services/globalErrorHandler.ts`（可测试构造 seam）
- `server/src/app.ts`（`bootstrap()` 顶部注册）
- `server/src/services/novel/novelCoreShared.ts`（`logPipelineError`，复用不改）
- `server/tests/globalErrorHandler.test.js`（TDD 行为契约）
- 进程托管：supervisord `novel-server`（autorestart 接力 exit(1)）

## 来源文档

- 2026-08-19 生产 novel-server 无声崩溃根因排查与 NET 修复（commit `c25c15c7`）
