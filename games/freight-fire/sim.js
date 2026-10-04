/* Transport Ship — dependency-free shared simulation. */
import { MAP } from './transport-map.js';
export { MAP };
export const PLAYER_RADIUS = 0.36;
export const PLAYER_HEIGHT = 1.76;
export const CROUCH_HEIGHT = 1.40;
const GRAVITY = 16;
const JUMP_SPEED = 6.8;
const EPS = 0.0001;
const TWO_PI = Math.PI * 2;
const clamp = (n, lo, hi) => Math.max(lo, Math.min(hi, n));
const finite = (n, fallback = 0) => Number.isFinite(Number(n)) ? Number(n) : fallback;
const angleDelta = (a, b) => ((b - a + Math.PI * 3) % TWO_PI) - Math.PI;
// Static broad phase: detailed classic geometry should not cost a full-map
// scan for every footstep or A* edge. Include player clearance in each bucket.
const SOLID_STEP=3,SOLID_GRID=new Map();
for(const box of MAP.boxes){
  for(let x=Math.floor((box.x-box.w/2-.7)/SOLID_STEP);x<=Math.floor((box.x+box.w/2+.7)/SOLID_STEP);x++)
    for(let z=Math.floor((box.z-box.d/2-.7)/SOLID_STEP);z<=Math.floor((box.z+box.d/2+.7)/SOLID_STEP);z++){
      const key=x+','+z;if(!SOLID_GRID.has(key))SOLID_GRID.set(key,[]);SOLID_GRID.get(key).push(box);
    }
}
const localSolids=(x,z)=>SOLID_GRID.get(Math.floor(x/SOLID_STEP)+','+Math.floor(z/SOLID_STEP))||[];

export const WEAPONS = [
  { id: 'm4a1', name: 'M4A1-S', mag: 30, reserve: 120, damage: 30, interval: 0.095, reload: 2.1, speed: 6.2, spread: 0.008, range: 150, automatic: true, color: '#343b39', barrelLength: 0.62, recoil: 0.017 },
  { id: 'ak47', name: 'AK-47', mag: 30, reserve: 120, damage: 34, interval: 0.105, reload: 2.45, speed: 6.0, spread: 0.013, range: 150, automatic: true, color: '#8b5639', barrelLength: 0.49, recoil: 0.026 },
  { id: 'awp', name: 'AWP', mag: 5, reserve: 25, damage: 115, interval: 1.15, reload: 2.9, speed: 5.2, spread: 0.036, range: 220, automatic: false, scope: true, color: '#68714c', barrelLength: 0.68, recoil: 0.055 },
  { id: 'usp', name: 'USP-S', mag: 12, reserve: 60, damage: 25, interval: 0.22, reload: 1.55, speed: 6.6, spread: 0.012, range: 90, automatic: false, color: '#3d4140', barrelLength: 0.22, recoil: 0.014 },
  { id: 'knife', name: '战术匕首', mag: 0, reserve: 0, damage: 50, heavyDamage: 100, interval: 0.55, heavyInterval: 0.95, reload: 0, speed: 6.8, spread: 0, range: 1.9, automatic: true, melee: true, color: '#aeb3b1', barrelLength: 0, recoil: 0 },
];

/** The cabin behind either team's two exits is its loadout area. The side
 * tunnel has a lower floor and does not allow buying beneath the cabin. */
export function canBuy(player) {
  if (!player?.alive || ![0, 1].includes(player.team)) return false;
  const side = player.team === 0 ? 1 : -1;
  const front = Math.max(...MAP.exits.filter(exit => exit.team === player.team).map(exit => side * exit.z));
  return Number.isFinite(player.x + player.y + player.z) && Math.abs(player.x) <= 10.8
    && Math.abs(player.y) < 0.3 && side * player.z >= front + 0.35
    && player.z > MAP.bounds.minZ + PLAYER_RADIUS && player.z < MAP.bounds.maxZ - PLAYER_RADIUS;
}

export function getEye(player) {
  return { x: player.x, y: player.y + (player.crouching ? 1.20 : 1.58), z: player.z };
}
export function directionFromAngles(yaw, pitch) {
  const c = Math.cos(pitch);
  return { x: -Math.sin(yaw) * c, y: Math.sin(pitch), z: -Math.cos(yaw) * c };
}
function pointAt(origin, direction, distance) {
  return { x: origin.x + direction.x * distance, y: origin.y + direction.y * distance, z: origin.z + direction.z * distance };
}
function rayBoxAligned(origin, direction, box, maxDistance) {
  let near = 0, far = maxDistance, normal = { x: 0, y: 0, z: 0 };
  const min = { x: box.x - box.w / 2, y: box.y, z: box.z - box.d / 2 };
  const max = { x: box.x + box.w / 2, y: box.y + box.h, z: box.z + box.d / 2 };
  for (const axis of ['x', 'y', 'z']) {
    if (Math.abs(direction[axis]) < 1e-8) {
      if (origin[axis] < min[axis] || origin[axis] > max[axis]) return null;
    } else {
      let a = (min[axis] - origin[axis]) / direction[axis];
      let b = (max[axis] - origin[axis]) / direction[axis];
      const sign = direction[axis] > 0 ? -1 : 1;
      if (a > b) [a, b] = [b, a];
      if (a > near) { near = a; normal = { x: 0, y: 0, z: 0, [axis]: sign }; }
      far = Math.min(far, b);
      if (near > far) return null;
    }
  }
  return near <= maxDistance && far >= 0 ? { distance: Math.max(0, near), normal } : null;
}

