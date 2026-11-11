// Shared modelling helpers for the realism prototype: soft rounded boxes, side-profile extrusions, tubes along a
// path, lathe tyres. Convention (same as games/hqvehiclemodels.js): metres, forward +z, up +y, model-local +x is LEFT.
import * as THREE from "three";

// A box whose edges and corners are rounded to radius r (every vertex is pushed out from an inner box), with the
// rounded normals set directly so the shading stays soft. seg: subdivisions per side (more = rounder corners).
export function roundedBox(w, h, d, r, seg = 2){
  r = Math.min(r, w / 2, h / 2, d / 2);
  const g = new THREE.BoxGeometry(w, h, d, seg * 2, seg * 2, seg * 2);
  const p = g.attributes.position, n = g.attributes.normal;
  const hx = w / 2 - r, hy = h / 2 - r, hz = d / 2 - r, v = new THREE.Vector3(), c = new THREE.Vector3();
  for(let i = 0; i < p.count; i++){
    v.fromBufferAttribute(p, i);
    c.set(THREE.MathUtils.clamp(v.x, -hx, hx), THREE.MathUtils.clamp(v.y, -hy, hy), THREE.MathUtils.clamp(v.z, -hz, hz));
    v.sub(c);
    if(v.lengthSq() < 1e-12){ continue; }
    v.normalize();
    n.setXYZ(i, v.x, v.y, v.z);
    v.multiplyScalar(r).add(c);
    p.setXYZ(i, v.x, v.y, v.z);
  }
  return g;
}

// A side silhouette (points as [z, y] pairs, any order around the outline) extruded across the bike to width w,
// centred on x = 0, with a soft bevel. The workhorse for tanks, fairings, seats, mudguards and car bodies.
export function profile(pts, w, bevel = 0.012, curveSeg = 3){
  const s = new THREE.Shape();
  pts.forEach(([z, y], i) => i ? s.lineTo(z, y) : s.moveTo(z, y));
  s.closePath();
  const depth = Math.max(0.001, w - 2 * bevel);
  const g = new THREE.ExtrudeGeometry(s, {depth, bevelEnabled: bevel > 0, bevelThickness: bevel, bevelSize: bevel,
    bevelSegments: curveSeg, curveSegments: 8});
  g.translate(0, 0, -depth / 2);
  g.rotateY(-Math.PI / 2);   // shape x -> +z (forward), extrusion -> x (across)
  g.computeVertexNormals();
  return g;
}

// The same, but from a smooth closed curve through the points (a Catmull-Rom outline) for organic panels.
export function smoothProfile(pts, w, bevel = 0.012, samples = 40){
  const c = new THREE.CatmullRomCurve3(pts.map(([z, y]) => new THREE.Vector3(z, y, 0)), true, "centripetal");
  return profile(c.getPoints(samples).slice(0, -1).map(v => [v.x, v.y]), w, bevel);
}

// A flat decal (livery panel) on a side face: pts as [z, y]; returns geometry lying in the x = 0 plane, 3 mm thick.
export function decal(pts){
  const s = new THREE.Shape();
  pts.forEach(([z, y], i) => i ? s.lineTo(z, y) : s.moveTo(z, y));
  s.closePath();
  const g = new THREE.ExtrudeGeometry(s, {depth: 0.003, bevelEnabled: false});
  g.rotateY(-Math.PI / 2);
  return g;
}

// A round tube through 3D points [x, y, z] (handlebars, frame tubes, exhaust headers, rack rails).
export function tube(pts, r, seg = 24, radial = 10, closed = false){
  const c = new THREE.CatmullRomCurve3(pts.map(p => new THREE.Vector3(...p)), closed, "centripetal");
  return new THREE.TubeGeometry(c, seg, r, radial, closed);
}

