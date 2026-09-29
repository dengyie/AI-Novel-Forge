# 有声书第二轮生产审查

基线：beta@0f891f60；分支：codex/review-round2-audio。

本阶段聚焦 MiMo HTTP 请求生命周期。provider 同时承担请求构造、端点策略、熔断、HTTP 和响应解码，原文件 797 行。将 HTTP/响应解码移入 owned infrastructure/mimo，provider 保留产品与应用策略，门面维持现有调用契约。

1. Public synthesize 回归：预先取消、配置读取期间取消不能调用 fetch；HTTP 503 必须进入熔断。
2. 最小修复：取消边界检查、真实 HTTP 状态传递、单次请求资源释放。
3. 验证请求中/正文读取取消、请求契约、fallback、transport 和 circuit 测试及 server TypeScript 构建。
4. 更新有声书边界 wiki、用户更新记录并提交独立阶段。

初次回归 3/3 失败：两个取消用例缺少预期 rejection；503 返回 502。未触及业务数据库或生产服务。
