const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const childProcess = require('node:child_process');
const { M4bWorkerManager } = require('../dist/services/audiobook/m4b/M4bWorkerManager.js');

function deferred() { let resolve; const promise=new Promise(r=>resolve=r);return {promise,resolve}; }
function mockWorker(t, autoSpawn = false) {
  const original=childProcess.spawn; let calls=0; let child;
  childProcess.spawn=()=>{
    calls++;child=new EventEmitter();child.pid=999999;child.exitCode=null;child.signalCode=null;
    child.kill=signal=>{child.signalCode=signal;child.emit('exit',null,signal);return true;};
    if(autoSpawn)queueMicrotask(()=>child.emit('spawn'));
    return child;
  };
  t.after(()=>childProcess.spawn=original);
  return { get calls(){return calls;},get child(){return child;} };
}
function queue(hasPendingJobs) {
  return {hasPendingJobs,recoverJobsForWorker:async()=>({requeued:0,failed:0})};
}

test('shutdown fences an already awaited pending-job query', async t=>{
  const pending=deferred();const entered=deferred();const spawned=mockWorker(t,true);
  const manager=new M4bWorkerManager();manager.queueService=queue(()=>{entered.resolve();return pending.promise;});
  const starting=manager.ensureWorkerForPendingJobs();
  await entered.promise;await manager.shutdown();pending.resolve(true);await starting;
  try {
    assert.equal(spawned.calls,0,'a query completed after shutdown must not create a child');
    assert.equal(manager.watchdogTimer,null);
  } finally {await manager.shutdown();}
});

test('shutdown owns a registered child while spawn notification is pending', async t=>{
  const spawned=mockWorker(t);const manager=new M4bWorkerManager();manager.queueService=queue(async()=>true);
  const starting=manager.ensureWorkerForPendingJobs();
  await Promise.resolve();assert.equal(spawned.calls,1);
  await manager.shutdown();spawned.child.emit('spawn');await starting;
  try {
    assert.equal(manager.activeWorkers.size,0);
    assert.equal(manager.watchdogTimer,null,'late spawn notification must not restart watchdog');
  } finally {await manager.shutdown();}
});

test('child exit before spawn notification settles an in-flight start on shutdown', async t=>{
  const spawned=mockWorker(t);const manager=new M4bWorkerManager();manager.queueService=queue(async()=>true);
  const starting=manager.ensureWorkerForPendingJobs();
  await Promise.resolve();assert.equal(spawned.calls,1);await manager.shutdown();
  let settled=false;void starting.then(()=>settled=true);
  // Allow the exit-handler and promise continuation chain to drain without wall-clock sleeps.
  await new Promise(resolve=>setImmediate(resolve));
  try {assert.equal(settled,true,'shutdown must settle a start even without a spawn event');}
  finally {spawned.child.emit('spawn');await starting;await manager.shutdown();}
});
