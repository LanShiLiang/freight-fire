import {chromium} from 'playwright';
import {mkdir,readFile,writeFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import assert from 'node:assert/strict';
import path from 'node:path';
import {root} from './catalog.mjs';

// One ordinary match. All movement, shooting and reloads use actual keys.
// __freight, animation bones, camera and Cannon worlds are only read.
const option=name=>process.argv.find(value=>value.startsWith(name+'='))?.slice(name.length+1);
const target=new URL(option('--url')||process.env.FREIGHT_PUBLIC_URL||'https://lslzqco.cn/ai-game-lab/games/freight-fire/');
assert(['http:','https:'].includes(target.protocol)&&!target.username&&!target.password,'Use a plain HTTP(S) FPS URL');
target.searchParams.set('qa','1');
const size=Number(option('--size')||8),playSeconds=Number(option('--play-seconds')||180);
const quietPerf=process.argv.includes('--quiet-perf');
assert([4,8].includes(size),'--size must be 4 or 8');
assert(Number.isFinite(playSeconds)&&playSeconds>=30&&playSeconds<=300,'--play-seconds must be between 30 and 300');
const runId=new Date().toISOString().replace(/[:.]/g,'-');
// A fresh default folder preserves previous failures and never mixes PNGs.
const out=path.resolve(root,option('--out')||'artifacts/character-public/'+runId);
const outRelative=path.relative(root,out);assert(!outRelative.startsWith('..')&&!path.isAbsolute(outRelative),'Output must stay inside the workspace');
await mkdir(out,{recursive:true});
const thresholds={scaleMin:.97,scaleMax:1.03,localBoneOffset:.004,boneLengthRatioMin:.97,boneLengthRatioMax:1.03,
  headPelvis:.60,torsoVerticalRatioMax:.6,farHeadAnkle:.9,extendedLegSpan:.60,singleExtendedLegSpan:.75,singleExtendedFarHeadAnkle:.8,headFootMeshSeparation:1e-4,legSpan:.46,horizontalExtent:1.2,height:1.05,groundMin:-.055,groundMax:.09,
  finalJointGap:.03,finalBendViolation:.06,finalTwistViolation:.06,finalSwingViolation:.06,
  activeJointGap:.18,physicsStepSeconds:1/180,maxPhysicsSteps:504,cameraGroundClearance:.23,cameraDistance:5.5,cameraTargetError:.6,cameraAimDot:.97};
const report={date:new Date().toISOString(),url:target.href,size,playSeconds,expectedRelease:process.env.FREIGHT_EXPECTED_RELEASE||null,
  runId,outputDirectory:out,thresholds,checks:[],samples:[],deaths:[],cameraSamples:[],freezeObservations:[],normalControlActions:[],captureObservations:[],screenshots:[],errors:[],failedRequests:[],responses:[],moduleHashes:[],modelHashes:[],
  limitations:[`One real ${size}v${size} bot match, bounded to ${playSeconds} seconds of play; death outcomes are not forced.`,
    'No actor fixtures, teleport, health changes, input-object or camera writes. All screenshots use the actual player camera.',
    'Ragdoll permits genuine elbow/knee bends. Anatomy checks reject compressed bodies without requiring the old flat, straight death pose.',
    'Spread posture requires a head-to-far-ankle distance over 0.9m OR both hip-to-ankle leg spans over 0.60m OR a maximum leg span over 0.75m together with a far-ankle distance over 0.8m. All three paths additionally require the unchanged torso, minimum leg reach, bounds, ground, bone and joint checks.',
    'A frozen torso additionally requires abs(headY-pelvisY)/head-to-pelvis distance <=0.6; this rejects upright support even when total mesh height is under 1.05m.',
    'Live material and waist checks read actual Cannon bodies, contact materials and constraint equations. A support-release proof retains independent forearm/chest and forearm/pelvis loads, with trunk load equal to their maximum. It reports prior physical contacts and is compared with live state when observable; it never replaces that state.',
    'Fitted boot and upper-thigh checks read actual ConvexPolyhedra. Their saved source envelopes are reconstructed once per observed death from existing weighted samples assigned to the nearest actual body binding; the QA never updates live bones or skeletons for this measurement. Boot source records retain their two-item format.',
    'A release that occurs inside the same render advance as whole-world freezing can have no observable live released world. Such a trigger is explicitly marked unobserved-active-state rather than claimed as a measured material transition.',
    'Camera aim and NDC checks establish direction and frustum membership, not lack of occlusion. Actual death-camera PNGs require a separate visual check that the corpse is visible.',
    'Physics cost records the naturally observed concurrent corpses, not a synthetic simultaneous-death benchmark.',
    'Head/boot proximity groups actual skinned vertices by their strongest bone weight and measures nearest vertex distances; this does not test triangle/surface intersections or prove that volumes do not overlap.',
    'A supplied release name is an expected deployment identity; exact public/local module and model hashes independently verify served content.']};
const started=Date.now();let browser,page,cdp,pulse,closing=false,stage='launch',latestObservation=null,inspectedObservation=null,lastActorKey=null;
const frozenPairAttempts=new Set(),measuredKeys=new Set(),deathRecords=new Map(),lastAlive=new Map(),frozenSignatures=new Map(),eventSeen=new Set(),firedTeams=new Set();
let liveSamples=0,fireSamples=0,localShots=0,localReloads=0,reloadObserved=false,lastReload=-10,lastStrafe=-1,playingCaptured=false;
let peakActiveWorlds=0,peakBodies=0,peakConstraints=0,peakFrozenCorpses=0;
let lastKeyRefresh=-1,progressAnchor=null,lastRecovery=-5,mouseX=750;
const check=(name,passed,details)=>{report.checks.push({name,passed,details});console.log((passed?'PASS ':'FAIL ')+name);assert(passed,name+': '+JSON.stringify(details));};
async function shot(name){const filename=name+'.png';await page.screenshot({path:path.join(out,filename)});report.screenshots.push(filename);console.log('SCREENSHOT '+filename);}
// Read pixels directly without changing the live scene or delaying respawn.
// An asynchronous capture that crosses respawn is kept as race evidence.
async function fastFrozenPair(key){
  // Poll only the local corpse near the freeze boundary. Waiting on rAF lets
  // the untouched game render normally; the timeout cannot hang a QA run.
  const pair=await page.evaluate(async key=>{
    const names=['pelvis','spine_0','spine_1','spine_2','spine_3','neck_0','head_0','arm_upper_L','arm_upper_R','arm_lower_L','arm_lower_R','hand_L','hand_R','leg_upper_L','leg_upper_R','leg_lower_L','leg_lower_R','ankle_L','ankle_R'];
    // Copy primitive values from the real Cannon world; never retain or edit it.
    const snapshotSupport=state=>{
      if(!state)return null;
      const material=m=>m?{id:m.id,name:m.name,friction:m.friction,restitution:m.restitution}:null;
      const contact=cm=>({materials:cm.materials.map(material),friction:cm.friction,restitution:cm.restitution,
        normalStiffness:cm.contactEquationStiffness,normalRelaxation:cm.contactEquationRelaxation,
        frictionStiffness:cm.frictionEquationStiffness,frictionRelaxation:cm.frictionEquationRelaxation});
      const waist=state.joints.find(joint=>joint.name==='spine_0'),slide=state.supportSlide;
      const bodyName=body=>state.bindings.find(binding=>binding.body===body)?.bone.name||(body.mass===0?'ground':'unknown');
      return {worldPresent:state.world!==null,worldTime:state.world?.time??null,supportSlidePresent:slide!=null,
        materialPresent:state.material!=null,handMaterialPresent:state.handMaterial!=null,bootMaterialPresent:state.bootMaterial!=null,
        supportSlide:slide?{released:slide.released,releaseAge:slide.releaseAge,hold:slide.hold,tiltRate:slide.tiltRate??null,proof:slide.proof?{...slide.proof}:null}:null,
        bodyMaterials:state.bindings.map(({bone,body})=>({name:bone.name,material:material(body.material),shapeMaterials:body.shapes.map(shape=>material(shape.material))})),
        bootShapes:state.bindings.filter(({bone})=>/^ankle_[LR]$/.test(bone.name)).map(({bone,body})=>({name:bone.name,count:body.shapes.length,type:body.shapes[0]?.type??null,
          vertexCount:body.shapes[0]?.vertices?.length||0,faceCount:body.shapes[0]?.faces?.length||0,
          finiteVertices:(body.shapes[0]?.vertices||[]).every(v=>[v.x,v.y,v.z].every(Number.isFinite)),
          validFaces:(body.shapes[0]?.faces||[]).every(face=>face.length>=3&&face.every(i=>Number.isInteger(i)&&i>=0&&i<(body.shapes[0]?.vertices?.length||0))),
          finiteNormals:(body.shapes[0]?.faceNormals||[]).length===(body.shapes[0]?.faces||[]).length&&(body.shapes[0]?.faceNormals||[]).every(v=>[v.x,v.y,v.z].every(Number.isFinite)&&Math.hypot(v.x,v.y,v.z)>.99)})),
        thighShapes:state.bindings.filter(({bone})=>/^leg_upper_[LR]$/.test(bone.name)).map(({bone,body})=>({name:bone.name,count:body.shapes.length,type:body.shapes[0]?.type??null,
          vertexCount:body.shapes[0]?.vertices?.length||0,faceCount:body.shapes[0]?.faces?.length||0,
          finiteVertices:(body.shapes[0]?.vertices||[]).every(v=>[v.x,v.y,v.z].every(Number.isFinite)),
          validFaces:(body.shapes[0]?.faces||[]).every(face=>face.length>=3&&face.every(i=>Number.isInteger(i)&&i>=0&&i<(body.shapes[0]?.vertices?.length||0))),
          finiteNormals:(body.shapes[0]?.faceNormals||[]).length===(body.shapes[0]?.faces||[]).length&&(body.shapes[0]?.faceNormals||[]).every(v=>[v.x,v.y,v.z].every(Number.isFinite)&&Math.hypot(v.x,v.y,v.z)>.99)})),
        groundMaterials:(state.world?.bodies||[]).filter(body=>body.mass===0).map(body=>({material:material(body.material),shapeMaterials:body.shapes.map(shape=>material(shape.material))})),
        contactMaterials:(state.world?.contactmaterials||[]).map(contact),defaultContactMaterial:state.world?contact(state.world.defaultContactMaterial):null,
        contacts:(state.world?.contacts||[]).map(c=>({a:bodyName(c.bi),b:bodyName(c.bj),multiplier:c.multiplier})),
        waist:waist?{angle:waist.angle,constraintAngle:waist.constraint.angle,coneAngle:waist.constraint.coneEquation.angle,
          twistAngle:waist.constraint.twistAngle,nativeTwistMax:waist.constraint.twistEquation.maxAngle,nativeTwistEnabled:waist.constraint.twistEquation.enabled,
          twistLimitMax:waist.limit.max,twistLimitInConstraint:waist.constraint.equations.includes(waist.limit)}:null};
    };
    const read=()=>{
      const f=window.__freight,p=f?.snapshot?.players.find(p=>p.id===f.localId),group=p&&f.view.players.get(p.id)?.group,d=group?.userData,stats=d?.deathStats,state=d?.deathState;
      if(!p||!d)return null;
      const currentKey=p.id+'/'+p.deaths,result={key:currentKey,time:f.snapshot.time,renderFrame:f.view.renderer.info.render.frame,alive:p.alive,paused:f.paused,supportMaterials:snapshotSupport(state),
        frozen:stats?.frozen===true,phase:stats?.phase||null,stats:stats?structuredClone(stats):null,worldPresent:state?state.world!==null:null,
        resources:state?{bodies:state.bodies.length,bindings:state.bindings.length,joints:state.joints.length,poses:state.poses.length,worldBodies:state.world?.bodies.length||0,worldConstraints:state.world?.constraints.length||0}:null};
      if(currentKey===key&&result.frozen){
        const bones=names.map(name=>{const b=d.bones[name],m=b.matrixWorld.elements;return {name,position:b.position.toArray(),rotation:b.quaternion.toArray(),world:[m[12],m[13],m[14]]};});
        result.signature=JSON.stringify([group.position.toArray(),d.visual.position.toArray(),bones,stats.physicsSteps,stats.contactPasses]);
      }
      return result;
    };
    const nextFrame=()=>new Promise(resolve=>{let timer,frame;const finish=()=>{clearTimeout(timer);cancelAnimationFrame(frame);resolve();};frame=requestAnimationFrame(finish);timer=setTimeout(finish,100);});
    const activeSupportSnapshots=[],remember=s=>{if(s?.key===key&&!s.alive&&!s.paused&&!s.frozen&&s.supportMaterials?.worldPresent)activeSupportSnapshots.push(s);return s;};
    const deadline=performance.now()+450;let first=remember(read());
    while(first?.key===key&&!first.alive&&!first.paused&&!first.frozen&&performance.now()<deadline){await nextFrame();first=remember(read());}
    if(first?.key!==key||first?.alive||first?.paused||!first?.frozen)return {key,status:'missed',reason:'No frozen local corpse before its natural respawn or bounded observation deadline',first,second:null,activeSupportSnapshots};
    await nextFrame();const second=read();return {key,status:'observed',first,second,activeSupportSnapshots,method:'Two read-only samples across requestAnimationFrame; the live match is never paused.'};
  },key);
  report.freezeObservations.push(pair);return pair;
}
function verifyFrozenPair(record,pair){
  for(const active of pair.activeSupportSnapshots||[]){
    assert.equal(active.key,record.key);inspectSupportEvidence(record,active.stats,active.supportMaterials,{time:active.time,renderFrame:active.renderFrame,method:'fast-freeze active rAF read'});
  }
  const {first,second}=pair,valid=s=>s?.key===record.key&&!s.alive&&!s.paused&&s.frozen&&s.phase==='frozen';
  if(pair.status!=='observed'||!valid(first)||!valid(second)){pair.stable=false;pair.race=true;return false;}
  assert(Number.isInteger(first.renderFrame)&&Number.isInteger(second.renderFrame)&&second.renderFrame>first.renderFrame,'Frozen samples span different actual renderer frames');
  assert.equal(second.signature,first.signature,'Frozen pose, physics steps and contact passes remain stable across render frames');
  for(const state of [first,second]){
    inspectSupportEvidence(record,state.stats,state.supportMaterials,{time:state.time,renderFrame:state.renderFrame,method:'fast-freeze frozen rAF read'});
    assert.equal(state.worldPresent,false,'Quick frozen sample confirms the physics world was released');
    assert(state.resources&&Object.values(state.resources).every(value=>value===0),'Quick frozen sample confirms all physics resources were released');
    assert(state.stats.age>=0&&state.stats.age<=2.8+1e-6);assert.equal(state.stats.physicsStepSeconds,thresholds.physicsStepSeconds);
    assert(state.stats.physicsSteps>=0&&state.stats.physicsSteps<=thresholds.maxPhysicsSteps);
  }
  pair.stable=true;record.fastFrozenPair=pair;record.stableSamples++;return true;
}
async function rearmControls(sample,elapsed,reason){
  for(const key of ['KeyW','KeyF','KeyA','KeyD'])await page.keyboard.up(key);
  await page.keyboard.down('KeyW');await page.keyboard.down('KeyF');lastStrafe=-1;lastKeyRefresh=elapsed;
  progressAnchor={deaths:sample.local.deaths,position:[...sample.local.position],elapsed};
  report.normalControlActions.push({type:'keyup/down',reason,elapsed,deaths:sample.local.deaths,position:[...sample.local.position],keys:['KeyW','KeyF']});
}
async function recoverPastCover(local,elapsed){
  if(!local?.alive)return;
  if(!progressAnchor||progressAnchor.deaths!==local.deaths||Math.hypot(local.position[0]-progressAnchor.position[0],local.position[2]-progressAnchor.position[2])>.35){progressAnchor={deaths:local.deaths,position:[...local.position],elapsed};return;}
  if(elapsed-progressAnchor.elapsed<1.6||elapsed-lastRecovery<2.5)return;
  lastRecovery=elapsed;const dx=mouseX>1250?-160:160,pointerLocked=await page.evaluate(()=>document.pointerLockElement===document.querySelector('#arena'));
  // A real drag works both with pointer lock and the game's normal fallback.
  await page.mouse.move(mouseX,475);await page.mouse.down({button:'left'});mouseX+=dx;await page.mouse.move(mouseX,475,{steps:4});await page.mouse.up({button:'left'});
  report.normalControlActions.push({type:'mouse drag around cover',elapsed,dx,pointerLocked,deaths:local.deaths,position:[...local.position],yawBefore:local.yaw});
  progressAnchor={deaths:local.deaths,position:[...local.position],elapsed};
}
async function frozenShot(record){
  const read=()=>page.evaluate(key=>{
    const f=window.__freight,p=f?.snapshot?.players.find(p=>p.id===f.localId),group=p&&f.view.players.get(p.id)?.group;
    return p?{time:f.snapshot.time,key:p.id+'/'+p.deaths,alive:p.alive,frozen:group?.userData.deathStats?.frozen===true,
      bodyVisible:group?.visible===true&&group.userData.skin.visible===true,cameraPhase:f.view.deathCameraStats?.phase||null,
      cameraAge:f.view.deathCameraStats?.age??null,requestedKey:key}:null;
  },record.key);
  const valid=state=>state?.key===record.key&&!state.alive&&state.frozen&&state.bodyVisible&&state.cameraPhase==='corpse';
  const before=await read();if(!valid(before)){report.captureObservations.push({key:record.key,before,skipped:true,reason:'The frozen live camera window had already ended.'});return;}
  cdp||=await page.context().newCDPSession(page);
  const filename='local-'+record.key.split('/')[1]+'-natural-frozen-corpse-attempt.png',captureStarted=Date.now();let timer;
  let pixels;
  try{pixels=await Promise.race([cdp.send('Page.captureScreenshot',{format:'png',fromSurface:true,captureBeyondViewport:false}),new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error('Frozen screenshot readback timed out')),5000);})]);}finally{clearTimeout(timer);}
  const after=await read();await writeFile(path.join(out,filename),Buffer.from(pixels.data,'base64'));report.screenshots.push(filename);
  const verifiedStateWindow=valid(before)&&valid(after);report.captureObservations.push({key:record.key,filename,method:'CDP direct pixel readback; no game writes',before,after,durationMs:Date.now()-captureStarted,verifiedStateWindow,race:!verifiedStateWindow});
  if(verifiedStateWindow)record.frozenScreenshot=filename.replace(/\.png$/,'');
  console.log('SCREENSHOT '+filename+(verifiedStateWindow?' (frozen state retained across capture)':' (capture crossed the frozen camera window)'));
}
const length=value=>Math.hypot(...value);
const finite=value=>Array.isArray(value)&&value.every(Number.isFinite);

