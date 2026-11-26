/*
 * Local preview server for testing the UI in a desktop browser.
 *   node tools/dev-server.js [port]
 * Serves ./app plus fake test data:
 *   /test/playlist.m3u      M3U with groups, logos, catch-up and url-tvg
 *   /test/epg.xml           XMLTV for those channels
 *   /player_api.php         mock Xtream Codes API (user "demo", password "demo")
 */
'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = parseInt(process.argv[2] || process.env.PORT || '8123', 10);
const ROOT = process.argv[3] ? path.resolve(process.argv[3]) : path.join(__dirname, '..', 'app');   // 2nd arg: build/app to test the minified copy
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'application/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json', '.png': 'image/png', '.woff2': 'font/woff2', '.svg': 'image/svg+xml' };

const TEST_STREAM = 'https://test-streams.mux.dev/x36xhzz/x36xhzz.m3u8';
const GROUPS = ['ქართული', 'სპორტი', 'ფილმები', 'News', 'Kids'];
const NAMES = {
  'ქართული': ['პირველი არხი', 'იმედი', 'რუსთავი 2', 'მთავარი', 'ფორმულა', 'TV პირველი', 'პალიტრა ნიუსი', 'კავკასია'],
  'სპორტი': ['Setanta Sports 1', 'Setanta Sports 2', 'Silk Sport 1', 'Silk Sport 2', 'Eurosport', 'Adjarasport 1'],
  'ფილმები': ['Kino 1', 'Kino 2', 'Cinema HD', 'Drama TV', 'Comedy Club'],
  'News': ['World News', 'Business 24', 'Euronews', 'Info 24'],
  'Kids': ['Cartoon Fun', 'Kids Zone', 'Nick Jr', 'Baby TV']
};
const SHOWS = ['ახალი ამბები', 'დილის შოუ', 'Documentary: Ocean', 'Football: Live', 'სერიალი „ოჯახი“', 'Talk Show', 'კინო: საღამო', 'Weather', 'Music Hits', 'Cartoon Time', 'კულინარია', 'Sport Review'];

const channels = [];
GROUPS.forEach((g) => NAMES[g].forEach((n) => channels.push({ id: 'ch' + (channels.length + 1), name: n, group: g, num: channels.length + 1 })));

function logo(ch) {
  const colors = ['#2f7cf6', '#e5484d', '#3ddc84', '#f5a623', '#8b5cf6'];
  const c = colors[ch.num % colors.length];
  const txt = ch.name.replace(/[^A-Za-z0-9ა-ჰ ]/g, '').split(' ').map((w) => w[0]).join('').slice(0, 3);
  return 'data:image/svg+xml;utf8,' + encodeURIComponent(
    `<svg xmlns="http://www.w3.org/2000/svg" width="120" height="80"><rect width="120" height="80" rx="12" fill="${c}"/>` +
    `<text x="60" y="52" font-family="Arial" font-size="30" font-weight="bold" fill="#fff" text-anchor="middle">${txt}</text></svg>`);
}

function m3u(host) {
  let s = `#EXTM3U url-tvg="http://${host}/test/epg.xml"\n`;
  channels.forEach((c) => {
    const arch = c.num % 3 === 0 ? ' catchup="shift" catchup-days="3"' : '';
    s += `#EXTINF:-1 tvg-id="${c.id}" tvg-name="${c.name}" tvg-logo="${logo(c)}" group-title="${c.group}"${arch},${c.name}\n${TEST_STREAM}\n`;
  });
  // a real live stream (sliding window), to test live playback / hls.js
  s += `#EXTINF:-1 tvg-logo="" group-title="Live test",Unified Live\nhttps://demo.unified-streaming.com/k8s/live/scte35.isml/.m3u8\n`;
  s += `#EXTINF:-1 tvg-logo="" group-title="VOD",Big Buck Bunny\nhttp://${host}/movie/demo/demo/1001.mp4\n`;
  return s;
}

