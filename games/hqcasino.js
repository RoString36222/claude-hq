/* Claude HQ: the Casino (HQ 3.7) -- The Lucky Byte.
 *
 * A casino in every city from tier 3 (the Commons has it too): on the street a black-glass hall with gold fins under
 * a hotel tower, a marquee of chasing bulbs, the name in neon on the roof beside a pair of giant turning dice, a red
 * carpet between brass stanchions. Walk through the doors and you are on the casino floor (its own world, like the
 * Lobby): slot banks, roulette, blackjack, the dice pit, the Race Book's big screens, Plinko, the Lucky Wheel, a Rocket
 * cabinet, the Scratch-O-Matic, the Coin Toss, the bar and the cashier's cage, with dealers in waistcoats and bow
 * ties and a crowd at the machines. Walk up to a game and press E: games/hqcasinoui.js opens on it. The Arena decides
 * every outcome (backend/src/casino.rs); chips come from the cage.
 *
 * And a few things to find: the duck on the bar, the door marked Staff Only, the machine that has been out of order
 * since forever, the cat on the bar stool, the golden asterisk's honest odds, the money tree, a ghost who plays
 * machine 13 at 3 a.m., and an old cheat code typed anywhere on the floor.
 *
 *   place(W, tier) -> site | null   (pure; mutates W once: idempotent) a "casino:0" site on a building lot
 *   pick(W)        -> {lot, F, rank} | null   (pure) the lot place() takes
 *   build(c, site, opts) -> B, the civic building games/hqcity3d.js keeps (g, doors, hits, glows, boxes, lod, decks,
 *                     top, tint, x, y, z, setNight, animate, inside, dispose, door {x, z, yaw})
 *   HQV.hqWorlds.casino(c, w) -> the casino floor (a world: see mount() in games/hq3d.js for the shape)
 *   EGGS, SPOTS    the floor's games and secrets, for the tests
 *
 * Privacy: nothing leaves the page but what games/hqcasinoui.js posts (a game, a bet, a pick). textContent only.
 */
