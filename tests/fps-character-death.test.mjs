import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import * as THREE from '../games/freight-fire/vendor/three.module.js';
import {GLTFLoader} from '../games/freight-fire/vendor/GLTFLoader.js';
import {clone} from '../games/freight-fire/vendor/SkeletonUtils.js';
import {beginCharacterDeath,advanceCharacterDeath,clearCharacterDeath} from '../games/freight-fire/character-death.js';
import * as CANNON from '../games/freight-fire/vendor/cannon-es.js';

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
    // Use the same per-bone 26-direction extremes as the shipped runtime.
    // Verification bounds below still examine the actual complete mesh.
    if(object.isSkinnedMesh){
      const p=object.geometry.getAttribute('position'),j=object.geometry.getAttribute('skinIndex'),w=object.geometry.getAttribute('skinWeight'),extremes=new Map();
      for(const index of new Set(object.geometry.index?.array||Array.from({length:p.count},(_,i)=>i))){let strongest=0;for(let k=1;k<4;k++)if(w.getComponent(index,k)>w.getComponent(index,strongest))strongest=k;
        for(let x=-1;x<=1;x++)for(let y=-1;y<=1;y++)for(let z=-1;z<=1;z++){if(!x&&!y&&!z)continue;const key=j.getComponent(index,strongest)+','+x+','+y+','+z,value=p.getX(index)*x+p.getY(index)*y+p.getZ(index)*z;
          if(!extremes.has(key)||value>extremes.get(key).value)extremes.set(key,{index,value});}}
      contactSamples.push({mesh:object,indices:[...new Set([...extremes.values()].map(item=>item.index))]});
    }
  });
  group.userData={skin,visual,bones,rest,contactSamples,team,mixer:new THREE.AnimationMixer(skin),rawPose:new Map(),currentAction:'rifle/idle'};
  return group;
}
const point=(group,name)=>group.userData.bones[name].getWorldPosition(new THREE.Vector3());
function bounds(group){group.updateMatrixWorld(true);group.userData.skin.traverse(object=>{if(object.isSkinnedMesh)object.skeleton.update();});return new THREE.Box3().setFromObject(group.userData.skin,true);}
function settle(group){for(let frame=0;frame<180;frame++)advanceCharacterDeath(group,1/60);}
function projectedSpan(group,axis){let min=Infinity,max=-Infinity;const vertex=new THREE.Vector3();for(const {mesh,indices}of group.userData.contactSamples)for(const index of indices){const value=mesh.getVertexPosition(index,vertex).applyMatrix4(mesh.matrixWorld).dot(axis);min=Math.min(min,value);max=Math.max(max,value);}return max-min;}

const animations=readCharacter('animations.glb').then(source=>source.animations);
async function animate(actor,mode='idle'){
  const data=actor.userData,names=new Set(Object.keys(data.bones)),clips=await animations;
  const native=name=>{const clip=clips.find(item=>item.name===name).clone();clip.tracks=clip.tracks.filter(track=>names.has(THREE.PropertyBinding.parseTrackName(track.name).nodeName));return clip;};
  data.mixer.clipAction(native(mode.includes('crouch')?'rifle/crouchIdle':'rifle/idle')).play();
  if(mode.includes('shoot')||mode==='reload'){
    const upper=new Set();data.bones.spine_3.traverse(object=>upper.add(object.name));data.skin.getObjectByName('wpnPivot')?.traverse(object=>upper.add(object.name));
    const overlay=native(mode==='reload'?'rifle/reload':'rifle/shoot');overlay.tracks=overlay.tracks.filter(track=>upper.has(THREE.PropertyBinding.parseTrackName(track.name).nodeName)&&!track.name.endsWith('.scale'));
    if(mode==='reload')THREE.AnimationUtils.makeClipAdditive(overlay,0,native('rifle/idle'),30);else overlay.blendMode=THREE.AdditiveAnimationBlendMode;
    data.mixer.clipAction(overlay).play();
  }
  data.mixer.update(.075);actor.updateMatrixWorld(true);
}
function checkOffsets(actor){
  for(const [bone,rest]of actor.userData.rest){if(bone.name!=='pelvis')assert.deepEqual(bone.position.toArray(),rest.position.toArray());assert.deepEqual(bone.scale.toArray(),rest.scale.toArray());assert.ok(Math.abs(bone.quaternion.length()-1)<1e-6);}
}
const directionVector=(direction,yaw)=>new THREE.Vector3(...({back:[0,0,1],left:[-1,0,0],right:[1,0,0]}[direction])).applyAxisAngle(new THREE.Vector3(0,1,0),yaw);

