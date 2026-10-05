import * as THREE from './vendor/three.module.js';

const clamp=(value,min,max)=>Math.max(min,Math.min(max,value));
const smooth=value=>{const t=clamp(value,0,1);return t*t*(3-2*t);};
const progress=(age,delay,span)=>smooth((age-delay)/span);
const axisX=new THREE.Vector3(1,0,0),axisZ=new THREE.Vector3(0,0,1);
const hash=value=>{let result=2166136261;for(const letter of String(value))result=Math.imul(result^letter.charCodeAt(0),16777619);return result>>>0;};

function directionOf(data,group){
  const direction=data.deathDirection;
  if(!Array.isArray(direction)&&!direction?.isVector3)return 'back';
  const local=Array.isArray(direction)?new THREE.Vector3().fromArray(direction):direction.clone();
  local.y=0;
  if(local.lengthSq()<1e-8||![local.x,local.z].every(Number.isFinite))return 'back';
  local.applyQuaternion(group.getWorldQuaternion(new THREE.Quaternion()).invert());
  return Math.abs(local.x)>.35&&Math.abs(local.x)>Math.abs(local.z)*.75?local.x<0?'left':'right':'back';
}

// Author relaxed targets in character coordinates, not mirrored bone axes.
// Each limb uses the real child offset and parent rotation from its rest rig.
function aimChild(group,bone,child,direction){
  if(!bone||!child)return;
  group.updateMatrixWorld(true);
  const old=child.getWorldPosition(new THREE.Vector3()).sub(bone.getWorldPosition(new THREE.Vector3())).normalize();
  const desired=new THREE.Vector3(...direction).normalize().applyQuaternion(group.getWorldQuaternion(new THREE.Quaternion()));
  const world=new THREE.Quaternion().setFromUnitVectors(old,desired).multiply(bone.getWorldQuaternion(new THREE.Quaternion()));
  bone.quaternion.copy(bone.parent.getWorldQuaternion(new THREE.Quaternion()).invert().multiply(world));
}

function targets(group,poses,direction,variation){
  const data=group.userData,bones=data.bones;
  for(const {bone,rest}of poses){bone.position.copy(rest.position);bone.quaternion.copy(rest.quaternion);bone.scale.copy(rest.scale);}
  const spread=(variation-1)*.018;
  for(const side of ['L','R']){
    const sign=side==='L'?-1:1;
    const high=direction==='left'&&side==='R'||direction==='right'&&side==='L';
    const upper=direction==='back'?[sign*(.09+spread),-.274,-.035]:high?[-sign*.072,-.267,-.10]:[sign*.023,-.291,-.045];
    const lower=direction==='back'?[sign*.038,-.277,-.031]:high?[-sign*.035,-.257,-.095]:[sign*.016,-.276,-.04];
    aimChild(group,bones['arm_upper_'+side],bones['arm_lower_'+side],upper);
    aimChild(group,bones['arm_lower_'+side],bones['hand_'+side],lower);
    aimChild(group,bones['leg_upper_'+side],bones['leg_lower_'+side],[sign*(.026+spread*.4),-.448,side==='L'?-.018:.025]);
    aimChild(group,bones['leg_lower_'+side],bones['ankle_'+side],[sign*.008,-.421,side==='L'?.055:.085]);
  }
  group.updateMatrixWorld(true);
  const worldAxis=(direction==='back'?axisX:axisZ).clone().applyQuaternion(group.getWorldQuaternion(new THREE.Quaternion()));
  for(const pose of poses){
    pose.target=pose.bone.quaternion.clone();
    pose.lagAxis=worldAxis.clone().applyQuaternion(pose.bone.parent.getWorldQuaternion(new THREE.Quaternion()).invert());
    pose.kneeAxis=axisX.clone().applyQuaternion(group.getWorldQuaternion(new THREE.Quaternion())).applyQuaternion(pose.bone.parent.getWorldQuaternion(new THREE.Quaternion()).invert());
  }
}

function timing(name,variation){
  if(name.startsWith('arm_upper_'))return [.08+(name.endsWith('R')?.06:0),.77+variation*.02];
  if(name.startsWith('arm_lower_'))return [.17+(name.endsWith('R')?.07:0),.81];
  if(name.startsWith('hand_')||name.startsWith('finger_'))return [.25,.76];
  if(name.startsWith('leg_upper_'))return [0,.91];
  if(name.startsWith('leg_lower_')||name.startsWith('ankle_'))return [.07+(name.endsWith('R')?.06:0),.98];
  if(name.startsWith('spine_')||name==='neck_0'||name==='head_0')return [.17,.94];
  return [0,.89];
}

