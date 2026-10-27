/* Claude HQ: City play feature "carjack" (HQ 3.27): take a car off the street, GTA style. Registers with HQV.cityPlay
 * (games/cityplay.js); nothing here goes to a server.
 *
 * On foot within JACK_R m of an ordinary traffic car (games/traffic.js: kind "car", type "car", the ones drawn as one of
 * the garage's cars) going no faster than JACK_V m/s (stopped at a light, queued, or braking for you standing in its
 * lane), the HUD offers "E  Take the car" (hq3d.js shows it as E: you get into a vehicle, as with your own; F stays the
 * key for talking and doors). E takes it: hq3d builds that same car (traffic.carLook: its catalogue model and paint, a
 * pure function of the vehicle's id, so it is the car you saw) where the traffic car stood, facing its way, and seats you
 * in it with the City's own driving (ctx.c.carjack(look) -> true once you sit in it). The traffic car is then hidden on
 * this client (hide(list): the City drops it from what it draws, collides with and hands the other features), for as long
 * as you have it: getting out (E) leaves it parked where you stopped (hq3d keeps it), and once you walk off and leave it
 * far behind, take another or leave the world, hq3d lets it go (ctx.c.carjacked() -> null) and the traffic car is back
 * on its timetable. The traffic sim itself never changes: everyone else's street is as it was, and they see you driving
 * the car as any vehicle you ride (hq presence's vehicle id and paint index, nothing new).
 * Emits "carjack" {x, z, id} as you take it: the police (games/playheat.js) add half a star for "stealing a car", only
 * when one of their cars is close enough to see it. Announced: "You took the car: the <brand model>." (ctx.api.announce).
 * The feature: jackPrompt(p) -> text | null, near(p) -> the car you would take {vid, x, z, yaw, model, paint, hex, name}
 *   | null, take(p) -> bool, taken() -> the hidden vehicle id | null, hide(list) -> list without it, release().
 * Nothing here is random: the car and its look are the traffic's, the same on every client. */
(function(){
"use strict";
var root = typeof window !== "undefined" ? window : self;
var HQV = root.HQV = root.HQV || {};

var JACK_R = 3.5;          // m: from the car's centre (its side, a step from the door; its nose or tail)
var JACK_V = 4;            // m/s: a car going faster than this drives off before you reach the door

function num(v, d){ return typeof v === "number" && isFinite(v) ? v : d; }

function create(ctx){
  ctx = ctx || {};
  var S = {traffic: [], ride: null, taken: null, dead: false, cat: null, models: []};
  function TR(){ return HQV.traffic || null; }
  function announce(t){ try { if(ctx.api && ctx.api.announce) ctx.api.announce(t); } catch(e){} }
  // the street's models: the catalogue hq3d has loaded (the same pick traffic.js draws from)
  function models(){
    var cat = null;
    try { cat = ctx.c && typeof ctx.c.catalogue === "function" ? ctx.c.catalogue() : null; } catch(e){ cat = null; }
    if(cat !== S.cat){ S.cat = cat; try { S.models = cat && TR() && TR().streetCars ? TR().streetCars(cat) || [] : []; } catch(e){ S.models = []; } }
    return S.models;
  }
  function nameOf(id){
    var L = (S.cat && S.cat.vehicles) || [];
    for(var i = 0; i < L.length; i++) if(L[i] && L[i].id === id) return String((L[i].brand ? L[i].brand + " " : "") + (L[i].model || "")).replace(/\s*\([^)]*\)\s*$/, "").trim();
    return "";
  }
  function near(p){
    if(S.dead || S.ride || !p || !isFinite(+p.x) || !isFinite(+p.z)) return null;
    var T = TR(); if(!T || !T.carLook || !T.modelled) return null;
    var M = models(); if(!M.length) return null;
    var best = null, bd = JACK_R;
    for(var i = 0; i < S.traffic.length; i++){
      var v = S.traffic[i];
      if(!T.modelled(v) || v.id == null || String(v.id) === S.taken || Math.abs(num(v.speed, 0)) > JACK_V) continue;
      var d = Math.hypot(num(v.x, 1e9) - p.x, num(v.z, 1e9) - p.z);
      if(d <= bd){ bd = d; best = v; }
    }
    if(!best) return null;
    var lk = T.carLook(best.id, M); if(!lk || !lk.id) return null;
    return {vid: String(best.id), x: best.x, y: num(best.y, 0), z: best.z, yaw: num(best.yaw, 0), model: lk.id, paint: lk.paint, hex: lk.hex, name: nameOf(lk.id)};
  }
  function take(p){
    var cand = near(p); if(!cand) return false;
    var ok = false;
    try { ok = !!(ctx.c && typeof ctx.c.carjack === "function" && ctx.c.carjack(cand)); } catch(e){ ok = false; }
    if(!ok) return false;
    S.taken = cand.vid;
    if(ctx.emit) ctx.emit("carjack", {x: cand.x, z: cand.z, id: cand.vid});
    announce("You took the car" + (cand.name ? ": the " + cand.name + "." : "."));
    return true;
  }
  function update(dt, f){
    if(S.dead) return;
    f = f || {};
    S.traffic = Array.isArray(f.traffic) ? f.traffic : [];
    var m = f.motion || {};
    S.ride = m.ride || null;
    // hq3d let it go (parked and left far behind, another taken, another world): the traffic car is back
    if(S.taken != null && ctx.c && typeof ctx.c.carjacked === "function"){
      var held = null;
      try { held = ctx.c.carjacked(); } catch(e){ held = null; }
      if(held == null || String(held) !== S.taken) S.taken = held != null ? String(held) : null;
    }
  }
  return {
    update: update, near: near, take: take,
    jackPrompt: function(p){ return near(p) ? "E  Take the car" : null; },
    taken: function(){ return S.taken; },
    hide: function(list){ if(S.taken == null || !Array.isArray(list)) return list; var t = S.taken; return list.filter(function(v){ return !v || String(v.id) !== t; }); },
    release: function(){ S.taken = null; },
    dispose: function(){ S.dead = true; S.traffic = []; S.taken = null; }
  };
}

if(HQV.cityPlay && HQV.cityPlay.register) HQV.cityPlay.register({id: "carjack", order: 45, create: create});
HQV.playCarjack = {create: create, JACK_R: JACK_R, JACK_V: JACK_V};
})();
