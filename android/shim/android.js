/* Ekrani IPTV on Android: gives the webOS web app what the TV gives it, from the Android app (window.EkraniNative).
   Loaded before js/boot.js (tools/build-android.js puts it into index.html). It is part of the APK, not of the
   over-the-air updates, so the app's own code only feature-checks (window.EkraniAndroid).
   - PalmServiceBridge: the luna calls go to the Kotlin service (same methods as service/index.js)
   - NativeVideo: document.getElementById('video') returns an object that acts like the <video> element and
     drives ExoPlayer; the picture is under the page, which is transparent where the video layer is
   - remote keys that the WebView does not pass on (Back, colours, channel ±…) arrive as webOS key codes
   - visibility (app to the background and back), exit */
(function () {
  'use strict';
  var N = window.EkraniNative;
  if (!N) return;
  document.documentElement.className += ' android';

  /* ---------- luna bus ---------- */
  var seq = 0, pend = {};
  function PalmServiceBridge() { this.onservicecallback = null; }
  PalmServiceBridge.prototype.call = function (uri, params) {
    var id = ++seq;
    pend[id] = this;
    N.call(id, String(uri), params == null ? '{}' : String(params));
    return true;
  };
  PalmServiceBridge.prototype.cancel = function () {};
  window.PalmServiceBridge = PalmServiceBridge;
  window.__ekReply = function (id) {
    var b = pend[id];
    delete pend[id];
    var msg = N.result(id);
    if (b && typeof b.onservicecallback === 'function') b.onservicecallback(msg);
  };

  /* ---------- keys ---------- */
  window.__ekKey = function (code, type, repeat) {
    var ev = document.createEvent('Event');
    ev.initEvent(type, true, true);
    try {
      Object.defineProperty(ev, 'keyCode', { value: code });
      Object.defineProperty(ev, 'which', { value: code });
      Object.defineProperty(ev, 'repeat', { value: !!repeat });
      Object.defineProperty(ev, 'key', { value: '' });
    } catch (e) { /* ignore */ }
    (document.activeElement || document.body || document).dispatchEvent(ev);
  };

  /* ---------- visibility: Home button, another app ---------- */
  var hidden = false;
  try {
    Object.defineProperty(document, 'hidden', { configurable: true, get: function () { return hidden; } });
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: function () { return hidden ? 'hidden' : 'visible'; } });
  } catch (e) { /* ignore */ }
  // only the activity's own signal reaches the app (the WebView's would come a second time)
  document.addEventListener('visibilitychange', function (e) { if (!e.__ek) e.stopImmediatePropagation(); }, true);
  window.__ekVis = function (h) {
    if (h === hidden) return;
    hidden = h;
    var ev = document.createEvent('Event');
    ev.initEvent('visibilitychange', true, false);
    ev.__ek = true;
    document.dispatchEvent(ev);
  };

  window.close = function () { N.exit(); };

  /* ---------- app updates (APK) ---------- */
  window.EkraniAndroid = {
    code: N.versionCode(),
    name: N.versionName(),
    tv: N.isTv(),
    installApk: function (url) { N.installApk(url); }
  };
  window.__ekApk = function (o) {
    var ev = document.createEvent('Event');
    ev.initEvent('ekapk', false, false);
    ev.detail = o;
    window.dispatchEvent(ev);
  };

  /* ---------- video ---------- */
  var gen = 0;
  function send(o) { o.g = gen; N.video(JSON.stringify(o)); }
  function blank() { return { t: 0, d: -2, p: true, rs: 0, vh: 0, vw: 0, ss: 0, se: 0, at: [], tt: [] }; }

  function NativeVideo() {
    var self = this;
    this._l = {};
    this._s = blank();
    this._at = Date.now();
    this._src = '';
    this._fresh = false;
    this._fit = 'contain';
    this._cmdAt = 0;
    this.error = null;
    this.audioTracks = [];
    this.textTracks = [];
    this.style = {};
    Object.defineProperty(this.style, 'objectFit', {
      get: function () { return self._fit; },
      set: function (v) { self._fit = v; send({ op: 'fit', v: v }); }
    });
  }
  var V = NativeVideo.prototype;
  V.addEventListener = function (t, f) { (this._l[t] = this._l[t] || []).push(f); };
  V.removeEventListener = function (t, f) {
    var a = this._l[t], i = a ? a.indexOf(f) : -1;
    if (i >= 0) a.splice(i, 1);
  };
  V._fire = function (t) {
    var a = (this._l[t] || []).slice(), ev = { type: t, target: this, currentTarget: this };
    for (var i = 0; i < a.length; i++) {
      try { a[i].call(this, ev); } catch (e) { setTimeout(function () { throw e; }); }
    }
  };
  V._open = function (u) {
    gen++;
    this._src = u;
    this._s = blank();
    this._at = Date.now();
    this.error = null;
    this.audioTracks = [];
    this.textTracks = [];
    if (u) {
      send({ op: 'open', url: u });
      // src = … followed by load() (what the player does) opens it only once
      var self = this;
      this._fresh = true;
      setTimeout(function () { self._fresh = false; }, 0);
    } else send({ op: 'stop' });
  };
  V.load = function () {
    if (this._fresh) { this._fresh = false; return; }
    this._open(this._src);
  };
  V.play = function () {
    this._cmdAt = Date.now();
    this._s.p = false;
    this._at = Date.now();
    send({ op: 'play' });
    return Promise.resolve();
  };
  V.pause = function () {
    this._cmdAt = Date.now();
    this._s.p = true;
    send({ op: 'pause' });
  };
  V.getAttribute = function (n) { return n === 'src' ? (this._src || null) : null; };
  V.setAttribute = function (n, v) { if (n === 'src') this.src = v; };
  V.removeAttribute = function (n) {
    if (n !== 'src' || !this._src) return;
    this._src = '';
    this._fresh = false;
    this._open('');
  };
  V.canPlayType = function () { return 'maybe'; };

  function num(v) { return v === -1 ? Infinity : v === -2 ? NaN : v; }
  Object.defineProperties(V, {
    src: { get: function () { return this._src; }, set: function (v) { this._open(String(v || '')); } },
    currentTime: {
      get: function () {
        var s = this._s, t = s.t;
        if (!s.p && s.rs >= 4 && !s.ended) t += Math.min(1, (Date.now() - this._at) / 1000);
        return t;
      },
      set: function (v) {
        v = +v || 0;
        this._s.t = v;
        this._at = Date.now();
        send({ op: 'seek', t: v });
      }
    },
    paused: { get: function () { return this._s.p; } },
    ended: { get: function () { return !!this._s.ended; } },
    duration: { get: function () { return num(this._s.d); } },
    readyState: { get: function () { return this._s.rs; } },
    videoHeight: { get: function () { return this._s.vh; } },
    videoWidth: { get: function () { return this._s.vw; } },
    seekable: {
      get: function () {
        var s = this._s;
        return { length: s.rs > 0 ? 1 : 0, start: function () { return s.ss; }, end: function () { return s.se; } };
      }
    }
  });

  V._tracks = function () {
    var self = this, st = this._s;
    this.audioTracks = (st.at || []).map(function (a, i) {
      var on = !!a[2], o = { id: String(i), kind: 'main', label: a[0], language: a[1] };
      Object.defineProperty(o, 'enabled', {
        get: function () { return on; },
        set: function (x) { x = !!x; if (x && !on) send({ op: 'audio', i: i }); on = x; }
      });
      return o;
    });
    this.textTracks = (st.tt || []).map(function (a, i) {
      var mode = a[2] ? 'showing' : 'disabled', o = { id: String(i), kind: 'subtitles', label: a[0], language: a[1] };
      Object.defineProperty(o, 'mode', {
        get: function () { return mode; },
        set: function (m) {
          mode = m;
          clearTimeout(self._ttTimer);
          self._ttTimer = setTimeout(function () {
            var sel = -1;
            for (var j = 0; j < self.textTracks.length; j++) if (self.textTracks[j].mode === 'showing') sel = j;
            send({ op: 'text', i: sel });
          }, 0);
        }
      });
      return o;
    });
  };

  var video = null;
  window.__ekVideo = function (ev, st) {
    if (!video || st.g !== gen) return;    // about an earlier source
    // play()/pause() sent just now win over a state that was already on its way
    if (Date.now() - video._cmdAt < 500) st.p = video._s.p;
    video._s = st;
    video._at = Date.now();
    if (ev === 'error') video.error = { code: st.err || 4, message: st.errMsg || '' };
    if (ev === 'tracks' || ev === 'loadedmetadata' || !video.audioTracks.length) video._tracks();
    if (ev !== 'tracks') video._fire(ev);
  };

  var realGet = document.getElementById;
  document.getElementById = function (id) {
    if (id === 'video') return video || (video = new NativeVideo());
    return realGet.call(document, id);
  };

  /* the video picture is under the page: the page gets a hole where the video layer is */
  var layer = null, hole = null, lastPlace = '';
  function place() {
    if (!layer) return;
    var m = layer.classList.contains('hidden') ? 'hidden' : layer.classList.contains('full') ? 'full' : 'preview';
    var r = layer.getBoundingClientRect(), k = window.devicePixelRatio || 1;
    var o = { op: 'place', mode: m, x: Math.round(r.left * k), y: Math.round(r.top * k), w: Math.round(r.width * k), h: Math.round(r.height * k) };
    var key = JSON.stringify(o);
    if (key === lastPlace) return;
    lastPlace = key;
    send(o);
    document.documentElement.classList.toggle('ek-preview', m === 'preview');
    if (m === 'preview') {
      hole.style.left = r.left + 'px'; hole.style.top = r.top + 'px';
      hole.style.width = r.width + 'px'; hole.style.height = r.height + 'px';
    } else {
      hole.style.left = hole.style.top = '-10px';
      hole.style.width = hole.style.height = '0';
    }
  }
  var placeTimer = null;
  function placeSoon() { if (!placeTimer) placeTimer = setTimeout(function () { placeTimer = null; place(); }, 0); }

  document.addEventListener('DOMContentLoaded', function () {
    hole = document.createElement('div');
    hole.id = 'ekHole';
    document.body.insertBefore(hole, document.body.firstChild);
    layer = realGet.call(document, 'videoLayer');
    if (!layer) return;
    new MutationObserver(placeSoon).observe(layer, { attributes: true, attributeFilter: ['class', 'style'] });
    window.addEventListener('resize', placeSoon);
    place();
  });
})();
