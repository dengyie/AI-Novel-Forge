/**
 * 全站 VoiceAsset 库：JSON registry + voice-refs/global 文件。
 * 安全：所有 clone 路径必须过 checkVoiceRefAudioPath；客户端只提交 asset id。
 * registry.primaryFile.path 存相对 voice-refs 根的路径；角色 denormalize 写绝对路径（bind 时 resolve）。
 * 导入路径只允许 allowlist 根；import/seed 不得直批 approved（须 setStatus 人耳批准）。
 */
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type {
  VoiceAsset,
  VoiceAssetBackendTarget,
  VoiceAssetImportFromFileInput,
  VoiceAssetImportPackInput,
  VoiceAssetImportPackResult,
  VoiceAssetKind,
  VoiceAssetLicense,
  VoiceAssetListQuery,
  VoiceAssetListResult,
  VoiceAssetStatus,
  VoiceAssetBindCharacterInput,
  VoiceAssetBindCharacterResult,
} from "@ai-novel/shared/types/audiobook";
import {
  isVoiceAssetKind,
  isVoiceAssetStatus,
} from "@ai-novel/shared/types/audiobook";
import { prisma } from "../../db/prisma";
import { AppError } from "../../middleware/errorHandler";
import { resolveDataRoot } from "../../runtime/appPaths";
import {
  resolveGlobalVoiceAssetDir,
  resolveGlobalVoiceAssetRefPath,
  resolveGlobalVoiceLibraryRoot,
  resolveGlobalVoiceRegistryPath,
  resolveVoiceRefRoot,
} from "./audiobookPaths";
import { isValidPcmWavFile, parseWavInfo } from "./audiobookWav";
import { auditVoiceLibraryStatusChange } from "./voiceLibraryApproveGate";
import { checkVoiceRefAudioPath, isPathInside } from "./voiceRefPath";

const DEFAULT_PACK_REL = path.join("docs", "voice-packs", "05-yuanworld-seed-from-mimo");
const LIST_DEFAULT_LIMIT = 200;
const LIST_MAX_LIMIT = 500;
const REGISTRY_LOCK_STALE_MS = 15_000;
const REGISTRY_LOCK_WAIT_MS = 5_000;

type RegistryFile = {
  version: 1;
  updatedAt: string;
  assets: VoiceAsset[];
};

function nowIso(): string {
  return new Date().toISOString();
}

function newAssetId(): string {
  return `va_${crypto.randomBytes(8).toString("hex")}`;
}

function normalizeSlug(raw: string): string {
  const s = raw
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N}_-]+/gu, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
  if (!s || s.length > 80) {
    throw new AppError("slug 非法或过长。", 400);
  }
  return s;
}

function emptyRegistry(): RegistryFile {
  return { version: 1, updatedAt: nowIso(), assets: [] };
}

function clampListLimit(raw: number | undefined): number {
  if (typeof raw !== "number" || !Number.isFinite(raw)) {
    return LIST_DEFAULT_LIMIT;
  }
  return Math.max(1, Math.min(LIST_MAX_LIMIT, Math.floor(raw)));
}

function clampListOffset(raw: number | undefined): number {
  if (typeof raw !== "number" || !Number.isFinite(raw) || raw < 0) {
    return 0;
  }
  return Math.floor(raw);
}

/** 损坏 registry 备份后抛错，禁止静默清空导致丢库。 */
function quarantineCorruptRegistry(file: string, reason: string): never {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const backup = `${file}.corrupt.${stamp}`;
  try {
    fs.renameSync(file, backup);
  } catch {
    try {
      fs.copyFileSync(file, backup);
    } catch {
      /* ignore */
    }
  }
  throw new AppError(
    `VoiceAsset registry 损坏（${reason}），已尝试备份为 ${path.basename(backup)}。请人工恢复后再写库。`,
    500,
  );
}

function readRegistry(): RegistryFile {
  const file = resolveGlobalVoiceRegistryPath();
  if (!fs.existsSync(file)) {
    return emptyRegistry();
  }
  let text: string;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch (error) {
    throw new AppError(
      `无法读取 VoiceAsset registry：${error instanceof Error ? error.message : String(error)}`,
      500,
    );
  }
  let raw: Partial<RegistryFile>;
  try {
    raw = JSON.parse(text) as Partial<RegistryFile>;
  } catch {
    quarantineCorruptRegistry(file, "JSON 解析失败");
  }
  if (!raw || !Array.isArray(raw.assets)) {
    quarantineCorruptRegistry(file, "缺少 assets 数组");
  }
  return {
    version: 1,
    updatedAt: raw.updatedAt || nowIso(),
    assets: raw.assets.filter((a): a is VoiceAsset => Boolean(a && typeof a.id === "string")),
  };
}

