import { chromium } from 'playwright';
import { createServer } from 'node:http';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import assert from 'node:assert/strict';
import path from 'node:path';
import { root } from './catalog.mjs';
import { makeServer } from './serve.mjs';

// Fault injection happens in actual HTTP requests. Game, animation, input,
// renderer and loading-state globals are never overwritten or fabricated.
const out = path.join(root, 'artifacts', 'freight-loading');
await mkdir(out, { recursive: true });
const report = { date: new Date().toISOString(), checks: [], scenarios: [], screenshots: [], limitations: [
  'One fresh real Chrome context per scenario, real local model/texture bytes.',
  'Network faults are intentional browser-route failures or real server pauses.',
  'The 150 ms idle-deadline check exercises the public loader API in an isolated page; the game retains its production 20 second deadline.'
] };
const started = Date.now(), delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const characterPath = '/games/freight-fire/assets/characters-cs2/ct-sas.glb';
const gunPath = '/games/freight-fire/assets/viewmodel-cs2/m4a1-golden-coil.glb';
let slowStream = false, browser, currentPage, pulse, server, closing = false;
const handler = makeServer(root).listeners('request')[0];
const sockets = new Set();

function check(name, detail) { report.checks.push({ name, passed: true, detail }); console.log('PASS ' + name); }
async function screenshot(page, name) { await page.screenshot({ path: path.join(out, name + '.png') }); report.screenshots.push(name + '.png'); }
async function servePausedAsset(req, res, idleOnly = false) {
  const bytes = await readFile(path.join(root, characterPath));
  res.writeHead(200, { 'Content-Type': 'model/gltf-binary', 'Content-Length': bytes.length, 'Cache-Control': 'no-store' });
  res.write(bytes.subarray(0, 65536));
  if (idleOnly) return; // The client's real AbortController closes this stream.
  await delay(6500);
  for (let offset = 65536; offset < bytes.length && !res.destroyed; offset += 262144) {
    res.write(bytes.subarray(offset, Math.min(offset + 262144, bytes.length)));
    await delay(20);
  }
  if (!res.destroyed) res.end();
}
server = createServer(async (req, res) => {
  const pathname = new URL(req.url, 'http://localhost').pathname;
  if (pathname === '/__loading_qa_api.html') { res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }); res.end('<!doctype html><title>Real loader timeout API verification</title>'); return; }
  if (pathname === '/__loading_qa_idle.glb') { await servePausedAsset(req, res, true); return; }
  if (slowStream && pathname === characterPath && req.method === 'GET') { await servePausedAsset(req, res); return; }
  handler(req, res);
});
server.on('connection', socket => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); });
await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
const localBase = 'http://127.0.0.1:' + server.address().port;
const target = new URL(process.env.FREIGHT_LOADING_URL || localBase + '/games/freight-fire/?qa=1');
if (!['127.0.0.1', 'localhost', '[::1]'].includes(target.hostname)) throw Error('Fault-injection QA is restricted to the local project');
target.searchParams.set('qa', '1');
const loaderURL = new URL('./asset-loading.js', target).href;
report.url = target.href;

async function loadingState(page) { return page.evaluate(async url => (await import(url)).assetLoading.snapshot, loaderURL); }
async function waitSnapshot(page, predicate, timeout = 30000) {
  const until = Date.now() + timeout;
  while (Date.now() < until) { const snapshot = await loadingState(page); if (predicate(snapshot)) return snapshot; await delay(50); }
  throw Error('Asset snapshot condition timed out');
}
async function waitReady(page) {
  await page.waitForFunction(() => window.__freight?.view?.viewModel, null, { timeout: 90000 });
  await page.locator('#loading').waitFor({ state: 'hidden', timeout: 90000 });
  assert.equal(await page.locator('#start').isEnabled(), true);
}
async function loadingUI(page) {
  return page.evaluate(() => {
    const box = document.querySelector('#loading'), progress = box.querySelector('progress,[role="progressbar"]');
    return { text: box.innerText, state: box.dataset.state, value: Number(progress?.value ?? progress?.getAttribute('aria-valuenow')),
      max: Number(progress?.max ?? progress?.getAttribute('aria-valuemax') ?? 100), retryVisible: [...box.querySelectorAll('button')].some(b => !b.hidden && b.offsetParent !== null) };
  });
}
async function newScenario(name) {
  const context = await browser.newContext({ viewport: { width: 1500, height: 900 } }), page = await context.newPage();
  page.setDefaultTimeout(15000); page.setDefaultNavigationTimeout(90000); currentPage = page;
  const entry = { name, startedMs: Date.now() - started, errors: [], requests: {}, failures: [] }; report.scenarios.push(entry);
  page.on('pageerror', error => entry.errors.push(error.message));
  page.on('request', request => { const key = new URL(request.url()).pathname; entry.requests[key] = (entry.requests[key] || 0) + 1; });
  page.on('requestfailed', request => { if (!closing) entry.failures.push({ path: new URL(request.url()).pathname, error: request.failure()?.errorText }); });
  return { context, page, entry };
}
async function retryButton(page) {
  const button = page.locator('#loading button').filter({ hasText: /重试|重新载入|重新加载/ });
  await button.waitFor({ state: 'visible' }); return button;
}
async function play(page) {
  await page.locator('#difficulty').selectOption('easy'); await page.locator('#quality').selectOption('low');
  await page.locator('#start').click();
  await page.waitForFunction(() => { const f = window.__freight; return f?.snapshot?.players.find(p => p.id === f.localId)?.alive && !f.paused; });
  const before = await page.evaluate(() => { const f = __freight, p = f.snapshot.players.find(p => p.id === f.localId); return { x: p.x, z: p.z, time: f.snapshot.time }; });
  await page.keyboard.down('KeyW'); await page.waitForTimeout(450); await page.keyboard.up('KeyW');
  const after = await page.evaluate(() => { const f = __freight, p = f.snapshot.players.find(p => p.id === f.localId); return { x: p.x, z: p.z, time: f.snapshot.time }; });
  assert.ok(Math.hypot(after.x - before.x, after.z - before.z) > .8);
  assert.ok(after.time > before.time); return { before, after };
}

