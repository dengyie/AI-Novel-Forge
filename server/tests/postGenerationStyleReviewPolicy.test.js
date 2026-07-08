const test = require("node:test");
const assert = require("node:assert/strict");

const {
  resolveSecondRoundEnabled,
  resolveSecondRoundThreshold,
  DEFAULT_SECOND_ROUND_THRESHOLD,
} = require("../dist/services/novel/runtime/PostGenerationStyleReviewPolicyResolver.js");

// 每个用例前后保存/还原 env，避免污染其他测试。
function withEnv(key, value, run) {
  const had = Object.prototype.hasOwnProperty.call(process.env, key);
  const prev = process.env[key];
  if (value === undefined) {
    delete process.env[key];
  } else {
    process.env[key] = value;
  }
  try {
    run();
  } finally {
    if (had) {
      process.env[key] = prev;
    } else {
      delete process.env[key];
    }
  }
}

// ============ resolveSecondRoundEnabled ============

test("未设置环境变量 → 默认启用二轮", () => {
  withEnv("HUMANIZER_SECOND_ROUND_ENABLED", undefined, () => {
    assert.equal(resolveSecondRoundEnabled(), true);
  });
});

test("空字符串 → 默认启用（不误判为关闭）", () => {
  withEnv("HUMANIZER_SECOND_ROUND_ENABLED", "", () => {
    assert.equal(resolveSecondRoundEnabled(), true);
  });
});

test("false / 0 → 关闭二轮", () => {
  withEnv("HUMANIZER_SECOND_ROUND_ENABLED", "false", () => {
    assert.equal(resolveSecondRoundEnabled(), false);
  });
  withEnv("HUMANIZER_SECOND_ROUND_ENABLED", "0", () => {
    assert.equal(resolveSecondRoundEnabled(), false);
  });
  withEnv("HUMANIZER_SECOND_ROUND_ENABLED", "FALSE", () => {
    assert.equal(resolveSecondRoundEnabled(), false);
  });
});

test("true / 其他非空值 → 启用二轮", () => {
  withEnv("HUMANIZER_SECOND_ROUND_ENABLED", "true", () => {
    assert.equal(resolveSecondRoundEnabled(), true);
  });
  withEnv("HUMANIZER_SECOND_ROUND_ENABLED", "1", () => {
    assert.equal(resolveSecondRoundEnabled(), true);
  });
});

// ============ resolveSecondRoundThreshold ============

test("回归守卫：空字符串不得击穿成阈值 0", () => {
  // Number("")===0，若不先判空会让阈值变 0，riskScore>=0 恒真，二轮永远触发。
  withEnv("HUMANIZER_SECOND_ROUND_THRESHOLD", "", () => {
    assert.equal(resolveSecondRoundThreshold(), DEFAULT_SECOND_ROUND_THRESHOLD);
  });
});

test("空白字符串 → 回落默认", () => {
  withEnv("HUMANIZER_SECOND_ROUND_THRESHOLD", "   ", () => {
    assert.equal(resolveSecondRoundThreshold(), DEFAULT_SECOND_ROUND_THRESHOLD);
  });
});

test("未设置 → 回落默认", () => {
  withEnv("HUMANIZER_SECOND_ROUND_THRESHOLD", undefined, () => {
    assert.equal(resolveSecondRoundThreshold(), DEFAULT_SECOND_ROUND_THRESHOLD);
  });
});

test("合法数值 [0,100] → 采用", () => {
  withEnv("HUMANIZER_SECOND_ROUND_THRESHOLD", "70", () => {
    assert.equal(resolveSecondRoundThreshold(), 70);
  });
  withEnv("HUMANIZER_SECOND_ROUND_THRESHOLD", "0", () => {
    // 显式设 0 是用户意图（激进二轮），与空串击穿区分：显式 "0" 应被采纳。
    assert.equal(resolveSecondRoundThreshold(), 0);
  });
  withEnv("HUMANIZER_SECOND_ROUND_THRESHOLD", "100", () => {
    assert.equal(resolveSecondRoundThreshold(), 100);
  });
});

test("越界 / 非数值 → 回落默认", () => {
  withEnv("HUMANIZER_SECOND_ROUND_THRESHOLD", "150", () => {
    assert.equal(resolveSecondRoundThreshold(), DEFAULT_SECOND_ROUND_THRESHOLD);
  });
  withEnv("HUMANIZER_SECOND_ROUND_THRESHOLD", "-10", () => {
    assert.equal(resolveSecondRoundThreshold(), DEFAULT_SECOND_ROUND_THRESHOLD);
  });
  withEnv("HUMANIZER_SECOND_ROUND_THRESHOLD", "abc", () => {
    assert.equal(resolveSecondRoundThreshold(), DEFAULT_SECOND_ROUND_THRESHOLD);
  });
});
