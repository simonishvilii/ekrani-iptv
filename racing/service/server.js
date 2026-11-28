/*
 * Racing – LAN game server (plain Node.js, runs on the TV's Node 12 and on a PC for testing).
 *
 *   GET  /            the phone controller page (pad.html), opened from the QR code on the TV
 *   GET  /info        { ip, port }
 *   WS   /tv          the game on the TV (one at a time; a new one replaces the old)
 *   WS   /pad         a phone
 *
 * Messages are small JSON objects with a "t" (type) field:
 *   tv  -> server   { t:'hello', code }                  sets the 4-digit join code
 *                   { t:'to', id, m:{...} }              message for one phone
 *                   { t:'all', m:{...} }                 message for every phone
 *   server -> tv    { t:'info', ip, port }
 *                   { t:'join', id, name } / { t:'leave', id } / { t:'in', id, k } / { t:'cmd', id, c }
 *   pad -> server   { t:'join', code, pid, name }        pid: the phone's own id (kept across reconnects)
 *                   { t:'in', k }                        k: bit mask of the held buttons
 *                   { t:'cmd', c }                       one-off commands (start, pause)
 *   server -> pad   { t:'ok', id } / { t:'err', e:'code'|'tv' } / anything the TV sends
 *
 * WebSocket (RFC 6455) is implemented here: Node 12 has no WebSocket server and the
 * package must not need npm modules on the TV. Only what the game needs: text frames,
 * ping/pong, close; messages are tiny so fragmented frames are not expected.
 */
'use strict';

var http = require('http');
var crypto = require('crypto');
var fs = require('fs');
var path = require('path');
var os = require('os');

var GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

var state = {
  server: null,
  port: 0,
  code: '',
  tv: null,
  pads: {},      // id -> conn
  nextId: 1,
  byPid: {}      // phone's own id -> game id (same slot after a reconnect)
};

function localIp() {
  var nets = os.networkInterfaces(), best = null;
  Object.keys(nets).forEach(function (name) {
    (nets[name] || []).forEach(function (a) {
      if (a.family !== 'IPv4' && a.family !== 4) return;
      if (a.internal || /^169\.254\./.test(a.address)) return;
      var main = /^(eth|wlan|wl|wi-?fi|en)/i.test(name);
      if (!best || (main && !best.main)) best = { ip: a.address, main: main };
    });
  });
  return best ? best.ip : '';
}

/* ---------- WebSocket connection ---------- */

function Conn(socket) {
  this.socket = socket;
  this.buf = Buffer.alloc(0);
  this.open = true;
  this.onmessage = null;
  this.onclose = null;
  this.alive = true;
  var self = this;
  socket.setNoDelay(true);   // inputs must leave at once, not wait for Nagle
  socket.on('data', function (d) { self._data(d); });
  socket.on('close', function () { self._closed(); });
  socket.on('error', function () { self._closed(); });
}

Conn.prototype._data = function (d) {
  this.buf = this.buf.length ? Buffer.concat([this.buf, d]) : d;
  while (this.buf.length >= 2) {
    var b0 = this.buf[0], b1 = this.buf[1];
    var op = b0 & 0x0f, masked = (b1 & 0x80) !== 0, len = b1 & 0x7f, off = 2;
    if (len === 126) {
      if (this.buf.length < 4) return;
      len = this.buf.readUInt16BE(2); off = 4;
    } else if (len === 127) {
      if (this.buf.length < 10) return;
      len = this.buf.readUInt32BE(6); off = 10;
      if (len > 1 << 20) return this.close();
    }
    var maskAt = off;
    if (masked) off += 4;
    if (this.buf.length < off + len) return;
    var payload = Buffer.from(this.buf.slice(off, off + len));
    if (masked) for (var i = 0; i < len; i++) payload[i] ^= this.buf[maskAt + (i & 3)];
    this.buf = this.buf.slice(off + len);
    this.alive = true;
    if (op === 0x8) { this.close(); return; }
    if (op === 0x9) { this._frame(0xA, payload); continue; }
    if (op === 0xA) continue;
    if (op === 0x1 || op === 0x0) {
      var msg = null;
      try { msg = JSON.parse(payload.toString('utf8')); } catch (e) { /* ignore bad frames */ }
      if (msg && this.onmessage) this.onmessage(msg);
    }
  }
};

Conn.prototype._frame = function (op, payload) {
  if (!this.open) return;
  var len = payload.length, head;
  if (len < 126) { head = Buffer.from([0x80 | op, len]); }
  else if (len < 65536) { head = Buffer.alloc(4); head[0] = 0x80 | op; head[1] = 126; head.writeUInt16BE(len, 2); }
  else { head = Buffer.alloc(10); head[0] = 0x80 | op; head[1] = 127; head.writeUInt32BE(0, 2); head.writeUInt32BE(len, 6); }
  try { this.socket.write(Buffer.concat([head, payload])); } catch (e) { this._closed(); }
};