function writeRegistryUnlocked(registry: RegistryFile): void {
  const root = resolveGlobalVoiceLibraryRoot();
  fs.mkdirSync(root, { recursive: true });
  const file = resolveGlobalVoiceRegistryPath();
  const next: RegistryFile = {
    version: 1,
    updatedAt: nowIso(),
    assets: registry.assets,
  };
  const tmp = `${file}.part`;
  fs.writeFileSync(tmp, `${JSON.stringify(next, null, 2)}\n`, "utf8");
  fs.renameSync(tmp, file);
}

/** 跨请求串行写 registry（文件锁；单进程内同步代码本已原子）。 */
function withRegistryWriteLock<T>(fn: () => T): T {
  const lockPath = `${resolveGlobalVoiceRegistryPath()}.lock`;
  fs.mkdirSync(path.dirname(lockPath), { recursive: true });
  const started = Date.now();
  // eslint-disable-next-line no-constant-condition
  while (true) {
    try {
      const fd = fs.openSync(lockPath, "wx");
      try {
        return fn();
      } finally {
        try {
          fs.closeSync(fd);
        } catch {
          /* ignore */
        }
        try {
          fs.unlinkSync(lockPath);
        } catch {
          /* ignore */
        }
      }
    } catch (error) {
      const code = (error as NodeJS.ErrnoException)?.code;
      if (code !== "EEXIST") {
        throw error;
      }
      try {
        const st = fs.statSync(lockPath);
        if (Date.now() - st.mtimeMs > REGISTRY_LOCK_STALE_MS) {
          fs.unlinkSync(lockPath);
          continue;
        }
      } catch {
        /* ignore */
      }
      if (Date.now() - started > REGISTRY_LOCK_WAIT_MS) {
        throw new AppError("VoiceAsset registry 正忙，请稍后重试。", 503);
      }
      const waitUntil = Date.now() + 15;
      while (Date.now() < waitUntil) {
        /* brief spin; sync API 无 await */
      }
    }
  }
}

function writeRegistry(registry: RegistryFile): void {
  withRegistryWriteLock(() => {
    writeRegistryUnlocked(registry);
  });
}

/** 在写锁内完成读-改-写，避免并发 import/setStatus 丢资产。 */
function mutateRegistry(mutator: (registry: RegistryFile) => void): RegistryFile {
  return withRegistryWriteLock(() => {
    const registry = readRegistry();
    mutator(registry);
    writeRegistryUnlocked(registry);
    return registry;
  });
}

function sha256File(filePath: string): string {
  const hash = crypto.createHash("sha256");
  hash.update(fs.readFileSync(filePath));
  return hash.digest("hex");
}

/** import 源路径允许根：data/voice-refs、docs/voice-packs、data 根、os.tmpdir（单测）。 */
function listImportSourceRoots(): string[] {
  const roots = new Set<string>();
  const add = (p: string) => {
    try {
      roots.add(path.resolve(p));
    } catch {
      /* ignore */
    }
  };
  add(resolveDataRoot());
  add(resolveVoiceRefRoot());
  add(resolveGlobalVoiceLibraryRoot());
  add(path.resolve(process.cwd(), "docs", "voice-packs"));
  add(path.resolve(process.cwd(), "..", "docs", "voice-packs"));
  add(path.resolve(process.cwd(), "docs"));
  add(path.join(resolveDataRoot(), "tmp"));
  add(path.join(resolveDataRoot(), "storage"));
  add(os.tmpdir());
  return [...roots];
}

function assertPathUnderAllowlist(absolutePath: string, label: string): void {
  const abs = path.resolve(absolutePath);
  const ok = listImportSourceRoots().some((root) => isPathInside(root, abs) || abs === root);
  if (!ok) {
    throw new AppError(
      `${label} 不在允许目录内（须位于 data/voice-refs、docs/voice-packs 或应用数据根下）。`,
      400,
    );
  }
}

