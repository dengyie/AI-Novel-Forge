import test from "node:test";
import assert from "node:assert/strict";
import { parseReadinessJobActiveError } from "../src/api/novel/parseReadinessJobActiveError.ts";

test("parseReadinessJobActiveError: ApiHttpError status+details.data (route D17 shape)", () => {
  const error = Object.assign(new Error("busy"), {
    status: 409,
    details: {
      success: false,
      error: "该小说已有进行中的音色就绪任务，请等待或取消后再试。",
      data: {
        code: "READINESS_JOB_ACTIVE",
        activeJobId: "job-abc",
      },
    },
  });
  assert.deepEqual(parseReadinessJobActiveError(error), {
    code: "READINESS_JOB_ACTIVE",
    activeJobId: "job-abc",
  });
});

test("parseReadinessJobActiveError: details object without nesting (AppError fallback)", () => {
  const error = Object.assign(new Error("busy"), {
    status: 409,
    details: {
      code: "READINESS_JOB_ACTIVE",
      activeJobId: "job-direct",
    },
  });
  assert.deepEqual(parseReadinessJobActiveError(error), {
    code: "READINESS_JOB_ACTIVE",
    activeJobId: "job-direct",
  });
});

test("parseReadinessJobActiveError: legacy axios-like response still works", () => {
  assert.deepEqual(
    parseReadinessJobActiveError({
      response: {
        status: 409,
        data: {
          data: { code: "READINESS_JOB_ACTIVE", activeJobId: "legacy" },
        },
      },
    }),
    {
      code: "READINESS_JOB_ACTIVE",
      activeJobId: "legacy",
    },
  );
});

test("parseReadinessJobActiveError: ignores non-409 / garbage", () => {
  assert.equal(parseReadinessJobActiveError({ status: 500, details: {} }), null);
  assert.equal(parseReadinessJobActiveError(new Error("x")), null);
  assert.equal(parseReadinessJobActiveError(null), null);
});
