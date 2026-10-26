/* Claude HQ: City play, collectibles and the photo hunt (HQ 3.22). Registers with HQV.cityPlay (games/cityplay.js).
 *
 * About fifty finds per world, a pure function of (W, its seed); nothing a player sees twice is random:
 *   roof     tokens over low roofs (1-3 floors): fly a helicopter through them, or reach them off a stunt (touch)
 *   tag      graffiti on the side and back walls of buildings, mostly in the industrial streets: stand by one and press
 *            E to tag it with your colour
 *   stall    rare street stalls, each with its own name, by the footpaths in the parks: visit one
 *   hidden   tokens tucked under bridges, by the water and in the parks (touch)
 * Tokens glow (unlit gold, static); within SPARKLE_M a sparkle turns over the nearest (Calm: it holds still).
 *
 * Photo hunt: five challenges a week (Monday to Sunday, local time): the Sunday parade, the street market
 * (Wednesday, Saturday), the week's landmark, the busker, the stadium crowd on Saturday. Take a photo with the phone's
 * camera (games/hqgallery.js emits "photo" {x, y, z, yaw, pitch, fov, aspect}); it counts when the target is on now and
 * in frame (within PHOTO_M, inside the camera's field of view).
 *
 * Store (ctx.store, this browser only): "finds:<seed>" {id: 1}, "finds:<seed>:photos:<week>" {challenge id: 1}.
 * Feature (HQV.cityPlay.live().feature("finds")): list() -> [find + {got}], progress(ms) -> {finds, total, photos,
 *   photosTotal}, challenges(ms) -> [{id, name, when, on, done}], hint() (a waypoint near the nearest one left).
 * Emits ctx.emit("find", {id, kind, n, total}) (kind "photo" for a challenge done).
 * Pure (node-tested, tests/test_play_finds.py): HQV.playFinds = {finds, challenges, targets, judge, week, PHOTO_M, ...}.
 * A phone app "Finds" shows progress and this week's photo challenges. Nothing leaves the machine.
 */
