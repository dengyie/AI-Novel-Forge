# 有声书：全 AI 音色匹配 + AI 耳升权 + 现库重标补洞

## 目标
1. 规划器用书级设定（styleTone/卖点/简介…）+ VoiceBrief 配角色音色。
2. AI 耳自动 mark heard → approved（无人耳前置）。
3. 现库 AI 重标（可赋 lead）+ 矩阵空洞报告驱动补洞 import。

## 里程碑（实现）
- **M1** EarAgent v2：`approve` 硬升权；中区 `approve_with_low_confidence` **默认不升权**（`requireHardApprove=true`）；`heardBy=agent:ear@2`；heardSha 不删。
- **M2** LabelAgent（`label:ai-v3`）：可赋 lead，但**禁止** Edge 预设名启发式；speaker 广播仅 `lead-confidence:high`；`updateAssetTagsBatch` 单锁。MatrixReport → `data/storage/voice-matrix-reports`（或 `VOICE_MATRIX_REPORT_DIR`）。
- **M3** suggest 加载书级字段 + NovelBible 摘要；`buildVoiceBrief`；planner persona 加权；策略 `prefer_library_ai`（LLM Brief/pick **仅 lead/cast**，有限并发）；Ready 无 clone 时 apply design/preset。
- **M4** profile `library_ai_fill` = import → label → ear → approve → matrix。

## CLI
```bash
# AI 耳扫 draft 升权（需 token 或 AUDIOBOOK_OPS_ALLOW_OPEN_APPROVE=1）
node server/scripts/audiobookOps.cjs run ear_auto

# 重标 + 耳 + 矩阵
node server/scripts/audiobookOps.cjs run library_ai_fill --dry-run
```

## 不变量
- import 永不直批 approved。
- bind/合成只认 approved assetId。
- LLM pick 只返回预筛 catalog 内 id。
- 中文书默认 scope-zh。

## 环境开关
- `VOICE_LIBRARY_APPROVE_TOKEN` / `AUDIOBOOK_OPS_ALLOW_OPEN_APPROVE=1`
- `EAR_AUTO_SOFT_APPROVE=1` 允许中区 soft 自动升权（生产默认关）
- `VOICE_PLAN_BRIEF_LLM=1` 强制 Brief 走 LLM（`prefer_library_ai` 对 lead/cast 默认开）
- `VOICE_PLAN_AI_PICK=0` 关 LLM 选库
- `VOICE_PLAN_AI_PICK_RERANK=1` 对已有规则 clone 再 LLM 重排（仅 lead/cast）
- `VOICE_MATRIX_REPORT_DIR` 矩阵 gap 报告输出目录

## 回滚
- registry backup；策略回 prefer_library / auto。
