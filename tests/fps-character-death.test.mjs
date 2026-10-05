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
function settle(group){for(let frame=0;frame<90;frame++)advanceCharacterDeath(group,1/60);}
function projectedSpan(group,axis){let min=Infinity,max=-Infinity;const vertex=new THREE.Vector3();for(const {mesh,indices}of group.userData.contactSamples)for(const index of indices){const value=mesh.getVertexPosition(index,vertex).applyMatrix4(mesh.matrixWorld).dot(axis);min=Math.min(min,value);max=Math.max(max,value);}return max-min;}

test('actual SAS and Phoenix preserve limb lengths for three fall directions at every yaw',async()=>{
  for(const team of [0,1])for(const yaw of [0,Math.PI/4,Math.PI/2,Math.PI])for(const direction of ['back','left','right']){
    const actor=await character(team,{yaw}),data=actor.userData;
    data.deathDirection=new THREE.Vector3(...({back:[0,0,1],left:[-1,0,0],right:[1,0,0]}[direction])).applyQuaternion(actor.quaternion);
    beginCharacterDeath(actor,{y:0},0);
    for(let i=0;i<90;i++){
      advanceCharacterDeath(actor,1/60);
      for(const [bone,rest]of data.rest){assert.deepEqual(bone.position.toArray(),rest.position.toArray());assert.deepEqual(bone.scale.toArray(),rest.scale.toArray());assert.ok(Math.abs(bone.quaternion.length()-1)<1e-5);}
    }
    const box=bounds(actor),size=box.getSize(new THREE.Vector3());
    assert.ok(size.y<.65,JSON.stringify({team,yaw,size:size.toArray()}));
    // A 45-degree corpse has smaller X/Z bounds while retaining its length.
    // Measure along the actual fall axis, rather than weakening the length gate.
    assert.ok(projectedSpan(actor,data.deathDirection.clone().normalize())>1.65,JSON.stringify({team,yaw,direction,size:size.toArray()}));
    assert.ok(Math.abs(box.min.y-.018)<.001,box.min.toArray().join(','));
    assert.ok(point(actor,'head_0').distanceTo(point(actor,'pelvis'))>.69,'Torso stays extended');
    for(const side of ['L','R']){
      assert.ok(point(actor,'ankle_'+side).distanceTo(point(actor,'head_0'))>1.6,'Legs extend away from head');
      assert.ok(point(actor,'hand_'+side).distanceTo(point(actor,'head_0'))>.7,'Hands settle beside torso');
    }
    const torso=point(actor,'head_0').sub(point(actor,'pelvis')).applyQuaternion(actor.quaternion.clone().invert());
    assert.ok(direction==='back'?torso.z>.65:direction==='left'?torso.x<-.65:torso.x>.65,'Actual body follows chosen roll direction');
    assert.equal(data.deathStats.fallDirection,direction);
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
      const upper=new Set();data.skin.getObjectByName('spine_3').traverse(object=>upper.add(object.name));data.skin.getObjectByName('wpnPivot')?.traverse(object=>upper.add(object.name));
      const shot=native('rifle/shoot');shot.tracks=shot.tracks.filter(track=>upper.has(THREE.PropertyBinding.parseTrackName(track.name).nodeName)&&!track.name.endsWith('.scale'));shot.blendMode=THREE.AdditiveAnimationBlendMode;
      data.mixer.clipAction(shot).setEffectiveWeight(1).play();
    }
    data.mixer.update(.07);
    // Model the displayed post-animation grip solve, outside mixer bindings.
    data.bones.arm_upper_R.quaternion.multiply(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1,0,0),.12));
    const displayed=new Map([...data.rest.keys()].map(bone=>[bone,bone.quaternion.clone().normalize()]));
    const pelvis=data.bones.pelvis.position.clone();
    assert.ok([...displayed].some(([bone,q])=>q.angleTo(data.rest.get(bone).quaternion)>.01),'Pose differs from mixer original state');
    beginCharacterDeath(actor,{},0);
    for(const [bone,expected]of displayed)assert.ok(bone.quaternion.angleTo(expected)<1e-6,mode+': '+bone.name+' stays continuous');
    assert.deepEqual(data.bones.pelvis.position.toArray(),pelvis.toArray(),'Crouched pelvis does not snap to standing height');
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