function rayBox(origin, direction, box, maxDistance) {
  if(box.planes){
    if(!rayBoxAligned(origin,direction,box,maxDistance))return null;
    let enter=0,exit=maxDistance,normal={x:0,y:0,z:0};
    for(const [nx,ny,nz,d]of box.planes){
      const distance=nx*origin.x+ny*origin.y+nz*origin.z-d,denom=nx*direction.x+ny*direction.y+nz*direction.z;
      if(Math.abs(denom)<1e-8){if(distance>EPS)return null;continue;}
      const t=-distance/denom;
      if(denom<0){if(t>enter){enter=t;normal={x:nx,y:ny,z:nz};}}else exit=Math.min(exit,t);
      if(enter>exit+EPS)return null;
    }
    return exit>=0&&enter<=maxDistance?{distance:Math.max(0,enter),normal}:null;
  }
  const yaw = box.yaw || 0, c = Math.cos(yaw), s = Math.sin(yaw);
  const dx = origin.x - box.x, dz = origin.z - box.z;
  const o = { x: c * dx - s * dz, y: origin.y, z: s * dx + c * dz };
  const d = { x: c * direction.x - s * direction.z, y: direction.y, z: s * direction.x + c * direction.z };
  const hit = rayBoxAligned(o, d, { ...box, x: 0, z: 0 }, maxDistance);
  if (hit) hit.normal = { x: c * hit.normal.x + s * hit.normal.z, y: hit.normal.y, z: -s * hit.normal.x + c * hit.normal.z };
  return hit;
}

/** A normalized direction is expected. Players are intentionally not included. */
export function raycastWorld(origin, direction, maxDistance = 200) {
  let nearest = null;
  for (const box of MAP.boxes) {
    const hit = rayBox(origin, direction, box, nearest?.distance ?? maxDistance);
    if (hit && (!nearest || hit.distance < nearest.distance)) nearest = { ...hit, box };
  }
  if (direction.y < -1e-8) {
    const distance = (MAP.floorY - origin.y) / direction.y;
    if (distance >= 0 && distance <= (nearest?.distance ?? maxDistance)) nearest = { distance, normal: { x: 0, y: 1, z: 0 }, box: null };
  }
  return nearest ? { ...nearest, point: pointAt(origin, direction, nearest.distance) } : null;
}
export function lineOfSight(from, to) {
  const dx = to.x - from.x, dy = to.y - from.y, dz = to.z - from.z;
  const distance = Math.hypot(dx, dy, dz);
  if (distance < EPS) return true;
  return !raycastWorld(from, { x: dx / distance, y: dy / distance, z: dz / distance }, distance - 0.01);
}

