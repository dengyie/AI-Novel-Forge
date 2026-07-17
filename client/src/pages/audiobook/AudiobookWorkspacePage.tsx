import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { Headphones, BookOpenText, Library, Search } from "lucide-react";
import { getNovelList } from "@/api/novel";
import { postAudiobookWorkspaceOverview } from "@/api/novel/audiobook";
import { queryKeys } from "@/api/queryKeys";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { resolveAudiobookWorkspaceBadges } from "./audiobookWorkspaceBadges";

const PAGE_SIZE = 50;
const SEARCH_DEBOUNCE_MS = 300;

export default function AudiobookWorkspacePage() {
  const [keyword, setKeyword] = useState("");
  const [debouncedKeyword, setDebouncedKeyword] = useState("");
  const [page, setPage] = useState(1);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      setDebouncedKeyword(keyword.trim());
      setPage(1);
    }, SEARCH_DEBOUNCE_MS);
    return () => window.clearTimeout(timer);
  }, [keyword]);

  const novelListQuery = useQuery({
    queryKey: queryKeys.novels.list(page, PAGE_SIZE, debouncedKeyword),
    queryFn: () => getNovelList({ page, limit: PAGE_SIZE, q: debouncedKeyword || undefined }),
    staleTime: 30_000,
  });

  const items = novelListQuery.data?.data?.items ?? [];
  const totalPages = novelListQuery.data?.data?.totalPages ?? 1;
  const novelIds = useMemo(() => items.map((item) => item.id), [items]);
  /** 稳定 key：列表顺序即页内顺序，join 后进 queryKey，防同 page/keyword 换书仍吃旧 overview */
  const novelIdsKey = useMemo(() => novelIds.join(","), [novelIds]);

  const overviewQuery = useQuery({
    queryKey: queryKeys.novels.audiobookWorkspaceOverview(page, debouncedKeyword, novelIdsKey),
    queryFn: async () => {
      const response = await postAudiobookWorkspaceOverview({ novelIds });
      return response.data;
    },
    enabled: novelIds.length > 0 && !novelListQuery.isLoading && !novelListQuery.isError,
    staleTime: 20_000,
  });

  const overviewById = useMemo(() => {
    const map = new Map<string, NonNullable<typeof overviewQuery.data>["items"][number]>();
    for (const row of overviewQuery.data?.items ?? []) {
      map.set(row.novelId, row);
    }
    return map;
  }, [overviewQuery.data]);

  return (
    <div className="mx-auto max-w-4xl space-y-6 px-4 py-6">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <h1 className="flex items-center gap-2 text-2xl font-semibold">
            <Headphones className="h-6 w-6 text-primary" />
            有声书工作台
          </h1>
          <p className="mt-1 text-sm text-muted-foreground">
            选择一本小说，配置角色音色并生成多角色有声书（WAV / M4B）。
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button type="button" variant="outline" asChild>
            <Link to="/audiobook/voice-library">
              <Library className="h-4 w-4" />
              全站音色库
            </Link>
          </Button>
          <Button type="button" variant="outline" asChild>
            <Link to="/novels">
              <BookOpenText className="h-4 w-4" />
              小说列表
            </Link>
          </Button>
        </div>
      </div>

      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base">选择小说</CardTitle>
          <CardDescription>
            有声书任务挂在小说角色卡与章节上，无需单独建项目。选中后进入该小说的有声书开发页。
            列表展示轻量态势（生成中 / 缺音色 / 可听等），精确试听与 clone 探针以项目页为准。
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="relative">
            <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              className="pl-9"
              placeholder="搜索小说标题…"
              value={keyword}
              onChange={(event) => setKeyword(event.target.value)}
            />
          </div>

          {novelListQuery.isLoading ? (
            <div className="py-10 text-center text-sm text-muted-foreground">加载小说列表…</div>
          ) : null}

          {novelListQuery.isError ? (
            <div className="py-10 text-center text-sm text-destructive">
              加载失败：{novelListQuery.error instanceof Error ? novelListQuery.error.message : "未知错误"}
            </div>
          ) : null}

          {!novelListQuery.isLoading && !novelListQuery.isError && items.length === 0 ? (
            <div className="py-10 text-center text-sm text-muted-foreground">
              {debouncedKeyword
                ? "没有匹配的小说。"
                : "还没有小说。请先在「小说列表」创建作品。"}
            </div>
          ) : null}

          {overviewQuery.isError ? (
            <div className="flex flex-col gap-2 rounded-xl border border-destructive/40 bg-destructive/5 px-3 py-2 text-sm text-destructive sm:flex-row sm:items-center sm:justify-between">
              <span>
                态势加载失败：
                {overviewQuery.error instanceof Error
                  ? overviewQuery.error.message
                  : "未知错误"}
                。列表仍可打开项目；徽章暂不可用。
              </span>
              <Button
                type="button"
                size="sm"
                variant="outline"
                className="shrink-0"
                onClick={() => void overviewQuery.refetch()}
              >
                重试态势
              </Button>
            </div>
          ) : null}

          {overviewQuery.data?.truncated ? (
            <div className="rounded-xl border border-border/70 bg-muted/30 px-3 py-2 text-xs leading-5 text-muted-foreground">
              本页请求超过服务端态势上限（50 本），仅展示前 50 本态势；请分页查看。
            </div>
          ) : null}

          <div className="space-y-3">
            {items.map((novel) => {
              const overview = overviewById.get(novel.id);
              const badges = resolveAudiobookWorkspaceBadges(overview);
              return (
                <div
                  key={novel.id}
                  className="flex flex-col gap-3 rounded-xl border border-border/70 bg-muted/20 p-4 sm:flex-row sm:items-center sm:justify-between"
                >
                  <div className="min-w-0 space-y-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <div className="truncate text-sm font-semibold text-foreground">{novel.title}</div>
                      {novel.status ? (
                        <Badge variant="outline" className="text-[10px]">
                          {novel.status}
                        </Badge>
                      ) : null}
                      {badges.primary ? (
                        <Badge variant={badges.primary.variant} className="text-[10px]">
                          {badges.primary.label}
                        </Badge>
                      ) : overviewQuery.isError ? (
                        <Badge variant="outline" className="text-[10px] text-muted-foreground">
                          态势失败
                        </Badge>
                      ) : overviewQuery.isFetching && !overviewQuery.data ? (
                        <Badge variant="outline" className="text-[10px] text-muted-foreground">
                          态势…
                        </Badge>
                      ) : null}
                      {badges.secondary.map((badge) => (
                        <Badge key={badge.label} variant={badge.variant} className="text-[10px]">
                          {badge.label}
                        </Badge>
                      ))}
                    </div>
                    <div className="line-clamp-2 text-xs leading-5 text-muted-foreground">
                      {novel.description?.trim() || "暂无简介"}
                    </div>
                  </div>
                  <div className="flex shrink-0 flex-wrap gap-2">
                    <Button type="button" size="sm" asChild>
                      <Link to={`/audiobook/novels/${novel.id}`}>打开有声书</Link>
                    </Button>
                    <Button type="button" size="sm" variant="outline" asChild>
                      <Link to={`/novels/${novel.id}/edit`}>编辑小说</Link>
                    </Button>
                  </div>
                </div>
              );
            })}
          </div>

          {totalPages > 1 ? (
            <div className="flex items-center justify-between gap-2 pt-2">
              <Button
                type="button"
                size="sm"
                variant="outline"
                disabled={page <= 1 || novelListQuery.isFetching}
                onClick={() => setPage((prev) => Math.max(1, prev - 1))}
              >
                上一页
              </Button>
              <div className="text-xs text-muted-foreground">
                第 {page} / {totalPages} 页
              </div>
              <Button
                type="button"
                size="sm"
                variant="outline"
                disabled={page >= totalPages || novelListQuery.isFetching}
                onClick={() => setPage((prev) => Math.min(totalPages, prev + 1))}
              >
                下一页
              </Button>
            </div>
          ) : null}
        </CardContent>
      </Card>
    </div>
  );
}
