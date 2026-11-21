/* Dialogs: menu, confirm, PIN pad, forms. Navigable with the remote and the pointer. */
(function () {
  'use strict';
  var K = U.KEY;
  var stack = [];

  function Dialog(cls) {
    this.root = U.el('div', 'modal-back');
    this.box = U.el('div', 'modal ' + (cls || ''));
    this.root.appendChild(this.box);
    this.r = 0; this.c = 0;
    this.rows = [];
    var self = this;
    this.root.addEventListener('mousemove', function (e) {
      var f = e.target.closest ? e.target.closest('.mf') : null;
      if (f && f.hasAttribute('data-r')) self.focus(+f.getAttribute('data-r'), +f.getAttribute('data-c'));
    });
    this.root.addEventListener('click', function (e) {
      var f = e.target.closest ? e.target.closest('.mf') : null;
      if (f && f.hasAttribute('data-r')) {
        self.focus(+f.getAttribute('data-r'), +f.getAttribute('data-c'));
        self.activate();
      } else if (e.target === self.root) {
        self.cancel();
      }
    });
  }

  Dialog.prototype.collect = function () {
    var rows = [];
    var els = this.box.querySelectorAll('.mf');
    var byRow = {};
    var order = [];
    for (var i = 0; i < els.length; i++) {
      var rr = els[i].getAttribute('data-row');
      var key = rr == null ? 'i' + i : rr;
      if (!byRow[key]) { byRow[key] = []; order.push(key); }
      byRow[key].push(els[i]);
    }
    order.forEach(function (k, ri) {
      byRow[k].forEach(function (e, ci) { e.setAttribute('data-r', ri); e.setAttribute('data-c', ci); });
      rows.push(byRow[k]);
    });
    this.rows = rows;
  };

  Dialog.prototype.cur = function () { var row = this.rows[this.r]; return row ? row[Math.min(this.c, row.length - 1)] : null; };

  Dialog.prototype.focus = function (r, c) {
    var old = this.cur();
    if (old) old.classList.remove('focused');
    this.r = U.clamp(r, 0, this.rows.length - 1);
    this.c = U.clamp(c, 0, (this.rows[this.r] || [1]).length - 1);
    var n = this.cur();
    if (n) {
      n.classList.add('focused');
      if (n.scrollIntoView) n.scrollIntoView({ block: 'nearest' });
    }
  };

  Dialog.prototype.show = function () {
    document.getElementById('modalRoot').appendChild(this.root);
    stack.push(this);
    this.collect();
    this.focus(this.r, this.c);
  };

  Dialog.prototype.close = function () {
    var i = stack.indexOf(this);
    if (i >= 0) stack.splice(i, 1);
    if (this.root.parentNode) this.root.parentNode.removeChild(this.root);
    if (document.activeElement && document.activeElement.blur) document.activeElement.blur();
  };

  Dialog.prototype.cancel = function () { this.close(); if (this.onCancel) this.onCancel(); };

  Dialog.prototype.activate = function () {
    var f = this.cur();
    if (!f) return;
    if (f.tagName === 'INPUT') { f.focus(); return; }
    if (this.onActivate) this.onActivate(f);
  };

  Dialog.prototype.key = function (e) {
    var k = e.keyCode;
    var f = this.cur();
    var inInput = document.activeElement && document.activeElement.tagName === 'INPUT';
    if (inInput) {
      if (k === K.BACK || k === K.ESC || k === K.ENTER) { document.activeElement.blur(); if (k === K.ENTER) this.focus(this.r + 1, 0); return true; }
      if (k === K.UP || k === K.DOWN) { document.activeElement.blur(); this.focus(this.r + (k === K.UP ? -1 : 1), 0); return true; }
      return false; // let the input handle typing / caret keys
    }
    if (this.onKey && this.onKey(e, f) === true) return true;
    switch (k) {
      case K.UP: this.focus(this.r - 1, this.c); return true;
      case K.DOWN: this.focus(this.r + 1, this.c); return true;
      case K.LEFT:
        if (f && f.classList.contains('choice')) { this.onChoice(f, -1); return true; }
        this.focus(this.r, this.c - 1); return true;
      case K.RIGHT:
        if (f && f.classList.contains('choice')) { this.onChoice(f, 1); return true; }
        this.focus(this.r, this.c + 1); return true;
      case K.ENTER: this.activate(); return true;
      case K.BACK: case K.ESC: this.cancel(); return true;
    }
    return true; // modal swallows everything else
  };

  Dialog.prototype.onChoice = function () {};

  var Modal = {
    top: function () { return stack[stack.length - 1] || null; },
    isOpen: function () { return stack.length > 0; },
    handleKey: function (e) { var t = Modal.top(); return t ? t.key(e) : false; },
    closeAll: function () { while (stack.length) stack[stack.length - 1].close(); },

    /* list of options; resolves with the chosen item's value or null */
    menu: function (title, items, startIndex) {
      return new Promise(function (resolve) {
        var d = new Dialog('menu');
        var html = (title ? '<div class="modal-title">' + U.esc(title) + '</div>' : '') + '<div class="menu-list">';
        items.forEach(function (it, i) {
          html += '<div class="mf menu-item' + (it.danger ? ' danger' : '') + '" data-i="' + i + '">' +
            (it.icon ? U.icon(it.icon) : '') + '<span>' + U.esc(it.label) + '</span>' +
            (it.hint ? '<em>' + U.esc(it.hint) + '</em>' : '') + '</div>';
        });
        d.box.innerHTML = html + '</div>';
        d.r = startIndex || 0;
        d.onActivate = function (f) { d.close(); var it = items[+f.getAttribute('data-i')]; resolve(it.value != null ? it.value : it); };
        d.onCancel = function () { resolve(null); };
        d.show();
      });
    },

    confirm: function (text, yes, no) {
      return new Promise(function (resolve) {
        var d = new Dialog('confirm');
        d.box.innerHTML = '<div class="modal-text">' + U.esc(text) + '</div><div class="btn-row">' +
          '<div class="mf btn primary" data-row="b" data-v="1">' + U.esc(yes || I18n.t('yes')) + '</div>' +
          '<div class="mf btn" data-row="b" data-v="0">' + U.esc(no || I18n.t('no')) + '</div></div>';
        d.onActivate = function (f) { d.close(); resolve(f.getAttribute('data-v') === '1'); };
        d.onCancel = function () { resolve(false); };
        d.show();
      });
    },

    alert: function (title, html) {
      return new Promise(function (resolve) {
        var d = new Dialog('alert');
        d.box.innerHTML = '<div class="modal-title">' + U.esc(title) + '</div><div class="modal-text">' + html + '</div>' +
          '<div class="btn-row"><div class="mf btn primary">' + I18n.t('ok') + '</div></div>';
        d.onActivate = function () { d.close(); resolve(); };
        d.onCancel = function () { resolve(); };
        d.show();
      });
    },

    /* text/html with a row of buttons [{v,l,primary}]; resolves with the pressed button's v, null on Back.
       Returns the promise; the dialog itself is Modal.top() right after the call. */
    buttons: function (title, html, btns) {
      return new Promise(function (resolve) {
        var d = new Dialog('alert');
        var b = '';
        btns.forEach(function (x, i) {
          b += '<div class="mf btn' + (x.primary ? ' primary' : '') + '" data-row="b" data-i="' + i + '">' + U.esc(x.l) + '</div>';
        });
        d.box.innerHTML = (title ? '<div class="modal-title">' + U.esc(title) + '</div>' : '') + '<div class="modal-text">' + html + '</div><div class="btn-row">' + b + '</div>';
        d.onActivate = function (f) { d.close(); resolve(btns[+f.getAttribute('data-i')].v); };
        d.onCancel = function () { resolve(null); };
        d.show();
      });
    },

    /* 4-digit PIN entry; digit keys on the remote work directly */
    pin: function (title) {
      return new Promise(function (resolve) {
        var d = new Dialog('pin');
        var val = '';
        var keys = ['1', '2', '3', '4', '5', '6', '7', '8', '9', '⌫', '0', 'OK'];
        var html = '<div class="modal-title">' + U.esc(title) + '</div><div class="pin-dots"></div><div class="pin-pad">';
        keys.forEach(function (k, i) {
          html += '<div class="mf pin-key" data-row="r' + Math.floor(i / 3) + '" data-k="' + k + '">' + k + '</div>';
        });
        d.box.innerHTML = html + '</div>';
        var dots = d.box.querySelector('.pin-dots');
        function paint() {
          var s = '';
          for (var i = 0; i < 4; i++) s += '<span class="' + (i < val.length ? 'on' : '') + '"></span>';
          dots.innerHTML = s;
        }
        function press(k) {
          if (k === '⌫') val = val.slice(0, -1);
          else if (k === 'OK') { if (val.length === 4) { d.close(); resolve(val); } return; }
          else if (val.length < 4) val += k;
          paint();
          if (val.length === 4) setTimeout(function () { if (stack.indexOf(d) >= 0) { d.close(); resolve(val); } }, 150);
        }
        paint();
        d.onActivate = function (f) { press(f.getAttribute('data-k')); };
        d.onKey = function (e) {
          if (e.keyCode >= 48 && e.keyCode <= 57) { press(String(e.keyCode - 48)); return true; }
          if (e.keyCode >= 96 && e.keyCode <= 105) { press(String(e.keyCode - 96)); return true; }
          if (e.keyCode === K.BACKSPACE) { press('⌫'); return true; }
          return false;
        };
        d.onCancel = function () { resolve(null); };
        d.show();
      });
    },

    /*
     * Form. fields: [{id,label,type:'text'|'password'|'choice',value,options:[{v,l}],visible:fn(values)}]
     * resolves with values object or null.
     */
    form: function (title, fields, validate) {
      return new Promise(function (resolve) {
        var d = new Dialog('form');
        var values = {};
        fields.forEach(function (f) { values[f.id] = f.value != null ? f.value : (f.options ? f.options[0].v : ''); });

        function readInputs() {
          var ins = d.box.querySelectorAll('input[data-id]');
          for (var i = 0; i < ins.length; i++) values[ins[i].getAttribute('data-id')] = ins[i].value.trim();
        }
        function build() {
          var html = '<div class="modal-title">' + U.esc(title) + '</div><div class="form-body">';
          fields.forEach(function (f) {
            if (f.visible && !f.visible(values)) return;
            html += '<label class="form-row"><span class="form-label">' + U.esc(f.label) + '</span>';
            if (f.type === 'choice') {
              var opt = f.options.filter(function (o) { return o.v === values[f.id]; })[0] || f.options[0];
              html += '<div class="mf choice" data-id="' + f.id + '"><b>‹</b><span>' + U.esc(opt.l) + '</span><b>›</b></div>';
            } else {
              html += '<input class="mf" data-id="' + f.id + '" type="' + (f.type === 'password' ? 'password' : 'text') +
                '" value="' + U.esc(values[f.id]) + '" placeholder="' + U.esc(f.placeholder || '') + '" autocomplete="off" spellcheck="false">';
            }
            html += '</label>';
          });
          html += '</div><div class="btn-row"><div class="mf btn primary" data-row="b" data-v="save">' + I18n.t('save') +
            '</div><div class="mf btn" data-row="b" data-v="cancel">' + I18n.t('cancel') + '</div></div>';
          d.box.innerHTML = html;
          d.collect();
        }
        d.onChoice = function (el, dir) {
          readInputs();
          var id = el.getAttribute('data-id');
          var f = fields.filter(function (x) { return x.id === id; })[0];
          var i = 0;
          f.options.forEach(function (o, k) { if (o.v === values[id]) i = k; });
          values[id] = f.options[(i + dir + f.options.length) % f.options.length].v;
          var r = d.r;
          build();
          d.focus(r, 0);
        };
        d.onActivate = function (f) {
          if (f.classList.contains('choice')) { d.onChoice(f, 1); return; }
          var v = f.getAttribute('data-v');
          if (v === 'cancel') { d.close(); resolve(null); return; }
          if (v === 'save') {
            readInputs();
            var err = validate ? validate(values) : null;
            if (err) { U.toast(err); return; }
            d.close();
            resolve(values);
          }
        };
        d.onCancel = function () { resolve(null); };
        d.box.addEventListener('change', readInputs);
        build();
        d.show();
      });
    },

    /* blocking "loading" overlay */
    busy: function (text) {
      var d = new Dialog('busy');
      d.box.innerHTML = '<div class="spinner small"></div><div class="modal-text">' + U.esc(text || I18n.t('loading')) + '</div>';
      d.key = function () { return true; };
      d.show();
      return { close: function () { d.close(); }, text: function (t) { var x = d.box.querySelector('.modal-text'); if (x) x.textContent = t; } };
    }
  };

  window.Modal = Modal;
})();
