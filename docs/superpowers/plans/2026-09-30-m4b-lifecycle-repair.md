# M4B lifecycle repair implementation plan

**Goal:** 正确启动独立编码进程、依据真实推进判停滞，并禁止旧代际发布或覆盖新任务。

**Architecture:** M4B 队列保有代际与每次领取的随机租约。发布在数据库事务内先锁定任务代际，再锁定领取租约，最后执行短时文件 rename；所有代际轮换本身更新同一任务行，数据库行写锁使跨进程发布与轮换串行。worker 的取消和退出等待 ffmpeg 进程组清理；健康推进时间独立于领取时间。

## Responsibilities
- `m4b/M4bWorkerManager`: 启动、退出、恢复；使用实际编译入口与 Node 可执行文件。
- `m4b/M4bJobQueueService`: 领取租约、推进、收口、事务发布；同代际可重试，旧代际拒绝。
- `m4b/M4bEncodingCore`: 只生成独有 part，委托持有租约的发布者。
- `m4b/M4bWorkerRuntime`: 信号/数据库代际取消、队列轮询与编码资源生命周期。
- `m4b/M4bPipelineDispatch`: 从大 pipeline 抽出入队编排，不再扩张大文件。
- 两套 Prisma schema 和 additive migration：generationToken、leaseToken、lastProgressAt。

## Steps
- [x] 保存当前入口与停滞复现为失败测试；建立隔离 SQLite 验证环境。
- [x] 修复入口与故障反馈，验证真实 worker 可启动。
- [x] 实现代际/领取租约、原子发布；测试旧代际与并发轮换无法覆盖新文件。
- [x] 连接真实增长心跳与 SIGTERM / 代际取消，验证进程组停止及恢复只发生一次。
- [x] 定向回归、类型构建、wiki / 日期发布说明与阶段提交。

## Boundaries
不变更小说正文、生产数据或部署；不运行 UI 验收。不把进程内 mutex 当成跨进程所有权保证。

## Verification evidence

- Red: `/tmp/m4b-lifecycle-red.log`（2 failures）, `/tmp/m4b-generation-red.log`（旧 core 忽略拒绝发布）。
- Green: 定向 45 项通过；新增真实 worker / SIGTERM / SIGKILL / 跨进程 SQLite 发布测试通过。
- 冷启动 shell fixture 实测 3.5 秒，旧测试的 2 秒启动屏障超时调整为 8 秒，仍等待显式启动信号。
- PostgreSQL 运行时与 Windows 原生进程清理未在本机执行；不把 schema 校验作为这些环境的运行证据。

## Shutdown boundary follow-up

- Baseline: `6bfe62df1ffe020ad92a68db30c6f6dcf3ffb296`.
- Root cause: 关闭标志仅在 async 方法入口检查，查询和 spawn 等待之后继续创建资源；spawn 等待没有 exit 收口。
- Minimal fix: 三处异步恢复边界再校验，watchdog 入口拒绝关闭后启动；spawn/error/exit 共同收口且清理临时监听器。
- Red evidence: `/tmp/m4b-shutdown-red.log`，三个独立异步屏障场景失败。
- Verification: `m4bShutdownRace`、`m4bLifecycleRegression`、`m4bWorkerRecovery`、`m4bWorkerOwnership` 定向回归及 server build。
