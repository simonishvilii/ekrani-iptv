/*
 * Builds the Racing game for the TV:
 *   npm run build:racing   ->  dist/com.ekrani.racing_<version>_all.ipk
 * racing/app (the game) and racing/service (the LAN server phones connect to) go into one package,
 * packaged with the official LG CLI. The code is already ES5 for the TV's Chromium 79 / Node 12.
 */
'use strict';
const path = require('path');
const fs = require('fs');
const { execFileSync } = require('child_process');

const root = path.join(__dirname, '..');
const dist = path.join(root, 'dist');
const app = JSON.parse(fs.readFileSync(path.join(root, 'racing', 'app', 'appinfo.json'), 'utf8'));
const svc = JSON.parse(fs.readFileSync(path.join(root, 'racing', 'service', 'package.json'), 'utf8'));
if (svc.version !== app.version) console.warn('note: service version ' + svc.version + ' differs from the app ' + app.version);

// the version on the debug line comes from appinfo.json: keep game.js in step
const gameJs = path.join(root, 'racing', 'app', 'js', 'game.js');
const src = fs.readFileSync(gameJs, 'utf8');
const synced = src.replace(/var VERSION = '[^']*';/, "var VERSION = '" + app.version + "';");
if (synced !== src) { fs.writeFileSync(gameJs, synced); console.log('game.js VERSION -> ' + app.version); }

fs.mkdirSync(dist, { recursive: true });
execFileSync(process.execPath, [
  path.join(root, 'node_modules', '@webos-tools', 'cli', 'bin', 'ares-package.js'),
  path.join(root, 'racing', 'app'), path.join(root, 'racing', 'service'),
  '--no-minify', '-o', dist
], { stdio: 'inherit' });
const ipk = path.join(dist, app.id + '_' + app.version + '_all.ipk');
console.log(fs.existsSync(ipk) ? 'built ' + path.relative(root, ipk) + ' (' + Math.round(fs.statSync(ipk).size / 1024) + ' KB)' : 'package not found: ' + ipk);
