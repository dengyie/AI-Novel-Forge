import { Router } from "express";
import fs from "node:fs";
import path from "node:path";
import type { ApiResponse } from "@ai-novel/shared/types/api";
import { z } from "zod";
import { prisma } from "../db/prisma";
import { llmConnectivityService } from "../llm/connectivity";
import { getStructuredFallbackSettings, saveStructuredFallbackSettings } from "../llm/structuredFallbackSettings";
import { getProviderModels } from "../llm/modelCatalog";
import { listModelRouteConfigs, MODEL_ROUTE_TASK_TYPES, upsertModelRouteConfig } from "../llm/modelRouter";
import { llmProviderSchema } from "../llm/providerSchema";
import { getProviderEnvApiKey, getProviderEnvModel, isBuiltInProvider, PROVIDERS } from "../llm/providers";
import { authMiddleware } from "../middleware/auth";
import { AppError } from "../middleware/errorHandler";
import { validate } from "../middleware/validate";

const router = Router();

const llmTestSchema = z.object({
  provider: llmProviderSchema,
  apiKey: z.string().trim().optional(),
  model: z.string().trim().optional(),
  baseURL: z.string().trim().url("API URL 格式不正确。").optional(),
  probeMode: z.enum(["plain", "structured", "both"]).optional(),
});

const structuredFallbackHopSchema = z.object({
  provider: z.string().trim().min(1),
  model: z.string().trim().min(1),
  temperature: z.number().min(0).max(2).optional(),
  maxTokens: z.union([z.number().int().min(64).max(32768), z.null()]).optional(),
});

const structuredFallbackSchema = z.object({
  enabled: z.boolean().optional(),
  provider: z.string().trim().min(1).optional(),
  model: z.string().trim().min(1).optional(),
  temperature: z.number().min(0).max(2).optional(),
  maxTokens: z.union([z.number().int().min(64).max(32768), z.null()]).optional(),
  /** Ordered multi-hop cascade. When set, first hop also mirrors legacy provider/model. */
  chain: z.array(structuredFallbackHopSchema).max(8).optional(),
});

router.use(authMiddleware);

router.get("/providers", async (_req, res, next) => {
  try {
    const keys = await prisma.aPIKey.findMany({
      orderBy: [{ createdAt: "asc" }],
    });
    const keyMap = new Map(keys.map((item) => [item.provider, item]));

    const builtInEntries = await Promise.all(
      Object.entries(PROVIDERS).map(async ([provider, config]) => {
        const keyConfig = keyMap.get(provider);
        const currentModel = keyConfig?.model?.trim()
          || getProviderEnvModel(provider)
          || config.defaultModel;
        const models = await getProviderModels(provider, {
          apiKey: keyConfig?.key ?? getProviderEnvApiKey(provider),
          baseURL: keyConfig?.baseURL ?? undefined,
          fallbackModel: currentModel,
          fallbackModels: [...config.models, currentModel],
        });
        return [provider, {
          name: config.name,
          defaultModel: currentModel,
          models,
        }] as const;
      }),
    );

    const customEntries = await Promise.all(
      keys
        .filter((item) => !isBuiltInProvider(item.provider))
        .map(async (item) => {
          const currentModel = item.model?.trim() || "";
          const models = await getProviderModels(item.provider, {
            apiKey: item.key ?? undefined,
            baseURL: item.baseURL ?? undefined,
            fallbackModel: currentModel,
            fallbackModels: [currentModel],
          });
          return [item.provider, {
            name: item.displayName?.trim() || item.provider,
            defaultModel: currentModel,
            models,
          }] as const;
        }),
    );

    const data = Object.fromEntries([...builtInEntries, ...customEntries]);
    const response: ApiResponse<typeof data> = {
      success: true,
      data,
      message: "获取模型配置成功。",
    };
    res.status(200).json(response);
  } catch (error) {
    next(error);
  }
});

