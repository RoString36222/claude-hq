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
 *   E at a stop, station, platform or pier opens a board menu (the next departures, 0 coins: quick travel); the metro's
 *     stairs are walked down and up, E at a lift rides it (HQV.hqUndergroundCtl; HQ 3.36: nothing teleports). [stations]
 *     Below the street a departure on the board is a plan: you walk to its platform and in through an open door (the
 *     session waits, walkOn); nothing below the street puts you aboard from a distance.
 *   The transit pass (below the street): the hall's ticket machines (E) sell a single, a day pass or the Claude Card
 *     (hqRide.wallet, 0 coins); the gate lines block the walker (T.blocked) unless a ticket is held or you come from the
 *     paid side, and take it as you walk through; on a platform E at an open door of a standing train (or stepping into
 *     the doorway) boards it, and while riding E gets off at the stop the doors are open at. T.prompt says which.
 *     HQV.hqTransit.cur is the City's T while it is the one you are in.
 *   HQV.hqUnderground = {under(), set(on, reason)}: the switch. set hides the city's surface (o.surface(false) and
 *     the surface views here), swaps in a dark fog and shows the metro's underground (V.underground(on)); the
 *     avatar's ground below the street comes from the metro's walkable floors (ground / blocked).
 *   [island trains] The Island Link: its station (games/hqilstation.js) is walked through like the metro's (machines,
 *     gates, stairs, platforms; T.ground / T.blocked / T.ilCamHit / T.ilCeil / T.ilGround), its trains boarded through an
 *     open door, and the ride runs on the real track: the far world is built while you ride (c.prebuildCity) and takes
 *     the session over mid-sea (c.swapCity, HQV.hqTransit.carried, adopt), so you arrive aboard and walk off. On the
 *     Commons the islands' docs (on an island the Commons') load when you come near the station or ask for a train.
 * Everything here is a pure function of the doc, the tier, the UTC clock and the world's seed, so every client sees
 * the same trains; nothing here talks to the network. No DOM: menus and toasts go through the hub's callbacks.
 *
 * create(c, o) -> T
 *   c = hq3d's ctx; o = {scene, W (packed), doc (raw), world (id), tier, seed, tsim (traffic sim) | null,
 *        say(text) (announce + toast), announce(text), toast(text), calm(), reduced(), night(), me() -> {x, y, z, yaw},
 *        teleport(x, y, z, yaw), surface(on) (show / hide the hub's surface groups), fade(ms), openMenu(title, items),
 *        startLink(trip, seat) -> bool (unused since [island trains]: the ride itself crosses), arch() -> Promise, ndraw() (the residents' drawing),
 *        showRoute(pts | null, label), traffic() -> this frame's traffic list, userId}
 *   T.update(ms, dt, cam)            every frame (cam {x, y, z})
 *   T.carry(ms) / T.camPose(ms)      the hold chain (session, cabs, heli, water taxi), else null
 *   T.use(p) -> bool                 E: get off, get in, board, go down or up
 *   T.key(e) -> bool                 S (stop), V (camera) while a session holds you
 *   T.ground(x, z) -> y | null       below the street: the walkable floor (null: not underground, the hub's own)
 *   T.blocked(x, z) -> bool | null   below the street: no floor there (null: the hub decides)
 *   T.noVehicle(x, z) -> bool        a metro entrance (stairs, lift, canopy): the hub blocks vehicles there
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
  var rideEnd = 0;             // when the last ride ended (a door you just stepped out of does not take you straight back in)

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
  if(msim) view("metro", function(){ return HQV.hqMetro.view(cS, msim, {calm: calm, night: night, sfx: sfxM, under: function(){ return under; }, gateOk: function(){ return gateOk(); },
                                                                      me: function(){ var m = me(); return {x: m.x, y: m.y, z: m.z}; }}); });
  if(CL) view("cityrail", function(){ return HQV.hqCityRail.view(cS, CL, {W: W, ground: ground, night: night}); });
  if(HQV.hqPortals) view("portals", function(){ return HQV.hqPortals.view(cS, W, {night: night}); });
  if(G1) view("gondola", function(){ return HQV.hqGondola.view(cS, G1, {ground: ground, calm: calm, reduced: reduced(), world: worldId, sfx: sfxM}); });
  if(FS) view("ferries", function(){ return HQV.hqFerries.view(cS, FS, {calm: calm, night: night, sfx: sfxM, parent: S}); });
  // the Island Link: once the archipelago is known (where the Commons and the islands are)
  // [island trains] laid again once the far ends' docs are loaded (an island's own terminal comes from its doc), with this
  // world's station (games/hqilstation.js) to walk through
  var ILS = null, ILSv = null, ilArch = null, ilDocs = {}, ilLoading = false, ilWant = false;
  function linkUp(a, docs){
    var svc2 = tryf(function(){ return HQV.hqRail.linkService({here: worldId, W: W, arch: a, docs: docs, seed: worldId}); }, null);
    if(!svc2 || !(svc2.lines() || []).length) return;
    if(ILv){ tryf(function(){ ILv.dispose(); }); delete V.link; ILv = null; }
    if(ILSv){ tryf(function(){ ILSv.dispose(); }); ILSv = null; }
    IL = svc2; reg(IL);
    ILS = HQV.hqILStation ? tryf(function(){
      var sp = IL.station(ground); if(!sp) return null;
      sp.name = (IL.stops()[0] || {}).name || ""; return HQV.hqILStation.layout(sp);
    }, null) : null;
    var seaY = W && W.island && W.island.sea_cm != null ? W.island.sea_cm/100 : 0;
    ILv = view("link", function(){ return HQV.hqRail.linkView(cS, IL, {seaY: seaY, ground: ground, under: function(){ return under; }, night: night,
      noPier: ILS ? function(x, z){ return ILS.inHall(x, z, 3); } : null}); });
    if(ILS && THREE && S) ILSv = tryf(function(){
      var used = IL.lines().map(function(l){ return l.plat; }), v = HQV.hqILStation.view(cS, ILS, {ground: ground, used: used, departures: function(ms){
        return (IL.departures(IL.stops()[0].id, ms, 4) || []).map(function(r){ return {to: r.to, plat: r.plat, at: r.at}; }); }});
      S.add(v.g); S.add(v.doorsG); return v;
    }, null);
    // a ride you are on keeps going on the train this view draws
    if(ride && ride.trip && ride.trip.mode === "link"){ var rr = ride; tryf(function(){ rr.rebind({view: ILv}); }); if(ILv && ILv.ride) ILv.ride(rr.trip); }
  }
  // the far ends' docs: on the Commons every island's (once you come near its station or ask for a train), on an island the Commons'
  function loadFar(){
    if(ilLoading || !ilArch || !HQV.world || !HQV.world.load || !active()) return;
    var want = HQV.hqRail.isCommonsId(worldId) ? (ilArch.islands || []).map(function(i){ return i && i.world; }).filter(Boolean)
                                                 : [(HQV.world && HQV.world.COMMONS) || "claude-hq@3"];
    want = want.filter(function(w){ return !ilDocs[w]; });
    if(!want.length) return;
    ilLoading = true;
    var got = 0;
    (function next(i){
      if(dead) return;
      if(i >= want.length){ ilLoading = false; if(got) linkUp(ilArch, ilDocs); return; }
      Promise.resolve(HQV.world.load({id: want[i]})).then(function(W2){ if(W2 && W2.id === want[i]){ ilDocs[want[i]] = W2; got++; } }, function(){})
        .then(function(){ next(i + 1); });
    })(0);
  }
  if(HQV.hqRail && HQV.hqRail.linkService && o.arch) tryf(function(){
    Promise.resolve(o.arch()).then(function(a){
      if(dead || !a) return;
      ilArch = a; linkUp(a, ilDocs);
      if(!HQV.hqRail.isCommonsId(worldId) || ilWant) loadFar();
    }, function(){});
  });

  /* ---------- the underground ---------- */
  var MV = V.metro || null;
  if(MV && HQV.hqUndergroundCtl){
    ctl = tryf(function(){ return HQV.hqUndergroundCtl.create({metro: MV, sim: msim, announce: announce, calm: function(){ return calm() || reduced(); },
      fade: function(ms){ if(o.fade) tryf(function(){ o.fade(ms); }); }, set: function(on, why){ setUnder(on, why); },
      teleport: function(p){ if(o.teleport && p) o.teleport(p.x, p.y, p.z, p.yaw); }}); }, null);
  }
  var SURFACE_VIEWS = ["tramway", "coach", "cityrail", "portals", "gondola", "ferries"], hideNext = false, surfShown = true;
  function surfaceOn(vis){
    surfShown = !!vis;
    if(o.surface) tryf(function(){ o.surface(vis); });
    SURFACE_VIEWS.forEach(function(k){ var g = V[k] && (V[k].group || V[k].g); if(g && g.visible != null) g.visible = vis; });
    [cabs, heli].forEach(function(m){ var g = m && m.group; if(g) g.visible = vis; });
  }
  function setUnder(on, why){
    on = !!on;
    if(on === under) return;
    under = on;
    // [stations] going down, the street is hidden on the next frame: this frame's camera was placed before the switch
    // (outside, over the stairs), and with the street gone it would look at nothing; the next one is held in the station
    if(on) hideNext = true; else { hideNext = false; surfaceOn(true); }
    if(MV && MV.underground) tryf(function(){ MV.underground(on); });
    if(THREE && S){
      if(on && !underLight){ underLight = new THREE.AmbientLight(0xdfe6ee, 0.35); underLight.name = "underground:fill"; }
      if(underLight){ if(on) S.add(underLight); else S.remove(underLight); }
    }
    if(o.onUnder) tryf(function(){ o.onUnder(on, why); });
  }
  var UG = {under: function(){ return under; }, set: function(on, why){ if(ctl && ctl.force) ctl.force(!!on, why || "set"); else setUnder(on, why); }};
  if(active()){ HQV.hqUnderground = UG; HQV.hqTransit.cur = T; }
  T.activate = function(){
    if(dead) return;
    if(R && R.register) Object.keys(svc).forEach(function(k){ tryf(function(){ R.register(svc[k]); }); });
    HQV.hqUnderground = UG; HQV.hqTransit.cur = T;
    adopt();
    if(ilArch && !HQV.hqRail.isCommonsId(worldId)) loadFar();
  };
  // [island trains] the Island Link ride you are on, carried over from the world you boarded in (the swap mid-sea): this
  // City takes the session over where it is, in its own frame
  function adopt(){
    var CO = HQV.hqTransit.carried;
    if(!CO || !CO.S || !CO.trip || !HQV.hqRail || !HQV.hqRail.sameWorld(CO.trip.world, worldId)) return false;
    HQV.hqTransit.carried = null;
    var Sx = CO.S;
    ride = Sx; rideCam = CO.cam | 0;
    tryf(function(){ Sx.rebind({view: V.link || null, onEnd: function(reason){
      if(ride !== Sx) return;
      ride = null; rideCam = 0; rideEnd = Date.now(); plan = null;
      if(V.link && V.link.ride) tryf(function(){ V.link.ride(null); });
      if(o.showRoute) tryf(function(){ o.showRoute(null); });
    }}); });
    if(V.link && V.link.ride) tryf(function(){ V.link.ride(CO.trip); });
    say("Island Link: the next and last stop is " + (CO.trip.toName || "the island") + ", in " + waitText(num(CO.trip.reach, 0) - Date.now()) + ".");
    return true;
  }

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
  function startTrip(trip, legs, extra){
    if(!trip || !R || !R.session) return null;
    extra = extra || {};
    if(ride) tryf(function(){ ride.cancel(true); });
    // [island trains] the Island Link is boarded on foot at its station: through the gates, up to the platform, in at a door
    if(trip.mode === "link" && ILS && !extra.hop) extra.walkOn = true;
    var Sx = null;
    // (the stop you wait at: a bus held back from a junction's box may pull up a way along from it)
    var sv = svc[trip.mode], stopAt = sv ? (tryf(function(){ return sv.stops(); }, []) || []).filter(function(st){ return st && st.id === trip.from; })[0] || null : null;
    Sx = R.session({trip: trip, stopAt: stopAt ? {x: num(stopAt.x, 0), z: num(stopAt.z, 0)} : null, view: viewFor(trip.mode), announce: announce, toast: o.toast, calm: function(){ return calm() || reduced(); }, reduced: reduced(),
      at: extra.at || null, boardDoor: extra.boardDoor || null, hop: !!extra.hop, walkOn: !!extra.walkOn,
      sfx: function(n, so){ sfxM(n, so); }, me: function(){ var m = me(); return {x: m.x, y: m.y, z: m.z}; }, userId: o.userId, world: worldId, seed: seed,
      announcer: ANN, now: function(){ return Date.now(); },
      under: function(){ /* the underground controller follows the ride (ctl.step riding) */ },
      // [island trains] no hand-over to a cinematic: the session rides on, into the far world mid-sea (linkStep)
      onEnd: function(reason){
        if(ride !== Sx) return;
        ride = null; rideCam = 0; rideEnd = Date.now();
        if(trip.mode === "link" && V.link && V.link.ride) tryf(function(){ V.link.ride(null); });
        var next = reason === "done" && legs && legs.length ? legs.shift() : null;
        while(next && next.mode === "walk") next = legs.length ? legs.shift() : null;
        if(next && next.trip){ startTrip(next.trip, legs); return; }
        plan = null;
        if(o.showRoute) tryf(function(){ o.showRoute(null); });
      }});
    ride = Sx;
    if(Sx && trip.mode === "link"){
      if(V.link && V.link.ride) tryf(function(){ V.link.ride(trip); });
      ilWant = true; loadFar();
      // the way to the station's doors, and which platform
      var pl = ILS ? ILS.plats.filter(function(q){ return q.tracks.some(function(t2){ return String(t2.plat) === String(trip.plat); }); })[0] || ILS.plats[0] : null;
      if(pl && !extra.hop){
        var dw = ILS.world(ILS.hall.u0 - 2, pl.c), m0 = me();
        if(o.showRoute) tryf(function(){ o.showRoute([m0.x, m0.z, dw.x, dw.z], "Island Link · " + (trip.fromName || "station")); });
        say("Island Link to " + (trip.toName || "the island") + ": platform " + (trip.plat || 1) + ", doors open " + waitText(num(trip.arrive, 0) - Date.now()) + " from now. Walk in at " + (trip.fromName || "the station") + ", through the gates and up to the platform, then in at an open door.");
      }
      return Sx;
    }
    if(Sx){
      var at = tryf(function(){ return trip.door(num(trip.arrive, Date.now())); }, null);
      if(at && o.showRoute && !extra.hop){ var m = me(); tryf(function(){ o.showRoute([m.x, m.z, at.x, at.z], (MODE_WORD[trip.mode] || "Stop") + ": " + (trip.fromName || "your stop")); }); }
      if(!under && trip.mode === "metro" && at && !extra.hop) say("Walk to " + (trip.fromName || "the station") + ": the stairs down are by the M signs.");
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
    if(ride){ var cm = under && CAMS[rideCam] === "chase" ? "seat" : CAMS[rideCam]; p = tryf(function(){ return ride.camPose(ms, look, cm); }, null); if(p) return p; }
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
      if(under && CAMS[rideCam] === "chase") rideCam = (rideCam + (e.shiftKey ? CAMS.length - 1 : 1)) % CAMS.length;   // [stations] in a tunnel: no camera outside the car
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
              text: (L.short || L.id) + " " + (MODE_WORD[s.mode] || "") + " to " + (trip.toName || stopName(s, to)) + " · " + waitText(num(trip.arrive, trip.depart) - ms) + " · 0 coins"});
          });
        });
      });
    });
    items.sort(function(a, b){ return a.at - b.at || (a.text < b.text ? -1 : 1); });
    return items.slice(0, 8);
  };
  function openBoard(near, p){
    var st = near.stop, s = near.svc, rows = T.board(st.id, s.mode);
    // [stations] below the street a departure is a plan, not a jump: you walk down to its platform and in through an open
    // door of its train (the session waits for you there); no shortcut puts you aboard from the hall
    if(under && (s.mode === "metro" || s.mode === "rail")){
      var its = rows.map(function(r){ return {text: r.text.replace(/ · 0 coins$/, "") + " · walk to its platform and in at a door", fn: function(){
        if(!ticket(Date.now()) && gateSide !== true) say("You need a ticket for the gates: the machines by the wall sell them (E).");
        startTrip(r.trip, [], {walkOn: true});
        say("Walk down to the " + (r.trip.short || r.trip.line || "") + " platform; the train's doors open there: walk in through any of them.");
      }}; });
      if(o.openMenu) o.openMenu("Departures · " + (st.name || st.id), its);
      return true;
    }
    var items = rows.map(function(r){ return {text: r.text, fn: function(){
      // [transit pass] quick travel on the metro or the City Line still rides on a ticket: with none, the machine's
      // single (0 coins) is bought and tapped for you
      if(WL && (r.trip.mode === "metro" || r.trip.mode === "rail") && gateSide !== true){
        var ms0 = Date.now();
        if(!ticket(ms0)) tryf(function(){ WL.buy("single", ms0); });
        var tp = tryf(function(){ return WL.tap(ms0); }, null); if(tp && tp.ok) announce(tp.text);
      }
      startTrip(r.trip, []);
    }}; });
    if(o.openMenu) o.openMenu((MODE_WORD[s.mode] || "Stop") + ": " + (st.name || st.id), items);
    return true;
  }
  // E while something holds you or waits for you (a ride, a taxi, a cab, the heli) or below the street
  T.useHeld = function(p){
    p = p || me();
    var ms = Date.now();
    if(ride){
      if(ride.phase === "walk" || ride.phase === "wait"){
        // [island trains] at an open door of the Island Link train you wait for: in through it
        var dl = ILS && !under ? ilDoorNear(p, ms, DOOR_E) : null;
        if(dl && ride.trip && dl.v.id === ride.trip.vehicle && ride.boardAt){ var ml = me(); if(tryf(function(){ return ride.boardAt({x: dl.door.x, y: dl.door.y, z: dl.door.z}, ms, {x: ml.x, y: feetY(), z: ml.z}); }, false)) return true; }
        // [stations] at an open door of the train you wait for: in through it (another standing train's: that one)
        var dw = under ? doorNear(p, ms, DOOR_E) : null;
        if(dw && ride.trip && dw.v.id === ride.trip.vehicle && ride.boardAt){ var mm = me(); if(tryf(function(){ return ride.boardAt({x: dw.door.x, y: dw.door.y, z: dw.door.z}, ms, {x: mm.x, y: feetY(), z: mm.z}); }, false)) return true; }
        tryf(function(){ ride.cancel(); });
        if(dw && dw.run && dw.run.last !== dw.station && hop(dw, ms)) return true;
        say("You stopped waiting."); return true;
      }
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
    if(ILS && !under && ilNear(p.x, p.z)){
      var fy0 = feetY(), idn = ilDoorNear(p, ms, DOOR_E);
      if(idn){ ilHop(idn, ms); return true; }
      var imc = ILS.machineAt(p.x, p.z, fy0, MACHINE_R); if(imc) return buyMenu({name: ILS.name || "Island Link"});
      if(ILS.inside(p.x, fy0 != null ? fy0 + 0.5 : ILS.ys + 0.5, p.z) || ILS.inHall(p.x, p.z, 4)) return ilBoard(p);
    }
    if(under){
      // [3.36] the lift before the departures (it stands in the hall, within the station's board reach)
      if(ctl && liftNear(p) && tryf(function(){ return ctl.use(lastMs || ms, {x: p.x, y: m.y, z: p.z}); }, false)) return true;
      // [transit pass] an open train door, then a ticket machine, then the departures
      var dn = doorNear(p, ms, DOOR_E);
      if(dn && dn.run){ if(dn.run.last === dn.station){ say("This train terminates here: wait for one the other way."); return true; } if(hop(dn, ms)) return true; }
      var mc = machineNear(p); if(mc) return buyMenu(mc.station);
      var nu = stopsNear(p.x, p.z, STATION_R).filter(function(n){ return n.svc.mode === "metro" || (n.stop.under && n.svc.mode !== "bus"); })[0];
      if(nu) return openBoard(nu, p);
      return false;
    }
    return false;
  };
  // E anywhere: the above, then a metro entrance (down), a stop, station or pier (the board menu)
  T.use = function(p){
    p = p || me();
    if(T.useHeld(p)) return true;
    var ms = lastMs || Date.now(), m = me();
    // [3.36] E at a lift rides it (down from the street, up from the hall); stairs are walked, nothing teleports
    if(ctl && liftNear(p) && tryf(function(){ return ctl.use(ms, {x: p.x, y: m.y, z: p.z}); }, false)) return true;
    if(under) return false;
    var near = stopsNear(p.x, p.z, STOP_R).filter(function(n){ return !n.stop.under || n.svc.mode === "link"; })[0];
    if(near) return openBoard(near, p);
    return false;
  };
  function liftNear(p){
    var r = HQV.hqUndergroundCtl ? HQV.hqUndergroundCtl.E_R : 3.5, e = MV && MV.entranceAt && tryf(function(){ return MV.entranceAt(p.x, p.z, under ? r + 1.2 : r); }, null);
    return !!(e && e.kind === "lift");
  }
  // the hub's E prompt
  T.prompt = function(p){
    if(!p) return null;
    var ms = lastMs || Date.now();
    if(ride){
      var ri = tryf(function(){ return ride.info(ms); }, null); if(!ri) return null;
      if(ri.phase === "walk" || ri.phase === "wait"){
        var dq = ILS && !under && ride.walkOn ? ilDoorNear(p, ms, DOOR_E) : null;
        if(dq && ride.trip && dq.v.id === ride.trip.vehicle) return "E  Board the Island Link to " + ri.to;
        if(ride.trip && ride.trip.mode === "link") return "Island Link to " + ri.to + ": platform " + (ride.trip.plat || 1) + ", in at an open door · E stops waiting";
        var dp = under && ride.walkOn ? doorNear(p, ms, DOOR_E) : null;
        if(dp && ride.trip && dp.v.id === ride.trip.vehicle) return "E  Board " + dp.v.line + " to " + (dp.run ? dp.run.lastName : ri.to);
        return ride.walkOn ? "Walk to the " + (ri.short || ri.line || "") + " platform and in at a door · E stops waiting" : "E  Stop waiting";
      }
      if(ri.phase !== "seated" && ri.phase !== "standing") return null;
      return ri.atStop ? "E  Get off here: " + ri.atStop : "E  Get off at " + ((ri.nextStop && ri.nextStop.name) || "the next stop");
    }
    if(liftNear(p)) return under ? "E  Lift up to the street" : "E  Lift down to the Metro";
    if(ILS && !under && ilNear(p.x, p.z)){
      var fy1 = feetY(), idp = ilDoorNear(p, ms, DOOR_E);
      if(idp) return idp.leaving ? "E  Board the Island Link: " + ((IL.lines() || []).filter(function(l){ return l.id === idp.v.line; })[0] || {name: ""}).name.replace(/^Island Link /, "") : "This train has just come in";
      if(ILS.machineAt(p.x, p.z, fy1, MACHINE_R)) return "E  Ticket machine: single, day pass, card (free)";
      var ig = ILS.gateAt(p.x + 0.6*Math.sin(me().yaw || 0), p.z + 0.6*Math.cos(me().yaw || 0), fy1);
      if(ig && !ilGateOk()) return "Gates: you need a ticket (the machines by the wall, free)";
      if(ILS.inside(p.x, fy1 != null ? fy1 + 0.5 : ILS.ys + 0.5, p.z) || ILS.inHall(p.x, p.z, 4)) return "E  Island Link departures";
    }
    if(under){
      var dn = doorNear(p, ms, DOOR_E);
      if(dn && dn.run) return dn.run.last === dn.station ? "This train terminates here" : "E  Board " + dn.v.line + " to " + dn.run.lastName;
      if(machineNear(p)) return "E  Ticket machine: single, day pass, card";
      var gg = LAYM ? tryf(function(){ var y = feetY(), q = me(); return LAYM.gateAt(q.x, y, q.z) || LAYM.gateAt(p.x + 0.6*Math.sin(q.yaw || 0), y, p.z + 0.6*Math.cos(q.yaw || 0)); }, null) : null;
      if(gg && !gateOk()) return "Gates: you need a ticket (machines by the wall)";
      return stopsNear(p.x, p.z, STATION_R).length ? "E  Departures" : null;
    }
    // [transit pass] an entrance within 10 m: which station and lines, so you know before you go down
    var en = MV && MV.entranceAt && tryf(function(){ return MV.entranceAt(p.x, p.z, 10); }, null);
    if(en){ var ES = LAYM && LAYM.byId[en.station]; return "Metro" + (ES ? " " + ES.name + " (" + ES.lines.join(", ") + ")" : "") + ": walk down the stairs, tickets inside"; }
    var n = stopsNear(p.x, p.z, STOP_R).filter(function(q){ return !q.stop.under; })[0];
    return n ? "E  " + (MODE_WORD[n.svc.mode] || "Stop") + " departures" : null;
  };

  /* ---------- the transit pass: tickets, gates, stepping onto a standing train ---------- */
  // A ticket costs 0 coins (D4: no money moves) but it is a ticket: the machines in the hall (or the phone's Tickets
  // app) sell a single, a day pass or the Claude Card (hqRide.wallet, on this computer only); the gate lines across
  // the hall open for one and take it (a single starts its 90 minutes there); going out is always free. On a
  // platform a train standing with its doors open takes you aboard through the door you walk up to (E, or step into the
  // doorway); while you ride E gets you off at the stop you stand at, else at the next. The quick menu stays (E away
  // from the doors).
  var WL = R && R.wallet ? R.wallet : null;
  var LAYM = msim && msim.layout ? tryf(function(){ return msim.layout(); }, null) : null;
  var MACHINE_R = 2.3, DOOR_E = 2.6, DOOR_STEP = 0.8, HOP_COOL = 4000;
  var gateSide = null, inBand = false, gateSaid = 0, trainSaid = {}, closeSaid = {};
  function feetY(){ var a = tryf(function(){ return c.avatar ? c.avatar() : null; }, null); return a && a.hy != null && isFinite(a.hy) ? +a.hy : null; }
  function ticket(ms){ return WL ? tryf(function(){ return WL.best(ms || Date.now()); }, null) : {item: null, ready: true}; }
  // may the walker pass a gate now: coming from the paid side (out) always, in only with a ticket
  function gateOk(){ return !WL || gateSide === true || !!ticket(); }
  T.gateOk = gateOk;
  function machineNear(p){
    if(!under || !LAYM) return null;
    var y = feetY(), best = null, bd = MACHINE_R;
    LAYM.stations.forEach(function(S){
      if(Math.hypot(S.x - p.x, S.z - p.z) > S.ext + 2 || (y != null && Math.abs(y - S.hallY) > 1.5)) return;
      (S.machines || []).forEach(function(M){ var d = Math.hypot(M.x - p.x, M.z - p.z); if(d < bd){ bd = d; best = {station: S, m: M}; } });
    });
    return best;
  }
  function onPlatform(p){
    if(!under || !LAYM) return null;
    var y = feetY(), w = tryf(function(){ return LAYM.walkable(p.x, y != null ? y + 0.2 : 1e4, p.z); }, null);
    return w && w.kind === "platform" ? w : null;
  }
  // the open door of a standing metro train nearest p within r m: {v, door, d, run}
  function doorNear(p, ms, r){
    var w = onPlatform(p); if(!w || !msim || !msim.doorsOf) return null;
    var y = feetY(), best = null;
    (tryf(function(){ return msim.vehicles(ms); }, []) || []).forEach(function(v){
      if(v.stop !== w.station || !(v.doors >= 0.5)) return;
      (msim.doorsOf(v) || []).forEach(function(d){
        var dd = Math.hypot(d.x - p.x, d.z - p.z);
        if(dd <= r && (y == null || Math.abs(d.y - y) < 1.6) && (!best || dd < best.d)) best = {v: v, door: d, d: dd, station: w.station};
      });
    });
    if(best) best.run = tryf(function(){ return msim.runOf(best.v); }, null);
    return best;
  }
  function lineWord(id){ var L = (tryf(function(){ return msim.lines(); }, []) || []).filter(function(l){ return l.id === id; })[0]; return L ? L.short + " " + L.name : id; }
  function hop(h, ms){
    if(!h || !h.run || h.run.last === h.station) return false;
    var t = tryf(function(){ return msim.trip(h.v.line, h.station, h.run.last, ms); }, null);
    if(!t || t.vehicle !== h.v.id){ say("The doors are closing: wait for the next train."); return true; }
    var m = me();
    return !!startTrip(t, [], {hop: true, at: {x: m.x, z: m.z}, boardDoor: {x: h.door.x, y: h.door.y, z: h.door.z}});
  }
  function buyMenu(S){
    if(!o.openMenu || !WL) return false;
    var ms = Date.now(), F = WL.FARES, have = tryf(function(){ return WL.list(ms); }, []) || [];
    var items = WL.ORDER.map(function(k){
      var f = F[k], owned = k === "card" && have.some(function(t){ return t.kind === "card"; });
      return {text: f.name + " · " + WL.fareText(f.coins) + " · " + (owned ? "you have one" : f.desc), off: owned, fn: function(){
        var t = tryf(function(){ return WL.buy(k, Date.now()); }, null);
        if(!t){ say("The machine could not sell that."); return; }
        sfxM("validator", {pos: {x: me().x, y: (feetY() || 0) + 1, z: me().z}, kind: "door"});
        say(t.name + " bought, " + WL.fareText(f.coins) + ". The gates take it: walk through.");
        if(o.toast) tryf(function(){ o.toast("🎫 " + t.name + " · " + WL.fareText(f.coins)); });
      }};
    });
    have.slice(0, 3).forEach(function(t){ items.push({text: "Your " + t.name + ": " + WL.status(t, ms), off: true, fn: function(){}}); });
    o.openMenu("Ticket machine · " + (S && S.name ? S.name : "Metro"), items);
    return true;
  }
  T.buy = function(kind){ return WL ? tryf(function(){ return WL.buy(kind, Date.now()); }, null) : null; };
  T.wallet = function(){ return WL; };
  // every frame below the street: which side of the gates you are on, a tap when you walk through one, the trains
  // that open their doors at your platform, and stepping into an open doorway
  function passStep(ms){
    if(!under || !LAYM){ gateSide = null; inBand = false; return; }
    var m = me(), y = feetY(), g = tryf(function(){ return LAYM.gateAt(m.x, y, m.z); }, null);
    if(!g){
      var paid = tryf(function(){ return LAYM.paidAt(m.x, y, m.z); }, null);
      if(inBand && gateSide === false && paid === true && WL){
        var r = tryf(function(){ return WL.tap(ms); }, null);
        if(r && r.ok){ announce(r.text); sfxM("validator", {pos: {x: m.x, y: (y || 0) + 1, z: m.z}, kind: "door"}); }
      }
      if(paid != null) gateSide = paid;
      inBand = false;
    } else inBand = true;
    // [stations] waiting for a train you chose on the board: walking into its open doorway takes you aboard
    if(ride && ride.walkOn && (ride.phase === "walk" || ride.phase === "wait")){
      var hw0 = doorNear(m, ms, DOOR_STEP);
      if(hw0 && ride.trip && hw0.v.id === ride.trip.vehicle) tryf(function(){ ride.boardAt({x: hw0.door.x, y: hw0.door.y, z: hw0.door.z}, ms, {x: m.x, y: y, z: m.z}); });
    }
    if(ride) return;
    var w = onPlatform(m); if(!w) return;
    (tryf(function(){ return msim.vehicles(ms); }, []) || []).forEach(function(v){
      if(v.stop !== w.station) return;
      var ru = tryf(function(){ return msim.runOf(v); }, null), plat = tryf(function(){ return msim.platNo(w.station, v.line, ru && ru.key); }, null);
      if(v.doors >= 0.5 && !trainSaid[v.id]){
        trainSaid[v.id] = ms;
        if(ru && ru.last === w.station) announce(lineWord(v.line) + (plat ? ", platform " + plat : "") + ": this train terminates here.");
        else announce(lineWord(v.line) + " to " + (ru ? ru.lastName : "") + (plat ? ", platform " + plat : "") + ": doors open. Walk up to a door and press E to board.");
      }
      if(trainSaid[v.id] && v.doors < 0.5 && v.doors > 0 && !closeSaid[v.id]){ closeSaid[v.id] = 1; announce("Stand clear: the doors are closing."); }
    });
    Object.keys(trainSaid).forEach(function(k){ if(ms - trainSaid[k] > 120000){ delete trainSaid[k]; delete closeSaid[k]; } });
    // stepped into an open doorway: aboard (not straight back in through the door you just came out of)
    if(ms - rideEnd > HOP_COOL){ var h = doorNear(m, ms, DOOR_STEP); if(h && h.run && h.run.last !== h.station) hop(h, ms); }
  }

  /* ---------- [island trains] the Island Link's station: its floors, gates, machines, trains' doors, its passengers ----------
     ILS (games/hqilstation.js's layout) is this world's elevated IL station: the hall at street level (its gate line takes
     the same tickets as the metro's, its own side of the gates kept apart), the stairs and the platforms over it. A link
     train standing at a platform with its doors open takes you aboard through the door you walk up to (E, or into the
     doorway); the ride then runs on the real track, and mid-sea (the trip's handover) the far world, built while you ride,
     takes the session over (HQV.hqTransit.carried, adopt above): no cinematic, no fade. */
  var IL_STEP = 1.3;           // m: stepping this near an open door of a link train takes you in (the platform edge keeps you 0.3 m back)
  var ilSide = null, ilBand = false, ilSaid = {}, ilClose = {}, ilPeople = [], ilExtras = false;
  function ilFeet(x, z){ var a = tryf(function(){ return c.avatar ? c.avatar() : null; }, null); return a && Math.hypot(a.x - x, a.z - z) < 4 && a.hy != null && isFinite(a.hy) ? +a.hy : null; }
  function ilNear(x, z){ return !!ILS && !under && Math.hypot(x - ILS.x, z - ILS.z) < ILS.half + 60; }
  function ilGateOk(){ return !WL || ilSide === true || !!ticket(); }
  T.ilGateOk = ilGateOk;
  T.ilStation = function(){ return ILS; };
  // the link trains standing at this station (doors on the platform side, world frame): [{v, doors, open, leaving}]
  function ilTrains(ms){
    if(!ILS || !IL) return [];
    var out = [], o0 = IL.origin();
    (tryf(function(){ return IL.vehicles(ms); }, []) || []).forEach(function(v){
      if(!(v.doors > 0) || Math.hypot(v.x - ILS.x, v.z - ILS.z) > ILS.half) return;
      var leaving = v.dir === IL.dir, Rv = IL.route(v.line, v.dir); if(!Rv) return;
      var side = IL.sideHere(v.line, !leaving), doors = ILS.doorsOf(Rv, v.along, o0, side);
      out.push({v: v, doors: doors, open: v.doors, leaving: leaving, id: v.id});
    });
    return out;
  }
  // the open door of a leaving train nearest p within r m, on the platform: {v, door, d}
  function ilDoorNear(p, ms, r){
    if(!ILS) return null;
    var y = feetY(); if(!ILS.upper(y)) return null;
    var best = null;
    ilTrains(ms).forEach(function(T0){
      if(T0.open < 0.5) return;
      T0.doors.forEach(function(d){ var dd = Math.hypot(d.x - p.x, d.z - p.z); if(dd <= r && Math.abs(d.y - (y || d.y)) < 1.6 && (!best || dd < best.d)) best = {v: T0.v, door: d, d: dd, leaving: T0.leaving}; });
    });
    return best;
  }
  function ilHop(h, ms){
    if(!h || !IL) return false;
    if(!h.leaving){ say("This train has just come in from " + (h.v.line ? "the island" : "there") + ": it goes nowhere until its next run."); return true; }
    var L0 = (IL.lines() || []).filter(function(l){ return l.id === h.v.line; })[0];
    var t = L0 && tryf(function(){ return IL.trip(L0.id, L0.stops[0], L0.stops[1], ms); }, null);
    if(!t || t.vehicle !== h.v.id){ say("The doors are closing: the next train is in five minutes."); return true; }
    var m = me();
    return !!startTrip(t, [], {hop: true, at: {x: m.x, z: m.z}, boardDoor: {x: h.door.x, y: h.door.y, z: h.door.z}});
  }
  function ilBoard(p){
    if(!IL || !o.openMenu) return false;
    var st = IL.stops()[0], rows = T.board(st.id, "link");
    o.openMenu("Island Link · " + (st.name || "departures"), rows.map(function(r){ return {text: r.text.replace(/ · 0 coins$/, "") + " · platform " + (r.trip.plat || 1) + " · walk up and in at a door", fn: function(){
      if(!ticket(Date.now()) && ilSide !== true) say("You need a ticket for the gates: the machines by the wall sell them (E), free.");
      startTrip(r.trip, [], {walkOn: true});
    }}; }));
    return true;
  }
  function ilStep(ms){
    if(!ILS || under){ ilSide = null; ilBand = false; return; }
    var m = me(), y = feetY();
    if(!ilNear(m.x, m.z)) { ilSide = null; ilBand = false; return; }
    ilWant = true; loadFar();
    var g = ILS.gateAt(m.x, m.z, y);
    if(!g){
      var paid = ILS.paidAt(m.x, m.z, y);
      if(ilBand && ilSide === false && paid === true && WL){
        var r = tryf(function(){ return WL.tap(ms); }, null);
        if(r && r.ok){ announce(r.text); sfxM("validator", {pos: {x: m.x, y: (y || 0) + 1, z: m.z}, kind: "door"}); }
      }
      if(paid != null) ilSide = paid;
      ilBand = false;
    } else ilBand = true;
    // the trains at your platform: their doors open (once), closing; walking into a doorway takes you aboard
    if(ILS.upper(y)){
      ilTrains(ms).forEach(function(T0){
        var v = T0.v, near = T0.doors.some(function(d){ return Math.hypot(d.x - m.x, d.z - m.z) < 40; });
        if(!near) return;
        if(v.doors >= 0.5 && !ilSaid[v.id]){
          ilSaid[v.id] = ms;
          var L0 = (IL.lines() || []).filter(function(l){ return l.id === v.line; })[0];
          announce(T0.leaving ? (L0 ? L0.name : "Island Link") + ", platform " + (L0 ? L0.plat : "") + ": doors open. Walk in at any door." : "The Island Link from " + (L0 ? L0.name.replace(/^Island Link to /, "") : "the island") + " has arrived: passengers getting off first, please.");
        }
        if(ilSaid[v.id] && v.doors < 0.5 && v.doors > 0 && !ilClose[v.id]){ ilClose[v.id] = 1; announce("Stand clear: the doors are closing."); }
      });
      Object.keys(ilSaid).forEach(function(k){ if(ms - ilSaid[k] > 120000){ delete ilSaid[k]; delete ilClose[k]; } });
      if(ride && ride.walkOn && (ride.phase === "walk" || ride.phase === "wait")){
        var hw = ilDoorNear(m, ms, IL_STEP);
        if(hw && ride.trip && hw.v.id === ride.trip.vehicle) tryf(function(){ ride.boardAt({x: hw.door.x, y: hw.door.y, z: hw.door.z}, ms, {x: m.x, y: y, z: m.z}); });
      } else if(!ride && ms - rideEnd > HOP_COOL){ var h = ilDoorNear(m, ms, IL_STEP); if(h && h.leaving) ilHop(h, ms); }
    }
  }
  // this City's passengers through the station (hqILStation.walkers): drawn with the residents (npcdraw's extras)
  function ilWalkers(ms){
    if(!ILS || !IL) return [];
    var RL = HQV.hqRail, o0 = IL.origin(), deps = [], arrs = [], DW = (RL.LINK_DWELL || 40)*1000, other = IL.dir === "in" ? "out" : "in";
    (IL.lines() || []).forEach(function(l){
      var pi = -1; ILS.plats.forEach(function(q, i){ if(q.tracks.some(function(t2){ return String(t2.plat) === String(l.plat); })) pi = i; });
      if(pi < 0) return;
      var tv = (ILS.plats[pi].tracks.filter(function(t2){ return String(t2.plat) === String(l.plat); })[0] || {}).v || 0;
      var Rd = IL.route(l.id, IL.dir), Ra = IL.route(l.id, other);
      if(Rd) RL.linkDepartures(l.island, IL.dir, ms, 30000, 420000).forEach(function(dep){
        deps.push({key: l.id + ":" + dep, at: dep, open: dep - DW, plat: pi, track: tv, doors: ILS.doorsOf(Rd, Rd.s0, o0, IL.sideHere(l.id, false))});
      });
      if(Ra) RL.linkDepartures(l.island, other, ms - Ra.T*1000, 120000, 0).forEach(function(dep){
        var at = dep + Ra.T*1000; if(at <= ms) arrs.push({key: l.id + ":a" + dep, at: at, plat: pi, track: tv, doors: ILS.doorsOf(Ra, Ra.s1, o0, IL.sideHere(l.id, true))});
      });
    });
    return HQV.hqILStation.walkers(ILS, ms, {deps: deps, arrs: arrs, max: 48});
  }
  // the ride on: the far world built while you ride (from boarding), and taken over mid-sea once it is ready
  function linkStep(ms){
    var tr = ride && ride.trip;
    if(!tr || tr.mode !== "link" || !tr.world || tr.frame === "to" || !HQV.hqRail.sameWorld(tr.from_world, worldId)) return;
    var ph = ride.phase;
    if(ph !== "board" && ph !== "seated" && ph !== "standing") return;
    if(!tr._pre && c.prebuildCity){ tr._pre = true; tryf(function(){ c.prebuildCity(tr.world); }); }
    if(ph === "board" || ms < num(tr.hand, Infinity)) return;
    var built = tryf(function(){ return !!(c.cityBuilt && c.cityBuilt(tr.world)); }, false);
    if(!built){
      // (not ready by the far platform: the slow way, behind the loading screen)
      if(ms > num(tr.reach, Infinity) - 15000 && !tr._slow && c.goCity){
        tr._slow = true; HQV.hqTransit.carried = {S: ride, trip: tr, cam: rideCam}; tr.frame = "to"; ride = null;
        if(!tryf(function(){ return c.goCity(tr.world, null); }, false)){ tr.frame = null; ride = HQV.hqTransit.carried.S; HQV.hqTransit.carried = null; }
      }
      return;
    }
    var Sx = ride;
    HQV.hqTransit.carried = {S: Sx, trip: tr, cam: rideCam};
    tr.frame = "to"; ride = null;
    var ok = tryf(function(){ return !!(c.swapCity && c.swapCity(tr.world)); }, false);
    if(!ok){ tr.frame = null; ride = Sx; HQV.hqTransit.carried = null; }
  }
  T.ilWalkers = function(ms){ return ilPeople; };
  T.ilCamHit = function(a, b){ return ILS && !under && (ilNear(a.x, a.z) || ilNear(b.x, b.z)) ? tryf(function(){ return ILS.camHit(a, b); }, 1) : 1; };
  T.ilCeil = function(x, y, z){ return ILS && !under && ilNear(x, z) ? tryf(function(){ return ILS.ceilAt(x, y, z); }, null) : null; };
  T.ilGround = function(x, z){
    if(!ILS || under || !ilNear(x, z)) return null;
    var a = tryf(function(){ return c.avatar ? c.avatar() : null; }, null), h = a && a.hy != null ? +a.hy : null;
    if(!(h != null && ILS.upper(h))) return null;
    var f = ILS.floorAt(x, h + 0.5, z);
    return f ? f.y : null;
  };

  /* ---------- the ground below the street ---------- */
  function feet(x, z){ var a = tryf(function(){ return c.avatar ? c.avatar() : null; }, null); return a && Math.hypot(a.x - x, a.z - z) < 4 && a.hy != null && isFinite(a.hy) ? a.hy : null; }
  function belowStreet(x, z){ return under || !!(MV && MV.rampAt && tryf(function(){ return MV.rampAt(x, z); }, null)); }
  T.ground = function(x, z){
    // [island trains] the IL station's hall, stairs and platforms, where you stand
    if(ILS && !under && ilNear(x, z)){ var ih = ilFeet(x, z); if(ih != null){ var fl = ILS.floorAt(x, ih, z); if(fl) return fl.y; if(ILS.upper(ih)) return ih; } }
    if(!MV || !MV.walkable || !belowStreet(x, z)) return null;
    var h = feet(x, z), y = h != null ? h : (under ? street(x, z) - 6 : street(x, z));
    var f = tryf(function(){ return MV.walkable(x, y, z); }, null);
    return f && isFinite(+f.y) ? +f.y : (under ? y : null);
  };
  // [3.36] the levels below the street, asked at a height (the deck you are on, not the first floor found): the floor at
  // (x, z) on the level at y -> {y, kind, station} | null (on the track, in a wall, outside), and whether (x, y, z) is
  // inside a station's box at all (over the track is inside, with no floor)
  T.floorAt = function(x, z, y){ return MV && MV.walkable && y != null && isFinite(y) ? tryf(function(){ return MV.walkable(x, y, z); }, null) : null; };
  T.inside = function(x, y, z){ return !!(MV && MV.isUnder && tryf(function(){ return MV.isUnder(x, y, z); }, false)); };
  // [stations] the camera below the street: how far along from -> to it may go inside the station's rooms (0..1), and the
  // ceiling over (x, z) of the room your head is in
  T.camHit = function(a, b){
    var t = LAYM && LAYM.camHit ? tryf(function(){ return LAYM.camHit(a, b); }, 1) : 1;
    return msim && t > 0 ? Math.min(t, tryf(function(){ return trainHit(a, b, t); }, t)) : t;
  };
  // the trains are solid to the camera too: from outside one, the ray stops at its side; from inside one (you are walking in)
  // it stays inside that car
  var CAR_BOX = HQV.hqMetro ? {hw: HQV.hqMetro.CAR_HW || 1.4, hl: (HQV.hqMetro.CAR_L || 19)/2, fl: HQV.hqMetro.FLOOR || 1.1} : null;
  function trainHit(a, b, t){
    if(!CAR_BOX || !msim.carPose) return t;
    var ms = lastMs || Date.now(), cars = [];
    (msim.vehicles(ms) || []).forEach(function(v){ if(Math.hypot(v.x - a.x, v.z - a.z) > 70) return; for(var k = 0; k < (HQV.hqMetro.CARS || 4); k++){ var cp = msim.carPose(v, k); if(cp) cars.push(cp); } });
    if(!cars.length) return t;
    function inCar(cp, x, y, z){ var dx = x - cp.x, dz = z - cp.z, s = Math.sin(cp.yaw), c = Math.cos(cp.yaw), lz = dx*s + dz*c, lx = dx*c - dz*s;
      return Math.abs(lx) <= CAR_BOX.hw + 0.15 && Math.abs(lz) <= CAR_BOX.hl + 0.3 && y >= cp.y - 0.2 && y <= cp.y + CAR_BOX.fl + 2.75; }
    var home = null; cars.forEach(function(cp){ if(!home && inCar(cp, a.x, a.y, a.z)) home = cp; });
    var dx = b.x - a.x, dy = b.y - a.y, dz = b.z - a.z, n = Math.max(4, Math.ceil(Math.sqrt(dx*dx + dy*dy + dz*dz)*t/0.15));
    for(var i = 1; i <= n; i++){
      var f = t*i/n, x = a.x + dx*f, y = a.y + dy*f, z = a.z + dz*f;
      if(home){ if(!inCar(home, x, y, z)) return Math.max(0, t*(i - 1)/n); continue; }
      for(var j = 0; j < cars.length; j++) if(inCar(cars[j], x, y, z)) return Math.max(0, t*(i - 1)/n);
    }
    return t;
  }
  T.ceilAt = function(x, y, z){ return LAYM && LAYM.ceilAt ? tryf(function(){ return LAYM.ceilAt(x, y, z); }, null) : null; };
  T.blocked = function(x, z){
    if(ILS && !under && ilNear(x, z)){ var ih = ilFeet(x, z); if(ih != null){ var ib = ILS.blocked(x, z, ih, ilGateOk);
      if(ib === true){ var gg = ILS.gateAt(x, z, ih); if(gg && gg.lane >= 0 && Date.now() - gateSaid > 15000){ gateSaid = Date.now(); say("The gate stays shut: you need a ticket. The machines by the wall sell them (E), free."); } }
      if(ib != null) return ib; } }
    if(!MV || !MV.walkable || !belowStreet(x, z)) return null;
    var h = feet(x, z), y = h != null ? h : street(x, z);
    var wf = tryf(function(){ return MV.walkable(x, y, z); }, null);
    if(!wf) return true;
    // [stations] no stepping off an edge (into a stair's well over its balustrade), nor through a stair's side walls: a
    // stair is walked on and off at its ends; and your body keeps 0.3 m from every edge and wall
    if(h != null && under){
      if(wf.y < h - 0.6) return true;
      var av = tryf(function(){ return c.avatar ? c.avatar() : null; }, null);
      if(av && LAYM && LAYM.stepBlocked && tryf(function(){ return LAYM.stepBlocked(av.x, av.z, x, z, h); }, false)) return true;
      var offs = [[0.3, 0], [-0.3, 0], [0, 0.3], [0, -0.3]];
      for(var oi = 0; oi < offs.length; oi++){
        var ox = x + offs[oi][0], oz = z + offs[oi][1], w2 = tryf(function(){ return MV.walkable(ox, h, oz); }, null);
        if(!w2 || w2.y < h - 0.6) return true;
      }
    }
    // [transit pass] the gate lines: the cabinets and glass always, a lane unless it opens for you
    var g = under && LAYM ? tryf(function(){ return LAYM.gateAt(x, y, z); }, null) : null;
    if(g && (g.lane < 0 || !gateOk())){
      if(g.lane >= 0 && Date.now() - gateSaid > 15000){ gateSaid = Date.now(); say("The gate stays shut: you need a ticket. Buy one at the machines by the wall (E), or in the phone's Tickets app."); }
      return true;
    }
    return false;
  };
  // [3.36] a metro entrance's stairs, its lift or its canopy (2.5 m round the street door): no vehicle goes there
  T.noVehicle = function(x, z){
    if(ILS && !under && ILS.inHall(x, z, 1)) return true;                               // [island trains] the IL station's hall
    return !!(MV && MV.entranceAt && (tryf(function(){ return MV.rampAt && MV.rampAt(x, z); }, null) || tryf(function(){ return MV.entranceAt(x, z, 2.5); }, null)));
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
    ilWant = true; loadFar();
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
    // [stations] below the street the street is hidden, except while the camera itself is up in the open air: coming up
    // an entrance stair the chase camera clears the street a few steps before your feet do (the switch is at the feet),
    // and going down it is still up there for a frame or two; with the street hidden it would look at nothing
    var camUp = !!(under && cam && cam.y != null && isFinite(cam.y) && cam.y > street(cam.x, cam.z) + 0.2 && !T.inside(cam.x, cam.y, cam.z));
    if(hideNext){ hideNext = false; if(under && !camUp) surfaceOn(false); }
    else if(under && camUp !== surfShown) surfaceOn(camUp);
    var m = me(), camP = cam && cam.x != null ? cam : m;
    if(ride) tryf(function(){ ride.step(ms, {x: m.x, y: m.y, z: m.z}); });
    tryf(function(){ passStep(ms); });
    tryf(function(){ ilStep(ms); });
    tryf(function(){ linkStep(ms); });
    if(ride && ride.trip && ride.trip.mode === "link" && V.link && V.link.ride){ var rs = tryf(function(){ return ride.info(ms); }, null); tryf(function(){ V.link.ride(ride.trip, rs ? rs.seat : null); }); }
    // (aboard: the way to the station's doors is done with)
    if(ride && ride.trip && ride.trip.mode === "link" && !ride.trip._routeOff && ride.phase !== "walk" && ride.phase !== "wait"){ ride.trip._routeOff = true; if(o.showRoute) tryf(function(){ o.showRoute(null); }); }
    if(ILSv){
      ilPeople = tryf(function(){ return ilWalkers(ms); }, []) || [];
      if(!ilExtras && o.ndraw){ var nd = tryf(function(){ return o.ndraw(); }, null); if(nd && nd.addExtras){ ilExtras = true; T.unExtras = nd.addExtras(function(){ return ilPeople.map(function(r){ var q = {}; for(var k in r) q[k] = r[k]; return q; }); }); } }
      var trs = tryf(function(){ return ilTrains(ms); }, []) || [];
      if(ride && ride.trip && ride.trip.mode === "link" && V.link && V.link.rideDoors) trs = trs.filter(function(t2){ return t2.id !== ride.trip.vehicle; }).concat(tryf(function(){ return V.link.rideDoors(ms, ILS); }, []) || []);
      var mm = me();
      tryf(function(){ ILSv.update(ms, dt, cam, {calm: calm() || reduced(), me: {x: mm.x, y: feetY(), z: mm.z}, gateOk: ilGateOk(), people: ilPeople, trains: trs}); });
    }
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
    if(HQV.hqTransit.cur === T) HQV.hqTransit.cur = null;
    if(T.unAch) tryf(T.unAch);
    if(T.unExtras) tryf(T.unExtras);
    if(ILSv) tryf(function(){ ILSv.dispose(); });
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
