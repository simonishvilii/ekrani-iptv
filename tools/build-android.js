/*
 * Builds the Android / Android TV app (android/):
 *   node tools/build-android.js            release APK -> dist/ekrani-iptv-<version>.apk
 *   node tools/build-android.js --debug    debug APK (WebView inspectable from Chrome) -> dist/ekrani-iptv-debug.apk
 *   node tools/build-android.js --bump     raises android/version.properties first (versionCode +1, last number of the name +1)
 *   node tools/build-android.js --publish  also copies the APK to apk/ekrani-iptv.apk and writes apk/android.json:
 *                                          the install link and the app's own update check (app/js/update.js) use them
 * The web app itself is the webOS one: build/app (made by tools/build.js --stage) is copied into the APK's assets
 * with android/shim/ added to index.html. Its JS/CSS keep updating over the air like on webOS (ota/); a new APK is
 * only needed when the Android part (android/) or the parts behind the "native" hash change.
 * Needs JDK 17 and the Android SDK: JAVA_HOME / ANDROID_HOME, or the defaults below.
 * Release signing: ~/.ekrani/signing.properties (see android/app/build.gradle.kts). Never commit the key.
 */
'use strict';
const path = require('path');
const fs = require('fs');
const os = require('os');
const { execFileSync } = require('child_process');

const root = path.join(__dirname, '..');
const androidDir = path.join(root, 'android');
const assets = path.join(androidDir, 'app', 'src', 'main', 'assets');
const args = process.argv.slice(2);
const debug = args.includes('--debug');
const home = os.homedir();
const javaHome = process.env.JAVA_HOME || path.join(home, 'Android', 'jdk-17.0.21.1+2');
const sdk = process.env.ANDROID_HOME || process.env.ANDROID_SDK_ROOT || path.join(home, 'Android', 'sdk');
const gradle = process.env.GRADLE || path.join(home, 'Android', 'gradle-8.9', 'bin', process.platform === 'win32' ? 'gradle.bat' : 'gradle');
const REPO_RAW = 'https://raw.githubusercontent.com/simonishvilii/ekrani-iptv/main/';

function copyDir(src, dst) {
  fs.mkdirSync(dst, { recursive: true });
  for (const d of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, d.name), t = path.join(dst, d.name);
    if (d.isDirectory()) copyDir(s, t); else fs.copyFileSync(s, t);
  }
}

function readVersion() {
  const txt = fs.readFileSync(path.join(androidDir, 'version.properties'), 'utf8');
  const name = /^name=(.+)$/m.exec(txt)[1].trim(), code = parseInt(/^code=(\d+)$/m.exec(txt)[1], 10);
  return { name, code };
}

function bump() {
  const v = readVersion();
  const parts = v.name.split('.').map((x) => parseInt(x, 10) || 0);
  parts[parts.length - 1]++;
  const nv = { name: parts.join('.'), code: v.code + 1 };
  fs.writeFileSync(path.join(androidDir, 'version.properties'), 'name=' + nv.name + '\ncode=' + nv.code + '\n');
  console.log('Android version: ' + v.name + ' (' + v.code + ') -> ' + nv.name + ' (' + nv.code + ')');
}

/* the web app into the APK's assets */
function stageAssets() {
  execFileSync(process.execPath, [path.join(root, 'tools', 'build.js'), '--stage', '--no-ota'], { cwd: root, stdio: 'inherit' });
  fs.rmSync(assets, { recursive: true, force: true });
  const app = path.join(assets, 'app');
  copyDir(path.join(root, 'build', 'app'), app);
  copyDir(path.join(androidDir, 'shim'), path.join(app, 'android'));
  fs.copyFileSync(path.join(root, 'service', 'yt.html'), path.join(assets, 'yt.html'));
  const idx = path.join(app, 'index.html');
  let html = fs.readFileSync(idx, 'utf8');
  const boot = '<script src="js/boot.js"></script>';
  const css = '<script>Boot.css();</script>';
  if (html.indexOf(boot) < 0 || html.indexOf(css) < 0) throw new Error('index.html: boot.js / Boot.css() not found');
  html = html.replace(boot, '<script src="android/android.js"></script>\n  ' + boot)
    .replace(css, css + '\n  <link rel="stylesheet" href="android/android.css">');
  fs.writeFileSync(idx, html);
  fs.rmSync(path.join(app, 'appinfo.json'), { force: true });   // webOS only
}

function gradleBuild() {
  fs.writeFileSync(path.join(androidDir, 'local.properties'), 'sdk.dir=' + sdk.split(path.sep).join('/') + '\n');
  const env = Object.assign({}, process.env, { JAVA_HOME: javaHome, ANDROID_HOME: sdk });
  const task = debug ? 'assembleDebug' : 'assembleRelease';
  const isWin = process.platform === 'win32';
  // .bat files need the shell on Windows
  const run = (a) => execFileSync(isWin ? 'cmd.exe' : gradle, (isWin ? ['/c', gradle] : []).concat(a), { cwd: root, stdio: 'inherit', env });
  try { run(['-p', androidDir, task, '--console=plain']); }
  finally { try { run(['--stop', '--quiet']); } catch (e) { /* ignore */ } }   // the daemon holds ~1.5 GB
  const outDir = path.join(androidDir, 'app', 'build', 'outputs', 'apk', debug ? 'debug' : 'release');
  const apk = fs.readdirSync(outDir).filter((f) => f.endsWith('.apk')).map((f) => path.join(outDir, f))[0];
  if (!apk) throw new Error('APK not found in ' + outDir);
  if (!debug && /unsigned/.test(apk)) throw new Error('The release APK is unsigned: ~/.ekrani/signing.properties is missing');
  return apk;
}

function main() {
  if (args.includes('--bump')) bump();
  const v = readVersion();
  stageAssets();
  const apk = gradleBuild();
  fs.mkdirSync(path.join(root, 'dist'), { recursive: true });
  const out = path.join(root, 'dist', debug ? 'ekrani-iptv-debug.apk' : 'ekrani-iptv-' + v.name + '.apk');
  fs.copyFileSync(apk, out);
  console.log('\nOK: ' + path.relative(root, out) + ' (' + Math.round(fs.statSync(out).size / 1024) + ' KB), Android ' + v.name + ' (' + v.code + ')');
  if (args.includes('--publish')) {
    if (debug) throw new Error('--publish needs a release build');
    const dir = path.join(root, 'apk');
    fs.mkdirSync(dir, { recursive: true });
    fs.copyFileSync(out, path.join(dir, 'ekrani-iptv.apk'));
    const info = { name: v.name, code: v.code, apk: REPO_RAW + 'apk/ekrani-iptv.apk', size: fs.statSync(out).size, date: new Date().toISOString() };
    fs.writeFileSync(path.join(dir, 'android.json'), JSON.stringify(info, null, 2) + '\n');
    console.log('Published: apk/ekrani-iptv.apk + apk/android.json (commit and push them)');
  }
}

try { main(); } catch (e) { console.error(e.message || e); process.exit(1); }
