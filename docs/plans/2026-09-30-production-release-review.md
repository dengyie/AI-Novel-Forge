# Review Summary

- 范围：前两轮修复的发布前复核，扩展至完整 fast suite、Docker 运行依赖、媒体端到端状态、真实生产部署链。
- 发现：图片替换发布协议、M4B 完成投影及前端轮询、过期任务清理音频块、镜像依赖缺失、图片 Range 错误映射。
- 原始风险：高。代码修复已完成，完整本地发布门禁通过；镜像构建与线上调用仍由发布流程验证。
- 结构：沿用现有事务、任务代际与模块门面，提取音频完成阶段；没有新增业务关键词兜底或平行任务框架。
- 扩展性：镜像依赖在 runtime 声明；文件 HTTP 错误由统一边界处理；M4B 工作进程与主任务使用同一代际收口。
- 测试：新增行为回归；完整 fast 测试首次 452 文件中 7 文件失败，修复后最终 455/455 文件通过（0 failure、0 timeout，process isolation、并发 6）。旧测试只更新契约，不跳过用例或放宽生产校验。
- 删除：替换了过期的源码字符串断言；没有确认需要额外删除的生产文件。

# Findings

## [P1] M4B 工作进程完成没有同步任务与页面状态

- 文件与位置：`server/src/services/audiobook/m4b/M4bJobQueueService.ts`；`AudiobookTaskService.ts`；`client/src/pages/novels/components/NovelAudiobookPanel.tsx`。
- 所属维度：正确性、状态一致性。
- 问题：任务把已入队保存为 skipped；工作进程完成只更新编码 job；页面在主任务 succeeded 后停止轮询。
- 触发条件：主任务交付 WAV 后后台完成编码，或编码早于主任务终态持久化。
- 实际影响：已生成的整书 M4B 无下载入口，主任务的迟到保存还可能覆盖 ready。
- 根本原因：异步产物与主任务各自收口，无统一所有权与消费状态。
- 最小修改方案：按 task→job 锁序投影当前代际，主任务最终保存读取当前编码状态；前端持续轮询明确的编码中状态。
- 需要补充的测试：先后两种完成顺序、失败/换代/耗尽重试、页面终态仍编码时继续轮询。
- 是否阻塞合并：已修复，行为回归通过；线上验收见运维记录。

## [P1] 旧任务完成时可删除新一轮音频块

- 文件与位置：`server/src/services/audiobook/application/finalization/`。
- 所属维度：数据一致性、竞态。
- 问题：清理 chunk 发生在代际校验前。
- 触发条件：旧流水线完成与新代际重做竞争。
- 实际影响：新一轮临时音频被删除，重做失败或重复调用语音服务。
- 根本原因：数据库写入有代际条件，文件副作用没有。
- 最小修改方案：取得当前任务代际锁后才同步清理文件。
- 需要补充的测试：旧 finalize 不删除新代际 chunk，当前代际正常清理。
- 是否阻塞合并：已修复，行为回归通过；线上验收见运维记录。

## [P2] 替换图片格式后仍读取旧图片，失败可丢失旧图

- 文件与位置：`server/src/services/comic/ComicCharacterAssetService.ts`。
- 所属维度：正确性、文件/数据库一致性。
- 问题：固定扩展名优先级遮住后上传图片；直接覆盖文件早于数据库成功。
- 触发条件：PNG 后上传 JPEG，或文件写入/数据库提交失败。
- 实际影响：上传成功仍显示旧图，失败后原图无法恢复。
- 根本原因：未区分候选文件与已发布文件。
- 最小修改方案：完整候选文件写入后，在事务中发布文件指针；失败仅清理候选，成功清理实际被替代版本。
- 需要补充的测试：换格式、同格式提交失败、部分写失败、生成路径使用同一发布协议。
- 是否阻塞合并：已修复，行为回归通过；线上验收见运维记录。

## [P2] 生产镜像缺少编码与进程所有权检查依赖

