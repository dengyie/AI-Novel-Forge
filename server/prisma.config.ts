import { defineConfig } from "prisma/config";
import { resolveDatabaseRuntimeConfig } from "./src/config/database";
import { resolveDatabaseFilePath } from "./src/runtime/appPaths";

const runtimeConfig = resolveDatabaseRuntimeConfig();
const datasourceUrl = runtimeConfig.url.startsWith("file:")
  ? `file:${resolveDatabaseFilePath(runtimeConfig.url.slice("file:".length) || "./dev.db")}`
  : runtimeConfig.url;

export default defineConfig({
  schema: runtimeConfig.prismaSchemaPath,
  migrations: {
    path: runtimeConfig.prismaMigrationsPath,
    seed: "ts-node-dev --transpile-only src/db/seed.ts",
  },
  datasource: {
    url: datasourceUrl,
  },
});
