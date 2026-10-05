import {readFile,writeFile,mkdir} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {createHash} from 'node:crypto';
import {inflateSync,deflateSync} from 'node:zlib';

const root=fileURLToPath(new URL('../',import.meta.url));
export const ORIGINAL_SKIN_SOURCES=Object.freeze(['ct-sas','t-phoenix','ak47-fire-serpent']);
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
const align4=n=>(n+3)&~3;
const safeName=value=>String(value).replace(/[^a-zA-Z0-9_.-]+/g,'-').slice(0,100)||'image';
const xml=value=>String(value).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&apos;'}[c]));

export function parseGLB(input){
  const bytes=Buffer.from(input);
  if(bytes.length<28||bytes.readUInt32LE(0)!==0x46546c67||bytes.readUInt32LE(4)!==2||bytes.readUInt32LE(8)!==bytes.length)throw Error('Invalid GLB 2.0 header or length');
  const chunks=[];let offset=12;
  while(offset<bytes.length){
    if(offset+8>bytes.length)throw Error('Truncated GLB chunk');
    const size=bytes.readUInt32LE(offset),type=bytes.readUInt32LE(offset+4);offset+=8;
    if(size%4||offset+size>bytes.length)throw Error('Invalid GLB chunk length');
    chunks.push({type,bytes:bytes.subarray(offset,offset+size)});offset+=size;
  }
  if(chunks.length!==2||chunks[0].type!==0x4e4f534a||chunks[1].type!==0x004e4942)throw Error('Expected JSON and BIN GLB chunks');
  const json=JSON.parse(chunks[0].bytes.toString('utf8').trim()),binary=chunks[1].bytes;
  if(json.buffers?.length!==1||json.buffers[0].uri||json.buffers[0].byteLength>binary.length)throw Error('Only one embedded GLB buffer is supported');
  for(const view of json.bufferViews||[]){const start=view.byteOffset||0;if(view.buffer!==0||start<0||!Number.isInteger(start)||!Number.isInteger(view.byteLength)||view.byteLength<0||start+view.byteLength>json.buffers[0].byteLength)throw Error('Invalid embedded bufferView');}
  return {json,binary,bytes};
}

const pngSignature=Buffer.from([137,80,78,71,13,10,26,10]);
function crc32(bytes){let value=0xffffffff;for(const byte of bytes){value^=byte;for(let bit=0;bit<8;bit++)value=(value>>>1)^((value&1)?0xedb88320:0);}return (value^0xffffffff)>>>0;}
function pngChunk(type,body){const name=Buffer.from(type),chunk=Buffer.alloc(body.length+12);chunk.writeUInt32BE(body.length);name.copy(chunk,4);body.copy(chunk,8);chunk.writeUInt32BE(crc32(Buffer.concat([name,body])),body.length+8);return chunk;}

