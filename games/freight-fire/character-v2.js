import * as THREE from './vendor/three.module.js';
import { GLTFLoader } from './vendor/GLTFLoader.js';
import { clone } from './vendor/SkeletonUtils.js';
import { WEAPONS, floorAt, resolveWorldSphere } from './sim.js';
import { declareAsset, loadGLTF } from './asset-loading.js';

// Original CS2 SAS/Phoenix meshes and their own skeleton animations.
// Valve retains their rights: assets/characters-cs2/README.md.
let library, loading;
const clamp = (v,a,b) => Math.max(a,Math.min(b,v));
const vector = () => new THREE.Vector3();
const sourceBasisInverse = new THREE.Matrix4().makeRotationFromQuaternion(new THREE.Quaternion(-.5,-.5,-.5,.5)).invert();
const trackNode = track => THREE.PropertyBinding.parseTrackName(track.name).nodeName;
const contactDirections=[];for(const x of [-1,0,1])for(const y of [-1,0,1])for(const z of [-1,0,1])if(x||y||z)contactDirections.push([x,y,z]);
const modelBase=new URL('./assets/characters-cs2/',import.meta.url);
const modelAssets=[['ct-sas.glb',3974156,'保卫者人物'],['t-phoenix.glb',4804936,'潜伏者人物'],['animations.glb',4802692,'人物动作']];
for(const [path,bytes,label]of modelAssets)declareAsset(new URL(path,modelBase),{bytes,label,group:'characters'});

export async function loadCharacters() {
  if(library) return library;
  if(!loading) loading=(async()=>{
    const loader=new GLTFLoader();
    const [defender,raider,animationSource]=await Promise.all(modelAssets.map(([path,bytes,label])=>loadGLTF(loader,new URL(path,modelBase),{bytes,label,group:'characters'})));
    for(const source of [defender,raider]) {
      const names=new Set();source.scene.traverse(o=>names.add(o.name));
      source.animations=animationSource.animations.map(original=>{const clip=original.clone();clip.tracks=clip.tracks.filter(t=>names.has(trackNode(t)));return clip;});
    }
    library={defender,raider};return library;
  })().catch(error=>{loading=null;throw error;});
  return loading;
}

function familyOf(p) {return p.weapon===4||p.weapon==='knife'?'knife':p.weapon===3||p.weapon==='usp'?'pistol':'rifle';}
function locomotion(p) {
  if(!p.alive)return 'death';
  const family=familyOf(p),speed=Math.hypot(p.vx||0,p.vz||0);
  if(p.grounded===false && Math.abs(p.vy||0)>.2)return family+'/jump';
  if(p.crouching)return family+(speed>.25?'/crouchMove':'/crouchIdle');
  if(speed<.25)return family+'/idle';
  if(p.walking)return family+'/walk';
  const c=Math.cos(p.yaw||0),s=Math.sin(p.yaw||0),right=c*(p.vx||0)-s*(p.vz||0),forward=-s*(p.vx||0)-c*(p.vz||0);
  return family+'/run_'+(Math.abs(forward)>=Math.abs(right)?forward>=0?'n':'s':right>=0?'e':'w');
}

function playBase(data,name) {
  if(data.currentAction===name)return;
  const wanted=data.actions[name];if(!wanted)return;
  for(const action of Object.values(data.actions))if(action!==wanted)action.fadeOut(name==='death'?.075:.13);
  wanted.reset().setEffectiveTimeScale(1).setEffectiveWeight(1).setLoop(name==='death'?THREE.LoopOnce:THREE.LoopRepeat,name==='death'?1:Infinity);
  wanted.clampWhenFinished=name==='death';wanted.fadeIn(name==='death'?.075:.13).play();data.currentAction=name;
}