// A straight cylinder from a to b (struts, spokes, fork legs).
export function rod(a, b, r0, r1 = r0, radial = 10){
  const A = new THREE.Vector3(...a), B = new THREE.Vector3(...b), len = A.distanceTo(B);
  const g = new THREE.CylinderGeometry(r1, r0, len, radial, 1);
  g.translate(0, len / 2, 0);
  const q = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), B.clone().sub(A).normalize());
  g.applyQuaternion(q);
  g.translate(A.x, A.y, A.z);
  return g;
}

// A tyre: a lathe of a rounded section (rim radius rr, outer radius R, section width w), axis along x.
export function tyre(rr, R, w, seg = 48){
  const pts = [], k = 10;
  for(let i = 0; i <= k; i++){
    const a = -Math.PI / 2 + Math.PI * i / k;
    pts.push(new THREE.Vector2(rr + (R - rr) * (0.55 + 0.45 * Math.cos(a)), (w / 2) * Math.sin(a)));
  }
  pts.unshift(new THREE.Vector2(rr, -w * 0.42)); pts.push(new THREE.Vector2(rr, w * 0.42));
  const g = new THREE.LatheGeometry(pts, seg);
  g.rotateZ(Math.PI / 2);
  return g;
}

// Knobbly tread: blocks around a tyre in two staggered rows (adventure / off-road pattern).
export function knobs(R, w, n, bw = 0.03, bh = 0.012){
  const out = [];
  for(let row = 0; row < 2; row++){
    for(let i = 0; i < n; i++){
      const a = (i + row * 0.5) / n * Math.PI * 2;
      const x = (row ? -1 : 1) * w * 0.2;
      const g = new THREE.BoxGeometry(w * 0.36, bh, bw);
      g.translate(x, R + bh * 0.2, 0);
      g.rotateX(a);
      out.push(g);
    }
  }
  return out;
}

// Merge geometries that share one material (non-indexed + indexed mixed is handled by toNonIndexed).
export function merge(geos){
  const list = geos.map(g => g.index ? g.toNonIndexed() : g);
  let count = 0;
  list.forEach(g => count += g.attributes.position.count);
  const pos = new Float32Array(count * 3), nor = new Float32Array(count * 3);
  let o = 0;
  for(const g of list){
    if(!g.attributes.normal){ g.computeVertexNormals(); }
    pos.set(g.attributes.position.array, o * 3);
    nor.set(g.attributes.normal.array, o * 3);
    o += g.attributes.position.count;
  }
  const m = new THREE.BufferGeometry();
  m.setAttribute("position", new THREE.BufferAttribute(pos, 3));
  m.setAttribute("normal", new THREE.BufferAttribute(nor, 3));
  return m;
}

// A tiny builder: collects geometry per material key, then emits one mesh per material (few draw calls).
export class Kit {
  constructor(mats){ this.mats = mats; this.bins = {}; }
  add(key, geo, x = 0, y = 0, z = 0, rx = 0, ry = 0, rz = 0){
    place(geo, x, y, z, rx, ry, rz);
    (this.bins[key] = this.bins[key] || []).push(geo);
    return geo;
  }
  // Add a geometry on the left (+x) and its mirror on the right.
  pair(key, make, x = 0, y = 0, z = 0, rx = 0, ry = 0, rz = 0){
    this.add(key, make(), x, y, z, rx, ry, rz);
    const g = place(make(), x, y, z, rx, ry, rz);
    (this.bins[key] = this.bins[key] || []).push(flipX(g));
    return g;
  }
  build(group, opts = {}){
    for(const key of Object.keys(this.bins)){
      const mesh = new THREE.Mesh(merge(this.bins[key]), this.mats[key]);
      mesh.castShadow = opts.cast !== false; mesh.receiveShadow = !!opts.receive;
      mesh.name = key;
      group.add(mesh);
    }
    this.bins = {};
    return group;
  }
}

export function place(geo, x = 0, y = 0, z = 0, rx = 0, ry = 0, rz = 0){
  if(rx || ry || rz){ geo.applyMatrix4(new THREE.Matrix4().makeRotationFromEuler(new THREE.Euler(rx, ry, rz, "YXZ"))); }
  if(x || y || z){ geo.translate(x, y, z); }
  return geo;
}