/** Validate the image container, dimensions and PNG compressed pixel stream. */
export function inspectImage(input){
  const bytes=Buffer.from(input);let width,height,mimeType;
  if(bytes.subarray(0,8).equals(pngSignature)){
    let offset=8,header,ended=false;const data=[];
    while(offset<bytes.length){
      if(offset+12>bytes.length)throw Error('Truncated PNG chunk');
      const length=bytes.readUInt32BE(offset),type=bytes.toString('ascii',offset+4,offset+8),end=offset+12+length;
      if(end>bytes.length)throw Error('Truncated PNG image');
      const body=bytes.subarray(offset+8,end-4);
      if(crc32(bytes.subarray(offset+4,end-4))!==bytes.readUInt32BE(end-4))throw Error('Invalid PNG chunk checksum');
      if(offset===8&&type!=='IHDR')throw Error('PNG must start with IHDR');
      if(type==='IHDR'){if(header||length!==13)throw Error('Invalid PNG IHDR');header=body;width=body.readUInt32BE(0);height=body.readUInt32BE(4);}
      if(type==='IDAT')data.push(body);
      if(type==='IEND'){if(length||end!==bytes.length)throw Error('Invalid PNG IEND');ended=true;}
      offset=end;
    }
    if(!header||!ended||!data.length)throw Error('Incomplete PNG image');
    if(width<1||height<1||width>8192||height>8192)throw Error('Image dimensions outside 1..8192');
    const channels={0:1,2:3,3:1,4:2,6:4}[header[9]],depth=header[8];
    if(!channels||![1,2,4,8,16].includes(depth)||header[10]!==0||header[11]!==0||header[12]>1)throw Error('Unsupported PNG image encoding');
    const decoded=inflateSync(Buffer.concat(data),{maxOutputLength:width*height*8+height*8+4096});
    if(header[12]===0){const row=1+Math.ceil(width*channels*depth/8);if(decoded.length!==height*row)throw Error('Invalid PNG pixel stream length');for(let y=0;y<height;y++)if(decoded[y*row]>4)throw Error('Invalid PNG pixel filter');}
    mimeType='image/png';
  }else if(bytes.length>4&&bytes[0]===0xff&&bytes[1]===0xd8){
    if(bytes.at(-2)!==0xff||bytes.at(-1)!==0xd9)throw Error('Truncated JPEG image');
    let offset=2,sawScan=false;
    while(offset<bytes.length-2){
      if(bytes[offset++]!==0xff)throw Error('Invalid JPEG marker');while(bytes[offset]===0xff)offset++;
      const marker=bytes[offset++];if(marker===0xd9)break;if(marker===0xd8||marker===0x01||(marker>=0xd0&&marker<=0xd7))continue;
      if(offset+2>bytes.length)throw Error('Truncated JPEG segment');const length=bytes.readUInt16BE(offset);if(length<2||offset+length>bytes.length)throw Error('Invalid JPEG segment length');
      if([0xc0,0xc1,0xc2,0xc3,0xc5,0xc6,0xc7,0xc9,0xca,0xcb,0xcd,0xce,0xcf].includes(marker)){if(length<8)throw Error('Invalid JPEG frame');height=bytes.readUInt16BE(offset+3);width=bytes.readUInt16BE(offset+5);}
      if(marker===0xda){sawScan=true;break;}offset+=length;
    }
    if(!sawScan||!width||!height)throw Error('Missing JPEG frame or scan');mimeType='image/jpeg';
  }else if(bytes.length>=30&&bytes.toString('ascii',0,4)==='RIFF'&&bytes.toString('ascii',8,12)==='WEBP'){
    if(bytes.readUInt32LE(4)+8!==bytes.length)throw Error('Invalid WebP RIFF length');
    let offset=12;while(offset+8<=bytes.length){const type=bytes.toString('ascii',offset,offset+4),length=bytes.readUInt32LE(offset+4),start=offset+8;if(start+length>bytes.length)throw Error('Truncated WebP chunk');
      if(type==='VP8X'&&length>=10){width=1+bytes.readUIntLE(start+4,3);height=1+bytes.readUIntLE(start+7,3);}
      else if(type==='VP8L'&&length>=5&&bytes[start]===0x2f){const bits=bytes.readUInt32LE(start+1);width=(bits&0x3fff)+1;height=((bits>>>14)&0x3fff)+1;}
      else if(type==='VP8 '&&length>=10&&bytes.subarray(start+3,start+6).equals(Buffer.from([0x9d,0x01,0x2a]))){width=bytes.readUInt16LE(start+6)&0x3fff;height=bytes.readUInt16LE(start+8)&0x3fff;}
      offset=start+length+(length%2);
    }
    if(!width||!height)throw Error('Missing WebP image frame');mimeType='image/webp';
  }else throw Error('Only valid PNG, JPEG or WebP image containers are accepted');
  if(!Number.isInteger(width)||!Number.isInteger(height)||width<1||height<1||width>8192||height>8192)throw Error('Image dimensions outside 1..8192');
  return {mimeType,width,height,bytes:bytes.length,sha256:hash(bytes)};
}

