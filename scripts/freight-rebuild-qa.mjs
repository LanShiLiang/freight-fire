import { chromium } from 'playwright';
import { mkdir, writeFile } from 'node:fs/promises';
import assert from 'node:assert/strict';
import path from 'node:path';
import { makeServer } from './serve.mjs';
import { root } from './catalog.mjs';
import { MAP } from '../games/freight-fire/sim.js';

// Position/health fixtures are limited to the explicitly enabled ?qa=1 build.
// All loadout, equipment, scope, attacks and respawn inputs use real keyboard,
// pointer or on-screen UI events. The collapse/corpse view uses a documented
// death-state fixture; actual knife deaths are separately exercised below.
const out = path.join(root, 'artifacts', 'freight-rebuild');
await mkdir(out, { recursive: true });
const report = {
  date: new Date().toISOString(), checks: [], animations: [], audio: [],
  screenshots: [], errors: [], failedRequests: [],
  limitations: ['One Windows Chrome session, not multiple physical computers.',
    'Enemy positions, health and initial facing use local QA fixtures.',
    'Local death camera uses an identified snapshot fixture; melee damage uses actual mouse attacks.']
};
const check = (name, detail) => { report.checks.push({ name, passed: true, detail }); console.log('PASS ' + name); };
let server, browser, page;
const shot = async name => {
  const filename = name + '.png'; await page.screenshot({ path: path.join(out, filename) });
  report.screenshots.push(filename);
};
const state = () => page.evaluate(() => {
  const p = __freight.snapshot.players.find(player => player.id === __freight.localId);
  return { weapon: p.weapon, primaryWeapon: p.primaryWeapon, hp: p.hp, alive: p.alive,
    ammo: [...p.ammo], reserve: [...p.reserve], input: structuredClone(__freight.input),
    zoomLevel: __freight.zoomLevel, time: __freight.snapshot.time,
    view: structuredClone(__freight.view.viewModel.diagnostics || {}) };
});
async function equip(key, index) {
  await page.keyboard.press(key);
  await page.waitForFunction(index => __freight.snapshot.players.find(p => p.id === __freight.localId).weapon === index, index);
}
async function buy(index) {
  await page.keyboard.press('KeyB'); await page.locator('#loadout').waitFor({ state: 'visible' });
  await page.locator(`button[data-primary="${index}"]`).click();
  await page.locator('#loadout').waitFor({ state: 'hidden' });
  await page.waitForFunction(index => {
    const p = __freight.snapshot.players.find(p => p.id === __freight.localId);
    return p.primaryWeapon === index && p.weapon === index;
  }, index);
  await page.waitForFunction(() => document.pointerLockElement?.id === 'arena');
}
async function fireGun(bank) {
  const before = await state(), start = await page.evaluate(() => __qaAudio.length);
  await page.mouse.down(); await page.waitForTimeout(40); await page.mouse.up();
  await page.waitForFunction(before => {
    const p = __freight.snapshot.players.find(player => player.id === __freight.localId);
    return p.ammo[p.weapon] < before.ammo[before.weapon];
  }, before);
  const result = await page.evaluate(start => ({ calls: __qaAudio.slice(start),
    recoil: { pitch: __freight.view.recoilPitch, yaw: __freight.view.recoilYaw,
      kick: __freight.view.kick }, sample: __freight.audio.lastSample }), start);
  assert.ok(result.calls.some(call => call.bank === bank && call.running), 'actual gun event must play ' + bank);
  assert.ok(Math.abs(result.recoil.pitch || 0) + Math.abs(result.recoil.yaw || 0) + Math.abs(result.recoil.kick || 0) > 0, 'actual shot moves the recoil camera');
  check('Actual ' + bank + ' fire consumes ammo, plays its CS2 bank and applies camera recoil', result);
}
async function positionFixture({ base = false, distance = 1.7, hp = 100, bodyAim = false, targetAlive = true } = {}) {
  await page.mouse.up({ button: 'left' }); await page.mouse.up({ button: 'right' });
  await page.evaluate(options => {
    const match = __freight.match, p = match.players.find(player => player.id === __freight.localId);
    const target = match.players.find(player => player.team !== p.team);
    for (const other of match.players) if (other.id !== p.id) {
      other.bot = false; other._input = {}; other.alive = false; other.respawnAt = Infinity;
      other.moving = false; other.vx = 0; other.vy = 0; other.vz = 0;
      // Inactive actors must leave the camera, rather than becoming visible
      // corpses at their original adjacent spawn slots in ready-pose captures.
      Object.assign(other, { x: 1000 + other._index, y: 0, z: 1000 });
      const group = __freight.view.players.get(other.id)?.group;
      group?.position.set(other.x, 0, other.z);
      group?.userData.deathOrigin?.set(other.x, 0, other.z);
    }
    const x = options.base ? -6.6 : 0, z = options.base ? 40 : 3;
    Object.assign(p, { x, y: 0, z, yaw: 0, pitch: 0, alive: true, hp: 100,
      shieldUntil: 0, reloadUntil: 0, vx: 0, vy: 0, vz: 0, grounded: true,
      _nextShot: 0, _equipUntil: 0, _fireHeld: false, _input: {} });
    const pitch = options.bodyAim ? Math.atan2(.95 - 1.58, options.distance) : 0;
    Object.assign(__freight.input, { yaw: 0, pitch, fire: false, altFire: false, aim: false,
      reload: false, forward: 0, strafe: 0, weapon: p.weapon });
    const targetX = options.targetAlive ? x : 1000, targetZ = options.targetAlive ? z - options.distance : 1000;
    Object.assign(target, { x: targetX, y: 0, z: targetZ, yaw: Math.PI, pitch: 0,
      hp: options.hp, alive: options.targetAlive, shieldUntil: 0, reloadUntil: 0,
      respawnAt: Infinity, vy: 0, grounded: true, _input: {} });
    const targetGroup = __freight.view.players.get(target.id)?.group;
    targetGroup?.position.set(targetX, 0, targetZ); targetGroup?.userData.deathOrigin?.set(targetX, 0, targetZ);
    window.__qaTargetId = target.id;
  }, { base, distance, hp, bodyAim, targetAlive });
  await page.waitForTimeout(100);
}
async function sampleAction(name, expected, trigger, milliseconds = 220) {
  const before = await state(); await trigger();
  const frames = [];
  for (let elapsed = 0; elapsed <= milliseconds; elapsed += 20) {
    frames.push(await state()); await page.waitForTimeout(20);
  }
  const states = [...new Set(frames.map(frame => frame.view.state))];
  report.animations.push({ name, before, states, frames });
  assert.ok(states.includes(expected), `${name}: expected ${expected}, observed ${JSON.stringify(states)}`);
  for (const frame of frames) {
    assert.equal(frame.view.authored, true); assert.equal(frame.view.boneIK, false);
    assert.ok(Number.isFinite(frame.view.clipTime));
    assert.ok(frame.view.attachmentError < 1e-5, `${name}: weapon attachment must follow original animated anchor`);
  }
  return frames;
}

