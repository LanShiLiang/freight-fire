import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import * as THREE from '../games/freight-fire/vendor/three.module.js';
import {GLTFLoader} from '../games/freight-fire/vendor/GLTFLoader.js';
import {loadCharacters,makeCharacterV2,updateCharacterV2,characterEvent,disposeCharacterV2} from '../games/freight-fire/character-v2.js';

// Keep the real GLB geometry, inverse binds and animation accessors. Texture
// images are irrelevant to skin deformation and need a browser image decoder.
function withoutTextures(buffer) {
  const source=Buffer.from(buffer),length=source.readUInt32LE(12);
  const json=JSON.parse(source.toString('utf8',20,20+length));
  json.materials=(json.materials||[]).map(()=>({pbrMetallicRoughness:{baseColorFactor:[.5,.5,.5,1]}}));
  delete json.images;delete json.textures;delete json.samplers;
  let text=Buffer.from(JSON.stringify(json));
  text=Buffer.concat([text,Buffer.alloc((4-text.length%4)%4,32)]);
  const binary=source.subarray(20+length),result=Buffer.alloc(20+text.length+binary.length);
  result.writeUInt32LE(0x46546c67,0);result.writeUInt32LE(2,4);result.writeUInt32LE(result.length,8);
  result.writeUInt32LE(text.length,12);result.writeUInt32LE(0x4e4f534a,16);text.copy(result,20);binary.copy(result,20+text.length);
  return result.buffer.slice(result.byteOffset,result.byteOffset+result.byteLength);
}

test('native rifle and pistol recoil preserve both character skeletons and finite skinned vertices',async()=>{
  const fetch=globalThis.fetch,parseAsync=GLTFLoader.prototype.parseAsync;
  globalThis.fetch=async url=>new Response(await readFile(new URL(url)));
  GLTFLoader.prototype.parseAsync=function(buffer,path){return parseAsync.call(this,withoutTextures(buffer),path);};
  try {await loadCharacters();}finally {globalThis.fetch=fetch;GLTFLoader.prototype.parseAsync=parseAsync;}

  const anatomy=['spine_3','neck_0','head_0','arm_upper_L','arm_lower_L','hand_L','arm_upper_R','arm_lower_R','hand_R'];
  for(const team of [0,1])for(const weapon of [0,3,4])for(const stance of ['idle','run','crouch']){
    const actor=makeCharacterV2(team),control=makeCharacterV2(team),d=actor.userData;
    const p={alive:true,grounded:true,weapon,pitch:0,...(stance==='run'?{vz:-5.5}:stance==='crouch'?{crouching:true}:{})};
    let now=0;
    for(let i=0;i<60;i++){now+=1/60;updateCharacterV2(actor,p,1/60,now);updateCharacterV2(control,p,1/60,now);}
    let recoilAngle=0;
    for(let frame=0;frame<120;frame++){
      if(frame%10===0)characterEvent(actor,{type:weapon===4?'melee':'shot',weapon},now);
      now+=1/120;updateCharacterV2(actor,p,1/120,now);updateCharacterV2(control,p,1/120,now);actor.updateMatrixWorld(true);
      for(const name of anatomy){
        const bone=d.bones[name],expected=control.userData.bones[name].position.length(),message=JSON.stringify({team,weapon,stance,frame,bone:name,length:bone.position.length(),expected});
        assert.ok(Math.abs(bone.position.length()-expected)<.00001,message);
        assert.ok([...bone.position,...bone.quaternion,...bone.scale].every(Number.isFinite),message);
        assert.ok(bone.scale.distanceTo(new THREE.Vector3(1,1,1))<.00001,message);
      }
      recoilAngle=Math.max(recoilAngle,control.userData.bones.spine_3.quaternion.angleTo(d.bones.spine_3.quaternion));
      if(frame%12===0){
        const bounds=new THREE.Box3();
        d.skin.traverse(mesh=>{if(!mesh.isSkinnedMesh)return;mesh.skeleton.update();
          const positions=mesh.geometry.getAttribute('position');
          const used=mesh.geometry.index?new Set(mesh.geometry.index.array):Array.from({length:positions.count},(_,i)=>i);
          for(const index of used){const vertex=mesh.getVertexPosition(index,new THREE.Vector3()).applyMatrix4(mesh.matrixWorld);
            assert.ok([...vertex].every(Number.isFinite),JSON.stringify({team,weapon,stance,frame,mesh:mesh.name,index}));bounds.expandByPoint(vertex);
          }
        });
        const height=bounds.max.y-bounds.min.y;
        assert.ok(height>(stance==='crouch'?.8:1.5)&&height<2.3,JSON.stringify({team,weapon,stance,frame,height}));
      }
    }
    assert.ok(recoilAngle>.005,`Native attack is still animated: ${team}/${weapon}/${stance}`);
    disposeCharacterV2(actor);disposeCharacterV2(control);
  }
});

test('absolute native reload retains torso and arm segment lengths throughout its blend',async()=>{
  for(const team of [0,1])for(const weapon of [0,3]){
    const actor=makeCharacterV2(team),d=actor.userData,p={alive:true,grounded:true,weapon,pitch:0};
    for(let i=0;i<60;i++)updateCharacterV2(actor,p,1/60,i/60);
    const names=['spine_3','neck_0','arm_upper_L','arm_lower_L','hand_L','arm_upper_R','arm_lower_R','hand_R'];
    const before=new Map(names.map(name=>[name,d.bones[name].position.length()]));
    characterEvent(actor,{type:'reload',weapon,time:1,until:3.4},1);
    for(let i=0;i<180;i++){
      updateCharacterV2(actor,p,1/60,1+i/60);
      for(const name of names)assert.ok(Math.abs(d.bones[name].position.length()-before.get(name))<.00001,JSON.stringify({team,weapon,frame:i,bone:name,length:d.bones[name].position.length(),expected:before.get(name)}));
    }
    disposeCharacterV2(actor);
  }
});

test('respawn at a reset round clock clears reload and immediately applies a full-weight live pose',async()=>{
  for(const team of [0,1])for(const weapon of [0,1,2,3]){
    const actor=makeCharacterV2(team),d=actor.userData,p={alive:true,grounded:true,weapon,pitch:0,x:0,y:0,z:0};
    for(let frame=0;frame<40;frame++)updateCharacterV2(actor,p,1/60,10+frame/60);
    characterEvent(actor,{type:'reload',weapon,time:11,until:14},11);
    updateCharacterV2(actor,p,1/60,11);
    updateCharacterV2(actor,{...p,alive:false},1/60,11+1/60);
    updateCharacterV2(actor,p,1/60,0);
    assert.equal(d.upperMode,null);assert.equal(d.upperUntil,0);assert.equal(d.dead,false);
    assert.equal(d.actions[d.currentAction].getEffectiveWeight(),1,'No rest-pose fade on the first respawn frame');
    for(const action of Object.values(d.upperActions))assert.equal(action.isRunning(),false);
    for(const [bone,rest]of d.rest){assert.deepEqual(bone.scale.toArray(),rest.scale.toArray());assert.ok([...bone.position,...bone.quaternion].every(Number.isFinite));}
    characterEvent(actor,{type:'shot',weapon},.01);updateCharacterV2(actor,p,1/60,.02);
    assert.equal(d.upperMode,'shoot');assert.equal(d.actions[d.currentAction].getEffectiveWeight(),1);
    disposeCharacterV2(actor);
  }
});
