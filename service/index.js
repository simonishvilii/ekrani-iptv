/*
 * Ekrani IPTV – network helper service (runs on the TV, Node.js).
 *
 * Some IPTV servers do not send CORS headers, so the web app cannot read
 * playlists / EPG directly. The app then asks this service to download the
 * file. Large bodies are returned in chunks because Luna bus messages are
 * size-limited.
 *
 *   luna://com.ekrani.iptv.service/fetch  { url, headers? }
 *       -> { returnValue, id, size, status, contentType }
 *   luna://com.ekrani.iptv.service/chunk  { id, offset, length }
 *       -> { returnValue, data, done }
 *
 * XMLTV guides can be huge (hundreds of MB unpacked), far more than the web
 * app can hold. They are streamed instead: downloaded, gunzipped and parsed
 * here piece by piece, keeping only the wanted channels and time window.
 *
 *   luna://com.ekrani.iptv.service/epgOpen { url, headers? }
 *       -> { returnValue, id, status, channels: [[id, name, name…], …], bytes, total }
 *   luna://com.ekrani.iptv.service/epgNext { id, want?: [lowercase channel ids], from?, to?, max? }
 *       -> { returnValue, data: { channelId: [[startSec, stopSec, title, desc], …] }, done, bytes, total }
 *      (bytes / total: downloaded so far / Content-Length, for a progress bar)
 *      (want/from/to are given on the first call; the stream pauses between calls)
 *
 *   luna://com.ekrani.iptv.service/release { id }   (both kinds)
 *
 * Phone setup: a tiny web page in the home network where a playlist can be
 * typed on the phone and sent to the TV (the TV shows the address as a QR code).
 *
 *   luna://com.ekrani.iptv.service/lanStart { code, texts } -> { returnValue, ip, port }
 *   luna://com.ekrani.iptv.service/lanPoll  {}  -> { returnValue, items: [{type,name,url,server,user,pass,epg}] }
 *   luna://com.ekrani.iptv.service/lanStop  {}
 *   (stops by itself when the app has not polled for a minute)
 *
 * YouTube: luna://com.ekrani.iptv.service/ytServe {} -> { returnValue, port }
 *   serves yt.html at http://127.0.0.1:<port>/yt.html (the app embeds it; see app/js/ytplayer.js)
 */
'use strict';

var pkgInfo = require('./package.json');
var Service = require('webos-service');
var http = require('http');
var https = require('https');
var zlib = require('zlib');
var urlLib = require('url');
var stream = require('stream');
var StringDecoder = require('string_decoder').StringDecoder;
var os = require('os');
var qs = require('querystring');

var service = new Service(pkgInfo.name);
try {
  // keep the service alive a little longer between chunk requests
  service.activityManager.idleTimeout = 60;
} catch (e) { /* older webos-service */ }

var UA = 'Mozilla/5.0 (Web0S; Linux/SmartTV) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/79.0 Safari/537.36 EkraniIPTV/1.0';

var store = {};
var jobs = {};
var seq = 0;
var CACHE_TTL = 120 * 1000;
var JOB_TTL = 5 * 60 * 1000;

function cleanup() {
  var now = Date.now();
  Object.keys(store).forEach(function (k) {
    if (now - store[k].time > CACHE_TTL) delete store[k];
  });
  Object.keys(jobs).forEach(function (k) {
    if (now - jobs[k].time > JOB_TTL) jobs[k].close();
  });
}

/* GET with redirects; cb(err, res) gets the final response (body not read yet) */
function request(url, headers, redirects, cb) {
  var u;
  try { u = urlLib.parse(url); } catch (e) { return cb(e); }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return cb(new Error('Unsupported URL'));
  var mod = u.protocol === 'https:' ? https : http;
  var opts = {
    protocol: u.protocol,
    hostname: u.hostname,
    port: u.port,
    path: u.path,
    method: 'GET',
    headers: Object.assign({ 'User-Agent': UA, 'Accept': '*/*', 'Accept-Encoding': 'gzip, deflate' }, headers || {}),
    rejectUnauthorized: false,
    timeout: 60000
  };
  var done = false;
  var finish = function (err, res) { if (!done) { done = true; cb(err, res); } };
  var req = mod.request(opts, function (res) {
    if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
      res.resume();
      if (redirects > 6) return finish(new Error('Too many redirects'));
      done = true;
      return request(urlLib.resolve(url, res.headers.location), headers, redirects + 1, cb);
    }
    finish(null, res);
  });
  req.on('timeout', function () { req.abort(); finish(new Error('Timeout')); });
  req.on('error', function (e) { finish(e); });
  req.end();
}

