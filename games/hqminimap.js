/* Claude HQ 3D city: the minimap in the bottom-right corner (HQV.hqminimap, nav-river spec 3.1).
 *
 * Two canvases, nothing leaves the machine:
 *   static   built once per setWorld, never in frame(): the sea, the island's land, the river and its
 *            harbour basin, the roads by class width (edges whose min_tier is above the tier left out),
 *            in a north-up world bitmap (about 1.5 px/m), plus an atlas of the POI icons
 *   overlay  the visible canvas, redrawn by frame(): the bitmap under a rotation and scale, the POI
 *            icons (upright, from the atlas), the route, the waypoint pin, other players, you (an
 *            arrow) and the N marker on the rim
 *
 * Bearings (as games/hqhud.js): yaw 0 faces +z and increasing yaw turns LEFT; the clockwise heading
 * is -yaw; N = +z, E = -x. North-up puts +z at the top and -x on the right; heading-up turns the map
 * so where you face is up, and puts you 62% of the way down so more of the road ahead shows.
 *
 * A view is {x, z (m, the anchor's world point), rot (rad: the map's turn, the heading in heading-up,
 * 0 north-up), span (m across the width), w, h (CSS px), ay (the anchor's height, 0..1)}.
 *   toMini(view, x, z) -> [px, py]    CSS px inside the minimap
 *   fromMini(view, px, py) -> [x, z]  its inverse (a click -> the world point under it)
 *   zoomFor(speedMps) -> span         220 m on foot easing up to 600 m at 60 km/h and over
 *
 * HQ 3.15 (@3 docs): the static layer also has the lakes, canals and the marina (W.water: water, their islands as land,
 * a stone edge on quays, the breakwater) and the piers as dots; frame() draws the lines over it as vectors: the metro
 * (M1, M2) in its line colour, dashed where it runs underground, with a ring at each station, the City Line and the
 * Island Link (dashed in tunnel), the gondola (dotted, square stations); the big map names each line at its first
 * station, so colour is never the only signal. Underground mode (opts.under() true, e.g. on a metro platform or
 * riding one) dims the surface to UNDER_DIM and draws the metro solid, wider and brighter on top.
 *
 * Mounted by the 3D City (games/hqcity3d.js):
 *   HQV.hqminimap.mount(stageEl, {onPick(x, z), onExpand(), announce, under()}) -> mm
 *     mm.setWorld(W, tier, {places, coast, river})  W: the packed world (HQV.world.pack); places: hqnav
 *                     Places (m; default: W's civic sites at this tier); coast, river: cm, as the doc's
 *                     layers (default W.island.coast and W.river)
 *     mm.setAirfield(L | null)  the airfield (games/hqairfield.js layout, docs/plans/airport-spec.md 8) painted into the
 *                     world bitmap in its real colours: the platform's grass, the apron, taxiways, the runway and its
 *                     pads, the service road, the landside roads, the terminal, concourse and skybridge. Kept across
 *                     setWorld for the same world; null takes it out. It redraws into the same bitmap canvas.
 *     mm.frame({x, z, yaw, view?, speed, route, waypoint, others, dt?})   view: the camera's heading (heading-up turns
 *                    by it; default yaw); yaw: where you face (the arrow)
 *     mm.setMode("heading" | "north"), mm.mode(), mm.zoom(+1 | -1), mm.view(), mm.destroy()
 * Clicks and taps call onPick with the world point (the host snaps it to a road); the wheel and the
 * +/- buttons zoom; one button toggles heading-up / north-up, another calls onExpand (the full map).
 * Keys inside the minimap never reach the dashboard or the avatar (stopPropagation + preventDefault).
 */
