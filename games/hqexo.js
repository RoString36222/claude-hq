/* Claude HQ: HQ Exosuit -- six flyable powered suits for the HQ and the City (original designs: armour types, not any
 * film suit).
 *
 * A suit is a layer of armour over your own character (games/avatar3d.js, the Kenney Mini Characters: a big head on a
 * short body, bones root / torso / head / arm-left / arm-right / leg-left / leg-right). Each piece is sized from the box
 * of the skin its bone carries, so it fits all six base models, and is skinned rigidly to that bone, merged per material
 * into at most 4 SkinnedMeshes on the avatar's own skeleton (paint as vertex colour, the finish on the material, the dark
 * undersuit, the glow, Abyss's glass dome): under 4k triangles (tests/test_hqexo.py). The avatar's clips keep running;
 * in the air pose() blends a flight pose over them (lean, bank, climb, crouch) and lights the thrusters (two more draws).
 *
 *   FRAMES / PAINTS / FINISHES / GLOWS   the roster (index for index what presence `ex` carries)
 *   clean(o) -> {f, p, fin, g}           any input to a valid look       load() / save(o)   this browser (hq3d.exo)
 *   encode(o, m) / decode(a)             presence `ex` = [frame, paint, finish, glow, mode] (backend/src/valley/hq.rs)
 *                                        mode 1 suiting up, 2 on foot, 3 hover, 4 cruise, 5 boost, 6 swim
 *   wear(THREE, ch, o) -> bool           the armour onto character ch (ch._exo; ch._fly = {mode, speed, boost} flies it)
 *   strip(ch)                            and off again; stats(ch) -> {draws, tris} of the armour, fx the thrusters' draws
 *   pose(ch, t) / targets(fl) / bankFor(turn, speed)   the flight pose (after the clips), its pure targets, the bank
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
// x, y, z, rx, ry, rz, sx, sy, sz, grp, kind]; shape ["r", w, h, d, seg] rounded box, ["b", w, h, d] box, ["s", r] sphere,
// ["y", r0, r1, h, seg] cylinder, ["t", R, tube, seg] ring; grp orders the suit-up (boots first, the faceplate last); kind
// tells the armour shader (ARM_FS) which plate it is: its panel lines, trim and the frame's decal (KIND)
var KIND = {plain: 0, helmet: 1, face: 2, cuirass: 3, chest: 4, boot: 5, shin: 6, shoulder: 7, gauntlet: 8, pack: 9};
function spec(F, M){
  var b = Math.min(F.b, 1.3), has = function(k){ return F.x.indexOf(k) >= 0; }, fist = has("fists") ? 1.6 : 1, P = [], K = KIND;
  function p(bone, shape, key, x, y, z, rx, ry, rz, sx, sy, sz, grp, kind){ P.push([bone, shape, key, x, y, z, rx || 0, ry || 0, rz || 0, sx || 1, sy || 1, sz || 1, grp | 0, kind | 0]); }
  // the helmet: a rounded shell over the whole big head (a ponytail or a bun may peek out behind), its faceplate, two
  // slanted eye lenses where the character's own eyes are, a crest and an ear vent each side
  var H = M.head, hx = (H[0] + H[3])/2, hw = H[3] - H[0], hh = Math.min(H[4] - H[1], hw*1.05), hd = Math.min(H[5] - H[2], hw*1.1),
      hz = H[5] - hd/2, hy = H[1] + hh/2, e = 0.03, fz = H[5] + e*0.55;
  p("head", ["r", hw + e, hh + e, hd + e, 14, 10], "A", hx, hy + e*0.3, hz + e*0.2, 0, 0, 0, 1, 1, 1, 7, K.helmet);
  p("head", ["r", hw*0.8, hh*0.42, 0.05], "B", hx, H[1] + hh*0.43, fz, 0, 0, 0, 1, 1, 1, 8, K.face);
  p("head", ["r", 0.055, 0.05, hd*0.82, 6, 5], "B", hx, H[1] + hh + e*0.75, hz, 0, 0, 0, 1, 1, 1, 8, K.helmet);
  [-1, 1].forEach(function(s){
    // the eyes: the outer end up (a slight upward-outward slant) and back round the face
    p("head", ["r", hw*0.2, hh*0.085, 0.016, 6, 4], "G", hx + s*hw*EYE_X, H[1] + hh*EYE_Y, fz + 0.026, 0, s*0.14, s*0.24, 1, 1, 1, 8);
    p("head", ["r", 0.03, hh*0.34, hd*0.36, 6, 4], "B", hx + s*(hw + e)/2, hy - hh*0.04, hz - hd*0.04, 0, 0, 0, 1, 1, 1, 7, K.plain);       // ear vents
    p("head", ["b", 0.008, hh*0.2, 0.012], "G", hx + s*((hw + e)/2 + 0.014), hy - hh*0.04, hz - hd*0.04, 0, 0, 0, 1, 1, 1, 7);
  });
  if(has("dome")) p("head", ["s", 0.5, 14, 10], "L", hx, hy + 0.01, hz + 0.01, 0, 0, 0, hw*1.3, hh*1.35, hd*1.3, 8);
  // the torso: a cuirass, the chest plate and its core in two rings, a belt; on the back the frame's pack, tanks or wings
  var Tb = M.torso, tw = Tb[3] - Tb[0], th = Tb[4] - Tb[1], td = Tb[5] - Tb[2], tz = (Tb[2] + Tb[5])/2, tf = Tb[5] + 0.02*b, cr = (has("core") ? 0.055 : 0.032)*tw/0.3;
  p("torso", ["r", tw + 0.04*b, th*0.9, td + 0.04*b, 12, 8], "A", 0, Tb[1] + th*0.56, tz, 0, 0, 0, 1, 1, 1, 3, K.cuirass);
  p("torso", ["r", tw*0.62*b, th*0.36, 0.035, 8, 6], "B", 0, Tb[1] + th*0.64, tf, 0, 0, 0, 1, 1, 1, 3, K.chest);
  p("torso", ["y", cr, cr, 0.03, 12], "G", 0, Tb[1] + th*0.66, tf + 0.026, PI/2, 0, 0, 1, 1, 1, 3);
  p("torso", ["t", cr*1.32, cr*0.2, 12], "B", 0, Tb[1] + th*0.66, tf + 0.04, 0, 0, 0, 1, 1, 1, 3);
  p("torso", ["t", cr*1.7, cr*0.09, 12], "G", 0, Tb[1] + th*0.66, tf + 0.034, 0, 0, 0, 1, 1, 1, 3);
  p("torso", ["b", tw + 0.06*b, 0.035, td + 0.06*b], "D", 0, Tb[1] + 0.02, tz, 0, 0, 0, 1, 1, 1, 2);
  if(has("pack")) p("torso", ["r", tw*0.8*b, th*0.85, 0.09*b, 8, 6], "D", 0, Tb[1] + th*0.55, Tb[2] - 0.04*b, 0, 0, 0, 1, 1, 1, 6, K.pack);
  // the limbs, each side mirrored: s is the side's sign along X. No knee bone: the shin leans its top forward and the boot
  // tips its heel back (KNEE rad), with a knee cop between, so a leg reads bent, not a stub, when it trails in a cruise
  var A = M.arm, al = A.o - A.i, ah = A.y1 - A.y0, ad = A.z1 - A.z0, ay = (A.y0 + A.y1)/2, az = (A.z0 + A.z1)/2;
  var Lg = M.leg, lw = Lg.o - Lg.i, lh = Lg.y1 - Lg.y0, ld = Lg.z1 - Lg.z0, lx = (Lg.i + Lg.o)/2, lz = (Lg.z0 + Lg.z1)/2;
  [["left", A.s, Lg.s], ["right", -A.s, -Lg.s]].forEach(function(q){
    var n = q[0], s = q[1], t = q[2];
    p("leg-" + n, ["r", lw + 0.035*b, lh*0.42, ld + 0.05*b, 8, 6], "B", t*lx, Lg.y0 + lh*0.21 + 0.006, lz + 0.006, KNEE[1], 0, 0, 1, 1, 1, 0, K.boot);   // boots
    p("leg-" + n, ["r", lw + 0.024*b, lh*0.42, ld*0.9 + 0.022*b, 8, 6], "A", t*lx, Lg.y0 + lh*0.62, lz + 0.01, KNEE[0], 0, 0, 1, 1, 1, 1, K.shin); // shins
    p("leg-" + n, ["r", lw*0.62, lh*0.2, 0.035, 6, 4], "B", t*lx, Lg.y0 + lh*0.5, Lg.z1 + 0.018*b, 0.3, 0, 0, 1, 1, 1, 1, K.plain);               // knee cops
    if(has("fins")) p("leg-" + n, ["b", 0.012, lh*0.6, ld*0.85], "B", t*(Lg.o + 0.018*b), Lg.y0 + lh*0.58, lz - ld*0.15, -0.3, 0, 0, 1, 1, 1, 1);
    p("arm-" + n, ["r", al*0.36, ah*0.62*b, ad + 0.05*b, 8, 6], "B", s*(A.i + al*0.17), A.y1 + ah*0.02, az, 0, 0, -s*0.25, 1, 1, 1, 4, K.shoulder); // shoulder pads
    p("arm-" + n, ["r", al*0.42, ah + 0.022*b, ad + 0.022*b, 8, 6], "A", s*(A.i + al*0.66), ay, az, 0, 0, 0, 1, 1, 1, 5, K.gauntlet);             // forearm gauntlets
    if(has("fists")) p("arm-" + n, ["r", al*0.24*fist, ah*1.3, ad*1.25, 8, 6], "B", s*(A.o - al*0.1), ay, az, 0, 0, 0, 1, 1, 1, 5, K.shoulder);
    else p("arm-" + n, ["b", al*0.16, ah*0.5, 0.016], "B", s*(A.o - al*0.12), ay + ah*0.08, A.z1 + 0.012, 0, 0, 0, 1, 1, 1, 5, K.plain);        // knuckle plates
    p("arm-" + n, ["s", 0.016*fist], "G", s*(A.o + 0.006), ay, az, 0, 0, 0, 1, 1, 1, 5);                                                // palm emitters
    if(has("wings")) p("torso", ["b", tw*1.4, 0.016, td*0.55], "B", s*tw*0.8, Tb[1] + th*0.82, Tb[2] - 0.03, 0, -s*0.2, s*0.35, 1, 1, 1, 6);
    if(has("tanks")) p("torso", ["y", 0.038*tw/0.3, 0.038*tw/0.3, th*1.05, 10], "B", s*tw*0.22, Tb[1] + th*0.55, Tb[2] - 0.035, 0, 0, 0, 1, 1, 1, 6);
  });
  return P;
}
// the eye lenses: x off the head's centre and y up it, as shares of the helmet's width and height (where the Kenney
// characters' own eyes are); KNEE [shin, boot] the faked knee bend (rad about X, + the top forward)
var EYE_X = 0.19, EYE_Y = 0.47, KNEE = [0.12, 0.2];
function sp(c){ return (c < 0 ? -1 : 1)*Math.pow(Math.abs(c), 0.42); }
function shape(T, s){
  if(s[0] === "r"){
    var g = new T.SphereGeometry(1, s[4] || 10, s[5] || 7), a = g.attributes.position;
    for(var i = 0; i < a.count; i++) a.setXYZ(i, sp(a.getX(i))*s[1]/2, sp(a.getY(i))*s[2]/2, sp(a.getZ(i))*s[3]/2);
    g.computeVertexNormals(); return g;
  }
  if(s[0] === "s") return new T.SphereGeometry(s[1], s[2] || (s[1] < 0.03 ? 8 : 16), s[3] || (s[1] < 0.03 ? 6 : 12));
  if(s[0] === "t") return new T.TorusGeometry(s[1], s[2], 3, s[3] || 12);
  if(s[0] === "b") return new T.BoxGeometry(s[1], s[2], s[3]);
  return new T.CylinderGeometry(s[1], s[2], s[3], s[4] || 12);
}
function local(T, q){
  return new T.Matrix4().compose(new T.Vector3(q[3], q[4], q[5]), new T.Quaternion().setFromEuler(new T.Euler(q[6], q[7], q[8])), new T.Vector3(q[9], q[10], q[11]));
}
function colOf(key, o){ var P = PAINTS[o.p]; return key === "A" ? P[1] : key === "B" ? P[2] : key === "D" ? UNDER : key === "L" ? 0xbfe8ff : 0xffffff; }
/* The armour's detail is in its shader, not its triangles (the dragons' hide in games/hqpets.js, DR_HIDE / DR_BUMP, is the
   model): every vertex carries aX = its piece-local position (-1..1 over the piece's box) and its kind (KIND, + 0.5 on a
   second-paint piece). From those the fragment works out panel lines with rivets along them, worn bare edges, a thin
   trim line in the glow colour, the frame's decal (uDec: 0 Sentinel chevrons, 1 Strider racing stripe, 2 Bulwark hazard
   stripes, 3 Abyss rivet rows, 4 Stratos quilting, 5 Flux liquid sheen) and the eyes' soft halo on the faceplate; the
   grooves and rivets bump the normal through screen derivatives and fade out with distance. One program for all six. */