const viewBytes=(glb,index)=>{const view=glb.json.bufferViews[index];if(!view)throw Error('Missing bufferView '+index);return glb.binary.subarray(view.byteOffset||0,(view.byteOffset||0)+view.byteLength);};
const typeSize={SCALAR:1,VEC2:2,VEC3:3,VEC4:4,MAT2:4,MAT3:9,MAT4:16};
const componentSize={5120:1,5121:1,5122:2,5123:2,5125:4,5126:4};
function accessorValues(glb,index){
  const accessor=glb.json.accessors[index];if(!accessor||accessor.sparse||accessor.bufferView===undefined)throw Error('Unsupported UV/index accessor '+index);
  const size=typeSize[accessor.type],component=componentSize[accessor.componentType],view=glb.json.bufferViews[accessor.bufferView],bytes=viewBytes(glb,accessor.bufferView),stride=view.byteStride||size*component;
  const read={5120:'readInt8',5121:'readUInt8',5122:'readInt16LE',5123:'readUInt16LE',5125:'readUInt32LE',5126:'readFloatLE'}[accessor.componentType];
  return Array.from({length:accessor.count},(_,i)=>Array.from({length:size},(_,k)=>{let value=bytes[read]((accessor.byteOffset||0)+i*stride+k*component);if(accessor.normalized&&accessor.componentType!==5126)value=accessor.componentType===5120?Math.max(-1,value/127):accessor.componentType===5122?Math.max(-1,value/32767):value/({5121:255,5123:65535,5125:4294967295}[accessor.componentType]);return value;}));
}

function imageRoles(json,index){const roles=[];for(const [materialIndex,material]of (json.materials||[]).entries())for(const [role,info]of [['baseColor',material.pbrMetallicRoughness?.baseColorTexture],['ORM',material.pbrMetallicRoughness?.metallicRoughnessTexture],['normal',material.normalTexture],['occlusion',material.occlusionTexture]])if(info&&json.textures?.[info.index]?.source===index)roles.push({materialIndex,materialName:material.name||'material-'+materialIndex,role,texCoord:info.texCoord||0});return roles;}
function uvEdges(glb,roles){const edges=new Map();for(const mesh of glb.json.meshes||[])for(const primitive of mesh.primitives||[]){const role=roles.find(item=>item.materialIndex===primitive.material&&item.role==='baseColor');if(!role)continue;const uvIndex=primitive.attributes?.['TEXCOORD_'+role.texCoord];if(uvIndex===undefined)continue;if(primitive.mode!==undefined&&primitive.mode!==4)throw Error('UV guides require triangle primitives');const uv=accessorValues(glb,uvIndex),indices=primitive.indices===undefined?uv.map((_,i)=>i):accessorValues(glb,primitive.indices).flat();for(let i=0;i+2<indices.length;i+=3)for(const [a,b]of [[indices[i],indices[i+1]],[indices[i+1],indices[i+2]],[indices[i+2],indices[i]]]){if(!uv[a]||!uv[b]||![...uv[a],...uv[b]].every(Number.isFinite))throw Error('Invalid UV edge');const p=uv[a].map(n=>n.toFixed(7)).join(','),q=uv[b].map(n=>n.toFixed(7)).join(',');edges.set([p,q].sort().join('|'),[uv[a],uv[b]]);}}return [...edges.values()];}

