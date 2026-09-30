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
- 主进程后台 worker 在启动、`full-book.m4b` rename 前和数据库 settle 前都校验 token；settle 还必须满足 `status=succeeded`，
  因此旧 worker 的成功、失败或取消结果都不能覆盖新代 `resultJson`。
- 代际轮换先于破坏性清理发生，并立即 abort 当前进程内的 ffmpeg；跨重启的孤儿进程依靠旧 token CAS 被拒绝，启动恢复还会清理孤儿进程并轮换 token。
- 同一任务目录的 m4b 编码使用模块级互斥。等待中的 worker 绑定自己的 `AbortSignal`，代际失效后会从等待队列移除，
  不会在旧锁释放后再次占用编码执行权。
- 主进程 token 轮换和删除旧全书产物也必须取得同一个 taskDir artifact lock；这把锁覆盖发布检查到 canonical rename 的窗口，
  防止“旧 worker 已通过检查、重做刚清理、旧 worker 随后 rename”这种跨代覆盖。
- `resultJson` 的 m4b settle 必须读改写并保留其它字段；所有权仅由 `status=succeeded + generation token` 确定，乐观并发使用完整 `resultJson` 快照。label 是可变展示文案，禁止作为 CAS 条件；同代 CAS 冲突且尚无终态时必须重试投影，已有合法终态时幂等结束。
- 迁移前的 `NULL` 或空字符串 token 必须作为精确 CAS 值处理，不能把它们混同为缺少栅栏；首次执行会在成功抢占时签发真实 UUID。
- 章节重做与续生成必须先把精确清理意图和新 generation 持久化，再删除任何章/全书产物。除 `ENOENT` 外的删除错误必须上抛并保留可恢复任务；启动恢复会重放幂等清理意图，不能把仍可读取的旧 WAV 当作本代成功。

### 独立编码进程的持久归属

独立 `m4b-worker` 与 API 不共享内存锁。队列的 `generationToken` 绑定任务代际，`leaseToken` 在每次领取时生成；旧请求入队、旧 worker 的进度/失败/成功回写都不能覆盖新租约。同代际重复入队保留当前 pending/processing 租约。

跨进程发布必须在短数据库事务内按 task → job 顺序加写锁：条件更新当前任务代际，再验证领取租约，最后同步 rename 并提交。章节重做先更新同一 task 行再清理，故不会插入到旧发布的校验与 rename 之间。禁止用模块级 mutex 或事务外 select 替代该边界。

领取时间不是停滞时间。`lastProgressAt` 只在实际 part 字节增长时刷新；达到展示进度上限后仍应刷新增长时间。`WorkerHeartbeat` 表示进程存活，不替代音频推进。

关闭标志也是异步启动的权限边界：查询 pending 前通过校验，不代表查询返回后仍可启动。队列查询返回、spawn 入口和 spawn 通知返回都必须重新检查关闭状态；进程一经创建就同步登记给 shutdown，启动等待同时监听 spawn/error/exit，避免关闭后的迟到通知重建 watchdog 或留下悬挂 Promise。

服务在 readiness 放行前恢复独立编码队列；关闭 worker 模式不得启动恢复扫描或领取旧 pending。SIGTERM 和代际失效均传播至 ffmpeg AbortSignal；SIGKILL/OOM 后，manager 仅根据受管 worker 的 IPC 报告验证唯一 part 命令行并终止进程组，确认退出后才能回队。无法确认清理完成时保留租约，交由后续扫描重试，不能为了继续推进而释放资源所有权。

缺少历史代际/租约的待处理 job 不可猜测归属；迁移将其标记失败，保留任务和已有音频，用户从有声书封装重试入口重新生成。实现职责见 `server/src/services/audiobook/m4b/README.md`。

### 失败模式

若发现磁盘上有旧 m4b、但任务投影没有对应状态，先检查任务的 `m4bGenerationToken`、后台 settle CAS 日志和同目录 `.part` 文件。
不要通过手工复制或直接改状态恢复；应使用 m4b 重做、章节重做或任务恢复入口，让新代际完成清理和投影收口。

取消优先于 failed/succeeded（CAS）。

## 音频 HTTP 响应的资源所有权

整书、章节、角色试听与音色库下载统一使用 `production/http/audiobook` 门面。该模块只负责文件响应与 Range 协议，不拥有生成任务或文件删除规则。

HTTP 响应拥有读取源的生命周期：客户端切换进度、关闭页面或取消下载时，必须销毁源流并关闭文件描述符。使用 Node `pipeline` 连接源与响应，异步 open/read 错误在回调收口，不能依赖路由外层同步 `try/catch`。正常连接提前关闭无需升级为服务故障；真实读取失败记录错误代码并终止当前响应。

禁止恢复为裸 `createReadStream().pipe(res)`。它不会在目标关闭时自动销毁源，长音频请求反复取消会积累暂停的文件流。回归测试必须使用真实 HTTP 断连，并验证源流 `closed` / `fd`，同时保留完整下载、Range 206 与 416 的协议覆盖。

## 可变音频地址与超长全书

章节重做和全书重生成会复用媒体 URL，因此完整响应和 Range 响应均使用 `private, no-store`。只有未来显式采用不可变内容版本 URL 时才可考虑 freshness 缓存；任务签名 token 不等同内容版本。

