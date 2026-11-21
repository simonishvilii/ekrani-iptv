/* Live TV: groups | channels | preview + programme list. */
(function () {
  'use strict';
  var K = U.KEY;

  var el, groupsL, chL, progL, previewBox, infoBox, chTitle, progTitle;
  var zone = 1;          // 0 groups, 1 channels, 2 programmes
  var groups = [], groupId = '__all';
  var detailCh = null;
  var moving = null;     // channel being moved with ⬆⬇ (channel editor)

  function renderGroup(g) {
    return '<div class="g-row">' + (g.icon ? U.icon(g.icon) : (g.locked ? U.icon('lock') : '<span class="ico"></span>')) +
      '<span class="g-name">' + U.esc(g.name) + '</span><span class="g-count">' + (g.count || '') + '</span></div>';
  }

  function renderChannel(c) {
    Epg.ensure(c);   // Xtream: lazy per-channel EPG for visible rows (no-op otherwise)
    var nn = Epg.nowNext(c);
    var now = Date.now();
    var prog = '';
    if (nn.cur) {
      var pct = U.clamp((now - nn.cur.s) / (nn.cur.e - nn.cur.s) * 100, 0, 100);
      prog = '<div class="c-prog">' + U.esc(nn.cur.t) + '</div><div class="bar thin"><i style="width:' + pct + '%"></i></div>';
    }
    var playing = Player.current() && Player.current().ch === c;
    return (moving === c ? '<div class="c-moving"></div>' : '') + '<div class="c-num">' + (c.num || '') + '</div>' +
      '<div class="c-logo">' + U.imgTag(c.logo, 'logo', c.name) + '</div>' +
      '<div class="c-main"><div class="c-name">' + (playing ? '<i class="eq"></i>' : '') + U.esc(c.name) + '</div>' + prog + '</div>' +
      '<div class="c-badges">' + (Store.isFav('live', c.key) ? U.icon('star', 'fav') : '') + (c.catchup ? U.icon('archive') : '') + '</div>';
  }

  function renderProg(p, i) {
    var now = Date.now();
    var isNow = p.s <= now && p.e > now;
    var prev = progL && progL.items[i - 1];
    var newDay = !prev || U.dayKey(prev.s) !== U.dayKey(p.s);
    var arch = p.e <= now && Data.canCatchup(detailCh, p) && p.a !== false;
    return '<div class="p-row' + (isNow ? ' now' : '') + (p.s > now ? ' future' : '') + '">' +
      '<span class="p-day">' + (newDay ? U.esc(U.dayLabel(p.s)) : '') + '</span>' +
      '<span class="p-time">' + U.hhmm(p.s) + '</span>' +
      '<span class="p-title">' + U.esc(p.t) + '</span>' +
      (arch ? U.icon('archive', 'arch') : '') + (p.s > now && Reminders.has(detailCh, p) ? U.icon('bell', 'bell') : '') + (isNow ? '<span class="badge live">' + I18n.t('live_badge') + '</span>' : '') + '</div>';
  }

  function build() {
    el = U.el('section', 'screen live hidden');
    el.innerHTML =
      '<div class="col col-groups"><div class="col-title">' + I18n.t('groups') + '</div><div class="list groups"></div></div>' +
      '<div class="col col-channels"><div class="col-title"><span class="ct-name"></span><span class="ct-count"></span></div><div class="list channels"></div></div>' +
      '<div class="col col-detail">' +
      '  <div class="preview-box"><div class="preview-ph">' + U.icon('tv') + '</div></div>' +
      '  <div class="d-info"></div>' +
      '  <div class="col-title small p-title-row"></div>' +
      '  <div class="list progs"></div>' +
      '</div>';
    document.getElementById('screens').appendChild(el);

    previewBox = el.querySelector('.preview-box');
    infoBox = el.querySelector('.d-info');
    chTitle = el.querySelector('.col-channels .col-title');
    progTitle = el.querySelector('.p-title-row');

    groupsL = new VList(el.querySelector('.groups'), {
      rowHeight: 6.4, itemClass: 'g-item', render: renderGroup,
      onFocus: U.debounce(function (g) { openGroup(g, false); }, 250),
      onSelect: function (g) { openGroup(g, true); setZone(1); },
      onPointer: function () { setZone(0, true); }
    });
    chL = new VList(el.querySelector('.channels'), {
      rowHeight: 8.8, itemClass: 'ch-row', render: renderChannel, emptyText: I18n.t('no_items'),
      onFocus: function (c) { showDetailSoon(c); autoPreview(c); },
      onSelect: function (c) { okChannel(c); },
      onPointer: function () { setZone(1, true); }
    });
    progL = new VList(el.querySelector('.progs'), {
      rowHeight: 5.4, itemClass: 'pr-row', render: renderProg, margin: 2, emptyText: I18n.t('no_epg'),
      onSelect: function (p) { okProgramme(p); },
      onPointer: function () { setZone(2, true); }
    });

    Epg.onUpdate(U.debounce(function () {
      if (el.classList.contains('hidden')) return;
      chL.refresh();
      if (detailCh) showDetail(detailCh, true);
      Player.refreshInfo();
    }, 400));
    setInterval(function () {
      if (el.classList.contains('hidden')) return;
      chL.refresh();
      if (detailCh) paintInfo(detailCh);
    }, 30000);
  }

  function setZone(z, fromPointer) {
    zone = z;
    groupsL.setActive(z === 0);
    chL.setActive(z === 1);
    progL.setActive(z === 2);
    el.classList.toggle('zone-groups', z === 0);
    if (!fromPointer) App.focusContent();
  }

  function openGroup(g, explicit) {
    if (!g) return;
    if (g.locked && !App.lockOpen(g.id)) {
      if (!explicit) { chL.setItems([]); chTitle.querySelector('.ct-name').textContent = g.name; chTitle.querySelector('.ct-count').textContent = ''; return; }
      App.checkLock(g.id).then(function (ok) { if (ok) openGroup(g, true); });
      return;
    }
    if (groupId === g.id && chL.items.length && !explicit) return;
    groupId = g.id;
    var list = Data.liveList(g.id);
    chL.setItems(list, 0);
    chTitle.querySelector('.ct-name').textContent = g.name;
    chTitle.querySelector('.ct-count').textContent = list.length;
    if (list[0]) showDetail(list[0]);
  }

  function paintInfo(c) {
    var nn = Epg.nowNext(c);
    var now = Date.now();
    var h = '<div class="d-ch">' + U.imgTag(c.logo, 'logo', c.name) + '<div><div class="d-name">' + (c.num ? c.num + '. ' : '') + U.esc(c.name) + '</div>' +
      '<div class="d-group">' + U.esc(c.group) + (c.catchup ? ' • ' + U.icon('archive') + ' ' + I18n.t('archive') + ' ' + c.catchup.days + ' ' + I18n.t('days_short') : '') + '</div></div></div>';
    if (nn.cur) {
      var pct = U.clamp((now - nn.cur.s) / (nn.cur.e - nn.cur.s) * 100, 0, 100);
      h += '<div class="d-now"><span class="time">' + U.hhmm(nn.cur.s) + ' – ' + U.hhmm(nn.cur.e) + '</span><b>' + U.esc(nn.cur.t) + '</b></div>' +
        '<div class="bar"><i style="width:' + pct + '%"></i></div>' +
        (nn.cur.d ? '<div class="d-desc">' + U.esc(nn.cur.d) + '</div>' : '') +
        (nn.next ? '<div class="d-next">' + I18n.t('next') + ': <span class="time">' + U.hhmm(nn.next.s) + '</span> ' + U.esc(nn.next.t) + '</div>' : '');
    } else {
      h += '<div class="d-desc muted">' + I18n.t('hint_live') + '</div>';
    }
    infoBox.innerHTML = h;
  }

  function showDetail(c, keepProgIndex) {
    if (!c) return;
    var changed = detailCh !== c;
    detailCh = c;
    paintInfo(c);
    var list = Epg.get(c) || [];
    if (changed || !keepProgIndex || progL.items !== list) {
      var i = Epg.indexAt(list, Date.now());
      if (zone === 2 && !changed) i = progL.index;
      progL.setItems(list, i < 0 ? 0 : i);
    }
    progTitle.textContent = I18n.t('guide');
    if (changed) Epg.ensure(c);
  }

  var showDetailSoon = U.debounce(function (c) { showDetail(c); }, 150);

  /* "auto" mode: the channel under the cursor starts in the preview box once the cursor rests on it */
  var autoPreview = U.debounce(function (c) {
    if (Store.get('chOk') !== 'auto' || !c || moving || zone !== 1 || !chL.active || chL.current() !== c) return;
    if (Player.mode() === 'full' || Modal.isOpen() || !App.lockOpen(c.group)) return;
    var cur = Player.current();
    if (cur && cur.type === 'live' && cur.ch === c) return;
    Player.playLive(c, { list: chL.items, index: chL.index, listName: chTitle.querySelector('.ct-name').textContent, gid: groupId, browse: true });
    chL.refresh();
  }, 600);

  function okChannel(c) {
    App.checkLock(c.group).then(function (ok) {
      if (!ok) return;
      var cur = Player.current();
      var how = Store.get('chOk');
      var full = how === 'full' || how === 'auto' || (cur && cur.type === 'live' && cur.ch === c && Player.mode() === 'preview');
      if (cur && cur.type === 'live' && cur.ch === c && full) {
        cur.list = chL.items; cur.index = chL.index; cur.listName = chTitle.querySelector('.ct-name').textContent; cur.gid = groupId;
        Store.pushRecent(c.key);
        Player.full();
        return;
      }
      Player.playLive(c, { list: chL.items, index: chL.index, listName: chTitle.querySelector('.ct-name').textContent, gid: groupId, full: full });
      chL.refresh();
    });
  }

  function okProgramme(p) {
    var c = detailCh;
    if (!c || !p) return;
    var now = Date.now();
    if (p.s > now) { Reminders.toggle(c, p); progL.refresh(); return; }
    App.checkLock(c.group).then(function (ok) {
      if (!ok) return;
      var listOpts = { list: chL.items, index: chL.items.indexOf(c), listName: chTitle.querySelector('.ct-name').textContent, gid: groupId };
      if (p.e > now) {
        Player.askOnAir(c, p).then(function (how) {
          if (how === 'start') Player.playCatchup(c, p, listOpts);
          else if (how === 'live') { listOpts.full = true; Player.playLive(c, listOpts); }
        });
        return;
      }
      if (!Data.canCatchup(c, p)) { U.toast(I18n.t('no_archive')); return; }
      Player.playCatchup(c, p, listOpts);
    });
  }

  /* lists changed by the channel editor: rebuild, keep the cursor on ch */
  function afterEdit(ch) {
    var i = chL.index;
    reloadGroups(true);
    var list = Data.liveList(groupId);
    if (!list.length && groupId !== '__all') { groupsL.setIndex(0, true); openGroup(groups[0], true); list = chL.items; }
    var j = ch ? list.indexOf(ch) : -1;
    chL.setItems(list, j >= 0 ? j : Math.min(i, Math.max(0, list.length - 1)));
    chTitle.querySelector('.ct-count').textContent = list.length;
    if (chL.current()) showDetail(chL.current());
  }

  function editName(c) {
    Modal.form(I18n.t('ch_rename'), [{ id: 'name', label: I18n.t('ch_name'), value: c.name, placeholder: c.orig ? c.orig.name : '' }]).then(function (v) {
      if (!v) return;
      Data.setEdit(c.key, { name: (v.name || '').trim() });
      afterEdit(c);
    });
  }

  function editGroup(c) {
    var items = [{ label: I18n.t('new_group'), icon: 'list', value: '\u0000new' }];
    Data.groupNames().forEach(function (g) { if (g !== c.group) items.push({ label: g, value: g }); });
    Modal.menu(I18n.t('ch_move_group'), items).then(function (g) {
      if (g == null) return;
      if (g !== '\u0000new') { setGroup(c, g); return; }
      Modal.form(I18n.t('new_group'), [{ id: 'g', label: I18n.t('group_name'), value: '' }]).then(function (v) {
        var name = v && (v.g || '').trim();
        if (name) setGroup(c, name);
      });
    });
  }
  function setGroup(c, g) {
    Data.setEdit(c.key, { group: g });
    U.toast(c.name + ' → ' + g);
    afterEdit(c);
  }

  /* take the guide of another channel (e.g. "Channel HD" without its own EPG) */
  function editEpg(c) {
    var me = U.normName(c.orig ? c.orig.name : c.name), stem = me.slice(0, Math.min(4, me.length));
    var near = Data.state.all.filter(function (x) {
      if (x === c) return false;
      var n = U.normName(x.orig ? x.orig.name : x.name);
      return stem && n && (n.indexOf(stem) === 0 || me.indexOf(n.slice(0, 4)) === 0);
    }).slice(0, 40);
    if (!near.length) near = Data.liveList(c.group).filter(function (x) { return x !== c; }).slice(0, 60);
    var items = [{ label: I18n.t('epg_own'), value: '', icon: c.epgFrom ? '' : 'play' }];
    near.forEach(function (x) {
      var nn = Epg.nowNext(x);
      items.push({ label: x.name, value: x.key, icon: c.epgFrom === x.key ? 'play' : '', hint: nn.cur ? nn.cur.t : '' });
    });
    Modal.menu(I18n.t('ch_epg_from'), items).then(function (key) {
      if (key == null) return;
      Data.setEdit(c.key, { epg: key });
      Epg.ensure(c);
      afterEdit(c);
      U.toast(I18n.t('done'));
    });
  }

  function startMove(c) {
    if (groupId === '__fav' || groupId === '__recent') { U.toast(I18n.t('move_na'), 4000); return; }
    moving = c;
    chL.refresh();
    U.toast(I18n.t('move_hint'), 4000);
  }
  function endMove() { moving = null; chL.refresh(); }

  function channelMenu(c) {
    if (!c) return;
    var fav = Store.isFav('live', c.key);
    var locked = Store.isLocked(c.group);
    Modal.menu(c.name, [
      { label: I18n.t(fav ? 'remove_fav' : 'add_fav'), icon: 'star', value: 'fav' },
      { label: I18n.t(locked ? 'unlock_group' : 'lock_group') + ': ' + c.group, icon: 'lock', value: 'lock' },
      { label: I18n.t('show_guide'), icon: 'guide', value: 'guide' },
      { label: I18n.t('ch_rename'), icon: 'list', value: 'rename' },
      { label: I18n.t('ch_move_group'), icon: 'right', value: 'group' },
      { label: I18n.t('ch_reorder'), icon: 'list', value: 'move' },
      { label: I18n.t('ch_epg_from'), icon: 'guide', value: 'epg', hint: c.epgFrom && Data.channel(c.epgFrom) ? Data.channel(c.epgFrom).name : '' },
      { label: I18n.t('ch_hide'), icon: 'lock', value: 'hide', danger: true }
    ]).then(function (v) {
      if (v === 'fav') toggleFav(c);
      else if (v === 'lock') App.toggleGroupLock(c.group).then(function () { reloadGroups(); });
      else if (v === 'guide') App.show('guide');
      else if (v === 'rename') editName(c);
      else if (v === 'group') editGroup(c);
      else if (v === 'move') startMove(c);
      else if (v === 'epg') editEpg(c);
      else if (v === 'hide') { Data.setEdit(c.key, { hidden: true }); U.toast(I18n.t('ch_hidden_done') + ': ' + c.name); afterEdit(null); }
    });
  }

  function toggleFav(c) {
    var added = Store.toggleFav('live', c.key);
    U.toast(I18n.t(added ? 'fav_added' : 'fav_removed'));
    chL.refresh();
    reloadGroups(true);
    if (groupId === '__fav') { var i = chL.index; openGroup(groups[1], true); chL.setIndex(i); }
  }

  function reloadGroups(keep) {
    var gi = groupsL.index;
    groups = Data.liveGroups();
    groupsL.setItems(groups, gi, keep);
  }

  var Live = {
    id: 'live',
    renderChannel: renderChannel,
    renderGroup: renderGroup,
    get el() { return el; },
    build: build,

    reset: function () {
      groupId = null;
      moving = null;
      detailCh = null;
      groups = Data.liveGroups();
      groupsL.setItems(groups, 0);
      openGroup(groups[0], true);
      zone = 1;
    },

    show: function () {
      el.classList.remove('hidden');
      Player.setPreviewEl(previewBox);
      var cur = Player.current();
      if (cur && cur.type === 'live' && Player.mode() !== 'full') Player.preview();
      reloadGroups(true);
      // the open group was locked meanwhile (Settings): hide its channels until the PIN is entered
      if (groupId && !App.lockOpen(groupId) && Store.isLocked(groupId)) {
        groupId = null;
        openGroup(groupsL.current(), false);
        if (zone === 1) zone = 0;
      }
      setZone(zone === 0 ? 0 : 1, true);
    },
    hide: function () {
      el.classList.add('hidden');
      if (Player.mode() === 'preview') Player.stop();
    },
    focus: function () { setZone(zone, true); },
    blur: function () { groupsL.setActive(false); chL.setActive(false); progL.setActive(false); },

    currentList: function () { return { list: chL.items, name: chTitle.querySelector('.ct-name').textContent, index: chL.index }; },

    /* called when the player switches channel (or group) in fullscreen */
    syncTo: function (ch, gid) {
      if (gid && gid !== groupId) {
        for (var g = 0; g < groups.length; g++) {
          if (groups[g].id === gid) {
            groupsL.setIndex(g, true);   // a locked group was already opened with the PIN by the player
            openGroup(groups[g], true);
            break;
          }
        }
      }
      var i = chL.items.indexOf(ch);
      if (i >= 0) { chL.setIndex(i, true); showDetail(ch); }
      chL.refresh();
    },

    jumpTo: function (ch) {
      var i = chL.items.indexOf(ch);
      if (i < 0) { groupsL.setIndex(0, true); openGroup(groups[0], true); i = chL.items.indexOf(ch); }
      if (i >= 0) { setZone(1); chL.setIndex(i); showDetail(ch); okChannel(ch); }
    },

    playLast: function () {
      var key = Store.lastChannel();
      var ch = key && Data.channel(key);
      if (!ch || Store.isLocked(ch.group)) return;
      var i = chL.items.indexOf(ch);
      if (i >= 0) { chL.setIndex(i, true); showDetail(ch); }
      Player.playLive(ch, { list: chL.items, index: i < 0 ? 0 : i, listName: chTitle.querySelector('.ct-name').textContent, gid: groupId });
      chL.refresh();
    },

    key: function (e) {
      var k = e.keyCode;
      if (zone === 0) {
        switch (k) {
          case K.UP: groupsL.move(-1); return true;
          case K.DOWN: groupsL.move(1); return true;
          case K.CH_UP: groupsL.page(-1); return true;
          case K.CH_DOWN: groupsL.page(1); return true;
          case K.RIGHT: case K.ENTER: openGroup(groupsL.current(), true); if (chL.items.length) setZone(1); return true;
          case K.LONG_OK: case K.YELLOW: {
            var g = groupsL.current();
            if (g && g.id.indexOf('__') !== 0) App.toggleGroupLock(g.id).then(function () { reloadGroups(true); });
            return true;
          }
          case K.LEFT: return false;
        }
        return false;
      }
      if (zone === 1 && moving) {
        switch (k) {
          case K.UP: case K.DOWN:
            if (Data.moveChannel(moving, k === K.UP ? -1 : 1, groupId)) afterEdit(moving);
            return true;
          case K.ENTER: case K.BACK: case K.ESC: case K.LEFT: case K.LONG_OK: endMove(); U.toast(I18n.t('done')); return true;
        }
        return true;
      }
      if (zone === 1) {
        var c = chL.current();
        switch (k) {
          case K.UP: chL.move(-1); return true;
          case K.DOWN: chL.move(1); return true;
          case K.CH_UP: chL.page(-1); return true;
          case K.CH_DOWN: chL.page(1); return true;
          case K.LEFT: setZone(0); return true;
          case K.RIGHT: if (progL.items.length) setZone(2); return true;
          case K.ENTER: if (c) okChannel(c); return true;
          case K.RED: if (c) toggleFav(c); return true;
          case K.LONG_OK: case K.YELLOW: case K.INFO: channelMenu(c); return true;
          case K.GREEN: App.show('guide'); return true;
        }
        return false;
      }
      if (zone === 2) {
        switch (k) {
          case K.UP: progL.move(-1); return true;
          case K.DOWN: progL.move(1); return true;
          case K.CH_UP: progL.page(-1); return true;
          case K.CH_DOWN: progL.page(1); return true;
          case K.LEFT: setZone(1); return true;
          case K.ENTER: okProgramme(progL.current()); return true;
          case K.RIGHT: return true;
        }
        return false;
      }
      return false;
    },

    back: function () {
      if (zone === 2) { setZone(1); return true; }
      if (zone === 1) { setZone(0); return true; }
      return false;
    }
  };

  window.Live = Live;
})();
