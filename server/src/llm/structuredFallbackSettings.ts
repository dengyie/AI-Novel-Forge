import type { LLMProvider } from "@ai-novel/shared/types/llm";
import { prisma } from "../db/prisma";

const STRUCTURED_FALLBACK_ENABLED_KEY = "structuredFallback.enabled";
const STRUCTURED_FALLBACK_PROVIDER_KEY = "structuredFallback.provider";
const STRUCTURED_FALLBACK_MODEL_KEY = "structuredFallback.model";
const STRUCTURED_FALLBACK_TEMPERATURE_KEY = "structuredFallback.temperature";
const STRUCTURED_FALLBACK_MAX_TOKENS_KEY = "structuredFallback.maxTokens";
/** Ordered multi-hop cascade as JSON array. First hop mirrors legacy provider/model keys. */
const STRUCTURED_FALLBACK_CHAIN_KEY = "structuredFallback.chain";

export interface StructuredFallbackModel {
  provider: LLMProvider;
  model: string;
  temperature: number;
  maxTokens: number | null;
}

export interface StructuredFallbackSettings {
  enabled: boolean;
  /** Legacy first-hop fields (kept for API/UI compat; equal to chain[0] when chain non-empty). */
  provider: LLMProvider;
  model: string;
  temperature: number;
  maxTokens: number | null;
  /** Ordered cascade after primary model failure. Empty means use [provider/model/...]. */
  chain: StructuredFallbackModel[];
}

/**
 * Defaults prefer the **deepseek** provider slot when the model id is DeepSeek-family.
 * Using provider=openai + deepseek-v4-pro against CPA used to skip thinking-disable and
 * return empty structured content. Model id still works via OpenAI-compatible baseURL.
 */
const DEFAULT_STRUCTURED_FALLBACK_SETTINGS: StructuredFallbackSettings = {
  enabled: false,
  provider: "deepseek",
  model: "deepseek-v4-pro",
  temperature: 0.2,
  maxTokens: null,
  chain: [
    {
      provider: "deepseek",
      model: "deepseek-v4-pro",
      temperature: 0.2,
      maxTokens: null,
    },
    {
      provider: "deepseek",
      model: "deepseek-v4-flash",
      temperature: 0.2,
      maxTokens: null,
    },
  ],
};

/** Prefer deepseek provider slot for deepseek-* model ids when hop still says openai. */
export function coerceProviderForModelId(
  provider: LLMProvider,
  model: string,
): LLMProvider {
  const id = (model ?? "").trim().toLowerCase();
  const leaf = id.includes("/") ? id.split("/").filter(Boolean).pop() ?? id : id;
  if (
    leaf.startsWith("deepseek")
    || leaf.includes("deepseek-v4")
    || leaf.includes("deepseek-reasoner")
  ) {
    // Keep explicit non-openai slots (deepseek/siliconflow/custom) as-is.
    if (provider === "openai") {
      return "deepseek";
    }
  }
  return provider;
}

let cachedSettings: StructuredFallbackSettings | null = null;

function isMissingTableError(error: unknown): boolean {
  return (
    typeof error === "object"
    && error !== null
    && "code" in error
    && (error as { code?: string }).code === "P2021"
  );
}

function normalizeProvider(value: string | undefined | null): LLMProvider {
  const trimmed = value?.trim();
  return (trimmed || DEFAULT_STRUCTURED_FALLBACK_SETTINGS.provider) as LLMProvider;
}

function normalizeModel(value: string | undefined | null): string {
  return value?.trim() || DEFAULT_STRUCTURED_FALLBACK_SETTINGS.model;
}

function clampTemperature(value: number | undefined | null): number {
  if (typeof value === "number" && Number.isFinite(value)) {
    return Math.min(2, Math.max(0, value));
  }
  return DEFAULT_STRUCTURED_FALLBACK_SETTINGS.temperature;
}

function normalizeMaxTokens(value: number | string | undefined | null): number | null {
  if (value === null || value === undefined || value === "") {
    return null;
  }
  const numeric = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(numeric)) {
    return DEFAULT_STRUCTURED_FALLBACK_SETTINGS.maxTokens;
  }
  const normalized = Math.floor(numeric);
  if (normalized < 64) {
    return 64;
  }
  return Math.min(32768, normalized);
}

function normalizeHop(input: Partial<StructuredFallbackModel> | null | undefined): StructuredFallbackModel | null {
  if (!input || typeof input !== "object") {
    return null;
  }
  const model = typeof input.model === "string" ? input.model.trim() : "";
  if (!model) {
    return null;
  }
  const provider = coerceProviderForModelId(normalizeProvider(input.provider), model);
  return {
    provider,
    model,
    temperature: clampTemperature(input.temperature),
    maxTokens: normalizeMaxTokens(input.maxTokens),
  };
}

function parseChainJson(raw: string | undefined | null): StructuredFallbackModel[] {
  if (!raw?.trim()) {
    return [];
  }
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) {
      return [];
    }
    const hops: StructuredFallbackModel[] = [];
    for (const item of parsed) {
      const hop = normalizeHop(item as Partial<StructuredFallbackModel>);
      if (hop) {
        hops.push(hop);
      }
    }
    return hops;
  } catch {
    return [];
  }
}

