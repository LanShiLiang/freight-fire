import { createServer } from 'node:http';
import { readFile, realpath, stat } from 'node:fs/promises';
import { networkInterfaces, hostname } from 'node:os';
import { randomBytes } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { performance } from 'node:perf_hooks';
import { WebSocketServer, WebSocket } from 'ws';
import { Match } from '../games/freight-fire/sim.js';

const projectRoot = fileURLToPath(new URL('../', import.meta.url));
const gameEntry = '/games/freight-fire/index.html';
const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif', '.ico': 'image/x-icon',
  '.woff2': 'font/woff2', '.mp3': 'audio/mpeg', '.wav': 'audio/wav',
  '.ogg': 'audio/ogg', '.glb': 'model/gltf-binary', '.gltf': 'model/gltf+json',
  '.bin': 'application/octet-stream', '.wasm': 'application/wasm'
};
const INPUT_KEYS = new Set(['forward', 'strafe', 'yaw', 'pitch', 'fire', 'altFire', 'aim', 'jump', 'reload', 'weapon', 'primaryWeapon', 'walk', 'crouch']);
const BOOLEAN_KEYS = ['fire', 'altFire', 'aim', 'jump', 'reload', 'walk', 'crouch'];
const WEAPONS = new Set(['m4a1', 'ak47', 'awp', 'usp', 'knife']);
const ROOM_TOKEN = /^[A-Za-z0-9_-]{16}$/;
const CONTROL = /[\u0000-\u001f\u007f]/g;

function isPrivateIpv4(value) {
  const octets = value.split('.').map(Number);
  return octets.length === 4 && octets.every(n => Number.isInteger(n) && n >= 0 && n <= 255)
    && (octets[0] === 10 || (octets[0] === 172 && octets[1] >= 16 && octets[1] <= 31)
      || (octets[0] === 192 && octets[1] === 168));
}

export function lanAddresses() {
  const addresses = new Set();
  for (const entries of Object.values(networkInterfaces())) {
    for (const entry of entries || []) {
      if ((entry.family === 'IPv4' || entry.family === 4) && !entry.internal && isPrivateIpv4(entry.address)) {
        addresses.add(entry.address);
      }
    }
  }
  return [...addresses].sort();
}

/** Only the lobby and runtime game assets are published by the LAN host. */
export function resolvePublicFile(base, rawUrl) {
  let pathname;
  try { pathname = decodeURIComponent(rawUrl.split('?')[0]); } catch { return null; }
  if (!pathname.startsWith('/') || /[\\\0]/.test(pathname)) return null;
  const segments = pathname.split('/');
  if (segments.some(segment => segment === '..' || segment.startsWith('.'))) return null;
  if (!['', 'index.html', 'games.json', 'games', 'src'].includes(segments[1])) return null;
  if (['index.html', 'games.json'].includes(segments[1]) && segments.length !== 2) return null;
  if (segments[1] === '' && pathname !== '/') return null;
  const filename = path.resolve(base, `.${pathname.endsWith('/') ? `${pathname}index.html` : pathname}`);
  const relative = path.relative(base, filename);
  if (relative.startsWith('..') || path.isAbsolute(relative) || !MIME[path.extname(filename).toLowerCase()]) return null;
  return filename;
}

function publicSummary(room) {
  return {
    roomId: room.id, size: room.size, humanCount: room.members.size,
    capacity: room.size * 2, status: room.match.status, hostId: room.hostId
  };
}

function send(socket, message) {
  if (socket.readyState === WebSocket.OPEN && socket.bufferedAmount < 512 * 1024) {
    socket.send(JSON.stringify(message));
  }
}

function fail(socket, code, message) {
  send(socket, { type: 'error', code, message });
}

function playerName(value) {
  return typeof value === 'string' ? value.replace(CONTROL, '').trim().slice(0, 24) || '玩家' : '玩家';
}

function cleanInput(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)
    || Object.keys(input).some(key => !INPUT_KEYS.has(key))) return null;
  const result = {};
  for (const key of ['forward', 'strafe', 'yaw', 'pitch']) {
    if (input[key] === undefined) continue;
    if (typeof input[key] !== 'number' || !Number.isFinite(input[key])) return null;
    if (key === 'forward' || key === 'strafe') result[key] = Math.max(-1, Math.min(1, input[key]));
    if (key === 'yaw') result[key] = ((input[key] % (Math.PI * 2)) + Math.PI * 2) % (Math.PI * 2);
    if (key === 'pitch') result[key] = Math.max(-1.55, Math.min(1.55, input[key]));
  }
  for (const key of BOOLEAN_KEYS) {
    if (input[key] === undefined) continue;
    if (typeof input[key] !== 'boolean') return null;
    result[key] = input[key];
  }
  if (input.weapon !== undefined) {
    if (!WEAPONS.has(input.weapon) && !(Number.isInteger(input.weapon) && input.weapon >= 0 && input.weapon <= 4)) return null;
    result.weapon = input.weapon;
  }
  if (input.primaryWeapon !== undefined) {
    if (!Number.isInteger(input.primaryWeapon) || input.primaryWeapon < 0 || input.primaryWeapon > 2) return null;
    result.primaryWeapon = input.primaryWeapon;
  }
  return result;
}

