/* Claude HQ: the phone's Claude Cabs, Vehicles and Dealership apps (docs/plans/transport-revamp.md 3.12 apps 4-6,
 * part `cabs`). They register in the phone's queue (5.8), so load order does not matter:
 *   (HQV.hqPhoneQueue = HQV.hqPhoneQueue || []).push({id, name, order, glyph, dock, needsCity, render(el, host, nav), badge(host)})
 * The phone shell (games/hqphone.js, part `phone`) draws the frame, the header with Back and the home grid; Esc goes
 * back there. These apps use host (5.8): host.cabs (HQV.hqCabs.mount's controller), host.heli (HQV.hqHeliCall.mount's),
 * host.vehicles {list(), call(key), state()}, host.dealer {mount(el, onDone)}, host.places(), host.ride, host.me(),
 * host.announce, host.calm(), host.sfx(name), host.atJetty?().
 *   claude-cabs  Ride: a destination search over host.places() and the transit stations, class chips Bike · Go · Cab ·
 *                XL · Lux · Heli · Water taxi with an ETA (no price: everything is free, D4), Request / Cancel, the live
 *                state with its ETA and the driver's card, Skip ahead, a rating at the end. Drive (D5, score only): on /
 *                off, the offers with Accept, the live job, the score, rating and fares (kept on this device).
 *   vehicles     your vehicles with the call list's chips (HQV.hqCall.mountChips), Call, and Call a helicopter (a spot list)
 *   dealership   a 2 s ring with a dial tone (Calm: no animation), "Claude Motors, how can we help?", then the dealer
 *                catalogue (host.dealer.mount: hqDealer.mountPanel in remote mode); after a buy "Your new X is parked
 *                at level L, bay B. Call it?"
 * Live status goes to announce() (matched, the ETA every 30 s and at 1 min, arrived) only when host.cabs does not
 * announce itself (HQV.hqCabs.mount's controller does: announces = true). textContent only; roles and aria on every
 * control; roving tabindex in the tab list and the chips; nothing random; no network.
 */
