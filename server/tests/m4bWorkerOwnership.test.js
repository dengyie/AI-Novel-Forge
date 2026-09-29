const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { prisma } = require('../dist/db/prisma.js');
const { M4bJobQueueService } = require('../dist/services/audiobook/m4b/M4bJobQueueService.js');
const { M4bWorkerManager } = require('../dist/services/audiobook/m4b/M4bWorkerManager.js');
const { withQueueLock } = require('./helpers/m4bQueueTestLock.js');
const queue = new M4bJobQueueService();
async function waitFor(predicate, timeout=8000) {
  const end=Date.now()+timeout;
  while(Date.now()<end) { if(await predicate()) return; await new Promise(r=>setTimeout(r,20)); }
  throw new Error('condition timed out');
}
async function fixture(run) {
  return withQueueLock(async()=>{
    const dir=fs.mkdtempSync(path.join(os.tmpdir(),'m4b-ownership-'));
    const novel=await prisma.novel.create({data:{title:'m4b ownership fixture'}});
    const task=await prisma.audiobookTask.create({data:{novelId:novel.id,title:'fixture',scopeMode:'full',narratorVoice:'test',narratorStyle:'neutral',status:'succeeded',m4bGenerationToken:'generation-a'}});
    const input=path.join(dir,'input.wav'), output=path.join(dir,'full-book.m4b'), part=path.join(dir,'part');
    fs.writeFileSync(input,Buffer.alloc(128));fs.writeFileSync(part,'old-generation');
    const params={audiobookTaskId:task.id,generationToken:'generation-a',inputWavPath:input,outputM4bPath:output,metadataJson:JSON.stringify({title:'fixture',chapters:[]})};
    const job=await queue.createJob(params);
    try { await run({dir,task,job,params,part,output}); }
    finally { await prisma.novel.delete({where:{id:novel.id}});fs.rmSync(dir,{recursive:true,force:true}); }
  });
}
function fakeFfmpeg(dir) {
  const entry=path.join(dir,'fake-ffmpeg.js');
  fs.writeFileSync(entry,`#!${process.execPath}\nconst fs=require('node:fs');\nconst child=require('node:child_process').spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});\nfs.writeFileSync(process.env.FAKE_PID_FILE,JSON.stringify([process.pid,child.pid]));\nconst output=process.argv.at(-1);fs.writeFileSync(output,Buffer.alloc(128));\nconst timer=setInterval(()=>fs.appendFileSync(output,Buffer.alloc(32)),20);\nsetTimeout(()=>{clearInterval(timer);child.kill();process.exit(0);},Number(process.env.FAKE_DURATION_MS)||50);\n`,{mode:0o755});
  return entry;
}
function alive(pid) { try { process.kill(pid,0);return true; } catch {return false;} }
function launchWorker(env) {
  const worker=spawn(process.execPath,[path.resolve(__dirname,'../dist/workers/m4b-worker.js')],{env:{...process.env,...env},stdio:'pipe'});
  let stderr='';worker.stderr.on('data',b=>stderr+=b);
  worker.done=new Promise((resolve,reject)=>{worker.once('error',reject);worker.once('exit',(code)=>code===0?resolve():reject(new Error(stderr||`exit ${code}`)));});
  return worker;
}

test('late generation and revoked lease cannot publish or settle new job',()=>fixture(async({task,params,part,output})=>{
  const old=await queue.claimNextJob('1001');
  await prisma.audiobookTask.update({where:{id:task.id},data:{m4bGenerationToken:'generation-b'}});
  fs.writeFileSync(output,'new-generation');
  await queue.requeueJobForTask({...params,generationToken:'generation-b'});
  const current=await queue.claimNextJob('1002');
  await assert.rejects(queue.requeueJobForTask(params),/generation/);
  await assert.rejects(queue.createJob(params),/generation/);
  assert.equal((await prisma.m4bEncodingJob.findUnique({where:{id:old.id}})).leaseToken,current.leaseToken);
  await assert.rejects(queue.publish(old,part),/generation/);
  await queue.markFailed(old,'late failure'); await queue.updateProgress(old,90); await queue.resetJob(old);
  assert.equal(fs.readFileSync(output,'utf8'),'new-generation');
  assert.equal((await prisma.m4bEncodingJob.findUnique({where:{id:old.id}})).leaseToken,current.leaseToken);
  assert.equal((await prisma.m4bEncodingJob.findUnique({where:{id:old.id}})).status,'processing');
  await queue.resetJob(current);const next=await queue.claimNextJob('1002');
  await assert.rejects(queue.publish(current,part),/lease/);
  assert.notEqual(next.leaseToken,current.leaseToken);
}));