test('death builds genuine fifteen-body Cannon worlds with anatomical joint constraints and no scene walls',async()=>{
  for(const team of [0,1]){
    const actor=await character(team);await animate(actor,'crouch');beginCharacterDeath(actor,{crouching:true},0);const state=actor.userData.deathState;
    assert.ok(state.world instanceof CANNON.World);assert.equal(state.bodies.length,15);assert.equal(state.world.bodies.length,16);assert.equal(state.world.constraints.length,14);
    assert.equal(state.joints.filter(joint=>joint.constraint instanceof CANNON.HingeConstraint).length,4);
    assert.equal(state.joints.filter(joint=>joint.constraint instanceof CANNON.ConeTwistConstraint).length,10);
    assert.equal(state.world.gravity.y,-9.81);assert.ok(state.world.bodies.filter(body=>body.mass===0).every(body=>body.shapes[0] instanceof CANNON.Plane));
    assert.ok(actor.userData.deathStats.contactVertices>100);checkOffsets(actor);clearCharacterDeath(actor);assert.equal(state.world,null);
  }
});

test('real SAS and Phoenix poses retain bone lengths and bounded biological joints throughout gravity-driven deaths',async()=>{
  for(const team of [0,1])for(const mode of ['idle','crouch','shoot','crouch-shoot','reload'])for(const direction of ['back','left','right']){
    const yaw=team?-.63:.47,actor=await character(team,{yaw}),data=actor.userData;await animate(actor,mode);
    data.deathDirection=directionVector(direction,yaw);beginCharacterDeath(actor,{crouching:mode.includes('crouch')},0);
    let maxGap=0,maxBend=0,maxTwist=0,maxSwing=0,previous=point(actor,'pelvis');
    for(let frame=0;frame<360;frame++){
      advanceCharacterDeath(actor,1/120);const stats=data.deathStats;maxGap=Math.max(maxGap,stats.maxJointGap);maxBend=Math.max(maxBend,stats.maxBendViolation);maxTwist=Math.max(maxTwist,stats.maxTwistViolation);maxSwing=Math.max(maxSwing,stats.maxSwingViolation);
      const current=point(actor,'pelvis');assert.ok(current.distanceTo(previous)<.08,JSON.stringify({team,mode,direction,frame,step:current.distanceTo(previous)}));previous=current;
      if(frame%12===0)checkOffsets(actor);
      assert.ok(point(actor,'head_0').distanceTo(current)>.60,'Torso retains its real length');
      for(const side of ['L','R'])assert.ok(point(actor,'leg_upper_'+side).distanceTo(point(actor,'ankle_'+side))>.46,'Knee cannot double back into a folded limb');
    }
    const detail={team,mode,direction,maxGap,maxBend,maxTwist,maxSwing,stats:data.deathStats},box=bounds(actor),size=box.getSize(new THREE.Vector3());
    // Real 30-pose measurements with the runtime's sparse collider fitting:
    // joint gaps stay below 5 cm at impact; angle overshoot is transient and
    // resolves to <3 degrees before freezing. These bounds reject the former
    // 37-degree twist error rather than widening a gate to accept it.
    assert.ok(maxGap<.055,JSON.stringify(detail));assert.ok(maxBend<.2,JSON.stringify(detail));assert.ok(maxTwist<.2,JSON.stringify(detail));assert.ok(maxSwing<.2,JSON.stringify(detail));
    assert.ok(data.deathStats.maxJointGap<.03,JSON.stringify(detail));assert.ok(data.deathStats.maxBendViolation<.06,JSON.stringify(detail));assert.ok(data.deathStats.maxTwistViolation<.06,JSON.stringify(detail));assert.ok(data.deathStats.maxSwingViolation<.06,JSON.stringify(detail));
    assert.ok(size.y<1.05&&Math.max(size.x,size.z)>1.2,JSON.stringify({team,mode,direction,size:size.toArray()}));
    assert.ok(box.min.y>-.055&&box.min.y<.09,JSON.stringify({team,mode,direction,min:box.min.y}));
    for(const side of ['L','R'])assert.ok(point(actor,'ankle_'+side).distanceTo(point(actor,'head_0'))>.9,'Boots do not collect around the head');
    assert.equal(data.deathStats.frozen,true);assert.equal(data.deathStats.horizontalContacts,false);assert.equal(data.deathState.world,null);
  }
});

