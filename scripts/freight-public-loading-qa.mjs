import { chromium } from 'playwright';
import { mkdir, writeFile } from 'node:fs/promises';
import assert from 'node:assert/strict';
import path from 'node:path';
import { root } from './catalog.mjs';

// Production acceptance with a fresh Chrome context followed by an ordinary
// reload of that same context. No route mocking, browser-cache disabling,
// timeout overrides, injected globals or simulated game/loader state.
const target = new URL(process.env.FREIGHT_PUBLIC_URL || 'https://lslzqco.cn/ai-game-lab/games/freight-fire/?qa=1');
if (!['http:', 'https:'].includes(target.protocol) || target.username || target.password) throw Error('Use a plain public HTTP(S) game URL');
target.searchParams.set('qa', '1');
const out = path.join(root, 'artifacts', 'freight-public-loading');
await mkdir(out, { recursive: true });
const report = { date: new Date().toISOString(), url: target.href, checks: [], phases: [], progress: [], network: [],
  screenshots: [], errors: [], consoleErrors: [], failedRequests: [], limitations: [
    'One fresh real Chrome context; warm reload keeps that context and its normal HTTP cache.',
    'Cold and warm entry use actual Start/WASD inputs and read-only game diagnostics.',
    'Raw HTTP 304 is read from CDP responseReceivedExtraInfo because a browser may expose its cached effective response as HTTP 200.',
    'CDP encodedDataLength measures bytes received over the network, including response metadata; decoded progress remains a separate measurement.'
  ] };
const began = Date.now(), records = new Map();
let browser, page, phase = 'launch', pulse, monitor, closing = false, sampling = false, capturedColdProgress = false;
const field = (headers, name) => { const key = Object.keys(headers || {}).find(key => key.toLowerCase() === name.toLowerCase()); return key ? headers[key] : null; };
function beginPhase(name) { phase = name; const entry = { name, startedMs: Date.now() - began }; report.phases.push(entry); console.log('STAGE ' + name); return entry; }
function check(name, detail) { report.checks.push({ name, passed: true, detail }); console.log('PASS ' + name); }
function networkRecord(id) { if (!records.has(id)) records.set(id, { id, phase, url: null, status: null, actualStatus: null, encodedDataLength: 0 }); return records.get(id); }
async function screenshot(name) { await page.screenshot({ path: path.join(out, name + '.png') }); report.screenshots.push(name + '.png'); }
async function progress() {
  return page.evaluate(() => {
    const box = document.querySelector('#loading'), bar = document.querySelector('#loading-progress'), loading = window.__freight?.loading;
    return { visible: !!box && !box.hidden, percent: Number(bar?.value || 0), percentText: document.querySelector('#loading-percent')?.textContent,
      stage: document.querySelector('#loading-stage')?.textContent, bytesText: document.querySelector('#loading-bytes')?.textContent,
      count: document.querySelector('#loading-count')?.textContent, elapsed: document.querySelector('#loading-elapsed')?.textContent,
      help: document.querySelector('#loading-help')?.textContent, retry: !!document.querySelector('#loading-retry') && !document.querySelector('#loading-retry').hidden,
      loadedBytes: loading?.loadedBytes, totalBytes: loading?.totalBytes, ratio: loading?.ratio };
  });
}
async function ready() {
  await page.waitForFunction(() => window.__freight?.view?.viewModel, null, { timeout: 180000 });
  await page.locator('#loading').waitFor({ state: 'hidden', timeout: 180000 });
  assert.equal(await page.locator('#start').isEnabled(), true);
}
async function play() {
  await page.locator('#difficulty').selectOption('easy'); await page.locator('#quality').selectOption('low'); await page.locator('#start').click();
  await page.waitForFunction(() => { const f = window.__freight; return f?.snapshot?.players.find(p => p.id === f.localId)?.alive && !f.paused; });
  const before = await page.evaluate(() => { const f = __freight, p = f.snapshot.players.find(p => p.id === f.localId); return { x: p.x, z: p.z, time: f.snapshot.time }; });
  await page.keyboard.down('KeyW'); await page.waitForTimeout(450); await page.keyboard.up('KeyW');
  const after = await page.evaluate(() => { const f = __freight, p = f.snapshot.players.find(p => p.id === f.localId); return { x: p.x, z: p.z, time: f.snapshot.time, weapon: p.weapon }; });
  assert.ok(Math.hypot(after.x - before.x, after.z - before.z) > .8, 'Real W must move the player'); assert.ok(after.time > before.time);
  return { before, after, distance: Math.hypot(after.x - before.x, after.z - before.z) };
}
async function finishAudio() {
  // This is a post-entry observation, never a condition for entering the game.
  // Finish background downloads before reload so their cancelled old requests
  // are not confused with failures in the new navigation.
  let timer;
  try {
    const audio = await Promise.race([page.evaluate(async () => { const a = __freight.audio; await a.ready; await a.decoded; return { enabled: a.enabled, state: a.ctx?.state, samples: a.samples.size, expected: new Set(Object.values(a.banks).flat()).size, errors: [...a.loadErrors] }; }), new Promise((_, reject) => { timer = setTimeout(() => reject(Error('Background audio observation exceeded 90 seconds')), 90000); })]);
    assert.equal(audio.enabled, true); assert.equal(audio.state, 'running'); assert.equal(audio.samples, audio.expected); assert.ok(audio.samples > 0); assert.deepEqual(audio.errors, []); return audio;
  } finally { clearTimeout(timer); }
}
function phaseNetwork(name) {
  const entries = [...records.values()].filter(record => record.phase === name && record.url?.startsWith(target.origin));
  const models = entries.filter(record => new URL(record.url).pathname.endsWith('.glb'));
  return { requests: entries.length, actual304: entries.filter(record => record.actualStatus === 304).length,
    modelRequests: models.length, model304: models.filter(record => record.actualStatus === 304).length,
    encodedDataLength: entries.reduce((sum, record) => sum + record.encodedDataLength, 0),
    modelEncodedDataLength: models.reduce((sum, record) => sum + record.encodedDataLength, 0),
    modelRequestsWithValidators: models.filter(record => record.ifNoneMatch || record.ifModifiedSince).length,
    modelDetails: models.map(record => ({ url: record.url, status: record.status, actualStatus: record.actualStatus,
      encodedDataLength: record.encodedDataLength, etag: record.etag, encoding: record.encoding, fromDiskCache: record.fromDiskCache,
      ifNoneMatch: record.ifNoneMatch, ifModifiedSince: record.ifModifiedSince })) };
}