export function overlapsFoot(x, z, box, margin = 0) {
  if(box.planes){
    if(Math.abs(x-box.x)>=box.w/2+margin||Math.abs(z-box.z)>=box.d/2+margin)return false;
    return box.planes.every(([nx,ny,nz,d])=>Math.abs(ny)>1e-6||nx*x+nz*z<d+margin*Math.hypot(nx,nz)+EPS);
  }
  const c = Math.cos(box.yaw || 0), s = Math.sin(box.yaw || 0), dx = x - box.x, dz = z - box.z;
  const localX = Math.abs(c * dx - s * dz), localZ = Math.abs(s * dx + c * dz);
  if (margin === 0) return localX < box.w / 2 && localZ < box.d / 2;
  const cornerX = Math.max(0, localX - box.w / 2), cornerZ = Math.max(0, localZ - box.d / 2);
  return cornerX * cornerX + cornerZ * cornerZ < margin * margin;
}
export function columnSpan(box,x,z,margin=0){
  if(!overlapsFoot(x,z,box,margin))return null;
  if(!box.planes)return {bottom:box.y,top:box.y+box.h};
  let bottom=-Infinity,top=Infinity;
  for(const [nx,ny,nz,d]of box.planes){
    if(Math.abs(ny)<1e-6)continue;
    const limit=(d+margin*Math.hypot(nx,nz)-nx*x-nz*z)/ny;
    if(ny>0)top=Math.min(top,limit);else bottom=Math.max(bottom,limit);
  }
  return top>=bottom-EPS?{bottom,top}:null;
}
export function floorAt(x,z,below=Infinity,margin=0){
  let floor=MAP.floorY;
  for(const box of localSolids(x,z)){const span=columnSpan(box,x,z,margin);if(span&&span.top<=below+EPS)floor=Math.max(floor,span.top);}
  return floor;
}
export function resolveWorldSphere(point,radius,velocity,solids=MAP.boxes){
  for(const box of solids){
    if(point.x<box.x-box.w/2-radius||point.x>box.x+box.w/2+radius||point.y<box.y-radius||point.y>box.y+box.h+radius||point.z<box.z-box.d/2-radius||point.z>box.z+box.d/2+radius)continue;
    let best=-Infinity,normal=null,inside=true;
    const planes=box.planes||[[1,0,0,box.x+box.w/2],[-1,0,0,-box.x+box.w/2],[0,1,0,box.y+box.h],[0,-1,0,-box.y],[0,0,1,box.z+box.d/2],[0,0,-1,-box.z+box.d/2]];
    for(const [nx,ny,nz,d]of planes){const distance=nx*point.x+ny*point.y+nz*point.z-d;if(distance>=radius){inside=false;break;}if(distance>best){best=distance;normal={x:nx,y:ny,z:nz};}}
    if(inside&&normal){const depth=radius-best;point.x+=normal.x*depth;point.y+=normal.y*depth;point.z+=normal.z*depth;if(velocity){const into=velocity.x*normal.x+velocity.y*normal.y+velocity.z*normal.z;if(into<0){velocity.x-=normal.x*into*1.04;velocity.y-=normal.y*into*1.04;velocity.z-=normal.z*into*1.04;}if(normal.y>.5){velocity.x*=.76;velocity.z*=.76;}}}
  }
  if(point.y<MAP.floorY+radius){point.y=MAP.floorY+radius;if(velocity)velocity.y=Math.max(0,velocity.y)*.02;}
}
function blocked(x, z, y, height, margin = PLAYER_RADIUS) {
  const b = MAP.bounds;
  if (x < b.minX + margin || x > b.maxX - margin || z < b.minZ + margin || z > b.maxZ - margin) return true;
  return localSolids(x,z).some(box=>{const span=columnSpan(box,x,z,margin);return span&&y+height>span.bottom+EPS&&y<span.top-EPS;});
}
export function canStandAt(x,z,y=0,margin=PLAYER_RADIUS){return !blocked(x,z,y,PLAYER_HEIGHT,margin);}
function raySphere(origin, direction, center, radius, maxDistance) {
  const x = origin.x - center.x, y = origin.y - center.y, z = origin.z - center.z;
  const b = x * direction.x + y * direction.y + z * direction.z;
  const c = x * x + y * y + z * z - radius * radius;
  const discriminant = b * b - c;
  if (discriminant < 0) return null;
  const distance = -b - Math.sqrt(discriminant);
  return distance >= 0 && distance <= maxDistance ? distance : null;
}
function rayPlayer(origin, direction, player, maxDistance) {
  const height = player.crouching ? CROUCH_HEIGHT : PLAYER_HEIGHT;
  const headCenter = { x: player.x, y: player.y + height - 0.22, z: player.z };
  const head = raySphere(origin, direction, headCenter, 0.24, maxDistance);
  // Vertical body cylinder: a single analytic ray intersection avoids axis-aligned corner hits.
  const ox = origin.x - player.x, oz = origin.z - player.z;
  const a = direction.x ** 2 + direction.z ** 2;
  const b = 2 * (ox * direction.x + oz * direction.z);
  const c = ox ** 2 + oz ** 2 - PLAYER_RADIUS ** 2;
  let body = null;
  const discriminant = b * b - 4 * a * c;
  if (a > 1e-9 && discriminant >= 0) {
    for (const distance of [(-b - Math.sqrt(discriminant)) / (2 * a), (-b + Math.sqrt(discriminant)) / (2 * a)]) {
      const y = origin.y + direction.y * distance;
      if (distance >= 0 && distance <= maxDistance && y >= player.y + 0.1 && y <= player.y + height - 0.3) {
        body = distance; break;
      }
    }
  }
  if (head !== null && (body === null || head < body)) return { distance: head, headshot: true };
  return body !== null ? { distance: body, headshot: false } : null;
}

