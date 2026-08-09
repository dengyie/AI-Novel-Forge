# Task Retention 模块边界

## 背景

任务保留扫描同时涉及终态生命周期、自动导演恢复、任务中心可见性和 Prisma 清理。把这些规则放在一个 service 中会让状态策略、数据库副作用和周期编排互相耦合，后续修复难以判断哪个模块拥有事实。

## 当前边界

- `domain/retentionPolicy.ts` 只拥有终态/活跃态常量、桶分组、年龄窗口和 supersede 选择规则；它不访问 Prisma，也不依赖 application/infrastructure。
- `domain/retentionTypes.ts` 只拥有 retention run 的稳定 summary 合同和零值构造器。
- `infrastructure/TaskRetentionCleanupStore.ts` 负责 CAS 删除、SQL 年龄筛选、孤儿 follow-up 日志清理和终态自动归档；它是这些 Prisma 写入与查询的拥有者。
- `infrastructure/TaskRetentionOrphanStore.ts` 负责 null-novel 工作流、孤儿 AgentRun、approval 过期和对应归档/硬删适配。
- `application/AutoDirectorRetentionCoordinator.ts` 负责 auto_director 僵尸恢复/取消、非导演活跃投影自愈和瞬态失败重试；重试认领仍由 `NovelWorkflowTaskAdapter` 的统一链路拥有。
- `application/TaskRetentionRunner.ts` 只编排既有步骤顺序和错误边界，不新增保留判断，也不被 HTTP 路由直接调用。
- `TaskRetentionService.ts` 是外部稳定 facade，只负责 timer 生命周期、`runOnce` 委托和兼容 re-export。`app.ts` 与其他生产模块不得深链 `retention` 内部文件。

## 依赖方向

生产调用方向是 `TaskRetentionService facade -> application -> infrastructure -> domain`；application 也可以直接消费 domain 合同。domain 不得反向依赖 Prisma、任务 adapter 或导演 runtime。

## 测试规则

策略、CAS、自动导演恢复、投影、重试和孤儿处理测试应直接实例化对应 owned module，保证测试命中真实实现。`runOnce` 的真实 SQLite 行为等价测试继续从稳定 facade 进入，覆盖完整步骤顺序和 summary 汇总。

## 失败排查

- 策略选错任务：先查 `domain/retentionPolicy.ts` 的桶键、时间回退和终态集合。
- 删除顺序或竞态：查 `TaskRetentionCleanupStore` 的事务内终态 recheck，不要在 runner 中补第二套删除逻辑。
- stale auto_director 未恢复：查 coordinator 的 stale predicate 和 adapter command acceptance，不要在 retention 中直接写成功恢复状态。
- UI 仍显示旧任务：查 cleanup store 的 archive/delete 计数和任务中心 projection；retention 不拥有前端展示规则。
