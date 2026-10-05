import * as THREE from './vendor/three.module.js';

const clamp=(value,min,max)=>Math.max(min,Math.min(max,value));
const smooth=value=>{const t=clamp(value,0,1);return t*t*(3-2*t);};
const duration=1.12;
const axisX=new THREE.Vector3(1,0,0),axisZ=new THREE.Vector3(0,0,1);

/**
 * A short, deterministic fall replaces the chest-hit clip's tightly curled
 * terminal pose. Bone translations and scales always retain model rest values.
 * Corpses deliberately have no horizontal contacts, joint physics or live IK.
 */
export function beginCharacterDeath(group,player={},ground=Number(player.y)||0) {
  const data=group.userData;
  // stopAllAction restores the mixer's original bindings. Save the displayed
  // pose first, including the final hand IK, so death starts without a jump.
  const poses=[...data.rest].map(([bone,rest])=>({bone,start:bone.quaternion.clone().normalize(),target:rest.quaternion.clone(),rest}));
  data.mixer.stopAllAction();
  data.currentAction='';
  data.upperMode=null;data.upperUntil=0;
  data.rawPose?.clear();
  for(const {bone,target,rest}of poses){
    // Very small asymmetric bends keep the relaxed pose from looking like a
    // perfectly mirrored mannequin; limb lengths and joint positions are fixed.
    const bend={arm_upper_L:.035,arm_upper_R:-.025,arm_lower_L:.07,arm_lower_R:-.035,leg_lower_L:.025,leg_lower_R:-.02}[bone.name];
    if(bend)target.multiply(new THREE.Quaternion().setFromAxisAngle(axisZ,bend)).normalize();
    bone.position.copy(rest.position);bone.scale.copy(rest.scale);
  }
  const side=data.team===0||data.team==='blue'||data.team==='defender'?1:-1;
  data.deathState={age:0,frozen:false,poses,ground:Number.isFinite(ground)?ground:0,
    origin:group.position.clone(),yaw:group.rotation.y,
    startRotation:data.visual.quaternion.clone(),startPosition:data.visual.position.clone(),
    settledRotation:new THREE.Quaternion().setFromAxisAngle(axisX,Math.PI/2)
      .multiply(new THREE.Quaternion().setFromAxisAngle(axisZ,side*.035)),
    point:new THREE.Vector3(),contactPasses:0,contactVertices:0};
  data.visual.visible=true;
  if(data.gun)data.gun.visible=false;
  return advanceCharacterDeath(group,0);
}

/** Once settled, no mixer, skeleton sampling, collision or bone work remains. */
export function advanceCharacterDeath(group,dt=1/60) {
  const data=group.userData,state=data.deathState;
  if(!state||state.frozen)return data.deathStats;
  const step=clamp(Number(dt)||0,0,.1);
  // begin() still needs one contact pass at age zero. Paused frames afterwards
  // keep those matrices and ground support without resampling the skinned mesh.
  if(step===0&&state.contactPasses>0)return data.deathStats;
  state.age=Math.min(duration,state.age+step);
  group.position.copy(state.origin);group.rotation.y=state.yaw;
  const relax=smooth(state.age/.42),fall=smooth(state.age/duration);
  for(const {bone,start,target}of state.poses)bone.quaternion.slerpQuaternions(start,target,relax);
  data.visual.quaternion.slerpQuaternions(state.startRotation,state.settledRotation,fall);
  data.visual.position.copy(state.startPosition);data.visual.position.y=0;

  // Only support the visual vertically on the deck selected at death. A body
  // near a wall may pass through it rather than compressing, sliding or jittering.
  group.updateMatrixWorld(true);
  let minimum=Infinity,vertices=0;
  for(const {mesh,indices}of data.contactSamples||[]){
    mesh.skeleton?.update();
    for(const index of indices){mesh.getVertexPosition(index,state.point).applyMatrix4(mesh.matrixWorld);minimum=Math.min(minimum,state.point.y);vertices++;}
  }
  if(!Number.isFinite(minimum))minimum=state.origin.y;
  data.visual.position.y=state.ground+.018-minimum;
  group.updateMatrixWorld(true);
  state.contactPasses++;state.contactVertices=vertices;
  state.frozen=state.age>=duration;
  data.deathAge=state.age;
  data.deathStats={age:state.age,clip:'relaxed-fall',source:'model rest skeleton',once:true,
    groundContacts:true,horizontalContacts:false,collisionMode:'ground-only',
    contactVertices:vertices,contactPasses:state.contactPasses,frozen:state.frozen};
  if(state.frozen){
    // Drop the temporary animation transforms; final bone matrices stay fixed.
    state.poses.length=0;
    data.skin.traverse(object=>{if(object.isSkinnedMesh)object.skeleton.update();});
  }
  return data.deathStats;
}

export function clearCharacterDeath(group) {
  const data=group.userData;
  data.deathState=null;data.deathStats=null;data.deathAge=0;
  data.upperMode=null;data.upperUntil=0;
}