test('death hands off the displayed post-IK, crouch and firing pose before stopping mixer bindings',async()=>{
  for(const team of [0,1])for(const mode of ['idle','crouch','shoot','reload']){
    const actor=await character(team),data=actor.userData;await animate(actor,mode);
    data.bones.arm_upper_R.quaternion.multiply(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1,0,0),.12));actor.updateMatrixWorld(true);
    const before=new Map([...data.rest.keys()].map(bone=>[bone,{q:bone.quaternion.clone().normalize(),p:bone.getWorldPosition(new THREE.Vector3())}]));
    beginCharacterDeath(actor,{},0);
    for(const [bone,pose]of before){assert.ok(bone.quaternion.angleTo(pose.q)<1e-6,'Quaternion handoff is continuous: '+bone.name);
      // Native wpnPivot translates the hidden weapon several metres. It has
      // no character skin weights and is restored with the discarded weapon.
      if(bone.name.startsWith('wpn'))continue;
      const gap=bone.getWorldPosition(new THREE.Vector3()).distanceTo(pose.p);assert.ok(gap<.0001,JSON.stringify({team,mode,bone:bone.name,gap}));}
    assert.equal(data.deathStats.physicsSteps,0);assert.equal(data.mixer.time,.075);clearCharacterDeath(actor);
  }
});

test('paused deaths do no physics, bone updates or skin sampling; frozen deaths release every physics object',async()=>{
  const actor=await character(),data=actor.userData;await animate(actor,'idle');beginCharacterDeath(actor,{},0);
  let samples=0;for(const {mesh}of data.contactSamples){mesh.getVertexPosition=()=>{samples++;throw Error('Skin vertices must only be sampled on initialization');};mesh.skeleton.update=()=>{throw Error('Death update must not update skin matrices');};}
  const passes=data.deathStats.contactPasses,initial=data.bones.pelvis.position.clone(),world=data.deathState.world;let steps=0;const step=world.step.bind(world);world.step=(...args)=>{steps++;return step(...args);};
  for(let i=0;i<600;i++)advanceCharacterDeath(actor,0);assert.equal(steps,0);assert.equal(data.deathStats.contactPasses,passes);assert.ok(initial.equals(data.bones.pelvis.position));
  settle(actor);assert.equal(data.deathState.world,null);assert.equal(world.bodies.length,0);assert.equal(world.constraints.length,0);assert.equal(world.contacts.length,0);
  for(const key of ['bodies','bindings','joints','poses'])assert.equal(data.deathState[key].length,0);
  const lastSteps=steps,pose=[...data.rest.keys()].map(bone=>[...bone.quaternion,...bone.position]),lastStats={...data.deathStats};
  for(const bone of data.rest.keys())bone.updateMatrix=()=>{throw Error('Frozen corpse bone updated');};
  for(let i=0;i<600;i++)advanceCharacterDeath(actor,1/60);
  assert.equal(samples,0);assert.equal(steps,lastSteps);assert.deepEqual(data.deathStats,lastStats);assert.deepEqual([...data.rest.keys()].map(bone=>[...bone.quaternion,...bone.position]),pose);
});

test('world ground height/yaw and low frame-rate steps keep corpses grounded without compressed bones',async()=>{
  for(const ground of [0,1.95,-2.4])for(const yaw of [0,.73,Math.PI/2]){
    const actor=await character(1,{ground,yaw}),data=actor.userData,origin=actor.position.clone();await animate(actor,'idle');data.deathDirection=directionVector('left',yaw);
    beginCharacterDeath(actor,{y:ground},ground);for(let i=0;i<40;i++)advanceCharacterDeath(actor,.1);
    const box=bounds(actor);assert.ok(box.min.y-ground>-.055&&box.min.y-ground<.09,JSON.stringify({ground,yaw,min:box.min.y}));
    assert.deepEqual(actor.position.toArray(),origin.toArray());assert.equal(actor.rotation.y,yaw);checkOffsets(actor);
    assert.ok(data.deathStats.age<=2.8);assert.ok(data.deathStats.physicsSteps<=252);assert.equal(data.deathStats.frozen,true);
    clearCharacterDeath(actor);assert.equal(data.deathState,null);assert.equal(data.deathStats,null);assert.equal(data.deathAge,0);
  }
});

