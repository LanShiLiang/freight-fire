import * as THREE from './vendor/three.module.js';
import { bakeGroup } from './models.js';
import { classicSurfaceArt,loadSurfaceImage,declareSurfaceImage } from './surface-art.js';
import {declareAsset,loadAssetBuffer,trackTask} from './asset-loading.js';

export function declareEnvironmentAssets(MAP){
  if(MAP.geometry){declareAsset(new URL(MAP.geometry,import.meta.url),{label:'经典运输船结构',bytes:4326565,group:'environment'});for(const id of ['green_metal_rust','wooden_planks','metal_plate_02'])declareSurfaceImage(id+'_diff_1k.jpg');}
}

// Environment art only. Photographic PBR sources are CC0 and bundled locally.
// See assets/textures/environment/sources.json for every source and checksum.
const Y = new THREE.Vector3(0, 1, 0);
const cylinder = new THREE.CylinderGeometry(1, 1, 1, 12);
const sphere = new THREE.SphereGeometry(1, 10, 6);
const cube = new THREE.BoxGeometry(1, 1, 1);

function metresUV(geometry, metres = 2) {
  const p=geometry.getAttribute('position'),n=geometry.getAttribute('normal'),uv=geometry.getAttribute('uv');
  for(let i=0;i<p.count;i++) {
    const nx=Math.abs(n.getX(i)),ny=Math.abs(n.getY(i)),nz=Math.abs(n.getZ(i));
    let u,v;
    if(ny>=nx && ny>=nz){u=p.getX(i);v=p.getZ(i);}
    else if(nx>=nz){u=p.getZ(i)*(n.getX(i)>0?-1:1);v=p.getY(i);}
    else{u=p.getX(i)*(n.getZ(i)<0?-1:1);v=p.getY(i);}
    uv.setXY(i,u/metres+.5,v/metres+.5);
  }
  geometry.setAttribute('uv1',uv.clone());return geometry;
}
function mesh(g,geometry,mat,x,y,z,sx=1,sy=1,sz=1) {
  const obj=new THREE.Mesh(geometry,mat);obj.position.set(x,y,z);obj.scale.set(sx,sy,sz);
  obj.castShadow=true;obj.receiveShadow=true;g.add(obj);return obj;
}
function box(g,m,x,y,z,w,h,d,metres=2) {return mesh(g,metresUV(new THREE.BoxGeometry(w,h,d),metres),m,x,y,z);}
function smallBox(g,m,x,y,z,w,h,d) {return mesh(g,cube,m,x,y,z,w,h,d);}
function ball(g,m,x,y,z,r,sy=r,sz=r) {return mesh(g,sphere,m,x,y,z,r,sy,sz);}
function pipe(g,m,from,to,r=.035) {
  const a=new THREE.Vector3(...from),b=new THREE.Vector3(...to),dir=b.clone().sub(a);
  const obj=mesh(g,cylinder,m,...a.clone().add(b).multiplyScalar(.5).toArray(),r,dir.length(),r);
  obj.quaternion.setFromUnitVectors(Y,dir.normalize());return obj;
}
function roundedPath(w,h,r) {
  const s=new THREE.Shape(),x=-w/2,y=-h/2;
  s.moveTo(x+r,y);s.lineTo(x+w-r,y);s.quadraticCurveTo(x+w,y,x+w,y+r);
  s.lineTo(x+w,y+h-r);s.quadraticCurveTo(x+w,y+h,x+w-r,y+h);
  s.lineTo(x+r,y+h);s.quadraticCurveTo(x,y+h,x,y+h-r);
  s.lineTo(x,y+r);s.quadraticCurveTo(x,y,x+r,y);return s;
}
function bevel(g,m,x,y,z,w,h,d,r=.05) {
  const geometry=new THREE.ExtrudeGeometry(roundedPath(w,h,r),{depth:d,bevelEnabled:true,bevelSegments:2,bevelSize:.012,bevelThickness:.012,steps:1,curveSegments:4});
  geometry.translate(0,0,-d/2);metresUV(geometry,2);return mesh(g,geometry,m,x,y,z);
}
function ring(g,m,x,y,z,outerW,outerH,innerW,innerH,depth,r=.20) {
  const s=roundedPath(outerW,outerH,r),hole=roundedPath(innerW,innerH,Math.max(.04,r-.08));
  s.holes.push(new THREE.Path(hole.getPoints(8)));
  const geometry=new THREE.ExtrudeGeometry(s,{depth,bevelEnabled:true,bevelSegments:2,bevelSize:.018,bevelThickness:.018,curveSegments:6});
  geometry.translate(0,0,-depth/2);metresUV(geometry,2);return mesh(g,geometry,m,x,y,z);
}
function signTexture(text,subtitle,color='#303c40') {
  const canvas=document.createElement('canvas');canvas.width=512;canvas.height=128;const c=canvas.getContext('2d');
  c.clearRect(0,0,512,128);c.fillStyle=color;c.font='bold 55px Arial';c.fillText(text,18,67);c.font='18px Arial';c.fillText(subtitle,20,105);
  const tex=new THREE.CanvasTexture(canvas);tex.colorSpace=THREE.SRGBColorSpace;return tex;
}
function sign(g,text,subtitle,x,y,z,w,h,yaw=0,color) {
  const mat=new THREE.MeshBasicMaterial({map:signTexture(text,subtitle,color),transparent:true,depthWrite:false,polygonOffset:true,polygonOffsetFactor:-2});
  const obj=new THREE.Mesh(new THREE.PlaneGeometry(w,h),mat);obj.position.set(x,y,z);obj.rotation.y=yaw;g.add(obj);return obj;
}
function contactShadow(g,x,z,w,d,strength=.29) {
  const mat=new THREE.ShaderMaterial({transparent:true,depthWrite:false,polygonOffset:true,polygonOffsetFactor:-1,
    uniforms:{strength:{value:strength}},vertexShader:'varying vec2 vUV;void main(){vUV=uv;gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.);}',
    fragmentShader:'uniform float strength;varying vec2 vUV;void main(){vec2 p=abs(vUV-.5)*2.;float a=(1.-smoothstep(.65,1.,max(p.x,p.y)))*strength;gl_FragColor=vec4(.035,.042,.045,a);}' });
  const obj=new THREE.Mesh(new THREE.PlaneGeometry(w+.90,d+.90),mat);obj.rotation.x=-Math.PI/2;obj.position.set(x,.015,z);g.add(obj);
}

