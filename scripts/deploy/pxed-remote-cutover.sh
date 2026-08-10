#!/usr/bin/env bash
# pxed 远端 cutover（由 GitHub Actions 经 SSH 调用）。
# 对齐 vault [[pxed ai-novel 部署与运维]] §八：备份 → git tip → 解包 dist → prisma generate → 单次 restart → health。
#
# 环境变量（必填）：
#   DEPLOY_SHA          目标 git sha（完整或 short）
#   DEPLOY_COMPONENTS   server | server-client | all
#   SERVER_TGZ          已 scp 的 server dist 包路径
# 可选：
#   CLIENT_TGZ          client dist 包（server-client|all 必填）
#   SHARED_TGZ          shared dist 包（始终建议传）
#   APP_DIR             默认 /personal/pxed/ai-novel
#   SUPERVISOR_CONF     默认 /personal/pxed/supervisord.conf
#   SNAPSHOT_ROOT       默认 /data/ainovel/db-snapshots
#   SNAPSHOT_RETENTION_COUNT  保留的 pre-* 快照数（默认 10；仅部署成功后自清超龄，失败不动）
#   SKIP_GIT_RESET=1    跳过 git reset（仅 overlay dist；不推荐）
#   ALLOW_LOCKFILE_DRIFT=1  允许 pnpm-lock 相对 prev tip 变更而不失败（默认失败，需人工 install）
#   RUN_PNPM_INSTALL=1  lockfile 变更时尝试 pnpm install --frozen-lockfile（慢）
set -euo pipefail

APP_DIR="${APP_DIR:-/personal/pxed/ai-novel}"
SUPERVISOR_CONF="${SUPERVISOR_CONF:-/personal/pxed/supervisord.conf}"
SNAPSHOT_ROOT="${SNAPSHOT_ROOT:-/data/ainovel/db-snapshots}"
SNAPSHOT_RETENTION_COUNT="${SNAPSHOT_RETENTION_COUNT:-10}"
DEPLOY_SHA="${DEPLOY_SHA:?DEPLOY_SHA required}"
DEPLOY_COMPONENTS="${DEPLOY_COMPONENTS:-server}"
SERVER_TGZ="${SERVER_TGZ:?SERVER_TGZ required}"
CLIENT_TGZ="${CLIENT_TGZ:-}"
SHARED_TGZ="${SHARED_TGZ:-}"
SKIP_GIT_RESET="${SKIP_GIT_RESET:-0}"
ALLOW_LOCKFILE_DRIFT="${ALLOW_LOCKFILE_DRIFT:-0}"
RUN_PNPM_INSTALL="${RUN_PNPM_INSTALL:-0}"
# 允许在活跃 auto_director 任务时强行 restart（默认拒绝，防止打断在途章节生成）
ALLOW_RESTART_WITH_ACTIVE_DIRECTOR="${ALLOW_RESTART_WITH_ACTIVE_DIRECTOR:-0}"

[[ "$SNAPSHOT_RETENTION_COUNT" =~ ^[0-9]+$ ]] && (( SNAPSHOT_RETENTION_COUNT >= 1 )) \
  || die "SNAPSHOT_RETENTION_COUNT must be a positive integer, got '$SNAPSHOT_RETENTION_COUNT'"

log() { printf '[pxed-cutover] %s\n' "$*"; }
die() { printf '[pxed-cutover] ERROR: %s\n' "$*" >&2; exit 1; }

need_file() {
  [[ -f "$1" ]] || die "missing file: $1"
}

need_cmd() {
  command -v "$1" >/dev/null 2>&1 || die "missing command: $1"
}