test('real impact direction and inherited motion change physics trajectories rather than selecting fixed poses',async()=>{
  const trajectories=[];
  for(const direction of ['back','left','right']){
    const actor=await character(0,{yaw:.47}),data=actor.userData;await animate(actor,'idle');data.deathDirection=directionVector(direction,.47);
    beginCharacterDeath(actor,{},0);const initial=point(actor,'spine_3');for(let frame=0;frame<12;frame++)advanceCharacterDeath(actor,1/120);
    const movement=point(actor,'spine_3').sub(initial);assert.ok(movement.dot(data.deathDirection)>.005,'Torso responds to the actual impact');settle(actor);trajectories.push(['head_0','hand_L','hand_R','ankle_L','ankle_R'].map(name=>point(actor,name)));
  }
  for(let i=1;i<trajectories.length;i++)assert.ok(trajectories[0].some((joint,index)=>joint.distanceTo(trajectories[i][index])>.1),'Different impulses produce different terminal physics poses');
  const moving=await character(1),stationary=await character(1);await animate(moving);await animate(stationary);moving.userData.lastLivingVelocity=[2,0,-1];beginCharacterDeath(moving,{},0);beginCharacterDeath(stationary,{},0);
  assert.deepEqual(moving.userData.deathStats.initialVelocity,[2,0,-1]);for(let i=0;i<45;i++){advanceCharacterDeath(moving,1/60);advanceCharacterDeath(stationary,1/60);}
  assert.ok(point(moving,'pelvis').distanceTo(point(stationary,'pelvis'))>.15,'Living momentum is inherited by the actual bodies');
});

test('invalid animation scales are restored and clearing an active corpse immediately releases its simulation',async()=>{
  const actor=await character(),data=actor.userData;for(const name of ['spine_1','spine_2','neck_0','arm_lower_R']){data.bones[name].position.set(0,0,0);data.bones[name].scale.set(0,0,0);}
  data.rawPose.set(data.bones.spine_1,{p:new THREE.Vector3(),q:new THREE.Quaternion()});data.upperMode='reload';data.upperUntil=99;
  beginCharacterDeath(actor,{},0);checkOffsets(actor);const world=data.deathState.world;advanceCharacterDeath(actor,.1);clearCharacterDeath(actor);
  assert.equal(world.bodies.length,0);assert.equal(world.constraints.length,0);assert.equal(data.rawPose.size,0);assert.equal(data.upperMode,null);assert.equal(data.upperUntil,0);assert.equal(data.deathState,null);
});

test('shallow initial deck penetration and airborne momentum land without physics explosions',async()=>{
  for(const team of [0,1])for(const [offset,velocity]of [[-.055,[0,0,0]],[.65,[1,2.5,-.5]]]){
    const actor=await character(team),data=actor.userData;await animate(actor,'idle');actor.position.y=offset;data.lastLivingVelocity=velocity;
    actor.updateMatrixWorld(true);const initialHip=point(actor,'pelvis').y;beginCharacterDeath(actor,{},0);let maxHip=initialHip,maxSpeed=0,maxGap=0;
    for(let frame=0;frame<180;frame++){advanceCharacterDeath(actor,1/60);maxHip=Math.max(maxHip,point(actor,'pelvis').y);maxSpeed=Math.max(maxSpeed,data.deathStats.maxSpeed);maxGap=Math.max(maxGap,data.deathStats.maxJointGap);checkOffsets(actor);}
    const detail={team,offset,maxHip,initialHip,maxSpeed,maxGap,stats:data.deathStats};
    assert.ok(maxHip<initialHip+(offset<0?.15:.55),JSON.stringify(detail));assert.ok(maxSpeed<8,JSON.stringify(detail));assert.ok(maxGap<.09,JSON.stringify(detail));
    assert.equal(data.deathStats.frozen,true);assert.equal(data.deathState.world,null);const box=bounds(actor);assert.ok(box.min.y>-.055&&box.min.y<.09,JSON.stringify({team,offset,bounds:box.min.toArray()}));
  }
});
