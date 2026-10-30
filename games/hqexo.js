/* Claude HQ: HQ Exosuit -- six flyable powered suits for the HQ and the City (original designs: armour types, not any
 * film suit).
 *
 * A frame is a full hero body with human proportions, rigged the SkyStrike way (games/skystrike.js: build() gives
 * {o, mixer, acts, cur, base, hip, update}, bones named root / torso / head / arm-* / leg-*, arm bones resting along
 * +-X and leg bones along -Y, elbows and knees nested), so games/hq3d.js swaps it in for your body (and a peer's) the
 * way it swaps SkyStrike's. Every piece is merged per material into one SkinnedMesh (each vertex rigidly on its bone):
 * armour (paint as vertex colour, the finish on the material), the dark undersuit, the glow, and Abyss's glass dome --
 * at most 4 draw calls and under 6k triangles a frame (tests/test_hqexo.py).
 *
 *   FRAMES / PAINTS / FINISHES / GLOWS   the roster (index for index what presence `ex` carries)
 *   clean(o) -> {f, p, fin, g}           any input to a valid look       load() / save(o)   this browser (hq3d.exo)
 *   encode(o, m) / decode(a)             presence `ex` = [frame, paint, finish, glow, mode] (backend/src/valley/hq.rs)
 *                                        mode 1 suiting up, 2 on foot, 3 hover, 4 cruise, 5 boost, 6 swim
 *   build(THREE, o) -> ch                the body; ch.update(t) poses it (gait from ch.acts like SkyStrike's, or flight
 *                                        from ch._fly = {mode, speed, boost})
 *   styleFor(f, where)                   the suit-up style: "gantry" (the Suit-Up Centre), "summon", "flow", "drop"
 *   seq(THREE, ch, style, opts) -> S     the suit-up: one mesh per piece flying home onto the posed body (reverse: off);
 *                                        seqStep(S, dt) -> {done, eyes 0..1, shake, lock (a piece landed), black}
 *   bay(c, w, x, z, ry) -> B             the lobby's Suit-Up Centre: the plate, two gantry arms, the customiser kiosk
 *   panel(onPick, onSuit) / panelOpen()  the customiser (frame, two-tone paint, finish, glow / HUD tint)
 *   wanted(key) / peer(u, ex) / sig(o)   which body hq3d builds for "you:*" and "peer:*"
 * Free: every frame, paint and finish from day one. Privacy: presence carries five small numbers.
 */
