/* Start-up loader. Runs the app code that came with the installed package, or a newer copy downloaded
   from GitHub (Settings-free update, see update.js). This file is part of the package itself and is never
   replaced by an update; the build stamps NATIVE with the package version and the hash of the parts
   an update cannot change (service, index.html, this file, fonts, images). */
(function () {
  'use strict';
  var NATIVE = /*@NATIVE*/{ "v": "", "h": "" }/*@END*/;
  // the app's scripts in load order (the build concatenates them in this order for an update)
  var FILES = [
    "js/util.js", "js/i18n.js", "js/store.js", "js/net.js", "js/m3u.js", "js/xtream.js", "js/epg.js", "js/data.js",
    "js/vlist.js", "js/modal.js", "js/player.js", "js/ytplayer.js", "js/ytchannels.js", "js/reminders.js", "js/lan.js",
    "js/update.js",
    "js/screens/live.js", "js/screens/guide.js", "js/screens/youtube.js", "js/screens/search.js", "js/screens/settings.js",
    "js/app.js"
  ];
  var P = 'ekrani.ota';

  function parts(v) { return String(v || '').split('.').map(function (x) { return parseInt(x, 10) || 0; }); }
  /* true when version a is newer than b */
  function newer(a, b) {
    var x = parts(a), y = parts(b);
    for (var i = 0; i < Math.max(x.length, y.length); i++) {
      if ((x[i] || 0) !== (y[i] || 0)) return (x[i] || 0) > (y[i] || 0);
    }
    return false;
  }

  function get(k) { try { return localStorage.getItem(k); } catch (e) { return null; } }
  function set(k, v) { try { localStorage.setItem(k, v); } catch (e) { /* ignore */ } }
  function drop() { try { [P, P + '.js', P + '.css', P + '.tries'].forEach(function (k) { localStorage.removeItem(k); }); } catch (e) { /* ignore */ } }

  /* a downloaded update is used when it is newer than the package and was made for this package */
  var ota = null;
  try {
    var meta = JSON.parse(get(P) || 'null');
    if (meta && NATIVE.v && newer(meta.v, NATIVE.v) && meta.h === NATIVE.h) {
      var tries = +(get(P + '.tries') || 0);
      if (tries >= 2) drop();   // it failed to start twice: back to the installed version
      else {
        var js = get(P + '.js'), css = get(P + '.css');
        if (js && css) { set(P + '.tries', String(tries + 1)); ota = { v: meta.v, js: js, css: css }; }
        else drop();
      }
    } else if (meta) drop();      // the package was updated past it (or it belongs to another package)
  } catch (e) { drop(); }

  window.Boot = {
    native: NATIVE,
    ota: ota ? ota.v : null,
    newer: newer,
    files: FILES,

    css: function () {
      if (ota) {
        var s = document.createElement('style');
        s.textContent = ota.css;
        document.head.appendChild(s);
      } else document.write('<link rel="stylesheet" href="css/app.css">');
    },

    js: function () {
      if (ota) {
        var s = document.createElement('script');
        s.text = ota.js;
        document.body.appendChild(s);   // runs at once, before 'load'
        ota.js = ota.css = null;
      } else {
        var h = '';
        FILES.forEach(function (f) { h += '<script src="' + f + '"><\/script>'; });
        document.write(h);
      }
    },

    /* the app came up: the update (if any) is good */
    started: function () { try { localStorage.removeItem(P + '.tries'); } catch (e) { /* ignore */ } },

    /* store a downloaded update; it is used from the next start */
    install: function (v, h, js, css) {
      try {
        localStorage.setItem(P + '.js', js);
        localStorage.setItem(P + '.css', css);
        localStorage.setItem(P, JSON.stringify({ v: v, h: h, t: Date.now() }));
        localStorage.removeItem(P + '.tries');
        return true;
      } catch (e) {
        drop();
        return false;
      }
    }
  };
})();
