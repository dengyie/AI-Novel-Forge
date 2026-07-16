import { useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowLeft, Headphones } from "lucide-react";
import { updateNovel } from "@/api/novel";
import { getAudiobookWorkspace } from "@/api/novel/audiobook";
import { queryKeys } from "@/api/queryKeys";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import NovelAudiobookPanel from "@/pages/novels/components/NovelAudiobookPanel";

export default function AudiobookProjectPage() {
  const { id = "" } = useParams<{ id: string }>();
  const queryClient = useQueryClient();
  const [narratorVoice, setNarratorVoice] = useState("");
  const [narratorStyle, setNarratorStyle] = useState("");

  // 轻量 bootstrap：不含章节正文（getNovelDetail 对源世界 ~2MB）
  const workspaceQuery = useQuery({
    queryKey: queryKeys.novels.audiobookWorkspace(id),
    queryFn: async () => {
      const response = await getAudiobookWorkspace(id);
      if (!response.data) {
        throw new Error(response.message || "有声书工作台数据为空。");
      }
      return response.data;
    },
    enabled: Boolean(id),
    staleTime: 30_000,
  });

  const workspace = workspaceQuery.data;

  useEffect(() => {
    if (!workspace) return;
    setNarratorVoice(workspace.audiobookNarratorVoice ?? "");
    setNarratorStyle(workspace.audiobookNarratorStyle ?? "");
  }, [
    workspace?.novelId,
    workspace?.audiobookNarratorVoice,
    workspace?.audiobookNarratorStyle,
  ]);

  const saveNarratorMutation = useMutation({
    mutationFn: async () => {
      await updateNovel(id, {
        audiobookNarratorVoice: (narratorVoice ?? "").trim() || null,
        audiobookNarratorStyle: (narratorStyle ?? "").trim() || null,
      });
    },
    onSuccess: async () => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: queryKeys.novels.audiobookWorkspace(id) }),
        queryClient.invalidateQueries({ queryKey: queryKeys.novels.audiobookVoiceReadiness(id) }),
      ]);
    },
  });

  if (!id) {
    return (
      <div className="mx-auto max-w-4xl px-4 py-10 text-sm text-muted-foreground">
        缺少小说 id。
        <Button asChild className="ml-3" size="sm" variant="outline">
          <Link to="/audiobook">返回有声书工作台</Link>
        </Button>
      </div>
    );
  }

  if (workspaceQuery.isLoading) {
    return (
      <div className="mx-auto max-w-4xl space-y-4 px-4 py-10">
        <Button asChild size="sm" variant="ghost" className="-ml-2 w-fit">
          <Link to="/audiobook">
            <ArrowLeft className="h-4 w-4" />
            有声书工作台
          </Link>
        </Button>
        <div className="rounded-xl border border-border/70 bg-muted/20 px-4 py-8 text-sm text-muted-foreground">
          正在加载有声书工作台（章节目录与角色音色，不含正文）…
        </div>
      </div>
    );
  }

  if (workspaceQuery.isError || !workspace) {
    return (
      <div className="mx-auto max-w-4xl space-y-4 px-4 py-10">
        <div className="text-sm text-destructive">
          小说加载失败：
          {workspaceQuery.error instanceof Error ? workspaceQuery.error.message : "不存在或无权访问"}
        </div>
        <div className="flex flex-wrap gap-2">
          <Button
            type="button"
            size="sm"
            variant="outline"
            onClick={() => {
              void workspaceQuery.refetch();
            }}
          >
            重试
          </Button>
          <Button asChild size="sm" variant="outline">
            <Link to="/audiobook">
              <ArrowLeft className="h-4 w-4" />
              返回有声书工作台
            </Link>
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-4xl space-y-6 px-4 py-6 pb-[max(7rem,calc(5.5rem+env(safe-area-inset-bottom)))] md:pb-10">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="space-y-2">
          <Button asChild size="sm" variant="ghost" className="-ml-2 w-fit">
            <Link to="/audiobook">
              <ArrowLeft className="h-4 w-4" />
              有声书工作台
            </Link>
          </Button>
          <h1 className="flex flex-wrap items-center gap-2 text-2xl font-semibold">
            <Headphones className="h-6 w-6 text-primary" />
            {workspace.title}
          </h1>
          <div className="flex flex-wrap items-center gap-2 text-sm text-muted-foreground">
            <span>有声书开发</span>
            <Badge variant="outline">{workspace.chapterCount} 章</Badge>
            <Badge variant="outline">{workspace.characterCount} 角色</Badge>
          </div>
        </div>
        <Button asChild size="sm" variant="outline">
          <Link to={`/novels/${id}/edit`}>打开小说编辑</Link>
        </Button>
      </div>

      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-base">开发说明</CardTitle>
          <CardDescription>
            本台可一键补齐角色音色与固定试听，再设旁白并生成任务。
            clone 参考音与单卡精修仍可在小说编辑 → 角色 Tab。
            本页只拉目录与音色字段，不会加载全文章节正文。
          </CardDescription>
        </CardHeader>
        <CardContent>
          <NovelAudiobookPanel
            novelId={id}
            chapters={workspace.chapters}
            characters={workspace.characters}
            narratorVoice={narratorVoice}
            narratorStyle={narratorStyle}
            bootstrapActiveJobId={workspace.readiness?.activeReadinessJobId ?? null}
            onNarratorChange={(patch) => {
              saveNarratorMutation.reset();
              if (patch.audiobookNarratorVoice !== undefined) {
                setNarratorVoice(patch.audiobookNarratorVoice);
              }
              if (patch.audiobookNarratorStyle !== undefined) {
                setNarratorStyle(patch.audiobookNarratorStyle);
              }
            }}
            onSaveNarrator={() => saveNarratorMutation.mutate()}
            isSavingNarrator={saveNarratorMutation.isPending}
          />
          {saveNarratorMutation.isError ? (
            <div className="mt-3 text-xs text-destructive">
              旁白保存失败：
              {saveNarratorMutation.error instanceof Error
                ? saveNarratorMutation.error.message
                : "未知错误"}
            </div>
          ) : null}
          {saveNarratorMutation.isSuccess ? (
            <div className="mt-3 text-xs text-muted-foreground">旁白默认已保存。</div>
          ) : null}
        </CardContent>
      </Card>
    </div>
  );
}