(function(){
"use strict";
var root = typeof window !== "undefined" ? window : self;
var HQV = root.HQV = root.HQV || {};
function WQ(){ return HQV.world; }

var COUNTS = {roof: 12, tag: 16, stall: 6, hidden: 16};
var FLOOR_H = 3.5;
var TOUCH_M = 2.6, ROOF_M = 5, VISIT_M = 5, TAG_M = 4, SPARKLE_M = 15, PHOTO_M = 60;
var DAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

function cm(v){ return (+v || 0)/100; }
function hashStr(s){ var h = 2166136261 >>> 0; s = String(s == null ? "" : s); for(var i = 0; i < s.length; i++){ h ^= s.charCodeAt(i); h = Math.imul(h, 16777619) >>> 0; } return h >>> 0; }
function mulberry32(a){ a = a >>> 0; return function(){ a = (a + 0x6D2B79F5) >>> 0; var t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0)/4294967296; }; }
function wrapA(a){ a = +a || 0; while(a > Math.PI) a -= 2*Math.PI; while(a < -Math.PI) a += 2*Math.PI; return a; }
function shuffle(a, rnd){ for(var i = a.length - 1; i > 0; i--){ var j = Math.floor(rnd()*(i + 1)), t = a[i]; a[i] = a[j]; a[j] = t; } return a; }
function hourOf(ms){ return (((ms % 864e5) + 864e5) % 864e5)/36e5; }
function weekday(ms){ return ((Math.floor(ms/864e5) % 7) + 7 + 4) % 7; }
function week(ms){ return Math.floor((Math.floor(ms/864e5) + 3)/7); }      // Monday to Sunday (citylife's roadworks week)

/* ---------- where things can stand ---------- */
function ground(W, x, z){ var Q = WQ(); return Q.groundAt ? Q.groundAt(W, x, z) : 0; }
// open ground: off roads, pavements, water, lots and sites, not in a building or a tree
function openAt(W, x, z){
  var Q = WQ(), s = Q.surfaceAt(W, x, z);
  if(s !== "grass" && s !== "park" && s !== "forest") return false;
  return !Q.blockedAt(W, x, z);
}
function waterNear(W, x, z, r){
  var Q = WQ();
  for(var k = 0; k < 8; k++){ var a = k*Math.PI/4; if(Q.surfaceAt(W, x + Math.sin(a)*r, z + Math.cos(a)*r) === "water") return true; }
  return false;
}
function farFrom(list, x, z, d){ for(var i = 0; i < list.length; i++) if(Math.hypot(list[i].x - x, list[i].z - z) < d) return false; return true; }
// a building lot's box: centre o, front F, half sizes hu (across) and hv (deep); world point of lot (u, v)
function boxOf(lot){
  var fp = HQV.worldgeom && HQV.worldgeom.footprint && (lot.poly || lot.front) ? HQV.worldgeom.footprint(lot) : null;
  if(fp && fp.hu > 0 && fp.hv > 0) return fp;
  var R = WQ().buildingRect(lot);
  return {o: {x: (R.x0 + R.x1)/2, z: (R.z0 + R.z1)/2}, F: {x: 0, z: 1}, hu: (R.x1 - R.x0)/2, hv: (R.z1 - R.z0)/2};
}
function wx(B, u, v){ return {x: B.o.x + u*B.F.z + v*B.F.x, z: B.o.z - u*B.F.x + v*B.F.z}; }

/* ---------- the finds ---------- */
var ADJ = ["Moonlit", "Velvet", "Copper", "Lucky", "Midnight", "Tiny", "Golden", "Wandering", "Secret", "Sleepy", "Crooked", "Humble"];
var FOOD = ["Dumpling", "Noodle", "Waffle", "Pickle", "Lemonade", "Pretzel", "Crepe", "Bao", "Churro", "Falafel", "Mochi", "Toastie"];
var SHOP = ["Cart", "Stand", "Hatch", "Kiosk", "Wagon", "Barrow"];
var MEMO = typeof WeakMap === "function" ? new WeakMap() : null;
function finds(W, seed){
  if(!W) return [];
  var memo = MEMO && MEMO.get(W), key = String(seed);
  if(memo && memo[key]) return memo[key];
  var Q = WQ(), rnd = mulberry32(hashStr("finds:" + seed)), out = [], half = W.half || 1000;
  var U = HQV.cityLife && HQV.cityLife.landUse ? HQV.cityLife.landUse(W) : {};
  var blds = (W.lots || []).filter(function(l){ return l.kind === "building" && l.min_tier == null; });
  if(!blds.length) blds = (W.lots || []).filter(function(l){ return l.kind === "building"; });
  blds = blds.slice().sort(function(a, b){ return a.id - b.id; });
  // roof tokens: over low roofs
  var roofs = [];
  shuffle(blds.filter(function(l){ var f = l.floors | 0; return f >= 1 && f <= 3; }), rnd).forEach(function(l){
    if(roofs.length >= COUNTS.roof) return;
    var B = boxOf(l);
    if(B.hu < 3 || B.hv < 3 || !farFrom(roofs, B.o.x, B.o.z, 60)) return;
    var y = ground(W, B.o.x, B.o.z) + Math.max(1, l.floors | 0)*FLOOR_H + 1.6;
    roofs.push({id: "roof:" + l.id, kind: "roof", how: "touch", x: +B.o.x.toFixed(2), y: +y.toFixed(2), z: +B.o.z.toFixed(2), lot: l.id, hint: "on a low roof"});
  });
  // graffiti: side and back walls, mostly industrial
  var tags = [], weighted = [];
  blds.forEach(function(l){ var u = U[l.id], gp = u ? u.group : ""; weighted.push({l: l, w: (gp === "industry" ? 5 : gp === "work" ? 1.2 : 1)*rnd()}); });
  weighted.sort(function(a, b){ return b.w - a.w; });
  weighted.forEach(function(it){
    if(tags.length >= COUNTS.tag) return;
    var l = it.l, B = boxOf(l);
    var walls = shuffle([{u: 0, v: -1, n: -1, ax: "v"}, {u: 1, v: 0, ax: "u"}, {u: -1, v: 0, ax: "u"}], rnd);
    for(var k = 0; k < walls.length; k++){
      var wl = walls[k], width = wl.ax === "v" ? 2*B.hu : 2*B.hv;
      if(width < 5) continue;
      var nu = wl.u, nv = wl.v, n = {x: nu*B.F.z + nv*B.F.x, z: -nu*B.F.x + nv*B.F.z};
      var p = wx(B, nu*(B.hu + 0.06), nv*(B.hv + 0.06)), sp = {x: p.x + n.x*1.6, z: p.z + n.z*1.6};
      var s1 = Q.surfaceAt(W, p.x, p.z), s2 = Q.surfaceAt(W, sp.x, sp.z);
      if(s1 === "road" || s1 === "water" || s2 === "road" || s2 === "water" || s2 === "edge" || Q.blockedAt(W, p.x, p.z) || Q.blockedAt(W, sp.x, sp.z)) continue;
      if(!farFrom(tags, p.x, p.z, 40)) continue;
      var u = U[l.id];
      tags.push({id: "tag:" + l.id, kind: "tag", how: "tag", x: +p.x.toFixed(2), y: +(ground(W, sp.x, sp.z) + 2.3).toFixed(2), z: +p.z.toFixed(2), yaw: +Math.atan2(n.x, n.z).toFixed(3),
        w: +Math.min(3.4, width*0.55).toFixed(2), stand: {x: +sp.x.toFixed(2), z: +sp.z.toFixed(2)}, lot: l.id, group: u ? u.group : "", hint: u && u.group === "industry" ? "on a wall in the industrial streets" : "on a side wall"});
      break;
    }
  });
  // rare street stalls: just off the footpaths, in the parks (else on any open ground by a quiet street)
  var stalls = [], cands = [], names = {};
  (W.edges || []).slice().sort(function(a, b){ return a.id - b.id; }).forEach(function(e){
    var kind = HQV.cityLife ? HQV.cityLife.road(e.cls).kind : "res";
    if(kind === "fast" || e.bridge) return;
    var p = e.pts || [], P = [];
    for(var i = 0; i + 2 < p.length; i += 3) P.push({x: p[i]/100, z: p[i + 2]/100});
    for(i = 1; i < P.length; i++){
      var a = P[i - 1], b = P[i], L = Math.hypot(b.x - a.x, b.z - a.z);
      if(L < 4) continue;
      var dx = (b.x - a.x)/L, dz = (b.z - a.z)/L, off = cm(e.width)/2 + 2.6;
      for(var s = L/2; s < L; s += 30) [1, -1].forEach(function(sg){
        var x = a.x + dx*s + dz*off*sg, z = a.z + dz*s - dx*off*sg;
        if(!openAt(W, x, z) || !openAt(W, x + dz*1.2*sg, z - dx*1.2*sg)) return;
        var d = Q.districtAt(W, x, z).name;
        cands.push({x: x, z: z, yaw: Math.atan2(-dz*sg, dx*sg), park: d === "park" || d === "forest", r: rnd()});
      });
    }
  });
  cands.sort(function(a, b){ return (b.park ? 1 : 0) - (a.park ? 1 : 0) || a.r - b.r; });
  cands.forEach(function(c){
    if(stalls.length >= COUNTS.stall || !farFrom(stalls, c.x, c.z, 120)) return;
    var nm = null;
    for(var t = 0; t < 20 && (!nm || names[nm]); t++) nm = "The " + ADJ[Math.floor(rnd()*ADJ.length)] + " " + FOOD[Math.floor(rnd()*FOOD.length)] + " " + SHOP[Math.floor(rnd()*SHOP.length)];
    names[nm] = true;
    stalls.push({id: "stall:" + Math.round(c.x) + "," + Math.round(c.z), kind: "stall", how: "visit", x: +c.x.toFixed(2), z: +c.z.toFixed(2), yaw: +c.yaw.toFixed(3), name: nm, hint: c.park ? "in a park" : "by a quiet street"});
  });
  // hidden tokens: under bridges first, then by the water and in the parks
  var hid = [];
  (W.edges || []).filter(function(e){ return e.bridge; }).sort(function(a, b){ return a.id - b.id; }).forEach(function(e){
    var p = e.pts || [], best = null;
    for(var i = 0; i + 5 < p.length; i += 3){
      var ax = p[i]/100, az = p[i + 2]/100, bx = p[i + 3]/100, bz = p[i + 5]/100, L = Math.hypot(bx - ax, bz - az) || 1, dx = (bx - ax)/L, dz = (bz - az)/L;
      for(var s = 0; s <= L; s += 8) [1, -1].forEach(function(sg){
        [cm(e.width)/2 + 3, cm(e.width)/2 + 7].forEach(function(off){
          var x = ax + dx*s + dz*off*sg, z = az + dz*s - dx*off*sg;
          if(best || !openAt(W, x, z) || !waterNear(W, x, z, 8)) return;
          best = {x: x, z: z};
        });
      });
    }
    if(best && hid.length < 4 && farFrom(hid, best.x, best.z, 60)) hid.push({id: "hidden:" + Math.round(best.x) + "," + Math.round(best.z), kind: "hidden", how: "touch", x: +best.x.toFixed(2), z: +best.z.toFixed(2), hint: "under a bridge"});
  });
  for(var tries = 0; tries < 6000 && hid.length < COUNTS.hidden; tries++){
    var x = (rnd()*2 - 1)*half*0.95, z = (rnd()*2 - 1)*half*0.95, late = tries > 3000;
    if(!openAt(W, x, z) || !farFrom(hid, x, z, 70)) continue;
    var dn = Q.districtAt(W, x, z).name, park = dn === "park" || dn === "forest", wet = waterNear(W, x, z, 7);
    if(!park && !wet && !late) continue;
    hid.push({id: "hidden:" + Math.round(x) + "," + Math.round(z), kind: "hidden", how: "touch", x: +x.toFixed(2), z: +z.toFixed(2), hint: wet ? "by the water" : park ? "in a park" : "somewhere quiet"});
  }
  out = roofs.concat(tags, stalls, hid);
  out.forEach(function(f){ if(f.y == null) f.y = +(ground(W, f.x, f.z) + 0.6).toFixed(2); });
  if(MEMO){ if(!memo){ memo = {}; MEMO.set(W, memo); } memo[key] = out; }
  return out;
}

/* ---------- the photo hunt ---------- */
var LANDMARK = {townhall: "the town hall", library: "the library", stadium: "the stadium", hospital: "the hospital", university: "the university",
  museum: "the museum", mall: "the mall", fountain: "the fountain", police: "the police station", fire: "the fire station", bank: "the bank",
  post: "the post office", campus: "the campus", studio: "the studios", airport: "the airport", harbour: "the harbour"};
function site(W, kind){ var s = (W.sites || []).filter(function(x){ return x.kind === kind; })[0]; return s ? {x: cm(s.x), z: cm(s.z), y: cm(s.y)} : null; }
function busker(W){
  var H = HQV.cityLife && HQV.cityLife.hotspots ? HQV.cityLife.hotspots(W) : [], b = null;
  ["linger", "terrace", "wait"].forEach(function(k){ if(!b) b = H.filter(function(s){ return s.kind === k; })[0] || null; });
  if(!b){ var f = site(W, "fountain"); if(f) b = {x: f.x + 6, z: f.z}; }
  return b ? {x: +(b.x + 2).toFixed(2), z: +b.z.toFixed(2)} : null;
}
function landmarkOf(W, seed, wk){
  var L = (W.sites || []).filter(function(s){ return LANDMARK[s.kind]; }).sort(function(a, b){ return a.id < b.id ? -1 : a.id > b.id ? 1 : 0; });
  if(!L.length) return null;
  var s = L[hashStr(seed + ":landmark:" + wk) % L.length];
  return {kind: s.kind, name: LANDMARK[s.kind], x: cm(s.x), z: cm(s.z)};
}
// the week's challenges (the ones this world has): {id, name, when}
function challenges(W, seed, ms){
  if(!W) return [];
  var out = [], wk = week(ms), ev = HQV.cityLife && HQV.cityLife.events;
  if(ev && (W.edges || []).some(function(e){ return HQV.cityLife.road(e.cls).kind === "main"; })) out.push({id: "parade", name: "Photograph the parade", when: "Sunday 15:00-16:30"});
  if(site(W, "market")) out.push({id: "market", name: "Photograph the street market", when: "Wednesday and Saturday 07:00-14:00"});
  var lm = landmarkOf(W, seed, wk);
  if(lm) out.push({id: "landmark:" + lm.kind, name: "Photograph " + lm.name, when: "Any time this week"});
  if(busker(W)) out.push({id: "busker", name: "Photograph the busker", when: "Every day 10:00-20:00"});
  if(site(W, "stadium")) out.push({id: "stadium", name: "Photograph the stadium crowd", when: "Saturday 15:30-17:10"});
  return out;
}
// what to photograph for challenge id at local ms: [{x, y, z}] (empty: not on now)
function targets(W, seed, id, ms){
  var L = HQV.cityLife, Q = WQ(), out = [];
  function at(x, z, up){ out.push({x: x, y: ground(W, x, z) + (up || 1.6), z: z}); }
  if(id === "parade" || id === "market"){
    if(!L || !L.events) return out;
    L.events(W, ms).forEach(function(e){
      if(e.kind !== id) return;
      if(e.at) at(e.at.x, e.at.z);
      e.edges.forEach(function(eid){
        var E = (W.edges || []).filter(function(x){ return x.id === eid; })[0], p = E ? E.pts : [];
        for(var i = 0; p && i + 2 < p.length; i += 3) at(p[i]/100, p[i + 2]/100);
      });
    });
    return out;
  }
  if(id === "busker"){ var h = hourOf(ms), b = busker(W); if(b && h >= 10 && h < 20) at(b.x, b.z); return out; }
  if(id === "stadium"){
    var s = site(W, "stadium");
    if(s && weekday(ms) === 6 && hourOf(ms) >= 15.5 && hourOf(ms) < 17.2) at(s.x, s.z, 6);
    return out;
  }
  if(id.indexOf("landmark:") === 0){
    var lm = landmarkOf(W, seed, week(ms));
    if(lm && "landmark:" + lm.kind === id) at(lm.x, lm.z, 8);
    return out;
  }
  return out;
}
// is target t in a photo taken from pose {x, y?, z, yaw, pitch?, fov? (vertical, degrees), aspect?}
function judge(pose, t, maxM){
  if(!pose || !t) return false;
  var dx = t.x - pose.x, dz = t.z - pose.z, d = Math.hypot(dx, dz);
  if(!(d <= (maxM || PHOTO_M)) || d < 0.5) return false;
  var vf = Math.max(10, Math.min(120, +pose.fov || 50))*Math.PI/180, asp = Math.max(0.3, Math.min(4, +pose.aspect || 1.5));
  var hf = 2*Math.atan(Math.tan(vf/2)*asp);
  if(Math.abs(wrapA(Math.atan2(dx, dz) - (+pose.yaw || 0))) > hf/2) return false;
  if(pose.pitch != null && pose.y != null && t.y != null){
    var el = Math.atan2(t.y - pose.y, d);
    if(Math.abs(el - (+pose.pitch || 0)) > vf/2 + 0.05) return false;
  }
  return true;
}

/* ---------- the feature ---------- */
function create(ctx){
  var W = ctx.W, THREE = ctx.THREE, S = ctx.scene, seed = ctx.seed;
  var F = finds(W, seed), byId = {}, K = "finds:" + seed;
  F.forEach(function(f){ byId[f.id] = f; });
  var got = ctx.store.get(K, {}); if(!got || typeof got !== "object") got = {};
  var me = null, mo = null, lastLocal = 0, clock = 0;
  var g = null, tokIM = null, tokIdx = {}, tagMats = {}, sparkle = null, buskerG = null, stallG = [];
  var MYCOL = 0xff4fa3;

  function wkKey(ms){ return K + ":photos:" + week(ms); }
  function photosDone(ms){ var o = ctx.store.get(wkKey(ms), {}); return o && typeof o === "object" ? o : {}; }
  function nGot(){ var n = 0; F.forEach(function(f){ if(got[f.id]) n++; }); return n; }

  if(THREE && S){
    g = new THREE.Group(); g.name = "cityplay-finds"; S.add(g);
    var toks = F.filter(function(f){ return f.how === "touch"; });
    tokIM = new THREE.InstancedMesh(new THREE.CylinderGeometry(0.45, 0.45, 0.1, 20), new THREE.MeshBasicMaterial({color: 0xffc83d}), Math.max(1, toks.length));
    toks.forEach(function(f, i){ tokIdx[f.id] = i; });
    tokIM.count = toks.length; g.add(tokIM);
    // graffiti: a seeded spray texture each
    F.filter(function(f){ return f.kind === "tag"; }).forEach(function(f){
      var r = mulberry32(hashStr(f.id + ":" + seed)), w = 32, h = 12, px = new Uint8Array(w*h*4);
      var cols = [[255, 90, 60], [80, 200, 255], [250, 230, 70], [160, 255, 120], [230, 120, 255]], c1 = cols[Math.floor(r()*cols.length)], c2 = cols[Math.floor(r()*cols.length)];
      for(var s = 0; s < 7; s++){
        var cx = 3 + r()*26, cy = 2 + r()*8, rx = 2 + r()*4, ry = 1.5 + r()*3, c = s % 2 ? c1 : c2;
        for(var y = 0; y < h; y++) for(var x = 0; x < w; x++){
          var q = ((x - cx)/rx)*((x - cx)/rx) + ((y - cy)/ry)*((y - cy)/ry);
          if(q < 1){ var k = 4*(y*w + x); px[k] = c[0]; px[k + 1] = c[1]; px[k + 2] = c[2]; px[k + 3] = q > 0.7 ? 255 : 230; }
        }
      }
      var tex = new THREE.DataTexture(px, w, h, THREE.RGBAFormat); tex.needsUpdate = true;
      var m = new THREE.MeshBasicMaterial({map: tex, transparent: true, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -2});
      var mesh = new THREE.Mesh(new THREE.PlaneGeometry(f.w, f.w*0.4), m);
      mesh.position.set(f.x, f.y, f.z); mesh.rotation.set(0, f.yaw, 0); g.add(mesh);
      tagMats[f.id] = m;
    });
    // the stalls: a counter and a striped awning
    F.filter(function(f){ return f.kind === "stall"; }).forEach(function(f){
      var r = mulberry32(hashStr(f.name)), hue = r(), gs = new THREE.Group(), gy = ctx.groundY(f.x, f.z);
      var col = new THREE.Color().setHSL(hue, 0.6, 0.55);
      var counter = new THREE.Mesh(new THREE.BoxGeometry(2.2, 1, 1), new THREE.MeshLambertMaterial({color: 0x7a5534})); counter.position.y = 0.5; gs.add(counter);
      var awn = new THREE.Mesh(new THREE.BoxGeometry(2.6, 0.12, 1.5), new THREE.MeshLambertMaterial({color: col})); awn.position.set(0, 2.3, 0.2); awn.rotation.x = 0.2; gs.add(awn);
      [-1, 1].forEach(function(sg){ var pole = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.05, 2.3, 6), new THREE.MeshLambertMaterial({color: 0x333333})); pole.position.set(sg*1.1, 1.15, -0.4); gs.add(pole); });
      gs.position.set(f.x, gy, f.z); gs.rotation.y = f.yaw; g.add(gs); stallG.push(gs);
    });
    // the busker: a figure and a guitar, there in the busker's hours
    var bk = busker(W);
    if(bk){
      buskerG = new THREE.Group();
      var bm = new THREE.MeshLambertMaterial({color: 0x3f6fb5});
      var bd = new THREE.Mesh(new THREE.CylinderGeometry(0.28, 0.32, 1.2, 10), bm); bd.position.y = 0.95; buskerG.add(bd);
      var hd = new THREE.Mesh(new THREE.SphereGeometry(0.2, 10, 8), new THREE.MeshLambertMaterial({color: 0xd9a77a})); hd.position.y = 1.75; buskerG.add(hd);
      var gt = new THREE.Mesh(new THREE.BoxGeometry(0.35, 0.8, 0.12), new THREE.MeshLambertMaterial({color: 0xa0522d})); gt.position.set(0.1, 1.0, 0.3); gt.rotation.z = 0.6; buskerG.add(gt);
      buskerG.position.set(bk.x, ctx.groundY(bk.x, bk.z), bk.z); buskerG.visible = false; g.add(buskerG);
    }
    sparkle = new THREE.Mesh(new THREE.OctahedronGeometry(0.35, 0), new THREE.MeshBasicMaterial({color: 0xfff6c0, transparent: true, opacity: 0.9, depthWrite: false}));
    sparkle.visible = false; g.add(sparkle);
    drawTokens();
  }
  function drawTokens(){
    if(!tokIM) return;
    var m4 = new THREE.Matrix4(), q = new THREE.Quaternion().setFromEuler(new THREE.Euler(Math.PI/2, 0, 0)), v = new THREE.Vector3(), s = new THREE.Vector3();
    F.forEach(function(f){
      var i = tokIdx[f.id]; if(i == null) return;
      var k = got[f.id] ? 0.0001 : f.kind === "roof" ? 1.8 : 1;
      var y = f.kind === "roof" ? f.y : ctx.groundY(f.x, f.z) + 0.6;
      m4.compose(v.set(f.x, y, f.z), q, s.set(k, k, k)); tokIM.setMatrixAt(i, m4);
    });
    tokIM.instanceMatrix.needsUpdate = true;
  }
  function collect(f){
    if(!f || got[f.id]) return false;
    got[f.id] = 1; ctx.store.set(K, got);
    if(tagMats[f.id]) tagMats[f.id].color.setHex(MYCOL);
    drawTokens();
    var n = nGot(), what = f.kind === "stall" ? "Found " + f.name : f.kind === "tag" ? "Tagged a wall" : f.kind === "roof" ? "Rooftop token" : "Hidden token";
    ctx.hud.set("finds", what + "  " + n + "/" + F.length, {colour: "#ffd040"}); clock = 3;
    ctx.say(what + ". Finds " + n + " of " + F.length + ".");
    ctx.emit("find", {id: f.id, kind: f.kind, n: n, total: F.length});
    return true;
  }
  function near(f, p, y){
    var d = Math.hypot(p.x - f.x, p.z - f.z);
    if(f.kind === "roof") return d <= ROOF_M && y != null && Math.abs(y - f.y) <= ROOF_M;
    if(f.kind === "stall") return d <= VISIT_M;
    if(f.kind === "hidden") return d <= TOUCH_M && (y == null || Math.abs(y - f.y) < 4);
    return false;
  }
  function tagAt(p){
    for(var i = 0; i < F.length; i++){ var f = F[i]; if(f.kind === "tag" && !got[f.id] && Math.hypot(p.x - f.stand.x, p.z - f.stand.z) <= TAG_M) return f; }
    return null;
  }
  function photo(d){
    var ms = lastLocal || ctx.local(Date.now()), done = photosDone(ms), C = challenges(W, seed, ms), hit = null;
    var pose = d && d.x != null ? d : me ? {x: me.x, z: me.z, yaw: me.yaw || 0} : null;
    if(!pose) return false;
    C.forEach(function(c){
      if(hit || done[c.id]) return;
      if(targets(W, seed, c.id, ms).some(function(t){ return judge(pose, t); })) hit = c;
    });
    if(!hit) return false;
    done[hit.id] = 1; ctx.store.set(wkKey(ms), done);
    var n = Object.keys(done).filter(function(k){ return C.some(function(c){ return c.id === k; }); }).length;
    ctx.hud.set("finds", "Photo hunt: " + hit.name.replace(/^Photograph /, "") + "  " + n + "/" + C.length, {colour: "#7dd3ff"}); clock = 3;
    ctx.say("Photo challenge done: " + hit.name + ". " + n + " of " + C.length + " this week.");
    ctx.emit("find", {id: hit.id, kind: "photo", n: n, total: C.length});
    return true;
  }

  return {
    update: function(dt, f){
      f = f || {}; dt = Math.max(0, Math.min(0.5, +dt || 0));
      me = f.me || me; mo = f.motion || null; lastLocal = f.local || lastLocal;
      if(clock > 0){ clock -= dt; if(clock <= 0) ctx.hud.clear("finds"); }
      if(!me) return;
      var y = mo && mo.y != null ? +mo.y : me.y != null ? +me.y : null, best = null, bd = SPARKLE_M;
      for(var i = 0; i < F.length; i++){
        var x = F[i]; if(got[x.id]) continue;
        var d = Math.hypot(me.x - x.x, me.z - x.z);
        if(d < bd && x.kind !== "roof"){ bd = d; best = x; }
        if(x.kind === "roof" && d < SPARKLE_M && y != null && Math.abs(y - x.y) < SPARKLE_M){ bd = d; best = x; }
        if(d < 8 && near(x, me, y)) collect(x);
      }
      if(sparkle){
        if(best && !got[best.id]){
          var sy = best.kind === "roof" ? best.y + 1.2 : best.kind === "tag" ? best.y + 1 : best.kind === "stall" ? ctx.groundY(best.x, best.z) + 3 : ctx.groundY(best.x, best.z) + 1.4;
          sparkle.position.set(best.x, sy, best.z); sparkle.visible = true;
          if(!ctx.calm()){ sparkle.rotation.y += dt*2.4; var k = 1 + 0.25*Math.sin(sparkle.rotation.y*3); sparkle.scale.set(k, k, k); }
          else sparkle.scale.set(1, 1, 1);
        } else sparkle.visible = false;
      }
      if(buskerG && lastLocal){ var h = hourOf(lastLocal); buskerG.visible = h >= 10 && h < 20; }
    },
    blocked: function(x, z){
      for(var i = 0; i < F.length; i++){ var f = F[i]; if(f.kind === "stall" && Math.abs(x - f.x) < 1.2 && Math.abs(z - f.z) < 1.2) return true; }
      return false;
    },
    prompt: function(p){ if(mo && mo.ride) return null; var f = tagAt(p); return f ? "E  Tag this wall" : null; },
    use: function(p){ if(mo && mo.ride) return false; var f = tagAt(p); return f ? collect(f) : false; },
    on: function(kind, d){ if(kind === "photo") photo(d || {}); },
    list: function(){ return F.map(function(f){ var o = {}; for(var k in f) o[k] = f[k]; o.got = !!got[f.id]; return o; }); },
    progress: function(ms){
      ms = ms != null ? ms : (lastLocal || ctx.local(Date.now()));
      var C = challenges(W, seed, ms), done = photosDone(ms);
      return {finds: nGot(), total: F.length, photos: C.filter(function(c){ return done[c.id]; }).length, photosTotal: C.length};
    },
    challenges: function(ms){
      ms = ms != null ? ms : (lastLocal || ctx.local(Date.now()));
      var done = photosDone(ms);
      return challenges(W, seed, ms).map(function(c){ return {id: c.id, name: c.name, when: c.when, on: targets(W, seed, c.id, ms).length > 0, done: !!done[c.id]}; });
    },
    hint: function(){
      if(!me) return null;
      var best = null, bd = Infinity;
      F.forEach(function(f){ if(got[f.id]) return; var d = Math.hypot(me.x - f.x, me.z - f.z); if(d < bd){ bd = d; best = f; } });
      if(!best) return null;
      var r = mulberry32(hashStr(best.id + ":hint")), a = r()*2*Math.PI, o = 20 + r()*20;
      ctx.waypoint(best.x + Math.sin(a)*o, best.z + Math.cos(a)*o, "Somewhere near here");
      ctx.say("Something is " + best.hint + ", near the marker.");
      return {kind: best.kind, hint: best.hint};
    },
    collect: function(id){ return collect(byId[id]); },
    dispose: function(){
      ctx.hud.clear("finds");
      if(g && S){ S.remove(g); g.traverse(function(o){ if(o.geometry) o.geometry.dispose(); if(o.material){ if(o.material.map) o.material.map.dispose(); o.material.dispose(); } }); }
      g = null;
    }
  };
}

