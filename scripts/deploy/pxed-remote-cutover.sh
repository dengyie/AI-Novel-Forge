#!/usr/bin/env bash
# pxed 远端 cutover（由 GitHub Actions 经 SSH 调用）。
# 对齐 vault [[pxed ai-novel 部署与运维]] §八：备份 → git tip → 解包 dist → prisma generate → 单次 restart → health。
#
# 环境变量（必填）：
#   DEPLOY_SHA          目标 git sha（完整或 short）
#   DEPLOY_COMPONENTS   server | server-client | all（all=server+client+shared 强制）
#   SERVER_TGZ          本机已 scp 的 server dist 包路径
# 可选：
#   CLIENT_TGZ          client dist 包
#   SHARED_TGZ          shared dist 包
#   APP_DIR             默认 /personal/pxed/ai-novel
#   SUPERVISOR_CONF     默认 /personal/pxed/supervisord.conf
#   SNAPSHOT_ROOT       默认 /data/ainovel/db-snapshots
#   SKIP_GIT_RESET=1    跳过 git reset（仅 overlay dist；不推荐）
set -euo pipefail

APP_DIR="${APP_DIR:-/personal/pxed/ai-novel}"
SUPERVISOR_CONF="${SUPERVISOR_CONF:-/personal/pxed/supervisord.conf}"
SNAPSHOT_ROOT="${SNAPSHOT_ROOT:-/data/ainovel/db-snapshots}"
DEPLOY_SHA="${DEPLOY_SHA:?DEPLOY_SHA required}"
DEPLOY_COMPONENTS="${DEPLOY_COMPONENTS:-server}"
SERVER_TGZ="${SERVER_TGZ:?SERVER_TGZ required}"
CLIENT_TGZ="${CLIENT_TGZ:-}"
SHARED_TGZ="${SHARED_TGZ:-}"
SKIP_GIT_RESET="${SKIP_GIT_RESET:-0}"

log() { printf '[pxed-cutover] %s\n' "$*"; }
die() { printf '[pxed-cutover] ERROR: %s\n' "$*" >&2; exit 1; }

need_file() {
  [[ -f "$1" ]] || die "missing file: $1"
}

need_cmd() {
  command -v "$1" >/dev/null 2>&1 || die "missing command: $1"
}

need_cmd tar
need_cmd git
need_cmd curl
need_cmd supervisorctl
need_cmd md5sum
need_cmd date
need_cmd find

need_file "$SERVER_TGZ"
case "$DEPLOY_COMPONENTS" in
  server) ;;
  server-client|all)
    [[ -n "$CLIENT_TGZ" ]] || die "CLIENT_TGZ required for components=$DEPLOY_COMPONENTS"
    need_file "$CLIENT_TGZ"
    ;;
  *)
    die "unknown DEPLOY_COMPONENTS=$DEPLOY_COMPONENTS (server|server-client|all)"
    ;;
esac

[[ -d "$APP_DIR" ]] || die "APP_DIR not found: $APP_DIR"
[[ -f "$SUPERVISOR_CONF" ]] || die "SUPERVISOR_CONF not found: $SUPERVISOR_CONF"

# 禁止在生产设 NODE_ENV=production（手册铁律）
if [[ "${NODE_ENV:-}" == "production" ]]; then
  die "NODE_ENV=production is forbidden on pxed; unset it in the deploy environment"
fi
unset NODE_ENV || true

cd "$APP_DIR"
SERVER_DIR="$APP_DIR/server"
[[ -d "$SERVER_DIR" ]] || die "server dir missing: $SERVER_DIR"

TS="$(date -u +%Y%m%dT%H%M%SZ)"
SHORT_SHA="$(printf '%s' "$DEPLOY_SHA" | cut -c1-12)"
SNAP_DIR="$SNAPSHOT_ROOT/pre-${SHORT_SHA}-${TS}"
mkdir -p "$SNAP_DIR/db" "$SNAP_DIR/server-dist" "$SNAP_DIR/client-dist" "$SNAP_DIR/shared-dist"

PREV_TIP="$(git rev-parse HEAD 2>/dev/null || echo unknown)"
PREV_PID="$(supervisorctl -c "$SUPERVISOR_CONF" status novel-server 2>/dev/null | awk '{print $4}' | tr -d ',' || true)"
{
  echo "prev_tip=$PREV_TIP"
  echo "deploy_sha=$DEPLOY_SHA"
  echo "components=$DEPLOY_COMPONENTS"
  echo "pid_before=$PREV_PID"
  echo "ts=$TS"
  echo "server_tgz=$(basename "$SERVER_TGZ")"
  echo "server_md5=$(md5sum "$SERVER_TGZ" | awk '{print $1}')"
  [[ -n "$CLIENT_TGZ" ]] && echo "client_tgz=$(basename "$CLIENT_TGZ")" && echo "client_md5=$(md5sum "$CLIENT_TGZ" | awk '{print $1}')"
  [[ -n "$SHARED_TGZ" ]] && echo "shared_tgz=$(basename "$SHARED_TGZ")" && echo "shared_md5=$(md5sum "$SHARED_TGZ" | awk '{print $1}')"
} >"$SNAP_DIR/META"

