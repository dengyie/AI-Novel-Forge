# pxed 生产运行时一致性与 OOM 恢复

## 背景

pxed 上 novel-server 与其它 Node 进程共享约 4 GiB、无 swap 的宿主内存。--max-old-space-size 只约束 V8 old space，不能覆盖 native heap、SQLite、Buffer、Prisma、线程和 ffmpeg 子进程；宿主级 OOM 可能直接 SIGKILL 进程。

## 当前规则

- novel-server 的 Supervisor 配置在 OOM 恢复阶段保持 autorestart=false，startretries 必须有限；恢复由人工单次启动并观察，避免 crash-loop 放大器。
- 部署 cutover 先生成 DB/dist/control-plane 快照，再原子替换 dist 和 Prisma generated client。
- CI 随 Prisma client 产出 manifest，包含 deploy SHA、client 版本、schema hash、generated client hash 和必需字段。
- 重启前运行 scripts/deploy/prisma-runtime-probe.cjs。探针只构造 Prisma client 并读取 _runtimeDataModel，不执行查询；字段缺失或 hash 不匹配时立即失败，禁止 restart。
- 线上排障同时记录 Supervisor 状态、PID、RSS、OOM counter、启动时间和 health/ready 响应，不能只看应用日志。

## 高负载执行边界（2026-09-19）

pxed 的 global OOM 不会被应用进程看到，`process.availableMemory()`、V8 heap 上限和容器 cgroup 余量都不能作为并发安全信号。因此高负载入口必须在业务上下文构造之前经过进程级准入：

- 批量章节 Pipeline 与直接单章运行共用 `PipelineExecutionAdmission`，默认并发 1，硬上限 4。
- 准入等待期间不领取数据库租约；取消请求会从等待队列移除，避免取消任务继续占用下一次执行机会。
- Volume Readiness 的 polish 入口也通过单章入口，不能从后台恢复路径绕过准入。
- Director、RAG、m4b 使用按需子进程；Director/RAG 子进程显式继承受控 V8 heap。m4b 队列记录真实 worker PID，API 父进程 PID 不可用于停滞杀进程。
- worker 异常退出后，持有的 m4b 任务最多自动回队一次；替换 worker 有短暂冷却，避免 crash-loop 形成重启和内存峰值放大器。
- RAG 主进程与子进程使用 Node `ChildProcess.send` IPC；RAG 检索只能通过 `ragMain` facade 访问，业务层不得重新 import 重型 RAG 服务。
- RAG worker 的 heartbeat watchdog 必须挂在 manager 的周期 tick 上；worker 心跳停止时先杀 worker，再按任务状态回队，不能只实现检查函数而不调度。
- RAG worker 任何异常退出（包括 OOM/SIGKILL）都必须在 manager 侧把 `running` 任务回队；只清理 IPC 而等待下一条 queued 任务会留下永久卡住的 running 行。
- m4b worker 退出的恢复顺序固定为「按 workerId CAS 回队/失败 → 冷却 → 检查 pending → 拉起替代 worker」。恢复与替代不能并行，否则数据库延迟会留下永久 pending。
- retrieval trace retention 只由主进程运行；RAG 子进程只负责检索和索引，避免两个 timer 重复扫描同一张表。
- RAG 运行时关闭必须停止现有子进程；重新启用只通过 manager 按需拉起，保证设置、队列和子进程状态一致。

诊断时应同时区分三类现象：主进程 RSS 仍高但没有活跃高负载任务，说明是常驻 import/堆底线；worker 被 SIGKILL 后任务回队，说明隔离边界生效但需检查 worker 堆和输入规模；任务长期 `processing` 且 `workerId` 不再对应当前 manager 子进程，说明是历史 ownership 数据，应回队而不能按该 PID 发信号。

## 失败模式

- SIGKILL 与宿主 oom_kill 计数同时增长：按 OOM 处理，先降低并发/内存占用并恢复 Supervisor，不要把它误判为 Prisma 或业务异常。
- Prisma 日志出现 Unknown field：先运行 runtime probe，检查实际加载的 @prisma/client 路径和 manifest hash；不要在生产机直接 generate 作为常规修复。
- probe 失败：保留快照，修复 artifact 或回滚到上一批完整 generated client；不得带着不一致的 Prisma runtime 重启。
- RAG 检索全部为空时，先查 `[RAG][Client] IPC send failed`、worker PID 和 heartbeat；不要把降级空上下文误判为“没有命中”。

## 相关模块

- scripts/deploy/prisma-runtime-probe.cjs
- scripts/deploy/create-prisma-manifest.cjs
- scripts/deploy/pxed-remote-cutover.sh
- .github/workflows/deploy-pxed.yml
