/* Phone setup: the TV service serves a small form in the home network; the TV shows its address
   as a QR code and polls for what the phone sends. Plain HTTP inside the LAN, guarded by a 4-digit code. */
(function () {
  'use strict';

  var poll = null, dlg = null;

  function texts() {
    return {
      title: I18n.t('lan_page_title'), type: I18n.t('pl_type'), m3u: I18n.t('m3u_url'), xtream: I18n.t('xtream'),
      name: I18n.t('pl_name'), url: I18n.t('pl_url'), server: I18n.t('pl_server'), user: I18n.t('pl_user'), pass: I18n.t('pl_pass'),
      epg: I18n.t('pl_epg'), epgHint: I18n.t('epg_sources_hint'), codeHint: I18n.t('lan_code_hint'), send: I18n.t('lan_send'),
      sent: I18n.t('lan_sent'), badCode: I18n.t('lan_bad_code'),
      ytTitle: I18n.t('lan_yt_title'), ytKey: I18n.t('lan_yt_key'), ytChannels: I18n.t('lan_yt_channels')
    };
  }

  /* the QR library (~57 KB) is only needed here: load it on first use, not at every start */
  var qrLib = null;
  function loadQr() {
    if (window.qrcode) return Promise.resolve();
    if (!qrLib) {
      qrLib = new Promise(function (resolve, reject) {
        var s = document.createElement('script');
        s.src = 'js/lib/qrcode.js';
        s.onload = function () { resolve(); };
        s.onerror = function () { qrLib = null; reject(new Error('qrcode.js')); };
        document.head.appendChild(s);
      });
    }
    return qrLib;
  }

  function qrSvg(text) {
    var q = qrcode(0, 'M');
    q.addData(text);
    q.make();
    return q.createSvgTag({ cellSize: 6, margin: 0, scalable: true });
  }

  function stop() {
    clearInterval(poll); poll = null;
    Net.luna('lanStop', {})['catch'](function () {});
  }

  function available() { return !!window.PalmServiceBridge; }

  /*
   * Shows the QR dialog and waits for the phone.
   * opts: { title, intro (html above the QR), buttons: [{v,l,primary}], mode: 'yt' for the YouTube key/channels form }.
   * Resolves with { item } when the phone sent a playlist, with a button's v when one was pressed,
   * null on Back, or 'fail' when the page could not be started (no network / not on the TV).
   */
  function session(opts) {
    opts = opts || {};
    if (!available()) return Promise.resolve('fail');
    var code = String(1000 + Math.floor(Math.random() * 9000));
    var start = { code: code, texts: texts(), mode: opts.mode || 'playlist' };
    return Promise.all([Net.luna('lanStart', start), loadQr()]).then(function (res) {
      var r = res[0];
      if (!r.ip) throw new Error('no network');
      var url = 'http://' + r.ip + ':' + r.port + '/';
      var html = (opts.intro || '') + '<div class="lan-box"><div class="lan-qr">' + qrSvg(url) + '</div><div class="lan-text">' + U.esc(I18n.t('lan_scan')) +
        '<div class="lan-url">' + U.esc(url) + '</div><div class="lan-code">' + U.esc(I18n.t('lan_code')) + ':<b>' + code + '</b></div></div></div>';
      return new Promise(function (resolve) {
        var done = false;
        function finish(v) { if (done) return; done = true; dlg = null; stop(); resolve(v); }
        Modal.buttons(opts.title || I18n.t('lan_setup'), html, opts.buttons || [{ v: 'close', l: I18n.t('close'), primary: true }]).then(finish);
        dlg = Modal.top();
        clearInterval(poll);
        poll = setInterval(function () {
          Net.luna('lanPoll', {}).then(function (res) {
            var it = res.items && res.items[0];
            if (!it || done) return;
            if (dlg) { dlg.close(); dlg = null; }
            U.toast(I18n.t('lan_received'));
            finish({ item: it.type === 'yt' ? { type: 'yt', key: it.key, channels: it.channels }
              : { type: it.type, name: it.name, url: it.url, server: it.server, user: it.user, pass: it.pass, epg: it.epg } });
          })['catch'](function () { /* service restarted: ask again next tick */ Net.luna('lanStart', start)['catch'](function () {}); });
        }, 2000);
      });
    })['catch'](function (e) {
      U.toast(I18n.t('lan_failed') + (e && e.message ? ': ' + e.message : ''), 5000);
      return 'fail';
    });
  }

  var Lan = {
    available: available,
    session: session,
    /* from Settings: on success open the normal playlist form, prefilled, to check it on the TV before saving */
    open: function () {
      if (!available()) { U.toast(I18n.t('lan_tv_only')); return; }
      session().then(function (r) { if (r && r.item) App.editPlaylist(r.item); });
    },
    stop: stop
  };

  window.Lan = Lan;
})();
