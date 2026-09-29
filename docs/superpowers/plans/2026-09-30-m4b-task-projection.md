# M4B 持久任务投影收口

基线 beta@b01ca810；独立分支 codex/review-release-m4b-projection。

1. 通过真实 SQLite task/job 验证 worker 成功、失败没有更新任务投影，保留红证据。
2. 保持 task→job 锁顺序；队列发布/失败事务同时合并当前代际任务投影。主任务最终保存也在同一行锁下读取当前代际 job，不能覆盖先完成的 worker。
3. AudiobookTaskService 目前承担排队、恢复、进度、文件与最终保存；本次把完整成功收口提取到 application/finalization，投影策略留在 owned m4b 模块，通过门面消费。
4. 覆盖 worker 先/后完成、失败、换代、取消与已有非 M4B 元数据保留。修复部署检查以读取真实 schema 与旧 pending/processing 数量。
5. 目标验证、Wiki、release 与阶段提交。仅 synthetic DB，无线上操作。


## 验证与补充结论

- 初始 worker 成功/失败回归均保持 skipped，2/2 红；旧 finalize 清掉 g2 chunk 的回归报 ENOENT；旧前端 succeeded+encoding 轮询返回 false。
- 当前投影测试 12/12：success/failure 的生产保存先后顺序、同时发布、摘要 API 投影、换代保护、retry 耗尽、旧 finalize 不删新 chunk。
- ownership/worker/migration 7 文件 19/19；恢复/继续生成/代际/投影组合 56/56（随后新增 chunk 保护并局部复验）。
- 全量检查暴露的五个音频文件已针对根因修复：废弃路由源码断言改为真实 HTTP 下载 disposition；逐章交付 fixture mock 持久队列边界并传递代际；短时间窗子进程 fixture 不主动降权；permit fixture 无论准备是否失败都 abort 拥有的进程。相关 7 文件 36/36。
- shared/server 构建通过；前端轮询纯策略 3/3。最终 client 构建与整合全量 gate 由主代理执行，未运行 UI/浏览器验收。
- 所有数据库测试使用 `/tmp/ainovel-m4b-lifecycle-test.db` 或自动创建的隔离临时 SQLite，未操作线上。
