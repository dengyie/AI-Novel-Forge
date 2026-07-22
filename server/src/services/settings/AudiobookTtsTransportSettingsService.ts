import type { LLMProvider } from "@ai-novel/shared/types/llm";
import { prisma } from "../../db/prisma";
import {
  getProviderDefaultBaseUrl,
  getProviderEnvApiKey,
  getProviderEnvBaseUrl,
  isBuiltInProvider,
  normalizeBaseURL,
  providerRequiresApiKey,
} from "../../llm/providers";
import { AppError } from "../../middleware/errorHandler";
import { parseMimoTtsFallbackBaseUrls } from "../audiobook/mimoTtsEndpointParse";
import { isMissingTableError, normalizeOptionalText } from "./ragLegacyCompatibility";
import { secretStore } from "./secretStore";
import {
  AUDIOBOOK_TTS_BOUND_PROVIDER_KEY,
  AUDIOBOOK_TTS_FALLBACK_BASE_URLS_KEY,
  AUDIOBOOK_TTS_PRIMARY_BASE_URL_KEY,
  AUDIOBOOK_TTS_TIMEOUT_MS_KEY,
  AUDIOBOOK_TTS_TRANSPORT_SETTING_KEYS,
  DEFAULT_AUDIOBOOK_TTS_BOUND_PROVIDER,
  DEFAULT_AUDIOBOOK_TTS_TIMEOUT_MS,
  ENV_AUDIOBOOK_TTS_FALLBACK_API_KEYS,
  ENV_AUDIOBOOK_TTS_FALLBACK_BASE_URLS,
  ENV_AUDIOBOOK_TTS_PROVIDER,
  ENV_AUDIOBOOK_TTS_TIMEOUT_MS,
  MAX_AUDIOBOOK_TTS_TIMEOUT_MS,
  MIN_AUDIOBOOK_TTS_TIMEOUT_MS,
} from "./audiobookTtsSettingKeys";

export type AudiobookTtsBaseUrlSource = "setting" | "secret" | "env" | "default";

/** openai/deepseek 历史同 CPA 部署可互兜；其它绑定厂商不跨厂借 key */
const CPA_KEY_FALLBACK_PROVIDERS = ["openai", "deepseek"] as const;

export interface AudiobookTtsTransportStoredSettings {
  /** 库内绑定；空 = 未写库 */
  boundProvider: string | null;
  /** 库内 primary baseURL 覆盖；空 = 未写库 */
  primaryBaseURL: string | null;
  /** 库内 fallback 原始串（逗号/换行）；空 = 未写库 */
  fallbackBaseUrlsRaw: string | null;
  /** 库内 timeout；null = 未写库 */
  timeoutMs: number | null;
}

export interface AudiobookTtsTransportSettingsInput {
  boundProvider?: string | null;
  /** 传 "" 或 null 清除库内覆盖 */
  primaryBaseURL?: string | null;
  /** 传 "" 或 null 清除库内 fallback */
  fallbackBaseUrls?: string | null;
  /** 传 null 清除库内 timeout */
  timeoutMs?: number | null;
}

export type AudiobookTtsApiKeySource =
  | "secret"
  | "env"
  | "fallback-openai"
  | "fallback-deepseek"
  | "none";