function wireSVG(edges,width,height,image){const paths=edges.map(([a,b])=>`M${(a[0]*width).toFixed(3)} ${(a[1]*height).toFixed(3)}L${(b[0]*width).toFixed(3)} ${(b[1]*height).toFixed(3)}`).join('');return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}"><title>Unmodified glTF UV islands: v=0 at image top</title><defs><clipPath id="atlas"><rect width="${width}" height="${height}"/></clipPath></defs>${image?`<image width="${width}" height="${height}" href="${xml(image)}"/>`:`<rect width="${width}" height="${height}" fill="#f6f7f8"/>`}<path d="${paths}" clip-path="url(#atlas)" fill="none" stroke="${image?'#ff4ab0':'#233847'}" stroke-width="${Math.max(.5,width/2048)}" stroke-opacity=".72"/></svg>`;}
function wirePNG(edges,width,height){const pixels=Buffer.alloc(width*height*4,255);for(const [a,b]of edges){const x=a[0]*(width-1),y=a[1]*(height-1),dx=(b[0]-a[0])*(width-1),dy=(b[1]-a[1])*(height-1),steps=Math.min(65536,Math.ceil(Math.max(Math.abs(dx),Math.abs(dy))));for(let step=0;step<=steps;step++){const t=steps?step/steps:0,px=Math.round(x+dx*t),py=Math.round(y+dy*t);if(px<0||py<0||px>=width||py>=height)continue;const offset=(py*width+px)*4;pixels[offset]=35;pixels[offset+1]=56;pixels[offset+2]=71;}}const scanlines=Buffer.alloc(height*(width*4+1));for(let y=0;y<height;y++)pixels.copy(scanlines,y*(width*4+1)+1,y*width*4,(y+1)*width*4);const header=Buffer.alloc(13);header.writeUInt32BE(width);header.writeUInt32BE(height,4);header[8]=8;header[9]=6;return Buffer.concat([pngSignature,pngChunk('IHDR',header),pngChunk('IDAT',deflateSync(scanlines)),pngChunk('IEND',Buffer.alloc(0))]);}

export async function extractOriginalSkins({sourceDirectory=path.join(root,'games/freight-fire/assets/viewmodel-cs2'),outputDirectory=path.join(root,'artifacts/original-skins/source')}={}){
  await mkdir(outputDirectory,{recursive:true});const manifest={version:1,kind:'source-images-and-uv-guides',models:[]};
  for(const id of ORIGINAL_SKIN_SOURCES){const inputPath=path.join(sourceDirectory,id+'.glb'),source=await readFile(inputPath),glb=parseGLB(source),directory=path.join(outputDirectory,id);await mkdir(directory,{recursive:true});const model={id,inputPath,sha256:hash(source),images:[]};
    for(const [index,image]of (glb.json.images||[]).entries()){if(image.bufferView===undefined)throw Error('Only embedded source images are supported');const bytes=viewBytes(glb,image.bufferView),info=inspectImage(bytes),roles=imageRoles(glb.json,index),extension={'image/png':'png','image/jpeg':'jpg','image/webp':'webp'}[info.mimeType],imagePath=path.join(directory,`${String(index).padStart(2,'0')}-${safeName(image.name||'image')}.${extension}`);await writeFile(imagePath,bytes);const record={index,name:image.name,bufferView:image.bufferView,path:imagePath,...info,roles};
      if(roles.some(role=>role.role==='baseColor')){const edges=uvEdges(glb,roles),stem=path.join(directory,String(index).padStart(2,'0')+'-uv');record.guides={wire:stem+'-wire.svg',overlay:stem+'-overlay.svg',png:stem+'-wire.png',edges:edges.length};await writeFile(record.guides.wire,wireSVG(edges,info.width,info.height));await writeFile(record.guides.overlay,wireSVG(edges,info.width,info.height,`data:${info.mimeType};base64,${bytes.toString('base64')}`));await writeFile(record.guides.png,wirePNG(edges,info.width,info.height));}
      model.images.push(record);
    }manifest.models.push(model);
  }const manifestPath=path.join(outputDirectory,'manifest.json');await writeFile(manifestPath,JSON.stringify(manifest,null,2)+'\n');return {...manifest,manifestPath};
}

function encodeGLB(json,binary){const text=Buffer.from(JSON.stringify(json)),padded=Buffer.alloc(align4(text.length),32);text.copy(padded);const payload=Buffer.alloc(align4(binary.length));binary.copy(payload);const output=Buffer.alloc(28+padded.length+payload.length);output.writeUInt32LE(0x46546c67);output.writeUInt32LE(2,4);output.writeUInt32LE(output.length,8);output.writeUInt32LE(padded.length,12);output.writeUInt32LE(0x4e4f534a,16);padded.copy(output,20);output.writeUInt32LE(payload.length,20+padded.length);output.writeUInt32LE(0x004e4942,24+padded.length);payload.copy(output,28+padded.length);return output;}