/* response -> stream of plain bytes: undoes Content-Encoding and a gzip file body (.xml.gz).
   onBytes(n) is told about every received (still compressed) chunk, for progress. */
function plainBody(res, cb, onBytes) {
  var raw = res;
  if (onBytes) {
    var counter = new stream.Transform({ transform: function (c, e, done) { onBytes(c.length); done(null, c); } });
    res.on('error', function (e) { counter.emit('error', e); });
    raw = res.pipe(counter);
  }
  var src = raw;
  var enc = (res.headers['content-encoding'] || '').toLowerCase();
  if (enc === 'gzip' || enc === 'x-gzip') src = raw.pipe(zlib.createGunzip());
  else if (enc === 'deflate') src = raw.pipe(zlib.createInflate());
  if (src !== raw) raw.on('error', function (e) { src.emit('error', e); });

  var started = false;
  src.once('data', function (first) {
    started = true;
    src.pause();
    var out = (first.length > 1 && first[0] === 0x1f && first[1] === 0x8b) ? zlib.createGunzip() : new stream.PassThrough();
    src.on('error', function (e) { out.emit('error', e); });
    out.write(first);
    src.pipe(out);
    cb(out);
  });
  src.once('end', function () {
    if (started) return;
    var empty = new stream.PassThrough();
    cb(empty);
    empty.end();
  });
}

function download(url, headers, cb) {
  request(url, headers, 0, function (err, res) {
    if (err) return cb(err);
    plainBody(res, function (body) {
      var chunks = [];
      var total = 0;
      body.on('data', function (c) { chunks.push(c); total += c.length; });
      body.on('error', function (e) { cb(e); });
      body.on('end', function () {
        cb(null, {
          status: res.statusCode,
          contentType: res.headers['content-type'] || '',
          body: Buffer.concat(chunks, total).toString('utf8')
        });
      });
    });
  });
}

/* ------------------------------------------------------------------ */
/*  XMLTV streaming                                                    */
/* ------------------------------------------------------------------ */

function decode(s) {
  if (!s) return '';
  s = s.replace(/^\s*<!\[CDATA\[([\s\S]*?)\]\]>\s*$/, '$1');
  return s.replace(/&(#x?[0-9a-f]+|amp|lt|gt|quot|apos);/gi, function (m, e) {
    switch (e.toLowerCase()) {
      case 'amp': return '&'; case 'lt': return '<'; case 'gt': return '>';
      case 'quot': return '"'; case 'apos': return "'";
    }
    var code = e.charAt(1).toLowerCase() === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
    try { return String.fromCodePoint(code); } catch (x) { return ''; }
  }).trim();
}

var RE_ATTR = {
  id: /\bid\s*=\s*"([^"]*)"/, channel: /\bchannel\s*=\s*"([^"]*)"/,
  start: /\bstart\s*=\s*"([^"]*)"/, stop: /\bstop\s*=\s*"([^"]*)"/
};
function attr(str, name) {
  var m = RE_ATTR[name].exec(str);
  if (!m) m = new RegExp('\\b' + name + "\\s*=\\s*'([^']*)'").exec(str);
  return m ? m[1] : '';
}

/* XMLTV time "20261118220000 +0300" -> unix seconds */
function xmlTime(s) {
  var m = /^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})?\s*([+-]\d{2})?(\d{2})?/.exec(s || '');
  if (!m) return 0;
  var t = Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +(m[6] || 0)) / 1000;
  if (m[7]) {
    var sign = m[7].charAt(0) === '-' ? -1 : 1;
    t -= sign * (Math.abs(parseInt(m[7], 10)) * 60 + parseInt(m[8] || '0', 10)) * 60;
  }
  return t;
}

var RE_CH = /<channel\b([^>]*)>([\s\S]*?)<\/channel>/g;
var RE_DN = /<display-name[^>]*>([\s\S]*?)<\/display-name>/g;
var RE_PROG = /<programme\b([^>]*)>([\s\S]*?)<\/programme>/g;
var RE_TITLE = /<title[^>]*>([\s\S]*?)<\/title>/;
var RE_DESC = /<desc[^>]*>([\s\S]*?)<\/desc>/;
var MAX_BUF = 16 * 1024 * 1024;   // a single element never gets this big
var MAX_DESC = 700;

