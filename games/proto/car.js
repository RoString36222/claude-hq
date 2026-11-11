// Sports saloon, modelled from the BMW M3 Competition (G80) layout: length 4,794 mm, width 1,903 mm, height 1,433 mm,
// wheelbase 2,857 mm, 275/35 R19 front and 285/30 R20 rear, the tall twin kidney grille, M side gills, quad tailpipes
// in a black diffuser. Original paint, no badges. Same rig shape as the bike: {g, wheels, steerL, steerR, anchors}.
import * as THREE from "three";
import {roundedBox, profile, tube, rod, tyre, Kit, std, flipX, loft, curve, cap} from "./parts.js";

const WB = 2.857, FZ = WB / 2, RZ = -WB / 2, R = 0.34, HALF_W = 0.95;

// plan-view and tumblehome shaping: narrow the extruded slab toward the nose and tail, and inward above the beltline
function shapeBody(g, opts){
  const p = g.attributes.position;
  for(let i = 0; i < p.count; i++){
    const z = p.getZ(i), y = p.getY(i);
    let f = 1;
    const dn = z - (opts.front - opts.endLen), dt = (opts.rear + opts.endLen) - z;
    if(dn > 0){ const t = dn / opts.endLen; f *= 1 - opts.endPinch * t * t; }
    if(dt > 0){ const t = dt / opts.endLen; f *= 1 - opts.endPinch * 0.8 * t * t; }
    if(opts.belt != null && y > opts.belt){ f *= 1 - opts.tumble * Math.min(1, (y - opts.belt) / (opts.roof - opts.belt)); }
    p.setX(i, p.getX(i) * f);
  }
  g.computeVertexNormals();
  return g;
}

function archPts(cz, cy, r, a0, a1, n = 14){
  const out = [];
  for(let i = 0; i <= n; i++){ const a = a0 + (a1 - a0) * i / n; out.push([cz + r * Math.cos(a), cy + r * Math.sin(a)]); }
  return out;
}