(function(){
"use strict";
var HQV = window.HQV = window.HQV || {};

var PI = Math.PI;
var WALK_SPAN = 220, DRIVE_SPAN = 600;        // m across: on foot, and at 60 km/h and over
var WALK_V = 1.6, DRIVE_V = 60/3.6;           // m/s
var ZOOM_STEP = 1.5, ZOOM_MIN = -3, ZOOM_MAX = 3;
var SPAN_K = 3;                               // 1/s: how fast the span eases to its target
var HEAD_AY = 0.62;                           // heading-up: you sit 62% of the way down
var BIG_FILL = 0.8;                           // the big map (M): the world's width fills 80% of the box at first
var SWING_K = 6, PAN_K = 10;                  // 1/s: the big map swings north-up / glides to a pan
var BITMAP_MAX = 3072, BITMAP_PX_M = 2;       // the static bitmap: device px at most, px per m at most
var MARGIN = 60;                              // m of sea round the world in the bitmap
var ICON = 18;                                // CSS px: a POI icon's disc
var UNDER_DIM = 0.3;                          // underground mode: the surface's alpha
var PIER_M = 3;                               // m: a pier's dot radius in the bitmap (at least 1.5 px)
// the transit lines' colours (canvas only; the line's name is drawn beside it on the big map)
var LINE_COL = {M1: "#d64541", M2: "#2f6fd1", CL: "#3f8f4f", IL: "#8e5bd0", G1: "#d08a1f"};
var KIND_COL = {metro: "#c2185b", city: "#3f8f4f", island: "#8e5bd0", gondola: "#d08a1f"};
var ROAD_M = {highway: 22, ring: 18, arterial: 14, avenue: 14, local: 9, street: 9};   // drawn widths
var ROAD_RANK = {local: 0, street: 0, arterial: 1, avenue: 1, ring: 2, highway: 3};
// The POI kinds the minimap shows (hqnav Place kinds), their disc colour and pictogram.
var POI = {
  dock: {col: "#2f7fc1", g: "anchor"}, port: {col: "#1f5f9e", g: "anchor"},
  transit: {col: "#2a9d8f", g: "bus"}, airport: {col: "#5b6b8c", g: "plane"},
  townhall: {col: "#8a6d3b", g: "hall"}, hospital: {col: "#c9372c", g: "cross"}, clinic: {col: "#d4574c", g: "cross"},
  police: {col: "#2d4a8a", g: "shield"}, fire: {col: "#d0611f", g: "flame"}, market: {col: "#3f8f4f", g: "basket"},
  school: {col: "#a07a12", g: "book"}, myhq: {col: "#ffb347", g: "star"}, hq: {col: "#5fd3e6", g: "house"},
  dealer: {col: "#1c66b5", g: "car"}, tuning: {col: "#b8452c", g: "wrench"},   // [3.13] the Tuning shop (games/hqtuning.js)
  carpark: {col: "#1f6fd1", g: "parking"}
};
var POI_ORDER = ["hq", "school", "market", "fire", "police", "clinic", "hospital", "townhall", "airport", "transit", "dealer", "tuning", "dock", "port", "carpark", "myhq"];
var PAL = {
  dark: {sea: "#0f2a3d", land: "#1d2620", landEdge: "#33503f", water: "#1a4a6b", bank: "#2f6f8f", quay: "#8a8578", pier: "#c8b48a",
         station: "#ffffff",
         road: {highway: "#c99a4a", ring: "#b08a50", arterial: "#8d939c", avenue: "#8d939c", local: "#5d636b", street: "#5d636b"},
         casing: "#0b0d10", bridge: "#d8d2c4", route: "#e2805e", routeCase: "#3a1c10", you: "#ffffff", youEdge: "#e2805e",
         pin: "#e2805e", rim: "#ecebe8", other: "#5fd3e6"},
  light: {sea: "#a9cfe6", land: "#eef0e6", landEdge: "#c9d3bf", water: "#8cc0e0", bank: "#6aa3c8", quay: "#8f897c", pier: "#9a7b4a",
          station: "#ffffff",
          road: {highway: "#e3a64a", ring: "#d6a35c", arterial: "#ffffff", avenue: "#ffffff", local: "#fbfbf8", street: "#fbfbf8"},
          casing: "#b9b4aa", bridge: "#7b7466", route: "#b64e2b", routeCase: "#ffffff", you: "#1d1c1a", youEdge: "#ffffff",
          pin: "#b64e2b", rim: "#1d1c1a", other: "#1f7a8c"}
};

function clamp(v, a, b){ return v < a ? a : v > b ? b : v; }
function num(v, d){ v = +v; return isFinite(v) ? v : d; }
function ease(k, dt){ return 1 - Math.exp(-Math.max(0, +k || 0)*Math.max(0, +dt || 0)); }
function hexCol(c, d){
  if(typeof c === "number" && isFinite(c)){ var s = (c >>> 0 & 0xffffff).toString(16); while(s.length < 6) s = "0" + s; return "#" + s; }
  if(typeof c === "string" && /^#[0-9a-f]{3,8}$/i.test(c)) return c;
  return d;
}

// ---- pure helpers ---------------------------------------------------------------------------

// m across the minimap for a speed: 220 m on foot easing (smoothstep) to 600 m at 60 km/h and over.
function zoomFor(speedMps){
  var t = clamp((Math.abs(num(speedMps, 0)) - WALK_V)/(DRIVE_V - WALK_V), 0, 1);
  t = t*t*(3 - 2*t);
  return WALK_SPAN + (DRIVE_SPAN - WALK_SPAN)*t;
}

// World (m) -> minimap CSS px. North-up: u = -(x - vx)*s (E = -x on the right), v = -(z - vz)*s
// (N = +z at the top), then the map turns by -rot so the heading points up.
function toMini(V, x, z){
  var s = V.w/V.span, u = -(x - V.x)*s, v = -(z - V.z)*s, c = Math.cos(V.rot), n = Math.sin(V.rot);
  return [V.w/2 + u*c + v*n, V.h*V.ay - u*n + v*c];
}
function fromMini(V, px, py){
  var s = V.w/V.span, a = px - V.w/2, b = py - V.h*V.ay, c = Math.cos(V.rot), n = Math.sin(V.rot);
  var u = a*c - b*n, v = a*n + b*c;
  return [V.x - u/s, V.z - v/s];
}

// The view for a player state: heading-up turns by the clockwise heading (-yaw) and anchors low.
function viewFor(mode, x, z, yaw, span, w, h){
  var north = mode === "north";
  return {x: num(x, 0), z: num(z, 0), rot: north ? 0 : -num(yaw, 0), span: span, w: w, h: h, ay: north ? 0.5 : HEAD_AY};
}

// A point pushed onto the box inset by m px, along the line from the box's centre, when it is outside.
// Returns [px, py, clamped].
function edgeClamp(px, py, w, h, m){
  var cx = w/2, cy = h/2, dx = px - cx, dy = py - cy, hx = w/2 - m, hy = h/2 - m;
  if(Math.abs(dx) <= hx && Math.abs(dy) <= hy) return [px, py, false];
  var t = Math.min(dx ? hx/Math.abs(dx) : Infinity, dy ? hy/Math.abs(dy) : Infinity);
  return [cx + dx*t, cy + dy*t, true];
}

// The civic places of a packed world at a tier (sites, cm -> m) when the host hands none.
function sitePlaces(W, tier){
  var out = [];
  (W && W.sites || []).forEach(function(s){
    if(!s || !POI[s.kind] || s.kind === "myhq" || s.kind === "hq") return;
    if(s.tier != null && tier != null && s.tier > tier) return;
    out.push({id: s.id, kind: s.kind, label: s.kind, x: (s.x|0)/100, z: (s.z|0)/100});
  });
  return out;
}

// ---- the static layer -----------------------------------------------------------------------

function palette(el){
  var dark = true;
  try {
    var bg = window.getComputedStyle(el).getPropertyValue("--bg");
    var m = /#([0-9a-f]{6})/i.exec(String(bg || ""));
    if(m){ var v = parseInt(m[1], 16); dark = (0.299*(v >> 16) + 0.587*(v >> 8 & 255) + 0.114*(v & 255)) < 128; }
  } catch(e){}
  return dark ? PAL.dark : PAL.light;
}

function polyPath(g, poly, ox, oz, k){
  g.beginPath();
  for(var i = 0; i < poly.length; i++){
    var p = poly[i], bx = (ox - p[0]/100)*k, by = (oz - p[1]/100)*k;
    if(i) g.lineTo(bx, by); else g.moveTo(bx, by);
  }
  g.closePath();
}

// The world bitmap: north-up, bitmap px (bx, by) = ((x1 - x)*k, (z1 - z)*k) for world m (x, z). reuse: a canvas
// to draw into again (setAirfield) instead of a new one.
function buildStatic(doc, W, tier, coast, river, pal, dpr, reuse){
  var half = num(W && W.half, 1024) + MARGIN, span = 2*half;
  var k = Math.min(BITMAP_PX_M, (dpr >= 2 ? BITMAP_MAX : BITMAP_MAX*2/3)/span);
  var n = Math.max(1, Math.ceil(span*k));
  var cv = reuse || doc.createElement("canvas");
  if(cv.width !== n) cv.width = n;
  if(cv.height !== n) cv.height = n;
  var g = cv.getContext("2d");
  var B = {cv: cv, g: g, k: k, x1: half, z1: half, n: n};
  if(!g) return B;
  g.fillStyle = pal.sea; g.fillRect(0, 0, n, n);
  // the land: the island's coast, else (claude-hq@1) the whole square
  if(Array.isArray(coast) && coast.length > 2){
    polyPath(g, coast, half, half, k);
    g.fillStyle = pal.land; g.fill();
    g.lineWidth = Math.max(1, 3*k); g.strokeStyle = pal.landEdge; g.stroke();
  } else {
    var h0 = num(W && W.half, 1024);
    g.fillStyle = pal.land; g.fillRect((half - h0)*k, (half - h0)*k, 2*h0*k, 2*h0*k);
  }
  // the river and its harbour basin: one water outline
  if(river && Array.isArray(river.poly) && river.poly.length > 2){
    polyPath(g, river.poly, half, half, k);
    g.fillStyle = pal.water; g.fill();
    g.lineWidth = Math.max(1, 2*k); g.strokeStyle = pal.bank; g.stroke();
  }
  // @3: the lakes, canals and the marina (their islands are land), a stone edge on quays, the breakwater
  var WL = W && W.water;
  if(WL && Array.isArray(WL.bodies)){
    WL.bodies.forEach(function(b){
      if(!b || !Array.isArray(b.poly) || b.poly.length < 3) return;
      polyPath(g, b.poly, half, half, k);
      g.fillStyle = pal.water; g.fill();
      g.lineWidth = Math.max(1, (b.edge === "quay" ? 2.5 : 2)*k); g.strokeStyle = b.edge === "quay" ? pal.quay : pal.bank; g.stroke();
      (b.islands || []).forEach(function(I){
        if(!Array.isArray(I) || I.length < 3) return;
        polyPath(g, I, half, half, k);
        g.fillStyle = pal.land; g.fill();
        g.lineWidth = Math.max(1, 2*k); g.strokeStyle = pal.bank; g.stroke();
      });
    });
    var bw = WL.breakwater;
    if(Array.isArray(bw) && bw.length >= 2){
      g.beginPath();
      bw.forEach(function(p, i){ var bx = (half - p[0]/100)*k, by = (half - p[1]/100)*k; if(i) g.lineTo(bx, by); else g.moveTo(bx, by); });
      g.lineCap = "round"; g.lineWidth = Math.max(1.5, 8*k); g.strokeStyle = pal.quay; g.stroke();
    }
  }
  // the roads, minor classes first, casings under fills; bridges get a pale casing over the water
  var edges = ((W && W.edges) || []).filter(function(e){ return e && e.pts && e.pts.length >= 6 && !(e.min_tier != null && tier != null && e.min_tier > tier); });
  edges.sort(function(a, b){ return ((ROAD_RANK[a.cls] || 0) - (ROAD_RANK[b.cls] || 0)) || (a.id - b.id); });
  function trace(e){
    var P = e.pts;
    g.beginPath();
    for(var i = 0; i + 2 < P.length; i += 3){
      var bx = (half - P[i]/100)*k, by = (half - P[i + 2]/100)*k;
      if(i) g.lineTo(bx, by); else g.moveTo(bx, by);
    }
  }
  g.lineCap = "round"; g.lineJoin = "round";
  for(var pass = 0; pass < 2; pass++){
    for(var i = 0; i < edges.length; i++){
      var e = edges[i], wm = ROAD_M[e.cls] || 9;
      trace(e);
      if(pass === 0){ g.strokeStyle = e.bridge ? pal.bridge : pal.casing; g.lineWidth = (wm + 4)*k; }
      else { g.strokeStyle = pal.road[e.cls] || pal.road.local; g.lineWidth = wm*k; }
      g.stroke();
    }
  }
  // @3: the piers, as dots at their heads
  if(WL && Array.isArray(WL.piers)) WL.piers.forEach(function(p){
    if(!p || !isFinite(+p.x) || !isFinite(+p.z)) return;
    var f = p.front || [0, 65536], fl = Math.hypot(+f[0] || 0, +f[1] || 0) || 1, L = (+p.len || 0)/2;
    var x = (+p.x + (+f[0] || 0)/fl*L)/100, z = (+p.z + (+f[1] || 0)/fl*L)/100;
    g.beginPath(); g.arc((half - x)*k, (half - z)*k, Math.max(1.5, PIER_M*k), 0, 2*PI);
    g.fillStyle = pal.pier; g.fill(); g.lineWidth = Math.max(1, 0.8*k); g.strokeStyle = pal.casing; g.stroke();
  });
  return B;
}

// The lines a world's doc lays (W.metro, W.rail, W.gondola; cm) as metre polylines for frame():
// [{id, kind: "metro"|"city"|"island"|"gondola", col, segs: [{pts: [[x, z]...], under}], stations: [[x, z]...]}]
function transitLines(W){
  var out = [];
  function m(v){ return (+v || 0)/100; }
  function segsOf(path, kinds, underK){
    var segs = [], cur = null;
    for(var i = 0; i + 1 < (path || []).length; i++){
      var a = path[i], b = path[i + 1];
      if(!a || !b) continue;
      var u = !!underK[String((kinds || [])[i])];
      if(!cur || cur.under !== u){ cur = {pts: [[m(a[0]), m(a[2])]], under: u}; segs.push(cur); }
      cur.pts.push([m(b[0]), m(b[2])]);
    }
    return segs;
  }
  function stationsOf(ids, list){
    var by = {};
    (list || []).forEach(function(s){ if(s && s.id != null) by[s.id] = s; });
    return (ids || []).map(function(id){ return by[id]; }).filter(Boolean).map(function(s){ return [m(s.x), m(s.z)]; });
  }
  var Mt = W && W.metro;
  if(Mt) (Mt.lines || []).forEach(function(l){
    if(!l) return;
    out.push({id: String(l.id), kind: "metro", col: LINE_COL[l.id] || KIND_COL.metro,
              segs: segsOf(l.path, l.kinds, {bored: 1, cutcover: 1}), stations: stationsOf(l.stations, Mt.stations)});
  });
  var Rl = W && W.rail;
  if(Rl) (Rl.lines || []).forEach(function(l){
    if(!l) return;
    var kind = l.kind === "island" ? "island" : "city";
    out.push({id: String(l.id), kind: kind, col: LINE_COL[l.id] || KIND_COL[kind],
              segs: segsOf(l.path, l.kinds, {tunnel: 1}), stations: stationsOf(l.stations, Rl.stations)});
  });
  var Gd = W && W.gondola;
  if(Gd) (Gd.lines || []).forEach(function(l){
    if(!l) return;
    var st = (l.stations || []).filter(Boolean), pts = [];
    // the cable: station, towers in order along it, station
    if(st.length >= 2){
      var a = [m(st[0].x), m(st[0].z)], b = [m(st[st.length - 1].x), m(st[st.length - 1].z)], dx = b[0] - a[0], dz = b[1] - a[1];
      pts = [a].concat((l.towers || []).filter(Boolean).map(function(t){ return [m(t.x), m(t.z)]; })
             .sort(function(p, q){ return ((p[0] - a[0])*dx + (p[1] - a[1])*dz) - ((q[0] - a[0])*dx + (q[1] - a[1])*dz); })).concat([b]);
    }
    out.push({id: String(l.id), kind: "gondola", col: LINE_COL[l.id] || KIND_COL.gondola,
              segs: pts.length >= 2 ? [{pts: pts, under: false}] : [], stations: st.map(function(s){ return [m(s.x), m(s.z)]; })});
  });
  return out;
}

// The airfield's real colours (docs/plans/airport-spec.md 4), the same in both palettes
var AIR_COL = {grass: "#6f8f4f", apron: "#a8a69e", taxi: "#3a3d42", taxiEdge: "#55585c", runway: "#2b2d30", runwayEdge: "#4a4d52",
               pad: "#55575b", road: "#3a3d42", paint: "#f2f2ee", roof: "#d6dade", glass: "#9fb4c4", carpark: "#8e9096"};
function isPt(p){ return Array.isArray(p) && p.length >= 2 && isFinite(p[0]) && isFinite(p[1]); }
// L (world m) into the bitmap B: polygons filled, polylines stroked at their real widths
function paintAirfield(B, L){
  var g = B && B.g;
  if(!g || !L || L.ok === false) return;
  var k = B.k;
  function trace(P, closed){
    if(!Array.isArray(P) || P.length < 2 || !P.every(isPt)) return false;
    g.beginPath();
    for(var i = 0; i < P.length; i++){ var bx = (B.x1 - P[i][0])*k, by = (B.z1 - P[i][1])*k; if(i) g.lineTo(bx, by); else g.moveTo(bx, by); }
    if(closed) g.closePath();
    return true;
  }
  function fill(P, col){ if(trace(P, true)){ g.fillStyle = col; g.fill(); } }
  function line(P, w, col, cap){ if(trace(P, false)){ g.lineCap = cap || "round"; g.lineJoin = "round"; g.lineWidth = Math.max(1, w*k); g.strokeStyle = col; g.stroke(); } }
  // a strip along a -> b, w wide, ext m past each end
  function strip(a, b, w, ext, col){
    if(!isPt(a) || !isPt(b)) return;
    var dx = b[0] - a[0], dz = b[1] - a[1], l = Math.hypot(dx, dz) || 1, ux = dx/l, uz = dz/l, h = w/2;
    var a2 = [a[0] - ux*ext, a[1] - uz*ext], b2 = [b[0] + ux*ext, b[1] + uz*ext];
    fill([[a2[0] - uz*h, a2[1] + ux*h], [b2[0] - uz*h, b2[1] + ux*h], [b2[0] + uz*h, b2[1] - ux*h], [a2[0] + uz*h, a2[1] - ux*h]], col);
  }
  (L.platform || []).forEach(function(P){ fill(P, AIR_COL.grass); });
  (L.apron || []).forEach(function(P){ fill(P, AIR_COL.apron); });
  var sv = L.service || {};
  ["fuel", "fire", "hangars", "depot"].forEach(function(id){ fill(sv[id], AIR_COL.apron); });
  // the taxiways (every line but the runway, every curve but the stands' lead-ins): shoulders, then pavement
  var W = L.widths || {}, sh = num(W.shoulder, 3.5), lines = L.lines || {}, curves = L.curves || {}, taxi = [];
  Object.keys(lines).sort().forEach(function(id){ if(id !== "RWY") taxi.push([lines[id], num(W[id], 18)]); });
  Object.keys(curves).sort().forEach(function(id){ if(id.charAt(0) !== "S") taxi.push([curves[id], 18]); });
  taxi.forEach(function(t){ line(t[0], t[1] + 2*sh, AIR_COL.taxiEdge); });
  taxi.forEach(function(t){ line(t[0], t[1], AIR_COL.taxi); });
  // the runway: shoulders, the blast pads, the pavement and its centreline
  var R = L.runway || {}, E = R.ends || [], rw = num(R.w, 45), rsh = num(R.shoulder, 7.5);
  if(E.length >= 2 && isPt(E[0].thr) && isPt(E[1].thr)){
    strip(E[0].thr, E[1].thr, rw + 2*rsh, 0, AIR_COL.runwayEdge);
    E.forEach(function(e){ if(e.pad && e.pad.length >= 2) strip(e.pad[0], e.pad[1], rw, 0, AIR_COL.pad); });
    strip(E[0].thr, E[1].thr, rw, 0, AIR_COL.runway);
    line([E[0].thr, E[1].thr], 0.9, AIR_COL.paint, "butt");
  }
  line(L.serviceRoad, num(L.serviceRoadW, 6), AIR_COL.road);
  // landside: the roads, the car park, the terminal and its canopy, the skybridge, the concourse
  var ls = L.landside || {}, roadW = num(ls.roadW, 8);
  line(ls.access, roadW, AIR_COL.road, "butt");
  line(ls.forecourt, roadW, AIR_COL.road);
  fill(ls.carpark, AIR_COL.carpark);
  fill(ls.terminal, AIR_COL.roof);
  fill(ls.canopy, AIR_COL.glass);
  if(ls.skybridge) line([ls.skybridge.a, ls.skybridge.b], num(ls.skybridge.w, 8), AIR_COL.glass, "butt");
  fill(L.concourse, AIR_COL.roof);
}

// The pictograms, white on a coloured disc, drawn in a unit box centred on 0 (radius 1).
function glyph(g, kind, disc){
  g.beginPath();
  switch(kind){
    case "anchor":
      g.arc(0, -0.5, 0.14, 0, 2*PI); g.moveTo(0, -0.36); g.lineTo(0, 0.55);
      g.moveTo(-0.3, -0.15); g.lineTo(0.3, -0.15);
      g.moveTo(-0.5, 0.15); g.quadraticCurveTo(-0.45, 0.55, 0, 0.55); g.quadraticCurveTo(0.45, 0.55, 0.5, 0.15);
      g.stroke(); return;
    case "bus":
      g.rect(-0.45, -0.5, 0.9, 0.85); g.fill(); g.beginPath();
      g.fillStyle = disc; g.rect(-0.33, -0.36, 0.66, 0.32); g.fill();
      g.fillStyle = "#fff"; g.beginPath(); g.arc(-0.25, 0.45, 0.1, 0, 2*PI); g.arc(0.25, 0.45, 0.1, 0, 2*PI); g.fill(); return;
    case "plane":
      g.moveTo(0, -0.6); g.lineTo(0.08, -0.1); g.lineTo(0.6, 0.15); g.lineTo(0.08, 0.1); g.lineTo(0.06, 0.4);
      g.lineTo(0.22, 0.55); g.lineTo(-0.22, 0.55); g.lineTo(-0.06, 0.4); g.lineTo(-0.08, 0.1); g.lineTo(-0.6, 0.15);
      g.lineTo(-0.08, -0.1); g.closePath(); g.fill(); return;
    case "hall":
      g.moveTo(-0.55, -0.2); g.lineTo(0, -0.55); g.lineTo(0.55, -0.2); g.closePath(); g.fill();
      g.fillRect(-0.5, 0.4, 1, 0.14);
      for(var c = -0.36; c <= 0.37; c += 0.24) g.fillRect(c - 0.05, -0.15, 0.1, 0.52);
      return;
    case "cross":
      g.fillRect(-0.15, -0.5, 0.3, 1); g.fillRect(-0.5, -0.15, 1, 0.3); return;
    case "shield":
      g.moveTo(0, -0.55); g.lineTo(0.45, -0.38); g.quadraticCurveTo(0.42, 0.3, 0, 0.58);
      g.quadraticCurveTo(-0.42, 0.3, -0.45, -0.38); g.closePath(); g.fill(); return;
    case "flame":
      g.moveTo(0, -0.6); g.quadraticCurveTo(0.55, -0.05, 0.38, 0.3); g.quadraticCurveTo(0.2, 0.6, 0, 0.58);
      g.quadraticCurveTo(-0.45, 0.55, -0.38, 0.15); g.quadraticCurveTo(-0.3, -0.15, 0, -0.6); g.fill(); return;
    case "basket":
      g.moveTo(-0.55, -0.1); g.lineTo(0.55, -0.1); g.lineTo(0.38, 0.5); g.lineTo(-0.38, 0.5); g.closePath(); g.fill();
      g.beginPath(); g.arc(0, -0.1, 0.32, PI, 2*PI); g.stroke(); return;
    case "book":
      g.moveTo(0, -0.3); g.quadraticCurveTo(-0.3, -0.5, -0.55, -0.4); g.lineTo(-0.55, 0.4); g.quadraticCurveTo(-0.3, 0.3, 0, 0.5);
      g.quadraticCurveTo(0.3, 0.3, 0.55, 0.4); g.lineTo(0.55, -0.4); g.quadraticCurveTo(0.3, -0.5, 0, -0.3); g.fill(); return;
    case "star":
      for(var i = 0; i < 10; i++){
        var r = i % 2 ? 0.26 : 0.62, a = -PI/2 + i*PI/5;
        if(i) g.lineTo(r*Math.cos(a), r*Math.sin(a)); else g.moveTo(r*Math.cos(a), r*Math.sin(a));
      }
      g.closePath(); g.fill(); return;
    case "car":
      g.moveTo(-0.6, 0.25); g.lineTo(-0.55, -0.05); g.lineTo(-0.3, -0.1); g.lineTo(-0.15, -0.38); g.lineTo(0.25, -0.38);
      g.lineTo(0.42, -0.1); g.lineTo(0.6, -0.02); g.lineTo(0.6, 0.25); g.closePath(); g.fill();
      g.fillStyle = disc; g.beginPath(); g.arc(-0.32, 0.27, 0.15, 0, 2*PI); g.arc(0.32, 0.27, 0.15, 0, 2*PI); g.fill(); return;
    case "wrench":                                                       // [3.13] an open-ended spanner, on the slant
      g.lineWidth = 0.22; g.lineCap = "round"; g.moveTo(-0.42, 0.42); g.lineTo(0.12, -0.12); g.stroke();
      g.beginPath(); g.arc(0.24, -0.24, 0.27, 0, 2*PI); g.fill();
      g.fillStyle = disc; g.beginPath(); g.moveTo(0.24, -0.24); g.lineTo(0.62, -0.42); g.lineTo(0.42, -0.62); g.closePath(); g.fill(); return;
    case "parking":
      g.lineWidth = 0.26; g.lineCap = "butt"; g.lineJoin = "round";
      g.moveTo(-0.24, 0.56); g.lineTo(-0.24, -0.5); g.lineTo(0.08, -0.5);
      g.quadraticCurveTo(0.46, -0.5, 0.46, -0.16); g.quadraticCurveTo(0.46, 0.18, 0.08, 0.18); g.lineTo(-0.24, 0.18);
      g.stroke(); return;
    case "house":
      g.moveTo(-0.5, -0.05); g.lineTo(0, -0.52); g.lineTo(0.5, -0.05); g.lineTo(0.38, -0.05); g.lineTo(0.38, 0.48);
      g.lineTo(-0.38, 0.48); g.lineTo(-0.38, -0.05); g.closePath(); g.fill(); return;
  }
}

// One row of icons, each ICON CSS px (times dpr) with a 1 px pad, in POI_ORDER.
function buildAtlas(doc, dpr){
  var cell = Math.ceil((ICON + 2)*dpr), cv = doc.createElement("canvas");
  cv.width = cell*POI_ORDER.length; cv.height = cell;
  var g = cv.getContext("2d"), at = {cv: cv, cell: cell, idx: {}};
  POI_ORDER.forEach(function(kind, i){ at.idx[kind] = i; });
  if(!g) return at;
  POI_ORDER.forEach(function(kind, i){
    var P = POI[kind], r = ICON*dpr/2;
    g.setTransform(1, 0, 0, 1, i*cell + cell/2, cell/2);
    g.beginPath(); g.arc(0, 0, r, 0, 2*PI);
    g.fillStyle = P.col; g.fill();
    g.lineWidth = Math.max(1, 1.5*dpr); g.strokeStyle = "rgba(255,255,255,0.9)"; g.stroke();
    g.setTransform(r*0.78, 0, 0, r*0.78, i*cell + cell/2, cell/2);
    g.fillStyle = "#fff"; g.strokeStyle = "#fff"; g.lineWidth = 0.14; g.lineCap = "round";
    glyph(g, P.g, P.col);
  });
  g.setTransform(1, 0, 0, 1, 0, 0);
  return at;
}

// ---- DOM ------------------------------------------------------------------------------------

function mount(el, opts){
  opts = opts || {};
  var doc = window.document || (typeof document !== "undefined" ? document : null);
  var announce = typeof opts.announce === "function" ? opts.announce : function(){};
  var onPick = typeof opts.onPick === "function" ? opts.onPick : function(){};
  var onExpand = typeof opts.onExpand === "function" ? opts.onExpand : function(){};
  var underFn = typeof opts.under === "function" ? opts.under : function(){ return false; }, wasUnder = false;
  var domL = [], alive = true;
  var mode = "heading", level = 0, span = null, lastT = null, W = null, tier = null;
  var stat = null, atlas = null, places = [], pal = PAL.dark, coastW = null, riverW = null, airL = null, lines = [];
  var cssW = 200, cssH = 200, dpr = 1, V = viewFor(mode, 0, 0, 0, WALK_SPAN, cssW, cssH);
  // the big map (M): the same canvas grown to most of the stage, north-up over the whole world, with a pan
  // (m, from you) you drag; rot/ay ease between heading-up and north-up so the map swings round as it grows
  var big = false, bigLevel = 0, pan = {x: 0, z: 0}, panTo = {x: 0, z: 0}, swing = 0, drag = null;

  function mk(tag, cls, parent){
    var n = doc.createElement(tag);
    if(cls) n.className = cls;
    (parent || root).appendChild(n);
    return n;
  }
  function on(n, type, fn, o){ n.addEventListener(type, fn, o); domL.push([n, type, fn, o]); }
  function btn(cls, text, label){
    var b = mk("button", "hq3d-minimap-btn " + cls, bar);
    b.setAttribute("type", "button");
    b.setAttribute("aria-label", label);
    b.setAttribute("title", label);
    b.textContent = text;
    return b;
  }

  var root = doc.createElement("div");
  root.className = "hq3d-minimap";
  root.setAttribute("role", "group");
  root.setAttribute("aria-label", "Minimap");
  root.setAttribute("data-under", "false");
  el.appendChild(root);
  var scrim = doc.createElement("div");           // the big map's backdrop (under it by z-index); a click closes it
  scrim.className = "hq3d-minimap-scrim";
  el.appendChild(scrim);
  var cv = mk("canvas", "hq3d-minimap-canvas");
  cv.setAttribute("aria-label", "Minimap: click to set a waypoint");
  cv.setAttribute("role", "img");
  var g = cv.getContext ? cv.getContext("2d") : null;
  var bar = mk("div", "hq3d-minimap-bar");
  var bIn = btn("hq3d-minimap-in", "+", "Zoom in");
  var bOut = btn("hq3d-minimap-out", "−", "Zoom out");
  var bMode = btn("hq3d-minimap-mode", "↑", "North up");
  var bExp = btn("hq3d-minimap-expand", "⤢", "Open the big map (M)");
  var legend = mk("div", "hq3d-minimap-legend");
  legend.textContent = "Click to set a waypoint · drag to pan · wheel to zoom · M or Esc to close";
  function syncMode(){
    var north = mode === "north";
    bMode.textContent = north ? "N" : "↑";
    bMode.setAttribute("aria-pressed", north ? "true" : "false");
    bMode.setAttribute("aria-label", north ? "Heading up" : "North up");
    bMode.setAttribute("title", north ? "Heading up" : "North up");
    root.setAttribute("data-mode", mode);
  }
  syncMode();

  // Canvas size: CSS px from the box (200, or 160 on narrow screens), times the device pixel ratio.
  function measure(){
    var w = Math.round(num(root.clientWidth, 0)) || Math.round(num(cv.clientWidth, 0)) || 200;
    var h = Math.round(num(root.clientHeight, 0)) || Math.round(num(cv.clientHeight, 0)) || w;
    var d = clamp(num(window.devicePixelRatio, 1), 1, 3);
    if(w === cssW && h === cssH && d === dpr && cv.width === Math.round(w*d)) return false;
    var dprChanged = d !== dpr;
    cssW = w; cssH = h; dpr = d;
    cv.width = Math.round(w*d); cv.height = Math.round(h*d);
    if(dprChanged && W) atlas = buildAtlas(doc, dpr);
    return true;
  }
  // A resize only marks the canvas stale; the next frame() resizes it. Sizing the canvas inside the observer's own
  // callback is a layout change in the observed box, which Chrome reports as a "ResizeObserver loop" error.
  var stale = false, ro = null;
  function markStale(){ stale = true; }
  if(typeof window.ResizeObserver === "function"){
    try { ro = new window.ResizeObserver(markStale); ro.observe(root); } catch(e){ ro = null; }
  }
  if(window.addEventListener){ window.addEventListener("resize", markStale); domL.push([window, "resize", markStale]); }
  measure();

  // ---- input ----
  function zoom(d){
    if(big){ bigLevel = clamp(bigLevel + (d > 0 ? 1 : d < 0 ? -1 : 0), -1, 5); return bigLevel; }
    var nl = clamp(level + (d > 0 ? 1 : d < 0 ? -1 : 0), ZOOM_MIN, ZOOM_MAX);
    if(nl === level) return level;
    level = nl;
    announce("Minimap zoom " + (level > 0 ? "in " + level : level < 0 ? "out " + (-level) : "auto"));
    return level;
  }
  function setMode(m){
    m = m === "north" ? "north" : "heading";
    if(m === mode) return mode;
    mode = m; syncMode();
    announce(mode === "north" ? "Minimap: north up" : "Minimap: heading up");
    return mode;
  }
  function flag(n, c, on){
    var L = String(n.className || "").split(/\s+/).filter(function(x){ return x && x !== c; });
    if(on) L.push(c);
    n.className = L.join(" ");
  }
  function expand(on){
    on = on == null ? !big : !!on;
    if(on === big) return big;
    big = on; bigLevel = 0; pan = {x: 0, z: 0}; panTo = {x: 0, z: 0}; drag = null;
    flag(root, "hq3d-minimap-big", big); flag(scrim, "hq3d-minimap-scrim-on", big);
    bExp.textContent = big ? "✕" : "⤢";
    bExp.setAttribute("aria-label", big ? "Close the big map (M)" : "Open the big map (M)");
    bExp.setAttribute("title", big ? "Close the big map (M)" : "Open the big map (M)");
    announce(big ? "Big map open: click to set a waypoint, M or Escape closes it" : "Big map closed");
    return big;
  }
  function pick(e){
    var r = cv.getBoundingClientRect ? cv.getBoundingClientRect() : {left: 0, top: 0, width: cssW, height: cssH};
    var px = (num(e.clientX, 0) - num(r.left, 0))*cssW/(num(r.width, cssW) || cssW);
    var py = (num(e.clientY, 0) - num(r.top, 0))*cssH/(num(r.height, cssH) || cssH);
    if(!(px >= 0 && py >= 0 && px <= cssW && py <= cssH)) return;
    var p = fromMini(V, px, py);
    try { onPick(p[0], p[1]); } catch(err){ if(window.console) console.error(err); }
  }
  function stop(e){ if(e.stopPropagation) e.stopPropagation(); }
  on(cv, "click", function(e){ stop(e); if(e.preventDefault) e.preventDefault(); if(drag && drag.moved){ drag = null; return; } drag = null; pick(e); });
  // the big map pans with a drag (a click that moved over 4 px is a drag, not a waypoint)
  on(cv, "pointerdown", function(e){ if(big && e.button === 0) drag = {x: num(e.clientX, 0), y: num(e.clientY, 0), moved: false}; });
  on(cv, "pointermove", function(e){
    if(!big || !drag || !(e.buttons & 1)) return;
    var dx = num(e.clientX, 0) - drag.x, dy = num(e.clientY, 0) - drag.y;
    if(!drag.moved && dx*dx + dy*dy < 16) return;
    drag.moved = true; drag.x = num(e.clientX, 0); drag.y = num(e.clientY, 0);
    var m = V.span/cssW;                         // north-up: right = -x, down = -z
    panTo.x += dx*m; panTo.z += dy*m; pan.x = panTo.x; pan.z = panTo.z;
  });
  on(scrim, "click", function(e){ stop(e); expand(false); });
  on(root, "wheel", function(e){
    stop(e); if(e.preventDefault) e.preventDefault();
    var d = num(e.deltaY, 0); if(d) zoom(d < 0 ? 1 : -1);
  }, {passive: false});
  // the 3D view under us must not take a click on the minimap as a look / pointer-lock click
  ["pointerdown", "pointerup", "mousedown", "mouseup", "touchstart", "touchend", "dblclick", "contextmenu"].forEach(function(t){ on(root, t, stop); });
  on(bIn, "click", function(e){ stop(e); zoom(1); });
  on(bOut, "click", function(e){ stop(e); zoom(-1); });
  on(bMode, "click", function(e){ stop(e); setMode(mode === "north" ? "heading" : "north"); });
  on(bExp, "click", function(e){ stop(e); try { onExpand(); } catch(err){ if(window.console) console.error(err); } });
  // A mouse click must not leave focus on a button, or a later Space (hop) would press it again.
  [bIn, bOut, bMode, bExp].forEach(function(b){ on(b, "mousedown", function(e){ if(e.preventDefault) e.preventDefault(); }); });
  // Keys never leak: Enter/Space press the focused button here (a host capture handler may cancel the
  // native click), +/- zoom, Escape gives focus back; everything is stopped and its default prevented.
  function onKey(e){
    var k = e.key;
    if(e.type === "keydown" && !e.repeat){
      if(k === "Enter" || k === " " || k === "Spacebar" || e.code === "Space"){
        var t = e.target;
        if((t === bIn || t === bOut || t === bMode || t === bExp) && t.click) t.click();
      } else if(k === "+" || k === "=") zoom(1);
      else if(k === "-" || k === "_") zoom(-1);
      else if((k === "Escape" || k === "Esc") && big) expand(false);
      else if((k === "Escape" || k === "Esc") && e.target && e.target.blur) e.target.blur();
    }
    if(k !== "Tab" && e.preventDefault) e.preventDefault();
    stop(e);
  }
  on(root, "keydown", onKey);
  on(root, "keyup", onKey);

  // ---- the static layer ----
  function setWorld(w, t, o){
    o = o || {};
    W = w || null; tier = t == null ? null : t|0;
    stat = null; atlas = null; places = []; lines = [];
    if(!W) return;
    lines = transitLines(W);
    measure();
    pal = palette(el);
    var coast = Array.isArray(o.coast) ? o.coast : (W.island && W.island.coast) || null;
    var river = o.river || W.river || null;
    coastW = coast; riverW = river;
    stat = buildStatic(doc, W, tier, coast, river, pal, dpr);
    if(airHere()) paintAirfield(stat, airL);
    atlas = buildAtlas(doc, dpr);
    var src = Array.isArray(o.places) ? o.places : sitePlaces(W, tier);
    src.forEach(function(p){
      if(!p || atlas.idx[p.kind] == null) return;
      var x = num(p.x, NaN), z = num(p.z, NaN);
      if(isFinite(x) && isFinite(z)) places.push({kind: p.kind, x: x, z: z, i: atlas.idx[p.kind], label: typeof p.label === "string" ? p.label.slice(0, 40) : ""});
    });
    // the higher-priority icons are drawn last, on top
    places.sort(function(a, b){ return a.i - b.i; });
  }

  // the airfield: on the world it was laid out for (an L without a world id goes on any)
  function airHere(){ return !!(airL && W && (!airL.world || !W.id || airL.world === W.id)); }
  function setAirfield(L){
    var next = L && typeof L === "object" && L.ok !== false && Array.isArray(L.platform) ? L : null;
    if(!next && !airL) return;
    airL = next;
    if(!W || !stat) return;
    // the bitmap again, into the same canvas: with the airfield on top, or without it
    stat = buildStatic(doc, W, tier, coastW, riverW, pal, dpr, stat.cv);
    if(airHere()) paintAirfield(stat, airL);
  }

  // ---- the overlay: one frame ----
  function arrow(cx, cy, ang, r){
    g.save();
    g.translate(cx, cy); g.rotate(ang);
    g.beginPath(); g.moveTo(0, -r); g.lineTo(0.72*r, 0.78*r); g.lineTo(0, 0.42*r); g.lineTo(-0.72*r, 0.78*r); g.closePath();
    g.fillStyle = pal.you; g.fill();
    g.lineWidth = 2; g.strokeStyle = pal.youEdge; g.stroke();
    g.restore();
  }
  // m across for the big map: the whole world (the static bitmap's box) fits the shorter side
  function bigSpan(){
    var wm = stat && stat.k ? stat.n/stat.k : 2400;
    return wm/BIG_FILL*Math.max(1, cssW/Math.max(1, cssH));
  }
  function frame(f){
    if(!alive || !g) return;
    if(stale){ stale = false; measure(); }
    f = f || {};
    var now = (window.performance && window.performance.now) ? window.performance.now() : Date.now();
    var dt = f.dt != null ? num(f.dt, 0) : (lastT == null ? 0 : (now - lastT)/1000);
    lastT = now;
    dt = clamp(dt, 0, 0.25);
    var target = big ? bigSpan()*Math.pow(ZOOM_STEP, -bigLevel) : zoomFor(f.speed)*Math.pow(ZOOM_STEP, -level);
    span = span == null ? target : span + (target - span)*ease(SPAN_K*(big ? 1.6 : 1), dt);
    // heading-up turns with the camera's heading (f.view, HQ 3.2) where the host gives it, so the map, the camera
    // and the compass agree; the arrow below still shows where you face
    V = viewFor(mode, f.x, f.z, f.view != null && isFinite(f.view) ? f.view : f.yaw, span, cssW, cssH);
    // swing (0 small .. 1 big) eases, so the map turns north-up as it grows and back to your heading as it shrinks
    swing += ((big ? 1 : 0) - swing)*ease(SWING_K, dt);
    if(!big && swing < 1e-3) swing = 0;
    if(swing > 0){
      V.rot = Math.atan2(Math.sin(V.rot), Math.cos(V.rot))*(1 - swing);
      V.ay += (0.5 - V.ay)*swing;
    }
    if(!big){ panTo.x = panTo.z = 0; }
    pan.x += (panTo.x - pan.x)*ease(PAN_K, dt); pan.z += (panTo.z - pan.z)*ease(PAN_K, dt);
    V.x += pan.x; V.z += pan.z;
    var s = cssW/span, c = Math.cos(V.rot), n = Math.sin(V.rot), ax = cssW/2, ay = cssH*V.ay;
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.fillStyle = pal.sea; g.fillRect(0, 0, cssW, cssH);
    // underground: the surface dims, the metro comes up bright (a flag on the box for the stylesheet too)
    var under = false;
    try { under = !!underFn(); } catch(err){ under = false; }
    if(under !== wasUnder){
      wasUnder = under;
      root.setAttribute("data-under", under ? "true" : "false");
      cv.setAttribute("aria-label", under ? "Minimap, underground: the metro lines. Click to set a waypoint" : "Minimap: click to set a waypoint");
    }
    g.globalAlpha = under ? UNDER_DIM : 1;
    if(stat && stat.g){
      // only the part of the bitmap under the view: its corners' world box -> a source rect
      var x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity, corners = [[0, 0], [cssW, 0], [0, cssH], [cssW, cssH]];
      for(var i = 0; i < 4; i++){
        var wp = fromMini(V, corners[i][0], corners[i][1]);
        if(wp[0] < x0) x0 = wp[0]; if(wp[0] > x1) x1 = wp[0]; if(wp[1] < z0) z0 = wp[1]; if(wp[1] > z1) z1 = wp[1];
      }
      var k = stat.k, sx = Math.max(0, Math.floor((stat.x1 - x1)*k) - 1), sy = Math.max(0, Math.floor((stat.z1 - z1)*k) - 1);
      var ex = Math.min(stat.n, Math.ceil((stat.x1 - x0)*k) + 1), ey = Math.min(stat.n, Math.ceil((stat.z1 - z0)*k) + 1);
      if(ex > sx && ey > sy){
        // bitmap px -> CSS px: u = (bx/k - (x1 - vx))*s, v = (by/k - (z1 - vz))*s, then turned by -rot
        var u0 = -(stat.x1 - V.x)*s, v0 = -(stat.z1 - V.z)*s, q = s/k;
        g.setTransform(dpr*c*q, -dpr*n*q, dpr*n*q, dpr*c*q, dpr*(ax + u0*c + v0*n), dpr*(ay - u0*n + v0*c));
        g.drawImage(stat.cv, sx, sy, ex - sx, ey - sy, sx, sy, ex - sx, ey - sy);
        g.setTransform(dpr, 0, 0, dpr, 0, 0);
      }
    }
    g.globalAlpha = 1;
    drawLines(s, c, n, ax, ay, under);
    // the route: a cased line through every point (m)
    var R = f.route;
    if(R && R.length >= 4){
      g.beginPath();
      for(var j = 0; j + 1 < R.length; j += 2){
        var u = -(R[j] - V.x)*s, v = -(R[j + 1] - V.z)*s, px = ax + u*c + v*n, py = ay - u*n + v*c;
        if(j) g.lineTo(px, py); else g.moveTo(px, py);
      }
      g.lineCap = "round"; g.lineJoin = "round";
      g.lineWidth = 7; g.strokeStyle = pal.routeCase; g.stroke();
      g.lineWidth = 4; g.strokeStyle = pal.route; g.stroke();
    }
    // the POI icons, upright, only those near the view
    if(atlas && atlas.cv && places.length){
      var cell = atlas.cell, half = cell/dpr/2, lim = Math.max(cssW, cssH);
      for(var p = 0; p < places.length; p++){
        var P = places[p], uu = -(P.x - V.x)*s, vv = -(P.z - V.z)*s, qx = ax + uu*c + vv*n, qy = ay - uu*n + vv*c;
        if(qx < -half || qy < -half || qx > lim + half || qy > lim + half) continue;
        g.drawImage(atlas.cv, P.i*cell, 0, cell, cell, qx - half, qy - half, 2*half, 2*half);
        if(big && P.label){                        // the big map names its places
          g.font = "600 11px system-ui, sans-serif"; g.textAlign = "left"; g.textBaseline = "middle";
          g.lineWidth = 3; g.strokeStyle = pal.casing; g.strokeText(P.label, qx + half + 3, qy);
          g.fillStyle = pal.rim; g.fillText(P.label, qx + half + 3, qy);
        }
      }
    }
    // other players
    var O = f.others;
    if(O && O.length){
      for(var o = 0; o < O.length; o++){
        var X = O[o]; if(!X) continue;
        var m = toMini(V, num(X.x, 0), num(X.z, 0));
        if(m[0] < -4 || m[1] < -4 || m[0] > cssW + 4 || m[1] > cssH + 4) continue;
        g.beginPath(); g.arc(m[0], m[1], 3.5, 0, 2*PI);
        g.fillStyle = hexCol(X.col, pal.other); g.fill();
        g.lineWidth = 1.5; g.strokeStyle = pal.casing; g.stroke();
      }
    }
    // the waypoint pin; off the map it sits on the rim, pointing out towards the waypoint
    var wpt = f.waypoint;
    if(wpt && isFinite(+wpt.x) && isFinite(+wpt.z)){
      var mp = toMini(V, +wpt.x, +wpt.z), e = edgeClamp(mp[0], mp[1], cssW, cssH, 12);
      g.fillStyle = pal.pin; g.strokeStyle = pal.youEdge; g.lineWidth = 2;
      if(e[2]){
        arrowPin(e[0], e[1], Math.atan2(mp[0] - cssW/2, -(mp[1] - cssH/2)));
      } else {
        g.beginPath(); g.moveTo(e[0], e[1]);
        g.bezierCurveTo(e[0] - 2, e[1] - 6, e[0] - 7, e[1] - 9, e[0] - 7, e[1] - 14);
        g.arc(e[0], e[1] - 14, 7, PI, 0);
        g.bezierCurveTo(e[0] + 7, e[1] - 9, e[0] + 2, e[1] - 6, e[0], e[1]);
        g.closePath(); g.fill(); g.stroke();
        g.beginPath(); g.arc(e[0], e[1] - 14, 2.5, 0, 2*PI); g.fillStyle = pal.youEdge; g.fill();
      }
    }
    // you: the arrow points where you face (up in heading-up)
    arrow(ax, ay, -num(f.yaw, 0) - V.rot, 8);
    // the N marker on the rim, where north (+z) lies from the map's centre
    var nx = -n, ny = -c, rr = Math.min(cssW, cssH)/2 - 11;
    var mx = cssW/2 + nx*rr, my = cssH/2 + ny*rr;
    g.beginPath(); g.arc(mx, my, 8, 0, 2*PI); g.fillStyle = pal.casing; g.fill();
    g.fillStyle = pal.rim; g.font = "700 10px system-ui, sans-serif"; g.textAlign = "center"; g.textBaseline = "middle";
    g.fillText("N", mx, my + 0.5);
  }
  // the transit lines as vectors over the map: metro dashed where it is underground (solid, wider, on top when under),
  // rail dashed in tunnel, the gondola dotted; stations as rings (squares on the gondola); names on the big map
  function drawLines(s, c, n, ax, ay, under){
    if(!lines.length) return;
    function P(p){ var u = -(p[0] - V.x)*s, v = -(p[1] - V.z)*s; return [ax + u*c + v*n, ay - u*n + v*c]; }
    var order = under ? lines.filter(function(L){ return L.kind !== "metro"; }).concat(lines.filter(function(L){ return L.kind === "metro"; })) : lines;
    g.lineCap = "round"; g.lineJoin = "round";
    order.forEach(function(L){
      var metro = L.kind === "metro", dim = under && !metro;
      g.globalAlpha = dim ? UNDER_DIM : 1;
      L.segs.forEach(function(sg){
        if(sg.pts.length < 2) return;
        g.beginPath();
        sg.pts.forEach(function(p, i){ var q = P(p); if(i) g.lineTo(q[0], q[1]); else g.moveTo(q[0], q[1]); });
        var w = L.kind === "gondola" ? 1.6 : (metro && under ? 5 : 3);
        g.setLineDash && g.setLineDash(L.kind === "gondola" ? [1.5, 3] : (sg.under && !(metro && under) ? [5, 4] : []));
        g.lineWidth = w + 2; g.strokeStyle = pal.casing; g.stroke();
        g.lineWidth = w; g.strokeStyle = L.col; g.stroke();
      });
      g.setLineDash && g.setLineDash([]);
      L.stations.forEach(function(p){
        var q = P(p), r = metro && under ? 4.5 : 3.5;
        if(q[0] < -8 || q[1] < -8 || q[0] > cssW + 8 || q[1] > cssH + 8) return;
        g.beginPath();
        if(L.kind === "gondola") g.rect(q[0] - r*0.8, q[1] - r*0.8, r*1.6, r*1.6);
        else g.arc(q[0], q[1], r, 0, 2*PI);
        g.fillStyle = pal.station; g.fill();
        g.lineWidth = 2; g.strokeStyle = L.col; g.stroke();
      });
      if(big && L.stations.length){
        var q0 = P(L.stations[0]);
        g.font = "700 11px system-ui, sans-serif"; g.textAlign = "left"; g.textBaseline = "middle";
        g.lineWidth = 3; g.strokeStyle = pal.casing; g.strokeText(L.id, q0[0] + 7, q0[1] - 8);
        g.fillStyle = pal.rim; g.fillText(L.id, q0[0] + 7, q0[1] - 8);
      }
    });
    g.globalAlpha = 1;
  }
  function arrowPin(x, y, ang){
    g.save(); g.translate(x, y); g.rotate(ang);
    g.beginPath(); g.moveTo(0, -9); g.lineTo(7, 6); g.lineTo(0, 2); g.lineTo(-7, 6); g.closePath();
    g.fill(); g.stroke();
    g.restore();
  }

  function destroy(){
    if(!alive) return;
    alive = false;
    domL.forEach(function(l){ l[0].removeEventListener(l[1], l[2], l[3]); });
    domL = [];
    if(ro){ try { ro.disconnect(); } catch(e){} ro = null; }
    if(root.parentNode) root.parentNode.removeChild(root);
    if(scrim.parentNode) scrim.parentNode.removeChild(scrim);
    stat = null; atlas = null; W = null; places = []; airL = null; lines = [];
  }

  return {
    el: root, canvas: cv,
    setWorld: setWorld, setAirfield: setAirfield, frame: frame, setMode: setMode, zoom: zoom, expand: expand, destroy: destroy,
    isBig: function(){ return big; },
    mode: function(){ return mode; },
    view: function(){ return {x: V.x, z: V.z, rot: V.rot, span: V.span, w: V.w, h: V.h, ay: V.ay}; },
    // for tests and the integrator: the cached static layer (null before setWorld)
    layers: function(){ return {static: stat && stat.cv, atlas: atlas && atlas.cv, places: places.length, lines: lines.length}; },
    under: function(){ return wasUnder; }
  };
}

HQV.hqminimap = {mount: mount, toMini: toMini, fromMini: fromMini, zoomFor: zoomFor, viewFor: viewFor,
                 edgeClamp: edgeClamp, sitePlaces: sitePlaces, POI: POI, AIR_COL: AIR_COL, transitLines: transitLines, LINE_COL: LINE_COL};
})();
