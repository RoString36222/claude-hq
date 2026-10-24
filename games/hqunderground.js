/* Claude HQ 3.15: going below ground (HQV.hqUndergroundCtl). docs/plans/transport-revamp.md 3.3, 5.7.
 *
 * Decides when you are underground and drives the switch; the integrator implements HQV.hqUnderground.set(on, reason)
 * (hide the terrain, buildings, sky, sea and weather, a dark fog, V.underground(on)) and passes it in as `set`.
 *
 * Pure (node-tested in tests/test_hqunderground.py):
 *   decide(under, me, env) -> {go: "down"|"up", reason: "walk"|"key"|"ride", cut, station, teleport?, ride?} | null
 *     me  = {x, y (feet), z, key: "E"|null (pressed this step), riding: null | {under, line?, to?}}
 *     env = the metro view V (or sim.layout()): rampAt, entranceAt, stationAt, exitTo, isUnder
 *     - riding: the view follows the train (it switches as the train passes the portal mouth), a cut.
 *     - on foot, above: walked down an entrance's stairs past THRESH_DOWN m below the street; or E within E_R m of
 *       an entrance (stairs, escalator or lift): you are taken to the foot of its stairs in the hall.
 *     - on foot, below: walked up an entrance's stairs above THRESH_UP m below the street (0.5 m of hysteresis); or E
 *       anywhere in a station: you come out at the street side of the nearest entrance (exitTo).
 *   text(go, info) -> "Underground: Harbour Street station, M1 and M2" | "Underground: M1 to Central" | "Back at street level"
 *
 * create({metro (V), sim, announce(text), calm(), fade(ms), set(on, reason), teleport?(pose)}) -> ctl
 *   ctl.step(ms, me) -> {under, phase, went?}    every frame; me.key "E" counts as a press (or call ctl.use)
 *   ctl.use(ms, me) -> bool                       E: true when it starts a switch
 *   ctl.force(on, reason, ms)                     the tour / the integrator: switch now (a cut)
 *   ctl.under() -> bool; ctl.state() -> {under, phase, reason, station}
 * The switch: a FADE ms fade (fade(FADE) at the start; set, teleport and announce at the midpoint); Calm, reduced
 * motion and rides cut (set at once, no fade). While a switch runs further decisions wait.
 */
