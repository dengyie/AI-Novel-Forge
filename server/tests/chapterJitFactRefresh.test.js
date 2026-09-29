const test = require('node:test');
const assert = require('node:assert/strict');
const { prisma } = require('../dist/db/prisma.js');
const { novelFactService } = require('../dist/services/novel/fact/NovelFactService.js');
const { ChapterPlanJITService } = require('../dist/services/novel/planning/ChapterPlanJITService.js');
const { ChapterExecutionContractService } = require('../dist/services/novel/volume/ChapterExecutionContractService.js');
const generation = require('../dist/services/novel/volume/volumeGenerationOrchestrator.js');

function fixture() {
  const originals = { find: prisma.chapter.findFirst, facts: novelFactService.listForChapter,
    generate: generation.generateVolumePlanDocument };
  const chapter = { id:'c', novelId:'n', order:6, title:'chapter', taskSheet:'old task sheet', sceneCards:JSON.stringify({
    targetWordCount:2000, lengthBudget:{targetWordCount:2000,softMinWordCount:1700,softMaxWordCount:2300,hardMaxWordCount:2500},
    scenes:[1,2,3].map(i=>({key:`s${i}`,title:'scene',purpose:'推进冲突',mustAdvance:['目标'],mustPreserve:['动机'],entryState:'进入冲突',exitState:'压力升级',forbiddenExpansion:[],targetWordCount:667})),
  }),
    targetWordCount:2000, conflictLevel:1, revealLevel:1, mustAvoid:'avoid', riskFlags:null };
  let facts = [1,2,3].map(i=>({ category:'completed', chapterOrder:i, text:`fact ${i}` }));
  let generated = 0;
  prisma.chapter.findFirst = async () => chapter;
  novelFactService.listForChapter = async () => facts;
  generation.generateVolumePlanDocument = async () => { generated++; throw Error('GENERATION_REACHED'); };
  const contract = new ChapterExecutionContractService({
    ensureVolumeWorkspace:async()=>({volumes:[{id:'v',chapters:[{id:'vc',purpose:'p',exclusiveEvent:'e',endingState:'s',nextChapterEntryState:'n'}]}]}),
    findVolumeChapterMatch:()=>({volumeId:'v',volumeChapterId:'vc'}),
    styleBindingService:{resolveForGeneration:async()=>({})},
  });
  return { chapter, contract, get generated(){return generated}, setFacts:v=>facts=v,
    cleanup(){prisma.chapter.findFirst=originals.find;novelFactService.listForChapter=originals.facts;
      generation.generateVolumePlanDocument=originals.generate;} };
}

test('JIT with new facts bypasses complete-contract reuse and reaches AI generation', async()=>{
  const f=fixture();
  try {
    const jit=new ChapterPlanJITService({ensureChapterExecutionContract:(...args)=>f.contract.ensureChapterExecutionContract(...args)});
    await assert.rejects(()=>jit.ensureExecutionReady('n','c'), /GENERATION_REACHED/);
    assert.equal(f.generated,1);
  } finally { f.cleanup(); }
});

test('same fact fingerprint is stable across fact ordering and concurrent prefetch joins', async()=>{
  const f=fixture();
  try {
    let calls=0, received;
    let release; const blocked=new Promise(resolve=>release=resolve);
    const jit=new ChapterPlanJITService({ensureChapterExecutionContract:async(n,c,options)=>{
      calls++; received=options; await blocked;
    }});
    const first=jit.ensureExecutionReady('n','c');
    const second=jit.ensureExecutionReady('n','c');
    await new Promise(resolve=>setImmediate(resolve)); release();
    await Promise.all([first,second]);
    assert.equal(calls,1);
    assert.ok(received.factRefresh?.fingerprint);
    const fingerprint=received.factRefresh.fingerprint;
    f.setFacts([3,2,1].map(i=>({category:'completed',chapterOrder:i,text:`fact ${i}`})));
    await jit.ensureExecutionReady('n','c');
    assert.equal(received.factRefresh.fingerprint,fingerprint);
  } finally {f.cleanup();}
});

