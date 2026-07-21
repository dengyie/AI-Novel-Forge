# LLM Live (AI 实况)

Process-local broker for model stream observability.

- Mount: `GET /api/llm-live/stream` (NOT under `/api/llm` expensive rate limit)
- Auth: same `authMiddleware` as other APIs (`API_AUTH_TOKEN` / open mode)
- Filter: prefer `taskId` / `novelId` / `interactionId`. Unfiltered process-wide bus is allowed only when `NODE_ENV !== "production"` or `LLM_LIVE_ALLOW_UNFILTERED=1`
- SSE close unsubscribes only; does not abort generation
- Preview is unvalidated model output; never persist as chapter content
- Structured prompts: **phase-only** (non-streaming JSON invoke); text prompts may stream deltas
- Feature flag: `LLM_LIVE_ENABLED=0` disables begin/hooks
