/* Video playback: preview box / fullscreen, live info bar, channel list overlay, archive seek bar. */
(function () {
  'use strict';
  var K = U.KEY;

  var video, layer, spinner, msg, overlay;
  var cur = null;           // {type:'live'|'catchup', ch, prog, url, list, index}
  var mode = 'hidden';      // hidden | preview | bg | full
  var fromMenu = false;     // the side menu was opened from full screen: Back returns to the picture
  var previewEl = null;
  var hideTimer = null, stallTimer = null;
  var retries = 0, triedAlt = false, quick = false;
  var warmUrl = null;       // last channel started at boot before the playlist / UI were ready
  var netWait = null;       // {t} while waiting for the network to come back (TV just switched on)
  var hls = null, hlsFixed = false, hlsBroken = false;   // live HLS through hls.js (webOS): see attach()
  var ovState = 'none';     // none | info | list | groups | epg
  var ovList = null;        // VList of the open list / programme panel
  var browse = null;        // group shown in the channel list overlay {gid, name, list}
  var epgCh = null, epgFrom = null;
  var pausedAt = 0;
  var seekAcc = 0, seekTimer = null, seekTarget = null;
  var skips = 0, lastDir = 1; // auto-skip of channels that do not play

  function init() {
    video = document.getElementById('video');
    layer = document.getElementById('videoLayer');
    spinner = document.getElementById('videoSpinner');
    msg = document.getElementById('videoMsg');
    overlay = document.getElementById('playerOverlay');

    video.addEventListener('playing', function () { setBusy(false); hideMsg(); retries = 0; skips = 0; quick = false; App.bootMark('playing'); });
    // network back (after switching the TV on, Wi-Fi needs a few seconds): continue at once
    window.addEventListener('online', function () {
      if (!netWait || !cur) return;
      var t = netWait.t;
      netWait = null;
      load(cur.url, t);
    });
    video.addEventListener('loadedmetadata', function () { paintQuality(); applyAudio(); setTimeout(applyAudio, 1500); });
    video.addEventListener('resize', paintQuality);
    video.addEventListener('waiting', onStall);
    video.addEventListener('loadstart', function () { setBusy(true); });
    video.addEventListener('canplay', function () { setBusy(false); });
    video.addEventListener('error', onError);
    var lastT = -1;
    video.addEventListener('timeupdate', function () {
      // playback is progressing: make sure the spinner / stall watchdog are off
      if (video.currentTime !== lastT && !video.paused && !spinner.classList.contains('hidden')) setBusy(false);
      lastT = video.currentTime;
      if (ovState === 'info' && cur && cur.type !== 'live') paintSeek();
    });
    video.addEventListener('ended', function () {
      if (cur && cur.type === 'catchup') catchupEnded();
    });
    layer.addEventListener('click', function () {
      if (mode === 'preview') { Player.full(); return; }
      if (mode === 'full') { if (ovState === 'none') showInfo(); else hideOverlay(); }
    });
    window.addEventListener('resize', function () { if (mode === 'preview') placePreview(); });
    // Magic Remote wheel over the full-screen picture = the OK button (lists scroll by themselves)
    var lastWheel = 0;
    document.addEventListener('wheel', function (e) {
      if (mode !== 'full' || !cur || ovList || Modal.isOpen()) return;
      e.preventDefault();
      var now = Date.now();
      if (now - lastWheel < 600) return;
      lastWheel = now;
      if (cur.type === 'live' && mapped('ok') !== 'info') runAction(mapped('ok')); else showInfo();   // info is shown, not toggled, while scrolling
    }, { passive: false });
    Epg.onUpdate(U.debounce(onEpgUpdate, 300));
    applyAspect();
  }

  /* picture size: remembered per channel, otherwise the global setting */
  function curAspect() {
    var m = cur && cur.ch ? Store.map('chaspect')[cur.ch.key] : null;
    return m || Store.get('aspect') || 'contain';
  }
  function applyAspect() { if (video) video.style.objectFit = curAspect(); }

  /* stream resolution for the info bar */
  function quality() {
    var h = video && video.videoHeight;
    if (!h) return '';
    return h >= 2000 ? '4K' : h >= 1400 ? '1440p' : h >= 1000 ? '1080p' : h >= 700 ? '720p' : h >= 560 ? '576p' : h + 'p';
  }
  function paintQuality() {
    var q = overlay && overlay.querySelector('.ib-q');
    if (q) q.textContent = quality();
  }

  function setBusy(b) {
    spinner.classList.toggle('hidden', !b);
    clearTimeout(stallTimer);
    if (b && cur && cur.type === 'live') {
      stallTimer = setTimeout(function () { reload(I18n.t('retrying')); }, 15000);
    }
  }
  function onStall() { if (!video.paused || video.readyState < 3) setBusy(true); }
  function showMsg(t) { msg.textContent = t; msg.classList.remove('hidden'); }
  function hideMsg() { msg.classList.add('hidden'); }

  function waitNet(startAt) {
    netWait = { t: startAt || 0 };
    clearTimeout(stallTimer);
    spinner.classList.remove('hidden');
    showMsg(I18n.t('waiting_network'));
  }

  function onError(fromHls) {
    if (hls && fromHls !== true) return;   // hls.js reports its own errors (onHlsError)
    if (!cur && warmUrl) { warmUrl = null; dropHls(); return; }   // boot start failed: playLive loads again
    if (!cur || (!hls && !video.getAttribute('src'))) return;
    setBusy(false);
    // no network yet: wait for it instead of spending the retries
    if (navigator.onLine === false) { waitNet(0); return; }
    // one fast retry first: right after power-on the first request often fails
    if (!quick && retries === 0) {
      quick = true;
      setTimeout(function () { if (cur) load(cur.url); }, 700);
      return;
    }
    if (cur.type === 'live' && !triedAlt) {
      var alt = Data.altLiveUrl(cur.ch);
      if (alt) { triedAlt = true; load(alt); return; }
    }
    // Xtream archive: some panels only serve one container for timeshift
    if (cur.type === 'catchup' && !triedAlt && cur.ch && cur.ch.catchup && cur.ch.catchup.type === 'xtream') {
      var u = cur.url;
      var other = /\.m3u8$/.test(u) ? u.replace(/\.m3u8$/, '.ts') : (/\.ts$/.test(u) ? u.replace(/\.ts$/, '.m3u8') : '');
      if (other) { triedAlt = true; load(other); return; }
    }
    if (retries < 3) {
      retries++;
      showMsg(I18n.t('play_error') + ' — ' + I18n.t('retrying'));
      setTimeout(function () { if (cur) load(cur.url); }, (cur.type === 'live' ? 1500 : 3000) * retries);
    } else if (cur.type === 'live' && mode === 'full' && Store.get('failNext') && skips < 5 && ovState !== 'list' && !Modal.isOpen()) {
      skips++;
      U.toast(I18n.t('ch_unavailable'));
      step(lastDir);
    } else {
      showMsg(I18n.t('play_error'));
    }
  }

  function reload(text) {
    if (!cur) return;
    if (text) showMsg(text);
    load(cur.url, 0);
  }

  /* ---------- live HLS: hls.js or the TV's own player ----------
     The TV's player (webOS) starts at the newest segment with almost no buffer and has no setting for it, so a
     slow segment stops the picture. hls.js (bundled into player.js by the build) plays ~10 s behind live with
     its own buffer. Archive, non-HLS streams, Android (ExoPlayer) and channels set to the TV's player
     (Settings, or picking an audio track: hls.js plays only a stream's first audio) keep the <video> player. */
  var HLS_CFG = {
    enableWorker: true,
    lowLatencyMode: false,
    liveSyncDuration: 10,          // play ~10 s behind the newest segment: a slow download is covered by the buffer
    liveMaxLatencyDuration: 30,    // more than 30 s behind (after a long stall): jump forward
    maxLiveSyncPlaybackRate: 1,    // never speed up to catch up
    maxBufferLength: 30,
    maxMaxBufferLength: 60,
    backBufferLength: 10,          // the TV's memory: keep only 10 s of what was played
    // a quick channel change: the first segment is played while it downloads (fetch stream) instead of after it,
    // and it is requested together with the playlist
    progressive: true,
    startFragPrefetch: true
  };

  function hlsWanted(url, key) {
    if (window.EkraniAndroid || !window.Hls || !Hls.isSupported()) return false;
    if (Store.get('liveEngine') === 'native') return false;
    if (!/\.m3u8($|\?)/i.test(url)) return false;
    return !(key && Store.map('chnative')[key]);
  }

  function dropHls() {
    if (!hls) return;
    var h = hls;
    hls = null;
    try { h.destroy(); } catch (e) { /* ignore */ }
  }

  /* point the <video> at a stream, through hls.js or directly */
  function attach(url, viaHls) {
    if (!viaHls || hlsBroken) dropHls();
    if (!viaHls) {
      video.src = url;
      try { video.load(); } catch (e) { /* ignore */ }
      return;
    }
    hlsFixed = false;
    // the next channel on the same hls.js: its worker and decoder setup stay (no new instance to build for every channel)
    if (hls) { hls.loadSource(url); return; }
    hlsBroken = false;
    var h = hls = new Hls(HLS_CFG);
    h.on(Hls.Events.ERROR, function (ev, d) { if (hls === h) onHlsError(d); });
    h.attachMedia(video);
    h.loadSource(url);
  }

  function onHlsError(d) {
    if (!d || !d.fatal) return;   // hls.js retries / skips on its own
    if (!(d.type === Hls.ErrorTypes.MEDIA_ERROR && !hlsFixed)) hlsBroken = true;   // the next load starts a new hls.js
    console.warn('hls.js', d.type, d.details);
    if (!cur) { if (warmUrl) { warmUrl = null; dropHls(); } return; }   // boot start: playLive loads again
    if (d.type === Hls.ErrorTypes.NETWORK_ERROR) { onError(true); return; }   // same retries as the TV's player
    if (d.type === Hls.ErrorTypes.MEDIA_ERROR && !hlsFixed) { hlsFixed = true; hls.recoverMediaError(); return; }
    // a stream hls.js cannot play (codec …): this channel goes on with the TV's player
    cur.native = true;
    load(cur.url);
  }

  function load(url, startAt) {
    cur.url = url;
    netWait = null;
    if (navigator.onLine === false) { waitNet(startAt); return; }
    hideMsg();
    setBusy(true);
    attach(url, cur.type === 'live' && !cur.native && hlsWanted(url, cur.ch && cur.ch.key));
    if (startAt > 0) {
      var once = function () { video.removeEventListener('loadedmetadata', once); try { video.currentTime = startAt; } catch (e) { /* ignore */ } };
      video.addEventListener('loadedmetadata', once);
    }
    var p = video.play();
    if (p && p['catch']) p['catch'](function () { /* autoplay errors surface through 'error' */ });
  }

  function placePreview() {
    if (!previewEl) return;
    var r = previewEl.getBoundingClientRect();
    layer.style.left = r.left + 'px';
    layer.style.top = r.top + 'px';
    layer.style.width = r.width + 'px';
    layer.style.height = r.height + 'px';
  }

  /* modes: full | preview (the Live screen's box) | bg (other screens: keeps playing, not shown) | hidden (stopped) */
  function setMode(m) {
    mode = m;
    if (m === 'full' || m === 'hidden') fromMenu = false;
    layer.classList.toggle('hidden', m === 'hidden' || m === 'bg');
    layer.classList.toggle('full', m === 'full');
    document.body.classList.toggle('fullscreen', m === 'full');
    if (m === 'full') {
      layer.style.left = layer.style.top = '0';
      layer.style.width = layer.style.height = '100%';
    } else if (m === 'preview') {
      placePreview();
    }
    if (m !== 'full') hideOverlay();
  }

  /* ---------- remote buttons ---------- */
  var ACTIONS = ['none', 'list', 'groups', 'epg', 'next', 'prev', 'last', 'fav', 'info', 'audio', 'subs', 'aspect', 'rewind', 'restart', 'guide'];
  var BUTTONS = [
    ['ok', K.ENTER], ['left', K.LEFT], ['right', K.RIGHT], ['up', K.UP], ['down', K.DOWN],
    ['chup', K.CH_UP], ['chdown', K.CH_DOWN], ['red', K.RED], ['green', K.GREEN], ['yellow', K.YELLOW], ['blue', K.BLUE]
  ];

  function buttonName(k) {
    for (var i = 0; i < BUTTONS.length; i++) if (BUTTONS[i][1] === k) return BUTTONS[i][0];
    return null;
  }
  function mapped(name) { return Store.get('k_' + name) || Store.def('k_' + name) || 'none'; }

  function actLabel(a) {
    var special = { audio: 'audio_track', subs: 'subtitles', aspect: 'aspect', guide: 'guide' };
    return I18n.t(special[a] || 'act_' + a);
  }

  /* ---------- overlay: info bar ---------- */
  function setOv(st) {
    ovState = st;
    document.body.setAttribute('data-ov', st);
  }

  function hideOverlay() {
    setOv('none');
    overlay.classList.add('hidden');
    overlay.innerHTML = '';
    ovList = null;
    clearTimeout(hideTimer);
  }

  function autoHide(ms) {
    clearTimeout(hideTimer);
    hideTimer = setTimeout(function () {
      if (ovState === 'info' && !(cur && cur.type !== 'live' && video.paused)) hideOverlay();
      else if (ovState === 'list' || ovState === 'groups' || ovState === 'epg') hideOverlay();
    }, ms || 5000);
  }
  /* lists close by themselves when the remote is left alone */
  function idle() { autoHide(25000); }

  function liveInfoHtml() {
    var ch = cur.ch;
    var nn = Epg.nowNext(ch);
    var now = Date.now();
    var progHtml = '';
    if (nn.cur) {
      var pct = U.clamp((now - nn.cur.s) / (nn.cur.e - nn.cur.s) * 100, 0, 100);
      progHtml = '<div class="ib-prog"><span class="time">' + U.hhmm(nn.cur.s) + '–' + U.hhmm(nn.cur.e) + '</span> <b>' + U.esc(nn.cur.t) + '</b></div>' +
        '<div class="bar"><i style="width:' + pct + '%"></i></div>' +
        (nn.next ? '<div class="ib-next">' + I18n.t('next') + ': ' + U.hhmm(nn.next.s) + ' ' + U.esc(nn.next.t) + '</div>' : '');
    } else {
      progHtml = '<div class="ib-next">' + I18n.t('no_epg') + '</div>';
    }
    return '<div class="ib-num">' + (ch.num || '') + '</div>' +
      '<div class="ib-logo">' + U.imgTag(ch.logo, 'logo', ch.name) + '</div>' +
      '<div class="ib-main"><div class="ib-name">' + U.esc(ch.name) +
      (ch.catchup ? ' <span class="badge">' + U.icon('archive') + '</span>' : '') +
      (Store.isFav('live', ch.key) ? ' <span class="badge fav">' + U.icon('star') + '</span>' : '') +
      ' <span class="badge ib-q">' + quality() + '</span></div>' + progHtml + '</div>' +
      (Store.get('clock') ? '' : '<div class="ib-clock">' + U.hhmm(now) + '</div>');
  }

  function archiveInfoHtml() {
    var head = '<div class="ib-name">' + (cur.ch.num ? cur.ch.num + '. ' : '') + U.esc(cur.ch.name) +
      ' <span class="badge archive">' + U.icon('archive') + I18n.t('archive') + '</span> <span class="badge ib-q">' + quality() + '</span></div>' +
      '<div class="ib-prog"><span class="time">' + U.hhmm(cur.prog.s) + '–' + U.hhmm(cur.prog.e) + '</span> <b>' + U.esc(cur.prog.t || '') + '</b></div>';
    return '<div class="ib-logo">' + U.imgTag(cur.ch.logo, 'logo', cur.ch.name) + '</div>' +
      '<div class="ib-main wide">' + head +
      '<div class="seek"><span class="seek-ico">' + U.icon(video.paused ? 'pause' : 'play') + '</span><span class="seek-t cur">0:00</span>' +
      '<div class="bar seekbar"><b></b><i></i></div><span class="seek-t dur">0:00</span></div></div>' +
      (Store.get('clock') ? '' : '<div class="ib-clock">' + U.hhmm(Date.now()) + '</div>');
  }

  /* colour-button hints, built from the current button setup */
  function buttonsHtml() {
    var b = '';
    if (cur.type === 'catchup') {
      b += '<div class="ob" data-a="golive"><span class="ob-key">BACK</span>' + U.esc(I18n.t('back_to_live')) + '</div>';
    }
    ['red', 'green', 'yellow', 'blue'].forEach(function (c) {
      var a = mapped(c);
      if (!a || a === 'none') return;
      b += '<div class="ob" data-a="' + a + '"><i class="dot ' + c + '"></i>' + U.esc(actLabel(a)) + '</div>';
    });
    return b ? '<div class="ob-row">' + b + '</div>' : '';
  }

  function showInfo(keep) {
    if (!cur || mode !== 'full') return;
    setOv('info');
    overlay.classList.remove('hidden');
    overlay.innerHTML = '<div class="ib-wrap">' + buttonsHtml() + '<div class="infobar">' + (cur.type === 'live' ? liveInfoHtml() : archiveInfoHtml()) + '</div></div>';
    overlay.onclick = function (e) {
      var b = e.target.closest ? e.target.closest('.ob') : null;
      if (b) { runAction(b.getAttribute('data-a')); return; }
      var sb = e.target.closest ? e.target.closest('.seekbar') : null;
      if (sb) {
        var r = sb.getBoundingClientRect(), d = seekLen();
        if (d) video.currentTime = U.clamp((e.clientX - r.left) / r.width * d, 0, Math.max(0, availEnd() - 1));
      }
    };
    if (cur.type !== 'live') paintSeek();
    if (!keep) autoHide(cur.type === 'live' ? 5000 : 4000);
  }

  /* seconds that can be played right now */
  function availEnd() {
    var d = video.duration;
    if (!isFinite(d) || !d) {
      var s = video.seekable;
      d = s && s.length ? s.end(s.length - 1) : 0;
    }
    return d || 0;
  }
  /* length of the seek bar: the whole programme */
  function seekLen() {
    if (cur && cur.type === 'catchup') return Math.max(availEnd(), (cur.prog.e - cur.prog.s) / 1000);
    return availEnd();
  }

  function paintSeek() {
    var bar = overlay.querySelector('.seekbar i');
    if (!bar) return;
    var len = seekLen(), avail = availEnd();
    var t = seekTarget != null ? seekTarget : video.currentTime;
    bar.style.width = (len ? U.clamp(t / len * 100, 0, 100) : 0) + '%';
    var got = overlay.querySelector('.seekbar b');
    if (got) got.style.width = (len ? U.clamp(avail / len * 100, 0, 100) : 0) + '%';
    var tc = overlay.querySelector('.seek-t.cur'), td = overlay.querySelector('.seek-t.dur');
    if (cur.type === 'catchup') {
      // wall-clock time of the picture, like a recording
      tc.textContent = U.hhmm(cur.prog.s + t * 1000);
      td.textContent = U.hhmm(cur.prog.e);
    } else {
      tc.textContent = U.fmtDuration(t);
      td.textContent = len ? U.fmtDuration(len) : '--:--';
    }
    var ico = overlay.querySelector('.seek-ico');
    if (ico) ico.innerHTML = U.icon(video.paused ? 'pause' : 'play');
  }

  function hint(icon, text) {
    return '<span class="ov-k">' + U.icon(icon) + '</span><span class="ov-kt">' + U.esc(text) + '</span>';
  }

  /* ---------- overlay: channels of a group ---------- */
  function curGroup() {
    return {
      gid: cur.gid || (cur.list ? '' : '__all'),
      name: cur.listName || I18n.t('all_channels'),
      list: cur.list || Data.liveList('__all')
    };
  }

  function showList(b) {
    if (!cur || !cur.ch) return;
    b = b || curGroup();
    browse = b;
    var idx = b.index != null ? b.index : b.list.indexOf(cur.ch);
    setOv('list');
    overlay.classList.remove('hidden');
    overlay.innerHTML = '<div class="ov-list"><div class="ov-title"><span class="ov-tn">' + U.esc(b.name) + '</span><span class="ov-count">' + b.list.length + '</span></div>' +
      '<div class="ov-items"></div><div class="ov-hint">' + hint('left', I18n.t('groups')) + hint('right', I18n.t('close')) + '</div></div>';
    overlay.onclick = null;
    ovList = new VList(overlay.querySelector('.ov-items'), {
      rowHeight: 8, itemClass: 'ch-row', emptyText: I18n.t('no_items'),
      render: function (c) { return Live.renderChannel(c); },
      onSelect: function (c, i) { pickChannel(i); }
    });
    ovList.setItems(b.list, idx < 0 ? 0 : idx);
    ovList.setActive(true);
    idle();
  }

  function pickChannel(i) {
    var b = browse, ch = b && b.list[i];
    if (!ch) return;
    hideOverlay();
    if (cur.type === 'live' && cur.ch === ch) {
      cur.list = b.list; cur.index = i; cur.listName = b.name; cur.gid = b.gid;
      showInfo();
      if (Player.onChannelChange) Player.onChannelChange(ch, i, b.gid);
      return;
    }
    playIn(b.list, i, b.name, b.gid);
  }

  function playIn(list, i, name, gid) {
    var ch = list[i];
    if (!ch) return;
    App.checkLock(ch.group).then(function (ok) {
      if (!ok) return;
      Player.playLive(ch, { list: list, index: i, listName: name, gid: gid, keepMode: true });
      if (Player.onChannelChange) Player.onChannelChange(ch, i, gid);
    });
  }

  /* ---------- overlay: groups ---------- */
  function showGroups() {
    if (!cur || !cur.ch) return;
    var groups = Data.liveGroups();
    var gid = browse ? browse.gid : curGroup().gid;
    var idx = 0;
    groups.forEach(function (g, i) { if (g.id === gid) idx = i; });
    setOv('groups');
    overlay.classList.remove('hidden');
    overlay.innerHTML = '<div class="ov-list"><div class="ov-title"><span class="ov-tn">' + U.esc(I18n.t('groups')) + '</span><span class="ov-count">' + groups.length + '</span></div>' +
      '<div class="ov-items"></div><div class="ov-hint">' + hint('ok', I18n.t('open')) + hint('left', I18n.t('main_menu')) + hint('right', I18n.t('close')) + '</div></div>';
    overlay.onclick = null;
    ovList = new VList(overlay.querySelector('.ov-items'), {
      rowHeight: 6.4, itemClass: 'g-item', render: Live.renderGroup,
      onSelect: function (g) { openGroup(g); }
    });
    ovList.setItems(groups, idx);
    ovList.setActive(true);
    idle();
  }

  function openGroup(g) {
    if (!g) return;
    App.checkLock(g.id).then(function (ok) {
      if (!ok) return;
      var list = Data.liveList(g.id);
      if (!list.length) { U.toast(I18n.t('no_items')); return; }
      showList({ gid: g.id, name: g.name, list: list });
    });
  }

  /* ---------- overlay: programme of a channel ---------- */
  function renderProg(p, i) {
    var now = Date.now();
    var isNow = p.s <= now && p.e > now;
    var prev = ovList && ovList.items[i - 1];
    var newDay = !prev || U.dayKey(prev.s) !== U.dayKey(p.s);
    var arch = p.e <= now && Data.canCatchup(epgCh, p) && p.a !== false;
    var playing = cur && cur.type === 'catchup' && cur.ch === epgCh && cur.prog.s === p.s;
    return '<div class="p-row' + (isNow ? ' now' : '') + (p.s > now ? ' future' : '') + (playing ? ' playing' : '') + '">' +
      '<span class="p-day">' + (newDay ? U.esc(U.dayLabel(p.s)) : '') + '</span>' +
      '<span class="p-time">' + U.hhmm(p.s) + '</span>' +
      '<span class="p-title">' + (playing ? '<i class="eq"></i>' : '') + U.esc(p.t) + '</span>' +
      (arch ? U.icon('archive', 'arch') : '') + (p.s > now && Reminders.has(epgCh, p) ? U.icon('bell', 'bell') : '') + (isNow ? '<span class="badge live">' + I18n.t('live_badge') + '</span>' : '') + '</div>';
  }

  function paintProgDesc() {
    var box = overlay.querySelector('.ov-pdesc');
    var p = ovList && ovList.current();
    if (!box) return;
    box.innerHTML = p
      ? '<div class="pd-time">' + U.esc(U.dayLabel(p.s)) + ', ' + U.hhmm(p.s) + '–' + U.hhmm(p.e) + '</div><div class="pd-title">' + U.esc(p.t) + '</div>' +
        (p.d ? '<div class="pd-text">' + U.esc(p.d) + '</div>' : '')
      : '';
  }

  function progIndex(list, ch) {
    var t = cur.type === 'catchup' && cur.ch === ch ? cur.prog.s + 1000 : Date.now();
    var i = Epg.indexAt(list, t);
    if (i < 0) {
      for (var j = 0; j < list.length; j++) if (list[j].s > t) return j;
      return Math.max(0, list.length - 1);
    }
    return i;
  }

  function showEpg(ch, from) {
    ch = ch || cur.ch;
    if (!ch) return;
    epgCh = ch; epgFrom = from || null;
    Epg.ensure(ch);
    var list = Epg.get(ch) || [];
    setOv('epg');
    overlay.classList.remove('hidden');
    overlay.innerHTML = '<div class="ov-epg"><div class="ov-title"><span class="ov-logo">' + U.imgTag(ch.logo, 'logo', ch.name) + '</span>' +
      '<span class="ov-tn">' + (ch.num ? ch.num + '. ' : '') + U.esc(ch.name) + '</span></div>' +
      '<div class="ov-pdesc"></div><div class="ov-items"></div>' +
      '<div class="ov-hint">' + hint('ok', I18n.t('play')) + hint('left', I18n.t(from === 'list' ? 'back' : 'close')) + '</div></div>';
    overlay.onclick = null;
    ovList = new VList(overlay.querySelector('.ov-items'), {
      rowHeight: 5.4, itemClass: 'pr-row', margin: 2, render: renderProg, emptyText: I18n.t('no_epg'),
      onFocus: paintProgDesc,
      onSelect: function (p) { pickProg(p); }
    });
    ovList.setItems(list, progIndex(list, ch));
    ovList.setActive(true);
    paintProgDesc();
    idle();
  }

  /* leave full screen and put the focus on the app's side menu; the channel keeps playing and Back returns to it */
  function toMainMenu() {
    hideOverlay();
    if (cur && cur.type === 'live') Player.exitFull(); else setMode('bg');
    fromMenu = !!cur;
    App.focusSidebar();
  }

  /* the Live screen's preview box is on screen (other screens: the player goes to the background) */
  function previewShown() { return !!(previewEl && previewEl.offsetParent); }

  function epgBack() {
    if (epgFrom === 'list' && browse) {
      var i = browse.list.indexOf(epgCh);
      showList({ gid: browse.gid, name: browse.name, list: browse.list, index: i < 0 ? 0 : i });
    } else hideOverlay();
  }

  /* where a channel sits, so channel up/down keep working after a pick */
  function contextFor(ch) {
    if (cur && cur.list && cur.list.indexOf(ch) >= 0) return { list: cur.list, index: cur.list.indexOf(ch), listName: cur.listName, gid: cur.gid };
    if (browse && browse.list.indexOf(ch) >= 0) return { list: browse.list, index: browse.list.indexOf(ch), listName: browse.name, gid: browse.gid };
    var all = Data.liveList('__all');
    return { list: all, index: Math.max(0, all.indexOf(ch)), listName: I18n.t('all_channels'), gid: '__all' };
  }

  /* OK on the programme that is on air now: from its start (archive) or live.
     Resolves 'start' | 'live', or null when the menu was closed. Channels without archive: 'live'. */
  function askOnAir(ch, p) {
    var now = Date.now();
    if (!p || p.s > now || p.e <= now || !Data.canCatchup(ch, p) || p.a === false) return Promise.resolve('live');
    return Modal.menu(p.t || ch.name, [
      { label: I18n.t('play_from_start'), icon: 'rewind', value: 'start' },
      { label: I18n.t('back_to_live'), icon: 'live', value: 'live' }
    ]).then(function (v) { return v === 'start' || v === 'live' ? v : null; });
  }

  function pickProg(p) {
    var ch = epgCh, now = Date.now();
    if (!ch || !p) return;
    if (p.s > now) { Reminders.toggle(ch, p); if (ovList) ovList.refresh(); return; }
    if (p.e <= now && !(Data.canCatchup(ch, p) && p.a !== false)) { U.toast(I18n.t('no_archive')); return; }
    App.checkLock(ch.group).then(function (ok) {
      if (!ok) return null;
      return p.e > now ? askOnAir(ch, p) : 'archive';
    }).then(function (how) {
      if (!how) return;   // locked, or the menu was closed: the panel stays open
      hideOverlay();
      var o = contextFor(ch);
      if (how === 'live') {
        if (cur.type === 'live' && cur.ch === ch) { showInfo(); return; }
        o.keepMode = true;
        Player.playLive(ch, o);
      } else {
        Player.playCatchup(ch, p, o);   // 'start' or an archived programme: from its beginning
      }
      if (Player.onChannelChange) Player.onChannelChange(ch, o.index, o.gid);
    });
  }

  function groupName(gid) {
    var gs = Data.liveGroups();
    for (var i = 0; i < gs.length; i++) if (gs[i].id === gid) return gs[i].name;
    return I18n.t('all_channels');
  }

  /* channel up / down: inside the current group, all channels or favourites (setting) */
  function step(dir) {
    if (!cur || !cur.ch) return;
    lastDir = dir < 0 ? -1 : 1;
    var sc = Store.get('chScope'), list, gid, name;
    if (sc === 'all' || sc === 'fav') {
      gid = sc === 'fav' ? '__fav' : '__all';
      list = Data.liveList(gid);
      if (!list.length) { gid = '__all'; list = Data.liveList(gid); }
      name = groupName(gid);
    } else {
      list = cur.list || Data.liveList('__all');
      gid = cur.gid || (cur.list ? '' : '__all');
      name = cur.listName || I18n.t('all_channels');
    }
    if (!list.length) return;
    var i = list.indexOf(cur.ch);
    if (i < 0) i = cur.list === list ? (cur.index || 0) : (lastDir > 0 ? -1 : 0);
    var n = (i + lastDir + list.length) % list.length;
    playIn(list, n, name, gid);
  }

  /* previously watched channel (recall) */
  function lastChannel() {
    var keys = Store.list('recent');
    for (var i = 0; i < keys.length; i++) {
      var ch = Data.channel(keys[i]);
      if (ch && ch !== cur.ch) {
        var o = contextFor(ch);
        playIn(o.list, o.index, o.listName, o.gid);
        return;
      }
    }
  }

  /* ---------- archive from the live picture ---------- */
  /* back = seconds behind live, or null for the start of the programme */
  function timeshift(back) {
    var ch = cur.ch, now = Date.now();
    if (!ch || !ch.catchup) { U.toast(I18n.t('no_archive')); return; }
    var nn = Epg.nowNext(ch);
    var prog = nn.cur;
    if (!prog || !Data.canCatchup(ch, prog)) {
      if (back == null) { U.toast(I18n.t('no_epg')); return; }
      // no guide for this channel: a window from two hours ago
      var s = Math.floor((now - 7200000) / 60000) * 60000;
      prog = { s: s, e: s + 3 * 3600000, t: ch.name, d: '' };
    }
    var o = contextFor(ch);
    o.startAt = back == null ? 0 : Math.max(0, (now - prog.s) / 1000 - back);
    Player.playCatchup(ch, prog, o);
  }

  function goLive() {
    if (!cur || !cur.ch) return;
    Player.playLive(cur.ch, { list: cur.list, index: cur.index, listName: cur.listName, gid: cur.gid, full: true });
  }

  function runAction(a) {
    if (!cur) return;
    switch (a) {
      case 'list': showList(); break;
      case 'groups': browse = null; showGroups(); break;
      case 'epg': showEpg(cur.ch); break;
      case 'next': step(1); break;
      case 'prev': step(-1); break;
      case 'last': lastChannel(); break;
      case 'fav':
        if (cur.ch) {
          var added = Store.toggleFav('live', cur.ch.key);
          U.toast(I18n.t(added ? 'fav_added' : 'fav_removed'));
          showInfo();
        }
        break;
      case 'info': if (ovState === 'info') hideOverlay(); else showInfo(); break;
      case 'audio': audioMenu(); break;
      case 'subs': subsMenu(); break;
      case 'aspect': aspectMenu(); break;
      case 'rewind':
        if (cur.type === 'live') timeshift(30); else seek(-1);
        break;
      case 'restart':
        if (cur.type === 'live') timeshift(null);
        else { video.currentTime = 0; showInfo(); }
        break;
      case 'guide': Player.exitFull(); App.show('guide'); break;
      case 'golive': goLive(); break;
    }
  }

  /* long OK / Menu in fullscreen: everything the colour buttons do, for remotes that only have arrows and OK */
  function playerMenu() {
    if (!cur) return;
    var acts = cur.type === 'live'
      ? ['list', 'groups', 'epg', 'fav', 'last', 'audio', 'subs', 'aspect', 'rewind', 'restart', 'guide']
      : ['audio', 'subs', 'aspect', 'restart'];
    if (cur.type === 'catchup') acts = ['golive', 'epg', 'list'].concat(acts);
    if (!cur.ch || !cur.ch.catchup) acts = acts.filter(function (a) { return cur.type !== 'live' || (a !== 'rewind' && a !== 'restart'); });
    var icons = { list: 'list', groups: 'folder', epg: 'archive', fav: 'star', last: 'left', guide: 'guide', rewind: 'rewind', restart: 'rewind', golive: 'live', audio: 'play', subs: 'list', aspect: 'tv' };
    var items = acts.map(function (a) {
      var label = a === 'golive' ? I18n.t('back_to_live') : actLabel(a);
      if (a === 'fav' && cur.ch && Store.isFav('live', cur.ch.key)) label += ' ★';
      return { label: label, icon: icons[a] || '', value: a };
    });
    hideOverlay();
    Modal.menu(cur.ch ? cur.ch.name : '', items).then(function (a) { if (a) runAction(a); });
  }

  /* keys while a list / programme panel is open */
  function overlayKey(k) {
    if (!ovList) return false;
    idle();
    switch (k) {
      case K.UP: ovList.move(-1); return true;
      case K.DOWN: ovList.move(1); return true;
      case K.CH_UP: ovList.page(-1); return true;
      case K.CH_DOWN: ovList.page(1); return true;
    }
    if (ovState === 'list') {
      switch (k) {
        case K.ENTER: pickChannel(ovList.index); return true;
        case K.LEFT: showGroups(); return true;
        case K.RIGHT: hideOverlay(); return true;
        case K.GREEN: showEpg(ovList.current(), 'list'); return true;
        case K.RED: {
          var c = ovList.current();
          if (c) { U.toast(I18n.t(Store.toggleFav('live', c.key) ? 'fav_added' : 'fav_removed')); ovList.refresh(); }
          return true;
        }
        case K.BACK: case K.ESC: hideOverlay(); return true;
      }
      return true;
    }
    if (ovState === 'groups') {
      switch (k) {
        case K.ENTER: openGroup(ovList.current()); return true;
        case K.RIGHT: case K.BACK: case K.ESC: hideOverlay(); return true;
        case K.LEFT: toMainMenu(); return true;
      }
      return true;
    }
    if (ovState === 'epg') {
      switch (k) {
        case K.ENTER: pickProg(ovList.current()); return true;
        case K.LEFT: case K.BACK: case K.ESC: epgBack(); return true;
      }
      return true;
    }
    return false;
  }

  /* the guide arrived / changed while a panel is open */
  function onEpgUpdate() {
    if (!ovList) { if (ovState === 'info' && cur && cur.type === 'live') showInfo(true); return; }
    if (ovState === 'epg' && epgCh) {
      var list = Epg.get(epgCh) || [];
      if (list !== ovList.items) {
        var p = ovList.current();
        var i = p ? Epg.indexAt(list, p.s + 1000) : -1;
        ovList.setItems(list, i >= 0 ? i : progIndex(list, epgCh));
        paintProgDesc();
      } else ovList.refresh();
    } else if (ovState === 'list') ovList.refresh();
  }

  /* ---------- tracks ---------- */

  function audioMenu() {
    if (hls && cur && cur.ch) {
      // hls.js plays only the stream's first audio: this channel switches to the TV's player, which lists them all
      var m = Store.map('chnative');
      m[cur.ch.key] = 1;
      Store.setMap('chnative', m);
      cur.native = true;
      U.toast(I18n.t('audio_tv_player'));
      load(cur.url);
      return;
    }
    var tracks = video.audioTracks;
    if (!tracks || tracks.length < 2) { U.toast(I18n.t('audio_track') + ': 1'); return; }
    var items = [];
    for (var i = 0; i < tracks.length; i++) {
      var t = tracks[i];
      items.push({ label: (t.label || t.language || ('#' + (i + 1))) + (t.language && t.label ? ' (' + t.language + ')' : ''), value: i, icon: t.enabled ? 'play' : '' });
    }
    Modal.menu(I18n.t('audio_track'), items).then(function (v) {
      if (v == null) return;
      for (var j = 0; j < tracks.length; j++) tracks[j].enabled = j === v;
      if (cur && cur.ch) {
        var m = Store.map('chaudio');
        m[cur.ch.key] = { lang: tracks[v].language || '', label: tracks[v].label || '', i: v };
        Store.setMap('chaudio', m);
      }
    });
  }

  /* re-select the audio track picked earlier on this channel */
  function applyAudio() {
    if (!cur || !cur.ch) return;
    var want = Store.map('chaudio')[cur.ch.key], tracks = video.audioTracks;
    if (!want || !tracks || tracks.length < 2) return;
    var hit = -1, j;
    for (j = 0; j < tracks.length && hit < 0; j++) if (want.lang && tracks[j].language === want.lang && tracks[j].label === want.label) hit = j;
    for (j = 0; j < tracks.length && hit < 0; j++) if (want.lang && tracks[j].language === want.lang) hit = j;
    if (hit < 0 && !want.lang && want.i < tracks.length) hit = want.i;
    if (hit < 0 || tracks[hit].enabled) return;
    for (j = 0; j < tracks.length; j++) tracks[j].enabled = j === hit;
  }

  function subsMenu() {
    var tt = video.textTracks;
    var items = [{ label: I18n.t('no_subtitles'), value: -1 }];
    for (var i = 0; tt && i < tt.length; i++) {
      if (tt[i].kind === 'subtitles' || tt[i].kind === 'captions') {
        items.push({ label: tt[i].label || tt[i].language || ('#' + (i + 1)), value: i, icon: tt[i].mode === 'showing' ? 'play' : '' });
      }
    }
    if (items.length < 2) { U.toast(I18n.t('subtitles') + ': —'); return; }
    Modal.menu(I18n.t('subtitles'), items).then(function (v) {
      if (v == null) return;
      for (var j = 0; j < tt.length; j++) tt[j].mode = j === v ? 'showing' : 'disabled';
    });
  }

  function aspectMenu() {
    var opts = ['contain', 'cover', 'fill'];
    var i = opts.indexOf(curAspect());
    var nx = opts[(i + 1) % opts.length];
    var perCh = !!(cur && cur.ch);
    if (perCh) {
      // remembered for this channel only
      var m = Store.map('chaspect');
      if (nx === (Store.get('aspect') || 'contain')) delete m[cur.ch.key]; else m[cur.ch.key] = nx;
      Store.setMap('chaspect', m);
    } else Store.set('aspect', nx);
    applyAspect();
    U.toast(I18n.t('aspect') + ': ' + I18n.t('aspect_' + nx) + (perCh ? ' (' + cur.ch.name + ')' : ''));
  }

  /* archive playback reached its end */
  function catchupEnded() {
    var c = cur, now = Date.now();
    // programme still on air: the server only had it up to the moment we opened it — fetch the newer part
    if (c.prog.e > now - 60000 && video.currentTime > 5 && (c.reopened || 0) < 500) {
      c.reopened = (c.reopened || 0) + 1;
      load(c.url, video.currentTime);
      return;
    }
    // otherwise continue with the next programme (archive, or live once we have caught up)
    var list = Epg.get(c.ch) || [];
    var i = Epg.indexAt(list, c.prog.s + 1000);
    var nx = i >= 0 ? list[i + 1] : null;
    var opts = { list: c.list, index: c.index, listName: c.listName, gid: c.gid };
    if (nx && Data.canCatchup(c.ch, nx)) Player.playCatchup(c.ch, nx, opts);
    else { opts.full = true; Player.playLive(c.ch, opts); }
  }

  function seek(dir) {
    var d = video.duration;
    if (!isFinite(d) || !d) {
      var s = video.seekable;
      d = s && s.length ? s.end(s.length - 1) : 0;
    }
    if (!d) return;
    seekAcc = Math.min(seekAcc + 1, 30);
    var step = seekAcc < 4 ? 10 : (seekAcc < 10 ? 30 : 60);
    if (seekTarget == null) seekTarget = video.currentTime;
    seekTarget = U.clamp(seekTarget + dir * step, 0, d - 1);
    showInfo(true);
    clearTimeout(seekTimer);
    seekTimer = setTimeout(function () {
      video.currentTime = seekTarget;
      seekTarget = null;
      seekAcc = 0;
      autoHide(3000);
    }, 600);
  }

  function togglePause() {
    if (video.paused) video.play(); else video.pause();
    showInfo(video.paused);
  }

  var Player = {
    init: init,
    current: function () { return cur; },
    mode: function () { return mode; },
    video: function () { return video; },
    applyAspect: applyAspect,

    setPreviewEl: function (el) { previewEl = el; if (mode === 'preview') placePreview(); },

    playLive: function (ch, opts) {
      opts = opts || {};
      pausedAt = 0;
      cur = { type: 'live', ch: ch, list: opts.list || null, index: opts.index || 0, listName: opts.listName || '', gid: opts.gid || '' };
      triedAlt = false; retries = 0; quick = false;
      applyAspect();
      var url = Data.liveUrl(ch);
      if (warmUrl && warmUrl === url) {
        // already started at boot: keep it running
        cur.url = url;
        warmUrl = null;
        if (video.readyState < 3) setBusy(true);
        var pp = video.play();
        if (pp && pp['catch']) pp['catch'](function () {});
      } else {
        warmUrl = null;
        load(url);
      }
      Store.setLastPlay({ key: ch.key, url: url, group: ch.group });
      if (!opts.browse) Store.pushRecent(ch.key);   // channels only passed by in the list are not "recent"
      Store.setLastChannel(ch.key);
      Epg.ensure(ch);
      if (!opts.keepMode) setMode(opts.full ? 'full' : 'preview');
      if (mode === 'full') showInfo();
    },

    askOnAir: askOnAir,

    playCatchup: function (ch, prog, opts) {
      opts = opts || {};
      var url = Data.catchupUrl(ch, prog);
      if (!url) { U.toast(I18n.t('no_archive')); return; }
      cur = { type: 'catchup', ch: ch, prog: prog, list: opts.list || null, index: opts.index || 0, listName: opts.listName || '', gid: opts.gid || '' };
      triedAlt = false; retries = 0; quick = false;
      applyAspect();
      load(url, opts.startAt || 0);
      // the next start opens this channel (live), and offers to continue the archive from here
      Store.setLastPlay({ key: ch.key, url: Data.liveUrl(ch), group: ch.group });
      Store.setLastChannel(ch.key);
      Epg.ensure(ch);
      setMode('full');
      showInfo();
    },

    full: function () {
      if (!cur) return;
      setMode('full');
      showInfo();
    },

    preview: function () { setMode(cur && cur.type === 'live' ? 'preview' : 'hidden'); },

    /* another screen is opened: the channel goes on playing behind it (stopped only by playing something else) */
    background: function () { if (cur && mode !== 'full') setMode('bg'); },

    /* Back on the menu or a screen: return to the full-screen picture of what plays behind it.
       True when it did (the menu was opened from full screen, or the player is in the background). */
    backToChannel: function () {
      if (!cur || !(fromMenu || mode === 'bg')) return false;
      if (cur.type === 'live') App.show('live');   // Back from full screen then lands on the Live screen as usual
      Player.full();
      return true;
    },

    /* boot: start the last channel's stream at once, before the playlist and the screens are ready */
    warm: function (url) {
      if (!url || cur) return;
      warmUrl = url;
      var lp = Store.lastPlay();
      attach(url, hlsWanted(url, lp && lp.key));
      var p = video.play();
      if (p && p['catch']) p['catch'](function () {});
    },
    /* the boot stream was not taken over by playLive (channel gone, locked …) */
    dropWarm: function () {
      if (!warmUrl) return;
      warmUrl = null;
      if (!cur) { dropHls(); video.pause(); video.removeAttribute('src'); try { video.load(); } catch (e) { /* ignore */ } setBusy(false); }
    },

    stop: function () {
      netWait = null;
      warmUrl = null;
      clearTimeout(stallTimer);
      cur = null;
      dropHls();
      video.pause();
      video.removeAttribute('src');
      try { video.load(); } catch (e) { /* ignore */ }
      setBusy(false);
      hideMsg();
      setMode('hidden');
    },

    /* app goes to background / comes back */
    suspend: function () {
      if (!cur) return;
      Player._resume = { pos: video.currentTime };
      video.pause();
      if (cur.type === 'live') { dropHls(); video.removeAttribute('src'); try { video.load(); } catch (e) { /* ignore */ } }
    },
    resume: function () {
      if (!cur || !Player._resume) return;
      var p = Player._resume.pos;
      Player._resume = null;
      if (cur.type === 'live') load(cur.url);
      else load(cur.url, p);
    },

    refreshInfo: function () { if (ovState === 'info' && cur && cur.type === 'live') showInfo(true); },

    ACTIONS: ACTIONS,
    BUTTONS: BUTTONS.map(function (b) { return b[0]; }),
    actionLabel: actLabel,

    /* key handling while fullscreen */
    handleKey: function (e) {
      if (mode !== 'full' || !cur) return false;
      var k = e.keyCode;

      if (ovList && (ovState === 'list' || ovState === 'groups' || ovState === 'epg')) return overlayKey(k === K.LONG_OK ? K.ENTER : k);

      if (k === K.INFO) { runAction('info'); return true; }
      if (k === K.LONG_OK) { playerMenu(); return true; }
      if (k === K.GUIDE) { runAction('guide'); return true; }
      var btn = buttonName(k);

      if (cur.type === 'live') {
        if (btn) { runAction(mapped(btn)); return true; }
        switch (k) {
          case K.RW: runAction('rewind'); return true;
          case K.PAUSE: case K.PLAYPAUSE: case K.PLAY:
            // pause live; on resume continue from the archive where it stopped
            if (!video.paused) {
              if (k === K.PLAY) return true;
              video.pause(); pausedAt = Date.now(); showInfo(true);
            } else if (pausedAt && cur.ch.catchup && Date.now() - pausedAt > 5000) {
              timeshift((Date.now() - pausedAt) / 1000 + 5);
            } else { video.play(); showInfo(); }
            return true;
          case K.BACK: case K.ESC:
            if (ovState === 'info') { hideOverlay(); return true; }
            Player.exitFull();
            return true;
        }
        return false;
      }

      // archive: arrows seek, OK pauses
      switch (k) {
        case K.LEFT: case K.RW: seek(-1); return true;
        case K.FF:
          // archive of a programme still on air: fast-forward jumps back to live
          if (cur.type === 'catchup' && cur.prog.e > Date.now()) { goLive(); return true; }
          seek(1); return true;
        case K.RIGHT: seek(1); return true;
        case K.ENTER: case K.PLAYPAUSE: togglePause(); return true;
        case K.PLAY: video.play(); showInfo(); return true;
        case K.PAUSE: video.pause(); showInfo(true); return true;
        case K.STOP: Player.exitFull(); return true;
        case K.BACK: case K.ESC:
          if (ovState === 'info' && !video.paused) { hideOverlay(); return true; }
          // archive (on air or an earlier programme): back to the channel's live picture
          if (cur.type === 'catchup') { goLive(); return true; }
          Player.exitFull();
          return true;
      }
      if (cur.type === 'catchup') {
        // ⬆ the channel's programme, ⬇ the channel list (⬅ there: groups, then the main menu)
        if (k === K.UP) { showEpg(cur.ch); return true; }
        if (k === K.DOWN) { showList(); return true; }
        if (btn) { runAction(mapped(btn)); return true; }
      }
      return false;
    },

    exitFull: function () {
      if (cur && cur.type !== 'live') {
        Player.stop();
        if (Player.onExit) Player.onExit();
        return;
      }
      setMode(previewShown() ? 'preview' : 'bg');
      if (Player.onExit) Player.onExit();
    },

    channelKeyJump: function (ch) {
      if (!cur) return;
      if (ovList) hideOverlay();
      var o = contextFor(ch);
      playIn(o.list, o.index, o.listName, o.gid);
    }
  };

  window.Player = Player;
})();
