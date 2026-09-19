# RAG / Director 子进程化设计（pxed 防 OOM Phase 3）

日期：2026-09-13 ｜ 状态：已批准（方案 1：双 Manager + fork，检索走 IPC-RPC）

## 背景

pxed 宿主 OOM 可能按 badness 选择进程；当时的采样曾观察到 novel-server RSS 偏高，
并记录过 RAG 树、directorWorker 树的单次 import 测量。这些数值属于设计阶段的观测，
不是当前生产基线，也不能单独证明 OOM 根因。把重型 import 树移出主进程是候选的
内存隔离杠杆；是否降低宿主 OOM 风险必须用同一时间窗口的 RSS、cgroup 和 kill 证据验证，
不能把各堆增量直接相加或承诺某个 RSS 目标。

## 方案

沿用已验证的 M4bWorkerManager 模式：`child_process.fork`（内置 IPC，零新依赖）。

### 组件

1. **RagWorkerManager**（`src/runtime/RagWorkerManager.ts`）
   - 轮询 RagIndexJob（`hasPendingJobs`）→ fork `rag-worker` 子进程（入口新文件
     `src/workers/ragWorkerEntry.ts`，在启动阶段 dynamic import services/rag barrel 并
     `ragServices.ragWorker.start()`；IPC listener 先于该异步 bootstrap 注册，并用有界队列接住冷启动消息。
   - 检索代理：主进程 `RagClient`（`src/runtime/RagClient.ts`）通过 IPC 发送
     `{id, type: "buildContextBlock", payload}`，子进程调 `hybridRetrievalService.buildContextBlock`
     回 `{id, ok, result|error}`。30s 超时；失败/无子进程 → 返回空串（与 RAG-disabled 同语义）。
   - 生命周期：有 pending 任务或在途 RPC 时保持；队列空 + 在途完成 + 空闲宽限（RAG 10min）
     → 子进程自杀退出；Manager 按需再 fork。fork 前置环境 `RAG_WORKER_HEAP_MB=128`。
   - 心跳看门狗：子进程 30s 心跳，stalled ≥2min → SIGTERM→SIGKILL→重置 running 任务。

2. **DirectorWorkerManager**（`src/runtime/DirectorWorkerManager.ts`）
   - 轮询 DirectorRunCommand pending → fork 现有 `dist/workers/directorWorker.js`
     （已有 `require.main === module` 独立入口，含 bootstrap/信号处理）。
   - Manager 的 DB 轮询为当前发现待处理命令的基准；`DirectorWorkerManager.kick()` 保留为显式
     IPC 唤醒入口并可复位 idle 计时，但当前入队路径未接入该调用，因此不能把秒级唤醒当作
     已验证的运行时保证。
   - 空闲宽限 5min 后子进程退出；事件流：子进程日志即状态源，SSE 路由不感知变化。

3. **主进程瘦身**（app.ts + 消费点改线）
   - 删除 app.ts 的 `import { ragServices }` 与 `import { DirectorWorker }`；RAG 树与
     director 树不再由主进程直接构造；主进程是否达到预期内存变化必须用运行时 RSS/heap
     采样确认，不能从设计阶段的 import 增量推算目标值。
   - chat.ts:208 / novelReadTools.ts:457 → `RagClient.buildContextBlock()`（IPC-RPC）。
   - rag.ts 路由：任务列表、重建展开和清理走纯 DB/队列 facade；health 经由主进程 client
     向 RAG worker 发 RPC，不在主进程加载 embedding/vector service。
   - settings.ts:504-516：worker 启停改为只写 DB runtime 设置（子进程按轮询读取生效）；
     enqueueReindex 保留 DB 写路径。
   - `RagRetrievalTraceRetention` 定时器保留在主进程（仅 prisma，不引重树）。

## 不做

- worker_threads/cluster（共享堆、无隔离）；单重子进程（其 ~170MB 堆会成为容器第一）。
- 主进程内惰性 import（JS 无法卸载模块，首聊后树永久常驻）。

## 验证

- 单测：RagClient 冷启动/超时/降级、Manager 生命周期状态机（fast tests）。
- 生产验证必须在同一 workload 与时间窗口采集父子 PID、RSS/峰值、Node heap/native 指标、
  cgroup kill 记录和 RAG/聊天/Director 冒烟结果；除非这些证据支持，否则不设定固定 RSS
  阈值或宣称 OOM 根因已确认。
