import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocket } from 'ws';
import { startLanServer, resolvePublicFile } from '../scripts/lan-server.mjs';
import { LanClient } from '../games/freight-fire/network.js';
import { WEAPONS } from '../games/freight-fire/sim.js';

const root = fileURLToPath(new URL('../', import.meta.url));
// Node 20 has no native browser WebSocket global; ws exposes the same event API.
globalThis.WebSocket ||= WebSocket;

async function running(t, options = {}) {
  const host = await startLanServer({ host: '127.0.0.1', port: 0, ...options });
  t.after(() => host.close());
  return { ...host, base: `http://127.0.0.1:${host.port}`, url: `ws://127.0.0.1:${host.port}/fps` };
}

async function client(host, options = {}) {
  const socket = new WebSocket(host.url, { origin: host.base, ...options });
  const queue = [];
  socket.on('message', data => queue.push(JSON.parse(data.toString())));
  socket.on('error', () => {});
  await once(socket, 'open');
  return {
    socket, queue,
    send: message => socket.send(JSON.stringify(message)),
    async next(predicate, timeout = 3000) {
      const until = Date.now() + timeout;
      while (Date.now() < until) {
        const index = queue.findIndex(typeof predicate === 'string' ? message => message.type === predicate : predicate);
        if (index >= 0) return queue.splice(index, 1)[0];
        await delay(10);
      }
      throw new Error(`Timed out waiting for ${predicate}: ${JSON.stringify(queue.slice(-3))}`);
    },
    async close() {
      if (socket.readyState === WebSocket.CLOSED) return;
      const done = once(socket, 'close'); socket.close(); await done;
    }
  };
}

async function create(host, size, name = 'Room owner') {
  const owner = await client(host);
  owner.send({ type: 'create_room', size, name, goal: 40, difficulty: 'normal' });
  return { owner, joined: await owner.next('joined') };
}

async function waitFor(predicate, timeout = 3000) {
  const until = Date.now() + timeout;
  while (Date.now() < until) { if (predicate()) return; await delay(10); }
  assert.fail('State did not converge before timeout');
}

test('LAN serves runtime files and health, hides private files and traversal', async t => {
  const host = await running(t);
  assert.deepEqual((await (await fetch(`${host.base}/api/fps/health`)).json()).roomSizes, [4, 8]);
  assert.equal((await fetch(host.base)).status, 200);
  const runtime = await fetch(`${host.base}/games/freight-fire/network.js`);
  assert.equal(runtime.status, 200);
  assert.match(runtime.headers.get('content-type'), /javascript/);
  assert.equal((await fetch(`${host.base}/games.json`, { method: 'HEAD' })).status, 200);
  assert.equal((await fetch(host.base, { method: 'POST' })).status, 405);
  for (const route of ['/package.json', '/package-lock.json', '/README.md', '/scripts/lan-server.mjs', '/tests/fps-network.test.mjs', '/.git/config', '/games/freight-fire/.env']) {
    assert.equal((await fetch(`${host.base}${route}`)).status, 404, route);
  }
  for (const route of ['/../package.json', '/%2e%2e/package.json', '/games/../../package.json', '/src/%5c..%5cpackage.json', '/%ZZ', '/games/freight-fire/notes.md']) {
    assert.equal(resolvePublicFile(root, route), null, route);
  }
  assert.equal((await fetch(`${host.base}/api/fps/invites?room=missing`)).status, 404);
});

test('independent 4v4 and 8v8 matches fill empty seats with bots and expose invite metadata', async t => {
  const host = await running(t);
  const four = await create(host, 4, 'PRIVATE NAME A');
  const eight = await create(host, 8, 'PRIVATE NAME B');
  for (const { joined } of [four, eight]) {
    assert.match(joined.roomId, /^[A-Za-z0-9_-]{16}$/);
    assert.equal(joined.snapshot.players.length, joined.size * 2);
    assert.equal(joined.snapshot.players.filter(player => player.human).length, 1);
    assert.equal(joined.snapshot.players.filter(player => player.bot).length, joined.size * 2 - 1);
    assert.equal(joined.playerId, joined.hostId);
    assert.equal(new URL(joined.invite, host.base).searchParams.get('room'), joined.roomId);
    const invite = await (await fetch(`${host.base}/api/fps/invites?room=${joined.roomId}`)).json();
    assert.equal(invite.roomId, joined.roomId);
    assert.match(invite.local, new RegExp(`^http://localhost:${host.port}/games/freight-fire/index.html\\?room=`));
    assert.ok(Array.isArray(invite.lan));
    for (const link of invite.lan) assert.match(new URL(link).hostname, /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/);
  }
  assert.notEqual(four.joined.roomId, eight.joined.roomId);
  const listing = await (await fetch(`${host.base}/api/fps/rooms`)).json();
  assert.equal(listing.rooms.length, 2);
  assert.deepEqual(listing.rooms.map(room => room.capacity).sort((a, b) => a - b), [8, 16]);
  assert.doesNotMatch(JSON.stringify(listing), /PRIVATE NAME/);
  const streamed = await four.owner.next('snapshot');
  assert.equal(streamed.room.humanCount, 1);
  assert.equal(streamed.snapshot.players.length, 8);
  assert.ok(streamed.snapshot.time > four.joined.snapshot.time);
});

