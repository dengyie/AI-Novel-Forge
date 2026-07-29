import type { ChapterArtifactDeltaOutput } from "../../../../prompting/prompts/novel/chapterArtifactDelta.prompts";
import { prisma } from "../../../../db/prisma";
import { novelFactService, type NovelFactWriteItem } from "../../fact/NovelFactService";
import { extractFacts } from "../../novelP0Utils";
import { compactText } from "../../characterResource/characterResourceShared";
import {
  ChapterProjectionRevisionGuard,
  type ChapterProjectionOwner,
} from "../projections";
import { joinFactContents } from "./ChapterArtifactContracts";

export class ChapterSummaryFactProjection {
  async project(input: {
    owner: ChapterProjectionOwner;
    chapterOrder: number;
    content: string;
    output: ChapterArtifactDeltaOutput;
  }): Promise<number> {
    const summary = compactText(input.output.summary) || "暂无可总结正文";
    const extractedFacts = extractFacts(input.content || summary);
    const keyEvents = joinFactContents(
      extractedFacts.filter((item) => item.category === "plot").map((item) => item.content),
      3,
    );
    const characterStates = joinFactContents(
      extractedFacts.filter((item) => item.category === "character").map((item) => item.content),
      3,
    );
    await prisma.$transaction(async (tx) => {
      await new ChapterProjectionRevisionGuard(tx).lockCurrentForWrite(input.owner);
      await tx.chapter.updateMany({
        where: {
          id: input.owner.chapterId,
          OR: [{ expectation: null }, { expectation: "" }],
        },
        data: { expectation: summary },
      });
      const existingSummary = await tx.chapterSummary.findUnique({
        where: { chapterId: input.owner.chapterId },
      });
      const shouldBackfillSummary = !existingSummary || existingSummary.summary.trim().length === 0;
      await tx.chapterSummary.upsert({
        where: { chapterId: input.owner.chapterId },
        update: {
          ...(shouldBackfillSummary ? { summary } : {}),
          keyEvents,
          characterStates,
        },
        create: {
          novelId: input.owner.novelId,
          chapterId: input.owner.chapterId,
          summary,
          keyEvents,
          characterStates,
        },
      });
    });

    const concreteFacts: NovelFactWriteItem[] = input.output.concreteFacts
      .map((fact) => ({
        text: compactText(fact.text),
        category: fact.category,
        source: "auto" as const,
      }))
      .filter((fact) => fact.text.length > 0);
    await novelFactService.writeChapterFacts({
      novelId: input.owner.novelId,
      chapterId: input.owner.chapterId,
      chapterOrder: input.chapterOrder,
      contentRevision: input.owner.expectedContentRevision,
      items: concreteFacts,
    });

    return concreteFacts.length;
  }
}
