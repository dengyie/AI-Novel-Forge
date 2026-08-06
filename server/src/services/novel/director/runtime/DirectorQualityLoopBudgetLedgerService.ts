/**
 * 兼容层（方案 C，Phase 1.1）：质量回环预算账本已上提为共享纯函数模块
 * `../qualityLoopBudget`（`server/src/services/novel/qualityLoopBudget.ts`），
 * volume 层与 director 层都只 import 共享模块，杜绝 volume → director 循环依赖。
 *
 * 本文件保留为 re-export，兼容既有 import（`director/runtime/DirectorQualityLoopBudgetLedgerService`），
 * 避免目录内引用断链。
 */
export * from "../../qualityLoopBudget";