function resolveSourcePath(sourcePath: string): string {
  const raw = sourcePath.trim();
  if (!raw) {
    throw new AppError("sourcePath 不能为空。", 400);
  }
  if (raw.includes("\0")) {
    throw new AppError("sourcePath 非法。", 400);
  }
  const absolute = path.isAbsolute(raw) ? path.resolve(raw) : path.resolve(process.cwd(), raw);
  if (!fs.existsSync(absolute) || !fs.statSync(absolute).isFile()) {
    throw new AppError(`源文件不存在：${absolute}`, 400);
  }
  assertPathUnderAllowlist(absolute, "sourcePath");
  return absolute;
}

/** 导入链路禁止直批 approved；人耳批准只走 setStatus。 */
function normalizeImportStatus(raw: VoiceAssetStatus | undefined | null): VoiceAssetStatus {
  if (raw == null || raw === undefined) {
    return "draft";
  }
  if (!isVoiceAssetStatus(raw)) {
    throw new AppError("status 非法。", 400);
  }
  if (raw === "approved") {
    throw new AppError(
      "import 禁止 status=approved；请先以 draft 入库，人耳确认后 PATCH status。",
      400,
    );
  }
  return raw;
}

function assertLicense(license: VoiceAssetLicense | undefined | null): VoiceAssetLicense {
  const source = license?.source?.trim() || "";
  const rights = license?.rights?.trim() || "";
  if (!source || !rights) {
    throw new AppError("导入必须提供 license.source 与 license.rights。", 400);
  }
  return {
    source,
    rights,
    notes: license?.notes?.trim() || null,
    url: license?.url?.trim() || null,
  };
}

/** 将 registry 内 path（相对 voice-refs 或历史绝对路径）解析为绝对路径。 */
export function resolveVoiceAssetStoredPath(stored: string | null | undefined): string | null {
  const raw = stored?.trim() || "";
  if (!raw) return null;
  if (path.isAbsolute(raw)) {
    return path.resolve(raw);
  }
  return path.resolve(resolveVoiceRefRoot(), raw);
}

/** 绝对路径 → 相对 voice-refs 根；越界则抛错。 */
export function toVoiceRefRelativePath(absolutePath: string): string {
  const abs = path.resolve(absolutePath);
  const root = resolveVoiceRefRoot();
  if (!isPathInside(root, abs)) {
    throw new AppError("参考音频路径越界（必须位于 voice-refs 目录）。", 400);
  }
  const rel = path.relative(root, abs);
  if (!rel || rel.startsWith("..") || path.isAbsolute(rel)) {
    throw new AppError("参考音频路径无法转为 voice-refs 相对路径。", 400);
  }
  return rel.split(path.sep).join("/");
}

function assertCloneRefUsable(asset: VoiceAsset, requireApproved: boolean): string {
  if (asset.kind !== "clone_ref") {
    throw new AppError(`资产「${asset.displayName}」不是 clone_ref，不能绑角色 clone。`, 400);
  }
  if (requireApproved && asset.status !== "approved") {
    throw new AppError(
      `资产「${asset.displayName}」状态为 ${asset.status}，合成绑库需要 approved。`,
      400,
    );
  }
  if (asset.status === "archived" || asset.status === "deprecated") {
    throw new AppError(`资产「${asset.displayName}」已 ${asset.status}，禁止绑定。`, 400);
  }
  const stored = asset.primaryFile?.path?.trim() || "";
  if (!stored) {
    throw new AppError(`资产「${asset.displayName}」缺少 primaryFile。`, 400);
  }
  const absoluteCandidate = resolveVoiceAssetStoredPath(stored);
  if (!absoluteCandidate) {
    throw new AppError(`资产「${asset.displayName}」primaryFile 路径无效。`, 400);
  }
  const checked = checkVoiceRefAudioPath(absoluteCandidate);
  if (!checked.ok) {
    throw new AppError(`资产「${asset.displayName}」参考音频不可用：${checked.reason}`, 400);
  }
  if (!isValidPcmWavFile(checked.absolutePath)) {
    throw new AppError(`资产「${asset.displayName}」参考音频不是合法 PCM WAV。`, 400);
  }
  return checked.absolutePath;
}

