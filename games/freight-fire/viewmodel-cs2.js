import * as THREE from './vendor/three.module.js';
import {GLTFLoader} from './vendor/GLTFLoader.js';
import {clone as cloneSkeleton} from './vendor/SkeletonUtils.js';
import {declareAsset,loadGLTF} from './asset-loading.js';

// Matching original weapon/finger/arm tracks, shared Source 2 skeleton.
// No replacement firearm is fitted onto another weapon's hand animation.
export const AUTHORED_RIGS=Object.freeze({
 m4a1:{file:'m4a1-golden-coil',model:'M4A1-S | Golden Coil'},
 ak47:{file:'ak47-docksteel',model:'AK-47 | Dock Steel'},
 awp:{file:'awp-dragon-lore',model:'AWP | Dragon Lore'},
 usp:{file:'usp-kill-confirmed',model:'USP-S | Kill Confirmed'},
 knife:{file:'karambit-sapphire',model:'Karambit | Sapphire'},
});
const ids=Object.keys(AUTHORED_RIGS),sources=new Map(),arms=new Map(),templates=new Map(),muzzleCalibrations=new Map();
let animations=null,loading=null;
const V=(x=0,y=0,z=0)=>new THREE.Vector3(x,y,z),clamp=n=>Math.max(0,Math.min(1,n));
// Cancel the duplicate exported basis at the original animated wpn joint.
export const WEAPON_SOURCE_BASIS_INVERSE=new THREE.Matrix4().makeRotationFromQuaternion(new THREE.Quaternion(-.5,-.5,-.5,.5)).invert();
const url=file=>new URL(`./assets/viewmodel-cs2/${file}.glb`,import.meta.url).href;
const armFiles=Object.freeze({'ct-sas':'ct-sas-harbor','t-phoenix':'t-phoenix-harbor'});
const modelAssets=[
 ['animations-selected',3719372,'第一人称动作'],['ct-sas-harbor',4144592,'保卫者 · 港湾警戒'],['t-phoenix-harbor',4523660,'潜伏者 · 港湾警戒'],
 ['m4a1-golden-coil',4516992,'M4A1 金蛇缠绕'],['ak47-docksteel',2696768,'AK-47 船坞黑钢'],
 ['awp-dragon-lore',4490124,'AWM 狙击枪'],['usp-kill-confirmed',3266132,'USP 手枪'],['karambit-sapphire',2877116,'爪子刀'],
];
for(const [file,bytes,label]of modelAssets)declareAsset(url(file),{bytes,label,group:'viewmodels'});
const loadModel=(loader,file)=>{const [,bytes,label]=modelAssets.find(asset=>asset[0]===file);return loadGLTF(loader,url(file),{bytes,label,group:'viewmodels'});};
function prepare(root){root.traverse(o=>{if(o.isMesh){o.frustumCulled=false;o.castShadow=false;o.receiveShadow=false;o.userData.sharedAsset=true;for(const m of [].concat(o.material)){if(m.map)m.map.anisotropy=4;m.envMapIntensity=.7;}}});}
function rawWeapon(source){const root=cloneSkeleton(source.scene),wrapper=root.getObjectByName('normalization');if(wrapper){wrapper.matrixAutoUpdate=true;wrapper.position.set(0,0,0);wrapper.quaternion.identity();wrapper.scale.set(1,1,1);wrapper.updateMatrix();}return root;}
function staticGlass(root){
 const canvas=document.createElement('canvas');canvas.width=canvas.height=128;const c=canvas.getContext('2d'),g=c.createRadialGradient(48,43,2,64,64,84);g.addColorStop(0,'#5c8997');g.addColorStop(.45,'#244955');g.addColorStop(1,'#071a25');c.fillStyle=g;c.fillRect(0,0,128,128);c.fillStyle='rgba(205,240,246,.16)';c.beginPath();c.ellipse(40,37,34,7,-.65,0,Math.PI*2);c.fill();
 const map=new THREE.CanvasTexture(canvas);map.colorSpace=THREE.SRGBColorSpace;const material=new THREE.MeshBasicMaterial({map,side:THREE.DoubleSide});material.name='Static coated scope glass';
 root.traverse(o=>{if(!o.isMesh||o.material?.name!=='shared_scope')return;
  // This primitive contains only the two glass discs. The position accessor
  // also contains rifle vertices; use indexed discs when projecting UVs.
  o.geometry=o.geometry.clone();const p=o.geometry.getAttribute('position'),indices=o.geometry.index?.array||Array.from({length:p.count},(_,i)=>i),bounds=new THREE.Box3();for(const i of indices)bounds.expandByPoint(V().fromBufferAttribute(p,i));const size=bounds.getSize(V()),uv=new THREE.Float32BufferAttribute(new Float32Array(p.count*2),2);for(let i=0;i<p.count;i++)uv.setXY(i,(p.getX(i)-bounds.min.x)/size.x,(p.getY(i)-bounds.min.y)/size.y);o.geometry.setAttribute('uv',uv);o.material=material;
 });
}
export async function loadViewModels(){if(loading)return loading;loading=(async()=>{const loader=new GLTFLoader();await Promise.all([
 loadModel(loader,'animations-selected').then(source=>animations=source),
 ...['ct-sas','t-phoenix'].map(async id=>{const source=await loadModel(loader,armFiles[id]);prepare(source.scene);arms.set(id,source);}),
 ...ids.map(async id=>{const source=await loadModel(loader,AUTHORED_RIGS[id].file);if(id==='awp')staticGlass(source.scene);prepare(source.scene);sources.set(id,source);}),
 ]);})().catch(error=>{loading=null;throw error;});return loading;}