/** Native clips own every wrist/finger pose; weapons follow their authored wpn anchor. */
export function makeCharacterV2(team=0,makeGun) {
  if(!library)throw Error('Await loadCharacters() before creating a Freight Fire character.');
  const source=team===0||team==='blue'||team==='defender'?library.defender:library.raider;
  const group=new THREE.Group(),visual=new THREE.Group(),skin=clone(source.scene);
  group.add(visual);visual.add(skin);skin.rotation.y=Math.PI;
  const bones={},rest=new Map(),contactSamples=[];
  skin.traverse(o=>{
    if(o.isBone){bones[o.name]=o;rest.set(o,{position:o.position.clone(),quaternion:o.quaternion.clone(),scale:o.scale.clone()});}
    if(o.isMesh){o.castShadow=true;o.receiveShadow=true;o.frustumCulled=false;for(const m of [].concat(o.material)){if(m?.map)m.map.anisotropy=4;m.envMapIntensity=.45;}}
    if(o.isSkinnedMesh){
      const positions=o.geometry.getAttribute('position'),indices=o.geometry.getAttribute('skinIndex'),weights=o.geometry.getAttribute('skinWeight'),extremes=new Map();
      const used=o.geometry.index?new Set(o.geometry.index.array):Array.from({length:positions.count},(_,i)=>i);
      for(const i of used){let strongest=0;for(let k=1;k<4;k++)if(weights.getComponent(i,k)>weights.getComponent(i,strongest))strongest=k;const bone=indices.getComponent(i,strongest);
        for(let direction=0;direction<contactDirections.length;direction++){const [x,y,z]=contactDirections[direction],key=bone+','+direction,value=positions.getX(i)*x+positions.getY(i)*y+positions.getZ(i)*z,old=extremes.get(key);if(!old||value>old.value)extremes.set(key,{index:i,value});}
      }
      contactSamples.push({mesh:o,indices:[...new Set([...extremes.values()].map(x=>x.index))]});
    }
  });
  const mixer=new THREE.AnimationMixer(skin),actions={};
  for(const clip of source.animations)actions[clip.name]=mixer.clipAction(clip);
  const upperNames=new Set();skin.getObjectByName('spine_3')?.traverse(o=>upperNames.add(o.name));skin.getObjectByName('wpnPivot')?.traverse(o=>upperNames.add(o.name));
  const upperActions={};
  for(const family of ['rifle','pistol','knife']) {
    const reference=source.animations.find(a=>a.name===family+'/idle');
    for(const mode of ['shoot','reload']) {
      const authored=source.animations.find(a=>a.name===family+'/'+mode);if(!authored||!reference)continue;
      const clip=authored.clone();clip.name='upper/'+authored.name;clip.tracks=clip.tracks.filter(t=>upperNames.has(trackNode(t)));
      THREE.AnimationUtils.makeClipAdditive(clip,0,reference,30);upperActions[family+'/'+mode]=mixer.clipAction(clip);
    }
  }
  Object.assign(group.userData,{characterV2:true,nativeCharacter:true,team,skin,visual,bones,mixer,actions,upperActions,rest,contactSamples,rawPose:new Map(),
    currentAction:'',makeGun,weaponId:null,gun:null,anchor:skin.getObjectByName('wpn'),aimBone:skin.getObjectByName('spine_3'),dead:false,elapsed:0,deathAge:0,upperUntil:0,raisedWeight:0,raisedUntil:0});
  playBase(group.userData,'rifle/idle');mixer.update(.001);updateCharacterV2(group,{alive:true,weapon:0,pitch:0},.001,0);return group;
}

export function characterEvent(group,event,time=0) {
  const d=group?.userData;if(!d?.characterV2||d.dead)return;
  if(event.type==='shot'||event.type==='reload')d.raisedUntil=Math.max(d.raisedUntil,time+(event.type==='reload'?Math.max(.3,(event.until??time+.7)-time):.35));
  const family=event.weapon===4?'knife':event.weapon===3?'pistol':'rifle',mode=event.type==='reload'?'reload':'shoot',action=d.upperActions[family+'/'+mode];
  if(!action)return;
  for(const other of Object.values(d.upperActions))if(other!==action)other.fadeOut(.04);
  const duration=mode==='reload'&&Number.isFinite(event.until)?Math.max(.1,event.until-(event.time??time)):action.getClip().duration/(event.heavy?.8:1);
  action.reset().setEffectiveWeight(1).setLoop(THREE.LoopOnce,1).setEffectiveTimeScale(action.getClip().duration/duration).fadeIn(.035).play();action.clampWhenFinished=false;
  d.upperUntil=time+duration;d.upperMode=mode;
}

