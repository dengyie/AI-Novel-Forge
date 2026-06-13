# Docker Compose Runtime Plan

## 背景

本项目当前可以通过 `pnpm dev` 在本机启动前端、后端和 shared watch，但这种方式依赖宿主机 Node、pnpm、原生模块编译环境和本地数据库路径。近期本机 Node 26 导致 `better-sqlite3` 原生模块无法编译，后端 API 无法启动，前端虽然可监听 5173，但 `/api/health` 代理到 3000 时失败。

仓库已经包含 `Dockerfile.api`、`Dockerfile.web` 和 `infra/docker-compose.qdrant.yml`，但还没有把 Web、API、PostgreSQL、Qdrant 和持久化目录编排成一套可迁移的一键运行方案。

## 目标

- 提供轻量、可靠、可迁移的一键容器化启动入口：`docker compose up -d --build`。
- 默认只暴露一个用户入口：`http://localhost:8080`。
- 避免宿主机 Node 版本、pnpm 安装状态和 SQLite 原生模块影响服务可用性。
- 保留现有 `pnpm dev` 本地开发路径，不把本地开发和容器运行强行合并。
- 默认使用 PostgreSQL 作为 Compose 数据库，使用 Qdrant 支持知识库/RAG，图片资产使用本地 volume。
- 首版不做 SQLite 到 PostgreSQL 的自动数据迁移，不做 destructive reset，不自动 seed。

## 非目标

- 不替换桌面端打包流程。
- 不引入 MinIO 作为默认依赖。
- 不开放 PostgreSQL 到宿主机，除非后续调试明确需要。
- 不在 Compose 启动过程中执行 `prisma migrate reset`、`db push --force-reset`、删库、清 volume 等破坏性操作。
- 不把 release 上传、桌面分发或 GitHub Actions 发布流程并入本阶段。

## 目标架构

浏览器只访问 Web 容器：

```text
Browser
  |
  | http://localhost:8080
  v
web/nginx
  |-- /assets/* and SPA routes -> static frontend
  |-- /api/* -> api:3000/api/*
  |-- generated local asset paths -> api:3000/* when needed

api
  |-- postgres:5432
  |-- qdrant:6333
  |-- /app/storage volume
```

## 服务边界

### web

- 基于 `Dockerfile.web` 构建前端静态产物。
- 使用 nginx 监听容器内 8080。
- 负责 SPA fallback。
- 负责把 `/api/` 反代到 `http://api:3000/api/`。
- 前端不应在 Docker 默认构建中写死 `localhost:3000`。

### api

- 基于 `Dockerfile.api` 构建后端生产产物。
- 使用 Node 20 Debian slim 镜像，避免宿主机 Node 版本漂移。
- 连接 Compose 内部 PostgreSQL 和 Qdrant。
- 启动前执行非破坏性迁移：`prisma migrate deploy`。
- 启动命令只允许等待依赖、部署迁移、启动 API，不做 reset、seed 或清理数据。

### postgres

- 使用 `postgres:16-alpine`。
- 通过 volume 持久化 `/var/lib/postgresql/data`。
- 默认只在 Compose 内部网络可访问。
- 提供 healthcheck，API 等待数据库可用后启动。

### qdrant

- 使用仓库现有版本 `qdrant/qdrant:v1.15.4`。
- 通过 volume 持久化 `/qdrant/storage`。
- 默认给 API 使用；是否映射到宿主机可在 override 中配置。

## 文件计划

新增：

- `docker-compose.yml`：默认一键运行编排。
- `.env.docker.example`：Docker 运行环境变量模板。
- `infra/nginx/ai-novel-web.docker.conf`：支持 API 反代的 Web nginx 配置。
- `server/scripts/docker-entrypoint.sh`：API 容器启动前的非破坏性准备脚本。
- `docs/wiki/architecture/docker-compose-runtime.md`：长期维护规则和架构边界。

可能调整：

- `Dockerfile.api`：复制 entrypoint、保证 runtime 能运行 Prisma migrate deploy。
- `Dockerfile.web`：使用 Docker 专用 nginx 配置。
- `client/src/lib/constants.ts` 或等价位置：确认生产静态部署在未设置 `VITE_API_BASE_URL` 时可以使用同源 `/api`。
- `README.md`：新增 Docker 一键启动说明。

## 环境变量策略

- `.env.docker` 可选；没有该文件时使用 Compose 内置默认值，需要改端口、数据库密码或预填模型 Key 时再由 `.env.docker.example` 复制。
- Compose 默认提供数据库、Qdrant、存储路径等内部连接变量。
- 模型供应商 API Key 可以先留空，用户仍可在 `/settings` 页面配置。
- `DATABASE_URL` 默认指向 `postgres` 服务名，不指向 `localhost`。
- `QDRANT_URL` 默认指向 `http://qdrant:6333`。
- Web 默认通过同源 `/api` 请求后端，避免迁移机器后改前端构建参数。

## 数据安全规则

- 本阶段不会删除、重置或迁移现有 SQLite 数据库文件。
- 本阶段不会执行任何数据库 destructive operation。
- `docker compose down` 是允许的普通停止方式；文档必须明确不要随意使用 `docker compose down -v`，因为 `-v` 会删除 volume 数据。
- 如未来要导入现有 SQLite 数据到 PostgreSQL，必须作为单独阶段处理，并先完成备份、备份路径记录和恢复验证。

## 验证计划

1. 配置解析：`docker compose config`。
2. 镜像构建：`docker compose build`。
3. 启动：`docker compose up -d`。
4. API 健康检查：`curl http://localhost:8080/api/health`。
5. 前端入口检查：`curl -I http://localhost:8080/settings`。
6. 浏览器检查：打开 `http://localhost:8080/settings`，确认页面可渲染、无明显控制台错误。
7. 重启检查：`docker compose restart` 后再次验证 `/api/health` 和 `/settings`。
8. 数据持久性检查：创建最小配置或记录后重启服务，确认数据未丢失。该步骤只使用普通重启，不删除 volume。

## 分阶段实施

### Phase 1：运行编排基础

- 新增 Compose、Docker env 模板、nginx 反代配置。
- 补 API entrypoint。
- 调整 Dockerfile 以使用新配置。
- 运行 `docker compose config` 和构建检查。

### Phase 2：前端同源 API 兼容

- 检查前端 API base URL 推导逻辑。
- 如果生产静态部署默认仍指向 `hostname:3000`，改为 Docker/生产静态场景使用同源 `/api`。
- 验证图片资产 URL 拼接不会因同源 `/api` 退化。

### Phase 3：文档和启动体验

- README 增加 Docker 入口、停止方式、日志查看、数据卷说明。
- Wiki 记录架构边界和维护规则。
- 补充常见问题：Node 版本不影响 Docker 运行、不要使用 `down -v` 清数据、如何关闭 RAG。

### Phase 4：完整验证和提交

- 运行 Compose 端到端验证。
- 检查 Git scope。
- 如属于用户可见运行方式变化，按 README Release Notes Workflow 更新 release notes 和 README 最新更新。
- 提交阶段性 commit。

## 当前注意事项

- 开发开始前工作树已有 `server/package.json` 和 `pnpm-lock.yaml` 修改，内容是 Prisma 相关依赖从 7.4.2 升到 7.8.0。该变更不是 Docker Compose 方案本身产生的，实施前需要确认是保留、纳入本阶段，还是恢复到远端版本。
- 当前本机已有 `cpa-stack` 的 Docker 容器运行，端口为 18317 和 8317，不占用本方案默认端口 8080、3000、5432、6333。
