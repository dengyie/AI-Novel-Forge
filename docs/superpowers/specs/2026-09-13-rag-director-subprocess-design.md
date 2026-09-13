# RAG / Director 子进程化设计（pxed 防 OOM Phase 3）

日期：2026-09-13 ｜ 状态：已批准（方案 1：双 Manager + fork，检索走 IPC-RPC）

## 背景

pxed 宿主 OOM 按 badness 选杀，novel-server RSS ~250MB 恒为容器第一。heapUsed 稳态 ~171MB，
实测 import 树：RAG 树 +85MB、directorWorker 树 +96MB（与主树重叠 ~15MB）。把这两棵树从
主进程剥离是唯一可冲到 <150MB（甚至 <98MB 让出首选击杀位）的杠杆。

## 方案

沿用已验证的 M4bWorkerManager 模式：`child_process.fork`（内置 IPC，零新依赖）。

### 组件

1. **RagWorkerManager**（`src/runtime/RagWorkerManager.ts`）
   - 轮询 RagIndexJob（`hasPendingJobs`）→ fork `rag-worker` 子进程（入口新文件
     `src/workers/ragWorkerEntry.ts`，require services/rag barrel 并 `ragServices.ragWorker.start()`）。
   - 检索代理：主进程 `RagClient`（`src/runtime/RagClient.ts`）通过 IPC 发送
     `{id, type: "buildContextBlock", payload}`，子进程调 `hybridRetrievalService.buildContextBlock`
     回 `{id, ok, result|error}`。30s 超时；失败/无子进程 → 返回空串（与 RAG-disabled 同语义）。
   - 生命周期：有 pending 任务或在途 RPC 时保持；队列空 + 在途完成 + 空闲宽限（RAG 10min）
     → 子进程自杀退出；Manager 按需再 fork。fork 前置环境 `RAG_WORKER_HEAP_MB=128`。
   - 心跳看门狗：子进程 30s 心跳，stalled ≥2min → SIGTERM→SIGKILL→重置 running 任务。

2. **DirectorWorkerManager**（`src/runtime/DirectorWorkerManager.ts`）
   - 轮询 DirectorRunCommand pending → fork 现有 `dist/workers/directorWorker.js`
     （已有 `require.main === module` 独立入口，含 bootstrap/信号处理）。
   - DB 轮询（worker 内 ~3s pollMs）为基准；入队时主进程通过 IPC 发 `kick` 消息实现秒级唤醒
     （主进程在入队路径 taskDispatcher.notify() 处同时 `directorWorkerManager.kick()`）。
   - 空闲宽限 5min 后子进程退出；事件流：子进程日志即状态源，SSE 路由不感知变化。

3. **主进程瘦身**（app.ts + 消费点改线）
   - 删除 app.ts 的 `import { ragServices }` 与 `import { DirectorWorker }`；RAG 树与
     director 树不再进主进程堆（预计 heap 171 → ~50-90MB，RSS → ~120-150MB）。
   - chat.ts:208 / novelReadTools.ts:457 → `RagClient.buildContextBlock()`（IPC-RPC）。
   - rag.ts 路由：reindex/cleanup/health 改为纯 DB 行操作 + 轻量 HTTP（embedding/Qdrant
     healthCheck 走直接 fetch，不引 RAG 类）。
   - settings.ts:504-516：worker 启停改为只写 DB runtime 设置（子进程按轮询读取生效）；
     enqueueReindex 保留 DB 写路径。
   - `RagRetrievalTraceRetention` 定时器保留在主进程（仅 prisma，不引重树）。

## 不做

- worker_threads/cluster（共享堆、无隔离）；单重子进程（其 ~170MB 堆会成为容器第一）。
- 主进程内惰性 import（JS 无法卸载模块，首聊后树永久常驻）。

## 验证

- 单测：RagClient 超时/降级、Manager 生命周期状态机（fast tests）。
- `pnpm test` → main push 自动 cutover → 生产 guard 遥测 RSS <150MB、RAG/聊天/director 冒烟。
