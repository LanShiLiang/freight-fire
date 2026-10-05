import * as THREE from './vendor/three.module.js';
import * as CANNON from './vendor/cannon-es.js';

const STEP=1/90,MAX_AGE=2.8,DEG=Math.PI/180;
const clamp=(value,min,max)=>Math.max(min,Math.min(max,value));
const cv=v=>new CANNON.Vec3(v.x,v.y,v.z);
const cq=q=>new CANNON.Quaternion(q.x,q.y,q.z,q.w);
const tv=v=>new THREE.Vector3(v.x,v.y,v.z);
const worldPoint=bone=>bone.getWorldPosition(new THREE.Vector3());
const worldQuaternion=bone=>bone.getWorldQuaternion(new THREE.Quaternion());
const finiteVector=value=>value&&[value.x,value.y,value.z].every(Number.isFinite);
function vector(value,fallback=new THREE.Vector3()){
  const result=Array.isArray(value)?new THREE.Vector3(...value):finiteVector(value)?tv(value):fallback.clone();
  return finiteVector(result)?result:fallback.clone();
}

// Cannon's hinge constrains its axis, but has no built-in angle limits. This
// one-sided solver equation restricts the physical bend, rather than clamping
// the rendered bone after simulation. References come from the actual two
// segment directions, so mirrored +/-X child offsets need no guessed signs.
class BendLimit extends CANNON.Equation{
  constructor(bodyA,bodyB,axis,referenceA,referenceB,min,max){
    super(bodyA,bodyB,-180,180);
    this.axisA=bodyA.vectorToLocalFrame(axis);
    this.referenceA=bodyA.vectorToLocalFrame(referenceA);
    this.referenceB=bodyB.vectorToLocalFrame(referenceB);
    this.min=min;this.max=max;this.angle=0;this.error=0;
    this.axis=new CANNON.Vec3();this.aRef=new CANNON.Vec3();this.bRef=new CANNON.Vec3();this.cross=new CANNON.Vec3();
    this.setSpookParams(1e6,4,STEP);
  }
  update(){
    this.bi.vectorToWorldFrame(this.axisA,this.axis);
    this.bi.vectorToWorldFrame(this.referenceA,this.aRef);
    this.bj.vectorToWorldFrame(this.referenceB,this.bRef);
    // A swinging cone also moves its twist reference out of the hinge plane.
    // Project both references before measuring the signed twist/bend.
    this.axis.scale(this.aRef.dot(this.axis),this.cross);this.aRef.vsub(this.cross,this.aRef);this.aRef.normalize();
    this.axis.scale(this.bRef.dot(this.axis),this.cross);this.bRef.vsub(this.cross,this.bRef);this.bRef.normalize();
    this.aRef.cross(this.bRef,this.cross);
    this.angle=Math.atan2(this.axis.dot(this.cross),this.aRef.dot(this.bRef));
    this.error=this.angle-clamp(this.angle,this.min,this.max);
    this.enabled=Math.abs(this.error)>1e-5;
    this.minForce=this.error>0?-180:0;this.maxForce=this.error>0?0:180;
  }
  computeB(h){
    this.axis.negate(this.jacobianElementA.rotational);this.jacobianElementB.rotational.copy(this.axis);
    return -this.error*this.a-this.computeGW()*this.b-h*this.computeGiMf();
  }
}

