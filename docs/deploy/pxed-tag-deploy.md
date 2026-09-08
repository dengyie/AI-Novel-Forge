# pxed 生产部署（main 自动 / tag 可选）

**策略**：推到 **`main`（PR 合入）后自动部署**；无需人工审批。  
可选 `deploy/*` tag 或 Actions 手动重放。Environment `pxed-production` 只挂 secrets 与 branch policy，**无 required reviewers**。

权威运维细节仍以 Obsidian `[[pxed ai-novel 部署与运维]]` 为准。本页描述 GitHub 侧如何触发同一套 cutover。

## 触发方式

### A. main push（默认 / 推荐）

```bash
# PR 合入 main，或本地：
git push origin main
```

- 触发 workflow **Deploy pxed**
- 默认组件：`server-client`（shared 始终随包）
- 组件覆盖：commit message 含独立词 `#server` / `#all`
- 并发：`concurrency: deploy-pxed`，不并行 cutover（排队不取消进行中的）

### B. tag（可选定点 / 回放）

```bash
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
- 覆盖：annotated tag / commit 含 `#server` / `#all`，或 tag 名后缀 `-server` / `-all`

### C. Actions 手动

GitHub → Actions → **Deploy pxed** → **Run workflow**

- `components`: `server` | `server-client` | `all`
- `ref`: 可选 sha/分支；空=当前默认分支 tip

## 门禁

| 关卡 | 行为 |
|---|---|
| main 祖先 | deploy sha 必须是 `origin/main` 的祖先（或等于 tip） |
| 测试 | workflow 内重跑 prisma generate + sqlite push + typecheck + fast tests |
| 审批 | **无** required reviewers（2026-07-26 起：main 合入直部署） |
| 并发 | `concurrency: deploy-pxed`，不并行 cutover |
| lockfile | cutover 若 `pnpm-lock.yaml` 相对 prev tip 变更 → **默认失败**（须机上 `pnpm install` 或 `RUN_PNPM_INSTALL=1` / `ALLOW_LOCKFILE_DRIFT=1`） |
| SSH host key | 有 `PXED_SSH_KNOWN_HOSTS` → `StrictHostKeyChecking=yes`；否则 TOFU `accept-new` + warning |

## 一次部署实际做什么

1. **gate**：校验 main + 测  
2. **build-artifacts**：Ubuntu 构建 `shared`/`server`（及需要时 `client`），打 `*-dist-<sha>.tgz`  
3. **deploy / Cutover pxed**（自动，无审批）：  
   - scp 包 + `scripts/deploy/pxed-remote-cutover.sh`  
   - 远端：DB+dist 快照 → `git reset --hard <sha>` → **原子解包** dist → 仅在 Prisma schema/config/依赖变更时执行 `prisma generate` → **单次** `supervisorctl restart novel-server` → 本机 health
   - runner：公网 `https://ainovel.mangoqwq.com/api/health` + ready  

**不做**：pxed 上 tsc；`NODE_ENV=production`；`git add -A`；改 `.env`/`dev.db` 进 git；自动 migrate 写生产 schema；**失败自动回滚**（只留 snap，人工按日志 rollback）。

**注意**：main 合入即部署。有运行中的导演 / TTS 长任务时，合入前先 drain，或接受 cutover 期间短暂中断。

## 一次性配置（仓库 maintainer）

### 1. Environment

GitHub 仓库 → Settings → Environments → **`pxed-production`**

- **不要**勾 Required reviewers（已去掉；合入直部署）
- Deployment branches/tags：`main` + `deploy/*`（branch policy）

### 2. Secrets

写在 **Environment `pxed-production`**（推荐）或 Repository secrets：

| Secret | 示例 / 说明 |
|---|---|
| `PXED_SSH_HOST` | **Bohrium 直连主机名**，如 `pxed1497962.bohrium.tech`（**不要**用 `ssh-pxed.mangoqwq.com`：那条链路要 Cloudflare Access / `cloudflared`，GitHub runner 走不通） |
| `PXED_SSH_USER` | `root` |
| `PXED_SSH_KEY` | 专用 deploy 私钥全文（本机 `~/.ssh/pxed_gh_actions_deploy_ed25519`；公钥已在 pxed `authorized_keys`） |
| `PXED_SSH_PORT` | 可选，默认 `22` |
| `PXED_SSH_KNOWN_HOSTS` | 建议有；有则 StrictHostKeyChecking=yes |

### 3. 仓内文件

- `.github/workflows/deploy-pxed.yml`
- `scripts/deploy/pxed-remote-cutover.sh`

## 失败与回滚

- cutover 失败会留下 `pre-<sha>-…` snap；**不**自动回滚  
- 日志见 Actions run；远端按运维手册 rollback 到 snap  
- lockfile drift：机上 install 或带 `ALLOW_LOCKFILE_DRIFT=1` 重跑（慎用）

## 历史试飞

- 首次 tag 试飞（2026-07-25）：`deploy/de5e8387c3ed` 等  
- readiness thrash/wall 栈上线：tag `deploy/f943582d51ef` → run success · tip **`f943582`**  
- 2026-07-26：去掉 required reviewers；**main push 自动部署**
