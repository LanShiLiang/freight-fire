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
const out=path.resolve(root,option('--out')||'artifacts/character-public');
const outRelative=path.relative(root,out);assert(!outRelative.startsWith('..')&&!path.isAbsolute(outRelative),'Output must stay inside the workspace');
await mkdir(out,{recursive:true});
const thresholds={scaleMin:.97,scaleMax:1.03,localBoneOffset:.004,boneLengthRatioMin:.97,boneLengthRatioMax:1.03,
  headPelvis:.60,farHeadAnkle:.9,extendedLegSpan:.60,headFootMeshSeparation:1e-4,legSpan:.46,horizontalExtent:1.2,height:1.05,groundMin:-.055,groundMax:.09,
  finalJointGap:.03,finalBendViolation:.06,finalTwistViolation:.06,finalSwingViolation:.06,
  activeJointGap:.18,physicsStepSeconds:1/180,maxPhysicsSteps:504,cameraGroundClearance:.23,cameraDistance:5.5,cameraTargetError:.6,cameraAimDot:.97};
const report={date:new Date().toISOString(),url:target.href,size,playSeconds,expectedRelease:process.env.FREIGHT_EXPECTED_RELEASE||null,
  thresholds,checks:[],samples:[],deaths:[],cameraSamples:[],captureObservations:[],screenshots:[],errors:[],failedRequests:[],responses:[],moduleHashes:[],modelHashes:[],
  limitations:[`One real ${size}v${size} bot match, bounded to ${playSeconds} seconds of play; death outcomes are not forced.`,
    'No actor fixtures, teleport, health changes, input-object or camera writes. All screenshots use the actual player camera.',
    'Ragdoll permits genuine elbow/knee bends. Anatomy checks reject compressed bodies without requiring the old flat, straight death pose.',
    'Spread posture requires a head-to-far-ankle distance over 0.9m OR both hip-to-ankle leg spans over 0.60m, together with the unchanged torso, minimum leg reach, bounds, ground, bone and joint checks.',
    'Camera aim and NDC checks establish direction and frustum membership, not lack of occlusion. Actual death-camera PNGs require a separate visual check that the corpse is visible.',
    'Physics cost records the naturally observed concurrent corpses, not a synthetic simultaneous-death benchmark.',
    'Head/boot proximity groups actual skinned vertices by their strongest bone weight and measures nearest vertex distances; this does not test triangle/surface intersections or prove that volumes do not overlap.',
    'A supplied release name is an expected deployment identity; exact public/local module and model hashes independently verify served content.']};
