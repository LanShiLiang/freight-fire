import { chromium } from 'playwright';
import { mkdir, writeFile } from 'node:fs/promises';
import assert from 'node:assert/strict';
import path from 'node:path';
import { root } from './catalog.mjs';

// Public deployment smoke test. QA inspection is read-only: no actor, match,
// camera, audio or input objects are patched. All play uses real UI/keys/mouse.
const target = new URL(process.env.FREIGHT_PUBLIC_URL || 'https://lslzqco.cn/ai-game-lab/games/freight-fire/?qa=1');
if (!['http:', 'https:'].includes(target.protocol) || target.username || target.password) throw Error('Use a plain HTTP(S) FPS URL');
target.searchParams.set('qa', '1');
const out = path.join(root, 'artifacts', 'freight-public');
await mkdir(out, { recursive: true });
const report = { date: new Date().toISOString(), url: target.href, checks: [], stages: [], screenshots: [],
  errors: [], failedRequests: [], responses: [], limitations: [
    'One real Chrome session on the public deployment; local bot mode only.',
    'QA globals are read only; no fixture teleport, health/death or audio instrumentation.',
    'AudioContext/sample/voice state verifies playback; physical speaker output is not measured.'
  ] };
const started = Date.now();
let browser, page, pulse, closing = false, stageName = 'launch';
function stage(name) { stageName = name; report.stages.push({ name, elapsedMs: Date.now() - started }); console.log('STAGE ' + name); }
function check(name, detail) { report.checks.push({ name, passed: true, detail }); console.log('PASS ' + name); }
async function screenshot(name) { const file = name + '.png'; await page.screenshot({ path: path.join(out, file) }); report.screenshots.push(file); console.log('SCREENSHOT ' + file); }
async function state() {
  return page.evaluate(() => {
    const f = window.__freight, p = f?.snapshot?.players.find(player => player.id === f.localId), audio = f?.audio;
    if (!p) return null;
    return { time: f.snapshot.time, playerCount: f.snapshot.players.length, bots: f.snapshot.players.filter(player => player.bot).length,
      alive: p.alive, hp: p.hp, weapon: p.weapon, primaryWeapon: p.primaryWeapon, position: [p.x, p.y, p.z],
      ammo: [...p.ammo], zoomLevel: f.zoomLevel, fov: f.view.camera.fov, aspect: f.view.camera.aspect,
      viewVisible: f.view.viewModel.group.visible, view: structuredClone(f.view.viewModel.diagnostics),
      audio: { enabled: audio.enabled, state: audio.ctx?.state, samples: audio.samples.size,
        expected: new Set(Object.values(audio.banks).flat()).size, banks: Object.keys(audio.banks), errors: [...audio.loadErrors],
        sampleCount: audio.sampleCount, lastSample: audio.lastSample ? { ...audio.lastSample } : null,
        shotVoices: [...audio.voices].filter(voice => voice.channel === 'shot').length } };
  });
}
async function alive() { await page.waitForFunction(() => { const f = window.__freight; return f?.snapshot?.players.find(p => p.id === f.localId)?.alive; }, null, { timeout: 10000 }); }
async function buy(index) {
  await alive(); await page.keyboard.press('KeyB');
  await page.locator('#loadout').waitFor({ state: 'visible', timeout: 5000 });
  await page.locator(`button[data-primary="${index}"]`).click();
  await page.locator('#loadout').waitFor({ state: 'hidden' });
  await page.waitForFunction(index => { const f = __freight, p = f.snapshot.players.find(p => p.id === f.localId); return p.primaryWeapon === index && p.weapon === index; }, index);
  await page.waitForTimeout(750);
}
async function equip(key, index) {
  await page.keyboard.press(key);
  await page.waitForFunction(index => { const f = __freight; return f.snapshot.players.find(p => p.id === f.localId).weapon === index; }, index);
}
async function scope(level) {
  await page.mouse.down({ button: 'right' }); await page.waitForTimeout(35); await page.mouse.up({ button: 'right' });
  await page.waitForFunction(level => __freight.zoomLevel === level && document.querySelector('#scope').dataset.level === String(level), level);
  await page.waitForTimeout(350);
  const current = await state(); assert.equal(current.zoomLevel, level); assert.equal(current.viewVisible, level === 0);
  if (level) {
    const expected = 360 / Math.PI * Math.atan(Math.tan((level === 2 ? 10 : 40) * Math.PI / 360) / .7 / current.aspect);
    assert.ok(Math.abs(current.fov - expected) < .8, 'scope projection uses reference magnification × 0.7');
    await screenshot(level === 1 ? '04-scope-level-1' : '05-scope-level-2');
  }
  return current;
}

