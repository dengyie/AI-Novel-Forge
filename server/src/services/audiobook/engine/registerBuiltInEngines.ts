/**
 * registerBuiltInEngines —— 启动时把内置 TTS 引擎实例注册进 registry。
 *
 * 设计纪律（对照 docs/plans/audiobook-synthesis-layering-refactor-design.md §5）：
 *   - 这是 L1/L2 与 L3 之间的唯一接线点；调用一次即可。
 *   - 幂等：`registerEngine` 对同 id 覆盖，重复调用安全（测试 double / 热替换场景）。
 *   - 未来加第二引擎（CosyVoice 侧车）= 在此处 `registerEngine(cosyVoiceEngine)` 加一行，
 *     L1/L2 零改——这正是分层红利。
 */

import { hasEngine, registerEngine } from "./engineRegistry";
import { mimoTtsEngine } from "./mimoTtsEngine";

/** 注册所有内置 TTS 引擎。应在 server 启动早期调用一次。 */
export function registerBuiltInEngines(): void {
  registerEngine(mimoTtsEngine);
}

/** 自检：内置 mimo 引擎是否已注册（启动日志/降级判定可用）。 */
export function mimoEngineRegistered(): boolean {
  return hasEngine("mimo");
}