function wavMetaFromFile(filePath: string): {
  sampleRate: number | null;
  durationSec: number | null;
  channels: number | null;
  bytes: number;
} {
  const bytes = fs.statSync(filePath).size;
  try {
    const buf = fs.readFileSync(filePath);
    const info = parseWavInfo(buf);
    const durationSec = info.byteRate > 0
      ? Number((info.dataSize / info.byteRate).toFixed(3))
      : null;
    return {
      sampleRate: info.sampleRate || null,
      durationSec,
      channels: info.numChannels || null,
      bytes,
    };
  } catch {
    return { sampleRate: null, durationSec: null, channels: null, bytes };
  }
}

function discoverPackRoot(explicit?: string | null): string {
  if (explicit?.trim()) {
    const absolute = path.isAbsolute(explicit)
      ? path.resolve(explicit)
      : path.resolve(process.cwd(), explicit);
    if (!fs.existsSync(absolute) || !fs.statSync(absolute).isDirectory()) {
      throw new AppError(`种子包路径不存在：${absolute}`, 400);
    }
    assertPathUnderAllowlist(absolute, "packRoot");
    if (!fs.existsSync(path.join(absolute, "SEED_MANIFEST.json"))) {
      throw new AppError(`种子包缺少 SEED_MANIFEST.json：${absolute}`, 400);
    }
    return absolute;
  }
  const candidates = [
    path.resolve(process.cwd(), DEFAULT_PACK_REL),
    path.resolve(process.cwd(), "..", DEFAULT_PACK_REL),
    path.resolve(__dirname, "../../../../../../", DEFAULT_PACK_REL),
    path.resolve(__dirname, "../../../../../", DEFAULT_PACK_REL),
  ];
  for (const c of candidates) {
    if (fs.existsSync(path.join(c, "SEED_MANIFEST.json"))) {
      return c;
    }
  }
  throw new AppError(
    `未找到种子包（期望 ${DEFAULT_PACK_REL}/SEED_MANIFEST.json，cwd=${process.cwd()}）。`,
    400,
  );
}

/**
 * 有 ttsVoiceAssetId 时按库 resolve 绝对 clone 路径；无 id 时返回 legacy path 或 null。
 * 默认 requireApproved=true。asset 不存在/不可用时抛 AppError。
 */
export function resolveEffectiveCloneRefPath(input: {
  ttsVoiceAssetId?: string | null;
  ttsRefAudioPath?: string | null;
  requireApproved?: boolean;
}): string | null {
  const id = input.ttsVoiceAssetId?.trim();
  if (id) {
    return voiceLibraryService.resolveCloneRefForCharacter({
      ttsVoiceAssetId: id,
      requireApproved: input.requireApproved !== false,
    });
  }
  const legacy = input.ttsRefAudioPath?.trim();
  return legacy || null;
}

/**
 * 尽力 resolve：库 id 失败时不抛，返回 null（readiness probe 用）。
 */
export function tryResolveEffectiveCloneRefPath(input: {
  ttsVoiceAssetId?: string | null;
  ttsRefAudioPath?: string | null;
  requireApproved?: boolean;
}): string | null {
  try {
    return resolveEffectiveCloneRefPath(input);
  } catch {
    return null;
  }
}

export class VoiceLibraryService {
  ensureLibraryRoot(): void {
    fs.mkdirSync(resolveGlobalVoiceLibraryRoot(), { recursive: true });
    fs.mkdirSync(path.join(resolveGlobalVoiceLibraryRoot(), "assets"), { recursive: true });
    if (!fs.existsSync(resolveGlobalVoiceRegistryPath())) {
      writeRegistry(emptyRegistry());
    }
  }

  list(query: VoiceAssetListQuery = {}): VoiceAssetListResult {
    const registry = readRegistry();
    let items = [...registry.assets];
    const statuses = query.status
      ? Array.isArray(query.status)
        ? query.status
        : [query.status]
      : null;
    if (statuses?.length) {
      const set = new Set(statuses);
      items = items.filter((a) => set.has(a.status));
    }
    const kinds = query.kind
      ? Array.isArray(query.kind)
        ? query.kind
        : [query.kind]
      : null;
    if (kinds?.length) {
      const set = new Set(kinds);
      items = items.filter((a) => set.has(a.kind));
    }
    const tag = query.tag?.trim().toLowerCase();
    if (tag) {
      items = items.filter((a) => a.tags.some((t) => t.toLowerCase() === tag));
    }
    const q = query.q?.trim().toLowerCase();
    if (q) {
      items = items.filter(
        (a) =>
          a.slug.toLowerCase().includes(q)
          || a.displayName.toLowerCase().includes(q)
          || a.id.toLowerCase().includes(q)
          || a.tags.some((t) => t.toLowerCase().includes(q)),
      );
    }
    items.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    const total = items.length;
    const limit = clampListLimit(query.limit);
    const offset = clampListOffset(query.offset);
    return { items: items.slice(offset, offset + limit), total };
  }

