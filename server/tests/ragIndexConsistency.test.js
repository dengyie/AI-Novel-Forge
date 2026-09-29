const test = require('node:test');
const assert = require('node:assert/strict');
const { prisma } = require('../dist/db/prisma.js');
const { ragJobQueue } = require('../dist/services/rag/mainProcessProxy.js');
const { ragWorkerManager } = require('../dist/runtime/RagWorkerManager.js');
const { RagIndexService } = require('../dist/services/rag/RagIndexService.js');
const settings = require('../dist/services/settings/RagSettingsService.js');

function patch(t, object, name, replacement) {
  const old = object[name]; object[name] = replacement; t.after(() => object[name] = old);
}
for (const surface of ['main', 'worker']) {
  test(`${surface}: running source update persists a follow-up job with its new payload`, async t => {
    const old = { id: 'old', status: 'running', payloadJson: JSON.stringify({ preChunks: ['v1'] }) };
    const created = [];
    patch(t, prisma.ragIndexJob, 'findFirst', async () => old);
    patch(t, prisma.ragIndexJob, 'create', async ({data}) => { created.push(data); return {id: 'new', ...data}; });
    patch(t, ragWorkerManager, 'kickPoll', () => {});
    const queue = surface === 'main' ? ragJobQueue : new RagIndexService({}, {});
    const result = await queue.enqueueOwnerJob('rebuild', 'novel', 'n', {payload: {preChunks: ['v2']}});
    assert.equal(result.id, 'new');
    assert.equal(created.length, 1);
    assert.deepEqual(JSON.parse(created[0].payloadJson).preChunks, ['v2']);
  });
}

test('failed old vector cleanup keeps old DB IDs and rejects instead of completing', async t => {
  const rows = [{id: 'old', indexedAt:new Date()}];
  patch(t, prisma, '$transaction', async promises => Promise.all(promises));
  patch(t, prisma.knowledgeChunk, 'updateMany', async ({where,data}) => { for(const row of rows) if(where.id.in.includes(row.id)) Object.assign(row,data); return {count:1}; });
  patch(t, settings, 'getRagEmbeddingSettings', async () => ({embeddingProvider:'openai', embeddingModel:'text-embedding-3-small'}));
  patch(t, prisma.ragIndexJob, 'findUnique', async () => ({payloadJson:'{}'}));
  patch(t, prisma.knowledgeChunk, 'findMany', async () => rows.slice());
  patch(t, prisma.knowledgeChunk, 'createMany', async ({data}) => {rows.push(...data); return {count:data.length};});
  patch(t, prisma.knowledgeChunk, 'deleteMany', async ({where}) => {
    const ids = where.id.in; for(let i=rows.length-1;i>=0;i--) if(ids.includes(rows[i].id)) rows.splice(i,1);
    return {count:ids.length};
  });
  const service = new RagIndexService({}, {
    ensureCollection: async()=>{}, upsertPoints: async()=>{},
    deletePoints: async()=>{throw new Error('qdrant unavailable');},
  }, {applyToCandidates:async()=>{}});
  service.assertJobNotCancelled = async()=>{};
  service.updateJobProgress = async()=>{};
  service.sourceAssembler.loadSourceDocuments = async()=>[{ownerType:'novel',ownerId:'n',tenantId:'default',content:'new'}];
  service.sourceAssembler.buildChunkCandidates = ()=>[{id:'new',ownerType:'novel',ownerId:'n',tenantId:'default',chunkText:'new',chunkOrder:0,chunkHash:'new',tokenEstimate:1,language:'en',embedVersion:'v1'}];
  service.embedTextsInBatches = async()=>({provider:'openai',model:'embed',vectors:[[1]]});
  await assert.rejects(service.upsertOwnerChunks('novel','n','default','job'), /qdrant unavailable/);
  assert.ok(rows.some(row=>row.id==='old'));
  assert.equal(rows.find(row=>row.id==='old').indexedAt, null);
  assert.ok(rows.find(row=>row.id==='new').indexedAt instanceof Date);
});

