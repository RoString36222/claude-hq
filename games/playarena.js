/* Claude HQ: City play feature "arena" (HQ 3.22), three games with the other players in the same City. Registers with
 * HQV.cityPlay (games/cityplay.js) and adds the phone's "Arena play" app (HQV.hqPhoneQueue, games/hqphone.js).
 *
 * Everything is invite-based: a host invites one nearby player (within INVITE_R m, same world) at a time from the app;
 * nothing happens to them until they press Accept, and either side leaves with one button. The games:
 *   1 Co-op delivery  the host's active job (games/playjobs.js) is shared: its kind and its places go to the partner, who
 *                     starts the same job (jobs.start(spec): snapped to their own footpaths); both see the same beacon;
 *                     whoever reaches a stop first advances it for both (jobs.advance); both are paid the tip as rep.
 *   2 Cops & robber   the host is the robber: TAG_STARS stars (one more a minute, up to 4) shown to everyone in the game;
 *                     whoever accepts is a cop. The cops are the police for the robber (games/playheat.js tag(): they see,
 *                     witness and bust: within 4 m for 3 s while the robber is slow). The robber wins by lasting TAG_S
 *                     s or by losing every cop's line of sight for TAG_LOS_S s; the cops win with a bust.
 *   3 Ghost race      pick a route you have a ghost on; once they accept the host's ghost goes to them and theirs comes back (games/playraces.js ghostRaw /
 *                     loadGhost) and race them on your own; each side's best time shows to the other.
 *
 * Over the Arena (the page's hq presence, ui/app/22-hq.js hqNetSend, only where the Arena lists "cityplay"; checked
 * again by backend/src/valley/hq.rs and on receipt here, readNet). No transcript, session, path or name data:
 *   pk  the game, 1 | 2 | 3                                  (with any of the below; alone: hosting, nobody yet)
 *   pi  the user id you invite (a host only)                 pj  the host whose game you accepted (never with pi)
 *   pq  up to PQ_MAX whole numbers, by game (map points in decimetres):
 *        1 host [job 1 taxi | 2 delivery | 3 van, step, from x, z, stop x, z (1-4 stops)]; partner [job, step]
 *        2 robber [phase 0 waiting | 1 on | 2 robber won | 3 cops won, stars 0-5, seconds left]; cops send none
 *        3 [route hash (24 bits of the route id), best time in centiseconds or 0]
 * and one directed frame, {type: "ghost", to, r, g, t} (the route id, the encoded ghost, at most GHOST_CHARS, and its
 * time in centiseconds), relayed by the Arena to that one player's sockets in the same hq room, never stored; it is
 * sent only to someone in a ghost race with you and taken here only from them (onGhost).
 *
 * Pure (node-tested, tests/test_play_arena.py): HQV.playArena = {CAP, GAMES, NAMES, writeNet, readNet, jobToPq,
 *   pqToJob, ghostOk, routeHash, tagJudge, ...}; HQV.playArena.net() (the presence fields now) and onGhost(m) for the page.
 * Rep from these games is ctx.store's (this computer only), as the jobs' and the police's. */