var ARM_HEAD = "uniform vec3 uGlow; uniform vec3 uC1; uniform vec3 uC2; uniform float uGK; uniform float uT; uniform float uDec; uniform vec4 uEye;\n" +
  "varying vec4 vX; varying vec3 vWyP;\n";
var ARM_COL = [
  "vec3 lq = vX.xyz; float kd = floor(vX.w + 0.01), onB = step(0.25, vX.w - kd), fd = 1.0 - smoothstep(3.0, 18.0, length(vViewPosition));",
  "float isP = step(0.5, kd)*(1.0 - step(9.5, kd));",                    // a plate (kind 1..9), not a vent or a cop
  "float isH = step(abs(kd - 1.0), 0.1), isF = step(abs(kd - 2.0), 0.1), isC = step(abs(kd - 3.0), 0.1), isCh = step(abs(kd - 4.0), 0.1);",
  "float isBt = step(abs(kd - 5.0), 0.1), isSh = step(abs(kd - 6.0), 0.1), isSp = step(abs(kd - 7.0), 0.1), isG = step(abs(kd - 8.0), 0.1);",
  "vec3 ax = abs(lq); float emx = max(ax.x, max(ax.y, ax.z)), emn = min(ax.x, min(ax.y, ax.z)), e2 = ax.x + ax.y + ax.z - emx - emn;",
  // panel lines: two bands round each plate and a centre seam down the helmet and the cuirass; rivets along the bands
  "float sy = abs(abs(lq.y) - 0.42), lw = 0.03 + fwidth(lq.y);",
  "float pl = (1.0 - smoothstep(0.0, lw, sy))*isP*(1.0 - isF)*(1.0 - isCh);",
  "pl = max(pl, (1.0 - smoothstep(0.0, 0.025 + fwidth(lq.x), abs(lq.x)))*(isH + isC)*step(0.15, lq.y + 1.0)*(1.0 - isH*step(0.3, lq.z)));",
  "vec2 rc = vec2((fract(lq.x*3.5 + 0.5) - 0.5)*1.2, (abs(lq.y) - 0.53)*4.2); float rv = (1.0 - smoothstep(0.08, 0.17, length(rc)))*isP*(1.0 - isF)*(1.0 - isCh);",
  // the frame's decal: dc its mask, dcol its colour (the other paint), qz a height of its own (quilting, rivet rows)
  "float dc = 0.0, qz = 0.0; vec3 dcol = mix(uC2, uC1, onB);",
  "if(uDec < 0.5){ float cv = fract((lq.y + ax.x*0.75)*2.4); dc = step(0.55, cv)*step(lq.y, 0.25)*step(-0.85, lq.y)*(isCh + isSh*step(0.0, lq.z)); }",
  "else if(uDec < 1.5){ dc = (1.0 - smoothstep(0.1, 0.12 + fwidth(lq.x), abs(abs(lq.x) - 0.17)))*(isH + isC + isSh)*step(-0.2 - isH, lq.z); dcol = mix(vec3(0.93), uC2, 0.25); }",
  "else if(uDec < 2.5){ float hs = step(0.5, fract((lq.x + lq.y)*2.6)); dc = (isBt*step(lq.y, -0.15) + isSp*step(0.25, lq.y) + isG*step(abs(lq.y + 0.0), 0.22)); dcol = mix(vec3(0.05, 0.05, 0.04), vec3(0.95, 0.72, 0.08), hs); }",
  "else if(uDec < 3.5){ vec2 gq = fract(vec2(lq.x*4.0, lq.y*5.0)) - 0.5; float rr = 1.0 - smoothstep(0.1, 0.19, length(gq)); qz = rr*isP*(1.0 - isF); dc = qz*0.35; dcol = diffuseColor.rgb*0.55; }",
  "else if(uDec < 4.5){ vec2 qq = abs(fract(vec2(lq.x + lq.y, lq.x - lq.y)*2.6) - 0.5); float qs = min(qq.x, qq.y); qz = smoothstep(0.0, 0.32, qs)*(isC + isSh + isG + isH*step(lq.z, 0.1)); dc = (1.0 - smoothstep(0.0, 0.05 + fwidth(qs), qs))*sign(qz + 0.001)*0.35; dcol = diffuseColor.rgb*0.6; }",
  "else { float fl = sin(lq.y*5.0 + uT*1.1 + sin(lq.x*4.0 - uT*0.7)*1.6 + lq.z*3.0); dc = 0.0; diffuseColor.rgb *= 0.86 + 0.24*fl; diffuseColor.rgb += uGlow*0.06*max(0.0, fl); }",
  "diffuseColor.rgb = mix(diffuseColor.rgb, dcol, clamp(dc, 0.0, 1.0)*0.85);",
  // worn edges: where two of the piece's axes are near its box, a noisy band of bare steel
  "float wn = fract(sin(dot(floor(vWyP*140.0), vec3(12.9898, 78.233, 37.719)))*43758.5453);",
  "float wear = smoothstep(0.8, 0.97, e2)*step(0.5, wn*0.7 + smoothstep(0.85, 1.0, e2)*0.6)*isP;",
  "diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.6, 0.62, 0.64), wear*0.6);",
  "diffuseColor.rgb *= 1.0 - pl*0.45;",
  "float dH = (-pl*0.9 + rv*0.8 + qz*0.6)*0.0022*fd;"].join("\n") + "\n";
