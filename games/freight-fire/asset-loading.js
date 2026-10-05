// Byte counts are decoded response-body bytes. A gzipped Content-Length is
// smaller and must never be used as the denominator for GLB download progress.
const records=new Map(),listeners=new Set(),buffers=new Map(),models=new Map(),tasks=new Map();
const clock=()=>globalThis.performance?.now?.()??Date.now();
const absolute=value=>new URL(value,import.meta.url).href;
const positive=value=>Number.isFinite(value)&&value>0?value:0;
let lastNotice=0,noticeTimer;

export class AssetLoadError extends Error {
  constructor(message,{url,label,code='asset-error',phase='download',attempt=1,retryable=true,cause}={}) {
    super(`${label||url||'资源'}：${message}`,{cause});this.name='AssetLoadError';
    Object.assign(this,{url,label,code,phase,attempt,retryable});
  }
}

function snapshot() {
  const assets=[...records.values()].map(record=>({...record})),required=assets.filter(record=>record.critical);
  const loadedBytes=required.reduce((sum,record)=>sum+record.loadedBytes,0),totalBytes=required.reduce((sum,record)=>sum+record.totalBytes,0);
  const active=assets.filter(record=>['downloading','parsing','retrying'].includes(record.status));
  const failed=assets.filter(record=>record.status==='error'),completed=required.filter(record=>record.status==='ready').length;
  const stalled=active.filter(record=>record.status==='downloading'&&clock()-record.updatedAt>5000);
  const state=failed.some(record=>record.critical)?'error':required.length&&completed===required.length?'ready':active.length?'loading':'queued';
  return {state,loadedBytes,totalBytes,ratio:totalBytes?Math.min(1,loadedBytes/totalBytes):0,completed,total:required.length,
    active,failed,stalled,assets,current:active.filter(record=>record.critical).sort((a,b)=>b.updatedAt-a.updatedAt)[0]||null};
}
function notify(force=false) {
  if(force||clock()-lastNotice>=100){clearTimeout(noticeTimer);noticeTimer=undefined;lastNotice=clock();const state=snapshot();for(const listener of listeners)try{listener(state);}catch(error){console.error('Asset progress listener failed',error);}}
  else if(!noticeTimer)noticeTimer=setTimeout(()=>notify(true),100);
}
function update(record,values) {Object.assign(record,values,{updatedAt:clock()});notify();}
export function declareAsset(value,{label,bytes=0,group='models',critical=true,required=critical}={}) {
  const url=absolute(value),old=records.get(url);
  if(old){if(label)old.label=label;if(bytes>0&&!old.totalBytes)old.totalBytes=bytes;notify();return old;}
  const record={url,label:label||new URL(url).pathname.split('/').pop(),group,critical:required!==false,
    loadedBytes:0,totalBytes:positive(bytes),status:'queued',phase:'download',attempt:0,error:null,errorCode:null,reloadCache:false,startedAt:0,updatedAt:clock()};
  records.set(url,record);notify();return record;
}
export const assetLoading=Object.freeze({
  get snapshot(){return snapshot();},
  subscribe(listener){listeners.add(listener);listener(snapshot());return()=>listeners.delete(listener);},
  resetFailed({criticalOnly=true}={}){for(const record of records.values())if(record.status==='error'&&(!criticalOnly||record.critical)){
    // A body can have the expected length and still contain corrupt JSON, GLB
    // or image data. Re-fetch these failures rather than repeatedly parsing the
    // same bytes. A processing timeout alone does not prove the body is bad.
    if(['parse','decode'].includes(record.phase)&&record.errorCode!=='parse-timeout'){buffers.delete(record.url);record.reloadCache=true;}
    models.delete(record.url);tasks.delete(record.url);update(record,{status:'queued',phase:'download',error:null,errorCode:null,attempt:0,loadedBytes:0});
  }notify(true);},
});

// Decoders with a separate task URL (for example audio.mp3?decode) can invalidate
// the actual response URL after proving that its cached body cannot be decoded.
export function invalidateAsset(value,{reload=true}={}) {
  const url=absolute(value);buffers.delete(url);models.delete(url);tasks.delete(url);
  const record=records.get(url);if(record)update(record,{status:'queued',phase:'download',loadedBytes:0,error:null,errorCode:null,reloadCache:reload});
}

function queue(limit) {
  let running=0,order=0;const pending=[];
  function next(){pending.sort((a,b)=>a.priority-b.priority||a.order-b.order);while(running<limit&&pending.length){const job=pending.shift();running++;Promise.resolve().then(job.run).then(job.resolve,job.reject).finally(()=>{running--;next();});}}
  return(run,priority=0)=>new Promise((resolve,reject)=>{pending.push({run,priority,order:order++,resolve,reject});next();});
}
const fetchQueue=queue(3),modelQueue=queue(2),parseQueue=queue(1);
const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
function asAssetError(error,record,phase,attempt) {
  const code=phase==='download'?'network-error':phase==='parse'?'parse-error':phase==='decode'?'decode-error':'prepare-error';
  return error instanceof AssetLoadError?error:new AssetLoadError(error?.message||String(error),{url:record.url,label:record.label,code,phase,attempt,cause:error});
}

