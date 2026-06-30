import { useEffect, useMemo, useState } from "react";
import type { UnifiedTaskSummary } from "@ai-novel/shared/types/task";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  formatCheckpoint,
  formatDate,
  formatKind,
  formatStatus,
  getTaskViewGroup,
  TASK_VIEW_GROUP_DEFAULT_COLLAPSED,
  TASK_VIEW_GROUP_LABEL,
  TASK_VIEW_GROUP_ORDER,
  toStatusVariant,
  type TaskViewGroup,
} from "../taskCenterUtils";

interface TaskCenterListPanelProps {
  tasks: UnifiedTaskSummary[];
  selectedKind: string | null;
  selectedId: string | null;
  onSelectTask: (task: UnifiedTaskSummary) => void;
}

function TaskRow({
  task,
  isSelected,
  onSelect,
}: {
  task: UnifiedTaskSummary;
  isSelected: boolean;
  onSelect: (task: UnifiedTaskSummary) => void;
}) {
  return (
    <button
      type="button"
      className={`w-full rounded-md border p-3 text-left transition-colors ${
        isSelected ? "border-primary bg-primary/5" : "hover:bg-muted/40"
      }`}
      onClick={() => onSelect(task)}
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="font-medium">{task.title}</div>
        <Badge variant={toStatusVariant(task.status)}>{formatStatus(task.status)}</Badge>
      </div>
      <div className="mt-2 text-xs text-muted-foreground">
        {formatKind(task.kind)} | 进度 {Math.round(task.progress * 100)}%
      </div>
      <div className="mt-1 text-xs text-muted-foreground">
        阶段：{task.currentStage ?? "暂无"} | 当前项：{task.currentItemLabel ?? "暂无"}
      </div>
      {task.displayStatus || task.lastHealthyStage ? (
        <div className="mt-1 text-xs text-muted-foreground">
          状态：{task.displayStatus ?? formatStatus(task.status)} | 最近健康阶段：{task.lastHealthyStage ?? "暂无"}
        </div>
      ) : null}
      {task.kind === "novel_workflow" ? (
        <div className="mt-1 text-xs text-muted-foreground">
          检查点：{formatCheckpoint(task.checkpointType, task.executionScopeLabel)} | 建议继续：{task.resumeAction ?? task.nextActionLabel ?? "继续主流程"}
        </div>
      ) : null}
      {task.blockingReason ? (
        <div className="mt-1 text-xs text-muted-foreground line-clamp-2">
          原因：{task.blockingReason}
        </div>
      ) : null}
      <div className="mt-1 text-xs text-muted-foreground">
        最近心跳：{formatDate(task.heartbeatAt)} | 更新时间：{formatDate(task.updatedAt)}
      </div>
    </button>
  );
}

export default function TaskCenterListPanel({
  tasks,
  selectedKind,
  selectedId,
  onSelectTask,
}: TaskCenterListPanelProps) {
  const [collapsed, setCollapsed] = useState<Record<TaskViewGroup, boolean>>(
    TASK_VIEW_GROUP_DEFAULT_COLLAPSED,
  );

  const grouped = useMemo(() => {
    const buckets: Record<TaskViewGroup, UnifiedTaskSummary[]> = {
      active: [],
      needs_attention: [],
      completed: [],
    };
    for (const task of tasks) {
      buckets[getTaskViewGroup(task.status)].push(task);
    }
    return buckets;
  }, [tasks]);

  // Auto-expand a collapsed group when the selected task falls inside it.
  useEffect(() => {
    if (!selectedId) return;
    setCollapsed((prev) => {
      let changed = false;
      const next = { ...prev };
      for (const group of TASK_VIEW_GROUP_ORDER) {
        if (
          next[group]
          && grouped[group].some(
            (task) => task.id === selectedId && task.kind === selectedKind,
          )
        ) {
          next[group] = false;
          changed = true;
        }
      }
      return changed ? next : prev;
    });
  }, [selectedId, selectedKind, grouped]);

  const toggleGroup = (group: TaskViewGroup) => {
    setCollapsed((prev) => ({ ...prev, [group]: !prev[group] }));
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">任务列表</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        {tasks.length === 0 ? (
          <div className="rounded-md border border-dashed p-6 text-sm text-muted-foreground">
            当前没有符合条件的任务。
          </div>
        ) : null}
        {TASK_VIEW_GROUP_ORDER.map((group) => {
          const rows = grouped[group];
          if (rows.length === 0) return null;
          const isCollapsed = collapsed[group];
          return (
            <section key={group} className="space-y-2">
              <button
                type="button"
                className="flex w-full items-center gap-2 rounded-md bg-muted/50 px-3 py-2 text-sm font-medium hover:bg-muted"
                aria-expanded={!isCollapsed}
                onClick={() => toggleGroup(group)}
              >
                <span className="text-xs">{isCollapsed ? "▶" : "▼"}</span>
                <span>{TASK_VIEW_GROUP_LABEL[group]}</span>
                <Badge variant="secondary">{rows.length}</Badge>
              </button>
              {!isCollapsed
                ? rows.map((task) => {
                    const isSelected = task.kind === selectedKind && task.id === selectedId;
                    return (
                      <TaskRow
                        key={`${task.kind}:${task.id}`}
                        task={task}
                        isSelected={isSelected}
                        onSelect={onSelectTask}
                      />
                    );
                  })
                : null}
            </section>
          );
        })}
      </CardContent>
    </Card>
  );
}
