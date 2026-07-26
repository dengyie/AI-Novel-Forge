const chapterRepairLocks = new Map<string, Promise<unknown>>();

export async function acquireChapterRepairLock(chapterId: string): Promise<() => void> {
  const previous = chapterRepairLocks.get(chapterId) ?? Promise.resolve();
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const chain = previous.then(() => held, () => held);
  chapterRepairLocks.set(chapterId, chain);
  await previous.catch(() => undefined);
  return () => {
    release();
    if (chapterRepairLocks.get(chapterId) === chain) {
      chapterRepairLocks.delete(chapterId);
    }
  };
}

export function getChapterRepairLockTableSizeForTests(): number {
  return chapterRepairLocks.size;
}

export function resetChapterRepairLocksForTests(): void {
  chapterRepairLocks.clear();
}
