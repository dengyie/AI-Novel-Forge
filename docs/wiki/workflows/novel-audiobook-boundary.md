# 小说有声书边界

## 状态

- Milestone：W — 合成效率 + m4b 交付 + 说话人别名（在 V 之上）
- 日期：2026-07-15
- 产品 SoT：Obsidian `ainovel 小说转有声书 产品形态.md`
- 前序：V 音色资产 preset/design/clone；流水线 + 语义停顿 + 媒体 access

## 范围内

- Web 任务并进 ai-novel：`TaskKind = novel_audiobook`
- 多角色绑定：`Character.ttsMode` + `ttsVoice` / `ttsDesignPrompt` / `ttsRefAudioPath` + `ttsStyle`
- **说话人别名**：`Character.ttsSpeakerAliases`（JSON TEXT / 数组或顿号分隔入参）
  - 标注 roster 展示别名；`resolveCharacter` 按正式名 + 别名 exact / normalize / 子串匹配
  - 提示词：外号/称呼优先映射角色表正式名
- 旁白默认：`Novel.audiobookNarratorVoice` / `audiobookNarratorStyle`，任务可覆盖
- 启动硬门禁：
  - 按 `ttsMode` 校验：preset 缺 voice / design 缺 designPrompt / clone 缺可读 ref → `missingVoices`
  - 旁白仅 preset；非法 mode / 非法预置 / 坏 ref 路径 → `blockingErrors`
  - precheck 回传 `speakerAliases`
- TTS 通道：CPA MiMo 三模态 `mimo-v2.5-tts` / `…-voicedesign` / `…-voiceclone`（`MimoChatAudioTTSProvider`）；**禁止**隐式写死生产 baseURL；**无**官方永久 voice 库
- LLM 按章说话人标注：`audiobook.chapter.annotate@v1` + `AudiobookAnnotationService`（失败回退整章旁白，质量警告可见）
- 合成流水线：`AudiobookPipelineService`
  - **group_by_speaker**：同说话人且 TTS 配置一致的连续段先合并（`coalesceSegmentsBySpeaker`），再 ≤550 字切块
  - 每 chunk 原子落盘 `chunk-####.wav`
  - 章合并 `chapter.wav` → 全书 `full-book.wav`（流式 PCM 拼接）
  - **段间语义停顿**（`AUDIOBOOK_GAP_MS` + `audiobookGap.ts`）：旁白↔角色 420ms、角色↔角色 320ms、同说话人续块 180ms；短句(≤15字) +120ms；章间 700ms。合并时插入静音，不改 TTS 产物。
  - **m4b 可选封装**（`audiobookM4b.ts`）：全书 WAV → `full-book.m4b`（AAC 96k + 章节 ffmetadata）；无 ffmpeg → `skipped`，WAV 仍成功；失败/跳过写入 qualityWarnings
  - resume：已有 annotation / 合法 chapter.wav / 连续合法 chunk 则跳过
- 产物路径：`storage/audiobooks/{novelId}/{taskId}/`（磁盘，非 PG base64；id 段拒绝 `..`/`/`）
- clone 参考音频：`storage/voice-refs/{novelId}/{characterId}/ref.wav`（角色更新可带 `ttsRefAudioBase64` 落盘）
- TaskCenter / Recovery 已注册 `novel_audiobook`；缺表 `P2021` 时 overview/list/recovery **降级为空**
- 取消：写 `cancelRequestedAt` + 剔除内存队列 + AbortController + CAS 终态
- 重试：`retryTask` 断点续跑；`reprocessChapter` 失败章/质量章定点重做（不占 maxRetries）；重拼时删除 full-book.wav **与** full-book.m4b
- 标注查看：`GET .../annotations` + 小说页「查看标注」
- 媒体播放：token 模式用短时 `?access=` HMAC（`media-access` 签发）；支持 HTTP Range 206；资源含 `full` / `full_m4b` / `chapter`

## HTTP

- `GET /api/novels/audiobook/voices`
- `POST /api/novels/:id/audiobook/precheck`
- `POST /api/novels/:id/audiobook/tasks`
- `GET /api/novels/:id/audiobook/tasks`
- `GET /api/novels/:id/audiobook/tasks/:taskId`
- `POST /api/novels/:id/audiobook/tasks/:taskId/cancel`
- `GET /api/novels/:id/audiobook/tasks/:taskId/annotations`
- `POST /api/novels/:id/audiobook/tasks/:taskId/chapters/:chapterId/reprocess` body `{ mode: "reannotate" | "resynthesize" }`
- `POST /api/novels/:id/audiobook/tasks/:taskId/media-access` body `{ resource: "full" | "full_m4b" | "chapter", chapterId? }`
- `GET /api/novels/:id/audiobook/tasks/:taskId/audio/full`（WAV stream + Range）
- `GET /api/novels/:id/audiobook/tasks/:taskId/audio/full.m4b`（attachment audio/mp4；无文件 404）
- `GET /api/novels/:id/audiobook/tasks/:taskId/audio/chapters/:chapterId`（WAV stream + Range）

## reprocess 语义

| mode | 清除 | 保留 | 行为 |
|---|---|---|---|
| `resynthesize` | 该章 chunk/chapter.wav + full-book.wav + full-book.m4b | 该章 annotation | 排队 resume，重合成该章并重拼全书（含可选 m4b） |
| `reannotate` | 上表 + 该章 annotation 文件/库条目 | 其它章 | 排队后重标该章 → 重合成 → 重拼全书 |

仅 `succeeded` / `failed` / `cancelled` 可调用。

## 明确不做（本版本）

- 生产部署（用户硬约束：先不要生产）
- 多供应商 UI / 浏览器密钥 / Drama 表存储
- 公开分享链接（私有短时 access ≠ 公网分享产品）
- fufu 多后端 fallback 链（P1 backlog）
- 发音词典 / emotion·pause 标签 / 独立 VoiceAsset 表 / 封面嵌入 m4b
- 强制人工确认标注后再合成（默认自动连跑；可查看/定点重做）
- 将 precheck 角色范围收窄为「仅所选章说话人」（仍按产品 SoT：全书角色卡齐音色）

## 执行语义

创建任务后队列跑 `executeTask`：

1. CAS `queued → running`
2. 按章 LLM 标注（可磁盘/库 resume；别名参与匹配）
3. group_by_speaker 合并 → 按块 MiMo TTS，每块原子落盘
4. 章 WAV → 全书 WAV → 可选 m4b
5. `succeeded` + 相对 `fullAudioPath` / `resultJson.m4b` / 质量警告

取消优先于 failed/succeeded（CAS）。

## 关键代码

- `shared/types/audiobook.ts` / `shared/types/novelCharacter.ts`
- `server/src/services/audiobook/*`（含 `audiobookM4b.ts`、`coalesceSegmentsBySpeaker`）
- `server/src/prompting/prompts/audiobook/*`
- `server/src/services/task/adapters/AudiobookTaskAdapter.ts`
- `server/src/modules/novel/production/http/novelAudiobookRoutes.ts`
- `client/src/api/novel/audiobook.ts` / `client/src/api/novel/characters.ts`
- `client/src/pages/novels/components/NovelAudiobookPanel.tsx`
- `client/src/pages/novels/components/CharacterAssetWorkspace.tsx`
