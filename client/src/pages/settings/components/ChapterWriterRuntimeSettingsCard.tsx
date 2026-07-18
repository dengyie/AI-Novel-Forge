import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  getChapterWriterRuntimeSettings,
  saveChapterWriterRuntimeSettings,
  type ChapterWriterRuntimeSettingsStatus,
} from "@/api/settings";
import { queryKeys } from "@/api/queryKeys";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { AUTO_DIRECTOR_MOBILE_CLASSES } from "@/mobile/autoDirector";

/**
 * 章节写作运行时设置卡片（review-fix backlog #2 前端）。
 *
 * 四项均已在 server ChapterWriterRuntimeSettingsService + routes zod 强校验为唯一真值来源；
 * 这里仅做本地解析 + 范围提示 + 热调保存。服务器 zod 才是最终边界。
 */

// 与 server ChapterWriterRuntimeSettingsService 常量对齐；zod 为最终强制边界。
const LIMITS = {
  recentWindow: { min: 1, max: 20, default: 5, step: 1 },
  similarityThreshold: { min: 0.05, max: 1, default: 0.3, step: 0.01 },
  openingChars: { min: 64, max: 2000, default: 300, step: 1 },
  transportRetryMaxAttempts: { min: 0, max: 5, default: 2, step: 1 },
} as const;

type FieldKey =
  | "openingDiversityRecentWindow"
  | "openingDiversitySimilarityThreshold"
  | "openingDiversityOpeningChars"
  | "transportRetryMaxAttempts";

interface FieldSpec {
  key: FieldKey;
  label: string;
  hint: string;
  limits: { min: number; max: number; default: number; step: number };
}

const FIELDS: FieldSpec[] = [
  {
    key: "openingDiversityRecentWindow",
    label: "章首多样性参考窗口（最近 N 章）",
    hint: "比对最近 N 章前置章节开篇，命中阈值则整章重写防雷同。",
    limits: LIMITS.recentWindow,
  },
  {
    key: "openingDiversitySimilarityThreshold",
    label: "章首相似度阈值",
    hint: "本章开篇与参考集 n-gram jaccard 超过该值才触发改写。",
    limits: LIMITS.similarityThreshold,
  },
  {
    key: "openingDiversityOpeningChars",
    label: "章首比对字数窗口",
    hint: "章首前 N 个字符参与相似比较；过短易误判、过长易稀释。",
    limits: LIMITS.openingChars,
  },
  {
    key: "transportRetryMaxAttempts",
    label: "writer 传输层重试上限",
    hint: "writer 瞬时失败整章重试次数（不含首次）。0 = 仅首次、失败不重试。",
    limits: LIMITS.transportRetryMaxAttempts,
  },
];

const FIELD_ORDER: FieldKey[] = [
  "openingDiversityRecentWindow",
  "openingDiversitySimilarityThreshold",
  "openingDiversityOpeningChars",
  "transportRetryMaxAttempts",
];

function emptyDraft(): Record<FieldKey, string> {
  return {
    openingDiversityRecentWindow: String(LIMITS.recentWindow.default),
    openingDiversitySimilarityThreshold: String(LIMITS.similarityThreshold.default),
    openingDiversityOpeningChars: String(LIMITS.openingChars.default),
    transportRetryMaxAttempts: String(LIMITS.transportRetryMaxAttempts.default),
  };
}

function parseField(value: string, limits: { min: number; max: number; default: number; step: number }): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    return limits.default;
  }
  return Math.min(limits.max, Math.max(limits.min, parsed));
}

function isInRange(value: string, limits: { min: number; max: number }): boolean {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= limits.min && parsed <= limits.max;
}

