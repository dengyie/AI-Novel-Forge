const test = require("node:test");
const assert = require("node:assert/strict");
const express = require("express");
const http = require("node:http");

const { prisma } = require("../dist/db/prisma.js");
const { createApp, startServer } = require("../dist/app.js");
const { recoveryTaskService } = require("../dist/services/task/RecoveryTaskService.js");
const {
  healthRouter,
  setServerReadiness,
} = require("../dist/routes/health.js");

function listen(app) {
  return new Promise((resolve, reject) => {
    const server = app.listen(0, "127.0.0.1", () => resolve(server));
    server.once("error", reject);
  });
}

function requestReady(server) {
  return new Promise((resolve, reject) => {
    const address = server.address();
    const req = http.get({ host: address.address, port: address.port, path: "/ready" }, (res) => {
      let body = "";
      res.setEncoding("utf8");
      res.on("data", (chunk) => { body += chunk; });
      res.on("end", () => resolve({ statusCode: res.statusCode, body: JSON.parse(body) }));
    });
    req.once("error", reject);
  });
}

function requestPath(server, path) {
  return new Promise((resolve, reject) => {
    const address = server.address();
    const req = http.get({ host: address.address, port: address.port, path }, (res) => {
      let body = "";
      res.setEncoding("utf8");
      res.on("data", (chunk) => { body += chunk; });
      res.on("end", () => resolve({
        statusCode: res.statusCode,
        retryAfter: res.headers["retry-after"],
        body: JSON.parse(body),
      }));
    });
    req.once("error", reject);
  });
}

function requestRaw(server, input) {
  return new Promise((resolve, reject) => {
    const address = server.address();
    const req = http.request({
      host: address.address,
      port: address.port,
      path: input.path,
      method: input.method ?? "GET",
      headers: input.headers,
    }, (res) => {
      let body = "";
      res.setEncoding("utf8");
      res.on("data", (chunk) => { body += chunk; });
      res.on("end", () => resolve({
        statusCode: res.statusCode,
        retryAfter: res.headers["retry-after"],
        body: body ? JSON.parse(body) : null,
      }));
    });
    req.once("error", reject);
    if (input.body) req.write(input.body);
    req.end();
  });
}

test("health readiness remains non-ready until startup recovery is ready", async () => {
  const originalQueryRaw = prisma.$queryRaw;
  prisma.$queryRaw = async () => [];
  const app = express();
  app.use(healthRouter);
  const server = await listen(app);
  try {
    setServerReadiness("starting");
    assert.equal((await requestReady(server)).statusCode, 503);

    setServerReadiness("degraded", ["pipeline"]);
    const degraded = await requestReady(server);
    assert.equal(degraded.statusCode, 503);
    assert.equal(degraded.body.data.status, "degraded");

    setServerReadiness("ready");
    const ready = await requestReady(server);
    assert.equal(ready.statusCode, 200);
    assert.equal(ready.body.data.status, "ready");
  } finally {
    setServerReadiness("starting");
    prisma.$queryRaw = originalQueryRaw;
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});

test("production app rejects ordinary API traffic until startup recovery is ready", async () => {
  const app = createApp({ enforceStartupReadiness: true });
  const server = await listen(app);
  try {
    setServerReadiness("starting");
    const liveness = await requestPath(server, "/api/health");
    assert.equal(liveness.statusCode, 200, "liveness must stay reachable during recovery");

    const starting = await requestPath(server, "/api/__startup_probe__");
    assert.equal(starting.statusCode, 503);
    assert.equal(starting.retryAfter, "5");
    assert.equal(starting.body.data.status, "starting");

    setServerReadiness("degraded", ["novel_audiobook"]);
    const degraded = await requestPath(server, "/api/__startup_probe__");
    assert.equal(degraded.statusCode, 503);
    assert.deepEqual(degraded.body.data.failedRecoveryDomains, ["novel_audiobook"]);

    setServerReadiness("ready");
    const ready = await requestPath(server, "/api/__startup_probe__");
    assert.equal(ready.statusCode, 404, "the gate must release normal routing once ready");
  } finally {
    setServerReadiness("starting");
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});

test("startup gate rejects malformed JSON before allocating the API body parser", async () => {
  const app = createApp({ enforceStartupReadiness: true });
  const server = await listen(app);
  try {
    setServerReadiness("starting");
    const response = await requestRaw(server, {
      path: "/api/settings",
      method: "POST",
      headers: {
        "content-type": "application/json",
        "content-length": "1",
      },
      body: "{",
    });

    assert.equal(response.statusCode, 503);
    assert.equal(response.retryAfter, "5");
    assert.equal(response.body.data.status, "starting");
  } finally {
    setServerReadiness("starting");
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});

test("ready API classifies malformed JSON as a client error", async () => {
  const app = createApp({ enforceStartupReadiness: true });
  const server = await listen(app);
  try {
    setServerReadiness("ready");
    const response = await requestRaw(server, {
      path: "/api/settings",
      method: "POST",
      headers: {
        "content-type": "application/json",
        "content-length": "1",
      },
      body: "{",
    });

    assert.equal(response.statusCode, 400);
    assert.equal(response.body.error, "请求体 JSON 格式错误，请检查后重试。");
  } finally {
    setServerReadiness("starting");
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});

test("startup-rejected traffic does not consume the post-recovery API rate-limit budget", async () => {
  const originalLimit = process.env.API_RATE_LIMIT_MAX;
  const originalWindow = process.env.API_RATE_LIMIT_WINDOW_MS;
  process.env.API_RATE_LIMIT_MAX = "1";
  process.env.API_RATE_LIMIT_WINDOW_MS = "60000";
  const app = createApp({ enforceStartupReadiness: true });
  const server = await listen(app);
  try {
    setServerReadiness("starting");
    assert.equal((await requestPath(server, "/api/__startup_rate_limit_probe__")).statusCode, 503);
    assert.equal((await requestPath(server, "/api/__startup_rate_limit_probe__")).statusCode, 503);

    setServerReadiness("ready");
    assert.equal(
      (await requestPath(server, "/api/__startup_rate_limit_probe__")).statusCode,
      404,
      "the first ready request must retain the full one-request budget",
    );
  } finally {
    if (originalLimit === undefined) delete process.env.API_RATE_LIMIT_MAX;
    else process.env.API_RATE_LIMIT_MAX = originalLimit;
    if (originalWindow === undefined) delete process.env.API_RATE_LIMIT_WINDOW_MS;
    else process.env.API_RATE_LIMIT_WINDOW_MS = originalWindow;
    setServerReadiness("starting");
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});

test("startup recovery failure closes the listener before rejecting startServer", async () => {
  const originalInitialize = recoveryTaskService.initializePendingRecoveries;
  const probe = await listen(express());
  const port = probe.address().port;
  await new Promise((resolve, reject) => probe.close((error) => error ? reject(error) : resolve()));

  recoveryTaskService.initializePendingRecoveries = async () => {
    throw new Error("synthetic startup recovery failure");
  };
  try {
    await assert.rejects(
      startServer({ host: "127.0.0.1", port, allowLan: false }),
      /synthetic startup recovery failure/,
    );
  } finally {
    recoveryTaskService.initializePendingRecoveries = originalInitialize;
  }

  const replacement = await listen(express());
  await new Promise((resolve, reject) => replacement.close((error) => error ? reject(error) : resolve()));
});
