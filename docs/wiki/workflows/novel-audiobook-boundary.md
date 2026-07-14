# 小说有声书边界（骨架）

## 状态

- Milestone：有声书骨架（契约 + 任务底座）
- 日期：2026-07-15
- 产品 SoT：Obsidian `ainovel 小说转有声书 产品形态.md`

## 范围内

- Web 任务并进 ai-novel：`TaskKind = novel_audiobook`
- 多角色绑定：`Character.ttsVoice` / `ttsStyle`
- 旁白默认：`Novel.audiobookNarratorVoice` / `audiobookNarratorStyle`，任务可覆盖
- 启动硬门禁：
  - 任意角色缺 `ttsVoice` → precheck `ok=false`，`createTask` 400
  - 旁白或角色音色不在 MiMo 预置表 → `blockingErrors`，同样 `ok=false` / 400
- TTS 通道：仅 CPA `mimo-v2.5-tts` chat-audio（`MimoChatAudioTTSProvider`）；**禁止**隐式写死生产 baseURL，未配置 provider baseURL 直接 400
- 产物路径：`storage/audiobooks/{novelId}/{taskId}/`（磁盘，非 PG base64；id 段拒绝 `..`/`/`）
- TaskCenter / Recovery 已注册 `novel_audiobook`；缺表 `P2021` 时 overview/list/recovery **降级为空**，不拖垮任务中心
- 取消：写 `cancelRequestedAt` + 剔除内存队列 + CAS `updateMany` 终态，避免与 execute 竞态覆盖
- 重试：尊重 `maxRetries`（默认 1）；启动路径 **auto-resume**（`resumePendingTasks`），`markPendingTasksForManualRecovery` 仅运维/测试

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
- 将 precheck 角色范围收窄为「仅所选章说话人」（仍按产品 SoT：全书角色卡齐音色）

## 执行语义（骨架）

创建任务后队列会跑 `executeTaskSkeleton`：写 `outputDir`、推进到 `skeleton_ready`，默认以 **failed + 明确文案** 结束，避免假成功。本地若设 `AUDIOBOOK_SKELETON_MARK_SUCCEEDED=1` 可标 succeeded 做联调。终态写入均带 status CAS，取消优先于 failed/succeeded。

## 关键代码

- `shared/types/audiobook.ts`
- `server/src/services/audiobook/*`
- `server/src/services/task/adapters/AudiobookTaskAdapter.ts`
- `server/src/modules/novel/production/http/novelAudiobookRoutes.ts`
