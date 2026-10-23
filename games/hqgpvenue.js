/* Claude HQ 3.17: the Grand Prix Circuit (HQV.hqGpVenue), docs/plans/grand-prix-spec.md section 5.
 *
 * Every F1 circuit is its own world at true scale (the Valley's Grand Prix, games/gp.js): none fits in a city. In the
 * City stands their gateway: a pit building, a short stretch of grid under a start gantry and a chequered arch, and a
 * grandstand. E at the pit lane opens the panel: the circuits (the 2026 calendar, then the classics), the F1 car (the
 * one you drive, else one you own, else the team you pick) and Go, which opens the Grand Prix there.
 *
 *   place(W, tier) / pick(W)   the venue's site on a building lot ("gp:0", from tier 2; pure, idempotent), claimed after
 *                              every other shop so none of them moves: the roomiest free lot near a main road, a walk
 *                              out from the plaza
 *   build(c, site, opts) -> B  the venue, the civic-building shape games/hqcity3d.js keeps (g, doors, hits, glows, boxes,
 *                              lod, decks, top, tint, setNight, animate, inside(x, z), door, dispose)
 *   circuits() -> Promise<[{id, name, location, lengthM, round}]>   games/gp/circuits.json, names only
 *   rows(list) -> [{section} | circuit]   (pure) the calendar by round, then "Classics" by name
 *   grid(cat) -> [catalogue F1 cars]      (pure) class car.formula.2000 in slot order
 *   mountPanel(stage, opts) -> ui {open(o), close(), isOpen(), destroy()}
 *                              opts = {catalogue() -> cat, driving() -> vehicle id | null, owned() -> [vehicle ids],
 *                                      go({circuit, vehicle}), announce, onClose}
 *   owns(e)                    a key event inside the panel (the page's capture-phase handler skips it)
 *
 * No network beyond the page's own /games files; Go only changes the view. textContent only.
 */