router.get("/model-routes", async (_req, res, next) => {
  try {
    const data = {
      taskTypes: MODEL_ROUTE_TASK_TYPES,
      routes: await listModelRouteConfigs(),
    };
    res.status(200).json({
      success: true,
      data,
      message: "模型路由配置已加载。",
    } satisfies ApiResponse<typeof data>);
  } catch (error) {
    next(error);
  }
});

router.post("/model-routes/connectivity", async (_req, res, next) => {
  try {
    const data = await llmConnectivityService.testModelRoutes();
    res.status(200).json({
      success: true,
      data,
      message: "模型路由连通性检测完成。",
    } satisfies ApiResponse<typeof data>);
  } catch (error) {
    next(error);
  }
});

router.get("/structured-fallback", async (_req, res, next) => {
  try {
    const data = await getStructuredFallbackSettings();
    res.status(200).json({
      success: true,
      data,
      message: "结构化备用模型配置已加载。",
    } satisfies ApiResponse<typeof data>);
  } catch (error) {
    next(error);
  }
});

router.put(
  "/structured-fallback",
  validate({ body: structuredFallbackSchema }),
  async (req, res, next) => {
    try {
      const body = req.body as z.infer<typeof structuredFallbackSchema>;
      const hasChain = Array.isArray(body.chain) && body.chain.length > 0;
      if ((body.enabled ?? false) && !hasChain && (!body.provider || !body.model)) {
        throw new AppError("启用结构化备用模型时，provider/model 或 chain 不能为空。", 400);
      }
      const data = await saveStructuredFallbackSettings({
        enabled: body.enabled,
        provider: body.provider as Parameters<typeof saveStructuredFallbackSettings>[0]["provider"],
        model: body.model,
        temperature: body.temperature,
        maxTokens: body.maxTokens,
        chain: body.chain?.map((hop) => ({
          provider: hop.provider as NonNullable<Parameters<typeof saveStructuredFallbackSettings>[0]["chain"]>[number]["provider"],
          model: hop.model,
          temperature: hop.temperature ?? 0.2,
          maxTokens: hop.maxTokens ?? null,
        })),
      });
      res.status(200).json({
        success: true,
        data,
        message: "结构化备用模型配置已更新。",
      } satisfies ApiResponse<typeof data>);
    } catch (error) {
      next(error);
    }
  },
);

const modelRouteUpsertSchema = z.object({
  taskType: z.string().trim().min(1),
  provider: z.string().trim().min(1),
  model: z.string().trim().min(1),
  temperature: z.number().min(0).max(2).optional(),
  maxTokens: z.union([z.number().int().min(64).max(16384), z.null()]).optional(),
  requestProtocol: z.enum(["auto", "openai_compatible", "anthropic"]).optional(),
  structuredResponseFormat: z.enum(["auto", "json_schema", "json_object", "prompt_json"]).optional(),
});

router.put(
  "/model-routes",
  validate({ body: modelRouteUpsertSchema }),
  async (req, res, next) => {
    try {
      const body = req.body as z.infer<typeof modelRouteUpsertSchema>;
      await upsertModelRouteConfig(body.taskType, {
        provider: body.provider,
        model: body.model,
        temperature: body.temperature,
        maxTokens: body.maxTokens ?? null,
        requestProtocol: body.requestProtocol,
        structuredResponseFormat: body.structuredResponseFormat,
      });
      res.status(200).json({
        success: true,
        message: "模型路由已更新。",
      } satisfies ApiResponse<null>);
    } catch (error) {
      next(error);
    }
  },
);

