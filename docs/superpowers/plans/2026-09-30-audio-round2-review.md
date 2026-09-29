# 有声书第二轮生产审查

基线：beta@0f891f60；分支：codex/review-round2-audio。

本阶段聚焦 MiMo HTTP 请求生命周期。provider 同时承担请求构造、端点策略、熔断、HTTP 和响应解码，原文件 797 行。将 HTTP/响应解码移入 owned infrastructure/mimo，provider 保留产品与应用策略，门面维持现有调用契约。

1. Public synthesize 回归：预先取消、配置读取期间取消不能调用 fetch；HTTP 503 必须进入熔断。
2. 最小修复：取消边界检查、真实 HTTP 状态传递、单次请求资源释放。
3. 验证请求中/正文读取取消、请求契约、fallback、transport 和 circuit 测试及 server TypeScript 构建。
4. 更新有声书边界 wiki、用户更新记录并提交独立阶段。

初次回归 3/3 失败：两个取消用例缺少预期 rejection；503 返回 502。未触及业务数据库或生产服务。


## 交付阶段

确认相同 URL 的音频覆盖与 max-age=3600 冲突，完整/Range 响应改 no-store。两个虚拟 2GiB 章节经真实 concat 函数触发 RangeError；通过 RF64/ds64 修复，避免创建或复制 4GiB 测试内容。普通 RIFF 实际文件拼接、RF64 长度/偏移和不安全元数据均有回归。

Server build 与交付/续生成/M4B/桌面生命周期初次组合 38/38 通过，追加 RIFF 与非法 RF64 用例 3/3 通过。未运行真实超长 ffmpeg 编码或 UI 验收。


## 桌面生命周期阶段

原 health 函数在 20ms deadline 下，100ms 后仍 pending；原 before-quit callback 的 preventDefault=false/stopped=false，确认 Electron 可先退出。移除两份重复 readiness 循环与旧进程停止包装，收敛到 runtime/serverLifecycle。增加仅父 IPC 的 desktop shutdown 入口，避免 Windows 强制终止跳过 workers 收口。

Server 与 desktop build 通过；desktop 生命周期 6/6（含真实 HTTP 与子进程），父 IPC 3/3 通过。未运行 GUI、真实 Windows utilityProcess 或打包；不触及生产数据库。