class TwistLimit extends CANNON.Equation{
  constructor(a,b,axis,max){
    super(a,b,-100,100);this.axisA=a.vectorToLocalFrame(axis);this.axis=new CANNON.Vec3();
    this.neutral=a.quaternion.inverse().mult(b.quaternion).inverse();this.relative=new CANNON.Quaternion();
    this.gradient=new CANNON.Vec3();this.cross=new CANNON.Vec3();this.vector=new CANNON.Vec3();
    this.angle=0;this.error=0;this.max=max;this.setSpookParams(1e6,4,STEP);
  }
  update(){
    this.bi.quaternion.inverse().mult(this.bj.quaternion,this.relative);this.relative.mult(this.neutral,this.relative);
    const projection=this.relative.x*this.axisA.x+this.relative.y*this.axisA.y+this.relative.z*this.axisA.z;
    // The derivative of swing/twist decomposition is not the cone axis once
    // the shoulder/hip has swung. Using that guessed Jacobian lets the limit
    // and cone push against each other. Differentiate 2*atan2(v.axis,w).
    this.vector.set(this.relative.x,this.relative.y,this.relative.z);this.vector.cross(this.axisA,this.cross);
    this.axisA.scale(this.relative.w*this.relative.w,this.gradient);
    this.gradient.addScaledVector(this.relative.w,this.cross,this.gradient);
    this.gradient.addScaledVector(projection,this.vector,this.gradient);
    this.gradient.scale(1/Math.max(1e-8,this.relative.w*this.relative.w+projection*projection),this.gradient);
    this.bi.vectorToWorldFrame(this.gradient,this.axis);
    let angle=2*Math.atan2(projection,this.relative.w);if(angle>Math.PI)angle-=2*Math.PI;if(angle<-Math.PI)angle+=2*Math.PI;
    this.angle=angle;this.error=angle-clamp(angle,-this.max,this.max);this.enabled=Math.abs(this.error)>1e-5;
    this.minForce=this.error>0?-100:0;this.maxForce=this.error>0?0:100;
  }
  computeB(h){
    this.axis.negate(this.jacobianElementA.rotational);this.jacobianElementB.rotational.copy(this.axis);
    return -this.error*this.a-this.computeGW()*this.b-h*this.computeGiMf();
  }
}

function release(state){
  if(!state?.world)return;
  for(const constraint of [...state.world.constraints])state.world.removeConstraint(constraint);
  for(const body of [...state.world.bodies])state.world.removeBody(body);
  state.world.contacts.length=0;state.world.frictionEquations.length=0;
  state.world=null;state.material=null;state.neutral=null;state.player=null;state.bindings.length=0;state.joints.length=0;state.bodies.length=0;state.poses.length=0;
}

function createBody(state,bone,end,mass,width,depth,{center,radius,halfHeight,axis}={}){
  const position=worldPoint(bone),rotation=worldQuaternion(bone),inverse=rotation.clone().invert();
  const tip=end?worldPoint(end):position.clone();
  const midpoint=center||position.clone().add(tip).multiplyScalar(.5);
  const offset=midpoint.clone().sub(position).applyQuaternion(inverse);
  const body=new CANNON.Body({mass,material:state.material,position:cv(midpoint),quaternion:cq(rotation),linearDamping:.22,angularDamping:end?.85:.95,
    allowSleep:true,sleepSpeedLimit:.14,sleepTimeLimit:.35,collisionFilterGroup:2,collisionFilterMask:1});
  let orientation=new THREE.Quaternion();
  if(radius)body.addShape(new CANNON.Sphere(radius));
  else{
    const direction=axis?axis.clone().applyQuaternion(inverse):tip.clone().sub(position).applyQuaternion(inverse);
    const length=direction.length();
    orientation=length>1e-6?new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0,1,0),direction.normalize()):new THREE.Quaternion();
    body.addShape(new CANNON.Box(new CANNON.Vec3(width,halfHeight??Math.max(.035,length*.46),depth)),new CANNON.Vec3(),cq(orientation));
  }
  state.world.addBody(body);state.bodies.push(body);
  const binding={bone,body,offset,position,tip,orientation,radius,depth:boneDepth(bone)};state.bindings.push(binding);return binding;
}
function boneDepth(bone){let depth=0;while(bone.parent){depth++;bone=bone.parent;}return depth;}
function cone(state,a,b,pivot,axis,angle,twist,parentAxis=axis){
  const constraint=new CANNON.ConeTwistConstraint(a.body,b.body,{pivotA:a.body.pointToLocalFrame(cv(pivot)),pivotB:b.body.pointToLocalFrame(cv(pivot)),
    axisA:a.body.vectorToLocalFrame(cv(parentAxis)),axisB:b.body.vectorToLocalFrame(cv(axis)),angle:angle*DEG,twistAngle:twist*DEG,maxForce:1500,collideConnected:false});
  // Native ConeTwist builds its twist tangents independently in each body's
  // local frame. The imported mirrored bone frames have different tangent
  // phases, which would apply an artificial impulse to a valid starting pose.
  // Use the same captured world reference in both frames for our twist limit.
  constraint.twistEquation.enabled=false;
  const limit=new TwistLimit(a.body,b.body,cv(axis),twist*DEG);
  constraint.equations.push(limit);
  const update=constraint.update.bind(constraint);constraint.update=()=>{update();constraint.twistEquation.enabled=false;limit.update();};
  for(const equation of constraint.equations)equation.setSpookParams(2e7,6,STEP);
  constraint.coneEquation.setSpookParams(1e7,4,STEP);limit.setSpookParams(2e6,6,STEP);
  state.world.addConstraint(constraint);state.joints.push({constraint,limit,kind:'cone',angle:angle*DEG,name:b.bone.name});
}
function hinge(state,a,b,pivot,maxAngle,fallbackAxis){
  const directionA=a.tip.clone().sub(a.position).normalize(),directionB=b.tip.clone().sub(b.position).normalize();
  const axis=new THREE.Vector3().crossVectors(directionA,directionB);
  if(axis.lengthSq()<.002){axis.copy(fallbackAxis).addScaledVector(directionA,-fallbackAxis.dot(directionA));}
  axis.normalize();
  const constraint=new CANNON.HingeConstraint(a.body,b.body,{pivotA:a.body.pointToLocalFrame(cv(pivot)),pivotB:b.body.pointToLocalFrame(cv(pivot)),
    axisA:a.body.vectorToLocalFrame(cv(axis)),axisB:b.body.vectorToLocalFrame(cv(axis)),maxForce:1500,collideConnected:false});
  const limit=new BendLimit(a.body,b.body,cv(axis),cv(directionA),cv(directionB),-4*DEG,maxAngle*DEG);
  constraint.equations.push(limit);
  const update=constraint.update.bind(constraint);constraint.update=()=>{update();limit.update();};
  for(const equation of constraint.equations)equation.setSpookParams(2e7,6,STEP);
  limit.setSpookParams(2e6,6,STEP);
  state.world.addConstraint(constraint);state.joints.push({constraint,limit,kind:'hinge',angle:maxAngle*DEG,name:b.bone.name});
}