function attach(r){r.root.updateWorldMatrix(true,true);new THREE.Matrix4().copy(r.root.matrixWorld).invert().multiply(r.anchor.matrixWorld).multiply(WEAPON_SOURCE_BASIS_INVERSE).decompose(r.mount.position,r.mount.quaternion,r.mount.scale);r.mount.updateWorldMatrix(false,true);}
function play(r,name,{loop=name==='idle',duration=0}={}){const action=r.actions[name]||r.actions.idle;if(!action)return;r.mixer.stopAllAction();action.reset().setEffectiveWeight(1).setEffectiveTimeScale(duration>0?action.getClip().duration/duration:1).setLoop(loop?THREE.LoopRepeat:THREE.LoopOnce,loop?Infinity:1);action.clampWhenFinished=!loop;action.play();r.action=action;r.state=name;return action;}
function createRig(id,agent='ct-sas'){
 if(!sources.has(id)||!animations)throw Error('Matching viewmodel assets are not ready.');
 const config=AUTHORED_RIGS[id],pivot=new THREE.Group(),root=new THREE.Group(),arm=cloneSkeleton(arms.get(agent).scene),gun=rawWeapon(sources.get(id)),mount=new THREE.Group();pivot.rotation.y=Math.PI;pivot.add(root);root.add(arm,mount);mount.add(gun);
 const names=new Set();root.traverse(o=>names.add(o.name));const mixer=new THREE.AnimationMixer(root),actions={};for(const original of animations.animations){if(!original.name.startsWith(id+'/'))continue;const clip=original.clone();clip.tracks=clip.tracks.filter(t=>names.has(THREE.PropertyBinding.parseTrackName(t.name).nodeName));clip.duration=Math.max(.1,clip.duration);actions[original.name.slice(id.length+1)]=mixer.clipAction(clip);}
 const anchor=arm.getObjectByName('wpn'),hands=['hand_L','hand_R'].map(name=>arm.getObjectByName(name));if(!anchor||hands.some(h=>!h)||!actions.idle||!actions.draw||!actions.shoot)throw Error('Incomplete viewmodel '+id);
 const r={id,agent,config,pivot,root,arms:arm,gun,mount,mixer,actions,anchor,hands,state:'',action:null,shotTime:Infinity};mixer.addEventListener('finished',event=>{if(event.action===r.action&&!r.state.startsWith('reload'))play(r,'idle');});play(r,'idle');mixer.update(0);attach(r);
 // Place the muzzle on the original weapon bone, locating the visible tip
 // only in the idle pose. It then follows all authored gun-part animation.
 // getVertexPosition uses the skinning palette. Populate it before the first
 // render; updating matrixWorld alone leaves boneMatrices at identity here.
 pivot.updateMatrixWorld(true);gun.traverse(o=>{if(o.isSkinnedMesh)o.skeleton.update();});let front=Infinity,tip=V(),count=0;const vertices=[],boneWeights=new Map();gun.traverse(o=>{if(!o.isMesh)return;const p=o.geometry.getAttribute('position'),index=o.geometry.index?.array||Array.from({length:p.count},(_,i)=>i);for(const i of new Set(index)){const v=o.getVertexPosition(i,V()).applyMatrix4(o.matrixWorld);vertices.push({v,mesh:o,index:i});front=Math.min(front,v.z);}});for(const {v,mesh,index} of vertices)if(v.z<=front+.002){tip.add(v);count++;if(mesh.isSkinnedMesh){const joints=mesh.geometry.getAttribute('skinIndex'),weights=mesh.geometry.getAttribute('skinWeight');for(let k=0;k<4;k++){const weight=weights.getComponent(index,k),bone=mesh.skeleton.bones[joints.getComponent(index,k)];if(bone&&weight>0)boneWeights.set(bone,(boneWeights.get(bone)||0)+weight);}}}tip.divideScalar(Math.max(1,count));
 // Suppressed muzzle vertices belong to silencer; other rifles use
 // weapon_offset. Follow that authored bone instead of the weapon root.
 const muzzle=new THREE.Object3D(),parent=[...boneWeights].sort((a,b)=>b[1]-a[1])[0]?.[0]||gun.getObjectByName('weapon')||gun;muzzle.name='viewmodel_muzzle';muzzle.position.copy(parent.worldToLocal(tip));muzzle.quaternion.copy(parent.getWorldQuaternion(new THREE.Quaternion()).invert()).multiply(new THREE.Quaternion().setFromUnitVectors(V(0,0,1),V(0,0,-1)));parent.add(muzzle);r.muzzle=muzzle;
 if(!muzzleCalibrations.has(id)){const inverseGun=new THREE.Matrix4().copy(gun.matrixWorld).invert(),fingers={},bonePose={};for(const hand of hands)hand.traverse(b=>{if(b.isBone&&b!==hand)fingers[b.name]=b.quaternion.toArray();});gun.traverse(b=>{if(b.isBone)bonePose[b.name]={position:b.position.toArray(),quaternion:b.quaternion.toArray(),scale:b.scale.toArray()};});muzzleCalibrations.set(id,{bone:parent.name,position:muzzle.position.toArray(),quaternion:muzzle.quaternion.toArray(),bonePose,nativeGrip:{right:new THREE.Matrix4().copy(inverseGun).multiply(hands[1].matrixWorld).toArray(),left:new THREE.Matrix4().copy(inverseGun).multiply(hands[0].matrixWorld).toArray(),fingers}});}return r;
}
/** native:true keeps original coordinates for a character's wpn bone.
 * Default meshes are baked with the right wrist as origin for other rigs. */