var ARM_RM = "roughnessFactor = clamp(roughnessFactor + pl*0.25 - wear*0.15, 0.04, 1.0); metalnessFactor = clamp(metalnessFactor + wear*0.5, 0.0, 1.0);\n";
var ARM_EM = [
  // the trim: a hairline of the glow colour along the lower edge of the cuirass, shins and gauntlets; the eyes' halo
  "float tl = (1.0 - smoothstep(0.0, 0.022 + fwidth(lq.y), abs(lq.y + 0.66)))*(isC + isSh + isG);",
  "vec2 ed = vec2(abs(vWyP.x - uEye.x) - uEye.w, (vWyP.y - uEye.y)*1.6); float hal = exp(-dot(ed, ed)/(uEye.w*uEye.w*0.9))*isF*step(uEye.z - 0.04, vWyP.z);",
  "totalEmissiveRadiance += uGlow*uGK*(tl*1.1 + hal*0.9);"].join("\n") + "\n";
function mats(T, o, U){
  var Fi = FINISHES[o.fin], gl = GLOWS[o.g][1];
  var A = new T.MeshStandardMaterial({vertexColors: true, roughness: Fi[1], metalness: Fi[2]});
  if(U){
    A.onBeforeCompile = function(sh){
      for(var k in U) sh.uniforms[k] = U[k];
      sh.vertexShader = "attribute vec4 aX;\nvarying vec4 vX;\nvarying vec3 vWyP;\n" + sh.vertexShader.replace("#include <begin_vertex>", "#include <begin_vertex>\n  vX = aX; vWyP = position;");
      sh.fragmentShader = ARM_HEAD + sh.fragmentShader.replace("#include <color_fragment>", "#include <color_fragment>\n" + ARM_COL)
        .replace("#include <metalnessmap_fragment>", "#include <metalnessmap_fragment>\n" + ARM_RM)
        .replace("#include <normal_fragment_maps>", "#include <normal_fragment_maps>\n" + DR_BUMP_X)
        .replace("#include <emissivemap_fragment>", "#include <emissivemap_fragment>\n" + ARM_EM);
    };
    A.customProgramCacheKey = function(){ return "hqexo-armour"; };
  }
  return {
    A: A,
    D: new T.MeshStandardMaterial({color: UNDER, roughness: 0.6, metalness: 0.45}),
    G: new T.MeshStandardMaterial({color: gl, emissive: gl, emissiveIntensity: 2.2, toneMapped: false}),
    L: new T.MeshStandardMaterial({color: 0xbfe8ff, roughness: 0.05, metalness: 0.1, transparent: true, opacity: 0.38, depthWrite: false})
  };
}
// the derivative bump (games/hqpets.js DR_BUMP): dH moves the normal, no extra triangles
var DR_BUMP_X = "{ vec3 bx = dFdx(-vViewPosition), by = dFdy(-vViewPosition), r1 = cross(by, normal), r2 = cross(normal, bx); float bd = dot(bx, r1);\n" +
  "  normal = normalize(abs(bd)*normal - sign(bd)*(dFdx(dH)*r1 + dFdy(dH)*r2)); }\n";
