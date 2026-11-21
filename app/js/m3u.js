/* M3U / M3U8 (extended) playlist parser + catch-up URL builder. */
(function () {
  'use strict';

  var ATTR_RE = /([\w-]+)=("([^"]*)"|'([^']*)'|([^\s,]+))/g;

  function attrs(str) {
    var out = {}, m;
    ATTR_RE.lastIndex = 0;
    while ((m = ATTR_RE.exec(str))) {
      out[m[1].toLowerCase()] = m[3] != null ? m[3] : (m[4] != null ? m[4] : m[5]);
    }
    return out;
  }

  /* split '#EXTINF:-1 a="x, y" b="z",Channel name' into attribute part + title */
  function splitExtinf(line) {
    var body = line.slice(line.indexOf(':') + 1);
    var inQ = false, q = '';
    for (var i = 0; i < body.length; i++) {
      var c = body[i];
      if (inQ) { if (c === q) inQ = false; }
      else if (c === '"' || c === "'") { inQ = true; q = c; }
      else if (c === ',') return { attrs: body.slice(0, i), title: body.slice(i + 1).trim() };
    }
    return { attrs: body, title: '' };
  }

  function kindOf(url, group) {
    if (/\/movie\//i.test(url)) return 'movie';
    if (/\/series\//i.test(url)) return 'series';
    if (/\.(mp4|mkv|avi|mov)(\?|$)/i.test(url) && !/\/live\//i.test(url)) return 'movie';
    return 'live';
  }

  /* archive type when the playlist only says how many days are recorded:
     Flussonic servers (…/index.m3u8, …/mono.m3u8, …/video.m3u8, …/mpegts) get their own
     URL scheme, everything else the common ?utc=…&lutc=… query */
  function guessCatchup(url) {
    var path = url.split('?')[0];
    if (/\/(index|video|mono)\.m3u8$/i.test(path) || /\/mpegts$/i.test(path)) return 'flussonic';
    return 'shift';
  }

  function parse(text) {
    var lines = text.split(/\r?\n/);
    var header = {};
    var items = [];
    var cur = null;
    var curGroup = null;
    for (var i = 0; i < lines.length; i++) {
      var line = lines[i].trim();
      if (!line) continue;
      if (line.charAt(0) === '#') {
        var up = line.slice(0, 10).toUpperCase();
        if (up.indexOf('#EXTM3U') === 0) {
          header = attrs(line.slice(7));
        } else if (up.indexOf('#EXTINF') === 0) {
          var sp = splitExtinf(line);
          cur = { a: attrs(sp.attrs), title: sp.title };
        } else if (up.indexOf('#EXTGRP') === 0) {
          curGroup = line.slice(line.indexOf(':') + 1).trim();
        }
        continue;
      }
      // URL line
      if (!cur) cur = { a: {}, title: line };
      var a = cur.a;
      var group = a['group-title'] || curGroup || '';
      var name = cur.title || a['tvg-name'] || line;
      var catchupType = a.catchup || a['catchup-type'] || header.catchup || '';
      var recDays = a['tvg-rec'] != null ? a['tvg-rec'] : (a.timeshift != null ? a.timeshift : null);
      var days = parseInt(a['catchup-days'] || recDays || header['catchup-days'] || 0, 10) || 0;
      // tvg-rec / timeshift = archive depth in days without an explicit type ("0" = no archive)
      if (!catchupType && recDays != null) catchupType = days > 0 ? guessCatchup(line) : '';
      if (/^(0|false|no|none|disabled?)$/i.test(catchupType)) catchupType = '';
      items.push({
        key: line,
        name: name,
        logo: a['tvg-logo'] || a.logo || '',
        group: group,
        url: line,
        tvgId: a['tvg-id'] || '',
        tvgName: a['tvg-name'] || '',
        chno: parseInt(a['tvg-chno'] || a['channel-number'] || 0, 10) || 0,
        catchup: catchupType ? {
          type: catchupType.toLowerCase(),
          days: days || 3,
          source: a['catchup-source'] || header['catchup-source'] || ''
        } : null,
        kind: kindOf(line, group)
      });
      cur = null;
      curGroup = null;
    }
    var epg = header['url-tvg'] || header['x-tvg-url'] || header['tvg-url'] || '';
    return { items: items, epgUrls: epg ? epg.split(',').map(function (s) { return s.trim(); }).filter(Boolean) : [] };
  }

  /* ---------- catch-up URL templates ---------- */
  function fill(tpl, start, end) {
    var s = new Date(start), e = new Date(end);
    var su = Math.floor(start / 1000), eu = Math.floor(end / 1000);
    var now = Math.floor(Date.now() / 1000);
    var dur = eu - su;
    var p = U.pad;
    function fmt(d, f) {
      return f.replace(/yyyy|YYYY/g, d.getFullYear()).replace(/MM/g, p(d.getMonth() + 1)).replace(/dd/g, p(d.getDate()))
        .replace(/HH/g, p(d.getHours())).replace(/mm/g, p(d.getMinutes())).replace(/ss/g, p(d.getSeconds()));
    }
    return tpl
      .replace(/\$\{\(b\)([^}]+)\}/g, function (_, f) { return fmt(s, f); })
      .replace(/\$\{\(e\)([^}]+)\}/g, function (_, f) { return fmt(e, f); })
      .replace(/\{utc:([^}]+)\}/g, function (_, f) { return fmt(s, f); })
      .replace(/\{utcend:([^}]+)\}/g, function (_, f) { return fmt(e, f); })
      .replace(/\$\{start\}|\{utc\}|\{start\}|\$\{timestamp\}|\{timestamp\}/g, su)
      .replace(/\$\{end\}|\{utcend\}|\{end\}/g, eu)
      .replace(/\$\{offset\}|\{offset\}/g, now - su)
      .replace(/\$\{duration\}|\{duration\}/g, dur)
      .replace(/\{duration:(\d+)\}/g, function (_, d) { return Math.floor(dur / parseInt(d, 10)); })
      .replace(/\$\{now\}|\{lutc\}|\{now\}/g, now)
      .replace(/\{Y\}/g, s.getFullYear()).replace(/\{m\}/g, p(s.getMonth() + 1)).replace(/\{d\}/g, p(s.getDate()))
      .replace(/\{H\}/g, p(s.getHours())).replace(/\{M\}/g, p(s.getMinutes())).replace(/\{S\}/g, p(s.getSeconds()));
  }

  function catchupUrl(ch, start, end) {
    var c = ch.catchup;
    if (!c) return null;
    var url = ch.url;
    var su = Math.floor(start / 1000), dur = Math.floor((end - start) / 1000);
    switch (c.type) {
      case 'default':
        if (c.source && !/^https?:/i.test(c.source)) return url + fill(c.source, start, end);
        return c.source ? fill(c.source, start, end) : url + (url.indexOf('?') >= 0 ? '&' : '?') + 'utc=' + su + '&lutc=' + Math.floor(Date.now() / 1000);
      case 'append':
        return url + fill(c.source || '?utc={utc}&lutc={lutc}', start, end);
      case 'shift':
      case 'timeshift':
      case 'archive':
        return url + (url.indexOf('?') >= 0 ? '&' : '?') + 'utc=' + su + '&lutc=' + Math.floor(Date.now() / 1000);
      case 'flussonic':
      case 'flussonic-hls':
      case 'flussonic-ts':
      case 'fs':
        if (/\/(index|video|mono)\.m3u8/.test(url)) {
          return url.replace(/\/(index|video|mono)\.m3u8/, '/$1-' + su + '-' + dur + '.m3u8');
        }
        if (/\/mpegts/.test(url)) return url.replace(/\/mpegts/, '/timeshift_abs-' + su + '.ts');
        return url.replace(/\/([^\/?]+)(\?|$)/, '/timeshift_abs-' + su + '.ts$2');
      case 'xc':
        var m = /^(https?:\/\/[^\/]+)\/(?:live\/)?([^\/]+)\/([^\/]+)\/(\d+)(\.\w+)?/.exec(url);
        if (!m) return null;
        var d = new Date(start), p = U.pad;
        var ts = d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) + ':' + p(d.getHours()) + '-' + p(d.getMinutes());
        return m[1] + '/timeshift/' + m[2] + '/' + m[3] + '/' + Math.ceil(dur / 60) + '/' + ts + '/' + m[4] + (m[5] || '.ts');
      default:
        return c.source ? fill(c.source, start, end) : null;
    }
  }

  window.M3U = { parse: parse, catchupUrl: catchupUrl };
})();
