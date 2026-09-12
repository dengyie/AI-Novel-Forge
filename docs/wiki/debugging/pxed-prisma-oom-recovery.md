# pxed 生产运行时一致性与 OOM 恢复

## 背景

pxed 上 novel-server 与其它 Node 进程共享约 4 GiB、无 swap 的宿主内存。--max-old-space-size 只约束 V8 old space，不能覆盖 native heap、SQLite、Buffer、Prisma、线程和 ffmpeg 子进程；宿主级 OOM 可能直接 SIGKILL 进程。

## 当前规则

- novel-server 的 Supervisor 配置在 OOM 恢复阶段保持 autorestart=false，startretries 必须有限；恢复由人工单次启动并观察，避免 crash-loop 放大器。
- 部署 cutover 先生成 DB/dist/control-plane 快照，再原子替换 dist 和 Prisma generated client。
- CI 随 Prisma client 产出 manifest，包含 deploy SHA、client 版本、schema hash、generated client hash 和必需字段。
- 重启前运行 scripts/deploy/prisma-runtime-probe.cjs。探针只构造 Prisma client 并读取 _runtimeDataModel，不执行查询；字段缺失或 hash 不匹配时立即失败，禁止 restart。
- 线上排障同时记录 Supervisor 状态、PID、RSS、OOM counter、启动时间和 health/ready 响应，不能只看应用日志。

## 失败模式

- SIGKILL 与宿主 oom_kill 计数同时增长：按 OOM 处理，先降低并发/内存占用并恢复 Supervisor，不要把它误判为 Prisma 或业务异常。
- Prisma 日志出现 Unknown field：先运行 runtime probe，检查实际加载的 @prisma/client 路径和 manifest hash；不要在生产机直接 generate 作为常规修复。
- probe 失败：保留快照，修复 artifact 或回滚到上一批完整 generated client；不得带着不一致的 Prisma runtime 重启。

## 相关模块

- scripts/deploy/prisma-runtime-probe.cjs
- scripts/deploy/create-prisma-manifest.cjs
- scripts/deploy/pxed-remote-cutover.sh
- .github/workflows/deploy-pxed.yml