export interface AudiobookTtsTransportStatus {
  boundProvider: string;
  boundProviderSource: "setting" | "env" | "default";
  /** 解析后的主链 baseURL（可能仍为空若无任何来源） */
  primaryBaseURL: string | null;
  primaryBaseURLSource: AudiobookTtsBaseUrlSource | "none";
  /** 库内覆盖值（未解析默认） */
  primaryBaseURLOverride: string | null;
  /** 库内 timeout 覆盖；null = 未写库（表单勿把 env 生效值钉回库） */
  timeoutMsOverride: number | null;
  fallbackBaseUrlsRaw: string | null;
  fallbackBaseUrlsSource: "setting" | "env" | "none";
  fallbackCount: number;
  timeoutMs: number;
  timeoutMsSource: "setting" | "env" | "default";
  /** 合成实际可用的 key 是否存在（含受限兜底） */
  hasApiKey: boolean;
  /** 绑定厂商自身 key 来源（不含跨厂兜底） */
  boundApiKeySource: "secret" | "env" | "none";
  /** 合成实际采用的 key 来源 */
  apiKeySource: AudiobookTtsApiKeySource;
  /** 实际提供 key 的厂商 id（可能与 bound 不同，仅 openai↔deepseek 兜底） */
  apiKeyFromProvider: string | null;
  /** 绑定厂商是否在 SecretStore 有记录 */
  secretRecordPresent: boolean;
  secretBaseURL: string | null;
  envBootstrapHints: {
    boundProviderEnv: string;
    fallbackBaseUrlsEnv: string;
    fallbackApiKeysEnv: string;
    timeoutMsEnv: string;
  };
}

/**
 * 进程内缓存：供 hasEffectiveMimoTtsMultiEndpointChain 同步路径读取 AppSetting/Secret 生效值。
 * 首次 resolve/get/save/warm 后更新；冷启动未加载前仍看 env（与历史一致）。
 * env 来源不写缓存，始终 live 读 process.env。
 * transportCacheWarmed：ensure* 只在冷时读库，避免每 chunk 打 DB。
 */
let cachedBoundProvider: string | undefined;
let cachedFallbackBaseUrlsRaw: string | null | undefined;
let cachedPrimaryBaseURL: string | null | undefined;
let transportCacheWarmed = false;

export function getCachedAudiobookTtsBoundProvider(): string | undefined {
  return cachedBoundProvider;
}

export function getCachedAudiobookTtsFallbackBaseUrlsRaw(): string | null | undefined {
  return cachedFallbackBaseUrlsRaw;
}

export function getCachedAudiobookTtsPrimaryBaseURL(): string | null | undefined {
  return cachedPrimaryBaseURL;
}

/**
 * 丢弃进程缓存（api-keys 变更 / 测试）。
 * 下次 get/status/synthesize/warm 会重新灌入 setting/secret 结果。
 */
export function invalidateAudiobookTtsTransportCache(): void {
  cachedBoundProvider = undefined;
  cachedFallbackBaseUrlsRaw = undefined;
  cachedPrimaryBaseURL = undefined;
  transportCacheWarmed = false;
}

/** @internal 测试用 */
export function __resetAudiobookTtsTransportCacheForTests(): void {
  invalidateAudiobookTtsTransportCache();
}

function clampTimeoutMs(value: number, fallback: number): number {
  if (!Number.isFinite(value)) {
    return fallback;
  }
  return Math.max(
    MIN_AUDIOBOOK_TTS_TIMEOUT_MS,
    Math.min(MAX_AUDIOBOOK_TTS_TIMEOUT_MS, Math.floor(value)),
  );
}

function getEnvBoundProvider(): string | undefined {
  return normalizeOptionalText(process.env[ENV_AUDIOBOOK_TTS_PROVIDER]);
}

function getEnvFallbackBaseUrlsRaw(): string | undefined {
  return normalizeOptionalText(process.env[ENV_AUDIOBOOK_TTS_FALLBACK_BASE_URLS]);
}

function getEnvTimeoutMs(): number | undefined {
  const raw = process.env[ENV_AUDIOBOOK_TTS_TIMEOUT_MS];
  if (raw == null || !String(raw).trim()) {
    return undefined;
  }
  const n = Number(raw);
  if (!Number.isFinite(n)) {
    return undefined;
  }
  return clampTimeoutMs(n, DEFAULT_AUDIOBOOK_TTS_TIMEOUT_MS);
}

function assertHttpBaseURL(value: string, label: string): void {
  try {
    const parsed = new URL(value);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      throw new Error("protocol");
    }
  } catch {
    throw new AppError(`${label} 格式不正确：${value}`, 400);
  }
}

