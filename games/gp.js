/* Valley: Grand Prix (HQ 3.17, docs/plans/grand-prix-spec.md). Every F1 circuit at its true size, the 2026 grid's
 * eleven cars, time trials against your best lap's ghost.
 *
 * Built on Valley Rally's car physics (games/rally/physics.js) and scene (games/rally/scene.js): a circuit from
 * games/gp/circuits.json becomes a rally-shaped stage (games/gp/circuit.js, HQV.gpCircuit), closed into a loop with
 * kerbs, walls, grandstands and the start gantry; the cars are the catalogue's car.formula.2000 class
 * (games/vehicles/catalogue.json), all on the same spec, painted in their liveries.
 *
 * Solo only: nothing leaves this machine. Bests, sector bests and a few ghosts live in the Valley save (api.save.gp).
 *   HQV.gpLaunch({circuit, vehicle, start}) opens the game with that circuit and car picked (the City's Grand Prix
 *   Circuit venue calls it); start defaults to true when a circuit is given.
 */
(function(){
"use strict";
var HQV = window.HQV; if(!HQV || !HQV.api || !HQV.engine) return;
var E = HQV.engine, api = HQV.api;
var now = E.now, clamp = E.clamp, calm = E.calm, say = E.say, tokens = E.tokens, hasWebGL2 = E.hasWebGL2;

var LIBS = null, CAT = null, PENDING = null, CUR = null;
// games/rally/physics.js, games/rally/scene.js and games/gp/circuit.js, loaded once, in order
function loadLibs(){
  if(LIBS) return LIBS;
  LIBS = [["/games/rally/physics.js", function(){ return HQV.rallyPhysics; }], ["/games/rally/scene.js", function(){ return HQV.rallyScene; }],
          ["/games/gp/circuit.js", function(){ return HQV.gpCircuit; }]].reduce(function(p, e){
    return p.then(function(){
      if(e[1]()) return null;
      return new Promise(function(res, rej){
        var s = document.createElement("script"); s.src = e[0]; s.async = false;
        s.onload = res; s.onerror = function(){ rej(new Error(e[0] + " failed to load")); };
        document.head.appendChild(s);
      });
    });
  }, Promise.resolve()).catch(function(e){ LIBS = null; throw e; });
  return LIBS;
}
// the eleven cars: the catalogue's Formula 1 class, by slot
function loadGrid(){
  if(CAT) return CAT;
  CAT = fetch("/games/vehicles/catalogue.json").then(function(r){ if(!r.ok) throw new Error("catalogue " + r.status); return r.json(); }).then(function(cat){
    var cls = (cat.classes || []).filter(function(c){ return c && c.type === "formula"; })[0];
    return (cat.vehicles || []).filter(function(v){ return cls && v && v.class === cls.id && typeof v.slot === "number"; })
      .sort(function(a, b){ return a.slot - b.slot; });
  }).catch(function(e){ CAT = null; throw e; });
  return CAT;
}

/* ---------- formatting ---------- */
function fmtMs(ms){
  if(ms == null || !isFinite(ms)) return "–";
  ms = Math.max(0, Math.round(ms)); var m = Math.floor(ms/60000), s = Math.floor((ms % 60000)/1000), r = ms % 1000;
  return m + ":" + (s < 10 ? "0" : "") + s + "." + ("00" + r).slice(-3);
}
function fmtSec(ms){ if(ms == null || !isFinite(ms)) return "–"; return (Math.max(0, ms)/1000).toFixed(3); }
function fmtDelta(ms){ if(ms == null || !isFinite(ms)) return ""; var a = Math.abs(ms)/1000; return (ms < 0 ? "−" : "+") + a.toFixed(3); }
function metres(n){ return (n|0).toLocaleString() + " m"; }

/* ---------- the save: api.save.gp ---------- */
function gsave(){
  var s = api.save; if(!s) return {best: {}, sectors: {}, sbest: {}, ghosts: {}};
  if(!s.gp || typeof s.gp !== "object" || Array.isArray(s.gp)) s.gp = {};
  var r = s.gp;
  ["best", "sectors", "sbest", "ghosts"].forEach(function(k){ if(!r[k] || typeof r[k] !== "object" || Array.isArray(r[k])) r[k] = {}; });
  return r;
}
function opt(name, fb){ var r = gsave(); return r[name] != null ? r[name] : fb; }
function setOpt(name, v){ gsave()[name] = v; api.persist(); }
var GFX = ["auto", "high", "medium", "low"];
function gfxMode(){ var g = opt("gfx", null); return GFX.indexOf(g) >= 0 ? g : "auto"; }

/* ---------- ghosts: ~10 Hz samples packed into a short string (the rally's format) ---------- */
var B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_", B64I = {};
for(var bi = 0; bi < 64; bi++) B64I[B64.charAt(bi)] = bi;
var GHOST_HZ = 10, GHOST_MAX = 4, GHOST_MAX_CHARS = 26000;
function ghostRecorder(x, y, z){
  var R = {x0: Math.round(x*10), y0: Math.round(y*10), z0: Math.round(z*10), lx: 0, ly: 0, lz: 0, out: []};
  R.lx = R.x0; R.ly = R.y0; R.lz = R.z0;
  R.push = function(x, y, z, yaw, pitch, roll){
    var qx = Math.round(x*10), qy = Math.round(y*10), qz = Math.round(z*10);
    var dx = clamp(qx - R.lx, -2047, 2047), dz = clamp(qz - R.lz, -2047, 2047), dy = clamp(qy - R.ly, -31, 31);
    R.lx += dx; R.lz += dz; R.ly += dy;
    var yw = Math.round(((yaw % (Math.PI*2)) + Math.PI*2)/(Math.PI*2)*4096) & 4095;
    var pt = clamp(Math.round(pitch/(Math.PI/2)*31), -31, 31) + 32, rl = clamp(Math.round(roll/(Math.PI/2)*31), -31, 31) + 32;
    var a = dx + 2048, b = dz + 2048;
    R.out.push(B64.charAt(a >> 6) + B64.charAt(a & 63) + B64.charAt(b >> 6) + B64.charAt(b & 63) + B64.charAt(dy + 32) +
               B64.charAt(yw >> 6) + B64.charAt(yw & 63) + B64.charAt(pt & 63) + B64.charAt(rl & 63));
  };
  R.pack = function(ms, car){ return {v: 1, hz: GHOST_HZ, x: R.x0, y: R.y0, z: R.z0, ms: Math.round(ms), car: car || null, d: R.out.join("")}; };
  return R;
}
function ghostDecode(g){
  if(!g || typeof g !== "object" || typeof g.d !== "string" || g.d.length % 9) return null;
  var x = g.x|0, y = g.y|0, z = g.z|0, out = [];
  for(var i = 0; i < g.d.length; i += 9){
    var c = function(k){ var v = B64I[g.d.charAt(i + k)]; return v == null ? 0 : v; };
    x += ((c(0) << 6) | c(1)) - 2048; z += ((c(2) << 6) | c(3)) - 2048; y += c(4) - 32;
    out.push({x: x/10, y: y/10, z: z/10, yaw: ((c(5) << 6) | c(6))/4096*Math.PI*2, pitch: (c(7) - 32)/31*Math.PI/2, roll: (c(8) - 32)/31*Math.PI/2});
  }
  return {hz: g.hz || GHOST_HZ, ms: g.ms|0, car: typeof g.car === "string" ? g.car : null, s: out};
}

/* ---------- input ---------- */
var GP_BUTTONS = {rset: {keys: ["KeyR"], pad: [3]}, cam: {keys: ["KeyC"], pad: [8]}, esc: {keys: ["Escape", "KeyP"], pad: [9]}, keyshelp: {keys: ["KeyH"], pad: []}};
function padValue(I, i){ var p = I && I.pad, b = p && p.buttons && p.buttons[i]; return b ? (typeof b === "object" ? b.value : +b) : 0; }
function padAxis(I, i){ var p = I && I.pad, v = p && p.axes ? +p.axes[i] || 0 : 0; var D = 0.12; return Math.abs(v) < D ? 0 : (v - (v > 0 ? D : -D))/(1 - D); }
var HUDF = (function(){ try { return (getComputedStyle(document.documentElement).getPropertyValue("--font") || "").trim() || "sans-serif"; } catch(e){ return "sans-serif"; } })();
var LIGHT_STEP = 0.8;                         // s between the start lights; all five lit, then out: go

/* =============================== the game view =============================== */
function makeGame(host){
  var P = null, C = null;                    // physics, circuits (after loadLibs)
  var V = {alive: true, paused: false, phase: "menu", note: "", doc: null, grid: [], stage: null, info: null, car: null, handle: null, ghost: null, T: null,
    vehicle: null, laps: clamp(opt("laps", 3)|0, 1, 5), raceT: 0, goAt: null, lightsAt: null, done: false, lapList: [], sessBest: null, sessSec: [null, null, null],
    cam: clamp(opt("cam", 0)|0, 0, 2), units: opt("units", "kmh") === "mph" ? "mph" : "kmh", assist: opt("assist", true) !== false, gfx: gfxMode(), low: false,
    fps: 60, frames: 0, thr: 0, brk: 0, padSeen: 0, lastDev: "kb", rec: null, recT: 0, hint: -1, slick: 0, flashUntil: 0, quality: null, pick: null};

  var root = api.mk("div", "vg-golf vg-rally vg-gp"), menu = api.mk("div", "vg-golf-menu vg-rally-menu vg-gp-menu"), stageBox = api.mk("div", "vg-golf-stage hidden");
  root.appendChild(menu); root.appendChild(stageBox); host.appendChild(root);
  var wrap = api.mk("div", "vg-golf-view vg-rally-view vg-gp-view");
  var hudTop = api.mk("div", "vg-rally-top"), slab = api.mk("div", "vg-rally-slab"), hudTime = api.mk("b", "vg-rally-time", "0:00.000"), hudLap = api.mk("span", "vg-rally-gate", "LAP 1 OF 3");
  var hudDelta = api.mk("span", "vg-gp-delta", ""), splitBox = api.mk("div", "vg-rally-split hidden");
  slab.appendChild(hudTime); slab.appendChild(hudLap); slab.appendChild(hudDelta);
  hudTop.appendChild(slab); hudTop.appendChild(splitBox);
  var map = api.mk("canvas", "vg-gp-map"), hudBL = api.mk("div", "vg-rally-bl"), hudLast = api.mk("b", "vg-rally-dist", ""), bars = api.mk("canvas", "vg-rally-bars");
  hudBL.appendChild(hudLast); hudBL.appendChild(bars);
  var gauge = api.mk("canvas", "vg-rally-gauge"), cdBox = api.mk("div", "vg-kart-cd vg-rally-cd hidden"), cardBox = api.mk("div", "vg-golf-card vg-rally-card hidden");
  cardBox.setAttribute("role", "dialog"); cardBox.setAttribute("aria-label", "Session results");
  var pauseBox = api.mk("div", "vg-rally-pause hidden"); pauseBox.setAttribute("role", "dialog"); pauseBox.setAttribute("aria-label", "Paused");
  pauseBox.addEventListener("keydown", function(e){ if(e.key === "Escape"){ e.preventDefault(); e.stopPropagation(); togglePause(false); } });
  var load = api.mk("div", "vg-meter vg-golf-load hidden"), loadFill = api.mk("i"); load.appendChild(loadFill);
  [hudTop, hudBL, gauge, map, cdBox, load].forEach(function(n){ n.setAttribute("aria-hidden", "true"); });
  var live = api.mk("p", "sr-only"); live.setAttribute("aria-live", "polite");
  var hint = api.mk("p", "vg-golf-hint"), tools = api.mk("div", "vg-row vg-golf-tools"), keysBox = api.mk("div", "vg-golf-keys");
  stageBox.appendChild(wrap); stageBox.appendChild(hint); stageBox.appendChild(tools); stageBox.appendChild(keysBox); stageBox.appendChild(live);
  var KEYS = [["W / ↑ / RT", "throttle"], ["S / ↓ / LT", "brake, then reverse"], ["A D / ← → / stick", "steer"], ["R / Y", "back on the track (the lap won't count)"],
              ["C / View", "camera"], ["Esc / Start", "pause"], ["H", "hide these keys"]];
  function renderKeys(){
    keysBox.textContent = "";
    if(opt("keysHidden", false)){ keysBox.appendChild(api.mk("span", "vg-muted", "Keys hidden — press H to show them")); return; }
    KEYS.forEach(function(r){ var it = api.mk("span", "vg-golf-key"); it.appendChild(api.mk("kbd", null, r[0])); it.appendChild(document.createTextNode(" " + r[1])); keysBox.appendChild(it); });
  }
  var canvas = null, R3 = null, R2 = null, IN = null, raf = 0, lastT = 0, ro = null, TOK = tokens(), tokAt = 0, eng = null, skid = null;

  /* ---------- menu ---------- */
  function vehicleById(id){ for(var i = 0; i < V.grid.length; i++) if(V.grid[i].id === id) return V.grid[i]; return null; }
  function myVehicle(){ return vehicleById(V.pick && V.pick.vehicle) || vehicleById(opt("car", "")) || V.grid[0] || null; }
  function liverySwatch(v){
    var sw = api.mk("span", "vg-gp-livery"), lv = v.livery || {}; sw.setAttribute("aria-hidden", "true");
    [lv.base, lv.accent, lv.trim].forEach(function(c){ var i = api.mk("i"); if(/^#[0-9a-f]{6}$/i.test(c || "")) i.style.background = c; sw.appendChild(i); });
    return sw;
  }
  function circuitCard(c){
    var card = api.mk("button", "vg-card vg-golf-course vg-gp-circuit"); card.type = "button";
    var ic = api.mk("span", "vg-card-ic", c.round != null ? String(c.round) : "🏁"); ic.setAttribute("aria-hidden", "true"); card.appendChild(ic);
    var tt = api.mk("span", "vg-card-t"), best = gsave().best[c.id];
    tt.appendChild(api.mk("b", null, (c.round != null ? "Round " + c.round + " · " : "") + c.name));
    tt.appendChild(api.mk("span", null, (c.location ? c.location + " · " : "") + metres(c.lengthM) + (best ? " · best " + fmtMs(best) : "")));
    card.appendChild(tt);
    card.addEventListener("click", function(){ startSolo(c.id); });
    return card;
  }
  function renderMenu(){
    if(!V.alive) return;
    menu.textContent = "";
    if(!C || !V.doc){ menu.appendChild(api.mk("p", "vg-muted", V.note || "Loading the circuits…")); return; }
    menu.appendChild(api.mk("p", "vg-muted", "Every Formula 1 circuit at its real length, from Melbourne to Abu Dhabi, and the 2026 grid's eleven cars. Time trials against your best lap's ghost: three sectors, track limits, nothing leaves this machine."));
    var top = api.mk("div", "vg-row");
    top.appendChild(api.btn("Settings", "", function(){ settingsDialog(menu); }));
    var ls = api.mk("label", "vg-row vg-gp-laps"), lsel = api.mk("select", "vg-select"); lsel.setAttribute("aria-label", "Laps");
    [1, 3, 5].forEach(function(n){ var o = api.mk("option", null, n + (n === 1 ? " lap" : " laps")); o.value = String(n); if(n === V.laps) o.selected = true; lsel.appendChild(o); });
    lsel.addEventListener("change", function(){ V.laps = clamp(+lsel.value|0, 1, 5); setOpt("laps", V.laps); });
    ls.appendChild(api.mk("span", "vg-muted", "Session")); ls.appendChild(lsel); top.appendChild(ls);
    menu.appendChild(top);
    // the car
    menu.appendChild(api.mk("h4", "vg-golf-h", "Your car"));
    var cars = api.mk("div", "vg-golf-chars vg-rally-cars vg-gp-cars"); cars.setAttribute("role", "group"); cars.setAttribute("aria-label", "Pick a car");
    var mine = myVehicle();
    if(!V.grid.length) cars.appendChild(api.mk("p", "vg-muted", "The Formula 1 grid isn't in this catalogue yet."));
    V.grid.forEach(function(v){
      var on = mine && v.id === mine.id;
      var b = api.btn("", "vg-golf-char vg-rally-car" + (on ? " on" : ""), function(){ V.pick = {vehicle: v.id}; setOpt("car", v.id); renderMenu(); });
      b.appendChild(liverySwatch(v));
      var t = api.mk("span", "vg-rally-carname"); t.appendChild(api.mk("b", null, v.brand)); t.appendChild(api.mk("small", null, v.model + " · " + v.year));
      b.appendChild(t); b.setAttribute("aria-pressed", on ? "true" : "false");
      cars.appendChild(b);
    });
    menu.appendChild(cars);
    // the circuits: the calendar, then the classics
    var all = C.list(V.doc), cal = all.filter(function(c){ return c.round != null; }), old = all.filter(function(c){ return c.round == null; });
    [[cal, (V.doc.calendar || "") + " calendar"], [old, "Classics"]].forEach(function(gr){
      if(!gr[0].length) return;
      menu.appendChild(api.mk("h4", "vg-golf-h", gr[1]));
      var grid = api.mk("div", "vg-golf-courses vg-gp-circuits");
      gr[0].forEach(function(c){ grid.appendChild(circuitCard(c)); });
      menu.appendChild(grid);
    });
    menu.appendChild(api.mk("p", "vg-muted vg-gp-credit", "Circuit lines: bacinger/f1-circuits (MIT). Team and car names belong to their owners; the liveries here are plain team colours."));
  }
  function tcMode(){ var m = opt("tc", "auto"); return m === "on" || m === "off" ? m : "auto"; }
  function tcWanted(){ var m = tcMode(); return m === "on" || (m === "auto" && V.lastDev !== "pad"); }
  function settingsDialog(where){
    var box = api.mk("div", "vg-rally-settings"); box.setAttribute("role", "group"); box.setAttribute("aria-label", "Grand Prix settings");
    function check(label, val, fn){
      var l = api.mk("label", "vg-golf-check"), cb = api.mk("input"); cb.type = "checkbox"; cb.checked = val;
      cb.addEventListener("change", function(){ fn(cb.checked); });
      l.appendChild(cb); l.appendChild(document.createTextNode(" " + label)); box.appendChild(l); return cb;
    }
    check("Stability assist (recommended on a keyboard)", V.assist, function(v){ V.assist = v; setOpt("assist", v); if(V.car) V.car.assist = v; });
    var tr = api.mk("label", "vg-row"), ts = api.mk("select", "vg-select"); ts.setAttribute("aria-label", "Traction control");
    [["auto", "Auto: on with keys, off with a gamepad"], ["on", "On"], ["off", "Off"]].forEach(function(o){ var op = api.mk("option", null, o[1]); op.value = o[0]; if(o[0] === tcMode()) op.selected = true; ts.appendChild(op); });
    ts.addEventListener("change", function(){ setOpt("tc", ts.value); });
    tr.appendChild(api.mk("span", "vg-muted", "Traction control")); tr.appendChild(ts); box.appendChild(tr);
    check("Speed in mph", V.units === "mph", function(v){ V.units = v ? "mph" : "kmh"; setOpt("units", V.units); });
    check("Show my best lap's ghost", opt("ghost", true) !== false, function(v){ setOpt("ghost", v); if(V.ghost && V.ghost.handle) V.ghost.handle.g.visible = v; });
    var gr = api.mk("label", "vg-row"), gs = api.mk("select", "vg-select"); gs.setAttribute("aria-label", "Graphics quality");
    [["auto", "Auto (by frame rate)"], ["high", "High"], ["medium", "Medium"], ["low", "Low (older laptops)"]].forEach(function(o){ var op = api.mk("option", null, o[1]); op.value = o[0]; if(o[0] === V.gfx) op.selected = true; gs.appendChild(op); });
    gs.addEventListener("change", function(){ V.gfx = gs.value; setOpt("gfx", V.gfx); applyGfx(true); });
    gr.appendChild(api.mk("span", "vg-muted", "Graphics")); gr.appendChild(gs); box.appendChild(gr);
    var cr = api.mk("div", "vg-row"); cr.appendChild(api.mk("span", "vg-muted", "Camera"));
    ["Chase", "Nose", "T-cam"].forEach(function(n, i){ var b = api.btn(n, V.cam === i ? "primary" : "", function(){ V.cam = i; setOpt("cam", i); box.remove(); settingsDialog(where); }); b.setAttribute("aria-pressed", V.cam === i ? "true" : "false"); cr.appendChild(b); });
    box.appendChild(cr);
    var vr = api.mk("label", "vg-row vg-rally-vol"), vi = api.mk("input"); vi.type = "range"; vi.min = "0"; vi.max = "1"; vi.step = "0.05"; vi.value = String(E.sfxVolume());
    vi.setAttribute("aria-label", "Sound volume"); vi.addEventListener("input", function(){ E.sfxSetVolume(+vi.value); });
    vr.appendChild(api.mk("span", "vg-muted", "Sound")); vr.appendChild(vi); box.appendChild(vr);
    box.appendChild(api.btn("Done", "", function(){ box.remove(); }));
    var old = where.querySelector(".vg-rally-settings"); if(old) old.remove();
    where.appendChild(box);
    var f = box.querySelector("input"); if(f) f.focus();
  }

  /* ---------- the session ---------- */
  function showStage(on){ stageBox.classList.toggle("hidden", !on); menu.classList.toggle("hidden", on); if(on){ ensureRenderer(); renderTools(); renderKeys(); } }
  function renderTools(){
    tools.textContent = "";
    tools.appendChild(api.btn("Back to circuits", "", function(){ quitSession(); }));
    tools.appendChild(api.btn("Camera", "", function(){ V.cam = (V.cam + 1) % 3; setOpt("cam", V.cam); if(canvas) canvas.focus(); }));
    tools.appendChild(api.btn("Pause", "", function(){ togglePause(true); }));
  }
  function quitSession(){ resetRun(); showStage(false); renderMenu(); }
  function resetRun(){
    V.phase = "menu"; V.paused = false; pauseBox.classList.add("hidden"); cardBox.classList.add("hidden"); cdBox.classList.add("hidden"); splitBox.classList.add("hidden");
    if(R3){ if(V.handle){ R3.removeCar(V.handle); V.handle = null; } if(V.ghost && V.ghost.handle) R3.removeCar(V.ghost.handle); if(R3.startLights) R3.startLights(0); }
    V.ghost = null; V.car = null; V.rec = null; V.T = null; V.lapList = []; V.done = false;
    if(eng){ eng.stop(); eng = null; } if(skid){ skid.stop(); skid = null; }
  }
  function startSolo(id){
    var c = C && V.doc ? C.find(V.doc, id) : null;
    if(!c){ api.toast("That circuit isn't in this build"); return false; }
    var v = myVehicle(); if(!v){ api.toast("The Formula 1 grid isn't in this catalogue yet"); return false; }
    resetRun();
    V.info = {id: c.id, name: c.name, location: c.location || "", round: c.round, lengthM: c.lengthM|0};
    V.vehicle = v; setOpt("lastCircuit", c.id);
    V.stage = C.build(c, {slick: V.slick});
    beginSession();
    return true;
  }
  function beginSession(){
    var st = V.stage, v = V.vehicle, spec = C.carSpec(v), pole = st.slots[0];
    V.car = P.create(spec, {assist: V.assist, tc: tcWanted()});
    P.place(V.car, pole.x, pole.z, pole.h, st.env);
    V.T = C.tracker(st); V.raceT = 0; V.lapList = []; V.sessBest = null; V.sessSec = [null, null, null]; V.done = false; V.hint = -1; V.thr = V.brk = 0;
    V.lapStartS = 0; V.cur = {lap: 0};
    // the ghost: your best lap here (any car)
    V.ghost = null;
    var g = ghostDecode(gsave().ghosts[st.circuit.id]);
    if(g && g.s.length > 8) V.ghost = {data: g, handle: null, prof: ghostProfile(st, g)};
    showStage(true);
    V.phase = "loading"; load.classList.remove("hidden"); loadFill.style.width = "40%";
    whenRenderer(function(){
      if(!V.alive || !V.stage) return;
      if(R3){
        R3.setStage(st);
        V.handle = R3.addCar(spec, {number: v.slot || 1, body: "formula"});
        if(V.ghost){ var gv = vehicleById(V.ghost.data.car) || v; V.ghost.handle = R3.addCar(C.carSpec(gv), {ghost: true, body: "formula", name: "Best " + fmtMs(V.ghost.data.ms)}); V.ghost.handle.g.visible = false; }
        R3.resetCamera();
        if(R3.startLights) R3.startLights(0);
      }
      load.classList.add("hidden");
      V.phase = "countdown"; V.lightsAt = now() + 0.6; V.goAt = V.lightsAt + LIGHT_STEP*5 + 0.4 + (calm() ? 0 : 0.5);
      hint.textContent = st.name + (st.circuit.location ? " · " + st.circuit.location : "") + " · " + metres(st.lapLength) + " · " + V.laps + (V.laps === 1 ? " lap" : " laps") + " · " + v.brand + " " + v.model;
      say(st.name + ". " + V.laps + (V.laps === 1 ? " lap" : " laps") + " in the " + v.brand + ". Lights out to go.");
      if(canvas) canvas.focus();
    });
  }
  // a ghost's distance-into-the-lap at each sample (for the live delta): monotonic, 0 at the line
  function ghostProfile(st, g){
    var out = [], hint = -1, last = 0, L = st.lapLength;
    g.s.forEach(function(p, i){
      var q = st.locate(p.x, p.z, hint); hint = q.i;
      var sv = q.s; if(i === 0 && sv > L/2) sv -= L;
      if(i > 0 && sv < last - L/2) sv += L;
      last = Math.max(last, sv); out.push(last);
    });
    return out;
  }
  // the ghost's lap time (s) at distance d into the lap, or null
  function ghostTimeAt(prof, hz, d){
    if(!prof || !prof.length || d < prof[0] || d > prof[prof.length - 1]) return null;
    var lo = 0, hi = prof.length - 1;
    while(hi - lo > 1){ var mid = (lo + hi) >> 1; if(prof[mid] <= d) lo = mid; else hi = mid; }
    var span = prof[hi] - prof[lo], u = span > 1e-6 ? (d - prof[lo])/span : 0;
    return (lo + u)/hz;
  }

  /* ---------- driving ---------- */
  function controls(dt){
    var I = IN; if(!I) return {throttle: 0, brake: 0, steer: 0, handbrake: 0};
    var kThr = I.down("up") ? 1 : 0, kBrk = I.down("down") ? 1 : 0, kSteer = (I.down("right") ? 1 : 0) - (I.down("left") ? 1 : 0);
    var pThr = padValue(I, 7), pBrk = padValue(I, 6), pSteer = padAxis(I, 0);
    if(pThr > 0.05 || pBrk > 0.05 || Math.abs(pSteer) > 0.05){ V.padSeen = now(); V.lastDev = "pad"; } else if(kThr || kBrk || kSteer) V.lastDev = "kb";
    var analog = now() - V.padSeen < 1.5 && kSteer === 0;
    V.thr += (kThr - V.thr)*Math.min(1, dt*(kThr > V.thr ? 9 : 14));
    V.brk += (kBrk - V.brk)*Math.min(1, dt*(kBrk > V.brk ? 6 : 14));
    // the steering limiter: a full key or stick is the tightest corner the grip allows at this speed
    var sc = C.steerScale(V.car.spec, V.car.tel.speed, analog);
    return {throttle: Math.max(V.thr, pThr), brake: Math.max(V.brk, pBrk), steer: (analog ? pSteer : clamp(kSteer + pSteer, -1, 1))*sc, handbrake: 0, analog: analog};
  }
  function backOnTrack(){
    var Cc = V.car, st = V.stage; if(!Cc || !st) return;
    var q = st.locate(Cc.p[0], Cc.p[2], V.hint), p = st.pointAtS(q.s - 4);
    P.place(Cc, p.x, p.z, p.h, st.env);
    if(V.T) V.T.reset();
    V.rec = null;
    say("Back on the track. This lap won't count.");
  }
  function update(dt, t){
    if(!V.car || !V.stage) return;
    if(IN) IN.poll();
    if(IN && IN.pressed("keyshelp")){ setOpt("keysHidden", !opt("keysHidden", false)); renderKeys(); }
    if(IN && IN.pressed("cam")){ V.cam = (V.cam + 1) % 3; setOpt("cam", V.cam); }
    if(IN && IN.pressed("esc") && V.phase !== "done") togglePause(!V.paused);
    if(V.paused) return;
    var Cc = V.car, st = V.stage;
    if(V.phase === "countdown"){
      var lit = V.lightsAt != null ? clamp(Math.floor((t - V.lightsAt)/LIGHT_STEP) + 1, 0, 5) : 0;
      if(t >= V.goAt){ lit = 0; V.phase = "race"; V.raceT = 0; cdShow("GO!"); say("Lights out!"); }
      else if(lit !== V.lit && lit > 0){ cdShow(String(lit) + "/5", true); }
      if(lit !== V.lit){ V.lit = lit; if(R3 && R3.startLights) R3.startLights(lit); }
    }
    var racing = V.phase === "race";
    var ctl = racing ? controls(dt) : {throttle: 0, brake: V.phase === "done" ? 0.6 : 0, steer: 0, handbrake: 0, hold: V.phase !== "race" && V.phase !== "done"};
    if(V.auto && racing){ var ap = C.autopilot(st, Cc, V.hint); ctl = ap; }
    if(racing && IN && IN.pressed("rset")) backOnTrack();
    Cc.assist = V.assist; Cc.tc = tcWanted();
    var n = P.advance(Cc, ctl, st.env, dt), sdt = n*P.DT;
    if(racing) V.raceT += sdt;
    if(racing && V.T && n > 0){
      V.T.update(Cc.p[0], Cc.p[2], V.raceT, sdt).forEach(onTrackEvent);
      V.hint = V.T.hint;
    } else if(V.T){ V.hint = st.locate(Cc.p[0], Cc.p[2], V.hint).i; }
    if(Cc.upsideT > 2.5 && racing) backOnTrack();
    // the lap's ghost recording (from the line on)
    if(racing && V.rec){
      V.recT += sdt;
      while(V.recT >= 1/GHOST_HZ){
        V.recT -= 1/GHOST_HZ;
        var M = Cc.M, f = [-M[2], -M[5], -M[8]], r = [M[0], M[3], M[6]];
        V.rec.push(Cc.p[0], Cc.p[1], Cc.p[2], P.headingOf(M), Math.asin(clamp(f[1], -1, 1)), Math.asin(clamp(r[1], -1, 1)));
      }
    }
    audioUpdate(Cc);
    if(cdBox.dataset.until && t > +cdBox.dataset.until){ cdBox.classList.add("hidden"); cdBox.dataset.until = ""; }
    if(V.flashUntil && t > V.flashUntil){ splitBox.classList.add("hidden"); V.flashUntil = 0; }
  }
  function startRec(){ var Cc = V.car; V.rec = ghostRecorder(Cc.p[0], Cc.p[1], Cc.p[2]); V.recT = 0; }
  function onTrackEvent(ev){
    var id = V.stage.circuit.id, sv = gsave();
    if(ev.type === "start"){ startRec(); V.cur = {lap: 1}; announce("Lap 1"); return; }
    if(ev.type === "sector"){
      var sb = (sv.sbest[id] || [])[ev.n - 1], ss = V.sessSec[ev.n - 1], cls = "", note = "";
      if(!V.T.invalid && (sb == null || ev.ms < sb)) cls = " best";
      else if(!V.T.invalid && (ss == null || ev.ms < ss)) cls = " good";
      if(!V.T.invalid && (ss == null || ev.ms < ss)) V.sessSec[ev.n - 1] = ev.ms;
      flash("S" + ev.n, fmtSec(ev.ms), sb != null ? fmtDelta(ev.ms - sb) : "", cls + (V.T.invalid ? " bad" : ""));
      note = "Sector " + ev.n + ", " + fmtSec(ev.ms) + (cls === " best" ? ", your fastest" : cls === " good" ? ", an improvement" : "");
      announce(note);
      return;
    }
    if(ev.type === "lap"){
      V.lapList.push(ev);
      var best = sv.best[id], newBest = false;
      if(ev.valid){
        // the third sector, and the per-sector bests
        if(ev.sectors.length === 3){
          var sbl = Array.isArray(sv.sbest[id]) ? sv.sbest[id].slice() : [null, null, null];
          ev.sectors.forEach(function(ms, i){ if(sbl[i] == null || ms < sbl[i]) sbl[i] = ms; });
          sv.sbest[id] = sbl;
          var s3 = V.sessSec[2]; if(s3 == null || ev.sectors[2] < s3) V.sessSec[2] = ev.sectors[2];
        }
        if(V.sessBest == null || ev.ms < V.sessBest) V.sessBest = ev.ms;
        if(!best || ev.ms < best){
          newBest = true; sv.best[id] = ev.ms; sv.sectors[id] = ev.sectors.slice();
          var gh = V.rec ? V.rec.pack(ev.ms, V.vehicle.id) : null;
          if(gh && gh.d.length <= GHOST_MAX_CHARS){
            gh.at = Date.now(); sv.ghosts[id] = gh;
            var keys = Object.keys(sv.ghosts).sort(function(a, b){ return (sv.ghosts[b].at || 0) - (sv.ghosts[a].at || 0); });
            keys.slice(GHOST_MAX).forEach(function(k){ delete sv.ghosts[k]; });
          }
        }
        api.persist();
      }
      flash("LAP " + ev.n, fmtMs(ev.ms), !ev.valid ? "deleted" : best ? fmtDelta(ev.ms - best) : "", !ev.valid ? " bad" : newBest ? " best" : "");
      announce("Lap " + ev.n + ", " + fmtMs(ev.ms) + (!ev.valid ? ", deleted for track limits" : newBest ? ", a new best" : ""));
      startRec();
      if(ev.n >= V.laps) finishSession();
      else V.cur = {lap: ev.n + 1};
    }
  }
  function announce(t){ live.textContent = t; say(t); }
  function flash(label, val, d, cls){
    splitBox.textContent = "";
    splitBox.appendChild(api.mk("b", null, label)); splitBox.appendChild(api.mk("span", null, val));
    if(d) splitBox.appendChild(api.mk("i", null, d));
    splitBox.className = "vg-rally-split vg-gp-split" + (cls || "");
    V.flashUntil = now() + 3; E.sfx("hit");
  }
  function finishSession(){
    V.phase = "done"; V.done = true; cdShow("🏁");
    if(HQV.story && HQV.story.note) try { HQV.story.note("gp-finish"); } catch(e){}
    showResults();
  }
  function showResults(){
    var id = V.stage.circuit.id, sv = gsave(), best = sv.best[id];
    cardBox.textContent = "";
    var valid = V.lapList.filter(function(l){ return l.valid; });
    cardBox.appendChild(api.mk("b", "vg-rally-big", V.sessBest != null ? fmtMs(V.sessBest) : "No valid lap"));
    cardBox.appendChild(api.mk("p", "vg-muted", V.stage.name + " · your best " + (best ? fmtMs(best) : "–") + " · " + valid.length + " of " + V.lapList.length + " laps valid"));
    var tb = api.mk("table", "vg-golf-table vg-rally-splits"), hr = api.mk("tr");
    ["Lap", "S1", "S2", "S3", "Time"].forEach(function(h){ hr.appendChild(api.mk("th", null, h)); }); tb.appendChild(hr);
    V.lapList.forEach(function(l){
      var tr = api.mk("tr", l.valid ? null : "vg-gp-deleted");
      tr.appendChild(api.mk("td", null, String(l.n)));
      [0, 1, 2].forEach(function(i){ tr.appendChild(api.mk("td", null, fmtSec(l.sectors[i]))); });
      tr.appendChild(api.mk("td", l.valid && l.ms === V.sessBest ? "good" : null, fmtMs(l.ms) + (l.valid ? "" : " ✗")));
      tb.appendChild(tr);
    });
    var tw = api.mk("div", "vg-rally-splitwrap"); tw.appendChild(tb); cardBox.appendChild(tw);
    var row = api.mk("div", "vg-row");
    row.appendChild(api.btn("Drive again", "primary", function(){ startSolo(id); }));
    row.appendChild(api.btn("Circuits", "", function(){ quitSession(); }));
    cardBox.appendChild(row); cardBox.classList.remove("hidden");
    var b = cardBox.querySelector("button"); if(b) b.focus();
    announce("Session over. " + (V.sessBest != null ? "Best lap " + fmtMs(V.sessBest) : "No valid lap") + ".");
  }
  function togglePause(on){
    if(V.phase === "menu" || !V.stage) return;
    V.paused = !!on;
    pauseBox.textContent = ""; pauseBox.classList.toggle("hidden", !on);
    if(!on){ if(canvas) canvas.focus(); return; }
    var box = api.mk("div", "vg-rally-pausebox");
    box.appendChild(api.mk("b", null, "Paused"));
    var row = api.mk("div", "vg-row");
    row.appendChild(api.btn("Resume", "primary", function(){ togglePause(false); }));
    row.appendChild(api.btn("Restart", "", function(){ togglePause(false); startSolo(V.stage.circuit.id); }));
    row.appendChild(api.btn("Quit to circuits", "", function(){ togglePause(false); quitSession(); }));
    box.appendChild(row); settingsDialog(box); pauseBox.appendChild(box);
    var b = box.querySelector("button"); if(b) b.focus();
  }
  function cdShow(t, quiet){ if(!quiet) E.sfx(t === "GO!" ? "go" : "finish"); else E.sfx("count"); cdBox.textContent = t; cdBox.classList.remove("hidden"); cdBox.dataset.until = String(now() + (t === "GO!" ? 1.1 : 0.75)); }

  /* ---------- audio: the V6, tyre scrub ---------- */
  function audioUpdate(Cc){
    if(!Cc) return;
    var kind = E.engines && E.engines.indexOf("v6") >= 0 ? "v6" : E.engines && E.engines.indexOf("four") >= 0 ? "four" : "turbo";
    if(!eng){ eng = E.engineSound(kind); }
    var e = Cc.spec.engine;
    eng.set(900 + clamp((Cc.rpm - e.idle)/(e.limiter - e.idle), 0, 1.05)*6700, {thr: Cc.tel.throttle, gear: Cc.tel.gear, speed: Cc.tel.speed});
    if(E.noiseLoop){
      if(!skid) skid = E.noiseLoop(1400, 2);
      skid.set(Math.min(0.08, Math.max(0, Cc.tel.slip - 1.05)*0.05), 1300);
    }
  }

  /* ---------- HUD ---------- */
  var hudAt = 0, gaugeAt = 0, mapCache = null;
  function curLapTime(){ return V.T && V.T.started ? V.T.lapTime(V.raceT)*1000 : 0; }
  function hudUpdate(){
    if(!V.stage || !V.car) return;
    var ms = V.phase === "done" && V.lapList.length ? V.lapList[V.lapList.length - 1].ms : curLapTime();
    var tt = fmtMs(ms); if(hudTime.textContent !== tt) hudTime.textContent = tt;
    var lt = V.phase === "done" ? "SESSION OVER" : !V.T || !V.T.started ? "OUT LAP" : "LAP " + Math.min(V.laps, V.cur.lap || 1) + " OF " + V.laps + (V.T.invalid ? " · DELETED" : "");
    if(hudLap.textContent !== lt) hudLap.textContent = lt;
    // the live delta to your best lap's ghost, at the same distance into the lap
    var dtext = "", dcls = "vg-gp-delta";
    if(V.ghost && V.T && V.T.started && V.phase === "race"){
      var gt = ghostTimeAt(V.ghost.prof, V.ghost.data.hz, V.T.into());
      if(gt != null){ var d = curLapTime() - gt*1000; dtext = fmtDelta(d); dcls += d <= 0 ? " good" : " bad"; }
    }
    if(hudDelta.textContent !== dtext) hudDelta.textContent = dtext;
    if(hudDelta.className !== dcls) hudDelta.className = dcls;
    var last = V.lapList.length ? V.lapList[V.lapList.length - 1] : null, best = gsave().best[V.stage.circuit.id];
    var lt2 = (last ? "LAST " + fmtMs(last.ms) + (last.valid ? "" : " ✗") : "LAST –") + "  ·  BEST " + (best ? fmtMs(best) : "–");
    if(hudLast.textContent !== lt2) hudLast.textContent = lt2;
  }
  function sizeCanvas(cv, W, H){
    var dpr = Math.min(window.devicePixelRatio || 1, 2);
    if(cv.width !== Math.round(W*dpr) || cv.height !== Math.round(H*dpr)){ cv.width = Math.round(W*dpr); cv.height = Math.round(H*dpr); }
    var g = cv.getContext("2d"); g.setTransform(dpr, 0, 0, dpr, 0, 0); g.clearRect(0, 0, W, H); return g;
  }
  function drawGauge(){
    var Cc = V.car; if(!Cc) return;
    var W = 230, H = 218, g = sizeCanvas(gauge, W, H), T = TOK, tel = Cc.tel;
    var spd = V.units === "mph" ? tel.speed*2.23694 : tel.speed*3.6, e = Cc.spec.engine, rmax = Math.ceil(e.limiter/1000)*1000;
    var cx = 152, cy = 116, r = 50, a0 = Math.PI*0.8, a1 = Math.PI*2.2;
    if(Cc.tc){ g.fillStyle = T.panel; g.globalAlpha = 0.86; g.fillRect(W - 92, 6, 92, 13); g.globalAlpha = 1; g.fillStyle = tel.tc ? T.gold : T.line; g.fillRect(W - 88, 9, 7, 7);
      g.fillStyle = tel.tc ? T.ink : T.muted; g.font = "800 9px " + HUDF; g.textAlign = "left"; g.textBaseline = "middle"; g.fillText("TC", W - 77, 13); }
    g.beginPath(); g.arc(cx, cy, r + 9, a0 - 0.08, a1 + 0.08); g.lineWidth = 6; g.strokeStyle = T.panel; g.globalAlpha = 0.8; g.stroke(); g.globalAlpha = 1;
    var seg = 24;
    for(var k = 0; k < seg; k++){
      var u0 = k/seg, s0 = a0 + (a1 - a0)*u0, s1 = a0 + (a1 - a0)*(k + 0.78)/seg, rpmAt = u0*rmax;
      g.beginPath(); g.arc(cx, cy, r, s0, s1); g.lineWidth = 13;
      var lit = rpmAt <= Cc.rpm, red = rpmAt >= Cc.spec.shiftUp - 600;
      g.strokeStyle = lit ? (red ? T.need : T.brand) : (red ? T.need : T.line); g.globalAlpha = lit ? 1 : 0.55; g.stroke(); g.globalAlpha = 1;
    }
    g.beginPath(); g.arc(cx, cy, r - 12, 0, Math.PI*2); g.fillStyle = T.panel; g.globalAlpha = 0.88; g.fill(); g.globalAlpha = 1;
    var gear = Cc.gear < 0 ? "R" : Cc.shiftT > 0 ? String(Cc.pend > 0 ? Cc.pend : "N") : String(Cc.gear);
    g.fillStyle = T.ink; g.font = "italic 900 40px " + HUDF; g.textAlign = "center"; g.textBaseline = "middle"; g.fillText(gear, cx, cy + 2);
    g.fillStyle = T.muted; g.font = "700 8px " + HUDF; g.fillText("×1000 RPM", cx, cy + 27);
    var sx = 66, sy = 154, sw = W - sx, sh = 62;
    g.fillStyle = T.panel; g.globalAlpha = 0.9; g.fillRect(sx, sy, sw, sh); g.globalAlpha = 1;
    g.fillStyle = T.brand; g.fillRect(sx, sy, sw, 3);
    g.fillStyle = T.ink; g.font = "italic 900 46px " + HUDF; g.textAlign = "right"; g.textBaseline = "alphabetic"; g.fillText(String(Math.round(spd)), W - 44, sy + 52);
    g.fillStyle = T.muted; g.font = "800 10px " + HUDF; g.textAlign = "left"; g.fillText(V.units === "mph" ? "MPH" : "KM/H", W - 40, sy + 52);
  }
  function drawBars(){
    var Cc = V.car; if(!Cc) return;
    var W = 176, H = 50, g = sizeCanvas(bars, W, H), T = TOK, tel = Cc.tel;
    function bar(y, label, v, col, centred){
      g.fillStyle = T.muted; g.font = "800 9px " + HUDF; g.textAlign = "left"; g.textBaseline = "middle"; g.fillText(label, 0, y + 5);
      g.fillStyle = T.line; g.fillRect(48, y, 126, 10); g.fillStyle = col;
      if(centred){ var w = v*63; g.fillRect(111 + Math.min(0, w), y, Math.abs(w), 10); g.fillStyle = T.ink; g.fillRect(110.5, y - 1, 1, 12); }
      else g.fillRect(48, y, 126*clamp(v, 0, 1), 10);
    }
    bar(2, "STEER", clamp(Cc.steerIn, -1, 1), T.ink, true); bar(19, "THROT", tel.throttle, T.good, false); bar(36, "BRAKE", tel.brake, T.need, false);
  }
  // top right: the whole circuit, north up, you and your ghost on it
  function drawMap(){
    var st = V.stage, Cc = V.car; if(!st || !Cc) return;
    var W = 150, H = 150, g = sizeCanvas(map, W, H), T = TOK;
    if(!mapCache || mapCache.st !== st){
      var minX = 1e9, maxX = -1e9, minZ = 1e9, maxZ = -1e9;
      st.pts.forEach(function(p){ minX = Math.min(minX, p.x); maxX = Math.max(maxX, p.x); minZ = Math.min(minZ, p.z); maxZ = Math.max(maxZ, p.z); });
      var sc = Math.min((W - 18)/Math.max(1, maxX - minX), (H - 18)/Math.max(1, maxZ - minZ));
      mapCache = {st: st, sc: sc, ox: W/2 - (minX + maxX)/2*sc, oz: H/2 - (minZ + maxZ)/2*sc};
    }
    var mc = mapCache;
    function X(x){ return mc.ox + x*mc.sc; } function Z(z){ return mc.oz + z*mc.sc; }
    g.fillStyle = T.panel; g.globalAlpha = 0.78; g.fillRect(0, 0, W, H); g.globalAlpha = 1;
    g.beginPath(); st.pts.forEach(function(p, i){ if(i % 4 && i !== st.pts.length - 1) return; if(i) g.lineTo(X(p.x), Z(p.z)); else g.moveTo(X(p.x), Z(p.z)); });
    g.lineJoin = "round"; g.lineWidth = 6; g.strokeStyle = T.line; g.stroke(); g.lineWidth = 2.5; g.strokeStyle = T.ink; g.stroke();
    [st.sectors[0], st.sectors[1], 0].forEach(function(sv, i){ var p = st.pointAtS(sv); g.beginPath(); g.arc(X(p.x), Z(p.z), 3, 0, Math.PI*2); g.fillStyle = i === 2 ? T.gold : T.muted; g.fill(); });
    if(V.ghost && V.ghost.handle && V.ghost.handle.g.visible){ var gp = V.ghost.handle.g.position; g.beginPath(); g.arc(X(gp.x), Z(gp.z), 3.5, 0, Math.PI*2); g.fillStyle = T.muted; g.fill(); }
    g.beginPath(); g.arc(X(Cc.p[0]), Z(Cc.p[2]), 4.5, 0, Math.PI*2); g.fillStyle = T.brand; g.fill(); g.lineWidth = 1.2; g.strokeStyle = T.ink; g.stroke();
  }

  /* ---------- renderer ---------- */
  var renderWait = [];
  function whenRenderer(fn){ if(R3 || R2) fn(); else renderWait.push(fn); }
  function ensureRenderer(){
    if(canvas) return;
    wrap.textContent = "";
    [hudTop, hudBL, gauge, map, cdBox, cardBox, pauseBox, load].forEach(function(n){ wrap.appendChild(n); });
    canvas = api.mk("canvas", "vg-golf-canvas vg-rally-canvas"); canvas.tabIndex = 0;
    canvas.setAttribute("aria-label", "Grand Prix circuit. W or up arrow for throttle, S to brake and reverse, A and D steer, R puts you back on the track, C changes the camera, Escape pauses.");
    wrap.insertBefore(canvas, wrap.firstChild);
    if(IN) IN.destroy();
    IN = HQV.input ? HQV.input.create(canvas, {buttons: GP_BUTTONS}) : null;
    canvas.addEventListener("pointerdown", function(){ canvas.focus(); });
    resize();
    if(hasWebGL2()){
      load.classList.remove("hidden"); loadFill.style.width = "15%";
      E.lib().then(function(lib){
        if(!V.alive) return;
        R3 = HQV.rallyScene.create(lib.THREE, canvas, {quality: V.gfx === "auto" ? "high" : V.gfx});
        V.quality = R3.quality; V.low = V.quality === "low"; perf.auto = {t: 0, n: 0, wait: 2.5};
        resize();
        var w = renderWait; renderWait = []; w.forEach(function(f){ f(); });
      }, function(){
        if(!V.alive) return;
        V.note = "3D unavailable: showing the map view."; api.toast(V.note); R2 = make2d(canvas);
        var w = renderWait; renderWait = []; w.forEach(function(f){ f(); });
      });
    } else R2 = make2d(canvas);
    if(!raf) raf = requestAnimationFrame(frame);
  }
  function resize(){
    if(!canvas) return;
    var w = Math.max(300, wrap.clientWidth || host.clientWidth || 800), h = Math.round(Math.min(w*0.58, (window.innerHeight || 800)*0.74));
    canvas.style.height = h + "px";
    if(R3) R3.size(w, h);
    else if(R2){ var dpr = Math.min(window.devicePixelRatio || 1, 2); canvas.width = Math.round(w*dpr); canvas.height = Math.round(h*dpr); }
  }
  // 2D map view (no WebGL2): north up, centred on the car
  function make2d(cv){
    return {render: function(){
      var g = cv.getContext("2d"), W = cv.width, H = cv.height, T = TOK;
      g.setTransform(1, 0, 0, 1, 0, 0); g.fillStyle = T.bg2; g.fillRect(0, 0, W, H);
      if(!V.stage || !V.car) return;
      var sc = Math.min(W, H)/160, Cc = V.car, st = V.stage;
      g.save(); g.translate(W/2, H/2); g.scale(sc, sc); g.translate(-Cc.p[0], -Cc.p[2]);
      g.beginPath(); st.pts.forEach(function(p, i){ if(i) g.lineTo(p.x, p.z); else g.moveTo(p.x, p.z); });
      g.lineJoin = "round"; g.lineWidth = st.roadHalf*2 + 1; g.strokeStyle = T.line; g.stroke(); g.lineWidth = st.roadHalf*2; g.strokeStyle = T.panel2; g.stroke();
      g.save(); g.translate(Cc.p[0], Cc.p[2]); g.rotate(P.headingOf(Cc.M)); g.fillStyle = T.need; g.fillRect(-0.95, -2.6, 1.9, 5.2); g.restore();
      g.restore();
    }};
  }
  var POSE = {p: [0, 0, 0], q: [0, 0, 0, 1]}, GPOSE = {p: [0, 0, 0], q: [0, 0, 0, 1]};
  function eulerQuat(yaw, pitch, roll, out){
    var x = pitch/2, y = -yaw/2, z = roll/2, c1 = Math.cos(x), c2 = Math.cos(y), c3 = Math.cos(z), s1 = Math.sin(x), s2 = Math.sin(y), s3 = Math.sin(z);
    out[0] = s1*c2*c3 + c1*s2*s3; out[1] = c1*s2*c3 - s1*c2*s3; out[2] = c1*c2*s3 - s1*s2*c3; out[3] = c1*c2*c3 + s1*s2*s3;
    return out;
  }
  var FAKE = {wheels: [{len: 0.1, steer: 0, ang: 0}, {len: 0.1, steer: 0, ang: 0}, {len: 0.1, steer: 0, ang: 0}, {len: 0.1, steer: 0, ang: 0}], tel: {brake: 0}};
  function renderScene(dt){
    var Cc = V.car;
    if(!Cc || !V.stage || !R3 || !R3.stage){ if(R3) R3.renderer.render(R3.scene, R3.camera); return; }
    P.pose(Cc, POSE);
    if(V.handle) R3.poseCar(V.handle, POSE, Cc);
    // the ghost: your best lap, replayed by this lap's time (from the line)
    if(V.ghost && V.ghost.handle){
      var showG = opt("ghost", true) !== false && V.T && V.T.started && (V.phase === "race");
      if(showG){
        var gd = V.ghost.data, f = V.T.lapTime(V.raceT)*gd.hz, i0 = Math.floor(f), u = f - i0;
        if(i0 >= gd.s.length - 1){ showG = false; }
        else {
          var A = gd.s[i0], B = gd.s[i0 + 1], yaw = A.yaw + Math.atan2(Math.sin(B.yaw - A.yaw), Math.cos(B.yaw - A.yaw))*u;
          GPOSE.p[0] = A.x + (B.x - A.x)*u; GPOSE.p[1] = A.y + (B.y - A.y)*u; GPOSE.p[2] = A.z + (B.z - A.z)*u;
          eulerQuat(yaw, A.pitch + (B.pitch - A.pitch)*u, A.roll + (B.roll - A.roll)*u, GPOSE.q);
          var sp = Math.sqrt(Math.pow(B.x - A.x, 2) + Math.pow(B.z - A.z, 2))*gd.hz;
          FAKE.wheels.forEach(function(w){ w.ang = (w.ang + sp*dt/0.36) % (Math.PI*2); w.len = 0.1; w.steer = 0; });
          R3.poseCar(V.ghost.handle, GPOSE, FAKE);
        }
      }
      V.ghost.handle.g.visible = showG;
    }
    R3.fx(Cc, dt, calm(), V.handle);
    R3.render(dt, {mode: V.phase === "done" ? 3 : V.cam, pose: POSE, car: Cc, calm: calm()});
  }
  var perf = {t: 0, n: 0, pr: null, auto: null};
  function applyGfx(user){
    if(!R3) return;
    var q = V.gfx === "auto" ? (user ? "high" : R3.quality) : V.gfx;
    R3.setQuality(q); V.quality = R3.quality; V.low = V.quality === "low"; perf.pr = null; perf.auto = {t: 0, n: 0, wait: 2};
  }
  function autoGfx(dt){
    var A = perf.auto; if(!A || V.gfx !== "auto" || V.paused) return;
    if(A.wait > 0){ A.wait -= dt; return; }
    A.t += dt; A.n++;
    if(A.t < 3) return;
    var fps = A.n/A.t; A.t = 0; A.n = 0;
    var next = fps < 45 ? (R3.quality === "high" ? "medium" : R3.quality === "medium" ? "low" : null) : null;
    if(next){ R3.setQuality(next); V.quality = next; V.low = next === "low"; A.wait = 1.5; } else perf.auto = null;
  }
  function frame(ts){
    if(!V.alive) return;
    raf = requestAnimationFrame(frame);
    var t = ts/1000, dt = lastT ? clamp(t - lastT, 0, 0.1) : 0; lastT = t;
    try {
      if(t - tokAt > 2){ TOK = tokens(); tokAt = t; }
      update(dt, now());
      if(R3) renderScene(dt); else if(R2) R2.render();
      if(t - hudAt > 0.08){ hudAt = t; hudUpdate(); }
      if(R3 && V.car && V.phase !== "menu") autoGfx(dt);
      if(t - gaugeAt > (V.low ? 1/15 : 1/30)){ gaugeAt = t; drawGauge(); drawBars(); drawMap(); }
      V.frames++; perf.n++; perf.t += dt;
      if(perf.t > 2){
        V.fps = perf.n/perf.t; perf.n = 0; perf.t = 0;
        if(R3 && V.fps < 28 && V.car && (V.gfx !== "auto" || V.low)){ perf.pr = Math.max(0.6, (perf.pr || Math.min(window.devicePixelRatio || 1, 1.5)) - 0.2); R3.setPixelRatio(perf.pr); }
      }
    } catch(e){ if(window.console) console.error("gp frame", e); }
  }
  function onResize(){ resize(); }
  window.addEventListener("resize", onResize);
  if(typeof ResizeObserver !== "undefined"){ ro = new ResizeObserver(onResize); ro.observe(host); }
  // a pick from HQV.gpLaunch: the car now, the circuit once everything is loaded
  V.applyPick = function(p){
    p = p || {};
    if(p.vehicle) V.pick = {vehicle: String(p.vehicle)};
    if(p.circuit && p.start !== false){ V.wantStart = String(p.circuit); }
    if(V.ready){ renderMenu(); if(V.wantStart){ var c2 = V.wantStart; V.wantStart = null; startSolo(c2); } }
  };
  renderKeys(); renderMenu();
  Promise.all([loadLibs(), loadGrid()]).then(function(res){
    if(!V.alive) return;
    P = HQV.rallyPhysics; C = HQV.gpCircuit; V.grid = res[1] || [];
    V.slick = C.useSlick(P);
    return C.load().then(function(doc){
      if(!V.alive) return;
      V.doc = doc; V.ready = true; renderMenu();
      if(V.wantStart){ var c3 = V.wantStart; V.wantStart = null; startSolo(c3); }
    });
  }).catch(function(e){ V.note = "Couldn't load Grand Prix: " + (e && e.message || e); renderMenu(); });
  if(!raf) raf = requestAnimationFrame(frame);

  V.destroy = function(){
    V.alive = false;
    if(eng){ eng.stop(); eng = null; } if(skid){ skid.stop(); skid = null; }
    if(raf) cancelAnimationFrame(raf); raf = 0;
    window.removeEventListener("resize", onResize); if(ro) ro.disconnect();
    if(IN){ IN.destroy(); IN = null; }
    if(R3){ R3.dispose(); R3 = null; }
    root.remove();
  };
  // for the browser smoke test
  V.startSolo = function(id){ if(!C || !V.doc) return false; return startSolo(id || C.list(V.doc)[0].id); };
  V.autopilot = function(on){ if(on != null) V.auto = !!on; return V.car && V.stage ? C.autopilot(V.stage, V.car, V.hint) : null; };
  V.debug = function(){ return {phase: V.phase, ready: !!V.ready, circuit: V.stage ? V.stage.circuit.id : null, vehicle: V.vehicle ? V.vehicle.id : null, lap: V.cur ? V.cur.lap : 0,
    laps: V.lapList.map(function(l){ return {n: l.n, ms: l.ms, valid: l.valid}; }), started: !!(V.T && V.T.started), invalid: !!(V.T && V.T.invalid), raceMs: Math.round(V.raceT*1000),
    speed: V.car ? V.car.tel.kmh : 0, fps: V.fps, renderer: R3 ? "3d" : R2 ? "2d" : "", quality: V.quality, info: R3 ? R3.info() : null, grid: V.grid.length}; };
  V.scene = function(){ return R3; };
  return V;
}

/* ---------- registration ---------- */
HQV.register({id: "gp", name: "Grand Prix", icon: "🏎️", desc: "Every F1 circuit and the 2026 grid: time trials against your best lap's ghost",
  badge: function(){ var s = api.save && api.save.gp, n = s && s.best ? Object.keys(s.best).length : 0; return n ? n + " circuit" + (n === 1 ? "" : "s") + " timed" : ""; },
  mount: function(el){ if(CUR) CUR.destroy(); CUR = makeGame(el); if(PENDING){ var p = PENDING; PENDING = null; CUR.applyPick(p); } },
  unmount: function(){ if(CUR){ CUR.destroy(); CUR = null; } },
  pause: function(){ if(CUR) CUR.paused = true; },
  resume: function(){ if(CUR) CUR.paused = false; }});

// The City's Grand Prix Circuit (and anything else) opens the game with a circuit and a car picked.
// {circuit: "mc-1929", vehicle: "f1-ferrari-sf-26", start: true}: ids only; an unknown one is ignored.
HQV.gpLaunch = function(o){
  o = o && typeof o === "object" ? o : {};
  var p = {circuit: /^[a-z]{2}-\d{4}$/.test(String(o.circuit || "")) ? String(o.circuit) : null,
           vehicle: /^[a-z0-9-]{1,48}$/.test(String(o.vehicle || "")) ? String(o.vehicle) : null, start: o.start};
  if(CUR && CUR.alive){ CUR.applyPick(p); return true; }
  PENDING = p;
  api.open("gp");
  // the Valley's shell may still be mounting (HQV.enter runs on the same load): try again for a few seconds
  if(!CUR){ var tries = 0, t = setInterval(function(){ tries++; if(!CUR && PENDING) api.open("gp"); if(CUR || !PENDING || tries > 25) clearInterval(t); }, 200); }
  return true;
};
HQV.gpDebug = function(){ return CUR; };
})();
