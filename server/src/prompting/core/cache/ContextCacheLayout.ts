import type { PromptRenderContext } from "../promptTypes";

const SCOPES = ["book", "volume", "request"] as const;

/**
 * 预算选择先完成，布局只调整选中材料的渲染顺序：book → volume → request，
 * 同层保持声明顺序；不增删内容、不改变丢弃或压缩政策。
 */
export function renderCacheOrderedContextBlocks(context: PromptRenderContext, emptyLabel = "none"): string {
  return SCOPES
    .flatMap((scope) => context.blocks
      .filter((block) => (block.reuseScope ?? "request") === scope)
      .map((block) => block.content.trim())
      .filter(Boolean))
    .join("\n\n") || emptyLabel;
}

export function renderCacheContextSections(context: PromptRenderContext): { stable: string; dynamic: string } {
  const render = (stable: boolean) => renderCacheOrderedContextBlocks(
    { ...context, blocks: context.blocks.filter((block) => ((block.reuseScope ?? "request") !== "request") === stable) },
    "",
  );
  return { stable: render(true), dynamic: render(false) };
}