function EpgJob(id) {
  this.id = id;
  this.time = Date.now();
  this.body = null;
  this.res = null;
  this.dec = new StringDecoder('utf8');
  this.buf = '';
  this.header = true;          // still reading <channel> elements
  this.channels = [];
  this.want = null;
  this.from = 0;
  this.to = Infinity;
  this.max = 300 * 1024;
  this.out = {};
  this.outSize = 0;
  this.ended = false;
  this.error = null;
  this.waiter = null;          // function(job) waiting for a batch or the channel list
  this.bytes = 0;              // received so far (as sent, i.e. compressed)
  this.total = 0;              // Content-Length, 0 when unknown
}

EpgJob.prototype.attach = function (body) {
  var self = this;
  this.body = body;
  body.on('data', function (chunk) { self.feed(self.dec.write(chunk)); });
  body.on('end', function () {
    self.feed(self.dec.end());
    self.ended = true;
    self.header = false;
    self.wake();
  });
  body.on('error', function (e) {
    self.error = e;
    self.ended = true;
    self.wake();
  });
};

EpgJob.prototype.feed = function (text) {
  if (!text) return;
  this.buf += text;
  if (this.header) this.readChannels();
  if (!this.header && this.want) this.readProgrammes();
  if (this.buf.length > MAX_BUF) this.buf = this.buf.slice(-1024 * 1024);
};

EpgJob.prototype.readChannels = function () {
  var buf = this.buf, m, last = 0;
  var stop = buf.indexOf('<programme');
  RE_CH.lastIndex = 0;
  while ((m = RE_CH.exec(buf))) {
    if (stop >= 0 && m.index > stop) break;
    var row = [decode(attr(m[1], 'id'))], d;
    RE_DN.lastIndex = 0;
    while ((d = RE_DN.exec(m[2])) && row.length < 4) row.push(decode(d[1]));
    this.channels.push(row);
    last = RE_CH.lastIndex;
  }
  if (stop >= 0) {
    this.header = false;
    this.buf = buf.slice(stop);
    this.body.pause();          // wait for epgNext with the wanted channel list
    this.wake();
  } else if (last) {
    this.buf = buf.slice(last);
  } else if (buf.length > 65536) {
    var cut = buf.lastIndexOf('<channel');
    this.buf = cut > 0 ? buf.slice(cut) : buf.slice(-4096);
  }
};

EpgJob.prototype.readProgrammes = function () {
  var buf = this.buf, m, last = 0;
  var want = this.want, from = this.from, to = this.to;
  RE_PROG.lastIndex = 0;
  while ((m = RE_PROG.exec(buf))) {
    last = RE_PROG.lastIndex;
    var a = m[1];
    var cid = decode(attr(a, 'channel'));
    if (!want[cid.toLowerCase()]) continue;
    var s = xmlTime(attr(a, 'start'));
    var e = xmlTime(attr(a, 'stop')) || s + 1800;
    if (!s || e <= from || s >= to) continue;
    var body = m[2];
    var tm = RE_TITLE.exec(body), dm = RE_DESC.exec(body);
    var title = tm ? decode(tm[1]) : '';
    var desc = dm ? decode(dm[1]) : '';
    if (desc.length > MAX_DESC) desc = desc.slice(0, MAX_DESC - 1) + '…';
    // copy so the result does not pin the big chunk string in memory
    title = (' ' + title).slice(1);
    desc = desc ? (' ' + desc).slice(1) : '';
    (this.out[cid] = this.out[cid] || []).push([s, e, title, desc]);
    this.outSize += title.length + desc.length + 24;
  }
  if (last) this.buf = buf.slice(last);
  else if (buf.length > 65536 && buf.indexOf('<programme') < 0) this.buf = buf.slice(-4096);
  if (this.outSize >= this.max) {
    this.body.pause();
    this.wake();
  }
};

EpgJob.prototype.wake = function () {
  var w = this.waiter;
  if (!w) return;
  if (this.ended || this.error || (this.want ? this.outSize >= this.max : !this.header)) {
    this.waiter = null;
    w(this);
  }
};

EpgJob.prototype.take = function () {
  var data = this.out;
  this.out = {};
  this.outSize = 0;
  return data;
};