// A shared static navigation grid with clearance for the full player radius.
const NAV_STEP = .55;
const NAV_X = MAP.bounds.minX + 0.65;
const NAV_Z = MAP.bounds.minZ + 0.65;
const NAV_W = Math.floor((MAP.bounds.maxX - MAP.bounds.minX - 1.3) / NAV_STEP) + 1;
const NAV_H = Math.floor((MAP.bounds.maxZ - MAP.bounds.minZ - 1.3) / NAV_STEP) + 1;
const navPoint = index => ({ x: NAV_X + (index % NAV_W) * NAV_STEP, z: NAV_Z + Math.floor(index / NAV_W) * NAV_STEP });
const NAV_OPEN = Array.from({ length: NAV_W * NAV_H }, (_, index) => {
  const p = navPoint(index),floor=floorAt(p.x,p.z,.225,PLAYER_RADIUS+.12);return floor>-.25&&!blocked(p.x,p.z,floor,PLAYER_HEIGHT,PLAYER_RADIUS+.12);
});
function nearestCell(x, z) {
  const cx = clamp(Math.round((x - NAV_X) / NAV_STEP), 0, NAV_W - 1);
  const cz = clamp(Math.round((z - NAV_Z) / NAV_STEP), 0, NAV_H - 1);
  const direct = cz * NAV_W + cx;
  if (NAV_OPEN[direct]) return direct;
  let best = direct, bestD = Infinity;
  for (let i = 0; i < NAV_OPEN.length; i++) if (NAV_OPEN[i]) {
    const p = navPoint(i), d = (p.x - x) ** 2 + (p.z - z) ** 2;
    if (d < bestD) { best = i; bestD = d; }
  }
  return best;
}
function walkSegment(a, b) {
  const distance = Math.hypot(b.x - a.x, b.z - a.z);
  const count = Math.max(1, Math.ceil(distance / 0.10));
  for (let i = 1; i <= count; i++) {
    const t = i / count;
    const x=a.x+(b.x-a.x)*t,z=a.z+(b.z-a.z)*t;
    const floor=floorAt(x,z,.225,PLAYER_RADIUS+.08);if(floor<-.25||blocked(x,z,floor,PLAYER_HEIGHT,PLAYER_RADIUS+.08))return false;
  }
  return true;
}
const NAV_EDGES=new Map();
function navEdge(a,b){const key=Math.min(a,b)*NAV_OPEN.length+Math.max(a,b);if(!NAV_EDGES.has(key))NAV_EDGES.set(key,walkSegment(navPoint(a),navPoint(b)));return NAV_EDGES.get(key);}
class PathHeap{
 constructor(){this.items=[];}
 push(index,rank){const item={index,rank};let at=this.items.length;this.items.push(item);while(at>0){const parent=(at-1)>>1;if(this.items[parent].rank<=rank)break;this.items[at]=this.items[parent];at=parent;}this.items[at]=item;}
 pop(){const first=this.items[0],last=this.items.pop();if(this.items.length){let at=0;while(at*2+1<this.items.length){let child=at*2+1;if(child+1<this.items.length&&this.items[child+1].rank<this.items[child].rank)child++;if(this.items[child].rank>=last.rank)break;this.items[at]=this.items[child];at=child;}this.items[at]=last;}return first.index;}
}
/** A* with diagonal corner checks, used by bots on both the static and LAN builds. */
export function findPath(from, to) {
  if (walkSegment(from, to)) return [{ x: to.x, z: to.z }];
  const start = nearestCell(from.x, from.z), end = nearestCell(to.x, to.z);
  const scores = new Float64Array(NAV_OPEN.length).fill(Infinity);
  const parents = new Int32Array(NAV_OPEN.length).fill(-1);
  const closed = new Uint8Array(NAV_OPEN.length);
  const open = new PathHeap(); scores[start] = 0;
  const target = navPoint(end);
  const heuristic = index => { const p = navPoint(index); return Math.hypot(p.x - target.x, p.z - target.z); };
  open.push(start,heuristic(start));let reached = false;
  while (open.items.length) {
    const current = open.pop();if(closed[current])continue;
    if (current === end) { reached = true; break; }
    closed[current] = 1;
    const cx = current % NAV_W, cz = Math.floor(current / NAV_W);
    for (let dz = -1; dz <= 1; dz++) for (let dx = -1; dx <= 1; dx++) {
      if (!dx && !dz) continue;
      const nx = cx + dx, nz = cz + dz, next = nz * NAV_W + nx;
      if (nx < 0 || nx >= NAV_W || nz < 0 || nz >= NAV_H || !NAV_OPEN[next] || closed[next]) continue;
      if (dx && dz && (!NAV_OPEN[cz * NAV_W + nx] || !NAV_OPEN[nz * NAV_W + cx])) continue;
      if (!navEdge(current,next)) continue;
      const cost = scores[current] + NAV_STEP * (dx && dz ? Math.SQRT2 : 1);
      if (cost >= scores[next]) continue;
      scores[next] = cost; parents[next] = current;
      open.push(next,cost+heuristic(next));
    }
  }
  if (!reached) return [];
  const route = [];
  for (let at = end; at !== start; at = parents[at]) route.push(navPoint(at));
  route.reverse();
  // String-pull only over movement-clear segments, preserving container clearance.
  const result = []; let anchor = from, at = 0;
  while (at < route.length) {
    let far = at;
    while (far + 1 < route.length && walkSegment(anchor, route[far + 1])) far++;
    result.push(route[far]); anchor = route[far]; at = far + 1;
  }
  if (walkSegment(anchor, to)) result.push({ x: to.x, z: to.z });
  return result;
}

const BOT_NAMES = ['Rook', 'Sable', 'Echo', 'Atlas', 'Kestrel', 'Nomad', 'Ghost', 'Viper'];
const DIFFICULTY = {
  easy: { accuracy: 0.058, reaction: 0.38, speed: 0.79, aggression: 17 },
  normal: { accuracy: 0.026, reaction: 0.22, speed: 0.9, aggression: 22 },
  hard: { accuracy: 0.012, reaction: 0.12, speed: 1, aggression: 28 },
};

