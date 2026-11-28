/*
 * TV side of the phone connection. On the TV the JS service (racing/service) runs the LAN server;
 * on a computer `node tools/racing-dev.js` runs the same server. The game talks to it over a
 * WebSocket on 127.0.0.1 (no Luna round trips per input).
 */
var Net = (function () {
  'use strict';

  var SERVICE = 'luna://com.ekrani.racing.service/';
  var ws = null, onEvent = null, code = '', host = '', port = 0, retry = 0, keep = [];

  function luna(uri, params, cb) {
    if (!window.PalmServiceBridge) { if (cb) cb(null); return null; }
    var b = new window.PalmServiceBridge();
    var sub = !!(params && params.subscribe);
    keep.push(b);   // a bridge must stay referenced while its call runs (a subscription: for good)
    b.onservicecallback = function (msg) {
      var r = null;
      try { r = JSON.parse(msg); } catch (e) { /* ignore */ }
      if (!sub) { var i = keep.indexOf(b); if (i >= 0) keep.splice(i, 1); }
      if (cb) cb(r);
    };
    b.call(uri, JSON.stringify(params || {}));
    return b;
  }

  function start(handler) {
    onEvent = handler;
    code = String(1000 + Math.floor(Math.random() * 9000));
    if (window.PalmServiceBridge) {
      startService();
      // keep the service from idling out even if the subscription is dropped
      setInterval(function () { luna(SERVICE + 'ping', {}, null); }, 30000);
      screenSaver();
    } else {
      // computer: the dev server tells where the game server is (?ws=host:port to override)
      var m = /[?&]ws=([^&]+)/.exec(location.search);
      var hp = m ? decodeURIComponent(m[1]).split(':') : [location.hostname, '8900'];
      host = hp[0]; port = +hp[1];
      connect();
    }
  }

  function startService() {
    luna(SERVICE + 'start', { subscribe: true }, function (r) {
      if (!r || r.returnValue === false) {
        if (onEvent) onEvent({ t: 'neterr', e: (r && r.errorText) || 'service' });
        setTimeout(startService, 3000);
        return;
      }
      if (r.port && !ws) { host = '127.0.0.1'; port = r.port; connect(); }
    });
  }

  function connect() {
    clearTimeout(retry);
    try { ws = new WebSocket('ws://' + host + ':' + port + '/tv'); } catch (e) { return again(); }
    ws.onopen = function () { ws.send(JSON.stringify({ t: 'hello', code: code })); };
    ws.onmessage = function (e) {
      var m; try { m = JSON.parse(e.data); } catch (x) { return; }
      if (onEvent) onEvent(m);
    };
    ws.onclose = function () {
      ws = null;
      if (onEvent) onEvent({ t: 'down' });
      again();
    };
  }
  function again() {
    clearTimeout(retry);
    retry = setTimeout(function () {
      if (!window.PalmServiceBridge) return connect();
      // the service may have been restarted: make sure the server runs, then connect
      luna(SERVICE + 'start', {}, function (r) {
        if (r && r.port) { host = '127.0.0.1'; port = r.port; }
        connect();
      });
    }, 1500);
  }

  function raw(o) { if (ws && ws.readyState === 1) ws.send(JSON.stringify(o)); }

  /* webOS: keep the screen saver away while people play with phones (no remote key presses).
     Two ways: answer the TV's screen saver request with "no" (if the TV lets this app ask), and play a
     tiny black video hidden behind the canvas (the TV does not start the screen saver during video). */
  var ssOn = true, ssState = '-', ssAsked = 0;
  function screenSaver() {
    var id = 'com.ekrani.racing';
    ssState = '…';
    luna('luna://com.webos.service.tvpower/power/registerScreenSaverRequest', { subscribe: true, clientName: id }, function (r) {
      if (!r) { ssState = '?'; return; }
      if (r.returnValue === false) { ssState = 'x' + (r.errorCode !== undefined ? r.errorCode : ''); return; }
      if (!r.timestamp) { ssState = 'ok'; return; }
      ssAsked++;
      luna('luna://com.webos.service.tvpower/power/responseScreenSaverRequest', { clientName: id, ack: ssOn, timestamp: r.timestamp }, null);
    });
  }

  var vid = null, vidState = '-';
  function keepAwake(on) {
    if (!vid) {
      if (!on) return;
      vid = document.createElement('video');
      vid.muted = true; vid.loop = true;
      vid.setAttribute('muted', ''); vid.setAttribute('playsinline', '');
      vid.style.cssText = 'position:fixed;left:0;bottom:0;width:2px;height:2px;z-index:-1;pointer-events:none';
      vid.src = 'media/keep.mp4';
      vid.onerror = function () { vidState = 'err' + (vid.error ? vid.error.code : ''); };
      vid.onplaying = function () { vidState = 'on'; };
      vid.onpause = function () { if (vidState === 'on') vidState = 'off'; };
      document.body.insertBefore(vid, document.body.firstChild);
    }
    if (on && vid.paused) {
      var p = vid.play();
      if (p && p.catch) p.catch(function (e) { vidState = 'blocked'; });
    } else if (!on && !vid.paused) vid.pause();
  }

  return {
    start: start,
    code: function () { return code; },
    to: function (id, m) { if (typeof id === 'number') raw({ t: 'to', id: id, m: m }); },
    all: function (m) { raw({ t: 'all', m: m }); },
    kick: function (id) { raw({ t: 'kick', id: id }); },
    allowScreenSaver: function (on) { ssOn = on; keepAwake(!on); },
    awake: function () { return 'ss ' + ssState + (ssAsked ? '/' + ssAsked : '') + ' · vid ' + vidState; },
    online: function () { return !!(ws && ws.readyState === 1); }
  };
})();
