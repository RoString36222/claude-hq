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

HQV.hqWorlds.base = function(c, w){
  var THREE = c.THREE, PI = c.PI, S = w.scene, COL = c.COL, HEX = c.HEX;
  var mat = c.mat, emis = c.emis, box = c.box, cyl = c.cyl, sph = c.sph;
  var hits = [], doors = [];

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

  // trees, bushes, benches, street lamps
  var tr = c.rng(57);
  for(var t = 0; t < 90; t++){
    var a2 = tr()*PI*2, r2 = 23 + tr()*24, tx = Math.cos(a2)*r2, tz = Math.sin(a2)*r2;
    if((tx > 22 && Math.abs(tz) < 10) || (tx < -21 && Math.abs(tz) < 13) || (tz < -22 && Math.abs(tx) < 13) || (Math.abs(tx) < 3.5 && tz > 15)) continue;
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

  /* ---------- the building, rebuilt when your level or look changes ---------- */
  var baseG = new THREE.Group(); S.add(baseG);
  var dyn = null, built = {level: null, look: ""}, litShare = 0.5, night = true;
  function paintWin(e, wn){
    e.fillStyle = "#000"; e.fillRect(wn.x, wn.y, wn.w, wn.h);
    if(!wn.lit) return;
    e.fillStyle = wn.col; e.fillRect(wn.x, wn.y, wn.w, wn.h);
    e.fillStyle = "rgba(0,0,0,.55)"; e.fillRect(wn.x + 2, wn.y + wn.h - 7, wn.w - 4, 3);
    if(wn.who){ var px = wn.x + wn.who; e.beginPath(); e.arc(px + 3, wn.y + wn.h - 15, 3, 0, 7); e.fill(); e.fillRect(px, wn.y + wn.h - 12, 6, 6); }
    e.fillStyle = "rgba(0,0,0,.6)"; e.fillRect(wn.x + wn.w/2 - 1, wn.y, 2, wn.h);
  }
  function facade(cols, floors, seed, paint){
    var cw = 40, fh = 48, Wd = cols*cw, H = floors*fh, R = c.rng(seed);
    var map = c.canvasTex(Wd, H), emi = c.canvasTex(Wd, H), g = map.g, wins = [];
    g.fillStyle = paint; g.fillRect(0, 0, Wd, H);
    for(var f = 0; f < floors; f++){
      var y0 = f*fh; g.fillStyle = "rgba(255,255,255,.12)"; g.fillRect(0, y0, Wd, 9);
      for(var k = 0; k < cols; k++){
        var x = k*cw + 5, y = y0 + 13, ww = cw - 10, hh = fh - 18;
        var gr = g.createLinearGradient(x, y, x + ww, y + hh); gr.addColorStop(0, "#24486a"); gr.addColorStop(1, "#0e1c2a"); g.fillStyle = gr; g.fillRect(x, y, ww, hh);
        g.fillStyle = "rgba(255,255,255,.09)"; g.fillRect(x, y, ww*0.35, hh);
        var wn = {x: x, y: y, w: ww, h: hh, col: R() < 0.82 ? "#ffcf7a" : "#9fe3f0", r: R(), who: R() < 0.5 ? 4 + R()*(ww - 12) : 0};
        wn.lit = wn.r < litShare; wins.push(wn); paintWin(emi.g, wn);
      }
    }
    map.t.needsUpdate = emi.t.needsUpdate = true;
    return {map: map, emi: emi, wins: wins};
  }
  function tower(x, y0, z, wd, d, floors, seed, paint){
    var cols = Math.max(2, Math.round(wd/1.15)), colsD = Math.max(2, Math.round(d/1.15));
    var Ff = facade(cols, floors, seed, paint), Fs = facade(colsD, floors, seed + 7, paint), Fb = facade(cols, floors, seed + 13, paint);
    dyn.facades.push(Ff, Fs, Fb);
    function fm(F){ var m = new THREE.MeshStandardMaterial({map: F.map.t, emissiveMap: F.emi.t, emissive: new THREE.Color(0xffffff), emissiveIntensity: 1, roughness: 0.35, metalness: 0.35}); dyn.facMats.push(m); return m; }
    var mF = fm(Ff), mS = fm(Fs), mB = fm(Fb), roof = mat(0x2b3a48, {roughness: 0.8});
    var H = floors*2.6, body = new THREE.Mesh(new THREE.BoxGeometry(wd, H, d), [mS, mS, roof, roof, mF, mB]); c.add(body, x, y0 + H/2, z, baseG);
    var ledge = mat(0x4d6680, {metalness: 0.4, roughness: 0.5});
    for(var f = 1; f <= floors; f++) box(wd + 0.24, 0.12, d + 0.24, ledge, x, y0 + f*2.6 - 0.06, z, baseG, true);
    [[-1, -1], [1, -1], [-1, 1], [1, 1]].forEach(function(q){ box(0.24, H, 0.24, mat(0x5a7590, {metalness: 0.5}), x + q[0]*wd/2, y0 + H/2, z + q[1]*d/2, baseG); });
    var top = y0 + H, led = emis(0x0d1a24, dyn.accent, 2);
    box(wd + 0.3, 0.5, 0.14, roof, x, top + 0.25, z + d/2, baseG); box(wd + 0.3, 0.5, 0.14, roof, x, top + 0.25, z - d/2, baseG);
    box(0.14, 0.5, d + 0.3, roof, x - wd/2, top + 0.25, z, baseG); box(0.14, 0.5, d + 0.3, roof, x + wd/2, top + 0.25, z, baseG);
    box(wd + 0.34, 0.07, 0.07, led, x, top + 0.52, z + d/2 + 0.02, baseG, true); box(0.07, 0.07, d + 0.34, led, x + wd/2 + 0.02, top + 0.52, z, baseG, true);
    dyn.leds.push(led);
    return top;
  }
  function lobbyBlock(x, z, wd, d){
    var gl = new THREE.MeshStandardMaterial({color: 0x0b1622, emissive: new THREE.Color(0xffb866), emissiveIntensity: 0.3, transparent: true, opacity: 0.9, roughness: 0.1, metalness: 0.3});
    dyn.lobbyMats.push(gl);
    box(wd - 0.4, 3.2, d - 0.4, gl, x, 1.6, z, baseG);
    for(var m = -wd/2 + 0.2; m <= wd/2 - 0.2 + 0.01; m += 1.2) box(0.1, 3.2, 0.1, mat(0x5a7590, {metalness: 0.6}), x + m, 1.6, z + d/2 - 0.18, baseG);
    box(wd + 0.4, 0.3, d + 0.4, mat(0x4d6680), x, 3.35, z, baseG);
    return 3.5;
  }
  function beacon(x, y, z){ var b = sph(0.22, emis(COL.coral, COL.coral, 3), x, y, z, baseG); dyn.beacons.push(b); var g = c.glow(COL.coral, 1.4, 0.9); g.position.copy(b.position); baseG.add(g); dyn.beaconGlows.push(g); }
  function build(){
    var level = Math.max(1, c.level() | 0), look = c.look() || {};
    var paint = /^#[0-9a-f]{6}$/i.test(look.paint || "") ? look.paint : "#2a3c50";
    var accent = /^#[0-9a-f]{6}$/i.test(look.accent || "") ? parseInt(look.accent.slice(1), 16) : COL.amber;
    while(baseG.children.length) baseG.remove(baseG.children[0]);
    hits.length = 0; doors.length = 0;
    dyn = {facades: [], facMats: [], leds: [], lobbyMats: [], beacons: [], beaconGlows: [], banners: [], heli: null, jets: [], karts: [], glows: [], accent: accent,
           flags: [], fireworks: []};
    var floorsLow = Math.min(8, 1 + Math.floor(level/5)), floorsHigh = level >= 25 ? Math.min(8, 1 + Math.floor((level - 25)/4)) : 0;
    var y = lobbyBlock(0, 0, 9, 7);
    var topLow = tower(0, y, 0, 9, 7, floorsLow, 100 + level % 7, paint), top = topLow;
    if(floorsHigh){ top = tower(0, topLow + 0.5, -0.5, 6, 4.6, floorsHigh, 200 + level % 5, paint); box(9.2, 0.5, 7.2, mat(0x2b3a48), 0, topLow + 0.25, 0, baseG); }
    // the front door: canopy, sign, revolving door; walk up to it to go in
    box(5.6, 0.28, 2.6, mat(0x2b3a48, {metalness: 0.5}), 0, 3.15, 4.6, baseG); [-2.5, 2.5].forEach(function(x){ box(0.2, 3.1, 0.2, mat(0x9aa7b5, {metalness: 0.7}), x, 1.55, 5.7, baseG); });
    var cs = c.canvasTex(512, 64, function(g){ g.fillStyle = "#0b1622"; g.fillRect(0, 0, 512, 64); g.fillStyle = "#" + accent.toString(16).padStart(6, "0"); g.font = "700 44px system-ui, sans-serif"; g.textAlign = "center"; g.fillText(c.short((look.sign || "CLAUDE HQ").toUpperCase(), 16), 256, 48); });
    var sgn = c.screen(5.4, 0.5, cs.t); sgn.position.set(0, 3.15, 5.92); baseG.add(sgn);
    var cg = c.glow(accent, 4, 0.35); cg.position.set(0, 3.1, 6.2); baseG.add(cg); dyn.glows.push(cg);
    var revolve = cyl(0.9, 0.9, 2.6, new THREE.MeshStandardMaterial({color: 0xbfe3f5, transparent: true, opacity: 0.3, roughness: 0.05, emissive: new THREE.Color(0xffb866), emissiveIntensity: 0.2}), 0, 1.3, 3.5, baseG, 20);
    var door = {view: "@lobby", label: "Front door", tip: "Front door: into the Lobby", front: new THREE.Vector3(0, 0, 4.8)};   // under the canopy
    [revolve, sgn].forEach(function(o){ o.userData.door = door; hits.push(o); }); doors.push(door);
    var lt = c.label("Front door", HEX.green, 0.5); lt.position.set(0, 4.3, 6.1); baseG.add(lt);
    // the roof
    if(level >= 40){
      var dome = new THREE.Mesh(new THREE.SphereGeometry(2.1, 28, 14, 0, PI*2, 0, PI/2), new THREE.MeshStandardMaterial({color: 0xbfe3f5, transparent: true, opacity: 0.4, roughness: 0.05, metalness: 0.3, emissive: new THREE.Color(COL.cyan), emissiveIntensity: 0.35}));
      c.add(dome, 0, top + 0.1, -0.5, baseG); cyl(2.2, 2.2, 0.3, mat(0x4d6680), 0, top + 0.15, -0.5, baseG, 28);
      box(0.12, 5, 0.12, mat(0x9aa7b5), 2.2, top + 2.5, -2, baseG); beacon(2.2, top + 5.1, -2);
    } else {
      var rx = 0, rz = floorsHigh ? -0.5 : 0, rw = floorsHigh ? 6 : 9, rd = floorsHigh ? 4.6 : 7;
      [[-rw*0.25, -rd*0.2], [rw*0.05, -rd*0.25], [rw*0.28, rd*0.15]].forEach(function(q){ box(1.1, 0.7, 0.9, mat(0x8e9aa6, {metalness: 0.5}), rx + q[0], top + 0.35, rz + q[1], baseG); });
      cyl(0.7, 0.7, 1.2, mat(0x8a5a35, {roughness: 0.8}), rx - rw*0.28, top + 1.6, rz + rd*0.22, baseG, 16);
      box(0.14, 5, 0.14, mat(0x9aa7b5, {metalness: 0.6}), rx + rw*0.32, top + 2.5, rz - rd*0.3, baseG); beacon(rx + rw*0.32, top + 5.1, rz - rd*0.3);
    }
    if(level >= 25){
      var ty = topLow + 0.5;
      [[-3.8, 0, 1.2, 6.8], [3.8, 0, 1.2, 6.8], [0, 2.8, 6.2, 1.2]].forEach(function(p){ box(p[2], 0.25, p[3], mat(0x2f6b45, {roughness: 0.9}), p[0], ty + 0.12, p[1], baseG); });
      [[-3.8, -2.2], [-3.8, 1.8], [3.8, -2.2], [3.8, 1.8]].forEach(function(p){ sph(0.5, mat(0x3c8a4f, {roughness: 0.9}), p[0], ty + 1.0, p[1], baseG); });
      for(var sl = 0; sl < 10; sl++){ var gw = c.glow(0xffd9a0, 0.35, 0.9); gw.position.set(-4.2 + sl*0.93, ty + 1.6, 3.4); baseG.add(gw); dyn.glows.push(gw); }
    }
    // wings, helipad, skybridges
    var floorsW = Math.max(1, floorsLow - 2);
    [[-10.5, 10], [10.5, 30]].forEach(function(wd, n){
      if(level < wd[1]) return;
      var yy = lobbyBlock(wd[0], 0.5, 5.5, 5), wt = tower(wd[0], yy, 0.5, 5.5, 5, floorsW, 300 + n*11 + level % 3, paint);
      if(n === 0 && level >= 20){
        cyl(2.3, 2.3, 0.16, mat(0x2b3a48), wd[0], wt + 0.1, 0.5, baseG, 32);
        var hT = c.canvasTex(256, 256, function(g){ g.strokeStyle = HEX.amber; g.lineWidth = 10; g.beginPath(); g.arc(128, 128, 110, 0, 7); g.stroke(); g.fillStyle = "#e9eff3"; g.font = "700 150px system-ui, sans-serif"; g.textAlign = "center"; g.fillText("H", 128, 182); });
        var hp = new THREE.Mesh(new THREE.CircleGeometry(2.1, 32), new THREE.MeshBasicMaterial({map: hT.t, transparent: true, toneMapped: false})); hp.rotation.x = -PI/2; hp.position.set(wd[0], wt + 0.19, 0.5); baseG.add(hp);
        var heli = new THREE.Group(), red = mat(0xd14a5c, {metalness: 0.5, roughness: 0.35});
        sph(0.8, red, 0, 0.95, 0, heli).scale.set(1.5, 0.9, 0.9); box(0.12, 0.12, 2.4, red, 0, 1.1, -1.9, heli);
        var rotor = new THREE.Group(); rotor.position.y = 1.92; heli.add(rotor); box(4.2, 0.03, 0.18, mat(0x1d2128), 0, 0, 0, rotor); box(0.18, 0.03, 4.2, mat(0x1d2128), 0, 0, 0, rotor);
        heli.position.set(wd[0], wt + 0.2, 0.5); heli.rotation.y = PI/2; baseG.add(heli); dyn.heli = {g: heli, rotor: rotor, y: wt + 0.2, x: wd[0]};
      }
      if(level >= 30){
        var by = Math.max(4.8, wt - 1.3), bx = (4.5 + Math.abs(wd[0]) - 2.75)/2*Math.sign(wd[0]), bl = Math.abs(wd[0]) - 2.75 - 4.5;
        box(bl, 1.6, 2, new THREE.MeshStandardMaterial({color: 0x0b1622, emissive: new THREE.Color(COL.cyan), emissiveIntensity: 0.45, transparent: true, opacity: 0.8, roughness: 0.1}), bx, by, 0.5, baseG);
      }
    });
    if(level >= 15){
      var bt = c.canvasTex(128, 512, function(g){ g.fillStyle = "#1a1408"; g.fillRect(0, 0, 128, 512); g.fillStyle = HEX.amber; g.fillRect(0, 0, 128, 14); g.fillRect(0, 498, 128, 14); g.save(); g.translate(64, 256); g.rotate(-PI/2); g.textAlign = "center"; g.fillStyle = HEX.amber; g.font = "700 60px system-ui, sans-serif"; g.fillText("LEVEL " + level, 0, 8); g.fillStyle = HEX.ink; g.font = "600 26px ui-monospace, monospace"; g.fillText(c.short((look.sign || "CLAUDE HQ").toUpperCase(), 18), 0, 46); g.restore(); });
      [-2.9, 2.9].forEach(function(x){ var bn = c.screen(1.3, 5.2, bt.t); bn.material.side = THREE.DoubleSide; var piv = new THREE.Group(); piv.position.set(x, topLow - 0.3, 3.75); baseG.add(piv); bn.position.y = -2.6; piv.add(bn); dyn.banners.push(piv); });
    }
    if(level >= 45 && floorsHigh){
      var live = (c.sessions() || []).filter(function(s){ return c.crewState(s) !== "stale"; }).length;
      var bbT = c.canvasTex(512, 300, function(g){ g.fillStyle = "#06111a"; g.fillRect(0, 0, 512, 300); g.strokeStyle = HEX.cyan; g.lineWidth = 6; g.strokeRect(6, 6, 500, 288); g.fillStyle = HEX.amber; g.font = "700 64px system-ui, sans-serif"; g.fillText(live + " CREW LIVE", 30, 110); g.fillStyle = HEX.cyan; g.font = "600 36px ui-monospace, monospace"; g.fillText("HQ level " + level, 30, 200); });
      var bb = c.screen(4.2, 2.5, bbT.t); bb.position.set(3.16, top - 3.5, -0.5); bb.rotation.y = PI/2; baseG.add(bb);
    }
    if(level >= 5){
      var fg = new THREE.Group(); fg.position.set(0, 0, 10.4); baseG.add(fg);
      cyl(2.5, 2.6, 0.55, mat(0x9aa7b5, {roughness: 0.6}), 0, 0.27, 0, fg, 32);
      cyl(2.3, 2.3, 0.05, new THREE.MeshStandardMaterial({color: 0x2a7fa8, emissive: new THREE.Color(COL.cyan), emissiveIntensity: 0.35, transparent: true, opacity: 0.85, roughness: 0.05}), 0, 0.5, 0, fg, 32);
      cyl(0.9, 1.0, 0.5, mat(0x9aa7b5), 0, 0.75, 0, fg, 20); cyl(0.25, 0.3, 1.0, mat(0x9aa7b5), 0, 1.4, 0, fg, 12);
      for(var j = 0; j < 10; j++){ var jg = c.glow(0x9fe3f0, 0.35, 0.9); fg.add(jg); dyn.jets.push({g: jg, a: j/10*PI*2, o: (j % 5)/5}); }
    }
    if(level >= 50){
      var st = new THREE.Group(); st.position.set(7.4, 0, 9.6); baseG.add(st);
      box(1.8, 1.0, 1.8, mat(0x4d5866, {roughness: 0.6}), 0, 0.5, 0, st);
      var gold = mat(0xd8b34a, {metalness: 0.9, roughness: 0.25});
      sph(0.9, gold, 0, 1.85, 0, st).scale.y = 0.9; [-0.4, 0.4].forEach(function(x){ c.add(new THREE.Mesh(new THREE.ConeGeometry(0.25, 0.7, 6), gold), x, 2.75, 0, st).rotation.z = -x; });
    }
    if(level >= 35){
      var ktT = c.canvasTex(512, 768, function(g){ g.fillStyle = "#1f3d2c"; g.fillRect(0, 0, 512, 768); g.lineWidth = 92; g.strokeStyle = "#2a2f36"; g.beginPath(); g.ellipse(256, 384, 176, 300, 0, 0, 7); g.stroke(); g.lineWidth = 10; g.setLineDash([22, 22]); g.strokeStyle = "#d14a5c"; g.beginPath(); g.ellipse(256, 384, 222, 346, 0, 0, 7); g.stroke(); g.setLineDash([]); });
      var kt = new THREE.Mesh(new THREE.PlaneGeometry(14, 21), new THREE.MeshStandardMaterial({map: ktT.t, roughness: 0.9})); kt.rotation.x = -PI/2; kt.position.set(-31, 0.03, 0); kt.receiveShadow = true; baseG.add(kt);
      [0xd14a5c, 0x4a7bd1, 0x6fd38a].forEach(function(col, n){ var kg = new THREE.Group(); box(1.1, 0.3, 0.65, mat(col, {metalness: 0.5}), 0, 0.3, 0, kg); baseG.add(kg); dyn.karts.push({g: kg, o: n*0.33}); });
      var kl = c.label("Kart Racing", HEX.coral, 0.9); kl.position.set(-31, 4.5, 0); baseG.add(kl);
    }
    if(level >= 55){
      var ar = new THREE.Group(); ar.position.set(0, 0, -34); baseG.add(ar);
      c.add(new THREE.Mesh(new THREE.CylinderGeometry(9.5, 8, 4, 40, 1, true), mat(0x3a5068, {side: THREE.DoubleSide, roughness: 0.7})), 0, 2, 0, ar);
      var field = new THREE.Mesh(new THREE.CircleGeometry(7.6, 40), new THREE.MeshStandardMaterial({color: 0x1d4a3a, emissive: new THREE.Color(COL.cyan), emissiveIntensity: 0.15})); field.rotation.x = -PI/2; field.position.y = 0.05; ar.add(field);
      var al = c.label("Arena", HEX.cyan, 1.1); al.position.set(0, 7, 0); ar.add(al);
    }
    // HQ 2.1 decor (a cosmetic the owner wears): flags, gnomes, fireworks or a neon outline
    if(look.decor === "flags"){
      for(var fi = 0; fi < 8; fi++){ var fa = fi/8*PI*2 + 0.2, fx = Math.cos(fa)*13.6, fz = Math.sin(fa)*13.6;
        cyl(0.05, 0.05, 4.2, mat(0xb8c4cf, {metalness: 0.6}), fx, 2.1, fz, baseG, 6);
        var fl = box(1.1, 0.7, 0.03, mat([0xff6b5b, 0x5fd3e6, 0xffb347, 0x6fd38a][fi % 4]), fx + 0.55, 3.75, fz, baseG); fl.userData.wave = fi; dyn.flags.push(fl); }
    } else if(look.decor === "gnomes"){
      for(var gi = 0; gi < 10; gi++){ var ga = gi/10*PI*2 + 0.3, gx = Math.cos(ga)*14.8, gz = Math.sin(ga)*14.8, gn = new THREE.Group(); gn.position.set(gx, 0, gz); baseG.add(gn);
        cyl(0.22, 0.28, 0.45, mat(0x3a5ea8), 0, 0.22, 0, gn, 10); sph(0.18, mat(0xf1c9a5), 0, 0.58, 0, gn); sph(0.16, mat(0xf4f4f4), 0, 0.48, 0.1, gn);
        c.add(new THREE.Mesh(new THREE.ConeGeometry(0.2, 0.45, 10), mat(0xd14a5c)), 0, 0.88, 0, gn); }
    } else if(look.decor === "fireworks"){
      for(var fw = 0; fw < 3; fw++){ var g = new THREE.Group(); baseG.add(g); var parts = [];
        for(var q = 0; q < 18; q++){ var sp = c.glow([COL.amber, COL.cyan, COL.coral][fw], 0.6, 1); g.add(sp); parts.push({s: sp, a: q/18*PI*2, b: (q % 3 - 1)*0.6}); }
        dyn.fireworks.push({g: g, parts: parts, o: fw/3, x: (fw - 1)*6, y: top + 8 + fw*2}); }
    } else if(look.decor === "neon"){
      [[-1, -1], [1, -1], [-1, 1], [1, 1]].forEach(function(q){ box(0.08, top - 3.5, 0.08, emis(0x0d1a24, accent, 2.5), q[0]*4.62, 3.5 + (top - 3.5)/2, q[1]*3.62, baseG, true); });
    }
    // your crew's banner on the roof (HQ 2.1 crews)
    if(look.crew && /^#[0-9a-f]{6}$/i.test(look.crew.color || "")){
      var crewCol = parseInt(look.crew.color.slice(1), 16);
      cyl(0.08, 0.08, 4, mat(0xb8c4cf, {metalness: 0.6}), -2.6, top + 2, 1.6, baseG, 8);
      var ct = c.canvasTex(256, 128, function(g){ g.fillStyle = look.crew.color; g.fillRect(0, 0, 256, 128); g.fillStyle = "#0e1923"; g.font = "700 64px system-ui, sans-serif"; g.textAlign = "center"; g.fillText(String(look.crew.tag || "").slice(0, 4), 128, 86); });
      var cf = c.screen(1.8, 0.9, ct.t); cf.material.side = THREE.DoubleSide; cf.position.set(-1.7, top + 3.5, 1.6); baseG.add(cf); cf.userData.wave = 9; dyn.flags.push(cf);
    }
    var sb = c.label(c.short((look.sign || "Claude HQ"), 16) + " · Lv " + level, HEX.amber, 1.1); sb.position.set(0, top + 7, 0); baseG.add(sb);
    built.level = level; built.look = JSON.stringify(look); built.top = top;
    w.wings = level >= 30 ? 2 : level >= 10 ? 1 : 0; w.level = level;
    applyTime();
  }
  function applyTime(){
    if(!dyn) return;
    dyn.facMats.forEach(function(m){ m.emissiveIntensity = night ? 1 : 0.06; });
    dyn.lobbyMats.forEach(function(m){ m.emissiveIntensity = night ? 0.32 : 0.08; });
    dyn.glows.forEach(function(g){ g.visible = night; });
    lampGlows.forEach(function(g){ g.material.opacity = night ? 0.85 : 0.08; });
    cars.forEach(function(k){ k.c.lights.forEach(function(l){ l.material.opacity = night ? 0.95 : 0.25; }); });
    clouds.visible = !night;
  }

  // what you cannot walk through
  function blocked(x, z){
    if(Math.hypot(x, z) > 46) return true;
    if(Math.abs(x) < 4.8 && Math.abs(z) < 3.8) return true;                         // the tower
    if(w.wings >= 1 && Math.abs(x + 10.5) < 3.0 && Math.abs(z - 0.5) < 2.8) return true;
    if(w.wings >= 2 && Math.abs(x - 10.5) < 3.0 && Math.abs(z - 0.5) < 2.8) return true;
    if(w.level >= 5 && Math.hypot(x, z - 10.4) < 2.8) return true;                  // the fountain
    if(w.level >= 50 && Math.abs(x - 7.4) < 1.1 && Math.abs(z - 9.6) < 1.1) return true;
    if(w.level >= 55 && Math.hypot(x, z + 34) < 9.8) return true;
    return false;
  }

  build();
  var acc = 0, twinkle = 0, liveSeen = -1;
  w.floor = ground; w.hits = hits; w.doors = doors; w.span = 17; w.zoom = 0.85; w.camY = 2.5; w.follow = 1; w.camPitch = 0.5;
  w.bounds = [-46, 46, -46, 46];
  w.spawn = {x: 3, z: 14, yaw: PI};
  w.spawnFrom = {lobby: {x: 0, z: 7.4, yaw: 0}};
  w.blocked = blocked;
  w.setTime = function(n){ night = n; S.background = n ? skyBg.night : skyBg.day; S.fog = new THREE.Fog(n ? 0x0f1f30 : 0xb8dcf2, 70, 160);
    hemi.intensity = n ? 1.3 : 2.4; sun.intensity = n ? 0.7 : 2.4; sun.color.set(n ? 0xa9b8ff : 0xfff2dc); applyTime(); };
  w.onData = function(list){
    var live = (list || []).filter(function(s){ return c.crewState(s) !== "stale"; }).length;
    litShare = Math.min(0.9, 0.3 + live*0.08);          // more crew at work, more windows lit
    if(live !== liveSeen && dyn){ liveSeen = live; dyn.facades.forEach(function(F){ F.wins.forEach(function(wn){ wn.lit = wn.r < litShare; paintWin(F.emi.g, wn); }); F.emi.t.needsUpdate = true; }); }
  };
  w.onLook = function(){ build(); };
  w.update = function(t, dt, k){
    acc += dt;
    if(acc > 2){ acc = 0; if(Math.max(1, c.level() | 0) !== built.level || JSON.stringify(c.look() || {}) !== built.look) build(); }
    if(dyn.heli){ dyn.heli.rotor.rotation.y = t*14*k; var hv = (t % 24)/24, lift = hv < 0.4 ? 0 : hv < 0.5 ? (hv - 0.4)*10 : hv < 0.9 ? 1 : (1 - hv)*10;
      dyn.heli.g.position.y = dyn.heli.y + lift*6*k; dyn.heli.g.position.x = dyn.heli.x + lift*Math.sin(t*0.4)*3*k; }
    dyn.beacons.forEach(function(b, n){ var on = ((t + n*0.3) % 1.4) < 0.25; b.material.emissiveIntensity = on ? 3 : 0.4; dyn.beaconGlows[n].material.opacity = on ? 1 : 0.1; });
    dyn.banners.forEach(function(b, n){ b.rotation.x = Math.sin(t*1.6 + n)*0.06*k; });
    dyn.flags.forEach(function(f){ f.rotation.y = Math.sin(t*2.4 + f.userData.wave)*0.35*k; });
    dyn.fireworks.forEach(function(fw){ var u = (t*0.35*k + fw.o) % 1; fw.g.visible = night && u > 0.15;
      fw.parts.forEach(function(p){ var r = (u - 0.15)*9; p.s.position.set(fw.x + Math.cos(p.a)*r, fw.y + Math.sin(p.a)*r*0.8 - u*u*4 + p.b, Math.sin(p.a)*r*0.4); p.s.material.opacity = Math.max(0, 1 - u); }); });
    dyn.jets.forEach(function(j){ var u = (t*0.9*k + j.o) % 1, r = 0.6 + u*1.4; j.g.position.set(Math.cos(j.a)*r, 2.0 + Math.sin(u*PI)*1.3 - u*0.9, Math.sin(j.a)*r); j.g.material.opacity = 0.9*(1 - u*0.6); });
    dyn.karts.forEach(function(kk){ var a = t*0.7*k + kk.o*PI*2; kk.g.position.set(-31 + Math.cos(a)*4.4, 0.05, Math.sin(a)*8); kk.g.rotation.y = Math.atan2(-Math.cos(a)*8, -Math.sin(a)*4.4); });
    cars.forEach(function(k2){ k2.a += k2.v*dt*k; var x = Math.cos(k2.a)*k2.r, z = Math.sin(k2.a)*k2.r, dx = -Math.sin(k2.a)*k2.v, dz = Math.cos(k2.a)*k2.v; k2.c.g.position.set(x, 0, z); k2.c.g.rotation.y = Math.atan2(-dz, dx); });
    strollers.forEach(function(s){ var a = t*0.12*s.dir*k + s.ph, x = Math.cos(a)*s.rx, z = 9.6 + Math.sin(a)*s.rz; s.g.position.set(x, 0, z);
      var dx = -Math.sin(a)*s.rx*s.dir, dz = Math.cos(a)*s.rz*s.dir; s.g.rotation.y = Math.atan2(dx, dz); if(s.ch) s.ch.mixer.update(dt*k); });
    clouds.position.x = ((t*0.6*k) % 40) - 20;
    twinkle += dt;
    if(twinkle > 0.45 && night && dyn.facades.length){ twinkle = 0; var F = dyn.facades[Math.floor(Math.random()*dyn.facades.length)], wn = F.wins[Math.floor(Math.random()*F.wins.length)]; wn.lit = !wn.lit; paintWin(F.emi.g, wn); F.emi.t.needsUpdate = true; }
  };
  return w;
};
})();