function serializeFallbackBaseUrls(raw: string | null | undefined): string | null {
  const urls = parseMimoTtsFallbackBaseUrls(raw);
  if (urls.length === 0) {
    return null;
  }
  for (const url of urls) {
    assertHttpBaseURL(url, "fallback baseURL");
  }
  // 保留槽位顺序；用逗号写回，parse 侧兼容
  return urls.join(",");
}

function normalizeStoredBaseURL(value: string | null | undefined): string | null {
  const trimmed = normalizeOptionalText(value);
  if (!trimmed) {
    return null;
  }
  return normalizeBaseURL(trimmed.replace(/\/+$/, "") || trimmed);
}

async function readStoredSettings(): Promise<AudiobookTtsTransportStoredSettings> {
  const empty: AudiobookTtsTransportStoredSettings = {
    boundProvider: null,
    primaryBaseURL: null,
    fallbackBaseUrlsRaw: null,
    timeoutMs: null,
  };
  try {
    const records = await prisma.appSetting.findMany({
      where: { key: { in: [...AUDIOBOOK_TTS_TRANSPORT_SETTING_KEYS] } },
    });
    const map = new Map(records.map((row) => [row.key, row.value]));
    const timeoutRaw = map.get(AUDIOBOOK_TTS_TIMEOUT_MS_KEY);
    const timeoutParsed = timeoutRaw != null && String(timeoutRaw).trim()
      ? Number(timeoutRaw)
      : Number.NaN;
    return {
      boundProvider: normalizeOptionalText(map.get(AUDIOBOOK_TTS_BOUND_PROVIDER_KEY)) ?? null,
      primaryBaseURL: normalizeStoredBaseURL(map.get(AUDIOBOOK_TTS_PRIMARY_BASE_URL_KEY)),
      fallbackBaseUrlsRaw: normalizeOptionalText(map.get(AUDIOBOOK_TTS_FALLBACK_BASE_URLS_KEY)) ?? null,
      timeoutMs: Number.isFinite(timeoutParsed)
        ? clampTimeoutMs(timeoutParsed, DEFAULT_AUDIOBOOK_TTS_TIMEOUT_MS)
        : null,
    };
  } catch (error) {
    if (isMissingTableError(error)) {
      return empty;
    }
    throw error;
  }
}

/**
 * 仅缓存 AppSetting / Secret 解析结果，供同步 hasEffective* 使用。
 * env 来源不写缓存，始终 live 读 process.env，避免测试/热改 env 被脏缓存钉死。
 */
function updateRuntimeCache(input: {
  boundProvider: string;
  boundSource: "override" | "setting" | "env" | "default";
  fallbackBaseUrlsRaw: string | null;
  fallbackSource: "setting" | "env" | "none";
  primaryBaseURL: string | null;
  primarySource: AudiobookTtsBaseUrlSource | "none";
}): void {
  if (input.boundSource === "setting") {
    cachedBoundProvider = input.boundProvider;
  } else {
    cachedBoundProvider = undefined;
  }
  if (input.fallbackSource === "setting") {
    cachedFallbackBaseUrlsRaw = input.fallbackBaseUrlsRaw;
  } else {
    cachedFallbackBaseUrlsRaw = undefined;
  }
  if (input.primarySource === "setting" || input.primarySource === "secret") {
    cachedPrimaryBaseURL = input.primaryBaseURL;
  } else {
    cachedPrimaryBaseURL = undefined;
  }
}

export function resolveBoundProviderId(input?: {
  overrideProvider?: string | null;
  storedBoundProvider?: string | null;
}): { provider: string; source: "override" | "setting" | "env" | "default" } {
  const override = normalizeOptionalText(input?.overrideProvider ?? undefined);
  if (override) {
    return { provider: override, source: "override" };
  }
  const stored = normalizeOptionalText(input?.storedBoundProvider ?? undefined);
  if (stored) {
    return { provider: stored, source: "setting" };
  }
  const fromEnv = getEnvBoundProvider();
  if (fromEnv) {
    return { provider: fromEnv, source: "env" };
  }
  return { provider: DEFAULT_AUDIOBOOK_TTS_BOUND_PROVIDER, source: "default" };
}