function restoreRawPose(data) {
  // AnimationMixer skips writes for constant tracks. Restore the previous raw
  // pose before aiming, so aiming never accumulates on those tracks.
  for(const [bone,pose]of data.rawPose){bone.quaternion.copy(pose.q);bone.position.copy(pose.p);}
}
function recordRawPose(data) {for(const bone of Object.values(data.bones)){const previous=data.rawPose.get(bone);if(previous){previous.q.copy(bone.quaternion);previous.p.copy(bone.position);}else data.rawPose.set(bone,{q:bone.quaternion.clone(),p:bone.position.clone()});}}
function solveGripArm(data,side,target,orientation) {
  const shoulder=data.bones['arm_upper_'+side],elbow=data.bones['arm_lower_'+side],hand=data.bones['hand_'+side];if(!shoulder||!elbow||!hand)return;
  const a=shoulder.getWorldPosition(vector()),b=elbow.getWorldPosition(vector()),c=hand.getWorldPosition(vector()),upper=a.distanceTo(b),lower=b.distanceTo(c),towards=target.clone().sub(a),distance=clamp(towards.length(),Math.abs(upper-lower)+.0001,upper+lower-.0001);towards.normalize();
  // Keep the native elbow's bend side while solving the two fixed bone lengths.
  const bend=b.clone().sub(a).addScaledVector(towards,-b.clone().sub(a).dot(towards));if(bend.lengthSq()<.000001)bend.set(-1,-1,.2);bend.normalize();
  const along=(upper*upper+distance*distance-lower*lower)/(2*distance),height=Math.sqrt(Math.max(0,upper*upper-along*along)),desiredElbow=a.clone().addScaledVector(towards,along).addScaledVector(bend,height),desiredHand=a.clone().addScaledVector(towards,distance);
  const turn=(bone,oldDirection,newDirection)=>{const q=new THREE.Quaternion().setFromUnitVectors(oldDirection.normalize(),newDirection.normalize()).multiply(bone.getWorldQuaternion(new THREE.Quaternion()));bone.quaternion.copy(bone.parent.getWorldQuaternion(new THREE.Quaternion()).invert().multiply(q));bone.updateWorldMatrix(false,true);};
  turn(shoulder,b.clone().sub(a),desiredElbow.clone().sub(a));const actualElbow=elbow.getWorldPosition(vector());turn(elbow,hand.getWorldPosition(vector()).sub(actualElbow),desiredHand.sub(actualElbow));
  hand.quaternion.copy(hand.parent.getWorldQuaternion(new THREE.Quaternion()).invert().multiply(orientation));hand.updateWorldMatrix(false,true);
}
function updateGun(group,p,dt,time) {
  const d=group.userData,id=typeof p.weapon==='string'?p.weapon:WEAPONS[p.weapon||0]?.id||'m4a1';
  if(d.makeGun&&id!==d.weaponId){if(d.gun){disposeNativeWeapon(d.gun);d.gun.removeFromParent();}d.gun=d.makeGun(id,{native:true});d.weaponId=id;if(d.gun)d.visual.add(d.gun);}
  if(!d.gun||!d.anchor)return;
  group.updateMatrixWorld(true);
  const anchor=d.anchor.matrixWorld.clone(),pitch=clamp(Number(p.pitch)||0,-1.35,1.35),knife=id==='knife';
  const raised=knife||p.aiming||time<d.raisedUntil?1:0;d.raisedWeight+=(raised-d.raisedWeight)*(1-Math.exp(-dt*(raised?16:9)));
  const lower=(1-d.raisedWeight)*(id==='usp'?.45:.36),posePitch=clamp(pitch-lower,-1.35,1.35);d.weaponPosePitch=posePitch;
  const grips=d.gun.userData.nativeGrip,rightWrist=d.bones.hand_R,weaponWorld=anchor.clone().multiply(sourceBasisInverse);
  const local=new THREE.Matrix4().copy(d.visual.matrixWorld).invert().multiply(weaponWorld);
  local.decompose(d.gun.position,d.gun.quaternion,d.gun.scale);d.gun.updateMatrixWorld(true);
  d.weaponAnchorMatrix=anchor.clone();
  d.supportError=null;d.rightGripError=null;
  if(grips){
    const reloading=d.upperMode==='reload'&&time<d.upperUntil;
    if(!knife&&rightWrist&&d.gun.userData.muzzle){
      const wrist=rightWrist.getWorldPosition(vector()),currentAxis=d.gun.userData.muzzle.getWorldDirection(vector()),desiredAxis=new THREE.Vector3(0,Math.sin(posePitch),-Math.cos(posePitch)).applyQuaternion(group.getWorldQuaternion(new THREE.Quaternion())),rotation=new THREE.Quaternion().setFromUnitVectors(currentAxis,desiredAxis),transform=new THREE.Matrix4().makeTranslation(wrist.x,wrist.y,wrist.z).multiply(new THREE.Matrix4().makeRotationFromQuaternion(rotation)).multiply(new THREE.Matrix4().makeTranslation(-wrist.x,-wrist.y,-wrist.z));weaponWorld.premultiply(transform);
      const authoredRight=new THREE.Matrix4().copy(weaponWorld).multiply(new THREE.Matrix4().fromArray(grips.right)),desiredRight=wrist.clone();desiredRight.y-=(1-d.raisedWeight)*(p.crouching?.10:.16);const delta=desiredRight.sub(new THREE.Vector3().setFromMatrixPosition(authoredRight));weaponWorld.premultiply(new THREE.Matrix4().makeTranslation(delta.x,delta.y,delta.z));
      local.copy(d.visual.matrixWorld).invert().multiply(weaponWorld);local.decompose(d.gun.position,d.gun.quaternion,d.gun.scale);d.gun.updateMatrixWorld(true);
    }else if(rightWrist){weaponWorld.copy(rightWrist.matrixWorld).multiply(new THREE.Matrix4().fromArray(grips.right).invert());local.copy(d.visual.matrixWorld).invert().multiply(weaponWorld);local.decompose(d.gun.position,d.gun.quaternion,d.gun.scale);d.gun.updateMatrixWorld(true);}
    const applyHand=side=>{const target=new THREE.Matrix4().copy(d.gun.matrixWorld).multiply(new THREE.Matrix4().fromArray(side==='R'?grips.right:grips.left)),position=vector(),orientation=new THREE.Quaternion(),scale=vector();target.decompose(position,orientation,scale);solveGripArm(d,side,position,orientation);return d.bones['hand_'+side].getWorldPosition(vector()).distanceTo(position);};
    if(!knife)d.rightGripError=applyHand('R');
    for(const [name,quaternion]of Object.entries(grips.fingers||{}))if(d.bones[name]&&(!reloading||!name.endsWith('L')))d.bones[name].quaternion.fromArray(quaternion);
    if(!knife&&!reloading)d.supportError=applyHand('L');
    group.updateMatrixWorld(true);
  }
  if(!d.gun.userData.muzzle){
    const direction=new THREE.Vector3(0,Math.sin(posePitch),-Math.cos(posePitch)).applyQuaternion(group.getWorldQuaternion(new THREE.Quaternion()));let best=-Infinity;const tip=vector(),vertices=[];let count=0;
    d.gun.traverse(mesh=>{if(!mesh.isMesh)return;if(mesh.isSkinnedMesh)mesh.skeleton.update();const positions=mesh.geometry.getAttribute('position'),used=mesh.geometry.index?new Set(mesh.geometry.index.array):Array.from({length:positions.count},(_,i)=>i);
      for(const i of used){const world=mesh.getVertexPosition(i,vector()).applyMatrix4(mesh.matrixWorld),projection=world.dot(direction);best=Math.max(best,projection);vertices.push({world,projection});}
    });
    for(const {world,projection}of vertices)if(projection>=best-.002){tip.add(world);count++;}
    tip.divideScalar(Math.max(1,count));const muzzle=new THREE.Object3D();muzzle.name='world_muzzle';const parent=d.gun.getObjectByName('weapon')||d.gun;muzzle.position.copy(parent.worldToLocal(tip));parent.add(muzzle);d.gun.userData.muzzle=muzzle;
  }
}

