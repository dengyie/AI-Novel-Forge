const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const { EventEmitter } = require('node:events');

for (const packaged of [false, true]) {
  test(`actual managed handle retries a failed shutdown (packaged=${packaged})`, async () => {
    const child = Object.assign(new EventEmitter(), { pid: 123, stdout: null, stderr: null, exitCode: null, signalCode: null, connected: true });
    let requests = 0;
    const send = () => {
      if (++requests === 1) throw new Error('IPC temporarily unavailable');
      child.exitCode = 0;
      child.emit('exit', 0);
    };
    child.send = send;
    child.postMessage = send;
    child.kill = () => { throw new Error('unexpected force kill'); };
    const file = path.resolve(__dirname, '../dist/runtime/server.js');
    const realRequire = createRequire(file);
    const exports = {};
    vm.runInNewContext(fs.readFileSync(file, 'utf8') + '\nexports.startOwned = ' + (packaged ? 'startPackagedManagedServer' : 'startWorkspaceManagedServer') + ';', {
      exports, process,
      require: name => name === 'node:child_process' ? { spawn: () => child }
        : name === 'electron' ? { utilityProcess: { fork: () => child } }
        : name === './logging' ? { appendDesktopLog() {}, logDesktopError() {} }
        : name === './paths' ? { resolveDesktopAppDataDir: () => '/synthetic', resolveWorkspaceRoot: () => '/synthetic', resolveDesktopResourcesDir: () => '/synthetic', resolvePackagedServerEntry: () => '/synthetic/app.js' }
        : realRequire(name),
    });
    const handle = exports.startOwned(34567);
    const firstStop = handle.stop();
    assert.equal(handle.stop(), firstStop, "concurrent stop callers share the current attempt");
    await assert.rejects(firstStop, /IPC temporarily unavailable/);
    await handle.stop();
    assert.equal(requests, 2);
    assert.equal(handle.hasExited(), true);
    await handle.stop();
    assert.equal(requests, 2, 'completed shutdown remains idempotent');
  });
}