function pad(n) { return String(n).padStart(2, '0'); }
function xmlTime(ms) {
  const d = new Date(ms);
  return `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}00 +0000`;
}
function programmes(ch) {
  const out = [];
  const slot = 30 * 60000;
  let t = Math.floor(Date.now() / slot) * slot - 2 * 86400000;
  const end = Date.now() + 2 * 86400000;
  let i = ch.num;
  while (t < end) {
    const len = (1 + ((i * 7) % 4)) * slot;
    out.push({ s: t, e: t + len, title: SHOWS[i % SHOWS.length], desc: 'გადაცემის მოკლე აღწერა. Programme description #' + i });
    t += len; i++;
  }
  return out;
}
function epg() {
  let s = '<?xml version="1.0" encoding="UTF-8"?>\n<tv>\n';
  channels.forEach((c) => { s += `<channel id="${c.id}"><display-name>${c.name}</display-name></channel>\n`; });
  channels.forEach((c) => programmes(c).forEach((p) => {
    s += `<programme start="${xmlTime(p.s)}" stop="${xmlTime(p.e)}" channel="${c.id}"><title lang="ka">${p.title.replace(/&/g, '&amp;')}</title><desc>${p.desc}</desc></programme>\n`;
  }));
  return s + '</tv>\n';
}

/* ---- mock Xtream ---- */
const b64 = (s) => Buffer.from(s, 'utf8').toString('base64');
const MOVIES = ['The Long Road', 'Ocean Deep', 'მთის სიმღერა', 'Night City', 'Last Train', 'Golden Hour', 'თბილისური ზღაპარი', 'Iron Sky', 'Silent Forest', 'Blue Planet', 'Desert Wind', 'Paper Hearts', 'Storm Chasers', 'Summer Lake'];
function poster(name, i) {
  const hue = (i * 47) % 360;
  return 'data:image/svg+xml;utf8,' + encodeURIComponent(
    `<svg xmlns="http://www.w3.org/2000/svg" width="300" height="450"><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1">` +
    `<stop offset="0" stop-color="hsl(${hue},60%,45%)"/><stop offset="1" stop-color="hsl(${(hue + 60) % 360},60%,20%)"/></linearGradient></defs>` +
    `<rect width="300" height="450" fill="url(#g)"/><text x="150" y="400" font-family="Arial" font-size="26" fill="#fff" text-anchor="middle">${name}</text></svg>`);
}
function xtream(q, host) {
  const a = q.get('action') || '';
  const now = Math.floor(Date.now() / 1000);
  switch (a) {
    case '': return { user_info: { username: 'demo', auth: 1, status: 'Active', exp_date: String(now + 90 * 86400), active_cons: '0', max_connections: '2' },
      server_info: { url: host, timezone: 'Asia/Tbilisi', time_now: new Date().toISOString() } };
    case 'get_live_categories': return GROUPS.map((g, i) => ({ category_id: String(i + 1), category_name: g }));
    case 'get_live_streams': return channels.map((c) => ({ num: c.num, name: c.name, stream_id: c.num, stream_icon: logo(c), epg_channel_id: c.id,
      category_id: String(GROUPS.indexOf(c.group) + 1), tv_archive: c.num % 2 ? 1 : 0, tv_archive_duration: 5 }));
    case 'get_vod_categories': return [{ category_id: '10', category_name: 'Action' }, { category_id: '11', category_name: 'ქართული ფილმები' }, { category_id: '12', category_name: 'Drama' }];
    case 'get_vod_streams': return MOVIES.map((m, i) => ({ stream_id: 1000 + i, name: m, stream_icon: poster(m, i), rating: (5 + (i % 5)).toString(), container_extension: 'mp4', category_id: String(10 + (i % 3)) }))
      .filter((m) => !q.get('category_id') || m.category_id === q.get('category_id'));
    case 'get_vod_info': return { info: { plot: 'A short plot of the movie. ფილმის მოკლე შინაარსი.', genre: 'Drama, Action', director: 'John Doe', cast: 'Actor One, Actor Two', releasedate: '2021-05-01', duration: '01:48:00', rating: '7.4' }, movie_data: {} };
    case 'get_series_categories': return [{ category_id: '20', category_name: 'TV Shows' }, { category_id: '21', category_name: 'ქართული სერიალები' }];
    case 'get_series': return ['Ocean Stories', 'ცისფერი მთები', 'City Lights', 'The Office Hours', 'Detective Lane'].map((n, i) => ({ series_id: 500 + i, name: n, cover: poster(n, i + 20), rating: '8', releaseDate: '2020-01-01', category_id: String(20 + (i % 2)) }))
      .filter((m) => !q.get('category_id') || m.category_id === q.get('category_id'));
    case 'get_series_info': {
      const eps = {};
      [1, 2, 3].forEach((s) => { eps[s] = Array.from({ length: 8 }, (_, e) => ({ id: String(s * 100 + e + 1), episode_num: e + 1, title: 'Episode ' + (e + 1), container_extension: 'mp4', season: s, info: { plot: 'Episode plot text', duration: '00:45:00' } })); });
      return { seasons: [], info: { name: 'Series', plot: 'Series plot. სერიალის აღწერა.', genre: 'Drama', cast: 'Cast A, Cast B', releaseDate: '2020-01-01', rating: '8.1' }, episodes: eps };
    }
    case 'get_simple_data_table': {
      const ch = channels[(parseInt(q.get('stream_id'), 10) || 1) - 1];
      return { epg_listings: programmes(ch).map((p) => ({ title: b64(p.title), description: b64(p.desc), start_timestamp: String(Math.floor(p.s / 1000)), stop_timestamp: String(Math.floor(p.e / 1000)), has_archive: p.e < Date.now() ? 1 : 0 })) };
    }
  }
  return [];
}

