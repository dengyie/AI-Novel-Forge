# 启动恢复与服务就绪边界

## 背景

服务启动时需要扫描并恢复多个可持久化任务域：拆书、图片、自动导演、章节流水线、写法提取和有声书。恢复动作可能遇到短暂数据库抖动，也可能只影响其中一个任务域。HTTP 进程存活、数据库可访问和后台任务恢复完成是三个不同状态，不能用其中一个状态替代另外两个。

## 决策

- `/api/health` 只表示进程存活。
- `/api/health/ready` 只有在启动恢复全部域完成且没有 degraded 域、数据库探针成功时才返回 200。
- 恢复初始化使用共享 Promise，并按固定顺序逐域扫描。单个域失败会记录域名并进入 degraded，不取消后续域，也不直接终止 server；禁止用 `Promise.all` / `Promise.allSettled` 在重启窗口同时启动所有恢复域。
- degraded 启动保留服务进程与健康诊断入口，同时以 503 阻止普通 API 和 readiness；后台按退避间隔只重试失败域，全部成功后才恢复 ready。
- `/api/health` 必须位于启动门禁之前；普通 `/api/*` 的启动门禁必须位于 JSON body parser 和限流器之前。恢复期间不能先接收最高 20MB 请求体，也不能消耗恢复完成后的首批限流额度。
- 持久化模型密钥必须在恢复扫描前载入；可能立即执行长链路的 Director worker、Volume Readiness、RAG/watchdog 与定时扫描器只能在核心恢复扫描结束后启动。
- “恢复域扫描串行”不等于“真实任务执行串行”。章节 Pipeline、Director 与 m4b 必须各自拥有进程级高负载准入：默认并发 1，显式配置也必须有硬上限。启动期 Volume Readiness 跨小说逐条执行，不能为每本书 fire-and-forget 扇出；Director 必须等待这条后台恢复 Promise 完成后才能开始 leasing，HTTP readiness 不等待整卷长任务。
- 若启动阶段发生无法归属为单域恢复失败的异常，必须停止已启动的后台资源并关闭 HTTP listener，再把异常交给 bootstrap 的进程级失败处理。
- 有声书恢复扫描必须按稳定唯一键分页；活动任务查询不应加载历史 `resultJson`，只有 succeeded 任务需要读取 m4b 持久标记。这样历史任务数量或 JSON 体积增长不会把启动恢复变成一次性内存峰值。

## 当前规则

`RecoveryTaskService.initializePendingRecoveries()` 返回共享初始化结果，其中 `failedDomains` 是持久任务恢复没有完成的域。`waitUntilReady()` 等待本轮串行扫描结束，不把 degraded 误报为 rejection；需要重试时通过 `retryPendingRecoveries()` 重新执行幂等扫描。

`startServer()` 在监听期间把 readiness 置为 `starting`，恢复成功后置为 `ready`，存在失败域时置为 `degraded`。启动异常的清理由后台服务初始化和 HTTP 启动层共同负责，避免半启动端口或扫描器继续运行。

`retryPendingRecoveries()` 只重试上一轮失败的域；已经成功的域不因其它域暂时失败而重复扫描或重复入队。每个域仍需保持自身幂等，以应对进程重启和显式重试。

高负载任务的默认进程并发规则：

- Pipeline：`PIPELINE_EXECUTION_CONCURRENCY=1`，硬上限 4；先取得许可，再认领数据库租约，避免任务在内存排队期间持有会过期的租约。
- Director：`DIRECTOR_WORKER_EXECUTION_SLOTS=1`，硬上限 4；容器内可用内存不能代表宿主 global OOM 水位，禁止依据 CPU 数自动扩槽。
- m4b：`AUDIOBOOK_M4B_CONCURRENCY=1`，硬上限 4；单个 ffmpeg 默认 2 线程，硬上限 4。
- Volume Readiness startup auto-resume：同小说只选最新可运行项，不同小说也逐条等待完成；定时巡检只能在该恢复序列结束后启动。
- 恢复中的 Pipeline 任务如果在进程级高负载准入队列等待期间收到取消，准入边界必须执行取消终态收口；不能仅因恢复认领 CAS 未命中就退出，否则会留下 `cancelRequestedAt` 且 `finishedAt=null` 的不可重试任务。
- 启动消费者（Web 启动门禁、桌面托管服务探针）必须探测 `/api/health/ready`；`/api/health` 只供进程存活、隧道和 supervisor 使用，不能作为业务入口放行条件。

域内批量扫描允许单条任务失败后继续处理其它任务，但必须在本轮结束后以聚合错误标记该域 degraded；不能只记录日志并把 readiness 报为健康，否则失败任务会永久停在原状态而没有自动重试机会。

## 失败模式

- 只检查数据库连通性就返回 ready：数据库可用不代表恢复队列已经接管，探针可能把请求送入尚未恢复的服务。
- 用 `Promise.all` 聚合恢复：一个域的查询失败会短路整体启动，并让其余已经开始的恢复失去统一生命周期。
- 用 `Promise.allSettled` 同时启动全部恢复域：虽然能收集错误，但各域会在同一个重启窗口同时入队或执行高负载任务，放大内存峰值和 crash-loop。
- 只把恢复方法调用改成逐条 `await`：如果方法内部只是 fire-and-forget 调度，真实 Pipeline/ffmpeg/Director 仍会并发；必须在执行入口设置准入边界。
- 把启动门禁放在 body parser 或限流器之后：未就绪请求仍会占用请求体内存，并让服务恢复后的合法请求提前遇到 429。
- 监听后初始化失败但不关闭 listener：测试/嵌入式调用会泄漏端口，托管环境会出现短暂可访问后进程退出。
- 把 degraded 当作永久失败：应保留可重试状态，使用幂等恢复扫描或人工恢复入口，而不是复活用户已取消的任务。

## 相关模块

- `server/src/services/task/RecoveryTaskService.ts`
- `server/src/routes/health.ts`
- `server/src/app.ts`
- `server/tests/recoveryBootstrapConcurrency.test.js`
- `server/tests/startupReadiness.test.js`