function hopKey(hop: Pick<StructuredFallbackModel, "provider" | "model">): string {
  return `${hop.provider}::${hop.model}`;
}

/** Deduplicate hops by provider+model, preserving first occurrence order. */
export function dedupeFallbackChain(chain: StructuredFallbackModel[]): StructuredFallbackModel[] {
  const seen = new Set<string>();
  const result: StructuredFallbackModel[] = [];
  for (const hop of chain) {
    const key = hopKey(hop);
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    result.push(hop);
  }
  return result;
}

/**
 * Resolve the runtime cascade for a primary attempt target.
 * Skips hops identical to the primary model; dedupes consecutive/duplicate hops.
 */
export function resolveStructuredFallbackChain(
  settings: StructuredFallbackSettings,
  primary: Pick<StructuredFallbackModel, "provider" | "model">,
): StructuredFallbackModel[] {
  if (!settings.enabled) {
    return [];
  }
  const base = settings.chain.length > 0
    ? settings.chain
    : [{
      provider: settings.provider,
      model: settings.model,
      temperature: settings.temperature,
      maxTokens: settings.maxTokens,
    }];
  const primaryKey = hopKey(primary);
  return dedupeFallbackChain(base).filter((hop) => hopKey(hop) !== primaryKey && hop.model.trim().length > 0);
}

function buildSettingsFromEntries(entries: Map<string, string>): StructuredFallbackSettings {
  const legacyModel = normalizeModel(entries.get(STRUCTURED_FALLBACK_MODEL_KEY));
  const legacy: StructuredFallbackModel = {
    provider: coerceProviderForModelId(
      normalizeProvider(entries.get(STRUCTURED_FALLBACK_PROVIDER_KEY)),
      legacyModel,
    ),
    model: legacyModel,
    temperature: clampTemperature(Number(entries.get(STRUCTURED_FALLBACK_TEMPERATURE_KEY))),
    maxTokens: normalizeMaxTokens(entries.get(STRUCTURED_FALLBACK_MAX_TOKENS_KEY)),
  };
  let chain = parseChainJson(entries.get(STRUCTURED_FALLBACK_CHAIN_KEY));
  if (chain.length === 0) {
    // Pre-chain installs: single hop from legacy keys.
    chain = [legacy];
  }
  // Re-coerce every hop so persisted provider=openai + deepseek-* is healed on read.
  chain = dedupeFallbackChain(
    chain.map((hop) => ({
      ...hop,
      provider: coerceProviderForModelId(hop.provider, hop.model),
    })),
  );
  const first = chain[0] ?? legacy;
  return {
    enabled: entries.get(STRUCTURED_FALLBACK_ENABLED_KEY) === "true",
    provider: first.provider,
    model: first.model,
    temperature: first.temperature,
    maxTokens: first.maxTokens,
    chain,
  };
}

function mirrorLegacyFromChain(chain: StructuredFallbackModel[]): StructuredFallbackModel {
  return chain[0] ?? {
    provider: DEFAULT_STRUCTURED_FALLBACK_SETTINGS.provider,
    model: DEFAULT_STRUCTURED_FALLBACK_SETTINGS.model,
    temperature: DEFAULT_STRUCTURED_FALLBACK_SETTINGS.temperature,
    maxTokens: DEFAULT_STRUCTURED_FALLBACK_SETTINGS.maxTokens,
  };
}

export async function getStructuredFallbackSettings(forceRefresh = false): Promise<StructuredFallbackSettings> {
  if (!forceRefresh && cachedSettings) {
    return cachedSettings;
  }
  try {
    const rows = await prisma.appSetting.findMany({
      where: {
        key: {
          in: [
            STRUCTURED_FALLBACK_ENABLED_KEY,
            STRUCTURED_FALLBACK_PROVIDER_KEY,
            STRUCTURED_FALLBACK_MODEL_KEY,
            STRUCTURED_FALLBACK_TEMPERATURE_KEY,
            STRUCTURED_FALLBACK_MAX_TOKENS_KEY,
            STRUCTURED_FALLBACK_CHAIN_KEY,
          ],
        },
      },
    });
    const valueMap = new Map(rows.map((item) => [item.key, item.value]));
    cachedSettings = buildSettingsFromEntries(valueMap);
    return cachedSettings;
  } catch (error) {
    if (isMissingTableError(error)) {
      cachedSettings = { ...DEFAULT_STRUCTURED_FALLBACK_SETTINGS, chain: [...DEFAULT_STRUCTURED_FALLBACK_SETTINGS.chain] };
      return cachedSettings;
    }
    throw error;
  }
}

/** Build a single hop with model/provider coercion (openai+deepseek-* → deepseek). */
export function normalizeStructuredFallbackHop(
  input: Partial<StructuredFallbackModel> | null | undefined,
): StructuredFallbackModel | null {
  return normalizeHop(input);
}

