/*
 * Builds the installable webOS package:
 *   npm run build   ->  dist/com.ekrani.iptv_<version>_all.ipk
 * The app is copied to build/app first with its JS minified (terser, shipped with the LG CLI) and its CSS
 * comments/whitespace removed: a smaller package and less for the TV to parse at every start.
 * Then it is packaged with the official LG CLI (ares-package from @webos-tools/cli).
 *   node tools/build.js --stage   only prepares build/app (to test it: node tools/dev-server.js 8124 build/app)
 *   --no-ota                      leaves ota/ as it is (used by tools/build-android.js)
 * It also writes ota/ (pushed to GitHub): the app's JS and CSS as one file each plus version.json.
 * The TV checks ota/version.json and offers the update (app/js/update.js, app/js/boot.js).
 * "native" in version.json is a hash of what an update cannot replace (the service, index.html, boot.js,
 * fonts, images, appinfo.json without its version): when it changes, the new version needs an install from the PC.
 */
'use strict';
const path = require('path');
const fs = require('fs');
const { execFileSync } = require('child_process');
const crypto = require('crypto');

const root = path.join(__dirname, '..');
const dist = path.join(root, 'dist');
const stage = path.join(root, 'build', 'app');
const cli = path.join(root, 'node_modules', '@webos-tools', 'cli');
const terser = require(path.join(cli, 'node_modules', 'terser'));
const HLS_LIB = 'js/lib/hls.light.min.js';   // hls.js 1.7.4 light build (npm hls.js, dist/)
const app = JSON.parse(fs.readFileSync(path.join(root, 'app', 'appinfo.json'), 'utf8'));

function files(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).reduce((out, d) => {
    const p = path.join(dir, d.name);
    return out.concat(d.isDirectory() ? files(p) : [p]);
  }, []);
}

function minCss(css) {
  return css.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\s*\n\s*/g, '\n').replace(/\n+/g, '\n').trim() + '\n';
}

/* hash of the package parts an over-the-air update cannot change */
function nativeHash() {
  const h = crypto.createHash('sha1');
  const appDir = path.join(root, 'app');
  const parts = files(path.join(root, 'service'))
    .concat(files(path.join(appDir, 'fonts')), files(path.join(appDir, 'img')))
    .concat([path.join(appDir, 'index.html'), path.join(appDir, 'js', 'boot.js')])
    .sort();
  for (const p of parts) {
    h.update(path.relative(root, p).split(path.sep).join('/'));
    // text files: line endings must not change the hash (Windows checkout vs. GitHub)
    const buf = fs.readFileSync(p);
    h.update(/\.(html|js|json|txt)$/.test(p) ? buf.toString('utf8').replace(/\r\n/g, '\n') : buf);
  }
  const info = Object.assign({}, app);
  delete info.version;
  h.update(JSON.stringify(info));
  return h.digest('hex').slice(0, 16);
}

async function prepare() {
  const native = { v: app.version, h: nativeHash() };
  fs.rmSync(path.join(root, 'build'), { recursive: true, force: true });
  let before = 0, after = 0;
  for (const src of files(path.join(root, 'app'))) {
    const rel = path.relative(path.join(root, 'app'), src);
    const dst = path.join(stage, rel);
    fs.mkdirSync(path.dirname(dst), { recursive: true });
    const ext = path.extname(src);
    if (rel.split(path.sep).join('/') === HLS_LIB) continue;   // goes into player.js (below)
    if (ext !== '.js' && ext !== '.css') { fs.copyFileSync(src, dst); continue; }
    let text = fs.readFileSync(src, 'utf8');
    if (rel.split(path.sep).join('/') === 'js/boot.js') {
      // the package's own version and hash, for the update check
      text = text.replace(/\/\*@NATIVE\*\/[\s\S]*?\/\*@END\*\//, JSON.stringify(native));
      if (text.indexOf(native.h) < 0) throw new Error('boot.js: NATIVE marker not found');
    }
    let out;
    if (ext === '.css') out = minCss(text);
    else {
      // ES5 output for the TV's Chromium; top-level names stay (the files share globals)
      const r = await terser.minify(text, { ecma: 5, compress: { passes: 2 }, mangle: true, format: { comments: false } });
      if (r.error) throw r.error;
      out = r.code;
      // hls.js (live HLS on webOS, see player.js) rides in player.js: boot.js's file list is part of the package
      // and cannot grow through an update. It is minified ES5 already, so it is added after terser.
      if (rel.split(path.sep).join('/') === 'js/player.js') {
        const hls = fs.readFileSync(path.join(root, 'app', HLS_LIB), 'utf8').replace(/\/\/# sourceMappingURL=.*$/m, '').trim();
        out = hls.replace(/;?$/, ';') + '\n' + out;
      }
    }
    fs.writeFileSync(dst, out);
    before += Buffer.byteLength(text); after += Buffer.byteLength(out);
  }
  console.log('JS/CSS: ' + Math.round(before / 1024) + ' KB -> ' + Math.round(after / 1024) + ' KB');
  if (!process.argv.includes('--no-ota')) writeOta(native);
}

/* ota/: everything boot.js loads, in its order, as one JS file + the CSS (font paths made relative to index.html) */
function writeOta(native) {
  const boot = fs.readFileSync(path.join(root, 'app', 'js', 'boot.js'), 'utf8');
  const m = /var FILES = (\[[\s\S]*?\]);/.exec(boot);
  if (!m) throw new Error('boot.js: FILES not found');
  const list = JSON.parse(m[1]);
  const js = list.map((f) => fs.readFileSync(path.join(stage, f), 'utf8').trim().replace(/;?$/, ';')).join('\n') + '\n';
  const css = fs.readFileSync(path.join(stage, 'css', 'app.css'), 'utf8').replace(/url\(\.\.\//g, 'url(');
  if (js.indexOf(app.version) < 0) throw new Error('app.js does not carry version ' + app.version);
  const dir = path.join(root, 'ota');
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  // file names carry the version: GitHub's raw CDN caches each path ~5 min, so a new version must not reuse a cached one
  const jsName = 'app-' + app.version + '.js', cssName = 'app-' + app.version + '.css';
  fs.writeFileSync(path.join(dir, jsName), js);
  fs.writeFileSync(path.join(dir, cssName), css);
  const ver = { version: app.version, native: native.h, js: jsName, css: cssName, jsLen: js.length, cssLen: css.length, date: new Date().toISOString() };
  fs.writeFileSync(path.join(dir, 'version.json'), JSON.stringify(ver, null, 2) + '\n');
  console.log('OTA: ota/ ' + app.version + ' (native ' + native.h + ', ' + Math.round(Buffer.byteLength(js) / 1024) + ' KB JS)');
}

async function main() {
  await prepare();
  if (process.argv.includes('--stage')) return;
  fs.mkdirSync(dist, { recursive: true });
  const out = path.join(dist, `${app.id}_${app.version}_all.ipk`);
  if (fs.existsSync(out)) fs.unlinkSync(out);
  const bin = path.join(cli, 'bin', 'ares-package.js');
  execFileSync(process.execPath, [bin, path.relative(root, stage), 'service', '--no-minify', '-o', 'dist'], { cwd: root, stdio: 'inherit' });
  if (!fs.existsSync(out)) { console.error('Package not found: ' + out); process.exit(1); }
  console.log('\nOK: ' + path.relative(root, out) + ' (' + Math.round(fs.statSync(out).size / 1024) + ' KB)');
}

main().catch((e) => { console.error(e); process.exit(1); });