EpgJob.prototype.close = function () {
  delete jobs[this.id];
  this.waiter = null;
  try { if (this.body) { this.body.removeAllListeners('data'); this.body.pause(); } } catch (e) { /* ignore */ }
  try { if (this.res) this.res.destroy(); } catch (e) { /* ignore */ }
  this.buf = '';
  this.out = {};
};

service.register('epgOpen', function (message) {
  cleanup();
  var p = message.payload || {};
  if (!p.url) return message.respond({ returnValue: false, errorText: 'url is required' });
  request(p.url, Object.assign({ 'Accept-Encoding': 'gzip' }, p.headers || {}), 0, function (err, res) {
    if (err) return message.respond({ returnValue: false, errorText: String(err.message || err.code || err) });
    if (res.statusCode >= 400) {
      res.resume();
      return message.respond({ returnValue: false, errorText: 'HTTP ' + res.statusCode, status: res.statusCode });
    }
    if (res.socket && res.socket.setTimeout) res.socket.setTimeout(0);   // it is paused between epgNext calls
    var id = 'e' + (++seq);
    var job = jobs[id] = new EpgJob(id);
    job.res = res;
    job.waiter = function (j) {
      if (j.error && !j.channels.length) {
        j.close();
        return message.respond({ returnValue: false, errorText: String(j.error.message || j.error) });
      }
      message.respond({ returnValue: true, id: id, status: res.statusCode, channels: j.channels, done: j.ended, bytes: j.bytes, total: j.total });
      if (j.ended) j.close();
    };
    job.total = parseInt(res.headers['content-length'], 10) || 0;
    plainBody(res, function (body) { job.attach(body); }, function (n) { job.bytes += n; });
  });
});

service.register('epgNext', function (message) {
  var p = message.payload || {};
  var job = jobs[p.id];
  if (!job) return message.respond({ returnValue: false, errorText: 'unknown id' });
  job.time = Date.now();
  if (p.want) {
    job.want = {};
    p.want.forEach(function (w) { job.want[String(w).toLowerCase()] = true; });
    if (p.from) job.from = p.from;
    if (p.to) job.to = p.to;
    if (p.max) job.max = Math.max(32 * 1024, Math.min(p.max, 2 * 1024 * 1024));
  }
  if (!job.want) return message.respond({ returnValue: false, errorText: 'want is required' });
  if (job.error) {
    job.close();
    return message.respond({ returnValue: false, errorText: String(job.error.message || job.error) });
  }
  job.waiter = function (j) {
    if (j.error) {
      j.close();
      return message.respond({ returnValue: false, errorText: String(j.error.message || j.error) });
    }
    var done = j.ended;
    message.respond({ returnValue: true, data: j.take(), done: done, bytes: j.bytes, total: j.total });
    if (done) j.close();
  };
  // programmes already buffered from the last chunk
  if (job.buf) job.readProgrammes();
  if (job.waiter) {
    job.wake();
    if (job.waiter && !job.ended) job.body.resume();
  }
});

/* ------------------------------------------------------------------ */

service.register('fetch', function (message) {
  cleanup();
  var p = message.payload || {};
  if (!p.url) {
    return message.respond({ returnValue: false, errorText: 'url is required' });
  }
  download(p.url, p.headers, function (err, res) {
    if (err) {
      return message.respond({ returnValue: false, errorText: String(err.message || err.code || err) });
    }
    var id = 'r' + (++seq);
    store[id] = { time: Date.now(), body: res.body };
    message.respond({
      returnValue: true,
      id: id,
      size: res.body.length,
      status: res.status,
      contentType: res.contentType
    });
  });
});

service.register('chunk', function (message) {
  var p = message.payload || {};
  var item = store[p.id];
  if (!item) return message.respond({ returnValue: false, errorText: 'unknown id' });
  item.time = Date.now();
  var offset = p.offset || 0;
  var length = p.length || 512 * 1024;
  var data = item.body.substr(offset, length);
  var done = offset + length >= item.body.length;
  if (done) delete store[p.id];
  message.respond({ returnValue: true, data: data, done: done });
});

service.register('release', function (message) {
  var p = message.payload || {};
  delete store[p.id];
  if (jobs[p.id]) jobs[p.id].close();
  message.respond({ returnValue: true });
});

/* ---------- phone setup page ---------- */

var lan = null;   // { server, port, code, texts, inbox, last, timer }

function esc(v) {
  return String(v == null ? '' : v).replace(/[&<>"']/g, function (c) {
    return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
  });
}

