/* Xtream Codes API client. */
(function () {
  'use strict';

  function normBase(s) {
    s = String(s || '').trim().replace(/\/+$/, '');
    s = s.replace(/\/(player_api\.php|get\.php|c)$/i, '');
    if (!/^https?:\/\//i.test(s)) s = 'http://' + s;
    return s;
  }

  function Xtream(pl) {
    this.base = normBase(pl.server);
    this.user = encodeURIComponent(pl.user || '');
    this.pass = encodeURIComponent(pl.pass || '');
    this.tz = null;
    this.info = null;
  }

  Xtream.normBase = normBase;

  Xtream.prototype.api = function (action, extra) {
    var url = this.base + '/player_api.php?username=' + this.user + '&password=' + this.pass;
    if (action) url += '&action=' + action;
    if (extra) Object.keys(extra).forEach(function (k) { url += '&' + k + '=' + encodeURIComponent(extra[k]); });
    return Net.json(url);
  };

  Xtream.prototype.auth = function () {
    var self = this;
    return this.api('').then(function (r) {
      if (!r || !r.user_info) throw new Error('Bad server response');
      if (String(r.user_info.auth) === '0') throw new Error('Authorization failed');
      self.info = r;
      self.tz = (r.server_info && r.server_info.timezone) || null;
      return r;
    });
  };

  Xtream.prototype.liveCategories = function () { return this.api('get_live_categories'); };
  Xtream.prototype.liveStreams = function () { return this.api('get_live_streams'); };
  Xtream.prototype.epgTable = function (id) { return this.api('get_simple_data_table', { stream_id: id }); };
  Xtream.prototype.liveUrl = function (id, fmt) {
    return this.base + '/live/' + this.user + '/' + this.pass + '/' + id + '.' + (fmt || 'm3u8');
  };

  /* start time must be written in the server's own timezone */
  Xtream.prototype.fmtServerTime = function (ms) {
    var p = U.pad;
    if (this.tz) {
      try {
        var parts = new Intl.DateTimeFormat('en-GB', {
          timeZone: this.tz, year: 'numeric', month: '2-digit', day: '2-digit',
          hour: '2-digit', minute: '2-digit', hourCycle: 'h23'
        }).formatToParts(new Date(ms));
        var o = {};
        parts.forEach(function (x) { o[x.type] = x.value; });
        return o.year + '-' + o.month + '-' + o.day + ':' + o.hour + '-' + o.minute;
      } catch (e) { /* unknown tz -> local time */ }
    }
    var d = new Date(ms);
    return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) + ':' + p(d.getHours()) + '-' + p(d.getMinutes());
  };

  Xtream.prototype.timeshiftUrl = function (id, start, end, fmt) {
    var dur = Math.max(1, Math.ceil((end - start) / 60000));
    return this.base + '/timeshift/' + this.user + '/' + this.pass + '/' + dur + '/' +
      this.fmtServerTime(start) + '/' + id + '.' + (fmt || 'ts');
  };

  window.Xtream = Xtream;
})();
