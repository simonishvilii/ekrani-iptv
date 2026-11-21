/* Global search over channels, YouTube videos and guide programmes. */
(function () {
  'use strict';
  var K = U.KEY;
  var el, input, resL, zone = 0, seq = 0;

  function build() {
    el = U.el('section', 'screen search hidden');
    el.innerHTML = '<div class="search-bar">' + U.icon('search') +
      '<input type="text" class="search-input" autocomplete="off" spellcheck="false" placeholder="' + U.esc(I18n.t('search_hint')) + '"></div>' +
      '<div class="list results"></div>';
    document.getElementById('screens').appendChild(el);
    input = el.querySelector('input');
    input.addEventListener('input', U.debounce(run, 500));
    input.addEventListener('click', function () { zone = 0; paint(); });
    resL = new VList(el.querySelector('.results'), {
      rowHeight: 8.8, itemClass: 'ch-row', emptyText: I18n.t('no_items'),
      render: function (r) {
        if (r.kind === 'live') return Live.renderChannel(r.item);
        if (r.kind === 'prog') return renderProg(r);
        return '<div class="c-num"></div><div class="c-logo">' + U.imgTag(r.item.poster, 'logo', r.item.name) + '</div>' +
          '<div class="c-main"><div class="c-name">' + U.esc(r.item.name) + '</div><div class="c-prog">' +
          'YouTube' + (r.item.year ? ' • ' + U.esc(r.item.year) : '') + '</div></div>';
      },
      onSelect: function (r) { open(r); },
      onPointer: function () { zone = 1; paint(true); }
    });
  }

  function paint(fromPointer) {
    el.querySelector('.search-bar').classList.toggle('focused', zone === 0);
    resL.setActive(zone === 1);
    if (zone === 1 && document.activeElement === input) input.blur();
    if (!fromPointer) App.focusContent();
  }

  /* a programme found in the guide */
  function renderProg(r) {
    var p = r.p, ch = r.item, now = Date.now(), mark = '';
    if (p.s <= now && p.e > now) mark = '<span class="badge live">' + I18n.t('live_badge') + '</span>';
    else if (p.s > now) mark = Reminders.has(ch, p) ? U.icon('bell', 'bell') : '';
    else if (Data.canCatchup(ch, p) && p.a !== false) mark = U.icon('archive');
    return '<div class="c-num"></div><div class="c-logo">' + U.imgTag(ch.logo, 'logo', ch.name) + '</div>' +
      '<div class="c-main"><div class="c-name">' + U.esc(p.t) + '</div><div class="c-prog">' +
      U.esc(ch.name) + ' • ' + U.esc(U.dayLabel(p.s)) + ' ' + U.hhmm(p.s) + '–' + U.hhmm(p.e) + '</div></div>' +
      '<div class="c-badges">' + mark + '</div>';
  }

  function match(name, q) { return String(name || '').toLowerCase().indexOf(q) >= 0; }

  function run() {
    var q = input.value.trim().toLowerCase();
    var my = ++seq;
    if (q.length < 2) { resL.setItems([]); return; }
    // channels, then YouTube videos, then programmes from the guide
    var out = [], vod = [], progs = [];
    Data.state.live.forEach(function (c) { if (match(c.name, q)) out.push({ kind: 'live', item: c }); });
    out = out.slice(0, 500);
    resL.setItems(out);
    function paintAll() { if (my === seq) resL.setItems(out.concat(vod, progs), resL.index, true); }
    Data.vodAll().then(function (list) {
      list.forEach(function (m) { if (match(m.name, q)) vod.push({ kind: 'youtube', item: m }); });
      vod = vod.slice(0, 300);
      paintAll();
    })['catch'](function () {});
    Epg.search(q, 150).then(function (l) {
      progs = l.map(function (x) { return { kind: 'prog', item: x.ch, p: x.p }; });
      paintAll();
    })['catch'](function () {});
  }

  function openProg(r) {
    var ch = r.item, p = r.p, now = Date.now();
    if (p.s > now) { Reminders.toggle(ch, p); resL.refresh(); return; }
    if (p.e <= now && !(Data.canCatchup(ch, p) && p.a !== false)) { U.toast(I18n.t('no_archive')); return; }
    App.checkLock(ch.group).then(function (ok) {
      if (!ok) return;
      var all = Data.liveList('__all');
      var o = { list: all, index: Math.max(0, all.indexOf(ch)), listName: I18n.t('all_channels'), gid: '__all', full: true };
      if (p.e <= now) { Player.playCatchup(ch, p, o); return; }
      // on air: from the start (archive) or live, as in the guide
      Player.askOnAir(ch, p).then(function (how) {
        if (how === 'start') Player.playCatchup(ch, p, o);
        else if (how === 'live') Player.playLive(ch, o);
      });
    });
  }

  function open(r) {
    if (!r) return;
    if (r.kind === 'prog') { openProg(r); return; }
    if (r.kind === 'live') {
      App.checkLock(r.item.group).then(function (ok) {
        if (!ok) return;
        var list = resL.items.filter(function (x) { return x.kind === 'live'; }).map(function (x) { return x.item; });
        Player.playLive(r.item, { list: list, index: Math.max(0, list.indexOf(r.item)), full: true, listName: I18n.t('results') });
      });
      return;
    }
    App.show('youtube');
    YouTube.openDirect(r.item);
  }

  window.Search = {
    id: 'search',
    get el() { return el; },
    build: build,
    reset: function () { if (input) { input.value = ''; resL.setItems([]); } },
    show: function () { el.classList.remove('hidden'); paint(true); },
    hide: function () { el.classList.add('hidden'); input.blur(); },
    focus: function () { paint(true); },
    blur: function () { el.querySelector('.search-bar').classList.remove('focused'); resL.setActive(false); input.blur(); },
    key: function (e) {
      var k = e.keyCode;
      if (zone === 0) {
        if (document.activeElement === input) {
          if (k === K.DOWN || k === K.ENTER) { input.blur(); if (resL.items.length) { zone = 1; paint(); } return true; }
          if (k === K.BACK || k === K.ESC) { input.blur(); return true; }
          return false; // typing
        }
        if (k === K.ENTER) { input.focus(); return true; }
        if (k === K.DOWN && resL.items.length) { zone = 1; paint(); return true; }
        return k === K.UP || k === K.RIGHT;
      }
      switch (k) {
        case K.UP: if (!resL.move(-1)) { zone = 0; paint(); } return true;
        case K.DOWN: resL.move(1); return true;
        case K.CH_UP: resL.page(-1); return true;
        case K.CH_DOWN: resL.page(1); return true;
        case K.ENTER: open(resL.current()); return true;
        case K.RIGHT: return true;
      }
      return false;
    },
    back: function () { if (zone === 1) { zone = 0; paint(); return true; } return false; }
  };
})();
