import {chromium} from 'playwright';
import {mkdir,readFile,writeFile,stat} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import assert from 'node:assert/strict';
import path from 'node:path';
import {makeServer} from './serve.mjs';
import {root} from './catalog.mjs';
import {fileURLToPath} from 'node:url';
import {AUTHORED_RIGS} from '../games/freight-fire/viewmodel-cs2.js';
import {assetLoading} from '../games/freight-fire/asset-loading.js';
import {COMMUNITY_SKIN_SOURCE_PINS,verifyCommunitySkins} from './community-skins-verification.mjs';

// The studio advances real packaged GLBs and native clips. It is explicitly
// labelled as an animation diagnostic. The match section only reads __freight;
// every Start, movement, shot, reload and purchase uses ordinary UI/key events.
const option=name=>process.argv.find(value=>value.startsWith(name+'='))?.slice(name.length+1);
const out=path.join(root,'artifacts','original-skins');
const manifestPath=path.resolve(root,option('--manifest')||'games/freight-fire/assets/viewmodel-cs2/original-skins.json');
const communityManifestPath=path.resolve(root,option('--community-manifest')||'games/freight-fire/assets/viewmodel-cs2/skin-selection-community.json');
await mkdir(out,{recursive:true});
const report={date:new Date().toISOString(),manifest:path.relative(root,manifestPath).replaceAll('\\','/'),communityManifest:path.relative(root,communityManifestPath).replaceAll('\\','/'),checks:[],assets:[],textures:[],poses:[],gameplay:[],screenshots:[],errors:[],failedRequests:[],limitations:[
 'Studio screenshots are clearly labelled deterministic animation diagnostics using real packaged models and native actions; they are not combat footage.',
 'The actual match uses normal UI and keyboard inputs. Game QA globals are read only.',
 'Death staging and three-angle corpse diagnostics are covered separately by character-animation-qa.mjs.'
]};
const hash=data=>createHash('sha256').update(data).digest('hex');
const check=(name,passed,details)=>{report.checks.push({name,passed,details});console.log((passed?'PASS ':'FAIL ')+name);assert.ok(passed,name+': '+JSON.stringify(details));};

