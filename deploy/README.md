# 部署与恢复指南（google-vps 实机记录）

本目录记录 AI Novel 在生产 VPS 上的**真实**部署方式，用于「只靠 GitHub 就能从零复原整个项目 + 历史数据」。

> 线上现实与仓库根目录 `infra/`（nginx + docker-compose）**不是同一套**。生产实际用的是 **systemd + Caddy + SQLite**，以本目录为准。

## 架构一览

- **服务**：`node dist/app.js`，由 systemd 单元 `ai-novel-server.service` 托管，监听 `127.0.0.1:3000`
- **反代/HTTPS**：Caddy，`novel.mangoq.ccwu.cc → 127.0.0.1:3000`，自动签发证书
- **数据库**：SQLite，`server/dev.db`（不进 git，见下方 Release 恢复）
- **前端**：已构建的 SPA 由 server 在根路径直接托管（commit b63fa9c4 起）

## 目录内容

| 路径 | 说明 |
|---|---|
| `config/ai-novel-server.service` | systemd 单元，放到 `/etc/systemd/system/` |
| `config/Caddyfile` | Caddy 配置，放到 `/etc/caddy/Caddyfile` |
| `env/server.env` | 生产环境变量（含真实密钥），复制到 `server/.env` |

## 大文件在 GitHub Release

数据库和构建产物不进 git，作为 Release 附件（tag `vps-backup-20260710`）：

- `dev.db.gz` — 生产库快照（gunzip 后放 `server/dev.db`）
- `db-backups.tar.gz` — 历史备份（解到 `server/tmp/db-backups/`）
- `client-dist.tgz` / `server-dist.tgz` — 已构建产物（免重新编译）

## 从零恢复步骤

```bash
# 1. 拉代码
git clone https://github.com/dengyie/AI-Novel-Writing-Assistant.git
cd AI-Novel-Writing-Assistant

# 2. 环境变量
cp deploy/env/server.env server/.env

# 3. 依赖 + 构建（或直接用 Release 的 dist 产物解压）
pnpm install
pnpm build
#   或：从 Release 下载 server-dist.tgz / client-dist.tgz 解压到对应 dist/

# 4. 数据库：从 Release 下载并还原
gh release download vps-backup-20260710 -p "dev.db.gz"
gunzip -c dev.db.gz > server/dev.db
#   历史备份（可选）
gh release download vps-backup-20260710 -p "db-backups.tar.gz"
mkdir -p server/tmp/db-backups && tar xzf db-backups.tar.gz -C server/tmp/

# 5. 反代 + 服务
sudo cp deploy/config/Caddyfile /etc/caddy/Caddyfile && sudo systemctl reload caddy
sudo cp deploy/config/ai-novel-server.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now ai-novel-server.service

# 6. 验证
curl -s http://127.0.0.1:3000/api/health
```

## 注意事项

- **Node 版本**：见根目录 `.nvmrc`。
- **内存**：VPS 约 1GB，构建时注意 OOM，可优先用 Release 里的预构建产物。
- **service 里的绝对路径**：`WorkingDirectory` 指向 `/home/mango/AI-Novel-Writing-Assistant/server`，换部署路径需同步改。
- **密钥轮换**：`env/server.env` 含真实 key，泄露时请到各 provider 后台吊销重签。
- **src/dist 曾不同步**：历史上出现过 `server/src/app.ts` 落后于运行中的 `dist`（缺 SPA 托管代码）。若在机器上重新 `pnpm build`，务必确认源码是 main 最新版，否则前端会 404。
