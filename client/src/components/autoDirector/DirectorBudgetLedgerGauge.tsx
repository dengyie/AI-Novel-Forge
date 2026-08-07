import type { DirectorBudgetLedgerSummary } from "@ai-novel/shared/types/novelDirector";
import { Badge } from "@/components/ui/badge";
import { AUTO_DIRECTOR_MOBILE_CLASSES } from "@/mobile/autoDirector";

interface DirectorBudgetLedgerGaugeProps {
  summary: DirectorBudgetLedgerSummary;
}

/**
 * 质量修复预算仪表盘。
 *
 * 语义说明：`totals.*` 是跨窗口（跨 issue 签名）的合计，而预算上限是「单窗口」上限，
 * 二者不能直接相除——用 used/limit 填充条会错误地把多个窗口的合计当作单个窗口的用量，
 * 给「预算已耗尽」的假信号。因此这里以 `exhaustedEntryCount`（达到单窗口上限的账本条数）
 * 作为真正的告警指标，各类型合计仅作中性数量展示。
 */
export function DirectorBudgetLedgerGauge({ summary }: DirectorBudgetLedgerGaugeProps) {
  const breaker = summary.circuitBreaker;
  const breakerOpen = breaker?.status === "open";
  const { patchRepair, chapterRewrite, windowReplan } = summary.budgetLimits;

  const statItem = (label: string, value: number, limit?: number) => (
    <div className="rounded-md border p-2.5">
      <div className="text-xs text-muted-foreground">{label}</div>
      <div className="mt-1 text-lg font-semibold tabular-nums">
        {value}
        {typeof limit === "number" ? (
          <span className="ml-1 text-xs font-normal text-muted-foreground">/ 窗口上限 {limit}</span>
        ) : null}
      </div>
    </div>
  );

  return (
    <div
      className={`space-y-3 rounded-md border p-3 text-sm ${AUTO_DIRECTOR_MOBILE_CLASSES.wrapText} ${breakerOpen ? "border-red-400 bg-red-50" : "border-border"}`}
    >
      <div className="flex flex-wrap items-center gap-2">
        <div className="font-medium">质量修复预算</div>
        <Badge variant={breakerOpen ? "destructive" : "outline"}>
          熔断：{breakerOpen ? "已断开" : "正常"}
        </Badge>
        {summary.exhaustedEntryCount > 0 ? (
          <Badge variant="destructive">{summary.exhaustedEntryCount} 项已达上限</Badge>
        ) : null}
      </div>

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        {statItem("补丁修复", summary.totals.patchRepairCount, patchRepair)}
        {statItem("章节重写", summary.totals.chapterRewriteCount, chapterRewrite)}
        {statItem("窗口重规划", summary.totals.windowReplanCount, windowReplan)}
        {statItem("降级跳过", summary.totals.deferredCount)}
      </div>

      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground">
        <span>账本条目：{summary.entryCount}</span>
        <span>模型侧降级：{summary.transientModelFallbackCount}</span>
        {breaker ? (
          <span>
            故障：{breaker.failureCount}（补丁 {breaker.patchFailureCount} / 模型 {breaker.modelFailureCount} / 用量 {breaker.usageAnomalyCount}）
          </span>
        ) : null}
        {summary.updatedAt ? (
          <span>更新：{new Date(summary.updatedAt).toLocaleString()}</span>
        ) : null}
      </div>
    </div>
  );
}