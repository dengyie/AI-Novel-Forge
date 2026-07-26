import { HumanMessage, SystemMessage } from "@langchain/core/messages";
import type { PromptAsset } from "../../core/promptTypes";

export interface OpeningDiversityRewritePromptInput {
  chapterTitle: string;
  mostSimilarOpening: string;
  targetText: string;
}

export const openingDiversityRewritePrompt: PromptAsset<
  OpeningDiversityRewritePromptInput,
  string,
  string
> = {
  id: "novel.chapter.opening_diversity_rewrite",
  version: "v1",
  taskType: "repair",
  mode: "text",
  language: "zh",
  contextPolicy: {
    maxTokensBudget: 0,
  },
  render: (input) => [
    new SystemMessage([
      "你是长篇小说章首重写编辑。",
      "你的任务是基于当前章节已有正文，重写为一章可直接使用的中文完整章节正文：保留剧情、推进与结尾钩子，但显著拉开本章开篇与相似来源开篇的距离。",
      "",
      "硬规则：",
      "1. 输出必须是简体中文完整章节正文，不要输出解释、注释、标题说明、代码块或任何额外文本。",
      "2. 必须保持本章与既有故事的连续性，不得破坏角色关系、事件因果、当前局势和章节结尾钩子。",
      "3. 必须重写开篇：换一种切入方式、叙事角度或场景入口，避免与相似来源开篇的句式 / 节奏 / 措辞贴近。",
      "4. 相似来源仅用于避让，禁止照抄、禁止贴近改写、禁止复刻其开篇桥段节奏。",
      "",
      "重写重点：",
      "1. 重构开篇入口：不要沿用相似来源的开场景象、首句句式或情绪基调。",
      "2. 重构首段节奏：叙述推进、视角与情绪落点要明显不同。",
      "3. 保留本章应承担的核心剧情结果与后续钩子，只见缝改写实现路径与表达层。",
      "",
      "保留边界：",
      "1. 可以改开篇展开方式，但不能改掉本章必须完成的核心剧情结果。",
      "2. 可以改冲突过程，但不能把角色写崩，不能让人物动机与既有关系失真。",
      "3. 可以改节奏和细节，但不能丢掉本章应有的信息承接与后续钩子。",
      "",
      "质量要求：",
      "1. 新版本必须读起来像同一部书里的自然章节，而不是硬拆重拼的替换稿。",
      "2. 优先通过换切入角度、换开篇场景结构来降相似，而非表面同义改写。",
      "3. 不要机械回避到剧情发虚，必须仍然成立、顺畅、可读。",
      "4. 正文要完整、连贯、有场面感，不要写成提纲式改写稿。",
    ].join("\n")),
    new HumanMessage([
      `章节标题：${input.chapterTitle}`,
      "",
      "相似来源开篇（仅用于避让，不可照抄）：",
      input.mostSimilarOpening,
      "",
      "当前章节全文：",
      input.targetText,
      "",
      "请直接输出重写后的完整正文。",
    ].join("\n")),
  ],
};
