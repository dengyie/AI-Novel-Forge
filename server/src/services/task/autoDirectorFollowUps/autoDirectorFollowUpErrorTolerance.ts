/**
 * 自动导演通知 / 站内红点读写路径的统一"可容忍错误"判定。
 *
 * 判定一次通知写入/读取失败的"可容忍"类别——即只影响红点/外部渠道这类非致命
 * 记录，绝不因此打崩自动导演续跑或让跟进中心接口 500。容忍并不等于无差别吞错：
 * 吞噬路径都会打 console.warn 留下可观测痕迹（P2023/P2009 这类真实数据缺陷尤其
 * 要靠告警暴露）。
 *
 * 已知类别（按成因区分，不要混为一谈）：
 *  - schema 漂移，自愈：P2021 表不存在、P2022 列不存在、底层驱动抛出的
 *    "does not exist / no such column / no such table"。根因多为 db push 建库后
 *    再加 schema 字段未回填（见 runtimeMigrations REQUIRED_COLUMN_BACKFILLS），
 *    属自愈、丢了这条记录不影响推进。
 *  - 瞬时基础设施：P1001 及 "can't reach database server"——DB 短暂不可达，
 *    重启/重试后即可恢复，同样不应把整本书标 failed。
 *  - 潜在数据 bug（容忍但掩盖，须告警）：P2023 列数据不一致、P2009 查询解析失败。
 *    容忍是为了不因个别坏数据打崩续跑，但很可能对应真实缺陷，必须可观测。
 *
 * 站内红点与外部渠道通知都是"尽力而为"（best-effort）：写失败只丢一条提醒；
 * 读失败（未读数、标记已读）只影响红点展示，不应让跟进中心接口 500。统一复用
 * 该判定，读写两路在 schema 漂移/DB 不可用时降级为空/0，其余错误原样上抛。
 */
export function extractErrorCode(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null) {
    return undefined;
  }
  return "code" in error ? String((error as { code?: unknown }).code) : undefined;
}

export function extractErrorMessage(error: unknown): string {
  if (typeof error === "object" && error !== null && "message" in error) {
    const message = (error as { message?: unknown }).message;
    if (typeof message === "string" && message.trim()) {
      return message.trim();
    }
  }
  return String(error);
}

export function isTolerableNotificationError(error: unknown): boolean {
  if (!error || typeof error !== "object") {
    return false;
  }
  const code = extractErrorCode(error);
  if (
    code === "P2021"
    || code === "P2022"
    || code === "P2023"
    || code === "P1001"
    || code === "P2009"
  ) {
    return true;
  }
  const message = extractErrorMessage(error);
  return /does not exist in the current database/i.test(message)
    || /no such column/i.test(message)
    || /no such table/i.test(message)
    || /can't reach database server/i.test(message);
}