(function(){
"use strict";
var G = typeof window !== "undefined" ? window : globalThis;
var HQV = G.HQV = G.HQV || {};

var PI = Math.PI, Q16 = 65536;
var SITE_ID = "gp:0", MIN_TIER = 2, NAME = "Grand Prix Circuit";
var MIN_W = 26, MIN_D = 22;                    // m: the pit building, the grid strip and the grandstand
var CLASS = "car.formula.2000";
var URL = "/games/gp/circuits.json";
var NEAR_ROAD = 40, WANT_FROM_PLAZA = 420;
var ROADS = {arterial: 1, avenue: 1, ring: 1};

/* ---------- where it stands (pure) ---------- */
function frame(o){ return HQV.hqDealer && HQV.hqDealer.frame ? HQV.hqDealer.frame(o) : null; }
function siteOf(W, id){ var S = W.sites || []; for(var i = 0; i < S.length; i++) if(S[i] && S[i].id === id) return S[i]; return null; }
function find(W){ var S = (W && W.sites) || []; for(var i = 0; i < S.length; i++) if(S[i] && S[i].kind === "gp") return S[i]; return null; }
function roadPts(W){
  var P = [];
  (W.edges || []).forEach(function(e){
    if(!e || !ROADS[e.cls || e["class"]]) return;
    if(e.pts){ for(var i = 0; i + 2 < e.pts.length; i += 3) P.push(e.pts[i]/100, e.pts[i + 2]/100); }
    else (e.points || []).forEach(function(p){ P.push(p[0]/100, p[2]/100); });
  });
  return P;
}
// the roomiest free building lot (more room counts for no more past 40 x 32 m), on a main road, a walk out from the plaza
function pick(W){
  if(!W || !W.lots) return null;
  var C = [];
  W.lots.forEach(function(l){
    if(!l || l.kind !== "building") return;
    if(l.min_tier != null && (l.min_tier | 0) > MIN_TIER) return;
    var F = frame(l); if(!F || F.w < MIN_W || F.d < MIN_D) return;
    C.push({lot: l, F: F, room: Math.min(F.w, 40)*Math.min(F.d, 32)});
  });
  if(!C.length) return null;
  var P = roadPts(W), pl = siteOf(W, "fountain:0") || siteOf(W, "spawn:0"), px = pl ? pl.x/100 : 0, pz = pl ? pl.z/100 : 0;
  C.forEach(function(c){
    var dx0 = c.F.cx + c.F.f[0]*c.F.d/2, dz0 = c.F.cz + c.F.f[1]*c.F.d/2, best = 1e18;
    for(var i = 0; i + 1 < P.length; i += 2){ var dx = P[i] - dx0, dz = P[i + 1] - dz0, q = dx*dx + dz*dz; if(q < best) best = q; }
    c.rank = c.room*0.12 + (best < NEAR_ROAD*NEAR_ROAD ? 80 : 0) - Math.abs(Math.hypot(dx0 - px, dz0 - pz) - WANT_FROM_PLAZA)*0.2;
  });
  C.sort(function(a, b){ return (b.rank - a.rank) || ((a.lot.id | 0) - (b.lot.id | 0)); });
  return C[0];
}
function place(W, tier){
  if(!W || !W.sites || !W.lots) return null;
  var have = find(W); if(have) return have;
  if((tier | 0) < MIN_TIER) return null;
  var c = pick(W); if(!c) return null;
  var l = c.lot, F = c.F, y = l.door && l.door.length >= 3 ? l.door[1] | 0 : (l.y | 0);
  // worldbuild draws no building here now; the site does (`was` and `claimed` keep it out of the world cache)
  l.was = l.kind; l.kind = "gp";
  var s = {id: SITE_ID, kind: "gp", tier: MIN_TIER, lot: l.id, block: l.block, district: l.district,
           x: Math.round(F.cx*100), y: y, z: Math.round(F.cz*100), w: Math.round(F.w*100), d: Math.round(F.d*100),
           front: [Math.round(F.f[0]*Q16), Math.round(F.f[1]*Q16)], facing: l.facing || "north", name: NAME, claimed: 1};
  W.sites.push(s);
  W.index = null;
  return s;
}

/* ---------- the venue on the street ---------- */
function tex(c, w, h, draw){ try { var t = c.canvasTex(w, h, function(g){ draw(g, w, h); }).t; if(c.THREE.SRGBColorSpace) t.colorSpace = c.THREE.SRGBColorSpace; return t; } catch(e){ return null; } }
function build(c, site, opts){
  opts = opts || {};
  var T = c.THREE, F = frame(site), y0 = (+site.y || 0)/100, PL = 0.2;
  var g = new T.Group(); g.name = "gp-venue"; g.position.set(F.cx, y0, F.cz); g.rotation.y = F.rot;
  var stat = new T.Group(); stat.name = "gp-static"; g.add(stat);
  var Wd = Math.max(MIN_W - 2, Math.min(F.w - 2, 40)), Dd = Math.max(MIN_D - 2, Math.min(F.d - 2, 32));
  var hw = Wd/2, z0 = -Dd/2, z1 = Dd/2;
  // in the lot's frame (+z the street): the pit building at the back, the strip of track across the middle (the grid,
  // the gantry over its line, the arch at the pit lane), the grandstand on the street side facing it
  var pitD = Math.min(8, Dd*0.3), trackW = Math.min(12, Dd*0.36), standD = Math.max(4, Dd - pitD - trackW - 2);
  var pz0 = z0, pz1 = z0 + pitD, tz0 = pz1 + 1, tz1 = tz0 + trackW, sz0 = tz1 + 0.5, sz1 = Math.min(z1, sz0 + standD);
  var cr = Math.cos(F.rot), sr = Math.sin(F.rot);
  function world(x, z){ return {x: F.cx + x*cr + z*sr, z: F.cz - x*sr + z*cr}; }
  function box(w, h, d, m, x, y, z, p){ return c.box(w, h, d, m, x, y, z, p || stat); }
  function mat(col, o){ return c.mat(col, o); }
  var B = {g: g, doors: [], hits: [], glows: [], boxes: [], lod: [], decks: [], top: 9, tint: 0x3b4048, kind: "gp",
           x: F.cx, y: y0, z: F.cz, site: site, frame: F};
  var nightMats = [];
  // the ground: concrete, the track's asphalt with white edges and red-and-white kerbs, the grid boxes
  box(Wd + 1, 0.4, Dd + 1, mat(0x9a9ea4, {roughness: 0.9}), 0, PL - 0.2, 0);
  var asphalt = tex(c, 256, 256, function(gx, w, h){
    gx.fillStyle = "#33363b"; gx.fillRect(0, 0, w, h);
    for(var i = 0; i < 900; i++){ var v = 40 + ((i*97) % 30); gx.fillStyle = "rgb(" + v + "," + v + "," + (v + 4) + ")"; gx.fillRect((i*53) % w, (i*131) % h, 2, 2); }
  });
  if(asphalt){ asphalt.wrapS = asphalt.wrapT = T.RepeatWrapping; asphalt.repeat.set(Wd/8, trackW/8); }
  box(Wd, 0.05, trackW, new T.MeshStandardMaterial({color: 0xffffff, map: asphalt || null, roughness: 0.85}), 0, PL + 0.03, (tz0 + tz1)/2);
  var white = mat(0xf2f2f2, {roughness: 0.6});
  box(Wd, 0.02, 0.25, white, 0, PL + 0.07, tz0 + 0.5); box(Wd, 0.02, 0.25, white, 0, PL + 0.07, tz1 - 0.5);
  var kerb = tex(c, 128, 16, function(gx, w, h){ for(var i = 0; i < 8; i++){ gx.fillStyle = i % 2 ? "#f4f4f4" : "#d2232a"; gx.fillRect(i*16, 0, 16, h); } });
  if(kerb){ kerb.wrapS = T.RepeatWrapping; kerb.repeat.set(Wd/8, 1); }
  var kerbM = new T.MeshStandardMaterial({color: kerb ? 0xffffff : 0xd2232a, map: kerb || null, roughness: 0.6});
  box(Wd, 0.08, 0.6, kerbM, 0, PL + 0.06, tz0 + 0.1); box(Wd, 0.08, 0.6, kerbM, 0, PL + 0.06, tz1 - 0.1);
  // the start line (chequered) and four grid boxes behind it, two by two
  var lineX = hw*0.35;
  var chk = tex(c, 32, 256, function(gx, w, h){ for(var i = 0; i < 2; i++) for(var j = 0; j < 16; j++){ gx.fillStyle = (i + j) % 2 ? "#f2f2f2" : "#121316"; gx.fillRect(i*16, j*16, 16, 16); } });
  box(1, 0.02, trackW - 1.4, new T.MeshStandardMaterial({color: chk ? 0xffffff : 0xdddddd, map: chk || null, roughness: 0.6}), lineX, PL + 0.07, (tz0 + tz1)/2);
  for(var k = 0; k < 4; k++){
    var gx0 = lineX - 4 - k*4.5, gz = k % 2 ? tz0 + trackW*0.32 : tz0 + trackW*0.68;
    if(gx0 < -hw + 2) break;
    box(0.15, 0.02, 2.2, white, gx0, PL + 0.07, gz); box(1.4, 0.02, 0.15, white, gx0 - 0.7, PL + 0.07, gz - 1.05); box(1.4, 0.02, 0.15, white, gx0 - 0.7, PL + 0.07, gz + 1.05);
  }
  // the pit building: three garages with their doors up, a glass race-control deck on top, the name along it
  var wallM = mat(0xe9ebee, {roughness: 0.55}), darkM = mat(0x23262b, {roughness: 0.5, metalness: 0.3});
  var pitH = 4.2, deckH = 3;
  box(Wd, pitH, 0.4, wallM, 0, PL + pitH/2, pz0 + 0.2);
  [-1, 1].forEach(function(sx){ box(0.4, pitH, pitD, wallM, sx*(hw - 0.2), PL + pitH/2, (pz0 + pz1)/2); });
  var bays = 3, bw = (Wd - 0.6*(bays + 1))/bays;
  for(var b = 0; b <= bays; b++) box(0.6, pitH, 0.5, wallM, -hw + 0.3 + b*(bw + 0.6), PL + pitH/2, pz1 - 0.25);
  var garageM = new T.MeshStandardMaterial({color: 0x4a4f57, emissive: 0xfff6e0, emissiveIntensity: 0, roughness: 0.4});
  nightMats.push([garageM, 0, 0.55]);
  box(Wd - 0.8, pitH - 0.2, 0.1, garageM, 0, PL + pitH/2, pz0 + 0.45);
  box(Wd, 0.4, pitD + 0.6, darkM, 0, PL + pitH + 0.2, (pz0 + pz1)/2 + 0.3);
  var glassM = new T.MeshStandardMaterial({color: 0x5f86a8, emissive: 0xbfe2ff, emissiveIntensity: 0.05, roughness: 0.15, metalness: 0.4, transparent: true, opacity: 0.75});
  nightMats.push([glassM, 0.05, 0.7]);
  box(Wd - 2, deckH, pitD - 1.5, glassM, 0, PL + pitH + 0.4 + deckH/2, (pz0 + pz1)/2 - 0.2);
  box(Wd - 1.4, 0.3, pitD - 0.8, darkM, 0, PL + pitH + 0.4 + deckH + 0.15, (pz0 + pz1)/2 - 0.2);
  var signT = tex(c, 1024, 128, function(gx, w, h){
    gx.fillStyle = "#121418"; gx.fillRect(0, 0, w, h);
    gx.font = "900 " + Math.round(h*0.6) + "px 'Avenir Next', 'Segoe UI', sans-serif"; gx.textAlign = "center"; gx.textBaseline = "middle";
    gx.fillStyle = "#f6f6f6"; gx.fillText(NAME.toUpperCase(), w/2, h*0.54);
    for(var i = 0; i < w/16; i++){ gx.fillStyle = i % 2 ? "#f2f2f2" : "#16181b"; gx.fillRect(i*16, h - 10, 16, 10); }
  });
  var signM = new T.MeshStandardMaterial({color: 0xffffff, map: signT || null, emissive: 0xffffff, emissiveMap: signT || null, emissiveIntensity: 0.3, roughness: 0.5});
  if(!signT){ signM.color.setHex(0x121418); signM.emissiveIntensity = 0; }
  nightMats.push([signM, 0.3, 1.4]);
  // the name across the front of the race-control deck
  var sw = Math.min(Wd - 3, 22, deckH*7), sign = new T.Mesh(new T.PlaneGeometry(sw, sw/8), signM);
  sign.position.set(0, PL + pitH + 0.4 + deckH/2, (pz0 + pz1)/2 - 0.2 + (pitD - 1.5)/2 + 0.03); g.add(sign);
  // the start gantry over the line: two posts, a beam, five pairs of lights (red at night, unlit by day)
  var postM = mat(0x2a2d33, {roughness: 0.4, metalness: 0.6}), gH = 6;
  box(0.4, gH, 0.4, postM, lineX, PL + gH/2, tz0 - 0.4); box(0.4, gH, 0.4, postM, lineX, PL + gH/2, tz1 + 0.4);
  box(0.6, 1, trackW + 1.2, postM, lineX, PL + gH, (tz0 + tz1)/2);
  var lightM = new T.MeshStandardMaterial({color: 0x3a0d0d, emissive: 0xff2a1f, emissiveIntensity: 0.15, roughness: 0.3});
  nightMats.push([lightM, 0.15, 2.2]);
  for(var li = 0; li < 5; li++){ var lz = tz0 + trackW*(li + 1)/6; box(0.2, 0.3, 0.3, lightM, lineX + 0.35, PL + gH + 0.15, lz); box(0.2, 0.3, 0.3, lightM, lineX + 0.35, PL + gH - 0.25, lz); }
  // the chequered arch at the pit lane: the door
  var archX = -hw + 3, archT = tex(c, 256, 64, function(gx, w, h){
    for(var i = 0; i < w/16; i++) for(var j = 0; j < h/16; j++){ gx.fillStyle = (i + j) % 2 ? "#f2f2f2" : "#16181b"; gx.fillRect(i*16, j*16, 16, 16); }
  });
  var archM = new T.MeshStandardMaterial({color: archT ? 0xffffff : 0x888888, map: archT || null, roughness: 0.5});
  box(0.5, 4.5, 0.5, postM, archX - 2, PL + 2.25, sz1 + 0.2); box(0.5, 4.5, 0.5, postM, archX + 2, PL + 2.25, sz1 + 0.2);
  box(4.6, 0.8, 0.4, archM, archX, PL + 4.6, sz1 + 0.2);
  // the grandstand: stepped tiers along the street side facing the track, a roof on posts, seats in the venue's red
  var standW = Wd - 8, tiers = Math.max(3, Math.min(7, Math.floor(standD/1.1))), tierD = (sz1 - sz0)/tiers;
  var seatM = mat(0xc8262c, {roughness: 0.6}), stepM = mat(0xbfc3c8, {roughness: 0.8});
  for(var ti = 0; ti < tiers; ti++){
    var tz = sz0 + tierD*(ti + 0.5), th = 0.5 + ti*0.55;
    box(standW, th, tierD, stepM, 2, PL + th/2, tz);
    box(standW - 0.4, 0.25, tierD*0.4, seatM, 2, PL + th + 0.12, tz - tierD*0.15);
  }
  var roofY = PL + 0.5 + tiers*0.55 + 2.6;
  [-standW/2 + 2.5, 2, standW/2 + 1.5].forEach(function(x){ box(0.25, roofY - PL, 0.25, postM, x, PL + (roofY - PL)/2, sz1 - 0.3); });
  box(standW + 0.6, 0.25, sz1 - sz0 + 0.6, darkM, 2, roofY, (sz0 + sz1)/2 - 0.2);
  // the door: the pit lane under the arch (a hit the pointer and E find)
  var dHit = box(3.6, 0.05, 2.4, new T.MeshStandardMaterial({color: 0xf2c94c, roughness: 0.6}), archX, PL + 0.06, sz1 + 0.6);
  var dp = world(archX, sz1 + 1.4), out = world(archX, sz1 + 3.5);
  var door = {x: dp.x, y: y0 + PL, z: dp.z, kind: "gp", label: NAME, tip: NAME + ": race any F1 circuit (E)", live: true,
              front: new T.Vector3(dp.x, y0, dp.z)};
  dHit.userData.door = door; B.doors.push(door); B.hits.push(dHit);
  B.door = {x: out.x, z: out.z, yaw: F.rot + PI};
  if(c.glow) [[-hw + 1, tz0], [hw - 1, tz0], [-hw + 1, tz1], [hw - 1, tz1]].forEach(function(p){ var s = c.glow(0xfff1d6, 9, 0.5); s.position.set(p[0], PL + 7, p[1]); stat.add(s); B.glows.push(s); });
  // the masses: the pit building and the grandstand (they block you, the camera and the far boxes); the track is open
  function note(cx, cz, w, d, ya, yb){
    var o = world(cx, cz), a = world(cx - w/2, cz - d/2), b2 = world(cx + w/2, cz + d/2), e = world(cx - w/2, cz + d/2), f2 = world(cx + w/2, cz - d/2);
    B.lod.push({x: o.x, z: o.z, w: w, d: d, rot: F.rot, y0: y0 + ya, y1: y0 + yb});
    B.boxes.push({min: {x: Math.min(a.x, b2.x, e.x, f2.x), y: y0 + ya, z: Math.min(a.z, b2.z, e.z, f2.z)},
                  max: {x: Math.max(a.x, b2.x, e.x, f2.x), y: y0 + yb, z: Math.max(a.z, b2.z, e.z, f2.z)},
                  o: {x: o.x, z: o.z, hw: w/2, hd: d/2, rot: F.rot, y0: ya}});
  }
  note(0, (pz0 + pz1)/2, Wd, pitD, 0, PL + pitH + 0.4 + deckH + 0.3);
  note(2, (sz0 + sz1)/2, standW, sz1 - sz0, 0, roofY + 0.2);
  B.top = PL + pitH + deckH + 1;
  B.inside = function(x, z){
    var dx = x - F.cx, dz = z - F.cz, lx = dx*cr - dz*sr, lz = dx*sr + dz*cr;
    return Math.abs(lx - archX) <= 3 && lz >= sz1 - 0.5 && lz <= Dd/2 + 2;     // at the arch
  };
  B.setNight = function(n){ nightMats.forEach(function(m){ m[0].emissiveIntensity = n ? m[2] : m[1]; }); B.glows.forEach(function(s){ s.visible = !!n; }); };
  B.setNight(opts.night !== false);
  B.animate = function(){};
  if(HQV.hqMerge && HQV.hqMerge.mergeStatic){ try { HQV.hqMerge.mergeStatic(T, stat); } catch(e){} }
  stat.traverse(function(o){ if(o.isMesh) o.receiveShadow = true; });
  B.dispose = function(){ B.dead = true; };
  return B;
}

/* ---------- the circuits and the grid (pure, but for the one fetch) ---------- */
var LIST = null;
function circuits(){
  if(!LIST) LIST = G.fetch(URL).then(function(r){ if(!r.ok) throw new Error("circuits " + r.status); return r.json(); })
    .then(function(d){
      return ((d && d.circuits) || []).map(function(c){ return {id: c.id, name: c.name, location: c.location, lengthM: c.lengthM, round: c.round == null ? null : c.round}; });
    }).catch(function(e){ LIST = null; throw e; });
  return LIST;
}
function rows(list){
  list = (list || []).filter(function(c){ return c && typeof c.id === "string"; });
  var cal = list.filter(function(c){ return typeof c.round === "number"; }).sort(function(a, b){ return a.round - b.round; });
  var old = list.filter(function(c){ return typeof c.round !== "number"; }).sort(function(a, b){ return String(a.name).localeCompare(String(b.name)); });
  var out = [];
  if(cal.length) out.push({section: "2026 calendar"});
  out = out.concat(cal);
  if(old.length) out.push({section: "Classics"});
  return out.concat(old);
}
function grid(cat){
  return ((cat && cat.vehicles) || []).filter(function(v){ return v && v.class === CLASS && typeof v.slot === "number"; })
    .sort(function(a, b){ return a.slot - b.slot; });
}
function km(m){ return (Math.round((+m || 0)/10)/100).toFixed(2) + " km"; }

/* ---------- the panel (DOM) ---------- */
var OWN = ".hqgpv";
function inside(t){ return !!(t && t.closest && t.closest(OWN)); }
function owns(e){ return !!(e && inside(e.target)); }
function mountPanel(stage, opts){
  opts = opts || {};
  var doc = stage.ownerDocument || G.document, open = false, list = null, pick = {circuit: null, vehicle: null}, listeners = [];
  function mk(tag, cls, parent, text){ var n = doc.createElement(tag); if(cls) n.className = cls; if(text != null) n.textContent = text; if(parent) parent.appendChild(n); return n; }
  function on(n, ev, fn){ n.addEventListener(ev, fn); listeners.push([n, ev, fn]); }
  function say(t){ status.textContent = t || ""; if(t && opts.announce) opts.announce(t); }
  var root = mk("div", "hqgpv", stage); root.hidden = true;
  root.setAttribute("role", "dialog"); root.setAttribute("aria-modal", "true"); root.setAttribute("aria-labelledby", "hqgpvTitle");
  var head = mk("div", "hqgpv-head", root);
  var title = mk("h3", null, head, "🏁 " + NAME); title.id = "hqgpvTitle";
  var x = mk("button", "hqgpv-x", head, "✕"); x.type = "button"; x.setAttribute("aria-label", "Close");
  on(x, "click", function(){ close(); });
  mk("p", "hqgpv-sub", root, "Every circuit is full size, in its own world. Pick one and a car, then Go.");
  var body = mk("div", "hqgpv-body", root);
  var cBox = mk("div", "hqgpv-list", body); cBox.setAttribute("role", "listbox"); cBox.setAttribute("aria-label", "Circuits"); cBox.tabIndex = 0;
  var side = mk("div", "hqgpv-side", body);
  mk("h4", null, side, "Car");
  var carBox = mk("div", "hqgpv-cars", side); carBox.setAttribute("role", "radiogroup"); carBox.setAttribute("aria-label", "F1 car");
  var chosen = mk("p", "hqgpv-chosen", side);
  var goB = mk("button", "hqgpv-go", side, "Go"); goB.type = "button";
  var status = mk("p", "hqgpv-status", side); status.setAttribute("aria-live", "polite");
  on(goB, "click", function(){
    if(!pick.circuit){ say("Pick a circuit first."); return; }
    var c = pick.circuit; close(true);
    if(opts.go) opts.go({circuit: c.id, vehicle: pick.vehicle});
  });
  on(root, "keydown", function(e){ if(e.key === "Escape"){ e.preventDefault(); close(); } });
  function cars(){ return grid(opts.catalogue ? opts.catalogue() : null); }
  function carLabel(v){ return v ? v.brand + " " + v.model : "a car of your choice"; }
  function sync(){
    chosen.textContent = (pick.circuit ? pick.circuit.name : "No circuit picked") + " · " + carLabel(cars().filter(function(v){ return v.id === pick.vehicle; })[0]);
    goB.disabled = !pick.circuit;
    Array.prototype.forEach.call(cBox.querySelectorAll("[role=option]"), function(n){ n.setAttribute("aria-selected", n.dataset.id === (pick.circuit && pick.circuit.id) ? "true" : "false"); });
    Array.prototype.forEach.call(carBox.querySelectorAll("button"), function(n){ n.setAttribute("aria-checked", n.dataset.id === pick.vehicle ? "true" : "false"); });
  }
  function renderCircuits(){
    cBox.textContent = "";
    rows(list).forEach(function(r){
      if(r.section){ mk("div", "hqgpv-sec", cBox, r.section); return; }
      var b = mk("div", "hqgpv-row", cBox); b.setAttribute("role", "option"); b.dataset.id = r.id; b.tabIndex = -1;
      mk("b", null, b, (r.round ? "R" + r.round + " · " : "") + r.name);
      mk("span", null, b, (r.location || "") + " · " + km(r.lengthM));
      on(b, "click", function(){ pick.circuit = r; sync(); });
    });
    sync();
  }
  // the circuit list: arrows move, Enter / Space picks (one tab stop)
  on(cBox, "keydown", function(e){
    var opts2 = Array.prototype.slice.call(cBox.querySelectorAll("[role=option]")); if(!opts2.length) return;
    var i = opts2.indexOf(doc.activeElement);
    if(e.key === "ArrowDown" || e.key === "ArrowUp"){
      e.preventDefault(); i = i < 0 ? 0 : Math.max(0, Math.min(opts2.length - 1, i + (e.key === "ArrowDown" ? 1 : -1))); opts2[i].focus();
    } else if((e.key === "Enter" || e.key === " ") && i >= 0){ e.preventDefault(); opts2[i].click(); }
  });
  function renderCars(){
    carBox.textContent = "";
    var L = cars();
    if(!L.length){ mk("p", "hqgpv-muted", carBox, "The F1 grid loads with the dealership's catalogue."); return; }
    L.forEach(function(v){
      var b = mk("button", "hqgpv-car", carBox); b.type = "button"; b.dataset.id = v.id; b.setAttribute("role", "radio");
      var sw = mk("span", "hqgpv-sw", b); sw.setAttribute("aria-hidden", "true");
      var lv = v.livery || {};
      sw.style.background = "linear-gradient(90deg," + (lv.base || "#888888") + " 0 60%," + (lv.accent || "#444444") + " 60% 85%," + (lv.trim || "#222222") + " 85%)";
      mk("span", null, b, v.brand);
      on(b, "click", function(){ pick.vehicle = v.id; sync(); });
    });
  }
  function openP(o){
    o = o || {};
    // the car: the F1 car you drive, else one you own, else the last pick, else the first team
    var L = cars(), ids = L.map(function(v){ return v.id; }), d = opts.driving ? opts.driving() : null, own = opts.owned ? opts.owned() : [];
    if(ids.indexOf(d) >= 0) pick.vehicle = d;
    else if(ids.indexOf(pick.vehicle) < 0){ var mine = (own || []).filter(function(i){ return ids.indexOf(i) >= 0; })[0]; pick.vehicle = mine || ids[0] || null; }
    renderCars(); open = true; root.hidden = false; say("");
    if(list){ renderCircuits(); }
    else {
      cBox.textContent = ""; mk("p", "hqgpv-muted", cBox, "Loading the circuits…");
      circuits().then(function(l){ list = l; if(!pick.circuit) pick.circuit = rows(l).filter(function(r){ return !r.section; })[0] || null; if(open) renderCircuits(); },
                      function(){ cBox.textContent = ""; mk("p", "hqgpv-muted", cBox, "The circuits couldn't load."); });
    }
    sync();
    try { cBox.focus(); } catch(e){}
    if(d && ids.indexOf(d) >= 0) say("You're in the " + carLabel(L[ids.indexOf(d)]) + ": it comes with you.");
  }
  function close(going){
    if(!open) return; open = false; root.hidden = true;
    if(opts.onClose) opts.onClose(!!going);
  }
  return {open: openP, close: function(){ close(false); }, isOpen: function(){ return open; }, root: root,
          destroy: function(){ listeners.forEach(function(l){ l[0].removeEventListener(l[1], l[2]); }); listeners = []; if(root.parentNode) root.parentNode.removeChild(root); }};
}

HQV.hqGpVenue = {SITE_ID: SITE_ID, NAME: NAME, CLASS: CLASS, URL: URL, find: find, pick: pick, place: place, build: build,
                 circuits: circuits, rows: rows, grid: grid, mountPanel: mountPanel, owns: owns};
if(typeof module === "object" && module.exports) module.exports = HQV.hqGpVenue;
})();
