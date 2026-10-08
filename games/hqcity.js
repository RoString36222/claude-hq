/* Claude HQ 2.1: Arena City, the street of open HQs.
 *
 * Everyone who opened their HQ to visitors has a building on one round street:
 * a ring road around a plaza, each HQ on its own lot facing the middle, built from
 * that HQ's level, paint, accent, sign (its name, on the banners) and decor. Your
 * own building is one of them. Walk up to someone's front door to go into their
 * HQ as a visitor (their Lobby); your own door takes you into your Lobby.
 *
 * A floor of the 3D HQ: registered as HQV.hqWorlds.city and built by games/hq3d.js.
 * The street comes from ctx.api.city() (the Arena's list of open HQs: counts and
 * cosmetics only) and is rebuilt when that list changes (w.onCity). Everyone gets
 * the same layout from the same list (sorted by user id), so the people walking the
 * street (live presence, room "hq_city") stand in the same places for everyone.
 */
(function(){
"use strict";
var HQV = window.HQV = window.HQV || {};
HQV.hqWorlds = HQV.hqWorlds || {};

var MAX_LOTS = 40;
var LOT_ARC = 15;           // street frontage per building (m)

// The street's layout from the list: who stands where. Pure, so it is easy to test.
function layout(list){
  var hs = (list || []).filter(function(h){ return h && typeof h.userId === "string"; })
    .sort(function(a, b){ return a.userId < b.userId ? -1 : a.userId > b.userId ? 1 : 0; });
  if(hs.length > MAX_LOTS){
    var you = hs.filter(function(h){ return h.isYou; });
    hs = hs.filter(function(h){ return !h.isYou; }).slice(0, MAX_LOTS - you.length).concat(you)
      .sort(function(a, b){ return a.userId < b.userId ? -1 : 1; });
  }
  var n = Math.max(1, hs.length), R = Math.max(24, n*LOT_ARC/(2*Math.PI));
  return {R: R, lots: hs.map(function(h, i){
    var a = i/n*Math.PI*2 + Math.PI/2, rb = R + 12, dx = -Math.cos(a), dz = -Math.sin(a);   // dx/dz: towards the middle
    return {h: h, a: a, x: Math.cos(a)*rb, z: Math.sin(a)*rb, rot: Math.atan2(dx, dz), dx: dx, dz: dz,
            door: {x: Math.cos(a)*(rb - 6.3), z: Math.sin(a)*(rb - 6.3)}};
  })};
}
HQV.hqCityLayout = layout;
function nameOf(h){
  var s = h.look && typeof h.look.sign === "string" && h.look.sign.trim();
  return s || ((h.trainerName || h.displayName || h.handle || "Someone") + "'s HQ");
}
HQV.hqCityName = nameOf;

HQV.hqWorlds.city = function(c, w){
  var THREE = c.THREE, PI = c.PI, S = w.scene, COL = c.COL, HEX = c.HEX;
  var mat = c.mat, emis = c.emis, box = c.box, cyl = c.cyl, sph = c.sph;
  var hits = [], doors = [], night = true;
  var api = c.api || {};

  var hemi = new THREE.HemisphereLight(0xbcd7ff, 0x223322, 2.2); S.add(hemi);
  var sun = new THREE.DirectionalLight(0xffffff, 2.2); sun.position.set(40, 70, 30); sun.castShadow = true;
  sun.shadow.mapSize.set(2048, 2048); S.add(sun); S.add(sun.target);
  var skyBg = {
    night: c.canvasTex(512, 512, function(g){ var gr = g.createLinearGradient(0, 0, 0, 512); gr.addColorStop(0, "#040a12"); gr.addColorStop(0.6, "#0b1826"); gr.addColorStop(1, "#16304a"); g.fillStyle = gr; g.fillRect(0, 0, 512, 512); var R = c.rng(9); for(var i = 0; i < 220; i++){ g.fillStyle = "rgba(255,255,255," + (0.25 + R()*0.7) + ")"; g.fillRect(R()*512, R()*330, 1, 1); } }).t,
    day: c.canvasTex(512, 512, function(g){ var gr = g.createLinearGradient(0, 0, 0, 512); gr.addColorStop(0, "#5ea6dc"); gr.addColorStop(1, "#cfe8f7"); g.fillStyle = gr; g.fillRect(0, 0, 512, 512); }).t
  };
  var grassT = c.canvasTex(256, 256, function(g){ var R = c.rng(4); g.fillStyle = "#1f3d2c"; g.fillRect(0, 0, 256, 256);
    for(var i = 0; i < 900; i++){ g.fillStyle = R() < 0.5 ? "rgba(46,92,58,.5)" : "rgba(22,48,33,.5)"; g.fillRect(R()*256, R()*256, 2 + R()*5, 2 + R()*5); } });
  grassT.t.wrapS = grassT.t.wrapT = THREE.RepeatWrapping;
  var paveT = c.canvasTex(256, 256, function(g){ g.fillStyle = "#3b4c5c"; g.fillRect(0, 0, 256, 256); g.strokeStyle = "rgba(255,255,255,.08)"; g.lineWidth = 2;
    for(var i = 0; i <= 256; i += 32){ g.beginPath(); g.moveTo(i, 0); g.lineTo(i, 256); g.stroke(); g.beginPath(); g.moveTo(0, i); g.lineTo(256, i); g.stroke(); } });
  paveT.t.wrapS = paveT.t.wrapT = THREE.RepeatWrapping;

  var streetG = new THREE.Group(); S.add(streetG);
  var city = {R: 24, lots: []}, sig = null, lampGlows = [], cars = [], dyn = {facMats: [], glows: [], beacons: [], flags: [], leds: []};
  var floor = null;
  function flat(geo, m, y){ var o = new THREE.Mesh(geo, m); o.rotation.x = -PI/2; o.position.y = y; o.receiveShadow = true; streetG.add(o); return o; }

  // one building on its lot, front (+z local) facing the middle of the street
  function building(L){
    var h = L.h, level = Math.max(1, h.level | 0), look = h.look || {}, cos = h.cos || {};
    var paint = /^#[0-9a-f]{6}$/i.test(look.paint || "") ? look.paint : "#2a3c50";
    var accent = /^#[0-9a-f]{6}$/i.test(look.accent || "") ? parseInt(look.accent.slice(1), 16) : COL.amber;
    var accHex = "#" + accent.toString(16).padStart(6, "0"), name = nameOf(h);
    var g = new THREE.Group(); g.position.set(L.x, 0, L.z); g.rotation.y = L.rot; streetG.add(g);
    var bodyG = new THREE.Group(); g.add(bodyG);         // what fades when it stands between you and the camera
    var Wd = 8, D = 7, floors = Math.max(2, Math.min(16, 2 + Math.floor(level/4))), H = 3.2 + floors*2.4;
    // lot: paving, lawn, a path to the street
    var pad = new THREE.Mesh(new THREE.PlaneGeometry(13, 13), new THREE.MeshStandardMaterial({map: paveT.t, roughness: 0.9}));
    pad.rotation.x = -PI/2; pad.position.set(0, 0.02, 0.5); pad.receiveShadow = true; g.add(pad);
    if(h.isYou){ var ring = new THREE.Mesh(new THREE.RingGeometry(6.4, 6.8, 48), new THREE.MeshBasicMaterial({color: COL.amber, transparent: true, opacity: 0.55, toneMapped: false}));
      ring.rotation.x = -PI/2; ring.position.set(0, 0.04, 0.5); g.add(ring); }
    // the facade: windows lit by crew at work
    var crew = h.crew || {}, live = (crew.working | 0) + (crew.needs | 0), lit = Math.min(0.9, 0.25 + live*0.1), R = c.rng(c.hashStr(h.userId));
    var fT = c.canvasTex(256, 32*floors), eT = c.canvasTex(256, 32*floors);
    fT.g.fillStyle = paint; fT.g.fillRect(0, 0, 256, 32*floors); eT.g.fillStyle = "#000"; eT.g.fillRect(0, 0, 256, 32*floors);
    for(var f = 0; f < floors; f++) for(var k = 0; k < 7; k++){
      var x = 8 + k*35, y = f*32 + 7, on = R() < lit;
      fT.g.fillStyle = "#16304a"; fT.g.fillRect(x, y, 26, 20); fT.g.fillStyle = "rgba(255,255,255,.1)"; fT.g.fillRect(x, y, 9, 20);
      if(on){ eT.g.fillStyle = R() < 0.8 ? "#ffcf7a" : "#9fe3f0"; eT.g.fillRect(x, y, 26, 20); }
    }
    fT.t.needsUpdate = eT.t.needsUpdate = true;
    var fm = new THREE.MeshStandardMaterial({map: fT.t, emissiveMap: eT.t, emissive: new THREE.Color(0xffffff), emissiveIntensity: night ? 1 : 0.06, roughness: 0.4, metalness: 0.3});
    dyn.facMats.push(fm);
    var roof = mat(0x2b3a48, {roughness: 0.8});
    var lob = new THREE.MeshStandardMaterial({color: 0x0b1622, emissive: new THREE.Color(0xffb866), emissiveIntensity: 0.3, transparent: true, opacity: 0.9, roughness: 0.1});
    box(Wd - 0.4, 3.2, D - 0.4, lob, 0, 1.6, 0, g);
    var body = new THREE.Mesh(new THREE.BoxGeometry(Wd, H - 3.2, D), [fm, fm, roof, roof, fm, fm]); c.add(body, 0, 3.2 + (H - 3.2)/2, 0, bodyG);
    [[-1, -1], [1, -1], [-1, 1], [1, 1]].forEach(function(q){ box(0.22, H, 0.22, mat(0x5a7590, {metalness: 0.5}), q[0]*Wd/2, H/2, q[1]*D/2, bodyG); });
    var led = emis(0x0d1a24, accent, 2); dyn.leds.push(led);
    box(Wd + 0.3, 0.12, 0.12, led, 0, H + 0.1, D/2, g, true); box(Wd + 0.3, 0.12, 0.12, led, 0, H + 0.1, -D/2, g, true);
    box(0.12, 0.12, D + 0.3, led, Wd/2, H + 0.1, 0, g, true); box(0.12, 0.12, D + 0.3, led, -Wd/2, H + 0.1, 0, g, true);
    if(level >= 30){   // a second, shorter wing
      var wh = Math.max(4, H*0.6); box(4.5, wh, 5, fm, -Wd/2 - 2.6, wh/2, -0.6, bodyG);
    }
    if(level >= 20){
      cyl(2, 2, 0.15, mat(0x2b3a48), 0, H + 0.1, -0.3, g, 28);
      var hT = c.canvasTex(128, 128, function(gg){ gg.strokeStyle = HEX.amber; gg.lineWidth = 8; gg.beginPath(); gg.arc(64, 64, 54, 0, 7); gg.stroke(); gg.fillStyle = "#e9eff3"; gg.font = "700 74px system-ui, sans-serif"; gg.textAlign = "center"; gg.fillText("H", 64, 90); });
      var hp = new THREE.Mesh(new THREE.CircleGeometry(1.8, 28), new THREE.MeshBasicMaterial({map: hT.t, transparent: true, toneMapped: false})); hp.rotation.x = -PI/2; hp.position.set(0, H + 0.19, -0.3); g.add(hp);
    } else {
      box(0.12, 3.5, 0.12, mat(0x9aa7b5), Wd*0.3, H + 1.75, -D*0.3, g);
      var b = sph(0.2, emis(COL.coral, COL.coral, 3), Wd*0.3, H + 3.6, -D*0.3, g); dyn.beacons.push(b);
    }
    // the front: canopy, door, the HQ's name on the sign and both banners
    box(5.2, 0.25, 2.2, mat(0x2b3a48, {metalness: 0.5}), 0, 3.15, D/2 + 1, g);
    var signT = c.canvasTex(512, 64, function(gg){ gg.fillStyle = "#0b1622"; gg.fillRect(0, 0, 512, 64); gg.fillStyle = accHex; gg.font = "700 42px system-ui, sans-serif"; gg.textAlign = "center"; gg.fillText(c.short(name.toUpperCase(), 18), 256, 47); });
    var sgn = c.screen(5, 0.48, signT.t); sgn.position.set(0, 3.15, D/2 + 2.12); g.add(sgn);
    var bT = c.canvasTex(128, 512, function(gg){ gg.fillStyle = "#14100a"; gg.fillRect(0, 0, 128, 512); gg.fillStyle = accHex; gg.fillRect(0, 0, 128, 12); gg.fillRect(0, 500, 128, 12);
      gg.save(); gg.translate(64, 256); gg.rotate(-PI/2); gg.textAlign = "center"; gg.fillStyle = accHex; gg.font = "700 50px system-ui, sans-serif"; gg.fillText(c.short(name.toUpperCase(), 14), 0, 4);
      gg.fillStyle = HEX.ink; gg.font = "600 28px ui-monospace, monospace"; gg.fillText("LEVEL " + level, 0, 44); gg.restore(); });
    [-Wd/2 + 0.9, Wd/2 - 0.9].forEach(function(x){ var bn = c.screen(1.2, 4.8, bT.t); bn.material.side = THREE.DoubleSide; bn.position.set(x, Math.min(H - 2.8, 3.6 + 2.6), D/2 + 0.08); g.add(bn); });
    var door = cyl(0.85, 0.85, 2.6, new THREE.MeshStandardMaterial({color: 0xbfe3f5, transparent: true, opacity: 0.35, roughness: 0.05, emissive: new THREE.Color(0xffb866), emissiveIntensity: 0.25}), 0, 1.3, D/2 + 0.2, g, 20);
    var cg = c.glow(accent, 3.5, 0.35); cg.position.set(0, 3.1, D/2 + 2.4); g.add(cg); dyn.glows.push(cg);
    // decor the owner wears
    if(cos.decor === "neon"){
      var nm = new THREE.MeshBasicMaterial({color: accent, toneMapped: false});
      [[-1, -1], [1, -1], [-1, 1], [1, 1]].forEach(function(q){ box(0.16, H, 0.16, nm, q[0]*(Wd/2 + 0.12), H/2, q[1]*(D/2 + 0.12), g, true); });
      for(var nf = 1; nf <= floors; nf += 2) box(Wd + 0.4, 0.08, 0.08, nm, 0, 3.2 + nf*2.4, D/2 + 0.14, g, true);
    } else if(cos.decor === "flags"){
      for(var fi = 0; fi < 4; fi++){ var fx = -5 + fi*3.33; cyl(0.05, 0.05, 3.8, mat(0xb8c4cf, {metalness: 0.6}), fx, 1.9, 6.4, g, 6);
        var fl = box(1, 0.6, 0.03, mat([0xff6b5b, 0x5fd3e6, 0xffb347, 0x6fd38a][fi]), fx + 0.5, 3.4, 6.4, g); fl.userData.wave = fi; dyn.flags.push(fl); }
    } else if(cos.decor === "gnomes"){
      for(var gi = 0; gi < 5; gi++){ var gn = new THREE.Group(); gn.position.set(-5 + gi*2.5, 0, 6.2); g.add(gn);
        cyl(0.22, 0.28, 0.45, mat(0x3a5ea8), 0, 0.22, 0, gn, 10); sph(0.18, mat(0xf1c9a5), 0, 0.58, 0, gn); c.add(new THREE.Mesh(new THREE.ConeGeometry(0.2, 0.45, 10), mat(0xd14a5c)), 0, 0.88, 0, gn); }
    } else if(cos.decor === "fireworks"){
      for(var fw = 0; fw < 6; fw++){ var sp = c.glow([COL.amber, COL.cyan, COL.coral][fw % 3], 1, 0.9); sp.position.set(Math.cos(fw)*2.4, H + 4 + (fw % 3), Math.sin(fw)*2.4); g.add(sp); dyn.glows.push(sp); }
    }
    // the name over the roof, and who is in
    var tag = c.label(c.short(name, 18) + " · Lv " + level, h.isYou ? HEX.amber : (/^#[0-9a-f]{6}$/i.test(cos.frame || "") ? cos.frame : HEX.cyan), 1.1);
    tag.position.set(0, H + 4.6, 0); g.add(tag);
    var sub = c.label((h.isYou ? "You · " : "") + (crew.working | 0) + " working · " + (crew.needs | 0) + " need them", HEX.green, 0.6);
    sub.position.set(0, H + 3.5, 0); g.add(sub);
    var d = {view: h.isYou ? "@lobby" : "visit:" + h.userId, label: name,
             tip: h.isYou ? "Your HQ: go in" : name + ": walk in as a visitor",
             front: new THREE.Vector3(L.door.x, 0, L.door.z), userId: h.userId};
    [door, sgn, body].forEach(function(o){ o.userData.door = d; hits.push(o); }); doors.push(d);
    L.H = H; L.fade = {g: bodyG, on: false};
  }

  function build(){
    var list = (api.city && api.city()) || [];
    var key = JSON.stringify(list.map(function(h){ return [h.userId, h.level, h.look, h.cos, h.crew, !!h.isYou]; }));
    if(key === sig) return; sig = key;
    while(streetG.children.length) streetG.remove(streetG.children[0]);
    hits.length = 0; doors.length = 0; lampGlows.length = 0; cars.length = 0;
    dyn = {facMats: [], glows: [], beacons: [], flags: [], leds: []};
    city = layout(list);
    var R = city.R, OUT = R + 30;
    var gm = new THREE.MeshStandardMaterial({map: grassT.t, roughness: 0.95}); grassT.t.repeat.set(OUT/6, OUT/6);
    floor = flat(new THREE.CircleGeometry(OUT, 96), gm, 0);
    flat(new THREE.RingGeometry(R - 3, R + 3, 128), mat(0x2a2f36, {roughness: 0.9}), 0.03);
    [R - 3.1, R + 3.1].forEach(function(r){ flat(new THREE.RingGeometry(r - 0.12, r + 0.12, 128), mat(0x8e9aa6), 0.04); });
    var nd = Math.floor(2*PI*R/2.6), dash = new THREE.InstancedMesh(new THREE.BoxGeometry(1.2, 0.02, 0.14), new THREE.MeshBasicMaterial({color: 0xffc86e, toneMapped: false}), nd);
    var m4 = new THREE.Matrix4(), q = new THREE.Quaternion(), up = new THREE.Vector3(0, 1, 0);
    for(var i = 0; i < nd; i++){ var a = i/nd*PI*2; q.setFromAxisAngle(up, -a + PI/2); m4.compose(new THREE.Vector3(Math.cos(a)*R, 0.05, Math.sin(a)*R), q, new THREE.Vector3(1, 1, 1)); dash.setMatrixAt(i, m4); }
    streetG.add(dash);
    paveT.t.repeat.set(R/5, R/5);
    flat(new THREE.CircleGeometry(R - 3.3, 96), new THREE.MeshStandardMaterial({map: paveT.t, roughness: 0.9}), 0.025);
    flat(new THREE.RingGeometry(R + 3.3, R + 6, 128), new THREE.MeshStandardMaterial({map: paveT.t, roughness: 0.9}), 0.025);
    // the plaza in the middle: a fountain and the city's name
    var fg = new THREE.Group(); streetG.add(fg);
    cyl(3.2, 3.3, 0.6, mat(0x9aa7b5, {roughness: 0.6}), 0, 0.3, 0, fg, 36);
    cyl(3, 3, 0.05, new THREE.MeshStandardMaterial({color: 0x2a7fa8, emissive: new THREE.Color(COL.cyan), emissiveIntensity: 0.35, transparent: true, opacity: 0.85}), 0, 0.55, 0, fg, 36);
    cyl(0.3, 0.4, 2.4, mat(0x9aa7b5), 0, 1.4, 0, fg, 12);
    var cityL = c.label("Arena City · " + city.lots.length + " HQ" + (city.lots.length === 1 ? "" : "s"), HEX.amber, 1.3); cityL.position.set(0, 5, 0); streetG.add(cityL);
    var tr = c.rng(77);
    for(var p = 0; p < 12; p++){ var pa = p/12*PI*2, px = Math.cos(pa)*(R - 8), pz = Math.sin(pa)*(R - 8); if(R - 8 < 5) break;
      var tg = new THREE.Group(); tg.position.set(px, 0, pz); streetG.add(tg); cyl(0.2, 0.28, 1.2, mat(0x5a3d2a), 0, 0.6, 0, tg, 8); sph(1.2, mat(0x3c8a4f, {roughness: 0.9}), 0, 2.1, 0, tg); }
    function lamp(x, z){ cyl(0.07, 0.1, 3.4, mat(0x2b3a48, {metalness: 0.6}), x, 1.7, z, streetG, 8); sph(0.16, emis(0xfff1d6, 0xffd9a0, 2), x, 3.3, z, streetG);
      var gl = c.glow(0xffd9a0, 2.2, 0.8); gl.position.set(x, 3.25, z); streetG.add(gl); lampGlows.push(gl); }
    var nl = Math.max(10, Math.floor(2*PI*R/9));
    for(var l = 0; l < nl; l++){ var la = (l + 0.5)/nl*PI*2; lamp(Math.cos(la)*(R - 3.8), Math.sin(la)*(R - 3.8)); }
    // trees behind the lots
    for(var t = 0; t < Math.min(160, city.lots.length*5 + 30); t++){
      var ta = tr()*PI*2, trr = R + 21 + tr()*8, tx = Math.cos(ta)*trr, tz = Math.sin(ta)*trr;
      var tgg = new THREE.Group(); tgg.position.set(tx, 0, tz); tgg.scale.setScalar(0.8 + tr()*0.6); streetG.add(tgg);
      cyl(0.2, 0.28, 1.2, mat(0x5a3d2a), 0, 0.6, 0, tgg, 8);
      for(var cn = 0; cn < 3; cn++) c.add(new THREE.Mesh(new THREE.ConeGeometry(1.3 - cn*0.3, 1.6, 8), mat([0x2f6b45, 0x2a5f3d, 0x357a4f][cn])), 0, 1.6 + cn*0.9, 0, tgg);
    }
    // cars round the street
    [[0xd14a5c, 0.25], [0x4a7bd1, -0.2], [0xe0e4e8, 0.22], [0xffb347, -0.18], [0x3fa66a, 0.2], [0x8a4ad1, -0.24]].forEach(function(cd, n){
      var k = new THREE.Group(), bodyM = mat(cd[0], {metalness: 0.6, roughness: 0.3});
      box(1.9, 0.45, 0.95, bodyM, 0, 0.42, 0, k); box(1.0, 0.42, 0.85, mat(0x0b1622, {metalness: 0.6, roughness: 0.15}), -0.1, 0.82, 0, k);
      streetG.add(k); cars.push({g: k, a: n/6*PI*2, v: cd[1]*24/R, r: R + (cd[1] > 0 ? -1.4 : 1.4)});
    });
    city.lots.forEach(building);
    w.floor = floor; w.bounds = [-OUT + 2, OUT - 2, -OUT + 2, OUT - 2];
    // arriving: at your own door, or the door of the HQ you just visited
    var mine = city.lots.filter(function(L){ return L.h.isYou; })[0];
    var back = api.cityReturn && api.cityReturn(), ret = city.lots.filter(function(L){ return L.h.userId === back; })[0];
    // the camera stands on the street side, looking at the building's front (a little off-axis)
    function at(L){ return L ? {x: L.door.x + L.dx*2.6, z: L.door.z + L.dz*2.6, yaw: Math.atan2(L.dx, L.dz), camYaw: L.rot + 0.55} : {x: 0, z: R - 6, yaw: PI}; }
    w.spawn = at(ret || mine); w.spawnFrom = {lobby: at(mine)};
    applyTime();
  }

  function applyTime(){
    dyn.facMats.forEach(function(m){ m.emissiveIntensity = night ? 1 : 0.06; });
    dyn.glows.forEach(function(g){ g.visible = night; });
    lampGlows.forEach(function(g){ g.material.opacity = night ? 0.85 : 0.08; });
  }
  function blocked(x, z){
    var R = city.R;
    if(Math.hypot(x, z) > R + 27) return true;
    if(Math.hypot(x, z) < 3.6) return true;                       // the fountain
    for(var i = 0; i < city.lots.length; i++){
      var L = city.lots[i], rx = x - L.x, rz = z - L.z, c0 = Math.cos(-L.rot), s0 = Math.sin(-L.rot);
      var lx = rx*c0 + rz*s0, lz = -rx*s0 + rz*c0;              // into the lot's own frame
      if(Math.abs(lx) < 4.4 && Math.abs(lz) < 3.9) return true;
      if(L.h.level >= 30 && lx < -4 && lx > -9.2 && Math.abs(lz + 0.6) < 2.9) return true;   // the wing
    }
    return false;
  }

  build();
  w.hits = hits; w.doors = doors; w.span = 18; w.zoom = 0.8; w.camY = 2.5; w.follow = 1; w.camPitch = 0.72;
  w.blocked = blocked;
  w.onCity = function(){ build(); };
  w.setTime = function(n){ night = n; S.background = n ? skyBg.night : skyBg.day; S.fog = new THREE.Fog(n ? 0x0f1f30 : 0xb8dcf2, 90, 220);
    hemi.intensity = n ? 1.3 : 2.4; sun.intensity = n ? 0.7 : 2.4; sun.color.set(n ? 0xa9b8ff : 0xfff2dc);
    var sc = sun.shadow.camera, R = city.R + 30; sc.left = -R; sc.right = R; sc.top = R; sc.bottom = -R; sc.far = 260; sc.updateProjectionMatrix(); applyTime(); };
  w.onLook = function(){ sig = null; build(); };
  // A building between you and the camera fades, so you are never lost behind a tower.
  function fade(L, on){
    if(L.fade.on === on) return; L.fade.on = on;
    L.fade.g.traverse(function(o){ if(!o.isMesh) return; (Array.isArray(o.material) ? o.material : [o.material]).forEach(function(m){
      if(m.userData.op == null){ m.userData.op = m.opacity; m.userData.tr = m.transparent; }
      m.transparent = on || m.userData.tr; m.opacity = on ? 0.16 : m.userData.op; m.depthWrite = !on; m.needsUpdate = true; }); o.castShadow = !on; });
  }
  var fadeAcc = 0;
  function cutaway(){
    var me = c.avatar(), v = c.view && c.view(); if(!me || !v) return;
    var ux = Math.sin(v.yaw), uz = Math.cos(v.yaw), tp = Math.max(0.2, Math.tan(v.pitch));
    city.lots.forEach(function(L){
      if(!L.fade) return;
      var vx = L.x - me.x, vz = L.z - me.z, along = vx*ux + vz*uz, side = Math.abs(vx*uz - vz*ux);
      fade(L, along > 2 && side < 7.5 && along < L.H/tp + 6);
    });
  }
  w.update = function(t, dt, k){
    fadeAcc += dt; if(fadeAcc > 0.15){ fadeAcc = 0; cutaway(); }
    dyn.beacons.forEach(function(b, n){ b.material.emissiveIntensity = ((t + n*0.37) % 1.4) < 0.25 ? 3 : 0.4; });
    dyn.flags.forEach(function(f){ f.rotation.y = Math.sin(t*2.4 + f.userData.wave)*0.35*k; });
    cars.forEach(function(cr){ cr.a += cr.v*dt*k; var x = Math.cos(cr.a)*cr.r, z = Math.sin(cr.a)*cr.r, dx = -Math.sin(cr.a)*cr.v, dz = Math.cos(cr.a)*cr.v;
      cr.g.position.set(x, 0, z); cr.g.rotation.y = Math.atan2(-dz, dx); });
  };
  return w;
};
})();
