/* Valley: one input layer for the real-time 3D games (Kart Racing now; the platformer
 * and arena games reuse it). Keyboard, mouse look under pointer lock, and a gamepad,
 * read as named axes and buttons so a game never deals with raw events:
 *
 *   var I = HQV.input.create(el, {look: false});
 *   each frame: I.poll(); I.axis("x") / I.axis("y") in -1..1; I.down("jump");
 *               I.pressed("jump") (this frame only); I.look() -> {dx, dy} since last call
 *   I.destroy() when the view goes away.
 *   opts.buttons adds named buttons for this one view (e.g. weapon keys), so a key only
 *   one game uses is never taken from the others; I.wheel() -> mouse wheel steps since
 *   the last call (counted while the pointer is locked or over the view).
 *
 * Keys only count while `el` (or something inside it) has focus, so typing anywhere
 * else in HQ is never stolen; a key the game uses is preventDefault()ed so the global
 * shortcuts (R refresh, 1-9 views) leave it alone. Releasing focus or hiding the tab
 * lets go of everything. Nothing here touches the network.
 */
(function(){
"use strict";
var HQV = window.HQV; if(!HQV) return;

// Named buttons -> keys (KeyboardEvent.code, so it works on any layout) and gamepad buttons
// (standard mapping: 0 A, 1 B, 2 X, 3 Y, 4 LB, 5 RB, 6 LT, 7 RT, 8 Back, 9 Start, 12-15 d-pad).
var BUTTONS = {
  up:     {keys: ["KeyW", "ArrowUp"], pad: [12]},
  down:   {keys: ["KeyS", "ArrowDown"], pad: [13]},
  left:   {keys: ["KeyA", "ArrowLeft"], pad: [14]},
  right:  {keys: ["KeyD", "ArrowRight"], pad: [15]},
  jump:   {keys: ["Space"], pad: [0]},
  drift:  {keys: ["ShiftLeft", "ShiftRight"], pad: [1, 5]},
  fire:   {keys: [], pad: [7], mouse: 0},
  aim:    {keys: [], pad: [6], mouse: 2},
  reset:  {keys: ["KeyR"], pad: [3]},
  camera: {keys: ["KeyC"], pad: [8]},
  use:    {keys: ["KeyE", "Enter"], pad: [2]},
  pause:  {keys: ["Escape", "KeyP"], pad: [9]},
  reload: {keys: ["KeyR"], pad: [2]},
  help:   {keys: ["KeyH"], pad: []}
};
var DEAD = 0.18;          // stick dead zone
var LOOK_PAD = 900;       // right stick: pixels-equivalent per second at full tilt

function dz(v){ v = +v || 0; return Math.abs(v) < DEAD ? 0 : (v - (v > 0 ? DEAD : -DEAD))/(1 - DEAD); }
function clamp(v, a, b){ return v < a ? a : v > b ? b : v; }

function create(el, opts){
  opts = opts || {};
  var I = {keys: {}, mouse: {}, pad: null, padDown: {}, was: {}, now: {}, lookX: 0, lookY: 0, locked: false,
           alive: true, lastPoll: 0, sens: +opts.sensitivity || 1};
  var codes = {}, MAP = {};
  Object.keys(BUTTONS).forEach(function(b){ MAP[b] = BUTTONS[b]; });
  Object.keys(opts.buttons || {}).forEach(function(b){ var x = opts.buttons[b] || {};
    MAP[b] = {keys: Array.isArray(x.keys) ? x.keys : [], pad: Array.isArray(x.pad) ? x.pad : [], mouse: x.mouse}; });
  Object.keys(MAP).forEach(function(b){ MAP[b].keys.forEach(function(c){ codes[c] = 1; }); });
  I.wheelN = 0;
  (opts.extraKeys || []).forEach(function(c){ codes[c] = 1; });

  function inside(){ var a = document.activeElement; return !!(a && (a === el || el.contains(a))); }
  function kd(e){
    if(!inside() || e.metaKey || e.ctrlKey || e.altKey) return;
    var t = (e.target && e.target.tagName || "").toLowerCase();
    if(t === "input" || t === "textarea" || t === "select") return;
    if(!codes[e.code]) return;
    I.keys[e.code] = true;
    e.preventDefault();
  }
  function ku(e){ if(I.keys[e.code]){ delete I.keys[e.code]; e.preventDefault(); } }
  function release(){ I.keys = {}; I.mouse = {}; }
  function md(e){ if(e.button === 0 || e.button === 2){ I.mouse[e.button] = true; if(opts.look && !I.locked) lock(); } }
  function mu(e){ delete I.mouse[e.button]; }
  function mm(e){ if(I.locked){ I.lookX += e.movementX || 0; I.lookY += e.movementY || 0; } }
  function wh(e){ if(!opts.wheel || !(I.locked || inside())) return; I.wheelN += e.deltaY > 0 ? 1 : e.deltaY < 0 ? -1 : 0; e.preventDefault(); }
  function lockChange(){ I.locked = document.pointerLockElement === el; if(!I.locked) I.mouse = {}; }
  function vis(){ if(document.hidden) release(); }
  function lock(){ try { var r = el.requestPointerLock && el.requestPointerLock(); if(r && r.catch) r.catch(function(){}); } catch(e){} }

  window.addEventListener("keydown", kd, true);
  window.addEventListener("keyup", ku, true);
  window.addEventListener("blur", release);
  document.addEventListener("visibilitychange", vis);
  el.addEventListener("focusout", function(e){ if(!el.contains(e.relatedTarget)) release(); });
  el.addEventListener("pointerdown", md);
  window.addEventListener("pointerup", mu);
  document.addEventListener("pointermove", mm);
  document.addEventListener("pointerlockchange", lockChange);
  el.addEventListener("contextmenu", function(e){ if(opts.look) e.preventDefault(); });
  if(opts.wheel) el.addEventListener("wheel", wh, {passive: false});

  function readPad(){
    var pads = null;
    try { pads = navigator.getGamepads ? navigator.getGamepads() : null; } catch(e){ pads = null; }
    var p = null;
    if(pads) for(var i = 0; i < pads.length; i++){ if(pads[i] && pads[i].connected){ p = pads[i]; break; } }
    I.pad = p;
  }
  function padBtn(i){ var p = I.pad, b = p && p.buttons && p.buttons[i]; return b ? (typeof b === "object" ? b.value : b) : 0; }
  function raw(name){
    var b = MAP[name]; if(!b) return false;
    for(var i = 0; i < b.keys.length; i++) if(I.keys[b.keys[i]]) return true;
    for(var j = 0; j < b.pad.length; j++) if(padBtn(b.pad[j]) > 0.5) return true;
    return b.mouse != null && !!I.mouse[b.mouse];
  }
  I.poll = function(){
    var t = performance.now()/1000, dt = I.lastPoll ? clamp(t - I.lastPoll, 0, 0.1) : 0;
    I.lastPoll = t;
    readPad();
    I.was = I.now; I.now = {};
    Object.keys(MAP).forEach(function(n){ I.now[n] = raw(n); });
    if(I.pad && I.pad.axes && I.pad.axes.length >= 4){
      I.lookX += dz(I.pad.axes[2])*LOOK_PAD*dt; I.lookY += dz(I.pad.axes[3])*LOOK_PAD*dt;
    }
  };
  I.down = function(n){ return !!I.now[n]; };
  I.pressed = function(n){ return !!I.now[n] && !I.was[n]; };
  // x: left -1 .. right 1; y: back -1 .. forward 1; throttle: forward minus brake, triggers too.
  I.axis = function(n){
    var p = I.pad, ax = p && p.axes ? p.axes : [];
    if(n === "x"){ var s = dz(ax[0]); return clamp((I.now.right ? 1 : 0) - (I.now.left ? 1 : 0) + s, -1, 1); }
    if(n === "y"){ var y = -dz(ax[1]); return clamp((I.now.up ? 1 : 0) - (I.now.down ? 1 : 0) + y, -1, 1); }
    if(n === "throttle"){
      var go = Math.max(I.now.up ? 1 : 0, padBtn(7), -dz(ax[1]) > 0 ? -dz(ax[1]) : 0);
      var stop = Math.max(I.now.down ? 1 : 0, padBtn(6), -dz(ax[1]) < 0 ? dz(ax[1]) : 0);
      return clamp(go - stop, -1, 1);
    }
    return 0;
  };
  I.look = function(){ var r = {dx: I.lookX*I.sens, dy: I.lookY*I.sens}; I.lookX = 0; I.lookY = 0; return r; };
  I.wheel = function(){ var n = I.wheelN; I.wheelN = 0; return n; };
  I.hasPad = function(){ return !!I.pad; };
  I.lock = lock;
  I.unlock = function(){ try { if(document.pointerLockElement === el) document.exitPointerLock(); } catch(e){} };
  I.destroy = function(){
    I.alive = false; I.unlock();
    window.removeEventListener("keydown", kd, true);
    window.removeEventListener("keyup", ku, true);
    window.removeEventListener("blur", release);
    document.removeEventListener("visibilitychange", vis);
    window.removeEventListener("pointerup", mu);
    document.removeEventListener("pointermove", mm);
    document.removeEventListener("pointerlockchange", lockChange);
    release();
  };
  return I;
}

HQV.input = {create: create, BUTTONS: BUTTONS};
})();
