import type {
  DirectorBookAutomationProjection,
  DirectorBookAutomationStatus,
} from "@ai-novel/shared/types/directorRuntime";
import {
  Activity,
  AlertTriangle,
  CheckCircle2,
  Clock3,
  Database,
  History,
  ListTodo,
  PauseCircle,
  RotateCcw,
  ShieldCheck,
  XCircle,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

interface DirectorBookAutomationCardProps {
  projection: DirectorBookAutomationProjection | null | undefined;
  fallbackSummary?: string | null;
  fallbackStatusLabel?: string | null;
  onOpenTaskCenter: () => void;
  onSwitchToProjectNav?: () => void;
}

function formatDate(value: string | null | undefined): string {
  if (!value) {
    return "暂无";
  }
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return "暂无";
  }
  return date.toLocaleString();
}

function formatStatus(status: DirectorBookAutomationStatus): string {
  const labels: Record<DirectorBookAutomationStatus, string> = {
    idle: "空闲",
    queued: "排队中",
    running: "推进中",
    waiting_approval: "等待确认",
    waiting_recovery: "待恢复",
    blocked: "已暂停",
    failed: "异常",
    cancelled: "已取消",
    completed: "已完成",
  };
  return labels[status];
}

function statusBadgeVariant(status: DirectorBookAutomationStatus): "default" | "secondary" | "outline" | "destructive" {
  if (status === "failed" || status === "blocked") {
    return "destructive";
  }
  if (status === "running" || status === "queued") {
    return "default";
  }
  if (status === "waiting_approval" || status === "waiting_recovery") {
    return "outline";
  }
  return "secondary";
}

function statusClassName(status: DirectorBookAutomationStatus): string {
  if (status === "running" || status === "queued") {
    return "border-sky-200 bg-sky-50/70";
  }
  if (status === "waiting_approval" || status === "waiting_recovery") {
    return "border-amber-200 bg-amber-50/70";
  }
  if (status === "blocked" || status === "failed") {
    return "border-destructive/30 bg-destructive/5";
  }
  if (status === "completed") {
    return "border-emerald-200 bg-emerald-50/60";
  }
  return "border-border/70 bg-muted/20";
}

function statusIcon(status: DirectorBookAutomationStatus) {
  if (status === "running") {
    return <Activity className="h-4 w-4" />;
  }
  if (status === "queued") {
    return <Clock3 className="h-4 w-4" />;
  }
  if (status === "waiting_recovery") {
    return <RotateCcw className="h-4 w-4" />;
  }
  if (status === "waiting_approval") {
    return <PauseCircle className="h-4 w-4" />;
  }
  if (status === "blocked") {
    return <AlertTriangle className="h-4 w-4" />;
  }
  if (status === "failed") {
    return <XCircle className="h-4 w-4" />;
  }
  if (status === "completed") {
    return <CheckCircle2 className="h-4 w-4" />;
  }
  return <ShieldCheck className="h-4 w-4" />;
}

function artifactTypeLabel(type: string): string {
  const labels: Record<string, string> = {
    book_contract: "书级约定",
    story_macro: "故事规划",
    character_cast: "角色",
    volume_strategy: "分卷",
    chapter_task_sheet: "任务单",
    chapter_draft: "正文",
    audit_report: "审校",
    repair_ticket: "修复",
    reader_promise: "读者承诺",
    character_governance_state: "角色状态",
    world_skeleton: "世界框架",
    source_knowledge_pack: "资料包",
    chapter_retention_contract: "留存约定",
    continuity_state: "连续性",
    rolling_window_review: "近期复盘",
  };
  return labels[type] ?? type;
}

export default function DirectorBookAutomationCard({
  projection,
  fallbackSummary,
  fallbackStatusLabel,
  onOpenTaskCenter,
  onSwitchToProjectNav,
}: DirectorBookAutomationCardProps) {
  const status = projection?.status ?? "idle";
  const headline = projection?.headline?.trim() || "AI 驾驶舱";
  const detail = projection?.requiresUserAction
    ? projection.blockedReason?.trim() || projection.detail?.trim()
    : projection?.detail?.trim();
  const summary = projection?.automationSummary?.trim()
    || projection?.progressSummary?.trim()
    || fallbackSummary?.trim()
    || "当前没有后台导演任务，可以直接继续手动创作。";
  const recentItems = projection?.timeline.slice(0, 2) ?? [];
  const artifactRows = projection?.artifactSummary.byType?.slice(0, 3) ?? [];

  return (
    <div className={cn("rounded-lg border p-3", statusClassName(status))}>
      <div className="flex items-start justify-between gap-2">
        <div className="flex min-w-0 items-start gap-2">
          <span className="mt-0.5 shrink-0 text-foreground">{statusIcon(status)}</span>
          <div className="min-w-0">
            <div className="text-sm font-semibold text-foreground">AI 驾驶舱</div>
            <div className="mt-1 text-xs leading-5 text-muted-foreground">{headline}</div>
          </div>
        </div>
        <Badge variant={projection ? statusBadgeVariant(status) : "secondary"} className="shrink-0">
          {projection ? formatStatus(status) : fallbackStatusLabel ?? "空闲"}
        </Badge>
      </div>

      {detail ? (
        <div className="mt-3 rounded-md border bg-background/70 px-3 py-2 text-xs leading-5 text-muted-foreground">
          {projection?.requiresUserAction ? "需要处理：" : null}
          {detail}
        </div>
      ) : null}

      {summary ? (
        <div className="mt-3 text-xs leading-5 text-muted-foreground">{summary}</div>
      ) : null}

      {artifactRows.length > 0 ? (
        <div className="mt-3 rounded-md border bg-background/70 px-3 py-2">
          <div className="flex items-center gap-1 text-xs font-medium text-muted-foreground">
            <Database className="h-3.5 w-3.5" />
            产物记录
          </div>
          <div className="mt-2 flex flex-wrap gap-1.5">
            {artifactRows.map((item) => (
              <Badge key={item.artifactType} variant={item.staleCount > 0 ? "outline" : "secondary"} className="text-[11px]">
                {artifactTypeLabel(String(item.artifactType))}
                <span className="ml-1 text-muted-foreground">{item.activeCount}/{item.totalCount}</span>
              </Badge>
            ))}
          </div>
        </div>
      ) : null}

      {projection?.nextActionLabel ? (
        <div className="mt-2 rounded-md border bg-background/70 px-3 py-2 text-xs leading-5 text-muted-foreground">
          下一步：{projection.nextActionLabel}
        </div>
      ) : null}

      {recentItems.length > 0 ? (
        <div className="mt-3 space-y-2">
          <div className="flex items-center gap-1 text-xs font-medium text-muted-foreground">
            <History className="h-3.5 w-3.5" />
            自动化记录
          </div>
          {recentItems.map((item) => (
            <div key={item.id} className="rounded-md border bg-background/70 px-3 py-2 text-xs leading-5">
              <div className="line-clamp-2 text-foreground">{item.title}</div>
              <div className="mt-1 text-muted-foreground">{formatDate(item.occurredAt)}</div>
            </div>
          ))}
        </div>
      ) : null}

      <div className="mt-3 flex gap-2">
        <Button type="button" size="sm" className="flex-1" onClick={onOpenTaskCenter}>
          <ListTodo className="h-4 w-4" />
          执行详情
        </Button>
        {onSwitchToProjectNav ? (
          <Button type="button" size="sm" variant="outline" onClick={onSwitchToProjectNav}>
            项目导航
          </Button>
        ) : null}
      </div>
    </div>
  );
}