log "snapshot → $SNAP_DIR"
# DB（含 wal/shm）
if compgen -G "$SERVER_DIR/dev.db*" >/dev/null; then
  cp -a "$SERVER_DIR"/dev.db* "$SNAP_DIR/db/" || true
else
  log "warn: no server/dev.db* found (still continue)"
fi
if [[ -d "$SERVER_DIR/dist" ]]; then
  tar czf "$SNAP_DIR/server-dist/dist.tgz" -C "$SERVER_DIR" dist
fi
if [[ -d "$APP_DIR/client/dist" ]]; then
  tar czf "$SNAP_DIR/client-dist/dist.tgz" -C "$APP_DIR/client" dist
fi
if [[ -d "$APP_DIR/shared/dist" ]]; then
  tar czf "$SNAP_DIR/shared-dist/dist.tgz" -C "$APP_DIR/shared" dist
fi

if [[ "$SKIP_GIT_RESET" != "1" ]]; then
  log "git fetch + reset --hard $DEPLOY_SHA"
  # 机上 deploy key 只读 origin；允许按 sha 对齐 tip
  git fetch origin --prune
  if git cat-file -e "${DEPLOY_SHA}^{commit}" 2>/dev/null; then
    git reset --hard "$DEPLOY_SHA"
  elif git rev-parse --verify "origin/main" >/dev/null 2>&1; then
    # tag 推送后 fetch 可能只要再拉一次
    git fetch origin "+refs/heads/main:refs/remotes/origin/main" || true
    git fetch origin "$DEPLOY_SHA" || true
    git cat-file -e "${DEPLOY_SHA}^{commit}" 2>/dev/null || die "cannot resolve DEPLOY_SHA=$DEPLOY_SHA on pxed"
    git reset --hard "$DEPLOY_SHA"
  else
    die "git cannot resolve $DEPLOY_SHA"
  fi
  git rev-parse --short HEAD
else
  log "SKIP_GIT_RESET=1 — source tip not updated"
fi

unpack_dist() {
  local tgz="$1"
  local dest_parent="$2"
  local label="$3"
  need_file "$tgz"
  [[ -d "$dest_parent" ]] || die "dest parent missing for $label: $dest_parent"
  # 只覆 dist/，不动 storage/tmp 等
  rm -rf "${dest_parent}/dist"
  mkdir -p "${dest_parent}/dist"
  tar xzf "$tgz" -C "${dest_parent}"
  find "${dest_parent}/dist" -name '._*' -delete 2>/dev/null || true
  [[ -d "${dest_parent}/dist" ]] || die "$label dist missing after unpack"
  log "unpacked $label → ${dest_parent}/dist"
}

log "unpack server dist"
unpack_dist "$SERVER_TGZ" "$SERVER_DIR" "server"

if [[ -n "$SHARED_TGZ" ]]; then
  log "unpack shared dist"
  unpack_dist "$SHARED_TGZ" "$APP_DIR/shared" "shared"
fi

if [[ "$DEPLOY_COMPONENTS" == "server-client" || "$DEPLOY_COMPONENTS" == "all" ]]; then
  log "unpack client dist"
  unpack_dist "$CLIENT_TGZ" "$APP_DIR/client" "client"
fi

# symlink 纪律（手册 §8.3）
for link in storage tmp; do
  target="$SERVER_DIR/$link"
  if [[ -L "$target" ]]; then
    log "ok symlink server/$link → $(readlink "$target")"
  elif [[ -e "$target" ]]; then
    log "warn: server/$link exists but is not a symlink"
  else
    die "server/$link missing after unpack (expected symlink)"
  fi
done

log "prisma generate"
(
  cd "$SERVER_DIR"
  # 不 export NODE_ENV=production
  if command -v pnpm >/dev/null 2>&1; then
    pnpm prisma:generate
  else
    npx prisma generate --config prisma.config.ts
  fi
)

log "supervisorctl restart novel-server (once)"
supervisorctl -c "$SUPERVISOR_CONF" restart novel-server

# 冷启动：给 node 一点时间 LISTEN
sleep 3
for i in 1 2 3 4 5 6 7 8 9 10; do
  if curl --noproxy '*' -fsS "http://127.0.0.1:3001/api/health" >/dev/null 2>&1; then
    break
  fi
  sleep 2
done

log "health checks"
unset http_proxy https_proxy HTTP_PROXY HTTPS_PROXY ALL_PROXY all_proxy || true
supervisorctl -c "$SUPERVISOR_CONF" status novel-server
curl --noproxy '*' -fsS "http://127.0.0.1:3001/api/health" | head -c 500 || die "health :3001 failed"
echo
curl --noproxy '*' -fsS "http://127.0.0.1:3000/api/health" | head -c 500 || die "health :3000 failed"
echo
curl --noproxy '*' -fsS "http://127.0.0.1:3000/api/health/ready" | head -c 500 || die "ready :3000 failed"
echo

log "done sha=$(git rev-parse --short HEAD 2>/dev/null || echo "$SHORT_SHA") snap=$SNAP_DIR"
log "rollback hint: restore $SNAP_DIR/server-dist/dist.tgz → server/dist (+ optional db) then supervisorctl restart novel-server"
