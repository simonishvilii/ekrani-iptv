/*
 * Racing – the game on the TV: lobby (QR code, players joining from phones), countdown, race, results.
 * One screen per human player: 1 = full screen, 2 = top / bottom halves, 3-4 = quarters.
 * Rendering scale adapts to the frame rate (the TV GPU is the limit, not the CPU).
 */
(function () {
  'use strict';

  var VERSION = '0.1.0';
  var COLORS = [0xe8382f, 0x2f7cf0, 0xf2b922, 0x2fbf62];
  var CSS_COLORS = ['#ff4d4d', '#3d8bff', '#ffc933', '#3ddc84'];
  var AI_NAMES = ['Nika', 'Mari', 'Luka', 'Ana'];
  var CARS = 4;
  var B = Car.BITS;

  var T = {
    ka: { join: 'შემოუერთდი ტელეფონით', s1: 'ტელეფონი იმავე Wi-Fi ქსელში უნდა იყოს', s2: 'დაასკანერე QR კოდი კამერით', s3: 'ან გახსენი ბრაუზერში:',
      code: 'კოდი', free: 'თავისუფალი', ready: 'დაკავშირებულია', remote: 'პულტი', start: 'რბოლის დასაწყებად: ტელეფონზე „რბოლის დაწყება“ ან პულტზე OK',
      lap: 'წრე', go: 'სტარტი!', wrong: 'საწინააღმდეგო მიმართულება', finish: 'ფინიში', results: 'შედეგები', paused: 'პაუზა',
      pausedHint: 'გაგრძელება: OK ან ტელეფონი · ლობიში: Back', again: 'ახალი რბოლა: OK ან ტელეფონი', boost: 'ბუსტი', noNet: 'ქსელის სერვერი არ ეშვება',
      connecting: 'ქსელი იტვირთება…', player: 'მოთამაშე', kmh: 'კმ/სთ', nitro: 'ნიტრო!', crash: 'ავარია!', hitIt: 'დაარტყი!', draft: 'სლიპსტრიმი' },
    en: { join: 'Join with your phone', s1: 'The phone must be on the same Wi-Fi', s2: 'Scan the QR code with the camera', s3: 'or open in the browser:',
      code: 'Code', free: 'Free', ready: 'Connected', remote: 'Remote', start: 'To start: “Start race” on a phone or OK on the remote',
      lap: 'Lap', go: 'GO!', wrong: 'Wrong way', finish: 'Finish', results: 'Results', paused: 'Paused',
      pausedHint: 'Resume: OK or phone · Lobby: Back', again: 'New race: OK or phone', boost: 'Boost', noNet: 'The network server does not start',
      connecting: 'Starting the network…', player: 'Player', kmh: 'km/h', nitro: 'NITRO!', crash: 'Crash!', hitIt: 'Takedown!', draft: 'Slipstream' },
    ru: { join: 'Подключитесь с телефона', s1: 'Телефон должен быть в той же сети Wi-Fi', s2: 'Отсканируйте QR-код камерой', s3: 'или откройте в браузере:',
      code: 'Код', free: 'Свободно', ready: 'Подключён', remote: 'Пульт', start: 'Старт: «Начать гонку» на телефоне или OK на пульте',
      lap: 'Круг', go: 'Старт!', wrong: 'Не туда', finish: 'Финиш', results: 'Результаты', paused: 'Пауза',
      pausedHint: 'Продолжить: OK или телефон · В лобби: Back', again: 'Новая гонка: OK или телефон', boost: 'Буст', noNet: 'Сетевой сервер не запускается',
      connecting: 'Запуск сети…', player: 'Игрок', kmh: 'км/ч', nitro: 'НИТРО!', crash: 'Авария!', hitIt: 'Сбил!', draft: 'Слипстрим' }
  };
  var lang = (navigator.language || 'ka').slice(0, 2);
  if (!T[lang]) lang = 'ka';
  var t = T[lang];
  var $ = function (id) { return document.getElementById(id); };

  /* ---------- renderer / scene ---------- */
  var W = window.innerWidth, H = window.innerHeight;
  var canvas = $('gl');
  var renderer = new THREE.WebGLRenderer({ canvas: canvas, antialias: true, powerPreference: 'high-performance', stencil: false });
  var scale = 0.75;    // render resolution vs. the screen (adapts, see adapt())
  renderer.setPixelRatio(scale);
  renderer.setSize(W, H);
  renderer.setScissorTest(true);
  renderer.outputEncoding = THREE.sRGBEncoding;

  var scene = new THREE.Scene();
  var tr = Track.build('mountain');
  if (tr.minRadius < tr.wall + 4) console.warn('track: tight bend, radius ' + tr.minRadius.toFixed(1) + ' m');
  var world = World.build(scene, tr);
  var hemi = new THREE.HemisphereLight(0xdfe9ff, 0x5d6b40, 0.8);
  scene.add(hemi);
  var sun = new THREE.DirectionalLight(0xfff0d8, 0.9);
  sun.position.copy(World.SUN);
  scene.add(sun);
  var fx = Fx.create(scene, CARS);
  var pickups = Pickups.create(scene, tr);

  /* ---------- players & cars ---------- */
  // player: { id (phone id or 'kb'), slot 0..3, bits, online, car }
  var players = [];
  var cars = [];
  var wheels = new THREE.InstancedMesh(Car.wheelGeometry(), new THREE.MeshLambertMaterial({ vertexColors: true }), CARS * 4);
  wheels.frustumCulled = false;
  scene.add(wheels);

  function humanOf(car) { for (var i = 0; i < players.length; i++) if (players[i].car === car) return players[i]; return null; }

  function setupCars() {
    cars.forEach(function (c) { scene.remove(c.mesh); });
    cars = [];
    var humans = players.slice().sort(function (a, b) { return a.slot - b.slot; });
    var aiCount = CARS - humans.length, k;
    // AI in front, people at the back of the grid: there is someone to catch
    for (k = 0; k < aiCount; k++) {
      var ai = Car.create({ color: aiColor(k, humans), ai: true, skill: 0.9 + 0.035 * k, name: AI_NAMES[k] });
      cars.push(ai);
    }
    humans.forEach(function (p) {
      p.car = Car.create({ color: COLORS[p.slot], name: 'P' + (p.slot + 1) });
      cars.push(p.car);
    });
    cars.forEach(function (c, i) {
      c.reset(tr, -(9 + i * 7.5), i % 2 ? -3.4 : 3.4);
      scene.add(c.mesh);
    });
    wheels.count = cars.length * 4;
    fx.clear();
    layoutViews();
  }

  function aiColor(k, humans) {
    var used = humans.map(function (p) { return p.slot; }), free = [];
    for (var i = 0; i < 4; i++) if (used.indexOf(i) < 0) free.push(i);
    var extra = [0x9a5cf0, 0xf07a2f, 0x2fc4d6, 0xd6d6d6];
    return free[k] !== undefined ? COLORS[free[k]] : extra[k % 4];
  }

  /* ---------- views (split screen) ---------- */
  var views = [];
  function layoutViews() {
    var humans = players.filter(function (p) { return p.car; }).sort(function (a, b) { return a.slot - b.slot; });
    var n = Math.max(1, humans.length);
    var rects;
    if (n === 1) rects = [[0, 0, 1, 1]];
    else if (n === 2) rects = [[0, 0, 1, 0.5], [0, 0.5, 1, 0.5]];
    else rects = [[0, 0, 0.5, 0.5], [0.5, 0, 0.5, 0.5], [0, 0.5, 0.5, 0.5], [0.5, 0.5, 0.5, 0.5]].slice(0, n === 3 ? 3 : 4);
    views.forEach(function (v) { v.hud.parentNode.removeChild(v.hud); });
    views = rects.map(function (r, i) {
      var cam = new THREE.PerspectiveCamera(60, (r[2] * W) / (r[3] * H), 0.8, 2600);
      var hud = document.createElement('div');
      hud.className = 'hud' + (n > 1 ? ' small' : '');
      hud.style.left = r[0] * 100 + '%'; hud.style.top = r[1] * 100 + '%';
      hud.style.width = r[2] * 100 + '%'; hud.style.height = r[3] * 100 + '%';
      hud.innerHTML = '<div class="pos"><b>-</b><span>/' + CARS + '</span></div><div class="lap"></div><div class="time"></div>' +
        '<div class="spd"><b>0</b><span>' + t.kmh + '</span><i class="charge"><u></u></i></div><div class="msg"></div>' +
        (n > 1 ? '<div class="tag" style="background:' + CSS_COLORS[humans[i] ? humans[i].slot : 0] + '">P' + ((humans[i] ? humans[i].slot : 0) + 1) + '</div>' : '');
      $('huds').appendChild(hud);
      var car = humans[i] ? humans[i].car : cars[cars.length - 1];
      return { rect: r, cam: cam, hud: hud, car: car, yaw: car ? car.heading : 0, shake: 0, fov: 60,
        el: { pos: hud.querySelector('.pos b'), lap: hud.querySelector('.lap'), time: hud.querySelector('.time'), spd: hud.querySelector('.spd b'),
          charge: hud.querySelector('.charge u'), chargeBox: hud.querySelector('.charge'), msg: hud.querySelector('.msg') } };
    });
    $('minimap').className = n > 1 ? 'center' : '';
  }

  /* ---------- game state ---------- */
  var state = 'lobby', paused = false, clock = 0, raceTime = 0, countT = 0, doneT = 0, lastCount = 0, order = [];

  function setState(s) {
    state = s;
    paused = false;
    $('lobby').className = s === 'lobby' ? 'on' : '';
    $('huds').className = (s === 'race' || s === 'count' || s === 'done') ? 'on' : '';
    $('results').className = s === 'done' ? 'on' : '';
    $('pause').className = '';
    $('minimap').style.display = (s === 'race' || s === 'count') ? 'block' : 'none';
    if (s === 'lobby') { Sfx.silence(); lobbyCars(); }
    tellPhones();
  }

  /* lobby: the joined players' cars wait on the grid, the camera circles the start */
  function lobbyCars() {
    setupCars();
  }

  function startRace() {
    if (!players.length) addKeyboardPlayer();
    setupCars();
    raceTime = 0; countT = 3.6; lastCount = 4; order = [];
    pickups.reset();
    Sfx.init(); Sfx.resume();
    setState('count');
  }

  function addKeyboardPlayer() {
    if (findPlayer('kb')) return;
    var slot = freeSlot();
    if (slot < 0) return;
    players.push({ id: 'kb', slot: slot, bits: 0, online: true, car: null });
    renderSlots();
  }

  function findPlayer(id) { for (var i = 0; i < players.length; i++) if (players[i].id === id) return players[i]; return null; }
  function freeSlot() {
    for (var s = 0; s < 4; s++) { var used = false; for (var i = 0; i < players.length; i++) if (players[i].slot === s) used = true; if (!used) return s; }
    return -1;
  }

  /* ---------- network events ---------- */
  var netInfo = null;
  function onNet(m) {
    if (m.t === 'info') { netInfo = m; showQr(); return; }
    if (m.t === 'neterr') { $('qrUrl').textContent = t.noNet + ' (' + m.e + ')'; return; }
    if (m.t === 'down') { return; }
    if (m.t === 'join') {
      var p = findPlayer(m.id);
      if (!p) {
        var slot = freeSlot();
        if (slot < 0) { Net.kick(m.id); return; }
        // a phone takes over the remote's place in the lobby
        var kb = findPlayer('kb');
        if (kb && state === 'lobby') { players.splice(players.indexOf(kb), 1); slot = kb.slot; }
        p = { id: m.id, slot: slot, bits: 0, online: true, car: null };
        players.push(p);
        if (state === 'lobby') lobbyCars();
      }
      p.online = true;
      renderSlots();
      tellPhone(p);
      Net.to(p.id, { t: 'buzz', ms: 60 });
      return;
    }
    if (m.t === 'leave') {
      var q = findPlayer(m.id);
      if (!q) return;
      q.online = false; q.bits = 0;
      if (q.car) q.car.input = 0;
      if (state === 'lobby') { players.splice(players.indexOf(q), 1); lobbyCars(); }
      renderSlots();
      return;
    }
    if (m.t === 'in') {
      var r = findPlayer(m.id);
      if (r) { r.bits = m.k; if (r.car) r.car.input = m.k; }
      return;
    }
    if (m.t === 'cmd') command(m.c);
  }

  function command(c) {
    if (c === 'start') {
      if (state === 'lobby' || state === 'done') startRace();
      else if (state === 'race' && paused) resume();
    } else if (c === 'pause') { if (state === 'race' && !paused) pause(); }
    else if (c === 'resume') { if (paused) resume(); }
  }
  function pause() { paused = true; $('pause').className = 'on'; Sfx.silence(); tellPhones(); }
  function resume() { paused = false; $('pause').className = ''; tellPhones(); }

  function tellPhone(p) {
    if (typeof p.id !== 'number') return;
    var c = p.car;
    // a phone that joined during a race drives in the next one
    var s = c ? state : (state === 'done' ? 'lobby' : (state === 'lobby' ? 'lobby' : 'wait'));
    Net.to(p.id, { t: 'p', n: p.slot + 1, c: CSS_COLORS[p.slot], s: s, paused: paused,
      pos: c ? c.place || 0 : 0, cars: cars.length, lap: c ? lapOf(c) : 0, laps: tr.laps });
  }
  function tellPhones() { players.forEach(tellPhone); }
  function lapOf(c) { return Math.max(1, Math.min(tr.laps, Math.floor(c.raceDist / tr.length) + 1)); }

  /* ---------- lobby UI ---------- */
  function showQr() {
    if (!netInfo || !netInfo.ip) { $('qrUrl').textContent = t.connecting; return; }
    var url = 'http://' + netInfo.ip + ':' + netInfo.port + '/';
    var full = url + '?c=' + Net.code() + '&l=' + lang;
    $('qrUrl').textContent = url.replace(/\/$/, '');
    $('qrCode').textContent = Net.code();
    var q = qrcode(0, 'M');
    q.addData(full); q.make();
    var n = q.getModuleCount(), cv = $('qr'), px = Math.floor(300 / (n + 8)), size = px * (n + 8);
    cv.width = cv.height = size;
    var x = cv.getContext('2d');
    x.fillStyle = '#fff'; x.fillRect(0, 0, size, size);
    x.fillStyle = '#0b0f1a';
    for (var r = 0; r < n; r++) for (var c = 0; c < n; c++) if (q.isDark(r, c)) x.fillRect((c + 4) * px, (r + 4) * px, px, px);
  }

  function renderSlots() {
    var html = '';
    for (var s = 0; s < 4; s++) {
      var p = null;
      for (var i = 0; i < players.length; i++) if (players[i].slot === s) p = players[i];
      html += '<div class="slot' + (p ? ' on' : '') + '"><i style="background:' + CSS_COLORS[s] + '"></i><b>P' + (s + 1) + '</b><span>' +
        (p ? (p.id === 'kb' ? t.remote : t.ready) + (p.online ? '' : ' …') : t.free) + '</span></div>';
    }
    $('slots').innerHTML = html;
    Net.allowScreenSaver(!players.length && state === 'lobby');
  }

  /* ---------- keyboard / TV remote ---------- */
  var KEYS = { 37: B.left, 39: B.right, 38: B.gas, 40: B.brake, 32: B.hand, 403: B.hand, 16: B.drift, 13: B.drift, 17: B.drift };
  var kbBits = 0;
  document.addEventListener('keydown', function (e) {
    var k = e.keyCode;
    Sfx.init(); Sfx.resume();
    if (k === 461 || k === 27 || k === 8) {       // Back
      e.preventDefault();
      if (state === 'race' && !paused) pause();
      else if (state === 'lobby') { try { window.close(); } catch (x) { /* ignore */ } }
      else { players = players.filter(function (p) { return p.online; }); setState('lobby'); renderSlots(); }
      return;
    }
    if (k === 49 || k === 406) { $('dbg').classList.toggle('on'); return; }   // 1 / blue button: debug line
    if (state === 'lobby' && k === 13) { e.preventDefault(); startRace(); return; }
    if (state === 'done' && k === 13) { startRace(); return; }
    if (paused && k === 13) { resume(); return; }
    if (KEYS[k]) { e.preventDefault(); kbBits |= KEYS[k]; applyKb(); }
  });
  document.addEventListener('keyup', function (e) {
    if (KEYS[e.keyCode]) { kbBits &= ~KEYS[e.keyCode]; applyKb(); }
  });
  function applyKb() {
    var p = findPlayer('kb');
    if (p && p.car) p.car.input = kbBits;
  }

  /* ---------- simulation ---------- */
  function step(dt) {
    var racing = state === 'race';
    if (state === 'count') {
      countT -= dt;
      var n = Math.ceil(countT - 0.6);
      if (n !== lastCount && n >= 0) {
        lastCount = n;
        if (n > 0) Sfx.beep(440, 0.18); else Sfx.beep(880, 0.45, 0.2);
        players.forEach(function (p) { Net.to(p.id, { t: 'buzz', ms: n > 0 ? 25 : 90 }); });
      }
      if (countT <= 0.6) { state = 'race'; racing = true; tellPhones(); }
    }
    if (racing) raceTime += dt;

    // AI keeps driving after the finish and on the results screen; people coast to a stop
    var live = racing || state === 'done';
    var lead = -1e9;
    for (var h = 0; h < players.length; h++) if (players[h].car) lead = Math.max(lead, players[h].car.raceDist);
    slipstream(dt, live);
    for (var i = 0; i < cars.length; i++) {
      var c = cars[i];
      if (c.ai && live) {
        // gentle rubber band: AI far ahead of the best human takes bends a bit slower, far behind a bit faster
        var gap = lead - c.raceDist;
        c.rubber = Math.max(0.88, Math.min(1.1, 1 + gap * 0.0015));
        c.think(tr, cars, dt);
      }
      var hadBoost = c.boost > 0;
      c.update(dt, tr, c.ai ? live : racing && !c.finished);
      if (!hadBoost && c.boost > 0) {
        var hp = humanOf(c);
        if (hp) { Net.to(hp.id, { t: 'buzz', ms: c.boostLevel === 2 ? 70 : 40 }); Sfx.boost(); }
      }
    }
    collide();
    for (i = 0; i < cars.length; i++) {
      var cc = cars[i];
      if (cc.impact > 5 && !cc.hitShown) {
        cc.hitShown = true;
        var hp2 = humanOf(cc);
        if (hp2) { Net.to(hp2.id, { t: 'buzz', ms: Math.min(150, 20 + cc.impact * 6) }); Sfx.hit(cc.impact); }
      }
      if (cc.impact < 1) cc.hitShown = false;
      if (cc.landed) {
        cc.landed = false; cc.dust = true;
        var hp4 = humanOf(cc);
        if (hp4) Net.to(hp4.id, { t: 'buzz', ms: 120 });
        if (anyHumanNear(cc)) Sfx.hit(14);
      }
      if (racing && !cc.finished && cc.raceDist >= tr.laps * tr.length) {
        cc.finished = true; cc.finishTime = raceTime;
        order.push(cc);
        var hp3 = humanOf(cc);
        if (hp3) Net.to(hp3.id, { t: 'buzz', ms: 250 });
      }
      cc.sync();
      cc.wheelMatrices(wheels, i * 4);
    }
    wheels.instanceMatrix.needsUpdate = true;
    rank();

    if (racing) {
      var humansLeft = players.some(function (p) { return p.car && !p.car.finished; });
      if (!humansLeft) {
        doneT += dt;
        if (doneT > 2.5) { doneT = 0; showResults(); }
      } else doneT = 0;
    }
  }

  /* slipstream: a car close behind another (same lane, same direction, at speed) builds up a pull
     over about a second; it fades quickly once out of the wake */
  function slipstream(dt, live) {
    for (var i = 0; i < cars.length; i++) {
      var c = cars[i], inWake = 0;
      if (live && !c.air && c.wreck <= 0 && c.s > 18) {
        var fx = Math.sin(c.heading), fz = Math.cos(c.heading);
        for (var j = 0; j < cars.length; j++) {
          var o = cars[j];
          if (o === c || o.air || o.s < 12) continue;
          var dx = o.x - c.x, dz = o.z - c.z;
          var along = dx * fx + dz * fz;
          if (along < 4 || along > 24) continue;
          var side = Math.abs(dx * fz - dz * fx);
          if (side > 2.4) continue;
          if (Math.cos(o.heading - c.heading) < 0.85) continue;
          inWake = Math.max(inWake, 1 - (along - 4) / 20 * 0.4);   // closer = stronger
        }
      }
      var before = c.draft;
      if (inWake > 0) c.draft = Math.min(inWake, c.draft + dt * 0.9);
      else c.draft = Math.max(0, c.draft - dt * 1.6);
      if (before < 0.75 && c.draft >= 0.75 && !(c.draftMsg > 0)) {
        c.draftMsg = 1.2;
        var hp = humanOf(c);
        if (hp) Net.to(hp.id, { t: 'buzz', ms: 30 });
      }
    }
  }

  /* cars are two circles each (front, back): push apart, bounce */
  function collide() {
    for (var a = 0; a < cars.length; a++) {
      for (var b = a + 1; b < cars.length; b++) {
        var A = cars[a], Bc = cars[b];
        var dx0 = Bc.x - A.x, dz0 = Bc.z - A.z;
        if (dx0 * dx0 + dz0 * dz0 > 36) continue;
        if (Math.abs(A.y - Bc.y) > 1.2) continue;     // one of them is flying over the other
        for (var i = -1; i <= 1; i += 2) {
          for (var j = -1; j <= 1; j += 2) {
            var ax = A.x + Math.sin(A.heading) * 1.1 * i, az = A.z + Math.cos(A.heading) * 1.1 * i;
            var bx = Bc.x + Math.sin(Bc.heading) * 1.1 * j, bz = Bc.z + Math.cos(Bc.heading) * 1.1 * j;
            var dx = bx - ax, dz = bz - az, d2 = dx * dx + dz * dz;
            if (d2 >= 4 || d2 < 1e-6) continue;
            var d = Math.sqrt(d2), nx = dx / d, nz = dz / d, pen = (2 - d) / 2;
            A.x -= nx * pen; A.z -= nz * pen; Bc.x += nx * pen; Bc.z += nz * pen;
            var rel = (Bc.vx - A.vx) * nx + (Bc.vz - A.vz) * nz;
            if (rel < 0) {
              if (state === 'race') takedown(A, Bc, nx, nz, -rel);
              var imp = -rel * 0.65;
              A.vx -= nx * imp; A.vz -= nz * imp; Bc.vx += nx * imp; Bc.vz += nz * imp;
              A.impact = Math.max(A.impact, -rel); Bc.impact = Math.max(Bc.impact, -rel);
              A.omega += (Math.random() - 0.5) * -rel * 0.04; Bc.omega += (Math.random() - 0.5) * -rel * 0.04;
            }
          }
        }
      }
    }
  }

  /* who drove into whom: the car moving into the other one more is the attacker */
  var SPIN_AT = 7.5, FLIP_AT = 14;
  function takedown(A, Bc, nx, nz, hit) {
    if (hit < SPIN_AT - 2) return;
    var aIn = A.vx * nx + A.vz * nz, bIn = -(Bc.vx * nx + Bc.vz * nz);
    var atk = aIn >= bIn ? A : Bc, vic = atk === A ? Bc : A;
    var px = atk === A ? nx : -nx, pz = atk === A ? nz : -nz;    // push direction, away from the attacker
    // nitro / boost make the hit count for more
    var power = hit + (atk.nitro > 0 ? 5 : 0) + (atk.boost > 0 ? 2.5 : 0);
    if (power < SPIN_AT) return;
    if (!vic.knock(px, pz, power, power >= FLIP_AT)) return;
    vic.crashMsg = 1.6; atk.hitMsg = 1.4;
    var hv = humanOf(vic), ha = humanOf(atk);
    if (hv) Net.to(hv.id, { t: 'buzz', ms: 260 });
    if (ha) Net.to(ha.id, { t: 'buzz', ms: 90 });
    if (hv || ha) Sfx.hit(power);
  }
  function anyHumanNear(c) {
    for (var i = 0; i < players.length; i++) {
      var o = players[i].car;
      if (o && (o.x - c.x) * (o.x - c.x) + (o.z - c.z) * (o.z - c.z) < 90 * 90) return true;
    }
    return false;
  }

  function takeNitro(c) {
    c.takeNitro();
    c.nitroMsg = 1.2;
    var hp = humanOf(c);
    if (hp) { Net.to(hp.id, { t: 'buzz', ms: 80 }); Sfx.boost(); }
  }

  function rank() {
    var list = cars.slice().sort(function (a, b) {
      if (a.finished && b.finished) return a.finishTime - b.finishTime;
      if (a.finished !== b.finished) return a.finished ? -1 : 1;
      return b.raceDist - a.raceDist;
    });
    for (var i = 0; i < list.length; i++) list[i].place = i + 1;
  }

  function showResults() {
    var list = cars.slice().sort(function (a, b) { return a.place - b.place; });
    var html = '<h2>' + t.results + '</h2>';
    list.forEach(function (c) {
      var hp = humanOf(c);
      var color = '#' + new THREE.Color(c.color).getHexString();
      html += '<div class="row' + (hp ? ' me' : '') + '"><b>' + c.place + '</b><i style="background:' + color + '"></i><span>' +
        (hp ? t.player + ' ' + (hp.slot + 1) : c.name) + '</span><em>' + (c.finished ? fmt(c.finishTime) : '—') + '</em></div>';
    });
    html += '<p>' + t.again + '</p>';
    $('results').innerHTML = html;
    setState('done');
  }

  function fmt(s) {
    var m = Math.floor(s / 60), r = s - m * 60;
    return m + ':' + (r < 10 ? '0' : '') + r.toFixed(2);
  }

  /* ---------- cameras ---------- */
  var tmpV = new THREE.Vector3();
  function cameras(dt) {
    for (var i = 0; i < views.length; i++) {
      var v = views[i], c = v.car, cam = v.cam;
      if (!c) continue;
      if (state === 'lobby') {
        var a = clock * 0.12;
        var o = Track.pointAt(tr, -20, 0, {});
        cam.position.set(o.x + Math.cos(a) * 46, 13 + Math.sin(clock * 0.2) * 3, o.z + Math.sin(a) * 46);
        cam.lookAt(o.x, 1, o.z);
        v.yaw = c.heading;
        setFov(v, 55);
        continue;
      }
      var d = c.heading - v.yaw;
      while (d > Math.PI) d -= Math.PI * 2;
      while (d < -Math.PI) d += Math.PI * 2;
      v.yaw += d * (1 - Math.exp(-dt * (c.wreck > 0 || c.air ? 1.2 : (c.drift ? 3.2 : 6))));
      var spd = Math.abs(c.s), back = 7.2 + spd * 0.025, up = 2.7 + spd * 0.006;
      var sx = Math.sin(v.yaw), sz = Math.cos(v.yaw);
      v.shake = Math.max(v.shake * Math.exp(-dt * 7), c.impact > 4 ? Math.min(0.5, c.impact * 0.03) : 0);
      cam.position.set(c.x - sx * back + (Math.random() - 0.5) * v.shake, up + c.y * 0.6 + (Math.random() - 0.5) * v.shake, c.z - sz * back);
      tmpV.set(c.x + sx * 6, 1.25 + c.y * 0.8, c.z + sz * 6);
      cam.lookAt(tmpV);
      setFov(v, 58 + 14 * Math.min(1, spd / Car.MAX) + (c.nitro > 0 ? 11 : (c.boost > 0 ? 7 : 0)));
    }
  }
  function setFov(v, f) {
    v.fov += (f - v.fov) * 0.1;
    if (Math.abs(v.cam.fov - v.fov) > 0.05) { v.cam.fov = v.fov; v.cam.updateProjectionMatrix(); }
  }

  /* ---------- HUD (DOM, refreshed ~10x a second) ---------- */
  var hudT = 0;
  function hud(dt) {
    hudT -= dt;
    if (hudT > 0) return;
    hudT = 0.1;
    for (var i = 0; i < views.length; i++) {
      var v = views[i], c = v.car, e = v.el;
      if (!c) continue;
      e.pos.textContent = c.place || '-';
      e.lap.textContent = t.lap + ' ' + lapOf(c) + '/' + tr.laps;
      e.time.textContent = fmt(c.finished ? c.finishTime : raceTime);
      e.spd.textContent = Math.round(Math.abs(c.s) * 3.6);
      var drafting = !(c.nitro > 0) && !c.drift && c.draft > 0.05;
      var ch = c.nitro > 0 ? c.nitro / Car.NITRO_TIME : (c.drift ? Math.min(1, c.charge / 2.4) : (drafting ? c.draft : 0));
      e.charge.style.width = (ch * 100) + '%';
      e.charge.style.background = c.nitro > 0 ? '#38e8ff' : (drafting ? '#b9f5c8' : (c.charge >= 2.4 ? '#ff9b2f' : (c.charge >= 1.1 ? '#4fb3ff' : '#cfd6e4')));
      e.chargeBox.style.opacity = c.drift || c.boost > 0 || c.nitro > 0 || drafting ? 1 : 0.25;
      if (c.nitroMsg > 0) c.nitroMsg -= 0.1;
      if (c.draftMsg > 0) c.draftMsg -= 0.1;
      if (c.crashMsg > 0) c.crashMsg -= 0.1;
      if (c.hitMsg > 0) c.hitMsg -= 0.1;
      var msg = '', kind = '';
      if (state === 'count') msg = lastCount > 0 ? String(lastCount) : t.go;
      else if (state === 'race' && raceTime < 1) msg = t.go;
      else if (c.finished) msg = t.finish + ' · ' + c.place;
      else if (c.crashMsg > 0) { msg = t.crash; kind = ' crash'; }
      else if (c.hitMsg > 0) { msg = t.hitIt; kind = ' hit'; }
      else if (c.nitroMsg > 0) { msg = t.nitro; kind = ' nitro'; }
      else if (c.draftMsg > 0 && c.draft > 0.3) { msg = t.draft; kind = ' draft'; }
      else if (c.wrongWay > 60) msg = t.wrong;
      e.msg.textContent = msg;
      e.msg.className = 'msg' + (msg && (state === 'count' || (state === 'race' && raceTime < 1)) ? ' big' : kind);
    }
    phoneT -= 0.1;
    if (phoneT <= 0) { phoneT = 0.5; if (state === 'race' || state === 'count') tellPhones(); }
    minimap();
  }
  var phoneT = 0;

  /* ---------- minimap ---------- */
  var mm = $('minimap'), mmx = mm.getContext('2d'), mmBase = null, mmS = 1, mmOx = 0, mmOz = 0;
  function minimapBase() {
    var minx = 1e9, maxx = -1e9, minz = 1e9, maxz = -1e9, i;
    for (i = 0; i < tr.n; i++) { minx = Math.min(minx, tr.px[i]); maxx = Math.max(maxx, tr.px[i]); minz = Math.min(minz, tr.pz[i]); maxz = Math.max(maxz, tr.pz[i]); }
    var S = mm.width, pad = 16;
    mmS = (S - pad * 2) / Math.max(maxx - minx, maxz - minz);
    mmOx = pad + ((S - pad * 2) - (maxx - minx) * mmS) / 2 - minx * mmS;
    mmOz = pad + ((S - pad * 2) - (maxz - minz) * mmS) / 2 - minz * mmS;
    mmBase = document.createElement('canvas'); mmBase.width = mmBase.height = S;
    var x = mmBase.getContext('2d');
    x.lineJoin = 'round';
    x.beginPath();
    for (i = 0; i <= tr.n; i++) { var k = i % tr.n, X = S - (tr.px[k] * mmS + mmOx), Z = S - (tr.pz[k] * mmS + mmOz); if (i) x.lineTo(X, Z); else x.moveTo(X, Z); }
    x.strokeStyle = 'rgba(0,0,0,0.55)'; x.lineWidth = 13; x.stroke();
    x.strokeStyle = 'rgba(235,240,250,0.9)'; x.lineWidth = 7; x.stroke();
    var X0 = S - (tr.px[0] * mmS + mmOx), Z0 = S - (tr.pz[0] * mmS + mmOz);
    x.fillStyle = '#ff4d4d'; x.fillRect(X0 - 2, Z0 - 8, 4, 16);
  }
  function minimap() {
    if (!mmBase) minimapBase();
    var S = mm.width;
    mmx.clearRect(0, 0, S, S);
    mmx.drawImage(mmBase, 0, 0);
    for (var i = 0; i < cars.length; i++) {
      var c = cars[i], hp = humanOf(c);
      var X = S - (c.x * mmS + mmOx), Z = S - (c.z * mmS + mmOz);
      mmx.beginPath(); mmx.arc(X, Z, hp ? 8 : 6, 0, 6.3);
      mmx.fillStyle = '#' + new THREE.Color(c.color).getHexString(); mmx.fill();
      mmx.lineWidth = hp ? 3 : 2; mmx.strokeStyle = hp ? '#fff' : 'rgba(0,0,0,0.6)'; mmx.stroke();
    }
  }

  /* ---------- render + adaptive resolution ---------- */
  function render() {
    var pr = renderer.getPixelRatio();
    for (var i = 0; i < views.length; i++) {
      var v = views[i], r = v.rect;
      var x = Math.round(r[0] * W), w = Math.round(r[2] * W), h = Math.round(r[3] * H);
      var y = Math.round(H - (r[1] + r[3]) * H);   // WebGL: from the bottom
      renderer.setViewport(x, y, w, h);
      renderer.setScissor(x, y, w, h);
      var asp = w / h;
      if (Math.abs(v.cam.aspect - asp) > 1e-3) { v.cam.aspect = asp; v.cam.updateProjectionMatrix(); }
      world.sky.position.copy(v.cam.position);
      fx.setViewHeight(h * pr);
      renderer.render(scene, v.cam);
    }
  }

  var frames = 0, acc = 0, adaptT = 0, good = 0, fps = 60;
  function adapt(dt) {
    frames++; acc += dt; adaptT += dt;
    if (adaptT < 1) return;
    fps = frames / acc;
    frames = 0; acc = 0; adaptT = 0;
    var target = scale;
    if (fps < 50 && scale > 0.5) { target = Math.max(0.5, scale - 0.1); good = 0; }
    else if (fps > 58) { good++; if (good >= 3 && scale < 1) { target = Math.min(1, scale + 0.05); good = 0; } }
    if (target !== scale) { scale = target; renderer.setPixelRatio(scale); renderer.setSize(W, H); }
    var info = renderer.info.render;
    $('dbg').textContent = VERSION + ' · ' + Math.round(fps) + ' fps · ' + Math.round(W * scale) + '×' + Math.round(H * scale) +
      ' · ' + info.calls + ' calls · ' + Math.round(info.triangles / 1000) + 'k tris · audio ' + Sfx.state();
  }

  window.addEventListener('resize', function () {
    W = window.innerWidth; H = window.innerHeight;
    renderer.setSize(W, H);
  });

  /* ---------- loop ---------- */
  var last = performance.now();
  function frame(now) {
    requestAnimationFrame(frame);
    var dt = Math.min(0.05, (now - last) / 1000);
    last = now;
    clock += dt;
    if (!paused) {
      // fixed physics steps (stable handling whatever the frame rate)
      var steps = Math.max(1, Math.round(dt / (1 / 120)));
      var h = dt / steps;
      for (var s = 0; s < steps; s++) step(h);
      fx.update(dt, cars, state === 'race');
      pickups.update(dt, cars, state === 'race' ? takeNitro : null);
      if (state !== 'lobby') players.forEach(function (p, i) {
        var e = Sfx.engine(p.slot);
        if (e && p.car) e.set(p.car, players.length > 1 ? 0.6 : 1, true);
      });
    }
    cameras(dt);
    hud(dt);
    render();
    adapt(dt);
  }

  /* ---------- start ---------- */
  function texts() {
    $('tJoin').textContent = t.join; $('tS1').textContent = t.s1; $('tS2').textContent = t.s2; $('tS3').textContent = t.s3;
    $('tCode').textContent = t.code; $('tStart').textContent = t.start; $('tPaused').textContent = t.paused; $('tPausedHint').textContent = t.pausedHint;
    $('qrUrl').textContent = t.connecting;
  }
  texts();
  renderSlots();
  setState('lobby');
  Net.start(onNet);
  requestAnimationFrame(frame);
  window.Game = { cars: function () { return cars; }, track: tr, pickups: pickups, players: players, state: function () { return state; }, start: startRace };
})();
