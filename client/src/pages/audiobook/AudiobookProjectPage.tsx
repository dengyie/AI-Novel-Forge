import { useEffect, useMemo, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowLeft, Headphones } from "lucide-react";
import { getNovelDetail, updateNovel } from "@/api/novel";
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

  const detailQuery = useQuery({
    queryKey: queryKeys.novels.detail(id),
    queryFn: () => getNovelDetail(id),
    enabled: Boolean(id),
  });

  const detail = detailQuery.data?.data;

  useEffect(() => {
    if (!detail) return;
    setNarratorVoice(detail.audiobookNarratorVoice ?? "");
    setNarratorStyle(detail.audiobookNarratorStyle ?? "");
  }, [detail?.id, detail?.audiobookNarratorVoice, detail?.audiobookNarratorStyle]);

  const chapters = useMemo(
    () =>
      (detail?.chapters ?? [])
        .slice()
        .sort((a, b) => a.order - b.order)
        .map((chapter) => ({
          id: chapter.id,
          order: chapter.order,
          title: chapter.title,
        })),
    [detail?.chapters],
  );

  const characters = detail?.characters ?? [];

  const saveNarratorMutation = useMutation({
    mutationFn: async () => {
      await updateNovel(id, {
        audiobookNarratorVoice: (narratorVoice ?? "").trim() || null,
        audiobookNarratorStyle: (narratorStyle ?? "").trim() || null,
      });
    },
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: queryKeys.novels.detail(id) });
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

  if (detailQuery.isLoading) {
    return <div className="mx-auto max-w-4xl px-4 py-10 text-sm text-muted-foreground">加载小说…</div>;
  }

  if (detailQuery.isError || !detail) {
    return (
      <div className="mx-auto max-w-4xl space-y-4 px-4 py-10">
        <div className="text-sm text-destructive">
          小说加载失败：
          {detailQuery.error instanceof Error ? detailQuery.error.message : "不存在或无权访问"}
        </div>
        <Button asChild size="sm" variant="outline">
          <Link to="/audiobook">
            <ArrowLeft className="h-4 w-4" />
            返回有声书工作台
          </Link>
        </Button>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-4xl space-y-6 px-4 py-6">
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
            {detail.title}
          </h1>
          <div className="flex flex-wrap items-center gap-2 text-sm text-muted-foreground">
            <span>有声书开发</span>
            <Badge variant="outline">{chapters.length} 章</Badge>
            <Badge variant="outline">{characters.length} 角色</Badge>
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
            先规划/写入角色音色，再设旁白并生成任务。角色卡细节仍可在小说编辑 → 角色 Tab 调整（含 clone 参考音）。
          </CardDescription>
        </CardHeader>
        <CardContent>
          <NovelAudiobookPanel
            novelId={id}
            chapters={chapters}
            characters={characters}
            narratorVoice={narratorVoice}
            narratorStyle={narratorStyle}
            onNarratorChange={(patch) => {
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
