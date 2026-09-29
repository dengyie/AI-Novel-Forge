# RAG 与接口边界第二轮修复计划

**Goal:** 修复已复现的资料恢复/索引一致性和外部请求失败边界，保留明确接受的 open 策略。
**Architecture:** 消费持久任务时再次核验资料当前生命周期；外部请求超时覆盖响应体读取。每项先失败证据，再最小实现和定向验证。
**Scope:** RAG、知识库、非音频 HTTP 文件/网络边界；不操作生产或业务数据库，不修改认证产品策略。

- [x] 复现归档 delete 退避→恢复启用并重建成功→旧 delete 重试导致索引清空。
- [x] 消费端和状态投影共同拒绝对恢复文档执行旧归档删除，补当前归档仍可清理的回归。
- [ ] 检查 Embedding/Qdrant 响应头之后的超时；用本地短生命周期 HTTP 服务器验证慢响应体，确认后修复。
- [ ] 审核知识文档提交和入队的持久边界，以及 API 输入/路径/secret 调用链；只处理确认缺陷。
- [ ] 每阶段更新 wiki/release notes，运行 server build 和相应测试后提交。

阶段一验证：server build 通过；archive/consistency/status/worker 四组共 29 tests 通过。仅 stub 数据，不接业务数据库。
