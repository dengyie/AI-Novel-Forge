#!/usr/bin/env node
/**
 * Ops: 把角色表 ttsRefAudioPath 历史绝对路径规范化为相对 voice-refs 根。
 *
 * Why: bindCharacter 现存相对路径（防根目录/symlink 迁移后绑定集体失效）；
 *      旧数据仍可能是绝对路径。本脚本显式迁移 + 校验剩余，作为惰性迁移的 ops 双保险。
 *
 * Safety:
 *   - 仅迁移 ttsMode=clone 且 ttsRefAudioPath 为绝对路径的行
 *   - 越界（不在 voice-refs 根内）保持绝对不迁，报告但不阻断
 *   - 默认 dry-run；VOICEREF_MIGRATE_WRITE=1 才写库
 *   - 复用 voiceLibraryService.migrateCharacterCloneRefPathsRelativeOnce（同源逻辑）
 *
 * Usage (on pxed, novel-server host):
 *   node server/scripts/migrate-character-clone-ref-paths.cjs            # dry-run + audit
 *   VOICEREF_MIGRATE_WRITE=1 node server/scripts/migrate-character-clone-ref-paths.cjs
 */
const path = require("node:path");

function loadDistModule(modulePath) {
  try {
    return require(modulePath);
  } catch (error) {
    if (error && error.code === "MODULE_NOT_FOUND") {
      throw new Error("Build the server first: pnpm --filter @ai-novel/server build");
    }
    throw error;
  }
}

async function main() {
  const serverRoot = path.resolve(__dirname, "..");
  const repoRoot = path.resolve(serverRoot, "..");
  const { prisma } = loadDistModule(path.join(repoRoot, "server", "dist", "db", "prisma.js"));
  const svc = loadDistModule(path.join(repoRoot, "server", "dist", "services", "audiobook", "voiceLibraryService.js"));

  const write = process.env.VOICEREF_MIGRATE_WRITE === "1";

  // 1) 审计：当前绝对路径存量
  const rows = await prisma.character.findMany({
    where: { ttsMode: "clone", ttsRefAudioPath: { not: null } },
    select: { id: true, name: true, ttsRefAudioPath: true, ttsVoiceAssetId: true },
  });
  const absoluteRows = rows.filter((r) => {
    const p = (r.ttsRefAudioPath || "").trim();
    return p && path.isAbsolute(p);
  });

  console.log(`[audit] clone 配置角色: ${rows.length}；其中绝对路径: ${absoluteRows.length}`);

  if (!write) {
    if (absoluteRows.length > 0) {
      console.log("[dry-run] 待迁移（前 20 条）：");
      for (const r of absoluteRows.slice(0, 20)) {
        console.log(`  - ${r.id} (asset=${r.ttsVoiceAssetId || "-"}): ${r.ttsRefAudioPath}`);
      }
      if (absoluteRows.length > 20) console.log(`  ... 还有 ${absoluteRows.length - 20} 条`);
    }
    console.log("[dry-run] 设置 VOICEREF_MIGRATE_WRITE=1 真正写库迁移。");
    return;
  }

  // 2) 写库迁移：复用同源惰性迁移函数
  const result = await svc.migrateCharacterCloneRefPathsRelativeOnce();
  console.log(`[migrate] migrated=${result.migrated} skippedOutOfRoot=${result.skippedOutOfRoot} attempted=${result.attempted}`);

  // 3) 校验：迁移后仍残留绝对的行（应为 0；非 0 说明越界绝对，需人工看是否合理）
  const after = await prisma.character.findMany({
    where: { ttsMode: "clone", ttsRefAudioPath: { not: null } },
    select: { id: true, name: true, ttsRefAudioPath: true },
  });
  const remainingAbs = after.filter((r) => {
    const p = (r.ttsRefAudioPath || "").trim();
    return p && path.isAbsolute(p);
  });
  if (remainingAbs.length > 0) {
    console.warn(`[verify] 仍有 ${remainingAbs.length} 条绝对路径（越界/非 voice-refs 根，保留绝对可解析）：`);
    for (const r of remainingAbs.slice(0, 20)) {
      console.warn(`  - ${r.id}: ${r.ttsRefAudioPath}`);
    }
  } else {
    console.log("[verify] 所有 clone ttsRefAudioPath 已规范为相对路径。");
  }
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error("[migrate] 失败：", error);
    process.exit(1);
  });
