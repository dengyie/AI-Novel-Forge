# Novel Director 子系统

## 架构概览

长篇小说自动导演的后台执行分为三层：

### 1. 任务分发层（TaskDispatcher + DirectorTaskQueue）

- **`TaskDispatcher`** — 进程内事件总线。当新命令入队时发出信号，worker 立即唤醒。
  取代旧架构中 1.5 秒固定轮询，同时保留轮询作为跨进程和 crash recovery 兜底（5 秒间隔）。
- **`DirectorTaskQueue`** — 统一队列抽象。封装底层双持久化系统（`DirectorRunCommand` + `DirectorRuntimeCommand`），
  对外暴露 `leaseNext` / `completeTask` / `failTask` 语义。资源限流（ResourceGate）也由此层管理。

### 2. Worker 消费层（DirectorWorker）

Worker 是纯消费者，核心循环：
```
waitForWork() → leaseNext() → acquireResourceGate() → markRunning() → executeCommand() → completeTask()
```
不直接操作任何数据库模型。通过构造函数注入 `DirectorTaskQueue` 和 `DirectorExecutionService`，可在测试中替换为 mock。

### 3. 持久化与调度层（Services）

- **`DirectorCommandService`** — HTTP 入口，创建 `DirectorRunCommand` 并桥接到 Runtime 系统，同时发出 `taskDispatcher.notify()` 唤醒信号。
- **`DirectorRuntimeExecutionService`** — Runtime 系统的执行租约管理。
- **`DirectorWorkerReconciliationService`** — 兜底调和：回收 stale lease、关闭终态任务步骤、收养 legacy 命令。

## 门面入口

```typescript
import {
  DirectorCommandService,
  DirectorExecutionService,
  DirectorTaskQueue,
  taskDispatcher,
} from "./directorSubsystem";
```

## 数据模型

系统当前维护两套并行队列（历史演进产物）：

| 层级 | 模型 | 用途 |
|------|------|------|
| Legacy | `DirectorRunCommand` | 原始命令队列，与 `NovelWorkflowTask` 直接关联 |
| Runtime | `DirectorRuntimeInstance` → `DirectorRuntimeCommand` → `DirectorRuntimeExecution` | 执行容器 + 命令 + 租约追踪 |

`DirectorTaskQueue` 封装了双系统的桥接逻辑，新代码不应直接操作这两套模型。
