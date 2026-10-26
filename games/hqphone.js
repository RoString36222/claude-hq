/* Claude HQ: the phone (HQ 3.15 transport revamp, docs/plans/transport-revamp.md 3.12 / 3.13 / 5.8, part `phone`).
 *
 * A 360 x 740 device in the bottom-right corner of the stage (a full-screen sheet under 600 px wide): a status bar
 * (the city clock, signal bars and a battery: decorative, aria-hidden), a home screen of app icons in a 4-column grid
 * plus a dock, badges, and one app at a time on a navigation stack. Everything is free (D4): no coins, no wallet.
 *
 * Apps register in a queue, so load order does not matter:
 *   (HQV.hqPhoneQueue = HQV.hqPhoneQueue || []).push({id, name, order, glyph (SVG path d, 24 x 24), dock: bool,
 *      needsCity: bool, render(el, host, nav, arg) -> {dispose?, onKey?(e) -> bool, tick?(ms)}, badge?(host) -> n})
 *   nav = {back(), open(appId, arg), title(text), setBadge(n), arg}
 * The queue is drained when this file loads and on every mount, and its push is wrapped so a later push lands at once.
 * The same id pushed again replaces the earlier app.
 *
 * Mounted by the host:  HQV.hqPhone.mount(stageEl, host) -> ui
 *   ui.open(appId?, arg?) / close() / isOpen() / toggle() / owns(e) / badge(appId, n) / notify({app, title, text})
 *   ui.dispose()        plus ui.badgeTotal() (every app's badge summed, for the host's phone button) and ui.top()
 *   host: plan 5.8 (announce, toast, now(), clock() -> {h, m}, calm(), reducedMotion(), inCity(), me(), ride, ...)
 * Keys: while the phone is open owns(e) is true for every key event, so hq3d's capture-phase handler leaves them alone
 * (WASD does not walk). Inside the device: Esc goes back (on the home screen it closes), Backquote closes (except while
 * typing), Tab stays inside, arrows move between icons (roving tabindex), Enter opens. A key pressed while focus is
 * outside the device (the 3D canvas clicked) still reaches Esc / Backquote through a window listener.
 * Calm (host.calm() or html.hq-calm) and prefers-reduced-motion: no slide-up, the banner appears in place.
 * Notifications: a banner from the top of the phone (or of the stage while it is closed) for 4 s, and announce() of
 * its title only (never a message's text: plan 3.13).
 *
 * Pure (node-tested, tests/test_hqphone.py): HQV.hqPhone.model = {createRegistry(), createNav(), badgeTotals(apps,
 *   explicit, host), gated(app, inCity), clockText({h, m}, h24), gridMove(i, key, n, cols), ownsKey(open, e),
 *   validApp(a), ingest(registry, queue, onAdd)}; HQV.hqPhone.prefs (the phone's local settings) and
 *   HQV.hqPhone.registry (the apps registered so far).
 * DOM: createElement / createElementNS / textContent only. Nothing leaves the machine.
 */
