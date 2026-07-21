import { Router } from "express";
import { z } from "zod";
import type { LlmLiveStreamFrame } from "@ai-novel/shared/types/llmLive";
import { authMiddleware } from "../../middleware/auth";
import { validate } from "../../middleware/validate";
import { llmLiveBroker } from "./LlmLiveBroker";

const router = Router();

router.use(authMiddleware);

const streamQuerySchema = z.object({
  taskId: z.string().trim().min(1).optional(),
  interactionId: z.string().trim().min(1).optional(),
  novelId: z.string().trim().min(1).optional(),
});

function allowUnfilteredLiveStream(): boolean {
  const raw = String(process.env.LLM_LIVE_ALLOW_UNFILTERED ?? "").trim().toLowerCase();
  if (raw === "1" || raw === "true" || raw === "yes" || raw === "on") {
    return true;
  }
  // Desktop / local open-auth defaults: unfiltered process bus is intentional.
  return process.env.NODE_ENV !== "production";
}

function writeFrame(res: import("express").Response, frame: LlmLiveStreamFrame, eventId?: number): void {
  if (res.writableEnded) {
    return;
  }
  if (eventId != null) {
    res.write("id: " + eventId + "\n");
  }
  res.write("event: llm_live\n");
  res.write("data: " + JSON.stringify(frame) + "\n\n");
}

router.get("/stream", validate({ query: streamQuerySchema }), (req, res) => {
  const query = streamQuerySchema.parse(req.query);
  const hasFilter = Boolean(query.taskId || query.interactionId || query.novelId);
  if (!hasFilter && !allowUnfilteredLiveStream()) {
    res.status(400).json({
      success: false,
      error: "生产环境订阅 LLM 实况需提供 taskId、novelId 或 interactionId（或设置 LLM_LIVE_ALLOW_UNFILTERED=1）。",
    });
    return;
  }
  const filter = {
    taskId: query.taskId,
    interactionId: query.interactionId,
    novelId: query.novelId,
  };
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no");
  res.flushHeaders?.();

  writeFrame(res, {
    type: "snapshot",
    sessions: llmLiveBroker.getSnapshots(filter),
  });
  const unsubscribe = llmLiveBroker.subscribe(filter, (event) => {
    writeFrame(res, { type: "event", event }, event.seq);
  });
  const heartbeat = setInterval(() => writeFrame(res, { type: "ping" }), 15_000);
  req.on("close", () => {
    clearInterval(heartbeat);
    unsubscribe();
  });
});

export default router;
