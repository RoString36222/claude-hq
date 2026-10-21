/* Claude HQ: the dealership (HQV.hqDealer), docs/plans/dealership-spec.md "The dealership".
 *
 * One dealership in every city from tier 2 (the Commons has the flagship): a glass showroom with the city's
 * on-sale vehicles (HQV.hqVehicles.onSale: the classes with both slots filled) on slowly turning turntables,
 * a forecourt in front where a test drive starts and a vehicle you get waits, brand flags and a pylon sign.
 * Its door opens the dealer panel (E): Bikes / Cars, type and cc band, the two vehicles of each class side by
 * side with their real specs and paints, a turning 3D preview, Test drive and Get it.
 *
 * Where it stands: the client turns one of the world's building lots into the dealership (place()), the same
 * lot on every client: a commercial or downtown lot (else office, finance, the old town...) big enough for a
 * showroom, its door near an arterial, not too far from the plaza. Not a generator site: a new civic row would
 * take a lot before the HQ pool is drawn, and the Commons' HQ lots go by rank (commons_lot.lot_rank), so every
 * player's HQ could move. The lot stops being a building (worldbuild draws none there) and a "dealer" site
 * takes its place in W.sites, so Go to (hqnav), the minimap and the rest see it as any other site.
 *
 *   place(W, tier)          -> site | null   (pure; mutates W once: idempotent) a "dealer:0" site, from tier 2
 *   pick(W)                 -> {lot, F, score} | null  (pure) the lot place() takes
 *   frame(o)                -> {cx, cz, w, d, rot, f: [fx, fz]}  (pure) a lot's or site's footprint in its own frame (m)
 *   layout(F, items)        -> {fc, hall, cells: [{x, z, r, i}], slots: [{x, z, yaw}]}  (pure, local m) where things go
 *   model(cat, o)           -> panel model (pure): {tabs: [{kind, label, sections: [{type, label, classes: [{id,
 *                              label, vehicles: [card]}]}]}]}; card = {id, brand, model, spec, paints, price,
 *                              priceText, minLevel, locked, owned, canGet, action}. o = {level, owned: [vehicle ids],
 *                              garage: bool}. Free and unlocked unless the data sets a price or a minLevel.
 *   build(c, site, opts)    -> B, the civic-building shape games/hqcity3d.js keeps (g, doors, hits, glows,
 *                              setNight, animate, top, boxes, lod, tint, decks, x, y, z) plus forecourt (world
 *                              slots), door {x, z}, setCatalogue(cat), inside(x, z), dispose()
 *                              opts = {tier, night, catalogue}
 *   mountPanel(stage, opts) -> ui {open(), close(), isOpen(), render(), status(text), destroy(), root}
 *                              opts = {catalogue() -> cat, level() -> n, owned() -> Promise<[ids]>, garage() -> bool,
 *                                      onTest(id, hex), onGet(id, hex) -> Promise<{ok, text}>, three, ctx, name,
 *                                      announce, onClose}
 *   owns(e)                 -> true for a key event inside the panel (the host's capture-phase handler skips it)
 * Pure parts run under node (tests/test_hqdealer.py). textContent only.
 */