# 只清超龄 pre-* 快照目录（保留最近 $keep 个），不动 auto/ 与顶层手动还原点
prune_old_snapshots() {
  local keep="$1"
  local snaps=()
  local d
  # ls -dt 按 mtime 降序（新→旧）；pre-* 目录名无空格，可安全按行切
  local IFS=$'\n'
  shopt -s nullglob
  for d in $(ls -dt "$SNAPSHOT_ROOT"/pre-*/ 2>/dev/null); do
    [[ -d "$d" ]] && snaps+=("$d")
  done
  shopt -u nullglob
  local total="${#snaps[@]}"
  if (( total <= keep )); then
    log "snapshot retention: keep $total (<= $keep), nothing to prune"
    return 0
  fi
  local i removed=0
  for (( i=keep; i<total; i++ )); do
    d="${snaps[$i]}"
    rm -rf -- "$d"
    removed=$(( removed + 1 ))
  done
  log "snapshot retention: pruned $removed pre-* dirs (kept $keep of $total)"
}

# 避免 curl|head SIGPIPE（pipefail 下 exit 141）假失败
http_get() {
  # usage: http_get URL [out_file]
  local url="$1"
  local out="${2:-}"
  if [[ -n "$out" ]]; then
    curl --noproxy '*' -fsS --max-time 20 -o "$out" "$url"
  else
    curl --noproxy '*' -fsS --max-time 20 -o /tmp/pxed-cutover-http.out "$url"
    cat /tmp/pxed-cutover-http.out
  fi
}

