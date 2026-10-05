import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import * as THREE from '../games/freight-fire/vendor/three.module.js';
import {GLTFLoader} from '../games/freight-fire/vendor/GLTFLoader.js';
import {clone} from '../games/freight-fire/vendor/SkeletonUtils.js';
import {beginCharacterDeath,advanceCharacterDeath,clearCharacterDeath} from '../games/freight-fire/character-death.js';

// Use the real character vertices, skin weights, inverse binds and bones.
// Removing material references lets Node parse the GLBs without a DOM/Image API.
async function readCharacter(name){
  const original=await readFile(new URL('../games/freight-fire/assets/characters-cs2/'+name,import.meta.url));
  const jsonLength=original.readUInt32LE(12),json=JSON.parse(original.subarray(20,20+jsonLength).toString());
  for(const mesh of json.meshes||[])for(const primitive of mesh.primitives)delete primitive.material;
  delete json.materials;delete json.textures;delete json.images;
  const binaryOffset=20+jsonLength,binary=original.subarray(binaryOffset+8,binaryOffset+8+original.readUInt32LE(binaryOffset));
  const text=Buffer.from(JSON.stringify(json)),padded=Buffer.alloc((text.length+3)&~3,32);text.copy(padded);
  const glb=Buffer.alloc(28+padded.length+binary.length);
  glb.writeUInt32LE(0x46546c67);glb.writeUInt32LE(2,4);glb.writeUInt32LE(glb.length,8);
  glb.writeUInt32LE(padded.length,12);glb.writeUInt32LE(0x4e4f534a,16);padded.copy(glb,20);
  glb.writeUInt32LE(binary.length,20+padded.length);glb.writeUInt32LE(0x004e4942,24+padded.length);binary.copy(glb,28+padded.length);
  return new GLTFLoader().parseAsync(glb.buffer,'');
}
const source=Promise.all(['ct-sas.glb','t-phoenix.glb'].map(readCharacter));
async function character(team=0,{yaw=0,ground=0}={}){
  const group=new THREE.Group(),visual=new THREE.Group(),skin=clone((await source)[team].scene);
  group.add(visual);visual.add(skin);skin.rotation.y=Math.PI;group.rotation.y=yaw;group.position.set(12,ground,-10);
  const bones={},rest=new Map(),contactSamples=[];
  skin.traverse(object=>{
    if(object.isBone){bones[object.name]=object;rest.set(object,{position:object.position.clone(),quaternion:object.quaternion.clone(),scale:object.scale.clone()});}
    // Full mesh contact is intentionally stricter than the runtime extreme samples.
    if(object.isSkinnedMesh)contactSamples.push({mesh:object,indices:[...new Set(object.geometry.index?.array||Array.from({length:object.geometry.getAttribute('position').count},(_,i)=>i))]});
  });
  group.userData={skin,visual,bones,rest,contactSamples,team,mixer:new THREE.AnimationMixer(skin),rawPose:new Map(),currentAction:'rifle/idle'};
  return group;
}
const point=(group,name)=>group.userData.bones[name].getWorldPosition(new THREE.Vector3());
function bounds(group){group.updateMatrixWorld(true);group.userData.skin.traverse(object=>{if(object.isSkinnedMesh)object.skeleton.update();});return new THREE.Box3().setFromObject(group.userData.skin,true);}
function settle(group){for(let frame=0;frame<75;frame++)advanceCharacterDeath(group,1/60);}

test('actual SAS and Phoenix fall unfolded with preserved torso and limb lengths at every yaw',async()=>{
  for(const team of [0,1])for(const yaw of [0,Math.PI/2,Math.PI]){
    const actor=await character(team,{yaw}),data=actor.userData;
    beginCharacterDeath(actor,{y:0},0);
    for(let i=0;i<75;i++){
      advanceCharacterDeath(actor,1/60);
      for(const [bone,rest]of data.rest){assert.deepEqual(bone.position.toArray(),rest.position.toArray());assert.deepEqual(bone.scale.toArray(),rest.scale.toArray());assert.ok(Math.abs(bone.quaternion.length()-1)<1e-5);}
    }
    const box=bounds(actor),size=box.getSize(new THREE.Vector3());
    assert.ok(size.y<.65,JSON.stringify({team,yaw,size:size.toArray()}));
    assert.ok(Math.max(size.x,size.z)>1.65,JSON.stringify({team,yaw,size:size.toArray()}));
    assert.ok(Math.abs(box.min.y-.018)<.001,box.min.toArray().join(','));
    assert.ok(point(actor,'head_0').distanceTo(point(actor,'pelvis'))>.69,'Torso stays extended');
    for(const side of ['L','R']){
      assert.ok(point(actor,'ankle_'+side).distanceTo(point(actor,'head_0'))>1.6,'Legs extend away from head');
      assert.ok(point(actor,'hand_'+side).distanceTo(point(actor,'head_0'))>.7,'Hands settle beside torso');
    }
    assert.equal(data.deathStats.horizontalContacts,false);assert.equal(data.deathStats.frozen,true);
  }
});

