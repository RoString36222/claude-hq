/* Claude HQ 3D city: the heads-up display over the 3D view (HQV.hqhud).
 *
 * Draws only what the host hands it each frame, nothing leaves the machine:
 *   mode chip      "Chase camera" for 1.4 s after a camera change (announced once)
 *   crosshair      first person only, with the "E  Enter Maya's HQ" prompt under it
 *   speedometer    km/h, only while riding something
 *   compass        a 180 degree ribbon, N at bearing +z (3D modes)
 *   map labels     on one canvas in map mode: street names along their roads, highway and ring
 *                  shields, HQ names (yours in amber) and friends; overlaps dropped by priority
 *   vignette       the fast-FP edge darkening (opacity from camrig's pose.vignette)
 *   settings       the gear and its panel (FOV, sensitivity, invert Y, reduced motion, head bob,
 *                  quality, preferred camera), persisted in localStorage "hq_cam"
 *
 * Bearings: yaw 0 faces +z and increasing yaw turns the camera LEFT (model-local +x is left),
 * so the clockwise compass heading is -yaw: N = +z, E = -x, S = -z, W = +x. Seen from above with
 * the map's up vector (0,0,-1), N is at the bottom of the screen and E on the left.
 *
 * Mounted by games/hq3d.js:  HQV.hqhud.mount(stageEl, {announce}) -> hud (see the build spec 2.6),
 * plus hud.setSettings(partial) / hud.setPreferred(mode) so the host can persist `preferred` after V
 * without the panel. frame(f) may also carry f.ground(x, z) -> y (road labels are projected on the
 * ground; without it HQV.world.groundAt of the current world is used, else y = 0).
 * Keys: the gear opens on Enter/Space itself (on keydown), so a host's capture-phase key handler that
 * preventDefaults Space still cannot block it; but such a handler must ignore keys whose target is
 * inside .hqhud-gear / .hqhud-settings, or Space on the gear also drives the avatar. The panel's
 * stopPropagation runs in the bubble phase and cannot stop a capture listener on window.
 * The pure helpers (layoutLabels, labelAngle, compassTicks, kmh, loadSettings) need no DOM.
 */