export class Match {
  constructor({ size = 4, goal = 40, duration = 300, difficulty = 'normal', seed = 10604 } = {}) {
    this.size = Number(size) === 8 ? 8 : 4;
    this.goal = clamp(Math.round(finite(goal, 40)), 1, 500);
    this.duration = clamp(finite(duration, 300), 5, 3600);
    this.difficulty = Object.hasOwn(DIFFICULTY, difficulty) ? difficulty : 'normal';
    this.seed = finite(seed, 10604) >>> 0;
    this._randomState = this.seed || 1;
    this._eventSeq = 0;
    this.time = 0; this.score = [0, 0]; this.status = 'playing'; this.winner = null;
    this.events = [];
    this.players = Array.from({ length: this.size * 2 }, (_, i) => this._newPlayer(i));
  }
  _random() {
    let x = this._randomState; x ^= x << 13; x ^= x >>> 17; x ^= x << 5;
    this._randomState = x >>> 0; return this._randomState / 4294967296;
  }
  _event(type, fields = {}) {
    this.events.push({ seq: ++this._eventSeq, type, time: this.time, ...fields });
    if (this.events.length > 128) this.events.splice(0, this.events.length - 128);
  }
  _newPlayer(index) {
    const team = index < this.size ? 0 : 1;
    const p = { id: `p${index}`, name: BOT_NAMES[index % this.size], team, bot: true, human: false,
      x: 0, y: 0, z: 0, yaw: team ? Math.PI : 0, pitch: 0,
      hp: 100, alive: true, primaryWeapon: index % 5 === 4 ? 1 : 0, weapon: index % 5 === 4 ? 1 : 0, ammo: [], reserve: [],
      kills: 0, deaths: 0, respawnAt: 0, reloadUntil: 0, shieldUntil: 0,
      killerId: null, deathWeapon: null, deathHeadshot: false, deathAt: 0,
      vx: 0, vy: 0, vz: 0, grounded: true, moving: false, crouching: false, walking: false, aiming: false,
      _index: index, _input: {}, _jumpPressed: false, _jumpHeld: false, _fireHeld: false,
      _nextShot: 0, _equipUntil: 0, _ai: { nextThink: 0, targetId: null, acquireAt: 0, path: [], pathAt: 0, nextPath: 0, side: index % 2 ? -1 : 1 },
    };
    this._spawn(p, true); return p;
  }
  _spawn(player, initial = false) {
    const teamSpawns = MAP.spawns.filter(s => s.team === player.team);
    let spawn = teamSpawns[player._index % this.size];
    if (!initial) {
      // Prefer a free, safer spawn. Fixed candidates keep the slots reproducible.
      let best = -Infinity;
      for (let i = 0; i < teamSpawns.length; i++) {
        const candidate = teamSpawns[(i + player._index) % teamSpawns.length];
        let safety = 100;
        for (const other of this.players ?? []) if (other.id !== player.id && other.alive) {
          const distance = Math.hypot(other.x - candidate.x, other.z - candidate.z);
          safety = Math.min(safety, distance * (other.team === player.team ? 3 : 1));
        }
        if (safety > best) { best = safety; spawn = candidate; }
      }
    }
    Object.assign(player, { x: spawn.x, y: 0, z: spawn.z, yaw: spawn.yaw ?? (player.team ? Math.PI : 0), pitch: 0, hp: 100,
      alive: true, weapon: player.primaryWeapon, ammo: WEAPONS.map(w => w.mag), reserve: WEAPONS.map(w => w.reserve), respawnAt: 0,
      reloadUntil: 0, shieldUntil: this.time + 1.4, vx: 0, vy: 0, vz: 0, grounded: true,
      killerId: null, deathWeapon: null, deathHeadshot: false, deathAt: 0,
      moving: false, crouching: false, walking: false, aiming: false,
      _input: {}, _jumpPressed: false, _jumpHeld: false, _fireHeld: false,
      _nextShot: this.time + (initial ? 0 : 0.25), _equipUntil: this.time,
    });
    player._ai = { nextThink: 0, targetId: null, acquireAt: this.time, path: [], pathAt: 0, nextPath: 0, side: player._index % 2 ? -1 : 1 };
    if (!initial) this._event('respawn', { playerId: player.id, team: player.team, from: { x: player.x, y: player.y, z: player.z } });
  }
  addHuman(name = 'Operator', team) {
    const validTeam = team === 0 || team === 1 ? team : null;
    const humans = [0, 1].map(t => this.players.filter(p => p.team === t && !p.bot).length);
    const preferred = validTeam ?? (humans[0] <= humans[1] ? 0 : 1);
    let player = this.players.find(p => p.bot && p.team === preferred);
    if (!player && validTeam === null) player = this.players.find(p => p.bot);
    if (!player) return null;
    player.bot = false; player.human = true;
    player.primaryWeapon = 0;
    player.name = String(name).replace(/[\u0000-\u001f<>]/g, '').trim().slice(0, 24) || 'Operator';
    this._spawn(player, this.time === 0);
    this._event('join', { playerId: player.id, name: player.name, team: player.team });
    return player;
  }
  removeHuman(id) {
    const player = this.players.find(p => p.id === id);
    if (!player || player.bot) return false;
    player.bot = true; player.human = false; player.name = BOT_NAMES[player._index % this.size];
    player._input = {}; player._fireHeld = false; player._jumpHeld = false;
    player._ai.nextThink = 0; player._ai.nextPath = 0; player._ai.path = [];
    this._event('leave', { playerId: player.id, team: player.team });
    return true;
  }
  input(id, data = {}) {
    const player = this.players.find(p => p.id === id);
    if (!player || player.bot || this.status !== 'playing') return false;
    const primaryWeapon = data.primaryWeapon;
    if (primaryWeapon !== undefined && (!Number.isInteger(primaryWeapon) || primaryWeapon < 0 || primaryWeapon > 2 || !canBuy(player))) return false;
    let weapon = typeof data.weapon === 'string' ? WEAPONS.findIndex(w => w.id === data.weapon) : data.weapon;
    if (!Number.isInteger(weapon) || weapon < 0 || weapon >= WEAPONS.length) weapon = primaryWeapon ?? player.weapon;
    if (weapon < 3 && weapon !== player.primaryWeapon && weapon !== primaryWeapon) return false;
    const jump = !!data.jump;
    player._jumpPressed ||= jump && !player._jumpHeld;
    player._jumpHeld = jump;
    player._input = {
      forward: clamp(finite(data.forward), -1, 1), strafe: clamp(finite(data.strafe), -1, 1),
      yaw: finite(data.yaw, player.yaw), pitch: clamp(finite(data.pitch, player.pitch), -1.48, 1.48),
      fire: !!data.fire, altFire: !!data.altFire, aim: !!data.aim, reload: !!data.reload, weapon, primaryWeapon,
      walk: !!data.walk, crouch: !!data.crouch,
    };
    return true;
  }
  _reload(player) {
    const weapon = WEAPONS[player.weapon];
    if (!player.alive || weapon.melee || player.reloadUntil > this.time || player.ammo[player.weapon] >= weapon.mag || player.reserve[player.weapon] <= 0) return false;
    player.reloadUntil = this.time + weapon.reload;
    this._event('reload', { playerId: player.id, weapon: player.weapon, until: player.reloadUntil });
    return true;
  }
  _shoot(player, input) {
    const weapon = WEAPONS[player.weapon];
    if (weapon.melee) { this._melee(player, input); return; }
    if (!input.fire || this.time < player._nextShot || this.time < player._equipUntil || player.reloadUntil > 0) return;
    if (!weapon.automatic && player._fireHeld && !player.bot) return;
    if (player.ammo[player.weapon] <= 0) { this._reload(player); return; }
    player.ammo[player.weapon]--; player._nextShot = this.time + weapon.interval; player._fireHeld = true;
    player.shieldUntil = 0;
    const movement = player.moving ? 1.85 : 1;
    let spread = weapon.spread * movement * (player.crouching ? 0.72 : 1) * (player.aiming ? (weapon.scope ? 0.035 : 0.52) : 1);
    if (!player.grounded) spread *= 3;
    // Bots receive their intentional aim error in the AI controller, not a second hidden penalty.
    const yaw = player.yaw + (this._random() + this._random() - 1) * spread;
    const pitch = player.pitch + (this._random() + this._random() - 1) * spread;
    const direction = directionFromAngles(yaw, pitch), from = getEye(player);
    const wall = raycastWorld(from, direction, weapon.range);
    let distance = wall?.distance ?? weapon.range, target = null, headshot = false;
    for (const other of this.players) {
      if (!other.alive || other.id === player.id || other.team === player.team) continue;
      const hit = rayPlayer(from, direction, other, distance);
      if (hit && hit.distance < distance) { distance = hit.distance; target = other; headshot = hit.headshot; }
    }
    const to = pointAt(from, direction, distance);
    this._event('shot', { playerId: player.id, team: player.team, weapon: player.weapon, from, to,
      targetId: target?.id ?? null, headshot, normal: wall?.normal, surface: target ? 'player' : wall ? 'world' : 'air' });
    if (target) {
      const protectedSpawn = target.shieldUntil > this.time;
      const damage = protectedSpawn ? 0 : Math.round(weapon.damage * (headshot ? 3.6 : 1) * (distance > 55 && !weapon.scope ? 0.82 : 1));
      this._damage(player, target, { damage, headshot, protectedSpawn, from, to, direction });
    }
  }
  _damage(player, target, { damage, headshot, protectedSpawn, from, to, direction, heavy = false }) {
    target.hp = Math.max(0, target.hp - damage);
    this._event('hit', { playerId: player.id, targetId: target.id, weapon: player.weapon, damage, headshot, heavy, protected: protectedSpawn, to });
    if (target.hp > 0) return;
    target.alive = false; target.deaths++; target.respawnAt = this.time + 3; target.reloadUntil = 0;
    target.vx = 0; target.vy = 0; target.vz = 0; target.moving = false;
    target.killerId = player.id; target.deathWeapon = player.weapon; target.deathHeadshot = headshot; target.deathAt = this.time;
    player.kills++; this.score[player.team]++;
    this._event('kill', { playerId: player.id, targetId: target.id, team: player.team, weapon: player.weapon, headshot, from, to, direction, score: [...this.score] });
    if (this.score[player.team] >= this.goal) this._finish(player.team, 'score');
  }
  _melee(player, input) {
    if ((!input.fire && !input.altFire) || this.time < player._nextShot || this.time < player._equipUntil || player.reloadUntil > 0) return;
    const weapon = WEAPONS[player.weapon], heavy = !!input.altFire;
    player._nextShot = this.time + (heavy ? weapon.heavyInterval : weapon.interval);
    player.shieldUntil = 0;
    const from = getEye(player), direction = directionFromAngles(player.yaw, player.pitch);
    let nearest = weapon.range, target = null, to = pointAt(from, direction, weapon.range);
    // A narrow swept cone follows the blade. Test actual visibility to the
    // closest body height, so a swing cannot reach through a crate or wall.
    for (const other of this.players) {
      if (!other.alive || other.id === player.id || other.team === player.team) continue;
      const height = other.crouching ? CROUCH_HEIGHT : PLAYER_HEIGHT;
      const point = { x: other.x, y: clamp(from.y, other.y + 0.35, other.y + height - 0.18), z: other.z };
      const delta = { x: point.x - from.x, y: point.y - from.y, z: point.z - from.z };
      const centerDistance = Math.hypot(delta.x, delta.y, delta.z), reach = Math.max(0, centerDistance - PLAYER_RADIUS);
      if (reach > nearest || centerDistance < EPS) continue;
      const facing = (delta.x * direction.x + delta.y * direction.y + delta.z * direction.z) / centerDistance;
      if (facing < 0.82 || !lineOfSight(from, point)) continue;
      nearest = reach; target = other; to = point;
    }
    this._event('melee', { playerId: player.id, team: player.team, weapon: player.weapon, heavy, from, to, targetId: target?.id ?? null });
    if (target) {
      const protectedSpawn = target.shieldUntil > this.time;
      this._damage(player, target, { damage: protectedSpawn ? 0 : heavy ? weapon.heavyDamage : weapon.damage, headshot: false, protectedSpawn, from, to, direction, heavy });
    }
  }
  _move(player, input, dt) {
    player.yaw = input.yaw ?? player.yaw; player.pitch = input.pitch ?? player.pitch;
    const crouchWanted = !!input.crouch;
    if (crouchWanted || !blocked(player.x, player.z, player.y, PLAYER_HEIGHT)) player.crouching = crouchWanted;
    player.aiming = !!input.aim && !WEAPONS[player.weapon].melee;
    player.walking = !!input.walk;
    const height = player.crouching ? CROUCH_HEIGHT : PLAYER_HEIGHT;
    let forward = input.forward ?? 0, strafe = input.strafe ?? 0;
    const length = Math.hypot(forward, strafe);
    if (length > 1) { forward /= length; strafe /= length; }
    let speed = WEAPONS[player.weapon].speed * Math.min(player.crouching ? 0.46 : 1, player.walking ? 0.5 : 1, player.aiming ? 0.58 : 1);
    if (player.bot) speed *= DIFFICULTY[this.difficulty].speed;
    const dx = (-Math.sin(player.yaw) * forward + Math.cos(player.yaw) * strafe) * speed * dt;
    const dz = (-Math.cos(player.yaw) * forward - Math.sin(player.yaw) * strafe) * speed * dt;
    if (player._jumpPressed && player.grounded && !player.crouching) { player.vy = JUMP_SPEED; player.grounded = false; this._event('jump', { playerId: player.id }); }
    player._jumpPressed = false;
    const previousY = player.y;
    player.vy -= GRAVITY * dt;
    let newY = player.y + player.vy * dt;
    if (player.vy > 0) {
      for (const box of localSolids(player.x,player.z)) {const span=columnSpan(box,player.x,player.z,PLAYER_RADIUS);if(span&&previousY+height<=span.bottom+EPS&&newY+height>=span.bottom){
        newY=span.bottom-height;player.vy=0;
      }
      }
    }
    // Resolve the supporting platform before lateral motion. Otherwise the tiny
    // gravity step would put feet inside a crate and prevent walking off it.
    if (player.vy <= 0) for (const box of localSolids(player.x,player.z)) {
      const span=columnSpan(box,player.x,player.z,PLAYER_RADIUS),top=span?.top??-Infinity;
      if (span && previousY >= top - 0.03 && newY <= top) {
        newY = Math.max(newY, top); player.vy = 0;
      }
    }
    player.y = newY;
    const oldX = player.x, oldZ = player.z;
    const lateral=(x,z)=>{
      if(!blocked(x,z,player.y,height))return true;
      // Walk up the metal passage stairs; jumping is still required for cargo.
      if(player.grounded&&player.vy<=0){
        const tops=localSolids(x,z).map(b=>columnSpan(b,x,z,PLAYER_RADIUS)?.top).filter(top=>top>player.y&&top<=player.y+.225);
        const step=Math.max(-Infinity,...tops);
        if(Number.isFinite(step)&&!blocked(x,z,step,height)){player.y=step;player.vy=0;return true;}
      }
      return false;
    };
    if(lateral(player.x+dx,player.z))player.x+=dx;
    if(lateral(player.x,player.z+dz))player.z+=dz;
    let floor = MAP.floorY;
    if (player.vy <= 0) for (const box of localSolids(player.x,player.z)) {
      const span=columnSpan(box,player.x,player.z,PLAYER_RADIUS),top=span?.top??-Infinity;
      if (span && Math.max(previousY,player.y) >= top - 0.03 && player.y <= top) floor = Math.max(floor, top);
    }
    if (player.y <= floor) { player.y = floor; player.vy = 0; player.grounded = true; }
    else player.grounded = false;
    player.vx = (player.x - oldX) / dt; player.vz = (player.z - oldZ) / dt;
    player.moving = Math.hypot(player.vx, player.vz) > 0.05;
  }
  _bot(player) {
    const ai = player._ai, config = DIFFICULTY[this.difficulty];
    if (this.time < ai.nextThink) return player._input;
    ai.nextThink = this.time + 0.09 + this._random() * 0.045;
    const eye = getEye(player);
    let nearest = null, best = Infinity;
    for (const enemy of this.players) if (enemy.alive && enemy.team !== player.team) {
      const distance = Math.hypot(enemy.x - player.x, enemy.z - player.z);
      const visible = lineOfSight(eye, { x: enemy.x, y: enemy.y + (enemy.crouching ? 0.72 : 1.2), z: enemy.z });
      const weight = distance + (visible ? 0 : 24) + (ai.targetId === enemy.id ? -5 : 0);
      if (weight < best) { best = weight; nearest = { enemy, distance, visible }; }
    }
    if (!nearest) return player._input = { forward: 0, strafe: 0, yaw: player.yaw, pitch: 0 };
    const { enemy, distance, visible } = nearest;
    if (ai.targetId !== enemy.id) { ai.targetId = enemy.id; ai.acquireAt = this.time + config.reaction; ai.nextPath = 0; }
    let yaw, pitch = 0, forward = 0, strafe = 0;
    const engage = visible && distance < config.aggression;
    if (engage) {
      const dx = enemy.x - player.x, dz = enemy.z - player.z;
      const desiredYaw = Math.atan2(-dx, -dz);
      yaw = desiredYaw + (this._random() - 0.5) * config.accuracy * 2;
      const targetY = enemy.y + (enemy.crouching ? 0.72 : 1.25);
      pitch = Math.atan2(targetY - eye.y, distance) + (this._random() - 0.5) * config.accuracy;
      // Short strafing bursts seek clear space and make combat less static.
      strafe = Math.sin(this.time * 1.7 + player._index * 1.8) * 0.42;
      forward = distance > 15 ? 0.28 : distance < 5 ? -0.25 : 0;
      ai.path = []; ai.nextPath = this.time + 0.35;
    } else {
      if (this.time >= ai.nextPath || ai.pathAt >= ai.path.length) {
        ai.path = findPath(player, enemy); ai.pathAt = 0; ai.nextPath = this.time + 1.1 + this._random() * 0.45;
      }
      while (ai.pathAt < ai.path.length && Math.hypot(ai.path[ai.pathAt].x - player.x, ai.path[ai.pathAt].z - player.z) < 0.24) ai.pathAt++;
      const waypoint = ai.path[ai.pathAt] ?? enemy;
      const dx = waypoint.x - player.x, dz = waypoint.z - player.z;
      yaw = Math.atan2(-dx, -dz); forward = 1;
    }
    // Never aim instantly across a full turn; the fire decision checks the resulting alignment.
    yaw = player.yaw + clamp(angleDelta(player.yaw, yaw), -0.75, 0.75);
    const aligned = Math.abs(angleDelta(yaw, Math.atan2(-(enemy.x - player.x), -(enemy.z - player.z)))) < 0.13;
    const weapon = WEAPONS[player.weapon];
    const needsReload = player.ammo[player.weapon] <= 0 || (!visible && player.ammo[player.weapon] < weapon.mag * 0.4);
    player._input = { forward, strafe, yaw, pitch, fire: engage && aligned && this.time >= ai.acquireAt,
      aim: engage, reload: needsReload, weapon: player.weapon, walk: false, crouch: false };
    return player._input;
  }
  _finish(winner, reason) {
    if (this.status === 'ended') return;
    this.status = 'ended'; this.winner = winner;
    for (const player of this.players) { player.vx = 0; player.vz = 0; player.moving = false; }
    this._event('end', { winner, reason, score: [...this.score] });
  }
  step(dt) {
    dt = clamp(finite(dt), 0, 1);
    if (this.status !== 'playing' || dt <= 0) return;
    const count = Math.max(1, Math.ceil(dt / (1 / 30))), h = dt / count;
    for (let frame = 0; frame < count && this.status === 'playing'; frame++) {
      this.time += h;
      if (this.time >= this.duration) {
        this.time = this.duration;
        this._finish(this.score[0] === this.score[1] ? null : this.score[0] > this.score[1] ? 0 : 1, 'time'); break;
      }
      for (const player of this.players) {
        if (!player.alive) { if (this.time >= player.respawnAt) this._spawn(player); else continue; }
        if (player.reloadUntil > 0 && this.time >= player.reloadUntil) {
          const transfer = Math.min(WEAPONS[player.weapon].mag - player.ammo[player.weapon], player.reserve[player.weapon]);
          player.ammo[player.weapon] += transfer; player.reserve[player.weapon] -= transfer; player.reloadUntil = 0;
          this._event('reloadComplete', { playerId: player.id, weapon: player.weapon });
        }
        const input = player.bot ? this._bot(player) : player._input;
        if (Number.isInteger(input.primaryWeapon)) {
          if (canBuy(player)) {
            const changed = input.primaryWeapon !== player.primaryWeapon;
            player.primaryWeapon = input.primaryWeapon; player.reloadUntil = 0;
            input.weapon = player.primaryWeapon;
            if (changed) this._event('loadout', { playerId: player.id, primaryWeapon: player.primaryWeapon });
          }
          delete input.primaryWeapon;
        }
        if (Number.isInteger(input.weapon) && input.weapon >= 0 && input.weapon < WEAPONS.length
          && (input.weapon >= 3 || input.weapon === player.primaryWeapon) && input.weapon !== player.weapon) {
          player.weapon = input.weapon; player.reloadUntil = 0; player._equipUntil = this.time + 0.25; player._fireHeld = false;
          this._event('weapon', { playerId: player.id, weapon: player.weapon });
          this._event('equip', { playerId: player.id, weapon: player.weapon });
        }
        this._move(player, input, h);
        if (input.reload) this._reload(player);
        if (!input.fire) player._fireHeld = false;
        this._shoot(player, input);
        if (this.status !== 'playing') break;
      }
    }
  }
  restart() {
    this.time = 0; this.score = [0, 0]; this.status = 'playing'; this.winner = null;
    this._randomState = this.seed || 1;
    this.events = [];
    // Keep seq monotonic so connected renderers can recognize the restart event.
    for (const player of this.players) { player.kills = 0; player.deaths = 0; this._spawn(player, true); }
    this._event('restart', { score: [0, 0] });
    return this.snapshot();
  }
  snapshot() {
    const players = this.players.map(player => Object.fromEntries(Object.entries(player)
      .filter(([key]) => !key.startsWith('_')).map(([key, value]) => [key, Array.isArray(value) ? [...value] : value])));
    return { version: 1, map: 'freight', time: this.time, score: [...this.score], status: this.status,
      winner: this.winner, size: this.size, goal: this.goal, duration: this.duration, difficulty: this.difficulty,
      players, events: this.events.map(event => ({ ...event })) };
  }
}
