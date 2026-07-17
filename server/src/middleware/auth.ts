import type { NextFunction, Request, Response } from "express";
import type { ApiResponse } from "@ai-novel/shared/types/api";

/**
 * Production auth modes:
 * - open: no credential (desktop / intentional private LAN). Default when API_AUTH_TOKEN unset.
 * - token: require Authorization: Bearer <token> or X-API-Token header.
 *
 * When API_AUTH_TOKEN is set, token mode is always enforced.
 * Health liveness (`GET /api/health` exact) is exempt so probes stay open.
 */
export type AuthMode = "open" | "token";

export function resolveAuthMode(): AuthMode {
  const token = process.env.API_AUTH_TOKEN?.trim();
  if (token) {
    return "token";
  }
  const explicit = process.env.AUTH_MODE?.trim().toLowerCase();
  if (explicit === "token") {
    return "token";
  }
  return "open";
}

export function resolveApiAuthToken(): string | null {
  const token = process.env.API_AUTH_TOKEN?.trim();
  return token || null;
}

/** Fail closed when production binds non-loopback without a token (unless AUTH_ALLOW_OPEN=true). */
export function assertProductionAuthSafety(options: {
  host: string;
  allowLan: boolean;
}): void {
  if (process.env.NODE_ENV !== "production") {
    return;
  }
  if (process.env.AUTH_ALLOW_OPEN === "true" || process.env.AUTH_ALLOW_OPEN === "1") {
    return;
  }
  const token = resolveApiAuthToken();
  if (token) {
    return;
  }
  const host = options.host.trim().toLowerCase();
  const publicBind =
    options.allowLan
    || host === "0.0.0.0"
    || host === "::"
    || host === "[::]";
  if (!publicBind) {
    return;
  }
  throw new Error(
    "[auth] Refusing to start in production with public bind (HOST/ALLOW_LAN) and no API_AUTH_TOKEN. "
    + "Set API_AUTH_TOKEN (and VITE_API_AUTH_TOKEN for SPA rebuild), bind HOST=127.0.0.1, "
    + "or set AUTH_ALLOW_OPEN=true only if you accept an open API on the LAN.",
  );
}

function extractPresentedToken(req: Request): string | null {
  const headerToken = req.header("x-api-token")?.trim();
  if (headerToken) {
    return headerToken;
  }
  const authorization = req.header("authorization")?.trim();
  if (!authorization) {
    return null;
  }
  const bearer = /^Bearer\s+(.+)$/i.exec(authorization);
  if (bearer?.[1]) {
    return bearer[1].trim();
  }
  return authorization;
}

function isHealthLivenessPath(req: Request): boolean {
  // Mounted at /api/health; router path is "/" for liveness.
  const url = req.originalUrl?.split("?")[0] ?? req.path ?? "";
  return url === "/api/health" || url === "/api/health/";
}

/**
 * 有声书 WAV / 角色固定试听 / 库级试听：原生 <audio>/<a> 无法带 Authorization。
 * token 模式下允许携带 ?access= 短时签名令牌进入路由，由路由校验绑定关系。
 */
export function isAudiobookMediaPath(req: Pick<Request, "originalUrl" | "url">): boolean {
  const url = (req.originalUrl ?? req.url ?? "").split("?")[0];
  return /\/audiobook\/tasks\/[^/]+\/audio\//.test(url)
    || /\/characters\/[^/]+\/voice-preview\/audio$/.test(url)
    || /\/audiobook\/voice-library\/[^/]+\/audio$/.test(url);
}

export type RequestWithApiAuth = Request & {
  apiAuthViaHeader?: boolean;
};

export function authMiddleware(req: Request, res: Response, next: NextFunction): void {
  if (isHealthLivenessPath(req)) {
    next();
    return;
  }

  const mode = resolveAuthMode();
  if (mode === "open") {
    next();
    return;
  }

  const expected = resolveApiAuthToken();
  if (!expected) {
    const response: ApiResponse<null> = {
      success: false,
      error: "服务端配置了 AUTH_MODE=token，但未设置 API_AUTH_TOKEN。",
    };
    res.status(503).json(response);
    return;
  }

  const presented = extractPresentedToken(req);
  if (presented && presented === expected) {
    (req as RequestWithApiAuth).apiAuthViaHeader = true;
    next();
    return;
  }

  const access = typeof req.query?.access === "string" ? req.query.access : null;
  if (isAudiobookMediaPath(req) && access) {
    // 路由内校验 access 与 novelId/taskId/resource 绑定
    next();
    return;
  }

  const response: ApiResponse<null> = {
    success: false,
    error: "未授权：请提供有效的 API 令牌。",
  };
  res.status(401).json(response);
}