(function(){
"use strict";
var root = typeof window !== "undefined" ? window : globalThis;
var HQV = root.HQV = root.HQV || {};

var CAP = "cityplay";
var GAMES = {coop: 1, tag: 2, ghost: 3};
var NAMES = {1: "Co-op delivery", 2: "Cops & robber", 3: "Ghost race"};
var JOB_CODE = {taxi: 1, delivery: 2, van: 3}, JOB_KIND = [null, "taxi", "delivery", "van"];
var UID_RE = /^[A-Za-z0-9_-]{1,64}$/;
var ROUTE_RE = /^[A-Za-z0-9:_-]{1,40}$/;
var GHOST_RE = /^g1:[0-9a-z,-]*$/;
var PQ_MAX = 12, PQ_ABS = 16777216;   // whole numbers, |n| <= 2^24 (the Arena checks the same)
var XZ_DM = 10240;                    // the map's half width in decimetres (the Arena's XZ_MAX_CM)
var GHOST_CHARS = 12000;              // an encoded ghost's length at most (about five minutes)
var T_CS = 360000;                    // a race time at most, centiseconds (an hour)
var INVITE_R = 60;                    // m: whom you may invite
var INVITE_S = 60;                    // s an invitation stands
var LINGER_S = 6;                     // s a finished game's result stays in presence, so the others see it
var TAG_S = 180, TAG_LOS_S = 30, TAG_STARS = 2, TAG_STAR_EVERY = 60, TAG_STAR_MAX = 4, TAG_EMPTY_S = 10, TAG_PING_S = 10;
var TAG_WIN_REP = 5, TAG_COP_REP = 3;
var HUD = "arena", BEACON = "arena";

function num(v, d){ return typeof v === "number" && isFinite(v) ? v : d; }
function isInt(v){ return typeof v === "number" && isFinite(v) && Math.floor(v) === v; }
function hashStr(s){ var h = 2166136261 >>> 0; s = String(s == null ? "" : s); for(var i = 0; i < s.length; i++){ h ^= s.charCodeAt(i); h = Math.imul(h, 16777619) >>> 0; } return h >>> 0; }
function routeHash(id){ return hashStr(String(id || "")) & 0xffffff; }
function dm(v){ return Math.max(-XZ_DM, Math.min(XZ_DM, Math.round(num(+v, 0)*10))); }
function fmtT(s){ s = Math.max(0, Math.ceil(num(s, 0))); var m = Math.floor(s/60), r = s % 60; return m + ":" + (r < 10 ? "0" : "") + r; }
function fmtCs(cs){ var t = Math.max(0, num(cs, 0))/100, m = Math.floor(t/60), s = t - m*60, ss = s.toFixed(1); return m + ":" + (s < 10 ? "0" : "") + ss; }
function stars(n){ var t = ""; for(var i = 0; i < 5; i++) t += i < n ? "★" : "☆"; return t; }
function name(p){ var n = p && typeof p.n === "string" ? p.n.replace(/[\u0000-\u001f\u007f]/g, "").slice(0, 24) : ""; return n || "Someone"; }

/* ---------- the wire (pure) ---------- */
function intsOk(a, lo, hi){ return Array.isArray(a) && a.every(function(v){ return isInt(v) && v >= lo && v <= hi; }); }
// a game's own pq shape (kind k): true when it is one this page would send
function pqOk(k, q){
  if(!Array.isArray(q)) return false;
  if(k === 1){
    if(q.length === 2) return intsOk([q[0]], 1, 3) && intsOk([q[1]], 0, 5);
    return q.length >= 6 && q.length <= PQ_MAX && q.length % 2 === 0 && intsOk([q[0]], 1, 3) && intsOk([q[1]], 0, 5) && intsOk(q.slice(2), -XZ_DM, XZ_DM);
  }
  if(k === 2) return q.length === 3 && intsOk([q[0]], 0, 3) && intsOk([q[1]], 0, 5) && intsOk([q[2]], 0, TAG_S);
  if(k === 3) return q.length === 2 && intsOk([q[0]], 0, 0xffffff) && intsOk([q[1]], 0, T_CS);
  return false;
}
// the presence fields to send, checked: {pk, pi?, pj?, pq?} or null (anything off and nothing goes)
function writeNet(o){
  if(!o || typeof o !== "object") return null;
  var k = o.pk;
  if(!isInt(k) || k < 1 || k > 3) return null;
  var out = {pk: k};
  if(o.pi != null){ if(typeof o.pi !== "string" || !UID_RE.test(o.pi)) return null; out.pi = o.pi; }
  if(o.pj != null){ if(typeof o.pj !== "string" || !UID_RE.test(o.pj)) return null; out.pj = o.pj; }
  if(out.pi && out.pj) return null;
  if(o.pq != null){ if(!pqOk(k, o.pq)) return null; out.pq = o.pq.slice(); }
  return out;
}
// someone's presence frame (as the Arena relays it) -> {pk, pi, pj, pq} or null; strict: one bad field and none of it
function readNet(p){
  if(!p || typeof p !== "object" || p.pk == null) return null;
  var k = p.pk;
  if(!isInt(k) || k < 1 || k > 3) return null;
  var pi = p.pi == null ? null : typeof p.pi === "string" && UID_RE.test(p.pi) ? p.pi : false;
  var pj = p.pj == null ? null : typeof p.pj === "string" && UID_RE.test(p.pj) ? p.pj : false;
  if(pi === false || pj === false || (pi && pj)) return null;
  var pq = p.pq == null ? null : pqOk(k, p.pq) ? p.pq.slice() : false;
  if(pq === false) return null;
  return {pk: k, pi: pi, pj: pj, pq: pq};
}
// a co-op job's places as pq (decimetres), and back
function jobToPq(spec, step){
  if(!spec || !JOB_CODE[spec.kind] || !spec.from || !Array.isArray(spec.stops) || !spec.stops.length) return null;
  var q = [JOB_CODE[spec.kind], Math.max(0, Math.min(5, num(step, num(spec.step, 0)) | 0)), dm(spec.from.x), dm(spec.from.z)];
  spec.stops.slice(0, 4).forEach(function(s){ q.push(dm(s && s.x), dm(s && s.z)); });
  return pqOk(1, q) ? q : null;
}
function pqToJob(q){
  if(!pqOk(1, q) || q.length < 6) return null;
  var stops = [];
  for(var i = 4; i + 1 < q.length; i += 2) stops.push({x: q[i]/10, z: q[i + 1]/10});
  return {kind: JOB_KIND[q[0]], step: q[1], from: {x: q[2]/10, z: q[3]/10}, stops: stops};
}
// a shared ghost, as sent and as received: the route id, the encoded ghost, the time in centiseconds
function ghostOk(r, g, t){
  return typeof r === "string" && ROUTE_RE.test(r) && typeof g === "string" && g.length <= GHOST_CHARS && GHOST_RE.test(g) &&
         isInt(t) && t > 0 && t <= T_CS;
}
// Cops & robber: who has won, from the robber's clock (s), how long no cop has seen them (s) and a bust
function tagJudge(o){
  o = o || {};
  if(o.busted) return {phase: 3, why: "busted"};
  if(num(o.unseen, 0) >= TAG_LOS_S) return {phase: 2, why: "lost"};
  if(num(o.t, 0) >= TAG_S) return {phase: 2, why: "time"};
  return null;
}

/* ---------- the feature ---------- */
var LIVE = null;
function create(ctx){
  ctx = ctx || {};
  var api = ctx.api || {}, c = ctx.c || {};
  var S = {t: 0, me: {x: 0, z: 0}, speed: 0, host: null, guest: null, seen: {}, declined: {}, toastAt: {}, msg: "", msgT: 0, dead: false, last: null};
  var listeners = [];
  function F(id){ try { return ctx.feature ? ctx.feature(id) : null; } catch(e){ return null; } }
  function meId(){ try { var u = api.me ? api.me() : null; return typeof u === "string" && UID_RE.test(u) ? u : null; } catch(e){ return null; } }
  function can(){ try { return !api.netCan || !!api.netCan(CAP); } catch(e){ return false; } }
  function say(t){ if(ctx.say) try { ctx.say(t); } catch(e){} }
  function toast(t){ try { if(api.toast) api.toast(t); else say(t); } catch(e){} }
  function announce(t){ try { if(api.announce) api.announce(t); } catch(e){} }
  function changed(){ listeners.slice().forEach(function(fn){ try { fn(); } catch(e){} }); }
  function rep(n){ if(!ctx.store) return; var r = Math.max(0, num(+ctx.store.get("rep", 0), 0)); ctx.store.set("rep", Math.round(r + n)); }
  function hud(t, col){ if(!ctx.hud) return; if(t) ctx.hud.set(HUD, t, col ? {colour: col} : null); else ctx.hud.clear(HUD); }
  function note(t, secs){ S.msg = t; S.msgT = S.t + (secs || 5); say(t); }
  // the other players in this world: [{u, n, x, z, play}] (play: readNet's, checked by games/hq3d.js on receipt)
  function players(){
    var L = [];
    try { L = c.players ? c.players() || [] : []; } catch(e){ L = []; }
    return L.filter(function(p){ return p && typeof p.u === "string" && UID_RE.test(p.u) && isFinite(+p.x) && isFinite(+p.z); });
  }
  function byId(L, u){ for(var i = 0; i < L.length; i++) if(L[i].u === u) return L[i]; return null; }
  function near(p){ return Math.hypot(+p.x - S.me.x, +p.z - S.me.z) <= INVITE_R; }

  /* ---- hosting ---- */
  function busy(){ return !!(S.host || S.guest); }
  function invite(uid, kind, o){
    o = o || {};
    if(S.dead || !can()) return {ok: false, reason: "off"};
    if(S.guest) return {ok: false, reason: "busy"};
    if(typeof uid !== "string" || !UID_RE.test(uid) || uid === meId()) return {ok: false, reason: "who"};
    var p = byId(players(), uid);
    if(!p || !near(p)) return {ok: false, reason: "far"};
    if(S.host && S.host.kind !== kind) return {ok: false, reason: "busy"};
    if(S.host && S.host.final) return {ok: false, reason: "busy"};
    if(!S.host){
      var H = {kind: kind, members: [], invite: null, inviteT: 0, t: 0, phase: 0, final: null, sent: {}, names: {}};
      if(kind === 1){
        var J = F("jobs"), sp = J && J.spec ? J.spec() : null;
        if(!sp) return {ok: false, reason: "nojob"};
        if(/^coop:/.test(String(sp.id))) return {ok: false, reason: "nojob"};
        if(!jobToPq(sp, sp.step)) return {ok: false, reason: "nojob"};
        H.n = sp.stops.length;
      } else if(kind === 2){
        if(!F("heat") || !F("heat").tag) return {ok: false, reason: "noheat"};
      } else if(kind === 3){
        var R = F("races"), rid = o.route;
        if(!R || typeof rid !== "string" || !ROUTE_RE.test(rid) || !R.routes().some(function(r){ return r.id === rid; }) || !(R.ghostRaw && R.ghostRaw(rid))) return {ok: false, reason: "route"};
        H.route = rid; H.theirs = {};
      } else return {ok: false, reason: "kind"};
      S.host = H;
    }
    S.host.invite = uid; S.host.inviteT = S.t;
    toast("🎮 " + NAMES[kind] + ": invited " + name(p) + ".");
    changed();
    return {ok: true};
  }
  function endHost(why){
    var H = S.host; if(!H) return;
    if(H.kind === 2){ var Ht = F("heat"); if(Ht && Ht.tag){ Ht.tag(null); if(H.phase === 1) Ht.clear(); } }
    if(ctx.beaconOff) ctx.beaconOff(BEACON);
    S.host = null;
    if(why) note(why);
    hud("");
    changed();
  }
  function hostStep(dt, L){
    var H = S.host, me = meId();
    if(H.invite && (S.t - H.inviteT > INVITE_S || !byId(L, H.invite))){ H.invite = null; changed(); }
    // who has joined: their pj is you, in this game
    var mem = L.filter(function(p){ return p.play && p.play.pj === me && p.play.pk === H.kind; });
    var ids = mem.map(function(p){ return p.u; });
    ids.forEach(function(u){
      if(H.members.indexOf(u) < 0){
        H.members.push(u); H.names[u] = name(byId(L, u));
        if(H.invite === u) H.invite = null;
        toast("🎮 " + H.names[u] + " joined your " + NAMES[H.kind] + ".");
        changed();
      }
    });
    H.members = H.members.filter(function(u){
      if(ids.indexOf(u) >= 0) return true;
      if(!H.final) note(H.names[u] + " left your " + NAMES[H.kind] + ".");
      changed(); return false;
    });
    if(H.final){ if(S.t >= H.final.until) endHost(null); return; }
    if(H.kind === 1){
      var J = F("jobs"), sp = J && J.spec ? J.spec() : null;
      if(!sp){ endHost("Your co-op job is over."); return; }
      var top = sp.step;
      mem.forEach(function(p){ if(p.play.pq && p.play.pq.length === 2 && p.play.pq[1] > top) top = p.play.pq[1]; });
      if(top > sp.step && J.advance) J.advance(top);       // a partner made the drop: it counts for you (may finish it)
      if(S.host && !S.host.final) hud("Co-op · " + (H.members.length ? H.members.map(function(u){ return H.names[u]; }).join(", ") : "waiting for a partner"));
    } else if(H.kind === 2) tagHost(dt, L);
    else if(H.kind === 3) ghostHost(L, mem);
  }
  /* Cops & robber, the robber's side: the clock, the stars, the judge */
  function tagHost(dt, L){
    var H = S.host, Ht = F("heat");
    if(!Ht || !Ht.tag){ endHost("Cops & robber ended."); return; }
    var cops = H.members.map(function(u){ return byId(L, u); }).filter(Boolean).map(function(p){ return {x: +p.x, z: +p.z}; });
    if(H.phase === 0){
      if(!cops.length){ hud("Cops & robber · waiting for a cop"); return; }
      H.phase = 1; H.t = 0; H.nextStar = TAG_STAR_EVERY; H.emptyT = 0; H.busted = false;
      Ht.clear(); Ht.tag({cops: cops}); Ht.add(TAG_STARS, "Cops & robber");
      toast("🚨 Cops & robber: run! Last " + fmtT(TAG_S) + " or lose them for " + TAG_LOS_S + " s.");
      changed();
    }
    Ht.tag({cops: cops});
    H.t += dt;
    if(Ht.stars() < 1) Ht.add(1, "Cops & robber");
    if(H.t >= H.nextStar){ H.nextStar += TAG_STAR_EVERY; if(Ht.stars() < TAG_STAR_MAX) Ht.add(1, "Cops & robber"); }
    H.emptyT = cops.length ? 0 : H.emptyT + dt;
    if(H.emptyT >= TAG_EMPTY_S){ endHost("The cops left: Cops & robber is over."); return; }
    var v = tagJudge({t: H.t, unseen: Ht.unseen ? Ht.unseen() : 0, busted: H.busted});
    if(v){
      H.phase = v.phase; H.why = v.why; H.final = {until: S.t + LINGER_S};
      Ht.tag(null); if(v.phase === 2) Ht.clear();
      if(v.phase === 2){ rep(TAG_WIN_REP); toast("🏁 You got away (" + (v.why === "lost" ? "out of sight " + TAG_LOS_S + " s" : "you lasted " + fmtT(TAG_S)) + "). City rep +" + TAG_WIN_REP + "."); }
      else toast("🚓 Busted: the cops win.");
      hud(v.phase === 2 ? "Cops & robber · you got away" : "Cops & robber · busted");
      changed();
      return;
    }
    var un = Ht.unseen ? Ht.unseen() : 0;
    hud("Robber " + stars(Ht.stars()) + " · " + fmtT(TAG_S - H.t) + (un >= 5 ? " · out of sight " + Math.floor(un) + "/" + TAG_LOS_S + " s" : ""), "#ffd040");
  }
  /* Ghost race, both sides: send your ghost once to each new rival */
  function sendGhost(to, route){
    var R = F("races"); if(!R || !api.playGhost) return false;
    var g = R.ghostRaw ? R.ghostRaw(route) : null, b = R.best ? R.best(route) : null, t = b ? Math.round(num(b.t, 0)*100) : 0;
    if(!g || !(t > 0)) return false;
    if(!ghostOk(route, g, t)){ note("Your ghost on that route is too long to share."); return false; }
    try { return !!api.playGhost(to, route, g, t); } catch(e){ return false; }
  }
  function ghostHost(L, mem){
    var H = S.host;
    mem.forEach(function(p){
      if(!H.sent[p.u]){ H.sent[p.u] = true; sendGhost(p.u, H.route); }
      var q = p.play.pq;
      if(q && q[0] === routeHash(H.route) && q[1] > 0 && H.theirs[p.u] !== q[1]){
        if(H.theirs[p.u] != null) toast("🏁 " + name(p) + " set " + fmtCs(q[1]) + " on your ghost race.");
        H.theirs[p.u] = q[1]; changed();
      }
    });
  }
  function myBestCs(route){ var R = F("races"), b = R && R.best ? R.best(route) : null; return b ? Math.max(0, Math.min(T_CS, Math.round(num(b.t, 0)*100))) : 0; }

  /* ---- joining ---- */
  function invites(){
    var me = meId(); if(!me || !can()) return [];
    return players().filter(function(p){ return p.play && p.play.pi === me && !p.play.pj && !S.declined[p.u + ":" + p.play.pk]; })
      .map(function(p){
        var o = {u: p.u, n: name(p), kind: p.play.pk, game: NAMES[p.play.pk], text: NAMES[p.play.pk]};
        if(p.play.pk === 1){ var j = pqToJob(p.play.pq); o.ok = !!j; if(j) o.text += ": " + j.kind + ", " + j.stops.length + (j.stops.length === 1 ? " drop" : " drops"); }
        else if(p.play.pk === 3){
          var R = F("races"), h = p.play.pq ? p.play.pq[0] : -1, r = R ? R.routes().filter(function(x){ return routeHash(x.id) === h; })[0] : null;
          o.ok = !!r; o.route = r ? r.id : null; if(r) o.text += ": " + r.name;
        } else o.ok = !!F("heat");
        return o;
      });
  }
  function accept(uid){
    if(S.dead || !can()) return {ok: false, reason: "off"};
    if(busy()) return {ok: false, reason: "busy"};
    var inv = invites().filter(function(i){ return i.u === uid; })[0];
    if(!inv) return {ok: false, reason: "gone"};
    if(!inv.ok) return {ok: false, reason: inv.kind === 3 ? "route" : "place"};
    var p = byId(players(), uid), G = {kind: inv.kind, host: uid, hostName: inv.n, t: 0, final: null, pingT: 0, phase: 0};
    if(inv.kind === 1){
      var J = F("jobs"), j = pqToJob(p.play.pq);
      if(!J || !j) return {ok: false, reason: "place"};
      if(J.active && J.active()) return {ok: false, reason: "busy"};
      var r = J.start({kind: j.kind, from: j.from, stops: j.stops, id: "coop:" + uid});
      if(!r || !r.ok) return {ok: false, reason: (r && r.reason) || "place"};
      G.n = j.stops.length;
      if(j.step > 0 && J.advance) J.advance(j.step);
    } else if(inv.kind === 3){
      G.route = inv.route; G.theirs = 0;
      var R = F("races"); if(R && R.setRoute) R.setRoute(inv.route);
    }
    S.guest = G;
    toast("🎮 You joined " + inv.n + "'s " + NAMES[inv.kind] + (inv.kind === 2 ? ": you're a cop. Stay within 4 m of them for 3 s while they're slow." : "."));
    changed();
    return {ok: true};
  }
  function decline(uid){
    var inv = invites().filter(function(i){ return i.u === uid; })[0];
    if(!inv) return false;
    S.declined[uid + ":" + inv.kind] = true; changed(); return true;
  }
  function endGuest(why){
    var G = S.guest; if(!G) return;
    if(G.kind === 1 && !G.final){ var J = F("jobs"), sp = J && J.spec ? J.spec() : null; if(sp && String(sp.id) === "coop:" + G.host && why === "leave") J.cancel(); }
    if(ctx.beaconOff) ctx.beaconOff(BEACON);
    S.guest = null;
    if(why && why !== "leave") note(why);
    hud("");
    changed();
  }
  function guestStep(dt, L){
    var G = S.guest, me = meId(), H = byId(L, G.host);
    var ok = H && H.play && H.play.pk === G.kind && !H.play.pj;
    if(G.final){ if(S.t >= G.final.until || !ok) endGuest(null); return; }
    if(!ok){
      endGuest(G.kind === 1 ? G.hostName + " left: the job is yours alone now." : G.hostName + " ended the " + NAMES[G.kind] + ".");
      return;
    }
    G.t += dt;
    if(G.kind === 1){
      var J = F("jobs"), sp = J && J.spec ? J.spec() : null, q = H.play.pq;
      if(!sp || String(sp.id) !== "coop:" + G.host){ endGuest("Your co-op job is over."); return; }
      if(q && q.length >= 2 && q[1] > sp.step && J.advance) J.advance(q[1]);
      if(S.guest && !S.guest.final) hud("Co-op with " + G.hostName);
    } else if(G.kind === 2){
      var q2 = H.play.pq, ph = q2 ? q2[0] : 0;
      if(ph >= 2 && !G.final){
        G.final = {until: S.t + LINGER_S};
        if(ph === 3){ rep(TAG_COP_REP); toast("🚓 You caught " + G.hostName + "! City rep +" + TAG_COP_REP + "."); }
        else toast("🏁 " + G.hostName + " got away.");
        if(ctx.beaconOff) ctx.beaconOff(BEACON);
        hud(ph === 3 ? "Cops & robber · busted!" : "Cops & robber · they got away");
        changed();
        return;
      }
      var d = Math.hypot(+H.x - S.me.x, +H.z - S.me.z);
      // where the robber is, every TAG_PING_S s (a cop has to look for them in between)
      if(ph === 1 && S.t >= G.pingT){ G.pingT = S.t + TAG_PING_S; if(ctx.beacon) ctx.beacon(BEACON, +H.x, +H.z, 0xff5050); }
      hud(ph === 1 ? "Cop · robber " + stars(q2[1]) + " · " + fmtT(q2[2]) + " · " + Math.round(d) + " m" : "Cop · waiting for " + G.hostName, "#9fd0ff");
    } else if(G.kind === 3){
      var q3 = H.play.pq;
      if(q3 && q3[0] === routeHash(G.route) && q3[1] > 0 && q3[1] !== G.theirs){
        if(G.theirs) toast("🏁 " + G.hostName + " set " + fmtCs(q3[1]) + " on your ghost race.");
        G.theirs = q3[1]; changed();
      }
    }
  }

  /* ---- presence out ---- */
  function net(){
    if(S.dead || !can()) return null;
    var H = S.host, G = S.guest, o = null;
    if(H){
      o = {pk: H.kind};
      if(H.invite && !H.final) o.pi = H.invite;
      if(H.kind === 1){
        var J = F("jobs"), sp = J && J.spec ? J.spec() : S.last;
        if(sp){ S.last = sp; o.pq = jobToPq(sp, H.final ? H.n + 1 : sp.step); }
      } else if(H.kind === 2){
        var Ht = F("heat");
        o.pq = [H.phase, H.phase === 1 && Ht ? Math.max(0, Math.min(5, Ht.stars() | 0)) : 0, Math.max(0, Math.min(TAG_S, Math.ceil(TAG_S - (H.t || 0)))) | 0];
      } else if(H.kind === 3) o.pq = [routeHash(H.route), myBestCs(H.route)];
    } else if(G){
      o = {pk: G.kind, pj: G.host};
      if(G.kind === 1){
        var J2 = F("jobs"), sp2 = J2 && J2.spec ? J2.spec() : null;
        o.pq = [JOB_CODE[(sp2 && sp2.kind) || G.jobKind] || 1, G.final ? G.n + 1 : sp2 ? sp2.step : 0];
      } else if(G.kind === 3) o.pq = [routeHash(G.route), myBestCs(G.route)];
    }
    return writeNet(o);
  }
  // a ghost from someone (the page hands in {type: "ghost", from: {userId, displayName?}, r, g, t})
  function onGhost(m){
    if(!m || typeof m !== "object" || !m.from || typeof m.from.userId !== "string" || !UID_RE.test(m.from.userId)) return false;
    if(!ghostOk(m.r, m.g, m.t)) return false;
    var u = m.from.userId, route = null, label = null;
    if(S.host && S.host.kind === 3 && S.host.members.indexOf(u) >= 0){ route = S.host.route; label = S.host.names[u]; }
    else if(S.guest && S.guest.kind === 3 && S.guest.host === u){ route = S.guest.route; label = S.guest.hostName; }
    if(!route || m.r !== route) return false;            // only from someone in a ghost race with you, on its route
    var R = F("races");
    if(!R || !R.loadGhost || !R.loadGhost(route, m.g, label || "a rival")) return false;
    toast("👻 " + (label || "Your rival") + "'s ghost (" + fmtCs(m.t) + ") is loaded: race it.");
    // the host sends first (once they see you joined); your own goes back once, in reply
    if(S.guest && S.guest.kind === 3 && !S.guest.replied){ S.guest.replied = true; sendGhost(u, route); }
    changed();
    return true;
  }

  var feat = {
    update: function(dt, f){
      if(S.dead) return;
      f = f || {}; dt = Math.max(0, Math.min(0.25, num(dt, 0)));
      S.t += dt;
      if(f.me) S.me = {x: num(f.me.x, S.me.x), z: num(f.me.z, S.me.z)};
      if(!can()){ if(S.host) endHost(null); if(S.guest) endGuest(null); return; }
      var L = players();
      if(S.host) hostStep(dt, L);
      if(S.guest) guestStep(dt, L);
      // invitations to you: a toast once each
      invites().forEach(function(i){
        var k = i.u + ":" + i.kind;
        if(!S.toastAt[k] || S.t - S.toastAt[k] > INVITE_S){ S.toastAt[k] = S.t; toast("🎮 " + i.n + " invites you to " + i.text + ". Accept in the phone's Arena play app."); changed(); }
      });
      if(!S.host && !S.guest){
        if(S.msg && S.t < S.msgT) hud(S.msg); else if(S.msg){ S.msg = ""; hud(""); }
      }
    },
    on: function(kind, d){
      d = d || {};
      if(kind === "busted" && d.tag && S.host && S.host.kind === 2 && S.host.phase === 1) S.host.busted = true;
      if(kind === "job" && S.host && S.host.kind === 1 && !S.host.final){
        if(d.state === "done"){ S.host.final = {until: S.t + LINGER_S}; hud("Co-op job done"); changed(); }
        else if(d.state === "fail") endHost("Your co-op job ended.");
      }
      if(kind === "job" && S.guest && S.guest.kind === 1 && !S.guest.final && String(d.id) === "coop:" + S.guest.host){
        if(d.state === "start") S.guest.jobKind = d.kind;
        else if(d.state === "done"){ S.guest.final = {until: S.t + LINGER_S}; hud("Co-op job done"); changed(); }
        else if(d.state === "fail") endGuest("Your co-op job ended.");
      }
    },
    // for the phone app and tests
    can: can,
    nearby: function(){ var me = meId(); return players().filter(function(p){ return p.u !== me && near(p); }).map(function(p){ return {u: p.u, n: name(p), d: Math.round(Math.hypot(+p.x - S.me.x, +p.z - S.me.z)), busy: !!(p.play && (p.play.pj || p.play.pk && !p.play.pi))}; }); },
    invites: invites,
    invite: invite, accept: accept, decline: decline,
    leave: function(){ if(S.host){ endHost("You left the " + NAMES[S.host.kind] + "."); return true; } if(S.guest){ var k = S.guest.kind; endGuest("leave"); note("You left the " + NAMES[k] + "."); return true; } return false; },
    state: function(){
      var H = S.host, G = S.guest;
      if(H) return {role: "host", kind: H.kind, game: NAMES[H.kind], invite: H.invite, members: H.members.map(function(u){ return {u: u, n: H.names[u], best: H.theirs ? H.theirs[u] || 0 : 0}; }),
                    phase: H.phase, t: H.t, why: H.why || null, route: H.route || null, done: !!H.final};
      if(G) return {role: "guest", kind: G.kind, game: NAMES[G.kind], host: G.host, hostName: G.hostName, route: G.route || null, best: G.theirs || 0, done: !!G.final};
      return null;
    },
    ghostRoutes: function(){ var R = F("races"); if(!R) return []; return R.routes().filter(function(r){ return R.ghostRaw && R.ghostRaw(r.id); }).map(function(r){ return {id: r.id, name: r.name, best: r.best}; }); },
    hasJob: function(){ var J = F("jobs"), sp = J && J.spec ? J.spec() : null; return !!sp && !/^coop:/.test(String(sp.id)); },
    net: net, onGhost: onGhost,
    onChange: function(fn){ if(typeof fn === "function") listeners.push(fn); return function(){ listeners = listeners.filter(function(g){ return g !== fn; }); }; },
    dispose: function(){
      if(S.dead) return;
      if(S.host) endHost(null);
      if(S.guest) endGuest(null);
      S.dead = true; listeners = [];
      if(ctx.hud) ctx.hud.clear(HUD);
      if(LIVE === feat) LIVE = null;
    }
  };
  LIVE = feat;
  return feat;
}
if(HQV.cityPlay) HQV.cityPlay.register({id: "arena", order: 50, create: create});

function live(){ var L = HQV.cityPlay && HQV.cityPlay.live && HQV.cityPlay.live(), f = L && L.feature ? L.feature("arena") : null; return f || LIVE; }
var API = HQV.playArena = {CAP: CAP, GAMES: GAMES, NAMES: NAMES, PQ_MAX: PQ_MAX, PQ_ABS: PQ_ABS, XZ_DM: XZ_DM, GHOST_CHARS: GHOST_CHARS, T_CS: T_CS,
  INVITE_R: INVITE_R, TAG_S: TAG_S, TAG_LOS_S: TAG_LOS_S, UID_RE: UID_RE, ROUTE_RE: ROUTE_RE, GHOST_RE: GHOST_RE,
  writeNet: writeNet, readNet: readNet, pqOk: pqOk, jobToPq: jobToPq, pqToJob: pqToJob, ghostOk: ghostOk, routeHash: routeHash, tagJudge: tagJudge,
  create: create, live: live,
  // the page's presence fields now (ui/app/22-hq.js, only where the Arena lists "cityplay"), and a ghost frame in
  net: function(){ var f = live(); return f ? f.net() : null; },
  onGhost: function(m){ var f = live(); return f ? f.onGhost(m) : false; }};

/* ---------- the phone's Arena play app ---------- */
var GLYPH = "M6 12h4M8 10v4M15 11h.01M18 13h.01M3 9a4 4 0 014-4h10a4 4 0 014 4v6a4 4 0 01-4 4H7a4 4 0 01-4-4z";
var WHY = {busy: "Finish or leave your game first", far: "They're too far away", nojob: "Start a job first (Jobs app)", route: "Pick a route you have a time on",
           noheat: "The police aren't in this City", off: "This Arena doesn't run City play games", gone: "That invitation has gone", place: "That job's places aren't reachable here", who: "Pick someone"};
function render(el, host, nav){
  var doc = root.document;
  function mk(tag, cls, parent, text){ var n = doc.createElement(tag); if(cls) n.className = cls; if(text != null) n.textContent = String(text); if(parent) parent.appendChild(n); return n; }
  function btn(parent, text, cls, fn, label){ var b = mk("button", "hp-btn" + (cls ? " " + cls : ""), parent, text); b.type = "button"; if(label) b.setAttribute("aria-label", label); b.addEventListener("click", fn); return b; }
  function announce(t){ try { if(host && host.announce) host.announce(t); } catch(e){} }
  var uid = "hpa-" + (Date.now() % 1e6), rootEl = mk("div", "hp-app", el), F = API.live();
  mk("p", "hp-muted", rootEl, "Play with people near you in this City: a shared job, Cops & robber, or a race against each other's ghosts. Nothing starts until they accept.");
  if(!F){ mk("p", "hp-muted", rootEl, "Arena play works when the City is loaded."); return {dispose: function(){}}; }
  if(!F.can()){ mk("p", "hp-muted", rootEl, "This Arena doesn't run City play games yet."); return {dispose: function(){}}; }
  var cur = mk("section", "hp-card", rootEl), ch = mk("h3", "", cur, "Your game"); ch.id = uid + "-cur"; cur.setAttribute("aria-labelledby", ch.id);
  var curText = mk("p", "", cur), curSub = mk("p", "hp-legsub", cur);
  btn(cur, "Leave game", "hp-danger", function(){ if(F.leave()) announce("You left the game"); draw(true); });
  var invS = mk("section", "", rootEl), ih = mk("h3", "", invS, "Invitations"); ih.id = uid + "-inv"; invS.setAttribute("aria-labelledby", ih.id);
  var invUl = mk("ul", "hp-list", invS); invUl.setAttribute("aria-labelledby", ih.id);
  var nS = mk("section", "", rootEl), nh = mk("h3", "", nS, "People near you"); nh.id = uid + "-near"; nS.setAttribute("aria-labelledby", nh.id);
  var lab = mk("label", "hp-legsub", nS, "Route for a ghost race "), sel = mk("select", "hp-select", lab); sel.id = uid + "-route";
  var nUl = mk("ul", "hp-list", nS); nUl.setAttribute("aria-labelledby", nh.id);
  mk("p", "hp-hint", nS, "Within " + INVITE_R + " m. Your game's places and positions go to the players in it through the Arena; nothing about your sessions does.");
  var sig = "";
  function say(r, ok){ announce(r.ok ? ok : WHY[r.reason] || "That didn't work"); }
  function drawSel(){
    var keep = sel.value, R = F.ghostRoutes();
    while(sel.firstChild) sel.removeChild(sel.firstChild);
    if(!R.length){ var o0 = mk("option", "", sel, "No ghost yet: finish a race first"); o0.value = ""; }
    R.forEach(function(r){ var o = mk("option", "", sel, r.name + (r.best != null ? " · " + fmtCs(Math.round(r.best*100)) : "")); o.value = r.id; });
    if(keep && R.some(function(r){ return r.id === keep; })) sel.value = keep;
  }
  function draw(force){
    var st = F.state(), inv = F.invites(), nb = F.nearby(), gr = F.ghostRoutes();
    var s2 = JSON.stringify([st, inv.map(function(i){ return [i.u, i.kind, i.ok]; }), nb.map(function(p){ return [p.u, p.busy]; }), gr.map(function(r){ return r.id + r.best; }), F.hasJob()]);
    // the live line (time, distance) every tick; the lists only when they change
    cur.hidden = !st;
    if(st){
      curText.textContent = st.game + (st.role === "host" ? (st.kind === 2 ? " · you're the robber" : " · you host") : " · with " + st.hostName + (st.kind === 2 ? " · you're a cop" : ""));
      var bits = [];
      if(st.role === "host"){
        if(st.members.length) bits.push((st.kind === 2 ? "Cops: " : "With ") + st.members.map(function(m){ return m.n + (m.best ? " (" + fmtCs(m.best) + ")" : ""); }).join(", "));
        if(st.invite) bits.push("Invitation open");
        if(st.kind === 2 && st.phase === 1) bits.push(fmtT(TAG_S - st.t) + " left");
      } else if(st.kind === 3 && st.best) bits.push(st.hostName + "'s best " + fmtCs(st.best));
      if(st.done) bits.push("Finished");
      curSub.textContent = bits.join(" · ");
    }
    if(!force && s2 === sig) return;
    sig = s2;
    drawSel();
    while(invUl.firstChild) invUl.removeChild(invUl.firstChild);
    if(!inv.length) mk("li", "hp-muted", invUl, "No invitations.");
    inv.forEach(function(i){
      var li = mk("li", "hp-achrow", invUl);
      mk("b", "", li, i.n); mk("span", "hp-legsub", li, " " + i.text);
      var a = btn(li, "Accept", "hp-primary", function(){ var r = F.accept(i.u); say(r, "You joined " + i.n + "'s " + i.game); if(r.ok && nav && nav.close) nav.close(); draw(true); }, "Accept " + i.n + "'s " + i.game);
      a.disabled = !!st || !i.ok;
      btn(li, "Decline", "", function(){ F.decline(i.u); announce("Declined"); draw(true); }, "Decline " + i.n + "'s " + i.game);
    });
    while(nUl.firstChild) nUl.removeChild(nUl.firstChild);
    if(!nb.length) mk("li", "hp-muted", nUl, "Nobody within " + INVITE_R + " m.");
    nb.forEach(function(p){
      var li = mk("li", "hp-achrow", nUl);
      mk("b", "", li, p.n); mk("span", "hp-legsub", li, " " + p.d + " m" + (p.busy ? " · in a game" : ""));
      var guest = st && st.role === "guest", hostK = st && st.role === "host" ? st.kind : 0;
      var b1 = btn(li, "Co-op job", "", function(){ say(F.invite(p.u, 1), "Invited " + p.n + " to share your job"); draw(true); }, "Invite " + p.n + " to a co-op delivery");
      b1.disabled = guest || p.busy || (hostK && hostK !== 1) || !F.hasJob() && hostK !== 1;
      var b2 = btn(li, "Cops & robber", "", function(){ say(F.invite(p.u, 2), "Invited " + p.n + " to chase you"); draw(true); }, "Invite " + p.n + " to Cops and robber: you're the robber");
      b2.disabled = guest || p.busy || (hostK && hostK !== 2);
      var b3 = btn(li, "Ghost race", "", function(){ say(F.invite(p.u, 3, {route: sel.value}), "Invited " + p.n + " to a ghost race"); draw(true); }, "Invite " + p.n + " to race ghosts on the chosen route");
      b3.disabled = guest || p.busy || (hostK && hostK !== 3) || !gr.length;
    });
  }
  draw(true);
  var off = F.onChange(function(){ draw(false); });
  return {tick: function(){ draw(false); }, dispose: function(){ off(); }};
}
(HQV.hqPhoneQueue = HQV.hqPhoneQueue || []).push({id: "arena", name: "Arena play", order: 41, glyph: GLYPH, dock: false, needsCity: true, render: render});
API.render = render;
})();
