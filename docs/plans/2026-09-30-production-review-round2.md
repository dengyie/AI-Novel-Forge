# Review Summary

- 审查基线：本地 beta `0f891f60`，继续覆盖当前实现与前一轮修复涉及的调用链；审查与修复位于 `codex/production-review-round2`。main 不变。
- 结论：本轮确认的下列缺陷均已根因修复，可进入本地 beta 验收；不据此直接部署生产或宣称全库不存在任何缺陷。
- 原始整体风险：高，主要集中于异步结果所有权、数据库/队列提交边界和网络/进程生命周期。
- 最重要三项：旧质量评估覆盖新版正文并误停全书；资料与索引任务非原子提交导致永久漏索引；图片上传/文件错误可能耗尽内存或退出 API 进程。
- 结构与架构：保留既有业务 facade 与唯一写入服务；删除绕过 revision 的补写路径。HTTP 图片、MiMo 网络调用、桌面进程生命周期归入明确的职责目录。漫画/短剧路由门面为 575/658 行，MiMo provider 为 677 行。
- 扩展性：沿用现有队列、Prisma 事务、Express 文件响应和音频协议；没有增加关键词业务兜底或通用重试框架。
- 测试：服务端 76 文件/561 项组合回归，再加真实 SQLite 原子提交 4 项；前端 17 项，桌面 8 项均通过。合计 590 项（含 node:test 父测试计数）。server/desktop 编译、client typecheck 通过；独立临时 SQLite 89 项迁移通过。
- 验证代码基线：`3a99ac73`，后续 `f2d7e600` 仅追加真实 SQLite 测试；报告与发布说明收口不改变运行行为。实际未运行浏览器、真实 Windows utilityProcess、发行打包、PostgreSQL 并发和真实超长 ffmpeg/Qdrant 验收。
- 覆盖范围：自动导演/章节审校修复与质量门控、任务投影与前端 SSE、知识资料与 RAG、图片上传下载/限流、有声书 TTS/WAV/M4B、桌面启动退出、公共 LLM timeout 与 HTTP error 边界。未把个人风格或不可达推测算作缺陷。
- 已知策略：匿名开放模式是现有明确决策，本轮不将“没有登录系统”作为缺陷，也没有改动生产权限策略。

# Findings

以下位置对应修复后的文件与函数；严重级别描述修复前风险。各项均有失败证据和修复后验证。

## [P1] F1 旧章节质量评估覆盖新版状态并误停全书

- 文件与位置：`server/src/services/novel/pipeline/quality/PipelineChapterQualityPolicy.ts / projectPipelineChapterQuality`。
- 所属维度：正确性、状态一致性。
- 问题：旧 riskFlags/chapterStatus 覆盖新正文，旧重规划建议进入全书停止判断。
- 触发条件：审校返回后用户提交新正文，质量评估 CAS 被拒绝。
- 实际影响：旧 riskFlags/chapterStatus 覆盖新正文，旧重规划建议进入全书停止判断。
- 根本原因：catch 绕过唯一 revision writer，使用无条件补写。
- 最小修改方案：删除补写，重试既有 revision writer；冲突时刷新当前债务并淘汰过期建议。 已实施。
- 需要补充的测试：pipelineQualityRevisionOwnership.test.js：真实 SQLite 报告后更新、报告冲突、瞬态重试。 已补充并通过。
- 是否阻塞合并：修复前是；当前已解决。

## [P1] F2 未采纳修复候选污染新正文的修复历史

- 文件与位置：`server/src/services/novel/runtime/repair/application/ChapterRepairFinalizer.ts；services/novel/quality/ChapterQualityLoopService.ts`。
- 所属维度：正确性、事务。
- 问题：覆盖新修复历史，错误累计 failedPatchCount/avoidRetry。
- 触发条件：旧修复评估等待期间提交新正文，旧候选最终被 discard/plateau。
- 实际影响：覆盖新修复历史，错误累计 failedPatchCount/avoidRetry。
- 根本原因：仅 adopt 路径验证 revision；discard 分两笔无条件写入。
- 最小修改方案：历史与反馈在持有 revision 的同一事务更新，过期候选不应用。 已实施。
- 需要补充的测试：repairDiscardRevisionOwnership.test.js：真实并发保存、正常 discard、触发器故障回滚。 已补充并通过。
- 是否阻塞合并：修复前是；当前已解决。

