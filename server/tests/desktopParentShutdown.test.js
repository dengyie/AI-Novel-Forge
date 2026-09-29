const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { registerDesktopParentShutdown } = require('../dist/app/desktopLifecycle');
for (const utility of [true, false]) {
  test(`desktop parent shutdown registration (utility=${utility})`, () => {
    const port = new EventEmitter();
    const proc = Object.assign(new EventEmitter(), { connected: !utility, parentPort: utility ? port : undefined });
    let stopped = 0;
    registerDesktopParentShutdown({ runtime: 'desktop', nodeProcess: proc, shutdown: () => stopped++ });
    const emit = message => (utility ? port : proc).emit('message', utility ? { data: message } : message);
    emit(null); emit({ type: 'unrelated' }); assert.equal(stopped, 0);
    emit({ type: 'ai-novel:shutdown' }); assert.equal(stopped, 1);
  });
}
test('ordinary web runtime never accepts shutdown messages', () => {
  const proc = Object.assign(new EventEmitter(), { connected: true });
  registerDesktopParentShutdown({ runtime: 'web', nodeProcess: proc, shutdown: () => assert.fail() });
  assert.equal(proc.listenerCount('message'), 0);
});
