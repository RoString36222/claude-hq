/* games/hqgaragemgr.js — HQ 3.4 Basement Garage: the garage manager (HQV.hqGarageMgr).
 *
 * Where each vehicle you own lives: your private basement garage (B1, under your HQ) or the common
 * multi-storey carpark. A thin client over the dashboard proxies, a pure planner, a DOM panel and a 3D kiosk.
 *
 *   homes(fresh)            -> Promise<Homes>  {available, homes:{<ownedId>:{home, bay}}, basement:{max, used}}
 *                              cached, in-flight deduped; 404/501/network -> available:false (every vehicle "carpark")
 *   homeOf(id) / bayOf(id)  -> sync, from the cache ("carpark" / null when unknown)
 *   transfer(id, home, bay) -> Promise<Homes>; optimistic (cache + emit first), rolls back and rejects {code, msg}
 *   onChange(fn)            -> unsubscribe fn; fn(Homes) after every change
 *   plan(list, homes, max, move) -> {ok, reason?, bay?, swap?}   pure; reason: full|same|unknown|starter|out
 *   open({from}) / close() / isOpen()   the panel (role=dialog, focus trap, Esc, arrows, Enter)
 *   kiosk(ctx, from)        -> {g, hits, door}  a lit pedestal with a screen; door is the "garage:open" view
 *
 * Egress: GET /api/arena/garages/mine and POST /api/arena/vehicles/<uuid>/home with {home} or {home, bay}.
 * Owned-vehicle ids and a bay number only. The panel is built with textContent; it never shows tokens, user ids
 * or raw error bodies, only the mapped messages below.
 */