async function readAttempt(record,{idleTimeoutMs=20000,fetchImpl=globalThis.fetch,attempt,cache}={}) {
  const controller=new AbortController();let timer,rejectDeadline;
  const deadline=new Promise((_,reject)=>{rejectDeadline=reject;});
  const resetDeadline=()=>{clearTimeout(timer);timer=setTimeout(()=>{
    const error=new AssetLoadError(`网络连续 ${Math.round(idleTimeoutMs/1000)} 秒没有收到数据`,{url:record.url,label:record.label,code:'network-stall',phase:'download',attempt});
    rejectDeadline(error);controller.abort(error);
  },idleTimeoutMs);};
  update(record,{status:'downloading',phase:'download',attempt,loadedBytes:0,error:null,errorCode:null,startedAt:clock()});resetDeadline();
  let reader;
  try {
    const response=await Promise.race([fetchImpl(record.url,{signal:controller.signal,cache:cache||'default'}),deadline]);resetDeadline();
    if(!response.ok)throw new AssetLoadError(`HTTP ${response.status}`,{url:record.url,label:record.label,code:'http-error',phase:'download',attempt,retryable:response.status===408||response.status===429||response.status>=500});
    const declaredBytes=record.totalBytes;
    const encoding=response.headers.get('content-encoding');
    if(!declaredBytes&&(!encoding||encoding==='identity'))update(record,{totalBytes:positive(Number(response.headers.get('content-length')))});
    let data;
    if(response.body?.getReader) {
      reader=response.body.getReader();const chunks=[];let size=0;
      while(true){const {done,value}=await Promise.race([reader.read(),deadline]);if(done)break;resetDeadline();chunks.push(value);size+=value.byteLength;update(record,{loadedBytes:size});}
      const joined=new Uint8Array(size);let offset=0;for(const chunk of chunks){joined.set(chunk,offset);offset+=chunk.byteLength;}data=joined.buffer;
    } else {
      data=await Promise.race([response.arrayBuffer(),deadline]);update(record,{loadedBytes:data.byteLength});
    }
    // Local manifest sizes detect truncated GLBs even when the server supplied
    // a compressed transfer length. A retry bypasses an incomplete HTTP cache.
    if(declaredBytes&&data.byteLength!==declaredBytes)throw new AssetLoadError(`文件不完整（${data.byteLength} / ${declaredBytes} 字节）`,{url:record.url,label:record.label,code:'size-mismatch',phase:'download',attempt});
    update(record,{loadedBytes:data.byteLength,totalBytes:declaredBytes||data.byteLength,reloadCache:false});return data;
  } catch(error) {
    controller.abort();if(reader)reader.cancel().catch(()=>{});throw asAssetError(error,record,'download',attempt);
  } finally {clearTimeout(timer);}
}

export function fetchAssetBuffer(value,options={}) {
  const record=declareAsset(value,options),old=buffers.get(record.url);if(old)return old;
  const {retries=2,priority=record.critical?0:10}=options;
  const promise=fetchQueue(async()=>{
    for(let attempt=1;attempt<=retries+1;attempt++) {
      try{const data=await readAttempt(record,{...options,attempt,cache:attempt>1||record.reloadCache?'reload':options.cache});if(!options.deferReady)update(record,{status:'ready',phase:'ready',errorCode:null});return data;}
      catch(error){if(!error.retryable||attempt>retries){update(record,{status:'error',error:error.message,errorCode:error.code});notify(true);throw error;}
        update(record,{status:'retrying',error:error.message,errorCode:error.code,loadedBytes:0});await pause(Math.min(2000,400*attempt));}
    }
  },priority);
  buffers.set(record.url,promise);promise.catch(()=>{if(buffers.get(record.url)===promise)buffers.delete(record.url);});return promise;
}
export const loadAssetBuffer=fetchAssetBuffer;

function timeoutTask(run,record,timeoutMs) {
  let timer;return Promise.race([Promise.resolve().then(run),new Promise((_,reject)=>{timer=setTimeout(()=>reject(new AssetLoadError(`处理超过 ${Math.round(timeoutMs/1000)} 秒，请重试`,{url:record.url,label:record.label,code:'parse-timeout',phase:record.phase,attempt:record.attempt})),timeoutMs);})]).finally(()=>clearTimeout(timer));
}
export function loadGLTF(loader,value,options={}) {
  const record=declareAsset(value,options),old=models.get(record.url);if(old)return old;
  const promise=modelQueue(async()=>{
    try {
      const buffer=await fetchAssetBuffer(record.url,{...options,deferReady:true});
      // Downloads waiting for the single decoder are not stalled transfers.
      update(record,{status:'queued',phase:'parse',loadedBytes:buffer.byteLength,error:null,errorCode:null});
      const source=await parseQueue(async()=>{
        update(record,{status:'parsing',phase:'parse',loadedBytes:buffer.byteLength,error:null,errorCode:null});
        return timeoutTask(()=>loader.parseAsync(buffer,new URL('./',record.url).href),record,options.parseTimeoutMs??60000);
      });
      update(record,{status:'ready',phase:'ready',error:null,errorCode:null});return source;
    }catch(error){const cause=asAssetError(error,record,record.phase,record.attempt);update(record,{status:'error',error:cause.message,errorCode:cause.code});notify(true);throw cause;}
  },options.priority??0);
  models.set(record.url,promise);promise.catch(()=>{if(models.get(record.url)===promise)models.delete(record.url);});return promise;
}

export function trackTask(key,options,run) {
  const record=declareAsset(key,{...options,bytes:0}),old=tasks.get(record.url);if(old)return old;
  const promise=(async()=>{
    update(record,{status:'parsing',phase:options.phase||'prepare',error:null,errorCode:null});
    try{const result=await timeoutTask(run,record,options.timeoutMs??60000);update(record,{status:'ready',phase:'ready',errorCode:null});return result;}
    catch(error){const cause=asAssetError(error,record,record.phase,record.attempt);update(record,{status:'error',error:cause.message,errorCode:cause.code});notify(true);throw cause;}
  })();
  tasks.set(record.url,promise);promise.finally(()=>{if(tasks.get(record.url)===promise)tasks.delete(record.url);}).catch(()=>{});return promise;
}