/**
 * 同步 probe：库内绑定（缓存）> env > default。
 * 不读 DB；cold 时无 setting 缓存则与 env 行为一致。
 */
export function resolveBoundProviderIdForProbe(): {
  provider: string;
  source: "setting" | "env" | "default";
} {
  if (cachedBoundProvider) {
    return { provider: cachedBoundProvider, source: "setting" };
  }
  const resolved = resolveBoundProviderId({});
  return {
    provider: resolved.provider,
    source: resolved.source === "override" ? "default" : resolved.source,
  };
}

/**
 * 同步 probe 主链 baseURL：入参 > setting/secret 缓存 > 绑定厂商 env/default。
 * **不再硬编码 openai**，避免 bound≠openai 时 outer retry 门禁误判。
 */
export function resolvePrimaryBaseURLForProbe(explicit?: string | null): string {
  const fromInput = typeof explicit === "string" ? explicit.trim() : "";
  if (fromInput) {
    return fromInput.replace(/\/+$/, "");
  }
  const cached = getCachedAudiobookTtsPrimaryBaseURL();
  if (cached !== undefined) {
    return (cached ?? "").trim().replace(/\/+$/, "");
  }
  const { provider } = resolveBoundProviderIdForProbe();
  if (isBuiltInProvider(provider)) {
    const envUrl = getProviderEnvBaseUrl(provider);
    if (envUrl) {
      return envUrl.replace(/\/+$/, "");
    }
    const def = getProviderDefaultBaseUrl(provider);
    if (def) {
      return def.replace(/\/+$/, "");
    }
  }
  return "";
}

export function resolveFallbackBaseUrlsRaw(input?: {
  storedFallbackBaseUrlsRaw?: string | null;
}): { raw: string | null; source: "setting" | "env" | "none" } {
  const stored = normalizeOptionalText(input?.storedFallbackBaseUrlsRaw ?? undefined);
  if (stored) {
    return { raw: stored, source: "setting" };
  }
  const fromEnv = getEnvFallbackBaseUrlsRaw();
  if (fromEnv) {
    return { raw: fromEnv, source: "env" };
  }
  return { raw: null, source: "none" };
}

export function resolveTimeoutMs(input?: {
  storedTimeoutMs?: number | null;
}): { timeoutMs: number; source: "setting" | "env" | "default" } {
  if (input?.storedTimeoutMs != null && Number.isFinite(input.storedTimeoutMs)) {
    return {
      timeoutMs: clampTimeoutMs(input.storedTimeoutMs, DEFAULT_AUDIOBOOK_TTS_TIMEOUT_MS),
      source: "setting",
    };
  }
  const fromEnv = getEnvTimeoutMs();
  if (fromEnv != null) {
    return { timeoutMs: fromEnv, source: "env" };
  }
  return { timeoutMs: DEFAULT_AUDIOBOOK_TTS_TIMEOUT_MS, source: "default" };
}

async function loadSecretRecord(provider: string) {
  try {
    return await secretStore.getProvider(provider);
  } catch (error) {
    if (isMissingTableError(error)) {
      return null;
    }
    throw error;
  }
}

export async function resolveProviderApiKey(
  provider: string,
): Promise<{ apiKey: string | undefined; source: "secret" | "env" | "none" }> {
  const secret = await loadSecretRecord(provider);
  if (secret?.isActive && normalizeOptionalText(secret.key)) {
    return { apiKey: secret.key!.trim(), source: "secret" };
  }
  if (isBuiltInProvider(provider)) {
    const envKey = getProviderEnvApiKey(provider);
    if (envKey) {
      return { apiKey: envKey, source: "env" };
    }
  }
  return { apiKey: undefined, source: "none" };
}