test('successful refresh persists its fingerprint with the contract; new service instances reuse it', async()=>{
  const f=fixture();
  const persistence=require('../dist/services/novel/volume/volumeWorkspacePersistence.js');
  const serialization=require('../dist/services/novel/volume/volumeWorkspaceDocument.js');
  const original={transaction:persistence.runVolumeWorkspaceTransaction,persist:persistence.persistActiveVolumeWorkspace,
    serialize:serialization.serializeVolumeWorkspaceDocument};
  let generationCount=0, writes=0;
  let allowClaim=true;
  const workspace={volumes:[{id:'v',chapters:[{id:'vc',purpose:'p',exclusiveEvent:'e',endingState:'s',nextChapterEntryState:'n'}]}]};
  const generator=async({options})=>{
    generationCount++;
    if (options.guidance) assert.ok(options.guidance.includes('fact'));
    return {volumes:[{id:'v',chapters:[{...workspace.volumes[0].chapters[0],
      taskSheet:'【本章独占事件】主角发现新的事实。\n【人物选择】在公开对质与私下取证之间押上人脉。\n【现场压力】雨夜仓库警报响起。',sceneCards:f.chapter.sceneCards,targetWordCount:2000,conflictLevel:45,revealLevel:35,mustAvoid:'不要重复旧事件',summary:'核对新事实'}]}]};
  };
  try {
    f.chapter.riskFlags=JSON.stringify({chapterSummaryStale:{reason:'keep'}});
    f.chapter.updatedAt=new Date('2026-09-01T00:00:00Z');
    generation.generateVolumePlanDocument=generator;
    serialization.serializeVolumeWorkspaceDocument=JSON.stringify;
    persistence.persistActiveVolumeWorkspace=async()=>{writes++};
    persistence.runVolumeWorkspaceTransaction=async callback=>callback({
      chapter:{updateMany:async({where})=>{assert.equal(where.updatedAt,f.chapter.updatedAt);return {count:allowClaim?1:0}},
        findUnique:async()=>f.chapter,update:async({data})=>Object.assign(f.chapter,data)},
      volumePlanVersion:{update:async()=>{writes++}},
    });
    const create=()=>new ChapterPlanJITService({ensureChapterExecutionContract:(...args)=>new ChapterExecutionContractService({
      ensureVolumeWorkspace:async()=>workspace,
      findVolumeChapterMatch:()=>({volumeId:'v',volumeChapterId:'vc'}),
      styleBindingService:{resolveForGeneration:async()=>({})},
      ensureActiveVersionRecord:async()=>({versionId:'version',version:1}),emitVolumeUpdated:()=>{},
    }).ensureChapterExecutionContract(...args)});
    await create().ensureExecutionReady('n','c');
    assert.equal(generationCount,1);
    const flags=JSON.parse(f.chapter.riskFlags);
    assert.ok(flags.jitPlanning.factFingerprint);
    assert.equal(flags.chapterSummaryStale.reason,'keep');
    assert.match(f.chapter.taskSheet,/主角发现新的事实/);
    await create().ensureExecutionReady('n','c');
    assert.equal(generationCount,1, 'persisted identity survives JIT and contract service recreation');
    f.setFacts([{category:'completed',chapterOrder:1,text:'changed fact'}]);
    allowClaim=false;
    const priorWrites=writes;
    await assert.rejects(()=>create().ensureExecutionReady('n','c'), /生成期间发生变化/);
    assert.equal(writes,priorWrites,'failed snapshot claim precedes all workspace/version writes');
    assert.equal(JSON.parse(f.chapter.riskFlags).jitPlanning.factFingerprint,flags.jitPlanning.factFingerprint);
    allowClaim=true;
    await create().ensureExecutionReady('n','c');
    assert.notEqual(JSON.parse(f.chapter.riskFlags).jitPlanning.factFingerprint,flags.jitPlanning.factFingerprint);
    const beforeRemoval = generationCount;
    f.setFacts([]);
    await create().ensureExecutionReady('n','c');
    assert.equal(generationCount, beforeRemoval + 1, 'removed facts invalidate the last consumed set');
    await create().ensureExecutionReady('n','c');
    assert.equal(generationCount, beforeRemoval + 1);
  } finally {
    f.cleanup();persistence.runVolumeWorkspaceTransaction=original.transaction;
    persistence.persistActiveVolumeWorkspace=original.persist;
    serialization.serializeVolumeWorkspaceDocument=original.serialize;
  }
});
