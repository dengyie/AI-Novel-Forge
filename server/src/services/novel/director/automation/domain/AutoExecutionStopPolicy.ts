import type { AutoExecutionQualityAction } from "./AutoExecutionQualityDebtPolicy";

export function shouldStopAutoExecutionForQualityAction(
  action: AutoExecutionQualityAction,
): boolean {
  return action === "stop_for_replan";
}