async function observe(){const sample=await page.evaluate(({alreadyMeasured,knownDeaths})=>{
  const observeStarted=performance.now();
  const f=window.__freight;if(!f?.snapshot)return null;
  const names=['pelvis','spine_0','spine_1','spine_2','spine_3','neck_0','head_0','arm_upper_L','arm_upper_R','arm_lower_L','arm_lower_R','hand_L','hand_R','leg_upper_L','leg_upper_R','leg_lower_L','leg_lower_R','ankle_L','ankle_R'];
    // Copy primitive values from the real Cannon world; never retain or edit it.
    const snapshotSupport=state=>{
      if(!state)return null;
      const material=m=>m?{id:m.id,name:m.name,friction:m.friction,restitution:m.restitution}:null;
      const contact=cm=>({materials:cm.materials.map(material),friction:cm.friction,restitution:cm.restitution,
        normalStiffness:cm.contactEquationStiffness,normalRelaxation:cm.contactEquationRelaxation,
        frictionStiffness:cm.frictionEquationStiffness,frictionRelaxation:cm.frictionEquationRelaxation});
      const waist=state.joints.find(joint=>joint.name==='spine_0'),slide=state.supportSlide;
      const bodyName=body=>state.bindings.find(binding=>binding.body===body)?.bone.name||(body.mass===0?'ground':'unknown');
      return {worldPresent:state.world!==null,worldTime:state.world?.time??null,supportSlidePresent:slide!=null,
        materialPresent:state.material!=null,handMaterialPresent:state.handMaterial!=null,bootMaterialPresent:state.bootMaterial!=null,
        supportSlide:slide?{released:slide.released,releaseAge:slide.releaseAge,hold:slide.hold,tiltRate:slide.tiltRate??null,proof:slide.proof?{...slide.proof}:null}:null,
        bodyMaterials:state.bindings.map(({bone,body})=>({name:bone.name,material:material(body.material),shapeMaterials:body.shapes.map(shape=>material(shape.material))})),
        bootShapes:state.bindings.filter(({bone})=>/^ankle_[LR]$/.test(bone.name)).map(({bone,body})=>({name:bone.name,count:body.shapes.length,type:body.shapes[0]?.type??null,
          vertexCount:body.shapes[0]?.vertices?.length||0,faceCount:body.shapes[0]?.faces?.length||0,
          finiteVertices:(body.shapes[0]?.vertices||[]).every(v=>[v.x,v.y,v.z].every(Number.isFinite)),
          validFaces:(body.shapes[0]?.faces||[]).every(face=>face.length>=3&&face.every(i=>Number.isInteger(i)&&i>=0&&i<(body.shapes[0]?.vertices?.length||0))),
          finiteNormals:(body.shapes[0]?.faceNormals||[]).length===(body.shapes[0]?.faces||[]).length&&(body.shapes[0]?.faceNormals||[]).every(v=>[v.x,v.y,v.z].every(Number.isFinite)&&Math.hypot(v.x,v.y,v.z)>.99)})),
        thighShapes:state.bindings.filter(({bone})=>/^leg_upper_[LR]$/.test(bone.name)).map(({bone,body})=>({name:bone.name,count:body.shapes.length,type:body.shapes[0]?.type??null,
          vertexCount:body.shapes[0]?.vertices?.length||0,faceCount:body.shapes[0]?.faces?.length||0,
          finiteVertices:(body.shapes[0]?.vertices||[]).every(v=>[v.x,v.y,v.z].every(Number.isFinite)),
          validFaces:(body.shapes[0]?.faces||[]).every(face=>face.length>=3&&face.every(i=>Number.isInteger(i)&&i>=0&&i<(body.shapes[0]?.vertices?.length||0))),
          finiteNormals:(body.shapes[0]?.faceNormals||[]).length===(body.shapes[0]?.faces||[]).length&&(body.shapes[0]?.faceNormals||[]).every(v=>[v.x,v.y,v.z].every(Number.isFinite)&&Math.hypot(v.x,v.y,v.z)>.99)})),
        groundMaterials:(state.world?.bodies||[]).filter(body=>body.mass===0).map(body=>({material:material(body.material),shapeMaterials:body.shapes.map(shape=>material(shape.material))})),
        contactMaterials:(state.world?.contactmaterials||[]).map(contact),defaultContactMaterial:state.world?contact(state.world.defaultContactMaterial):null,
        contacts:(state.world?.contacts||[]).map(c=>({a:bodyName(c.bi),b:bodyName(c.bj),multiplier:c.multiplier})),
        waist:waist?{angle:waist.angle,constraintAngle:waist.constraint.angle,coneAngle:waist.constraint.coneEquation.angle,
          twistAngle:waist.constraint.twistAngle,nativeTwistMax:waist.constraint.twistEquation.maxAngle,nativeTwistEnabled:waist.constraint.twistEquation.enabled,
          twistLimitMax:waist.limit.max,twistLimitInConstraint:waist.constraint.equations.includes(waist.limit)}:null};
    };
  const world=bone=>bone?[bone.matrixWorld.elements[12],bone.matrixWorld.elements[13],bone.matrixWorld.elements[14]]:null;
  const distance=(a,b)=>a&&b?Math.hypot(a[0]-b[0],a[1]-b[1],a[2]-b[2]):null;
  const xyz=value=>[value.x,value.y,value.z],dot=(a,b)=>a.reduce((sum,value,index)=>sum+value*b[index],0),unit=v=>{const length=Math.hypot(...v);return v.map(value=>value/length);};
  const projected=(v,axis)=>unit(v.map((value,index)=>value-axis[index]*dot(v,axis)));
  const physicalJoints=state=>(state?.joints||[]).map(({constraint,limit,kind,name,angle})=>{
    const a=constraint.bodyA,b=constraint.bodyB,gap=a.pointToWorldFrame(constraint.pivotA).distanceTo(b.pointToWorldFrame(constraint.pivotB));
    if(kind==='hinge'){
      const axis=xyz(a.vectorToWorldFrame(limit.axisA)),ar=projected(xyz(a.vectorToWorldFrame(limit.referenceA)),axis),br=projected(xyz(b.vectorToWorldFrame(limit.referenceB)),axis);
      const cross=[ar[1]*br[2]-ar[2]*br[1],ar[2]*br[0]-ar[0]*br[2],ar[0]*br[1]-ar[1]*br[0]],bend=Math.atan2(dot(axis,cross),dot(ar,br));
      return {name,kind,gap,bend,min:limit.min,max:limit.max,violation:Math.abs(bend-Math.max(limit.min,Math.min(limit.max,bend)))};
    }
    const swing=Math.acos(Math.max(-1,Math.min(1,dot(xyz(a.vectorToWorldFrame(constraint.axisA)),xyz(b.vectorToWorldFrame(constraint.axisB))))));
    return {name,kind,gap,swing,maxSwing:angle};
  });

  // Reconstruct only the existing sparse hull fitting samples in private
  // matrices from the captured source pose. No live bone/skeleton is updated.
  // This runs once per observed death, not every frame or over the whole mesh.
  const sourceFittedHulls=(data,state,targetNames)=>{
    if(!state?.world)return null;
    const poses=new Map(state.poses.map(pose=>[pose.bone,pose])),matrices=new Map();
    const originalMatrix=bone=>{
      if(matrices.has(bone))return matrices.get(bone);
      const pose=poses.get(bone);if(!pose)return bone.matrixWorld.clone();
      const local=bone.matrixWorld.clone().compose(bone.name==='pelvis'?pose.position:pose.rest.position,pose.quaternion,pose.rest.scale),parent=originalMatrix(bone.parent);
      const matrix=parent.clone().multiply(local);matrices.set(bone,matrix);return matrix;
    };
    const byBone=new Map(state.bindings.map(binding=>[binding.bone,binding]));
    const hulls=new Map(state.bindings.filter(({bone})=>targetNames.includes(bone.name)).map(binding=>{
      const position=binding.bone.position.clone(),rotation=binding.bone.quaternion.clone(),scale=binding.bone.scale.clone();originalMatrix(binding.bone).decompose(position,rotation,scale);
      position.add(binding.offset.clone().applyQuaternion(rotation));
      return [binding.bone,{binding,position,inverse:rotation.invert(),min:[Infinity,Infinity,Infinity],max:[-Infinity,-Infinity,-Infinity],sampleCount:0}];
    }));
    for(const {mesh,indices}of data.contactSamples||[]){
      const positions=mesh.geometry.getAttribute('position'),joints=mesh.geometry.getAttribute('skinIndex'),weights=mesh.geometry.getAttribute('skinWeight');if(!joints||!weights)continue;
      for(const index of indices){
        let strongest=0;for(let k=1;k<4;k++)if(weights.getComponent(index,k)>weights.getComponent(index,strongest))strongest=k;
        let bone=mesh.skeleton.bones[joints.getComponent(index,strongest)];while(bone?.isBone&&!byBone.has(bone))bone=bone.parent;const hull=hulls.get(bone);if(!hull)continue;
        const base=mesh.position.clone().fromBufferAttribute(positions,index).applyMatrix4(mesh.bindMatrix),point=mesh.position.clone().set(0,0,0);
        for(let k=0;k<4;k++){const weight=weights.getComponent(index,k);if(!weight)continue;const joint=joints.getComponent(index,k),matrix=originalMatrix(mesh.skeleton.bones[joint]).clone().multiply(mesh.skeleton.boneInverses[joint]);point.addScaledVector(base.clone().applyMatrix4(matrix),weight);}
        point.applyMatrix4(mesh.bindMatrixInverse).applyMatrix4(mesh.matrixWorld).sub(hull.position).applyQuaternion(hull.inverse);
        for(let k=0;k<3;k++){hull.min[k]=Math.min(hull.min[k],point.getComponent(k));hull.max[k]=Math.max(hull.max[k],point.getComponent(k));}hull.sampleCount++;
      }
    }
    return [...hulls.values()].map(({binding,min,max,sampleCount})=>{
      const body=binding.body,shape=body.shapes[0],proxyMin=[Infinity,Infinity,Infinity],proxyMax=[-Infinity,-Infinity,-Infinity],q=body.shapeOrientations[0],offset=body.shapeOffsets[0],orientation=binding.bone.quaternion.clone().set(q.x,q.y,q.z,q.w);
      for(const vertex of shape.vertices||[]){const point=binding.bone.position.clone().set(vertex.x,vertex.y,vertex.z).applyQuaternion(orientation).add(binding.bone.position.clone().set(offset.x,offset.y,offset.z));for(let k=0;k<3;k++){proxyMin[k]=Math.min(proxyMin[k],point.getComponent(k));proxyMax[k]=Math.max(proxyMax[k],point.getComponent(k));}}
      return {name:binding.bone.name,sampleCount,vertexCount:shape.vertices?.length||0,sourceMin:min,sourceMax:max,proxyMin,proxyMax,minDelta:proxyMin.map((value,k)=>value-min[k]),maxDelta:proxyMax.map((value,k)=>value-max[k]),
        method:'Actual convex body-local vertices compared with existing weighted contact samples reconstructed from the captured source pose in private matrices; 8mm radial skin.'};
    });
  };

  const actors=f.snapshot.players.map(p=>{
    const group=f.view.players.get(p.id)?.group,d=group?.userData;if(!d)return {id:p.id,missing:true};
    const key=p.id+'/'+p.deaths,head=world(d.bones.head_0),pelvis=world(d.bones.pelvis);
    const bones=names.map(name=>{
      const bone=d.bones[name],rest=bone&&d.rest.get(bone);if(!rest)return {name,missing:true};
      const parent=bone.parent.matrixWorld.elements,parentScale=Math.hypot(parent[0],parent[1],parent[2]),restLength=rest.position.length()*parentScale;
      return {name,position:bone.position.toArray(),rest:rest.position.toArray(),rotation:bone.quaternion.toArray(),world:world(bone),
        scale:bone.scale.toArray(),lengthRatio:restLength>1e-5?distance(world(bone),world(bone.parent))/restLength:null};
    });
    const scales=Object.values(d.bones).flatMap(bone=>bone.scale.toArray());
    const state=d.deathState,death=d.deathStats?structuredClone(d.deathStats):null;
    const sourceFit=state?.world&&!knownDeaths.includes(key)?sourceFittedHulls(d,state,['ankle_L','ankle_R','leg_upper_L','leg_upper_R']):null;
    const physics=state?{supportMaterials:snapshotSupport(state),bootSourceFit:sourceFit?.filter(hull=>/^ankle_/.test(hull.name))||null,thighSourceFit:sourceFit?.filter(hull=>/^leg_upper_/.test(hull.name))||null,worldPresent:state.world!==null,bodies:state.bodies.length,bindings:state.bindings.length,joints:state.joints.length,poses:state.poses.length,
      worldBodies:state.world?.bodies.length||0,worldConstraints:state.world?.constraints.length||0,worldDt:state.world?.dt??null,worldAllowSleep:state.world?.allowSleep??null,solverIterations:state.world?.solver.iterations??null,bodyAllowSleep:state.bodies.map(body=>body.allowSleep),
      bodiesMeasured:state.bindings.map(({bone,body,offset})=>({name:bone.name,position:[body.position.x,body.position.y,body.position.z],rotation:[body.quaternion.x,body.quaternion.y,body.quaternion.z,body.quaternion.w],
        velocity:[body.velocity.x,body.velocity.y,body.velocity.z],angularVelocity:[body.angularVelocity.x,body.angularVelocity.y,body.angularVelocity.z],offset:offset.toArray(),
        shapes:body.shapes.map((shape,index)=>({type:shape.type,halfExtents:shape.halfExtents?[shape.halfExtents.x,shape.halfExtents.y,shape.halfExtents.z]:null,radius:shape.radius??null,
          offset:[body.shapeOffsets[index].x,body.shapeOffsets[index].y,body.shapeOffsets[index].z],rotation:[body.shapeOrientations[index].x,body.shapeOrientations[index].y,body.shapeOrientations[index].z,body.shapeOrientations[index].w]}))})),
      dynamicCollisionMasks:state.bodies.map(body=>[body.collisionFilterGroup,body.collisionFilterMask]),
      collisionBodies:state.bindings.map(({bone,body})=>({name:bone.name,group:body.collisionFilterGroup,mask:body.collisionFilterMask})),
      collisionConnections:state.joints.map(({constraint})=>({a:state.bindings.find(binding=>binding.body===constraint.bodyA)?.bone.name,b:state.bindings.find(binding=>binding.body===constraint.bodyB)?.bone.name,collideConnected:constraint.collideConnected})),
      staticBodies:(state.world?.bodies||[]).filter(body=>body.mass===0).map(body=>({group:body.collisionFilterGroup,mask:body.collisionFilterMask,shapeTypes:body.shapes.map(shape=>shape.type)})),
      groundContacts:(state.world?.contacts||[]).filter(contact=>contact.bi.mass===0||contact.bj.mass===0).length,
      selfContacts:(state.world?.contacts||[]).filter(contact=>contact.bi.mass>0&&contact.bj.mass>0).length,
      externalContactsOnlyGround:(state.world?.contacts||[]).filter(contact=>contact.bi.mass===0||contact.bj.mass===0).every(contact=>[contact.bi,contact.bj].filter(body=>body.mass===0).every(body=>body.collisionFilterGroup===1&&body.shapes.length===1&&body.shapes[0].type===2)),
      selfContactsOnlyNonAdjacentLimbs:(state.world?.contacts||[]).filter(contact=>contact.bi.mass>0&&contact.bj.mass>0).every(contact=>{
        const groups=[contact.bi.collisionFilterGroup,contact.bj.collisionFilterGroup].sort((a,b)=>a-b);
        return (groups[0]===4&&groups[1]===4||groups[0]===2&&[4,8].includes(groups[1]))&&!state.joints.some(({constraint})=>constraint.bodyA===contact.bi&&constraint.bodyB===contact.bj||constraint.bodyA===contact.bj&&constraint.bodyB===contact.bi);
      }),
      jointsMeasured:physicalJoints(state),
      ground:state.ground}:null;
    let skinBounds=null,footGeometry=null;
    if(death?.frozen&&!alreadyMeasured.includes(key)){
      const min=[Infinity,Infinity,Infinity],max=[-Infinity,-Infinity,-Infinity],parts={head:[],L:[],R:[]};let vertices=0;
      d.skin.traverse(mesh=>{
        if(!mesh.isSkinnedMesh)return;
        const positions=mesh.geometry.getAttribute('position'),skinIndex=mesh.geometry.getAttribute('skinIndex'),skinWeight=mesh.geometry.getAttribute('skinWeight'),used=mesh.geometry.index?new Set(mesh.geometry.index.array):Array.from({length:positions.count},(_,i)=>i),point=mesh.position.clone();
        for(const index of used){
          mesh.getVertexPosition(index,point).applyMatrix4(mesh.matrixWorld);for(let axis=0;axis<3;axis++){min[axis]=Math.min(min[axis],point.getComponent(axis));max[axis]=Math.max(max[axis],point.getComponent(axis));}vertices++;
          if(!skinIndex||!skinWeight)continue;
          let strongest=0;for(let influence=1;influence<4;influence++)if(skinWeight.getComponent(index,influence)>skinWeight.getComponent(index,strongest))strongest=influence;
          let bone=mesh.skeleton.bones[skinIndex.getComponent(index,strongest)];while(bone&&!['head_0','ankle_L','ankle_R'].includes(bone.name))bone=bone.parent;
          const part=bone?.name==='head_0'?'head':bone?.name==='ankle_L'?'L':bone?.name==='ankle_R'?'R':null;if(part)parts[part].push(point.toArray());
        }
      });
      skinBounds={min,max,size:max.map((value,index)=>value-min[index]),vertices};
      const clearance=foot=>{let square=Infinity;for(const head of parts.head)for(const vertex of foot){const x=head[0]-vertex[0],y=head[1]-vertex[1],z=head[2]-vertex[2];square=Math.min(square,x*x+y*y+z*z);}return Math.sqrt(square);};
      footGeometry={headVertices:parts.head.length,footVertices:[parts.L.length,parts.R.length],headClearances:[clearance(parts.L),clearance(parts.R)],
        footSeparation:distance(world(d.bones.ankle_L),world(d.bones.ankle_R)),method:'Nearest vertices of the actual skinned meshes, grouped by strongest skin weight and head/ankle descendants, including toe/ball bones.'};
    }
    const allBones=skinBounds?Object.entries(d.bones).map(([name,bone])=>({name,position:bone.position.toArray(),rotation:bone.quaternion.toArray(),scale:bone.scale.toArray(),world:world(bone)})):null;
    const asArray=value=>Array.isArray(value)?[...value]:value?.toArray?.()||null;
    const initialDeath=state?.poses.length&&!knownDeaths.includes(key)?{origin:state.origin.toArray(),yaw:state.yaw,ground:state.ground,
      groupPosition:group.position.toArray(),groupRotation:group.quaternion.toArray(),groupMatrixWorld:[...group.matrixWorld.elements],groupScale:group.scale.toArray(),
      skinPosition:d.skin.position.toArray(),skinRotation:d.skin.quaternion.toArray(),skinScale:d.skin.scale.toArray(),
      visualPosition:d.visual.position.toArray(),visualRotation:d.visual.quaternion.toArray(),visualScale:d.visual.scale.toArray(),
      contactSamples:(d.contactSamples||[]).map(({mesh,indices})=>({name:mesh.name,vertexCount:mesh.geometry.getAttribute('position').count,indices:[...indices]})),
      poses:state.poses.map(pose=>({name:pose.bone.name,position:pose.position.toArray(),rotation:pose.quaternion.toArray(),scale:pose.rest.scale.toArray()})),
      hitPoint:asArray(d.deathHitPoint),direction:asArray(d.deathDirection),initialVelocity:asArray(state.initialVelocity),
      player:{id:p.id,team:p.team,weapon:p.weapon,x:p.x,y:p.y,z:p.z,yaw:p.yaw,pitch:p.pitch,vx:p.vx,vy:p.vy,vz:p.vz,deathAt:p.deathAt,deathWeapon:p.deathWeapon,deathHeadshot:p.deathHeadshot}}:null;
    return {id:p.id,key,team:p.team,alive:p.alive,hp:p.hp,deaths:p.deaths,deathAt:p.deathAt,respawnAt:p.respawnAt,weapon:p.weapon,
      visible:group.visible,skinVisible:d.skin.visible,position:group.position.toArray(),visual:d.visual.position.toArray(),scaleMin:Math.min(...scales),scaleMax:Math.max(...scales),bones,
      headPelvis:distance(head,pelvis),torsoVerticalRatio:head&&pelvis?Math.abs(head[1]-pelvis[1])/distance(head,pelvis):null,headAnkles:['L','R'].map(side=>distance(head,world(d.bones['ankle_'+side]))),
      legSpans:['L','R'].map(side=>distance(world(d.bones['leg_upper_'+side]),world(d.bones['ankle_'+side]))),
      upperMode:d.upperMode,upperActive:f.snapshot.time<d.upperUntil,
      activeOverlay:Object.entries(d.upperActions).filter(([,action])=>action.isRunning()&&action.getEffectiveWeight()>.001).map(([name])=>name),
      pose:d.poseStats?{...d.poseStats}:null,death,physics,skinBounds,footGeometry,allBones,initialDeath};
  });
  const me=f.snapshot.players.find(p=>p.id===f.localId),dc=f.view.deathCamera,stats=f.view.deathCameraStats,camera=f.view.camera;
  let cameraDeath=null;
  if(dc&&stats){
    const own=actors.find(actor=>actor.id===f.localId),pelvis=own?.bones.find(bone=>bone.name==='pelvis')?.world,head=own?.bones.find(bone=>bone.name==='head_0')?.world;
    const center=pelvis&&head?pelvis.map((value,index)=>(value+head[index])*.5):null,position=camera.position.toArray(),elements=camera.matrixWorld.elements;
    const forward=[-elements[8],-elements[9],-elements[10]],forwardLength=Math.hypot(...forward),toward=center?.map((value,index)=>value-position[index]),distance=toward&&Math.hypot(...toward);
    const point=center?camera.position.clone().fromArray(center).project(camera):null;
    cameraDeath={...stats,position,origin:dc.origin.toArray(),target:dc.target.toArray(),center,forward,
      aimDot:distance>1e-6?toward.reduce((total,value,index)=>total+value*forward[index],0)/distance/forwardLength:null,
      targetError:center?Math.hypot(...center.map((value,index)=>value-dc.target.getComponent(index))):null,
      centerNDC:point?.toArray()||null,centerOriginHorizontalDistance:center?Math.hypot(center[0]-dc.origin.x,center[2]-dc.origin.z):null,bodyVisible:own?.visible};
  }
  return {time:f.snapshot.time,localId:f.localId,paused:f.paused,status:f.snapshot.status,count:actors.length,
    local:me?{alive:me.alive,hp:me.hp,deaths:me.deaths,position:[me.x,me.y,me.z],yaw:me.yaw,pitch:me.pitch,ammo:me.ammo[me.weapon],reloading:me.reloadUntil>f.snapshot.time}:null,
    actors,events:f.snapshot.events.filter(event=>['shot','kill','reload','respawn'].includes(event.type)).map(event=>({type:event.type,seq:event.seq,playerId:event.playerId,targetId:event.targetId,weapon:event.weapon})),
    cameraDeath,renderStats:{...f.view.stats},observationMs:performance.now()-observeStarted};
},{alreadyMeasured:[...measuredKeys],knownDeaths:[...deathRecords.keys()]});latestObservation=sample;return sample;}

