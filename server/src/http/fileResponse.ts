import type { NextFunction, Response } from "express";
import { AppError } from "../middleware/errorHandler";

/** Only sendFile owns these status codes; arbitrary application errors remain untrusted. */
export function sendFileResponse(filePath: string, res: Response, next: NextFunction): void {
  res.sendFile(filePath, (error) => {
    if (!error || res.destroyed) return;
    if (res.headersSent) {
      res.destroy(error);
      return;
    }
    const fileError = error as Error & { status?: number; statusCode?: number; headers?: Record<string, unknown> };
    const requestedStatus = fileError.statusCode ?? fileError.status;
    const status = requestedStatus && [400, 403, 404, 412, 416].includes(requestedStatus) ? requestedStatus : 500;
    // A failed image response is JSON, and must not inherit image type, length or cache policy.
    res.removeHeader("Content-Type");
    res.removeHeader("Content-Length");
    res.removeHeader("Cache-Control");
    if (status === 416) {
      const range = fileError.headers?.["Content-Range"];
      if (typeof range === "string" && /^bytes \*\/\d+$/.test(range)) res.setHeader("Content-Range", range);
    }
    const message = status === 416 ? "请求的文件范围无效。"
      : status === 404 ? "文件不存在。" : "文件请求无法完成。";
    const responseError = new AppError(message, status);
    Object.defineProperty(responseError, "cause", { value: error });
    next(responseError);
  });
}
