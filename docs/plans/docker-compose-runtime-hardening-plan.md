# Docker Compose Runtime Hardening Plan

## 背景

`70324638 Add Docker Compose runtime` 已经让项目可以通过 Docker Compose 启动 Web、API、PostgreSQL 和 Qdrant，并通过了主栈与空 PostgreSQL 数据卷的启动验证。后续自审发现几个会影响“可靠、轻量、便于移植”的细节，需要在进入 beta 前收紧。

本阶段只修 Docker Compose 运行体验和相关启动稳定性，不改变产品功能、不做数据迁移、不执行任何破坏性数据库操作。

## 修复目标

1. 让 `.env.docker` 真正成为 Docker Compose 用户可复制、可修改、可生效的配置入口。
2. 增加 `.dockerignore`，减少 build context，避免本地依赖、日志、数据库和密钥文件进入镜像构建上下文。
3. 让 nginx 反代支持 SSE/流式响应，避免自动导演、Creative Hub 或章节生成进度在 Docker 入口下被缓冲。
4. 让 RAG worker 的基础设施级异常默认可见，但避免高频刷屏。
5. 让 Web 容器等待 API healthy，减少用户一打开 `8080` 就遇到短暂 502 的概率。

## 非目标

- 不删除、重置、清理任何 Docker volume。
- 不执行 `prisma migrate reset`、`db push --force-reset`、truncate/drop table。
- 不引入新的默认外部依赖，例如 MinIO 或云服务。
- 不改变本地 `pnpm dev` 热更新开发方式。
- 不把桌面打包、发布、GitHub Release 流程并入本阶段。

## 设计决策

### 1. `.env.docker` 的生效方式

Docker Compose 的 `${VAR}` 插值发生在解析 Compose 文件时，`services.api.env_file` 只会把变量注入 API 容器，不会参与端口映射、PostgreSQL 初始化变量或 `DATABASE_URL` 拼接。

因此本阶段采用显式命令方式：

```bash
docker compose --env-file .env.docker up -d --build
```

README 必须说明：

- 不复制 `.env.docker` 时可以继续运行 `docker compose up -d --build`，使用内置默认值。
- 复制并修改 `.env.docker` 后，应使用 `--env-file .env.docker` 启动，才能让端口、数据库名、用户名、密码等 Compose 解析期变量生效。
- `docker compose down` 停止时同样建议带 `--env-file .env.docker`，确保项目解析一致。

`api.env_file` 保留，用于把模型 Key、RAG 参数、API 限制等运行时变量注入 API 容器。

### 2. `.dockerignore` 作为轻量和安全边界

新增 `.dockerignore`，排除：

- `.git/`、`.logs/`、`.tmp/`、`.codex-backups/` 等本地工具目录。
- 根目录和子包的 `node_modules/`、`dist/`、构建产物和桌面打包产物。
- `.env`、`.env.local`、`.env.docker`、`server/.env`、`client/.env` 等密钥文件。
- SQLite 数据库、临时数据库、server storage 等本地持久化数据。

必须保留 `.env.docker.example`、`.env.example`、源码、Prisma migrations、README 和 docs，因为它们是镜像构建或用户文档所需内容。

### 3. nginx 流式代理规则

后端存在 SSE 输出：`server/src/llm/streaming.ts` 和 `server/src/routes/creativeHub.ts`。Docker Web 入口反代 `/api/` 时必须禁用代理缓冲：

```nginx
proxy_buffering off;
proxy_cache off;
add_header X-Accel-Buffering "no" always;
```

同时保留较长的 `proxy_read_timeout` 和 `proxy_send_timeout`，避免长章节生成被 nginx 过早断开。

### 4. RAG worker 可观测性

RAG worker 的详细任务日志继续受 `RAG_VERBOSE_LOG` 控制，但 worker 级基础设施异常需要默认可见，因为它会导致知识库队列持续停滞。

实现规则：

- `logInfo` 仍只在 verbose 模式输出。
- `logWarn` 默认输出，但按 message 做时间窗口节流，避免数据库短暂不可达时每个 poll 周期刷屏。
- 节流窗口用常量实现，不新增环境变量，保持配置轻量。

### 5. Web 等待 API healthy

`web.depends_on.api.condition` 改为 `service_healthy`，让 Web 容器尽量在 API 健康后启动。运行时 API 仍可能重启，nginx 继续负责反代错误；该改动只优化首次启动体验。

## 修改清单

- `.dockerignore`：新增 build context 排除规则。
- `docker-compose.yml`：Web 依赖 API healthy；保留 API `env_file`。
- `infra/nginx/ai-novel-web.docker.conf`：关闭 `/api/` 代理缓冲，支持 SSE。
- `server/src/services/rag/RagWorker.ts`：调整 warning 默认输出和节流。
- `README.md`：修正 `.env.docker` 使用命令和停止命令。
- `.env.docker.example`：补充注释，说明需要 `--env-file` 参与 Compose 解析。
- `docs/wiki/architecture/docker-compose-runtime.md`：记录 env-file、dockerignore、SSE 和 worker 可观测性规则。
- `docs/releases/release-notes.md`：补充用户可见的 Docker 启动配置修复说明。

## 验证计划

1. `pnpm --filter @ai-novel/server build`。
2. `docker compose config`。
3. `docker compose --env-file .env.docker.example config`，验证模板能参与 Compose 解析。
4. `docker compose build api web`，确认 `.dockerignore` 没误排除构建所需文件。
5. `docker compose up -d api web` 或 `docker compose up -d`，确认主栈健康。
6. `curl -sS -i http://localhost:8080/api/health` 返回 200。
7. `curl -sS -I http://localhost:8080/settings` 返回 200。
8. `docker compose logs --since=2m api` 扫描无新的启动错误。
9. 如需要验证 env-file 端口，可用不会覆盖当前主栈的临时 project name 运行 `docker compose --env-file .env.docker.example config` 即可；不创建或删除用户数据 volume。

## 安全规则

- 本阶段验证不得使用 `docker compose down -v`。
- 如需要停止临时栈，只能使用 `docker compose down`，保留 volume。
- 不手动删除 PostgreSQL、Qdrant 或 app storage volume。
- 不修改已存在用户数据，只修改运行配置、文档和 worker 日志策略。
