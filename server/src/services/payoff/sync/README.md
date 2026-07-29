# Payoff 同步写入边界

`PayoffLedgerSyncService` 保留 Prompt Registry 调用、输入装配和主账本对账编排；`sync/` 只承接独立的后续 canonical writer：

- `PayoffLedgerWindowExtension`：对遗漏的过期 `pending_payoff` 应用有限宽限窗口。
- `PayoffLedgerConflictProjection`：把账本风险同步到 `OpenConflict`。

章节资产后台触发全量 payoff reconcile 时必须传入 `projectionOwner`。主账本事务、窗口延期、open-conflict 和同步失败风险回写都要在首个副作用前取得同一章节 revision 的事务写锁。`ChapterProjectionSupersededError` 必须原样抛回章节 background runtime，不能进入“保留旧结果并标 stale”的通用 fallback。

人工查询或不由章节正文派生的调用可以不传 `projectionOwner`，保持原有账本同步语义；这项兼容不能被章节自动生产链用来绕过 revision 所有权。
