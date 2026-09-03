const test = require("node:test");
const assert = require("node:assert/strict");
const express = require("express");
const http = require("node:http");

const { prisma } = require("../dist/db/prisma.js");
const { startServer } = require("../dist/app.js");
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
