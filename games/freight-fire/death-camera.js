import * as THREE from './vendor/three.module.js';
import { floorAt, raycastWorld, resolveWorldSphere } from './sim.js';
const clamp=(v,a,b)=>Math.max(a,Math.min(b,v));
const ease=t=>t*t*(3-2*t);

/** A grounded death camera: short first-person collapse, then a safe corpse view. */
export class DeathCamera {
  constructor(player,camera,killer) {
    this.age=0;this.playerId=player.id;this.origin=new THREE.Vector3(player.x,player.y||0,player.z);
    this.start=camera.position.clone();this.startQ=camera.quaternion.clone();
    const toward=killer?new THREE.Vector3(killer.x-player.x,0,killer.z-player.z):new THREE.Vector3(-Math.sin(player.yaw||0),0,-Math.cos(player.yaw||0));
    if(toward.lengthSq()<.01)toward.set(0,0,-1);toward.normalize();this.toward=toward;
    const floor=floorAt(player.x,player.z,(player.y||0)+.25);this.floor=Number.isFinite(floor)?floor:player.y||0;
    this.fall=this.origin.clone().addScaledVector(toward,-.18);this.fall.y=this.floor+.68;
    this.target=this.origin.clone();this.target.y=this.floor+.43;
    const side=new THREE.Vector3(toward.z,0,-toward.x);
    const candidates=[side.clone().multiplyScalar(3.0).addScaledVector(toward,-1.4),side.clone().multiplyScalar(-3).addScaledVector(toward,-1.4),toward.clone().multiplyScalar(-3.2),toward.clone().multiplyScalar(3.2)];
    this.orbit=null;let best=-1;
    const anchor=this.target.clone();anchor.y=this.floor+1.0;
    for(const offset of candidates) {
      const desired=this.origin.clone().add(offset);desired.y=this.floor+1.95;
      const delta=desired.clone().sub(anchor),distance=delta.length(),hit=raycastWorld(anchor,delta.clone().normalize(),distance+.15);
      const clear=hit?Math.max(.32,hit.distance-.23):distance;
      const position=anchor.clone().addScaledVector(delta.normalize(),Math.min(clear,distance));resolveWorldSphere(position,.16,null);
      if(clear>best){best=clear;this.orbit=position;}
    }
    const look=new THREE.Object3D();look.position.copy(this.fall);look.lookAt(this.fall.clone().addScaledVector(toward,5).add(new THREE.Vector3(0,.22,0)));this.fallQ=look.quaternion.clone();
    // Camera local forward is -Z, while Object3D.lookAt uses +Z.
    this.fallQ.multiply(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0,1,0),Math.PI));
    this.fallQ.multiply(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0,0,1),-.10));
  }
  update(camera,dt) {
    this.age+=Math.max(0,Math.min(.1,dt));
    if(this.age<.62) {
      const t=ease(clamp(this.age/.62,0,1));camera.position.copy(this.start).lerp(this.fall,t);camera.quaternion.copy(this.startQ).slerp(this.fallQ,t);
    } else {
      const t=ease(clamp((this.age-.62)/.85,0,1));camera.position.copy(this.fall).lerp(this.orbit,t);
      const look=new THREE.PerspectiveCamera();look.position.copy(camera.position);look.lookAt(this.target);camera.quaternion.copy(this.fallQ).slerp(look.quaternion,t);
    }
    resolveWorldSphere(camera.position,.12,null);camera.position.y=Math.max(this.floor+.24,camera.position.y);
    const fallFov=72;camera.fov+=(fallFov-camera.fov)*(1-Math.exp(-dt*12));camera.updateProjectionMatrix();
    return {phase:this.age<.62?'collapse':'corpse',age:this.age,showBody:this.age>1.02,position:camera.position.toArray(),ground:this.floor};
  }
}
