const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { EventEmitter } = require('node:events');
const { waitForServerHealth, stopOwnedServerProcess, createServerQuitHandler } = require('../dist/runtime/serverLifecycle');

test('health deadline aborts a real HTTP request that never responds', async () => {
  const server = http.createServer(() => {});
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const start = Date.now();
  try {
    await assert.rejects(waitForServerHealth(server.address().port, 60), /Timed out/);
    assert.ok(Date.now() - start < 1000);
  } finally { server.closeAllConnections(); await new Promise(r => server.close(r)); }
});
test('health probe observes process exit while HTTP is pending', async () => {
  const server = http.createServer(() => {});
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  let exited = false;
  const timer = setTimeout(() => { exited = true; }, 30);
  try { await assert.rejects(waitForServerHealth(server.address().port, 3000, () => exited), /exited before/); }
  finally { clearTimeout(timer); server.closeAllConnections(); await new Promise(r => server.close(r)); }
});
test('before-quit blocks repeated quit until server exit and then permits reentry', async () => {
  let release;
  const stopped = new Promise(r => { release = r; });
  let calls = 0, quits = 0, prevented = 0;
  const handler = createServerQuitHandler(async () => { calls++; await stopped; }, () => quits++, error => { throw error; });
  const event = { preventDefault() { prevented++; } };
  handler(event); handler(event);
  await new Promise(r => setImmediate(r));
  assert.equal(quits, 0); assert.equal(calls, 1); assert.equal(prevented, 2);
  release(); await new Promise(r => setImmediate(r));
  assert.equal(quits, 1);
  handler(event); assert.equal(prevented, 2);
});
test('server stop waits for actual exit and escalates an unresponsive child', async () => {
  const child = new EventEmitter();
  let terminated = 0, forced = 0;
  await stopOwnedServerProcess({ events: child, hasExited: () => false,
    terminate: () => { terminated++; }, forceKill: () => { forced++; child.emit('exit'); }, graceMs: 5 });
  assert.equal(terminated, 1); assert.equal(forced, 1); assert.equal(child.listenerCount('exit'), 0);
});
test('shutdown failure does not quit and permits retry', async () => {
  let errors = 0, quits = 0, attempts = 0;
  const handler = createServerQuitHandler(async () => { if (++attempts === 1) throw Error('failure'); }, () => quits++, () => errors++);
  handler({ preventDefault() {} }); await new Promise(r => setImmediate(r));
  assert.equal(errors, 1); assert.equal(quits, 0);
  handler({ preventDefault() {} }); await new Promise(r => setImmediate(r)); assert.equal(quits, 1);
});

test('owned Node child receives graceful parent IPC and exits before stop resolves', async () => {
  const { spawn } = require('node:child_process');
  const child = spawn(process.execPath, ['-e', `process.on('message', message => { if (message.type === 'ai-novel:shutdown') setTimeout(() => process.exit(0), 20); }); process.send('ready');`], { stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
  try {
    await new Promise((resolve, reject) => { child.once('message', resolve); child.once('error', reject); });
    await stopOwnedServerProcess({ events: child, hasExited: () => child.exitCode !== null,
      terminate: () => child.send({ type: 'ai-novel:shutdown' }),
      forceKill: () => { child.kill('SIGKILL'); assert.fail('responsive child must not be force killed'); } });
    assert.equal(child.exitCode, 0);
  } finally { if (child.exitCode === null) child.kill('SIGKILL'); }
});