export function makeWeaponV2(id,{native=false}={}){
 if(!sources.has(id))throw Error('Missing weapon model '+id);if(native){if(!muzzleCalibrations.has(id)){const calibration=createRig(id);calibration.mixer.stopAllAction();calibration.mixer.uncacheRoot(calibration.root);}const root=rawWeapon(sources.get(id)),calibration=muzzleCalibrations.get(id),anchor=root.getObjectByName(calibration.bone)||root,muzzle=new THREE.Object3D();
 // Source bind-pose weapon.translation is an export offset. The original idle
 // clip cancels it; world guns must use that same authored idle bone pose.
 root.traverse(b=>{const pose=calibration.bonePose[b.name];if(b.isBone&&pose){b.position.fromArray(pose.position);b.quaternion.fromArray(pose.quaternion);b.scale.fromArray(pose.scale);}});muzzle.name='viewmodel_muzzle';muzzle.position.fromArray(calibration.position);muzzle.quaternion.fromArray(calibration.quaternion);anchor.add(muzzle);root.userData={...root.userData,sharedAsset:true,muzzle,muzzlePoint:calibration.position.slice(),muzzleOrientation:calibration.quaternion.slice(),muzzleBone:calibration.bone,nativeGrip:JSON.parse(JSON.stringify(calibration.nativeGrip))};root.traverse(o=>{if(o.isMesh){o.castShadow=true;o.receiveShadow=true;}});return root;}if(templates.has(id))return templates.get(id).clone(true);
 const r=createRig(id),group=new THREE.Group();r.pivot.updateWorldMatrix(true,true);const right=r.hands[1].getWorldPosition(V());r.gun.traverse(o=>{if(!o.isMesh)return;const geometry=o.geometry.clone(),p=geometry.getAttribute('position');for(let i=0;i<p.count;i++){const v=o.getVertexPosition(i,V()).applyMatrix4(o.matrixWorld).sub(right);p.setXYZ(i,v.x,v.y,v.z);}geometry.deleteAttribute('skinIndex');geometry.deleteAttribute('skinWeight');geometry.computeVertexNormals();geometry.computeBoundingBox();const mesh=new THREE.Mesh(geometry,o.material);mesh.castShadow=true;mesh.receiveShadow=true;mesh.userData.sharedAsset=true;group.add(mesh);});
 const bounds=new THREE.Box3().setFromObject(group),scale=({m4a1:1,ak47:.9,awp:1.25,usp:.36,knife:.28}[id])/(bounds.max.z-bounds.min.z||1);group.traverse(o=>{if(o.isMesh)o.geometry.scale(scale,scale,scale);});group.userData={sharedAsset:true,rightGrip:[0,0,0],leftGrip:r.hands[0].getWorldPosition(V()).sub(right).multiplyScalar(scale).toArray(),rearZ:bounds.max.z*scale,muzzleZ:r.muzzle.getWorldPosition(V()).sub(right).z*scale};templates.set(id,group);return group.clone(true);
}
export class ViewModelV2{
 constructor(camera){this.camera=camera;camera.fov=68;camera.updateProjectionMatrix();this.group=new THREE.Group();camera.add(this.group);this.rigs=new Map();this.cache=new Map();for(const id of ids){const r=createRig(id);this.rigs.set(id,r);this.cache.set(id+':ct-sas',r);this.group.add(r.pivot);r.pivot.visible=false;}this.previous='';this.previousAgent='';this.lastReloadUntil=0;this.reloadStart=0;this.reloadProgress=0;this.phase=0;this.wall=0;this.ads=0;this.muzzle=V();this.muzzleDirection=V(0,0,-1);this.lastHands={};this.diagnostics={};this.slash=0;}
 fire(event={}){const r=this.rigs.get(this.previous);if(!r)return;const heavy=event===true||event?.heavy===true,name=r.id==='knife'?(heavy?'heavy':(this.slash++%2?'shoot2':'shoot')):'shoot';r.shotTime=0;play(r,name,{duration:r.id==='awp'?(Number(event?.interval)||1.15):0});}
 update(p,input={},dt=0,time=0,{kick=0}={}){
  dt=Math.max(0,Math.min(.1,dt));const id=typeof p.weapon==='string'?p.weapon:(ids[p.weapon]||ids[0]),agent=p.team===1||p.team==='red'?'t-phoenix':'ct-sas',config=AUTHORED_RIGS[id];if(!config)return;const key=id+':'+agent;let r=this.cache.get(key);if(!r){r=createRig(id,agent);this.cache.set(key,r);this.group.add(r.pivot);}this.rigs.set(id,r);
  const changed=id!==this.previous||agent!==this.previousAgent,reload=p.reloadUntil>time&&id!=='knife',aim=!!input.aim;if(changed){this.lastReloadUntil=0;r.shotTime=Infinity;play(r,'draw');this.wall=0;}if(reload&&p.reloadUntil!==this.lastReloadUntil){this.reloadStart=time;this.lastReloadUntil=p.reloadUntil;play(r,p.ammo?.[p.weapon]===0&&r.actions.reloadEmpty?'reloadEmpty':'reload');r.shotTime=Infinity;}
  this.reloadProgress=reload?clamp((time-this.reloadStart)/Math.max(.1,p.reloadUntil-this.reloadStart)):0;if(reload){r.action.paused=true;r.action.time=this.reloadProgress*r.action.getClip().duration;r.mixer.update(0);}else{if(this.lastReloadUntil){this.lastReloadUntil=0;play(r,'idle');}r.mixer.update(input.paused?0:dt);if(r.shotTime<Infinity){r.shotTime+=dt;if(r.state==='idle')r.shotTime=Infinity;}}
  for(const cached of this.cache.values())cached.pivot.visible=cached===r;this.group.visible=p.alive!==false&&!(aim&&id==='awp');const moving=clamp(Math.hypot(p.vx||0,p.vz||0)/5);this.phase+=dt*(p.walking?4.5:8.5)*moving;this.ads+=(Number(aim&&!reload&&id!=='knife')-this.ads)*(1-Math.exp(-dt*14));
  const narrow=Math.max(0,1.35-(this.camera.aspect||1));
  // Keep the source sleeve's open upper-arm boundary below the camera edge.
  // Move the complete authored rig, preserving its scale and every contact.
  this.group.position.set(Math.sin(this.phase)*.0025*moving-narrow*.035,Math.abs(Math.cos(this.phase))*.003*moving-.035-narrow*.04,-narrow*.08+Math.max(0,kick)*.004);this.group.rotation.set(0,Math.sin(this.phase*.5)*.0015*moving,Math.sin(this.phase)*.002*moving);const desiredWall=clamp((.85-(input.wallDistance??Infinity))/.65);this.wall+=(desiredWall-this.wall)*(1-Math.exp(-dt*20));this.group.position.y-=this.wall*.22;this.group.position.z+=this.wall*.15;this.group.rotation.x=-this.wall*.8;
  attach(r);this.group.updateWorldMatrix(true,true);this.muzzle.copy(this.camera.worldToLocal(r.muzzle.getWorldPosition(V())));const retract=Math.max(0,-this.muzzle.z-(input.wallDistance??Infinity)+.07);if(retract){this.group.position.z+=retract;this.group.updateWorldMatrix(true,true);this.muzzle.copy(this.camera.worldToLocal(r.muzzle.getWorldPosition(V())));}this.muzzleDirection.copy(r.muzzle.getWorldDirection(V())).transformDirection(this.camera.matrixWorldInverse);this.lastHands=Object.fromEntries(r.hands.map((h,i)=>[i?'R':'L',this.camera.worldToLocal(h.getWorldPosition(V())).toArray()]));
  const expected=new THREE.Matrix4().copy(r.root.matrixWorld).invert().multiply(r.anchor.matrixWorld).multiply(WEAPON_SOURCE_BASIS_INVERSE);let attachmentError=0;for(let i=0;i<16;i++)attachmentError=Math.max(attachmentError,Math.abs(expected.elements[i]-r.mount.matrix.elements[i]));this.diagnostics={asset:config.file,model:config.model,arms:agent,state:r.state,clip:r.action?.getClip().name,clipTime:r.action?.time||0,authored:true,boneIK:false,supportWeight:0,supportError:0,attachmentError,wallRetraction:retract,drawn:r.state==='draw',melee:id==='knife'};this.previous=id;this.previousAgent=agent;
 }
 dispose(){for(const r of this.cache.values()){r.mixer.stopAllAction();r.mixer.uncacheRoot(r.root);const skeletons=new Set();r.root.traverse(o=>{if(o.skeleton&&!skeletons.has(o.skeleton)){skeletons.add(o.skeleton);o.skeleton.dispose();}});}this.group.removeFromParent();this.group.clear();this.rigs.clear();this.cache.clear();}
}
