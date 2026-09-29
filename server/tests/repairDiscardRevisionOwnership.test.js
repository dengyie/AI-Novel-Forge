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

db.exec(`CREATE TABLE Novel (id TEXT PRIMARY KEY, storyWorldSliceJson TEXT, storyWorldSliceOverridesJson TEXT);
 INSERT INTO Novel (id) VALUES ('novel');`);
const {ChapterRepairFinalizer}=require('../dist/services/novel/runtime/repair/application/ChapterRepairFinalizer.js');
const score={overall:70,coherence:70,pacing:70,repetition:70,engagement:70,voice:70};
const freshFlags=JSON.stringify({jitPlanning:{factFingerprint:'new'},qualityLoop:{status:'passed'}});
test.after(async()=>{await prisma.$disconnect();db.close();fs.rmSync(directory,{recursive:true});});
for(const concurrentSave of [true,false])test(`discard owns history and feedback revision (concurrent save=${concurrentSave})`,async()=>{
 const id=`repair-${concurrentSave}`;
 db.prepare('INSERT INTO Chapter (id,novelId,title,content,contentRevision,"order",generationState,chapterStatus,riskFlags,repairHistory,targetWordCount) VALUES (?,?,?,?,7,1,?,?,?,?,3000)').run(id,'novel','章','基线正文。','reviewed','needs_repair','{}','baseline history');
 const frames=[];let reviews=0;
 const finalizer=new ChapterRepairFinalizer({
  contentCommitService:{commit:async()=>{throw new Error('short candidate must not commit');}},
  artifactSyncService:{syncChapterArtifacts:async()=>{}},
  reviewChapterAfterRepair:async()=>{
   reviews++;
   if(reviews===2 && concurrentSave) db.prepare('UPDATE Chapter SET content=?,contentRevision=8,chapterStatus=?,riskFlags=?,repairHistory=? WHERE id=?').run('新正文。','completed',freshFlags,'new history',id);
   return {score,issues:[]};
  },
 });
 await finalizer.finalize({novelId:'novel',chapterId:id,baselineContentRevision:7,options:{},content:'短候选。',helpers:{writeFrame:frame=>frames.push(frame)}});
 const row=db.prepare('SELECT * FROM Chapter WHERE id=?').get(id);
 if(concurrentSave){
  assert.equal(row.repairHistory,'new history');assert.equal(row.riskFlags,freshFlags);assert.equal(row.chapterStatus,'completed');
  assert.equal(frames.at(-1).status,'failed');
 } else {
  assert.match(row.repairHistory,/decision=discard/);assert.ok(JSON.parse(row.riskFlags).qualityLoop.feedback.length);assert.equal(frames.at(-1).status,'succeeded');
 }
});

test('feedback persistence failure cannot leave a partial discard history',async()=>{
 const id='repair-storage-failure';
 db.prepare('INSERT INTO Chapter (id,novelId,title,content,contentRevision,"order",generationState,chapterStatus,riskFlags,repairHistory,targetWordCount) VALUES (?,?,?,?,7,1,?,?,?,?,3000)').run(id,'novel','章','基线正文。','reviewed','needs_repair','{}','baseline history');
 db.exec(`CREATE TRIGGER fail_feedback BEFORE UPDATE OF riskFlags ON Chapter WHEN NEW.id='repair-storage-failure' BEGIN SELECT RAISE(ABORT, 'feedback unavailable'); END;`);
 const finalizer=new ChapterRepairFinalizer({contentCommitService:{commit:async()=>{throw new Error('must discard');}},artifactSyncService:{syncChapterArtifacts:async()=>{}},reviewChapterAfterRepair:async()=>({score,issues:[]})});
 await assert.rejects(finalizer.finalize({novelId:'novel',chapterId:id,baselineContentRevision:7,options:{},content:'短候选。',helpers:{writeFrame:()=>{}}}));
 const row=db.prepare('SELECT repairHistory,riskFlags FROM Chapter WHERE id=?').get(id);
 assert.equal(row.repairHistory,'baseline history');assert.equal(row.riskFlags,'{}');
});