// Mirror a geometry across x = 0 and fix the winding so it still faces out.
export function flipX(g){
  const p = g.attributes.position, n = g.attributes.normal;
  for(let i = 0; i < p.count; i++){ p.setX(i, -p.getX(i)); if(n){ n.setX(i, -n.getX(i)); } }
  if(g.index){
    const a = g.index.array;
    for(let i = 0; i < a.length; i += 3){ const t = a[i + 1]; a[i + 1] = a[i + 2]; a[i + 2] = t; }
  } else {
    const swap = (attr) => {
      if(!attr){ return; }
      const s = attr.itemSize, arr = attr.array;
      for(let i = 0; i < attr.count; i += 3){
        for(let k = 0; k < s; k++){ const t = arr[(i + 1) * s + k]; arr[(i + 1) * s + k] = arr[(i + 2) * s + k]; arr[(i + 2) * s + k] = t; }
      }
    };
    swap(p); swap(n);
  }
  return g;
}

export function std(color, rough = 0.5, metal = 0, extra = {}){
  return new THREE.MeshStandardMaterial(Object.assign({color, roughness: rough, metalness: metal}, extra));
}

// Narrow a geometry across x toward the back: scale sFront at z >= zFront, sBack at z <= zBack (knee cut-outs).
export function taperX(g, zFront, zBack, sFront, sBack){
  const p = g.attributes.position;
  for(let i = 0; i < p.count; i++){
    const t = THREE.MathUtils.clamp((p.getZ(i) - zBack) / (zFront - zBack), 0, 1);
    p.setX(i, p.getX(i) * (sBack + (sFront - sBack) * t));
  }
  g.computeVertexNormals();
  return g;
}

// Loft: a smooth skin through cross-section rings. rings[i] is an array of [x, y] points (same count for every ring,
// ordered around the section), zs[i] its station. closed: the ring wraps around. Indexed, so normals come out smooth.
export function loft(rings, zs, closed = true){
  const n = rings[0].length, m = rings.length, pos = [], idx = [];
  for(let i = 0; i < m; i++){ for(const [x, y] of rings[i]){ pos.push(x, y, zs[i]); } }
  const seg = closed ? n : n - 1;
  for(let i = 0; i < m - 1; i++){
    for(let j = 0; j < seg; j++){
      const a = i * n + j, b = i * n + (j + 1) % n, c = (i + 1) * n + j, d = (i + 1) * n + (j + 1) % n;
      idx.push(a, b, c, b, d, c);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
  g.setIndex(idx);
  g.computeVertexNormals();
  return g;
}

// Piecewise-smooth lookup through [t, value] keys (cosine-eased between keys).
export function curve(keys){
  return t => {
    if(t <= keys[0][0]){ return keys[0][1]; }
    for(let i = 1; i < keys.length; i++){
      if(t <= keys[i][0]){
        const [t0, v0] = keys[i - 1], [t1, v1] = keys[i], u = (t - t0) / (t1 - t0), e = (1 - Math.cos(u * Math.PI)) / 2;
        return v0 + (v1 - v0) * e;
      }
    }
    return keys[keys.length - 1][1];
  };
}

// Close a loft end: a fan from the ring's centre at station z; dir +1 faces forward (+z), -1 faces back.
export function cap(ring, z, dir){
  let cx = 0, cy = 0;
  ring.forEach(([x, y]) => { cx += x; cy += y; });
  cx /= ring.length; cy /= ring.length;
  const pos = [cx, cy, z], idx = [];
  ring.forEach(([x, y]) => pos.push(x, y, z));
  for(let i = 0; i < ring.length; i++){
    const a = 1 + i, b = 1 + (i + 1) % ring.length;
    if(dir > 0){ idx.push(0, a, b); } else { idx.push(0, b, a); }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
  g.setIndex(idx);
  g.computeVertexNormals();
  const n = g.attributes.normal;
  for(let i = 0; i < n.count; i++){ n.setXYZ(i, 0, 0, dir); }
  return g;
}
