/* Claude HQ 3.13: the Tuning shop (HQV.hqTuning) -- Redline Tuning.
 *
 * Tune the vehicles you own (the Arena's owned catalogue vehicles) and your starter car and motorbike: paint (the
 * catalogue's paints or any colour, a finish: gloss / matte / metallic / pearl / chrome, a second tone on the roof, as
 * stripes or as a livery), wheels (six rim designs per car or bike, the rim colour, a size step: the alloy grows inside
 * the tyre, the tyre's outside never changes), window tint (four levels), a wing (cars: a lip, a ducktail, a GT wing),
 * the exhaust (cars: sport / quad / titanium, bikes: slip-on / under-seat / end can; it changes the engine note too,
 * games/engine.js EXHAUST) and a number plate of your own (up to 8 of A-Z, 0-9, space and dash; the HQ's name stays
 * the default). Everything is free.
 *
 * Where: a garage-style workshop in every City from tier 2, on the building lot nearest the dealership (place(), the
 * same lot on every client; Go to lists it as "Tuning shop"), E at its open bay; and the "Tune" button on a B1 row of
 * the garage manager (games/hqgaragemgr.js). The panel previews every change live on the vehicle on a turntable under a
 * two-post lift, with an orbit camera (drag, wheel or the arrow keys, + and -).
 *
 *   OPTIONS, BANNED                   the choices (labels) and the plate filter (the Arena's own list: backend/src/tuning.rs)
 *   defaults() / normalize(t, kind) / isStock(t, kind)   the Arena's canonical tune ({finish, color, two_tone, color2,
 *                                     rim, rim_color, rim_size, tint, wing, exhaust, plate}; colours "#rrggbb" or null)
 *   plateCheck(text) -> {ok, text, why}   upper-cased, spaces tidied; A-Z 0-9 space dash, at most 8, nothing BANNED
 *   encode(t, kind) -> code / decode(code, kind) -> t | null   presence's `vt` (backend/src/tuning.rs code / parse_code)
 *   of(key) -> t | null               "own:<id>" (from HQV.hqGarage's list) or "starter:car" / "starter:moto" (localStorage)
 *   save(key, t, paint) -> Promise<{ok, text}>   the Arena (POST /api/arena/vehicles/<id>/tuning) or localStorage
 *   onChange(fn) -> unsubscribe       fn(key) after a save
 *   exhaustOf(t) -> the engine's exhaust id or null
 *   openFor(key) / host               the page's opener (games/hq3d.js sets host); the garage manager's Tune button
 *   place(W, tier) / pick(W)          the shop's site on a building lot ("tuning:0", from tier 2; pure, idempotent)
 *   build(c, site, opts) -> B         the workshop, the civic-building shape games/hqcity3d.js keeps
 *   mountPanel(stage, opts) -> ui     the panel: opts = {three, ctx, vehicles() -> [item], save(item, t, paint) ->
 *                                     Promise<{ok, text}>, plate() -> the default plate text, announce, onClose}
 *                                     item = {key, title, kind: "car" | "bike", entry, paints, paint, tune, ev}
 *   owns(e)                           a key event inside the panel (the page's capture-phase handler skips it)
 *
 * Egress: only through games/hqgarage.js's proxy (owned-vehicle ids, the tune's enum words, colours, small numbers and
 * the plate text the user typed) and presence's `vt` (the same, as a short code). textContent only.
 */
