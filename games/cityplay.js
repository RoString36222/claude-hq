/* Claude HQ: City play (HQ 3.22), the things to do in the City: one small core every feature plugs into.
 *
 * games/hqcity3d.js makes one instance per City it builds (create) and calls it every frame; the features
 * (jobs, police heat, races, finds, street reactions, the Arena games) register here, each in its own file:
 *
 *   HQV.cityPlay.register({id, order?, create(ctx) -> feat})
 *     feat: {update(dt, f)?, blocked(x, z)?, on(kind, data)?, prompt(p)?, use(p)?, through(x, z)?, sprintMul()?, dispose()?}
 *       (every key optional) prompt(p) -> text | null: the HUD's E prompt on foot at p {x, z} (the first feature with one wins);
 *       use(p) -> bool: E on foot at p, true when the feature took it (hqcity3d's w.prompt / w.use ask these);
 *       through(x, z) -> true: the City's own furniture or market stall at (x, z) gives way (knocked over);
 *       sprintMul() -> your sprint x (the largest wins, at most 1.3)
 *     f, each frame: {ms: Date.now(), local: the City's local ms (npcSim.localMs), me: {x, y, z, yaw},
 *                     motion: hq3d's c.motion() (ride, speed, air, boat), traffic: what traffic.js drew near you}
 *
 *   ctx: {THREE, scene, W (the packed world), worldId, tier (the City's tier: roads open by it), c (hq3d's context), api, tsim, nsim, cev,
 *         ndraw (npcdraw), wb() (worldbuild, once built),
 *         say(text), local(ms), calm(), night(), blocked(x, z) (the City's own, without the features'),
 *         emit(kind, data) (to every feature, and to HQV.cityPlay.on listeners),
 *         hud: {set(id, text, opts?), clear(id)} (one line each, top centre, textContent only: XSS-safe),
 *         beacon(id, x, z, colour) / beaconOff(id) (a tall light column you drive to),
 *         waypoint(x, z, label) (the City's route to it, as a map pick),
 *         store: {get(key, fallback), set(key, value)} (this browser only, guarded; nothing leaves the machine),
 *         feature(id) (another feature of this same City: the Arena games drive jobs, heat and races through it),
 *         seed: a number from the world (W.seed || W.id): every place a feature picks is a pure function of it}
 *
 * Events in (from hq3d.js and the features; HQV.cityPlay.emit is safe with no City built):
 *   "blast" {x, z, k}   a grenade or tank shell went off      "shot" {x, z}   a tank fired
 *   "ram" {x, z, what, speed}  you hit a car, a person or a prop "red" {x, z}   you ran a red light
 *   "job" / "race" / "find" / "heat" {...}   the features' own news
 *
 * Nothing here draws more than the HUD and the beacons; nothing here goes to a server (the Arena games, games/playarena.js,
 * go through the page's opt-in hq presence, the "cityplay" capability). Features never use Math.random for
 * anything a player sees twice: places, routes and rewards come from mulberry32(seed + ...). */