assert_health_json() {
  local file="$1"
  local label="$2"
  [[ -s "$file" ]] || die "$label empty body"
  # 期望 {"success":true,...}；无 jq 时用 grep
  if command -v jq >/dev/null 2>&1; then
    local ok
    ok="$(jq -r '.success // empty' "$file" 2>/dev/null || true)"
    [[ "$ok" == "true" ]] || die "$label JSON success!=true body=$(head -c 200 "$file")"
  else
    grep -q '"success"[[:space:]]*:[[:space:]]*true' "$file" \
      || die "$label missing success:true body=$(head -c 200 "$file")"
  fi
  head -c 400 "$file"
  echo
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
# supervisorctl: "novel-server  RUNNING   pid 2735119, uptime ..."
PREV_STATUS="$(supervisorctl -c "$SUPERVISOR_CONF" status novel-server 2>/dev/null || true)"
PREV_PID="$(printf '%s' "$PREV_STATUS" | sed -n 's/.*pid \([0-9][0-9]*\).*/\1/p' | head -1)"
PREV_LOCK_HASH=""
if [[ -f "$APP_DIR/pnpm-lock.yaml" ]]; then
  PREV_LOCK_HASH="$(md5sum "$APP_DIR/pnpm-lock.yaml" | awk '{print $1}')"
fi

{
  echo "prev_tip=$PREV_TIP"
  echo "deploy_sha=$DEPLOY_SHA"
  echo "components=$DEPLOY_COMPONENTS"
  echo "pid_before=${PREV_PID:-unknown}"
  echo "status_before=$PREV_STATUS"
  echo "ts=$TS"
  echo "db_snapshot=best_effort_live_copy"
  echo "server_tgz=$(basename "$SERVER_TGZ")"
  echo "server_md5=$(md5sum "$SERVER_TGZ" | awk '{print $1}')"
  [[ -n "$CLIENT_TGZ" ]] && echo "client_tgz=$(basename "$CLIENT_TGZ")" && echo "client_md5=$(md5sum "$CLIENT_TGZ" | awk '{print $1}')"
  [[ -n "$SHARED_TGZ" ]] && echo "shared_tgz=$(basename "$SHARED_TGZ")" && echo "shared_md5=$(md5sum "$SHARED_TGZ" | awk '{print $1}')"
  echo "prev_lock_md5=${PREV_LOCK_HASH:-none}"
} >"$SNAP_DIR/META"

log "snapshot → $SNAP_DIR"
# DB：热拷 best-effort（服务可能仍在写）。优先 sqlite .backup 若可用。
if [[ -f "$SERVER_DIR/dev.db" ]] && command -v sqlite3 >/dev/null 2>&1; then
  if sqlite3 "$SERVER_DIR/dev.db" ".backup '$SNAP_DIR/db/dev.db'" 2>/dev/null; then
    # .backup 已合并进 dev.db；gzip 压缩（约 330M → 80M），恢复时 gunzip
    echo "db_snapshot=sqlite3_backup" >>"$SNAP_DIR/META"
    if gzip -f "$SNAP_DIR/db/dev.db" 2>/dev/null; then
      echo "db_snapshot_gzip=1" >>"$SNAP_DIR/META"
      log "db snapshot via sqlite3 .backup + gzip"
    else
      log "warn: gzip failed; snapshot dev.db left uncompressed"
    fi
  else
    # 只拷 dev.db + wal/shm，别 cp -a dev.db* 把 live 目录陈旧 .bak 拖进快照
    cp -a "$SERVER_DIR/dev.db" "$SNAP_DIR/db/dev.db" 2>/dev/null || true
    cp -a "$SERVER_DIR/dev.db-wal" "$SERVER_DIR/dev.db-shm" "$SNAP_DIR/db/" 2>/dev/null || true
    gzip -f "$SNAP_DIR/db/dev.db" 2>/dev/null || true
    echo "db_snapshot=best_effort_live_copy" >>"$SNAP_DIR/META"
    log "warn: sqlite3 .backup failed; fell back to cp dev.db + wal/shm + gzip"
  fi
elif compgen -G "$SERVER_DIR/dev.db" >/dev/null; then
  cp -a "$SERVER_DIR/dev.db" "$SNAP_DIR/db/dev.db" || true
  cp -a "$SERVER_DIR/dev.db-wal" "$SERVER_DIR/dev.db-shm" "$SNAP_DIR/db/" 2>/dev/null || true
  gzip -f "$SNAP_DIR/db/dev.db" 2>/dev/null || true
  log "db snapshot via cp dev.db + wal/shm (no sqlite3)"
else
  log "warn: no server/dev.db found (still continue)"
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
  git fetch origin --prune
  if git cat-file -e "${DEPLOY_SHA}^{commit}" 2>/dev/null; then
    git reset --hard "$DEPLOY_SHA"
  else
    git fetch origin "+refs/heads/main:refs/remotes/origin/main" || true
    git fetch origin "$DEPLOY_SHA" || true
    git cat-file -e "${DEPLOY_SHA}^{commit}" 2>/dev/null || die "cannot resolve DEPLOY_SHA=$DEPLOY_SHA on pxed"
    git reset --hard "$DEPLOY_SHA"
  fi
  git rev-parse --short HEAD
else
  log "SKIP_GIT_RESET=1 — source tip not updated"
fi

# lockfile 漂移门：源 tip 变了但 node_modules 未装 → 易 runtime/generate 炸
NEW_LOCK_HASH=""
if [[ -f "$APP_DIR/pnpm-lock.yaml" ]]; then
  NEW_LOCK_HASH="$(md5sum "$APP_DIR/pnpm-lock.yaml" | awk '{print $1}')"
fi
echo "new_lock_md5=${NEW_LOCK_HASH:-none}" >>"$SNAP_DIR/META"
if [[ -n "$PREV_LOCK_HASH" && -n "$NEW_LOCK_HASH" && "$PREV_LOCK_HASH" != "$NEW_LOCK_HASH" ]]; then
  log "pnpm-lock.yaml changed ($PREV_LOCK_HASH → $NEW_LOCK_HASH)"
  if [[ "$RUN_PNPM_INSTALL" == "1" ]]; then
    log "RUN_PNPM_INSTALL=1 → pnpm install --frozen-lockfile"
    (
      cd "$APP_DIR"
      if command -v pnpm >/dev/null 2>&1; then
        pnpm install --frozen-lockfile
      else
        die "pnpm missing; cannot install after lockfile change"
      fi
    )
  elif [[ "$ALLOW_LOCKFILE_DRIFT" == "1" ]]; then
    log "warn: ALLOW_LOCKFILE_DRIFT=1 — continuing without install"
  else
    die "pnpm-lock.yaml changed vs prev tip. Refusing auto cutover. Options: (1) on pxed run pnpm install --frozen-lockfile then re-tag, (2) re-run with RUN_PNPM_INSTALL=1, (3) ALLOW_LOCKFILE_DRIFT=1 (危险)."
  fi
fi

# 原子解包：解到临时目录 → 校验 → rename 切换；失败绝不碰旧 dist
# （禁止 tar 直接解到 live dist：半截/合并残留旧文件都会坏生产）
unpack_dist() {
  local tgz="$1"
  local dest_parent="$2"
  local label="$3"
  local marker="${4:-}"
  need_file "$tgz"
  [[ -d "$dest_parent" ]] || die "dest parent missing for $label: $dest_parent"

  local stage next prev
  stage="${dest_parent}/.unpack-stage.$$"
  next="${dest_parent}/dist.next.$$"
  prev="${dest_parent}/dist.prev.$$"
  rm -rf "$stage" "$next" "$prev"
  mkdir -p "$stage"

  # 包内顶层是 dist/（workflow: tar -C <pkg> dist）
  if ! tar xzf "$tgz" -C "$stage"; then
    rm -rf "$stage"
    die "$label tar extract failed (live dist untouched)"
  fi
  if [[ ! -d "${stage}/dist" ]]; then
    rm -rf "$stage"
    die "$label tar did not contain top-level dist/ (live dist untouched)"
  fi
  mv "${stage}/dist" "$next"
  rm -rf "$stage"
  find "$next" -name '._*' -delete 2>/dev/null || true

  if [[ -n "$marker" ]]; then
    if [[ ! -e "$next/$marker" ]]; then
      rm -rf "$next"
      die "$label missing marker after unpack: $marker (live dist untouched)"
    fi
  fi
  local count
  count="$(find "$next" -type f | wc -l | tr -d ' ')"
  if [[ "$count" -le 0 ]]; then
    rm -rf "$next"
    die "$label dist.next has 0 files (live dist untouched)"
  fi

  # 切换窗口尽量短：旧 dist → prev，next → dist，再删 prev
  if [[ -d "${dest_parent}/dist" ]]; then
    mv "${dest_parent}/dist" "$prev"
  fi
  if ! mv "$next" "${dest_parent}/dist"; then
    # 尝试把旧 dist 挪回来
    if [[ -d "$prev" ]]; then
      mv "$prev" "${dest_parent}/dist" || true
    fi
    rm -rf "$next"
    die "$label failed to promote dist.next → dist"
  fi
  rm -rf "$prev"
  log "unpacked $label → ${dest_parent}/dist (files=$count)"
}

log "unpack server dist"
unpack_dist "$SERVER_TGZ" "$SERVER_DIR" "server" "app.js"

if [[ -n "$SHARED_TGZ" ]]; then
  log "unpack shared dist"
  # shared 入口因包而异；至少保证非空 + 常见 index
  unpack_dist "$SHARED_TGZ" "$APP_DIR/shared" "shared" ""
  if [[ ! -e "$APP_DIR/shared/dist/index.js" && ! -e "$APP_DIR/shared/dist/index.mjs" ]]; then
    log "warn: shared/dist has no index.js|mjs (continue if package layout differs)"
  fi
fi

if [[ "$DEPLOY_COMPONENTS" == "server-client" || "$DEPLOY_COMPONENTS" == "all" ]]; then
  log "unpack client dist"
  unpack_dist "$CLIENT_TGZ" "$APP_DIR/client" "client" "index.html"
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

# dist 标记（手册 §8.1.9）：记录 app.js mtime/size + 可选字符串探针
if [[ -f "$SERVER_DIR/dist/app.js" ]]; then
  {
    echo "server_app_js_md5=$(md5sum "$SERVER_DIR/dist/app.js" | awk '{print $1}')"
    echo "server_app_js_bytes=$(wc -c <"$SERVER_DIR/dist/app.js" | tr -d ' ')"
  } >>"$SNAP_DIR/META"
  log "dist mark server/dist/app.js md5=$(md5sum "$SERVER_DIR/dist/app.js" | awk '{print $1}')"
fi

log "prisma generate"
(
  cd "$SERVER_DIR"
  if command -v pnpm >/dev/null 2>&1; then
    pnpm prisma:generate
  else
    npx prisma generate --config prisma.config.ts
  fi
)

# drain 门：若存在进行中的 auto_director 章节生成任务，restart 会 kill 在途 job，
# 流式输出丢失 → 愈合标记失败需人工续跑。默认拒绝 restart，提示 drain 窗口；
# 仅当 ALLOW_RESTART_WITH_ACTIVE_DIRECTOR=1 才强上（叠加新 dist 已就位）。
ACTIVE_DIRECTOR=0
if [[ -f "$SERVER_DIR/dev.db" ]] && command -v sqlite3 >/dev/null 2>&1; then
  ACTIVE_DIRECTOR="$(sqlite3 "$SERVER_DIR/dev.db" "SELECT COUNT(*) FROM \"NovelWorkflowTask\" WHERE lane='auto_director' AND status='running';" 2>/dev/null || echo 0)"
  ACTIVE_DIRECTOR="${ACTIVE_DIRECTOR:-0}"