const started=Date.now();let browser,page,cdp,pulse,closing=false,stage='launch',latestObservation=null,inspectedObservation=null,lastActorKey=null;
const measuredKeys=new Set(),deathRecords=new Map(),lastAlive=new Map(),frozenSignatures=new Map(),eventSeen=new Set(),firedTeams=new Set();
let liveSamples=0,fireSamples=0,localShots=0,localReloads=0,reloadObserved=false,lastReload=-10,lastStrafe=-1,playingCaptured=false;
let peakActiveWorlds=0,peakBodies=0,peakConstraints=0,peakFrozenCorpses=0;
const check=(name,passed,details)=>{report.checks.push({name,passed,details});console.log((passed?'PASS ':'FAIL ')+name);assert(passed,name+': '+JSON.stringify(details));};
async function shot(name){const filename=name+'.png';await page.screenshot({path:path.join(out,filename)});report.screenshots.push(filename);console.log('SCREENSHOT '+filename);}
// Read pixels directly without changing the live scene or delaying respawn.
// An asynchronous capture that crosses respawn is kept as race evidence.
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
    const physics=state?{worldPresent:state.world!==null,bodies:state.bodies.length,bindings:state.bindings.length,joints:state.joints.length,poses:state.poses.length,
      worldBodies:state.world?.bodies.length||0,worldConstraints:state.world?.constraints.length||0,worldDt:state.world?.dt??null,worldAllowSleep:state.world?.allowSleep??null,solverIterations:state.world?.solver.iterations??null,bodyAllowSleep:state.bodies.map(body=>body.allowSleep),
      bodiesMeasured:state.bindings.map(({bone,body,offset})=>({name:bone.name,position:[body.position.x,body.position.y,body.position.z],rotation:[body.quaternion.x,body.quaternion.y,body.quaternion.z,body.quaternion.w],
        velocity:[body.velocity.x,body.velocity.y,body.velocity.z],angularVelocity:[body.angularVelocity.x,body.angularVelocity.y,body.angularVelocity.z],offset:offset.toArray(),
        shapes:body.shapes.map((shape,index)=>({type:shape.type,halfExtents:shape.halfExtents?[shape.halfExtents.x,shape.halfExtents.y,shape.halfExtents.z]:null,radius:shape.radius??null,
          offset:[body.shapeOffsets[index].x,body.shapeOffsets[index].y,body.shapeOffsets[index].z],rotation:[body.shapeOrientations[index].x,body.shapeOrientations[index].y,body.shapeOrientations[index].z,body.shapeOrientations[index].w]}))})),
      dynamicCollisionMasks:state.bodies.map(body=>[body.collisionFilterGroup,body.collisionFilterMask]),
      staticBodies:(state.world?.bodies||[]).filter(body=>body.mass===0).map(body=>({group:body.collisionFilterGroup,mask:body.collisionFilterMask,shapeTypes:body.shapes.map(shape=>shape.type)})),
      groundContacts:(state.world?.contacts||[]).filter(contact=>contact.bi.mass===0||contact.bj.mass===0).length,
      selfContacts:(state.world?.contacts||[]).filter(contact=>contact.bi.mass>0&&contact.bj.mass>0).length,
      externalContactsOnlyGround:(state.world?.contacts||[]).filter(contact=>contact.bi.mass===0||contact.bj.mass===0).every(contact=>[contact.bi,contact.bj].filter(body=>body.mass===0).every(body=>body.collisionFilterGroup===1&&body.shapes.length===1&&body.shapes[0].type===2)),
      selfContactsOnlyNonAdjacentLimbs:(state.world?.contacts||[]).filter(contact=>contact.bi.mass>0&&contact.bj.mass>0).every(contact=>{
        const groups=[contact.bi.collisionFilterGroup,contact.bj.collisionFilterGroup].sort((a,b)=>a-b);
        return groups[0]===2&&[4,8].includes(groups[1])&&!state.joints.some(({constraint})=>constraint.bodyA===contact.bi&&constraint.bodyB===contact.bj||constraint.bodyA===contact.bj&&constraint.bodyB===contact.bi);
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
      headPelvis:distance(head,pelvis),headAnkles:['L','R'].map(side=>distance(head,world(d.bones['ankle_'+side]))),
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
    local:me?{alive:me.alive,hp:me.hp,deaths:me.deaths,position:[me.x,me.y,me.z],ammo:me.ammo[me.weapon],reloading:me.reloadUntil>f.snapshot.time}:null,
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
  assert(physics&&physics.externalContactsOnlyGround&&physics.selfContactsOnlyNonAdjacentLimbs,'World contacts are ground-only and internal contacts are bounded to non-adjacent limbs versus torso');
  const record=deathRecords.get(actor.key)||{key:actor.key,id:actor.id,team:actor.team,local:actor.id===sample.localId,deathAt:actor.deathAt,
    phases:[],samples:0,frozen:false,stableSamples:0,respawned:false,maxJointGap:0,maxBendViolation:0};
  if(!record.phases.includes(d.phase))record.phases.push(d.phase);record.samples++;record.maxJointGap=Math.max(record.maxJointGap,d.maxJointGap);record.maxBendViolation=Math.max(record.maxBendViolation,d.maxBendViolation);
  deathRecords.set(actor.key,record);
  if(actor.initialDeath)record.initial=actor.initialDeath;
  // Preserve the full true pose before any anatomical assertion can fail. This
  // is diagnostic evidence for a separate scene, never a write to the match.
  if(actor.skinBounds){record.frozenPose={bones:actor.allBones,skinBounds:actor.skinBounds,footGeometry:actor.footGeometry,headPelvis:actor.headPelvis,headAnkles:actor.headAnkles,legSpans:actor.legSpans,physics:actor.physics,death:actor.death};}
  if(!d.frozen){
    assert.equal(physics.worldPresent,true);assert.equal(physics.bodies,15);assert.equal(physics.bindings,15);assert.equal(physics.joints,14);
    if(d.physicsSteps>0)assert(Math.abs(physics.worldDt-d.physicsStepSeconds)<1e-12,'Actual Cannon world dt matches reported fixed step after a physical step');
    assert.equal(physics.worldBodies,16);assert.equal(physics.worldConstraints,14);
    assert.deepEqual(physics.staticBodies,[{group:1,mask:14,shapeTypes:[2]}],'The private corpse world contains one ground plane and no walls/other players');
    assert(physics.dynamicCollisionMasks.every(([group,mask])=>group===2&&mask===13||[4,8].includes(group)&&mask===3),'Only the ground and constrained limb-versus-torso collision groups are enabled');
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
    assert(actor.headPelvis>thresholds.headPelvis,'Corpse torso remains full size');
    const farFoot=Math.max(...actor.headAnkles)>thresholds.farHeadAnkle,extendedLegs=actor.legSpans.every(value=>value>thresholds.extendedLegSpan);
    assert(farFoot||extendedLegs,'Spread posture retains a far ankle or anatomical reach in both bent legs');record.postureClassification={farFoot,extendedLegs,farHeadAnkle:Math.max(...actor.headAnkles),legSpans:[...actor.legSpans]};
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
  await page.locator('#start').click();await page.locator('#hud').waitFor({state:'visible'});await page.waitForFunction(count=>window.__freight?.snapshot?.players.length===count,size*2);
  const initial=await observe();assert.equal(initial.count,size*2);assert.equal(initial.paused,false);await shot('01-start-real-match');
  check('Normal Start creates the requested live bot match',true,{localId:initial.localId,playerCount:initial.count});
  const playStarted=Date.now();stage='actual W/F/R/strafe and read-only natural corpse observation';
  await page.keyboard.down('KeyW');await page.keyboard.down('KeyF');
  while(Date.now()-playStarted<playSeconds*1000){
    const elapsed=(Date.now()-playStarted)/1000;
    if(elapsed-lastReload>=4){await page.keyboard.press('KeyR');lastReload=elapsed;}
    const strafe=Math.floor(elapsed/3)%4;if(strafe!==lastStrafe){await page.keyboard.up('KeyA');await page.keyboard.up('KeyD');if(strafe===0)await page.keyboard.down('KeyD');if(strafe===2)await page.keyboard.down('KeyA');lastStrafe=strafe;}
    const sample=await observe();if(!sample){await page.waitForTimeout(75);continue;}
    assert.equal(sample.paused,false,'Natural match remains active');assert.equal(sample.count,size*2);
    for(const event of sample.events){if(eventSeen.has(event.seq))continue;eventSeen.add(event.seq);if(event.playerId===sample.localId&&event.type==='shot')localShots++;if(event.playerId===sample.localId&&event.type==='reload')localReloads++;}
    if(sample.local?.reloading)reloadObserved=true;
    let activeWorlds=0,bodies=0,constraints=0,frozenCorpses=0;
    for(const actor of sample.actors){
      lastActorKey=actor.key;inspectedObservation=sample;
      validateAnatomy(actor);
      if(actor.alive){
        liveSamples++;assert.equal(actor.death,null,'Natural respawn clears corpse diagnostics');assert.equal(actor.physics,null,'Natural respawn clears the physics state');assert.equal(actor.skinVisible,true);
        if(lastAlive.get(actor.id)===false){const record=deathRecords.get(actor.key);assert(record,'Respawn has an observed natural death');record.respawned=true;record.respawnTime=sample.time;if(record.local&&!record.respawnScreenshot){record.respawnScreenshot=`local-${actor.deaths}-natural-respawn`;await shot(record.respawnScreenshot);}}
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
          if(actor.death.frozen&&!record.frozenCaptureAttempted){
            // Two live samples prove freeze/release/stability independently of
            // the optional screenshot's short 2.8-to-3-second camera window.
            await page.waitForTimeout(40);const next=await observe(),same=next?.actors.find(candidate=>candidate.key===actor.key&&!candidate.alive&&candidate.death?.frozen);
            if(same){inspectDeath(same,next);record.frozenCaptureAttempted=true;await frozenShot(record);}
          }
        }
      }
      lastAlive.set(actor.id,actor.alive);
    }
    assert(bodies<=sample.count*16&&constraints<=sample.count*14,'Physics resources are bounded by current natural corpses');
    peakActiveWorlds=Math.max(peakActiveWorlds,activeWorlds);peakBodies=Math.max(peakBodies,bodies);peakConstraints=Math.max(peakConstraints,constraints);peakFrozenCorpses=Math.max(peakFrozenCorpses,frozenCorpses);
    report.samples.push({elapsed,time:sample.time,local:sample.local,observationMs:sample.observationMs,cost:{activeWorlds,bodies,constraints,frozenCorpses,...sample.renderStats},actors:sample.actors.map(({bones,activeOverlay,skinBounds,allBones,initialDeath,...actor})=>actor)});
    if(elapsed>10&&!playingCaptured){await shot('02-actual-fire-and-movement');playingCaptured=true;}
    const complete=[...deathRecords.values()].filter(record=>record.frozen&&record.stableSamples>0&&record.respawned&&record.skinBounds),locals=complete.filter(record=>record.local&&record.cameraVerified&&record.cameraScreenshot&&record.respawnScreenshot);
    if(elapsed>25&&complete.length>=2&&locals.length>=2&&firedTeams.size===2&&fireSamples>5&&localShots>0&&reloadObserved)break;
    await page.waitForTimeout(75);
  }
  report.playMs=Date.now()-playStarted;
  for(const key of ['KeyW','KeyF','KeyA','KeyD'])await page.keyboard.up(key);
  check('Live firing preserves both teams and authored bone lengths',firedTeams.size===2&&fireSamples>5&&localShots>0&&reloadObserved,{liveSamples,fireSamples,firedTeams:[...firedTeams],localShots,localReloadEvents:localReloads,reloadObserved});
  const complete=[...deathRecords.values()].filter(record=>record.frozen&&record.stableSamples>0&&record.respawned&&record.skinBounds),locals=complete.filter(record=>record.local&&record.cameraVerified&&record.cameraScreenshot&&record.respawnScreenshot);
  check('At least two natural deaths freeze, release physics and respawn',complete.length>=2,{completeDeaths:complete.map(record=>record.key),observedDeaths:deathRecords.size});
  check('Two actual player cameras show physical falls followed by verified freeze and natural respawn',locals.length>=2,{localDeaths:locals.map(record=>({key:record.key,cameraScreenshot:record.cameraScreenshot,frozenStableSamples:record.stableSamples,frozenScreenshot:record.frozenScreenshot||null,respawnScreenshot:record.respawnScreenshot}))});
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
