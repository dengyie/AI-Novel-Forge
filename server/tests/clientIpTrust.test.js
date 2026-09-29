const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const { createRateLimitMiddleware } = require('../dist/middleware/rateLimit');
const { resolveClientIp } = require('../dist/http/clientIp');

async function withServer(trust, run) {
  const app = express();
  app.set('trust proxy', trust);
  app.use(createRateLimitMiddleware({ limit: 1, windowMs: 60000 }));
  app.get('/', (req, res) => res.json({ ip: resolveClientIp(req) }));
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  try { await run(`http://127.0.0.1:${server.address().port}`); }
  finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
}

test('untrusted peer cannot reset quota by changing forwarded headers', async () => {
  await withServer(false, async url => {
    const first = await fetch(url, { headers: { 'x-forwarded-for': '198.51.100.1' } });
    assert.equal(first.status, 200);
    assert.equal((await first.json()).ip, '127.0.0.1');
    const second = await fetch(url, { headers: { 'x-forwarded-for': '198.51.100.2' } });
    assert.equal(second.status, 429);
  });
});
test('explicit trusted proxy uses nearest untrusted address and ignores forged prefix', async () => {
  await withServer('loopback', async url => {
    const first = await fetch(url, { headers: { 'x-forwarded-for': '192.0.2.1, 198.51.100.3' } });
    assert.equal((await first.json()).ip, '198.51.100.3');
    const second = await fetch(url, { headers: { 'x-forwarded-for': '192.0.2.2, 198.51.100.3' } });
    assert.equal(second.status, 429);
  });
});
test('proxy outside allowlist cannot supply client identity', async () => {
  await withServer('10.0.0.0/8', async url => {
    const result = await fetch(url, { headers: { 'x-forwarded-for': '198.51.100.4' } });
    assert.equal((await result.json()).ip, '127.0.0.1');
  });
});
