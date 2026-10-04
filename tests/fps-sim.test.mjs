import test from 'node:test';
import assert from 'node:assert/strict';
import { Match, MAP, WEAPONS, PLAYER_RADIUS, PLAYER_HEIGHT, CROUCH_HEIGHT, findPath, getEye, raycastWorld, lineOfSight, overlapsFoot, columnSpan, floorAt, canStandAt, canBuy } from '../games/freight-fire/sim.js';

function advance(match, seconds, tick = 1 / 30) {
  for (let elapsed = 0; elapsed < seconds - 1e-8; elapsed += tick) match.step(Math.min(tick, seconds - elapsed));
}
function passiveMatch(options = {}) {
  const match = new Match({ goal: 100, duration: 300, ...options });
  for (const p of match.players) { p.bot = false; p.human = true; p.shieldUntil = 0; }
  return match;
}
function place(player, x, z, extras = {}) {
  Object.assign(player, { x, y: 0, z, yaw: 0, pitch: 0, hp: 100, alive: true, vy: 0, shieldUntil: 0, ...extras });
}
function duel(options = {}) {
  const match = passiveMatch(options), shooter = match.players[0], target = match.players[match.size];
  for (const player of match.players) if (player !== shooter && player !== target) { player.alive = false; player.respawnAt = Infinity; }
  place(shooter, 0, 3); place(target, 0, -3);
  return { match, shooter, target };
}
function bodyAim(match, shooter, target, extras = {}) {
  const dx = target.x - shooter.x, dz = target.z - shooter.z;
  match.input(shooter.id, { yaw: Math.atan2(-dx, -dz), pitch: Math.atan2(target.y + 0.95 - getEye(shooter).y, Math.hypot(dx, dz)), fire: true, aim: true, ...extras });
}

test('primary loadout changes only inside the owning cabin and persists through respawn', () => {
  const match = passiveMatch(), player = match.players[0];
  for (const spawn of MAP.spawns) assert.equal(canBuy({ ...spawn, alive: true }), true, 'all classic spawn slots allow B loadout');
  assert.equal(canBuy(player), true);
  player.reloadUntil = match.time + 2;
  assert.equal(match.input(player.id, { primaryWeapon: 2, weapon: 0 }), true, 'selection can arrive with the previous weapon still held');
  advance(match, 0.04);
  assert.equal(player.primaryWeapon, 2); assert.equal(player.weapon, 2); assert.equal(player.reloadUntil, 0);
  assert.equal(match.input(player.id, { weapon: 0 }), false, 'cannot equip a primary absent from loadout');
  assert.equal(match.input(player.id, { weapon: 'ak47' }), false);
  assert.equal(match.input(player.id, { weapon: 3 }), true); advance(match, 0.04); assert.equal(player.weapon, 3);
  assert.equal(match.input(player.id, { primaryWeapon: 2 }), true); advance(match, 0.04); assert.equal(player.weapon, 2, 'B reselect equips the selected primary');
  place(player, 0, 3);
  assert.equal(canBuy(player), false);
  assert.equal(match.input(player.id, { primaryWeapon: 1 }), false);
  const opponentSpawn = MAP.spawns.find(spawn => spawn.team === 1);
  place(player, opponentSpawn.x, opponentSpawn.z); assert.equal(canBuy(player), false);
  place(player, 0, 40, { y: -2.37 }); assert.equal(canBuy(player), false, 'tunnel floor is outside the loadout area');
  player.alive = false; player.respawnAt = match.time + 0.1;
  advance(match, 0.15);
  assert.equal(player.primaryWeapon, 2); assert.equal(player.weapon, 2); assert.equal(player.alive, true);
  assert.equal(player.ammo[4], 0); assert.equal(player.reserve[4], 0);
  assert.equal(match.snapshot().players[0].primaryWeapon, 2);
  assert.ok(JSON.stringify(match.snapshot()).includes('"primaryWeapon":2'));
});

