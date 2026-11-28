/*
 * Racing on a computer: runs the same LAN server the TV runs (phones open http://<pc-ip>:8900)
 * and serves the game itself on http://localhost:8901 (open it in a browser, it connects to :8900).
 *   node tools/racing-dev.js
 */
'use strict';
var http = require('http');
var fs = require('fs');
var path = require('path');

process.env.RACING_DEV = '1';
var server = require('../racing/service/server.js');
var ROOT = path.join(__dirname, '..', 'racing', 'app');
var TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'application/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.png': 'image/png', '.woff2': 'font/woff2', '.json': 'application/json' };

server.start(8900, function (err, port) {
  if (err) { console.error('LAN server:', err); process.exit(1); }
  console.log('phones:  http://' + server.localIp() + ':' + port + '/');
});

http.createServer(function (req, res) {
  var p = decodeURIComponent(req.url.split('?')[0]);
  if (p === '/') p = '/index.html';
  var f = path.normalize(path.join(ROOT, p));
  if (f.indexOf(ROOT) !== 0) { res.writeHead(403); return res.end(); }
  fs.readFile(f, function (e, data) {
    if (e) { res.writeHead(404); return res.end('not found'); }
    res.writeHead(200, { 'Content-Type': TYPES[path.extname(f)] || 'application/octet-stream', 'Cache-Control': 'no-store' });
    res.end(data);
  });
}).listen(8901, function () { console.log('game:    http://localhost:8901/'); });
