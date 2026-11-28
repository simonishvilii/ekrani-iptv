/*
 * Cars: low-poly model (flat-shaded, Lambert = per-vertex light, cheap), arcade handling and the AI driver.
 *
 * Handling ("velocity follows heading"): the heading turns with the steering, the velocity is pulled
 * toward the heading by tyre grip. Less grip (drift, handbrake) = the car slides. With buttons instead of
 * an analogue stick the steering value ramps up while an arrow is held and springs back when released.
 *
 * Drift: hold the drift button while steering at speed. The direction is fixed when the drift starts;
 * the arrows then tighten (into the turn) or widen (against it) the line. Holding it charges a boost
 * (blue, then orange) that fires when the button is released. Drift includes the throttle.
 */
var Car = (function () {
  'use strict';

  var MAX = 52;          // m/s top speed (187 km/h)
  var ACC = 13;
  var BRAKE = 30;
  var REV_MAX = 12, REV_ACC = 9;
  var WHEEL_R = 0.36;
  var PIVOT = 0.7;       // centre of mass height
  var GRAV = 22;
  var NITRO_TIME = 3;
  var BITS = { left: 1, right: 2, gas: 4, brake: 8, hand: 16, drift: 32 };

  /* ---------- model ---------- */

  function taper(w, h, l, tw, tf, tb, y0, zc) {
    // bottom: w x l around zc; top: tw wide, from zc - tb to zc + tf
    var b = [[-w / 2, y0, zc - l / 2], [w / 2, y0, zc - l / 2], [w / 2, y0, zc + l / 2], [-w / 2, y0, zc + l / 2]];
    var t = [[-tw / 2, y0 + h, zc - tb], [tw / 2, y0 + h, zc - tb], [tw / 2, y0 + h, zc + tf], [-tw / 2, y0 + h, zc + tf]];
    var faces = [[t[0], t[3], t[2], t[1]], [b[0], b[1], b[2], b[3]], [b[3], b[2], t[2], t[3]], [b[1], b[0], t[0], t[1]], [b[2], b[1], t[1], t[2]], [b[0], b[3], t[3], t[0]]];
    var pos = [];
    faces.forEach(function (f) { pos.push.apply(pos, f[0].concat(f[1], f[2], f[0], f[2], f[3])); });
    var g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    return g;
  }

  function paint(g, color) {
    g = g.index ? g.toNonIndexed() : g;
    g.deleteAttribute('uv');
    var c = new THREE.Color(color).convertSRGBToLinear(), n = g.attributes.position.count, a = new Float32Array(n * 3);   // linear: deep, saturated paint after the sRGB output
    for (var i = 0; i < n; i++) { a[i * 3] = c.r; a[i * 3 + 1] = c.g; a[i * 3 + 2] = c.b; }
    g.setAttribute('color', new THREE.BufferAttribute(a, 3));
    g.computeVertexNormals();
    return g;
  }

  function merge(list) {
    var total = 0, i;
    for (i = 0; i < list.length; i++) total += list[i].attributes.position.count;
    var pos = new Float32Array(total * 3), col = new Float32Array(total * 3), nor = new Float32Array(total * 3), o = 0;
    for (i = 0; i < list.length; i++) {
      var g = list[i];
      pos.set(g.attributes.position.array, o * 3);
      col.set(g.attributes.color.array, o * 3);
      nor.set(g.attributes.normal.array, o * 3);
      o += g.attributes.position.count;
    }
    var m = new THREE.BufferGeometry();
    m.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    m.setAttribute('color', new THREE.BufferAttribute(col, 3));
    m.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
    return m;
  }

  function boxAt(w, h, d, x, y, z, color) {
    var g = new THREE.BoxGeometry(w, h, d); g.translate(x, y, z);
    return paint(g, color);
  }

  var bodyMat = null, lightMat = null;

  /* a tiny sky box for reflections in the paint and glass: sky above, bright horizon, green ground */
  function envCube() {
    function face(kind) {
      var cv = document.createElement('canvas'); cv.width = cv.height = 64;
      var x = cv.getContext('2d');
      if (kind === 'top') { x.fillStyle = '#6f9fe0'; x.fillRect(0, 0, 64, 64); }
      else if (kind === 'bottom') { x.fillStyle = '#4b5a3a'; x.fillRect(0, 0, 64, 64); }
      else {
        var g = x.createLinearGradient(0, 0, 0, 64);
        g.addColorStop(0, '#7fa9e3'); g.addColorStop(0.46, '#e9ecef'); g.addColorStop(0.52, '#a8b5a0'); g.addColorStop(1, '#55683f');
        x.fillStyle = g; x.fillRect(0, 0, 64, 64);
      }
      return cv;
    }
    var tex = new THREE.CubeTexture([face('side'), face('side'), face('top'), face('bottom'), face('side'), face('side')]);
    tex.needsUpdate = true;
    return tex;
  }

  function model(color) {
    if (!bodyMat) {
      // per-pixel light with a highlight and a faint sky reflection: the paint looks like paint
      bodyMat = new THREE.MeshPhongMaterial({ vertexColors: true, specular: 0x5a5a5a, shininess: 60,
        envMap: envCube(), combine: THREE.MixOperation, reflectivity: 0.16 });
      lightMat = new THREE.MeshBasicMaterial({ vertexColors: true });
    }
    var dark = 0x1c1f26, glass = 0x1d2a3a, c = new THREE.Color(color);
    var trim = c.clone().multiplyScalar(0.55).getHex();
    var parts = [
      paint(taper(1.94, 0.46, 4.25, 1.86, 2.0, 2.08, 0.3, 0), color),               // body
      paint(taper(1.86, 0.08, 1.5, 1.7, 0.7, 0.7, 0.76, 1.25), color),              // bonnet bulge
      boxAt(1.98, 0.16, 4.1, 0, 0.26, 0, dark),                                    // skirt
      paint(taper(1.66, 0.52, 2.15, 1.32, 0.15, 1.12, 0.76, -0.4), glass),          // cabin (glass)
      paint(taper(1.34, 0.06, 1.24, 1.3, 0.12, 1.08, 1.27, -0.6), color),           // roof
      boxAt(0.32, 0.02, 2.0, -0.22, 0.775, 1.0, 0xf5f5f0),                          // stripes
      boxAt(0.32, 0.02, 2.0, 0.22, 0.775, 1.0, 0xf5f5f0),
      boxAt(1.84, 0.07, 0.42, 0, 1.12, -1.92, trim),                               // spoiler
      boxAt(0.08, 0.3, 0.16, -0.62, 0.92, -1.9, dark),
      boxAt(0.08, 0.3, 0.16, 0.62, 0.92, -1.9, dark),
      boxAt(1.2, 0.16, 0.06, 0, 0.42, 2.11, dark),                                 // grille
      boxAt(2.02, 0.06, 0.34, 0, 0.24, 2.0, dark),                                  // front splitter
      boxAt(1.5, 0.14, 0.2, 0, 0.3, -2.1, dark),                                    // rear diffuser
      boxAt(0.12, 0.12, 0.2, -0.45, 0.32, -2.16, 0x8d929c),                         // exhausts
      boxAt(0.12, 0.12, 0.2, 0.45, 0.32, -2.16, 0x8d929c),
      boxAt(0.22, 0.12, 0.1, -0.95, 1.0, 0.62, color),                              // mirrors
      boxAt(0.22, 0.12, 0.1, 0.95, 1.0, 0.62, color),
      boxAt(0.08, 0.12, 1.0, -0.99, 0.7, 1.33, trim),                               // wheel arch flares
      boxAt(0.08, 0.12, 1.0, 0.99, 0.7, 1.33, trim),
      boxAt(0.08, 0.12, 1.0, -0.99, 0.7, -1.3, trim),
      boxAt(0.08, 0.12, 1.0, 0.99, 0.7, -1.3, trim)
    ];
    var body = new THREE.Mesh(merge(parts), bodyMat);
    var lights = new THREE.Mesh(merge([
      boxAt(0.46, 0.13, 0.05, -0.62, 0.6, 2.11, 0xfff4cf), boxAt(0.46, 0.13, 0.05, 0.62, 0.6, 2.11, 0xfff4cf),
      boxAt(0.5, 0.12, 0.05, -0.6, 0.62, -2.11, 0xff2b2b), boxAt(0.5, 0.12, 0.05, 0.6, 0.62, -2.11, 0xff2b2b)
    ]), lightMat);
    var g = new THREE.Group();
    var tilt = new THREE.Group();     // body roll / pitch / flip around the centre of mass, wheels stay level
    body.position.y = -PIVOT; lights.position.y = -PIVOT;
    tilt.position.y = PIVOT;
    tilt.add(body); tilt.add(lights);
    g.add(tilt);
    g.userData.tilt = tilt;
    return g;
  }

  function wheelGeometry() {
    var g = new THREE.CylinderGeometry(WHEEL_R, WHEEL_R, 0.3, 10, 1);
    g.rotateZ(Math.PI / 2);
    g = g.toNonIndexed();
    g.deleteAttribute('uv');
    g.computeVertexNormals();
    var n = g.attributes.normal, cnt = n.count, col = new Float32Array(cnt * 3);
    var tyre = new THREE.Color(0x1a1a1d), rim = new THREE.Color(0xb9bdc6), hub = new THREE.Color(0x6f7480);
    var p = g.attributes.position;
    for (var i = 0; i < cnt; i++) {
      var cap = Math.abs(n.getX(i)) > 0.9;
      var r = Math.sqrt(p.getY(i) * p.getY(i) + p.getZ(i) * p.getZ(i));
      var c = cap ? (r < 0.05 ? hub : rim) : tyre;
      col[i * 3] = c.r; col[i * 3 + 1] = c.g; col[i * 3 + 2] = c.b;
    }
    g.setAttribute('color', new THREE.BufferAttribute(col, 3));
    return g;
  }

  var WHEELS = [[-0.9, 1.33, 1], [0.9, 1.33, 1], [-0.9, -1.3, 0], [0.9, -1.3, 0]];   // x, z, steers

  /* ---------- the car ---------- */

  function C(opts) {
    this.color = opts.color;
    this.name = opts.name || '';
    this.ai = !!opts.ai;
    this.skill = opts.skill || 1;
    this.mesh = model(opts.color);
    this.x = 0; this.z = 0; this.heading = 0;
    this.vx = 0; this.vz = 0; this.s = 0; this.l = 0; this.omega = 0;
    this.steer = 0;
    this.input = 0;                 // button bits
    this.aiSteer = 0; this.aiGas = false; this.aiBrake = false;
    this.drift = 0; this.driftDir = 0; this.charge = 0; this.wasDrift = false;
    this.boost = 0; this.boostLevel = 0;
    this.offroad = false; this.slip = 0; this.hand = false;
    this.idx = 0; this.lat = 0; this.along = 0; this.raceDist = 0; this.lane = 0; this.laneT = 0;
    this.finished = false; this.finishTime = 0; this.place = 0;
    this.spin = 0; this.roll = 0; this.pitch = 0; this.accel = 0;
    this.impact = 0;                // last wall / car hit strength (for buzz, shake, sound)
    this.wrongWay = 0;
    this.nitro = 0;                 // seconds of nitro left (from a canister on the road)
    this.draft = 0;                 // 0..1 slipstream behind another car (set by the game every step)
    this.wreck = 0;                 // seconds without control after being hit
    this.immune = 0;                // a moment after a wreck in which it cannot be knocked again
    this.y = 0; this.vy = 0; this.flip = 0; this.flipRate = 0; this.air = false;
    this.loc = { i: 0, lat: 0, along: 0 };
  }

  C.prototype.reset = function (tr, dist, lat) {
    var o = Track.pointAt(tr, dist, lat, {});
    this.x = o.x; this.z = o.z; this.heading = o.heading;
    this.vx = this.vz = this.s = this.l = this.omega = this.steer = 0;
    this.drift = 0; this.charge = 0; this.boost = 0; this.boostLevel = 0; this.input = 0;
    this.nitro = 0; this.draft = 0; this.wreck = 0; this.immune = 0; this.y = 0; this.vy = 0; this.flip = 0; this.flipRate = 0; this.air = false;
    this.finished = false; this.finishTime = 0;
    Track.locate(tr, this.x, this.z, o.i, this.loc, true);
    this.idx = this.loc.i; this.along = this.loc.along; this.lat = this.loc.lat;
    this.raceDist = dist > tr.length / 2 ? dist - tr.length : dist;
    this.lane = lat;
    this.sync();
  };

  function kTurn(s) {
    var a = Math.abs(s);
    return 2.0 * Math.min(1, a / 7) * (1 - 0.5 * Math.min(1, a / MAX));
  }

  C.prototype.update = function (dt, tr, racing) {
    if (this.air) return this.fly(dt, tr);
    var wrecked = this.wreck > 0;
    if (wrecked) { this.wreck -= dt; if (this.wreck <= 0) this.immune = 1.2; }
    else if (this.immune > 0) this.immune -= dt;
    var b = racing && !wrecked ? this.input : 0;
    var left = b & BITS.left, right = b & BITS.right, gas = !!(b & BITS.gas), brake = !!(b & BITS.brake);
    var hand = !!(b & BITS.hand), driftBtn = !!(b & BITS.drift);
    var target = (right ? 1 : 0) - (left ? 1 : 0);
    if (this.ai && racing && !wrecked) { target = this.aiSteer; gas = this.aiGas; brake = this.aiBrake; hand = false; driftBtn = false; }

    // steering ramp: ~0.2 s to full lock, faster back to centre
    if (this.ai) this.steer += (target - this.steer) * Math.min(1, dt * 8);
    else {
      var rate = (target !== 0 && (this.steer === 0 || (target > 0) === (this.steer > 0))) ? 5 : 9;
      var d = target - this.steer, step = rate * dt;
      this.steer += Math.abs(d) < step ? d : (d > 0 ? step : -step);
    }

    var fx = Math.sin(this.heading), fz = Math.cos(this.heading), rx = fz, rz = -fx;
    var s = this.vx * fx + this.vz * fz, l = this.vx * rx + this.vz * rz;
    var sgn = s >= 0 ? 1 : -1;

    // drift state
    if (driftBtn && !this.drift && s > 13 && this.steer !== 0 && Math.abs(target) > 0) {
      this.drift = 1; this.driftDir = target > 0 ? 1 : -1; this.charge = 0;
    }
    var endDrift = this.drift && (!driftBtn || s < 9 || this.impact > 6);
    if (endDrift) {
      if (!driftBtn && s >= 9) {
        if (this.charge >= 2.4) { this.boost = 1.6; this.boostLevel = 2; }
        else if (this.charge >= 1.1) { this.boost = 0.9; this.boostLevel = 1; }
      }
      this.drift = 0; this.charge = 0;
    }
    if (driftBtn) gas = true;   // the drift button holds the throttle too

    // yaw
    var k = kTurn(s);
    var omega;
    if (this.drift) {
      omega = -this.driftDir * k * (1.1 + 0.55 * this.steer * this.driftDir);
      this.charge += dt * (0.7 + 0.6 * Math.min(1, Math.abs(l) / 8));
    } else {
      omega = -this.steer * k * sgn;
      if (hand) omega *= 1.6;
    }
    if (wrecked) { omega = this.omega * Math.exp(-dt * 1.1); this.steer = 0; }   // spinning out: nothing to steer with
    this.omega += (omega - this.omega) * Math.min(1, dt * 12);
    this.heading += this.omega * dt;

    // velocity in the new frame (the heading turned, the velocity did not yet)
    fx = Math.sin(this.heading); fz = Math.cos(this.heading); rx = fz; rz = -fx;
    s = this.vx * fx + this.vz * fz; l = this.vx * rx + this.vz * rz;

    var grip = wrecked ? 1.1 : (this.drift ? 2.4 : (hand ? 1.3 : 10));
    if (this.offroad) grip *= 0.8;
    var l2 = l * Math.exp(-grip * dt);
    s += Math.abs(l - l2) * (this.drift ? 0.45 : 0.1) * (s >= 0 ? 1 : -1);
    l = l2;

    // throttle / brake
    // slipstream: less air to push behind another car, so more pull and a higher top speed
    var extra = (this.nitro > 0 ? 15 : (this.boost > 0 ? 10 : 0)) + this.draft * 4;
    var maxS = MAX * this.skill * (this.offroad ? 0.55 : 1) + extra;
    var s0 = s;
    if (brake && s > 1) s -= BRAKE * dt;
    else if (brake) s = Math.max(-REV_MAX, s - REV_ACC * dt);
    else if (gas) {
      if (s < 0) s += BRAKE * dt;
      else if (s < maxS) s += ACC * (1 - (s / maxS) * (s / maxS)) * dt + (this.nitro > 0 ? 22 * dt : (this.boost > 0 ? 14 * dt : 0)) + this.draft * 4 * dt;
    } else {
      var coast = (2.5 + 0.0009 * s * s) * dt;
      s -= Math.abs(s) < coast ? s : (s > 0 ? coast : -coast);
    }
    if (s > maxS) s -= Math.min(s - maxS, (this.offroad ? 18 : 6) * dt);
    if (hand) { var hb = 7 * dt; s -= Math.abs(s) < hb ? s : (s > 0 ? hb : -hb); }
    this.accel = (s - s0) / Math.max(dt, 1e-4);
    if (this.boost > 0) { this.boost -= dt; if (this.boost <= 0) this.boostLevel = 0; }
    if (this.nitro > 0) this.nitro = Math.max(0, this.nitro - dt);
    if (wrecked) { var fr = 7 * dt; s -= Math.abs(s) < fr ? s : (s > 0 ? fr : -fr); }

    this.vx = fx * s + rx * l;
    this.vz = fz * s + rz * l;
    this.x += this.vx * dt;
    this.z += this.vz * dt;
    this.s = s; this.l = l; this.hand = hand;
    this.slip = Math.abs(l) / Math.max(6, Math.abs(s));

    this.impact = Math.max(0, this.impact - dt * 30);
    this.trackUpdate(tr);

    // visuals
    this.spin += s * dt / WHEEL_R;
    var rollT = Math.max(-0.09, Math.min(0.09, -this.omega * Math.abs(s) * 0.0028 + l * 0.004));
    var pitchT = Math.max(-0.05, Math.min(0.05, -this.accel * 0.0025));
    this.roll += (rollT - this.roll) * Math.min(1, dt * 6);
    this.pitch += (pitchT - this.pitch) * Math.min(1, dt * 6);
  };

  /* hit by another car: (nx, nz) is the push direction, power the closing speed in m/s */
  C.prototype.knock = function (nx, nz, power, flip) {
    if (this.wreck > 0 || this.air || this.immune > 0) return false;
    this.wreck = Math.min(2.6, 1.2 + power * 0.07);
    this.drift = 0; this.charge = 0; this.boost = 0; this.boostLevel = 0; this.nitro = 0;
    // shoved sideways (into the barrier, if it is close) and set spinning
    this.vx += nx * power * 0.35; this.vz += nz * power * 0.35;
    var side = nx * Math.cos(this.heading) - nz * Math.sin(this.heading);   // pushed toward its left or its right
    this.omega = (side >= 0 ? 1 : -1) * Math.min(9, 3.5 + power * 0.3);
    if (flip) {
      this.air = true;
      this.vy = Math.min(10, 6 + power * 0.18);
      var flight = 2 * this.vy / GRAV, turns = power > 20 ? 2 : 1;
      this.flipRate = (side >= 0 ? -1 : 1) * turns * Math.PI * 2 / flight;
      this.omega *= 0.5;
    }
    this.impact = Math.max(this.impact, power);
    return true;
  };

  /* airborne after a hard hit: ballistic, rolling over, lands on its wheels */
  C.prototype.fly = function (dt, tr) {
    this.vy -= GRAV * dt;
    this.y += this.vy * dt;
    this.flip += this.flipRate * dt;
    this.heading += this.omega * dt;
    this.x += this.vx * dt; this.z += this.vz * dt;
    this.spin += this.s * dt / WHEEL_R;
    if (this.y <= 0 && this.vy < 0) {
      this.y = 0; this.flip = 0; this.flipRate = 0; this.air = false;
      this.vx *= 0.55; this.vz *= 0.55;
      this.impact = Math.max(this.impact, 9);
      this.landed = true;           // the game plays the landing (sound, shake)
    }
    var fx = Math.sin(this.heading), fz = Math.cos(this.heading);
    this.s = this.vx * fx + this.vz * fz;
    this.trackUpdate(tr);
  };

  C.prototype.takeNitro = function () { this.nitro = NITRO_TIME; };

  C.prototype.trackUpdate = function (tr) {
    var loc = Track.locate(tr, this.x, this.z, this.idx, this.loc, false);
    var prevAlong = this.along;
    this.idx = loc.i; this.lat = loc.lat; this.along = loc.along;
    var d = this.along - prevAlong, L = tr.length;
    if (d < -L / 2) d += L; else if (d > L / 2) d -= L;
    this.raceDist += d;
    this.offroad = Math.abs(this.lat) > tr.hw + 1.7;

    // barriers
    var W = tr.wall - 0.45;
    if (Math.abs(this.lat) > W) {
      var sg = this.lat > 0 ? 1 : -1, nx = tr.nx[loc.i] * sg, nz = tr.nz[loc.i] * sg;
      var pen = Math.abs(this.lat) - W;
      this.x -= nx * pen; this.z -= nz * pen;
      var vn = this.vx * nx + this.vz * nz;
      if (vn > 0) {
        this.vx -= nx * vn * 1.3; this.vz -= nz * vn * 1.3;
        var scrub = 1 - Math.min(0.3, vn * 0.02);
        this.vx *= scrub; this.vz *= scrub;
        this.omega *= 0.5;
        this.impact = Math.max(this.impact, vn);
      }
      this.lat = sg * W;
    }
    // driving the wrong way
    var vt = this.vx * tr.tx[loc.i] + this.vz * tr.tz[loc.i];
    this.wrongWay = vt < -4 ? this.wrongWay + 1 : 0;
  };

  C.prototype.sync = function () {
    var m = this.mesh;
    m.position.set(this.x, this.y, this.z);
    m.rotation.y = this.heading;
    var t = m.userData.tilt;
    t.rotation.z = this.roll + this.flip;
    t.rotation.x = this.pitch;
    t.position.y = PIVOT + (this.drift ? Math.sin(this.charge * 40) * 0.01 : 0);
  };

  var tmpM = new THREE.Matrix4(), tmpQ = new THREE.Quaternion(), tmpE = new THREE.Euler(0, 0, 0, 'YXZ'), tmpP = new THREE.Vector3(), one = new THREE.Vector3(1, 1, 1);
  var bodyM = new THREE.Matrix4(), rollM = new THREE.Matrix4(), offM = new THREE.Matrix4();
  C.prototype.wheelMatrices = function (inst, base) {
    var c = Math.cos(this.heading), s = Math.sin(this.heading), w, wx, wz;
    if (this.air) {
      // car frame: position, heading, roll around the centre of mass
      bodyM.makeRotationY(this.heading).setPosition(this.x, this.y, this.z);
      offM.makeTranslation(0, PIVOT, 0); bodyM.multiply(offM);
      rollM.makeRotationZ(this.flip); bodyM.multiply(rollM);
      offM.makeTranslation(0, -PIVOT, 0); bodyM.multiply(offM);
      for (w = 0; w < 4; w++) {
        tmpP.set(WHEELS[w][0], WHEEL_R, WHEELS[w][1]);
        tmpE.set(this.spin, 0, 0);
        tmpQ.setFromEuler(tmpE);
        tmpM.compose(tmpP, tmpQ, one).premultiply(bodyM);
        inst.setMatrixAt(base + w, tmpM);
      }
      return;
    }
    for (w = 0; w < 4; w++) {
      wx = WHEELS[w][0]; wz = WHEELS[w][1];
      tmpP.set(this.x + wx * c + wz * s, WHEEL_R, this.z - wx * s + wz * c);
      // front wheels: steering; in a drift they point against the slide (counter-steer look)
      var steerA = WHEELS[w][2] ? (this.drift ? this.driftDir * 0.3 : (this.wreck > 0 ? 0 : -this.steer * 0.42)) : 0;
      tmpE.set(this.spin, this.heading + steerA, 0);
      tmpQ.setFromEuler(tmpE);
      tmpM.compose(tmpP, tmpQ, one);
      inst.setMatrixAt(base + w, tmpM);
    }
  };

  /* ---------- AI ---------- */

  var tmpPt = {};
  C.prototype.think = function (tr, cars, dt) {
    var s = this.s;
    // lane: drift slowly, step aside when someone is just ahead
    this.laneT -= dt;
    if (this.laneT <= 0) { this.laneT = 2 + Math.random() * 3; this.laneGoal = (Math.random() - 0.5) * (tr.hw * 0.9); }
    if (this.laneGoal === undefined) this.laneGoal = this.lane;
    for (var i = 0; i < cars.length; i++) {
      var o = cars[i];
      if (o === this) continue;
      var ahead = o.raceDist - this.raceDist;
      if (ahead > 0 && ahead < 14 && Math.abs(o.lat - this.lane) < 2.6) {
        this.laneGoal = o.lat > 0 ? o.lat - 3.4 : o.lat + 3.4;
        this.laneGoal = Math.max(-tr.hw + 1.5, Math.min(tr.hw - 1.5, this.laneGoal));
      }
    }
    this.lane += (this.laneGoal - this.lane) * Math.min(1, dt * 0.8);

    var look = 9 + Math.abs(s) * 0.45;
    Track.pointAt(tr, this.along + look, this.lane, tmpPt);
    var want = Math.atan2(tmpPt.x - this.x, tmpPt.z - this.z);
    var err = want - this.heading;
    while (err > Math.PI) err -= Math.PI * 2;
    while (err < -Math.PI) err += Math.PI * 2;
    this.aiSteer = Math.max(-1, Math.min(1, -err * 2.6));

    // speed for the sharpest bend in the braking distance ahead
    var n = tr.n, from = this.idx, span = Math.ceil((Math.abs(s) * 1.4 + 20) / tr.seg), bend = 0;
    for (var k = 2; k < span; k++) bend = Math.max(bend, tr.bend[(from + k) % n] * (1 - k / (span * 2.2)));
    var vt = bend > 1e-4 ? Math.sqrt(30 * this.skill / bend) : MAX;
    vt *= this.rubber || 1;
    this.aiGas = s < vt - 0.5;
    this.aiBrake = s > vt + 4;
  };

  return { create: function (o) { return new C(o); }, wheelGeometry: wheelGeometry, BITS: BITS, MAX: MAX, NITRO_TIME: NITRO_TIME };
})();