test('8v8 accepts sixteen distinct humans, rejects full room and unknown invite', async t => {
  const host = await running(t);
  const { owner, joined } = await create(host, 8);
  const identities = new Set([joined.playerId]);
  for (let index = 1; index < 16; index++) {
    const peer = await client(host);
    peer.send({ type: 'join_room', roomId: joined.roomId, name: `Friend ${index}` });
    identities.add((await peer.next('joined')).playerId);
  }
  assert.equal(identities.size, 16);
  const extra = await client(host);
  extra.send({ type: 'join_room', roomId: joined.roomId, name: 'Overflow' });
  assert.equal((await extra.next('error')).code, 'ROOM_FULL');
  extra.send({ type: 'join_room', roomId: 'AAAAAAAAAAAAAAAA', name: 'Unknown' });
  assert.equal((await extra.next('error')).code, 'ROOM_NOT_FOUND');
  const snapshot = await owner.next(message => message.type === 'snapshot' && message.room.humanCount === 16);
  assert.equal(snapshot.snapshot.players.filter(player => player.human).length, 16);
  assert.equal(snapshot.snapshot.players.filter(player => player.bot).length, 0);
});

test('server advances inputs, rejects invented state, restricts restart and migrates host on disconnect', async t => {
  const host = await running(t);
  const { owner, joined } = await create(host, 4);
  const friend = await client(host);
  friend.send({ type: 'join_room', roomId: joined.roomId, name: 'Friend' });
  const friendJoin = await friend.next('joined');
  const room = host.rooms.get(joined.roomId);
  const akIndex = WEAPONS.findIndex(weapon => weapon.id === 'ak47');
  const start = room.match.snapshot().players.find(player => player.id === joined.playerId);
  owner.send({ type: 'input', input: { yaw: 0.7, pitch: 0.1, forward: 1, strafe: 0, walk: true, primaryWeapon: akIndex, weapon: 'ak47' } });
  await waitFor(() => room.match.snapshot().players.find(player => player.id === joined.playerId).weapon === akIndex);
  await delay(150);
  const moved = room.match.snapshot().players.find(player => player.id === joined.playerId);
  assert.equal(moved.weapon, akIndex);
  assert.ok(Math.hypot(moved.x - start.x, moved.z - start.z) > 0.1, 'authoritative movement should advance');
  owner.queue.length = 0; friend.queue.length = 0;
  const ownerState = await owner.next('snapshot');
  const friendState = await friend.next(message => message.type === 'snapshot' && message.snapshot.time === ownerState.snapshot.time);
  assert.deepEqual(friendState.snapshot, ownerState.snapshot, 'clients must receive identical authoritative state');
  owner.send({ type: 'input', input: { hp: 999, x: 9999, damage: 999, fire: true } });
  assert.equal((await owner.next('error')).code, 'INVALID_INPUT');
  assert.notEqual(room.match.snapshot().players.find(player => player.id === joined.playerId).x, 9999);
  friend.send({ type: 'restart' });
  assert.equal((await friend.next('error')).code, 'HOST_ONLY');
  await waitFor(() => room.match.snapshot().time > 0.2);
  owner.send({ type: 'restart' });
  await owner.next(message => message.type === 'snapshot' && message.snapshot.time < 0.05);
  await owner.close();
  await waitFor(() => room.hostId === friendJoin.playerId && room.members.size === 1);
  const bot = room.match.snapshot().players.find(player => player.id === joined.playerId);
  assert.equal(bot.bot, true);
  assert.equal(bot.human, false);
  const update = await friend.next(message => message.type === 'room' && message.hostId === friendJoin.playerId);
  assert.equal(update.humanCount, 1);
  friend.send({ type: 'restart' });
  await friend.next(message => message.type === 'snapshot' && message.snapshot.time < 0.05);
  friend.send({ type: 'leave' });
  await friend.next('left');
  assert.equal(room.members.size, 0);
  assert.equal(room.match.snapshot().players.filter(player => player.bot).length, 8);
});