## [P1] F3 恢复资料后旧归档清理删除新索引

- 文件与位置：`server/src/services/rag/RagIndexService.ts / processJob；indexing/documentStatus.ts`。
- 所属维度：可靠性、状态转换。
- 问题：清空有效索引并把恢复后的资料投影为 idle。
- 触发条件：归档 delete 失败退避，资料恢复重建成功后旧 delete 重试。
- 实际影响：清空有效索引并把恢复后的资料投影为 idle。
- 根本原因：消费与完成投影未重新检查资料生命周期。
- 最小修改方案：知识资料 delete 消费和状态投影均验证当前仍归档。 已实施。
- 需要补充的测试：ragArchiveRestoreLifecycle.test.js：恢复后旧删除重试与仍归档的正常删除。 已补充并通过。
- 是否阻塞合并：修复前是；当前已解决。

## [P1] F4 资料保存成功但索引任务永久丢失

- 文件与位置：`server/src/services/knowledge/KnowledgeService.ts；services/rag/indexing/queue.ts`。
- 所属维度：事务、可靠性。
- 问题：资料永久 queued，没有任务自动补回；新版本无法检索。
- 触发条件：资料变更已提交，后续异步入队失败或进程退出。
- 实际影响：资料永久 queued，没有任务自动补回；新版本无法检索。
- 根本原因：fire-and-forget 吞掉队列错误，后台只恢复已有任务。
- 最小修改方案：沿用唯一入队实现并注入事务 client；资料与 job 同事务，提交后唤醒 worker。 已实施。
- 需要补充的测试：knowledgeQueueAtomicity.test.js 覆盖七条变更路径；knowledgeQueueSqliteTransaction.test.js 用真实 SQLite/第二连接核验回滚与提交可见性。 已补充并通过。
- 是否阻塞合并：修复前是；当前已解决。

## [P1] F5 二进制图片上传绕过大小限制

