/* Claude HQ 2.0: the 3D headquarters (Wave 0).
 *
 * Mission Control, as a room you walk around: every live Claude Code session is a
 * crew member at a console, the holo-table in the middle shows your projects, and
 * doors lead to the rest of HQ (Lab = Analytics, Gym, Quest Board, Shop = Store,
 * Trophy Hall = Pokédex, the Valley and the Arena).
 *
 *   working   sits and types; code scrolls on the screen; a data stream runs to the table
 *   needs     stands beside the desk and waves; the screen shows what it waits on; "!"
 *   idle      slumps in the chair and dozes; screensaver; "z"
 *   stale     an empty desk (the most recent few)
 *
 * Driven only by the /api/sessions payload index.html already has: nothing new leaves
 * the machine. Walk with WASD / arrows, or click the floor to travel there; click a
 * crew member to open their card, a door to go through it, a project on the table to
 * show only its crew. Day and night follow your local clock.
 *
 * Mounted by ui/app/22-hq.js:  HQV.hq3d.mount(el, api) -> {update, pause, resume, setFilter, destroy}
 * Uses games/engine.js (three.js loading, the shared model cache) and the Kenney (CC0)
 * characters that ship with Mini Golf / Blaster Arena.
 */
(function(){
"use strict";
var HQV = window.HQV = window.HQV || {};

/* ---------- pure helpers (node-tested: tests/test_hq3d_integration.py) ---------- */
// The camera modes that orbit behind you (camrig's chase family).
var CHASE = {far: 1, chase: 1, near: 1};
var MODE_LABEL = {map: "Map", far: "Far camera", chase: "Chase camera", near: "Near camera", fp: "First person",
                  classic: "Classic camera", photo: "Photo mode", cine: "Cinematic camera"};
// Which Arena City to build: the generated 3D city, or the classic street (?world=old, or
// localStorage hq_city_impl = "old").
function cityImplOf(search, stored){
  var q = null;
  try { q = new URLSearchParams(search || "").get("world"); } catch(e){ q = null; }
  return q === "old" || stored === "old" ? "old" : "3d";
}
// A photo's file name, local time: claude-hq-YYYYMMDD-HHMMSS.png
function shotName(d){
  function p(n){ return (n < 10 ? "0" : "") + n; }
  return "claude-hq-" + d.getFullYear() + p(d.getMonth() + 1) + p(d.getDate()) + "-" + p(d.getHours()) + p(d.getMinutes()) + p(d.getSeconds()) + ".png";
}
// A gamepad's state as HQ input. axes: [lx, ly, rx, ry]; buttons: GamepadButton-likes or booleans;
// prev: last call's `pressed` (for press edges). Dead zone 0.15, the rest rescaled to 0..1.
// -> {move: [x, y], look: [x, y], cycle: -1|0|1 (LB / RB), map (Y), hop (A held), use (X: E), pressed, any}
function padToInput(axes, buttons, prev){
  axes = axes || []; buttons = buttons || []; prev = prev || [];
  function dz(v){ v = +v || 0; var a = Math.abs(v); return a < 0.15 ? 0 : (v < 0 ? -1 : 1)*Math.min(1, (a - 0.15)/0.85); }
  function on(i){ var b = buttons[i]; return !!(b && (typeof b === "object" ? b.pressed : b)); }
  var pressed = [0, 1, 2, 3, 4, 5].map(on);
  function edge(i){ return pressed[i] && !prev[i]; }
  var out = {move: [dz(axes[0]), dz(axes[1])], look: [dz(axes[2]), dz(axes[3])],
             cycle: (edge(5) ? 1 : 0) - (edge(4) ? 1 : 0), map: edge(3), hop: pressed[0], use: edge(2), pressed: pressed};
  out.any = !!(out.move[0] || out.move[1] || out.look[0] || out.look[1] || pressed.some(Boolean));
  return out;
}
// The door you look at in first person: the nearest whose 1.2 m disc round its front the view ray
// passes within maxM metres (measured along the ground). pose = {pos, look}; doors = [{front: {x, z, y?}}].
function doorUnderCrosshair(pose, doors, maxM){
  if(!pose || !pose.pos || !pose.look) return null;
  var o = pose.pos, dx = pose.look.x - o.x, dy = pose.look.y - o.y, dz = pose.look.z - o.z, len = Math.hypot(dx, dy, dz);
  if(!(len > 1e-6)) return null;
  dx /= len; dy /= len; dz /= len;
  var h2 = dx*dx + dz*dz, best = null, bt = Infinity, R = 1.2;
  (doors || []).forEach(function(d){
    var f = d && (d.front || d); if(!f || f.x == null || f.z == null) return;
    var t = h2 > 1e-9 ? ((f.x - o.x)*dx + (f.z - o.z)*dz)/h2 : 0;     // ray parameter of the closest approach on the ground plane
    if(t < 0) return;
    var px = o.x + dx*t, pz = o.z + dz*t;
    if(Math.hypot(f.x - px, f.z - pz) > R) return;
    if(Math.sqrt(h2)*t > maxM) return;
    if(f.y != null){ var y = o.y + dy*t; if(y < f.y - 0.5 || y > f.y + 3.5) return; }
    if(t < bt){ bt = t; best = d; }
  });
  return best;
}
// What a click on the City map does, from w.mapPick(x, z): your HQ dives into 3D at its door,
// someone else's flies the map to their lot (no teleport), anywhere else flies the map there.
function mapClickAction(p){
  if(!p) return null;
  if(p.kind === "hq" && p.you && p.door){
    var lx = p.lot ? p.lot.x : p.door.x, lz = p.lot ? p.lot.z : p.door.z - 1;
    return {act: "dive", x: p.door.x, z: p.door.z, yaw: Math.atan2(p.door.x - lx, p.door.z - lz)};
  }
  if(p.kind === "hq" && p.lot) return {act: "fly", x: p.lot.x, z: p.lot.z, span: 44, name: p.name || null};
  return {act: "fly", x: +p.x || 0, z: +p.z || 0};
}
// Critically damped spring, exact closed form (as games/camrig.js): the same goal reached in any number of steps.
// -> [x, v]
function spring(x, v, goal, omega, dt){
  x = +x || 0; v = +v || 0; dt = Math.max(0, +dt || 0);
  var c1 = x - goal, c2 = v + omega*c1, e = Math.exp(-omega*dt);
  return [goal + (c1 + c2*dt)*e, (c2 - omega*(c1 + c2*dt))*e];
}
// The share of the way to a goal to cover this frame at rate k: 1 - exp(-k dt) (frame-rate independent).
function ease(k, dt){ return 1 - Math.exp(-Math.max(0, +k || 0)*Math.max(0, +dt || 0)); }
function wrapPi(a){ a = +a || 0; return Math.atan2(Math.sin(a), Math.cos(a)); }
// On foot in the chase cameras: m/s, the back-step share, rad/s, and the springs' omegas.
var FOOT = {walk: 4, run: 7, back: 0.65, turn: 2.4, turnW: 10, speedW: 12};
// Where you are headed: facing while going forward or turning, facing + PI while stepping back, null when still.
function travelYawOf(yaw, speed, rate){
  speed = +speed || 0; rate = +rate || 0;
  if(speed < -0.05) return wrapPi(yaw + Math.PI);
  return speed > 0.05 || Math.abs(rate) > 0.05 ? wrapPi(yaw) : null;
}
// One body-relative step on foot (chase family). st = {yaw, rate, rateV, speed (signed), speedV};
// inp = {fwd: -1..1 (W +, S -), turn: -1..1 (A +, turns left), run}. The turn rate springs toward
// +-2.4 rad/s and the yaw integrates it; the speed springs toward 4 / 7 m/s forward or 0.65x back.
// -> a new state plus travelYaw.
function footStep(st, inp, dt){
  st = st || {}; inp = inp || {}; dt = Math.max(0, +dt || 0);
  var fwd = Math.max(-1, Math.min(1, +inp.fwd || 0)), turn = Math.max(-1, Math.min(1, +inp.turn || 0));
  var base = inp.run ? FOOT.run : FOOT.walk, rate0 = +st.rate || 0;
  var r = spring(rate0, st.rateV, turn*FOOT.turn, FOOT.turnW, dt);
  var s = spring(st.speed, st.speedV, fwd > 0 ? fwd*base : fwd*base*FOOT.back, FOOT.speedW, dt);
  var yaw = wrapPi((+st.yaw || 0) + (rate0 + r[0])*0.5*dt);          // trapezoid over the frame
  return {yaw: yaw, rate: r[0], rateV: r[1], speed: s[0], speedV: s[1], travelYaw: travelYawOf(yaw, s[0], r[0])};
}
HQV.hq3dPure = {cityImplOf: cityImplOf, shotName: shotName, padToInput: padToInput, doorUnderCrosshair: doorUnderCrosshair,
                mapClickAction: mapClickAction, spring: spring, ease: ease, footStep: footStep, travelYawOf: travelYawOf,
                FOOT: FOOT, CHASE: CHASE, MODE_LABEL: MODE_LABEL};

var E = HQV.engine;
if(!E){ return; }

var PI = Math.PI;
var CHAR_FILES = ["character-female-a", "character-male-a", "character-female-c", "character-male-c", "character-female-e", "character-male-e"];
// the six characters and their model height, for the City's residents (games/npcdraw.js keeps copies)
HQV.hq3dPure.CHAR_FILES = CHAR_FILES; HQV.hq3dPure.CH_H = 0.72;
var COL = {cyan: 0x5fd3e6, coral: 0xff6b5b, violet: 0x9b8cf0, amber: 0xffb347, green: 0x6fd38a};
var HEX = {cyan: "#5fd3e6", coral: "#ff6b5b", violet: "#9b8cf0", amber: "#ffb347", green: "#6fd38a", ink: "#e9eff3", muted: "#93a7b7", stale: "#5b6b78"};
var STATE_COL = {working: COL.cyan, needs: COL.coral, idle: COL.violet, stale: 0x3a4652};
var STATE_HEX = {working: HEX.cyan, needs: HEX.coral, idle: HEX.violet, stale: HEX.stale};
var STATE_TXT = {working: "Working", needs: "Needs you", idle: "Idle", stale: "Away"};
var ROOM = 15;                       // the room spans -ROOM..ROOM on x and z
var TABLE = {x: 0, z: -4.5, r: 3.2};
var MAX_DESKS = 16, MAX_STALE = 6;
var DOORS = [
  {view: "analytics", label: "Lab", wall: "left", at: -10, col: COL.cyan},
  {view: "gym", label: "Gym", wall: "left", at: -5, col: COL.coral},
  {view: "quests", label: "Quest Board", wall: "left", at: 0, col: COL.amber},
  {view: "store", label: "Shop", wall: "left", at: 5, col: COL.green},
  {view: "pokedex", label: "Trophy Hall", wall: "left", at: 10, col: COL.violet},
  {view: "valley", label: "Valley", wall: "back", at: 8, col: COL.green},
  {view: "arena", label: "Arena", wall: "back", at: 12, col: COL.cyan},
  {view: "@lobby", label: "Lift to Lobby", wall: "left", at: 13.5, col: COL.amber}
];
// The other floors of the building register here (games/hqlobby.js, games/hqbase.js):
// HQV.hqWorlds[name] = function(ctx){ return world }  (see mount() for ctx and the world shape)
HQV.hqWorlds = HQV.hqWorlds || {};

function hashStr(s){ var h = 2166136261 >>> 0; s = String(s); for(var i = 0; i < s.length; i++){ h ^= s.charCodeAt(i); h = Math.imul(h, 16777619) >>> 0; } return h >>> 0; }
function rng(seed){ var a = seed >>> 0 || 1; return function(){ a = (a + 0x6D2B79F5) >>> 0; var t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0)/4294967296; }; }
function rr(g, x, y, w, h, r){ g.beginPath(); if(g.roundRect) g.roundRect(x, y, w, h, r); else g.rect(x, y, w, h); }
function short(s, n){ s = String(s || "").replace(/\s+/g, " ").trim(); return s.length > n ? s.slice(0, n - 1) + "…" : s; }
function crewState(s){
  var st = s && s.status;
  return st === "working" || st === "needs" || st === "idle" ? st : "stale";
}
// The project a session works in: its working folder's name (the transcript folder name is an
// encoded path like "-Users-me-code", so prefer cwd).
function projectOf(s){
  var c = s && s.cwd ? String(s.cwd).replace(/\/+$/, "").split("/").pop() : "";
  var f = s && s.folder ? String(s.folder) : "";
  if(!c && f.charAt(0) === "-") c = f.split("-").filter(Boolean).pop();
  return (c || f || "other").slice(0, 40);
}
function titleOf(s){
  var t = s && s.title ? String(s.title) : "";
  if(t && !/^untitled/i.test(t)) return t;
  var n = s && s.name ? String(s.name) : "";
  return n && !/^[0-9a-f]{6,}$/i.test(n) ? n : projectOf(s);      // a bare id says nothing: show the project
}
function activityOf(s){ var sp = (s && s.spark) || []; var n = 0; for(var i = 0; i < sp.length; i++) n += +sp[i] || 0; return n; }

function mount(el, api){
  var inst = {alive: true, running: false};
  var THREE = null, L = null;
  var canvas = document.createElement("canvas");
  canvas.className = "hq3d-canvas"; canvas.setAttribute("aria-label", "3D headquarters: your sessions as crew at their desks");
  canvas.tabIndex = 0;
  el.appendChild(canvas);
  var tip = document.createElement("div"); tip.className = "hq3d-tip"; tip.hidden = true; el.appendChild(tip);
  var loading = document.createElement("div"); loading.className = "hq3d-loading"; loading.textContent = "Building your HQ…"; el.appendChild(loading);
  var fadeEl = document.createElement("div"); fadeEl.className = "hq3d-fade"; fadeEl.setAttribute("aria-hidden", "true"); el.appendChild(fadeEl);
  var rideUi = document.createElement("button"); rideUi.type = "button"; rideUi.className = "hq3d-ride"; rideUi.hidden = true;
  rideUi.addEventListener("click", function(){ rideToggle(); canvas.focus(); }); el.appendChild(rideUi);

  var renderer, scene, cam, clock0 = E.now();
  var tgt = null;                      // where the build helpers add things (a world's scene while it is built)
  var worlds = {}, cur = null, fading = false;
  var view = {yaw: PI/4, pitch: 0.62, zoom: 1.45, target: null, goal: null, span: 12};
  var desks = [], deskById = {}, clickables = [], doorHits = [], projHits = [];
  // Everyone is drawn 1.7 m tall against CH_H, the height of the six Mini Characters' shared
  // skeleton to the top of the hair (model units, ~0.67-0.79 by hairstyle): one fixed figure, so
  // everyone is the same size whichever model happened to load first.
  var avatar = null, charLib = {}, CH_H = 0.72;
  var filter = null, sessions = [];
  var tex = {}, wall = null, sky = {}, lamps = [], winPanes = [], streams = [], holo = {};
  var night = null, raf = 0, last = 0, acc = {scr: 0, wall: 0, sky: 0};
  var keys = {}, walkTo = null, walkDoor = null;
  // The 3D City (worlds with camModes): a perspective camera driven by games/camrig.js, the HUD of
  // games/hqhud.js and the quality governor of games/worldbuild.js. Other worlds keep the ortho `cam`.
  var pcam = null, rig = null, hud = null, pose = null, camSet = null, lastMode = null, lastFpView = null, calmWas = null, calmT = 0;
  var gov = null, govQ = null, perf = {t: 0, n: 0, ms: 0}, entering = null, cityFailed = false, failLogged = false, cityRetried = false;
  var idleT = 0, occT = 0, pad = {on: false, prev: [], st: null}, frustum = null, projM = null, projV = null, lastPeers = [];
  var SMOKE = smokeParams();
  // URL hooks for tools/ui_smoke.py and tools/hq_shots.py (inert without ?hqsmoke=1; ?hqperf=1 logs frame times).
  function smokeParams(){
    var q; try { q = new URLSearchParams(location.search); } catch(e){ return null; }
    var perfOn = q.get("hqperf") === "1";
    if(q.get("hqsmoke") !== "1") return perfOn ? {on: false, perf: true} : null;
    var at = (q.get("at") || "").split(",").map(Number);
    return {on: true, perf: perfOn, cam: q.get("cam"), night: q.get("night") === "1", ride: q.get("ride"), span: +q.get("span") || null,
            calm: q.get("calm") === "1", yaw: q.get("yaw") != null && isFinite(+q.get("yaw")) && q.get("yaw") !== "" ? +q.get("yaw") : null, at: at.length === 2 && isFinite(at[0]) && isFinite(at[1]) ? {x: at[0], z: at[1]} : null,
            frames: 0, applied: false, done: false, peer: null};
  }

  /* ---------- helpers ---------- */
  function mat(c, o){ return new THREE.MeshStandardMaterial(Object.assign({color: c, roughness: 0.7, metalness: 0.08}, o || {})); }
  function emis(c, e, ei, o){ var m = mat(c, o); m.emissive = new THREE.Color(e); m.emissiveIntensity = ei; return m; }
  function add(o, x, y, z, p, noShadow){ o.position.set(x, y, z); if(!noShadow){ o.castShadow = true; o.receiveShadow = true; } (p || tgt).add(o); return o; }
  function box(w, h, d, m, x, y, z, p, ns){ return add(new THREE.Mesh(new THREE.BoxGeometry(w, h, d), m), x, y, z, p, ns); }
  function cyl(rt, rb, h, m, x, y, z, p, seg){ return add(new THREE.Mesh(new THREE.CylinderGeometry(rt, rb, h, seg || 20), m), x, y, z, p); }
  function sph(r, m, x, y, z, p){ return add(new THREE.Mesh(new THREE.SphereGeometry(r, 14, 10), m), x, y, z, p); }
  function canvasTex(w, h, draw){
    var c = document.createElement("canvas"); c.width = w; c.height = h; var g = c.getContext("2d");
    if(draw) draw(g, w, h);
    var t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; t.anisotropy = 4;
    return {c: c, g: g, t: t};
  }
  function screen(w, h, t, transparent){
    return new THREE.Mesh(new THREE.PlaneGeometry(w, h), new THREE.MeshBasicMaterial({map: t, transparent: !!transparent, toneMapped: false}));
  }
  function glowSprite(color, size, op){
    var s = new THREE.Sprite(new THREE.SpriteMaterial({map: tex.glow, color: color, transparent: true, opacity: op == null ? 0.8 : op,
      blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false}));
    s.scale.set(size, size, 1); return s;
  }
  function label(text, color, scale){
    var T = canvasTex(512, 128, function(g){
      g.font = "600 50px system-ui, -apple-system, sans-serif";
      var w = Math.min(500, g.measureText(text).width + 56);
      g.fillStyle = "rgba(14,25,35,.88)"; g.strokeStyle = color; g.lineWidth = 5;
      rr(g, 256 - w/2, 18, w, 92, 30); g.fill(); g.stroke();
      g.fillStyle = HEX.ink; g.textAlign = "center"; g.textBaseline = "middle"; g.fillText(text, 256, 66);
    });
    var s = new THREE.Sprite(new THREE.SpriteMaterial({map: T.t, transparent: true, depthTest: false, toneMapped: false}));
    var k = scale || 1; s.scale.set(4*k, k, 1); s.renderOrder = 5; return s;
  }
  function glyph(ch, color){
    var T = canvasTex(128, 128, function(g){
      g.fillStyle = color; g.beginPath(); g.arc(64, 64, 52, 0, 7); g.fill();
      g.fillStyle = "#0e1923"; g.font = "700 72px system-ui, sans-serif"; g.textAlign = "center"; g.textBaseline = "middle"; g.fillText(ch, 64, 70);
    });
    var s = new THREE.Sprite(new THREE.SpriteMaterial({map: T.t, transparent: true, depthTest: false, toneMapped: false}));
    s.scale.set(0.55, 0.55, 1); s.renderOrder = 6; return s;
  }
  function plant(x, z, s, seed){
    var g = new THREE.Group(); g.position.set(x, 0, z); g.scale.setScalar(s); tgt.add(g);
    cyl(0.42, 0.32, 0.72, mat(0xd9d2c3, {roughness: 0.9}), 0, 0.36, 0, g);
    var R = rng(seed), greens = [0x2f7d4a, 0x3c9a5a, 0x276b3e, 0x4caf6a];
    for(var i = 0; i < 9; i++){
      var a = i/9*PI*2 + R(), l = sph(0.22 + R()*0.12, mat(greens[i % 4], {roughness: 0.8}), Math.cos(a)*0.25, 0.95 + R()*0.7, Math.sin(a)*0.25, g);
      l.scale.set(0.7, 1.6, 0.5); l.rotation.set((R() - 0.5)*0.8, a, (R() - 0.5)*0.9);
    }
  }

  /* ---------- the vehicles ---------- */
  // Built round the people who ride them (the Mini Characters: short legs, long arms, a big head).
  // Each says where its rider goes: a-seat (the hips), a-grip-l / a-grip-r (the hands) and
  // a-foot-l / a-foot-r (pegs or pedals). The grips turn with the bars and the pedals go round with
  // the cranks, so a rider's hands follow the steering and the feet pedal (ridePose).
  // A kind is modelled once from rounded, bevelled parts, merged per material within each rigid
  // piece (the body; each wheel; the bars; the cranks; the steering wheel), then cloned for every
  // car, bike and motorbike on the street with its own paint: a handful of draw calls each, and
  // nothing modelled again when the street is rebuilt. {g, wheels, steer, seat, grips, feet, R,
  // lean, brake(on)}; a bicycle adds crank, a car spin (its steering wheel) and hats: false (a hat
  // would not fit under the roof).
  var VBP = {};
  var NO_SHADOW = {glass: 1, tint: 1, head: 1, tail: 1, lamp: 1, plate: 1, liner: 1};
  function V3(x, y, z){ return new THREE.Vector3(x, y, z); }
  function vpart(mk, geo, p, x, y, z, rx, ry, rz){
    var m = new THREE.Mesh(geo); m.userData.mk = mk; m.position.set(x || 0, y || 0, z || 0);
    if(rx || ry || rz) m.rotation.set(rx || 0, ry || 0, rz || 0);
    p.add(m); return m;
  }
  // (not "rig": that is the camera rig below, and a var of that name would shadow this function)
  function rigidPart(p, name, x, y, z){ var g = new THREE.Group(); g.name = name; g.userData.rigid = true; g.position.set(x || 0, y || 0, z || 0); p.add(g); return g; }
  function anchor(p, name, x, y, z){ var o = new THREE.Object3D(); o.name = name; o.position.set(x, y, z); p.add(o); return o; }
  function rrShape(w, h, r){                      // a rounded rectangle, centred
    var s = new THREE.Shape(), x = -w/2, y = -h/2; r = Math.max(0.001, Math.min(r, w/2, h/2));
    s.moveTo(x + r, y); s.lineTo(x + w - r, y); s.quadraticCurveTo(x + w, y, x + w, y + r); s.lineTo(x + w, y + h - r);
    s.quadraticCurveTo(x + w, y + h, x + w - r, y + h); s.lineTo(x + r, y + h); s.quadraticCurveTo(x, y + h, x, y + h - r);
    s.lineTo(x, y + r); s.quadraticCurveTo(x, y, x + r, y); return s;
  }
  // a rounded slab, w × h × d (x, y, z), its corners rounded by r and its edges bevelled by b, centred
  function slabGeo(w, h, d, r, b){
    b = b == null ? Math.min(0.02, d/4, w/4, h/4) : b; if(b < 0.005) b = 0;      // (small parts: rounded corners, no bevel: fewer triangles)
    var g = new THREE.ExtrudeGeometry(rrShape(Math.max(0.004, w - 2*b), Math.max(0.004, h - 2*b), r),
      {depth: Math.max(0.001, d - 2*b), bevelEnabled: b > 0, bevelThickness: b, bevelSize: b, bevelSegments: b > 0.012 ? 2 : 1, curveSegments: r > 0.03 ? 4 : 2});
    g.translate(0, 0, -Math.max(0.001, d - 2*b)/2); return g;
  }
  function slab(mk, w, h, d, r, p, x, y, z, rx, ry, rz, b){ return vpart(mk, slabGeo(w, h, d, r, b), p, x, y, z, rx, ry, rz); }
  // a side profile (a shape in (z, y)) extruded across the width w (x), its edges bevelled by b
  function sideGeo(shape, w, b){
    var g = new THREE.ExtrudeGeometry(shape, {depth: Math.max(0.001, w - 2*b), bevelEnabled: b > 0, bevelThickness: b, bevelSize: b, bevelSegments: 2, curveSegments: 8});
    g.rotateY(-PI/2); g.translate((w - 2*b)/2, 0, 0); return g;
  }
  function poly(pts){ var s = new THREE.Shape(); s.moveTo(pts[0][0], pts[0][1]); for(var i = 1; i < pts.length; i++) s.lineTo(pts[i][0], pts[i][1]); return s; }
  // a flat bar from a to b (a pillar, a strut): w wide (x) and d deep, its edges rounded
  function bar(mk, a, b, w, d, p){
    var dd = new THREE.Vector3().subVectors(b, a), m = vpart(mk, slabGeo(w, dd.length(), d, Math.min(w, d)/3), p);
    m.position.copy(a).addScaledVector(dd, 0.5); m.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), dd.normalize()); return m;
  }
  function rod(mk, a, b, r, p, seg){
    var d = new THREE.Vector3().subVectors(b, a), m = vpart(mk, new THREE.CylinderGeometry(r, r, Math.max(0.001, d.length()), seg || 8), p);
    m.position.copy(a).addScaledVector(d, 0.5); m.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), d.normalize()); return m;
  }
  function ring(mk, R, t, p, x, y, z, seg){ return vpart(mk, new THREE.TorusGeometry(R, t, t > 0.03 ? 8 : 5, seg || 32), p, x, y, z, 0, PI/2, 0); }   // in the y-z plane (a wheel's)
  function disc(mk, r, w, p, x, y, z, seg){ return vpart(mk, new THREE.CylinderGeometry(r, r, w, seg || 20), p, x, y, z, 0, 0, PI/2); }   // its axle along x
  // part of a ring over a wheel (a mudguard, an arch): from angle a0 to a1, 0 at the back (-z),
  // PI/2 on top, PI at the front
  function arcGeo(R, t, a0, a1){ var g = new THREE.TorusGeometry(R, t, 6, 18, a1 - a0); g.rotateZ(a0); g.rotateY(PI/2); return g; }

  // merge every mesh of a rigid piece into one per material (positions and normals; uvs when all have them)
  function mergeGeos(list){
    var n = 0, uv = true;
    list.forEach(function(g){ n += g.attributes.position.count; if(!g.attributes.uv) uv = false; });
    var P = new Float32Array(n*3), N = new Float32Array(n*3), U = uv ? new Float32Array(n*2) : null, o = 0;
    list.forEach(function(g){ var c = g.attributes.position.count;
      P.set(g.attributes.position.array, o*3); N.set(g.attributes.normal.array, o*3); if(U) U.set(g.attributes.uv.array, o*2); o += c; g.dispose(); });
    var out = new THREE.BufferGeometry(); out.setAttribute("position", new THREE.BufferAttribute(P, 3)); out.setAttribute("normal", new THREE.BufferAttribute(N, 3));
    if(U) out.setAttribute("uv", new THREE.BufferAttribute(U, 2));
    out.computeBoundingSphere(); return out;
  }
  function compile(root){
    root.userData.rigid = true; root.updateMatrixWorld(true);
    var rigids = []; root.traverse(function(o){ if(o.userData.rigid) rigids.push(o); });
    rigids.forEach(function(R){
      var inv = new THREE.Matrix4().copy(R.matrixWorld).invert(), by = {}, done = [];
      (function walk(o){ o.children.forEach(function(ch){
        if(ch.userData.rigid) return;
        if(ch.isMesh && ch.userData.mk){
          var gm = ch.geometry.index ? ch.geometry.toNonIndexed() : ch.geometry.clone();
          gm.applyMatrix4(new THREE.Matrix4().multiplyMatrices(inv, ch.matrixWorld));
          (by[ch.userData.mk] = by[ch.userData.mk] || []).push(gm); done.push(ch);
        }
        walk(ch);
      }); })(R);
      done.forEach(function(m){ m.parent.remove(m); m.geometry.dispose(); });
      Object.keys(by).forEach(function(mk){
        var m = new THREE.Mesh(mergeGeos(by[mk])); m.userData.mk = mk; m.castShadow = !NO_SHADOW[mk]; m.receiveShadow = mk !== "glass";
        if(mk === "glass" || mk === "tint") m.renderOrder = 2;
        R.add(m);
      });
    });
    return root;
  }
  // one vehicle's materials: c1 its paint, c2 the accent (stripes, the rims of a motorbike)
  // Number plates read the HQ's name (its sign), upper case; one texture per text, the font shrinks to fit.
  var plateTexs = {};
  function plateText(s){
    s = String(s == null ? "" : s).toUpperCase().replace(/[^A-Z0-9 '·.&-]/g, "").replace(/\s+/g, " ").trim();
    return s ? s.slice(0, 18) : "HQ·CITY";
  }
  function plateTexFor(txt){
    txt = plateText(txt);
    return plateTexs[txt] || (plateTexs[txt] = canvasTex(128, 40, function(g){
      g.fillStyle = "#f1f0e8"; g.fillRect(0, 0, 128, 40); g.strokeStyle = "#20242a"; g.lineWidth = 3; g.strokeRect(3, 3, 122, 34);
      g.fillStyle = "#20242a"; g.textAlign = "center"; g.textBaseline = "middle";
      var px = 21; g.font = "700 " + px + "px ui-monospace, Menlo, monospace";
      while(px > 10 && g.measureText(txt).width > 112){ px -= 1; g.font = "700 " + px + "px ui-monospace, Menlo, monospace"; }
      g.fillText(txt, 64, 21);
    }).t);
  }
  function vmats(c1, c2, plate){
    var plateTex = plateTexFor(plate);
    return {
      paint: mat(c1, {metalness: 0.45, roughness: 0.3}), accent: mat(c2, {metalness: 0.4, roughness: 0.34}),
      dark: mat(0x1b1f25, {roughness: 0.72}), trim: mat(0x2b3038, {roughness: 0.82}), seat: mat(0x26292f, {roughness: 0.92}),
      tyre: mat(0x17191c, {roughness: 0.95}), rim: mat(0xb9c2cb, {metalness: 0.85, roughness: 0.28}),
      chrome: mat(0xdfe5ec, {metalness: 0.95, roughness: 0.16}),
      glass: new THREE.MeshStandardMaterial({color: 0x9cc6e4, metalness: 0.2, roughness: 0.05, transparent: true, opacity: 0.26, depthWrite: false,
                                             emissive: new THREE.Color(0x1d3446), emissiveIntensity: 0.35}),
      tint: new THREE.MeshStandardMaterial({color: 0x30536e, metalness: 0.3, roughness: 0.05, transparent: true, opacity: 0.5, depthWrite: false}),
      liner: mat(0x0e1013, {roughness: 1, side: THREE.DoubleSide}),
      head: emis(0xfff6e0, 0xfff1c8, 1.4), tail: emis(0x5a0d12, 0xff3344, 0.9), lamp: emis(0xffb347, 0xffa020, 0.7),
      plate: new THREE.MeshStandardMaterial({map: plateTex, roughness: 0.6})
    };
  }
  function vehicle(kind, c1, c2, plate){
    var bp = VBP[kind] || (VBP[kind] = compile(BUILD[kind]()));
    var g = bp.clone(true), M = vmats(c1, c2 == null ? 0xf2f2f2 : c2, plate), on = null;
    g.traverse(function(o){ if(o.isMesh) o.material = M[o.userData.mk] || M.dark; });
    function get(n){ return g.getObjectByName(n); }
    return {g: g, M: M, get: get, seat: get("a-seat"), grips: [get("a-grip-l"), get("a-grip-r")], feet: [get("a-foot-l"), get("a-foot-r")],
            brake: function(b){ b = !!b; if(b === on) return; on = b; M.tail.emissiveIntensity = b ? 3.4 : 0.9; }};
  }

  // A bicycle: forward is +z, wheels on the ground, sized for those legs (a small diamond frame).
  var BIKE_WR = 0.3, BIKE_WB = 0.94, BIKE_CR = 0.1;
  function buildBike(){
    var g = new THREE.Group(), WR = BIKE_WR, WB = BIKE_WB, CR = BIKE_CR;
    function wheel(p, name, x, y, z){
      var w = rigidPart(p, name, x, y, z);
      ring("tyre", WR - 0.024, 0.024, w, 0, 0, 0, 40);
      ring("rim", WR - 0.052, 0.011, w, 0, 0, 0, 40);
      disc("chrome", 0.024, 0.08, w, 0, 0, 0, 10);
      for(var i = 0; i < 16; i++){                                                 // laced spokes, both flanges
        var a = i/16*PI*2, sx = i % 2 ? 0.028 : -0.028;
        rod("chrome", V3(sx, Math.cos(a)*0.024, Math.sin(a)*0.024), V3(0, Math.cos(a + 0.25)*(WR - 0.058), Math.sin(a + 0.25)*(WR - 0.058)), 0.0035, w, 4);
      }
      return w;
    }
    var BB = V3(0, 0.3, -0.02), ST = V3(0, 0.53, -0.2), H = V3(0, 0.8, 0.3), Hb = V3(0, 0.6, 0.34);
    var rear = wheel(g, "wheel-0", 0, WR, -WB/2);
    disc("chrome", 0.036, 0.012, rear, 0.05, 0, 0, 14);                            // the rear cog
    // the diamond frame
    rod("paint", BB, V3(0, 0.56, -0.21), 0.019, g, 10); rod("paint", BB, Hb, 0.021, g, 10); rod("paint", ST, H, 0.018, g, 10);
    rod("paint", Hb, V3(0, 0.83, 0.29), 0.026, g, 10);
    [0.05, -0.05].forEach(function(x){ rod("paint", BB, V3(x, WR, -WB/2), 0.011, g, 8); rod("paint", ST, V3(x, WR, -WB/2), 0.01, g, 8); });
    disc("dark", 0.03, 0.09, g, 0, BB.y, BB.z, 12);                                // the bottom bracket shell
    // the chain, round the chainring and the cog (they turn; it is drawn still)
    rod("dark", V3(0.05, BB.y + 0.072, BB.z), V3(0.05, WR + 0.034, -WB/2), 0.006, g, 4);
    rod("dark", V3(0.05, BB.y - 0.072, BB.z), V3(0.05, WR - 0.034, -WB/2), 0.006, g, 4);
    // the seat post, the saddle and a rear reflector
    rod("chrome", ST, V3(0, 0.59, -0.225), 0.012, g, 8);
    var sad = new THREE.Shape(); sad.moveTo(-0.34, 0.585); sad.quadraticCurveTo(-0.35, 0.625, -0.27, 0.628); sad.lineTo(-0.14, 0.618);
    sad.quadraticCurveTo(-0.06, 0.612, -0.05, 0.6); sad.quadraticCurveTo(-0.06, 0.585, -0.12, 0.588); sad.lineTo(-0.34, 0.585);
    vpart("seat", sideGeo(sad, 0.13, 0.018), g);
    slab("tail", 0.05, 0.03, 0.012, 0.01, g, 0, 0.55, -0.24, 0, 0, 0, 0.003);
    // the steering: fork, front wheel, bars, a light and a bell turn about the head tube
    var steer = rigidPart(g, "steer", H.x, H.y, H.z);
    wheel(steer, "wheel-1", 0, WR - H.y, WB/2 - H.z);
    [0.045, -0.045].forEach(function(x){ rod("paint", V3(x, Hb.y - H.y, Hb.z - H.z), V3(x, WR - H.y, WB/2 - H.z), 0.012, steer, 8); });
    slab("paint", 0.12, 0.03, 0.05, 0.01, steer, 0, Hb.y - H.y - 0.01, Hb.z - H.z, 0, 0, 0, 0.008);   // fork crown
    rod("chrome", V3(0, 0, 0), V3(0, 0.1, 0.02), 0.014, steer, 8);                 // stem
    [1, -1].forEach(function(s){ rod("chrome", V3(0, 0.1, 0.03), V3(s*0.27, 0.12, 0.0), 0.011, steer, 8);   // riser bars
      vpart("dark", new THREE.CylinderGeometry(0.018, 0.018, 0.1, 10), steer, s*0.255, 0.119, 0.004, 0, 0, PI/2); });
    slab("head", 0.05, 0.035, 0.03, 0.012, steer, 0, 0.07, 0.07, 0, 0, 0, 0.006);  // the light
    vpart("chrome", new THREE.CylinderGeometry(0.018, 0.022, 0.016, 12), steer, 0.13, 0.13, 0.02);   // the bell
    anchor(steer, "a-grip-l", 0.254, 0.118, 0.005); anchor(steer, "a-grip-r", -0.254, 0.118, 0.005);
    // the cranks, the chainring and the pedals turn about the bottom bracket (left pedal on +x: the rider faces +z)
    var crank = rigidPart(g, "crank", BB.x, BB.y, BB.z);
    ring("chrome", 0.072, 0.009, crank, 0.05, 0, 0, 30); disc("dark", 0.064, 0.008, crank, 0.05, 0, 0, 20);
    [[1, 0.06], [-1, -0.06]].forEach(function(sd){
      var arm = new THREE.Group(); arm.rotation.x = sd[0] > 0 ? 0 : PI; crank.add(arm);
      slab("chrome", 0.018, CR + 0.02, 0.026, 0.008, arm, sd[1], -CR/2, 0, 0, 0, 0, 0.004);
      slab("dark", 0.09, 0.018, 0.055, 0.008, arm, sd[1]*2, -CR, 0, 0, 0, 0, 0.004);
      anchor(arm, sd[0] > 0 ? "a-foot-l" : "a-foot-r", sd[1]*2, -CR, 0);
    });
    anchor(g, "a-seat", 0, 0.62, -0.2);
    return g;
  }
  function bikeModel(color, c2){
    var V = vehicle("bike", color, c2);
    return {g: V.g, wheels: [V.get("wheel-0"), V.get("wheel-1")], crank: V.get("crank"), steer: V.get("steer"), R: BIKE_WR,
            seat: V.seat, grips: V.grips, feet: V.feet, lean: 0.22, brake: function(){}};
  }
  // Roll a bike's wheels and cranks forward by `d` metres, its bars turned by `st` (-1..1).
  function bikeRoll(B, d, st){
    if(!B) return;
    B.wheels[0].rotation.x += d/BIKE_WR; B.wheels[1].rotation.x += d/BIKE_WR;
    B.crank.rotation.x += d/BIKE_WR*0.5;
    if(st != null) B.steer.rotation.y = st*0.45;
  }

  // A car you can drive: forward is +z, wheels on the ground, a rounded little hatchback with a
  // tall glass cabin round a driver (right-hand drive) you see through the windows and the
  // sunroof, hands on the wheel. Paint and an accent stripe.
  var CAR_WR = 0.34, CAR_WX = 0.79, CAR_WZ = 1.2;
  function buildCar(){
    var g = new THREE.Group();
    // the lower body: its side profile, both wheel arches cut out, extruded across and rounded off
    var s = new THREE.Shape();
    s.moveTo(-1.8, 0.36); s.lineTo(-1.66, 0.3); s.lineTo(-CAR_WZ - 0.46, 0.34);
    s.absarc(-CAR_WZ, 0.34, 0.46, PI, 0, true); s.lineTo(-CAR_WZ + 0.46, 0.3);
    s.lineTo(CAR_WZ - 0.46, 0.3); s.lineTo(CAR_WZ - 0.46, 0.34);
    s.absarc(CAR_WZ, 0.34, 0.46, PI, 0, true); s.lineTo(1.66, 0.3); s.lineTo(1.8, 0.36);
    s.lineTo(1.84, 0.6); s.quadraticCurveTo(1.84, 0.8, 1.56, 0.84); s.lineTo(0.8, 0.92);
    s.lineTo(-1.24, 0.92); s.lineTo(-1.62, 0.89); s.quadraticCurveTo(-1.84, 0.86, -1.84, 0.64); s.lineTo(-1.8, 0.36);
    vpart("paint", sideGeo(s, 1.76, 0.06), g);
    // inside the arches: dark liners, so the wheels stand out
    [-CAR_WZ, CAR_WZ].forEach(function(z){ vpart("liner", new THREE.CylinderGeometry(0.41, 0.41, 1.58, 16, 1, true, 0, PI), g, 0, 0.34, z, 0, 0, PI/2); });
    // the cabin: glass all round (windscreen, side windows, the rear), under a roof with a sunroof
    var gh = poly([[-1.5, 0.95], [-1.2, 1.6], [-1.0, 1.68], [0.26, 1.68], [0.44, 1.6], [0.84, 0.95]]);
    vpart("glass", sideGeo(gh, 1.56, 0.05), g);
    var roof = rrShape(1.62, 1.36, 0.2); roof.holes.push(rrShape(1.0, 0.8, 0.14));
    var rg = new THREE.ExtrudeGeometry(roof, {depth: 0.03, bevelEnabled: true, bevelThickness: 0.02, bevelSize: 0.02, bevelSegments: 2, curveSegments: 6});
    rg.rotateX(PI/2); rg.translate(0, 1.77, -0.36); vpart("paint", rg, g);
    slab("tint", 1.02, 0.012, 0.82, 0.14, g, 0, 1.755, -0.36, 0, 0, 0, 0.004);    // the sunroof: tinted glass you see the driver through
    // the pillars and the window frames
    [1, -1].forEach(function(sx){
      var x = sx*0.79;
      bar("paint", V3(x, 0.95, 0.85), V3(x, 1.73, 0.4), 0.07, 0.1, g);             // A
      bar("trim", V3(x, 0.95, -0.4), V3(x, 1.74, -0.4), 0.06, 0.09, g);             // B
      bar("paint", V3(x, 0.95, -1.46), V3(x, 1.72, -1.06), 0.08, 0.2, g);          // C
      bar("trim", V3(x, 1.7, 0.42), V3(x, 1.72, -1.02), 0.05, 0.05, g);             // the top of the door frames
      slab("trim", 0.03, 0.03, 2.1, 0.01, g, sx*0.82, 0.975, -0.22, 0, 0, 0, 0.008);   // the belt line
      // the side: door shut lines, handles, the accent stripe, the mirror
      slab("trim", 0.01, 0.56, 0.012, 0.004, g, sx*0.886, 0.64, 0.76, 0, 0, 0, 0.002);
      slab("trim", 0.01, 0.56, 0.012, 0.004, g, sx*0.886, 0.64, -0.44, 0, 0, 0, 0.002);
      slab("chrome", 0.02, 0.035, 0.12, 0.01, g, sx*0.89, 0.84, -0.3, 0, 0, 0, 0.006);
      slab("accent", 0.012, 0.075, 3.0, 0.01, g, sx*0.886, 0.8, 0, 0, 0, 0, 0.003);
      rod("paint", V3(sx*0.84, 1.0, 0.7), V3(sx*0.97, 1.05, 0.68), 0.018, g, 6);
      slab("paint", 0.06, 0.11, 0.17, 0.03, g, sx*1.0, 1.08, 0.66, 0, sx*0.12, 0, 0.012);
      // the lights: headlights, indicators, tail lights
      slab("head", 0.34, 0.14, 0.04, 0.05, g, sx*0.58, 0.7, 1.89, 0, 0, 0, 0.012);
      slab("lamp", 0.1, 0.05, 0.03, 0.02, g, sx*0.81, 0.56, 1.86, 0, 0, 0, 0.008);
      slab("tail", 0.32, 0.13, 0.04, 0.04, g, sx*0.6, 0.72, -1.895, 0, 0, 0, 0.012);
      // the hood stripes
      slab("accent", 0.14, 0.012, 0.92, 0.01, g, sx*0.17, 0.965, 1.24, 0.085, 0, 0, 0.003);
    });
    // bumpers, the grille, the number plates
    slab("dark", 1.78, 0.18, 0.2, 0.08, g, 0, 0.36, 1.88, 0, 0, 0, 0.04);
    slab("dark", 1.78, 0.18, 0.2, 0.08, g, 0, 0.36, -1.88, 0, 0, 0, 0.04);
    slab("trim", 0.9, 0.16, 0.04, 0.05, g, 0, 0.56, 1.895, 0, 0, 0, 0.01);
    [-0.24, 0, 0.24].forEach(function(x){ slab("chrome", 0.02, 0.12, 0.02, 0.005, g, x, 0.56, 1.92, 0, 0, 0, 0.004); });
    vpart("plate", new THREE.PlaneGeometry(0.42, 0.13), g, 0, 0.4, 1.985);
    vpart("plate", new THREE.PlaneGeometry(0.42, 0.13), g, 0, 0.4, -1.985, 0, PI, 0);
    // inside: two seats, the dashboard and the steering wheel (it turns: spin)
    [-0.38, 0.38].forEach(function(x){
      slab("seat", 0.5, 0.14, 0.5, 0.06, g, x, 0.42, -0.3);
      slab("seat", 0.48, 0.72, 0.12, 0.08, g, x, 0.86, -0.62, -0.14);
      slab("seat", 0.28, 0.16, 0.1, 0.05, g, x, 1.3, -0.7, -0.1);
    });
    slab("dark", 1.48, 0.14, 0.36, 0.05, g, 0, 1.0, 0.6, 0.18);
    var col = new THREE.Group(); col.position.set(-0.38, 0.99, 0.07); col.rotation.x = -0.6; g.add(col);   // tilted to face the driver
    rod("dark", V3(0, 0, 0.02), V3(0, 0, 0.3), 0.025, col, 8);
    var spin = rigidPart(col, "spin");
    vpart("dark", new THREE.TorusGeometry(0.16, 0.022, 8, 28), spin);
    [0, 2.1, -2.1].forEach(function(a){ slab("chrome", 0.026, 0.15, 0.02, 0.008, spin, Math.sin(a)*0.075, -Math.cos(a)*0.075, 0, 0, 0, a, 0.005); });
    vpart("chrome", new THREE.CylinderGeometry(0.04, 0.04, 0.04, 14), spin, 0, 0, 0, PI/2, 0, 0);
    anchor(spin, "a-grip-l", 0.16*Math.sin(1.05), 0.16*Math.cos(1.05), 0.02); anchor(spin, "a-grip-r", -0.16*Math.sin(1.05), 0.16*Math.cos(1.05), 0.02);   // ten to two
    anchor(g, "a-foot-l", -0.27, 0.3, 0.1); anchor(g, "a-foot-r", -0.49, 0.3, 0.1);                       // on the pedals, out of sight
    anchor(g, "a-seat", -0.38, 0.5, -0.26);
    // the wheels: chunky tyres round dark alloys with five bright spokes; the front ones steer
    [[-CAR_WX, CAR_WZ, "steer-l"], [CAR_WX, CAR_WZ, "steer-r"], [-CAR_WX, -CAR_WZ, null], [CAR_WX, -CAR_WZ, null]].forEach(function(p, i){
      var hold = new THREE.Group(); hold.position.set(p[0], CAR_WR, p[1]); if(p[2]) hold.name = p[2]; g.add(hold);
      var w = rigidPart(hold, "wheel-" + i);
      ring("tyre", CAR_WR - 0.1, 0.1, w, 0, 0, 0, 28);
      disc("trim", CAR_WR - 0.12, 0.16, w, 0, 0, 0, 22);
      [1, -1].forEach(function(sx){
        ring("rim", CAR_WR - 0.13, 0.016, w, sx*0.08, 0, 0, 24);
        for(var k = 0; k < 5; k++){ var a = k/5*PI*2; slab("rim", 0.02, 0.14, 0.04, 0.008, w, sx*0.08, Math.cos(a)*0.09, Math.sin(a)*0.09, a, 0, 0, 0.004); }
        disc("chrome", 0.045, 0.02, w, sx*0.085, 0, 0, 14);
      });
    });
    return g;
  }
  function carModel(body, accent, plate){
    var V = vehicle("car", carPaint(body), accent, plate);
    return {g: V.g, wheels: [0, 1, 2, 3].map(function(i){ return V.get("wheel-" + i); }), steer: [V.get("steer-l"), V.get("steer-r")], spin: V.get("spin"),
            R: CAR_WR, seat: V.seat, grips: V.grips, feet: V.feet, lean: -0.08, hats: false, riderK: 0.8, brake: V.brake};
  }
  // a dark paint is lifted a little, so a navy or black car still reads on a night street
  function carPaint(hex){
    var c = new THREE.Color(hex == null ? 0x2a3c50 : hex), l = 0.2126*c.r + 0.7152*c.g + 0.0722*c.b;
    if(l < 0.18) c.lerp(new THREE.Color(0x9fb3c8), 0.22*(1 - l/0.18));
    return c.getHex();
  }
  function carRoll(C, d, st){
    if(!C) return;
    C.wheels.forEach(function(w){ w.rotation.x += d/CAR_WR; });
    if(st != null){ C.steer.forEach(function(h){ h.rotation.y = st*0.5; }); if(C.spin) C.spin.rotation.z = -st*1.6; }
  }

  // A motorbike: a small street bike, forward is +z, wheels on the ground. Drawn at MOTO_S: a
  // solid machine under a big-headed rider (2.1 m long, the car 3.8 m).
  var MOTO_WR = 0.34, MOTO_WB = 1.42, MOTO_S = 1.2;
  function buildMoto(){
    var g = new THREE.Group(), m = new THREE.Group(), WR = MOTO_WR, WB = MOTO_WB;
    m.scale.setScalar(MOTO_S); g.add(m);
    function wheel(p, name, x, y, z){
      var w = rigidPart(p, name, x, y, z);
      ring("tyre", WR - 0.07, 0.07, w, 0, 0, 0, 32);
      ring("rim", WR - 0.145, 0.018, w, 0, 0, 0, 30);                             // the rim; the spokes in the accent
      for(var k = 0; k < 5; k++){ var a = k/5*PI*2, L = WR - 0.165, rc = 0.02 + L/2; slab("accent", 0.026, L, 0.022, 0.008, w, 0, Math.cos(a)*rc, Math.sin(a)*rc, a, 0, 0, 0.006); }
      disc("chrome", 0.045, 0.13, w, 0, 0, 0, 14);
      disc("rim", 0.13, 0.01, w, -0.055, 0, 0, 24);                               // the brake disc
      return w;
    }
    var rear = wheel(m, "wheel-0", 0, WR, -WB/2);
    disc("dark", 0.1, 0.012, rear, 0.075, 0, 0, 22);                              // the rear sprocket
    var piv = V3(0, 0.47, -0.27);
    // the frame, the swingarm and the shock
    [0.075, -0.075].forEach(function(x){
      rod("trim", V3(x, 0.94, 0.42), V3(x, 0.5, -0.24), 0.03, m, 8);
      rod("dark", V3(x, piv.y, piv.z), V3(x, WR, -WB/2), 0.026, m, 8);
    });
    rod("trim", V3(0, 0.9, 0.46), V3(0, 0.36, 0.2), 0.026, m, 8);
    rod("accent", V3(0, 0.5, -0.46), V3(0, 0.78, -0.38), 0.034, m, 8); rod("chrome", V3(0, 0.46, -0.47), V3(0, 0.82, -0.37), 0.014, m, 6);
    // the engine: crankcase, cylinder with fins, side covers
    slab("chrome", 0.26, 0.26, 0.44, 0.06, m, 0, 0.42, -0.03, 0, 0, 0, 0.03);
    slab("dark", 0.22, 0.2, 0.18, 0.04, m, 0, 0.6, 0.12, -0.4, 0, 0, 0.02);
    [0.54, 0.59, 0.64, 0.69].forEach(function(y){ slab("chrome", 0.27, 0.012, 0.21, 0.005, m, 0, y, 0.12 + (y - 0.6)*0.42, -0.4, 0, 0, 0.003); });
    [0.14, -0.14].forEach(function(x){ disc("chrome", 0.1, 0.03, m, x, 0.42, -0.06, 20); });
    // the exhaust (on the right) and the chain (on the left)
    rod("chrome", V3(-0.05, 0.56, 0.2), V3(-0.12, 0.26, 0.1), 0.024, m, 8); rod("chrome", V3(-0.12, 0.26, 0.1), V3(-0.16, 0.3, -0.36), 0.024, m, 8);
    rod("chrome", V3(-0.17, 0.33, -0.36), V3(-0.2, 0.5, -0.78), 0.06, m, 14); vpart("dark", new THREE.CylinderGeometry(0.04, 0.04, 0.02, 12), m, -0.2, 0.5, -0.785, 1.17, 0, 0);
    rod("dark", V3(0.075, 0.51, piv.z), V3(0.075, WR + 0.1, -WB/2), 0.008, m, 4); rod("dark", V3(0.075, 0.43, piv.z), V3(0.075, WR - 0.1, -WB/2), 0.008, m, 4);
    disc("dark", 0.045, 0.02, m, 0.075, 0.47, piv.z, 14);
    // the tank (paint, an accent stripe), the side panels, the seat, the tail with its light and plate
    var tk = new THREE.Shape(); tk.moveTo(-0.14, 0.78); tk.lineTo(0.36, 0.83); tk.quadraticCurveTo(0.52, 0.86, 0.47, 0.98);
    tk.quadraticCurveTo(0.36, 1.06, 0.08, 1.04); tk.quadraticCurveTo(-0.14, 1.0, -0.14, 0.78);
    vpart("paint", sideGeo(tk, 0.4, 0.06), m);
    slab("accent", 0.08, 0.014, 0.42, 0.01, m, 0, 1.075, 0.2, -0.06, 0, 0, 0.004);
    [0.15, -0.15].forEach(function(x){
      slab("paint", 0.03, 0.26, 0.38, 0.08, m, x, 0.62, 0.25, 0, 0, -x*0.6, 0.012);
      slab("accent", 0.008, 0.04, 0.3, 0.01, m, x*1.12, 0.66, 0.25, 0, 0, -x*0.6, 0.002);
    });
    var st = new THREE.Shape(); st.moveTo(-0.13, 0.77); st.lineTo(-0.64, 0.8); st.quadraticCurveTo(-0.7, 0.86, -0.62, 0.875);
    st.lineTo(-0.22, 0.86); st.quadraticCurveTo(-0.12, 0.85, -0.13, 0.77);
    vpart("seat", sideGeo(st, 0.3, 0.035), m);
    vpart("paint", sideGeo(poly([[-0.42, 0.7], [-1.0, 0.84], [-1.05, 0.9], [-0.66, 0.88], [-0.42, 0.78]]), 0.24, 0.035), m);
    slab("tail", 0.15, 0.05, 0.03, 0.02, m, 0, 0.87, -1.07, 0, 0, 0, 0.008);
    slab("dark", 0.12, 0.2, 0.02, 0.01, m, 0, 0.72, -1.0, 0.35, 0, 0, 0.005);
    vpart("plate", new THREE.PlaneGeometry(0.16, 0.09), m, 0, 0.7, -1.02, 0.35, PI, 0);
    [0.11, -0.11].forEach(function(x){ slab("lamp", 0.04, 0.03, 0.05, 0.012, m, x, 0.85, -1.0, 0, 0, 0, 0.006); });
    vpart("dark", arcGeo(WR + 0.04, 0.035, 0.35*PI, 0.95*PI), m, 0, WR, -WB/2);   // the rear hugger
    // the footpegs
    [0.2, -0.2].forEach(function(x){ rod("trim", V3(x*0.6, 0.56, -0.12), V3(x, 0.56, -0.12), 0.016, m, 6); });
    anchor(m, "a-foot-l", 0.2, 0.58, -0.1); anchor(m, "a-foot-r", -0.2, 0.58, -0.1);
    // the steering: forks, front wheel, mudguard, bars and the headlight cowl turn about the head
    var steer = rigidPart(m, "steer", 0, 0.98, 0.5), FW = V3(0, WR - 0.98, WB/2 - 0.5);
    wheel(steer, "wheel-1", FW.x, FW.y, FW.z);
    [0.09, -0.09].forEach(function(x){
      rod("chrome", V3(x, 0.04, 0.0), V3(x, -0.3, 0.1), 0.026, steer, 10);
      rod("trim", V3(x, -0.3, 0.1), V3(x, FW.y, FW.z), 0.032, steer, 10);
    });
    slab("trim", 0.26, 0.05, 0.1, 0.02, steer, 0, 0.06, -0.02, 0, 0, 0, 0.01);       // the top clamp
    vpart("paint", arcGeo(WR + 0.03, 0.04, 0.42*PI, 0.92*PI), steer, FW.x, FW.y, FW.z);   // the front mudguard
    [1, -1].forEach(function(s){
      rod("chrome", V3(s*0.06, 0.11, -0.05), V3(s*0.3, 0.17, -0.29), 0.018, steer, 8);
      vpart("dark", new THREE.CylinderGeometry(0.027, 0.027, 0.12, 10), steer, s*0.34, 0.17, -0.3, 0, 0, PI/2);
      rod("trim", V3(s*0.26, 0.19, -0.24), V3(s*0.34, 0.2, -0.17), 0.006, steer, 4);     // a lever
      rod("trim", V3(s*0.2, 0.15, -0.2), V3(s*0.25, 0.3, -0.2), 0.008, steer, 4);        // a mirror
      slab("trim", 0.1, 0.055, 0.02, 0.02, steer, s*0.26, 0.32, -0.2, 0, 0, 0, 0.006);
    });
    anchor(steer, "a-grip-l", 0.33, 0.17, -0.3); anchor(steer, "a-grip-r", -0.33, 0.17, -0.3);
    slab("paint", 0.26, 0.22, 0.16, 0.07, steer, 0, -0.02, 0.12, 0, 0, 0, 0.03);   // the cowl
    vpart("head", new THREE.CylinderGeometry(0.075, 0.075, 0.03, 18), steer, 0, -0.03, 0.205, PI/2, 0, 0);
    slab("glass", 0.22, 0.16, 0.012, 0.04, steer, 0, 0.13, 0.13, -0.55, 0, 0, 0.004);   // a little screen
    [0.13, -0.13].forEach(function(x){ slab("lamp", 0.04, 0.03, 0.05, 0.012, steer, x, -0.04, 0.16, 0, 0, 0, 0.006); });
    anchor(g, "a-seat", 0, 0.88*MOTO_S, -0.27*MOTO_S);
    return g;
  }
  function motoModel(color, c2, plate){
    var V = vehicle("moto", color, c2, plate);
    return {g: V.g, wheels: [V.get("wheel-0"), V.get("wheel-1")], steer: V.get("steer"), R: MOTO_WR*MOTO_S,
            seat: V.seat, grips: V.grips, feet: V.feet, lean: 0.45, brake: V.brake};
  }
  function motoRoll(M, d, st){
    if(!M) return;
    M.wheels[0].rotation.x += d/(MOTO_WR*MOTO_S); M.wheels[1].rotation.x += d/(MOTO_WR*MOTO_S);
    if(st != null) M.steer.rotation.y = st*0.4;
  }
  var BUILD = {bike: buildBike, car: buildCar, moto: buildMoto};
  // A skateboard: deck, trucks and four wheels; forward is +z (the nose). {g, deck, wheels}.
  function boardModel(color){
    var g = new THREE.Group(), deck = new THREE.Group(); g.add(deck);
    var top = mat(0x1d2126, {roughness: 0.95}), ply = mat(color, {roughness: 0.6}), steel = mat(0xc4ccd4, {metalness: 0.85, roughness: 0.3});
    var wheelM = mat(0xf2efe6, {roughness: 0.5});
    box(0.24, 0.02, 0.74, ply, 0, 0.11, 0, deck);                                     // the deck, in its colour underneath
    box(0.22, 0.008, 0.7, top, 0, 0.124, 0, deck, true);                             // grip tape
    [-0.4, 0.4].forEach(function(z){ var k = box(0.2, 0.02, 0.08, ply, 0, 0.13, z, deck); k.rotation.x = z > 0 ? -0.35 : 0.35; });   // nose and tail kick up
    var wheels = [];
    [-0.26, 0.26].forEach(function(z){
      box(0.18, 0.04, 0.04, steel, 0, 0.075, z, deck);                                // a truck
      [-0.1, 0.1].forEach(function(x){ var w = cyl(0.03, 0.03, 0.035, wheelM, x, 0.035, z, deck, 12); w.rotation.z = PI/2; wheels.push(w); });
    });
    return {g: g, deck: deck, wheels: wheels};
  }
  function bikeColor(key){ return [0xff6b5b, 0x5fd3e6, 0xffb347, 0x6fd38a, 0x9b8cf0, 0xf4f4f4, 0xe0559b, 0x3d6fd1][hashStr(key) % 8]; }

  // What a floor of the building (games/hqlobby.js, games/hqbase.js) builds with.
  var ctx = {
    get THREE(){ return THREE; }, get L(){ return L; }, get el(){ return el; }, E: E, PI: PI, COL: COL, HEX: HEX, STATE_HEX: STATE_HEX,
    mat: function(c, o){ return mat(c, o); }, emis: function(c, e, ei, o){ return emis(c, e, ei, o); },
    add: function(o, x, y, z, p, ns){ return add(o, x, y, z, p, ns); }, box: function(w, h, d, m, x, y, z, p, ns){ return box(w, h, d, m, x, y, z, p, ns); },
    cyl: function(rt, rb, h, m, x, y, z, p, seg){ return cyl(rt, rb, h, m, x, y, z, p, seg); }, sph: function(r, m, x, y, z, p){ return sph(r, m, x, y, z, p); },
    canvasTex: function(w, h, d){ return canvasTex(w, h, d); }, screen: function(w, h, t, tr){ return screen(w, h, t, tr); },
    glow: function(c, sz, op){ return glowSprite(c, sz, op); }, label: function(t, c, sc){ return label(t, c, sc); }, glyph: function(ch, c){ return glyph(ch, c); },
    plant: function(x, z, sc, seed){ return plant(x, z, sc, seed); }, sky: function(day){ return day ? sky.day : sky.night; },
    bike: function(col, c2){ return bikeModel(col, c2); }, bikeRoll: function(B, d, st){ bikeRoll(B, d, st); }, bikeColor: bikeColor,
    car: function(body, accent, plate){ return carModel(body, accent, plate); }, moto: function(col, c2, plate){ return motoModel(col, c2, plate); },
    board: function(col){ return boardModel(col); },
    rng: rng, hashStr: hashStr, short: short, rr: rr, crewState: crewState,
    character: function(key, cb){ makeCharacter(key, cb); }, anim: function(ch, n, sp){ setAnim(ch, n, sp); },
    avatar: function(){ return avatar ? {x: avatar.x, z: avatar.z} : null; },
    view: function(){ return {yaw: view.yaw, pitch: view.pitch}; },
    sessions: function(){ return sessions; }, level: function(){ return api.level ? api.level() : 1; },
    look: function(){ return (api.look && api.look()) || {}; }, api: api,
    // Cities: put you somewhere in this world (off a bus, back at a dock), or build the City again on
    // another world (an island, the Commons) and arrive at spawn
    teleport: function(x, z, yaw){ if(avatar){ if(ride) dismount(true); placeAvatar(x, z, yaw); } },
    goCity: function(world, spawn){ return inst.goCity ? inst.goCity(world, spawn) : false; },
    // navigation (HQ 3.1, games/hqcity3d.js): where you face and how fast, and what you ride (kind, a boat or not);
    // the other players in this world; is world w the one you are in; the full map (M)
    motion: function(){ return avatar ? {yaw: avatar.yaw || 0, speed: Math.abs(ride ? (ride.speed || 0) : (avatar.speed || 0)),
                                         ride: ride ? ride.kind || null : null, boat: !!(ride && ride.boat)} : null; },
    others: function(){ var out = []; Object.keys(peers).forEach(function(u){ var P = peers[u]; if(cur && P.g.parent === cur.scene) out.push({x: P.x, z: P.z, col: bikeColor(u)}); }); return out; },
    active: function(w){ return !!(inst.running && cur && cur === w); },
    toggleMap: function(){ if(rigOn()) mapToggle(); },
    // voyages (games/hqcity3d.js, games/hqvoyage.js): the next city built while you sail, then moved into with no fade
    prebuildCity: function(world){ return inst.prebuildCity ? inst.prebuildCity(world) : false; },
    cityBuilt: function(world){ return !!(nextCity && nextCity.world === world && nextCity.ready); },
    swapCity: function(world, keep){ return inst.swapCity ? inst.swapCity(world, keep) : false; },
    night: function(){ return isNight(); },
    held: function(code){ return !!keys[code]; }
  };

  /* ---------- day / night from the local clock ---------- */
  function isNight(){ if(SMOKE && SMOKE.on) return SMOKE.night; var h = new Date().getHours(); return h < 7 || h >= 19; }
  function skyTex(day){
    return canvasTex(512, 256, function(g, w, h){
      var gr = g.createLinearGradient(0, 0, 0, h);
      if(day){ gr.addColorStop(0, "#7fb8e6"); gr.addColorStop(1, "#cfe6f5"); } else { gr.addColorStop(0, "#050c14"); gr.addColorStop(1, "#14273a"); }
      g.fillStyle = gr; g.fillRect(0, 0, w, h);
      var R = rng(11), x = 0;
      if(!day){ var R0 = rng(3); for(var s = 0; s < 60; s++){ g.fillStyle = "rgba(255,255,255," + (0.3 + R0()*0.6) + ")"; g.fillRect(R0()*w, R0()*h*0.5, 1.5, 1.5); } }
      while(x < w){
        var bw = 26 + R()*40, bh = 60 + R()*150;
        g.fillStyle = day ? "#8ea6b8" : "#0b1724"; g.fillRect(x, h - bh, bw, bh);
        for(var yy = h - bh + 8; yy < h - 6; yy += 10) for(var xx = x + 5; xx < x + bw - 6; xx += 8){
          if(R() < (day ? 0.15 : 0.42)){ g.fillStyle = day ? "#a9c4d6" : (R() < 0.8 ? "#ffcf7a" : "#9fe3f0"); g.fillRect(xx, yy, 4, 5); }
        }
        x += bw + 3;
      }
    }).t;
  }
  function applyTime(){
    var n = isNight(); if(n === night) return; night = n;
    scene.background = new THREE.Color(n ? 0x0a1520 : 0x7fb2d6);
    Object.keys(worlds).forEach(function(k){ if(worlds[k].setTime) worlds[k].setTime(n); });
    sky.hemi.intensity = n ? 2.2 : 2.6; sky.sun.intensity = n ? 1.0 : 2.2; sky.sun.color.set(n ? 0xa9b8ff : 0xfff2dc);
    lamps.forEach(function(l){ l.intensity = l.userData.base*(n ? 1 : 0.5); });
    winPanes.forEach(function(p){ p.material.map = n ? sky.night : sky.day; p.material.needsUpdate = true; });
  }

  /* ---------- the room ---------- */
  function buildRoom(){
    sky.night = skyTex(false); sky.day = skyTex(true);
    sky.hemi = new THREE.HemisphereLight(0xbcd7ff, 0x1a2430, 1.2); scene.add(sky.hemi);
    var sun = sky.sun = new THREE.DirectionalLight(0xffffff, 1.2); sun.position.set(18, 30, 14); sun.castShadow = true;
    sun.shadow.mapSize.set(2048, 2048); var sc = sun.shadow.camera; sc.left = -22; sc.right = 22; sc.top = 22; sc.bottom = -22; sc.far = 90; sun.shadow.bias = -0.0005;
    scene.add(sun); scene.add(sun.target);
    [[-4, 7, 2, 160], [6, 7, 7, 160], [-8, 7, -8, 120], [8, 7, -9, 120]].forEach(function(p){
      var l = new THREE.PointLight(0xfff1d6, p[3], 0, 2); l.position.set(p[0], p[1], p[2]); l.userData.base = p[3]; scene.add(l); lamps.push(l);
    });
    // floor: tiles, a carpet zone under the consoles, a dashed guide line
    var fl = canvasTex(1024, 1024, function(g, w){
      var u = w/30; g.fillStyle = "#1c2d3b"; g.fillRect(0, 0, w, w);
      for(var i = 0; i < 15; i++) for(var j = 0; j < 15; j++){ g.fillStyle = ((i + j) & 1) ? "#1f3141" : "#223646"; g.fillRect(i*2*u + 1, j*2*u + 1, 2*u - 2, 2*u - 2); }
      g.fillStyle = "#18303a"; g.beginPath(); g.arc(15*u, 10.5*u, 13*u, 0, PI); g.fill();
      g.strokeStyle = "rgba(255,179,71,.35)"; g.lineWidth = 3; g.setLineDash([14, 10]); g.beginPath(); g.arc(15*u, 10.5*u, 13*u, 0, PI); g.stroke(); g.setLineDash([]);
    });
    var floor = new THREE.Mesh(new THREE.PlaneGeometry(2*ROOM, 2*ROOM), new THREE.MeshStandardMaterial({map: fl.t, roughness: 0.55, metalness: 0.15}));
    floor.rotation.x = -PI/2; floor.receiveShadow = true; floor.userData.floor = true; scene.add(floor); inst.floor = floor;
    // two walls (the room is cut away on the camera's side), trim, a light strip at the base
    var wallM = mat(0x2a3d4f, {roughness: 0.85}), trim = mat(0x34495d);
    box(2*ROOM, 8, 0.5, wallM, 0, 4, -ROOM - 0.25); box(0.5, 8, 2*ROOM, wallM, -ROOM - 0.25, 4, 0);
    box(2*ROOM, 0.35, 0.8, trim, 0, 8.05, -ROOM - 0.1); box(0.8, 0.35, 2*ROOM, trim, -ROOM - 0.1, 8.05, 0);
    var base = emis(0x0d1a24, COL.cyan, 1.2);
    box(2*ROOM, 0.06, 0.06, base, 0, 0.12, -ROOM + 0.03, null, true); box(0.06, 0.06, 2*ROOM, base, -ROOM + 0.03, 0.12, 0, null, true);
    box(28, 0.1, 0.12, emis(0xffffff, 0xfff1d6, 2), 0, 7.6, -ROOM + 0.1, null, true);
    box(0.12, 0.1, 28, emis(0xffffff, 0xfff1d6, 2), -ROOM + 0.1, 7.6, 0, null, true);
    // a window with the skyline, and the wall screen
    box(4.4, 3.6, 0.2, mat(0x3a5066, {metalness: 0.5, roughness: 0.4}), -10.4, 4.4, -ROOM + 0.05);
    var pane = screen(4, 3.2, sky.night); pane.position.set(-10.4, 4.4, -ROOM + 0.18); scene.add(pane); winPanes.push(pane);
    wall = canvasTex(1024, 384);
    var ws = screen(12, 4.5, wall.t); ws.position.set(-1, 4.45, -ROOM + 0.12); scene.add(ws);
    box(12.5, 5, 0.3, mat(0x101a24, {metalness: 0.6, roughness: 0.3}), -1, 4.45, -ROOM);
    var sg = glowSprite(COL.cyan, 16, 0.16); sg.position.set(-1, 4.4, -ROOM + 0.6); scene.add(sg);
    // doors
    DOORS.forEach(function(d){
      var g = new THREE.Group();
      if(d.wall === "left"){ g.position.set(-ROOM + 0.05, 0, d.at); g.rotation.y = PI/2; } else { g.position.set(d.at, 0, -ROOM + 0.05); }
      scene.add(g);
      box(2.9, 4.1, 0.25, mat(0x3a5066, {metalness: 0.5, roughness: 0.35}), 0, 2.05, 0, g);
      [-0.62, 0.62].forEach(function(x){ box(1.2, 3.75, 0.12, mat(0x15222e), x, 1.9, 0.12, g); box(0.5, 2.4, 0.02, emis(0x0b1622, d.col, 0.35), x, 2.1, 0.19, g); });
      box(2.6, 0.05, 0.05, emis(0x0d1a24, d.col, 2), 0, 3.85, 0.2, g, true);
      var mark = box(2.4, 0.02, 1.4, emis(0x0d1a24, d.col, 0.5), 0, 0.015, 0.9, g, true);
      var lb = label(d.label, "#" + d.col.toString(16).padStart(6, "0"), 0.6); lb.position.set(0, 4.9, 0.4); g.add(lb);
      g.updateMatrixWorld(true);
      var front = new THREE.Vector3(0, 0, 1.6); g.localToWorld(front);
      d.front = front;
      g.traverse(function(o){ if(o.isMesh){ o.userData.door = d; doorHits.push(o); } });
    });
    plant(-13.6, -13.4, 1.2, 1); plant(8.6, -13.8, 1, 2); plant(13.2, 13.2, 1.3, 3); plant(-13.2, 13.2, 1.1, 4);
    // build racks along the back wall
    var leds = tex.leds = canvasTex(128, 256);
    [-14 + 1.4, -14 + 3.2].forEach(function(x){
      box(1.6, 4.4, 1.1, mat(0x141c24, {metalness: 0.5, roughness: 0.4}), x + 18, 2.2, -ROOM + 0.6);
      var f = screen(1.4, 4.1, leds.t); f.position.set(x + 18, 2.2, -ROOM + 1.17); scene.add(f);
    });
  }

  /* ---------- the holo-table ---------- */
  function buildHolo(){
    var g = holo.g = new THREE.Group(); g.position.set(TABLE.x, 0, TABLE.z); scene.add(g);
    [[3.4, 3.5, 0.45], [4.5, 4.55, 0.2]].forEach(function(r){
      var m = new THREE.Mesh(new THREE.RingGeometry(r[0], r[1], 72), new THREE.MeshBasicMaterial({color: COL.cyan, transparent: true, opacity: r[2], side: THREE.DoubleSide, toneMapped: false}));
      m.rotation.x = -PI/2; m.position.y = 0.015; g.add(m);
    });
    var metal = mat(0x2c4154, {metalness: 0.7, roughness: 0.35}), metal2 = mat(0x1d2c39, {metalness: 0.7, roughness: 0.4});
    cyl(2.2, 2.5, 0.3, metal2, 0, 0.15, 0, g, 48); cyl(1.45, 1.85, 0.5, metal, 0, 0.55, 0, g, 48); cyl(2.6, 2.35, 0.2, metal, 0, 0.9, 0, g, 64);
    for(var v = 0; v < 16; v++){ var va = v/16*PI*2, vent = box(0.32, 0.26, 0.05, emis(0x0d1a24, COL.cyan, 1.4), Math.sin(va)*1.66, 0.55, Math.cos(va)*1.66, g, true); vent.rotation.y = va; vent.rotation.x = -0.38; }
    var rim = holo.rim = new THREE.Mesh(new THREE.TorusGeometry(2.6, 0.045, 8, 96), emis(COL.cyan, COL.cyan, 3)); rim.rotation.x = PI/2; rim.position.y = 1.0; g.add(rim);
    var top = new THREE.Mesh(new THREE.CylinderGeometry(2.42, 2.42, 0.05, 64), new THREE.MeshStandardMaterial({color: 0x0d2a36, emissive: new THREE.Color(COL.cyan), emissiveIntensity: 0.3, transparent: true, opacity: 0.75, metalness: 0.2, roughness: 0.1}));
    top.position.y = 1.02; g.add(top);
    var stripe = holo.stripe = canvasTex(64, 256, function(c){ for(var y = 0; y < 256; y += 8){ c.fillStyle = "rgba(95,211,230," + (y % 32 ? 0.15 : 0.55) + ")"; c.fillRect(0, y, 64, 2); } });
    stripe.t.wrapS = stripe.t.wrapT = THREE.RepeatWrapping; stripe.t.repeat.set(10, 1);
    var beam = new THREE.Mesh(new THREE.CylinderGeometry(2.0, 2.35, 3.6, 64, 1, true), new THREE.MeshBasicMaterial({map: stripe.t, transparent: true, opacity: 0.3, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide, toneMapped: false}));
    beam.position.y = 2.85; g.add(beam);
    var scan = holo.scan = new THREE.Mesh(new THREE.TorusGeometry(2.2, 0.02, 6, 80), new THREE.MeshBasicMaterial({color: COL.cyan, transparent: true, opacity: 0.8, blending: THREE.AdditiveBlending, toneMapped: false}));
    scan.rotation.x = PI/2; g.add(scan);
    var NP = 180, pos = new Float32Array(NP*3), R = rng(21);
    for(var q = 0; q < NP; q++){ var qa = R()*PI*2, qr = Math.sqrt(R())*2; pos[q*3] = Math.cos(qa)*qr; pos[q*3 + 1] = 1.05 + R()*3.6; pos[q*3 + 2] = Math.sin(qa)*qr; }
    var pg = holo.pgeo = new THREE.BufferGeometry(); pg.setAttribute("position", new THREE.BufferAttribute(pos, 3));
    g.add(new THREE.Points(pg, new THREE.PointsMaterial({color: COL.cyan, size: 0.06, transparent: true, opacity: 0.8, blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false})));
    var hl = new THREE.PointLight(COL.cyan, 30, 0, 2); hl.position.set(TABLE.x, 3, TABLE.z); hl.userData.base = 30; scene.add(hl); holo.light = hl;
    holo.proj = new THREE.Group(); holo.proj.position.y = 1.1; g.add(holo.proj);
  }
  // The projects on the table: one holographic tower cluster per project, height = today's activity.
  function buildProjects(){
    var P = holo.proj; while(P.children.length) P.remove(P.children[0]);
    projHits = [];
    var by = {};
    sessions.forEach(function(s){
      var p = projectOf(s), st = crewState(s);
      var b = by[p] || (by[p] = {name: p, act: 0, live: 0, need: 0});
      b.act += activityOf(s); if(st !== "stale") b.live++; if(st === "needs") b.need++;
    });
    var list = Object.keys(by).map(function(k){ return by[k]; }).filter(function(b){ return b.live || b.act; })
      .sort(function(a, b){ return (b.live - a.live) || (b.act - a.act); }).slice(0, 6);
    holo.projects = list;
    var maxAct = Math.max.apply(null, list.map(function(b){ return b.act; }).concat([1]));
    var cols = [COL.cyan, COL.green, COL.amber, COL.violet, COL.coral, 0x8ec9ff];
    list.forEach(function(b, n){
      var a = n/Math.max(1, list.length)*PI*2 + PI/4, cx = Math.cos(a)*1.15, cz = Math.sin(a)*1.15, col = cols[n % cols.length];
      var dim = filter && filter !== b.name;
      var R = rng(hashStr(b.name)), towers = 2 + Math.min(4, b.live + 1);
      for(var i = 0; i < towers; i++){
        var h = 0.25 + (b.act/maxAct)*1.2*(0.55 + R()*0.45);
        var geo = new THREE.BoxGeometry(0.2, h, 0.2); geo.translate(0, h/2, 0);
        var fill = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({color: col, transparent: true, opacity: dim ? 0.06 : 0.28, blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false}));
        fill.position.set(cx + ((i % 3) - 1)*0.26, 0, cz + (Math.floor(i/3) - 0.5)*0.28);
        var edges = new THREE.LineSegments(new THREE.EdgesGeometry(geo), new THREE.LineBasicMaterial({color: col, transparent: true, opacity: dim ? 0.2 : 0.95, toneMapped: false}));
        edges.position.copy(fill.position); P.add(fill); P.add(edges);
        fill.userData.project = b.name; projHits.push(fill);
      }
      var lb = label(short(b.name, 16) + (b.need ? "  !" : ""), "#" + col.toString(16).padStart(6, "0"), 0.42);
      lb.position.set(cx, 1.85, cz); lb.material.opacity = dim ? 0.35 : 1; P.add(lb);
    });
  }

  /* ---------- crew at desks ---------- */
  function seatPositions(n){
    // Two arcs facing the table: 7 desks on the inner one, the rest on the outer.
    var out = [], inner = Math.min(n, 7), outer = n - inner;
    function arc(k, r, z0){ for(var i = 0; i < k; i++){ var a = (k === 1 ? 0 : (i/(k - 1) - 0.5))*PI*0.78; out.push([TABLE.x + Math.sin(a)*r, TABLE.z + Math.cos(a)*r]); } }
    arc(inner, 7.4); arc(outer, 11.2);
    return out;
  }
  function deskList(){
    var live = sessions.filter(function(s){ return crewState(s) !== "stale"; });
    var stale = sessions.filter(function(s){ return crewState(s) === "stale"; })
      .sort(function(a, b){ return (a.ageSecs || 1e12) - (b.ageSecs || 1e12); }).slice(0, MAX_STALE);
    return live.concat(stale).slice(0, MAX_DESKS);
  }
  // A person: their own 3D character when they built one (games/avatar3d.js; you, and anyone whose
  // presence carries `c`), else one of the six looks picked from a hash of the key.
  function makeCharacter(key, onReady, spec){
    var A3 = HQV.avatar3d;
    if(spec && A3 && A3.valid(spec)){
      A3.build(spec).then(function(ch){
        if(!inst.alive) return;
        ch.base = 1.7/CH_H; ch.o.scale.setScalar(ch.base);
        onReady(ch);
      }).catch(function(){ makeCharacter(key, onReady); });
      return;
    }
    var name = CHAR_FILES[hashStr(key) % CHAR_FILES.length];
    E.loadGlb(L, "golf", name).then(function(g){
      if(!inst.alive) return;
      var o = L.clone(g.scene); o.scale.setScalar(1.7/CH_H);
      o.traverse(function(n){ if(n.isMesh){ n.castShadow = true; n.frustumCulled = false; } });
      var mixer = new THREE.AnimationMixer(o), acts = {};
      ["idle", "walk", "sit", "emote-yes", "sprint"].forEach(function(n){ var cl = THREE.AnimationClip.findByName(g.animations, n); if(cl) acts[n] = mixer.clipAction(cl); });
      onReady({o: o, mixer: mixer, acts: acts, cur: null, base: 1.7/CH_H});
    }).catch(function(){});
  }
  function setAnim(ch, n, speed){
    if(!ch || !ch.acts[n]) return;
    if(ch.cur !== n){
      var next = ch.acts[n]; next.reset().fadeIn(0.25).play();
      if(ch.cur && ch.acts[ch.cur]) ch.acts[ch.cur].fadeOut(0.25);
      ch.cur = n;
    }
    ch.acts[n].timeScale = speed == null ? 1 : speed;
  }
  function buildDesk(s, at){
    var root = new THREE.Group(); root.position.set(at[0], 0, at[1]); root.lookAt(TABLE.x, 0, TABLE.z); scene.add(root);
    var top = mat(0x2b3947, {roughness: 0.45, metalness: 0.3}), body = mat(0x1c2834, {roughness: 0.7});
    box(2.4, 0.07, 0.95, top, 0, 0.98, 0.9, root); box(2.3, 0.55, 0.04, body, 0, 0.68, 1.34, root);
    [-1.15, 1.15].forEach(function(x){ box(0.06, 0.95, 0.9, body, x, 0.48, 0.9, root); });
    box(0.5, 0.6, 0.8, body, -0.82, 0.3, 0.92, root);
    var strip = box(2.4, 0.025, 0.03, emis(0x0d1a24, COL.cyan, 2), 0, 0.955, 0.43, root, true);
    var frame = mat(0x0f151c, {metalness: 0.5, roughness: 0.35});
    box(1.16, 0.7, 0.05, frame, 0, 1.55, 1.2, root);
    var scr = canvasTex(256, 150), sp = screen(1.08, 0.62, scr.t); sp.position.set(0, 1.55, 1.172); sp.rotation.y = PI; root.add(sp);
    cyl(0.03, 0.03, 0.3, frame, 0, 1.15, 1.24, root, 8);
    var side = new THREE.Group(); side.position.set(-0.95, 0, 1.05); side.rotation.y = -0.55; root.add(side);
    box(0.74, 0.5, 0.05, frame, 0, 1.42, 0, side);
    var scr2 = canvasTex(160, 110), sp2 = screen(0.68, 0.44, scr2.t); sp2.position.set(0, 1.42, -0.028); sp2.rotation.y = PI; side.add(sp2);
    box(0.66, 0.03, 0.22, mat(0x1a2129), 0, 1.03, 0.62, root);
    var mugC = [0xf4f4f4, 0xffb347, 0x5fd3e6, 0x6fd38a, 0xff6b5b, 0x9b8cf0][hashStr(s.sessionId) % 6];
    cyl(0.07, 0.065, 0.14, mat(mugC), 0.82, 1.08, 0.55, root, 12);
    box(0.28, 0.55, 0.55, mat(0x161e26), 0.78, 0.3, 1.0, root);
    // chair
    var chair = new THREE.Group(); chair.position.set(0, 0, -0.05); root.add(chair);
    var dark = mat(0x1d2730, {metalness: 0.5, roughness: 0.4}), fab = mat([0x2f4459, 0x46303a, 0x2f4a3a, 0x3e3a52][hashStr(s.sessionId) % 4], {roughness: 0.9});
    for(var i = 0; i < 5; i++){ var a = i/5*PI*2; box(0.36, 0.04, 0.06, dark, Math.cos(a)*0.18, 0.08, Math.sin(a)*0.18, chair).rotation.y = -a; }
    cyl(0.04, 0.04, 0.32, dark, 0, 0.26, 0, chair, 8);
    box(0.62, 0.1, 0.58, fab, 0, 0.45, 0, chair);
    var back = box(0.58, 0.72, 0.08, fab, 0, 0.9, -0.3, chair); back.rotation.x = -0.12;
    // creature on the desk: its type hue, a little bob
    var hue = (s.creature && (s.creature.typeHue != null ? s.creature.typeHue : s.creature.hue)) || 200;
    var pet = new THREE.Group(); pet.position.set(1.0, 1.0, 0.95); pet.scale.setScalar(0.5); root.add(pet);
    var pc = new THREE.Color().setHSL(hue/360, 0.6, 0.55), pm = mat(pc, {roughness: 0.5});
    var pb = sph(0.42, pm, 0, 0.4, 0, pet); pb.scale.y = 0.9;
    [-0.15, 0.15].forEach(function(x){ sph(0.07, mat(0x101010), x, 0.52, -0.35, pet); });
    [-0.2, 0.2].forEach(function(x){ var e = new THREE.Mesh(new THREE.ConeGeometry(0.12, 0.34, 6), pm); add(e, x, 0.86, 0, pet).rotation.z = -x; });
    var st = crewState(s);
    var tag = label(short(titleOf(s), 20), STATE_HEX[st], 0.5); tag.position.set(0, 2.75, 0.3); root.add(tag);
    var D = {s: s, id: s.sessionId, root: root, strip: strip, scr: scr, scr2: scr2, chair: chair, pet: pet, tag: tag, tagState: st,
             badge: null, ch: null, state: null, R: rng(hashStr(s.sessionId)), lines: null};
    D.lines = []; for(var li = 0; li < 40; li++){ var segs = [], ns = 1 + Math.floor(D.R()*4); for(var sg = 0; sg < ns; sg++) segs.push([10 + D.R()*40, ["#5fd3e6", "#ffb347", "#6fd38a", "#9b8cf0", "#e9eff3", "#ff9a8a"][Math.floor(D.R()*6)]]); D.lines.push({ind: Math.floor(D.R()*4), segs: segs}); }
    root.traverse(function(o){ if(o.isMesh){ o.userData.desk = D; clickables.push(o); } });
    makeCharacter(s.sessionId, function(ch){
      if(!deskById[D.id] || deskById[D.id] !== D){ return; }
      D.ch = ch; root.add(ch.o); ch.o.traverse(function(o){ if(o.isMesh){ o.userData.desk = D; clickables.push(o); } });
      D.state = null; applyState(D);
    });
    applyState(D);
    return D;
  }
  function applyState(D){
    var st = crewState(D.s);
    if(D.tagState !== st){
      D.root.remove(D.tag); D.tag = label(short(titleOf(D.s), 20), STATE_HEX[st], 0.5); D.tag.position.set(0, 2.75, 0.3); D.root.add(D.tag); D.tagState = st;
    }
    if(D.state === st && (D.ch || st === "stale")) return;
    D.state = st;
    D.strip.material.emissive.set(STATE_COL[st]); D.strip.material.emissiveIntensity = st === "stale" ? 0.2 : 2;
    if(D.badge){ D.root.remove(D.badge); D.badge = null; }
    if(st === "needs" || st === "idle"){ D.badge = glyph(st === "needs" ? "!" : "z", STATE_HEX[st]); D.badge.position.set(0.55, 2.3, 0); D.root.add(D.badge); }
    var ch = D.ch; if(!ch) return;
    ch.o.visible = st !== "stale";
    // Kenney's "sit" pose sits on a seat about chair height; stand beside the desk to wave.
    if(st === "working"){ ch.o.position.set(0, 0.06, -0.05); ch.o.rotation.set(0, 0, 0); setAnim(ch, "sit", 1); }
    else if(st === "idle"){ ch.o.position.set(0, 0.04, -0.18); ch.o.rotation.set(-0.18, 0, 0); setAnim(ch, "sit", 0.3); }
    else if(st === "needs"){ ch.o.position.set(1.0, 0, -0.35); ch.o.rotation.set(0, -2.4, 0); setAnim(ch, "emote-yes", 1); }
    D.chair.rotation.y = st === "needs" ? 0.5 : 0;
  }
  function layoutDesks(){
    var want = deskList(), ids = want.map(function(s){ return s.sessionId; }).join("|");
    if(ids === inst.deskIds){ want.forEach(function(s){ var D = deskById[s.sessionId]; if(D){ D.s = s; applyState(D); } }); return; }
    inst.deskIds = ids;
    desks.forEach(function(D){ scene.remove(D.root); });
    desks = []; deskById = {}; clickables = [];
    var seats = seatPositions(want.length);
    want.forEach(function(s, i){ var D = buildDesk(s, seats[i]); desks.push(D); deskById[D.id] = D; });
    buildStreams();
    applyFilter();
  }
  function buildStreams(){
    streams.forEach(function(st){ scene.remove(st.tube); st.dots.forEach(function(d){ scene.remove(d); }); });
    streams = [];
    scene.updateMatrixWorld(true);
    desks.forEach(function(D){
      var st = crewState(D.s); if(st !== "working" && st !== "needs") return;
      var a = D.root.localToWorld(new THREE.Vector3(0, 1.95, 1.2)), b = new THREE.Vector3(TABLE.x, 1.35, TABLE.z);
      var mid = a.clone().lerp(b, 0.5); mid.y = 3.6;
      var curve = new THREE.QuadraticBezierCurve3(a, mid, b), col = st === "working" ? COL.cyan : COL.coral;
      var tube = new THREE.Mesh(new THREE.TubeGeometry(curve, 40, 0.012, 5, false), new THREE.MeshBasicMaterial({color: col, transparent: true, opacity: 0.22, blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false}));
      scene.add(tube);
      var dots = [];
      for(var i = 0; i < 4; i++){ var d = glowSprite(col, 0.35, 1); scene.add(d); dots.push(d); }
      streams.push({curve: curve, tube: tube, dots: dots, dir: st === "working" ? 1 : -1, speed: st === "working" ? 0.35 : 0.18, D: D});
    });
  }
  function applyFilter(){
    desks.forEach(function(D){
      var on = !filter || projectOf(D.s) === filter;
      D.root.visible = true;
      if(D.ch) D.ch.o.visible = on && crewState(D.s) !== "stale";
      D.tag.visible = on; if(D.badge) D.badge.visible = on;
      D.pet.visible = on;
    });
    streams.forEach(function(st){ var on = !filter || projectOf(st.D.s) === filter; st.tube.visible = on; st.dots.forEach(function(d){ d.visible = on; }); });
    buildProjects();
  }

  /* ---------- screens ---------- */
  function drawScreen(D, t){
    var g = D.scr.g, W = 256, H = 150, st = crewState(D.s);
    g.fillStyle = st === "stale" ? "#05080b" : "#07121b"; g.fillRect(0, 0, W, H);
    if(st === "stale"){ D.scr.t.needsUpdate = true; return; }
    g.fillStyle = "#13222f"; g.fillRect(0, 0, W, 16);
    ["#ff6b5b", "#ffb347", "#6fd38a"].forEach(function(c, i){ g.fillStyle = c; g.beginPath(); g.arc(9 + i*10, 8, 3, 0, 7); g.fill(); });
    g.fillStyle = HEX.muted; g.font = "600 10px ui-monospace, Menlo, monospace"; g.fillText(short(projectOf(D.s), 26), 42, 12);
    if(st === "idle"){
      var bx = 128 + Math.sin(t*0.4 + D.R()*0)*80, by = 85 + Math.cos(t*0.53)*38;
      g.fillStyle = "rgba(155,140,240,.85)"; g.beginPath(); g.arc(bx, by, 14, 0, 7); g.fill();
      g.fillStyle = HEX.violet; g.font = "700 14px system-ui, sans-serif"; g.fillText("z z", bx + 16, by - 12);
    } else {
      var off = st === "working" ? Math.floor(t*5) : 8;
      for(var i = 0; i < 12; i++){
        var ln = D.lines[(off + i) % D.lines.length], y = 26 + i*10, x = 22 + ln.ind*10;
        ln.segs.forEach(function(sg){ g.fillStyle = sg[1]; g.globalAlpha = 0.85; g.fillRect(x, y - 4, sg[0], 4); x += sg[0] + 5; });
        g.globalAlpha = 1;
      }
      if(st === "needs"){
        g.fillStyle = "rgba(7,18,27,.72)"; g.fillRect(0, 16, W, H - 16);
        g.fillStyle = "#1b0f12"; rr(g, 22, 40, 212, 84, 8); g.fill(); g.strokeStyle = HEX.coral; g.lineWidth = 2; g.stroke();
        g.fillStyle = HEX.ink; g.font = "700 14px system-ui, sans-serif"; g.textAlign = "center";
        g.fillText(short(D.s.waitingSince ? "Waiting for you" : "Needs you", 26), 128, 66);
        g.fillStyle = Math.sin(t*5) > 0 ? HEX.coral : "#5a2a2a"; rr(g, 78, 84, 100, 24, 6); g.fill();
        g.fillStyle = HEX.ink; g.font = "600 11px system-ui, sans-serif"; g.fillText("Open the tab", 128, 100); g.textAlign = "left";
      }
    }
    D.scr.t.needsUpdate = true;
    var g2 = D.scr2.g; g2.fillStyle = "#06100a"; g2.fillRect(0, 0, 160, 110);
    var sp = D.s.spark || [], mx = Math.max.apply(null, sp.concat([1]));
    sp.forEach(function(v, i){ g2.fillStyle = i === sp.length - 1 ? HEX.amber : HEX.cyan; var h = (v/mx)*86; g2.fillRect(6 + i*12.5, 102 - h, 9, h); });
    D.scr2.t.needsUpdate = true;
  }
  function drawWall(t){
    var g = wall.g, W = 1024, H = 384;
    g.fillStyle = "#06111a"; g.fillRect(0, 0, W, H);
    g.strokeStyle = "rgba(95,211,230,.08)"; g.lineWidth = 1;
    for(var x = 0; x < W; x += 32){ g.beginPath(); g.moveTo(x, 0); g.lineTo(x, H); g.stroke(); }
    var c = {working: 0, needs: 0, idle: 0};
    sessions.forEach(function(s){ var st = crewState(s); if(c[st] != null) c[st]++; });
    g.fillStyle = HEX.amber; g.font = "700 34px system-ui, sans-serif"; g.fillText("MISSION CONTROL", 28, 50);
    g.fillStyle = HEX.muted; g.font = "600 20px ui-monospace, Menlo, monospace";
    g.fillText(new Date().toLocaleTimeString([], {hour: "2-digit", minute: "2-digit"}) + "  ·  " + c.working + " working  ·  " + c.needs + " need you  ·  " + c.idle + " idle", 330, 48);
    // activity across every session, newest bucket right
    var n = 12, sums = []; for(var i = 0; i < n; i++) sums.push(0);
    sessions.forEach(function(s){ (s.spark || []).forEach(function(v, j){ if(j < n) sums[j] += +v || 0; }); });
    var mx = Math.max.apply(null, sums.concat([1])), cx = 28, cy = 110, cw = 560, ch = 230;
    g.fillStyle = HEX.muted; g.font = "600 16px ui-monospace, Menlo, monospace"; g.fillText("ACTIVITY · ALL SESSIONS", 28, 94);
    sums.forEach(function(v, j){ var h = v/mx*ch; g.fillStyle = j === n - 1 ? HEX.amber : "rgba(95,211,230,.8)"; g.fillRect(cx + j*(cw/n) + 4, cy + ch - h, cw/n - 8, h); });
    g.fillStyle = HEX.muted; g.fillText("CREW", 640, 94);
    desks.filter(function(D){ return crewState(D.s) !== "stale"; }).slice(0, 7).forEach(function(D, k){
      var y0 = 110 + k*38, st = crewState(D.s), col = STATE_HEX[st];
      g.fillStyle = "rgba(27,43,57,.9)"; rr(g, 636, y0, 360, 32, 6); g.fill();
      g.fillStyle = col; g.fillRect(636, y0, 5, 32);
      g.fillStyle = HEX.ink; g.font = "600 17px system-ui, sans-serif"; g.fillText(short(titleOf(D.s), 22), 652, y0 + 22);
      g.fillStyle = col; g.font = "600 13px ui-monospace, Menlo, monospace"; g.textAlign = "right"; g.fillText(STATE_TXT[st].toUpperCase(), 986, y0 + 21); g.textAlign = "left";
    });
    wall.t.needsUpdate = true;
  }
  function drawLeds(){
    var g = tex.leds.g; g.fillStyle = "#0b1118"; g.fillRect(0, 0, 128, 256);
    for(var u = 0; u < 16; u++){ g.fillStyle = "#16212c"; g.fillRect(6, 6 + u*15.5, 116, 12);
      for(var l = 0; l < 7; l++){ var on = Math.random() < 0.55; g.fillStyle = on ? (l === 0 ? "#6fd38a" : (Math.random() < 0.2 ? "#ffb347" : "#5fd3e6")) : "#1f2b36"; g.fillRect(12 + l*9, 10 + u*15.5, 5, 4); } }
    tex.leds.t.needsUpdate = true;
  }

  /* ---------- you ---------- */
  function buildAvatar(){
    // speed (m/s; signed in the chase cameras: < 0 steps back) and rate (rad/s) on springs (sv, rv);
    // mdx/mdz: the last walk direction off the chase cameras; hy: the visual ground height on a spring (hyV)
    avatar = {g: new THREE.Group(), x: 3, z: 9, yaw: PI, ch: null, speed: 0, sv: 0, rate: 0, rv: 0, mdx: 0, mdz: 1,
              travelYaw: null, hy: 0, hyV: 0, vy: 0, hop: 0, airborne: false};
    avatar.g.rotation.order = "YXZ";                 // yaw, then pitch (x = -pitch), then roll (Units in the 3D city spec)
    avatar.g.position.set(avatar.x, 0, avatar.z); scene.add(avatar.g);
    var ring = avatar.ring = new THREE.Mesh(new THREE.RingGeometry(0.45, 0.55, 32), new THREE.MeshBasicMaterial({color: COL.amber, transparent: true, opacity: 0.7, toneMapped: false}));
    ring.rotation.x = -PI/2; ring.position.y = 0.02; avatar.g.add(ring);
    nameTag();
    var mySpec = api.character && api.character();
    avatar.csig = mySpec ? mySpec.join(".") : "";
    makeCharacter("you:" + (api.name || ""), function(ch){ if(!avatar.ch) putMe(ch); }, mySpec);   // (on the seat if you got on first)
  }
  // Your character changed (Settings): swap the model in place, on the bike if you are riding.
  inst.setCharacter = function(spec){
    if(!avatar || !spec) return;
    var s = spec.join(".");
    if(s === avatar.csig) return;
    avatar.csig = s;
    makeCharacter("you:" + (api.name || ""), function(ch){
      if(avatar.csig !== s) return;
      var old = avatar.ch;
      if(old && old.o.parent) old.o.parent.remove(old.o);
      putMe(ch);
    }, spec);
  };
  // your character, onto whatever you stand or sit on: the seat of the vehicle you ride (in its pose:
  // a board stood side-on, a bike or a car seated), else your feet
  function putMe(ch){
    avatar.ch = ch;
    if(ride){ ride.lean.add(ch.o); seatAny(ch, ride.kind, ride.B); }
    else { avatar.g.add(ch.o); setAnim(ch, "idle"); }
  }
  // Your name tag, in the name frame you wear (HQ 2.1 cosmetics), else amber.
  function frameHex(v){ return /^#[0-9a-f]{6}$/i.test(v || "") ? v : null; }
  function nameTag(){
    if(avatar.tag) avatar.g.remove(avatar.tag);
    avatar.tag = label(short(api.name || "You", 14), frameHex(api.frame && api.frame()) || HEX.amber, 0.5);
    avatar.tag.position.y = 2.3; avatar.g.add(avatar.tag);
  }
  function blocked(x, z){ return cur === worlds.mission ? missionBlocked(x, z) : cur.blocked(x, z); }
  function missionBlocked(x, z){
    if(Math.abs(x) > ROOM - 0.8 || Math.abs(z) > ROOM - 0.8) return true;
    if(Math.hypot(x - TABLE.x, z - TABLE.z) < TABLE.r + 0.6) return true;
    for(var i = 0; i < desks.length; i++){ var p = desks[i].root.position; if(Math.hypot(x - p.x, z - p.z) < 1.35) return true; }
    return false;
  }
  // Walking up to a door takes you through it, the same as clicking it. Doors arm only
  // once you have stepped away from them, so arriving through one never bounces you back.
  var doorsArmed = false, keyMove = false, keyRun = false, movedHere = false;
  function curDoors(){ return cur === worlds.mission ? DOORS : (cur.doors || []); }
  function walkInto(){
    if(fading || walkDoor) return;
    var near = null, nd = 1e9;
    curDoors().forEach(function(d){ if(!d.front) return; var dd = Math.hypot(avatar.x - d.front.x, avatar.z - d.front.z); if(dd < nd){ nd = dd; near = d; } });
    if(!near) return;
    if(nd > 2.6){ doorsArmed = true; return; }
    if(doorsArmed && nd < 1.5){ doorsArmed = false; walkTo = null; through(near); }
  }
  /* ---------- riding a bike or driving a car (Arena City: cur.bikes) ---------- */
  // cur.bikes lists what you can get on: {g, x, z, yaw, color, kind: "car" | "moto" | "skate" (else a
  // bicycle), roof, id}. id names the prop across rebuilds of the street (games/hqcity.js).
  // ride = {idx, id, B (what is under you), lean (group you and it sit in), speed, steer, head (the
  // way you travel; your yaw is the way you point, and the two part in a powerslide), slip, drift,
  // gear, rpm, kind, V (VEHICLES[kind]), car}.
  // Getting off parks it where you are (this page's own props, not shared: everyone else's street
  // keeps them at home); the rack and the skateboards take theirs back.
  // How each one handles (m/s, m/s²). A bicycle sprints while you hold Shift; a motorbike or a car
  // has an accelerator instead: hold W and it keeps gathering speed up to its top, S brakes then
  // reverses, Space is the handbrake, and Shift with the steering powerslides (slide: from `min`
  // m/s, turning `turn` times as hard, the tail letting go with `grip`/s of grip, at most `max`
  // rad sideways, bleeding `bleed` m/s² at full slip). box: half the body's width and length,
  // inside the street's own allowance for a body (its corners must stay clear of walls).
  var VEHICLES = {
    bike: {top: 10, sprint: 14, acc: 7, rev: 2.5, lean: 0.32, box: [0, 0.4]},
    moto: {top: 24, acc: 9, rev: 3, lean: 0.42, box: [0, 0.8], motor: true, gears: [6.5, 11.5, 16, 20.5, 25], eng: "bike",
           slide: {min: 8, turn: 1.35, grip: 3.2, max: 0.32, bleed: 3}},
    car:  {top: 22, acc: 6, rev: 5, lean: 0, box: [0.66, 1.66], motor: true, gears: [5, 9.5, 14, 18.5, 23], eng: "turbo",
           slide: {min: 7, turn: 1.3, grip: 2.2, max: 0.62, bleed: 3.4}},
    skate: {top: 9, acc: 5.5, rev: 0, lean: 0, box: [0, 0], skate: true}     // its physics: games/hqskate.js
  };
  // the boats at the docks (games/hqboat.js: a rowboat and a jet ski; their physics is its own)
  if(HQV.hqboat) Object.keys(HQV.hqboat.VEHICLES).forEach(function(k){ VEHICLES[k] = HQV.hqboat.VEHICLES[k]; });
  // the helicopters on the pads (games/hqheli.js: their flight model is their own; heliMove below)
  if(HQV.hqheli) Object.keys(HQV.hqheli.VEHICLES).forEach(function(k){ VEHICLES[k] = HQV.hqheli.VEHICLES[k]; });
  var ride = null, nearIdx = -1;                                      // nearIdx: nearBike(), once per frame
  function nearBike(){
    var bs = cur && cur.bikes; if(!bs || !avatar) return -1;
    var best = -1, bd = 1e9;
    bs.forEach(function(b, i){
      var d = Math.hypot(avatar.x - b.x, avatar.z - b.z);
      if(b.kind === "car"){                       // a car is long: how far you are from its side, nose to tail
        var hx = Math.sin(b.yaw), hz = Math.cos(b.yaw), u = E.clamp((avatar.x - b.x)*hx + (avatar.z - b.z)*hz, -1.5, 1.5);
        d = Math.hypot(avatar.x - (b.x + hx*u), avatar.z - (b.z + hz*u)) - 0.9;
        if(d > 1.2) return;                       // close by its door, not through the garage wall
      }
      var reach = VEHICLES[b.kind] && VEHICLES[b.kind].reach ? VEHICLES[b.kind].reach : VEHICLES[b.kind] && VEHICLES[b.kind].boat ? 4 : 1.7;   // a boat lies off the quay
      if(b.y != null && Math.abs(b.y - avatar.hy) > 3) return;                  // a helicopter up on a roof
      if(d < reach && d < bd){ bd = d; best = i; } });
    return best;
  }
  // the parked prop you are riding: found by its id, so a rebuilt street (someone opened their HQ
  // and the lots moved along) still gives back yours, not whatever now sits at its old index
  function rideProp(){
    var bs = cur && cur.bikes; if(!bs || !ride) return null;
    if(ride.id){ for(var i = 0; i < bs.length; i++) if(bs[i].id === ride.id) return bs[i]; return null; }
    return bs[ride.idx] || null;
  }
  // Where you left them (by id), until you leave the page: put back on every rebuild of the street.
  var parked = {}, propsSeen = null;
  function placeProp(b, x, z, yaw){
    var p = b.g.parent; if(!p) return;
    p.updateMatrixWorld(true);
    var q = new THREE.Quaternion(), e = new THREE.Euler(0, 0, 0, "YXZ"); p.getWorldQuaternion(q); e.setFromQuaternion(q, "YXZ");
    var v = p.worldToLocal(new THREE.Vector3(x, 0, z));
    b.g.position.set(v.x, b.g.position.y, v.z); b.g.rotation.y = yaw - e.y;
    b.x = x; b.z = z; b.yaw = yaw;
  }
  // a point on the street as {u (the HQ whose block it is on), dx, dz}, and back again
  function anchorOf(w, x, z){
    var ls = w && w.lots, best = null, bd = 26;
    (ls || []).forEach(function(L){ var d = Math.max(Math.abs(x - L.x), Math.abs(z - L.z)); if(d < bd){ bd = d; best = {u: L.u, dx: x - L.x, dz: z - L.z}; } });
    return best;
  }
  function anchorAt(w, a){
    var ls = (w && w.lots) || [];
    for(var i = 0; i < ls.length; i++) if(ls[i].u === a.u) return {x: ls[i].x + a.dx, z: ls[i].z + a.dz};
    return null;
  }
  function syncProps(){
    var bs = cur && cur.bikes; if(!bs || bs === propsSeen) return;
    propsSeen = bs;
    bs.forEach(function(b){
      if(!b.home) b.home = {x: b.x, z: b.z, yaw: b.yaw};                  // its bay (Return to HQ puts it back)
      var p = b.id && parked[b.id]; if(p) placeProp(b, p.x, p.z, p.yaw);
    });
  }
  /* Skate poses, built from the rig's bones (the characters have no trick clips): a crouch
     (legs bent; your own rider also sits lower), arms out for balance, and the torso twisting into a spin.
     pose = {crouch 0..1, arms 0..1, twist (rad)}. Last frame's offsets are taken back before
     the mixer runs, so nothing accumulates whether or not a clip drives that bone. */
  function poseBones(ch){
    if(!ch || ch._pb === false) return null;
    if(!ch._pb){
      var b = {la: ch.o.getObjectByName("arm-left"), ra: ch.o.getObjectByName("arm-right"), t: ch.o.getObjectByName("torso"),
               ll: ch.o.getObjectByName("leg-left"), rl: ch.o.getObjectByName("leg-right")};
      ch._pb = b.la && b.ra && b.t && b.ll && b.rl ? b : false;
      if(!ch._pb) return null;
      ch._po = {la: 0, ra: 0, t: 0, l: 0};
    }
    return ch._pb;
  }
  function poseUndo(ch){
    var b = poseBones(ch), o = ch && ch._po; if(!b || !o) return;
    b.la.rotation.z -= o.la; b.ra.rotation.z -= o.ra; b.t.rotation.y -= o.t;
    b.ll.rotation.x -= o.l; b.rl.rotation.x -= o.l;
    ch._po = {la: 0, ra: 0, t: 0, l: 0};
  }
  function poseApply(ch, pose){
    var b = poseBones(ch); if(!b || !pose) return;
    var o = {la: pose.arms*1.25, ra: -pose.arms*1.25, t: pose.twist || 0, l: -pose.crouch*0.7};
    b.la.rotation.z += o.la; b.ra.rotation.z += o.ra; b.t.rotation.y += o.t;
    b.ll.rotation.x += o.l; b.rl.rotation.x += o.l;
    ch._po = o;
  }
  // the pose for a skater, from the sim's state (yours) or from a trick id k (someone else's)
  function skatePoseOf(k, air, crouchT){
    var K = HQV.hqSkateSim ? HQV.hqSkateSim.K : {};
    if(k === K.bail) return {crouch: 0.2, arms: 0.9, twist: 0};
    if(k === K.grind) return {crouch: 0.45, arms: 1, twist: 0};
    var crouch = air ? 0.85 : Math.max(0.15, crouchT > 0 ? 0.8 : 0.15);
    return {crouch: crouch, arms: air ? 0.45 : 0.15, twist: k === K.spin ? 0.35 : 0};
  }

  // on a board you stand side-on, knees bent a little
  function standSkater(ch, on){
    if(!ch) return;
    if(on){ ch.o.position.set(0, 0.13, 0); ch.o.rotation.set(0, PI/2, 0); setAnim(ch, "idle"); }
    else { ch.o.position.set(0, 0, 0); ch.o.rotation.set(0, 0, 0); setAnim(ch, "idle"); }
  }
  /* ---------- riders: on the seat, hands on the grips, feet on the pegs ---------- */
  // The six Mini Characters share one skeleton (model units): the hips 0.176 up, the arms straight out
  // to the sides at rest (a T), the legs straight down, every bone's rest rotation the identity. A
  // rider is seated by placing the hips on the vehicle's seat, bending forward at the waist, then
  // pointing each arm at its grip and each leg at its peg or pedal, every frame after the clips
  // have run (each limb is one bone, so it is aimed, and stretched or shortened a little to reach).
  // Seated, everyone is drawn a little smaller (RIDER_K) so the vehicles stay a believable size.
  var HIP = [0, 0.176, -0.029], RIDER_K = 0.85;
  var LEG_REST = [0, -0.168, 0.012];
  function rigOf(ch){
    if(!ch) return null;
    if(ch._rig !== undefined) return ch._rig;
    var o = ch.o, R = {root: o.getObjectByName("root"), t: o.getObjectByName("torso"), h: o.getObjectByName("head"),
                       la: o.getObjectByName("arm-left"), ra: o.getObjectByName("arm-right"),
                       ll: o.getObjectByName("leg-left"), rl: o.getObjectByName("leg-right")};
    if(!(R.root && R.t && R.h && R.la && R.ra && R.ll && R.rl)) return (ch._rig = null);
    // each arm's reach at rest, from the skin itself: the far end of its hand, in the arm's frame
    R.lav = armReach(o, R.la) || new THREE.Vector3(0.28, -0.03, 0.03);
    R.rav = armReach(o, R.ra) || new THREE.Vector3(-0.28, -0.03, 0.03);
    R.legv = new THREE.Vector3(LEG_REST[0], LEG_REST[1], LEG_REST[2]);
    return (ch._rig = R);
  }
  function armReach(o, bone){
    var tip = null;
    o.traverse(function(n){
      if(tip || !n.isSkinnedMesh || !n.skeleton) return;
      var bi = n.skeleton.bones.indexOf(bone); if(bi < 0) return;
      var at = new THREE.Vector3().setFromMatrixPosition(new THREE.Matrix4().copy(n.skeleton.boneInverses[bi]).invert());
      var pos = n.geometry.attributes.position, si = n.geometry.attributes.skinIndex, sw = n.geometry.attributes.skinWeight;
      if(!pos || !si || !sw) return;
      var pts = [], far = 0, v = new THREE.Vector3();
      for(var i = 0; i < pos.count; i++){
        var best = 0, bb = -1;
        for(var k = 0; k < 4; k++){ var w = sw.getComponent(i, k); if(w > best){ best = w; bb = si.getComponent(i, k); } }
        if(bb !== bi) continue;
        v.set(pos.getX(i), pos.getY(i), pos.getZ(i)).sub(at); var d = v.length();
        pts.push([v.x, v.y, v.z, d]); if(d > far) far = d;
      }
      if(!pts.length) return;
      var s = new THREE.Vector3(), n2 = 0;
      pts.forEach(function(p){ if(p[3] > far*0.88){ s.x += p[0]; s.y += p[1]; s.z += p[2]; n2++; } });
      tip = s.divideScalar(Math.max(1, n2));
    });
    return tip && tip.length() > 0.05 ? tip : null;
  }
  var tmpA = null, tmpB = null, tmpQ = null, tmpE = null;
  // point `bone` (its rest reach `rest`, along `axis`) at the world point `w`, stretching to reach it
  function aimBone(bone, w, rest, axis, reach, lift){
    var p = bone.parent.worldToLocal(tmpA.copy(w));
    if(lift) p.y += lift;
    p.sub(bone.position);
    var len = p.length(); if(len < 1e-4) return;
    bone.quaternion.setFromUnitVectors(tmpB.copy(rest).normalize(), p.divideScalar(len));
    var k = E.clamp(len/(rest.length()*reach), 0.62, 1.32);
    bone.scale.set(axis === "x" ? k : 1, axis === "y" ? k : 1, 1);
  }
  // what sits on top of a character's head (games/avatar3d.js add-ons on the head bone, above the
  // brow): headwear, a halo, a crest. Glasses and visors stay.
  function hatsOf(ch){
    if(ch._hats) return ch._hats;
    var h = ch.o.getObjectByName("head"), out = [];
    if(h) h.children.forEach(function(gp){ if(gp.isBone) return; gp.traverse(function(o){ if(o.isMesh && o.position.y > 0.6) out.push(o); }); });
    return (ch._hats = out);
  }
  // Seat a character on vehicle B (or stand them back up: B null).
  function seatOn(ch, B){
    if(!ch) return;
    var R = rigOf(ch), base = ch.base || ch.o.scale.x;
    ch.base = base;
    // under a car's roof a hat would poke through it: hats (and halos, crests) come off while you drive
    var bare = !!(B && B.hats === false);
    hatsOf(ch).forEach(function(o){ o.visible = !bare; });
    if(B && B.seat){
      var s = base*(B.riderK || RIDER_K), p = B.seat.position;
      ch.o.scale.setScalar(s); ch.o.rotation.set(0, 0, 0);
      ch.o.position.set(p.x - HIP[0]*s, p.y - HIP[1]*s, p.z - HIP[2]*s);
      setAnim(ch, "idle");
      return;
    }
    ch.o.scale.setScalar(base); ch.o.position.set(0, 0, 0); ch.o.rotation.set(0, 0, 0);
    if(R){                                   // back to the rest pose; the clips take it from there
      [R.t, R.h, R.la, R.ra, R.ll, R.rl].forEach(function(b){ b.quaternion.set(0, 0, 0, 1); b.scale.set(1, 1, 1); });
      R.root.position.set(0, 0, 0);
    }
    setAnim(ch, "idle");
  }
  // The riding pose, after the clips have run: `top` is the group the rider and vehicle hang from
  // (your avatar or a peer); steer -1..1 turns the head and shoulders into the bend.
  function ridePose(ch, B, steer, top){
    var R = rigOf(ch); if(!R || !B || !B.seat || !B.grips) return;
    if(!tmpA){ tmpA = new THREE.Vector3(); tmpB = new THREE.Vector3(); tmpQ = new THREE.Vector3(); tmpE = new THREE.Euler(); }
    steer = steer || 0;
    R.root.position.set(0, 0, 0);
    R.t.quaternion.setFromEuler(tmpE.set(B.lean || 0, steer*0.14, 0));
    R.h.quaternion.setFromEuler(tmpE.set(-(B.lean || 0)*0.8, steer*0.3, 0));   // eyes up the road, looking into the turn
    top.updateMatrixWorld(true);
    aimBone(R.la, B.grips[0].getWorldPosition(tmpQ), R.lav, "x", 0.9, 0);
    aimBone(R.ra, B.grips[1].getWorldPosition(tmpQ), R.rav, "x", 0.9, 0);
    aimBone(R.ll, B.feet[0].getWorldPosition(tmpQ), R.legv, "y", 1, 0.02/ (ch.o.scale.y || 1));
    aimBone(R.rl, B.feet[1].getWorldPosition(tmpQ), R.legv, "y", 1, 0.02/ (ch.o.scale.y || 1));
  }
  function seatAny(ch, kind, B){ if(kind === "skate") standSkater(ch, true); else seatOn(ch, B); }

  function mount(i){
    var b = cur.bikes && cur.bikes[i]; if(!b || ride) return;
    mountOn(b, i);
  }
  // b: a parked {g, x, z, yaw, color, roof?, kind}; i: its index in cur.bikes (-1: not parked anywhere)
  function mountOn(b, i){
    var lean = new THREE.Group(); avatar.g.add(lean);
    var kind = VEHICLES[b.kind] ? b.kind : "bike", car = kind === "car", boat = !!VEHICLES[kind].boat && !!HQV.hqboat, heli = !!VEHICLES[kind].heli && !!HQV.hqheli;
    var B = heli ? HQV.hqheli.model(ctx, kind, b.color, b.accent) : boat ? HQV.hqboat.model(ctx, kind, b.color, b.accent) : car ? carModel(b.color, b.accent, b.plate) : kind === "moto" ? motoModel(b.color, b.accent, b.plate) : kind === "skate" ? boardModel(b.color) : bikeModel(b.color, b.accent); lean.add(B.g);
    if(avatar.ch){ lean.add(avatar.ch.o); seatAny(avatar.ch, kind, B); }
    b.g.visible = false;
    avatar.airborne = false; avatar.vy = 0; avatar.hop = 0;   // getting on mid-hop lands you on the seat
    // you take its place: the seat is where it stands (a car is long, so this matters most there)
    if(kind !== "skate"){ avatar.x = b.x; avatar.z = b.z; }
    settleY(0); if(boat) avatar.hy = cur.sea ? cur.sea.y : 0; avatar.g.position.y = avatar.hy;
    avatar.speed = 0; avatar.sv = 0; avatar.rate = 0; avatar.rv = 0;
    ride = {idx: i, id: b.id || null, B: B, lean: lean, speed: 0, steer: 0, head: b.yaw, slip: 0, drift: false, gear: 1, rpm: 900,
            kind: kind, V: VEHICLES[kind], car: car, eng: null, pitch: 0, pv: 0, roll: 0, rv: 0,
            boat: boat ? HQV.hqboat.newState(kind, b.x, b.z, b.yaw) : null,
            heli: heli ? HQV.hqheli.newState(kind, b.x, b.y != null ? b.y : groundAt(b.x, b.z), b.z, b.yaw) : null};
    if(ride.heli){ avatar.hy = ride.heli.y; avatar.g.position.y = avatar.hy; }
    if(kind === "skate") skateStart(b);
    if(ride.boat) ride.boat.y = cur.sea ? cur.sea.y : 0;            // afloat where it lies (no spring down from 0)
    avatar.yaw = b.yaw; avatar.rideYaw = null; walkTo = null; walkDoor = null;
    movedHere = true;                       // you are somewhere now: a street rebuild must not put you back at your door
    avatar.g.position.set(avatar.x, avatar.hy, avatar.z); avatar.g.rotation.y = avatar.yaw;
    E.sfx(kind === "bike" ? "bell" : car ? "door" : kind === "skate" ? "jump" : "go");
    if(kind !== "skate") driveHud(kind);
    rideUiSync(true);
  }
  function dismount(force){
    if(!ride) return;
    if(ride.heli){
      // out only once it is down, and on land: the world says where you stand (a roof pad: its building's door);
      // forced (another world, Return to HQ) it stays where it was parked
      var hs = ride.heli, hspot = hs.ground && cur && cur.heliLand ? cur.heliLand(hs) : null;
      if(!hs.ground && !force){ if(api.announce) api.announce("Land first: hold Shift to come down, then E."); return; }
      if(!hspot && !force){ if(api.announce) api.announce("You can't step out here: land on the ground or on a helipad."); return; }
      var hp = rideProp();
      if(hp){
        if(hspot && !force){ parked[hp.id] = {x: hs.x, z: hs.z, yaw: hs.yaw}; placeProp(hp, hs.x, hs.z, hs.yaw); hp.g.position.y = hs.y; hp.y = hs.y; }
        hp.g.visible = true;
      }
      if(avatar.ch){ poseUndo(avatar.ch); avatar.g.add(avatar.ch.o); seatOn(avatar.ch, null); }
      avatar.g.rotation.x = 0; avatar.g.rotation.z = 0;
      if(hspot){ avatar.x = hspot.x; avatar.z = hspot.z; if(hspot.yaw != null) avatar.yaw = hspot.yaw; }
      avatar.g.remove(ride.lean);
      if(ride.eng){ ride.eng.stop(); ride.eng = null; }
      ride = null; doorsArmed = false; stopFeet(); settleY(0);
      avatar.g.position.set(avatar.x, avatar.hy, avatar.z); avatar.g.rotation.y = avatar.yaw;
      driveHud(null); rideUiSync(true);
      return;
    }
    if(ride.boat){
      // ashore only at a dock or where the bow touches the beach (the world says where you step);
      // forced (another world, Return to HQ) the boat goes back to its berth
      var spot = cur && cur.boatLand ? cur.boatLand(ride.boat) : null;
      if(!spot && !force){ if(api.announce) api.announce("Steer to a dock or onto a beach to step ashore."); return; }
      var bp = rideProp();
      if(bp){
        if(spot && !force){ parked[bp.id] = {x: ride.boat.x, z: ride.boat.z, yaw: ride.boat.yaw}; placeProp(bp, ride.boat.x, ride.boat.z, ride.boat.yaw); }
        bp.g.visible = true;
      }
      if(avatar.ch){ poseUndo(avatar.ch); avatar.g.add(avatar.ch.o); seatOn(avatar.ch, null); }
      avatar.g.rotation.x = 0; avatar.g.rotation.z = 0;
      if(spot){ avatar.x = spot.x; avatar.z = spot.z; if(spot.yaw != null) avatar.yaw = spot.yaw; }
      avatar.g.remove(ride.lean);
      if(ride.eng){ ride.eng.stop(); ride.eng = null; }
      ride = null; doorsArmed = false; stopFeet(); settleY(0);
      avatar.g.position.set(avatar.x, avatar.hy, avatar.z); avatar.g.rotation.y = avatar.yaw;
      driveHud(null); rideUiSync(true);
      return;
    }
    if(ride.kind === "skate"){
      var st = ride.sk && ride.sk.st;
      if(st && (st.air || st.grind) && !force) return;               // finish the trick first (E mid-air does nothing)
      settleY(0); avatar.g.position.y = avatar.hy; skateHud(null);
    }
    avatar.g.rotation.x = 0; avatar.g.rotation.z = 0;                  // off the slope-following vehicle: stand upright
    var b = rideProp();
    if(b){
      // a vehicle from a garage stays where you leave it; the rack's bikes and the boards go home
      if(b.stay && !force){ parked[b.id] = {x: avatar.x, z: avatar.z, yaw: avatar.yaw}; placeProp(b, avatar.x, avatar.z, avatar.yaw); }
      b.g.visible = true;
    }
    if(avatar.ch){ poseUndo(avatar.ch); avatar.g.add(avatar.ch.o); seatOn(avatar.ch, null); }
    if(ride.kind !== "skate"){
      // step off to the side (a car: out of the driver's door, else the passenger's, else behind
      // or in front), never into a wall or back into the car, which stands here again now
      var cy = Math.cos(avatar.yaw), sy = Math.sin(avatar.yaw);
      var offs = ride.car ? [[-1.4, 0], [1.4, 0], [0, -2.6], [0, 2.6], [-2.4, 0], [2.4, 0]] : [[-0.7, 0], [0.7, 0], [0, -1.2], [0, 1.2]];
      offs.some(function(o){
        var ox = avatar.x + o[0]*cy + o[1]*sy, oz = avatar.z - o[0]*sy + o[1]*cy;
        if(blocked(ox, oz)) return false;
        avatar.x = ox; avatar.z = oz; settleY(0); avatar.g.position.set(ox, avatar.hy, oz); return true;
      });
      avatar.g.position.set(avatar.x, groundAt(avatar.x, avatar.z), avatar.z);
    }
    avatar.g.remove(ride.lean);
    if(ride.eng){ ride.eng.stop(); ride.eng = null; }
    ride = null; doorsArmed = false;
    driveHud(null);
    rideUiSync(true);
  }
  // A gamepad, while you ride (standard mapping): left stick steers, RT/LT throttle/brake,
  // A handbrake, B powerslide (pedal harder on a bicycle).
  function padNow(){
    var pads = null; try { pads = navigator.getGamepads ? navigator.getGamepads() : null; } catch(e){ pads = null; }
    if(!pads) return null;
    for(var i = 0; i < pads.length; i++){
      var p = pads[i]; if(!p || !p.connected || !p.buttons) continue;
      var bv = function(n){ var b = p.buttons[n]; return b ? (typeof b === "object" ? (b.pressed ? Math.max(0.5, b.value || 1) : b.value || 0) : +b || 0) : 0; };
      var x = p.axes && p.axes.length ? +p.axes[0] || 0 : 0;
      return {x: Math.abs(x) > 0.18 ? x : 0, thr: bv(7) - bv(6), hand: bv(0) > 0.5, slide: bv(1) > 0.5, use: bv(2) > 0.5};
    }
    return null;
  }
  // how many of a body's corners (box: half width, half length) stand somewhere blocked, pointing yaw at x, z
  function bodyHits(x, z, yaw, bx){
    var w = bx[0], l = bx[1], s = Math.sin(yaw), c = Math.cos(yaw), n = 0;
    var pts = w ? [[w, l], [-w, l], [w, -l], [-w, -l], [w, 0], [-w, 0], [0, l], [0, -l]] : l ? [[0, l], [0, -l]] : [];
    if(blocked(x, z)) n++;
    for(var i = 0; i < pts.length; i++) if(blocked(x + pts[i][0]*c + pts[i][1]*s, z - pts[i][0]*s + pts[i][1]*c)) n++;
    return n;
  }
  function angDiff(a, b){ return Math.atan2(Math.sin(a - b), Math.cos(a - b)); }
  function rideMove(dt){
    var gp = padNow();
    var thr = (keys.KeyW || keys.ArrowUp ? 1 : 0) - (keys.KeyS || keys.ArrowDown ? 1 : 0);
    var st = (keys.KeyA || keys.ArrowLeft ? 1 : 0) - (keys.KeyD || keys.ArrowRight ? 1 : 0);
    var shift = !!(keys.ShiftLeft || keys.ShiftRight), hand = !!keys.Space;
    if(gp){ thr = E.clamp(thr + gp.thr, -1, 1); st = E.clamp(st - gp.x, -1, 1); shift = shift || gp.slide; hand = hand || gp.hand; }
    var V = ride.V, top = V.sprint && shift ? V.sprint : V.top;
    walkTo = null; walkDoor = null;
    // an engine pulls hardest from a standstill and less as it nears its top speed
    var pull = (V.motor ? V.acc*Math.max(0.25, 1 - Math.max(0, ride.speed)/top) : V.acc)*Math.max(0, thr);
    if(V.motor && hand) ride.speed = ride.speed > 0 ? Math.max(0, ride.speed - 24*dt) : Math.min(0, ride.speed + 24*dt);   // handbrake
    else if(thr > 0) ride.speed = Math.min(top, ride.speed + (ride.speed < 0 ? 14 : pull)*dt);
    else if(thr < 0) ride.speed = Math.max(-V.rev, ride.speed - (ride.speed > 0 ? 14 : 4)*-thr*dt);
    else ride.speed = ride.speed > 0 ? Math.max(0, ride.speed - (V.motor ? 3 : 2)*dt) : Math.min(0, ride.speed + 4*dt);
    if(ride.speed > top) ride.speed = Math.max(top, ride.speed - 6*dt);
    if(ride.B.brake) ride.B.brake(!!V.motor && ((thr < 0 && ride.speed > 0.3) || (hand && Math.abs(ride.speed) > 0.3)));   // the brake lights
    ride.steer += (st - ride.steer)*ease(6, dt);
    // the powerslide: Shift (or B) with the steering, fast enough, going forward. It holds while you
    // keep Shift down and some speed, so you can catch it with opposite lock.
    var spd = Math.abs(ride.speed), S = V.slide, was = ride.drift;
    if(S && shift && ride.speed > S.min && (ride.drift || Math.abs(st) > 0.3)) ride.drift = true;
    else if(!S || !shift || ride.speed < S.min*0.55) ride.drift = false;
    if(ride.drift && !was) E.sfx("door");          // the tyres let go (a burst of noise: engine.js has no screech)
    var grip = Math.min(1, spd/2.5), yaw0 = avatar.yaw;
    avatar.yaw += ride.steer*grip*(ride.speed >= 0 ? 1.9 : -1.2)*(ride.drift ? S.turn : 1)*dt;
    // the way you travel follows the way you point: at once with grip, slowly in a slide (and
    // catching up smoothly as the tyres bite again)
    var slip = angDiff(avatar.yaw, ride.head);
    if(ride.drift) ride.head += slip*ease(S.grip, dt);
    else if(Math.abs(slip) > 0.02) ride.head += slip*ease(7, dt);
    else ride.head = avatar.yaw;
    if(S){ slip = E.clamp(angDiff(avatar.yaw, ride.head), -S.max, S.max); ride.head = avatar.yaw - slip; } else slip = 0;
    ride.slip = slip;
    if(ride.drift) ride.speed = Math.max(0, ride.speed - (0.15*ride.speed + Math.abs(Math.sin(slip))*S.bleed/Math.max(0.2, S.max))*dt);
    var d = ride.speed*dt;
    // the 3D city's hills: slower uphill, a little faster down (world.js slopeFactor per kind)
    if(d && cur.camModes) d *= slopeFactor(slopeAlong(avatar.x, avatar.z, ride.head, 1.5)*(d < 0 ? -1 : 1), ride.kind);
    var sh = Math.sin(ride.head), ch = Math.cos(ride.head), nx = avatar.x + sh*d, nz = avatar.z + ch*d;
    // the body, every corner of it, stays out of the walls; a body already touching one may still
    // move or turn as long as that does not push it further in (so nothing is ever stuck)
    var bx = V.box, now = bodyHits(avatar.x, avatar.z, yaw0, bx);
    if(d || avatar.yaw !== yaw0){
      var then = bodyHits(nx, nz, avatar.yaw, bx);
      if(then === 0 || then < now){ avatar.x = nx; avatar.z = nz; }
      else {
        var turnOnly = bodyHits(avatar.x, avatar.z, avatar.yaw, bx);
        if(!(turnOnly === 0 || turnOnly < now)) avatar.yaw = yaw0;
        if(d && Math.abs(ride.speed) > 2.5) E.sfx("hit");
        ride.speed *= -0.2; d = 0; ride.drift = false; ride.head = avatar.yaw; ride.slip = 0;
      }
    }
    (ride.kind === "car" ? carRoll : ride.kind === "moto" ? motoRoll : bikeRoll)(ride.B, d, ride.steer);
    // lean into the turn, a slide leans further (and sit up straight in Calm); a car does not lean
    var lean = E.calm() ? 0 : (-ride.steer*Math.min(1, spd/6) - ride.slip*1.2)*V.lean;
    ride.lean.rotation.z += (lean - ride.lean.rotation.z)*ease(8, dt);
    engineStep(dt, thr);
    keyMove = spd > 0.3; keyRun = false; if(keyMove){ movedHere = true; walkInto(); }
    vehicleTilt(dt);
    var ry0 = avatar.rideYaw != null ? avatar.rideYaw : avatar.yaw;
    avatar.rate += ((dt > 0 ? wrapPi(avatar.yaw - ry0)/dt : 0) - avatar.rate)*ease(10, dt); avatar.rideYaw = avatar.yaw;
    // where you are headed is where the vehicle travels (ride.head: in a slide that is not where it points)
    avatar.travelYaw = Math.abs(ride.speed) > 0.05 ? (ride.speed < 0 ? wrapPi(ride.head + PI) : ride.head) : null;
    settleY(dt);
    avatar.g.position.set(avatar.x, avatar.hy, avatar.z);
    avatar.g.rotation.y = avatar.yaw; avatar.g.rotation.x = -ride.pitch; avatar.g.rotation.z = ride.roll;
    var b = rideProp(); if(b && b.g.visible) b.g.visible = false;   // the street rebuilt under you
    view.goal.set(avatar.x*(cur.follow || 1), avatar.hy + (cur.camY || 1.4), avatar.z*(cur.follow || 1));
  }
  // A vehicle on the 3D city's ground: nose pitched to the slope over its wheelbase, a car rolled to the
  // cross slope over 1.2 m (a bike or motorbike only leans, ride.lean); both on springs (omega 10).
  var WHEELBASE = {car: 2.3, moto: MOTO_WB, bike: BIKE_WB};
  function vehicleTilt(dt){
    var wantP = 0, wantR = 0;
    if(cur && cur.camModes && cur.groundY){
      var wb = WHEELBASE[ride.kind] || 1.2, h = wb/2, sy = Math.sin(avatar.yaw), cy = Math.cos(avatar.yaw);
      wantP = Math.atan((groundAt(avatar.x + sy*h, avatar.z + cy*h) - groundAt(avatar.x - sy*h, avatar.z - cy*h))/wb);
      if(ride.kind === "car"){                      // model-local +x (left) is (cos yaw, -sin yaw); roll > 0 = right side down
        var lx = cy*0.6, lz = -sy*0.6;
        wantR = Math.atan((groundAt(avatar.x + lx, avatar.z + lz) - groundAt(avatar.x - lx, avatar.z - lz))/1.2);
      }
    }
    var a = tiltSpring(ride.pitch, ride.pv, wantP, dt), r = tiltSpring(ride.roll, ride.rv, wantR, dt);
    ride.pitch = a[0]; ride.pv = a[1]; ride.roll = r[0]; ride.rv = r[1];
  }
  function tiltSpring(x, v, goal, dt){ return spring(x || 0, v || 0, goal, 10, dt); }
  // An automatic gearbox and the engine note (games/engine.js engineSound), for the HUD's rev
  // counter and your ears: revs climb through each gear and drop as it changes up; a slide spins
  // the wheels up a little.
  function engineStep(dt, thr){
    var V = ride.V; if(!V.motor){ ride.gear = 0; return; }
    var G = V.gears, v = Math.abs(ride.speed), g = Math.max(1, Math.min(G.length, ride.gear | 0 || 1));
    if(v > G[g - 1]*0.98 && g < G.length) g++;
    else if(g > 1 && v < G[g - 2]*0.78) g--;
    ride.gear = ride.speed < -0.3 ? -1 : g;
    var top = G[g - 1], tgt = 900 + 6600*E.clamp(v/top, 0, 1) + (thr > 0 ? 500*thr : 0) + (ride.drift ? 900 : 0);
    ride.rpm += (Math.min(7800, tgt) - ride.rpm)*(1 - Math.exp(-dt*8));
    // stopped with the throttle off: no note (without set() each frame, engineSound fades out)
    if(v < 0.3 && !(thr > 0)) return;
    if(!ride.eng && E.engineSound) ride.eng = E.engineSound(V.eng);
    if(ride.eng) ride.eng.set(ride.rpm);
  }
  /* ---------- skating (games/hqskate.js does the physics) ---------- */
  // ride.sk = {st (the sim's state, in the park's frame), cx, cz (the park's centre), prev (keys last frame)}
  var SKATE_BEST = "hq_skate_best";
  function skateBest(){ try { return Math.max(0, parseInt(localStorage.getItem(SKATE_BEST), 10) || 0); } catch(e){ return 0; } }
  function skateStart(b){
    var park = cur.skatepark || {cx: 0, cz: 0}, Sim = HQV.hqSkateSim;
    var st = Sim.newState(avatar.x - park.cx, avatar.z - park.cz, b.yaw);
    st.best = skateBest();
    ride.sk = {st: st, cx: park.cx, cz: park.cz, prev: {}, pop: [], t: 0};
    skateHud("Hold W to push · A / D carve · Space ollie · in the air: A / D spin, F kickflip, G shove-it · land on the rail or the ledge to grind");
  }
  function skateMove(dt){
    var sk = ride.sk, st = sk.st, Sim = HQV.hqSkateSim, k = keys, pv = sk.prev;
    var inp = {push: k.KeyW || k.ArrowUp, brake: k.KeyS || k.ArrowDown,
      steer: (k.KeyA || k.ArrowLeft ? 1 : 0) - (k.KeyD || k.ArrowRight ? 1 : 0),
      ollie: k.Space && !pv.Space, flip: k.KeyF && !pv.KeyF, shove: k.KeyG && !pv.KeyG};
    sk.prev = {Space: k.Space, KeyF: k.KeyF, KeyG: k.KeyG};
    walkTo = null; walkDoor = null;
    var wasAir = st.air;
    var evs = Sim.step(st, inp, dt, function(x, z){ return blocked(x + sk.cx, z + sk.cz); });
    // a quick crouch: winding up the pop, and soaking up a landing
    sk.crouch = Math.max(0, (sk.crouch || 0) - dt);
    if(inp.ollie || (wasAir && !st.air)) sk.crouch = 0.16;
    sk.pose = E.calm() ? null : skatePoseOf(Sim.kOf(st), st.air, sk.crouch);
    evs.forEach(skateEvent);
    var syaw0 = avatar.yaw;
    avatar.x = st.x + sk.cx; avatar.z = st.z + sk.cz; avatar.yaw = st.yaw;
    avatar.rate += ((dt > 0 ? wrapPi(avatar.yaw - syaw0)/dt : 0) - avatar.rate)*ease(10, dt);
    avatar.travelYaw = Math.abs(st.speed) > 0.05 ? (st.speed < 0 ? wrapPi(avatar.yaw + PI) : avatar.yaw) : null;
    // the 3D city: the park's pad height plus the sim's height (st.y already holds the ramps; never add groundAt)
    var base = cur.camModes && cur.skateBase != null ? cur.skateBase : 0;
    avatar.g.position.set(avatar.x, base + st.y, avatar.z); avatar.g.rotation.y = avatar.yaw;
    // the trick: the whole rider and board turn for a spin, the board alone flips or shoves
    var calm = E.calm(), B = ride.B;
    ride.lean.rotation.y = calm ? 0 : st.spin;
    B.deck.rotation.z = calm ? 0 : st.flip*PI*2;
    B.deck.rotation.y = calm ? 0 : st.shove*PI;
    ride.lean.rotation.x = st.bail > 0 && !calm ? -0.5 : 0;
    if(avatar.ch){
      avatar.ch.o.position.y = 0.13 - (sk.pose ? sk.pose.crouch*0.12 : 0);   // lower as the knees bend (poseApply bends them)
      setAnim(avatar.ch, st.bail > 0 ? "sit" : inp.push && !st.air && !st.grind ? "walk" : "idle", inp.push ? 0.8 : 1);
    }
    B.wheels.forEach(function(w){ w.rotation.x += st.speed*dt/0.03; });
    keyMove = Math.abs(st.speed) > 0.3 || st.air; keyRun = false; if(keyMove){ movedHere = true; walkInto(); }
    var b = rideProp(); if(b && b.g.visible) b.g.visible = false;
    view.goal.set(avatar.x*(cur.follow || 1), groundAt(avatar.x, avatar.z) + (cur.camY || 1.4) + st.y*0.7, avatar.z*(cur.follow || 1));
    sk.t += dt; if(sk.t > 0.25){ sk.t = 0; skateHudCombo(st); }
  }
  function skateEvent(e){
    var st = ride && ride.sk && ride.sk.st; if(!st) return;
    if(e.type === "trick") skatePop(e.name + " +" + e.pts, "trick");
    else if(e.type === "grind") { skatePop(e.name + "!", "trick"); E.sfx("coin"); }
    else if(e.type === "land") E.sfx("putt");
    else if(e.type === "bail"){ skatePop("Bail! " + e.why, "bail"); E.sfx("sink"); if(api.announce) api.announce("Bail. " + e.why + "."); }
    else if(e.type === "combo"){
      skatePop((e.mult > 1 ? e.mult + "× combo  " : "") + "+" + e.total + (e.best ? "  · new best!" : ""), e.best ? "best" : "combo");
      E.sfx(e.best ? "finish" : "coin");
      if(e.best){ try { localStorage.setItem(SKATE_BEST, String(e.total)); } catch(x){} }
      if(api.announce) api.announce(e.names.join(", ") + ". " + e.total + " points" + (e.best ? ", a new best." : "."));
      if(api.skateCombo) api.skateCombo({total: e.total, tricks: e.mult});   // the page may put it on the week's board
    }
  }
  // the skate HUD over the scene: the hint line, the running combo, your best, and popups
  var skateEl = null;
  function skateHud(hint){
    if(hint == null){ if(skateEl){ skateEl.remove(); skateEl = null; } return; }
    if(!skateEl){
      skateEl = document.createElement("div"); skateEl.className = "hq3d-skate"; skateEl.setAttribute("aria-hidden", "true");
      ["hq3d-skate-combo", "hq3d-skate-pops", "hq3d-skate-hint"].forEach(function(cl){ var d = document.createElement("div"); d.className = cl; skateEl.appendChild(d); });
      ((rideUi && rideUi.parentNode) || el).appendChild(skateEl);
    }
    skateEl.querySelector(".hq3d-skate-hint").textContent = hint;
    skateHudCombo(ride && ride.sk ? ride.sk.st : null);
  }
  function skateHudCombo(st){
    if(!skateEl || !st) return;
    var c = st.combo, txt = c.mult ? c.names.slice(-4).join(" + ") + "   " + c.score + (c.mult > 1 ? " × " + c.mult : "") : "";
    skateEl.querySelector(".hq3d-skate-combo").textContent = (txt ? txt + "   ·   " : "") + "Best " + st.best;
  }
  function skatePop(text, kind){
    if(!skateEl) return;
    var box = skateEl.querySelector(".hq3d-skate-pops"), el = document.createElement("div");
    el.className = "hq3d-skate-pop " + kind; el.textContent = text; box.appendChild(el);
    while(box.children.length > 3) box.removeChild(box.firstChild);
    setTimeout(function(){ if(el.parentNode) el.parentNode.removeChild(el); }, 1600);
  }
  // what other players see you doing on a board: {k (hqskate.js K), y (height, decimetres)}
  function skateNet(){
    var st = ride && ride.sk && ride.sk.st; if(!st) return null;
    return {k: HQV.hqSkateSim.kOf(st), y: Math.max(0, Math.min(60, Math.round(st.y*10)))};
  }

  // The "Ride (E)" / "Get off (E)" button over the scene: shows near a parked bike or while riding.
  function rideUiSync(force){
    if(!rideUi) return;
    var near = ride ? -2 : force ? nearBike() : nearIdx, nb = near >= 0 && cur && cur.bikes ? cur.bikes[near] : null;
    var key = ride ? "on" : nb ? "near-" + (nb.kind || "bike") : "";
    if(!force && key === rideUi.dataset.k) return;
    rideUi.dataset.k = key; rideUi.hidden = !key;
    var kind = ride ? ride.kind : (nb && VEHICLES[nb.kind] ? nb.kind : "bike");
    rideUi.textContent = ride ? (kind === "car" || VEHICLES[kind].heli ? "Get out (E)" : kind === "skate" ? "Step off (E)" : VEHICLES[kind].boat ? "Step ashore (E)" : "Get off (E)")
      : VEHICLES[kind].heli ? "\uD83D\uDE81 Fly (E)" : kind === "rowboat" ? "\uD83D\uDEA3 Row (E)" : kind === "jetski" ? "\uD83C\uDF0A Ride the jet ski (E)" : kind === "car" ? "\uD83D\uDE97 Drive (E)" : kind === "moto" ? "\uD83C\uDFCD\uFE0F Ride (E)" : kind === "skate" ? "\uD83D\uDEF9 Skate (E)" : "\uD83D\uDEB2 Ride (E)";
    rideUi.title = ride ? RIDE_HELP[kind] : VEHICLES[kind].heli ? "Take the controls" : VEHICLES[kind].boat ? "Take the helm" : kind === "car" ? "Get in this car" : kind === "moto" ? "Get on this motorbike"
      : kind === "skate" ? "Step on this skateboard" : "Get on this bike";
    if(key === "on" && force) tipRide();
  }
  var RIDE_HELP = {
    bike: "W / S: pedal and brake · A / D: steer · Shift: pedal harder · E: get off",
    moto: "W: throttle (hold it to keep speeding up) · S: brake, then reverse · A / D: steer · Shift + steer: slide the back wheel · Space: handbrake · E: get off",
    car: "W: accelerator (hold it to keep speeding up) · S: brake, then reverse · A / D: steer · Shift + steer: powerslide · Space: handbrake · E: get out",
    skate: "W: push · S: brake · A / D: carve (in the air: spin) · Space: ollie · F: kickflip · G: shove-it · E: step off",
    rowboat: "W: row · S: back water · A / D: steer · E: step ashore at a dock or a beach",
    jetski: "W: throttle · S: astern · A / D: steer (it needs way on to turn) · E: step ashore at a dock or a beach",
    heli: "Space: climb (hold it to take off) · Shift: descend · W / S: nose down to fly forward, nose up to slow · A / D: turn · E: get out once landed",
    attack: "Space: climb (hold it to take off) · Shift: descend · W / S: nose down to fly forward, nose up to slow · A / D: turn · E: get out once landed"
  };
  // the one-line version under the driving HUD
  var RIDE_HINT = {
    bike: "W pedal · S brake · A/D steer · Shift pedal harder · E get off · T home",
    moto: "W throttle · S brake · A/D steer · Shift+steer slide · Space handbrake · E get off · T home",
    car: "W go · S brake · A/D steer · Shift+steer powerslide · Space handbrake · E get out · T home",
    rowboat: "W row · S back water · A/D steer · E step ashore at a dock or a beach",
    jetski: "W throttle · S astern · A/D steer · E step ashore at a dock or a beach",
    heli: "Space climb · Shift descend · W/S forward/back · A/D turn · E get out (landed)",
    attack: "Space climb · Shift descend · W/S forward/back · A/D turn · E get out (landed)"
  };
  function tipRide(){ if(!api.announce || !ride) return;
    if(ride.kind === "skate") return;                                 // the skate HUD says how
    if(ride.heli){ api.announce("At the controls. Hold Space to lift off and climb, Shift to come down, W and S tilt forward and back, A and D turn. Land, then E to get out."); return; }
    api.announce(ride.kind === "car" ? "In the car. Hold W to accelerate, S brakes and reverses, A and D steer, hold Shift while steering to powerslide, Space is the handbrake, E gets out."
      : ride.kind === "moto" ? "On the motorbike. Hold W for throttle, S brakes, A and D steer, hold Shift while steering to slide, Space is the handbrake, E gets off."
      : "On the bike. W and S pedal and brake, A and D steer, Shift pedals harder, E gets off."); }

  /* ---------- the driving HUD: speed and revs, Kart Racing's gauges (games/kart.js) ---------- */
  // While you ride: a speedometer (km/h) and, with an engine, a rev counter with the gear in it,
  // plus the keys. The dials are drawn in the theme's colours (engine.js tokens); in Calm (and with
  // reduced motion) the moving dials give way to a plain readout. Decorative to screen readers:
  // tipRide() announces the keys, and the speed is not worth a running commentary.
  var dhud = null;                      // (not "hud": that is the camera HUD, hqhud)
  var HUD_MAX = {bike: [60, 10, 5], moto: [120, 20, 10], car: [120, 20, 10], rowboat: [20, 5, 1], jetski: [80, 10, 5], heli: [200, 40, 10], attack: [200, 40, 10]};   // the speed dial: max, major, minor
  function driveHud(kind){
    if(dhud){ if(dhud.el.parentNode) dhud.el.parentNode.removeChild(dhud.el); dhud = null; }
    if(!kind || !HUD_MAX[kind]) return;
    gamesCss();
    var d = document.createElement("div"); d.className = "hq3d-drive hq3d-drive-" + kind; d.setAttribute("aria-hidden", "true");
    var slide = document.createElement("span"); slide.className = "hq3d-drive-slide"; slide.textContent = kind === "moto" ? "Slide" : "Powerslide";
    var cv = document.createElement("canvas"); cv.className = "hq3d-drive-dial";
    var read = document.createElement("div"); read.className = "hq3d-drive-read";
    var hint = document.createElement("div"); hint.className = "hq3d-drive-hint"; hint.textContent = RIDE_HINT[kind];
    [slide, cv, read, hint].forEach(function(n){ d.appendChild(n); });
    ((rideUi && rideUi.parentNode) || el).appendChild(d);
    dhud = {el: d, cv: cv, read: read, kind: kind, tok: null, tokAt: -9, at: -9, txt: "", sl: false};
  }
  // the HUD's and the Return to HQ button's styles live with the games' (the Valley loads the same sheet)
  function gamesCss(){
    if(document.getElementById("valleyCss")) return;
    var l = document.createElement("link"); l.id = "valleyCss"; l.rel = "stylesheet"; l.href = "/games/games.css"; document.head.appendChild(l);
  }
  function gearTxt(g){ return g < 0 ? "R" : g === 0 ? "N" : String(g); }
  function driveHudDraw(t){
    if(!dhud || !ride || t - dhud.at < 1/30) return;
    dhud.at = t;
    var kmh = Math.abs(ride.speed)*3.6, motor = !!ride.V.motor, gear = motor ? (Math.abs(ride.speed) < 0.3 && ride.gear > 0 ? 0 : ride.gear) : 0;
    var txt = Math.round(kmh) + " km/h" + (motor ? "  ·  gear " + gearTxt(gear) : "") + (ride.heli ? "  ·  " + Math.round(ride.heli.agl) + " m up" + (ride.heli.ground ? " (landed)" : "") : "");
    if(txt !== dhud.txt){ dhud.txt = txt; dhud.read.textContent = txt; }
    if(!!ride.drift !== dhud.sl){ dhud.sl = !!ride.drift; dhud.el.classList.toggle("sliding", dhud.sl); }
    if(E.calm()) return;                              // no moving needles (CSS shows the readout instead)
    if(!dhud.tok || t - dhud.tokAt > 2){ dhud.tok = E.tokens(); dhud.tokAt = t; }
    var cv = dhud.cv, dpr = Math.min(window.devicePixelRatio || 1, 2), W = motor ? 236 : 124, H = 124;
    if(cv.width !== Math.round(W*dpr)){ cv.width = Math.round(W*dpr); cv.height = Math.round(H*dpr); }
    var g = cv.getContext("2d"), M = HUD_MAX[dhud.kind]; g.setTransform(dpr, 0, 0, dpr, 0, 0); g.clearRect(0, 0, W, H);
    driveDial(g, dhud.tok, 62, 64, 54, kmh, M[0], M[1], M[2], "km/h", Math.round(kmh), null);
    if(motor) driveDial(g, dhud.tok, 174, 64, 54, ride.rpm/1000, 8, 1, 0.5, "×1000 rpm", gearTxt(gear), 6.5, "GEAR");
  }
  // one round dial: Kart Racing's (games/kart.js dial()), the label under the needle's hub
  function driveDial(g, T, cx, cy, r, val, max, major, minor, unit, label, red, cap){
    var a0 = PI*0.75, a1 = PI*2.25;
    function ang(v){ return a0 + (a1 - a0)*E.clamp(v/max, 0, 1); }
    g.beginPath(); g.arc(cx, cy, r, 0, PI*2); g.fillStyle = T.panel; g.globalAlpha = 0.9; g.fill(); g.globalAlpha = 1;
    g.lineWidth = 1.5; g.strokeStyle = T.line; g.stroke();
    if(red != null){ g.beginPath(); g.arc(cx, cy, r - 7, ang(red), a1); g.lineWidth = 6; g.strokeStyle = T.need; g.stroke(); }
    g.lineCap = "round";
    for(var v = 0; v <= max + 1e-6; v += minor){
      var isMaj = Math.abs(v/major - Math.round(v/major)) < 1e-6, a = ang(v), r1 = r - 4, r2 = r - (isMaj ? 13 : 9);
      g.beginPath(); g.moveTo(cx + Math.cos(a)*r1, cy + Math.sin(a)*r1); g.lineTo(cx + Math.cos(a)*r2, cy + Math.sin(a)*r2);
      g.lineWidth = isMaj ? 2 : 1; g.strokeStyle = red != null && v >= red ? T.need : T.muted; g.stroke();
      if(isMaj){
        g.fillStyle = T.muted; g.font = "600 9px " + T.mono; g.textAlign = "center"; g.textBaseline = "middle";
        g.fillText(String(Math.round(v)), cx + Math.cos(a)*(r - 22), cy + Math.sin(a)*(r - 22));
      }
    }
    var an = ang(val);
    g.beginPath(); g.moveTo(cx - Math.cos(an)*6, cy - Math.sin(an)*6); g.lineTo(cx + Math.cos(an)*(r - 8), cy + Math.sin(an)*(r - 8));
    g.lineWidth = 3; g.strokeStyle = red != null && val >= red ? T.need : T.brand; g.stroke();
    g.beginPath(); g.arc(cx, cy, 4, 0, PI*2); g.fillStyle = T.ink; g.fill();
    g.fillStyle = T.ink; g.font = "700 16px " + T.mono; g.textAlign = "center"; g.textBaseline = "alphabetic";
    g.fillText(String(label), cx, cy + r*0.55);
    g.fillStyle = T.muted; g.font = "600 8px " + T.mono; g.fillText(unit, cx, cy + r*0.55 + 11);
    if(cap) g.fillText(cap, cx, cy + r*0.55 - 16);                 // what the big label is (the gear, on the rev counter)
  }

  /* ---------- skid marks and tyre smoke in a slide ---------- */
  // Marks: flat dark quads on the road behind the back wheels, a ring of them reused (they stay
  // until overwritten; a still mark is no animation, so Calm keeps them). Smoke: soft grey puffs
  // that swell and fade (not in Calm). Both live in the scene you drive in, rebuilt with it.
  var fx = null, FX_MARKS = 220, FX_PUFFS = 36;
  function fxOf(){
    var sc = cur && cur.scene; if(!sc) return null;
    if(fx && fx.scene === sc) return fx;
    fxClear();
    if(!tex.smoke){
      tex.smoke = canvasTex(64, 64, function(g2){ var rg = g2.createRadialGradient(32, 32, 0, 32, 32, 32);
        rg.addColorStop(0, "rgba(220,224,230,.9)"); rg.addColorStop(0.5, "rgba(200,205,212,.45)"); rg.addColorStop(1, "rgba(200,205,212,0)");
        g2.fillStyle = rg; g2.fillRect(0, 0, 64, 64); }).t;
    }
    fx = {scene: sc, marks: [], mi: 0, puffs: [], pi: 0, at: 0, last: [null, null],
          mm: new THREE.MeshBasicMaterial({color: 0x101214, transparent: true, opacity: 0.5, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -2}),
          geo: new THREE.PlaneGeometry(1, 1)};
    return fx;
  }
  function fxClear(){
    if(!fx) return;
    fx.marks.forEach(function(m){ if(m.parent) m.parent.remove(m); });
    fx.puffs.forEach(function(p){ if(p.sp.parent) p.sp.parent.remove(p.sp); p.sp.material.dispose(); });
    fx.mm.dispose(); fx.geo.dispose(); fx = null;
  }
  // a mark from the last spot of wheel w to (x, z)
  function fxMark(F, w, x, z, width){
    var L = F.last[w]; F.last[w] = {x: x, z: z};
    if(!L) return;
    var dx = x - L.x, dz = z - L.z, len = Math.hypot(dx, dz); if(len < 0.05 || len > 2) return;
    var m = F.marks[F.mi];
    if(!m){ m = new THREE.Mesh(F.geo, F.mm); m.rotation.order = "YXZ"; m.renderOrder = 1; F.marks[F.mi] = m; }
    if(m.parent !== F.scene) F.scene.add(m);
    m.position.set((x + L.x)/2, 0.066, (z + L.z)/2); m.rotation.set(-PI/2, Math.atan2(dx, dz), 0); m.scale.set(width, len + 0.04, 1);
    F.mi = (F.mi + 1) % FX_MARKS;
  }
  function fxPuff(F, x, z, t){
    var p = F.puffs[F.pi];
    if(!p){ p = F.puffs[F.pi] = {sp: new THREE.Sprite(new THREE.SpriteMaterial({map: tex.smoke, transparent: true, depthWrite: false, opacity: 0}))}; }
    if(p.sp.parent !== F.scene) F.scene.add(p.sp);
    p.t0 = t; p.x = x; p.z = z; p.sp.position.set(x, 0.3, z); p.sp.scale.set(0.5, 0.5, 1); p.sp.visible = true;
    F.pi = (F.pi + 1) % FX_PUFFS;
  }
  function fxStep(t, dt){
    var sliding = ride && ride.drift && Math.abs(ride.speed) > 3 && Math.abs(ride.slip) > 0.08;
    if(!fx && !sliding) return;
    var F = fxOf(); if(!F) return;
    if(sliding){
      // the back wheels, in the world: under the body (your yaw), behind the seat
      var s = Math.sin(avatar.yaw), c = Math.cos(avatar.yaw), car = ride.car;
      var wh = car ? [[CAR_WX, -CAR_WZ], [-CAR_WX, -CAR_WZ]] : [[0, -MOTO_WB/2*MOTO_S]];
      wh.forEach(function(w, i){ fxMark(F, i, avatar.x + w[0]*c + w[1]*s, avatar.z - w[0]*s + w[1]*c, car ? 0.24 : 0.14); });
      F.at += dt;
      if(F.at > 0.05 && !E.calm()){ F.at = 0; wh.forEach(function(w){ fxPuff(F, avatar.x + w[0]*c + w[1]*s, avatar.z - w[0]*s + w[1]*c, t); }); }
    } else F.last = [null, null];
    F.puffs.forEach(function(p){
      if(!p.sp.visible) return;
      var age = t - p.t0;
      if(age > 0.9 || E.calm()){ p.sp.visible = false; return; }
      var k = 0.5 + age*2.4; p.sp.scale.set(k, k, 1); p.sp.position.y = 0.3 + age*0.7; p.sp.material.opacity = 0.5*(1 - age/0.9);
    });
  }
  function rideToggle(){ if(ride) dismount(); else { var i = nearBike(); if(i >= 0) mount(i); } }

  // The visual ground height: springs (omega 18) toward the ground under you, so a kerb or a road's
  // height change is a step, not a snap. dt 0 (a teleport) or a jump over 3 m lands at once.
  // The raw ground (groundAt) stays the physics: hops and collisions measure from it.
  // A boat (games/hqboat.js): its own water physics against the world's sea (cur.sea, games/ocean.js
  // seaOf): W / S throttle and astern, A / D steer (A turns left, as rideMove), a pad's stick too.
  function boatMove(dt){
    var gp = padNow(), H = HQV.hqboat, st = ride.boat;
    var thr = (keys.KeyW || keys.ArrowUp ? 1 : 0) - (keys.KeyS || keys.ArrowDown ? 1 : 0);
    var steer = (keys.KeyA || keys.ArrowLeft ? 1 : 0) - (keys.KeyD || keys.ArrowRight ? 1 : 0);
    if(gp){ thr = E.clamp(thr + gp.thr, -1, 1); steer = E.clamp(steer - gp.x, -1, 1); }
    walkTo = null; walkDoor = null;
    var inp = {thr: thr, steer: steer}, yaw0 = avatar.yaw;
    var evs = cur.sea ? H.step(st, inp, dt, cur.sea.boat || cur.sea) : [];   // the hull's sea: under a bridge is water
    (evs || []).forEach(function(ev){ var k = ev && (ev.type || ev); if(k === "beach" || k === "dock") E.sfx(k === "dock" ? "door" : "hit"); });
    ride.speed = st.speed != null ? st.speed : ride.speed; ride.steer = steer;
    avatar.x = st.x; avatar.z = st.z; avatar.yaw = st.yaw;
    avatar.rate += ((dt > 0 ? wrapPi(avatar.yaw - yaw0)/dt : 0) - avatar.rate)*ease(10, dt); avatar.rideYaw = avatar.yaw;
    avatar.travelYaw = Math.abs(ride.speed) > 0.05 ? (ride.speed < 0 ? wrapPi(avatar.yaw + PI) : avatar.yaw) : null;
    avatar.hy = st.y != null ? st.y : (cur.sea ? cur.sea.y : 0); avatar.hyV = 0;
    ride.pitch = st.pitch || 0; ride.roll = st.roll || 0;
    H.animate(ride.B, st, inp, dt);
    engineStep(dt, thr);
    keyMove = Math.abs(ride.speed) > 0.3; keyRun = false; if(keyMove) movedHere = true;
    avatar.g.position.set(avatar.x, avatar.hy, avatar.z);
    avatar.g.rotation.y = avatar.yaw; avatar.g.rotation.x = -ride.pitch; avatar.g.rotation.z = ride.roll;
    var b = rideProp(); if(b && b.g.visible) b.g.visible = false;
    view.goal.set(avatar.x*(cur.follow || 1), avatar.hy + (cur.camY || 1.4), avatar.z*(cur.follow || 1));
  }
  // A helicopter (games/hqheli.js): Space climbs, Shift descends, W / S tilt it forward and back, A / D turn
  // (a pad: left stick turns, the triggers tilt, A climbs, B descends). The world's floor (cur.heliFloor: terrain,
  // roofs, the sea, a carrier's deck) is what it lands on and what stops it.
  function heliMove(dt){
    var gp = padNow(), Hh = HQV.hqheli, st = ride.heli;
    var fwd = (keys.KeyW || keys.ArrowUp ? 1 : 0) - (keys.KeyS || keys.ArrowDown ? 1 : 0);
    var turn = (keys.KeyA || keys.ArrowLeft ? 1 : 0) - (keys.KeyD || keys.ArrowRight ? 1 : 0);
    var lift = (keys.Space ? 1 : 0) - (keys.ShiftLeft || keys.ShiftRight ? 1 : 0);
    if(gp){ fwd = E.clamp(fwd + gp.thr, -1, 1); turn = E.clamp(turn - gp.x, -1, 1); lift = E.clamp(lift + (gp.hand ? 1 : 0) - (gp.slide ? 1 : 0), -1, 1); }
    walkTo = null; walkDoor = null;
    var yaw0 = avatar.yaw, floor = cur && cur.heliFloor ? cur.heliFloor : groundAt;
    var evs = Hh.step(st, {fwd: fwd, turn: turn, lift: lift}, dt, {floor: floor});
    evs.forEach(function(ev){
      if(ev.type === "land") E.sfx(ev.hard ? "hit" : "putt");
      else if(ev.type === "bump") E.sfx("hit");
      else if(ev.type === "takeoff") E.sfx("go");
    });
    ride.speed = st.speed; ride.steer = turn;
    avatar.x = st.x; avatar.z = st.z; avatar.yaw = st.yaw;
    avatar.rate += ((dt > 0 ? wrapPi(avatar.yaw - yaw0)/dt : 0) - avatar.rate)*ease(10, dt); avatar.rideYaw = avatar.yaw;
    avatar.travelYaw = st.speed > 0.5 ? Math.atan2(st.vx, st.vz) : null;
    avatar.hy = st.y; avatar.hyV = 0;
    ride.pitch = st.pitch; ride.roll = st.roll;
    Hh.animate(ride.B, st, dt, isNight());
    // the rotor's note: the blades spooling up, harder with the collective and the speed (set() every frame or it fades)
    if(st.rpm > 0.02 && E.engineSound){
      if(!ride.eng) ride.eng = E.engineSound(ride.V.eng);
      ride.eng.set(900 + 6700*E.clamp(st.rpm*0.55 + Math.max(0, lift)*0.25 + st.speed/ride.V.top*0.2, 0, 1));
    }
    keyMove = st.speed > 0.3 || !st.ground; keyRun = false; if(keyMove) movedHere = true;
    avatar.g.position.set(avatar.x, avatar.hy, avatar.z);
    avatar.g.rotation.y = avatar.yaw; avatar.g.rotation.x = -ride.pitch; avatar.g.rotation.z = ride.roll;
    var b = rideProp(); if(b && b.g.visible) b.g.visible = false;
    view.goal.set(avatar.x*(cur.follow || 1), avatar.hy + (cur.camY || 1.4), avatar.z*(cur.follow || 1));
  }
  function settleY(dt){
    var gy = groundAt(avatar.x, avatar.z);
    if(!(dt > 0) || Math.abs(gy - avatar.hy) > 3){ avatar.hy = gy; avatar.hyV = 0; }
    else { var h = spring(avatar.hy, avatar.hyV, gy, 18, dt); avatar.hy = h[0]; avatar.hyV = h[1]; }
    return gy;
  }
  // a teleport: standing still where you land, at the ground's height (no spring from where you were)
  function stopFeet(){ avatar.speed = 0; avatar.sv = 0; avatar.rate = 0; avatar.rv = 0; avatar.travelYaw = null; avatar.hy = 1e9; }
  function moveAvatar(dt){
    if(ride){ if(ride.kind === "skate") skateMove(dt); else if(ride.boat) boatMove(dt); else if(ride.heli) heliMove(dt); else rideMove(dt); return; }
    // on a bus or a tram (games/hqcity3d.js w.carry): the vehicle's seat, its timetable's pose
    var cp = cur && cur.carry ? cur.carry() : null;
    if(cp){
      walkTo = null; walkDoor = null; keyMove = false; movedHere = true;
      avatar.x = cp.x; avatar.z = cp.z; avatar.yaw = cp.yaw; avatar.speed = 0; avatar.sv = 0; avatar.rate = 0; avatar.travelYaw = cp.yaw;
      avatar.hy = cp.y; avatar.hyV = 0; setAnim(avatar.ch, "idle");
      avatar.g.position.set(avatar.x, avatar.hy, avatar.z); avatar.g.rotation.y = avatar.yaw;
      view.goal.set(avatar.x*(cur.follow || 1), avatar.hy + (cur.camY || 1.4), avatar.z*(cur.follow || 1));
      return;
    }
    var fwd = (keys.KeyW || keys.ArrowUp ? 1 : 0) - (keys.KeyS || keys.ArrowDown ? 1 : 0);
    var side = (keys.KeyA || keys.ArrowLeft ? 1 : 0) - (keys.KeyD || keys.ArrowRight ? 1 : 0);
    var run = !!(keys.ShiftLeft || keys.ShiftRight), base = run ? FOOT.run : FOOT.walk;
    if(fwd || side){ walkTo = null; walkDoor = null; }
    var yaw0 = avatar.yaw, dx = 0, dz = 0;
    if(rigOn() && CHASE[rig.mode] && !walkTo){
      // Chase cameras: the keys are the BODY's. W walks along your facing, S steps back without turning
      // (the camera swings round to show where you are headed), A / D turn you on a spring.
      var f = footStep({yaw: avatar.yaw, rate: avatar.rate, rateV: avatar.rv, speed: avatar.speed, speedV: avatar.sv},
                       {fwd: fwd, turn: side, run: run}, dt);
      avatar.yaw = f.yaw; avatar.rate = f.rate; avatar.rv = f.rateV; avatar.speed = f.speed; avatar.sv = f.speedV;
      dx = Math.sin(avatar.yaw); dz = Math.cos(avatar.yaw);
      if(avatar.speed < 0){ dx = -dx; dz = -dz; }
      avatar.mdx = dx; avatar.mdz = dz;
    } else {
      // Classic: relative to the camera ("up" walks away from it; view.yaw points target -> camera).
      // First person: along the look (W / S) and strafing (A / D); rig.lookYaw points camera -> target.
      // A click on the floor walks there. You turn to face where you go; the speed springs either way.
      if(avatar.speed < 0){ avatar.speed = -avatar.speed; avatar.sv = -avatar.sv; avatar.mdx = -avatar.mdx; avatar.mdz = -avatar.mdz; }
      var want = 0;
      if(fwd || side){
        var ref = rigOn() && rig.mode !== "classic" ? rig.lookYaw + PI : view.yaw, mx = -side, mz = -fwd;
        var sn = Math.sin(ref), cs = Math.cos(ref), l = Math.hypot(mx, mz);
        avatar.mdx = (mx*cs + mz*sn)/l; avatar.mdz = (-mx*sn + mz*cs)/l; want = base;
      } else if(walkTo){
        var wx = walkTo.x - avatar.x, wz = walkTo.z - avatar.z, d = Math.hypot(wx, wz);
        if(d < 0.25){ walkTo = null; if(walkDoor){ var dd = walkDoor; walkDoor = null; through(dd); } }
        else { avatar.mdx = wx/d; avatar.mdz = wz/d; want = Math.min(base, d*6); }   // ease into the spot
      }
      var sp = spring(avatar.speed, avatar.sv, want, FOOT.speedW, dt);
      avatar.speed = Math.max(0, sp[0]); avatar.sv = avatar.speed > 0 ? sp[1] : 0;
      dx = avatar.mdx; dz = avatar.mdz;
      if(avatar.speed > 0.05) avatar.yaw = E.angLerp(avatar.yaw, Math.atan2(dx, dz), ease(10, dt));
      avatar.rate += ((dt > 0 ? wrapPi(avatar.yaw - yaw0)/dt : 0) - avatar.rate)*ease(12, dt);
      avatar.rv = 0;
    }
    avatar.travelYaw = travelYawOf(avatar.yaw, avatar.speed, avatar.rate);
    var step = Math.abs(avatar.speed)*dt;
    if(step && cur.camModes) step *= slopeFactor(slopeAlong(avatar.x, avatar.z, Math.atan2(dx, dz), 1.5), "foot");
    keyMove = Math.abs(avatar.speed) > 0.3; keyRun = keyMove && run; if(keyMove) movedHere = true;
    if(step > 0){
      var nx = avatar.x + dx*step, nz = avatar.z + dz*step;
      // standing somewhere blocked already (a car parked over you, a street rebuilt round you):
      // any step is allowed, so you can always walk out
      if(!blocked(nx, nz) || blocked(avatar.x, avatar.z)){ avatar.x = nx; avatar.z = nz; }
      else if(!blocked(nx, avatar.z)) avatar.x = nx;
      else if(!blocked(avatar.x, nz)) avatar.z = nz;
      else { avatar.speed = 0; avatar.sv = 0; keyMove = false; if(walkTo){ walkTo = null; walkDoor = null; } }   // a wall stops you
    }
    // the walk plays at your pace, backwards while you step back
    if(keyMove){ if(keyRun && avatar.speed > 0) setAnim(avatar.ch, "sprint", avatar.speed/FOOT.run); else setAnim(avatar.ch, "walk", avatar.speed/FOOT.walk); walkInto(); }
    else setAnim(avatar.ch, "idle");
    // Space hops: a little gravity so you come back down where you started.
    // Calm mode keeps feet on the ground (no bouncing for reduced motion).
    // The hop is measured from the ground under you (the 3D city's hills; 0 on every flat floor).
    if(E.calm()){ avatar.vy = 0; avatar.airborne = false; avatar.hop = 0; }
    else{
      if(keys.Space && !avatar.airborne){ avatar.airborne = true; avatar.vy = 6.2; E.sfx("jump"); }
      if(avatar.airborne){
        avatar.vy -= 18*dt;
        var ny = avatar.hop + avatar.vy*dt;
        if(ny <= 0){ ny = 0; avatar.vy = 0; avatar.airborne = false; }
        avatar.hop = ny;
      }
    }
    settleY(dt);
    avatar.g.position.set(avatar.x, avatar.hy + avatar.hop, avatar.z); avatar.g.rotation.y = avatar.yaw;
    // the camera follows you, gently
    if(cur === worlds.mission) view.goal.set((avatar.x + TABLE.x)*0.5, 1.4, (avatar.z + TABLE.z)*0.5 + 1);
    else view.goal.set(avatar.x*(cur.follow || 1), avatar.hy + (cur.camY || 1.4), avatar.z*(cur.follow || 1));
  }

  /* ---------- camera + input ---------- */
  function placeCam(){
    var r = 70, t = view.target;
    cam.position.set(t.x + Math.sin(view.yaw)*Math.cos(view.pitch)*r, t.y + Math.sin(view.pitch)*r, t.z + Math.cos(view.yaw)*Math.cos(view.pitch)*r);
    cam.lookAt(t);
  }
  function resize(){
    var w = canvas.clientWidth, h = canvas.clientHeight; if(!w || !h) return;
    if(w !== inst.w || h !== inst.h){ renderer.setSize(w, h, false); inst.w = w; inst.h = h; }
    var span = view.span/view.zoom, a = w/h; if(a < 1) span /= Math.max(a, 0.55);
    cam.left = -span*a; cam.right = span*a; cam.top = span; cam.bottom = -span; cam.updateProjectionMatrix();
    if(pcam && pcam.aspect !== a){ pcam.aspect = a; pcam.updateProjectionMatrix(); }
  }
  var ray = null, drag = null, ptr = null;
  function pick(e, list){
    var r = canvas.getBoundingClientRect();
    ptr.set((e.clientX - r.left)/r.width*2 - 1, -(e.clientY - r.top)/r.height*2 + 1);
    ray.setFromCamera(ptr, curCam());
    return ray.intersectObjects(list, false)[0] || null;
  }

  /* ---------- the 3D City: camera rig (games/camrig.js), HUD (games/hqhud.js), quality ---------- */
  // A rig world is one whose world object lists camModes (the generated City); everything else keeps
  // the orthographic `cam` and today's controls.
  function rigOn(){ return !!(rig && cur && cur.camModes); }
  // The camera that draws and picks: the perspective one in every rig mode but Classic.
  function curCam(){ return rigOn() && rig.mode !== "classic" && pcam ? pcam : cam; }
  function groundAt(x, z){ return cur && cur.camModes && cur.groundY ? cur.groundY(x, z) : 0; }
  // grade (dy/ds) along yaw over +-len m: world.js slopeAlong, on the world's own ground (roads, pads)
  function slopeAlong(x, z, yaw, len){ var sx = Math.sin(yaw)*len, sz = Math.cos(yaw)*len; return (groundAt(x + sx, z + sz) - groundAt(x - sx, z - sz))/(2*len); }
  function slopeFactor(grade, kind){ var W = HQV.world; return W && W.slopeFactor ? W.slopeFactor(grade, kind) : 1; }
  function hudSettings(){
    if(hud && hud.settings) return hud.settings();
    var H = HQV.hqhud, raw = null;
    try { raw = localStorage.getItem("hq_cam"); } catch(e){ raw = null; }
    return H && H.loadSettings ? H.loadSettings(raw) : {fov: 65, sens: 1, invertY: false, reduced: false, headBob: true, quality: "auto", preferred: "chase"};
  }
  // What camrig gets: the HUD's settings, reduced motion also when HQ is calm (E.calm covers the system setting too)
  function camSettings(){
    var s = Object.assign({}, camSet || hudSettings());
    s.reduced = !!(E.calm() || s.reduced || (SMOKE && SMOKE.calm));
    return s;
  }
  function locked(){ return document.pointerLockElement === canvas; }
  function exitLock(){ try { if(locked() && document.exitPointerLock) document.exitPointerLock(); } catch(e){} }
  function showAvatar(on){
    if(!avatar) return;
    if(avatar.ch) avatar.ch.o.visible = on; if(avatar.tag) avatar.tag.visible = on; if(avatar.ring) avatar.ring.visible = on;
  }
  function rigEnter(w){
    if(!w.camModes || !HQV.camrig) return;
    var C = HQV.camrig;
    camSet = hudSettings();
    rig = C.create({mode: w.startMode || "map", preferred: camSet.preferred, settings: camSettings(), span: SMOKE && SMOKE.span || 600, seed: 1});
    if(HQV.hqhud){
      hud = HQV.hqhud.mount(el, {announce: function(t){ if(api.announce) api.announce(t); }});
      hud.onSettings(function(s){ camSet = s || hudSettings(); if(rig) C.setSettings(rig, camSettings()); govQ = null; });
      if(w.mapInfo) hud.setLabels(w.mapInfo());
    }
    calmWas = E.calm(); calmT = 0; lastMode = null; lastFpView = rig.fpView; idleT = 0; occT = 0; pose = null;
    if(rig.mode === "map" && C.flyMap) C.flyMap(rig, avatar.x, avatar.z, SMOKE && SMOKE.span || 600);   // open on the map round you
    gov = HQV.worldbuild && HQV.worldbuild.governor ? HQV.worldbuild.governor.create({target: 16.7}) : null; govQ = null;
  }
  function rigLeave(){
    exitLock();
    Object.keys(HELD_CAM).forEach(function(c){ delete keys[c]; });   // their keyup would not reach a non-rig world
    if(hud){ try { hud.destroy(); } catch(e){} hud = null; }
    if(rig && cur && cur.setFaded) cur.setFaded([]);
    rig = null; pose = null; lastMode = null;
    if(gov || govQ){ gov = null; govQ = null; setQuality({pixelRatio: Math.min(window.devicePixelRatio || 1, 1.5), shadows: true, level: 2}); }
    showAvatar(true);
  }
  // Settings "quality" other than auto pins the governor's level.
  var QUALITY = {low: 0, medium: 1, high: 2};
  function qualityStep(ms){
    if(!gov) return;
    var pin = QUALITY[camSet && camSet.quality], dpr = window.devicePixelRatio || 1;
    var q = pin != null ? {level: pin, pixelRatio: [0.75, 1, Math.min(dpr, 1.5)][pin], shadows: pin > 0} : HQV.worldbuild.governor.step(gov, ms);
    if(govQ && govQ.level === q.level && govQ.pixelRatio === q.pixelRatio && govQ.shadows === q.shadows) return;
    govQ = q; setQuality(q);
    if(cur.setQuality) cur.setQuality(q.level); else if(cur.wb && cur.wb.setQuality) cur.wb.setQuality(q.level);
  }
  // The renderer's shadow map stays on and no material is touched at runtime (that recompiles every
  // shader: a freeze); shadows off is the world's sun no longer casting. Runs only when the level changes.
  function setQuality(q){
    if(renderer.getPixelRatio() !== q.pixelRatio){ renderer.setPixelRatio(q.pixelRatio); inst.w = 0; }   // resize() sets the size again
    var on = !!q.shadows;
    if(cur && cur.scene) cur.scene.traverse(function(o){ if(o.isDirectionalLight && o.castShadow !== on) o.castShadow = on; });
  }
  function perfLog(ms){
    if(!SMOKE || !SMOKE.perf) return;
    perf.n++; perf.ms += ms; perf.t += ms/1000;
    if(perf.t < 5) return;
    var ri = renderer.info.render;
    console.info("hq-frame", JSON.stringify({ms: Math.round(perf.ms/perf.n*10)/10, dc: ri.calls, tri: ri.triangles, q: govQ ? govQ.level : null}));
    perf.t = 0; perf.n = 0; perf.ms = 0;
  }
  // What camrig follows. y: the smoothed visual height; travelYaw: where you are headed (facing, facing + PI
  // stepping back, null when still); turnRate: the smoothed body yaw rate (rad/s, + = left); speed >= 0.
  function rigTarget(){
    var st = ride && ride.sk && ride.sk.st;
    return {x: avatar.x, y: avatar.g.position.y, z: avatar.z, yaw: avatar.yaw, pitch: ride ? ride.pitch || 0 : 0, roll: ride ? ride.roll || 0 : 0,
            speed: ride ? Math.abs(st ? st.speed || 0 : ride.speed) : Math.abs(avatar.speed || 0), vehicle: ride ? ride.kind : null,
            lean: ride && ride.lean ? ride.lean.rotation.z : 0, moving: !!keyMove,
            travelYaw: avatar.travelYaw != null ? avatar.travelYaw : null, turnRate: avatar.rate || 0};
  }
  // Any key, click, wheel or pad input: the idle timer restarts and a cinematic hands back the camera.
  function noteInput(){
    idleT = 0;
    if(rig && rig.mode === "cine"){ var C = HQV.camrig; C.input(rig, {anyInput: true}); C.setMode(rig, rig.prev && rig.prev !== "cine" ? rig.prev : rig.preferred || "chase"); }
  }
  function modeChanged(prev, now){
    lastMode = now; lastFpView = rig.fpView; idleT = 0;
    if((prev === "fp" || prev === "photo") && now !== "fp" && now !== "photo") exitLock();
    // one fade system per mode: Classic runs the world's hqCutaway, the rig modes the occluder list
    if((now === "classic" || now === "map") && cur.setFaded) cur.setFaded([]);
    if(now === "classic"){ view.yaw = rig.lookYaw + PI; view.target.copy(view.goal); }
    if(hud) hud.setMode(now, MODE_LABEL[now] || now);
  }
  function persistPreferred(){
    if(!rig || !rig.preferred) return;
    if(camSet) camSet.preferred = rig.preferred;
    if(hud && hud.setSettings){ hud.setSettings({preferred: rig.preferred}); return; }   // saves hq_cam
    var H = HQV.hqhud;
    if(H && H.saveSettings){ var s = Object.assign({}, hudSettings(), {preferred: rig.preferred}); H.saveSettings(s); }
  }
  function camCycle(dir){
    HQV.camrig.cycle(rig, dir); persistPreferred();
    // V in a car's first person goes seat -> bonnet without changing the mode
    if(rig.mode === lastMode && rig.fpView !== lastFpView){ lastFpView = rig.fpView; if(hud) hud.setMode(rig.mode, rig.fpView === "bonnet" ? "Bonnet camera" : "Seat camera"); }
  }
  function mapToggle(){
    if(cur && cur.bigMap && rig.mode !== "map" && cur.bigMap()) return;   // the 3D City: M grows its minimap
    var C = HQV.camrig;
    if(rig.mode === "map") C.dive(rig, rigTarget()); else C.rise(rig);
  }
  function photoToggle(){
    var C = HQV.camrig;
    if(rig.mode === "photo") C.setMode(rig, rig.prev && rig.prev !== "photo" && rig.prev !== "cine" ? rig.prev : rig.preferred || "chase");
    else C.setMode(rig, "photo");
  }
  // Enter in photo mode: the frame as a PNG, named by the local time (shotName).
  function photoShot(){
    renderer.render(cur.scene, curCam());
    canvas.toBlob(function(b){
      if(!b) return;
      var a = document.createElement("a"), url = URL.createObjectURL(b);
      a.href = url; a.download = shotName(new Date()); document.body.appendChild(a); a.click(); a.remove();
      setTimeout(function(){ URL.revokeObjectURL(url); }, 4000);
      if(api.announce) api.announce("Photo saved");
    }, "image/png");
  }
  function placeAvatar(x, z, yaw){
    avatar.x = x; avatar.z = z; if(yaw != null) avatar.yaw = yaw;
    avatar.hop = 0; avatar.vy = 0; avatar.airborne = false; stopFeet();
    walkTo = null; walkDoor = null; doorsArmed = false; movedHere = true;
    moveAvatar(0); view.target.copy(view.goal);
  }
  // A click on the City map (w.mapPick): your HQ dives in at its door; another HQ flies the map there; the ground
  // sets a waypoint where the world takes one (w.mapWaypoint), else flies the map there too.
  function mapClick(e){
    var x, z, f = pick(e, [].concat(cur.floor || []));
    if(f){ x = f.point.x; z = f.point.z; }
    else {                                   // tiles not drawn yet: straight-down camera, span metres per view height
      var r = canvas.getBoundingClientRect(), kk = (rig.mapSpan || 2048)/(r.height || 1), c = rig.mapCentre || {x: 0, z: 0};
      x = c.x + (e.clientX - r.left - r.width/2)*kk; z = c.z + (e.clientY - r.top - r.height/2)*kk;
    }
    var p = cur.mapPick ? cur.mapPick(x, z) : {kind: "point", x: x, z: z};
    if(p && p.kind === "point" && cur.mapWaypoint && cur.mapWaypoint(x, z)) return;     // the ground: a waypoint (HQ 3.1)
    var a = mapClickAction(p), C = HQV.camrig;
    if(!a) return;
    if(a.act === "dive"){ dismount(true); placeAvatar(a.x, a.z, a.yaw); C.dive(rig, rigTarget()); }
    else { C.flyMap(rig, a.x, a.z, a.span); if(a.name && api.announce) api.announce(a.name); }
  }
  // The HUD's E prompt: a door under the crosshair only. A vehicle near you already has its own E pill (rideUi:
  // "Drive (E)", "Row (E)"), so the HUD never offers it a second time (it once said "E  Ride the bike" by a rowboat).
  function hudPrompt(){
    if(rig.mode === "fp" && !ride && pose){ var d = doorUnderCrosshair(pose, curDoors(), 3); if(d) return "E  Enter " + (d.label || d.tip || "the door"); }
    return null;
  }
  function project(x, y, z){
    projV.set(x, y, z).project(curCam());
    return {x: (projV.x + 1)/2*(inst.w || 1), y: (1 - projV.y)/2*(inst.h || 1), vis: projV.z > -1 && projV.z < 1};
  }
  function peerDots(){
    var out = [];
    Object.keys(peers).forEach(function(u){ var P = peers[u]; if(P.g.parent === cur.scene) out.push({n: P.n || "Visitor", x: P.x, y: P.hy || 0, z: P.z}); });
    return out;
  }
  function camInfo(){
    var c = curCam();
    c.updateMatrixWorld(); projM.multiplyMatrices(c.projectionMatrix, c.matrixWorldInverse); frustum.setFromProjectionMatrix(projM);
    return {x: c.position.x, y: c.position.y, z: c.position.z, fov: c.isPerspectiveCamera ? c.fov : 0, far: c.far, mode: rig ? rig.mode : "classic",
            frustum: frustum, avatar: {x: avatar.x, y: avatar.g.position.y, z: avatar.z}};
  }
  // Every frame in a rig world: held keys into the rig, step it, put the perspective camera on its pose.
  function rigFrame(t, dt){
    var C = HQV.camrig, m = rig.mode, k = keys;
    var ev = {swing: (k.KeyR ? 1 : 0) - (k.KeyQ ? 1 : 0), lift: (k.KeyC ? 1 : 0) - (k.KeyZ ? 1 : 0)};
    var fwd = (k.KeyW || k.ArrowUp ? 1 : 0) - (k.KeyS || k.ArrowDown ? 1 : 0), side = (k.KeyA || k.ArrowLeft ? 1 : 0) - (k.KeyD || k.ArrowRight ? 1 : 0);
    if(m === "photo"){ ev.fly = {x: -side, y: ev.lift, z: fwd}; ev.fast = !!(k.ShiftLeft || k.ShiftRight); ev.swing = 0; ev.lift = 0; }   // fly x: +1 = to the right
    if(m === "map" && (fwd || side)){ var pv = 600*dt; ev.pan = [-side*pv, -fwd*pv]; }
    C.input(rig, ev);
    var T = rigTarget();
    pose = C.step(rig, T, dt, {ground: groundAt, hit: cur.camHit || function(){ return 1; }, viewH: inst.h || 600, aspect: (inst.w || 1)/(inst.h || 1)});
    if(rig.mode === "cine" && rig.wake) C.setMode(rig, rig.prev && rig.prev !== "cine" ? rig.prev : rig.preferred || "chase");
    if(rig.mode !== lastMode) modeChanged(lastMode, rig.mode);
    if(pose && !pose.ortho){
      pcam.position.set(pose.pos.x, pose.pos.y, pose.pos.z);
      pcam.up.set(pose.up.x, pose.up.y, pose.up.z);
      pcam.lookAt(pose.look.x, pose.look.y, pose.look.z);
      if(pose.roll) pcam.rotateZ(pose.roll);
      pcam.fov = pose.fov; pcam.near = pose.near; pcam.far = pose.far; pcam.updateProjectionMatrix(); pcam.updateMatrixWorld();
    }
    showAvatar(!(pose && pose.hideAvatar));
    if(rig.mode !== "classic" && rig.mode !== "map" && cur.setFaded && cur.occluderItems && pose){
      occT += dt;
      if(occT >= 0.1){ occT = 0; cur.setFaded(C.occluders(pose.pos, pose.focus || pose.look, cur.occluderItems(avatar.x, avatar.g.position.y, avatar.z))); }
    }
    calmT += dt;
    if(calmT >= 1){ calmT = 0; var cl = E.calm(); if(cl !== calmWas){ calmWas = cl; C.setSettings(rig, camSettings()); } }
    // idle: 45 s without input starts a cinematic (never from the map or photo mode)
    if(rig.mode === "map" || rig.mode === "photo" || rig.mode === "cine") idleT = 0;
    else if((idleT += dt) > 45){ idleT = 0; C.setMode(rig, "cine"); }
    if(hud && pose) hud.frame({mode: rig.mode, hudOn: pose.hud !== false, yaw: rig.lookYaw, speed: ride ? T.speed : null,
      vehicle: ride ? ride.kind : null, prompt: hudPrompt(), crosshair: rig.mode === "fp", vignette: pose.vignette || 0,
      mapSpan: rig.mapSpan, project: project, peers: peerDots(), ground: groundAt});
  }
  // A trip between islands (games/hqtravel.js through hqcity3d's w.camPose): while its pose has a
  // camera, it is the shot (a perspective one: classic and the map hand over to chase first).
  function tripCam(){
    var cp = cur && cur.camPose ? cur.camPose() : null;
    if(!cp || !cp.camera || !cp.pos || !cp.look || !rigOn()) return;
    if(rig.mode === "classic" || rig.mode === "map" || rig.mode === "photo") HQV.camrig.setMode(rig, "chase", {instant: true});
    pcam.position.set(cp.pos.x, cp.pos.y, cp.pos.z);
    if(cp.up) pcam.up.set(cp.up.x, cp.up.y, cp.up.z);
    pcam.lookAt(cp.look.x, cp.look.y, cp.look.z);
    pcam.fov = cp.fov || 60; pcam.far = Math.max(pcam.far, 3000); pcam.updateProjectionMatrix(); pcam.updateMatrixWorld();
    showAvatar(false);
  }
  // Gamepad: polled only after a gamepadconnected (and until a gamepaddisconnected).
  function onPadOn(){ pad.on = true; }
  function onPadOff(){ pad.on = false; pad.st = null; pad.prev = []; }
  function padPoll(dt){
    pad.st = null;
    if(!pad.on || !navigator.getGamepads) return;
    var list = navigator.getGamepads() || [], gp = null;
    for(var i = 0; i < list.length; i++) if(list[i]){ gp = list[i]; break; }
    if(!gp) return;
    var p = padToInput(gp.axes, gp.buttons, pad.prev); pad.prev = p.pressed; pad.st = p;
    if(!p.any) return;
    noteInput();
    if(rigOn()){
      if(p.cycle) camCycle(p.cycle);
      if(p.map) mapToggle();
      var lx = p.look[0]*900*dt, ly = p.look[1]*900*dt;
      if(lx || ly){ if(rig.mode === "fp" || rig.mode === "photo") HQV.camrig.input(rig, {look: [lx, ly]}); else if(CHASE[rig.mode]) HQV.camrig.input(rig, {orbit: [lx, ly]}); }
    }
    if(p.use) useKey();
  }
  // the keys as this frame sees them: the keyboard, plus the left stick and A (hop) of a pad
  function withPad(){
    var p = pad.st; if(!p) return keys;
    var k = Object.assign({}, keys);
    if(p.move[1] < -0.35) k.KeyW = true; if(p.move[1] > 0.35) k.KeyS = true;
    if(p.move[0] < -0.35) k.KeyA = true; if(p.move[0] > 0.35) k.KeyD = true;
    if(p.hop) k.Space = true;
    return k;
  }

  function onDown(e){
    noteInput();
    if(rigOn() && rig.mode !== "classic"){
      var m = rig.mode;
      // first person and photo: a click captures the mouse for looking (Esc gives it back); no picking while locked
      if(m === "fp" || m === "photo"){ if(!locked() && canvas.requestPointerLock){ try { canvas.requestPointerLock(); } catch(x){} } drag = null; return; }
      if(m === "cine") return;
      // map: left-drag pans; chase family: left- or right-drag orbits (trackpads have no right-drag),
      // and a left click that barely moved still picks / walks (onUp, under 5 px)
      drag = {x: e.clientX, y: e.clientY, lx: e.clientX, ly: e.clientY, moved: 0, rig: true, button: e.button,
              map: m === "map" && e.button === 0, orbit: !!CHASE[m] && (e.button === 0 || e.button === 2)};
      canvas.setPointerCapture(e.pointerId); return;
    }
    drag = {x: e.clientX, y: e.clientY, yaw: view.yaw, pitch: view.pitch, moved: 0}; canvas.setPointerCapture(e.pointerId);
  }
  function onMove(e){
    if(locked()){ if(rig){ HQV.camrig.input(rig, {look: [e.movementX || 0, e.movementY || 0]}); noteInput(); } return; }
    if(drag){
      var dx = e.clientX - drag.x, dy = e.clientY - drag.y; drag.moved = Math.max(drag.moved, Math.abs(dx) + Math.abs(dy));
      if(drag.rig){
        var ix = e.clientX - drag.lx, iy = e.clientY - drag.ly; drag.lx = e.clientX; drag.ly = e.clientY;
        if(drag.moved > 5 && rig){
          if(drag.map) HQV.camrig.input(rig, {pan: [-ix, -iy]});              // grab the map: it follows the pointer
          else if(drag.orbit) HQV.camrig.input(rig, {orbit: [ix, iy]});
          tip.hidden = true; noteInput();
        }
        return;
      }
      if(drag.moved > 5){ view.yaw = drag.yaw - dx*0.006; view.pitch = E.clamp(drag.pitch + dy*0.004, 0.25, 1.2); tip.hidden = true; }
      return;
    }
    if(rigOn() && rig.mode === "map"){ tip.hidden = true; return; }
    var h = pick(e, hitList());
    var o = h && h.object.userData, txt = null;
    if(o && o.desk){ var s = o.desk.s; txt = titleOf(s) + " · " + STATE_TXT[crewState(s)] + " · " + projectOf(s); }
    else if(o && o.door) txt = o.door.tip || (o.door.label + ": go to " + o.door.view.charAt(0).toUpperCase() + o.door.view.slice(1));
    else if(o && o.tip) txt = o.tip;
    else if(o && o.project) txt = o.project + ": show only its crew";
    canvas.classList.toggle("hot", !!txt);
    if(txt){ tip.hidden = false; tip.textContent = txt; var r = el.getBoundingClientRect(); tip.style.left = (e.clientX - r.left + 14) + "px"; tip.style.top = (e.clientY - r.top + 10) + "px"; }
    else tip.hidden = true;
  }
  function onUp(e){
    var d = drag; drag = null; if(!d || d.moved > 5) return;
    if(d.rig && rigOn() && rig.mode === "map"){ if(d.button === 0) mapClick(e); return; }
    if(d.rig && d.button !== 0) return;                                 // a right click only orbits
    var h = pick(e, hitList());
    var o = h && h.object.userData;
    if(o && o.desk){ api.openSession(o.desk.id); return; }
    if(o && o.project){ inst.setFilter(filter === o.project ? null : o.project); api.onFilter(filter); return; }
    if(o && o.door){ walkTo = {x: o.door.front.x, z: o.door.front.z}; walkDoor = o.door; return; }
    var f = pick(e, [].concat(cur.floor)), b = cur.bounds;
    if(f){ walkTo = {x: E.clamp(f.point.x, b[0] + 1, b[1] - 1), z: E.clamp(f.point.z, b[2] + 1, b[3] - 1)}; walkDoor = null; }
  }
  // the browser menu stays away only while right-drag orbits (chase family)
  function onContext(e){ if(rigOn() && CHASE[rig.mode]) e.preventDefault(); }
  function hitList(){ return cur === worlds.mission ? clickables.concat(doorHits, projHits) : (cur.hits || []); }
  // Through a door: another view of the page, or another floor of the building ("@lobby").
  function through(d){
    if(!d.view){ if(d.kind === "townhall" && cur && cur.townHall) cur.townHall(); return; }   // games/hqcivic.js: the town hall
    if(d.view.charAt(0) === "@") enterWorld(d.view.slice(1), cur.name);
    else if(d.view.indexOf("visit:") === 0){ if(api.visit) api.visit(d.view.slice(6)); }   // someone's HQ on the city street
    else api.go(d.view);
  }
  // "Outside" is Arena City when the page says so (not private, paired), else your own Base.
  function outside(name){ return name === "base" && api.outside && api.outside() === "city" && HQV.hqWorlds.city ? "city" : name; }
  // The generated 3D City is the City unless ?world=old / hq_city_impl = "old", or it failed to load.
  function cityImpl(){ var st = null; try { st = localStorage.getItem("hq_city_impl"); } catch(e){ st = null; } return cityImplOf(location.search, st); }
  function makeWorld(name){
    // the world document changed under a 3D City you are not in: drop it and build a fresh one
    var old = worlds[name];
    if(old && old.stale === true && old !== cur){ delete worlds[name]; if(old.destroy){ try { old.destroy(); } catch(e){} } }
    if(worlds[name]) return worlds[name];
    var build = HQV.hqWorlds[name];
    if(name === "city" && !cityFailed && cityImpl() !== "old" && HQV.hqWorlds.city3d) build = HQV.hqWorlds.city3d;
    if(!build) return null;
    var w = {scene: new THREE.Scene(), name: name};
    tgt = w.scene;
    var got;
    try { got = build(ctx, w) || w; }
    catch(err){ tgt = scene; if(build !== HQV.hqWorlds.city3d) throw err; cityFallback(name, null, err); return makeWorld(name); }
    tgt = scene;
    worlds[name] = got; if(got.setTime) got.setTime(isNight()); if(got.onData) got.onData(sessions);
    return got;
  }
  /* Where you arrive in Arena City. Out of your own door (the Lobby) or back from a visit: at that
     door. Otherwise (Jump to City, the City button, opening the page): where you last stood on the
     street, if that is still a sensible place, near home (within HOME_NEAR m of your door, on an HQ's
     block, not inside anything now built there, the street laid out again meanwhile); else at your door. */
  var lastCity = null, HOME_NEAR = 60;
  function cityAnchor(w){ var a = anchorOf(w, avatar.x, avatar.z); if(a) a.yaw = avatar.yaw; return a; }
  function citySpot(w){
    if(!lastCity || (api.cityReturn && api.cityReturn())) return null;
    var p = anchorAt(w, lastCity), h = w.home;
    if(!p || !h || Math.hypot(p.x - h.x, p.z - h.z) > HOME_NEAR || (w.blocked && w.blocked(p.x, p.z))) return null;
    return {x: p.x, z: p.z, yaw: lastCity.yaw || 0, camYaw: h.camYaw};
  }
  /* Return to HQ (the button over the street, T or Home, the side panel, the command palette): off
     whatever you ride, onto the pavement at your front door facing it, the camera behind you, and
     a fresh garage: every vehicle you parked somewhere back in its bay, parked straight. A short
     fade (none in Calm). Your HQ not on the street (private): your own Base. */
  function returnHome(){
    if(!scene || fading) return false;
    var C = worlds.city;
    if(!C || cur !== C || !C.home){ inst.goWorld("base"); return true; }
    var go = function(){
      dismount(true);
      Object.keys(parked).forEach(function(id){ delete parked[id]; });
      (C.bikes || []).forEach(function(b){ if(b.home){ placeProp(b, b.home.x, b.home.z, b.home.yaw); b.g.visible = true; } });
      var h = C.home;
      avatar.x = h.x; avatar.z = h.z; avatar.yaw = (h.yaw || 0) + PI;     // facing your door
      avatar.vy = 0; avatar.airborne = false; avatar.hop = 0; stopFeet();
      walkTo = null; walkDoor = null; doorsArmed = false; movedHere = false; keys = {};
      if(h.camYaw != null) view.yaw = h.camYaw;
      view.pitch = C.camPitch || view.pitch;
      moveAvatar(0); view.target.copy(view.goal);
      rideUiSync(true);
      if(api.announce) api.announce("Back at your HQ. Your car, motorbike and bicycle are in the garage.");
    };
    if(E.calm()){ go(); return true; }
    fading = true; fadeEl.classList.add("on"); E.sfx("door");
    setTimeout(function(){ go(); fadeEl.classList.remove("on"); setTimeout(function(){ fading = false; }, 260); }, 260);
    return true;
  }
  inst.returnHome = function(){ return returnHome(); };
  // The "Return to HQ" button over the street: shown in Arena City.
  var homeUi = document.createElement("button"); homeUi.type = "button"; homeUi.className = "hq3d-home"; homeUi.hidden = true;
  homeUi.textContent = "🏠 Return to HQ (T)"; homeUi.title = "Back to your front door, your car, motorbike and bicycle back in the garage";
  homeUi.addEventListener("click", function(){ returnHome(); canvas.focus(); }); el.appendChild(homeUi);
  function homeUiSync(){ var on = !!(cur && cur === worlds.city); if(homeUi.hidden === on){ homeUi.hidden = !on; if(on) gamesCss(); } }
  function showLoading(text){ loading.textContent = text; if(!loading.parentNode) el.appendChild(loading); }
  // The 3D City could not load (no world route on this Arena, a timeout): the classic City, under the same name.
  function cityFallback(name, w, err){
    if(!failLogged){ failLogged = true; console.warn("hq3d: the 3D city is not available:", (err && err.message) || err); }
    if(api.announce) api.announce("The 3D city is not available, showing the classic City");
    cityFailed = true;
    if(worlds[name] === w) delete worlds[name];
    if(w && w.destroy){ try { w.destroy(); } catch(e){} }
  }
  // Fade out, move you to the other scene (at the door you came through), fade in. A world with
  // whenReady (the 3D City) is awaited first behind the loading overlay; the world you are in keeps drawing.
  function enterWorld(name, from, instant){
    name = outside(name);
    if(entering === name) return;                                   // already on the way there
    var w = name === "mission" ? worlds.mission : makeWorld(name); if(!w || fading) return;
    if(w.whenReady && !w.isReady){
      entering = name; showLoading("Building the city…");
      var to = 0, settle = function(ok, err){
        // a later enterWorld replaced this one (or this world was dropped): nothing to do here
        if(entering !== name || worlds[name] !== w) return;
        entering = null; clearTimeout(to); loading.remove();
        if(ok) w.isReady = true;
        else if(!cityRetried && /unavailable: timeout/.test((err && err.message) || "")){
          // world.js's deadline is wall-clock: a long first-frame shader compile (cold profile, software GL) can
          // trip it although the doc arrived. Drop this City and build a fresh one, once, before falling back.
          cityRetried = true;
          if(worlds[name] === w) delete worlds[name];
          if(w.destroy){ try { w.destroy(); } catch(e){} }
        }
        else cityFallback(name, w, err);
        enterWorld(name, from, instant);
      };
      to = setTimeout(function(){ settle(false, new Error("timed out")); }, 15000);
      w.whenReady.then(function(){ settle(true); }, function(e){ settle(false, e); });
      return;
    }
    if(entering){ entering = null; loading.remove(); }               // going somewhere else instead
    exitLock();
    var keep = keepRide && instant && ride && ride.heli;
    var go = function(){
      if(!keep) dismount(true);
      rigLeave();
      var prev = cur;
      if(cur && cur === worlds.city && avatar) lastCity = cityAnchor(cur);   // where you were on the street
      if(avatar.g.parent) avatar.g.parent.remove(avatar.g);
      w.scene.add(avatar.g);
      var sp = (w.spawnFrom && (w.spawnFrom[from] || (from === "city" && w.spawnFrom.base))) || (name === "city" && !from && citySpot(w)) || w.spawn;
      avatar.x = sp.x; avatar.z = sp.z; avatar.yaw = sp.yaw || 0; avatar.hop = 0; avatar.airborne = false; walkTo = null; walkDoor = null; stopFeet();
      cur = w; if(w === worlds.mission && missionDirty) refreshMission(); doorsArmed = false; movedHere = false; view.span = w.span || 12; view.zoom = w.zoom || 1.45; view.yaw = sp.camYaw != null ? sp.camYaw : w.camYaw != null ? w.camYaw : PI/4; view.pitch = w.camPitch || 0.62;
      if(keep){ ride.idx = -1; ride.id = null; avatar.hy = ride.heli.y; movedHere = true; }   // flying in: the helicopter is yours now
      moveAvatar(0); view.target.copy(view.goal);
      if(w.camModes) rigEnter(w);
      if(prev && prev !== w && prev.onLeave){ try { prev.onLeave(); } catch(e){} }
      if(w.onEnter){ try { w.onEnter(); } catch(e){} }
      if(api.remember !== false){ try { localStorage.setItem("hq_world", name); } catch(e){} }
      if(api.onWorld) api.onWorld(name);
      if(prev && prev.swapOut && prev !== w && prev.destroy){ try { prev.destroy(); } catch(e){} }   // the island you left
    };
    if(instant || E.calm()){ go(); return; }
    fading = true; fadeEl.classList.add("on"); E.sfx("door");
    setTimeout(function(){ go(); fadeEl.classList.remove("on"); setTimeout(function(){ fading = false; }, 260); }, 260);
  }
  function onWheel(e){
    e.preventDefault(); noteInput();
    if(rigOn() && rig.mode !== "classic"){ HQV.camrig.input(rig, {zoom: e.deltaY}); return; }
    view.zoom = E.clamp(view.zoom*Math.exp(-e.deltaY*0.0012), 0.6, 3.5);
  }
  var MOVE_KEYS = {KeyW: 1, KeyA: 1, KeyS: 1, KeyD: 1, ArrowUp: 1, ArrowDown: 1, ArrowLeft: 1, ArrowRight: 1, ShiftLeft: 1, ShiftRight: 1, Space: 1};
  var SKATE_KEYS = {KeyF: 1, KeyG: 1};                                // tricks, only while on a board
  // the camera keys of a rig world (the page binds R, C, M and V too: these win while HQ is open there)
  var CAM_KEYS = {KeyV: 1, KeyM: 1, KeyP: 1, KeyQ: 1, KeyR: 1, KeyZ: 1, KeyC: 1};
  var HELD_CAM = {KeyQ: 1, KeyR: 1, KeyZ: 1, KeyC: 1};
  function typing(t){ var tag = (t && t.tagName || "").toLowerCase(); return tag === "input" || tag === "textarea" || tag === "select" || (t && t.isContentEditable) || !!(t && t.closest && t.closest(".hqhud-gear, .hqhud-settings")); }
  // E (and a pad's X): get on or off what is near you; in first person also the door under the crosshair.
  function useKey(){
    if(ride || nearBike() >= 0){ rideToggle(); return true; }
    if(rigOn() && rig.mode === "fp" && pose){ var d = doorUnderCrosshair(pose, curDoors(), 3); if(d){ through(d); return true; } }
    // the world's own (games/hqcity3d.js): talk to a resident, a bus stop, a dock, a station
    if(cur && cur.use && avatar && cur.use({x: avatar.x, z: avatar.z, yaw: avatar.yaw})) return true;
    return false;
  }
  // V / Shift+V, M, P, Q / R, Z / C (and Enter in photo mode); only while a rig world (cur.camModes) is up.
  function camKey(e){
    if(!rigOn() || !inst.running || typing(e.target) || e.metaKey || e.ctrlKey || e.altKey) return false;
    var down = e.type === "keydown";
    if(e.code === "Enter" && rig.mode === "photo"){ e.preventDefault(); if(down && !e.repeat) photoShot(); return true; }
    if(!CAM_KEYS[e.code]) return false;
    e.preventDefault();
    if(HELD_CAM[e.code]){ keys[e.code] = down; return true; }
    if(!down || e.repeat) return true;
    if(e.code === "KeyV") camCycle(e.shiftKey ? -1 : 1);
    else if(e.code === "KeyM") mapToggle();
    else if(e.code === "KeyP") photoToggle();
    return true;
  }
  // Capture phase, so walking keys win over the page's single-key shortcuts while HQ is open.
  function onKey(e){
    if(HQV.townHall && HQV.townHall.isOpen && HQV.townHall.isOpen()){ keys = {}; return; }   // the Town Hall has the keys
    if(HQV.hqnavui && HQV.hqnavui.owns && HQV.hqnavui.owns(e)) return;                      // the Go to panel's, the banner's
    if(cur && cur.menuOpen && cur.menuOpen()){ keys = {}; return; }                         // a stop's or a dock's menu too
    if(e.type === "keydown" && inst.running && rigOn() && !typing(e.target)) noteInput();
    if(e.code === "KeyE" && e.type === "keydown" && !e.repeat && inst.running && !typing(e.target) && !e.metaKey && !e.ctrlKey && !e.altKey
       && (ride || nearBike() >= 0 || (rigOn() && rig.mode === "fp") || (cur && cur.use))){ if(useKey()) e.preventDefault(); return; }
    if((e.code === "KeyT" || e.code === "Home") && e.type === "keydown" && !e.repeat && inst.running && cur === worlds.city && !typing(e.target)
       && !e.metaKey && !e.ctrlKey && !e.altKey){ e.preventDefault(); returnHome(); return; }
    if(camKey(e)) return;
    if(!inst.running || typing(e.target) || e.metaKey || e.ctrlKey || e.altKey) return;
    if(!MOVE_KEYS[e.code] && !(SKATE_KEYS[e.code] && ride && ride.kind === "skate")) return;
    keys[e.code] = e.type === "keydown";
    if(e.code.indexOf("Shift") < 0) e.preventDefault();
  }
  function onBlur(){ keys = {}; }

  /* ---------- the loop ---------- */
  function frame(ts){
    raf = 0; if(!inst.running) return;
    raf = requestAnimationFrame(frame);
    // time from the rAF timestamp (the same clock as E.now()), not from when this callback got to run
    var t = (ts > 0 ? ts/1000 : E.now()) - clock0, ms = last ? (t - last)*1000 : 16.7, dt = Math.max(0, Math.min(0.05, last ? t - last : 0)); last = t;
    var k = E.calm() ? 0.25 : 1;
    syncProps();
    padPoll(dt);
    // a pad's stick and A count as keys this frame; on the map, in photo mode and in a cinematic
    // the keys drive the camera (rigFrame), not you
    var kb = keys, kp = withPad();
    keys = rigOn() && (rig.mode === "map" || rig.mode === "photo" || rig.mode === "cine") ? {} : kp;
    moveAvatar(dt);
    if(cur && cur.onBoat) cur.onBoat(ride && ride.boat ? {st: ride.boat, kind: ride.kind, beam: ride.V.beam || 1} : null);   // the City's wake, landings
    if(cur && cur.onHeli) cur.onHeli(ride && ride.heli ? {st: ride.heli, kind: ride.kind} : null);                          // flying on to another island
    nearIdx = ride ? -1 : nearBike();
    rideUiSync(false); homeUiSync();
    keys = kp;
    if(rigOn()) rigFrame(t, dt);
    tripCam();
    keys = kb;
    // the camera keeps up better the faster you go (a car at full speed stays on screen)
    var ease = 1 - Math.exp(-dt*(ride ? 4 + Math.min(6, Math.abs(ride.speed)*0.3) : 4)); view.target.lerp(view.goal, ease);
    resize(); placeCam();
    if(avatar && avatar.ch){
      var skp = ride && ride.kind === "skate" && ride.sk ? ride.sk.pose : null;
      if(skp || avatar.ch._po) poseUndo(avatar.ch);
      avatar.ch.mixer.update(dt); if(avatar.ch.update) avatar.ch.update(t);
      if(ride && ride.kind !== "skate" && avatar.ch.o.parent === ride.lean) ridePose(avatar.ch, ride.B, ride.steer, avatar.g);
      if(skp) poseApply(avatar.ch, skp);                               // Calm: no pose (skp is null)
    }
    placePeers(dt, t);
    fxStep(t, dt); driveHudDraw(t);
    acc.sky += dt; if(acc.sky > 30){ acc.sky = 0; applyTime(); }
    if(cur !== worlds.mission){
      if(rigOn()){ qualityStep(ms); perfLog(ms); }
      if(cur.update){ if(cur.camModes) cur.update(t, dt, k, camInfo()); else cur.update(t, dt, k); }
      renderer.render(cur.scene, curCam());
      smokeFrame();
      return;
    }
    acc.scr += dt; acc.wall += dt;
    if(acc.scr > 0.18){ acc.scr = 0; desks.forEach(function(D){ if(!filter || projectOf(D.s) === filter) drawScreen(D, t); }); drawLeds(); }
    if(acc.wall > 1){ acc.wall = 0; drawWall(t); }
    // the table
    holo.rim.material.emissiveIntensity = (2.6 + Math.sin(t*2)*0.5*k)*(0.8 + combo*0.35);
    var warm = combo - 1; holo.rim.material.emissive.setRGB(0.37 + warm*0.63, 0.83 - warm*0.13, 0.9 - warm*0.62);
    holo.light.intensity = holo.light.userData.base*(0.8 + combo*0.4);
    holo.stripe.t.offset.y = -t*0.25*k;
    var sy = (t*0.45*k) % 1; holo.scan.position.y = 1.15 + sy*3.4; var sr = (2.35 - sy*0.35)/2.2; holo.scan.scale.set(sr, sr, 1); holo.scan.material.opacity = 0.8*(1 - sy);
    var pa = holo.pgeo.attributes.position.array;
    for(var q = 0; q < pa.length; q += 3){ pa[q + 1] += dt*(0.4 + (q % 7)*0.08)*k; if(pa[q + 1] > 4.65) pa[q + 1] = 1.05; }
    holo.pgeo.attributes.position.needsUpdate = true;
    holo.proj.rotation.y = t*0.12*k;
    // crew
    desks.forEach(function(D){
      var st = crewState(D.s);
      if(D.ch) D.ch.mixer.update(dt*k);
      if(D.badge){ if(st === "needs") D.badge.position.y = 2.3 + Math.abs(Math.sin(t*3))*0.3*k; else { var zz = (t*0.5) % 1; D.badge.position.y = 2.2 + zz*0.8*k; D.badge.material.opacity = 1 - zz*0.7; } }
      if(st === "needs") D.strip.material.emissiveIntensity = Math.sin(t*5) > 0 ? 2.6 : 0.6;
      var hop = st === "needs" ? Math.abs(Math.sin(t*5 + D.root.position.x))*0.25 : st === "working" ? Math.abs(Math.sin(t*2.5 + D.root.position.x))*0.06 : 0;
      D.pet.children[0].position.y = 0.4 + hop*k;
    });
    streams.forEach(function(s){ s.dots.forEach(function(d, i){ var u = (t*s.speed*k + i/4) % 1; if(s.dir < 0) u = 1 - u; s.curve.getPoint(u, d.position); d.material.opacity = Math.sin(u*PI); }); });
    renderer.render(scene, cam);
  }

  /* ---------- lifecycle ---------- */
  inst.update = function(list){
    sessions = Array.isArray(list) ? list : [];
    if(!scene) return;
    // Mission Control's desks, table and wall redraw only while you are in it (else on the way back in)
    if(cur === worlds.mission) refreshMission(); else missionDirty = true;
    Object.keys(worlds).forEach(function(k){ if(worlds[k].onData) worlds[k].onData(sessions); });
  };
  // The building's paint/accent/sign changed (customisation): every floor redraws what shows it.
  // Focus combo (×1..×2): the holo-table glows brighter and warms from cyan to amber.
  var combo = 1, missionDirty = false;
  function refreshMission(){ missionDirty = false; layoutDesks(); buildStreamsIfChanged(); buildProjects(); drawWall(E.now() - clock0); }
  inst.setCombo = function(m){ combo = E.clamp(+m || 1, 1, 2); };
  inst.lookChanged = function(){ if(avatar) nameTag(); Object.keys(worlds).forEach(function(k){ if(worlds[k].onLook) worlds[k].onLook(); }); };
  // The list of open HQs changed: the city street rebuilds.
  inst.cityChanged = function(){
    if(!worlds.city || !worlds.city.onCity) return;
    var C = worlds.city, here = cur === C && avatar ? anchorOf(C, avatar.x, avatar.z) : null;
    var pk = {}; Object.keys(parked).forEach(function(id){ var p = parked[id]; pk[id] = anchorOf(C, p.x, p.z); });
    C.onCity();
    // someone opened or closed their HQ and the blocks moved: you, and anything you parked, move
    // with the block you were on (else you could be standing inside what is built there now)
    if(here){ var w = anchorAt(C, here); if(w){ var dx = w.x - avatar.x, dz = w.z - avatar.z; avatar.x = w.x; avatar.z = w.z; view.target.x += dx; view.target.z += dz; } }
    Object.keys(pk).forEach(function(id){ var w2 = pk[id] && anchorAt(C, pk[id]); if(w2){ parked[id].x = w2.x; parked[id].z = w2.z; } });
    propsSeen = null;
    // the street filled in after you arrived and you have not moved yet: stand at your door
    if(cur === worlds.city && !movedHere && cur.spawn){ avatar.x = cur.spawn.x; avatar.z = cur.spawn.z; avatar.yaw = cur.spawn.yaw || 0; stopFeet(); if(cur.spawn.camYaw != null) view.yaw = cur.spawn.camYaw; moveAvatar(0); view.target.copy(view.goal); }
    if(hud && cur === worlds.city && cur.mapInfo) hud.setLabels(cur.mapInfo());     // the map's HQ names
  };
  /* ---------- other people in this HQ (live, from the Arena) ---------- */
  // inst.setPeers([{u, n, w, x, z, r, a, h?, p?}]): x/z in cm, r in degrees, a 0 idle / 1 walk / 2 run;
  // h (feet height, cm) and p (pitch, degrees) from a presence v2 Arena ("alt") in the 3D city.
  // Each shows on its floor as a Kenney character with a name tag, eased toward where it was last seen.
  var peers = {};
  inst.setPeers = function(list){
    if(!THREE) return;
    lastPeers = list || [];
    if(SMOKE && SMOKE.peer) list = lastPeers.concat([SMOKE.peer]);          // ?hqsmoke=1: one synthetic friend
    var seen = {};
    (list || []).forEach(function(p){
      if(!p || typeof p.u !== "string") return;
      seen[p.u] = 1;
      var P = peers[p.u];
      if(!P){
        P = peers[p.u] = {g: new THREE.Group(), ch: null, x: p.x/100, z: p.z/100, yaw: p.r*PI/180, hy: null, pitch: 0};
        P.g.rotation.order = "YXZ";
        var ring = new THREE.Mesh(new THREE.RingGeometry(0.45, 0.55, 32), new THREE.MeshBasicMaterial({color: COL.green, transparent: true, opacity: 0.7, toneMapped: false}));
        ring.rotation.x = -PI/2; ring.position.y = 0.02; P.g.add(ring);
        var tg = label(short(p.n || "Visitor", 14), frameHex(p.f) || HEX.green, 0.5); tg.position.y = 2.3; P.g.add(tg);
      }
      // Their character: made on arrival, and made again when they change it (`c`, the "look" capability).
      var cs = Array.isArray(p.c) ? p.c.join(".") : "";
      if(P.csig !== cs){
        P.csig = cs;
        makeCharacter("peer:" + p.u, function(ch){
          if(peers[p.u] !== P || P.csig !== cs) return;
          if(P.ch && P.ch.o.parent) P.ch.o.parent.remove(P.ch.o);
          P.ch = ch; (P.lean || P.g).add(ch.o);
          if(P.board) standSkater(ch, true); else if(P.bike) seatOn(ch, P.bike);
        }, Array.isArray(p.c) ? p.c : null);
      }
      P.n = p.n; P.th = typeof p.h === "number" ? p.h/100 : null; P.tp = typeof p.p === "number" ? p.p*PI/180 : 0;
      P.w = p.w; P.tx = p.x/100; P.tz = p.z/100; P.tyaw = p.r*PI/180; P.a = p.a | 0; P.k = p.k | 0; P.y = Math.max(0, Math.min(60, p.y | 0));
    });
    Object.keys(peers).forEach(function(u){ if(!seen[u]){ var P = peers[u]; if(P.g.parent) P.g.parent.remove(P.g); delete peers[u]; } });
  };
  // what another player is on, from their presence `a`, and how they sit on it
  var PEER_VEHICLE = {3: "bike", 5: "car", 6: "moto", 7: "heli", 8: "attack"};
  function placePeers(dt, t){
    Object.keys(peers).forEach(function(u){
      // the floor they are on: the 3D city sends "city3d" (w.net), so legacy and 3D clients never mix
      var P = peers[u], here = cur && P.w === (cur.net || cur.name);
      if(!here){ if(P.g.parent) P.g.parent.remove(P.g); return; }
      if(P.g.parent !== cur.scene){ cur.scene.add(P.g); P.x = P.tx; P.z = P.tz; P.yaw = P.tyaw; P.hy = null; P.pitch = P.tp; }
      // their height: the h they send, else the ground under them (0 on flat floors)
      var ty = P.th != null && cur.camModes ? P.th : groundAt(P.tx, P.tz);
      var k = ease(8, dt), jump = Math.hypot(P.tx - P.x, P.tz - P.z, P.hy == null ? 0 : ty - P.hy) > 6;
      P.x = jump ? P.tx : P.x + (P.tx - P.x)*k; P.z = jump ? P.tz : P.z + (P.tz - P.z)*k;
      P.hy = jump || P.hy == null ? ty : P.hy + (ty - P.hy)*k;
      P.pitch = jump ? P.tp : P.pitch + (P.tp - P.pitch)*k;
      P.yaw = E.angLerp(P.yaw, P.tyaw, k);
      P.g.position.set(P.x, P.hy, P.z); P.g.rotation.y = P.yaw; P.g.rotation.x = -P.pitch;
      var skates = P.a === 4;
      // on a board: stood on it side-on, lifted to the height they send, the trick they send played here
      if(skates && !P.board){ if(P.bike){ if(P.ch) P.g.add(P.ch.o); P.g.remove(P.lean); P.bike = null; P.vkind = null; }
        P.lean = new THREE.Group(); P.g.add(P.lean); P.board = boardModel(bikeColor(u)); P.lean.add(P.board.g);
        if(P.ch){ P.lean.add(P.ch.o); standSkater(P.ch, true); } }
      else if(!skates && P.board){ if(P.ch){ poseUndo(P.ch); P.g.add(P.ch.o); standSkater(P.ch, false); } P.g.remove(P.lean); P.board = null; P.lean = null; P.gy = 0; }
      if(P.board){
        if(P.ch && P.ch.o.parent !== P.lean){ P.lean.add(P.ch.o); standSkater(P.ch, true); }
        var K = HQV.hqSkateSim ? HQV.hqSkateSim.K : {}, calm = E.calm(), tk = (t || 0)*1000;
        P.gy = (P.gy || 0) + ((P.y || 0)/10 - (P.gy || 0))*k;           // smoothed: the frame above set y
        P.g.position.y = (cur.camModes && cur.skateBase != null ? cur.skateBase : 0) + P.gy; P.g.rotation.x = 0;
        P.board.deck.rotation.z = !calm && P.k === K.flip ? (tk/450 % 1)*PI*2 : 0;
        P.board.deck.rotation.y = !calm && P.k === K.shove ? (tk/400 % 1)*PI : 0;
        P.lean.rotation.y = !calm && P.k === K.spin ? (tk/840 % 1)*PI*2 : 0;
        P.lean.rotation.x = P.k === K.bail && !calm ? -0.5 : 0;
        P.px = P.x; P.pz = P.z;
        if(P.ch){
          setAnim(P.ch, P.k === K.bail ? "sit" : "idle");
          poseUndo(P.ch); P.ch.mixer.update(dt); if(P.ch.update) P.ch.update(t || 0);
          if(!calm) poseApply(P.ch, skatePoseOf(P.k, (P.y || 0) > 1 && P.k !== K.grind, 0));
        }
        return;
      }
      // on wheels: a bike (3), a car (5) or a motorbike (6), in their colour, them in its seat;
      // or at the controls of a helicopter (7) / an attack helicopter (8), at the height `h` they send
      var vk = PEER_VEHICLE[P.a] || null;
      if(vk && !VEHICLES[vk]) vk = null;                          // no games/hqheli.js here
      if(P.bike && P.vkind !== vk){ if(P.ch){ P.g.add(P.ch.o); seatOn(P.ch, null); } P.g.remove(P.lean); P.bike = null; P.lean = null; P.vkind = null; }
      if(vk && !P.bike){
        P.lean = new THREE.Group(); P.g.add(P.lean); P.vkind = vk; P.steer = 0;
        P.bike = VEHICLES[vk].heli ? HQV.hqheli.model(ctx, vk, bikeColor(u)) : vk === "car" ? carModel(bikeColor(u)) : vk === "moto" ? motoModel(bikeColor(u)) : bikeModel(bikeColor(u));
        P.lean.add(P.bike.g); if(P.ch){ P.lean.add(P.ch.o); seatOn(P.ch, P.bike); }
      }
      if(P.bike){
        if(P.ch && P.ch.o.parent !== P.lean){ P.lean.add(P.ch.o); seatOn(P.ch, P.bike); }   // the character loaded after they got on
        var mv = Math.hypot(P.x - (P.px == null ? P.x : P.px), P.z - (P.pz == null ? P.z : P.pz));
        // how hard they steer, read from how fast they turn (presence carries no steering): the bars,
        // the wheels and their lean into the bend follow it
        var dyaw = P.pyaw == null ? 0 : Math.atan2(Math.sin(P.yaw - P.pyaw), Math.cos(P.yaw - P.pyaw)), v = dt > 0 ? mv/dt : 0;
        var want = !jump && v > 0.5 && dt > 0 ? E.clamp(dyaw/dt/(1.9*Math.min(1, v/2.5)), -1, 1) : 0;
        P.steer += (want - P.steer)*ease(6, dt);
        if(VEHICLES[vk].heli){                       // rotors at flying speed, the strobe blinking, the searchlight at night
          P.hst = P.hst || {rpm: 1, t: 0, ground: false}; P.hst.t += dt || 0;
          HQV.hqheli.animate(P.bike, P.hst, dt, isNight());
        } else (vk === "car" ? carRoll : vk === "moto" ? motoRoll : bikeRoll)(P.bike, jump ? 0 : mv, P.steer);
        var pl = E.calm() || vk === "car" ? 0 : -P.steer*Math.min(1, v/6)*VEHICLES[vk].lean;
        P.lean.rotation.z += (pl - P.lean.rotation.z)*ease(8, dt);
        // their brake lights, when they slow down hard (held a moment, so they do not flicker)
        if(P.pv != null && dt > 0 && (P.pv - v)/dt > 3 && v > 0.5) P.brakeT = 0.4; else P.brakeT = (P.brakeT || 0) - dt;
        P.pv = v; if(P.bike.brake) P.bike.brake(P.brakeT > 0);
      }
      P.px = P.x; P.pz = P.z; P.pyaw = P.yaw;
      if(P.ch){
        setAnim(P.ch, vk ? "idle" : P.a === 2 ? "sprint" : P.a === 1 ? "walk" : "idle"); P.ch.mixer.update(dt); if(P.ch.update) P.ch.update(t || 0);
        if(P.bike && P.ch.o.parent === P.lean) ridePose(P.ch, P.bike, P.steer, P.g);
      }
    });
  }
  // 0 still, 1 walk, 2 run, 3 on a bike (any speed: others draw you riding), 4 on a skateboard,
  // 5 driving a car, 6 on a motorbike (the page sends 5 / 6 only where the Arena lists "drive").
  var RIDE_A = {bike: 3, skate: 4, car: 5, moto: 6};
  // 7 flying a helicopter, 8 an attack helicopter (the page sends them only where the Arena lists "fly").
  // (a boat has no presence animation of its own yet: others see you standing, or walking while it moves)
  inst.moving = function(){ return ride ? (ride.heli ? (ride.kind === "attack" ? 8 : 7) : ride.boat ? (keyMove ? 1 : 0) : RIDE_A[ride.kind] || 3) : keyMove ? (keyRun ? 2 : 1) : 0; };
  // on a board: what others should see you doing ({k, y}); null otherwise
  inst.skate = function(){ return ride && ride.kind === "skate" ? skateNet() : null; };
  inst.riding = function(){ return !!ride; };
  // read-only, for the HUD's tests and tools: what you are driving and how
  inst.drive = function(){ return ride ? {kind: ride.kind, speed: ride.speed, slip: ride.slip, drift: !!ride.drift, gear: ride.gear, rpm: Math.round(ride.rpm)} : null; };

  /* ---------- ?hqsmoke=1: hooks for tools/ui_smoke.py and tools/hq_shots.py (inert otherwise) ---------- */
  function smokeErr(e){
    var m = e && (e.message || (e.reason && (e.reason.message || String(e.reason)))) || String(e);
    try { document.documentElement.dataset.hqSmoke = "error " + m; } catch(x){}
  }
  function smokeStats(){
    var w = cur || {}, s = w.stats ? w.stats() : w.wb && w.wb.stats ? w.wb.stats() : {}, ri = renderer && renderer.info.render;
    // the renderer's own counts of the last frame when the world reports none
    if(ri && s.drawCalls == null) s = Object.assign({drawCalls: ri.calls, triangles: ri.triangles}, s);
    return Object.assign({}, s, {labels: hud && hud.labelCounts ? hud.labelCounts() : null, mode: rig ? rig.mode : "classic",
      cache: HQV.world && typeof HQV.world.cacheMs === "function" ? HQV.world.cacheMs() : null,
      vehicle: ride ? {pitch: ride.pitch || 0, roll: ride.roll || 0} : null, world: w.net || w.name || null});
  }
  // &cam=<mode> once ready; "fp-bonnet" is first person from a car's bonnet
  function smokeCam(m){
    if(!rig || !m) return;
    var C = HQV.camrig;
    if(m === "fp-bonnet"){ C.setMode(rig, "fp", {instant: true}); rig.fpView = "bonnet"; }
    else if(m !== rig.mode) C.setMode(rig, m, {instant: true});
  }
  function smokeTeleport(x, z, yaw){
    dismount(true); placeAvatar(x, z, yaw != null && isFinite(yaw) ? yaw : avatar.yaw);
    if(rig && rig.mode === "map") HQV.camrig.flyMap(rig, x, z, rig.mapSpan);
  }
  // &ride=car|moto|bike|skate: on that vehicle where you stand (not taken from anyone's garage)
  function smokeRide(kind){
    if(!VEHICLES[kind] || (kind === "skate" && !HQV.hqSkateSim)) return;
    dismount(true);
    mountOn({g: new THREE.Group(), x: avatar.x, z: avatar.z, yaw: avatar.yaw, color: 0x3d6fd1, roof: 0x2a3c50, kind: kind}, -1);
  }
  function smokeFrame(){
    var S = SMOKE; if(!S || !S.on || S.done || !cur || cur.name !== "city") return;
    if(!S.applied){
      S.applied = true;
      try {
        // no &at=: your own HQ door (hq_shots' door spot); &yaw= turns you before &ride= mounts
        var door = !S.at && cur.spawnFrom && cur.spawnFrom.lobby;
        if(S.at) smokeTeleport(S.at.x, S.at.z, S.yaw);
        else if(door) smokeTeleport(door.x, door.z, S.yaw != null ? S.yaw : door.yaw);
        else if(S.yaw != null) smokeTeleport(avatar.x, avatar.z, S.yaw);
        if(S.ride) smokeRide(S.ride);
        smokeCam(S.cam);
        if(rig && S.span) HQV.camrig.flyMap(rig, avatar.x, avatar.z, S.span);
        S.peer = {u: "smoke-friend", n: "Friend", w: cur.net || cur.name, x: Math.round((avatar.x + 20)*100), z: Math.round(avatar.z*100), r: 0, a: 0};
        inst.setPeers(lastPeers);
      } catch(e){ smokeErr(e); S.done = true; return; }
    }
    if(++S.frames < 30) return;
    S.done = true;
    try { document.documentElement.dataset.hqSmoke = "ok " + JSON.stringify(smokeStats()); } catch(e){ smokeErr(e); }
  }
  if(SMOKE && SMOKE.on){
    window.HQ3D_DEBUG = {mode: function(m){ smokeCam(m); }, teleport: function(x, z, yaw){ smokeTeleport(+x || 0, +z || 0, yaw == null ? null : +yaw); },
                         ride: function(kind){ smokeRide(kind); }, stats: function(){ return smokeStats(); },
                         // in a helicopter (ride('heli') first): put it in the air at x, y, z, rotor up to speed
                         fly: function(x, y, z, yaw){ var h = ride && ride.heli; if(!h) return false; h.x = +x; h.y = +y; h.z = +z; if(yaw != null) h.yaw = +yaw;
                           h.ground = false; h.rpm = 1; h.vx = h.vy = h.vz = 0; return true; },
                         heli: function(){ var h = ride && ride.heli; return h ? {x: h.x, y: h.y, z: h.z, yaw: h.yaw, speed: h.speed, agl: h.agl, ground: h.ground, rpm: h.rpm} : null; },
                         // the City's navigation (route, minimap, panel), for tools that follow a route
                         nav: function(){ return cur && cur.nav ? cur.nav() : null; },
                         // avatar + camera, for tools that drive the keys and record motion
                         probe: function(){ var c = curCam(); return {x: avatar.x, y: avatar.g.position.y, z: avatar.z, yaw: avatar.yaw, speed: avatar.speed || 0,
                           travelYaw: avatar.travelYaw, turnRate: avatar.rate || 0, heading: rig && rig.moveYaw != null ? rig.moveYaw : null,
                           mode: rig && rig.mode, moveYaw: rig && rig.moveYaw, lookYaw: rig && rig.lookYaw,
                           cam: c ? {x: c.position.x, y: c.position.y, z: c.position.z} : null, t: performance.now()}; }};
  }

  inst._place = function(x, z){ if(avatar){ avatar.x = x; avatar.z = z; } };    // for tests
  // read-only: the scene of the world you stand in (tests and tools traverse it)
  inst.sceneOf = function(){ return cur ? cur.scene : null; };
  // where you are, for presence: the floor (the 3D city is "city3d"), and in it your feet height (m) and pitch (rad)
  inst.where = function(){
    if(!avatar) return null;
    var rigW = !!(cur && cur.camModes);
    return {world: cur && (cur.net || cur.name), x: avatar.x, z: avatar.z, yaw: avatar.yaw,
            h: rigW ? avatar.g.position.y : null, pitch: rigW && ride ? ride.pitch || 0 : 0};
  };
  inst.goWorld = function(name){ name = outside(name); if(scene && cur && cur.name !== name) enterWorld(name, null); };
  // Another island (or back to the Commons): the City is built again for that world (games/hqcity3d.js
  // HQV.hqCity3d.go picks it and where you arrive), behind the loading overlay while the old one draws.
  inst.goCity = function(world, spawn){
    if(!scene || !HQV.hqCity3d || !HQV.hqCity3d.go) return false;
    HQV.hqCity3d.go(world, spawn || null);
    var C = worlds.city;
    if(C){ delete worlds.city; C.swapOut = true; if(C !== cur && C.destroy){ try { C.destroy(); } catch(e){} } }
    lastCity = null; entering = null;
    enterWorld("city", null);
    return true;
  };
  // A voyage's destination, built in its own scene while you are still in this City (its tiles build on their own,
  // its overlays stay hidden until it is the one you are in); swapCity then moves you in without a fade or a
  // loading screen, mid-sea, where both cities are far behind the haze.
  var nextCity = null, keepRide = false;
  function dropNext(){ if(!nextCity) return; var w = nextCity.w; nextCity = null; if(w && w !== cur && w.destroy){ try { w.destroy(); } catch(e){} } }
  inst.prebuildCity = function(world){
    if(!scene || !HQV.hqCity3d || !HQV.hqWorlds.city3d) return false;
    if(nextCity && nextCity.world === world) return true;
    dropNext();
    HQV.hqCity3d.go(world, null);
    var w = {scene: new THREE.Scene(), name: "city"}, got = null;
    tgt = w.scene;
    try { got = HQV.hqWorlds.city3d(ctx, w) || w; } catch(err){ got = null; }
    tgt = scene;
    if(!got) return false;
    if(got.setTime) got.setTime(isNight()); if(got.onData) got.onData(sessions);
    var N = nextCity = {world: world, w: got, ready: false};
    (got.whenReady || Promise.resolve()).then(function(){ if(nextCity === N){ N.ready = true; got.isReady = true; } },
                                              function(){ if(nextCity === N) dropNext(); });
    return true;
  };
  // keep = {dx, dz}: you fly on in the helicopter you are in, moved by the new island's offset (games/hqcity3d.js)
  inst.swapCity = function(world, keep){
    if(!nextCity || nextCity.world !== world || !nextCity.ready || !scene) return false;
    var C = worlds.city;
    if(C){ delete worlds.city; C.swapOut = true; }
    worlds.city = nextCity.w; nextCity = null;
    lastCity = null; entering = null;
    if(keep && ride && ride.heli){ ride.heli.x -= +keep.dx || 0; ride.heli.z -= +keep.dz || 0; keepRide = true; }
    enterWorld("city", null, true);
    keepRide = false;
    return true;
  };
  var streamKey = "";
  function buildStreamsIfChanged(){
    var k = desks.map(function(D){ return D.id + ":" + crewState(D.s); }).join("|");
    if(k !== streamKey){ streamKey = k; buildStreams(); applyFilter(); }
  }
  inst.setFilter = function(p){ filter = p || null; if(scene) applyFilter(); };
  inst.pause = function(){ inst.running = false; keys = {}; exitLock(); if(raf){ cancelAnimationFrame(raf); raf = 0; }
    if(ride && ride.eng){ ride.eng.stop(); ride.eng = null; } };     // (the engine starts again with the next frame you drive)
  inst.resume = function(){
    if(!inst.alive || inst.running || !scene) { if(!scene) inst.wantRun = true; return; }
    inst.running = true; last = 0; applyTime(); raf = requestAnimationFrame(frame);
  };
  inst.destroy = function(){
    inst.alive = false; inst.pause(); driveHud(null); exitLock(); rigLeave(); dropNext();
    window.removeEventListener("keydown", onKey, true); window.removeEventListener("keyup", onKey, true); window.removeEventListener("blur", onBlur);
    window.removeEventListener("gamepadconnected", onPadOn); window.removeEventListener("gamepaddisconnected", onPadOff);
    if(SMOKE && SMOKE.on){ window.removeEventListener("error", smokeErr); window.removeEventListener("unhandledrejection", smokeErr); }
    if(renderer){ renderer.dispose(); }
    el.textContent = "";
  };
  window.addEventListener("keydown", onKey, true); window.addEventListener("keyup", onKey, true); window.addEventListener("blur", onBlur);
  window.addEventListener("gamepadconnected", onPadOn); window.addEventListener("gamepaddisconnected", onPadOff);
  if(SMOKE && SMOKE.on){ window.addEventListener("error", smokeErr); window.addEventListener("unhandledrejection", smokeErr); }

  // Outside is the 3D City: start reading its world (IndexedDB, then the Arena) while three.js loads,
  // a quiet moment; games/world.js hands the same promise to the City when it is built.
  if(api.outside && api.outside() === "city" && cityImpl() !== "old" && HQV.hqWorlds && HQV.hqWorlds.city3d && HQV.world && HQV.world.load){
    try { HQV.world.load({id: HQV.world.COMMONS || "claude-hq@1"}).catch(function(){}); } catch(e){}
  }
  E.lib().then(function(lib){
    if(!inst.alive) return;
    L = lib; THREE = lib.THREE;
    ray = new THREE.Raycaster(); ptr = new THREE.Vector2();
    renderer = new THREE.WebGLRenderer({canvas: canvas, antialias: true});
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.5));
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.shadowMap.enabled = true; renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    renderer.toneMapping = THREE.ACESFilmicToneMapping; renderer.toneMappingExposure = 1.05;
    scene = new THREE.Scene(); tgt = scene;
    cam = new THREE.OrthographicCamera(-10, 10, 10, -10, 0.1, 500);
    pcam = new THREE.PerspectiveCamera(65, 1, 0.3, 3000);           // the 3D City's rig modes (Classic keeps `cam`)
    frustum = new THREE.Frustum(); projM = new THREE.Matrix4(); projV = new THREE.Vector3();
    view.target = new THREE.Vector3(0, 1.4, 1); view.goal = view.target.clone();
    var gc = document.createElement("canvas"); gc.width = gc.height = 128; var gg = gc.getContext("2d");
    var rg = gg.createRadialGradient(64, 64, 0, 64, 64, 64); rg.addColorStop(0, "rgba(255,255,255,1)"); rg.addColorStop(0.22, "rgba(255,255,255,.55)"); rg.addColorStop(0.6, "rgba(255,255,255,.12)"); rg.addColorStop(1, "rgba(255,255,255,0)");
    gg.fillStyle = rg; gg.fillRect(0, 0, 128, 128); tex.glow = new THREE.CanvasTexture(gc);
    buildRoom(); buildHolo(); buildAvatar();
    worlds.mission = cur = {scene: scene, name: "mission", span: 12, floor: inst.floor, bounds: [-ROOM, ROOM, -ROOM, ROOM],
      spawn: {x: 3, z: 9, yaw: PI}, spawnFrom: {lobby: {x: -12.6, z: 13.5, yaw: PI/2}}};
    // Mission Control's desks first: the 3D City starts reading its world from IndexedDB in enterWorld,
    // and a long task right after that read would hold up its answer (the < 100 ms cache gate)
    inst.update(sessions);
    drawLeds();
    enterWorld(HQV.hqWorlds[api.startWorld] || api.startWorld === "mission" ? api.startWorld : "mission", null, true);
    canvas.addEventListener("pointerdown", onDown); canvas.addEventListener("pointermove", onMove); canvas.addEventListener("pointerup", onUp);
    canvas.addEventListener("pointerleave", function(){ tip.hidden = true; });
    canvas.addEventListener("wheel", onWheel, {passive: false});
    canvas.addEventListener("contextmenu", onContext);
    if(!entering) loading.remove();                                  // (else it stays up until the City is ready)
    if(inst.wantRun){ inst.wantRun = false; inst.resume(); }
  }).catch(function(e){ loading.textContent = "The 3D HQ couldn’t load: " + (e && e.message || e); });
  return inst;
}

HQV.hq3d = {mount: mount, crewState: crewState, projectOf: projectOf, titleOf: titleOf,
            padToInput: padToInput, doorUnderCrosshair: doorUnderCrosshair, shotName: shotName};
})();
