# 有声书 AI Ops Agents 实现（H 计划 — 阶段 1+2+3）

> 范围：有声书 VoiceAsset 库与成书链路的一键 AI Agent 编排（Ear=审听、Ready=角色就绪、Patrol=成书巡检），人工覆盖可选。
>
> 本文不是一个新的里程碑展开，而是已实现功能的交付说明。设计与不变量来自 `audiobook-voice-library-ops-and-ai-plan.md` §4（跨里程碑安全不变量）与本仓库已 live 的 `voiceLibraryService`、`audiobookVoiceAssetService`、`audiobookVoiceReadinessService` 行为。

## 1. 实现范围（阶段 1+2+3）

| 阶段 | 模块 | 落盘文件 |
|---|---|---|
| 1 | OpsRun 编排核心 + 一键入口 | `server/src/services/audiobook/ops/OpsRunService.ts`, `OpsRunStorage.ts`, `OpsReport.ts`；`server/src/modules/novel/production/http/novelAudiobookRoutes.ts` 内 6 路由；CLI `server/scripts/audiobookOps.cjs`；共享类型 `shared/types/audiobookOps.ts` |
| 2 | Ear / Ready / Patrol Agent + §D 进程内门禁 | `server/src/services/audiobook/ops/agents/EarAgent.ts`, `ReadyAgent.ts`, `PatrolAgent.ts`；纯启发式 `server/src/services/audiobook/ops/heuristics/earSignalHeuristics.ts` |
| 3 | 门禁测试 + 文档收口 | `server/tests/opsApproveGate.test.js`, `server/tests/patrolAgentSmoke.test.js` |

测试矩阵（32 项全绿）：`tests/audiobookOpsRun.test.js` 12 + `tests/earAgentHeuristics.test.js` 11 + `tests/opsApproveGate.test.js` 6 + `tests/patrolAgentSmoke.test.js` 3。

## 2. 不变量门禁（§4）

| 不变量 | 落点 |
|---|---|
| Import 永远为 draft | `voiceLibraryService.normalizeImportStatus` 已有；Agent 不接入 import |
| approved 必须 heardAt + heardSha256≡primaryFile.sha256 | `voiceLibraryService.setStatus("approved")` 内建校验沿用 |
| Agent 升权前显式跑进程内门禁 | `server/src/services/audiobook/ops/OpsReport.ts` `assertOpsApproveAllowed()`；EarAgent 在 setStatus 前调用 |
| 动态 token 或显式 dev 开关 | env `VOICE_LIBRARY_APPROVE_TOKEN` 或 `AUDIOBOOK_OPS_ALLOW_OPEN_APPROVE=1`；二者皆缺 → 403 |
| 人工 force 优先于 Agent | `OpsRunService.registerOverride("forceKeepDraft"|"forceReject"|"forceBind")`，EarAgent 查询后改 verdict 而非覆盖 |
| 不伪造浏览器试听 | EarAgent 仅做启发式评分；试听验证仍归 `markLibraryPreviewHeard`（已 live） |
| dry-run 改库为零 | `OpsRunInput.dryRun=true` 时 Agent 跑 suggest/startup 评估，不 apply；OpsRunService 终态产出 dryRunPlan + 报告 |

## 3. HTTP 路由

```
POST   /audiobook/ops/runs                  # 入队一键 Run {profile, novelId, assetIds?, autoFix?, dryRun?}
GET    /audiobook/ops/runs                   # 列最近 50 run
GET    /audiobook/ops/runs/:runId            # 单 run 状态
POST   /audiobook/ops/runs/:runId/cancel     # 取消
GET    /audiobook/ops/runs/:runId/report     # 单 run 报告
POST   /audiobook/ops/overrides              # 人工 force 标记 {action, assetId?, characterId?}
```

幂等：`computeInputFingerprint(profile+novelId+packRoots+assetIds+autoFix+dryRun)`；60s 内同指纹返回 `duplicateOfRunId`。

## 4. CLI 入口

```bash
pnpm --filter @ai-novel/server audiobook:ops -- --profile library_only --dry-run
pnpm --filter @ai-novel/server audiobook:ops -- --profile full --novel-id <id>
pnpm --filter @ai-novel/server audiobook:ops -- --profile patrol_only --auto-fix
```

