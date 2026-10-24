/* Claude HQ 3.15: the City's transport glue (HQV.hqTransit). docs/plans/transport-revamp.md section 7.
 *
 * games/hqcity3d.js builds one per City (setupLife) and hands it the hub's state; this file wires every transport
 * module into it, each one feature-detected (a module that failed to load only takes its own feature out):
 *   Services, registered with HQV.hqRide: bus and tram (traffic.service), metro (hqMetro), the City Line (hqCityRail),
 *     the gondola (hqGondola), the water bus and launch (hqFerries) and the Island Link (hqRail.linkService, once the
 *     archipelago is known).
 *   Views: the tramway, bus and tram interiors (hqCoach), the metro (surface and underground), the City Line, the
 *     Island Link, the gondola, the water buses, Claude Cabs, the helicopter you call and the water taxi.
 *   The ride: one hqRide session at a time (startRide: a Trip or a planned journey, leg after leg), its seat camera
 *     (V cycles seat, window, chase), S requests the stop, E gets off; the session holds you (carry) and owns the
 *     camera (camPose) while you ride; then cabs, the heli and the water taxi, in that order.
 *   E at a stop, station, platform or pier opens a board menu (the next departures, free); E at a metro entrance
 *     takes you down, on a platform "Way out" takes you up (HQV.hqUndergroundCtl).
 *   HQV.hqUnderground = {under(), set(on, reason)}: the switch. set hides the city's surface (o.surface(false) and
 *     the surface views here), swaps in a dark fog and shows the metro's underground (V.underground(on)); the
 *     avatar's ground below the street comes from the metro's walkable floors (ground / blocked).
 * Everything here is a pure function of the doc, the tier, the UTC clock and the world's seed, so every client sees
 * the same trains; nothing here talks to the network. No DOM: menus and toasts go through the hub's callbacks.
 *
 * create(c, o) -> T
 *   c = hq3d's ctx; o = {scene, W (packed), doc (raw), world (id), tier, seed, tsim (traffic sim) | null,
 *        say(text) (announce + toast), announce(text), toast(text), calm(), reduced(), night(), me() -> {x, y, z, yaw},
 *        teleport(x, y, z, yaw), surface(on) (show / hide the hub's surface groups), fade(ms), openMenu(title, items),
 *        startLink(trip, seat) -> bool (the Island Link's world trip, hqTravel mode "link"), arch() -> Promise,
 *        showRoute(pts | null, label), traffic() -> this frame's traffic list, userId}
 *   T.update(ms, dt, cam)            every frame (cam {x, y, z})
 *   T.carry(ms) / T.camPose(ms)      the hold chain (session, cabs, heli, water taxi), else null
 *   T.use(p) -> bool                 E: get off, get in, board, go down or up
 *   T.key(e) -> bool                 S (stop), V (camera) while a session holds you
 *   T.ground(x, z) -> y | null       below the street: the walkable floor (null: not underground, the hub's own)
 *   T.blocked(x, z) -> bool | null   below the street: no floor there (null: the hub decides)
 *   T.under(), T.fog, T.session(), T.startRide(planOrTrip) -> S | null, T.board(stopId, mode?) -> items
 *   T.cabs, T.heli, T.water {taxi, hire, piers, targets}, T.link(world) -> bool, T.track(vehicleId)
 *   T.peerSeat(tk, tv, uid, ms) -> {x, y, z, yaw} | null   another player's seat in their vehicle
 *   T.net() -> {tk, tv} | null      your own (presence a = 15)
 *   T.drawCalls() / T.drawCallsBy() / T.debug / T.dispose()
 */
