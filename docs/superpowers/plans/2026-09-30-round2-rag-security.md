# RAG 与接口边界第二轮修复计划

**Goal:** 修复已复现的资料恢复/索引一致性和外部请求失败边界，保留明确接受的 open 策略。
**Architecture:** 消费持久任务时再次核验资料当前生命周期；外部请求超时覆盖响应体读取。每项先失败证据，再最小实现和定向验证。
**Scope:** RAG、知识库、非音频 HTTP 文件/网络边界；不操作生产或业务数据库，不修改认证产品策略。

- [x] 复现归档 delete 退避→恢复启用并重建成功→旧 delete 重试导致索引清空。
- [x] 消费端和状态投影共同拒绝对恢复文档执行旧归档删除，补当前归档仍可清理的回归。
- [x] 检查 Embedding/Qdrant 响应头之后的超时；用本地短生命周期 HTTP 服务器验证慢响应体，确认后修复。
- [x] 审核知识文档提交和入队的持久边界，以及 API 输入/路径/secret 调用链；只处理确认缺陷。
- [x] 每阶段更新 wiki/release notes，运行 server build 和相应测试后提交。

阶段一验证：server build 通过；archive/consistency/status/worker 四组共 29 tests 通过。仅 stub 数据，不接业务数据库。

阶段二：限流与审计改用 Express 可信代理解析，默认不信任转发头，API_TRUST_PROXY 显式配置代理 IP/CIDR。三项真实 HTTP 测试旧实现全红；修复后 server build + identity/GC/auth 共 14 tests 通过。部署代理网段需在实际环境验收，本阶段不改线上配置。

阶段三：超大上传200、丢文件进程退出均已红测复现。上传边界与sendFile错误收口修复后 server build + 6 HTTP tests 通过（普通/chunked超限、格式、空体、完整传输、缺失、中断FD）。comic 64 / drama 45 路由 method/path 清单前后一致；路由按明确HTTP职责拆为575/658行门面并附边界说明，无浏览器验收。

阶段四：Embedding/Qdrant响应体 deadline 六项旧实现全红；修复后慢成功/错误体、集合元数据、健康检查、正常响应、应用错误分类、404取消及独立deadline共8 tests通过；加RAG生命周期/状态共37 tests通过，server build通过。

范围收口：知识提交→fire-and-forget入队失败窗口经专项追查确认为缺陷，见阶段五。保留明确接受的open策略。后续验收仅需主线集成检查与实际可信代理链配置核验。

阶段五：确认 worker/manager 只恢复/轮询已有任务，全量owner扫描仅手动重建/设置触发，队列写失败没有自动补偿。新建/同名追加/版本/激活/重建/恢复/归档七条路径的失败回滚及成功持久化14项旧实现全红。复用唯一enqueueIndexJob实现并注入事务client，源与队列同事务提交，提交后kick；删除吞错fire-and-forget方法。验证使用内存事务快照，不连接业务DB。

阶段五验证收口：server build通过；knowledge atomicity/status、RAG archive/consistency/process boundary/worker 六组共45 tests通过。既有状态测试改为拦截事务入队实现（barrel getter不可直接mock），失败测试期间仅本地空测试库查询报缺表，无业务数据库写入。