(function(){
"use strict";
var root = typeof window !== "undefined" ? window : self;
var HQV = root.HQV = root.HQV || {};

var THRESH_DOWN = 1.5, THRESH_UP = 1.0, E_R = 3.5, FADE = 600;

function hyp(x, z){ return Math.sqrt(x*x + z*z); }
function call(env, name){ var a = Array.prototype.slice.call(arguments, 2); try { return env && typeof env[name] === "function" ? env[name].apply(env, a) : null; } catch(e){ return null; } }
function linesText(ls){
  ls = (ls || []).slice();
  if(ls.length <= 1) return ls.join("");
  return ls.slice(0, -1).join(", ") + " and " + ls[ls.length - 1];
}

function decide(under, me, env){
  if(!me || !isFinite(+me.x) || !isFinite(+me.z)) return null;
  var x = +me.x, z = +me.z, y = isFinite(+me.y) && me.y !== null ? +me.y : null, R = me.riding;
  if(R){
    var want = !!R.under;
    if(want === !!under) return null;
    return {go: want ? "down" : "up", reason: "ride", cut: true, station: null, ride: {line: R.line || R.short || null, to: R.to || R.toName || null}};
  }
  var ramp = call(env, "rampAt", x, z);
  if(!under){
    if(ramp && y != null && y < ramp.street - THRESH_DOWN) return {go: "down", reason: "walk", cut: false, station: ramp.station};
    if(me.key === "E"){
      var e = call(env, "entranceAt", x, z, E_R);
      if(e) return {go: "down", reason: "key", cut: false, station: e.station, teleport: e.foot ? {x: e.foot.x, y: e.foot.y, z: e.foot.z, yaw: e.foot.yaw} : null};
    }
    // put below ground some other way (a teleport to a platform): follow it, a cut
    if(!ramp && y != null && call(env, "isUnder", x, y, z) === true){ var s0 = call(env, "stationAt", x, y, z); return {go: "down", reason: "walk", cut: true, station: s0 && s0.id}; }
    return null;
  }
  if(ramp && y != null && y > ramp.street - THRESH_UP) return {go: "up", reason: "walk", cut: false, station: ramp.station};
  if(me.key === "E"){
    var s = call(env, "stationAt", x, y != null ? y : 0, z);
    if(s){ var ex = call(env, "exitTo", s.id, x, z); if(ex) return {go: "up", reason: "key", cut: false, station: s.id, teleport: {x: ex.x, y: ex.y, z: ex.z, yaw: ex.yaw}}; }
  }
  if(!ramp && y != null && call(env, "isUnder", x, y, z) === false && !call(env, "walkable", x, y, z)) return {go: "up", reason: "walk", cut: true, station: null};
  return null;
}

// info: {name, lines} of the station, or {ride: {line, to}}
function text(go, info){
  if(go === "up") return "Back at street level";
  info = info || {};
  if(info.name) return "Underground: " + info.name + " station" + (info.lines && info.lines.length ? ", " + linesText(info.lines) : "");
  var r = info.ride;
  if(r && r.line) return "Underground: " + r.line + (r.to ? " to " + r.to : "");
  return "Underground";
}

function create(o){
  o = o || {};
  var V = o.metro || null, sim = o.sim || null;
  var env = V && typeof V.rampAt === "function" ? V : sim && sim.layout ? sim.layout() : V;
  var st = {under: false, phase: "idle", reason: null, station: null, t0: 0, pending: null};
  function calm(){
    try { if(o.calm && o.calm()) return true; } catch(e){}
    try { return !!(root.matchMedia && root.matchMedia("(prefers-reduced-motion: reduce)").matches); } catch(e){ return false; }
  }
  function infoOf(dec){
    if(dec.station && sim && sim.stops){
      var s = null; try { sim.stops().forEach(function(q){ if(q.id === dec.station) s = q; }); } catch(e){}
      if(s) return {name: s.name, lines: s.lines};
    }
    return {ride: dec.ride || null};
  }
  function apply(dec){
    var on = dec.go === "down";
    st.under = on; st.reason = dec.reason; st.station = on ? dec.station : null;
    try { if(o.set) o.set(on, dec.reason); } catch(e){}
    if(dec.teleport && o.teleport) try { o.teleport(dec.teleport); } catch(e){}
    try { if(o.announce) o.announce(text(dec.go, infoOf(dec))); } catch(e){}
  }
  function begin(ms, dec){
    if(dec.cut || calm()){ apply(dec); st.phase = "idle"; return; }
    st.phase = "out"; st.t0 = ms; st.pending = dec;
    try { if(o.fade) o.fade(FADE); } catch(e){}
  }
  function advance(ms){
    if(st.phase === "out" && ms - st.t0 >= FADE/2){ var d = st.pending; st.pending = null; st.phase = "in"; apply(d); }
    if(st.phase === "in" && ms - st.t0 >= FADE) st.phase = "idle";
  }
  var ctl = {
    step: function(ms, me){
      advance(ms);
      if(st.phase !== "idle") return {under: st.under, phase: st.phase};
      var dec = decide(st.under, me, env);
      if(!dec || dec.reason === "key" && !(me && me.key === "E")) return {under: st.under, phase: st.phase};
      begin(ms, dec); advance(ms);
      return {under: st.under, phase: st.phase, went: dec.go};
    },
    use: function(ms, me){
      if(st.phase !== "idle" || !me) return false;
      var dec = decide(st.under, {x: me.x, y: me.y, z: me.z, key: "E", riding: me.riding || null}, env);
      if(!dec || dec.reason !== "key") return false;
      begin(ms, dec); advance(ms);
      return true;
    },
    force: function(on, reason){
      st.phase = "idle"; st.pending = null;
      if(!!on === st.under) return;
      apply({go: on ? "down" : "up", reason: reason || "force", cut: true, station: null});
    },
    under: function(){ return st.under; },
    state: function(){ return {under: st.under, phase: st.phase, reason: st.reason, station: st.station}; }
  };
  return ctl;
}

HQV.hqUndergroundCtl = {create: create, decide: decide, text: text, linesText: linesText,
  THRESH_DOWN: THRESH_DOWN, THRESH_UP: THRESH_UP, E_R: E_R, FADE: FADE};
})();
