const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");

function loadAuth() {
  const modulePath = path.join(__dirname, "../dist/middleware/auth.js");
  delete require.cache[modulePath];
  return require(modulePath);
}

function withEnv(overrides, run) {
  const previous = {};
  for (const key of Object.keys(overrides)) {
    previous[key] = process.env[key];
    if (overrides[key] === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = overrides[key];
    }
  }
  return Promise.resolve()
    .then(run)
    .finally(() => {
      for (const key of Object.keys(overrides)) {
        if (previous[key] === undefined) {
          delete process.env[key];
        } else {
          process.env[key] = previous[key];
        }
      }
    });
}

function mockRes() {
  const res = {
    statusCode: 200,
    body: null,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(payload) {
      this.body = payload;
      return this;
    },
  };
  return res;
}

test("auth open mode passes without token", async () => {
  await withEnv({ API_AUTH_TOKEN: undefined, AUTH_MODE: undefined }, async () => {
    const { authMiddleware, resolveAuthMode } = loadAuth();
    assert.equal(resolveAuthMode(), "open");
    let nextCalled = false;
    const res = mockRes();
    authMiddleware(
      { originalUrl: "/api/novels", header: () => undefined },
      res,
      () => {
        nextCalled = true;
      },
    );
    assert.equal(nextCalled, true);
    assert.equal(res.statusCode, 200);
  });
});

test("auth token mode rejects missing credential", async () => {
  await withEnv({ API_AUTH_TOKEN: "secret-token", AUTH_MODE: undefined }, async () => {
    const { authMiddleware, resolveAuthMode } = loadAuth();
    assert.equal(resolveAuthMode(), "token");
    let nextCalled = false;
    const res = mockRes();
    authMiddleware(
      {
        originalUrl: "/api/novels",
        header: () => undefined,
      },
      res,
      () => {
        nextCalled = true;
      },
    );
    assert.equal(nextCalled, false);
    assert.equal(res.statusCode, 401);
  });
});

test("auth token mode accepts bearer token", async () => {
  await withEnv({ API_AUTH_TOKEN: "secret-token" }, async () => {
    const { authMiddleware } = loadAuth();
    let nextCalled = false;
    const res = mockRes();
    authMiddleware(
      {
        originalUrl: "/api/novels",
        header: (name) => (name === "authorization" ? "Bearer secret-token" : undefined),
      },
      res,
      () => {
        nextCalled = true;
      },
    );
    assert.equal(nextCalled, true);
  });
});

test("auth token mode accepts X-API-Token", async () => {
  await withEnv({ API_AUTH_TOKEN: "secret-token" }, async () => {
    const { authMiddleware } = loadAuth();
    let nextCalled = false;
    authMiddleware(
      {
        originalUrl: "/api/settings",
        header: (name) => (name === "x-api-token" ? "secret-token" : undefined),
      },
      mockRes(),
      () => {
        nextCalled = true;
      },
    );
    assert.equal(nextCalled, true);
  });
});

test("health liveness is exempt from token auth", async () => {
  await withEnv({ API_AUTH_TOKEN: "secret-token" }, async () => {
    const { authMiddleware } = loadAuth();
    let nextCalled = false;
    authMiddleware(
      {
        originalUrl: "/api/health",
        header: () => undefined,
      },
      mockRes(),
      () => {
        nextCalled = true;
      },
    );
    assert.equal(nextCalled, true);
  });
});

test("production public bind without token is refused", async () => {
  await withEnv({
    NODE_ENV: "production",
    API_AUTH_TOKEN: undefined,
    AUTH_ALLOW_OPEN: undefined,
  }, async () => {
    const { assertProductionAuthSafety } = loadAuth();
    assert.throws(
      () => assertProductionAuthSafety({ host: "0.0.0.0", allowLan: true }),
      /API_AUTH_TOKEN/,
    );
  });
});

test("production localhost open auth is allowed", async () => {
  await withEnv({
    NODE_ENV: "production",
    API_AUTH_TOKEN: undefined,
    AUTH_ALLOW_OPEN: undefined,
  }, async () => {
    const { assertProductionAuthSafety } = loadAuth();
    assert.doesNotThrow(() => assertProductionAuthSafety({ host: "127.0.0.1", allowLan: false }));
  });
});

test("AUTH_ALLOW_OPEN overrides production public bind refuse", async () => {
  await withEnv({
    NODE_ENV: "production",
    API_AUTH_TOKEN: undefined,
    AUTH_ALLOW_OPEN: "true",
  }, async () => {
    const { assertProductionAuthSafety } = loadAuth();
    assert.doesNotThrow(() => assertProductionAuthSafety({ host: "0.0.0.0", allowLan: true }));
  });
});