普通 PCM 使用 RIFF，数据长度加容器开销超过 uint32 后使用 RF64 + ds64。全书生成仍先合并 WAV 再封装 M4B；24kHz、16bit、mono 在约 24.85 小时就会到达原 RIFF 上限。必须同时保持拼接偏移、输出总字节数、恢复检查和 M4B 时长解析对 RF64 的一致支持。RF64 输入不能把 data 的 0xffffffff 哨兵当作真实长度，必须从 ds64 读取可安全表示的 uint64 长度。

## MiMo 请求取消与上游状态边界

Provider 持有端点选择、退避和熔断策略；`infrastructure/mimo` 持有单次 HTTP 请求、超时、取消监听器和响应解码。基础设施层不反向调用 provider。

取消必须覆盖请求开始前、异步配置解析后、退避等待以及响应正文读取。已取消的 signal 不会再次派发 abort 事件，因此监听器不能代替发送前检查。取消结果统一为 408，不触发端点切换；每次请求的计时器和监听器必须在 finally 释放。

HTTP 429/503 是上游繁忙状态，必须保留到 provider 的熔断计数。将 503 统一改成 502 会让纯策略单测通过但实际 HTTP 请求绕过熔断。回归应经 public synthesize 调用真实状态转换，并确认熔断后不再调用 fetch。

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

## 容器运行依赖

生产 API 镜像必须在 runtime 阶段安装 ffmpeg（含 ffprobe）与 procps，不能只在构建阶段或宿主机安装。M4B worker 在容器内执行编码，进程所有权回收通过 ps 校验；缺失其中任一依赖会导致整书仅有 WAV 或无法安全识别残留编码进程。Docker 构建直接执行版本与进程查询检查；上线验收还需完成一次真实编码与下载。运行期临时安装不构成可复现修复。

## 独立 M4B 队列与任务投影收口

`M4bEncodingJob` 是封装执行状态源；`AudiobookTask.resultJson.m4b` 是任务列表与前端交付投影。成功发布、失败与恢复重试耗尽必须在同一 task→job 锁顺序的数据库事务中更新两者。仅把 job 标记 completed 会造成磁盘文件存在但界面永久不可下载。

`application/finalization` 拥有章节生产的成功收口。它先锁当前代际任务，再清理该代际 chunk，读取当前 job，最后写入生成结果。worker 可能早于主任务最终保存，因此最终保存不能盲写 pipeline 的暂态 skipped；须合并同代 job 的 ready/failed/encoding。新代际不允许旧 finalize 删除 chunk，也不允许旧 worker 写新投影。worker 在 task 仍 running 时只更新封装结果，不提前宣称全书完成或显示零章摘要。

共享 `m4bStatus=encoding` 是可见的轮询契约：章节生产 succeeded 后仍每 4 秒刷新，ready/failed/skipped 后停止。缺少状态的旧任务不能被解释为编码中，否则会永久轮询。WAV 完成和 M4B 完成是两个独立条件。

部署检查分为 `validate-m4b-worker-migration.sh --preflight` 与 `--post-migration`，都只读真实数据库。前者阻止未收口的 pending/processing 任务直接迁移；后者实际查询 generationToken/leaseToken/lastProgressAt 并拒绝遗留无归属活动任务。检查不代替数据库/音频备份，也不能证明旧操作系统进程已经退出。


## 编码进程测试的时间边界

真实子进程启动和文件 I/O 的等待必须使用单调实时时钟与有界预算，并以 ready/输出 ack 确认实际状态。在夹具准备前耗掉短停滞窗口，会把并行构建或冷启动调度延迟误判为编码缺陷。

停滞策略测试只在真实夹具准备后推进父进程的虚拟时钟，覆盖持续增长、首次无输出、增长后停滞、进度采样与 watchdog 竞争。不得为了稳定测试放宽生产超时或降低生产并发。取消、进程组死亡、继承管道 close 和许可交接仍验证真实进程行为；失败清理必须 abort 已启动编码并释放夹具等待条件。


## Web 持久数据目录与路径迁移

Web 显式设置 `AI_NOVEL_APP_DATA_DIR` 时，`runtime/appPaths.resolveDataRoot()` 必须返回该目录。有声书、参考音频、全站音色库和音频运营产物均从该根的 `storage/` 下派生，不能写入会随容器替换而丢失的应用目录。未配置的 Web 保持 `server/` 数据根；桌面版保持 `<app-data>/data`，图片和日志继续使用既有桌面布局。

相对 SQLite URL（如 `file:./dev.db`）由 Prisma 连接与 runtime migration 共同通过 `resolveDatabaseFilePath()` 解析，必须落在同一个数据根。绝对 SQLite 路径和 PostgreSQL URL 不受影响。部署变更数据根时，不能把在新路径创建空库误判为数据迁移完成；已有相对路径库必须备份并迁移，或显式保留原绝对数据库路径。

路径解析不自动迁移历史数据。切换目录前应备份并核验媒体文件和数据库，再同步迁移文件与数据库内保存的绝对路径（包括任务 `outputDir` 与参考音频路径）。下载、恢复和参考音频校验仍必须限制在配置的数据根内；不能为兼容旧路径放宽边界。回归测试需要实际创建任务目录、写入音频及参考文件，单测只验证日志或图片路径不足以证明所有产物持久化。
