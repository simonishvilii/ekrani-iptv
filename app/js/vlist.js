/* Virtualised list / grid with remote-control focus and Magic Remote (pointer) support. */
(function () {
  'use strict';

  function remPx() { return parseFloat(getComputedStyle(document.documentElement).fontSize) || 10; }

  function VList(container, opts) {
    this.c = container;
    this.o = opts;
    this.cols = opts.cols || 1;
    this.items = [];
    this.index = 0;
    this.active = false;
    this.offset = 0;
    this.rows = {};
    this.c.classList.add('vlist');
    this.inner = U.el('div', 'vlist-inner');
    this.c.innerHTML = '';
    this.c.appendChild(this.inner);
    if (opts.emptyText) {
      this.empty = U.el('div', 'vlist-empty hidden', U.esc(opts.emptyText));
      this.c.appendChild(this.empty);
    }
    var self = this;
    this.c.addEventListener('wheel', function (e) {
      e.preventDefault();
      self.move(e.deltaY > 0 ? self.cols : -self.cols, true);
    });
    this.c.addEventListener('mousemove', function (e) {
      var it = e.target.closest ? e.target.closest('.vitem') : null;
      if (!it) return;
      var i = parseInt(it.getAttribute('data-i'), 10);
      if (opts.onPointer) opts.onPointer(self);
      if (i !== self.index) self.setIndex(i, true);
    });
    this.c.addEventListener('click', function (e) {
      var it = e.target.closest ? e.target.closest('.vitem') : null;
      if (!it) return;
      var i = parseInt(it.getAttribute('data-i'), 10);
      if (opts.onPointer) opts.onPointer(self);
      self.setIndex(i, true);
      if (opts.onSelect) opts.onSelect(self.items[i], i, self);
    });
    // re-layout when the list becomes visible or changes size
    if (window.ResizeObserver) {
      var lastH = 0;
      new ResizeObserver(function () {
        var h = self.c.clientHeight;
        if (h && h !== lastH && self.items.length) { lastH = h; self.scrollTo(true); }
        else lastH = h;
      }).observe(this.c);
    }
  }

  VList.prototype.rowH = function () { return this.o.rowHeight * remPx(); };
  VList.prototype.viewH = function () { return this.c.clientHeight; };

  VList.prototype.setItems = function (items, index, keepOffset) {
    this.items = items || [];
    this.index = U.clamp(index || 0, 0, Math.max(0, this.items.length - 1));
    if (!keepOffset) this.offset = 0;
    this.rows = {};
    this.inner.innerHTML = '';
    if (this.empty) this.empty.classList.toggle('hidden', this.items.length > 0);
    this.inner.style.height = Math.ceil(this.items.length / this.cols) * this.rowH() + 'px';
    this.scrollTo(true);
  };

  VList.prototype.current = function () { return this.items[this.index]; };

  VList.prototype.setActive = function (a) {
    this.active = a;
    this.c.classList.toggle('active', a);
    this.paintFocus();
  };

  VList.prototype.setIndex = function (i, noScrollAnim) {
    if (!this.items.length) return;
    i = U.clamp(i, 0, this.items.length - 1);
    var changed = i !== this.index;
    this.index = i;
    this.scrollTo(noScrollAnim);
    if (changed && this.o.onFocus) this.o.onFocus(this.items[i], i, this);
  };

  /* returns false when the move hits an edge (so the screen can move focus elsewhere) */
  VList.prototype.move = function (delta, fromWheel) {
    if (!this.items.length) return false;
    var n = this.index + delta;
    if (this.cols > 1 && Math.abs(delta) === 1) {
      // horizontal move inside a grid row
      if (Math.floor(n / this.cols) !== Math.floor(this.index / this.cols) || n < 0) return false;
      if (n >= this.items.length) return false;
    }
    if (n < 0) { if (this.index === 0 || fromWheel) return false; n = 0; }
    if (n >= this.items.length) {
      if (this.cols > 1 && Math.floor((this.items.length - 1) / this.cols) > Math.floor(this.index / this.cols)) n = this.items.length - 1;
      else return false;
    }
    this.setIndex(n);
    return true;
  };

  VList.prototype.page = function (dir) {
    var per = Math.max(1, Math.floor((this.viewH() || this.rowH() * 6) / this.rowH()) - 1) * this.cols;
    this.setIndex(this.index + dir * per);
  };

  VList.prototype.scrollTo = function (instant) {
    var rh = this.rowH(), vh = this.viewH();
    var row = Math.floor(this.index / this.cols);
    var top = row * rh, total = Math.ceil(this.items.length / this.cols) * rh;
    var margin = rh * (this.o.margin == null ? 1 : this.o.margin);
    var off = this.offset;
    if (vh < rh * 2) {
      // not laid out yet (hidden screen): keep the focused row near the top
      off = Math.max(0, top - margin);
    } else {
      if (vh < margin * 2 + rh) margin = Math.max(0, (vh - rh) / 2);
      if (top - off < margin) off = top - margin;
      if (top + rh - off > vh - margin) off = top + rh - vh + margin;
      off = U.clamp(off, 0, Math.max(0, total - vh));
    }
    this.offset = off;
    this.inner.style.transition = instant ? 'none' : '';
    this.inner.style.transform = 'translateY(' + (-off) + 'px)';
    this.renderRows();
    this.paintFocus();
  };

  VList.prototype.renderRows = function () {
    var rh = this.rowH(), vh = this.viewH() || rh * 12;
    var first = Math.max(0, Math.floor(this.offset / rh) - 3);
    var last = Math.min(Math.ceil(this.items.length / this.cols) - 1, Math.ceil((this.offset + vh) / rh) + 3);
    var keep = {};
    for (var r = first; r <= last; r++) {
      for (var c = 0; c < this.cols; c++) {
        var i = r * this.cols + c;
        if (i >= this.items.length) break;
        keep[i] = true;
        if (!this.rows[i]) {
          var e = U.el('div', 'vitem ' + (this.o.itemClass || ''));
          e.setAttribute('data-i', i);
          e.style.top = r * rh + 'px';
          e.style.height = rh + 'px';
          if (this.cols > 1) {
            e.style.width = (100 / this.cols) + '%';
            e.style.left = (100 / this.cols * c) + '%';
          }
          e.innerHTML = this.o.render(this.items[i], i);
          this.inner.appendChild(e);
          this.rows[i] = e;
        }
      }
    }
    var self = this;
    Object.keys(this.rows).forEach(function (k) {
      if (!keep[k]) { self.inner.removeChild(self.rows[k]); delete self.rows[k]; }
    });
  };

  /* re-render visible rows (e.g. after EPG update) */
  VList.prototype.refresh = function () {
    var self = this;
    Object.keys(this.rows).forEach(function (k) {
      var it = self.items[k];
      if (it) self.rows[k].innerHTML = self.o.render(it, +k);
    });
    this.paintFocus();
  };

  VList.prototype.paintFocus = function () {
    var self = this;
    Object.keys(this.rows).forEach(function (k) {
      var on = +k === self.index;
      self.rows[k].classList.toggle('focused', on && self.active);
      self.rows[k].classList.toggle('selected', on && !self.active);
    });
  };

  window.VList = VList;
})();