test('native crouch eye and collision height remain aligned and aimed hits use the lowered head', () => {
  assert.equal(CROUCH_HEIGHT, 1.40);
  const { match, shooter, target } = duel();
  match.input(target.id, { crouch: true }); advance(match, .04);
  assert.equal(target.crouching, true); assert.equal(getEye(target).y - target.y, 1.20);
  const dy = getEye(target).y - getEye(shooter).y;
  match.input(shooter.id, { yaw: 0, pitch: Math.atan2(dy, shooter.z - target.z), fire: true, aim: true });
  advance(match, .04);
  assert.equal(target.alive, false); assert.equal(match.events.find(event => event.type === 'kill').headshot, true);
});

test('knife light swings take exactly two hits without head multipliers or frame-rate damage', () => {
  const { match, shooter, target } = duel(); place(target, 0, 1.2);
  match.input(shooter.id, { weapon: 4 }); advance(match, 0.27);
  match.input(shooter.id, { weapon: 4, fire: true, yaw: 0, pitch: 0 }); advance(match, 0.3, 1 / 120);
  assert.equal(target.hp, 50); assert.equal(target.alive, true);
  assert.equal(match.events.filter(event => event.type === 'melee').length, 1, 'held attack respects the swing interval');
  advance(match, 0.3, 1 / 120);
  assert.equal(target.hp, 0); assert.equal(target.alive, false); assert.equal(shooter.kills, 1);
  const hits = match.events.filter(event => event.type === 'hit');
  assert.deepEqual(hits.map(event => event.damage), [50, 50]); assert.ok(hits.every(event => !event.headshot));
  assert.equal(target.killerId, shooter.id); assert.equal(target.deathWeapon, 4); assert.equal(target.deathHeadshot, false);
  assert.ok(target.deathAt > 0); assert.equal(shooter.ammo[4], 0);
});

test('knife right click is a single 100-damage heavy swing and cannot reload or aim', () => {
  const { match, shooter, target } = duel(); place(target, 0, 1.2);
  match.input(shooter.id, { weapon: 'knife' }); advance(match, 0.27);
  match.input(shooter.id, { weapon: 4, altFire: true, fire: true, aim: true, reload: true, yaw: 0, pitch: 0 }); advance(match, 0.2);
  assert.equal(target.alive, false); assert.equal(match.score[0], 1); assert.equal(shooter.reloadUntil, 0); assert.equal(shooter.aiming, false);
  const swing = match.events.find(event => event.type === 'melee');
  assert.equal(swing.heavy, true); assert.equal(swing.targetId, target.id); assert.equal(swing.weapon, 4);
  assert.equal(match.events.find(event => event.type === 'hit').damage, 100);
  assert.equal(match.events.some(event => event.type === 'shot' && event.weapon === 4), false);
});

test('melee enforces distance, facing, friendly immunity, spawn shield and solid occlusion', () => {
  for (const situation of ['far', 'behind', 'friendly', 'shield', 'wall']) {
    const { match, shooter, target } = duel(); place(target, 0, 1.2);
    if (situation === 'far') place(target, 0, 0);
    if (situation === 'behind') place(target, 0, 4.2);
    if (situation === 'friendly') target.team = shooter.team;
    if (situation === 'shield') target.shieldUntil = 10;
    if (situation === 'wall') {
      const solid = MAP.boxes.find(box => box.id === 'classic-147');
      assert.ok(solid, 'classic cabin timber panel provides a real occlusion fixture');
      place(shooter, solid.x, solid.z + solid.d / 2 + 0.45);
      place(target, solid.x, solid.z - solid.d / 2 - 0.45);
      assert.equal(canStandAt(shooter.x, shooter.z), true); assert.equal(canStandAt(target.x, target.z), true);
      assert.equal(lineOfSight(getEye(shooter), getEye(target)), false);
    }
    match.input(shooter.id, { weapon: 4 }); advance(match, 0.27);
    match.input(shooter.id, { weapon: 4, altFire: true, yaw: 0, pitch: 0 }); advance(match, 0.1);
    assert.equal(target.hp, 100, situation); assert.equal(match.score[0], 0, situation);
    assert.equal(match.events.filter(event => event.type === 'melee').length, 1);
  }
});