/** Copy every non-image bufferView byte-for-byte; never re-export a mesh. */
export function repackOriginalSkin(input,{sourceSha256,replacements=[],materialNames={},allowResize=false}={}){
  const source=parseGLB(input);if(!sourceSha256||hash(source.bytes)!==sourceSha256)throw Error('Original GLB SHA-256 mismatch');
  if(!replacements.length)throw Error('At least one original baseColor image replacement is required');
  const json=structuredClone(source.json),changedViews=new Map(),changedImages=[],seen=new Set();
  for(const replacement of replacements){const index=replacement.imageIndex,image=json.images?.[index];if(!Number.isInteger(index)||!image||image.bufferView===undefined||seen.has(index))throw Error('Invalid or duplicate replacement image index');seen.add(index);
    const roles=imageRoles(source.json,index);if(!roles.length||roles.some(role=>role.role!=='baseColor'))throw Error('Replacement is restricted to baseColor-only images');
    const previous=inspectImage(viewBytes(source,image.bufferView)),bytes=Buffer.from(replacement.bytes),next=inspectImage(bytes);
    if(!allowResize&&(previous.width!==next.width||previous.height!==next.height))throw Error('Replacement image dimensions must match the original UV atlas');
    if(previous.width*next.height!==previous.height*next.width)throw Error('Replacement image aspect ratio must match the original UV atlas');
    if(!replacement.source||typeof replacement.source!=='object'||typeof replacement.source.provider!=='string'||!replacement.source.provider.trim())throw Error('Each generated image requires source provenance metadata with a provider');
    if(next.mimeType==='image/webp')throw Error('Convert WebP to PNG/JPEG before embedding; GLB core requires PNG/JPEG');
    const view=image.bufferView;if(changedViews.has(view))throw Error('Shared image bufferViews cannot be replaced independently');
    if((source.json.images||[]).some((item,other)=>other!==index&&item.bufferView===view))throw Error('Replacement would alter another embedded image');
    if((source.json.accessors||[]).some(accessor=>accessor.bufferView===view||accessor.sparse?.indices?.bufferView===view||accessor.sparse?.values?.bufferView===view))throw Error('Image bufferView is also used by mesh/animation data');
    changedViews.set(view,bytes);image.mimeType=next.mimeType;image.name=replacement.name||image.name;
    changedImages.push({imageIndex:index,bufferView:view,previous,next,source:replacement.source});
  }
  for(const [key,name]of Object.entries(materialNames)){const index=Number(key);if(!Number.isInteger(index)||!json.materials?.[index]||typeof name!=='string'||!name.trim())throw Error('Invalid material rename');json.materials[index].name=name;}
  const chunks=[];let offset=0;
  for(const [index,view]of json.bufferViews.entries()){const bytes=changedViews.get(index)||viewBytes(source,index);const padding=align4(offset)-offset;if(padding){chunks.push(Buffer.alloc(padding));offset+=padding;}view.byteOffset=offset;view.byteLength=bytes.length;chunks.push(bytes);offset+=bytes.length;}
  json.buffers[0].byteLength=offset;const output=encodeGLB(json,Buffer.concat(chunks)),comparison=compareSkinGeometry(input,output);
  if(!comparison.identical)throw Error('Repack changed protected mesh, skeleton or animation data');
  return {bytes:output,sha256:hash(output),changedImages,comparison};
}

export function compareSkinGeometry(input,output){
  const source=parseGLB(input),result=parseGLB(output),protectedKeys=['nodes','scenes','scene','skins','meshes','accessors','animations','textures','samplers'];
  const structure=Object.fromEntries(protectedKeys.map(key=>[key,JSON.stringify(source.json[key])===JSON.stringify(result.json[key])]));
  const imageViews=new Set((source.json.images||[]).map(image=>image.bufferView)),views=[];
  for(const [index,view]of (source.json.bufferViews||[]).entries())if(!imageViews.has(index))views.push({index,sourceSha256:hash(viewBytes(source,index)),outputSha256:hash(viewBytes(result,index)),sameMetadata:JSON.stringify({...view,byteOffset:0})===JSON.stringify({...result.json.bufferViews[index],byteOffset:0})});
  return {identical:Object.values(structure).every(Boolean)&&source.json.bufferViews.length===result.json.bufferViews.length&&views.every(view=>view.sourceSha256===view.outputSha256&&view.sameMetadata),structure,nonImageBufferViews:views,protectedAccessorCount:source.json.accessors?.length||0};
}

