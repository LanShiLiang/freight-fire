// Original CS2 samples from the user-selected dust2-web resource manifest.
// Valve retains the audio rights; see assets/audio/cs2/NOTICE.md. No remote
// audio is fetched at runtime. Playback/mixing is independently implemented.
import {WEAPONS} from './sim.js';
const IDS=['m4a1','ak47','awp','usp','knife'];
const RELOADS=[[[.14,'m4a1Out'],[.38,'m4a1In'],[.66,'m4a1Forward']],[[.15,'ak47Out'],[.44,'ak47In'],[.66,'ak47Bolt']],[[.07,'awpOut'],[.42,'awpIn'],[.72,'awpBack'],[.81,'awpForward']],[[.20,'uspOut'],[.45,'uspIn'],[.72,'uspForward']]];
export class BattleAudio{
 constructor(){this.enabled=true;this.ctx=null;this.voices=new Set();this.samples=new Map();this.banks={};this.loadErrors=[];this.sampleCount=0;this.lastStep=0;this.lastWeapon=-1;this.ready=this.load();}
 async load(){
  try{
   const response=await fetch(new URL('./assets/audio/cs2/freight-manifest.json',import.meta.url));if(!response.ok)throw new Error(response.status);
   const manifest=await response.json();this.banks=manifest.banks;
   const files=[...new Set(Object.values(this.banks).flat())],result=[];
   let cursor=0;await Promise.all(Array.from({length:4},async()=>{while(cursor<files.length){const key=files[cursor++];try{const r=await fetch(new URL('./assets/audio/cs2/'+key,import.meta.url));if(!r.ok)throw new Error(r.status);result.push([key,await r.arrayBuffer()]);}catch(e){this.loadErrors.push(key+': '+e.message);}}}));return result;
  }catch(e){this.loadErrors.push('CS2 manifest: '+e.message);return [];}
 }
 async unlock(){
  if(!this.ctx){
   const C=globalThis.AudioContext||globalThis.webkitAudioContext;if(!C)return;
   const c=this.ctx=new C({latencyHint:'interactive'});this.master=c.createGain();this.master.gain.value=.42;
   const limiter=c.createDynamicsCompressor();limiter.threshold.value=-10;limiter.knee.value=12;limiter.ratio.value=6;limiter.attack.value=.003;limiter.release.value=.12;this.master.connect(limiter);limiter.connect(c.destination);
   this.noise=c.createBuffer(1,c.sampleRate,c.sampleRate);const a=this.noise.getChannelData(0);for(let i=0;i<a.length;i++)a[i]=Math.random()*2-1;
   this.decoded=this.ready.then(async files=>{for(const [key,data]of files)try{this.samples.set(key,await c.decodeAudioData(data));}catch(e){this.loadErrors.push(key+': '+e.message);}});
  }
  if(this.ctx.state==='suspended')await this.ctx.resume();await this.decoded;
 }
 play(bank,{volume=1,pan=0,delay=0,channel='effect',rate=1}={}){
  if(!this.enabled||!this.ctx||this.ctx.state!=='running')return;
  const files=this.banks[bank];if(!files?.length)return;const key=files[this.sampleCount++%files.length],buffer=this.samples.get(key);if(!buffer)return;
  if(this.voices.size>=48){const first=this.voices.values().next().value;first.source.stop();}
  const c=this.ctx,source=c.createBufferSource(),gain=c.createGain(),panner=c.createStereoPanner();source.buffer=buffer;source.playbackRate.value=rate;
  gain.gain.value=Math.max(0,Math.min(1.2,volume));panner.pan.value=Math.max(-1,Math.min(1,pan));source.connect(gain);gain.connect(panner);panner.connect(this.master);
  const voice={source,gain,panner,channel};this.voices.add(voice);source.onended=()=>{source.disconnect();gain.disconnect();panner.disconnect();this.voices.delete(voice);};source.start(c.currentTime+Math.max(0,delay));
  this.lastSample={bank,key,volume,pan:panner.pan.value,duration:buffer.duration};if(channel==='feedback')this.lastFeedback={...this.lastSample};return voice;
 }
 cancel(channel){for(const voice of this.voices)if(voice.channel===channel)voice.source.stop();}
 draw(weapon){this.cancel('reload');this.cancel('bolt');this.cancel('draw');this.play(IDS[weapon]+'Draw',{volume:.68,channel:'draw'});}
 syncWeapon(player){if(!player?.alive){this.lastWeapon=-1;this.cancel('reload');this.cancel('bolt');return;}if(this.lastWeapon!==player.weapon){this.lastWeapon=player.weapon;this.draw(player.weapon);}}
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
