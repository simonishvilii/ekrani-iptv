/*
 * Scenery around the track: sky dome, faceted ground, snowy mountains, pine trees, start gantry,
 * grandstand and a small hill-top church. Everything is lit once here (colours baked per face)
 * and drawn with MeshBasicMaterial: on the TV this is the cheapest way to get a lit look.
 */
var World = (function () {
  'use strict';

  var SUN = new THREE.Vector3(-0.45, 0.75, -0.5).normalize();
  var HAZE = new THREE.Color(0xc9d8e6);

  /* colour of a face with normal n: sun + sky light, a little warm */
  function lit(base, n, amb, sun) {
    var d = Math.max(0, n.dot(SUN));
    var k = (amb === undefined ? 0.58 : amb) + (sun === undefined ? 0.55 : sun) * d;
    var c = base.clone().multiplyScalar(k);
    c.r = Math.min(1, c.r * 1.03); c.b = Math.min(1, c.b * 0.98);
    return c;
  }

  /* non-indexed geometry -> per-face baked colour from a colour function(faceIndex, centre, normal) */
  function bake(geo, colorFn) {
    geo = geo.index ? geo.toNonIndexed() : geo;
    var p = geo.attributes.position, cnt = p.count, cols = new Float32Array(cnt * 3);
    var a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3(), n = new THREE.Vector3(), m = new THREE.Vector3();
    for (var f = 0; f < cnt; f += 3) {
      a.fromBufferAttribute(p, f); b.fromBufferAttribute(p, f + 1); c.fromBufferAttribute(p, f + 2);
      n.subVectors(c, b).cross(m.subVectors(a, b)).normalize();
      m.copy(a).add(b).add(c).multiplyScalar(1 / 3);
      var col = colorFn(f / 3, m, n);
      for (var k = 0; k < 3; k++) { cols[(f + k) * 3] = col.r; cols[(f + k) * 3 + 1] = col.g; cols[(f + k) * 3 + 2] = col.b; }
    }
    geo.setAttribute('color', new THREE.BufferAttribute(cols, 3));
    geo.deleteAttribute('normal');
    geo.deleteAttribute('uv');
    return geo;
  }

  function mergeGeos(list) {
    var total = 0, i;
    for (i = 0; i < list.length; i++) total += list[i].attributes.position.count;
    var pos = new Float32Array(total * 3), col = new Float32Array(total * 3), o = 0;
    for (i = 0; i < list.length; i++) {
      pos.set(list[i].attributes.position.array, o * 3);
      col.set(list[i].attributes.color.array, o * 3);
      o += list[i].attributes.position.count;
    }
    var g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    g.setAttribute('color', new THREE.BufferAttribute(col, 3));
    return g;
  }

  function sky() {
    var g = new THREE.SphereGeometry(1, 24, 12);
    var p = g.attributes.position, cols = new Float32Array(p.count * 3);
    var top = new THREE.Color(0x3f78c9), mid = new THREE.Color(0x8fb8e3), hor = new THREE.Color(0xe6e2d6), c = new THREE.Color();
    for (var i = 0; i < p.count; i++) {
      var y = p.getY(i);
      if (y < 0) c.copy(hor);
      else if (y < 0.25) c.copy(hor).lerp(mid, y / 0.25);
      else c.copy(mid).lerp(top, Math.min(1, (y - 0.25) / 0.6));
      cols[i * 3] = c.r; cols[i * 3 + 1] = c.g; cols[i * 3 + 2] = c.b;
    }
    g.setAttribute('color', new THREE.BufferAttribute(cols, 3));
    var m = new THREE.Mesh(g, new THREE.MeshBasicMaterial({ vertexColors: true, side: THREE.BackSide, fog: false, depthWrite: false }));
    m.scale.setScalar(2000);
    m.renderOrder = -10;
    // the sun: a soft disc
    var cv = document.createElement('canvas'); cv.width = cv.height = 128;
    var x = cv.getContext('2d'), gr = x.createRadialGradient(64, 64, 4, 64, 64, 64);
    gr.addColorStop(0, 'rgba(255,252,235,1)'); gr.addColorStop(0.18, 'rgba(255,245,210,0.95)'); gr.addColorStop(0.4, 'rgba(255,230,170,0.25)'); gr.addColorStop(1, 'rgba(255,220,160,0)');
    x.fillStyle = gr; x.fillRect(0, 0, 128, 128);
    var sun = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), new THREE.MeshBasicMaterial({ map: new THREE.CanvasTexture(cv), transparent: true, fog: false, depthWrite: false }));
    sun.scale.setScalar(420);
    sun.position.copy(SUN).multiplyScalar(1800);
    sun.lookAt(0, 0, 0);
    sun.renderOrder = -9;
    var grp = new THREE.Group();
    grp.add(m); grp.add(sun);
    return grp;
  }

  function ground() {
    var size = 2600, seg = 64;
    var g = new THREE.PlaneGeometry(size, size, seg, seg);
    g.rotateX(-Math.PI / 2);
    var p = g.attributes.position;
    // small bumps far from the track only (the track area stays flat)
    for (var i = 0; i < p.count; i++) {
      var x = p.getX(i), z = p.getZ(i), r = Math.sqrt(x * x + z * z);
      if (r > 520) p.setY(i, Math.max(0, (r - 520) * 0.06) * (0.6 + 0.4 * Math.sin(x * 0.013) * Math.cos(z * 0.011)) - 0.2);
      else p.setY(i, -0.2);
    }
    var grass = [new THREE.Color(0x6e9a44), new THREE.Color(0x76a24a), new THREE.Color(0x66923f), new THREE.Color(0x7aa650)];
    return bake(g, function (f, m, n) {
      var r = Math.sqrt(m.x * m.x + m.z * m.z);
      var c = lit(grass[(f * 7 + (f >> 3)) % 4], n, 0.62, 0.45);
      if (r > 700) c.lerp(HAZE, Math.min(0.5, (r - 700) / 1400));
      return c;
    });
  }

  function mountains() {
    var parts = [], rnd = seeded(7);
    var rock = new THREE.Color(0x6d6f78), rock2 = new THREE.Color(0x5d6670), snow = new THREE.Color(0xf4f6fa), green = new THREE.Color(0x58743f);
    for (var k = 0; k < 34; k++) {
      var ang = k / 34 * Math.PI * 2 + rnd() * 0.08;
      var dist = 1250 + rnd() * 300;
      var h = 220 + rnd() * 360 + (Math.abs(Math.sin(ang * 1.5)) > 0.8 ? 220 : 0);   // a few big peaks
      var r = h * (0.9 + rnd() * 0.5);
      var g = new THREE.ConeGeometry(r, h, 6 + Math.floor(rnd() * 3), 3);
      var p = g.attributes.position;
      for (var i = 0; i < p.count; i++) {
        var y = p.getY(i);
        if (y < h / 2 - 1) { p.setX(i, p.getX(i) * (0.85 + rnd() * 0.3)); p.setZ(i, p.getZ(i) * (0.85 + rnd() * 0.3)); p.setY(i, y + (rnd() - 0.5) * h * 0.08); }
      }
      g.translate(Math.cos(ang) * dist, h / 2 - 2, Math.sin(ang) * dist);
      var snowLine = 230 + rnd() * 80;
      parts.push(bake(g, function (f, m, n) {
        var base = m.y > snowLine ? snow : (m.y < 60 ? green : (f % 2 ? rock : rock2));
        var c = lit(base, n, 0.6, 0.55);
        return c.lerp(HAZE, 0.42);   // far away: aerial perspective
      }));
    }
    return mergeGeos(parts);
  }

  /* detail textures: fine grain multiplied over the baked colours (mean about 0.9, the material colour
     lifts it back). Planar world UVs, mipmapped, anisotropic where the TV allows. */
  function grain(kind, aniso) {
    var S = 256, cv = document.createElement('canvas'); cv.width = cv.height = S;
    var x = cv.getContext('2d'), img = x.createImageData(S, S), d = img.data, rnd = seeded(kind === 'road' ? 3 : 5);
    var i, v;
    for (i = 0; i < S * S; i++) {
      if (kind === 'road') v = 214 + (rnd() - 0.5) * 70 + (rnd() < 0.03 ? 40 : 0);
      else v = 205 + (rnd() - 0.5) * 60;
      d[i * 4] = d[i * 4 + 1] = d[i * 4 + 2] = Math.max(0, Math.min(255, v)); d[i * 4 + 3] = 255;
    }
    x.putImageData(img, 0, 0);
    // soft blotches: patched asphalt, or clumps of grass
    for (i = 0; i < 60; i++) {
      var px = rnd() * S, py = rnd() * S, r = 8 + rnd() * 26;
      var g = x.createRadialGradient(px, py, 0, px, py, r), dark = rnd() < 0.5;
      var a = kind === 'road' ? 0.13 : 0.2;
      g.addColorStop(0, dark ? 'rgba(0,0,0,' + a + ')' : 'rgba(255,255,255,' + a + ')');
      g.addColorStop(1, 'rgba(0,0,0,0)');
      x.fillStyle = g;
      for (var ox = -S; ox <= S; ox += S) for (var oy = -S; oy <= S; oy += S) { x.save(); x.translate(ox, oy); x.fillRect(px - r, py - r, r * 2, r * 2); x.restore(); }
    }
    if (kind === 'grass') {
      // little blades
      for (i = 0; i < 900; i++) {
        var bx = rnd() * S, by = rnd() * S;
        x.strokeStyle = rnd() < 0.5 ? 'rgba(255,255,255,0.18)' : 'rgba(0,0,0,0.16)';
        x.beginPath(); x.moveTo(bx, by); x.lineTo(bx + (rnd() - 0.5) * 3, by - 3 - rnd() * 4); x.stroke();
      }
    }
    var tex = new THREE.CanvasTexture(cv);
    tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
    tex.anisotropy = aniso || 1;
    return tex;
  }

  /* world-planar UVs (vertical faces get some variation from y) */
  function planarUv(geo, size) {
    var p = geo.attributes.position, uv = new Float32Array(p.count * 2);
    for (var i = 0; i < p.count; i++) {
      var y = p.getY(i);
      uv[i * 2] = (p.getX(i) + y * 0.8) / size;
      uv[i * 2 + 1] = (p.getZ(i) + y * 0.8) / size;
    }
    geo.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
    return geo;
  }

  function seeded(s) {
    return function () { s = (s * 16807) % 2147483647; return (s - 1) / 2147483646; };
  }

  /* one pine (trunk + 3 cones), its base at y = 0 */
  function pine() {
    var parts = [];
    var trunk = new THREE.CylinderGeometry(0.25, 0.35, 2.2, 5); trunk.translate(0, 1.1, 0);
    parts.push(bake(trunk, function (f, m, n) { return lit(new THREE.Color(0x6b4a2e), n); }));
    var tiers = [[2.6, 3.6, 3.0], [2.0, 3.0, 4.9], [1.3, 2.6, 6.6]];
    for (var i = 0; i < tiers.length; i++) {
      var c = new THREE.ConeGeometry(tiers[i][0], tiers[i][1], 7); c.translate(0, tiers[i][2], 0);
      parts.push(bake(c, function (f, m, n) { return lit(new THREE.Color(f % 2 ? 0x2f6b3a : 0x2a5f34), n, 0.55, 0.6); }));
    }
    return mergeGeos(parts);
  }

  function trees(tr) {
    var geo = pine(), rnd = seeded(11), max = 420, list = [];
    var tries = 0;
    while (list.length < max && tries++ < 6000) {
      var x = (rnd() - 0.5) * 1300, z = (rnd() - 0.5) * 1100 + 150;
      // keep clear of the track (and its barriers)
      var ok = true, d2min = 1e9;
      for (var i = 0; i < tr.n; i += 2) {
        var dx = x - tr.px[i], dz = z - tr.pz[i], d2 = dx * dx + dz * dz;
        if (d2 < d2min) d2min = d2;
      }
      var need = tr.wall + 6;
      if (d2min < need * need) ok = false;
      // more trees close to the track (seen most), fewer far away
      if (ok && d2min > 140 * 140 && rnd() < 0.6) ok = false;
      if (ok) list.push([x, z]);
    }
    var mesh = new THREE.InstancedMesh(geo, new THREE.MeshBasicMaterial({ vertexColors: true }), list.length);
    var m = new THREE.Matrix4(), q = new THREE.Quaternion(), s = new THREE.Vector3(), p = new THREE.Vector3(), up = new THREE.Vector3(0, 1, 0);
    for (var k = 0; k < list.length; k++) {
      var sc = 0.8 + rnd() * 0.9;
      q.setFromAxisAngle(up, rnd() * 6.28);
      s.set(sc, sc * (0.85 + rnd() * 0.35), sc);
      p.set(list[k][0], -0.1, list[k][1]);
      m.compose(p, q, s);
      mesh.setMatrixAt(k, m);
    }
    return mesh;
  }

  function box(w, h, d, x, y, z, color, ry) {
    var g = new THREE.BoxGeometry(w, h, d);
    if (ry) g.rotateY(ry);
    g.translate(x, y, z);
    return bake(g, function (f, m, n) { return lit(new THREE.Color(color), n); });
  }

  /* start gantry over the line, grandstand beside the start straight */
  function startArea(tr) {
    var parts = [];
    var o = {};
    Track.pointAt(tr, 0, 0, o);
    var span = tr.hw + 3.5;
    var hd = o.heading;
    var nx = tr.nx[0], nz = tr.nz[0];
    // pillars
    parts.push(box(1, 7, 1, o.x + nx * span, 3.5, o.z + nz * span, 0x2b2f3a, hd));
    parts.push(box(1, 7, 1, o.x - nx * span, 3.5, o.z - nz * span, 0x2b2f3a, hd));
    // beam with checkers
    var cells = 16;
    for (var c = 0; c < cells; c++) {
      var l = -span + (c + 0.5) * (2 * span / cells);
      parts.push(box(2 * span / cells, 0.8, 0.5, o.x + nx * l, 7.1, o.z + nz * l, c % 2 ? 0x15161a : 0xf4f4f0, hd));
      parts.push(box(2 * span / cells, 0.8, 0.5, o.x + nx * l, 6.3, o.z + nz * l, c % 2 ? 0xf4f4f0 : 0x15161a, hd));
    }
    // grandstand: stepped rows on the right side of the straight
    var gs = {};
    for (var row = 0; row < 6; row++) {
      for (var seg = -4; seg <= 4; seg++) {
        Track.pointAt(tr, seg * 9 + 20, -(tr.wall + 4 + row * 1.6), gs);
        var col = row % 2 ? 0x3f6fb8 : 0x335c9c;
        parts.push(box(9, 1 + row * 0.9, 1.6, gs.x, (1 + row * 0.9) / 2, gs.z, col, gs.heading + Math.PI / 2));
      }
    }
    // roof
    Track.pointAt(tr, 20, -(tr.wall + 8), gs);
    parts.push(box(84, 0.5, 11, gs.x, 9.2, gs.z, 0xd8dde6, gs.heading + Math.PI / 2));
    return mergeGeos(parts);
  }

  /* a small stone church with a drum and cone roof, on a hill (a nod to Gergeti) */
  function church(x, z, ry) {
    var stone = 0x9b8a72, roof = 0x6d6a66, parts = [];
    var hill = new THREE.ConeGeometry(70, 34, 9, 2); hill.translate(x, 15, z);
    parts.push(bake(hill, function (f, m, n) { return lit(new THREE.Color(f % 2 ? 0x6e9142 : 0x648a3d), n, 0.6, 0.5); }));
    var y0 = 32;
    parts.push(box(10, 8, 16, x, y0 + 4, z, stone, ry));
    parts.push(box(16, 6, 7, x, y0 + 3, z, stone, ry));
    var drum = new THREE.CylinderGeometry(2.8, 2.8, 5, 8); drum.translate(x, y0 + 10.5, z);
    parts.push(bake(drum, function (f, m, n) { return lit(new THREE.Color(stone), n); }));
    var cone = new THREE.ConeGeometry(3.3, 4.5, 8); cone.translate(x, y0 + 15.2, z);
    parts.push(bake(cone, function (f, m, n) { return lit(new THREE.Color(roof), n); }));
    var r1 = new THREE.ConeGeometry(8, 3, 4); r1.rotateY(Math.PI / 4 + (ry || 0)); r1.scale(1, 1, 1.6); r1.translate(x, y0 + 9.5, z);
    parts.push(bake(r1, function (f, m, n) { return lit(new THREE.Color(roof), n); }));
    var tower = new THREE.CylinderGeometry(1.4, 1.4, 9, 6); tower.translate(x + 9, y0 + 4.5, z - 12);
    parts.push(bake(tower, function (f, m, n) { return lit(new THREE.Color(stone), n); }));
    return mergeGeos(parts);
  }

  function build(scene, tr, aniso) {
    var a = Math.min(4, aniso || 1);
    var mat = new THREE.MeshBasicMaterial({ vertexColors: true, side: THREE.DoubleSide, map: grain('road', a) });
    mat.color.setScalar(1.1);
    var gmat = new THREE.MeshBasicMaterial({ vertexColors: true, map: grain('grass', a) });
    gmat.color.setScalar(1.14);
    var skyGroup = sky();
    scene.add(skyGroup);
    scene.add(new THREE.Mesh(planarUv(ground(), 9), gmat));
    var mtn = new THREE.Mesh(mountains(), new THREE.MeshBasicMaterial({ vertexColors: true, fog: false }));
    scene.add(mtn);
    scene.add(new THREE.Mesh(planarUv(Track.roadMesh(tr), 7), mat));
    scene.add(trees(tr));
    scene.add(new THREE.Mesh(startArea(tr), new THREE.MeshBasicMaterial({ vertexColors: true })));
    scene.add(new THREE.Mesh(church(-60, 520, 0.4), new THREE.MeshBasicMaterial({ vertexColors: true })));
    scene.fog = new THREE.Fog(HAZE.getHex(), 260, 1100);
    return { sky: skyGroup };
  }

  return { build: build, SUN: SUN, lit: lit, bake: bake, mergeGeos: mergeGeos, box: box };
})();
