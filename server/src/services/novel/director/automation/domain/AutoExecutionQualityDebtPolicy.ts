export type AutoExecutionQualityAction =
  | "continue_with_warning"
  | "local_patch_plan"
  | "stop_for_replan";

export function isContinuableAutoExecutionQualityDebt(input: {
  action: AutoExecutionQualityAction;
  hasUsableChapterContent: boolean;
}): boolean {
  return input.hasUsableChapterContent && input.action !== "stop_for_replan";
}