async function quietPerformance(){
  const light=()=>page.evaluate(()=>{
    const f=window.__freight;if(!f?.snapshot)return null;const worlds=[...f.view.players.values()].map(entry=>entry.group.userData.deathState?.world).filter(Boolean);
    return {time:f.snapshot.time,status:f.snapshot.status,paused:f.paused,playerCount:f.snapshot.players.length,fps:f.view.stats.fps,
      hud:document.querySelector('#performance')?.textContent,drawCalls:f.view.stats.drawCalls,triangles:f.view.stats.triangles,activeWorlds:worlds.length,
      worldBodies:worlds.reduce((count,world)=>count+world.bodies.length,0),worldConstraints:worlds.reduce((count,world)=>count+world.constraints.length,0)};
  });
  stage='30 seconds ordinary play without frequent anatomy/mesh observation';
  const start=await light(),wallStarted=Date.now();console.log('QUIET START '+JSON.stringify(start));
  await page.keyboard.press('KeyR');await page.waitForTimeout(15000);await page.keyboard.press('KeyR');await page.waitForTimeout(15000);
  const end=await light();report.quietPerformance={durationMs:Date.now()-wallStarted,start,end,liveAtBothEndpoints:start?.status==='playing'&&end?.status==='playing'&&!start.paused&&!end.paused,
    interpretation:'Existing HUD/renderer FPS at two endpoints, without frequent reads for 30 seconds. Concurrency can change naturally; these are not average frame times or a synthetic benchmark.'};
  console.log('QUIET END '+JSON.stringify(report.quietPerformance));
  report.heavySnapshotAfterQuiet=await observe();await shot('quiet-performance-final');
}


