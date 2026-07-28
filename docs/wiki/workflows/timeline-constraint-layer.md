# 时间线约束层

## 背景

章节生产链路已有 `StoryStateSnapshot`、`ConsistencyFact` 和 `CharacterTimeline`，但这些资产主要承担章节后的状态摘要、事实抽取和角色经历记录。它们缺少一个独立的“事件顺序约束层”，无法稳定阻止未来事件泄漏、上一章钩子断接、时间倒退、事件重复和角色状态回滚。

时间线约束层用于给章节生产提供更硬的事件顺序骨架。它不负责写正文，不直接改正文，也不替代章节计划或状态快照。

## 决策

新增独立 `timeline` 模块，时间线只负责四件事：

- 记录计划事件、已发生事件、章节时间锚点、钩子和检测报告。
- 在章节生成前提供不可裁剪的 `timeline_context` 和 `previous_chapter_hook`。
- 在正文生成后抽取关键事件并校验时间线一致性。
- 检测失败时输出问题给章节修复链路，不直接修改正文。

失败章节应保留正文并标记为 `needs_repair`，但不能把失败正文中的事件提交为 `occurred` 时间线，避免污染后续上下文。

## 当前规则

- `StoryTimelineEvent` 管全局事件顺序，区分 `planned` 和 `occurred`。
- `ChapterTimeAnchor` 管章节处于什么故事时间、承接哪些事件、禁止提前发生哪些事件。
- `TimelineHook` 管上一章或前文遗留的钩子，当前语义分成 `resolveMode` 与 `blocking` 两个维度：`immediate + blocking` 才进入硬阻断，`short_arc` 和 `long_arc` 只进入提示或低优先级约束。
- `TimelineCheckReport` 记录每次正文后的检测结果，供任务中心和章节编辑器展示。
- `timeline_context` 是章节写作 required context；`recent_chapters` 仍可作为辅助记忆，但不能替代时间线约束。
- 时间线抽取使用结构化 AI 输出；检测器只对结构化事件、钩子和状态变化做确定性判断。
- `autoReview=false` 不影响时间线检测。时间线检测属于章节接收闸门，不依赖完整质量审校事实。
- 检测失败时不提交 `occurred` 事件；通过或 warning 时才允许提交抽取事件和新钩子。
- 自动时间线投影必须绑定已提交正文的 `contentRevision`。抽取完成后、任何 canonical 写入前，以及拥有写入的数据库事务内，都要再次验证 `{ novelId, chapterId, contentRevision }`；不匹配表示本次投影已被新正文取代（superseded），只终止本次局部投影，不得触发章节失败、自动导演失败或重规划。
- 自动重投影按章节替换 `source=chapter_extraction` 的事件、钩子和时间锚点。人工维护的数据必须使用显式来源标记保留，禁止通过标题文本或其他启发式规则推断所有权。
- 自动修复由现有章节修复链路处理，timeline 模块只提供问题清单和修复建议。
- 章节接收闸门会把 `acceptance` 与 `timeline` 并行执行，并对同一章同一内容 hash 做门禁缓存，避免重复触发相同检测。
- 长弧钩子被正文部分回应时，应标记为已处理或已触达，而不是继续按下一章必须解决的硬阻断处理。

## 失败模式

- 第 N 章提前写出第 N+M 章才应发生的事件：检查 `forbiddenEvents` 是否进入 `timeline_context`，以及 checker 是否输出 `future_event_leak`。
- 下一章跳过上一章结尾钩子：检查 `TimelineHook` 是否仍为 `open`，以及 `previous_chapter_hook` 是否被 Prompt Context 保留；如果是 `short_arc` 或 `long_arc`，优先检查是否被错误升级成 `immediate + blocking`。
- 角色状态回滚：检查上一轮 `occurred` 事件的 `stateChanges` 是否记录了 confirmed 状态。
- 检测失败但后续章节继续引用污染事件：检查失败章是否错误提交了 `occurred` timeline。
- 时间线检测长期 warning：检查 extractor prompt 是否无法抽取章节时间锚点，或章节计划本身缺少时间标签。
- 人工改正文后仍出现旧事件或旧钩子：检查 finalization 是否携带 committed `contentRevision`，事务是否在首个时间线副作用前重新校验，以及自动数据是否带有 `source=chapter_extraction`；revision mismatch 应记录为 superseded，而不是降级写入旧锚点。

## 相关模块

- `server/src/modules/timeline/`
- `server/src/services/novel/runtime/GenerationContextAssembler.ts`
- `server/src/services/novel/runtime/ChapterRuntimeCoordinator.ts`
- `server/src/prompting/prompts/novel/chapterWriter.prompts.ts`
- `server/src/prompting/prompts/novel/timelineExtractor.prompts.ts`
- `shared/types/timeline.ts`

## 来源文档

- 当前时间线约束层开发方案
- [章节生产链路](./chapter-production-chain.md)
- [模块边界与文档治理](../architecture/module-boundaries.md)
