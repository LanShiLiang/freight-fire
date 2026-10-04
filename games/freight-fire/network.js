/** The offline game never constructs this client unless the player chooses LAN. */
export class LanClient {
  constructor({ onJoined, onSnapshot, onError, onClose, onRooms, onRoom, base, url } = {}) {
    this.callbacks = { onJoined, onSnapshot, onError, onClose, onRooms, onRoom };
    const address = new URL(url || '/fps', base || globalThis.location?.origin || 'http://localhost:8787');
    address.protocol = address.protocol === 'https:' || address.protocol === 'wss:' ? 'wss:' : 'ws:';
    this.url = address.href;
    this.socket = null;
    this.connecting = null;
    this.joined = null;
  }

  connect() {
    if (this.socket?.readyState === WebSocket.OPEN) return Promise.resolve(this);
    if (this.connecting) return this.connecting;
    this.connecting = new Promise((resolve, reject) => {
      const socket = new WebSocket(this.url);
      this.socket = socket;
      let opened = false;
      const timeout = setTimeout(() => { socket.close(); reject(new Error('连接超时，请确认局域网开服窗口仍在运行。')); }, 6000);
      socket.addEventListener('open', () => { opened = true; clearTimeout(timeout); this.connecting = null; resolve(this); });
      socket.addEventListener('message', event => {
        let data;
        try { data = JSON.parse(event.data); } catch { return; }
        if (data.type === 'joined') { this.joined = data; this.callbacks.onJoined?.(data); }
        else if (data.type === 'snapshot') this.callbacks.onSnapshot?.(data.snapshot, data);
        else if (data.type === 'rooms') this.callbacks.onRooms?.(data.rooms);
        else if (data.type === 'room') {
          if (this.joined) Object.assign(this.joined, { hostId: data.hostId, humanCount: data.humanCount });
          this.callbacks.onRoom?.(data);
        } else if (data.type === 'left') this.joined = null;
        else if (data.type === 'error') this.callbacks.onError?.(data);
      });
      socket.addEventListener('error', () => {
        if (!opened) { clearTimeout(timeout); this.connecting = null; reject(new Error('无法连接开服电脑，请从局域网地址打开游戏。')); }
        this.callbacks.onError?.({ code: 'CONNECTION_ERROR', message: '局域网连接失败，请确认地址、端口和开服状态。' });
      });
      socket.addEventListener('close', event => {
        clearTimeout(timeout);
        if (this.socket === socket) { this.socket = null; this.connecting = null; this.joined = null; }
        if (!opened) reject(new Error('连接已关闭。'));
        this.callbacks.onClose?.({ code: event.code, reason: event.reason });
      });
    });
    return this.connecting;
  }

  send(message) {
    if (this.socket?.readyState !== WebSocket.OPEN || this.socket.bufferedAmount > 64 * 1024) return false;
    this.socket.send(JSON.stringify(message));
    return true;
  }

  async create(options = {}) { await this.connect(); return this.send({ size: 4, ...options, type: 'create_room' }); }
  async join(roomId, name) { await this.connect(); return this.send({ type: 'join_room', roomId, name }); }
  sendInput(input) { return Boolean(this.joined) && this.send({ type: 'input', input }); }
  restart() { return this.send({ type: 'restart' }); }
  listRooms() { return this.send({ type: 'list_rooms' }); }
  leave() { this.joined = null; return this.send({ type: 'leave' }); }
  disconnect() { this.joined = null; this.socket?.close(1000, 'Client disconnect'); }
}
