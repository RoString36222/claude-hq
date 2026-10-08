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

var MAX_LOTS = 12;          // an Arena has a handful of members (5 today); room to spare
var LOT_ARC = 36;           // street frontage per building: a whole campus with both wings (m)

// The street's layout from the list: who stands where. Pure, so it is easy to test.
function layout(list){
  var hs = (list || []).filter(function(h){ return h && typeof h.userId === "string"; })
    .sort(function(a, b){ return a.userId < b.userId ? -1 : a.userId > b.userId ? 1 : 0; });
  if(hs.length > MAX_LOTS){
    var you = hs.filter(function(h){ return h.isYou; });
    hs = hs.filter(function(h){ return !h.isYou; }).slice(0, MAX_LOTS - you.length).concat(you)
      .sort(function(a, b){ return a.userId < b.userId ? -1 : 1; });
  }
  var n = Math.max(1, hs.length), R = Math.max(30, n*LOT_ARC/(2*Math.PI));
  return {R: R, lots: hs.map(function(h, i){
    var a = i/n*Math.PI*2 + Math.PI/2, rb = R + 13, dx = -Math.cos(a), dz = -Math.sin(a);   // dx/dz: towards the middle
    return {h: h, a: a, x: Math.cos(a)*rb, z: Math.sin(a)*rb, rot: Math.atan2(dx, dz), dx: dx, dz: dz,
            door: {x: Math.cos(a)*(rb - 4.8), z: Math.sin(a)*(rb - 4.8)}};      // under the canopy
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

  // one HQ on its lot: the same building as that HQ's own Base (games/hqbase.js), front facing the middle
  var lotsB = [];
  function building(L){
    var h = L.h, cos = h.cos || {}, crew = h.crew || {}, name = nameOf(h);
    var g = new THREE.Group(); g.position.set(L.x, 0, L.z); g.rotation.y = L.rot; streetG.add(g);
    var pad = new THREE.Mesh(new THREE.PlaneGeometry(30, 15), new THREE.MeshStandardMaterial({map: paveT.t, roughness: 0.9}));
    pad.rotation.x = -PI/2; pad.position.set(0, 0.02, 1.5); pad.receiveShadow = true; g.add(pad);
    if(h.isYou){ var ring = new THREE.Mesh(new THREE.RingGeometry(14.6, 15.1, 64), new THREE.MeshBasicMaterial({color: COL.amber, transparent: true, opacity: 0.5, toneMapped: false}));
      ring.rotation.x = -PI/2; ring.position.set(0, 0.04, 0.5); ring.scale.y = 0.45; g.add(ring); }
    var B = HQV.hqBuilding(c, {
      level: function(){ return Math.max(1, h.level | 0); },
      look: function(){ return Object.assign({}, h.look || {}, {sign: name, decor: cos.decor}); },
      live: function(){ return (crew.working | 0) + (crew.needs | 0); },
      campus: false,
      door: {view: h.isYou ? "@lobby" : "visit:" + h.userId, label: name, userId: h.userId,
             tip: h.isYou ? "Your HQ: go in" : name + ": walk in as a visitor"},
      doorFront: function(){ return new THREE.Vector3(L.door.x, 0, L.door.z); }
    });
    g.add(B.g); B.setLive((crew.working | 0) + (crew.needs | 0)); B.setNight(night);
    var sub = c.label((h.isYou ? "You · " : "") + (crew.working | 0) + " working · " + (crew.needs | 0) + " need them", HEX.green, 0.7);
    sub.position.set(0, B.top() + 5.6, 0); g.add(sub);
    B.hits.forEach(function(o){ hits.push(o); }); B.doors.forEach(function(d){ doors.push(d); });
    L.B = B; L.H = B.top() + 2; L.fade = {g: B.g, on: false}; lotsB.push(B);
  }

  function build(){
    var list = (api.city && api.city()) || [];
    var key = JSON.stringify(list.map(function(h){ return [h.userId, h.level, h.look, h.cos, h.crew, !!h.isYou]; }));
    if(key === sig) return; sig = key;
    while(streetG.children.length) streetG.remove(streetG.children[0]);
    hits.length = 0; doors.length = 0; lampGlows.length = 0; cars.length = 0; lotsB.length = 0;
    dyn = {facMats: [], glows: [], beacons: [], flags: [], leds: []};
    city = layout(list);
    var R = city.R, OUT = R + 34;
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
      var ta = tr()*PI*2, trr = R + 24 + tr()*8, tx = Math.cos(ta)*trr, tz = Math.sin(ta)*trr;
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
    lotsB.forEach(function(B){ B.setNight(night); });
    lampGlows.forEach(function(g){ g.material.opacity = night ? 0.85 : 0.08; });
  }
  function blocked(x, z){
    var R = city.R;
    if(Math.hypot(x, z) > R + 31) return true;
    if(Math.hypot(x, z) < 3.6) return true;                       // the fountain
    for(var i = 0; i < city.lots.length; i++){
      var L = city.lots[i], rx = x - L.x, rz = z - L.z, c0 = Math.cos(-L.rot), s0 = Math.sin(-L.rot);
      var lx = rx*c0 + rz*s0, lz = -rx*s0 + rz*c0;              // into the lot's own frame
      if(L.B && L.B.blockedLocal(lx, lz)) return true;
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
      fade(L, along > 2 && side < 14 && along < L.H/tp + 8);
    });
  }
  w.update = function(t, dt, k){
    fadeAcc += dt; if(fadeAcc > 0.15){ fadeAcc = 0; cutaway(); }
    lotsB.forEach(function(B){ B.animate(t, dt, k); });
    cars.forEach(function(cr){ cr.a += cr.v*dt*k; var x = Math.cos(cr.a)*cr.r, z = Math.sin(cr.a)*cr.r, dx = -Math.sin(cr.a)*cr.v, dz = Math.cos(cr.a)*cr.v;
      cr.g.position.set(x, 0, z); cr.g.rotation.y = Math.atan2(-dz, dx); });
  };
  return w;
};
})();