/** A recipe selects files and records image-generation provenance explicitly. */
export async function repackOriginalSkins(recipePath){
  const absolute=path.resolve(recipePath),directory=path.dirname(absolute),recipe=JSON.parse(await readFile(absolute,'utf8'));
  if(recipe.version!==1||!Array.isArray(recipe.models)||!recipe.models.length)throw Error('Expected original-skins recipe version 1 with models');
  const relative=value=>path.relative(root,value).replaceAll('\\','/');
  const lock={version:1,kind:'original-textures-on-original-rigs',recipe:path.basename(absolute),assets:[]},prepared=[];
  const originalPaths=new Set([...recipe.models.map(model=>path.resolve(directory,model.input)),...ORIGINAL_SKIN_SOURCES.map(id=>path.join(root,'games/freight-fire/assets/viewmodel-cs2',id+'.glb'))].map(value=>value.toLowerCase()));
  const outputPaths=new Set();
  for(const model of recipe.models){const inputPath=path.resolve(directory,model.input),outputPath=path.resolve(directory,model.output);if(originalPaths.has(outputPath.toLowerCase()))throw Error('Derived GLB must not overwrite an original');if(outputPaths.has(outputPath.toLowerCase()))throw Error('Duplicate derived GLB output');outputPaths.add(outputPath.toLowerCase());const input=await readFile(inputPath),replacements=[];
    for(const replacement of model.replacements||[]){const imagePath=path.resolve(directory,replacement.image);replacements.push({...replacement,bytes:await readFile(imagePath),source:{...replacement.source,file:replacement.image}});}
    const result=repackOriginalSkin(input,{sourceSha256:model.sourceSha256,replacements,materialNames:model.materialNames,allowResize:model.allowResize===true});prepared.push({outputPath,bytes:result.bytes});
    lock.assets.push({source:{path:relative(inputPath),bytes:input.length,sha256:hash(input)},output:{path:relative(outputPath),bytes:result.bytes.length,sha256:result.sha256},replacements:result.changedImages,geometryComparison:result.comparison,materialNames:model.materialNames||{}});
  }
  const lockPath=path.resolve(directory,recipe.lock||'original-skins.json');
  if(originalPaths.has(lockPath.toLowerCase())||outputPaths.has(lockPath.toLowerCase())||lockPath===absolute)throw Error('Lock output must not overwrite a source, derived GLB or recipe');
  for(const {outputPath,bytes}of prepared){await mkdir(path.dirname(outputPath),{recursive:true});await writeFile(outputPath,bytes);}
  await mkdir(path.dirname(lockPath),{recursive:true});await writeFile(lockPath,JSON.stringify(lock,null,2)+'\n');return {...lock,lockPath};
}

if(process.argv[1]&&pathToFileURL(path.resolve(process.argv[1])).href===import.meta.url){
  const [mode='extract',arg]=process.argv.slice(2);
  if(mode==='extract'){const result=await extractOriginalSkins(arg?{outputDirectory:path.resolve(arg)}:{});console.log(JSON.stringify({manifestPath:result.manifestPath,models:result.models.map(model=>({id:model.id,sha256:model.sha256,images:model.images.map(image=>({index:image.index,path:image.path,width:image.width,height:image.height,roles:image.roles,guides:image.guides}))}))},null,2));}
  else if(mode==='repack'&&arg){const result=await repackOriginalSkins(arg);console.log(JSON.stringify({lockPath:result.lockPath,assets:result.assets.map(asset=>({output:asset.output.path,sha256:asset.output.sha256,bytes:asset.output.bytes,geometryIdentical:asset.geometryComparison.identical}))},null,2));}
  else throw Error('Usage: node scripts/prepare-original-skins.mjs extract [outputDirectory] | repack <recipe.json>');
}
