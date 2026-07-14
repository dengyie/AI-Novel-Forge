# 小说有声书边界（骨架）

## 状态

- Milestone：有声书骨架（契约 + 任务底座）
- 日期：2026-07-15
- 产品 SoT：Obsidian `ainovel 小说转有声书 产品形态.md`

## 范围内

- Web 任务并进 ai-novel：`TaskKind = novel_audiobook`
- 多角色绑定：`Character.ttsVoice` / `ttsStyle`
- 旁白默认：`Novel.audiobookNarratorVoice` / `audiobookNarratorStyle`，任务可覆盖
- 启动硬门禁：任意角色缺 `ttsVoice` → precheck `ok=false`，`createTask` 400
- TTS 通道：仅 CPA `mimo-v2.5-tts` chat-audio（`MimoChatAudioTTSProvider`）
- 产物路径：`storage/audiobooks/{novelId}/{taskId}/`（磁盘，非 PG base64）
- TaskCenter / Recovery 已注册 `novel_audiobook`

## HTTP

- `GET /api/novels/audiobook/voices`
- `POST /api/novels/:id/audiobook/precheck`
- `POST /api/novels/:id/audiobook/tasks`
- `GET /api/novels/:id/audiobook/tasks`
- `GET /api/novels/:id/audiobook/tasks/:taskId`
- `POST /api/novels/:id/audiobook/tasks/:taskId/cancel`

## 明确不做（本骨架）

- 完整 LLM 按章说话人标注流水线
- 完整 chunk TTS + 章/全书 WAV 合并与下载 UI
- m4b / 多供应商 / 浏览器密钥 / Drama 表存储
- 公开分享链接

## 执行语义（骨架）

创建任务后队列会跑 `executeTaskSkeleton`：写 `outputDir`、推进到 `skeleton_ready`，默认以 **failed + 明确文案** 结束，避免假成功。本地若设 `AUDIOBOOK_SKELETON_MARK_SUCCEEDED=1` 可标 succeeded 做联调。

## 关键代码

- `shared/types/audiobook.ts`
- `server/src/services/audiobook/*`
- `server/src/services/task/adapters/AudiobookTaskAdapter.ts`
- `server/src/modules/novel/production/http/novelAudiobookRoutes.ts`
