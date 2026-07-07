import { prisma } from "../../../db/prisma";

export interface PostGenerationStyleReviewPolicy {
  enabled: boolean;
  // 双轮自审改写：首轮改写后再检测一次，残留 riskScore 仍偏高才追加第二轮。
  // 渠道慢或要控成本时可用环境变量 HUMANIZER_SECOND_ROUND_ENABLED=false 关闭，退回单轮。
  secondRoundEnabled: boolean;
  // 二轮触发阈值：首轮改写产物的残留 riskScore 达到此值才进第二轮（默认 50，比首轮 35 高）。
  secondRoundThreshold: number;
}

const DEFAULT_SECOND_ROUND_THRESHOLD = 50;

function resolveSecondRoundEnabled(): boolean {
  const raw = process.env.HUMANIZER_SECOND_ROUND_ENABLED;
  if (raw == null || raw.trim() === "") {
    return true;
  }
  return raw.trim().toLowerCase() !== "false" && raw.trim() !== "0";
}

function resolveSecondRoundThreshold(): number {
  const raw = process.env.HUMANIZER_SECOND_ROUND_THRESHOLD;
  const parsed = Number(raw);
  if (Number.isFinite(parsed) && parsed >= 0 && parsed <= 100) {
    return parsed;
  }
  return DEFAULT_SECOND_ROUND_THRESHOLD;
}

export class PostGenerationStyleReviewPolicyResolver {
  async resolve(novelId: string): Promise<PostGenerationStyleReviewPolicy> {
    const novel = await prisma.novel.findUnique({
      where: { id: novelId },
      select: { postGenerationStyleReviewEnabled: true },
    });

    return {
      enabled: novel?.postGenerationStyleReviewEnabled ?? true,
      secondRoundEnabled: resolveSecondRoundEnabled(),
      secondRoundThreshold: resolveSecondRoundThreshold(),
    };
  }
}