function createMaterials() {
  const pending=[],cache=new Map();
  const tex=(filename,color=false)=>{
    if(cache.has(filename))return cache.get(filename);
    const texture=new THREE.Texture();
    pending.push(loadSurfaceImage(filename).then(image=>{texture.image=image;texture.needsUpdate=true;return texture;}));
    texture.wrapS=texture.wrapT=THREE.RepeatWrapping;texture.anisotropy=8;texture.colorSpace=color?THREE.SRGBColorSpace:THREE.NoColorSpace;cache.set(filename,texture);return texture;
  };
  const pbr=(asset,color,normal=.5,metal=.3)=>new THREE.MeshStandardMaterial({
    map:tex(`${asset}_diff_1k.jpg`,true),normalMap:tex(`${asset}_nor_gl_1k.jpg`),normalScale:new THREE.Vector2(normal,normal),
    roughnessMap:tex(`${asset}_arm_1k.jpg`),aoMap:tex(`${asset}_arm_1k.jpg`),metalnessMap:tex(`${asset}_arm_1k.jpg`),
    aoMapIntensity:.65,color,roughness:1,metalness:metal,
  });
  const plain=(color,roughness=.72,metalness=.25)=>new THREE.MeshStandardMaterial({color,roughness,metalness});
  const deck=pbr('metal_plate_02','#b9bdc1',.36,.38);
  // Grey deck coating retains the photograph's wear without reading as soil.
  deck.onBeforeCompile=shader=>{shader.fragmentShader=shader.fragmentShader.replace('#include <map_fragment>',`#ifdef USE_MAP
    vec3 photo=texture2D(map,vMapUv).rgb;float wear=dot(photo,vec3(.2126,.7152,.0722));
    diffuseColor.rgb*=vec3(.24,.26,.27)*(.72+.76*sqrt(max(wear,0.0)));
    #endif`);};deck.customProgramCacheKey=()=> 'painted-steel-deck-v2';
  // Ship plate joins are geometry, not a repeating masonry-looking photograph.
  const white=new THREE.MeshStandardMaterial({color:'#c8d0cf',normalMap:tex('green_metal_rust_nor_gl_1k.jpg'),
    normalScale:new THREE.Vector2(.065,.065),roughnessMap:tex('green_metal_rust_arm_1k.jpg'),roughness:.94,metalness:.12});
  const green=pbr('green_metal_rust','#f1f0d9',.56,.16);
  const camo=green.clone(),camoTexture=tex('camouflage.svg',true);
  camo.onBeforeCompile=shader=>{shader.uniforms.maritimeCamo={value:camoTexture};shader.fragmentShader='uniform sampler2D maritimeCamo;\n'+shader.fragmentShader;shader.fragmentShader=shader.fragmentShader.replace('#include <map_fragment>',`#ifdef USE_MAP
    vec4 metalColor=texture2D(map,vMapUv);vec3 paint=texture2D(maritimeCamo,vMapUv*.68).rgb;
    diffuseColor.rgb*=metalColor.rgb*mix(vec3(1.0),paint*2.35,.56);
    #endif`);};camo.customProgramCacheKey=()=> 'maritime-camouflage-pbr-v2';
  const wood=pbr('wooden_planks','#dac19b',.70,0);
  const woodFrame=wood.clone();woodFrame.color.set('#a68c68');
  const woodTop=wood.clone();woodTop.normalScale.set(.92,.92);woodTop.polygonOffset=true;woodTop.polygonOffsetFactor=-1;
  woodTop.onBeforeCompile=shader=>{shader.fragmentShader=shader.fragmentShader.replace('#include <map_fragment>',`#ifdef USE_MAP
    vec3 timber=texture2D(map,vMapUv).rgb;diffuseColor.rgb*=max(vec3(.025),timber*1.65-vec3(.075));
    #endif`);};woodTop.customProgramCacheKey=()=> 'crate-roof-grain-v2';
  const m={deck,white,green,camo,wood,woodFrame,woodTop,steel:plain('#53636a',.51,.55),dark:plain('#29393f',.82,.15),
    seam:plain('#353f42',.88,.22),yellow:plain('#b6a45e',.76,.12),rubber:plain('#293332',.96,0),bolt:plain('#9caaa9',.47,.68),
    blue:plain('#467184',.81,.14),red:plain('#8d4741',.81,.14),glass:plain('#4f6b70',.25,.42),
    lamp:new THREE.MeshStandardMaterial({color:'#dbddc7',emissive:'#d3d9b1',emissiveIntensity:.8,roughness:.7}),rust:plain('#6a4f39',.93,.18)};
  return {m,pending};
}

