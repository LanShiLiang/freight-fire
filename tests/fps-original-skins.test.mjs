import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile,writeFile,mkdir,mkdtemp,rm,stat} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import {parseGLB,inspectImage,extractOriginalSkins,repackOriginalSkin,repackOriginalSkins,compareSkinGeometry,ORIGINAL_SKIN_SOURCES} from '../scripts/prepare-original-skins.mjs';

const root=fileURLToPath(new URL('../',import.meta.url));
const originalDirectory=path.join(root,'games/freight-fire/assets/viewmodel-cs2');
const artifactDirectory=path.join(root,'artifacts/original-skins');
const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
const assets=new Map(await Promise.all(ORIGINAL_SKIN_SOURCES.map(async id=>[id,await readFile(path.join(originalDirectory,id+'.glb'))])));
const imageBytes=(source,index)=>{const glb=parseGLB(source),view=glb.json.bufferViews[glb.json.images[index].bufferView];return glb.binary.subarray(view.byteOffset||0,(view.byteOffset||0)+view.byteLength);};
const testSource={provider:'test-fixture',description:'Original normal atlas used only to test container replacement; never shipped as a painted skin.'};
function options(id){const source=assets.get(id),normal=id==='ak47-fire-serpent'?2:1,bytes=imageBytes(source,normal);return {sourceSha256:sha(source),allowResize:id==='ak47-fire-serpent',replacements:[{imageIndex:0,bytes,name:inspectImage(bytes).mimeType==='image/png'?'container-test.png':'container-test.jpg',source:testSource}],materialNames:{0:'Freight Fire container test'}};}
async function temporary(run){await mkdir(artifactDirectory,{recursive:true});const directory=await mkdtemp(path.join(artifactDirectory,'qa-'));try{return await run(directory);}finally{assert.ok(path.dirname(directory)===artifactDirectory&&path.basename(directory).startsWith('qa-'));await rm(directory,{recursive:true,force:true});}}
function changeJSON(bytes,change){const glb=parseGLB(bytes),json=structuredClone(glb.json);change(json);const text=Buffer.from(JSON.stringify(json)),padding=Buffer.alloc((4-text.length%4)%4,32),body=Buffer.concat([text,padding]),output=Buffer.alloc(28+body.length+glb.binary.length);output.writeUInt32LE(0x46546c67);output.writeUInt32LE(2,4);output.writeUInt32LE(output.length,8);output.writeUInt32LE(body.length,12);output.writeUInt32LE(0x4e4f534a,16);body.copy(output,20);output.writeUInt32LE(glb.binary.length,20+body.length);output.writeUInt32LE(0x004e4942,24+body.length);glb.binary.copy(output,28+body.length);return output;}

test('extracts all 21 embedded original images with material roles and true UV guides',async()=>temporary(async directory=>{
  const manifest=await extractOriginalSkins({outputDirectory:directory});
  assert.deepEqual(manifest.models.map(model=>model.images.length),[9,9,3]);
  const expected={'ct-sas':[[0,1024,1024],[6,512,1024]],'t-phoenix':[[0,1024,1024],[6,1024,1024]],'ak47-fire-serpent':[[0,2048,2048]]};
  for(const model of manifest.models){
    assert.equal(model.sha256,sha(assets.get(model.id)));
    for(const image of model.images){const bytes=await readFile(image.path);assert.equal(sha(bytes),image.sha256);assert.deepEqual(bytes,imageBytes(assets.get(model.id),image.index));}
    for(const [index,width,height]of expected[model.id]){const image=model.images[index];assert.equal(image.width,width);assert.equal(image.height,height);assert.ok(image.roles.some(role=>role.role==='baseColor'));assert.ok(image.guides.edges>0);const guide=inspectImage(await readFile(image.guides.png));assert.equal(guide.width,width);assert.equal(guide.height,height);assert.match(await readFile(image.guides.wire,'utf8'),/v=0 at image top/);assert.match(await readFile(image.guides.overlay,'utf8'),/data:image\/(jpeg|png);base64,/);}
  }
}));

