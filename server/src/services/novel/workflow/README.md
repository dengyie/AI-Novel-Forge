# Novel Workflow Service Boundary

`NovelWorkflowService` 是对外门面。内部职责按三块拆分：

- `store / projection`：任务可见性、读模型、持久化更新、通知投影所需的底层读写。
- `healing`：恢复、纠偏、历史失败态修复、自动导演状态对齐。
- `application`：bootstrap、状态迁移、checkpoint、重试和恢复命令。
- `recovery/StartupWorkflowRecoveryService`：服务启动扫描后的重排队、失败收口和 checkpoint 恢复；必须用扫描快照的 `status`、`cancelRequestedAt`、`updatedAt`、`attemptCount` 与手工恢复标记作 CAS，且只能使用 raw lookup。CAS miss 表示更晚的取消、重试、完成或运行时投影已生效，不能改写任务或 command。
- `recovery/WorkflowRetryService`：统一 retry 认领和 retry dispatch 失败收口；`attemptCount` 只能在 retry 认领 CAS 成功时递增一次。

外部模块只应依赖门面，不应深链到具体实现文件。
