import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {BattleAudio} from '../games/freight-fire/audio-cs2.js';
import {AssetLoadError} from '../games/freight-fire/asset-loading.js';

function playback(){
 const audio=new BattleAudio(),played=[];
 const connectable=()=>({connect(){},disconnect(){}});
 audio.ctx={state:'running',currentTime:0,
  createGain:()=>({...connectable(),gain:{value:0}}),
  createStereoPanner:()=>({...connectable(),pan:{value:0}}),
  createBufferSource:()=>({...connectable(),playbackRate:{value:1},start(){played.push(this.buffer.key);},stop(){this.onended?.();}}),
 };
 audio.master=connectable();audio.banks={m4a1Draw:['m4-draw'],ak47Draw:['ak-draw'],m4a1:['m4-shot']};
 const ready=key=>audio.samples.set(key,{key,duration:.2});
 return {audio,played,ready};
}

test('the current weapon draws once after decoding without replaying a missed shot',()=>{
 const {audio,played,ready}=playback(),player={alive:true,weapon:0};
 for(let frame=0;frame<4;frame++)audio.syncWeapon(player);
 audio.shot(0);assert.deepEqual(played,[]);assert.equal(audio.lastWeapon,-1);assert.equal(audio.sampleCount,0);
 ready('m4-draw');audio.syncWeapon(player);audio.syncWeapon(player);
 assert.deepEqual(played,['m4-draw']);assert.equal(audio.lastWeapon,0);assert.equal(audio.sampleCount,1);
 ready('m4-shot');audio.syncWeapon(player);
 assert.deepEqual(played,['m4-draw'],'a missed shot must never be queued');
 audio.shot(0);assert.deepEqual(played,['m4-draw','m4-shot']);assert.equal(audio.sampleCount,2);
});

test('late draw audio follows the selected weapon and cannot revive an old draw',()=>{
 const {audio,played,ready}=playback(),player={alive:true,weapon:0};
 audio.syncWeapon(player);player.weapon=1;audio.syncWeapon(player);
 ready('m4-draw');audio.syncWeapon(player);
 assert.deepEqual(played,[]);assert.equal(audio.sampleCount,0);
 ready('ak-draw');audio.syncWeapon(player);audio.syncWeapon(player);
 assert.deepEqual(played,['ak-draw']);assert.equal(audio.lastWeapon,1);
 player.alive=false;audio.syncWeapon(player);audio.syncWeapon(player);
 assert.deepEqual(played,['ak-draw']);assert.equal(audio.lastWeapon,-1);
});

test('a suspended audio context does not consume the first draw',()=>{
 const {audio,played,ready}=playback(),player={alive:true,weapon:0};ready('m4-draw');audio.ctx.state='suspended';
 audio.syncWeapon(player);assert.deepEqual(played,[]);assert.equal(audio.sampleCount,0);assert.equal(audio.lastWeapon,-1);
 audio.ctx.state='running';audio.syncWeapon(player);audio.syncWeapon(player);
 assert.deepEqual(played,['m4-draw']);assert.equal(audio.sampleCount,1);
});

test('audio retry fetches corrupt bodies again while preserving a decoder timeout body',async()=>{
 const original={fetch:globalThis.fetch,AudioContext:globalThis.AudioContext,warn:console.warn};
 const requests=[],warnings=[];let manifestAttempts=0,corrupt=true;
 const connectable=()=>({connect(){},gain:{value:0}});
 class AudioContext{
  constructor(){this.state='suspended';this.sampleRate=100;this.destination={};}
  createGain(){return connectable();}
  createDynamicsCompressor(){return {...connectable(),threshold:{},knee:{},ratio:{},attack:{},release:{}};}
  createBuffer(){return {getChannelData:()=>new Float32Array(100)};}
  async resume(){this.state='running';}
  async decodeAudioData(data){
   const marker=new Uint8Array(data)[0];
   if(corrupt&&marker===0xaa)throw new Error('EncodingError: corrupt MP3');
   if(corrupt&&marker===0xab)throw new AssetLoadError('decoder took too long',{code:'parse-timeout',phase:'decode'});
   return {duration:1};
  }
 }
 globalThis.AudioContext=AudioContext;console.warn=(...args)=>warnings.push(args);
 globalThis.fetch=async(url,options)=>{
  const name=new URL(url).pathname.split('/').pop(),originalBytes=readFileSync(fileURLToPath(url));
  requests.push({name,cache:options?.cache});let body=originalBytes;
  if(name==='freight-manifest.json'&&++manifestAttempts===1)body=Buffer.alloc(body.length,0x61);
  if(corrupt&&name==='m4a1_silencer_01.mp3')body=Buffer.alloc(body.length,0xaa);
  if(corrupt&&name==='awp_01.mp3')body=Buffer.alloc(body.length,0xab);
  return new Response(body,{headers:{'content-length':String(body.length)}});
 };
 try{
  const audio=new BattleAudio();assert.equal(requests.length,0,'constructor must not consume model bandwidth');
  await audio.prepare();assert.ok(audio.loadErrors.some(error=>error.includes('CS2 manifest')));
  await audio.prepare({retryFailed:true});assert.equal(manifestAttempts,2);assert.equal(requests.filter(r=>r.name==='freight-manifest.json')[1].cache,'reload');
  await audio.unlock();await audio.decoded;
  assert.equal(audio.ctx.state,'running');assert.equal(audio.samples.size,45);
  assert.equal(audio.files.has('m4a1_silencer_01.mp3'),false,'bad MP3 must leave the local buffer map');
  assert.equal(audio.files.has('awp_01.mp3'),true,'a timeout does not prove its body is bad');
  corrupt=false;await audio.prepare({retryFailed:true});await audio.decoded;
  assert.equal(audio.samples.size,47);assert.deepEqual(audio.loadErrors,[]);
  assert.equal(requests.filter(r=>r.name==='m4a1_silencer_01.mp3').length,2);
  assert.equal(requests.filter(r=>r.name==='m4a1_silencer_01.mp3')[1].cache,'reload');
  assert.equal(requests.filter(r=>r.name==='awp_01.mp3').length,1);
  assert.ok(warnings.length>=3,'manifest, corrupt MP3, and timeout failures remain explicit');
 }finally{globalThis.fetch=original.fetch;globalThis.AudioContext=original.AudioContext;console.warn=original.warn;}
});