try {
  stage('Launch a fresh Chrome context');
  browser = await chromium.launch({ channel: 'chrome', headless: true, args: ['--no-first-run'] });
  report.browser = browser.version();
  const context = await browser.newContext({ viewport: { width: 1500, height: 900 } });
  page = await context.newPage(); page.setDefaultTimeout(15000); page.setDefaultNavigationTimeout(180000);
  page.on('pageerror', error => report.errors.push(error.message));
  page.on('requestfailed', request => { if (!closing) report.failedRequests.push({ url: request.url(), error: request.failure()?.errorText }); });
  page.on('response', response => {
    const headers = response.headers();
    report.responses.push({ url: response.url(), status: response.status(), bytes: Number(headers['content-length'] || 0), encoding: headers['content-encoding'] || null });
    if (response.status() >= 400) report.failedRequests.push({ url: response.url(), status: response.status() });
  });
  pulse = setInterval(() => console.log('PROGRESS ' + JSON.stringify({ stage: stageName, elapsedSeconds: Math.round((Date.now() - started) / 1000), responses: report.responses.length, failures: report.failedRequests.length })), 10000);
  stage('Load public HTML and local assets; allow three minutes for first cloud load');
  await page.goto(target.href, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => window.__freight?.view?.viewModel, null, { timeout: 180000 });
  await page.locator('#loading').waitFor({ state: 'hidden', timeout: 180000 });
  report.readyMs = Date.now() - started;
  assert.equal(await page.locator('body').getAttribute('data-static'), 'true');
  assert.equal(await page.locator('[data-mode="lan"]').isVisible(), false);
  assert.equal(await page.locator('#sound').count(), 0);
  assert.doesNotMatch(await page.locator('#menu').innerText(), /音效开启|建议佩戴耳机/);
  check('Public static homepage loads without LAN or sound prompts', { readyMs: report.readyMs });
  await screenshot('01-public-menu');

  stage('Start a real bot match with the normal Start button');
  await page.locator('#nickname').fill('公网验收');
  await page.locator('#size').selectOption('4'); await page.locator('#difficulty').selectOption('easy');
  await page.locator('#goal').selectOption('80'); await page.locator('#start').click();
  await page.waitForFunction(() => __freight.snapshot?.players.some(p => p.id === __freight.localId), null, { timeout: 180000 });
  await page.locator('#menu').waitFor({ state: 'hidden' }); await page.locator('#hud').waitFor({ state: 'visible' });
  await page.waitForTimeout(750);
  const initial = await state(); assert.equal(initial.playerCount, 8); assert.equal(initial.bots, 7); assert.equal(initial.weapon, 0);
  assert.match(initial.view.asset, /m4a1-golden-coil/); assert.ok(initial.view.attachmentError < 1e-5);
  // Audio is optional background work. Observe its real completion without
  // making that download a requirement for clicking Start or moving.
  await page.evaluate(async()=>{const audio=window.__freight.audio;await audio.ready;await audio.decoded;});
  Object.assign(initial.audio,(await state()).audio);
  assert.equal(initial.audio.enabled, true); assert.equal(initial.audio.state, 'running');
  assert.equal(initial.audio.samples, initial.audio.expected); assert.ok(initial.audio.samples > 0); assert.deepEqual(initial.audio.errors, []);
  for (const bank of ['m4a1', 'ak47', 'awp', 'knifeDraw', 'kill', 'headHit']) assert.ok(initial.audio.banks.includes(bank), bank);
  check('Live 4v4 match uses Golden Coil and default decoded CS2 audio', initial);
  await screenshot('02-public-m4a1');

  stage('Use B at the actual spawn cabin to equip AK');
  await buy(1); const ak = await state(); assert.match(ak.view.asset, /ak47-docksteel/); assert.ok(ak.view.attachmentError < 1e-5);
  check('Real B purchase equips the original Dock Steel AK', ak); await screenshot('03-public-ak47');

  stage('Use B to equip AWP and cycle both scope levels');
  await buy(2); assert.match((await state()).view.asset, /awp-dragon-lore/);
  const scope1 = await scope(1), scope2 = await scope(2); assert.ok(scope2.fov < scope1.fov); const unscoped = await scope(0);
  check('AWP cycles two reduced magnifications and exits the scope', { first: scope1.fov, second: scope2.fov, unscoped: unscoped.fov });

  stage('Use the three owned weapon slots and draw the knife');
  await equip('Digit2', 3); await equip('Digit3', 4); await page.waitForTimeout(650);
  const knife = await state(); assert.equal(knife.primaryWeapon, 2); assert.equal(knife.view.melee, true); assert.match(knife.view.asset, /karambit-sapphire/);
  assert.equal(await page.locator('#ammo-line').isVisible(), false);
  assert.equal(await page.locator('#weapon-slots [data-equip-slot]').count(), 3);
  await page.keyboard.press('Digit4'); await page.waitForTimeout(100); assert.equal((await state()).weapon, 4);
  await screenshot('06-public-knife'); await equip('Digit1', 2);
  check('Sidearm, knife and primary slots work; Digit4 cannot change primary', knife);

  stage('Exercise WASD movement through real keys without state fixtures');
  await alive(); const movements = [];
  for (const key of ['KeyW', 'KeyS', 'KeyD', 'KeyA']) {
    const before = await state(); await page.keyboard.down(key); await page.waitForTimeout(240); await page.keyboard.up(key); const after = await state();
    movements.push({ key, before: before.position, after: after.position, distance: Math.hypot(after.position[0] - before.position[0], after.position[2] - before.position[2]), alive: after.alive });
  }
  assert.ok(movements.some(move => move.distance > .2), 'real movement must change world position');
  check('Real WASD input changes the local player world position', movements); await screenshot('07-public-battle');
  assert.deepEqual(report.errors, []); assert.deepEqual(report.failedRequests, []);
  report.ok = true; check('Public session has no JavaScript or asset request failures', { responses: report.responses.length });
} catch (error) {
  report.ok = false; report.failure = error.stack || String(error); console.error('FAIL ' + report.failure); process.exitCode = 1;
  if (page) try { await screenshot('failure'); } catch {}
} finally {
  clearInterval(pulse); closing = true;
  if (page) try { await page.keyboard.up('KeyW'); await page.keyboard.up('KeyS'); await page.keyboard.up('KeyA'); await page.keyboard.up('KeyD'); await page.mouse.up({ button: 'left' }); await page.mouse.up({ button: 'right' }); } catch {}
  await browser?.close(); report.elapsedMs = Date.now() - started;
  await writeFile(path.join(out, 'report.json'), JSON.stringify(report, null, 2) + '\n');
  console.log('REPORT ' + path.join(out, 'report.json'));
  console.log('CLOSED Chrome public smoke session');
}
