import type { WritableSSEFrame } from "../../../llm/streaming";

type RunStatusFrame = Extract<WritableSSEFrame, { type: "run_status" }>;

/**
 * 构造主章节生成流（chapter runtime）的 run_status SSE 帧，纯函数、无 DB，便于专门回归测试。
 *
 * 与 repair 流的 buildRepairRunStatusFrame（`repair/ChapterRepairStreamRuntime.ts`）成对：两路
 * run_status 收敛在各自的纯函数 helper，防回到"某处 inline 报 succeeded、另一处 inline 报 failed"
 * 的形态分裂。
 *
 * 契约（对齐 F9 repair 流 `ChapterRepairStreamRuntime.ts:569`）：
 *  - status:"succeeded" 仅当 audit 无 blocking issue；`hasBlockingIssues=true` 必 "failed"。
 *  - phase 语义由调用方决定：中间态用 "finalizing"（正文已生成、正在落库/检查），
 *    终态用 "completed"（章节已落库）。blocking-issue 章节也用 "completed" —— 章节确已落库，
 *    只是 audit 检出待修 issue，状态待 needs_repair。phase 不丢 completed 语义。
 *  - runId 由调用方传入（主生流有 `traceRunId ?? chapter-runtime:<id>` 覆写链，见
 *    ChapterStreamGenerationOrchestrator 的 runStatusId 派生），与 F9 helper 直接派生
 *    `chapter-repair:<id>` 略异——主生流保留 traceRunId 优先，故收 runId 必填。
 *
 * 取证：监管 poller（ChapterExecutionProgressInspector + NovelDirectorService.getRuntimeProjection）
 * 不读 SSE run_status 帧的 status 字段，而是从 DB chapter row + audit flags 重推 needs_repair。
 * 故此 status 不影响 poller 自动续跑；它服务客户端 UI 文案与跨运行时契约一致。详见
 * 审查报告 P1-1 与 tests/chapterRunStatusReport.test.js。
 */
export type ChapterRunStatus = "running" | "succeeded" | "failed";
export type ChapterRunStatusPhase = "streaming" | "finalizing" | "completed";

export function buildChapterRunStatusFrame(input: {
  runId: string;
  status: ChapterRunStatus;
  phase: ChapterRunStatusPhase;
  message: string;
}): RunStatusFrame {
  return {
    type: "run_status",
    runId: input.runId,
    status: input.status,
    phase: input.phase,
    message: input.message,
  };
}