export function buildSportsSaloon(opts = {}){
  const M = {
    paint: new THREE.MeshPhysicalMaterial({color: opts.paint ?? 0x1d6a4c, roughness: 0.42, metalness: 0.18, clearcoat: 0.8, clearcoatRoughness: 0.12, envMapIntensity: 0.75}),
    black: std(0x141518, 0.45, 0.1),
    gloss: new THREE.MeshPhysicalMaterial({color: 0x0d0e10, roughness: 0.18, metalness: 0.2, clearcoat: 1}),
    carbon: new THREE.MeshPhysicalMaterial({color: 0x1b1d21, roughness: 0.3, metalness: 0.3, clearcoat: 1}),
    glass: new THREE.MeshPhysicalMaterial({color: 0x0f161c, roughness: 0.04, metalness: 0.2, clearcoat: 1, transparent: true, opacity: 0.9, envMapIntensity: 1.2}),
    chrome: std(0xd9dde2, 0.15, 1.0),
    steel: std(0xc5c9ce, 0.25, 0.9),
    rim: std(0x3a3d42, 0.3, 0.8),
    rubber: std(0x151517, 0.9, 0),
    caliper: std(0x1f4fbf, 0.35, 0.3),
    lamp: new THREE.MeshStandardMaterial({color: 0xffffff, emissive: 0xdfefff, emissiveIntensity: 1.8}),
    lens: new THREE.MeshPhysicalMaterial({color: 0x5d6873, roughness: 0.05, metalness: 0.8, clearcoat: 1}),
    tail: new THREE.MeshStandardMaterial({color: 0xff1e1e, emissive: 0xb00000, emissiveIntensity: 0.9, roughness: 0.25}),
    amber: new THREE.MeshStandardMaterial({color: 0xffa21a, emissive: 0xff8a00, emissiveIntensity: 0.5}),
    plate: std(0xeeeeea, 0.5, 0),
  };
  const g = new THREE.Group(); g.name = "sports-saloon";
  const K = new Kit(M);

  // ---- body: a loft of rounded (superellipse) sections along the car, wheel arches carved into the flanks -------------
  const ZF = 2.36, ZR = -2.49, CAP = 0.07, ar = 0.385, acy = R + 0.01;
  const top = curve([[ZR, 0.98], [-2.42, 1.07], [-2.2, 1.075], [-1.6, 1.04], [-1.0, 0.99], [0.0, 0.97], [0.86, 0.955],
    [1.4, 0.90], [1.95, 0.85], [2.25, 0.78], [ZF, 0.70]]);
  const bot = curve([[ZR, 0.32], [-2.35, 0.24], [-2.0, 0.19], [-1.0, 0.165], [1.0, 0.165], [2.0, 0.19], [2.28, 0.21], [ZF, 0.26]]);
  const half = curve([[ZR, 0.86], [-2.3, 0.925], [-1.6, 0.95], [1.4, 0.95], [2.0, 0.93], [2.25, 0.89], [ZF, 0.84]]);
  const archY = z => {
    let y = -9;
    for(const cz of [FZ, RZ]){ const d = Math.abs(z - cz); if(d < ar){ y = Math.max(y, acy + Math.sqrt(ar * ar - d * d)); } }
    return y;
  };
  const se = (c, n) => Math.sign(c) * Math.pow(Math.abs(c), 2 / n);
  // the cross-section, designed rather than a superellipse: rocker, a slightly convex door, the max width low, a crisp
  // shoulder line, then the upper body tucking in to a gently crowned top. (u: x / half-width, v: 0 sill .. 1 top)
  const SEC = [[0.95, 0.06], [0.985, 0.18], [1.0, 0.42], [0.99, 0.60], [0.978, 0.70], [0.955, 0.735], [0.90, 0.80],
    [0.80, 0.90], [0.64, 0.975], [0.32, 1.0], [0.0, 1.006]];
  const sample = (pts, n) => {
    const c = new THREE.CatmullRomCurve3(pts.map(([u, v]) => new THREE.Vector3(u, v, 0)), false, "centripetal", 0.5);
    return c.getSpacedPoints(n).map(q => [q.x, q.y]);
  };
  const paintSec = sample(SEC.concat(SEC.slice(0, -1).reverse().map(([u, v]) => [-u, v])), 60);
  const underSec = sample([[-0.95, 0.06], [-0.80, 0.0], [0, -0.005], [0.80, 0.0], [0.95, 0.06]], 14);
  const dome = (z, u) => {
    if(z < 0.95 || z > 2.2){ return 0; }
    const tz = Math.sin((z - 0.95) / 1.25 * Math.PI);
    return 0.016 * tz * (Math.exp(-(((u - 0.22) / 0.12) ** 2)) + Math.exp(-(((u + 0.22) / 0.12) ** 2)));
  };
  const station = z => {
    let w = half(z), yt = top(z), yb = bot(z);
    const past = Math.max(z - (ZF - CAP), (ZR + CAP) - z, 0);
    const k = past > 0 ? Math.sqrt(Math.max(0.02, 1 - (past / CAP) ** 2)) : 1;
    const h = (yt - yb) * (0.4 + 0.6 * k);
    w *= 0.35 + 0.65 * k;
    const yb2 = yb + (yt - yb - h) * 0.5;
    return {w, yb: yb2, h, ay: archY(z)};
  };
  const surf = (z, u, v) => {
    const S = station(z);
    let y = S.yb + v * S.h + (v > 0.95 ? dome(z, u) : 0);
    if(y < S.ay){ y = S.ay; }
    return new THREE.Vector3(u * S.w, y, z);
  };
  const ringOf = (z, sec) => sec.map(([u, v]) => { const q = surf(z, u, v); return [q.x, q.y]; });
  const up = [], under = [], zs = [], NS = 110;
  for(let i = 0; i <= NS; i++){
    const u = i / NS, z = ZR + (ZF - ZR) * (0.5 - 0.5 * Math.cos(u * Math.PI));
    zs.push(z); up.push(ringOf(z, paintSec)); under.push(ringOf(z, underSec));
  }
  K.add("paint", loft(up, zs, false));
  K.add("black", loft(under, zs, false));
  // close both ends (the ring there is already pulled in by the end rounding); test the winding with dir
  const endRing = i => up[i].concat(under[i].slice(1, -1));
  K.add("paint", cap(endRing(0), zs[0], -1));
  K.add("paint", cap(endRing(NS), zs[NS], 1));

  // ---- greenhouse: glass with tumblehome, carbon roof, black A-pillars, body-colour C-pillars -----------------------------
  const roof = curve([[-1.66, 1.03], [-1.0, 1.40], [-0.62, 1.433], [-0.05, 1.40], [0.88, 0.95]]);
  const ghRing = (z, a0, a1, grow = 0, n = 26) => {
    const yb = top(z) - 0.02, yt = Math.max(yb + 0.001, roof(z)), wb = half(z) * 0.82, wt = half(z) * 0.62, ring = [];
    for(let j = 0; j <= n; j++){
      const a = a0 + (a1 - a0) * j / n, c = Math.cos(a), sn = Math.sin(a), e = Math.pow(Math.abs(sn), 0.5);
      const y = yb + (yt - yb) * e, x = se(c, 4) * (wb + (wt - wb) * e);
      ring.push([x * (1 + grow), y + grow * 0.6]);
    }
    return ring;
  };
  const ghZ = [], ghR = [], roofR = [], roofZ = [], cpR = [[], []], cpZ = [];
  for(let i = 0; i <= 44; i++){
    const z = -1.66 + (0.88 + 1.66) * i / 44;
    ghZ.push(z); ghR.push(ghRing(z, 0, Math.PI));
    if(z > -1.02 && z < 0.0){ roofZ.push(z); roofR.push(ghRing(z, Math.PI * 0.30, Math.PI * 0.70, 0.004, 12)); }
    if(z < -1.05){ cpZ.push(z); cpR[0].push(ghRing(z, 0.02, Math.PI * 0.30, 0.004, 8)); cpR[1].push(ghRing(z, Math.PI * 0.70, Math.PI - 0.02, 0.004, 8)); }
  }
  K.add("glass", loft(ghR, ghZ, false));
  K.add("carbon", loft(roofR, roofZ, false));
  K.add("paint", loft(cpR[0], cpZ, false)); K.add("paint", loft(cpR[1], cpZ, false));
  K.pair("gloss", () => roundedBox(0.03, 0.36, 0.09, 0.012), 0.72, 1.18, -0.52, 0.0, 0, 0.22);     // B-pillar

  // ---- nose: twin kidney grille, headlights, intakes, splitter, power-dome bonnet ---------------------------------------
  K.pair("chrome", () => roundedBox(0.25, 0.33, 0.06, 0.05), 0.145, 0.50, 2.335);
  K.pair("gloss", () => roundedBox(0.215, 0.295, 0.06, 0.04), 0.145, 0.50, 2.35);
  for(let i = 0; i < 4; i++){ K.pair("chrome", () => roundedBox(0.012, 0.27, 0.02, 0.005), 0.075 + i * 0.047, 0.50, 2.37); }
  // headlight units seated on the body surface (position and facing from the loft itself)
  // the real skin point on the nose for (x, y): walk back from the nose until the section at that height reaches x
  const boundU = v => {
    if(v <= SEC[0][1]){ return SEC[0][0]; }
    for(let q = 1; q < SEC.length; q++){ if(v <= SEC[q][1]){ const [u0, v0] = SEC[q - 1], [u1, v1] = SEC[q]; return u0 + (u1 - u0) * (v - v0) / (v1 - v0); } }
    return 0;
  };
  const noseZ = (x, y) => {
    let lo = ZF - 0.6, hi = ZF + 0.01;
    for(let it = 0; it < 30; it++){
      const mid = (lo + hi) / 2, S = station(mid), v = (y - S.yb) / S.h;
      const inside = v >= 0 && v <= 1.0 && Math.abs(x) <= boundU(v) * S.w;
      if(inside){ lo = mid; } else { hi = mid; }
    }
    return lo;
  };
  const seat = (geo, x, y, out) => {
    const z = noseZ(x, y), e = 0.02;
    const dzdx = (noseZ(x + e, y) - noseZ(x - e, y)) / (2 * e), dzdy = (noseZ(x, y + e) - noseZ(x, y - e)) / (2 * e);
    const n = new THREE.Vector3(-dzdx, -dzdy, 1).normalize(), p0 = new THREE.Vector3(x, y, z);
    const o = new THREE.Object3D(); o.position.copy(p0).addScaledVector(n, out); o.lookAt(p0.clone().add(n)); o.updateMatrix();
    return geo.applyMatrix4(o.matrix);
  };
  for(const sx of [1, -1]){
    K.add("gloss", seat(roundedBox(0.30, 0.10, 0.04, 0.03), sx * 0.58, 0.64, -0.008));
    K.add("lens", seat(roundedBox(0.075, 0.07, 0.03, 0.03), sx * 0.50, 0.645, 0.006));
    K.add("lens", seat(roundedBox(0.075, 0.07, 0.03, 0.03), sx * 0.63, 0.645, 0.006));
    K.add("lamp", seat(roundedBox(0.27, 0.014, 0.016, 0.006), sx * 0.58, 0.602, 0.012));
    K.add("lamp", seat(roundedBox(0.014, 0.06, 0.016, 0.006), sx * 0.43, 0.63, 0.012));
  }
  K.pair("gloss", () => roundedBox(0.30, 0.17, 0.08, 0.05), 0.58, 0.36, 2.29, 0, -0.3, 0);          // side intakes
  K.add("gloss", roundedBox(0.66, 0.10, 0.08, 0.04), 0, 0.27, 2.33);                                 // centre intake
  K.add("carbon", roundedBox(1.80, 0.025, 0.16, 0.01), 0, 0.19, 2.27);                              // splitter
  K.add("paint", shapeBody(profile([[2.05, 0.75], [1.5, 0.82], [1.0, 0.86], [1.5, 0.79]], 0.62, 0.03, 3), {front: 2.1, rear: 1, endLen: 0.0001, endPinch: 0}));

  // ---- flanks: mirrors, handles, M gills, skirts ------------------------------------------------------------------------
  K.pair("paint", () => roundedBox(0.15, 0.10, 0.19, 0.045), 0.97, 1.05, 0.70, 0, 0.1, 0);
  K.pair("black", () => rod([0, 0, 0], [0.12, 0, 0.0], 0.02), 0.80, 1.01, 0.72);
  K.pair("chrome", () => roundedBox(0.012, 0.022, 0.16, 0.008), 0.95, 0.90, 0.15);
  K.pair("chrome", () => roundedBox(0.012, 0.022, 0.16, 0.008), 0.95, 0.92, -0.82);
  K.pair("gloss", () => roundedBox(0.02, 0.12, 0.26, 0.03), 0.955, 0.66, 0.98, 0, 0, 0);
  K.pair("carbon", () => roundedBox(0.06, 0.07, 1.86, 0.03), 0.93, 0.19, 0.0);

  // ---- tail: L-shaped lamps, boot spoiler, diffuser with four tailpipes, plate -------------------------------------------
  K.pair("tail", () => roundedBox(0.30, 0.075, 0.06, 0.025), 0.56, 0.96, -2.45, 0, 0.3, 0);
  K.pair("tail", () => roundedBox(0.12, 0.035, 0.04, 0.015), 0.37, 0.975, -2.475, 0, 0.1, 0);
  K.add("carbon", roundedBox(1.10, 0.03, 0.10, 0.012), 0, 1.09, -2.34, 0.25);
  K.add("carbon", roundedBox(1.70, 0.18, 0.12, 0.03), 0, 0.27, -2.43);
  for(const x of [0.47, 0.33]){
    K.pair("steel", () => new THREE.CylinderGeometry(0.048, 0.048, 0.12, 20).rotateX(Math.PI / 2), x, 0.28, -2.47);
    K.pair("black", () => new THREE.CylinderGeometry(0.036, 0.036, 0.122, 20).rotateX(Math.PI / 2), x, 0.28, -2.475);
  }
  K.add("plate", roundedBox(0.52, 0.12, 0.01, 0.006), 0, 0.66, -2.495);
  K.build(g);

  // ---- wheels: 20-inch Y-spoke rims, low-profile tyres, big discs and blue calipers --------------------------------------
  const wheel = (left) => {
    const wg = new THREE.Group(), KW = new Kit(M);
    KW.add("rubber", tyre(0.245, R, 0.27, 56));
    KW.add("rim", new THREE.TorusGeometry(0.248, 0.018, 10, 48).rotateY(Math.PI / 2), 0.10, 0, 0);
    KW.add("rim", new THREE.CylinderGeometry(0.055, 0.055, 0.06, 16).rotateZ(Math.PI / 2), 0.09, 0, 0);
    for(let i = 0; i < 5; i++){
      const a = i / 5 * Math.PI * 2;
      for(const d of [-0.12, 0.12]){
        KW.add("rim", rod([0.105, Math.cos(a) * 0.05, Math.sin(a) * 0.05], [0.115, Math.cos(a + d) * 0.24, Math.sin(a + d) * 0.24], 0.02, 0.014, 6));
      }
    }
    KW.add("steel", new THREE.CylinderGeometry(0.175, 0.175, 0.03, 36).rotateZ(Math.PI / 2), 0.0, 0, 0);
    KW.add("rim", new THREE.CylinderGeometry(0.235, 0.235, 0.01, 40).rotateZ(Math.PI / 2), 0.035, 0, 0);
    KW.build(wg);
    if(!left){ wg.scale.x = -1; }
    return wg;
  };
  const wheels = [], steerL = new THREE.Group(), steerR = new THREE.Group();
  for(const [x, z, front] of [[0.81, FZ, 1], [-0.81, FZ, 1], [0.81, RZ, 0], [-0.81, RZ, 0]]){
    const hold = front ? (x > 0 ? steerL : steerR) : new THREE.Group();
    hold.position.set(x, R, z);
    const w = wheel(x > 0); hold.add(w); g.add(hold); wheels.push(w);
    const cal = new THREE.Mesh(roundedBox(0.05, 0.16, 0.10, 0.02), M.caliper);
    cal.position.set(x - Math.sign(x) * 0.03, R + 0.12, z - 0.12); g.add(cal);
  }
  g.traverse(o => { if(o.isMesh){ o.castShadow = true; } });
  const anchors = {seat: new THREE.Vector3(0.38, 0.52, -0.35), wheel: new THREE.Vector3(0.38, 0.92, 0.18)};
  return {g, wheels, steerL, steerR, anchors, mats: M};
}
