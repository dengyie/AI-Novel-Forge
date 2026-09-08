/**
 * P1-7 TTS 上游 503 burst 指数退避 + 熔断 纯逻辑单测。
 *
 * 测 computeTtsUpstreamBackoffMs（曲线）、TtsUpstreamCircuitBreaker（计数/熔断打开）、
 * isTtsUpstreamStatus。不 mock fetch——provider.synthesize 的真实 HTTP 走 Manual-required。
 */
const test = require("node:test");
const assert = require("node:assert/strict");

const {
  computeTtsUpstreamBackoffMs,
  TtsUpstreamCircuitBreaker,
  isTtsUpstreamStatus,
  TTS_UPSTREAM_CIRCUIT_BROKEN_MSG,
  TTS_BURST_BACKOFF_BASE_MS,
  TTS_BURST_BACKOFF_CAP_MS,
} = require("../dist/services/audiobook/MimoChatAudioTTSProvider.js");

// ── backoff curve ──

test("computeTtsUpstreamBackoffMs: 曲线 min(5000, 2^n × 400)", () => {
  const base = 400;
  const caps = [];
  for (let n = 0; n < 8; n += 1) {
    caps.push(computeTtsUpstreamBackoffMs({ burstCount: n, baseMs: base, capMs: 5000 }));
  }
  // n=0: 2^0×400=400; n=1: 800; n=2: 1600; n=3: 3200; n=4: 6400→cap 5000
  assert.deepEqual(caps.slice(0, 5), [400, 800, 1600, 3200, 5000]);
  for (let n = 5; n < 8; n += 1) {
    assert.equal(caps[n], 5000, "curve should cap at 5000 after n=4");
  }
});

test("computeTtsUpstreamBackoffMs: 显式 capMs 覆盖默认 5000", () => {
  assert.equal(computeTtsUpstreamBackoffMs({ burstCount: 10, baseMs: 400, capMs: 6000 }), 6000);
});

test("computeTtsUpstreamBackoffMs: 负/小 burstCount 归一", () => {
  assert.equal(computeTtsUpstreamBackoffMs({ burstCount: -1, baseMs: 400, capMs: 5000 }), 400);
  assert.equal(computeTtsUpstreamBackoffMs({ burstCount: 0, baseMs: 400, capMs: 5000 }), 400);
});

test("computeTtsUpstreamBackoffMs: env 默认常量 <= 5000 且 >= 400", () => {
  assert.ok(TTS_BURST_BACKOFF_CAP_MS <= 5000, `cap=${TTS_BURST_BACKOFF_CAP_MS} should <= 5000`);
  assert.ok(TTS_BURST_BACKOFF_BASE_MS >= 400, `base=${TTS_BURST_BACKOFF_BASE_MS} should >= 400`);
});

// ── isTtsUpstreamStatus ──

test("isTtsUpstreamStatus: 503/429 识别", () => {
  assert.equal(isTtsUpstreamStatus(503), true);
  assert.equal(isTtsUpstreamStatus(429), true);
  assert.equal(isTtsUpstreamStatus(500), false);
  assert.equal(isTtsUpstreamStatus(504), false);
  assert.equal(isTtsUpstreamStatus(502), false);
});

// ── TtsUpstreamCircuitBreaker ──

test("TtsUpstreamCircuitBreaker: 初始不开、burstCount=0", () => {
  const cb = new TtsUpstreamCircuitBreaker({ maxBurstFailures: 3, cooldownMs: 30_000 });
  assert.equal(cb.isOpen, false);
  assert.equal(cb.burstCount, 0);
});

test("TtsUpstreamCircuitBreaker: 连续 <threshold 不熔断", () => {
  const cb = new TtsUpstreamCircuitBreaker({ maxBurstFailures: 3, cooldownMs: 30_000 });
  assert.equal(cb.recordUpstreamFailure(), false);
  assert.equal(cb.recordUpstreamFailure(), false);
  assert.equal(cb.burstCount, 2);
  assert.equal(cb.isOpen, false);
});

test("TtsUpstreamCircuitBreaker: 连续 =threshold 熔断并返回 true", () => {
  const cb = new TtsUpstreamCircuitBreaker({ maxBurstFailures: 3, cooldownMs: 30_000 });
  cb.recordUpstreamFailure();
  cb.recordUpstreamFailure();
  assert.equal(cb.recordUpstreamFailure(), true);
  assert.equal(cb.isOpen, true);
  assert.equal(cb.burstCount, 3);
});

test("TtsUpstreamCircuitBreaker: recordSuccess 清空计数并关断", () => {
  const cb = new TtsUpstreamCircuitBreaker({ maxBurstFailures: 3, cooldownMs: 30_000 });
  cb.recordUpstreamFailure();
  cb.recordUpstreamFailure();
  cb.recordSuccess();
  assert.equal(cb.burstCount, 0);
  assert.equal(cb.isOpen, false);
});

test("TtsUpstreamCircuitBreaker: cooldown 过期后转 half-open（isOpen=false）", () => {
  const cb = new TtsUpstreamCircuitBreaker({
    maxBurstFailures: 1,
    cooldownMs: 600_000,
  });
  cb.recordUpstreamFailure();
  assert.equal(cb.isOpen, true);
  // 构造函数对 cooldown 有 1s 下限（Math.max(1_000, ...)），
  // 传 min 值也得等满 1s 才能回落 half-open。
  const cb2 = new TtsUpstreamCircuitBreaker({ maxBurstFailures: 1, cooldownMs: 1_000 });
  cb2.recordUpstreamFailure();
  assert.equal(cb2.isOpen, true);
  // openUntilMs = 记录时刻 + 1000ms；等 1400ms 让 cooldown 一定过期，
  // isOpen 应从 true 回落为 false（half-open 允许单发探活）。
  return new Promise((resolvePromise) => {
    setTimeout(() => {
      assert.equal(cb2.isOpen, false);
      resolvePromise();
    }, 1_400);
  });
});

test("TTS_UPSTREAM_CIRCUIT_BROKEN_MSG 语义文案", () => {
  assert.equal(TTS_UPSTREAM_CIRCUIT_BROKEN_MSG, "TTS upstream failed, circuit broken");
});