(function(){
"use strict";
var HQV = window.HQV = window.HQV || {};
var FEATS = [], LIVE = null, LISTEN = [];
var STORE_KEY = "hq.cityplay.v1";

function hashStr(s){ var h = 2166136261 >>> 0; s = String(s == null ? "" : s); for(var i = 0; i < s.length; i++){ h ^= s.charCodeAt(i); h = Math.imul(h, 16777619) >>> 0; } return h >>> 0; }
function mulberry32(a){ a = a >>> 0; return function(){ a = (a + 0x6D2B79F5) >>> 0; var t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0)/4294967296; }; }

function register(f){
  if(!f || typeof f.id !== "string" || typeof f.create !== "function") return false;
  for(var i = 0; i < FEATS.length; i++) if(FEATS[i].id === f.id){ FEATS[i] = f; return true; }
  FEATS.push(f); FEATS.sort(function(a, b){ return (a.order | 0) - (b.order | 0); });
  return true;
}

function readStore(){ try { var s = window.localStorage && window.localStorage.getItem(STORE_KEY); var o = s ? JSON.parse(s) : {}; return o && typeof o === "object" ? o : {}; } catch(e){ return {}; } }
function writeStore(o){ try { if(window.localStorage) window.localStorage.setItem(STORE_KEY, JSON.stringify(o)); } catch(e){} }

function makeHud(){
  var el = null, rows = {};
  function host(){
    if(el || typeof document === "undefined" || !document.body) return el;
    el = document.createElement("div"); el.className = "hq-cityplay-hud"; el.setAttribute("role", "status"); el.setAttribute("aria-live", "polite");
    el.style.cssText = "position:fixed;top:64px;left:50%;transform:translateX(-50%);z-index:40;pointer-events:none;display:flex;flex-direction:column;align-items:center;gap:4px;font:600 14px system-ui,sans-serif";
    document.body.appendChild(el); return el;
  }
  return {
    set: function(id, text, o){
      o = o || {}; if(!host()) return;
      var r = rows[id];
      if(!r){ r = rows[id] = document.createElement("div"); r.style.cssText = "padding:4px 12px;border-radius:999px;background:rgba(10,16,24,.72);color:#fff;white-space:nowrap"; el.appendChild(r); }
      r.textContent = String(text == null ? "" : text).slice(0, 120);
      r.style.color = o.colour || "#fff";
    },
    clear: function(id){ var r = rows[id]; if(r && r.parentNode) r.parentNode.removeChild(r); delete rows[id]; },
    dispose: function(){ if(el && el.parentNode) el.parentNode.removeChild(el); el = null; rows = {}; }
  };
}

function create(THREE, o){
  o = o || {};
  var S = o.scene, W = o.W, feats = [], beacons = {}, data = readStore(), dead = false, inst = null;
  var bG = THREE && S ? new THREE.Group() : null;
  if(bG){ bG.name = "cityplay-beacons"; S.add(bG); }
  var hud = makeHud();
  function emit(kind, d){
    if(dead) return;
    feats.forEach(function(f){ if(f.on){ try { f.on(kind, d || {}); } catch(e){} } });
    LISTEN.slice().forEach(function(fn){ try { fn(kind, d || {}); } catch(e){} });
  }
  function beacon(id, x, z, colour){
    if(!bG) return;
    var b = beacons[id];
    if(!b){
      var m = new THREE.MeshBasicMaterial({color: colour || 0xffd040, transparent: true, opacity: 0.35, depthWrite: false});
      b = beacons[id] = new THREE.Mesh(new THREE.CylinderGeometry(1.6, 1.6, 60, 16, 1, true), m);
      b.name = "beacon-" + id; b.renderOrder = 5; bG.add(b);
    }
    if(colour != null) b.material.color.setHex(colour);
    var gy = o.groundY ? o.groundY(x, z) : 0;
    b.position.set(x, gy + 30, z); b.visible = true;
  }
  function beaconOff(id){ var b = beacons[id]; if(!b) return; bG.remove(b); b.geometry.dispose(); b.material.dispose(); delete beacons[id]; }
  var ctx = {
    THREE: THREE, scene: S, W: W, worldId: o.worldId, tier: o.tier != null ? o.tier | 0 : null, c: o.c, api: o.api || {}, tsim: o.tsim || null, nsim: o.nsim || null, cev: o.cev || null,
    ndraw: o.ndraw || null, wb: function(){ try { return (typeof o.wb === "function" ? o.wb() : o.wb) || null; } catch(e){ return null; } },
    seed: hashStr((W && (W.seed || W.id)) || "city"), mulberry32: mulberry32, hashStr: hashStr,
    say: function(t){ if(o.say) o.say(t); },
    local: function(ms){ return o.local ? o.local(ms) : ms; },
    calm: function(){ return !!(o.calm && o.calm()); }, night: function(){ return !!(o.night && o.night()); },
    blocked: function(x, z){ return !!(o.blocked && o.blocked(x, z)); },
    groundY: function(x, z){ return o.groundY ? o.groundY(x, z) : 0; },
    emit: emit, hud: hud, beacon: beacon, beaconOff: beaconOff,
    feature: function(id){ return inst ? inst.feature(id) : null; },
    waypoint: function(x, z, label){ if(o.waypoint) try { o.waypoint(x, z, label); } catch(e){} },
    store: {
      get: function(k, fb){ return Object.prototype.hasOwnProperty.call(data, k) ? data[k] : fb; },
      set: function(k, v){ data[k] = v; writeStore(data); }
    }
  };
  FEATS.forEach(function(F){
    try { var f = F.create(ctx); if(f){ f.id = F.id; feats.push(f); } } catch(e){ if(window.console) console.warn("[cityplay] " + F.id, e); }
  });
  inst = {
    ctx: ctx,
    feature: function(id){ for(var i = 0; i < feats.length; i++) if(feats[i].id === id) return feats[i]; return null; },
    update: function(dt, f){
      if(dead) return;
      feats.forEach(function(x){ if(x.update){ try { x.update(dt, f || {}); } catch(e){} } });
    },
    blocked: function(x, z){
      for(var i = 0; i < feats.length; i++){ var f = feats[i]; if(f.blocked){ try { if(f.blocked(x, z)) return true; } catch(e){} } }
      return false;
    },
    // [play-street] the first feature that lets the City's own prop at (x, z) give way; how much faster you sprint
    through: function(x, z){
      for(var i = 0; i < feats.length; i++){ var f = feats[i]; if(f.through){ try { if(f.through(x, z)) return true; } catch(e){} } }
      return false;
    },
    sprintMul: function(){
      var m = 1;
      feats.forEach(function(f){ if(f.sprintMul){ try { var v = +f.sprintMul(); if(v > m) m = v; } catch(e){} } });
      return Math.min(1.3, m);
    },
    prompt: function(p){
      if(dead || !p) return null;
      for(var i = 0; i < feats.length; i++){ var f = feats[i]; if(f.prompt){ try { var t = f.prompt(p); if(t) return String(t); } catch(e){} } }
      return null;
    },
    use: function(p){
      if(dead || !p) return false;
      for(var i = 0; i < feats.length; i++){ var f = feats[i]; if(f.use){ try { if(f.use(p)) return true; } catch(e){} } }
      return false;
    },
    emit: emit,
    dispose: function(){
      if(dead) return; dead = true;
      feats.forEach(function(f){ if(f.dispose){ try { f.dispose(); } catch(e){} } });
      Object.keys(beacons).forEach(beaconOff);
      if(bG && S) S.remove(bG);
      hud.dispose();
      if(LIVE === inst) LIVE = null;
    }
  };
  LIVE = inst;
  return inst;
}

HQV.cityPlay = {
  register: register, create: create, hashStr: hashStr, mulberry32: mulberry32,
  features: function(){ return FEATS.map(function(f){ return f.id; }); },
  live: function(){ return LIVE; },
  emit: function(kind, d){ if(LIVE) LIVE.emit(kind, d); },
  sprintMul: function(){ return LIVE ? LIVE.sprintMul() : 1; },          // [play-street] hq3d.js: your sprint's pace x this
  on: function(fn){ if(typeof fn === "function") LISTEN.push(fn); return function(){ var i = LISTEN.indexOf(fn); if(i >= 0) LISTEN.splice(i, 1); }; }
};
})();
