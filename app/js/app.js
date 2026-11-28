/* App shell: sidebar, screen switching, key routing, boot. */
(function () {
  'use strict';
  var K = U.KEY;

  var VERSION = '1.3.29';

  var NAV = [
    { id: 'live', icon: 'live', screen: function () { return Live; } },
    { id: 'guide', icon: 'guide', screen: function () { return Guide; } },
    { id: 'youtube', icon: 'youtube', screen: function () { return YouTube; } },
    { id: 'search', icon: 'search', screen: function () { return Search; } },
    { id: 'settings', icon: 'settings', screen: function () { return Settings; } }
  ];

  var sidebar, navIdx = 0, inSidebar = false, curScreen = null;
  var sessionUnlocked = {};
  var okTimer = null, okLong = false, okDown = false;
  var numBuf = '', numTimer = null;
  var reloadTimer = null;

  function buildSidebar() {
    sidebar = document.getElementById('sidebar');
    var h = '<div class="brand"><span class="brand-mark">' + U.icon('tv') + '</span><span class="brand-name">Ekrani</span></div><div class="nav">';
    NAV.forEach(function (n, i) {
      h += '<div class="nav-item" data-i="' + i + '">' + U.icon(n.icon) + '<span>' + U.esc(I18n.t(n.id)) + '</span></div>';
    });
    h += '</div><div class="clock"></div>';
    sidebar.innerHTML = h;
    sidebar.addEventListener('mouseenter', function () { sidebar.classList.add('open'); });
    sidebar.addEventListener('mouseleave', function () { if (!inSidebar) sidebar.classList.remove('open'); });
    sidebar.addEventListener('click', function (e) {
      var it = e.target.closest ? e.target.closest('.nav-item') : null;
      if (!it) return;
      navIdx = +it.getAttribute('data-i');
      App.show(NAV[navIdx].id);
      App.focusContent();
    });
    paintNav();
  }

  function paintNav() {
    var items = sidebar.querySelectorAll('.nav-item');
    for (var i = 0; i < items.length; i++) {
      items[i].classList.toggle('focused', inSidebar && i === navIdx);
      items[i].classList.toggle('current', curScreen === NAV[i].screen());
    }
    sidebar.classList.toggle('open', inSidebar);
  }

  function tickClock() {
    var t = U.hhmm(Date.now());
    var c = sidebar && sidebar.querySelector('.clock');
    if (c) c.textContent = t;
    var tv = document.getElementById('tvClock');
    if (tv) {
      tv.textContent = t;
      tv.classList.toggle('hidden', !Store.get('clock'));
    }
  }

  /* -------- time zone -------- */
  function parseOffset(v) {
    // "+0400", "+04:00", "-0330" -> minutes
    var m = /^([+-])(d{2}):?(d{2})$/.exec(String(v || '').trim());
    if (!m) return null;
    return (m[1] === '-' ? -1 : 1) * (parseInt(m[2], 10) * 60 + parseInt(m[3], 10));
  }

  /* look the zone up from the public IP (only when the user picked "by location") */
  function detectTz() {
    return Net.json('https://ipapi.co/json/', { timeout: 10000 }).then(function (r) {
      var off = r ? parseOffset(r.utc_offset) : null;
      if (off == null) throw new Error('no offset');
      return { off: off, name: r.timezone || '', t: Date.now() };
    })['catch'](function () {
      return Net.json('http://ip-api.com/json/?fields=status,timezone,offset', { timeout: 10000 }).then(function (r) {
        if (!r || r.status !== 'success' || typeof r.offset !== 'number') throw new Error('no offset');
        return { off: Math.round(r.offset / 60), name: r.timezone || '', t: Date.now() };
      });
    });
  }

  function applyTz(refetch) {
    var tz = Store.get('tz');
    if (tz === 'net') {
      var c = Store.get('tzNet');
      U.setTzOffset(c ? c.off : null);
      if (refetch || !c || Date.now() - c.t > 6 * 3600000) {
        detectTz().then(function (r) {
          Store.set('tzNet', r);
          if (Store.get('tz') !== 'net') return;
          U.setTzOffset(r.off);
          timeChanged();
        }, function (e) {
          console.warn('time zone lookup failed', e);
          if (refetch) U.toast(I18n.t('tz_failed'));
        });
      }
    } else if (typeof tz === 'number') {
      U.setTzOffset(tz);
    } else {
      U.setTzOffset(null);
    }
    timeChanged();
  }

  function timeChanged() {
    tickClock();
    if (curScreen && curScreen.refresh) curScreen.refresh();
    Player.refreshInfo();
  }

  /* -------- guide download indicator -------- */
  function paintEpgBadge(st) {
    var b = document.getElementById('epgBadge');
    if (!b) return;
    var on = st.state === 'loading';
    b.classList.toggle('hidden', !on);
    if (on) b.innerHTML = '<span>EPG ' + (st.pct || 0) + '%</span><i><b style="width:' + (st.pct || 0) + '%"></b></i>';
  }

  /* -------- keys -------- */
  function dispatch(e) {
    var k = e.keyCode;
    if (Modal.isOpen()) return Modal.handleKey(e);
    if (window.YtPlayer && YtPlayer.isOpen()) return YtPlayer.handleKey(k);

    // number keys -> channel number
    var digit = k >= 48 && k <= 57 ? k - 48 : (k >= 96 && k <= 105 ? k - 96 : -1);
    var inInput = document.activeElement && document.activeElement.tagName === 'INPUT';
    if (digit >= 0 && !inInput && Data.state.live.length && (curScreen === Live || Player.mode() === 'full')) {
      numberKey(digit);
      return true;
    }

    if (Player.mode() === 'full') {
      // long OK: the player menu; where the player has none (archive lists), it is a plain OK
      if (Player.handleKey({ keyCode: k })) return true;
      return k === K.LONG_OK ? Player.handleKey({ keyCode: K.ENTER }) : false;
    }
    // the remote's guide button (Android remotes)
    if (k === K.GUIDE) { App.show('guide'); return true; }

    if (inSidebar) {
      switch (k) {
        case K.UP: navIdx = Math.max(0, navIdx - 1); paintNav(); App.show(NAV[navIdx].id, true); return true;
        case K.DOWN: navIdx = Math.min(NAV.length - 1, navIdx + 1); paintNav(); App.show(NAV[navIdx].id, true); return true;
        case K.RIGHT: case K.ENTER: case K.LONG_OK: App.focusContent(); return true;
        // Back closes the menu over a playing channel; with nothing behind it, it closes the app
        case K.BACK: case K.ESC: if (!Player.backToChannel()) exitApp(); return true;
      }
      return true;
    }

    if (curScreen && curScreen.key(e.keyCode === k ? e : { keyCode: k })) return true;
    if (k === K.LEFT) { App.focusSidebar(); return true; }
    if (k === K.BACK || k === K.ESC) {
      if (curScreen && curScreen.back && curScreen.back()) return true;
      if (Player.backToChannel()) return true;
      App.focusSidebar();
      return true;
    }
    if (k === K.PLAY || k === K.PLAYPAUSE) { if (Player.current()) Player.full(); return true; }
    return false;
  }

  function onKeyDown(e) {
    var k = e.keyCode;
    var inInput = document.activeElement && document.activeElement.tagName === 'INPUT';
    // OK: delay to keyup so a long press can open the context menu
    if (k === K.ENTER && !inInput) {
      e.preventDefault();
      if (e.repeat || okDown) return;
      okDown = true; okLong = false;
      clearTimeout(okTimer);
      okTimer = setTimeout(function () { okLong = true; dispatch({ keyCode: K.LONG_OK }); }, 700);
      return;
    }
    if (dispatch(e)) {
      if (!(inInput && (k === K.LEFT || k === K.RIGHT || k === K.BACKSPACE))) e.preventDefault();
    }
  }

  function onKeyUp(e) {
    if (e.keyCode === K.ENTER && okDown) {
      okDown = false;
      clearTimeout(okTimer);
      if (!okLong) dispatch({ keyCode: K.ENTER });
    }
  }

  function numberKey(d) {
    numBuf = (numBuf + d).slice(-4);
    var box = document.getElementById('numEntry');
    box.textContent = numBuf;
    box.classList.remove('hidden');
    clearTimeout(numTimer);
    numTimer = setTimeout(function () {
      var n = parseInt(numBuf, 10);
      numBuf = '';
      box.classList.add('hidden');
      var ch = null;
      Data.state.live.some(function (c) { if (c.num === n) { ch = c; return true; } return false; });
      if (!ch) return;
      App.checkLock(ch.group).then(function (ok) {
        if (!ok) return;
        if (Player.mode() === 'full') Player.channelKeyJump(ch);
        else Live.jumpTo(ch);
      });
    }, 1500);
  }

  /* Back twice within two seconds closes the app */
  var backAt = 0;
  function exitApp() {
    var now = Date.now();
    if (now - backAt > 2000) { backAt = now; U.toast(I18n.t('press_back_exit')); return; }
    backAt = 0;
    Player.stop();
    try { if (window.PalmSystem && window.PalmSystem.platformBack) { window.PalmSystem.platformBack(); return; } } catch (e) { /* ignore */ }
    window.close();
  }

  /* -------- playlist form -------- */
  function editPlaylist(pl) {
    var isNew = !pl || !pl.id;   // a prefilled object without id (from the phone) is new too
    pl = pl || { type: 'm3u' };
    return Modal.form(I18n.t(isNew ? 'add_playlist' : 'edit_playlist'), [
      { id: 'type', label: I18n.t('pl_type'), type: 'choice', value: pl.type, options: [{ v: 'm3u', l: I18n.t('m3u_url') }, { v: 'xtream', l: I18n.t('xtream') }] },
      { id: 'name', label: I18n.t('pl_name'), value: pl.name || '', placeholder: 'My IPTV' },
      { id: 'url', label: I18n.t('pl_url'), value: pl.url || '', placeholder: 'http://example.com/playlist.m3u', visible: function (v) { return v.type === 'm3u'; } },
      { id: 'server', label: I18n.t('pl_server'), value: pl.server || '', placeholder: 'http://host:8080', visible: function (v) { return v.type === 'xtream'; } },
      { id: 'user', label: I18n.t('pl_user'), value: pl.user || '', visible: function (v) { return v.type === 'xtream'; } },
      { id: 'pass', label: I18n.t('pl_pass'), type: 'password', value: pl.pass || '', visible: function (v) { return v.type === 'xtream'; } },
      { id: 'epg', label: I18n.t('pl_epg'), value: pl.epg || '', placeholder: I18n.t('epg_sources_hint') }
    ], function (v) {
      if (v.type === 'm3u' && !/^https?:\/\//i.test(v.url || '') && v.url !== LOCAL_PL) return I18n.t('fill_required');
      if (v.type === 'xtream' && (!v.server || !v.user || !v.pass)) return I18n.t('fill_required');
      return null;
    }).then(function (v) {
      if (!v) return null;
      var out = { id: pl.id, type: v.type, name: v.name || (v.type === 'xtream' ? Xtream.normBase(v.server).replace(/^https?:\/\//, '') : 'M3U'), epg: v.epg || '' };
      if (v.type === 'm3u') out.url = v.url; else { out.server = Xtream.normBase(v.server); out.user = v.user; out.pass = v.pass; }
      var first = Store.playlists().length === 0;
      Store.savePlaylist(out);
      if (out.id) Cache.remove('pl:' + out.id);
      if (first || isNew) { Store.setActive(out.id); App.reload(true); }
      return out;
    });
  }

  function dropScreen() {
    if (curScreen) { curScreen.blur(); curScreen.hide(); }
    curScreen = null;
  }

  /* test builds: a playlist file shipped inside the package (app/local/playlist.m3u8; git-ignored, never in the
     published APK or ota/). It is added once; deleted in Settings, it is never added again (the package is read-only). */
  var LOCAL_PL = 'local/playlist.m3u8';
  function addLocalPlaylist() {
    if (Store.get('localPlGone') || Store.playlist(Store.LOCAL_ID)) return Promise.resolve();
    return Net.text(LOCAL_PL, { timeout: 5000 }).then(function (t) {
      if (!/^\s*#EXTM3U/.test(t || '')) return;
      Store.savePlaylist({ id: Store.LOCAL_ID, type: 'm3u', name: 'tv.team (' + I18n.t('pl_file') + ')', url: LOCAL_PL, epg: '' });
    })['catch'](function () { /* this build has no playlist file */ });
  }

  /* first start: the phone QR and "type it on the TV" side by side */
  function welcome() {
    dropScreen();
    function onTv(prefill) { editPlaylist(prefill || null).then(function (pl) { if (!pl) welcome(); }); }
    function plain() { Modal.alert(I18n.t('welcome_title'), U.esc(I18n.t('welcome_text'))).then(function () { onTv(); }); }
    if (!Lan.available()) { plain(); return; }
    Lan.session({
      title: I18n.t('welcome_title'),
      intro: '<div class="lan-intro">' + U.esc(I18n.t('welcome_text')) + '</div>',
      buttons: [{ v: 'tv', l: I18n.t('lan_enter_tv'), primary: true }]
    }).then(function (r) {
      if (r && r.item) onTv(r.item);
      else if (r === 'fail') plain();
      else onTv();   // "type on the TV", or Back
    });
  }

  var App = {
    show: function (id, keepSidebar) {
      var n = null;
      NAV.forEach(function (x, i) { if (x.id === id) { n = x; navIdx = i; } });
      if (!n) return;
      var s = n.screen();
      if (curScreen && curScreen !== s) { curScreen.blur(); curScreen.hide(); }
      if (curScreen !== s) { curScreen = s; s.show(); }
      if (!keepSidebar) { inSidebar = false; s.focus(); }
      paintNav();
    },

    focusSidebar: function () {
      inSidebar = true;
      if (curScreen) curScreen.blur();
      paintNav();
    },

    focusContent: function () {
      if (!inSidebar) return;
      inSidebar = false;
      if (curScreen) curScreen.focus();
      paintNav();
    },

    /* parental lock check for a group name */
    /* true when the group can be opened without asking for the PIN */
    lockOpen: function (group) {
      return !group || !Store.get('pin') || !Store.isLocked(group) || !!sessionUnlocked[group];
    },

    checkLock: function (group) {
      if (!group || !Store.get('pin') || !Store.isLocked(group) || sessionUnlocked[group]) return Promise.resolve(true);
      return App.askPin().then(function (ok) { if (ok) sessionUnlocked[group] = true; return ok; });
    },

    askPin: function () {
      return Modal.pin(I18n.t('pin_enter')).then(function (p) {
        if (p == null) return false;
        if (p !== Store.get('pin')) { U.toast(I18n.t('pin_wrong')); return false; }
        return true;
      });
    },

    toggleGroupLock: function (group) {
      if (!Store.get('pin')) { U.toast(I18n.t('pin_needed')); return Promise.resolve(false); }
      return App.askPin().then(function (ok) {
        if (!ok) return false;
        var locked = Store.toggleLock(group);
        if (locked) delete sessionUnlocked[group];   // locking again: the PIN is asked from now on
        U.toast(I18n.t(locked ? 'lock_group' : 'unlock_group') + ': ' + I18n.t('done'));
        return true;
      });
    },

    /* lock / unlock without asking (the caller already checked the PIN); returns true when now locked */
    setGroupLock: function (group, on) {
      if (Store.isLocked(group) !== !!on) Store.toggleLock(group);
      if (on) delete sessionUnlocked[group];
      return Store.isLocked(group);
    },

    editPlaylist: editPlaylist,
    version: VERSION,
    applyTz: applyTz,

    /* (re)load the active playlist */
    reload: function (force, boot) {
      if (!boot) Player.stop();
      Modal.closeAll();
      sessionUnlocked = {};
      if (!Store.active()) { welcome(); return Promise.resolve(); }
      var busy = Modal.busy(I18n.t('loading_playlist'));
      return Data.load(force).then(function () {
        App.bootMark('data');
        busy.close();
        dropScreen();
        [Live, Guide, YouTube, Search, Settings].forEach(function (s) { s.reset(); });
        App.show('live');
        App.bootMark('ui');
        if (Store.get('autoplay')) Live.playLast(!!boot);   // at start-up straight to full screen
        Player.dropWarm();
      }).catch(function (e) {
        busy.close();
        Player.dropWarm();
        console.error(e);
        Modal.alert(I18n.t('load_error'), U.esc(e.message || String(e))).then(function () {
          App.show('settings');
        });
      });
    },

    scheduleReload: function () {
      clearTimeout(reloadTimer);
      reloadTimer = setTimeout(function () { App.reload(true); }, 2500);
    },

    /* language change: rebuild every screen */
    rebuild: function () {
      Player.stop();
      document.getElementById('screens').innerHTML = '';
      buildSidebar();
      [Live, Guide, YouTube, Search, Settings].forEach(function (s) { s.build(); s.reset(); });
      curScreen = null;
      if (Data.state.loaded) {
        App.show('settings');
      } else App.reload(false);
    },

    start: function () {
      App.bootMark('start');
      if (window.Boot) Boot.started();   // this code runs: a downloaded update is kept
      Player.init();
      buildSidebar();
      [Live, Guide, YouTube, Search, Settings].forEach(function (s) { s.build(); });
      applyTz(false);
      setInterval(tickClock, 5000);
      Reminders.start();
      // YouTube channels from Settings: cached lists now, the network a bit later and every 3 h
      setTimeout(function () { YtChannels.refresh(); }, 3000);
      setInterval(function () { YtChannels.refresh(); }, 3 * 3600000);
      Epg.onStatus(paintEpgBadge);
      // the guide: downloaded again when it is out of date or running out, also while the app stays open
      setInterval(Epg.check, 10 * 60000);
      window.addEventListener('online', function () { setTimeout(Epg.check, 5000); });
      Update.start();

      document.addEventListener('keydown', onKeyDown, true);
      document.addEventListener('keyup', onKeyUp, true);
      Player.onExit = function () {
        if (curScreen === Live) { var c = Player.current(); if (c) Live.syncTo(c.ch, c.gid); Live.focus(); }
      };
      Player.onChannelChange = function (ch, i, gid) { if (curScreen === Live) Live.syncTo(ch, gid); };

      document.addEventListener('visibilitychange', function () {
        if (document.hidden) Player.suspend(); else { Player.resume(); setTimeout(Epg.check, 3000); }
      });
      // webOS: show the pointer-friendly UI when the Magic Remote cursor appears
      document.addEventListener('cursorStateChange', function (e) {
        document.body.classList.toggle('pointer', !!(e.detail && e.detail.visibility));
      });

      function go() {
        if (!Store.active()) { welcome(); return; }
        // start the last channel's stream right away; the playlist, guide and screens load meanwhile
        var lp = Store.get('autoplay') && Store.lastPlay();
        if (lp && lp.url && lp.key === Store.lastChannel() && !Store.isLocked(lp.group)) Player.warm(lp.url);
        App.reload(false, true);
      }
      if (Store.get('localPlGone') || Store.playlist(Store.LOCAL_ID)) go();
      else addLocalPlaylist().then(go);
    },

    /* boot timing (console + Settings → about), to see where start-up time goes on the TV */
    bootTimes: {},
    bootMark: function (name) {
      if (App.bootTimes[name] != null) return;
      App.bootTimes[name] = Math.round(window.performance && performance.now ? performance.now() : 0);
      if (window.console) console.info('[boot] ' + name + ' ' + App.bootTimes[name] + ' ms');
    }
  };

  window.App = App;
  window.addEventListener('load', App.start);
})();