test('quiet walking halves speed in every direction, keeps firing and legacy sprint cannot boost',()=>{
 const speed=(extra,diagonal=false)=>{const match=passiveMatch(),p=match.players[0];place(p,0,3);match.input(p.id,{forward:1,strafe:diagonal?1:0,...extra});advance(match,.15);return {speed:Math.hypot(p.vx,p.vz),p,match};};
 const normal=speed({}),quiet=speed({walk:true}),diagonal=speed({walk:true},true),legacy=speed({sprint:true});
 assert.ok(Math.abs(quiet.speed/normal.speed-.5)<.001);assert.ok(Math.abs(diagonal.speed-quiet.speed)<.001);assert.equal(quiet.p.walking,true);assert.equal(legacy.speed,normal.speed);assert.equal('sprinting' in quiet.p,false);
 const {match,shooter,target}=duel();bodyAim(match,shooter,target,{walk:true});advance(match,.1);assert.ok(shooter.ammo[0]<30);assert.equal(shooter.walking,true);
});

test('all classic spawn slots have safe routes through the two-door cabins',()=>{
  assert.equal(MAP.spawns.length,16);
  for(const spawn of MAP.spawns){
    assert.ok(canStandAt(spawn.x,spawn.z,spawn.y));
    const route=findPath(spawn,MAP.spawns.find(s=>s.team!==spawn.team));
    assert.ok(route.length>0,'every spawn is connected to the opposing end');
    let from=spawn;
    for(const to of route){
      const count=Math.ceil(Math.hypot(to.x-from.x,to.z-from.z)/.15);
      for(let i=1;i<=count;i++){const x=from.x+(to.x-from.x)*i/count,z=from.z+(to.z-from.z)*i/count,floor=floorAt(x,z,.225,PLAYER_RADIUS);assert.ok(floor>-.25&&canStandAt(x,z,floor,PLAYER_RADIUS),'path respects cargo, door sills and full player clearance');}
      from=to;
    }
  }
  assert.equal(new Match({size:8}).players.length,16);
});

test('both exits on each team allow leaving and returning; the middle wall remains solid',()=>{
  assert.equal(MAP.exits.length,4);
  for(const door of MAP.exits){
    const end=door.team===0?1:-1,match=passiveMatch(),p=match.players[0],yaw=end===1?0:Math.PI;
    place(p,door.x,door.z+end*2.5,{grounded:true});
    match.input(p.id,{forward:1,yaw});advance(match,1.1);
    assert.ok(end*(p.z-door.z)<-.8,'both left and right doors connect to the deck');
    match.input(p.id,{forward:-1,yaw});advance(match,1.1);
    assert.ok(end*(p.z-door.z)>1.6,'both doors allow returning to spawn');
    place(p,0,door.z+end*2,{grounded:true});
    match.input(p.id,{forward:1,yaw});advance(match,1);
    assert.ok(end*(p.z-door.z)>.3,'central cabin wall cannot be walked through');
  }
});

test('human spawn directions point to a usable classic exit',()=>{
  for(const team of [0,1]){
    const match=new Match({size:8}),p=match.addHuman('Door check',team);for(const other of match.players)other.bot=false;
    match.input(p.id,{forward:1,yaw:p.yaw});advance(match,2);
    assert.ok(Math.abs(p.z)<35,'holding W leaves either team spawn');
  }
  for(const spawn of MAP.spawns)assert.ok((spawn.team===0?1:-1)*Math.cos(spawn.yaw)>0,'all slots initially look toward their cabin exits');
});

test('movement keeps diagonal speed and respects convex cargo and hull boundaries',()=>{
  const match=passiveMatch(),p=match.players[0];place(p,0,0);
  match.input(p.id,{forward:1,strafe:1,yaw:0});advance(match,.2);
  assert.ok(Math.abs(Math.hypot(p.x,p.z)-WEAPONS[0].speed*.2)<.005);
  const box=MAP.boxes.find(b=>b.id==='classic-236');
  place(p,box.x,box.z+box.d/2+1,{grounded:true});
  match.input(p.id,{forward:1,yaw:0});advance(match,1);
  assert.ok(p.z>=box.z+box.d/2+PLAYER_RADIUS-.05,'walking cannot enter the crate');
  place(p,MAP.bounds.maxX-1,20);
  match.input(p.id,{strafe:1,yaw:0});advance(match,1);
  assert.ok(p.x<=MAP.bounds.maxX-PLAYER_RADIUS);
});

