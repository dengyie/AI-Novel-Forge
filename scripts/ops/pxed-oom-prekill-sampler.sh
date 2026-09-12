#!/usr/bin/env bash
set -u

# Bounded pre-OOM sampler for pxed. It intentionally writes a small rolling log
# outside the application tree so an application failure does not erase evidence.
OUT="${PXED_OOM_SAMPLE_LOG:-/personal/pxed/oom-prekill.log}"
INTERVAL="${PXED_OOM_SAMPLE_INTERVAL:-5}"
CG="${PXED_MEMORY_CGROUP:-/sys/fs/cgroup/memory}"
SUPERVISOR_CONF="${SUPERVISOR_CONF:-/personal/pxed/supervisord.conf}"
MAX_BYTES="${PXED_OOM_SAMPLE_MAX_BYTES:-5242880}"

mkdir -p "$(dirname "$OUT")"

read_file() { [ -r "$1" ] && cat "$1" || printf '%s' '?'; }
oom_count() { awk '$1 == "oom_kill" { print $2; found=1 } END { if (!found) print "?" }' "$CG/memory.oom_control" 2>/dev/null; }
trim() {
  [ -f "$OUT" ] || return 0
  local size
  size=$(wc -c < "$OUT")
  if [ "$size" -gt "$MAX_BYTES" ]; then
    tail -c "$((MAX_BYTES / 2))" "$OUT" > "$OUT.tmp" && mv "$OUT.tmp" "$OUT"
  fi
}

while :; do
  now=$(date -Is)
  pid=$(supervisorctl -c "$SUPERVISOR_CONF" pid novel-server 2>/dev/null || printf '?')
  rss='?'; heap='?'
  if [ "$pid" != "?" ] && [ -r "/proc/$pid/status" ]; then
    rss=$(awk '$1 == "VmRSS:" { print $2 "kB" }' "/proc/$pid/status")
  fi
  if [ "$pid" != "?" ] && [ -r "/proc/$pid/environ" ]; then
    heap=$(tr '\0' '\n' < "/proc/$pid/environ" | grep '^NODE_OPTIONS=' | head -1 || true)
  fi
  printf '%s oom_kill=%s usage=%s limit=%s novel_pid=%s rss=%s node_options=%s top=%s\n' \
    "$now" "$(oom_count)" "$(read_file "$CG/memory.usage_in_bytes")" \
    "$(read_file "$CG/memory.limit_in_bytes")" "$pid" "$rss" "${heap:-unset}" \
    "$(ps -eo pid,rss,comm --sort=-rss 2>/dev/null | sed -n '2,7p' | tr '\n' ';')" >> "$OUT"
  trim
  sleep "$INTERVAL"
done
