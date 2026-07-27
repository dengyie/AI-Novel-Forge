# Volume Readiness 模块边界

`VolumeReadinessExecutor` 只负责卷级运行编排：读取计划、控制预算与取消、选择 review / repair / polish 动作、记录结果并汇总。

`application/ChapterReviewStatusReconciler.ts` 负责真 review 后的章节状态收口。它只在审校信号全绿时，以 `contentRevision + chapterStatus` 做 CAS；CAS 未命中必须保留 `needs_re_review`，不能把旧审校结果投影到新正文。

`application/VolumeReadinessExecutionSupport.ts` 负责执行协议支撑，包括 repair stream 终态解释、章级超时与取消、重试计数、LLM 预算估算和只读正文加载。这些协议不应重新堆回 executor。

依赖方向为 `VolumeReadinessExecutor -> readiness/application -> readiness policy / run store / chapter lifecycle`。应用服务不得反向依赖 executor，也不得在这些支撑模块中新增正文生成或修复实现；正文改写仍统一委托章节 runtime。
