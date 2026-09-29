const test=require('node:test');
const assert=require('node:assert/strict');
const http=require('node:http');
const {ragConfig}=require('../dist/config/rag');
const {EmbeddingService}=require('../dist/services/rag/EmbeddingService');
const {VectorStoreService}=require('../dist/services/rag/VectorStoreService');

async function slowBody(t,status,body,run,delay=400){
  const saved={embeddingTimeoutMs:ragConfig.embeddingTimeoutMs,qdrantTimeoutMs:ragConfig.qdrantTimeoutMs,embeddingMaxRetries:ragConfig.embeddingMaxRetries,qdrantUrl:ragConfig.qdrantUrl};
  Object.assign(ragConfig,{embeddingTimeoutMs:60,qdrantTimeoutMs:60,embeddingMaxRetries:0});
  const timers=new Set();
  const server=http.createServer((req,res)=>{
    res.writeHead(status,{'content-type':'application/json'});res.flushHeaders();
    const timer=setTimeout(()=>res.end(body),delay);timers.add(timer);res.on('close',()=>{clearTimeout(timer);timers.delete(timer);});
  });
  server.listen(0,'127.0.0.1');await new Promise(resolve=>server.once('listening',resolve));
  const url=`http://127.0.0.1:${server.address().port}`;ragConfig.qdrantUrl=url;
  try{await run(url);}finally{Object.assign(ragConfig,saved);for(const timer of timers)clearTimeout(timer);server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}
}
for(const status of [200,500]){
  test(`embedding ${status} response body stays inside request deadline`,async t=>{
    await slowBody(t,status,JSON.stringify({data:[{embedding:[1],index:0}]}),async url=>{
      const start=Date.now();
      await assert.rejects(new EmbeddingService().requestEmbeddingBatch(['text'],{baseUrl:url,model:'fixture',provider:'openai'}),/timed out/);
      assert.ok(Date.now()-start<300);
    });
  });
  test(`Qdrant ${status} response body stays inside request deadline`,async t=>{
    await slowBody(t,status,JSON.stringify({result:{}}),async url=>{
      const start=Date.now();
      await assert.rejects(new VectorStoreService().request(url),/请求超时/);
      assert.ok(Date.now()-start<300);
    });
  });
}
test('collection metadata body also respects timeout',async t=>{
  await slowBody(t,200,JSON.stringify({result:{config:{params:{vectors:{size:1}}}}}),async()=>{
    await assert.rejects(new VectorStoreService().ensureCollection(1),/请求超时/);
  });
});
test('health success requires body completion inside timeout',async t=>{
  await slowBody(t,200,'{}',async()=>{
    const result=await new VectorStoreService().healthCheck();
    assert.equal(result.ok,false);assert.match(result.detail,/请求超时/);
  });
});

test('fast complete payloads succeed without changing application error retry semantics',async t=>{
  await slowBody(t,200,JSON.stringify({data:[{embedding:[1,2],index:0}]}),async url=>{
    assert.deepEqual(await new EmbeddingService().requestEmbeddingBatch(['text'],{baseUrl:url,model:'fixture',provider:'openai'}),[[1,2]]);
    assert.equal((await new VectorStoreService().healthCheck()).ok,true);
  },0);
  await slowBody(t,400,'bad input',async url=>{
    await assert.rejects(new EmbeddingService().requestEmbeddingBatch(['text'],{baseUrl:url,model:'fixture',provider:'openai'}),error=>{
      assert.equal(error.retryable,false);assert.equal(error.shouldSplitBatch,false);assert.match(error.message,/400/);return true;
    });
  },0);
});
test('collection 404 cancels unread body and creates collection with separate request deadlines',async()=>{
  const oldFetch=global.fetch;const previousTimeout=ragConfig.qdrantTimeoutMs;
  ragConfig.qdrantTimeoutMs=30;let cancelled=false;let calls=0;
  global.fetch=async(_url,init)=>{
    calls++;
    if(calls===1)return new Response(new ReadableStream({cancel(){cancelled=true;}}),{status:404});
    await new Promise(resolve=>setTimeout(resolve,5));
    assert.equal(init.signal.aborted,false);
    return new Response('{}',{status:200});
  };
  try{await new VectorStoreService().ensureCollection(1);assert.ok(cancelled);assert.ok(calls>2);}
  finally{global.fetch=oldFetch;ragConfig.qdrantTimeoutMs=previousTimeout;}
});