function localIp() {
  var nets = os.networkInterfaces(), best = '';
  Object.keys(nets).forEach(function (name) {
    (nets[name] || []).forEach(function (a) {
      if (a.family !== 'IPv4' && a.family !== 4) return;
      if (a.internal || /^169\.254\./.test(a.address)) return;
      // prefer the wired / Wi-Fi adapter over anything else (e.g. docker or p2p links)
      if (!best || (/^(eth|wlan|wl|wi-?fi)/i.test(name) && !best.main)) best = { ip: a.address, main: /^(eth|wlan|wl|wi-?fi)/i.test(name) };
    });
  });
  return best ? best.ip : '';
}

function lanPage(t, note, ok, mode) {
  t = t || {};
  if (mode === 'yt' && t.ytTitle) t = Object.assign({}, t, { title: t.ytTitle });
  function f(id, label, type, ph) {
    return '<label id="f_' + id + '">' + esc(label) + '<input name="' + id + '" type="' + (type || 'text') + '" placeholder="' + esc(ph || '') +
      '" autocomplete="off" autocapitalize="off" spellcheck="false"></label>';
  }
  return '<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">' +
    '<title>' + esc(t.title) + '</title><style>' +
    'body{font:16px/1.4 system-ui,sans-serif;margin:0;background:#0d1117;color:#e6edf3}main{max-width:520px;margin:0 auto;padding:20px 16px}' +
    'h1{font-size:20px;margin:0 0 16px}label{display:block;margin:0 0 14px;font-size:14px;color:#9aa7b4}' +
    'input,select{display:block;width:100%;box-sizing:border-box;margin-top:6px;padding:12px;font-size:16px;border-radius:8px;border:1px solid #30363d;background:#161b22;color:#e6edf3}' +
    'button{width:100%;padding:14px;font-size:17px;font-weight:600;border:0;border-radius:8px;background:#2f7cf6;color:#fff}' +
    '.note{padding:12px;border-radius:8px;margin:0 0 16px;background:' + (ok ? '#123d1f' : '#4a1515') + '}.hint{font-size:12px;color:#7d8590;margin-top:4px}' +
    '</style></head><body><main><h1>' + esc(t.title) + '</h1>' + (note ? '<div class="note">' + esc(note) + '</div>' : '') +
    (mode === 'yt' ? ytForm(t, f) : '<form method="post" action="/send">' +
    '<label>' + esc(t.type) + '<select name="type" id="type"><option value="m3u">' + esc(t.m3u) + '</option><option value="xtream">' + esc(t.xtream) + '</option></select></label>' +
    f('name', t.name, 'text', 'My IPTV') +
    f('url', t.url, 'url', 'http://example.com/playlist.m3u') +
    f('server', t.server, 'url', 'http://host:8080') + f('user', t.user) + f('pass', t.pass, 'password') +
    f('epg', t.epg, 'text', 'https://…/epg.xml.gz') + '<div class="hint">' + esc(t.epgHint) + '</div><br>' +
    f('code', t.codeHint, 'tel', '0000') +
    '<button type="submit">' + esc(t.send) + '</button></form></main><script>' +
    'var s=document.getElementById("type");function u(){var x=s.value==="xtream";["url"].forEach(function(i){document.getElementById("f_"+i).style.display=x?"none":""});' +
    '["server","user","pass"].forEach(function(i){document.getElementById("f_"+i).style.display=x?"":"none"})}s.onchange=u;u();</script>') + '</body></html>';
}

/* YouTube: API key + channel list (one per line) */
function ytForm(t, f) {
  return '<form method="post" action="/send"><input type="hidden" name="type" value="yt">' +
    f('key', t.ytKey, 'text', 'AIza…') +
    '<label>' + esc(t.ytChannels) + '<textarea name="channels" rows="6" autocomplete="off" autocapitalize="off" spellcheck="false" placeholder="@channel&#10;https://www.youtube.com/@channel" ' +
    'style="display:block;width:100%;box-sizing:border-box;margin-top:6px;padding:12px;font-size:16px;border-radius:8px;border:1px solid #30363d;background:#161b22;color:#e6edf3"></textarea></label>' +
    f('code', t.codeHint, 'tel', '0000') +
    '<button type="submit">' + esc(t.send) + '</button></form></main>';
}