(function(){
"use strict";
var root = typeof window !== "undefined" ? window : globalThis;
var HQV = root.HQV = root.HQV || {};

var OWNED_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
var HEX_RE = /^#[0-9a-fA-F]{3,8}$/;
var MAX_BAYS = 12;
var OFF = {available: false, homes: {}, basement: {max: 0, used: 0}};

var cache = null, inflight = null, subs = [];
var io = {fetch: typeof fetch === "function" ? function(u, o){ return fetch(u, o); } : null};

function copyHomes(H){
  var o = {available: !!H.available, homes: {}, basement: {max: H.basement.max | 0, used: H.basement.used | 0}};
  for(var k in H.homes) if(Object.prototype.hasOwnProperty.call(H.homes, k)) o.homes[k] = {home: H.homes[k].home, bay: H.homes[k].bay};
  return o;
}
function offline(){ return copyHomes(OFF); }
function emit(){
  var H = cache || offline();
  subs.slice().forEach(function(f){ try { f(H); } catch(e){} });
}
function csrf(){
  try {
    if(typeof CSRF === "string" && CSRF) return CSRF;
    var m = typeof document !== "undefined" && document.querySelector && document.querySelector('meta[name="hq-csrf"]');
    return m ? m.getAttribute("content") || "" : "";
  } catch(e){ return ""; }
}
function req(u, opts){
  if(!io.fetch) return Promise.reject(new Error("offline"));
  return Promise.resolve(io.fetch(u, opts)).then(function(r){
    return Promise.resolve(r.json ? r.json() : {}).catch(function(){ return {}; })
      .then(function(j){ return {status: r.status, ok: !!r.ok, body: j || {}}; });
  });
}
function cleanBay(b){ b = b == null ? null : +b; return b != null && isFinite(b) && b >= 0 && b < MAX_BAYS && b === Math.floor(b) ? b : null; }
function cleanBasement(b){
  b = b || {};
  var max = Math.max(0, Math.min(MAX_BAYS, b.max | 0));
  return {max: max, used: Math.max(0, Math.min(max, b.used | 0))};
}
function clean(body){
  var H = {available: true, homes: {}, basement: cleanBasement(body && body.basement)}, src = (body && body.homes) || {};
  Object.keys(src).forEach(function(id){
    var h = src[id];
    if(!OWNED_RE.test(id) || !h) return;
    var home = h.home === "basement" ? "basement" : "carpark";
    H.homes[id] = {home: home, bay: home === "basement" ? cleanBay(h.bay) : null};
  });
  return H;
}

function homes(fresh){
  if(cache && !fresh) return Promise.resolve(cache);
  if(inflight) return inflight;
  inflight = req("/api/arena/garages/mine", {cache: "no-store"}).then(function(r){
    inflight = null;
    cache = r.ok ? clean(r.body) : offline();         // 404 / 501: an Arena without the routes
    emit();
    return cache;
  }, function(){ inflight = null; cache = offline(); emit(); return cache; });
  return inflight;
}
function homeOf(id){ var h = cache && cache.available && cache.homes[id]; return h && h.home === "basement" ? "basement" : "carpark"; }
function bayOf(id){ var h = cache && cache.available && cache.homes[id]; return h && h.home === "basement" ? h.bay : null; }

function isStarter(id, row){
  return /^lot:/.test(String(id)) || !!(row && /^starter-/.test(String(row.vehicle_id)));
}

/* plan(list, homes, max, move): may `move` = {id, to, bay?} happen? Pure. `homes` is a Homes or its .homes map. */
function plan(list, homesIn, max, move){
  move = move || {};
  var map = homesIn && homesIn.homes && typeof homesIn.homes === "object" ? homesIn.homes : (homesIn || {});
  max = Math.max(0, Math.min(MAX_BAYS, max | 0));
  var id = move.id, to = move.to, row = null;
  (list || []).forEach(function(v){ if(v && v.id === id) row = v; });
  if(isStarter(id, row)) return {ok: false, reason: "starter"};
  if(!row || (to !== "basement" && to !== "carpark")) return {ok: false, reason: "unknown"};
  var cur = map[id] && map[id].home === "basement" ? map[id] : null;
  var want = move.bay == null ? null : +move.bay;
  if(want != null && !(want >= 0 && want < MAX_BAYS && want === Math.floor(want))) return {ok: false, reason: "unknown"};
  var out = !!row.parked;
  function res(o){ if(out && o.ok){ o.reason = "out"; o.warn = "It's out on the street. Transferring brings it home."; } return o; }
  if(to === "carpark"){
    if(!cur && !out) return {ok: false, reason: "same"};
    return res({ok: true, bay: null});
  }
  if(cur && (want == null || want === cur.bay) && !out) return {ok: false, reason: "same"};
  var taken = {}, used = 0, owners = {};
  (list || []).forEach(function(v){
    var h = v && map[v.id];
    if(h && h.home === "basement" && v.id !== id){ used++; if(h.bay != null){ taken[h.bay] = 1; owners[h.bay] = v.id; } }
  });
  if(!cur && used >= max) return {ok: false, reason: "full"};
  if(want != null){
    if(want >= max) return {ok: false, reason: "full"};
    if(taken[want]){
      if(cur && cur.bay != null) return res({ok: true, bay: want, swap: {id: owners[want], bay: cur.bay}});
      return {ok: false, reason: "full"};
    }
    return res({ok: true, bay: want});
  }
  if(cur) return res({ok: true, bay: cur.bay});
  for(var b = 0; b < max; b++) if(!taken[b]) return res({ok: true, bay: b});
  return {ok: false, reason: "full"};
}

var MSG = {
  full: "Your basement is full. Send a vehicle to the common garage first.",
  taken: "That bay was just taken. Try another one.",
  notyours: "That vehicle isn't in your garages any more.",
  unlinked: "Link your Arena account to manage your garages.",
  refused: "The Arena didn't accept that move.",
  network: "Can't reach the Arena right now.",
  unavailable: "Garage transfers need the newer Arena",
  starter: "Starters live in the basement showcase and never move.",
  same: "It's already there.",
  unknown: "That vehicle isn't one of yours.",
  error: "Something went wrong. Please try again.",
  busy: "You're driving it. Get out first, then move it."
};
var guard = null;
function setGuard(fn){ guard = typeof fn === "function" ? fn : null; }
function mapError(status, body){
  var d = String((body && (body.error || body.detail)) || "").toLowerCase();
  if(status === 409) return {code: d.indexOf("taken") >= 0 ? "taken" : "full", msg: d.indexOf("taken") >= 0 ? MSG.taken : MSG.full};
  if(status === 404) return {code: "notyours", msg: MSG.notyours};
  if(status === 403) return {code: "unlinked", msg: MSG.unlinked};
  if(status === 400 || status === 422) return {code: "refused", msg: MSG.refused};
  if(status === 501) return {code: "unavailable", msg: MSG.unavailable};
  if(!status) return {code: "network", msg: MSG.network};
  return {code: "error", msg: MSG.error};
}
function refreshGarage(){
  try { var G = HQV.hqGarage; if(G && G.mine) Promise.resolve(G.mine(true)).catch(function(){}); } catch(e){}
}
function ownedList(){ var G = HQV.hqGarage; return (G && G.cached && G.cached()) || []; }

function post(id, home, bay){
  var body = home === "basement" && bay != null ? {home: home, bay: bay} : {home: home};
  return req("/api/arena/vehicles/" + id + "/home", {method: "POST",
    headers: {"Content-Type": "application/json", "X-HQ-Token": csrf()}, body: JSON.stringify(body)});
}

function transfer(id, home, bay){
  if(!OWNED_RE.test(String(id))){
    return Promise.reject(/^lot:/.test(String(id)) ? {code: "starter", msg: MSG.starter} : {code: "unknown", msg: MSG.unknown});
  }
  if(home !== "basement" && home !== "carpark") return Promise.reject({code: "refused", msg: MSG.refused});
  // the world's say (hq3d.js, setGuard): you're driving it -> refused; out on a trip -> it is parked home first
  var held = null; try { held = guard ? guard(String(id), home) : null; } catch(e){ held = null; }
  if(held) return Promise.reject({code: "busy", msg: typeof held === "string" ? held : MSG.busy});
  var start = cache ? Promise.resolve(cache) : homes();
  return start.then(function(H){
    if(!H.available) throw {code: "unavailable", msg: MSG.unavailable};
    var list = ownedList();
    if(!list.some(function(v){ return v.id === id; })) list = list.concat([{id: id, vehicle_id: "", parked: null}]);
    var P = plan(list, H, H.basement.max, {id: id, to: home, bay: bay});
    if(!P.ok && P.reason !== "same") throw {code: P.reason, msg: MSG[P.reason] || MSG.error};
    var before = copyHomes(H);
    // optimistic: the panel and the basement move at once
    var next = copyHomes(H), prev = next.homes[id];
    next.homes[id] = {home: home, bay: home === "basement" ? (P.bay == null ? null : P.bay) : null};
    if(P.swap) next.homes[P.swap.id] = {home: "basement", bay: P.swap.bay};
    var wasB = prev && prev.home === "basement";
    if(home === "basement" && !wasB) next.basement.used = Math.min(next.basement.max, next.basement.used + 1);
    if(home === "carpark" && wasB) next.basement.used = Math.max(0, next.basement.used - 1);
    cache = next; emit();
    var chain;
    if(P.swap){            // the server holds one vehicle per bay: step the other one out, move, bring it back
      chain = post(P.swap.id, "carpark").then(function(r){ return r.ok ? post(id, home, P.bay) : r; })
        .then(function(r){ return r.ok ? post(P.swap.id, "basement", P.swap.bay).then(function(r2){ return r2.ok ? r2 : r; }) : r; });
    } else chain = post(id, home, home === "basement" ? (bay == null ? null : P.bay) : null);
    return chain.then(function(r){
      if(!r.ok){ cache = before; emit(); refreshGarage(); throw mapError(r.status, r.body); }
      var b = r.body || {};
      var after = copyHomes(cache);
      if(b.home && (b.home.home === "basement" || b.home.home === "carpark")){
        after.homes[id] = {home: b.home.home, bay: b.home.home === "basement" ? cleanBay(b.home.bay) : null};
      }
      if(b.basement) after.basement = cleanBasement(b.basement);
      cache = after; emit(); refreshGarage();
      return cache;
    }, function(){ cache = before; emit(); throw {code: "network", msg: MSG.network}; });
  });
}

/* ------------------------------------------------------------------ the panel */
var P = {root: null, from: "basement", rows: [], lastFocus: null, unsub: null, busy: {}, cat: null, toastT: null};
var STYLE_ID = "hqgm-style";
var CSS = [
  ".hqgm-scrim{position:fixed;inset:0;background:var(--scrim,rgba(0,0,0,.45));display:flex;align-items:center;justify-content:center;z-index:9000;padding:16px}",
  ".hqgm{background:var(--panel,#fff);color:var(--ink,#111);border:1px solid var(--line,#ddd);border-radius:var(--radius,12px);box-shadow:var(--shadow-lg,0 10px 40px rgba(0,0,0,.3));width:min(880px,100%);max-height:min(640px,100%);display:flex;flex-direction:column;font:14px/1.4 var(--font,sans-serif);overflow:hidden}",
  ".hqgm-head{display:flex;align-items:center;gap:12px;padding:14px 18px;border-bottom:1px solid var(--line,#ddd);background:var(--panel2,#f6f6f6)}",
  ".hqgm-head h2{margin:0;font-size:17px;flex:1}",
  ".hqgm-sub{color:var(--muted,#666);font-size:12px}",
  ".hqgm-x{background:none;border:1px solid var(--line,#ddd);color:var(--ink,#111);border-radius:var(--radius-sm,8px);padding:4px 10px;cursor:pointer}",
  ".hqgm-note{margin:10px 18px 0;padding:8px 12px;border-radius:var(--radius-sm,8px);background:var(--goldbg,#fbf1d9);color:var(--gold,#946200);font-size:13px}",
  ".hqgm-cols{display:grid;grid-template-columns:1fr 1fr;gap:14px;padding:14px 18px;overflow:auto}",
  "@media (max-width:640px){.hqgm-cols{grid-template-columns:1fr}}",
  ".hqgm-col{border:1px solid var(--line,#ddd);border-radius:var(--radius,12px);background:var(--bg2,#f2f2f2);display:flex;flex-direction:column;min-height:120px}",
  ".hqgm-col h3{margin:0;padding:10px 12px 6px;font-size:14px;display:flex;justify-content:space-between;gap:8px}",
  ".hqgm-meter{display:flex;gap:3px;padding:0 12px 8px}",
  ".hqgm-meter i{flex:1;height:6px;border-radius:3px;background:var(--line,#ddd)}",
  ".hqgm-meter i.on{background:var(--brand,#b64e2b)}.hqgm-meter i.lock{opacity:.35}",
  ".hqgm-list{list-style:none;margin:0;padding:4px 8px 10px;display:flex;flex-direction:column;gap:6px}",
  ".hqgm-row{display:grid;grid-template-columns:18px 1fr auto;gap:10px;align-items:center;padding:8px 10px;border-radius:var(--radius-sm,8px);background:var(--panel,#fff);border:1px solid var(--line,#ddd);outline:none}",
  ".hqgm-row:focus-visible,.hqgm-row:focus{border-color:var(--brand,#b64e2b);box-shadow:0 0 0 2px var(--brand2,#d97757)}",
  ".hqgm-sw{width:18px;height:18px;border-radius:50%;border:1px solid var(--line,#ddd)}",
  ".hqgm-name{font-weight:600}.hqgm-meta{color:var(--muted,#666);font-size:12px}",
  ".hqgm-st{font-size:12px;color:var(--faint,#777)}.hqgm-st.out{color:var(--warn,#a15c07)}",
  ".hqgm-btn{background:var(--brand,#b64e2b);color:var(--on-brand,#fff);border:0;border-radius:var(--radius-sm,8px);padding:6px 10px;cursor:pointer;font:inherit;font-size:12px;white-space:nowrap}",
  ".hqgm-btn[disabled]{opacity:.55;cursor:default}",
  ".hqgm-spin{display:inline-block;width:10px;height:10px;margin-right:6px;border:2px solid currentColor;border-right-color:transparent;border-radius:50%;animation:hqgm-r .8s linear infinite;vertical-align:-1px}",
  "@keyframes hqgm-r{to{transform:rotate(360deg)}}",
  "@media (prefers-reduced-motion:reduce){.hqgm-spin{animation:none;border-right-color:currentColor;opacity:.6}}",
  ".hqgm-empty{color:var(--faint,#777);font-size:12px;padding:8px 10px}",
  ".hqgm-toast{margin:0 18px 14px;padding:8px 12px;border-radius:var(--radius-sm,8px);display:flex;gap:10px;align-items:center;background:var(--goodbg,#e5f3ec);color:var(--good,#18794e)}",
  ".hqgm-toast.err{background:var(--needbg,#fcebe9);color:var(--need,#c9372c)}",
  ".hqgm-toast[hidden]{display:none}",
  ".hqgm-toast button{margin-left:auto}"
].join("\n");

function D(){ return typeof document !== "undefined" ? document : null; }
function E(tag, cls, text){
  var e = D().createElement(tag);
  if(cls) e.className = cls;
  if(text != null) e.textContent = String(text);
  return e;
}
function ensureStyle(){
  var d = D();
  if(!d || (d.getElementById && d.getElementById(STYLE_ID))) return;
  var s = E("style"); s.id = STYLE_ID; s.textContent = CSS;
  (d.head || d.body).appendChild(s);
}
function catalogue(){
  if(P.cat) return Promise.resolve(P.cat);
  var V = HQV.hqVehicles;
  if(!V || !V.load) return Promise.resolve(null);
  return Promise.resolve(V.load()).then(function(c){ P.cat = c; return c; }, function(){ return null; });
}
function entryOf(vid){
  var V = HQV.hqVehicles;
  return (V && V.get && P.cat && V.get(P.cat, vid)) || null;
}
function describe(v){
  var e = entryOf(v.vehicle_id), name = e ? ((e.brand && e.brand !== "Claude HQ" ? e.brand + " " : "") + e.model) : String(v.vehicle_id || "Vehicle");
  var cls = "";
  if(e && P.cat && P.cat.classes) P.cat.classes.forEach(function(c){ if(c.id === e["class"]) cls = c.label || ""; });
  var s = e && e.spec, bits = [];
  if(s){
    if(s.electric) bits.push("EV"); else if(s.cc) bits.push(s.cc + " cc");
    if(s.powerKw) bits.push(Math.round(s.powerKw * 1.341) + " hp");
    if(s.topKmh) bits.push(s.topKmh + " km/h");
  }
  var hex = e && e.paints && e.paints[v.paint | 0] && e.paints[v.paint | 0].hex;
  return {name: name, cls: cls, spec: bits.join(" · "), hex: HEX_RE.test(String(hex)) ? hex : "#888888",
          paintName: e && e.paints && e.paints[v.paint | 0] ? e.paints[v.paint | 0].name : ""};
}
function placeOf(p){
  var w = String(p.world || ""), at = w.indexOf("@") > 0 ? w.slice(0, w.indexOf("@")) : w;
  var nm = /^[a-z0-9-]{1,40}$/i.test(at) ? at.replace(/-/g, " ") : "the city";
  return nm + " (" + Math.round(p.x) + ", " + Math.round(p.z) + ")";
}

var STARTERS = [{vid: "starter-car", label: "City hatchback"}, {vid: "starter-moto", label: "Street bike"}, {vid: "", label: "Bicycle"}];

function rowEl(v, col, H){
  var li = E("li", "hqgm-row"), d, st;
  li.setAttribute("tabindex", "-1");
  li.setAttribute("role", "group");
  if(v.starter){
    d = {name: v.label, cls: "Starter", spec: "", hex: "#3d6fd1"};
    var e = v.vid && entryOf(v.vid);
    if(e) d.name = e.model;
    st = "Starter (showcase)";
  } else {
    d = describe(v);
    var b = H.homes[v.id] && H.homes[v.id].home === "basement" ? H.homes[v.id].bay : null;
    st = v.parked ? "Out — near " + placeOf(v.parked) : col === "basement" ? (b == null ? "In the basement" : "In bay " + (b + 1)) : "In the common garage";
  }
  var sw = E("span", "hqgm-sw"); sw.style.background = d.hex; sw.setAttribute("aria-hidden", "true");
  var mid = E("div");
  mid.appendChild(E("div", "hqgm-name", d.name));
  var meta = [d.cls, d.spec, d.paintName].filter(Boolean).join(" · ");
  if(meta) mid.appendChild(E("div", "hqgm-meta", meta));
  mid.appendChild(E("div", "hqgm-st" + (v.parked ? " out" : ""), st));
  li.appendChild(sw); li.appendChild(mid);
  li.setAttribute("aria-label", d.name + ", " + st);
  if(!v.starter && H.available){
    var to = col === "basement" ? "carpark" : "basement";
    var btn = E("button", "hqgm-btn", to === "carpark" ? "Send to common garage" : "Bring to basement");
    btn.setAttribute("type", "button");
    var pl = plan(ownedList(), H, H.basement.max, {id: v.id, to: to});
    if(P.busy[v.id]){
      btn.disabled = true; btn.setAttribute("aria-busy", "true"); btn.textContent = "";
      btn.appendChild(E("span", "hqgm-spin")); btn.appendChild(D().createTextNode ? D().createTextNode("Moving…") : E("span", null, "Moving…"));
    } else if(!pl.ok){
      btn.disabled = true;
      if(pl.reason === "full") btn.setAttribute("title", MSG.full);
    } else if(pl.reason === "out") btn.setAttribute("title", pl.warn);
    btn.addEventListener("click", function(){ act(v.id, to); });
    li._act = function(){ if(!btn.disabled) act(v.id, to); };
    li.appendChild(btn);
  }
  return li;
}

function toast(text, err, retry){
  var t = P.toast; if(!t) return;
  while(t.firstChild) t.removeChild(t.firstChild);
  t.className = "hqgm-toast" + (err ? " err" : "");
  t.appendChild(E("span", null, text));
  if(retry){
    var b = E("button", "hqgm-btn", "Retry"); b.setAttribute("type", "button");
    b.addEventListener("click", retry); t.appendChild(b);
  }
  t.hidden = false;
  if(P.toastT) clearTimeout(P.toastT);
  if(!retry) P.toastT = setTimeout(function(){ if(P.toast) P.toast.hidden = true; }, 4200);
}

function act(id, to){
  if(P.busy[id]) return;
  P.busy[id] = 1; render();
  transfer(id, to).then(function(){
    delete P.busy[id];
    var d = describe((ownedList().filter(function(v){ return v.id === id; })[0]) || {vehicle_id: ""});
    toast(to === "basement" ? d.name + " is on its way down to B1." : d.name + " is heading to the common garage.");
    try { if(HQV.hqBasementFx && HQV.hqBasementFx.valet) HQV.hqBasementFx.valet(id, to); } catch(e){}
    render();
  }, function(err){
    delete P.busy[id];
    var msg = err && typeof err.msg === "string" && MSG[err.code] === err.msg ? err.msg : MSG.error;
    toast(msg, true, function(){ if(P.toast) P.toast.hidden = true; act(id, to); });
    render();
  });
}

function render(){
  if(!P.root) return;
  var H = cache || offline(), list = ownedList(), body = P.cols;
  var focusedId = P.focusId;
  while(body.firstChild) body.removeChild(body.firstChild);
  P.rows = [];
  P.note.hidden = !!H.available;
  ["basement", "carpark"].forEach(function(col){
    var c = E("section", "hqgm-col"); c.setAttribute("aria-label", col === "basement" ? "Basement garage" : "Common multi-storey garage");
    var h = E("h3");
    h.appendChild(E("span", null, col === "basement" ? "Basement (B1) " + H.basement.used + "/" + H.basement.max : "Common multi-storey"));
    h.appendChild(E("span", "hqgm-sub", col === "basement" ? (P.from === "basement" ? "You are here" : "Under your HQ") : (P.from === "carpark" ? "You are here" : "Downtown")));
    c.appendChild(h);
    if(col === "basement"){
      var m = E("div", "hqgm-meter"); m.setAttribute("aria-hidden", "true");
      for(var i = 0; i < MAX_BAYS; i++) m.appendChild(E("i", i < H.basement.used ? "on" : i >= H.basement.max ? "lock" : ""));
      c.appendChild(m);
      if(H.available && H.basement.max < MAX_BAYS) c.appendChild(E("div", "hqgm-sub", "  More bays unlock as your HQ levels up (up to " + MAX_BAYS + ")."));
    }
    var ul = E("ul", "hqgm-list"), n = 0;
    if(col === "basement") STARTERS.forEach(function(s){ var li = rowEl({starter: true, vid: s.vid, label: s.label}, col, H); ul.appendChild(li); P.rows.push(li); });
    list.forEach(function(v){
      var home = H.available && H.homes[v.id] && H.homes[v.id].home === "basement" ? "basement" : "carpark";
      if(home !== col) return;
      var li = rowEl(v, col, H); li._id = v.id; ul.appendChild(li); P.rows.push(li); n++;
      if(focusedId && v.id === focusedId) P.refocus = li;
    });
    if(!n && col === "carpark") ul.appendChild(E("li", "hqgm-empty", list.length ? "Nothing parked here." : "No vehicles yet. Visit a dealership."));
    c.appendChild(ul);
    body.appendChild(c);
  });
  if(P.refocus){ try { P.refocus.focus(); } catch(e){} P.refocus = null; }
}

function focusables(){
  var out = [];
  (function walk(n){
    if(!n || !n.children) return;
    for(var i = 0; i < n.children.length; i++){
      var c = n.children[i];
      if(c.hidden) continue;
      if((c.tagName === "BUTTON" && !c.disabled) || (c.getAttribute && c.getAttribute("tabindex") === "-1" && c.className === "hqgm-row")) out.push(c);
      walk(c);
    }
  })(P.dlg);
  return out;
}
function onKey(ev){
  var k = ev.key, d = D(), a = d && d.activeElement;
  if(k === "Escape"){ ev.preventDefault && ev.preventDefault(); close(); return; }
  if(k === "ArrowDown" || k === "ArrowUp"){
    var rows = P.rows, i = rows.indexOf(a);
    if(i < 0) for(var j = 0; j < rows.length; j++) if(rows[j].contains && rows[j].contains(a)) i = j;
    var n = rows.length ? rows[(i + (k === "ArrowDown" ? 1 : -1) + rows.length) % rows.length] : null;
    if(n){ ev.preventDefault && ev.preventDefault(); P.focusId = n._id || null; n.focus(); }
    return;
  }
  if(k === "Enter" && a && a._act){ ev.preventDefault && ev.preventDefault(); P.focusId = a._id || null; a._act(); return; }
  if(k === "Tab"){
    var f = focusables(); if(!f.length) return;
    var idx = f.indexOf(a), nx = ev.shiftKey ? (idx <= 0 ? f.length - 1 : idx - 1) : (idx < 0 || idx >= f.length - 1 ? 0 : idx + 1);
    ev.preventDefault && ev.preventDefault(); f[nx].focus();
  }
  if(ev.stopPropagation) ev.stopPropagation();      // the 3D view's keys don't fire under the dialog
}

function open(o){
  o = o || {};
  if(!D()) return false;
  P.from = o.from === "carpark" ? "carpark" : "basement";
  if(P.root){ render(); return true; }
  ensureStyle();
  P.lastFocus = D().activeElement || null;
  var scrim = E("div", "hqgm-scrim");
  var dlg = E("div", "hqgm");
  dlg.setAttribute("role", "dialog"); dlg.setAttribute("aria-modal", "true"); dlg.setAttribute("aria-labelledby", "hqgm-title");
  var head = E("div", "hqgm-head");
  var ttl = E("h2", null, "Garage manager"); ttl.id = "hqgm-title";
  head.appendChild(ttl);
  head.appendChild(E("span", "hqgm-sub", "Move vehicles between your basement and the common garage"));
  var x = E("button", "hqgm-x", "Close"); x.setAttribute("type", "button"); x.setAttribute("aria-label", "Close garage manager");
  x.addEventListener("click", close); head.appendChild(x);
  dlg.appendChild(head);
  P.note = E("div", "hqgm-note", MSG.unavailable); P.note.setAttribute("role", "note"); P.note.hidden = true;
  dlg.appendChild(P.note);
  P.cols = E("div", "hqgm-cols"); dlg.appendChild(P.cols);
  P.toast = E("div", "hqgm-toast"); P.toast.setAttribute("role", "status"); P.toast.setAttribute("aria-live", "polite"); P.toast.hidden = true;
  dlg.appendChild(P.toast);
  scrim.appendChild(dlg);
  scrim.addEventListener("keydown", onKey);
  scrim.addEventListener("click", function(ev){ if(ev.target === scrim) close(); });
  P.root = scrim; P.dlg = dlg; P.close = x;
  (D().body || D().documentElement).appendChild(scrim);
  P.unsub = onChange(function(){ render(); });
  var G = HQV.hqGarage, unG = G && G.onChange ? G.onChange(function(){ render(); }) : null;
  P.unsubG = unG;
  render();
  try { x.focus(); } catch(e){}
  Promise.all([homes(), G && G.mine ? Promise.resolve(G.mine()).catch(function(){ return []; }) : [], catalogue()])
    .then(function(){ render(); var r = P.rows[0]; if(r && P.root) try { r.focus(); } catch(e){} });
  return true;
}
function close(){
  if(!P.root) return;
  if(P.unsub) P.unsub(); if(P.unsubG) P.unsubG();
  P.unsub = P.unsubG = null;
  if(P.toastT) clearTimeout(P.toastT);
  if(P.root.parentNode) P.root.parentNode.removeChild(P.root);
  P.root = P.dlg = P.cols = P.note = P.toast = null; P.rows = []; P.busy = {};
  var f = P.lastFocus; P.lastFocus = null;
  if(f && f.focus) try { f.focus(); } catch(e){}
}
function isOpen(){ return !!P.root; }

function onChange(f){
  if(typeof f !== "function") return function(){};
  subs.push(f);
  return function(){ subs = subs.filter(function(g){ return g !== f; }); };
}

/* ------------------------------------------------------------------ the 3D kiosk */
function kiosk(ctx, from){
  from = from === "carpark" ? "carpark" : "basement";
  var door = {view: "garage:open", from: from, label: "Garage manager", tip: "Garage manager",
              front: {x: 0, z: 1.1}};
  if(!ctx || !ctx.THREE) return {g: null, hits: [], door: door};
  var T = ctx.THREE, g = new T.Group(); g.name = "garage-kiosk";
  var accent = from === "basement" ? 0xe9c46a : 0x5fd3e6;
  var base = ctx.cyl ? ctx.cyl(0.42, 0.5, 0.9, ctx.mat(0x23262d, {roughness: 0.35, metalness: 0.6}), 0, 0.45, 0, g, 24) : null;
  var ring = ctx.cyl ? ctx.cyl(0.52, 0.52, 0.05, ctx.emis ? ctx.emis(accent, accent, 1.6) : ctx.mat(accent), 0, 0.03, 0, g, 24) : null;
  var stem = ctx.box ? ctx.box(0.12, 0.7, 0.12, ctx.mat(0x2f333b, {metalness: 0.7, roughness: 0.3}), 0, 1.25, 0, g) : null;
  var tex = ctx.canvasTex ? ctx.canvasTex(256, 192, function(c, w, h){
    var gr = c.createLinearGradient(0, 0, 0, h); gr.addColorStop(0, "#10141c"); gr.addColorStop(1, "#1c2433");
    c.fillStyle = gr; c.fillRect(0, 0, w, h);
    c.strokeStyle = from === "basement" ? "#e9c46a" : "#5fd3e6"; c.lineWidth = 6; c.strokeRect(6, 6, w - 12, h - 12);
    c.fillStyle = "#ffffff"; c.textAlign = "center"; c.font = "bold 30px sans-serif"; c.fillText("GARAGE", w/2, 58);
    c.font = "20px sans-serif"; c.fillStyle = "#c9d3e3"; c.fillText(from === "basement" ? "B1 ⇄ Common" : "Common ⇄ B1", w/2, 92);
    for(var i = 0; i < 6; i++){                                        // a little bay meter, fixed pattern
      c.fillStyle = i < 4 ? (from === "basement" ? "#e9c46a" : "#5fd3e6") : "#39414f";
      c.fillRect(38 + i*31, 118, 24, 12);
    }
    c.font = "16px sans-serif"; c.fillStyle = "#8fa0b8"; c.fillText("Press E · manage vehicles", w/2, 166);
  }) : null;
  var scr = null;
  if(tex && ctx.screen){
    scr = ctx.screen(0.9, 0.675, tex.t || tex);
    scr.position.set(0, 1.85, 0.02); scr.rotation.x = -0.22; g.add(scr);
    var bezel = ctx.box ? ctx.box(0.98, 0.75, 0.05, ctx.mat(0x15171c, {metalness: 0.5, roughness: 0.4}), 0, 1.85, -0.02, g) : null;
    if(bezel) bezel.rotation.x = -0.22;
  }
  if(ctx.glow){ var gl = ctx.glow(accent, 1.6, 0.35); gl.position.set(0, 0.08, 0); g.add(gl); }
  var hits = [base, stem, scr].filter(Boolean);
  hits.forEach(function(m){ m.userData = m.userData || {}; m.userData.door = door; m.userData.tip = "Garage manager"; });
  g.userData = g.userData || {}; g.userData.door = door; g.userData.tip = "Garage manager";
  void ring;
  return {g: g, hits: hits, door: door};
}

HQV.hqGarageMgr = {
  homes: homes, homeOf: homeOf, bayOf: bayOf, transfer: transfer, onChange: onChange, plan: plan,
  open: open, close: close, isOpen: isOpen, kiosk: kiosk, MESSAGES: MSG, setGuard: setGuard,
  _io: io,
  _reset: function(){ guard = null; cache = null; inflight = null; subs = []; if(P.root) close(); P.cat = null; }
};
})();