function coerceChainHops(chain: StructuredFallbackModel[]): StructuredFallbackModel[] {
  return dedupeFallbackChain(
    chain.map((hop) => ({
      ...hop,
      provider: coerceProviderForModelId(hop.provider, hop.model),
    })),
  );
}

export async function saveStructuredFallbackSettings(
  input: Partial<StructuredFallbackSettings>,
): Promise<StructuredFallbackSettings> {
  const previous = await getStructuredFallbackSettings(true);

  let chain: StructuredFallbackModel[];
  if (Array.isArray(input.chain)) {
    chain = dedupeFallbackChain(
      input.chain
        .map((hop) => normalizeHop(hop))
        .filter((hop): hop is StructuredFallbackModel => hop !== null),
    );
    if (chain.length === 0 && (input.provider || input.model || previous.model)) {
      // Explicit empty chain with legacy fields → single hop (must coerce provider).
      const hop = normalizeHop({
        provider: input.provider ?? previous.provider,
        model: input.model ?? previous.model,
        temperature: input.temperature ?? previous.temperature,
        maxTokens: input.maxTokens !== undefined ? input.maxTokens : previous.maxTokens,
      });
      chain = hop ? [hop] : [];
    }
  } else if (input.provider !== undefined || input.model !== undefined
    || input.temperature !== undefined || input.maxTokens !== undefined) {
    // Legacy partial update: replace first hop, keep remaining hops if model changed.
    const first = normalizeHop({
      provider: input.provider ?? previous.provider,
      model: input.model ?? previous.model,
      temperature: input.temperature ?? previous.temperature,
      maxTokens: input.maxTokens !== undefined ? input.maxTokens : previous.maxTokens,
    });
    if (!first) {
      chain = previous.chain.length > 0
        ? previous.chain
        : [...DEFAULT_STRUCTURED_FALLBACK_SETTINGS.chain];
    } else {
      const rest = previous.chain.slice(1).filter((hop) => hopKey(hop) !== hopKey(first));
      chain = dedupeFallbackChain([first, ...rest]);
    }
  } else {
    chain = previous.chain.length > 0
      ? previous.chain
      : [{
        provider: previous.provider,
        model: previous.model,
        temperature: previous.temperature,
        maxTokens: previous.maxTokens,
      }];
  }

  if (chain.length === 0) {
    chain = [...DEFAULT_STRUCTURED_FALLBACK_SETTINGS.chain];
  }
  // Persist-time heal: never write openai+deepseek-* even if a caller bypassed UI.
  chain = coerceChainHops(chain);

  const first = mirrorLegacyFromChain(chain);
  const next: StructuredFallbackSettings = {
    enabled: input.enabled ?? previous.enabled,
    provider: first.provider,
    model: first.model,
    temperature: first.temperature,
    maxTokens: first.maxTokens,
    chain,
  };

  try {
    await prisma.$transaction([
      prisma.appSetting.upsert({
        where: { key: STRUCTURED_FALLBACK_ENABLED_KEY },
        update: { value: String(next.enabled) },
        create: { key: STRUCTURED_FALLBACK_ENABLED_KEY, value: String(next.enabled) },
      }),
      prisma.appSetting.upsert({
        where: { key: STRUCTURED_FALLBACK_PROVIDER_KEY },
        update: { value: next.provider },
        create: { key: STRUCTURED_FALLBACK_PROVIDER_KEY, value: next.provider },
      }),
      prisma.appSetting.upsert({
        where: { key: STRUCTURED_FALLBACK_MODEL_KEY },
        update: { value: next.model },
        create: { key: STRUCTURED_FALLBACK_MODEL_KEY, value: next.model },
      }),
      prisma.appSetting.upsert({
        where: { key: STRUCTURED_FALLBACK_TEMPERATURE_KEY },
        update: { value: String(next.temperature) },
        create: { key: STRUCTURED_FALLBACK_TEMPERATURE_KEY, value: String(next.temperature) },
      }),
      prisma.appSetting.upsert({
        where: { key: STRUCTURED_FALLBACK_MAX_TOKENS_KEY },
        update: { value: next.maxTokens == null ? "" : String(next.maxTokens) },
        create: {
          key: STRUCTURED_FALLBACK_MAX_TOKENS_KEY,
          value: next.maxTokens == null ? "" : String(next.maxTokens),
        },
      }),
      prisma.appSetting.upsert({
        where: { key: STRUCTURED_FALLBACK_CHAIN_KEY },
        update: { value: JSON.stringify(next.chain) },
        create: { key: STRUCTURED_FALLBACK_CHAIN_KEY, value: JSON.stringify(next.chain) },
      }),
    ]);
    cachedSettings = next;
    return next;
  } catch (error) {
    if (isMissingTableError(error)) {
      cachedSettings = next;
      return next;
    }
    throw error;
  }
}

/** Test helper: clear in-process cache between cases. */
export function resetStructuredFallbackSettingsCacheForTests(): void {
  cachedSettings = null;
}
