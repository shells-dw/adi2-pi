'use strict';
/**
 * Minimal WebSocket server (RFC 6455) on Node's http module – no dependencies.
 * Text messages only (JSON), fragmentation, ping/pong keep-alive, close handshake.
 */
const crypto = require('crypto');
const { EventEmitter } = require('events');

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
const MAX_MESSAGE = 1 << 20;
const PING_MS = 25000;

class WsClient extends EventEmitter {
  constructor(socket, req) {
    super();
    this.socket = socket;
    this.req = req;
    this.remote = req.socket.remoteAddress;
    this.buf = Buffer.alloc(0);
    this.fragments = null;
    this.fragOpcode = 0;
    this.closed = false;
    this.alive = true;
    socket.setNoDelay(true);
    socket.on('data', (d) => this._onData(d));
    socket.on('close', () => this._gone());
    socket.on('error', () => this._gone());
  }

  send(obj) {
    if (this.closed) return;
    const payload = Buffer.from(typeof obj === 'string' ? obj : JSON.stringify(obj));
    this._frame(0x1, payload);
  }

  close(code = 1000, reason = '') {
    if (this.closed) return;
    const p = Buffer.alloc(2 + Buffer.byteLength(reason));
    p.writeUInt16BE(code, 0);
    p.write(reason, 2);
    this._frame(0x8, p);
    this.closed = true;
    this.socket.end();
    setTimeout(() => this.socket.destroy(), 1000).unref();
  }

  _frame(opcode, payload) {
    const len = payload.length;
    let head;
    if (len < 126) head = Buffer.from([0x80 | opcode, len]);
    else if (len < 65536) {
      head = Buffer.alloc(4);
      head[0] = 0x80 | opcode; head[1] = 126; head.writeUInt16BE(len, 2);
    } else {
      head = Buffer.alloc(10);
      head[0] = 0x80 | opcode; head[1] = 127; head.writeBigUInt64BE(BigInt(len), 2);
    }
    try { this.socket.write(Buffer.concat([head, payload])); } catch { this._gone(); }
  }

  _gone() {
    if (this.closed && this._emittedClose) return;
    this.closed = true;
    if (!this._emittedClose) {
      this._emittedClose = true;
      this.emit('close');
    }
  }

  _onData(d) {
    this.buf = this.buf.length ? Buffer.concat([this.buf, d]) : d;
    for (;;) {
      if (this.buf.length < 2) return;
      const b0 = this.buf[0], b1 = this.buf[1];
      const fin = (b0 & 0x80) !== 0;
      const opcode = b0 & 0x0f;
      const masked = (b1 & 0x80) !== 0;
      let len = b1 & 0x7f;
      let off = 2;
      if (len === 126) {
        if (this.buf.length < 4) return;
        len = this.buf.readUInt16BE(2); off = 4;
      } else if (len === 127) {
        if (this.buf.length < 10) return;
        const big = this.buf.readBigUInt64BE(2);
        if (big > BigInt(MAX_MESSAGE)) return this.close(1009, 'too big');
        len = Number(big); off = 10;
      }
      if (!masked) return this.close(1002, 'client frames must be masked');
      if (len > MAX_MESSAGE) return this.close(1009, 'too big');
      if (this.buf.length < off + 4 + len) return;
      const mask = this.buf.subarray(off, off + 4);
      const payload = Buffer.from(this.buf.subarray(off + 4, off + 4 + len));
      for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i & 3];
      this.buf = this.buf.subarray(off + 4 + len);
      this._onFrame(fin, opcode, payload);
      if (this.closed) return;
    }
  }

  _onFrame(fin, opcode, payload) {
    this.alive = true;
    switch (opcode) {
      case 0x0: // continuation
        if (!this.fragments) return this.close(1002, 'unexpected continuation');
        this.fragments.push(payload);
        if (this.fragments.reduce((n, b) => n + b.length, 0) > MAX_MESSAGE) return this.close(1009, 'too big');
        if (fin) {
          const all = Buffer.concat(this.fragments);
          this.fragments = null;
          if (this.fragOpcode === 0x1) this.emit('message', all.toString('utf8'));
        }
        return;
      case 0x1:
      case 0x2:
        if (!fin) {
          this.fragments = [payload];
          this.fragOpcode = opcode;
          return;
        }
        if (opcode === 0x1) this.emit('message', payload.toString('utf8'));
        return;
      case 0x8:
        if (!this.closed) {
          this._frame(0x8, payload.subarray(0, 2));
          this.closed = true;
          this.socket.end();
        }
        this._gone();
        return;
      case 0x9:
        this._frame(0xa, payload);
        return;
      case 0xa:
        return;
      default:
        this.close(1002, 'unknown opcode');
    }
  }
}

class WsServer extends EventEmitter {
  /** @param {import('http').Server} http @param {string} path */
  constructor(http, path) {
    super();
    this.clients = new Set();
    http.on('upgrade', (req, socket) => {
      const url = new URL(req.url, 'http://x');
      const key = req.headers['sec-websocket-key'];
      if (url.pathname !== path || !key || (req.headers.upgrade || '').toLowerCase() !== 'websocket') {
        socket.end('HTTP/1.1 400 Bad Request\r\n\r\n');
        return;
      }
      const accept = crypto.createHash('sha1').update(key + GUID).digest('base64');
      socket.write(
        'HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n' +
        `Sec-WebSocket-Accept: ${accept}\r\n\r\n`,
      );
      const c = new WsClient(socket, req);
      c.query = url.searchParams;
      this.clients.add(c);
      c.on('close', () => this.clients.delete(c));
      this.emit('connection', c);
    });
    this.pinger = setInterval(() => {
      for (const c of this.clients) {
        if (!c.alive) { c.socket.destroy(); continue; }
        c.alive = false;
        c._frame(0x9, Buffer.alloc(0));
      }
    }, PING_MS);
    this.pinger.unref();
  }

  broadcast(obj, filter) {
    const s = JSON.stringify(obj);
    for (const c of this.clients) if (!filter || filter(c)) c.send(s);
  }

  close() {
    clearInterval(this.pinger);
    for (const c of this.clients) c.close(1001, 'shutting down');
  }
}

module.exports = { WsServer };