  getById(assetId: string): VoiceAsset | null {
    const id = assetId.trim();
    if (!id) return null;
    return readRegistry().assets.find((a) => a.id === id) ?? null;
  }

  getBySlug(slug: string): VoiceAsset | null {
    const s = slug.trim().toLowerCase();
    if (!s) return null;
    return readRegistry().assets.find((a) => a.slug === s) ?? null;
  }

  /**
   * 若有 ttsVoiceAssetId 则优先走库；否则返回 null（调用方用 legacy ttsRefAudioPath）。
   * 合成/绑库路径默认 requireApproved=true。
   */
  resolveCloneRefForCharacter(input: {
    ttsVoiceAssetId?: string | null;
    requireApproved?: boolean;
  }): string | null {
    const id = input.ttsVoiceAssetId?.trim();
    if (!id) return null;
    const asset = this.getById(id);
    if (!asset) {
      throw new AppError(`VoiceAsset 不存在：${id}`, 404);
    }
    return assertCloneRefUsable(asset, input.requireApproved !== false);
  }

  /**
   * 绑库前校验（不写角色）。用于 create 避免半成品角色。
   */
  assertBindableCloneRef(voiceAssetId: string): { asset: VoiceAsset; absolutePath: string } {
    const assetId = voiceAssetId.trim();
    if (!assetId) {
      throw new AppError("voiceAssetId 不能为空。", 400);
    }
    const asset = this.getById(assetId);
    if (!asset) {
      throw new AppError(`VoiceAsset 不存在：${assetId}`, 404);
    }
    const absolutePath = assertCloneRefUsable(asset, true);
    return { asset, absolutePath };
  }

  importFromFile(input: VoiceAssetImportFromFileInput): VoiceAsset {
    this.ensureLibraryRoot();
    const license = assertLicense(input.license);
    const slug = normalizeSlug(input.slug);
    const displayName = input.displayName?.trim() || slug;
    const kind: VoiceAssetKind =
      input.kind && isVoiceAssetKind(input.kind) ? input.kind : "clone_ref";
    // 禁止 import 直批 approved（open API 下的提权面）
    const status = normalizeImportStatus(input.status);
    if (kind !== "clone_ref") {
      throw new AppError("当前仅支持 kind=clone_ref 文件导入。", 400);
    }
    const sourceAbs = resolveSourcePath(input.sourcePath);
    if (!isValidPcmWavFile(sourceAbs)) {
      throw new AppError("clone_ref 导入仅接受合法 PCM WAV。", 400);
    }
    const backendTargets: VoiceAssetBackendTarget[] = (
      input.backendTargets?.length ? input.backendTargets : ["mimo_chat_audio"]
    ) as VoiceAssetBackendTarget[];
    const tags = Array.isArray(input.tags)
      ? input.tags.map((t) => t.trim()).filter(Boolean).slice(0, 32)
      : [];
    const sampleText = input.sampleText?.trim() || null;
    const designPrompt = input.designPrompt?.trim() || null;
    const packId = input.packId?.trim() || null;
    let result: VoiceAsset | null = null;
    mutateRegistry((registry) => {
      const existing = registry.assets.find((a) => a.slug === slug);
      if (existing && !input.overwrite) {
        throw new AppError(`slug「${slug}」已存在（id=${existing.id}）。传 overwrite=true 可覆盖。`, 409);
      }
      const assetId = existing?.id || newAssetId();
      const destDir = resolveGlobalVoiceAssetDir(assetId);
      fs.mkdirSync(destDir, { recursive: true });
      const destPath = resolveGlobalVoiceAssetRefPath(assetId, "wav");
      const tmp = `${destPath}.part`;
      fs.copyFileSync(sourceAbs, tmp);
      fs.renameSync(tmp, destPath);
      const checked = checkVoiceRefAudioPath(destPath);
      if (!checked.ok) {
        try {
          fs.unlinkSync(destPath);
        } catch {
          /* ignore */
        }
        throw new AppError(`导入后路径校验失败：${checked.reason}`, 500);
      }
      const meta = wavMetaFromFile(checked.absolutePath);
      const sha = sha256File(checked.absolutePath);
      const relativePath = toVoiceRefRelativePath(checked.absolutePath);
      const now = nowIso();
      const asset: VoiceAsset = {
        id: assetId,
        slug,
        displayName,
        kind,
        status,
        tags,
        sampleText,
        designPrompt,
        presetVoice: null,
        license,
        backendTargets,
        primaryFile: {
          path: relativePath,
          sha256: sha,
          bytes: meta.bytes,
          format: "wav",
          sampleRate: meta.sampleRate,
          durationSec: meta.durationSec,
          channels: meta.channels,
        },
        packId,
        createdAt: existing?.createdAt || now,
        updatedAt: now,
      };
      if (existing) {
        registry.assets = registry.assets.map((a) => (a.id === assetId ? asset : a));
      } else {
        registry.assets.push(asset);
      }
      result = asset;
    });
    return result!;
  }