test('jumping reaches the classic crate top and crouched movement can leave it',()=>{
  const match=passiveMatch(),p=match.players[0],crate=MAP.boxes.find(b=>b.id==='classic-236');
  place(p,crate.x,crate.z+crate.d/2+.7,{grounded:true});
  match.input(p.id,{jump:true,yaw:0});advance(match,19/60,1/60);
  assert.ok(p.y>1.2);
  match.input(p.id,{forward:1,yaw:0});advance(match,17/60,1/60);
  match.input(p.id,{yaw:0});advance(match,.7,1/60);
  assert.ok(Math.abs(p.y-.953333)<.001,'lands on the actual crate surface');
  assert.equal(p.grounded,true);
  match.input(p.id,{strafe:-1,crouch:true,yaw:0});advance(match,2,1/120);
  match.input(p.id,{yaw:0});advance(match,1);
  assert.ok(Math.abs(p.y)<.03,'can step off the crate');
});

test('both below-deck passages have real ceilings and reachable cargo-step exits',()=>{
  for(const tunnel of MAP.tunnels){
    const match=passiveMatch(),p=match.players[0],side=tunnel.side;
    place(p,tunnel.x,tunnel.baseZ,{grounded:true});
    match.input(p.id,{forward:side,yaw:0});advance(match,2,1/60);
    assert.ok(Math.abs(p.y+2.371111)<.001,'entry stairs descend into the passage');
    const ceiling=raycastWorld(getEye(p),{x:0,y:1,z:0},4);
    assert.ok(ceiling&&ceiling.normal.y<-.9,'deck is an actual collision ceiling');
    advance(match,8,1/60);
    assert.ok(Math.abs(p.z-tunnel.exitZ)<2,'reaches the far exit step');
    match.input(p.id,{forward:side,jump:true,yaw:0});advance(match,55/60,1/60);
    assert.ok(Math.abs(p.y+1.026667)<.001,'first jump reaches the exit cargo step');
    match.input(p.id,{yaw:0});advance(match,1/60,1/60);
    match.input(p.id,{strafe:-side,jump:true,yaw:0});advance(match,1.5,1/60);
    assert.ok(Math.abs(p.y)<.03,'second jump exits onto the deck');
    match.input(p.id,{forward:-side,yaw:0});advance(match,1.2,1/60);
    // The classic exit leads to the narrow side lane. Its original three
    // cargo steps reach the high ledge; it is not an invented central door.
    const hop=(travel,duration)=>{
      match.input(p.id,{jump:true,yaw:0});advance(match,.32,1/60);
      match.input(p.id,{...travel,yaw:0});advance(match,duration,1/60);
      match.input(p.id,{yaw:0});advance(match,.7,1/60);
    };
    hop({forward:-side},.25);assert.ok(Math.abs(p.y-.953333)<.001);
    hop({strafe:side},.25);assert.ok(Math.abs(p.y-1.931111)<.001);
    hop({strafe:-side},.4);assert.ok(p.y>2.8,'cargo steps reach the classic high ledge');
    match.input(p.id,{strafe:-side,yaw:0});advance(match,1,1/60);
    match.input(p.id,{yaw:0});advance(match,.8,1/60);
    assert.ok(Math.abs(p.x)<8&&Math.abs(p.y)<.03,'can drop from the ledge into the arena');
  }
});

