/* Claude HQ: HQ roofs (HQV.hqRoof), the HQ revamp's working rooftop helipads and roof decks.
 *
 * Every HQ tower has a pad on its roof (games/hqtower.js). Here, pure (no THREE, no DOM, so node tests it):
 *   roofOf(E, B, toWorld) -> {uid, name, own, pad: {x, z, y, r}, deck: {x, z, hw, hd, y, rot}, lift: {x, z, y}, house}
 *                 one HQ's roof in the world (E: the City's entry {x, y, z, rot, h}; B: its building)
 *   padAt(roofs, x, z, slack)    the roof whose pad (x, z) is over (within r + slack), else null
 *   onDeck(R, x, z)              (x, z) is inside the roof's railing (the deck you walk), off its lift's head house
 *   deckAt(roofs, x, z)          the roof whose deck (x, z) is on, else null
 *   assist(st, R, inp, dt) -> cue  a helicopter's landing assist over a pad: within APPROACH m (level with it or
 *                 above it, below CEIL m over it, not climbing) it levels the disc, draws the craft over the pad's
 *                 centre while you give it no stick, and softens the last metres of the sink; cue: null, "approach"
 *                 (lining up), "descend" (over the pad) or "down" (on it)
 *   step(S, st, roofs, inp, dt) -> {cue, roof, say}   assist() on the nearest pad, and the one-time "Landing on
 *                 <name>'s HQ" (say: the text, once per approach; again only after you leave LEAVE m or climb CEIL m)
 *   spotBeside(R)                where you step out of a helicopter on the pad: on the deck by the lift's door
 * Helicopters only (a plane never lands here: hqcity3d calls this from heliMove's hook only).
 */
(function(){
"use strict";
var HQV = window.HQV = window.HQV || {};

var APPROACH = 9;      // m from the pad's centre (past its rim) where the assist starts
var CEIL = 18;         // m over the pad: higher, no assist
var LEAVE = 60;        // m away (or CEIL up) and the next approach is a new one
var SOFT = 4;          // m: below this over the pad the sink is held to SINK m/s
var SINK = 2.2;

function clamp(v, a, b){ return v < a ? a : v > b ? b : v; }
function ease(k, dt){ return 1 - Math.exp(-Math.max(0, +k || 0)*Math.max(0, +dt || 0)); }
function roofOf(E, B, toWorld){
  if(!E || !B || !B.pad || !B.roofDeck) return null;
  var P = B.pad(), D = B.roofDeck(), L = B.roofLift ? B.roofLift() : null; if(!P || !D) return null;
  var y0 = +E.y || 0, pw = toWorld(E, P.x, P.z), dw = toWorld(E, D.x, D.z), lw = L ? toWorld(E, L.x, L.z) : null, h = E.h || {};
  var who = h.trainerName || h.displayName || h.handle;
  return {uid: h.userId || null, name: h.isYou ? "your HQ" : who ? who + "'s HQ" : (E.name || "an HQ"), own: !!h.isYou, rot: +E.rot || 0,
    pad: {x: pw.x, z: pw.z, y: y0 + P.y, r: P.r},
    deck: {x: dw.x, z: dw.z, hw: D.hw, hd: D.hd, y: y0 + D.y, rot: +E.rot || 0},
    lift: lw ? {x: lw.x, z: lw.z, y: y0 + L.y} : null,
    house: L ? (function(){ var hw = toWorld(E, L.x, L.z - 0.9); return {x: hw.x, z: hw.z, r: 0.75}; })() : null};
}
// (x, z) in the deck's own frame
function local(D, x, z){ var dx = x - D.x, dz = z - D.z, c = Math.cos(-D.rot), s = Math.sin(-D.rot); return {x: dx*c + dz*s, z: -dx*s + dz*c}; }
function onDeck(R, x, z){
  if(!R) return false;
  var q = local(R.deck, x, z);
  if(Math.abs(q.x) > R.deck.hw || Math.abs(q.z) > R.deck.hd) return false;
  if(R.house && Math.hypot(x - R.house.x, z - R.house.z) < R.house.r) return false;
  return true;
}
function deckAt(roofs, x, z){ for(var i = 0; i < (roofs || []).length; i++) if(roofs[i] && onDeck(roofs[i], x, z)) return roofs[i]; return null; }
function padAt(roofs, x, z, slack){
  var best = null, bd = 1e9;
  (roofs || []).forEach(function(R){ if(!R) return; var d = Math.hypot(x - R.pad.x, z - R.pad.z); if(d <= R.pad.r + (slack || 0) && d < bd){ bd = d; best = R; } });
  return best;
}
function assist(st, R, inp, dt){
  if(!st || !R || st.ground) return st && st.ground && R && Math.hypot(st.x - R.pad.x, st.z - R.pad.z) <= R.pad.r + 0.5 && Math.abs(st.y - R.pad.y) < 0.6 ? "down" : null;
  inp = inp || {};
  var dx = R.pad.x - st.x, dz = R.pad.z - st.z, d = Math.hypot(dx, dz), agl = st.y - R.pad.y;
  if(d > R.pad.r + APPROACH || agl < -0.5 || agl > CEIL || (+inp.lift || 0) > 0) return null;
  var k = ease(3, dt);
  st.pitch += (0 - st.pitch)*k*(inp.fwd ? 0.3 : 1); st.roll += (0 - st.roll)*k;          // the disc levels
  if(!inp.fwd && !inp.turn){                                                               // no stick: drawn over the centre
    var vmax = Math.min(5, d*0.9), tx = d > 0.05 ? dx/d*vmax : 0, tz = d > 0.05 ? dz/d*vmax : 0, kv = ease(2.2, dt);
    st.vx += (tx - st.vx)*kv; st.vz += (tz - st.vz)*kv;
  }
  if(agl < SOFT && st.vy < -SINK) st.vy = -SINK;                                           // the last metres: soft
  return d <= R.pad.r ? "descend" : "approach";
}
function step(S, st, roofs, inp, dt){
  S = S || {};
  var R = st ? padAt(roofs, st.x, st.z, APPROACH) : null, out = {cue: null, roof: R, say: null};
  if(S.cur && st && (Math.hypot(st.x - S.cur.pad.x, st.z - S.cur.pad.z) > LEAVE || st.y - S.cur.pad.y > CEIL + 10)) S.cur = null;   // left: a new approach next time
  if(!R) return out;
  out.cue = assist(st, R, inp, dt);
  if(out.cue && out.cue !== "down" && (!S.cur || S.cur.uid !== R.uid)){ S.cur = R; out.say = "Landing on " + R.name; }
  return out;
}
function spotBeside(R){
  if(!R) return null;
  var L = R.lift || {x: R.deck.x, z: R.deck.z};
  var dx = L.x - R.pad.x, dz = L.z - R.pad.z, d = Math.hypot(dx, dz) || 1;
  var r = Math.min(d, R.pad.r + 0.6), x = R.pad.x + dx/d*r, z = R.pad.z + dz/d*r;
  if(!onDeck(R, x, z)){ x = L.x; z = L.z; }
  return {x: x, z: z, y: R.deck.y, yaw: Math.atan2(dx, dz)};
}

HQV.hqRoof = {roofOf: roofOf, onDeck: onDeck, deckAt: deckAt, padAt: padAt, assist: assist, step: step, spotBeside: spotBeside,
  APPROACH: APPROACH, CEIL: CEIL, LEAVE: LEAVE};
})();