if(HQV.cityPlay) HQV.cityPlay.register({id: "finds", order: 31, create: create});

/* ---------- the phone app ---------- */
var GLYPH = "M12 3l2.6 5.6 6 .7-4.5 4.1 1.2 6L12 16.4 6.7 19.4l1.2-6L3.4 9.3l6-.7z";
function mk(tag, cls, parent, text){
  var e = document.createElement(tag);
  if(cls) e.className = cls;
  if(text != null) e.textContent = String(text);
  if(parent) parent.appendChild(e);
  return e;
}
function feature(){ var L = HQV.cityPlay && HQV.cityPlay.live && HQV.cityPlay.live(); return L ? L.feature("finds") : null; }
function renderApp(el){
  var root = mk("div", "hp-app", el), Fe = feature();
  if(!Fe){ mk("p", "hp-muted", root, "Finds appear when the City is loaded."); return {dispose: function(){}}; }
  var P = Fe.progress(), L = Fe.list(), by = {};
  L.forEach(function(f){ var b = by[f.kind] = by[f.kind] || {n: 0, got: 0}; b.n++; if(f.got) b.got++; });
  var head = mk("p", "", root, "Finds " + P.finds + "/" + P.total + ", Photos " + P.photos + "/" + P.photosTotal);
  head.setAttribute("role", "status");
  var card = mk("section", "hp-card", root);
  mk("h3", "", card, "Around the city");
  [["roof", "Rooftop tokens"], ["tag", "Walls tagged"], ["stall", "Rare stalls"], ["hidden", "Hidden tokens"]].forEach(function(r){
    var b = by[r[0]]; if(b) mk("span", "hp-legsub", card, r[1] + ": " + b.got + " of " + b.n);
  });
  var hb = mk("button", "hp-btn", card, "Hint: the nearest one");
  hb.type = "button";
  hb.addEventListener("click", function(){ var G = feature(), h = G && G.hint(); hb.textContent = h ? "Marked: " + h.hint : "Nothing left nearby"; });
  var pc = mk("section", "hp-card", root);
  mk("h3", "", pc, "This week's photo hunt");
  mk("span", "hp-hint", pc, "Use the Camera app. The target must be in frame and within 60 m.");
  var ul = mk("ul", "hp-list", pc); ul.setAttribute("aria-label", "Photo challenges");
  Fe.challenges().forEach(function(c){
    var li = mk("li", "", ul);
    mk("b", "", li, (c.done ? "✓ " : "") + c.name);
    mk("span", "hp-legsub", li, " " + c.when + (c.on && !c.done ? " (on now)" : ""));
  });
  mk("p", "hp-hint", root, "Progress stays on this computer.");
  return {dispose: function(){}};
}
// the phone's Achievements app lists these too (local only; empty with no City)
(HQV.hqAchSources = HQV.hqAchSources || []).push(function(){
  var F = feature(); if(!F) return [];
  var P = F.progress();
  function a(id, name, desc, n, goal){ return {id: id, name: name, desc: desc, done: n >= goal, pct: Math.round(100*Math.min(1, n/Math.max(1, goal)))}; }
  return [a("finds:half", "Collector", "Find 25 things hidden in this city", P.finds, 25), a("finds:all", "Nothing left unturned", "Find everything hidden in this city", P.finds, P.total),
          a("finds:photos", "Shutterbug", "Finish every photo challenge this week", P.photos, P.photosTotal)];
});
(HQV.hqPhoneQueue = HQV.hqPhoneQueue || []).push({id: "finds", name: "Finds", order: 41, glyph: GLYPH, dock: false, needsCity: true, render: renderApp});

HQV.playFinds = {finds: finds, challenges: challenges, targets: targets, judge: judge, busker: busker, week: week, weekday: weekday,
  COUNTS: COUNTS, PHOTO_M: PHOTO_M, TOUCH_M: TOUCH_M, ROOF_M: ROOF_M, VISIT_M: VISIT_M, TAG_M: TAG_M, SPARKLE_M: SPARKLE_M, create: create};
})();