function groundCorpse(group,p) {
  const d=group.userData;
  // Recompute vertical contact from the current authored frame. Carrying the
  // previous correction forward makes the final body hover above the deck.
  d.visual.position.y=0;
  group.updateMatrixWorld(true);d.skin.traverse(o=>{if(o.isSkinnedMesh)o.skeleton.update();});
  const bounds=new THREE.Box3();for(const {mesh,indices}of d.contactSamples)for(const index of indices)bounds.expandByPoint(mesh.getVertexPosition(index,vector()).applyMatrix4(mesh.matrixWorld));
  const ground=floorAt(p.x,p.z,(p.y||0)+.22);
  const minimum=ground+.025,lift=Math.max(0,minimum-bounds.min.y);
  if(lift>0)d.visual.position.y+=Math.min(.55,lift);
  const contacts=['pelvis','spine_3','head_0','leg_lower_L','leg_lower_R','arm_lower_L','arm_lower_R'];
  const push=vector();let count=0;
  for(const name of contacts){const bone=d.bones[name];if(!bone)continue;const original=bone.getWorldPosition(vector()),resolved=original.clone();resolveWorldSphere(resolved,name==='pelvis'?.17:name==='head_0'?.12:.09,null);const delta=resolved.sub(original);delta.y=0;if(delta.lengthSq()>1e-7){push.add(delta);count++;}}
  if(count){push.divideScalar(count).clampLength(0,.2);const q=group.getWorldQuaternion(new THREE.Quaternion()).invert();d.visual.position.add(push.applyQuaternion(q));}
  group.updateMatrixWorld(true);
  d.deathStats={age:d.deathAge,clip:'death',source:'Valve CS2 death_chest_a',once:true,groundContacts:true,contactVertices:d.contactSamples.reduce((n,s)=>n+s.indices.length,0),frozen:d.deathAge>=d.actions.death.getClip().duration};
}

