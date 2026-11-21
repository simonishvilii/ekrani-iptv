/* Loaded content of the active playlist (live channels) + the YouTube section's lists. */
(function () {
  'use strict';

  var D = {
    pl: null, xt: null, info: null,
    live: [], byKey: {}, groups: [],
    base: [], all: [],      // playlist order / after user edits (incl. hidden)
    loaded: false
  };

  function groupBy(items) {
    var map = {}, order = [];
    items.forEach(function (c) {
      var g = c.group || '—';
      if (!map[g]) { map[g] = []; order.push(g); }
      map[g].push(c);
    });
    return order.map(function (g) { return { id: g, name: g, items: map[g] }; });
  }

  function fresh(c) {
    var h = Store.get('updateHours');
    return c && h > 0 && Date.now() - c.time < h * 3600000;
  }

  function loadM3U(pl, force) {
    var key = 'pl:' + pl.id;
    return Cache.get(key).then(function (c) {
      if (!force && fresh(c) && c.url === pl.url) return c.data;
      return Net.text(pl.url).then(function (txt) {
        if (!/#EXTINF/i.test(txt)) throw new Error('Not an M3U playlist');
        var data = M3U.parse(txt);
        Cache.set(key, { time: Date.now(), url: pl.url, data: data });
        return data;
      }).catch(function (e) {
        // a playlist file of a test build that a later package no longer has: its last copy, quietly
        if (c && !/^https?:\/\//i.test(pl.url)) return c.data;
        if (c) { U.toast(I18n.t('load_error') + ': ' + e.message); return c.data; }
        throw e;
      });
    }).then(function (data) {
      // films / series entries of a playlist are not shown (the app has no such sections)
      D.live = data.items.filter(function (it) { return it.kind !== 'movie' && it.kind !== 'series'; });
      return { epgUrls: pl.epg ? epgSources(pl.epg) : (data.epgUrls || []) };
    });
  }

  function loadXtream(pl, force) {
    var xt = new Xtream(pl);
    D.xt = xt;
    var key = 'pl:' + pl.id;
    return Cache.get(key).then(function (c) {
      var sig = xt.base + '|' + pl.user;
      if (!force && fresh(c) && c.sig === sig) {
        xt.info = c.data.info;
        xt.tz = c.data.info && c.data.info.server_info ? c.data.info.server_info.timezone : null;
        // refresh account info in the background (expiry etc.)
        xt.auth().then(function (r) { D.info = r; }).catch(function () {});
        return c.data;
      }
      return xt.auth().then(function (info) {
        return Promise.all([
          xt.liveCategories().catch(function () { return []; }),
          xt.liveStreams()
        ]).then(function (r) {
          var data = { info: info, liveCats: r[0] || [], live: r[1] || [] };
          Cache.set(key, { time: Date.now(), sig: sig, data: data });
          return data;
        });
      }).catch(function (e) {
        if (c) { U.toast(I18n.t('load_error') + ': ' + e.message); xt.info = c.data.info; return c.data; }
        throw e;
      });
    }).then(function (data) {
      D.info = data.info;
      var catName = {};
      (data.liveCats || []).forEach(function (c) { catName[c.category_id] = c.category_name; });
      var catOrder = {};
      (data.liveCats || []).forEach(function (c, i) { catOrder[c.category_id] = i; });
      var list = (data.live || []).slice();
      list.sort(function (a, b) {
        var ca = catOrder[a.category_id], cb = catOrder[b.category_id];
        if (ca !== cb) return (ca == null ? 1e9 : ca) - (cb == null ? 1e9 : cb);
        return (parseInt(a.num, 10) || 0) - (parseInt(b.num, 10) || 0);
      });
      D.live = list.map(function (s) {
        var arch = String(s.tv_archive) === '1';
        return {
          key: 'x' + s.stream_id,
          streamId: s.stream_id,
          name: s.name || '',
          logo: s.stream_icon || '',
          group: catName[s.category_id] || '—',
          tvgId: s.epg_channel_id || '',
          tvgName: '',
          chno: parseInt(s.num, 10) || 0,
          catchup: arch ? { type: 'xtream', days: parseInt(s.tv_archive_duration, 10) || 3 } : null,
          kind: 'live'
        };
      });
      return { epgUrls: pl.epg ? epgSources(pl.epg) : [] };
    });
  }

  /* "url1 +2, url2" -> [{url, shift(hours)}]; the order is the priority */
  function epgSources(str) {
    var out = [];
    String(str || '').split(/[\s,;]+/).forEach(function (t) {
      if (!t) return;
      if (/^[+-]\d+(\.\d+)?h?$/i.test(t)) { if (out.length) out[out.length - 1].shift = parseFloat(t); return; }
      if (/^https?:\/\//i.test(t)) out.push({ url: t, shift: 0 });
    });
    return out;
  }

  /* ---- channel editor: names, groups, hidden, order, guide from another channel ---- */
  function applyEdits() {
    var ed = Store.map('chedit'), order = Store.list('chorder'), pos = {};
    order.forEach(function (k, i) { pos[k] = i; });
    D.base.forEach(function (c, i) {
      var e = ed[c.key] || {};
      c.name = e.name || c.orig.name;
      c.group = e.group || c.orig.group;
      c.hidden = !!e.hidden;
      c.epgFrom = e.epg && D.byKey[e.epg] ? e.epg : '';
      c._i = i;
    });
    var all = D.base.slice();
    if (order.length) {
      all.sort(function (a, b) {
        var pa = a.key in pos ? pos[a.key] : 1e9 + a._i, pb = b.key in pos ? pos[b.key] : 1e9 + b._i;
        return pa - pb;
      });
    }
    D.all = all;
    D.live = all.filter(function (c) { return !c.hidden; });
    D.live.forEach(function (c, i) { c.num = c.chno || (i + 1); });
    D.groups = groupBy(D.live);
  }

  function saveEdit(key, patch) {
    var ed = Store.map('chedit'), e = ed[key] || {};
    Object.keys(patch).forEach(function (k) { e[k] = patch[k]; });
    Object.keys(e).forEach(function (k) { if (!e[k]) delete e[k]; });
    var c = D.byKey[key];
    if (c && e.name === c.orig.name) delete e.name;
    if (c && e.group === c.orig.group) delete e.group;
    if (Object.keys(e).length) ed[key] = e; else delete ed[key];
    Store.setMap('chedit', ed);
  }

  var Data = {
    state: D,

    load: function (force) {
      var pl = Store.active();
      D.pl = pl; D.xt = null; D.info = null; D.loaded = false;
      D.live = []; D.byKey = {}; D.groups = []; D.base = []; D.all = [];
      if (!pl) return Promise.resolve(false);
      var p = pl.type === 'xtream' ? loadXtream(pl, force) : loadM3U(pl, force);
      return p.then(function (r) {
        var used = {};
        D.live.forEach(function (c, i) {
          if (used[c.key]) c.key = c.key + '#' + i; // same URL twice in a playlist
          used[c.key] = true;
          c.orig = { name: c.name, group: c.group };
          D.byKey[c.key] = c;
        });
        D.base = D.live;
        applyEdits();
        D.loaded = true;
        Epg.reset(D.xt);
        // EPG loads in background; UI updates via Epg.onUpdate
        if (r.epgUrls.length) {
          Epg.loadXmltv(pl.id, r.epgUrls, D.base, force).catch(function (e) { console.warn(e); });
        }
        return true;
      });
    },

    channel: function (key) { return D.byKey[key] || null; },

    epgSources: epgSources,
    applyEdits: applyEdits,
    /* patch: {name, group, hidden, epg} — empty values restore the playlist's own */
    setEdit: function (key, patch) { saveEdit(key, patch); applyEdits(); },
    resetEdits: function () { Store.setMap('chedit', {}); Store.setList('chorder', []); applyEdits(); },
    hiddenChannels: function () { return D.all.filter(function (c) { return c.hidden; }); },
    /* move a channel one place up/down inside the list of group gid (a real group or __all) */
    moveChannel: function (ch, dir, gid) {
      var list = Data.liveList(gid), i = list.indexOf(ch), other = list[i + dir];
      if (i < 0 || !other) return false;
      var keys = D.all.map(function (c) { return c.key; });
      var a = keys.indexOf(ch.key), b = keys.indexOf(other.key);
      keys[a] = other.key; keys[b] = ch.key;
      Store.setList('chorder', keys);
      applyEdits();
      return true;
    },
    /* real group names (for "move to group") */
    groupNames: function () { return D.groups.map(function (g) { return g.id; }); },

    /* virtual + real groups for the Live screen */
    liveGroups: function () {
      var g = [
        { id: '__all', name: I18n.t('all_channels'), icon: 'live', count: D.live.length },
        { id: '__fav', name: I18n.t('favorites'), icon: 'star', count: Store.list('fav_live').length },
        { id: '__recent', name: I18n.t('recent'), icon: 'archive', count: Store.list('recent').length }
      ];
      D.groups.forEach(function (x) { g.push({ id: x.id, name: x.name, count: x.items.length, locked: Store.isLocked(x.id) }); });
      return g;
    },

    liveList: function (gid) {
      if (gid === '__all') return D.live;
      if (gid === '__fav' || gid === '__recent') {
        return Store.list(gid === '__fav' ? 'fav_live' : 'recent').map(Data.channel).filter(function (c) { return c && !c.hidden; });
      }
      for (var i = 0; i < D.groups.length; i++) if (D.groups[i].id === gid) return D.groups[i].items;
      return [];
    },

    liveUrl: function (ch) {
      if (D.xt && ch.streamId) return D.xt.liveUrl(ch.streamId, Store.get('streamFormat'));
      return ch.url;
    },

    altLiveUrl: function (ch) {
      if (D.xt && ch.streamId) return D.xt.liveUrl(ch.streamId, Store.get('streamFormat') === 'ts' ? 'm3u8' : 'ts');
      return null;
    },

    canCatchup: function (ch, prog) {
      if (!ch || !ch.catchup || !prog) return false;
      var now = Date.now();
      if (prog.s >= now) return false;
      return now - prog.s <= ch.catchup.days * 86400000 + 3600000;
    },

    catchupUrl: function (ch, prog) {
      if (D.xt && ch.streamId) {
        return D.xt.timeshiftUrl(ch.streamId, prog.s, prog.e, Store.get('streamFormat') === 'ts' ? 'ts' : 'm3u8');
      }
      return M3U.catchupUrl(ch, prog.s, prog.e);
    },

    /* ---- YouTube section (screens/youtube.js) ---- */
    vodCats: function () {
      return [
        { id: '__fav', name: I18n.t('favorites'), icon: 'star' },
        { id: '__cont', name: I18n.t('continue_watching'), icon: 'archive' }
      ].concat(YtChannels.cats().map(function (c) { return { id: c.id, name: c.name, locked: Store.isLocked('vod:' + c.name) }; }));
    },

    vodList: function (type, catId) {
      if (catId === '__fav') {
        var meta = {};
        Store.list('favmeta').forEach(function (m) { meta[m.key] = m; });
        return Promise.resolve(Store.list('fav_youtube').map(function (k) { return YtChannels.item(k) || meta[k]; }).filter(Boolean));
      }
      if (catId === '__cont') {
        return Promise.resolve(Store.positions().filter(function (p) { return p.meta && p.meta.section === 'youtube'; }).map(function (p) { return p.meta; }));
      }
      return Promise.resolve(YtChannels.items(catId));
    },

    /* all videos (used by search) */
    vodAll: function () { return Promise.resolve(YtChannels.all()); },

    /* full item for a saved favourite / "continue watching" entry */
    localItem: function (key) { return YtChannels.item(key) || null; },

    rememberFavMeta: function (item) {
      var l = Store.list('favmeta').filter(function (m) { return m.key !== item.key; });
      l.unshift({ key: item.key, id: item.id, name: item.name, poster: item.poster, rating: item.rating, ext: item.ext, url: item.url, type: item.type, year: item.year, youtube: item.youtube });
      Store.setList('favmeta', l.slice(0, 500));
    }
  };

  window.Data = Data;
})();
