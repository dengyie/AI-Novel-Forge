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

const TARGET_PROVIDER = "openai";
const TARGET_MODEL = "deepseek-v4-pro";

async function main() {
  const serverRoot = path.resolve(__dirname, "..");
  const repoRoot = path.resolve(serverRoot, "..");
  const { prisma } = loadDistModule(path.join(repoRoot, "server", "dist", "db", "prisma.js"));
  const { MODEL_ROUTE_TASK_TYPES } = loadDistModule(
    path.join(repoRoot, "server", "dist", "llm", "modelRouter.js"),
  );

  const write = process.env.MODEL_ROUTES_MIGRATE_WRITE === "1";

  const report = [];
  for (const taskType of MODEL_ROUTE_TASK_TYPES) {
    const existing = await prisma.modelRouteConfig.findUnique({
      where: { taskType },
    });

    const temperature = existing?.temperature ?? 0.7;
    const maxTokens = existing?.maxTokens ?? null;
    const requestProtocol = existing?.requestProtocol ?? "openai_compatible";
    const structuredResponseFormat = existing?.structuredResponseFormat ?? "json_object";

    const alreadyTargeted = existing
      && existing.provider === TARGET_PROVIDER
      && existing.model === TARGET_MODEL;

    report.push({
      taskType,
      before: existing
        ? { provider: existing.provider, model: existing.model, temperature: existing.temperature }
        : null,
      after: { provider: TARGET_PROVIDER, model: TARGET_MODEL, temperature, maxTokens, requestProtocol, structuredResponseFormat },
      unchanged: alreadyTargeted,
    });

    if (!write) {
      continue;
    }

    if (alreadyTargeted) {
      continue;
    }

    await prisma.modelRouteConfig.upsert({
      where: { taskType },
      create: {
        taskType,
        provider: TARGET_PROVIDER,
        model: TARGET_MODEL,
        temperature,
        maxTokens,
        requestProtocol,
        structuredResponseFormat,
      },
      update: {
        provider: TARGET_PROVIDER,
        model: TARGET_MODEL,
      },
    });
  }

  console.log(JSON.stringify({
    dryRun: !write,
    target: { provider: TARGET_PROVIDER, model: TARGET_MODEL },
    count: report.length,
    routes: report,
  }, null, 2));

  await prisma.$disconnect();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
