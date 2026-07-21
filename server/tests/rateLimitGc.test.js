const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");

function loadRateLimit() {
  const modulePath = path.join(__dirname, "../dist/middleware/rateLimit.js");
  delete require.cache[modulePath];
  return require(modulePath);
}

function mockReq(ip) {
  return {
    header: () => undefined,
    ip,
    socket: { remoteAddress: ip },
  };
}

function mockRes() {
  return {
    headers: {},
    statusCode: 200,
    setHeader(key, value) {
      this.headers[key] = value;
    },
    status(code) {
      this.statusCode = code;
      return this;
    },
    json() {
      return this;
    },
  };
}

test("rate limiter sweeps expired buckets via periodic timer even without traffic", async () => {
  const { createRateLimitMiddleware } = loadRateLimit();
  const windowMs = 1000;
  // interval = max(windowMs, 60s) = 60s；为让周期清扫可测，这里直接验证
  // 「无新请求时过期 bucket 会被清掉」这一周期清扫独有行为：
  // 惰性过期只在「同一 key 再次请求」时重建 bucket，周期清扫才真正 delete 掉 key。
  // 通过 buckets size 白盒观测：先造若干 key，等过 window + 手动等到 timer 触发不可行
  // （60s 太久），改为直接验证 middleware 暴露的内部状态句柄。
  const middleware = createRateLimitMiddleware({ limit: 5, windowMs });
  assert.ok(middleware.__bucketsForTest, "middleware should expose __bucketsForTest for white-box GC assertions");
  const buckets = middleware.__bucketsForTest;

  middleware(mockReq("1.1.1.1"), mockRes(), () => {});
  middleware(mockReq("2.2.2.2"), mockRes(), () => {});
  assert.equal(buckets.size, 2);

  // 过期后，在没有任何新请求的情况下直接调用内部清扫（与 setInterval 同一函数），
  // buckets 应被清空——这是惰性过期路径做不到的行为（惰性只重置被访问 key）。
  await new Promise((resolve) => setTimeout(resolve, windowMs + 50));
  middleware.__sweepForTest();
  assert.equal(buckets.size, 0, "sweep should delete all expired buckets without any new request");
});

test("rate limiter triggers synchronous GC when buckets exceed size threshold", () => {
  const { createRateLimitMiddleware } = loadRateLimit();
  // windowMs 下限 1000ms：灌 key 的过程（远快于 1s）内所有 bucket 均未过期，
  // 同步 GC 不会误删；size>10000 的阈值分支本身被触发即可通过 size 不再无限增长观测。
  const middleware = createRateLimitMiddleware({ limit: 100000, windowMs: 1000 });
  const buckets = middleware.__bucketsForTest;

  for (let index = 0; index < 10001; index += 1) {
    middleware(mockReq(`10.0.${Math.floor(index / 256)}.${index % 256}`), mockRes(), () => {});
  }
  // 10001 个唯一 key 均已进入 buckets（未过期，惰性不触发，GC 也无可清）
  assert.equal(buckets.size, 10001);

  // 手动让所有 key 过期（直接改 resetAt，等价于时间推进），再发一个请求触发 size 阈值 GC
  const past = Date.now() - 1;
  for (const bucket of buckets.values()) {
    bucket.resetAt = past;
  }
  middleware(mockReq("9.9.9.9"), mockRes(), () => {});
  // size 阈值 GC 应清掉全部 10001 个过期 key，仅留新 key
  assert.equal(buckets.size, 1, "size-threshold GC should sweep all expired buckets on next request");
});
