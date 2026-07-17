# 全站音色库 + AI 规划调研（SoT 摘要）

## Milestone A（已交付）
- VoiceAsset JSON registry @ `storage/voice-refs/global`
- Character.ttsVoiceAssetId + 服务端 bind（禁客户端裸 path）
- 种子包 `docs/voice-packs/05-yuanworld-seed-from-mimo`（draft）
- API: list/get/import-file/import-seed-pack/status/bind
- P1 harden：相对 path + assertBindable 恒 approved + runtime resolve

## Milestone B（已交付）
- 策略扩展：`prefer_library`；`auto` 在有 approved 库时对 lead/cast/narrator 优先 clone
- `planCharacterVoices` 纯函数接受 `libraryAssets`（调用方只注入 approved）
- suggest 注入 `voiceLibraryService.list({status:approved, kind:clone_ref})`
- apply 允许 `ttsMode:clone` + `ttsVoiceAssetId` → `bindCharacter`（assert approved）
- 禁止客户端 path；draft 永不建议/绑定
- readiness fillMissingVoice 透传 `ttsVoiceAssetId`
- 分支 harden：`fix/voice-library-b-review-harden@21201a9`

## Milestone C（已交付）
- 工作台 `CharacterVoiceEditor`：approved `clone_ref` 库选择器 + `POST .../voice-library/bind`
- 客户端 API：`listVoiceLibrary` / `getVoiceLibraryAsset` / `bindVoiceLibraryAsset`
- 表单/hydrate/save 透传 `ttsVoiceAssetId`；helpers ready/preview/dirty/save 认 assetId
- 本地 base64 上传覆盖库绑定；客户端不写 `ttsRefAudioPath`
- 分支：`feat/voice-library-milestone-c@b9940e7`（基于 B）

## 安全
- ttsRefAudioPath 仅 null 或服务端写
- bind / plan apply clone 恒 requireApproved
- 种子人耳批准前保持 draft

## 后续 backlog（未开）
- 真 LLM design rewrite
- 人耳 approve 种子 / 生产 cutover
- 库选择器检索/分页（当前 limit 200）
