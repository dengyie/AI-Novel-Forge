import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowLeft, Library, Loader2, RefreshCw, Search } from "lucide-react";
import type { VoiceAsset, VoiceAssetStatus } from "@ai-novel/shared/types/audiobook";
import {
  getVoiceLibraryAsset,
  importVoiceLibraryFile,
  importVoiceLibrarySeedPack,
  listVoiceLibrary,
} from "@/api/novel/audiobook";
import { queryKeys } from "@/api/queryKeys";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

const PAGE_SIZE = 30;
const SEARCH_DEBOUNCE_MS = 300;

type StatusFilter = "all" | VoiceAssetStatus;

function statusBadgeVariant(status: VoiceAssetStatus): "default" | "secondary" | "outline" | "destructive" {
  if (status === "approved") return "default";
  if (status === "draft") return "secondary";
  if (status === "archived" || status === "deprecated") return "outline";
  return "secondary";
}

function formatError(error: unknown): string {
  if (error instanceof Error && error.message.trim()) return error.message;
  return "未知错误";
}

export default function VoiceLibraryAdminPage() {
  const queryClient = useQueryClient();
  const [keyword, setKeyword] = useState("");
  const [debouncedKeyword, setDebouncedKeyword] = useState("");
  const [statusFilter, setStatusFilter] = useState<StatusFilter>("all");
  const [offset, setOffset] = useState(0);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [actionMessage, setActionMessage] = useState("");

  const [importSourcePath, setImportSourcePath] = useState("");
  const [importSlug, setImportSlug] = useState("");
  const [importDisplayName, setImportDisplayName] = useState("");
  const [importLicenseSource, setImportLicenseSource] = useState("ops-import");
  const [importLicenseRights, setImportLicenseRights] = useState("internal-test-only");
  const [importOverwrite, setImportOverwrite] = useState(false);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      setDebouncedKeyword(keyword.trim());
      setOffset(0);
    }, SEARCH_DEBOUNCE_MS);
    return () => window.clearTimeout(timer);
  }, [keyword]);

  useEffect(() => {
    setOffset(0);
  }, [statusFilter]);

  const listParamsKey = useMemo(
    () =>
      JSON.stringify({
        status: statusFilter,
        q: debouncedKeyword,
        limit: PAGE_SIZE,
        offset,
        kind: "clone_ref",
      }),
    [statusFilter, debouncedKeyword, offset],
  );

  const listQuery = useQuery({
    queryKey: queryKeys.novels.voiceLibrary(`admin:${listParamsKey}`),
    queryFn: async () => {
      const response = await listVoiceLibrary({
        status: statusFilter === "all" ? undefined : statusFilter,
        kind: "clone_ref",
        q: debouncedKeyword || undefined,
        limit: PAGE_SIZE,
        offset,
      });
      return {
        items: (response.data?.items ?? []) as VoiceAsset[],
        total: response.data?.total ?? 0,
      };
    },
    staleTime: 15_000,
  });

  const items = listQuery.data?.items ?? [];
  const total = listQuery.data?.total ?? 0;
  const page = Math.floor(offset / PAGE_SIZE) + 1;
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));

  const detailQuery = useQuery({
    queryKey: queryKeys.novels.voiceLibrary(`detail:${selectedId || ""}`),
    queryFn: async () => {
      if (!selectedId) return null;
      const response = await getVoiceLibraryAsset(selectedId);
      return (response.data ?? null) as VoiceAsset | null;
    },
    enabled: Boolean(selectedId),
    staleTime: 10_000,
  });

  const invalidateLibrary = async () => {
    await queryClient.invalidateQueries({ queryKey: ["novels", "voice-library"] });
  };

  const importFileMutation = useMutation({
    mutationFn: () =>
      importVoiceLibraryFile({
        sourcePath: importSourcePath.trim(),
        slug: importSlug.trim(),
        displayName: importDisplayName.trim() || importSlug.trim(),
        status: "draft",
        license: {
          source: importLicenseSource.trim() || "ops-import",
          rights: importLicenseRights.trim() || "internal-test-only",
        },
        overwrite: importOverwrite,
      }),
    onSuccess: async (response) => {
      const asset = response.data;
      setActionMessage(
        asset
          ? `已导入 draft：${asset.displayName}（${asset.id}）。人耳确认后请用 API PATCH status=approved。`
          : "导入成功。",
      );
      setImportSourcePath("");
      setImportSlug("");
      setImportDisplayName("");
      await invalidateLibrary();
      if (asset?.id) setSelectedId(asset.id);
    },
    onError: (error) => {
      setActionMessage(`导入失败：${formatError(error)}`);
    },
  });

  const importSeedMutation = useMutation({
    mutationFn: () =>
      importVoiceLibrarySeedPack({
        overwrite: false,
      }),
    onSuccess: async (response) => {
      const data = response.data;
      const imported = data?.imported?.length ?? 0;
      const skipped = data?.skipped?.length ?? 0;
      const failed = data?.failed?.length ?? 0;
      setActionMessage(
        `种子包 ${data?.packId || "?"}：imported=${imported} skipped=${skipped} failed=${failed}（均为 draft，禁 auto-approve）。`,
      );
      await invalidateLibrary();
    },
    onError: (error) => {
      setActionMessage(`种子导入失败：${formatError(error)}`);
    },
  });

  const canImportFile =
    importSourcePath.trim().length > 0
    && importSlug.trim().length > 0
    && importLicenseSource.trim().length > 0
    && importLicenseRights.trim().length > 0
    && !importFileMutation.isPending;

  return (
    <div className="mx-auto max-w-5xl space-y-6 px-4 py-6">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <h1 className="flex items-center gap-2 text-2xl font-semibold">
            <Library className="h-6 w-6 text-primary" />
            全站音色库
          </h1>
          <p className="mt-1 text-sm text-muted-foreground">
            运营浏览 / 筛选 / 导入 draft。合成绑库仅 approved；本页不提供一键 approve。
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button type="button" variant="outline" asChild>
            <Link to="/audiobook">
              <ArrowLeft className="h-4 w-4" />
              有声书工作台
            </Link>
          </Button>
          <Button
            type="button"
            variant="outline"
            onClick={() => void listQuery.refetch()}
            disabled={listQuery.isFetching}
          >
            {listQuery.isFetching ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
            刷新
          </Button>
        </div>
      </div>

      {actionMessage ? (
        <div className="rounded-xl border border-border/70 bg-muted/30 px-3 py-2 text-sm text-foreground">
          {actionMessage}
        </div>
      ) : null}

      <div className="grid gap-4 lg:grid-cols-[1.4fr_1fr]">
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-base">资产列表</CardTitle>
            <CardDescription>
              共 {total} 条 · 第 {page}/{totalPages} 页 · 仅展示 clone_ref
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="flex flex-col gap-2 sm:flex-row">
              <div className="relative flex-1">
                <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
                <Input
                  className="pl-9"
                  placeholder="搜索 slug / 名称 / id / tag…"
                  value={keyword}
                  onChange={(event) => setKeyword(event.target.value)}
                />
              </div>
              <Select
                value={statusFilter}
                onValueChange={(value) => setStatusFilter(value as StatusFilter)}
              >
                <SelectTrigger className="sm:w-40">
                  <SelectValue placeholder="状态" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">全部状态</SelectItem>
                  <SelectItem value="draft">draft</SelectItem>
                  <SelectItem value="approved">approved</SelectItem>
                  <SelectItem value="archived">archived</SelectItem>
                  <SelectItem value="deprecated">deprecated</SelectItem>
                </SelectContent>
              </Select>
            </div>

            {listQuery.isLoading ? (
              <div className="py-10 text-center text-sm text-muted-foreground">加载中…</div>
            ) : null}
            {listQuery.isError ? (
              <div className="py-10 text-center text-sm text-destructive">
                {formatError(listQuery.error)}
              </div>
            ) : null}
            {!listQuery.isLoading && !listQuery.isError && items.length === 0 ? (
              <div className="py-10 text-center text-sm text-muted-foreground">
                无匹配资产。可导入种子包（draft）或服务端 allowlist 路径 WAV。
              </div>
            ) : null}

            <ul className="divide-y divide-border/60 rounded-xl border border-border/60">
              {items.map((asset) => {
                const active = asset.id === selectedId;
                return (
                  <li key={asset.id}>
                    <button
                      type="button"
                      className={`flex w-full flex-col gap-1 px-3 py-3 text-left transition hover:bg-muted/40 ${
                        active ? "bg-muted/50" : ""
                      }`}
                      onClick={() => setSelectedId(asset.id)}
                    >
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="font-medium">{asset.displayName}</span>
                        <Badge variant={statusBadgeVariant(asset.status)}>{asset.status}</Badge>
                        <span className="text-xs text-muted-foreground">{asset.slug}</span>
                      </div>
                      <div className="text-xs text-muted-foreground">
                        {asset.id}
                        {asset.tags?.length ? ` · ${asset.tags.slice(0, 6).join(", ")}` : ""}
                      </div>
                    </button>
                  </li>
                );
              })}
            </ul>

            <div className="flex items-center justify-between gap-2">
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={offset <= 0 || listQuery.isFetching}
                onClick={() => setOffset((value) => Math.max(0, value - PAGE_SIZE))}
              >
                上一页
              </Button>
              <span className="text-xs text-muted-foreground">
                offset {offset} · limit {PAGE_SIZE}
              </span>
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={offset + PAGE_SIZE >= total || listQuery.isFetching}
                onClick={() => setOffset((value) => value + PAGE_SIZE)}
              >
                下一页
              </Button>
            </div>
          </CardContent>
        </Card>

        <div className="space-y-4">
          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="text-base">详情</CardTitle>
              <CardDescription>相对路径展示；不提供任意绝对路径写回。</CardDescription>
            </CardHeader>
            <CardContent className="space-y-2 text-sm">
              {!selectedId ? (
                <p className="text-muted-foreground">点选左侧资产查看详情。</p>
              ) : detailQuery.isLoading ? (
                <p className="text-muted-foreground">加载详情…</p>
              ) : detailQuery.isError ? (
                <p className="text-destructive">{formatError(detailQuery.error)}</p>
              ) : detailQuery.data ? (
                <>
                  <div><span className="text-muted-foreground">名称</span> · {detailQuery.data.displayName}</div>
                  <div><span className="text-muted-foreground">slug</span> · {detailQuery.data.slug}</div>
                  <div><span className="text-muted-foreground">id</span> · {detailQuery.data.id}</div>
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="text-muted-foreground">状态</span>
                    <Badge variant={statusBadgeVariant(detailQuery.data.status)}>
                      {detailQuery.data.status}
                    </Badge>
                  </div>
                  <div>
                    <span className="text-muted-foreground">license</span>
                    {" · "}
                    {detailQuery.data.license?.source || "—"} / {detailQuery.data.license?.rights || "—"}
                  </div>
                  <div>
                    <span className="text-muted-foreground">primaryFile</span>
                    {" · "}
                    {detailQuery.data.primaryFile?.path || "—"}
                  </div>
                  <div>
                    <span className="text-muted-foreground">tags</span>
                    {" · "}
                    {(detailQuery.data.tags || []).join(", ") || "—"}
                  </div>
                  <div className="text-xs text-muted-foreground">
                    updated {detailQuery.data.updatedAt}
                  </div>
                  {detailQuery.data.status === "draft" ? (
                    <p className="rounded-lg border border-border/60 bg-muted/20 px-2 py-1.5 text-xs text-muted-foreground">
                      draft 不可绑角色。人耳试听通过后使用
                      {" "}
                      <code className="text-[11px]">PATCH /api/novels/audiobook/voice-library/:id/status</code>
                      {" "}
                      设为 approved（Milestone E 将补库级试听 UI）。
                    </p>
                  ) : null}
                </>
              ) : (
                <p className="text-muted-foreground">资产不存在。</p>
              )}
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="text-base">导入种子包</CardTitle>
              <CardDescription>
                默认包 docs/voice-packs/05-yuanworld-seed-from-mimo · 恒 draft · 禁 force approved
              </CardDescription>
            </CardHeader>
            <CardContent>
              <Button
                type="button"
                onClick={() => {
                  setActionMessage("");
                  importSeedMutation.mutate();
                }}
                disabled={importSeedMutation.isPending}
              >
                {importSeedMutation.isPending ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : null}
                导入 yuanworld 种子（draft）
              </Button>
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="text-base">从服务端路径导入 WAV</CardTitle>
              <CardDescription>
                sourcePath 须在服务端 allowlist（data / voice-refs / docs/voice-packs / tmp）。
                固定以 draft 入库，无 approved 选项。
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-3">
              <Input
                placeholder="sourcePath（服务器绝对/相对路径）"
                value={importSourcePath}
                onChange={(event) => setImportSourcePath(event.target.value)}
              />
              <div className="grid gap-2 sm:grid-cols-2">
                <Input
                  placeholder="slug"
                  value={importSlug}
                  onChange={(event) => setImportSlug(event.target.value)}
                />
                <Input
                  placeholder="displayName（可空=slug）"
                  value={importDisplayName}
                  onChange={(event) => setImportDisplayName(event.target.value)}
                />
              </div>
              <div className="grid gap-2 sm:grid-cols-2">
                <Input
                  placeholder="license.source"
                  value={importLicenseSource}
                  onChange={(event) => setImportLicenseSource(event.target.value)}
                />
                <Input
                  placeholder="license.rights"
                  value={importLicenseRights}
                  onChange={(event) => setImportLicenseRights(event.target.value)}
                />
              </div>
              <label className="flex items-center gap-2 text-sm text-muted-foreground">
                <input
                  type="checkbox"
                  checked={importOverwrite}
                  onChange={(event) => setImportOverwrite(event.target.checked)}
                />
                overwrite 同 slug
              </label>
              <Button
                type="button"
                disabled={!canImportFile}
                onClick={() => {
                  setActionMessage("");
                  importFileMutation.mutate();
                }}
              >
                {importFileMutation.isPending ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : null}
                导入为 draft
              </Button>
            </CardContent>
          </Card>
        </div>
      </div>
    </div>
  );
}
