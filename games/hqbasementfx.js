/* Claude HQ 3.4: the basement garage's experience layer (HQV.hqBasementFx, spec "D: experience").
 *
 * Everything here is optional to games/hqbasement.js (B): every hook tolerates a null ctx, a missing
 * THREE, a missing engine and a missing world, and every animation is a function of time added up, so
 * 30 Hz and 144 Hz agree. Motion scales by k (1 normal, 0 Calm / reduced motion): at k = 0 nothing moves.
 *
 *   liftArrival(ctx, w, {dir})   -> {update(t, dt, k), done(), state()}   the car lift arriving: a light
 *                                   sweep down the shaft, the floor indicator counting G..B1 (or back up),
 *                                   a chime when the doors part, a little settling dust. Instant in Calm.
 *   lobbyRide(ctx, w)            -> same shape: the person lift from the lobby (ding, indicator, doors)
 *   valetPlan(from, to)          -> {phases:[{name, t0, t1}], total}   pure: the valet's schedule
 *   valetAt(plan, t)             -> {phase, u, i}                       pure: where on it at time t
 *   valet(id, to)                   global: a toast, and when a basement world is live (enter()) the prop
 *                                   drives to the lift pad and sinks (to the common garage), or rises on
 *                                   the pad and drives to its bay (to the basement)
 *   plinths(ctx, g, plinths)     -> {update(t, dt, k), state()}   turntables 0.25 rad/s * k, breathing spots
 *   trophyWall(ctx, g, at)       -> {g, plaques}                   Rally / Kart bests from the local save,
 *                                   or engraved placeholder plaques (deterministic from the uid)
 *   plaqueLayout(uid, bests)     -> [{x, y, w, h, title, line, tier}]   pure
 *   lounge(ctx, g, at)           -> {update(t, dt, k)}   a fishtank: fish swim on fixed loops (Calm: still)
 *   lighting(w, {night, weather}) -> {warm, sheen, exposure}   warmer at night, a wet sheen when it rains
 *   photoSpot(ctx, g, at)        -> {g, hit, spot, tip}   a backdrop; hit.userData.tip "Press P for photo mode"
 *   sound(name)                     through HQV.engine.sfx when present; silent otherwise
 *   enter(ctx, w) / update(t, dt, k) / setTime(night, weather) / leave()   B's world hooks
 *   _reset()                        test hook
 * Frames as the 3D city's: metres, y up, yaw 0 faces +z.
 */
