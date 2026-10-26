/* Claude HQ: City play feature playjobs (HQ 3.22), odd jobs you start from the phone. Registers with HQV.cityPlay
 * (games/cityplay.js) as "jobs" and adds the phone's Jobs app (HQV.hqPhoneQueue, games/hqphone.js).
 *
 * Three kinds, offered near you, a new set every SLOT_MS (10 min of the City's local clock), the same for everyone in
 * the same world, slot and BUCKET (300 m square) of the map: a pure function of (W, seed, slot, bucket, hour).
 *   taxi      drive a car to a fare waiting at a kerb (a figure with an arm up, by a stop or a cafe terrace), stop
 *             beside them, drive them to a door (a home or an office). More fares at night and in the rush hours
 *             (citylife.demand). Rams while they ride cost tip.
 *   delivery  on foot, by bike, scooter or board: pick up at a shop or cafe (or a loading bay), drop 1-3 parcels at
 *             home doors.
 *   van       from a warehouse loading bay (the industrial group) to 2 shops; any car will do (there is no van in the
 *             catalogue), a heavy one (an SUV, the tank) earns a 25% bonus. Fragile: rams cost more tip.
 * Every target is a point on a footpath (WD.surfaceAt "sidewalk", not WD.blockedAt) in front of a real lot of the
 * right use (citylife.landUse), never on a carriageway, in a building or on water. Pay is "City rep" (no fares, no
 * coins: D4), kept with ctx.store on this computer, with per-kind ranks Rookie -> Pro -> Legend and a few local
 * achievements shown in the phone's Achievements app (HQV.hqAchSources).
 *
 * Pure (node-tested, tests/test_play_jobs.py): HQV.playJobs = {SLOT_MS, BUCKET, KINDS, NAMES, RANKS, CFG, slotOf,
 *   bucketOf, kerbPoint, places, offers, limitFor, payout, rankOf, statsOf, record, achList, canDo, heavy, fmtClock,
 *   fmtDist, live(), achievements()}
 * The feature (HQV.cityPlay.live().feature("jobs"), or HQV.playJobs.live()), for the phone and for others (Arena co-op):
 *   offers() -> [offer]          offer: {id, kind, title, sub, from: {x, z, label}, stops: [{x, z, label}], dist, base}
 *   start(id | offer | spec) -> {ok, reason?}   spec (co-op): {kind, from: {x, z}, stops: [{x, z}], limit?, base?, id?}:
 *                                its points are snapped to the nearest footpath (refused when there is none)
 *   cancel() / active() -> {id, kind, title, step, of, text, left, dist, rams, aboard} | null / stats() / onChange(fn)
 * Events out: ctx.emit("job", {kind, state: "start" | "done" | "fail", tip, reason?}). In: "ram" (while a fare rides
 * or cargo is aboard). ctx.say carries counts only. Nothing leaves the machine.
 */
