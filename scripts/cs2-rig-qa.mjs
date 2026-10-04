import {chromium} from 'playwright';
import {mkdir,writeFile} from 'node:fs/promises';
import assert from 'node:assert/strict';
import {makeServer} from './serve.mjs';
import {root} from './catalog.mjs';

const fit=process.argv.includes('--fit');
const out=root+'/artifacts/'+(fit?'cs2-rig-fit':'cs2-rig');await mkdir(out,{recursive:true});
const report={date:new Date().toISOString(),frames:[],errors:[],assetErrors:[]};
const fixture=`<!doctype html><style>body{margin:0;background:#98a5a8}canvas{display:block}#label{position:absolute;top:24px;left:28px;color:#e9eeeb;font:17px Arial;text-shadow:0 1px 3px #000}</style><canvas id="canvas"></canvas><div id="label"></div><script type="module">
import * as THREE from '/games/freight-fire/vendor/three.module.js';
import {ViewModelV2,loadViewModels} from '/games/freight-fire/viewmodel.js';
await loadViewModels();
const renderer=new THREE.WebGLRenderer({canvas:document.querySelector('canvas'),antialias:true,preserveDrawingBuffer:true});renderer.setSize(innerWidth,innerHeight);renderer.outputColorSpace=THREE.SRGBColorSpace;renderer.toneMapping=THREE.ACESFilmicToneMapping;renderer.toneMappingExposure=1.12;
const scene=new THREE.Scene();scene.background=new THREE.Color('#8fa3aa');const camera=new THREE.PerspectiveCamera(68,innerWidth/innerHeight,.015,10);scene.add(camera);scene.add(new THREE.HemisphereLight('#dfeaf2','#56564a',2.3));const light=new THREE.DirectionalLight('#fff0df',2.3);light.position.set(-3,5,-2);scene.add(light);
window.resizeRig=()=>{renderer.setSize(innerWidth,innerHeight);camera.aspect=innerWidth/innerHeight;camera.updateProjectionMatrix();};
const studio=new THREE.Scene();studio.background=new THREE.Color('#8499aa');const wall=new THREE.Mesh(new THREE.BoxGeometry(12,12,.2),new THREE.MeshBasicMaterial({color:'#edf2f0'}));wall.position.set(0,3,-5);studio.add(wall);const roof=new THREE.Mesh(new THREE.BoxGeometry(6,.1,6),new THREE.MeshBasicMaterial({color:'#f4e9d6'}));roof.position.set(0,4,0);studio.add(roof);const pmrem=new THREE.PMREMGenerator(renderer);const reflection=pmrem.fromScene(studio,.06,.1,20);scene.environment=reflection.texture;scene.environmentIntensity=.65;
const vm=new ViewModelV2(camera);window.vm=vm;window.THREE=THREE;let clock=10;
window.pose=(slot,kind,progress=0,team=0)=>{
 vm.previous='';vm.previousAgent='';vm.lastReloadUntil=0;vm.phase=0;vm.wall=0;const p={weapon:slot,team,alive:true,vx:0,vz:0,reloadUntil:0,ammo:[30,30,5,12,0]},input={};vm.update(p,input,0,clock);
 const advance=(duration)=>{for(let t=0;t<duration;t+=1/120)vm.update(p,input,Math.min(1/120,duration-t),clock+t);};
 if(kind==='draw')advance(progress);else {advance(2.2);if(kind==='shoot'||kind==='heavy'){vm.fire({heavy:kind==='heavy'});advance(progress);}else if(kind==='reload'){p.reloadUntil=clock+3;vm.update(p,input,0,clock);vm.update(p,input,0,clock+3*progress);}else if(kind==='walk'){p.vx=5.5;advance(.6);}else if(kind==='aim'){input.aim=true;advance(.2);}}
 const r=vm.rigs.get(['m4a1','ak47','awp','usp','knife'][slot]);let trackError=0,checked=0;for(const track of r.action.getClip().tracks){const binding=THREE.PropertyBinding.parseTrackName(track.name),node=r.root.getObjectByName(binding.nodeName);if(!node)continue;const expected=track.createInterpolant().evaluate(r.action.time),actual=node[binding.propertyName]?.toArray?.();if(!actual)continue;let error=Math.max(...expected.map((value,i)=>Math.abs(value-actual[i])));if(binding.propertyName==='quaternion')error=Math.min(error,Math.max(...expected.map((value,i)=>Math.abs(-value-actual[i]))));trackError=Math.max(trackError,error);checked++;}
 let finite=true;r.root.traverse(o=>{for(const v of [...o.position,...o.quaternion,...o.scale])if(!Number.isFinite(v))finite=false;});
 renderer.render(scene,camera);document.querySelector('#label').textContent=r.config.model+' · '+kind+' '+progress+' · '+vm.diagnostics.arms;
 return {...vm.diagnostics,trackError,checked,finite,hands:vm.lastHands,muzzle:vm.muzzle.toArray(),visible:vm.group.visible,position:vm.group.position.toArray(),viewport:[innerWidth,innerHeight]};
};window.ready=true;
</script>`;
const server=makeServer(root);server.prependListener('request',(request,response)=>{if(request.url==='/rig-fixture'){request.url='/';response.writeHead(200,{'Content-Type':'text/html;charset=utf-8'});response.end(fixture);}});
// Avoid invoking the normal static request callback after the fixture reply.
const normal=server.listeners('request')[1];server.removeListener('request',normal);server.on('request',(request,response)=>{if(!response.writableEnded)normal(request,response);});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const browser=await chromium.launch({channel:'chrome',headless:true});
try{const page=await browser.newPage({viewport:{width:1500,height:900}});page.on('pageerror',error=>report.errors.push(error.message));page.on('response',r=>{if(r.status()>=400)report.assetErrors.push(r.url());});await page.goto('http://127.0.0.1:'+server.address().port+'/rig-fixture');await page.waitForFunction(()=>window.ready,{timeout:60000});
 for(const viewport of fit?[{width:1500,height:900},{width:829,height:958}]:[{width:1500,height:900}]){
  await page.setViewportSize(viewport);await page.evaluate(()=>resizeRig());
  for(let team=0;team<(fit?1:2);team++)for(let slot=0;slot<5;slot++){
   const states=fit?[['idle',0],['shoot',.08],['shoot',.25],...(slot===4?[['heavy',.18],['heavy',.4]]:[['reload',.15],['reload',.45],['reload',.8],['reload',.96]])]:[['draw',.1],['draw',.35],['idle',0],['walk',0],['shoot',.08],['shoot',.25],...(slot===4?[['heavy',.18],['heavy',.4]]:[['reload',.15],['reload',.45],['reload',.8],['reload',.96]]),...(slot===2?[['aim',0]]:[])];
   for(const [kind,progress]of states){const pose=await page.evaluate(args=>window.pose(...args),[slot,kind,progress,team]);assert.ok(pose.finite);assert.ok(pose.attachmentError<1e-6);assert.ok(pose.trackError<2e-5,'Authored track altered: '+JSON.stringify(pose));assert.ok(pose.checked>30);if(kind==='aim')assert.equal(pose.visible,false);report.frames.push({team,slot,kind,progress,...pose});await page.screenshot({path:out+'/'+(fit?viewport.width+'x'+viewport.height+'-':'')+team+'-'+slot+'-'+kind+'-'+progress+'.png'});}
  }
 }
 assert.deepEqual(report.errors,[]);assert.deepEqual(report.assetErrors,[]);console.log('PASS '+report.frames.length+' matching first-person poses; original local tracks and native attachment intact.');
}finally{await browser.close();server.close();await writeFile(out+'/report.json',JSON.stringify(report,null,2));}