test('replaces baseColor buffers while preserving actual nodes, vertices, UVs, skinning and animations',()=>{
  for(const id of ORIGINAL_SKIN_SOURCES){const source=assets.get(id),original=parseGLB(source),result=repackOriginalSkin(source,options(id)),output=parseGLB(result.bytes);
    assert.equal(result.comparison.identical,true);assert.equal(compareSkinGeometry(source,result.bytes).identical,true);
    for(const key of ['nodes','scenes','skins','meshes','accessors','animations','textures','samplers'])assert.deepEqual(output.json[key],original.json[key],id+': '+key);
    for(const [index,image]of original.json.images.entries())if(index!==0)assert.deepEqual(imageBytes(result.bytes,index),imageBytes(source,index),id+': untouched image '+image.name);
    assert.equal(output.json.materials[0].name,'Freight Fire container test');assert.equal(output.json.images[0].mimeType,inspectImage(options(id).replacements[0].bytes).mimeType);assert.equal(output.json.images[0].name,options(id).replacements[0].name);assert.deepEqual(imageBytes(result.bytes,0),options(id).replacements[0].bytes);
    assert.equal(result.sha256,sha(result.bytes));assert.notEqual(result.sha256,sha(source));assert.equal(result.changedImages[0].source.provider,'test-fixture');
  }
});

test('rejects wrong source hashes, non-color slots, duplicates and missing image provenance',()=>{
  const source=assets.get('ct-sas'),base=options('ct-sas');
  assert.throws(()=>repackOriginalSkin(source,{...base,sourceSha256:'0'.repeat(64)}),/SHA-256 mismatch/);
  assert.throws(()=>repackOriginalSkin(source,{...base,replacements:[{...base.replacements[0],imageIndex:1}]}),/baseColor-only/);
  assert.throws(()=>repackOriginalSkin(source,{...base,replacements:[base.replacements[0],base.replacements[0]]}),/duplicate replacement/);
  assert.throws(()=>repackOriginalSkin(source,{...base,replacements:[{...base.replacements[0],source:{}}]}),/provenance metadata/);
  assert.throws(()=>repackOriginalSkin(source,{...base,replacements:[]}),/At least one/);
});

test('rejects truncated or corrupted image payloads and incompatible UV atlas dimensions',()=>{
  const source=assets.get('ct-sas'),base=options('ct-sas'),png=Buffer.from(base.replacements[0].bytes);png[Math.floor(png.length/2)]^=1;
  assert.throws(()=>inspectImage(png),/PNG chunk checksum/);
  assert.throws(()=>inspectImage(imageBytes(source,0).subarray(0,-2)),/Truncated JPEG/);
  assert.throws(()=>inspectImage(Buffer.from('not an image')),/valid PNG, JPEG or WebP/);
  const wrongSize={...base.replacements[0],bytes:imageBytes(source,5)};
  assert.throws(()=>repackOriginalSkin(source,{...base,replacements:[wrongSize]}),/dimensions must match/);
  assert.throws(()=>repackOriginalSkin(source,{...base,allowResize:true,replacements:[wrongSize]}),/aspect ratio/);
  const ak=assets.get('ak47-fire-serpent');assert.throws(()=>repackOriginalSkin(ak,{...options('ak47-fire-serpent'),allowResize:false}),/dimensions must match/);
});

test('rejects image bufferViews aliased by a mesh accessor or another image',()=>{
  const original=assets.get('ct-sas');
  const meshAlias=changeJSON(original,json=>{json.accessors[0].bufferView=json.images[0].bufferView;});
  assert.throws(()=>repackOriginalSkin(meshAlias,{...options('ct-sas'),sourceSha256:sha(meshAlias)}),/also used by mesh\/animation/);
  const imageAlias=changeJSON(original,json=>{json.images[1].bufferView=json.images[0].bufferView;});
  assert.throws(()=>repackOriginalSkin(imageAlias,{...options('ct-sas'),sourceSha256:sha(imageAlias)}),/another embedded image/);
});

test('geometry comparison detects protected node or vertex bytes changing',()=>{
  const source=assets.get('ct-sas'),result=repackOriginalSkin(source,options('ct-sas'));
  const nodeChanged=changeJSON(result.bytes,json=>{json.nodes[0].name='changed-original-rig';});assert.equal(compareSkinGeometry(source,nodeChanged).identical,false);
  const changed=Buffer.from(result.bytes),glb=parseGLB(changed),view=glb.json.bufferViews[glb.json.accessors[0].bufferView],binOffset=28+changed.readUInt32LE(12);changed[binOffset+(view.byteOffset||0)]^=1;assert.equal(compareSkinGeometry(source,changed).identical,false);
});

