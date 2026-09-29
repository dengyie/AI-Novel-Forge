import fs from "node:fs";
import { pipeline } from "node:stream";
import type { ApiResponse } from "@ai-novel/shared/types/api";

function parseRangeHeader(
  rangeHeader: string | undefined,
  size: number,
): { start: number; end: number } | "invalid" | null {
  if (!rangeHeader) {
    return null;
  }
  const match = /^bytes=(\d*)-(\d*)$/i.exec(rangeHeader.trim());
  if (!match) {
    return "invalid";
  }
  const startRaw = match[1];
  const endRaw = match[2];
  let start = startRaw ? Number(startRaw) : NaN;
  let end = endRaw ? Number(endRaw) : NaN;
  if (!startRaw && !endRaw) {
    return "invalid";
  }
  if (!startRaw) {
    // suffix: bytes=-N
    const suffix = Number(endRaw);
    if (!Number.isFinite(suffix) || suffix <= 0) {
      return "invalid";
    }
    start = Math.max(0, size - suffix);
    end = size - 1;
  } else {
    if (!Number.isFinite(start) || start < 0) {
      return "invalid";
    }
    end = Number.isFinite(end) ? end : size - 1;
    if (end < start || start >= size) {
      return "invalid";
    }
    end = Math.min(end, size - 1);
  }
  return { start, end };
}

export function streamAudioFile(
  req: import("express").Request,
  res: import("express").Response,
  filePath: string,
  downloadName: string,
  contentType: string,
  disposition: "inline" | "attachment" = "inline",
): void {
  if (!fs.existsSync(filePath)) {
    res.status(404).json({
      success: false,
      error: "音频文件不存在。",
    } satisfies ApiResponse<null>);
    return;
  }
  const stat = fs.statSync(filePath);
  const size = stat.size;
  const range = parseRangeHeader(req.headers.range, size);

  res.setHeader("Content-Type", contentType);
  res.setHeader("Accept-Ranges", "bytes");
  res.setHeader("Cache-Control", "private, max-age=3600");
  res.setHeader("Content-Disposition", `${disposition}; filename="${downloadName}"`);

  if (range === "invalid") {
    res.status(416);
    res.setHeader("Content-Range", `bytes */${size}`);
    res.end();
    return;
  }

  if (range) {
    const { start, end } = range;
    const chunkSize = end - start + 1;
    res.status(206);
    res.setHeader("Content-Range", `bytes ${start}-${end}/${size}`);
    res.setHeader("Content-Length", String(chunkSize));
  } else {
    res.setHeader("Content-Length", String(size));
  }

  // The HTTP response owns the source: disconnects must close the descriptor,
  // and asynchronous open/read errors must never escape to the process handler.
  const source = fs.createReadStream(filePath, range ?? undefined);
  pipeline(source, res, (error) => {
    if (!error) return;
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ERR_STREAM_PREMATURE_CLOSE" || code === "ECONNRESET") return;
    console.warn("[audiobook-media] audio response failed", { code: code ?? "STREAM_ERROR" });
  });
}

function wantsAttachmentDownload(req: import("express").Request): boolean {
  const raw = req.query?.download;
  if (Array.isArray(raw)) {
    return raw.some((item) => item === "1" || item === "true");
  }
  return raw === "1" || raw === "true";
}

export function streamWavFile(
  req: import("express").Request,
  res: import("express").Response,
  filePath: string,
  downloadName: string,
): void {
  const disposition = wantsAttachmentDownload(req) ? "attachment" : "inline";
  streamAudioFile(req, res, filePath, downloadName, "audio/wav", disposition);
}
