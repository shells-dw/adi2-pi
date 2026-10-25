'use strict';
/**
 * Minimal MQTT 3.1.1 client (TCP, QoS 0) without dependencies: connect with optional user name,
 * password and last will, publish, subscribe, keep-alive, reconnect.
 *
 * Events: 'connect', 'close' (reason), 'message' (topic, payload string), 'error' (Error)
 */
const net = require('net');
const { EventEmitter } = require('events');

const KEEPALIVE_S = 30;
const CONNACK_ERRORS = { 1: 'protocol version refused', 2: 'client id refused', 3: 'server unavailable', 4: 'wrong user name or password', 5: 'not authorised' };

function varint(n) {
  const out = [];
  do {
    let b = n % 128;
    n = Math.floor(n / 128);
    if (n > 0) b |= 0x80;
    out.push(b);
  } while (n > 0);
  return Buffer.from(out);
}

const str = (s) => {
  const b = Buffer.from(String(s), 'utf8');
  const len = Buffer.alloc(2);
  len.writeUInt16BE(b.length);
  return Buffer.concat([len, b]);
};

const packet = (type, body) => Buffer.concat([Buffer.from([type]), varint(body.length), body]);

function connectPacket({ clientId, username, password, will, keepalive = KEEPALIVE_S }) {
  let flags = 0x02; // clean session
  const payload = [str(clientId)];
  if (will) {
    flags |= 0x04 | (will.retain ? 0x20 : 0);
    payload.push(str(will.topic), str(will.payload));
  }
  if (username) { flags |= 0x80; payload.push(str(username)); }
  if (username && password) { flags |= 0x40; payload.push(str(password)); }
  const ka = Buffer.alloc(2);
  ka.writeUInt16BE(keepalive);
  return packet(0x10, Buffer.concat([str('MQTT'), Buffer.from([4, flags]), ka, ...payload]));
}

const publishPacket = (topic, payload, retain) => packet(0x30 | (retain ? 1 : 0), Buffer.concat([str(topic), Buffer.from(String(payload), 'utf8')]));

function subscribePacket(id, topics) {
  const pid = Buffer.alloc(2);
  pid.writeUInt16BE(id);
  return packet(0x82, Buffer.concat([pid, ...topics.map((t) => Buffer.concat([str(t), Buffer.from([0])]))]));
}

/** Split a byte stream into MQTT packets: [{ type, flags, body }] and the rest. */
function parse(buf) {
  const out = [];
  let i = 0;
  while (i < buf.length) {
    let mult = 1, len = 0, j = i + 1, b;
    do {
      if (j >= buf.length) return { packets: out, rest: buf.subarray(i) };
      b = buf[j++];
      len += (b & 0x7f) * mult;
      mult *= 128;
    } while (b & 0x80);
    if (j + len > buf.length) return { packets: out, rest: buf.subarray(i) };
    out.push({ type: buf[i] >> 4, flags: buf[i] & 0x0f, body: buf.subarray(j, j + len) });
    i = j + len;
  }
  return { packets: out, rest: Buffer.alloc(0) };
}

class MqttClient extends EventEmitter {
  /**
   * @param {object} o  { host, port, clientId, username, password, will: { topic, payload, retain } }
   */
  constructor(o) {
    super();
    this.o = o;
    this.sock = null;
    this.connected = false;
    this.stopped = true;
    this.retry = 2000;
    this.buf = Buffer.alloc(0);
    this.subs = [];
    this.pid = 0;
  }

  start() { this.stopped = false; this._connect(); return this; }

  stop() {
    this.stopped = true;
    clearTimeout(this.retryTimer);
    clearInterval(this.pingTimer);
    if (this.sock) {
      if (this.connected) { try { this.sock.write(Buffer.from([0xe0, 0])); } catch { /* closing */ } }
      this.sock.destroy();
    }
  }

  _connect() {
    const s = net.connect({ host: this.o.host, port: this.o.port || 1883 });
    this.sock = s;
    this.buf = Buffer.alloc(0);
    s.setNoDelay(true);
    s.setTimeout(KEEPALIVE_S * 1500);
    s.on('connect', () => s.write(connectPacket(this.o)));
    s.on('data', (d) => this._data(d));
    s.on('timeout', () => s.destroy(new Error('no answer from the MQTT server')));
    s.on('error', (e) => this.emit('error', e));
    s.on('close', () => {
      const was = this.connected;
      this.connected = false;
      clearInterval(this.pingTimer);
      if (was) this.emit('close', 'connection closed');
      if (this.stopped) return;
      this.retryTimer = setTimeout(() => this._connect(), this.retry);
      this.retryTimer.unref?.();
      this.retry = Math.min(this.retry * 2, 60000);
    });
  }

  _data(d) {
    const { packets, rest } = parse(Buffer.concat([this.buf, d]));
    this.buf = rest;
    for (const p of packets) {
      if (p.type === 2) { // CONNACK
        const rc = p.body[1];
        if (rc !== 0) { this.emit('error', new Error(`MQTT server: ${CONNACK_ERRORS[rc] || `refused (${rc})`}`)); this.sock.destroy(); continue; }
        this.connected = true;
        this.retry = 2000;
        this.pingTimer = setInterval(() => { try { this.sock.write(Buffer.from([0xc0, 0])); } catch { /* closing */ } }, KEEPALIVE_S * 1000);
        this.pingTimer.unref?.();
        if (this.subs.length) this.sock.write(subscribePacket(this._pid(), this.subs));
        this.emit('connect');
      } else if (p.type === 3) { // PUBLISH
        const tl = p.body.readUInt16BE(0);
        const topic = p.body.subarray(2, 2 + tl).toString('utf8');
        const qos = (p.flags >> 1) & 3;
        let off = 2 + tl;
        if (qos > 0) {
          const id = p.body.readUInt16BE(off);
          off += 2;
          if (qos === 1) { const ack = Buffer.alloc(2); ack.writeUInt16BE(id); this.sock.write(packet(0x40, ack)); }
        }
        this.emit('message', topic, p.body.subarray(off).toString('utf8'));
      }
      // SUBACK, PINGRESP: nothing to do
    }
  }

  _pid() { this.pid = (this.pid % 65535) + 1; return this.pid; }

  subscribe(topics) {
    this.subs = [...new Set([...this.subs, ...topics])];
    if (this.connected) this.sock.write(subscribePacket(this._pid(), topics));
  }

  publish(topic, payload, { retain = false } = {}) {
    if (!this.connected) return false;
    this.sock.write(publishPacket(topic, payload, retain));
    return true;
  }
}

module.exports = { MqttClient, parse, connectPacket, publishPacket, subscribePacket, varint };
