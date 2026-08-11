# 状态提案提交模块边界

## Background

待确认提案的自动放行与人工确认共享同一批 `StateChangeProposal`。预演结果只能说明提案在读取时可处理，不能作为最终写授权；同时，自动导演的 workflow ownership CAS 可能先于 canonical snapshot、版本记录或审计留痕提交。

## Decision

`ExistingProposalCommitService` 只负责“既有待确认提案”的提交编排：

- 在同一事务内校验当前 command lease 与 workflow task ownership；
- 用 `id + novelId + status=pending_review` 条件认领提案最终状态；
- 只为认领成功的提案应用 canonical 变更；
- 在 task CAS 事务提交后、任何 snapshot/version 后置工作前，把 committed ownership 交还 run-local fence；
- 只为实际提交成功的提案创建状态版本并回填 `committedVersionId`。

`StateCommitService` 保持稳定 facade，继续负责新提案抽取、验证、首次持久化，以及 canonical proposal application policy。自动放行策略和 ledger 仍归 `PendingReviewAutoPromotionService`，不得下沉到提交模块。

## Failure Rules

- command lease、workflow ownership 或 proposal status 任一 CAS miss 都不能继续相应写入。
- snapshot、version、version link 与 ledger 错误必须原样传播；task CAS 已提交时，fence 必须先获得新 ownership，避免后续失败收口使用旧版本。
- 人工确认或拒绝先赢时，自动放行不得覆盖状态、应用 canonical 变更、创建版本或把该提案写入自动放行 ledger。