(function(){
"use strict";
var G = typeof window !== "undefined" ? window : globalThis;
var HQV = G.HQV = G.HQV || {};

var PI = Math.PI, Q16 = 65536;
var MIN_TIER = 2;                // the first city tier with a dealership
var SITE_ID = "dealer:0";
var COMMONS = "claude-hq@2";
var MIN_W = 30, MIN_D = 24;      // m: the smallest footprint a showroom and its forecourt fit on
var PREF = {commercial: 5, downtown: 5, office: 3, finance: 3, oldtown: 2, tech: 2, media: 2, studio: 1, logistics: 1, civic: 1};
var LINEUP = 26;                 // vehicles a showroom should fit (today's on-sale lineup); more room counts for no more
var ROADS = {arterial: 1, avenue: 1, ring: 1};
var NEAR_ROAD = 30;              // m: a lot whose door is this near an arterial is on the main road
var WANT_FROM_PLAZA = 300;       // m: the best distance from the plaza (downtown, not on it)
var CANDIDATES = 400;            // the best this many by district and size get the road test
var TURN = 0.22;                 // rad/s: the turntables
var CAR_CELL = 6.2, BIKE_CELL = 3.2;   // m: a turntable's square in the hall
var PLINTH = 0.15;

/* ---------- placement (pure) ---------- */
function frontOf(o){
  if(o && o.front && o.front.length === 2){
    var fx = o.front[0]/Q16, fz = o.front[1]/Q16, l = Math.hypot(fx, fz);
    if(l > 1e-6) return [fx/l, fz/l];
  }
  return o && o.facing === "south" ? [0, -1] : [0, 1];
}
// the footprint in its own frame: local +z is the front, local +x is (fz, -fx) (a group turned by rot)
function frame(o){
  o = o || {};
  var f = frontOf(o), r = [f[1], -f[0]], x0 = (+o.x || 0)/100, z0 = (+o.z || 0)/100;
  var w, d, cu = 0, cv = 0;
  if(o.poly && o.poly.length >= 3){
    var us = [], vs = [];
    o.poly.forEach(function(p){ var dx = p[0]/100 - x0, dz = p[1]/100 - z0; us.push(dx*r[0] + dz*r[1]); vs.push(dx*f[0] + dz*f[1]); });
    us.sort(function(a, b){ return a - b; }); vs.sort(function(a, b){ return a - b; });
    // a skewed quad: the inner pair of each side (the rectangle that fits inside, near enough)
    var n = us.length, ua = n >= 4 ? us[1] : us[0], ub = n >= 4 ? us[n - 2] : us[n - 1], va = n >= 4 ? vs[1] : vs[0], vb = n >= 4 ? vs[n - 2] : vs[n - 1];
    w = Math.max(0, ub - ua); d = Math.max(0, vb - va); cu = (ua + ub)/2; cv = (va + vb)/2;
  } else {
    var ww = (+o.w || 0)/100, dd = (+o.d || 0)/100;
    w = Math.abs(f[1]) > Math.abs(f[0]) ? ww : dd; d = Math.abs(f[1]) > Math.abs(f[0]) ? dd : ww;
  }
  return {cx: x0 + r[0]*cu + f[0]*cv, cz: z0 + r[1]*cu + f[1]*cv, w: w, d: d, rot: Math.atan2(f[0], f[1]), f: f};
}
function doorPt(l){
  if(l.door && l.door.length >= 3) return {x: l.door[0]/100, z: l.door[2]/100};
  var F = frame(l); return {x: F.cx + F.f[0]*F.d/2, z: F.cz + F.f[1]*F.d/2};
}
function siteOf(W, id){ var S = W.sites || []; for(var i = 0; i < S.length; i++) if(S[i] && S[i].id === id) return S[i]; return null; }
function find(W){ var S = (W && W.sites) || []; for(var i = 0; i < S.length; i++) if(S[i] && S[i].kind === "dealer") return S[i]; return null; }
// arterial points (m): packed edges (pts: Int32Array x, y, z cm) or doc edges (points: [[x, y, z]])
function roadPts(W){
  var P = [];
  (W.edges || []).forEach(function(e){
    if(!e || !ROADS[e.cls || e["class"]]) return;
    if(e.pts){ for(var i = 0; i + 2 < e.pts.length; i += 3) P.push(e.pts[i]/100, e.pts[i + 2]/100); }
    else (e.points || []).forEach(function(p){ P.push(p[0]/100, p[2]/100); });
  });
  return P;
}
function pick(W){
  if(!W) return null;
  var legend = (W.districts && W.districts.legend) || [], C = [];
  (W.lots || []).forEach(function(l){
    if(!l || l.kind !== "building") return;
    if(l.min_tier != null && (l.min_tier | 0) > MIN_TIER) return;
    var F = frame(l); if(F.w < MIN_W || F.d < MIN_D) return;
    C.push({lot: l, F: F, score: PREF[legend[l.district | 0]] || 0, fits: Math.min(LINEUP, layout(F, CARS).cells.length)});
  });
  if(!C.length) return null;
  C.sort(function(a, b){ return (b.fits - a.fits) || (b.score - a.score) || ((a.lot.id | 0) - (b.lot.id | 0)); });
  C = C.slice(0, CANDIDATES);
  var P = roadPts(W), pl = siteOf(W, "fountain:0") || siteOf(W, "spawn:0"), px = pl ? pl.x/100 : 0, pz = pl ? pl.z/100 : 0;
  C.forEach(function(c){
    var d = doorPt(c.lot), best = 1e18;
    for(var i = 0; i + 1 < P.length; i += 2){ var dx = P[i] - d.x, dz = P[i + 1] - d.z, q = dx*dx + dz*dz; if(q < best) best = q; }
    c.road = best < NEAR_ROAD*NEAR_ROAD;
    c.from = Math.hypot(d.x - px, d.z - pz);
    // room for the lineup first (a showroom that shows it), then the district, the main road, downtown but not on the plaza
    c.rank = c.fits*60 + c.score*40 + (c.road ? 120 : 0) - Math.abs(c.from - WANT_FROM_PLAZA)*0.3;
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
  // worldbuild draws no building here now; the site does. `was` and `claimed` keep it out of the world cache
  // (games/world.js cacheCopy puts the lot back and drops the site), as games/hqspectacle.js does
  l.was = l.kind; l.kind = "dealer";
  var s = {id: SITE_ID, kind: "dealer", tier: MIN_TIER, lot: l.id, block: l.block, district: l.district,
           x: Math.round(F.cx*100), y: y, z: Math.round(F.cz*100), w: Math.round(F.w*100), d: Math.round(F.d*100),
           front: [Math.round(F.f[0]*Q16), Math.round(F.f[1]*Q16)], facing: l.facing || "north",
           flagship: W.id === COMMONS, name: W.id === COMMONS ? "Flagship Dealership" : "Dealership", claimed: 1};
  W.sites.push(s);
  W.index = null;                          // world.js rebuilds its lot/site buckets
  return s;
}

/* ---------- the panel model (pure) ---------- */
var TYPE_LABEL = {naked: "Naked", sport: "Sport", adventure: "Adventure", cruiser: "Cruiser", scooter: "Scooter", dirt: "Dirt",
                  hatch: "Hatchback", sedan: "Sedan", coupe: "Coupé", suv: "SUV", pickup: "Pickup", hyper: "Hypercar"};
var KIND_LABEL = {bike: "Bikes", car: "Cars"};
function onSale(cat){
  if(HQV.hqVehicles && HQV.hqVehicles.onSale) return HQV.hqVehicles.onSale(cat);
  var by = {};
  ((cat && cat.vehicles) || []).forEach(function(v){ if(v && (v.slot === 1 || v.slot === 2)) (by[v["class"]] = by[v["class"]] || []).push(v); });
  return ((cat && cat.classes) || []).filter(function(c){ return c.id !== "starter" && (by[c.id] || []).length === 2; });
}
function slotVehicles(cat, id){
  return ((cat && cat.vehicles) || []).filter(function(v){ return v && v["class"] === id && (v.slot === 1 || v.slot === 2); })
    .sort(function(a, b){ return a.slot - b.slot; });
}
function specLine(v){
  if(HQV.hqShowroom && HQV.hqShowroom.specLine) return HQV.hqShowroom.specLine(v);
  var sp = (v && v.spec) || {}, bits = [];
  if(sp.electric) bits.push("electric"); else if(+sp.cc > 0) bits.push(Math.round(+sp.cc) + " cc");
  if(+sp.powerKw > 0) bits.push(Math.round(+sp.powerKw*1.35962) + " PS");
  if(+sp.topKmh > 0) bits.push(Math.round(+sp.topKmh) + " km/h");
  return bits.join(" · ");
}
function priceText(p){
  p = +p || 0;
  return p > 0 ? String(Math.round(p)).replace(/\B(?=(\d{3})+(?!\d))/g, ",") + " coins" : "Free";
}
function model(cat, o){
  o = o || {};
  var level = Math.max(0, +o.level || 0), owned = {}, garage = !!o.garage, out = [], K = {};
  (o.owned || []).forEach(function(id){ owned[id] = (owned[id] || 0) + 1; });
  onSale(cat).forEach(function(c){
    var vs = slotVehicles(cat, c.id); if(vs.length !== 2) return;
    var k = K[c.kind];
    if(!k){ k = K[c.kind] = {kind: c.kind, label: KIND_LABEL[c.kind] || c.kind, sections: [], T: {}}; out.push(k); }
    var t = k.T[c.type];
    if(!t){ t = k.T[c.type] = {type: c.type, label: TYPE_LABEL[c.type] || c.type, classes: []}; k.sections.push(t); }
    t.classes.push({id: c.id, label: c.label || c.id, band: c.band, vehicles: vs.map(function(v){
      var minLevel = Math.max(0, +(v.minLevel != null ? v.minLevel : c.minLevel) || 0), locked = minLevel > 0 && level < minLevel;
      var price = Math.max(0, +v.price || 0);
      return {id: v.id, brand: v.brand || "", model: v.model || v.id, spec: specLine(v), kind: c.kind,
              paints: (v.paints || []).filter(function(p){ return p && /^#[0-9a-fA-F]{6}$/.test(p.hex); }),
              price: price, priceText: priceText(price), minLevel: minLevel, locked: locked, owned: owned[v.id] || 0,
              canGet: garage && !locked,
              action: !garage ? "Getting vehicles opens soon" : locked ? "Needs level " + minLevel : price > 0 ? "Buy · " + priceText(price) : "Get it"};
    })});
  });
  out.sort(function(a, b){ return a.kind === b.kind ? 0 : a.kind === "car" ? -1 : 1; });   // cars first: the showroom's floor
  out.forEach(function(k){ delete k.T; });
  return {tabs: out};
}

/* ---------- the layout (pure, local m: +z the front) ---------- */
var CARS = []; for(var ci = 0; ci < LINEUP; ci++) CARS.push({kind: "car"});
// items: [{kind: "car" | "bike"}] in showroom order -> the forecourt, the hall and a turntable cell per item that fits
function layout(F, items, flagship){
  var W = Math.max(MIN_W, +F.w || 0), D = Math.max(MIN_D, +F.d || 0);
  var fcD = Math.max(9, Math.min(14, D*0.32)), hw = Math.min(W - 4, flagship ? 70 : 56), hd = Math.min(D - fcD - 3, flagship ? 40 : 32);
  var zf = D/2 - fcD - 1, zb = zf - hd, H = flagship ? 9 : 7.5;
  var hall = {x0: -hw/2, x1: hw/2, z0: zb, z1: zf, h: H, w: hw, d: hd};
  // shelves from the front glass back: cars, then bikes; a 2 m aisle behind the front glass
  var cells = [], m = 1.4, x = hall.x0 + m, z = hall.z1 - 2.2, rowD = 0, list = items || [];
  for(var i = 0; i < list.length; i++){
    var cs = list[i] && list[i].kind === "bike" ? BIKE_CELL : CAR_CELL;
    if(x + cs > hall.x1 - m){ x = hall.x0 + m; z -= rowD; rowD = 0; }
    if(z - cs < hall.z0 + m) break;                      // the hall is full: the rest stay in the catalogue
    cells.push({x: x + cs/2, z: z - cs/2, r: cs/2 - 0.35, i: i});
    x += cs; rowD = Math.max(rowD, cs);
  }
  // the forecourt's bays either side of the walk to the door, nose out to the street
  var fz = D/2 - fcD/2, slots = [], walk = 4.5;
  [1, -1].forEach(function(s){ for(var k = 0; k < 3; k++){ var sx = s*(walk/2 + 3 + k*5.2); if(Math.abs(sx) + 2.6 < W/2) slots.push({x: sx, z: fz, yaw: 0}); } });
  slots.sort(function(a, b){ return Math.abs(a.x) - Math.abs(b.x) || a.x - b.x; });
  return {W: W, D: D, fc: {z0: D/2 - fcD, z1: D/2, d: fcD}, hall: hall, cells: cells, slots: slots, door: {x: 0, z: zf}};
}

/* ---------- the building (THREE) ---------- */
// one vertex-coloured geometry from a vehicle rig: its whole body in one draw call, for the turntables
function bake(T, root){
  root.updateMatrixWorld(true);
  var inv = new T.Matrix4().copy(root.matrixWorld).invert(), pos = [], nor = [], col = [], c = new T.Color(), cv = new T.Color();
  root.traverse(function(o){
    if(!o.isMesh || !o.geometry || o.visible === false) return;
    var m = Array.isArray(o.material) ? o.material[0] : o.material; if(!m) return;
    var g = o.geometry.index ? o.geometry.toNonIndexed() : o.geometry.clone();
    g.applyMatrix4(new T.Matrix4().multiplyMatrices(inv, o.matrixWorld));
    if(!g.getAttribute("normal")) g.computeVertexNormals();
    c.set(0x888888); if(m.color) c.copy(m.color);
    if(m.isMeshBasicMaterial && m.color) c.copy(m.color);
    if(m.emissive && (+m.emissiveIntensity || 0) > 0.6 && (m.emissive.r + m.emissive.g + m.emissive.b) > 0.6) c.copy(m.emissive);
    if(m.transparent) c.lerp(cv.set(0x1d2a36), 0.6);                 // glass: dark, tinted
    var P = g.getAttribute("position"), N = g.getAttribute("normal"), Cv = m.vertexColors ? g.getAttribute("color") : null;
    for(var i = 0; i < P.count; i++){
      pos.push(P.getX(i), P.getY(i), P.getZ(i)); nor.push(N.getX(i), N.getY(i), N.getZ(i));
      if(Cv) col.push(c.r*Cv.getX(i), c.g*Cv.getY(i), c.b*Cv.getZ(i)); else col.push(c.r, c.g, c.b);
    }
    g.dispose();
  });
  var out = new T.BufferGeometry();
  out.setAttribute("position", new T.Float32BufferAttribute(pos, 3));
  out.setAttribute("normal", new T.Float32BufferAttribute(nor, 3));
  out.setAttribute("color", new T.Float32BufferAttribute(col, 3));
  out.computeBoundingSphere();
  return out;
}
var BAKED = {};                                      // vehicle id + paint -> baked geometry (shared by every showroom)
function bakedOf(c, v){
  var T = c.THREE, p = ((v.paints || [])[0] || {}).hex || "#888888", key = v.id + p;
  if(BAKED[key]) return BAKED[key];
  if(!HQV.hqVehicleModels) return null;
  var entry = Object.assign({}, v, {model3d: null}), rig;
  try { rig = HQV.hqVehicleModels.build(c, entry, parseInt(p.slice(1), 16)); } catch(e){ return null; }
  return (BAKED[key] = bake(T, rig.g));
}
function brandsOf(cat){
  var seen = {}, out = [];
  onSale(cat).forEach(function(cl){ slotVehicles(cat, cl.id).forEach(function(v){ var b = String(v.brand || ""); if(b && !seen[b]){ seen[b] = 1; out.push(b); } }); });
  return out;
}
var BRAND_COL = {BMW: ["#1c69d4", "#ffffff"], Bugatti: ["#0a2a5c", "#e8ecf2"], KTM: ["#ff6600", "#111111"]};
function brandCol(b){
  if(BRAND_COL[b]) return BRAND_COL[b];
  var h = 0; for(var i = 0; i < b.length; i++) h = (h*31 + b.charCodeAt(i)) >>> 0;
  return ["hsl(" + (h % 360) + ",55%,40%)", "#ffffff"];
}
function signTex(c, w, h, draw){
  var t = c.canvasTex(w, h, draw);
  return t && t.t ? t.t : t;
}

function build(c, site, opts){
  opts = opts || {};
  var T = c.THREE, F = frame(site), flagship = !!site.flagship, y0 = (+site.y || 0)/100;
  var g = new T.Group(); g.name = "dealer"; g.position.set(F.cx, y0, F.cz); g.rotation.y = F.rot;
  var stat = new T.Group(); stat.name = "dealer-static"; g.add(stat);
  var L0 = layout(F, [], flagship), Wd = L0.W, Dd = L0.D, hall = L0.hall, H = hall.h;
  var mat = function(col, o){ return c.mat(col, o); }, box = function(w, h, d, m, x, y, z, p){ return c.box(w, h, d, m, x, y, z, p || stat); };
  var cr = Math.cos(F.rot), sr = Math.sin(F.rot);
  function world(x, z){ return {x: F.cx + x*cr + z*sr, z: F.cz - x*sr + z*cr}; }
  var B = {g: g, doors: [], hits: [], glows: [], boxes: [], lod: [], decks: [], top: H + 2, tint: 0xdfe7ee, kind: "dealer",
           tier: opts.tier | 0, x: F.cx, y: y0, z: F.cz, site: site, frame: F, layout: L0, night: !!opts.night};

  // the ground: paving under it all, the forecourt darker with its bay lines and the walk to the door
  box(Wd, 0.6, Dd, mat(0xb9bec4, {roughness: 0.9}), 0, PLINTH - 0.3, 0);
  box(Wd - 0.4, 0.04, L0.fc.d - 0.4, mat(0x4a4f56, {roughness: 0.85}), 0, PLINTH + 0.02, L0.fc.z0 + L0.fc.d/2);
  var white = mat(0xf2f2f2, {roughness: 0.7});
  L0.slots.forEach(function(s){ [-1.4, 1.4].forEach(function(dx){ box(0.12, 0.02, 5.2, white, s.x + dx, PLINTH + 0.05, s.z); }); });
  box(4.5, 0.03, L0.fc.d + 1, mat(0xd9d4cb, {roughness: 0.8}), 0, PLINTH + 0.045, L0.fc.z0 + L0.fc.d/2 - 0.5);
  // the hall: a glossy floor, a white roof slab over it with an overhang, a dark fascia with the sign
  var hx = (hall.x0 + hall.x1)/2, hz = (hall.z0 + hall.z1)/2;
  // the floor and the back wall light up from inside at night (an emissive share, set in setNight; no real lights)
  var floorM = new T.MeshStandardMaterial({color: 0xe9ecef, roughness: 0.18, metalness: 0.1, emissive: 0xdfe6ee, emissiveIntensity: 0});
  var floor = new T.Mesh(new T.BoxGeometry(hall.w, 0.12, hall.d), floorM); floor.position.set(hx, PLINTH + 0.06, hz); floor.receiveShadow = true; g.add(floor);
  box(hall.w + 3, 0.6, hall.d + 3, mat(0xf4f5f6, {roughness: 0.5}), hx, PLINTH + H + 0.3, hz + 0.6);
  var dark = mat(0x22272e, {roughness: 0.5, metalness: 0.4});
  box(hall.w + 3, 1.6, 0.3, dark, hx, PLINTH + H - 0.4, hall.z1 + 2.05);
  // the back wall, solid; mullions on the glass sides
  var wallM = new T.MeshStandardMaterial({color: 0x2b3138, roughness: 0.7, emissive: 0x4a5866, emissiveIntensity: 0});
  var wall = new T.Mesh(new T.BoxGeometry(hall.w, H, 0.4), wallM); wall.position.set(hx, PLINTH + H/2, hall.z0 + 0.2); g.add(wall);
  var mul = mat(0x3a4048, {metalness: 0.6, roughness: 0.4});
  for(var mx = hall.x0; mx <= hall.x1 + 0.01; mx += Math.max(3, hall.w/Math.round(hall.w/4))) box(0.18, H, 0.18, mul, mx, PLINTH + H/2, hall.z1);
  for(var mz = hall.z0; mz <= hall.z1 + 0.01; mz += Math.max(3, hall.d/Math.round(hall.d/4))){ box(0.18, H, 0.18, mul, hall.x0, PLINTH + H/2, mz); box(0.18, H, 0.18, mul, hall.x1, PLINTH + H/2, mz); }
  // lights under the roof: long strips, lit (unlit material: they glow by night, and read as lights by day)
  var stripM = new T.MeshBasicMaterial({color: 0xfdfaf0, toneMapped: false});
  for(var sz = hall.z0 + 4; sz < hall.z1 - 1; sz += 6) box(hall.w - 4, 0.1, 0.6, stripM, hx, PLINTH + H - 0.12, sz);
  // the glass: front and sides, one material, see-through
  var glassM = new T.MeshStandardMaterial({color: 0xa9cfe6, roughness: 0.05, metalness: 0.2, transparent: true, opacity: 0.22, depthWrite: false,
                                           emissive: 0x3a5a70, emissiveIntensity: 0});
  var gl = new T.Group(); gl.name = "dealer-glass"; g.add(gl);
  [[hall.w, hx, hall.z1, 0], [hall.d, hall.x0, hz, PI/2], [hall.d, hall.x1, hz, PI/2]].forEach(function(p){
    var m = new T.Mesh(new T.PlaneGeometry(p[0], H), glassM); m.position.set(p[1], PLINTH + H/2, p[2]); m.rotation.y = p[3]; m.renderOrder = 2; gl.add(m);
  });
  // the door: a frame, its sliding glass, and the hit the pointer and E find
  box(4.2, 3.2, 0.25, dark, 0, PLINTH + 3.2/2 + 0.02, hall.z1 + 0.12);
  var doorG = box(3.4, 2.7, 0.1, new T.MeshStandardMaterial({color: 0x9cc3dc, roughness: 0.05, metalness: 0.3, transparent: true, opacity: 0.45}), 0, PLINTH + 1.37, hall.z1 + 0.28);
  doorG.renderOrder = 3;
  var dw = world(0, hall.z1 + 1.8), name = String(site.name || "Dealership");
  var door = {x: dw.x, y: y0 + PLINTH, z: dw.z, kind: "dealer", label: name, tip: name + ": browse and test drive (E)", live: true,
              front: new T.Vector3(dw.x, y0, dw.z)};
  doorG.userData.door = door; B.doors.push(door); B.hits.push(doorG);
  B.door = {x: dw.x, z: dw.z};

  // the sign on the fascia and the pylon by the street
  var fasciaT = signTex(c, 1024, 96, function(g2, w, h){
    g2.fillStyle = "#22272e"; g2.fillRect(0, 0, w, h); g2.fillStyle = "#ffffff"; g2.font = "800 56px system-ui, sans-serif";
    g2.textAlign = "center"; g2.textBaseline = "middle"; g2.fillText(name.toUpperCase(), w/2, h/2 + 2);
  });
  if(fasciaT) box(Math.min(hall.w*0.6, 30), 1.1, 0.05, new T.MeshBasicMaterial({map: fasciaT, toneMapped: false}), hx, PLINTH + H - 0.4, hall.z1 + 2.22);
  var pyl = world(Wd/2 - 2.2, Dd/2 - 1.5), pylH = flagship ? 11 : 8;
  box(1.6, pylH, 0.6, dark, Wd/2 - 2.2, PLINTH + pylH/2, Dd/2 - 1.5);
  var pylT = signTex(c, 160, 640, function(g2, w, h){
    g2.fillStyle = "#1c66b5"; g2.fillRect(0, 0, w, h); g2.fillStyle = "#ffffff"; g2.font = "800 92px system-ui, sans-serif"; g2.textAlign = "center";
    "CARS".split("").forEach(function(ch, i){ g2.fillText(ch, w/2, 150 + i*120); });
  });
  if(pylT){ [1, -1].forEach(function(s){ var p = box(1.3, pylH - 1.6, 0.02, new T.MeshBasicMaterial({map: pylT, toneMapped: false}), Wd/2 - 2.2, PLINTH + pylH/2 + 0.4, Dd/2 - 1.5 + s*0.32); if(s < 0) p.rotation.y = PI; }); }

  var flagsG = new T.Group(); flagsG.name = "dealer-flags"; g.add(flagsG);
  var dyn = new T.Group(); dyn.name = "dealer-floor"; g.add(dyn);
  var vehMat = new T.MeshStandardMaterial({vertexColors: true, roughness: 0.35, metalness: 0.35, emissive: 0xffffff, emissiveIntensity: 0});
  var spin = [], discM = mat(0x30353c, {roughness: 0.25, metalness: 0.5}), ringM = new T.MeshBasicMaterial({color: 0x9fd4ff, toneMapped: false});
  var tableG = new T.Group(); tableG.name = "dealer-tables"; g.add(tableG);

  function setCatalogue(cat){
    if(!cat || B.cat === cat) return;
    B.cat = cat;
    while(dyn.children.length) dyn.remove(dyn.children[0]);
    while(tableG.children.length){ var t0 = tableG.children[0]; tableG.remove(t0); if(t0.geometry) t0.geometry.dispose(); }
    while(flagsG.children.length){ var f0 = flagsG.children[0]; flagsG.remove(f0); }
    spin = [];
    // the floor: cars first, then bikes, in class order, both of each class side by side
    var items = [];
    var tabs = model(cat, {}).tabs;
    tabs.forEach(function(k){ k.sections.forEach(function(s){ s.classes.forEach(function(cl){ cl.vehicles.forEach(function(v){ items.push({kind: k.kind, id: v.id}); }); }); }); });
    var L = layout(F, items, flagship), discs = [], rings = [];
    L.cells.forEach(function(cell, n){
      var it = items[cell.i], v = HQV.hqVehicles && HQV.hqVehicles.get ? HQV.hqVehicles.get(cat, it.id) : null;
      if(!v) (cat.vehicles || []).forEach(function(x){ if(x.id === it.id) v = x; });
      discs.push(cell); rings.push(cell);
      var geo = v ? bakedOf(c, v) : null; if(!geo) return;
      var m = new T.Mesh(geo, vehMat); m.position.set(cell.x, PLINTH + 0.26, cell.z); m.rotation.y = (n*0.7) % (2*PI);
      m.castShadow = true; m.name = "dealer-vehicle:" + it.id; dyn.add(m); spin.push({m: m, a: m.rotation.y});
    });
    // turntables: two InstancedMeshes (the discs, their glowing rims), whatever the count
    if(discs.length){
      var dg = new T.CylinderGeometry(1, 1, 0.22, 32), rg = new T.CylinderGeometry(1, 1, 0.06, 32, 1, true);
      var D = new T.InstancedMesh(dg, discM, discs.length), R = new T.InstancedMesh(rg, ringM, rings.length), M4 = new T.Matrix4();
      discs.forEach(function(cl, i){
        M4.makeScale(cl.r, 1, cl.r); M4.setPosition(cl.x, PLINTH + 0.13, cl.z); D.setMatrixAt(i, M4);
        M4.makeScale(cl.r + 0.04, 1, cl.r + 0.04); M4.setPosition(cl.x, PLINTH + 0.21, cl.z); R.setMatrixAt(i, M4);
      });
      D.name = "dealer-discs"; R.name = "dealer-rims"; D.receiveShadow = true;
      tableG.add(D); tableG.add(R);
    }
    // a flag per brand on the forecourt's front edge
    var brands = brandsOf(cat), poleM = mat(0xd5d9de, {metalness: 0.7, roughness: 0.3}), fx0 = -(brands.length - 1)*2.4/2;
    brands.forEach(function(b, i){
      var x = fx0 + i*2.4, z = Dd/2 - 0.6, pole = c.cyl(0.06, 0.06, 7, poleM, x, PLINTH + 3.5, z, flagsG, 8);
      var cols = brandCol(b), tex = signTex(c, 256, 160, function(g2, w, h){
        g2.fillStyle = cols[0]; g2.fillRect(0, 0, w, h); g2.fillStyle = cols[1]; g2.font = "800 " + (b.length > 6 ? 40 : 56) + "px system-ui, sans-serif";
        g2.textAlign = "center"; g2.textBaseline = "middle"; g2.fillText(b.toUpperCase(), w/2, h/2);
      });
      var flag = new T.Mesh(new T.PlaneGeometry(1.5, 0.95), new T.MeshStandardMaterial({map: tex || null, color: tex ? 0xffffff : 0x1c66b5, side: T.DoubleSide, roughness: 0.8}));
      flag.position.set(x + 0.78, PLINTH + 6.4, z); flag.userData.flag = true; flagsG.add(flag);
      pole.userData.pole = true;
    });
    B.layout = L;
  }
  B.setCatalogue = setCatalogue;
  if(opts.catalogue) setCatalogue(opts.catalogue);
  else if(HQV.hqVehicles && HQV.hqVehicles.load) HQV.hqVehicles.load().then(function(cat){ if(!B.dead) setCatalogue(cat); }, function(){});

  // night: the hall glows through its glass, floodlights on the forecourt
  var flood = [];
  if(c.glow) [[-Wd/2 + 2, Dd/2 - 1], [Wd/2 - 4, Dd/2 - 1], [hx, hall.z1 + 1.5]].forEach(function(p){
    var s = c.glow(0xfff1d0, 10, 0.5); s.position.set(p[0], PLINTH + 5, p[1]); stat.add(s); flood.push(s); B.glows.push(s);
  });
  B.setNight = function(n){
    B.night = !!n;
    glassM.emissiveIntensity = n ? 0.9 : 0; glassM.opacity = n ? 0.32 : 0.22;
    floorM.emissiveIntensity = n ? 0.55 : 0; wallM.emissiveIntensity = n ? 0.6 : 0; vehMat.emissiveIntensity = n ? 0.18 : 0;
    flood.forEach(function(s){ if(s.material) s.material.opacity = n ? 0.75 : 0.0; s.visible = !!n; });
  };
  B.setNight(opts.night !== false);
  B.animate = function(t, dt, k){
    var r = (+dt || 0)*TURN*(k == null ? 1 : k);
    if(r) spin.forEach(function(s){ s.a += r; s.m.rotation.y = s.a; });
    var sw = Math.sin((+t || 0)*1.3)*0.12*(k == null ? 1 : k);
    flagsG.children.forEach(function(o){ if(o.userData.flag) o.rotation.y = sw; });
  };
  // the masses: the hall (blocks you, the camera's and the far boxes), the pylon
  function note(cx, cz, w, d, ya, yb){
    var o = world(cx, cz), a = world(cx - w/2, cz - d/2), b = world(cx + w/2, cz + d/2), e = world(cx - w/2, cz + d/2), f = world(cx + w/2, cz - d/2);
    B.lod.push({x: o.x, z: o.z, w: w, d: d, rot: F.rot, y0: y0 + ya, y1: y0 + yb});
    B.boxes.push({min: {x: Math.min(a.x, b.x, e.x, f.x), y: y0 + ya, z: Math.min(a.z, b.z, e.z, f.z)},
                  max: {x: Math.max(a.x, b.x, e.x, f.x), y: y0 + yb, z: Math.max(a.z, b.z, e.z, f.z)},
                  o: {x: o.x, z: o.z, hw: w/2, hd: d/2, rot: F.rot, y0: ya}});
  }
  note(hx, hz, hall.w, hall.d, 0, PLINTH + H + 0.6);
  note(Wd/2 - 2.2, Dd/2 - 1.5, 1.6, 0.6, 0, pylH);
  B.forecourt = L0.slots.map(function(s){ var p = world(s.x, s.z); return {x: p.x, z: p.z, yaw: F.rot + s.yaw}; });
  B.inside = function(x, z){
    var dx = x - F.cx, dz = z - F.cz, lx = dx*cr - dz*sr, lz = dx*sr + dz*cr;
    return Math.abs(lx) <= Wd/2 && lz >= L0.fc.z0 - 1 && lz <= Dd/2 + 1;     // on the forecourt (or at the door)
  };
  if(HQV.hqMerge && HQV.hqMerge.mergeStatic){ try { HQV.hqMerge.mergeStatic(T, stat); } catch(e){} }
  stat.traverse(function(o){ if(o.isMesh){ o.receiveShadow = true; } });
  B.dispose = function(){ B.dead = true; };
  return B;
}

/* ---------- the panel (DOM) ---------- */
var OWN = ".hqdealer";
function inside(t){ return !!(t && t.closest && t.closest(OWN)); }
function owns(e){ return !!(e && (e.hqDealerHandled || inside(e.target))); }

function mountPanel(stage, opts){
  opts = opts || {};
  var doc = typeof document !== "undefined" ? document : null; if(!doc) return null;
  var getCat = typeof opts.catalogue === "function" ? opts.catalogue : function(){ return null; };
  var level = typeof opts.level === "function" ? opts.level : function(){ return 0; };
  var garage = typeof opts.garage === "function" ? opts.garage : function(){ return false; };
  var announce = typeof opts.announce === "function" ? opts.announce : function(){};
  var listeners = [], open = false, sel = {}, kindNow = "car", pick = null, owned = [], statusText = "", busy = false;

  function mk(tag, cls, parent, text){ var n = doc.createElement(tag); if(cls) n.className = cls; if(text != null) n.textContent = text; if(parent) parent.appendChild(n); return n; }
  function on(n, ev, fn){ n.addEventListener(ev, fn); listeners.push([n, ev, fn]); }

  var root = mk("div", "hqdealer", stage); root.hidden = true;
  root.setAttribute("role", "dialog"); root.setAttribute("aria-label", String(opts.name || "Dealership"));
  var head = mk("div", "hqdealer-head", root);
  var title = mk("div", "hqdealer-title", head, "🚘 " + String(opts.name || "Dealership"));
  var note = mk("div", "hqdealer-note", head, "Test drive any of them, then get it.");
  var closeBtn = mk("button", "hqdealer-close", head, "✕"); closeBtn.type = "button"; closeBtn.setAttribute("aria-label", "Leave the dealership");
  var top = mk("div", "hqdealer-top", root);
  var prevBox = mk("div", "hqdealer-preview", top); prevBox.setAttribute("aria-hidden", "true");
  var info = mk("div", "hqdealer-info", top);
  var tabs = mk("div", "hqdealer-tabs", root); tabs.setAttribute("role", "tablist");
  var body = mk("div", "hqdealer-body", root);
  var status = mk("div", "hqdealer-status", root); status.setAttribute("role", "status"); status.setAttribute("aria-live", "polite");

  /* the preview: one small renderer, made on first open, drawing only while the panel is open */
  var P = null;
  function preview(){
    if(P || !opts.three || !HQV.hqVehicleModels) return P;
    var T = opts.three, cv = mk("canvas", "hqdealer-canvas", prevBox), R;
    try { R = new T.WebGLRenderer({canvas: cv, antialias: true, alpha: true}); } catch(e){ prevBox.removeChild(cv); return null; }
    R.setPixelRatio(Math.min(2, G.devicePixelRatio || 1));
    var S = new T.Scene(), cam = new T.PerspectiveCamera(32, 2, 0.1, 100);
    S.add(new T.HemisphereLight(0xffffff, 0x4a5058, 1.6));
    var sun = new T.DirectionalLight(0xffffff, 2.2); sun.position.set(4, 6, 5); S.add(sun);
    var disc = new T.Mesh(new T.CylinderGeometry(3.2, 3.2, 0.12, 48), new T.MeshStandardMaterial({color: 0x30353c, roughness: 0.3, metalness: 0.5}));
    disc.position.y = -0.06; S.add(disc);
    var holder = new T.Group(); S.add(holder);
    P = {R: R, S: S, cam: cam, holder: holder, cv: cv, key: null, raf: 0, t0: 0};
    return P;
  }
  function previewSet(v, hex){
    var p = preview(); if(!p || !v) return;
    var key = v.id + hex; if(p.key === key) return; p.key = key;
    while(p.holder.children.length) p.holder.remove(p.holder.children[0]);
    var rig = null;
    try { rig = HQV.hqVehicleModels.build(opts.ctx || opts.three, Object.assign({}, v, {model3d: v.model3d || null}), parseInt(hex.slice(1), 16)); } catch(e){ rig = null; }
    if(!rig) return;
    p.holder.add(rig.g);
    var L = (v.dims && +v.dims.lengthM) || 4.5, bike = String(v["class"] || "").indexOf("bike.") === 0;
    p.cam.position.set(L*0.95, L*0.42 + (bike ? 0.4 : 0.6), L*1.05); p.cam.lookAt(0, bike ? 0.55 : 0.6, 0);
  }
  function previewLoop(){
    if(!P || !open) return;
    var w = P.cv.clientWidth || 320, h = P.cv.clientHeight || 180;
    if(P.cv.width !== Math.round(w*P.R.getPixelRatio()) || P.cv.height !== Math.round(h*P.R.getPixelRatio())){ P.R.setSize(w, h, false); P.cam.aspect = w/h; P.cam.updateProjectionMatrix(); }
    var calm = doc.documentElement && doc.documentElement.classList && doc.documentElement.classList.contains("hq-calm");
    P.holder.rotation.y = calm ? -0.6 : ((G.performance ? G.performance.now() : Date.now())/1000*0.5) % (2*PI);
    P.R.render(P.S, P.cam);
    P.raf = G.requestAnimationFrame ? G.requestAnimationFrame(previewLoop) : 0;
  }

  function choose(card){
    pick = card;
    var pi = sel[card.id] || 0, paint = card.paints[pi];
    previewSet(G.HQV.hqVehicles && getCat() ? HQV.hqVehicles.get(getCat(), card.id) : null, paint ? paint.hex : "#888888");
    while(info.firstChild) info.removeChild(info.firstChild);
    mk("div", "hqdealer-brand", info, card.brand);
    mk("div", "hqdealer-model", info, card.model);
    mk("div", "hqdealer-spec", info, card.spec);
    mk("div", "hqdealer-price", info, card.locked ? "Needs level " + card.minLevel : card.priceText + (card.owned ? " · you have " + card.owned : ""));
  }
  function render(){
    while(tabs.firstChild) tabs.removeChild(tabs.firstChild);
    while(body.firstChild) body.removeChild(body.firstChild);
    var cat = getCat();
    if(!cat){ mk("div", "hqdealer-empty", body, "Loading the showroom…"); return; }
    var M = model(cat, {level: level(), owned: owned, garage: garage()}), first = null, free = true;
    M.tabs.forEach(function(k){ k.sections.forEach(function(s){ s.classes.forEach(function(cl){ cl.vehicles.forEach(function(v){ if(v.price > 0 || v.minLevel > 0) free = false; }); }); }); });
    note.textContent = free ? "Every vehicle is free: test drive it, then get it." : "Test drive any of them, then get it.";
    if(!M.tabs.some(function(k){ return k.kind === kindNow; }) && M.tabs[0]) kindNow = M.tabs[0].kind;
    M.tabs.forEach(function(k){
      var t = mk("button", "hqdealer-tab" + (k.kind === kindNow ? " on" : ""), tabs, k.label);
      t.type = "button"; t.setAttribute("role", "tab"); t.setAttribute("aria-selected", k.kind === kindNow ? "true" : "false");
      on(t, "click", function(){ kindNow = k.kind; pick = null; render(); });
    });
    M.tabs.filter(function(k){ return k.kind === kindNow; }).forEach(function(k){
      k.sections.forEach(function(s){
        var sec = mk("section", "hqdealer-type", body); mk("h3", null, sec, s.label);
        s.classes.forEach(function(cl){
          var row = mk("div", "hqdealer-class", sec);
          mk("div", "hqdealer-class-label", row, cl.label);
          var pair = mk("div", "hqdealer-pair", row);
          cl.vehicles.forEach(function(v){ if(!first) first = v; card(pair, v); });
        });
      });
    });
    var keep = pick && first ? findCard(M, pick.id) : null;
    if(keep || first) choose(keep || first);
    status.textContent = statusText;
  }
  function findCard(M, id){
    var hit = null;
    M.tabs.forEach(function(k){ k.sections.forEach(function(s){ s.classes.forEach(function(cl){ cl.vehicles.forEach(function(v){ if(v.id === id) hit = v; }); }); }); });
    return hit;
  }
  function card(parent, v){
    var c = mk("div", "hqdealer-card" + (pick && pick.id === v.id ? " on" : "") + (v.locked ? " locked" : ""), parent);
    var pickBtn = mk("button", "hqdealer-pick", c); pickBtn.type = "button"; pickBtn.setAttribute("aria-label", v.brand + " " + v.model + ": show it");
    mk("div", "hqdealer-brand", pickBtn, v.brand);
    mk("div", "hqdealer-model", pickBtn, v.model);
    mk("div", "hqdealer-spec", pickBtn, v.spec);
    on(pickBtn, "click", function(){ choose(v); [].forEach.call(body.querySelectorAll(".hqdealer-card.on"), function(n){ n.classList.remove("on"); }); c.classList.add("on"); });
    var pi = sel[v.id] || 0;
    var sw = mk("div", "hqdealer-paints", c), pname = mk("div", "hqdealer-paint-name", c, v.paints[pi] ? v.paints[pi].name : "");
    v.paints.forEach(function(p, i){
      var b = mk("button", "hqdealer-swatch" + (i === pi ? " on" : ""), sw);
      b.type = "button"; b.style.background = p.hex; b.title = p.name; b.setAttribute("aria-label", p.name);
      on(b, "click", function(){ sel[v.id] = i; pname.textContent = p.name; [].forEach.call(sw.children, function(n, j){ n.classList.toggle("on", j === i); }); choose(v); });
    });
    mk("div", "hqdealer-tag", c, v.locked ? "Needs level " + v.minLevel : v.priceText + (v.owned ? " · yours" : ""));
    var acts = mk("div", "hqdealer-acts", c);
    var test = mk("button", "hqdealer-test", acts, "Test drive"); test.type = "button";
    on(test, "click", function(){
      var p = v.paints[sel[v.id] || 0];
      close();
      if(opts.onTest) opts.onTest(v.id, p ? p.hex : null);
    });
    var get = mk("button", "hqdealer-get", acts, v.action); get.type = "button"; get.disabled = !v.canGet || busy;
    on(get, "click", function(){
      if(!v.canGet || busy || !opts.onGet) return;
      var p = v.paints[sel[v.id] || 0];
      busy = true; get.disabled = true; setStatus("Getting your " + v.brand + " " + v.model + "…");
      Promise.resolve(opts.onGet(v.id, p ? p.hex : null)).then(function(r){
        busy = false; setStatus((r && r.text) || ""); if(r && r.ok) refreshOwned(); else render();
      }, function(){ busy = false; setStatus("That didn't work. Try again in a moment."); render(); });
    });
  }
  function setStatus(t){ statusText = String(t || ""); status.textContent = statusText; if(statusText) announce(statusText); }
  function refreshOwned(){
    if(!opts.owned) return render();
    Promise.resolve(opts.owned()).then(function(ids){ owned = Array.isArray(ids) ? ids : []; if(open) render(); }, function(){ if(open) render(); });
  }

  function contain(e){
    e.hqDealerHandled = true;
    if(e.stopPropagation) e.stopPropagation();
    if(e.type === "keydown" && e.key === "Escape"){ if(e.preventDefault) e.preventDefault(); close(); }
  }
  on(root, "keydown", contain); on(root, "keyup", contain);
  on(closeBtn, "click", function(){ close(); });

  function openP(){
    if(open) return; open = true; root.hidden = false; statusText = ""; render(); refreshOwned();
    if(P || preview()) previewLoop();
    var f = root.querySelector(".hqdealer-tab.on") || closeBtn; if(f && f.focus) f.focus();
  }
  function close(){
    if(!open) return; open = false; root.hidden = true;
    if(P && P.raf && G.cancelAnimationFrame) G.cancelAnimationFrame(P.raf);
    if(opts.onClose) opts.onClose();
  }
  return {
    open: openP, close: close, isOpen: function(){ return open; }, render: render, root: root, status: setStatus,
    title: function(t){ title.textContent = "🚘 " + String(t || "Dealership"); root.setAttribute("aria-label", String(t || "Dealership")); },
    destroy: function(){
      close(); listeners.forEach(function(l){ l[0].removeEventListener(l[1], l[2]); }); listeners = [];
      if(P){ try { P.R.dispose(); } catch(e){} P = null; }
      if(root.parentNode) root.parentNode.removeChild(root);
    }
  };
}

HQV.hqDealer = {place: place, pick: pick, frame: frame, layout: layout, model: model, priceText: priceText, build: build,
                mountPanel: mountPanel, owns: owns, MIN_TIER: MIN_TIER, SITE_ID: SITE_ID, TEST_S: 180};
})();
