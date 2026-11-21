/* Programme reminders: OK on an upcoming programme stores one; a minute before it starts the app asks to switch.
   Works while the app is open (webOS gives an app no alarms of its own). */
(function () {
  'use strict';

  function now() { return Date.now(); }

  function all() {
    var t = now();
    return Store.list('reminders').filter(function (r) { return r && r.e > t; });
  }
  function save(l) { Store.setList('reminders', l); }

  function same(r, ch, p) { return r.key === ch.key && r.s === p.s; }

  function label(r) {
    return U.dayLabel(r.s) + ' ' + U.hhmm(r.s) + '  •  ' + r.ch + ' — ' + r.t;
  }

  /* play a channel full screen from anywhere in the app */
  function watch(ch) {
    App.checkLock(ch.group).then(function (ok) {
      if (!ok) return;
      if (Player.mode() === 'full' && Player.current()) { Player.channelKeyJump(ch); return; }
      var list = Data.liveList('__all');
      Player.playLive(ch, { full: true, list: list, index: Math.max(0, list.indexOf(ch)), listName: I18n.t('all_channels'), gid: '__all' });
    });
  }

  var busy = false;
  function check() {
    if (busy || Modal.isOpen()) return;
    var t = now(), l = all(), due = null;
    for (var i = 0; i < l.length; i++) if (l[i].s <= t + 60000) { due = l[i]; break; }
    if (due) l.splice(l.indexOf(due), 1);
    if (due || l.length !== Store.list('reminders').length) save(l);
    if (!due) return;
    var ch = Data.channel(due.key);
    if (!ch) return;
    busy = true;
    var when = due.s <= t ? I18n.t('rem_now') : I18n.t('rem_soon');
    Modal.confirm(ch.name + ': ' + due.t + ' (' + U.hhmm(due.s) + ') — ' + when, I18n.t('rem_watch'), I18n.t('rem_later')).then(function (y) {
      busy = false;
      if (y) watch(ch);
    });
  }

  var Reminders = {
    list: all,
    has: function (ch, p) {
      if (!ch || !p) return false;
      return all().some(function (r) { return same(r, ch, p); });
    },
    /* add or remove; returns true when it was added */
    toggle: function (ch, p) {
      if (!ch || !p) return false;
      var l = all(), had = false;
      l = l.filter(function (r) { if (same(r, ch, p)) { had = true; return false; } return true; });
      if (!had) {
        l.push({ key: ch.key, s: p.s, e: p.e, t: p.t || '', ch: ch.name });
        l.sort(function (a, b) { return a.s - b.s; });
      }
      save(l);
      U.toast(I18n.t(had ? 'rem_removed' : 'rem_set') + (had ? '' : ': ' + U.hhmm(p.s) + ' ' + (p.t || '')));
      return !had;
    },
    /* settings: list, pick one to delete */
    manage: function () {
      var l = all();
      if (!l.length) { U.toast(I18n.t('rem_none')); return Promise.resolve(); }
      return Modal.menu(I18n.t('reminders'), l.map(function (r, i) { return { label: label(r), icon: 'bell', value: i }; })).then(function (i) {
        if (i == null || !l[i]) return;
        return Modal.confirm(I18n.t('rem_delete') + '\n' + label(l[i])).then(function (y) {
          if (y) { var r = l[i]; save(all().filter(function (x) { return !(x.key === r.key && x.s === r.s); })); U.toast(I18n.t('rem_removed')); }
          return Reminders.manage();
        });
      });
    },
    start: function () { setInterval(check, 15000); setTimeout(check, 3000); }
  };

  window.Reminders = Reminders;
})();