fi
log "active auto_director running tasks = $ACTIVE_DIRECTOR"
if [[ "$ACTIVE_DIRECTOR" =~ ^[1-9][0-9]*$ ]]; then
  if [[ "$ALLOW_RESTART_WITH_ACTIVE_DIRECTOR" == "1" ]]; then
    log "warn: ALLOW_RESTART_WITH_ACTIVE_DIRECTOR=1 — restarting despite $ACTIVE_DIRECTOR active auto_director task(s)"
  else
    die "drain required: $ACTIVE_DIRECTOR active auto_director task(s) running. Wait for completion then re-run; or set ALLOW_RESTART_WITH_ACTIVE_DIRECTOR=1 to force (risk: in-flight chapter generation lost)."
  fi
fi

log "supervisorctl restart novel-server (once)"
supervisorctl -c "$SUPERVISOR_CONF" restart novel-server

# 冷启动等待
sleep 3
for _ in 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15; do
  if curl --noproxy '*' -fsS --max-time 5 -o /tmp/pxed-h1.json "http://127.0.0.1:3001/api/health" 2>/dev/null; then
    break
  fi
  sleep 2
done

log "health checks"
unset http_proxy https_proxy HTTP_PROXY HTTPS_PROXY ALL_PROXY all_proxy || true
supervisorctl -c "$SUPERVISOR_CONF" status novel-server

