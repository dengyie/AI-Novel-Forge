import type { ReplanDecision } from "./replanDecision";

export function shouldExecutePlannerReplan(
  decision: Pick<ReplanDecision, "action">,
): boolean {
  return decision.action === "stop_for_replan";
}
