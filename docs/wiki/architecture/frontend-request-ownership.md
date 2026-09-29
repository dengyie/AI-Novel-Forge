# 前端请求所有权与任务快照

## 背景

章节写作、修复、世界生成使用同一个 `useSSE` 接口。用户取消后立即重试时，旧请求的异步 continuation 仍可能返回；网络正常 EOF 也不等于服务端已经完成保存。导演任务则同时来自定期刷新的 active 接口和按 ID 查询的 detail 接口，两者都可能持有较早快照。

## 当前规则

- 每次 start 创建独立 AbortController。只有 controller 仍是 hook 当前请求且没有取消，才能消费帧、触发完成回调和更新状态。
- finally 只能清理自己拥有的 controller 引用，不能把新请求的取消句柄清空。退出时取消 reader 并释放锁。
- 静默 deadline 从 fetch 开始前覆盖响应头等待；收到字节才续期。done/error 终止读取并清理 deadline。没有终结帧的 EOF 是可见中断，保留已收到正文但不能标为完成。
- onDone 的异步回调必须被等待并观察失败，禁止 fire-and-forget 造成未处理 rejection。
- Director 先按显式任务 ID、active、可恢复的书级投影确定任务身份。同一任务的 detail 与 active 数据按服务端 `updatedAt` 选择较新者；不能用客户端请求先后或固定接口优先级覆盖新状态。
- 请求中的任务详情持续轮询，直到观察到终态。active 接口移除完成任务不能替代对该任务最终详情的读取。

## 失败模式与验证

重叠请求应测试迟到响应、旧请求 catch/finally、取消新请求。流传输应测试缺少终结帧、响应头静默、终结后服务端没有立刻关闭和异步回调拒绝。任务快照应测试审批点更新及旧 active 响应晚到；保留显式历史任务、失败与恢复投影的既有选择规则。

## 相关模块

- `client/src/hooks/useSSE.ts`
- `client/src/pages/novels/automation/directorTaskSelection.ts`
- `client/src/pages/novels/hooks/novelEdit/useNovelDirectorTaskController.ts`
- [自动导演运行时](../workflows/auto-director-runtime.md)
- [Wiki 索引](../README.md)