(function(){
"use strict";
var HQV = window.HQV = window.HQV || {};

var LIFT_T = 2.6, CALM_T = 0.3, DEPTH = 6;          // s, s, m
var SPIN = 0.25;                                    // rad/s: the showcase turntables at k = 1
var PAD_DEFAULT = {x: 0, z: 14};                    // m: when B gives no layout
var live = null;                                    // {ctx, w, valets:[]} while a basement world is up

function num(v, d){ v = +v; return isFinite(v) ? v : d; }
function clamp(v, a, b){ return v < a ? a : v > b ? b : v; }
function ease(u){ u = clamp(u, 0, 1); return u < 0.5 ? 2*u*u : 1 - Math.pow(-2*u + 2, 2)/2; }
function hashStr(s){ var h = 2166136261 >>> 0; s = String(s); for(var i = 0; i < s.length; i++){ h ^= s.charCodeAt(i); h = Math.imul(h, 16777619) >>> 0; } return h >>> 0; }
function mulberry32(a){ a = a >>> 0; return function(){ a = (a + 0x6D2B79F5) >>> 0; var t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0)/4294967296; }; }
function T(ctx){ return ctx && ctx.THREE && ctx.THREE.Group ? ctx.THREE : null; }
function kOf(k){ return clamp(num(k, 1), 0, 1); }

function sound(name){
  var E = HQV.engine; if(!E || typeof E.sfx !== "function") return false;
  try { E.sfx(name); return true; } catch(e){ return false; }
}
function toast(msg){
  try { if(HQV.api && typeof HQV.api.toast === "function"){ HQV.api.toast(msg); return; } } catch(e){}
  try { if(HQV.engine && HQV.engine.say) HQV.engine.say(msg); } catch(e){}
}
function tex(ctx, w, h, draw){
  if(!ctx) return null;
  try {
    if(typeof ctx.canvasTex === "function") return ctx.canvasTex(w, h, draw);
  } catch(e){}
  return null;
}

/* ---------- a ride (car lift or person lift): a timed sequence of beats ---------- */
// beats: [{at: s, fn}] fired once as the clock passes them; the clock only runs at k > 0 (Calm: done at once)
function ride(ctx, w, kind, dir){
  var THREE = T(ctx), down = dir !== "up", total = kind === "carlift" ? LIFT_T : 1.6, t = 0, fired = 0, over = false;
  var floors = down ? ["G", "B1"] : ["B1", "G"], st = {floor: floors[0], sweep: 0, doors: 0, dust: 0, chimed: false, kind: kind, dir: down ? "down" : "up"};
  var parent = w && (w.scene || w.group || w.g) || null, g = null, sweep = null, dust = null, dustBase = null;
  if(THREE && parent && parent.add){
    try {
      g = new THREE.Group(); g.name = "basementfx:" + kind;
      // the light sweep: one additive ring that runs down (or up) the shaft
      sweep = new THREE.Mesh(new THREE.CylinderGeometry(2.2, 2.2, 0.12, 32, 1, true),
        new THREE.MeshBasicMaterial({color: 0x9fe8ff, transparent: true, opacity: 0.0, depthWrite: false, blending: THREE.AdditiveBlending}));
      g.add(sweep);
      // settling dust: one Points cloud, deterministic seeds
      var r = mulberry32(hashStr("dust:" + kind)), n = 48, pos = new Float32Array(n*3);
      for(var i = 0; i < n; i++){ pos[i*3] = (r() - 0.5)*5; pos[i*3 + 1] = r()*2.4; pos[i*3 + 2] = (r() - 0.5)*5; }
      dustBase = pos.slice ? pos.slice() : pos;
      var geo = new THREE.BufferGeometry(); geo.setAttribute("position", new THREE.BufferAttribute(pos, 3));
      dust = new THREE.Points(geo, new THREE.PointsMaterial({color: 0xd8cfc0, size: 0.05, transparent: true, opacity: 0, depthWrite: false}));
      g.add(dust);
      var at = (w && w.fxPad) || (kind === "carlift" ? padOf(w) : (w && w.liftDoor) || null);
      if(at) g.position.set(num(at.x, 0), 0, num(at.z, 0));
      parent.add(g);
    } catch(e){ g = null; sweep = null; dust = null; }
  }
  sound(kind === "carlift" ? "door" : "ui");
  function apply(){
    var u = clamp(t/total, 0, 1);
    st.sweep = ease(Math.min(1, u/0.75));
    st.floor = u < 0.6 ? floors[0] : floors[1];
    st.doors = clamp((u - 0.75)/0.25, 0, 1);
    st.dust = u > 0.7 ? clamp(1 - (u - 0.7)/0.3, 0, 1) : 0;
    if(st.doors > 0 && !st.chimed){ st.chimed = true; sound("bell"); }
    if(sweep){ sweep.position.y = down ? 4.4 - st.sweep*4.4 : st.sweep*4.4; sweep.material.opacity = 0.55*(1 - Math.abs(st.sweep - 0.5)*2); }
    if(dust && dust.geometry && dustBase){
      var a = dust.geometry.attributes && dust.geometry.attributes.position;
      if(a && a.array){ for(var i = 1; i < a.array.length; i += 3) a.array[i] = Math.max(0, dustBase[i] - (1 - st.dust)*0.6); a.needsUpdate = true; }
      dust.material.opacity = 0.45*st.dust;
    }
  }
  function finish(){ t = total; apply(); over = true; if(g && g.parent && g.parent.remove) g.parent.remove(g); }
  return {
    update: function(_t, dt, k){
      if(over) return;
      k = kOf(k);
      if(k < 0.5){ t += Math.max(0, num(dt, 0)); if(t >= CALM_T){ finish(); } return; }   // Calm: instant-ish, no motion
      t += Math.max(0, num(dt, 0)); apply(); if(t >= total) finish();
    },
    done: function(){ return over; },
    finish: finish,
    state: function(){ return {floor: st.floor, sweep: st.sweep, doors: st.doors, dust: st.dust, chimed: st.chimed, kind: st.kind, dir: st.dir, t: t, total: total}; },
    group: g
  };
}
function liftArrival(ctx, w, o){ return ride(ctx, w, "carlift", o && o.dir); }
function lobbyRide(ctx, w){ return ride(ctx, w, "lift", "down"); }

/* ---------- the valet ---------- */
// basement -> carpark: drive to the lift pad, doors close, sink. carpark -> basement: rise on the pad, drive to the bay.
function valetPlan(from, to){
  var out = to === "carpark" || (to !== "basement" && from === "basement");
  var spec = out ? [["drive", 2.2], ["doors", 0.6], ["sink", 2.4]] : [["rise", 2.4], ["doors", 0.6], ["drive", 2.2]];
  var phases = [], t = 0;
  spec.forEach(function(p){ phases.push({name: p[0], t0: t, t1: t + p[1]}); t += p[1]; });
  return {from: out ? "basement" : "carpark", to: out ? "carpark" : "basement", phases: phases, total: t};
}
function valetAt(plan, t){
  t = clamp(num(t, 0), 0, plan.total);
  for(var i = 0; i < plan.phases.length; i++){
    var p = plan.phases[i];
    if(t <= p.t1 || i === plan.phases.length - 1) return {phase: p.name, u: clamp((t - p.t0)/Math.max(1e-6, p.t1 - p.t0), 0, 1), i: i};
  }
  return {phase: "done", u: 1, i: plan.phases.length};
}
function padOf(w){
  var B = HQV.hqBasement, L = null;
  try { L = B && B.layout ? B.layout(w && w.level) : null; } catch(e){ L = null; }
  var p = (w && w.pad) || (L && L.pad) || PAD_DEFAULT;
  return {x: num(p.x, PAD_DEFAULT.x), z: num(p.z, PAD_DEFAULT.z)};
}
function findProp(w, id){
  var list = w && w.bikes; if(!list || !list.length) return null;
  for(var i = 0; i < list.length; i++) if(list[i] && (list[i].id === "own:" + id || list[i].id === id)) return list[i];
  return null;
}
function valet(id, to, label){
  var name = label ? String(label).slice(0, 40) : "Your vehicle";
  if(!label) try {
    var mine = HQV.hqGarage && HQV.hqGarage.cached && HQV.hqGarage.cached(), row = null, cat = null;
    if(mine && mine.length) for(var i = 0; i < mine.length; i++) if(mine[i] && mine[i].id === id) row = mine[i];
    cat = live && live.ctx && typeof live.ctx.catalogue === "function" ? live.ctx.catalogue() : null;
    var e = row && cat && HQV.hqVehicles && HQV.hqVehicles.get ? HQV.hqVehicles.get(cat, row.vehicle_id) : null;
    if(e && e.name) name = String(e.name).slice(0, 40);
  } catch(e2){}
  toast(to === "basement" ? "Valet: " + name + " is on its way down to B1." : "Valet: " + name + " is off to the common multi-storey.");
  sound("ui");
  if(!live || !live.w) return null;
  var prop = findProp(live.w, id);
  var plan = valetPlan(to === "basement" ? "carpark" : "basement", to);
  if(!prop || !prop.g || !prop.g.position) return {plan: plan, prop: null};
  var pad = padOf(live.w), v = {id: id, prop: prop, plan: plan, t: 0,
    start: {x: num(prop.x, prop.g.position.x), z: num(prop.z, prop.g.position.z), y: num(prop.g.position.y, 0)}, pad: pad};
  if(plan.to === "basement"){ v.dest = {x: v.start.x, z: v.start.z}; v.start = {x: pad.x, z: pad.z, y: 0}; }
  live.valets.push(v);
  stepValet(v, 0, 1);
  return {plan: plan, prop: prop};
}
function stepValet(v, dt, k){
  v.t = Math.min(v.plan.total, v.t + (k < 0.5 ? v.plan.total : dt));       // Calm: jump to the end
  var s = valetAt(v.plan, v.t), P = v.prop.g.position, out = v.plan.to === "carpark";
  var a = out ? v.start : v.pad, b = out ? v.pad : v.dest, x = a.x, z = a.z, y = 0;
  if(out){
    if(s.phase === "drive"){ var e = ease(s.u); x = a.x + (b.x - a.x)*e; z = a.z + (b.z - a.z)*e; }
    else { x = b.x; z = b.z; if(s.phase === "sink") y = -DEPTH*ease(s.u); }
  } else {
    if(s.phase === "rise"){ y = -DEPTH*(1 - ease(s.u)); }
    else if(s.phase === "drive"){ var e2 = ease(s.u); x = a.x + (b.x - a.x)*e2; z = a.z + (b.z - a.z)*e2; }
  }
  P.x = x; P.z = z; P.y = y;
  if(s.phase === "drive" && (b.x !== a.x || b.z !== a.z) && v.prop.g.rotation) v.prop.g.rotation.y = Math.atan2(b.x - a.x, b.z - a.z);
  v.prop.x = x; v.prop.z = z;
  if(v.t >= v.plan.total && out && v.prop.g.visible !== undefined) v.prop.g.visible = false;
  return v.t >= v.plan.total;
}

/* ---------- showcase turntables ---------- */
function plinths(ctx, g, list){
  var THREE = T(ctx), tops = [], spots = [], ang = 0, breath = 0;
  (list || []).forEach(function(p, i){
    var top = p && (p.turn || p.top || p.g) || null, spot = null;
    if(!top && THREE && g && g.add){
      try {
        top = new THREE.Group(); top.position.set(num(p && p.x, 0), 0.32, num(p && p.z, 0)); g.add(top);
        spot = new THREE.Mesh(new THREE.ConeGeometry(1.9, 4, 24, 1, true),
          new THREE.MeshBasicMaterial({color: 0xfff1d6, transparent: true, opacity: 0.14, depthWrite: false, side: THREE.DoubleSide, blending: THREE.AdditiveBlending}));
        spot.position.set(num(p && p.x, 0), 2.1, num(p && p.z, 0)); g.add(spot);
      } catch(e){ top = null; spot = null; }
    }
    if(top) tops.push({o: top, yaw0: num(top.rotation && top.rotation.y, 0) + i*0.7});
    if(spot) spots.push(spot);
  });
  tops.forEach(function(t){ if(t.o.rotation) t.o.rotation.y = t.yaw0; });
  return {
    update: function(_t, dt, k){
      k = kOf(k); dt = Math.max(0, num(dt, 0)); if(k <= 0) return;
      ang += SPIN*k*dt; breath += dt*k;
      tops.forEach(function(t){ if(t.o.rotation) t.o.rotation.y = t.yaw0 + ang; });
      spots.forEach(function(s, i){ if(s.material) s.material.opacity = 0.11 + 0.05*(0.5 + 0.5*Math.sin(breath*1.3 + i*2.1)); });
    },
    state: function(){ return {angle: ang, count: tops.length}; },
    tops: tops
  };
}

/* ---------- the trophy wall ---------- */
function fmt(ms){ ms = Math.max(0, Math.round(num(ms, 0))); var m = Math.floor(ms/60000), s = (ms % 60000)/1000; return m + ":" + (s < 10 ? "0" : "") + s.toFixed(2); }
function localBests(){
  var out = [], S = null;
  try { S = HQV.api && HQV.api.save; } catch(e){ S = null; }
  function grab(game, label){
    var b = S && S[game] && S[game].best; if(!b || typeof b !== "object") return;
    Object.keys(b).sort().forEach(function(k){ var v = +b[k]; if(isFinite(v) && v > 0) out.push({game: label, track: String(k).slice(0, 24), ms: v}); });
  }
  grab("rally", "Rally"); grab("kart", "Kart");
  out.sort(function(a, b){ return a.ms - b.ms; });
  return out.slice(0, 6);
}
var PLACEHOLDERS = ["Founders' Cup", "Night Shift GP", "Basement 500", "Lobby Sprint", "Rooftop Classic", "Ramp Masters"];
function plaqueLayout(uid, bests){
  var r = mulberry32(hashStr("trophy:" + (uid || "hq"))), out = [], list = bests && bests.length ? bests : null, n = list ? list.length : 6;
  var names = PLACEHOLDERS.slice(), i;
  for(i = names.length - 1; i > 0; i--){ var j = Math.floor(r()*(i + 1)), t = names[i]; names[i] = names[j]; names[j] = t; }
  for(i = 0; i < n; i++){
    var col = i % 3, row = Math.floor(i/3), b = list && list[i];
    out.push({x: (col - 1)*1.25, y: 2.2 - row*0.9, w: 1.05, h: 0.7,
      title: b ? b.game + " · " + b.track : names[i],
      line: b ? "Best " + fmt(b.ms) : "Engraving pending",
      tier: b ? (i === 0 ? "gold" : i < 3 ? "silver" : "bronze") : ["gold", "silver", "bronze"][Math.floor(r()*3)]});
  }
  return out;
}
var TIER = {gold: "#d9b25a", silver: "#c4cad3", bronze: "#b9784a"};
function trophyWall(ctx, g, at, uid){
  var bests = localBests(), plaques = plaqueLayout(uid || (ctx && ctx.uid) || "hq", bests);
  var THREE = T(ctx); if(!THREE || !g || !g.add) return {g: null, plaques: plaques};
  var wall = new THREE.Group(); at = at || {};
  wall.position.set(num(at.x, 0), 0, num(at.z, 0)); wall.rotation.y = num(at.yaw, 0);
  // one canvas for the whole wall: one draw call for every plaque
  var W = 768, H = 384, tx = tex(ctx, W, H, function(c){
    c.fillStyle = "#1a1714"; c.fillRect(0, 0, W, H);
    c.fillStyle = "#e9dcc0"; c.font = "bold 30px system-ui, sans-serif"; c.textAlign = "center"; c.fillText("HALL OF BESTS", W/2, 40);
    plaques.forEach(function(p){
      var px = W/2 + p.x/3.9*W - 110, py = H - (p.y + 0.35)/3*H + 20;
      c.fillStyle = TIER[p.tier] || TIER.bronze; c.fillRect(px, py, 220, 120);
      c.fillStyle = "rgba(0,0,0,0.55)"; c.fillRect(px + 8, py + 8, 204, 104);
      c.fillStyle = TIER[p.tier] || TIER.bronze; c.font = "bold 18px system-ui, sans-serif";
      c.fillText(String(p.title).slice(0, 22), px + 110, py + 50); c.font = "16px system-ui, sans-serif"; c.fillText(String(p.line).slice(0, 26), px + 110, py + 84);
    });
  });
  if(tx && tx.t){
    var m = new THREE.Mesh(new THREE.PlaneGeometry(3.9, 1.95), new THREE.MeshStandardMaterial({map: tx.t, roughness: 0.4, metalness: 0.35}));
    m.position.set(0, 2.0, 0.02); wall.add(m);
  }
  g.add(wall);
  return {g: wall, plaques: plaques};
}

/* ---------- the lounge fishtank ---------- */
function lounge(ctx, g, at){
  var THREE = T(ctx), fish = [], t = 0, tank = null; at = at || {};
  var r = mulberry32(hashStr("tank:" + num(at.x, 0) + ":" + num(at.z, 0)));
  if(THREE && g && g.add){
    try {
      tank = new THREE.Group(); tank.position.set(num(at.x, 0), 0, num(at.z, 0)); tank.rotation.y = num(at.yaw, 0);
      var glass = new THREE.Mesh(new THREE.BoxGeometry(2.4, 1.1, 0.6), new THREE.MeshPhysicalMaterial ?
        new THREE.MeshPhysicalMaterial({color: 0x3fa7c9, transparent: true, opacity: 0.32, roughness: 0.05, transmission: 0.4}) :
        new THREE.MeshBasicMaterial({color: 0x3fa7c9, transparent: true, opacity: 0.32}));
      glass.position.y = 1.25; tank.add(glass);
      var cols = [0xff8a3d, 0xffd23f, 0x5fd3e6, 0xe0559b, 0x9b8cf0];
      var fgeo = new THREE.ConeGeometry(0.05, 0.16, 6);
      for(var i = 0; i < 7; i++){
        var f = new THREE.Mesh(fgeo, new THREE.MeshBasicMaterial({color: cols[i % cols.length]}));
        f.rotation.z = Math.PI/2; tank.add(f);
        fish.push({o: f, ph: r()*Math.PI*2, sp: 0.4 + r()*0.5, y: 0.9 + r()*0.65, rz: 0.12 + r()*0.12});
      }
      g.add(tank);
    } catch(e){ fish = []; }
  }
  function place(){ fish.forEach(function(f){ var a = f.ph + t*f.sp; f.o.position.set(Math.sin(a)*1.0, f.y + Math.sin(a*2.3)*0.04, Math.cos(a)*f.rz); f.o.rotation.y = Math.cos(a) >= 0 ? 0 : Math.PI; }); }
  place();
  return {update: function(_t, dt, k){ k = kOf(k); if(k <= 0) return; t += Math.max(0, num(dt, 0))*k; place(); }, group: tank, fish: fish.length};
}

/* ---------- lighting mood ---------- */
function lighting(w, o){
  o = o || {};
  var night = !!o.night, wet = /rain|storm|drizzle|shower/i.test(String(o.weather || ""));
  var look = {warm: night ? 1 : 0, sheen: wet ? 1 : 0, exposure: night ? 0.92 : 1, tint: night ? 0xffd9a8 : 0xf4f7ff};
  if(w){
    try {
      var lights = w.fxLights || w.lights || [];
      for(var i = 0; i < lights.length; i++){ var L = lights[i]; if(L && L.color && L.color.setHex) L.color.setHex(look.tint); }
      var fl = w.floorMat || (w.floor && w.floor.material);
      if(fl && "roughness" in fl){ fl.roughness = wet ? 0.06 : 0.15; if("envMapIntensity" in fl) fl.envMapIntensity = wet ? 1.6 : 1.0; fl.needsUpdate = true; }
    } catch(e){}
    w.fxLook = look;
  }
  return look;
}

/* ---------- photo spot ---------- */
function photoSpot(ctx, g, at){
  var THREE = T(ctx); at = at || {};
  var spot = {tip: "Press P for photo mode", label: "Photo spot", front: {x: num(at.x, 0), z: num(at.z, 0) + 2}};   // a tip, not a door: P is hq3d's own key
  if(!THREE || !g || !g.add) return {g: null, spot: spot, tip: spot.tip};
  var s = new THREE.Group(); s.position.set(num(at.x, 0), 0, num(at.z, 0)); s.rotation.y = num(at.yaw, 0);
  var tx = tex(ctx, 512, 256, function(c){
    var gr = c.createLinearGradient ? c.createLinearGradient(0, 0, 0, 256) : null;
    if(gr){ gr.addColorStop(0, "#2b1d3a"); gr.addColorStop(1, "#0d0b12"); c.fillStyle = gr; } else c.fillStyle = "#1b1424";
    c.fillRect(0, 0, 512, 256);
    for(var i = 0; i < 9; i++){ c.fillStyle = "rgba(255,210,140," + (0.08 + (i % 3)*0.05) + ")"; c.fillRect(20 + i*56, 0, 6, 256); }
    c.fillStyle = "#f3e7cf"; c.font = "bold 34px system-ui, sans-serif"; c.textAlign = "center"; c.fillText("B1 · PHOTO", 256, 230);
  });
  var back = new THREE.Mesh(new THREE.PlaneGeometry(6, 3), tx && tx.t ? new THREE.MeshBasicMaterial({map: tx.t}) : new THREE.MeshBasicMaterial({color: 0x1b1424}));
  back.position.set(0, 1.5, 0); s.add(back);
  back.userData = {tip: spot.tip, label: spot.label};
  g.add(s);
  return {g: s, spot: spot, tip: spot.tip, hit: back};
}

/* ---------- world hooks for B ---------- */
function enter(ctx, w){ live = {ctx: ctx || null, w: w || null, valets: [], rides: []}; return live; }
function update(t, dt, k){
  if(!live) return;
  k = kOf(k); dt = Math.max(0, num(dt, 0));
  live.valets = live.valets.filter(function(v){ return !stepValet(v, dt, k); });
  live.rides = live.rides.filter(function(r){ r.update(t, dt, k); return !r.done(); });
}
function setTime(night, weather){ return lighting(live && live.w, {night: night, weather: weather}); }
function leave(){ live = null; }
function arrive(ctx, w, o){   // convenience for B: start the right ride and let update() drive it
  var r = o && o.kind === "lift" ? lobbyRide(ctx, w) : liftArrival(ctx, w, o);
  if(live) live.rides.push(r);
  return r;
}

HQV.hqBasementFx = {
  liftArrival: liftArrival, lobbyRide: lobbyRide, arrive: arrive,
  valet: valet, valetPlan: valetPlan, valetAt: valetAt,
  plinths: plinths, trophyWall: trophyWall, plaqueLayout: plaqueLayout, localBests: localBests,
  lounge: lounge, lighting: lighting, photoSpot: photoSpot, sound: sound,
  enter: enter, update: update, setTime: setTime, leave: leave,
  live: function(){ return live ? {valets: live.valets.length, rides: live.rides.length} : null; },
  _reset: function(){ live = null; }
};
})();