for (const surface of ['main','worker']) {
  for (const claimed of [false,true]) {
    test(`${surface}: queued payload replacement ${claimed ? 'racing a worker claim preserves a follow-up' : 'persists latest preChunks'}`, async t => {
      const previous = {id:'queued',status:'queued',payloadJson:JSON.stringify({preChunks:['v1']})};
      let written;
      patch(t, prisma.ragIndexJob, 'findFirst', async()=>previous);
      patch(t, prisma.ragIndexJob, 'updateMany', async({where,data})=> {
        assert.equal(where.status,'queued'); assert.equal(where.payloadJson,previous.payloadJson);
        if(claimed) return {count:0}; written=data; return {count:1};
      });
      patch(t, prisma.ragIndexJob, 'create', async({data})=> {written=data;return {id:'follow-up',...data};});
      patch(t, ragWorkerManager, 'kickPoll', ()=>{});
      const queue=surface==='main'?ragJobQueue:new RagIndexService({},{});
      const result=await queue.enqueueOwnerJob('rebuild','novel','n',{payload:{preChunks:['v2']}});
      assert.equal(result.id,claimed?'follow-up':'queued');
      assert.deepEqual(JSON.parse(written.payloadJson).preChunks,['v2']);
    });
  }
}

test('partial external upsert retains every new ID as unpublished for restart cleanup',async t=>{
  const {replaceIndexedChunks}=require('../dist/services/rag/indexing/persistence');
  const rows=[{id:'old',indexedAt:new Date()}]; let deletes=0;
  patch(t,prisma.knowledgeChunk,'createMany',async({data})=>{rows.push(...data);return {count:data.length};});
  const candidates=['a','b'].map(id=>({id,ownerType:'novel',ownerId:'n',tenantId:'default',chunkText:id,chunkOrder:0,chunkHash:id,tokenEstimate:1,language:'en',embedVersion:1}));
  await assert.rejects(replaceIndexedChunks({
    upsertPoints:async points=>{assert.deepEqual(rows.map(r=>r.id),['old','a','b']); assert.equal(points.length,2);throw Error('second batch failed');},
    deletePoints:async()=>{deletes++;},
  },candidates,[[1],[2]],['old']),/second batch failed/);
  assert.equal(deletes,0);
  assert.ok(rows[0].indexedAt);
  assert.ok(rows.slice(1).every(row=>row.indexedAt===null));
});

test('retry removes IDs retained by a previous failed cleanup',async t=>{
  const {replaceIndexedChunks}=require('../dist/services/rag/indexing/persistence');
  const rows=[{id:'old',indexedAt:null},{id:'failed-new',indexedAt:null}];const deleted=[];
  patch(t,prisma.knowledgeChunk,'createMany',async({data})=>{rows.push(...data);return {count:data.length};});
  patch(t,prisma.knowledgeChunk,'updateMany',async({where,data})=>{for(const row of rows)if(where.id.in.includes(row.id))Object.assign(row,data);return {count:1};});
  patch(t,prisma,'$transaction',async promises=>Promise.all(promises));
  patch(t,prisma.knowledgeChunk,'deleteMany',async({where})=>{assert.deepEqual(deleted,where.id.in); for(let i=rows.length-1;i>=0;i--)if(where.id.in.includes(rows[i].id))rows.splice(i,1);return{count:2};});
  await replaceIndexedChunks({upsertPoints:async()=>{},deletePoints:async ids=>deleted.push(...ids)},[{id:'latest',ownerType:'novel',ownerId:'n',tenantId:'default',chunkText:'x',chunkOrder:0,chunkHash:'x',tokenEstimate:1,language:'en',embedVersion:1}],[[1]],['old','failed-new']);
  assert.deepEqual(rows.map(row=>row.id),['latest']);
  assert.ok(rows[0].indexedAt);
});

test('retrieval rejects inactive IDs and superseded or archived knowledge versions',async t=>{
  const {filterPublishedChunks}=require('../dist/services/rag/retrieval');
  const rows=[
    {id:'inactive',ownerType:'novel',ownerId:'n'},
    {id:'unknown',ownerType:'novel',ownerId:'n'},
    {id:'old',ownerType:'knowledge_document',ownerId:'doc',metadataJson:JSON.stringify({activeVersionId:'v1'})},
    {id:'current',ownerType:'knowledge_document',ownerId:'doc',metadataJson:JSON.stringify({activeVersionId:'v2'})},
    {id:'archived',ownerType:'knowledge_document',ownerId:'gone',metadataJson:JSON.stringify({activeVersionId:'v1'})},
  ];
  patch(t,prisma.knowledgeChunk,'findMany',async({where})=>{assert.deepEqual(where.indexedAt,{not:null});return rows.filter(row=>!['inactive','unknown'].includes(row.id));});
  patch(t,prisma.knowledgeDocument,'findMany',async()=>[{id:'doc',activeVersionId:'v2'}]);
  assert.deepEqual((await filterPublishedChunks(rows)).map(row=>row.id),['current']);
});