  importYuanworldSeedPack(input: VoiceAssetImportPackInput = {}): VoiceAssetImportPackResult {
    this.ensureLibraryRoot();
    if (input.forceStatus === "approved") {
      throw new AppError(
        "import-seed-pack 禁止 forceStatus=approved；种子须 draft 入库，人耳确认后 PATCH status。",
        400,
      );
    }
    const packRoot = discoverPackRoot(input.packRoot);
    const manifestPath = path.join(packRoot, "SEED_MANIFEST.json");
    let manifest: {
      packId?: string;
      items?: Array<Record<string, unknown>>;
    };
    try {
      manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
    } catch {
      throw new AppError(`无法读取 SEED_MANIFEST.json：${manifestPath}`, 400);
    }
    const packId = String(manifest.packId || "yuanworld-seed-from-mimo");
    const items = Array.isArray(manifest.items) ? manifest.items : [];
    const imported: VoiceAsset[] = [];
    const skipped: Array<{ slug: string; reason: string }> = [];
    const failed: Array<{ slug: string; reason: string }> = [];

    for (const raw of items) {
      const slug = String(raw.slug || "").trim();
      if (!slug) {
        failed.push({ slug: "(empty)", reason: "缺 slug" });
        continue;
      }
      try {
        const fileRel = String(raw.file || "").trim();
        if (!fileRel || fileRel.includes("..") || path.isAbsolute(fileRel)) {
          throw new AppError("manifest file 必须为包内相对路径。", 400);
        }
        const sourcePath = path.join(packRoot, fileRel);
        const licenseRaw = (raw.license || {}) as Record<string, string | null | undefined>;
        // 种子恒 draft（除非 force 到非 approved 状态）；manifest 写 approved 也降级
        let status: VoiceAssetStatus = "draft";
        if (input.forceStatus && isVoiceAssetStatus(input.forceStatus)) {
          status = normalizeImportStatus(input.forceStatus);
        } else if (typeof raw.status === "string" && isVoiceAssetStatus(raw.status)) {
          status = raw.status === "approved" ? "draft" : raw.status;
        }
        const existing = this.getBySlug(normalizeSlug(slug));
        if (existing && !input.overwrite) {
          skipped.push({ slug, reason: `已存在 id=${existing.id}` });
          continue;
        }
        const asset = this.importFromFile({
          sourcePath,
          slug,
          displayName: String(raw.displayName || slug),
          kind: "clone_ref",
          status,
          tags: Array.isArray(raw.tags) ? raw.tags.map(String) : ["seed"],
          sampleText: raw.sampleText != null ? String(raw.sampleText) : null,
          license: {
            source: licenseRaw.source || "app-seed",
            rights: licenseRaw.rights || "internal-test-only",
            notes: licenseRaw.notes || null,
            url: licenseRaw.url || null,
          },
          backendTargets: Array.isArray(raw.backendTargets)
            ? (raw.backendTargets as VoiceAssetBackendTarget[])
            : ["mimo_chat_audio"],
          packId,
          overwrite: Boolean(input.overwrite || existing),
        });
        imported.push(asset);
      } catch (error) {
        failed.push({
          slug,
          reason: error instanceof Error ? error.message : String(error),
        });
      }
    }
    return { packId, imported, skipped, failed };
  }