// The proof is a scalar description of the triggering prior contacts. Live
// materials and equations below independently establish the actual world state.
function validateSupportProof(d){
  assert.equal(typeof d.supportedClothSlip,'boolean','Support-release flag is explicit');
  if(!d.supportedClothSlip){assert.equal(d.supportReleaseAge,null);assert.equal(d.supportReleaseProof,null);return null;}
  const p=d.supportReleaseProof,keys=['age','sustainedSeconds','torsoRatio','tiltRate','armGroundLoad','sleeveChestLoad','sleevePelvisLoad','sleeveTrunkLoad','hipSpeed','chestSpeed','hipAngularSpeed','chestAngularSpeed','waistSwingDegrees','gloveDeckFriction','selfFriction'];
  assert(p&&typeof p==='object'&&!Array.isArray(p),'Support release retains scalar contact evidence');
  assert.deepEqual(Object.keys(p).sort(),keys.sort(),'Trigger evidence contains only the locked numeric fields');
  assert(Object.values(p).every(Number.isFinite),'Trigger proof does not retain bodies, contacts or other references');
  assert(p.age>1&&p.age<=d.age+1e-6&&p.age<=2.8+1e-6,'Support only releases during the late finite physical fall');
  assert(Math.abs(d.supportReleaseAge-p.age)<1e-12,'Release age matches trigger evidence');
  assert(p.sustainedSeconds>=.02&&p.sustainedSeconds<=.02+thresholds.physicsStepSeconds+1e-9,'Loaded support persists for the actual substep hold window');
  assert(p.torsoRatio>.6&&p.torsoRatio<=1+1e-6&&Math.abs(p.tiltRate)<.2,'Trigger describes a slowly changing elevated torso');
  assert(p.sleeveChestLoad>=0&&p.sleevePelvisLoad>=0,'Independent chest and pelvis contact loads remain nonnegative');
  assert.equal(p.sleeveTrunkLoad,Math.max(p.sleeveChestLoad,p.sleevePelvisLoad),'Trunk support retains the exact maximum of independent chest and pelvis loads');
  assert(p.armGroundLoad>5&&p.sleeveTrunkLoad>5,'Trigger describes a loaded arm-ground and forearm-trunk brace, permitting opposite sides');
  assert(p.hipSpeed>=0&&p.hipSpeed<.6&&p.chestSpeed>=0&&p.chestSpeed<.6&&p.hipAngularSpeed>=0&&p.hipAngularSpeed<1.5&&p.chestAngularSpeed>=0&&p.chestAngularSpeed<1.5,'Trigger retains bounded actual core motion');
  assert.equal(p.waistSwingDegrees,60);assert.equal(p.gloveDeckFriction,0);assert.equal(p.selfFriction,0);return p;
}
function inspectSupportEvidence(record,d,evidence,observedAt){
  assert(evidence,'Read support materials from the actual death state');
  const history=record.supportMaterialEvidence||={activeSamples:0,ordinarySamples:0,releasedSamples:0,frozenSamples:0,triggerObservation:'not-triggered'};
  const reading={...observedAt,stats:structuredClone(d),world:structuredClone(evidence)};
  // Preserve the raw values before assertions so a failure can be reconstructed.
  record.lastSupportReading=reading;
  const proof=validateSupportProof(d);
  if(history.triggered)assert.equal(d.supportedClothSlip,true,'A reported release never reverts before respawn, including an initially frozen observation');
  if(d.frozen){
    assert.equal(evidence.worldPresent,false);assert.equal(evidence.supportSlidePresent,false,'Freeze clears support state and all its body references');
    assert.equal(evidence.supportSlide,null);assert.equal(evidence.materialPresent,false);assert.equal(evidence.handMaterialPresent,false);assert.equal(evidence.bootMaterialPresent,false,'Freeze clears the fitted boot material');
    assert.equal(evidence.defaultContactMaterial,null);assert.equal(evidence.waist,null);
    for(const key of ['bodyMaterials','bootShapes','thighShapes','groundMaterials','contactMaterials','contacts'])assert.deepEqual(evidence[key],[],'Freeze clears real '+key);
    history.frozenSamples++;
    if(proof){
      history.triggered=true;history.triggerProof=structuredClone(proof);
      if(history.firstReleased)assert.deepEqual(proof,history.firstReleased.stats.supportReleaseProof,'Frozen trigger evidence matches the measured released world');
      history.triggerObservation=history.firstReleased?'observed-live-world':'unobserved-active-state';
    }
    return;
  }
  assert.equal(evidence.worldPresent,true);assert.equal(evidence.materialPresent,true);assert.equal(evidence.handMaterialPresent,true);assert.equal(evidence.bootMaterialPresent,true);
  assert(Number.isFinite(evidence.worldTime)&&evidence.worldTime>=0&&Math.abs(evidence.worldTime-d.physicsSteps*thresholds.physicsStepSeconds)<1e-6,'Material read belongs to the actual stepped world');
  const slide=evidence.supportSlide;
  if(proof){
    assert.equal(evidence.supportSlidePresent,true);assert.equal(slide.released,true);assert.equal(slide.releaseAge,d.supportReleaseAge);assert.deepEqual(slide.proof,proof);
    assert(proof.age<=evidence.worldTime+1e-6,'Measured live world is not earlier than the claimed release');
  }else if(slide){assert.equal(slide.released,false);assert.equal(slide.releaseAge,null);assert.equal(slide.proof,null);}
  const ids=new Map(),assertMaterial=(m,name)=>{
    assert(m&&m.name===name&&Number.isInteger(m.id),'Read the correct real body/contact material');
    assert.equal(m.friction,-1,'Per-material friction does not override the measured contact pair');assert.equal(m.restitution,-1);
    if(ids.has(name))assert.equal(m.id,ids.get(name),'All bodies and contact pairs share the actual '+name+' material');else ids.set(name,m.id);
  };
  assert.equal(evidence.bodyMaterials.length,15);
  for(const body of evidence.bodyMaterials){assertMaterial(body.material,/^hand_[LR]$/.test(body.name)?'glove':/^ankle_[LR]$/.test(body.name)?'boot':'corpse');assert(body.shapeMaterials.length>0&&body.shapeMaterials.every(m=>m===null),'Shapes do not override actual body materials');}
  assert.equal(evidence.groundMaterials.length,1);assertMaterial(evidence.groundMaterials[0].material,'deck');assert.deepEqual(evidence.groundMaterials[0].shapeMaterials,[null]);
  assert.equal(ids.size,4);assert.equal(new Set(ids.values()).size,4,'Corpse, glove, fitted boot and deck materials are distinct');
  assert.deepEqual(evidence.bootShapes.map(boot=>boot.name).sort(),['ankle_L','ankle_R']);
  for(const boot of evidence.bootShapes){assert.equal(boot.count,1);assert.equal(boot.type,16,'The actual boot proxy is a ConvexPolyhedron');assert(boot.vertexCount>=4&&boot.vertexCount<=40&&boot.faceCount>=4&&boot.finiteVertices&&boot.validFaces&&boot.finiteNormals,'The low-point boot hull has finite vertices, normals and valid faces');}
  assert.deepEqual(evidence.thighShapes.map(thigh=>thigh.name).sort(),['leg_upper_L','leg_upper_R']);
  for(const thigh of evidence.thighShapes){assert.equal(thigh.count,1);assert.equal(thigh.type,16,'The actual upper-thigh proxy is a fitted ConvexPolyhedron');assert(Number.isInteger(thigh.vertexCount)&&thigh.vertexCount>=4&&thigh.faceCount>=4&&thigh.finiteVertices&&thigh.validFaces&&thigh.finiteNormals,'Actual thigh hull vertices, normals and face indices remain finite and valid');}
  const selfFriction=proof?0:.08,expectedPairs={'corpse|corpse':selfFriction,'corpse|glove':selfFriction,'glove|glove':selfFriction,
    'boot|corpse':selfFriction,'boot|glove':selfFriction,'boot|boot':selfFriction,'corpse|deck':.15,'deck|glove':proof?0:.03,'boot|deck':.02},seen=new Set();
  assert.equal(evidence.contactMaterials.length,9);
  const validateNormal=(cm,deck)=>{
    assert.equal(cm.restitution,0);assert.equal(cm.normalStiffness,deck?2e7:5e4);assert.equal(cm.normalRelaxation,deck?12:8);
    assert.equal(cm.frictionStiffness,deck?2e7:5e4);assert.equal(cm.frictionRelaxation,deck?4:8);
  };
  for(const cm of evidence.contactMaterials){
    assert.equal(cm.materials.length,2);for(const m of cm.materials){assert(ids.has(m.name));assertMaterial(m,m.name);}
    const pair=cm.materials.map(m=>m.name).sort().join('|');assert(Object.hasOwn(expectedPairs,pair)&&!seen.has(pair),'Read each locked actual material pair exactly once');seen.add(pair);
    assert.equal(cm.friction,expectedPairs[pair],'Actual '+pair+' friction matches the measured release state');validateNormal(cm,pair.includes('deck'));
  }
  const defaults=evidence.defaultContactMaterial;assert(defaults);assert.equal(defaults.friction,.15);validateNormal(defaults,true);
  const waist=evidence.waist,angle=(proof?60:45)*Math.PI/180,twist=25*Math.PI/180;
  assert(waist,'Read the actual waist constraint');
  for(const key of ['angle','constraintAngle','coneAngle'])assert(Math.abs(waist[key]-angle)<1e-12,'Actual waist '+key+' matches the measured release state');
  for(const key of ['twistAngle','twistLimitMax'])assert(Math.abs(waist[key]-twist)<1e-12,'Waist twist remains at 25 degrees');
  if(d.physicsSteps>0)assert(Math.abs(waist.nativeTwistMax-twist)<1e-12);
  assert.equal(waist.nativeTwistEnabled,false);assert.equal(waist.twistLimitInConstraint,true,'The anatomical twist equation remains part of the actual constraint');
  history.activeSamples++;history.latestActive=reading;record.lastMeasuredMaterials=reading;
  if(proof){history.releasedSamples++;history.firstReleased||=reading;history.triggered=true;history.triggerProof=structuredClone(proof);history.triggerObservation='observed-live-world';}
  else {history.ordinarySamples++;history.firstOrdinary||=reading;}
}

