/*
 * Track: a closed spline sampled every ~3 m. Gives the road mesh (flat-coloured quads, lighting
 * baked into vertex colours: no lights or textures to compute on the TV) and fast queries
 * "where on the track is this car" by searching around the car's previous sample.
 */
var Track = (function () {
  'use strict';

  var DEFS = {
    // mountain circuit (Kazbegi-like scenery); metres, x right, z forward; the start straight runs along +x
    mountain: {
      hw: 7.5,           // half the road width
      runoff: 9,         // grass beyond the curb, then the barrier
      laps: 3,
      pts: [[-200, 0], [-40, 0], [120, 0], [230, 25], [300, 100], [285, 190], [215, 235], [140, 215], [95, 160],
        [30, 150], [-10, 215], [-75, 290], [-170, 300], [-245, 250], [-265, 180], [-232, 128], [-250, 80], [-300, 50], [-310, 15], [-290, -5]]
    }
  };

  function build(name) {
    var def = DEFS[name];
    var v3 = def.pts.map(function (p) { return new THREE.Vector3(p[0], 0, p[1]); });
    var curve = new THREE.CatmullRomCurve3(v3, true, 'centripetal');
    var len = curve.getLength();
    var n = Math.round(len / 3);
    var pts = curve.getSpacedPoints(n);   // n+1 points, last == first
    var tr = {
      name: name, hw: def.hw, wall: def.hw + def.runoff, laps: def.laps, n: n, length: len, seg: len / n,
      px: new Float32Array(n), pz: new Float32Array(n), tx: new Float32Array(n), tz: new Float32Array(n),
      nx: new Float32Array(n), nz: new Float32Array(n), curv: new Float32Array(n), dist: new Float32Array(n)
    };
    var i;
    for (i = 0; i < n; i++) { tr.px[i] = pts[i].x; tr.pz[i] = pts[i].z; tr.dist[i] = i * tr.seg; }
    for (i = 0; i < n; i++) {
      var a = (i + 1) % n, b = (i - 1 + n) % n;
      var dx = tr.px[a] - tr.px[b], dz = tr.pz[a] - tr.pz[b], l = Math.sqrt(dx * dx + dz * dz) || 1;
      tr.tx[i] = dx / l; tr.tz[i] = dz / l;
      tr.nx[i] = tr.tz[i]; tr.nz[i] = -tr.tx[i];     // left of the driving direction
    }
    var minR = 1e9;
    for (i = 0; i < n; i++) {
      var j = (i + 1) % n;
      var cross = tr.tx[i] * tr.tz[j] - tr.tz[i] * tr.tx[j];
      var dot = tr.tx[i] * tr.tx[j] + tr.tz[i] * tr.tz[j];
      tr.curv[i] = Math.atan2(cross, dot) / tr.seg;  // signed, 1/m
      if (Math.abs(tr.curv[i]) > 1e-6) minR = Math.min(minR, 1 / Math.abs(tr.curv[i]));
    }
    // smoothed |curvature| for the AI's speed choice and for where curbs go
    tr.bend = new Float32Array(n);
    for (i = 0; i < n; i++) {
      var s = 0;
      for (var k = -3; k <= 3; k++) s += Math.abs(tr.curv[(i + k + n) % n]);
      tr.bend[i] = s / 7;
    }
    tr.minRadius = minR;
    return tr;
  }

  /* nearest sample around `hint`; returns into `out`: i, lat (left +), along (m from the start line) */
  function locate(tr, x, z, hint, out, wide) {
    var n = tr.n, best = 1e18, bi = hint, from = wide ? 0 : hint - 14, to = wide ? n - 1 : hint + 14;
    for (var k = from; k <= to; k++) {
      var i = ((k % n) + n) % n;
      var dx = x - tr.px[i], dz = z - tr.pz[i], d = dx * dx + dz * dz;
      if (d < best) { best = d; bi = i; }
    }
    var dx2 = x - tr.px[bi], dz2 = z - tr.pz[bi];
    var t = dx2 * tr.tx[bi] + dz2 * tr.tz[bi];
    out.i = bi;
    out.lat = dx2 * tr.nx[bi] + dz2 * tr.nz[bi];
    out.along = tr.dist[bi] + t;
    return out;
  }

  /* point at distance d along the centre line plus lateral offset; heading of the road there */
  function pointAt(tr, d, lat, out) {
    var L = tr.length;
    d = ((d % L) + L) % L;
    var f = d / tr.seg, i = Math.floor(f) % tr.n, j = (i + 1) % tr.n, u = f - Math.floor(f);
    out.x = tr.px[i] + (tr.px[j] - tr.px[i]) * u + tr.nx[i] * lat;
    out.z = tr.pz[i] + (tr.pz[j] - tr.pz[i]) * u + tr.nz[i] * lat;
    out.heading = Math.atan2(tr.tx[i], tr.tz[i]);
    out.i = i;
    return out;
  }

  /* ---------- mesh ---------- */

  function Builder() { this.pos = []; this.col = []; }
  Builder.prototype.quad = function (a, b, c, d, color) {
    // a b c d: [x,y,z], counter-clockwise seen from where it should face
    this.pos.push(a[0], a[1], a[2], b[0], b[1], b[2], c[0], c[1], c[2], a[0], a[1], a[2], c[0], c[1], c[2], d[0], d[1], d[2]);
    for (var k = 0; k < 6; k++) this.col.push(color.r, color.g, color.b);
  };
  Builder.prototype.geometry = function () {
    var g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.pos, 3));
    g.setAttribute('color', new THREE.Float32BufferAttribute(this.col, 3));
    return g;
  };

  function shade(hex, f, jitter) {
    var c = new THREE.Color(hex);
    var k = f * (1 + (jitter ? (Math.random() - 0.5) * jitter : 0));
    c.r *= k; c.g *= k; c.b *= k;
    return c;
  }

  function roadMesh(tr) {
    var B = new Builder(), n = tr.n, hw = tr.hw;
    var y = 0.03;
    // lateral offsets (left +) of the columns, outside in, mirrored
    var cols = [
      { a: tr.wall + 0.6, b: hw + 1.6, kind: 'grass' },
      { a: hw + 1.6, b: hw, kind: 'curb' },
      { a: hw, b: hw - 0.55, kind: 'road' },
      { a: hw - 0.55, b: hw - 0.9, kind: 'line' },
      { a: hw - 0.9, b: 0.18, kind: 'road' },
      { a: 0.18, b: -0.18, kind: 'center' }
    ];
    var all = cols.slice();
    for (var c = cols.length - 2; c >= 0; c--) all.push({ a: -cols[c].b, b: -cols[c].a, kind: cols[c].kind });
    var asphalt = [], grass = [], i;
    for (i = 0; i < n; i++) { asphalt.push(shade(0x3b3f47, 1, 0.07)); grass.push(shade(0x6f9a45, 1, 0.08)); }
    var red = new THREE.Color(0xd8312b), white = new THREE.Color(0xf2f2ee), line = new THREE.Color(0xe9e9e2), gray = new THREE.Color(0x9a9a94);
    for (i = 0; i < n; i++) {
      var j = (i + 1) % n;
      var curby = tr.bend[i] > 1 / 140;
      for (var k = 0; k < all.length; k++) {
        var col = all[k], color;
        if (col.kind === 'road') color = asphalt[i];
        else if (col.kind === 'grass') color = grass[i];
        else if (col.kind === 'line') color = line;
        else if (col.kind === 'center') color = (i % 6 < 3) ? line : asphalt[i];
        else color = curby ? ((i >> 1) % 2 ? red : white) : gray;
        // start / finish: checkered band over the road at samples 0..1
        if (i < 2 && (col.kind === 'road' || col.kind === 'line' || col.kind === 'center')) {
          checker(B, tr, i, col.a, col.b, y + 0.005);
          continue;
        }
        var ya = col.kind === 'grass' ? 0.015 : y;
        B.quad(
          [tr.px[i] + tr.nx[i] * col.b, ya, tr.pz[i] + tr.nz[i] * col.b],
          [tr.px[i] + tr.nx[i] * col.a, ya, tr.pz[i] + tr.nz[i] * col.a],
          [tr.px[j] + tr.nx[j] * col.a, ya, tr.pz[j] + tr.nz[j] * col.a],
          [tr.px[j] + tr.nx[j] * col.b, ya, tr.pz[j] + tr.nz[j] * col.b], color);
      }
    }
    barriers(B, tr);
    return B.geometry();
  }

  function checker(B, tr, i, a, b, y) {
    var j = (i + 1) % tr.n, cells = Math.max(1, Math.round(Math.abs(a - b) / 0.9));
    var black = new THREE.Color(0x15161a), white = new THREE.Color(0xf4f4f0);
    for (var r = 0; r < 2; r++) {
      for (var c = 0; c < cells; c++) {
        var la = a + (b - a) * c / cells, lb = a + (b - a) * (c + 1) / cells;
        var u0 = r / 2, u1 = (r + 1) / 2;
        var x0 = tr.px[i] + (tr.px[j] - tr.px[i]) * u0, z0 = tr.pz[i] + (tr.pz[j] - tr.pz[i]) * u0;
        var x1 = tr.px[i] + (tr.px[j] - tr.px[i]) * u1, z1 = tr.pz[i] + (tr.pz[j] - tr.pz[i]) * u1;
        var odd = (Math.round((la + 100) / 0.9) + r + i * 2) % 2;
        B.quad([x0 + tr.nx[i] * lb, y, z0 + tr.nz[i] * lb], [x0 + tr.nx[i] * la, y, z0 + tr.nz[i] * la],
          [x1 + tr.nx[i] * la, y, z1 + tr.nz[i] * la], [x1 + tr.nx[i] * lb, y, z1 + tr.nz[i] * lb], odd ? black : white);
      }
    }
  }

  /* low tyre-wall style barriers: red / white blocks, lit side brighter than the top */
  function barriers(B, tr) {
    var n = tr.n, h = 1.0, off = tr.wall + 0.6, th = 0.7;
    var red = new THREE.Color(0xc9302c), white = new THREE.Color(0xe8e8e2);
    for (var side = -1; side <= 1; side += 2) {
      for (var i = 0; i < n; i++) {
        var j = (i + 1) % n;
        var base = ((i >> 1) % 2) ? red : white;
        var face = base.clone().multiplyScalar(0.82), top = base.clone().multiplyScalar(1.0), back = base.clone().multiplyScalar(0.6);
        var o1 = side * off, o2 = side * (off + th);
        var ax = tr.px[i] + tr.nx[i] * o1, az = tr.pz[i] + tr.nz[i] * o1, bx = tr.px[j] + tr.nx[j] * o1, bz = tr.pz[j] + tr.nz[j] * o1;
        var cx = tr.px[i] + tr.nx[i] * o2, cz = tr.pz[i] + tr.nz[i] * o2, dx = tr.px[j] + tr.nx[j] * o2, dz = tr.pz[j] + tr.nz[j] * o2;
        B.quad([ax, 0, az], [bx, 0, bz], [bx, h, bz], [ax, h, az], face);        // the face toward the road
        B.quad([ax, h, az], [bx, h, bz], [dx, h, dz], [cx, h, cz], top);
        B.quad([cx, 0, cz], [dx, 0, dz], [dx, h, dz], [cx, h, cz], back);
      }
    }
  }

  return { build: build, locate: locate, pointAt: pointAt, roadMesh: roadMesh, Builder: Builder, shade: shade };
})();