test('LAN enforces spawn-only primary selection and replicates knife damage and death identity', async t => {
  const host = await running(t);
  const { owner, joined } = await create(host, 4);
  const friend = await client(host);
  friend.send({ type: 'join_room', roomId: joined.roomId, name: 'Knife target' });
  const friendJoin = await friend.next('joined'), room = host.rooms.get(joined.roomId);
  const player = room.match.players.find(value => value.id === joined.playerId);
  const target = room.match.players.find(value => value.id === friendJoin.playerId);
  for (const other of room.match.players) other.bot = false;
  owner.send({ type: 'input', input: { primaryWeapon: 2, weapon: 0 } });
  await waitFor(() => player.primaryWeapon === 2 && player.weapon === 2);
  assert.equal((await owner.next(message => message.type === 'snapshot' && message.snapshot.players.find(value => value.id === player.id).primaryWeapon === 2)).snapshot.players.find(value => value.id === player.id).weapon, 2);
  owner.send({ type: 'input', input: { weapon: 0 } });
  assert.equal((await owner.next('error')).code, 'INVALID_INPUT'); assert.equal(player.weapon, 2);
  owner.send({ type: 'input', input: { primaryWeapon: 3 } });
  assert.equal((await owner.next('error')).code, 'INVALID_INPUT');
  Object.assign(player, { x: 0, y: 0, z: 3, yaw: 0, pitch: 0, shieldUntil: 0 });
  Object.assign(target, { x: 0, y: 0, z: 1.2, hp: 100, shieldUntil: 0 });
  owner.send({ type: 'input', input: { primaryWeapon: 1, weapon: 2 } });
  assert.equal((await owner.next('error')).code, 'INVALID_INPUT'); assert.equal(player.primaryWeapon, 2);
  owner.send({ type: 'input', input: { weapon: 'knife', altFire: false, yaw: 0, pitch: 0 } });
  await waitFor(() => player.weapon === 4); await delay(300);
  owner.send({ type: 'input', input: { weapon: 4, altFire: true, yaw: 0, pitch: 0 } });
  await waitFor(() => !target.alive);
  assert.equal(target.hp, 0); assert.equal(target.killerId, player.id); assert.equal(target.deathWeapon, 4);
  assert.equal(player.ammo[4], 0); assert.equal(player.reserve[4], 0);
  assert.ok(room.match.events.some(event => event.type === 'equip' && event.playerId === player.id && event.weapon === 4));
  assert.ok(room.match.events.some(event => event.type === 'melee' && event.targetId === target.id && event.heavy));
  assert.ok(room.match.events.some(event => event.type === 'hit' && event.targetId === target.id && event.weapon === 4 && event.damage === 100 && event.heavy));
  const deathSnapshot = await friend.next(message => message.type === 'snapshot' && message.snapshot.players.find(value => value.id === target.id)?.alive === false);
  const replicated = deathSnapshot.snapshot.players.find(value => value.id === target.id);
  assert.equal(replicated.killerId, player.id); assert.equal(replicated.deathWeapon, 4); assert.equal(replicated.deathHeadshot, false);
});

test('cross-origin upgrades, malformed messages, oversized payloads and flooding are rejected', async t => {
  const host = await running(t);
  const foreign = new WebSocket(host.url, { origin: 'https://untrusted.example' });
  foreign.on('error', () => {});
  const [, response] = await once(foreign, 'unexpected-response');
  assert.equal(response.statusCode, 403);
  foreign.terminate();
  const malformed = await client(host);
  malformed.socket.send('{');
  assert.equal((await malformed.next('error')).code, 'INVALID_JSON');
  malformed.socket.send(Buffer.from([1, 2, 3]));
  assert.equal((await malformed.next('error')).code, 'INVALID_MESSAGE');
  malformed.send({ type: 'create_room', size: 32 });
  assert.equal((await malformed.next('error')).code, 'INVALID_ROOM');
  const large = await client(host);
  const closedLarge = once(large.socket, 'close');
  large.socket.send('x'.repeat(9000));
  const [largeCode] = await closedLarge;
  assert.equal(largeCode, 1009);
  const flood = await client(host);
  const closedFlood = once(flood.socket, 'close');
  for (let index = 0; index < 250; index++) flood.send({ type: 'list_rooms' });
  const [floodCode] = await closedFlood;
  assert.equal(floodCode, 1008);
});

test('heartbeat drops silent peers and idle rooms expire', async t => {
  const host = await running(t, { heartbeatIntervalMs: 50, roomIdleMs: 80 });
  const silent = await client(host, { autoPong: false });
  silent.send({ type: 'create_room', size: 4, name: 'Silent' });
  const joined = await silent.next('joined');
  const room = host.rooms.get(joined.roomId);
  await waitFor(() => room.members.size === 0);
  assert.equal(room.match.snapshot().players.filter(player => player.bot).length, 8);
  await waitFor(() => !host.rooms.has(joined.roomId));
});

test('browser LAN client connects on demand, receives joins and snapshots, and leaves cleanly', async t => {
  const host = await running(t);
  let joined; let snapshot; let rooms; let closeEvent;
  const browser = new LanClient({ base: host.base, onJoined: value => { joined = value; }, onSnapshot: value => { snapshot = value; }, onRooms: value => { rooms = value; }, onClose: value => { closeEvent = value; } });
  assert.equal(browser.socket, null, 'constructing the client does not connect');
  await browser.create({ size: 4, name: 'Browser' });
  await waitFor(() => Boolean(joined && snapshot));
  assert.equal(joined.size, 4);
  assert.equal(snapshot.players.length, 8);
  assert.ok(Array.isArray(rooms));
  assert.equal(browser.sendInput({ forward: 0, strafe: 0, fire: false, yaw: 1, pitch: 0 }), true);
  browser.leave();
  await waitFor(() => host.rooms.get(joined.roomId).members.size === 0);
  assert.equal(browser.sendInput({ fire: true }), false);
  browser.disconnect();
  await waitFor(() => Boolean(closeEvent));
});
