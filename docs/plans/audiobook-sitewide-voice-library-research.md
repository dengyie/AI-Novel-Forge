# 全站音色库 + AI 规划调研（SoT 摘要）

> **基线 tip**：生产 / `origin/main` **`1b7078b`**（2026-07-18）  
> **下一里程碑计划**：[`audiobook-voice-library-ops-and-ai-plan.md`](./audiobook-voice-library-ops-and-ai-plan.md)（D 库管理台 · E 人耳 approve · F setStatus 门禁 · G LLM redesign）

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

## Harden（已交付 · `1b7078b`）
- import / seed **禁止** `status|forceStatus=approved`（HTTP schema + service）
- `sourcePath` / `packRoot` allowlist（data / voice-refs / docs/voice-packs / tmpdir）
- registry 损坏 quarantine 备份后 500；`mutateRegistry` 文件锁
- list `limit` 非有限回落 + `offset` 分页
- 列表 skipProbe 仍 `tryResolve(requireApproved)`，幽灵 assetId → invalid
- pxed cutover §七点四十五

## 安全（不变量）
- ttsRefAudioPath 仅 null 或服务端写
- bind / plan apply clone 恒 requireApproved
- 种子人耳批准前保持 draft
- 开放 API 下能力限制在 service/HTTP，不假设 token 全局 auth

## 后续（见 ops-and-ai 计划，未开实现前勿当已交付）
- **D** 库管理台 + list/picker UX
- **E** 种子人耳 approve（库级 preview + 单条 setStatus）
- **F** setStatus 运维门禁（可选 `VOICE_LIBRARY_APPROVE_TOKEN`）
- **G** 真 LLM design rewrite