test('healthy old claim is not stalled; only lack of audio growth expires',()=>fixture(async()=>{
  const job=await queue.claimNextJob('1001');
  const old=new Date(Date.now()-300000);
  await prisma.m4bEncodingJob.update({where:{id:job.id},data:{workerStartedAt:old,lastProgressAt:old}});
  await queue.updateProgress(job,95);
  assert.equal((await queue.getStalledJobs(120000)).some(x=>x.id===job.id),false);
  await prisma.m4bEncodingJob.update({where:{id:job.id},data:{lastProgressAt:old}});
  assert.equal((await queue.getStalledJobs(120000)).some(x=>x.id===job.id),true);
}));

test('manager launches real worker and publishes audio',{skip:process.platform==='win32'?'fake ffmpeg executable uses POSIX shebang':false},()=>fixture(async({dir,job,output})=>{
  fs.writeFileSync(output,Buffer.alloc(128,65));
  const saved={...process.env}; const manager=new M4bWorkerManager();
  Object.assign(process.env,{AUDIOBOOK_FFMPEG_PATH:fakeFfmpeg(dir),FAKE_PID_FILE:path.join(dir,'pids'),M4B_WORKER_IDLE_TIMEOUT_MS:'100'});
  try {
    await manager.ensureWorkerForPendingJobs();
    await waitFor(async()=> (await prisma.m4bEncodingJob.findUnique({where:{id:job.id}})).status==='completed');
    assert.ok(fs.statSync(output).size>=128);
    assert.equal(fs.readFileSync(output)[0],0,"pre-existing audio must not bypass current generation encoding");
    await waitFor(()=>manager.activeWorkers.size===0);
  } finally { await manager.shutdown();process.env=saved; }
}));

for(const mode of ['generation','SIGTERM']) test(`real worker ${mode} abort terminates ffmpeg process group`,{skip:process.platform==='win32'?'fake ffmpeg executable uses POSIX shebang':false},()=>fixture(async({dir,task,output})=>{
  const pidFile=path.join(dir,'pids');
  const worker=launchWorker({AUDIOBOOK_FFMPEG_PATH:fakeFfmpeg(dir),FAKE_PID_FILE:pidFile,FAKE_DURATION_MS:'30000',M4B_WORKER_IDLE_TIMEOUT_MS:'100'});
  let pids=[];
  try {
    await waitFor(()=>fs.existsSync(pidFile));pids=JSON.parse(fs.readFileSync(pidFile));
    if(mode==='generation') await prisma.audiobookTask.update({where:{id:task.id},data:{m4bGenerationToken:'generation-b'}});
    else worker.kill('SIGTERM');
    await worker.done;
    await waitFor(()=>pids.every(pid=>!alive(pid)));
    assert.equal(fs.existsSync(output),false);
  } finally { worker.kill('SIGTERM'); for(const pid of pids){try{process.kill(pid,'SIGKILL');}catch{}} }
}));