test('old version success cannot project new document as succeeded and queues catch-up',async t=>{
  patch(t,prisma.knowledgeChunk,'findFirst',async()=>null);
  const {syncDocumentIndexStatus}=require('../dist/services/rag/indexing');
  let updates=0,created;
  patch(t,prisma.ragIndexJob,'findUnique',async()=>({id:'old',tenantId:'default',payloadJson:JSON.stringify({indexedSourceVersionId:'v1'})}));
  patch(t,prisma.knowledgeDocument,'findUnique',async()=>({activeVersionId:'v2',status:'active'}));
  patch(t,prisma.ragIndexJob,'findFirst',async()=>null);
  patch(t,prisma.ragIndexJob,'create',async({data})=>{created=data;return{id:'catch-up',...data};});
  patch(t,prisma.knowledgeDocument,'updateMany',async()=>{updates++;return{count:1};});
  await syncDocumentIndexStatus('knowledge_document','doc','succeeded','rebuild','old');
  assert.equal(updates,0);
  assert.equal(JSON.parse(created.payloadJson).sourceVersionId,'v2');
});

test('source assembly never applies preChunks from another document version',async t=>{
  const {SourceDocumentAssembler}=require('../dist/services/rag/indexing/source');
  patch(t,prisma.knowledgeDocument,'findUnique',async()=>({id:'doc',title:'doc',status:'active',activeVersionId:'v2',activeVersion:{content:'new text'},updatedAt:new Date()}));
  const sources=await new SourceDocumentAssembler().loadSourceDocuments('knowledge_document','doc','default',{sourceVersionId:'v1',preChunks:[{chunkText:'old text'}]});
  assert.equal(sources[0].content,'new text');
  assert.equal(sources[0].preChunks,undefined);
});

for (const sourceVersionId of ['v2', 'v1']) {
  test(`catch-up from ${sourceVersionId} preserves newest queued custom chunks`,async t=>{
    const existing={id:'queued',status:'queued',payloadJson:JSON.stringify({sourceVersionId:'v2',preChunks:[{chunkText:'new custom'}]})};
    patch(t,prisma.knowledgeDocument,'findUnique',async()=>({activeVersionId:'v2'}));
    patch(t,prisma.ragIndexJob,'findFirst',async()=>existing);
    patch(t,prisma.ragIndexJob,'updateMany',async()=>({count:1}));
    patch(t,ragWorkerManager,'kickPoll',()=>{});
    const result=await ragJobQueue.enqueueOwnerJob('rebuild','knowledge_document','doc',{payload:{sourceVersionId}});
    assert.deepEqual(JSON.parse(result.payloadJson).preChunks,[{chunkText:'new custom'}]);
  });
}

test('matching source completion uses a version CAS and preserves a pending follow-up',async t=>{
  const {syncDocumentIndexStatus}=require('../dist/services/rag/indexing');
  patch(t,prisma.ragIndexJob,'findUnique',async()=>({payloadJson:JSON.stringify({indexedSourceVersionId:'v2'})}));
  patch(t,prisma.knowledgeDocument,'findUnique',async()=>({activeVersionId:'v2',status:'enabled'}));
  patch(t,prisma.ragIndexJob,'findMany',async()=>[{status:'queued',payloadJson:JSON.stringify({sourceVersionId:'v2'})}]);
  let write;
  patch(t,prisma.knowledgeDocument,'updateMany',async args=>{write=args;return{count:1};});
  await syncDocumentIndexStatus('knowledge_document','doc','succeeded','rebuild','job');
  assert.equal(write.where.activeVersionId,'v2');
  assert.equal(write.data.latestIndexStatus,'queued');
  assert.equal(write.data.lastIndexedAt,undefined);
});

