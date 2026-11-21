/* Settings: playlists, preferences, parental PIN. */
(function () {
  'use strict';
  var K = U.KEY;
  var el, listEl, rows = [], idx = 0;

  function onOff(v) { return I18n.t(v ? 'on' : 'off'); }

  var TZ_LIST = [-720, -660, -600, -570, -540, -480, -420, -360, -300, -240, -210, -180, -120, -60, 0, 60, 120, 180, 210, 240, 270, 300, 330, 345, 360, 390, 420, 480, 525, 540, 570, 600, 630, 660, 720, 765, 780, 840];
  var COLOUR = { red: 1, green: 1, yellow: 1, blue: 1 };

  function tzOpts() {
    var o = [{ v: 'auto', l: I18n.t('tz_auto') + ' (' + U.fmtOffset(-new Date().getTimezoneOffset()) + ')' }];
    var c = Store.get('tzNet');
    o.push({ v: 'net', l: I18n.t('tz_net') + (c ? ' (' + (c.name ? c.name + ', ' : '') + U.fmtOffset(c.off) + ')' : '') });
    TZ_LIST.forEach(function (m) { o.push({ v: m, l: U.fmtOffset(m) }); });
    return o;
  }

  function epgText(st) {
    st = st || Epg.status();
    switch (st.state) {
      case 'loading':
        return I18n.t('loading') + ' ' + (st.pct || 0) + '%' + (st.bytes ? ' (' + Math.round(st.bytes / 1048576) + ' ' + I18n.t('mb') + ')' : '');
      case 'ready':
        return (st.time ? I18n.t('epg_updated') + ' ' + U.dateTime(st.time) : '') +
          (st.n ? ' • ' + st.n + ' ' + I18n.t('epg_progs') : '') +
          (st.err ? ' • ' + I18n.t('epg_failed') + ': ' + st.err : '');
      case 'error': return I18n.t('epg_failed') + (st.err ? ': ' + st.err : '');
      case 'api': return 'Xtream API';
      default: return I18n.t('epg_none');
    }
  }

  function defs() {
    var out = [];
    out.push({ h: I18n.t('playlists') });
    var active = Store.active();
    Store.playlists().forEach(function (p) {
      out.push({
        type: 'playlist', pl: p,
        label: p.name || p.url || p.server,
        value: (p.type === 'xtream' ? 'Xtream' : 'M3U') + (active && active.id === p.id ? ' • ' + I18n.t('active') : ''),
        on: active && active.id === p.id
      });
    });
    out.push({ type: 'action', id: 'add', label: '+ ' + I18n.t('add_playlist') });
    out.push({ type: 'action', id: 'lan', label: '+ ' + I18n.t('lan_setup') });

    out.push({ h: I18n.t('yt_channels') });
    YtChannels.list().forEach(function (c) {
      var n = YtChannels.count(c.id);
      var err = YtChannels.error(c.id);
      out.push({ type: 'ytch', ch: c, label: c.name || c.id, value: (err ? '⚠ ' + I18n.t('yt_error') + ' • ' : '') + (c.kind === 'playlist' ? 'Playlist • ' : '') + n + ' ' + I18n.t('yt_videos') });
    });
    out.push({ type: 'action', id: 'yt_add', label: '+ ' + I18n.t('yt_add') });
    out.push({ type: 'action', id: 'yt_phone', label: '+ ' + I18n.t('yt_phone') });
    if (YtChannels.list().length) out.push({ type: 'action', id: 'yt_refresh', label: I18n.t('yt_refresh_all') });
    var key = Store.get('ytApiKey') || '';
    out.push({ type: 'action', id: 'yt_key', label: I18n.t('yt_api_key'), value: key ? key.slice(0, 4) + '…' + key.slice(-4) : I18n.t('yt_key_none') });
    if (key) {
      out.push({ type: 'choice', key: 'ytMinMin', label: I18n.t('yt_min_len'), opts: [0, 10, 20, 40, 60].map(function (m) { return { v: m, l: m ? m + ' ' + I18n.t('yt_min_unit') : I18n.t('yt_min_any') }; }) });
    }
    out.push({ type: 'choice', key: 'ytQuality', label: I18n.t('yt_quality'), opts: [{ v: 2160, l: I18n.t('yt_q_best') }, { v: 1080, l: '1080p' }, { v: 720, l: '720p' }, { v: 0, l: I18n.t('yt_q_auto') }] });
    out.push({ type: 'info', cls: 'hint', label: I18n.t('yt_api_hint'), value: '' });

    out.push({ h: I18n.t('general') });
    out.push({ type: 'choice', key: 'lang', label: I18n.t('language'), opts: I18n.langs.map(function (l) { return { v: l.id, l: l.name }; }) });
    out.push({ type: 'choice', key: 'chOk', label: I18n.t('ok_fullscreen'), opts: [{ v: 'preview', l: I18n.t('ok_preview') }, { v: 'full', l: I18n.t('ok_full') }, { v: 'auto', l: I18n.t('ok_auto') }] });
    out.push({ type: 'choice', key: 'autoplay', label: I18n.t('autoplay'), opts: [{ v: true, l: onOff(true) }, { v: false, l: onOff(false) }] });

    out.push({ h: I18n.t('time_section') });
    out.push({ type: 'choice', key: 'clock', label: I18n.t('clock'), opts: [{ v: true, l: onOff(true) }, { v: false, l: onOff(false) }] });
    out.push({ type: 'choice', key: 'tz', label: I18n.t('tz'), opts: tzOpts() });

    out.push({ h: I18n.t('playback') });
    out.push({ type: 'choice', key: 'streamFormat', label: I18n.t('stream_format'), opts: [{ v: 'm3u8', l: 'HLS (.m3u8)' }, { v: 'ts', l: 'MPEG-TS (.ts)' }] });
    out.push({ type: 'choice', key: 'chScope', label: I18n.t('ch_scope'), opts: [{ v: 'group', l: I18n.t('scope_group') }, { v: 'all', l: I18n.t('scope_all') }, { v: 'fav', l: I18n.t('scope_fav') }] });
    out.push({ type: 'choice', key: 'failNext', label: I18n.t('fail_next'), opts: [{ v: true, l: onOff(true) }, { v: false, l: onOff(false) }] });
    out.push({ type: 'choice', key: 'aspect', label: I18n.t('aspect'), opts: ['contain', 'cover', 'fill'].map(function (a) { return { v: a, l: I18n.t('aspect_' + a) }; }) });

    out.push({ h: I18n.t('channels_section') });
    var nHidden = Data.hiddenChannels().length;
    out.push({ type: 'action', id: 'ch_hidden', label: I18n.t('ch_hidden'), value: nHidden ? String(nHidden) : '' });
    out.push({ type: 'action', id: 'ch_reset', label: I18n.t('ch_reset') });
    var nRem = Reminders.list().length;
    out.push({ type: 'action', id: 'reminders', label: I18n.t('reminders'), value: nRem ? String(nRem) : I18n.t('rem_none') });

    out.push({ h: I18n.t('guide') });
    var shifts = [];
    for (var s = -12; s <= 12; s++) shifts.push({ v: s, l: (s > 0 ? '+' : '') + s + ' ' + I18n.t('hours') });
    out.push({ type: 'choice', key: 'epgShift', label: I18n.t('epg_shift'), opts: shifts, reload: true });
    out.push({ type: 'choice', key: 'updateHours', label: I18n.t('update_interval'), opts: [0, 6, 12, 24, 48, 72].map(function (h) { return { v: h, l: h ? h + ' ' + I18n.t('hours') : I18n.t('on_start') }; }) });
    out.push({ type: 'action', id: 'refresh', label: I18n.t('refresh') + ' (' + I18n.t('playlists') + ' + EPG)' });
    out.push({ type: 'info', id: 'epg_status', label: I18n.t('epg_status'), value: epgText() });

    out.push({ h: I18n.t('remote_keys') });
    var acts = Player.ACTIONS.map(function (a) { return { v: a, l: Player.actionLabel(a) }; });
    Player.BUTTONS.forEach(function (b) {
      out.push({ type: 'choice', key: 'k_' + b, label: I18n.t('key_' + b), dot: COLOUR[b] ? b : '', opts: acts });
    });
    out.push({ type: 'action', id: 'keys_reset', label: I18n.t('keys_reset') });

    out.push({ h: I18n.t('parental') });
    var nLocked = Data.groupNames().filter(function (g) { return Store.isLocked(g); }).length;
    out.push({ type: 'action', id: 'pin_groups', label: I18n.t('pin_groups'), value: Store.get('pin') ? String(nLocked) : I18n.t('pin_none') });
    if (Store.get('pin')) {
      out.push({ type: 'action', id: 'pin_change', label: I18n.t('pin_change') });
      out.push({ type: 'action', id: 'pin_remove', label: I18n.t('pin_remove') });
    } else {
      out.push({ type: 'action', id: 'pin_set', label: I18n.t('pin_set'), value: I18n.t('pin_none') });
    }

    out.push({ h: I18n.t('options') });
    out.push({ type: 'action', id: 'clear_history', label: I18n.t('clear_history') });
    out.push({ type: 'action', id: 'clear_favorites', label: I18n.t('clear_favorites') });

    out.push({ h: I18n.t('about') });
    var info = Data.state.info;
    if (info && info.user_info) {
      var ui = info.user_info;
      var exp = ui.exp_date ? new Date(parseInt(ui.exp_date, 10) * 1000) : null;
      out.push({ type: 'info', label: I18n.t('account'), value: ui.username || '' });
      out.push({ type: 'info', label: I18n.t('status'), value: ui.status || '' });
      out.push({ type: 'info', label: I18n.t('expires'), value: exp ? exp.toLocaleDateString() : '∞' });
      out.push({ type: 'info', label: I18n.t('connections'), value: (ui.active_cons || 0) + ' / ' + (ui.max_connections || '?') });
    }
    out.push({ type: 'action', id: 'upd_check', label: 'Ekrani IPTV ' + I18n.t('version') + ' ' + Update.label(), value: I18n.t('upd_check') });
    var bt = App.bootTimes;
    if (bt.playing != null) {
      // where the last start-up spent its time: playlist ready / screens built / picture on
      var sec = function (v) { return v == null ? '–' : (v / 1000).toFixed(1); };
      out.push({ type: 'info', label: I18n.t('boot_time'), value: sec(bt.data) + ' / ' + sec(bt.ui) + ' / ' + sec(bt.playing) + ' ' + I18n.t('sec') });
    }
    return out;
  }

  function valueLabel(r) {
    if (r.type !== 'choice') return r.value || '';
    var v = Store.get(r.key);
    for (var i = 0; i < r.opts.length; i++) if (r.opts[i].v === v) return r.opts[i].l;
    return r.opts[0].l;
  }

  function render() {
    rows = defs();
    var h = '';
    rows.forEach(function (r, i) {
      if (r.h) { h += '<div class="s-head">' + U.esc(r.h) + '</div>'; return; }
      h += '<div class="s-row ' + r.type + (r.cls ? ' ' + r.cls : '') + (r.on ? ' on' : '') + '" data-i="' + i + '"' + (r.id ? ' data-id="' + r.id + '"' : '') + '><span class="s-label">' +
        (r.dot ? '<i class="dot ' + r.dot + '"></i>' : '') + U.esc(r.label) + '</span>' +
        '<span class="s-value">' + (r.type === 'choice' ? '<b>‹</b>' + U.esc(valueLabel(r)) + '<b>›</b>' : U.esc(valueLabel(r))) + '</span></div>';
    });
    listEl.innerHTML = h;
    if (!focusable(idx)) idx = next(-1, 1);
    paint();
  }

  function focusable(i) { var r = rows[i]; return r && !r.h && r.type !== 'info'; }
  function next(from, dir) {
    for (var i = from + dir; i >= 0 && i < rows.length; i += dir) if (focusable(i)) return i;
    return from;
  }

  var active = false;
  function paint() {
    var els = listEl.querySelectorAll('.s-row');
    for (var i = 0; i < els.length; i++) {
      var on = +els[i].getAttribute('data-i') === idx;
      els[i].classList.toggle('focused', on && active);
      if (on && active && els[i].scrollIntoView) els[i].scrollIntoView({ block: 'nearest' });
    }
  }

  function change(dir) {
    var r = rows[idx];
    if (!r || r.type !== 'choice') return;
    var v = Store.get(r.key), i = 0;
    r.opts.forEach(function (o, k) { if (o.v === v) i = k; });
    setChoice(r, r.opts[(i + dir + r.opts.length) % r.opts.length].v);
  }

  function hiddenMenu() {
    var list = Data.hiddenChannels();
    if (!list.length) { U.toast(I18n.t('ch_hidden_none')); return; }
    Modal.menu(I18n.t('ch_unhide'), list.map(function (c) { return { label: c.name + (c.group ? '  •  ' + c.group : ''), value: c.key }; })).then(function (key) {
      if (key == null) return;
      Data.setEdit(key, { hidden: false });
      render();
      hiddenMenu();
    });
  }

  function setChoice(r, nv) {
    Store.set(r.key, nv);
    if (r.key === 'tz' || r.key === 'clock') { App.applyTz(r.key === 'tz' && nv === 'net'); render(); return; }
    if (r.key === 'lang') { I18n.setLang(nv); App.rebuild(); return; }
    if (r.key === 'aspect') Player.applyAspect();
    if (r.key === 'ytMinMin') YtChannels.rebuild();
    render();
    if (r.reload) App.scheduleReload();
  }

  function activate() {
    var r = rows[idx];
    if (!r) return;
    if (r.type === 'choice') {
      if (r.opts.length <= 6) { change(1); return; }
      var cur = Store.get(r.key), start = 0;
      var items = r.opts.map(function (o, k) { if (o.v === cur) start = k; return { label: o.l, value: k }; });
      Modal.menu(r.label, items, start).then(function (k) { if (k != null && typeof k === 'number') setChoice(r, r.opts[k].v); });
      return;
    }
    if (r.type === 'playlist') { playlistMenu(r.pl); return; }
    if (r.type === 'ytch') { ytMenu(r.ch); return; }
    switch (r.id) {
      case 'add': App.editPlaylist(null).then(render); break;
      case 'refresh': App.reload(true); break;
      case 'lan': Lan.open(); break;
      case 'yt_add': ytAdd(''); break;
      case 'yt_refresh': {
        var bz = Modal.busy(I18n.t('yt_refreshing'));
        YtChannels.refresh(true).then(function () { bz.close(); render(); U.toast(I18n.t('yt_refreshed')); }, function () { bz.close(); render(); });
        break;
      }
      case 'yt_key': ytKey(); break;
      case 'yt_phone': ytPhone(); break;
      case 'reminders': Reminders.manage().then(render); break;
      case 'ch_hidden': hiddenMenu(); break;
      case 'ch_reset':
        Modal.confirm(I18n.t('ch_reset_q')).then(function (y) {
          if (!y) return;
          Data.resetEdits();
          render(); U.toast(I18n.t('done'));
        });
        break;
      case 'keys_reset':
        Player.BUTTONS.forEach(function (b) { Store.set('k_' + b, Store.def('k_' + b)); });
        render(); U.toast(I18n.t('done'));
        break;
      case 'pin_set': setPin().then(function (ok) { if (ok) groupsMenu(0); }); break;   // a new PIN: pick the groups to lock right away
      case 'pin_change': setPin(); break;
      case 'upd_check': Update.check(true); break;
      case 'pin_groups':
        if (!Store.get('pin')) setPin().then(function (ok) { if (ok) groupsMenu(0); });
        else App.askPin().then(function (ok) { if (ok) groupsMenu(0); });
        break;
      case 'pin_remove':
        App.askPin().then(function (ok) { if (ok) { Store.set('pin', ''); Store.setList('locked', []); render(); U.toast(I18n.t('done')); } });
        break;
      case 'clear_history':
        Modal.confirm(I18n.t('clear_history') + '?').then(function (y) { if (y) { Store.setList('recent', []); Store.setList('pos', []); U.toast(I18n.t('done')); } });
        break;
      case 'clear_favorites':
        Modal.confirm(I18n.t('clear_favorites') + '?').then(function (y) {
          if (y) { ['fav_live', 'fav_youtube', 'favmeta'].forEach(function (k) { Store.setList(k, []); }); U.toast(I18n.t('done')); }
        });
        break;
    }
  }

  /* resolves true when a new PIN was saved */
  function setPin() {
    var pre = Store.get('pin') ? App.askPin() : Promise.resolve(true);
    return pre.then(function (ok) {
      if (!ok) return false;
      return Modal.pin(I18n.t('pin_new')).then(function (a) {
        if (!a) return false;
        return Modal.pin(I18n.t('pin_repeat')).then(function (b) {
          if (!b) return false;
          if (a !== b) { U.toast(I18n.t('pin_mismatch')); return false; }
          Store.set('pin', a);
          U.toast(I18n.t('done'));
          render();
          return true;
        });
      });
    });
  }

  /* the playlist's groups (folders); OK puts a lock on a group or takes it off. The PIN was checked by the caller. */
  function groupsMenu(start) {
    var names = Data.groupNames();
    if (!names.length) { U.toast(I18n.t('pin_groups_none')); return; }
    var items = names.map(function (g, i) {
      var on = Store.isLocked(g);
      return { label: g, icon: on ? 'lock' : 'folder', hint: on ? I18n.t('locked') : '', value: i };
    });
    Modal.menu(I18n.t('pin_groups_title'), items, start).then(function (i) {
      if (i == null || typeof i !== 'number') { render(); return; }
      var g = names[i];
      var locked = App.setGroupLock(g, !Store.isLocked(g));
      U.toast(I18n.t(locked ? 'lock_group' : 'unlock_group') + ': ' + g);
      groupsMenu(i);
    });
  }

  /* ---- YouTube channels ---- */
  function ytAdd(prefill) {
    Modal.form(I18n.t('yt_add_title'), [
      { id: 'url', label: I18n.t('yt_input'), value: prefill, placeholder: 'https://www.youtube.com/@channel' }
    ], function (v) { return v.url ? null : I18n.t('fill_required'); }).then(function (v) {
      if (!v) return;
      var bz = Modal.busy(I18n.t('yt_adding'));
      YtChannels.add(v.url).then(function (c) {
        bz.close();
        render();
        U.toast(I18n.t('yt_added') + ': ' + c.name + ' (' + YtChannels.count(c.id) + ' ' + I18n.t('yt_videos') + ')', 4000);
      }, function (e) {
        bz.close();
        Modal.alert(I18n.t('yt_add'), U.esc(e.message || String(e))).then(function () { ytAdd(v.url); });
      });
    });
  }

  function ytMenu(c) {
    var list = YtChannels.list(), i = -1;
    list.forEach(function (x, j) { if (x.id === c.id) i = j; });
    var items = [];
    if (YtChannels.error(c.id)) items.push({ label: '⚠ ' + YtChannels.error(c.id), icon: 'bell', value: 'err' });
    items.push({ label: I18n.t('refresh'), icon: 'archive', value: 'refresh' });
    if (i > 0) items.push({ label: I18n.t('move_up'), icon: 'left', value: 'up' });
    if (i < list.length - 1) items.push({ label: I18n.t('move_down'), icon: 'right', value: 'down' });
    items.push({ label: I18n.t('delete'), icon: 'lock', value: 'delete', danger: true });
    Modal.menu(c.name || c.id, items).then(function (v) {
      if (v === 'err') {
        Modal.alert(c.name || c.id, U.esc(YtChannels.error(c.id)));
      } else if (v === 'refresh') {
        var bz = Modal.busy(I18n.t('yt_refreshing'));
        YtChannels.refresh(true).then(function () { bz.close(); render(); }, function () { bz.close(); render(); });
      } else if (v === 'up' || v === 'down') {
        YtChannels.move(c.id, v === 'up' ? -1 : 1);
        idx += v === 'up' ? -1 : 1;
        render();
      } else if (v === 'delete') {
        Modal.confirm(I18n.t('yt_remove_q') + '\n' + (c.name || c.id)).then(function (y) {
          if (!y) return;
          YtChannels.remove(c.id);
          render();
        });
      }
    });
  }

  function ytKey(prefill) {
    var old = Store.get('ytApiKey') || '';
    Modal.form(I18n.t('yt_api_key'), [
      { id: 'key', label: 'YouTube Data API v3 key', value: prefill != null ? prefill : old, placeholder: 'AIza…' }
    ], function (v) { v.key = String(v.key || '').replace(/\s+/g, ''); return !v.key || /^[\w-]{30,}$/.test(v.key) ? null : I18n.t('yt_bad_key'); }).then(function (v) {
      if (!v) return;
      var key = String(v.key || '').replace(/\s+/g, '');
      if (key === old && !YtChannels.list().some(function (c) { return YtChannels.error(c.id); })) return;
      saveKey(key).then(function (ok) { if (!ok) ytKey(key); });
    });
  }

  /* check the key with one API call before using it; resolves false when it does not work */
  function saveKey(key) {
    var old = Store.get('ytApiKey') || '';
    var check = key ? YtChannels.checkKey(key) : Promise.resolve(true);
    var bz = Modal.busy(I18n.t('yt_key_checking'));
    return check.then(function () {
      bz.close();
      Store.set('ytApiKey', key);
      render();
      if (key) U.toast(I18n.t('yt_key_ok'));
      if (!YtChannels.list().length) return true;
      if (key === old && !YtChannels.list().some(function (c) { return YtChannels.error(c.id); })) return true;
      var bz2 = Modal.busy(I18n.t('yt_refreshing'));
      return YtChannels.resetCache().then(function () { bz2.close(); render(); U.toast(I18n.t('yt_refreshed')); return true; },
        function () { bz2.close(); render(); return true; });
    }, function (e) {
      bz.close();
      return Modal.alert(I18n.t('yt_key_fail'), U.esc(e.message || String(e)) + '<br><br>' + U.esc(I18n.t('yt_key_retype'))).then(function () { return false; });
    });
  }

  /* key and channels typed on a phone (QR page served by the TV service) */
  function ytPhone() {
    if (!Lan.available()) { U.toast(I18n.t('lan_tv_only')); return; }
    Lan.session({ mode: 'yt', title: I18n.t('yt_phone') }).then(function (r) {
      var it = r && r.item;
      if (!it || it.type !== 'yt') return;
      var key = String(it.key || '').replace(/\s+/g, '');
      var lines = String(it.channels || '').split(/[\r\n,]+/).map(function (x) { return x.trim(); }).filter(Boolean).slice(0, 30);
      var step = key && key !== (Store.get('ytApiKey') || '') ? saveKey(key) : Promise.resolve(true);
      step.then(function (ok) {
        if (!ok || !lines.length) return;
        var added = [], failed = [];
        var bz = Modal.busy(I18n.t('yt_adding'));
        lines.reduce(function (p, line) {
          return p.then(function () {
            return YtChannels.add(line).then(function (c) { added.push(c.name + ' (' + YtChannels.count(c.id) + ')'); },
              function (e) { failed.push(line + ' — ' + (e.message || e)); });
          });
        }, Promise.resolve()).then(function () {
          bz.close();
          render();
          var msg = (added.length ? '<b>' + U.esc(I18n.t('yt_phone_done')) + '</b>' + U.esc(added.join(', ')) : '') +
            (failed.length ? (added.length ? '<br><br>' : '') + '<b>' + U.esc(I18n.t('yt_phone_fail')) + '</b><br>' + failed.map(function (x) { return U.esc(x); }).join('<br>') : '');
          Modal.alert(I18n.t('yt_channels'), msg);
        });
      });
    });
  }

  function playlistMenu(pl) {
    var isActive = Store.active() && Store.active().id === pl.id;
    var items = [];
    if (!isActive) items.push({ label: I18n.t('activate'), icon: 'play', value: 'activate' });
    items.push({ label: I18n.t('edit'), icon: 'settings', value: 'edit' });
    if (isActive) items.push({ label: I18n.t('refresh'), icon: 'archive', value: 'refresh' });
    items.push({ label: I18n.t('delete'), icon: 'lock', value: 'delete', danger: true });
    Modal.menu(pl.name, items).then(function (v) {
      if (v === 'activate') { Store.setActive(pl.id); App.reload(false); }
      else if (v === 'edit') App.editPlaylist(pl).then(function (saved) { render(); if (saved && isActive) App.reload(true); });
      else if (v === 'refresh') App.reload(true);
      else if (v === 'delete') {
        Modal.confirm(I18n.t('confirm_delete')).then(function (y) {
          if (!y) return;
          Store.deletePlaylist(pl.id);
          render();
          if (isActive) App.reload(false);
        });
      }
    });
  }

  window.Settings = {
    id: 'settings',
    get el() { return el; },
    build: function () {
      el = U.el('section', 'screen settings hidden');
      el.innerHTML = '<div class="s-title">' + I18n.t('settings') + '</div><div class="s-list"></div>';
      document.getElementById('screens').appendChild(el);
      listEl = el.querySelector('.s-list');
      Epg.onStatus(function (st) {
        var v = listEl.querySelector('[data-id="epg_status"] .s-value');
        if (v) v.textContent = epgText(st);
      });
      listEl.addEventListener('mousemove', function (e) {
        var r = e.target.closest ? e.target.closest('.s-row') : null;
        if (r) { var i = +r.getAttribute('data-i'); if (i !== idx && focusable(i)) { idx = i; active = true; paint(); } }
      });
      listEl.addEventListener('click', function (e) {
        var r = e.target.closest ? e.target.closest('.s-row') : null;
        if (!r) return;
        idx = +r.getAttribute('data-i');
        var b = e.target.closest('b');
        if (b && rows[idx].type === 'choice') { change(b.textContent === '‹' ? -1 : 1); return; }
        activate();
      });
    },
    reset: function () { idx = 0; },
    show: function () { el.classList.remove('hidden'); render(); },
    hide: function () { el.classList.add('hidden'); },
    focus: function () { active = true; paint(); },
    blur: function () { active = false; paint(); },
    key: function (e) {
      switch (e.keyCode) {
        case K.UP: idx = next(idx, -1); paint(); return true;
        case K.DOWN: idx = next(idx, 1); paint(); return true;
        case K.LEFT: if (rows[idx] && rows[idx].type === 'choice') { change(-1); return true; } return false;
        case K.RIGHT: change(1); return true;
        case K.ENTER: activate(); return true;
      }
      return false;
    },
    back: function () { return false; },
    refresh: function () { if (!el.classList.contains('hidden')) render(); }
  };
})();