/**
 * 主链 key：绑定厂商 secret/env；仅当 bound ∈ {openai, deepseek} 时允许互兜。
 * 避免 siliconflow 主链误用 openai key。
 */
export async function resolveEffectiveMimoTtsApiKey(boundProvider: string): Promise<{
  apiKey: string | undefined;
  boundSource: "secret" | "env" | "none";
  effectiveSource: AudiobookTtsApiKeySource;
  fromProvider: string | null;
}> {
  const boundKey = await resolveProviderApiKey(boundProvider);
  if (boundKey.apiKey) {
    return {
      apiKey: boundKey.apiKey,
      boundSource: boundKey.source,
      effectiveSource: boundKey.source,
      fromProvider: boundProvider,
    };
  }

  const mayCrossFallback = (CPA_KEY_FALLBACK_PROVIDERS as readonly string[]).includes(
    boundProvider,
  );
  if (mayCrossFallback) {
    for (const fallbackProvider of CPA_KEY_FALLBACK_PROVIDERS) {
      if (fallbackProvider === boundProvider) continue;
      const fb = await resolveProviderApiKey(fallbackProvider);
      if (fb.apiKey) {
        return {
          apiKey: fb.apiKey,
          boundSource: "none",
          effectiveSource:
            fallbackProvider === "openai" ? "fallback-openai" : "fallback-deepseek",
          fromProvider: fallbackProvider,
        };
      }
    }
  }

  return {
    apiKey: undefined,
    boundSource: "none",
    effectiveSource: "none",
    fromProvider: null,
  };
}

export async function resolvePrimaryBaseURL(input: {
  provider: string;
  storedPrimaryBaseURL?: string | null;
}): Promise<{
  baseURL: string | null;
  source: AudiobookTtsBaseUrlSource | "none";
  secretBaseURL: string | null;
}> {
  const secret = await loadSecretRecord(input.provider);
  const secretBase = normalizeStoredBaseURL(secret?.baseURL);

  const settingBase = normalizeStoredBaseURL(input.storedPrimaryBaseURL);
  if (settingBase) {
    return {
      baseURL: settingBase,
      source: "setting",
      secretBaseURL: secretBase,
    };
  }

  // SecretStore baseURL 优先于 env（设置中心模型厂商为 SoT 的一部分）
  if (secretBase) {
    return { baseURL: secretBase, source: "secret", secretBaseURL: secretBase };
  }

  if (isBuiltInProvider(input.provider)) {
    const envUrl = getProviderEnvBaseUrl(input.provider as LLMProvider);
    if (envUrl) {
      return { baseURL: envUrl, source: "env", secretBaseURL: null };
    }
    const def = getProviderDefaultBaseUrl(input.provider as LLMProvider);
    if (def) {
      return { baseURL: def, source: "default", secretBaseURL: null };
    }
  }

  return { baseURL: null, source: "none", secretBaseURL: null };
}

function refreshCacheFromResolved(statusLike: {
  boundProvider: string;
  boundSource: "override" | "setting" | "env" | "default";
  fallbackBaseUrlsRaw: string | null;
  fallbackSource: "setting" | "env" | "none";
  primaryBaseURL: string | null;
  primarySource: AudiobookTtsBaseUrlSource | "none";
}): void {
  updateRuntimeCache(statusLike);
}

