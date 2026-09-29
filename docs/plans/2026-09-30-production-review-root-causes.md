# 生产审查根因修复实施计划

**目标：** 修复 main@f690a22d 审查确认的 8 项问题，以对应失败场景的回归验证作为完成依据。

**架构：** HTTP 音频响应拥有文件流生命周期；M4B 队列拥有跨进程执行代际与发布权；章节投影与正文共享 revision 所有权；JIT 刷新由显式合同表达；RAG 队列追赶内容版本并持久化清理责任。沿用现有模块，不建立新的通用兜底框架。

**技术栈：** TypeScript、Node stream、Express、Prisma（SQLite / PostgreSQL）、node:test。

## 全局约束

- 主工作区 main 保持只读；集成分支 `codex/production-review-fixes`，各独立子系统在独立工作树提交后集成。
- 不连接生产、不迁移现有业务数据库、不发布；测试数据库只使用新建临时文件。
- 每项先记录失败证据，再实施根因修复，再重跑同一证据；优先真正时序测试而不是源码字符串断言。
- 超过 700 行的相关文件不继续扩展职责；抽取触及的职责到有归属的子模块。
- 每个完成阶段提交前核查 Wiki、日期发布说明和 README；最终检查覆盖所有 8 项。

## 阶段一：HTTP 音频流生命周期（主审）

文件：`server/src/modules/novel/production/http/novelAudiobookRoutes.ts`；新增 owned `http/audiobook/audioResponse.ts` 与 `index.ts`；测试 `server/tests/audiobookAudioResponse.test.js`。

接口保持 `streamAudioFile(req, res, filePath, downloadName, contentType, disposition): void` 与 `streamWavFile(req, res, filePath, downloadName): void`，调用方只从 audiobook HTTP facade 导入。

- [x] 提取原有 Range / WAV 响应行为，写真实 HTTP 断连、Range、异步读取错误测试。
- [x] 红测：响应销毁后 `assert.equal(source.closed, true)` 失败，复现未关闭源流。
- [x] 使用 `pipeline(source, res, callback)` 绑定源与响应资源；同步路径异常仍由路由处理，异步错误由 callback 收口，正常客户端断连不升级为进程错误。
- [x] 运行 `node --test server/tests/audiobookAudioResponse.test.js`，验证 Range 206、416、完整响应和资源回收。
- [x] 更新 HTTP 资源所有权 Wiki 与发布说明后提交。

## 阶段二：M4B 执行生命周期（独立子计划）

文件归属：`server/src/services/audiobook/m4b/`、worker 入口、AudiobookPipelineService / AudiobookTaskService 的 M4B 边界、相关双引擎迁移与测试。

- [ ] pending 队列下验证实际入口路径，入口不存在必须显式失败。
- [ ] 假时钟验证健康推进超过 120 秒不误杀、停滞才取消，并验证 ffmpeg 进程组结束。
- [ ] 暂停旧代编码，轮换代际再释放，旧产物不得发布、旧任务不得提交当前状态。
- [ ] 实现持久代际/领取所有权、发布检查与取消收口，复用编码边界，去掉被替代的重复逻辑。
- [ ] 新建 SQLite 应用增量迁移验证实际字段；补 Wiki / 发布说明，提交。

## 阶段三：章节投影与 JIT（独立子计划）

文件归属：`ChapterArtifactSyncService`、CRUD artifact 写入、pipeline adapter、`ChapterPlanJITService`、`ChapterExecutionContractService`。

- [ ] R7 投影暂停 → R8 提交并投影 → R7 恢复；断言 R8 timeline / facts 保留。
- [ ] 贯穿提交返回 revision，投影写事务使用已有 `ChapterProjectionRevisionGuard`。
- [ ] 完整合同 + 新事实连接真实 JIT / Contract，断言生成被调用；同一事实版本复用。
- [ ] 实现显式刷新合同与事实指纹，避免以 entrypoint 字符串分支替代语义。
- [ ] 运行章节合同与投影专项回归，补 Wiki / 发布说明，提交。

## 阶段四：RAG 版本追赶与清理（独立子计划）

文件归属：`rag/mainProcessProxy.ts`、owned `rag/indexing/`、KnowledgeService、RagIndexService 与相关测试。

- [ ] v1 读取后暂停，上传 v2，释放 v1；断言 v2 最终入索引且旧完成事件不能宣告新版成功。
- [ ] 注入旧向量删除失败、数据库删除成功场景，断言旧 ID 不丢失且后续可以清理。
- [ ] 去重只合并尚未消费需求；运行中新增需求持久追赶；清理责任保留到外部删除完成。
- [ ] 核验 queued payload 合并、重启恢复及失败重试，补 Wiki / 发布说明，提交。

## 最终集成

- [ ] 逐份审阅独立提交，合并日期说明并核查双引擎 schema / migration 一致性。
- [ ] 编译 shared / server，运行受影响的全部回归；客户端无 UI 修改则复用审查基线的检查，不跑浏览器验收。
- [ ] 核查 diff、工作区、8 项覆盖表及测试输出，完成集成提交；发布和 beta 推进单独报告状态。
