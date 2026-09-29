# 修复未采纳结果的正文归属

- [x] 实际 SQLite 复现评估期间 R7→R8，旧 discard 覆盖新 repairHistory。
- [x] history + feedback 收口到唯一 revision-owned 事务，瞬态数据库错误重试整笔事务；正文升版时终止旧结果。
- [x] 验证当前正文正常 discard、旧正文 discard 不写入、写入故障无部分历史提交。
- [x] 更新 wiki 和用户发布说明，检查提交范围。

证据：`/tmp/round2-repair-red.log` 旧实现并发测试失败；`/tmp/round2-repair-build.log` server build 成功；`/tmp/round2-repair-final.log` 82/82 测试通过。覆盖修复 CAS、长度门、runtime coordinator、质量闭环与反馈总线。本阶段无 UI 交互改动，界面验收由用户进行。
