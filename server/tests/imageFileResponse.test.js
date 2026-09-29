const test = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const path = require('node:path');

for (const kind of ['comic', 'drama']) {
  test(`${kind} file disappearing after resolution is a request error, not process crash`, () => {
    const result = spawnSync(process.execPath, ['-e', `
      const express = require('express');
      const app = express();
      const kind = ${JSON.stringify(kind)};
      let route;
      if (kind === 'comic') {
        require('./dist/services/comic/ComicSceneService').comicSceneService.serveSceneImage = async () => ({filePath:'/missing-review-fixture.png',mimeType:'image/png'});
        route = '/scenes/id/image';
      } else {
        require('./dist/services/drama/visual/DramaShotKeyframeService').dramaShotKeyframeService.resolveExistingKeyframePath = async () => ({filePath:'/missing-review-fixture.png',mimeType:'image/png'});
        route = '/shot-images/id/keyframe';
      }
      app.use(require('./dist/modules/'+kind+'/http/'+kind+'Routes').default);
      app.use((err, req, res, next) => res.status(404).end());
      const server = app.listen(0, '127.0.0.1', async () => {
        try {
          const response = await fetch('http://127.0.0.1:'+server.address().port+route);
          await response.arrayBuffer();
          if(response.status !== 404) throw Error('expected error response');
          server.closeAllConnections(); server.close(() => process.exit(0));
        } catch(err) { console.error(err); process.exit(1); }
      });
    `], { cwd:path.join(__dirname,'..'), encoding:'utf8', timeout:10000 });
    assert.equal(result.status, 0, result.stderr || String(result.error));
  });
}

for (const kind of ['comic', 'drama']) {
  test(`${kind} abort closes source file and complete download preserves bytes`, async t => {
    const fs = require('node:fs');
    const os = require('node:os');
    const http = require('node:http');
    const express = require('express');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ainovel-media-review-'));
    const filePath = path.join(dir, 'fixture.png');
    const data = Buffer.alloc(8 * 1024 * 1024, 42);
    fs.writeFileSync(filePath, data);
    t.after(() => fs.rmSync(dir, { recursive:true, force:true }));
    let service, method, route;
    if (kind === 'comic') {
      service = require('../dist/services/comic/ComicSceneService').comicSceneService;
      method = 'serveSceneImage'; route = '/scenes/id/image';
    } else {
      service = require('../dist/services/drama/visual/DramaShotKeyframeService').dramaShotKeyframeService;
      method = 'resolveExistingKeyframePath'; route = '/shot-images/id/keyframe';
    }
    const previous = service[method];
    service[method] = async () => ({filePath, mimeType:'image/png'});
    t.after(() => service[method] = previous);
    const streams=[]; const original = fs.createReadStream;
    fs.createReadStream = function(...args) { const stream=original.apply(this,args); if(args[0]===filePath) streams.push(stream); return stream; };
    t.after(() => fs.createReadStream = original);
    const app = express(); app.use(require('../dist/modules/'+kind+'/http/'+kind+'Routes').default);
    const server = app.listen(0,'127.0.0.1');
    await new Promise(resolve=>server.once('listening',resolve));
    t.after(async()=>{server.closeAllConnections(); await new Promise(resolve=>server.close(resolve));});
    const url = `http://127.0.0.1:${server.address().port}${route}`;
    const response=await fetch(url); assert.equal(response.status,200);
    assert.deepEqual(Buffer.from(await response.arrayBuffer()), data);
    streams.length=0;
    await new Promise((resolve,reject)=>{
      const request=http.get(url,response=>response.once('data',()=>{response.destroy();request.destroy();resolve();}));
      request.on('error',error=>{if(error.code!=='ECONNRESET')reject(error);});
    });
    await new Promise(resolve=>setTimeout(resolve,100));
    assert.ok(streams.length>0);
    assert.ok(streams.every(stream=>stream.destroyed && stream.closed), 'aborted response must close every source stream');
  });
}