http_get "http://127.0.0.1:3001/api/health" /tmp/pxed-h-3001.json
assert_health_json /tmp/pxed-h-3001.json "health :3001"

http_get "http://127.0.0.1:3000/api/health" /tmp/pxed-h-3000.json
assert_health_json /tmp/pxed-h-3000.json "health :3000"

http_get "http://127.0.0.1:3000/api/health/ready" /tmp/pxed-h-ready.json
# ready 也可能包 success；至少非空
[[ -s /tmp/pxed-h-ready.json ]] || die "ready :3000 empty"
if grep -q '"success"' /tmp/pxed-h-ready.json; then
  assert_health_json /tmp/pxed-h-ready.json "ready :3000"
else
  head -c 400 /tmp/pxed-h-ready.json
  echo
fi

log "done sha=$(git rev-parse --short HEAD 2>/dev/null || echo "$SHORT_SHA") snap=$SNAP_DIR"
log "rollback: tar xzf $SNAP_DIR/server-dist/dist.tgz -C $SERVER_DIR  (after rm -rf dist) then supervisorctl restart novel-server"
log "rollback DB: zcat $SNAP_DIR/db/dev.db.gz > $SERVER_DIR/dev.db (best_effort 需一并放回 dev.db-wal/shm) then supervisorctl restart novel-server"
log "note: failed cutover does NOT auto-rollback; use snap above. Drain long director/TTS jobs before approving next deploy."

# 部署成功后才清超龄 pre-* 快照（set -e 下失败会在 health 前 exit，本次快照保留供回滚）
prune_old_snapshots "$SNAPSHOT_RETENTION_COUNT"