export async function getAudiobookTtsTransportStatus(): Promise<AudiobookTtsTransportStatus> {
  const stored = await readStoredSettings();
  const bound = resolveBoundProviderId({ storedBoundProvider: stored.boundProvider });
  const fallback = resolveFallbackBaseUrlsRaw({
    storedFallbackBaseUrlsRaw: stored.fallbackBaseUrlsRaw,
  });
  const timeout = resolveTimeoutMs({ storedTimeoutMs: stored.timeoutMs });
  const primary = await resolvePrimaryBaseURL({
    provider: bound.provider,
    storedPrimaryBaseURL: stored.primaryBaseURL,
  });
  const keyInfo = await resolveEffectiveMimoTtsApiKey(bound.provider);
  const secret = await loadSecretRecord(bound.provider);

  const status: AudiobookTtsTransportStatus = {
    boundProvider: bound.provider,
    boundProviderSource: bound.source === "override" ? "default" : bound.source,
    primaryBaseURL: primary.baseURL,
    primaryBaseURLSource: primary.source,
    primaryBaseURLOverride: stored.primaryBaseURL,
    timeoutMsOverride: stored.timeoutMs,
    fallbackBaseUrlsRaw: fallback.raw,
    fallbackBaseUrlsSource: fallback.source,
    fallbackCount: parseMimoTtsFallbackBaseUrls(fallback.raw).length,
    timeoutMs: timeout.timeoutMs,
    timeoutMsSource: timeout.source,
    hasApiKey: Boolean(keyInfo.apiKey),
    boundApiKeySource: keyInfo.boundSource,
    apiKeySource: keyInfo.effectiveSource,
    apiKeyFromProvider: keyInfo.fromProvider,
    secretRecordPresent: secret != null,
    secretBaseURL: primary.secretBaseURL,
    envBootstrapHints: {
      boundProviderEnv: ENV_AUDIOBOOK_TTS_PROVIDER,
      fallbackBaseUrlsEnv: ENV_AUDIOBOOK_TTS_FALLBACK_BASE_URLS,
      fallbackApiKeysEnv: ENV_AUDIOBOOK_TTS_FALLBACK_API_KEYS,
      timeoutMsEnv: ENV_AUDIOBOOK_TTS_TIMEOUT_MS,
    },
  };

  refreshCacheFromResolved({
    boundProvider: bound.provider,
    boundSource: bound.source,
    fallbackBaseUrlsRaw: status.fallbackBaseUrlsRaw,
    fallbackSource: status.fallbackBaseUrlsSource,
    primaryBaseURL: status.primaryBaseURL,
    primarySource: status.primaryBaseURLSource,
  });
  transportCacheWarmed = true;

  return status;
}

/**
 * 灌入 setting/secret 缓存，供 pipeline outer retry 同步 probe。
 * 仅冷缓存时读库；api-keys/transport 变更会 invalidate。
 * 合成主路径也会 refresh；在 maxAttempts 计算前调用可避免 cold 误判。
 */
export async function ensureAudiobookTtsTransportCacheWarm(): Promise<void> {
  if (transportCacheWarmed) {
    return;
  }
  await getAudiobookTtsTransportStatus();
  transportCacheWarmed = true;
}

async function upsertSetting(key: string, value: string | null): Promise<void> {
  try {
    if (value == null || value === "") {
      await prisma.appSetting.deleteMany({ where: { key } });
      return;
    }
    await prisma.appSetting.upsert({
      where: { key },
      update: { value },
      create: { key, value },
    });
  } catch (error) {
    if (!isMissingTableError(error)) {
      throw error;
    }
  }
}

