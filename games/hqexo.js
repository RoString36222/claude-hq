/* Claude HQ: HQ Exosuit -- six flyable powered suits for the HQ and the City (original designs: armour types, not any
 * film suit).
 *
 * A suit is a layer of armour over your own character (games/avatar3d.js, the Kenney Mini Characters: a big head on a
 * short body, bones root / torso / head / arm-left / arm-right / leg-left / leg-right). Each piece is sized from the box
 * of the skin its bone carries, so it fits all six base models, and is skinned rigidly to that bone, merged per material
 * into at most 4 SkinnedMeshes on the avatar's own skeleton (paint as vertex colour, the finish on the material, the dark
 * undersuit, the glow, Abyss's glass dome): under 4k triangles (tests/test_hqexo.py). The avatar's clips keep running;
 * in the air pose() tilts and poses it after them.
 *
 *   FRAMES / PAINTS / FINISHES / GLOWS   the roster (index for index what presence `ex` carries)
 *   clean(o) -> {f, p, fin, g}           any input to a valid look       load() / save(o)   this browser (hq3d.exo)
 *   encode(o, m) / decode(a)             presence `ex` = [frame, paint, finish, glow, mode] (backend/src/valley/hq.rs)
 *                                        mode 1 suiting up, 2 on foot, 3 hover, 4 cruise, 5 boost, 6 swim
 *   wear(THREE, ch, o) -> bool           the armour onto character ch (ch._exo; ch._fly = {mode, speed, boost} flies it)
 *   strip(ch)                            and off again; stats(ch) -> {draws, tris} of the armour
 *   styleFor(f, where)                   the suit-up style: "gantry" (the Suit-Up Centre), "summon", "flow", "drop"
 *   seq(THREE, ch, style, opts) -> S     the suit-up: one mesh per piece flying home onto its bone (reverse: off, and
 *                                        strip at the end); seqStep(S, dt) -> {done, eyes 0..1, shake, lock, black}
 *   bay(c, w, x, z, ry) -> B             the lobby's Suit-Up Centre: the plate, two gantry arms, the customiser kiosk
 *   panel(onPick, onSuit) / panelOpen()  the customiser (frame, two-tone paint, finish, glow / HUD tint)
 *   wanted(key) / peer(u, ex) / sig(o)   who wears a suit: "you:*" and "peer:*"
 * Free: every frame, paint and finish from day one. Privacy: presence carries five small numbers.
 */