/** A finite staged fall; corpses never receive horizontal or joint physics. */
export function beginCharacterDeath(group,player={},ground=Number(player.y)||0){
  const data=group.userData;
  group.updateMatrixWorld(true);
  // Capture the visible post-IK pose before stopAllAction restores bindings.
  const poses=[...data.rest].map(([bone,rest])=>({bone,start:bone.quaternion.clone().normalize(),startPosition:bone.position.clone(),rest}));
  const pivot=data.bones.pelvis.getWorldPosition(new THREE.Vector3());data.visual.worldToLocal(pivot);
  const startRotation=data.visual.quaternion.clone(),startPosition=data.visual.position.clone();
  const direction=directionOf(data,group),variation=hash((player.id??'body')+':'+Math.round((player.deathAt??player.deaths??0)*1000))%3;
  data.mixer.stopAllAction();data.currentAction='';data.upperMode=null;data.upperUntil=0;data.rawPose?.clear();
  targets(group,poses,direction,variation);
  for(const pose of poses){
    const [delay,span]=timing(pose.bone.name,variation);pose.delay=delay;pose.span=span;
    pose.bone.quaternion.copy(pose.start);pose.bone.position.copy(pose.bone.name==='pelvis'?pose.startPosition:pose.rest.position);pose.bone.scale.copy(pose.rest.scale);
  }
  const rollSign=direction==='right'?-1:1,rollAxis=direction==='back'?axisX:axisZ;
  // skin's Y=PI basis makes +Z the back: +X roll falls backward, +Z roll
  // falls left, and -Z roll falls right. The authored limb targets share it.
  const settledRotation=new THREE.Quaternion().setFromAxisAngle(rollAxis,rollSign*Math.PI/2)
    .multiply(new THREE.Quaternion().setFromAxisAngle(direction==='back'?axisZ:axisX,(variation-1)*.045));
  data.deathState={age:0,duration:1.24+variation*.045,frozen:false,poses,direction,variation,rollSign,
    ground:Number.isFinite(ground)?ground:0,origin:group.position.clone(),yaw:group.rotation.y,pivot,
    startRotation,startPosition,settledRotation,braceScale:player.crouching?.3:1,
    point:new THREE.Vector3(),rotation:new THREE.Quaternion(),offset:new THREE.Vector3(),contactPasses:0,contactVertices:0};
  data.visual.visible=true;if(data.gun)data.gun.visible=false;
  return advanceCharacterDeath(group,0);
}

/** After settling or while paused, skip all animation and skin contact work. */
export function advanceCharacterDeath(group,dt=1/60){
  const data=group.userData,state=data.deathState;
  if(!state||state.frozen)return data.deathStats;
  const step=clamp(Number(dt)||0,0,.1);
  if(step===0&&state.contactPasses>0)return data.deathStats;
  state.age=Math.min(state.duration,state.age+step);
  group.position.copy(state.origin);group.rotation.y=state.yaw;
  const age=state.age,fall=progress(age,.16,.90),brace=Math.sin(Math.PI*progress(age,0,.57))*state.braceScale;
  const lag=Math.sin(Math.PI*progress(age,.08,1.02))*state.rollSign;
  for(const pose of state.poses){
    const {bone,start,target}=pose;
    bone.quaternion.slerpQuaternions(start,target,progress(age,pose.delay,pose.span));
    let angle=0,axis=pose.lagAxis;
    if(bone.name.startsWith('leg_upper_')){angle=.36*brace;axis=pose.kneeAxis;}
    else if(bone.name.startsWith('leg_lower_')){angle=-.72*brace;axis=pose.kneeAxis;}
    // Counter the hip/knee reaction at the ankle so the boot does not point
    // into the deck and lift the hips during the initial loss of support.
    else if(bone.name.startsWith('ankle_')){angle=.36*brace;axis=pose.kneeAxis;}
    else if(bone.name==='spine_0')angle=-.18*lag;
    else if(bone.name==='neck_0')angle=-.075*Math.sin(Math.PI*progress(age,.17,.94))*state.rollSign;
    if(angle)bone.quaternion.premultiply(state.rotation.setFromAxisAngle(axis,angle));
    if(bone.name==='pelvis')bone.position.lerpVectors(pose.startPosition,pose.rest.position,progress(age,.40,.70));
  }
  data.visual.quaternion.slerpQuaternions(state.startRotation,state.settledRotation,fall);
  // Tip around the hips instead of the feet. The hips lose height first; the
  // delayed chest/head and independently relaxed limbs follow that trajectory.
  state.offset.copy(state.pivot).applyQuaternion(state.rotation.copy(state.startRotation).invert().multiply(data.visual.quaternion));
  data.visual.position.copy(state.startPosition).add(state.pivot).sub(state.offset);
  data.visual.position.y-=(Math.max(0,state.pivot.y-.235))*Math.pow(fall,1.12);
  group.updateMatrixWorld(true);
  let minimum=Infinity,vertices=0;
  for(const {mesh,indices}of data.contactSamples||[]){
    mesh.skeleton?.update();
    for(const index of indices){mesh.getVertexPosition(index,state.point).applyMatrix4(mesh.matrixWorld);minimum=Math.min(minimum,state.point.y);vertices++;}
  }
  if(!Number.isFinite(minimum))minimum=state.origin.y;
  const contact=state.ground+.018-minimum;
  // Upward support while falling; one short non-looping settle takes out any
  // final gap. Bodies cross walls instead of compressing against them.
  data.visual.position.y+=contact>0?contact:contact*progress(age,1.04,state.duration-1.04);
  group.updateMatrixWorld(true);
  state.contactPasses++;state.contactVertices=vertices;state.frozen=age>=state.duration;data.deathAge=age;
  data.deathStats={age,clip:'staged-fall',source:'model rest skeleton',once:true,
    fallDirection:state.direction,variation:state.variation,phase:state.frozen?'frozen':age<.24?'loss-of-support':age<1.04?'falling':'settling',
    groundContacts:true,horizontalContacts:false,collisionMode:'ground-only',contactVertices:vertices,contactPasses:state.contactPasses,frozen:state.frozen};
  if(state.frozen){state.poses.length=0;data.skin.traverse(object=>{if(object.isSkinnedMesh)object.skeleton.update();});}
  return data.deathStats;
}

export function clearCharacterDeath(group){
  const data=group.userData;data.deathState=null;data.deathStats=null;data.deathAge=0;data.upperMode=null;data.upperUntil=0;
}
