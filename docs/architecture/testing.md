# 后端测试基础设施

本仓库的长期业务逻辑主要在 [`server/tests/`](../../server/tests/) 下，使用 **Node 内置 `node:test`** 与 **`node:assert/strict`**，执行前会先构建 `@ai-novel/shared` 与 `@ai-novel/server`（见 [`server/package.json`](../../server/package.json) `test` 脚本）。

## 运行方式

```bash
# 在仓库根目录（推荐）
pnpm test

# 或仅在 server 包内
pnpm --filter @ai-novel/server test
```

单次只跑某一文件示例：

```bash
cd server && pnpm run build && node --test tests/chapterLifecycleState.test.js
```

## 覆盖重点

现有用例已覆盖包括但不限于：结构化 LLM 解析与降级（[`structuredInvoke.test.js`](../../server/tests/structuredInvoke.test.js)）、导演运行时与 Worker（[`directorRuntimeStore.test.js`](../../server/tests/directorRuntimeStore.test.js)、[`directorWorker.test.js`](../../server/tests/directorWorker.test.js)）、小说工作流恢复（[`novelWorkflowRecoveryNormalization.test.js`](../../server/tests/novelWorkflowRecoveryNormalization.test.js)）、提示词治理注册（[`prompting-governance.test.js`](../../server/tests/prompting-governance.test.js)）。

新增纯函数或状态时，请在 `tests/` 下增加对应 `*.test.js`，保持与既有风格一致：**先 `pnpm run build`**，再 **`require("../dist/...")`** 引用编译产物。

## 与其它质量门禁

根目录 `pnpm typecheck` / `pnpm lint` 与各包脚本互补；大改动Director/Prisma 时务必本地跑通 `pnpm test` 后再提交。