(function(){
"use strict";
var G = typeof window !== "undefined" ? window : globalThis;
var HQV = G.HQV = G.HQV || {};
var PI = Math.PI;

/* ---------- the roster (pure) ---------- */
// b bulk (plate size), sw shoulder width, h the suited character's scale (Bulwark 1.3x: a suit over the suit), x extras, up its suit-up style,
// paint / fin the look it comes in; st [speed, armour, agility, firepower] (the HUD and the flight read hqexoride's)
var FRAMES = [
  {id: "sentinel", n: "Sentinel", t: "All-rounder", up: "gantry", b: 1, sw: 1, h: 1, paint: 1, fin: 0, x: ["pack"], st: [65, 60, 65, 60],
   d: "The everyday suit. Good at everything, and a good first pick."},
  {id: "strider", n: "Strider", t: "Speed", up: "summon", b: 0.82, sw: 0.95, h: 1, paint: 2, fin: 0, x: ["fins"], st: [95, 35, 85, 45],
   d: "Built for speed: the fastest in a straight line, and it turns sharply."},
  {id: "bulwark", n: "Bulwark", t: "Giant buster", up: "drop", b: 1.9, sw: 1.55, h: 1.3, paint: 0, fin: 0, x: ["pack", "fists"], st: [25, 100, 15, 90],
   d: "A suit that goes over the suit. Too big for seats; its landings shake the street."},
  {id: "abyss", n: "Abyss", t: "Deep-sea", up: "flow", b: 1.25, sw: 1.1, h: 1, paint: 6, fin: 0, x: ["dome", "tanks"], st: [50, 70, 50, 40],
   d: "Swims and dives the ocean, and hovers slowly on land."},
  {id: "stratos", n: "Stratos", t: "High altitude", up: "summon", b: 0.95, sw: 1, h: 1, paint: 7, fin: 0, x: ["wings"], st: [90, 45, 60, 40],
   d: "Climbs above the clouds: no height cap, and long glides."},
  {id: "flux", n: "Flux", t: "Nanite", up: "flow", b: 0.88, sw: 0.98, h: 1, paint: 8, fin: 2, x: ["core"], st: [75, 55, 80, 70],
   d: "Liquid metal that flows into place from the chest core."}
];
var PAINTS = [["Crimson / gold", 0xa3202a, 0xd6a23c], ["Gunmetal / cyan", 0x3a434e, 0x7fd3ea], ["Racing silver / blue", 0xb9c2cc, 0x2f5fbf],
              ["Night", 0x1a1d22, 0x30343c], ["Olive / sand", 0x55603a, 0xb9a46a], ["Raw steel", 0x6c7076, 0x3c3f44],
              ["Abyss teal", 0x1f6f78, 0xe3b23c], ["Arctic", 0xe8eef3, 0x9aa9b6], ["Violet", 0x4b2c8f, 0xc9b2ff]];
var FINISHES = [["Gloss", 0.28, 0.55], ["Matte", 0.82, 0.12], ["Chrome", 0.08, 0.85], ["Carbon", 0.45, 0.35]];
var GLOWS = [["Cyan", 0x4fd8ff], ["Amber", 0xffb547], ["Lime", 0x9cff6a], ["Red", 0xff5a5a], ["White", 0xf2f6ff]];
var MODES = {suit: 1, foot: 2, hover: 3, cruise: 4, boost: 5, swim: 6}, MODE_MAX = 6, KEY = "hq3d.exo";
var UNDER = 0x1c2026;

function idx(v, n, d){ v = Math.floor(+v); return isFinite(v) && v >= 0 && v < n ? v : d; }
function clean(o){
  o = o && typeof o === "object" ? o : {};
  var f = typeof o.f === "string" ? FRAMES.map(function(F){ return F.id; }).indexOf(o.f) : o.f;
  f = idx(f, FRAMES.length, 0);
  return {f: f, p: idx(o.p, PAINTS.length, FRAMES[f].paint), fin: idx(o.fin, FINISHES.length, FRAMES[f].fin), g: idx(o.g, GLOWS.length, 0)};
}
function encode(o, m){ var c = clean(o); return [c.f, c.p, c.fin, c.g, idx(m, MODE_MAX + 1, 2) || 2]; }
function decode(a){
  if(!Array.isArray(a) || a.length !== 5 || !a.every(function(v){ return v === (v | 0); })) return null;
  if(a[0] < 0 || a[0] >= FRAMES.length || a[1] < 0 || a[1] >= PAINTS.length || a[2] < 0 || a[2] >= FINISHES.length ||
     a[3] < 0 || a[3] >= GLOWS.length || a[4] < 1 || a[4] > MODE_MAX) return null;
  return {f: a[0], p: a[1], fin: a[2], g: a[3], m: a[4]};
}
function sig(o){ if(!o) return ""; var c = clean(o); return "x" + [c.f, c.p, c.fin, c.g].join("."); }
function load(){ try { return clean(JSON.parse(G.localStorage.getItem(KEY) || "{}")); } catch(e){ return clean({}); } }
function save(o){ var c = clean(o); try { G.localStorage.setItem(KEY, JSON.stringify(c)); } catch(e){} return c; }
// gantry needs the Centre's arms; summon needs open sky: each falls back to the other
function styleFor(f, where){ var u = FRAMES[idx(f, FRAMES.length, 0)].up; return where === "bay" ? (u === "summon" ? "gantry" : u) : (u === "gantry" ? "summon" : u); }

/* ---------- fitting the avatar: its skeleton, and per bone the box of the skin that bone carries ---------- */
// The Kenney Mini Characters (games/avatar3d.js) all share one skeleton: root, torso, head, arm-left / arm-right (resting
// along +-X, a T-pose) and leg-left / leg-right; no elbows or knees. A piece is built in the body mesh's space from those
// boxes and skinned rigidly to its bone, so it follows every clip the avatar plays.
var NEED = ["root", "torso", "head", "arm-left", "arm-right", "leg-left", "leg-right"];
// female-a's boxes [x0, y0, z0, x1, y1, z1], for a bone whose skin can't be read
var DEF = {head: [-0.227, 0.343, -0.25, 0.227, 0.72, 0.2], torso: [-0.151, 0.176, -0.163, 0.151, 0.343, 0.105],
           "arm-left": [0.1, 0.2, -0.1, 0.384, 0.37, 0.107], "leg-left": [0.01, 0, -0.12, 0.155, 0.176, 0.103]};
function measure(T, o){
  var skins = [];
  o.traverse(function(n){ if(n.isSkinnedMesh && n.skeleton && n.geometry && n.geometry.attributes.skinIndex && !n.userData.exo) skins.push(n); });
  var body = skins.filter(function(n){ return /body/.test(n.name); })[0] || skins[0]; if(!body) return null;
  var sk = body.skeleton, bi = {};
  sk.bones.forEach(function(b, i){ if(bi[b.name] == null) bi[b.name] = i; });
  if(!NEED.every(function(n){ return bi[n] != null; })) return null;
  var toBody = new T.Matrix4().copy(body.bindMatrix).invert(), m = new T.Matrix4(), v = new T.Vector3(), box = {};
  skins.forEach(function(s){
    m.multiplyMatrices(toBody, s.bindMatrix);
    var P = s.geometry.attributes.position, I = s.geometry.attributes.skinIndex, W = s.geometry.attributes.skinWeight; if(!P || !W) return;
    for(var i = 0; i < P.count; i++){
      var best = -1, j = 0;
      for(var k = 0; k < 4; k++){ var w = W.getComponent(i, k); if(w > best){ best = w; j = I.getComponent(i, k); } }
      var bn = s.skeleton.bones[j]; if(!bn) continue;
      v.fromBufferAttribute(P, i).applyMatrix4(m); if(!isFinite(v.x + v.y + v.z)) continue;
      var b = box[bn.name] || (box[bn.name] = [1e9, 1e9, 1e9, -1e9, -1e9, -1e9]);
      b[0] = Math.min(b[0], v.x); b[1] = Math.min(b[1], v.y); b[2] = Math.min(b[2], v.z); b[3] = Math.max(b[3], v.x); b[4] = Math.max(b[4], v.y); b[5] = Math.max(b[5], v.z);
    }
  });
  function ok(b){ return b && b[3] - b[0] > 0.02 && b[4] - b[1] > 0.02 && b[5] - b[2] > 0.02 && b[3] - b[0] < 5 && b[4] - b[1] < 5; }
  // a limb as {i inner, o outer (|x|), y0, y1, z0, z1, s its side's sign}: the left one, else the right mirrored
  function limb(n){
    var L = box[n + "-left"], R = box[n + "-right"], b = ok(L) ? L : ok(R) ? [-R[3], R[1], R[2], -R[0], R[4], R[5]] : DEF[n + "-left"];
    var s = b[0] + b[3] >= 0 ? 1 : -1; if(!ok(L) && ok(R)) s = -s;
    var i = Math.min(Math.abs(b[0]), Math.abs(b[3])), oo = Math.max(Math.abs(b[0]), Math.abs(b[3]));
    return {i: i, o: oo, y0: b[1], y1: b[4], z0: b[2], z1: b[5], s: s};
  }
  var rest = {};
  NEED.forEach(function(n){ rest[n] = new T.Vector3().setFromMatrixPosition(m.copy(sk.boneInverses[bi[n]]).invert()).applyMatrix4(toBody); });
  return {body: body, sk: sk, bi: bi, head: ok(box.head) ? box.head : DEF.head, torso: ok(box.torso) ? box.torso : DEF.torso,
          arm: limb("arm"), leg: limb("leg"), rest: rest};
}
// the pieces, in the body mesh's space: [bone, shape, key ("A" paint, "B" second paint, "D" undersuit, "G" glow, "L" glass),
// x, y, z, rx, ry, rz, sx, sy, sz, grp]; shape ["r", w, h, d, seg] rounded box, ["b", w, h, d] box, ["s", r] sphere,
// ["y", r0, r1, h, seg] cylinder; grp orders the suit-up (boots first, the faceplate last)
function spec(F, M){
  var b = Math.min(F.b, 1.3), has = function(k){ return F.x.indexOf(k) >= 0; }, fist = has("fists") ? 1.6 : 1, P = [];
  function p(bone, shape, key, x, y, z, rx, ry, rz, sx, sy, sz, grp){ P.push([bone, shape, key, x, y, z, rx || 0, ry || 0, rz || 0, sx || 1, sy || 1, sz || 1, grp | 0]); }
  // the helmet: a rounded shell over the whole big head (a ponytail or a bun may peek out behind), its faceplate and eye slit
  var H = M.head, hx = (H[0] + H[3])/2, hw = H[3] - H[0], hh = Math.min(H[4] - H[1], hw*1.05), hd = Math.min(H[5] - H[2], hw*1.1),
      hz = H[5] - hd/2, hy = H[1] + hh/2, e = 0.03;
  p("head", ["r", hw + e, hh + e, hd + e, 14, 10], "A", hx, hy + e*0.3, hz + e*0.2, 0, 0, 0, 1, 1, 1, 7);
  p("head", ["r", hw*0.8, hh*0.42, 0.05], "B", hx, H[1] + hh*0.43, H[5] + e*0.55, 0, 0, 0, 1, 1, 1, 8);
  p("head", ["b", hw*0.6, 0.024, 0.012], "G", hx, H[1] + hh*0.48, H[5] + e*0.55 + 0.028, 0, 0, 0, 1, 1, 1, 8);
  p("head", ["r", 0.055, 0.05, hd*0.82, 6, 5], "B", hx, H[1] + hh + e*0.75, hz, 0, 0, 0, 1, 1, 1, 8);
  if(has("dome")) p("head", ["s", 0.5], "L", hx, hy + 0.01, hz + 0.01, 0, 0, 0, hw*1.3, hh*1.35, hd*1.3, 8);
  // the torso: a cuirass, the chest plate and its core, a belt; on the back the frame's pack, tanks or wings
  var Tb = M.torso, tw = Tb[3] - Tb[0], th = Tb[4] - Tb[1], td = Tb[5] - Tb[2], tz = (Tb[2] + Tb[5])/2, tf = Tb[5] + 0.02*b, cr = (has("core") ? 0.055 : 0.032)*tw/0.3;
  p("torso", ["r", tw + 0.04*b, th*0.9, td + 0.04*b, 12, 8], "A", 0, Tb[1] + th*0.56, tz, 0, 0, 0, 1, 1, 1, 3);
  p("torso", ["r", tw*0.62*b, th*0.36, 0.035, 8, 6], "B", 0, Tb[1] + th*0.64, tf, 0, 0, 0, 1, 1, 1, 3);
  p("torso", ["y", cr, cr, 0.03, 16], "G", 0, Tb[1] + th*0.66, tf + 0.026, PI/2, 0, 0, 1, 1, 1, 3);
  p("torso", ["b", tw + 0.06*b, 0.035, td + 0.06*b], "D", 0, Tb[1] + 0.02, tz, 0, 0, 0, 1, 1, 1, 2);
  if(has("pack")) p("torso", ["r", tw*0.8*b, th*0.85, 0.09*b, 8, 6], "D", 0, Tb[1] + th*0.55, Tb[2] - 0.04*b, 0, 0, 0, 1, 1, 1, 6);
  // the limbs, each side mirrored: s is the side's sign along X
  var A = M.arm, al = A.o - A.i, ah = A.y1 - A.y0, ad = A.z1 - A.z0, ay = (A.y0 + A.y1)/2, az = (A.z0 + A.z1)/2;
  var Lg = M.leg, lw = Lg.o - Lg.i, lh = Lg.y1 - Lg.y0, ld = Lg.z1 - Lg.z0, lx = (Lg.i + Lg.o)/2, lz = (Lg.z0 + Lg.z1)/2;
  [["left", A.s, Lg.s], ["right", -A.s, -Lg.s]].forEach(function(q){
    var n = q[0], s = q[1], t = q[2];
    p("leg-" + n, ["r", lw + 0.035*b, lh*0.42, ld + 0.05*b, 8, 6], "B", t*lx, Lg.y0 + lh*0.21, lz + 0.012, 0, 0, 0, 1, 1, 1, 0);       // boots
    p("leg-" + n, ["r", lw + 0.024*b, lh*0.42, ld*0.9 + 0.022*b, 8, 6], "A", t*lx, Lg.y0 + lh*0.62, lz + 0.006, 0, 0, 0, 1, 1, 1, 1);  // shins
    if(has("fins")) p("leg-" + n, ["b", 0.012, lh*0.6, ld*0.85], "B", t*(Lg.o + 0.018*b), Lg.y0 + lh*0.58, lz - ld*0.15, -0.3, 0, 0, 1, 1, 1, 1);
    p("arm-" + n, ["r", al*0.36, ah*0.62*b, ad + 0.05*b, 8, 6], "B", s*(A.i + al*0.17), A.y1 + ah*0.02, az, 0, 0, -s*0.25, 1, 1, 1, 4); // shoulder pads
    p("arm-" + n, ["r", al*0.42, ah + 0.022*b, ad + 0.022*b, 8, 6], "A", s*(A.i + al*0.66), ay, az, 0, 0, 0, 1, 1, 1, 5);               // forearm gauntlets
    if(has("fists")) p("arm-" + n, ["r", al*0.24*fist, ah*1.3, ad*1.25, 8, 6], "B", s*(A.o - al*0.1), ay, az, 0, 0, 0, 1, 1, 1, 5);
    p("arm-" + n, ["s", 0.016*fist], "G", s*(A.o + 0.006), ay, az, 0, 0, 0, 1, 1, 1, 5);                                                // palm emitters
    if(has("wings")) p("torso", ["b", tw*1.4, 0.016, td*0.55], "B", s*tw*0.8, Tb[1] + th*0.82, Tb[2] - 0.03, 0, -s*0.2, s*0.35, 1, 1, 1, 6);
    if(has("tanks")) p("torso", ["y", 0.038*tw/0.3, 0.038*tw/0.3, th*1.05, 10], "B", s*tw*0.22, Tb[1] + th*0.55, Tb[2] - 0.035, 0, 0, 0, 1, 1, 1, 6);
  });
  return P;
}
function sp(c){ return (c < 0 ? -1 : 1)*Math.pow(Math.abs(c), 0.42); }
function shape(T, s){
  if(s[0] === "r"){
    var g = new T.SphereGeometry(1, s[4] || 10, s[5] || 7), a = g.attributes.position;
    for(var i = 0; i < a.count; i++) a.setXYZ(i, sp(a.getX(i))*s[1]/2, sp(a.getY(i))*s[2]/2, sp(a.getZ(i))*s[3]/2);
    g.computeVertexNormals(); return g;
  }
  if(s[0] === "s") return new T.SphereGeometry(s[1], s[1] < 0.03 ? 8 : 16, s[1] < 0.03 ? 6 : 12);
  if(s[0] === "b") return new T.BoxGeometry(s[1], s[2], s[3]);
  return new T.CylinderGeometry(s[1], s[2], s[3], s[4] || 12);
}
function local(T, q){
  return new T.Matrix4().compose(new T.Vector3(q[3], q[4], q[5]), new T.Quaternion().setFromEuler(new T.Euler(q[6], q[7], q[8])), new T.Vector3(q[9], q[10], q[11]));
}
function colOf(key, o){ var P = PAINTS[o.p]; return key === "A" ? P[1] : key === "B" ? P[2] : key === "D" ? UNDER : key === "L" ? 0xbfe8ff : 0xffffff; }
function mats(T, o){
  var Fi = FINISHES[o.fin], gl = GLOWS[o.g][1];
  return {
    A: new T.MeshStandardMaterial({vertexColors: true, roughness: Fi[1], metalness: Fi[2]}),
    D: new T.MeshStandardMaterial({color: UNDER, roughness: 0.6, metalness: 0.45}),
    G: new T.MeshStandardMaterial({color: gl, emissive: gl, emissiveIntensity: 2.2, toneMapped: false}),
    L: new T.MeshStandardMaterial({color: 0xbfe8ff, roughness: 0.05, metalness: 0.1, transparent: true, opacity: 0.38, depthWrite: false})
  };
}
var MAT_OF = {A: "A", B: "A", D: "D", G: "G", L: "L"};

/* ---------- wearing it: the armour layer on your own character ---------- */
// wear(T, ch, look) -> true when it fits (ch from games/avatar3d.js, or any body with a skinned Kenney skeleton). The
// pieces merge per material into at most 4 SkinnedMeshes beside the body's skin, bound to its skeleton; the headwear on
// the head bone (a halo, a cap, glasses) hides under the helmet; Bulwark makes the whole character 1.3x (ch.base).
// ch.update runs the avatar's own first, then pose() (flight). strip(ch) undoes all of it.
function wear(T, ch, o0){
  if(!ch || !ch.o) return false;
  if(ch._exo) strip(ch);
  ch.o.updateMatrixWorld(true);
  var M = measure(T, ch.o); if(!M) return false;
  var o = clean(o0), F = FRAMES[o.f], P = spec(F, M), MT = mats(T, o), acc = {}, body = M.body;
  P.forEach(function(q){
    var geo = shape(T, q[1]), k = MAT_OF[q[2]], bi = M.bi[q[0]], gg = geo.index ? geo.toNonIndexed() : geo;
    gg.applyMatrix4(local(T, q));
    var a = acc[k] || (acc[k] = {pos: [], nor: [], col: [], si: [], sw: []}), c = new T.Color(colOf(q[2], o));
    var pp = gg.attributes.position.array, nn = gg.attributes.normal.array;
    for(var i = 0; i < pp.length; i += 3){ a.pos.push(pp[i], pp[i + 1], pp[i + 2]); a.nor.push(nn[i], nn[i + 1], nn[i + 2]); a.col.push(c.r, c.g, c.b); a.si.push(bi, 0, 0, 0); a.sw.push(1, 0, 0, 0); }
    if(gg !== geo) gg.dispose(); geo.dispose();
  });
  var meshes = [];
  ["A", "D", "G", "L"].forEach(function(k){
    var a = acc[k]; if(!a){ MT[k].dispose(); delete MT[k]; return; }
    var geo = new T.BufferGeometry();
    geo.setAttribute("position", new T.Float32BufferAttribute(a.pos, 3)); geo.setAttribute("normal", new T.Float32BufferAttribute(a.nor, 3));
    geo.setAttribute("color", new T.Float32BufferAttribute(a.col, 3));
    geo.setAttribute("skinIndex", new T.Uint16BufferAttribute(a.si, 4)); geo.setAttribute("skinWeight", new T.Float32BufferAttribute(a.sw, 4));
    var me = new T.SkinnedMesh(geo, MT[k]); me.name = "exo-" + k; me.userData.exo = 1; me.frustumCulled = false; me.castShadow = k !== "L";
    me.position.copy(body.position); me.quaternion.copy(body.quaternion); me.scale.copy(body.scale);
    (body.parent || ch.o).add(me); me.bind(M.sk, body.bindMatrix); meshes.push(me);
  });
  // under the helmet: whatever rides the head bone (avatar3d's headwear, halo, glasses, crest)
  var head = M.sk.bones[M.bi.head], hid = [];
  head.children.forEach(function(c){ if(!c.isBone && !c.userData.exo){ hid.push([c, c.visible]); c.visible = false; } });
  var rest = {}; NEED.forEach(function(n){ var bn = M.sk.bones[M.bi[n]]; rest[n] = {q: bn.quaternion.clone(), p: bn.position.clone()}; });
  var s0 = ch.base || ch.o.scale.x || 1;
  ch._exo = {look: o, frame: F, mats: MT, meshes: meshes, spec: P, M: M, hid: hid, rest: rest, s0: s0, s1: s0*F.h, up: ch.update, tilt: false,
             q: new T.Quaternion(), q2: new T.Quaternion(), e: new T.Euler(), v: new T.Vector3(), v2: new T.Vector3()};
  ch.base = s0*F.h; ch.o.scale.setScalar(ch.base);
  var up = ch._exo.up;
  ch.update = function(t){ if(up) up(t); pose(ch, t); };
  return true;
}
function strip(ch){
  var X = ch && ch._exo; if(!X) return;
  X.meshes.forEach(function(m){ if(m.parent) m.parent.remove(m); m.geometry.dispose(); });
  for(var k in X.mats) X.mats[k].dispose();
  X.hid.forEach(function(h){ h[0].visible = h[1]; });
  if(X.tilt) unTilt(X);
  ch.update = X.up; if(!X.up) delete ch.update;
  ch.base = X.s0; ch.o.scale.setScalar(X.s0);
  ch._exo = null; ch._fly = null;
}
function stats(ch){
  var tris = 0, draws = 0;
  (ch && ch._exo ? ch._exo.meshes : []).forEach(function(m){ if(m.visible){ draws++; tris += (m.geometry.index ? m.geometry.index.count : m.geometry.attributes.position.count)/3; } });
  return {tris: tris, draws: draws};
}

/* ---------- flight poses, put on after the avatar's clips (on foot its own idle / walk / sprint / sit carry on) ----------
   rest arms lie along +-X: a Z turn hangs them, an X turn swings them (+ forward); legs swing on X */
function fin(v){ v = +v; return isFinite(v) ? v : 0; }
function bone(X, n){ return X.M.sk.bones[X.M.bi[n]]; }
function turn(X, n, x, y, z){ var b = bone(X, n); X.e.set(x, y, z); b.quaternion.copy(X.rest[n].q).multiply(X.q.setFromEuler(X.e)); }
function arm(X, n, s, swing, out){ turn(X, "arm-" + n, -swing, 0, -s*(PI/2 - out)); }
function unTilt(X){ var r = bone(X, "root"); r.quaternion.copy(X.rest.root.q); r.position.copy(X.rest.root.p); X.tilt = false; }
function pose(ch, t){
  var X = ch && ch._exo; if(!X) return;
  var fl = ch._fly, m = fl ? fl.mode : null;
  if(m !== "hover" && m !== "cruise" && m !== "swim"){ if(X.tilt) unTilt(X); return; }
  var E = HQV.engine, calm = !!(E && E.calm && E.calm()), t1 = fin(t), t0 = X.t, bob = calm ? 0 : Math.sin(t1*2.1);
  X.t = t1; var dt = t0 == null ? 0 : Math.max(0, Math.min(0.1, t1 - t0)); if(calm) dt = 0;
  var sa = X.M.arm.s, sl = X.M.leg.s;
  NEED.forEach(function(n){ bone(X, n).quaternion.copy(X.rest[n].q); });
  // pitched about the hips (the torso bone), not the feet, so the body lies along its flight
  var k = m === "hover" ? 0 : m === "swim" ? 1 : Math.max(0.35, Math.min(1, fin(fl.speed)/30)), al = m === "swim" ? PI/2 : m === "hover" ? 0.08 : 1.3*k;
  var r = bone(X, "root"), h = X.v.copy(bone(X, "torso").position).multiply(r.scale);
  X.q2.setFromAxisAngle(X.v2.set(1, 0, 0), al).multiply(X.rest.root.q);
  r.quaternion.copy(X.q2);
  r.position.copy(X.rest.root.p).add(X.v2.copy(h).applyQuaternion(X.rest.root.q)).sub(h.applyQuaternion(X.q2));
  X.tilt = true;
  if(m === "hover"){
    arm(X, "left", sa, 0.1, 0.38 + bob*0.04); arm(X, "right", -sa, 0.1, 0.38 - bob*0.04);
    turn(X, "leg-left", -0.12 - bob*0.03, 0, sl*0.06); turn(X, "leg-right", -0.04 + bob*0.03, 0, -sl*0.06); turn(X, "head", 0.05, 0, 0);
  } else if(m === "swim"){
    X.ph = ((X.ph || 0) + dt*0.7) % 1; var spn = Math.sin(X.ph*2*PI), kick = calm ? 0 : Math.sin(t1*7);
    arm(X, "left", sa, 2.4 - spn*0.9, 0.5 + spn*0.4); arm(X, "right", -sa, 2.4 - spn*0.9, 0.5 + spn*0.4);
    turn(X, "leg-left", -kick*0.25, 0, 0); turn(X, "leg-right", kick*0.25, 0, 0); turn(X, "head", -1.0, 0, 0);
  } else {
    var back = fl.boost ? 0.6 : 0.3, out = fl.boost ? 0.06 : 0.2;
    arm(X, "left", sa, -back, out); arm(X, "right", -sa, -back, out);
    turn(X, "leg-left", 0.05 + bob*0.03, 0, sl*0.04); turn(X, "leg-right", 0.05 - bob*0.03, 0, -sl*0.04); turn(X, "head", -0.95*k, 0, 0);
  }
}

/* ---------- the suit-up: every piece its own mesh, flying from `from` onto its bone on your posed body ---------- */
function rnd(i, f){ var x = Math.sin(i*91.7 + f*13.1)*43758.5; return x - Math.floor(x); }
function ease(x){ var c = 1.6; return 1 + (c + 1)*Math.pow(x - 1, 3) + c*Math.pow(x - 1, 2); }
// where a piece (built in the body mesh's space) sits now, in ch.o's frame: bone * boneInverse * bindMatrix
function home(S, p, out){
  var M = S.ch._exo.M, i = M.bi[p.bone];
  return out.copy(S.inv).multiply(M.sk.bones[i].matrixWorld).multiply(M.sk.boneInverses[i]).multiply(M.body.bindMatrix);
}
function seq(T, ch, style, opts){
  opts = opts || {};
  var X = ch._exo, o = X.look, g = new T.Group(), parts = [], dur = 0, M = X.mats;
  ch.o.updateMatrixWorld(true);
  var S = {g: g, ch: ch, parts: parts, style: style, t: 0, rev: !!opts.reverse, done: false, m4: new T.Matrix4(), inv: new T.Matrix4().copy(ch.o.matrixWorld).invert(),
           q: new T.Quaternion(), q1: new T.Quaternion(), e: new T.Euler(), v: new T.Vector3(), s: new T.Vector3(), T: T};
  X.spec.forEach(function(q, i){
    var geo = shape(T, q[1]); geo.applyMatrix4(local(T, q));
    var c = new T.Color(colOf(q[2], o)), n = geo.attributes.position.count, ca = new Float32Array(n*3);
    for(var j = 0; j < n; j++){ ca[3*j] = c.r; ca[3*j + 1] = c.g; ca[3*j + 2] = c.b; }
    geo.setAttribute("color", new T.BufferAttribute(ca, 3));
    var me = new T.Mesh(geo, M[MAT_OF[q[2]]]); me.matrixAutoUpdate = false; me.frustumCulled = false; g.add(me);
    var pc = {m: me, bone: q[0], flow: 0, spin: 0}, hm = home(S, pc, new T.Matrix4());
    var hp = new T.Vector3(q[3], q[4], q[5]).applyMatrix4(hm), s = Math.sign(q[3]) || (rnd(i, o.f) < 0.5 ? -1 : 1), gr = q[12];
    pc.hp = hp;
    // offsets in the character's own (unscaled, ~0.8 tall) frame
    if(style === "gantry"){ pc.from = new T.Vector3(s*0.7, -0.5 + gr*0.02, -0.15); pc.del = gr*0.3 + rnd(i, o.f)*0.06; pc.d = 0.55; pc.spin = 1.2; }
    else if(style === "summon"){ var an = rnd(i, o.f)*6.28; pc.from = new T.Vector3(Math.cos(an)*6, 3 + rnd(i + 3, o.f)*4, Math.sin(an)*6); pc.del = gr*0.22 + rnd(i, o.f)*0.15; pc.d = 0.7; pc.spin = 4; }
    else if(style === "drop"){ pc.from = new T.Vector3(0, 13, 0); pc.del = gr*0.32; pc.d = 0.45; }
    else { pc.flow = 1; pc.del = hp.distanceTo(new T.Vector3(0, 0.3, 0.1))*3.2; pc.d = 0.5; }
    dur = Math.max(dur, pc.del + pc.d); parts.push(pc);
  });
  S.dur = dur + 0.45;
  X.meshes.forEach(function(m){ m.visible = false; });
  if(M.G) M.G.emissiveIntensity = 0;
  ch.o.add(g);
  scaleTo(S, S.rev ? 1 : 0);
  return S;
}
// Bulwark grows into its 1.3x while it suits up (and shrinks back taking it off)
function scaleTo(S, k){ var X = S.ch._exo; if(!X || X.s1 === X.s0) return; var s = X.s0 + (X.s1 - X.s0)*Math.max(0, Math.min(1, k)); S.ch.o.scale.setScalar(s); S.ch.base = s; }
function seqStep(S, dt){
  var out = {done: false, eyes: 0, shake: 0, lock: null, black: false, k: 0};
  if(!S || S.done || !S.ch._exo){ out.done = true; if(S && !S.done) seqEnd(S); return out; }
  S.t += Math.max(0, Math.min(0.1, fin(dt)));
  var t = S.rev ? Math.max(0, (S.dur - 0.45)*(1 - S.t/0.9)) : S.t;           // off: the build run backwards, fast
  S.ch.o.updateMatrixWorld(true); S.inv.copy(S.ch.o.matrixWorld).invert();
  S.parts.forEach(function(p){
    var k = Math.max(0, Math.min(1, (t - p.del)/p.d)), e = S.style === "drop" ? (k < 1 ? k*k : 1) : ease(k);
    p.m.visible = k > 0;
    home(S, p, S.m4);
    if(p.flow){ var sc = Math.max(0.001, ease(k)); S.m4.scale(S.v.set(sc, sc, sc)); p.m.matrix.copy(S.m4); }
    else {
      S.m4.decompose(S.v, S.q, S.s); var f = 1 - e;
      S.v.addScaledVector(p.from, f); S.e.set(f*p.spin, f*p.spin*1.3, 0); S.q.multiply(S.q1.setFromEuler(S.e));
      p.m.matrix.compose(S.v, S.q, S.s);
    }
    if(k >= 1 && !p.done && !S.rev){ p.done = 1; out.lock = p.hp.clone().applyMatrix4(S.ch.o.matrix); out.shake = Math.max(out.shake, S.style === "drop" ? 0.35 : 0.04); }
    if(k < 1) p.done = 0;
  });
  out.k = Math.min(1, S.t/(S.rev ? 0.9 : S.dur));
  scaleTo(S, S.rev ? 1 - out.k : out.k*1.6);
  var end = S.rev ? 0.9 : S.dur, G = S.ch._exo.mats.G;
  if(!S.rev){ out.eyes = Math.max(0, Math.min(1, (S.t - (S.dur - 0.3))/0.3)); if(G) G.emissiveIntensity = 2.2*out.eyes; }
  if(S.t >= end) seqEnd(S), out.done = true;
  return out;
}
// the end (or Esc): forward, the merged armour shows; reverse, the layer comes off
function seqEnd(S){
  if(!S || S.done) return; S.done = true;
  if(S.g.parent) S.g.parent.remove(S.g);
  S.g.children.forEach(function(m){ m.geometry.dispose(); });
  var X = S.ch._exo; if(!X) return;
  if(S.rev){ strip(S.ch); return; }
  scaleTo(S, 1);
  X.meshes.forEach(function(m){ m.visible = true; }); if(X.mats.G) X.mats.G.emissiveIntensity = 2.2;
}

/* ---------- the Suit-Up Centre (games/hqlobby.js): a plate, two gantry arms, the customiser kiosk ---------- */
function bay(c, w, x, z, ry){
  var T = c.THREE, g = new T.Group(); g.position.set(x, 0, z); g.rotation.y = ry || 0; w.scene.add(g);
  var steel = c.mat(0x56606b, {metalness: 0.75, roughness: 0.35}), dark = c.mat(0x1d2128, {metalness: 0.5}), glowM = c.emis(0x0d1a24, 0x4fd8ff, 1.8);
  c.cyl(1.1, 1.2, 0.12, steel, 0, 0.06, 0, g, 40); c.cyl(0.95, 0.95, 0.02, glowM, 0, 0.13, 0, g, 40);       // the plate and its ring
  var arms = [-1, 1].map(function(s){
    var post = new T.Group(); post.position.set(s*1.9, 0, -0.4); g.add(post);
    c.box(0.35, 3.2, 0.35, dark, 0, 1.6, 0, post);
    var boom = new T.Group(); boom.position.y = 1.2; post.add(boom);
    c.box(1.2, 0.18, 0.22, steel, -s*0.55, 0, 0, boom); c.box(0.12, 0.4, 0.3, glowM, -s*1.15, -0.15, 0, boom);
    return boom;
  });
  c.box(3.9, 0.25, 0.35, dark, 0, 3.25, -0.4, g);                                                           // the gantry's beam
  var kt = c.canvasTex(256, 192, function(gg){ gg.fillStyle = "#06111a"; gg.fillRect(0, 0, 256, 192); gg.fillStyle = "#4fd8ff"; gg.font = "700 26px system-ui, sans-serif";
    gg.textAlign = "center"; gg.fillText("SUIT-UP CENTRE", 128, 46); gg.fillStyle = "#e8eef3"; gg.font = "500 17px system-ui, sans-serif"; gg.fillText("F  frame, paint, finish", 128, 92);
    gg.fillText("F on the plate: suit up / off", 128, 118); FRAMES.forEach(function(F, i){ gg.fillStyle = "#" + ("00000" + PAINTS[F.paint][1].toString(16)).slice(-6); gg.fillRect(36 + i*32, 140, 24, 24); }); });
  var kg = new T.Group(); kg.position.set(2.6, 0, 1.2); kg.rotation.y = -0.6; g.add(kg);
  c.cyl(0.08, 0.14, 1.2, c.mat(0x3a4652, {metalness: 0.7}), 0, 0.6, 0, kg, 10);
  var kp = c.screen(0.68, 0.48, kt.t); kp.position.set(0, 1.42, 0.04); kp.rotation.x = -0.5; kg.add(kp);
  c.box(0.75, 0.55, 0.06, dark, 0, 1.4, 0, kg).rotation.x = -0.5;
  if(c.label){ var tag = c.label("Suit-Up Centre", "#4fd8ff", 0.5); tag.position.set(0, 3.9, -0.4); g.add(tag); }
  g.updateMatrixWorld(true);
  var kw = new T.Vector3(2.6, 0, 1.2).applyMatrix4(g.matrixWorld), pw = new T.Vector3(0, 0, 0).applyMatrix4(g.matrixWorld);
  var B = {g: g, plate: pw, kiosk: kw, busy: 0,
    near: function(p){ if(!p) return null; if(Math.hypot(p.x - pw.x, p.z - pw.z) < 1.3) return "plate"; if(Math.hypot(p.x - kw.x, p.z - kw.z) < 1.6) return "kiosk"; return null; },
    blocked: function(px, pz){ var lx = px - x, lz = pz - z; return Math.hypot(lx - (kw.x - x), lz - (kw.z - z)) < 0.45 ||
      [-1, 1].some(function(s){ var a = new T.Vector3(s*1.9, 0, -0.4).applyMatrix4(g.matrixWorld); return Math.abs(px - a.x) < 0.4 && Math.abs(pz - a.z) < 0.4; }); },
    prompt: function(p){ var n = B.near(p); return n === "plate" ? "F  " + (HQV.hqExo.me && HQV.hqExo.me.on ? "Suit off" : "Suit up") : n === "kiosk" ? "F  Customise your suit" : null; },
    // the arms swing in while a gantry suit-up runs (k 0..1), and rest folded back
    update: function(t, dt){ var k = B.busy > 0 ? Math.sin(Math.min(1, B.busy)*PI) : 0; arms.forEach(function(a, i){ var s = i ? 1 : -1; a.rotation.y = s*(0.9 - 0.9*k); a.position.y = 1.2 + 0.4*k*Math.sin(t*3); });
      glowM.emissiveIntensity = 1.2 + 0.6*Math.sin(t*2); }};
  HQV.hqExo.bayRef = B;
  return B;
}

/* ---------- the customiser (DOM; hq3d keeps the keys off you while it is open) ---------- */
var PANEL = null;
function hex(n){ return "#" + ("00000" + (n >>> 0).toString(16)).slice(-6); }
function panel(look, onPick, onSuit){
  var doc = G.document; if(!doc) return null;
  panelClose();
  var cur = clean(look), el = doc.createElement("div");
  el.className = "hqs hqexo-panel";
  el.style.cssText = "position:fixed;right:16px;top:72px;z-index:99;width:min(340px,calc(100vw - 32px));max-height:calc(100vh - 100px);overflow:auto;" +
    "background:rgba(8,14,20,.94);color:#e8eef3;border:1px solid #2b3b4a;border-radius:10px;padding:12px 14px;font:13px system-ui,sans-serif;box-shadow:0 8px 30px rgba(0,0,0,.5)";
  function row(title, list, key, sw){
    var h = "<div style=\"margin:10px 0 4px;font-weight:600;color:#9fb3c4\">" + title + "</div><div style=\"display:flex;flex-wrap:wrap;gap:6px\">";
    list.forEach(function(it, i){
      var on = cur[key] === i, st = "cursor:pointer;border-radius:6px;padding:4px 8px;border:1px solid " + (on ? "#4fd8ff" : "#2b3b4a") + ";background:" + (on ? "#12303d" : "#101a22") + ";color:#e8eef3";
      var face = sw ? "<span style=\"display:inline-block;width:12px;height:12px;border-radius:3px;vertical-align:-2px;margin-right:5px;background:" + hex(it[1]) + "\"></span>" +
        (it[2] != null && key === "p" ? "<span style=\"display:inline-block;width:12px;height:12px;border-radius:3px;vertical-align:-2px;margin-right:5px;background:" + hex(it[2]) + "\"></span>" : "") : "";
      h += "<button type=\"button\" data-k=\"" + key + "\" data-i=\"" + i + "\" aria-pressed=\"" + on + "\" style=\"" + st + "\">" + face + (it.n || it[0]) + "</button>";
    });
    return h + "</div>";
  }
  function draw(){
    var F = FRAMES[cur.f];
    el.innerHTML = "<div style=\"display:flex;justify-content:space-between;align-items:center\"><b style=\"font-size:15px\">Suit-Up Centre</b>" +
      "<button type=\"button\" data-x=\"close\" aria-label=\"Close\" style=\"background:none;border:0;color:#9fb3c4;font-size:18px;cursor:pointer\">×</button></div>" +
      row("Frame", FRAMES, "f", false) +
      "<div style=\"margin-top:8px;color:#c9d6e2\"><b>" + F.n + "</b> · " + F.t + "<br><span style=\"color:#9fb3c4\">" + F.d + "</span></div>" +
      "<div style=\"display:grid;grid-template-columns:70px 1fr;gap:3px 8px;margin-top:6px;font-size:12px\">" + ["Speed", "Armour", "Agility", "Power"].map(function(k, i){
        return "<span>" + k + "</span><span style=\"background:#1a2630;border-radius:3px;height:8px;margin-top:4px\"><i style=\"display:block;height:8px;border-radius:3px;background:#4fd8ff;width:" + F.st[i] + "%\"></i></span>"; }).join("") + "</div>" +
      row("Paint", PAINTS, "p", true) + row("Finish", FINISHES, "fin", false) + row("Glow and HUD tint", GLOWS, "g", true) +
      "<button type=\"button\" data-x=\"suit\" style=\"margin-top:12px;width:100%;padding:8px;border-radius:7px;border:0;background:#4fd8ff;color:#05121a;font-weight:700;cursor:pointer\">" +
      (HQV.hqExo.me && HQV.hqExo.me.on ? "Apply to my suit" : "Suit up") + "</button><div style=\"margin-top:6px;font-size:11px;color:#7f93a4\">Free: every frame, paint and finish. Esc closes.</div>";
  }
  el.addEventListener("click", function(e){
    var b = e.target.closest ? e.target.closest("button") : null; if(!b) return;
    if(b.getAttribute("data-x") === "close"){ panelClose(); return; }
    if(b.getAttribute("data-x") === "suit"){ panelClose(); if(onSuit) onSuit(cur); return; }
    var k = b.getAttribute("data-k"); if(!k) return;
    cur[k] = +b.getAttribute("data-i");
    if(k === "f"){ cur.p = FRAMES[cur.f].paint; cur.fin = FRAMES[cur.f].fin; }
    cur = save(cur); draw(); if(onPick) onPick(cur);
  });
  draw(); doc.body.appendChild(el); PANEL = el;
  return el;
}
function panelOpen(){ return !!(PANEL && PANEL.parentNode); }
function panelClose(){ if(PANEL && PANEL.parentNode) PANEL.parentNode.removeChild(PANEL); PANEL = null; }

/* ---------- whose body is a suit (games/hq3d.js makeCharacter) ---------- */
var PEERS = {};
var me = {on: false, look: load(), mode: 2};
function peer(u, ex){ var d = decode(ex); if(d) PEERS[u] = d; else delete PEERS[u]; return d; }
function wanted(key){
  key = String(key || "");
  if(key.indexOf("you:") === 0) return me.on ? me.look : null;
  if(key.indexOf("peer:") === 0){ var d = PEERS[key.slice(5)]; return d || null; }
  return null;
}

HQV.hqExo = {FRAMES: FRAMES, PAINTS: PAINTS, FINISHES: FINISHES, GLOWS: GLOWS, MODES: MODES, BONES: NEED, clean: clean, encode: encode,
  decode: decode, sig: sig, load: load, save: save, styleFor: styleFor, wear: wear, strip: strip, stats: stats, pose: pose, measure: measure,
  seq: seq, seqStep: seqStep, seqEnd: seqEnd, bay: bay, panel: panel, panelOpen: panelOpen, panelClose: panelClose,
  peer: peer, wanted: wanted, me: me, bayRef: null, hex: hex};
})();