try {
  browser = await chromium.launch({ channel: 'chrome', headless: true, args: ['--no-first-run'] }); report.browser = browser.version();
  pulse = setInterval(() => console.log('PROGRESS ' + JSON.stringify({ elapsedSeconds: Math.round((Date.now() - started) / 1000), checks: report.checks.length, scenario: report.scenarios.at(-1)?.name })), 10000);

  // The real GLB sends its first 64 KiB immediately, pauses long enough for the
  // production five-second heartbeat, then resumes with the untouched bytes.
  {
    slowStream = true;
    const { context, page, entry } = await newScenario('Real byte progress, stalled heartbeat and successful entry');
    await page.goto(target.href, { waitUntil: 'domcontentloaded' });
    await waitSnapshot(page, s => { const r = s.assets.find(r => r.url.endsWith(characterPath)); return r?.loadedBytes > 0 && r.loadedBytes < r.totalBytes; });
    await page.waitForFunction(() => document.querySelector('#loading-progress').value > 0);
    const partial = await loadingState(page), ui = await loadingUI(page), asset = partial.assets.find(r => r.url.endsWith(characterPath));
    assert.ok(asset.loadedBytes > 0 && asset.loadedBytes < asset.totalBytes); assert.ok(ui.value > 0 && ui.value < ui.max); assert.equal(await page.locator('#loading').isVisible(), true);
    await screenshot(page, '01-real-byte-progress'); check('Loading bar reflects partial real GLB bytes', { ui, asset: { loadedBytes: asset.loadedBytes, totalBytes: asset.totalBytes }, overall: { loadedBytes: partial.loadedBytes, totalBytes: partial.totalBytes, ratio: partial.ratio } });
    await waitSnapshot(page, s => s.stalled.some(asset => asset.url.endsWith(characterPath)));
    await page.waitForFunction(() => /等待服务器|连接停滞/.test(document.querySelector('#loading-help').textContent));
    const stalledUI = await loadingUI(page); assert.match(stalledUI.text, /慢|等待|没有|停|连接|网络/);
    await screenshot(page, '02-network-heartbeat'); check('Five-second real stream pause is visible in the loading heartbeat', stalledUI);
    await waitReady(page); const movement = await play(page); await screenshot(page, '03-start-after-load');
    assert.deepEqual(entry.errors, []); check('Completed loading enters a real moving bot match', movement); slowStream = false; await context.close();
  }

  {
    const { context, page, entry } = await newScenario('Single actual failedFetch recovers automatically'); let attempts = 0;
    await context.route('**/*', route => route.continue());
    await context.route('**/m4a1-golden-coil.glb', route => { attempts++; return attempts === 1 ? route.abort('failed') : route.continue(); });
    await page.goto(target.href, { waitUntil: 'domcontentloaded' }); await waitReady(page);
    const loaded = (await loadingState(page)).assets.find(r => r.url.endsWith(gunPath));
    assert.equal(attempts, 2); assert.equal(loaded.attempt, 2); assert.equal(loaded.status, 'ready'); assert.deepEqual(entry.errors, []);
    check('A real failed model fetch retries once and completes without manual intervention', { attempts, status: loaded.status, phase: loaded.phase }); await context.close();
  }

  {
    const { context, page, entry } = await newScenario('Three HTTP 503 responses, visible failure, retry reuses successful models'); let blocked = true, attempts = 0;
    await context.route('**/*', route => route.continue());
    await context.route('**/m4a1-golden-coil.glb', route => { attempts++; return blocked ? route.fulfill({ status: 503, contentType: 'text/plain', body: 'Intentional loading QA service unavailable' }) : route.continue(); });
    await page.goto(target.href, { waitUntil: 'domcontentloaded' }); await retryButton(page);
    const failure = await loadingUI(page); assert.match(failure.text, /503/); assert.match(failure.text, /M4A1|m4a1-golden-coil/); assert.equal(attempts, 3);
    await waitSnapshot(page, s => s.assets.filter(r => r.critical && r.url.endsWith('.glb')).every(r => ['ready', 'error'].includes(r.status)));
    const failedState = await loadingState(page), successful = failedState.assets.filter(r => r.status === 'ready' && r.url.endsWith('.glb'));
    assert.ok(successful.length >= 3); const counts = Object.fromEntries(successful.map(asset => { const key = new URL(asset.url).pathname; return [key, entry.requests[key] || 0]; }));
    await screenshot(page, '04-specific-resource-failure'); check('Repeated HTTP 503 gives a named resource error and a usable retry button', { failure, attempts, successfulModels: successful.length });
    blocked = false; await (await retryButton(page)).click(); await waitReady(page);
    for (const [file, count] of Object.entries(counts)) assert.equal(entry.requests[file], count, 'Successful GLB must be reused: ' + file);
    assert.equal(attempts, 4); await screenshot(page, '05-manual-retry-complete');
    check('Real retry requests only the failed model and keeps all successful model downloads', { totalAttempts: attempts, preservedRequests: counts }); await context.close();
  }

  {
    const { context, page, entry } = await newScenario('Game module 404 leaves the loading state and retry recovers'); let blocked = true, attempts = 0;
    await context.route('**/game.js*', route => { if (new URL(route.request().url()).pathname.endsWith('/game.js')) { attempts++; return blocked ? route.fulfill({ status: 404, contentType: 'text/javascript', body: '' }) : route.continue(); } return route.continue(); });
    await page.goto(target.href, { waitUntil: 'domcontentloaded' }); await retryButton(page);
    const failure = await loadingUI(page); assert.match(failure.text, /程序|模块|脚本|game\.js|代码/); assert.equal(await page.locator('#loading').isVisible(), true);
    await screenshot(page, '06-module-failure'); check('A real module 404 exposes failure and retry instead of loading forever', { failure, attempts });
    blocked = false; await (await retryButton(page)).click(); await waitReady(page); assert.ok(attempts >= 2);
    check('Real user retry recovers after the missing game module becomes available', { attempts }); await context.close();
  }

  {
    const { context, page } = await newScenario('Real streaming loader API idle deadline'); await page.goto(localBase + '/__loading_qa_api.html');
    const bytes = (await readFile(path.join(root, characterPath))).length;
    const outcome = await page.evaluate(async ({ moduleURL, assetURL, bytes }) => {
      const module = await import(moduleURL), before = performance.now();
      try { await module.fetchAssetBuffer(assetURL, { label: '真实网络停顿验证', bytes, critical: false, retries: 0, idleTimeoutMs: 150 }); return { succeeded: true }; }
      catch (error) { return { elapsedMs: performance.now() - before, name: error.name, code: error.code, message: error.message, phase: error.phase, asset: module.assetLoading.snapshot.assets.find(r => r.url === assetURL) }; }
    }, { moduleURL: localBase + '/games/freight-fire/asset-loading.js', assetURL: localBase + '/__loading_qa_idle.glb', bytes });
    assert.equal(outcome.code, 'network-stall'); assert.equal(outcome.phase, 'download'); assert.equal(outcome.asset.status, 'error'); assert.ok(outcome.elapsedMs >= 100 && outcome.elapsedMs < 3000);
    check('Real paused body stream aborts at the configured idle deadline with a named network error', outcome); await context.close();
  }
  report.passed = true;
} catch (error) {
  report.failure = error.stack; if (currentPage && !currentPage.isClosed()) await screenshot(currentPage, 'failure').catch(() => {}); throw error;
} finally {
  clearInterval(pulse); closing = true; await browser?.close(); for (const socket of sockets) socket.destroy(); await new Promise(resolve => server.close(resolve));
  report.elapsedMs = Date.now() - started; await writeFile(path.join(out, 'report.json'), JSON.stringify(report, null, 2)); console.log('REPORT ' + path.join(out, 'report.json'));
}