test('producer with an older version snapshot cannot replace a newer queued payload',async t=>{
  const existing={id:'newer',status:'queued',payloadJson:JSON.stringify({sourceVersionId:'v3',preChunks:[{chunkText:'v3'}]})};
  patch(t,prisma.knowledgeDocument,'findUnique',async()=>({activeVersionId:'v2'})); // read immediately before concurrent v3 activation
  patch(t,prisma.ragIndexJob,'findFirst',async()=>existing);
  let cas=0;
  patch(t,prisma.ragIndexJob,'updateMany',async()=>{cas++;return{count:1};});
  patch(t,prisma.ragIndexJob,'create',async({data})=>({id:'older-follow-up',...data}));
  patch(t,ragWorkerManager,'kickPoll',()=>{});
  const result=await ragJobQueue.enqueueOwnerJob('rebuild','knowledge_document','doc',{payload:{sourceVersionId:'v2',preChunks:[{chunkText:'v2'}]}});
  assert.equal(cas,0);
  assert.equal(result.id,'older-follow-up');
  assert.equal(JSON.parse(existing.payloadJson).preChunks[0].chunkText,'v3');
});

test('delayed superseded job performs no writes and does not rebuild an already indexed current version',async t=>{
  patch(t,prisma.knowledgeChunk,'findFirst',async()=>({metadataJson:JSON.stringify({activeVersionId:'v2'})}));
  patch(t,settings,'getRagEmbeddingSettings',async()=>({embeddingProvider:'openai',embeddingModel:'text-embedding-3-small'}));
  let payload={sourceVersionId:'v1'};
  patch(t,prisma.ragIndexJob,'findUnique',async()=>({payloadJson:JSON.stringify(payload)}));
  patch(t,prisma.ragIndexJob,'update',async({data})=>{payload=JSON.parse(data.payloadJson);return{id:'old'};});
  const service=new RagIndexService({},{});
  service.assertJobNotCancelled=async()=>{};
  service.updateJobProgress=async()=>{};
  service.sourceAssembler.loadSourceDocuments=async()=>[{metadata:{activeVersionId:'v2'}}];
  service.sourceAssembler.buildChunkCandidates=()=>{throw Error('superseded job must not rebuild');};
  assert.deepEqual(await service.upsertOwnerChunks('knowledge_document','doc','default','old'),{chunks:0});
  assert.equal(payload.indexedSourceVersionId,'v1');
  patch(t,prisma.knowledgeDocument,'findUnique',async()=>({activeVersionId:'v2',status:'enabled',latestIndexStatus:'succeeded'}));
  patch(t,prisma.ragIndexJob,'create',async()=>{throw Error('must not overwrite current custom chunks');});
  await require('../dist/services/rag/indexing').syncDocumentIndexStatus('knowledge_document','doc','succeeded','rebuild','old');
});

test('late rebuild completion cannot mark an archived document indexed',async t=>{
  patch(t,prisma.ragIndexJob,'findUnique',async()=>({payloadJson:JSON.stringify({sourceVersionId:'v1',indexedSourceVersionId:'v1'})}));
  patch(t,prisma.knowledgeDocument,'findUnique',async()=>({activeVersionId:'v1',status:'archived',latestIndexStatus:'idle'}));
  patch(t,prisma.knowledgeDocument,'updateMany',async()=>{throw Error('archived status must stay idle');});
  await require('../dist/services/rag/indexing').syncDocumentIndexStatus('knowledge_document','doc','succeeded','rebuild','old');
});

test('a succeeded label without published current-version chunks is not proof of catch-up',async t=>{
  const {syncDocumentIndexStatus}=require('../dist/services/rag/indexing');
  patch(t,prisma.ragIndexJob,'findUnique',async()=>({id:'v1-retry',tenantId:'default',payloadJson:JSON.stringify({indexedSourceVersionId:'v1'})}));
  patch(t,prisma.knowledgeDocument,'findUnique',async()=>({activeVersionId:'v2',status:'enabled',latestIndexStatus:'succeeded'}));
  patch(t,prisma.knowledgeChunk,'findFirst',async()=>({metadataJson:JSON.stringify({activeVersionId:'v1'})}));
  patch(t,prisma.ragIndexJob,'findFirst',async()=>null);
  let created;
  patch(t,prisma.ragIndexJob,'create',async({data})=>{created=data;return{id:'catch-up',...data};});
  await syncDocumentIndexStatus('knowledge_document','doc','succeeded','rebuild','v1-retry');
  assert.ok(created,'missing v2 publication still requires a persisted catch-up');
  assert.equal(JSON.parse(created.payloadJson).sourceVersionId,'v2');
});

