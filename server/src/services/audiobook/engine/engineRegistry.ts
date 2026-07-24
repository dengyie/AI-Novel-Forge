/**
 * engineRegistry —— L3 引擎注册表（= 通过 id 选择 TtsEngine 实现）。
 *
 * 设计纪律（对照 CosyVoice：一个 `CosyVoice` 实例即一个引擎；此处允许多引擎共存）：
 *   - 纯查表；不含合成 / delivery / voice 解析逻辑。
 *   - 引擎实例在启动时通过 `registerEngine` 注册（M2 落地 `MimoTtsEngine`）。
 *   - `AudiobookPipelineService` / `AudiobookVoiceAssetService` / preview 三处直连
 *     将于 M2 改走 `getEngine(id).synthesize(req)`（消灭 P-3/P-4）。
 *   - 未注册即抛错——留下明确的 wiring 断点，避免静默回退到旧 provider。
 *
 * SoT: docs/plans/audiobook-synthesis-layering-refactor-design.md §5
 */

import type { TtsEngine, TtsEngineId } from "./ttsEngine";

const engines = new Map<TtsEngineId, TtsEngine>();

/**
 * 注册一个引擎实例。重复注册同 id 会**覆盖**（用于测试 double / 生产热替换）。
 * 生产代码通常只在启动路径调用一次。
 */
export function registerEngine(engine: TtsEngine): void {
  engines.set(engine.id, engine);
}

/**
 * 取引擎实例。默认 `"mimo"`（当前唯一实现）。
 *
 * @throws Error 当 id 未注册。M1 契约阶段所有 id 都未注册；接线在 M2 完成。
 */
export function getEngine(id: TtsEngineId = "mimo"): TtsEngine {
  const engine = engines.get(id);
  if (!engine) {
    throw new Error(
      `TtsEngine "${id}" is not registered. ` +
        `Call registerEngine() during startup (M2 MimoTtsEngine adapter).`,
    );
  }
  return engine;
}

/** 探测某个引擎是否已注册（无副作用，不抛错）。用于启动自检 / 降级判定。 */
export function hasEngine(id: TtsEngineId): boolean {
  return engines.has(id);
}

/** 已注册引擎的 id 列表（顺序 = 注册顺序）。 */
export function listEngineIds(): TtsEngineId[] {
  return Array.from(engines.keys());
}

/**
 * 测试用：清空注册表。生产代码不应调用。
 * 双下划线前缀表示「内部/测试专用」。
 */
export function __resetEngineRegistry(): void {
  engines.clear();
}