(function(){
"use strict";
var W = typeof window !== "undefined" ? window : globalThis;
var HQV = W.HQV = W.HQV || {};

var COLS = 4;
var BANNER_MS = 4000;
var TICK_MS = 1000;
var BATTERY = 87;
var TONES = 7;               // squircle colour classes hqphone-t0..t6

/* ---------------------------------------------------------------- pure ---- */
function num(v, d){ v = +v; return isFinite(v) ? v : d; }
function hash32(s){
  s = String(s == null ? "" : s);
  var h = 0x811c9dc5;
  for(var i = 0; i < s.length; i++){ h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193); }
  return h >>> 0;
}
function pad2(n){ n = n | 0; return (n < 10 ? "0" : "") + n; }

function validApp(a){
  return !!(a && typeof a === "object" && typeof a.id === "string" && a.id && typeof a.render === "function");
}
function cmpApps(a, b){
  var d = num(a.order, 999) - num(b.order, 999);
  if(d) return d;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}
// The registered apps: one per id (a later push replaces the earlier one), listed by order then id.
function createRegistry(){
  var byId = {}, seq = 0;
  var R = {
    add: function(a){
      if(!validApp(a)) return false;
      var app = {id: a.id, name: String(a.name || a.id).slice(0, 24), order: num(a.order, 999), glyph: typeof a.glyph === "string" ? a.glyph : "",
                 dock: !!a.dock, needsCity: !!a.needsCity, render: a.render, badge: typeof a.badge === "function" ? a.badge : null,
                 tone: a.tone != null ? (a.tone | 0) % TONES : hash32(a.id) % TONES, seq: ++seq};
      byId[a.id] = app;
      return true;
    },
    get: function(id){ return byId[id] || null; },
    list: function(){ return Object.keys(byId).map(function(k){ return byId[k]; }).sort(cmpApps); },
    grid: function(){ return R.list().filter(function(a){ return !a.dock; }); },
    dock: function(){ return R.list().filter(function(a){ return a.dock; }); },
    size: function(){ return Object.keys(byId).length; }
  };
  return R;
}
// Drain a queue into a registry and wrap its push so later pushes land at once (onAdd(app) after each).
function ingest(reg, Q, onAdd){
  if(!reg || !Q || typeof Q.length !== "number") return 0;
  var n = 0;
  while(Q.length){ var a = Array.prototype.shift.call(Q); if(reg.add(a)){ n++; if(onAdd) onAdd(a); } }
  if(!Q.__hqPhoneWrapped){
    var hooks = [];
    try {
      Object.defineProperty(Q, "__hqPhoneWrapped", {value: hooks, enumerable: false});
      Object.defineProperty(Q, "push", {enumerable: false, configurable: true, writable: true, value: function(){
        for(var i = 0; i < arguments.length; i++){
          var it = arguments[i];
          hooks.forEach(function(h){ try { h(it); } catch(e){} });
        }
        return Q.length;
      }});
    } catch(e){ return n; }
  }
  var hk = Q.__hqPhoneWrapped;
  for(var i = 0; i < hk.length; i++) if(hk[i].reg === reg) return n;    // this registry already listens
  var f = function(it){ if(reg.add(it) && onAdd) onAdd(it); };
  f.reg = reg;
  hk.push(f);
  return n;
}
// The navigation stack: home is the empty stack. back() -> "close" on home, else "home" or the app now on top.
function createNav(){
  var st = [];
  return {
    open: function(id, arg){
      if(!id) return null;
      var t = st[st.length - 1];
      if(t && t.id === id){ t.arg = arg != null ? arg : t.arg; return t; }
      for(var i = 0; i < st.length; i++) if(st[i].id === id){ st.splice(i, 1); break; }   // no loops: bring it up
      st.push({id: id, arg: arg != null ? arg : null});
      return st[st.length - 1];
    },
    back: function(){
      if(!st.length) return "close";
      st.pop();
      return st.length ? st[st.length - 1].id : "home";
    },
    top: function(){ return st.length ? st[st.length - 1] : null; },
    depth: function(){ return st.length; },
    ids: function(){ return st.map(function(s){ return s.id; }); },
    reset: function(){ st.length = 0; }
  };
}
// Badges: an explicit badge(appId, n) wins over the app's own badge(host); totals over every app.
function badgeTotals(apps, explicit, host){
  var by = {}, total = 0;
  explicit = explicit || {};
  (apps || []).forEach(function(a){
    var n = 0;
    if(Object.prototype.hasOwnProperty.call(explicit, a.id)) n = explicit[a.id];
    else if(a.badge){ try { n = a.badge(host); } catch(e){ n = 0; } }
    n = Math.max(0, Math.min(999, num(n, 0) | 0));
    by[a.id] = n; total += n;
  });
  return {by: by, total: total};
}
function gated(app, inCity){ return !!(app && app.needsCity && !inCity); }
function clockText(c, h24){
  c = c || {};
  var h = Math.max(0, Math.min(23, num(c.h, 0) | 0)), m = Math.max(0, Math.min(59, num(c.m, 0) | 0));
  if(h24) return pad2(h) + ":" + pad2(m);
  return ((h % 12) || 12) + ":" + pad2(m);
}
// Roving focus in a grid of n items, cols wide: the index an arrow / Home / End moves to (-1: not a move key).
function gridMove(i, key, n, cols){
  n = n | 0; cols = Math.max(1, cols | 0); i = i | 0;
  if(n <= 0) return -1;
  switch(key){
    case "ArrowRight": return Math.min(n - 1, i + 1);
    case "ArrowLeft": return Math.max(0, i - 1);
    case "ArrowDown": return i + cols < n ? i + cols : i;
    case "ArrowUp": return i - cols >= 0 ? i - cols : i;
    case "Home": return 0;
    case "End": return n - 1;
    default: return -1;
  }
}
// While the phone is open it owns every key event (hq3d skips them); closed, none.
function ownsKey(open, e){
  if(!open || !e) return false;
  var t = e.type;
  return t == null || t === "keydown" || t === "keyup" || t === "keypress";
}

/* ---- the phone's local settings: host settings hooks, else localStorage over the page's CONFIG ---- */
var PREF_KEY = "hq_phone_prefs";
var PREF_DEF = {transitVoice: true, transitTextOnly: false, phoneClock24: false, cabClass: "go"};
var CAB_CLASSES = ["bike", "go", "cab", "xl", "lux"];
function lsGet(k){ try { var s = W.localStorage && W.localStorage.getItem(k); return s ? JSON.parse(s) : null; } catch(e){ return null; } }
function lsSet(k, v){ try { if(W.localStorage) W.localStorage.setItem(k, JSON.stringify(v)); return true; } catch(e){ return false; } }
var prefMem = null;
function prefOk(k, v){
  if(k === "cabClass") return CAB_CLASSES.indexOf(v) >= 0;
  return typeof v === "boolean" && Object.prototype.hasOwnProperty.call(PREF_DEF, k);
}
var prefs = {
  KEYS: Object.keys(PREF_DEF), CAB_CLASSES: CAB_CLASSES,
  // host.settings {get(key), set(key, value)} when the integrator passes it (the page's Settings keys)
  get: function(k, host){
    var hs = host && host.settings;
    if(hs && typeof hs.get === "function"){ try { var hv = hs.get(k); if(prefOk(k, hv)) return hv; } catch(e){} }
    var s = prefMem || lsGet(PREF_KEY) || {};
    if(prefOk(k, s[k])) return s[k];
    var c = W.CONFIG;
    if(c && prefOk(k, c[k])) return c[k];
    return PREF_DEF[k];
  },
  set: function(k, v, host){
    if(!prefOk(k, v)) return false;
    var hs = host && host.settings;
    if(hs && typeof hs.set === "function"){ try { hs.set(k, v); } catch(e){} }
    var s = prefMem || lsGet(PREF_KEY) || {};
    s[k] = v; prefMem = s;
    lsSet(PREF_KEY, s);
    if(W.CONFIG && typeof W.CONFIG === "object") W.CONFIG[k] = v;   // the comms apps read CONFIG.phoneClock24
    return true;
  },
  all: function(host){ var o = {}; Object.keys(PREF_DEF).forEach(function(k){ o[k] = prefs.get(k, host); }); return o; },
  reset: function(){ prefMem = null; lsSet(PREF_KEY, {}); }
};

var REG = createRegistry();
var LISTEN = [];
function onRegistered(){ LISTEN.slice().forEach(function(f){ try { f(); } catch(e){} }); }
function drain(){ ingest(REG, HQV.hqPhoneQueue = HQV.hqPhoneQueue || [], onRegistered); }
drain();

var API = HQV.hqPhone = {
  model: {createRegistry: createRegistry, createNav: createNav, badgeTotals: badgeTotals, gated: gated, clockText: clockText,
          gridMove: gridMove, ownsKey: ownsKey, validApp: validApp, ingest: ingest, COLS: COLS, BANNER_MS: BANNER_MS},
  prefs: prefs,
  registry: REG,
  hash32: hash32,
  mount: null
};

/* ----------------------------------------------------------------- DOM ---- */
var doc = W.document;
var SVGNS = "http://www.w3.org/2000/svg";
var uidN = 0;

function mk(tag, cls, parent, text){
  var n = doc.createElement(tag);
  if(cls) n.className = cls;
  if(text != null) n.textContent = text;
  if(parent) parent.appendChild(n);
  return n;
}
function svgEl(tag, attrs, parent){
  var n = doc.createElementNS(SVGNS, tag);
  for(var k in attrs) if(Object.prototype.hasOwnProperty.call(attrs, k)) n.setAttribute(k, String(attrs[k]));
  if(parent) parent.appendChild(n);
  return n;
}
function clear(n){ while(n && n.firstChild) n.removeChild(n.firstChild); }
function glyphSvg(d, size){
  var s = svgEl("svg", {viewBox: "0 0 24 24", width: size || 26, height: size || 26, "aria-hidden": "true", focusable: "false"});
  svgEl("path", {d: d || "M5 5h14v14H5z", fill: "none", stroke: "currentColor", "stroke-width": 1.8, "stroke-linecap": "round", "stroke-linejoin": "round"}, s);
  return s;
}
function hcall(host, name, args, def){
  try { if(host && typeof host[name] === "function") { var v = host[name].apply(host, args || []); return v === undefined ? def : v; } } catch(e){}
  return def;
}
function calmNow(host){
  if(hcall(host, "calm", [], false)) return true;
  if(hcall(host, "reducedMotion", [], false)) return true;
  var de = doc && doc.documentElement;
  if(de && de.classList && de.classList.contains("hq-calm")) return true;
  try { return !!(W.matchMedia && W.matchMedia("(prefers-reduced-motion: reduce)").matches); } catch(e){ return false; }
}
function say(host, msg){
  if(!msg) return;
  if(host && typeof host.announce === "function"){ try { host.announce(msg); return; } catch(e){} }
  try { if(typeof W.announce === "function") W.announce(msg); } catch(e){}
}
function typingIn(t){
  if(!t || !t.tagName) return false;
  var tg = String(t.tagName).toUpperCase();
  return tg === "INPUT" || tg === "TEXTAREA" || tg === "SELECT" || !!t.isContentEditable;
}
function focusables(root){
  var sel = "a[href],button,input,select,textarea,[tabindex]";
  return Array.prototype.slice.call(root.querySelectorAll(sel)).filter(function(n){
    if(n.disabled) return false;
    var ti = n.getAttribute && n.getAttribute("tabindex");
    if(ti === "-1") return false;
    if(n.closest && n.closest("[hidden]")) return false;
    return true;
  });
}

function mount(stageEl, host){
  if(!doc || !doc.createElement) return null;
  host = host || {};
  drain();
  var stage = stageEl || doc.body;
  var id = ++uidN;
  var nav = createNav();
  var explicit = {};
  var state = {open: false, opener: null, app: null, appId: null, handle: null, timer: null, bannerT: null, disposed: false,
               lastClock: "", lastTotal: -1};

  var root = mk("div", "hqphone-root" + (stage === doc.body ? " hqphone-fixed" : ""), stage);
  var back = mk("div", "hqphone-back", root);
  back.id = "phoneBack";
  back.hidden = true;
  back.setAttribute("aria-hidden", "true");
  var dev = mk("div", "hqphone", back);
  dev.setAttribute("role", "dialog");
  dev.setAttribute("aria-modal", "true");
  dev.tabIndex = -1;

  // status bar: decorative
  var status = mk("div", "hqphone-status", dev);
  status.setAttribute("aria-hidden", "true");
  var clockEl = mk("span", "hqphone-clock", status, "");
  var icons = mk("span", "hqphone-sicons", status);
  var bars = svgEl("svg", {viewBox: "0 0 18 12", width: 18, height: 12, focusable: "false"}, icons);
  for(var b = 0; b < 4; b++) svgEl("rect", {x: b*4.5, y: 9 - b*3, width: 3, height: 3 + b*3, rx: 0.6, "class": "hqphone-bar"}, bars);
  var batt = svgEl("svg", {viewBox: "0 0 26 12", width: 26, height: 12, focusable: "false"}, icons);
  svgEl("rect", {x: 0.6, y: 0.6, width: 22, height: 10.8, rx: 2.5, "class": "hqphone-batt-case"}, batt);
  svgEl("rect", {x: 23.4, y: 4, width: 1.8, height: 4, rx: 0.8, "class": "hqphone-batt-tip"}, batt);
  svgEl("rect", {x: 2.2, y: 2.2, width: Math.round(18.8*BATTERY)/100, height: 7.6, rx: 1.4, "class": "hqphone-batt-fill"}, batt);
  mk("span", "hqphone-pct", icons, BATTERY + "%");

  var screen = mk("div", "hqphone-screen", dev);
  // home
  var home = mk("section", "hqphone-home", screen);
  var homeH = mk("h2", "hqphone-sr", home, "Phone");
  homeH.id = "hqphoneHome" + id;
  var grid = mk("div", "hqphone-grid", home);
  grid.setAttribute("role", "group");
  grid.setAttribute("aria-label", "Apps");
  var dock = mk("div", "hqphone-dock", home);
  dock.setAttribute("role", "group");
  dock.setAttribute("aria-label", "Dock");
  // an app's panel
  var panel = mk("section", "hqphone-app", screen);
  panel.hidden = true;
  var head = mk("div", "hqphone-apphead", panel);
  var backBtn = mk("button", "hqphone-backbtn", head);
  backBtn.type = "button";
  backBtn.setAttribute("aria-label", "Back");
  backBtn.appendChild(glyphSvg("M15 5l-7 7 7 7", 20));
  mk("span", "hqphone-backlbl", backBtn, "Back");
  var titleEl = mk("h2", "hqphone-apptitle", head, "");
  titleEl.id = "hqphoneTitle" + id;
  var closeBtn = mk("button", "hqphone-closebtn", head);
  closeBtn.type = "button";
  closeBtn.setAttribute("aria-label", "Close the phone");
  closeBtn.appendChild(glyphSvg("M6 6l12 12M18 6L6 18", 18));
  var body = mk("div", "hqphone-body", panel);
  dev.setAttribute("aria-labelledby", homeH.id);

  var banner = mk("button", "hqphone-banner", root);
  banner.type = "button";
  banner.hidden = true;
  var bIcon = mk("span", "hqphone-banner-icon", banner);
  var bText = mk("span", "hqphone-banner-text", banner);
  var bTitle = mk("b", "hqphone-banner-title", bText, "");
  var bBody = mk("span", "hqphone-banner-body", bText, "");

  /* ---- home screen ---- */
  var iconEls = {};
  function drawHome(){
    clear(grid); clear(dock); iconEls = {};
    var tot = totals();
    function icon(a, parent){
      var btn = mk("button", "hqphone-icon", parent);
      btn.type = "button";
      btn.setAttribute("data-app", a.id);
      var sq = mk("span", "hqphone-squircle hqphone-t" + a.tone, btn);
      sq.appendChild(glyphSvg(a.glyph, 26));
      var bd = mk("span", "hqphone-badge", sq, "");
      bd.setAttribute("aria-hidden", "true");
      mk("span", "hqphone-iname", btn, a.name);
      btn.addEventListener("click", function(){ openApp(a.id, null); });
      iconEls[a.id] = {btn: btn, badge: bd, name: a.name};
      setIconBadge(a.id, tot.by[a.id] || 0);
      return btn;
    }
    REG.grid().forEach(function(a){ icon(a, grid); });
    REG.dock().forEach(function(a){ icon(a, dock); });
    rove(grid, COLS); rove(dock, 99);
  }
  function setIconBadge(appId, n){
    var ic = iconEls[appId]; if(!ic) return;
    var t = n > 99 ? "99+" : n > 0 ? String(n) : "";
    if(ic.badge.textContent !== t) ic.badge.textContent = t;
    ic.badge.hidden = !t;
    var label = ic.name + (n > 0 ? ", " + n + " new" : "");
    if(ic.btn.getAttribute("aria-label") !== label) ic.btn.setAttribute("aria-label", label);
  }
  function rove(group, cols){
    var items = Array.prototype.slice.call(group.querySelectorAll(".hqphone-icon"));
    items.forEach(function(it, i){ it.tabIndex = i === 0 ? 0 : -1; });
    group.onkeydown = function(e){
      var its = Array.prototype.slice.call(group.querySelectorAll(".hqphone-icon")), i = its.indexOf(doc.activeElement);
      if(i < 0) return;
      var j = gridMove(i, e.key, its.length, cols);
      if(j < 0) return;
      e.preventDefault();
      its.forEach(function(it, k){ it.tabIndex = k === j ? 0 : -1; });
      if(its[j].focus) its[j].focus();
    };
  }
  function totals(){ return badgeTotals(REG.list(), explicit, host); }
  function refreshBadges(){
    var t = totals();
    Object.keys(iconEls).forEach(function(k){ setIconBadge(k, t.by[k] || 0); });
    state.lastTotal = t.total;
    return t;
  }

  /* ---- apps ---- */
  function disposeApp(){
    var h = state.handle; state.handle = null; state.app = null; state.appId = null;
    if(h && typeof h.dispose === "function"){ try { h.dispose(); } catch(e){} }
    clear(body);
  }
  function showHome(){
    disposeApp();
    panel.hidden = true; home.hidden = false;
    dev.setAttribute("aria-labelledby", homeH.id);
    drawHome();
    var first = grid.querySelector(".hqphone-icon") || dock.querySelector(".hqphone-icon");
    if(first && first.focus && state.open) first.focus();
  }
  function navFor(appId, arg){
    return {
      arg: arg,
      back: function(){ goBack(); },
      open: function(id2, arg2){ openApp(id2, arg2); },
      title: function(text){ if(state.appId === appId) titleEl.textContent = String(text == null ? "" : text).slice(0, 40); },
      setBadge: function(n){ setBadge(appId, n); },
      close: function(){ close(); }       // beyond plan 5.8: Tickets' Go closes the phone so you can walk
    };
  }
  function showApp(appId, arg){
    var a = REG.get(appId);
    disposeApp();
    home.hidden = true; panel.hidden = false;
    dev.setAttribute("aria-labelledby", titleEl.id);
    if(!a){
      titleEl.textContent = "Not installed";
      mk("p", "hqphone-empty", body, "This app is not on this phone yet.");
    } else {
      state.app = a; state.appId = appId;
      titleEl.textContent = a.name;
      body.setAttribute("data-app", a.id);
      if(gated(a, hcall(host, "inCity", [], false))){
        var g = mk("div", "hqphone-gate", body);
        g.appendChild(glyphSvg(a.glyph, 40));
        mk("p", "hqphone-gate-text", g, "Open the City to use this");
        g.setAttribute("role", "status");
      } else {
        var el = mk("div", "hqphone-appbody", body);
        try { state.handle = a.render(el, host, navFor(appId, arg), arg) || {}; }
        catch(err){ clear(body); mk("p", "hqphone-empty", body, "This app could not start."); state.handle = null; }
      }
    }
    if(state.open){
      var f = focusables(body)[0];
      (f && f.focus ? f : backBtn).focus();
    }
  }
  function openApp(appId, arg){
    if(!appId) return;
    nav.open(appId, arg);
    showApp(appId, arg);
  }
  function goBack(){
    var r = nav.back();
    if(r === "close"){ close(); return; }
    if(r === "home"){ showHome(); return; }
    var t = nav.top();
    showApp(t.id, t.arg);
  }

  /* ---- open / close ---- */
  function tick(){
    if(state.disposed) return;
    var c = clockText(hcall(host, "clock", [], null) || nowClock(), prefs.get("phoneClock24", host));
    if(c !== state.lastClock){ clockEl.textContent = c; state.lastClock = c; }
    if(!home.hidden) refreshBadges();
    var h = state.handle;
    if(h && typeof h.tick === "function"){ try { h.tick(num(hcall(host, "now", [], Date.now()), Date.now())); } catch(e){} }
  }
  function nowClock(){ var d = new Date(Date.now() + 330*60000); return {h: d.getUTCHours(), m: d.getUTCMinutes()}; }   // [3.23] the City's (IST)
  function open(appId, arg){
    if(state.disposed) return false;
    if(!state.open){
      try { if(doc.pointerLockElement && doc.exitPointerLock) doc.exitPointerLock(); } catch(e){}
      state.opener = doc.activeElement || null;
      state.open = true;
      back.hidden = false;
      back.setAttribute("aria-hidden", "false");
      back.className = "hqphone-back open" + (calmNow(host) ? " hqphone-still" : " hqphone-anim");
      root.className = root.className.replace(/\s*hqphone-on/g, "") + " hqphone-on";
      state.lastClock = "";
      tick();
      if(state.timer == null) state.timer = setInterval(tick, TICK_MS);
      win(true);
    }
    if(appId){ nav.reset(); openApp(appId, arg); }
    else if(nav.depth()){ var t = nav.top(); showApp(t.id, t.arg); }
    else showHome();
    return true;
  }
  function close(){
    if(!state.open) return false;
    state.open = false;
    disposeApp();
    nav.reset();
    back.className = "hqphone-back";
    back.hidden = true;
    back.setAttribute("aria-hidden", "true");
    root.className = root.className.replace(/\s*hqphone-on/g, "");
    if(state.timer != null){ clearInterval(state.timer); state.timer = null; }
    win(false);
    var o = state.opener; state.opener = null;
    if(o && o.focus && (!doc.contains || doc.contains(o) || (doc.body && doc.body.contains && doc.body.contains(o)))){ try { o.focus(); } catch(e){} }
    return true;
  }
  function toggle(){ return state.open ? close() : open(); }
  function isOpen(){ return state.open; }
  function owns(e){
    if(!ownsKey(state.open, e)) return !!(e && e.hqPhoneHandled);
    return true;
  }
  function setBadge(appId, n){
    if(!appId) return;
    if(n == null) delete explicit[appId];
    else explicit[appId] = Math.max(0, num(n, 0) | 0);
    refreshBadges();
  }

  /* ---- notifications ---- */
  function notify(o){
    o = o || {};
    if(state.disposed) return;
    var a = REG.get(o.app) || null;
    clear(bIcon);
    bIcon.className = "hqphone-banner-icon hqphone-squircle hqphone-t" + (a ? a.tone : 0);
    bIcon.appendChild(glyphSvg(a ? a.glyph : "M12 4a6 6 0 0 1 6 6v4l2 3H4l2-3v-4a6 6 0 0 1 6-6zM10 20h4", 18));
    bTitle.textContent = String(o.title || (a ? a.name : "Phone")).slice(0, 60);
    bBody.textContent = String(o.text || "").slice(0, 120);
    banner.setAttribute("aria-label", bTitle.textContent + (o.app ? ". Open " + (a ? a.name : o.app) : ""));
    banner.className = "hqphone-banner" + (calmNow(host) ? " hqphone-still" : " hqphone-anim") + (state.open ? " hqphone-banner-in" : "");
    banner.hidden = false;
    banner.onclick = function(){ hideBanner(); open(o.app || null); };
    say(host, bTitle.textContent);       // the title only: never a message's text
    if(state.bannerT != null) clearTimeout(state.bannerT);
    state.bannerT = setTimeout(hideBanner, BANNER_MS);
  }
  function hideBanner(){
    if(state.bannerT != null){ clearTimeout(state.bannerT); state.bannerT = null; }
    banner.hidden = true;
  }

  /* ---- keys ---- */
  function contain(e){
    e.hqPhoneHandled = true;
    if(e.stopPropagation) e.stopPropagation();
  }
  function onKeyDown(e){
    contain(e);
    var h = state.handle;
    if(h && typeof h.onKey === "function"){
      var used = false;
      try { used = !!h.onKey(e); } catch(err){ used = false; }
      if(used){ if(e.preventDefault) e.preventDefault(); return; }
    }
    if(e.key === "Escape"){ if(e.preventDefault) e.preventDefault(); goBack(); return; }
    if((e.code === "Backquote" || e.key === "`") && !typingIn(e.target)){ if(e.preventDefault) e.preventDefault(); close(); return; }
    if(e.key === "Tab") trap(e);
  }
  function trap(e){
    var f = focusables(dev);
    if(!f.length){ if(e.preventDefault) e.preventDefault(); return; }
    var first = f[0], last = f[f.length - 1], a = doc.activeElement;
    if(f.indexOf(a) < 0){ if(e.preventDefault) e.preventDefault(); (e.shiftKey ? last : first).focus(); return; }
    if(e.shiftKey && a === first){ if(e.preventDefault) e.preventDefault(); last.focus(); }
    else if(!e.shiftKey && a === last){ if(e.preventDefault) e.preventDefault(); first.focus(); }
  }
  // a key while focus is outside the device (the canvas clicked): Esc and Backquote still work
  function onWinKey(e){
    if(!state.open || !e || e.hqPhoneHandled) return;
    if(dev.contains(e.target)) return;
    if(e.key === "Escape"){ e.hqPhoneHandled = true; if(e.preventDefault) e.preventDefault(); goBack(); }
    else if((e.code === "Backquote" || e.key === "`") && !typingIn(e.target)){ e.hqPhoneHandled = true; if(e.preventDefault) e.preventDefault(); close(); }
  }
  var winOn = false;
  function win(on){
    if(!W.addEventListener || on === winOn) return;
    winOn = on;
    if(on) W.addEventListener("keydown", onWinKey); else if(W.removeEventListener) W.removeEventListener("keydown", onWinKey);
  }
  dev.addEventListener("keydown", onKeyDown);
  dev.addEventListener("keyup", contain);
  dev.addEventListener("keypress", contain);
  back.addEventListener("click", function(e){ if(e.target === back) close(); });
  backBtn.addEventListener("click", function(){ goBack(); });
  closeBtn.addEventListener("click", function(){ close(); });

  var unlisten = (function(){
    function f(){ if(state.open && !home.hidden) drawHome(); }
    LISTEN.push(f);
    return function(){ LISTEN = LISTEN.filter(function(g){ return g !== f; }); };
  })();
  drawHome();
  tick();

  function dispose(){
    if(state.disposed) return;
    close();
    hideBanner();
    state.disposed = true;
    unlisten();
    if(root.parentNode) root.parentNode.removeChild(root);
  }

  return {open: open, close: close, isOpen: isOpen, owns: owns, toggle: toggle, badge: setBadge, notify: notify, dispose: dispose,
          badgeTotal: function(){ return totals().total; }, top: function(){ var t = nav.top(); return t ? t.id : null; },
          el: root};
}
API.mount = mount;
})();
