import {chromium} from 'playwright';
import {mkdir,writeFile} from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import {makeServer} from './serve.mjs';
import {root} from './catalog.mjs';
const out=path.join(root,'artifacts','characters-upgrade');await mkdir(out,{recursive:true});
const server=makeServer(root);await new Promise(r=>server.listen(0,'127.0.0.1',r));
const report={date:new Date().toISOString(),errors:[],requests:[],poses:[],deaths:[],camera:[]};let browser;
try {
 browser=await chromium.launch({headless:true,channel:'chrome',args:['--no-first-run']});const page=await browser.newPage({viewport:{width:1365,height:900}});
 page.on('pageerror',e=>report.errors.push(e.message));page.on('response',r=>{if(r.status()>=400)report.requests.push({url:r.url(),status:r.status()});});
 await page.route('**/character-qa',route=>route.fulfill({status:200,contentType:'text/html',body:'<!doctype html><title>Character acceptance</title><style>html,body{margin:0;background:#243642}canvas{display:block}</style><canvas></canvas>'}));
 await page.goto(`http://127.0.0.1:${server.address().port}/character-qa`);
 await page.evaluate(async()=>{
  const T=await import('/games/freight-fire/vendor/three.module.js'),chars=await import('/games/freight-fire/character-v2.js'),{makeEnvironmentV2}=await import('/games/freight-fire/environment-v2.js'),{MAP}=await import('/games/freight-fire/sim.js'),{DeathCamera}=await import('/games/freight-fire/death-camera.js');
  const weapons=await import('/games/freight-fire/viewmodel.js');await Promise.all([chars.loadCharacters(),weapons.loadViewModels()]);const renderer=new T.WebGLRenderer({canvas:document.querySelector('canvas'),antialias:true});renderer.setSize(1365,900);renderer.outputColorSpace=T.SRGBColorSpace;renderer.toneMapping=T.ACESFilmicToneMapping;renderer.toneMappingExposure=1.1;
  const scene=new T.Scene();scene.background=new T.Color('#8babbb');scene.add(new T.HemisphereLight('#f0f2f6','#676750',2.4));const sun=new T.DirectionalLight('#fff4df',3);sun.position.set(-10,15,15);scene.add(sun);
  const environment=makeEnvironmentV2(MAP);scene.add(environment);await environment.userData.ready;const camera=new T.PerspectiveCamera(48,1365/900,.05,250);
  window.__cq={T,...chars,...weapons,DeathCamera,renderer,scene,camera};
 });
 const shot=async name=>page.screenshot({path:path.join(out,name+'.png')});
 for(const team of [0,1]) {
  for(const pose of [{name:'m4a1',weapon:0},{name:'ak47',weapon:1},{name:'awp',weapon:2},{name:'pistol',weapon:3},{name:'knife',weapon:4},{name:'crouch',weapon:0,crouching:true},{name:'walk-forward',weapon:0,vz:-3,walking:true},{name:'strafe-right',weapon:0,vx:5.5}]) {
   const data=await page.evaluate(({team,pose})=>{const q=__cq;if(q.actor)q.scene.remove(q.actor);q.actor=q.makeCharacterV2(team,q.makeWeaponV2);q.scene.add(q.actor);q.actor.position.set(0,0,12);const p={alive:true,grounded:true,yaw:0,pitch:0,...pose};for(let i=0;i<50;i++)q.updateCharacterV2(q.actor,p,1/60,i/60);q.actor.updateMatrixWorld(true);q.actor.userData.skin.traverse(o=>{if(o.isSkinnedMesh)o.skeleton.update();});const b=new q.T.Box3().setFromObject(q.actor.userData.skin,true);q.camera.position.set(2.2,1.8,15.7);q.camera.lookAt(0,.95,12);q.renderer.render(q.scene,q.camera);return {team,pose:pose.name,height:b.max.y-b.min.y,min:b.min.toArray(),max:b.max.toArray(),stats:q.actor.userData.poseStats};},{team,pose});
   assert.ok(data.height>.6&&data.height<2.2,JSON.stringify(data));assert.ok(data.min[1]>-.12,JSON.stringify(data));report.poses.push(data);await shot('team-'+team+'-'+pose.name);
  }
  for(const yaw of [0,Math.PI/2,Math.PI]) {
   await page.evaluate(({team,yaw})=>{const q=__cq;q.scene.remove(q.actor);q.actor=q.makeCharacterV2(team,q.makeWeaponV2);q.scene.add(q.actor);q.actor.position.set(0,0,12);q.actor.rotation.y=yaw;for(let i=0;i<20;i++)q.updateCharacterV2(q.actor,{alive:true,grounded:true,weapon:0,yaw,pitch:0},1/60,i/60);q.age=0;},{team,yaw});
   for(const age of [.15,.5,1,1.6,2.5,3.5]) {
    const data=await page.evaluate(age=>{const q=__cq;while(q.age<age-1e-6){q.updateCharacterV2(q.actor,{id:'me',x:0,y:0,z:12,alive:false,weapon:0},1/120,q.age);q.age+=1/120;}q.actor.updateMatrixWorld(true);q.actor.userData.skin.traverse(o=>{if(o.isSkinnedMesh)o.skeleton.update();});const b=new q.T.Box3().setFromObject(q.actor.userData.skin,true);q.camera.position.set(3,2.3,15.6);q.camera.lookAt(0,.6,12);q.renderer.render(q.scene,q.camera);return {age,min:b.min.toArray(),max:b.max.toArray(),offset:q.actor.userData.visual.position.toArray(),stats:q.actor.userData.deathStats};},age);
    assert.ok(data.min[1]>=-.01,JSON.stringify(data));if(age>=1.6)assert.ok(data.max[1]-data.min[1]<1.0,JSON.stringify(data));report.deaths.push({team,yaw,...data});await shot('death-'+team+'-'+yaw.toFixed(2)+'-'+age);
   }
   const reset=await page.evaluate(()=>{const q=__cq;for(let i=0;i<40;i++)q.updateCharacterV2(q.actor,{alive:true,weapon:0},1/60,4+i/60);const b=new q.T.Box3().setFromObject(q.actor.userData.skin,true);return {height:b.max.y-b.min.y,offset:q.actor.userData.visual.position.toArray(),dead:q.actor.userData.dead};});assert.equal(reset.dead,false);assert.deepEqual(reset.offset,[0,0,0]);assert.ok(reset.height>1.6);
  }
 }
 for(const location of [{name:'deck',x:0,y:0,z:-3},{name:'base',x:0,y:0,z:37},{name:'tunnel',x:12.8,y:-2.27,z:-10}]) {
  const samples=await page.evaluate(location=>{const q=__cq,camera=new q.T.PerspectiveCamera(78,1365/900,.035,250);camera.position.set(location.x,location.y+1.58,location.z);camera.rotation.set(0,0,0);const death=new q.DeathCamera({id:'me',...location,yaw:0,pitch:0},camera,{x:location.x+4,y:location.y,z:location.z-4});const result=[];for(let i=0;i<240;i++){const stats=death.update(camera,1/120);if(i%12===0)result.push({...stats,fov:camera.fov,quaternion:camera.quaternion.toArray()});}return result;},location);
  for(const s of samples)assert.ok([...s.position,...s.quaternion,s.fov].every(Number.isFinite));assert.ok(samples[0].position[1]>samples[6].position[1]);assert.ok(samples.every(s=>s.position[1]>=s.ground+.23));report.camera.push({location,samples});
 }
 await page.evaluate(async()=>{
  const {ArenaRenderer}=await import('/games/freight-fire/render.js');__cq.renderer.dispose();const view=new ArenaRenderer(document.querySelector('canvas'),{quality:'medium'});await view.ready;window.__cv=view;
  window.__cp={id:'me',name:'角色验收',team:0,x:0,y:0,z:12,yaw:0,pitch:0,vx:0,vz:0,grounded:true,alive:true,weapon:0,primaryWeapon:0,ammo:[30,30,5,12,0],reserve:[120,120,25,60,0],reloadUntil:0,hp:100};
  window.__ck={...__cp,id:'killer',name:'对手',team:1,x:3,z:7,yaw:Math.PI,weapon:1};window.__cs={time:0,players:[__cp,__ck],events:[]};for(let i=0;i<90;i++){__cs.time=i/60;view.render(__cs,'me',{yaw:0,pitch:0},1/60);}window.__cp.crouching=true;for(let i=0;i<60;i++)view.render(__cs,'me',{yaw:0,pitch:0},1/60);window.__crouchEye=view.camera.position.y;window.__cp.crouching=false;for(let i=0;i<60;i++)view.render(__cs,'me',{yaw:0,pitch:0},1/60);window.__ca=0;
 });
 assert.ok(Math.abs(await page.evaluate(()=>__crouchEye)-1.20)<.001);await shot('game-view-alive');
 await page.evaluate(()=>{__cp.alive=false;__cp.hp=0;__cp.killerId='killer';__cp.deathWeapon=1;__cp.deathHeadshot=true;__cp.respawnAt=__cs.time+3;__cs.events=[{type:'kill',seq:100,time:__cs.time,playerId:'killer',targetId:'me',weapon:1,headshot:true,direction:[-1,0,1]}];});
 for(const age of [.12,.45,.8,1.2,1.8,2.75]){
  const stats=await page.evaluate(age=>{while(__ca<age-1e-6){__cs.time+=1/120;__cv.render(__cs,'me',{yaw:2,pitch:1},1/120);__ca+=1/120;}return {camera:__cv.deathCameraStats,bodyVisible:__cv.players.get('me').group.visible,viewVisible:__cv.view.visible,body:__cv.players.get('me').group.userData.deathStats};},age);
  assert.equal(stats.viewVisible,false);if(age>1.1)assert.equal(stats.bodyVisible,true);assert.ok(stats.camera.position.every(Number.isFinite));report.camera.push({scenario:'ArenaRenderer integration',age,...stats});await shot('game-view-death-'+age);
 }
 const respawn=await page.evaluate(()=>{__cp.alive=true;__cp.hp=100;__cp.x=-.7;__cp.z=33;__cp.weapon=4;__cs.time+=1/60;__cv.render(__cs,'me',{yaw:0,pitch:0},1/60);return {death:__cv.deathCameraStats,bodyVisible:__cv.players.get('me').group.visible,viewVisible:__cv.view.visible,eye:__cv.camera.position.toArray(),dead:__cv.players.get('me').group.userData.dead};});
 assert.equal(respawn.death,null);assert.equal(respawn.bodyVisible,false);assert.equal(respawn.viewVisible,true);assert.equal(respawn.dead,false);await shot('game-view-respawn-knife');
 assert.deepEqual(report.errors,[]);assert.deepEqual(report.requests,[]);console.log(JSON.stringify({poses:report.poses.length,deaths:report.deaths.length,camera:report.camera.map(c=>c.samples?({location:c.location,final:c.samples.at(-1)}):c),errors:report.errors,requests:report.requests}));
}catch(e){report.failure=e.stack;throw e;}finally{await writeFile(path.join(out,'report.json'),JSON.stringify(report,null,2));await browser?.close();await new Promise(r=>server.close(r));}
