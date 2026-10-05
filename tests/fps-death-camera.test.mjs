import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from '../games/freight-fire/vendor/three.module.js';
import {DeathCamera} from '../games/freight-fire/death-camera.js';

test('corpse view follows the actual ragdoll after its horizontal fall and pauses cleanly',()=>{
  const player={id:'local',x:0,y:0,z:12,yaw:0},camera=new THREE.PerspectiveCamera(78,16/9,.05,200);
  camera.position.set(player.x,1.58,player.z);camera.lookAt(0,1.58,0);
  const death=new DeathCamera(player,camera),corpse=new THREE.Vector3(1.2,.35,11.3);
  for(let i=0;i<150;i++)death.update(camera,1/90,corpse);
  assert.ok(death.target.distanceTo(corpse)<.001,'Camera follows the real corpse instead of the standing origin');
  const toCorpse=corpse.clone().sub(camera.position).normalize(),forward=camera.getWorldDirection(new THREE.Vector3());
  assert.ok(forward.dot(toCorpse)>.999,'Corpse remains centred in the third-person view');
  assert.ok(camera.position.y>=death.floor+.24&&camera.position.toArray().every(Number.isFinite));
  const frozen={position:camera.position.toArray(),rotation:camera.quaternion.toArray(),target:death.target.toArray(),age:death.age};
  death.update(camera,0,new THREE.Vector3(8,5,8));
  assert.deepEqual({position:camera.position.toArray(),rotation:camera.quaternion.toArray(),target:death.target.toArray(),age:death.age},frozen,'Paused death camera cannot advance towards a new corpse location');
});