function hashedEntries(value,trail=[]) {
 const found=[];if(!value||typeof value!=='object')return found;
 if(!Array.isArray(value)&&typeof value.sha256==='string'&&/^[0-9a-f]{64}$/i.test(value.sha256))found.push({entry:value,trail:trail.join('.')});
 for(const [key,child]of Object.entries(value))if(child&&typeof child==='object')found.push(...hashedEntries(child,[...trail,key]));return found;
}
async function localFile(entry) {
 const names=['path','file','filename','localFile','localArchive','sourceFile','outputFile'].map(key=>entry[key]).filter(value=>typeof value==='string'&&!/^https?:/i.test(value));
 for(const filename of names)for(const candidate of [path.resolve(root,filename),path.resolve(path.dirname(manifestPath),filename)]){
  const relative=path.relative(root,candidate);if(relative.startsWith('..')||path.isAbsolute(relative))continue;
  if(await stat(candidate).then(value=>value.isFile(),()=>false))return candidate;
 }return null;
}
function imageSize(data,mimeType) {
 if(mimeType==='image/png'&&data.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10])))return {width:data.readUInt32BE(16),height:data.readUInt32BE(20)};
 if(mimeType==='image/jpeg'&&data[0]===255&&data[1]===216){
  for(let offset=2;offset+4<data.length;){assert.equal(data[offset++],255,'Invalid JPEG marker');while(data[offset]===255)offset++;const marker=data[offset++];if(marker===217||marker===218)break;if(marker===216||marker===1||marker>=208&&marker<=215)continue;const length=data.readUInt16BE(offset);assert(length>=2&&offset+length<=data.length,'Invalid JPEG segment');if([192,193,194,195,197,198,199,201,202,203,205,206,207].includes(marker))return {width:data.readUInt16BE(offset+5),height:data.readUInt16BE(offset+3)};offset+=length;}
 }
 if(mimeType==='image/webp'&&data.toString('ascii',0,4)==='RIFF'&&data.toString('ascii',8,12)==='WEBP'){
  for(let offset=12;offset+8<=data.length;){const type=data.toString('ascii',offset,offset+4),length=data.readUInt32LE(offset+4),start=offset+8;if(type==='VP8X')return {width:1+data.readUIntLE(start+4,3),height:1+data.readUIntLE(start+7,3)};if(type==='VP8L'){const bits=data.readUInt32LE(start+1);return {width:(bits&16383)+1,height:((bits>>>14)&16383)+1};}if(type==='VP8 ')return {width:data.readUInt16LE(start+6)&16383,height:data.readUInt16LE(start+8)&16383};offset=start+length+(length%2);}
 }
 throw Error('Cannot independently read embedded image dimensions: '+mimeType);
}
function glbStructure(data) {
 assert.equal(data.readUInt32LE(0),0x46546c67,'Invalid GLB magic');assert.equal(data.readUInt32LE(4),2,'Unsupported GLB version');
 assert.equal(data.readUInt32LE(8),data.length,'GLB length mismatch');let json,binary;
 for(let offset=12;offset<data.length;){const length=data.readUInt32LE(offset),type=data.readUInt32LE(offset+4),chunk=data.subarray(offset+8,offset+8+length);if(type===0x4e4f534a)json=JSON.parse(chunk.toString('utf8').replace(/\0+$/,''));if(type===0x004e4942)binary=chunk;offset+=8+length;}
 assert(json&&binary,'GLB JSON/BIN chunks are required');
 const imageViews=new Set((json.images||[]).map(image=>image.bufferView)),nonImageViews=(json.bufferViews||[]).flatMap((view,index)=>imageViews.has(index)?[]:[{index,bytes:view.byteLength,sha256:hash(binary.subarray(view.byteOffset||0,(view.byteOffset||0)+view.byteLength))}]);
 const images=(json.images||[]).map((image,index)=>{const view=json.bufferViews[image.bufferView];assert(view,'Image needs an embedded bufferView');const payload=binary.subarray(view.byteOffset||0,(view.byteOffset||0)+view.byteLength);return {index,mimeType:image.mimeType,bytes:payload.length,sha256:hash(payload),...imageSize(payload,image.mimeType)};});
 const roles=(json.materials||[]).flatMap((material,materialIndex)=>[['baseColor',material.pbrMetallicRoughness?.baseColorTexture],['normal',material.normalTexture],['ORM',material.pbrMetallicRoughness?.metallicRoughnessTexture],['occlusion',material.occlusionTexture]].flatMap(([role,texture])=>texture?[{materialIndex,role,imageIndex:json.textures[texture.index].source}]:[]));
 const geometry=Object.fromEntries(['nodes','scenes','scene','meshes','skins','accessors','animations','textures','samplers'].map(key=>[key,json[key]??[]]));return {geometry,nonImageViews,images,roles};
}
async function verifyManifest() {
 const manifest=JSON.parse(await readFile(manifestPath,'utf8')),entries=hashedEntries(manifest);check('Manifest records source/output SHA-256 evidence',entries.length>=3,{entries:entries.length});
 for(const {entry,trail}of entries){
  const filename=await localFile(entry);if(!filename){report.assets.push({trail,sha256:entry.sha256,reference:entry.url||entry.path||entry.file,verified:false,reason:'Provenance metadata only; this referenced file is not bundled locally.'});continue;}
  const data=await readFile(filename),actual=hash(data),bytes=Number(entry.bytes??entry.size??entry.byteLength);
  check('Manifest checksum '+path.relative(root,filename),actual===entry.sha256&&(!Number.isFinite(bytes)||bytes===data.length),{trail,actual,expected:entry.sha256,bytes:data.length,expectedBytes:bytes});
  report.assets.push({trail,path:path.relative(root,filename).replaceAll('\\','/'),sha256:actual,bytes:data.length,verified:true});
 }
 const outputs=report.assets.filter(asset=>asset.verified&&/\.glb$/i.test(asset.path)&&/(^|\.)output(?:\.|$)/.test(asset.trail));check('Both Harbor hands and historical Dock Steel derivative outputs are verified',outputs.length===3,outputs);
 for(const asset of manifest.assets||[]){
  if(!asset.source||!asset.output)continue;const sourcePath=await localFile(asset.source),outputPath=await localFile(asset.output);if(!sourcePath||!outputPath||!outputPath.endsWith('.glb'))continue;
  const source=await readFile(sourcePath),output=await readFile(outputPath),ratio=output.length/source.length,sourceStructure=glbStructure(source),outputStructure=glbStructure(output);
  check('Original skin stays within a normal asset size '+path.basename(outputPath),ratio>.05&&ratio<3,{sourceBytes:source.length,outputBytes:output.length,ratio});
  const protectedData=value=>JSON.stringify({geometry:value.geometry,nonImageViews:value.nonImageViews,roles:value.roles});
  check('Independent geometry / UV / skin / motion preservation '+path.basename(outputPath),protectedData(sourceStructure)===protectedData(outputStructure),{sourceStructuralSha256:hash(protectedData(sourceStructure)),outputStructuralSha256:hash(protectedData(outputStructure)),nonImageViews:sourceStructure.nonImageViews.length});
  const changed=new Set((asset.replacements||[]).map(replacement=>replacement.imageIndex));
  check('Only declared albedo textures change '+path.basename(outputPath),sourceStructure.images.length===outputStructure.images.length&&sourceStructure.images.every(image=>changed.has(image.index)||JSON.stringify(image)===JSON.stringify(outputStructure.images[image.index])),{imageCount:outputStructure.images.length,changed:[...changed]});
  for(const replacement of asset.replacements||[]){
   const previous=sourceStructure.images[replacement.imageIndex],next=outputStructure.images[replacement.imageIndex],roles=sourceStructure.roles.filter(role=>role.imageIndex===replacement.imageIndex),pixelRatio=next.width*next.height/(previous.width*previous.height);
   check('Embedded original atlas provenance '+path.basename(outputPath)+'/'+replacement.imageIndex,['sha256','bytes','mimeType','width','height'].every(field=>replacement.previous[field]===previous[field]&&replacement.next[field]===next[field])&&previous.sha256!==next.sha256&&!!replacement.source?.provider,{previous,next,provider:replacement.source?.provider});
   check('Original atlas keeps its UV aspect and bounded GPU resolution '+path.basename(outputPath)+'/'+replacement.imageIndex,next.width*previous.height===previous.width*next.height&&next.width<=4096&&next.height<=4096&&pixelRatio>=.25&&pixelRatio<=4&&roles.length>0&&roles.every(role=>role.role==='baseColor'),{pixelRatio,roles,width:next.width,height:next.height});
  }
  const preservedPBR=sourceStructure.roles.filter(role=>role.role!=='baseColor');check('Normal / ORM / occlusion payloads are byte identical '+path.basename(outputPath),preservedPBR.every(role=>sourceStructure.images[role.imageIndex].sha256===outputStructure.images[role.imageIndex].sha256),preservedPBR);
  const rgbaMipBytes=outputStructure.images.reduce((sum,image)=>sum+image.width*image.height*4*4/3,0);check('Per-model estimated texture memory remains bounded '+path.basename(outputPath),rgbaMipBytes<256*1048576,{rgbaMipMB:rgbaMipBytes/1048576,images:outputStructure.images});
  report.textures.push({asset:path.relative(root,outputPath).replaceAll('\\','/'),ratio,rgbaMipBytes,images:outputStructure.images,changed:[...changed],preservedPBR});
 }
 const community=await verifyCommunitySkins({projectRoot:root,manifestPath:communityManifestPath});report.communitySkins=community.results;
 for(const skin of community.results){
  check('Current complete community PBR model and preview '+skin.model.materials[0].name,true,{output:skin.output,preview:skin.preview,images:skin.model.images,extensionsUsed:skin.model.extensionsUsed});
  for(const comparison of skin.comparisons)check('Independent semantic geometry / original bones / UV / skin preservation '+skin.model.materials[0].name+' vs '+path.basename(comparison.path),comparison.identical,comparison);
  for(const entry of [skin.output,skin.preview])report.assets.push({trail:'community.'+skin.weaponId,path:entry.path,sha256:entry.sha256,bytes:entry.bytes,verified:true});
  const rgbaMipBytes=skin.model.images.reduce((sum,image)=>sum+image.width*image.height*4*4/3,0);check('Community texture memory remains bounded '+skin.model.materials[0].name,rgbaMipBytes<256*1048576,{rgbaMipMB:rgbaMipBytes/1048576,images:skin.model.images});
 }
 const records=assetLoading.snapshot.assets.filter(record=>record.group==='viewmodels'&&record.url.endsWith('.glb'));report.runtimeAssetDeclarations=[];
 check('Runtime declares five weapons, two Harbor arms and original actions',records.length===8,{count:records.length});
 for(const record of records){const filename=fileURLToPath(record.url),bytes=await readFile(filename);check('Runtime decoded download byte count '+path.basename(filename),record.totalBytes===bytes.length,{declared:record.totalBytes,actual:bytes.length,label:record.label});report.runtimeAssetDeclarations.push({path:path.relative(root,filename).replaceAll('\\','/'),bytes:bytes.length,label:record.label});}
 for(const pin of COMMUNITY_SKIN_SOURCE_PINS)check('Current authored rig selects '+pin.model,AUTHORED_RIGS[pin.weaponId].file===pin.file&&AUTHORED_RIGS[pin.weaponId].model===pin.model,{actual:AUTHORED_RIGS[pin.weaponId],expected:pin.file});
 for(const historical of ['ak47-docksteel','ak47-fire-serpent','m4a1-golden-coil','ct-sas','t-phoenix'])check('Historical model excluded from runtime requests '+historical,!records.some(record=>path.basename(fileURLToPath(record.url),'.glb')===historical));
 return manifest;
}

