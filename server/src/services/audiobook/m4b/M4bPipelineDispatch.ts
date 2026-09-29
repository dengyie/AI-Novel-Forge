import { buildM4bChapterTimeline, type AudiobookM4bChapterInput, type AudiobookM4bEncodeResult } from "../audiobookM4b";
import { resolveBetweenChapterGapMs } from "../audiobookGap";
import { resolveFullBookM4bPath } from "../audiobookPaths";
import { M4bJobQueueService } from "./M4bJobQueueService";
import { m4bWorkerManager } from "./M4bWorkerManager";

export async function dispatchM4bJob(input: {
  taskId: string; generationToken?: string | null; taskDir: string; fullAudioPath: string;
  novelTitle?: string | null; chapters: AudiobookM4bChapterInput[];
}): Promise<AudiobookM4bEncodeResult> {
  if (!input.generationToken) throw new Error("M4b dispatch requires persisted generation ownership");
  const queue = new M4bJobQueueService();
  const params = {
    audiobookTaskId: input.taskId, generationToken: input.generationToken,
    inputWavPath: input.fullAudioPath, outputM4bPath: resolveFullBookM4bPath(input.taskDir),
    metadataJson: JSON.stringify({ title: input.novelTitle?.trim() || "有声书",
      chapters: buildM4bChapterTimeline({ chapters: input.chapters, betweenChapterGapMs: resolveBetweenChapterGapMs() }) }),
  };
  try { await queue.createJob(params); }
  catch (error) {
    if ((error as { code?: string })?.code !== "P2002") throw error;
    await queue.requeueJobForTask(params);
  }
  // Do not silently start a second, unowned encoder if dispatch fails after persistence.
  await m4bWorkerManager.ensureWorkerForPendingJobs();
  return { status: "skipped", path: null, relativePath: "full-book.m4b", reason: "m4b 已入队，由独立进程编码" };
}
