const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const { M4bWorkerManager } = require('../dist/services/audiobook/m4b/M4bWorkerManager.js');
const { M4bJobQueueService } = require('../dist/services/audiobook/m4b/M4bJobQueueService.js');
const { prisma } = require('../dist/db/prisma.js');

test('pending queue launches existing worker entry', async () => {
  const childProcess = require('node:child_process');
  const original = childProcess.spawn;
  let command;
  const EventEmitter = require('node:events');
  childProcess.spawn = (executable, args) => {
    command = { executable, args };
    assert.ok(fs.existsSync(args.at(-1)), 'compiled worker entry must exist');
    const child = new EventEmitter(); child.pid = 999999;
    child.kill = () => { child.emit('exit', 0, null); return true; };
    queueMicrotask(() => child.emit("spawn"));
    return child;
  };
  const manager = new M4bWorkerManager();
  manager.queueService = { hasPendingJobs: async () => true, recoverJobsForWorker: async () => ({requeued:0,failed:0}) };
  try {
    await manager.ensureWorkerForPendingJobs();
    assert.ok(command, 'pending jobs must launch worker');
    assert.equal(command.executable, process.execPath);
  } finally {
    manager.shuttingDown = true;
    for (const worker of manager.activeWorkers.values()) worker.kill();
    await manager.shutdown();
    childProcess.spawn = original;
  }
});

test('stall detection uses latest audio growth, not claim time', async () => {
  const original = prisma.m4bEncodingJob.findMany;
  let query;
  prisma.m4bEncodingJob.findMany = async (input) => { query=input;return []; };
  try {
    await new M4bJobQueueService().getStalledJobs(120000);
    assert.ok(query.where.lastProgressAt, 'growth timestamp determines stall');
    assert.equal(query.where.workerStartedAt, undefined);
  } finally { prisma.m4bEncodingJob.findMany = original; }
});

test('disabled worker mode never starts recovery scans or pending workers', async () => {
  const previous=process.env.AUDIOBOOK_M4B_USE_WORKER;
  process.env.AUDIOBOOK_M4B_USE_WORKER='false';
  const manager=new M4bWorkerManager();
  manager.queueService={getStalledJobs:async()=>assert.fail('disabled scan'),hasPendingJobs:async()=>assert.fail('disabled dispatch')};
  try { await manager.start();await manager.ensureWorkerForPendingJobs();assert.equal(manager.watchdogTimer,null); }
  finally {await manager.shutdown();if(previous===undefined)delete process.env.AUDIOBOOK_M4B_USE_WORKER;else process.env.AUDIOBOOK_M4B_USE_WORKER=previous;}
});