function cargoBox(staticG,details,item,m,index) {
  const {x,y=0,z,w,h,d}=item,paint=item.skin==='white'?m.white:item.skin==='blue'?m.blue:m.green;
  box(staticG,paint,x,y+h/2,z,w,h,d,2.5);
  for(const side of [-1,1]) {
    for(let zz=z-d/2+.17;zz<z+d/2;zz+=.29) bevel(staticG,paint,x+side*(w/2+.015),y+h/2,zz,.038,h-.11,.067,.009);
    for(const yy of [.055,h-.055]) smallBox(staticG,m.steel,x+side*(w/2+.028),y+yy,z,.065,.085,d+.04);
    for(const zz of [z-d/2,z+d/2]) bevel(staticG,m.steel,x+side*w/2,y+h/2,zz,.11,h+.025,.14,.018);
  }
  for(let xx=x-w/2+.18;xx<x+w/2;xx+=.31) smallBox(staticG,paint,xx,y+h+.01,z,.045,.026,d-.15);
  // One end has two broad inset door skins and separate hinge/locking hardware.
  const face=z+d/2+.038;
  for(const side of [-1,1]) {
    bevel(staticG,paint,x+side*w*.25,y+h*.5,face,w*.485,h-.10,.07,.035);
    for(const xx of [x+side*w*.16,x+side*w*.35]) {
      pipe(staticG,m.bolt,[xx,y+.15,face+.068],[xx,y+h-.15,face+.068],.018);
      for(const yy of [.28,h/2,h-.28]) smallBox(staticG,m.steel,xx,y+yy,face+.078,.105,.13,.06);
      smallBox(staticG,m.bolt,xx,y+1.05,face+.106,.20,.035,.03);
    }
    for(const yy of [.39,h/2,h-.39]) {smallBox(staticG,m.steel,x+side*(w/2-.015),y+yy,face,.12,.15,.11);ball(staticG,m.bolt,x+side*(w/2-.012),y+yy,face+.072,.019);}
  }
  sign(details,`FRT ${420+17*index}`,'22G1 / 30,480 KG',x,y+h*.78,face+.12,w*.55,.43,0,'#d2d4c3');
  sign(details,`MFC ${420+17*index}`,'MARITIME FREIGHT COMPANY',x-w/2-.045,y+h*.75,z+.5,Math.min(d*.55,3.7),.55,-Math.PI/2,'#c5c8b7');
  contactShadow(details,x,z,w,d,.30);
}
function tarpCargo(g, details, item, m) {
  const {x,y=0,z,w,h,d}=item;
  box(g,m.wood,x,y+.17,z,w,.34,d,2.3);
  bevel(g,m.green,x,y+(h+.34)/2,z,w,h-.34,d,.045);
  for(const side of [-1,1]) {
    for(let zz=z-d/2+.45;zz<z+d/2;zz+=1.25) {
      smallBox(g,m.dark,x+side*(w/2+.02),y+h/2,zz,.026,h-.15,.035);
      smallBox(g,m.steel,x+side*(w/2+.035),y+.48,zz,.043,.14,.095);
      smallBox(g,m.dark,x,y+h+.015,zz,w,.025,.035);
    }
    for(const yy of [.35,h*.52,h-.08])smallBox(g,m.woodFrame,x+side*(w/2+.015),y+yy,z,.024,.021,d);
    sign(details,'A-01','CAUTION / DRY CARGO',x+side*(w/2+.044),y+h*.67,z,d*.53,.57,side*Math.PI/2,'#d0cfb0');
  }
  contactShadow(details,x,z,w,d,.30);
}
function woodenCrate(staticG,details,item,m) {
  const {x,y=0,z,w,h,d}=item;
  box(staticG,m.wood,x,y+h/2,z,w,h,d,2.3);
  for(const side of [-1,1]) {
    for(const xx of [x-w*.42,x+w*.42]) box(staticG,m.woodFrame,xx,y+h/2,z+side*(d/2+.022),.092,h,.052,1.2);
    for(const yy of [.065,h-.065]) box(staticG,m.woodFrame,x,y+yy,z+side*(d/2+.047),w,.095,.072,1.2);
    for(const zz of [z-d*.42,z+d*.42]) box(staticG,m.woodFrame,x+side*(w/2+.021),y+h/2,zz,.056,h,.094,1.2);
    for(const xx of [x-w*.43,x+w*.43])for(const yy of [.075,h-.075])ball(staticG,m.bolt,xx,y+yy,z+side*(d/2+.093),.014);
  }
  // The timber grain is metre-scaled across all six faces; framing remains proud.
  const roofGeometry=new THREE.PlaneGeometry(w-.10,d-.10);roofGeometry.rotateX(-Math.PI/2);metresUV(roofGeometry,2.3);
  mesh(staticG,roofGeometry,m.woodTop,x,y+h+.004,z);
  for(let zz=z-d/2+.25;zz<z+d/2-.08;zz+=.25)smallBox(staticG,m.woodFrame,x,y+h+.007,zz,w-.10,.004,.006);
  for(const xx of [x-w*.43,x+w*.43])box(staticG,m.woodFrame,xx,y+h+.027,z,.085,.054,d,1.2);
  sign(details,'↑  ↑','DRY CARGO',x,y+h*.53,z+d/2+.065,w*.44,h*.39,0,'#504a39');
  contactShadow(details,x,z,w,d,.28);
}

