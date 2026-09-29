const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const http = require('node:http');
const { comicCharacterAssetService } = require('../dist/services/comic/ComicCharacterAssetService');
const { comicSceneService } = require('../dist/services/comic/ComicSceneService');
const router = require('../dist/modules/comic/http/comicRoutes').default;
const { errorHandler } = require('../dist/middleware/errorHandler');

for (const [route, service, method] of [
  ['/character-assets/asset/upload-image', comicCharacterAssetService, 'uploadAssetImage'],
  ['/scenes/scene/upload-image', comicSceneService, 'uploadSceneImage'],
]) {
  test(`${route} bounds raw and chunked bodies before service writes`, async t => {
    let calls = 0;
    const previous = service[method];
    service[method] = async (_id, buffer) => { calls++; return { size: buffer.length }; };
    t.after(() => { service[method] = previous; });
    const app = express(); app.use(express.json({ limit: '2mb' })); app.use(router); app.use(errorHandler);
    const server = app.listen(0, '127.0.0.1');
    await new Promise(resolve => server.once('listening', resolve));
    t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
    const url = `http://127.0.0.1:${server.address().port}${route}`;
    const normal = await fetch(url, { method: 'POST', headers: {'content-type':'image/png'}, body: Buffer.from('image bytes') });
    assert.equal(normal.status, 200); await normal.arrayBuffer();
    const huge = await fetch(url, { method: 'POST', headers: {'content-type':'image/png'}, body: Buffer.alloc(10 * 1024 * 1024 + 1) });
    assert.equal(huge.status, 413); await huge.arrayBuffer();
    const chunked = await new Promise((resolve, reject) => {
      const request = http.request(url, { method:'POST', headers:{'content-type':'image/png'} }, response => {
        response.resume(); response.once('end', () => resolve(response.statusCode));
      });
      request.on('error', reject);
      for (let i=0;i<11;i++) request.write(Buffer.alloc(1024 * 1024));
      request.end();
    });
    assert.equal(chunked, 413);
    const wrongType = await fetch(url, { method:'POST', headers:{'content-type':'text/plain'}, body:'not image' });
    assert.equal(wrongType.status, 415); await wrongType.arrayBuffer();
    const empty = await fetch(url, { method:'POST', headers:{'content-type':'image/png'}, body:Buffer.alloc(0) });
    assert.equal(empty.status, 400); await empty.arrayBuffer();
    assert.equal(calls, 1);
  });
}