try {
  browser = await chromium.launch({ channel: 'chrome', headless: true, args: ['--no-first-run'] }); report.browser = browser.version();
  const context = await browser.newContext({ viewport: { width: 1500, height: 900 } }); page = await context.newPage();
  page.setDefaultTimeout(15000); page.setDefaultNavigationTimeout(180000);
  page.on('pageerror', error => report.errors.push({ phase, message: error.message }));
  page.on('console', message => { if (message.type() === 'error') report.consoleErrors.push({ phase, message: message.text() }); });
  page.on('requestfailed', request => { if (!closing) report.failedRequests.push({ phase, url: request.url(), error: request.failure()?.errorText }); });
  const cdp = await context.newCDPSession(page); await cdp.send('Network.enable');
  cdp.on('Network.requestWillBeSent', event => { const record = networkRecord(event.requestId); Object.assign(record, { phase, url: event.request.url, method: event.request.method, type: event.type, startedMs: Date.now() - began }); });
  cdp.on('Network.requestWillBeSentExtraInfo', event => { const record = networkRecord(event.requestId); record.ifNoneMatch = field(event.headers, 'if-none-match'); record.ifModifiedSince = field(event.headers, 'if-modified-since'); });
  cdp.on('Network.responseReceived', event => { const record = networkRecord(event.requestId); Object.assign(record, { url: event.response.url, status: event.response.status, fromDiskCache: !!event.response.fromDiskCache, fromServiceWorker: !!event.response.fromServiceWorker,
    etag: field(event.response.headers, 'etag'), lastModified: field(event.response.headers, 'last-modified'), encoding: field(event.response.headers, 'content-encoding'), contentLength: Number(field(event.response.headers, 'content-length') || 0), mimeType: event.response.mimeType }); });
  cdp.on('Network.responseReceivedExtraInfo', event => { const record = networkRecord(event.requestId); record.actualStatus = event.statusCode; record.actualEtag = field(event.headers, 'etag'); });
  cdp.on('Network.loadingFinished', event => { const record = networkRecord(event.requestId); record.encodedDataLength = event.encodedDataLength; record.finishedMs = Date.now() - began; });
  cdp.on('Network.loadingFailed', event => { const record = networkRecord(event.requestId); record.error = event.errorText; });
  pulse = setInterval(() => console.log('PROGRESS ' + JSON.stringify({ phase, elapsedSeconds: Math.round((Date.now() - began) / 1000), requests: records.size, errors: report.errors.length, failedRequests: report.failedRequests.length })), 30000);
  monitor = setInterval(async () => {
    if (sampling || closing) return; sampling = true;
    try {
      const state = await progress(); report.progress.push({ phase, atMs: Date.now() - began, ...state });
      if (phase === 'cold' && state.visible && state.percent > 0 && state.percent < 100 && !capturedColdProgress) { capturedColdProgress = true; await screenshot('01-public-byte-progress'); }
    } catch {} finally { sampling = false; }
  }, 500);

  const cold = beginPhase('cold'); await page.goto(target.href, { waitUntil: 'domcontentloaded' }); await ready(); cold.readyMs = Date.now() - began - cold.startedMs;
  assert.equal(await page.locator('body').getAttribute('data-static'), 'true');
  const interim = report.progress.filter(state => state.phase === 'cold' && state.visible && state.percent > 0 && state.percent < 100);
  assert.ok(interim.length > 0, 'Cold public loading must show an observed partial byte-progress state');
  await screenshot('02-public-loaded-menu'); check('Public cold load reports real partial progress and reaches its usable menu', { readyMs: cold.readyMs, observedIntermediateStates: interim.length, first: interim[0], last: interim.at(-1) });
  cold.movement = await play(); await screenshot('03-public-first-entry'); check('Public cold load starts a real moving match', cold.movement);
  cold.audio = await finishAudio(); await page.keyboard.press('Escape'); await page.locator('#menu').waitFor({ state: 'visible' }); await page.waitForTimeout(300);
  cold.network = phaseNetwork('cold'); assert.equal(cold.network.modelRequests, 11); assert.ok(cold.network.modelEncodedDataLength > 1000000); check('Fresh context downloads the eleven real models and decodes default background audio', { network: cold.network, audio: cold.audio });

  const warm = beginPhase('warm'); await page.reload({ waitUntil: 'domcontentloaded' }); await ready(); warm.readyMs = Date.now() - began - warm.startedMs;
  warm.movement = await play(); warm.audio = await finishAudio(); await screenshot('04-public-cached-entry'); await page.waitForTimeout(300);
  warm.network = phaseNetwork('warm');
  assert.equal(warm.network.modelRequests, 11); assert.equal(warm.network.model304, 11, 'Ordinary reload must revalidate each model with a raw HTTP 304');
  assert.equal(warm.network.modelRequestsWithValidators, 11); assert.ok(warm.network.modelEncodedDataLength < cold.network.modelEncodedDataLength * .1, 'Warm model transfers should consist of validation metadata rather than their old bodies');
  check('Same-context ordinary reload reuses all eleven model bodies through actual HTTP 304', { readyMs: warm.readyMs, coldEncodedModelBytes: cold.network.modelEncodedDataLength, warmEncodedModelBytes: warm.network.modelEncodedDataLength, network: warm.network });
  check('Cached public reload also starts a moving match with default audio', { movement: warm.movement, audio: warm.audio });
  assert.deepEqual(report.errors, []); assert.deepEqual(report.consoleErrors, []); assert.deepEqual(report.failedRequests, []);
  check('Cold and warm public sessions have no JavaScript, console or asset-request failures', { phases: report.phases.length }); report.ok = true;
} catch (error) {
  report.ok = false; report.failure = error.stack || String(error); process.exitCode = 1; console.error('FAIL ' + report.failure);
  if (page && !page.isClosed()) await screenshot('failure').catch(() => {});
} finally {
  clearInterval(pulse); clearInterval(monitor); closing = true;
  if (page && !page.isClosed()) await page.keyboard.up('KeyW').catch(() => {}); await browser?.close();
  report.network = [...records.values()].filter(record => record.url?.startsWith(target.origin)); report.elapsedMs = Date.now() - began;
  await writeFile(path.join(out, 'report.json'), JSON.stringify(report, null, 2) + '\n'); console.log('REPORT ' + path.join(out, 'report.json')); console.log('CLOSED Chrome public loading session');
}
