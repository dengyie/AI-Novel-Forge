import "dotenv/config";
import { prisma } from "../db/prisma";
import { runM4bWorker } from "../services/audiobook/m4b";

const shutdown = new AbortController();
const stop = () => shutdown.abort();
process.once("SIGTERM", stop);
process.once("SIGINT", stop);
void runM4bWorker(shutdown.signal)
  .catch((error) => { console.error("[m4b-worker] failed", error); process.exitCode = 1; })
  .finally(async () => {
    process.removeListener("SIGTERM", stop);
    process.removeListener("SIGINT", stop);
    await prisma.$disconnect();
  });
