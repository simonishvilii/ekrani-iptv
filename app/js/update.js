/* App updates from GitHub: checks ota/version.json at start and every few hours; a newer version is offered
   on screen and, when accepted, downloaded and started (js/boot.js runs it from then on). */
(function () {
  'use strict';

  var BASE = 'https://raw.githubusercontent.com/simonishvilii/ekrani-iptv/main/ota/';
  var FIRST = 8000, EVERY = 3 * 3600000;
  var declined = {};     // versions answered "No" in this session
  var busy = false, timer = null;

  function boot() { return window.Boot || { native: { v: '', h: '' }, newer: function () { return false; } }; }

  function fetchText(name) {
    return Net.text(BASE + name + '?t=' + Date.now(), { timeout: 60000 });
  }

  /* the app is in a state where a question may pop up */
  function quiet() { return !Modal.isOpen() && !(window.YtPlayer && YtPlayer.isOpen()); }

  function later(ms) { clearTimeout(timer); timer = setTimeout(check, ms); }

  /* manual: from Settings — always answers, also "you have the latest" */
  function check(manual) {
    if (busy) return;
    busy = true;
    if (manual === true) U.toast(I18n.t('upd_checking'));
    fetchText('version.json').then(function (t) {
      var r = JSON.parse(t);
      busy = false;
      if (!r || !r.version || !boot().newer(r.version, App.version) || (declined[r.version] && manual !== true)) {
        if (manual === true) U.toast(I18n.t('upd_latest') + ' (' + App.version + ')', 3000);
        later(EVERY);
        return;
      }
      if (!quiet()) { later(60000); return; }   // a dialog is open: ask a little later
      offer(r, manual === true);
    })['catch'](function (e) {
      busy = false;
      console.warn('update check failed', e);
      if (manual === true) U.toast(I18n.t('upd_failed'), 3000);
      later(EVERY);
    });
  }

  function offer(r, manual) {
    var b = boot();
    // parts the update cannot change (TV service, icons, fonts…) differ: only a new install from the PC helps
    if (!b.native.h || r.native !== b.native.h) {
      var seen = Store.get('updNative');
      if (seen !== r.version || manual) {
        Store.set('updNative', r.version);
        Modal.alert(I18n.t('upd_title'), U.esc(I18n.t('upd_native').replace('{v}', r.version)));
      }
      later(EVERY);
      return;
    }
    Modal.confirm(I18n.t('upd_q').replace('{v}', r.version), I18n.t('resume_yes'), I18n.t('resume_no')).then(function (yes) {
      if (!yes) { declined[r.version] = true; later(EVERY); return; }
      install(r);
    });
  }

  function install(r) {
    var bz = Modal.busy(I18n.t('upd_loading'));
    Promise.all([fetchText(r.js || 'app.js'), fetchText(r.css || 'app.css')]).then(function (f) {
      var js = f[0], css = f[1];
      // whole files of this very version, or nothing
      if (!js || !css || (r.jsLen && js.length !== r.jsLen) || (r.cssLen && css.length !== r.cssLen) || js.indexOf(r.version) < 0) {
        throw new Error(I18n.t('upd_bad'));
      }
      if (!boot().install(r.version, r.native, js, css)) throw new Error(I18n.t('upd_space'));
      bz.close();
      U.toast(I18n.t('upd_done'), 3000);
      setTimeout(function () {
        try { Player.stop(); } catch (e) { /* ignore */ }
        location.reload();
      }, 1200);
    })['catch'](function (e) {
      bz.close();
      Modal.alert(I18n.t('upd_title'), U.esc(I18n.t('upd_failed') + (e && e.message ? ': ' + e.message : '')));
      later(EVERY);
    });
  }

  window.Update = {
    start: function () { later(FIRST); },
    check: check,
    /* version shown in Settings */
    label: function () { var b = boot(); return App.version + (b.ota ? ' (' + I18n.t('upd_ota') + ')' : ''); }
  };
})();
