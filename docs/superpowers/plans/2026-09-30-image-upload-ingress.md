# Image Upload Ingress Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox syntax for tracking.

**Goal:** 超限漫画图片在 nginx 读取完整请求前返回可读的 413。

**Architecture:** 保留应用层二进制验证，在 /api/ 内嵌两个上传路由的 10m 限制，继承代理配置。专用错误页输出 ApiResponse JSON；其他 API 仍为 20m。

**Tech Stack:** nginx 1.27、Python 标准库、Docker、GitHub Actions。

## Global Constraints

- 仅隔离 worktree 修改，feature → beta → main；生产数据不删除。
- 不改 AI 决策、任务状态、数据库与音频链路。
- 不把 chunked 传输的网络超时宣称为完全修复。

### Task 1: 上传入口限制与回归门禁

**Files:** `infra/nginx/ai-novel-web.conf`、`scripts/deploy/test-image-upload-ingress.py`、`.github/workflows/deploy-tencent.yml`。

**Interfaces:** 输入为原始图片 HTTP 请求；输出为 413 JSON，正常请求沿用代理。脚本接受 `--image` 与 `--config`，用独立容器和回环随机端口验证，不连接生产 API。

- [x] 创建真实 nginx 回归脚本：超限 Content-Length 只发请求头即 413；10 MiB 头返回 100 Continue；小请求保留 URI、Host、XFF；chunked 超限 413；其他 API 的 11 MiB 头允许继续，20 MiB+1 拒绝。
- [x] 先对当前配置运行脚本，确认预期 413 实际 100 的失败。
- [x] 在 /api/ 内加入 `location ~* ^/api/comic/(character-assets|scenes)/[^/]+/upload-image/?$`，设置 `client_max_body_size 10m` 与 `error_page 413 = @image_upload_too_large`；命名 location 返回中文 JSON 413。
- [x] 运行 `python3 scripts/deploy/test-image-upload-ingress.py`，必须全部通过；加入发布 gate。
- [x] 更新图片边界 wiki 和 2026-09-30 发布说明；检查 diff 并提交 `fix(web): reject oversized image uploads before buffering`。
- 发布验收：beta 同树验证后按既有生产流程发布，检查公网超限上传、正常健康检查、旧图哈希，记录实际结果与未覆盖项。

## 验证证据

旧配置真实 nginx 回归失败：10 MiB+1 请求头预期 413、实际 100 Continue。修复后相同镜像运行新配置：nginx -t 与 34 项检查通过，包括 10 MiB 完整上传、累计分块超限及代理继承。生产发布结果记录到既有 Obsidian 主手册，避免为验收记录重复触发发布。