/** Caller owns living position/yaw. Authored death plays once, holds until respawn. */
export function updateCharacterV2(group,p,dt=1/60,time) {
  const d=group.userData;if(!d.characterV2)return;dt=clamp(Number(dt)||0,0,.1);d.elapsed+=dt;time=Number.isFinite(time)?time:d.elapsed;
  restoreRawPose(d);
  if(p.alive===false) {
    if(!d.dead){d.dead=true;d.deathAge=0;d.deathOrigin=group.position.clone();d.deathYaw=group.rotation.y;for(const a of Object.values(d.upperActions))a.stop();playBase(d,'death');}
    group.position.copy(d.deathOrigin);group.rotation.y=d.deathYaw;d.deathAge+=dt;d.mixer.update(dt);
    recordRawPose(d);
    d.visual.visible=true;groundCorpse(group,p);if(d.gun)d.gun.visible=false;return;
  }
  if(d.dead){d.dead=false;d.deathStats=null;d.raisedWeight=0;d.raisedUntil=0;d.visual.position.set(0,0,0);d.visual.rotation.set(0,0,0);for(const a of Object.values(d.actions))a.stop();d.currentAction='';d.rawPose.clear();for(const [bone,r]of d.rest){bone.position.copy(r.position);bone.quaternion.copy(r.quaternion);bone.scale.copy(r.scale);}}
  d.visual.visible=true;const wanted=locomotion(p);playBase(d,wanted);
  const speed=Math.hypot(p.vx||0,p.vz||0),moving=speed>.25;
  d.actions[wanted]?.setEffectiveTimeScale(moving?clamp(speed/(p.crouching?2.4:p.walking?3:5.5),.6,1.25):1);
  d.mixer.update(dt);recordRawPose(d);
  updateGun(group,p,dt,time);if(d.gun)d.gun.visible=true;
  d.poseStats={animation:wanted,native:true,weaponAnchor:!!d.anchor,authoredGrip:!!d.gun?.userData.nativeGrip,rightGripError:d.rightGripError,supportError:d.supportError,handIK:d.supportError!==null,raisedWeight:d.raisedWeight,stance:d.weaponId==='knife'?'knife':d.raisedWeight>.9?'raised':'hip'};
}

export function disposeCharacterV2(group) {
  const d=group?.userData;if(!d?.characterV2||d.disposed)return;d.disposed=true;
  d.mixer.stopAllAction();d.mixer.uncacheRoot(d.skin);const skeletons=new Set();group.traverse(o=>{if(o.skeleton&&!skeletons.has(o.skeleton)){skeletons.add(o.skeleton);o.skeleton.dispose();}});
  d.rawPose.clear();d.rest.clear();d.contactSamples=[];
}

function disposeNativeWeapon(gun) {const skeletons=new Set();gun.traverse(o=>{if(o.skeleton&&!skeletons.has(o.skeleton)){skeletons.add(o.skeleton);o.skeleton.dispose();}});}
