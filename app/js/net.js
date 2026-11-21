/* Network: direct XHR first, then the on-TV Node service (no CORS limits, gunzips .gz). */
(function () {
  'use strict';

  var SERVICE = 'luna://com.ekrani.iptv.service/';
  var bridges = [];
  var preferService = {}; // host -> true when direct XHR failed before

  function luna(method, params) {
    return new Promise(function (resolve, reject) {
      if (!window.PalmServiceBridge) return reject(new Error('no luna bridge'));
      var b = new window.PalmServiceBridge();
      bridges.push(b);
      var done = function () { var i = bridges.indexOf(b); if (i >= 0) bridges.splice(i, 1); };
      b.onservicecallback = function (msg) {
        done();
        var r;
        try { r = JSON.parse(msg); } catch (e) { return reject(e); }
        if (r.returnValue === false) reject(new Error(r.errorText || 'service error'));
        else resolve(r);
      };
      b.call(SERVICE + method, JSON.stringify(params || {}));
    });
  }

  function viaService(url, onProgress) {
    return luna('fetch', { url: url }).then(function (head) {
      if (head.status >= 400) {
        var err = new Error('HTTP ' + head.status);
        err.status = head.status;
        // small error bodies (API messages) are kept so callers can show them
        if (!head.size || head.size > 65536) throw err;
        return luna('chunk', { id: head.id, offset: 0, length: head.size }).then(function (r) { err.body = r.data; throw err; }, function () { throw err; });
      }
      var parts = [];
      var offset = 0;
      var CH = 1024 * 1024;
      function next() {
        return luna('chunk', { id: head.id, offset: offset, length: CH }).then(function (r) {
          parts.push(r.data);
          offset += CH;
          if (onProgress) onProgress(Math.min(1, offset / (head.size || 1)));
          return r.done ? parts.join('') : next();
        });
      }
      return head.size ? next() : '';
    });
  }

  function isRemote(url) { return /^https?:\/\//i.test(url); }
  function hostOf(url) { var m = /^https?:\/\/([^\/?#]+)/i.exec(url); return m ? m[1] : ''; }

  function xhr(url, timeout) {
    return new Promise(function (resolve, reject) {
      var x = new XMLHttpRequest();
      x.open('GET', url, true);
      x.timeout = timeout || 60000;
      x.onload = function () {
        // a file inside the app package (file://) loads with status 0
        if ((x.status >= 200 && x.status < 400) || (x.status === 0 && !isRemote(url) && x.responseText)) resolve(x.responseText);
        else { var e = new Error('HTTP ' + x.status); e.status = x.status; e.body = x.responseText; reject(e); }
      };
      x.onerror = function () { var e = new Error('network'); e.status = 0; reject(e); };
      x.ontimeout = function () { var e = new Error('timeout'); e.status = -1; reject(e); };
      x.send();
    });
  }

  function looksGz(url) { return /\.gz($|\?)/i.test(url); }

  /* fetch a text resource; gz files and CORS-blocked hosts go through the service */
  function text(url, opts) {
    opts = opts || {};
    var host = hostOf(url);
    var hasService = !!window.PalmServiceBridge && isRemote(url);   // files of the app itself: never the service
    if (hasService && (preferService[host] || looksGz(url))) {
      return viaService(url, opts.onProgress);
    }
    return xhr(url, opts.timeout).catch(function (err) {
      if (hasService && err.status === 0) {
        preferService[host] = true;
        return viaService(url, opts.onProgress);
      }
      throw err;
    });
  }

  function json(url, opts) {
    return text(url, opts).then(function (t) {
      if (!t) return null;
      try { return JSON.parse(t); } catch (e) { throw new Error('Bad JSON'); }
    });
  }

  window.Net = { text: text, json: json, luna: luna };
})();
