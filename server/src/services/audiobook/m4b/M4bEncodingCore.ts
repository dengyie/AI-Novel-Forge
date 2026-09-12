import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { runFfmpegProcess, type M4bProgressCallback } from "../infrastructure/m4b/FfmpegProcessRunner";
import {
  buildM4bFfmetadata,
  buildM4bFfmpegArgs,
  resolveFfmpegBinary,
  resolveM4bFfmpegThreads,
} from "../audiobookM4b";
import { cleanupStaleM4bParts } from "../audiobookPaths";

export interface M4bEncodeInput {
  sourceWavPath: string;
  outputM4bPath: string;
  bookTitle: string;
  chapters: Array<{ title: string; startMs: number; endMs: number }>;
  signal?: AbortSignal;
  onProgress?: M4bProgressCallback | null;
}

export interface M4bEncodeResult {
  success: boolean;
  outputPath: string | null;
  error: string | null;
  skipped: boolean;
}

export async function executeM4bEncoding(input: M4bEncodeInput): Promise<M4bEncodeResult> {
  if (!fs.existsSync(input.sourceWavPath)) {
    return {
      success: false,
      outputPath: null,
      error: "Source WAV file does not exist",
      skipped: false,
    };
  }

  if (input.signal?.aborted) {
    return {
      success: false,
      outputPath: null,
      error: "Encoding was aborted",
      skipped: false,
    };
  }

  const ffmpeg = resolveFfmpegBinary();
  if (!ffmpeg) {
    return {
      success: false,
      outputPath: null,
      error: "ffmpeg not found (set AUDIOBOOK_FFMPEG_PATH or FFMPEG_PATH)",
      skipped: true,
    };
  }

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "audiobook-m4b-"));
  const metaPath = path.join(tmpDir, "chapters.ffmeta");
  const runId = `${Date.now().toString(36)}-${process.pid}-${Math.random().toString(36).slice(2, 8)}`;
  const partPath = path.join(
    path.dirname(input.outputM4bPath),
    `${path.basename(input.outputM4bPath)}.${runId}.part`,
  );

  try {
    // Check if output already exists (concurrent safety)
    if (fs.existsSync(input.outputM4bPath) && fs.statSync(input.outputM4bPath).size >= 64) {
      return {
        success: true,
        outputPath: input.outputM4bPath,
        error: null,
        skipped: false,
      };
    }

    cleanupStaleM4bParts(path.dirname(input.outputM4bPath), input.outputM4bPath);

    fs.writeFileSync(
      metaPath,
      buildM4bFfmetadata({
        title: input.bookTitle?.trim() || "有声书",
        chapters: input.chapters,
      }),
      "utf8",
    );

    const args = buildM4bFfmpegArgs({
      sourceWavPath: input.sourceWavPath,
      metadataPath: metaPath,
      outputPath: partPath,
      threads: resolveM4bFfmpegThreads(),
    });

    const result = await runFfmpegProcess({
      ffmpeg,
      args,
      partPath,
      signal: input.signal,
      onProgress: input.onProgress,
    });

    if (result.status !== 0) {
      return {
        success: false,
        outputPath: null,
        error: `ffmpeg encoding failed with exit code ${result.status}: ${result.stderr.slice(0, 500)}`,
        skipped: false,
      };
    }

    if (!fs.existsSync(partPath) || fs.statSync(partPath).size < 64) {
      return {
        success: false,
        outputPath: null,
        error: "ffmpeg completed but output file is missing or too small",
        skipped: false,
      };
    }

    fs.renameSync(partPath, input.outputM4bPath);

    return {
      success: true,
      outputPath: input.outputM4bPath,
      error: null,
      skipped: false,
    };
  } catch (error) {
    return {
      success: false,
      outputPath: null,
      error: error instanceof Error ? error.message : String(error),
      skipped: false,
    };
  } finally {
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      // ignore cleanup errors
    }
    try {
      if (fs.existsSync(partPath)) fs.unlinkSync(partPath);
    } catch {
      // ignore cleanup errors
    }
  }
}