// Fit simple collider boxes once to the real visible, weighted vertices. Boots
// include their toe bones and hands include the fingers; a sphere at the ankle
// or wrist misses those extents and can leave 15 cm of visible mesh underground.
// No skin vertices are sampled during the subsequent physics frames.
function fitShapes(group,state){
  const data=group.userData,byBone=new Map(state.bindings.map(binding=>[binding.bone,binding])),owner=new Map();
  for(const bone of Object.values(data.bones)){let current=bone;while(current&&!byBone.has(current))current=current.parent;owner.set(bone,byBone.get(current));}
  for(const binding of state.bindings){binding.bounds=new THREE.Box3();binding.inverseBody=worldQuaternion(binding.bone).invert();binding.inverseShape=binding.orientation.clone().invert();}
  const point=new THREE.Vector3();let vertices=0;
  for(const {mesh,indices}of data.contactSamples||[]){
    mesh.skeleton?.update();const joints=mesh.geometry.getAttribute('skinIndex'),weights=mesh.geometry.getAttribute('skinWeight');
    if(!joints||!weights)continue;
    for(const index of indices){
      let strongest=0;for(let i=1;i<4;i++)if(weights.getComponent(index,i)>weights.getComponent(index,strongest))strongest=i;
      const binding=owner.get(mesh.skeleton.bones[joints.getComponent(index,strongest)]);if(!binding)continue;
      mesh.getVertexPosition(index,point).applyMatrix4(mesh.matrixWorld).sub(tv(binding.body.position)).applyQuaternion(binding.inverseBody).applyQuaternion(binding.inverseShape);
      binding.bounds.expandByPoint(point);vertices++;
    }
  }
  for(const binding of state.bindings){
    if(binding.bounds.isEmpty()||binding.radius)continue;
    const half=binding.bounds.getSize(new THREE.Vector3()).multiplyScalar(.5).addScalar(.008),center=binding.bounds.getCenter(new THREE.Vector3()).applyQuaternion(binding.orientation);
    half.x=Math.max(.025,half.x);half.y=Math.max(.03,half.y);half.z=Math.max(.025,half.z);
    binding.body.removeShape(binding.body.shapes[0]);binding.body.addShape(new CANNON.Box(cv(half)),cv(center),cq(binding.orientation));
    delete binding.bounds;delete binding.inverseBody;delete binding.inverseShape;
  }
  state.contactVertices=vertices;
}