test('settled corpses retain a frozen pose and perform no further contact or skeleton sampling',async()=>{
  const actor=await character(),data=actor.userData;
  beginCharacterDeath(actor,{},0);settle(actor);
  const pose=[...data.rest.keys()].map(bone=>bone.quaternion.toArray()),passes=data.deathStats.contactPasses;
  let samples=0;
  for(const {mesh}of data.contactSamples){mesh.getVertexPosition=()=>{samples++;throw Error('Frozen corpse resampled');};mesh.skeleton.update=()=>{throw Error('Frozen corpse skeleton updated');};}
  for(let i=0;i<600;i++)advanceCharacterDeath(actor,1/60);
  assert.equal(samples,0);assert.equal(data.deathStats.contactPasses,passes);
  assert.deepEqual([...data.rest.keys()].map(bone=>bone.quaternion.toArray()),pose);
  assert.equal(data.mixer.time,0);assert.equal(data.deathState.poses.length,0);
});

test('death restores real bone offsets and scales even immediately after an invalid shot pose',async()=>{
  const actor=await character(),data=actor.userData;
  for(const name of ['spine_1','spine_2','neck_0','arm_lower_R']){data.bones[name].position.set(0,0,0);data.bones[name].scale.set(0,0,0);}
  data.rawPose.set(data.bones.spine_1,{p:new THREE.Vector3(),q:new THREE.Quaternion()});
  data.upperMode='reload';data.upperUntil=99;
  beginCharacterDeath(actor,{},0);settle(actor);
  assert.equal(data.rawPose.size,0);
  assert.equal(data.upperMode,null);assert.equal(data.upperUntil,0);
  for(const [bone,rest]of data.rest){assert.deepEqual(bone.position.toArray(),rest.position.toArray());assert.deepEqual(bone.scale.toArray(),rest.scale.toArray());}
  assert.ok(point(actor,'head_0').distanceTo(point(actor,'pelvis'))>.69);
});

test('death uses the selected deck/tunnel height, holds its origin and clears temporary state on respawn',async()=>{
  for(const ground of [0,1.95,-2.27]){
    const actor=await character(1,{ground,yaw:.73}),origin=actor.position.clone();
    beginCharacterDeath(actor,{y:ground},ground);settle(actor);
    assert.ok(Math.abs(bounds(actor).min.y-(ground+.018))<.001);
    assert.deepEqual(actor.position.toArray(),origin.toArray());assert.equal(actor.rotation.y,.73);
    clearCharacterDeath(actor);
    assert.equal(actor.userData.deathState,null);assert.equal(actor.userData.deathStats,null);assert.equal(actor.userData.deathAge,0);
    assert.equal(actor.userData.upperMode,null);assert.equal(actor.userData.upperUntil,0);
  }
});

test('death begins from the displayed crouch or firing/IK rotations before mixer bindings restore',async()=>{
  const animations=(await readCharacter('animations.glb')).animations;
  for(const mode of ['crouch','shoot']){
    const actor=await character(),data=actor.userData,names=new Set(Object.keys(data.bones));
    const native=name=>{const clip=animations.find(item=>item.name===name).clone();clip.tracks=clip.tracks.filter(track=>names.has(THREE.PropertyBinding.parseTrackName(track.name).nodeName));return clip;};
    data.mixer.clipAction(native(mode==='crouch'?'rifle/crouchIdle':'rifle/idle')).play();
    if(mode==='shoot'){
      const shot=native('rifle/shoot');shot.blendMode=THREE.AdditiveAnimationBlendMode;
      data.mixer.clipAction(shot).setEffectiveWeight(1).play();
    }
    data.mixer.update(.07);
    // Model the displayed post-animation grip solve, outside mixer bindings.
    data.bones.arm_upper_R.quaternion.multiply(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1,0,0),.12));
    const displayed=new Map([...data.rest.keys()].map(bone=>[bone,bone.quaternion.clone().normalize()]));
    assert.ok([...displayed].some(([bone,q])=>q.angleTo(data.rest.get(bone).quaternion)>.01),'Pose differs from mixer original state');
    beginCharacterDeath(actor,{},0);
    for(const [bone,expected]of displayed)assert.ok(bone.quaternion.angleTo(expected)<1e-6,mode+': '+bone.name+' stays continuous');
    assert.equal(data.deathAge,0);assert.equal(data.deathStats.contactPasses,1);
    advanceCharacterDeath(actor,1/60);
    assert.ok(data.deathAge>0);
  }
});

test('paused falls retain initial support and avoid further bone or mesh sampling',async()=>{
  const actor=await character(),data=actor.userData;
  beginCharacterDeath(actor,{},0);advanceCharacterDeath(actor,1/60);
  const age=data.deathAge,stats=data.deathStats,position=data.visual.position.toArray(),pose=[...data.rest.keys()].map(bone=>bone.quaternion.toArray());
  assert.equal(stats.contactPasses,2);
  for(const {mesh}of data.contactSamples){mesh.getVertexPosition=()=>{throw Error('Paused corpse resampled');};mesh.skeleton.update=()=>{throw Error('Paused skeleton updated');};}
  for(let frame=0;frame<100;frame++)assert.equal(advanceCharacterDeath(actor,0),stats);
  assert.equal(data.deathAge,age);assert.equal(data.deathStats.contactPasses,2);
  assert.deepEqual(data.visual.position.toArray(),position);assert.deepEqual([...data.rest.keys()].map(bone=>bone.quaternion.toArray()),pose);
});
