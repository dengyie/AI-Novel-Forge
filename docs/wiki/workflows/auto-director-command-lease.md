# 自动导演 Command Lease 与取消传播

## 背景

自动导演 command 由 Worker 租约执行。一个 command 是否完成，不能只看 API 方法是否返回；它必须覆盖该命令启动的真实规划、恢复或章节执行 runner。否则 Worker 会提前提交 command 成功，runner 却继续在租约之外写任务、章节和质量状态。

取消也不能只停在 Worker。租约丢失、command 取消或 ownership 失效后，同一个 `AbortSignal` 必须进入规划 LLM、自动执行端口和统一章节 runtime，所有后续投影在写入前都要重新检查该信号。

## 决策

Command 执行使用进程内 execution context 保存两个事实：

- 当前 command 的 `AbortSignal`。
- 当前调用是否必须等待真实 runner 完成。

该 context 只表达一次 command 执行的生命周期，不进入数据库、Prompt 输入或可序列化请求。Worker 通过 `DirectorCommandExecutor` 建立 context，后续服务从 context 读取 signal，不再给每一层增加互不一致的取消状态。

## 当前规则

- Worker 持有 command lease 时，`scheduleBackgroundRun` 必须返回并等待真实 runner Promise。`confirm`、`continue`、`resume`、`takeover`、候选恢复和章节标题修复都必须 `await` 该 Promise。
- 不持有 command lease 的普通后台调用可以继续异步调度，但不得被 Worker command 路径复用成 fire-and-forget。
- scheduler 在组装 usage context 前后、进入 runner 前后都必须检查 command signal。租约在任一 await 期间丢失时，不得再启动 runner。
- 普通 runner 错误先写任务失败，再向 command executor 重新抛出；错误不得因“后台调度”而被吞掉。
- Abort 不得改写为普通任务失败。它必须保留原始 reason 向 Worker 传播，由 Worker 按 lease lost 或 cancelled 归因。
- `runFromReady` 的调用契约必须携带 signal。自动执行模块负责消费该 signal、停止 pipeline job 和轮询；导演编排层不得直接实现章节 job 取消。
- 规划阶段的候选、标题、Story Macro、Book Contract、角色阵容与 tracked step 必须使用同一 signal。LLM 调用和 fallback catch 都不得把 abort 当成可降级错误。
- 自动导演进入章节生产后，只能把 signal 传入统一章节 runtime。不得新增导演专用 writer、repair 或 quality 分支。
- 章节 runtime 在正文提交、修复提交、质量分数、章节状态、timeline、fact、artifact 和 trace 投影前检查 signal。abort 后不得启动下一项写入。
- timeline 投影可以保持异步，但必须继承 command signal。等待后台 LLM 槽时也要响应 abort，并从等待队列移除，不能等到槽位超时后才结束。
- revision guard、CAS 和 ownership fence 继续负责并发写入完整性。AbortSignal 负责阻止后续动作，不能替代数据库所有权校验，也不能回滚已经进入数据库事务的单次写入。

## 调用边界

```text
DirectorWorker lease signal
  -> DirectorCommandExecutor execution context
  -> NovelDirectorService scheduler
  -> Director pipeline / continue / takeover runner
  -> NovelDirectorRuntimeOrchestrator
  -> runFromReady abortable port
  -> unified chapter runtime
  -> writer / review / repair / finalization / projections
```

Prompt Registry 和 Context Broker 的职责不变：signal 通过 Prompt 执行 options 传递，不进入业务 prompt 文本；章节上下文仍由统一 assembler/context boundary 组装。

## 失败模式

- Command 很快显示完成，章节仍在继续生成：检查调用点是否遗漏 `await scheduleBackgroundRun(...)`，以及 scheduler 是否处于 `waitForCompletion` context。
- Worker 报 lease lost，但任务随后变成 failed：检查外层 catch 是否在 abort 后仍调用 `markTaskFailed`。
- Worker 报 lease lost 后仍有新章节或质量记录：从 `runFromReady` 输入开始检查 signal 是否进入 pipeline job，再检查章节 commit 与 projection 前是否重新 guard。
- Timeline 或 fact 在取消后继续写：检查异步 schedule 是否携带 signal、timeline extractor 是否把 abort 降级成 warning、fact/timeline catch 是否吞掉 abort。
- Command 长时间停在后台 LLM 槽：检查槽位 waiter 是否监听 signal，并在 abort 时从 queue 移除。
- 普通模型错误没有到达 Worker：检查 scheduler 是否只记录日志却没有在 command 模式重新抛出 runner error。

## 相关模块

- `server/src/workers/directorWorker.ts`
- `server/src/services/novel/director/commands/DirectorCommandExecutor.ts`
- `server/src/services/novel/director/runtime/DirectorExecutionContext.ts`
- `server/src/services/novel/director/runtime/novelDirectorRuntimeOrchestrator.ts`
- `server/src/services/novel/director/automation/`
- `server/src/services/novel/runtime/`
- `server/src/services/novel/runtime/finalization/`

## 来源文档

- [自动导演 Runtime 与恢复边界](./auto-director-runtime.md)
- [章节生产链](./chapter-production-chain.md)
- [章节投影 Revision Ownership](./chapter-projection-revision-ownership.md)
