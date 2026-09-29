# M4B 独立编码边界

- `M4bPipelineDispatch`：章节流水线只提交绑定当前代际的任务。入队失败上抛，禁止在持久队列之外再启动无归属的第二个编码器。
- `M4bJobQueueService`：数据库是代际与领取租约的权威。入队、重排、发布统一先锁 `AudiobookTask` 再修改 job；进度和失败写入使用精确租约 CAS。
- `M4bWorkerRuntime`：启动前与运行中确认代际，取消传播到 ffmpeg 的 AbortSignal；只有产物增长才刷新 `lastProgressAt`。
- `M4bEncodingCore`：创建独有临时文件，发布委托给队列。不能依据规范文件存在而跳过生成，也不能自行 rename。
- `M4bWorkerManager` / `M4bOwnedProcess`：进程退出先终止已验证归属的编码进程组，再回收租约。IPC 记录只来自受管子进程；不能依据数据库 PID 任意终止系统进程。

数据库事务内的 task 条件写入持有行写锁（SQLite 为写事务锁），随后租约 CAS、同步 rename、提交。另一进程轮换代际必须写同一行，因此它只能在发布前使条件失败，或在发布后执行新代清理。进程内 mutex 无法提供这个保证。

数据库与文件系统不是分布式事务：rename 后提交失败会保留同代可用文件；job 未完成可重试编码覆盖同代文件。代际变化仍先持久化再清理，旧 worker 不得据文件存在认领成功。

当前测试在 SQLite 上验证真实跨进程串行、进程取消和 SIGKILL；PostgreSQL 使用同一行写锁协议，须在 PostgreSQL 集成环境验收。Windows 有命令行身份核验 + taskkill 路径，POSIX 进程组测试不作为 Windows 运行证据。
