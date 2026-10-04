import test from 'node:test';
import assert from 'node:assert/strict';
import {BattleAudio} from '../games/freight-fire/audio-cs2.js';

function recorder(){
 const audio=Object.create(BattleAudio.prototype),calls=[];
 audio.play=(bank,options={})=>calls.push({bank,...options});
 return {audio,calls};
}
const self={id:'self',x:0,z:0,yaw:0},enemy={id:'enemy',x:0,z:-25,yaw:Math.PI};
test('own AWP fire schedules its bolt while a centred enemy shot stays spatial and distant',()=>{
 const local=recorder();local.audio.event({type:'shot',playerId:self.id,weapon:2},self,[self,enemy]);
 assert.deepEqual(local.calls.map(c=>c.bank),['awp','awpBack','awpForward']);
 const remote=recorder();remote.audio.event({type:'shot',playerId:enemy.id,weapon:2},self,[self,enemy]);
 assert.deepEqual(remote.calls.map(c=>c.bank),['awp']);
 assert.equal(remote.calls[0].pan,0);assert.ok(remote.calls[0].volume<.25);
});
test('a headshot emits one head hit and one kill confirmation without replaying the head sound',()=>{
 const {audio,calls}=recorder();
 audio.event({type:'hit',playerId:self.id,targetId:enemy.id,weapon:0,headshot:true},self,[self,enemy]);
 audio.event({type:'kill',playerId:self.id,targetId:enemy.id,weapon:0,headshot:true},self,[self,enemy]);
 assert.deepEqual(calls.map(c=>c.bank),['headHit','kill']);
});
test('melee feedback uses the light or heavy hit sample and protected hits stay silent',()=>{
 const {audio,calls}=recorder();
 for(const heavy of [false,true])audio.event({type:'hit',playerId:self.id,targetId:enemy.id,weapon:4,heavy},self,[self,enemy]);
 audio.event({type:'hit',playerId:self.id,targetId:enemy.id,weapon:4,protected:true},self,[self,enemy]);
 assert.deepEqual(calls.map(c=>c.bank),['knifeHit','knifeHeavyHit']);
});
test('another player killing an opponent never plays the local confirmation',()=>{
 const {audio,calls}=recorder();audio.event({type:'kill',playerId:enemy.id,targetId:'third',weapon:1,headshot:true},self,[self,enemy]);
 assert.equal(calls.length,0);
});