const fixture=`<!doctype html><title>Community Vulcan / Printstream and Harbor hands / animation diagnostics</title>
<style>html,body{margin:0;background:#889ca5}canvas{display:block}aside{position:fixed;left:24px;top:24px;padding:13px 19px;background:#102b3ae8;color:#e9f3f7;font:16px system-ui;white-space:pre;z-index:2}</style><aside id="caption">动画诊断 · 原生 GLB / 非实战录像</aside><canvas></canvas>`;
const server=makeServer(root);await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
const base=`http://127.0.0.1:${server.address().port}`;let browser,page;
const shot=async(name,options={})=>{await page.screenshot({path:path.join(out,name+'.png'),...options});report.screenshots.push(name+'.png');};
try {
 await verifyManifest();
 report.validationOnly=process.argv.includes('--assets-only');
 if(!report.validationOnly){
 browser=await chromium.launch({channel:'chrome',headless:true,args:['--no-first-run']});report.browser=browser.version();
 page=await browser.newPage({viewport:{width:1440,height:900}});page.setDefaultTimeout(30000);
 page.on('pageerror',error=>report.errors.push(error.message));page.on('response',response=>{if(response.status()>=400)report.failedRequests.push({url:response.url(),status:response.status()});});
 await page.route('**/original-skins-fixture',route=>route.fulfill({status:200,contentType:'text/html',body:fixture}));
 await page.goto(base+'/original-skins-fixture');
 const assets=await page.evaluate(async()=>{
  const T=await import('/games/freight-fire/vendor/three.module.js'),module=await import('/games/freight-fire/viewmodel.js');await module.loadViewModels();
  const renderer=new T.WebGLRenderer({canvas:document.querySelector('canvas'),antialias:true,preserveDrawingBuffer:true});renderer.setSize(innerWidth,innerHeight);renderer.outputColorSpace=T.SRGBColorSpace;renderer.toneMapping=T.ACESFilmicToneMapping;renderer.toneMappingExposure=1.12;
  const scene=new T.Scene();scene.background=new T.Color('#849ba7');const camera=new T.PerspectiveCamera(68,innerWidth/innerHeight,.015,10);scene.add(camera,new T.HemisphereLight('#e5f2f5','#51616a',2.3));
  const sun=new T.DirectionalLight('#fff0df',2.3);sun.position.set(-3,5,-2);scene.add(sun);
  const studio=new T.Scene();studio.background=new T.Color('#8499aa');const wall=new T.Mesh(new T.BoxGeometry(12,12,.2),new T.MeshBasicMaterial({color:'#edf2f0'}));wall.position.set(0,3,-5);studio.add(wall);
  const roof=new T.Mesh(new T.BoxGeometry(6,.1,6),new T.MeshBasicMaterial({color:'#f4e9d6'}));roof.position.set(0,4,0);studio.add(roof);const pmrem=new T.PMREMGenerator(renderer),reflection=pmrem.fromScene(studio,.06,.1,20);scene.environment=reflection.texture;scene.environmentIntensity=.65;pmrem.dispose();
  const vm=new module.ViewModelV2(camera),ids=Object.keys(module.AUTHORED_RIGS),uvBaselines=new Map();
  const attributeHash=array=>{let result=2166136261;const bytes=new Uint8Array(array.buffer,array.byteOffset,array.byteLength);for(const value of bytes)result=Math.imul(result^value,16777619);return (result>>>0).toString(16);};
  window.__originalSkinDiagnostic={T,renderer,scene,camera,vm,ids,uvBaselines};
  window.__originalSkinPose=(slot,kind,progress,team)=>{
   const q=__originalSkinDiagnostic,id=q.ids[slot],p={weapon:slot,team,alive:true,vx:0,vz:0,reloadUntil:0,ammo:[30,30,5,12,0]},input={};
   vm.previous='';vm.previousAgent='';vm.lastReloadUntil=0;vm.phase=0;vm.wall=0;vm.update(p,input,0,10);
   const advance=duration=>{for(let time=0;time<duration;time+=1/120)vm.update(p,input,Math.min(1/120,duration-time),10+time);};
   if(kind==='draw')advance(progress);else{advance(2.2);if(kind==='fire'||kind==='heavy'){vm.fire({heavy:kind==='heavy'});advance(progress);}else if(kind==='reload'){p.reloadUntil=13;vm.update(p,input,0,10);vm.update(p,input,0,10+3*progress);}}
   const rig=vm.rigs.get(id),scales=[],uv=[],materials=[];let finite=true,trackError=0,checked=0;
   rig.root.traverse(node=>{for(const value of [...node.position,...node.quaternion,...node.scale])if(!Number.isFinite(value))finite=false;if(node.isBone)scales.push({name:node.name,scale:node.scale.toArray()});if(node.isMesh){for(const attr of ['uv','uv1','skinIndex','skinWeight']){const data=node.geometry.getAttribute(attr);if(data)uv.push({mesh:node.name,attribute:attr,count:data.count,hash:attributeHash(data.array)});}for(const material of [].concat(node.material||[])){const image=material.map?.image;materials.push({mesh:node.name,name:material.name,width:image?.width,height:image?.height,hasMap:!!material.map});}}});
   for(const track of rig.action.getClip().tracks){const binding=T.PropertyBinding.parseTrackName(track.name),node=rig.root.getObjectByName(binding.nodeName),actual=node?.[binding.propertyName]?.toArray?.();if(!actual)continue;const expected=track.createInterpolant().evaluate(rig.action.time);let error=Math.max(...expected.map((value,index)=>Math.abs(value-actual[index])));if(binding.propertyName==='quaternion')error=Math.min(error,Math.max(...expected.map((value,index)=>Math.abs(-value-actual[index]))));trackError=Math.max(trackError,error);checked++;}
   const key=team+':'+id,signature=JSON.stringify(uv);if(!uvBaselines.has(key))uvBaselines.set(key,signature);
   renderer.render(scene,camera);const hands=rig.hands.map(hand=>hand.getWorldPosition(new T.Vector3()).project(camera)).map(point=>({x:(point.x+1)*innerWidth/2,y:(1-point.y)*innerHeight/2}));
   const minX=Math.min(...hands.map(hand=>hand.x)),minY=Math.min(...hands.map(hand=>hand.y)),maxX=Math.max(...hands.map(hand=>hand.x));
   const cropX=Math.max(0,Math.min(innerWidth-240,Math.floor(minX-200))),cropY=Math.max(150,Math.min(innerHeight-240,Math.floor(minY-190)));
   document.querySelector('#caption').textContent='动画诊断 · 原生 GLB / 非实战录像\n'+(team?'潜伏者':'保卫者')+' · '+rig.config.model+'\n'+kind+' '+progress.toFixed(2)+' · 港湾警戒手套与袖口';
   return {team,slot,id,kind,progress,...vm.diagnostics,finite,trackError,checked,scales,scaleError:Math.max(...scales.flatMap(bone=>bone.scale.map(value=>Math.abs(value-1)))),uvStable:uvBaselines.get(key)===signature,uv,materials,hands:vm.lastHands,muzzle:vm.muzzle.toArray(),crop:{x:cropX,y:cropY,width:Math.min(innerWidth-cropX,Math.max(300,Math.ceil(maxX-minX+400))),height:innerHeight-cropY}};
  };
  return Object.entries(module.AUTHORED_RIGS).map(([id,config])=>({id,...config}));
 });report.runtimeAssets=assets;
 for(const team of [0,1])for(let slot=0;slot<assets.length;slot++){
  const states=[['idle',0],['draw',.08],['draw',.28],['draw',.5],['fire',.05],['fire',.16],['fire',.32],...(assets[slot].id==='knife'?[['heavy',.12],['heavy',.3],['heavy',.5]]:[['reload',.15],['reload',.4],['reload',.7],['reload',.93]])];
  for(const [kind,progress]of states){
   const pose=await page.evaluate(args=>__originalSkinPose(...args),[slot,kind,progress,team]);report.poses.push(pose);
   check(`Native rig ${team}/${pose.id}/${kind}/${progress}`,pose.finite&&pose.attachmentError<1e-5&&pose.scaleError<1e-5&&pose.trackError<2e-5&&pose.checked>30&&pose.uvStable,{attachmentError:pose.attachmentError,scaleError:pose.scaleError,trackError:pose.trackError,checked:pose.checked,uvStable:pose.uvStable});
   const name=`diagnostic-${team}-${pose.asset}-${kind}-${progress}`;await shot(name);
   if(kind==='idle'||pose.id==='ak47'&&kind==='reload'&&progress===.4){
    await page.evaluate(crop=>{const label=document.querySelector('#caption');label.style.left=(crop.x+10)+'px';label.style.top=(crop.y+10)+'px';label.style.fontSize='12px';},pose.crop);
    await shot(name+'-hands-detail',{clip:pose.crop});await page.evaluate(()=>{const label=document.querySelector('#caption');label.style.left='24px';label.style.top='24px';label.style.fontSize='16px';});
   }
  }
 }
 check('All ten team/weapon combinations retain mapped materials',new Set(report.poses.map(pose=>pose.team+':'+pose.id)).size===10&&report.poses.every(pose=>pose.materials.some(material=>material.hasMap)),{combinations:new Set(report.poses.map(pose=>pose.team+':'+pose.id)).size});
 await page.goto(base+'/games/freight-fire/?qa=1');await page.locator('#loading').waitFor({state:'hidden',timeout:120000});await page.waitForFunction(()=>window.__freight?.view?.stats?.fps>0);
 await page.locator('#difficulty').selectOption('easy');await shot('real-menu');
 for(const team of [0,1]){
  if(team){await page.keyboard.press('Escape');await page.locator('#menu').waitFor({state:'visible'});await page.locator('#leave').click();await page.locator('button[data-team="1"]').click();}
  await page.locator('#start').click();await page.waitForFunction(team=>{const q=__freight,p=q.snapshot?.players.find(player=>player.id===q.localId);return p?.alive&&p.team===team&&!q.paused;},team);await page.waitForTimeout(850);
  const read=()=>page.evaluate(()=>{const q=__freight,p=q.snapshot.players.find(player=>player.id===q.localId),vm=q.view.viewModel;return {time:q.snapshot.time,alive:p.alive,team:p.team,weapon:p.weapon,primary:p.primaryWeapon,position:[p.x,p.y,p.z],ammo:[...p.ammo],reserve:[...p.reserve],reloadUntil:p.reloadUntil,diagnostics:{...vm.diagnostics},paused:q.paused,actors:[...q.view.players.values()].map(({group})=>({team:group.userData.team,dead:group.userData.dead,pose:group.userData.poseStats,scaleError:Math.max(...Object.values(group.userData.bones).flatMap(bone=>bone.scale.toArray().map(value=>Math.abs(value-1))))}))};});
  const initial=await read();await shot(`real-${team}-m4-printstream-harbor-hands`);
  await page.keyboard.down('KeyF');await page.waitForTimeout(420);await page.keyboard.up('KeyF');const fired=await read();check('Actual M4 fire '+team,fired.alive&&fired.ammo[0]<initial.ammo[0],{initial,fired});
  await page.keyboard.press('KeyR');await page.waitForFunction(()=>{const q=__freight,p=q.snapshot.players.find(player=>player.id===q.localId);return p.reloadUntil>q.snapshot.time;});await page.waitForTimeout(550);await shot(`real-${team}-m4-printstream-reload-hands`);await page.waitForFunction(()=>{const q=__freight,p=q.snapshot.players.find(player=>player.id===q.localId);return p.reloadUntil<=q.snapshot.time&&p.ammo[0]===30;});
  await page.keyboard.press('KeyB');await page.locator('#loadout').waitFor({state:'visible'});await page.locator('button[data-primary="1"]').click();await page.locator('#loadout').waitFor({state:'hidden'});await page.waitForFunction(()=>{const q=__freight,p=q.snapshot.players.find(player=>player.id===q.localId);return p.primaryWeapon===1&&p.weapon===1;});await page.waitForTimeout(850);
  const selected=await read();await shot(`real-${team}-ak-vulcan-harbor-hands`);check('Actual B purchase selects the configured community AK Vulcan '+team,selected.weapon===1&&selected.diagnostics.asset===assets.find(asset=>asset.id==='ak47').file,selected);
  await page.keyboard.down('KeyF');await page.waitForTimeout(400);await page.keyboard.up('KeyF');const akShot=await read();check('Actual AK fire '+team,akShot.ammo[1]<selected.ammo[1],{selected,akShot});await page.keyboard.press('KeyR');await page.waitForTimeout(500);await shot(`real-${team}-ak-vulcan-reload-hands`);
  const beforeMove=await read();await page.keyboard.down('KeyW');await page.waitForTimeout(650);await page.keyboard.up('KeyW');const moved=await read();check('Actual W movement preserves character geometry '+team,Math.hypot(moved.position[0]-beforeMove.position[0],moved.position[2]-beforeMove.position[2])>1&&moved.actors.every(actor=>actor.scaleError<1e-5),{beforeMove,moved});await shot(`real-${team}-walk-and-reload`);
  report.gameplay.push({team,initial,fired,selected,akShot,beforeMove,moved});
 }
 check('No browser errors or failed asset requests',!report.errors.length&&!report.failedRequests.length,{errors:report.errors,failedRequests:report.failedRequests});
 }
 report.ok=true;
}catch(error){report.ok=false;report.failure=error.stack;process.exitCode=1;console.error(error.stack);if(page)await shot('failure').catch(()=>{});}
finally{await browser?.close();await new Promise(resolve=>server.close(resolve));await writeFile(path.join(out,'report.json'),JSON.stringify(report,null,2)+'\n');console.log('REPORT '+path.join(out,'report.json'));}