try {
  server = makeServer(root); await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  browser = await chromium.launch({ channel: 'chrome', headless: true, args: ['--no-first-run'] });
  report.browser = browser.version();
  const context = await browser.newContext({ viewport: { width: 1500, height: 900 } });
  page = await context.newPage();
  page.on('pageerror', error => report.errors.push(error.message));
  page.on('response', response => { if (response.status() >= 400) report.failedRequests.push({ status: response.status(), url: response.url() }); });
  await page.goto(`http://127.0.0.1:${server.address().port}/games/freight-fire/?qa=1`);
  await page.waitForFunction(() => window.__freight?.view?.viewModel);
  await page.locator('#loading').waitFor({ state: 'hidden' });
  assert.equal(await page.locator('#sound').count(), 0);
  assert.doesNotMatch(await page.locator('#menu').innerText(), /音效开启|建议佩戴耳机/);
  await shot('01-menu'); check('Homepage has no sound toggle or headphone prompt', true);
  await page.locator('#start').click();
  await page.waitForFunction(() => !__freight.paused && document.pointerLockElement?.id === 'arena');
  await page.waitForFunction(() => __freight.audio.ctx?.state === 'running');
  const audio = await page.evaluate(() => {
    const a = __freight.audio, files = [...new Set(Object.values(a.banks).flat())];
    window.__qaAudio = [];
    const original = a.play.bind(a);
    a.play = (bank, options) => {
      const entry = { bank, options: { ...options }, at: performance.now(), running: a.ctx.state === 'running' };
      window.__qaAudio.push(entry); return original(bank, options);
    };
    return { enabled: a.enabled, state: a.ctx.state, decoded: a.samples.size,
      expected: files.length, errors: [...a.loadErrors], banks: Object.keys(a.banks) };
  });
  assert.equal(audio.enabled, true); assert.equal(audio.decoded, audio.expected); assert.deepEqual(audio.errors, []);
  for (const bank of ['m4a1', 'ak47', 'awp', 'usp', 'knifeDraw', 'knifeSwing', 'knifeHeavySwing', 'kill', 'headHit']) assert.ok(audio.banks.includes(bank), bank);
  check('Sound starts automatically on entering battle and CS2 banks all decode', audio);
  await positionFixture({ targetAlive: false });
  await page.waitForTimeout(650); await shot('02-m4a1s-ready');
  assert.equal(await page.locator('#weapon-slots [data-equip-slot]').count(), 3);
  const slots = await page.locator('#weapon-slots [data-equip-slot]').evaluateAll(nodes => nodes.map(node => node.dataset.equipSlot));
  assert.deepEqual(slots, ['1', '2', '3']); check('Weapon bar contains primary, sidearm and knife slots', slots);
  await positionFixture({ base: true, targetAlive: false });
  await page.keyboard.press('KeyB'); await page.locator('#loadout').waitFor({ state: 'visible' });
  await shot('03-base-loadout'); await page.locator('button[data-primary="1"]').click();
  await page.locator('#loadout').waitFor({ state: 'hidden' });
  await page.waitForFunction(() => { const p = __freight.snapshot.players.find(p => p.id === __freight.localId); return p.primaryWeapon === 1 && p.weapon === 1; });
  await page.waitForFunction(() => document.pointerLockElement?.id === 'arena');
  await page.waitForTimeout(550); await fireGun('ak47');
  await equip('Digit2', 3); await page.waitForTimeout(550); await fireGun('usp'); await equip('Digit1', 1);
  await sampleAction('Knife equip uses an authored draw animation', 'draw', () => equip('Digit3', 4));
  await page.waitForTimeout(450); await shot('04-knife-ready');
  await page.keyboard.press('Digit4'); await page.waitForTimeout(100);
  assert.equal((await state()).weapon, 4, 'Digit4 must not equip another primary');
  await equip('Digit1', 1);
  await page.mouse.wheel(0, 120); await page.waitForFunction(() => __freight.snapshot.players.find(p => p.id === __freight.localId).weapon === 3);
  await page.mouse.wheel(0, 120); await page.waitForFunction(() => __freight.snapshot.players.find(p => p.id === __freight.localId).weapon === 4);
  await page.mouse.wheel(0, 120); await page.waitForFunction(() => __freight.snapshot.players.find(p => p.id === __freight.localId).weapon === 1);
  check('B buys AK; 1/2/3 and wheel select only the three owned slots; 4 does nothing', await state());

  await positionFixture({ targetAlive: false });
  await page.keyboard.press('KeyB'); await page.waitForTimeout(150);
  assert.equal(await page.locator('#loadout').isVisible(), false); assert.equal((await state()).primaryWeapon, 1);
  check('B is rejected outside the owning spawn cabin', true);
  await positionFixture({ base: true, targetAlive: false });
  await buy(2); await page.waitForTimeout(700);
  await positionFixture({ targetAlive: false });
  const scopeFovs = [];
  for (const level of [1, 2, 0]) {
    await page.mouse.down({ button: 'right' }); await page.waitForTimeout(30); await page.mouse.up({ button: 'right' });
    await page.waitForFunction(level => __freight.zoomLevel === level, level); await page.waitForTimeout(350);
    const scope = await page.evaluate(() => ({ level: __freight.zoomLevel, attribute: document.querySelector('#scope').dataset.level,
      visible: !document.querySelector('#scope').hidden, fov: __freight.view.camera.fov,
      viewVisible: __freight.view.view.visible }));
    assert.equal(scope.visible, level !== 0);
    if (level) assert.equal(Number(scope.attribute), level);
    scopeFovs.push(scope); if (level === 2) await shot('05-awp-double-zoom');
  }
  assert.ok(scopeFovs[1].fov < scopeFovs[0].fov); assert.ok(scopeFovs[2].fov > scopeFovs[0].fov);
  check('AWP right click cycles two magnifications and returns to normal sight', scopeFovs);
  await fireGun('awp');

  await equip('Digit3', 4); await page.waitForTimeout(500);
  await positionFixture({ distance: 1.7 });
  const emptyBefore = (await state()).ammo[4];
  await sampleAction('Knife light attack follows authored blade motion', 'shoot', async () => { await page.mouse.down(); await page.waitForTimeout(30); await page.mouse.up(); });
  const light = await page.evaluate(() => ({ target: __freight.match.players.find(p => p.id === __qaTargetId).hp,
    events: __freight.snapshot.events.filter(e => e.type === 'melee' || e.type === 'hit').slice(-3) }));
  assert.equal(light.target, 50); assert.ok(light.events.some(e => e.type === 'hit' && e.damage === 50 && !e.headshot));
  await shot('06-knife-light'); await page.waitForTimeout(400);
  await page.mouse.down(); await page.waitForTimeout(30); await page.mouse.up();
  await page.waitForFunction(() => !__freight.match.players.find(p => p.id === __qaTargetId).alive);
  assert.equal((await state()).ammo[4], emptyBefore); check('Two real left-click knife attacks defeat a full-health enemy', light);
  await positionFixture({ distance: 1.7 });
  await sampleAction('Knife right click follows authored heavy motion', 'heavy', async () => { await page.mouse.down({ button: 'right' }); await page.waitForTimeout(30); await page.mouse.up({ button: 'right' }); });
  const heavy = await page.evaluate(() => ({ target: __freight.match.players.find(p => p.id === __qaTargetId).hp,
    hit: __freight.snapshot.events.filter(e => e.type === 'hit' && e.targetId === __qaTargetId).at(-1), zoom: __freight.zoomLevel }));
  assert.equal(heavy.target, 0); assert.equal(heavy.hit.damage, 100); assert.equal(heavy.hit.heavy, true); assert.equal(heavy.zoom, 0);
  await shot('07-knife-heavy'); check('One real right-click heavy knife attack deals 100 without opening scope', heavy);
  await positionFixture({ distance: 8 });
  await page.mouse.down(); await page.waitForTimeout(30); await page.mouse.up(); await page.waitForTimeout(120);
  assert.equal((await state()).ammo[4], 0); assert.equal(await page.evaluate(() => __freight.match.players.find(p => p.id === __qaTargetId).hp), 100);
  check('Empty knife swing does not consume ammunition or hit distant enemies', true);

  await positionFixture({ base: true, targetAlive: false }); await buy(0); await page.waitForTimeout(500);
  await positionFixture({ distance: 4 });
  const initialLog = await page.evaluate(() => __qaAudio.length);
  await page.mouse.down(); await page.waitForTimeout(20); await page.mouse.up();
  await page.waitForFunction(() => !__freight.match.players.find(p => p.id === __qaTargetId).alive);
  await page.waitForTimeout(150);
  const feedback = await page.evaluate(start => __qaAudio.slice(start).filter(e => e.bank === 'headHit' || e.bank === 'kill'), initialLog);
  assert.ok(await page.evaluate(start => __qaAudio.slice(start).some(e => e.bank === 'm4a1' && e.running), initialLog));
  assert.equal(feedback.filter(e => e.bank === 'headHit').length, 1, 'headshot sample must not play again at kill event');
  assert.equal(feedback.filter(e => e.bank === 'kill').length, 1); assert.ok(feedback.every(e => e.running));
  const feed = await page.locator('#killfeed .feed-line').last().evaluate(node => ({
    html: node.outerHTML, text: node.textContent, svg: node.querySelectorAll('svg,img[src$=".svg"]').length,
    local: node.classList.contains('local'), headshot: !!node.querySelector('[data-headshot],.feed-headshot,.headshot-icon'),
    borderWidth: getComputedStyle(node).borderWidth, borderColor: getComputedStyle(node).borderColor,
    position: node.getBoundingClientRect().toJSON()
  }));
  assert.ok(feed.svg >= 1, 'CS2 kill feed should use weapon silhouette'); assert.equal(feed.local, true); assert.equal(feed.headshot, true);
  assert.ok(feed.position.x > 750, 'kill feed belongs in upper-right');
  assert.ok(feed.position.y < 250, 'kill feed belongs near the top');
  await shot('08-headshot-killfeed'); check('Headshot plays one headHit + one kill cue; right-top CS2 kill feed shows weapon, headshot and local border', { feedback, feed });

  await positionFixture({ distance: 4 });
  await page.evaluate(() => {
    const match = __freight.match, p = match.players.find(p => p.id === __freight.localId), enemy = match.players.find(p => p.id === __qaTargetId);
    Object.assign(p, { hp: 0, alive: false, respawnAt: match.time + 3, killerId: enemy.id,
      deathWeapon: 1, deathHeadshot: false, deathAt: match.time, moving: false, vx: 0, vy: 0, vz: 0 });
  });
  await page.locator('#death').waitFor({ state: 'visible' }); await page.waitForTimeout(220);
  const collapse = await page.evaluate(() => ({ stats: structuredClone(__freight.view.deathCameraStats),
    gunVisible: __freight.view.view.visible, camera: __freight.view.camera.position.toArray() }));
  assert.equal(collapse.stats.phase, 'collapse'); assert.equal(collapse.gunVisible, false);
  assert.ok(collapse.camera[1] < 1.58); assert.ok(collapse.camera.every(Number.isFinite));
  await shot('09-death-collapse'); await page.waitForTimeout(1100);
  const corpse = await page.evaluate(() => ({ stats: structuredClone(__freight.view.deathCameraStats),
    camera: __freight.view.camera.position.toArray(), bodyVisible: __freight.view.players.get(__freight.localId).group.visible }));
  assert.equal(corpse.stats.phase, 'corpse'); assert.equal(corpse.stats.showBody, true); assert.equal(corpse.bodyVisible, true);
  assert.ok(corpse.camera[1] >= corpse.stats.ground + .24); assert.ok(corpse.camera.every(Number.isFinite));
  assert.ok(Math.hypot(...corpse.camera.map((value, index) => value - collapse.camera[index])) > .25);
  await shot('10-death-corpse');
  await page.waitForFunction(() => __freight.snapshot.players.find(p => p.id === __freight.localId).alive);
  // Sample the first living frame, before the HUD's 100 ms refresh interval.
  // Returning to the same primary must still restart its authored draw clip.
  const firstRespawnFrame = await page.evaluate(() => {
    const p = __freight.snapshot.players.find(player => player.id === __freight.localId);
    return { player: { x: p.x, y: p.y, z: p.z, team: p.team, crouching: p.crouching },
      camera: __freight.view.camera.position.toArray(),
      viewState: __freight.view.viewModel.diagnostics.state,
      clip: __freight.view.viewModel.diagnostics.clip,
      deathCamera: __freight.view.deathCameraStats };
  });
  assert.equal(firstRespawnFrame.viewState, 'draw', 'same-primary respawn must restart its original draw animation');
  assert.equal(firstRespawnFrame.deathCamera, null);
  const p = firstRespawnFrame.player, expectedEye = p.y + (p.crouching ? 1.20 : 1.58);
  assert.ok(MAP.spawns.some(spawn => spawn.team === p.team && Math.hypot(spawn.x - p.x, spawn.z - p.z) < .001), 'respawn snapshot must be inside an actual classic spawn slot');
  assert.ok(Math.hypot(firstRespawnFrame.camera[0] - p.x, firstRespawnFrame.camera[1] - expectedEye, firstRespawnFrame.camera[2] - p.z) < .05,
    'camera must immediately return to spawn instead of interpolating across the map from the corpse');
  await page.locator('#death').waitFor({ state: 'hidden' });
  const respawn = await state(); assert.equal(respawn.weapon, respawn.primaryWeapon); assert.equal(respawn.input.weapon, respawn.primaryWeapon);
  assert.equal(await page.evaluate(() => __freight.view.deathCameraStats), null);
  check('Death camera descends, shows a grounded corpse, then draws primary and returns camera/input directly to spawn', { collapse, corpse, firstRespawnFrame, respawn });
  report.audio = await page.evaluate(() => __qaAudio); report.performance = await page.evaluate(() => ({ ...__freight.view.stats }));
  assert.deepEqual(report.errors, []); assert.deepEqual(report.failedRequests, []);
  check('No JavaScript exceptions or missing model, texture or audio assets', true);
} catch (error) {
  report.failure = error.stack;
  if (page) await shot('failure').catch(() => {});
  throw error;
} finally {
  await writeFile(path.join(out, 'report.json'), JSON.stringify(report, null, 2));
  await browser?.close();
  if (server) await new Promise(resolve => server.close(resolve));
  console.log('Report: ' + path.join(out, 'report.json'));
}
