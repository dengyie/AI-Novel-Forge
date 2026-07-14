# 小说有声书边界

## 状态

- Milestone：失败章重标/重合成 + 标注查看（SoT slice-4）
- 日期：2026-07-15
- 产品 SoT：Obsidian `ainovel 小说转有声书 产品形态.md`
- 前序：流水线 + 最小 UI + production review 修复（媒体 access / 超时重试 / 原子 chunk / 流式合并）

## 范围内

- Web 任务并进 ai-novel：`TaskKind = novel_audiobook`
- 多角色绑定：`Character.ttsVoice` / `ttsStyle`
- 旁白默认：`Novel.audiobookNarratorVoice` / `audiobookNarratorStyle`，任务可覆盖
- 启动硬门禁：
  - 任意角色缺 `ttsVoice` → precheck `ok=false`，`createTask` 400
  - 旁白或角色音色不在 MiMo 预置表 → `blockingErrors`，同样 `ok=false` / 400
- TTS 通道：仅 CPA `mimo-v2.5-tts` chat-audio（`MimoChatAudioTTSProvider`）；**禁止**隐式写死生产 baseURL
- LLM 按章说话人标注：`audiobook.chapter.annotate@v1` + `AudiobookAnnotationService`（失败回退整章旁白，质量警告可见）
- 合成流水线：`AudiobookPipelineService`
  - 段切块 ≤550 字 → 每 chunk 原子落盘 `chunk-####.wav`
  - 章合并 `chapter.wav` → 全书 `full-book.wav`（流式 PCM 拼接）
  - **段间语义停顿**（`AUDIOBOOK_GAP_MS` + `audiobookGap.ts`）：旁白↔角色 420ms、角色↔角色 320ms、同说话人续块 180ms；短句(≤15字) +120ms；章间 700ms。合并时插入静音，不改 TTS 产物。
  - resume：已有 annotation / 合法 chapter.wav / 连续合法 chunk 则跳过
- 产物路径：`storage/audiobooks/{novelId}/{taskId}/`（磁盘，非 PG base64；id 段拒绝 `..`/`/`）
- TaskCenter / Recovery 已注册 `novel_audiobook`；缺表 `P2021` 时 overview/list/recovery **降级为空**
- 取消：写 `cancelRequestedAt` + 剔除内存队列 + AbortController + CAS 终态
- 重试：`retryTask` 断点续跑；`reprocessChapter` 失败章/质量章定点重做（不占 maxRetries）
- 标注查看：`GET .../annotations` + 小说页「查看标注」
- 媒体播放：token 模式用短时 `?access=` HMAC（`media-access` 签发）；支持 HTTP Range 206

## HTTP

- `GET /api/novels/audiobook/voices`
- `POST /api/novels/:id/audiobook/precheck`
- `POST /api/novels/:id/audiobook/tasks`
- `GET /api/novels/:id/audiobook/tasks`
- `GET /api/novels/:id/audiobook/tasks/:taskId`
- `POST /api/novels/:id/audiobook/tasks/:taskId/cancel`
- `GET /api/novels/:id/audiobook/tasks/:taskId/annotations`
- `POST /api/novels/:id/audiobook/tasks/:taskId/chapters/:chapterId/reprocess` body `{ mode: "reannotate" | "resynthesize" }`
- `POST /api/novels/:id/audiobook/tasks/:taskId/media-access` body `{ resource: "full" | "chapter", chapterId? }`
- `GET /api/novels/:id/audiobook/tasks/:taskId/audio/full`（WAV stream + Range）
- `GET /api/novels/:id/audiobook/tasks/:taskId/audio/chapters/:chapterId`（WAV stream + Range）

## reprocess 语义

| mode | 清除 | 保留 | 行为 |
|---|---|---|---|
| `resynthesize` | 该章 chunk/chapter.wav + full-book.wav | 该章 annotation | 排队 resume，重合成该章并重拼全书 |
| `reannotate` | 上表 + 该章 annotation 文件/库条目 | 其它章 | 排队后重标该章 → 重合成 → 重拼全书 |

仅 `succeeded` / `failed` / `cancelled` 可调用。

## 明确不做（本版本）

- m4b / 多供应商 UI / 浏览器密钥 / Drama 表存储
- 公开分享链接（私有短时 access ≠ 公网分享产品）
- fufu 多后端 fallback 链（P1 backlog）
- 强制人工确认标注后再合成（默认自动连跑；可查看/定点重做）
- 将 precheck 角色范围收窄为「仅所选章说话人」（仍按产品 SoT：全书角色卡齐音色）

## 执行语义

创建任务后队列跑 `executeTask`：

1. CAS `queued → running`
2. 按章 LLM 标注（可磁盘/库 resume）
3. 按段/块 MiMo TTS，每块原子落盘
4. 章 WAV → 全书 WAV
5. `succeeded` + 相对 `fullAudioPath` / `resultJson` / 质量警告

取消优先于 failed/succeeded（CAS）。

## 关键代码

- `shared/types/audiobook.ts`
- `server/src/services/audiobook/*`
- `server/src/prompting/prompts/audiobook/*`
- `server/src/services/task/adapters/AudiobookTaskAdapter.ts`
- `server/src/modules/novel/production/http/novelAudiobookRoutes.ts`
- `client/src/api/novel/audiobook.ts`
- `client/src/pages/novels/components/NovelAudiobookPanel.tsx`
