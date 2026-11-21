/* "YouTube ფილმები": videos from YouTube channels / playlists the user adds in Settings.
   Without an API key each channel's RSS feed gives its latest 15 uploads; what was seen once is
   kept, so the list grows over time. With a YouTube Data API v3 key the whole uploads list is read
   (with durations, so short clips can be left out). Channels are global, not per playlist. */
(function () {
  'use strict';

  var PREFIX = 'ekrani.';
  var REFRESH_MS = 3 * 3600000;     // re-check a channel at most every 3 h
  var NEW_DAYS = 30;
  var KEEP = 3000;                  // videos kept per channel
  var MAX_PAGES = 40;               // 50 videos per page with a key
  var API = 'https://www.googleapis.com/youtube/v3/';

  function load(k, def) {
    try { var v = localStorage.getItem(PREFIX + k); return v == null ? def : JSON.parse(v); } catch (e) { return def; }
  }
  function save(k, v) { try { localStorage.setItem(PREFIX + k, JSON.stringify(v)); } catch (e) { /* ignore */ } }

  var channels = load('ytChannels', []);     // [{id, kind: 'channel' | 'playlist', name, input}]
  var videos = {};                           // channel id -> [raw video]
  var listeners = [];
  var busy = null;

  /* in the desktop preview YouTube pages need the dev server's proxy (no CORS); on the TV the service fetches them */
  function get(url) {
    if (!window.PalmServiceBridge && /^(localhost|127\.0\.0\.1)$/.test(location.hostname) && /\/\/(www\.)?youtube\.com\//.test(url)) {
      url = '/proxy?url=' + encodeURIComponent(url);
    }
    return Net.text(url, { timeout: 30000 });
  }
  /* the API's own message ("API key not valid…") instead of a bare "HTTP 400" */
  function apiError(r) {
    var er = r && r.error;
    if (!er) return null;
    var reason = er.errors && er.errors[0] && er.errors[0].reason;
    return new Error((er.message || 'API error').replace(/<[^>]+>/g, '') + (reason && (er.message || '').indexOf(reason) < 0 ? ' (' + reason + ')' : ''));
  }
  function api(path, q, keyOverride) {
    var key = keyOverride || Store.get('ytApiKey');
    var s = Object.keys(q).map(function (k) { return k + '=' + encodeURIComponent(q[k]); }).join('&');
    return Net.json(API + path + '?' + s + '&key=' + encodeURIComponent(key)).then(function (r) {
      var e = apiError(r);
      if (e) throw e;
      return r || {};
    }, function (e) {
      var r = null;
      try { r = JSON.parse(e.body || ''); } catch (x) { /* not JSON */ }
      throw apiError(r) || e;
    });
  }
  /* one cheap call (1 unit) to tell a working key from a mistyped one */
  function checkKey(key) {
    return api('i18nLanguages', { part: 'snippet', hl: 'en' }, key).then(function () { return true; });
  }
  var errors = {};   // channel id -> last error message

  function feedUrl(c) {
    return 'https://www.youtube.com/feeds/videos.xml?' + (c.kind === 'playlist' ? 'playlist_id=' : 'channel_id=') + encodeURIComponent(c.id);
  }

  function tag(e, name) {
    return e.getElementsByTagName(name)[0] || e.getElementsByTagNameNS('*', name.replace(/^.*:/, ''))[0] || null;
  }

  /* RSS: {title, items:[{id, title, published, description, thumb, short}]} */
  function parseFeed(xml) {
    var doc = new DOMParser().parseFromString(xml, 'application/xml');
    if (doc.getElementsByTagName('parsererror').length) throw new Error('bad feed');
    var feedTitle = '';
    var root = doc.documentElement;
    for (var n = root.firstChild; n; n = n.nextSibling) {
      if (n.nodeName === 'title') { feedTitle = n.textContent.trim(); break; }
    }
    var out = [], entries = doc.getElementsByTagName('entry');
    for (var i = 0; i < entries.length; i++) {
      var e = entries[i];
      var id = tag(e, 'yt:videoId'), title = tag(e, 'title'), pub = tag(e, 'published');
      var desc = tag(e, 'media:description'), thumb = tag(e, 'media:thumbnail');
      if (!id || !title) continue;
      var links = e.getElementsByTagName('link'), short = false;
      for (var j = 0; j < links.length; j++) if (/\/shorts\//.test(links[j].getAttribute('href') || '')) short = true;
      out.push({
        id: id.textContent.trim(), title: title.textContent.trim(),
        published: pub ? Date.parse(pub.textContent) || 0 : 0,
        description: desc ? desc.textContent.trim() : '',
        thumb: thumb ? thumb.getAttribute('url') : '', short: short
      });
    }
    return { title: feedTitle, items: out };
  }

  /* "PT1H32M5S" -> seconds */
  function isoDur(s) {
    var m = /^P(?:(\d+)D)?T?(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?$/.exec(s || '');
    return m ? (+m[1] || 0) * 86400 + (+m[2] || 0) * 3600 + (+m[3] || 0) * 60 + (+m[4] || 0) : 0;
  }
  function fmtDur(sec) {
    if (!sec) return '';
    var h = Math.floor(sec / 3600), m = Math.floor(sec % 3600 / 60);
    return h ? h + ' სთ ' + m + ' წთ' : m + ' წთ';
  }

  /* ---- what the user typed -> {kind, id, name} ---- */
  function resolve(input) {
    var s = String(input || '').trim();
    if (!s) return Promise.reject(new Error(I18n.t('yt_bad_input')));
    var m = /[?&]list=([\w-]{10,})/.exec(s) || /^(PL[\w-]{10,}|UU[\w-]{20,}|OL[\w-]{10,})$/.exec(s);
    if (m) return named({ kind: 'playlist', id: m[1] });
    m = /(?:^|\/channel\/)(UC[\w-]{22})(?:$|[\/?#])/.exec(s);
    if (m) return named({ kind: 'channel', id: m[1] });
    // @handle, /c/name, /user/name, or a bare handle
    var page;
    m = /youtube\.com\/((?:@|c\/|user\/)[^\/?#\s]+)/i.exec(s);
    if (m) page = 'https://www.youtube.com/' + m[1];
    else if (/^@?[\w.\-]{3,}$/.test(s)) page = 'https://www.youtube.com/' + (s.charAt(0) === '@' ? s : '@' + s);
    else return Promise.reject(new Error(I18n.t('yt_bad_input')));
    var handle = /\/(@[^\/?#]+)$/.exec(page);
    var viaApi = Store.get('ytApiKey') && handle
      ? api('channels', { part: 'snippet', forHandle: decodeURIComponent(handle[1]) }).then(function (r) {
        var it = r.items && r.items[0];
        if (!it) throw new Error('not found');
        return { kind: 'channel', id: it.id, name: it.snippet.title };
      })
      : Promise.reject(new Error('no key'));
    return viaApi.catch(function () {
      return get(page).then(function (html) {
        var id = /<link rel="canonical" href="https:\/\/www\.youtube\.com\/channel\/(UC[\w-]{22})"/.exec(html) ||
          /"externalId":"(UC[\w-]{22})"/.exec(html) || /channel_id=(UC[\w-]{22})/.exec(html) ||
          /"channelId":"(UC[\w-]{22})"/.exec(html);
        if (!id) throw new Error(I18n.t('yt_not_found'));
        var t = /<meta property="og:title" content="([^"]*)"/.exec(html);
        return named({ kind: 'channel', id: id[1], name: t ? unent(t[1]) : '' });
      });
    });
  }
  function unent(s) {
    var d = document.createElement('textarea');
    d.innerHTML = s;
    return d.value;
  }
  /* fill in the name from the feed (also proves the channel exists) */
  function named(c) {
    if (c.name) return Promise.resolve(c);
    return get(feedUrl(c)).then(function (xml) {
      c.name = parseFeed(xml).title || c.id;
      return c;
    }, function (e) {
      if (!Store.get('ytApiKey')) throw new Error(I18n.t('yt_not_found') + ' (' + e.message + ')');
      var q = c.kind === 'playlist' ? api('playlists', { part: 'snippet', id: c.id }) : api('channels', { part: 'snippet', id: c.id });
      return q.then(function (r) {
        var it = r.items && r.items[0];
        if (!it) throw new Error(I18n.t('yt_not_found'));
        c.name = it.snippet.title;
        return c;
      });
    });
  }

  /* ---- fetching ---- */
  function viaFeed(c, known) {
    return get(feedUrl(c)).then(function (xml) {
      var f = parseFeed(xml), byId = {};
      known.forEach(function (x) { byId[x.id] = x; });
      f.items.forEach(function (x) { if (!x.short) byId[x.id] = Object.assign({}, byId[x.id] || {}, x); });
      return Object.keys(byId).map(function (k) { return byId[k]; });
    });
  }

  function viaApi(c, known, full) {
    var list = c.kind === 'playlist' ? c.id : 'UU' + c.id.slice(2);
    var have = {};
    known.forEach(function (x) { have[x.id] = x; });
    var got = [], stop = false;
    // uploads are newest first: a channel that was read in full only needs the pages up to a known video
    var incremental = full && c.kind === 'channel';
    function page(token, n) {
      var q = { part: 'snippet,contentDetails', maxResults: 50, playlistId: list };
      if (token) q.pageToken = token;
      return api('playlistItems', q).then(function (r) {
        (r.items || []).forEach(function (it) {
          var sn = it.snippet || {}, cd = it.contentDetails || {};
          var vid = cd.videoId || (sn.resourceId && sn.resourceId.videoId);
          if (!vid || /^(Private|Deleted) video$/.test(sn.title)) return;
          if (incremental && have[vid]) { stop = true; return; }
          var th = sn.thumbnails || {};
          got.push({
            id: vid, title: sn.title || '', description: sn.description || '',
            published: Date.parse(cd.videoPublishedAt || sn.publishedAt) || 0,
            thumb: (th.high || th.medium || th['default'] || {}).url || ''
          });
        });
        if (!stop && r.nextPageToken && n + 1 < MAX_PAGES) return page(r.nextPageToken, n + 1);
      });
    }
    return page('', 0).then(function () {
      // durations, 50 ids at a time
      var ids = got.map(function (x) { return x.id; }), chunks = [];
      for (var i = 0; i < ids.length; i += 50) chunks.push(ids.slice(i, i + 50));
      return chunks.reduce(function (p, ch) {
        return p.then(function () {
          return api('videos', { part: 'contentDetails,snippet', id: ch.join(',') }).then(function (r) {
            var by = {};
            (r.items || []).forEach(function (v) { by[v.id] = v; });
            got.forEach(function (x) {
              var v = by[x.id];
              if (!v) return;
              x.dur = isoDur(v.contentDetails && v.contentDetails.duration);
              if (v.snippet && v.snippet.liveBroadcastContent && v.snippet.liveBroadcastContent !== 'none') x.live = true;
            });
          });
        });
      }, Promise.resolve());
    }).then(function () {
      got = got.filter(function (x) { return !x.live; });
      if (!incremental) return got;
      var seen = {};
      got.forEach(function (x) { seen[x.id] = true; });
      return got.concat(known.filter(function (x) { return !seen[x.id]; }));
    });
  }

  function pull(c, force) {
    var ck = 'ytc:' + c.kind + ':' + c.id;
    return Cache.get(ck).then(function (old) {
      var known = (old && old.items) || [];
      var key = !!Store.get('ytApiKey');
      var full = !!(old && old.full);
      if (!force && old && Date.now() - old.time < REFRESH_MS && (!key || full)) return known;
      var viaKey = key;
      var p = key ? viaApi(c, full ? known : [], full) : viaFeed(c, known);
      if (key) {
        // the API failed (bad key, quota): show the error, but still list the feed's latest videos
        p = p.catch(function (e) {
          errors[c.id] = e.message;
          console.warn('YouTube API ' + (c.name || c.id) + ': ' + e.message);
          if (force) U.toast((c.name || c.id) + ': ' + e.message, 7000);
          viaKey = false;
          return viaFeed(c, known);
        });
      }
      return p.then(function (items) {
        if (viaKey) delete errors[c.id];
        items.sort(function (a, b) { return b.published - a.published; });
        items = items.slice(0, KEEP);
        Cache.set(ck, { time: viaKey ? Date.now() : 0, items: items, full: viaKey || (full && !key) });
        return items;
      }, function (e) {
        if (!errors[c.id]) errors[c.id] = e.message;
        console.warn('YouTube ' + (c.name || c.id) + ': ' + e.message);
        if (force && !key) U.toast((c.name || c.id) + ': ' + e.message, 5000);
        return known;
      });
    });
  }

  /* a film's own year when the title has one ("Name (1977)"); the upload date says nothing about it */
  function yearOf(t) {
    var m = /(?:^|[^\d])(19[1-9]\d|20[0-4]\d)(?:[^\d]|$)/.exec(t || '');
    return m ? m[1] : '';
  }

  /* ---- items for the VOD screen ---- */
  var cats = [], byCat = {}, byKey = {};

  function build() {
    var min = (+Store.get('ytMinMin') || 0) * 60;
    var now = Date.now(), all = [], seen = {};
    cats = [];
    byCat = {};
    byKey = {};
    channels.forEach(function (c) {
      var list = (videos[c.id] || []).filter(function (v) {
        return !v.short && (!min || !v.dur || v.dur >= min);   // no duration (RSS): keep
      }).map(function (v) {
        var key = 'yc:' + v.id;
        var it = byKey[key] || {
          key: key, id: v.id, name: v.title, youtube: v.id, type: 'movie', local: true, group: c.name,
          poster: 'https://i.ytimg.com/vi/' + v.id + '/hqdefault.jpg',
          plot: v.description, added: v.published, year: yearOf(v.title),
          isNew: v.published > 0 && now - v.published < NEW_DAYS * 86400000,
          info: { plot: v.description, duration: fmtDur(v.dur), genre: c.name, backdrop_path: [] }
        };
        byKey[key] = it;
        return it;
      });
      byCat['yc:' + c.id] = list;
      cats.push({ id: 'yc:' + c.id, name: c.name || c.id });
      list.forEach(function (it) { if (!seen[it.key]) { seen[it.key] = true; all.push(it); } });
    });
    all.sort(function (a, b) { return (b.added || 0) - (a.added || 0); });
    byCat['yc:__all'] = all;
    if (channels.length) cats.unshift({ id: 'yc:__all', name: I18n.t('yt_all') });
  }

  function emit() { listeners.forEach(function (f) { try { f(); } catch (e) { console.warn(e); } }); }

  /* cached lists first (fast start), then the network */
  function refresh(force) {
    if (busy && !force) return busy;
    var list = channels.slice();
    var run = Promise.all(list.map(function (c) {
      return Cache.get('ytc:' + c.kind + ':' + c.id).then(function (old) { if (old && !videos[c.id]) videos[c.id] = old.items; });
    })).then(function () {
      build(); emit();
      return Promise.all(list.map(function (c) {
        return pull(c, force).then(function (items) { videos[c.id] = items; });
      }));
    }).then(function () {
      build(); emit();
      if (busy === run) busy = null;
    }, function (e) {
      if (busy === run) busy = null;
      throw e;
    });
    busy = run;
    return run;
  }

  window.YtChannels = {
    list: function () { return channels.slice(); },
    resolve: resolve,
    add: function (input) {
      return resolve(input).then(function (c) {
        for (var i = 0; i < channels.length; i++) if (channels[i].id === c.id) throw new Error(I18n.t('yt_exists') + ': ' + channels[i].name);
        c.input = String(input).trim();
        channels.push(c);
        save('ytChannels', channels);
        return pull(c, true).then(function (items) { videos[c.id] = items; build(); emit(); return c; });
      });
    },
    remove: function (id) {
      var c = channels.filter(function (x) { return x.id === id; })[0];
      channels = channels.filter(function (x) { return x.id !== id; });
      save('ytChannels', channels);
      delete videos[id];
      if (c) Cache.remove('ytc:' + c.kind + ':' + c.id);
      build(); emit();
    },
    move: function (id, dir) {
      var i = -1;
      channels.forEach(function (x, j) { if (x.id === id) i = j; });
      var j = i + dir;
      if (i < 0 || j < 0 || j >= channels.length) return false;
      var t = channels[i]; channels[i] = channels[j]; channels[j] = t;
      save('ytChannels', channels);
      build(); emit();
      return true;
    },
    count: function (id) { return (byCat['yc:' + id] || []).length; },
    error: function (id) { return errors[id] || ''; },
    checkKey: checkKey,
    refresh: refresh,
    /* settings that change what is shown (min length) */
    rebuild: function () { build(); emit(); },
    /* the API key changed: read every channel again in full */
    resetCache: function () {
      return Promise.all(channels.map(function (c) { return Cache.remove('ytc:' + c.kind + ':' + c.id); })).then(function () {
        videos = {};
        return refresh(true);
      });
    },
    cats: function () { return cats; },
    items: function (catId) { return byCat[catId] || []; },
    all: function () { return byCat['yc:__all'] || []; },
    item: function (key) { return byKey[key] || null; },
    onUpdate: function (f) { listeners.push(f); },
    parseFeed: parseFeed,
    isoDur: isoDur
  };
})();