function buildRig(group,state){
  const {bones}=group.userData,up=new THREE.Vector3(0,1,0),right=new THREE.Vector3(1,0,0).applyQuaternion(group.getWorldQuaternion(new THREE.Quaternion()));
  const pelvisPoint=worldPoint(bones.pelvis),chestBottom=worldPoint(bones.spine_0),neck=worldPoint(bones.neck_0);
  const pelvis=createBody(state,bones.pelvis,null,12,.17,.145,{center:pelvisPoint.clone().addScaledVector(up,-.055),halfHeight:.12,axis:up});
  // A chest proxy follows spine_0; the existing intermediate spine offsets and
  // current curvature remain intact instead of stretching each bone to a body.
  const chest=createBody(state,bones.spine_0,bones.neck_0,26,.18,.17);
  const head=createBody(state,bones.head_0,null,5,0,0,{center:worldPoint(bones.head_0).addScaledVector(up,.045),radius:.13});
  cone(state,pelvis,chest,chestBottom,neck.clone().sub(chestBottom).normalize(),45,25);
  cone(state,chest,head,worldPoint(bones.head_0),up,32,28);
  for(const side of ['L','R']){
    const upperArm=createBody(state,bones['arm_upper_'+side],bones['arm_lower_'+side],2.2,.058,.061);
    const forearm=createBody(state,bones['arm_lower_'+side],bones['hand_'+side],1.5,.048,.052);
    const hand=createBody(state,bones['hand_'+side],bones['finger_middle_1_'+side],.55,.045,.05);
    const thigh=createBody(state,bones['leg_upper_'+side],bones['leg_lower_'+side],7.5,.09,.10);
    const calf=createBody(state,bones['leg_lower_'+side],bones['ankle_'+side],3.8,.075,.085);
    const foot=createBody(state,bones['ankle_'+side],bones['ball_'+side],1,.075,.065);
    cone(state,chest,upperArm,upperArm.position,upperArm.tip.clone().sub(upperArm.position).normalize(),85,55);
    hinge(state,upperArm,forearm,forearm.position,135,right);
    cone(state,forearm,hand,hand.position,forearm.tip.clone().sub(forearm.position).normalize(),25,25);
    // The hip's cone is centred on the source rig's anatomical standing axis,
    // rather than the already flexed crouch. Centring on a crouch would allow
    // another 60 degrees of flexion, bringing both boots up around the head.
    const hipAxis=state.neutral.thigh[side].clone().applyQuaternion(state.neutral.pelvis.clone().invert()).applyQuaternion(worldQuaternion(bones.pelvis));
    cone(state,pelvis,thigh,thigh.position,thigh.tip.clone().sub(thigh.position).normalize(),95,28,hipAxis);
    hinge(state,thigh,calf,calf.position,105,right.clone().negate());
    cone(state,calf,foot,foot.position,calf.tip.clone().sub(calf.position).normalize(),22,15);
  }
  fitShapes(group,state);
  // Only non-adjacent limbs versus the trunk collide inside this private world.
  // Opposite limbs do not fight each other; connected joint pairs are excluded
  // by Cannon. This prevents knees/boots sinking through the chest/head without
  // adding any wall, player, or other-corpse collision volumes to the scene.
  for(const {bone,body}of state.bindings){
    const leg=/^(leg_|ankle_)/.test(bone.name),arm=/^(arm_|hand_)/.test(bone.name);
    body.collisionFilterGroup=leg?4:arm?8:2;body.collisionFilterMask=leg||arm?3:13;
  }
  state.bindings.sort((a,b)=>a.depth-b.depth);
  const inherited=vector(group.userData.lastLivingVelocity,new THREE.Vector3(Number(state.player.vx)||0,Number(state.player.vy)||0,Number(state.player.vz)||0));
  if(inherited.length()>7)inherited.setLength(7);
  for(const body of state.bodies)body.velocity.copy(cv(inherited));
  const direction=vector(group.userData.deathDirection,new THREE.Vector3(0,0,1).applyQuaternion(group.quaternion));
  direction.y=clamp(direction.y,-.3,.3);if(direction.lengthSq()<1e-6)direction.set(0,0,1);direction.normalize();
  const strength=state.player.deathWeapon===2?38:state.player.deathWeapon===3?22:28;
  const hit=vector(group.userData.deathHitPoint,tv(chest.body.position).addScaledVector(up,.16));
  const relative=hit.sub(tv(chest.body.position));if(relative.length()>.24)relative.setLength(.24);
  chest.body.applyImpulse(cv(direction.clone().multiplyScalar(strength)),cv(relative));
  state.impulse=direction.multiplyScalar(strength).toArray();state.initialVelocity=inherited.toArray();
}

