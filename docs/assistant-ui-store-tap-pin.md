# @assistant-ui store / tap 版本钉扎

## 为什么 pin `store@0.2.13`

`package.json` → `pnpm.overrides["@assistant-ui/store"] = "0.2.13"`。

| 包 | 字段协议 |
|---|---|
| `@assistant-ui/tap@0.5.x` | `ResourceElement = { type, props }` |
| `@assistant-ui/store@<=0.2.13` | `splitClients` 读 `clientElement.type` |
| `@assistant-ui/store@>=0.2.16` | `splitClients` 读 `clientElement.hook` |
| `@assistant-ui/tap@>=0.7` | `ResourceElement = { hook, props }` |

错误组合（本仓库曾踩坑）：**store 0.2.20 + tap 0.5.16**  
→ `getTransformScopes(undefined)` → 创作中枢整页白屏。

## 升级规则

1. **不要**单独把 store override 抬到 `0.2.16+`。
2. 若升级 store 到 hook 协议：必须同步 **tap >= 0.7**，并验证 `@assistant-ui/react` / `react-langgraph` 全链路。
3. 契约测试：`client/tests/assistantUiStoreTapContract.test.js`。
