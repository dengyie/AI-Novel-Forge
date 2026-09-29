const test=require('node:test');
const assert=require('node:assert/strict');
const {prisma}=require('../dist/db/prisma');
const {KnowledgeService}=require('../dist/services/knowledge/KnowledgeService');
const {ragMain}=require('../dist/services/rag/mainProcessProxy');
function patch(t,object,key,replacement){const previous=object[key];object[key]=replacement;t.after(()=>object[key]=previous);}
function fixture(t,{failQueue=false,absent=false,archived=false}={}){
  let state={document:absent?null:{id:'doc',status:archived?'archived':'enabled',activeVersionId:'v1',activeVersionNumber:1,fileName:'a.txt',title:'a',latestIndexStatus:'succeeded'},versions:[],jobs:[]};
  function client(get){return{
    knowledgeDocument:{
      findUnique:async()=>get().document,findFirst:async()=>get().document,
      create:async({data})=>(get().document={id:'doc',...data}),
      update:async({data})=>(get().document={...get().document,...data}),
    },
    knowledgeDocumentVersion:{
      create:async({data})=>{const version={id:'v2',...data};get().versions.push(version);return version;},
      findFirst:async()=>({id:'v2',documentId:'doc',versionNumber:2}),
    },
    ragIndexJob:{
      findFirst:async()=>null,
      create:async({data})=>{if(failQueue)throw Error('queue write failed');const row={id:'job',...data};get().jobs.push(row);return row;},
    },
  };}
  patch(t,require('../dist/runtime/RagWorkerManager').ragWorkerManager,'kickPoll',()=>{});
  const direct=client(()=>state);
  for(const [model,delegate]of Object.entries(direct))for(const [method,fn]of Object.entries(delegate))patch(t,prisma[model],method,fn);
  patch(t,prisma,'$transaction',async callback=>{const draft=structuredClone(state);const result=await callback(client(()=>draft));state=draft;return result;});
  let wakeups=0;patch(t,ragMain,'kickWorker',()=>{assert.ok(state.jobs.length,'wake only after commit');wakeups++;});
  const service=new KnowledgeService();service.getDocumentById=async()=>state.document;
  return{service,read:()=>state,wakeups:()=>wakeups};
}
const actions={
  create:service=>service.createDocument({fileName:'a.txt',content:'new',indexPayload:{preChunks:['custom']}}),
  replace:service=>service.createDocument({fileName:'a.txt',content:'new',indexPayload:{preChunks:['custom']}}),
  version:service=>service.createDocumentVersion('doc',{content:'new',indexPayload:{preChunks:['custom']}}),
  activate:service=>service.activateVersion('doc','v2'),
  reindex:service=>service.reindexDocument('doc'),
  restore:service=>service.updateDocumentStatus('doc','enabled'),
  archive:service=>service.updateDocumentStatus('doc','archived'),
};
for(const[action,run]of Object.entries(actions)){
  test(`${action}: failed queue write rolls back source mutation`,async t=>{
    const f=fixture(t,{failQueue:true,absent:action==='create',archived:action==='restore'});const before=structuredClone(f.read());
    await assert.rejects(run(f.service),/queue write failed/);
    assert.deepEqual(f.read(),before);assert.equal(f.wakeups(),0);
  });
  test(`${action}: success commits source and version-bound durable job together`,async t=>{
    const f=fixture(t,{absent:action==='create',archived:action==='restore'});
    await run(f.service);
    assert.equal(f.read().jobs.length,1);assert.equal(f.wakeups(),1);
    const job=f.read().jobs[0];assert.equal(job.jobType,action==='archive'?'delete':'rebuild');
    const payload=JSON.parse(job.payloadJson);assert.equal(payload.sourceVersionId,f.read().document.activeVersionId);
    if(['create','replace','version'].includes(action))assert.deepEqual(payload.preChunks,['custom']);
  });
}
