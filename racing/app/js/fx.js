/*
 * Effects: tyre smoke and drift sparks (one Points draw call for all cars), skid marks (one ring-buffer
 * mesh), blob shadows under the cars (one instanced quad). All cheap enough for the TV GPU.
 */
var Fx = (function () {
  'use strict';

  var MAXP = 360;
  var MAXQ = 1400;

  function radialTexture(inner, outer) {
    var cv = document.createElement('canvas'); cv.width = cv.height = 64;
    var x = cv.getContext('2d'), g = x.createRadialGradient(32, 32, 2, 32, 32, 32);
    g.addColorStop(0, inner); g.addColorStop(0.55, outer); g.addColorStop(1, 'rgba(0,0,0,0)');
    x.fillStyle = g; x.fillRect(0, 0, 64, 64);
    return new THREE.CanvasTexture(cv);
  }

  function Fx(scene, carCount) {
    // ---- particles ----
    this.p = [];
    for (var i = 0; i < MAXP; i++) this.p.push({ life: 0, max: 1, x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0, s0: 1, s1: 1, r: 1, g: 1, b: 1, a: 0.5 });
    this.next = 0;
    var g = new THREE.BufferGeometry();
    this.ppos = new Float32Array(MAXP * 3);
    this.psize = new Float32Array(MAXP);
    this.pcol = new Float32Array(MAXP * 4);
    g.setAttribute('position', new THREE.BufferAttribute(this.ppos, 3));
    g.setAttribute('size', new THREE.BufferAttribute(this.psize, 1));
    g.setAttribute('pcolor', new THREE.BufferAttribute(this.pcol, 4));
    g.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e5);
    this.pmat = new THREE.ShaderMaterial({
      uniforms: { scale: { value: 500 }, map: { value: radialTexture('rgba(255,255,255,1)', 'rgba(255,255,255,0.45)') } },
      vertexShader: [
        'attribute float size; attribute vec4 pcolor; varying vec4 vC; uniform float scale;',
        'void main(){ vC = pcolor; vec4 mv = modelViewMatrix * vec4(position,1.0);',
        ' gl_PointSize = size * scale / max(0.5, -mv.z); gl_Position = projectionMatrix * mv; }'
      ].join('\n'),
      fragmentShader: [
        'uniform sampler2D map; varying vec4 vC;',
        'void main(){ vec4 t = texture2D(map, gl_PointCoord); gl_FragColor = vec4(vC.rgb, vC.a * t.a); if (gl_FragColor.a < 0.01) discard; }'
      ].join('\n'),
      transparent: true, depthWrite: false
    });
    this.points = new THREE.Points(g, this.pmat);
    this.points.frustumCulled = false;
    this.points.renderOrder = 5;
    scene.add(this.points);

    // ---- skid marks ----
    this.qpos = new Float32Array(MAXQ * 6 * 3);
    this.qn = 0;
    var sg = new THREE.BufferGeometry();
    this.qattr = new THREE.BufferAttribute(this.qpos, 3);
    this.qattr.setUsage(THREE.DynamicDrawUsage);
    sg.setAttribute('position', this.qattr);
    sg.setDrawRange(0, 0);
    this.skid = new THREE.Mesh(sg, new THREE.MeshBasicMaterial({ color: 0x15161a, transparent: true, opacity: 0.42, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 }));
    this.skid.frustumCulled = false;
    this.skid.renderOrder = 1;
    scene.add(this.skid);
    this.last = {};    // car index*2 + wheel -> [x, z] or null

    // ---- blob shadows ----
    var pg = new THREE.PlaneGeometry(1, 1); pg.rotateX(-Math.PI / 2);
    this.shadows = new THREE.InstancedMesh(pg, new THREE.MeshBasicMaterial({
      map: radialTexture('rgba(0,0,0,0.62)', 'rgba(0,0,0,0.4)'), transparent: true, depthWrite: false,
      polygonOffset: true, polygonOffsetFactor: -3, polygonOffsetUnits: -3 }), carCount);
    this.shadows.renderOrder = 2;
    this.shadows.frustumCulled = false;
    scene.add(this.shadows);
    this.m4 = new THREE.Matrix4(); this.q = new THREE.Quaternion(); this.v = new THREE.Vector3(); this.sc = new THREE.Vector3(); this.up = new THREE.Vector3(0, 1, 0);
  }

  Fx.prototype.emit = function (x, y, z, vx, vy, vz, life, s0, s1, r, g, b, a) {
    var p = this.p[this.next];
    this.next = (this.next + 1) % MAXP;
    p.x = x; p.y = y; p.z = z; p.vx = vx; p.vy = vy; p.vz = vz; p.life = life; p.max = life; p.s0 = s0; p.s1 = s1; p.r = r; p.g = g; p.b = b; p.a = a;
  };

  Fx.prototype.skidSeg = function (key, x, z, on) {
    var last = this.last[key];
    if (!on) { this.last[key] = null; return; }
    if (!last) { this.last[key] = [x, z]; return; }
    var dx = x - last[0], dz = z - last[1], d = Math.sqrt(dx * dx + dz * dz);
    if (d < 0.6) return;
    var w = 0.16, nx = -dz / d * w, nz = dx / d * w, y = 0.05;
    var o = (this.qn % MAXQ) * 18, a = this.qpos;
    var ax = last[0] + nx, az = last[1] + nz, bx = last[0] - nx, bz = last[1] - nz, cx = x - nx, cz = z - nz, ex = x + nx, ez = z + nz;
    a[o] = ax; a[o + 1] = y; a[o + 2] = az; a[o + 3] = bx; a[o + 4] = y; a[o + 5] = bz; a[o + 6] = cx; a[o + 7] = y; a[o + 8] = cz;
    a[o + 9] = ax; a[o + 10] = y; a[o + 11] = az; a[o + 12] = cx; a[o + 13] = y; a[o + 14] = cz; a[o + 15] = ex; a[o + 16] = y; a[o + 17] = ez;
    this.qn++;
    this.dirty = true;
    this.last[key] = [x, z];
  };

  Fx.prototype.update = function (dt, cars, playing) {
    var i;
    for (i = 0; i < cars.length; i++) {
      var c = cars[i];
      var fx = Math.sin(c.heading), fz = Math.cos(c.heading), rx = fz, rz = -fx;
      var spd = Math.abs(c.s);
      var sliding = playing && !c.air && spd > 6 && (c.drift || c.hand || c.slip > 0.22 || c.wreck > 0);
      for (var w = 0; w < 2; w++) {
        var side = w ? 0.9 : -0.9;
        var wx = c.x + rx * side - fx * 1.3, wz = c.z + rz * side - fz * 1.3;
        this.skidSeg(i * 2 + w, wx, wz, sliding);
        if (sliding && Math.random() < 0.55) {
          var k = 0.8 + Math.random() * 0.25;
          this.emit(wx, 0.35, wz, c.vx * 0.25 + (Math.random() - 0.5) * 2, 0.8 + Math.random(), c.vz * 0.25 + (Math.random() - 0.5) * 2,
            0.9 + Math.random() * 0.5, 0.9, 3.4, k, k, k * 1.02, 0.32);
        }
        // drift charge sparks: blue, then orange
        if (c.drift && c.charge >= 1.1 && Math.random() < 0.7) {
          var orange = c.charge >= 2.4;
          this.emit(wx, 0.25, wz, (Math.random() - 0.5) * 5 - fx * 3, 1.5 + Math.random() * 2, (Math.random() - 0.5) * 5 - fz * 3,
            0.25 + Math.random() * 0.15, 0.35, 0.12, orange ? 1 : 0.35, orange ? 0.6 : 0.75, orange ? 0.15 : 1, 1);
        }
      }
      // boost: orange exhaust flames; nitro: bigger blue-white ones
      if (c.nitro > 0) {
        for (var e2 = 0; e2 < 2; e2++) {
          this.emit(c.x - fx * 2.25 + rx * (e2 ? 0.45 : -0.45), 0.42, c.z - fz * 2.25 + rz * (e2 ? 0.45 : -0.45),
            c.vx * 0.6 - fx * 8, Math.random() * 0.6, c.vz * 0.6 - fz * 8, 0.22, 1.1, 0.25, 0.45, 0.85, 1, 0.95);
        }
      } else if (c.boost > 0) {
        for (var e = 0; e < 2; e++) {
          var lvl2 = c.boostLevel === 2;
          this.emit(c.x - fx * 2.25 + rx * (e ? 0.45 : -0.45), 0.42, c.z - fz * 2.25 + rz * (e ? 0.45 : -0.45),
            c.vx * 0.7 - fx * 6, Math.random(), c.vz * 0.7 - fz * 6, 0.16, 0.7, 0.2, 1, lvl2 ? 0.55 : 0.8, lvl2 ? 0.15 : 0.35, 0.95);
        }
      }
      // slipstream: thin wind streaks rushing past both sides of the car
      if (c.draft > 0.35 && Math.random() < c.draft * 0.9) {
        var sd = Math.random() < 0.5 ? -1 : 1, ah = 1 + Math.random() * 2.5;
        this.emit(c.x + rx * sd * (1.25 + Math.random() * 0.4) + fx * ah, 0.5 + Math.random() * 0.7, c.z + rz * sd * (1.25 + Math.random() * 0.4) + fz * ah,
          c.vx * 0.35, 0, c.vz * 0.35, 0.3, 0.16, 0.06, 0.92, 1, 0.95, 0.7);
      }
      // a car landing after a flip throws up dust
      if (c.dust) {
        c.dust = false;
        for (var dd = 0; dd < 14; dd++) {
          this.emit(c.x + (Math.random() - 0.5) * 3, 0.4, c.z + (Math.random() - 0.5) * 4, (Math.random() - 0.5) * 6, 1 + Math.random() * 2,
            (Math.random() - 0.5) * 6, 1 + Math.random() * 0.6, 1.4, 4.5, 0.85, 0.82, 0.76, 0.4);
        }
      }
      // shadow
      this.q.setFromAxisAngle(this.up, c.heading);
      this.v.set(c.x, 0.06, c.z);
      var sh = 1 / (1 + c.y * 0.25);
      this.sc.set(2.7 * sh, 1, 5.0 * sh);
      this.m4.compose(this.v, this.q, this.sc);
      this.shadows.setMatrixAt(i, this.m4);
    }
    this.shadows.instanceMatrix.needsUpdate = true;

    // particles
    var pp = this.ppos, ps = this.psize, pc = this.pcol;
    for (i = 0; i < MAXP; i++) {
      var p = this.p[i];
      if (p.life <= 0) { ps[i] = 0; pc[i * 4 + 3] = 0; continue; }
      p.life -= dt;
      var t = 1 - p.life / p.max;
      p.x += p.vx * dt; p.y += p.vy * dt; p.z += p.vz * dt;
      p.vx *= 1 - dt * 1.5; p.vz *= 1 - dt * 1.5; p.vy -= (p.a > 0.9 ? 6 : -0.3) * dt;
      pp[i * 3] = p.x; pp[i * 3 + 1] = p.y; pp[i * 3 + 2] = p.z;
      ps[i] = p.s0 + (p.s1 - p.s0) * t;
      pc[i * 4] = p.r; pc[i * 4 + 1] = p.g; pc[i * 4 + 2] = p.b; pc[i * 4 + 3] = p.a * (1 - t);
    }
    var ga = this.points.geometry.attributes;
    ga.position.needsUpdate = true; ga.size.needsUpdate = true; ga.pcolor.needsUpdate = true;

    if (this.dirty) {
      this.dirty = false;
      this.qattr.needsUpdate = true;
      this.skid.geometry.setDrawRange(0, Math.min(this.qn, MAXQ) * 6);
    }
  };

  Fx.prototype.clear = function () {
    this.qn = 0; this.last = {};
    this.skid.geometry.setDrawRange(0, 0);
    for (var i = 0; i < MAXP; i++) this.p[i].life = 0;
  };

  Fx.prototype.setViewHeight = function (h) { this.pmat.uniforms.scale.value = h * 0.9; };

  return { create: function (scene, n) { return new Fx(scene, n); } };
})();
