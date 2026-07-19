/**
 * OpsReport 进程内 approve 门禁 §D（阶段 3）。
 * 纯 env 测，不依赖 voiceLibraryService / prisma / 文件系统。
 */
const { describe, it, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert/strict");

// 必须先 require 再清 env；assertOpsApproveAllowed 每次调用读 process.env 即时值
const {
  assertOpsApproveAllowed,
  auditOpsApproveAllowedPath,
} = require("../dist/services/audiobook/ops/OpsReport");

function clearEnv() {
  delete process.env.VOICE_LIBRARY_APPROVE_TOKEN;
  delete process.env.AUDIOBOOK_OPS_ALLOW_OPEN_APPROVE;
}

describe("opsApproveGate (§D)", () => {
  beforeEach(clearEnv);
  afterEach(clearEnv);

  it("无 token + 无 allow_open → 抛 403 + 提示两种放行路径", () => {
    assert.throws(
      () => assertOpsApproveAllowed(),
      (err) => {
        assert.equal(err.statusCode, 403);
        assert.ok(/VOICE_LIBRARY_APPROVE_TOKEN/.test(err.message), err.message);
        assert.ok(/AUDIOBOOK_OPS_ALLOW_OPEN_APPROVE/.test(err.message), err.message);
        return true;
      },
    );
  });

  it("仅 token 在场（生产路径）→ 通过；audit via=token", () => {
    process.env.VOICE_LIBRARY_APPROVE_TOKEN = "sk-test-token-xxx";
    assert.doesNotThrow(() => assertOpsApproveAllowed());
    assert.equal(auditOpsApproveAllowedPath().via, "token");
  });

  it("仅 allow_open=1（dev 路径）→ 通过；audit via=allow_open", () => {
    process.env.AUDIOBOOK_OPS_ALLOW_OPEN_APPROVE = "1";
    assert.doesNotThrow(() => assertOpsApproveAllowed());
    assert.equal(auditOpsApproveAllowedPath().via, "allow_open");
  });

  it("token + allow_open 同时配置 → 优先 audit via=token（生产行为）", () => {
    process.env.VOICE_LIBRARY_APPROVE_TOKEN = "sk-test-token-xxx";
    process.env.AUDIOBOOK_OPS_ALLOW_OPEN_APPROVE = "1";
    assert.doesNotThrow(() => assertOpsApproveAllowed());
    assert.equal(auditOpsApproveAllowedPath().via, "token");
  });

  it("allow_open 非 1（如 yes/true/0）→ 不放行", () => {
    process.env.AUDIOBOOK_OPS_ALLOW_OPEN_APPROVE = "true";
    assert.throws(
      () => assertOpsApproveAllowed(),
      (err) => err.statusCode === 403,
    );
  });

  it("token 空字符串不被当作在场", () => {
    process.env.VOICE_LIBRARY_APPROVE_TOKEN = "   ";
    assert.throws(
      () => assertOpsApproveAllowed(),
      (err) => err.statusCode === 403,
    );
  });
});
