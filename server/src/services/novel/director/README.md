# Novel Director 子系统

## 架构概览

长篇小说自动导演的后台执行分为三层：

### 1. 任务分发层（TaskDispatcher + DirectorTaskQueue）

- **`TaskDispatcher`** — 进程内事件总线。当新命令入队时发出信号，worker 立即唤醒。
  取代旧架构中 1.5 秒固定轮询，同时保留轮询作为跨进程和 crash recovery 兜底（5 秒间隔）。
- **`DirectorTaskQueue`** — 单活动队列抽象。当前只 lease / renew / complete / fail `DirectorRunCommand`，
  对外暴露 `leaseNext` / `completeTask` / `failTask` 语义。资源限流（ResourceGate）也由此层管理。

### 2. Worker 消费层（DirectorWorker）

Worker 是纯消费者，核心循环：
```
waitForWork() → leaseNext() → acquireResourceGate() → markRunning() → executeCommand() → completeTask()
```
不直接操作任何数据库模型。通过构造函数注入 `DirectorTaskQueue` 和 `DirectorCommandExecutor`，可在测试中替换为 mock。

### 3. 持久化与调度层（Services）

- **`DirectorCommandService`** — 命令应用 facade，校验任务事实、构造幂等键并创建或复用 `DirectorRunCommand`；HTTP 层只调用该 facade，不拥有命令状态机。
- **`DirectorCommandAcceptanceService`** — 在同一事务内提交新命令与任务 `queued` 投影；取消或终态先赢时让命令退出 active 状态。事务提交后才发送 `taskDispatcher.notify()`，该信号只用于降低同进程延迟，失败时由 durable queue 轮询兜底。
- **`commands/leases/DirectorCommandLeaseService`** — 统一拥有 command lease、过期恢复、终态 CAS 和取消事务；取消任务、active command、子运行状态与取消审计必须原子收束，facade 和 worker 不得各自维护第二套 lifecycle。
- **`DirectorCommandExecutor`** — 将命令解释为自动导演管线动作，并调用 `NovelDirectorService` 推进候选、接管、恢复、审批和修复流程。
- **`DirectorRuntimeStore` / `DirectorRuntimeService`** — 维护自动导演步骤、事件、artifact 和策略快照；不参与后台命令 lease。

## 门面入口

```typescript
import {
  DirectorCommandService,
  DirectorCommandExecutor,
  DirectorTaskQueue,
  taskDispatcher,
} from "./runtime/directorSubsystem";
```

## 目录边界

`director/` 根目录只保留稳定门面和兼容桥接。新增自动导演能力必须进入明确职责目录：

- `commands/`：后台命令创建、解释和执行。
- `state/`：导演任务状态读取、写入和提交。
- `projections/`：运行时投影、任务快照、进度和展示状态。
- `recovery/`：恢复、回填、下游重置和结构化大纲恢复游标。
- `phases/`：自动导演阶段、阶段节点适配和阶段级质量策略。
- `runtime/`：接管、确认、候选、继续执行、运行时编排和内存/校验策略。
- `automation/`：章节批次执行、pipeline job 协调、质量债和任务投影。每次 `AutoExecutionRangeRunner` 调用必须持有 run-local ownership fence；本目录的 checkpoint、批续窗、质量处理和异步投影只能经 fence 写入。pipeline job 终态仍由生产链的 lease/CAS 负责，automation 不得直写覆盖。
- `http/`：Express 路由映射。

外部模块优先依赖这些目录的门面或稳定入口，不应向 `director/` 根目录继续添加同前缀业务文件。

### 根目录现存文件契约（受 `tests/directorDirectoryBoundary.test.js` 固定）

根目录 `.ts` 文件集合当前固定为 7 个，新增根文件会被该测试拒绝：

- 门面：`NovelDirectorService.ts`
- 兼容桥接（re-export 1 行声明，主体在子目录）：
  `DirectorStateStore.ts` / `DirectorStateReader.ts` / `DirectorStateCommitter.ts`
  → 主体分别在 `state/DirectorStateStore.ts` 等。
- 历史遗留根文件（**对照 wiki `module-boundaries.md:L31` + `L20-21` 客观属违规，但当前受 `directorDirectoryBoundary.test.js` 精确文件名固定，故为「已设门延迟」而非合规**；迁移到子目录需先与责任人协商并同步更新该测试断言，再 `git mv`，顺序不可颠倒）：
  `novelDirectorConfirmNodeAdapters.ts`（38 行，逻辑归属 `phases/`，仅类型导入、无内部同级依赖，迁移风险低，但与现有 node adapter 放置习惯并行，暂留根）；
  `NovelDirectorIdeaInspirationService.ts`（82 行，独立 prompt 服务，逻辑归属 `commands/`，迁移涉及 `promptRunner` 等 `../../../` 深链补层级，暂留根）；
  `novelDirectorPipelineRuntime.ts`（695 行，逻辑归属 `runtime/`，且单文件接近 wiki `L20-21` 的 700 行扩展前必拆阈值，但主体有 10+ 处对 `./runtime`、`./recovery`、`../characterPrep`、`../storyMacro` 的同级深链，相对路径 rewire 属中风险，暂留根，后续若需收缩规模在拆分时一并归位）。

「保持根文件集合不变、不再新增同前缀根文件」是该测试在当前阈值下守住的底线，**不代表这 3 个历史遗留根文件目录边界合规**；L31 收敛目标仍是把它们移入对应子目录，但每次迁移必须先更新边界测试断言。

## 数据模型

系统当前只有一套活动后台命令队列：

| 层级 | 模型 | 用途 |
|------|------|------|
| Active Queue | `DirectorRunCommand` | 唯一活动命令队列，与 `NovelWorkflowTask` 直接关联 |
| Runtime Snapshot | `DirectorRun` → `DirectorStepRun` / `DirectorEvent` / `DirectorArtifact` | 自动导演步骤、事件和产物历史 |
| Legacy Runtime Queue | `DirectorRuntimeInstance` → `DirectorRuntimeCommand` → `DirectorRuntimeExecution` | 仅保留历史投影兼容，不再作为新的后台命令队列写入 |

新代码不应新增 `DirectorRuntimeCommand` / `DirectorRuntimeExecution` 写入路径。需要展示旧任务历史时，可以通过 runtime projection 读取这些历史行；需要排队执行时，必须通过 `DirectorCommandService` 创建 `DirectorRunCommand`。