test('body shots consume ammo, kill, update score and respawn with protection', () => {
  const { match, shooter, target } = duel();
  bodyAim(match, shooter, target); advance(match, 0.36);
  assert.equal(target.alive, false);
  assert.equal(target.hp, 0);
  assert.equal(shooter.kills, 1); assert.equal(target.deaths, 1); assert.equal(match.score[0], 1);
  const hitEvents = match.events.filter(e => e.type === 'hit');
  assert.equal(hitEvents.length, 4);
  assert.ok(hitEvents.every(e => e.damage === WEAPONS[0].damage && !e.headshot));
  assert.equal(shooter.ammo[0], WEAPONS[0].mag - 4);
  match.input(shooter.id, { fire: false }); advance(match, 3.1);
  assert.equal(target.alive, true); assert.equal(target.hp, 100);
  assert.ok(target.shieldUntil > match.time);
  assert.ok(match.events.some(e => e.type === 'respawn' && e.playerId === target.id));
});

test('headshot multiplier, teammate immunity and spawn protection are enforced', () => {
  const { match, shooter, target } = duel();
  target.shieldUntil = 1;
  match.input(shooter.id, { fire: true, aim: true, yaw: 0, pitch: 0 }); advance(match, 0.04);
  assert.equal(target.hp, 100); assert.ok(match.events.some(e => e.type === 'hit' && e.protected));
  match.input(shooter.id, { fire: false }); advance(match, 1);
  match.input(shooter.id, { fire: true, aim: true, yaw: 0, pitch: 0 }); advance(match, 0.04);
  assert.equal(target.alive, false); assert.ok(match.events.some(e => e.type === 'kill' && e.headshot));
  const friendly = match.players[1]; place(friendly, 0, 2);
  match.input(shooter.id, { fire: true, aim: true, yaw: 0, pitch: 0 }); advance(match, 0.5);
  assert.equal(friendly.hp, 100);
});

test('containers occlude shots and raycasts include the floor', () => {
  const { match, shooter, target } = duel();
  const box=MAP.boxes.find(b=>b.id==='classic-236');
  place(shooter, box.x, box.z+box.d/2+1.2); place(target, box.x, box.z-box.d/2-1.2);
  assert.equal(lineOfSight(getEye(shooter), getEye(target)), false);
  bodyAim(match, shooter, target); advance(match, 0.5);
  assert.equal(target.hp, 100); assert.equal(match.score[0], 0);
  assert.ok(match.events.filter(e => e.type === 'shot').every(e => e.surface === 'world'));
  const floor = raycastWorld({ x: 0, y: 2, z: 0 }, { x: 0, y: -1, z: 0 });
  assert.equal(floor.distance, 2); assert.equal(floor.point.y, 0);
});

test('reload timing / reserve transfer, switching and semi-auto trigger are meaningful', () => {
  const { match, shooter } = duel();
  shooter.ammo[0] = 7; shooter.reserve[0] = 15;
  match.input(shooter.id, { reload: true }); advance(match, 0.05);
  assert.ok(shooter.reloadUntil > match.time);
  match.input(shooter.id, { fire: true }); advance(match, 0.3);
  assert.equal(shooter.ammo[0], 7, 'cannot fire while loading');
  match.input(shooter.id, {}); advance(match, WEAPONS[0].reload);
  assert.equal(shooter.ammo[0], 22); assert.equal(shooter.reserve[0], 0); assert.equal(shooter.reloadUntil, 0);
  match.input(shooter.id, { weapon: 'usp', fire: true }); advance(match, 1);
  assert.equal(shooter.weapon, 3);
  assert.equal(shooter.ammo[3], WEAPONS[3].mag - 1, 'held semi-auto trigger emits only one shot');
  match.input(shooter.id, { weapon: 3, fire: false }); advance(match, 0.25);
  match.input(shooter.id, { weapon: 3, fire: true }); advance(match, 0.1);
  assert.equal(shooter.ammo[3], WEAPONS[3].mag - 2);
});

