import Database from "better-sqlite3";

export interface SqliteRuntimePragmaOptions {
  busyTimeoutMs: number;
}

const SQLITE_JOURNAL_MODE_RETRIES = 8;

function sleepSync(milliseconds: number): void {
  const shared = new SharedArrayBuffer(4);
  Atomics.wait(new Int32Array(shared), 0, 0, milliseconds);
}

function isSqliteBusyError(error: unknown): boolean {
  return error instanceof Error && /SQLITE_BUSY|SQLITE_LOCKED|database is locked/i.test(error.message);
}

function setWalJournalMode(database: Database.Database, busyTimeoutMs: number): string | undefined {
  for (let attempt = 0; attempt < SQLITE_JOURNAL_MODE_RETRIES; attempt += 1) {
    try {
      return database.pragma("journal_mode = WAL", { simple: true }) as string;
    } catch (error) {
      if (!isSqliteBusyError(error) || attempt === SQLITE_JOURNAL_MODE_RETRIES - 1) {
        if (isSqliteBusyError(error)) {
          console.warn(
            `[sqlite] WAL journal mode is busy after ${SQLITE_JOURNAL_MODE_RETRIES} attempts; continuing with the existing journal mode.`,
          );
          return undefined;
        }
        throw error;
      }
      const delay = Math.min(250, Math.max(10, Math.ceil(busyTimeoutMs / 100) * (attempt + 1)));
      sleepSync(delay);
    }
  }
  return undefined;
}

export function configureSqliteRuntimePragmas(
  databasePath: string,
  options: SqliteRuntimePragmaOptions,
): void {
  if (process.env.SQLITE_ENABLE_WAL === "false") {
    return;
  }

  const database = new Database(databasePath);
  try {
    const busyTimeoutMs = Math.max(0, options.busyTimeoutMs);
    database.pragma(`busy_timeout = ${busyTimeoutMs}`);
    const journalMode = setWalJournalMode(database, busyTimeoutMs);
    database.pragma("synchronous = NORMAL");
    database.pragma("wal_autocheckpoint = 1000");
    if (journalMode !== "wal") {
      console.warn(`[sqlite] expected WAL journal mode, got ${JSON.stringify(journalMode)}.`);
    }
  } finally {
    database.close();
  }
}