(function(){
"use strict";
var G = typeof window !== "undefined" ? window : globalThis;
var HQV = G.HQV = G.HQV || {};
HQV.hqWorlds = HQV.hqWorlds || {};

var PI = Math.PI, TAU = PI*2, Q16 = 65536;
var SITE_ID = "casino:0", MIN_TIER = 3, NAME = "The Lucky Byte";
var MIN_W = 24, MIN_D = 22, WANT_FROM_PLAZA = 170;
var PREF = {downtown: 4, commercial: 4, finance: 2, office: 2, oldtown: 1, mixed: 1};

/* ---------- where it stands (pure) ---------- */
function frame(o){ return HQV.hqDealer && HQV.hqDealer.frame ? HQV.hqDealer.frame(o) : null; }
function siteOf(W, id){ var S = W.sites || []; for(var i = 0; i < S.length; i++) if(S[i] && S[i].id === id) return S[i]; return null; }
function find(W){ var S = (W && W.sites) || []; for(var i = 0; i < S.length; i++) if(S[i] && S[i].kind === "casino") return S[i]; return null; }
function pick(W){
  if(!W || !W.lots) return null;
  var legend = (W.districts && W.districts.legend) || [], pl = siteOf(W, "fountain:0") || siteOf(W, "spawn:0"), px = pl ? pl.x/100 : 0, pz = pl ? pl.z/100 : 0, best = null;
  W.lots.forEach(function(l){
    if(!l || l.kind !== "building") return;
    if(l.min_tier != null && (l.min_tier | 0) > MIN_TIER) return;
    var F = frame(l); if(!F || F.w < MIN_W || F.d < MIN_D) return;
    var from = Math.hypot(F.cx - px, F.cz - pz);
    // big enough for the hall, in the busy districts, a short walk from the plaza (not on it)
    var rank = Math.min(F.w, 46)*Math.min(F.d, 40)/40 + (PREF[legend[l.district | 0]] || 0)*30 - Math.abs(from - WANT_FROM_PLAZA)*0.25;
    if(!best || rank > best.rank || (rank === best.rank && (l.id | 0) < (best.lot.id | 0))) best = {lot: l, F: F, rank: rank};
  });
  return best;
}
function place(W, tier){
  if(!W || !W.sites || !W.lots) return null;
  var have = find(W); if(have) return have;
  if((tier | 0) < MIN_TIER) return null;
  var c = pick(W); if(!c) return null;
  var l = c.lot, F = c.F, y = l.door && l.door.length >= 3 ? l.door[1] | 0 : (l.y | 0);
  // worldbuild draws no building here now; the site does. `was` and `claimed` keep it out of the world cache
  // (games/world.js cacheCopy puts the lot back and drops the site), as the dealership and the landmarks do
  l.was = l.kind; l.kind = "casino";
  var s = {id: SITE_ID, kind: "casino", tier: MIN_TIER, lot: l.id, block: l.block, district: l.district,
           x: Math.round(F.cx*100), y: y, z: Math.round(F.cz*100), w: Math.round(F.w*100), d: Math.round(F.d*100),
           front: [Math.round(F.f[0]*Q16), Math.round(F.f[1]*Q16)], facing: l.facing || "north", name: NAME, claimed: 1};
  W.sites.push(s);
  W.index = null;
  return s;
}

/* ---------- shared bits ---------- */
function signTex(c, text, w, h, col, glow, bg){
  var t = c.canvasTex(w, h, function(g){
    if(bg){ g.fillStyle = bg; g.fillRect(0, 0, w, h); }
    g.font = "900 " + Math.round(h*0.62) + "px 'Avenir Next', 'Segoe UI', sans-serif"; g.textAlign = "center"; g.textBaseline = "middle";
    var tw = g.measureText(text).width; if(tw > w*0.92){ g.font = "900 " + Math.round(h*0.62*w*0.92/tw) + "px 'Avenir Next', 'Segoe UI', sans-serif"; }
    g.shadowColor = glow; g.shadowBlur = h*0.18; g.fillStyle = col; g.fillText(text, w/2, h*0.54); g.shadowBlur = h*0.08; g.fillText(text, w/2, h*0.54);
  }).t;
  t.colorSpace = c.THREE.SRGBColorSpace; return t;
}
function diceTex(c, n){
  var t = c.canvasTex(256, 256, function(g){
    g.fillStyle = "#c41e3a"; g.fillRect(0, 0, 256, 256); g.strokeStyle = "#7a0f22"; g.lineWidth = 10; g.strokeRect(5, 5, 246, 246);
    var P = {1: [[0, 0]], 2: [[-1, -1], [1, 1]], 3: [[-1, -1], [0, 0], [1, 1]], 4: [[-1, -1], [1, -1], [-1, 1], [1, 1]], 5: [[-1, -1], [1, -1], [0, 0], [-1, 1], [1, 1]], 6: [[-1, -1], [1, -1], [-1, 0], [1, 0], [-1, 1], [1, 1]]}[n];
    g.fillStyle = "#fff"; P.forEach(function(p){ g.beginPath(); g.arc(128 + p[0]*64, 128 + p[1]*64, 24, 0, TAU); g.fill(); });
  }).t;
  t.colorSpace = c.THREE.SRGBColorSpace; return t;
}

/* ---------- the building on the street ---------- */
function build(c, site, opts){
  opts = opts || {};
  var T = c.THREE, F = frame(site), y0 = (+site.y || 0)/100;
  var g = new T.Group(); g.name = "casino"; g.position.set(F.cx, y0, F.cz); g.rotation.y = F.rot;
  var stat = new T.Group(); g.add(stat);
  var Wd = Math.min(F.w - 2, 46), Dd = Math.min(F.d - 2, 40), H = 13, PL = 0.35;
  var hw = Wd/2, hz0 = -Dd/2, hz1 = Dd/2 - 7;            // the hall's back and front (the front 7 m: the carpet and the canopy)
  var cr = Math.cos(F.rot), sr = Math.sin(F.rot);
  function world(x, z){ return {x: F.cx + x*cr + z*sr, z: F.cz - x*sr + z*cr}; }
  function box(w, h, d, m, x, y, z, p){ return c.box(w, h, d, m, x, y, z, p || stat); }
  var mat = function(col, o){ return c.mat(col, o); };
  var B = {g: g, doors: [], hits: [], glows: [], boxes: [], lod: [], decks: [], top: H + 18, tint: 0x2b2f38, kind: "casino",
           x: F.cx, y: y0, z: F.cz, site: site, frame: F};
  var nightMats = [], bulbs = [];
  function glowM(col, day, night){ var m = new T.MeshStandardMaterial({color: col, emissive: col, emissiveIntensity: day, roughness: 0.4}); nightMats.push([m, day, night]); return m; }

  // the plaza in front, the plinth, the hall in black glass with gold fins
  box(Wd + 1, 0.6, Dd + 1, mat(0xd9d2c3, {roughness: 0.6}), 0, PL - 0.3, 0);
  var glass = new T.MeshStandardMaterial({color: 0x0b0d12, roughness: 0.08, metalness: 0.9, emissive: 0x4a2a00, emissiveIntensity: 0});
  nightMats.push([glass, 0, 0.35]);
  var hall = new T.Mesh(new T.BoxGeometry(Wd, H, hz1 - hz0), glass); hall.position.set(0, PL + H/2, (hz0 + hz1)/2); hall.castShadow = true; stat.add(hall);
  var gold = mat(0xd4af37, {metalness: 0.9, roughness: 0.25});
  for(var fx = -hw + 1; fx <= hw - 1 + 1e-6; fx += 2.4) box(0.35, H, 0.5, gold, fx, PL + H/2, hz1 + 0.2);
  box(Wd + 0.6, 0.8, 0.8, gold, 0, PL + H + 0.4, hz1 + 0.2);
  // the hotel tower behind: lit windows by night
  var TW = Wd*0.6, TD = Math.min(14, (hz1 - hz0)*0.5), TH = 26;
  var winT = c.canvasTex(256, 512, function(gx){ gx.fillStyle = "#11141b"; gx.fillRect(0, 0, 256, 512); var R = c.rng(7);
    for(var i = 0; i < 8; i++) for(var j = 0; j < 22; j++){ gx.fillStyle = R() < 0.62 ? (R() < 0.5 ? "#ffd27a" : "#ffe9b8") : "#1d2230"; gx.fillRect(10 + i*30, 8 + j*23, 22, 14); } }).t;
  winT.colorSpace = T.SRGBColorSpace; winT.wrapS = winT.wrapT = T.RepeatWrapping; winT.repeat.set(Math.max(1, Math.round(TW/8)), 1);
  var towerM = new T.MeshStandardMaterial({map: winT, emissiveMap: winT, emissive: 0xffffff, emissiveIntensity: 0.05, roughness: 0.4, metalness: 0.3});
  nightMats.push([towerM, 0.05, 0.9]);
  var tower = new T.Mesh(new T.BoxGeometry(TW, TH, TD), towerM); tower.position.set(0, PL + H + TH/2, hz0 + TD/2 + 1); tower.castShadow = true; stat.add(tower);
  box(TW + 0.6, 0.6, TD + 0.6, gold, 0, PL + H + TH + 0.3, hz0 + TD/2 + 1);
  // the name on the roof, and a pair of giant dice turning beside it
  var nameT = signTex(c, "THE LUCKY BYTE", 1024, 192, "#fff2c2", "#ff3fb4");
  var nameM = new T.MeshStandardMaterial({map: nameT, emissiveMap: nameT, emissive: 0xffffff, emissiveIntensity: 0.4, transparent: true, side: T.DoubleSide, roughness: 0.5});
  nightMats.push([nameM, 0.4, 1.6]);
  var nameP = new T.Mesh(new T.PlaneGeometry(Wd*0.95, Wd*0.95*192/1024), nameM); nameP.position.set(0, PL + H + 2.6, hz1 + 0.35); g.add(nameP);
  box(Wd*0.95, 0.3, 0.6, mat(0x1a1a1a, {metalness: 0.6}), 0, PL + H + 0.9, hz1);
  var dice = new T.Group(); dice.position.set(hw - 4.5, PL + H + 3.6, hz1 - 3); g.add(dice);
  var dm = [1, 6, 2, 5, 3, 4].map(function(n){ return new T.MeshStandardMaterial({map: diceTex(c, n), roughness: 0.3}); });
  var d1 = new T.Mesh(new T.BoxGeometry(4, 4, 4), dm), d2 = new T.Mesh(new T.BoxGeometry(3.2, 3.2, 3.2), dm); d2.position.set(-3.4, -0.4, 1.2); d1.castShadow = d2.castShadow = true; dice.add(d1); dice.add(d2);
  box(1.6, 3, 1.6, gold, hw - 4.5, PL + H + 1.5, hz1 - 3);
  // the marquee: a canopy over the doors ringed in chasing bulbs, the doors, the red carpet, the stanchions, palms
  var cw = Math.min(16, Wd*0.5), cd = 6;
  box(cw, 0.5, cd, mat(0x1b1b22, {metalness: 0.5, roughness: 0.4}), 0, PL + 6.2, hz1 + cd/2);
  box(cw + 0.2, 1.1, 0.25, glowM(0xffcc66, 0.25, 1.8), 0, PL + 6.4, hz1 + cd + 0.05);
  [-1, 1].forEach(function(sd){ box(0.3, 6.2, 0.3, gold, sd*(cw/2 - 0.3), PL + 3.1, hz1 + cd - 0.3); });
  for(var b = 0; b < 40; b++){ var u = b/39; bulbs.push(new T.Vector3(-cw/2 + u*cw, PL + 5.75, hz1 + cd + 0.1)); }
  for(b = 0; b < 12; b++){ [-1, 1].forEach(function(sd){ bulbs.push(new T.Vector3(sd*cw/2, PL + 5.75, hz1 + cd - b*0.5)); }); }
  var bulbI = new T.InstancedMesh(new T.SphereGeometry(0.11, 8, 6), new T.MeshBasicMaterial({color: 0xffffff, toneMapped: false}), bulbs.length), dmx = new T.Object3D();
  bulbs.forEach(function(p, i){ dmx.position.copy(p); dmx.updateMatrix(); bulbI.setMatrixAt(i, dmx.matrix); bulbI.setColorAt(i, new T.Color(0xffd27a)); });
  g.add(bulbI);
  var doorM = new T.MeshStandardMaterial({color: 0xffe6b0, emissive: 0xffc870, emissiveIntensity: 0.3, roughness: 0.1, metalness: 0.2, transparent: true, opacity: 0.85});
  nightMats.push([doorM, 0.3, 1.3]);
  var doorP = new T.Mesh(new T.BoxGeometry(6, 4.2, 0.2), doorM); doorP.position.set(0, PL + 2.1, hz1 + 0.12); g.add(doorP);
  box(6.6, 0.4, 0.4, gold, 0, PL + 4.4, hz1 + 0.25); [-3.2, 3.2].forEach(function(x){ box(0.3, 4.4, 0.4, gold, x, PL + 2.2, hz1 + 0.25); });
  box(4.2, 0.06, cd + 6, mat(0x9b111e, {roughness: 0.9}), 0, PL + 0.03, hz1 + (cd + 6)/2);
  var brass = mat(0xd4a017, {metalness: 0.9, roughness: 0.3}), velvet = mat(0x7a0b16, {roughness: 0.9});
  [-1, 1].forEach(function(sd){
    for(var i = 0; i < 6; i++){ var z = hz1 + 1.5 + i*1.8; c.cyl(0.06, 0.08, 1, brass, sd*2.5, PL + 0.5, z, stat, 8); c.sph(0.1, brass, sd*2.5, PL + 1.05, z, stat);
      if(i < 5) c.add(new T.Mesh(new T.CylinderGeometry(0.04, 0.04, 1.8, 6), velvet), sd*2.5, PL + 0.85, z + 0.9, stat).rotation.x = PI/2; }
    // palms in gold planters
    var px = sd*(cw/2 + 2.2), pz = hz1 + 2.5;
    c.cyl(0.9, 0.7, 1, gold, px, PL + 0.5, pz, stat, 16);
    var trunk = new T.Mesh(new T.CylinderGeometry(0.16, 0.24, 6, 8), mat(0x8d6e4b, {roughness: 0.9})); trunk.position.set(px, PL + 4, pz); stat.add(trunk);
    var leaf = mat(0x2e8b57, {roughness: 0.8});
    for(var f = 0; f < 7; f++){ var a = f/7*TAU, fr = new T.Mesh(new T.ConeGeometry(0.35, 3.2, 4), leaf); fr.position.set(px + Math.cos(a)*1.2, PL + 6.6, pz + Math.sin(a)*1.2); fr.rotation.set(Math.sin(a)*1.2, 0, -Math.cos(a)*1.2); stat.add(fr); }
  });
  // a blade sign up the corner
  var bladeT = c.canvasTex(128, 640, function(gx){ gx.fillStyle = "#14070c"; gx.fillRect(0, 0, 128, 640); gx.strokeStyle = "#ffcc66"; gx.lineWidth = 8; gx.strokeRect(6, 6, 116, 628);
    gx.font = "900 86px 'Avenir Next', sans-serif"; gx.textAlign = "center"; gx.shadowColor = "#ff3fb4"; gx.shadowBlur = 20; gx.fillStyle = "#ffe0f2"; "CASINO".split("").forEach(function(ch, i){ gx.fillText(ch, 64, 100 + i*100); }); }).t;
  bladeT.colorSpace = T.SRGBColorSpace;
  var bladeM = new T.MeshStandardMaterial({map: bladeT, emissiveMap: bladeT, emissive: 0xffffff, emissiveIntensity: 0.35, roughness: 0.5}); nightMats.push([bladeM, 0.35, 1.5]);
  var blade = new T.Mesh(new T.BoxGeometry(0.5, 10, 2), [bladeM, bladeM, mat(0x14070c), mat(0x14070c), mat(0x14070c), mat(0x14070c)]); blade.position.set(-hw + 0.25, PL + 8, hz1 + 1); g.add(blade);
  var lightUp = c.glow ? c.glow(0xffb347, 26, 0) : null; if(lightUp){ lightUp.position.set(0, PL + 6, hz1 + 4); g.add(lightUp); B.glows.push(lightUp); }

  // the door into the casino floor: walk through it (E or a click on the doors too)
  var dp = world(0, hz1 + 1.4), out = world(0, hz1 + 10);   // out far enough down the carpet that the camera behind you is not in the hall
  var door = {view: "@casino", label: NAME, tip: NAME + ": the casino floor", front: new T.Vector3(dp.x, y0 + PL, dp.z)};
  doorP.userData.door = door; B.hits.push(doorP); B.doors.push(door);
  // out facing the casino: the chase camera behind you stands in the open street (not in the hall's bounds), the facade in view
  B.door = {x: out.x, z: out.z, yaw: F.rot + PI};
  // the masses: the hall (blocks you, the camera and the far boxes), the tower over it
  function note(cx, cz, w, d, ya, yb){
    var o = world(cx, cz), a = world(cx - w/2, cz - d/2), b2 = world(cx + w/2, cz + d/2), e = world(cx - w/2, cz + d/2), f2 = world(cx + w/2, cz - d/2);
    B.lod.push({x: o.x, z: o.z, w: w, d: d, rot: F.rot, y0: y0 + ya, y1: y0 + yb});
    B.boxes.push({min: {x: Math.min(a.x, b2.x, e.x, f2.x), y: y0 + ya, z: Math.min(a.z, b2.z, e.z, f2.z)}, max: {x: Math.max(a.x, b2.x, e.x, f2.x), y: y0 + yb, z: Math.max(a.z, b2.z, e.z, f2.z)},
                  o: {x: o.x, z: o.z, hw: w/2, hd: d/2, rot: F.rot, y0: ya}});
  }
  note(0, (hz0 + hz1)/2, Wd, hz1 - hz0, 0, PL + H + 1);
  note(0, hz0 + TD/2 + 1, TW, TD, PL + H, PL + H + TH + 0.6);
  B.inside = function(x, z){ var dx = x - F.cx, dz = z - F.cz, lx = dx*cr - dz*sr, lz = dx*sr + dz*cr; return Math.abs(lx) <= Wd/2 && lz >= hz0 && lz <= Dd/2 + 1; };
  var night = false, col = new T.Color();
  B.setNight = function(n){ night = !!n; nightMats.forEach(function(m){ m[0].emissiveIntensity = night ? m[2] : m[1]; }); if(lightUp) lightUp.material.opacity = night ? 0.45 : 0; };
  B.setNight(opts.night !== false);
  B.animate = function(t, dt, k){
    k = k == null ? 1 : k;
    d1.rotation.y += (dt || 0)*0.4*k; d1.rotation.x = Math.sin(t*0.5)*0.3*k; d2.rotation.y -= (dt || 0)*0.55*k; d2.rotation.z = Math.cos(t*0.4)*0.3*k;
    var step = k ? Math.floor(t*8) : 0;
    if(step !== B.step){ B.step = step; bulbs.forEach(function(p, i){ col.setHex(((i + step) % 4 === 0) ? 0xffffff : night ? 0xffb347 : 0xd9b36a); bulbI.setColorAt(i, col); }); bulbI.instanceColor.needsUpdate = true; }
  };
  if(HQV.hqMerge && HQV.hqMerge.mergeStatic){ try { HQV.hqMerge.mergeStatic(T, stat); } catch(e){} }
  stat.traverse(function(o){ if(o.isMesh) o.receiveShadow = true; });
  B.dispose = function(){ B.dead = true; };
  return B;
}

/* ---------- the casino floor ---------- */
var RX = 26, RZ = 20;
// the games and the secrets on the floor: where they are (x, z), how near is near (r), and what E does
var SPOTS = [
  {id: "cage", game: "cage", x: -RX + 4.6, z: -9, r: 2.6, label: "The Cage: chips for Poke Coins"},
  {id: "wheel", game: "wheel", x: -15, z: -RZ + 5.5, r: 3, label: "The Lucky Wheel"},
  {id: "plinko", game: "plinko", x: -5.5, z: -RZ + 5.5, r: 3, label: "Plinko"},
  {id: "race", game: "horses", x: 20.5, z: -RZ + 7.5, r: 4, label: "The Race Book"},
  {id: "roulette", game: "roulette", x: -13, z: 9.6, r: 3, label: "Roulette"},
  {id: "bj1", game: "blackjack", x: -2, z: 12.6, r: 3, label: "Blackjack"},
  {id: "bj2", game: "blackjack", x: -2, z: 1.6, r: 3, label: "Blackjack"},
  {id: "dice", game: "dice", x: 8, z: 15.4, r: 3, label: "The Dice Pit"},
  {id: "rocket", game: "rocket", x: 21.6, z: 12, r: 2.6, label: "Rocket"},
  {id: "scratch", game: "scratch", x: -21, z: 16.4, r: 2.4, label: "Scratch-O-Matic"},
  {id: "coin", game: "coin", x: -13, z: -2.6, r: 2.6, label: "Coin Toss"},
  {id: "duel", game: "duel", x: 16.5, z: 13.8, r: 3, label: "The Duel Table: bet against other players"}
];
var EGGS = ["duck", "staff", "broken", "cat", "asterisk", "tree", "ghost", "konami"];
var SLOT_BANKS = [{x0: 7, z: -5.5}, {x0: 7, z: 4.5}];       // two back-to-back banks of machines, six a side
var EGG_LINES = {
  duck: ["Quack. (The duck sees all. The duck judges all.)", "Quack. (The duck has never lost a hand. The duck has never played one.)", "QUACK. (The duck is the casino's longest-serving employee.)", "Quack. (Translation: \"have you tried not gambling?\")"],
  staff: ["Staff only. Behind this door: the vault, full of IOUs from everyone who said \"one more spin\".", "Locked. A muffled voice: \"the house always wins, Kevin, now get back to the floor\".", "You try the handle. A tiny sign lights up: NICE TRY."],
  broken: ["OUT OF ORDER since before the city was generated. Like your luck.", "The machine sighs. It has been out of order longer than you've been losing.", "Still out of order. Just like your strategy.", "You kick it. It does nothing. You both feel better."],
  catWin: ["The cat opens one eye. It has seen high rollers come and go."],
  cat: ["The cat has won more hands than you today. It was asleep for all of them.", "The cat yawns. It's a professional, it doesn't play when the odds are bad.", "The cat is not impressed. The cat is never impressed."],
  tree: ["A money tree! You reach for a leaf. It's paper. Like your bank statement.", "Money doesn't grow on trees. This one's a prop. Like your winning streak."],
  ghost: ["\"I was SO close... just one more seven...\" -- the ghost of machine 13, at it since 1997.", "The ghost of machine 13 nods at you. \"Don't end up like me, kid.\""],
  konami: ["↑↑↓↓←→←→ B A: disco mode! The house is too busy dancing to take your chips (it still will)."]
};

HQV.hqWorlds.casino = function(c, w){
  var T = c.THREE, S = w.scene, mat = c.mat, box = c.box, cyl = c.cyl, sph = c.sph;
  var stat = new T.Group(); stat.name = "casino-static"; S.add(stat);
  var hits = [], doors = [], spots = SPOTS.map(function(s){ return Object.assign({}, s); }), solids = [], timeLights = [], chars = [], anims = [];
  function sb(wd, h, d, m, x, y, z, p){ return box(wd, h, d, m, x, y, z, p || stat); }
  function solid(x, z, hw, hd){ solids.push({x0: x - hw, x1: x + hw, z0: z - hd, z1: z + hd}); }

  // light: warm and low, neon accents, a few lamps that pool on the felt
  var hemi = new T.HemisphereLight(0xffe2b8, 0x2a0d14, 1.6); S.add(hemi);
  var sun = new T.DirectionalLight(0xfff1dc, 0.9); sun.position.set(14, 30, 18); sun.castShadow = true;
  sun.shadow.mapSize.set(2048, 2048); var sc = sun.shadow.camera; sc.left = -30; sc.right = 30; sc.top = 26; sc.bottom = -26; sc.far = 90; S.add(sun); S.add(sun.target);
  [[-13, 6, 8, 0xffd9a0, 120], [-2, 6, 7, 0xffd9a0, 120], [12, 6, -1, 0xffd9a0, 110], [-14, 6, -10, 0xffc0e0, 90], [20, 6, -12, 0x9fd8ff, 90], [8, 6, 14, 0xffd9a0, 100]].forEach(function(p){
    var l = new T.PointLight(p[3], p[4], 0, 2); l.position.set(p[0], p[1], p[2]); l.userData.base = p[4]; l.userData.col = p[3]; S.add(l); timeLights.push(l); });

  // the carpet: a casino carpet, loud on purpose (a repeating swirl of gold, teal and plum on deep red)
  var carpet = c.canvasTex(512, 512, function(g){
    g.fillStyle = "#5a0d1c"; g.fillRect(0, 0, 512, 512);
    var R = c.rng(11);
    for(var i = 0; i < 4; i++) for(var j = 0; j < 4; j++){
      var x = i*128 + 64, y = j*128 + 64;
      g.strokeStyle = "#d4a537"; g.lineWidth = 6; g.beginPath(); for(var a = 0; a < 6; a++){ var an = a/6*TAU; g.moveTo(x, y); g.quadraticCurveTo(x + Math.cos(an + 0.6)*50, y + Math.sin(an + 0.6)*50, x + Math.cos(an)*58, y + Math.sin(an)*58); } g.stroke();
      g.fillStyle = "#1f8a8a"; g.beginPath(); g.arc(x, y, 14, 0, TAU); g.fill();
      g.fillStyle = "#6a2c70"; [[-64, -64], [64, -64], [-64, 64], [64, 64]].forEach(function(o){ g.beginPath(); g.arc(x + o[0], y + o[1], 18, 0, TAU); g.fill(); });
      g.strokeStyle = "rgba(255,210,120,.35)"; g.lineWidth = 2; g.beginPath(); g.arc(x, y, 40 + R()*6, 0, TAU); g.stroke();
    }
  });
  carpet.t.wrapS = carpet.t.wrapT = T.RepeatWrapping; carpet.t.repeat.set(RX/4, RZ/4);
  var floor = new T.Mesh(new T.PlaneGeometry(2*RX, 2*RZ), new T.MeshStandardMaterial({map: carpet.t, roughness: 0.95})); floor.rotation.x = -PI/2; floor.receiveShadow = true; S.add(floor);

  // walls: the back and the left tall, dark wood panels with gold trim; the front and right a low balustrade (the camera looks in)
  var wood = mat(0x2a1414, {roughness: 0.6}), goldM = mat(0xd4af37, {metalness: 0.9, roughness: 0.25}), dark = mat(0x120a0c, {roughness: 0.7});
  sb(2*RX, 10, 0.5, wood, 0, 5, -RZ - 0.25); sb(0.5, 10, 2*RZ, wood, -RX - 0.25, 5, 0);
  for(var px = -RX + 2; px < RX; px += 4) sb(0.18, 10, 0.2, goldM, px, 5, -RZ + 0.05);
  for(var pz = -RZ + 2; pz < RZ; pz += 4) if(Math.abs(pz - 12) > 3) sb(0.2, 10, 0.18, goldM, -RX + 0.05, 5, pz);
  sb(2*RX, 0.3, 0.4, goldM, 0, 9.8, -RZ + 0.1); sb(0.4, 0.3, 2*RZ, goldM, -RX + 0.1, 9.8, 0);
  sb(2*RX, 1.1, 0.3, dark, 0, 0.55, RZ + 0.15); sb(0.3, 1.1, 2*RZ, dark, RX + 0.15, 0.55, 0);
  sb(2*RX, 0.12, 0.45, goldM, 0, 1.16, RZ + 0.15); sb(0.45, 0.12, 2*RZ, goldM, RX + 0.15, 1.16, 0);

  // the neon name over the bar
  var nameT = signTex(c, NAME.toUpperCase(), 1024, 160, "#fff2c2", "#ff3fb4");
  var nameM = new T.MeshBasicMaterial({map: nameT, transparent: true, toneMapped: false}); var name = new T.Mesh(new T.PlaneGeometry(16, 2.5), nameM); name.position.set(8, 7.6, -RZ + 0.3); S.add(name);
  var neonL = [];
  [[-RX + 0.3, 0], [8, 1]].forEach(function(q, i){ var n = new T.Mesh(new T.BoxGeometry(i ? 17 : 0.12, 0.12, i ? 0.12 : 2*RZ - 2), new T.MeshBasicMaterial({color: 0xff3fb4, toneMapped: false})); n.position.set(q[0], 9.2, i ? -RZ + 0.35 : 0); S.add(n); neonL.push(n); });

  // the entrance: gold-framed glass doors in the left wall, the street beyond, the way out
  var street = c.screen(10, 6.5, c.sky(false)); street.position.set(-RX - 1.6, 3.25, 12); street.rotation.y = PI/2; S.add(street);
  var glassM = mat(0xffe6b0, {transparent: true, opacity: 0.18, roughness: 0.05});
  var dl = sb(0.08, 4.4, 2, glassM, -RX + 0.05, 2.2, 11), dr = sb(0.08, 4.4, 2, glassM, -RX + 0.05, 2.2, 13);
  sb(0.3, 0.4, 6, goldM, -RX + 0.1, 4.6, 12); [9, 15].forEach(function(z){ sb(0.3, 4.6, 0.3, goldM, -RX + 0.1, 2.3, z); });
  var exit = {view: "@city", label: "Way out", tip: "The way out: back to the street", front: new T.Vector3(-RX + 1.6, 0, 12)};
  // the doorway itself is what you click: the glass slides away as you come near, and an open door is still a door
  var doorway = new T.Mesh(new T.PlaneGeometry(4, 4.4), new T.MeshBasicMaterial({transparent: true, opacity: 0, depthWrite: false})); doorway.position.set(-RX + 0.2, 2.2, 12); doorway.rotation.y = PI/2; S.add(doorway);
  [dl, dr, doorway].forEach(function(o){ o.userData.door = exit; hits.push(o); }); doors.push(exit);
  var exitT = c.label("Way out · the street", c.HEX.green, 0.55); exitT.position.set(-RX + 0.6, 5.4, 12); S.add(exitT);
  sb(9, 0.03, 2.4, mat(0x9b111e, {roughness: 0.95}), -RX + 4.5, 0.015, 12);

  // the cage: a counter behind gold bars, the cashier, stacks of chips
  sb(1.2, 1.2, 10, mat(0x3a2018, {roughness: 0.5}), -RX + 3.2, 0.6, -9); sb(1.4, 0.08, 10.2, goldM, -RX + 3.2, 1.24, -9);
  for(var bz = -13.8; bz <= -4.2; bz += 0.5) sb(0.06, 2.6, 0.06, goldM, -RX + 3.4, 2.6, bz);
  sb(0.2, 0.3, 10, goldM, -RX + 3.4, 3.9, -9);
  var cageT = signTex(c, "THE CAGE · CHIPS ⇄ COINS", 1024, 128, "#fff6d5", "#ffb300", "#140b05"); var cs = c.screen(7, 0.9, cageT); cs.position.set(-RX + 3.5, 4.6, -9); cs.rotation.y = PI/2; S.add(cs);
  var chipCols = [0xe63946, 0x3a86ff, 0x2a9d8f, 0x111111, 0xffbe0b, 0x8338ec];
  for(var ch = 0; ch < 12; ch++) cyl(0.18, 0.18, 0.06*(4 + ch % 5), mat(chipCols[ch % 6], {roughness: 0.4}), -RX + 3.0, 1.28 + 0.03*(4 + ch % 5), -13 + ch*0.7, stat, 14);
  solid(-RX + 2.3, -9, 1.9, 5.2);

  // the Lucky Wheel on the back wall: it turns slowly; a spin at the panel spins it
  var wheelG = new T.Group(); wheelG.position.set(-15, 5.4, -RZ + 0.6); S.add(wheelG);
  var WSEG = 50, wheelT = c.canvasTex(1024, 1024, function(g){
    var COL = ["#2d2d3a", "#00b4d8", "#4361ee", "#9d4edd", "#ff9f1c", "#ffd60a"], seq = [0, 1, 0, 2, 0, 1, 0, 3, 0, 1, 0, 4, 0, 1, 0, 2, 0, 0, 1, 0, 3, 0, 5, 0, 1, 0, 2, 0, 0, 1, 0, 4, 0, 1, 0, 3, 0, 2, 0, 0, 1, 0, 0, 2, 0, 0, 0, 0, 0, 0];
    for(var i = 0; i < WSEG; i++){ g.fillStyle = COL[seq[i]]; g.beginPath(); g.moveTo(512, 512); g.arc(512, 512, 500, i/WSEG*TAU, (i + 1)/WSEG*TAU); g.closePath(); g.fill(); g.strokeStyle = "rgba(255,255,255,.3)"; g.lineWidth = 3; g.stroke(); }
    g.fillStyle = "#ffd54f"; g.beginPath(); g.arc(512, 512, 70, 0, TAU); g.fill();
  });
  var wheel = new T.Mesh(new T.CircleGeometry(3.6, 64), new T.MeshStandardMaterial({map: wheelT.t, roughness: 0.4, emissive: 0xffffff, emissiveMap: wheelT.t, emissiveIntensity: 0.25})); wheelG.add(wheel);
  var wheelRim = new T.Mesh(new T.TorusGeometry(3.7, 0.18, 8, 64), goldM); wheelG.add(wheelRim);
  var wbulbs = new T.Group(); wheelG.add(wbulbs);
  for(var wb = 0; wb < 24; wb++){ var wa = wb/24*TAU, bl = new T.Mesh(new T.SphereGeometry(0.09, 6, 4), new T.MeshBasicMaterial({color: wb % 2 ? 0xfff59d : 0xff6b6b, toneMapped: false})); bl.position.set(Math.cos(wa)*4.05, Math.sin(wa)*4.05, 0.1); wbulbs.add(bl); }
  var pointer = new T.Mesh(new T.ConeGeometry(0.35, 0.8, 3), goldM); pointer.position.set(0, 4.2, 0.2); pointer.rotation.z = PI; wheelG.add(pointer);
  cyl(0.5, 0.7, 1.6, dark, -15, 0.8, -RZ + 1, stat, 12); solid(-15, -RZ + 1, 1.2, 1.2);

  // Plinko: a tall board of pegs on the back wall, the bins along its foot lit
  var plG = new T.Group(); plG.position.set(-5.5, 0, -RZ + 0.5); S.add(plG);
  c.add(new T.Mesh(new T.BoxGeometry(6, 8, 0.3), mat(0x1b1035, {roughness: 0.5})), 0, 4.6, 0, plG);
  var pegM = mat(0xe0d7ff, {metalness: 0.7, roughness: 0.2});
  for(var pr = 0; pr < 11; pr++) for(var pi2 = 0; pi2 <= pr + 2; pi2++) c.add(new T.Mesh(new T.SphereGeometry(0.06, 6, 4), pegM), (pi2 - (pr + 2)/2)*0.42, 7.8 - pr*0.5, 0.2, plG);
  for(var pb = 0; pb < 13; pb++){ var m3 = [10, 3, 1.6, 1.3, 1.1, 0.95, 0.5][Math.abs(pb - 6) > 6 ? 0 : 6 - Math.abs(pb - 6)]; c.add(new T.Mesh(new T.BoxGeometry(0.38, 0.4, 0.2), new T.MeshBasicMaterial({color: m3 >= 3 ? 0xff3d71 : m3 >= 1.3 ? 0xff9f1c : m3 >= 1 ? 0xffd166 : 0x4cc9f0, toneMapped: false})), (pb - 6)*0.42, 1.9, 0.25, plG); }
  var plBall = c.add(new T.Mesh(new T.SphereGeometry(0.12, 10, 8), new T.MeshBasicMaterial({color: 0xffeb3b, toneMapped: false})), 0, 8, 0.3, plG);
  sb(6.4, 0.9, 1.2, dark, -5.5, 0.45, -RZ + 1); solid(-5.5, -RZ + 1, 3.3, 0.9);
  var plTag = c.label("Plinko", c.HEX.violet || "#c084fc", 0.5); plTag.position.set(-5.5, 9.4, -RZ + 0.8); S.add(plTag);

  // the bar: a long counter, back-lit shelves of bottles, stools, the bartender; the duck at the end
  sb(12, 1.15, 1.2, mat(0x4a1c12, {roughness: 0.45}), 8, 0.575, -RZ + 3.6); sb(12.4, 0.1, 1.5, mat(0x111111, {metalness: 0.6, roughness: 0.15}), 8, 1.2, -RZ + 3.6);
  sb(12, 0.12, 0.6, goldM, 8, 0.15, -RZ + 4.25);
  [2.2, 3.4, 4.6].forEach(function(y){ sb(12, 0.08, 0.5, mat(0x2b1d14), 8, y, -RZ + 0.5); });
  var bottleCols = [0x2e7d32, 0x8d6e63, 0xffb300, 0x1565c0, 0xc62828, 0xe0e0e0, 0x6a1b9a], nb = 0;
  var bottleI = new T.InstancedMesh(new T.CylinderGeometry(0.08, 0.1, 0.5, 8), new T.MeshStandardMaterial({roughness: 0.15, metalness: 0.1, transparent: true, opacity: 0.85, emissive: 0x332211, emissiveIntensity: 0.6}), 66), bm4 = new T.Object3D();
  [2.2, 3.4, 4.6].forEach(function(y){ for(var i = 0; i < 22; i++){ bm4.position.set(2.4 + i*0.53, y + 0.3, -RZ + 0.5); bm4.updateMatrix(); bottleI.setMatrixAt(nb, bm4.matrix); bottleI.setColorAt(nb, new T.Color(bottleCols[(i*3 + y*7 | 0) % 7])); nb++; } });
  S.add(bottleI);
  var backlight = new T.Mesh(new T.PlaneGeometry(12, 3.4), new T.MeshBasicMaterial({color: 0xff9f43, transparent: true, opacity: 0.35, toneMapped: false})); backlight.position.set(8, 3.4, -RZ + 0.27); S.add(backlight);
  var stools = [];
  for(var st = 0; st < 7; st++){ var sx = 3 + st*1.7; cyl(0.06, 0.06, 0.75, goldM, sx, 0.38, -RZ + 5.1, stat, 6); cyl(0.3, 0.3, 0.12, mat(0x9b111e, {roughness: 0.6}), sx, 0.8, -RZ + 5.1, stat, 14); stools.push(sx); }
  solid(8, -RZ + 2.2, 6.3, 2.2);
  var duck = new T.Group(); duck.position.set(13.6, 1.25, -RZ + 3.5); S.add(duck);
  var duckM = mat(0xffd600, {roughness: 0.35});
  c.add(new T.Mesh(new T.SphereGeometry(0.2, 12, 10), duckM), 0, 0.16, 0, duck).scale.set(1.2, 0.9, 1);
  c.add(new T.Mesh(new T.SphereGeometry(0.13, 10, 8), duckM), 0.14, 0.38, 0, duck);
  c.add(new T.Mesh(new T.ConeGeometry(0.06, 0.14, 8), mat(0xff6d00)), 0.3, 0.37, 0, duck).rotation.z = -PI/2;
  spots.push({id: "duck", egg: "duck", x: 13.6, z: -RZ + 5.2, r: 1.6, label: "A rubber duck"});
  // the cat asleep on the last stool
  var cat = new T.Group(); cat.position.set(stools[6], 0.9, -RZ + 5.1); S.add(cat);
  var catM = mat(0x3b3b3b, {roughness: 0.9});
  c.add(new T.Mesh(new T.SphereGeometry(0.22, 12, 8), catM), 0, 0.1, 0, cat).scale.set(1.3, 0.6, 1);
  c.add(new T.Mesh(new T.SphereGeometry(0.12, 10, 8), catM), 0.22, 0.14, 0.05, cat);
  [-0.06, 0.06].forEach(function(z){ c.add(new T.Mesh(new T.ConeGeometry(0.04, 0.08, 4), catM), 0.25, 0.26, 0.05 + z, cat); });
  var tail = c.add(new T.Mesh(new T.CylinderGeometry(0.025, 0.02, 0.4, 6), catM), -0.3, 0.08, 0.1, cat); tail.rotation.z = 1.2;
  spots.push({id: "cat", egg: "cat", x: stools[6], z: -RZ + 6.4, r: 1.4, label: "A sleeping cat"});

  // the Race Book: a wall of screens over the lounge, the race looping on them
  var raceTex = c.canvasTex(1024, 384), raceS = c.screen(9.5, 3.56, raceTex.t); raceS.position.set(20.5, 5.6, -RZ + 0.3); S.add(raceS);
  sb(10, 4, 0.2, mat(0x101318, {metalness: 0.6}), 20.5, 5.6, -RZ + 0.15);
  [16.5, 24.5].forEach(function(x){ var tv = c.canvasTex(256, 160, function(g){ g.fillStyle = "#06121f"; g.fillRect(0, 0, 256, 160); g.fillStyle = "#7CFFB2"; g.font = "700 20px ui-monospace, monospace"; ["ODDS", "1 3.3x", "2 4.3x", "3 5.2x", "4 6.7x", "5 9.5x", "6 11.8x"].forEach(function(s, i){ g.fillText(s, 14, 24 + i*21); }); }); var s3 = c.screen(2.4, 1.5, tv.t); s3.position.set(x, 8.6, -RZ + 0.3); S.add(s3); });
  var loungeM = mat(0x1d3557, {roughness: 0.9});
  for(var lr = 0; lr < 2; lr++) for(var lc = 0; lc < 4; lc++){ var lx = 17 + lc*2.4, lz = -RZ + 7.5 + lr*2.6; sb(1.8, 0.5, 1.2, loungeM, lx, 0.25, lz); sb(1.8, 0.8, 0.25, loungeM, lx, 0.7, lz + 0.5); solid(lx, lz, 0.95, 0.7); }
  var raceTag = c.label("The Race Book", c.HEX.green, 0.6); raceTag.position.set(20.5, 9.9, -RZ + 0.8); S.add(raceTag);

  // the slot banks: back-to-back machines with lit toppers and attract screens; one has been out of order forever
  var attract = [0, 1, 2].map(function(){ return c.canvasTex(256, 192); });
  var attractM = attract.map(function(A){ return new T.MeshBasicMaterial({map: A.t, toneMapped: false}); }), topperM = {};
  function topper(col){ return topperM[col] || (topperM[col] = new T.MeshStandardMaterial({color: col, emissive: col, emissiveIntensity: 0.9, roughness: 0.4})); }
  var cabM = mat(0x1b1b2a, {roughness: 0.35, metalness: 0.4}), topperCols = [0xff3fb4, 0x3a86ff, 0xffbe0b, 0x2a9d8f], seats = [], machineN = 0;
  SLOT_BANKS.forEach(function(Bk){
    sb(15, 1.6, 0.5, dark, Bk.x0 + 7, 0.8, Bk.z); solid(Bk.x0 + 7, Bk.z, 7.6, 1.5);
    [-1, 1].forEach(function(face){
      for(var i = 0; i < 6; i++){
        var x = Bk.x0 + 1.2 + i*2.4, z = Bk.z + face*0.95, n = ++machineN, broken = n === 12, ghostly = n === 13;
        var g2 = new T.Group(); g2.position.set(x, 0, z); g2.rotation.y = face > 0 ? 0 : PI; S.add(g2);
        c.add(new T.Mesh(new T.BoxGeometry(1.5, 2.1, 0.9), cabM), 0, 1.05, 0, g2);
        c.add(new T.Mesh(new T.BoxGeometry(1.5, 0.7, 0.9), broken ? mat(0x333333) : topper(topperCols[n % 4])), 0, 2.5, 0, g2);
        var scr = broken ? c.screen(1.2, 0.9, signTex(c, "OUT OF ORDER", 256, 96, "#ff5252", "#ff0000", "#0b0b0b")) : new T.Mesh(new T.PlaneGeometry(1.2, 0.9), attractM[n % 3]); scr.position.set(0, 1.55, 0.46); g2.add(scr);
        c.add(new T.Mesh(new T.BoxGeometry(1.3, 0.12, 0.5), goldM), 0, 0.95, 0.6, g2);
        var lever = c.add(new T.Mesh(new T.CylinderGeometry(0.04, 0.04, 0.8, 6), goldM), 0.85, 1.6, 0.1, g2); c.add(new T.Mesh(new T.SphereGeometry(0.1, 8, 6), mat(0xc62828)), 0.85, 2.0, 0.1, g2);
        if(ghostly){ var nP = c.screen(0.3, 0.22, signTex(c, "13", 128, 96, "#fff", "#ffb300")); nP.position.set(0.55, 2.5, 0.46); g2.add(nP); }   // the ghost's machine
        // a stool in front, and the spot
        var fz = z + face*1.4;
        cyl(0.05, 0.05, 0.7, goldM, x, 0.35, fz, stat, 6); cyl(0.26, 0.26, 0.1, mat(0x9b111e, {roughness: 0.6}), x, 0.75, fz, stat, 12);
        if(broken) spots.push({id: "broken", egg: "broken", x: x, z: z + face*2.1, r: 1.1, label: "An out-of-order machine"});
        else spots.push({id: "slot" + n, game: "slots", x: x, z: z + face*2.1, r: 1.1, label: "Slots · machine " + n});
        seats.push({x: x, z: fz, yaw: face > 0 ? PI : 0, n: n, ghost: ghostly, broken: broken});
        g2.traverse(function(o){ if(o.isMesh) o.castShadow = true; });
      }
    });
  });
  var slotTag = c.label("Slots", "#ff8ad8", 0.6); slotTag.position.set(14, 4.4, -0.5); S.add(slotTag);

  // a gaming table: felt in a gold-railed oval (or a half-moon), its layout printed on the felt
  function table(x, z, w2, d2, kind, rot){
    var tg = new T.Group(); tg.position.set(x, 0, z); tg.rotation.y = rot || 0; S.add(tg);
    var feltT = c.canvasTex(512, 256, function(g){
      g.fillStyle = "#0f6b3a"; g.fillRect(0, 0, 512, 256); g.strokeStyle = "rgba(255,230,150,.7)"; g.lineWidth = 4; g.fillStyle = "rgba(255,230,150,.85)"; g.textAlign = "center";
      if(kind === "roulette"){ for(var i = 0; i < 12; i++) for(var j = 0; j < 3; j++){ var n = i*3 + 3 - j, red = [1, 3, 5, 7, 9, 12, 14, 16, 18, 19, 21, 23, 25, 27, 30, 32, 34, 36].indexOf(n) >= 0; g.fillStyle = red ? "#b71c1c" : "#111"; g.fillRect(150 + i*28, 50 + j*40, 26, 38); g.fillStyle = "#fff"; g.font = "700 14px sans-serif"; g.fillText(String(n), 163 + i*28, 74 + j*40); } g.fillStyle = "#1b8a3e"; g.fillRect(120, 50, 28, 118); }
      else if(kind === "blackjack"){ g.beginPath(); g.arc(256, -60, 260, 0.2*PI, 0.8*PI); g.stroke(); g.font = "700 22px Georgia, serif"; g.fillText("BLACKJACK PAYS 3 TO 2", 256, 150); for(var s = 0; s < 5; s++){ var a = 0.28*PI + s*0.11*PI; g.strokeRect(256 + Math.cos(a)*200 - 18, -60 + Math.sin(a)*200 + 40, 36, 50); } }
      else { g.font = "800 30px sans-serif"; g.fillText("OVER 7  ·  UNDER 7", 256, 90); g.fillText("SEVEN  ·  DOUBLES", 256, 150); g.strokeRect(20, 20, 472, 216); }
    });
    var top = new T.Mesh(new T.BoxGeometry(w2, 0.12, d2), mat(0x4a2a16)); top.position.y = 0.92; tg.add(top);
    var fe = new T.Mesh(new T.PlaneGeometry(w2 - 0.1, d2 - 0.1), new T.MeshStandardMaterial({map: feltT.t, roughness: 0.95})); fe.rotation.x = -PI/2; fe.position.y = 0.985; tg.add(fe);
    c.add(new T.Mesh(new T.BoxGeometry(w2 + 0.3, 0.16, 0.25), mat(0x3e2412, {roughness: 0.5})), 0, 1.0, d2/2 + 0.05, tg); c.add(new T.Mesh(new T.BoxGeometry(w2 + 0.3, 0.16, 0.25), mat(0x3e2412, {roughness: 0.5})), 0, 1.0, -d2/2 - 0.05, tg);
    c.add(new T.Mesh(new T.BoxGeometry(w2*0.8, 0.85, d2*0.7), dark), 0, 0.43, 0, tg);
    tg.traverse(function(o){ if(o.isMesh) o.castShadow = true; });
    return tg;
  }
  var rt = table(-13, 7, 5.2, 2.4, "roulette");
  var rwG = new T.Group(); rwG.position.set(-15.1, 1.05, 7); S.add(rwG);
  var rwT = c.canvasTex(512, 512, function(g){ var ord = [0, 32, 15, 19, 4, 21, 2, 25, 17, 34, 6, 27, 13, 36, 11, 30, 8, 23, 10, 5, 24, 16, 33, 1, 20, 14, 31, 9, 22, 18, 29, 7, 28, 12, 35, 3, 26];
    ord.forEach(function(n, i){ g.fillStyle = n === 0 ? "#1b8a3e" : [1, 3, 5, 7, 9, 12, 14, 16, 18, 19, 21, 23, 25, 27, 30, 32, 34, 36].indexOf(n) >= 0 ? "#c62828" : "#111"; g.beginPath(); g.moveTo(256, 256); g.arc(256, 256, 250, i/37*TAU, (i + 1)/37*TAU); g.closePath(); g.fill(); });
    g.fillStyle = "#3e2412"; g.beginPath(); g.arc(256, 256, 130, 0, TAU); g.fill(); g.fillStyle = "#d4af37"; g.beginPath(); g.arc(256, 256, 40, 0, TAU); g.fill(); });
  var rWheel = new T.Mesh(new T.CircleGeometry(0.8, 48), new T.MeshStandardMaterial({map: rwT.t, roughness: 0.4})); rWheel.rotation.x = -PI/2; rwG.add(rWheel);
  c.add(new T.Mesh(new T.TorusGeometry(0.85, 0.1, 8, 40), mat(0x4e2a14)), 0, 0.02, 0, rwG).rotation.x = PI/2;
  var rBall = c.add(new T.Mesh(new T.SphereGeometry(0.04, 8, 6), mat(0xffffff)), 0.7, 0.06, 0, rwG);
  solid(-13, 7, 2.9, 1.5);
  table(-2, 10, 4, 2.2, "blackjack"); solid(-2, 10, 2.3, 1.4);
  table(-2, -1, 4, 2.2, "blackjack"); solid(-2, -1, 2.3, 1.4);
  table(8, 13, 4.6, 2.4, "dice"); solid(8, 13, 2.6, 1.5);
  var pitDice = [0, 1].map(function(i){ var d = new T.Mesh(new T.BoxGeometry(0.22, 0.22, 0.22), [1, 6, 2, 5, 3, 4].map(function(n){ return new T.MeshStandardMaterial({map: diceTex(c, n), roughness: 0.3}); })); d.position.set(7.6 + i*0.5, 1.1, 13); S.add(d); return d; });
  // the Duel Table: player against player, under its own neon
  table(16.5, 11, 4, 2.2, "dice"); solid(16.5, 11, 2.3, 1.4);
  var duelS = c.screen(5, 1, signTex(c, "\u2694 THE DUEL TABLE \u00b7 PvP", 1024, 200, "#ffe0f2", "#ff3fb4", "#14070c")); duelS.position.set(16.5, 3.6, 9.4); S.add(duelS);
  var tTags = [["Roulette", -13, 8.8], ["Blackjack", -2, 11.6], ["Blackjack", -2, 0.6], ["The Dice Pit", 8, 14.8]];
  tTags.forEach(function(q){ var lt = c.label(q[0], c.HEX.amber, 0.5); lt.position.set(q[1], 3.4, q[2] - 2); S.add(lt); });

  // the Rocket cabinet by the right rail: a tall arcade cabinet with a rocket on its screen
  var rocketT = c.canvasTex(256, 320), rocketG = new T.Group(); rocketG.position.set(24, 0, 12); rocketG.rotation.y = -PI/2; S.add(rocketG);
  c.add(new T.Mesh(new T.BoxGeometry(1.8, 2.8, 1.2), mat(0x16213e, {roughness: 0.4, metalness: 0.4})), 0, 1.4, 0, rocketG);
  var rsc = c.screen(1.4, 1.75, rocketT.t); rsc.position.set(0, 1.9, 0.61); rocketG.add(rsc);
  c.add(new T.Mesh(new T.BoxGeometry(1.8, 0.5, 1.2), new T.MeshStandardMaterial({color: 0xff4d6d, emissive: 0xff4d6d, emissiveIntensity: 0.8})), 0, 3.05, 0, rocketG);
  solid(24, 12, 0.8, 1.1);
  // the Scratch-O-Matic by the door: a vending machine of tickets
  var scrG = new T.Group(); scrG.position.set(-21, 0, 18.6); scrG.rotation.y = PI; S.add(scrG);
  c.add(new T.Mesh(new T.BoxGeometry(1.6, 2.4, 1), new T.MeshStandardMaterial({color: 0xffb300, roughness: 0.4, emissive: 0x442200, emissiveIntensity: 0.4})), 0, 1.2, 0, scrG);
  var scrS = c.screen(1.3, 0.6, signTex(c, "SCRATCH-O-MATIC", 512, 128, "#2b1600", "#ffe082", "#ffecb3")); scrS.position.set(0, 2.05, 0.51); scrG.add(scrS);
  var tickT = c.canvasTex(256, 256, function(g){ g.fillStyle = "#1a1300"; g.fillRect(0, 0, 256, 256); for(var i = 0; i < 6; i++){ g.fillStyle = ["#ff7043", "#66bb6a", "#42a5f5"][i % 3]; g.fillRect(20 + (i % 3)*76, 20 + Math.floor(i/3)*110, 64, 96); g.fillStyle = "#cfd8dc"; g.fillRect(28 + (i % 3)*76, 56 + Math.floor(i/3)*110, 48, 44); } });
  var tickS = c.screen(1.2, 1.2, tickT.t); tickS.position.set(0, 1.15, 0.51); scrG.add(tickS);
  solid(-21, 18.6, 0.9, 0.6);
  // the Coin Toss: a giant gold coin turning over a marble plinth
  cyl(0.9, 1.1, 1.2, mat(0xeee8dd, {roughness: 0.3}), -13, 0.6, -5, stat, 24); solid(-13, -5, 1.2, 1.2);
  var bigCoin = new T.Mesh(new T.CylinderGeometry(1, 1, 0.16, 40), [mat(0xb8860b, {metalness: 0.95, roughness: 0.2}), new T.MeshStandardMaterial({map: (function(){ var t = c.canvasTex(256, 256, function(g){ var gr = g.createRadialGradient(100, 100, 10, 128, 128, 128); gr.addColorStop(0, "#fff3b0"); gr.addColorStop(1, "#c99700"); g.fillStyle = gr; g.fillRect(0, 0, 256, 256); g.fillStyle = "#8c6a00"; g.font = "900 140px system-ui"; g.textAlign = "center"; g.textBaseline = "middle"; g.fillText("✳", 128, 136); }).t; t.colorSpace = T.SRGBColorSpace; return t; })(), metalness: 0.9, roughness: 0.25}), mat(0xd4a017, {metalness: 0.95, roughness: 0.2})]);
  bigCoin.position.set(-13, 2.6, -5); bigCoin.rotation.x = PI/2; S.add(bigCoin);
  var coinTag = c.label("Coin Toss", c.HEX.amber, 0.5); coinTag.position.set(-13, 4.4, -5); S.add(coinTag);

  // the golden asterisk by the door (its plaque: the honest odds), and the money tree
  var ast = new T.Group(); ast.position.set(-20, 0, 6.5); S.add(ast);
  cyl(0.7, 0.8, 1, mat(0x1a1a1a, {roughness: 0.4}), 0, 0.5, 0, ast, 16);
  for(var ai = 0; ai < 4; ai++){ var arm = c.add(new T.Mesh(new T.BoxGeometry(0.3, 2.2, 0.3), goldM), 0, 2.3, 0, ast); arm.rotation.z = ai*PI/4; }
  spots.push({id: "asterisk", egg: "asterisk", x: -20, z: 8.4, r: 1.6, label: "A golden asterisk"}); solid(-20, 6.5, 0.9, 0.9);
  var tree = new T.Group(); tree.position.set(RX - 2, 0, RZ - 2); S.add(tree);
  cyl(0.6, 0.45, 0.8, goldM, 0, 0.4, 0, tree, 16); c.add(new T.Mesh(new T.CylinderGeometry(0.08, 0.12, 2, 6), mat(0x6d4c41)), 0, 1.8, 0, tree);
  var billM = mat(0x8bc34a, {roughness: 0.8, side: T.DoubleSide});
  for(var lf = 0; lf < 26; lf++){ var la = lf*2.4, lh = 2.2 + (lf % 6)*0.25, bill = c.add(new T.Mesh(new T.PlaneGeometry(0.42, 0.2), billM), Math.cos(la)*0.6*(lf % 3 ? 1 : 0.6), lh, Math.sin(la)*0.6, tree); bill.rotation.set(la, la*0.6, 0.4); }
  spots.push({id: "tree", egg: "tree", x: RX - 3.6, z: RZ - 3.2, r: 1.6, label: "A suspicious money tree"}); solid(RX - 2, RZ - 2, 0.8, 0.8);
  // the door marked Staff Only, back left
  var staff = sb(1.6, 3, 0.15, mat(0x3a2520, {roughness: 0.6}), -RX + 3, 1.5, -RZ + 0.1);
  var staffS = c.screen(1.3, 0.35, signTex(c, "STAFF ONLY", 256, 64, "#ffffff", "#ff5252", "#7a0f0f")); staffS.position.set(-RX + 3, 3.3, -RZ + 0.2); S.add(staffS);
  spots.push({id: "staff", egg: "staff", x: -RX + 3, z: -RZ + 1.8, r: 1.3, label: "A door marked Staff Only"});

  // chandeliers: gold rings of crystal drops on long chains, a glow at their heart
  var crystals = [];
  [[-13, 3], [-2, 5], [10, 6], [8, -11]].forEach(function(q, n){
    var cg = new T.Group(); cg.position.set(q[0], 8.4, q[1]); S.add(cg);
    c.add(new T.Mesh(new T.TorusGeometry(1.2, 0.06, 6, 32), goldM), 0, 0, 0, cg).rotation.x = PI/2;
    c.add(new T.Mesh(new T.TorusGeometry(0.7, 0.05, 6, 24), goldM), 0, -0.5, 0, cg).rotation.x = PI/2;
    c.add(new T.Mesh(new T.CylinderGeometry(0.02, 0.02, 6, 4), goldM), 0, 3, 0, cg);
    for(var i = 0; i < 18; i++){ var a = i/18*TAU, ring = i % 2 ? 1.2 : 0.7, cy = i % 2 ? -0.25 : -0.75; crystals.push([q[0] + Math.cos(a)*ring, 8.4 + cy, q[1] + Math.sin(a)*ring, n]); }
    var gl = c.glow ? c.glow(0xfff1c4, 4.5, 0.55) : null; if(gl){ gl.position.set(0, -0.4, 0); cg.add(gl); }
  });
  var crystalI = new T.InstancedMesh(new T.OctahedronGeometry(0.11, 0), new T.MeshStandardMaterial({color: 0xffffff, roughness: 0.05, metalness: 0.2, emissive: 0xfff3d6, emissiveIntensity: 0.5}), crystals.length), cm4 = new T.Object3D();
  crystals.forEach(function(p, i){ cm4.position.set(p[0], p[1], p[2]); cm4.scale.set(1, 1.8, 1); cm4.updateMatrix(); crystalI.setMatrixAt(i, cm4.matrix); }); S.add(crystalI);

  // decorative plants along the walls
  c.plant(-RX + 1.4, -RZ + 1.4, 1.3, 21); c.plant(RX - 1.4, -RZ + 1.4, 1.2, 22); c.plant(-RX + 1.4, RZ - 1.4, 1.2, 23);

  // fewer draw calls: everything that stands still, merged by material; what moves or changes stays itself
  var moving = new Set([wheelG, plBall, rwG, bigCoin, duck, cat, dl, dr, doorway].concat(pitDice, neonL));
  if(HQV.hqMerge && HQV.hqMerge.mergeStatic){ try { HQV.hqMerge.mergeStatic(T, S, {keep: function(o){ return moving.has(o); }}); } catch(e){} }

  /* the people: dealers in waistcoats and bow ties, a cashier, a bartender, and a crowd at the machines and tables */
  function addOn(ch, uniform){
    // a white shirt front and a red bow tie riding the torso bone (in model space, as avatar3d's add-ons do)
    if(!uniform) return;
    var o = ch.o, torso = o.getObjectByName("torso"), head = o.getObjectByName("head"); if(!torso || !head) return;
    o.updateMatrixWorld(true);
    var hp = new T.Vector3(), inv = new T.Matrix4().copy(o.matrixWorld).invert(); head.getWorldPosition(hp); hp.applyMatrix4(inv);
    var bbox = new T.Box3(); o.traverse(function(n){ if(n.isMesh && /body/i.test(n.name)){ n.geometry.computeBoundingBox(); bbox.union(n.geometry.boundingBox); } });
    var front = isFinite(bbox.max.z) ? bbox.max.z : 0.12;
    var gp = new T.Group(); gp.applyMatrix4(new T.Matrix4().copy(torso.matrixWorld).invert().multiply(o.matrixWorld)); torso.add(gp);
    var shirt = new T.Mesh(new T.PlaneGeometry(0.1, 0.12), new T.MeshStandardMaterial({color: 0xffffff, roughness: 0.8})); shirt.position.set(0, hp.y - 0.17, front + 0.004); gp.add(shirt);
    var bow = new T.Group(); bow.position.set(0, hp.y - 0.13, front + 0.012); gp.add(bow);
    var red = new T.MeshStandardMaterial({color: 0xc1121f, roughness: 0.5});
    [-1, 1].forEach(function(sd){ var w2 = new T.Mesh(new T.ConeGeometry(0.03, 0.05, 4), red); w2.rotation.z = sd*PI/2; w2.position.x = sd*0.028; bow.add(w2); });
    bow.add(new T.Mesh(new T.SphereGeometry(0.014, 6, 4), red));
  }
  function person(x, z, yaw, opt){
    opt = opt || {};
    var done = function(ch){
      if(w.dead){ return; }
      ch.o.position.set(x, opt.y || 0, z); ch.o.rotation.y = yaw; S.add(ch.o);
      if(opt.ghost){ ch.o.traverse(function(n){ if(n.isMesh){ n.material = n.material.clone(); n.material.transparent = true; n.material.opacity = 0.35; n.material.color && n.material.color.multiply(new T.Color(0.7, 0.85, 1)); } }); ch.o.visible = false; }
      addOn(ch, opt.uniform);
      if(!opt.uniform) ch.o.traverse(function(n){ if(n.isMesh) n.castShadow = false; });   // the crowd casts none (a draw each, too small to see)
      c.anim(ch, opt.anim || "idle", 1);
      ch.mixer.timeScale = 0.8 + (Math.abs(x*7 + z*3) % 5)*0.06;
      chars.push(ch); if(opt.role) roles[opt.role] = ch; if(opt.ghost) ghost = ch;
    };
    var A3 = HQV.avatar3d;
    if(opt.spec && A3 && A3.valid && A3.valid(opt.spec)){
      A3.build(opt.spec).then(function(ch){ ch.base = 1.7/0.72; ch.o.scale.setScalar(ch.base); done(ch); }, function(){ c.character(opt.key || "dealer", done); });
    } else c.character(opt.key || ("patron:" + x + ":" + z), done);
  }
  var roles = {}, ghost = null;
  // dealers: a dark suit (avatar3d outfit 6), the base model by seat, a shirt front and bow tie added
  function dealer(base, x, z, yaw, role){ person(x, z, yaw, {spec: [base, 1 + (base*2) % 6, 1 + base % 8, 6, 0, 0, 0, 0, 0, 0], uniform: true, role: role}); }
  dealer(1, -13, 5.4, 0, "croupier");
  dealer(0, -2, 8.5, 0, "bj1");
  dealer(3, -2, -2.5, 0, "bj2");
  dealer(5, 8, 11.4, 0, "stick");
  dealer(2, -RX + 1.4, -9, PI/2, "cashier");
  dealer(4, 8, -RZ + 2.2, 0, "bartender");
  // the crowd: at the machines, round the tables, at the bar
  seats.forEach(function(s2, i){ if(s2.broken || s2.ghost || i % 3 === 1) return; person(s2.x, s2.z, s2.yaw, {anim: "sit", y: 0.2, key: "slot" + i}); });
  [[15, 13.3, PI], [18, 13.3, PI + 0.3], [-14.6, 9.4, PI], [-11.4, 9.4, PI], [-3.2, 12.2, PI], [-0.6, 12.4, PI], [-2.6, 1.3, PI], [6.6, 15.2, PI], [9.6, 15.1, PI], [10.6, 15, PI + 0.4], [19, -RZ + 7.6, PI], [22, -RZ + 10.2, PI]].forEach(function(p, i){ person(p[0], p[1], p[2], {key: "guest" + i}); });
  [4.7, 8.1].forEach(function(x, i){ person(x, -RZ + 5.3, PI, {anim: "sit", y: 0.25, key: "bar" + i}); });
  person(seats.filter(function(s2){ return s2.ghost; })[0].x, seats.filter(function(s2){ return s2.ghost; })[0].z, seats.filter(function(s2){ return s2.ghost; })[0].yaw, {anim: "sit", y: 0.2, key: "ghost", ghost: true});

  /* the prompt and the toast: what E does here, and what the room says back */
  var stage = c.el, prompt = null, toast = null, toastT = 0;
  function dom(){
    if(prompt || !stage || typeof document === "undefined") return;
    prompt = document.createElement("button"); prompt.type = "button"; prompt.className = "hqcasino-prompt"; prompt.hidden = true; stage.appendChild(prompt);
    // the prompt is a button too: a click (or a tap) does what E does
    prompt.addEventListener("click", function(){ var av = c.avatar(); if(av) w.use(av); });
    toast = document.createElement("div"); toast.className = "hqcasino-toast"; toast.hidden = true; toast.setAttribute("role", "status"); toast.setAttribute("aria-live", "polite"); stage.appendChild(toast);
  }
  function say(t){ dom(); if(!toast) return; toast.textContent = t; toast.hidden = false; toastT = 5.5; if(c.api && c.api.announce) c.api.announce(t); }
  var ui = null, eggN = {};
  function panel(){
    if(ui || !HQV.hqCasinoUi || !stage) return ui;
    ui = HQV.hqCasinoUi.mount(stage, {
      get: function(p){ return c.api && c.api.arenaGet ? Promise.resolve(c.api.arenaGet(p)) : fetch(p, {cache: "no-store"}).then(function(r){ if(!r.ok) throw new Error("HTTP " + r.status); return r.json(); }); },
      post: function(p, b){ return c.api && c.api.arenaPost ? Promise.resolve(c.api.arenaPost(p, b)) : Promise.reject(new Error("offline")); },
      calm: function(){ return !!(c.E && c.E.calm && c.E.calm()); },
      audio: function(){ return c.E && c.E.audioOut ? c.E.audioOut() : null; },
      announce: function(t){ if(c.api && c.api.announce) c.api.announce(t); },
      onResult: function(gm, j){ react(gm, j); },
      notify: function(t){ say("\u2694 " + t); },
      onClose: function(){ if(c.el && c.el.querySelector){ var cv = c.el.querySelector(".hq3d-canvas"); if(cv && cv.focus) cv.focus(); } }
    });
    return ui;
  }
  var stats = {plays: 0, losses: 0, streak: 0};
  // the floor reacts: the wheel spins, the Plinko ball drops, the dealer nods when you win
  var fx = {wheel: null, plinko: null, rocket: null, roulette: null, dice: null};
  function react(gm, j){
    var stake = (j.bet | 0) || ((j.hand && j.hand.bet) | 0), won = (j.payout | 0) > stake;
    stats.plays++; stats.streak = j.streak | 0;
    var now = clock;
    if(gm === "wheel" && j.result) fx.wheel = {t0: now - 5, to: -(j.result.segment + 0.5)/WSEG*TAU};
    if(gm === "plinko" && j.result) fx.plinko = {t0: now - 3.2, bin: j.result.bin};
    if(gm === "roulette") fx.roulette = {t0: now - 5};
    if(gm === "dice") fx.dice = {t0: now - 1.6};
    var who = gm === "roulette" ? roles.croupier : gm === "blackjack" ? roles.bj1 : gm === "dice" ? roles.stick : null;
    if(who && won){ c.anim(who, "emote-yes", 1); setTimeout(function(){ if(!w.dead) c.anim(who, "idle", 1); }, 1800); }
  }
  function nearSpot(p){
    var best = null, bd = 1e9;
    spots.forEach(function(s){ var d = Math.hypot(p.x - s.x, p.z - s.z); if(d < s.r && d < bd){ if(s.egg === "ghost" && !ghostOn()) return; bd = d; best = s; } });
    return best;
  }
  function ghostOn(){ var h = new Date().getHours(), m = new Date().getMinutes(); return h === 3 && m >= 33 && m < 45; }
  function egg(s){
    var n = eggN[s.egg] = (eggN[s.egg] | 0) + 1, L = EGG_LINES[s.egg] || [], snd = HQV.hqCasinoUi && HQV.hqCasinoUi.sound ? HQV.hqCasinoUi.sound(function(){ return c.E && c.E.audioOut ? c.E.audioOut() : null; }) : null;
    if(s.egg === "duck"){ if(snd) snd.quack(); duckHop = 0.6; say(L[(n - 1) % L.length]); return; }
    if(s.egg === "broken"){
      if(n % 7 === 0){ var me = ui && ui.me && ui.me(), r = me && me.tables && me.tables.rtp; say(r ? "The machine coughs up a fortune cookie: \"The house keeps " + Object.keys(r).map(function(k){ return k + " " + Math.round((100 - r[k])*10)/10 + "%"; }).join(", ") + ". Spend accordingly.\"" : "The machine coughs up a fortune cookie: \"The house always wins.\""); return; }
      say(L[(n - 1) % L.length]); return;
    }
    if(s.egg === "cat"){ say(stats.plays && !stats.streak ? EGG_LINES.catWin[0] : EGG_LINES.cat[(n - 1) % EGG_LINES.cat.length]); return; }
    if(s.egg === "asterisk"){ var m2 = ui && ui.me && ui.me(), rt2 = m2 && m2.tables && m2.tables.rtp;
      say("The plaque reads HONEST ODDS. " + (rt2 ? "Out of every 100 chips bet, on average you get back: " + Object.keys(rt2).map(function(k){ return k + " " + rt2[k]; }).join(", ") + ". The rest builds chandeliers." : "Every game here keeps a few percent. Play for fun, not for rent.")); return; }
    say(L[(n - 1) % L.length]);
  }
  // the cheat code: anywhere on the floor
  var KON = ["ArrowUp", "ArrowUp", "ArrowDown", "ArrowDown", "ArrowLeft", "ArrowRight", "ArrowLeft", "ArrowRight", "KeyB", "KeyA"], konI = 0, disco = 0;
  function onKey(e){
    if(!active() || (ui && ui.isOpen())) return;
    if(e.code === KON[konI]){ konI++; if(konI === KON.length){ konI = 0; disco = 20; say(EGG_LINES.konami[0]); chars.forEach(function(ch){ c.anim(ch, "emote-yes", 1); }); } }
    else konI = e.code === KON[0] ? 1 : 0;
  }
  if(typeof document !== "undefined") document.addEventListener("keydown", onKey, true);
  function active(){ return c.active ? c.active(w) : true; }

  /* what you cannot walk through */
  function blocked(x, z){
    if(x < -RX + 0.7 || x > RX - 0.6 || z < -RZ + 0.8 || z > RZ - 0.6) return true;
    for(var i = 0; i < solids.length; i++){ var s = solids[i]; if(x > s.x0 && x < s.x1 && z > s.z0 && z < s.z1) return true; }
    return false;
  }

  /* the attract screens, the Race Book's loop, the rocket cabinet */
  var ART = HQV.hqCasinoUi && HQV.hqCasinoUi.art, SY = ["cherry", "lemon", "bell", "bar", "star", "gem", "seven"];
  function drawAttract(t){
    attract.forEach(function(A, i){
      var g = A.g; g.fillStyle = "#120006"; g.fillRect(0, 0, 256, 192);
      g.strokeStyle = (Math.floor(t*3) + i) % 2 ? "#ffd54f" : "#ff3fb4"; g.lineWidth = 8; g.strokeRect(4, 4, 248, 184);
      for(var r = 0; r < 3; r++){ g.fillStyle = "#fff"; g.fillRect(16 + r*78, 36, 70, 100); if(ART){ var p = t*(3 + r + i) + r*2 + i, sy = SY[Math.floor(p) % 7]; g.save(); g.beginPath(); g.rect(16 + r*78, 36, 70, 100); g.clip(); ART.symbol(g, sy, 51 + r*78, 86 + (p % 1)*-100 + 100*0, 56); ART.symbol(g, SY[(Math.floor(p) + 1) % 7], 51 + r*78, 86 + (p % 1)*-100 + 100, 56); g.restore(); } }
      g.fillStyle = "#ffd54f"; g.font = "900 26px Impact, sans-serif"; g.textAlign = "center"; g.fillText(["PLAY ME", "LUCKY 7s", "JACKPOT"][i], 128, 172);
      A.t.needsUpdate = true;
    });
  }
  var raceSeed = 0;
  function drawRace(t){
    var g = raceTex.g, Wt = 1024, Ht = 384, lap = 14, u = (t % lap)/lap, n = Math.floor(t/lap);
    var gr = g.createLinearGradient(0, 0, 0, Ht); gr.addColorStop(0, "#5fb8ff"); gr.addColorStop(0.25, "#bfe6ff"); gr.addColorStop(0.27, "#3c8d2f"); gr.addColorStop(1, "#1f5a18"); g.fillStyle = gr; g.fillRect(0, 0, Wt, Ht);
    g.fillStyle = "#b5895a"; g.fillRect(0, 110, Wt, 240);
    var silks = ["#e63946", "#3a86ff", "#ffbe0b", "#2a9d8f", "#8338ec", "#fb5607"];
    for(var i = 0; i < 6; i++){
      var R = c.rng(n*13 + i), sp = 0.85 + R()*0.3, x = 40 + ((u*sp*1.15) % 1.2)*(Wt - 120), y = 140 + i*36;
      if(ART) ART.horse(g, x, y, 34, t*14 + i, silks[i]);
    }
    g.fillStyle = "rgba(0,0,0,.6)"; g.fillRect(0, 0, Wt, 56); g.fillStyle = "#fff"; g.font = "800 30px system-ui"; g.textAlign = "left"; g.fillText("RACE " + (n % 90 + 1) + "  ·  NULL POINTER · MERGE CONFLICT · HOT RELOAD · OFF BY ONE · TABS NOT SPACES · SEGFAULT SALLY", 20 - (t*80 % 1400), 38);
    raceTex.t.needsUpdate = true;
  }
  function drawRocketScreen(t){
    var g = rocketT.g; g.fillStyle = "#050816"; g.fillRect(0, 0, 256, 320);
    for(var s = 0; s < 30; s++){ g.fillStyle = "rgba(255,255,255,.7)"; g.fillRect((s*53) % 256, (s*71 + t*40) % 320, 2, 2); }
    var cyc = 6, u = (t % cyc)/cyc, m = Math.exp(u*2.2);
    g.strokeStyle = "#ff4d6d"; g.lineWidth = 4; g.beginPath(); for(var i = 0; i <= 30; i++){ var q = u*i/30; g.lineTo(20 + q*220, 290 - (Math.exp(q*2.2) - 1)/8*250); } g.stroke();
    g.font = "40px serif"; g.textAlign = "center"; g.fillText(u > 0.92 ? "💥" : "🚀", 20 + u*220, 290 - (m - 1)/8*250);
    g.fillStyle = "#fff"; g.font = "900 34px system-ui"; g.fillText(m.toFixed(2) + "x", 128, 50);
    rocketT.t.needsUpdate = true;
  }

  var clock = 0, acc = 0, duckHop = 0;
  w.floor = floor; w.hits = hits; w.doors = doors; w.span = 15; w.zoom = 1.0; w.camY = 1.6; w.follow = 0.6;
  w.bounds = [-RX, RX, -RZ, RZ];
  // in from the street 2.9 m past the way out's spot, so the doors arm on your first step and walking back takes you out
  w.spawn = {x: -RX + 4.5, z: 12, yaw: PI/2};
  w.spawnFrom = {city: {x: -RX + 4.5, z: 12, yaw: PI/2}};
  w.blocked = blocked;
  w.menuOpen = function(){ return !!(ui && ui.isOpen()); };
  w.use = function(p){
    var s = nearSpot(p); if(!s) return false;
    if(s.egg){ egg(s); return true; }
    var u = panel(); if(u) u.open(s.game); else say("The tables aren't open on this page.");
    return true;
  };
  w.setTime = function(night){
    S.background = new T.Color(night ? 0x05030a : 0x140a10);
    hemi.intensity = night ? 1.4 : 1.7; sun.intensity = night ? 0.4 : 0.9;
    street.material.map = c.sky(!night); street.material.needsUpdate = true;
  };
  w.onEnter = function(){ dom(); panel(); say("Welcome to " + NAME + ". Chips at the cage on your left; walk up to any game and press E."); };
  w.onLeave = function(){ if(ui) ui.close(); if(prompt) prompt.hidden = true; if(toast) toast.hidden = true; };
  w.update = function(t, dt, k){
    clock = t; dt = dt || 0;
    chars.forEach(function(ch){ ch.mixer.update(dt*(k || 1)); });
    if(ghost) ghost.o.visible = ghostOn();
    acc += dt; if(acc > 0.1){ acc = 0; drawAttract(t*k); drawRace(t); drawRocketScreen(t*k); }
    // the wheel: idle drift, or the spin you just paid for
    if(fx.wheel){ var u = Math.min(1, (t - fx.wheel.t0)/5); wheel.rotation.z = fx.wheel.to + (1 - Math.pow(1 - u, 3) - 1)*TAU*6; if(u >= 1) fx.wheel = null; }
    else wheel.rotation.z += dt*0.12*k;
    wbulbs.children.forEach(function(b, i){ b.material.color.setHex((i + Math.floor(t*6*k)) % 2 ? 0xfff59d : 0xff6b6b); });
    // Plinko's ball: down the board, to your bin
    var fp = fx.plinko; if(fp){ var v = Math.min(1, (t - fp.t0)/3.2); plBall.position.set(((fp.bin - 6)*0.42)*v + Math.sin(v*40)*0.12*(1 - v), 8 - v*5.9, 0.3); if(v >= 1) fx.plinko = null; }
    else { var q = (t*0.25) % 1; plBall.position.set(Math.sin(t*3)*0.4*q, 8 - q*5.9, 0.3); }
    rWheel.rotation.z += dt*(fx.roulette ? 3 : 0.4)*k; var rb = t*(fx.roulette ? -5 : 0.4); rBall.position.set(Math.cos(rb)*0.7, 0.06, Math.sin(rb)*0.7); if(fx.roulette && t - fx.roulette.t0 > 5) fx.roulette = null;
    pitDice.forEach(function(d, i){ if(fx.dice){ d.rotation.set(t*9 + i, t*7, t*5); d.position.y = 1.1 + Math.abs(Math.sin(t*12 + i))*0.3; } else d.position.y = 1.1; }); if(fx.dice && t - fx.dice.t0 > 1.6) fx.dice = null;
    bigCoin.rotation.z = t*1.2*k; bigCoin.position.y = 2.6 + Math.sin(t*1.5)*0.12*k;
    duckHop = Math.max(0, duckHop - dt); duck.position.y = 1.25 + Math.abs(Math.sin(duckHop*16))*0.15*(duckHop > 0 ? 1 : 0); duck.rotation.y = Math.sin(t*0.6)*0.4;
    tail.rotation.x = Math.sin(t*1.3)*0.3*k;
    // disco: the room's lights cycle (gently in Calm), the neon flashes
    if(disco > 0){ disco -= dt; var hc = new T.Color(); timeLights.forEach(function(l, i){ hc.setHSL(((t*0.5*k + i*0.17) % 1 + 1) % 1, 0.9, 0.6); l.color.copy(hc); }); neonL.forEach(function(n){ n.material.color.setHSL((t*0.8*k) % 1, 1, 0.55); }); if(disco <= 0) timeLights.forEach(function(l){ l.color.setHex(l.userData.col); }); }
    // the prompt for what is near
    dom(); var av = c.avatar(); if(prompt && av){ var s = ui && ui.isOpen() ? null : nearSpot(av); prompt.hidden = !s; if(s && prompt.textContent !== "E  " + s.label) prompt.textContent = "E  " + s.label; }
    if(toast && toastT > 0){ toastT -= dt; if(toastT <= 0) toast.hidden = true; }
    if(ui && ui.idle && active()) ui.idle();
    // the doors slide when you come near them
    var dOpen = av && Math.abs(av.x + RX) < 4 && Math.abs(av.z - 12) < 3 ? 1 : 0, o = (dl.userData.o || 0) + (dOpen - (dl.userData.o || 0))*Math.min(1, dt*4); dl.userData.o = o;
    dl.position.z = 11 - o*1.8; dr.position.z = 13 + o*1.8;
  };
  w.destroy = function(){ w.dead = true; if(typeof document !== "undefined") document.removeEventListener("keydown", onKey, true); if(ui) ui.destroy(); [prompt, toast].forEach(function(n){ if(n && n.parentNode) n.parentNode.removeChild(n); }); };
  drawAttract(0); drawRace(0); drawRocketScreen(0);
  return w;
};

HQV.hqCasino = {place: place, pick: pick, build: build, SITE_ID: SITE_ID, MIN_TIER: MIN_TIER, NAME: NAME, SPOTS: SPOTS, EGGS: EGGS, EGG_LINES: EGG_LINES, RX: RX, RZ: RZ};
})();