function validateThighSourceFit(fits){
  assert.deepEqual(fits.map(hull=>hull.name).sort(),['leg_upper_L','leg_upper_R']);
  for(const hull of fits){
    assert(Number.isInteger(hull.sampleCount)&&hull.sampleCount>=4&&Number.isInteger(hull.vertexCount)&&hull.vertexCount>=4&&hull.vertexCount<=hull.sampleCount,'The actual thigh hull only retains owned weighted source sample points');
    assert([hull.sourceMin,hull.sourceMax,hull.proxyMin,hull.proxyMax,hull.minDelta,hull.maxDelta].every(values=>finite(values)&&values.length===3),'Read finite original source and actual thigh envelopes');
    assert(hull.minDelta.every(value=>value>=-.0081&&value<=.0001)&&hull.maxDelta.every(value=>value>=-.0001&&value<=.0081),'Actual thigh hull follows its saved weighted source envelope with only 8mm radial skin');
  }
}
function validateCollisionEvidence(physics){
  const names=['pelvis','spine_0','head_0',...['L','R'].flatMap(side=>['arm_upper_','arm_lower_','hand_','leg_upper_','leg_lower_','ankle_'].map(prefix=>prefix+side))];
  assert.deepEqual(physics.staticBodies,[{group:1,mask:14,shapeTypes:[2]}],'The private corpse world contains exactly one ground plane and no walls/other players');
  assert.deepEqual(physics.collisionBodies.map(body=>body.name).sort(),names.sort(),'Inspect exactly the fifteen actual bone-bound bodies');
  const bodies=new Map(physics.collisionBodies.map(body=>[body.name,body]));
  for(const body of physics.collisionBodies){const expected=/^(leg_|ankle_)/.test(body.name)?[4,7]:/^(arm_|hand_)/.test(body.name)?[8,3]:[2,13];assert.deepEqual([body.group,body.mask],expected,'Actual '+body.name+' collision filters match its authored body role');}
  assert.equal(physics.collisionConnections.length,14);assert(physics.collisionConnections.every(joint=>joint.collideConnected===false),'Actual constrained neighbours cannot collide');
  for(const contact of physics.supportMaterials.contacts){
    if(contact.a==='ground'||contact.b==='ground')continue;
    const a=bodies.get(contact.a),b=bodies.get(contact.b);assert(a&&b,'Both actual self-contact bodies belong to this one corpse world');
    assert((a.mask&b.group)!==0&&(b.mask&a.group)!==0,'Actual self-contact satisfies both body filters');
    const groups=[a.group,b.group].sort((a,b)=>a-b);assert(groups[0]===4&&groups[1]===4||groups[0]===2&&[4,8].includes(groups[1]),'Actual self-contact is leg/leg or torso/limb');
    assert(!physics.collisionConnections.some(joint=>joint.a===contact.a&&joint.b===contact.b||joint.a===contact.b&&joint.b===contact.a),'Actual connected body pair has no self-contact');
  }
}

