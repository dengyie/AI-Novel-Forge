# Docker Compose 运行边界

## Background

本项目的本地开发入口 `pnpm dev` 适合代码调试，但它依赖宿主机 Node 版本、pnpm、原生模块编译环境和本地 SQLite 文件。对于完整小说生产链路来说，服务入口不稳定会直接影响新手用户完成配置、创建小说、启动自动导演和继续章节生产。

容器化运行的目标不是替代本地开发，而是提供一个可迁移、可复现、低心智负担的服务启动面：用户只需要准备 Docker 和环境变量，就能启动 Web、API、数据库和向量服务。

## Decision

Docker Compose 默认运行时采用以下边界：

- Web 容器是唯一浏览器入口，默认暴露 `http://localhost:8080`。
- Web nginx 托管前端静态文件，并反代 `/api` 到 API 容器。
- API 容器使用 Node 20 系列镜像运行构建产物，避免宿主机 Node 版本影响服务启动。
- Compose 默认数据库使用 PostgreSQL，而不是 SQLite。
- Qdrant 作为知识库/RAG 向量服务被纳入 Compose，但 RAG 是否实际启用仍由环境变量和页面设置控制。
- 生成图片和导出等本地资产使用 Docker volume 持久化。

## Current Rule

### 单入口访问

容器化部署中，浏览器应只访问 Web 服务端口。前端生产构建不应默认把 API 指向 `localhost:3000`，因为在用户浏览器中 `localhost` 指的是访问设备本身，而不是 Compose 网络里的 API 容器。

默认规则是：

```text
Browser -> web:8080 -> /api proxy -> api:3000
```

这条规则让本机、局域网机器和轻量服务器迁移都保持同一种访问模型。

### PostgreSQL 作为 Compose 默认数据库

SQLite 继续作为本地 `pnpm dev` 的轻量默认值。Compose 默认使用 PostgreSQL，原因是：

- PostgreSQL 更适合容器化持久化、备份和后续部署迁移。
- API Dockerfile 构建路径已经按 PostgreSQL schema 生成 Prisma Client。
- PostgreSQL 避免 SQLite 文件权限、路径和原生模块运行时差异。
- 自动导演、任务中心、章节生产链和 Prompt/设置数据都需要可恢复的持久状态。

### API 启动只做非破坏性准备

API 容器启动时可以执行 `prisma migrate deploy`，但不得执行：

- `prisma migrate reset`
- `prisma db push --force-reset`
- 删除数据库文件或 volume
- truncate/drop table
- 自动 seed 覆盖用户已有数据

如果未来需要 SQLite 到 PostgreSQL 的数据迁移，必须作为独立迁移阶段处理，并先完成备份、备份路径记录和恢复验证。

PostgreSQL 运行时以 `20260413120000_postgresql_baseline` 作为有效基线。更早的 `20260328120000_schema_gap_backfill` 是 SQLite 历史补丁，不能在空 PostgreSQL 库上执行；容器入口在空库首次启动时应先把它标记为已应用，再让 `prisma migrate deploy` 从 PostgreSQL baseline 继续执行。

如果历史兼容迁移曾经在 PostgreSQL 上留下 `finished_at IS NULL AND rolled_back_at IS NULL` 的失败记录，容器入口可以把该迁移标记为已回滚后继续执行。该兼容处理只能修正 Prisma 迁移元数据，不得修改用户表数据来伪造迁移成功。

当前需要特殊处理的迁移类型是：

- `20260328120000_schema_gap_backfill`：SQLite 历史补丁，在 PostgreSQL 空库中应跳过。
- `20260419123000_schema_column_backfill`：与 PostgreSQL baseline 部分重叠，失败记录可标记回滚后交给幂等 SQL 和后续迁移保证结构。
- `20260422190000_style_extraction_task`：历史重复建表迁移，失败记录可标记回滚后由幂等 SQL 继续收敛。

### 后台 worker 的启动窗口

Compose 重启或数据库容器恢复时，API 可能先启动后台 worker，再遇到 PostgreSQL 短暂不可达。RAG worker 取队列或重排中断任务时遇到这类基础设施异常，应跳过本轮并等待下一次轮询，不能让未处理 Promise 影响 API 进程。

任务执行内部的业务失败仍应按 RAG 任务自己的 `attempts`、`runAfter`、`lastError` 和最大重试次数记录；只有 worker 级别的队列获取、启动重排和状态更新基础设施异常，才属于可等待下一轮的启动窗口问题。

### Volumes 是用户数据边界

Compose volume 中的数据应视为用户数据，包括：

- PostgreSQL 数据库
- Qdrant 向量库
- 生成图片和导出资产

文档和脚本可以推荐 `docker compose down` 停止服务，但不得把 `docker compose down -v` 作为常规清理命令，因为 `-v` 会删除 volume 数据。

## Examples

推荐访问方式：

```text
http://localhost:8080/settings
http://localhost:8080/api/health
```

Compose 内部连接：

```text
DATABASE_URL=postgresql://ai_novel:...@postgres:5432/ai_novel
QDRANT_URL=http://qdrant:6333
IMAGE_STORAGE_ROOT=/app/storage/generated-images
```

不推荐在 Docker 默认前端中使用：

```text
VITE_API_BASE_URL=http://localhost:3000/api
```

这会在局域网访问、远程机器访问或 Web 只暴露 8080 时破坏 API 请求。

## Failure Modes

### 前端可打开但 API 全部失败

优先检查 Web nginx 是否把 `/api` 正确反代到 `api:3000`，再检查 API 容器日志和数据库 healthcheck。

### API 容器反复重启

优先检查：

- `DATABASE_URL` 是否指向 Compose 服务名 `postgres`。
- PostgreSQL 是否 healthy。
- `prisma migrate deploy` 是否失败。
- 环境变量是否遗漏生产必需项。

### 知识库不可用

优先检查：

- `RAG_ENABLED` 是否为预期值。
- `QDRANT_URL` 是否为 `http://qdrant:6333`。
- Qdrant volume 是否正常挂载。
- Embedding provider 和 API key 是否在页面或环境变量中配置完成。

### 数据丢失

优先确认是否执行过 `docker compose down -v`、手动删除 volume、或更换了 Compose project name。此类操作属于数据边界变更，不能作为普通故障恢复步骤。

## Related Modules

- `Dockerfile.api`
- `Dockerfile.web`
- `infra/nginx/`
- `server/src/config/database.ts`
- `server/src/prisma/schema.prisma`
- `server/src/prisma/migrations/`
- `client/src/lib/constants.ts`
- `client/src/api/client.ts`

## Source Documents

- `docs/plans/docker-compose-runtime-plan.md`
- `server/.env.example`
- `infra/docker-compose.qdrant.yml`
