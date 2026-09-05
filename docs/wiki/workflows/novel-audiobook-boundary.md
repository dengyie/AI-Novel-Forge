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
  - m4b 后台状态必须先持久化为 `resultJson.m4b.status=encoding`，再启动 ffmpeg；启动恢复扫描 `succeeded + encoding` 任务并重新排队，不依赖进程内 Promise。
  - m4b 编码受进程级有界队列保护，默认 `AUDIOBOOK_M4B_CONCURRENCY=1`、硬上限 4；单个 ffmpeg 默认 2 线程、硬上限 4；同一 taskDir 仍保持额外互斥。
  - resume：已有 annotation / 合法 chapter.wav / 连续合法 chunk 则跳过
- 产物路径：`storage/audiobooks/{novelId}/{taskId}/`（磁盘，非 PG base64；id 段拒绝 `..`/`/`）
- clone 参考音频：`storage/voice-refs/{novelId}/{characterId}/ref.wav`（角色更新可带 `ttsRefAudioBase64` 落盘）
- TaskCenter / Recovery 已注册 `novel_audiobook`；缺表 `P2021` 时 overview/list/recovery **降级为空**
- 取消：写 `cancelRequestedAt` + 剔除内存队列 + AbortController + CAS 终态
- 启动恢复先等待恢复扫描完成；重启清理只读取 `ps` 并验证孤儿为 PPID=1、可执行文件为 ffmpeg 且命令行指向目标 taskDir 的 `.m4b*.part`，清理过程必须可等待且失败有日志。
- 重试：`retryTask` 断点续跑；`reprocessChapter` 失败章/质量章定点重做（不占 maxRetries）；重拼时删除 full-book.wav **与** full-book.m4b
- 标注查看：`GET .../annotations` + 小说页「查看标注」
- 媒体播放：token 模式用短时 `?access=` HMAC（`media-access` 签发）；支持 HTTP Range 206；资源含 `full` / `full_m4b` / `chapter`

## m4b 停滞看门狗契约

### 背景

m4b 是单次长时 ffmpeg 任务，进度日志会周期性采样 `.part` 文件大小。日志采样和停滞判定属于不同职责：前者用于展示观测值，后者用于决定是否回收进程。

### 当前规则

- 看门狗独立维护 `lastObservedBytes` 与 `lastGrowthAt`，只依据自己观察到的 `.part` 增长重置停滞窗口。
- 进度日志使用独立的采样字节基线；采样回调、日志失败或采样时序不得改变看门狗的停滞判定。
- 首字节在停滞窗口内未产生时回收 ffmpeg；产物持续增长时按最近观察到的增长续命；停止增长满窗口后才判定失败。
- 停滞窗口是相对最近一次看门狗观察到增长的时间，不使用整次编码的绝对墙钟超时。
- 同一 `taskDir` 的编码请求通过进程内锁串行化；排队等待者收到 `AbortSignal` 后必须从 waiter 队列移除并立即拒绝，不得等上一轮编码结束才返回。
- 宿主重启重排队前，孤儿 ffmpeg 清理必须等待已发送 `SIGKILL` 的 PID 消失后再放行新 worker；等待最多 2 秒，仍存活时记录 taskDir 与 PID 告警，并跳过该任务本轮重排队，等待下一轮域级恢复重试，避免新旧进程交错写产物。
- 单轮启动恢复只允许获取一次进程表快照；每个候选 PID 在 `SIGKILL` 前仍必须按 PID、PPID、可执行文件和完整 taskDir 目录段重新验证，不能用任务目录前缀匹配，也不能因快照复用而跳过 PID 复用检查。
- POSIX ffmpeg 必须运行在独立进程组中；取消、停滞与孤儿清理均优先终止整个组，避免只杀 wrapper 后留下继续持有管道或写盘的后代。
- 进程内 m4b worker 在取消或停滞后，必须等待 ffmpeg `close`/`error` 事件再释放全局编码许可；若子进程生命周期异常，最多等待 2 秒后以失败收口，避免正常情况下新旧 ffmpeg 重叠占用资源。
- 后台 m4b marker 只有在全书 WAV 有效、`chapterIds` 非空且每章 WAV 存在时才继续编码；任一前置条件缺失都要写入失败终态，不能永久停在「m4b 后台封装中」。

### 失败模式

如果进度采样直接写入看门狗的字节基线，采样发生在旧 watchdog deadline 之前时，deadline 会把“采样已观察到、但尚未被 watchdog 观察到”的增长误判为停滞并杀掉仍健康的 ffmpeg。任何新增观测渠道都必须保持上述状态隔离。

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

## m4b 后台代际与并发边界

### 背景

m4b 封装在任务主流水线完成后异步运行，可能跨越章节重做、续生成、重试或服务重启。
如果旧 worker 只依据 `taskId` 和状态写回，旧的 `full-book.m4b` 可能在新一轮音频产物之后覆盖规范文件，
并把前端投影误报为 ready。

### 当前规则

- `AudiobookTask.m4bGenerationToken` 是持久化的代际栅栏。新建、重试、恢复、续生成、章节重做和 m4b 重做都会签发新 token。
- 后台 worker 在启动、`full-book.m4b` rename 前和数据库 settle 前都校验 token；settle 还必须满足 `status=succeeded`，
  因此旧 worker 的成功、失败或取消结果都不能覆盖新代 `resultJson`。
- 代际轮换先于破坏性清理发生，并立即 abort 当前进程内的 ffmpeg；跨重启的孤儿进程依靠旧 token CAS 被拒绝，启动恢复还会清理孤儿进程并轮换 token。
- 同一任务目录的 m4b 编码使用模块级互斥。等待中的 worker 绑定自己的 `AbortSignal`，代际失效后会从等待队列移除，
  不会在旧锁释放后再次占用编码执行权。
- token 轮换和删除旧全书产物也必须取得同一个 taskDir artifact lock；这把锁覆盖发布检查到 canonical rename 的窗口，
  防止“旧 worker 已通过检查、重做刚清理、旧 worker 随后 rename”这种跨代覆盖。
- `resultJson` 的 m4b settle 必须读改写并保留其它字段；所有权仅由 `status=succeeded + generation token` 确定，乐观并发使用完整 `resultJson` 快照。label 是可变展示文案，禁止作为 CAS 条件；同代 CAS 冲突且尚无终态时必须重试投影，已有合法终态时幂等结束。
- 迁移前的 `NULL` 或空字符串 token 必须作为精确 CAS 值处理，不能把它们混同为缺少栅栏；首次执行会在成功抢占时签发真实 UUID。
- 章节重做与续生成必须先把精确清理意图和新 generation 持久化，再删除任何章/全书产物。除 `ENOENT` 外的删除错误必须上抛并保留可恢复任务；启动恢复会重放幂等清理意图，不能把仍可读取的旧 WAV 当作本代成功。

### 失败模式

若发现磁盘上有旧 m4b、但任务投影没有对应状态，先检查任务的 `m4bGenerationToken`、后台 settle CAS 日志和同目录 `.part` 文件。
不要通过手工复制或直接改状态恢复；应使用 m4b 重做、章节重做或任务恢复入口，让新代际完成清理和投影收口。

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

> 2026-07-17：选书页态势见 `POST /novels/audiobook/workspace-overview`（列表不 probe clone；项目页仍 assess）。详情：`docs/plans/audiobook-workbench-ux-optimization-plan.md`。