(function(){
"use strict";
var G = typeof window !== "undefined" ? window : globalThis;
var HQV = G.HQV = G.HQV || {};
var PI = Math.PI;

/* ---------- the roster (pure) ---------- */
// b bulk, sw shoulder width, h height (Bulwark 1.45x: a suit over the suit), x extras, up its suit-up style,
// paint / fin the look it comes in; st [speed, armour, agility, firepower] (the HUD and the flight read hqexoride's)
var FRAMES = [
  {id: "sentinel", n: "Sentinel", t: "All-rounder", up: "gantry", b: 1, sw: 1, h: 1, paint: 1, fin: 0, x: ["pack"], st: [65, 60, 65, 60],
   d: "The everyday suit. Good at everything, and a good first pick."},
  {id: "strider", n: "Strider", t: "Speed", up: "summon", b: 0.82, sw: 0.95, h: 1.02, paint: 2, fin: 0, x: ["fins"], st: [95, 35, 85, 45],
   d: "Built for speed: the fastest in a straight line, and it turns sharply."},
  {id: "bulwark", n: "Bulwark", t: "Giant buster", up: "drop", b: 1.9, sw: 1.55, h: 1.45, paint: 0, fin: 0, x: ["pack", "fists"], st: [25, 100, 15, 90],
   d: "A suit that goes over the suit. Too big for seats; its landings shake the street."},
  {id: "abyss", n: "Abyss", t: "Deep-sea", up: "flow", b: 1.25, sw: 1.1, h: 1, paint: 6, fin: 0, x: ["dome", "tanks"], st: [50, 70, 50, 40],
   d: "Swims and dives the ocean, and hovers slowly on land."},
  {id: "stratos", n: "Stratos", t: "High altitude", up: "summon", b: 0.95, sw: 1, h: 1.02, paint: 7, fin: 0, x: ["wings"], st: [90, 45, 60, 40],
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

/* ---------- the rig: bones (the SkyStrike names), at unit height; ch.base scales the frame ---------- */
var HIP = 0.95, ARM_Y = 0.5, UP_A = 0.28, FORE = 0.25, THIGH = 0.44, SHIN = 0.44;
var BONES = ["root", "torso", "head", "arm-left", "arm-right", "elbow-left", "elbow-right", "wrist-left", "wrist-right",
             "leg-left", "leg-right", "knee-left", "knee-right", "ankle-left", "ankle-right"];
var BI = {}; BONES.forEach(function(n, i){ BI[n] = i; });
function rig(T, F){
  var b = Math.min(F.b, 1.3), sw = F.sw, B = {};
  function bone(n, par, x, y, z){ var o = new T.Bone(); o.name = n; o.position.set(x, y, z); if(par) B[par].add(o); B[n] = o; return o; }
  bone("root", null, 0, 0, 0); bone("torso", "root", 0, HIP, 0); bone("head", "torso", 0, 0.6, 0);
  [["left", 1], ["right", -1]].forEach(function(q){
    var s = q[1];
    bone("arm-" + q[0], "torso", s*(0.17*sw + 0.03*F.b), ARM_Y, 0); bone("elbow-" + q[0], "arm-" + q[0], s*UP_A, 0, 0); bone("wrist-" + q[0], "elbow-" + q[0], s*FORE, 0, 0);
    bone("leg-" + q[0], "root", s*0.1*b, HIP, 0); bone("knee-" + q[0], "leg-" + q[0], 0, -THIGH, 0); bone("ankle-" + q[0], "knee-" + q[0], 0, -SHIN, 0);
  });
  return B;
}
// the pieces: [bone, shape, key ("A" paint, "B" second paint, "D" undersuit, "G" glow, "L" glass), x, y, z, rx, ry, rz, sx, sy, sz, grp]
// shape: ["s", r] sphere, ["c", r, len] capsule along y, ["b", w, h, d] box, ["y", r0, r1, h, seg] cylinder; grp orders the suit-up
function spec(F){
  var b = F.b, bl = Math.min(b, 1.3), sw = F.sw, has = function(k){ return F.x.indexOf(k) >= 0; }, fist = has("fists") ? 1.7 : 1, P = [];
  function p(bone, shape, key, x, y, z, rx, ry, rz, sx, sy, sz, grp){ P.push([bone, shape, key, x, y, z, rx || 0, ry || 0, rz || 0, sx || 1, sy || 1, sz || 1, grp | 0]); }
  [["left", 1], ["right", -1]].forEach(function(q){
    var n = q[0], s = q[1];
    p("ankle-" + n, ["b", 0.11*bl, 0.08, 0.22*bl], "B", 0, -0.035, 0.04, 0, 0, 0, 1, 1, 1, 0);                 // boots
    p("knee-" + n, ["c", 0.066*b, 0.24], "A", 0, -0.22, 0, 0, 0, 0, 1, 1, 1, 1);                               // shins
    p("knee-" + n, ["s", 0.052*b], "B", 0, 0, 0.045*b, 0, 0, 0, 1, 0.8, 0.7, 1);                               // knees
    p("leg-" + n, ["c", 0.082*b, 0.24], "A", 0, -0.22, 0, 0, 0, 0, 1, 1, 1, 2);                                // thighs
    p("arm-" + n, ["c", 0.057*b, 0.18], "A", s*0.14, 0, 0, 0, 0, PI/2, 1, 1, 1, 4);                            // upper arms
    p("arm-" + n, ["s", 0.095*b], "B", s*0.02, 0.05, 0, 0, 0, 0, 1.25, 0.8, 1.05, 4);                          // shoulder pads
    p("elbow-" + n, ["c", 0.062*b, 0.16], "A", s*0.12, 0, 0, 0, 0, PI/2, 1, 1, 1, 5);                          // forearms
    p("wrist-" + n, ["s", 0.05*b*fist], "B", s*0.045, 0, 0, 0, 0, 0, 1.1, 1, 1, 5);                            // gauntlets
    p("wrist-" + n, ["s", 0.016*fist], "G", s*0.05, -0.045*b*fist*0.8, 0, 0, 0, 0, 1, 1, 1, 5);              // palm emitters
    if(has("fins")) p("knee-" + n, ["b", 0.012, 0.16, 0.1], "B", s*(0.066*b + 0.012), -0.2, -0.04, -0.3, 0, s*0.15, 1, 1, 1, 1);
    if(has("wings")) p("torso", ["b", 0.5, 0.02, 0.14], "B", s*0.32, 0.47, -0.2, 0, s*-0.2, s*-0.35, 1, 1, 1, 6);
    if(has("tanks")) p("torso", ["y", 0.06, 0.06, 0.34, 10], "B", s*0.08, 0.35, -0.2*b, 0, 0, 0, 1, 1, 1, 6);
  });
  var cr = has("core") ? 0.07 : 0.045;
  p("torso", ["s", 0.15*b], "D", 0, 0, 0, 0, 0, 0, 1.1, 0.62, 0.78, 2);                                       // pelvis
  p("torso", ["c", 0.17*b, 0.2], "A", 0, 0.35, 0, 0, 0, 0, 1, 1, 0.72, 3);                                    // torso
  p("torso", ["b", 0.2*b, 0.13, 0.05], "B", 0, 0.16, 0.095*b, 0, 0, 0, 1, 1, 1, 3);                           // abs plate
  p("torso", ["y", cr, cr, 0.025, 18], "G", 0, 0.42, 0.125*b, PI/2, 0, 0, 1, 1, 1, 3);                        // chest core
  if(has("pack")) p("torso", ["b", 0.26*b, 0.3, 0.12*b], "D", 0, 0.37, -0.15*b, 0, 0, 0, 1, 1, 1, 6);         // backpack
  p("torso", ["y", 0.05, 0.06, 0.08, 10], "D", 0, 0.61, 0, 0, 0, 0, 1, 1, 1, 7);                              // neck
  p("head", ["s", 0.115], "A", 0, 0.14, 0, 0, 0, 0, 0.92, 1.1, 1.02, 7);                                      // helmet
  p("head", ["b", 0.15, 0.13, 0.045], "B", 0, 0.115, 0.095, 0, 0, 0, 1, 1, 1, 8);                             // faceplate
  p("head", ["b", 0.11, 0.014, 0.012], "G", 0, 0.14, 0.12, 0, 0, 0, 1, 1, 1, 8);                              // eye slit
  if(has("dome")) p("head", ["s", 0.17], "L", 0, 0.13, 0.01, 0, 0, 0, 1, 1, 1, 8);
  return P;
}
function shape(T, s){
  if(s[0] === "s") return new T.SphereGeometry(s[1], s[1] < 0.03 ? 8 : 14, s[1] < 0.03 ? 6 : 10);
  if(s[0] === "c") return new T.CapsuleGeometry(s[1], s[2], 4, 12);
  if(s[0] === "b") return new T.BoxGeometry(s[1], s[2], s[3]);
  return new T.CylinderGeometry(s[1], s[2], s[3], s[4] || 12);
}
function local(T, q){
  return new T.Matrix4().compose(new T.Vector3(q[3], q[4], q[5]), new T.Quaternion().setFromEuler(new T.Euler(q[6], q[7], q[8])), new T.Vector3(q[9], q[10], q[11]));
}
function colOf(key, o){ var P = PAINTS[o.p]; return key === "A" ? P[1] : key === "B" ? P[2] : key === "D" ? UNDER : key === "L" ? 0xbfe8ff : 0xffffff; }
function mats(T, o, F){
  var Fi = FINISHES[o.fin], gl = GLOWS[o.g][1];
  return {
    A: new T.MeshStandardMaterial({vertexColors: true, roughness: Fi[1], metalness: Fi[2]}),
    D: new T.MeshStandardMaterial({color: UNDER, roughness: 0.6, metalness: 0.45}),
    G: new T.MeshStandardMaterial({color: gl, emissive: gl, emissiveIntensity: 2.2, toneMapped: false}),
    L: new T.MeshStandardMaterial({color: 0xbfe8ff, roughness: 0.05, metalness: 0.1, transparent: true, opacity: 0.38, depthWrite: false})
  };
}
var MAT_OF = {A: "A", B: "A", D: "D", G: "G", L: "L"};

/* ---------- the body ---------- */
function act(name){
  return {name: name, weight: 0, timeScale: 1, time: 0, enabled: true,
          reset: function(){ this.time = 0; return this; }, play: function(){ this.enabled = true; return this; }, stop: function(){ return this; },
          fadeIn: function(){ return this; }, fadeOut: function(){ return this; }, setEffectiveWeight: function(w){ this.weight = +w || 0; return this; },
          setLoop: function(){ return this; }, getClip: function(){ return {duration: 1, name: this.name}; }};
}
function build(T, o0){
  var o = clean(o0), F = FRAMES[o.f], B = rig(T, F), g = new T.Group(), M = mats(T, o, F), acc = {}, P = spec(F);
  g.name = "exosuit"; g.add(B.root); g.updateMatrixWorld(true);
  var bones = BONES.map(function(n){ return B[n]; });
  P.forEach(function(q){
    var geo = shape(T, q[1]), m4 = B[q[0]].matrixWorld.clone().multiply(local(T, q)), k = MAT_OF[q[2]], bi = BI[q[0]];
    var gg = geo.index ? geo.toNonIndexed() : geo; gg.applyMatrix4(m4);
    var a = acc[k] || (acc[k] = {pos: [], nor: [], col: [], si: [], sw: []}), c = new T.Color(colOf(q[2], o));
    var pp = gg.attributes.position.array, nn = gg.attributes.normal.array;
    for(var i = 0; i < pp.length; i += 3){ a.pos.push(pp[i], pp[i + 1], pp[i + 2]); a.nor.push(nn[i], nn[i + 1], nn[i + 2]); a.col.push(c.r, c.g, c.b); a.si.push(bi, 0, 0, 0); a.sw.push(1, 0, 0, 0); }
    if(gg !== geo) gg.dispose(); geo.dispose();
  });
  var skel = new T.Skeleton(bones), meshes = [];
  ["A", "D", "G", "L"].forEach(function(k){
    var a = acc[k]; if(!a){ M[k].dispose(); return; }
    var geo = new T.BufferGeometry();
    geo.setAttribute("position", new T.Float32BufferAttribute(a.pos, 3)); geo.setAttribute("normal", new T.Float32BufferAttribute(a.nor, 3));
    geo.setAttribute("color", new T.Float32BufferAttribute(a.col, 3));
    geo.setAttribute("skinIndex", new T.Uint16BufferAttribute(a.si, 4)); geo.setAttribute("skinWeight", new T.Float32BufferAttribute(a.sw, 4));
    var me = new T.SkinnedMesh(geo, M[k]); me.name = "exo-" + k; me.frustumCulled = false; me.castShadow = k !== "L";
    g.add(me); me.bind(skel, new T.Matrix4()); meshes.push(me);
  });
  var acts = {idle: act("idle"), walk: act("walk"), sprint: act("sprint"), sit: act("sit")};
  var ch = {o: g, acts: acts, cur: null, base: F.h, hip: [0, HIP, 0], legRest: [0, -THIGH - SHIN, 0.03], _ph: 0, _t: null, _pb: false, ownLean: true,
            mixer: {update: function(){}}, _bones: B, _exo: {look: o, frame: F, mats: M, meshes: meshes, spec: P},
            _rig: {root: B.root, t: B.torso, h: B.head, la: B["arm-left"], ra: B["arm-right"], ll: B["leg-left"], rl: B["leg-right"],
                   lav: new T.Vector3(UP_A + FORE + 0.08, 0, 0), rav: new T.Vector3(-UP_A - FORE - 0.08, 0, 0), legv: new T.Vector3(0, -THIGH - SHIN, 0.03)},
            update: function(t){ pose(ch, t); }};
  pose(ch, 0);
  return ch;
}
function stats(ch){
  var tris = 0, draws = 0;
  ch.o.traverse(function(m){ if(m.isMesh && m.visible){ draws++; tris += (m.geometry.index ? m.geometry.index.count : m.geometry.attributes.position.count)/3; } });
  return {tris: tris, draws: draws};
}
function dispose(ch){ if(!ch || !ch._exo) return; ch._exo.meshes.forEach(function(m){ m.geometry.dispose(); }); var M = ch._exo.mats; for(var k in M) M[k].dispose(); }

/* ---------- posing (arms hang by a Z turn of -+PI/2, swing on X; elbows flex on Y; legs swing on X, knees fold +X) ---------- */
function fin(v){ v = +v; return isFinite(v) ? v : 0; }
function arm(B, n, s, swing, out, flex){ var a = B["arm-" + n]; a.rotation.set(-swing, 0, -s*(PI/2 - out)); B["elbow-" + n].rotation.set(0, -s*flex, 0); }
function leg(B, n, lift, knee, splay){ B["leg-" + n].rotation.set(-lift, 0, splay || 0); B["knee-" + n].rotation.set(Math.max(0, knee), 0, 0); }
function pose(ch, t){
  if(!ch || !ch._bones) return;
  var B = ch._bones, a = ch.acts || {}, t1 = fin(t), t0 = ch._t, E = HQV.engine, calm = !!(E && E.calm && E.calm());
  ch._t = t1;
  var dt = t0 == null ? 0 : Math.max(0, Math.min(0.1, t1 - t0)); if(calm) dt = 0;
  B.root.position.set(0, 0, 0); B.root.rotation.set(0, 0, 0); B.torso.rotation.set(0, 0, 0); B.head.rotation.set(0, 0, 0);
  var fl = ch._fly, m = fl ? fl.mode : null, bob = calm ? 0 : Math.sin(t1*2.1);
  if(m === "hover" || m === "cruise" || m === "swim"){
    var k = m === "hover" ? 0 : m === "swim" ? 1 : Math.max(0.35, Math.min(1, fin(fl.speed)/30)), al = (m === "swim" ? PI/2 : 1.35*k);
    // pitched about the hip (not the feet), so the body lies along its flight
    B.root.rotation.x = al; B.root.position.set(0, HIP - HIP*Math.cos(al), -HIP*Math.sin(al));
    if(m === "hover"){
      arm(B, "left", 1, 0.1, 0.38 + bob*0.03, 0.25); arm(B, "right", -1, 0.1, 0.38 - bob*0.03, 0.25);
      leg(B, "left", 0.12, 0.3 + bob*0.04, 0.06); leg(B, "right", 0.05, 0.22 - bob*0.04, -0.06);
      B.head.rotation.x = -0.08;
    } else if(m === "swim"){
      ch._ph = ((ch._ph || 0) + dt*0.7) % 1; var sp = Math.sin(ch._ph*2*PI), kick = calm ? 0 : Math.sin(t1*7);
      arm(B, "left", 1, -2.4 + sp*0.9, 0.5 + sp*0.4, 0.4); arm(B, "right", -1, -2.4 + sp*0.9, 0.5 + sp*0.4, 0.4);
      leg(B, "left", kick*0.25, 0.2, 0.05); leg(B, "right", -kick*0.25, 0.2, -0.05); B.head.rotation.x = -1.0;
    } else {
      var bz = fl.boost ? 0.12 : 0.3;
      arm(B, "left", 1, 0.15, bz, 0.05); arm(B, "right", -1, 0.15, bz, 0.05);
      leg(B, "left", -0.05, 0.08 + bob*0.03, 0.05); leg(B, "right", -0.05, 0.14 - bob*0.03, -0.05); B.head.rotation.x = -1.1*k;
    }
    return;
  }
  // on foot: SkyStrike's weights (the page's loco blend or the clip it set)
  function w(n){ var x = a[n]; return x ? fin(x.weight) : 0; }
  var wi = w("idle"), ww = w("walk"), ws = w("sprint"), wsi = ch.cur === "sit" ? 1 : 0;
  if(ch.cur === "idle" && !ch.loco) wi = 1; if(ch.cur === "walk" && !ch.loco){ ww = 1; ws = 0; } if(ch.cur === "sprint" && !ch.loco){ ws = 1; ww = 0; }
  var move = ww + ws; if(move > 1){ ww /= move; ws /= move; move = 1; }
  if(wsi){ arm(B, "left", 1, 0.5, 0.15, 0.9); arm(B, "right", -1, 0.5, 0.15, 0.9); leg(B, "left", 1.4, 1.4, 0.08); leg(B, "right", 1.4, 1.4, -0.08); return; }
  ch._ph = ((ch._ph || 0) + dt*(1.1*ww + 1.55*ws)) % 1;
  var ph = ch._ph*2*PI, sw = Math.sin(ph), cw = Math.cos(ph), amp = 0.42*ww + 0.75*ws, br = calm ? 0 : Math.sin(t1*1.5)*0.012;
  B.torso.rotation.set(0.04 + 0.18*ws + br, sw*0.06*move, 0); B.torso.position.y = HIP + Math.abs(cw)*0.025*move;
  arm(B, "left", 1, -sw*amp*0.9, 0.12, 0.25 + 0.9*ws); arm(B, "right", -1, sw*amp*0.9, 0.12, 0.25 + 0.9*ws);
  leg(B, "left", sw*amp, Math.max(0, -cw)*amp*1.3 + 0.04, 0.04*(1 - move)); leg(B, "right", -sw*amp, Math.max(0, cw)*amp*1.3 + 0.04, -0.04*(1 - move));
  B.head.rotation.x = -0.1*ws;
}

/* ---------- the suit-up: every piece its own mesh, flying from `from` to its place on the posed body ---------- */
function rnd(i, f){ var x = Math.sin(i*91.7 + f*13.1)*43758.5; return x - Math.floor(x); }
function ease(x){ var c = 1.6; return 1 + (c + 1)*Math.pow(x - 1, 3) + c*Math.pow(x - 1, 2); }
function seq(T, ch, style, opts){
  opts = opts || {};
  var X = ch._exo, o = X.look, g = new T.Group(), P = X.spec, parts = [], dur = 0;
  ch.o.updateMatrixWorld(true);
  var inv = new T.Matrix4().copy(ch.o.matrixWorld).invert(), M = X.mats;
  P.forEach(function(q, i){
    var geo = shape(T, q[1]); geo.applyMatrix4(local(T, q));
    var c = new T.Color(colOf(q[2], o)), n = geo.attributes.position.count, ca = new Float32Array(n*3);
    for(var j = 0; j < n; j++){ ca[3*j] = c.r; ca[3*j + 1] = c.g; ca[3*j + 2] = c.b; }
    geo.setAttribute("color", new T.BufferAttribute(ca, 3));
    var me = new T.Mesh(geo, M[MAT_OF[q[2]]]); me.matrixAutoUpdate = false; g.add(me);
    var home = new T.Matrix4().multiplyMatrices(inv, ch._bones[q[0]].matrixWorld);
    var hp = new T.Vector3().setFromMatrixPosition(home), s = Math.sign(hp.x) || (rnd(i, o.f) < 0.5 ? -1 : 1), gr = q[12], pc = {m: me, home: home, hp: hp, flow: 0, spin: 0};
    if(style === "gantry"){ pc.from = new T.Vector3(s*1.4, -1.1 + gr*0.05, -0.3); pc.del = gr*0.3 + rnd(i, o.f)*0.06; pc.d = 0.55; pc.spin = 1.2; }
    else if(style === "summon"){ var an = rnd(i, o.f)*6.28; pc.from = new T.Vector3(Math.cos(an)*14, 6 + rnd(i + 3, o.f)*8, Math.sin(an)*14); pc.del = gr*0.22 + rnd(i, o.f)*0.15; pc.d = 0.7; pc.spin = 4; }
    else if(style === "drop"){ pc.from = new T.Vector3(0, 30, 0); pc.del = gr*0.32; pc.d = 0.45; }
    else { pc.flow = 1; pc.del = hp.distanceTo(new T.Vector3(0, 1.37, 0.15))*1.4; pc.d = 0.5; }
    dur = Math.max(dur, pc.del + pc.d); parts.push(pc);
  });
  X.meshes.forEach(function(m){ m.visible = false; });
  M.G.emissiveIntensity = 0; ch.o.add(g);
  return {g: g, ch: ch, parts: parts, style: style, t: 0, dur: dur + 0.45, rev: !!opts.reverse, done: false, black: 0, m4: new T.Matrix4(),
          q: new T.Quaternion(), e: new T.Euler(), v: new T.Vector3(), s: new T.Vector3(), one: new T.Vector3(1, 1, 1), T: T};
}
function seqStep(S, dt){
  var out = {done: false, eyes: 0, shake: 0, lock: null, black: false, k: 0};
  if(!S || S.done){ out.done = true; return out; }
  S.t += Math.max(0, Math.min(0.1, fin(dt)));
  var t = S.rev ? Math.max(0, (S.dur - 0.45)*(1 - S.t/0.9)) : S.t;           // off: the build run backwards, fast
  S.parts.forEach(function(p){
    var k = Math.max(0, Math.min(1, (t - p.del)/p.d)), e = S.style === "drop" ? (k < 1 ? k*k : 1) : ease(k);
    p.m.visible = k > 0 || (S.rev && k > 0);
    if(p.flow){ var sc = Math.max(0.001, ease(k)); S.m4.copy(p.home); S.m4.scale(S.v.set(sc, sc, sc)); p.m.matrix.copy(S.m4); }
    else {
      p.home.decompose(S.v, S.q, S.s); var f = 1 - e;
      S.v.addScaledVector(p.from, f); S.e.set(f*p.spin, f*p.spin*1.3, 0); S.q.multiply(new S.T.Quaternion().setFromEuler(S.e));
      p.m.matrix.compose(S.v, S.q, S.s);
    }
    if(k >= 1 && !p.done && !S.rev){ p.done = 1; out.lock = p.hp; out.shake = Math.max(out.shake, S.style === "drop" ? 0.35 : 0.04); }
    if(k < 1) p.done = 0;
  });
  out.k = Math.min(1, S.t/S.dur);
  var end = S.rev ? 0.9 : S.dur;
  if(!S.rev){ out.eyes = Math.max(0, Math.min(1, (S.t - (S.dur - 0.3))/0.3)); S.ch._exo.mats.G.emissiveIntensity = 2.2*out.eyes; }
  if(S.t >= end) seqEnd(S), out.done = true;
  return out;
}
function seqEnd(S){
  if(!S || S.done) return; S.done = true;
  if(S.g.parent) S.g.parent.remove(S.g);
  S.g.children.forEach(function(m){ m.geometry.dispose(); });
  if(!S.rev){ S.ch._exo.meshes.forEach(function(m){ m.visible = true; }); S.ch._exo.mats.G.emissiveIntensity = 2.2; }
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
  el.style.cssText = "position:fixed;right:16px;top:72px;z-index:60;width:min(340px,calc(100vw - 32px));max-height:calc(100vh - 100px);overflow:auto;" +
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

HQV.hqExo = {FRAMES: FRAMES, PAINTS: PAINTS, FINISHES: FINISHES, GLOWS: GLOWS, MODES: MODES, BONES: BONES, clean: clean, encode: encode,
  decode: decode, sig: sig, load: load, save: save, styleFor: styleFor, build: build, stats: stats, dispose: dispose, pose: pose,
  seq: seq, seqStep: seqStep, seqEnd: seqEnd, bay: bay, panel: panel, panelOpen: panelOpen, panelClose: panelClose,
  peer: peer, wanted: wanted, me: me, bayRef: null, hex: hex};
})();
