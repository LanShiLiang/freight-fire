import {chromium} from 'playwright';
import {mkdir,readFile,writeFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import path from 'node:path';
import assert from 'node:assert/strict';
import {makeServer} from './serve.mjs';
import {root} from './catalog.mjs';

// This diagnostic advances the actual packaged skinned meshes and clips in
// deterministic animation scenes. The final match uses ordinary UI and keys;
// its actors, health and animation state are only observed, never overwritten.
const baseline=process.argv.includes('--baseline');
const deathsOnly=process.argv.includes('--deaths-only');
const caseFilter=process.argv.find(argument=>argument.startsWith('--case='))?.slice('--case='.length)||null;
const baselineSource=process.argv.find(argument=>argument.startsWith('--baseline-source='))?.slice('--baseline-source='.length);
const characterSource=await readFile(path.resolve(root,baseline&&baselineSource?baselineSource:'games/freight-fire/character-v2.js'),'utf8');
const deathSource=await readFile(path.resolve(root,'games/freight-fire/character-death.js'),'utf8');
const capturedTripod=JSON.parse(await readFile(path.resolve(root,'tests/fixtures/freight-death-running-tripod.json'),'utf8'));
const capturedSeated=JSON.parse(await readFile(path.resolve(root,'tests/fixtures/freight-death-seated-support.json'),'utf8'));
const capturedExtended=JSON.parse(await readFile(path.resolve(root,'tests/fixtures/freight-death-extended-leg.json'),'utf8'));
const out=path.join(root,'artifacts',baseline?'character-animation-baseline':'character-animation');
await mkdir(out,{recursive:true});
const report={date:new Date().toISOString(),baseline,caseFilter,runtimeSha256:createHash('sha256').update(characterSource).digest('hex'),deathModuleSha256:createHash('sha256').update(deathSource).digest('hex'),checks:[],poses:[],deaths:[],errors:[],requests:[],screenshots:[],limitations:[
 'Deterministic scenes use original GLB models, native animation actions and real skinning; they are animation diagnostics, not player gameplay.',
 'The match observation uses real Start/W/F/R inputs without teleporting or modifying game state.',
 'Head-to-boot distances compare vertices assigned by their strongest skin weight; they only reject coincident sampled vertices, not triangle-surface intersections. Joint limits, bone lengths, body spans and captured-pose mesh review provide the folding assessment.'
]};
const server=makeServer(root);await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
let browser,page;const check=(name,passed,details)=>{report.checks.push({name,passed,details});console.log((passed?'PASS ':'FAIL ')+name);if(!passed&&!baseline)throw Error(name+': '+JSON.stringify(details));};
const shot=async name=>{await page.screenshot({path:path.join(out,name+'.png')});report.screenshots.push(name+'.png');};
try{
 browser=await chromium.launch({channel:'chrome',headless:true,args:['--no-first-run']});
 page=await browser.newPage({viewport:{width:1440,height:900}});page.setDefaultTimeout(30000);
 page.on('pageerror',error=>report.errors.push(error.message));page.on('response',response=>{if(response.status()>=400)report.requests.push({url:response.url(),status:response.status()});});
 if(baseline)await page.route('**/character-v2.js',route=>route.fulfill({status:200,contentType:'application/javascript',body:characterSource}));
 await page.route('**/character-animation-fixture',route=>route.fulfill({status:200,contentType:'text/html',body:'<!doctype html><title>Character animation diagnostics</title><style>html,body{margin:0;background:#233747}canvas{display:block}aside{position:fixed;left:25px;top:25px;padding:14px 20px;background:#102634e8;color:#fff;font:16px system-ui;white-space:pre}</style><aside id="caption"></aside><canvas></canvas>'}));
 await page.goto(`http://127.0.0.1:${server.address().port}/character-animation-fixture`);
 await page.evaluate(async()=>{
  const T=await import('/games/freight-fire/vendor/three.module.js'),characters=await import('/games/freight-fire/character-v2.js'),weapons=await import('/games/freight-fire/viewmodel.js');
  await Promise.all([characters.loadCharacters(),weapons.loadViewModels()]);
  const renderer=new T.WebGLRenderer({canvas:document.querySelector('canvas'),antialias:true});renderer.setSize(1440,900);renderer.outputColorSpace=T.SRGBColorSpace;renderer.toneMapping=T.ACESFilmicToneMapping;renderer.toneMappingExposure=1.05;
  const scene=new T.Scene();scene.background=new T.Color('#7897a6');scene.add(new T.HemisphereLight('#eaf4ff','#706456',2.7));const sun=new T.DirectionalLight('#fff0df',3.2);sun.position.set(-3,8,5);scene.add(sun);
  const floor=new T.Mesh(new T.PlaneGeometry(30,30),new T.MeshStandardMaterial({color:'#617780',roughness:.95}));floor.rotation.x=-Math.PI/2;floor.position.y=-.035;scene.add(floor,new T.GridHelper(20,40,'#718d93','#596d72'));
  const camera=new T.PerspectiveCamera(43,1440/900,.05,100);camera.position.set(3.1,2.1,5.8);camera.lookAt(0,.9,0);
  const sample=actor=>{
   actor.updateMatrixWorld(true);const d=actor.userData,bounds=new T.Box3(),axis=d.deathDirection?.clone().normalize()||new T.Vector3(0,0,1).applyQuaternion(actor.quaternion),parts=d.deathStats?.frozen?{head:[],L:[],R:[]}:null;let axisMin=Infinity,axisMax=-Infinity;
   d.skin.traverse(mesh=>{if(!mesh.isSkinnedMesh)return;mesh.skeleton.update();const position=mesh.geometry.getAttribute('position'),indices=mesh.geometry.getAttribute('skinIndex'),weights=mesh.geometry.getAttribute('skinWeight'),used=mesh.geometry.index?new Set(mesh.geometry.index.array):Array.from({length:position.count},(_,i)=>i);for(const i of used){const vertex=mesh.getVertexPosition(i,new T.Vector3()).applyMatrix4(mesh.matrixWorld);bounds.expandByPoint(vertex);const projection=vertex.dot(axis);axisMin=Math.min(axisMin,projection);axisMax=Math.max(axisMax,projection);
    if(parts){let strongest=0;for(let k=1;k<4;k++)if(weights.getComponent(i,k)>weights.getComponent(i,strongest))strongest=k;let bone=mesh.skeleton.bones[indices.getComponent(i,strongest)];while(bone?.isBone){if(bone.name==='head_0'){parts.head.push(vertex);break;}if(/^ankle_[LR]$/.test(bone.name)){parts[bone.name.slice(-1)].push(vertex);break;}bone=bone.parent;}}
   }});
   const position=name=>d.bones[name]?.getWorldPosition(new T.Vector3()),distance=(a,b)=>position(a)?.distanceTo(position(b));
   const headFootVertexDistances=parts?['L','R'].map(side=>{let min=Infinity;for(const a of parts.head)for(const b of parts[side])min=Math.min(min,a.distanceToSquared(b));return Math.sqrt(min);}):null;
   const deckContacts=d.deathState?.world?.contactmaterials.filter(material=>material.materials.some(item=>item.name==='deck'));
   const deathPhysics=d.deathState?.world?{worldStepSeconds:d.deathState.world.dt,worldIndependentSleep:d.deathState.world.allowSleep,groundFriction:deckContacts.map(material=>material.friction),groundPairs:deckContacts.map(material=>({materials:material.materials.map(item=>item.name).sort(),friction:material.friction})),angularDamping:d.deathState.bodies.map(body=>body.angularDamping),independentSleep:d.deathState.bodies.map(body=>body.allowSleep)}:null;
   const scales=Object.values(d.bones).flatMap(bone=>bone.scale.toArray()),translations=['spine_3','neck_0','arm_lower_L','arm_lower_R'].map(name=>({name,length:d.bones[name]?.position.length(),rest:d.rest.get(d.bones[name])?.position.length()}));
   return {bounds:{min:bounds.min.toArray(),max:bounds.max.toArray(),size:bounds.getSize(new T.Vector3()).toArray()},axisExtent:axisMax-axisMin,head:position('head_0')?.toArray(),pelvis:position('pelvis')?.toArray(),headHipDistance:distance('head_0','pelvis'),torsoVerticalRatio:Math.abs(position('head_0').y-position('pelvis').y)/distance('head_0','pelvis'),headAnkles:['L','R'].map(side=>distance('head_0','ankle_'+side)),legSpans:['L','R'].map(side=>distance('leg_upper_'+side,'ankle_'+side)),headFootVertexDistances,headHands:['L','R'].map(side=>distance('head_0','hand_'+side)),footSeparation:distance('ankle_L','ankle_R'),translations,scaleMin:Math.min(...scales),scaleMax:Math.max(...scales),finite:scales.every(Number.isFinite)&&[...bounds.min.toArray(),...bounds.max.toArray()].every(Number.isFinite),pose:d.poseStats,death:d.deathStats,deathPhysics};
  };
  window.__animationDiagnostic={T,...characters,...weapons,renderer,scene,camera,sample};
 });
 await page.evaluate(value=>__animationDiagnostic.baseline=value,baseline);
 if(!deathsOnly)for(const team of [0,1])for(const weapon of [0,1,2,3,4])for(const moving of [false,true]){
  const result=await page.evaluate(({team,weapon,moving})=>{
   const q=__animationDiagnostic;if(q.actor){q.scene.remove(q.actor);q.disposeCharacterV2(q.actor);}q.actor=q.makeCharacterV2(team,q.makeWeaponV2);q.scene.add(q.actor);
   const state={alive:true,grounded:true,x:0,y:0,z:0,yaw:0,pitch:0,weapon,vx:0,vz:moving?-3:0,walking:moving};
   for(let i=0;i<40;i++)q.updateCharacterV2(q.actor,state,1/60,i/60);
   const initial=q.sample(q.actor),frames=[];q.characterEvent(q.actor,{type:weapon===4?'melee':'shot',weapon},1);
   for(let i=0;i<75;i++){const time=1+i/120;if(weapon<3&&i%12===0)q.characterEvent(q.actor,{type:'shot',weapon},time);q.updateCharacterV2(q.actor,state,1/120,time);if(i%6===0)frames.push({time,...q.sample(q.actor)});}
   q.camera.position.set(3.1,2.1,5.8);q.camera.lookAt(0,.9,0);document.querySelector('#caption').textContent=(team?'潜伏者':'保卫者')+' · '+['M4A1-S','AK-47','AWM','USP-S','战术匕首'][weapon]+'\n'+(moving?'移动中射击':'第三人称连续开火');q.renderer.render(q.scene,q.camera);
   return {team,weapon,moving,initial,frames};
  },{team,weapon,moving});report.poses.push(result);
  const bad=result.frames.filter(frame=>!frame.finite||frame.scaleMin<.9||frame.scaleMax>1.1||frame.headHipDistance<result.initial.headHipDistance*.8||frame.translations.some(t=>t.rest>.02&&t.length<t.rest*.8));
  await shot('shoot-'+team+'-'+weapon+'-'+Number(moving));check('Whole upper body survives '+team+'/'+weapon+'/'+(moving?'moving':'standing')+' burst',!bad.length,bad);
  const reload=await page.evaluate(weapon=>{const q=__animationDiagnostic;q.characterEvent(q.actor,{type:'reload',weapon,time:2,until:4},2);const frames=[];for(let i=0;i<150;i++){q.updateCharacterV2(q.actor,{alive:true,grounded:true,weapon,pitch:0},1/60,2+i/60);if(i%15===0)frames.push(q.sample(q.actor));}return frames;},weapon);
  check('Reload retains body geometry '+team+'/'+weapon, reload.every(frame=>frame.finite&&frame.scaleMin>.9&&frame.headHipDistance>.45),reload.filter(frame=>!frame.finite||frame.scaleMin<=.9||frame.headHipDistance<=.45));
 }
 const deathCases=[];
 for(const team of [0,1]){
  for(const crouching of [false,true])for(const fired of [false,true])for(const direction of ['back','left','right'])deathCases.push({team,crouching,fired,direction,weapon:0,heavy:false});
  for(const [weapon,heavy]of [[3,false],[2,false],[4,false],[4,true]])for(const direction of ['back','left'])deathCases.push({team,crouching:false,fired:true,direction,weapon,heavy});
 }
 for(const fixture of deathCases.filter(fixture=>!caseFilter||[fixture.team,Number(fixture.crouching),Number(fixture.fired),fixture.weapon,Number(fixture.heavy),fixture.direction].join('/')===caseFilter)){
  const {team,crouching,fired,direction,weapon,heavy}=fixture;
  const result=await page.evaluate(({team,crouching,fired,direction,weapon,heavy})=>{
   const q=__animationDiagnostic;q.scene.remove(q.actor);q.disposeCharacterV2(q.actor);q.actor=q.makeCharacterV2(team,q.makeWeaponV2);q.scene.add(q.actor);
   const yaw=(team?-.63:.47)+(crouching?.19:0)+(fired?-.11:.08);q.actor.rotation.y=yaw;
   const state={alive:true,grounded:true,x:0,y:0,z:0,yaw,weapon,pitch:0,crouching};
   for(let i=0;i<40;i++)q.updateCharacterV2(q.actor,state,1/60,i/60);if(fired){q.characterEvent(q.actor,{type:weapon===4?'melee':'shot',weapon,heavy},1);q.updateCharacterV2(q.actor,state,1/60,1);}
   const localImpulse=new q.T.Vector3(...({back:[0,0,1],left:[-1,0,0],right:[1,0,0]}[direction]));q.actor.userData.deathDirection=localImpulse.applyQuaternion(q.actor.quaternion);q.deathDirection=direction;
   q.deathAge=0;q.deathState={...state,id:'diagnostic-'+team+'-'+Number(crouching)+'-'+Number(fired),deathAt:1,alive:false};const initial=q.sample(q.actor),d=q.actor.userData;
   const capturedPose={team,initial:{origin:q.actor.position.toArray(),ground:0,groupPosition:q.actor.position.toArray(),groupRotation:q.actor.quaternion.toArray(),groupScale:q.actor.scale.toArray(),skinPosition:d.skin.position.toArray(),skinRotation:d.skin.quaternion.toArray(),skinScale:d.skin.scale.toArray(),visualPosition:d.visual.position.toArray(),visualRotation:d.visual.quaternion.toArray(),visualScale:d.visual.scale.toArray(),poses:Object.values(d.bones).map(bone=>({name:bone.name,position:bone.position.toArray(),rotation:bone.quaternion.toArray(),scale:bone.scale.toArray()})),direction:d.deathDirection.toArray(),hitPoint:null,initialVelocity:d.lastLivingVelocity,player:state}};
   q.updateCharacterV2(q.actor,q.deathState,0,1);return {team,crouching,fired,direction,weapon,heavy,yaw,worldImpulse:q.actor.userData.deathDirection.toArray(),capturedPose,initial,handoff:q.sample(q.actor)};
  },fixture);result.frames=[];
  report.deaths.push(result);
  for(const age of [.05,.2,.45,.75,1.2,1.8,2.8,3.5]){
   const frame=await page.evaluate(age=>{const q=__animationDiagnostic;while(q.deathAge<age-1e-6){q.updateCharacterV2(q.actor,q.deathState,1/120,1+q.deathAge);q.deathAge+=1/120;}const centre=q.actor.userData.bones.pelvis.getWorldPosition(new q.T.Vector3()).add(q.actor.userData.bones.head_0.getWorldPosition(new q.T.Vector3())).multiplyScalar(.5);q.camera.position.set(2.9,3.3,4.8).applyAxisAngle(new q.T.Vector3(0,1,0),q.actor.rotation.y).add(new q.T.Vector3(centre.x,0,centre.z));q.camera.lookAt(centre.x,.35,centre.z);document.querySelector('#caption').textContent=(q.actor.userData.team?'潜伏者':'保卫者')+' · '+({back:'后方受击',left:'左侧受击',right:'右侧受击'}[q.deathDirection])+' '+age.toFixed(2)+' 秒\n'+(q.baseline?'修复前的倒地动作':'真实布娃娃 · 独立地面与自身关节 · '+(q.actor.userData.deathStats?.phase||''));q.renderer.render(q.scene,q.camera);return {age,resources:{world:q.actor.userData.deathState?.world!==null,bodies:q.actor.userData.deathState?.bodies.length,joints:q.actor.userData.deathState?.joints.length},...q.sample(q.actor)};},age);
   result.frames.push(frame);if([.45,1.2,2.8].includes(age))await shot('death-'+team+'-'+Number(crouching)+'-'+Number(fired)+'-'+weapon+'-'+Number(heavy)+'-'+direction+'-'+age);
  }
  const final=result.frames.at(-1),flat=Math.max(final.bounds.size[0],final.bounds.size[2]);
  const label=team+'/'+Number(crouching)+'/'+Number(fired)+'/'+weapon+'/'+Number(heavy)+'/'+direction;
  check('Displayed live pose hands off continuously '+label,new Float64Array(result.initial.pelvis).every((value,index)=>Math.abs(value-result.handoff.pelvis[index])<.001)&&Math.abs(result.initial.headHipDistance-result.handoff.headHipDistance)<.001,{initial:result.initial,handoff:result.handoff});
  // A physically bent knee is valid: reject a compressed torso/limb pile by
  // true geometry and joint limits rather than demanding the old straight pose.
  check('Physical corpse remains unfolded and supported '+label,result.frames.every(frame=>frame.finite&&frame.headHipDistance>.60)&&final.scaleMin>.99&&final.scaleMax<1.01&&final.torsoVerticalRatio<=.6&&flat>1.2&&final.bounds.size[1]<1.05&&(final.headAnkles.some(value=>value>.9)||final.legSpans.every(value=>value>.60)||(Math.max(...final.legSpans)>.75&&Math.max(...final.headAnkles)>.8))&&final.legSpans.every(value=>value>.46)&&final.headFootVertexDistances.every(value=>Number.isFinite(value)&&value>1e-4)&&final.bounds.min[1]>=-.055&&final.bounds.min[1]<.09,{final,flat});
  check('True physics and limited joints settle '+label,final.death?.clip==='ragdoll'&&final.death.engine==='cannon-es'&&final.death.rigidBodies===15&&final.death.constraints===14&&final.death.phase==='frozen'&&final.death.frozen&&final.death.once&&final.death.horizontalContacts===false&&final.death.collisionMode==='ground-only'&&final.death.age<=2.8&&final.death.physicsStepSeconds===1/180&&final.death.physicsSteps<=504&&final.death.maxJointGap<.03&&final.death.maxBendViolation<.06&&final.death.maxTwistViolation<.06&&final.death.maxSwingViolation<.06&&result.frames.filter(frame=>frame.deathPhysics&&frame.death.physicsSteps>0).every(frame=>frame.deathPhysics.worldStepSeconds===1/180&&!frame.deathPhysics.worldIndependentSleep&&frame.deathPhysics.independentSleep.every(value=>!value)),final.death);
  const stable=result.frames.slice(-2);check('Settled corpse frees all bodies and freezes without further physics '+label,JSON.stringify(stable[0].bounds)===JSON.stringify(stable[1].bounds)&&stable[0].death?.physicsSteps===stable[1].death?.physicsSteps&&stable[0].death?.contactPasses===stable[1].death?.contactPasses&&stable.every(frame=>!frame.resources.world&&frame.resources.bodies===0&&frame.resources.joints===0),stable);
  const reset=await page.evaluate(()=>{const q=__animationDiagnostic;for(let i=0;i<40;i++)q.updateCharacterV2(q.actor,{alive:true,grounded:true,weapon:0,yaw:q.actor.rotation.y},1/60,5+i/60);return {dead:q.actor.userData.dead,deathState:q.actor.userData.deathState===null,upperMode:q.actor.userData.upperMode,upperUntil:q.actor.userData.upperUntil,visual:q.actor.userData.visual.position.toArray(),rotation:q.actor.userData.visual.rotation.toArray(),...q.sample(q.actor)};});
  check('Respawn restores normal body and clears death state '+label,!reset.dead&&reset.deathState&&reset.death===null&&reset.upperMode===null&&reset.upperUntil===0&&reset.visual.every(value=>value===0)&&reset.bounds.size[1]>1.6&&reset.headHipDistance>.5&&reset.scaleMin>.9,reset);
 }
 if(!baseline){
  for(const [key,label,fixture]of [['capturedTripod','hand/knee tripod',capturedTripod],['capturedSeated','seated hand support',capturedSeated]]){
  report[key]=await page.evaluate(fixture=>{
   const q=__animationDiagnostic,T=q.T;if(q.actor){q.actor.removeFromParent();q.disposeCharacterV2(q.actor);}q.actor=q.makeCharacterV2(fixture.team);q.scene.add(q.actor);
   const actor=q.actor,d=actor.userData,i=fixture.initial;actor.position.fromArray(i.groupPosition);actor.quaternion.fromArray(i.groupRotation);actor.scale.fromArray(i.groupScale);
   for(const [object,p,r,s]of [[d.visual,i.visualPosition,i.visualRotation,i.visualScale],[d.skin,i.skinPosition,i.skinRotation,i.skinScale]]){object.position.fromArray(p);object.quaternion.fromArray(r);object.scale.fromArray(s);}
   for(const pose of i.poses){const bone=d.bones[pose.name];bone.position.fromArray(pose.position);bone.quaternion.fromArray(pose.rotation);bone.scale.fromArray(pose.scale);}
   d.deathDirection=new T.Vector3(...i.direction);d.deathHitPoint=i.hitPoint;d.lastLivingVelocity=i.initialVelocity;q.capturedPlayer={...i.player,alive:false,x:i.origin[0],y:i.ground,z:i.origin[2]};q.capturedAge=0;
   q.updateCharacterV2(actor,q.capturedPlayer,0,0);return {source:fixture.source,initial:q.sample(actor),frames:[]};
  },fixture);
  for(const age of [.7,1.4,2.1,2.8,3.5]){
   const frame=await page.evaluate(age=>{const q=__animationDiagnostic;while(q.capturedAge<age-1e-6){q.updateCharacterV2(q.actor,q.capturedPlayer,1/120,q.capturedAge);q.capturedAge+=1/120;}const centre=q.actor.userData.bones.pelvis.getWorldPosition(new q.T.Vector3()).add(q.actor.userData.bones.head_0.getWorldPosition(new q.T.Vector3())).multiplyScalar(.5);q.camera.position.set(2.9,3.3,4.8).add(new q.T.Vector3(centre.x,0,centre.z));q.camera.lookAt(centre.x,.35,centre.z);document.querySelector('#caption').textContent='精准公网跑步死亡入口 · 物理修复诊断\n'+age.toFixed(2)+' 秒 · 已保存的真实骨架初态';q.renderer.render(q.scene,q.camera);return {age,...q.sample(q.actor)};},age);
   report[key].frames.push(frame);if([1.4,2.1,2.8].includes(age))await shot((key==='capturedTripod'?'captured-tripod-':'captured-seated-')+age);
  }
  const capturedFinal=report[key].frames.at(-1),capturedLanding=report[key].frames.find(frame=>frame.age===2.1);
  check('Captured public '+label+' collapses by 2.1 seconds and releases physics before respawn',capturedLanding.bounds.size[1]<1.05&&capturedFinal.bounds.size[1]<1.05&&capturedFinal.headHipDistance>.60&&capturedFinal.torsoVerticalRatio<.35&&(capturedFinal.headAnkles.some(value=>value>.9)||capturedFinal.legSpans.every(value=>value>.60)||(Math.max(...capturedFinal.legSpans)>.75&&Math.max(...capturedFinal.headAnkles)>.8))&&capturedFinal.legSpans.every(value=>value>.46)&&capturedFinal.death.frozen&&capturedFinal.death.maxJointGap<.03&&capturedFinal.death.maxBendViolation<.06&&capturedFinal.death.maxTwistViolation<.06&&capturedFinal.death.maxSwingViolation<.06,report[key]);
  const pairs=report[key].initial.deathPhysics.groundPairs;
  check('Captured '+label+' physics uses cloth and glove deck contact materials',pairs.length===2&&pairs.some(pair=>pair.materials.join(',')==='corpse,deck'&&pair.friction===.15)&&pairs.some(pair=>pair.materials.join(',')==='deck,glove'&&pair.friction===.03),report[key].initial.deathPhysics);
  }
  report.capturedExtended=await page.evaluate(fixture=>{
   const q=__animationDiagnostic;q.actor.removeFromParent();q.disposeCharacterV2(q.actor);q.actor=q.makeCharacterV2(fixture.team);q.scene.add(q.actor);const d=q.actor.userData,i=fixture.initial;
   q.actor.position.fromArray(i.groupPosition);q.actor.quaternion.fromArray(i.groupRotation);q.actor.scale.fromArray(i.groupScale);
   for(const [object,p,r,s]of [[d.visual,i.visualPosition,i.visualRotation,i.visualScale],[d.skin,i.skinPosition,i.skinRotation,i.skinScale]]){object.position.fromArray(p);object.quaternion.fromArray(r);object.scale.fromArray(s);}
   for(const pose of fixture.poses){const bone=d.bones[pose.name];bone.position.fromArray(pose.position);bone.quaternion.fromArray(pose.rotation);bone.scale.fromArray(pose.scale);}q.actor.updateMatrixWorld(true);
   const centre=new q.T.Box3().setFromObject(d.skin,true).getCenter(new q.T.Vector3());q.camera.position.copy(centre).add(new q.T.Vector3(2.6,2.1,3.1));q.camera.lookAt(centre);document.querySelector('#caption').textContent='精准侧跑单腿伸展 · 已保存蒙皮姿态诊断\n一腿伸展、一腿屈膝 · 非游戏实战画面';q.renderer.render(q.scene,q.camera);return q.sample(q.actor);
  },capturedExtended);
  const extended=report.capturedExtended;check('Exact side-running single extended leg remains an unfolded corpse',extended.headHipDistance>.60&&extended.torsoVerticalRatio<=.6&&Math.max(...extended.legSpans)>.75&&Math.max(...extended.headAnkles)>.8&&extended.legSpans.every(value=>value>.46)&&Math.max(extended.bounds.size[0],extended.bounds.size[2])>1.2&&extended.bounds.size[1]<1.05&&extended.bounds.min[1]>=-.055&&extended.bounds.min[1]<.09&&extended.scaleMin>.99&&extended.scaleMax<1.01,extended);await shot('captured-extended-leg');
  report.physicsCost=await page.evaluate(()=>{
   const q=__animationDiagnostic,results=[];
   for(const count of [8,16]){
    const actors=[];for(let i=0;i<count;i++){const actor=q.makeCharacterV2(i%2,q.makeWeaponV2);actor.position.set(i%4*3,0,Math.floor(i/4)*3);actor.rotation.y=i*.37;const alive={alive:true,weapon:0,grounded:true,pitch:0};for(let frame=0;frame<40;frame++)q.updateCharacterV2(actor,alive,1/60,frame/60);actor.userData.deathDirection=new q.T.Vector3(Math.sin(i*.63),0,Math.cos(i*.63));actors.push({actor,dead:{...alive,alive:false,x:0,y:0,z:0}});}
    const initialize=performance.now();for(const {actor,dead}of actors)q.updateCharacterV2(actor,dead,0,1);const initializationMs=performance.now()-initialize,times=[];
    for(let frame=0;frame<180;frame++){const start=performance.now();for(const {actor,dead}of actors)q.updateCharacterV2(actor,dead,1/60,1+frame/60);times.push(performance.now()-start);}
    const steps=actors.map(({actor})=>actor.userData.deathStats.physicsSteps),frozenStart=performance.now();for(let frame=0;frame<120;frame++)for(const {actor,dead}of actors)q.updateCharacterV2(actor,dead,1/60,4+frame/60);const frozenMs=performance.now()-frozenStart;
    const released=actors.every(({actor},index)=>actor.userData.deathState.world===null&&actor.userData.deathStats.physicsSteps===steps[index]);times.sort((a,b)=>a-b);results.push({count,initializationMs,medianFrameMs:times[Math.floor(times.length*.5)],p95FrameMs:times[Math.floor(times.length*.95)],maxFrameMs:times.at(-1),frozen120FramesMs:frozenMs,released});for(const {actor}of actors)q.disposeCharacterV2(actor);
   }return results;
  });check('Eight and sixteen corpses release simulations before respawn',report.physicsCost.every(result=>result.released),report.physicsCost);
 }
 if(!baseline){
  await page.goto(`http://127.0.0.1:${server.address().port}/games/freight-fire/?qa=1`);await page.locator('#loading').waitFor({state:'hidden',timeout:60000});await page.locator('#difficulty').selectOption('easy');await page.locator('#start').click();await page.waitForFunction(()=>__freight.snapshot?.players.find(p=>p.id===__freight.localId)?.alive&&!__freight.paused);
  const movement=await page.evaluate(()=>{const q=__freight,p=q.snapshot.players.find(p=>p.id===q.localId);return [p.x,p.z];});await page.keyboard.down('KeyW');await page.waitForTimeout(700);await page.keyboard.up('KeyW');await page.keyboard.down('KeyF');await page.waitForTimeout(1200);await page.keyboard.up('KeyF');await page.keyboard.press('KeyR');
  const real=await page.evaluate(()=>{const q=__freight,p=q.snapshot.players.find(p=>p.id===q.localId);return {alive:p.alive,position:[p.x,p.z],ammo:p.ammo[0],reserve:p.reserve[0],actors:[...q.view.players.values()].map(({group})=>({team:group.userData.team,dead:group.userData.dead,upper:group.userData.poseStats,death:group.userData.deathStats,scales:Object.values(group.userData.bones).flatMap(b=>b.scale.toArray())}))};});
  check('Actual Start/W/fire/reload match keeps all characters visible',Math.hypot(real.position[0]-movement[0],real.position[1]-movement[1])>1&&real.actors.every(actor=>actor.scales.every(s=>Number.isFinite(s)&&s>.9&&s<1.1)),real);await shot('real-match-entry');
 }
 check('No runtime or asset request errors',!report.errors.length&&!report.requests.length,{errors:report.errors,requests:report.requests});report.ok=report.checks.every(entry=>entry.passed);
}catch(error){report.ok=false;report.failure=error.stack;process.exitCode=1;console.error(error.stack);if(page)await shot('failure').catch(()=>{});}
finally{await browser?.close();await new Promise(resolve=>server.close(resolve));await writeFile(path.join(out,'report.json'),JSON.stringify(report,null,2)+'\n');console.log('REPORT '+path.join(out,'report.json'));}
