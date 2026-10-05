import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import path from 'node:path';
import {isDeepStrictEqual} from 'node:util';
import {parseGLB,inspectImage} from './prepare-original-skins.mjs';

// Independently pinned complete files from dust2-web assets-lock version
// 5a82c6eead18b7e0. A changed provenance JSON cannot bless a repainted GLB.
export const COMMUNITY_SKIN_SOURCE_PINS=Object.freeze([
 Object.freeze({weaponId:'ak47',file:'ak47-vulcan',model:'AK-47 | Vulcan',paintKit:302,
 bytes:2807216,sha256:'46c540e3869bb2737d633a67c578ce9e2665eae63f1c07544793ecf8de4f558c',
  previewBytes:17244,previewSha256:'0440efdc1c0e1a8b1c831d90687e5adab5b734837a2ba079cb88011a9c8789dc',
  reference:'ak47-fire-serpent',referenceBytes:3400016,referenceSha256:'3591d83e3c1de5eab06d4d656fbc0d6a6a753d984df438edb97c7d0549af2550',
  previous:'ak47-docksteel',previousBytes:2696768,previousSha256:'67bfb2db963b8cdbd3941bb0749868069efb5d6b3c4ff782c1a6c4c37234b19f'}),
 Object.freeze({weaponId:'m4a1',file:'m4a1-printstream',model:'M4A1-S | Printstream',paintKit:984,
  bytes:3592668,sha256:'6321cb8e979aaebf7f70ba77a36f2e0e84a40324d791b6b851088c2dc7af2a0e',
  previewBytes:14020,previewSha256:'3d8fc8c2841350892d5d0306d3a7f9a2f36ca208aa232091d39a33001ebfad90',
  reference:'m4a1-golden-coil',referenceBytes:4516992,referenceSha256:'f74ff219e5cc3087ed36e0935637c6bdade5772d28ed1cfb8f1376f9fde38ef3',
  previous:'m4a1-golden-coil',previousBytes:4516992,previousSha256:'f74ff219e5cc3087ed36e0935637c6bdade5772d28ed1cfb8f1376f9fde38ef3'})
]);
const sha256=bytes=>createHash('sha256').update(bytes).digest('hex');
const omit=(value,keys)=>Object.fromEntries(Object.entries(value).filter(([key])=>!keys.includes(key)));
const componentCount={SCALAR:1,VEC2:2,VEC3:3,VEC4:4,MAT2:4,MAT3:9,MAT4:16};
const componentBytes={5120:1,5121:1,5122:2,5123:2,5125:4,5126:4};
const normalizedNodes=nodes=>nodes.map(node=>node.name==='normalization'&&node.extras?{...node,extras:omit(node.extras,['paintkit'])}:node);

function rawAccessor(model,index){
 const accessor=model.json.accessors[index],view=model.json.bufferViews[accessor.bufferView];
 assert(view&&!accessor.sparse,'Protected accessor must use explicit bufferView data');
 const width=componentCount[accessor.type]*componentBytes[accessor.componentType],stride=view.byteStride||width;
 assert(width>0&&stride>=width,'Valid component width and stride');
 const offset=(view.byteOffset||0)+(accessor.byteOffset||0),bytes=Buffer.alloc(accessor.count*width);
 assert(offset+(accessor.count-1)*stride+width<=(view.byteOffset||0)+view.byteLength,'Accessor stays inside its bufferView');
 for(let row=0;row<accessor.count;row++)model.binary.copy(bytes,row*width,offset+row*stride,offset+row*stride+width);
 return {metadata:omit(accessor,['bufferView','byteOffset']),bytes};
}

export function compareCommunityGeometry(sourceBytes,outputBytes){
 const source=parseGLB(sourceBytes),output=parseGLB(outputBytes);
 const structure={
  nodesAndRestTransforms:isDeepStrictEqual(normalizedNodes(source.json.nodes),normalizedNodes(output.json.nodes)),
  sceneRoots:isDeepStrictEqual(source.json.scenes.map(scene=>omit(scene,['name'])),output.json.scenes.map(scene=>omit(scene,['name']))),
  defaultScene:isDeepStrictEqual(source.json.scene,output.json.scene),
  meshPrimitiveBindings:isDeepStrictEqual(source.json.meshes,output.json.meshes),
  skinsAndJointIndices:isDeepStrictEqual(source.json.skins,output.json.skins),
  animations:isDeepStrictEqual(source.json.animations,output.json.animations),
  accessorCount:source.json.accessors.length===output.json.accessors.length,
 };
 const semantics=new Map();
 source.json.meshes.forEach(mesh=>mesh.primitives.forEach(primitive=>{
  for(const [name,index]of Object.entries(primitive.attributes))semantics.set(index,name);
  semantics.set(primitive.indices,'indices');
 }));
 source.json.skins.forEach(skin=>semantics.set(skin.inverseBindMatrices,'inverseBindMatrices'));
 const accessors=structure.accessorCount?source.json.accessors.map((accessor,index)=>{
  const a=rawAccessor(source,index),b=rawAccessor(output,index);
  return {index,semantic:semantics.get(index)||accessor.name||'accessor',count:accessor.count,type:accessor.type,
   componentType:accessor.componentType,metadataIdentical:isDeepStrictEqual(a.metadata,b.metadata),
   byteLength:a.bytes.length,sourceSha256:sha256(a.bytes),outputSha256:sha256(b.bytes),rawBytesIdentical:a.bytes.equals(b.bytes)};
 }):[];
 return {identical:Object.values(structure).every(Boolean)&&accessors.every(value=>value.metadataIdentical&&value.rawBytesIdentical),structure,accessors};
}