function validateAnatomy(actor){
  assert.equal(actor.missing,undefined,actor.id+': model exists');
  assert(Number.isFinite(actor.scaleMin)&&Number.isFinite(actor.scaleMax)&&actor.scaleMin>thresholds.scaleMin&&actor.scaleMax<thresholds.scaleMax,actor.id+': bone scales remain full size');
  for(const bone of actor.bones){
    assert.equal(bone.missing,undefined,actor.id+': '+bone.name+' exists');
    assert(finite(bone.world)&&finite(bone.position)&&finite(bone.rotation),actor.id+': '+bone.name+' finite pose');
    if(bone.name!=='pelvis')assert(length(bone.position.map((value,index)=>value-bone.rest[index]))<thresholds.localBoneOffset,actor.id+': '+bone.name+' local length remains authored');
    if(bone.name!=='pelvis'&&bone.lengthRatio!==null)assert(bone.lengthRatio>thresholds.boneLengthRatioMin&&bone.lengthRatio<thresholds.boneLengthRatioMax,actor.id+': '+bone.name+' world length remains authored');
  }
}

function inspectDeath(actor,sample){
  lastActorKey=actor.key;inspectedObservation=sample;
  const d=actor.death,physics=actor.physics;
  assert.equal(d?.clip,'ragdoll','Natural death uses a real ragdoll');assert.equal(d.engine,'cannon-es');
  assert.equal(d.rigidBodies,15);assert.equal(d.constraints,14);assert.equal(d.collisionMode,'ground-only');assert.equal(d.horizontalContacts,false);
  assert(Number.isInteger(d.selfContactCount)&&d.selfContactCount>=0,'Internal limb contacts are measured');
  assert(['physics','frozen'].includes(d.phase));assert(d.age>=0&&d.age<=2.8+1e-6);assert(Number.isInteger(d.physicsSteps)&&d.physicsSteps>=0&&d.physicsSteps<=thresholds.maxPhysicsSteps);assert.equal(d.physicsStepSeconds,thresholds.physicsStepSeconds,'Reported physics step matches the final 180 Hz solver');
  assert(Array.isArray(d.jointAngles)&&d.jointAngles.length===14,'Inspect all actual constrained joints');
  assert(Number.isFinite(d.maxJointGap)&&d.maxJointGap<thresholds.activeJointGap,'Constrained segments stay connected during the fall');
  assert(physics&&physics.externalContactsOnlyGround&&physics.selfContactsOnlyNonAdjacentLimbs,'World contacts are ground-only; internal contacts are non-adjacent leg/leg or torso/limb pairs');
  const record=deathRecords.get(actor.key)||{key:actor.key,id:actor.id,team:actor.team,local:actor.id===sample.localId,deathAt:actor.deathAt,
    phases:[],samples:0,frozen:false,stableSamples:0,respawned:false,maxJointGap:0,maxBendViolation:0};
  if(!record.phases.includes(d.phase))record.phases.push(d.phase);record.samples++;record.maxJointGap=Math.max(record.maxJointGap,d.maxJointGap);record.maxBendViolation=Math.max(record.maxBendViolation,d.maxBendViolation);
  deathRecords.set(actor.key,record);
  if(actor.initialDeath)record.initial=actor.initialDeath;
  // Preserve the full true pose before any anatomical assertion can fail. This
  // is diagnostic evidence for a separate scene, never a write to the match.
  if(actor.skinBounds){record.frozenPose={bones:actor.allBones,skinBounds:actor.skinBounds,footGeometry:actor.footGeometry,headPelvis:actor.headPelvis,torsoVerticalRatio:actor.torsoVerticalRatio,headAnkles:actor.headAnkles,legSpans:actor.legSpans,physics:actor.physics,death:actor.death};}
  inspectSupportEvidence(record,d,physics.supportMaterials,{time:sample.time,method:'full read-only actor observation'});
  if(physics.bootSourceFit){
    record.bootSourceFit=physics.bootSourceFit;
    assert.deepEqual(physics.bootSourceFit.map(boot=>boot.name).sort(),['ankle_L','ankle_R']);
    for(const boot of physics.bootSourceFit){
      assert(boot.sampleCount>=4&&[boot.sourceMin,boot.sourceMax,boot.proxyMin,boot.proxyMax,boot.minDelta,boot.maxDelta].every(finite),'Read finite source and actual fitted convex boot envelopes');
      assert(boot.minDelta.every(value=>value>=-.0081&&value<=.0001)&&boot.maxDelta.every(value=>value>=-.0001&&value<=.0081),'Actual boot hull follows the saved weighted source envelope with only its 8mm radial skin');
    }
  }
  if(physics.thighSourceFit){
    record.thighSourceFit=physics.thighSourceFit;
    validateThighSourceFit(physics.thighSourceFit);
  }
  if(!d.frozen){
    assert.equal(physics.worldPresent,true);assert.equal(physics.bodies,15);assert.equal(physics.bindings,15);assert.equal(physics.joints,14);
    if(d.physicsSteps>0)assert(Math.abs(physics.worldDt-d.physicsStepSeconds)<1e-12,'Actual Cannon world dt matches reported fixed step after a physical step');
    assert.equal(physics.worldBodies,16);assert.equal(physics.worldConstraints,14);
    validateCollisionEvidence(physics);
    assert.equal(physics.groundContacts,d.groundContactCount);assert.equal(physics.selfContacts,d.selfContactCount,'Reported contacts match the actual private Cannon world');
    assert.equal(physics.jointsMeasured.length,14);
    const actualGap=Math.max(...physics.jointsMeasured.map(joint=>joint.gap)),actualBend=Math.max(0,...physics.jointsMeasured.filter(joint=>joint.kind==='hinge').map(joint=>joint.violation));
    assert(Math.abs(actualGap-d.maxJointGap)<1e-5,'Reported joint gap agrees with independent physical pivot measurement');assert(Math.abs(actualBend-d.maxBendViolation)<1e-5,'Reported elbow/knee bend agrees with independently measured rigid-body rotation');
    for(const actual of physics.jointsMeasured){const reported=d.jointAngles.find(joint=>joint.name===actual.name);assert(reported&&reported.kind===actual.kind);assert(Math.abs(actual[actual.kind==='hinge'?'bend':'swing']-reported[actual.kind==='hinge'?'bend':'swing'])<1e-5,'Joint angle is read from the actual physics bodies');}
    record.lastMeasuredJoints=physics.jointsMeasured;
    record.lastMeasuredBodies=physics.bodiesMeasured;
  }else{
    assert.equal(d.phase,'frozen');assert(['sleep','time-budget'].includes(d.freezeReason));
    assert.equal(physics.worldPresent,false,'Settled corpse releases its physics world');
    for(const key of ['bodies','bindings','joints','poses','worldBodies','worldConstraints'])assert.equal(physics[key],0,'Settled corpse releases '+key);
    assert(d.maxJointGap<thresholds.finalJointGap,'Final physical joint gap stays bounded');assert(d.maxBendViolation<thresholds.finalBendViolation,'Final elbow/knee limit overshoot stays bounded');
    assert(d.maxTwistViolation<thresholds.finalTwistViolation,'Final joint twist stays inside the anatomical limit');assert(d.maxSwingViolation<thresholds.finalSwingViolation,'Final joint swing stays inside the anatomical limit');
    assert(actor.headPelvis>thresholds.headPelvis,'Corpse torso remains full size');assert(Number.isFinite(actor.torsoVerticalRatio)&&actor.torsoVerticalRatio<=thresholds.torsoVerticalRatioMax,'Frozen torso has settled instead of remaining upright on its limbs');
    const farHeadAnkle=Math.max(...actor.headAnkles),maxLegSpan=Math.max(...actor.legSpans),farFoot=farHeadAnkle>thresholds.farHeadAnkle,extendedLegs=actor.legSpans.every(value=>value>thresholds.extendedLegSpan),singleExtendedLeg=maxLegSpan>thresholds.singleExtendedLegSpan&&farHeadAnkle>thresholds.singleExtendedFarHeadAnkle;
    assert(farFoot||extendedLegs||singleExtendedLeg,'Spread posture retains a far ankle, two bent legs with reach, or one extended leg with a distant ankle');record.postureClassification={farFoot,extendedLegs,singleExtendedLeg,farHeadAnkle,maxLegSpan,legSpans:[...actor.legSpans]};
    assert(actor.legSpans.every(value=>value>thresholds.legSpan),'Bent knees keep their anatomical reach');
    const signature=JSON.stringify([actor.position,actor.visual,actor.bones.map(({name,position,rotation,world})=>({name,position,rotation,world})),d.physicsSteps,d.contactPasses]);
    const previous=frozenSignatures.get(actor.key);
    if(previous){assert.equal(signature,previous.signature,'Frozen corpse does not drift or continue physics/contact work');if(sample.time-previous.time>=1/60-1e-6)record.stableSamples++;}
    frozenSignatures.set(actor.key,{signature,time:sample.time});record.frozen=true;record.final=structuredClone(d);
    if(actor.skinBounds){
      const b=actor.skinBounds;assert(finite(b.min)&&finite(b.max)&&finite(b.size)&&b.vertices>100,'Measure actual skinned body bounds');
      assert(Math.max(b.size[0],b.size[2])>thresholds.horizontalExtent,'Frozen corpse does not collapse into a small ball');assert(b.size[1]<thresholds.height,'Grounded body settles with a plausible bent posture');
      const clearance=b.min[1]-physics.ground;assert(clearance>=thresholds.groundMin&&clearance<=thresholds.groundMax,'Skinned corpse remains supported by the actual ground');
      const feet=actor.footGeometry;assert(feet&&feet.headVertices>2&&feet.footVertices.every(count=>count>2),'Measure actual head and both boot meshes');
      assert(feet.headClearances.every(value=>Number.isFinite(value)&&value>thresholds.headFootMeshSeparation),'Head and boot sampled vertices do not coincide');
      record.footGeometry=feet;
      record.skinBounds=b;record.groundClearance=clearance;measuredKeys.add(actor.key);
    }
  }
  return record;
}

