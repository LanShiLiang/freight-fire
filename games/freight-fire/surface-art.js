import * as THREE from './vendor/three.module.js';
import {declareAsset,loadAssetBuffer,trackTask} from './asset-loading.js';

// Painted in face UV space: ribs, doors, timber frames and plate joints stay
// attached to their original faces. Small CC0 photographs supply material grain.
const ROOT=new URL('./assets/textures/environment/',import.meta.url);
// Uncompressed bytes of the bundled photographs. HTTP Content-Length may be
// the gzip transfer size, so it is not a reliable texture progress denominator.
const IMAGE_BYTES={
 'camouflage.svg':945,
 'green_metal_rust_diff_1k.jpg':212088,'green_metal_rust_nor_gl_1k.jpg':121379,'green_metal_rust_arm_1k.jpg':108674,
 'wooden_planks_diff_1k.jpg':489587,'wooden_planks_nor_gl_1k.jpg':705118,'wooden_planks_arm_1k.jpg':468546,
 'metal_plate_02_diff_1k.jpg':625917,'metal_plate_02_nor_gl_1k.jpg':183264,'metal_plate_02_arm_1k.jpg':1075839,
};
const images=new Map();
export function declareSurfaceImage(name){return declareAsset(new URL(name,ROOT),{label:'运输船贴图 · '+name,bytes:IMAGE_BYTES[name],group:'environment'});}
export function loadSurfaceImage(name){
 const cached=images.get(name);if(cached)return cached;
 const url=new URL(name,ROOT),record=declareSurfaceImage(name);
 const pending=loadAssetBuffer(url,{label:record.label,bytes:IMAGE_BYTES[name],group:'environment',deferReady:true}).then(buffer=>
  trackTask(url,{label:record.label,group:'environment',phase:'decode',timeoutMs:20000},()=>new Promise((resolve,reject)=>{
   const image=new Image(),objectURL=URL.createObjectURL(new Blob([buffer],{type:name.endsWith('.svg')?'image/svg+xml':'image/jpeg'}));
   let settled=false;
   const finish=(error)=>{if(settled)return;settled=true;clearTimeout(timer);image.onload=image.onerror=null;URL.revokeObjectURL(objectURL);if(error){image.src='';reject(error);}else resolve(image);};
   const timer=setTimeout(()=>finish(new Error('贴图解码超过 20 秒，请重试')),20000);
   image.onload=()=>finish();image.onerror=()=>finish(new Error('贴图无法解码'));image.src=objectURL;
  }))
 ).catch(error=>{if(images.get(name)===pending)images.delete(name);console.warn('运输船贴图加载失败',error);throw error;});
 images.set(name,pending);return pending;
}
const N=1024;
function canvas(){const a=document.createElement('canvas');a.width=a.height=N;return a;}
function texture(a,color=false){const t=new THREE.CanvasTexture(a);t.wrapS=t.wrapT=THREE.RepeatWrapping;t.anisotropy=8;t.colorSpace=color?THREE.SRGBColorSpace:THREE.NoColorSpace;return t;}
function rng(seed){return()=>{seed=(Math.imul(seed,1664525)+1013904223)>>>0;return seed/4294967296;};}
function line(c,color,width,x,y,xx,yy){c.strokeStyle=color;c.lineWidth=width;c.beginPath();c.moveTo(x,y);c.lineTo(xx,yy);c.stroke();}
function bolt(c,x,y,r=5){c.fillStyle='#253238';c.beginPath();c.arc(x,y,r+2,0,Math.PI*2);c.fill();c.fillStyle='#a4aaa1';c.beginPath();c.arc(x-1,y-1,r,0,Math.PI*2);c.fill();line(c,'#5b625b',1,x-r/2,y,x+r/2,y);}
function frame(c,x,y,w,h,width=18){c.fillStyle='rgba(13,23,23,.55)';c.fillRect(x-3,y-3,w+6,h+6);c.strokeStyle='rgba(169,177,162,.5)';c.lineWidth=width;c.strokeRect(x+width/2,y+width/2,w-width,h-width);line(c,'rgba(227,233,208,.35)',2,x,y,x+w,y);}
function weather(c,seed){const r=rng(seed);for(let i=0;i<360;i++){const x=r()*N,y=r()*N;c.fillStyle=i%4?'rgba(20,27,26,.06)':'rgba(102,55,26,.19)';c.fillRect(x,y,1+r()*12,1+r()*3);}for(let i=0;i<12;i++){const x=r()*N;c.fillStyle='rgba(60,36,16,.08)';c.fillRect(x,890,3+r()*4,130);}}
function normalFromHeight(height){const c=height.getContext('2d'),a=c.getImageData(0,0,N,N),out=c.createImageData(N,N);const b=a.data,o=out.data;for(let y=0;y<N;y++)for(let x=0;x<N;x++){const i=(y*N+x)*4,dx=(b[(y*N+(x+1)%N)*4]-b[(y*N+(x+N-1)%N)*4])/255,dy=(b[(((y+1)%N)*N+x)*4]-b[(((y+N-1)%N)*N+x)*4])/255;o[i]=128-dx*95;o[i+1]=128+dy*95;o[i+2]=250;o[i+3]=255;}c.putImageData(out,0,0);return texture(height);}
function paint(kind,color,photo,seed){
 const a=canvas(),h=canvas(),c=a.getContext('2d'),b=h.getContext('2d');
 c.fillStyle=color;c.fillRect(0,0,N,N);b.fillStyle='#808080';b.fillRect(0,0,N,N);
 // Grain is restrained, avoiding the unrelated blotches of world-projected maps.
 c.save();c.globalAlpha=kind==='wood'?.7:.13;c.globalCompositeOperation=kind==='wood'?'source-over':'multiply';c.drawImage(photo,0,0,N,N);c.restore();
 if(kind==='side'||kind==='door'){
  for(let x=24;x<N;x+=64){const g=c.createLinearGradient(x,0,x+64,0);g.addColorStop(0,'rgba(5,16,19,.29)');g.addColorStop(.18,'rgba(5,16,19,.08)');g.addColorStop(.35,'rgba(230,239,223,.15)');g.addColorStop(.75,'rgba(230,239,223,.02)');g.addColorStop(1,'rgba(5,16,19,.29)');c.fillStyle=g;c.fillRect(x,15,64,994);b.fillStyle='#b2b2b2';b.fillRect(x+19,18,28,988);}
  frame(c,0,0,N,N,18);b.strokeStyle='#414141';b.lineWidth=10;b.strokeRect(6,6,N-12,N-12);
  if(kind==='door'){
   for(const x of [256,512,768])line(c,'#233337',7,x,20,x,1008);
   for(const x of [124,388,636,900]){line(c,'#273539',18,x,62,x,968);line(c,'#9da99f',10,x-2,62,x-2,968);line(c,'#d0d4c3',2,x-4,62,x-4,968);for(const y of [96,430,830,944]){c.fillStyle='#2f4040';c.fillRect(x-21,y-15,42,30);bolt(c,x-12,y);bolt(c,x+12,y);}line(c,'#263638',17,x,704,x+64,704);line(c,'#a2aa9a',7,x,700,x+64,700);}
   c.fillStyle='rgba(226,231,207,.82)';c.font='bold 35px monospace';c.fillText('FRTU 042 218',45,170);c.font='19px monospace';c.fillText('22G1  MAX GROSS 30,480 KG',46,200);c.fillText('TARE 2,250 KG',46,225);
  }else{c.fillStyle='rgba(225,232,211,.66)';c.font='bold 35px monospace';c.fillText('MARITIME FREIGHT',145,260);c.font='20px monospace';c.fillText('22G1 / KEEP CLEAR',150,290);}
 }else if(kind==='wood'){
  for(let y=0;y<N;y+=128){line(c,'rgba(35,23,9,.85)',8,0,y,N,y);line(c,'rgba(234,207,160,.4)',2,0,y+5,N,y+5);line(b,'#404040',7,0,y,N,y);}
  for(const x of [25,960]){c.fillStyle='#705637';c.fillRect(x,0,39,N);line(c,'#b09062',3,x+2,0,x+2,N);b.fillStyle='#b8b8b8';b.fillRect(x,0,39,N);}
  for(const y of [25,960]){c.fillStyle='#765b39';c.fillRect(0,y,N,39);b.fillStyle='#b8b8b8';b.fillRect(0,y,N,39);}
  line(c,'#3d311e',63,55,955,960,60);line(c,'#806442',51,55,950,960,55);line(c,'#bb9760',3,58,930,940,58);line(b,'#b8b8b8',52,55,950,960,55);
  for(const x of [46,981])for(const y of [47,978])bolt(c,x,y,7);
  c.fillStyle='rgba(37,33,23,.7)';c.font='bold 32px monospace';c.fillText('FRAGILE  ↑↑',170,400);c.font='22px monospace';c.fillText('CARGO / 042',170,434);
 }else if(kind==='deck'){
  c.fillStyle='rgba(45,54,55,.22)';c.fillRect(0,0,N,N);for(const x of [0,512]){line(c,'#303e42',5,x,0,x,N);line(c,'#a3aca8',2,x+5,0,x+5,N);line(b,'#4a4a4a',7,x,0,x,N);}for(const y of [0,512]){line(c,'#303e42',5,0,y,N,y);line(c,'#a3aca8',2,0,y+5,N,y+5);line(b,'#4a4a4a',7,0,y,N,y);}for(const x of [19,493,531,1005])for(const y of [19,493,531,1005])bolt(c,x,y,3);
 }else if(kind==='tarp'){
  for(const y of [30,850]){line(c,'#2b321e',19,0,y,N,y);line(c,'#7b6841',8,0,y-2,N,y-2);line(b,'#b3b3b3',14,0,y,N,y);}for(let x=120;x<N;x+=260){line(c,'rgba(18,31,15,.4)',2,x,0,x+15,N);line(c,'rgba(183,184,136,.12)',4,x+9,0,x+24,N);}c.fillStyle='#baae82';c.font='bold 35px monospace';c.fillText('FREIGHT 042',120,290);
 }else{for(const y of [0,512]){line(c,'#39484a',5,0,y,N,y);line(c,'rgba(221,226,210,.25)',2,0,y+5,N,y+5);line(b,'#444444',5,0,y,N,y);}for(let x=20;x<N;x+=128)for(const y of [20,500])bolt(c,x,y,3);}
 weather(c,seed);
 const mat=new THREE.MeshStandardMaterial({map:texture(a,true),normalMap:normalFromHeight(h),normalScale:new THREE.Vector2(.55,.55),roughness:kind==='wood'?.92:.78,metalness:kind==='wood'||kind==='tarp'?0:.18});mat.name=`Painted ${kind} ${color}`;return mat;
}
export async function classicSurfaceArt(){
 const load=name=>loadSurfaceImage(name+'_diff_1k.jpg');
 const [steel,wood,deck]=await Promise.all([load('green_metal_rust'),load('wooden_planks'),load('metal_plate_02')]);
 const palette={white:'#aebdbb',blue:'#315971',green:'#46563a',yellow:'#aa9445'},materials=new Map();
 const get=(kind,color)=>{const key=kind+color;if(!materials.has(key))materials.set(key,paint(kind,color,kind==='wood'?wood:kind==='deck'?deck:steel,materials.size+43));return materials.get(key);};
 const faces={
  texture_78:['side','white'],texture_90:['door','white'],texture_106:['door','white'],
  texture_83:['tarp','green'],texture_81:['tarp','green'],texture_101:['side','green'],texture_79:['door','green'],texture_80:['side','green'],texture_75:['side','green'],texture_77:['side','green'],texture_73:['side','green'],texture_70:['door','green'],texture_88:['side','green'],m_00017:['tarp','green'],
  texture_84:['door','blue'],texture_82:['door','blue'],texture_71:['side','blue'],texture_74:['side','blue'],texture_119:['side','blue'],texture_126:['side','blue'],m_00001:['side','blue'],
  texture_85:['side','yellow'],texture_113:['door','yellow'],texture_76:['side','yellow'],texture_86:['panel','yellow'],
  texture_234:['wood','#a48a60'],texture_125:['wood','#a48a60'],texture_232:['wood','#a48a60'],texture_99:['wood','#a48a60'],w_00004:['wood','#a48a60'],m_00024:['wood','#a48a60'],
  texture_94:['deck','#83918f'],texture_95:['deck','#697976'],texture_87:['deck','#6b7b77'],texture_93:['panel','white'],
 };
 return {material(name){const key=name.split('/').pop(),[kind,color]=faces[key]||['panel','white'];return get(kind,palette[color]||color);},materials};
}
