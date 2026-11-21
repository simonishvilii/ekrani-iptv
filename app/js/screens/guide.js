/* TV guide grid: channels x time. */
(function () {
  'use strict';
  var K = U.KEY;
  var SLOT = 30 * 60000;
  var SPAN = 2.5 * 3600000;          // visible time span

  var el, body, ruler, head, detail;
  var list = [], listName = '';
  var row = 0, top = 0;               // focused row / first visible row
  var t0 = 0;                         // window start
  var focusT = 0;                     // focused time (programme lookup)
  var ROWS = 8;

  function build() {
    el = U.el('section', 'screen guide hidden');
    el.innerHTML =
      '<div class="g-head"><div class="g-title"></div><div class="g-detail"></div></div>' +
      '<div class="g-ruler"><div class="g-corner"></div><div class="g-times"></div></div>' +
      '<div class="g-body"></div>';
    document.getElementById('screens').appendChild(el);
    head = el.querySelector('.g-title');
    detail = el.querySelector('.g-detail');
    ruler = el.querySelector('.g-times');
    body = el.querySelector('.g-body');

    body.addEventListener('click', function (e) {
      var p = e.target.closest ? e.target.closest('[data-r]') : null;
      if (!p) return;
      row = +p.getAttribute('data-r');
      if (p.hasAttribute('data-s')) focusT = +p.getAttribute('data-s') + 1;
      render();
      ok();
    });
    body.addEventListener('wheel', function (e) { e.preventDefault(); moveRow(e.deltaY > 0 ? 1 : -1); });
    Epg.onUpdate(U.debounce(function () { if (!el.classList.contains('hidden')) render(); }, 300));
  }

  function px(ms) { return (ms / SPAN) * 100; }   // percent of track width

  function progAt(ch, t) {
    var l = Epg.get(ch);
    if (!l) return null;
    var i = Epg.indexAt(l, t);
    return i >= 0 ? l[i] : null;
  }

  function render() {
    var now = Date.now();
    // ruler
    var r = '';
    for (var t = t0; t < t0 + SPAN; t += SLOT) {
      r += '<span style="left:' + px(t - t0) + '%">' + U.hhmm(t) + '</span>';
    }
    if (now >= t0 && now < t0 + SPAN) r += '<i class="g-now" style="left:' + px(now - t0) + '%"></i>';
    ruler.innerHTML = r;
    head.innerHTML = U.esc(listName) + ' <span class="muted">' + U.esc(U.dayLabel(t0)) + '</span>';

    var h = '';
    var focusedProg = null;
    for (var i = top; i < Math.min(list.length, top + ROWS); i++) {
      var ch = list[i];
      Epg.ensure(ch);
      var progs = Epg.get(ch) || [];
      var cells = '';
      var any = false;
      for (var j = 0; j < progs.length; j++) {
        var p = progs[j];
        if (p.e <= t0 || p.s >= t0 + SPAN) continue;
        any = true;
        var s = Math.max(p.s, t0), e = Math.min(p.e, t0 + SPAN);
        var isF = i === row && p.s <= focusT && p.e > focusT;
        if (isF) focusedProg = p;
        var cls = 'g-prog' + (isF ? ' focused' : '') + (p.s <= now && p.e > now ? ' now' : '') + (p.e <= now ? ' past' : '') +
          (p.e <= now && Data.canCatchup(ch, p) && p.a !== false ? ' arch' : '');
        cells += '<div class="' + cls + '" data-r="' + i + '" data-s="' + p.s + '" style="left:' + px(s - t0) + '%;width:' + px(e - s) + '%"><span>' +
          (p.s > now && Reminders.has(ch, p) ? U.icon('bell', 'bell') : '') + U.esc(p.t) + '</span></div>';
      }
      if (!any) {
        cells = '<div class="g-prog empty' + (i === row ? ' focused' : '') + '" data-r="' + i + '" style="left:0;width:100%"><span>' + I18n.t('no_epg') + '</span></div>';
      }
      var nowLine = now >= t0 && now < t0 + SPAN ? '<i class="g-now" style="left:' + px(now - t0) + '%"></i>' : '';
      h += '<div class="gd-row' + (i === row ? ' cur' : '') + '"><div class="g-ch" data-r="' + i + '">' +
        '<span class="c-num">' + (ch.num || '') + '</span>' + U.imgTag(ch.logo, 'logo', ch.name) + '<span class="g-chname">' + U.esc(ch.name) + '</span></div>' +
        '<div class="g-track">' + cells + nowLine + '</div></div>';
    }
    body.innerHTML = h || '<div class="vlist-empty">' + I18n.t('no_items') + '</div>';

    var fc = list[row];
    if (fc) {
      detail.innerHTML = focusedProg
        ? '<b>' + U.hhmm(focusedProg.s) + '–' + U.hhmm(focusedProg.e) + ' ' + U.esc(focusedProg.t) + '</b><p>' + U.esc(focusedProg.d || '') + '</p>'
        : '<b>' + U.esc(fc.name) + '</b>';
    }
  }

  function moveRow(d) {
    var n = U.clamp(row + d, 0, list.length - 1);
    if (n === row) return;
    row = n;
    if (row < top) top = row;
    if (row >= top + ROWS) top = row - ROWS + 1;
    render();
  }

  function moveTime(dir) {
    var ch = list[row];
    var progs = (ch && Epg.get(ch)) || [];
    var i = Epg.indexAt(progs, focusT);
    var target = null;
    if (i >= 0) target = progs[i + dir] || null;
    else {
      // find nearest in direction
      for (var j = 0; j < progs.length; j++) {
        if (dir > 0 && progs[j].s > focusT) { target = progs[j]; break; }
        if (dir < 0 && progs[j].e <= focusT) target = progs[j];
      }
    }
    if (target) focusT = target.s + 1;
    else focusT += dir * SLOT;
    // keep focus visible
    if (focusT < t0) t0 = Math.floor(focusT / SLOT) * SLOT;
    if (focusT >= t0 + SPAN) t0 = Math.floor(focusT / SLOT) * SLOT - SPAN + 2 * SLOT;
    render();
  }

  function ok() {
    var ch = list[row];
    if (!ch) return;
    var p = progAt(ch, focusT);
    var now = Date.now();
    var opts = { list: list, index: row, listName: listName };
    if (p && p.s > now) { Reminders.toggle(ch, p); render(); return; }
    App.checkLock(ch.group).then(function (okk) {
      if (!okk) return;
      if (!p) { opts.full = true; Player.playLive(ch, opts); return; }
      if (p.s <= now && p.e > now) {
        Player.askOnAir(ch, p).then(function (how) {
          if (how === 'start') Player.playCatchup(ch, p, opts);
          else if (how === 'live') { opts.full = true; Player.playLive(ch, opts); }
        });
        return;
      }
      if (!Data.canCatchup(ch, p)) { U.toast(I18n.t('no_archive')); return; }
      Player.playCatchup(ch, p, opts);
    });
  }

  var Guide = {
    id: 'guide',
    get el() { return el; },
    build: build,
    reset: function () { list = []; row = 0; top = 0; },
    show: function () {
      el.classList.remove('hidden');
      var cl = Live.currentList();
      if (cl.list !== list) { list = cl.list; row = cl.index || 0; top = Math.max(0, row - 2); }
      listName = cl.name;
      var now = Date.now();
      t0 = Math.floor(now / SLOT) * SLOT - SLOT;
      focusT = now;
      ROWS = Math.max(3, Math.floor(body.clientHeight / (parseFloat(getComputedStyle(document.documentElement).fontSize) * 8.4)));
      render();
    },
    hide: function () { el.classList.add('hidden'); },
    focus: function () { el.classList.add('active'); },
    blur: function () { el.classList.remove('active'); },
    key: function (e) {
      switch (e.keyCode) {
        case K.UP: moveRow(-1); return true;
        case K.DOWN: moveRow(1); return true;
        case K.CH_UP: moveRow(-ROWS); return true;
        case K.CH_DOWN: moveRow(ROWS); return true;
        case K.LEFT:
          if (focusT <= Date.now() - 7 * 86400000) return false;
          moveTime(-1); return true;
        case K.RIGHT: moveTime(1); return true;
        case K.ENTER: ok(); return true;
        case K.RED: { var c = list[row]; if (c) { U.toast(I18n.t(Store.toggleFav('live', c.key) ? 'fav_added' : 'fav_removed')); } return true; }
      }
      return false;
    },
    back: function () { return false; }
  };

  window.Guide = Guide;
})();
