import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';

const deferred = () => { let resolve, reject; const promise = new Promise((a,b) => {resolve=a;reject=b;});return {promise,resolve,reject}; };
const source = fs.readFileSync(new URL('./useSSE.ts', import.meta.url), 'utf8');
const code = ts.transpileModule(source, {compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText;
function mount(fetch, options) {
  const slots=[];let cursor=0;let timerId=0;const timers=new Map();
  const react={
    useState(initial) {const i=cursor++;if (!(i in slots)) slots[i]=initial;return [slots[i],v=>{slots[i]=typeof v==='function'?v(slots[i]):v;}];},
    useRef(initial) {const i=cursor++;return slots[i]??(slots[i]={current:initial});},
    useCallback:fn=>fn, useEffect:()=>{},
  };
  const exports={};
  vm.runInNewContext(code,{exports,require:name=>name==='react'?react:{API_BASE_URL:'/api'},fetch,AbortController,TextDecoder,
    setTimeout:fn=>{const id=++timerId;timers.set(id,fn);return id;},clearTimeout:id=>timers.delete(id),console});
  return {render:()=>{cursor=0;return exports.useSSE(options);},timers};
}
const response = frames => new Response(new ReadableStream({start(c){for(const frame of frames)c.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(frame)}\n\n`));c.close();}}));

test('EOF before terminal frame is a visible interruption, not perpetual streaming', async()=>{
  const hook=mount(async()=>response([{type:'chunk',content:'draft'}]));
  await hook.render().start('/generate',{});
  const state=hook.render();assert.equal(state.content,'draft');assert.equal(state.isStreaming,false);assert.equal(state.isDone,false);assert.ok(state.error);
});

test('old aborted fetch cannot clear the replacement request cancellation handle',async()=>{
  const requests=[];const hook=mount((_url,{signal})=>{const d=deferred();requests.push({...d,signal});return d.promise;});
  const first=hook.render().start('/generate',{});const second=hook.render().start('/generate',{});
  requests[0].reject(new DOMException('aborted','AbortError'));await first;
  hook.render().abort();assert.equal(requests[1].signal.aborted,true);
  requests[1].reject(new DOMException('aborted','AbortError'));await second;
});

test('replacement discards late old frames and completion callbacks',async()=>{
  const firstResponse=deferred();let count=0;const completed=[];
  const hook=mount(()=>++count===1?firstResponse.promise:Promise.resolve(response([{type:'chunk',content:'new'},{type:'done',fullContent:'new'}])),{onDone:text=>completed.push(text)});
  const first=hook.render().start('/generate',{});await hook.render().start('/generate',{});
  firstResponse.resolve(response([{type:'chunk',content:'old'},{type:'done',fullContent:'old'}]));await first;
  assert.equal(hook.render().content,'new');assert.deepEqual(completed,['new']);
});

test('silence deadline covers waiting for response headers',async()=>{
  const hook=mount((_url,{signal})=>new Promise((_resolve,reject)=>signal.addEventListener('abort',()=>reject(new DOMException('aborted','AbortError')))));
  const running=hook.render().start('/generate',{});
  assert.equal(hook.timers.size,1,'deadline must start before fetch resolves');
  [...hook.timers.values()][0]();await running;
  assert.equal(hook.render().isStreaming,false);assert.ok(hook.render().error);assert.equal(hook.timers.size,0);
});

test('terminal completion closes an otherwise open body and awaits completion callback',async()=>{
  let cancelled=false;let finished=false;const callback=deferred();
  const hook=mount(async()=>new Response(new ReadableStream({start(c){c.enqueue(new TextEncoder().encode('data: {"type":"done","fullContent":"ok"}\n\n'));},cancel(){cancelled=true;}})),{onDone:()=>callback.promise});
  const running=hook.render().start('/generate',{}).then(()=>{finished=true;});
  await new Promise(resolve=>setImmediate(resolve));assert.equal(finished,false);assert.equal(hook.timers.size,0);
  callback.resolve();await running;assert.equal(cancelled,true);assert.equal(hook.render().isDone,true);
});

test('completion callback rejection is observed through hook error state',async()=>{
  const hook=mount(async()=>response([{type:'done',fullContent:'ok'}]),{onDone:async()=>{throw Error('refresh failed');}});
  await hook.render().start('/generate',{});assert.equal(hook.render().isStreaming,false);assert.ok(hook.render().error);
});

test('completion callback can reject stale UI mutations after a newer request starts',async()=>{
  const refresh=deferred();const secondResponse=deferred();let calls=0;let active='A';
  const hook=mount(()=>++calls===1?Promise.resolve(response([{type:'done',fullContent:'A'}])):secondResponse.promise,{
    onDone:async(_text,request)=>{await refresh.promise;if(request?.isCurrent()===false)return;active=null;},
  });
  const first=hook.render().start('/generate',{});await new Promise(resolve=>setImmediate(resolve));
  active='B';const second=hook.render().start('/generate',{});refresh.resolve();await first;
  assert.equal(active,'B','old completion refresh must not clear the new active chapter');
  hook.render().abort();secondResponse.resolve(response([]));await second;
});