export default function ChapterWriterRuntimeSettingsCard() {
  const queryClient = useQueryClient();
  const [draft, setDraft] = useState<Record<FieldKey, string>>(emptyDraft);
  const [feedback, setFeedback] = useState("");

  const settingsQuery = useQuery({
    queryKey: queryKeys.settings.chapterWriterRuntime,
    queryFn: getChapterWriterRuntimeSettings,
  });

  const settings = settingsQuery.data?.data;

  useEffect(() => {
    if (settings) {
      setDraft({
        openingDiversityRecentWindow: String(settings.openingDiversityRecentWindow),
        openingDiversitySimilarityThreshold: String(settings.openingDiversitySimilarityThreshold),
        openingDiversityOpeningChars: String(settings.openingDiversityOpeningChars),
        transportRetryMaxAttempts: String(settings.transportRetryMaxAttempts),
      });
    }
  }, [settings]);

  const saveMutation = useMutation({
    mutationFn: (payload: ChapterWriterRuntimeSettingsStatus) =>
      saveChapterWriterRuntimeSettings(payload),
    onSuccess: async (response) => {
      setFeedback(response.message ?? "章节写作运行设置保存成功。");
      await queryClient.invalidateQueries({ queryKey: queryKeys.settings.chapterWriterRuntime });
    },
    onError: (error) => {
      setFeedback(error instanceof Error ? error.message : "章节写作运行设置保存失败。");
    },
  });

  const allValid = FIELDS.every((field) => isInRange(draft[field.key], field.limits));

  const handleSave = () => {
    setFeedback("");
    saveMutation.mutate({
      openingDiversityRecentWindow: parseField(draft.openingDiversityRecentWindow, LIMITS.recentWindow),
      openingDiversitySimilarityThreshold: parseField(draft.openingDiversitySimilarityThreshold, LIMITS.similarityThreshold),
      openingDiversityOpeningChars: parseField(draft.openingDiversityOpeningChars, LIMITS.openingChars),
      transportRetryMaxAttempts: parseField(draft.transportRetryMaxAttempts, LIMITS.transportRetryMaxAttempts),
    });
  };

  return (
    <Card className="min-w-0 overflow-hidden">
      <CardHeader className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0 space-y-1">
          <CardTitle>章节写作运行设置</CardTitle>
          <CardDescription className={AUTO_DIRECTOR_MOBILE_CLASSES.wrapText}>
            调节章首多样性防雷同与 writer 传输层重试。默认值即出厂推荐；改后下一次生成即按库值热调生效，无需重启。
          </CardDescription>
        </div>
        <Badge variant="outline">热调</Badge>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="grid min-w-0 gap-4 md:grid-cols-2">
          {FIELDS.map((field) => {
            const inRange = isInRange(draft[field.key], field.limits);
            return (
              <div key={field.key} className="space-y-2">
                <div className="text-sm font-medium">{field.label}</div>
                <Input
                  type="number"
                  min={field.limits.min}
                  max={field.limits.max}
                  step={field.limits.step}
                  value={draft[field.key]}
                  onChange={(event) => {
                    setFeedback("");
                    setDraft((prev) => ({ ...prev, [field.key]: event.target.value }));
                  }}
                  aria-invalid={!inRange}
                />
                <div className={`text-xs text-muted-foreground ${AUTO_DIRECTOR_MOBILE_CLASSES.wrapText}`}>
                  {field.hint}
                  <div>
                    可设置范围：{field.limits.min}-{field.limits.max}（默认 {field.limits.default}）。
                  </div>
                </div>
              </div>
            );
          })}
        </div>

        {!allValid ? (
          <div className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-900">
            有字段超出可设置范围，保存时会被自动钳到边界。请先核对再保存。
          </div>
        ) : null}

        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <Button
            variant="outline"
            className="w-full sm:w-auto"
            onClick={() => {
              setFeedback("");
              if (settings) {
                setDraft({
                  openingDiversityRecentWindow: String(settings.openingDiversityRecentWindow),
                  openingDiversitySimilarityThreshold: String(settings.openingDiversitySimilarityThreshold),
                  openingDiversityOpeningChars: String(settings.openingDiversityOpeningChars),
                  transportRetryMaxAttempts: String(settings.transportRetryMaxAttempts),
                });
              } else {
                setDraft(emptyDraft());
              }
            }}
            disabled={settingsQuery.isLoading || saveMutation.isPending}
          >
            恢复当前库值
          </Button>
          <Button
            className="w-full sm:w-auto"
            onClick={handleSave}
            disabled={settingsQuery.isLoading || saveMutation.isPending}
          >
            {saveMutation.isPending ? "保存中..." : "保存设置"}
          </Button>
        </div>

        {feedback ? (
          <div className={`text-sm text-muted-foreground ${AUTO_DIRECTOR_MOBILE_CLASSES.wrapText}`}>
            {feedback}
          </div>
        ) : null}
      </CardContent>
    </Card>
  );
}
