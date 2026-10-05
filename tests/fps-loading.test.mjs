import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {assetLoading,declareAsset,fetchAssetBuffer,loadGLTF,trackTask,invalidateAsset} from '../games/freight-fire/asset-loading.js';

const address=name=>`https://loading.test/${name}`;
const record=url=>assetLoading.snapshot.assets.find(asset=>asset.url===url);
const bytes=n=>new Uint8Array(n).fill(7);

test('progress counts actual decoded bytes rather than gzip Content-Length',async()=>{
  const url=address('gzip.glb');declareAsset(url,{bytes:16,label:'压缩模型'});
  const response=new Response(new ReadableStream({start(controller){controller.enqueue(bytes(8));setTimeout(()=>{controller.enqueue(bytes(8));controller.close();},150);}}),{headers:{'Content-Length':'3','Content-Encoding':'gzip'}});
  const progress=[],unsubscribe=assetLoading.subscribe(state=>progress.push(state.assets.find(asset=>asset.url===url)));
  const result=await fetchAssetBuffer(url,{fetchImpl:async()=>response});unsubscribe();
  assert.equal(result.byteLength,16);assert.equal(record(url).totalBytes,16);assert.equal(record(url).loadedBytes,16);
  assert(progress.some(asset=>asset.loadedBytes===8&&asset.totalBytes===16));assert.equal(record(url).status,'ready');
});

test('HTTP errors retain the concrete asset URL and a later retry can succeed',async()=>{
  const url=address('not-found.glb');let requests=0;
  await assert.rejects(fetchAssetBuffer(url,{label:'狙击枪',bytes:4,fetchImpl:async()=>{requests++;return new Response('',{status:404});}}),error=>error.url===url&&error.code==='http-error'&&error.message.includes('狙击枪')&&error.retryable===false);
  assert.equal(requests,1);assert.equal(record(url).status,'error');assetLoading.resetFailed();
  const result=await fetchAssetBuffer(url,{fetchImpl:async()=>new Response(bytes(4))});assert.equal(result.byteLength,4);assert.equal(record(url).status,'ready');
});

test('a stalled response terminates and explains the stalled asset',async()=>{
  const url=address('stalled.glb');
  const response=new Response(new ReadableStream({start(controller){controller.enqueue(bytes(2));}}));
  await assert.rejects(fetchAssetBuffer(url,{label:'人物模型',bytes:4,idleTimeoutMs:25,retries:0,fetchImpl:async()=>response}),error=>error.url===url&&error.code==='network-stall'&&error.phase==='download');
  assert.equal(record(url).status,'error');assert.equal(record(url).loadedBytes,2);
});

test('truncated files never report ready and retry has a finite bound',async()=>{
  const url=address('truncated.glb');let requests=0;
  await assert.rejects(fetchAssetBuffer(url,{bytes:8,retries:1,fetchImpl:async()=>{requests++;return new Response(bytes(4));}}),error=>error.code==='size-mismatch'&&error.attempt===2);
  assert.equal(requests,2);assert.equal(record(url).status,'error');
});

test('GLB decode timeout is separate from download and successful bytes are reused',async()=>{
  const url=address('decode.glb');let requests=0;
  await assert.rejects(loadGLTF({parseAsync:()=>new Promise(()=>{})},url,{bytes:12,parseTimeoutMs:25,fetchImpl:async()=>{requests++;return new Response(bytes(12));}}),error=>error.code==='parse-timeout'&&error.phase==='parse'&&error.url===url);
  assert.equal(record(url).status,'error');assert.equal(record(url).loadedBytes,12);assetLoading.resetFailed();
  const parsed=await loadGLTF({parseAsync:async(buffer,base)=>({size:buffer.byteLength,base})},url,{bytes:12,fetchImpl:async()=>{requests++;throw Error('Downloaded bytes should have been cached');}});
  assert.equal(parsed.size,12);assert.equal(parsed.base,'https://loading.test/');assert.equal(requests,1);assert.equal(record(url).status,'ready');
});