test('v1 queued backoff does not regress v2 completion and its retry preserves v2 custom chunks',async t=>{
  const {replaceIndexedChunks}=require('../dist/services/rag/indexing/persistence');
  const rows=[];let queued=0;
  patch(t,prisma.knowledgeChunk,'createMany',async({data})=>{rows.push(...data);return{count:data.length};});
  patch(t,prisma.knowledgeChunk,'updateMany',async({where,data})=>{for(const row of rows)if(where.id.in.includes(row.id))Object.assign(row,data);return{count:1};});
  patch(t,prisma,'$transaction',async promises=>Promise.all(promises));
  // v2 completes while v1 is waiting in retry backoff.
  await replaceIndexedChunks({upsertPoints:async()=>{},deletePoints:async()=>{}},[{id:'v2-custom',tenantId:'default',ownerType:'knowledge_document',ownerId:'doc',chunkText:'custom v2',chunkOrder:0,chunkHash:'custom',tokenEstimate:2,language:'en',embedVersion:1,metadataJson:JSON.stringify({activeVersionId:'v2'})}],[[1]],[]);
  const document={activeVersionId:'v2',status:'enabled',latestIndexStatus:'running'};
  patch(t,prisma.ragIndexJob,'findUnique',async()=>({id:'v2',tenantId:'default',payloadJson:JSON.stringify({sourceVersionId:'v2',indexedSourceVersionId:'v2'})}));
  patch(t,prisma.ragIndexJob,'findFirst',async()=>({id:'v1-retry',status:'queued',payloadJson:JSON.stringify({sourceVersionId:'v1'})}));
  patch(t,prisma.ragIndexJob,'findMany',async()=>[{id:'v1-retry',status:'queued',payloadJson:JSON.stringify({sourceVersionId:'v1'})}]);
  patch(t,prisma.knowledgeDocument,'findUnique',async()=>document);
  patch(t,prisma.knowledgeDocument,'updateMany',async({data})=>{Object.assign(document,data);return{count:1};});
  await require('../dist/services/rag/indexing').syncDocumentIndexStatus('knowledge_document','doc','succeeded','rebuild','v2');
  assert.equal(document.latestIndexStatus,'succeeded','queued older-version retries do not make v2 pending');
  let oldPayload={sourceVersionId:'v1',preChunks:[{chunkText:'v1'}]};
  patch(t,prisma.ragIndexJob,'findUnique',async()=>({id:'v1-retry',tenantId:'default',payloadJson:JSON.stringify(oldPayload)}));
  patch(t,prisma.ragIndexJob,'update',async({data})=>{oldPayload=JSON.parse(data.payloadJson);return{id:'v1-retry'};});
  patch(t,prisma.knowledgeDocument,'findUnique',async()=>document);
  patch(t,prisma.knowledgeChunk,'findFirst',async({where})=>{
    assert.deepEqual(where.indexedAt,{not:null}); return rows.find(row=>row.indexedAt!==null);
  });
  patch(t,prisma.ragIndexJob,'findFirst',async()=>null); // v2 is succeeded, no queued job exists
  patch(t,prisma.ragIndexJob,'create',async({data})=>{queued++;return{id:'bad-default-rebuild',...data};});
  const service=new RagIndexService({},{});
  service.assertJobNotCancelled=async()=>{};service.updateJobProgress=async()=>{};
  service.sourceAssembler.loadSourceDocuments=async()=>[{metadata:{activeVersionId:'v2'}}];
  service.sourceAssembler.buildChunkCandidates=()=>{throw Error('v1 must not rebuild v2');};
  await service.upsertOwnerChunks('knowledge_document','doc','default','v1-retry');
  await require('../dist/services/rag/indexing').syncDocumentIndexStatus('knowledge_document','doc','succeeded','rebuild','v1-retry');
  assert.equal(queued,0,'published v2 must not be replaced by a default catch-up');
  assert.equal(rows[0].chunkText,'custom v2');
  assert.equal(rows.length,1);
});
