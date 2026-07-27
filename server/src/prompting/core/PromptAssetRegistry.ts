import type { PromptAsset } from "./promptTypes";
import { buildPromptAssetKey } from "./promptTypes";

export type UnknownPromptAsset = PromptAsset<unknown, unknown, unknown>;
export type PromptAssetLoader = () => UnknownPromptAsset;

export interface PromptAssetLoaderEntry {
  key: string;
  load: PromptAssetLoader;
}

export interface PromptAssetRegistry {
  has(id: string, version: string): boolean;
  list(): UnknownPromptAsset[];
  get(id: string, version: string): UnknownPromptAsset | null;
  findById(id: string): UnknownPromptAsset | null;
}

export function createPromptAssetRegistry(entries: PromptAssetLoaderEntry[]): PromptAssetRegistry {
  const loaderByKey = new Map<string, PromptAssetLoader>();
  for (const entry of entries) {
    if (loaderByKey.has(entry.key)) {
      throw new Error(`Duplicate prompt asset registration: ${entry.key}`);
    }
    loaderByKey.set(entry.key, entry.load);
  }
  const entryByLoad = new Map<PromptAssetLoader, PromptAssetLoaderEntry>(
    entries.map((entry) => [entry.load, entry] as const),
  );
  const assetByKey = new Map<string, UnknownPromptAsset>();
  const unhydratedLoaders = new Set<PromptAssetLoader>(entries.map((entry) => entry.load));

  const findCachedByLoader = (load: PromptAssetLoader): UnknownPromptAsset | null => {
    for (const [key, asset] of assetByKey.entries()) {
      if (loaderByKey.get(key) === load) {
        return asset;
      }
    }
    return null;
  };
  const cacheLoaded = (entry: PromptAssetLoaderEntry, asset: UnknownPromptAsset): UnknownPromptAsset => {
    const actualKey = buildPromptAssetKey(asset);
    const registeredLoader = loaderByKey.get(actualKey);
    if (registeredLoader && registeredLoader !== entry.load) {
      throw new Error(`Duplicate prompt asset registration: ${actualKey}`);
    }
    const cachedAsset = assetByKey.get(actualKey);
    if (cachedAsset && cachedAsset !== asset) {
      throw new Error(`Duplicate prompt asset cache entry: ${actualKey}`);
    }
    if (entry.key !== actualKey && loaderByKey.get(entry.key) === entry.load) {
      loaderByKey.delete(entry.key);
    }
    loaderByKey.set(actualKey, entry.load);
    assetByKey.set(actualKey, asset);
    unhydratedLoaders.delete(entry.load);
    return asset;
  };
  const hydrateEntry = (entry: PromptAssetLoaderEntry): UnknownPromptAsset => (
    findCachedByLoader(entry.load) ?? cacheLoaded(entry, entry.load())
  );
  const hydrateByKey = (key: string): void => {
    if (assetByKey.has(key)) return;
    for (const entry of entries) {
      if (!unhydratedLoaders.has(entry.load)) continue;
      if (buildPromptAssetKey(hydrateEntry(entry)) === key) return;
    }
  };
  const hydrateAll = (): void => {
    for (const entry of entries) {
      if (unhydratedLoaders.has(entry.load)) hydrateEntry(entry);
    }
  };
  const loadByKey = (key: string): UnknownPromptAsset | null => {
    const cached = assetByKey.get(key);
    if (cached) return cached;
    const load = loaderByKey.get(key);
    if (load) {
      const entry = entryByLoad.get(load);
      if (!entry) return null;
      const asset = hydrateEntry(entry);
      return buildPromptAssetKey(asset) === key ? asset : assetByKey.get(key) ?? null;
    }
    hydrateByKey(key);
    return assetByKey.get(key) ?? null;
  };

  return {
    has: (id, version) => loadByKey(`${id}@${version}`) != null,
    list: () => {
      hydrateAll();
      return [...assetByKey.values()];
    },
    get: (id, version) => loadByKey(`${id}@${version}`),
    findById: (id) => {
      hydrateAll();
      for (const asset of assetByKey.values()) {
        if (asset.id === id) return asset;
      }
      return null;
    },
  };
}