// the shader's uniforms for a look on a measured body: its glow, both paints, the frame's decal, the eyes (x, y, z, half spacing)
function armU(T, o, M){
  var P = PAINTS[o.p], H = M.head, hw = H[3] - H[0], hh = Math.min(H[4] - H[1], hw*1.05);
  return {uGlow: {value: new T.Color(GLOWS[o.g][1])}, uC1: {value: new T.Color(P[1])}, uC2: {value: new T.Color(P[2])}, uGK: {value: 1}, uT: {value: 0},
          uDec: {value: o.f}, uEye: {value: new T.Vector4((H[0] + H[3])/2, H[1] + hh*EYE_Y, H[5] + 0.03*0.55 + 0.02, hw*EYE_X)}};
}
// a piece's geometry, placed, with aX (its piece-local position and kind) for the armour shader
function pieceGeo(T, q){
  var g = shape(T, q[1]); g.computeBoundingBox();
  var bb = g.boundingBox, a = g.attributes.position, n = a.count, x = new Float32Array(n*4), k = (q[13] | 0) + (q[2] === "B" ? 0.5 : 0);
  var cx = (bb.min.x + bb.max.x)/2, cy = (bb.min.y + bb.max.y)/2, cz = (bb.min.z + bb.max.z)/2;
  var sx = Math.max(1e-6, (bb.max.x - bb.min.x)/2), sy = Math.max(1e-6, (bb.max.y - bb.min.y)/2), sz = Math.max(1e-6, (bb.max.z - bb.min.z)/2);
  for(var i = 0; i < n; i++){ x[i*4] = (a.getX(i) - cx)/sx; x[i*4 + 1] = (a.getY(i) - cy)/sy; x[i*4 + 2] = (a.getZ(i) - cz)/sz; x[i*4 + 3] = k; }
  g.setAttribute("aX", new T.BufferAttribute(x, 4));
  g.applyMatrix4(local(T, q));
  return g;
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
  var o = clean(o0), F = FRAMES[o.f], P = spec(F, M), U = armU(T, o, M), MT = mats(T, o, U), acc = {}, body = M.body;
  P.forEach(function(q){
    var geo = pieceGeo(T, q), k = MAT_OF[q[2]], bi = M.bi[q[0]], gg = geo.index ? geo.toNonIndexed() : geo;
    var a = acc[k] || (acc[k] = {pos: [], nor: [], col: [], si: [], sw: [], ax: []}), c = new T.Color(colOf(q[2], o));
    var pp = gg.attributes.position.array, nn = gg.attributes.normal.array, xx = gg.attributes.aX.array;
    for(var i = 0, j = 0; i < pp.length; i += 3, j += 4){ a.pos.push(pp[i], pp[i + 1], pp[i + 2]); a.nor.push(nn[i], nn[i + 1], nn[i + 2]); a.col.push(c.r, c.g, c.b); a.si.push(bi, 0, 0, 0); a.sw.push(1, 0, 0, 0);
      a.ax.push(xx[j], xx[j + 1], xx[j + 2], xx[j + 3]); }
    if(gg !== geo) gg.dispose(); geo.dispose();
  });
  var meshes = [];
  ["A", "D", "G", "L"].forEach(function(k){
    var a = acc[k]; if(!a){ MT[k].dispose(); delete MT[k]; return; }
    var geo = new T.BufferGeometry();
    geo.setAttribute("position", new T.Float32BufferAttribute(a.pos, 3)); geo.setAttribute("normal", new T.Float32BufferAttribute(a.nor, 3));
    geo.setAttribute("color", new T.Float32BufferAttribute(a.col, 3)); geo.setAttribute("aX", new T.Float32BufferAttribute(a.ax, 4));
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
  ch._exo = {look: o, frame: F, mats: MT, U: U, meshes: meshes, spec: P, M: M, hid: hid, rest: rest, s0: s0, s1: s0*F.h, up: ch.update, tilt: false, T: T, fx: null,
             q: new T.Quaternion(), q2: new T.Quaternion(), q3: new T.Quaternion(), e: new T.Euler(), v: new T.Vector3(), v2: new T.Vector3()};
  ch.base = s0*F.h; ch.o.scale.setScalar(ch.base);
  var up = ch._exo.up;
  ch.update = function(t){ if(up) up(t); var E = HQV.engine; if(!(E && E.calm && E.calm())) U.uT.value = fin(t) % 1000; pose(ch, t); };
  return true;
}
function strip(ch){
  var X = ch && ch._exo; if(!X) return;
  X.meshes.forEach(function(m){ if(m.parent) m.parent.remove(m); m.geometry.dispose(); });
  for(var k in X.mats) X.mats[k].dispose();
  X.hid.forEach(function(h){ h[0].visible = h[1]; });
  if(X.tilt) unTilt(X);
  if(X.fx){ fxFree(X.fx); X.fx = null; }
  ch.update = X.up; if(!X.up) delete ch.update;
  ch.base = X.s0; ch.o.scale.setScalar(X.s0);
  ch._exo = null; ch._fly = null;
}
function stats(ch){
  var tris = 0, draws = 0;
  (ch && ch._exo ? ch._exo.meshes : []).forEach(function(m){ if(m.visible){ draws++; tris += (m.geometry.index ? m.geometry.index.count : m.geometry.attributes.position.count)/3; } });
  var F = ch && ch._exo && ch._exo.fx, fx = F ? (F.fl.visible && F.fl.parent ? 1 : 0) + (F.pts.visible && F.pts.parent ? 1 : 0) : 0;
  return {tris: tris, draws: draws, fx: fx};          // draws: the armour (at most 4); fx: the thrusters (at most 2)
}

/* ---------- flight poses, put on after the avatar's clips (on foot its own idle / walk / sprint / sit carry on) ----------
   rest arms lie along +-X: a Z turn hangs them, an X turn swings them (+ forward); legs swing on X (+ back). ch._fly =
   {mode "hover"|"cruise"|"swim"|"landed", speed m/s, boost, turn (yaw rate rad/s, + left), vs (m/s), agl (m), spin (rad)};
   a peer's carries only what presence syncs (mode, a stand-in speed, boost) and what hq3d measures (turn, agl): a missing
   turn or vs is measured here from the body's own movement. Every pose number is a critically damped spring toward
   targets(fl) and the whole pose blends in and out over the clip (w), so take-off and landing never snap. */
function rnd(i, f){ var x = Math.sin(i*91.7 + f*13.1)*43758.5; return x - Math.floor(x); }
var BANK_MAX = 1.05, BANK_K = 0.03;       // rad (60 degrees); bank = yaw rate x speed x BANK_K
function fin(v){ v = +v; return isFinite(v) ? v : 0; }
function cl(v, a, b){ return v < a ? a : v > b ? b : v; }
function bone(X, n){ return X.M.sk.bones[X.M.bi[n]]; }
// the bank for a yaw rate (rad/s, + left) at a speed (m/s): + leans left, at most BANK_MAX either way
function bankFor(turn, speed){ return cl(fin(turn)*(Math.max(0, fin(speed))*BANK_K + 0.08), -BANK_MAX, BANK_MAX); }
// the pose's targets for a flight state (pure, for tests): tilt (rad, the body toward horizontal), crouch 0..1, cruise
// and boost weights, the legs' swing and splay, the arms' swing and spread, lead (the leading arm forward), thrust 0..1.3
function targets(fl, o){
  o = o || {}; var m = fl ? fl.mode : null, sp = Math.max(0, fin(fl && fl.speed)), b = !!(fl && fl.boost) && m === "cruise";
  var c = m === "cruise" ? 1 : 0, ks = cl((sp - 15)/45, 0, 1), agl = fl && fl.agl != null && isFinite(+fl.agl) ? Math.max(0, +fl.agl) : 10;
  o.c = c; o.b = b ? 1 : 0; o.swim = m === "swim" ? 1 : 0;
  o.crouch = m === "landed" ? 1 : m === "hover" ? cl(1 - agl/1.6, 0, 1)*0.85 : 0;
  o.tilt = m === "swim" ? PI/2 : m === "cruise" ? (b ? 1.5 : 1.22 + 0.14*ks) : m === "hover" ? 0.06 + cl(sp/15, 0, 1)*0.25 : 0;
  // the air brake (fl.brake 0..1, hqexoride's): up out of the dive, legs swung forward under you, arms flared like flaps
  var br = c ? cl(fin(fl.brake), 0, 1) : 0; o.brake = br;
  if(br) o.tilt -= br*0.62;
  o.legX = c ? (b ? 0.04 : 0.08) - br*0.42 : -0.08 - o.crouch*0.4;
  o.splay = c ? (b ? 0.035 : 0.055) + br*0.04 : 0.13;        // a cruise: the legs parted a little, so both read from behind
  o.armSw = c ? (b ? -0.3 : -0.22) + br*0.5 : 0.12 + o.crouch*0.25;
  o.armOut = c ? (b ? 0.05 : 0.13) + br*0.55 : 0.4 + o.crouch*0.15;
  o.lead = b ? 1 : 0;
  o.thrust = m === "swim" || !m ? 0 : m === "landed" ? 0.2 : c ? (b ? 1.3 : 0.75 + 0.25*ks) : 0.45 + 0.1*cl(fin(fl.vs)/6, -1, 1);
  return o;
}
// an exact critically damped step of S[k] (its rate S[kv]) toward goal at w rad/s
function sd(S, k, kv, goal, w, dt){
  var x = S[k], v = S[kv], c = x - goal, t = (v + w*c)*dt, e = Math.exp(-w*dt);
  S[k] = goal + (c + t)*e; S[kv] = (v - w*t)*e;
}
// hover <-> cruise blends slowly (c, tilt), the limbs a little faster; brake its own spring
var SPR = [["c", 2.3], ["b", 3.5], ["swim", 4], ["crouch", 6], ["tilt", 2.6], ["legX", 4], ["splay", 4], ["armSw", 3.8], ["armOut", 3.8],
           ["lead", 3.5], ["thrust", 6], ["bank", 4.5], ["climb", 3], ["slip", 3], ["brake", 4], ["w", 7]];
SPR.forEach(function(p){ p.push(p[0] + "v"); });          // its rate's key, made once
function springs(){ var S = {}; SPR.forEach(function(p){ S[p[0]] = 0; S[p[2]] = 0; }); return S; }
// a bone toward rest x Euler(x, y, z), by w of the way from where the clip left it
function setB(X, n, x, y, z, w){ var b = bone(X, n); X.e.set(x, y, z); X.q.copy(X.rest[n].q).multiply(X.q3.setFromEuler(X.e)); b.quaternion.slerp(X.q, w); }
function arm(X, n, s, swing, out, w){ setB(X, "arm-" + n, -swing, 0, -s*(PI/2 - out), w); }
function unTilt(X){
  NEED.forEach(function(n){ var b = bone(X, n); b.quaternion.copy(X.rest[n].q); b.position.copy(X.rest[n].p); });
  X.tilt = false; X.t = null; X.s = null; if(X.fx) fxHide(X.fx);
}
function pose(ch, t){
  var X = ch && ch._exo; if(!X) return;
  var fl = ch._fly, m = fl ? fl.mode : null, on = m === "hover" || m === "cruise" || m === "swim" || m === "landed";
  if(!on && !X.tilt) return;
  var E = HQV.engine, calm = !!(E && E.calm && E.calm()), t1 = fin(t), t0 = X.t;
  X.t = t1; var dt = t0 == null ? 0 : Math.max(0, Math.min(0.1, t1 - t0));
  var S = X.s || (X.s = springs()), TG = targets(on ? fl : null, X.tg || (X.tg = {}));
  // a turn rate or climb not given: measured from the body's world yaw and height (last frame's matrices: a frame late, smoothed)
  var me = ch.o.matrixWorld.elements, wyaw = Math.atan2(me[8], me[10]), wy = me[13], mt = 0, mv = 0;
  if(X.wy != null && dt > 0){ var dy = wyaw - X.wyaw; dy = dy > PI ? dy - 2*PI : dy < -PI ? dy + 2*PI : dy; mt = dy/dt; mv = (wy - X.wy)/dt; }
  X.wyaw = wyaw; X.wy = wy;
  S.mt = fin(S.mt) + (cl(mt, -4, 4) - fin(S.mt))*Math.min(1, dt*6); S.mv = fin(S.mv) + (cl(mv, -60, 60) - fin(S.mv))*Math.min(1, dt*4);
  var turn = on && fl.turn != null && isFinite(+fl.turn) ? +fl.turn : S.mt, vs = on && fl.vs != null && isFinite(+fl.vs) ? +fl.vs : S.mv;
  var sp = on ? Math.max(0, fin(fl.speed)) : 0;
  TG.bank = on && m !== "swim" && m !== "landed" ? bankFor(turn, sp) : 0;
  TG.climb = m === "cruise" ? cl(Math.atan2(vs, Math.max(sp, 10)), -0.6, 0.6) : 0;
  TG.slip = m === "cruise" ? TG.bank*0.14*cl(sp/50, 0, 1) : 0;           // high speed: the nose a little into the turn, the body drifting out
  TG.w = on ? 1 : 0;
  if(t0 == null){ SPR.forEach(function(p){ S[p[0]] = TG[p[0]] || 0; }); S.w = 0; }     // a first frame: at the pose (blending in from the clip)
  for(var i = 0; i < SPR.length; i++) sd(S, SPR[i][0], SPR[i][2], fin(TG[SPR[i][0]]), SPR[i][1], dt);
  if(!isFinite(S.w + S.tilt + S.bank + S.climb + S.thrust)){ X.s = null; X.t = null; return; }
  if(!on && S.w < 0.003){ unTilt(X); return; }
  var w = cl(S.w, 0, 1), sa = X.M.arm.s, sl = X.M.leg.s, bob = calm ? 0 : Math.sin(t1*2.1), sway = calm ? 0 : Math.sin(t1*1.3);
  var hov = cl(1 - S.c - S.swim, 0, 1);
  // the hips: about the torso bone (not the feet), yaw-slip x bank (about the flight line) x the lean toward horizontal less the climb
  var r = bone(X, "root"), h = X.v.copy(bone(X, "torso").position).multiply(r.scale), R0 = X.rest.root.q;
  var spin = on ? fin(fl.spin) : 0;
  X.e.set(S.tilt + S.crouch*0.12 - S.climb, S.slip, -(S.bank + spin), "YZX");
  X.q2.setFromEuler(X.e).multiply(R0);
  X.q.copy(R0).slerp(X.q2, w); r.quaternion.copy(X.q);
  r.position.copy(X.rest.root.p).add(X.v2.copy(h).applyQuaternion(R0)).sub(h.applyQuaternion(X.q));
  r.position.y += w*(-S.crouch*0.035 + hov*bob*0.008);
  X.tilt = true;
  // the torso arches up a little in a cruise, curls in a crouch, and breathes; the head looks where it flies and into a turn
  var br = calm ? 0 : Math.sin(t1*1.7)*(0.022*hov + 0.01*S.c), bk = cl(S.bank, -BANK_MAX, BANK_MAX);
  setB(X, "torso", S.crouch*0.3 - S.c*0.1 + br, bk*0.08, 0, w);
  setB(X, "head", -S.tilt*0.72 + S.crouch*0.15 + 0.05 - br*0.6, -S.slip*0.6 + bk*0.32, -bk*0.12, w);
  if(S.swim > 0.5){
    X.ph = ((X.ph || 0) + dt*0.7) % 1; var spn = Math.sin(X.ph*2*PI), kick = calm ? 0 : Math.sin(t1*7);
    arm(X, "left", sa, 2.4 - spn*0.9, 0.5 + spn*0.4, w); arm(X, "right", -sa, 2.4 - spn*0.9, 0.5 + spn*0.4, w);
    setB(X, "leg-left", -kick*0.25, 0, 0, w); setB(X, "leg-right", kick*0.25, 0, 0, w);
  } else {
    // the arms counter the bank (the high one out, the low one in) and drift a little (secondary motion)
    var ls = hov*sway*0.06, ab = hov*bob*0.04 + (calm ? 0 : Math.sin(t1*2.3 + 1)*0.015), cb = bk*0.16*sa;
    arm(X, "left", sa, S.armSw, S.armOut + ab + cb, w);
    // the leading (right) arm reaches forward on a boost: the classic flying pose
    arm(X, "right", -sa, S.armSw + (PI - 0.2 - S.armSw)*S.lead, S.armOut - ab - cb + (0.12 - S.armOut)*S.lead, w);
    setB(X, "leg-left", S.legX + ls, 0, sl*S.splay, w); setB(X, "leg-right", S.legX - ls, 0, -sl*(S.splay + hov*0.03), w);
  }
  fxStep(ch, X, S, w, t1, dt, calm, on ? fl : null);
}

/* ---------- the thrusters: both boot soles and both palms, two draw calls for the lot ----------
   One InstancedMesh of additive open cones (FX_I instances): per emitter an outer soft flame, a white-hot core and a glow
   ring at the nozzle (3 each); a short ribbon behind each boot at cruise and boost (FX_RIB segments each, every one a
   stretched thin cone from one trail sample to the next, fading with age); two downwash rings spreading over the ground
   in a low hover. One Points cloud (FX_N): per emitter a soft halo; a dust ring of motes; boost heat puffs; a spark burst
   the moment a boost kicks in. World space, under the scene the character stands in (nothing shows in a portrait); every
   buffer made once in fxMake, nothing allocated per frame. Flames flicker on two noise octaves, grow with thrust and show
   shock diamonds on a boost. No heat haze (it would need the screen behind it: a render target). */
var FX_DUST = 16, FX_TRAIL = 24, FX_SPARK = 16, FX_N = 4 + FX_DUST + FX_TRAIL + FX_SPARK;
var FX_RIB = 9, FX_HIST = FX_RIB + 1, FX_I = 12 + 2*FX_RIB + 2;      // instances: flames, ribbons, downwash
// the boot jets lean a little out and down off the leg's line (body space: x out, -y down the leg, +z the front), so in a
// cruise they fan out below the body instead of firing straight back into the chase camera
var BOOT_JET = [0.2, -1, 0.24];
var FLAME_VS = [
  "attribute vec4 aI; varying float vT; varying float vE; varying vec4 vI; uniform float uTime;",
  "void main(){",
  "  vT = position.y; vI = aI; vec3 p = position; float fl = step(aI.y, 1.5);",           // types: 0 flame, 1 core, 2 ring, 3 ribbon, 4 downwash
  "  float nz = sin(uTime*41.0 + aI.w*9.0 + p.y*11.0)*0.6 + sin(uTime*23.0 - p.y*17.0 + aI.w*3.7)*0.4;",
  "  p.xz *= 1.0 + fl*0.17*nz*(1.0 - p.y*0.5);",
  "  vec4 mv = modelViewMatrix*instanceMatrix*vec4(p, 1.0);",
  "  vec3 n = normalize(normalMatrix*mat3(instanceMatrix)*normal);",
  "  vE = abs(dot(n, normalize(-mv.xyz)));",
  "  gl_Position = projectionMatrix*mv;",
  "}"].join("\n");
var FLAME_FS = [
  "uniform vec3 uGlow; uniform float uTime; varying float vT; varying float vE; varying vec4 vI;",
  "void main(){",
  "  float ty = vI.y, k = vI.x, a; vec3 hot = vec3(1.0, 0.97, 0.9), col;",
  "  if(ty > 3.5){ a = exp(-pow((vT - 0.45)*4.0, 2.0))*k; col = vec3(0.62, 0.57, 0.5); }",                                 // downwash
  "  else if(ty > 2.5){ a = pow(vE, 1.6)*k*(0.75 + 0.25*sin(vT*9.0 - uTime*20.0 + vI.w)); col = mix(uGlow, hot, 0.3); }",      // ribbon
  "  else if(ty > 1.5){ a = exp(-pow((vT - 0.22)*7.0, 2.0))*k*(0.85 + 0.15*sin(uTime*30.0 + vI.w)); col = mix(hot, uGlow, 0.35); }", // nozzle ring
  "  else {",
  "    float core = step(0.5, ty);",
  "    col = core > 0.5 ? mix(hot, uGlow, vT*0.55) : mix(mix(hot, uGlow, smoothstep(0.0, 0.3, vT)), uGlow*0.55, smoothstep(0.4, 1.0, vT));",
  "    a = pow(1.0 - vT, core > 0.5 ? 1.8 : 1.15)*pow(vE, core > 0.5 ? 1.0 : 1.6)*k;",
  "    a *= 0.78 + 0.22*sin(uTime*53.0 + vI.w*5.0 + vT*14.0)*sin(uTime*31.0 - vT*9.0 + vI.w);",          // two-octave flicker
  "    a *= 1.0 + vI.z*1.5*pow(max(0.0, sin(vT*19.0 - uTime*34.0)), 8.0);",                              // a boost's shock diamonds
  "  }",
  "  if(a < 0.003) discard;",
  "  gl_FragColor = vec4(col, clamp(a, 0.0, 1.0));",
  "}"].join("\n");
var PT_VS = [
  "attribute vec4 aC; attribute float aS; varying vec4 vC; uniform float uVh;",
  "void main(){ vC = aC; vec4 mv = modelViewMatrix*vec4(position, 1.0);",
  "  gl_PointSize = aS <= 0.0 ? 0.0 : clamp(aS*projectionMatrix[1][1]*uVh*0.5/max(0.05, -mv.z), 0.0, 256.0);",
  "  gl_Position = projectionMatrix*mv; }"].join("\n");
var PT_FS = [
  "varying vec4 vC;",
  "void main(){ float d = length(gl_PointCoord - 0.5)*2.0; float a = pow(max(0.0, 1.0 - d), 2.0)*vC.a; if(a < 0.003) discard;",
  "  gl_FragColor = vec4(vC.rgb, a); }"].join("\n");
// the four nozzles in their bones' space: a boot's sole (jet down its leg, BOOT_JET), a palm (jet out along its arm)
function emitters(T, X){
  var M = X.M, Lg = M.leg, A = M.arm, lx = (Lg.i + Lg.o)/2, lz = (Lg.z0 + Lg.z1)/2, ay = (A.y0 + A.y1)/2, az = (A.z0 + A.z1)/2, J = BOOT_JET;
  var bm = new T.Matrix4(), out = [];
  [["leg-left", Lg.s*lx, Lg.y0, lz, Lg.s*J[0], J[1], J[2]], ["leg-right", -Lg.s*lx, Lg.y0, lz, -Lg.s*J[0], J[1], J[2]],
   ["arm-left", A.s*(A.o + 0.01), ay, az, A.s, 0, 0], ["arm-right", -A.s*(A.o + 0.01), ay, az, -A.s, 0, 0]].forEach(function(q){
    var bi = M.bi[q[0]]; bm.multiplyMatrices(M.sk.boneInverses[bi], M.body.bindMatrix);
    out.push({n: q[0], p: new T.Vector3(q[1], q[2], q[3]).applyMatrix4(bm), d: new T.Vector3(q[4], q[5], q[6]).transformDirection(bm)});
  });
  return out;
}
function fxMake(T, X, glow){
  var cone = new T.ConeGeometry(1, 1, 12, 1, true); cone.rotateX(PI); cone.translate(0, 0.5, 0);     // the wide end at the nozzle, +Y along the jet
  var fm = new T.ShaderMaterial({uniforms: {uGlow: {value: new T.Color(glow)}, uTime: {value: 0}}, vertexShader: FLAME_VS, fragmentShader: FLAME_FS,
    transparent: true, depthWrite: false, blending: T.AdditiveBlending, side: T.DoubleSide, toneMapped: false});
  var ia = new T.InstancedBufferAttribute(new Float32Array(FX_I*4), 4); ia.setUsage(T.DynamicDrawUsage); cone.setAttribute("aI", ia);
  var fl = new T.InstancedMesh(cone, fm, FX_I); fl.instanceMatrix.setUsage(T.DynamicDrawUsage); fl.frustumCulled = false; fl.name = "exo-flames";
  fl.castShadow = false; fl.receiveShadow = false; fl.renderOrder = 5; fl.userData.exo = 1;
  var pg = new T.BufferGeometry(), pp = new T.BufferAttribute(new Float32Array(FX_N*3), 3), pc = new T.BufferAttribute(new Float32Array(FX_N*4), 4),
      ps = new T.BufferAttribute(new Float32Array(FX_N), 1);
  [pp, pc, ps].forEach(function(a){ a.setUsage(T.DynamicDrawUsage); });
  pg.setAttribute("position", pp); pg.setAttribute("aC", pc); pg.setAttribute("aS", ps);
  var pm = new T.ShaderMaterial({uniforms: {uVh: {value: 800}}, vertexShader: PT_VS, fragmentShader: PT_FS, transparent: true, depthWrite: false,
    blending: T.AdditiveBlending, toneMapped: false});
  var pts = new T.Points(pg, pm); pts.frustumCulled = false; pts.name = "exo-glow"; pts.renderOrder = 5; pts.userData.exo = 1;
  var F = {fl: fl, pts: pts, ia: ia, pp: pp, pc: pc, ps: ps, glow: new T.Color(glow), em: emitters(T, X), m4: new T.Matrix4(), q: new T.Quaternion(),
           v: new T.Vector3(), d: new T.Vector3(), s: new T.Vector3(), up: new T.Vector3(0, 1, 0), vs: new T.Vector2(), zero: new T.Matrix4().makeScale(0, 0, 0),
           nz: [new T.Vector3(), new T.Vector3(), new T.Vector3(), new T.Vector3()], nd: [new T.Vector3(), new T.Vector3(), new T.Vector3(), new T.Vector3()],
           tp: new Float32Array(FX_TRAIL*3), ta: new Float32Array(FX_TRAIL).fill(9), tk: 0, tacc: 0,
           rh: new Float32Array(2*FX_HIST*3), rk: 0, racc: 0, rn: 0, ra: new Float32Array(FX_HIST).fill(9),   // the ribbons' samples (2 boots) and ages
           sp: new Float32Array(FX_SPARK*3), sv: new Float32Array(FX_SPARK*3), sa: new Float32Array(FX_SPARK).fill(9), lb: 0, burst: 0};
  pts.onBeforeRender = function(rr){ if(rr && rr.getSize){ rr.getSize(F.vs); pm.uniforms.uVh.value = F.vs.y*(rr.getPixelRatio ? rr.getPixelRatio() : 1) || 800; } };
  return F;
}
function fxHide(F){ F.fl.visible = false; F.pts.visible = false; F.rn = 0; }
function fxFree(F){ [F.fl, F.pts].forEach(function(o){ if(o.parent) o.parent.remove(o); o.geometry.dispose(); o.material.dispose(); }); }
function sceneOf(o){ var s = o; while(s.parent) s = s.parent; return s.isScene ? s : null; }
// one instance: a cone from P along unit D, len long, rad wide; aI = [alpha, type, shock, seed]
function fxCone(F, n, P, D, len, rad, al, ty, sh, seed){
  F.q.setFromUnitVectors(F.up, D);
  F.m4.compose(P, F.q, F.s.set(rad, Math.max(0.001, len), rad)); F.fl.setMatrixAt(n, F.m4);
  var ia = F.ia.array; ia[n*4] = al; ia[n*4 + 1] = ty; ia[n*4 + 2] = sh; ia[n*4 + 3] = seed;
}
function fxOff(F, n){ F.fl.setMatrixAt(n, F.zero); F.ia.array[n*4] = 0; }
function fxStep(ch, X, S, w, t, dt, calm, fl){
  var sc = sceneOf(ch.o), th = cl(S.thrust, 0, 1.4)*w;
  if(!sc || th < 0.02 || !ch.o.visible){ if(X.fx) fxHide(X.fx); return; }
  var T = X.T, F = X.fx || (X.fx = fxMake(T, X, GLOWS[X.look.g][1]));
  if(F.fl.parent !== sc){ sc.add(F.fl); sc.add(F.pts); }
  F.fl.visible = true; F.pts.visible = true;
  ch.o.updateWorldMatrix(true, true);
  var k = Math.max(0.3, ch.base/2.1), tm = calm ? 0 : t, flick = calm ? 0 : 1, b = cl(S.b, 0, 1), c = cl(S.c, 0, 1);
  F.fl.material.uniforms.uTime.value = tm % 1000;
  var pp = F.pp.array, pc = F.pc.array, ps = F.ps.array, g = F.glow;
  for(var i = 0; i < 4; i++){
    var e = F.em[i], bn = bone(X, e.n), P = F.nz[i].copy(e.p).applyMatrix4(bn.matrixWorld), D = F.nd[i].copy(e.d).transformDirection(bn.matrixWorld);
    var palm = i >= 2, lead = i === 3 ? cl(S.lead, 0, 1) : 0;
    var kk = th*(palm ? 0.75*(1 - lead*0.9) : 1), sh = b*(1 - lead);
    // hover: short and flickering; a cruise: long jets; a boost: longer still, with shock diamonds
    var len = k*(palm ? 0.18 + 0.5*c + 0.35*b : 0.26 + 0.75*c + 0.75*b)*cl(kk, 0, 1.3)*(1 + flick*(0.16 - 0.1*c)*Math.sin(t*31 + i*1.9)*Math.sin(t*17.3 + i));
    var rad = k*(palm ? 0.045 : 0.065)*(0.75 + 0.25*cl(kk, 0, 1.2));
    fxCone(F, i*3, P, D, len, rad, cl(kk*0.8, 0, 1), 0, sh, i);                        // the outer soft flame
    fxCone(F, i*3 + 1, P, D, len*0.55, rad*0.4, cl(kk*1.15, 0, 1), 1, sh, i + 0.5);   // the white-hot core
    fxCone(F, i*3 + 2, P, D, rad*0.25, rad*1.45, cl(kk*0.9, 0, 1), 2, 0, i + 0.25);   // the glow ring round the nozzle
    // its halo, just out of the nozzle
    pp[i*3] = P.x + D.x*0.03*k; pp[i*3 + 1] = P.y + D.y*0.03*k; pp[i*3 + 2] = P.z + D.z*0.03*k;
    pc[i*4] = 0.55 + g.r*0.45; pc[i*4 + 1] = 0.55 + g.g*0.45; pc[i*4 + 2] = 0.55 + g.b*0.45; pc[i*4 + 3] = cl(kk*0.7, 0, 0.9);
    ps[i] = k*(palm ? 0.32 : 0.45)*(0.6 + 0.4*cl(kk, 0, 1.3))*(1 + flick*0.12*Math.sin(t*23 + i));
  }
  // the ribbons: at cruise and boost each boot drops a sample at its flame's tail every 1/30 s; segment j joins sample j
  // to j + 1, thinning and fading over FX_HIST samples
  var rib = !calm && c > 0.5 && th > 0.4, R = F.rh, base = 12;
  F.racc += dt;
  if(rib && F.racc >= 1/30){
    F.racc = 0; F.rk = (F.rk + 1) % FX_HIST; F.rn = Math.min(FX_HIST, F.rn + 1);
    for(var bb = 0; bb < 2; bb++){ var o3 = (bb*FX_HIST + F.rk)*3, ll = k*(0.5 + 0.6*b); R[o3] = F.nz[bb].x + F.nd[bb].x*ll; R[o3 + 1] = F.nz[bb].y + F.nd[bb].y*ll; R[o3 + 2] = F.nz[bb].z + F.nd[bb].z*ll; }
  }
  if(!rib) F.rn = Math.max(0, F.rn - (dt > 0 ? 1 : 0));
  if(F.racc > 1) F.racc = 0;
  for(var bb2 = 0; bb2 < 2; bb2++) for(var j = 0; j < FX_RIB; j++){
    var n = base + bb2*FX_RIB + j;
    if(j + 1 >= F.rn){ fxOff(F, n); continue; }
    var ia0 = ((F.rk - j) % FX_HIST + FX_HIST) % FX_HIST, ia1 = ((F.rk - j - 1) % FX_HIST + FX_HIST) % FX_HIST, o0 = (bb2*FX_HIST + ia0)*3, o1 = (bb2*FX_HIST + ia1)*3;
    var dx = R[o1] - R[o0], dy = R[o1 + 1] - R[o0 + 1], dz = R[o1 + 2] - R[o0 + 2], dl = Math.sqrt(dx*dx + dy*dy + dz*dz);
    if(!(dl > 1e-4) || dl > 40){ fxOff(F, n); continue; }
    var fade = 1 - j/FX_RIB;
    F.v.set(R[o0], R[o0 + 1], R[o0 + 2]); F.d.set(dx/dl, dy/dl, dz/dl);
    fxCone(F, n, F.v, F.d, dl, k*0.05*(0.4 + 0.6*fade)*(1 + 0.6*b), cl(0.55*fade*fade*th*c, 0, 1), 3, 0, j);
  }
  // the dust ring and the downwash: low over the ground in a hover (or settling), motes and two rings running out from under you
  var agl = fl && fl.agl != null && isFinite(+fl.agl) ? Math.max(0, +fl.agl) : 99, dk = calm ? 0 : cl(1 - agl/3, 0, 1)*(1 - c)*th;
  var ox = (F.nz[0].x + F.nz[1].x)/2, oz = (F.nz[0].z + F.nz[1].z)/2, gy = (F.nz[0].y + F.nz[1].y)/2 - agl + 0.05;
  for(var dw = 0; dw < 2; dw++){
    var nw = base + 2*FX_RIB + dw, ph0 = (t*0.9 + dw*0.5) % 1;
    if(dk < 0.01){ fxOff(F, nw); continue; }
    F.v.set(ox, gy + 0.02, oz); fxCone(F, nw, F.v, F.up, 0.04*k, k*(0.5 + ph0*2.2), cl(dk*0.4*(1 - ph0)*Math.min(1, ph0*5), 0, 1), 4, 0, dw);
  }
  for(var jd = 0; jd < FX_DUST; jd++){
    var q = 4 + jd, ph = (t*0.8 + jd*0.618) % 1, an = jd*2*PI/FX_DUST + Math.sin(jd*12.9)*0.3, rr = k*(0.35 + ph*1.5);
    pp[q*3] = ox + Math.cos(an)*rr; pp[q*3 + 1] = gy + ph*0.12; pp[q*3 + 2] = oz + Math.sin(an)*rr;
    pc[q*4] = 0.62; pc[q*4 + 1] = 0.57; pc[q*4 + 2] = 0.5; pc[q*4 + 3] = dk*0.28*(1 - ph)*Math.min(1, ph*6);
    ps[q] = dk > 0.01 ? k*(0.35 + ph*0.8) : 0;
  }
  F.fl.instanceMatrix.needsUpdate = true; F.ia.needsUpdate = true;
  // the heat trail: a boost sheds a puff from the end of a boot's jet every 1/40 s; each rises a little and fades in 0.7 s
  F.tacc += dt;
  var emit = !calm && b > 0.3 && th > 0.5;
  while(F.tacc > 0.025){ F.tacc -= 0.025; if(!emit) continue;
    var nt = F.tk % FX_TRAIL, bi2 = F.tk & 1, NP = F.nz[bi2], ND = F.nd[bi2], lt = k*0.9;
    F.tp[nt*3] = NP.x + ND.x*lt; F.tp[nt*3 + 1] = NP.y + ND.y*lt; F.tp[nt*3 + 2] = NP.z + ND.z*lt; F.ta[nt] = 0; F.tk++; }
  if(F.tacc > 1) F.tacc = 0;
  for(var u = 0; u < FX_TRAIL; u++){
    var a = F.ta[u] = Math.min(9, F.ta[u] + dt), z = 4 + FX_DUST + u, live = a < 0.7;
    pp[z*3] = F.tp[u*3]; pp[z*3 + 1] = F.tp[u*3 + 1] + a*0.4; pp[z*3 + 2] = F.tp[u*3 + 2];
    pc[z*4] = 0.75 + g.r*0.2; pc[z*4 + 1] = 0.78 + g.g*0.2; pc[z*4 + 2] = 0.85 + g.b*0.15; pc[z*4 + 3] = live ? 0.16*(1 - a/0.7) : 0;
    ps[z] = live ? k*(0.25 + a*1.3) : 0;
  }
  // the spark burst: the moment a boost kicks in, FX_SPARK sparks off both boots (hashed directions, no Math.random), slowing and falling
  var bOn = fl && fl.boost && c > 0.3 ? 1 : 0;
  if(bOn && !F.lb && !calm){
    F.burst++;
    for(var si = 0; si < FX_SPARK; si++){
      var sb = si & 1, r1 = rnd(si, F.burst) - 0.5, r2 = rnd(si + 7, F.burst) - 0.5, r3 = rnd(si + 13, F.burst), SD = F.nd[sb], v0 = k*(6 + 7*r3);
      F.sp[si*3] = F.nz[sb].x; F.sp[si*3 + 1] = F.nz[sb].y; F.sp[si*3 + 2] = F.nz[sb].z;
      F.sv[si*3] = (SD.x + r1*1.1)*v0; F.sv[si*3 + 1] = (SD.y + r2*1.1)*v0 + k*1.5; F.sv[si*3 + 2] = (SD.z + (r1 - r2)*0.8)*v0; F.sa[si] = 0;
    }
  }
  F.lb = bOn;
  var sdr = Math.exp(-3.2*dt);
  for(var sj = 0; sj < FX_SPARK; sj++){
    var sa = F.sa[sj] = Math.min(9, F.sa[sj] + dt), zs = 4 + FX_DUST + FX_TRAIL + sj, sl = sa < 0.55;
    if(sl){ F.sv[sj*3] *= sdr; F.sv[sj*3 + 1] = F.sv[sj*3 + 1]*sdr - 9*k*dt; F.sv[sj*3 + 2] *= sdr;
      F.sp[sj*3] += F.sv[sj*3]*dt; F.sp[sj*3 + 1] += F.sv[sj*3 + 1]*dt; F.sp[sj*3 + 2] += F.sv[sj*3 + 2]*dt; }
    pp[zs*3] = F.sp[sj*3]; pp[zs*3 + 1] = F.sp[sj*3 + 1]; pp[zs*3 + 2] = F.sp[sj*3 + 2];
    pc[zs*4] = 1; pc[zs*4 + 1] = 0.8 + g.g*0.2; pc[zs*4 + 2] = 0.55 + g.b*0.4; pc[zs*4 + 3] = sl ? 0.95*(1 - sa/0.55) : 0;
    ps[zs] = sl ? k*0.09*(1.4 - sa) : 0;
  }
  F.pp.needsUpdate = true; F.pc.needsUpdate = true; F.ps.needsUpdate = true;
}

/* ---------- the suit-up: every piece its own mesh, flying from `from` onto its bone on your posed body ---------- */
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
    var geo = pieceGeo(T, q);
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
  if(M.G) M.G.emissiveIntensity = 0; X.U.uGK.value = 0;
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
  if(!S.rev){ out.eyes = Math.max(0, Math.min(1, (S.t - (S.dur - 0.3))/0.3)); if(G) G.emissiveIntensity = 2.2*out.eyes; S.ch._exo.U.uGK.value = out.eyes; }
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
  X.meshes.forEach(function(m){ m.visible = true; }); if(X.mats.G) X.mats.G.emissiveIntensity = 2.2; X.U.uGK.value = 1;
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

/* ---------- the customiser's live preview: your own character in the suit, on its own tiny renderer ----------
   preview(host, look, opts) -> PV {set(look), fly(on), frame(t, dt), destroy()} | null. opts {spec, seed} your avatar3d
   spec (games/avatar3d.js build, as hq3d makes you), and for tests {A3, renderer(canvas, THREE), raf}. A 300x220 canvas,
   a WebGLRenderer of its own, the avatar wearing the look through wear() (so every pick shows at once); it turns slowly,
   drags to turn, and "Fly pose" puts it in the cruise pose with the thrusters lit. It draws only while the panel is open;
   destroy() strips the suit (its geometries, materials and the thrusters' buffers), frees the skeletons' bone textures and
   disposes the renderer and its context. No WebGL (or no avatar3d): null, and the panel is as it was. */
var PV_W = 300, PV_H = 220;
function preview(host, look, opts){
  opts = opts || {};
  var doc = G.document, A3 = opts.A3 || HQV.avatar3d; if(!doc || !host || !A3 || !A3.build) return null;
  var cv = doc.createElement("canvas"); if(!cv || !cv.getContext) return null;
  cv.width = PV_W; cv.height = PV_H;
  var gl = null; try { gl = opts.renderer ? true : cv.getContext("webgl2", {antialias: true, alpha: true}); } catch(e){ gl = null; }
  if(!gl) return null;
  cv.setAttribute("aria-label", "Live preview of your suit: drag to turn"); cv.setAttribute("role", "img");
  if(cv.style) cv.style.cssText = "display:block;width:100%;max-width:" + PV_W + "px;aspect-ratio:" + PV_W + "/" + PV_H + ";margin:8px auto 0;border-radius:8px;" +
    "background:radial-gradient(circle at 50% 60%,#173241,#070d12 75%);cursor:grab;touch-action:none";
  host.appendChild(cv);
  var raf = opts.raf !== undefined ? opts.raf : G.requestAnimationFrame ? G.requestAnimationFrame.bind(G) : null;
  var caf = G.cancelAnimationFrame ? G.cancelAnimationFrame.bind(G) : function(){};
  var PV = {cv: cv, ch: null, R: null, sc: null, cam: null, T: null, look: clean(look), flying: false, yaw: 0.6, drag: null, id: 0, alive: true, t: 0, last: 0, err: null};
  function fit(){
    var F = FRAMES[PV.look.f], k = F.h, cam = PV.cam; if(!cam) return;
    // standing: the whole figure; flying: lower and a little further (the body lies along the view)
    if(PV.flying) cam.position.set(0, 0.62*k, 2.35*k); else cam.position.set(0, 0.5*k, 2.15*k);
    cam.lookAt(0, (PV.flying ? 0.34 : 0.4)*k, 0);
  }
  function dress(){
    var ch = PV.ch; if(!ch || !PV.T) return;
    wear(PV.T, ch, PV.look);
    ch._fly = PV.flying ? {mode: "cruise", speed: 40, agl: 12, turn: 0, vs: 0} : null;
    fit();
  }
  PV.frame = function(t, dt){
    if(!PV.alive || !PV.ch || !PV.R) return;
    var ch = PV.ch, E = HQV.engine, calm = !!(E && E.calm && E.calm());
    dt = Math.max(0, Math.min(0.1, fin(dt)));
    if(PV.drag == null && !calm) PV.yaw += dt*0.45;
    ch.o.rotation.y = PV.yaw;
    if(ch.mixer && !calm) ch.mixer.update(dt);
    if(ch.update) ch.update(fin(t));
    PV.R.render(PV.sc, PV.cam);
  };
  function loop(now){
    if(!PV.alive) return;
    PV.id = raf ? raf(loop) : 0;
    var t = fin(now)/1000, dt = PV.last ? t - PV.last : 1/60; PV.last = t;
    try { PV.frame(t, dt); } catch(e){ PV.err = e; PV.alive = false; }
  }
  PV.set = function(o){ PV.look = clean(o); dress(); if(!raf) PV.frame(PV.t += 1/60, 1/60); };
  PV.fly = function(on){ PV.flying = !!on; dress(); if(!raf) PV.frame(PV.t += 1/60, 1/60); };
  PV.destroy = function(){
    if(!PV.alive && !PV.R && !PV.ch) return;
    PV.alive = false; if(PV.id) caf(PV.id); PV.id = 0;
    var ch = PV.ch; PV.ch = null;
    if(ch){
      strip(ch);
      if(ch.mixer && ch.mixer.stopAllAction) ch.mixer.stopAllAction();
      ch.o.traverse(function(n){ if(n.isSkinnedMesh && n.skeleton && n.skeleton.dispose) n.skeleton.dispose(); });
      if(ch.o.parent) ch.o.parent.remove(ch.o);
    }
    if(PV.R){ try { PV.R.dispose(); if(PV.R.forceContextLoss) PV.R.forceContextLoss(); } catch(e){} PV.R = null; }
    if(cv.parentNode) cv.parentNode.removeChild(cv);
  };
  cv.addEventListener("pointerdown", function(e){ PV.drag = e.clientX; if(cv.style) cv.style.cursor = "grabbing"; try { cv.setPointerCapture(e.pointerId); } catch(x){} });
  cv.addEventListener("pointermove", function(e){ if(PV.drag != null){ PV.yaw += (e.clientX - PV.drag)*0.012; PV.drag = e.clientX; } });
  cv.addEventListener("pointerup", function(){ PV.drag = null; if(cv.style) cv.style.cursor = "grab"; });
  var spec = opts.spec && (!A3.valid || A3.valid(opts.spec)) ? opts.spec : A3.fromSeed ? A3.fromSeed(String(opts.seed || "you")) : opts.spec;
  var pr; try { pr = A3.build(spec); } catch(e){ pr = null; }
  if(!pr || !pr.then){ PV.destroy(); return null; }
  pr.then(function(ch){
    if(!PV.alive){ return; }
    var T = (ch.L && ch.L.THREE) || opts.THREE || G.THREE; if(!T){ PV.destroy(); return; }
    PV.T = T;
    try {
      PV.R = opts.renderer ? opts.renderer(cv, T) : new T.WebGLRenderer({canvas: cv, antialias: true, alpha: true});
      if(PV.R.setPixelRatio) PV.R.setPixelRatio(Math.min(2, G.devicePixelRatio || 1));
      if(PV.R.setSize) PV.R.setSize(PV_W, PV_H, false);
      if(T.SRGBColorSpace) PV.R.outputColorSpace = T.SRGBColorSpace;
    } catch(e){ PV.destroy(); return; }
    var sc = PV.sc = new T.Scene();
    sc.add(new T.HemisphereLight(0xffffff, 0x4a5868, 1.5));
    var d = new T.DirectionalLight(0xffffff, 2.2); d.position.set(1.4, 2.2, 2.4); sc.add(d);
    var rim = new T.DirectionalLight(0x9fd8ff, 1.1); rim.position.set(-2, 1.5, -1.8); sc.add(rim);
    PV.cam = new T.PerspectiveCamera(30, PV_W/PV_H, 0.05, 30);
    PV.ch = ch; ch.o.scale.setScalar(ch.base || 1); sc.add(ch.o);
    if(ch.acts && ch.acts.idle) ch.acts.idle.play();
    dress();
    if(raf) PV.id = raf(loop); else PV.frame(PV.t += 1/60, 1/60);
  }, function(){ PV.destroy(); });
  return PV;
}

/* ---------- the customiser (DOM; hq3d keeps the keys off you while it is open) ---------- */
var PANEL = null, PVW = null;
function hex(n){ return "#" + ("00000" + (n >>> 0).toString(16)).slice(-6); }
// panel(look, onPick, onSuit, opts): opts {spec, seed} for the live preview (preview() above), when there is WebGL
function panel(look, onPick, onSuit, opts){
  var doc = G.document; if(!doc) return null;
  panelClose();
  var cur = clean(look), el = doc.createElement("div"), fly = false;
  el.className = "hqs hqexo-panel";
  el.style.cssText = "position:fixed;right:16px;top:72px;z-index:99;width:min(340px,calc(100vw - 32px));max-height:calc(100vh - 100px);overflow:auto;" +
    "background:rgba(8,14,20,.94);color:#e8eef3;border:1px solid #2b3b4a;border-radius:10px;padding:12px 14px;font:13px system-ui,sans-serif;box-shadow:0 8px 30px rgba(0,0,0,.5)";
  el.innerHTML = "<div style=\"display:flex;justify-content:space-between;align-items:center\"><b style=\"font-size:15px\">Suit-Up Centre</b>" +
    "<button type=\"button\" data-x=\"close\" aria-label=\"Close\" style=\"background:none;border:0;color:#9fb3c4;font-size:18px;cursor:pointer\">×</button></div>" +
    "<div class=\"hqexo-pv\"></div><div class=\"hqexo-body\"></div>";
  var pvHost = el.querySelector ? el.querySelector(".hqexo-pv") : null, body = el.querySelector ? el.querySelector(".hqexo-body") : el;
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
    body.innerHTML = (PVW ? "<div style=\"display:flex;justify-content:center;margin-top:6px\"><button type=\"button\" data-x=\"fly\" aria-pressed=\"" + fly + "\" style=\"cursor:pointer;border-radius:6px;padding:3px 10px;" +
        "border:1px solid " + (fly ? "#4fd8ff" : "#2b3b4a") + ";background:" + (fly ? "#12303d" : "#101a22") + ";color:#e8eef3\">Fly pose</button></div>" : "") +
      row("Frame", FRAMES, "f", false) +
      "<div style=\"margin-top:8px;color:#c9d6e2\"><b>" + F.n + "</b> · " + F.t + "<br><span style=\"color:#9fb3c4\">" + F.d + "</span></div>" +
      "<div style=\"display:grid;grid-template-columns:70px 1fr;gap:3px 8px;margin-top:6px;font-size:12px\">" + ["Speed", "Armour", "Agility", "Power"].map(function(k, i){
        return "<span>" + k + "</span><span style=\"background:#1a2630;border-radius:3px;height:8px;margin-top:4px\"><i style=\"display:block;height:8px;border-radius:3px;background:#4fd8ff;width:" + F.st[i] + "%\"></i></span>"; }).join("") + "</div>" +
      row("Paint", PAINTS, "p", true) + row("Finish", FINISHES, "fin", false) + row("Glow and HUD tint", GLOWS, "g", true) +
      "<button type=\"button\" data-x=\"suit\" style=\"margin-top:12px;width:100%;padding:8px;border-radius:7px;border:0;background:#4fd8ff;color:#05121a;font-weight:700;cursor:pointer\">" +
      (HQV.hqExo.me && HQV.hqExo.me.on ? "Apply to my suit" : "Suit up") + "</button><div style=\"margin-top:6px;font-size:11px;color:#7f93a4\">Free: every frame, paint and finish. Esc closes.</div>";
  }
  el.addEventListener("click", function(e){
    var b = e.target && e.target.closest ? e.target.closest("button") : null; if(!b) return;
    if(b.getAttribute("data-x") === "close"){ panelClose(); return; }
    if(b.getAttribute("data-x") === "suit"){ panelClose(); if(onSuit) onSuit(cur); return; }
    if(b.getAttribute("data-x") === "fly"){ fly = !fly; if(PVW) PVW.fly(fly); draw(); return; }
    var k = b.getAttribute("data-k"); if(!k) return;
    cur[k] = +b.getAttribute("data-i");
    if(k === "f"){ cur.p = FRAMES[cur.f].paint; cur.fin = FRAMES[cur.f].fin; }
    cur = save(cur); draw(); if(PVW) PVW.set(cur); if(onPick) onPick(cur);
  });
  doc.body.appendChild(el); PANEL = el;
  try { PVW = pvHost ? preview(pvHost, cur, opts) : null; } catch(e){ PVW = null; }
  draw();
  return el;
}
function panelOpen(){ return !!(PANEL && PANEL.parentNode); }
function panelClose(){
  if(PVW){ try { PVW.destroy(); } catch(e){} PVW = null; }
  if(PANEL && PANEL.parentNode) PANEL.parentNode.removeChild(PANEL); PANEL = null;
}

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
  decode: decode, sig: sig, load: load, save: save, styleFor: styleFor, wear: wear, strip: strip, stats: stats, pose: pose, measure: measure, targets: targets, bankFor: bankFor, BANK_MAX: BANK_MAX,
  seq: seq, seqStep: seqStep, seqEnd: seqEnd, FX: {N: FX_N, I: FX_I, DUST: FX_DUST, TRAIL: FX_TRAIL, SPARK: FX_SPARK, RIB: FX_RIB}, KNEE: KNEE, EYE: [EYE_X, EYE_Y], bay: bay, panel: panel, panelOpen: panelOpen, panelClose: panelClose, preview: preview, previewRef: function(){ return PVW; },
  peer: peer, wanted: wanted, me: me, bayRef: null, hex: hex};
})();
