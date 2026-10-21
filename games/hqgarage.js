/* games/hqgarage.js — the vehicles you own (docs/plans/dealership-spec.md, "Ownership and economy").
 *
 * A thin client over the dashboard's proxies to the Arena, with a cache. The dealership
 * (games/hqdealer.js) and calling your vehicle (games/hqcall.js) code against exactly this:
 *
 *   HQV.hqGarage.mine()                  -> Promise<[{id, vehicle_id, paint, parked: {world, x, z, yaw} | null}]>
 *                                           (cached; mine(true) refetches). parked null: in its city's garage
 *                                           (the normal state); set only for a vehicle out on a trip.
 *   HQV.hqGarage.buy(vehicleId, paint)   -> Promise<{id} | {error, status}>   (claim: everything is free for now)
 *   HQV.hqGarage.park(id, {world, x, z, yaw})  -> Promise   where it stands now
 *   HQV.hqGarage.park(id, null)          -> Promise   back in its garage
 *   HQV.hqGarage.cached()                -> the last list, or null
 *   HQV.hqGarage.onChange(fn)            -> unsubscribe fn; fn(list) after every change
 *
 * Egress (through GET /api/arena/vehicles/mine, POST /api/arena/vehicles/buy and
 * /api/arena/vehicles/<id>/park): catalogue ids, paint indexes, owned-vehicle ids, a world id and
 * coordinates. Nothing else. No transcript data.
 */
(function(){
  "use strict";
  var HQV = (typeof window !== "undefined" ? window : globalThis).HQV = (typeof window !== "undefined" ? window : globalThis).HQV || {};
  var ID_RE = /^[a-z0-9-]{1,48}$/, OWNED_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
  var list = null, inflight = null, subs = [];
  var io = {fetch: typeof fetch === "function" ? function(u, o){ return fetch(u, o); } : null};

  function csrf(){
    try {
      if(typeof CSRF === "string" && CSRF) return CSRF;
      var m = typeof document !== "undefined" && document.querySelector('meta[name="hq-csrf"]');
      return m ? m.getAttribute("content") || "" : "";
    } catch(e){ return ""; }
  }
  function getJson(u){
    if(!io.fetch) return Promise.reject(new Error("offline"));
    return io.fetch(u, {cache: "no-store"}).then(function(r){
      return r.json().catch(function(){ return {}; }).then(function(j){ return {status: r.status, ok: r.ok, body: j}; });
    });
  }
  function postJson(u, body){
    if(!io.fetch) return Promise.reject(new Error("offline"));
    return io.fetch(u, {method: "POST", headers: {"Content-Type": "application/json", "X-HQ-Token": csrf()}, body: JSON.stringify(body)})
      .then(function(r){ return r.json().catch(function(){ return {}; }).then(function(j){ return {status: r.status, ok: r.ok, body: j}; }); });
  }
  function clean(rows){
    return (Array.isArray(rows) ? rows : []).filter(function(v){
      return v && OWNED_RE.test(String(v.id)) && ID_RE.test(String(v.vehicle_id));
    }).map(function(v){
      var p = v.parked;
      return {id: v.id, vehicle_id: v.vehicle_id, paint: Math.max(0, v.paint | 0),
              parked: p && typeof p.world === "string" && isFinite(p.x) && isFinite(p.z) ? {world: p.world, x: +p.x, z: +p.z, yaw: +p.yaw || 0} : null};
    });
  }
  function changed(){
    var l = list;
    subs.slice().forEach(function(f){ try { f(l); } catch(e){} });
  }

  function mine(fresh){
    if(list && !fresh) return Promise.resolve(list);
    if(inflight) return inflight;
    inflight = getJson("/api/arena/vehicles/mine").then(function(r){
      inflight = null;
      if(!r.ok) throw new Error((r.body && (r.body.error || r.body.detail)) || ("HTTP " + r.status));
      list = clean(r.body && r.body.vehicles);
      changed();
      return list;
    }, function(e){ inflight = null; throw e; });
    return inflight;
  }

  function buy(vehicleId, paint){
    if(!ID_RE.test(String(vehicleId))) return Promise.resolve({error: "unknown vehicle", status: 400});
    return postJson("/api/arena/vehicles/buy", {vehicle_id: String(vehicleId), paint: Math.max(0, Math.min(63, paint | 0))}).then(function(r){
      var b = r.body || {};
      if(!r.ok || !b.vehicle) return {error: b.error || b.detail || ("HTTP " + r.status), status: r.status};
      var v = clean([b.vehicle])[0];
      if(v){ list = (list || []).concat([v]); changed(); }
      return {id: v ? v.id : b.vehicle.id, coins: b.coins};
    }, function(e){ return {error: String(e && e.message || e), status: 0}; });
  }

  function park(id, pose){
    if(!OWNED_RE.test(String(id))) return Promise.reject(new Error("bad vehicle id"));
    var body = pose ? {world: String(pose.world), x: +pose.x, z: +pose.z, yaw: +pose.yaw || 0} : {garage: true};
    if(pose && !(isFinite(body.x) && isFinite(body.z) && isFinite(body.yaw))) return Promise.reject(new Error("bad pose"));
    return postJson("/api/arena/vehicles/" + id + "/park", body).then(function(r){
      if(!r.ok) throw new Error((r.body && (r.body.error || r.body.detail)) || ("HTTP " + r.status));
      (list || []).forEach(function(v){ if(v.id === id) v.parked = pose ? {world: body.world, x: body.x, z: body.z, yaw: body.yaw} : null; });
      changed();
      return r.body;
    });
  }

  HQV.hqGarage = {
    mine: mine, buy: buy, park: park,
    cached: function(){ return list; },
    onChange: function(f){ if(typeof f !== "function") return function(){}; subs.push(f); return function(){ subs = subs.filter(function(g){ return g !== f; }); }; },
    // tests: a fake fetch, and a clean slate
    _io: io, _reset: function(){ list = null; inflight = null; subs = []; }
  };
})();