function applyPhysicsPose(group,state){
  const point=new THREE.Vector3(),rotation=new THREE.Quaternion(),parentRotation=new THREE.Quaternion();
  for(const {bone,body,offset}of state.bindings){
    rotation.set(body.quaternion.x,body.quaternion.y,body.quaternion.z,body.quaternion.w).normalize();
    if(bone.name==='pelvis'){
      point.copy(offset).applyQuaternion(rotation).negate().add(tv(body.position));
      bone.parent.worldToLocal(point);bone.position.copy(point);
    }
    bone.quaternion.copy(bone.parent.getWorldQuaternion(parentRotation).invert().multiply(rotation));
    bone.updateMatrix();bone.updateWorldMatrix(false,true);
  }
  group.updateMatrixWorld(true);
}

function diagnostics(state){
  let speed=0,angularSpeed=0,energy=0,sleeping=0,gap=0,bend=0,twist=0,swing=0;const jointAngles=[];
  for(const body of state.bodies){speed=Math.max(speed,body.velocity.length());angularSpeed=Math.max(angularSpeed,body.angularVelocity.length());energy+=.5*body.mass*body.velocity.lengthSquared();if(body.sleepState===CANNON.Body.SLEEPING)sleeping++;}
  for(const {constraint,limit,kind,angle,name}of state.joints){
    const a=constraint.bodyA.pointToWorldFrame(constraint.pivotA),b=constraint.bodyB.pointToWorldFrame(constraint.pivotB);
    gap=Math.max(gap,a.distanceTo(b));limit.update();
    if(kind==='hinge'){bend=Math.max(bend,Math.abs(limit.error));jointAngles.push({name,kind,bend:limit.angle,min:limit.min,max:limit.max});}
    else{
      twist=Math.max(twist,Math.abs(limit.error));
      const axisA=constraint.bodyA.vectorToWorldFrame(constraint.axisA),axisB=constraint.bodyB.vectorToWorldFrame(constraint.axisB);
      const opening=Math.acos(clamp(axisA.dot(axisB),-1,1));swing=Math.max(swing,Math.max(0,opening-angle));
      jointAngles.push({name,kind,swing:opening,maxSwing:angle,twist:limit.angle,maxTwist:limit.max});
    }
  }
  return {maxSpeed:speed,maxAngularSpeed:angularSpeed,kineticEnergy:energy,sleepingBodies:sleeping,maxJointGap:gap,maxBendViolation:bend,maxTwistViolation:twist,maxSwingViolation:swing,jointAngles};
}