Conn.prototype.send = function (obj) { this._frame(0x1, Buffer.from(JSON.stringify(obj), 'utf8')); };
Conn.prototype.ping = function () { this._frame(0x9, Buffer.alloc(0)); };
Conn.prototype.close = function () {
  if (!this.open) return;
  this._frame(0x8, Buffer.alloc(0));
  try { this.socket.end(); } catch (e) { /* ignore */ }
  this._closed();
};
Conn.prototype._closed = function () {
  if (!this.open) return;
  this.open = false;
  try { this.socket.destroy(); } catch (e) { /* ignore */ }
  if (this.onclose) this.onclose();
};

/* ---------- game routing ---------- */

function toTv(msg) { if (state.tv && state.tv.open) state.tv.send(msg); }

function attachTv(conn) {
  if (state.tv) state.tv.close();
  state.tv = conn;
  conn.onmessage = function (m) {
    if (m.t === 'hello') {
      state.code = String(m.code || '');
      conn.send({ t: 'info', ip: localIp(), port: state.port });
      // phones that are already connected (the TV app was restarted) join again
      Object.keys(state.pads).forEach(function (id) {
        var p = state.pads[id];
        if (p.code === state.code) conn.send({ t: 'join', id: +id, name: p.name || '' });
        else { p.send({ t: 'err', e: 'code' }); p.close(); }
      });
    } else if (m.t === 'to') {
      var p = state.pads[m.id];
      if (p) p.send(m.m);
    } else if (m.t === 'all') {
      Object.keys(state.pads).forEach(function (id) { state.pads[id].send(m.m); });
    } else if (m.t === 'kick') {
      var k = state.pads[m.id];
      if (k) k.close();
    }
  };
  conn.onclose = function () {
    if (state.tv === conn) state.tv = null;
  };
}

function attachPad(conn) {
  var id = 0;
  conn.onmessage = function (m) {
    if (m.t === 'png') { conn.send({ t: 'png', ts: m.ts }); return; }   // round trip time shown on the phone
    if (!id) {
      if (m.t !== 'join') return;
      if (!state.tv) { conn.send({ t: 'err', e: 'tv' }); return; }
      if (String(m.code || '') !== state.code) { conn.send({ t: 'err', e: 'code' }); return; }
      var pid = String(m.pid || '').slice(0, 40);
      id = (pid && state.byPid[pid]) || state.nextId++;
      if (pid) state.byPid[pid] = id;
      var old = state.pads[id];
      state.pads[id] = conn;
      if (old && old !== conn) { old.onclose = null; old.close(); }
      conn.code = state.code;
      conn.name = String(m.name || '').slice(0, 16);
      conn.send({ t: 'ok', id: id });
      toTv({ t: 'join', id: id, name: conn.name });
      return;
    }
    if (m.t === 'in') toTv({ t: 'in', id: id, k: m.k | 0 });
    else if (m.t === 'cmd') toTv({ t: 'cmd', id: id, c: String(m.c || '') });
  };
  conn.onclose = function () {
    if (id && state.pads[id] === conn) {
      delete state.pads[id];
      toTv({ t: 'leave', id: id });
    }
  };
}

/* ---------- HTTP ---------- */

var padHtml = null;
function page() {
  // re-read while testing on the PC, cached on the TV
  if (!padHtml || process.env.RACING_DEV) padHtml = fs.readFileSync(path.join(__dirname, 'pad.html'));
  return padHtml;
}

function handle(req, res) {
  var url = req.url.split('?')[0];
  if (req.method === 'GET' && (url === '/' || url === '/pad' || url === '/index.html')) {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
    return res.end(page());
  }
  if (req.method === 'GET' && url === '/info') {
    res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'no-store' });
    return res.end(JSON.stringify({ ip: localIp(), port: state.port }));
  }
  res.writeHead(404, { 'Content-Type': 'text/plain' });
  res.end('not found');
}

function upgrade(req, socket) {
  var key = req.headers['sec-websocket-key'];
  var url = req.url.split('?')[0];
  if (!key || (url !== '/tv' && url !== '/pad')) { socket.destroy(); return; }
  var accept = crypto.createHash('sha1').update(key + GUID).digest('base64');
  socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n' +
    'Sec-WebSocket-Accept: ' + accept + '\r\n\r\n');
  var conn = new Conn(socket);
  if (url === '/tv') attachTv(conn); else attachPad(conn);
}

/* drop connections that stopped answering (phone locked, Wi-Fi lost) */
setInterval(function () {
  var all = Object.keys(state.pads).map(function (id) { return state.pads[id]; });
  if (state.tv) all.push(state.tv);
  all.forEach(function (c) {
    if (!c.alive) return c.close();
    c.alive = false;
    c.ping();
  });
}, 5000).unref();

function listen(port, last, cb) {
  var srv = http.createServer(handle);
  srv.on('upgrade', upgrade);
  srv.once('error', function (e) {
    if (port < last) listen(port + 1, last, cb); else cb(e);
  });
  srv.listen(port, '0.0.0.0', function () { cb(null, srv, port); });
}

/* starts once; later calls return the running server */
function start(port, cb) {
  if (state.server) return cb(null, state.port);
  listen(port, port + 9, function (err, srv, p) {
    if (err) return cb(err);
    state.server = srv;
    state.port = p;
    cb(null, p);
  });
}

module.exports = { start: start, localIp: localIp, state: state };