router.post(
  "/test",
  validate({ body: llmTestSchema }),
  async (req, res, next) => {
    try {
      const { provider, apiKey, model, baseURL, probeMode } = req.body as z.infer<typeof llmTestSchema>;
      const result = await llmConnectivityService.testConnection({ provider, apiKey, model, baseURL, probeMode });
      const shouldFail =
        probeMode === "structured"
          ? result.structured?.ok === false
          : probeMode === "plain"
            ? result.plain?.ok === false
            : result.plain?.ok === false && result.structured?.ok === false;
      if (shouldFail) {
        if (/API Key|未配置/.test(result.error ?? "")) {
          next(new AppError(result.error ?? "未配置可用的模型连接。", 400));
          return;
        }
        next(new AppError(result.error ?? "模型连通性测试失败。", 400));
        return;
      }
      const response: ApiResponse<{
        success: boolean;
        model: string;
        latency: number;
        plain: typeof result.plain;
        structured: typeof result.structured;
      }> = {
        success: true,
        data: {
          success: result.ok || result.structured?.ok === true,
          model: result.model,
          latency: result.latency ?? 0,
          plain: result.plain,
          structured: result.structured,
        },
        message: "模型连通性与结构化兼容性测试已完成。",
      };
      res.status(200).json(response);
    } catch (error) {
      next(error);
    }
  },
);

router.get("/logs/recent", async (req, res, next) => {
  try {
    const limit = Math.min(Math.max(Number(req.query.limit) || 50, 1), 500);
    const logsDir = path.resolve(process.cwd(), "..", ".logs");
    const jsonlFiles = fs.existsSync(logsDir)
      ? fs.readdirSync(logsDir, { recursive: true })
          .filter((f) => String(f).endsWith(".llm.jsonl"))
          .map((f) => path.join(logsDir, String(f)))
          .sort((a, b) => fs.statSync(a).mtimeMs - fs.statSync(b).mtimeMs)
      : [];
    if (jsonlFiles.length === 0) {
      res.json({ success: true, data: { entries: [], files: [] } });
      return;
    }
    // Read from the most recently modified file
    const latest = jsonlFiles[jsonlFiles.length - 1]!;
    const lines = fs.readFileSync(latest, "utf-8").trim().split("\n").filter(Boolean);
    const entries = lines.slice(-limit).map((line) => {
      try { return JSON.parse(line); } catch { return null; }
    }).filter(Boolean);
    res.json({ success: true, data: { file: path.basename(latest), entries, totalLines: lines.length } });
  } catch (e) { next(e); }
});

router.get("/logs/stats", async (_req, res, next) => {
  try {
    const logsDir = path.resolve(process.cwd(), "..", ".logs");
    const jsonlFiles = fs.existsSync(logsDir)
      ? fs.readdirSync(logsDir, { recursive: true }).filter((f) => String(f).endsWith(".llm.jsonl")).map((f) => path.join(logsDir, String(f))).sort()
      : [];
    const stats = { totalRequests: 0, totalResponses: 0, errors: 0, providers: {} as Record<string, number>, models: {} as Record<string, number>, tasks: {} as Record<string, number>, totalPromptTokens: 0, totalLatencyMs: 0 };
    for (const f of jsonlFiles.slice(-5)) {
      const lines = fs.readFileSync(f, "utf-8").trim().split("\n").filter(Boolean);
      for (const line of lines) {
        try {
          const d = JSON.parse(line);
          if (d.event === "request") stats.totalRequests++;
          else if (d.event === "response") {
            stats.totalResponses++;
            const p = d.provider || "?";
            const m = d.model || "?";
            const t = d.taskType || "?";
            stats.providers[p] = (stats.providers[p] || 0) + 1;
            stats.models[m] = (stats.models[m] || 0) + 1;
            stats.tasks[t] = (stats.tasks[t] || 0) + 1;
            if (d.latencyMs) stats.totalLatencyMs += d.latencyMs;
            if (d.actualPromptTokens) stats.totalPromptTokens += d.actualPromptTokens;
          } else if (d.event === "error") stats.errors++;
        } catch { /* skip */ }
      }
    }
    res.json({ success: true, data: stats });
  } catch (e) { next(e); }
});

export default router;
