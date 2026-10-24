/* Helpers tools/transit_tour.py loads into the page (?hqsmoke=1): drive HQ3D_DEBUG.transit for the screenshot tour.
   Each returns a JSON string the tour prints. Test-only: never part of the HQ page. */
(function(){
var T = function(){ return window.HQ3D_DEBUG.transit; };
var TT = window.__tour = {};
function J(v){ try { return JSON.stringify(v); } catch(e){ return String(v); } }
// the Lobby chat card (a dashboard panel over the City's corner) out of the pictures
TT.hideLobby = function(){
  var c = [].slice.call(document.querySelectorAll("div,section,aside")).filter(function(e){ var t = e.textContent || "", r = e.getBoundingClientRect();
    return t.indexOf("Join voice") >= 0 && t.indexOf("Lobby") >= 0 && r.width > 0 && r.width < 420; });
  c.sort(function(a, b){ return b.getBoundingClientRect().height - a.getBoundingClientRect().height; });
  if(c[0]) c[0].style.visibility = "hidden";
  return c.length;
};
// a module's fixed shot: the avatar under it first (so its tiles are built), then the camera held
TT.shot = function(mod, name){
  var sc = T().shot(mod, name); if(!sc) return J(null);
  window.HQ3D_DEBUG.teleport(sc.pos.x, sc.pos.z);
  return J(T().shot(mod, name));
};
TT.cam = function(pos, look, fov, under){ return J(T().cam({pos: pos, look: look, fov: fov || 60, under: under})); };
TT.clear = function(){ return TT.endRide(); };
// a line's stops in order: {id, name, x, z}
TT.lineStops = function(mode, line){
  var L = (T().lines(mode) || []).filter(function(l){ return l.id === line || l.short === line; })[0]; if(!L) return [];
  var by = {}; (T().stops(mode) || []).forEach(function(s){ by[s.id] = s; });
  return (L.stops || []).map(function(id){ return by[id] ? {id: id, name: by[id].name, x: by[id].x, z: by[id].z, under: !!by[id].under} : null; }).filter(Boolean);
};
TT.lineOf = function(mode, k){ var L = (T().lines(mode) || [])[k || 0]; return L ? {id: L.id, short: L.short, stops: L.stops, name: L.name} : null; };
// board a line from stop a to stop b (indexes into its stops, or ids) and skip ahead: the clock runs on from
// when it arrives, then jumps to `frac` of the way to the far stop. Returns the ride's info.
TT.ride = function(mode, line, a, b, frac, at){
  var L = TT.lineOf(mode, 0), ls = (T().lines(mode) || []).filter(function(l){ return l.id === line || l.short === line; })[0] || L;
  if(!ls) return J({err: "no line"});
  var st = ls.stops || [], from = typeof a === "number" ? st[a] : a, to = typeof b === "number" ? st[Math.min(st.length - 1, b)] : b;
  if(at != null) T().freeze(at, true);
  var g = T().go(from);
  var ok = T().board(mode, ls.id, from, to);
  var info = T().info(); if(!ok || !info) return J({err: "no trip", ok: ok, go: g, from: from, to: to});
  if(info.door) window.HQ3D_DEBUG.teleport(info.door.x, info.door.z);          // at the doors, waiting
  T().freeze(info.arrive + 2500, true);
  TT._ride = {arrive: info.arrive, reach: info.reach, frac: frac == null ? 0.4 : frac};
  return J({go: g, info: info});
};
// after ride(): once seated, jump to frac of the trip
TT.rideOn = function(frac){
  var R = TT._ride; if(!R) return J({err: "no ride"});
  var f = frac == null ? R.frac : frac, t = R.arrive + 4000 + (R.reach - R.arrive - 4000)*f;
  T().freeze(t, true);
  return J({phase: T().phase(), info: T().info()});
};
TT.endRide = function(){
  var h = H(), S = h && h.session ? h.session() : null;
  if(S && S.cancel){ try { S.cancel(true); } catch(e){} }
  if(TT.base) T().freeze(TT.base, true); else T().freeze(null);
  T().shotClear(); T().under(false); window.HQ3D_DEBUG.mode("chase");
  return "1";
};

// the phone: open an app, then (optionally) click a button whose text matches
TT.phone = function(app, arg){ T().phone(app, arg); return J({open: !!document.querySelector(".hqphone-root .hqphone")}); };
TT.click = function(re, scope){
  var rx = new RegExp(re), root = scope ? document.querySelector(scope) : document.querySelector(".hqphone-root") || document;
  var b = [].slice.call((root || document).querySelectorAll("button,[role=tab],[role=radio],summary,a")).filter(function(e){ return rx.test((e.textContent || "").trim()) || rx.test(e.getAttribute("aria-label") || ""); })[0];
  if(!b) return J({err: "no button " + re});
  b.click(); return J((b.textContent || "").trim().slice(0, 60));
};
TT.select = function(labelRe, optRe){
  var root = document.querySelector(".hqphone-root") || document, rl = new RegExp(labelRe), ro = new RegExp(optRe);
  var lab = [].slice.call(root.querySelectorAll("label")).filter(function(l){ return rl.test(l.textContent || ""); })[0];
  var s = lab && lab.htmlFor ? document.getElementById(lab.htmlFor) : null; if(!s) return J({err: "no select " + labelRe});
  var o = [].slice.call(s.options).filter(function(o){ return ro.test(o.textContent || ""); })[0]; if(!o) return J({err: "no option " + optRe});
  s.value = o.value; s.dispatchEvent(new Event("change", {bubbles: true})); return J(o.textContent);
};
TT.type = function(sel, text){
  var root = document.querySelector(".hqphone-root") || document, e = root.querySelector(sel); if(!e) return J({err: "no " + sel});
  e.focus(); e.value = text; e.dispatchEvent(new Event("input", {bubbles: true})); return J(text.length);
};
TT.calm = function(on){ document.documentElement.classList.toggle("hq-calm", !!on); return J(!!on); };
TT.stats = function(){ return J(window.HQ3D_DEBUG.stats()); };
// the clock on to the nearest clear-skies weather slot (weather is a pure function of the clock and the world), running
TT.clearSkies = function(from){
  var Wx = window.HQV.hqWeather, w = window.HQ3D_DEBUG.world(), t = from != null ? from : Date.now();
  if(!Wx || !Wx.at) return J({err: "no weather"});
  // daylight (07:00..16:00 UTC, the smoke page is lit by day anyway) with three clear hours ahead: rides skip on in time
  function dry(k){ return k === "clear" || k === "cloudy"; }
  function clearFor(ms, n){ var a0 = Wx.at(w, ms); if(a0.kind !== "clear" || a0.prev !== "clear") return false;
    for(var j = 1; j < n; j++){ var a = Wx.at(w, ms + j*15*60000); if(!dry(a.kind) || !dry(a.prev)) return false; } return true; }
  for(var k = 0; k < 96*60; k++){ var ms = t + k*15*60000, h = new Date(ms).getUTCHours(); if(h >= 7 && h < 16 && clearFor(ms, 5)){ T().freeze(ms + 2*60000, true); TT.base = ms + 2*60000; return J({at: new Date(ms).toISOString(), k: k}); } }
  return J({err: "no clear slot"});
};
// hh:mm UTC on the clear day, running on (keeps the weather the tour picked when it can)
TT.at = function(h, m){
  var b = TT.base || Date.now(), d = new Date(b); d.setUTCHours(h, m || 0, 0, 0);
  var Wx = window.HQV.hqWeather, w = window.HQ3D_DEBUG.world(), t = d.getTime();
  function ok(ms){ for(var j = 0; j < 4; j++){ var a = Wx.at(w, ms + j*15*60000); if(!(a.kind === "clear" || a.kind === "cloudy") || !(a.prev === "clear" || a.prev === "cloudy")) return false; } return true; }
  for(var k = 0; k < 120 && Wx && !ok(t); k++) t += 86400000;
  T().freeze(t, true); return J(new Date(t).toISOString());
};
function H(){ return window.HQ3D && window.HQ3D.inst && window.HQ3D.inst.phone ? window.HQ3D.inst.phone.host : null; }
function doc(){ var h = H(); return h && h.doc ? h.doc() : null; }
TT.key = function(code){ var o = {code: code, key: code.replace(/^Key/, "").toLowerCase(), bubbles: true};
  [window, document, document.querySelector("canvas")].forEach(function(t){ if(!t) return; t.dispatchEvent(new KeyboardEvent("keydown", o)); t.dispatchEvent(new KeyboardEvent("keyup", o)); });
  return J(code); };
// the metro ride on to the portal: the train's last open-air stretch (the clock jumps to when it passes the portal)
TT.portalRide = function(){
  var L = (T().lines("metro") || [])[0]; if(!L) return J({err: "no metro"});
  var st = L.stops || [], ok = false;
  // from the last station to the one before it, the line's open end (towards its depot) is near the far terminus
  var a = st.length - 2, b = st.length - 1;
  var r = JSON.parse(TT.ride("metro", L.id, a, b, 0.92));
  return J(r);
};
// the Island Link train from outside, mid-crossing: a camera off its flank, looking at it
TT.linkCam = function(){
  var h = H(), R = h && h.ride, sv = R && R.services ? R.services().filter(function(q){ return q.mode === "link"; })[0] : null;
  if(!sv || !TT._linkVeh) return J({err: "no link"});
  var v = (sv.vehicles(Date.now()) || []).filter(function(q){ return String(q.id) === String(TT._linkVeh); })[0];
  if(!v) return J({err: "no train"});
  var yaw = +v.yaw || 0, rx = Math.cos(yaw), rz = -Math.sin(yaw), fx = Math.sin(yaw), fz = Math.cos(yaw);
  return TT.cam({x: v.x + rx*45 - fx*30, y: (v.y || 0) + 14, z: v.z + rz*45 - fz*30}, {x: v.x + fx*20, y: (v.y || 0) + 2, z: v.z + fz*20}, 50);
};
TT.linkRide = function(world){
  var t0 = Date.now(), ok = T().link(world), info = T().info();
  if(!ok || !info) return J({err: "no link trip", ok: ok});
  TT._linkVeh = info.vehicle;
  if(info.door) window.HQ3D_DEBUG.teleport(info.door.x, info.door.z);
  T().freeze(info.arrive + 2500, true);
  TT._ride = {arrive: info.arrive, reach: info.reach, frac: 0.3};
  setTimeout(function(){ TT.rideOn(0.6); }, 2500);            // mid-sea, seated (hqTravel carries you from departure)
  return J(info);
};
// the @3 water bodies: a camera over the first one of a kind
TT.water = function(kind){
  var W = window.HQV.world, d = doc(), V = W && W.waterOf && d ? W.waterOf(d) : null; if(!V) return J({err: "no water"});
  var b = V.bodies.filter(function(q){ return q.kind === kind; })[0]; if(!b) return J({err: "no " + kind, kinds: V.bodies.map(function(q){ return q.kind; })});
  var x0 = 1e9, x1 = -1e9, z0 = 1e9, z1 = -1e9;
  for(var i = 0; i + 1 < b.poly.length; i += 2){ x0 = Math.min(x0, b.poly[i]); x1 = Math.max(x1, b.poly[i]); z0 = Math.min(z0, b.poly[i + 1]); z1 = Math.max(z1, b.poly[i + 1]); }
  var cx = (x0 + x1)/2, cz = (z0 + z1)/2, R = Math.max(30, Math.max(x1 - x0, z1 - z0));
  window.HQ3D_DEBUG.teleport(cx, cz);
  return TT.cam({x: cx + R*0.55, y: b.y + R*0.5, z: cz + R*0.75}, {x: cx, y: b.y, z: cz}, 55);
};
// a water taxi from the nearest pier to another, the clock on to when it is nearly there, a camera on it
TT.waterTaxi = function(){
  var h = H(), w = h && h.water; if(!w) return J({err: "no water"});
  var P = w.piers() || []; if(!P.length) return J({err: "no piers"});
  var from = P[0], tg = w.targets(from.id) || []; if(!tg.length) return J({err: "no targets"});
  window.HQ3D_DEBUG.teleport(from.x, from.z);
  var hd = T().water("taxi", from.id, tg[0]); if(!hd) return J({err: "no taxi"});
  var s1 = hd.state ? hd.state() : null, eta = s1 && s1.eta ? s1.eta : 0;
  if(eta > 10) T().freeze(Date.now() + (eta - 8)*1000, true);           // on to when it is nearly at the pier
  return J({from: from.id, to: tg[0], eta: eta});
};
TT.taxiCam = function(){ var sc = T().shot("taxi", "water-taxi"); if(!sc) return J(null); return J(T().cam(sc)); };
TT.hire = function(kind){
  var h = H(), w = h && h.water; if(!w) return J({err: "no water"});
  var P = (w.piers() || []).filter(function(p){ return p.kind === "hire" && (w.kinds(p.id) || []).indexOf(kind) >= 0; })[0];
  if(!P) return J({err: "no hire jetty for " + kind});
  window.HQ3D_DEBUG.teleport(P.x, P.z);
  var r = T().water(kind, P.id);
  return J({jetty: P.id, ok: r});
};
TT.checkin = function(){
  var root = document.querySelector(".hqphone-root"); if(!root) return J({err: "no phone"});
  var b = [].slice.call(root.querySelectorAll("button")).filter(function(e){ return e.getAttribute("role") !== "tab" && /^check in$/i.test((e.textContent || "").trim()); })[0];
  if(b) b.click();
  return J(b ? b.textContent.trim() : null);
};
TT.openFirstStop = function(){ var b = document.querySelector(".hqphone-root .hp-stopbtn"); if(b) b.click(); return J(!!b); };
TT.clickIn = function(scope, sel){ var e = document.querySelector(".hqphone-root " + scope + " " + sel); if(e) e.click(); return J(!!e); };
function cabs(){ var h = H(); return h ? h.cabs : null; }
TT.cabSkip = function(want){
  var C = cabs(), Hd = C && C.current ? C.current() : null; if(!Hd) return J({err: "no cab"});
  var s = Hd.state(); if(s.phase === "coming" && C.tools && C.tools.arrive) C.tools.arrive();
  return J(s.phase);
};
TT.cabCam = function(){ var sc = T().shot("cabs", "cab-arrive"); return J(sc ? T().cam(sc) : null); };
TT.cabBoard = function(){
  var C = cabs(), Hd = C && C.current ? C.current() : null; if(!Hd) return J({err: "no cab"});
  var st = Hd.state();
  if(st.phase === "matching" || st.phase === "coming"){ T().freeze(Date.now() + 4000, true); if(C.tools && C.tools.arrive) C.tools.arrive(); }   // on to the kerb
  setTimeout(function(){
    var sc = T().shot("cabs", "cab-arrive"); T().shotClear();
    if(sc) window.HQ3D_DEBUG.teleport(sc.look.x, sc.look.z);                   // at the cab's door
    setTimeout(function(){ Hd.board();
      setTimeout(function(){ T().seatCam("seat"); var s2 = Hd.state(); if(s2.eta > 8) T().freeze(Date.now() + s2.eta*0.4*1000, true); }, 600); }, 400);
  }, 900);
  return J({phase: st.phase, eta: st.eta});
};
TT.cabEnd = function(){ var C = cabs(); if(C && C.cancel) C.cancel(); T().shotClear(); return "1"; };
TT.driver = function(){
  var C = cabs(); if(!C) return J({err: "no cabs"});
  window.HQ3D_DEBUG.ride("car");
  var r = C.driver.on(true), tries = 0;
  // requests come in seeded 15 s slots (not every slot has one): take the first that comes, then look at its beacon
  (function poll(){
    var O = C.driver.offers() || [];
    if(O.length && C.driver.accept(O[0].id)){ setTimeout(function(){ var sc = T().shot("cabs", "driver-pickup"); if(sc) T().cam(sc); }, 800); return; }
    if(++tries < 8){ T().freeze(Date.now() + 15000, true); setTimeout(poll, 400); }
  })();
  return J({on: r});
};
TT.driverOff = function(){ var C = cabs(); if(C) C.driver.on(false); T().shotClear(); window.HQ3D_DEBUG.unride(); return "1"; };
function heliC(){ var h = H(); return h ? h.heli : null; }
// a Claude Cabs heli to the nearest landing spot; the clock on to a few seconds before it touches down; a camera
// beside the spot (between you and it, raised) looking at it
TT.heli = function(){
  T().shotClear();
  var HC = heliC(); if(!HC) return J({err: "no heli"});
  var sp = (HC.spots(400) || []).filter(function(q){ return q.kind === "open"; })[0] || (HC.spots(400) || [])[0]; if(!sp) return J({err: "no spot"});
  var hd = HC.call(sp, {own: null}); if(!hd) return J({err: "no call"});
  var eta = hd.state().eta || 0;
  T().freeze(Date.now() + Math.max(0, eta - 4)*1000, true);
  var me = window.HQ3D_DEBUG.probe(), dx = me.x - sp.x, dz = me.z - sp.z, d = Math.hypot(dx, dz) || 1, k = Math.min(1, 28/d);
  TT._spot = sp;
  setTimeout(function(){ TT.cam({x: sp.x + dx*k, y: (sp.y || 0) + 9, z: sp.z + dz*k}, {x: sp.x, y: (sp.y || 0) + 4, z: sp.z}, 55); }, 300);
  return J({spot: sp.name, kind: sp.kind, eta: eta});
};
// on to touchdown, walk up, board, fly to the airport (or the farthest pad), the clock to the middle of the flight
TT.heliBoard = function(){
  T().shotClear();
  var HC = heliC(), hd = HC && HC.current(); if(!hd) return J({err: "no heli"});
  var st = hd.state(); if(st.phase === "coming") T().freeze(Date.now() + (st.eta + 2)*1000, true);
  var sp = TT._spot; if(sp) window.HQ3D_DEBUG.teleport(sp.x + 2, sp.z + 2);
  var ok = false;
  setTimeout(function(){ ok = HC.use();
    var pads = (HC.spots(4000) || []).filter(function(q){ return q.kind === "pad"; }), far = pads[pads.length - 1];
    if(far) HC.fly(far);
    setTimeout(function(){ var s2 = hd.state(); if(s2.eta > 6) T().freeze(Date.now() + s2.eta*0.45*1000, true); T().seatCam("window"); }, 600);
  }, 800);
  return J(st);
};
TT.heliEnd = function(){ var HC = heliC(), hd = HC && HC.current(); if(hd && hd.cancel) hd.cancel(); T().shotClear(); if(TT.base) T().freeze(TT.base, true); window.HQ3D_DEBUG.teleport(0, 10.5); return "1"; };
TT.openThread = function(){ var b = [].slice.call(document.querySelectorAll(".hqphone-root button")).filter(function(e){ return /Ada/.test(e.textContent || ""); })[0]; if(b) b.click(); return J(!!b); };
// a fake peer standing beside you says something nearby (the smoke peer of ?hqsmoke=1)
TT.nearby = function(){
  var S = window.hqPhoneSocial; if(!S) return J({err: "no social"});
  S.setEnabled("near", true);
  var P = (window.HQ3D_DEBUG.peers() || [])[0], id = P ? P.u : "tour-peer-1";
  S.onSocket({type: "say", from: {userId: id, displayName: "Ada"}, data: {kind: "near", text: "Is this the stop for the T2?", d: 6}});
  return J({peer: id});
};
TT.ring = function(){
  var S = window.hqPhoneSocial; if(!S) return J({err: "no social"});
  S.setEnabled("calls", true);
  S.onSocket({type: "ring", from: {userId: "tour-peer-1", displayName: "Ada"}, id: "ctour1"});
  return "1";
};
TT.hangup = function(){ var S = window.hqPhoneSocial, c = S && S.calls.active(); if(c && c.decline) c.decline(); else if(c && c.hangup) c.hangup(); return "1"; };
TT.shutter = function(){ var b = document.querySelector(".hqphone-root .hg-shutter"); if(b) b.click(); return J(!!b); };
// the busiest surface view: the Commons plaza, the chase camera
TT.busiest = function(){ T().shotClear(); window.HQ3D_DEBUG.teleport(0, 10.5); window.HQ3D_DEBUG.mode("chase"); return "1"; };

})();