(function(){
"use strict";
var root = typeof window !== "undefined" ? window : globalThis;
var HQV = root.HQV = root.HQV || {};

var SLOT_MS = 6e5, BUCKET = 300, STORE = "jobs";
var KINDS = ["taxi", "delivery", "van"];
var NAMES = {taxi: "Taxi fare", delivery: "Delivery", van: "Van run"};
var RANKS = [{id: "rookie", name: "Rookie", at: 0}, {id: "pro", name: "Pro", at: 5}, {id: "legend", name: "Legend", at: 20}];
// pace m/s and slack s for the time limit; base + dist/per rep; ram: tip lost per ram; arrive m; stop: m/s at most
var CFG = {
  taxi: {pace: 8, slack: 45, base: 20, per: 50, ram: 0.2, arrive: 7, stop: 1.5, colour: 0xffd040},
  delivery: {pace: 3.6, slack: 25, base: 10, per: 70, ram: 0.1, arrive: 4.5, stop: 3.5, colour: 0x40c0ff, perStop: 6},
  van: {pace: 7, slack: 50, base: 30, per: 40, ram: 0.3, arrive: 8, stop: 1.5, colour: 0xff8040, perStop: 8}
};
var BEACON = "job", HUD = "job";

function WQ(){ return HQV.world; }
function CL(){ return HQV.cityLife; }
function num(v, d){ v = +v; return isFinite(v) ? v : d; }
function hashStr(s){ var h = 2166136261 >>> 0; s = String(s == null ? "" : s); for(var i = 0; i < s.length; i++){ h ^= s.charCodeAt(i); h = Math.imul(h, 16777619) >>> 0; } return h >>> 0; }
function mulberry32(a){ a = a >>> 0; return function(){ a = (a + 0x6D2B79F5) >>> 0; var t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0)/4294967296; }; }
function cm(v){ return (+v || 0)/100; }
function dist(a, b){ return Math.hypot(a.x - b.x, a.z - b.z); }
function hourOf(ms){ return (((num(ms, 0) % 864e5) + 864e5) % 864e5)/36e5; }
function slotOf(localMs){ return Math.floor(num(localMs, 0)/SLOT_MS); }
function bucketOf(x, z){ var bx = Math.floor(num(x, 0)/BUCKET), bz = Math.floor(num(z, 0)/BUCKET); return {bx: bx, bz: bz, x: (bx + 0.5)*BUCKET, z: (bz + 0.5)*BUCKET}; }
function fmtClock(s){ s = Math.max(0, Math.ceil(num(s, 0))); var m = Math.floor(s/60), r = s % 60; return m + ":" + (r < 10 ? "0" : "") + r; }
function fmtDist(m){ m = Math.max(0, num(m, 0)); return m >= 1000 ? (Math.round(m/100)/10).toFixed(1) + " km" : (Math.round(m/10)*10) + " m"; }

/* ---------- places ---------- */
// The footpath in front of (x, z): the nearest road's footpath on the side (x, z) is on, its middle first, then nearer
// the kerb or the lots; a point only where the ground is footpath and nothing stands. null when there is none.
function kerbPoint(W, x, z){
  var Q = WQ();
  if(!W || !Q) return null;
  var n = Q.nearestRoad(W, x, z, 40);
  if(!n || !(n.half > 0)) return null;
  var walk = Math.max(0, n.half - n.carriage);
  if(walk < 1) return null;
  var dx = x - n.x, dz = z - n.z, L = Math.hypot(dx, dz);
  if(L < 0.01){ dx = Math.cos(n.yaw); dz = -Math.sin(n.yaw); L = 1; }      // on the centre line: the left-hand side
  dx /= L; dz /= L;
  var offs = [n.carriage + walk*0.5, n.carriage + walk*0.3, n.carriage + walk*0.7];
  for(var i = 0; i < offs.length; i++){
    var px = Math.round((n.x + dx*offs[i])*100)/100, pz = Math.round((n.z + dz*offs[i])*100)/100;
    if(Q.surfaceAt(W, px, pz) === "sidewalk" && !Q.blockedAt(W, px, pz))
      return {x: px, z: pz, edge: n.edge, street: n.name ? String(n.name).slice(0, 40) : "", yaw: Math.atan2(-dx, -dz)};
  }
  return null;
}
var PLACES = typeof WeakMap === "function" ? new WeakMap() : null;
// every place a job can use, each a footpath point: pickups (fares wait), homes, offices, shops (shop or cafe ground
// floors), docks (loading bays: warehouses first)
function places(W){
  var P = PLACES && PLACES.get(W);
  if(P) return P;
  P = {pickups: [], homes: [], offices: [], shops: [], docks: []};
  var L = CL();
  if(!W || !L || !WQ()){ return P; }
  var U = L.landUse(W);
  (W.lots || []).forEach(function(lot){
    var u = U[lot.id];
    if(!u) return;
    var dx = lot.door ? cm(lot.door[0]) : cm(lot.x), dz = lot.door ? cm(lot.door[2]) : cm(lot.z), k = kerbPoint(W, dx, dz);
    if(!k) return;
    var p = {x: k.x, z: k.z, yaw: k.yaw, street: k.street, lot: lot.id, use: u.use, ground: u.ground, group: u.group};
    if(u.use === "home" && u.ground === "door") P.homes.push(p);
    if(u.use === "office") P.offices.push(p);
    if(u.ground === "shop" || u.ground === "cafe") P.shops.push(p);
    if(u.ground === "loading" && u.group === "industry") P.docks.push(p);
  });
  L.hotspots(W).forEach(function(s){
    if(s.kind !== "wait" && s.kind !== "terrace") return;
    var k = kerbPoint(W, s.x, s.z);
    if(k) P.pickups.push({x: k.x, z: k.z, yaw: k.yaw, street: k.street, spot: s.id, at: s.kind});
  });
  if(PLACES) PLACES.set(W, P);
  return P;
}
function near(list, c, lo, hi){ return list.filter(function(p){ var d = dist(p, c); return d >= lo && d <= hi; }); }
function pickFrom(list, r){ return list.length ? list[Math.floor(r()*list.length) % list.length] : null; }
// the nearest few within hi (widening once when there are none), then one of them
function pickNear(list, c, lo, hi, r, few){
  var a = near(list, c, lo, hi);
  if(!a.length) a = near(list, c, lo*0.5, hi*2);
  a.sort(function(p, q){ return dist(p, c) - dist(q, c) || (p.lot != null ? p.lot : 0) - (q.lot != null ? q.lot : 0); });
  return pickFrom(a.slice(0, few || 8), r);
}
function on(p){ return p.street ? " on " + p.street : ""; }
function stopOf(p, label){ return {x: p.x, z: p.z, lot: p.lot != null ? p.lot : null, label: label + on(p)}; }
function routeLen(from, stops){ var d = 0, a = from; (stops || []).forEach(function(s){ d += dist(a, s); a = s; }); return d; }
function baseOf(kind, d, n){ var C = CFG[kind]; return Math.round(C.base + d/C.per + (C.perStop || 0)*Math.max(0, (n | 0) - 1)); }

// The offers near (x, z) in a slot, at a local hour: {kind, ...} for each, see the header. o: {seed, slot, x, z, hour}
function offers(W, o){
  o = o || {};
  var P = places(W), L = CL(), B = bucketOf(o.x, o.z), c = {x: B.x, z: B.z}, slot = num(o.slot, 0) | 0, h = num(o.hour, 12);
  var r = mulberry32((num(o.seed, 0) >>> 0) ^ hashStr("jobs:" + slot + ":" + B.bx + ":" + B.bz)), out = [];
  var dm = L ? L.demand(h, "main") : 0.5, night = h >= 21 || h < 5;
  var nTaxi = 1 + (night || dm > 0.7 ? 2 : dm > 0.4 ? 1 : 0);
  function add(kind, from, stops){
    if(!from || !stops.length || stops.some(function(s){ return !s; })) return;
    var d = routeLen(from, stops), i = out.length;
    out.push({id: kind + ":" + slot + ":" + B.bx + ":" + B.bz + ":" + i, kind: kind, title: NAMES[kind], from: from, stops: stops,
              dist: Math.round(d), base: baseOf(kind, d, stops.length), slot: slot});
  }
  var dests = P.homes.concat(P.offices);
  for(var t = 0; t < nTaxi; t++){
    var pu = pickNear(P.pickups, c, 0, 500, r, 10);
    if(!pu) break;
    var to = pickNear(dests, pu, 250, 1400, r, 40);
    if(!to) continue;
    add("taxi", {x: pu.x, z: pu.z, yaw: pu.yaw, spot: pu.spot, label: "A fare waiting at " + (pu.at === "terrace" ? "a cafe terrace" : "a stop") + on(pu)},
        [stopOf(to, to.use === "office" ? "An office" : "A home")]);
  }
  for(var k = 0; k < 2; k++){
    var sh = pickNear(P.shops.concat(P.docks), c, 0, 450, r, 10);
    if(!sh) break;
    var n = 1 + Math.floor(r()*3), drops = [], prev = sh;
    for(var j = 0; j < n; j++){
      var hm = pickNear(P.homes.filter(function(x){ return drops.indexOf(x) < 0; }), prev, 60, 450, r, 12);
      if(!hm) break;
      drops.push(hm); prev = hm;
    }
    if(!drops.length) continue;
    add("delivery", {x: sh.x, z: sh.z, yaw: sh.yaw, lot: sh.lot, label: "Pick up at " + (sh.ground === "cafe" ? "a cafe" : sh.ground === "loading" ? "a loading bay" : "a shop") + on(sh)},
        drops.map(function(x, i){ return stopOf(x, "Parcel " + (i + 1) + " of " + drops.length + ": a home"); }));
  }
  var wh = P.docks.filter(function(p){ return p.use === "warehouse"; });
  var dk = pickNear(wh.length ? wh : P.docks, c, 0, 1500, r, 4);
  if(dk){
    var v = [], pv = dk;
    for(var q = 0; q < 2; q++){
      var s2 = pickNear(P.shops.filter(function(x){ return v.indexOf(x) < 0; }), pv, 300, 1800, r, 20);
      if(!s2) break;
      v.push(s2); pv = s2;
    }
    if(v.length) add("van", {x: dk.x, z: dk.z, yaw: dk.yaw, lot: dk.lot, label: "Load up at a warehouse" + on(dk)},
                     v.map(function(x, i){ return stopOf(x, "Drop " + (i + 1) + " of " + v.length + ": a shop"); }));
  }
  return out;
}

/* ---------- rules ---------- */
function limitFor(kind, d, nStops){ var C = CFG[kind] || CFG.taxi; return Math.round(Math.max(0, num(d, 0))/C.pace + C.slack + 10*Math.max(0, (nStops | 0) - 1)); }
// rep for a finished job: its base, half of it for time left, less for rams, more in a heavy vehicle (a van run)
function payout(kind, o){
  o = o || {};
  var C = CFG[kind] || CFG.taxi, lim = Math.max(1, num(o.limit, 1)), left = Math.max(0, Math.min(lim, num(o.left, 0)));
  var smooth = Math.max(0.25, 1 - C.ram*Math.max(0, num(o.rams, 0) | 0));
  var heavyMul = kind === "van" && o.heavy ? 1.25 : 1;
  return Math.max(1, Math.round(Math.max(1, num(o.base, C.base))*(0.5 + 0.5*left/lim)*smooth*heavyMul));
}
function rankOf(n){
  n = Math.max(0, num(n, 0) | 0);
  var r = RANKS[0], nx = null;
  for(var i = 0; i < RANKS.length; i++){ if(n >= RANKS[i].at) r = RANKS[i]; else { nx = RANKS[i]; break; } }
  return {id: r.id, name: r.name, next: nx ? {name: nx.name, left: nx.at - n} : null};
}
function statsOf(s){
  s = s && typeof s === "object" ? s : {};
  var o = {rep: Math.max(0, num(s.rep, 0) | 0), streak: Math.max(0, num(s.streak, 0) | 0), bestStreak: Math.max(0, num(s.bestStreak, 0) | 0),
           fails: Math.max(0, num(s.fails, 0) | 0), smooth: Math.max(0, num(s.smooth, 0) | 0), night: Math.max(0, num(s.night, 0) | 0), done: {}, best: {}};
  KINDS.forEach(function(k){ o.done[k] = Math.max(0, num(s.done && s.done[k], 0) | 0); o.best[k] = Math.max(0, num(s.best && s.best[k], 0) | 0); });
  return o;
}
// the stats after a job: r = {kind, state: "done" | "fail" | "cancel", tip, rams, hour}
function record(s, r){
  s = statsOf(s); r = r || {};
  var k = KINDS.indexOf(r.kind) >= 0 ? r.kind : null;
  if(r.state === "done" && k){
    var tip = Math.max(0, num(r.tip, 0) | 0);
    s.rep += tip; s.done[k]++; s.best[k] = Math.max(s.best[k], tip); s.streak++; s.bestStreak = Math.max(s.bestStreak, s.streak);
    if(k === "van" && !(num(r.rams, 0) > 0)) s.smooth++;
    var h = num(r.hour, 12);
    if(k === "taxi" && (h >= 22 || h < 5)) s.night++;
  } else if(r.state === "fail"){ s.fails++; s.streak = 0; }
  else if(r.state === "cancel"){ s.streak = 0; }
  return s;                                    // "void": the place was blocked, or you left the City: no change
}
var ACH = [
  {id: "jobs-first-fare", name: "First fare", desc: "Finish a taxi fare.", of: function(s){ return s.done.taxi/1; }},
  {id: "jobs-night-shift", name: "Night shift", desc: "Finish 5 taxi fares after 22:00 city time.", of: function(s){ return s.night/5; }},
  {id: "jobs-gentle", name: "Gentle hands", desc: "Finish a van run without a single knock.", of: function(s){ return s.smooth/1; }},
  {id: "jobs-courier", name: "Courier", desc: "Finish 10 deliveries.", of: function(s){ return s.done.delivery/10; }},
  {id: "jobs-streak", name: "On a roll", desc: "Finish 5 jobs in a row.", of: function(s){ return s.bestStreak/5; }},
  {id: "jobs-legend", name: "City legend", desc: "Reach Legend in any kind of job.", of: function(s){ return Math.max(s.done.taxi, s.done.delivery, s.done.van)/RANKS[2].at; }}
];
function achList(s){
  s = statsOf(s);
  return ACH.map(function(a){ var p = Math.max(0, Math.min(1, a.of(s))); return {id: a.id, name: a.name, desc: a.desc, done: p >= 1, progress: p}; });
}
// what you are on (hq3d's motion(): ride "car" | "moto" | "bike" | "skate" | "tank" | a boat's or craft's kind | null)
function canDo(kind, m){
  var ride = m && m.ride != null ? String(m.ride) : null;
  if(m && (m.air || m.boat)) return false;
  if(kind === "taxi") return ride === "car";
  if(kind === "van") return ride === "car" || ride === "tank";
  return ride == null || ride === "bike" || ride === "moto" || ride === "skate";
}
function heavy(m){ return !!(m && (m.ride === "tank" || m.body === "suv" || m.body === "van" || m.body === "lorry")); }
var NEED = {taxi: "Get in a car", van: "Get in a car (heavy ones earn more)", delivery: "Deliveries go on foot, by bike or scooter"};

/* ---------- the fare: a person with an arm up ---------- */
function figure(THREE, seed){
  var g = new THREE.Group(), r = mulberry32(seed), cols = [0x3d6fd1, 0xc43a2a, 0x2a8c5a, 0x8a4fc4, 0xd18a3d, 0x2a3c50];
  var coat = new THREE.MeshLambertMaterial({color: cols[Math.floor(r()*cols.length)]}), skin = new THREE.MeshLambertMaterial({color: [0xf0c8a0, 0xc89870, 0x8a5a3a][Math.floor(r()*3)]});
  var legs = new THREE.MeshLambertMaterial({color: 0x30343c});
  var body = new THREE.Mesh(new THREE.CylinderGeometry(0.22, 0.26, 0.75, 10), coat); body.position.y = 1.15; g.add(body);
  var leg = new THREE.Mesh(new THREE.CylinderGeometry(0.2, 0.18, 0.8, 8), legs); leg.position.y = 0.4; g.add(leg);
  var head = new THREE.Mesh(new THREE.SphereGeometry(0.15, 12, 10), skin); head.position.y = 1.72; g.add(head);
  var arm = new THREE.Mesh(new THREE.BoxGeometry(0.09, 0.62, 0.09), coat); arm.position.set(0.3, 1.72, 0); arm.rotation.z = -0.25; g.add(arm);
  var arm2 = new THREE.Mesh(new THREE.BoxGeometry(0.09, 0.6, 0.09), coat); arm2.position.set(-0.28, 1.1, 0); arm2.rotation.z = 0.12; g.add(arm2);
  g.name = "job-fare";
  g.userData.mats = [coat, skin, legs];
  return g;
}
function disposeObj(o){
  if(!o) return;
  if(o.parent) o.parent.remove(o);
  o.traverse && o.traverse(function(n){ if(n.geometry) n.geometry.dispose(); });
  ((o.userData && o.userData.mats) || []).forEach(function(m){ m.dispose(); });
}

/* ---------- the feature ---------- */
var LIVE = null;
function storedStats(){
  if(LIVE) return LIVE.stats();
  try { var s = root.localStorage && root.localStorage.getItem("hq.cityplay.v1"), o = s ? JSON.parse(s) : {}; return statsOf(o && o[STORE]); } catch(e){ return statsOf(null); }
}
function create(ctx){
  ctx = ctx || {};
  var W = ctx.W, seed = num(ctx.seed, 0) >>> 0, job = null, me = {x: 0, z: 0}, motion = null, nowMs = Date.now(), localMs = null;
  var cache = null, listeners = [], lastHud = "", hudUntil = 0, chkT = 0, blockN = 0, ramAt = -1e9, fig = null, dead = false;
  function store(){ return ctx.store ? statsOf(ctx.store.get(STORE, null)) : statsOf(null); }
  function save(s){ if(ctx.store) ctx.store.set(STORE, s); }
  function changed(){ listeners.slice().forEach(function(fn){ try { fn(); } catch(e){} }); }
  function say(t){ if(ctx.say) try { ctx.say(t); } catch(e){} }
  function hud(t, col){ if(t === lastHud || !ctx.hud) return; lastHud = t; if(t) ctx.hud.set(HUD, t, col ? {colour: col} : null); else ctx.hud.clear(HUD); }
  function local(){ return localMs != null ? localMs : ctx.local ? ctx.local(nowMs) : nowMs; }
  function list(){
    var lm = local(), slot = slotOf(lm), B = bucketOf(me.x, me.z), key = slot + ":" + B.bx + ":" + B.bz;
    if(!cache || cache.key !== key){
      var o = [];
      try { o = offers(W, {seed: seed, slot: slot, x: me.x, z: me.z, hour: hourOf(lm)}); } catch(e){ o = []; }
      cache = {key: key, list: o};
    }
    return cache.list;
  }
  function blocked(p){ return !!(ctx.blocked && ctx.blocked(p.x, p.z)); }
  // a clear point at p, or within 3 m along its footpath (anything standing there now: a parked stall, a car)
  function clearAt(p){
    if(!blocked(p)) return p;
    for(var d = 1; d <= 3; d++) for(var s = -1; s <= 1; s += 2){
      var yaw = num(p.yaw, 0), q = {x: p.x + Math.cos(yaw)*d*s, z: p.z - Math.sin(yaw)*d*s, yaw: p.yaw, label: p.label, lot: p.lot};
      if(WQ() && W && WQ().surfaceAt(W, q.x, q.z) === "sidewalk" && !blocked(q)) return q;
    }
    return null;
  }
  function snap(p){ var k = p && isFinite(+p.x) && isFinite(+p.z) ? kerbPoint(W, +p.x, +p.z) : null; return k ? {x: k.x, z: k.z, yaw: k.yaw, label: String((p && p.label) || "A stop").slice(0, 60)} : null; }
  function target(){ return !job ? null : job.step === 0 ? job.from : job.stops[job.step - 1]; }
  function point(){
    var t = target();
    if(!t) return;
    if(ctx.beacon) ctx.beacon(BEACON, t.x, t.z, CFG[job.kind].colour);
    if(ctx.waypoint) ctx.waypoint(t.x, t.z, t.label);
  }
  function clearJob(){
    job = null; blockN = 0;
    if(ctx.beaconOff) ctx.beaconOff(BEACON);
    disposeObj(fig); fig = null;
  }
  function finish(state, reason){
    if(!job) return;
    var j = job, lm = local(), tip = 0;
    if(state === "done") tip = payout(j.kind, {base: j.base, left: j.limit - (nowMs - j.t0)/1000, limit: j.limit, rams: j.rams, heavy: j.heavy});
    var before = achList(store()), s = record(store(), {kind: j.kind, state: reason === "blocked" || reason === "left" ? "void" : state, tip: tip, rams: j.rams, hour: hourOf(lm)});
    save(s);
    clearJob();
    var ev = {kind: j.kind, state: state === "cancel" ? "fail" : state, tip: tip, id: j.id};
    if(state !== "done") ev.reason = reason || state;
    if(!dead && ctx.emit) ctx.emit("job", ev);
    if(state === "done"){ hud(NAMES[j.kind] + " done · +" + tip + " rep", "#9fe8a8"); say(NAMES[j.kind] + " done. Plus " + tip + " City rep."); }
    else if(!dead){ hud(state === "cancel" ? "" : NAMES[j.kind] + (reason === "blocked" ? ": the way is blocked" : reason === "late" ? ": out of time" : ": over"), "#ffb0a0"); say(NAMES[j.kind] + (state === "cancel" ? " cancelled." : " failed.")); }
    hudUntil = nowMs + 4000;
    var after = achList(s);
    after.forEach(function(a, i){ if(a.done && !before[i].done) say("Achievement: " + a.name); });
    changed();
  }
  function start(arg){
    if(dead) return {ok: false, reason: "gone"};
    if(job) return {ok: false, reason: "busy"};
    var o = null;
    if(typeof arg === "string"){ o = list().filter(function(x){ return x.id === arg; })[0] || null; if(!o) return {ok: false, reason: "gone"}; }
    else if(arg && arg.from && arg.stops){
      if(KINDS.indexOf(arg.kind) < 0) return {ok: false, reason: "kind"};
      if(arg.id && cache && cache.list.some(function(x){ return x.id === arg.id; })) o = arg;
      else {
        var f0 = snap(arg.from), st = (arg.stops || []).slice(0, 4).map(snap);
        if(!f0 || !st.length || st.some(function(x){ return !x; })) return {ok: false, reason: "place"};
        var d0 = routeLen(f0, st);
        o = {id: String(arg.id || "custom:" + Math.round(f0.x) + ":" + Math.round(f0.z)).slice(0, 80), kind: arg.kind, title: NAMES[arg.kind], from: f0, stops: st,
             dist: Math.round(d0), base: arg.base != null ? Math.max(1, Math.min(500, num(arg.base, 1) | 0)) : baseOf(arg.kind, d0, st.length), limit: arg.limit};
      }
    } else return {ok: false, reason: "gone"};
    var from = clearAt(o.from), stops = o.stops.map(clearAt);
    if(!from || stops.some(function(x){ return !x; })) return {ok: false, reason: "blocked"};
    var d = dist(me, from) + routeLen(from, stops);
    job = {id: o.id, kind: o.kind, title: o.title || NAMES[o.kind], from: from, stops: stops, step: 0, t0: nowMs, rams: 0, heavy: false, base: o.base,
           limit: o.limit != null ? Math.max(30, Math.min(3600, num(o.limit, 0))) : limitFor(o.kind, d, stops.length)};
    if(o.kind === "taxi" && ctx.THREE && ctx.scene){
      try { fig = figure(ctx.THREE, seed ^ hashStr(o.id)); fig.position.set(from.x, ctx.groundY ? ctx.groundY(from.x, from.z) : 0, from.z); fig.rotation.y = num(from.yaw, 0); ctx.scene.add(fig); } catch(e){ fig = null; }
    }
    point();
    if(ctx.emit) ctx.emit("job", {kind: job.kind, state: "start", tip: 0, id: job.id});
    say(job.title + " started. " + stops.length + (stops.length === 1 ? " drop." : " drops."));
    lastHud = ""; changed();
    return {ok: true};
  }
  function view(){
    if(!job) return null;
    var t = target(), left = job.limit - (nowMs - job.t0)/1000, d = dist(me, t);
    var text = job.step === 0 ? (job.kind === "taxi" ? "Pick up the fare" : job.kind === "van" ? "Load the van" : "Pick up the parcels") : t.label;
    return {id: job.id, kind: job.kind, title: job.title, step: job.step, of: job.stops.length + 1, text: text, label: t.label, left: Math.max(0, left), dist: d,
            rams: job.rams, aboard: job.step > 0, x: t.x, z: t.z, ok: canDo(job.kind, motion)};
  }
  var feat = {
    offers: function(){ return list().slice(); },
    start: start,
    cancel: function(){ if(job){ finish("cancel", "cancel"); return true; } return false; },
    active: view,
    stats: store,
    achievements: function(){ return achList(store()); },
    onChange: function(fn){ if(typeof fn === "function") listeners.push(fn); return function(){ listeners = listeners.filter(function(g){ return g !== fn; }); }; },
    update: function(dt, f){
      f = f || {};
      nowMs = num(f.ms, Date.now()); localMs = f.local != null ? num(f.local, nowMs) : null;
      if(f.me){ me = {x: num(f.me.x, me.x), z: num(f.me.z, me.z)}; }
      motion = f.motion || null;
      if(!job){
        if(hudUntil && nowMs > hudUntil){ hudUntil = 0; hud(""); }
        if(cache){ var k0 = cache.key; list(); if(cache.key !== k0) changed(); }
        return;
      }
      var v = view(), C = CFG[job.kind];
      if(v.left <= 0){ finish("fail", "late"); return; }
      chkT += num(dt, 0);
      if(chkT >= 1){
        chkT = 0;
        var t = target();
        blockN = blocked(t) ? blockN + 1 : 0;
        if(blockN >= 6){ finish("fail", "blocked"); return; }
      }
      var sp = Math.abs(num(motion && motion.speed, 0));
      if(v.ok && v.dist <= C.arrive && sp <= C.stop){
        job.step++;
        if(job.step === 1){
          if(fig) fig.visible = false;
          job.heavy = heavy(motion);
          say(job.kind === "taxi" ? "Fare aboard." : "Loaded. " + job.stops.length + (job.stops.length === 1 ? " drop." : " drops."));
        } else if(job.step <= job.stops.length) say("Drop " + (job.step - 1) + " of " + job.stops.length + " done.");
        if(job.step > job.stops.length){ finish("done"); return; }
        point(); changed();
        v = view();
      }
      var line = (job.kind === "taxi" ? "Fare: " : job.kind === "van" ? "Van: " : "Delivery: ") + fmtClock(v.left) + " · " + fmtDist(v.dist);
      if(!v.ok) line += " · " + NEED[job.kind];
      else if(v.dist <= C.arrive && sp > C.stop) line += " · stop here";
      hud(line, v.left < 20 ? "#ffb0a0" : null);
    },
    on: function(kind, d){
      if(kind !== "ram" || !job || job.step < 1 || job.kind === "delivery" && motion && motion.ride == null) return;
      if(nowMs - ramAt < 800) return;
      ramAt = nowMs; job.rams++;
      if(ctx.say && job.rams === 1) say(job.kind === "van" ? "Careful: fragile cargo." : "Careful: your fare felt that.");
    },
    dispose: function(){
      if(dead) return;
      dead = true;
      if(job) finish("cancel", "left");
      clearJob();
      if(ctx.hud) ctx.hud.clear(HUD);
      listeners = [];
      if(LIVE === feat) LIVE = null;
    }
  };
  LIVE = feat;
  return feat;
}
if(HQV.cityPlay) HQV.cityPlay.register({id: "jobs", order: 10, create: create});

var API = HQV.playJobs = {SLOT_MS: SLOT_MS, BUCKET: BUCKET, KINDS: KINDS, NAMES: NAMES, RANKS: RANKS, CFG: CFG, slotOf: slotOf, bucketOf: bucketOf,
  kerbPoint: kerbPoint, places: places, offers: offers, limitFor: limitFor, payout: payout, rankOf: rankOf, statsOf: statsOf, record: record,
  achList: achList, canDo: canDo, heavy: heavy, fmtClock: fmtClock, fmtDist: fmtDist, create: create,
  live: function(){ var L = HQV.cityPlay && HQV.cityPlay.live && HQV.cityPlay.live(), f = L && L.feature ? L.feature("jobs") : null; return f || LIVE; },
  achievements: function(){ return achList(storedStats()); }};
// the phone's Achievements app lists these too (local only)
(HQV.hqAchSources = HQV.hqAchSources || []).push(function(){ return API.achievements(); });

/* ---------- the phone's Jobs app ---------- */
var GLYPH = "M4 8h16v11H4zM9 8V5h6v3M4 13h16M11 12v2h2v-2";
function render(el, host, nav){
  var doc = root.document;
  function mk(tag, cls, parent, text){ var n = doc.createElement(tag); if(cls) n.className = cls; if(text != null) n.textContent = text; if(parent) parent.appendChild(n); return n; }
  function btn(parent, text, cls, fn, label){ var b = mk("button", "hp-btn" + (cls ? " " + cls : ""), parent, text); b.type = "button"; if(label) b.setAttribute("aria-label", label); b.addEventListener("click", fn); return b; }
  function announce(t){ try { if(host && host.announce) host.announce(t); } catch(e){} }
  var uid = "hpj-" + Math.floor(num(Date.now(), 0) % 1e6);
  var rootEl = mk("div", "hp-app", el), F = API.live();
  mk("p", "hp-muted", rootEl, "Odd jobs around the City. They pay in City rep, kept on this computer.");
  if(!F){ mk("p", "hp-muted", rootEl, "Jobs appear when the City is loaded."); return {dispose: function(){}}; }
  var cur = mk("section", "hp-card", rootEl), ch = mk("h3", "", cur, "Current job"); ch.id = uid + "-cur"; cur.setAttribute("aria-labelledby", ch.id);
  var curText = mk("p", "", cur), curSub = mk("p", "hp-legsub", cur);
  var cancel = btn(cur, "Cancel job", "hp-danger", function(){ if(F.cancel()) announce("Job cancelled"); draw(); });
  var offS = mk("section", "", rootEl), oh = mk("h3", "", offS, "Near you"); oh.id = uid + "-near"; offS.setAttribute("aria-labelledby", oh.id);
  var ul = mk("ul", "hp-list", offS); ul.setAttribute("aria-labelledby", oh.id);
  mk("p", "hp-hint", offS, "A new set every 10 minutes, the same for everyone here.");
  var stS = mk("section", "hp-card", rootEl), sh = mk("h3", "", stS, "Your record"); sh.id = uid + "-rec"; stS.setAttribute("aria-labelledby", sh.id);
  var stBox = mk("div", "", stS);
  var sig = "";
  function roving(){
    var bs = Array.prototype.slice.call(ul.querySelectorAll("button"));
    var on = bs.filter(function(b){ return b === doc.activeElement; })[0] || bs[0];
    bs.forEach(function(b){ b.tabIndex = b === on ? 0 : -1; });
  }
  ul.addEventListener("keydown", function(e){
    var bs = Array.prototype.slice.call(ul.querySelectorAll("button")), i = bs.indexOf(doc.activeElement);
    if(i < 0 || !bs.length) return;
    var j = e.key === "ArrowDown" ? Math.min(bs.length - 1, i + 1) : e.key === "ArrowUp" ? Math.max(0, i - 1) : e.key === "Home" ? 0 : e.key === "End" ? bs.length - 1 : -1;
    if(j < 0) return;
    if(e.preventDefault) e.preventDefault();
    bs.forEach(function(b, k){ b.tabIndex = k === j ? 0 : -1; });
    if(bs[j].focus) bs[j].focus();
  });
  function drawOffers(a){
    var foc = Array.prototype.slice.call(ul.querySelectorAll("button")).indexOf(doc.activeElement);
    while(ul.firstChild) ul.removeChild(ul.firstChild);
    var L = F.offers(), me = host && typeof host.me === "function" ? (function(){ try { return host.me(); } catch(e){ return null; } })() : null;
    if(!L.length) mk("li", "hp-muted", ul, "No jobs around here right now. Try another street.");
    L.forEach(function(o){
      var li = mk("li", "hp-achrow", ul), top = mk("div", "hp-achtop", li);
      var nm = mk("b", "", top, o.title);
      var away = me && isFinite(+me.x) ? fmtDist(Math.hypot(o.from.x - me.x, o.from.z - me.z)) + " away · " : "";
      mk("span", "hp-legsub", li, o.from.label);
      mk("span", "hp-legsub", li, away + o.stops.length + (o.stops.length === 1 ? " drop" : " drops") + " · " + fmtDist(o.dist) + " · about " + o.base + " rep");
      var b = btn(li, "Start", "hp-primary", function(){
        var r = F.start(o.id);
        announce(r.ok ? o.title + " started" : r.reason === "busy" ? "Finish or cancel your job first" : r.reason === "blocked" ? "That place is blocked right now" : "That job has gone");
        if(r.ok && nav && nav.close) nav.close();
        draw();
      }, "Start " + o.title + ": " + o.from.label);
      b.disabled = !!a;
      nm.id = uid + "-o" + ul.children.length;
    });
    roving();
    var bs = ul.querySelectorAll("button");
    if(foc >= 0 && bs.length){ var t = bs[Math.min(foc, bs.length - 1)]; if(t.focus) t.focus(); }
  }
  function drawStats(){
    while(stBox.firstChild) stBox.removeChild(stBox.firstChild);
    var s = F.stats(), dl = mk("dl", "hp-pass-grid", stBox);
    [["City rep", String(s.rep)], ["Streak", String(s.streak)], ["Best streak", String(s.bestStreak)]].forEach(function(r){ var d = mk("div", "", dl); mk("dt", "", d, r[0]); mk("dd", "", d, r[1]); });
    var kl = mk("ul", "hp-list", stBox); kl.setAttribute("aria-label", "By kind");
    KINDS.forEach(function(k){
      var rk = rankOf(s.done[k]), li = mk("li", "", kl);
      mk("b", "", li, NAMES[k] + ": " + rk.name);
      mk("span", "hp-legsub", li, " · " + s.done[k] + " done · best tip " + s.best[k] + (rk.next ? " · " + rk.next.left + " to " + rk.next.name : ""));
    });
  }
  function drawCur(a){
    cur.hidden = !a;
    if(!a) return;
    curText.textContent = a.title + ": " + a.text;
    curSub.textContent = fmtClock(a.left) + " left · " + fmtDist(a.dist) + " · stop " + a.step + " of " + (a.of - 1) + (a.ok ? "" : " · " + NEED[a.kind]);
  }
  function draw(){
    var a = F.active(), L = F.offers(), s2 = (a ? a.id + ":" + a.step : "-") + "|" + L.map(function(o){ return o.id; }).join(",");
    drawCur(a);
    if(s2 !== sig){ sig = s2; drawOffers(a); drawStats(); }
  }
  cancel.setAttribute("aria-describedby", ch.id);
  draw();
  var off = F.onChange(function(){ sig = ""; draw(); });
  return {tick: function(){ draw(); }, dispose: function(){ off(); }};
}
(HQV.hqPhoneQueue = HQV.hqPhoneQueue || []).push({id: "jobs", name: "Jobs", order: 40, glyph: GLYPH, dock: false, needsCity: true, render: render});
API.render = render;
})();