- 文件与位置：`Dockerfile.api` runtime 阶段。
- 所属维度：部署正确性、可靠性。
- 问题：生产容器不存在 ffmpeg、ffprobe、ps。
- 触发条件：网页生成整书音频，或回收残留编码进程。
- 实际影响：M4B 无法编码，进程身份无法安全核实。
- 根本原因：依赖未声明在最终镜像，仅假设宿主环境具备。
- 最小修改方案：runtime 安装 ffmpeg、procps、openssl，并在构建中执行依赖可用性检查。
- 需要补充的测试：新镜像工具检查、实际 worker 编码与下载。
- 是否阻塞合并：是，镜像构建及真实编码验证后解除。

## [P2] 图片不可满足 Range 请求被误映射为 500

- 文件与位置：`server/src/http/fileResponse.ts`；漫画/短剧图片 HTTP 入口。
- 所属维度：协议正确性、错误处理。
- 问题：sendFile 的 416 被通用错误处理中间件当内部错误处理，并继承图片响应头。
- 触发条件：请求字节起点超过图片长度。
- 实际影响：错误的服务器故障报告与响应类型/缓存语义。
- 根本原因：文件响应边界未转换已知 HTTP 错误。
- 最小修改方案：仅在 sendFile 边界映射允许的状态，清除不适合 JSON 错误的图片响应头并保留合法 Content-Range。
- 需要补充的测试：真实 HTTP 416、Content-Range、JSON 类型与缓存头。
- 是否阻塞合并：已修复，真实 HTTP 回归通过；线上验收见运维记录。

# Delete List

- `.github/workflows/deploy-pxed.yml`：pxed 已停产，但工作流仍自动响应 main。发布时确认触发后，在 gate 阶段取消并禁用；未执行构建包/远程 cutover。已删除工作流并同步清理旧部署手册的可执行指令。
- 过期源码断言已替换为实际行为验证。

# Final Verdict

可合并 beta 并通过发布门禁进入 main。当前已确认的代码阻塞问题均已修复；Docker 构建内置依赖检查及线上真实调用是发布后的必要验收。未覆盖超长音频压力、Windows GUI、PostgreSQL 与关闭中的 Qdrant 外部检索，不据此宣称全库无缺陷。

推荐最小路径：feature rebase 最新 main → beta 同树验证 → main 推送触发既有 deploy-tencent.yml → 公网真实接口验收。

# Verification and deployment preflight

- 代码/测试基线：`86ba3b2a`；shared/server build、client 生产 build 通过；client 状态/SSE/导演投影 19/19 通过。最后测试专用提交未改变构建产物，复用同一代码树的构建证据。
- 最终完整 fast 证据：`/tmp/ainovel-round2-evidence-latest` 所指目录的 `release-verified-fast.log`；455/455 文件通过。
- 前两轮真实 SQLite、桌面生命周期验证保留在对应审查报告；本轮未重复未改动的桌面测试。
- 生产依据：Obsidian《ainovel 文档索引》→《pxed ai-novel 部署与运维》七点九十七～九十九；现网腾讯 `/opt/ai-novel`，不是旧 pxed。
- 发布前仍为 `f690a22da38d`，健康检查通过；业务任务/小说计数均为 0。
- 备份：`/opt/ai-novel/backups/20260929T222859Z-pre-review-release`，SQLite 3,100,672 字节，integrity_check=ok；同时保存文件归档、.env、compose、pin/rollback 脚本，权限 600/700。
- 代理信任：现场受控网络仅 api/web，实际子网 `172.18.0.0/16`，配置 `API_TRUST_PROXY` 为该子网，8080 保持宿主环回。网络重建/迁移需重验该边界。
- RAG_ENABLED=false，线上只验收资料/版本/队列持久化，不将其算作真实向量检索通过。
- 生产最终部署标识、实际测试结果与保留的测试数据登记到同一 Obsidian 运维主手册。

## [P1] 退役主机自动部署入口仍响应 main

生产已迁腾讯，旧 pxed workflow 仍 active。main 推送会同时触发两套部署，有重启退役主机并修改旧数据的风险。根因为迁移只关闭运行服务，没有删除发布入口。最小修复是取消尚在 gate 的旧运行、禁用并删除 workflow，移除旧手册中的可执行入口。以 GitHub job 状态核验 Cutover 未启动；无需重跑未变化的应用测试。
