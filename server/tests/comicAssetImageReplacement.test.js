const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs/promises');
const os=require('node:os');
const path=require('node:path');
const {prisma}=require('../dist/db/prisma');
const {comicCharacterAssetService:service}=require('../dist/services/comic/ComicCharacterAssetService');
function patch(t,o,k,v){const old=o[k];o[k]=v;t.after(()=>o[k]=old);}
async function fixture(t){
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'asset-replace-'));const env=process.env.AI_NOVEL_APP_DATA_DIR;process.env.AI_NOVEL_APP_DATA_DIR=root;
 t.after(async()=>{if(env===undefined)delete process.env.AI_NOVEL_APP_DATA_DIR;else process.env.AI_NOVEL_APP_DATA_DIR=env;await fs.rm(root,{recursive:true,force:true});});
 const dir=path.join(root,'storage/generated-images/comic-character-assets/id');await fs.mkdir(dir,{recursive:true});
 let state={id:'id',imageData:JSON.stringify({status:'done',origin:'uploaded'})};
 patch(t,service,'getAsset',async()=>state);
 patch(t,prisma.comicCharacterAsset,'findUnique',async()=>state);
 patch(t,prisma.comicCharacterAsset,'update',async({data})=>(state={...state,...data}));
 patch(t,prisma,'$transaction',async cb=>cb(prisma));
 return{dir,state:()=>state};
}
test('PNG to JPEG replacement serves newly uploaded bytes and removes superseded files',async t=>{
 const f=await fixture(t);await fs.writeFile(path.join(f.dir,'asset.png'),'old-png');
 await service.uploadAssetImage('id',Buffer.from('new-jpeg'),'image/jpeg');
 const result=await service.serveAssetImage('id');assert.equal(result.mimeType,'image/jpeg');assert.equal(await fs.readFile(result.filePath,'utf8'),'new-jpeg');
 assert.equal((await fs.readdir(f.dir)).length,1);
});
for(const mime of ['image/png','image/jpeg'])test(`${mime}: database publication failure preserves previous image`,async t=>{
 const f=await fixture(t);await fs.writeFile(path.join(f.dir,'asset.png'),'old-png');
 patch(t,prisma.comicCharacterAsset,'update',async()=>{throw Error('DB unavailable');});
 await assert.rejects(service.uploadAssetImage('id',Buffer.from('new-image'),mime),/DB unavailable/);
 const result=await service.serveAssetImage('id');assert.equal(await fs.readFile(result.filePath,'utf8'),'old-png');assert.deepEqual(await fs.readdir(f.dir),['asset.png']);
});
test('partial candidate write failure preserves previous image and cleans the candidate',async t=>{
 const f=await fixture(t);await fs.writeFile(path.join(f.dir,'asset.png'),'old-png');
 const write=fs.writeFile;patch(t,fs,'writeFile',async(file)=>{await write(file,'partial');throw Error('disk full');});
 await assert.rejects(service.uploadAssetImage('id',Buffer.from('new-image'),'image/png'),/disk full/);
 const result=await service.serveAssetImage('id');assert.equal(await fs.readFile(result.filePath,'utf8'),'old-png');assert.deepEqual(await fs.readdir(f.dir),['asset.png']);
});

test('generation publishes its new format after upload and a failed generation retains current image',async t=>{
 const f=await fixture(t);
 patch(t,prisma.comicCharacterAsset,'findUnique',async()=>({...f.state(),assetType:'item',name:'Item',characterId:'char',character:{id:'char',name:'Character',gender:'unknown',visualAnchor:'',sheetData:null},project:{stylePreset:null}}));
 patch(t,prisma.comicCharacter,'findUnique',async()=>null);
 await service.uploadAssetImage('id',Buffer.from('upload'),'image/png');
 const ctx=await service.buildAssetGenerationContext('id');
 const filePath=ctx.adapter.diskPath('webp');await fs.writeFile(filePath,'generated-webp');
 await ctx.adapter.saveState({status:'done',origin:'generated'});
 const result=await service.serveAssetImage('id');assert.equal(result.mimeType,'image/webp');assert.equal(await fs.readFile(result.filePath,'utf8'),'generated-webp');
 assert.equal((await fs.readdir(f.dir)).length,1);
 const failed=await service.buildAssetGenerationContext('id');
 const partial=failed.adapter.diskPath('png');await fs.writeFile(partial,'partial');
 await service.uploadAssetImage('id',Buffer.from('newer-upload'),'image/jpeg');
 await failed.adapter.saveState({status:'error',origin:'generated',error:'provider failed'});
 const preserved=await service.serveAssetImage('id');assert.equal(await fs.readFile(preserved.filePath,'utf8'),'newer-upload');
 assert.equal((await fs.readdir(f.dir)).length,1);
});
