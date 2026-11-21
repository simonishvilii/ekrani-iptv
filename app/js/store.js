/* Persistent state: settings + playlists in localStorage, big caches in IndexedDB. */
(function () {
  'use strict';

  var PREFIX = 'ekrani.';

  function load(key, def) {
    try {
      var v = localStorage.getItem(PREFIX + key);
      return v == null ? def : JSON.parse(v);
    } catch (e) { return def; }
  }
  function save(key, val) {
    try { localStorage.setItem(PREFIX + key, JSON.stringify(val)); } catch (e) { console.warn('save failed', key, e); }
  }

  var DEFAULTS = {
    lang: 'ka',
    streamFormat: 'm3u8',   // Xtream live: m3u8 | ts
    epgShift: 0,            // hours
    updateHours: 24,        // 0 = every launch
    autoplay: true,
    okMode: 'preview',      // old setting (before 1.3.2), replaced by chOk
    chOk: 'preview',        // auto: preview starts on focus, OK = fullscreen | preview: OK preview, OK again fullscreen | full
    aspect: 'contain',
    pin: '',
    clock: true,            // clock in the corner while watching
    tz: 'auto',             // 'auto' (TV zone) | 'net' (by location) | minutes east of UTC
    // remote buttons while watching live in fullscreen (see Player.ACTIONS)
    k_ok: 'info', k_left: 'list', k_right: 'epg', k_up: 'next', k_down: 'prev',
    k_chup: 'next', k_chdown: 'prev',
    k_red: 'fav', k_green: 'audio', k_yellow: 'last', k_blue: 'restart',
    chScope: 'group',       // CH± / ⬆⬇: group | all | fav
    failNext: true,         // skip a channel that will not play
    ytApiKey: '',           // YouTube Data API v3 key (optional): full channel lists + durations
    ytMinMin: 20,           // YouTube: hide videos shorter than this many minutes (only known with a key)
    ytQuality: 2160         // YouTube player is laid out at this height so YouTube serves up to that quality (0 = YouTube decides)
  };

  var settings = Object.assign({}, DEFAULTS, load('settings', {}));
  // 1.3.2 started channels on focus by default and saved that with the other settings: back to "OK = preview" once
  if (!settings.m133) { settings.chOk = 'preview'; settings.m133 = true; save('settings', settings); }
  // before 1.3.5 OK on the live picture opened the channel list; now it shows the info/progress bar
  if (!settings.m135) { if (settings.k_ok === 'list') settings.k_ok = 'info'; settings.m135 = true; save('settings', settings); }
  // before 1.3.20 yellow/blue were subtitles/picture size (both also in Settings): now the last channel and the programme from its start
  if (!settings.m1320) {
    if (settings.k_yellow === 'subs') settings.k_yellow = 'last';
    if (settings.k_blue === 'aspect') settings.k_blue = 'restart';
    settings.m1320 = true; save('settings', settings);
  }
  var playlists = load('playlists', []);
  var activeId = load('active', playlists.length ? playlists[0].id : null);

  var Store = {
    LOCAL_ID: 'plocal',
    get: function (k) { return settings[k]; },
    set: function (k, v) { settings[k] = v; save('settings', settings); },
    def: function (k) { return DEFAULTS[k]; },

    playlists: function () { return playlists; },
    playlist: function (id) {
      for (var i = 0; i < playlists.length; i++) if (playlists[i].id === id) return playlists[i];
      return null;
    },
    active: function () { return Store.playlist(activeId) || playlists[0] || null; },
    setActive: function (id) { activeId = id; save('active', id); },
    savePlaylist: function (pl) {
      if (!pl.id) pl.id = 'p' + Date.now().toString(36);
      var found = false;
      for (var i = 0; i < playlists.length; i++) {
        if (playlists[i].id === pl.id) { playlists[i] = pl; found = true; }
      }
      if (!found) playlists.push(pl);
      save('playlists', playlists);
      if (!activeId || !Store.playlist(activeId)) Store.setActive(pl.id);
      return pl;
    },
    deletePlaylist: function (id) {
      // the playlist file shipped with a test build (App: addLocalPlaylist) is never added again
      if (id === Store.LOCAL_ID) Store.set('localPlGone', true);
      playlists = playlists.filter(function (p) { return p.id !== id; });
      save('playlists', playlists);
      ['fav_live_', 'fav_movie_', 'fav_series_', 'recent_', 'locked_', 'last_', 'chedit_', 'chorder_', 'chaspect_', 'chaudio_', 'reminders_', 'watch_', 'lastplay_'].forEach(function (k) {
        try { localStorage.removeItem(PREFIX + k + id); } catch (e) { /* ignore */ }
      });
      Cache.remove('pl:' + id);
      Cache.remove('epg:' + id);
      Cache.removePrefix('epgc:' + id + ':');
      if (activeId === id) Store.setActive(playlists.length ? playlists[0].id : null);
    },

    /* per-playlist lists */
    list: function (name) {
      var pl = Store.active();
      return pl ? load(name + '_' + pl.id, []) : [];
    },
    setList: function (name, arr) {
      var pl = Store.active();
      if (pl) save(name + '_' + pl.id, arr);
    },
    /* per-playlist key -> value maps */
    map: function (name) {
      var pl = Store.active();
      var m = pl ? load(name + '_' + pl.id, {}) : {};
      return m && typeof m === 'object' && !Array.isArray(m) ? m : {};
    },
    setMap: function (name, m) {
      var pl = Store.active();
      if (pl) save(name + '_' + pl.id, m);
    },
    isFav: function (type, key) { return Store.list('fav_' + type).indexOf(key) >= 0; },
    toggleFav: function (type, key) {
      var l = Store.list('fav_' + type);
      var i = l.indexOf(key);
      if (i >= 0) l.splice(i, 1); else l.unshift(key);
      Store.setList('fav_' + type, l);
      return i < 0;
    },
    pushRecent: function (key) {
      var l = Store.list('recent').filter(function (k) { return k !== key; });
      l.unshift(key);
      Store.setList('recent', l.slice(0, 40));
    },
    isLocked: function (group) {
      var l = Store.list('locked');
      return l.indexOf(group) >= 0;
    },
    toggleLock: function (group) {
      var l = Store.list('locked');
      var i = l.indexOf(group);
      if (i >= 0) l.splice(i, 1); else l.push(group);
      Store.setList('locked', l);
      return i < 0;
    },
    lastChannel: function () { var pl = Store.active(); return pl ? load('last_' + pl.id, null) : null; },
    setLastChannel: function (key) { var pl = Store.active(); if (pl) save('last_' + pl.id, key); },
    /* {key, url, group} of the last live channel: lets the next start begin streaming before the playlist is loaded */
    lastPlay: function () { var pl = Store.active(); return pl ? load('lastplay_' + pl.id, null) : null; },
    setLastPlay: function (o) {
      var pl = Store.active();
      if (!pl) return;
      var old = load('lastplay_' + pl.id, null);
      if (!old || old.url !== o.url) save('lastplay_' + pl.id, o);
    },

    /* VOD resume positions (global for active playlist) */
    positions: function () { return Store.list('pos'); },
    getPos: function (key) {
      var l = Store.positions();
      for (var i = 0; i < l.length; i++) if (l[i].key === key) return l[i];
      return null;
    },
    setPos: function (key, pos, dur, meta) {
      var l = Store.positions().filter(function (p) { return p.key !== key; });
      var finished = dur > 0 && pos > dur * 0.95;
      if (!finished && pos > 30) l.unshift({ key: key, pos: pos, dur: dur, t: Date.now(), meta: meta });
      Store.setList('pos', l.slice(0, 60));
    }
  };

  /* --- IndexedDB key/value cache for playlists and EPG --- */
  var dbp = null;
  function db() {
    if (dbp) return dbp;
    dbp = new Promise(function (resolve) {
      try {
        var req = indexedDB.open('ekrani', 1);
        req.onupgradeneeded = function () { req.result.createObjectStore('kv'); };
        req.onsuccess = function () { resolve(req.result); };
        req.onerror = function () { resolve(null); };
      } catch (e) { resolve(null); }
    });
    return dbp;
  }
  function tx(mode, fn) {
    return db().then(function (d) {
      if (!d) return null;
      return new Promise(function (resolve) {
        try {
          var t = d.transaction('kv', mode);
          var r = fn(t.objectStore('kv'));
          t.oncomplete = function () { resolve(r && r.result); };
          t.onerror = t.onabort = function () { resolve(null); };
        } catch (e) { resolve(null); }
      });
    });
  }
  var Cache = {
    get: function (k) { return tx('readonly', function (s) { return s.get(k); }); },
    set: function (k, v) { return tx('readwrite', function (s) { return s.put(v, k); }); },
    remove: function (k) { return tx('readwrite', function (s) { return s['delete'](k); }); },
    /* rows: [[key, value], …] in one transaction */
    setMany: function (rows) { return tx('readwrite', function (s) { rows.forEach(function (r) { s.put(r[1], r[0]); }); }); },
    /* walk every key that starts with p: fn(key, value); resolves when done */
    scan: function (p, fn) {
      return db().then(function (d) {
        if (!d) return;
        return new Promise(function (resolve) {
          try {
            var req = d.transaction('kv', 'readonly').objectStore('kv').openCursor(IDBKeyRange.bound(p, p + String.fromCharCode(0xffff)));
            req.onsuccess = function () {
              var c = req.result;
              if (!c) { resolve(); return; }
              if (fn(c.key, c.value) === false) { resolve(); return; }
              c['continue']();
            };
            req.onerror = function () { resolve(); };
          } catch (e) { resolve(); }
        });
      });
    },
    /* delete every key that starts with prefix */
    removePrefix: function (p) { return tx('readwrite', function (s) { return s['delete'](IDBKeyRange.bound(p, p + String.fromCharCode(0xffff))); }); }
  };

  I18n.setLang(settings.lang);
  window.Store = Store;
  window.Cache = Cache;
})();