(function(){
"use strict";
var root = typeof window !== "undefined" ? window : globalThis;
var HQV = root.HQV = root.HQV || {};

var TK = {bus: 1, tram: 2, metro: 3, rail: 4, link: 5, ferry: 6, gondola: 7, cab: 8, heli: 9};   // presence tk (1..9)
var TK_MODE = {1: "bus", 2: "tram", 3: "metro", 4: "rail", 5: "link", 6: "ferry", 7: "gondola"};
var CAMS = ["seat", "window", "chase"];
var STOP_R = 14;          // m: E reaches a stop or a pier within this
var STATION_R = 50;       // m: below ground, a platform's centre within this (a platform is 90 m long)
var UNDER_FOG = 0x0b0d10;
var MODE_WORD = {bus: "Bus", tram: "Tram", metro: "Metro", rail: "City Line", link: "Island Link", ferry: "Water bus", gondola: "Gondola"};

function num(v, d){ v = +v; return isFinite(v) ? v : d; }
function hash32(s){ s = String(s); var h = 2166136261; for(var i = 0; i < s.length; i++){ h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); } return h >>> 0; }
function tryf(f, d){ try { var v = f(); return v === undefined ? d : v; } catch(e){ return d; } }
function waitText(ms){ var s = Math.max(0, Math.round(ms/1000)); return s < 60 ? (s <= 5 ? "due" : s + " s") : Math.floor(s/60) + " min"; }

function create(c, o){
  o = o || {};
  var THREE = c && c.THREE, S = o.scene, W = o.W, worldId = String(o.world || (W && W.id) || ""), tier = Math.max(1, Math.min(5, o.tier | 0 || 5));
  var seed = o.seed != null ? o.seed : (W && (W.seed || W.id)) || worldId;
  var R = HQV.hqRide || null;
  var cS = Object.create(c || {}); cS.scene = S;                   // the modules hang their groups off this City's scene
  var dead = false, T = {fog: THREE ? new THREE.Fog(UNDER_FOG, 60, 380) : null};
  var svc = {}, V = {}, ride = null, plan = null, rideCam = 0, lastMs = 0, ctl = null, under = false, underLight = null, cabinLight = null, hidden = [];
  var cabs = null, heli = null, taxi = null, taxiH = null, IL = null, ILv = null, tracking = null;
  var pinned = false;          // the tour holds the underground view (debug.under) whatever your feet say

  function calm(){ return tryf(function(){ return !!(o.calm && o.calm()); }, false); }
  function reduced(){ return tryf(function(){ return !!(o.reduced && o.reduced()); }, false); }
  function night(){ return tryf(function(){ return !!(o.night && o.night()); }, false); }
  function say(t){ if(t && o.say) tryf(function(){ o.say(t); }); }
  function announce(t){ if(t && o.announce) tryf(function(){ o.announce(t); }); }
  function me(){ return tryf(function(){ return o.me ? o.me() : null; }, null) || {x: 0, y: 0, z: 0, yaw: 0}; }
  function audio(){ var E = HQV.engine; return tryf(function(){ return E && E.audioOut ? E.audioOut() : null; }, null); }
  function sfx(name, so){
    var a = audio(); if(!a || !R || !R.sfx) return null;
    return tryf(function(){ return R.sfx(a.ctx, name, Object.assign({dest: a.out}, so || {})); }, null);
  }
  // sound names a module uses that hqRide has no synth for, mapped to the nearest one it has: none today (Sound PR B
  // gave door, hiss, engine-hum, gangway-clank, water-lap, gondola-rumble, gondola-wind and ship-horn their own).
  // so (a module's options) passes through untouched: so.pos places the sound in the world, so.kind is its spatial kind
  var SFX_MAP = {};
  function sfxM(name, so){ var n = Object.prototype.hasOwnProperty.call(SFX_MAP, name) ? SFX_MAP[name] : name; return n ? sfx(n, so) : null; }
  // the announcer's chime goes to the master gain (the Game sounds volume, silent at 0 as every transit sound)
  var ANN = R && R.announcer ? R.announcer({announce: announce, calm: calm, audio: function(){ var a = audio(); return a && a.ctx; },
    dest: function(){ var a = audio(); return a ? a.out : null; },
    voiceOn: function(){ var P = HQV.hqPhone && HQV.hqPhone.prefs; return tryf(function(){ return P ? P.get("transitVoice") !== false && !P.get("transitTextOnly") : true; }, true); }}) : null;
  function ground(x, z){ return tryf(function(){ return HQV.world.groundAt(W, x, z); }, 0); }
  function street(x, z){ return tryf(function(){ return HQV.world.streetAt ? HQV.world.streetAt(W, x, z) : HQV.world.groundAt(W, x, z, true); }, 0); }
  // a Service: kept here, registered with hqRide while this City is the one you are in (activate: a City built ahead
  // for a voyage must not take the services of the one you still stand in)
  function active(){ return o.active ? tryf(function(){ return !!o.active(); }, true) : true; }
  function reg(s){ if(s && s.mode){ svc[s.mode] = s; if(R && R.register && active()) tryf(function(){ R.register(s); }); } return s; }

  /* ---------- the services ---------- */
  var tsim = o.tsim || null;
  if(tsim && HQV.traffic && HQV.traffic.service){
    reg(tryf(function(){ return HQV.traffic.service(tsim, "bus", {W: W}); }, null));
    reg(tryf(function(){ return HQV.traffic.service(tsim, "tram", {W: W}); }, null));
  }
  var msim = HQV.hqMetro && HQV.world && HQV.world.metroOf && HQV.world.metroOf(W) ? reg(tryf(function(){ return HQV.hqMetro.create(W, {tier: tier, seed: seed}); }, null)) : null;
  var CL = HQV.hqCityRail && HQV.world && HQV.world.railOf && HQV.world.railOf(W) ? reg(tryf(function(){ return HQV.hqCityRail.create(W, {tier: tier, seed: worldId}); }, null)) : null;
  var G1 = HQV.hqGondola && HQV.world && HQV.world.gondolaOf && HQV.world.gondolaOf(W) ? tryf(function(){ return HQV.hqGondola.create(W, {tier: tier, seed: worldId, heightAt: ground}); }, null) : null;
  if(G1 && !G1.empty) reg(G1); else G1 = null;
  var FS = HQV.hqFerries && HQV.world && HQV.world.waterOf && HQV.world.waterOf(W) ? reg(tryf(function(){ return HQV.hqFerries.create(W, {tier: tier, seed: W.id}); }, null)) : null;

  /* ---------- the views ---------- */
  function view(name, f){ var v = tryf(f, null); if(v) V[name] = v; return v; }
  if(tsim && HQV.hqTramway) view("tramway", function(){ return HQV.hqTramway.view(cS, W, tier, {sim: tsim, parent: S, night: night}); });
  if(tsim && HQV.hqCoach) view("coach", function(){ return HQV.hqCoach.view(cS, tsim, {W: W, parent: S, calm: calm, reduced: reduced, night: night, sfx: sfxM,
                                                                           traffic: function(){ return o.traffic ? o.traffic() : null; }}); });
  if(msim) view("metro", function(){ return HQV.hqMetro.view(cS, msim, {calm: calm, night: night, sfx: sfxM, under: function(){ return under; },
                                                                      me: function(){ var m = me(); return {x: m.x, y: m.y, z: m.z}; }}); });
  if(CL) view("cityrail", function(){ return HQV.hqCityRail.view(cS, CL, {W: W, ground: ground, night: night}); });
  if(G1) view("gondola", function(){ return HQV.hqGondola.view(cS, G1, {ground: ground, calm: calm, reduced: reduced(), world: worldId, sfx: sfxM}); });
  if(FS) view("ferries", function(){ return HQV.hqFerries.view(cS, FS, {calm: calm, night: night, sfx: sfxM, parent: S}); });
  // the Island Link: once the archipelago is known (where the Commons and the islands are)
  if(HQV.hqRail && HQV.hqRail.linkService && o.arch) tryf(function(){
    Promise.resolve(o.arch()).then(function(a){
      if(dead || !a) return;
      IL = tryf(function(){ return HQV.hqRail.linkService({here: worldId, W: W, arch: a, docs: {}, seed: worldId}); }, null);
      if(!IL || !(IL.lines() || []).length){ IL = null; return; }
      reg(IL);
      var seaY = W && W.island && W.island.sea_cm != null ? W.island.sea_cm/100 : 0;
      ILv = view("link", function(){ return HQV.hqRail.linkView(cS, IL, {seaY: seaY, ground: ground, under: function(){ return under; }, night: night}); });
    }, function(){});
  });

  /* ---------- the underground ---------- */
  var MV = V.metro || null;
  if(MV && HQV.hqUndergroundCtl){
    ctl = tryf(function(){ return HQV.hqUndergroundCtl.create({metro: MV, sim: msim, announce: announce, calm: function(){ return calm() || reduced(); },
      fade: function(ms){ if(o.fade) tryf(function(){ o.fade(ms); }); }, set: function(on, why){ setUnder(on, why); },
      teleport: function(p){ if(o.teleport && p) o.teleport(p.x, p.y, p.z, p.yaw); }}); }, null);
  }
  var SURFACE_VIEWS = ["tramway", "coach", "cityrail", "gondola", "ferries"];
  function setUnder(on, why){
    on = !!on;
    if(on === under) return;
    under = on;
    if(o.surface) tryf(function(){ o.surface(!on); });
    SURFACE_VIEWS.forEach(function(k){ var g = V[k] && (V[k].group || V[k].g); if(g && g.visible != null) g.visible = !on; });
    [cabs, heli].forEach(function(m){ var g = m && m.group; if(g) g.visible = !on; });
    if(MV && MV.underground) tryf(function(){ MV.underground(on); });
    if(THREE && S){
      if(on && !underLight){ underLight = new THREE.AmbientLight(0xdfe6ee, 0.35); underLight.name = "underground:fill"; }
      if(underLight){ if(on) S.add(underLight); else S.remove(underLight); }
    }
    if(o.onUnder) tryf(function(){ o.onUnder(on, why); });
  }
  var UG = {under: function(){ return under; }, set: function(on, why){ if(ctl && ctl.force) ctl.force(!!on, why || "set"); else setUnder(on, why); }};
  if(active()) HQV.hqUnderground = UG;
  T.activate = function(){
    if(dead) return;
    if(R && R.register) Object.keys(svc).forEach(function(k){ tryf(function(){ R.register(svc[k]); }); });
    HQV.hqUnderground = UG;
  };

  /* ---------- cabs, the heli you call, the water taxi ---------- */
  var callW = {W: function(){ return W; }, ground: ground, group: S, seed: worldId, now: function(){ return Date.now(); },
               me: function(){ var m = me(), mo = tryf(function(){ return c.motion ? c.motion() : null; }, null);
                               return {x: m.x, y: m.y, z: m.z, yaw: m.yaw, speed: mo ? mo.speed : 0, driving: !!(mo && mo.ride === "car"), street: true, kerbHits: T.kerbHits | 0}; },
               roofs: function(){ return o.roofs ? tryf(o.roofs, []) : []; }};
  if(HQV.hqHeliCall && HQV.hqHeliCall.mount) heli = tryf(function(){ return HQV.hqHeliCall.mount(cS, callW, {announce: announce, sfx: sfxM, calm: function(){ return calm() || reduced(); }, night: night,
    models: HQV.hqheli, paintOf: o.paintOf || null, achievements: R && R.achievements, seatCam: R && R.seatCam}); }, null);
  if(FS && HQV.hqFerries.taxiController) taxi = tryf(function(){ return HQV.hqFerries.taxiController(cS, W, {W: W, now: function(){ return Date.now(); },
    me: function(){ var m = me(); return {x: m.x, z: m.z}; }, announce: announce, sfx: sfxM, calm: calm, seed: W.id, parent: S}); }, null);
  var water = {
    taxi: function(from, to){ if(!taxi) return null; var h = tryf(function(){ return taxi.request(from || null, to); }, null); if(h) taxiH = h; return h; },
    hire: function(jetty, kind){ return HQV.hqboat && HQV.hqboat.hire ? tryf(function(){ var r = HQV.hqboat.hire(W, jetty, kind, {calm: calm()}); if(r && r.ok && o.hire) o.hire(r); return r; }, null) : null; },
    piers: function(){ return HQV.hqFerries && HQV.hqFerries.piers ? tryf(function(){ return HQV.hqFerries.piers(W); }, []) : []; },
    targets: function(from){ return HQV.hqFerries && HQV.hqFerries.taxiTargets ? tryf(function(){ return HQV.hqFerries.taxiTargets(W, from); }, []) : []; },
    kinds: function(jetty){ return HQV.hqboat && HQV.hqboat.hireKinds ? tryf(function(){ return HQV.hqboat.hireKinds(W, jetty); }, []) : []; }
  };
  if(HQV.hqCabs && HQV.hqCabs.mount) cabs = tryf(function(){ return HQV.hqCabs.mount(cS, callW, {call: HQV.hqCall, announce: announce, toast: o.toast, calm: function(){ return calm() || reduced(); },
    catalogue: function(){ return c.catalogue ? c.catalogue() : null; }, models: HQV.hqVehicleModels, heli: heli, water: water, fade: o.fade,
    showRoute: function(pts, label){ if(o.showRoute) tryf(function(){ o.showRoute(pts, label); }); }, sfx: sfxM,
    tickets: R && R.tickets, achievements: R && R.achievements, seatCam: R && R.seatCam}); }, null);
  if(R && R.achievements && R.achievements.onUnlock) T.unAch = tryf(function(){ return R.achievements.onUnlock(function(a){ if(a && a.name){ if(o.toast) tryf(function(){ o.toast("🏅 " + a.name); }); announce("Achievement: " + a.name); } }); }, null);

  /* ---------- riding ---------- */
  function viewFor(mode){ return {bus: V.coach, tram: V.coach, metro: V.metro, rail: V.cityrail, gondola: V.gondola, ferry: V.ferries, link: V.link}[mode] || null; }
  function startTrip(trip, legs){
    if(!trip || !R || !R.session) return null;
    if(ride) tryf(function(){ ride.cancel(true); });
    var Sx = null;
    Sx = R.session({trip: trip, view: viewFor(trip.mode), announce: announce, toast: o.toast, calm: function(){ return calm() || reduced(); }, reduced: reduced(),
      sfx: function(n, so){ sfxM(n, so); }, me: function(){ var m = me(); return {x: m.x, y: m.y, z: m.z}; }, userId: o.userId, world: worldId, seed: seed,
      announcer: ANN, now: function(){ return Date.now(); },
      under: function(){ /* the underground controller follows the ride (ctl.step riding) */ },
      travel: function(t){
        // the Island Link: hqTravel takes over at departure (the sea crossing and the next City)
        var ok = o.startLink ? tryf(function(){ return o.startLink(t, Sx && Sx.info ? Sx.info().seat : null); }, false) : false;
        if(ok){ var s0 = Sx; setTimeout(function(){ tryf(function(){ s0.cancel(true); }); }, 0); }
      },
      onEnd: function(reason){
        if(ride !== Sx) return;
        ride = null; rideCam = 0;
        var next = reason === "done" && legs && legs.length ? legs.shift() : null;
        while(next && next.mode === "walk") next = legs.length ? legs.shift() : null;
        if(next && next.trip){ startTrip(next.trip, legs); return; }
        plan = null;
        if(o.showRoute) tryf(function(){ o.showRoute(null); });
      }});
    ride = Sx;
    if(Sx){
      var at = tryf(function(){ return trip.door(num(trip.arrive, Date.now())); }, null);
      if(at && o.showRoute){ var m = me(); tryf(function(){ o.showRoute([m.x, m.z, at.x, at.z], (MODE_WORD[trip.mode] || "Stop") + ": " + (trip.fromName || "your stop")); }); }
      if(!under && trip.mode === "metro" && at) say("Walk to " + (trip.fromName || "the station") + ": the stairs down are by the M signs.");
    }
    return Sx;
  }
  // a planned journey (hqRide.plan's option: {legs}) or a Trip
  T.startRide = function(p){
    if(!p) return null;
    if(p.pose && p.mode) return startTrip(p, []);
    var legs = (p.legs || []).slice(), first = null;
    while(legs.length && !first){ var l = legs.shift(); if(l && l.mode !== "walk" && l.trip) first = l; }
    plan = p;
    return first ? startTrip(first.trip, legs) : null;
  };
  T.session = function(){ return ride; };
  T.carry = function(ms){
    ms = ms || Date.now();
    var p = ride ? tryf(function(){ return ride.carry(ms); }, null) : null; if(p) return p;
    if(cabs){ p = tryf(function(){ return cabs.carry(ms); }, null); if(p) return p; }
    if(heli){ p = tryf(function(){ return heli.carry(ms); }, null); if(p) return p; }
    if(taxi){ p = tryf(function(){ return taxi.carry(ms); }, null); if(p) return p; }
    return null;
  };
  T.camPose = function(ms){
    ms = ms || Date.now();
    var look = {yaw: 0, pitch: 0, mode: CAMS[rideCam]}, p;
    if(ride){ p = tryf(function(){ return ride.camPose(ms, look, CAMS[rideCam]); }, null); if(p) return p; }
    if(cabs){ p = tryf(function(){ return cabs.camPose(ms, look); }, null); if(p) return p; }
    if(heli){ p = tryf(function(){ return heli.camPose(ms, look); }, null); if(p) return p; }
    if(taxi){ p = tryf(function(){ return taxi.camPose(ms, look); }, null); if(p) return p; }
    return null;
  };
  function holding(){ return !!(ride && (ride.phase === "seated" || ride.phase === "standing")); }
  T.key = function(e){
    if(!e || e.type !== "keydown" || e.repeat || e.metaKey || e.ctrlKey || e.altKey) return false;
    if(e.code === "KeyS" && holding()){ tryf(function(){ ride.requestStop(); }); return true; }
    if(e.code === "KeyV" && (holding() || (cabs && tryf(function(){ return cabs.carry(Date.now()); }, null)) || (heli && tryf(function(){ return heli.carry(Date.now()); }, null)))){
      rideCam = (rideCam + (e.shiftKey ? CAMS.length - 1 : 1)) % CAMS.length;
      announce("Camera: " + CAMS[rideCam]);
      return true;
    }
    if(e.key === "Escape" && ride){ tryf(function(){ ride.cancel(); }); return true; }
    return false;
  };
  T.cam = function(mode){ var i = CAMS.indexOf(mode); if(i >= 0) rideCam = i; return CAMS[rideCam]; };

  /* ---------- the board menu (E at a stop, a station, a pier) ---------- */
  function stopsNear(x, z, r){
    var out = [];
    Object.keys(svc).forEach(function(k){
      var s = svc[k]; if(!s || !s.stopsNear) return;
      tryf(function(){ (s.stopsNear(x, z, r) || []).forEach(function(st){ out.push({svc: s, stop: st}); }); });
    });
    return out.sort(function(a, b){ return a.stop.dist - b.stop.dist || (a.stop.id < b.stop.id ? -1 : 1); });
  }
  function stopName(s, id){ var n = null; tryf(function(){ (s.stops() || []).forEach(function(q){ if(q.id === id) n = q.name; }); }); return n || String(id); }
  // the rides from a stop: per line, its ends and the next stop each way, soonest first (each a free ride)
  T.board = function(stopId, mode, ms){
    ms = ms || Date.now();
    var items = [];
    Object.keys(svc).forEach(function(k){
      var s = svc[k]; if(!s || (mode && s.mode !== mode)) return;
      tryf(function(){
        (s.lines() || []).forEach(function(L){
          var ids = (L.stops || []).map(function(q){ return typeof q === "string" ? q : q && q.id; }), at = ids.indexOf(stopId);
          if(at < 0) return;
          var cand = [ids[0], ids[ids.length - 1], ids[at + 1], ids[at - 1]].filter(function(id, i, a){ return id != null && id !== stopId && a.indexOf(id) === i; });
          cand.forEach(function(to){
            var trip = tryf(function(){ return s.trip(L.id, stopId, to, ms); }, null);
            if(trip && num(trip.depart, 0) > ms) items.push({at: num(trip.arrive, trip.depart), trip: trip,
              text: (L.short || L.id) + " " + (MODE_WORD[s.mode] || "") + " to " + (trip.toName || stopName(s, to)) + " · " + waitText(num(trip.arrive, trip.depart) - ms) + " · free"});
          });
        });
      });
    });
    items.sort(function(a, b){ return a.at - b.at || (a.text < b.text ? -1 : 1); });
    return items.slice(0, 8);
  };
  function openBoard(near, p){
    var st = near.stop, s = near.svc, rows = T.board(st.id, s.mode);
    var items = rows.map(function(r){ return {text: r.text, fn: function(){ startTrip(r.trip, []); }}; });
    if(under && ctl) items.push({text: "Way out to the street", fn: function(){ tryf(function(){ ctl.use(Date.now(), {x: p.x, y: me().y, z: p.z}); }); }});
    if(o.openMenu) o.openMenu((MODE_WORD[s.mode] || "Stop") + ": " + (st.name || st.id), items);
    return true;
  }
  // E while something holds you or waits for you (a ride, a taxi, a cab, the heli) or below the street
  T.useHeld = function(p){
    p = p || me();
    var ms = Date.now();
    if(ride){
      if(ride.phase === "walk" || ride.phase === "wait"){ tryf(function(){ ride.cancel(); }); say("You stopped waiting."); return true; }
      if(holding()){ tryf(function(){ ride.alightNext(); }); return true; }
      return true;                                                // boarding or getting off: E waits
    }
    if(taxiH){
      var ts = tryf(function(){ return taxiH.state(); }, null);
      if(ts && ts.state === "here"){ var a = tryf(function(){ return taxiH.ashore(); }, null); if(!a || Math.hypot(p.x - a.x, p.z - a.z) < 12){ tryf(function(){ taxiH.board(); }); return true; } }
    }
    if(cabs && tryf(function(){ return cabs.use(); }, false)) return true;
    if(heli && tryf(function(){ return heli.use(); }, false)) return true;
    var m = me();
    if(under){
      var nu = stopsNear(p.x, p.z, STATION_R).filter(function(n){ return n.svc.mode === "metro" || (n.stop.under && n.svc.mode !== "bus"); })[0];
      if(nu) return openBoard(nu, p);
      if(ctl && tryf(function(){ return ctl.use(ms, {x: p.x, y: m.y, z: p.z}); }, false)) return true;
      return false;
    }
    return false;
  };
  // E anywhere: the above, then a metro entrance (down), a stop, station or pier (the board menu)
  T.use = function(p){
    p = p || me();
    if(T.useHeld(p)) return true;
    if(under) return false;
    var ms = Date.now(), m = me();
    if(ctl && MV && MV.entranceAt && tryf(function(){ return MV.entranceAt(p.x, p.z, HQV.hqUndergroundCtl.E_R); }, null)){
      if(tryf(function(){ return ctl.use(ms, {x: p.x, y: m.y, z: p.z}); }, false)) return true;
    }
    var near = stopsNear(p.x, p.z, STOP_R).filter(function(n){ return !n.stop.under || n.svc.mode === "link"; })[0];
    if(near) return openBoard(near, p);
    return false;
  };
  // the hub's E prompt
  T.prompt = function(p){
    if(!p || ride) return null;
    if(under) return stopsNear(p.x, p.z, STATION_R).length ? "E  Departures · way out" : "E  Way out";
    if(MV && MV.entranceAt && tryf(function(){ return MV.entranceAt(p.x, p.z, 3.5); }, null)) return "E  Metro: go down";
    var n = stopsNear(p.x, p.z, STOP_R).filter(function(q){ return !q.stop.under; })[0];
    return n ? "E  " + (MODE_WORD[n.svc.mode] || "Stop") + " departures" : null;
  };

  /* ---------- the ground below the street ---------- */
  function feet(x, z){ var a = tryf(function(){ return c.avatar ? c.avatar() : null; }, null); return a && Math.hypot(a.x - x, a.z - z) < 4 && a.hy != null && isFinite(a.hy) ? a.hy : null; }
  function belowStreet(x, z){ return under || !!(MV && MV.rampAt && tryf(function(){ return MV.rampAt(x, z); }, null)); }
  T.ground = function(x, z){
    if(!MV || !MV.walkable || !belowStreet(x, z)) return null;
    var h = feet(x, z), y = h != null ? h : (under ? street(x, z) - 6 : street(x, z));
    var f = tryf(function(){ return MV.walkable(x, y, z); }, null);
    return f && isFinite(+f.y) ? +f.y : (under ? y : null);
  };
  T.blocked = function(x, z){
    if(!MV || !MV.walkable || !belowStreet(x, z)) return null;
    var h = feet(x, z), y = h != null ? h : street(x, z);
    return !tryf(function(){ return MV.walkable(x, y, z); }, null);
  };
  T.under = function(){ return under; };

  /* ---------- other players riding (presence a = 15) ---------- */
  T.net = function(){
    var i = ride && tryf(function(){ return ride.info(); }, null);
    if(i && (i.phase === "seated" || i.phase === "standing") && TK[i.mode] && i.vehicle != null) return {tk: TK[i.mode], tv: String(i.vehicle).slice(0, 24)};
    return null;
  };
  T.peerSeat = function(tk, tv, uid, ms){
    var mode = TK_MODE[tk | 0], s = mode && svc[mode]; if(!s || !s.vehicles) return null;
    var v = tryf(function(){ return (s.vehicles(ms || Date.now()) || []).filter(function(q){ return String(q.id) === String(tv); })[0]; }, null);
    if(!v) return null;
    // a seat chosen by the player's id: a little way along and across the floor (the vehicle's own frame)
    var h = hash32(uid + ":" + tv), along = ((h & 255)/255 - 0.5)*6, side = (h & 256) ? 0.7 : -0.7, yaw = num(v.yaw, 0);
    var x = num(v.x, 0) + Math.sin(yaw)*along - Math.cos(yaw)*side, z = num(v.z, 0) + Math.cos(yaw)*along + Math.sin(yaw)*side;
    var fl = {bus: 0.36, tram: 0.36, metro: 1.1, rail: 1.1, link: 1.1}[mode] || 0.4;
    return {x: x, y: num(v.y, 0) + fl + 0.45, z: z, yaw: yaw, under: !!v.under};
  };
  T.track = function(id){ tracking = id || null; return !!id; };
  T.link = function(world){
    if(!IL) return false;
    var l = tryf(function(){ return (IL.lines() || []).filter(function(x){ return x.world === world || (HQV.hqRail.sameWorld && HQV.hqRail.sameWorld(x.world, world)); })[0]; }, null);
    var t = l && tryf(function(){ return IL.trip(l.id, l.stops[0], l.stops[1], Date.now()); }, null);
    return t ? !!startTrip(t, []) : false;
  };
  T.cabs = cabs; T.heli = heli; T.water = water; T.services = function(){ return Object.keys(svc).map(function(k){ return svc[k]; }); };
  T.views = function(){ return V; };
  T.ctl = function(){ return ctl; };

  /* ---------- every frame ---------- */
  T.update = function(ms, dt, cam){
    if(dead) return;
    ms = ms || Date.now(); lastMs = ms;
    var m = me(), camP = cam && cam.x != null ? cam : m;
    if(ride) tryf(function(){ ride.step(ms, {x: m.x, y: m.y, z: m.z}); });
    // aboard (seated or standing, above ground): the cabin's lights, a soft fill, so ceilings and undersides seen from
    // inside are not black under the sky-only hemisphere light; off when you get off
    var aboard = !!(ride && (ride.phase === "seated" || ride.phase === "standing") && !under);
    if(THREE && S && aboard !== !!(cabinLight && cabinLight.parent)){
      if(!cabinLight){ cabinLight = new THREE.AmbientLight(0xfff4e2, 0.9); cabinLight.name = "transit:cabin-fill"; }
      if(aboard) S.add(cabinLight); else S.remove(cabinLight);
    }
    if(ctl && !pinned){
      var info = ride && tryf(function(){ return ride.info(ms); }, null), riding = null;
      if(info && info.mode === "metro" && (info.phase === "seated" || info.phase === "standing")) riding = {under: info.under, line: info.short, to: info.to};
      tryf(function(){ ctl.step(ms, {x: m.x, y: m.y, z: m.z, riding: riding}); });
    }
    Object.keys(V).forEach(function(k){
      var v = V[k]; if(!v || !v.update) return;
      if(under && SURFACE_VIEWS.indexOf(k) >= 0) return;            // hidden below the street
      tryf(function(){ v.update(ms, dt, camP); });
    });
    if(cabs) tryf(function(){ cabs.update(ms, dt); });
    if(heli) tryf(function(){ heli.update(ms, dt); });
    if(taxi){
      tryf(function(){ taxi.update(ms, dt); });
      var ts = taxiH && tryf(function(){ return taxiH.state(); }, null);
      if(ts && ts.state === "done"){ var a = tryf(function(){ return taxiH.ashore(); }, null); taxiH = null; if(a && o.teleport) o.teleport(a.x, a.y, a.z, a.yaw); }
      else if(ts && ts.state === "cancelled") taxiH = null;
    }
  };
  // the coach view hides the vehicles it draws in detail (pass to traffic.view's update): call before it
  T.hide = function(){ return V.coach && V.coach.hide ? tryf(function(){ return V.coach.hide(); }, null) : null; };
  T.wakes = function(){ return V.ferries && V.ferries.wakes ? tryf(function(){ return V.ferries.wakes(); }, []) : []; };
  T.setNight = function(n){ Object.keys(V).forEach(function(k){ if(V[k] && V[k].setNight) tryf(function(){ V[k].setNight(!!n); }); }); };
  T.drawCallsBy = function(){
    var out = {};
    Object.keys(V).forEach(function(k){ out[k] = V[k] && V[k].drawCalls ? tryf(function(){ return V[k].drawCalls() | 0; }, 0) : 0; });
    out.cabs = cabs && cabs.drawCalls ? tryf(function(){ return cabs.drawCalls() | 0; }, 0) : 0;
    out.heli = heli && heli.drawCalls ? tryf(function(){ return heli.drawCalls() | 0; }, 0) : 0;
    out.taxi = taxi && taxi.drawCalls ? tryf(function(){ return taxi.drawCalls() | 0; }, 0) : 0;
    return out;
  };
  T.drawCalls = function(){ var b = T.drawCallsBy(), n = 0; Object.keys(b).forEach(function(k){ n += b[k]; }); return n; };

  /* ---------- for the screenshot tour and the tests (HQ3D_DEBUG.transit) ---------- */
  T.debug = {
    services: function(){ return Object.keys(svc); },
    views: function(){ return Object.keys(V); },
    stops: function(mode){ var s = svc[mode]; return s ? tryf(function(){ return s.stops(); }, []) : []; },
    lines: function(mode){ var s = svc[mode]; return s ? tryf(function(){ return s.lines(); }, []) : []; },
    board: function(mode, lineId, from, to, ms){
      var s = svc[mode]; if(!s) return null;
      var t = tryf(function(){ return s.trip(lineId, from, to, ms || Date.now()); }, null);
      return t ? !!startTrip(t, []) : false;
    },
    phase: function(){ return ride ? ride.phase : null; },
    info: function(){ return ride ? tryf(function(){ return ride.info(); }, null) : null; },
    seatCam: function(mode){ return T.cam(mode); },
    under: function(on){ pinned = !!on; UG.set(!!on, "tour"); return under; },
    shot: function(name, shot){ var v = V[name] || (name === "cabs" ? cabs : name === "heli" ? heli : name === "taxi" ? taxi : null); return v && v.tools && v.tools.shotCam ? tryf(function(){ return v.tools.shotCam(shot); }, null) : null; },
    cab: function(cls, dest){ return cabs ? tryf(function(){ return cabs.request(dest, cls || "go"); }, null) : null; },
    cabDriver: function(on){ return cabs ? tryf(function(){ return cabs.driver.on(!!on); }, null) : null; },
    heli: function(spotId){ if(!heli) return null; var sp = tryf(function(){ return heli.spots(400); }, []) || []; var s = sp.filter(function(q){ return !spotId || q.id === spotId; })[0] || sp[0]; return s ? tryf(function(){ return heli.call(s, {own: null}); }, null) : null; },
    water: function(kind, a, b){ if(kind === "taxi") return water.taxi(a || null, b); return water.hire(a, kind); },
    link: function(world){ return T.link(world); },
    drawCalls: function(){ return T.drawCallsBy(); }
  };
  T.dispose = function(){
    if(dead) return; dead = true;
    if(ride) tryf(function(){ ride.cancel(true); }); ride = null;
    if(under) setUnder(false, "dispose");
    if(HQV.hqUnderground === UG) HQV.hqUnderground = null;
    if(T.unAch) tryf(T.unAch);
    Object.keys(V).forEach(function(k){ if(V[k] && V[k].dispose) tryf(function(){ V[k].dispose(); }); });
    [cabs, heli, taxi].forEach(function(m){ if(m && m.dispose) tryf(function(){ m.dispose(); }); });
    if(R && R.unregister) Object.keys(svc).forEach(function(k){ if(R.services && (R.services() || []).indexOf(svc[k]) >= 0) tryf(function(){ R.unregister(k); }); });
    if(underLight && S) S.remove(underLight);
    if(cabinLight && S) S.remove(cabinLight);
  };
  return T;
}

HQV.hqTransit = {create: create, TK: TK, TK_MODE: TK_MODE, CAMS: CAMS, waitText: waitText};
})();
