const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const Database=require('better-sqlite3');
const directory=fs.mkdtempSync(path.join(os.tmpdir(),'quality-revision-'));
const file=path.join(directory,'fixture.db');
process.env.DATABASE_URL=`file:${file}`;
const db=new Database(file);
db.exec(`CREATE TABLE Chapter (
 id TEXT PRIMARY KEY, novelId TEXT NOT NULL, title TEXT NOT NULL, content TEXT, contentRevision INTEGER NOT NULL,
 "order" INTEGER NOT NULL, generationState TEXT NOT NULL, chapterStatus TEXT, targetWordCount INTEGER,
 conflictLevel INTEGER,revealLevel INTEGER,mustAvoid TEXT,taskSheet TEXT,sceneCards TEXT,repairHistory TEXT,
 qualityScore INTEGER,continuityScore INTEGER,characterScore INTEGER,pacingScore INTEGER,riskFlags TEXT,hook TEXT,expectation TEXT,
 createdAt DATETIME DEFAULT CURRENT_TIMESTAMP, updatedAt DATETIME DEFAULT CURRENT_TIMESTAMP
)`);
const {prisma}=require('../dist/db/prisma.js');
const review=require('../dist/services/novel/novelCoreReviewService.js');
const {chapterQualityLoopService}=require('../dist/services/novel/quality/ChapterQualityLoopService.js');
const {createChapterContentConflictError}=require('../dist/services/novel/chapterContentCas.js');
const {projectPipelineChapterQuality}=require('../dist/services/novel/pipeline/quality/PipelineChapterQualityPolicy.js');
const score={overall:60,coherence:60,pacing:60,repetition:60,engagement:60,voice:60};
const freshFlags=JSON.stringify({jitPlanning:{factFingerprint:'new'},qualityLoop:{recommendedAction:'continue',status:'passed'}});
function input(id,mode){return {jobId:'job',novelId:'novel',chapter:{id,order:1,content:'旧正文'},
 chapterResult:{reviewExecuted:true,pass:false,score,issues:[],runtimePackage:null,retryCountUsed:0,contentRevision:7},
 runtimePayload:{},settingQualityMode:mode,settingAlignmentVolumeDocument:null,
 settingAlignmentWorkspaceUnavailableReason:mode==='enforce'?'workspace unavailable':null,
 volumeService:{},rangeDebtByChapterId:new Map(),startOrder:1,endOrder:3};}
function seed(id){db.prepare('INSERT INTO Chapter (id,novelId,title,content,contentRevision,"order",generationState,chapterStatus,riskFlags) VALUES (?,?,?,?,7,1,?,?,?)').run(id,'novel','章','旧正文','reviewed','needs_repair','{}');}
function saveNew(id){db.prepare('UPDATE Chapter SET content=?,contentRevision=8,chapterStatus=?,riskFlags=? WHERE id=?').run('新正文','completed',freshFlags,id);}
const originals={report:review.createQualityReport,assessment:chapterQualityLoopService.recordAssessment};
test.afterEach(()=>{review.createQualityReport=originals.report;chapterQualityLoopService.recordAssessment=originals.assessment;});
test.after(async()=>{await prisma.$disconnect();db.close();fs.rmSync(directory,{recursive:true});});
for(const mode of ['off','enforce'])test(`assessment conflict keeps new revision metadata and gate state (${mode})`,async()=>{
 const id=`assessment-${mode}`;seed(id);const request=input(id,mode);
 review.createQualityReport=async()=>{};
 chapterQualityLoopService.recordAssessment=async()=>{saveNew(id);throw createChapterContentConflictError({expectedContentRevision:7,currentContentRevision:8});};
 const result=await projectPipelineChapterQuality(request);
 const current=db.prepare('SELECT contentRevision,chapterStatus,riskFlags FROM Chapter WHERE id=?').get(id);
 assert.equal(current.riskFlags,freshFlags);assert.equal(current.chapterStatus,'completed');
 assert.equal(result.superseded,true);
 assert.equal(request.rangeDebtByChapterId.get(id).riskFlags,freshFlags);
});
test('quality report revision conflict is superseded, not an entire pipeline failure',async()=>{
 const id='report-conflict';seed(id);const request=input(id,'off');
 request.chapterResult.runtimePackage={replanRecommendation:{recommended:true,action:'stop_for_replan',reason:'obsolete plan'}};
 review.createQualityReport=async()=>{saveNew(id);throw createChapterContentConflictError({expectedContentRevision:7,currentContentRevision:8});};
 let assessments=0;chapterQualityLoopService.recordAssessment=async()=>{assessments++;};
 const result=await projectPipelineChapterQuality(request);
 assert.equal(result.superseded,true);assert.equal(assessments,0);
 const {applyPipelineReplanPolicy}=require('../dist/services/novel/pipeline/quality/PipelineReplanPolicy.js');
 const replanAlerts=[];
 assert.equal(applyPipelineReplanPolicy({jobId:'job',chapterOrder:1,recommendation:result.replanRecommendation,
  rangeGate:{shouldPause:false},qualityAlertDetails:[],replanAlertDetails:replanAlerts}),false);
 assert.deepEqual(replanAlerts,[]);
});
test('transient assessment failure retries the original revision-owned writer',async()=>{
 const id='transient';seed(id);const request=input(id,'off');review.createQualityReport=async()=>{};
 let attempts=0;
 const {buildChapterQualityLoopAssessment}=require('@ai-novel/shared/types/chapterQualityLoop');
 chapterQualityLoopService.recordAssessment=async args=>{
  attempts++;assert.equal(args.expectedContentRevision,7);
  if(attempts===1)throw Object.assign(new Error('SQLITE_BUSY'),{code:'P2034'});
  return buildChapterQualityLoopAssessment(args);
 };
 const result=await projectPipelineChapterQuality(request);
 assert.equal(attempts,2);assert.equal(result.superseded,false);
});
test('failed current-revision assessment keeps metadata intact without an unowned fallback write',async()=>{
 const id='unavailable';seed(id);db.prepare('UPDATE Chapter SET riskFlags=? WHERE id=?').run(freshFlags,id);
 const request=input(id,'off');review.createQualityReport=async()=>{};
 chapterQualityLoopService.recordAssessment=async()=>{throw new Error('storage unavailable');};
 const result=await projectPipelineChapterQuality(request);
 assert.equal(result.superseded,false);
 assert.equal(db.prepare('SELECT riskFlags FROM Chapter WHERE id=?').get(id).riskFlags,freshFlags);
});
