import { Prisma } from "@prisma/client";

/** AudiobookTask 表尚未迁移时 Prisma 返回 P2021。 */
export function isMissingAudiobookTaskTableError(error: unknown): boolean {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2021";
}

export async function withAudiobookTableFallback<T>(
  operation: () => Promise<T>,
  fallback: T,
): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    if (isMissingAudiobookTaskTableError(error)) {
      return fallback;
    }
    throw error;
  }
}