http.createServer((req, res) => {
  const u = new URL(req.url, 'http://' + req.headers.host);
  const host = req.headers.host;
  const send = (code, type, body) => { res.writeHead(code, { 'Content-Type': type, 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'no-store' }); res.end(body); };
  if (u.pathname === '/test/playlist.m3u') return send(200, 'audio/x-mpegurl; charset=utf-8', m3u(host));
  if (u.pathname === '/test/epg.xml' || u.pathname === '/xmltv.php') return send(200, 'application/xml; charset=utf-8', epg());
  if (u.pathname === '/player_api.php') {
    if (u.searchParams.get('username') !== 'demo' || u.searchParams.get('password') !== 'demo') return send(200, 'application/json', JSON.stringify({ user_info: { auth: 0 } }));
    return send(200, 'application/json', JSON.stringify(xtream(u.searchParams, host)));
  }
  if (u.pathname === '/yt.html') {   // on the TV the service serves this page
    return fs.readFile(path.join(__dirname, '..', 'service', 'yt.html'), (err, data) => send(err ? 404 : 200, 'text/html; charset=utf-8', err ? 'not found' : data));
  }
  if (u.pathname === '/proxy') {   // YouTube pages / feeds have no CORS; on the TV the service fetches them
    let target;
    try { target = new URL(u.searchParams.get('url') || ''); } catch (e) { return send(400, 'text/plain', 'bad url'); }
    if (target.protocol !== 'https:' || !/^(www\.)?youtube\.com$/.test(target.hostname)) return send(403, 'text/plain', 'youtube.com only');
    const https = require('https');
    const get = (t, n) => https.get(t, { headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36', 'Accept-Language': 'en-US,en;q=0.8' } }, (r) => {
      if (r.statusCode >= 300 && r.statusCode < 400 && r.headers.location && n < 5) { r.resume(); return get(new URL(r.headers.location, t), n + 1); }
      const chunks = [];
      r.on('data', (c) => chunks.push(c));
      r.on('end', () => send(r.statusCode, r.headers['content-type'] || 'text/plain', Buffer.concat(chunks)));
    }).on('error', (e) => send(502, 'text/plain', e.message));
    return get(target, 0);
  }
  let p = decodeURIComponent(u.pathname);
  if (p === '/') p = '/index.html';
  // app/local/ holds a private playlist (test builds): only for this computer, not the rest of the network
  const ra = req.socket.remoteAddress || '';
  if (/^\/local\//.test(p) && !/^(::1|127\.|::ffff:127\.)/.test(ra)) return send(403, 'text/plain', 'forbidden');
  const file = path.join(ROOT, path.normalize(p));
  if (!file.startsWith(ROOT)) return send(403, 'text/plain', 'forbidden');
  fs.readFile(file, (err, data) => {
    if (err) return send(404, 'text/plain', 'not found');
    send(200, TYPES[path.extname(file)] || 'application/octet-stream', data);
  });
}).listen(PORT, () => console.log('Ekrani dev server: http://localhost:' + PORT));
