#!/usr/bin/env bash
# pin-image-tag.sh <short_sha12> <full_sha>
# CI deploy 在 compose pull 之前调用：
#   1. 把 .env 里当前 API_IMAGE_TAG/WEB_IMAGE_TAG 备份到 .last-good-tag（若存在且非空）
#   2. 把 .env 里两行镜像 tag 更新为本次 commit 的 sha12
# 只改 tag 行，不动其它配置；幂等可重放。
set -euo pipefail

DEPLOY_DIR="$(cd "$(dirname "$0")" && pwd)"
ENV_FILE="$DEPLOY_DIR/.env"
SHORT_SHA="${1:?usage: pin-image-tag.sh <short_sha12> <full_sha>}"
FULL_SHA="${2:?usage: pin-image-tag.sh <short_sha12> <full_sha>}"

[[ -f "$ENV_FILE" ]] || { echo "pin-image-tag: $ENV_FILE missing" >&2; exit 1; }

current_api="$(grep -E '^API_IMAGE_TAG=' "$ENV_FILE" | tail -1 | cut -d= -f2- || true)"
if [[ -n "${current_api:-}" ]]; then
  printf '%s\n' "$current_api" > "$DEPLOY_DIR/.last-good-tag"
fi

update_or_append() {
  local key="$1" value="$2"
  if grep -qE "^${key}=" "$ENV_FILE"; then
    # BSD/GNU 兼容：用 awk 重写而不是 sed -i 的平台差异
    awk -v k="$key" -v v="$value" 'BEGIN{FS=OFS="="} $0 ~ "^"k"=" {$0=k"="v} {print}' \
      "$ENV_FILE" > "$ENV_FILE.tmp" && mv "$ENV_FILE.tmp" "$ENV_FILE"
  else
    printf '%s=%s\n' "$key" "$value" >> "$ENV_FILE"
  fi
}

update_or_append API_IMAGE_TAG "$SHORT_SHA"
update_or_append WEB_IMAGE_TAG "$SHORT_SHA"
chmod 600 "$ENV_FILE"

echo "pin-image-tag: pinned API_IMAGE_TAG=WEB_IMAGE_TAG=$SHORT_SHA (commit $FULL_SHA)"
grep -E '^(API_IMAGE_TAG|WEB_IMAGE_TAG)=' "$ENV_FILE"
