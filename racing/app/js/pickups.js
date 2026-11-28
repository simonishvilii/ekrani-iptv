/*
 * Nitro canisters on the straights: one at a time, in the left, middle or right lane (it moves to
 * another lane each time it comes back), so taking it means aiming for it. Driving through one gives
 * Car.NITRO_TIME seconds of extra power and top speed. A taken canister comes back after a while.
 * All canisters are one instanced mesh, their glow on the road another: two draw calls.
 */
var Pickups = (function () {
  'use strict';

  var RESPAWN = 8;          // seconds
  var LANES = [-4.6, 0, 4.6];
  var REACH2 = 2.1 * 2.1;   // pick-up distance (squared) from the car's front or rear point

  function bottleGeometry() {
    var parts = [], c;
    function cyl(r0, r1, h, y, color, seg) {
      var g = new THREE.CylinderGeometry(r0, r1, h, seg || 10, 1);
      g.translate(0, y, 0);
      g = g.toNonIndexed(); g.deleteAttribute('uv');
      c = new THREE.Color(color);
      var n = g.attributes.position.count, a = new Float32Array(n * 3);
      for (var i = 0; i < n; i++) { a[i * 3] = c.r; a[i * 3 + 1] = c.g; a[i * 3 + 2] = c.b; }
      g.setAttribute('color', new THREE.BufferAttribute(a, 3));
      g.computeVertexNormals();
      parts.push(g);
    }
    cyl(0.34, 0.34, 0.55, -0.12, 0x1f6bff);          // body
    cyl(0.345, 0.345, 0.16, 0.22, 0xf2f5fa);         // white band
    cyl(0.34, 0.34, 0.12, 0.36, 0x1f6bff);
    cyl(0.22, 0.34, 0.14, 0.49, 0xc8cdd6);           // shoulder
    cyl(0.09, 0.09, 0.16, 0.64, 0x9aa1ad, 8);        // valve
    cyl(0.16, 0.16, 0.05, 0.74, 0xff3b3b, 8);        // red knob
    var total = 0, i;
    for (i = 0; i < parts.length; i++) total += parts[i].attributes.position.count;
    var pos = new Float32Array(total * 3), col = new Float32Array(total * 3), nor = new Float32Array(total * 3), o = 0;
    for (i = 0; i < parts.length; i++) {
      pos.set(parts[i].attributes.position.array, o * 3);
      col.set(parts[i].attributes.color.array, o * 3);
      nor.set(parts[i].attributes.normal.array, o * 3);
      o += parts[i].attributes.position.count;
    }
    var m = new THREE.BufferGeometry();
    m.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    m.setAttribute('color', new THREE.BufferAttribute(col, 3));
    m.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
    return m;
  }

  function glowTexture() {
    var cv = document.createElement('canvas'); cv.width = cv.height = 64;
    var x = cv.getContext('2d'), g = x.createRadialGradient(32, 32, 4, 32, 32, 32);
    g.addColorStop(0, 'rgba(120,220,255,0.9)'); g.addColorStop(0.5, 'rgba(60,150,255,0.45)'); g.addColorStop(1, 'rgba(40,100,255,0)');
    x.fillStyle = g; x.fillRect(0, 0, 64, 64);
    return new THREE.CanvasTexture(cv);
  }

  /* straight-ish road for a row: little bend 35 m either side, away from the start line, spread out */
  function spots(tr) {
    var out = [], n = tr.n, look = Math.ceil(35 / tr.seg), gapMin = tr.length / 3.6;
    for (var i = 0; i < n; i++) {
      var d = tr.dist[i];
      if (d < 120 || d > tr.length - 60) continue;
      var bend = 0;
      for (var k = -look; k <= look; k++) bend = Math.max(bend, tr.bend[(i + k + n) % n]);
      if (bend > 1 / 70) continue;
      if (out.length && d - out[out.length - 1] < gapMin) continue;
      out.push(d);
    }
    return out;
  }

  function P(scene, tr) {
    this.items = [];
    var self = this;
    this.tr = tr;
    spots(tr).forEach(function (d, k) {
      var it = { x: 0, z: 0, dist: d, lane: k % 3, away: 0, phase: Math.random() * 6 };
      self.place(it, it.lane);
      self.items.push(it);
    });
    var n = this.items.length;
    this.mesh = new THREE.InstancedMesh(bottleGeometry(), new THREE.MeshLambertMaterial({ vertexColors: true, emissive: 0x0b2a66 }), n);
    this.mesh.frustumCulled = false;
    scene.add(this.mesh);
    var pg = new THREE.PlaneGeometry(1, 1); pg.rotateX(-Math.PI / 2);
    this.glow = new THREE.InstancedMesh(pg, new THREE.MeshBasicMaterial({ map: glowTexture(), transparent: true, depthWrite: false,
      blending: THREE.AdditiveBlending, polygonOffset: true, polygonOffsetFactor: -4, polygonOffsetUnits: -4 }), n);
    this.glow.frustumCulled = false;
    this.glow.renderOrder = 3;
    scene.add(this.glow);
    this.t = 0;
    this.m4 = new THREE.Matrix4(); this.q = new THREE.Quaternion(); this.v = new THREE.Vector3(); this.sc = new THREE.Vector3(); this.up = new THREE.Vector3(0, 1, 0);
    this.update(0, []);
  }

  /* onTake(car, item) is called for every canister taken */
  P.prototype.update = function (dt, cars, onTake) {
    this.t += dt;
    var i, j, it, c;
    for (i = 0; i < this.items.length; i++) {
      it = this.items[i];
      if (it.away > 0) it.away -= dt;
      else if (onTake) {
        for (j = 0; j < cars.length; j++) {
          c = cars[j];
          if (c.air) continue;
          var fx = Math.sin(c.heading) * 1.2, fz = Math.cos(c.heading) * 1.2;
          var ax = c.x + fx - it.x, az = c.z + fz - it.z, bx = c.x - fx - it.x, bz = c.z - fz - it.z;
          if (ax * ax + az * az < REACH2 || bx * bx + bz * bz < REACH2) {
            it.away = RESPAWN; onTake(c, it);
            this.place(it, (it.lane + 1 + Math.floor(Math.random() * 2)) % 3);   // comes back in another lane
            break;
          }
        }
      }
      // shown: spins and bobs; coming back: grows in during the last half second
      var s = it.away > 0 ? Math.max(0, Math.min(1, (0.5 - it.away) / 0.5)) : 1;
      if (it.away > 0.5) s = 0;
      this.q.setFromAxisAngle(this.up, this.t * 2.2 + it.phase);
      this.v.set(it.x, 0.95 + Math.sin(this.t * 3 + it.phase) * 0.15, it.z);
      this.sc.set(s * 1.25, s * 1.25, s * 1.25);
      this.m4.compose(this.v, this.q, this.sc);
      this.mesh.setMatrixAt(i, this.m4);
      this.q.set(0, 0, 0, 1);
      this.v.set(it.x, 0.07, it.z);
      var g = s * (2.6 + Math.sin(this.t * 5 + it.phase) * 0.25);
      this.sc.set(g, 1, g);
      this.m4.compose(this.v, this.q, this.sc);
      this.glow.setMatrixAt(i, this.m4);
    }
    this.mesh.instanceMatrix.needsUpdate = true;
    this.glow.instanceMatrix.needsUpdate = true;
  };

  P.prototype.place = function (it, lane) {
    var o = Track.pointAt(this.tr, it.dist, LANES[lane], {});
    it.lane = lane; it.lat = LANES[lane]; it.x = o.x; it.z = o.z;
  };

  P.prototype.reset = function () {
    for (var i = 0; i < this.items.length; i++) { this.items[i].away = 0; this.place(this.items[i], i % 3); }
  };

  return { create: function (scene, tr) { return new P(scene, tr); } };
})();
