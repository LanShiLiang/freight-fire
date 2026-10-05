// Original CS2 samples from the user-selected dust2-web resource manifest.
// Valve retains the audio rights; see assets/audio/cs2/NOTICE.md. No remote
// audio is fetched at runtime. Playback/mixing is independently implemented.
import {WEAPONS} from './sim.js';
import {declareAsset,loadAssetBuffer,trackTask,invalidateAsset} from './asset-loading.js';
const AUDIO_ROOT=new URL('./assets/audio/cs2/',import.meta.url);
const IDS=['m4a1','ak47','awp','usp','knife'];
const RELOADS=[[[.14,'m4a1Out'],[.38,'m4a1In'],[.66,'m4a1Forward']],[[.15,'ak47Out'],[.44,'ak47In'],[.66,'ak47Bolt']],[[.07,'awpOut'],[.42,'awpIn'],[.72,'awpBack'],[.81,'awpForward']],[[.20,'uspOut'],[.45,'uspIn'],[.72,'uspForward']]];
export class BattleAudio{
 constructor(){this.enabled=true;this.ctx=null;this.voices=new Set();this.samples=new Map();this.banks={};this.loadErrors=[];this.errors=new Map();this.files=new Map();this.decodeJobs=new Map();this.sampleCount=0;this.lastStep=0;this.lastWeapon=-1;this.loading=null;this.decoded=null;}
 get ready(){return this.prepare();}
 warning(key,error){this.errors.set(key,key+': '+error.message);this.loadErrors.splice(0,this.loadErrors.length,...this.errors.values());console.warn('CS2 音效加载失败',key,error);}
 clearWarning(key){this.errors.delete(key);this.loadErrors.splice(0,this.loadErrors.length,...this.errors.values());}
 // The game calls prepare after the required models are ready. Merely creating
 // BattleAudio must not start 47 competing downloads on a slow connection.
 prepare({retryFailed=false}={}){
  if(this.loading&&!retryFailed)return this.loading;
  this.loading=this.load();
  if(this.ctx)this.decoded=this.loading.then(files=>Promise.all(files.map(([key,data])=>this.decode(key,data))));
  return this.loading;
 }
 async load(){
  try{
   const url=new URL('freight-manifest.json',AUDIO_ROOT),options={label:'CS2 音效清单',bytes:17311,group:'audio',critical:false,priority:10};
   const buffer=await loadAssetBuffer(url,{...options,deferReady:true});
   const manifest=await trackTask(url,{...options,phase:'parse'},()=>JSON.parse(new TextDecoder().decode(buffer)));this.banks=manifest.banks;this.clearWarning('CS2 manifest');
   const sizes=new Map((manifest.files||[]).map(file=>[file.path.split('/').pop(),file.bytes]));
   const priorityFiles=['m4a1Draw','m4a1','kill','headHit','bodyHit'].flatMap(bank=>this.banks[bank]||[]),first=new Set(priorityFiles),rank=new Map(priorityFiles.map((key,index)=>[key,index]));
   const files=[...new Set(Object.values(this.banks).flat())].sort((a,b)=>(rank.get(a)??999)-(rank.get(b)??999));
   for(const key of files)declareAsset(new URL(key,AUDIO_ROOT),{label:'CS2 音效 · '+key,bytes:sizes.get(key),group:'audio',critical:false});
   await Promise.all(files.map(async key=>{
    try{
     if(!this.files.has(key))this.files.set(key,await loadAssetBuffer(new URL(key,AUDIO_ROOT),{label:'CS2 音效 · '+key,bytes:sizes.get(key),group:'audio',critical:false,priority:first.has(key)?10:11}));
     this.clearWarning(key);if(this.ctx)this.decode(key,this.files.get(key));
    }catch(error){this.warning(key,error);}
   }));return [...this.files];
  }catch(error){if(error.phase==='parse'&&error.code!=='parse-timeout')invalidateAsset(new URL('freight-manifest.json',AUDIO_ROOT));this.warning('CS2 manifest',error);return [...this.files];}
 }
 decode(key,data){
  if(this.samples.has(key))return Promise.resolve(this.samples.get(key));
  if(this.decodeJobs.has(key))return this.decodeJobs.get(key);
  const job=trackTask(new URL(key+'?decode',AUDIO_ROOT),{label:'解码 CS2 音效 · '+key,group:'audio',critical:false,phase:'decode',timeoutMs:20000},()=>this.ctx.decodeAudioData(data.slice(0)))
   .then(buffer=>{this.samples.set(key,buffer);this.clearWarning(key);return buffer;})
   .catch(error=>{if(error.code!=='parse-timeout'){this.files.delete(key);invalidateAsset(new URL(key,AUDIO_ROOT));}this.warning(key,error);return null;})
   .finally(()=>{if(this.decodeJobs.get(key)===job)this.decodeJobs.delete(key);});
  this.decodeJobs.set(key,job);return job;
 }
 async unlock(){
  if(!this.ctx){
   const C=globalThis.AudioContext||globalThis.webkitAudioContext;if(!C){this.warning('AudioContext',new Error('浏览器没有音频播放接口'));return;}
   let c;try{c=this.ctx=new C({latencyHint:'interactive'});}catch(error){this.warning('AudioContext',error);return;}this.master=c.createGain();this.master.gain.value=.42;
   const limiter=c.createDynamicsCompressor();limiter.threshold.value=-10;limiter.knee.value=12;limiter.ratio.value=6;limiter.attack.value=.003;limiter.release.value=.12;this.master.connect(limiter);limiter.connect(c.destination);
   this.noise=c.createBuffer(1,c.sampleRate,c.sampleRate);const a=this.noise.getChannelData(0);for(let i=0;i<a.length;i++)a[i]=Math.random()*2-1;
  }
  const ready=this.prepare({retryFailed:this.loadErrors.length>0});
  for(const [key,data]of this.files)this.decode(key,data);
  this.decoded=ready.then(files=>Promise.all(files.map(([key,data])=>this.decode(key,data))));
  // Resume remains in the trusted Start gesture. Download/decoding continues
  // in the background and cannot trap the player behind the loading screen.
  try{if(this.ctx.state==='suspended')await this.ctx.resume();this.clearWarning('AudioContext');}catch(error){this.warning('AudioContext',error);}
 }
 play(bank,{volume=1,pan=0,delay=0,channel='effect',rate=1}={}){
  if(!this.enabled||!this.ctx||this.ctx.state!=='running')return;
  const files=this.banks[bank];if(!files?.length)return;const key=files[this.sampleCount%files.length],buffer=this.samples.get(key);if(!buffer)return;
  if(this.voices.size>=48){const first=this.voices.values().next().value;first.source.stop();}
  const c=this.ctx,source=c.createBufferSource(),gain=c.createGain(),panner=c.createStereoPanner();source.buffer=buffer;source.playbackRate.value=rate;
  gain.gain.value=Math.max(0,Math.min(1.2,volume));panner.pan.value=Math.max(-1,Math.min(1,pan));source.connect(gain);gain.connect(panner);panner.connect(this.master);
  const voice={source,gain,panner,channel};this.voices.add(voice);source.onended=()=>{source.disconnect();gain.disconnect();panner.disconnect();this.voices.delete(voice);};source.start(c.currentTime+Math.max(0,delay));this.sampleCount++;
  this.lastSample={bank,key,volume,pan:panner.pan.value,duration:buffer.duration};if(channel==='feedback')this.lastFeedback={...this.lastSample};return voice;
 }
 cancel(channel){for(const voice of this.voices)if(voice.channel===channel)voice.source.stop();}
 draw(weapon){this.cancel('reload');this.cancel('bolt');this.cancel('draw');return this.play(IDS[weapon]+'Draw',{volume:.68,channel:'draw'});}
 syncWeapon(player){if(!player?.alive){this.lastWeapon=-1;this.cancel('reload');this.cancel('bolt');return;}if(this.lastWeapon!==player.weapon&&this.draw(player.weapon))this.lastWeapon=player.weapon;}
 shot(index,volume=1,pan=0,own=true){const id=IDS[index];if(!id||id==='knife')return;this.play(id,{volume:volume*[.85,.82,.94,.78][index],pan,channel:'shot',rate:.995+Math.random()*.01});if(index===2&&own){this.play('awpBack',{volume:.36,delay:.43,channel:'bolt'});this.play('awpForward',{volume:.36,delay:.81,channel:'bolt'});}}
 event(e,self,players){
  const shooter=players.find(p=>p.id===e.playerId);let volume=1,pan=0;
  if(shooter&&self&&shooter.id!==self.id){const dx=shooter.x-self.x,dz=shooter.z-self.z;volume=1/(1+Math.hypot(dx,dz)*.13);pan=(dx*Math.cos(self.yaw)-dz*Math.sin(self.yaw))/20;}
  if(e.type==='shot')this.shot(typeof e.weapon==='number'?e.weapon:IDS.indexOf(e.weapon),volume,pan,e.playerId===self?.id);
  if(e.type==='melee'){this.play(e.heavy?'knifeHeavySwing':'knifeSwing',{volume:.72*volume,pan});if(e.surface==='world')this.play('knifeWall',{volume:.65*volume,pan});}
  if(e.type==='hit'&&!e.protected){
   if(e.playerId===self?.id){const bank=e.weapon===4?(e.heavy?'knifeHeavyHit':'knifeHit'):e.headshot?'headHit':'bodyHit';this.play(bank,{volume:e.headshot?1:.85,channel:'feedback'});}
   if(e.targetId===self?.id)this.play(e.headshot?'headHit':'bodyHit',{volume:.6,channel:'injury'});
  }
  if(e.type==='reload'&&e.playerId===self?.id){this.cancel('reload');this.cancel('bolt');for(const [fraction,bank]of RELOADS[e.weapon]||[])this.play(bank,{volume:.65,delay:fraction*(WEAPONS[e.weapon]?.reload||2),channel:'reload'});}
  if(e.type==='kill'&&e.playerId===self?.id)this.play('kill',{volume:e.headshot?1:.95,channel:'feedback'});
 }
 burst(duration,volume,cutoff=1600){if(!this.enabled||!this.ctx||this.ctx.state!=='running'||this.voices.size>40)return;const c=this.ctx,s=c.createBufferSource(),gain=c.createGain(),filter=c.createBiquadFilter();s.buffer=this.noise;filter.type='lowpass';filter.frequency.value=cutoff;gain.gain.setValueAtTime(volume,c.currentTime);gain.gain.exponentialRampToValueAtTime(.001,c.currentTime+duration);s.connect(filter);filter.connect(gain);gain.connect(this.master);s.start(c.currentTime,Math.random()*.5,duration);s.onended=()=>{s.disconnect();filter.disconnect();gain.disconnect();};}
 footsteps(time,moving,quiet=false){if(quiet){this.lastStep=time;return;}if(moving&&time-this.lastStep>.42){this.lastStep=time;this.burst(.06,.10,700);}}
 dispose(){this.ctx?.close();}
}
