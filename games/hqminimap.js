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
 * Mounted by the 3D City (games/hqcity3d.js):
 *   HQV.hqminimap.mount(stageEl, {onPick(x, z), onExpand(), announce}) -> mm
 *     mm.setWorld(W, tier, {places, coast, river})  W: the packed world (HQV.world.pack); places: hqnav
 *                     Places (m; default: W's civic sites at this tier); coast, river: cm, as the doc's
 *                     layers (default W.island.coast and W.river)
 *     mm.frame({x, z, yaw, speed, route, waypoint, others, dt?})
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
var BITMAP_MAX = 3072, BITMAP_PX_M = 2;       // the static bitmap: device px at most, px per m at most
var MARGIN = 60;                              // m of sea round the world in the bitmap
var ICON = 18;                                // CSS px: a POI icon's disc
var ROAD_M = {highway: 22, ring: 18, arterial: 14, avenue: 14, local: 9, street: 9};   // drawn widths
var ROAD_RANK = {local: 0, street: 0, arterial: 1, avenue: 1, ring: 2, highway: 3};
// The POI kinds the minimap shows (hqnav Place kinds), their disc colour and pictogram.
var POI = {
  dock: {col: "#2f7fc1", g: "anchor"}, port: {col: "#1f5f9e", g: "anchor"},
  transit: {col: "#2a9d8f", g: "bus"}, airport: {col: "#5b6b8c", g: "plane"},
  townhall: {col: "#8a6d3b", g: "hall"}, hospital: {col: "#c9372c", g: "cross"}, clinic: {col: "#d4574c", g: "cross"},
  police: {col: "#2d4a8a", g: "shield"}, fire: {col: "#d0611f", g: "flame"}, market: {col: "#3f8f4f", g: "basket"},
  school: {col: "#a07a12", g: "book"}, myhq: {col: "#ffb347", g: "star"}, hq: {col: "#5fd3e6", g: "house"}
};
var POI_ORDER = ["hq", "school", "market", "fire", "police", "clinic", "hospital", "townhall", "airport", "transit", "dock", "port", "myhq"];
var PAL = {
  dark: {sea: "#0f2a3d", land: "#1d2620", landEdge: "#33503f", water: "#1a4a6b", bank: "#2f6f8f",
         road: {highway: "#c99a4a", ring: "#b08a50", arterial: "#8d939c", avenue: "#8d939c", local: "#5d636b", street: "#5d636b"},
         casing: "#0b0d10", bridge: "#d8d2c4", route: "#e2805e", routeCase: "#3a1c10", you: "#ffffff", youEdge: "#e2805e",
         pin: "#e2805e", rim: "#ecebe8", other: "#5fd3e6"},
  light: {sea: "#a9cfe6", land: "#eef0e6", landEdge: "#c9d3bf", water: "#8cc0e0", bank: "#6aa3c8",
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

// The world bitmap: north-up, bitmap px (bx, by) = ((x1 - x)*k, (z1 - z)*k) for world m (x, z).
function buildStatic(doc, W, tier, coast, river, pal, dpr){
  var half = num(W && W.half, 1024) + MARGIN, span = 2*half;
  var k = Math.min(BITMAP_PX_M, (dpr >= 2 ? BITMAP_MAX : BITMAP_MAX*2/3)/span);
  var n = Math.max(1, Math.ceil(span*k));
  var cv = doc.createElement("canvas");
  cv.width = n; cv.height = n;
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
  return B;
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
  var domL = [], alive = true;
  var mode = "heading", level = 0, span = null, lastT = null, W = null, tier = null;
  var stat = null, atlas = null, places = [], pal = PAL.dark;
  var cssW = 200, cssH = 200, dpr = 1, V = viewFor(mode, 0, 0, 0, WALK_SPAN, cssW, cssH);

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
  el.appendChild(root);
  var cv = mk("canvas", "hq3d-minimap-canvas");
  cv.setAttribute("aria-label", "Minimap: click to set a waypoint");
  cv.setAttribute("role", "img");
  var g = cv.getContext ? cv.getContext("2d") : null;
  var bar = mk("div", "hq3d-minimap-bar");
  var bIn = btn("hq3d-minimap-in", "+", "Zoom in");
  var bOut = btn("hq3d-minimap-out", "−", "Zoom out");
  var bMode = btn("hq3d-minimap-mode", "↑", "North up");
  var bExp = btn("hq3d-minimap-expand", "⤢", "Open the full map");
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
  function pick(e){
    var r = cv.getBoundingClientRect ? cv.getBoundingClientRect() : {left: 0, top: 0, width: cssW, height: cssH};
    var px = (num(e.clientX, 0) - num(r.left, 0))*cssW/(num(r.width, cssW) || cssW);
    var py = (num(e.clientY, 0) - num(r.top, 0))*cssH/(num(r.height, cssH) || cssH);
    if(!(px >= 0 && py >= 0 && px <= cssW && py <= cssH)) return;
    var p = fromMini(V, px, py);
    try { onPick(p[0], p[1]); } catch(err){ if(window.console) console.error(err); }
  }
  function stop(e){ if(e.stopPropagation) e.stopPropagation(); }
  on(cv, "click", function(e){ stop(e); if(e.preventDefault) e.preventDefault(); pick(e); });
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
    stat = null; atlas = null; places = [];
    if(!W) return;
    measure();
    pal = palette(el);
    var coast = Array.isArray(o.coast) ? o.coast : (W.island && W.island.coast) || null;
    var river = o.river || W.river || null;
    stat = buildStatic(doc, W, tier, coast, river, pal, dpr);
    atlas = buildAtlas(doc, dpr);
    var src = Array.isArray(o.places) ? o.places : sitePlaces(W, tier);
    src.forEach(function(p){
      if(!p || atlas.idx[p.kind] == null) return;
      var x = num(p.x, NaN), z = num(p.z, NaN);
      if(isFinite(x) && isFinite(z)) places.push({kind: p.kind, x: x, z: z, i: atlas.idx[p.kind]});
    });
    // the higher-priority icons are drawn last, on top
    places.sort(function(a, b){ return a.i - b.i; });
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
  function frame(f){
    if(!alive || !g) return;
    if(stale){ stale = false; measure(); }
    f = f || {};
    var now = (window.performance && window.performance.now) ? window.performance.now() : Date.now();
    var dt = f.dt != null ? num(f.dt, 0) : (lastT == null ? 0 : (now - lastT)/1000);
    lastT = now;
    dt = clamp(dt, 0, 0.25);
    var target = zoomFor(f.speed)*Math.pow(ZOOM_STEP, -level);
    span = span == null ? target : span + (target - span)*ease(SPAN_K, dt);
    V = viewFor(mode, f.x, f.z, f.yaw, span, cssW, cssH);
    var s = cssW/span, c = Math.cos(V.rot), n = Math.sin(V.rot), ax = cssW/2, ay = cssH*V.ay;
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.fillStyle = pal.sea; g.fillRect(0, 0, cssW, cssH);
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
    stat = null; atlas = null; W = null; places = [];
  }

  return {
    el: root, canvas: cv,
    setWorld: setWorld, frame: frame, setMode: setMode, zoom: zoom, destroy: destroy,
    mode: function(){ return mode; },
    view: function(){ return {x: V.x, z: V.z, rot: V.rot, span: V.span, w: V.w, h: V.h, ay: V.ay}; },
    // for tests and the integrator: the cached static layer (null before setWorld)
    layers: function(){ return {static: stat && stat.cv, atlas: atlas && atlas.cv, places: places.length}; }
  };
}

HQV.hqminimap = {mount: mount, toMini: toMini, fromMini: fromMini, zoomFor: zoomFor, viewFor: viewFor,
                 edgeClamp: edgeClamp, sitePlaces: sitePlaces, POI: POI};
})();