test('knees unload before the main roll, then chest/head lag and arms relax at different times',async()=>{
  for(const team of [0,1]){
    const actor=await character(team),data=actor.userData;
    beginCharacterDeath(actor,{id:'a'},0);
    const hip=point(actor,'pelvis').y,startRotation=data.visual.quaternion.clone(),chest=data.bones.spine_3.getWorldQuaternion(new THREE.Quaternion()),head=data.bones.head_0.getWorldQuaternion(new THREE.Quaternion());
    for(let i=0;i<9;i++)advanceCharacterDeath(actor,1/60);
    assert.ok(point(actor,'pelvis').y<hip-.01,'Hip drops at least 1 cm before main fall');
    assert.ok(data.visual.quaternion.angleTo(startRotation)<.001,'Torso roll has not started');
    assert.equal(data.deathStats.phase,'loss-of-support');
    for(let i=0;i<12;i++)advanceCharacterDeath(actor,1/60);
    const bodyTurn=data.visual.quaternion.angleTo(startRotation),chestTurn=chest.angleTo(data.bones.spine_3.getWorldQuaternion(new THREE.Quaternion())),headTurn=head.angleTo(data.bones.head_0.getWorldQuaternion(new THREE.Quaternion()));
    assert.ok(chestTurn<bodyTurn-.04,'Chest follows hip roll with a measurable lag');
    assert.ok(headTurn<chestTurn-.015,'Head follows chest later');
    const fraction=side=>{const pose=data.deathState.poses.find(p=>p.bone.name==='arm_upper_'+side);return pose.start.angleTo(pose.bone.quaternion)/pose.start.angleTo(pose.target);};
    assert.ok(fraction('L')>fraction('R')+.04,'Left and right arms have different release timing');
    assert.equal(data.deathStats.phase,'falling');
    while(data.deathAge<1.10)advanceCharacterDeath(actor,1/120);
    assert.equal(data.deathStats.phase,'settling');assert.equal(data.deathStats.frozen,false);
    settle(actor);assert.equal(data.deathStats.phase,'frozen');
  }
});

test('three deterministic posture variants settle unfolded with real geometry and no repeated motion',async()=>{
  for(const team of [0,1]){
    const signatures=[],variants=new Set();
    for(const id of ['a','b','f']){
      const actor=await character(team),data=actor.userData;
      data.deathDirection=new THREE.Vector3(-1,0,0);beginCharacterDeath(actor,{id,deathAt:0},0);
      const variant=data.deathStats.variation;variants.add(variant);settle(actor);
      const box=bounds(actor),size=box.getSize(new THREE.Vector3());
      // Full-vertex measurements: SAS side height 0.607–0.608 m; Phoenix 0.554 m.
      // Torso 0.711 m, head-to-ankle 1.690–1.692 m, head-to-hand 0.783–0.836 m.
      assert.ok(size.y<.65);assert.ok(Math.abs(box.min.y-.018)<.001);
      assert.ok(point(actor,'head_0').distanceTo(point(actor,'pelvis'))>.69);
      assert.ok(point(actor,'head_0').distanceTo(point(actor,'ankle_R'))>1.6);
      assert.ok(point(actor,'head_0').distanceTo(point(actor,'hand_R'))>.7);
      assert.ok(data.deathAge>=1.2&&data.deathAge<=1.4);
      signatures.push(point(actor,'head_0').sub(point(actor,'pelvis')).toArray());
      const repeat=await character(team);repeat.userData.deathDirection=new THREE.Vector3(-1,0,0);beginCharacterDeath(repeat,{id,deathAt:0},0);
      assert.equal(repeat.userData.deathStats.variation,variant);
    }
    assert.deepEqual([...variants].sort(),[0,1,2]);
    for(let i=1;i<signatures.length;i++)assert.ok(new THREE.Vector3(...signatures[i]).distanceTo(new THREE.Vector3(...signatures[i-1]))>.02,'Final postures differ visibly by at least 2 cm');
  }
});

