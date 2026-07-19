# MiMo TTS multi-backend fallback

**分支**：`feat/audiobook-tts-multi-backend-fallback`（基 `dcfc946`）  
**状态**：已完成（分支 tip，未 merge/deploy）  
**不做**：production 写死 fufu URL、默认改主链、与 design-prompt/listen-usability 叠合并、merge/deploy

## 目标

CPA 主链 MiMo TTS 遇 5xx/429/504 时可按 env 换 OpenAI-compatible 后端（如 fufu），密钥按位对齐；4xx/取消不换。

## 阶段

1. **端点链 + failover**（已完成 @ `8b31fcb`）：parse/resolve/isRetryable + `synthesize` 换端 + 单测
2. **可观测与门禁**：failover 日志（无密钥）；504/429/末节点耗尽测试；审查修阻断
3. **文档收口**：plan 关闭；.env 说明复核；交付总结停

## 验收

- 未设 fallback env = 单主链（与生产默认一致）
- 502 后换 fallback 成功；400 不换
- 错误信息含 `[endpoint.id]`，不含 API key
- 相关单测绿

## Manual-required

- production 配置 `AUDIOBOOK_MIMO_TTS_FALLBACK_BASE_URLS`（+ keys）后回归
- merge/deploy 另令


## 交付提交

- `8b31fcb` feat(phase-1): MiMo TTS multi-backend endpoint fallback
- phase-2：failover 日志 + 504/429/耗尽/primary-only 单测

验证：`node --test server/tests/mimoTtsEndpointFallback.test.js` 13 pass；shared/server build 绿。

## Review fix (retry matrix)

- 4xx/401 不 failover（刻意）；4xx 中途抛出不带 `mimoTtsEndpointChainExhausted`（仅多端 retryable 耗尽才打标）。
- **有效多端点**（`hasEffectiveMimoTtsMultiEndpointChain`：去重后 chain>1）时 outer 默认 maxAttempts=1；FALLBACK 与 primary 同 URL 不降 outer。
- 仅 primary 时仍默认 3 次瞬时 5xx/504 重试。
- merge 前 checklist：`chunkLayoutFingerprint` 必须经 `resolveChunkSynthesizeFields`；reconcile peel 卡面 base。