export async function saveAudiobookTtsTransportSettings(
  input: AudiobookTtsTransportSettingsInput,
): Promise<AudiobookTtsTransportStatus> {
  if (input.boundProvider !== undefined) {
    const next = normalizeOptionalText(input.boundProvider ?? undefined);
    if (next) {
      // 允许 builtin 或已存在 custom secret；builtin 不要求已有 secret
      if (!isBuiltInProvider(next)) {
        const exists = await loadSecretRecord(next);
        if (!exists) {
          throw new AppError(
            `绑定厂商「${next}」不存在。请先在「模型厂商」中配置自定义厂商，或选择内置厂商。`,
            400,
          );
        }
      }
      await upsertSetting(AUDIOBOOK_TTS_BOUND_PROVIDER_KEY, next);
    } else {
      await upsertSetting(AUDIOBOOK_TTS_BOUND_PROVIDER_KEY, null);
    }
  }

  if (input.primaryBaseURL !== undefined) {
    const next = normalizeStoredBaseURL(input.primaryBaseURL);
    if (next) {
      assertHttpBaseURL(next, "primaryBaseURL");
      await upsertSetting(AUDIOBOOK_TTS_PRIMARY_BASE_URL_KEY, next);
    } else {
      await upsertSetting(AUDIOBOOK_TTS_PRIMARY_BASE_URL_KEY, null);
    }
  }

  if (input.fallbackBaseUrls !== undefined) {
    const serialized = serializeFallbackBaseUrls(input.fallbackBaseUrls);
    await upsertSetting(AUDIOBOOK_TTS_FALLBACK_BASE_URLS_KEY, serialized);
  }

  if (input.timeoutMs !== undefined) {
    if (input.timeoutMs == null) {
      await upsertSetting(AUDIOBOOK_TTS_TIMEOUT_MS_KEY, null);
    } else {
      const clamped = clampTimeoutMs(Number(input.timeoutMs), DEFAULT_AUDIOBOOK_TTS_TIMEOUT_MS);
      await upsertSetting(AUDIOBOOK_TTS_TIMEOUT_MS_KEY, String(clamped));
    }
  }

  // 写库后强制重读，避免半更新缓存
  invalidateAudiobookTtsTransportCache();
  return getAudiobookTtsTransportStatus();
}

/**
 * 合成路径用的完整运输解析。
 * key 兜底仅 openai↔deepseek；不返回 raw secrets 到日志。
 */
export async function resolveMimoTtsTransportForSynthesize(input?: {
  providerOverride?: string | null;
}): Promise<{
  boundProvider: string;
  primaryBaseURL: string;
  primaryApiKey: string;
  fallbackBaseUrlsRaw: string | null;
  fallbackApiKeysRaw: string | null;
  timeoutMs: number;
}> {
  const stored = await readStoredSettings();
  const bound = resolveBoundProviderId({
    overrideProvider: input?.providerOverride,
    storedBoundProvider: stored.boundProvider,
  });
  const fallback = resolveFallbackBaseUrlsRaw({
    storedFallbackBaseUrlsRaw: stored.fallbackBaseUrlsRaw,
  });
  const timeout = resolveTimeoutMs({ storedTimeoutMs: stored.timeoutMs });
  const primary = await resolvePrimaryBaseURL({
    provider: bound.provider,
    storedPrimaryBaseURL: stored.primaryBaseURL,
  });

  const keyInfo = await resolveEffectiveMimoTtsApiKey(bound.provider);
  const apiKey = keyInfo.apiKey;

  refreshCacheFromResolved({
    boundProvider: bound.provider,
    boundSource: bound.source,
    fallbackBaseUrlsRaw: fallback.raw,
    fallbackSource: fallback.source,
    primaryBaseURL: primary.baseURL,
    primarySource: primary.source,
  });
  transportCacheWarmed = true;

  if (!primary.baseURL) {
    throw new AppError(
      "未配置 LLM/CPA baseURL，无法调用 MiMo TTS。请在设置中心配置有声书 TTS 运输或对应 provider 的 base URL。",
      400,
    );
  }
  if (!apiKey) {
    const requires = isBuiltInProvider(bound.provider)
      ? providerRequiresApiKey(bound.provider as LLMProvider)
      : true;
    if (requires) {
      throw new AppError(
        "未配置可用的 CPA/LLM API Key，无法调用 MiMo TTS。请在「模型厂商」中配置密钥。",
        400,
      );
    }
  }

  return {
    boundProvider: bound.provider,
    primaryBaseURL: primary.baseURL,
    primaryApiKey: apiKey ?? "",
    fallbackBaseUrlsRaw: fallback.raw,
    fallbackApiKeysRaw: process.env[ENV_AUDIOBOOK_TTS_FALLBACK_API_KEYS] ?? null,
    timeoutMs: timeout.timeoutMs,
  };
}
