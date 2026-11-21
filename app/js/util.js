/* Shared helpers. Written for webOS 6 (Chromium 79): no ?. / ?? / replaceAll. */
(function () {
  'use strict';

  var KEY = {
    LEFT: 37, UP: 38, RIGHT: 39, DOWN: 40, ENTER: 13,
    BACK: 461, ESC: 27, BACKSPACE: 8,
    CH_UP: 33, CH_DOWN: 34,
    RED: 403, GREEN: 404, YELLOW: 405, BLUE: 406,
    PLAY: 415, PAUSE: 19, PLAYPAUSE: 179, STOP: 413, FF: 417, RW: 412,
    INFO: 457,
    LONG_OK: 10013 /* synthetic: OK held for 0.7 s */
  };

  function el(tag, cls, html) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (html != null) e.innerHTML = html;
    return e;
  }

  function esc(s) {
    if (s == null) return '';
    return String(s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  function pad(n) { return n < 10 ? '0' + n : '' + n; }

  /* ---- clock / time zone ----
   * Times are shown in the TV's own zone unless the user picked a fixed UTC offset
   * (or "by location", resolved once from the internet and cached). */
  var tzOff = null;      // minutes east of UTC, null = TV's own zone

  function setTzOffset(min) { tzOff = (min == null || isNaN(min)) ? null : +min; }

  /* wall-clock parts of a moment in the chosen zone */
  function parts(ms) {
    var d;
    if (tzOff == null) {
      d = new Date(ms);
      return { y: d.getFullYear(), mo: d.getMonth(), d: d.getDate(), wd: d.getDay(), h: d.getHours(), mi: d.getMinutes() };
    }
    d = new Date(ms + tzOff * 60000);
    return { y: d.getUTCFullYear(), mo: d.getUTCMonth(), d: d.getUTCDate(), wd: d.getUTCDay(), h: d.getUTCHours(), mi: d.getUTCMinutes() };
  }

  /* start of the calendar day containing ms, as a day number (for "new day" breaks) */
  function dayKey(ms) { var p = parts(ms); return Date.UTC(p.y, p.mo, p.d) / 86400000; }

  function hhmm(ms) {
    var p = parts(ms);
    return pad(p.h) + ':' + pad(p.mi);
  }

  function fmtOffset(min) {
    var sign = min < 0 ? '-' : '+';
    min = Math.abs(min);
    return 'UTC' + sign + Math.floor(min / 60) + (min % 60 ? ':' + pad(min % 60) : '');
  }

  function fmtDuration(sec) {
    sec = Math.max(0, Math.floor(sec || 0));
    var h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60;
    return (h ? h + ':' + pad(m) : m) + ':' + pad(s);
  }

  function dayLabel(ms) {
    var diff = Math.round(dayKey(ms) - dayKey(Date.now()));
    if (diff === 0) return I18n.t('today');
    if (diff === -1) return I18n.t('yesterday');
    if (diff === 1) return I18n.t('tomorrow');
    var p = parts(ms);
    return I18n.weekday(p.wd) + ', ' + p.d + ' ' + I18n.month(p.mo);
  }

  /* "19.11 14:05" */
  function dateTime(ms) {
    var p = parts(ms);
    return pad(p.d) + '.' + pad(p.mo + 1) + ' ' + pad(p.h) + ':' + pad(p.mi);
  }

  function clamp(v, a, b) { return v < a ? a : (v > b ? b : v); }

  function b64(s) {
    if (!s) return '';
    try {
      var bin = atob(s);
      var bytes = new Uint8Array(bin.length);
      for (var i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      return new TextDecoder('utf-8').decode(bytes);
    } catch (e) { return s; }
  }

  function normName(s) {
    return String(s || '').toLowerCase()
      .replace(/\b(hd|fhd|uhd|4k|sd|hevc|h265|tv)\b/g, '')
      .replace(/[^a-z0-9Ѐ-ӿႠ-ჿ]+/g, '');
  }

  function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }

  /* run async tasks with limited concurrency */
  function Queue(limit) {
    this.limit = limit || 4;
    this.running = 0;
    this.items = [];
  }
  /* front=true: newest request runs first (visible rows win over rows scrolled past) */
  Queue.prototype.push = function (fn, front) {
    var self = this;
    return new Promise(function (resolve, reject) {
      self.items[front ? 'unshift' : 'push']({ fn: fn, resolve: resolve, reject: reject });
      self._next();
    });
  };
  Queue.prototype.clear = function () { this.items = []; };
  Queue.prototype._next = function () {
    var self = this;
    while (this.running < this.limit && this.items.length) {
      var it = this.items.shift();
      this.running++;
      Promise.resolve().then(it.fn).then(it.resolve, it.reject).then(function () {
        self.running--;
        self._next();
      });
    }
  };

  var toastTimer = null;
  function toast(msg, ms) {
    var t = document.getElementById('toast');
    t.textContent = msg;
    t.classList.remove('hidden');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { t.classList.add('hidden'); }, ms || 3000);
  }

  function debounce(fn, ms) {
    var t = null;
    return function () {
      var args = arguments, ctx = this;
      clearTimeout(t);
      t = setTimeout(function () { fn.apply(ctx, args); }, ms);
    };
  }

  /* small inline icon set (own drawings) */
  var ICONS = {
    live: '<svg viewBox="0 0 24 24"><rect x="2" y="5" width="20" height="13" rx="2"/><path d="M8 21h8M12 18v3"/></svg>',
    guide: '<svg viewBox="0 0 24 24"><rect x="3" y="4" width="18" height="16" rx="2"/><path d="M3 9h18M8 4v16"/></svg>',
    search: '<svg viewBox="0 0 24 24"><circle cx="11" cy="11" r="7"/><path d="M21 21l-5-5"/></svg>',
    settings: '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"/></svg>',
    bell: '<svg viewBox="0 0 24 24"><path d="M12 3a6 6 0 0 0-6 6v4l-2 3h16l-2-3V9a6 6 0 0 0-6-6zM10 19a2 2 0 0 0 4 0"/></svg>',
    star: '<svg viewBox="0 0 24 24"><path d="M12 2l3.1 6.3 6.9 1-5 4.9 1.2 6.8L12 17.8 5.8 21l1.2-6.8-5-4.9 6.9-1z"/></svg>',
    folder: '<svg viewBox="0 0 24 24"><path d="M3 6a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/></svg>',
    lock: '<svg viewBox="0 0 24 24"><rect x="4" y="11" width="16" height="10" rx="2"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/></svg>',
    archive: '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></svg>',
    youtube: '<svg viewBox="0 0 24 24"><rect x="2" y="5" width="20" height="14" rx="4"/><path d="M10 9l5 3-5 3z"/></svg>',
    play: '<svg viewBox="0 0 24 24"><path d="M7 4l13 8-13 8z"/></svg>',
    pause: '<svg viewBox="0 0 24 24"><path d="M6 4h4v16H6zM14 4h4v16h-4z"/></svg>',
    tv: '<svg viewBox="0 0 24 24"><rect x="2" y="5" width="20" height="13" rx="2"/><path d="M9 2l3 3 3-3"/></svg>',
    list: '<svg viewBox="0 0 24 24"><path d="M4 6h16M4 12h16M4 18h16"/></svg>',
    left: '<svg viewBox="0 0 24 24"><path d="M15 5l-7 7 7 7"/></svg>',
    right: '<svg viewBox="0 0 24 24"><path d="M9 5l7 7-7 7"/></svg>',
    ok: '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="8"/><circle cx="12" cy="12" r="2.5"/></svg>',
    rewind: '<svg viewBox="0 0 24 24"><path d="M11 6l-7 6 7 6zM20 6l-7 6 7 6z"/></svg>'
  };

  function icon(name, cls) {
    return '<span class="ico ' + (cls || '') + '">' + (ICONS[name] || '') + '</span>';
  }

  /* hide broken logos/posters */
  function imgTag(src, cls, fallbackText) {
    if (!src) {
      return '<span class="' + cls + ' noimg">' + esc((fallbackText || '').slice(0, 2).toUpperCase()) + '</span>';
    }
    return '<img class="' + cls + '" src="' + esc(src) + '" loading="lazy" onerror="this.style.visibility=\'hidden\'">';
  }

  window.U = {
    KEY: KEY, el: el, esc: esc, pad: pad, hhmm: hhmm, fmtDuration: fmtDuration,
    dayLabel: dayLabel, dayKey: dayKey, dateTime: dateTime, setTzOffset: setTzOffset, fmtOffset: fmtOffset, clamp: clamp, b64: b64, normName: normName, sleep: sleep,
    Queue: Queue, toast: toast, debounce: debounce, icon: icon, imgTag: imgTag,
    isWebOS: !!(window.PalmSystem || window.PalmServiceBridge || /Web0S|webOS/i.test(navigator.userAgent))
  };
})();