- 文件与位置：`server/src/modules/comic/http/imageUploadBody.ts；assetSceneRoutes.ts / characterImageRoutes.ts`。
- 所属维度：安全、性能。
- 问题：全量缓冲与拼接使 API 进程内存无界增长。
- 触发条件：向图片上传接口发送超大 Content-Length 或 chunked 请求。
- 实际影响：全量缓冲与拼接使 API 进程内存无界增长。
- 根本原因：express.json 限额不适用于 image/*，路由自行读取整个请求。
- 最小修改方案：在 HTTP 边界限制 10 MiB，明确 PNG/JPEG/WebP、拒绝压缩请求与空体。 已实施。
- 需要补充的测试：comicImageUpload.test.js：超限、chunked、空体、格式及正常图片。 已补充并通过。
- 是否阻塞合并：修复前是；当前已解决。

## [P1] F6 图片读取异常使进程退出或泄漏文件句柄

- 文件与位置：`server/src/modules/comic/http/*ImageRoutes.ts；server/src/modules/drama/http/imageFileRoutes.ts`。
- 所属维度：可靠性、资源释放。
- 问题：未处理的 ReadStream error 可退出进程；断开的请求残留文件源。
- 触发条件：定位文件后文件消失，或客户端中断图片下载。
- 实际影响：未处理的 ReadStream error 可退出进程；断开的请求残留文件源。
- 根本原因：八个端点裸 pipe，缺少源流错误和关闭管理。
- 最小修改方案：使用 Express sendFile 的资源生命周期，按未响应、已响应、已断开处理回调。 已实施。
- 需要补充的测试：imageFileResponse.test.js：真实 HTTP 缺文件、正常输出、中断后 FD 关闭。 已补充并通过。
- 是否阻塞合并：修复前是；当前已解决。

## [P2] F7 伪造转发头绕过限流与审计身份

- 文件与位置：`server/src/http/clientIp.ts；middleware/rateLimit.ts；app.ts createApp`。
- 所属维度：安全。
- 问题：逃逸配额、伪造审计来源并增加 bucket 数量。
- 触发条件：直接客户端随请求更换 X-Forwarded-For 首地址。
- 实际影响：逃逸配额、伪造审计来源并增加 bucket 数量。
- 根本原因：不经过代理信任边界，直接采用用户提交的首段。
- 最小修改方案：统一使用 Express req.ip；API_TRUST_PROXY 显式 IP/CIDR，默认不信任转发头。 已实施。
- 需要补充的测试：clientIpTrust.test.js：真实 HTTP 伪造头、可信代理和多跳来源。 已补充并通过。
- 是否阻塞合并：修复前是；当前已解决。

## [P1] F8 外部服务响应体停滞绕过超时

- 文件与位置：`server/src/services/rag/EmbeddingService.ts；VectorStoreService.ts`。
- 所属维度：超时、资源生命周期。
- 问题：索引、检索或健康检查长期等待，原超时无法收口。
- 触发条件：Embedding/Qdrant 返回响应头后停止发送成功体或错误体。
- 实际影响：索引、检索或健康检查长期等待，原超时无法收口。
- 根本原因：fetch 返回后立即清除 timer，未覆盖 body 消费。
- 最小修改方案：将正文解析、错误读取和必要取消放在 deadline 生命周期内，finally 统一清理。 已实施。
- 需要补充的测试：ragResponseDeadline.test.js：真实慢 200/500 body、集合信息、health、正常/400/404。 已补充并通过。
- 是否阻塞合并：修复前是；当前已解决。

## [P1] F9 流式请求重叠和提前结束破坏前端运行状态

- 文件与位置：`client/src/hooks/useSSE.ts；useNovelPipelineController.ts；ChatPage.tsx`。
- 所属维度：异步正确性、资源释放。
- 问题：旧正文混入新结果，新请求不能取消或关联被清除，UI 长期生成中。
- 触发条件：A 取消后启动 B；A 迟到帧/清理/完成刷新返回；或响应头静默、EOF 缺终结帧。
- 实际影响：旧正文混入新结果，新请求不能取消或关联被清除，UI 长期生成中。
- 根本原因：异步帧与回调无请求所有权；watchdog 晚于 headers；EOF 没有终态。
- 最小修改方案：controller 归属检查贯穿帧、catch/finally 和 onDone await 后副作用；超时覆盖 headers；EOF 显式中断并关闭 reader。 已实施。
- 需要补充的测试：client/src/hooks/useSSE.test.mjs：重叠响应、句柄、EOF、header deadline、body 清理、callback rejection、迟到完成刷新。 已补充并通过。
- 是否阻塞合并：修复前是；当前已解决。

## [P2] F10 旧详情遮住导演最新审批和进度

- 文件与位置：`client/src/pages/novels/automation/directorTaskSelection.ts；hooks/novelEdit/useNovelDirectorTaskController.ts`。
- 所属维度：前端状态投影。
- 问题：旧详情固定优先，新审批 checkpoint/进度被遮住，终态详情可能不刷新。
- 触发条件：detail 首次取到 running，active 轮询已进入 waiting_approval 或其他新状态。
- 实际影响：旧详情固定优先，新审批 checkpoint/进度被遮住，终态详情可能不刷新。
- 根本原因：双数据源固定优先级且 detail 不持续轮询。
- 最小修改方案：先固定任务身份，同任务按服务端 updatedAt 选择更新快照；活动详情轮询至终态。 已实施。
- 需要补充的测试：directorTaskSelection.test.mjs：新 active 替换旧 detail，旧 active 不覆盖新 detail，历史任务选择不回归。 已补充并通过。
- 是否阻塞合并：修复前是；当前已解决。

## [P1] F11 已取消 LLM 调用仍启动并可能误报成功

- 文件与位置：`server/src/llm/invokeTimeout.ts / runWithEnforcedTimeout`。
- 所属维度：取消、正确性。
- 问题：继续发送付费请求；已完成的 Promise 抢先把取消当成功。
- 触发条件：进入包装器前 signal 已取消，或操作同步触发上游取消并返回 resolved Promise。
- 实际影响：继续发送付费请求；已完成的 Promise 抢先把取消当成功。
- 根本原因：先启动 input.run，后安装 abort/timeout。
- 最小修改方案：预检查取消，先安装所有者，再通过 microtask 启动并复查 signal；race 观察迟到拒绝。 已实施。
- 需要补充的测试：invokeTimeoutCrash.test.js：预取消零调用、同步取消传递与结果竞争、迟到 rejection。 已补充并通过。
- 是否阻塞合并：修复前是；当前已解决。

## [P2] F12 错误中间件二次写入已开始的响应

- 文件与位置：`server/src/middleware/errorHandler.ts`。
- 所属维度：错误处理。
- 问题：二次 JSON 写入产生 ERR_HTTP_HEADERS_SENT，遮蔽原始错误。
- 触发条件：流响应已发送 headers 或连接已销毁后 next(error)。
- 实际影响：二次 JSON 写入产生 ERR_HTTP_HEADERS_SENT，遮蔽原始错误。
- 根本原因：所有错误分支无条件写结构化响应。
- 最小修改方案：已发送 headers 转交 Express final handler；已销毁响应不再写。 已实施。
- 需要补充的测试：httpErrorOwnership.test.js：原始 Error/AppError 转交、已销毁连接。 已补充并通过。
- 是否阻塞合并：修复前是；当前已解决。

## [P1] F13 桌面退出早于服务停止且失败无法重试

- 文件与位置：`desktop/src/main.ts；runtime/server.ts；runtime/serverLifecycle/index.ts；server/src/app/desktopLifecycle/index.ts`。
- 所属维度：资源生命周期、可靠性。
- 问题：服务或编码进程残留；缓存拒绝 Promise 后后续退出始终失败。
- 触发条件：退出/重启/安装更新发生于服务运行或启动中；首次关闭失败。
- 实际影响：服务或编码进程残留；缓存拒绝 Promise 后后续退出始终失败。
- 根本原因：Electron 不等待异步 before-quit；pnpm 包装层和 killed 标记不能代表退出；stop 缓存拒绝。
- 最小修改方案：退出 gate 等待真实进程退出；直接持有 Node/utilityProcess，私有父 IPC 优雅关闭；失败清除 stop 尝试供重试。 已实施。
- 需要补充的测试：desktop serverLifecycle/serverStopRetry 与 server desktopParentShutdown：实际子进程 IPC、启动等待、首次失败再次成功。 已补充并通过。
- 是否阻塞合并：修复前是；当前已解决。

## [P2] F14 桌面 readiness 的外层期限无法中断 fetch

- 文件与位置：`desktop/src/runtime/serverLifecycle/index.ts / waitForServerHealth`。
- 所属维度：超时、可用性。
- 问题：启动超过 45 秒仍无限等待，外层 deadline 无法执行。
- 触发条件：本地服务接受连接但不返回响应头。
- 实际影响：启动超过 45 秒仍无限等待，外层 deadline 无法执行。
- 根本原因：fetch 无取消信号，deadline 只在循环边界检查。
- 最小修改方案：每次请求受剩余启动期限约束，并观察子进程退出；取消响应体。 已实施。
- 需要补充的测试：desktop/tests/serverLifecycle.test.cjs：真实无响应 HTTP、进程退出。 已补充并通过。
- 是否阻塞合并：修复前是；当前已解决。

## [P1] F15 超长有声书合并超过 RIFF 长度上限

- 文件与位置：`server/src/services/audiobook/audiobookWav.ts`。
- 所属维度：边界正确性。
- 问题：uint32 头长度写入 RangeError，WAV 合并和后续 M4B 失败。
- 触发条件：24kHz 单声道 16bit 全书约超过 24.85 小时，数据跨越 4 GiB。
- 实际影响：uint32 头长度写入 RangeError，WAV 合并和后续 M4B 失败。
- 根本原因：全书仍固定采用 RIFF32 与 44 字节头。
- 最小修改方案：超限采用 RF64/ds64，统一大小计算、头长度、拼接偏移和解析。 已实施。
- 需要补充的测试：audiobookLargeWav.test.js：虚拟 4 GiB 拼接、正常小 RIFF、非法 RF64 元数据；未实际编码 4 GiB 文件。 已补充并通过。
- 是否阻塞合并：修复前是；当前已解决。

## [P2] F16 MiMo 已取消请求仍发送

- 文件与位置：`server/src/services/audiobook/MimoChatAudioTTSProvider.ts；infrastructure/mimo/index.ts`。
- 所属维度：取消、资源生命周期。
- 问题：仍合成语音并产生上游调用成本。
- 触发条件：调用前或配置读取 await 期间取消，abort 事件已触发。
- 实际影响：仍合成语音并产生上游调用成本。
- 根本原因：仅依赖后来注册的 abort listener。
- 最小修改方案：入口、配置后、HTTP 前与成功响应后验证 signal，finally 清理 listener/timer。 已实施。
- 需要补充的测试：mimoTtsCancellationRegression.test.js：预取消、配置等待取消、请求中取消。 已补充并通过。
- 是否阻塞合并：修复前是；当前已解决。

## [P2] F17 MiMo 503 被错误转换导致熔断失效

- 文件与位置：`server/src/services/audiobook/infrastructure/mimo/index.ts`。
- 所属维度：错误分类、可靠性。
- 问题：503 专用熔断不计数，重复请求繁忙服务。
- 触发条件：上游语音服务返回 503。
- 实际影响：503 专用熔断不计数，重复请求繁忙服务。
- 根本原因：HTTP 错误统一转换 502。
- 最小修改方案：保留有效的真实 4xx/5xx 状态交给现有重试与熔断策略。 已实施。
- 需要补充的测试：mimoTtsCancellationRegression.test.js 与 endpoint fallback：503 触发熔断和既有策略。 已补充并通过。
- 是否阻塞合并：修复前是；当前已解决。

## [P2] F18 重做有声书后缓存继续播放旧内容

- 文件与位置：`server/src/modules/novel/production/http/audiobook/audioResponse.ts`。
- 所属维度：缓存正确性。
- 问题：播放与下载仍使用旧音频。
- 触发条件：同一个稳定 URL 对应文件被重做覆盖，浏览器仍处于一小时 freshness 内。
- 实际影响：播放与下载仍使用旧音频。
- 根本原因：可变资源发送 private,max-age=3600。
- 最小修改方案：完整响应和 Range 响应使用 private,no-store。 已实施。
- 需要补充的测试：audiobookAudioResponse.test.js：200/206 响应缓存合同。 已补充并通过。
- 是否阻塞合并：修复前是；当前已解决。

# Delete List

- `server/tests/pipelineChapterQualityPersistStub.test.js` 与 `pipelineChapterQualityStubPersistHelper.test.js`：仅断言绕过 revision 的无条件补写，固化了错误行为；已删除，由真实 SQLite 所有权测试替代。
- `PipelineChapterQualityPolicy` 的直接 stub writer：重复唯一质量 writer 且绕过并发所有权，已删除，调用方同步收口。
- `KnowledgeService.queueKnowledgeRebuild/queueKnowledgeDelete`：异步吞错造成无持久任务，已删除；调用方改为事务内唯一入队实现。
- 桌面重复 health 循环、旧 stop 包装与 pnpm 启动包装：已被有实际进程所有权、deadline、重试能力的实现替代并删除，调用方已切换。
- 漫画/短剧门面中被迁入职责模块的重复路由体、失去用途的导入，以及 MiMo provider 内被 HTTP adapter 替代的重复代码：已同步移除；方法与路径清单保持一致。

# Final Verdict

- 本轮确认问题已修复，可将同一已验证代码树快进到本地 beta；main、远端和生产环境不在本轮推广范围。
- 合并前必须修复的问题：本轮已确认项无遗留。任何后续代码修改应重跑其影响范围，不能沿用失效证据。
- 发布前验收：核实实际受控代理链并设置 `API_TRUST_PROXY`（默认不信任转发头，未配置时同代理用户共享配额）；真实 Windows 退出、打包、长音频听感/编码、目标 PostgreSQL/Qdrant 环境仍需专项验收。
- 历史资料若已经缺索引任务，需要显式重建；修复防止新漏单，不暗中操作存量数据。本轮只使用独立临时测试数据库。
- 最小推广路径：feature 已验证树 → 本地 beta → 产品/目标平台验收 → 按项目规则决定 main 与发布；本轮不 push、不部署。
- 稳定知识已同步相关 Wiki；用户行为变更已合并到 2026-09-30 更新说明与 README。该审查记录为内部验证材料，不再单独追加发布条目。