function cabin(staticG,details,MAP,m,end) {
  const b=MAP.bounds,front=end*35.5,back=end*41.2,opening=3.6,edge=b.maxX;
  const facing=end>0?Math.PI:0,face=front-end*.25;
  const cabinWalls=MAP.boxes.filter(x=>x.kind==='cabin-wall'||x.kind==='cabin-lintel');
  if(!cabinWalls.length) {
    // Fallback matches the agreed shared collision dimensions.
    for(const x of [-8.9,8.9])box(staticG,m.white,x,3.1,front,11.4,6.2,.42,6);
    box(staticG,m.white,0,4.5,front,6.4,3.4,.42,6);
    box(staticG,m.white,0,3.1,back,edge*2+1,6.2,.34,6);
    for(const x of [-14.7,14.7])box(staticG,m.white,x,3.1,end*38.35,.32,6.2,6.2,6);
  }
  box(staticG,m.white,0,6.17,end*38.35,edge*2+1,.25,6.5,6);
  // Paint band wraps the cabin in the two teams' muted maritime identifiers.
  const band=end>0?m.blue:m.red;
  for(const x of [-8.9,8.9])box(staticG,band,x,1.02,face,11.3,.24,.035,5);
  box(staticG,band,0,1.02,back-end*.20,edge*2,.24,.025,5);
  for(const x of [-14.52,14.52])box(staticG,band,x,1.02,end*38.3,.025,.24,5.8,5);
  // A substantial rounded watertight opening, rubber seal and parked door leaves.
  ring(staticG,m.steel,0,1.405,face-end*.022,4.00,3.13,3.61,2.81,.22,.22);
  ring(staticG,m.rubber,0,1.405,face-end*.16,3.69,2.91,3.60,2.81,.035,.16);
  for(const side of [-1,1]) {
    const dx=side*2.83,dz=face-end*.19;
    bevel(staticG,m.white,dx,1.34,dz,1.90,2.63,.17,.18);
    bevel(staticG,m.white,dx,1.36,dz-end*.11,1.66,2.36,.025,.16);
    for(const yy of [.42,1.35,2.25]) {
      pipe(staticG,m.bolt,[side*1.88,yy-.10,dz],[side*1.88,yy+.10,dz],.045);
      smallBox(staticG,m.steel,side*1.94,yy,dz-end*.035,.14,.075,.055);
    }
    pipe(staticG,m.steel,[dx,1.25,dz-end*.13],[dx,1.25,dz-end*.25],.025);
    pipe(staticG,m.bolt,[dx-.14,1.25,dz-end*.25],[dx+.14,1.25,dz-end*.25],.022);
    const wheel=new THREE.Mesh(new THREE.TorusGeometry(.17,.025,7,14),m.steel);wheel.position.set(dx+.62,1.34,dz-end*.16);wheel.castShadow=true;staticG.add(wheel);
    for(const xx of [dx-1.34,dx+1.34])for(const yy of [.24,2.43])ball(staticG,m.bolt,xx,yy,dz-end*.12,.016);
    sign(details,side<0?'01':'02','WATERTIGHT DOOR',dx,2.04,dz-end*.145,1.12,.24,facing,'#687575');
  }
  for(let x=-14;x<=14;x+=2.0) {
    const bottom=Math.abs(x)<1.82?2.83:.10;
    smallBox(staticG,m.seam,x,(6.02+bottom)/2,face,.008,6.02-bottom,.012);
    for(const y of [3.01,3.65,4.30,4.95,5.62])ball(staticG,m.bolt,x,y,face-end*.03,.018);
  }
  for(const y of [2.95,5.73])smallBox(staticG,m.seam,0,y,face,edge*2,.013,.025);
  for(const y of [.48,2.12])for(const x of [-8.9,8.9])smallBox(staticG,m.seam,x,y,face,11.3,.009,.022);
  for(let x=-12.8;x<=13;x+=3.2) {
    smallBox(staticG,m.seam,x,3.0,back-end*.238,.008,5.82,.012);
    for(const y of [.3,2.28,4.5,5.78])ball(staticG,m.bolt,x,y,back-end*.247,.014);
  }
  for(const y of [2.28,4.5])smallBox(staticG,m.seam,0,y,back-end*.238,edge*2,.009,.012);
  // Overhead cable routes, drain plumbing and photographed wear on white metal.
  pipe(staticG,m.steel,[-13.5,4.87,face-end*.10],[13.5,4.87,face-end*.10],.036);
  pipe(staticG,m.white,[-12.8,.20,face-end*.15],[-12.8,5.15,face-end*.15],.072);
  for(const y of [.48,1.7,3.0,4.3]){smallBox(staticG,m.steel,-12.8,y,face-end*.11,.20,.057,.16);ball(staticG,m.rust,-12.8,y,face-end*.19,.035,.055,.025);}
  for(const x of [-10.4,0,10.4]) {
    bevel(staticG,m.steel,x,3.65,face-end*.19,.69,.25,.12,.04);
    bevel(staticG,m.lamp,x,3.64,face-end*.27,.54,.14,.025,.025);
    for(const xx of [x-.19,x,x+.19])pipe(staticG,m.steel,[xx,3.54,face-end*.29],[xx,3.74,face-end*.29],.008);
  }
  for(const x of [-9.4,9.4]) {
    bevel(staticG,m.steel,x,4.30,face-end*.13,1.9,.69,.10,.04);
    for(let yy=4.03;yy<4.59;yy+=.081)box(staticG,m.white,x,yy,face-end*.20,1.74,.045,.06,2);
  }
  sign(details,end>0?'SOUTH HOLD':'NORTH HOLD','MFC 07 / CREW ACCESS',0,4.28,face-end*.035,4.0,.62,facing,'#4b6068');
  // Upper maintenance walkway is decorative; every support is above headroom.
  box(staticG,m.deck,0,5.09,front-end*1.16,edge*2+1,.17,2.20,3.8);
  smallBox(staticG,m.steel,0,5.02,front-end*2.31,edge*2+1,.26,.10);
  for(let x=-14;x<14.5;x+=1.65) {
    pipe(staticG,m.white,[x,5.13,front-end*2.24],[x,6.18,front-end*2.24],.028);
    smallBox(staticG,m.steel,x,5.14,front-end*2.24,.13,.04,.13);
  }
  for(const y of [5.52,6.17])pipe(staticG,m.white,[-14.5,y,front-end*2.24],[14.5,y,front-end*2.24],.032);
  // Underside stiffeners and dark ceiling make the entrance read as an interior.
  for(const x of [-11,-6,0,6,11])box(staticG,m.dark,x,5.91,end*38.2,.16,.28,5.9,2);
  box(staticG,m.dark,0,6.025,end*38.3,edge*2-.1,.02,6.1,6);
  contactShadow(details,0,front-end*.22,opening+1,1.8,.28);
}