(function(){
"use strict";
var G = typeof window !== "undefined" ? window : globalThis;
var HQV = G.HQV = G.HQV || {};

var PI = Math.PI, Q16 = 65536;
var SITE_ID = "tuning:0", MIN_TIER = 2, NAME = "Redline Tuning", PLACE_NAME = "Tuning shop";
var MIN_W = 18, MIN_D = 16;                     // m: the workshop and its apron
var LS_KEY = "hq3d.tune.starters.v1";
var OWNED_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
var HEX_RE = /^#[0-9a-fA-F]{6}$/;

/* ---------- the choices ---------- */
var OPTIONS = {
  finish: [["gloss", "Gloss"], ["matte", "Matte"], ["metallic", "Metallic"], ["pearl", "Pearl"], ["chrome", "Chrome"]],
  two_tone: {car: [["none", "One tone"], ["roof", "Roof"], ["stripe", "Stripes"], ["livery", "Livery"]],
             bike: [["none", "One tone"], ["stripe", "Tank stripe"], ["livery", "Livery"]]},
  rim: {car: ["Stock", "Five-spoke", "Mesh", "Multi-spoke", "Aero disc", "Deep dish"],
        bike: ["Stock", "Five-spoke", "Y-spoke", "Wire", "Solid disc", "Ten-spoke"]},
  rim_size: [[-1, "Smaller"], [0, "Stock"], [1, "+1 size"], [2, "+2 sizes"]],
  tint: ["None", "Light", "Dark", "Limo"],
  wing: [["none", "None"], ["lip", "Lip"], ["ducktail", "Ducktail"], ["gt", "GT wing"]],
  exhaust: {car: [["stock", "Stock"], ["sport", "Sport"], ["quad", "Quad tips"], ["titanium", "Titanium"]],
            bike: [["stock", "Stock"], ["slipon", "Slip-on"], ["underseat", "Under-seat"], ["endcan", "End can"]]},
  rimColors: [["#c9ced4", "Silver"], ["#15171a", "Gloss black"], ["#4a4f57", "Gunmetal"], ["#c9a227", "Gold"], ["#dfe4ea", "Chrome"], ["#b3131f", "Red"], ["#1c69d4", "Blue"], ["#f2f2f2", "White"]]
};
var FINISHES = OPTIONS.finish.map(function(o){ return o[0]; });
var TWO_TONES = ["none", "roof", "stripe", "livery"], WINGS = ["none", "lip", "ducktail", "gt"];
var EXHAUSTS = {car: ["stock", "sport", "quad", "titanium"], bike: ["stock", "slipon", "underseat", "endcan"]};
// Words a plate may not spell (after 0->O, 1->I, 3->E, 4->A, 5->S, 7->T, 8->B, without spaces or dashes): a light filter,
// the Arena's list (backend/src/tuning.rs BANNED; tests/test_hqtuning.py keeps them the same)
var BANNED = ["FUCK", "FUK", "FCUK", "SHIT", "CUNT", "DICK", "COCK", "PUSSY", "BITCH", "NIGG", "NIGA", "FAG", "SLUT", "WHORE",
              "NAZI", "TWAT", "WANK", "PENIS", "ASSHOLE", "TITS", "PORN", "SEX", "HITLER", "KKK", "DILDO", "JIZZ", "PRICK", "BASTARD"];

function kindOf(k){ return k === "bike" || k === "moto" ? "bike" : "car"; }
function defaults(){ return {finish: "gloss", color: null, two_tone: "none", color2: null, rim: 0, rim_color: null, rim_size: 0, tint: 0, wing: "none", exhaust: "stock", plate: ""}; }
function hex(v){ return typeof v === "string" && HEX_RE.test(v) ? v.toLowerCase() : null; }
function intIn(v, lo, hi, fb){ v = +v; return isFinite(v) && v === Math.floor(v) && v >= lo && v <= hi ? v : fb; }
function plateCheck(s){
  var t = String(s == null ? "" : s).toUpperCase().replace(/\s+/g, " ").trim();
  if(t.length > 8) return {ok: false, text: t, why: "At most 8 characters."};
  if(!/^[A-Z0-9 -]*$/.test(t)) return {ok: false, text: t, why: "Only letters, numbers, spaces and dashes."};
  var sq = t.replace(/[ -]/g, "").replace(/[0134578]/g, function(c){ return {"0": "O", "1": "I", "3": "E", "4": "A", "5": "S", "7": "T", "8": "B"}[c]; });
  for(var i = 0; i < BANNED.length; i++) if(sq.indexOf(BANNED[i]) >= 0) return {ok: false, text: t, why: "Pick other letters for the plate."};
  return {ok: true, text: t, why: ""};
}
// the Arena's canonical tune for a vehicle of `kind`: anything off its list or out of range falls back to stock
function normalize(t, kind){
  t = t && typeof t === "object" ? t : {}; kind = kindOf(kind);
  var o = defaults();
  if(FINISHES.indexOf(t.finish) >= 0) o.finish = t.finish;
  o.color = hex(t.color);
  if(TWO_TONES.indexOf(t.two_tone) >= 0 && !(kind === "bike" && t.two_tone === "roof")) o.two_tone = t.two_tone;
  o.color2 = hex(t.color2);
  if(o.two_tone !== "none" && !o.color2) o.two_tone = "none";
  o.rim = intIn(t.rim, 0, 5, 0); o.rim_color = hex(t.rim_color); o.rim_size = intIn(t.rim_size, -1, 2, 0); o.tint = intIn(t.tint, 0, 3, 0);
  if(kind === "car" && WINGS.indexOf(t.wing) >= 0) o.wing = t.wing;
  if(EXHAUSTS[kind].indexOf(t.exhaust) >= 0) o.exhaust = t.exhaust;
  var p = plateCheck(t.plate); o.plate = p.ok ? p.text : "";
  return o;
}
function isStock(t, kind){ return encode(t, kind) === "0001000---"; }
function encode(t, kind){
  kind = kindOf(kind); t = normalize(t, kind);
  var s = "" + FINISHES.indexOf(t.finish) + TWO_TONES.indexOf(t.two_tone) + t.rim + (t.rim_size + 1) + t.tint + WINGS.indexOf(t.wing) + EXHAUSTS[kind].indexOf(t.exhaust);
  [t.color, t.color2, t.rim_color].forEach(function(c){ s += c ? c.slice(1) : "-"; });
  return s + t.plate.replace(/ /g, "_");
}
function decode(code, kind){
  kind = kindOf(kind);
  if(typeof code !== "string" || code.length < 10 || code.length > 33 || !/^[0-9]{7}/.test(code)) return null;
  var d = function(i){ return code.charCodeAt(i) - 48; };
  if(d(0) > 4 || d(1) > 3 || d(2) > 5 || d(3) > 3 || d(4) > 3 || d(5) > 3 || d(6) > 3) return null;
  var t = {finish: FINISHES[d(0)], two_tone: TWO_TONES[d(1)], rim: d(2), rim_size: d(3) - 1, tint: d(4), wing: WINGS[d(5)], exhaust: EXHAUSTS[kind][d(6)]};
  var i = 7, cols = [];
  for(var k = 0; k < 3; k++){
    if(code.charAt(i) === "-"){ cols.push(null); i++; continue; }
    var h = code.slice(i, i + 6); if(!/^[0-9a-f]{6}$/.test(h)) return null;
    cols.push("#" + h); i += 6;
  }
  t.color = cols[0]; t.color2 = cols[1]; t.rim_color = cols[2];
  var pl = code.slice(i); if(!/^[A-Z0-9_-]{0,8}$/.test(pl)) return null;
  var pc = plateCheck(pl.replace(/_/g, " ")); if(!pc.ok || pc.text !== pl.replace(/_/g, " ")) return null;
  t.plate = pc.text;
  if(t.two_tone !== "none" && !t.color2) return null;
  return normalize(t, kind);
}
var EXH_ENGINE = {sport: 1, quad: 1, titanium: 1, slipon: 1, underseat: 1, endcan: 1};
function exhaustOf(t){ return t && EXH_ENGINE[t.exhaust] ? t.exhaust : null; }

/* ---------- the store: owned vehicles in the Arena (HQV.hqGarage's list), starters in localStorage ---------- */
var subs = [];
var io = {fetch: typeof fetch === "function" ? function(u, o){ return fetch(u, o); } : null};
function emit(key){ subs.slice().forEach(function(f){ try { f(key); } catch(e){} }); }
function lsGet(){ try { var j = JSON.parse(G.localStorage.getItem(LS_KEY) || "null"); return j && typeof j === "object" ? j : {}; } catch(e){ return {}; } }
function lsSet(o){ try { G.localStorage.setItem(LS_KEY, JSON.stringify(o)); } catch(e){} }
function ownRow(id){ var L = HQV.hqGarage && HQV.hqGarage.cached ? HQV.hqGarage.cached() : null, hit = null; (L || []).forEach(function(v){ if(v && v.id === id) hit = v; }); return hit; }
var CATR = null;                                  // the catalogue, once the page has it (setCatalogue)
function ownKind(row){
  var V = HQV.hqVehicles, e = CATR && V && V.get ? V.get(CATR, row.vehicle_id) : null;
  if(e) return /^bike\./.test(String(e["class"] || "")) ? "bike" : "car";
  return row.tuning && EXHAUSTS.bike.indexOf(row.tuning.exhaust) > 0 ? "bike" : "car";   // a bike's exhausts have their own names
}
function of(key){
  key = String(key || "");
  if(key === "starter:car" || key === "starter:moto"){ var s = lsGet()[key.slice(8)]; return s ? normalize(s, key === "starter:moto" ? "bike" : "car") : null; }
  if(key.indexOf("own:") === 0){ var r = ownRow(key.slice(4)); return r && r.tuning ? normalize(r.tuning, ownKind(r)) : null; }
  return null;
}
function csrf(){
  try {
    if(typeof CSRF === "string" && CSRF) return CSRF;
    var m = typeof document !== "undefined" && document.querySelector && document.querySelector('meta[name="hq-csrf"]');
    return m ? m.getAttribute("content") || "" : "";
  } catch(e){ return ""; }
}
var MSG = {404: "That vehicle isn't in your garage any more.", 422: "The shop couldn't fit that: check the plate and the colours.", 403: "Link this device to your Arena account first."};
function save(key, t, paint, kind){
  key = String(key || "");
  if(key === "starter:car" || key === "starter:moto"){
    var all = lsGet(), nm = key.slice(8), n = normalize(t, nm === "moto" ? "bike" : "car");
    if(isStock(n, nm === "moto" ? "bike" : "car")) delete all[nm]; else all[nm] = n;
    lsSet(all); emit(key);
    return Promise.resolve({ok: true, text: "Done: your " + (nm === "moto" ? "motorbike" : "car") + " is tuned."});
  }
  var id = key.slice(4);
  if(key.indexOf("own:") !== 0 || !OWNED_RE.test(id)) return Promise.resolve({ok: false, text: "That vehicle can't be tuned here."});
  if(!io.fetch) return Promise.resolve({ok: false, text: "The shop is offline."});
  var row = ownRow(id), k = kind || (row ? ownKind(row) : "car"), body = {tuning: normalize(t, k)};
  if(paint != null) body.paint = Math.max(0, Math.min(63, paint | 0));
  return Promise.resolve(io.fetch("/api/arena/vehicles/" + id + "/tuning", {method: "POST", headers: {"Content-Type": "application/json", "X-HQ-Token": csrf()}, body: JSON.stringify(body)}))
    .then(function(r){ return Promise.resolve(r.json ? r.json() : {}).catch(function(){ return {}; }).then(function(j){ return {status: r.status, ok: !!r.ok, body: j || {}}; }); })
    .then(function(r){
      if(!r.ok) return {ok: false, text: MSG[r.status] || (r.status === 404 || r.status === 501 ? MSG[404] : "The shop couldn't save that right now.")};
      var tn = r.body.tuning && typeof r.body.tuning === "object" ? r.body.tuning : body.tuning;
      if(HQV.hqGarage && HQV.hqGarage.setTuning) HQV.hqGarage.setTuning(id, isStock(tn, k) ? null : tn, r.body.paint != null ? r.body.paint : body.paint);
      emit(key);
      return {ok: true, text: "Done: saved to your garage."};
    }, function(){ return {ok: false, text: "The shop couldn't reach the Arena."}; });
}

/* ---------- where it stands (pure) ---------- */
function frame(o){ return HQV.hqDealer && HQV.hqDealer.frame ? HQV.hqDealer.frame(o) : null; }
function siteOf(W, id){ var S = W.sites || []; for(var i = 0; i < S.length; i++) if(S[i] && S[i].id === id) return S[i]; return null; }
function find(W){ var S = (W && W.sites) || []; for(var i = 0; i < S.length; i++) if(S[i] && S[i].kind === "tuning") return S[i]; return null; }
// the building lot nearest the dealership (else nearest a spot a short walk from the plaza), big enough for the workshop
function pick(W){
  if(!W || !W.lots) return null;
  var d = null, S = W.sites || [];
  for(var i = 0; i < S.length; i++) if(S[i] && S[i].kind === "dealer") d = S[i];
  var pl = siteOf(W, "fountain:0") || siteOf(W, "spawn:0"), ax = d ? d.x/100 : (pl ? pl.x/100 : 0) + 200, az = d ? d.z/100 : (pl ? pl.z/100 : 0), best = null;
  W.lots.forEach(function(l){
    if(!l || l.kind !== "building") return;
    if(l.min_tier != null && (l.min_tier | 0) > MIN_TIER) return;
    var F = frame(l); if(!F || F.w < MIN_W || F.d < MIN_D) return;
    var dist = Math.hypot(F.cx - ax, F.cz - az) - Math.min(F.w, 40)*0.3;     // a roomier lot a little further is fine
    if(!best || dist < best.dist || (dist === best.dist && (l.id | 0) < (best.lot.id | 0))) best = {lot: l, F: F, dist: dist};
  });
  return best;
}
function place(W, tier){
  if(!W || !W.sites || !W.lots) return null;
  var have = find(W); if(have) return have;
  if((tier | 0) < MIN_TIER) return null;
  var c = pick(W); if(!c) return null;
  var l = c.lot, F = c.F, y = l.door && l.door.length >= 3 ? l.door[1] | 0 : (l.y | 0);
  // worldbuild draws no building here now; the site does (`was` and `claimed` keep it out of the world cache)
  l.was = l.kind; l.kind = "tuning";
  var s = {id: SITE_ID, kind: "tuning", tier: MIN_TIER, lot: l.id, block: l.block, district: l.district,
           x: Math.round(F.cx*100), y: y, z: Math.round(F.cz*100), w: Math.round(F.w*100), d: Math.round(F.d*100),
           front: [Math.round(F.f[0]*Q16), Math.round(F.f[1]*Q16)], facing: l.facing || "north", name: PLACE_NAME, claimed: 1};
  W.sites.push(s);
  W.index = null;
  return s;
}

/* ---------- the workshop on the street ---------- */
function signTex(c, w, h, draw){ try { var t = c.canvasTex(w, h, function(g){ draw(g, w, h); }).t; if(c.THREE.SRGBColorSpace) t.colorSpace = c.THREE.SRGBColorSpace; return t; } catch(e){ return null; } }
function build(c, site, opts){
  opts = opts || {};
  var T = c.THREE, F = frame(site), y0 = (+site.y || 0)/100, PL = 0.2;
  var g = new T.Group(); g.name = "tuning"; g.position.set(F.cx, y0, F.cz); g.rotation.y = F.rot;
  var stat = new T.Group(); stat.name = "tuning-static"; g.add(stat);
  var Wd = Math.max(16, Math.min(F.w - 2, 26)), Dd = Math.max(14, Math.min(F.d - 2, 22)), H = 7, apron = 6;
  var hz0 = -Dd/2, hz1 = Dd/2 - apron, hw = Wd/2;
  var cr = Math.cos(F.rot), sr = Math.sin(F.rot);
  function world(x, z){ return {x: F.cx + x*cr + z*sr, z: F.cz - x*sr + z*cr}; }
  function box(w, h, d, m, x, y, z, p){ return c.box(w, h, d, m, x, y, z, p || stat); }
  var mat = function(col, o){ return c.mat(col, o); };
  var B = {g: g, doors: [], hits: [], glows: [], boxes: [], lod: [], decks: [], top: H + 2, tint: 0x3a3d44, kind: "tuning",
           x: F.cx, y: y0, z: F.cz, site: site, frame: F};
  var nightMats = [];
  // the apron (dark asphalt, white bay lines), the workshop: dark corrugated walls, a red band, a flat roof
  box(Wd + 1, 0.4, Dd + 1, mat(0x8e9298, {roughness: 0.9}), 0, PL - 0.2, 0);
  box(Wd, 0.04, apron - 0.2, mat(0x2c2f34, {roughness: 0.85}), 0, PL + 0.02, hz1 + apron/2);
  var white = mat(0xeeeeee, {roughness: 0.7});
  [-hw/2, 0, hw/2].forEach(function(x){ box(0.12, 0.02, apron - 1, white, x, PL + 0.05, hz1 + apron/2); });
  var ribT = signTex(c, 128, 128, function(gx, w, h){ gx.fillStyle = "#2b2e34"; gx.fillRect(0, 0, w, h); for(var i = 0; i < w; i += 16){ gx.fillStyle = "#3b3f46"; gx.fillRect(i, 0, 8, h); gx.fillStyle = "#1d2025"; gx.fillRect(i + 8, 0, 2, h); } });
  if(ribT){ ribT.wrapS = ribT.wrapT = T.RepeatWrapping; ribT.repeat.set(Math.round(Wd/2), 2); }
  var wallM = new T.MeshStandardMaterial({color: 0xffffff, map: ribT || null, roughness: 0.7, metalness: 0.3});
  if(!ribT) wallM.color.setHex(0x30343a);
  box(Wd, H, 0.4, wallM, 0, PL + H/2, hz0 + 0.2);                                    // the back wall
  [-1, 1].forEach(function(sx){ box(0.4, H, hz1 - hz0, wallM, sx*(hw - 0.2), PL + H/2, (hz0 + hz1)/2); });
  box(Wd + 0.6, 0.5, hz1 - hz0 + 1.2, mat(0x24272c, {roughness: 0.6}), 0, PL + H + 0.25, (hz0 + hz1)/2 + 0.3);   // the roof, over the bays
  // the front: three piers round two big bays, the fascia over them (the sign, a chequered strip, a red band)
  var bayW = (Wd - 3*1.4)/2, bayH = 4.6, pierM = mat(0x1e2126, {roughness: 0.5, metalness: 0.4});
  [-hw + 0.7, 0, hw - 0.7].forEach(function(x){ box(1.4, bayH, 0.6, pierM, x, PL + bayH/2, hz1); });
  box(Wd, H - bayH, 0.6, pierM, 0, PL + bayH + (H - bayH)/2, hz1);
  var redM = new T.MeshStandardMaterial({color: 0xb8231c, emissive: 0xff2a1f, emissiveIntensity: 0.1, roughness: 0.4});
  nightMats.push([redM, 0.1, 0.9]);
  box(Wd + 0.1, 0.24, 0.66, redM, 0, PL + bayH + 0.12, hz1 + 0.02);
  var signT = signTex(c, 1024, 160, function(gx, w, h){
    gx.fillStyle = "#121418"; gx.fillRect(0, 0, w, h);
    gx.font = "900 " + Math.round(h*0.62) + "px 'Avenir Next', 'Segoe UI', sans-serif"; gx.textAlign = "center"; gx.textBaseline = "middle";
    gx.shadowColor = "#ff3b2f"; gx.shadowBlur = h*0.2; gx.fillStyle = "#ffe7e2"; gx.fillText(NAME.toUpperCase(), w/2, h*0.54); gx.shadowBlur = 0;
  });
  var signM = new T.MeshStandardMaterial({color: 0xffffff, map: signT || null, emissive: 0xffffff, emissiveMap: signT || null, emissiveIntensity: 0.35, roughness: 0.5});
  if(!signT){ signM.color.setHex(0x121418); signM.emissiveIntensity = 0; }
  nightMats.push([signM, 0.35, 1.5]);
  var sign = new T.Mesh(new T.PlaneGeometry(Math.min(Wd*0.8, 18), Math.min(Wd*0.8, 18)*160/1024), signM);
  sign.position.set(0, PL + bayH + (H - bayH)/2 + 0.2, hz1 + 0.31); g.add(sign);
  var chkT = signTex(c, 256, 16, function(gx, w, h){ for(var i = 0; i < w/8; i++) for(var j = 0; j < 2; j++){ gx.fillStyle = (i + j) % 2 ? "#f2f2f2" : "#16181b"; gx.fillRect(i*8, j*8, 8, 8); } });
  if(chkT){ chkT.wrapS = T.RepeatWrapping; chkT.repeat.set(Math.round(Wd/4), 1); }
  var chk = new T.Mesh(new T.PlaneGeometry(Wd, 0.22), new T.MeshBasicMaterial({color: chkT ? 0xffffff : 0x888888, map: chkT || null}));
  chk.position.set(0, PL + H - 0.12, hz1 + 0.31); g.add(chk);
  // inside: a light epoxy floor, the strip lights, a tool wall, and in each bay a two-post lift; the left bay's
  // roller door is half up, the right one open (its floor marking is the door E finds)
  var floorM = new T.MeshStandardMaterial({color: 0x9aa0a8, roughness: 0.25, metalness: 0.2, emissive: 0xdfe6ee, emissiveIntensity: 0});
  nightMats.push([floorM, 0, 0.35]);
  var floor = new T.Mesh(new T.BoxGeometry(Wd - 0.8, 0.06, hz1 - hz0 - 0.4), floorM); floor.position.set(0, PL + 0.03, (hz0 + hz1)/2); floor.receiveShadow = true; g.add(floor);
  var stripM = new T.MeshBasicMaterial({color: 0xfdfaf0, toneMapped: false});
  for(var sz = hz0 + 2; sz < hz1 - 1; sz += 3.5) box(Wd - 3, 0.08, 0.3, stripM, 0, PL + H - 0.1, sz);
  var toolT = signTex(c, 256, 128, function(gx, w, h){
    gx.fillStyle = "#3a3f47"; gx.fillRect(0, 0, w, h); gx.fillStyle = "#545b65";
    for(var i = 6; i < w; i += 12) for(var j = 6; j < h; j += 12){ gx.beginPath(); gx.arc(i, j, 1.6, 0, 2*PI); gx.fill(); }
    gx.strokeStyle = "#d9dde2"; gx.lineWidth = 4; gx.lineCap = "round";
    for(var k = 0; k < 7; k++){ var x = 22 + k*32; gx.beginPath(); gx.moveTo(x, 24); gx.lineTo(x, 70 + (k % 3)*12); gx.stroke(); gx.beginPath(); gx.arc(x, 20, 7, 0, 2*PI); gx.stroke(); }
    gx.fillStyle = "#b8231c"; gx.fillRect(14, 96, w - 28, 22);
  });
  var tools = new T.Mesh(new T.PlaneGeometry(Wd*0.6, 2.4), new T.MeshStandardMaterial({color: 0xffffff, map: toolT || null, roughness: 0.6}));
  tools.position.set(0, PL + 2.2, hz0 + 0.42); g.add(tools);
  var liftM = mat(0xd02a1f, {roughness: 0.4, metalness: 0.4}), armM = mat(0x2a2d33, {roughness: 0.5, metalness: 0.6});
  [-1, 1].forEach(function(bx){
    var cx = bx*(bayW/2 + 0.7), cz = (hz0 + hz1)/2 + 0.6;
    [-1, 1].forEach(function(sx){
      box(0.32, 3.6, 0.32, liftM, cx + sx*2.3, PL + 1.8, cz);
      box(0.12, 0.12, 1.8, armM, cx + sx*1.5, PL + 1.15, cz, null); box(1.4, 0.1, 0.12, armM, cx + sx*1.6, PL + 1.15, cz + 0.8); box(1.4, 0.1, 0.12, armM, cx + sx*1.6, PL + 1.15, cz - 0.8);
    });
    box(4.9, 0.2, 0.3, liftM, cx, PL + 3.7, cz);
  });
  // a stack of tyres and a red tool chest by the right pier
  var tyreM = mat(0x17181b, {roughness: 0.95});
  for(var ty = 0; ty < 4; ty++) c.cyl ? c.cyl(0.36, 0.36, 0.26, tyreM, hw - 1.6, PL + 0.13 + ty*0.27, hz1 - 1.4, stat, 14) : box(0.7, 0.26, 0.7, tyreM, hw - 1.6, PL + 0.13 + ty*0.27, hz1 - 1.4);
  box(1.2, 1.0, 0.55, redM, -hw + 1.4, PL + 0.5, hz0 + 1.2);
  // the half-up roller door in the left bay
  var rollT = signTex(c, 64, 64, function(gx, w, h){ gx.fillStyle = "#c9ced4"; gx.fillRect(0, 0, w, h); for(var j = 0; j < h; j += 8){ gx.fillStyle = "#8d959e"; gx.fillRect(0, j, w, 2); } });
  if(rollT){ rollT.wrapS = rollT.wrapT = T.RepeatWrapping; rollT.repeat.set(2, 4); }
  box(bayW, bayH*0.45, 0.1, new T.MeshStandardMaterial({color: 0xffffff, map: rollT || null, roughness: 0.5, metalness: 0.5}), -(bayW/2 + 0.7), PL + bayH - bayH*0.225, hz1 + 0.05);
  // the door: the open right bay's threshold (a hit the pointer and E find)
  var dHit = box(bayW - 0.4, 0.05, 1.2, new T.MeshStandardMaterial({color: 0xf2c94c, roughness: 0.6}), bayW/2 + 0.7, PL + 0.06, hz1 + 0.6);
  var dp = world(bayW/2 + 0.7, hz1 + 1.6), out = world(bayW/2 + 0.7, hz1 + 3.5);
  var door = {x: dp.x, y: y0 + PL, z: dp.z, kind: "tuning", label: PLACE_NAME, tip: NAME + ": tune your car or bike (E)", live: true,
              front: new T.Vector3(dp.x, y0, dp.z)};
  dHit.userData.door = door; B.doors.push(door); B.hits.push(dHit);
  B.door = {x: out.x, z: out.z, yaw: F.rot + PI};
  if(c.glow) [[-hw + 1, hz1 + 1], [hw - 1, hz1 + 1]].forEach(function(p){ var s = c.glow(0xffd9c8, 8, 0.5); s.position.set(p[0], PL + 5.5, p[1]); stat.add(s); B.glows.push(s); });
  // the masses: the workshop (blocks you, the camera and the far boxes)
  function note(cx, cz, w, d, ya, yb){
    var o = world(cx, cz), a = world(cx - w/2, cz - d/2), b2 = world(cx + w/2, cz + d/2), e = world(cx - w/2, cz + d/2), f2 = world(cx + w/2, cz - d/2);
    B.lod.push({x: o.x, z: o.z, w: w, d: d, rot: F.rot, y0: y0 + ya, y1: y0 + yb});
    B.boxes.push({min: {x: Math.min(a.x, b2.x, e.x, f2.x), y: y0 + ya, z: Math.min(a.z, b2.z, e.z, f2.z)},
                  max: {x: Math.max(a.x, b2.x, e.x, f2.x), y: y0 + yb, z: Math.max(a.z, b2.z, e.z, f2.z)},
                  o: {x: o.x, z: o.z, hw: w/2, hd: d/2, rot: F.rot, y0: ya}});
  }
  note(0, (hz0 + hz1)/2, Wd, hz1 - hz0, 0, PL + H + 0.5);
  B.inside = function(x, z){
    var dx = x - F.cx, dz = z - F.cz, lx = dx*cr - dz*sr, lz = dx*sr + dz*cr;
    return Math.abs(lx) <= Wd/2 && lz >= hz1 - 0.5 && lz <= Dd/2 + 1;        // on the apron, at the bays
  };
  B.setNight = function(n){ nightMats.forEach(function(m){ m[0].emissiveIntensity = n ? m[2] : m[1]; }); B.glows.forEach(function(s){ s.visible = !!n; }); };
  B.setNight(opts.night !== false);
  B.animate = function(){};
  if(HQV.hqMerge && HQV.hqMerge.mergeStatic){ try { HQV.hqMerge.mergeStatic(T, stat); } catch(e){} }
  stat.traverse(function(o){ if(o.isMesh) o.receiveShadow = true; });
  B.dispose = function(){ B.dead = true; };
  return B;
}

/* ---------- the panel (DOM): the vehicle, its preview, the tabs ---------- */
var OWN = ".hqtune";
function inside(t){ return !!(t && t.closest && t.closest(OWN)); }
function owns(e){ return !!(e && (e.hqTuneHandled || inside(e.target))); }
function calmNow(doc){
  var c = doc && doc.documentElement && doc.documentElement.classList && doc.documentElement.classList.contains("hq-calm");
  var r = false; try { r = !!(G.matchMedia && G.matchMedia("(prefers-reduced-motion: reduce)").matches); } catch(e){}
  return !!(c || r);
}
var TABS = [["paint", "Paint"], ["wheels", "Wheels"], ["windows", "Windows"], ["aero", "Aero"], ["exhaust", "Exhaust"], ["plate", "Plate"]];

function mountPanel(stage, opts){
  opts = opts || {};
  var doc = typeof document !== "undefined" ? document : null; if(!doc) return null;
  var announce = typeof opts.announce === "function" ? opts.announce : function(){};
  var listeners = [], open = false, items = [], cur = null, draft = defaults(), draftPaint = 0, tab = "paint", busy = false, statusText = "", plateMsg = "";
  function mk(tag, cls, parent, text){ var n = doc.createElement(tag); if(cls) n.className = cls; if(text != null) n.textContent = text; if(parent) parent.appendChild(n); return n; }
  function on(n, ev, fn){ n.addEventListener(ev, fn); listeners.push([n, ev, fn]); }

  var root = mk("div", "hqtune", stage); root.hidden = true;
  root.setAttribute("role", "dialog"); root.setAttribute("aria-label", NAME);
  var head = mk("div", "hqtune-head", root);
  mk("div", "hqtune-title", head, "🔧 " + NAME);
  mk("div", "hqtune-note", head, "Free: every change costs nothing.");
  var closeBtn = mk("button", "hqtune-close", head, "✕"); closeBtn.type = "button"; closeBtn.setAttribute("aria-label", "Leave the tuning shop");
  var main = mk("div", "hqtune-main", root);
  var left = mk("div", "hqtune-left", main);
  var pick = mk("select", "hqtune-pick", left); pick.setAttribute("aria-label", "Vehicle to tune");
  var prevBox = mk("div", "hqtune-preview", left);
  var cv = null;
  mk("div", "hqtune-hint", left, "Drag to orbit · wheel or + / − to zoom");
  var right = mk("div", "hqtune-right", main);
  var tabs = mk("div", "hqtune-tabs", right); tabs.setAttribute("role", "tablist");
  var body = mk("div", "hqtune-body", right); body.setAttribute("role", "tabpanel");
  var foot = mk("div", "hqtune-foot", root);
  var resetBtn = mk("button", "hqtune-reset", foot, "Back to stock"); resetBtn.type = "button";
  var status = mk("div", "hqtune-status", foot); status.setAttribute("role", "status"); status.setAttribute("aria-live", "polite");
  var saveBtn = mk("button", "hqtune-save", foot, "Save"); saveBtn.type = "button";

  /* the preview: its own small renderer, made on first open, drawing only while the panel is open */
  var P = null;
  function preview(){
    if(P || !opts.three || !HQV.hqVehicleModels) return P;
    var T = opts.three, R;
    cv = mk("canvas", "hqtune-canvas", prevBox); cv.setAttribute("tabindex", "0"); cv.setAttribute("role", "img"); cv.setAttribute("aria-label", "Preview: drag or use the arrow keys to look around");
    try { R = new T.WebGLRenderer({canvas: cv, antialias: true, alpha: true}); } catch(e){ prevBox.removeChild(cv); cv = null; return null; }
    R.setPixelRatio(Math.min(2, G.devicePixelRatio || 1));
    var S = new T.Scene(), cam = new T.PerspectiveCamera(34, 1.6, 0.1, 120);
    S.add(new T.HemisphereLight(0xffffff, 0x3c4048, 1.5));
    var sun = new T.DirectionalLight(0xffffff, 2.3); sun.position.set(5, 8, 6); S.add(sun);
    var rim = new T.DirectionalLight(0xffd9c8, 0.9); rim.position.set(-6, 3, -5); S.add(rim);
    var floor = new T.Mesh(new T.CylinderGeometry(9, 9, 0.1, 40), new T.MeshStandardMaterial({color: 0x3d4148, roughness: 0.4, metalness: 0.3})); floor.position.y = -0.11; S.add(floor);
    var turn = new T.Group(); S.add(turn);
    var disc = new T.Mesh(new T.CylinderGeometry(3.3, 3.3, 0.1, 48), new T.MeshStandardMaterial({color: 0x2a2d33, roughness: 0.3, metalness: 0.6})); disc.position.y = -0.05; turn.add(disc);
    var ring = new T.Mesh(new T.TorusGeometry(3.3, 0.04, 6, 48), new T.MeshBasicMaterial({color: 0xd02a1f})); ring.rotation.x = PI/2; S.add(ring);
    // the two-post lift behind: red posts, a cross beam, its arms folded
    var liftM = new T.MeshStandardMaterial({color: 0xd02a1f, roughness: 0.4, metalness: 0.4});
    [-1, 1].forEach(function(sx){ var p = new T.Mesh(new T.BoxGeometry(0.22, 3.2, 0.22), liftM); p.position.set(sx*3.7, 1.6, -3.2); S.add(p); });
    var beam = new T.Mesh(new T.BoxGeometry(7.6, 0.16, 0.22), liftM); beam.position.set(0, 3.25, -3.2); S.add(beam);
    var holder = new T.Group(); turn.add(holder);
    P = {T: T, R: R, S: S, cam: cam, turn: turn, holder: holder, raf: 0, th: 0.85, ph: 0.2, dist: 9, ty: 0.7, drag: null, spin: 0, last: 0, rig: null, key: null};
    on(cv, "pointerdown", function(e){ P.drag = {x: e.clientX, y: e.clientY}; if(cv.setPointerCapture && e.pointerId != null) try { cv.setPointerCapture(e.pointerId); } catch(x){} });
    on(cv, "pointermove", function(e){ if(!P.drag) return; P.th -= (e.clientX - P.drag.x)*0.01; P.ph = Math.max(0.05, Math.min(1.2, P.ph + (e.clientY - P.drag.y)*0.006)); P.drag = {x: e.clientX, y: e.clientY}; });
    on(cv, "pointerup", function(){ P.drag = null; }); on(cv, "pointercancel", function(){ P.drag = null; });
    on(cv, "wheel", function(e){ if(e.preventDefault) e.preventDefault(); zoom(e.deltaY > 0 ? 1.1 : 1/1.1); });
    on(cv, "keydown", function(e){
      var k = e.key;
      if(k === "ArrowLeft"){ P.th += 0.15; } else if(k === "ArrowRight"){ P.th -= 0.15; }
      else if(k === "ArrowUp"){ P.ph = Math.min(1.2, P.ph + 0.08); } else if(k === "ArrowDown"){ P.ph = Math.max(0.05, P.ph - 0.08); }
      else if(k === "+" || k === "="){ zoom(1/1.1); } else if(k === "-" || k === "_"){ zoom(1.1); } else return;
      if(e.preventDefault) e.preventDefault();
    });
    return P;
  }
  function zoom(f){ if(!P) return; var L = P.len || 4.5; P.dist = Math.max(L*0.9, Math.min(L*3.2, P.dist*f)); }
  function entryOf(it){ return it ? it.entry : null; }
  function baseHex(it){
    var p = it && it.paints && it.paints[draftPaint];
    return p && HEX_RE.test(String(p.hex || "")) ? parseInt(p.hex.slice(1), 16) : it && it.baseHex != null ? it.baseHex : 0x3366cc;
  }
  function previewSet(force){
    var p = preview(); if(!p || !cur) return;
    var VM = HQV.hqVehicleModels, hx = baseHex(cur);
    if(!force && p.rig && p.key === cur.key + ":" + draftPaint && p.rig.setTune && p.rig.setTune(draft)) return;
    while(p.holder.children.length) p.holder.remove(p.holder.children[0]);
    var rig = null;
    try { rig = VM.build(opts.ctx || opts.three, Object.assign({}, entryOf(cur)), hx, {tune: draft, accent: cur.accent, plate: typeof opts.plate === "function" ? opts.plate() : null}); } catch(e){ rig = null; }
    p.rig = rig; p.key = cur.key + ":" + draftPaint;
    if(!rig) return;
    p.holder.add(rig.g);
    var L = 4.5, e = entryOf(cur);
    try { L = e && !e.starter && VM.shown ? +VM.shown(e).lengthM : cur.kind === "bike" ? 2.6 : 4.2; } catch(x){}
    if(!(L > 0)) L = 4.5;
    if(p.len !== L){ p.len = L; p.dist = L*(cur.kind === "bike" ? 1.9 : 1.45); p.ty = cur.kind === "bike" ? 0.6 : 0.55; }
  }
  function previewLoop(){
    if(!P || !open) return;
    var w = P.R.domElement.clientWidth || 360, h = P.R.domElement.clientHeight || 220, pr = P.R.getPixelRatio();
    if(P.R.domElement.width !== Math.round(w*pr) || P.R.domElement.height !== Math.round(h*pr)){ P.R.setSize(w, h, false); P.cam.aspect = w/h; P.cam.updateProjectionMatrix(); }
    var t = (G.performance ? G.performance.now() : Date.now())/1000, dt = P.last ? Math.min(0.1, t - P.last) : 0; P.last = t;
    if(!P.drag && !calmNow(doc)) P.turn.rotation.y += dt*0.25;          // the turntable turns (still under Calm)
    var cp = Math.cos(P.ph);
    P.cam.position.set(Math.sin(P.th)*cp*P.dist, P.ty + Math.sin(P.ph)*P.dist, Math.cos(P.th)*cp*P.dist); P.cam.lookAt(0, P.ty, 0);
    P.R.render(P.S, P.cam);
    P.raf = G.requestAnimationFrame ? G.requestAnimationFrame(previewLoop) : 0;
  }

  /* the controls */
  function chips(parent, label, list, isOn, onPick){
    var fs = mk("fieldset", "hqtune-group", parent); mk("legend", null, fs, label);
    var row = mk("div", "hqtune-chips", fs);
    list.forEach(function(o){
      var b = mk("button", "hqtune-chip" + (isOn(o[0]) ? " on" : ""), row, o[1]); b.type = "button"; b.setAttribute("aria-pressed", isOn(o[0]) ? "true" : "false");
      on(b, "click", function(){ onPick(o[0]); changed(); });
    });
    return fs;
  }
  function swatches(parent, label, list, val, onPick, custom){
    var fs = mk("fieldset", "hqtune-group", parent); mk("legend", null, fs, label);
    var row = mk("div", "hqtune-chips", fs);
    list.forEach(function(o){
      var b = mk("button", "hqtune-swatch" + (o.on ? " on" : ""), row); b.type = "button"; b.style.background = o.hex; b.title = o.name;
      b.setAttribute("aria-label", o.name); b.setAttribute("aria-pressed", o.on ? "true" : "false");
      on(b, "click", function(){ onPick(o); changed(); });
    });
    if(custom){
      var lab = mk("label", "hqtune-custom", row); mk("span", null, lab, "Custom");
      var inp = mk("input", null, lab); inp.type = "color"; inp.value = val || "#3366cc"; inp.setAttribute("aria-label", label + ": custom colour");
      on(inp, "input", function(){ if(HEX_RE.test(inp.value)){ custom(inp.value.toLowerCase()); changed(true); } });
      on(inp, "change", function(){ render(); });
    }
    return fs;
  }
  function changed(soft){ draft = normalize(draft, cur ? cur.kind : "car"); previewSet(false); if(!soft) render(); dirtyNote(); }
  function dirtyNote(){
    var d = cur && (encode(draft, cur.kind) !== encode(cur.tune, cur.kind) || (cur.paints && cur.paints.length && draftPaint !== (cur.paint | 0)));
    saveBtn.disabled = !d || busy; resetBtn.disabled = busy || isStock(draft, cur ? cur.kind : "car");
  }
  function renderTab(){
    while(body.firstChild) body.removeChild(body.firstChild);
    if(!cur){ mk("div", "hqtune-empty", body, "Nothing to tune yet: get a car or a bike at the dealership."); return; }
    var k = cur.kind, f1 = !!(cur.entry && cur.entry.body === "formula");   // [3.17] an F1 car keeps its own aero, wheels and open cockpit
    if(f1 && tab !== "paint" && tab !== "exhaust"){
      mk("div", "hqtune-empty", body, tab === "wheels" ? "An F1 car keeps its own wheels: covers over 18-inch rims on slicks." : tab === "windows" ? "No windows: an F1 cockpit is open." :
        tab === "aero" ? "An F1 car keeps its own wings: its downforce is part of the car." : "An F1 car carries its number, not a plate.");
      return;
    }
    if(tab === "paint"){
      if(cur.paints && cur.paints.length) swatches(body, "Factory paint", cur.paints.map(function(p, i){ return {hex: p.hex, name: p.name || ("Paint " + (i + 1)), on: !draft.color && i === draftPaint, i: i}; }), null,
        function(o){ draftPaint = o.i; draft.color = null; });
      swatches(body, "Your colour", [], draft.color, null, function(v){ draft.color = v; });
      chips(body, "Finish", OPTIONS.finish, function(v){ return draft.finish === v; }, function(v){ draft.finish = v; });
      if(!f1) chips(body, "Two-tone", OPTIONS.two_tone[k], function(v){ return draft.two_tone === v; }, function(v){ draft.two_tone = v; if(v !== "none" && !draft.color2) draft.color2 = k === "bike" ? "#15171a" : "#f2f2f2"; });
      if(!f1 && draft.two_tone !== "none") swatches(body, "Second colour", [{hex: "#f2f2f2", name: "White", on: draft.color2 === "#f2f2f2"}, {hex: "#15171a", name: "Black", on: draft.color2 === "#15171a"}, {hex: "#c9a227", name: "Gold", on: draft.color2 === "#c9a227"}, {hex: "#b3131f", name: "Red", on: draft.color2 === "#b3131f"}],
        draft.color2, function(o){ draft.color2 = o.hex; }, function(v){ draft.color2 = v; });
    } else if(tab === "wheels"){
      chips(body, "Rims", OPTIONS.rim[k].map(function(n, i){ return [i, n]; }), function(v){ return draft.rim === v; }, function(v){ draft.rim = v; });
      swatches(body, "Rim colour", [{hex: "#9aa0a8", name: "Stock", on: !draft.rim_color, stock: true}].concat(OPTIONS.rimColors.map(function(o){ return {hex: o[0], name: o[1], on: draft.rim_color === o[0]}; })),
        draft.rim_color, function(o){ draft.rim_color = o.stock ? null : o.hex; }, function(v){ draft.rim_color = v; });
      chips(body, "Size (the tyre's outside stays the same)", OPTIONS.rim_size, function(v){ return draft.rim_size === v; }, function(v){ draft.rim_size = v; });
    } else if(tab === "windows"){
      if(k === "bike") mk("div", "hqtune-empty", body, "A bike's screen stays clear: tint is for cars.");
      else chips(body, "Window tint", OPTIONS.tint.map(function(n, i){ return [i, n]; }), function(v){ return draft.tint === v; }, function(v){ draft.tint = v; });
    } else if(tab === "aero"){
      if(k === "bike") mk("div", "hqtune-empty", body, "Wings are for cars.");
      else chips(body, "Rear wing", OPTIONS.wing, function(v){ return draft.wing === v; }, function(v){ draft.wing = v; });
    } else if(tab === "exhaust"){
      if(cur.ev) mk("div", "hqtune-empty", body, "Electric: nothing to tune here.");
      else {
        chips(body, "Exhaust", OPTIONS.exhaust[k], function(v){ return draft.exhaust === v; }, function(v){ draft.exhaust = v; });
        mk("div", "hqtune-tip", body, "Sport is louder and raspier; titanium and the end can crackle more.");
      }
    } else if(tab === "plate"){
      var fs = mk("fieldset", "hqtune-group", body); mk("legend", null, fs, "Number plate");
      var lab = mk("label", "hqtune-plate", fs);
      var inp = mk("input", null, lab); inp.type = "text"; inp.maxLength = 8; inp.value = draft.plate; inp.setAttribute("autocomplete", "off"); inp.setAttribute("spellcheck", "false");
      inp.placeholder = String((typeof opts.plate === "function" ? opts.plate() : "") || "HQ").toUpperCase().slice(0, 18); inp.setAttribute("aria-label", "Plate text, up to 8 letters, numbers, spaces or dashes");
      var msg = mk("div", "hqtune-tip", fs, plateMsg || "Up to 8: A-Z, 0-9, space and dash. Leave it empty for your HQ's name.");
      on(inp, "input", function(){
        var r = plateCheck(inp.value);
        if(r.ok){ draft.plate = r.text; plateMsg = ""; msg.textContent = "Up to 8: A-Z, 0-9, space and dash. Leave it empty for your HQ's name."; msg.className = "hqtune-tip"; changed(true); }
        else { plateMsg = r.why; msg.textContent = r.why; msg.className = "hqtune-tip bad"; }
      });
    }
  }
  function render(){
    while(tabs.firstChild) tabs.removeChild(tabs.firstChild);
    TABS.forEach(function(t){
      if(cur && cur.kind === "bike" && (t[0] === "aero" || t[0] === "windows")) return;
      var b = mk("button", "hqtune-tab" + (t[0] === tab ? " on" : ""), tabs, t[1]); b.type = "button"; b.setAttribute("role", "tab"); b.setAttribute("aria-selected", t[0] === tab ? "true" : "false");
      on(b, "click", function(){ tab = t[0]; render(); });
    });
    renderTab(); dirtyNote();
    status.textContent = statusText;
  }
  function fillPick(){
    while(pick.firstChild) pick.removeChild(pick.firstChild);
    items.forEach(function(it){ var o = mk("option", null, pick, it.title); o.value = it.key; if(cur && it.key === cur.key) o.selected = true; });
    pick.disabled = items.length < 2;
  }
  function choose(key){
    var it = null; items.forEach(function(x){ if(x.key === key) it = x; });
    cur = it || items[0] || null;
    if(cur){ cur.tune = normalize(cur.tune, cur.kind); draft = normalize(cur.tune, cur.kind); draftPaint = Math.max(0, cur.paint | 0); }
    if(cur && cur.kind === "bike" && (tab === "aero" || tab === "windows")) tab = "paint";
    plateMsg = ""; fillPick(); previewSet(true); render();
  }
  on(pick, "change", function(){ statusText = ""; choose(pick.value); });
  on(resetBtn, "click", function(){ if(!cur) return; draft = defaults(); draftPaint = Math.max(0, cur.paint | 0); changed(); });
  on(saveBtn, "click", function(){
    if(!cur || busy || !opts.save) return;
    busy = true; dirtyNote(); setStatus("Saving…");
    var it = cur, t = normalize(draft, it.kind), pi = it.paints && it.paints.length ? draftPaint : null;
    Promise.resolve(opts.save(it, t, pi)).then(function(r){
      busy = false;
      if(r && r.ok){ it.tune = t; if(pi != null) it.paint = pi; }
      setStatus((r && r.text) || ""); dirtyNote();
    }, function(){ busy = false; setStatus("That didn't work. Try again in a moment."); dirtyNote(); });
  });
  function setStatus(t){ statusText = String(t || ""); status.textContent = statusText; if(statusText) announce(statusText); }
  function contain(e){
    e.hqTuneHandled = true;
    if(e.stopPropagation) e.stopPropagation();
    if(e.type === "keydown" && e.key === "Escape"){ if(e.preventDefault) e.preventDefault(); close(); }
  }
  on(root, "keydown", contain); on(root, "keyup", contain);
  on(closeBtn, "click", function(){ close(); });

  function openP(o){
    o = o || {};
    items = (typeof opts.vehicles === "function" ? opts.vehicles() : []) || [];
    statusText = "";
    if(!open){ open = true; root.hidden = false; }
    choose(o.key || (cur && cur.key));
    if(P || preview()){ if(P.raf && G.cancelAnimationFrame) G.cancelAnimationFrame(P.raf); P.last = 0; previewLoop(); }
    var f = pick.disabled ? (root.querySelector(".hqtune-tab.on") || closeBtn) : pick; if(f && f.focus) f.focus();
  }
  function close(){
    if(!open) return; open = false; root.hidden = true;
    if(P && P.raf && G.cancelAnimationFrame) G.cancelAnimationFrame(P.raf);
    if(opts.onClose) opts.onClose();
  }
  return {
    open: openP, close: close, isOpen: function(){ return open; }, render: render, root: root, status: setStatus,
    draft: function(){ return normalize(draft, cur ? cur.kind : "car"); }, current: function(){ return cur ? cur.key : null; },
    rig: function(){ return P && P.rig; },
    destroy: function(){
      close(); listeners.forEach(function(l){ l[0].removeEventListener(l[1], l[2]); }); listeners = [];
      if(P){ try { P.R.dispose(); } catch(e){} P = null; }
      if(root.parentNode) root.parentNode.removeChild(root);
    }
  };
}

var api = {
  OPTIONS: OPTIONS, BANNED: BANNED, NAME: NAME, PLACE_NAME: PLACE_NAME, SITE_ID: SITE_ID, MIN_TIER: MIN_TIER,
  defaults: defaults, normalize: normalize, isStock: isStock, plateCheck: plateCheck, encode: encode, decode: decode, exhaustOf: exhaustOf,
  of: of, save: save, onChange: function(f){ if(typeof f !== "function") return function(){}; subs.push(f); return function(){ subs = subs.filter(function(g){ return g !== f; }); }; },
  setCatalogue: function(c){ CATR = c && c.vehicles ? c : CATR; },
  host: null, openFor: function(key){ return typeof api.host === "function" ? !!api.host(key) : false; },
  place: place, pick: pick, build: build, mountPanel: mountPanel, owns: owns,
  _io: io, _reset: function(){ subs = []; }
};
HQV.hqTuning = api;
})();
