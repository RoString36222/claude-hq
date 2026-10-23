/* Claude HQ 2.0: the Base, your HQ from outside.
 *
 * A campus that grows with your HQ level: the tower gains floors, and wings, a
 * fountain, streak banners, a helipad, a sky terrace, skybridges, a kart track, an
 * observatory dome, a crew billboard, a hall-of-fame statue and an Arena annex unlock
 * as you level. Lit windows follow how many sessions are live. Cars circle the ring
 * road, people stroll the plaza, day and night follow your clock. Walk to the front
 * door to go into the Lobby.
 *
 * A floor of the 3D HQ: registered as HQV.hqWorlds.base and built by games/hq3d.js
 * with its ctx helpers. The building's paint and sign come from ctx.look() (HQ
 * customisation); the level from ctx.level() (the season level the page shows).
 */
(function(){
"use strict";
var HQV = window.HQV = window.HQV || {};
HQV.hqWorlds = HQV.hqWorlds || {};

var UNLOCKS = [[1, "Main tower and lobby"], [5, "Plaza fountain"], [10, "West wing"], [15, "Streak banners"], [20, "Helipad and helicopter"],
  [25, "Sky terrace garden"], [30, "East wing and skybridges"], [35, "Kart track"], [40, "Observatory dome"], [45, "Crew billboard"],
  [50, "Hall of fame statue"], [55, "Arena annex"]];
HQV.hqUnlocks = UNLOCKS;

/* ---------- the building ----------
 * The HQ revamp: the tower, its entrance, wings, roof (always a helipad), crown and decor are games/hqtower.js
 * (HQV.hqTower.make), styled by HQ Studio (look.style, games/hqstyle.js): shared by your Base and every lot in
 * Arena City (games/hqcity.js, games/hqcity3d.js), so an HQ looks the same wherever you see it. opts: level(),
 * look(), live() (crew at work, for the billboard), campus (the plaza extras only the Base has room for:
 * fountain, statue, kart track, Arena annex), door (where the front door goes), doorFront() (its point, in the
 * world), prestige() and grand (0..1: how much bigger than the old tower its lot lets it be; the Base: 1).
 * It fills its own hits/doors; animate() and applyTime() keep it alive. */
function makeBuilding(c, opts){ return HQV.hqTower.make(c, opts); }
HQV.hqBuilding = makeBuilding;

/* ---------- the view buildings: every tab of HQ has a building of its own ----------
 * They stand in Arena City (games/hqcity.js) and round your Base; walk in through the door
 * to open that tab. The list is fixed (not whichever tabs this page shows) so the city's grid
 * comes out the same for everyone on the street. Labels follow the page (api.viewTitle), so
 * a pack that renames a tab renames its building too. */
var VIEWS = [
  {view: "live", label: "Live", icon: "📡", col: 0x5fd3e6, h: 11},
  {view: "analytics", label: "Analytics", icon: "📊", col: 0x5fd3e6, h: 9},
  {view: "pokedex", label: "Pokédex", icon: "📖", col: 0x9b8cf0, h: 8},
  {view: "gym", label: "Gym", icon: "🥊", col: 0xff6b5b, h: 7},
  {view: "quests", label: "Quests", icon: "🎯", col: 0xffb347, h: 8},
  {view: "village", label: "Village", icon: "🏰", col: 0x6fd38a, h: 7},
  {view: "arena", label: "Arena", icon: "🏆", col: 0x5fd3e6, h: 12},
  {view: "store", label: "Store", icon: "🛒", col: 0x6fd38a, h: 6},
  {view: "cali", label: "Cali Tuesdays", icon: "🌮", col: 0xffb347, h: 6},
  {view: "valley", label: "Valley", icon: "✨", col: 0x6fd38a, h: 7},
  {view: "music", label: "Music", icon: "🎵", col: 0x9b8cf0, h: 8},
  {view: "workshop", label: "Workshop", icon: "🛠", col: 0xffb347, h: 7},
  {view: "compete", label: "Compete", icon: "🥇", col: 0xff6b5b, h: 10}
];
HQV.hqViews = VIEWS;
var VB_W = 9, VB_D = 7;     // a view building's footprint (m); its front (and door) faces +z

// One view building. opts.doorFront(): its door's point in the world (where you walk to go in).
function makeViewBuilding(c, v, opts){
  var THREE = c.THREE, mat = c.mat, emis = c.emis, box = c.box;
  var api = c.api || {}, t = (api.viewTitle && api.viewTitle(v.view)) || [], title = t[0] || v.label;
  var hex = "#" + v.col.toString(16).padStart(6, "0"), h = v.h, hits = [], doors = [];
  var g = new THREE.Group();
  box(VB_W + 1, 0.3, VB_D + 1, mat(0x3b4c5c, {roughness: 0.9}), 0, 0.15, 0, g);
  var body = box(VB_W, h, VB_D, mat(0x22313f, {roughness: 0.6, metalness: 0.2}), 0, 0.3 + h/2, 0, g);
  // lit bands round the walls, and a cap in the building's colour
  var bandM = emis(0x0d1a24, v.col, 1.2), capM = emis(0x16222e, v.col, 0.6), bands = [];
  for(var y = 2.6; y < h - 0.6; y += 2.2) bands.push(box(VB_W + 0.06, 0.18, VB_D + 0.06, bandM, 0, 0.3 + y, 0, g, true));
  box(VB_W + 0.4, 0.4, VB_D + 0.4, capM, 0, 0.5 + h, 0, g);
  // the sign over the door: the tab's name
  var st = c.canvasTex(512, 96, function(gx){ gx.fillStyle = "#0b1622"; gx.fillRect(0, 0, 512, 96); gx.fillStyle = hex; gx.font = "700 54px system-ui, sans-serif";
    gx.textAlign = "center"; gx.textBaseline = "middle"; gx.fillText(c.short(title.toUpperCase(), 16), 256, 50); });
  var sign = new THREE.Mesh(new THREE.PlaneGeometry(7, 1.3), new THREE.MeshBasicMaterial({map: st.t, toneMapped: false}));
  sign.position.set(0, 4.4, VB_D/2 + 0.05); g.add(sign);
  // the door: glass panels with a lit frame, and a mat in front
  var doorM = emis(0x0b1622, v.col, 0.45);
  var dl = box(1.15, 3, 0.12, doorM, -0.6, 1.8, VB_D/2 + 0.08, g), dr = box(1.15, 3, 0.12, doorM, 0.6, 1.8, VB_D/2 + 0.08, g);
  box(2.7, 0.12, 0.16, emis(0x0d1a24, v.col, 2), 0, 3.36, VB_D/2 + 0.1, g, true);
  box(2.6, 0.02, 1.4, emis(0x0d1a24, v.col, 0.5), 0, 0.31, VB_D/2 + 0.9, g, true);
  var icon = c.glyph(v.icon, hex); icon.scale.set(2.4, 2.4, 1); icon.position.set(0, h + 2.4, 0); g.add(icon);
  var lb = c.label(title, hex, 0.9); lb.position.set(0, h + 4.4, 0); g.add(lb);
  var door = {view: v.view, label: title, tip: title + (t[1] ? ": " + t[1] : ": go in"),
              front: opts.doorFront ? opts.doorFront() : new THREE.Vector3(0, 0, VB_D/2 + 1.2)};
  [body, sign, dl, dr].forEach(function(o){ o.userData.door = door; hits.push(o); }); doors.push(door);
  var night = true, ph = c.hashStr(v.view) % 7;
  return {g: g, hits: hits, doors: doors, view: v.view, top: function(){ return h + 0.7; },
    blockedLocal: function(x, z){ return Math.abs(x) < VB_W/2 + 0.3 && Math.abs(z) < VB_D/2 + 0.3; },
    setNight: function(n){ night = n; bandM.emissiveIntensity = n ? 1.2 : 0.35; capM.emissiveIntensity = n ? 0.6 : 0.15; doorM.emissiveIntensity = n ? 0.45 : 0.2; },
    animate: function(tt, dt, k){ icon.position.y = h + 2.4 + Math.sin(tt*1.4 + ph)*0.25*k; }};
}
HQV.hqViewBuilding = makeViewBuilding;

// A building between you and the camera fades, so you are never lost behind a tower (Arena City
// and the view buildings round your Base). items: [{x, z, H (its height), side (half its width;
// default a campus), fade: {g, on}}].
function fade(L, on){
  if(L.fade.on === on) return; L.fade.on = on;
  L.fade.g.traverse(function(o){ if(!o.isMesh) return; (Array.isArray(o.material) ? o.material : [o.material]).forEach(function(m){
    if(m.userData.op == null){ m.userData.op = m.opacity; m.userData.tr = m.transparent; }
    m.transparent = on || m.userData.tr; m.opacity = on ? 0.16 : m.userData.op; m.depthWrite = !on; m.needsUpdate = true; }); o.castShadow = !on; });
}
function cutaway(c, items){
  var me = c.avatar(), v = c.view && c.view(); if(!me || !v) return;
  var ux = Math.sin(v.yaw), uz = Math.cos(v.yaw), tp = Math.max(0.2, Math.tan(v.pitch));
  items.forEach(function(L){
    if(!L.fade) return;
    var vx = L.x - me.x, vz = L.z - me.z, along = vx*ux + vz*uz, side = Math.abs(vx*uz - vz*ux);
    fade(L, along > 2 && side < (L.side || 14) && along < L.H/tp + 8);
  });
}
HQV.hqCutaway = cutaway;

// Where the view buildings stand round your Base: a ring outside the ring road, facing the middle,
// clear of the parking lot (east), the kart track (west), the Arena annex (north) and the front
// path (south). Pure, so it is easy to test: [{v, a, x, z, rot}].
var BASE_RING = 37.5, PI_ = Math.PI;
function baseViewRing(){
  var free = [], step = PI_/22;
  function clear(a){
    var d = function(b){ return Math.abs(((a - b) % (2*PI_) + 3*PI_) % (2*PI_) - PI_); };   // angle between a and b
    return d(0) > 0.34 && d(PI_) > 0.38 && d(-PI_/2) > 0.42 && d(PI_/2) > 0.2;
  }
  for(var i = 0; i < 44; i++){ var a = i*step + step/2; if(clear(a)) free.push(a); }
  // spread the buildings evenly over the free angles
  return VIEWS.map(function(v, n){
    var a = free[Math.floor(n*free.length/VIEWS.length)], dx = -Math.cos(a), dz = -Math.sin(a);
    return {v: v, a: a, x: Math.cos(a)*BASE_RING, z: Math.sin(a)*BASE_RING, rot: Math.atan2(dx, dz), dx: dx, dz: dz};
  });
}
HQV.hqBaseViewRing = baseViewRing;

HQV.hqWorlds.base = function(c, w){
  var THREE = c.THREE, PI = c.PI, S = w.scene, COL = c.COL, HEX = c.HEX;
  var mat = c.mat, emis = c.emis, box = c.box, cyl = c.cyl, sph = c.sph;

  // light + sky
  var hemi = new THREE.HemisphereLight(0xbcd7ff, 0x223322, 2.2); S.add(hemi);
  var sun = new THREE.DirectionalLight(0xffffff, 2.2); sun.position.set(34, 60, 26); sun.castShadow = true;
  sun.shadow.mapSize.set(2048, 2048); var sc = sun.shadow.camera; sc.left = -45; sc.right = 45; sc.top = 45; sc.bottom = -45; sc.far = 160;
  S.add(sun); S.add(sun.target);
  var skyBg = {
    night: c.canvasTex(512, 512, function(g){ var gr = g.createLinearGradient(0, 0, 0, 512); gr.addColorStop(0, "#040a12"); gr.addColorStop(0.6, "#0b1826"); gr.addColorStop(1, "#16304a"); g.fillStyle = gr; g.fillRect(0, 0, 512, 512); var R = c.rng(8); for(var i = 0; i < 220; i++){ g.fillStyle = "rgba(255,255,255," + (0.25 + R()*0.7) + ")"; var s = R() < 0.1 ? 2 : 1; g.fillRect(R()*512, R()*330, s, s); } g.fillStyle = "rgba(255,244,214,.95)"; g.beginPath(); g.arc(410, 90, 20, 0, 7); g.fill(); }).t,
    day: c.canvasTex(512, 512, function(g){ var gr = g.createLinearGradient(0, 0, 0, 512); gr.addColorStop(0, "#5ea6dc"); gr.addColorStop(1, "#cfe8f7"); g.fillStyle = gr; g.fillRect(0, 0, 512, 512); }).t
  };

  // ground: grass, the ring road, plaza paving, paths and a parking lot (one texture)
  function W2C(x, z, u){ return [(x + 50)*u, (z + 50)*u]; }
  var gt = c.canvasTex(2048, 2048, function(g, wd){
    var u = wd/100, R = c.rng(41), m = wd/2, p;
    g.fillStyle = "#1f3d2c"; g.fillRect(0, 0, wd, wd);
    for(var i = 0; i < 14000; i++){ g.fillStyle = R() < 0.5 ? "rgba(46,92,58,.45)" : "rgba(22,48,33,.5)"; g.fillRect(R()*wd, R()*wd, 3 + R()*7, 3 + R()*7); }
    g.fillStyle = "#3b4c5c"; p = W2C(-1.8, 15, u); g.fillRect(p[0], p[1], 3.6*u, 36*u);
    g.fillStyle = "#2a2f36"; p = W2C(20, -1.6, u); g.fillRect(p[0], p[1], 6*u, 3.2*u); p = W2C(25, -8, u); g.fillRect(p[0], p[1], 11*u, 16*u);
    g.strokeStyle = "rgba(233,239,243,.75)"; g.lineWidth = 0.12*u;
    for(var s = 0; s < 6; s++){ var q = W2C(25.5 + s*1.8, -7.5, u); g.beginPath(); g.moveTo(q[0], q[1]); g.lineTo(q[0], q[1] + 4.5*u); g.stroke(); q = W2C(25.5 + s*1.8, 3, u); g.beginPath(); g.moveTo(q[0], q[1]); g.lineTo(q[0], q[1] + 4.5*u); g.stroke(); }
    g.lineWidth = 4*u; g.strokeStyle = "#2a2f36"; g.beginPath(); g.arc(m, m, 19*u, 0, 7); g.stroke();
    g.lineWidth = 0.22*u; g.strokeStyle = "#8e9aa6"; [16.9, 21.1].forEach(function(r){ g.beginPath(); g.arc(m, m, r*u, 0, 7); g.stroke(); });
    g.setLineDash([1.4*u, 1.2*u]); g.lineWidth = 0.14*u; g.strokeStyle = "rgba(255,200,110,.8)"; g.beginPath(); g.arc(m, m, 19*u, 0, 7); g.stroke(); g.setLineDash([]);
    g.fillStyle = "rgba(233,239,243,.8)"; for(var z = 0; z < 6; z++){ p = W2C(-1.6 + z*0.6, 17, u); g.fillRect(p[0], p[1], 0.35*u, 4*u); }
    g.fillStyle = "#3b4c5c"; g.beginPath(); g.arc(m, m, 15.6*u, 0, 7); g.fill();
    g.strokeStyle = "rgba(255,255,255,.07)"; g.lineWidth = 0.08*u;
    for(var r = 2; r < 15.6; r += 1.3){ g.beginPath(); g.arc(m, m, r*u, 0, 7); g.stroke(); }
    for(var a = 0; a < 48; a++){ var an = a/48*PI*2; g.beginPath(); g.moveTo(m + Math.cos(an)*2*u, m + Math.sin(an)*2*u); g.lineTo(m + Math.cos(an)*15.6*u, m + Math.sin(an)*15.6*u); g.stroke(); }
    g.strokeStyle = "rgba(255,179,71,.55)"; g.lineWidth = 0.18*u; g.beginPath(); g.arc(m, m, 15.4*u, 0, 7); g.stroke();
  });
  var ground = new THREE.Mesh(new THREE.CircleGeometry(50, 96), new THREE.MeshStandardMaterial({map: gt.t, roughness: 0.95}));
  ground.rotation.x = -PI/2; ground.receiveShadow = true; S.add(ground);

  var ring = baseViewRing();
  // trees, bushes, benches, street lamps
  var tr = c.rng(57);
  for(var t = 0; t < 90; t++){
    var a2 = tr()*PI*2, r2 = 23 + tr()*24, tx = Math.cos(a2)*r2, tz = Math.sin(a2)*r2;
    if((tx > 22 && Math.abs(tz) < 10) || (tx < -21 && Math.abs(tz) < 13) || (tz < -22 && Math.abs(tx) < 13) || (Math.abs(tx) < 3.5 && tz > 15)) continue;
    if(ring.some(function(r){ return Math.hypot(tx - r.x, tz - r.z) < 7.5; })) continue;   // the view buildings
    var tg = new THREE.Group(); tg.position.set(tx, 0, tz); tg.scale.setScalar(0.8 + tr()*0.6); S.add(tg);
    cyl(0.2, 0.28, 1.2, mat(0x5a3d2a), 0, 0.6, 0, tg, 8);
    if(tr() < 0.55){ for(var cn = 0; cn < 3; cn++){ c.add(new THREE.Mesh(new THREE.ConeGeometry(1.3 - cn*0.3, 1.6, 8), mat([0x2f6b45, 0x2a5f3d, 0x357a4f][cn])), 0, 1.6 + cn*0.9, 0, tg); } }
    else { [[0, 2.1, 0, 1.2], [0.6, 2.6, 0.2, 0.8], [-0.5, 2.5, -0.3, 0.85]].forEach(function(b){ sph(b[3], mat([0x3c8a4f, 0x4a9a58, 0x2f7a45][Math.floor(tr()*3)], {roughness: 0.9}), b[0], b[1], b[2], tg); }); }
  }
  for(var bu = 0; bu < 30; bu++){ var ba = bu/30*PI*2 + 0.05, bx = Math.cos(ba)*16.2, bz = Math.sin(ba)*16.2; if(Math.abs(bx) < 2.4 && bz > 0) continue; sph(0.55, mat(0x2f7a45, {roughness: 0.9}), bx, 0.35, bz).scale.y = 0.7; }
  for(var bn = 0; bn < 8; bn++){ var bna = bn/8*PI*2 + PI/8, bg = new THREE.Group(); bg.position.set(Math.cos(bna)*14.4, 0, Math.sin(bna)*14.4); bg.rotation.y = -bna + PI/2; S.add(bg); box(1.6, 0.1, 0.5, mat(0x8a5a35), 0, 0.45, 0, bg); box(1.6, 0.45, 0.08, mat(0x8a5a35), 0, 0.75, -0.22, bg); }
  var lampGlows = [];
  function streetLamp(x, z){ cyl(0.07, 0.1, 3.4, mat(0x2b3a48, {metalness: 0.6}), x, 1.7, z, null, 8); var bulb = sph(0.16, emis(0xfff1d6, 0xffd9a0, 2), x, 3.3, z); var gl = c.glow(0xffd9a0, 2.2, 0.8); gl.position.set(x, 3.25, z); S.add(gl); lampGlows.push(gl); }
  for(var lp = 0; lp < 14; lp++){ var la = lp/14*PI*2 + 0.22; streetLamp(Math.cos(la)*15.9, Math.sin(la)*15.9); }
  for(var lr = 0; lr < 16; lr++){ var lra = lr/16*PI*2 + 0.1; streetLamp(Math.cos(lra)*21.9, Math.sin(lra)*21.9); }

  // cars on the ring road, parked cars, chargers
  function car(col){
    var g = new THREE.Group(), body = mat(col, {metalness: 0.6, roughness: 0.3});
    box(1.9, 0.45, 0.95, body, 0, 0.42, 0, g); box(1.0, 0.42, 0.85, mat(0x0b1622, {metalness: 0.6, roughness: 0.15}), -0.1, 0.82, 0, g);
    [[0.6, 0.45], [-0.6, 0.45], [0.6, -0.45], [-0.6, -0.45]].forEach(function(wl){ cyl(0.2, 0.2, 0.14, mat(0x111111), wl[0], 0.2, wl[1], g, 10).rotation.x = PI/2; });
    var lights = [];
    [-0.3, 0.3].forEach(function(z){ var h = c.glow(0xfff1d6, 0.7, 0.9); h.position.set(0.98, 0.45, z); g.add(h); lights.push(h); var tl = c.glow(0xff4040, 0.45, 0.9); tl.position.set(-0.98, 0.45, z); g.add(tl); lights.push(tl); });
    return {g: g, lights: lights};
  }
  var cars = [];
  [[0xd14a5c, 18, 0.0, 0.22], [0x4a7bd1, 18, 2.4, 0.22], [0xe0e4e8, 20, 1.1, -0.18], [0xffb347, 20, 4.0, -0.18], [0x3fa66a, 18, 4.6, 0.22]].forEach(function(cd){ var k = car(cd[0]); S.add(k.g); cars.push({c: k, r: cd[1], a: cd[2], v: cd[3]}); });
  [[27, -5.3, 0x8a4ad1], [28.8, -5.3, 0xe0e4e8], [32.4, -5.3, 0x2aa7a1], [27, 5.3, 0xd14a5c], [30.6, 5.3, 0x4a7bd1], [34.2, 5.3, 0xc9a14a]].forEach(function(pc){ var k = car(pc[2]); k.g.position.set(pc[0], 0, pc[1]); k.g.rotation.y = PI/2; S.add(k.g); k.lights.forEach(function(l){ l.visible = false; }); });

  // people strolling round the plaza (the Kenney characters the HQ uses)
  var strollers = [];
  for(var sw = 0; sw < 5; sw++){
    (function(n){
      var holder = new THREE.Group(); S.add(holder);
      var st = {g: holder, ch: null, ph: n*1.25, dir: n % 2 ? 1 : -1, rx: 9 + (n % 3), rz: 3.2 + (n % 2)*0.8};
      c.character("stroller:" + n, function(ch){ st.ch = ch; holder.add(ch.o); c.anim(ch, "walk"); });
      strollers.push(st);
    })(sw);
  }
  var clouds = new THREE.Group(); S.add(clouds);
  for(var cl = 0; cl < 6; cl++){ var cg = new THREE.Group(); cg.position.set(-40 + cl*16, 34 + (cl % 3)*4, -20 + (cl % 2)*30); clouds.add(cg); [[0, 0, 0, 2.6], [2.4, -0.4, 0.4, 2], [-2.3, -0.5, -0.2, 1.9], [1, 0.9, -0.5, 1.7]].forEach(function(b){ sph(b[3], mat(0xffffff, {roughness: 1}), b[0], b[1], b[2], cg).castShadow = false; }); }

  var Bld = makeBuilding(c, {level: function(){ return c.level(); }, look: function(){ return c.look(); }, campus: true,
    prestige: function(){ return (c.api && typeof c.api.prestige === "function") ? (c.api.prestige() | 0) : 0; },
    live: function(){ return (c.sessions() || []).filter(function(s){ return c.crewState(s) !== "stale"; }).length; }});
  S.add(Bld.g);
  // a building for every tab, round the outside of the ring road
  var views = ring.map(function(r){
    var V = makeViewBuilding(c, r.v, {doorFront: function(){ return new THREE.Vector3(r.x + r.dx*(VB_D/2 + 1.2), 0, r.z + r.dz*(VB_D/2 + 1.2)); }});
    V.g.position.set(r.x, 0, r.z); V.g.rotation.y = r.rot; S.add(V.g);
    V.at = r; V.x = r.x; V.z = r.z; V.H = V.top() + 2; V.side = 7; V.fade = {g: V.g, on: false}; return V;
  });
  var night = true;
  function applyTime(){
    Bld.setNight(night);
    views.forEach(function(V){ V.setNight(night); });
    lampGlows.forEach(function(g){ g.material.opacity = night ? 0.85 : 0.08; });
    cars.forEach(function(k){ k.c.lights.forEach(function(l){ l.material.opacity = night ? 0.95 : 0.25; }); });
    clouds.visible = !night;
  }

  // what you cannot walk through
  function blocked(x, z){
    if(Math.hypot(x, z) > 46 || Bld.blockedLocal(x, z)) return true;
    return views.some(function(V){ var r = V.at, rx = x - r.x, rz = z - r.z, c0 = Math.cos(-r.rot), s0 = Math.sin(-r.rot);
      return V.blockedLocal(rx*c0 + rz*s0, -rx*s0 + rz*c0); });          // into the building's own frame
  }

  applyTime();
  var acc = 0, fadeAcc = 0;
  // Bld rebuilds its own hits/doors on a level change, so these are read fresh each time
  Object.defineProperty(w, "hits", {get: function(){ return views.reduce(function(a, V){ return a.concat(V.hits); }, Bld.hits.slice()); }, configurable: true});
  Object.defineProperty(w, "doors", {get: function(){ return views.reduce(function(a, V){ return a.concat(V.doors); }, Bld.doors.slice()); }, configurable: true});
  w.floor = ground; w.span = 17; w.zoom = 0.85; w.camY = 2.5; w.follow = 1; w.camPitch = 0.5;
  w.bounds = [-46, 46, -46, 46];
  w.spawn = {x: 3, z: 14, yaw: PI};
  w.spawnFrom = {lobby: {x: 0, z: 7.4, yaw: 0}};
  w.blocked = blocked;
  w.setTime = function(n){ night = n; S.background = n ? skyBg.night : skyBg.day; S.fog = new THREE.Fog(n ? 0x0f1f30 : 0xb8dcf2, 70, 160);
    hemi.intensity = n ? 1.3 : 2.4; sun.intensity = n ? 0.7 : 2.4; sun.color.set(n ? 0xa9b8ff : 0xfff2dc); applyTime(); };
  w.onData = function(list){ Bld.setLive((list || []).filter(function(s){ return c.crewState(s) !== "stale"; }).length); };
  w.onLook = function(){ Bld.build(); };
  w.update = function(t, dt, k){
    acc += dt;
    if(acc > 2){ acc = 0; if(Bld.stale()) Bld.build(); }
    Bld.animate(t, dt, k);
    views.forEach(function(V){ V.animate(t, dt, k); });
    fadeAcc += dt; if(fadeAcc > 0.15){ fadeAcc = 0; cutaway(c, views); }
    cars.forEach(function(k2){ k2.a += k2.v*dt*k; var x = Math.cos(k2.a)*k2.r, z = Math.sin(k2.a)*k2.r, dx = -Math.sin(k2.a)*k2.v, dz = Math.cos(k2.a)*k2.v; k2.c.g.position.set(x, 0, z); k2.c.g.rotation.y = Math.atan2(-dz, dx); });
    strollers.forEach(function(s){ var a = t*0.12*s.dir*k + s.ph, x = Math.cos(a)*s.rx, z = 9.6 + Math.sin(a)*s.rz; s.g.position.set(x, 0, z);
      var dx = -Math.sin(a)*s.rx*s.dir, dz = Math.cos(a)*s.rz*s.dir; s.g.rotation.y = Math.atan2(dx, dz); if(s.ch) s.ch.mixer.update(dt*k); });
    clouds.position.x = ((t*0.6*k) % 40) - 20;
  };
  return w;
};
})();