export function makeEnvironmentV2(MAP) {
  if(MAP.geometry)return makeClassicEnvironment(MAP);
  const staticG=new THREE.Group(),details=new THREE.Group(),{m,pending}=createMaterials(),b=MAP.bounds;
  const width=b.maxX-b.minX,length=b.maxZ-b.minZ;
  // The top deck is built from MAP's tiles, including open passage stairwells.
  box(staticG,m.deck,0,-2.50,0,width+.15,.20,length+.15,3.8);
  box(staticG,m.dark,0,-2.1,0,width+1.65,3.4,length+3.0,5);
  box(staticG,m.red,0,-3.14,0,width+1.67,1.45,length+3.01,5);
  // Real plate-sized UVs, welding seams, scupper drains and sparse loading paint.
  for(let z=b.minZ;z<=b.maxZ;z+=3.0)smallBox(staticG,m.seam,0,.006,z,width,.008,.012);
  for(const x of [-.76,-.38,0,.38,.76].map(f=>f*b.maxX))smallBox(staticG,m.seam,x,.006,0,.012,.008,length);
  for(const x of [-.88,.88].map(f=>f*b.maxX)) {
    for(let z=-length*.40;z<length*.40;z+=4.2)box(staticG,m.yellow,x,.010,z,.070,.008,1.45,2);
    smallBox(staticG,m.steel,x<0?b.minX-.43:b.maxX+.43,.08,0,.30,.16,length+1.2);
    for(let z=b.minZ;z<b.maxZ;z+=2.30)for(let dz=-.22;dz<=.22;dz+=.075)smallBox(staticG,m.dark,x<0?b.minX-.43:b.maxX+.43,.171,z+dz,.27,.008,.025);
  }
  for(const side of [-1,1]) {
    const x=side*(b.maxX+.50);
    for(const y of [.62,1.10])pipe(staticG,m.white,[x,y,b.minZ],[x,y,b.maxZ],.032);
    for(let z=b.minZ;z<=b.maxZ;z+=2.55){pipe(staticG,m.white,[x,.16,z],[x,1.1,z],.028);smallBox(staticG,m.steel,x,.15,z,.18,.05,.18);}
    for(const z of [-.34,.34].map(f=>f*length)) {
      pipe(staticG,m.steel,[x,.15,z],[x,.70,z],.15);pipe(staticG,m.steel,[x-.3,.67,z],[x+.3,.67,z],.075);
      for(let i=0;i<3;i++) {const torus=new THREE.Mesh(new THREE.TorusGeometry(.22,.028,6,15),m.rubber);torus.rotation.x=Math.PI/2;torus.position.set(x,.17+i*.045,z+.7);staticG.add(torus);}
    }
  }
  let index=0;
  for(const item of MAP.boxes) {
    // Art and physical volumes share the same centre, dimensions and rotation.
    const local=new THREE.Group(),labels=new THREE.Group();
    const centred={...item,x:0,z:0};
    if(item.kind==='deck'||item.kind==='tunnel-step')box(local,m.deck,0,item.y+item.h/2,0,item.w,item.h,item.d,3.8);
    else if(item.kind==='tunnel-wall')box(local,m.white,0,item.y+item.h/2,0,item.w,item.h,item.d,3);
    else if(item.kind==='container')cargoBox(local,labels,centred,m,index++);
    else if(item.kind==='cargo')tarpCargo(local,labels,centred,m);
    else if(item.kind==='crate')woodenCrate(local,labels,centred,m);
    else if(item.kind==='container-wall') {
      box(local,m.green,0,item.y+item.h/2,0,item.w,item.h,item.d,2.5);
      for(let zz=-item.d/2+.15;zz<item.d/2;zz+=.29)smallBox(local,m.green,-Math.sign(item.x)*(item.w/2+.015),item.y+item.h/2,zz,.06,item.h-.10,.067);
    } else if(item.kind==='tunnel-roof'||item.kind==='platform')box(local,m.white,0,item.y+item.h/2,0,item.w,item.h,item.d,3);
    else box(local,m.white,0,item.y+item.h/2,0,item.w,item.h,item.d,6);
    local.position.set(item.x,0,item.z);local.rotation.y=item.yaw||0;
    labels.position.copy(local.position);labels.rotation.copy(local.rotation);staticG.add(local);details.add(labels);
  }
  const cosmetics=new THREE.Group(),cosmeticDetails=new THREE.Group(),scale=MAP.cosmeticScale||1;
  const oldMap={...MAP,bounds:Object.fromEntries(Object.entries(b).map(([k,v])=>[k,v/scale]))};
  for(const end of [-1,1])cabin(cosmetics,cosmeticDetails,oldMap,m,end);
  for(const item of MAP.boxes.filter(b=>b.id.endsWith('crane-crate'))){
    for(const dx of [-item.w*.34,item.w*.34])pipe(staticG,m.dark,[item.x+dx,2.17,item.z],[item.x+dx,8.5,item.z],.014);
  }
  // A shipboard boom with a counterweight, bracing, pulleys and hanging rigging.
  for(const end of [-1,1]) {
    // The classic cranes start at opposite ship ends and overlap near the
    // middle; neither truss runs the full length of both container rows.
    const x=end*16.4,z=(276-(end===-1?33:525))*.22;
    const span=(end===-1?[34,337]:[255,525]).map(px=>(276-px)*.22).sort((a,b)=>a-b);
    pipe(cosmetics,m.steel,[x,-1,z],[x,9.3,z],.32);
    pipe(cosmetics,m.yellow,[x,8.8,z],[x-end*6.8,12.0,z],.20);
    pipe(cosmetics,m.steel,[x,5.9,z],[x-end*5.8,11.5,z],.09);
    box(cosmetics,m.steel,x+end*.70,8.0,z,1.7,1.1,1.45,2);
    for(const dz of [-.19,.19])pipe(cosmetics,m.dark,[x-end*6.8,11.95,z+dz],[x-end*6.8,5.9,z+dz],.016);
    const pulley=new THREE.Mesh(new THREE.TorusGeometry(.17,.054,7,14),m.steel);pulley.position.set(x-end*6.8,11.83,z);cosmetics.add(pulley);
    bevel(cosmetics,m.steel,x-end*6.8,5.83,z,.49,.23,.35,.045);
    // The characteristic yellow longitudinal crane truss above the side rows.
    for(const xx of [x-1.0,x+1.0]) {
      pipe(cosmetics,m.yellow,[xx,8.5,span[0]],[xx,8.5,span[1]],.065);
      pipe(cosmetics,m.yellow,[xx,9.6,span[0]],[xx,9.6,span[1]],.065);
      for(let zz=span[0];zz<span[1];zz+=3.1)pipe(cosmetics,m.yellow,[xx,8.5,zz],[xx,9.6,Math.min(span[1],zz+3.1)],.038);
    }
  }
  // Cabin roof helicopter, an environmental landmark in the classic reference.
  const heli=new THREE.Group();
  ball(heli,m.dark,0,0,0,1.05,.78,2.25);ball(heli,m.glass,0,.12,-1.48,.82,.56,.89);
  pipe(heli,m.dark,[0,.05,1.6],[0,.48,5.1],.18);
  smallBox(heli,m.dark,0,.62,4.8,.13,1.45,.8);
  pipe(heli,m.steel,[0,.5,0],[0,1.45,0],.06);
  for(const angle of [0,Math.PI/2]){const rotor=smallBox(heli,m.dark,0,1.45,0,10.0,.035,.14);rotor.rotation.y=angle;}
  for(const xx of [-.8,.8]){pipe(heli,m.steel,[xx,-.48,-1.3],[xx,-.96,-1.3],.045);pipe(heli,m.steel,[xx,-.96,-1.5],[xx,-.96,1.5],.055);}
  heli.position.set(0,7.15,38.0);cosmetics.add(heli);
  cosmetics.scale.set(scale,1,scale);cosmeticDetails.scale.copy(cosmetics.scale);staticG.add(cosmetics);details.add(cosmeticDetails);
  const output=bakeGroup(staticG);output.name='Freight environment / photographic PBR';output.add(details);
  output.userData.ready=Promise.all(pending);output.userData.textureFiles=[...new Set(['metal_plate_02','green_metal_rust','wooden_planks'].flatMap(id=>['diff','nor_gl','arm'].map(map=>`${id}_${map}_1k.jpg`)))];
  output.userData.collisionNotes='Container/crate dimensions match MAP. Ship walls use cabin-wall/cabin-lintel collision volumes; maintenance walkway is decorative above player headroom.';
  return output;
}