test('cross-process rotation waits for transaction-protected publication',()=>fixture(async({dir,task,job,part,output})=>{
  const claimed=await queue.claimNextJob('1001');
  const marker=path.join(dir,'publishing');
  const servicePath=path.resolve(__dirname,'../dist/services/audiobook/m4b/M4bJobQueueService.js');
  const dbPath=path.resolve(__dirname,'../dist/db/prisma.js');
  const script=`const fs=require('node:fs');const {prisma}=require(${JSON.stringify(dbPath)});const {M4bJobQueueService}=require(${JSON.stringify(servicePath)});(async()=>{const job=await prisma.m4bEncodingJob.findUnique({where:{id:${JSON.stringify(job.id)}}});const rename=fs.renameSync;fs.renameSync=(a,b)=>{fs.writeFileSync(${JSON.stringify(marker)},'locked');Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,500);return rename(a,b);};await new M4bJobQueueService().publish(job,${JSON.stringify(part)});await prisma.$disconnect();})().catch(e=>{console.error(e);process.exit(1)});`;
  const child=spawn(process.execPath,['-e',script],{env:process.env,stdio:'pipe'});
  let errors='';child.stderr.on('data',b=>errors+=b);
  const done=new Promise((resolve,reject)=>child.on('exit',code=>code===0?resolve():reject(new Error(errors))));
  await waitFor(()=>fs.existsSync(marker));
  await prisma.audiobookTask.update({where:{id:task.id},data:{m4bGenerationToken:'generation-b'}});
  // Mirrors generation rotation: after the durable change, wipe old canonical output.
  fs.rmSync(output,{force:true});
  await done;
  assert.equal(fs.existsSync(output),false,'old publisher must never run after generation wipe');
  assert.equal((await prisma.m4bEncodingJob.findUnique({where:{id:claimed.id}})).status,'completed');
}));

test('SIGKILL worker exit cleans its reported ffmpeg group before requeue',
  {skip:process.platform==='win32'?'POSIX process groups; Windows uses verified taskkill tree':false},
  ()=>fixture(async({dir,job})=>{
    const saved={...process.env};const manager=new M4bWorkerManager();
    const pidFile=path.join(dir,'pids');
    Object.assign(process.env,{AUDIOBOOK_FFMPEG_PATH:fakeFfmpeg(dir),FAKE_PID_FILE:pidFile,FAKE_DURATION_MS:'30000',M4B_WORKER_IDLE_TIMEOUT_MS:'100'});
    let pids=[];
    try {
      await manager.ensureWorkerForPendingJobs();
      await waitFor(()=>fs.existsSync(pidFile)&&manager.ownedProcesses.size===1);
      pids=JSON.parse(fs.readFileSync(pidFile));
      const original=manager.queueService.recoverJobsForWorker.bind(manager.queueService);
      manager.queueService.recoverJobsForWorker=async workerId=>{
        assert.equal(pids.some(alive),false,"production cleanup must precede requeue");
        return original(workerId);
      };
      const worker=[...manager.activeWorkers.values()][0];worker.kill('SIGKILL');
      await waitFor(async()=> (await prisma.m4bEncodingJob.findUnique({where:{id:job.id}})).status==='pending');
      const current=await prisma.m4bEncodingJob.findUnique({where:{id:job.id}});
      assert.equal(current.retryCount,1);assert.equal(current.leaseToken,null);
      assert.equal(pids.some(alive),false);
    } finally { await manager.shutdown();process.env=saved;for(const pid of pids){try{process.kill(pid,'SIGKILL');}catch{}} }
  }));

test('encoding core cannot bypass a revoked publisher',
  {skip:process.platform==='win32'?'fake ffmpeg executable uses POSIX shebang':false},
  ()=>fixture(async({dir,params,output})=>{
    const saved={...process.env};
    Object.assign(process.env,{AUDIOBOOK_FFMPEG_PATH:fakeFfmpeg(dir),FAKE_PID_FILE:path.join(dir,'pids')});
    try {
      const {executeM4bEncoding}=require('../dist/services/audiobook/m4b/M4bEncodingCore.js');
      const result=await executeM4bEncoding({sourceWavPath:params.inputWavPath,outputM4bPath:output,
        bookTitle:'fixture',chapters:[],publish:async()=>{throw new Error('generation revoked');}});
      assert.equal(result.success,false);assert.match(result.error,/generation revoked/);
      assert.equal(fs.existsSync(output),false);
      assert.equal(fs.readdirSync(dir).some(name=>name.endsWith('.part')),false);
    } finally {process.env=saved;}
  }));
