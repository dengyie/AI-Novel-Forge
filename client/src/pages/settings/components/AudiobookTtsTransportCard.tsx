import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { LLMProvider } from "@ai-novel/shared/types/llm";
import {
  getAPIKeySettings,
  getAudiobookTtsTransportSettings,
  saveAudiobookTtsTransportSettings,
  type APIKeyStatus,
  type AudiobookTtsTransportStatus,
} from "@/api/settings";
import { queryKeys } from "@/api/queryKeys";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { AUTO_DIRECTOR_MOBILE_CLASSES } from "@/mobile/autoDirector";

const SOURCE_LABEL: Record<string, string> = {
  setting: "设置中心",
  secret: "模型厂商库",
  env: "环境变量",
  default: "内置默认",
  none: "未配置",
  override: "调用覆盖",
  "fallback-openai": "openai 兜底",
  "fallback-deepseek": "deepseek 兜底",
};

function sourceBadge(source: string | undefined): string {
  if (!source) return "—";
  return SOURCE_LABEL[source] ?? source;
}

export default function AudiobookTtsTransportCard() {
  const queryClient = useQueryClient();
  /** 表单存「库内覆盖」意图；与 status 生效值分离，避免 env 被误钉进库 */
  const [boundProviderDraft, setBoundProviderDraft] = useState<string | null>(null);
  const [primaryBaseURL, setPrimaryBaseURL] = useState("");
  const [fallbackBaseUrls, setFallbackBaseUrls] = useState("");
  const [timeoutMsDraft, setTimeoutMsDraft] = useState("");
  const [feedback, setFeedback] = useState("");
  /** 用户是否改过字段；未改则保存时不写对应字段 */
  const [timeoutTouched, setTimeoutTouched] = useState(false);
  const [boundTouched, setBoundTouched] = useState(false);
  const [primaryTouched, setPrimaryTouched] = useState(false);
  const [fallbackTouched, setFallbackTouched] = useState(false);

  const transportQuery = useQuery({
    queryKey: queryKeys.settings.audiobookTtsTransport,
    queryFn: getAudiobookTtsTransportSettings,
  });

  const providersQuery = useQuery({
    queryKey: queryKeys.settings.apiKeys,
    queryFn: getAPIKeySettings,
  });

  const status = transportQuery.data?.data as AudiobookTtsTransportStatus | undefined;
  const providers: APIKeyStatus[] = providersQuery.data?.data ?? [];

  const providerOptions = useMemo(() => {
    const list = providers.map((p) => ({
      id: p.provider as string,
      label: `${p.displayName || p.name || p.provider}${p.isConfigured ? "" : "（未配密钥）"}`,
      configured: p.isConfigured,
    }));
    if (status?.boundProvider && !list.some((item) => item.id === status.boundProvider)) {
      list.unshift({
        id: status.boundProvider,
        label: `${status.boundProvider}（当前绑定）`,
        configured: status.hasApiKey,
      });
    }
    if (list.length === 0) {
      list.push({ id: "openai", label: "openai", configured: false });
    }
    return list;
  }, [providers, status?.boundProvider, status?.hasApiKey]);

  useEffect(() => {
    if (!status) return;
    if (!boundTouched) {
      setBoundProviderDraft(
        status.boundProviderSource === "setting" ? status.boundProvider : null,
      );
    }
    if (!primaryTouched) {
      setPrimaryBaseURL(status.primaryBaseURLOverride ?? "");
    }
    if (!fallbackTouched) {
      setFallbackBaseUrls(
        status.fallbackBaseUrlsSource === "setting"
          ? (status.fallbackBaseUrlsRaw ?? "")
          : "",
      );
    }
    if (!timeoutTouched) {
      setTimeoutMsDraft(
        status.timeoutMsSource === "setting" && status.timeoutMsOverride != null
          ? String(status.timeoutMsOverride)
          : "",
      );
    }
  }, [status, boundTouched, primaryTouched, fallbackTouched, timeoutTouched]);

  const selectValue = boundProviderDraft
    ?? status?.boundProvider
    ?? "openai";

  const saveMutation = useMutation({
    mutationFn: () => {
      const payload: {
        boundProvider?: string | null;
        primaryBaseURL?: string | null;
        fallbackBaseUrls?: string | null;
        timeoutMs?: number | null;
      } = {};
      if (boundTouched) {
        payload.boundProvider = boundProviderDraft?.trim() || null;
      }
      if (primaryTouched) {
        payload.primaryBaseURL = primaryBaseURL.trim() ? primaryBaseURL.trim() : null;
      }
      if (fallbackTouched) {
        payload.fallbackBaseUrls = fallbackBaseUrls.trim() ? fallbackBaseUrls.trim() : null;
      }
      if (timeoutTouched) {
        const raw = timeoutMsDraft.trim();
        payload.timeoutMs = raw ? Number(raw) : null;
      }
      if (
        payload.boundProvider === undefined
        && payload.primaryBaseURL === undefined
        && payload.fallbackBaseUrls === undefined
        && payload.timeoutMs === undefined
      ) {
        return Promise.reject(new Error("没有改动可保存。修改字段后再保存，或使用「清除库内覆盖」。"));
      }
      return saveAudiobookTtsTransportSettings(payload);
    },
    onSuccess: async (response) => {
      setFeedback(response.message ?? "有声书 TTS 运输设置保存成功。");
      setBoundTouched(false);
      setPrimaryTouched(false);
      setFallbackTouched(false);
      setTimeoutTouched(false);
      await queryClient.invalidateQueries({ queryKey: queryKeys.settings.audiobookTtsTransport });
    },
    onError: (error) => {
      setFeedback(error instanceof Error ? error.message : "有声书 TTS 运输设置保存失败。");
    },
  });

  const clearOverridesMutation = useMutation({
    mutationFn: () =>
      saveAudiobookTtsTransportSettings({
        boundProvider: null,
        primaryBaseURL: null,
        fallbackBaseUrls: null,
        timeoutMs: null,
      }),
    onSuccess: async (response) => {
      setFeedback(response.message ?? "已清除库内覆盖，回落 env/默认。");
      setBoundTouched(false);
      setPrimaryTouched(false);
      setFallbackTouched(false);
      setTimeoutTouched(false);
      await queryClient.invalidateQueries({ queryKey: queryKeys.settings.audiobookTtsTransport });
    },
    onError: (error) => {
      setFeedback(error instanceof Error ? error.message : "清除失败。");
    },
  });

  const timeoutOk = (() => {
    if (!timeoutMsDraft.trim()) return true;
    const n = Number(timeoutMsDraft);
    return Number.isFinite(n) && n >= 10_000 && n <= 600_000;
  })();

  const hasLocalEdits = boundTouched || primaryTouched || fallbackTouched || timeoutTouched;

  return (
    <Card id="settings-audiobook-tts-transport" className="min-w-0 scroll-mt-20 overflow-hidden">
      <CardHeader className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0 space-y-1">
          <CardTitle>有声书 TTS 运输</CardTitle>
          <CardDescription className={AUTO_DIRECTOR_MOBILE_CLASSES.wrapText}>
            绑定用于 MiMo chat-audio 合成的模型厂商与主链/备链 URL。
            <strong className="font-medium"> API 密钥仍在「模型厂商」中配置</strong>
            ；此处不存密钥。库内设置优先于环境变量。
            主链 baseURL 优先级：库内覆盖 → 模型厂商库 → env → 内置默认。
          </CardDescription>
        </div>
        <div className="flex flex-wrap gap-2">
          <Badge variant={status?.hasApiKey ? "default" : "outline"}>
            {status?.hasApiKey ? "密钥就绪" : "密钥未配"}
          </Badge>
          <Badge variant="outline">fallback {status?.fallbackCount ?? 0}</Badge>
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        {transportQuery.isLoading ? (
          <div className="text-sm text-muted-foreground">读取运输设置…</div>
        ) : null}

        {status ? (
          <div className={`rounded-md border bg-muted/20 p-3 text-xs leading-5 text-muted-foreground ${AUTO_DIRECTOR_MOBILE_CLASSES.wrapText}`}>
            <div>
              生效绑定：
              <span className="font-medium text-foreground"> {status.boundProvider}</span>
              （{sourceBadge(status.boundProviderSource)}）
            </div>
            <div>
              生效主链：
              <span className="font-medium text-foreground"> {status.primaryBaseURL || "—"}</span>
              （{sourceBadge(status.primaryBaseURLSource)}
              {status.primaryBaseURLSource === "secret"
                ? " · 与模型厂商库一致，非 env"
                : ""}
              ）
            </div>
            <div>
              密钥：
              {sourceBadge(status.apiKeySource)}
              {status.apiKeyFromProvider && status.apiKeyFromProvider !== status.boundProvider
                ? `（来自 ${status.apiKeyFromProvider}）`
                : ""}
              {status.boundApiKeySource === "none" && status.hasApiKey
                ? " · 绑定厂商自身无 key，已用 CPA 互兜"
                : ""}
              {status.secretBaseURL ? ` · 厂商库 baseURL：${status.secretBaseURL}` : ""}
            </div>
            <div>
              fallback 来源：{sourceBadge(status.fallbackBaseUrlsSource)}
              {status.fallbackBaseUrlsRaw && status.fallbackBaseUrlsSource !== "setting"
                ? ` · env 生效：${status.fallbackBaseUrlsRaw}`
                : ""}
            </div>
            <div>
              超时：{status.timeoutMs} ms（{sourceBadge(status.timeoutMsSource)}）
            </div>
          </div>
        ) : null}

        <div className="grid min-w-0 gap-3 md:grid-cols-2">
          <label className="min-w-0 space-y-1.5 text-sm">
            <span className="font-medium">绑定厂商（库内覆盖）</span>
            <select
              className="flex h-9 w-full rounded-md border border-input bg-background px-3 py-1 text-sm shadow-sm"
              value={selectValue}
              onChange={(event) => {
                setFeedback("");
                setBoundTouched(true);
                setBoundProviderDraft(event.target.value as LLMProvider | string);
              }}
            >
              {providerOptions.map((option) => (
                <option key={option.id} value={option.id}>
                  {option.label}
                </option>
              ))}
            </select>
            <span className={`block text-xs text-muted-foreground ${AUTO_DIRECTOR_MOBILE_CLASSES.wrapText}`}>
              当前生效：{status?.boundProvider ?? "—"}（{sourceBadge(status?.boundProviderSource)}）。
              仅在改选并保存后写入库；未改保存不会把 env 钉进库。
            </span>
          </label>

          <label className="min-w-0 space-y-1.5 text-sm">
            <span className="font-medium">超时覆盖（毫秒，可选）</span>
            <Input
              type="number"
              min={10_000}
              max={600_000}
              step={1000}
              placeholder={
                status
                  ? `生效 ${status.timeoutMs}（${sourceBadge(status.timeoutMsSource)}）；留空=不写库/清除`
                  : "留空使用 env/默认"
              }
              value={timeoutMsDraft}
              onChange={(event) => {
                setFeedback("");
                setTimeoutTouched(true);
                setTimeoutMsDraft(event.target.value);
              }}
            />
            <span className="block text-xs text-muted-foreground">
              范围 10000–600000。留空并保存可清除库内覆盖，回落 env/默认。
            </span>
          </label>
        </div>

        <label className="block min-w-0 space-y-1.5 text-sm">
          <span className="font-medium">主链 baseURL 覆盖（可选）</span>
          <Input
            placeholder="留空则使用厂商库 / env / 内置默认"
            value={primaryBaseURL}
            onChange={(event) => {
              setFeedback("");
              setPrimaryTouched(true);
              setPrimaryBaseURL(event.target.value);
            }}
          />
        </label>

        <label className="block min-w-0 space-y-1.5 text-sm">
          <span className="font-medium">Fallback baseURL 列表（可选）</span>
          <textarea
            className="flex min-h-[88px] w-full rounded-md border border-input bg-background px-3 py-2 text-sm shadow-sm"
            placeholder={"逗号或换行分隔，例如：\nhttps://backup.example/v1"}
            value={fallbackBaseUrls}
            onChange={(event) => {
              setFeedback("");
              setFallbackTouched(true);
              setFallbackBaseUrls(event.target.value);
            }}
          />
          <span className={`block text-xs text-muted-foreground ${AUTO_DIRECTOR_MOBILE_CLASSES.wrapText}`}>
            写入后优先于 env {status?.envBootstrapHints.fallbackBaseUrlsEnv ?? "AUDIOBOOK_MIMO_TTS_FALLBACK_BASE_URLS"}。
            Fallback 密钥仍只用 env {status?.envBootstrapHints.fallbackApiKeysEnv ?? "AUDIOBOOK_MIMO_TTS_FALLBACK_API_KEYS"}（按位对齐）。
          </span>
        </label>

        {!timeoutOk ? (
          <div className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-900">
            超时需在 10000–600000 毫秒之间，或留空。
          </div>
        ) : null}

        <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-end">
          <Button
            variant="outline"
            className="w-full sm:w-auto"
            disabled={clearOverridesMutation.isPending || saveMutation.isPending || transportQuery.isLoading}
            onClick={() => {
              setFeedback("");
              clearOverridesMutation.mutate();
            }}
          >
            {clearOverridesMutation.isPending ? "清除中…" : "清除库内覆盖"}
          </Button>
          <Button
            className="w-full sm:w-auto"
            disabled={
              !timeoutOk
              || !hasLocalEdits
              || saveMutation.isPending
              || clearOverridesMutation.isPending
              || transportQuery.isLoading
            }
            onClick={() => {
              setFeedback("");
              saveMutation.mutate();
            }}
          >
            {saveMutation.isPending ? "保存中…" : "保存运输设置"}
          </Button>
        </div>

        {feedback ? (
          <div className={`text-sm text-muted-foreground ${AUTO_DIRECTOR_MOBILE_CLASSES.wrapText}`}>{feedback}</div>
        ) : null}
      </CardContent>
    </Card>
  );
}