function makeClassicEnvironment(MAP){
  const group=new THREE.Group(),pending=[],m={dark:new THREE.MeshStandardMaterial({color:'#29393f',roughness:.82,metalness:.15}),steel:new THREE.MeshStandardMaterial({color:'#53636a',roughness:.51,metalness:.55})};
  const fenceCanvas=document.createElement('canvas');fenceCanvas.width=fenceCanvas.height=128;
  const c=fenceCanvas.getContext('2d');c.strokeStyle='#82969a';c.lineWidth=2;
  for(let x=-128;x<=256;x+=32){c.beginPath();c.moveTo(x,0);c.lineTo(x+128,128);c.stroke();c.beginPath();c.moveTo(x,0);c.lineTo(x-128,128);c.stroke();}
  const fenceMap=new THREE.CanvasTexture(fenceCanvas);fenceMap.wrapS=fenceMap.wrapT=THREE.RepeatWrapping;
  const fence=new THREE.MeshStandardMaterial({map:fenceMap,alphaTest:.3,transparent:false,side:THREE.DoubleSide,roughness:.7,metalness:.25});
  const category=name=>{
    if(name.includes('metalfence'))return fence;
    const key=name.split('/').pop();
    if(key==='y_00002')return m.steel;
    return m.dark;
  };
  const geometryURL=new URL(MAP.geometry,import.meta.url),bytes=4326565;
  declareAsset(geometryURL,{label:'经典运输船结构',bytes,group:'environment'});
  const geometryData=loadAssetBuffer(geometryURL,{label:'经典运输船结构',bytes,group:'environment',deferReady:true}).then(buffer=>
    trackTask(geometryURL,{label:'经典运输船结构',group:'environment',phase:'parse'},()=>JSON.parse(new TextDecoder().decode(buffer))));
  const geometryReady=Promise.all([geometryData,classicSurfaceArt()]).then(([groups,art])=>trackTask(new URL('./assets/maps/classic-geometry.json?assembly',import.meta.url),{label:'构建运输船表面',group:'environment',phase:'prepare'},()=>{
    const parts=new THREE.Group();
    for(const [name,data]of Object.entries(groups)){
      const geometry=new THREE.BufferGeometry();
      geometry.setAttribute('position',new THREE.Float32BufferAttribute(data.positions,3));geometry.setAttribute('normal',new THREE.Float32BufferAttribute(data.normals,3));
      geometry.setAttribute('uv',new THREE.Float32BufferAttribute(data.uvs||new Float32Array(data.positions.length/3*2),2));if(!data.uvs)metresUV(geometry,2.6);
      const dark=['texture_100','texture_92','m_00025','w_00006','fuslo','verde','y_00002'].includes(name.split('/').pop());
      const obj=new THREE.Mesh(geometry,name.includes('metalfence')||dark?category(name):art.material(name));obj.castShadow=!name.includes('metalfence');obj.receiveShadow=true;parts.add(obj);
    }
    group.add(bakeGroup(parts));
  })).catch(error=>{console.warn('运输船环境准备失败',error);throw error;});
  group.name='Classic Transport Ship / shared structural geometry';
  group.userData.ready=Promise.all([...pending,geometryReady]);
  group.userData.collisionNotes='Visible faces and convex collision planes come from the same structural reference, including both cabin doors and the side passages.';
  return group;
}