export function describeCommunityGLB(bytes){
 const model=parseGLB(bytes);
 const images=model.json.images.map((image,index)=>{
  const view=model.json.bufferViews[image.bufferView],payload=model.binary.subarray(view.byteOffset||0,(view.byteOffset||0)+view.byteLength);
  return {index,name:image.name,...inspectImage(payload)};
 });
 return {bytes:bytes.length,sha256:sha256(bytes),paintKit:model.json.nodes.find(node=>node.name==='normalization')?.extras?.paintkit,
  materials:model.json.materials,images,textures:model.json.textures,samplers:model.json.samplers,extensionsUsed:model.json.extensionsUsed||[]};
}

export async function verifyCommunitySkins({projectRoot,manifestPath=path.join(projectRoot,'games/freight-fire/assets/viewmodel-cs2/skin-selection-community.json')}={}){
 assert(projectRoot,'projectRoot is required');
 const manifest=JSON.parse(await readFile(manifestPath,'utf8')),results=[];
 assert.equal(manifest.upstreamLock.version,'5a82c6eead18b7e0');
 assert.equal(manifest.skins.length,COMMUNITY_SKIN_SOURCE_PINS.length);
 const local=relative=>{
  const filename=path.resolve(projectRoot,relative),inside=path.relative(projectRoot,filename);
  assert(!inside.startsWith('..')&&!path.isAbsolute(inside),'Asset path stays inside project');return filename;
 };
 for(const pin of COMMUNITY_SKIN_SOURCE_PINS){
  const skin=manifest.skins.find(value=>value.weaponId===pin.weaponId);assert(skin,'Community selection '+pin.weaponId);
  assert.equal(skin.id,pin.file);assert.equal(skin.output.path,`games/freight-fire/assets/viewmodel-cs2/${pin.file}.glb`);
  assert.equal(skin.source.url,`https://cs2.duskrain.cn/assets/weapons/cs2-loadout/${pin.file}.glb`);
  const output=await readFile(local(skin.output.path)),model=describeCommunityGLB(output);
  assert.equal(model.sha256,pin.sha256,'Complete GLB matches the independent source pin');assert.equal(model.bytes,pin.bytes);
  for(const record of [skin.source,skin.output]){assert.equal(record.sha256,pin.sha256);assert.equal(record.bytes,pin.bytes);}
  assert.equal(model.materials[0].name,pin.model);assert.equal(model.paintKit,pin.paintKit);
  assert(model.materials[0].pbrMetallicRoughness.baseColorTexture&&model.materials[0].normalTexture&&model.materials[0].pbrMetallicRoughness.metallicRoughnessTexture,'Original complete PBR material retained');
  assert.equal(model.images.length,pin.weaponId==='m4a1'?4:3);
  assert(model.images.every(image=>image.width>0&&image.height>0&&image.width<=4096&&image.height<=4096));
  assert.deepEqual(model.images,skin.embeddedTextures,'Actual embedded image bytes/dimensions match provenance');
  if(pin.weaponId==='m4a1')assert(model.materials[0].extensions?.KHR_materials_iridescence,'Original Printstream iridescence material retained');
  const preview=await readFile(local(skin.preview.path)),previewImage=inspectImage(preview);
  assert.equal(previewImage.sha256,pin.previewSha256);assert.equal(previewImage.bytes,pin.previewBytes);assert.equal(previewImage.mimeType,'image/webp');assert.equal(previewImage.width,512);assert.equal(previewImage.height,384);
  assert.equal(skin.preview.sha256,pin.previewSha256);assert.equal(skin.preview.bytes,pin.previewBytes);
  const comparisons=[];
  for(const [record,role]of [[skin.geometryReference,'reference'],[skin.previous,'previous']]){
   assert.equal(record.path,`games/freight-fire/assets/viewmodel-cs2/${pin[role]}.glb`,'Expected retained same-weapon comparison model');
   assert.equal(record.sha256,pin[role+'Sha256']);assert.equal(record.bytes,pin[role+'Bytes']);
   const previous=await readFile(local(record.path));assert.equal(sha256(previous),pin[role+'Sha256']);assert.equal(previous.length,pin[role+'Bytes']);
   const comparison=compareCommunityGeometry(previous,output);assert(comparison.identical,'Actual protected geometry preserved '+record.path);
   assert.deepEqual(new Set(comparison.accessors.map(accessor=>accessor.semantic)),new Set(['POSITION','TEXCOORD_0','NORMAL','TANGENT','TEXCOORD_1','JOINTS_0','WEIGHTS_0','indices','inverseBindMatrices']));
   comparisons.push({path:record.path,...comparison});
  }
  results.push({weaponId:pin.weaponId,output:skin.output,preview:skin.preview,model,comparisons});
 }
 return {manifest,results};
}
