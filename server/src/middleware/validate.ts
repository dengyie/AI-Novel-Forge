import type { NextFunction, Request, RequestHandler, Response } from "express";
import type { ZodTypeAny } from "zod";
import { ZodError } from "zod";

interface ValidationSchema {
  body?: ZodTypeAny;
  query?: ZodTypeAny;
  params?: ZodTypeAny;
}

export function validate(schema: ValidationSchema): RequestHandler {
  return (req: Request, _res: Response, next: NextFunction) => {
    try {
      if (schema.body) {
        req.body = schema.body.parse(req.body);
      }
      if (schema.query) {
        // 仅校验：Express 5 的 req.query 是每次重新解析的只读 getter，
        // Object.assign 回写会被丢弃（no-op）。coerce 结果由 handler 内 schema.parse(req.query) 取用。
        schema.query.parse(req.query);
      }
      if (schema.params) {
        // 回写校验/强制转换后的结果，使 z.coerce.* 真正生效
        // （req.params 为只读字典引用，用 Object.assign 原地更新而非替换引用）
        Object.assign(req.params, schema.params.parse(req.params) as Record<string, unknown>);
      }
      next();
    } catch (error) {
      if (error instanceof ZodError) {
        next(error);
        return;
      }
      next(new Error("请求参数校验失败。"));
    }
  };
}
