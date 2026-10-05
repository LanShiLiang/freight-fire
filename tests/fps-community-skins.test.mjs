import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
import {AUTHORED_RIGS} from '../games/freight-fire/viewmodel-cs2.js';
import {assetLoading} from '../games/freight-fire/asset-loading.js';
import {parseGLB} from '../scripts/prepare-original-skins.mjs';
import {COMMUNITY_SKIN_SOURCE_PINS,verifyCommunitySkins,compareCommunityGeometry} from '../scripts/community-skins-verification.mjs';

const root=fileURLToPath(new URL('../',import.meta.url));
const verified=await verifyCommunitySkins({projectRoot:root});
for(const result of verified.results){
 test(result.weaponId+' community GLB keeps the exact complete public model and original PBR materials',()=>{
  const pin=COMMUNITY_SKIN_SOURCE_PINS.find(value=>value.weaponId===result.weaponId);
  assert.equal(result.model.sha256,pin.sha256);assert.equal(result.model.bytes,pin.bytes);
  assert.equal(result.model.materials[0].name,pin.model);assert.equal(result.model.paintKit,pin.paintKit);
  assert.equal(result.model.images.length,result.weaponId==='m4a1'?4:3);
  if(result.weaponId==='m4a1')assert(result.model.extensionsUsed.includes('KHR_materials_iridescence'));
 });
 test(result.weaponId+' actual semantic accessors, original hierarchy/rest transforms and inverse bind bytes match both preceding same-weapon models',()=>{
  for(const comparison of result.comparisons){
   assert(comparison.identical);assert(Object.values(comparison.structure).every(Boolean));assert.equal(comparison.accessors.length,9);
   for(const accessor of comparison.accessors){assert(accessor.metadataIdentical);assert(accessor.rawBytesIdentical);assert.equal(accessor.sourceSha256,accessor.outputSha256);}
  }
 });
}

test('actual AUTHORED_RIGS and executed modelAssets declarations match all eight file sizes and load community rifles with Harbor hands',async()=>{
 const records=assetLoading.snapshot.assets.filter(record=>record.group==='viewmodels'&&record.url.endsWith('.glb'));
 assert.equal(records.length,8);const files=new Set();
 for(const record of records){const filename=fileURLToPath(record.url),bytes=await readFile(filename);assert.equal(record.totalBytes,bytes.length,path.basename(filename)+' declared decoded body bytes');files.add(path.basename(filename,'.glb'));}
 for(const pin of COMMUNITY_SKIN_SOURCE_PINS){assert.equal(AUTHORED_RIGS[pin.weaponId].file,pin.file);assert.equal(AUTHORED_RIGS[pin.weaponId].model,pin.model);assert(files.has(pin.file));}
 for(const filename of ['ct-sas-harbor','t-phoenix-harbor','animations-selected','awp-dragon-lore','usp-kill-confirmed','karambit-sapphire'])assert(files.has(filename));
 for(const old of ['ak47-docksteel','ak47-fire-serpent','m4a1-golden-coil','ct-sas','t-phoenix'])assert(!files.has(old),'Historical source model is not a startup request');
});

test('independent geometry comparison rejects changed vertex data and hierarchy/rest pose instead of trusting the selection manifest',async()=>{
 const bytes=await readFile(path.join(root,verified.results[0].output.path)),parsed=parseGLB(bytes),changed=Buffer.from(bytes);
 const view=parsed.json.bufferViews[parsed.json.accessors[0].bufferView],binaryStart=28+bytes.readUInt32LE(12);changed[binaryStart+(view.byteOffset||0)]^=1;
 assert.equal(compareCommunityGeometry(bytes,changed).identical,false);
 const json=structuredClone(parsed.json);json.nodes[0].translation=[9,8,7];
 const text=Buffer.from(JSON.stringify(json)),jsonChunk=Buffer.concat([text,Buffer.alloc((4-text.length%4)%4,32)]),replacement=Buffer.alloc(28+jsonChunk.length+parsed.binary.length);
 replacement.writeUInt32LE(0x46546c67);replacement.writeUInt32LE(2,4);replacement.writeUInt32LE(replacement.length,8);replacement.writeUInt32LE(jsonChunk.length,12);replacement.writeUInt32LE(0x4e4f534a,16);jsonChunk.copy(replacement,20);replacement.writeUInt32LE(parsed.binary.length,20+jsonChunk.length);replacement.writeUInt32LE(0x004e4942,24+jsonChunk.length);parsed.binary.copy(replacement,28+jsonChunk.length);
 assert.equal(compareCommunityGeometry(bytes,replacement).identical,false);
});