test('recipe writes derived models and source/output hash lock without changing original assets',async()=>temporary(async directory=>{
  const models=[];
  for(const id of ORIGINAL_SKIN_SOURCES){const replacement=options(id).replacements[0],image=path.join(directory,id+'-fixture.png');await writeFile(image,replacement.bytes);models.push({input:path.join(originalDirectory,id+'.glb'),output:id+'-derived-test.glb',sourceSha256:sha(assets.get(id)),allowResize:id==='ak47-fire-serpent',replacements:[{imageIndex:0,image:path.basename(image),source:testSource}],materialNames:{0:'Test container'}});}
  const recipe=path.join(directory,'recipe.json');await writeFile(recipe,JSON.stringify({version:1,models}));const lock=await repackOriginalSkins(recipe);assert.equal(lock.assets.length,3);assert.equal(JSON.parse(await readFile(lock.lockPath,'utf8')).assets.length,3);
  for(const asset of lock.assets){assert.equal(asset.geometryComparison.identical,true);assert.equal(sha(await readFile(path.resolve(root,asset.source.path))),asset.source.sha256);const output=await readFile(path.resolve(root,asset.output.path));assert.equal(output.length,asset.output.bytes);assert.equal(sha(output),asset.output.sha256);assert.equal(asset.replacements[0].source.provider,'test-fixture');}
}));

test('invalid multi-model recipes write no partial output and cannot overwrite originals',async()=>temporary(async directory=>{
  const image=path.join(directory,'fixture.png');await writeFile(image,options('ct-sas').replacements[0].bytes);const model={input:path.join(originalDirectory,'ct-sas.glb'),output:'first.glb',sourceSha256:sha(assets.get('ct-sas')),replacements:[{imageIndex:0,image,source:testSource}]};
  const recipe=path.join(directory,'recipe.json');await writeFile(recipe,JSON.stringify({version:1,models:[model,{...model,output:'second.glb',sourceSha256:'0'.repeat(64)}]}));await assert.rejects(repackOriginalSkins(recipe),/SHA-256 mismatch/);await assert.rejects(stat(path.join(directory,'first.glb')),error=>error.code==='ENOENT');
  await writeFile(recipe,JSON.stringify({version:1,models:[{...model,output:model.input}]}));await assert.rejects(repackOriginalSkins(recipe),/overwrite an original/);
}));

test('shipped original skin recipe reproduces all three derived GLBs exactly with unchanged rig and untouched images',async()=>{
  const recipeDirectory=path.join(originalDirectory,'original');
  const recipe=JSON.parse(await readFile(path.join(recipeDirectory,'recipe.json'),'utf8'));
  const lock=JSON.parse(await readFile(path.join(originalDirectory,'original-skins.json'),'utf8'));
  assert.equal(recipe.models.length,3);assert.equal(lock.assets.length,3);
  assert.doesNotMatch(JSON.stringify({recipe,lock}),/[A-Za-z]:[\\/]|\/Users\/|\/home\//,'Published provenance contains no machine-specific absolute paths');
  let originalBytes=0,derivedBytes=0;
  for(const [index,model]of recipe.models.entries()){
    const source=await readFile(path.resolve(recipeDirectory,model.input)),output=await readFile(path.resolve(recipeDirectory,model.output));
    const replacements=[];
    for(const replacement of model.replacements){const bytes=await readFile(path.join(recipeDirectory,replacement.image));replacements.push({...replacement,bytes});const previous=inspectImage(imageBytes(source,replacement.imageIndex)),next=inspectImage(bytes);assert.equal(next.width,previous.width);assert.equal(next.height,previous.height);assert.equal(replacement.source.provider,'imagegen');assert.match(replacement.source.generatedImage.sha256,/^[a-f0-9]{64}$/);assert.ok(replacement.source.promptSummary.length>20);}
    const rebuilt=repackOriginalSkin(source,{sourceSha256:model.sourceSha256,replacements,materialNames:model.materialNames});
    assert.deepEqual(rebuilt.bytes,output,'Repository recipe produces exact derived GLB bytes');
    assert.equal(compareSkinGeometry(source,output).identical,true);
    const changed=new Set(model.replacements.map(item=>item.imageIndex));
    for(const [imageIndex]of parseGLB(source).json.images.entries())if(!changed.has(imageIndex))assert.deepEqual(imageBytes(output,imageIndex),imageBytes(source,imageIndex),'Normal, ORM and exposed arm images stay untouched');
    const asset=lock.assets[index];assert.equal(asset.source.sha256,sha(source));assert.equal(asset.output.sha256,sha(output));assert.equal(asset.source.bytes,source.length);assert.equal(asset.output.bytes,output.length);
    originalBytes+=source.length;derivedBytes+=output.length;
  }
  assert.ok(derivedBytes<originalBytes,'The three replacement loads do not increase startup download size');
});
