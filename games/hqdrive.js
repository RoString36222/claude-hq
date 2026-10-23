/* Claude HQ 3.12: driving feel and convoys for the City's cars, motorbikes and bicycles (HQV.hqDrive).
 * games/hq3d.js wires it in (rideMove, placePeers, the drive HUD); everything here is feature-detected there.
 *
 * Pure half (no THREE, no DOM; tests/test_hqdrive.py runs it under node):
 *   lightsAuto(night, wx) / lightsOn(night, wx, manual)   headlights: on at night, in heavy rain, a storm, snow or fog;
 *                                                         manual (L) true / false wins, null is automatic
 *   wxOf(kind)                                            the weather's numbers for a kind (HQV.hqWeather.LOOK, else a copy)
 *   wxEase(a, b, k)                                       eased toward b by k (0..1), field by field
 *   gripOf(wx, base)  -> {lat, brake, top, kind}          tyre grip in the wet and the snow (base: car | moto | bike)
 *   slideOf(S, g)     -> the powerslide tuned to that grip (a copy; S is VEHICLES[k].slide)
 *   damage: hitAmount(v), dmgAdd(st, v, side), dmgSmoke(st), dmgCracked(st), dmgLoad / dmgSave /
 *           dmgRepair / dmgRepairAll / dmgAll (localStorage "hq3d.damage.v1", keyed by the vehicle's own key)
 *   convoy: slotOf(i, air), slotPoint(L, s, lead), assist(me, L, s, air), inForm(dist, air), followersOf(peers, uid),
 *           convoyNew(), convoyStep(C, o), convoyKey(C, o), convoyNet(C, o)
 *   carpool (3.15): poolSeats(base, type, seats, band) how many it carries (the driver too), poolSeat(me, driver, list, n, mine)
 *           the passenger seat to take (1..n-1; 0: full)
 * Drawing half (needs THREE): beam(T, rig, o) a headlight pool and a faint cone in one additive mesh; fx(T, scene)
 *   wet-road spray and engine smoke in one Points; dent(T, rig, st, key) / undent(rig) the cosmetic damage;
 *   lights(rig, on, cracked) the lamps.
 * Presence (the Arena's "convoy" capability): ci (the user you invite), cv (the leader you follow), cg ([x, z] in cm:
 * the leader's Go to destination). User ids and a map point only; nothing else leaves this page.
 */
