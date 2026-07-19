# 全站音色库 + AI 规划调研（SoT 摘要）

> **生产 tip**：production / 代码 **`0b776e6`**（2026-07-18 · A–G + heardSha + approve token live）  
> **运营计划（已交付代码）**：[`audiobook-voice-library-ops-and-ai-plan.md`](./audiobook-voice-library-ops-and-ai-plan.md)（D–G · cutover vault §七点四十九）

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
- production cutover §七点四十五

## 安全（不变量）
- ttsRefAudioPath 仅 null 或服务端写
- bind / plan apply clone 恒 requireApproved
- 种子人耳批准前保持 draft
- 开放 API 下能力限制在 service/HTTP，不假设 token 全局 auth

## Milestone D（已交付 · 见 ops-and-ai §2.6）
- SPA `/audiobook/voice-library`：list/filter/pagination/详情 + seed/import draft
- client `listVoiceLibrary` 传 `offset`；`importVoiceLibraryFile` / `importVoiceLibrarySeedPack`
- 工作台入口；角色卡 picker `q` + 加载更多
- **无** auto-approve / 客户端写 path

## Milestone E/F/G（已交付 · 见 ops-and-ai §3.7/4.7/5.7）
- **E**：库级 media-access + audio 直播 ref.wav；管理台试听 / session 已听 / 单条+勾选 approve（仅已听）
- **heardSha `0b776e6`**：`review.heardAt` + `heardSha256` 对齐 `primaryFile.sha256`；overwrite 清 review；同 sha mark skip 写；UI 批准前预检
- **F**：`VOICE_LIBRARY_APPROVE_TOKEN`；仅升 approved 要 header；audit 无 token 明文；**生产已设 token live**
- **G**：`POST .../voice-design/rewrite` 候选不落库；角色卡 design 预览→应用表单；mock + rule_fallback；E2E `source=llm`
- Manual 仅剩：浏览器真人播放 + sessionStorage 填 token；真 LLM redesign 听感（不编造）