/** Genuine constrained rigid bodies, initialized from the displayed skinned pose. */
export function beginCharacterDeath(group,player={},ground=Number(player.y)||0){
  const data=group.userData;release(data.deathState);group.updateMatrixWorld(true);
  const poses=[...data.rest].map(([bone,rest])=>({bone,rest,quaternion:bone.quaternion.clone(),position:bone.position.clone()}));
  data.mixer.stopAllAction();data.currentAction='';data.upperMode=null;data.upperUntil=0;data.rawPose?.clear();
  for(const {bone,rest}of poses){bone.position.copy(rest.position);bone.quaternion.copy(rest.quaternion);bone.scale.copy(rest.scale);}
  group.updateMatrixWorld(true);
  const neutral={pelvis:worldQuaternion(data.bones.pelvis),thigh:{}};
  for(const side of ['L','R'])neutral.thigh[side]=worldPoint(data.bones['leg_lower_'+side]).sub(worldPoint(data.bones['leg_upper_'+side])).normalize();
  for(const pose of poses){pose.bone.quaternion.copy(pose.quaternion).normalize();pose.bone.position.copy(pose.bone.name==='pelvis'?pose.position:pose.rest.position);pose.bone.scale.copy(pose.rest.scale);}
  group.updateMatrixWorld(true);
  const world=new CANNON.World({gravity:new CANNON.Vec3(0,-9.81,0),allowSleep:true});
  world.solver.iterations=24;world.solver.tolerance=1e-6;
  Object.assign(world.defaultContactMaterial,{friction:.72,restitution:0,contactEquationStiffness:2e7,contactEquationRelaxation:12,frictionEquationStiffness:2e7,frictionEquationRelaxation:4});
  const material=new CANNON.Material('corpse'),floorMaterial=new CANNON.Material('deck');
  world.addContactMaterial(new CANNON.ContactMaterial(material,material,{friction:.08,restitution:0,contactEquationStiffness:5e4,contactEquationRelaxation:8,frictionEquationStiffness:5e4,frictionEquationRelaxation:8}));
  // Slow positional correction for a boot initially a few centimetres below
  // the deck; a very hard correction injects upward velocity into the whole
  // linked corpse. Restitution stays zero and gravity remains fully physical.
  world.addContactMaterial(new CANNON.ContactMaterial(material,floorMaterial,{friction:.72,restitution:0,contactEquationStiffness:2e7,contactEquationRelaxation:12,frictionEquationStiffness:2e7,frictionEquationRelaxation:4}));
  const plane=new CANNON.Body({mass:0,material:floorMaterial,shape:new CANNON.Plane(),position:new CANNON.Vec3(0,Number.isFinite(ground)?ground:0,0),collisionFilterGroup:1,collisionFilterMask:14});
  plane.quaternion.setFromAxisAngle(new CANNON.Vec3(1,0,0),-Math.PI/2);world.addBody(plane);
  const state={age:0,accumulator:0,frozen:false,world,material,poses,player,neutral,bodies:[],bindings:[],joints:[],ground:Number.isFinite(ground)?ground:0,
    origin:group.position.clone(),yaw:group.rotation.y,steps:0,quietTime:0,contactPasses:0,groundContactCount:0,freezeReason:null};
  data.deathState=state;buildRig(group,state);data.visual.visible=true;if(data.gun)data.gun.visible=false;
  return advanceCharacterDeath(group,0);
}

/** A stationary/paused/frozen corpse performs no physics or skin-vertex sampling. */
export function advanceCharacterDeath(group,dt=1/60){
  const data=group.userData,state=data.deathState;if(!state||state.frozen)return data.deathStats;
  const elapsed=Math.min(MAX_AGE-state.age,clamp(Number(dt)||0,0,.1));if(elapsed===0&&state.contactPasses)return data.deathStats;
  state.age=Math.min(MAX_AGE,state.age+elapsed);state.accumulator+=elapsed;
  group.position.copy(state.origin);group.rotation.y=state.yaw;
  while(state.accumulator>=STEP-1e-9){state.world.step(STEP);state.steps++;state.accumulator=Math.max(0,state.accumulator-STEP);}
  applyPhysicsPose(group,state);const measured=diagnostics(state);
  state.groundContactCount=state.world.contacts.filter(contact=>contact.bi.mass===0||contact.bj.mass===0).length;
  state.contactPasses++;
  const quiet=state.age>.65&&measured.maxSpeed<.16&&measured.maxAngularSpeed<.35&&state.groundContactCount>0;
  state.quietTime=quiet?state.quietTime+elapsed:0;
  state.frozen=state.quietTime>=.3||measured.sleepingBodies===15||state.age>=MAX_AGE-1e-6;
  if(state.frozen)state.freezeReason=state.age>=MAX_AGE-1e-6?'time-budget':'sleep';
  data.deathAge=state.age;
  data.deathStats={age:state.age,clip:'ragdoll',engine:'cannon-es',source:'current skinned skeleton',once:true,phase:state.frozen?'frozen':'physics',
    groundContacts:true,horizontalContacts:false,collisionMode:'ground-only',contactVertices:state.contactVertices,contactPasses:state.contactPasses,
    rigidBodies:15,constraints:14,physicsSteps:state.steps,groundContactCount:state.groundContactCount,selfContactCount:state.world.contacts.length-state.groundContactCount,impulse:state.impulse,initialVelocity:state.initialVelocity,
    frozen:state.frozen,freezeReason:state.freezeReason,...measured};
  if(state.frozen)release(state);
  return data.deathStats;
}

export function clearCharacterDeath(group){
  const data=group.userData;release(data.deathState);data.deathState=null;data.deathStats=null;data.deathAge=0;data.upperMode=null;data.upperUntil=0;
  data.deathHitPoint=null;
}
