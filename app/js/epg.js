/*
 * EPG.
 *  - XMLTV: on the TV the Node service streams the file (it can be hundreds of MB),
 *    keeping only our channels and the needed days. Every channel is stored as its
 *    own IndexedDB record and read lazily for the rows on screen, so memory stays small.
 *    Without the service (desktop preview) the file is parsed here the same way.
 *  - Xtream without XMLTV: per-channel API on demand.
 */
(function () {
  'use strict';

  var progs = {};        // channel key -> [{s,e,t,d}] for recently used channels
  var progGen = {};      // channel key -> XMLTV generation the list came from
  var touched = {}, tick = 0, held = 0;
  var reading = {};      // channel key -> pending IndexedDB read
  var lazyLoaded = {};   // channel key -> true (Xtream API fetched)
  var listeners = [];
  var queue = new U.Queue(4);
  var xt = null;         // Xtream client when the active playlist is Xtream
  var useApi = false;
  var src = null;        // active XMLTV cache { plId, gen }
  var loadSeq = 0;
  var emitTimer = null;
  var status = { state: 'none' };   // none | api | ready | loading | error  (+ pct, bytes, time, n)
  var statusListeners = [];
  var last = null;       // the active playlist's XMLTV sources, for the background refresh { plId, urls, channels, at }
  var apiAt = 0;         // when the Xtream per-channel guide was last cleared
  var MAX_HELD = 300;
  var RETRY = 15 * 60000;   // a failed or out-of-date guide is tried again at most this often
  var BATCH = 256 * 1024;

  function noop() {}

  function setStatus(st) {
    status = st;
    statusListeners.forEach(function (f) { try { f(st); } catch (e) { console.error(e); } });
  }

  /* download progress of source number ctx.idx (0-based) of ctx.urls */
  function progress(ctx, bytes, total, frac) {
    if (ctx.seq !== loadSeq) return;
    var part = frac != null ? frac : (total ? Math.min(1, bytes / total) : 0);
    var st = {
      state: 'loading', pct: Math.floor((ctx.idx + part) / ctx.urls * 100),
      bytes: (ctx.doneBytes || 0) + (bytes || 0), time: ctx.prevTime, n: ctx.prevN
    };
    if (status.state === 'loading' && status.pct === st.pct && Math.abs((status.bytes || 0) - st.bytes) < 2e6) return;
    setStatus(st);
  }

  function emit() {
    clearTimeout(emitTimer);
    emitTimer = setTimeout(function () {
      listeners.forEach(function (f) { try { f(); } catch (e) { console.error(e); } });
    }, 50);
  }

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

  function parseTime(s) {
    var m = /^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})?\s*([+-]\d{2})?(\d{2})?/.exec(s || '');
    if (!m) return 0;
    var t = Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +(m[6] || 0));
    if (m[7]) {
      var sign = m[7].charAt(0) === '-' ? -1 : 1;
      var off = (Math.abs(parseInt(m[7], 10)) * 60 + parseInt(m[8] || '0', 10)) * 60000 * sign;
      t -= off;
    }
    return t;
  }

  function attr(str, name) {
    var m = new RegExp('\\b' + name + '\\s*=\\s*"([^"]*)"').exec(str);
    return m ? m[1] : '';
  }

  /* ---------- channel matching ---------- */

  function buildIndex(channels) {
    var byId = {}, byName = {};
    channels.forEach(function (c) {
      if (c.tvgId) (byId[c.tvgId.toLowerCase()] = byId[c.tvgId.toLowerCase()] || []).push(c.key);
      [c.tvgName, c.orig ? c.orig.name : c.name, c.name].forEach(function (n) {
        var k = U.normName(n);
        if (k && (!byName[k] || byName[k].indexOf(c.key) < 0)) (byName[k] = byName[k] || []).push(c.key);
      });
    });
    return { byId: byId, byName: byName };
  }

  /* XMLTV channel list [[id, displayName…]] -> { lowercase xmltv id: [our channel keys] } */
  function matchChannels(list, channels) {
    var idx = buildIndex(channels);
    var map = {};
    Object.keys(idx.byId).forEach(function (id) { map[id] = idx.byId[id]; });
    list.forEach(function (row) {
      var lid = String(row[0] || '').toLowerCase();
      if (!lid || idx.byId[lid]) return;
      var keys = null;
      for (var i = 1; i < row.length && !keys; i++) keys = idx.byName[U.normName(row[i])] || null;
      if (!keys) keys = idx.byName[U.normName(row[0])] || null;
      if (keys) map[lid] = keys;
    });
    return map;
  }

  /* days of programmes to keep: deepest archive in the playlist, plus a few days ahead */
  function windowFor(channels) {
    var days = 1;
    channels.forEach(function (c) { if (c.catchup && c.catchup.days > days) days = c.catchup.days; });
    days = Math.min(days, 14);
    var now = Date.now() / 1000;
    return { from: Math.floor(now - (days + 0.5) * 86400), to: Math.floor(now + 3.5 * 86400) };
  }

  /* ---------- IndexedDB storage, one record per channel ---------- */

  function genPrefix(plId, gen) { return 'epgc:' + plId + ':' + gen + ':'; }

  function tidy(l) {
    l.sort(function (a, b) { return a[0] - b[0]; });
    for (var i = l.length - 1; i > 0; i--) if (l[i][0] === l[i - 1][0]) l.splice(i, 1);
    return l;
  }

  function Sink(plId, gen) {
    this.prefix = genPrefix(plId, gen);
    this.written = {};
    this.owner = {};     // channel key -> index of the source that filled it (first source wins)
    this.count = 0;
    this.src = 0;        // current source index
    this.shift = 0;      // current source time correction, seconds
    this.end = 0;        // end of the last programme stored, seconds
  }
  /* data: { xmltvId: [[startSec, stopSec, title, desc], …] } */
  Sink.prototype.add = function (data, map) {
    var self = this, byKey = {}, sh = this.shift;
    Object.keys(data).forEach(function (id) {
      var keys = map[id.toLowerCase()];
      if (!keys) return;
      keys = keys.filter(function (k) { return !(k in self.owner) || self.owner[k] === self.src; });
      if (!keys.length) return;
      var l = data[id];
      if (sh) l = l.map(function (r) { return [r[0] + sh, r[1] + sh, r[2], r[3]]; });
      self.count += l.length;
      for (var i = 0; i < l.length; i++) if (l[i][1] > self.end) self.end = l[i][1];
      keys.forEach(function (k) { self.owner[k] = self.src; byKey[k] = byKey[k] ? byKey[k].concat(l) : l.slice(); });
    });
    var keys = Object.keys(byKey);
    if (!keys.length) return Promise.resolve();
    // a channel split over two batches (or found in two sources): merge with what is stored
    var again = keys.filter(function (k) { return self.written[k]; });
    return Promise.all(again.map(function (k) {
      return Cache.get(self.prefix + k).then(function (old) { if (old) byKey[k] = old.concat(byKey[k]); });
    })).then(function () {
      return Cache.setMany(keys.map(function (k) {
        self.written[k] = true;
        return [self.prefix + k, tidy(byKey[k])];
      }));
    });
  };

  /* ---------- sources ---------- */

  function cancelled() { var e = new Error('cancelled'); e.cancelled = true; return e; }

  function viaService(url, channels, ctx) {
    return Net.luna('epgOpen', { url: url }).then(function (o) {
      progress(ctx, o.bytes, o.total);
      var map = matchChannels(o.channels || [], channels);
      var want = Object.keys(map);
      if (!want.length || o.done) { Net.luna('release', { id: o.id })['catch'](noop); return; }
      var first = true;
      function step() {
        if (ctx.seq !== loadSeq) { Net.luna('release', { id: o.id })['catch'](noop); throw cancelled(); }
        var p = first ? { id: o.id, want: want, from: ctx.win.from, to: ctx.win.to, max: BATCH } : { id: o.id };
        first = false;
        return Net.luna('epgNext', p).then(function (r) {
          progress(ctx, r.bytes, r.total);
          if (r.done) ctx.doneBytes = (ctx.doneBytes || 0) + (r.bytes || 0);
          return ctx.sink.add(r.data || {}, map).then(function () { return r.done ? null : step(); });
        });
      }
      return step();
    });
  }

  function inApp(url, channels, ctx) {
    return Net.text(url).then(function (text) {
      var list = [], m, d;
      var reCh = /<channel\b([^>]*)>([\s\S]*?)<\/channel>/g;
      var reDn = /<display-name[^>]*>([\s\S]*?)<\/display-name>/g;
      while ((m = reCh.exec(text))) {
        var row = [decode(attr(m[1], 'id'))];
        reDn.lastIndex = 0;
        while ((d = reDn.exec(m[2])) && row.length < 4) row.push(decode(d[1]));
        list.push(row);
      }
      var map = matchChannels(list, channels);
      var reP = /<programme\b([^>]*)>([\s\S]*?)<\/programme>/g;
      var reT = /<title[^>]*>([\s\S]*?)<\/title>/;
      var reD = /<desc[^>]*>([\s\S]*?)<\/desc>/;
      var data = {}, n = 0;
      return new Promise(function (resolve, reject) {
        function step() {
          if (ctx.seq !== loadSeq) return reject(cancelled());
          var t0 = Date.now();
          progress(ctx, 0, 0, reP.lastIndex / text.length);
          while ((m = reP.exec(text))) {
            var a = m[1];
            var cid = decode(attr(a, 'channel'));
            if (!map[cid.toLowerCase()]) continue;
            var s = Math.floor(parseTime(attr(a, 'start')) / 1000);
            var e = Math.floor(parseTime(attr(a, 'stop')) / 1000) || s + 1800;
            if (!s || e <= ctx.win.from || s >= ctx.win.to) continue;
            var tm = reT.exec(m[2]), dm = reD.exec(m[2]);
            (data[cid] = data[cid] || []).push([s, e, tm ? decode(tm[1]) : '', dm ? decode(dm[1]) : '']);
            if (++n % 20000 === 0) {
              var full = data; data = {};
              return ctx.sink.add(full, map).then(step, reject);
            }
            if (Date.now() - t0 > 40) return setTimeout(step, 0); // keep the UI responsive
          }
          ctx.sink.add(data, map).then(resolve, reject);
        }
        step();
      });
    });
  }

  function fetchSource(url, channels, ctx) {
    if (!window.PalmServiceBridge) return inApp(url, channels, ctx);
    return viaService(url, channels, ctx)['catch'](function (e) {
      // the helper service itself is missing / not allowed: small guides still work in the app
      if (!e.cancelled && /service|bridge|denied|method/i.test(e.message || '') && !/\.gz($|\?)/i.test(url)) {
        return inApp(url, channels, ctx);
      }
      throw e;
    });
  }

  /* ---------- in-memory cache of recently shown channels ---------- */

  function touch(key) { touched[key] = ++tick; }

  function trim() {
    if (held <= MAX_HELD) return;
    var keys = Object.keys(progs).sort(function (a, b) { return (touched[a] || 0) - (touched[b] || 0); });
    keys.slice(0, held - MAX_HELD + 50).forEach(function (k) { delete progs[k]; delete progGen[k]; });
    held = Object.keys(progs).length;
  }

  function put(key, list, gen) {
    if (!(key in progs)) held++;
    progs[key] = list;
    progGen[key] = gen;
    touch(key);
    trim();
  }

  function toObjs(rows) {
    var shift = (Store.get('epgShift') || 0) * 3600000;
    return rows.map(function (r) { return { s: r[0] * 1000 + shift, e: r[1] * 1000 + shift, t: r[2], d: r[3] }; });
  }

  function readChannel(key) {
    var cur = src, gen = cur.gen;
    touch(key);
    if (progGen[key] === gen) return Promise.resolve(progs[key]);
    if (reading[key]) return reading[key];
    var p = reading[key] = Cache.get(genPrefix(cur.plId, gen) + key).then(function (rows) {
      delete reading[key];
      if (src !== cur) return progs[key] || null;
      var had = progs[key] && progs[key].length;
      put(key, rows ? toObjs(rows) : [], gen);
      if (rows || had) emit();
      return progs[key];
    });
    return p;
  }

  /* "guide from another channel" (channel editor) */
  function alias(ch) {
    return ch && ch.epgFrom && window.Data ? Data.channel(ch.epgFrom) || ch : ch;
  }

  function activate(plId, gen) {
    if (src && src.plId === plId && src.gen === gen) return;   // the same guide (background check)
    src = { plId: plId, gen: gen };
    useApi = false;
    emit();
  }

  var Epg = {
    onUpdate: function (f) { listeners.push(f); },
    onStatus: function (f) { statusListeners.push(f); },
    status: function () { return status; },

    reset: function (xtream) {
      progs = {}; progGen = {}; touched = {}; held = 0; reading = {};
      lazyLoaded = {};
      queue.clear();
      loadSeq++;
      src = null;
      xt = xtream || null;
      useApi = !!xt;
      last = null;
      apiAt = Date.now();
      setStatus({ state: xt ? 'api' : 'none' });
      emit();
    },

    /* load XMLTV sources; cached per channel in IndexedDB and refreshed in the background */
    loadXmltv: function (plId, urls, channels, force, quiet) {
      var seq = ++loadSeq;
      last = { plId: plId, urls: urls, channels: channels, at: Date.now() };
      var metaKey = 'epg:' + plId;
      // [{url, shift(hours)}] or plain urls; earlier sources win for a channel
      urls = urls.map(function (u) { return typeof u === 'string' ? { url: u, shift: 0 } : u; });
      var sig = urls.map(function (u) { return u.url + (u.shift ? '@' + u.shift : ''); }).join('|');
      var maxAge = Math.max(6, Store.get('updateHours') || 12) * 3600000;
      return Cache.get(metaKey).then(function (meta) {
        if (seq !== loadSeq) return false;
        var usable = !!(meta && meta.v === 2 && meta.urls === sig && meta.gen);
        if (usable) {
          activate(plId, meta.gen);
          setStatus({ state: 'ready', time: meta.time, n: meta.n });
        } else if (meta) {
          Cache.remove(metaKey);
          if (meta.gen) Cache.removePrefix(genPrefix(plId, meta.gen));
        }
        var age = usable ? Date.now() - meta.time : 0;
        // the guide also runs out when the app stays open for days (a TV is rarely restarted):
        // with less than 12 h of programmes left it is downloaded again (at most every 3 h)
        var runningOut = usable && meta.end && meta.end * 1000 - Date.now() < 12 * 3600000 && age > 3 * 3600000;
        if (usable && !force && age < maxAge && !runningOut) return true;

        var gen = Date.now().toString(36);
        var ctx = {
          seq: seq, win: windowFor(channels), sink: new Sink(plId, gen), failed: false, error: '',
          idx: 0, urls: urls.length, prevTime: usable ? meta.time : 0, prevN: usable ? meta.n : 0
        };
        if (!usable && !quiet) U.toast(I18n.t('loading_epg'));
        progress(ctx, 0, 0);
        var p = Promise.resolve();
        urls.forEach(function (u, i) {
          p = p.then(function () {
            ctx.idx = i;
            ctx.sink.src = i;
            ctx.sink.shift = Math.round((u.shift || 0) * 3600);
            return fetchSource(u.url, channels, ctx)['catch'](function (e) {
              if (e.cancelled) throw e;
              ctx.failed = true;
              ctx.error = e && e.message ? e.message : String(e);
              console.warn('EPG failed', u, e);
            });
          });
        });
        return p.then(function () {
          if (seq !== loadSeq) { Cache.removePrefix(genPrefix(plId, gen)); return false; }
          // keep the previous guide when the new download failed half-way
          if (!ctx.sink.count || (ctx.failed && usable)) {
            Cache.removePrefix(genPrefix(plId, gen));
            if (usable) setStatus({ state: 'ready', time: meta.time, n: meta.n, err: ctx.error || I18n.t('no_epg') });
            else {
              setStatus({ state: 'error', err: ctx.error || I18n.t('no_epg') });
              if (!quiet) U.toast(I18n.t('epg_failed') + (ctx.error ? ': ' + ctx.error : ''), 6000);
            }
            return usable;
          }
          var time = Date.now();
          return Cache.set(metaKey, { v: 2, time: time, urls: sig, gen: gen, n: ctx.sink.count, end: ctx.sink.end }).then(function () {
            if (seq !== loadSeq) return false;
            activate(plId, gen);
            setStatus({ state: 'ready', time: time, n: ctx.sink.count, err: ctx.failed ? ctx.error : '' });
            if (usable) Cache.removePrefix(genPrefix(plId, meta.gen));
            else if (!quiet) U.toast(I18n.t('epg_ready'));
            return true;
          });
        }, function () {
          Cache.removePrefix(genPrefix(plId, gen));
          return usable;
        });
      });
    },

    /* background refresh (a timer, the app coming back to the screen, the network coming back): the guide
       was only loaded at start-up before, and a TV keeps the app open for days, so the programmes ran out */
    check: function () {
      var now = Date.now();
      if (useApi && !last && now - apiAt > 6 * 3600000) {
        // Xtream per-channel guide: fetched again when a channel is next shown
        apiAt = now;
        progs = {}; progGen = {}; touched = {}; held = 0; lazyLoaded = {};
        emit();
        return;
      }
      if (!last || status.state === 'loading' || now - last.at < RETRY) return;
      var l = last;
      Epg.loadXmltv(l.plId, l.urls, l.channels, false, true)['catch'](function (e) { console.warn(e); });
    },

    /* make sure the channel's programmes are in memory (XMLTV cache or Xtream API) */
    ensure: function (ch) {
      ch = alias(ch);
      if (!ch || ch.kind !== 'live') return Promise.resolve(null);
      if (src) return readChannel(ch.key);
      if (!useApi || !xt || !ch.streamId || lazyLoaded[ch.key]) return Promise.resolve(progs[ch.key] || null);
      lazyLoaded[ch.key] = true;
      var shift = (Store.get('epgShift') || 0) * 3600000;
      return queue.push(function () {
        return xt.epgTable(ch.streamId).then(function (r) {
          var list = (r && r.epg_listings) || [];
          var out = list.map(function (x) {
            return {
              s: parseInt(x.start_timestamp, 10) * 1000 + shift,
              e: parseInt(x.stop_timestamp, 10) * 1000 + shift,
              t: U.b64(x.title), d: U.b64(x.description),
              a: String(x.has_archive) === '1'
            };
          }).filter(function (x) { return x.s && x.e; });
          out.sort(function (a, b) { return a.s - b.s; });
          put(ch.key, out, null);
          emit();
          return out;
        })['catch'](function () { return null; });
      }, true);
    },

    get: function (ch) {
      ch = alias(ch);
      if (!ch) return null;
      if (src && progGen[ch.key] !== src.gen && ch.kind === 'live') readChannel(ch.key);
      else if (progs[ch.key]) touch(ch.key);
      return progs[ch.key] || null;
    },

    /* index of the programme playing at time t */
    indexAt: function (list, t) {
      if (!list || !list.length) return -1;
      var lo = 0, hi = list.length - 1;
      while (lo <= hi) {
        var mid = (lo + hi) >> 1;
        if (list[mid].e <= t) lo = mid + 1;
        else if (list[mid].s > t) hi = mid - 1;
        else return mid;
      }
      return -1;
    },

    nowNext: function (ch) {
      var l = Epg.get(ch);
      if (!l) return { cur: null, next: null };
      var t = Date.now();
      var i = Epg.indexAt(l, t);
      if (i < 0) {
        for (var j = 0; j < l.length; j++) if (l[j].s > t) return { cur: null, next: l[j] };
        return { cur: null, next: null };
      }
      return { cur: l[i], next: l[i + 1] || null };
    },

    /* programmes whose title contains q: resolves [{ch, p}] — on air and upcoming first, then the archive */
    search: function (q, limit) {
      q = String(q || '').toLowerCase().trim();
      limit = limit || 200;
      var out = [], seen = {}, now = Date.now();
      if (q.length < 2) return Promise.resolve(out);
      function hit(key, list) {
        var ch = Data.channel(key);
        if (!ch || ch.hidden) return;
        list.forEach(function (p) {
          if (p.e < now - 14 * 86400000 || (p.t || '').toLowerCase().indexOf(q) < 0) return;
          var id = key + p.s;
          if (!seen[id]) { seen[id] = 1; out.push({ ch: ch, p: p }); }
        });
      }
      var done;
      if (src) {
        var pre = genPrefix(src.plId, src.gen);
        done = Cache.scan(pre, function (k, rows) {
          if (!rows || !rows.length) return;
          var key = k.slice(pre.length), any = false;
          for (var i = 0; i < rows.length && !any; i++) any = (rows[i][2] || '').toLowerCase().indexOf(q) >= 0;
          if (any) hit(key, toObjs(rows));
          return out.length < limit * 3;
        });
      } else {
        Object.keys(progs).forEach(function (k) { hit(k, progs[k] || []); });
        done = Promise.resolve();
      }
      return done.then(function () {
        function rank(x) { return x.p.e <= now ? 1 : 0; }
        out.sort(function (a, b) {
          var ra = rank(a), rb = rank(b);
          if (ra !== rb) return ra - rb;
          return ra ? b.p.s - a.p.s : a.p.s - b.p.s;
        });
        return out.slice(0, limit);
      });
    },

    hasData: function () { return !!src || held > 0 || useApi; }
  };

  window.Epg = Epg;
})();
