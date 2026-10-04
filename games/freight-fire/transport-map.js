import classic from './classic-map-data.js';
// Structural geometry and collision planes share the same source conversion.
// Source-port units are uniformly scaled to our operator; original CF engine
// units are not available. See assets/maps/classic-source.json for provenance.
const exits=[
 {team:0,name:'left',x:-5.76,z:35.40,w:3.65},
 {team:0,name:'right',x:6.43,z:35.40,w:3.22},
 {team:1,name:'left',x:5.46,z:-35.78,w:3.22},
 {team:1,name:'right',x:-6.61,z:-35.78,w:3.22},
];
export const MAP={
 name:'运输船 / Transport Ship',floorY:-5.5,
 ...classic,geometry:'./assets/maps/classic-geometry.json',
 floorHoles:[],exits,cosmeticScale:1,cabinFront:35.40,
 tunnels:[
  {side:1,team:0,x:12.8,baseZ:41,exitZ:-14,width:2.55},
  {side:-1,team:1,x:-12.8,baseZ:-42,exitZ:14,width:2.55},
 ],
 spawns:classic.spawns.map(spawn=>{
  const door=exits.filter(e=>e.team===spawn.team).sort((a,b)=>Math.abs(a.x-spawn.x)-Math.abs(b.x-spawn.x))[0];
  return {...spawn,yaw:Math.atan2(spawn.x-door.x,spawn.z-door.z)};
 }),
 landmarks:[{x:0,z:39,name:'保卫者基地'},{x:0,z:-39,name:'潜伏者基地'}],
};
