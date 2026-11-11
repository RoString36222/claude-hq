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
 *   park(T, ch) / unpark(P) / dockRig(T)   [3.38.0] the suit parked on your roof's dock, and its gantry; parked() / setParked(yaw)
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
var UNDER = 0x1c2026, SUIT = 0x30363f;      // the plates' dark parts; the undersuit the body's clothes turn to

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
function raw(){ try { var v = JSON.parse(G.localStorage.getItem(KEY) || "{}"); return v && typeof v === "object" ? v : {}; } catch(e){ return {}; } }
function pkOf(v){ return typeof v === "number" && isFinite(v) ? v : null; }
function save(o){ var c = clean(o), w = clean(c), pk = pkOf(raw().pk); if(pk != null) w.pk = pk; try { G.localStorage.setItem(KEY, JSON.stringify(w)); } catch(e){} return c; }
// [3.38.0] the suit parked on your roof's dock: its yaw (rad), kept beside the look; null when it is not parked
function parked(){ return pkOf(raw().pk); }
function setParked(yaw){ var w = clean(raw()), pk = pkOf(+yaw); if(yaw != null && pk != null) w.pk = pk; try { G.localStorage.setItem(KEY, JSON.stringify(w)); } catch(e){} return parked(); }
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
function measureK(T, o){
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
function specK(F, M){
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
/* ---------- fitting the humanoid (games/people3d.js, ch.rig "uni"): the primary body since HQ 3.41 ----------
   The Quaternius rig binds in a T-pose facing +Z (arms along +-X, palms down, legs down -Y, the Foot bones IK controls
   under Root at the soles). Each piece is built in that bind space from the skin each bone (or a band of the spine)
   carries, robustly (quantiles, so a strap, a hood or a bag doesn't stretch a plate), and skinned rigidly to its bone.
   The helmet is built in the Head bone's own space round our toy head (ch.head {c, rx, ry, rz}; the bone draws it 2x),
   so it scales with the head exactly. While suited the body's clothes and skin turn to the dark undersuit (gloves,
   collar, the gaps at the joints) and the toy head, its hair and its hat hide under the helmet. */
var UNI = ["Root", "Body", "Hips", "Abdomen", "Torso", "Chest", "Neck", "Head", "ShoulderL", "ShoulderR", "UpperArmL", "UpperArmR",
           "LowerArmL", "LowerArmR", "WristL", "WristR", "UpperLegL", "UpperLegR", "LowerLegL", "LowerLegR", "FootL", "FootR"];
var DIGITS = ["Index", "Middle", "Ring", "Pinky", "Thumb"];
var SPINE = {Body: 1, Hips: 1, Abdomen: 1, Torso: 1, Chest: 1, Neck: 1, ShoulderL: 1, ShoulderR: 1};
function pct(a, k){ if(!a.length) return 0; var s = a.slice().sort(function(x, y){ return x - y; }); return s[Math.max(0, Math.min(s.length - 1, Math.round(k*(s.length - 1))))]; }
// a robust box [x0, y0, z0, x1, y1, z1] of a flat xyz list: the lo / hi quantile on each axis
function rbox(P, lo, hi){
  if(!P || P.length < 12) return null;
  var xs = [], ys = [], zs = []; for(var i = 0; i < P.length; i += 3){ xs.push(P[i]); ys.push(P[i + 1]); zs.push(P[i + 2]); }
  return [pct(xs, lo), pct(ys, lo), pct(zs, lo), pct(xs, hi), pct(ys, hi), pct(zs, hi)];
}
function sideOf(n){ var c = n.charAt(n.length - 1); return c === "L" ? "L" : c === "R" ? "R" : ""; }
function measureU(T, ch, skins, body, sk, bi){
  var toBody = new T.Matrix4().copy(body.bindMatrix).invert(), m = new T.Matrix4(), v = new T.Vector3(), bw = {}, P = {}, Q = {}, sc = new T.Vector3();
  sk.bones.forEach(function(b, i){
    if(bw[b.name]) return;
    var w = new T.Matrix4().copy(sk.boneInverses[i]).invert().premultiply(toBody); bw[b.name] = w;
    P[b.name] = new T.Vector3(); Q[b.name] = new T.Quaternion(); w.decompose(P[b.name], Q[b.name], sc);
  });
  // every visible skin vertex to the bone that carries most of it (hidden: the pack's own head, replaced by the toy one)
  var pts = {}, headP = [];
  skins.forEach(function(s){
    var vis = true; for(var o = s; o; o = o.parent) if(o.visible === false){ vis = false; break; }
    m.multiplyMatrices(toBody, s.bindMatrix);
    var A = s.geometry.attributes, Pp = A.position, I = A.skinIndex, W = A.skinWeight; if(!Pp || !W || !I) return;
    for(var i = 0; i < Pp.count; i++){
      var best = -1, j = 0;
      for(var k = 0; k < 4; k++){ var wt = W.getComponent(i, k); if(wt > best){ best = wt; j = I.getComponent(i, k); } }
      var bn = s.skeleton.bones[j]; if(!bn) continue;
      v.fromBufferAttribute(Pp, i).applyMatrix4(m); if(!isFinite(v.x + v.y + v.z)) continue;
      if(bn.name === "Head"){ headP.push(v.x, v.y, v.z); if(!vis) continue; }
      if(!vis) continue;
      (pts[bn.name] || (pts[bn.name] = [])).push(v.x, v.y, v.z);
    }
  });
  function ok(b){ return b && b[3] - b[0] > 0.01 && b[4] - b[1] > 0.01 && b[5] - b[2] > 0.01 && b[3] - b[0] < 3 && b[4] - b[1] < 3; }
  // a bone's box on the left side (the right one mirrored when the left has no skin), or a stand-in round the bone
  function limb(n, lo, hi, def){
    var L = rbox(pts[n + "L"], lo, hi), R = rbox(pts[n + "R"], lo, hi);
    if(ok(L)) return L; if(ok(R)) return [-R[3], R[1], R[2], -R[0], R[4], R[5]];
    var c = P[n + "L"]; return c ? [c.x - def, c.y - def, c.z - def, c.x + def, c.y + def, c.z + def] : null;
  }
  var hand = [];
  Object.keys(pts).forEach(function(k){ if(sideOf(k) === "L" && (k === "WristL" || DIGITS.some(function(d){ return k.indexOf(d) === 0; }))) hand.push.apply(hand, pts[k]); });
  var spine = []; Object.keys(SPINE).forEach(function(k){ if(pts[k]) spine.push.apply(spine, pts[k]); });
  // a band of the trunk between two heights: x half-width (symmetric) and z from the back to the front
  function band(y0, y1){
    var xs = [], zs = []; for(var i = 0; i < spine.length; i += 3){ var y = spine[i + 1]; if(y >= y0 && y <= y1){ xs.push(Math.abs(spine[i])); zs.push(spine[i + 2]); } }
    if(xs.length < 8) return {hw: 0.13, z0: P.Chest.z - 0.1, z1: P.Chest.z + 0.12, y0: y0, y1: y1};
    return {hw: pct(xs, 0.97), z0: pct(zs, 0.03), z1: pct(zs, 0.97), y0: y0, y1: y1};
  }
  var H = ch && ch.head && ch.head.c && isFinite(ch.head.rx) ? {c: ch.head.c.clone(), rx: ch.head.rx, ry: ch.head.ry, rz: ch.head.rz} : null;
  if(!H){
    // no toy head: the box of the Head bone's own skin, in the bone's space
    var hb = new T.Box3(), inv = new T.Matrix4().copy(bw.Head).invert();
    for(var i = 0; i < headP.length; i += 3) hb.expandByPoint(v.set(headP[i], headP[i + 1], headP[i + 2]).applyMatrix4(inv));
    if(hb.isEmpty()) hb.set(new T.Vector3(-0.1, 0, -0.1), new T.Vector3(0.1, 0.25, 0.1));
    var hs = hb.getSize(new T.Vector3()); H = {c: hb.getCenter(new T.Vector3()), rx: hs.x/2, ry: hs.y/2, rz: hs.z/2};
  }
  var yN = P.Neck.y, yC = P.Chest.y, yT = P.Torso.y, yA = P.Abdomen.y, yH = P.Hips.y;
  return {rig: "uni", body: body, sk: sk, bi: bi, bw: bw, P: P, Q: Q, head: H, hb: bw.Head,
          chest: band(yC - 0.07, yN), ribs: band(yT, yC - 0.07), abs: band(yA, yT), pelvis: band(yH - 0.07, yA),
          ua: limb("UpperArm", 0.03, 0.97, 0.05), la: limb("LowerArm", 0.03, 0.97, 0.045), hand: rbox(hand, 0.01, 0.99) || [P.WristL.x, P.WristL.y - 0.03, P.WristL.z - 0.05, P.WristL.x + 0.2, P.WristL.y + 0.03, P.WristL.z + 0.06],
          ul: limb("UpperLeg", 0.03, 0.97, 0.08), ll: limb("LowerLeg", 0.03, 0.97, 0.06), foot: limb("Foot", 0.01, 0.99, 0.06), legLen: ch && ch.legLen};
}
// the uni pieces: as specK's, plus q[14] the frame they are written in (the head's: the Head bone's space) when not bind space
function specU(F, M){
  var b = Math.min(F.b, 1.3), has = function(k){ return F.x.indexOf(k) >= 0; }, fist = has("fists") ? 1.35 : 1, P = [], K = KIND, J = M.P, t = 0.02*b;
  function p(bone, shape, key, x, y, z, rx, ry, rz, sx, sy, sz, grp, kind, fr){ P.push([bone, shape, key, x, y, z, rx || 0, ry || 0, rz || 0, sx || 1, sy || 1, sz || 1, grp | 0, kind | 0, fr || null]); }
  // the helmet, in the head bone's space round the toy head (c, rx, ry, rz): a skull-shaped shell a little over the hair,
  // a faceplate standing proud of it, slanted eye slits, a crest and an ear disc each side; a gorget closes the neck
  var H = M.head, c = H.c, rx = H.rx, ry = H.ry, rz = H.rz, e = 1.1, hf = M.hb;
  p("Head", ["k", rx*e, ry*e, rz*e, 22, 16], "A", c.x, c.y + ry*0.02, c.z, 0, 0, 0, 1, 1, 1, 7, K.helmet, hf);
  p("Head", ["s", 1, 20, 14], "B", c.x, c.y - ry*0.3, c.z + rz*0.66, -0.06, 0, 0, rx*0.88, ry*0.74, rz*0.5, 8, K.face, hf);
  p("Head", ["r", rx*1.12, ry*0.22, rz*0.4, 10, 5], "D", c.x, c.y - ry*0.04, c.z + rz*0.86, 0, 0, 0, 1, 1, 1, 8, 0, hf);                 // the dark band the eyes sit in
  p("Head", ["r", rx*0.34, ry*0.05, rz*0.5, 6, 4], "B", c.x, c.y - ry*0.74, c.z + rz*0.82, 0, 0, 0, 1, 1, 1, 8, K.plain, hf);             // the jaw line
  [-1, 1].forEach(function(s){
    p("Head", ["r", rx*0.4, ry*0.12, rz*0.08, 6, 4], "G", c.x + s*rx*0.36, c.y - ry*0.04, c.z + rz*1.1, 0.05, s*0.42, s*0.16, 1, 1, 1, 8, 0, hf);
    p("Head", ["y", ry*0.3, ry*0.3, rx*0.16, 12], "B", c.x + s*rx*e*0.98, c.y - ry*0.08, c.z - rz*0.04, 0, 0, PI/2, 1, 1, 1, 7, K.plain, hf);
    p("Head", ["t", ry*0.22, ry*0.035, 12], "G", c.x + s*rx*(e*0.98 + 0.08), c.y - ry*0.08, c.z - rz*0.04, 0, PI/2, 0, 1, 1, 1, 7, 0, hf);
  });
  p("Head", ["k", rx*0.2, ry*e*1.035, rz*e*1.02, 10, 16], "B", c.x, c.y + ry*0.02, c.z - rz*0.02, 0, 0, 0, 1, 1, 1, 8, K.helmet, hf);  // the crest ridge
  if(has("dome")) p("Head", ["s", 1, 16, 12], "L", c.x, c.y + ry*0.05, c.z + rz*0.05, 0, 0, 0, rx*1.42, ry*1.42, rz*1.42, 8, 0, hf);
  p("Neck", ["y", 0.068*b, 0.078*b, 0.15, 12], "D", 0, J.Neck.y + 0.03, J.Neck.z + 0.01, 0, 0, 0, 1, 1, 1, 7);
  // the trunk: a cuirass over the chest with its plate and core, the ribs, a flexible dark abdomen under four plates, the belt
  var C = M.chest, R = M.ribs, Ab = M.abs, Pv = M.pelvis, cr = has("core") ? 0.055 : 0.036;
  var ch0 = C.y0 - 0.02, ch1 = C.y1 + 0.02, chy = (ch0 + ch1)/2, chz = (C.z0 + C.z1)/2, cf = C.z1 + t;
  p("Chest", ["r", 2*C.hw + 2*t, ch1 - ch0, C.z1 - C.z0 + 2*t, 14, 9], "A", 0, chy, chz, 0, 0, 0, 1, 1, 1, 3, K.cuirass);
  p("Chest", ["r", 2*C.hw*0.78, (ch1 - ch0)*0.62, 0.05, 10, 6], "B", 0, chy + 0.01, cf - 0.012, 0, 0, 0, 1, 1, 1, 3, K.chest);
  p("Chest", ["y", cr, cr, 0.03, 14], "G", 0, chy + 0.01, cf + 0.01, PI/2, 0, 0, 1, 1, 1, 3);
  p("Chest", ["t", cr*1.3, cr*0.2, 14], "B", 0, chy + 0.01, cf + 0.024, 0, 0, 0, 1, 1, 1, 3);
  p("Chest", ["t", cr*1.7, cr*0.08, 14], "G", 0, chy + 0.01, cf + 0.018, 0, 0, 0, 1, 1, 1, 3);
  p("Torso", ["r", 2*R.hw + 1.6*t, R.y1 - R.y0 + 0.03, R.z1 - R.z0 + 1.6*t, 12, 7], "A", 0, (R.y0 + R.y1)/2, (R.z0 + R.z1)/2, 0, 0, 0, 1, 1, 1, 3, K.cuirass);
  p("Abdomen", ["r", 2*Ab.hw + t, Ab.y1 - Ab.y0 + 0.02, Ab.z1 - Ab.z0 + t, 10, 6], "D", 0, (Ab.y0 + Ab.y1)/2, (Ab.z0 + Ab.z1)/2, 0, 0, 0, 1, 1, 1, 2);
  [-1, 1].forEach(function(s){ [0.28, 0.72].forEach(function(f){
    p("Abdomen", ["r", Ab.hw*0.62, (Ab.y1 - Ab.y0)*0.4, 0.035, 6, 4], "A", s*Ab.hw*0.36, Ab.y0 + (Ab.y1 - Ab.y0)*f, Ab.z1 + t*0.5, -0.1, 0, 0, 1, 1, 1, 2, K.plain);
  }); });
  p("Hips", ["r", 2*Pv.hw + 2*t, 0.075, Pv.z1 - Pv.z0 + 2*t, 12, 5], "B", 0, Pv.y1 - 0.04, (Pv.z0 + Pv.z1)/2, 0, 0, 0, 1, 1, 1, 2, K.plain);
  p("Hips", ["y", 0.022, 0.022, 0.012, 10], "G", 0, Pv.y1 - 0.04, Pv.z1 + 2*t - 0.004, PI/2, 0, 0, 1, 1, 1, 2);
  p("Hips", ["r", Pv.hw*0.9, (Pv.y1 - Pv.y0)*0.75, 0.04, 6, 5], "A", 0, Pv.y0 + (Pv.y1 - Pv.y0)*0.32, Pv.z1 + t*0.4, -0.12, 0, 0, 1, 1, 1, 2, K.plain);
  if(has("pack")) p("Chest", ["r", 2*C.hw*0.72, (ch1 - ch0)*0.95, 0.1*b, 10, 6], "D", 0, chy - 0.02, C.z0 - 0.045*b, 0, 0, 0, 1, 1, 1, 6, K.pack);
  // the limbs, the left built and the right mirrored (x -> -x)
  var UA = M.ua, LA = M.la, HB = M.hand, UL = M.ul, LL = M.ll, FT = M.foot;
  var uay = (UA[1] + UA[4])/2, uaz = (UA[2] + UA[5])/2, lay = (LA[1] + LA[4])/2, laz = (LA[2] + LA[5])/2;
  var knx = J.Index2L ? J.Index2L.x : HB[0] + (HB[3] - HB[0])*0.45, hz = (HB[2] + HB[5])/2, hy = (HB[1] + HB[4])/2;
  var ulx = (UL[0] + UL[3])/2, ulz = (UL[2] + UL[5])/2, llx = (LL[0] + LL[3])/2, llz = (LL[2] + LL[5])/2, fx = (FT[0] + FT[3])/2;
  var yK = J.LowerLegL.y, yHip = J.UpperLegL.y;
  [1, -1].forEach(function(s){
    var n = s > 0 ? "L" : "R";
    // shoulder pauldron and the upper arm's plate
    p("UpperArm" + n, ["r", 0.15*b, 0.1*b, UA[5] - UA[2] + 0.07*b, 9, 6], "B", s*(UA[0] + 0.07), UA[4] + 0.008, uaz, 0, 0, -s*0.32, 1, 1, 1, 4, K.shoulder);
    p("UpperArm" + n, ["r", (UA[3] - UA[0])*0.62, UA[4] - UA[1] + t, UA[5] - UA[2] + t, 8, 6], "A", s*(UA[0] + (UA[3] - UA[0])*0.6), uay, uaz, 0, 0, 0, 1, 1, 1, 4, K.plain);
    p("LowerArm" + n, ["s", 0.04*b, 8, 6], "D", s*(LA[0] + 0.005), lay, laz - 0.012, 0, 0, 0, 1, 1, 1, 4);
    // the forearm gauntlet, its cuff glow, the back of the hand, knuckle plates and the palm's repulsor
    p("LowerArm" + n, ["r", (LA[3] - LA[0])*0.8, (LA[4] - LA[1] + 1.3*t)*fist, (LA[5] - LA[2] + 1.3*t)*fist, 9, 6], "A", s*(LA[0] + (LA[3] - LA[0])*0.56), lay, laz, 0, 0, 0, 1, 1, 1, 5, K.gauntlet);
    p("LowerArm" + n, ["b", 0.008, (LA[4] - LA[1])*0.8*fist, 0.012], "G", s*(LA[3] - 0.02), lay, LA[5] + 0.6*t*fist, 0, 0, 0, 1, 1, 1, 5);
    p("Wrist" + n, ["r", (knx - HB[0])*1.05*fist, 0.026*fist, (HB[5] - HB[2])*0.82*fist, 7, 4], "A", s*(HB[0] + (knx - HB[0])*0.5), HB[4] + 0.004, hz - 0.01, 0, 0, 0, 1, 1, 1, 5, K.plain);
    ["Index", "Middle", "Ring", "Pinky"].forEach(function(d){
      var a = J[d + "2" + n], z = J[d + "3" + n]; if(!a || !z) return;
      var len = Math.abs(z.x - a.x) + 0.012, mx = (Math.abs(a.x) + Math.abs(z.x))/2;
      p(d + "2" + n, ["r", len, 0.014, 0.024, 5, 3], "B", s*mx, Math.max(a.y, z.y) + 0.016, (a.z + z.z)/2, 0, 0, 0, 1, 1, 1, 5, K.plain);
    });
    if(J["Thumb2" + n]) p("Thumb2" + n, ["r", 0.03, 0.018, 0.026, 5, 3], "B", s*Math.abs(J["Thumb2" + n].x), J["Thumb2" + n].y + 0.006, J["Thumb2" + n].z + 0.01, 0, s*0.6, 0, 1, 1, 1, 5, K.plain);
    p("Wrist" + n, ["y", 0.024*fist, 0.024*fist, 0.008, 12], "G", s*(HB[0] + (knx - HB[0])*0.55), HB[1] - 0.002, hz, 0, 0, 0, 1, 1, 1, 5);
    // thigh, knee cop, shin, the boot (its top on the shin, the boot and sole on the foot), the sole's jet ring
    p("UpperLeg" + n, ["r", (UL[3] - UL[0])*0.92 + t, (yHip - yK)*0.56, (UL[5] - UL[2])*0.82 + t, 9, 6], "A", s*ulx, yK + (yHip - yK)*0.45, ulz + (UL[5] - UL[2])*0.06, 0, 0, 0, 1, 1, 1, 1, K.plain);
    p("LowerLeg" + n, ["r", (LL[3] - LL[0])*0.75, 0.1, 0.05, 7, 5], "B", s*llx, yK - 0.005, LL[5] + 0.012, 0.25, 0, 0, 1, 1, 1, 1, K.plain);
    p("LowerLeg" + n, ["r", LL[3] - LL[0] + t, (yK - 0.18)*0.82, LL[5] - LL[2] + t, 9, 6], "A", s*llx, 0.18 + (yK - 0.18)*0.45, llz + 0.004, 0, 0, 0, 1, 1, 1, 1, K.shin);
    p("LowerLeg" + n, ["r", LL[3] - LL[0] + 1.8*t, 0.14, LL[5] - LL[2] + 1.8*t, 9, 5], "B", s*llx, 0.13, llz, 0, 0, 0, 1, 1, 1, 0, K.boot);
    p("Foot" + n, ["r", FT[3] - FT[0] + 1.6*t, FT[4] - FT[1] + 0.03, FT[5] - FT[2] + 1.4*t, 9, 6], "B", s*fx, (FT[1] + FT[4])/2 + 0.012, (FT[2] + FT[5])/2 + 0.004, 0, 0, 0, 1, 1, 1, 0, K.boot);
    p("Foot" + n, ["r", FT[3] - FT[0] + 1.2*t, 0.03, FT[5] - FT[2] + 0.8*t, 8, 3], "D", s*fx, FT[1] + 0.012, (FT[2] + FT[5])/2 + 0.004, 0, 0, 0, 1, 1, 1, 0);
    p("Foot" + n, ["t", 0.03, 0.006, 12], "G", s*fx, FT[1] - 0.006, FT[2] + (FT[5] - FT[2])*0.32, PI/2, 0, 0, 1, 1, 1, 0);
    if(has("fins")) p("LowerLeg" + n, ["b", 0.014, (yK - 0.2)*0.7, 0.09], "B", s*(LL[3] + 0.02), 0.2 + (yK - 0.2)*0.45, llz - 0.03, -0.25, 0, 0, 1, 1, 1, 1);
    if(has("wings")) p("Chest", ["b", 0.42, 0.016, 0.16], "B", s*(C.hw*0.4 + 0.2), chy + 0.06, C.z0 - 0.05, 0, -s*0.15, s*0.3, 1, 1, 1, 6);
    if(has("tanks")) p("Chest", ["y", 0.045, 0.045, (ch1 - ch0)*1.05, 12], "B", s*C.hw*0.42, chy - 0.03, C.z0 - 0.05, 0, 0, 0, 1, 1, 1, 6);
  });
  return P;
}
// measure(T, o, ch) -> M: the uni rig's (M.rig "uni") when the skeleton has it, else the Kenney one's; spec(F, M) its pieces
function measure(T, o, ch){
  var skins = [];
  o.traverse(function(n){ if(n.isSkinnedMesh && n.skeleton && n.geometry && n.geometry.attributes.skinIndex && !n.userData.exo) skins.push(n); });
  var body = skins.filter(function(n){ return n.visible && /body/i.test(n.name); })[0] || skins.filter(function(n){ return n.visible; })[0] || skins[0];
  if(!body) return null;
  var sk = body.skeleton, bi = {};
  sk.bones.forEach(function(b, i){ if(bi[b.name] == null) bi[b.name] = i; });
  if(UNI.every(function(n){ return bi[n] != null; })) return measureU(T, ch, skins.filter(function(s){ return s.skeleton === sk || s.skeleton.bones[0] === sk.bones[0]; }), body, sk, bi);
  return measureK(T, o);
}
function spec(F, M){ return M && M.rig === "uni" ? specU(F, M) : specK(F, M); }
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
  if(s[0] === "k"){
    // a skull: people3d's toy head shape (a sphere, the jaw a little narrower) at radii s[1..3]
    var gk = new T.SphereGeometry(1, s[4] || 16, s[5] || 12), ak = gk.attributes.position;
    for(var ik = 0; ik < ak.count; ik++){ var dy = ak.getY(ik), jw = dy < 0 ? 1 - 0.16*dy*dy : 1; ak.setXYZ(ik, ak.getX(ik)*s[1]*jw, dy*s[2], ak.getZ(ik)*s[3]*jw); }
    gk.computeVertexNormals(); return gk;
  }
  if(s[0] === "s") return new T.SphereGeometry(s[1], s[2] || (s[1] < 0.03 ? 8 : 16), s[3] || (s[1] < 0.03 ? 6 : 12));
  if(s[0] === "t") return new T.TorusGeometry(s[1], s[2], 3, s[3] || 12);
  if(s[0] === "b") return new T.BoxGeometry(s[1], s[2], s[3]);
  return new T.CylinderGeometry(s[1], s[2], s[3], s[4] || 12);
}
// a piece's matrix into the body's bind space (through its frame q[14], when it is written in a bone's own space)
function local(T, q){
  var m = new T.Matrix4().compose(new T.Vector3(q[3], q[4], q[5]), new T.Quaternion().setFromEuler(new T.Euler(q[6], q[7], q[8])), new T.Vector3(q[9], q[10], q[11]));
  return q[14] ? m.premultiply(q[14]) : m;
}
// where a piece's centre sits in bind space
function centre(T, q){ var v = new T.Vector3(q[3], q[4], q[5]); return q[14] ? v.applyMatrix4(q[14]) : v; }
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
  var P = PAINTS[o.p], eye;
  if(M.rig === "uni"){ var H = M.head, ec = new T.Vector3(H.c.x, H.c.y - H.ry*0.04, H.c.z + H.rz*1.1).applyMatrix4(M.hb); eye = new T.Vector4(ec.x, ec.y, ec.z, H.rx*0.36); }
  else { var Hk = M.head, hw = Hk[3] - Hk[0], hh = Math.min(Hk[4] - Hk[1], hw*1.05); eye = new T.Vector4((Hk[0] + Hk[3])/2, Hk[1] + hh*EYE_Y, Hk[5] + 0.03*0.55 + 0.02, hw*EYE_X); }
  return {uGlow: {value: new T.Color(GLOWS[o.g][1])}, uC1: {value: new T.Color(P[1])}, uC2: {value: new T.Color(P[2])}, uGK: {value: 1}, uT: {value: 0},
          uDec: {value: o.f}, uEye: {value: eye}};
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
  var M = measure(T, ch.o, ch); if(!M) return false;
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
  // (the uni rig: the whole toy head, its hair and hat), and the body's clothes and skin turn to the undersuit
  var uni = M.rig === "uni", head = M.sk.bones[M.bi[uni ? "Head" : "head"]], hid = [], recol = [];
  head.children.forEach(function(c){ if(!c.isBone && !c.userData.exo){ hid.push([c, c.visible]); c.visible = false; } });
  if(uni) ch.o.traverse(function(n){
    if(!n.isMesh || n.userData.exo || !n.material || !n.visible) return;
    for(var p0 = n.parent; p0; p0 = p0.parent) if(p0 === head) return;
    (Array.isArray(n.material) ? n.material : [n.material]).forEach(function(m){
      if(!m || !m.color || recol.some(function(r){ return r[0] === m; })) return;
      recol.push([m, m.color.getHex(), m.roughness, m.metalness]);
      var l = m.color.r*0.3 + m.color.g*0.5 + m.color.b*0.2; m.color.setHex(SUIT).multiplyScalar(0.85 + 0.4*l); m.roughness = 0.58; m.metalness = 0.3;
    });
  });
  var J = uni ? jointsU(T, M, ch) : null, rest = {};
  (uni ? J.list : NEED).forEach(function(n){ var bn = M.sk.bones[M.bi[n]]; rest[n] = {q: bn.quaternion.clone(), p: bn.position.clone()}; });
  var s0 = ch.base || ch.o.scale.x || 1;
  ch._exo = {look: o, frame: F, mats: MT, U: U, meshes: meshes, spec: P, M: M, hid: hid, recol: recol, J: J, ch: ch, rest: rest, s0: s0, s1: s0*F.h, up: ch.update, tilt: false, T: T, fx: null,
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
  (X.recol || []).forEach(function(r){ r[0].color.setHex(r[1]); r[0].roughness = r[2]; r[0].metalness = r[3]; });
  if(X.tilt) unTilt(X);
  if(X.snd) sndStop(X);
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
  // the humanoid's joints (rad; games/people3d.js): hipF the thighs forward of the body's line, knee its bend, ankle the
  // toes pointed, lsp the legs apart, aSw the arms forward (- back) and aOut out from the sides, elb the elbows' bend,
  // ext the wrists bent back (palms flat to the jet: down in a hover, back toward the feet in a cruise), land the feet planted
  var hv = m === "hover" ? 1 : 0, ld = m === "landed" ? 1 : 0;
  o.land = ld;
  o.hipF = c ? (b ? -0.04 : -0.07) + br*0.9 : hv ? 0.2 + o.crouch*0.5 : 0;
  o.knee = c ? (b ? 0.03 : 0.14) + br*0.6 : hv ? 0.42 + o.crouch*0.9 : 0;
  o.ankle = c ? (b ? 1.1 : 0.85) : hv ? 0.55 - o.crouch*0.4 : 0;
  o.lsp = c ? (b ? 0.012 : 0.045) + br*0.06 : hv ? 0.1 : ld ? 0.03 : 0;
  o.aSw = c ? (b ? -0.16 : -0.3) + br*0.6 : hv ? 0.1 + o.crouch*0.2 : ld ? 0.3 : 0;
  o.aOut = c ? (b ? 0.07 : 0.2) + br*0.65 : hv ? 0.34 + o.crouch*0.1 : ld ? 0.3 : 0;
  o.elb = c ? (b ? 0.03 : 0.1) + br*0.3 : hv ? 0.3 : ld ? 0.55 : 0;
  o.ext = c ? (b ? 1.0 : 1.25) : hv ? 1.3 : ld ? 0.7 : 0;
  return o;
}
// an exact critically damped step of S[k] (its rate S[kv]) toward goal at w rad/s
function sd(S, k, kv, goal, w, dt){
  var x = S[k], v = S[kv], c = x - goal, t = (v + w*c)*dt, e = Math.exp(-w*dt);
  S[k] = goal + (c + t)*e; S[kv] = (v - w*t)*e;
}
// hover <-> cruise blends slowly (c, tilt), the limbs a little faster; brake its own spring
var SPR = [["c", 2.3], ["b", 3.5], ["swim", 4], ["crouch", 6], ["tilt", 2.6], ["legX", 4], ["splay", 4], ["armSw", 3.8], ["armOut", 3.8],
           ["lead", 3.5], ["thrust", 6], ["bank", 4.5], ["climb", 3], ["slip", 3], ["brake", 4], ["w", 7],
           ["land", 7], ["hipF", 4], ["knee", 5], ["ankle", 4], ["lsp", 4], ["aSw", 3.8], ["aOut", 3.8], ["elb", 4], ["ext", 4.5]];
SPR.forEach(function(p){ p.push(p[0] + "v"); });          // its rate's key, made once
function springs(){ var S = {}; SPR.forEach(function(p){ S[p[0]] = 0; S[p[2]] = 0; }); return S; }
// a bone toward rest x Euler(x, y, z), by w of the way from where the clip left it
function setB(X, n, x, y, z, w){ var b = bone(X, n); X.e.set(x, y, z); X.q.copy(X.rest[n].q).multiply(X.q3.setFromEuler(X.e)); b.quaternion.slerp(X.q, w); }
function arm(X, n, s, swing, out, w){ setB(X, "arm-" + n, -swing, 0, -s*(PI/2 - out), w); }
function unTilt(X){
  Object.keys(X.rest).forEach(function(n){ var b = bone(X, n); if(!b) return; b.quaternion.copy(X.rest[n].q); b.position.copy(X.rest[n].p); });
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
  if(X.J){ poseU(ch, X, S, cl(S.w, 0, 1), t1, dt, calm, on ? fl : null); X.tilt = true; fxStep(ch, X, S, cl(S.w, 0, 1), t1, dt, calm, on ? fl : null); return; }
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

/* ---------- the humanoid's flight pose (rig "uni"): real joints, set in the character's own frame ----------
   "char space" is the Root bone's: +Y up the body, +Z its front, +X its left. Every joint's target is a rotation in
   char space times its bind (T-pose) orientation, put under its parent's current one and slerped from the clip's by w:
   the upper arms aim along a direction (biceps forward), the forearms bend at the elbow, the hands bend back at the
   wrist (palm flat to the jet), the fingers straighten; the legs are a two-bone solve from the hip to an ankle point
   (knees forward), the feet follow the shins with the toes pointed (flat on the ground when they land). Root carries
   the lean, the bank and the climb about the belly, so the whole body (and the IK feet under Root) turns as one.
   Nothing is allocated per frame. */
function jointsU(T, M, ch){
  var bw = M.bw, J = {list: ["Root"], par: {}, cq0: {Root: new T.Quaternion()}, cp0: {Root: new T.Vector3()}, lq0: {}, cq: {}, d0: {}, side: {}, dig: []};
  var names = UNI.slice(1);
  ["L", "R"].forEach(function(sd){ DIGITS.forEach(function(d){ for(var k = 1; k <= 4; k++) if(M.bi[d + k + sd] != null){ names.push(d + k + sd); J.dig.push(d + k + sd); } }); });
  var ri = new T.Matrix4().copy(bw.Root).invert(), m = new T.Matrix4(), sc = new T.Vector3();
  names.forEach(function(n){
    if(M.bi[n] == null || !bw[n]) return;
    m.multiplyMatrices(ri, bw[n]); var p = new T.Vector3(), q = new T.Quaternion(); m.decompose(p, q, sc);
    var b = M.sk.bones[M.bi[n]], pn = b.parent && J.cq0[b.parent.name] ? b.parent.name : "Root";
    J.cp0[n] = p; J.cq0[n] = q; J.cq[n] = new T.Quaternion().copy(q); J.par[n] = pn; J.lq0[n] = J.cq0[pn].clone().invert().multiply(q); J.list.push(n);
  });
  var dir = function(a, b){ return J.cp0[b].clone().sub(J.cp0[a]).normalize(); };
  ["L", "R"].forEach(function(sd){
    J.d0["UpperArm" + sd] = dir("UpperArm" + sd, "LowerArm" + sd);
    J.d0["UpperLeg" + sd] = dir("UpperLeg" + sd, "LowerLeg" + sd);
    var sh = J.cp0["LowerLeg" + sd], ft = J.cp0["Foot" + sd], l1 = sh.distanceTo(J.cp0["UpperLeg" + sd]);
    var l2 = ch && ch.legLen && ch.legLen[sd] > 0.05 ? ch.legLen[sd] : sh.distanceTo(ft)*0.93;
    var pivS = new T.Vector3(0, l2, 0), a0 = pivS.clone().applyQuaternion(J.cq0["LowerLeg" + sd]).add(sh);
    J.d0["LowerLeg" + sd] = a0.clone().sub(sh).normalize();
    J.side[sd] = {l1: l1, l2: l2, pivS: pivS, a0: a0, pivF: a0.clone().sub(ft).applyQuaternion(J.cq0["Foot" + sd].clone().invert())};
  });
  J.piv = J.cp0.Abdomen.clone();
  J.qI = new T.Quaternion(); J.qa = new T.Quaternion(); J.qb = new T.Quaternion(); J.qc = new T.Quaternion(); J.qd = new T.Quaternion(); J.qe = new T.Quaternion();
  J.qr = new T.Quaternion(); J.qs = new T.Quaternion(); J.qn = new T.Quaternion();
  J.m1 = new T.Matrix4(); J.m2 = new T.Matrix4(); J.b1 = new T.Vector3(); J.b2 = new T.Vector3(); J.b3 = new T.Vector3();
  J.va = new T.Vector3(); J.vb = new T.Vector3(); J.vc = new T.Vector3(); J.vd = new T.Vector3(); J.ve = new T.Vector3(); J.vf = new T.Vector3();
  J.X = new T.Vector3(1, 0, 0); J.Y = new T.Vector3(0, 1, 0); J.Z = new T.Vector3(0, 0, 1); J.e = new T.Euler();
  return J;
}
// the bone n to (rotation R in char space) x its bind orientation, w of the way from the clip's; its char orientation kept
function setC(X, J, n, R, w){
  var b = bone(X, n); if(!b) return;
  var pq = J.par[n] === "Root" ? J.qI : J.cq[J.par[n]];
  J.qa.copy(R).multiply(J.cq0[n]); J.qb.copy(pq).invert().multiply(J.qa);
  b.quaternion.slerp(J.qb, w); J.cq[n].copy(pq).multiply(b.quaternion);
}
// a bone's change from its bind orientation, in char space (what its child's targets ride on)
function delta(J, n, out){ return out.copy(J.cq[n]).multiply(J.qn.copy(J.cq0[n]).invert()); }
function basis(J, m, d, n){
  var a = J.b1.copy(d).normalize(), c = J.b2.copy(n).addScaledVector(a, -a.dot(n));
  if(c.lengthSq() < 1e-8){ c.set(0, 1, 0).addScaledVector(a, -a.y); if(c.lengthSq() < 1e-8) c.set(1, 0, 0).addScaledVector(a, -a.x); }
  c.normalize(); return m.makeBasis(a, c, J.b3.crossVectors(a, c));
}
// the rotation taking the frame (d0, n0) onto (d, n): a limb's bind direction onto its aim, its front kept to the front
function frameQ(J, out, d0, n0, d, n){ basis(J, J.m1, d0, n0); basis(J, J.m2, d, n); return out.setFromRotationMatrix(J.m2.multiply(J.m1.transpose())); }
function axisQ(J, out, ax, a){ return out.setFromAxisAngle(ax, a); }
function poseU(ch, X, S, w, t, dt, calm, fl){
  var J = X.J, P = J.cp0, hov = cl(1 - S.c - S.swim, 0, 1), bob = calm ? 0 : Math.sin(t*2.1), sway = calm ? 0 : Math.sin(t*1.3);
  var bk = cl(S.bank, -BANK_MAX, BANK_MAX), land = cl(S.land, 0, 1), cr = cl(S.crouch, 0, 1.2), swim = S.swim > 0.5;
  var spin = fl ? fin(fl.spin) : 0;
  // Root: the lean toward horizontal less the climb, the slip, the bank (about the flight line), about the belly
  var r = bone(X, "Root"), R0 = X.rest.Root.q, h = J.vf.copy(J.piv).multiply(r.scale);
  J.e.set(S.tilt - S.climb, S.slip, -(S.bank + spin), "YZX");
  X.q2.setFromEuler(J.e).multiply(R0);
  X.q.copy(R0).slerp(X.q2, w); r.quaternion.copy(X.q);
  r.position.copy(X.rest.Root.p).add(X.v2.copy(h).applyQuaternion(R0)).sub(h.applyQuaternion(X.q));
  // Body: down into a landing crouch (knees absorb it), leaning in a little; a slow bob in a hover
  var B = bone(X, "Body"), drop = land*cr*0.26 + (1 - land)*cr*0.04;
  axisQ(J, J.qr, J.X, cr*0.32*(0.4 + 0.6*land));
  B.quaternion.slerp(J.qa.copy(J.qr).multiply(J.cq0.Body), w); J.cq.Body.copy(B.quaternion);
  B.position.lerp(J.va.copy(P.Body).add(J.vb.set(0, -drop + hov*bob*0.012, 0)), w);
  // the spine: arched up a little in a cruise (chest proud), curled in a crouch, breathing; a twist into a bank
  var br = calm ? 0 : Math.sin(t*1.7)*(0.02*hov + 0.008*S.c), a1 = -0.05*S.c + cr*0.08 + br, tw = bk*0.07;
  setC(X, J, "Hips", J.qr, w);
  J.qs.copy(J.qr).multiply(J.qc.setFromAxisAngle(J.X, a1)).multiply(J.qd.setFromAxisAngle(J.Y, tw*0.5)); setC(X, J, "Abdomen", J.qs, w);
  J.qs.multiply(J.qc.setFromAxisAngle(J.X, a1 - br*0.5)); setC(X, J, "Torso", J.qs, w);
  J.qs.multiply(J.qc.setFromAxisAngle(J.X, -0.04*S.c + cr*0.05)).multiply(J.qd.setFromAxisAngle(J.Y, tw*0.5)); setC(X, J, "Chest", J.qs, w);
  J.qe.copy(J.qs);                                                     // the chest's: the shoulders ride on it
  // the neck and head look where it flies (up out of the lean) and into a turn
  var look = S.tilt*0.78 - 0.08*S.c;
  J.qs.multiply(J.qc.setFromAxisAngle(J.X, -look*0.45 + cr*0.1 - br*0.4)).multiply(J.qd.setFromAxisAngle(J.Y, -S.slip*0.3 + bk*0.14)); setC(X, J, "Neck", J.qs, w);
  J.qs.multiply(J.qc.setFromAxisAngle(J.X, -look*0.55 + 0.04)).multiply(J.qd.setFromAxisAngle(J.Y, bk*0.18)).multiply(J.qc.setFromAxisAngle(J.Z, -bk*0.1)); setC(X, J, "Head", J.qs, w);
  // the arms
  var ph = 0, spn = 0, kick = 0;
  if(swim){ X.ph = ((X.ph || 0) + dt*0.7) % 1; ph = X.ph; spn = Math.sin(ph*2*PI); kick = calm ? 0 : Math.sin(t*7); }
  for(var k = 0; k < 2; k++){
    var s = k ? -1 : 1, n = k ? "R" : "L";
    var sw = swim ? 2.4 - spn*0.9 : S.aSw + hov*bob*0.03, out = swim ? 0.5 + spn*0.4 : S.aOut + s*bk*0.14 + hov*sway*0.03*s;
    var elb = swim ? 0.3 : S.elb, ext = swim ? 0.15 : S.ext;
    setC(X, J, "Shoulder" + n, J.qe, w);
    J.vc.set(s*Math.sin(out)*Math.cos(sw), -Math.cos(out)*Math.cos(sw), Math.sin(sw));
    frameQ(J, J.qr, J.d0["UpperArm" + n], J.Z, J.vc, J.Z); setC(X, J, "UpperArm" + n, J.qr, w);
    delta(J, "UpperArm" + n, J.qr).multiply(J.qc.setFromAxisAngle(J.Y, -s*elb)); setC(X, J, "LowerArm" + n, J.qr, w);
    delta(J, "LowerArm" + n, J.qr).multiply(J.qc.setFromAxisAngle(J.Z, s*ext)); setC(X, J, "Wrist" + n, J.qr, w);
  }
  // the fingers straight and together (a flat hand on the repulsor), the thumbs along them
  for(var f = 0; f < J.dig.length; f++){ var fb = bone(X, J.dig[f]); if(fb) fb.quaternion.slerp(J.lq0[J.dig[f]], w*0.9); }
  // the legs: hip -> knee -> ankle point; in the air the ankle hangs off the hip (forward hipF, bent by knee), on landing
  // it stays where the foot stands in the bind pose while the body drops
  var hip = J.vd, A = J.va, K = J.vb;
  for(var g = 0; g < 2; g++){
    var sg = g ? -1 : 1, m = g ? "R" : "L", L = J.side[m], UL = bone(X, "UpperLeg" + m), LL = bone(X, "LowerLeg" + m), FT = bone(X, "Foot" + m);
    if(!UL || !LL || !FT) continue;
    var hf = swim ? 0.05 + sg*kick*0.22 : S.hipF + (hov ? sg*sway*0.02 : 0), kn = swim ? 0.25 + 0.15*Math.max(0, sg*kick) : S.knee, sp2 = swim ? 0.06 : S.lsp;
    hip.copy(UL.position).applyQuaternion(J.cq.Body).add(B.position);
    var dd = Math.sqrt(Math.max(1e-6, L.l1*L.l1 + L.l2*L.l2 + 2*L.l1*L.l2*Math.cos(cl(kn, 0, 2.4))));
    A.set(sg*Math.sin(sp2), -Math.cos(hf), Math.sin(hf)).normalize().multiplyScalar(dd).add(hip);
    if(land > 0) A.lerp(J.vc.copy(L.a0).add(J.ve.set(sg*0.015, 0, 0)), land);
    // the two-bone solve, the knee toward the front
    var u = J.vc.copy(A).sub(hip), d = cl(u.length(), Math.abs(L.l1 - L.l2) + 1e-4, L.l1 + L.l2 - 1e-4); u.normalize();
    var v = J.ve.copy(J.Z).addScaledVector(u, -u.z); if(v.lengthSq() < 1e-8) v.set(0, 1, 0).addScaledVector(u, -u.y); v.normalize();
    var ca = cl((L.l1*L.l1 + d*d - L.l2*L.l2)/(2*L.l1*d), -1, 1), sa = Math.sqrt(1 - ca*ca);
    K.copy(hip).addScaledVector(u, L.l1*ca).addScaledVector(v, L.l1*sa);
    A.copy(hip).addScaledVector(u, d);
    frameQ(J, J.qr, J.d0["UpperLeg" + m], J.Z, J.vc.copy(K).sub(hip), J.Z); setC(X, J, "UpperLeg" + m, J.qr, w);
    frameQ(J, J.qr, J.d0["LowerLeg" + m], J.Z, J.vc.copy(A).sub(K), J.Z); setC(X, J, "LowerLeg" + m, J.qr, w);
    // where the blended chain ends, and the foot on it: the shin's turn, the toes pointed (flat when planted)
    K.copy(LL.position).applyQuaternion(J.cq["UpperLeg" + m]).add(hip);
    A.copy(L.pivS).applyQuaternion(J.cq["LowerLeg" + m]).add(K);
    delta(J, "LowerLeg" + m, J.qr).multiply(J.qc.setFromAxisAngle(J.X, (swim ? 0.7 : S.ankle)*(1 - land))).multiply(J.cq0["Foot" + m]);
    if(land > 0) J.qr.slerp(J.cq0["Foot" + m], land);
    FT.quaternion.slerp(J.qr, w);
    FT.position.lerp(J.vc.copy(L.pivF).applyQuaternion(FT.quaternion).negate().add(A), w);
  }
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
var FX_RIB = 9, FX_HIST = FX_RIB + 1, FX_I = 12 + 2*FX_RIB + 2 + 4;  // instances: flames, ribbons, downwash, heat shimmer (boots, palms)
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
  "  if(ty > 4.5){ float bd = sin(vT*26.0 - uTime*38.0 + vI.w*4.0)*sin(vT*11.0 + uTime*17.0 + vI.w);",                       // heat shimmer: a faint
  "    a = (0.5 + 0.5*bd)*pow(vE, 2.5)*smoothstep(0.0, 0.15, vT)*(1.0 - vT)*k; col = mix(vec3(0.85, 0.88, 0.92), uGlow, 0.2); }",   // rippling sheath
  "  else if(ty > 3.5){ a = exp(-pow((vT - 0.45)*4.0, 2.0))*k; col = vec3(0.62, 0.57, 0.5); }",                            // downwash
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
  if(X.J) return emittersU(T, X);
  var M = X.M, Lg = M.leg, A = M.arm, lx = (Lg.i + Lg.o)/2, lz = (Lg.z0 + Lg.z1)/2, ay = (A.y0 + A.y1)/2, az = (A.z0 + A.z1)/2, J = BOOT_JET;
  var bm = new T.Matrix4(), out = [];
  [["leg-left", Lg.s*lx, Lg.y0, lz, Lg.s*J[0], J[1], J[2]], ["leg-right", -Lg.s*lx, Lg.y0, lz, -Lg.s*J[0], J[1], J[2]],
   ["arm-left", A.s*(A.o + 0.01), ay, az, A.s, 0, 0], ["arm-right", -A.s*(A.o + 0.01), ay, az, -A.s, 0, 0]].forEach(function(q){
    var bi = M.bi[q[0]]; bm.multiplyMatrices(M.sk.boneInverses[bi], M.body.bindMatrix);
    out.push({n: q[0], p: new T.Vector3(q[1], q[2], q[3]).applyMatrix4(bm), d: new T.Vector3(q[4], q[5], q[6]).transformDirection(bm)});
  });
  return out;
}
// the humanoid's: each boot's sole (on the Foot bone) jetting down its shin (the LowerLeg's axis, so the jet follows the
// leg's line whatever the toes do), each palm's centre (on the Wrist) jetting out of the palm
function emittersU(T, X){
  var M = X.M, out = [], inv = new T.Matrix4(), FT = M.foot, HB = M.hand, J = M.P, knx = J.Index2L ? J.Index2L.x : HB[0] + (HB[3] - HB[0])*0.45;
  [1, -1].forEach(function(s){
    var n = s > 0 ? "L" : "R";
    inv.copy(M.bw["Foot" + n]).invert();
    out.push({n: "Foot" + n, p: new T.Vector3(s*(FT[0] + FT[3])/2, FT[1] - 0.004, FT[2] + (FT[5] - FT[2])*0.32).applyMatrix4(inv), dn: "LowerLeg" + n, d: new T.Vector3(0, 1, 0)});
  });
  [1, -1].forEach(function(s){
    var n = s > 0 ? "L" : "R";
    inv.copy(M.bw["Wrist" + n]).invert();
    out.push({n: "Wrist" + n, p: new T.Vector3(s*(HB[0] + (knx - HB[0])*0.55), HB[1] - 0.006, (HB[2] + HB[5])/2).applyMatrix4(inv), d: new T.Vector3(0, -1, 0).transformDirection(inv)});
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
    var e = F.em[i], bn = bone(X, e.n), P = F.nz[i].copy(e.p).applyMatrix4(bn.matrixWorld), D = F.nd[i].copy(e.d).transformDirection(e.dn ? bone(X, e.dn).matrixWorld : bn.matrixWorld);
    var palm = i >= 2, lead = i === 3 && !X.J ? cl(S.lead, 0, 1) : 0;      // the Kenney rig's leading arm (the humanoid tucks both)
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
  // the heat shimmer: a wide, faint, rippling sheath round each jet (no screen copy: it reads as hot air, not a lens)
  for(var hs = 0; hs < 4; hs++){
    var nh = base + 2*FX_RIB + 2 + hs, hp = hs >= 2, hk = th*(hp ? 0.6 : 1)*(hs === 3 && !X.J ? 1 - cl(S.lead, 0, 1) : 1);
    if(calm || hk < 0.05){ fxOff(F, nh); continue; }
    fxCone(F, nh, F.nz[hs], F.nd[hs], k*(hp ? 0.3 + 0.55*c : 0.45 + 1.1*c + 0.8*b)*cl(hk, 0, 1.3), k*(hp ? 0.09 : 0.13)*(1 + 0.4*c), cl(0.1*hk, 0, 0.2), 5, 0, hs + 3.1);
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
    pc[z*4] = 0.45 + g.r*0.4; pc[z*4 + 1] = 0.5 + g.g*0.4; pc[z*4 + 2] = 0.55 + g.b*0.4; pc[z*4 + 3] = live ? 0.06*(1 - a/0.7) : 0;
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

/* ---------- sound: every note synthesised with WebAudio (no files, no network) ----------
   Through the engine's shared output (games/engine.js audioOut: the SFX volume, its limiter, off at 0%, which Calm mode
   and reduced motion default to), and only once the page has had a gesture and the context runs, so nothing starts
   before your first click. sound(ch, dt) each frame for your own suit: the thrusters' hum (filtered noise, a turbine
   whine, a sub rumble) following the jets' thrust, the mode and the speed, a roar the moment a boost kicks in, a thump
   when you land (a Bulwark's heavier); the suit-up's servo whine, a clank per piece locking home and the power-up chirp
   come from seqStep. One looped noise buffer per context, seeded (the same hiss every time). */
var SND = {ctx: null, buf: null, last: 0};
function sndOut(){
  var E = HQV.engine; if(!E || !E.audioOut || !E.sfxVolume || !(E.sfxVolume() > 0)) return null;
  var ua = G.navigator && G.navigator.userActivation; if(ua && !ua.hasBeenActive) return null;
  var o = null; try { o = E.audioOut(); } catch(e){ o = null; }
  return o && o.ctx && o.ctx.state === "running" && o.out ? o : null;
}
function sndBuf(ac){
  if(SND.ctx === ac && SND.buf) return SND.buf;
  var n = Math.floor(ac.sampleRate*2), b = ac.createBuffer(1, n, ac.sampleRate), d = b.getChannelData(0);
  for(var i = 0, s = 0x2f6b1d3 >>> 0; i < n; i++){ s = (Math.imul(s, 1664525) + 1013904223) >>> 0; d[i] = s/2147483648 - 1; }
  SND.ctx = ac; SND.buf = b; return b;
}
function sTone(o, type, f0, f1, dur, vol, at){
  var ac = o.ctx, t = ac.currentTime + (at || 0), os = ac.createOscillator(), g = ac.createGain();
  os.type = type; os.frequency.setValueAtTime(f0, t); if(f1) os.frequency.exponentialRampToValueAtTime(Math.max(20, f1), t + dur);
  g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(vol, t + 0.01); g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  os.connect(g); g.connect(o.out); os.start(t); os.stop(t + dur + 0.05);
}
function sNoise(o, ftype, f0, f1, q, dur, vol, at){
  var ac = o.ctx, t = ac.currentTime + (at || 0), src = ac.createBufferSource(), f = ac.createBiquadFilter(), g = ac.createGain();
  src.buffer = sndBuf(ac); src.loop = true; f.type = ftype; f.Q.value = q || 0.8; f.frequency.setValueAtTime(f0, t);
  if(f1) f.frequency.exponentialRampToValueAtTime(Math.max(30, f1), t + dur);
  g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(vol, t + Math.min(0.08, dur*0.2)); g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  src.connect(f); f.connect(g); g.connect(o.out); src.start(t, (f0*0.37) % 1.5); src.stop(t + dur + 0.05);
}
// the one-shots: servo (the suit-up's whine; k < 0 winding down), clank (a piece home; k its pitch 0..1), power (the
// eyes on), roar (a boost kicking in), thump (a landing; k its weight)
var SFX1 = {
  servo: function(o, k){ var dn = k < 0; sTone(o, "sawtooth", dn ? 900 : 260, dn ? 240 : 980, 0.75, 0.025); sTone(o, "square", dn ? 450 : 130, dn ? 120 : 490, 0.75, 0.012);
    sNoise(o, "bandpass", dn ? 3000 : 900, dn ? 800 : 3200, 4, 0.8, 0.05); },
  clank: function(o, k){ var p = 0.8 + 0.4*cl(fin(k), 0, 1); sNoise(o, "bandpass", 2600*p, 1500*p, 3, 0.09, 0.22); sTone(o, "triangle", 210*p, 95*p, 0.16, 0.16);
    sTone(o, "square", 1250*p, 0, 0.04, 0.03, 0.012); },
  power: function(o){ sTone(o, "sine", 420, 1500, 0.5, 0.07); sTone(o, "sine", 840, 3000, 0.35, 0.03, 0.12); },
  roar: function(o){ sNoise(o, "lowpass", 2400, 380, 0.7, 1.4, 0.32); sTone(o, "sawtooth", 70, 42, 0.9, 0.08); sNoise(o, "bandpass", 5200, 1800, 1.2, 0.5, 0.1); },
  thump: function(o, k){ var w = cl(fin(k) || 1, 0.5, 2); sTone(o, "sine", 92/Math.sqrt(w), 34, 0.38*w, 0.32*Math.min(1.4, w)); sNoise(o, "lowpass", 700, 120, 0.9, 0.3*w, 0.22);
    sNoise(o, "bandpass", 1900, 900, 2, 0.12, 0.06, 0.02); }
};
function sfx1(name, k){
  var o = sndOut(); if(!o || !SFX1[name]) return false;
  var now = o.ctx.currentTime; if(name === "clank" && now - SND.last < 0.035) return false; if(name === "clank") SND.last = now;
  try { SFX1[name](o, k); } catch(e){ return false; }
  return true;
}
// the hum: three looping voices into one gain, made when you first fly with sound on, stopped a moment after you land
function humMake(o){
  var ac = o.ctx, V = {ctx: ac, g: ac.createGain()};
  V.g.gain.value = 0.0001; V.g.connect(o.out);
  function loop(rate, ftype, f, q, vol){ var s = ac.createBufferSource(), fl = ac.createBiquadFilter(), g = ac.createGain();
    s.buffer = sndBuf(ac); s.loop = true; s.playbackRate.value = rate; fl.type = ftype; fl.frequency.value = f; fl.Q.value = q; g.gain.value = vol;
    s.connect(fl); fl.connect(g); g.connect(V.g); s.start(); return {s: s, f: fl, g: g}; }
  V.jet = loop(1, "bandpass", 600, 0.9, 0.5); V.rum = loop(0.5, "lowpass", 140, 0.7, 0.9);
  var os = ac.createOscillator(), wf = ac.createBiquadFilter(), wg = ac.createGain(); os.type = "sawtooth"; os.frequency.value = 420; wf.type = "bandpass"; wf.frequency.value = 900; wf.Q.value = 6;
  wg.gain.value = 0.05; os.connect(wf); wf.connect(wg); wg.connect(V.g); os.start(); V.wh = {s: os, f: wf, g: wg};
  return V;
}
function humFree(V){ if(!V) return; try { var t = V.ctx.currentTime; V.g.gain.setTargetAtTime(0.0001, t, 0.08); [V.jet, V.rum, V.wh].forEach(function(x){ x.s.stop(t + 0.5); }); } catch(e){} }
function sndStop(X){ if(X && X.snd){ humFree(X.snd.V); X.snd = null; } }
function sound(ch, dt){
  var X = ch && ch._exo; if(!X) return;
  var A = X.snd || (X.snd = {V: null, quiet: 0, mode: null, b: 0}), fl = ch._fly, S = X.s, m = fl ? fl.mode : null;
  var th = S ? cl(fin(S.thrust)*cl(fin(S.w), 0, 1), 0, 1.4) : 0, b = S ? cl(fin(S.b), 0, 1) : 0, sp = fl ? Math.max(0, fin(fl.speed)) : 0;
  if(m === "landed" && (A.mode === "hover" || A.mode === "cruise")) sfx1("thump", X.frame.h*(A.mode === "cruise" ? 1.2 : 1));
  var bo = fl && fl.boost && m === "cruise" ? 1 : 0; if(bo && !A.b) sfx1("roar"); A.b = bo; A.mode = m;
  var o = th > 0.02 ? sndOut() : null;
  if(!o){ A.quiet += Math.max(0, fin(dt)); if(A.V && (A.quiet > 1.2 || !sndOut())){ humFree(A.V); A.V = null; } else if(A.V) try { A.V.g.gain.setTargetAtTime(0.0001, A.V.ctx.currentTime, 0.15); } catch(e){} return; }
  A.quiet = 0;
  if(A.V && A.V.ctx !== o.ctx){ humFree(A.V); A.V = null; }
  var V = A.V || (A.V = humMake(o)), t = o.ctx.currentTime, tc = 0.09;
  try {
    V.g.gain.setTargetAtTime(0.06 + 0.12*th, t, tc);
    V.jet.f.frequency.setTargetAtTime(380 + 700*th + 500*b + Math.min(400, sp*4), t, tc); V.jet.g.gain.setTargetAtTime(0.35 + 0.35*th, t, tc);
    V.rum.g.gain.setTargetAtTime(0.4*th + 0.9*b, t, tc); V.rum.f.frequency.setTargetAtTime(110 + 60*th + 80*b, t, tc);
    V.wh.s.frequency.setTargetAtTime(300 + 360*th + Math.min(500, sp*5), t, tc); V.wh.f.frequency.setTargetAtTime(700 + 600*th, t, tc); V.wh.g.gain.setTargetAtTime(0.025 + 0.04*th, t, tc);
  } catch(e){}
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
  var to = opts.to && isFinite(opts.to.x + opts.to.y + opts.to.z) ? opts.to : null;
  var S = {g: g, ch: ch, parts: parts, style: style, t: 0, rev: !!opts.reverse, rd: Math.max(0.3, Math.min(5, fin(opts.rdur) || 0.9)), keep: !!to, done: false, m4: new T.Matrix4(), inv: new T.Matrix4().copy(ch.o.matrixWorld).invert(),
           q: new T.Quaternion(), q1: new T.Quaternion(), e: new T.Euler(), v: new T.Vector3(), s: new T.Vector3(), T: T};
  X.spec.forEach(function(q, i){
    var geo = pieceGeo(T, q);
    var c = new T.Color(colOf(q[2], o)), n = geo.attributes.position.count, ca = new Float32Array(n*3);
    for(var j = 0; j < n; j++){ ca[3*j] = c.r; ca[3*j + 1] = c.g; ca[3*j + 2] = c.b; }
    geo.setAttribute("color", new T.BufferAttribute(ca, 3));
    var me = new T.Mesh(geo, M[MAT_OF[q[2]]]); me.matrixAutoUpdate = false; me.frustumCulled = false; g.add(me);
    var pc = {m: me, bone: q[0], flow: 0, spin: 0}, hm = home(S, pc, new T.Matrix4());
    var hp = centre(T, q).applyMatrix4(hm), s = Math.sign(q[3]) || (rnd(i, o.f) < 0.5 ? -1 : 1), gr = q[12];
    pc.hp = hp;
    // offsets in the character's own (unscaled, ~0.8 tall) frame
    if(to){ pc.from = new T.Vector3(to.x, to.y, to.z); pc.del = gr*0.25; pc.d = 0.8; }             // [3.38.0] docking: each piece over to the gantry
    else if(style === "gantry"){ pc.from = new T.Vector3(s*0.7, -0.5 + gr*0.02, -0.15); pc.del = gr*0.3 + rnd(i, o.f)*0.06; pc.d = 0.55; pc.spin = 1.2; }
    else if(style === "summon"){ var an = rnd(i, o.f)*6.28; pc.from = new T.Vector3(Math.cos(an)*6, 3 + rnd(i + 3, o.f)*4, Math.sin(an)*6); pc.del = gr*0.22 + rnd(i, o.f)*0.15; pc.d = 0.7; pc.spin = 4; }
    else if(style === "drop"){ pc.from = new T.Vector3(0, 13, 0); pc.del = gr*0.32; pc.d = 0.45; }
    else { pc.flow = 1; pc.del = hp.distanceTo(new T.Vector3(0, 0.3, 0.1))*3.2; pc.d = 0.5; }
    dur = Math.max(dur, pc.del + pc.d); parts.push(pc);
  });
  S.dur = dur + 0.45;
  X.meshes.forEach(function(m){ m.visible = false; });
  if(M.G) M.G.emissiveIntensity = S.rev ? 2.2 : 0; X.U.uGK.value = S.rev ? 1 : 0;
  ch.o.add(g);
  scaleTo(S, S.rev ? 1 : 0);
  return S;
}
// Bulwark grows into its 1.3x while it suits up (and shrinks back taking it off)
function scaleTo(S, k){ var X = S.ch._exo; if(!X || X.s1 === X.s0) return; var s = X.s0 + (X.s1 - X.s0)*Math.max(0, Math.min(1, k)); S.ch.o.scale.setScalar(s); S.ch.base = s; }
function seqStep(S, dt){
  var out = {done: false, eyes: 0, shake: 0, lock: null, black: false, k: 0};
  if(!S || S.done || !S.ch._exo){ out.done = true; if(S && !S.done) seqEnd(S); return out; }
  if(!S.snd0){ S.snd0 = 1; sfx1("servo", S.rev ? -1 : 1); }
  S.t += Math.max(0, Math.min(0.1, fin(dt)));
  var t = S.rev ? Math.max(0, (S.dur - 0.45)*(1 - S.t/S.rd)) : S.t;           // off: the build run backwards, fast
  S.ch.o.updateMatrixWorld(true); S.inv.copy(S.ch.o.matrixWorld).invert();
  S.parts.forEach(function(p){
    var k = Math.max(0, Math.min(1, (t - p.del)/p.d)), e = S.style === "drop" ? (k < 1 ? k*k : 1) : ease(k);
    p.m.visible = k > 0 || S.keep;
    home(S, p, S.m4);
    if(p.flow){ var sc = Math.max(0.001, ease(k)); S.m4.scale(S.v.set(sc, sc, sc)); p.m.matrix.copy(S.m4); }
    else {
      S.m4.decompose(S.v, S.q, S.s); var f = 1 - e;
      S.v.addScaledVector(p.from, f); S.e.set(f*p.spin, f*p.spin*1.3, 0); S.q.multiply(S.q1.setFromEuler(S.e));
      p.m.matrix.compose(S.v, S.q, S.s);
    }
    if(k >= 1 && !p.done && !S.rev){ p.done = 1; out.lock = p.hp.clone().applyMatrix4(S.ch.o.matrix); out.shake = Math.max(out.shake, S.style === "drop" ? 0.35 : 0.04);
      sfx1(S.style === "drop" && p.del === 0 ? "thump" : "clank", S.style === "drop" ? 0 : 1 - p.del/Math.max(0.1, S.dur)); }
    if(k < 1) p.done = 0;
  });
  out.k = Math.min(1, S.t/(S.rev ? S.rd : S.dur));
  if(!S.keep) scaleTo(S, S.rev ? 1 - out.k : out.k*1.6);
  var end = S.rev ? S.rd : S.dur, G = S.ch._exo.mats.G;
  if(S.rev){ out.eyes = 1 - out.k; if(G) G.emissiveIntensity = 2.2*out.eyes; S.ch._exo.U.uGK.value = out.eyes; }   // off: the eyes fade
  else { out.eyes = Math.max(0, Math.min(1, (S.t - (S.dur - 0.3))/0.3)); if(G) G.emissiveIntensity = 2.2*out.eyes; S.ch._exo.U.uGK.value = out.eyes;
    if(out.eyes > 0 && !S.snd1){ S.snd1 = 1; sfx1("power"); } }
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

/* ---------- [3.38.0] the suit parked on your HQ roof's dock ----------
   park(T, ch) -> P {g, meshes, look, s, yaw}: the armour ch wears now, baked in its current pose into plain meshes (one per
   material, so 4 draws at most, like the layer) with materials of their own (the eyes on standby), in a group the caller
   places (P.s the scale, P.yaw the facing it had); unpark(P) frees it. dockRig(T) -> the docking gantry: 2 draws. */
function park(T, ch){
  var X = ch && ch._exo; if(!X) return null;
  ch.o.updateMatrixWorld(true);
  var g = new T.Group(), U = armU(T, X.look, X.M), MT = mats(T, X.look, U), meshes = [], inv = new T.Matrix4().copy(ch.o.matrixWorld).invert();
  var sk = X.M.sk, bm = sk.bones.map(function(b, i){ return new T.Matrix4().multiplyMatrices(b.matrixWorld, sk.boneInverses[i]); }), mi = new T.Matrix4(), n3 = new T.Matrix3(), v = new T.Vector3();
  U.uGK.value = 0.25; MT.G.emissiveIntensity = 0.5;
  X.meshes.forEach(function(m){
    var k = m.name.slice(4), src = m.geometry, n = src.attributes.position.count, pos = new Float32Array(n*3), nor = new Float32Array(n*3);
    var si = src.attributes.skinIndex.array, pa = src.attributes.position, na = src.attributes.normal;
    for(var i = 0; i < n; i++){
      mi.copy(m.bindMatrixInverse).multiply(bm[si[i*4]]).multiply(m.bindMatrix); n3.getNormalMatrix(mi);
      v.fromBufferAttribute(pa, i).applyMatrix4(mi); pos[i*3] = v.x; pos[i*3 + 1] = v.y; pos[i*3 + 2] = v.z;
      v.fromBufferAttribute(na, i).applyMatrix3(n3).normalize(); nor[i*3] = v.x; nor[i*3 + 1] = v.y; nor[i*3 + 2] = v.z;
    }
    var geo = new T.BufferGeometry();
    geo.setAttribute("position", new T.BufferAttribute(pos, 3)); geo.setAttribute("normal", new T.BufferAttribute(nor, 3));
    geo.setAttribute("color", src.attributes.color.clone()); geo.setAttribute("aX", src.attributes.aX.clone());
    var me = new T.Mesh(geo, MT[k]); me.name = "exo-park-" + k; me.matrixAutoUpdate = false; me.matrix.multiplyMatrices(inv, m.matrixWorld); me.castShadow = k !== "L";
    g.add(me); meshes.push(me);
  });
  var q = new T.Quaternion(), ws = new T.Vector3(); ch.o.matrixWorld.decompose(v, q, ws);
  g.name = "exo-parked";
  return {g: g, meshes: meshes, mats: MT, look: X.look, s: ws.x, yaw: new T.Euler().setFromQuaternion(q, "YXZ").y};
}
function unpark(P){
  if(!P || P.gone || !P.g || !P.meshes) return; P.gone = true;
  if(P.g.parent) P.g.parent.remove(P.g);
  P.meshes.forEach(function(m){ m.geometry.dispose(); });
  for(var k in P.mats) P.mats[k].dispose();
}
function parkStats(P){ var d = 0; (P && !P.gone ? P.meshes : []).forEach(function(m){ if(m.visible) d++; }); return {draws: d}; }
// the docking gantry (the Suit-Up Centre's steel and glow): base plate, two posts, the beam, boom tips; merged to 2 meshes
function dockRig(T){
  var steel = new T.MeshStandardMaterial({color: 0x56606b, metalness: 0.75, roughness: 0.35}), glow = new T.MeshStandardMaterial({color: 0x0d1a24, emissive: 0x4fd8ff, emissiveIntensity: 1.8});
  function merge(list){
    var pos = [], nor = [];
    list.forEach(function(b){ var bg = (b[6] ? new T.CylinderGeometry(b[0], b[0], b[1], 24) : new T.BoxGeometry(b[0], b[1], b[2])).toNonIndexed(); bg.translate(b[3], b[4], b[5]);
      pos.push.apply(pos, bg.attributes.position.array); nor.push.apply(nor, bg.attributes.normal.array); bg.dispose(); });
    var geo = new T.BufferGeometry(); geo.setAttribute("position", new T.Float32BufferAttribute(pos, 3)); geo.setAttribute("normal", new T.Float32BufferAttribute(nor, 3)); return geo;
  }
  var g = new T.Group(); g.name = "exo-dock-rig";
  var a = new T.Mesh(merge([[0.85, 0.1, 0, 0, 0.05, 0, 1], [0.2, 2.5, 0.2, -1.05, 1.25, -0.35], [0.2, 2.5, 0.2, 1.05, 1.25, -0.35], [2.3, 0.16, 0.24, 0, 2.5, -0.35],
                         [0.6, 0.1, 0.16, -0.75, 1.4, -0.35], [0.6, 0.1, 0.16, 0.75, 1.4, -0.35]]), steel);
  var b = new T.Mesh(merge([[0.72, 0.02, 0, 0, 0.11, 0, 1], [0.08, 0.26, 0.18, -0.45, 1.3, -0.35], [0.08, 0.26, 0.18, 0.45, 1.3, -0.35], [1.6, 0.05, 0.05, 0, 2.42, -0.22]]), glow);
  a.castShadow = true; g.add(a); g.add(b);
  return g;
}

// the auto-dock's path (pure; hq3d sets the flight state from it, no physics): dockPlan(st, to) -> A from where st flies
// to the dock {x, y, z}; dockStep(A, st, dt) -> done: up over the roof first if you are under it (6 m over the dock), a
// curve in (a quadratic through a side point), easing out, the last 15% straight down onto it, "landed" on arrival
function sm(x){ x = x < 0 ? 0 : x > 1 ? 1 : x; return x*x*(3 - 2*x); }
function dockPlan(st, to){
  if(!st || !to || !isFinite(st.x + st.y + st.z + to.x + to.y + to.z)) return null;
  var dx = to.x - st.x, dz = to.z - st.z, d = Math.hypot(dx, dz);
  return {to: {x: to.x, y: to.y, z: to.z}, t: 0, T: Math.max(2.5, Math.min(7, d/12 + 2)), x0: st.x, y0: st.y, z0: st.z, top: Math.max(st.y, to.y + 6),
          cx: (st.x + to.x)/2 - dz*0.25, cz: (st.z + to.z)/2 + dx*0.25, px: st.x, pz: st.z, done: false};
}
function dockStep(A, st, dt){
  if(!A || !st || A.done) return !!(A && A.done);
  dt = Math.max(0, Math.min(0.1, fin(dt))); A.t += dt;
  var P = A.to, u = sm(A.t/A.T), v = 1 - u, dn = A.T*0.85;
  st.x = v*v*A.x0 + 2*u*v*A.cx + u*u*P.x; st.z = v*v*A.z0 + 2*u*v*A.cz + u*u*P.z;
  st.y = A.t < dn ? A.y0 + (A.top - A.y0)*sm(A.t/(A.T*0.4)) : A.top + (P.y - A.top)*sm((A.t - dn)/(A.T - dn));
  var mx = st.x - A.px, mz = st.z - A.pz, sp = dt > 0 ? Math.hypot(mx, mz)/dt : 0;
  if(sp > 0.3) st.yaw = st.th = Math.atan2(-mx, -mz);
  A.px = st.x; A.pz = st.z;
  st.vx = 0; st.vy = 0; st.vz = 0; st.speed = sp; st.pitch = 0; st.roll = 0; st.vs = 0; st.agl = Math.max(0, st.y - P.y);
  st.mode = A.t >= A.T ? "landed" : u < 0.8 ? "cruise" : "hover";
  if(A.t >= A.T){ st.x = P.x; st.z = P.z; st.y = P.y; A.done = true; }
  return A.done;
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

HQV.hqExo = {FRAMES: FRAMES, PAINTS: PAINTS, FINISHES: FINISHES, GLOWS: GLOWS, MODES: MODES, BONES: NEED, BONES_UNI: UNI, clean: clean, encode: encode,
  decode: decode, sig: sig, load: load, save: save, styleFor: styleFor, wear: wear, strip: strip, stats: stats, pose: pose, measure: measure, targets: targets, bankFor: bankFor, BANK_MAX: BANK_MAX,
  sound: sound, sfx: sfx1, seq: seq, seqStep: seqStep, seqEnd: seqEnd, park: park, unpark: unpark, parkStats: parkStats, dockRig: dockRig, dockPlan: dockPlan, dockStep: dockStep, parked: parked, setParked: setParked, FX: {N: FX_N, I: FX_I, DUST: FX_DUST, TRAIL: FX_TRAIL, SPARK: FX_SPARK, RIB: FX_RIB}, KNEE: KNEE, EYE: [EYE_X, EYE_Y], bay: bay, panel: panel, panelOpen: panelOpen, panelClose: panelClose, preview: preview, previewRef: function(){ return PVW; },
  peer: peer, wanted: wanted, me: me, bayRef: null, hex: hex};
})();
