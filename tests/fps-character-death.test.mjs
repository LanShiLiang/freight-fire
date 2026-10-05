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
async function capturedCharacter(name){
  const fixture=JSON.parse(await readFile(new URL('./fixtures/'+name,import.meta.url),'utf8')),actor=await character(fixture.team),data=actor.userData,initial=fixture.initial;
  actor.position.fromArray(initial.groupPosition);actor.quaternion.fromArray(initial.groupRotation);actor.scale.fromArray(initial.groupScale);
  for(const [object,p,q,s]of [[data.visual,initial.visualPosition,initial.visualRotation,initial.visualScale],[data.skin,initial.skinPosition,initial.skinRotation,initial.skinScale]]){object.position.fromArray(p);object.quaternion.fromArray(q);object.scale.fromArray(s);}
  for(const pose of fixture.poses||initial.poses){const bone=data.bones[pose.name];bone.position.fromArray(pose.position);bone.quaternion.fromArray(pose.rotation);bone.scale.fromArray(pose.scale);}
  data.deathDirection=new THREE.Vector3(...initial.direction);data.deathHitPoint=initial.hitPoint;data.lastLivingVelocity=initial.initialVelocity;actor.updateMatrixWorld(true);
  return {actor,fixture};
}
async function animate(actor,mode='idle'){
  const data=actor.userData,names=new Set(Object.keys(data.bones)),clips=await animations;
  const native=name=>{const clip=clips.find(item=>item.name===name).clone();clip.tracks=clip.tracks.filter(track=>names.has(THREE.PropertyBinding.parseTrackName(track.name).nodeName));return clip;};
  if(mode.startsWith('run:')){const action=data.mixer.clipAction(native('rifle/run_n')).play();action.time=Number(mode.slice(4));data.mixer.update(0);actor.updateMatrixWorld(true);return;}
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
function corpseGeometry(actor){
  const box=bounds(actor),size=box.getSize(new THREE.Vector3()),head=[],feet={L:[],R:[]},vertex=new THREE.Vector3();
  actor.userData.skin.traverse(mesh=>{
    if(!mesh.isSkinnedMesh)return;const positions=mesh.geometry.getAttribute('position'),indices=mesh.geometry.getAttribute('skinIndex'),weights=mesh.geometry.getAttribute('skinWeight');
    for(const index of new Set(mesh.geometry.index?.array||Array.from({length:positions.count},(_,i)=>i))){
      let strongest=0;for(let k=1;k<4;k++)if(weights.getComponent(index,k)>weights.getComponent(index,strongest))strongest=k;
      let bone=mesh.skeleton.bones[indices.getComponent(index,strongest)],part=null;
      while(bone?.isBone){if(bone.name==='head_0'){part='head';break;}if(/^ankle_[LR]$/.test(bone.name)){part=bone.name.slice(-1);break;}bone=bone.parent;}
      if(part){mesh.getVertexPosition(index,vertex).applyMatrix4(mesh.matrixWorld);(part==='head'?head:feet[part]).push(vertex.clone());}
    }
  });
  const headFootVertexDistances=['L','R'].map(side=>{let min=Infinity;for(const a of head)for(const b of feet[side])min=Math.min(min,a.distanceToSquared(b));return Math.sqrt(min);});
  const headPoint=point(actor,'head_0'),hipPoint=point(actor,'pelvis'),headHip=headPoint.distanceTo(hipPoint);
  return {box,size:size.toArray(),headHip,headHeight:headPoint.y,pelvisHeight:hipPoint.y,torsoVerticalRatio:Math.abs(headPoint.y-hipPoint.y)/headHip,headAnkles:['L','R'].map(side=>headPoint.distanceTo(point(actor,'ankle_'+side))),
    legSpans:['L','R'].map(side=>point(actor,'leg_upper_'+side).distanceTo(point(actor,'ankle_'+side))),footSeparation:point(actor,'ankle_L').distanceTo(point(actor,'ankle_R')),headFootVertexDistances};
}
// Vertex sampling is a corroborating metric, not a triangle intersection test.
const extendedLowerBody=geometry=>Math.max(...geometry.headAnkles)>.9||geometry.legSpans.every(value=>value>.60)||(Math.max(...geometry.legSpans)>.75&&Math.max(...geometry.headAnkles)>.8);
const spreadGeometry=geometry=>geometry.headHip>.60&&geometry.torsoVerticalRatio<=.6&&extendedLowerBody(geometry)&&geometry.legSpans.every(value=>value>.46)&&geometry.headFootVertexDistances.every(value=>Number.isFinite(value)&&value>1e-4)
  &&Math.max(geometry.size[0],geometry.size[2])>1.2&&geometry.size[1]<1.05&&geometry.box.min.y>=-.055&&geometry.box.min.y<.09;

test('death builds genuine fifteen-body Cannon worlds with anatomical joint constraints and no scene walls',async()=>{
  for(const team of [0,1]){
    const actor=await character(team);await animate(actor,'crouch');beginCharacterDeath(actor,{crouching:true},0);const state=actor.userData.deathState;
    assert.ok(state.world instanceof CANNON.World);assert.equal(state.bodies.length,15);assert.equal(state.world.bodies.length,16);assert.equal(state.world.constraints.length,14);
    assert.equal(state.joints.filter(joint=>joint.constraint instanceof CANNON.HingeConstraint).length,4);
    assert.equal(state.joints.filter(joint=>joint.constraint instanceof CANNON.ConeTwistConstraint).length,10);
    assert.equal(state.world.gravity.y,-9.81);assert.ok(state.world.bodies.filter(body=>body.mass===0).every(body=>body.shapes[0] instanceof CANNON.Plane));
    assert.equal(state.world.allowSleep,false);assert.ok(state.bodies.every(body=>!body.allowSleep),'Connected limbs must not become sleeping solver anchors independently');
    assert.equal(state.bindings.filter(({body})=>body.shapes[0] instanceof CANNON.Cylinder).length,10,'Eight limbs and both trunk segments use rounded compound proxies');
    for(const {bone,body}of state.bindings)if(bone.name.startsWith('hand_'))assert.equal(body.material.name,'glove');
    const deckContacts=state.world.contactmaterials.filter(item=>item.materials.some(material=>material.name==='deck'));
    assert.equal(deckContacts.length,2);for(const contact of deckContacts)assert.equal(contact.friction,contact.materials.some(material=>material.name==='glove')?.03:.15);
    assert.ok(actor.userData.deathStats.contactVertices>100);checkOffsets(actor);clearCharacterDeath(actor);assert.equal(state.world,null);assert.equal(state.handMaterial,null);
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
    const head=point(actor,'head_0'),hip=point(actor,'pelvis');assert.ok(Math.abs(head.y-hip.y)/head.distanceTo(hip)<=.6,'The trunk drops rather than freezing in a supported sitting posture');
    assert.ok(extendedLowerBody({headAnkles:['L','R'].map(side=>point(actor,'ankle_'+side).distanceTo(point(actor,'head_0'))),legSpans:['L','R'].map(side=>point(actor,'leg_upper_'+side).distanceTo(point(actor,'ankle_'+side)))}),'At least one leg reaches away from the head or both hip-to-ankle chains retain broad spans');
    assert.equal(data.deathStats.frozen,true);assert.equal(data.deathStats.horizontalContacts,false);assert.equal(data.deathState.world,null);
  }
});

test('exact public seated and shoulder supports fall naturally while their former frozen upright poses remain negatives',async()=>{
 for(const name of ['freight-death-seated-support.json','freight-death-shoulder-support.json']){
  const {actor,fixture}=await capturedCharacter(name),data=actor.userData,initial=point(actor,'pelvis');
  beginCharacterDeath(actor,fixture.initial.player,fixture.initial.ground);assert.ok(initial.distanceTo(point(actor,'pelvis'))<1e-4);
  let maxGap=0,maxAngle=0;
  for(let frame=0;frame<360;frame++){advanceCharacterDeath(actor,1/120);const stats=data.deathStats;maxGap=Math.max(maxGap,stats.maxJointGap);maxAngle=Math.max(maxAngle,stats.maxBendViolation,stats.maxTwistViolation,stats.maxSwingViolation);checkOffsets(actor);}
  const geometry=corpseGeometry(actor),detail={geometry,maxGap,maxAngle,stats:data.deathStats};
  assert.ok(maxGap<.055&&maxAngle<.2,JSON.stringify(detail));assert.ok(spreadGeometry(geometry),JSON.stringify(detail));
  // The exact SAS support now lands half-reclined (measured .408), with two
  // spread legs and a <.68 m body height; the former .681 sitting pose remains
  // a negative below. The Phoenix fixture remains near horizontal (.025).
  assert.ok(geometry.torsoVerticalRatio<(name.includes('shoulder')?.5:.35),'The actual supported trunk falls below its captured upright pose');
  assert.ok(point(actor,'pelvis').distanceTo(initial)<1.5,'Natural collapse does not require a large displacement');
  assert.ok(data.deathStats.maxJointGap<.03&&Math.max(data.deathStats.maxBendViolation,data.deathStats.maxTwistViolation,data.deathStats.maxSwingViolation)<.06);
  assert.equal(data.deathStats.frozen,true);assert.equal(data.deathState.world,null);
  for(const pose of fixture.supportedPose){const bone=data.bones[pose.name];bone.position.fromArray(pose.position);bone.quaternion.fromArray(pose.rotation);bone.scale.fromArray(pose.scale);}
  actor.updateMatrixWorld(true);checkOffsets(actor);const sitting=corpseGeometry(actor);
  assert.ok(sitting.headHip>.60&&sitting.torsoVerticalRatio>.6,'The genuine negative has intact bones but an upright supported trunk');
  assert.equal(spreadGeometry(sitting),false,'A low pelvis or intact source proportions alone cannot validate a seated corpse');
 }
});

test('only a slowly changing loaded sleeve/ground brace unlocks passive cloth and waist motion',async()=>{
  for(const name of ['freight-death-shoulder-support.json','freight-death-seated-support.json','freight-death-running-tripod.json']){
    const {actor,fixture}=await capturedCharacter(name),data=actor.userData;beginCharacterDeath(actor,fixture.initial.player,fixture.initial.ground);
    const state=data.deathState,world=state.world,waist=state.joints.find(joint=>joint.name==='spine_0'),materials=world.contactmaterials;
    assert.equal(waist.angle,45*Math.PI/180);assert.equal(waist.constraint.angle,waist.angle);
    assert.ok(materials.filter(cm=>!cm.materials.some(m=>m.name==='deck')).every(cm=>cm.friction===.08));
    assert.equal(materials.find(cm=>cm.materials.some(m=>m.name==='deck')&&cm.materials.some(m=>m.name==='glove')).friction,.03);
    const filters=state.bodies.map(body=>[body.collisionFilterGroup,body.collisionFilterMask]),normalParameters=materials.map(cm=>[cm.contactEquationStiffness,cm.contactEquationRelaxation,cm.restitution]);
    let measuredRelease=false;
    for(let frame=0;frame<360;frame++){
      advanceCharacterDeath(actor,1/120);checkOffsets(actor);
      if(data.deathStats.supportedClothSlip&&state.world){
        measuredRelease=true;const proof=data.deathStats.supportReleaseProof;
        assert.ok(proof.age>1&&proof.sustainedSeconds>=.02&&proof.torsoRatio>.6&&Math.abs(proof.tiltRate)<.2);
        assert.ok(proof.armGroundLoad>5&&proof.sleeveChestLoad>5&&proof.hipSpeed<.6&&proof.chestSpeed<.6&&proof.hipAngularSpeed<1.5&&proof.chestAngularSpeed<1.5);
        assert.ok(Object.values(proof).every(Number.isFinite),'Trigger evidence contains scalars only');
        assert.equal(waist.angle,60*Math.PI/180);assert.equal(waist.constraint.angle,waist.angle);
        for(const cm of materials){const deck=cm.materials.some(m=>m.name==='deck');assert.equal(cm.friction,deck&&!cm.materials.some(m=>m.name==='glove')?.15:0);}
        assert.deepEqual(state.bodies.map(body=>[body.collisionFilterGroup,body.collisionFilterMask]),filters);
        assert.deepEqual(materials.map(cm=>[cm.contactEquationStiffness,cm.contactEquationRelaxation,cm.restitution]),normalParameters);
        const hold=state.supportSlide.hold,steps=data.deathStats.physicsSteps,passes=data.deathStats.contactPasses,pose=point(actor,'head_0');
        advanceCharacterDeath(actor,0);assert.equal(state.supportSlide.hold,hold);assert.equal(data.deathStats.physicsSteps,steps);assert.equal(data.deathStats.contactPasses,passes);assert.ok(point(actor,'head_0').equals(pose));
      }
    }
    assert.equal(measuredRelease,name.includes('shoulder'));assert.equal(data.deathStats.supportedClothSlip,measuredRelease);
    assert.equal(state.world,null);assert.equal(state.supportSlide,null);assert.equal(state.material,null);assert.equal(state.handMaterial,null);
    const proof=data.deathStats.supportReleaseProof,steps=data.deathStats.physicsSteps;advanceCharacterDeath(actor,.1);
    assert.deepEqual(data.deathStats.supportReleaseProof,proof);assert.equal(data.deathStats.physicsSteps,steps);clearCharacterDeath(actor);assert.equal(data.deathState,null);assert.equal(data.deathStats,null);
  }
});

test('running death phases allow a natural bent near leg while rejecting a bilateral curled-leg pile',async()=>{
  for(const team of [0,1])for(const phase of [.1,.3,.5,.7])for(const direction of ['back','left','right']){
    const yaw=Math.PI,actor=await character(team,{yaw}),data=actor.userData;actor.position.set(0,0,0);await animate(actor,'run:'+phase);
    data.lastLivingVelocity=[0,0,.8438408765734451];data.deathDirection=directionVector(direction,yaw);beginCharacterDeath(actor,{},0);settle(actor);checkOffsets(actor);
    const geometry=corpseGeometry(actor),stats=data.deathStats,detail={team,phase,direction,geometry,stats};
    assert.ok(spreadGeometry(geometry),JSON.stringify(detail));assert.ok(stats.maxJointGap<.03&&stats.maxBendViolation<.06&&stats.maxTwistViolation<.06&&stats.maxSwingViolation<.06,JSON.stringify(detail));
    assert.equal(stats.frozen,true);assert.equal(data.deathState.world,null);
  }
  const {actor:bentActor}=await capturedCharacter('freight-death-bent-leg.json');checkOffsets(bentActor);
  const geometry=corpseGeometry(bentActor);
  // Two independently captured public deaths (SAS and Phoenix) have a boot
  // nearer than 0.9 m to the head yet retain a >1.2 m body span and separated
  // meshes. The exact SAS capture has 0.522 m of head-to-boot vertex distance.
  // Its complete captured pose preserves this valid asymmetry independently
  // of later physics tuning: the old per-boot gate rejects it.
  assert.ok(geometry.headAnkles.some(value=>value<.9),JSON.stringify(geometry));assert.ok(spreadGeometry(geometry));
  // Construct a deliberately unwanted bilateral curl from the same full GLB:
  // reflect its bent right-leg segment directions about the anatomical hip
  // plane. This keeps actual bone offsets/scales, so a bone-length-only check
  // cannot accept a pile with both boots gathered toward the head.
  const bones=bentActor.userData.bones,normal=point(bentActor,'leg_upper_R').sub(point(bentActor,'leg_upper_L')).normalize(),targets={};
  for(const [bone,child]of [['leg_upper_R','leg_lower_R'],['leg_lower_R','ankle_R'],['ankle_R','ball_R']]){
    const direction=point(bentActor,child).sub(point(bentActor,bone)).normalize();targets[bone.replace('_R','_L')]=direction.addScaledVector(normal,-2*direction.dot(normal));
  }
  for(const [name,child]of [['leg_upper_L','leg_lower_L'],['leg_lower_L','ankle_L'],['ankle_L','ball_L']]){
    const bone=bones[name],direction=point(bentActor,child).sub(point(bentActor,name)).normalize(),rotation=new THREE.Quaternion().setFromUnitVectors(direction,targets[name]).multiply(bone.getWorldQuaternion(new THREE.Quaternion()));
    bone.quaternion.copy(bone.parent.getWorldQuaternion(new THREE.Quaternion()).invert().multiply(rotation));bentActor.updateMatrixWorld(true);
  }
  checkOffsets(bentActor);const folded=corpseGeometry(bentActor);
  assert.ok(folded.headHip>.60&&folded.legSpans.every(value=>value>.46),'The negative remains a full-sized real skeleton');
  assert.ok(folded.headAnkles.every(value=>value<.9),JSON.stringify(folded));assert.equal(spreadGeometry(folded),false,'Both curled boots must not pass as a naturally bent near leg');
});

test('captured running death loses its hand/knee tripod support and lands before the respawn budget',async()=>{
  const {actor,fixture}=await capturedCharacter('freight-death-running-tripod.json'),data=actor.userData,ground=fixture.initial.ground;
  const initial=point(actor,'pelvis');beginCharacterDeath(actor,fixture.initial.player,ground);assert.ok(initial.distanceTo(point(actor,'pelvis'))<1e-4);
  let maxGap=0,maxBend=0,maxTwist=0,maxSwing=0,landing=null;
  for(let frame=0;frame<360;frame++){
    advanceCharacterDeath(actor,1/120);const stats=data.deathStats;maxGap=Math.max(maxGap,stats.maxJointGap);maxBend=Math.max(maxBend,stats.maxBendViolation);maxTwist=Math.max(maxTwist,stats.maxTwistViolation);maxSwing=Math.max(maxSwing,stats.maxSwingViolation);checkOffsets(actor);
    if(frame===251)landing=corpseGeometry(actor);
  }
  const geometry=corpseGeometry(actor),stats=data.deathStats,detail={geometry,landing,stats,maxGap,maxBend,maxTwist,maxSwing},head=point(actor,'head_0'),hip=point(actor,'pelvis');
  assert.ok(maxGap<.055&&maxBend<.2&&maxTwist<.2&&maxSwing<.2,JSON.stringify(detail));
  assert.ok(landing.size[1]<1.05&&geometry.size[1]<1.05,'The exact former half-kneel is already down at 2.1 seconds');
  assert.ok(spreadGeometry(geometry),JSON.stringify(detail));assert.ok(Math.abs(head.y-hip.y)/head.distanceTo(hip)<.35,'Torso is near horizontal, rather than freezing while propped up');
  assert.ok(stats.maxJointGap<.03&&stats.maxBendViolation<.06&&stats.maxTwistViolation<.06&&stats.maxSwingViolation<.06,JSON.stringify(detail));
  assert.equal(stats.frozen,true);assert.equal(data.deathState.world,null);assert.equal(data.deathState.bodies.length,0);assert.equal(data.deathState.joints.length,0);
});

test('captured natural double-bent knees stay spread while maximally curled legs cannot pass on bone lengths alone',async()=>{
  const {actor}=await capturedCharacter('freight-death-bent-knees.json');checkOffsets(actor);const natural=corpseGeometry(actor);
  assert.ok(natural.headAnkles.every(value=>value<.9),'The saved natural pose reproduces the distance heuristic false positive');
  assert.ok(natural.legSpans.every(value=>value>.60)&&spreadGeometry(natural),'Both actual 0.885 m leg chains retain over 68% of their span while bending');
  for(const side of ['L','R']){
    const thigh=point(actor,'leg_lower_'+side).sub(point(actor,'leg_upper_'+side)).normalize(),calf=point(actor,'ankle_'+side).sub(point(actor,'leg_lower_'+side)).normalize(),axis=new THREE.Vector3().crossVectors(thigh,calf).normalize(),bone=actor.userData.bones['leg_lower_'+side];
    const rotation=new THREE.Quaternion().setFromAxisAngle(axis,105*Math.PI/180-thigh.angleTo(calf)).multiply(bone.getWorldQuaternion(new THREE.Quaternion()));
    bone.quaternion.copy(bone.parent.getWorldQuaternion(new THREE.Quaternion()).invert().multiply(rotation));actor.updateMatrixWorld(true);
  }
  checkOffsets(actor);const curled=corpseGeometry(actor);
  assert.ok(curled.headHip>.60&&curled.legSpans.every(value=>value>.46),'The negative preserves real torso and limb lengths');
  assert.ok(curled.legSpans.every(value=>value<.60)&&curled.headAnkles.every(value=>value<.9),JSON.stringify(curled));
  assert.equal(extendedLowerBody(curled),false);assert.equal(spreadGeometry(curled),false);
});

test('captured side-running corpse keeps one long leg while its other knee bends naturally',async()=>{
  const {actor}=await capturedCharacter('freight-death-extended-leg.json');checkOffsets(actor);const geometry=corpseGeometry(actor);
  assert.ok(geometry.headAnkles.every(value=>value<.9)&&geometry.legSpans.some(value=>value<.60),'The exact native side-run pose reproduces both older distance gates');
  assert.ok(Math.max(...geometry.legSpans)>.75&&Math.max(...geometry.headAnkles)>.8&&spreadGeometry(geometry),JSON.stringify(geometry));
  assert.ok(geometry.headFootVertexDistances.every(value=>value>.4),'Both boot vertex sets remain away from the head in the captured complete mesh');
});

test('physics substeps preserve accumulated time across render phases and bound the complete corpse budget',async()=>{
  const actor=await character(),data=actor.userData;await animate(actor);beginCharacterDeath(actor,{},0);const world=data.deathState.world,calls=[],step=world.step.bind(world);
  world.step=(dt,...args)=>{calls.push(dt);return step(dt,...args);};
  for(let frame=0;frame<8;frame++)advanceCharacterDeath(actor,1/240);
  assert.equal(data.deathStats.physicsSteps,6);assert.equal(data.deathStats.physicsStepSeconds,1/180);assert.equal(world.dt,1/180);
  advanceCharacterDeath(actor,.1);assert.equal(data.deathStats.physicsSteps,24);assert.ok(calls.every(dt=>dt===1/180));
  assert.ok(Math.abs(world.time-data.deathStats.age)<1e-9,'The accumulator retains render-phase fractions');
  for(let frame=0;frame<30;frame++)advanceCharacterDeath(actor,.1);
  assert.ok(data.deathStats.physicsSteps<=504);assert.ok(data.deathStats.age<=2.8);assert.equal(data.deathState.world,null);
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
    assert.ok(data.deathStats.age<=2.8);assert.equal(data.deathStats.physicsStepSeconds,1/180);assert.ok(data.deathStats.physicsSteps<=504);assert.equal(data.deathStats.frozen,true);
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
    actor.updateMatrixWorld(true);const initialHip=point(actor,'pelvis').y;beginCharacterDeath(actor,{},0);let maxHip=initialHip,maxSpeed=0,maxCoreSpeed=0,maxGap=0;
    const state=data.deathState,bindings=[...state.bindings],world=state.world,bodies=[...state.bodies];
    // Include angular kinetic energy in each body's principal-inertia frame.
    // A light freely swinging hand can exceed 8 m/s without creating energy;
    // core speed and energy growth distinguish that motion from an explosion.
    const energy=()=>bodies.reduce((sum,body)=>{const spin=body.vectorToLocalFrame(body.angularVelocity),inertia=body.inertia;return sum+body.mass*9.81*body.position.y+.5*body.mass*body.velocity.lengthSquared()+.5*(inertia.x*spin.x*spin.x+inertia.y*spin.y*spin.y+inertia.z*spin.z*spin.z);},0);
    const initialEnergy=energy();let maxEnergy=initialEnergy,energySamples=0;const step=world.step.bind(world);
    world.step=(...args)=>{step(...args);energySamples++;maxEnergy=Math.max(maxEnergy,energy());for(const {bone,body}of bindings){assert.ok(Number.isFinite(body.velocity.length()));if(['pelvis','spine_0','head_0'].includes(bone.name))maxCoreSpeed=Math.max(maxCoreSpeed,body.velocity.length());}};
    for(let frame=0;frame<180;frame++){advanceCharacterDeath(actor,1/60);maxHip=Math.max(maxHip,point(actor,'pelvis').y);maxSpeed=Math.max(maxSpeed,data.deathStats.maxSpeed);maxGap=Math.max(maxGap,data.deathStats.maxJointGap);checkOffsets(actor);}
    const detail={team,offset,maxHip,initialHip,maxSpeed,maxCoreSpeed,maxGap,initialEnergy,maxEnergy,energySamples,stats:data.deathStats};
    assert.ok(maxHip<initialHip+(offset<0?.15:.55),JSON.stringify(detail));assert.ok(maxGap<.09,JSON.stringify(detail));
    if(offset<0)assert.ok(maxSpeed<8,JSON.stringify(detail));else{assert.ok(maxCoreSpeed<8,JSON.stringify(detail));assert.ok(maxEnergy<=initialEnergy*1.01,JSON.stringify(detail));assert.equal(energySamples,data.deathStats.physicsSteps);}
    assert.equal(data.deathStats.frozen,true);assert.equal(data.deathState.world,null);const box=bounds(actor);assert.ok(box.min.y>-.055&&box.min.y<.09,JSON.stringify({team,offset,bounds:box.min.toArray()}));
    const geometry=corpseGeometry(actor);assert.ok(geometry.torsoVerticalRatio<=.6,JSON.stringify(geometry));
  }
});