CLI 仅读写 `storage/audiobook-ops/{runId}/`；不连 HTTP 通道。

## 5. Run 状态机

```
queued → running → {succeeded | failed | cancelled}
                 ↘ cancel requested → cancelled
```

每个 Run 落盘：`run.json`（生命周期）/ `report.json`（Ear/Ready/Patrol 结果）/ `log.txt`（步骤日志）/ `steps/{stepName}.json`（每步骤 payload）。原子化写入（`.part` → `rename`）。

`reapStaleRuns(staleMs=30min)` 在 OpsRunService 构造时清理挂死进程的 `running` Run。

## 6. EarAgent 启发式（heuristic 模式，v1）

WAV → `parseWavInfo` → `extractPcmFromWav` → `readInt16LESamples` → 三大评分：

| 评分 | 计算公式 | 阈值 |
|---|---|---|
| `clarity` | `clamp01((rms - 0.005) / 0.05)` | ≥ 0.55 |
| `speechLikely` | `1 - silenceRatio`（|x| < 0.01 视静音） | ≥ 0.4 |
| `cleanliness` | `1 - min(1, clipRatio × 5)`（|x| > 0.985 视削波） | ≥ 0.5 |
| `durationOk` | `byteRate 推导` ∈ [3s, 1200s] | 必须 true |
| `clipOk` | `clipRatio < 0.02` | 必须 true |

决策：`reject`（时长/RMS/RIFF 失败）/ `approve`（全部过线）/ `needs_human`（介于）。批准后 `assertOpsApproveAllowed` 通过 → `setStatus("approved")`（继承既有 sha/license/heardAt/heardSha 门禁）。

## 7. Ready / Patrol Agent（最小可演示）

- **Ready**：`assess(novelId)` → `suggest(strategy=prefer_library)` → 仅对 `ttsMode==="clone" && ttsVoiceAssetId` 的项 `apply(overwrite=false)`；draft 资产由 `assertBindableCloneRef` 内门禁阻断。
- **Patrol**：P1 任务卡死（status=running 且 heartbeatAt > 30min）/ P2 speakerUnresolved ≥ 20% / P3 chapterProgress=ready 但 chapter.wav 缺失 / P7 approved VoiceAsset primaryFile 不可达。默认 `autoFix=false`；阶段 1 不实施写操作（info finding 占位）。

## 8. 回滚

- 单 commit 即可 `git revert`。
- 6 路由是新增 prefix `/audiobook/ops/*`，不影响既有路由。
- `voiceLibraryService` / `audiobookVoiceAssetService` / `audiobookVoiceReadinessService` 未改动。
- env：`AUDIOBOOK_OPS_ALLOW_OPEN_APPROVE` 默认未设；生产未配 `VOICE_LIBRARY_APPROVE_TOKEN` 时 Agent 永远 403，行为 == 之前无 Agent。
- `storage/audiobook-ops/` 删除即可清空 Run 历史；VoiceAsset 库与 Novel 数据不受影响。

## 9. 不做（backlog）

- 真 LLM 调用替代 heuristic 模式（EarAgent 留 `model` 字段占位）
- PatrolAgent 写操作的 autoFix 子集（chapter.wav 重新合成、speaker 重新 resolve 等）
- HTTP `/audiobook/ops/*` 前端面板（仅在 routes 后端 ready；UI 在后续里程碑）
- 通用 Ops Agent token 轮转 / RBAC（沿用既有 `VOICE_LIBRARY_APPROVE_TOKEN`）
- 任务级 `log.txt` 流式 SSE 推送（当前为 best-effort 落盘 + 客户端轮询）

## 10. 测试与验证入口

```bash
cd AI-Novel-Writing-Assistant
pnpm --filter @ai-novel/server build
cd server
node --test tests/audiobookOpsRun.test.js tests/earAgentHeuristics.test.js tests/opsApproveGate.test.js tests/patrolAgentSmoke.test.js
```

生产端到端验证（Manual-required）：在 dev 环境导入真实 seed pack 后跑 `audiobook:ops --profile library_only --dry-run` 看一遍，再跑 `--profile full --novel-id <真实 novel>` 验证 Bind/Patrol。
