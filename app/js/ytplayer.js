/* YouTube player for catalog items with a "youtube" id (official channels such as Mosfilm).
   On the TV the app runs from file://, and YouTube refuses embeds without a Referer (error 153).
   So the player lives in yt.html, served over http://127.0.0.1 by the app's service (in the
   browser the dev server serves it). The app drives it with postMessage. If YouTube still refuses,
   the video goes to the TV's own YouTube app. */
(function () {
  'use strict';

  var K = U.KEY;
  var S = { ENDED: 0, PLAYING: 1, PAUSED: 2, BUFFERING: 3 };
  var YT_APP = 'youtube.leanback.v4';
  var SAVE_MS = 15000, HUD_MS = 4000, START_MS = 25000;

  var layer = null, yt = null, cur = null;
  var saveTimer = null, hudTimer = null, startTimer = null, tickTimer = null;
  var bridges = [];

  /* where yt.html is served */
  function hostBase() {
    if (window.PalmServiceBridge) {
      return Net.luna('ytServe', {}).then(function (r) { return 'http://127.0.0.1:' + r.port; });
    }
    if (/^https?:$/.test(location.protocol)) return Promise.resolve(location.origin);
    return Promise.reject(new Error('no YouTube host'));
  }

  /* the yt.html iframe, with the YT.Player methods this file uses */
  function Host(base, id, start, h) {
    var self = this;
    this.t = 0; this.d = 0; this.s = -1;
    var f = this.frame = document.createElement('iframe');
    f.setAttribute('allow', 'autoplay; encrypted-media');
    f.setAttribute('tabindex', '-1');
    f.setAttribute('frameborder', '0');
    f.src = base + '/yt.html?v=' + encodeURIComponent(id) + '&start=' + Math.floor(start || 0) + '&h=' + (+Store.get('ytQuality') || 0);
    this.onMsg = function (e) {
      if (e.source !== f.contentWindow) return;
      var m;
      try { m = JSON.parse(e.data); } catch (x) { return; }
      if (m.t != null) self.t = m.t;
      if (m.d) self.d = m.d;
      if (m.q) self.q = m.q;
      if (m.ev === 'time') self.s = m.s;
      else if (m.ev === 'state') { self.s = m.data; h.onState({ data: m.data }); }
      else if (m.ev === 'error') h.onError({ data: m.data });
      else if (m.ev === 'ready') h.onReady();
    };
    window.addEventListener('message', this.onMsg);
    document.getElementById('yt-frame').appendChild(f);
  }
  Host.prototype.cmd = function (c, t) {
    try { this.frame.contentWindow.postMessage(JSON.stringify({ cmd: c, t: t }), '*'); } catch (e) { /* ignore */ }
  };
  Host.prototype.getCurrentTime = function () { return this.t; };
  Host.prototype.getDuration = function () { return this.d; };
  Host.prototype.getPlayerState = function () { return this.s; };
  Host.prototype.getPlaybackQuality = function () { return this.q || ''; };
  Host.prototype.playVideo = function () { this.cmd('play'); };
  Host.prototype.pauseVideo = function () { this.cmd('pause'); };
  Host.prototype.seekTo = function (t) { this.t = t; this.cmd('seek', t); };
  Host.prototype.destroy = function () {
    window.removeEventListener('message', this.onMsg);
    if (this.frame.parentNode) this.frame.parentNode.removeChild(this.frame);
  };

  /* hand the video to the TV's YouTube app */
  function openApp(id, start) {
    if (!window.PalmServiceBridge) return false;
    var b = new window.PalmServiceBridge();
    bridges.push(b);
    b.onservicecallback = function (msg) {
      bridges.splice(bridges.indexOf(b), 1);
      var r = {};
      try { r = JSON.parse(msg); } catch (e) { /* ignore */ }
      if (r.returnValue === false) U.toast(I18n.t('yt_app_fail') + (r.errorText ? ': ' + r.errorText : ''), 5000);
    };
    var target = 'v=' + id + (start > 0 ? '&t=' + Math.floor(start) + 's' : '');
    b.call('luna://com.webos.applicationManager/launch', JSON.stringify({ id: YT_APP, params: { contentTarget: target } }));
    return true;
  }

  function el(tag, cls, parent) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (parent) parent.appendChild(e);
    return e;
  }

  function build() {
    layer = el('div', 'yt-layer', document.body);
    el('div', '', layer).id = 'yt-frame';
    var spin = el('div', 'spinner', layer);
    var hud = el('div', 'yt-hud', layer);
    var title = el('div', 'yt-title', hud);
    var bar = el('div', 'yt-bar', hud);
    var fill = el('div', 'yt-fill', bar);
    var row = el('div', 'yt-row', hud);
    var time = el('span', 'yt-time', row);
    var hint = el('span', 'yt-hint', row);
    var msg = el('div', 'video-msg', layer);
    layer._ = { spin: spin, hud: hud, title: title, fill: fill, time: time, hint: hint, msg: msg };
  }

  function t() { try { return yt && yt.getCurrentTime ? yt.getCurrentTime() || 0 : 0; } catch (e) { return 0; } }
  function d() { try { return yt && yt.getDuration ? yt.getDuration() || 0 : 0; } catch (e) { return 0; } }
  function state() { try { return yt && yt.getPlayerState ? yt.getPlayerState() : -1; } catch (e) { return -1; } }

  var QUAL = { highres: '8K', hd2880: '5K', hd2160: '4K', hd1440: '1440p', hd1080: '1080p', hd720: '720p', large: '480p', medium: '360p', small: '240p', tiny: '144p' };
  function quality() { try { var v = yt && yt.getPlaybackQuality ? yt.getPlaybackQuality() : ''; return QUAL[v] || ''; } catch (e) { return ''; } }

  function fmt(s) {
    s = Math.max(0, Math.floor(s));
    var h = Math.floor(s / 3600), m = Math.floor(s % 3600 / 60);
    return (h ? h + ':' + U.pad(m) : m) + ':' + U.pad(s % 60);
  }

  function paint() {
    if (!layer || !cur) return;
    var x = layer._, now = cur.seekTo != null ? cur.seekTo : t(), dur = d();
    x.title.textContent = cur.title;
    x.fill.style.width = dur > 0 ? Math.min(100, now / dur * 100) + '%' : '0';
    var ql = quality();
    x.time.textContent = fmt(now) + (dur > 0 ? ' / ' + fmt(dur) : '') + (ql ? '  •  ' + ql : '') + (state() === 2 ? '  ❚❚' : '');
    x.hint.textContent = I18n.t('yt_hint');
  }

  function showHud(stay) {
    if (!layer) return;
    paint();
    layer._.hud.classList.add('on');
    clearInterval(tickTimer);
    tickTimer = setInterval(paint, 1000);
    clearTimeout(hudTimer);
    if (!stay) hudTimer = setTimeout(hideHud, HUD_MS);
  }

  function hideHud() {
    if (!layer || state() === 2) return;
    layer._.hud.classList.remove('on');
    clearInterval(tickTimer);
  }

  function setMsg(s) { if (layer) layer._.msg.textContent = s || ''; }
  function busy(on) { if (layer) layer._.spin.style.display = on ? '' : 'none'; }

  function savePos() {
    if (!cur || !cur.started) return;
    var now = t(), dur = d();
    if (now > 0) Store.setPos(cur.posKey, now, dur, cur.meta);
  }

  function keepFocus() {
    var f = layer && layer.querySelector('iframe');
    if (f) { f.setAttribute('tabindex', '-1'); f.style.pointerEvents = 'none'; }
    if (document.activeElement && document.activeElement.tagName === 'IFRAME') document.activeElement.blur();
    try { window.focus(); } catch (e) { /* ignore */ }
  }

  /* the embed failed: offer the TV's YouTube app instead */
  function fallback(why) {
    if (!cur) return;
    var c = cur;
    savePos();
    if (!window.PalmServiceBridge) {
      setMsg(I18n.t('yt_fail') + ' (' + why + ')');
      busy(false);
      return;
    }
    close(true);
    Modal.confirm(I18n.t('yt_fail') + ' (' + why + ').\n' + I18n.t('yt_open_app') + '?').then(function (y) {
      if (y) openApp(c.id, c.startAt);
    });
  }

  function onState(e) {
    if (!cur) return;
    if (e.data === S.PLAYING) {
      cur.started = true;
      cur.seekTo = null;
      clearTimeout(startTimer);
      busy(false);
      setMsg('');
      keepFocus();
      showHud();
    } else if (e.data === S.BUFFERING) {
      busy(true);
    } else if (e.data === S.PAUSED) {
      busy(false);
      showHud(true);
    } else if (e.data === S.ENDED) {
      Store.setPos(cur.posKey, d(), d(), cur.meta);   // finished: drops it from "continue"
      var next = cur.onEnded;
      close(true);
      if (next) next();
    }
  }

  function onError(e) {
    var code = e && e.data;
    if (code === 2 || code === 100) { setMsg(I18n.t('yt_gone') + ' (' + code + ')'); busy(false); return; }
    fallback('YouTube ' + code);
  }

  function play(o) {
    if (cur) close(true);
    if (window.Player && Player.mode && Player.mode() !== 'hidden') Player.stop();
    cur = { id: o.id, title: o.title || '', posKey: o.posKey, meta: o.meta, startAt: o.startAt || 0, onEnded: o.onEnded, onClose: o.onClose, started: false, seekTo: null };
    if (!layer) build();
    layer.style.display = '';
    busy(true);
    setMsg('');
    showHud(true);
    var c = cur;
    hostBase().then(function (base) {
      if (cur !== c) return;
      var box = document.getElementById('yt-frame');
      if (!box) { box = el('div', ''); box.id = 'yt-frame'; layer.insertBefore(box, layer.firstChild); }
      yt = new Host(base, c.id, c.startAt, {
        onReady: function () { keepFocus(); },
        onState: onState,
        onError: onError
      });
      keepFocus();
      clearTimeout(startTimer);
      startTimer = setTimeout(function () { if (cur === c && !c.started) fallback(I18n.t('yt_timeout')); }, START_MS);
      clearInterval(saveTimer);
      saveTimer = setInterval(savePos, SAVE_MS);
    })['catch'](function (e) {
      if (cur === c) fallback(e.message);
    });
  }

  function close(quiet) {
    if (!cur) return;
    var c = cur;
    savePos();
    clearInterval(saveTimer); clearInterval(tickTimer);
    clearTimeout(hudTimer); clearTimeout(startTimer);
    cur = null;
    try { if (yt) yt.destroy(); } catch (e) { /* ignore */ }
    yt = null;
    if (layer) {
      layer.style.display = 'none';
      layer._.hud.classList.remove('on');
      var f = layer.querySelector('iframe');
      if (f) f.parentNode.removeChild(f);
    }
    if (c.onClose) c.onClose(quiet);
  }

  function seek(by) {
    if (!yt || !cur || !cur.started) return;
    var dur = d();
    var base = cur.seekTo != null ? cur.seekTo : t();
    var to = Math.max(0, base + by);
    if (dur > 0) to = Math.min(dur - 2, to);
    cur.seekTo = to;
    try { yt.seekTo(to, true); } catch (e) { /* ignore */ }
    showHud();
  }

  function toggle() {
    if (!yt) return;
    try { if (state() === 1) yt.pauseVideo(); else yt.playVideo(); } catch (e) { /* ignore */ }
    showHud();
  }

  function handleKey(k) {
    if (!cur) return false;
    switch (k) {
      case K.ENTER: case K.LONG_OK: case K.PLAYPAUSE: toggle(); return true;
      case K.PLAY: try { yt && yt.playVideo(); } catch (e) { /* ignore */ } showHud(); return true;
      case K.PAUSE: try { yt && yt.pauseVideo(); } catch (e) { /* ignore */ } showHud(true); return true;
      case K.LEFT: seek(-15); return true;
      case K.RIGHT: seek(15); return true;
      case K.RW: seek(-60); return true;
      case K.FF: seek(60); return true;
      case K.UP: case K.DOWN: showHud(); return true;
      case K.YELLOW: {
        var c = cur, at = t() || c.startAt;
        if (!window.PalmServiceBridge) { U.toast(I18n.t('yt_app_fail')); return true; }
        close(true);
        openApp(c.id, at);
        return true;
      }
      case K.BACK: case K.ESC: case K.STOP: close(false); return true;
    }
    return true;   // nothing else leaks to the screen underneath
  }

  /* app hidden (YouTube app, Home button): pause and keep the place */
  document.addEventListener('visibilitychange', function () {
    if (document.hidden && yt && cur) { savePos(); try { yt.pauseVideo(); } catch (e) { /* ignore */ } }
  });

  window.YtPlayer = {
    play: play,
    close: close,
    isOpen: function () { return !!cur; },
    handleKey: handleKey,
    openApp: openApp
  };
})();