(function(){
"use strict";
var root = typeof window !== "undefined" ? window : globalThis;
var HQV = root.HQV = root.HQV || {};

function clamp(v, a, b){ v = +v; if(!(v === v)) v = a; return v < a ? a : (v > b ? b : v); }
function hashStr(s){ var h = 2166136261 >>> 0; s = String(s); for(var i = 0; i < s.length; i++){ h ^= s.charCodeAt(i); h = Math.imul(h, 16777619) >>> 0; } return h >>> 0; }
function mulberry32(a){ return function(){ a |= 0; a = a + 0x6D2B79F5 | 0; var t = Math.imul(a ^ a >>> 15, 1 | a); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0)/4294967296; }; }
function angDiff(a, b){ return Math.atan2(Math.sin(a - b), Math.cos(a - b)); }

/* ---------- lights ---------- */
// the weather's numbers, when hqweather.js is not here (kept in step with its LOOK table by a test)
var WX = {clear: {rain: 0, snow: 0, storm: 0, fogFar: 1600}, cloudy: {rain: 0, snow: 0, storm: 0, fogFar: 1150},
          rain: {rain: 0.7, snow: 0, storm: 0, fogFar: 620}, storm: {rain: 1, snow: 0, storm: 1, fogFar: 460},
          snow: {rain: 0, snow: 1, storm: 0, fogFar: 540}, fog: {rain: 0, snow: 0, storm: 0, fogFar: 165}};
function wxOf(kind){
  var L = HQV.hqWeather && HQV.hqWeather.LOOK && HQV.hqWeather.LOOK[kind], W = WX[kind] || WX.clear;
  return L ? {rain: +L.rain || 0, snow: +L.snow || 0, storm: +L.storm || 0, fogFar: +L.fogFar || 1600} : {rain: W.rain, snow: W.snow, storm: W.storm, fogFar: W.fogFar};
}
function wxEase(a, b, k){
  a = a || wxOf("clear"); b = b || a; k = clamp(k, 0, 1);
  return {rain: a.rain + (b.rain - a.rain)*k, snow: a.snow + (b.snow - a.snow)*k, storm: a.storm + (b.storm - a.storm)*k, fogFar: a.fogFar + (b.fogFar - a.fogFar)*k};
}
// heavy weather: rain at its full (a shower's 0.7 counts), any storm, falling snow, a fog you see 250 m into at most
function lightsAuto(night, wx){
  wx = wx || {};
  return !!night || (+wx.rain || 0) >= 0.6 || (+wx.storm || 0) >= 0.5 || (+wx.snow || 0) >= 0.6 || (wx.fogFar != null && +wx.fogFar < 250);
}
function lightsOn(night, wx, manual){ return manual === true ? true : manual === false ? false : lightsAuto(night, wx); }

/* ---------- grip ---------- */
// lat: how hard the tyres hold sideways (the slide catches slower, the tail lets go sooner); brake: how hard they can
// stop (stopping distance goes as 1/brake); top: a bicycle and a motorbike ride carefully (a lower top speed).
// A snowy road is worse than a wet one; two wheels lose more than four. Noticeable, still fun: never below 0.45.
function gripOf(wx, base){
  wx = wx || {};
  var rain = clamp(Math.max(+wx.rain || 0, (+wx.wet || 0)*0.8), 0, 1), snow = clamp(+wx.snow || 0, 0, 1), two = base === "moto" || base === "bike";
  var lat = 1 - 0.3*rain*(two ? 1.25 : 1) - 0.42*snow*(two ? 1.2 : 1);
  var brake = 1 - 0.35*rain*(two ? 1.15 : 1) - 0.5*snow;
  var top = two ? 1 - 0.1*rain - 0.25*snow : 1 - 0.08*snow;
  return {lat: clamp(lat, 0.45, 1), brake: clamp(brake, 0.45, 1), top: clamp(top, 0.6, 1),
          kind: snow > 0.3 ? "snow" : rain > 0.3 ? "wet" : null};
}
// the powerslide on that grip: it starts slower (min), the tail swings further (max) and comes back slower (grip)
function slideOf(S, g){
  if(!S) return null;
  var lat = g && g.lat ? clamp(g.lat, 0.45, 1) : 1;
  if(lat >= 0.999) return S;
  return {min: S.min*(0.55 + 0.45*lat), turn: S.turn, grip: S.grip*lat, max: S.max*Math.min(1.35, 1/lat), bleed: S.bleed*(0.7 + 0.3*lat)};
}
var GRIP_LABEL = {wet: "Wet road", snow: "Snow"}, GRIP_ICON = {wet: "💧", snow: "❄️"};

/* ---------- damage (cosmetic) ---------- */
// st = {d (0..1 overall), f (front), r (rear), n (hits so far), hits: [{s: "f" | "r", a}]}; a hit under DMG_MIN m/s
// (about 22 km/h) leaves no mark
var DMG_MIN = 6, DMG_HITS = 12, DMG_LS = "hq3d.damage.v1", DMG_KEEP = 40, KEY_RE = /^[A-Za-z0-9:_.-]{1,80}$/;
function dmgNew(){ return {d: 0, f: 0, r: 0, n: 0, hits: []}; }
function dmgNorm(st){
  var o = dmgNew(); if(!st || typeof st !== "object") return o;
  o.d = clamp(st.d || 0, 0, 1); o.f = clamp(st.f || 0, 0, 1); o.r = clamp(st.r || 0, 0, 1); o.n = Math.max(0, st.n | 0);
  o.hits = (Array.isArray(st.hits) ? st.hits : []).filter(function(h){ return h && (h.s === "f" || h.s === "r"); })
    .slice(-DMG_HITS).map(function(h){ return {s: h.s, a: clamp(h.a || 0, 0, 1), i: Math.max(0, h.i | 0)}; });
  return o;
}
function hitAmount(v){ v = Math.abs(+v || 0); return v < DMG_MIN ? 0 : Math.min(0.35, (v - DMG_MIN)*0.035 + 0.02); }
function dmgAdd(st, v, side){
  var o = dmgNorm(st), a = hitAmount(v); if(!a) return o;
  side = side === "r" ? "r" : "f";
  o.d = Math.min(1, o.d + a); o[side] = Math.min(1, o[side] + a*1.4);
  o.hits.push({s: side, a: Math.round(a*1000)/1000, i: o.n}); if(o.hits.length > DMG_HITS) o.hits.shift();
  o.n++;
  return o;
}
function dmgCracked(st){ return !!st && (+st.f || 0) >= 0.45; }
function dmgSmoke(st){ return !!st && (+st.d || 0) >= 0.7; }
var store = {get: function(k){ try { return root.localStorage ? root.localStorage.getItem(k) : null; } catch(e){ return null; } },
             set: function(k, v){ try { if(root.localStorage) root.localStorage.setItem(k, v); } catch(e){} }};
function dmgAll(){ var j = null; try { j = JSON.parse(store.get(DMG_LS) || "null"); } catch(e){ j = null; } return j && typeof j === "object" && !Array.isArray(j) ? j : {}; }
function dmgLoad(key){ if(!KEY_RE.test(String(key || ""))) return dmgNew(); var all = dmgAll(); return dmgNorm(all[key]); }
function dmgSave(key, st){
  if(!KEY_RE.test(String(key || ""))) return false;
  var all = dmgAll(), o = dmgNorm(st);
  if(o.d <= 0) delete all[key]; else { delete all[key]; all[key] = o; }
  var ks = Object.keys(all); while(ks.length > DMG_KEEP){ delete all[ks.shift()]; }   // the oldest first
  store.set(DMG_LS, JSON.stringify(all));
  return true;
}
function dmgRepair(key){ var had = dmgLoad(key).d > 0; if(KEY_RE.test(String(key || ""))){ var all = dmgAll(); delete all[key]; store.set(DMG_LS, JSON.stringify(all)); } return had; }
function dmgRepairAll(){ var n = Object.keys(dmgAll()).length; store.set(DMG_LS, "{}"); return n; }

/* ---------- convoys ---------- */
var INVITE_R = 40, INVITE_TTL = 30, LEAVE_R = 300, MAX_FOLLOW = 6, UID_RE = /^[A-Za-z0-9_-]{1,64}$/;
// slot i (0 first): on the road behind-left, behind-right, then the next row back (model-local +x is LEFT);
// in the air a wider, higher echelon
function slotOf(i, air){
  i = Math.max(0, i | 0); var row = Math.floor(i/2) + 1, side = i % 2 ? -1 : 1;
  return air ? {side: side*14*row, back: 22*row, up: 4*row} : {side: side*2.6, back: 8*row, up: 0};
}
// where slot s is now, behind the leader L {x, z, y, yaw, vx, vz} carried on `lead` seconds along its velocity
function slotPoint(L, s, lead){
  L = L || {}; s = s || slotOf(0); lead = +lead || 0;
  var x = (+L.x || 0) + (+L.vx || 0)*lead, z = (+L.z || 0) + (+L.vz || 0)*lead, yaw = +L.yaw || 0, sy = Math.sin(yaw), cy = Math.cos(yaw);
  return {x: x - sy*s.back + cy*s.side, z: z - cy*s.back - sy*s.side, y: (+L.y || 0) + s.up, yaw: yaw};
}
function inForm(dist, air){ return dist < (air ? 18 : 4); }
// The soft assist (held J): steer for a point a little ahead of the slot along the leader's heading (so you line up
// with them, not just arrive), and hold the leader's speed plus a pull toward the slot along the road.
// me {x, z, yaw, speed}; L the leader; s its slot -> {steer -1..1, thr -1..1, dist, along, ok}
function assist(me, L, s, air){
  me = me || {}; L = L || {};
  var P = slotPoint(L, s, 0.25), spL = Math.hypot(+L.vx || 0, +L.vz || 0), spd = +me.speed || 0;
  var look = clamp(spd*0.6 + 4, 4, 14), ax = P.x + Math.sin(P.yaw)*look, az = P.z + Math.cos(P.yaw)*look;
  var dx = P.x - (+me.x || 0), dz = P.z - (+me.z || 0), dist = Math.hypot(dx, dz);
  var along = dx*Math.sin(P.yaw) + dz*Math.cos(P.yaw);
  var want = dist > 30 ? Math.atan2(dx, dz) : Math.atan2(ax - (+me.x || 0), az - (+me.z || 0));
  var steer = clamp(angDiff(want, +me.yaw || 0)*2.2, -1, 1);
  var wantV = Math.max(0, spL + clamp(along*0.6, -6, 8));
  if(dist < 1.5 && spL < 0.5) wantV = 0;
  var thr = clamp((wantV - spd)*0.35, -1, 1);
  return {steer: steer, thr: thr, dist: dist, along: along, ok: inForm(dist, air)};
}
// who follows uid, in a stable order (everyone works out the same slots): [uid...]
function followersOf(peers, uid, me, meFollows){
  var out = [];
  (peers || []).forEach(function(p){ if(p && typeof p.u === "string" && p.cv === uid) out.push(p.u); });
  if(me && meFollows === uid && out.indexOf(me) < 0) out.push(me);
  return out.sort().slice(0, 64);
}
function convoyNew(){ return {lead: null, invite: null, invAt: 0, pending: null, pendName: "", said: {}, members: [], role: null}; }
function peerOf(peers, u){ for(var i = 0; i < (peers || []).length; i++) if(peers[i] && peers[i].u === u) return peers[i]; return null; }
function dist2(a, b){ return Math.hypot((+a.x || 0) - (+b.x || 0), (+a.z || 0) - (+b.z || 0)); }
// One step: o = {me, peers [{u, n, w, x, z (m), cv, ci}], world, pos {x, z}, now (s)}. -> events [{t, u, n, why?}]
//   invited (someone near you invites you), joined (someone took your invite), left (you left: why far | world | gone)
function convoyStep(C, o){
  var ev = [], me = o.me, peers = o.peers || [], now = +o.now || 0;
  if(!me){ if(C.lead || C.invite){ C.lead = null; C.invite = null; } C.members = []; C.role = null; return ev; }
  if(C.lead){
    var L = peerOf(peers, C.lead);
    var why = !L ? "gone" : L.w !== o.world ? "world" : dist2(L, o.pos || {}) > LEAVE_R ? "far" : null;
    if(why){ ev.push({t: "left", u: C.lead, n: L ? L.n : C.leadName, why: why}); C.lead = null; }
    else C.leadName = L.n || "Visitor";
  }
  if(C.invite){
    var I = peerOf(peers, C.invite);
    if(I && I.cv === me){ ev.push({t: "joined", u: C.invite, n: I.n}); C.invite = null; }
    else if(!I || now - C.invAt > INVITE_TTL) C.invite = null;
  }
  // an invitation to you: someone in this world, near you, naming you (not while you follow someone)
  var inv = null;
  if(!C.lead) peers.forEach(function(p){ if(!inv && p && p.ci === me && p.w === o.world && dist2(p, o.pos || {}) <= INVITE_R*1.5) inv = p; });
  if(inv && C.pending !== inv.u){ C.pending = inv.u; C.pendName = inv.n || "Visitor"; ev.push({t: "invited", u: inv.u, n: C.pendName}); }
  else if(!inv) C.pending = null;
  // who is in it: the leader, then the followers in slot order
  var lead = C.lead || (followersOf(peers, me).length ? me : null);
  C.role = !lead ? null : lead === me ? "lead" : "follow";
  C.members = lead ? [lead].concat(followersOf(peers, lead, me, C.lead)).filter(function(u, i, a){ return a.indexOf(u) === i; }) : [];
  return ev;
}
// Y: accept an invitation; else leave the convoy you follow; else invite the nearest player within INVITE_R.
// o = {me, peers, world, pos, now, target?: a uid to invite} -> {t: "joined" | "left" | "invited" | "none" | "busy", u?, n?}
function convoyKey(C, o){
  var me = o.me, peers = o.peers || [], now = +o.now || 0;
  if(!me) return {t: "none"};
  if(C.pending && !o.target){
    if(followersOf(peers, me).length) return {t: "busy"};               // a leader does not join someone else
    var P = peerOf(peers, C.pending); C.lead = C.pending; C.leadName = C.pendName; C.pending = null; C.invite = null;
    return {t: "joined", u: C.lead, n: P ? P.n : C.leadName};
  }
  if(C.lead && !o.target){ var was = C.lead; C.lead = null; return {t: "left", u: was, n: C.leadName, why: "key"}; }
  if(C.lead) return {t: "busy"};
  var best = null, bd = INVITE_R + 1e-9;
  peers.forEach(function(p){
    if(!p || typeof p.u !== "string" || !UID_RE.test(p.u) || p.w !== o.world || p.cv === me) return;
    if(o.target && p.u !== o.target) return;
    var d = dist2(p, o.pos || {}); if(d <= bd){ bd = d; best = p; }
  });
  if(!best) return {t: "none"};
  if(followersOf(peers, me).length >= MAX_FOLLOW) return {t: "full"};
  C.invite = best.u; C.invAt = now;
  return {t: "invited", u: best.u, n: best.n || "Visitor"};
}
// what presence carries: ci while an invitation is open, cv while you follow, cg while you lead with a route
/* ---------- [3.15] carpooling: a passenger seat in someone's car, behind them on a bike or a scooter ---------- */
// how many it carries, the driver too: a car four (a coupe, a hypercar, a supercar and the starter hatchback two), a
// scooter three, a super sports bike only its rider (a hypersport, a sport bike over 950 cc: no pillion), any other
// bike two (base: car | moto | bike, the bicycle; type / band: the catalogue class's, or null; seats: the catalogue
// entry's own count, 1-4, when it gives one)
var POOL_TWO = {coupe: 1, hyper: 1, "super": 1};
function poolSeats(base, type, seats, band){
  if(base === "tank") return 4;                    // [3.16] games/hqtank.js: its driver, its gunner (seat 1), two on the back
  if(!(base === "car" || base === "moto" || base === "bike")) return 0;
  if(seats === (seats | 0) && seats >= 1 && seats <= 4) return seats;
  if(base === "car") return !type || POOL_TWO[type] ? 2 : 4;
  if(base === "moto") return type === "scooter" ? 3 : type === "hypersport" || (type === "sport" && band === "over950") ? 1 : 2;
  return base === "bike" ? 2 : 0;
}
// the seat to take in driver's vehicle (n seats): list [{u, pb, ps}] is everyone here; mine the seat you hold (0: none).
// Two who take one seat at once: the lower user id keeps it, the other moves to a free one (0: none left)
function poolSeat(me, driver, list, n, mine){
  var taken = {};
  (list || []).forEach(function(p){
    if(!p || p.u === me || p.pb !== driver || !(p.ps >= 1 && p.ps < n)) return;
    if(mine && p.ps === mine && String(p.u) > String(me)) return;   // yours: you were first by id
    taken[p.ps] = 1;
  });
  if(mine >= 1 && mine < n && !taken[mine]) return mine;
  for(var i = 1; i < n; i++) if(!taken[i]) return i;
  return 0;
}
function convoyNet(C, o){
  o = o || {}; var m = {};
  if(C.invite && UID_RE.test(C.invite)) m.ci = C.invite;
  if(C.lead && UID_RE.test(C.lead)) m.cv = C.lead;
  if(C.role === "lead" && o.route && isFinite(o.route.x) && isFinite(o.route.z))
    m.cg = [Math.round(clamp(o.route.x, -1024, 1024)*100), Math.round(clamp(o.route.z, -1024, 1024)*100)];
  return m.ci || m.cv || m.cg ? m : null;
}

/* ---------- drawing (THREE) ---------- */
var texCache = null;
// one canvas: the left half a soft oval pool of light, the right half a beam fading along its length
function beamTex(T){
  if(texCache && texCache.T === T) return texCache.t;
  var c = root.document.createElement("canvas"); c.width = 128; c.height = 64; var g = c.getContext("2d");
  var rg = g.createRadialGradient(32, 40, 2, 32, 40, 32);
  rg.addColorStop(0, "rgba(255,255,255,1)"); rg.addColorStop(0.5, "rgba(255,255,255,0.45)"); rg.addColorStop(1, "rgba(255,255,255,0)");
  g.fillStyle = rg; g.fillRect(0, 0, 64, 64);
  var lg = g.createLinearGradient(0, 0, 0, 64);                 // v = 0 at the far end, 1 at the lamp
  lg.addColorStop(0, "rgba(255,255,255,0)"); lg.addColorStop(1, "rgba(255,255,255,0.9)");
  g.fillStyle = lg; g.fillRect(64, 0, 64, 64);
  var t = new T.CanvasTexture(c); if(T.SRGBColorSpace) t.colorSpace = T.SRGBColorSpace;
  texCache = {T: T, t: t};
  return t;
}
// the size of a rig as built (once), in its own frame: {minZ, maxZ, w (half width), h (height)}
function rigBox(T, rig){
  if(rig._box) return rig._box;
  var b = new T.Box3(), g = rig.g, q = g.quaternion.clone(), p = g.position.clone(), s = g.scale.clone(), par = g.parent;
  if(par) par.remove(g);
  g.position.set(0, 0, 0); g.quaternion.identity(); g.scale.set(1, 1, 1); g.updateMatrixWorld(true);
  b.setFromObject(g);
  g.position.copy(p); g.quaternion.copy(q); g.scale.copy(s); if(par) par.add(g);
  var ok = isFinite(b.min.z) && isFinite(b.max.z);
  rig._box = ok ? {minZ: b.min.z, maxZ: b.max.z, w: Math.max(0.2, (b.max.x - b.min.x)/2), h: Math.max(0.3, b.max.y)} : {minZ: -2, maxZ: 2, w: 0.9, h: 1.4};
  return rig._box;
}
// The headlights' light: a pool on the road ahead and a faint cone from the lamps to it, one additive mesh, one
// material (o.shared: one for everyone else's vehicles), no real light. Added to rig.g; hidden until lights(on).
var sharedMat = null;
function beamMat(T, shared){
  var mk = function(){ return new T.MeshBasicMaterial({map: beamTex(T), color: 0xfff0c8, transparent: true, opacity: 0.55, blending: T.AdditiveBlending,
                                                       depthWrite: false, toneMapped: false, side: T.DoubleSide}); };
  if(!shared) return mk();
  if(!sharedMat || sharedMat.T !== T){ sharedMat = {T: T, m: mk()}; sharedMat.m.opacity = 0.5; sharedMat.m.userData.shared = true; }
  return sharedMat.m;
}
function beam(T, rig, o){
  if(!T || !rig || !rig.g) return null;
  if(rig._beam) return rig._beam;
  o = o || {};
  var B = rigBox(T, rig), two = o.base === "moto" || o.base === "bike", front = B.maxZ - 0.05;
  var len = two ? (o.base === "bike" ? 6 : 10) : 13, wN = two ? 0.5 : B.w*0.9, wF = two ? 2.4 : B.w*3.2, ly = two ? Math.min(1.1, B.h*0.62) : Math.min(0.9, B.h*0.45);
  var z0 = front + 0.4, z1 = front + len, gy = 0.04;
  // the pool (u 0..0.5) and the cone, a sheet from the lamps down to the road (u 0.5..1; v 1 at the lamps)
  var pos = [ -wN, gy, z0,  wN, gy, z0,  wF, gy, z1,  -wF, gy, z1,
              -wN*0.6, ly, front, wN*0.6, ly, front, wF*0.8, gy + 0.05, z1*0.85 + front*0.15, -wF*0.8, gy + 0.05, z1*0.85 + front*0.15];
  var uv = [0, 0.15, 0.5, 0.15, 0.5, 1, 0, 1,    0.52, 1, 0.98, 1, 0.98, 0, 0.52, 0];
  var idx = [0, 1, 2, 0, 2, 3, 4, 5, 6, 4, 6, 7];
  var geo = new T.BufferGeometry();
  geo.setAttribute("position", new T.Float32BufferAttribute(pos, 3)); geo.setAttribute("uv", new T.Float32BufferAttribute(uv, 2)); geo.setIndex(idx);
  geo.computeBoundingSphere();
  var m = new T.Mesh(geo, beamMat(T, !!o.shared)); m.name = "hq-beam"; m.visible = false; m.renderOrder = 2; m.castShadow = false; m.receiveShadow = false;
  m.userData.base = two ? 0.5 : 0.6;
  rig.g.add(m); rig._beam = m;
  return m;
}
// lamps on or off (and a cracked headlight flickering dim): the model's own glow (rig.lights) and its beam; dim
// (0..1, 1 by night) fades the beam in daylight, where an additive pool would only wash the road out
function lights(rig, on, cracked, t, calm, dim){
  if(!rig) return;
  on = !!on;
  if(rig.lights && rig._lightsOn !== on + ":" + !!cracked){ rig._lightsOn = on + ":" + !!cracked; rig.lights(on, !!cracked); }
  var b = rig._beam; if(!b) return;
  b.visible = on;
  var k = dim == null ? 1 : clamp(dim, 0, 1);
  if(on && b.material.userData.shared) b.material.opacity = 0.5*k;      // one material for everyone else's: one value
  else if(on){
    var f = cracked ? (calm ? 0.55 : 0.5 + 0.12*Math.sin((+t || 0)*23) + 0.08*Math.sin((+t || 0)*7.3)) : 1;
    b.material.opacity = b.userData.base*f*k;
  }
}
// Wet-road spray and engine smoke, one Points of N particles in world space (your vehicle only). step() spawns
// and moves them on the CPU (N floats a frame); nothing is drawn while none is alive.
function fx(T, scene, n){
  n = Math.max(8, Math.min(128, n | 0 || 72));
  var pos = new Float32Array(n*3), col = new Float32Array(n*3), P = [], rnd = mulberry32(hashStr("hq-drive-fx"));
  for(var i = 0; i < n; i++){ P.push({life: 0, x: 0, y: -999, z: 0, vx: 0, vy: 0, vz: 0, smoke: false}); pos[i*3 + 1] = -999; }
  var geo = new T.BufferGeometry();
  geo.setAttribute("position", new T.BufferAttribute(pos, 3)); geo.setAttribute("color", new T.BufferAttribute(col, 3));
  var mat = new T.PointsMaterial({size: 0.55, vertexColors: true, transparent: true, opacity: 0.55, depthWrite: false, sizeAttenuation: true});
  var pts = new T.Points(geo, mat); pts.frustumCulled = false; pts.visible = false; pts.renderOrder = 3; pts.name = "hq-drive-fx";
  if(scene) scene.add(pts);
  var next = 0, sprayAcc = 0, smokeAcc = 0, alive = 0, was = 0;
  function spawn(x, y, z, vx, vy, vz, life, smoke){
    var p = P[next]; next = (next + 1) % n;
    p.x = x; p.y = y; p.z = z; p.vx = vx; p.vy = vy; p.vz = vz; p.life = life; p.max = life; p.smoke = smoke;
  }
  return {
    pts: pts,
    // s = {x, z, y (ground), yaw, speed, rain 0..1, smoke bool, back (m behind the centre), front, w (half width), calm}
    step: function(dt, s){
      dt = Math.max(0, Math.min(0.05, +dt || 0)); s = s || {};
      if(!s.calm && s.x != null){
        var sy = Math.sin(s.yaw || 0), cy = Math.cos(s.yaw || 0), v = Math.abs(s.speed || 0);
        var spray = (s.rain || 0) > 0.25 && v > 7 ? Math.min(1, (v - 7)/12)*(s.rain || 0) : 0;
        sprayAcc += spray*60*dt;
        while(sprayAcc >= 1){
          sprayAcc -= 1;
          var side = rnd() < 0.5 ? -1 : 1, bx = s.x - sy*(s.back || 1.6) + cy*side*(s.w || 0.8), bz = s.z - cy*(s.back || 1.6) - sy*side*(s.w || 0.8);
          spawn(bx, (s.y || 0) + 0.15, bz, -sy*v*0.25 + (rnd() - 0.5)*1.4 + cy*side*0.8, 1 + rnd()*1.6, -cy*v*0.25 + (rnd() - 0.5)*1.4 - sy*side*0.8, 0.45 + rnd()*0.3, false);
        }
        smokeAcc += s.smoke ? 9*dt : 0;
        while(smokeAcc >= 1){
          smokeAcc -= 1;
          var fx0 = s.x + sy*(s.front || 1.4), fz0 = s.z + cy*(s.front || 1.4);
          spawn(fx0 + (rnd() - 0.5)*0.4, (s.y || 0) + (s.h || 1) , fz0 + (rnd() - 0.5)*0.4, (rnd() - 0.5)*0.4, 0.9 + rnd()*0.5, (rnd() - 0.5)*0.4, 1.4 + rnd()*0.8, true);
        }
      }
      alive = 0;
      for(var i = 0; i < n; i++){
        var p = P[i];
        if(p.life <= 0){ pos[i*3 + 1] = -999; continue; }
        p.life -= dt; alive++;
        p.vy -= (p.smoke ? -0.3 : 6)*dt; p.x += p.vx*dt; p.y += p.vy*dt; p.z += p.vz*dt;
        var k = Math.max(0, p.life/(p.max || 1));
        pos[i*3] = p.x; pos[i*3 + 1] = p.life > 0 ? p.y : -999; pos[i*3 + 2] = p.z;
        var c = p.smoke ? 0.22 + 0.25*(1 - k) : 0.78*k + 0.1;
        col[i*3] = c; col[i*3 + 1] = c; col[i*3 + 2] = p.smoke ? c : c*1.06;
      }
      pts.visible = alive > 0;
      if(alive || was){ geo.attributes.position.needsUpdate = true; geo.attributes.color.needsUpdate = true; }
      was = alive;
      return alive;
    },
    clear: function(){ for(var i = 0; i < n; i++){ P[i].life = 0; pos[i*3 + 1] = -999; } pts.visible = false; geo.attributes.position.needsUpdate = true; },
    dispose: function(){ if(pts.parent) pts.parent.remove(pts); geo.dispose(); mat.dispose(); }
  };
}
// Dents: the body panels (the meshes painted in the body colour) pushed in round each hit, front or back, deterministic
// for that vehicle and hit; their geometry is copied the first time (shared blueprints stay untouched), and the paint
// scuffed (rougher, duller) with the damage. Nothing is done, and nothing costs anything, while there is no damage.
function paintMeshes(rig){
  var out = [];
  rig.g.traverse(function(o){ if(o.isMesh && o.material && (o.userData.mk === "paint" || (rig.paint && o.material === rig.paint))) out.push(o); });
  return out;
}
function dent(T, rig, st, key){
  if(!T || !rig || !rig.g) return false;
  st = dmgNorm(st);
  var sig = st.n + ":" + Math.round(st.d*100);
  if(rig._dentSig === sig) return false;
  if(st.d <= 0){ undent(rig); rig._dentSig = sig; return true; }
  var B = rigBox(T, rig), ms = paintMeshes(rig); if(!ms.length) return false;
  rig.g.updateMatrixWorld(true);
  var inv = new T.Matrix4().copy(rig.g.matrixWorld).invert(), M = new T.Matrix4(), Mi = new T.Matrix4(), v = new T.Vector3(), mats = [];
  var centres = st.hits.map(function(h){
    var r = mulberry32(hashStr(String(key || "v") + ":" + h.i));
    return {x: (r()*2 - 1)*B.w*0.75, y: B.h*(0.3 + r()*0.35), z: h.s === "f" ? B.maxZ : B.minZ, dir: h.s === "f" ? -1 : 1, a: h.a, r: 0.45 + r()*0.3, seed: r};
  });
  ms.forEach(function(m){
    var geo = m.geometry;
    if(!m.userData.dent0){
      geo = m.geometry = m.geometry.clone();
      m.userData.dent0 = new Float32Array(geo.attributes.position.array);
    }
    var P = geo.attributes.position, A = P.array, O = m.userData.dent0;
    M.multiplyMatrices(inv, m.matrixWorld); Mi.copy(M).invert();
    for(var i = 0; i < P.count; i++){
      v.set(O[i*3], O[i*3 + 1], O[i*3 + 2]).applyMatrix4(M);
      var dz = 0, dx = 0;
      for(var c = 0; c < centres.length; c++){
        var C = centres[c], dd = Math.hypot(v.x - C.x, (v.y - C.y)*1.3, (v.z - C.z)*0.8);
        if(dd >= C.r) continue;
        var f = 1 - dd/C.r, crumple = 0.7 + 0.3*Math.sin(i*12.9898 + c*78.233);
        dz += C.dir*C.a*0.45*f*f*crumple; dx += (v.x > C.x ? -1 : 1)*C.a*0.08*f*crumple;
      }
      v.z += dz; v.x += dx; v.applyMatrix4(Mi);
      A[i*3] = v.x; A[i*3 + 1] = v.y; A[i*3 + 2] = v.z;
    }
    P.needsUpdate = true; geo.computeVertexNormals();
    if(mats.indexOf(m.material) < 0) mats.push(m.material);
  });
  // scratches: a duller, rougher finish
  mats.forEach(function(mt){
    if(mt.userData.r0 == null){ mt.userData.r0 = mt.roughness; mt.userData.m0 = mt.metalness; }
    mt.roughness = Math.min(1, mt.userData.r0 + 0.45*st.d); mt.metalness = mt.userData.m0*(1 - 0.5*st.d);
  });
  rig._dented = ms; rig._dentSig = sig;
  return true;
}
function undent(rig){
  if(!rig || !rig._dented) return false;
  rig._dented.forEach(function(m){
    var O = m.userData.dent0, P = m.geometry && m.geometry.attributes.position; if(!O || !P) return;
    P.array.set(O); P.needsUpdate = true; m.geometry.computeVertexNormals();
    var mt = m.material; if(mt && mt.userData.r0 != null){ mt.roughness = mt.userData.r0; mt.metalness = mt.userData.m0; }
  });
  rig._dented = null; rig._dentSig = null;
  return true;
}

HQV.hqDrive = {
  WX: WX, wxOf: wxOf, wxEase: wxEase, lightsAuto: lightsAuto, lightsOn: lightsOn,
  gripOf: gripOf, slideOf: slideOf, GRIP_LABEL: GRIP_LABEL, GRIP_ICON: GRIP_ICON,
  DMG_MIN: DMG_MIN, DMG_LS: DMG_LS, hitAmount: hitAmount, dmgNew: dmgNew, dmgNorm: dmgNorm, dmgAdd: dmgAdd, dmgCracked: dmgCracked, dmgSmoke: dmgSmoke,
  dmgAll: dmgAll, dmgLoad: dmgLoad, dmgSave: dmgSave, dmgRepair: dmgRepair, dmgRepairAll: dmgRepairAll,
  INVITE_R: INVITE_R, INVITE_TTL: INVITE_TTL, LEAVE_R: LEAVE_R, MAX_FOLLOW: MAX_FOLLOW, UID_RE: UID_RE,
  slotOf: slotOf, slotPoint: slotPoint, inForm: inForm, assist: assist, followersOf: followersOf,
  convoyNew: convoyNew, convoyStep: convoyStep, convoyKey: convoyKey, convoyNet: convoyNet, poolSeats: poolSeats, poolSeat: poolSeat,
  beam: beam, lights: lights, fx: fx, dent: dent, undent: undent, rigBox: rigBox, _store: store
};
})();