test('score limit, timeout tie, frozen end state and restart preserve humans', () => {
  const { match, shooter, target } = duel({ goal: 1 });
  match.input(shooter.id, { fire: true, aim: true, yaw: 0, pitch: 0 }); advance(match, 0.1);
  assert.equal(target.alive, false); assert.equal(match.status, 'ended'); assert.equal(match.winner, 0);
  const endTime = match.time; advance(match, 1); assert.equal(match.time, endTime);
  const endSeq = match.events.at(-1).seq;
  match.restart();
  assert.equal(match.status, 'playing'); assert.deepEqual(match.score, [0, 0]); assert.equal(shooter.kills, 0);
  assert.equal(shooter.bot, false); assert.equal(shooter.hp, 100);
  assert.ok(match.events.at(-1).seq > endSeq);
  const timed = passiveMatch({ duration: 5 }); advance(timed, 5.1);
  assert.equal(timed.status, 'ended'); assert.equal(timed.winner, null); assert.equal(timed.time, 5);
});

test('human slots are fixed, room capacity is enforced and disconnect fills with AI', () => {
  const match = new Match({ size: 8 });
  const first = match.addHuman('<Alice>', 1);
  assert.equal(first.team, 1); assert.equal(first.name, 'Alice'); assert.equal(first.bot, false); assert.equal(first.human, true);
  first.kills = 3; first.deaths = 2; match.score[1] = 6;
  const identity = first.id;
  assert.equal(match.removeHuman(identity), true);
  assert.equal(first.bot, true); assert.equal(first.human, false); assert.equal(first.id, identity);
  assert.equal(first.kills, 3); assert.equal(first.deaths, 2); assert.equal(match.score[1], 6);
  for (let i = 0; i < 16; i++) assert.ok(match.addHuman(`client-${i}`));
  assert.equal(match.addHuman('overflow'), null);
  assert.equal(match.players.length, 16);
  assert.equal(match.input('missing', { fire: true }), false);
  const snapshot = match.snapshot();
  assert.doesNotThrow(() => JSON.stringify(snapshot));
  assert.ok(snapshot.players.every(p => Object.keys(p).every(key => !key.startsWith('_'))));
  snapshot.players[0].ammo[0] = -500;
  assert.notEqual(match.players[0].ammo[0], -500, 'snapshots detach ammo arrays');
});

test('all-bot 4v4 and 8v8 matches navigate, recover from low ammo, fight and reach a winner', () => {
  for (const size of [4, 8]) {
    const match = new Match({ size, goal: 40, duration: 180, difficulty: 'normal', seed: 12345 });
    // The low-ammo start exercises the AI's reload decision without depending
    // on one bot surviving long enough to empty an entire fresh magazine.
    for (const player of match.players) player.ammo[player.weapon] = 3;
    let furthest = 0, reloads = 0, shots = 0, kills = 0, respawns = 0, seenSeq = 0;
    for (let i = 0; i < 1800 && match.status === 'playing'; i++) {
      match.step(0.1);
      for (const p of match.players) furthest = Math.max(furthest, 29 - Math.abs(p.z));
      for (const event of match.events) if (event.seq > seenSeq) {
        if (event.type === 'reload') reloads++;
        if (event.type === 'shot') shots++;
        if (event.type === 'kill') kills++;
        if (event.type === 'respawn') respawns++;
      }
      seenSeq = match.events.at(-1)?.seq ?? seenSeq;
    }
    assert.ok(furthest > 18, `${size}v${size} bots leave their bases and advance`);
    assert.ok(shots > 60, `${size}v${size} bots engage`);
    assert.ok(kills >= 40, `${size}v${size} bots kill and score`);
    assert.ok(reloads > 0, `${size}v${size} bots reload`);
    assert.ok(respawns > 0, `${size}v${size} bots return after death`);
    assert.equal(match.status, 'ended'); assert.ok(match.winner === 0 || match.winner === 1);
    assert.equal(Math.max(...match.score), 40);
    assert.ok(match.events.length <= 128);
    for (const player of match.players) assert.ok(Number.isFinite(player.x + player.y + player.z + player.yaw + player.pitch));
  }
});

test('seeded simulation produces repeatable snapshots', () => {
  const a = new Match({ seed: 77 }), b = new Match({ seed: 77 });
  advance(a, 12, 0.1); advance(b, 12, 0.1);
  assert.deepEqual(a.snapshot(), b.snapshot());
  assert.equal(PLAYER_HEIGHT > 1.5, true);
});