test('correct-size corrupt GLB is downloaded again after a user retry',async()=>{
  const url=address('corrupt.glb'),requests=[];
  const fetchImpl=async(_,options)=>{requests.push(options.cache);return new Response(new Uint8Array([requests.length===1?0:103,108,84,70]));};
  const loader={parseAsync:async buffer=>{if(new Uint8Array(buffer)[0]!==103)throw Error('Invalid GLB magic');return {ok:true};}};
  await assert.rejects(loadGLTF(loader,url,{bytes:4,fetchImpl}),error=>error.code==='parse-error'&&error.phase==='parse');
  assert.equal(record(url).errorCode,'parse-error');assetLoading.resetFailed();
  assert.deepEqual(await loadGLTF(loader,url,{bytes:4,fetchImpl}),{ok:true});assert.deepEqual(requests,['default','reload']);
});

test('correct-size invalid JSON refreshes the cached response after retry',async()=>{
  const url=address('corrupt.json'),requests=[];
  const fetchImpl=async(_,options)=>{requests.push(options.cache);return new Response(requests.length===1?'!x':'{}');};
  const parse=async()=>{const buffer=await fetchAssetBuffer(url,{bytes:2,fetchImpl,deferReady:true});return trackTask(url,{phase:'parse'},()=>JSON.parse(new TextDecoder().decode(buffer)));};
  await assert.rejects(parse(),error=>error.code==='parse-error'&&error.phase==='parse');assetLoading.resetFailed();
  assert.deepEqual(await parse(),{});assert.deepEqual(requests,['default','reload']);
});

test('a separate decoder task can invalidate its original response URL',async()=>{
  const url=address('corrupt.mp3'),requests=[];
  const fetchImpl=async(_,options)=>{requests.push(options.cache);return new Response(bytes(3));};
  await fetchAssetBuffer(url,{critical:false,bytes:3,fetchImpl});
  await assert.rejects(trackTask(url+'?decode',{critical:false,phase:'decode'},()=>{throw Error('Invalid sample');}),error=>error.code==='decode-error'&&error.phase==='decode');
  invalidateAsset(url);await fetchAssetBuffer(url,{critical:false,bytes:3,fetchImpl});assert.deepEqual(requests,['default','reload']);
});

test('noncritical failures remain inspectable without blocking core readiness',async()=>{
  const url=address('optional.mp3'),totalBefore=assetLoading.snapshot.total;
  await assert.rejects(fetchAssetBuffer(url,{critical:false,group:'audio',fetchImpl:async()=>new Response('',{status:404})}));
  assert.equal(assetLoading.snapshot.total,totalBefore);assert(assetLoading.snapshot.failed.some(asset=>asset.url===url&&!asset.critical));
  const task=address('map-build');await trackTask(task,{label:'构建地图',critical:false,phase:'prepare'},async()=>42);assert.equal(record(task).status,'ready');
});

test('asset download concurrency stays bounded',async()=>{
  let active=0,peak=0;await Promise.all(Array.from({length:8},(_,index)=>fetchAssetBuffer(address(`parallel-${index}`),{critical:false,bytes:3,fetchImpl:async()=>{
    active++;peak=Math.max(peak,active);await new Promise(resolve=>setTimeout(resolve,15));active--;return new Response(bytes(3));
  }})));assert.equal(peak,3);
});

test('all 11 declared GLB byte counts match the bundled assets',async()=>{
  for(const relative of ['viewmodel-cs2.js','character-v2.js']){
    const source=await fs.readFile(new URL(`../games/freight-fire/${relative}`,import.meta.url),'utf8'),folder=relative==='viewmodel-cs2.js'?'viewmodel-cs2':'characters-cs2';
    const declarations=[...source.matchAll(/\['([^']+)',(\d+),'[^']+'\]/g)];assert.equal(declarations.length,relative==='viewmodel-cs2.js'?8:3);
    for(const [,name,size]of declarations){const filename=name.endsWith('.glb')?name:name+'.glb',stat=await fs.stat(new URL(`../games/freight-fire/assets/${folder}/${filename}`,import.meta.url));assert.equal(stat.size,Number(size),filename);}
  }
});