  /**
   * 库级试听：解析 clone_ref 的 ref.wav 绝对路径。
   * draft/approved 均可听；archived/deprecated 拒绝；不要求 approved。
   */
  resolveLibraryPreviewAudioPath(assetId: string): {
    asset: VoiceAsset;
    absolutePath: string;
  } {
    const asset = this.getById(assetId);
    if (!asset) {
      throw new AppError("VoiceAsset 不存在。", 404);
    }
    if (asset.kind !== "clone_ref") {
      throw new AppError("仅 clone_ref 支持库级 WAV 试听。", 400);
    }
    if (asset.status === "archived" || asset.status === "deprecated") {
      throw new AppError(`资产已 ${asset.status}，禁止试听。`, 400);
    }
    const absolutePath = assertCloneRefUsable(asset, false);
    return { asset, absolutePath };
  }

  /**
   * 标记人耳已听（写 registry.review.heardAt）。
   * 在库级 audio 实际被拉取时调用；media-access 签发不写。
   */
  markLibraryPreviewHeard(assetId: string): VoiceAsset {
    const id = assetId.trim();
    if (!id) {
      throw new AppError("assetId 必填。", 400);
    }
    // 先校验可试听，再写 heard
    this.resolveLibraryPreviewAudioPath(id);
    let result: VoiceAsset | null = null;
    mutateRegistry((registry) => {
      const idx = registry.assets.findIndex((a) => a.id === id);
      if (idx < 0) {
        throw new AppError("VoiceAsset 不存在。", 404);
      }
      const prev = registry.assets[idx]!;
      const next: VoiceAsset = {
        ...prev,
        review: {
          ...(prev.review ?? {}),
          heardAt: nowIso(),
        },
        updatedAt: nowIso(),
      };
      registry.assets[idx] = next;
      result = next;
    });
    return result!;
  }

  setStatus(assetId: string, status: VoiceAssetStatus): VoiceAsset {
    if (!isVoiceAssetStatus(status)) {
      throw new AppError("status 非法。", 400);
    }
    let result: VoiceAsset | null = null;
    let fromStatus = "";
    try {
      mutateRegistry((registry) => {
        const idx = registry.assets.findIndex((a) => a.id === assetId.trim());
        if (idx < 0) {
          throw new AppError("VoiceAsset 不存在。", 404);
        }
        const prev = registry.assets[idx]!;
        fromStatus = prev.status;
        if (status === "approved" && prev.kind === "clone_ref") {
          assertCloneRefUsable({ ...prev, status: "approved" }, false);
          if (!prev.license?.source || !prev.license?.rights) {
            throw new AppError("approved 前必须具备 license.source/rights。", 400);
          }
          if (!prev.review?.heardAt?.trim()) {
            throw new AppError(
              "升为 approved 前须先库级试听（服务端未记录 heardAt）。请先播放试听音频。",
              400,
            );
          }
        }
        const next: VoiceAsset = {
          ...prev,
          status,
          updatedAt: nowIso(),
        };
        registry.assets[idx] = next;
        result = next;
      });
      auditVoiceLibraryStatusChange({
        assetId: assetId.trim(),
        from: fromStatus || "?",
        to: status,
        ok: true,
      });
    } catch (error) {
      auditVoiceLibraryStatusChange({
        assetId: assetId.trim(),
        from: fromStatus || "?",
        to: status,
        ok: false,
        reason: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
    return result!;
  }

  async bindCharacter(
    novelId: string,
    characterId: string,
    input: VoiceAssetBindCharacterInput,
  ): Promise<VoiceAssetBindCharacterResult> {
    // 合成绑库恒 require approved；服务层不再接受 body 旁路
    const { asset, absolutePath } = this.assertBindableCloneRef(input.voiceAssetId);
    const character = await prisma.character.findFirst({
      where: { id: characterId, novelId },
      select: { id: true },
    });
    if (!character) {
      throw new AppError("角色不存在。", 404);
    }
    await prisma.character.update({
      where: { id: characterId },
      data: {
        ttsMode: "clone",
        ttsRefAudioPath: absolutePath,
        ttsVoiceAssetId: asset.id,
        ttsVoice: null,
        ttsDesignPrompt: null,
      },
    });
    return {
      novelId,
      characterId,
      voiceAssetId: asset.id,
      ttsMode: "clone",
      ttsRefAudioPath: absolutePath,
    };
  }
}

export const voiceLibraryService = new VoiceLibraryService();
