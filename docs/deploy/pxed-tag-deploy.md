# pxed 生产部署（tag + 审批）

**策略**：CI 自动测 + **人工/审批**触发部署；**禁止** main 每次 push 裸 auto-deploy。

权威运维步骤仍以 Obsidian `[[pxed ai-novel 部署与运维]]` §八为准。本页只描述 GitHub 侧怎么触发同一套 cutover。

## 触发方式

### A. tag（推荐）

```bash
# 工作区干净、已 push 到 main 且 CI Server Test 绿
git fetch origin
git checkout main
git pull --ff-only origin main
SHA=$(git rev-parse --short=12 HEAD)

git tag "deploy/${SHA}"
git push origin "deploy/${SHA}"
```

- tag 模式：`deploy/**`（例如 `deploy/13b0f16abcde`）
- 与 desktop 的 `v*` / `desktop-v*` **不冲突**
- 默认组件：`server-client`  
  - commit message 含 `#server` → 只 server  
  - 含 `#all` → server+client+shared（与 server-client 相同，shared 始终随 server 打包）

### B. Actions 手动

GitHub → Actions → **Deploy pxed** → **Run workflow**

- `components`: `server` | `server-client` | `all`
- `ref`: 可选 sha/分支；空=当前默认分支 tip

## 门禁

| 关卡 | 行为 |
|---|---|
| main 祖先 | deploy sha 必须是 `origin/main` 的祖先（或等于 tip） |
| 测试 | workflow 内重跑 prisma generate + sqlite push + typecheck + fast tests |
| 审批 | Environment **`pxed-production`** required reviewers（你点 Approve 后才 SSH） |
| 并发 | `concurrency: deploy-pxed`，不并行 cutover |

## 一次部署实际做什么

1. **gate**：校验 main + 测  
2. **build-artifacts**：Ubuntu 构建 `shared`/`server`（及需要时 `client`），打 `*-dist-<sha>.tgz`  
3. **deploy**（需审批）：  
   - scp 包 + `scripts/deploy/pxed-remote-cutover.sh`  
   - 远端：DB+dist 快照 → `git reset --hard <sha>` → 解包 dist → `prisma generate` → **单次** `supervisorctl restart novel-server` → 本机 health  
   - runner：公网 `https://ainovel.mangoqwq.com/api/health` + ready  

**不做**：pxed 上 tsc；`NODE_ENV=production`；`git add -A`；改 `.env`/`dev.db` 进 git；自动 migrate 写生产 schema（schema 变更仍须人工评估）。

## 一次性配置（仓库 maintainer）

### 1. Environment

GitHub 仓库 → Settings → Environments → 新建 **`pxed-production`**

- Required reviewers：你自己（或运维）
- 可选：Wait timer  
- Deployment branches：限制 `main` + tags `deploy/*`（若 UI 支持）

### 2. Secrets

写在 **Environment `pxed-production`**（推荐）或 Repository secrets：

| Secret | 示例 / 说明 |
|---|---|
| `PXED_SSH_HOST` | **Bohrium 直连主机名**，如 `pxed1497962.bohrium.tech`（**不要**用 `ssh-pxed.mangoqwq.com`：那条链路要 Cloudflare Access / `cloudflared`，GitHub runner 走不通） |
| `PXED_SSH_USER` | `root` |
| `PXED_SSH_KEY` | 专用 deploy 私钥全文（本机 `~/.ssh/pxed_gh_actions_deploy_ed25519`；公钥已在 pxed `authorized_keys`） |
| `PXED_SSH_PORT` | 可选，默认 `22` |
| `PXED_SSH_KNOWN_HOSTS` | 对该 **直连 host** 的 `ssh-keyscan` 结果（建议钉死） |

> **主机名会变**：Bohrium 容器重建后 `pxedNNNN.bohrium.tech` 可能换名/换 IP。重建后更新 `PXED_SSH_HOST` + `PXED_SSH_KNOWN_HOSTS`，并确认公钥仍在 `authorized_keys`。日常人肉运维仍用 `ssh pxed`（CF Access）。

生成专用 key 示例：

```bash
ssh-keygen -t ed25519 -f ~/.ssh/pxed_gh_actions_deploy_ed25519 -C "github-actions-pxed-deploy" -N ""
# 公钥写入 pxed authorized_keys（经 ssh pxed）
# 私钥 → secret PXED_SSH_KEY
HOST=pxed1497962.bohrium.tech   # 以机上/控制台当前直连名为准
ssh-keyscan -t ed25519,ecdsa,rsa "$HOST" > /tmp/pxed_kh
# /tmp/pxed_kh → PXED_SSH_KNOWN_HOSTS
# PXED_SSH_HOST=$HOST
```

### 3. pxed 机上前提

- `/personal/pxed/ai-novel` 可 `git fetch`（已有只读 deploy key `github_ai_novel_deploy`）
- `supervisord` 管理 `novel-server`
- runner 所用 SSH 账号能：读 DB、写 `server/dist`、跑 `pnpm prisma:generate`、`supervisorctl restart`

## 回滚

远端脚本会在 `/data/ainovel/db-snapshots/pre-<sha>-<ts>/` 留下：

- `db/dev.db*`
- `server-dist/dist.tgz`（及可能的 client/shared）
- `META`

人工回滚（pxed）：

```bash
SNAP=/data/ainovel/db-snapshots/pre-...   # 选对目录
APP=/personal/pxed/ai-novel
rm -rf "$APP/server/dist"
tar xzf "$SNAP/server-dist/dist.tgz" -C "$APP/server"
# 如需：恢复 db
# cp -a "$SNAP/db"/dev.db* "$APP/server/"
supervisorctl -c /personal/pxed/supervisord.conf restart novel-server
```

## 与「只测不部署」的关系

| Workflow | 触发 | 作用 |
|---|---|---|
| `Server Test` | push/PR main（路径过滤） | 只测 |
| `Deploy pxed` | `deploy/**` tag 或手动 | 测 + 审批 + 上生产 |

日常开发：push main → 只看 Server Test。  
要上生产：打 `deploy/<sha>` tag → 审批 → cutover。

## 首次验收清单

- [ ] Environment `pxed-production` + reviewer  
- [ ] 5 个 secrets 配齐  
- [ ] 用无害 tip 打 `deploy/<sha>`，审批通过  
- [ ] Actions 日志出现 snapshot 路径、health 200  
- [ ] 公网 health/ready OK  
- [ ] 更新 vault 手册 tip / cutover 记录（仍建议人工写附录 B）  
