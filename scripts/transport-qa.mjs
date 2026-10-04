import {chromium} from 'playwright';
import {mkdir,writeFile} from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import {makeServer} from './serve.mjs';
import {root} from './catalog.mjs';

const out=path.join(root,'artifacts','transport-v3');await mkdir(out,{recursive:true});
const report={date:new Date().toISOString(),checks:[],errors:[],badRequests:[],poses:[],screenshots:[],limitations:['Exact source-game engine units are unavailable. Reference reconstruction, not certified 1:1.','Spawn/tunnel positioning, animation pose sweeps and top-down captures use the explicit ?qa=1 interface; equipment/fire/reload and passage movement use actual controls.']};
const server=makeServer(root);await new Promise(r=>server.listen(0,'127.0.0.1',r));let browser;
const check=(name,detail)=>{report.checks.push({name,detail});console.log('PASS '+name);};
try{
 browser=await chromium.launch({headless:true,channel:'chrome',args:['--no-first-run']});
 const page=await browser.newPage({viewport:{width:1365,height:900}});page.on('pageerror',e=>report.errors.push(e.message));page.on('response',r=>{if(r.status()>=400)report.badRequests.push({url:r.url(),status:r.status()});});
 await page.goto(`http://127.0.0.1:${server.address().port}/games/freight-fire/?qa=1`);await page.waitForFunction(()=>window.__freight?.view?.stats?.fps>0);
 await page.bringToFront();await page.click('#start');await page.waitForTimeout(250);
 if(await page.evaluate(()=>__freight.paused)){await page.bringToFront();await page.click('#resume');}
 await page.evaluate(()=>{const m=__freight.match;for(const p of m.players)if(p.id!==__freight.localId){p.bot=false;p.alive=false;p.respawnAt=10000;}window.addEventListener('mousemove',e=>e.stopImmediatePropagation(),true);});
 const shot=async name=>{await page.screenshot({path:path.join(out,name+'.png')});report.screenshots.push(name+'.png');};
 const from=await page.evaluate(()=>__freight.snapshot.players.find(p=>p.id===__freight.localId).z);
 await page.keyboard.down('KeyW');await page.waitForTimeout(950);await page.keyboard.up('KeyW');
 const to=await page.evaluate(()=>__freight.snapshot.players.find(p=>p.id===__freight.localId).z);assert.ok(to<from-2,JSON.stringify({from,to,state:await page.evaluate(()=>({paused:__freight.paused,input:__freight.input,time:__freight.snapshot.time}))}));check('Real keyboard exits spawn cabin',{from,to});
 for(let slot=0;slot<4;slot++){
  await page.evaluate(()=>{const p=__freight.match.players.find(p=>p.id===__freight.localId);Object.assign(p,{x:-6.6,y:0,z:40,vx:0,vy:0,vz:0,grounded:true});});await page.waitForTimeout(80);
  if(slot<3){await page.keyboard.press('KeyB');await page.locator('#loadout').waitFor({state:'visible'});await page.locator(`button[data-primary="${slot}"]`).click();await page.locator('#loadout').waitFor({state:'hidden'});await page.waitForFunction(()=>document.pointerLockElement?.id==='arena');}else await page.keyboard.press('Digit2');
  await page.waitForFunction(slot=>__freight.snapshot.players.find(p=>p.id===__freight.localId).weapon===slot,slot);await page.waitForTimeout(500);
  await shot(['m4-ready','akm-ready','awp-ready','usp-ready'][slot]);
  if(process.argv.includes('--inspect'))console.log('RIG '+slot+' '+JSON.stringify(await page.evaluate(()=>({diagnostics:__freight.view.viewModel.diagnostics,hands:__freight.view.viewModel.lastHands}))));
  await page.keyboard.down('KeyF');await page.waitForTimeout(180);await page.keyboard.up('KeyF');
  const ammo=await page.evaluate(()=>{const p=__freight.snapshot.players.find(p=>p.id===__freight.localId);return p.ammo[p.weapon];});assert.ok(ammo<[30,30,5,12][slot]);
  await page.keyboard.press('KeyR');await page.waitForTimeout(600);await shot(['m4-reload','akm-reload','awp-reload','usp-reload'][slot]);
  await page.waitForFunction(()=>{const p=__freight.snapshot.players.find(p=>p.id===__freight.localId);return p.reloadUntil===0;});
  assert.equal(await page.evaluate(()=>{const p=__freight.snapshot.players.find(p=>p.id===__freight.localId);return p.ammo[p.weapon];}),[30,30,5,12][slot]);
 check('Actual equip/fire/reload '+slot,ammo);
 }
 // Explicit QA positioning selects the original right-hand passage; descent,
 // travel and both exit jumps are driven by real keyboard input afterwards.
 const tunnel=await page.evaluate(async()=>{const {MAP}=await import('/games/freight-fire/sim.js');return MAP.tunnels.find(t=>t.side===1);});
 await page.evaluate(t=>{const p=__freight.match.players.find(p=>p.id===__freight.localId);Object.assign(p,{x:t.x,z:t.baseZ,y:0,yaw:0,pitch:0,weapon:0,primaryWeapon:0,vy:0,grounded:true});Object.assign(__freight.input,{yaw:0,pitch:0,weapon:0});},tunnel);
 await page.waitForTimeout(150);await shot('tunnel-entry');
 await page.keyboard.down('KeyW');await page.waitForFunction(()=>__freight.snapshot.players.find(p=>p.id===__freight.localId).y<-2);await page.waitForTimeout(1800);await shot('tunnel-interior');
 await page.waitForTimeout(7200);await page.keyboard.up('KeyW');
 await page.keyboard.down('Space');await page.keyboard.down('KeyW');await page.waitForTimeout(920);await page.keyboard.up('Space');await page.keyboard.up('KeyW');await page.waitForTimeout(150);
 await page.keyboard.down('Space');await page.keyboard.down('KeyA');await page.waitForTimeout(1500);await page.keyboard.up('Space');await page.keyboard.up('KeyA');await page.waitForTimeout(200);await shot('tunnel-exit');
 const passage=await page.evaluate(()=>{const p=__freight.snapshot.players.find(p=>p.id===__freight.localId);return {x:p.x,y:p.y,z:p.z};});assert.ok(passage.y>-.05&&passage.z<-13);check('Actual keyboard passage descent, travel and cargo-step exit (QA start fixture)',passage);
 const poses=await page.evaluate(async()=>{
  const T=await import('/games/freight-fire/vendor/three.module.js');
  const vm=__freight.view.viewModel,p=__freight.snapshot.players.find(p=>p.id===__freight.localId),results=[];
  const caches=new WeakMap();
  for(let slot=0;slot<5;slot++)for(const aim of [false,true])for(const wallDistance of [Infinity,.25]){
   vm.lastReloadUntil=0;vm.previous='';const state={...p,weapon:slot,reloadUntil:slot===4?0:12,vx:0,vz:0,walking:false};
   for(let i=0;i<=120;i++){
    const time=10+i/60;vm.update(state,{aim,wallDistance},1/60,time,{recoil:.3,kick:.2});if(slot===4&&i%40===0){vm.fire({heavy:i===40});vm.update(state,{aim,wallDistance},0,time);}
    const rig=vm.rigs.get(vm.previous),action=rig.action,clip=action.getClip();
    if(!caches.has(clip))caches.set(clip,clip.tracks.map(track=>{const parsed=T.PropertyBinding.parseTrackName(track.name),node=rig.root.getObjectByName(parsed.nodeName);return {node,property:parsed.propertyName,interpolant:track.createInterpolant()};}));
    let maxError=0,matched=0;
    for(const {node,property,interpolant}of caches.get(clip)){if(!node?.[property]?.toArray)continue;const actual=node[property].toArray(),expected=interpolant.evaluate(action.time);let error=Math.max(...actual.map((v,i)=>Math.abs(v-expected[i])));if(property==='quaternion')error=Math.min(error,Math.max(...actual.map((v,i)=>Math.abs(v+expected[i]))));maxError=Math.max(maxError,error);matched++;}
    results.push({slot,aim,wall:wallDistance<1,t:i/120,authorPoseError:maxError,matchedTracks:matched,totalTracks:clip.tracks.length,attachmentError:vm.diagnostics.attachmentError,boneIK:vm.diagnostics.boneIK,muzzle:vm.muzzle.toArray(),hands:structuredClone(vm.lastHands)});
   }
  }
  vm.update(p,__freight.input,1/60,__freight.snapshot.time);return results;
 });
 report.poses=poses;assert.ok(poses.every(p=>p.muzzle.every(Number.isFinite)&&Object.values(p.hands).flat().every(Number.isFinite)));
 const maxError=Math.max(...poses.map(p=>p.authorPoseError));assert.ok(poses.every(p=>p.matchedTracks>0&&p.matchedTracks===p.totalTracks),'every original bone and weapon-part track is checked');assert.ok(maxError<.00001,'original source tracks remain faithful: '+maxError);assert.ok(poses.every(p=>p.attachmentError<1e-6&&!p.boneIK));check('2,420 native animation / aim / wall samples',{maxOriginalTransformError:maxError,maxAttachmentError:Math.max(...poses.map(p=>p.attachmentError)),meshIntersectionCertified:false});
 await page.keyboard.press('Digit1');await page.mouse.down({button:'right'});await page.waitForTimeout(300);await shot('m4-ads');
 assert.equal(await page.evaluate(()=>__freight.view.viewCamera.fov),68);await page.mouse.up({button:'right'});check('Native viewmodel FOV stays stable while aiming',68);
 // Capture the actual scene with an orthographic inspection camera.
 await page.evaluate(async()=>{
  const T=await import('/games/freight-fire/vendor/three.module.js'),view=__freight.view;
  view.render=()=>{};view.view.visible=false;for(const p of view.players.values())p.group.visible=false;
  const camera=new T.OrthographicCamera(-45,45,29.67,-29.67,.1,250);camera.position.set(0,100,0);camera.up.set(-1,0,0);camera.lookAt(0,0,0);view.renderer.render(view.scene,camera);
  document.querySelectorAll('#hud,#menu,#scoreboard,#touch-controls,.vignette').forEach(n=>n.hidden=true);
 });await shot('map-overhead');
 assert.deepEqual(report.errors,[]);assert.deepEqual(report.badRequests,[]);check('No JavaScript or asset HTTP errors',true);
}catch(e){report.failure=e.stack;throw e;}finally{await writeFile(path.join(out,'report.json'),JSON.stringify(report,null,2));await browser?.close();await new Promise(r=>server.close(r));}