function lanHandle(req, res) {
  function send(code, html) { res.writeHead(code, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' }); res.end(html); }
  if (!lan) return send(503, 'stopped');
  if (req.method === 'POST' && req.url.indexOf('/send') === 0) {
    var body = '', big = false;
    req.setEncoding('utf8');
    req.on('data', function (d) { body += d; if (body.length > 65536) { big = true; req.destroy(); } });
    req.on('end', function () {
      if (big || !lan) return;
      var v = qs.parse(body), t = lan.texts || {};
      if (String(v.code || '').trim() !== lan.code) return send(403, lanPage(t, t.badCode, false, lan.mode));
      var item;
      if (lan.mode === 'yt') {
        item = { type: 'yt', key: String(v.key || '').replace(/\s+/g, '').slice(0, 200), channels: String(v.channels || '').slice(0, 8000) };
      } else {
        item = { type: v.type === 'xtream' ? 'xtream' : 'm3u' };
        ['name', 'url', 'server', 'user', 'pass', 'epg'].forEach(function (k) { item[k] = String(v[k] || '').trim().slice(0, 4000); });
      }
      lan.inbox.push(item);
      if (lan.inbox.length > 5) lan.inbox.shift();
      send(200, lanPage(t, t.sent, true, lan.mode));
    });
    return;
  }
  if (req.method === 'GET' && (req.url === '/' || req.url.indexOf('/?') === 0)) return send(200, lanPage(lan.texts, '', false, lan.mode));
  send(404, 'not found');
}

function lanStop() {
  if (!lan) return;
  clearInterval(lan.timer);
  try { lan.server.close(); } catch (e) { /* ignore */ }
  lan = null;
}

function lanListen(port, cb) {
  var srv = http.createServer(lanHandle);
  srv.once('error', function (e) {
    if (port < 8899) lanListen(port + 1, cb); else cb(e);
  });
  srv.listen(port, '0.0.0.0', function () { cb(null, srv, port); });
}

service.register('lanStart', function (message) {
  var p = message.payload || {};
  var code = String(p.code || '').replace(/\D/g, '').slice(0, 8);
  if (!code) return message.respond({ returnValue: false, errorText: 'code is required' });
  if (lan) {
    lan.code = code; lan.texts = p.texts || lan.texts; lan.mode = p.mode || 'playlist'; lan.last = Date.now();
    return message.respond({ returnValue: true, ip: localIp(), port: lan.port });
  }
  lanListen(8890, function (err, srv, port) {
    if (err) return message.respond({ returnValue: false, errorText: String(err.message || err) });
    lan = { server: srv, port: port, code: code, texts: p.texts || {}, mode: p.mode || 'playlist', inbox: [], last: Date.now() };
    lan.timer = setInterval(function () { if (lan && Date.now() - lan.last > 60000) lanStop(); }, 10000);
    message.respond({ returnValue: true, ip: localIp(), port: port });
  });
});

service.register('lanPoll', function (message) {
  if (!lan) return message.respond({ returnValue: false, errorText: 'not running' });
  lan.last = Date.now();
  message.respond({ returnValue: true, items: lan.inbox.splice(0) });
});

service.register('lanStop', function (message) {
  lanStop();
  message.respond({ returnValue: true });
});

/* YouTube host page over http://127.0.0.1 (YouTube refuses embeds from file:// with error 153).
   Only yt.html is served, and only to this TV (bound to the loopback address). */
var yt = null;
var fs = require('fs');
var path = require('path');

function ytListen(port, cb) {
  var srv = http.createServer(function (req, res) {
    if (urlLib.parse(req.url).pathname !== '/yt.html') { res.writeHead(404); res.end(); return; }
    fs.readFile(path.join(__dirname, 'yt.html'), function (err, data) {
      if (err) { res.writeHead(500); res.end(); return; }
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end(data);
    });
  });
  srv.once('error', function (e) {
    if (port < 8909) ytListen(port + 1, cb); else cb(e);
  });
  srv.listen(port, '127.0.0.1', function () { cb(null, srv, port); });
}

service.register('ytServe', function (message) {
  if (yt) return message.respond({ returnValue: true, port: yt.port });
  ytListen(8900, function (err, srv, port) {
    if (err) return message.respond({ returnValue: false, errorText: String(err.message || err) });
    yt = { server: srv, port: port };
    srv.on('close', function () { yt = null; });
    message.respond({ returnValue: true, port: port });
  });
});

service.register('ping', function (message) {
  message.respond({ returnValue: true, version: pkgInfo.version });
});
