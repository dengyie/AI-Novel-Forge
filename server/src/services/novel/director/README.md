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

- **`DirectorCommandService`** — HTTP 入口，创建 `DirectorRunCommand`，并发出 `taskDispatcher.notify()` 唤醒信号。
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
- `http/`：Express 路由映射。

外部模块优先依赖这些目录的门面或稳定入口，不应向 `director/` 根目录继续添加同前缀业务文件。

### 根目录现存文件契约（受 `tests/directorDirectoryBoundary.test.js` 固定）

根目录 `.ts` 文件集合固定为 7 个，分两类，新增根文件会被该测试拒绝：

- 门面：`NovelDirectorService.ts`
- 兼容桥接（re-export 1 行声明，主体在子目录）：
  `DirectorStateStore.ts` / `DirectorStateReader.ts` / `DirectorStateCommitter.ts`
  → 主体分别在 `state/DirectorStateStore.ts` 等。
- 历史遗留根文件（主体仍在根，迁移到子目录需先与责任人协商并同步更新边界测试断言）：
  `novelDirectorConfirmNodeAdapters.ts`（38 行，逻辑归属 `phases/`，仅类型导入、无内部同级依赖，迁移风险低，但与现有 node adapter 放置习惯并行，暂留根）；
  `NovelDirectorIdeaInspirationService.ts`（82 行，独立 prompt 服务，逻辑归属 `commands/`，迁移涉及 `promptRunner` 等 `../../../` 深链补层级，暂留根）；
  `novelDirectorPipelineRuntime.ts`（695 行，逻辑归属 `runtime/`，但主体有 10+ 处对 `./runtime`、`./recovery`、`../characterPrep`、`../storyMacro` 的同级深链，迁移的相对路径 rewire 属中风险，暂留根，后续若需收缩规模在拆分时一并归位）。

保持根文件集合不变、不再新增同前缀根文件即为本子系统的目录边界合规要求。

## 数据模型

系统当前只有一套活动后台命令队列：

| 层级 | 模型 | 用途 |
|------|------|------|
| Active Queue | `DirectorRunCommand` | 唯一活动命令队列，与 `NovelWorkflowTask` 直接关联 |
| Runtime Snapshot | `DirectorRun` → `DirectorStepRun` / `DirectorEvent` / `DirectorArtifact` | 自动导演步骤、事件和产物历史 |
| Legacy Runtime Queue | `DirectorRuntimeInstance` → `DirectorRuntimeCommand` → `DirectorRuntimeExecution` | 仅保留历史投影兼容，不再作为新的后台命令队列写入 |

新代码不应新增 `DirectorRuntimeCommand` / `DirectorRuntimeExecution` 写入路径。需要展示旧任务历史时，可以通过 runtime projection 读取这些历史行；需要排队执行时，必须通过 `DirectorCommandService` 创建 `DirectorRunCommand`。