(function(){
"use strict";
var root = typeof window !== "undefined" ? window : globalThis;
var HQV = root.HQV = root.HQV || {};

var CLS_KEY = "hq_cabs_cls";
var PHASE_TEXT = {matching: "Finding you a driver…", coming: "On the way to you", here: "Your cab is here: press E to get in",
                  riding: "On your way", done: "You've arrived", cancelled: "Cancelled", landing: "Landing", leaving: "Leaving"};
var DRV_TEXT = {off: "Off duty", idle: "Waiting for a request", pickup: "Drive to the beacon and stop beside your passenger",
                boarding: "Your passenger is getting in", trip: "Drive to the drop-off", alighting: "Your passenger is getting out"};

function fn(f, d){ return typeof f === "function" ? f : function(){ return d; }; }
function num(v, d){ v = +v; return isFinite(v) ? v : d; }
function lsGet(k){ try { return root.localStorage ? root.localStorage.getItem(k) : null; } catch(e){ return null; } }
function lsSet(k, v){ try { if(root.localStorage) root.localStorage.setItem(k, v); } catch(e){} }
function etaText(s){ s = Math.max(0, Math.round(num(s, 0))); return s < 60 ? s + " s" : Math.round(s/60) + " min"; }
function distText(m){ m = Math.max(0, num(m, 0)); return m < 1000 ? Math.round(m/10)*10 + " m" : (m/1000).toFixed(1) + " km"; }
function fold(t){ t = String(t == null ? "" : t).toLowerCase(); return t.normalize ? t.normalize("NFD").replace(/[̀-ͯ]/g, "") : t; }

function dom(){
  var doc = root.document;
  function mk(tag, cls, parent, text){ var n = doc.createElement(tag); if(cls) n.className = cls; if(text != null) n.textContent = String(text); if(parent) parent.appendChild(n); return n; }
  function btn(parent, text, cls, onClick, label){ var b = mk("button", cls || "pc-btn", parent, text); b.type = "button"; if(label) b.setAttribute("aria-label", label); if(onClick) b.addEventListener("click", onClick); return b; }
  function clear(n){ while(n && n.firstChild) n.removeChild(n.firstChild); }
  return {doc: doc, mk: mk, btn: btn, clear: clear};
}
// a roving-tabindex group of buttons (tabs or radios): arrows move and pick, Home / End
function roving(group, items, opts){
  opts = opts || {};
  group.addEventListener("keydown", function(e){
    var L = items(), i = -1, k = e.key, n = L.length;
    for(var j = 0; j < n; j++) if(L[j].getAttribute(opts.attr || "aria-checked") === "true") i = j;
    var to = k === "ArrowRight" || (opts.vertical && k === "ArrowDown") ? i + 1 : k === "ArrowLeft" || (opts.vertical && k === "ArrowUp") ? i - 1 : k === "Home" ? 0 : k === "End" ? n - 1 : null;
    if(to == null || !n) return;
    if(e.preventDefault) e.preventDefault();
    var b = L[(to + n) % n]; if(b.focus) b.focus(); b.click();
  });
}

// every place you can be taken to: host.places() and the transit stations (each service's stops), named, deduplicated
function destinations(host){
  var out = [], seen = {};
  function add(p){
    if(!p || !isFinite(+p.x) || !isFinite(+p.z)) return;
    var name = String(p.name || p.label || ""); if(!name) return;
    var k = fold(name) + "|" + Math.round(p.x/20) + "," + Math.round(p.z/20); if(seen[k]) return; seen[k] = 1;
    out.push({id: String(p.id || k), name: name, x: +p.x, z: +p.z, kind: String(p.kind || p.mode || "place")});
  }
  try { (fn(host.places, [])() || []).forEach(function(p){ add({id: p.id, name: p.name || p.label, x: p.door ? p.door.x : p.x, z: p.door ? p.door.z : p.z, kind: p.kind}); }); } catch(e){}
  try {
    var R = host.ride || HQV.hqRide, S = R && R.services ? R.services() : [];
    (S || []).forEach(function(s){ (s && s.stops ? s.stops() || [] : []).forEach(function(st){ if(st.kind === "station" || st.kind === "pier" || s.mode !== "bus") add({id: st.id, name: st.name, x: st.x, z: st.z, kind: st.mode || s.mode}); }); });
  } catch(e2){}
  return out;
}
function searchDest(list, q, me, n){
  var words = fold(q).split(/\s+/).filter(Boolean), mx = num(me && me.x, 0), mz = num(me && me.z, 0);
  return list.filter(function(p){ var h = fold(p.name + " " + p.kind); return words.every(function(w){ return h.indexOf(w) >= 0; }); })
    .map(function(p){ return {p: p, d: Math.hypot(p.x - mx, p.z - mz)}; })
    .sort(function(a, b){ return a.d - b.d || (a.p.name < b.p.name ? -1 : 1); })
    .slice(0, n || 8).map(function(o){ o.p.dist = o.d; return o.p; });
}

/* ---------- Claude Cabs ---------- */
function renderCabs(el, host, nav){
  var D = dom(), mk = D.mk, btn = D.btn, cabs = host.cabs || null, calm = fn(host.calm, false), announce = fn(host.announce, null);
  var C = HQV.hqCabs, CL = cabs && cabs.classes ? cabs.classes() : C ? C.classes() : [];
  var tab = "ride", dest = null, cls = lsGet(CLS_KEY) || "cab", lastSig = "", lastEta = null, lastPhase = null, offerSig = "";
  if(!CL.some(function(c){ return c.id === cls; })) cls = "cab";
  function say(t){ if(!(cabs && cabs.announces)) try { announce(t); } catch(e){} }
  var wrap = mk("section", "pc-cabs", el); wrap.setAttribute("aria-labelledby", "pc-cabs-h");
  var h = mk("h2", "pc-h", wrap, "Claude Cabs"); h.id = "pc-cabs-h";
  if(!cabs){ mk("p", "pc-empty", wrap, "Open the City to use this."); return {}; }
  var tabs = mk("div", "pc-tabs", wrap); tabs.setAttribute("role", "tablist"); tabs.setAttribute("aria-label", "Ride or drive");
  var panel = mk("div", "pc-panel", wrap); panel.setAttribute("role", "tabpanel");
  var tabBtns = [["ride", "Ride"], ["drive", "Drive"]].map(function(t){
    var b = btn(tabs, t[1], "pc-tab", function(){ tab = t[0]; paintTabs(); draw(); });
    b.setAttribute("role", "tab"); b.id = "pc-cabs-tab-" + t[0]; return b;
  });
  roving(tabs, function(){ return tabBtns; }, {attr: "aria-selected"});
  function paintTabs(){
    tabBtns.forEach(function(b, i){ var on = (i === 0) === (tab === "ride"); b.setAttribute("aria-selected", on ? "true" : "false"); b.tabIndex = on ? 0 : -1; b.className = "pc-tab" + (on ? " on" : ""); });
    panel.setAttribute("aria-labelledby", "pc-cabs-tab-" + tab);
  }
  var live = null, liveSig = "";
  function draw(){
    D.clear(panel); live = null; liveSig = ""; offerSig = "";
    if(tab === "ride") drawRide(); else drawDrive();
  }
  /* ----- ride ----- */
  function current(){ var H = cabs.current ? cabs.current() : null, s = H ? H.state() : null; return s && s.phase !== "cancelled" ? {H: H, s: s} : null; }
  function drawRide(){
    var cur = current();
    if(cur) return drawLive(cur);
    var me = fn(host.me, {})() || {}, all = destinations(host);
    var lab = mk("label", "pc-label", panel, "Where to?"); lab.htmlFor = "pc-cabs-q";
    var q = mk("input", "pc-search", panel); q.type = "search"; q.id = "pc-cabs-q"; q.autocomplete = "off"; q.placeholder = "A place or a station";
    var res = mk("div", "pc-results", panel); res.setAttribute("role", "listbox"); res.setAttribute("aria-label", "Destinations");
    var pick = mk("p", "pc-dest", panel, dest ? "To " + dest.name : "Pick a destination."); pick.setAttribute("aria-live", "polite");
    function list(){
      D.clear(res);
      var L = searchDest(all, q.value, me, 8);
      if(!L.length){ mk("div", "pc-empty", res, q.value ? "Nothing matches." : "No places here."); return; }
      L.forEach(function(p, i){
        var o = btn(res, "", "pc-opt" + (dest && dest.id === p.id ? " on" : ""), function(){ dest = p; pick.textContent = "To " + p.name; list(); chips(); });
        o.setAttribute("role", "option"); o.setAttribute("aria-selected", dest && dest.id === p.id ? "true" : "false");
        mk("span", "pc-opt-name", o, p.name); mk("span", "pc-opt-sub", o, p.kind + " · " + distText(p.dist));
      });
    }
    q.addEventListener("input", list);
    q.addEventListener("keydown", function(e){ if(e.key === "ArrowDown"){ var f = res.querySelector("button"); if(f){ if(e.preventDefault) e.preventDefault(); f.focus(); } } });
    list();
    var cg = mk("div", "pc-chips", panel); cg.setAttribute("role", "radiogroup"); cg.setAttribute("aria-label", "Ride class");
    var cbs = [];
    function chips(){
      D.clear(cg); cbs = [];
      CL.forEach(function(c){
        var qt = null; try { qt = cabs.quote ? cabs.quote(dest || {x: num(me.x, 0), z: num(me.z, 0)}, c.id) : null; } catch(e){ qt = null; }
        var on = c.id === cls, b = btn(cg, "", "pc-chip" + (on ? " on" : ""), function(){ cls = c.id; lsSet(CLS_KEY, cls); chips(); var f = cbs.filter(function(x){ return x.getAttribute("aria-checked") === "true"; })[0]; if(f && f.focus) f.focus(); });
        b.setAttribute("role", "radio"); b.setAttribute("aria-checked", on ? "true" : "false"); b.tabIndex = on ? 0 : -1;
        mk("span", "pc-chip-name", b, c.name); mk("span", "pc-chip-eta", b, qt ? etaText(qt.eta) : "");
        b.setAttribute("aria-label", c.name + (qt ? ", arrives in " + etaText(qt.eta) : "") + ". " + c.desc + ". Free.");
        cbs.push(b);
      });
    }
    roving(cg, function(){ return cbs; });
    chips();
    mk("p", "pc-note", panel, "Every ride is free.");
    var go = btn(panel, "Request", "pc-btn pc-primary", function(){
      if(!dest){ pick.textContent = "Pick a destination first."; q.focus(); return; }
      var H = cabs.request(dest, cls);
      if(!H){ pick.textContent = "That didn't work. Try another place."; return; }
      lastEta = null; lastPhase = null; draw();
    });
    go.setAttribute("aria-describedby", "pc-cabs-h");
  }
  function drawLive(cur){
    live = mk("div", "pc-live", panel); live.setAttribute("role", "status"); live.setAttribute("aria-live", "polite");
    var ph = mk("p", "pc-phase", live), eta = mk("p", "pc-eta", live);
    var d = cur.s.driver || (cur.H && cur.H.driver);
    if(d){
      var card = mk("div", "pc-driver", panel); card.setAttribute("aria-label", "Your driver");
      mk("p", "pc-driver-name", card, d.name + " · " + Number(d.rating).toFixed(1) + " ★");
      mk("p", "pc-driver-car", card, d.model + " · " + d.plate);
    }
    var acts = mk("div", "pc-acts", panel), skipB = null, cancelB = null, rate = null;
    function upd(){
      var c2 = current(); if(!c2 || !c2.H){ draw(); return; }
      var s = c2.s, sig = s.phase + "|" + s.canSkip + "|" + (s.rated || 0);
      ph.textContent = PHASE_TEXT[s.phase] || s.phase;
      eta.textContent = s.phase === "coming" || s.phase === "matching" ? "Arrives in " + etaText(s.eta) + (s.metres ? " · " + distText(s.metres) : "")
                      : s.phase === "riding" ? distText(s.metres) + " to go · about " + etaText(s.eta) : s.phase === "done" ? "At " + (s.dest && s.dest.name || "your stop") : "";
      // the spoken status (when the controller does not speak it)
      if(s.phase !== lastPhase){
        if(s.phase === "coming" && lastPhase === "matching" && d) say("Matched: " + d.name + " in a " + d.model + ", " + etaText(s.eta) + " away.");
        if(s.phase === "here") say("Your Claude Cab is here.");
        if(s.phase === "done") say("You've arrived.");
        lastPhase = s.phase;
      } else if(s.phase === "coming" && C && C.etaSay(lastEta, s.eta)) say("Your cab is " + etaText(s.eta) + " away.");
      lastEta = s.eta;
      if(sig === liveSig) return;
      liveSig = sig; D.clear(acts);
      if(s.phase === "matching" || s.phase === "coming" || s.phase === "here") cancelB = btn(acts, "Cancel ride", "pc-btn", function(){ c2.H.cancel(); draw(); });
      if(s.canSkip) skipB = btn(acts, calm() ? "Skip ahead" : "Skip ahead (4×)", "pc-btn", function(){ c2.H.skip(); upd(); });
      if(s.phase === "done"){
        rate = mk("div", "pc-rate", acts); rate.setAttribute("role", "radiogroup"); rate.setAttribute("aria-label", "Rate your driver (optional)");
        var stars = [];
        [1, 2, 3, 4, 5].forEach(function(n){
          var b = btn(rate, n <= (s.rated || 0) ? "★" : "☆", "pc-star", function(){ c2.H.rate(n); liveSig = ""; upd(); }, n + (n === 1 ? " star" : " stars"));
          b.setAttribute("role", "radio"); b.setAttribute("aria-checked", (s.rated || 0) === n ? "true" : "false"); b.tabIndex = (s.rated || 1) === n ? 0 : -1; stars.push(b);
        });
        roving(rate, function(){ return stars; });
        btn(acts, "New ride", "pc-btn", function(){ if(cabs.cancel) cabs.cancel(); draw(); });
      }
    }
    live.upd = upd; upd();
  }
  /* ----- drive ----- */
  function drawDrive(){
    var dr = cabs.driver, st = dr.state();
    var tg = btn(panel, "Drive for Claude Cabs", "pc-btn pc-toggle" + (st.on ? " on" : ""), function(){
      var r = dr.on(!dr.state().on); msg.textContent = r && r.text ? r.text : ""; draw(); if(r && r.text) try { announce(r.text); } catch(e){}
    });
    tg.setAttribute("aria-pressed", st.on ? "true" : "false");
    var msg = mk("p", "pc-msg", panel, st.on ? DRV_TEXT[st.phase] || "" : "Score only: points, stars and achievements, kept on this device.");
    msg.setAttribute("role", "status"); msg.setAttribute("aria-live", "polite");
    var offersEl = mk("div", "pc-offers", panel); offersEl.setAttribute("aria-label", "Requests");
    var jobEl = mk("div", "pc-job", panel);
    var stats = mk("dl", "pc-stats", panel);
    function stat(k, v){ mk("dt", null, stats, k); mk("dd", null, stats, v); }
    var S = st.stats || (C ? C.driverStats() : {score: 0, rating: 0, fares: 0});
    stat("Driver score", S.score); stat("Rating", S.fares ? Number(S.rating).toFixed(2) + " ★" : "No fares yet"); stat("Fares", S.fares);
    live = {upd: function(){
      var s = dr.state(), now = typeof host.now === "function" ? host.now() : Date.now();
      msg.textContent = s.on ? DRV_TEXT[s.phase] || "" : msg.textContent;
      var O = s.on && s.phase === "idle" ? dr.offers() : [], sig = O.map(function(o){ return o.id; }).join(",") + "|" + s.phase;
      if(sig !== offerSig){
        offerSig = sig; D.clear(offersEl);
        if(s.on && s.phase === "idle" && !O.length) mk("p", "pc-empty", offersEl, "No requests right now. They come every few seconds.");
        O.forEach(function(o){
          var row = mk("div", "pc-offer", offersEl);
          mk("p", "pc-offer-what", row, "Pick up " + distText(o.pickupM) + " away · " + distText(o.metres) + " to " + o.drop.name);
          var left = mk("p", "pc-offer-left", row, ""); row.left = left; row.exp = o.expires;
          btn(row, "Accept", "pc-btn pc-primary", function(){ if(dr.accept(o.id)){ try { announce("Accepted: pick up " + distText(o.pickupM) + " away."); } catch(e){} draw(); } }, "Accept: pick up " + distText(o.pickupM) + " away, trip " + distText(o.metres));
        });
      }
      [].forEach.call(offersEl.children, function(row){ if(row.left) row.left.textContent = Math.max(0, Math.ceil((row.exp - now)/1000)) + " s left"; });
      D.clear(jobEl);
      if(s.offer && s.phase !== "idle"){ mk("p", "pc-job-what", jobEl, (s.phase === "pickup" ? "Pickup " : "Drop-off ") + distText(s.metres) + (s.phase === "trip" ? " · to " + s.offer.drop.name : "")); }
      if(s.result){ var r = s.result; mk("p", "pc-result", jobEl, "Last fare: " + r.points + " points · " + r.stars + (r.stars === 1 ? " star" : " stars") + " · score " + r.totals.score); }
    }};
    live.upd();
  }
  paintTabs(); draw();
  return {
    tick: function(){ if(live && live.upd) live.upd(); },
    onKey: function(){ return false; },
    dispose: function(){ live = null; }
  };
}

/* ---------- Vehicles ---------- */
function renderVehicles(el, host, nav){
  var D = dom(), mk = D.mk, btn = D.btn, V = host.vehicles, Hc = HQV.hqCall, announce = fn(host.announce, null);
  var wrap = mk("section", "pc-veh", el); wrap.setAttribute("aria-labelledby", "pc-veh-h");
  var h = mk("h2", "pc-h", wrap, "Vehicles"); h.id = "pc-veh-h";
  if(!V || !V.list){ mk("p", "pc-empty", wrap, "Open the City to use this."); return {}; }
  var q = mk("input", "pc-search", wrap); q.type = "search"; q.setAttribute("aria-label", "Search your vehicles"); q.placeholder = "Search: brand, model, bike…";
  function items(){ try { return V.list() || []; } catch(e){ return []; } }
  var chipUi = Hc && Hc.mountChips ? Hc.mountChips(wrap, {counts: function(){ return Hc.chipCounts(items()); }, atJetty: host.atJetty, onChange: function(){ list(); }}) : null;
  var listEl = mk("div", "pc-list", wrap); listEl.setAttribute("aria-label", "Your vehicles");
  var status = mk("p", "pc-msg", wrap, ""); status.setAttribute("role", "status"); status.setAttribute("aria-live", "polite");
  var heliBox = mk("div", "pc-spots", wrap);
  function say(t){ status.textContent = t; try { announce(t); } catch(e){} }
  function list(){
    D.clear(listEl);
    var all = items(), chip = chipUi ? chipUi.value() : "all", L = Hc ? Hc.filterItems(all, chip, q.value) : all;
    if(!all.length){ mk("p", "pc-empty", listEl, "No vehicles yet: the dealership has them."); return; }
    if(Hc && !Hc.filterItems(all, chip, "").length){ var c = Hc.chips(true).filter(function(x){ return x.id === chip; })[0]; mk("p", "pc-empty", listEl, c ? c.empty : "Nothing here."); return; }
    if(!L.length){ mk("p", "pc-empty", listEl, "Nothing matches."); return; }
    L.forEach(function(it){
      var row = mk("div", "pc-row", listEl);
      mk("span", "pc-row-name", row, it.title || it.key); mk("span", "pc-row-sub", row, it.sub || "");
      var isHeli = Hc && Hc.chipOf(it) === "heli";
      btn(row, "Call", "pc-btn", function(){
        if(isHeli && host.heli) return spotsFor(it.key, it.title);
        var ok = false; try { ok = V.call(it.key) !== false; } catch(e){ ok = false; }
        say(ok ? (it.title || "Your vehicle") + " is on its way." : "It can't come here.");
      }, "Call " + (it.title || it.key));
    });
  }
  function spotsFor(own, title){
    D.clear(heliBox);
    var H = host.heli; if(!H || !H.spots){ say("No helicopter can land here."); return; }
    var L = []; try { L = H.spots() || []; } catch(e){ L = []; }
    var hh = mk("h3", "pc-h3", heliBox, own ? "Where should " + (title || "it") + " land?" : "Where should the helicopter land?"); hh.id = "pc-spots-h";
    if(!L.length){ mk("p", "pc-empty", heliBox, "No open ground or helipad within 400 m. Try a park or the airport."); return; }
    var ul = mk("div", "pc-list", heliBox); ul.setAttribute("aria-labelledby", "pc-spots-h");
    L.slice(0, 6).forEach(function(s){
      var row = mk("div", "pc-row", ul);
      mk("span", "pc-row-name", row, s.name); mk("span", "pc-row-sub", row, (s.kind === "pad" ? "Helipad" : "Open ground") + " · " + distText(s.dist));
      btn(row, "Land here", "pc-btn", function(){
        var hd = null; try { hd = H.call(s, {own: own || null}); } catch(e){ hd = null; }
        say(hd ? (own ? (title || "Your helicopter") : "A Claude Cabs helicopter") + " is on its way to " + s.name + "." : "It can't land there.");
        D.clear(heliBox);
      }, "Land at " + s.name);
    });
    var f = ul.querySelector("button"); if(f && f.focus) f.focus();
  }
  q.addEventListener("input", list);
  btn(wrap, "Call a helicopter", "pc-btn pc-primary", function(){ spotsFor(null, null); });
  list();
  return {tick: function(){}, onKey: function(){ return false; }, dispose: function(){}};
}

/* ---------- Dealership ---------- */
function renderDealer(el, host, nav){
  var D = dom(), mk = D.mk, btn = D.btn, calm = fn(host.calm, false), announce = fn(host.announce, null), sfx = fn(host.sfx, null);
  var wrap = mk("section", "pc-dealer", el); wrap.setAttribute("aria-labelledby", "pc-dealer-h");
  var h = mk("h2", "pc-h", wrap, "Dealership"); h.id = "pc-dealer-h";
  var st = mk("p", "pc-msg", wrap, "Calling Claude Motors…"); st.setAttribute("role", "status"); st.setAttribute("aria-live", "polite");
  var ring = mk("div", "pc-ring" + (calm() ? "" : " pc-ringing"), wrap); ring.setAttribute("aria-hidden", "true");
  var body = mk("div", "pc-dealer-body", wrap);
  var timer = null, done = false;
  try { sfx("dial"); } catch(e){}
  try { announce("Calling Claude Motors."); } catch(e){}
  function answered(){
    timer = null; if(done) return;
    if(ring.parentNode) ring.parentNode.removeChild(ring);
    st.textContent = "Claude Motors, how can we help?";
    try { announce(st.textContent); } catch(e){}
    if(!host.dealer || !host.dealer.mount){ mk("p", "pc-empty", body, "The dealership can't take orders right now."); return; }
    try { host.dealer.mount(body, bought); } catch(e){ mk("p", "pc-empty", body, "The dealership can't take orders right now."); }
  }
  function bought(r){
    if(done || !r) return;
    D.clear(body);
    var name = String(r.name || "vehicle");
    var where = r.level != null && r.bay != null ? " is parked at level " + r.level + ", bay " + r.bay + "." : " is in your carpark.";
    st.textContent = "Your new " + name + where + " Call it?";
    try { announce(st.textContent); } catch(e){}
    var acts = mk("div", "pc-acts", body);
    btn(acts, "Call it", "pc-btn pc-primary", function(){
      var ok = false; try { ok = host.vehicles && host.vehicles.call(r.key || ("own:" + r.id)) !== false; } catch(e){ ok = false; }
      st.textContent = ok ? "Your " + name + " is on its way." : "It can't come here: open the City and call it with C.";
      try { announce(st.textContent); } catch(e){}
    });
    btn(acts, "Not now", "pc-btn", function(){ if(nav && nav.back) nav.back(); });
    var f = acts.querySelector("button"); if(f && f.focus) f.focus();
  }
  timer = setTimeout(answered, 2000);
  return {
    tick: function(){}, onKey: function(){ return false; },
    dispose: function(){ done = true; if(timer) clearTimeout(timer); timer = null; },
    _answer: answered, _bought: bought
  };
}

// original glyphs (24 x 24 paths)
var GLYPH = {
  cabs: "M5 11l1.6-4.3A2 2 0 0 1 8.5 5.4h7a2 2 0 0 1 1.9 1.3L19 11h1a1 1 0 0 1 1 1v4a1 1 0 0 1-1 1h-1a2 2 0 0 1-4 0H9a2 2 0 0 1-4 0H4a1 1 0 0 1-1-1v-4a1 1 0 0 1 1-1zm2.2 0h9.6l-1.2-3.4a.8.8 0 0 0-.8-.6H9.2a.8.8 0 0 0-.8.6zM10 2.5h4v2h-4z",
  vehicles: "M7 3a4 4 0 1 1-2.2 7.3L3 12.1V15h2.5v2.5H8V20h3v-3.2l1.3-1.3A4 4 0 0 1 7 3zm0 2.2a1.6 1.6 0 1 0 0 3.2 1.6 1.6 0 0 0 0-3.2zM15 13h6v2h-6zm0 4h6v2h-6z",
  dealer: "M6.6 3.2l2.6-.6 1.6 4-1.9 1.4a11 11 0 0 0 5.1 5.1l1.4-1.9 4 1.6-.6 2.6A2.5 2.5 0 0 1 16.4 17 13.4 13.4 0 0 1 3 3.6a2.5 2.5 0 0 1 3.6-.4zM15 3h6v6h-2V6.4l-4.3 4.3-1.4-1.4L17.6 5H15z"
};
var APPS = [
  {id: "claude-cabs", name: "Claude Cabs", order: 40, glyph: GLYPH.cabs, dock: true, needsCity: true, render: renderCabs,
   badge: function(host){ try { var s = host.cabs && host.cabs.state ? host.cabs.state() : null; return s && (s.phase === "coming" || s.phase === "here" || s.phase === "riding") ? 1 : 0; } catch(e){ return 0; } }},
  {id: "vehicles", name: "Vehicles", order: 50, glyph: GLYPH.vehicles, dock: false, needsCity: true, render: renderVehicles},
  {id: "dealership", name: "Dealership", order: 60, glyph: GLYPH.dealer, dock: false, needsCity: false, render: renderDealer}
];
var Q = HQV.hqPhoneQueue = HQV.hqPhoneQueue || [];
APPS.forEach(function(a){ Q.push(a); });
HQV.hqPhoneCabs = {apps: APPS, destinations: destinations, searchDest: searchDest, etaText: etaText, distText: distText,
                   renderCabs: renderCabs, renderVehicles: renderVehicles, renderDealer: renderDealer, CLS_KEY: CLS_KEY};
})();