function isLoopback(host) { return ['localhost', '127.0.0.1', '[::1]', '::1'].includes(host); }

function validUpgradeOrigin(request, bindHost, port) {
  let target;
  try { target = new URL(`http://${request.headers.host}`); } catch { return false; }
  const localHosts = new Set(['localhost', '127.0.0.1', '[::1]', hostname().toLowerCase(), ...lanAddresses()]);
  if (!['0.0.0.0', '::'].includes(bindHost)) localHosts.add(bindHost.toLowerCase());
  if (!localHosts.has(target.hostname.toLowerCase()) || Number(target.port || 80) !== port) return false;
  if (!request.headers.origin) return isLoopback(request.socket.remoteAddress?.replace(/^::ffff:/, '') || '');
  try {
    const origin = new URL(request.headers.origin);
    return ['http:', 'https:'].includes(origin.protocol)
      && (origin.host.toLowerCase() === target.host.toLowerCase()
        || (isLoopback(origin.hostname) && isLoopback(target.hostname) && origin.port === target.port));
  } catch { return false; }
}

/** Starts a static host plus authoritative FPS matches; never edits firewall settings. */
export async function startLanServer({
  port = 8787, host = '0.0.0.0', root = projectRoot,
  heartbeatIntervalMs = 15_000, roomIdleMs = 60_000, maxRooms = 32, maxConnections = 256
} = {}) {
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('Port must be an integer from 0 to 65535.');
  const base = await realpath(root);
  const rooms = new Map();
  let closing = false;
  let actualPort = port;
  const json = (response, status, data, head = false) => {
    const body = JSON.stringify(data);
    response.writeHead(status, {
      'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(body),
      'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer'
    });
    response.end(head ? undefined : body);
  };
  const server = createServer(async (request, response) => {
    if (!['GET', 'HEAD'].includes(request.method)) {
      response.writeHead(405, { Allow: 'GET, HEAD' }); response.end(); return;
    }
    let url;
    try { url = new URL(request.url || '/', 'http://127.0.0.1'); } catch { json(response, 400, { error: 'Bad request' }); return; }
    const head = request.method === 'HEAD';
    if (url.pathname === '/api/fps/health') {
      json(response, 200, { ok: true, protocol: 1, rooms: rooms.size, roomSizes: [4, 8] }, head); return;
    }
    if (url.pathname === '/api/fps/rooms') {
      json(response, 200, { rooms: [...rooms.values()].filter(room => room.members.size).map(publicSummary) }, head); return;
    }
    if (url.pathname === '/api/fps/invites') {
      const room = rooms.get(url.searchParams.get('room'));
      if (!room) { json(response, 404, { error: 'Room not found' }, head); return; }
      const suffix = `${gameEntry}?room=${room.id}`;
      json(response, 200, {
        roomId: room.id, local: `http://localhost:${actualPort}${suffix}`,
        lan: lanAddresses().map(address => `http://${address}:${actualPort}${suffix}`)
      }, head); return;
    }
    const filename = resolvePublicFile(base, request.url || '/');
    if (!filename) { json(response, 404, { error: 'Not found' }, head); return; }
    try {
      const resolved = await realpath(filename);
      const relative = path.relative(base, resolved);
      if (relative.startsWith('..') || path.isAbsolute(relative)
        || !resolvePublicFile(base, `/${relative.split(path.sep).join('/')}`)
        || !(await stat(resolved)).isFile()) throw new Error('Not public');
      const data = await readFile(resolved);
      response.writeHead(200, {
        'Content-Type': MIME[path.extname(filename).toLowerCase()], 'Content-Length': data.length,
        'Cache-Control': 'no-cache', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer'
      });
      response.end(head ? undefined : data);
    } catch { json(response, 404, { error: 'Not found' }, head); }
  });
  server.requestTimeout = 10_000;
  server.headersTimeout = 10_000;
  const wss = new WebSocketServer({ noServer: true, maxPayload: 8192, perMessageDeflate: false });
  const detach = socket => {
    const room = rooms.get(socket.roomId);
    if (room && socket.playerId && room.members.get(socket.playerId) === socket) {
      room.match.removeHuman(socket.playerId);
      room.members.delete(socket.playerId);
      if (room.hostId === socket.playerId) room.hostId = room.members.keys().next().value || null;
      if (!room.members.size) room.emptySince = performance.now();
      const info = publicSummary(room);
      for (const member of room.members.values()) send(member, { type: 'room', ...info });
    }
    socket.roomId = null; socket.playerId = null;
  };
  const join = (socket, room, name) => {
    if (socket.roomId) { fail(socket, 'ALREADY_JOINED', '请先离开当前房间。'); return; }
    if (room.members.size >= room.size * 2) { fail(socket, 'ROOM_FULL', '房间已满。'); return; }
    const player = room.match.addHuman(playerName(name));
    if (!player) { fail(socket, 'ROOM_FULL', '房间已满。'); return; }
    socket.roomId = room.id; socket.playerId = player.id; socket.lastInput = performance.now();
    room.members.set(player.id, socket); room.emptySince = null;
    room.hostId ||= player.id;
    send(socket, {
      type: 'joined', roomId: room.id, playerId: player.id, hostId: room.hostId,
      size: room.size, humanCount: room.members.size, snapshot: room.match.snapshot(), invite: `${gameEntry}?room=${room.id}`
    });
    for (const member of room.members.values()) send(member, { type: 'room', ...publicSummary(room) });
  };
  server.on('upgrade', (request, socket, head) => {
    let pathname;
    try { pathname = new URL(request.url || '/', 'http://127.0.0.1').pathname; } catch { pathname = ''; }
    if (pathname !== '/fps' || closing || !validUpgradeOrigin(request, host, actualPort)) {
      socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n'); return;
    }
    const fromAddress = request.socket.remoteAddress;
    if (wss.clients.size >= maxConnections || [...wss.clients].filter(client => client.remoteAddress === fromAddress).length >= 32) {
      socket.end('HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\n\r\n'); return;
    }
    wss.handleUpgrade(request, socket, head, client => {
      client.remoteAddress = fromAddress;
      wss.emit('connection', client, request);
    });
  });
  wss.on('connection', socket => {
    socket.alive = true; socket.tokens = 180; socket.tokenTime = performance.now();
    socket.roomActions = []; socket.roomId = null; socket.playerId = null;
    socket.on('pong', () => { socket.alive = true; });
    socket.on('error', () => {}); // ws protocol errors close the connection and trigger bot takeover.
    socket.on('close', () => detach(socket));
    send(socket, { type: 'hello', protocol: 1, roomSizes: [4, 8] });
    send(socket, { type: 'rooms', rooms: [...rooms.values()].filter(room => room.members.size).map(publicSummary) });
    socket.on('message', (data, isBinary) => {
      const now = performance.now();
      socket.tokens = Math.min(180, socket.tokens + (now - socket.tokenTime) * 0.09); socket.tokenTime = now;
      if (--socket.tokens < 0) { fail(socket, 'RATE_LIMIT', '操作过于频繁，请重新连接。'); socket.close(1008, 'Rate limit'); return; }
      if (isBinary) { fail(socket, 'INVALID_MESSAGE', '仅支持 JSON 消息。'); return; }
      let message;
      try { message = JSON.parse(data.toString()); } catch { fail(socket, 'INVALID_JSON', '消息格式错误。'); return; }
      if (!message || typeof message !== 'object' || Array.isArray(message) || typeof message.type !== 'string') {
        fail(socket, 'INVALID_MESSAGE', '消息格式错误。'); return;
      }
      if (['create_room', 'join_room'].includes(message.type)) {
        socket.roomActions = socket.roomActions.filter(time => now - time < 10_000);
        if (socket.roomActions.length >= 5) { fail(socket, 'RATE_LIMIT', '创建或加入房间过于频繁。'); return; }
        socket.roomActions.push(now);
      }
      if (message.type === 'create_room') {
        if (socket.roomId) { fail(socket, 'ALREADY_JOINED', '请先离开当前房间。'); return; }
        if (![4, 8].includes(message.size) || (message.goal !== undefined && (!Number.isInteger(message.goal) || message.goal < 10 || message.goal > 200))
          || (message.difficulty !== undefined && !['easy', 'normal', 'hard'].includes(message.difficulty))) {
          fail(socket, 'INVALID_ROOM', '房间人数、目标分数或难度无效。'); return;
        }
        if (rooms.size >= maxRooms) { fail(socket, 'SERVER_FULL', '服务器房间已满。'); return; }
        const id = randomBytes(12).toString('base64url');
        const room = {
          id, size: message.size, hostId: null, members: new Map(), emptySince: now,
          match: new Match({ size: message.size, goal: message.goal || 40, duration: 300, difficulty: message.difficulty || 'normal', seed: randomBytes(4).readUInt32LE() })
        };
        rooms.set(id, room); join(socket, room, message.name); return;
      }
      if (message.type === 'join_room') {
        const room = typeof message.roomId === 'string' && ROOM_TOKEN.test(message.roomId) ? rooms.get(message.roomId) : null;
        if (!room) { fail(socket, 'ROOM_NOT_FOUND', '邀请码无效，或房间已关闭。'); return; }
        join(socket, room, message.name); return;
      }
      if (message.type === 'list_rooms') {
        send(socket, { type: 'rooms', rooms: [...rooms.values()].filter(room => room.members.size).map(publicSummary) }); return;
      }
      if (message.type === 'leave') { detach(socket); send(socket, { type: 'left' }); return; }
      const room = rooms.get(socket.roomId);
      if (!room || !socket.playerId) { fail(socket, 'NOT_JOINED', '请先加入房间。'); return; }
      if (message.type === 'input') {
        const input = cleanInput(message.input);
        if (!input) { fail(socket, 'INVALID_INPUT', '仅允许移动、视角和武器操作。'); return; }
        if (!room.match.input(socket.playerId, input)) { fail(socket, 'INVALID_INPUT', '主武器仅能在己方出生点选择，战斗中只能使用已装备的主武器、手枪和刀。'); return; }
        socket.lastInput = now; return;
      }
      if (message.type === 'restart') {
        if (room.hostId !== socket.playerId) { fail(socket, 'HOST_ONLY', '只有房主可以重开。'); return; }
        room.match.restart();
        for (const member of room.members.values()) send(member, { type: 'snapshot', roomId: room.id, hostId: room.hostId, room: publicSummary(room), snapshot: room.match.snapshot() });
        return;
      }
      fail(socket, 'UNKNOWN_MESSAGE', '未知操作。');
    });
  });
  let lastTick = performance.now();
  let accumulator = 0;
  const simulation = setInterval(() => {
    const now = performance.now();
    accumulator += Math.min(0.1, (now - lastTick) / 1000); lastTick = now;
    for (const [id, room] of rooms) {
      if (!room.members.size && now - room.emptySince > roomIdleMs) rooms.delete(id);
      for (const [playerId, socket] of room.members) {
        if (now - socket.lastInput > 750) {
          room.match.input(playerId, { forward: 0, strafe: 0, fire: false, altFire: false, aim: false, jump: false, reload: false, walk: false, crouch: false });
        }
      }
    }
    while (accumulator >= 1 / 60) {
      for (const room of rooms.values()) if (room.members.size) room.match.step(1 / 60);
      accumulator -= 1 / 60;
    }
  }, 1000 / 60);
  const snapshots = setInterval(() => {
    for (const room of rooms.values()) {
      if (!room.members.size) continue;
      const message = { type: 'snapshot', roomId: room.id, hostId: room.hostId, room: publicSummary(room), snapshot: room.match.snapshot() };
      for (const socket of room.members.values()) send(socket, message);
    }
  }, 50);
  const heartbeat = setInterval(() => {
    for (const socket of wss.clients) {
      if (!socket.alive) { socket.terminate(); continue; }
      socket.alive = false; socket.ping();
    }
  }, heartbeatIntervalMs);
  const timers = [simulation, snapshots, heartbeat];
  const close = async () => {
    if (closing) return;
    closing = true; timers.forEach(clearInterval);
    for (const socket of wss.clients) socket.terminate();
    await new Promise(resolve => wss.close(resolve));
    await new Promise(resolve => server.close(resolve));
    server.closeAllConnections?.();
    rooms.clear();
  };
  try {
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(port, host, () => { server.removeListener('error', reject); resolve(); });
    });
    actualPort = server.address().port;
  } catch (error) { await close(); throw error; }
  return { server, wss, rooms, close, port: actualPort };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  let port = 8787; let host = '0.0.0.0';
  try {
    for (let index = 0; index < args.length; index++) {
      if (args[index] === '--port') port = Number(args[++index]);
      else if (args[index] === '--host') host = args[++index];
      else throw new Error(`Unknown option: ${args[index]}`);
    }
    if (!Number.isInteger(port) || port < 1 || port > 65535 || !host) throw new Error('Use --port 1..65535 and a valid --host.');
    const running = await startLanServer({ port, host });
    console.log(`\nFreight Fire LAN host\nLobby: http://localhost:${running.port}\nGame: http://localhost:${running.port}${gameEntry}`);
    for (const address of lanAddresses()) console.log(`LAN: http://${address}:${running.port}${gameEntry}`);
    console.log('\nKeep this window open. Ctrl+C stops the host.\nNo firewall rules or router settings have been changed.');
    for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, async () => { await running.close(); process.exitCode = 0; });
    running.server.on('error', error => { console.error(`Host error: ${error.message}`); process.exitCode = 1; });
  } catch (error) {
    console.error(`Unable to start LAN host: ${error.message}\nIf the port is busy, use --port 8788.`);
    process.exitCode = 1;
  }
}
