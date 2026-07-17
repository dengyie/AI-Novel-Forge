# 全站音色库 + AI 规划调研（SoT 摘要）

## Milestone A（本轮）
- VoiceAsset JSON registry @ `storage/voice-refs/global`
- Character.ttsVoiceAssetId + 服务端 bind（禁客户端裸 path）
- 种子包 `docs/voice-packs/05-yuanworld-seed-from-mimo`（draft）
- API: list/get/import-file/import-seed-pack/status/bind

## Milestone B（未开）
- AI Planner Provider 自动推荐 VoiceAsset
- apply 可写 clone（当前仍拒绝 clone 写入）

## 安全
- ttsRefAudioPath 仅 null 或服务端写
- bind requireApproved 默认 true
- 种子人耳批准前保持 draft
