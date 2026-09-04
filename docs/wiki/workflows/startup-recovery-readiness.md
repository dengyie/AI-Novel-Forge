# 启动恢复与服务就绪边界

## 背景

服务启动时需要扫描并恢复多个可持久化任务域：拆书、图片、自动导演、章节流水线、写法提取和有声书。恢复动作可能遇到短暂数据库抖动，也可能只影响其中一个任务域。HTTP 进程存活、数据库可访问和后台任务恢复完成是三个不同状态，不能用其中一个状态替代另外两个。

## 决策

- `/api/health` 只表示进程存活。
- `/api/health/ready` 只有在启动恢复全部域完成且没有 degraded 域、数据库探针成功时才返回 200。
- 恢复初始化使用共享的 `Promise.allSettled` 扇出。单个域失败会记录域名并进入 degraded，不取消其它域，也不直接终止 server。
- degraded 启动保留服务进程和已完成域的能力，同时以 503 阻止 readiness；后台按退避间隔重试幂等恢复扫描，全部成功后才恢复 ready。
- 若启动阶段发生无法归属为单域恢复失败的异常，必须停止已启动的后台资源并关闭 HTTP listener，再把异常交给 bootstrap 的进程级失败处理。
- 有声书恢复扫描必须按稳定唯一键分页；活动任务查询不应加载历史 `resultJson`，只有 succeeded 任务需要读取 m4b 持久标记。这样历史任务数量或 JSON 体积增长不会把启动恢复变成一次性内存峰值。

## 当前规则

`RecoveryTaskService.initializePendingRecoveries()` 返回共享初始化结果，其中 `failedDomains` 是持久任务恢复没有完成的域。`waitUntilReady()` 等待本轮扇出结束，不把 degraded 误报为 rejection；需要重试时通过 `retryPendingRecoveries()` 重新执行幂等扫描。

`startServer()` 在监听期间把 readiness 置为 `starting`，恢复成功后置为 `ready`，存在失败域时置为 `degraded`。启动异常的清理由后台服务初始化和 HTTP 启动层共同负责，避免半启动端口或扫描器继续运行。

`retryPendingRecoveries()` 只重试上一轮失败的域；已经成功的域不因其它域暂时失败而重复扫描或重复入队。每个域仍需保持自身幂等，以应对进程重启和显式重试。

## 失败模式

- 只检查数据库连通性就返回 ready：数据库可用不代表恢复队列已经接管，探针可能把请求送入尚未恢复的服务。
- 用 `Promise.all` 聚合恢复：一个域的查询失败会短路整体启动，并让其余已经开始的恢复失去统一生命周期。
- 监听后初始化失败但不关闭 listener：测试/嵌入式调用会泄漏端口，托管环境会出现短暂可访问后进程退出。
- 把 degraded 当作永久失败：应保留可重试状态，使用幂等恢复扫描或人工恢复入口，而不是复活用户已取消的任务。

## 相关模块

- `server/src/services/task/RecoveryTaskService.ts`
- `server/src/routes/health.ts`
- `server/src/app.ts`
- `server/tests/recoveryBootstrapConcurrency.test.js`
- `server/tests/startupReadiness.test.js`
