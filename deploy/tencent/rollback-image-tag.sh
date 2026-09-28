#!/usr/bin/env bash
# rollback-image-tag.sh
# CI 健康检查失败后调用：把 .env 里 API_IMAGE_TAG/WEB_IMAGE_TAG 回滚到
# .last-good-tag 里记录的上一个健康 tag，然后由调用方执行 docker compose up -d。
# 幂等：没有 .last-good-tag 或内容为空时不动 .env，只提示人工介入。
set -euo pipefail

DEPLOY_DIR="$(cd "$(dirname "$0")" && pwd)"
ENV_FILE="$DEPLOY_DIR/.env"
LAST_GOOD="$DEPLOY_DIR/.last-good-tag"

if [[ ! -f "$LAST_GOOD" ]]; then
  echo "rollback-image-tag: no .last-good-tag record; skipping auto-rollback" >&2
  exit 1
fi

LAST_TAG="$(head -1 "$LAST_GOOD" | tr -d '[:space:]')"
if [[ -z "$LAST_TAG" ]]; then
  echo "rollback-image-tag: .last-good-tag empty; refusing to guess" >&2
  exit 1
fi

update_or_append() {
  local key="$1" value="$2"
  if grep -qE "^${key}=" "$ENV_FILE"; then
    awk -v k="$key" -v v="$value" 'BEGIN{FS=OFS="="} $0 ~ "^"k"=" {$0=k"="v} {print}' \
      "$ENV_FILE" > "$ENV_FILE.tmp" && mv "$ENV_FILE.tmp" "$ENV_FILE"
  else
    printf '%s=%s\n' "$key" "$value" >> "$ENV_FILE"
  fi
}

update_or_append API_IMAGE_TAG "$LAST_TAG"
update_or_append WEB_IMAGE_TAG "$LAST_TAG"

echo "rollback-image-tag: rolled back to $LAST_TAG"
grep -E '^(API_IMAGE_TAG|WEB_IMAGE_TAG)=' "$ENV_FILE"