(function(){
"use strict";
var HQV = window.HQV = window.HQV || {};

var PI = Math.PI;
var KEY = "hq_cam";
var ORDER = ["far", "chase", "near", "fp", "classic"];       // camrig ORDER (used when camrig is not loaded)
var QUALITY = ["auto", "low", "medium", "high"];
var DEFAULTS = {fov: 65, sens: 1, invertY: false, reduced: false, headBob: true, quality: "auto", preferred: "chase", damage: false, mouseSteer: false};
var CHIP_MS = 1400;
var FADE_MS = 400;           // the chip's text stays until its fade-out (--t-med) is over
var MODE_NAMES = {far: "Far camera", chase: "Chase camera", near: "Near camera", fp: "First person", classic: "Classic camera"};
// Map label styling and priority (higher wins): shields > HQ names > friends > highway > ring > avenue > street.
var PRI = {shield: 7, hq: 6, peer: 5, highway: 4, ring: 3, avenue: 2, street: 1};
var FONT_PX = {street: 11, avenue: 13, ring: 14, highway: 15};
var SHIELD_EVERY = 300;      // px of screen length between route shields

function order(){ return (HQV.camrig && HQV.camrig.ORDER) || ORDER; }
function clamp(v, a, b){ return v < a ? a : v > b ? b : v; }
function num(v, d){ v = +v; return isFinite(v) ? v : d; }

// ---- pure helpers ---------------------------------------------------------------------------

// Segment angle folded into (-PI/2, PI/2], so text drawn along it never reads upside down.
function labelAngle(ax, ay, bx, by){
  var a = Math.atan2((+by || 0) - (+ay || 0), (+bx || 0) - (+ax || 0));
  if(a > PI/2) a -= PI;
  else if(a <= -PI/2) a += PI;
  if(a > PI/2) a = PI/2;               // float guard
  return a;
}

// Clockwise heading in degrees [0, 360) from a camera look yaw (yaw 0 = +z = north).
function heading(yaw){ var d = -(+yaw || 0) * 180/PI; d = d % 360; if(d < 0) d += 360; return d; }

// The ticks of the 180 degree compass window centred on the heading: every 15 degrees,
// x in -1..1 (right = clockwise of the heading), cardinal letters on 0/90/180/270.
function compassTicks(yaw){
  var h = heading(yaw), out = [];
  var first = Math.ceil((h - 90 - 1e-9) / 15) * 15;
  for(var b = first; b <= h + 90 + 1e-9; b += 15){
    var deg = ((Math.round(b) % 360) + 360) % 360;
    var x = clamp((b - h) / 90, -1, 1);
    out.push({deg: deg, x: x, label: deg === 0 ? "N" : deg === 90 ? "E" : deg === 180 ? "S" : deg === 270 ? "W" : null});
  }
  return out;
}

function kmh(speed){ return Math.round(num(speed, 0) * 3.6); }

// Settings from a stored value (JSON text or an object); junk falls back to defaults, numbers clamp.
function loadSettings(raw){
  var o = raw;
  if(typeof raw === "string"){ try { o = JSON.parse(raw); } catch(e){ o = null; } }
  if(!o || typeof o !== "object" || Array.isArray(o)) o = {};
  var s = {};
  s.fov = Math.round(clamp(num(o.fov, DEFAULTS.fov), 60, 100));
  s.sens = Math.round(clamp(num(o.sens, DEFAULTS.sens), 0.2, 3) * 100) / 100;
  s.invertY = typeof o.invertY === "boolean" ? o.invertY : DEFAULTS.invertY;
  s.reduced = typeof o.reduced === "boolean" ? o.reduced : DEFAULTS.reduced;
  s.headBob = typeof o.headBob === "boolean" ? o.headBob : DEFAULTS.headBob;
  s.damage = typeof o.damage === "boolean" ? o.damage : DEFAULTS.damage;      // vehicle damage: opt in
  s.quality = QUALITY.indexOf(o.quality) >= 0 ? o.quality : DEFAULTS.quality;
  s.preferred = order().indexOf(o.preferred) >= 0 ? o.preferred : DEFAULTS.preferred;
  s.mouseSteer = typeof o.mouseSteer === "boolean" ? o.mouseSteer : DEFAULTS.mouseSteer;   // [3.15] the mouse turns you (hq3d)
  return s;
}

// Normalise and persist; returns the stored JSON text (null when storage is unavailable).
function saveSettings(s){
  var txt = JSON.stringify(loadSettings(s));
  try { window.localStorage.setItem(KEY, txt); return txt; } catch(e){ return null; }
}
function readStored(){
  try { return loadSettings(window.localStorage.getItem(KEY)); } catch(e){ return loadSettings(null); }
}

// Greedy label layout. cands: [{x, y (centre px), w, h, angle?, pri, weight?, boxes?}]; a candidate is kept
// when its (rotated) bounding box lies inside the view and overlaps no label kept before it. A candidate
// with boxes: [[x0, y0, x1, y1], ...] (text along a curve, one box per glyph) is tested box by box instead.
// Order: pri desc, then weight desc, then input order. Returns the kept candidates in that order.
function layoutLabels(cands, viewW, viewH){
  var list = [], i;
  cands = cands || [];
  for(i = 0; i < cands.length; i++){ if(cands[i]) list.push({c: cands[i], i: i}); }
  list.sort(function(a, b){
    return ((b.c.pri || 0) - (a.c.pri || 0)) || ((b.c.weight || 0) - (a.c.weight || 0)) || (a.i - b.i);
  });
  var kept = [], boxes = [];
  for(i = 0; i < list.length; i++){
    var c = list[i].c, own;
    if(Array.isArray(c.boxes) && c.boxes.length) own = c.boxes;
    else {
      var ang = +c.angle || 0, w = Math.max(0, +c.w || 0), h = Math.max(0, +c.h || 0);
      var co = Math.abs(Math.cos(ang)), si = Math.abs(Math.sin(ang));
      var bw = w * co + h * si, bh = w * si + h * co;
      own = [[c.x - bw/2, c.y - bh/2, c.x + bw/2, c.y + bh/2]];
    }
    var bad = false;
    for(var k = 0; k < own.length && !bad; k++){
      var o = own[k];
      if(!(o[0] >= 0 && o[1] >= 0 && o[2] <= viewW && o[3] <= viewH)){ bad = true; break; }
      for(var j = 0; j < boxes.length && !bad; j++){
        var b = boxes[j];
        bad = o[0] < b[2] && o[2] > b[0] && o[1] < b[3] && o[3] > b[1];
      }
    }
    if(bad) continue;
    for(k = 0; k < own.length; k++) boxes.push(own[k]);
    kept.push(c);
  }
  return kept;
}

// ---- DOM ------------------------------------------------------------------------------------

var uid = 0;

function mount(el, opts){
  opts = opts || {};
  var doc = window.document || (typeof document !== "undefined" ? document : null);
  var announce = typeof opts.announce === "function" ? opts.announce : function(){};
  var settings = readStored();
  var listeners = [], domL = [], chipTimer = null, alive = true;
  var id = "hqhud-settings-" + (++uid);

  function mk(tag, cls, parent){
    var n = doc.createElement(tag);
    if(cls) n.className = cls;
    (parent || root).appendChild(n);
    return n;
  }
  function on(n, type, fn){ n.addEventListener(type, fn); domL.push([n, type, fn]); }
  function show(n, yes){ yes = !!yes; if(n.hidden !== !yes) n.hidden = !yes; }
  function setText(n, t){ if(n.textContent !== t) n.textContent = t; }

  var root = doc.createElement("div");
  root.className = "hqhud";
  el.appendChild(root);

  var labels = mk("canvas", "hqhud-labels");
  labels.setAttribute("aria-hidden", "true");
  var vignette = mk("div", "hqhud-vignette");
  vignette.setAttribute("aria-hidden", "true");
  var chip = mk("div", "hqhud-chip");
  chip.setAttribute("aria-hidden", "true");       // announce() speaks it
  var cross = mk("div", "hqhud-cross");
  cross.setAttribute("aria-hidden", "true");
  var prompt = mk("div", "hqhud-prompt");
  var promptKey = mk("kbd", "", prompt), promptText = mk("span", "", prompt);
  var speed = mk("div", "hqhud-speed");
  speed.setAttribute("aria-hidden", "true");
  var speedNum = mk("b", "", speed), speedUnit = mk("span", "", speed);
  speedUnit.textContent = "km/h";
  var compass = mk("div", "hqhud-compass");
  compass.setAttribute("aria-hidden", "true");
  var ticks = [];
  for(var t = 0; t < 13; t++){ ticks.push(mk("span", "hqhud-tick", compass)); }
  mk("i", "hqhud-needle", compass);

  // Settings: the gear and its panel.
  var gear = mk("button", "hqhud-gear");
  gear.setAttribute("type", "button");
  gear.setAttribute("aria-label", "Camera settings");
  gear.setAttribute("aria-expanded", "false");
  gear.setAttribute("aria-controls", id);
  gear.textContent = "⚙";
  var panel = mk("div", "hqhud-settings");
  panel.id = id;
  panel.setAttribute("role", "group");
  panel.setAttribute("aria-label", "Camera settings");
  panel.hidden = true;
  var head = mk("h3", "hqhud-set-title", panel);
  head.textContent = "Camera";
  var controls = {};

  function field(key, text, input, outText){
    var row = mk("div", "hqhud-set-row", panel);
    var lab = mk("label", "", row);
    var cid = id + "-" + key;
    lab.setAttribute("for", cid);
    lab.textContent = text;
    input.id = cid;
    row.appendChild(input);
    if(outText){
      var out = mk("output", "hqhud-set-val", row);
      out.setAttribute("for", cid);
      input._out = out;
    }
    controls[key] = input;
    return input;
  }
  function range(key, text, min, max, step){
    var n = doc.createElement("input");
    n.setAttribute("type", "range");
    n.setAttribute("min", String(min)); n.setAttribute("max", String(max)); n.setAttribute("step", String(step));
    n.type = "range"; n.min = String(min); n.max = String(max); n.step = String(step);
    field(key, text, n, true);
    on(n, "input", function(){ change(key, +n.value); });
    on(n, "change", function(){ change(key, +n.value); });
  }
  function check(key, text){
    var n = doc.createElement("input");
    n.setAttribute("type", "checkbox");
    n.type = "checkbox";
    field(key, text, n, false);
    on(n, "change", function(){ change(key, !!n.checked); });
  }
  function select(key, text, values, names){
    var n = doc.createElement("select");
    for(var i = 0; i < values.length; i++){
      var o = doc.createElement("option");
      o.value = values[i];
      o.setAttribute("value", values[i]);
      o.textContent = names[values[i]] || values[i];
      n.appendChild(o);
    }
    field(key, text, n, false);
    on(n, "change", function(){ change(key, n.value); });
  }
  range("fov", "Field of view", 60, 100, 1);
  range("sens", "Mouse sensitivity", 0.2, 3, 0.1);
  check("invertY", "Invert Y");
  check("reduced", "Reduced motion");
  check("headBob", "Head bob");
  check("damage", "Vehicle damage (dents, smoke)");
  check("mouseSteer", "Mouse steering");
  select("quality", "Quality", QUALITY, {auto: "Auto", low: "Low", medium: "Medium", high: "High"});
  select("preferred", "Preferred camera", order(), MODE_NAMES);

  function syncControls(){
    for(var k in controls){
      var n = controls[k], v = settings[k];
      if(n.type === "checkbox") n.checked = !!v;
      else n.value = String(v);
      if(n._out) n._out.textContent = k === "fov" ? v + "°" : String(v);
    }
  }
  function change(key, value){ var p = {}; p[key] = value; setSettings(p); }
  // Is v acceptable for settings key k? (numbers are clamped later, junk is skipped, never defaulted)
  function valid(k, v){
    if(k === "fov" || k === "sens") return v !== null && v !== "" && typeof v !== "boolean" && isFinite(+v);
    if(k === "quality") return QUALITY.indexOf(v) >= 0;
    if(k === "preferred") return order().indexOf(v) >= 0;
    return typeof v === "boolean";
  }
  // Merge a partial change (the panel, or the host persisting `preferred` after V), save, notify.
  // An invalid value leaves that setting as it was.
  function setSettings(partial){
    var next = {}, k;
    for(k in settings) next[k] = settings[k];
    partial = partial || {};
    for(k in partial){ if(Object.prototype.hasOwnProperty.call(DEFAULTS, k) && valid(k, partial[k])) next[k] = partial[k]; }
    next = loadSettings(next);
    if(JSON.stringify(next) === JSON.stringify(settings)) return;   // no-op (slider 'change' after 'input')
    settings = next;
    saveSettings(settings);
    syncControls();
    var copy = hudSettings();
    for(var i = 0; i < listeners.length; i++){ try { listeners[i](copy); } catch(e){ if(window.console) console.error(e); } }
  }
  function hudSettings(){ var o = {}; for(var k in settings) o[k] = settings[k]; return o; }
  syncControls();

  var open = false;
  function openSettings(want){
    open = want == null ? !open : !!want;
    panel.hidden = !open;
    gear.setAttribute("aria-expanded", open ? "true" : "false");
    if(open){ syncControls(); if(controls.fov.focus) controls.fov.focus(); }
    return open;
  }
  on(gear, "click", function(){ openSettings(); });
  // A mouse click must not leave focus on the gear, or a later Space (hop) would toggle the panel.
  on(gear, "mousedown", function(e){ if(e.preventDefault) e.preventDefault(); });
  function closeAndRefocus(){
    openSettings(false);
    if(gear.focus) gear.focus();
  }
  function onKey(e){
    if(e.key === "Escape" || e.key === "Esc"){
      if(open){
        closeAndRefocus();
        if(e.preventDefault) e.preventDefault();
      }
    }
    if(e.stopPropagation) e.stopPropagation();     // typing in the panel never drives the avatar
  }
  on(panel, "keydown", onKey);
  on(gear, "keydown", function(e){
    if((e.key === "Escape" || e.key === "Esc") && open){ onKey(e); return; }
    // Enter/Space toggle here, not via the button's native click: a host key handler that
    // preventDefaults Space (hq3d's capture listener) would otherwise cancel that click.
    if((e.key === "Enter" || e.key === " " || e.key === "Spacebar" || e.code === "Space") && !e.repeat){
      openSettings();
      if(e.preventDefault) e.preventDefault();   // no second toggle from the native click
      if(e.stopPropagation) e.stopPropagation();
    }
  });

  // ---- mode chip ----
  function setMode(mode, label){
    var text = String(label || MODE_NAMES[mode] || mode || "");
    setText(chip, text);
    chip.classList.add("on");
    if(chipTimer != null) window.clearTimeout(chipTimer);
    chipTimer = window.setTimeout(function(){
      chip.classList.remove("on");                // fades out (CSS), then the text goes
      chipTimer = window.setTimeout(function(){ chipTimer = null; setText(chip, ""); }, FADE_MS);
    }, CHIP_MS);
    if(text) announce(text);
  }

  // ---- map labels ----
  var L = {roads: [], hqs: []}, counts = {roads: 0, shields: 0, hqs: 0, peers: 0};
  var ctx = null, lastTheme = null, lastSig = "", drawn = false, canvasW = 0, canvasH = 0, colours = null, version = 0;
  try { ctx = labels.getContext ? labels.getContext("2d") : null; } catch(e){ ctx = null; }

  function setLabels(v){
    v = v || {};
    L = {roads: Array.isArray(v.roads) ? v.roads : [], hqs: Array.isArray(v.hqs) ? v.hqs : []};
    version++;
  }
  function token(cs, name, fb){
    var v = cs && cs.getPropertyValue ? String(cs.getPropertyValue(name) || "").trim() : "";
    return v || fb;
  }
  function readColours(){
    var cs = null;
    try { cs = window.getComputedStyle ? window.getComputedStyle(root) : null; } catch(e){ cs = null; }
    var ink = token(cs, "--ink", "black");
    colours = {
      ink: ink, bg: token(cs, "--bg", "white"), panel: token(cs, "--panel", "white"), line: token(cs, "--line", "gray"),
      muted: token(cs, "--muted", "gray"), gold: token(cs, "--gold", "goldenrod"), brand: token(cs, "--brand", ink),
      onBrand: token(cs, "--on-brand", "white"), good: token(cs, "--good", ink),
      font: token(cs, "--font", "sans-serif")
    };
    widths = {};
  }
  function font(px, bold){ return (bold ? "700 " : "600 ") + px + "px " + colours.font; }
  var widths = {};             // text widths per font + text (glyphRun measures every prefix)
  function measure(text, f){
    if(!ctx) return text.length * 7;
    var key = f + "\n" + text, w = widths[key];
    if(w != null) return w;
    ctx.font = f;
    var m = ctx.measureText(text);
    return (widths[key] = m && isFinite(m.width) ? m.width : text.length * 7);
  }
  function clearLabels(){
    if(ctx && drawn){ ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.clearRect(0, 0, labels.width || 0, labels.height || 0); }
    drawn = false;
    lastSig = "";
  }
  // Ground heights of every road point (roads are not at y = 0), cached per label set and world.
  var yCache = {ver: -1, src: null, ys: []};
  function groundFn(f){
    if(typeof f.ground === "function") return {src: f.ground, at: f.ground};
    var Wd = HQV.world, w = Wd && Wd.groundAt && Wd.current ? Wd.current() : null;
    if(!w) return {src: null, at: null};
    return {src: w, at: function(x, z){ return Wd.groundAt(w, x, z); }};
  }
  function roadYs(f){
    var g = groundFn(f);
    if(yCache.ver === version && yCache.src === g.src) return yCache.ys;
    var ys = [];
    for(var i = 0; i < L.roads.length; i++){
      var pts = L.roads[i] && Array.isArray(L.roads[i].pts) ? L.roads[i].pts : [], row = [];
      for(var j = 0; j < pts.length; j++){
        var y = 0;
        if(g.at && pts[j]){ try { y = num(g.at(+pts[j][0] || 0, +pts[j][1] || 0), 0); } catch(e){ y = 0; } }
        row.push(y);
      }
      ys.push(row);
    }
    yCache = {ver: version, src: g.src, ys: ys};
    return ys;
  }
  // Screen pieces of one road polyline: runs of visible points inside the view (plus a margin).
  function pieces(pts, ys, project, W, H){
    var out = [], cur = null, mx = W * 0.25, my = H * 0.25;
    for(var i = 0; i < pts.length; i++){
      var p = pts[i], q = p ? project(+p[0] || 0, ys[i] || 0, +p[1] || 0) : null;
      var ok = q && q.vis !== false && q.x >= -mx && q.x <= W + mx && q.y >= -my && q.y <= H + my;
      if(!ok){ if(cur && cur.length > 1) out.push(cur); cur = null; continue; }
      if(!cur) cur = [];
      cur.push([q.x, q.y]);
    }
    if(cur && cur.length > 1) out.push(cur);
    return out;
  }
  function arc(sp){
    var cum = [0];
    for(var i = 1; i < sp.length; i++) cum.push(cum[i-1] + Math.hypot(sp[i][0] - sp[i-1][0], sp[i][1] - sp[i-1][1]));
    return cum;
  }
  function at(sp, cum, s){
    s = clamp(s, 0, cum[cum.length - 1]);
    for(var i = 1; i < sp.length; i++){
      if(cum[i] >= s){
        var seg = cum[i] - cum[i-1] || 1, u = (s - cum[i-1]) / seg;
        return [sp[i-1][0] + (sp[i][0] - sp[i-1][0]) * u, sp[i-1][1] + (sp[i][1] - sp[i-1][1]) * u];
      }
    }
    return sp[sp.length - 1];
  }
  // A road name laid glyph by glyph along a screen piece, centred on its middle, each glyph turned
  // to the local tangent. The whole label keeps one reading direction (the piece is walked backwards
  // when its chord would read upside down). Null when the bend under the text is too sharp to read.
  function glyphRun(sp, cum, len, text, fnt, px){
    var tw = measure(text, fnt), s0 = len/2 - tw/2;
    var a = at(sp, cum, s0), b = at(sp, cum, s0 + tw);
    var raw = Math.atan2(b[1] - a[1], b[0] - a[0]);
    if(Math.abs(labelAngle(a[0], a[1], b[0], b[1]) - raw) > 1e-6){
      sp = sp.slice().reverse();
      cum = arc(sp);
    }
    var glyphs = [], boxes = [], prev = null, x0 = 0;
    for(var i = 0; i < text.length; i++){
      var x1 = measure(text.slice(0, i + 1), fnt), s = s0 + (x0 + x1)/2;
      var p = at(sp, cum, s), p1 = at(sp, cum, s - 2), p2 = at(sp, cum, s + 2);
      var ang = Math.atan2(p2[1] - p1[1], p2[0] - p1[0]);
      if(prev != null){
        var d = Math.abs(ang - prev); if(d > PI) d = 2*PI - d;
        if(d > 0.7) return null;
      }
      if(Math.abs(ang) > PI/2 + 0.35) return null;   // would read upside down
      prev = ang;
      glyphs.push({ch: text.charAt(i), x: p[0], y: p[1], a: ang});
      var hw = Math.max(x1 - x0, px * 0.6)/2 + 1, hh = px/2 + 2;
      boxes.push([p[0] - Math.max(hw, hh), p[1] - Math.max(hw, hh), p[0] + Math.max(hw, hh), p[1] + Math.max(hw, hh)]);
      x0 = x1;
    }
    return {glyphs: glyphs, boxes: boxes};
  }
  function drawMap(f, W, H){
    var project = f.project, cands = [], i, j;
    var roads = L.roads, hqs = L.hqs, peers = Array.isArray(f.peers) ? f.peers : [], ys = roadYs(f);
    for(i = 0; i < roads.length; i++){
      var r = roads[i] || {}, cls = FONT_PX[r.cls] ? r.cls : "street", name = String(r.name || "");
      var pts = Array.isArray(r.pts) ? r.pts : [];
      var ps = pieces(pts, ys[i] || [], project, W, H);
      var fnt = font(FONT_PX[cls], cls === "highway");
      var tw = name ? measure(name, fnt) : 0;
      for(j = 0; j < ps.length; j++){
        var sp = ps[j], cum = arc(sp), len = cum[cum.length - 1];
        var run = name && len >= tw + 16 ? glyphRun(sp, cum, len, name, fnt, FONT_PX[cls]) : null;
        if(run){
          var m = at(sp, cum, len/2);
          cands.push({kind: "road", cls: cls, text: name, font: fnt, x: m[0], y: m[1], w: tw + 6, h: FONT_PX[cls] + 4,
            glyphs: run.glyphs, boxes: run.boxes, pri: PRI[cls], weight: len});
        }
        if(r.ref && (cls === "highway" || cls === "ring") && len >= 60){
          var ref = String(r.ref), sf = font(12, true), sw = measure(ref, sf) + 12;
          // every SHIELD_EVERY px, offset half a step from the middle so the route name sits between two shields
          var at2 = [];
          for(var s = len/2 - SHIELD_EVERY/2; s >= 30; s -= SHIELD_EVERY) at2.push(s);
          for(s = len/2 + SHIELD_EVERY/2; s <= len - 30; s += SHIELD_EVERY) at2.push(s);
          if(!at2.length) at2.push(len/2);
          for(var k = 0; k < at2.length; k++){
            var sp2 = at(sp, cum, at2[k]);
            cands.push({kind: "shield", cls: cls, text: ref, font: sf, x: sp2[0], y: sp2[1], w: sw, h: 18, angle: 0, pri: PRI.shield, weight: len});
          }
        }
      }
    }
    for(i = 0; i < hqs.length; i++){
      var hq = hqs[i]; if(!hq) continue;
      var hp = project(+hq.x || 0, +hq.y || 0, +hq.z || 0);
      if(!hp || hp.vis === false) continue;
      var hn = String(hq.name || ""), hf = font(12, !!hq.you);
      if(!hn) continue;
      cands.push({kind: "hq", text: hn, font: hf, you: !!hq.you, x: hp.x, y: hp.y, w: measure(hn, hf) + 14, h: 20, angle: 0,
        pri: PRI.hq, weight: hq.you ? 1 : 0});
    }
    for(i = 0; i < peers.length; i++){
      var pe = peers[i]; if(!pe) continue;
      var pp = project(+pe.x || 0, +pe.y || 0, +pe.z || 0);
      if(!pp || pp.vis === false) continue;
      var pn = String(pe.n || ""), pf = font(11, false), pw = measure(pn, pf);
      // box covers the dot (left) and the name to its right; centre shifted accordingly
      cands.push({kind: "peer", text: pn, font: pf, px: pp.x, py: pp.y, x: pp.x + (pw + 8)/2 - 4, y: pp.y, w: pw + 16, h: 16, angle: 0, pri: PRI.peer});
    }
    var kept = layoutLabels(cands, W, H);
    var c = {roads: 0, shields: 0, hqs: 0, peers: 0};
    if(ctx){
      var dpr = canvasW / Math.max(1, W);
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.clearRect(0, 0, canvasW, canvasH);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
    }
    for(i = kept.length - 1; i >= 0; i--){              // lowest priority first, so the important ones end on top
      var q = kept[i];
      if(q.kind === "road") c.roads++;
      else if(q.kind === "shield") c.shields++;
      else if(q.kind === "hq") c.hqs++;
      else c.peers++;
      if(ctx) drawOne(q);
    }
    counts = c;
    drawn = true;
  }
  function pill(x, y, w, h, r){
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
  }
  function drawOne(q){
    var C = colours;
    ctx.save();
    ctx.font = q.font;
    if(q.kind === "road"){
      ctx.lineJoin = "round";
      ctx.lineWidth = 3;
      ctx.strokeStyle = C.bg;
      ctx.fillStyle = q.cls === "street" ? C.muted : C.ink;
      for(var pass = 0; pass < 2; pass++){                // all halos first, so no halo covers a glyph
        for(var g = 0; g < q.glyphs.length; g++){
          var gl = q.glyphs[g];
          ctx.save();
          ctx.translate(gl.x, gl.y);
          ctx.rotate(gl.a);
          if(pass === 0) ctx.strokeText(gl.ch, 0, 0); else ctx.fillText(gl.ch, 0, 0);
          ctx.restore();
        }
      }
    } else if(q.kind === "shield"){
      pill(q.x - q.w/2, q.y - q.h/2, q.w, q.h, 5);
      ctx.fillStyle = q.cls === "highway" ? C.brand : C.panel;
      ctx.fill();
      ctx.lineWidth = 1.5;
      ctx.strokeStyle = q.cls === "highway" ? C.bg : C.ink;
      ctx.stroke();
      ctx.fillStyle = q.cls === "highway" ? C.onBrand : C.ink;
      ctx.fillText(q.text, q.x, q.y + 0.5);
    } else if(q.kind === "hq"){
      pill(q.x - q.w/2, q.y - q.h/2, q.w, q.h, q.h/2);
      ctx.fillStyle = C.panel;
      ctx.fill();
      ctx.lineWidth = q.you ? 2 : 1;
      ctx.strokeStyle = q.you ? C.gold : C.line;
      ctx.stroke();
      ctx.fillStyle = q.you ? C.gold : C.ink;
      ctx.fillText(q.text, q.x, q.y + 0.5);
    } else {
      ctx.beginPath();
      ctx.arc(q.px, q.py, 4, 0, PI * 2);
      ctx.fillStyle = C.good;
      ctx.fill();
      ctx.lineWidth = 1.5;
      ctx.strokeStyle = C.bg;
      ctx.stroke();
      ctx.textAlign = "left";
      ctx.lineWidth = 3;
      ctx.strokeText(q.text, q.px + 8, q.py);
      ctx.fillStyle = C.ink;
      ctx.fillText(q.text, q.px + 8, q.py);
    }
    ctx.restore();
  }
  function sizeCanvas(W, H){
    var dpr = Math.min(2, Math.max(1, +window.devicePixelRatio || 1));
    var cw = Math.round(W * dpr), ch = Math.round(H * dpr);
    if(cw !== canvasW || ch !== canvasH){ labels.width = cw; labels.height = ch; canvasW = cw; canvasH = ch; lastSig = ""; }
  }

  // The theme (data-theme / classes on <html>, and the OS light/dark) is part of the map's redraw
  // signature, so a theme switch re-reads the colour tokens even when the map stands still.
  var darkMq = null;
  try { darkMq = window.matchMedia ? window.matchMedia("(prefers-color-scheme: dark)") : null; } catch(e){ darkMq = null; }
  function themeSig(){
    var h = doc.documentElement, t = h ? (h.getAttribute("data-theme") || "") + "/" + (h.className || "") : "";
    return t + (darkMq && darkMq.matches ? "/dark" : "/light");
  }
  function focusInPanel(){
    var a = doc.activeElement;
    for(; a; a = a.parentNode){ if(a === panel) return true; }
    return false;
  }

  // ---- per frame ----
  var lastMode = null, lastHeading = null, lastSpeed = null, lastVig = -1, lastPrompt = "";
  function frame(f){
    if(!alive) return;
    f = f || {};
    // Layout reads before any DOM write this frame (no forced reflow).
    var W = Math.max(0, +el.clientWidth || 0), H = Math.max(0, +el.clientHeight || 0);
    if(!f.hudOn){
      if(open){                                   // hiding the root would drop focus to <body>
        var had = focusInPanel();
        openSettings(false);
        if(had && el.focus){ try { el.focus({preventScroll: true}); } catch(e){ el.focus(); } }
      }
      lastPrompt = "";
      show(root, false);
      if(drawn) clearLabels();
      return;
    }
    show(root, true);
    var mode = String(f.mode || "");
    if(mode !== lastMode){ root.setAttribute("data-mode", mode); lastMode = mode; }
    var isMap = mode === "map";

    show(cross, !!f.crosshair && !isMap);
    var pr = f.prompt != null ? String(f.prompt) : "";
    if(pr){
      var mk2 = /^(\S{1,6})\s{2,}(.*)$/.exec(pr);
      setText(promptKey, mk2 ? mk2[1] : "");
      show(promptKey, !!mk2);
      setText(promptText, mk2 ? mk2[2] : pr);
    }
    show(prompt, !!pr && !isMap);
    var said = pr && !isMap ? pr : "";
    if(said !== lastPrompt){                      // screen readers hear a new prompt once, not per frame
      lastPrompt = said;
      if(said) announce(mk2 ? "Press " + mk2[1] + " to " + mk2[2].charAt(0).toLowerCase() + mk2[2].slice(1) : said);
    }

    var hasSpeed = f.speed != null && isFinite(+f.speed) && !isMap;
    if(hasSpeed){
      var k = Math.abs(kmh(f.speed));
      if(k !== lastSpeed){ setText(speedNum, String(k)); lastSpeed = k; }
    }
    show(speed, hasSpeed);

    var showCompass = !isMap && mode !== "classic";
    if(showCompass){
      var hd = Math.round(heading(f.yaw) * 2) / 2;
      if(hd !== lastHeading){
        lastHeading = hd;
        var tk = compassTicks(f.yaw);
        for(var i = 0; i < ticks.length; i++){
          var n = ticks[i], d = tk[i];
          if(!d){ show(n, false); continue; }
          show(n, true);
          n.style.left = ((d.x + 1) * 50).toFixed(2) + "%";
          setText(n, d.label || "");
          var cls = "hqhud-tick" + (d.label ? " hqhud-card" : d.deg % 45 === 0 ? " hqhud-mid" : "");
          if(n.className !== cls) n.className = cls;
        }
      }
    }
    show(compass, showCompass);

    var v = isMap ? 0 : clamp(num(f.vignette, 0), 0, 1);
    v = Math.round(v * 100) / 100;
    if(v !== lastVig){ vignette.style.opacity = String(v); lastVig = v; }   // stays displayed so the opacity fades

    if(isMap && typeof f.project === "function"){
      if(W > 0 && H > 0){
        sizeCanvas(W, H);
        var o = f.project(0, 0, 0) || {}, e = f.project(100, 0, 100) || {};
        var ts = themeSig();
        var sig = [version, W, H, canvasW, Math.round(o.x * 10), Math.round(o.y * 10), Math.round(e.x * 10), Math.round(e.y * 10),
          JSON.stringify(f.peers || []), ts].join("|");
        if(sig !== lastSig){
          if(ts !== lastTheme || !colours){ readColours(); lastTheme = ts; }
          drawMap(f, W, H);
          lastSig = sig;
        }
      }
      show(labels, true);
    } else {
      if(drawn) clearLabels();
      show(labels, false);
    }
  }

  function destroy(){
    alive = false;
    if(chipTimer != null) window.clearTimeout(chipTimer);
    chipTimer = null;
    for(var i = 0; i < domL.length; i++) domL[i][0].removeEventListener(domL[i][1], domL[i][2]);
    domL = [];
    listeners = [];
    if(root.parentNode) root.parentNode.removeChild(root);
  }

  return {
    setMode: setMode,
    setLabels: setLabels,
    frame: frame,
    settings: hudSettings,
    setSettings: setSettings,
    setPreferred: function(mode){ setSettings({preferred: mode}); },
    onSettings: function(cb){ if(typeof cb === "function") listeners.push(cb); },
    openSettings: openSettings,
    labelCounts: function(){ return {roads: counts.roads, shields: counts.shields, hqs: counts.hqs, peers: counts.peers}; },
    destroy: destroy,
    root: root
  };
}

HQV.hqhud = {
  mount: mount,
  layoutLabels: layoutLabels,
  labelAngle: labelAngle,
  compassTicks: compassTicks,
  heading: heading,
  kmh: kmh,
  loadSettings: loadSettings,
  saveSettings: saveSettings,
  DEFAULTS: DEFAULTS,
  KEY: KEY
};
})();
