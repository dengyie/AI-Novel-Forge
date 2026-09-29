const test=require('node:test');
const assert=require('node:assert/strict');
const {prisma}=require('../dist/db/prisma');
const {RagIndexService}=require('../dist/services/rag/RagIndexService');
const {syncDocumentIndexStatus}=require('../dist/services/rag/indexing');
const settings=require('../dist/services/settings/RagSettingsService');
function patch(t,o,key,value){const old=o[key];o[key]=value;t.after(()=>o[key]=old);}

test('archive delete retry cannot remove a restored and rebuilt document',async t=>{
  const document={id:'doc',status:'archived',activeVersionId:'v1',latestIndexStatus:'idle'};
  const job={id:'archive-delete',tenantId:'default',ownerType:'knowledge_document',ownerId:'doc',jobType:'delete',payloadJson:JSON.stringify({sourceVersionId:'v1'})};
  patch(t,settings,'getRagEmbeddingSettings',async()=>({embeddingProvider:'openai',embeddingModel:'test'}));
  patch(t,prisma.knowledgeDocument,'findUnique',async()=>document);
  patch(t,prisma.ragIndexJob,'findUnique',async()=>job);
  patch(t,prisma.ragIndexJob,'findMany',async()=>[]);
  patch(t,prisma.knowledgeDocument,'updateMany',async({data})=>{Object.assign(document,data);return{count:1};});
  const service=new RagIndexService({},{});service.assertJobNotCancelled=async()=>{};service.updateJobProgress=async()=>{};
  let attempts=0;let chunks=['old'];
  service.deleteOwnerChunks=async()=>{attempts++;if(attempts===1)throw Error('temporary vector outage');chunks=[];return{deleted:1};};
  await assert.rejects(service.processJob(job),/temporary vector outage/);
  document.status='enabled';document.latestIndexStatus='succeeded';chunks=['restored-current'];
  await service.processJob(job);
  await syncDocumentIndexStatus('knowledge_document','doc','succeeded','delete',job.id);
  assert.deepEqual(chunks,['restored-current']);
  assert.equal(attempts,1);
  assert.equal(document.latestIndexStatus,'succeeded');
});

test('a document that remains archived still clears its published chunks',async t=>{
  patch(t,settings,'getRagEmbeddingSettings',async()=>({embeddingProvider:'openai',embeddingModel:'test'}));
  patch(t,prisma.knowledgeDocument,'findUnique',async()=>({status:'archived'}));
  const service=new RagIndexService({},{});service.assertJobNotCancelled=async()=>{};service.updateJobProgress=async()=>{};
  let deleted=0;service.deleteOwnerChunks=async()=>{deleted++;return{deleted:1};};
  await service.processJob({id:'delete',tenantId:'default',ownerType:'knowledge_document',ownerId:'doc',jobType:'delete'});
  assert.equal(deleted,1);
});