try{
  browser=await chromium.launch({channel:'chrome',headless:true,args:['--no-first-run']});report.browser=browser.version();
  const context=await browser.newContext({viewport:{width:1500,height:950}});page=await context.newPage();page.setDefaultTimeout(15000);page.setDefaultNavigationTimeout(180000);
  page.on('pageerror',error=>report.errors.push(error.message));page.on('requestfailed',request=>{if(!closing)report.failedRequests.push({url:request.url(),error:request.failure()?.errorText});});
  page.on('response',response=>{report.responses.push({url:response.url(),status:response.status()});if(response.status()>=400)report.failedRequests.push({url:response.url(),status:response.status()});});
  pulse=setInterval(()=>console.log('PROGRESS '+JSON.stringify({stage,elapsedSeconds:Math.round((Date.now()-started)/1000),samples:report.samples.length,naturalDeaths:deathRecords.size,localDeaths:[...deathRecords.values()].filter(record=>record.local).length,errors:report.errors.length})),10000);
  stage='cold public load';await page.goto(target.href,{waitUntil:'domcontentloaded'});await page.locator('#loading').waitFor({state:'hidden',timeout:180000});
  await page.waitForFunction(()=>Boolean(window.__freight?.view?.viewModel),null,{timeout:180000});report.readyMs=Date.now()-started;
  stage='verify exact public modules and currently selected models';
  for(const name of ['character-death.js','character-v2.js','render.js','death-camera.js','viewmodel-cs2.js','asset-loading.js','vendor/cannon-es.js']){
    const response=await context.request.get(new URL(name,target).href,{timeout:60000});assert.equal(response.status(),200,name);
    const actual=createHash('sha256').update(await response.body()).digest('hex'),expected=createHash('sha256').update(await readFile(path.join(root,'games/freight-fire',name))).digest('hex');
    assert.equal(actual,expected,name+' public/local hash mismatch');report.moduleHashes.push({name,sha256:actual});
  }
  report.characterDeathSHA256=report.moduleHashes.find(module=>module.name==='character-death.js').sha256;
  if(process.env.FREIGHT_EXPECTED_CHARACTER_SHA)assert.equal(report.characterDeathSHA256,process.env.FREIGHT_EXPECTED_CHARACTER_SHA);
  check('Public ragdoll, camera, renderer, viewmodel and Cannon modules match source',true,{readyMs:report.readyMs,expectedRelease:report.expectedRelease,moduleHashes:report.moduleHashes});
  const original=JSON.parse(await readFile(path.join(root,'games/freight-fire/assets/viewmodel-cs2/original-skins.json'),'utf8'));
  const community=JSON.parse(await readFile(path.join(root,'games/freight-fire/assets/viewmodel-cs2/skin-selection-community.json'),'utf8'));
  const models=[...original.assets.filter(asset=>/\/(ct-sas-harbor|t-phoenix-harbor)\.glb$/.test(asset.output.path)).map(asset=>asset.output),...community.skins.map(skin=>skin.output)];
  assert.deepEqual(models.map(model=>path.basename(model.path)).sort(),['ak47-vulcan.glb','ct-sas-harbor.glb','m4a1-printstream.glb','t-phoenix-harbor.glb']);
  for(const model of models){
    const local=await readFile(path.join(root,model.path));assert.equal(local.length,model.bytes);assert.equal(createHash('sha256').update(local).digest('hex'),model.sha256,'Local selected model matches lock');
    const relative=model.path.replace(/^games\/freight-fire\//,''),url=new URL(relative,target).href;
    assert(report.responses.some(response=>response.url===url&&response.status===200),'Cold session requested '+relative);
    const actual=await page.evaluate(async url=>{const response=await fetch(url,{cache:'force-cache',signal:AbortSignal.timeout(60000)});if(!response.ok)throw Error('Model verification HTTP '+response.status);const bytes=await response.arrayBuffer(),hash=await crypto.subtle.digest('SHA-256',bytes);return {bytes:bytes.byteLength,sha256:[...new Uint8Array(hash)].map(byte=>byte.toString(16).padStart(2,'0')).join('')};},url);
    assert.equal(actual.bytes,model.bytes);assert.equal(actual.sha256,model.sha256);report.modelHashes.push({url,...actual});
  }
  check('Cold page loads the harbor arms, Vulcan and Printstream GLBs',true,report.modelHashes);
  stage=`start actual ${size}v${size} match`;
  await page.locator('#nickname').fill('布娃娃公网验收');await page.locator('#size').selectOption(String(size));await page.locator('#difficulty').selectOption('hard');await page.locator('#goal').selectOption('80');
  await page.mouse.move(mouseX,475);await page.locator('#start').click();await page.locator('#hud').waitFor({state:'visible'});await page.waitForFunction(count=>window.__freight?.snapshot?.players.length===count,size*2);
  const initial=await observe();assert.equal(initial.count,size*2);assert.equal(initial.paused,false);await shot('01-start-real-match');
  check('Normal Start creates the requested live bot match',true,{localId:initial.localId,playerCount:initial.count});
  const playStarted=Date.now();stage='actual W/F/R/strafe and read-only natural corpse observation';
  await rearmControls(initial,0,'Normal Start');
  while(Date.now()-playStarted<playSeconds*1000){
    let elapsed=(Date.now()-playStarted)/1000;
    if(latestObservation?.local?.alive&&elapsed-lastKeyRefresh>=.8){await page.keyboard.down('KeyW');await page.keyboard.down('KeyF');lastKeyRefresh=elapsed;}
    if(elapsed-lastReload>=4){await page.keyboard.press('KeyR');lastReload=elapsed;}
    const strafe=Math.floor(elapsed/3)%4;if(strafe!==lastStrafe){await page.keyboard.up('KeyA');await page.keyboard.up('KeyD');if(strafe===0)await page.keyboard.down('KeyD');if(strafe===2)await page.keyboard.down('KeyA');lastStrafe=strafe;}
    let sample=await observe();if(!sample){await page.waitForTimeout(50);continue;}
    assert.equal(sample.paused,false,'Natural match remains active');assert.equal(sample.count,size*2);
    const ownCorpse=sample.actors.find(actor=>actor.id===sample.localId&&!actor.alive&&actor.death?.age>=2.55);
    if(ownCorpse&&!frozenPairAttempts.has(ownCorpse.key)){
      // Capture initial physics/strict anatomy before waiting on the untouched
      // live corpse. A quick pair precedes optional PNG or all-player reads.
      validateAnatomy(ownCorpse);const record=inspectDeath(ownCorpse,sample);frozenPairAttempts.add(ownCorpse.key);
      verifyFrozenPair(record,await fastFrozenPair(ownCorpse.key));
      sample=await observe();assert(sample,'The live match remains observable after quick freeze sampling');elapsed=(Date.now()-playStarted)/1000;
      assert.equal(sample.paused,false);assert.equal(sample.count,size*2);
    }
    for(const event of sample.events){if(eventSeen.has(event.seq))continue;eventSeen.add(event.seq);if(event.playerId===sample.localId&&event.type==='shot')localShots++;if(event.playerId===sample.localId&&event.type==='reload')localReloads++;}
    if(sample.local?.reloading)reloadObserved=true;
    let activeWorlds=0,bodies=0,constraints=0,frozenCorpses=0;
    for(const actor of sample.actors){
      lastActorKey=actor.key;inspectedObservation=sample;
      validateAnatomy(actor);
      if(actor.alive){
        liveSamples++;assert.equal(actor.death,null,'Natural respawn clears corpse diagnostics');assert.equal(actor.physics,null,'Natural respawn clears the physics state');assert.equal(actor.skinVisible,true);
        if(lastAlive.get(actor.id)===false){const record=deathRecords.get(actor.key);assert(record,'Respawn has an observed natural death');record.respawned=true;record.respawnTime=sample.time;if(record.local&&!record.respawnScreenshot){record.respawnScreenshot=`local-${actor.deaths}-natural-respawn`;await shot(record.respawnScreenshot);}if(record.local)await rearmControls(sample,elapsed,'Natural respawn clears the game key set');}
        if(actor.upperActive&&actor.upperMode==='shoot'&&actor.activeOverlay.some(name=>name.endsWith('/shoot'))){fireSamples++;firedTeams.add(actor.team);}
        if(actor.id===sample.localId)assert.equal(sample.cameraDeath,null,'Respawn returns to the normal player camera');
      }else{
        const record=inspectDeath(actor,sample);if(actor.death.frozen)frozenCorpses++;
        if(actor.physics.worldPresent)activeWorlds++;bodies+=actor.physics.worldBodies;constraints+=actor.physics.worldConstraints;
        if(record.local&&sample.cameraDeath){
          const c=sample.cameraDeath;assert(finite(c.position)&&finite(c.origin)&&finite(c.target)&&finite(c.center),'Death camera has a finite body target');
          assert(c.position[1]>=c.ground+thresholds.cameraGroundClearance,'Death camera remains above the deck');assert(length(c.position.map((value,index)=>value-c.origin[index]))<thresholds.cameraDistance,'Death camera stays near the actual corpse');
          if(c.age>1.65){assert.equal(c.phase,'corpse');assert.equal(c.bodyVisible,true);assert(c.targetError<thresholds.cameraTargetError,'Camera follows the actual skinned torso');assert(c.aimDot>thresholds.cameraAimDot,'Actual camera looks at the corpse');assert(finite(c.centerNDC)&&Math.abs(c.centerNDC[0])<1&&Math.abs(c.centerNDC[1])<1&&Math.abs(c.centerNDC[2])<1,'Corpse center lies inside the visible camera frustum');record.cameraVerified=true;}
          report.cameraSamples.push({key:actor.key,elapsed,...c});
          if(c.age>1.65&&!record.cameraScreenshot){record.cameraScreenshot=`local-${actor.deaths}-natural-death-camera`;await shot(record.cameraScreenshot);}
          if(actor.death.frozen&&!record.frozenCaptureAttempted&&record.stableSamples>0){
            // Stability was already read across two live renderer frames. The
            // optional PNG can race respawn without invalidating that evidence.
            record.frozenCaptureAttempted=true;await frozenShot(record);
          }
        }
      }
      lastAlive.set(actor.id,actor.alive);
    }
    assert(bodies<=sample.count*16&&constraints<=sample.count*14,'Physics resources are bounded by current natural corpses');
    peakActiveWorlds=Math.max(peakActiveWorlds,activeWorlds);peakBodies=Math.max(peakBodies,bodies);peakConstraints=Math.max(peakConstraints,constraints);peakFrozenCorpses=Math.max(peakFrozenCorpses,frozenCorpses);
    report.samples.push({elapsed,time:sample.time,local:sample.local,observationMs:sample.observationMs,cost:{activeWorlds,bodies,constraints,frozenCorpses,...sample.renderStats},actors:sample.actors.map(({bones,activeOverlay,skinBounds,allBones,initialDeath,...actor})=>actor)});
    if(sample.local?.alive)await recoverPastCover(sample.local,elapsed);
    if(elapsed>10&&!playingCaptured){await shot('02-actual-fire-and-movement');playingCaptured=true;}
    const complete=[...deathRecords.values()].filter(record=>record.frozen&&record.stableSamples>0&&record.respawned&&record.skinBounds),locals=complete.filter(record=>record.local&&record.cameraVerified&&record.cameraScreenshot&&record.respawnScreenshot);
    if(elapsed>25&&complete.length>=2&&locals.length>=2&&firedTeams.size===2&&fireSamples>5&&localShots>0&&reloadObserved)break;
    await page.waitForTimeout(sample.local?.alive?60:35);
  }
  report.playMs=Date.now()-playStarted;
  for(const key of ['KeyW','KeyF','KeyA','KeyD'])await page.keyboard.up(key);
  check('Live firing preserves both teams and authored bone lengths',firedTeams.size===2&&fireSamples>5&&localShots>0&&reloadObserved,{liveSamples,fireSamples,firedTeams:[...firedTeams],localShots,localReloadEvents:localReloads,reloadObserved});
  const complete=[...deathRecords.values()].filter(record=>record.frozen&&record.stableSamples>0&&record.respawned&&record.skinBounds),locals=complete.filter(record=>record.local&&record.cameraVerified&&record.cameraScreenshot&&record.respawnScreenshot);
  check('At least two natural deaths freeze, release physics and respawn',complete.length>=2,{completeDeaths:complete.map(record=>record.key),observedDeaths:deathRecords.size});
  check('Two actual player cameras show physical falls followed by verified freeze and natural respawn',locals.length>=2,{localDeaths:locals.map(record=>({key:record.key,cameraScreenshot:record.cameraScreenshot,frozenStableSamples:record.stableSamples,frozenScreenshot:record.frozenScreenshot||null,respawnScreenshot:record.respawnScreenshot}))});
  const supportEvidence=[...deathRecords.values()].map(record=>({key:record.key,...record.supportMaterialEvidence}));
  report.supportMaterialSummary={sourceFittedDeaths:[...deathRecords.values()].filter(record=>record.bootSourceFit).map(record=>record.key),sourceFittedThighDeaths:[...deathRecords.values()].filter(record=>record.thighSourceFit).map(record=>record.key),activeSamples:supportEvidence.reduce((sum,item)=>sum+item.activeSamples,0),releasedSamples:supportEvidence.reduce((sum,item)=>sum+item.releasedSamples,0),
    triggered:supportEvidence.filter(item=>item.triggered).map(item=>({key:item.key,observation:item.triggerObservation,proof:item.triggerProof})),
    unobservedActiveTriggers:supportEvidence.filter(item=>item.triggerObservation==='unobserved-active-state').map(item=>item.key)};
  check('Observed live Cannon materials and waist equations match their measured support state',report.supportMaterialSummary.activeSamples>0,report.supportMaterialSummary);
  check('Both actual player deaths retain source-fitted convex boot evidence',locals.every(record=>record.bootSourceFit?.length===2),locals.map(record=>({key:record.key,bootSourceFit:record.bootSourceFit||null})));
  check('Both actual player deaths retain saved-source upper-thigh hull evidence',locals.every(record=>record.thighSourceFit?.length===2),locals.map(record=>({key:record.key,thighSourceFit:record.thighSourceFit||null})));
  report.cost={peakActiveWorlds,peakBodies,peakConstraints,peakFrozenCorpses,playerCount:size*2};
  check('Observed physics resources remain bounded and frozen worlds are released',true,report.cost);await shot('04-match-final');
  check('No public runtime or asset request errors',!report.errors.length&&!report.failedRequests.length,{errors:report.errors,failedRequests:report.failedRequests,playMs:report.playMs});report.ok=true;
}catch(error){report.ok=false;report.failure=error.stack;report.failureActorKey=lastActorKey;report.failureSample=inspectedObservation||latestObservation;process.exitCode=1;console.error(error.stack);if(page)await shot('failure').catch(()=>{});}
finally{
  if(quietPerf&&page&&latestObservation?.status==='playing')await quietPerformance().catch(error=>{report.quietPerformanceFailure=error.stack;console.error('QUIET FAILURE '+error.stack);});
  clearInterval(pulse);closing=true;report.deaths=[...deathRecords.values()];
  for(const key of ['KeyW','KeyF','KeyA','KeyD'])await page?.keyboard.up(key).catch(()=>{});
  await browser?.close();
  if(report.failureSample){
    const actor=report.failureSample.actors.find(candidate=>candidate.key===report.failureActorKey);
    await writeFile(path.join(out,'failure-snapshot.json'),JSON.stringify({date:report.date,expectedRelease:report.expectedRelease,url:report.url,
      provenance:'Exact read-only actor data from the ordinary public match; a reconstruction must be labelled diagnostic rather than gameplay.',
      moduleHashes:report.moduleHashes,modelHashes:report.modelHashes,time:report.failureSample.time,failure:report.failure,actor,
      deathRecord:deathRecords.get(report.failureActorKey)||null},null,2)+'\n');
  }
  await writeFile(path.join(out,'report.json'),JSON.stringify(report,null,2)+'\n');console.log('REPORT '+path.join(out,'report.json'));
}