test('actual crouch and firing poses fall continuously with ground support and no transient torso collapse',async()=>{
  const animations=(await readCharacter('animations.glb')).animations;
  for(const team of [0,1])for(const mode of ['crouch','shoot'])for(const direction of ['back','left','right']){
    const actor=await character(team),data=actor.userData,names=new Set(Object.keys(data.bones));
    const native=name=>{const clip=animations.find(item=>item.name===name).clone();clip.tracks=clip.tracks.filter(track=>names.has(THREE.PropertyBinding.parseTrackName(track.name).nodeName));return clip;};
    data.mixer.clipAction(native(mode==='crouch'?'rifle/crouchIdle':'rifle/idle')).play();
    if(mode==='shoot'){
      const upper=new Set();data.skin.getObjectByName('spine_3').traverse(object=>upper.add(object.name));data.skin.getObjectByName('wpnPivot')?.traverse(object=>upper.add(object.name));
      const shot=native('rifle/shoot');shot.tracks=shot.tracks.filter(track=>upper.has(THREE.PropertyBinding.parseTrackName(track.name).nodeName)&&!track.name.endsWith('.scale'));shot.blendMode=THREE.AdditiveAnimationBlendMode;data.mixer.clipAction(shot).play();
    }
    data.mixer.update(.075);actor.updateMatrixWorld(true);
    const before=point(actor,'pelvis'),box=bounds(actor),initialLift=Math.max(0,.018-box.min.y);
    data.deathDirection=new THREE.Vector3(...({back:[0,0,1],left:[-1,0,0],right:[1,0,0]}[direction]));
    beginCharacterDeath(actor,{id:'f',crouching:mode==='crouch'},0);
    const initial=point(actor,'pelvis');
    assert.ok(Math.abs(initial.x-before.x)<.001&&Math.abs(initial.z-before.z)<.001,JSON.stringify({team,mode,direction,before:before.toArray(),initial:initial.toArray()}));
    assert.ok(Math.abs(initial.y-before.y-initialLift)<.001,'Only initial vertical deck support shifts the pose');
    let previous=initial,minimumLegSpan=Infinity;
    for(let frame=0;frame<170;frame++){
      advanceCharacterDeath(actor,1/120);
      const current=point(actor,'pelvis');
      assert.ok(current.distanceTo(previous)<.06,JSON.stringify({team,mode,direction,frame,step:current.distanceTo(previous)}));previous=current;
      assert.ok(point(actor,'head_0').distanceTo(current)>.62,'Torso remains extended throughout the fall');
      for(const side of ['L','R'])minimumLegSpan=Math.min(minimumLegSpan,point(actor,'leg_upper_'+side).distanceTo(point(actor,'ankle_'+side)));
      for(const [bone,rest]of data.rest){assert.deepEqual(bone.scale.toArray(),rest.scale.toArray());if(bone.name!=='pelvis')assert.deepEqual(bone.position.toArray(),rest.position.toArray());}
      if(frame%20===0)assert.ok(bounds(actor).min.y>=.017,'Actual skinned geometry has vertical deck support');
    }
    assert.equal(data.deathStats.frozen,true);assert.equal(data.deathStats.horizontalContacts,false);
    assert.ok(minimumLegSpan>.35,JSON.stringify({team,mode,direction,minimumLegSpan}));
    assert.ok(bounds(actor).getSize(new THREE.Vector3()).y<.65);
  }
});
