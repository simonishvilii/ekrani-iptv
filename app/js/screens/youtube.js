/* YouTube: channels | thumbnail grid, plus a detail page per video. */
(function () {
  'use strict';
  var K = U.KEY;
  var COLS = 4;   // wide 16:9 thumbnails

  function YtScreen() {
    this.id = 'youtube';
    this.zone = 0;                 // 0 channels, 1 grid, 2 detail
    this.unlocked = {};
    this.catId = null;
    this.reqSeq = 0;
    this.det = null;
  }
  var P = YtScreen.prototype;

  P.build = function () {
    var self = this;
    var el = this.el = U.el('section', 'screen vod yt hidden');
    el.innerHTML =
      '<div class="col col-cats"><div class="col-title">' + I18n.t('youtube') + '</div><div class="list cats"></div></div>' +
      '<div class="col col-grid"><div class="col-title"><span class="ct-name"></span><span class="ct-count"></span></div><div class="list grid"></div></div>' +
      '<div class="vod-detail hidden"></div>';
    document.getElementById('screens').appendChild(el);
    this.title = el.querySelector('.col-grid .col-title');
    this.detEl = el.querySelector('.vod-detail');

    this.catsL = new VList(el.querySelector('.cats'), {
      rowHeight: 6.4, itemClass: 'g-item',
      render: function (c) {
        return '<div class="g-row">' + (c.icon ? U.icon(c.icon) : (c.locked ? U.icon('lock') : '<span class="ico"></span>')) +
          '<span class="g-name">' + U.esc(c.name) + '</span></div>';
      },
      onFocus: U.debounce(function (c) { self.openCat(c, false); }, 350),
      onSelect: function (c) { self.openCat(c, true); self.setZone(1); },
      onPointer: function () { self.setZone(0, true); }
    });
    this.gridL = new VList(el.querySelector('.grid'), {
      rowHeight: 27, cols: COLS, itemClass: 'poster-item', emptyText: I18n.t('no_items'), margin: 0,
      render: function (m) {
        return '<div class="poster">' + U.imgTag(m.poster, 'pimg', m.name) +
          (m.isNew ? '<span class="pnew">' + U.esc(I18n.t('new_added')) + '</span>' : '') +
          (m.info && m.info.duration ? '<span class="pdur">' + U.esc(m.info.duration) + '</span>' : '') +
          (Store.isFav('youtube', m.key) ? '<span class="pfav">' + U.icon('star') + '</span>' : '') +
          '</div><div class="ptitle">' + U.esc(m.name) + '</div>';
      },
      onSelect: function (m) { self.openItem(m); },
      onPointer: function () { self.setZone(1, true); }
    });
  };

  P.setZone = function (z, fromPointer) {
    this.zone = z;
    this.catsL.setActive(z === 0);
    this.gridL.setActive(z === 1);
    if (!fromPointer) App.focusContent();
  };

  P.reset = function () {
    this.unlocked = {};
    this.catId = null;
    this.closeDetail();
    this.loaded = false;
  };

  /* fill the channel column (first time, or after the lists changed) */
  P.fill = function () {
    this.loaded = true;
    var cats = Data.vodCats();
    // only the virtual Favorites / Continue entries: no channels added yet
    if (this.gridL.empty) this.gridL.empty.textContent = I18n.t(cats.length <= 2 ? 'yt_no_channels' : 'no_items');
    var keep = this.keepCat, at = cats.length > 2 ? 2 : 0;
    this.keepCat = null;
    cats.forEach(function (c, i) { if (keep && c.id === keep) at = i; });
    this.catsL.setItems(cats, at);
    this.openCat(this.catsL.current(), true);
  };

  P.show = function () {
    this.el.classList.remove('hidden');
    if (!this.loaded) { this.fill(); this.zone = 0; }
    else if (this.catId === '__fav' || this.catId === '__cont') this.openCat(this.catsL.current(), true, true);
    if (this.zone === 2 && this.det) this.paintDetFocus(); else this.setZone(this.zone, true);
  };
  P.hide = function () { this.el.classList.add('hidden'); };
  P.focus = function () { if (this.zone === 2 && this.det) this.paintDetFocus(); else this.setZone(this.zone, true); };
  P.blur = function () { this.catsL.setActive(false); this.gridL.setActive(false); };

  P.openCat = function (c, explicit, keepIndex) {
    var self = this;
    if (!c) return;
    if (c.locked && !this.unlocked[c.id]) {
      this.gridL.setItems([]);
      this.title.querySelector('.ct-name').textContent = c.name;
      if (!explicit) return;
      App.checkLock('vod:' + c.name).then(function (ok) { if (ok) { self.unlocked[c.id] = true; self.openCat(c, true); } });
      return;
    }
    if (this.catId === c.id && !keepIndex) return;   // already showing this channel
    this.catId = c.id;
    var seq = ++this.reqSeq;
    this.title.querySelector('.ct-name').textContent = c.name;
    this.title.querySelector('.ct-count').textContent = '…';
    var idx = keepIndex ? this.gridL.index : 0;
    if (!keepIndex) this.gridL.setItems([]);
    Data.vodList('youtube', c.id).then(function (items) {
      if (seq !== self.reqSeq) return;
      if (c.id === '__cont') {
        var seen = {};
        items = items.filter(function (m) { if (!m || seen[m.key]) return false; seen[m.key] = true; return true; });
      }
      if (self.keepIdx != null) { idx = self.keepIdx; self.keepIdx = null; }
      self.gridL.setItems(items, idx);
      self.title.querySelector('.ct-count').textContent = items.length;
    });
  };

  /* ---------------- detail page ---------------- */
  P.openItem = function (m) {
    if (!m) return;
    m = Data.localItem(m.key) || m;   // favourites / "continue" keep only a short copy
    this.det = { item: m, btn: 0 };
    this.zone = 2;
    this.catsL.setActive(false);
    this.gridL.setActive(false);
    this.detEl.classList.remove('hidden');
    this.renderDetail();
  };

  P.closeDetail = function () {
    this.det = null;
    if (this.detEl) { this.detEl.classList.add('hidden'); this.detEl.innerHTML = ''; }
    if (this.zone === 2) this.zone = 1;
    if (this.pendingReload) { var self = this; setTimeout(function () { self.reloadData(); }, 0); }
  };

  P.buttons = function () {
    var m = this.det.item, b = [];
    var pos = Store.getPos(m.key);
    if (pos) b.push({ id: 'resume', label: I18n.t('resume') + ' ' + U.fmtDuration(pos.pos), icon: 'play' });
    b.push({ id: 'play', label: pos ? I18n.t('from_start') : I18n.t('play'), icon: 'play' });
    b.push({ id: 'fav', label: I18n.t(Store.isFav('youtube', m.key) ? 'remove_fav' : 'add_fav'), icon: 'star' });
    return b;
  };

  P.renderDetail = function () {
    var d = this.det;
    if (!d) return;
    var m = d.item, info = m.info || {};
    var meta = [];
    if (m.year) meta.push(U.esc(String(m.year).slice(0, 4)));
    if (info.genre) meta.push(U.esc(info.genre));
    if (info.duration) meta.push(U.esc(info.duration));
    var btns = this.buttons();
    d.btn = U.clamp(d.btn, 0, btns.length - 1);

    var h = '<div class="vd-content"><div class="vd-poster">' + U.imgTag(m.poster, 'pimg', m.name) + '</div><div class="vd-info">' +
      '<h1>' + U.esc(m.name) + '</h1><div class="vd-meta">' + meta.join(' • ') + '</div>' +
      '<p class="vd-plot">' + U.esc(info.plot || m.plot || '') + '</p><div class="vd-btns">';
    btns.forEach(function (b, i) {
      h += '<div class="btn vd-btn' + (d.btn === i ? ' focused' : '') + (i === 0 ? ' primary' : '') +
        '" data-b="' + i + '">' + U.icon(b.icon) + U.esc(b.label) + '</div>';
    });
    this.detEl.innerHTML = h + '</div></div></div>';

    var self = this;
    this.detEl.onclick = function (e) {
      var b = e.target.closest('[data-b]');
      if (b) { d.btn = +b.getAttribute('data-b'); self.detAction(); }
    };
  };

  P.paintDetFocus = function () {
    var d = this.det;
    var bs = this.detEl.querySelectorAll('.vd-btn');
    for (var i = 0; i < bs.length; i++) bs[i].classList.toggle('focused', i === d.btn);
  };

  P.toggleFav = function (m) {
    var added = Store.toggleFav('youtube', m.key);
    if (added) Data.rememberFavMeta(m);
    U.toast(I18n.t(added ? 'fav_added' : 'fav_removed'));
    this.gridL.refresh();
  };

  P.detAction = function () {
    var self = this, m = this.det.item;
    var b = this.buttons()[this.det.btn];
    if (!b) return;
    if (b.id === 'fav') { this.toggleFav(m); this.renderDetail(); return; }
    var pos = Store.getPos(m.key);
    var meta = { key: m.key, id: m.id, name: m.name, poster: m.poster, type: m.type, year: m.year, youtube: m.youtube, section: 'youtube' };
    YtPlayer.play({
      id: m.youtube, title: m.name, posKey: m.key, meta: meta, startAt: b.id === 'resume' && pos ? pos.pos : 0,
      onClose: function () { self.afterYt(); }
    });
  };

  /* back from the YouTube player: refresh "resume" and the favourites marks */
  P.afterYt = function () {
    if (this.det) { this.renderDetail(); this.paintDetFocus(); }
    else this.focus();
  };

  P.key = function (e) {
    var k = e.keyCode, self = this;
    if (this.zone === 2 && this.det) {
      var d = this.det, nb = this.buttons().length;
      if (k === K.LEFT) { if (d.btn > 0) d.btn--; }
      else if (k === K.RIGHT) { if (d.btn < nb - 1) d.btn++; }
      else if (k === K.ENTER) { this.detAction(); return true; }
      else return k !== K.BACK && k !== K.ESC;
      this.paintDetFocus();
      return true;
    }
    if (this.zone === 0) {
      switch (k) {
        case K.UP: this.catsL.move(-1); return true;
        case K.DOWN: this.catsL.move(1); return true;
        case K.CH_UP: this.catsL.page(-1); return true;
        case K.CH_DOWN: this.catsL.page(1); return true;
        case K.RIGHT: case K.ENTER: {
          var cc = this.catsL.current();
          this.openCat(cc, true);
          if (cc && (!cc.locked || this.unlocked[cc.id])) this.setZone(1);
          return true;
        }
        case K.LONG_OK: case K.YELLOW: {
          var c = this.catsL.current();
          if (c && c.id.indexOf('__') !== 0) App.toggleGroupLock('vod:' + c.name).then(function () {
            c.locked = Store.isLocked('vod:' + c.name);
            self.catsL.refresh();
          });
          return true;
        }
      }
      return false;
    }
    switch (k) {
      case K.UP: this.gridL.move(-COLS); return true;
      case K.DOWN: this.gridL.move(COLS); return true;
      case K.LEFT: if (!this.gridL.move(-1)) this.setZone(0); return true;
      case K.RIGHT: this.gridL.move(1); return true;
      case K.CH_UP: this.gridL.page(-1); return true;
      case K.CH_DOWN: this.gridL.page(1); return true;
      case K.ENTER: this.openItem(this.gridL.current()); return true;
      case K.RED: { var m = this.gridL.current(); if (m) this.toggleFav(m); return true; }
    }
    return false;
  };

  P.back = function () {
    if (this.zone === 2) { this.closeDetail(); this.setZone(1); return true; }
    if (this.zone === 1) { this.setZone(0); return true; }
    return false;
  };

  /* open a video directly (used by search) */
  P.openDirect = function (m) {
    if (!this.loaded) this.fill();
    this.openItem(m);
  };

  /* the lists changed underneath (channels refreshed): rebuild, keep the channel */
  P.reloadData = function () {
    if (!this.el) return;
    var visible = !this.el.classList.contains('hidden');
    if (this.det && visible) { this.pendingReload = true; return; }   // not while a detail page is open
    this.keepCat = this.catId;
    this.catId = null;
    this.loaded = false;
    this.pendingReload = false;
    if (visible) {
      var z = this.zone;
      if (z === 1) this.keepIdx = this.gridL.index;
      this.show();
      if (z === 1) this.setZone(1, true);
    }
  };

  window.YouTube = new YtScreen();
  YtChannels.onUpdate(function () { YouTube.reloadData(); });
})();
