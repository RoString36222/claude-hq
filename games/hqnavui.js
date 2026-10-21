/* Claude HQ 3D city: the navigation UI (HQV.hqnavui, nav-river spec "Client: the navigation UI").
 *
 *   "Go to" panel   a search box over the places of this world (HQV.hqnav.places), nearest first:
 *                   icon, label, distance. Up/Down (and Home/End) move the selection, Enter or a
 *                   click goes there (onGo(place)), Esc closes. Focus stays in the search box (a
 *                   combobox with aria-activedescendant), so the list never takes keyboard focus.
 *   banner          top-centre while a route is on: the maneuver arrow, the distance to it, the
 *                   road name, the remaining distance + ETA, the destination and an X (onClear()).
 *   arrival card    "You have arrived" + the place, for ARRIVED_MS.
 *
 * Mounted by the host:  HQV.hqnavui.mount(stageEl, {places(), onGo(place), onClear(), announce}) -> ui
 *   ui.open() / ui.close() / ui.toggle() / ui.isOpen()
 *   ui.banner(info | null)   info = {step: {kind, road}, toNext (m), left (m), eta_s, dest (label),
 *                            hint?: "Press E for the ferry"}; null hides it. Cheap to call per frame:
 *                            the DOM is written only when a shown value changes, and the maneuver is
 *                            announced once per new step (not per frame).
 *   ui.arrived(label)        the arrival card (announced); ui.destroy()
 * Pure: maneuverText(step, toNext), fmtDist(m), fmtEta(s), filterPlaces(places, query), GLYPH.
 *
 * Keys (for the integrator): every keydown/keyup inside the panel, the banner or the card is marked
 * `e.hqnavHandled = true` and stopped (stopPropagation; preventDefault too, except for the text
 * typed into the search box, which must still reach the input). That stops the page's own bubble
 * phase shortcuts, but NOT a capture-phase listener on window (hq3d's onKey runs before any of
 * this), so such a host must skip events where HQV.hqnavui.owns(e) is true (e.hqnavHandled, or a
 * target inside .hqnavui-panel / .hqnavui-banner / .hqnavui-arrived), as hq3d's typing() already
 * does for .hqhud-settings. The X on the banner acts on Enter/Space itself (on keydown), so a host
 * that preventDefaults Space cannot cancel it.
 * textContent only; nothing leaves the machine.
 */
(function(){
"use strict";
var HQV = window.HQV = window.HQV || {};

var ARRIVED_MS = 4000;
var MAX_ROWS = 60;
var NEAR_M = 15;             // closer than this the maneuver is "now": no "In 20 m"
var OWN = ".hqnavui-panel, .hqnavui-banner, .hqnavui-arrived";

// The maneuver arrow per step kind (text glyphs, no emoji: they inherit the ink colour).
var GLYPH = {
  start: "↑", straight: "↑", left: "←", right: "→",
  "slight-left": "↖", "slight-right": "↗", "sharp-left": "↙", "sharp-right": "↘",
  uturn: "↶", bridge: "⌒", arrive: "◎"
};
// Fallback icons per place kind, when a Place carries no icon of its own.
var KIND_ICON = {
  dock: "⚓", port: "⚓", travel: "⛴", transit: "🚉", airport: "✈", townhall: "🏛", hospital: "✚", clinic: "✚",
  police: "★", fire: "▲", school: "✎", university: "✎", market: "🛒", mall: "🛍", bank: "$", library: "▤",
  post: "✉", stadium: "◉", fountain: "⛲", skatepark: "◢", myhq: "⌂", hq: "⌂"
};

function num(v, d){ v = +v; return isFinite(v) ? v : d; }

// ---- pure helpers ---------------------------------------------------------------------------

// "0 m", "999 m", "1.2 km", "12 km".
function fmtDist(m){
  m = Math.max(0, num(m, 0));
  var r = Math.round(m);
  if(r < 1000) return r + " m";
  var km = m / 1000;
  if(km < 9.95) return km.toFixed(1).replace(/\.0$/, "") + " km";
  return Math.round(km) + " km";
}

// "0 s", "59 s", "1 min", "1 h", "1 h 5 min".
function fmtEta(s){
  s = Math.max(0, num(s, 0));
  if(Math.round(s) < 60) return Math.round(s) + " s";
  var min = Math.max(1, Math.round(s / 60));
  if(min < 60) return min + " min";
  var h = Math.floor(min / 60), rest = min % 60;
  return h + " h" + (rest ? " " + rest + " min" : "");
}

function cap(t){ return t ? t.charAt(0).toUpperCase() + t.slice(1) : t; }

// One spoken/printed instruction: "In 120 m turn left onto Patch Lane". Under NEAR_M (or with no
// distance) the "In ..." goes: "Turn left onto Patch Lane".
function maneuverText(step, toNext){
  step = step || {};
  var kind = String(step.kind || "straight"), road = step.road ? String(step.road) : "";
  var onto = road ? " onto " + road : "", act;
  switch(kind){
    case "start": return road ? "Head along " + road : "Head to the route";
    case "arrive": act = "arrive at your destination"; break;
    case "left": case "right": act = "turn " + kind + onto; break;
    case "slight-left": case "slight-right": act = "bear " + kind.slice(7) + onto; break;
    case "sharp-left": case "sharp-right": act = "turn sharp " + kind.slice(6) + onto; break;
    case "uturn": act = "make a U-turn" + (road ? " on " + road : ""); break;
    case "bridge": act = "cross the bridge" + (road ? " on " + road : ""); break;
    default: act = "continue straight" + onto;
  }
  var d = toNext == null ? NaN : +toNext;
  return isFinite(d) && d >= NEAR_M ? "In " + fmtDist(d) + " " + act : cap(act);
}

// Places whose label (or kind) contains every word of the query, case-insensitive; order kept
// (the caller's list is sorted by distance). An empty query keeps them all.
function filterPlaces(places, q){
  var list = Array.isArray(places) ? places.filter(Boolean) : [];
  var words = String(q || "").toLowerCase().split(/\s+/).filter(Boolean);
  if(!words.length) return list;
  return list.filter(function(p){
    var hay = (String(p.label || "") + " " + String(p.kind || "")).toLowerCase();
    for(var i = 0; i < words.length; i++){ if(hay.indexOf(words[i]) < 0) return false; }
    return true;
  });
}

function inside(t){ return !!(t && t.closest && t.closest(OWN)); }
// Should a host's capture-phase key handler leave this event alone?
function owns(e){ return !!(e && (e.hqnavHandled || inside(e.target))); }

// ---- DOM ------------------------------------------------------------------------------------

var uid = 0;

function mount(el, opts){
  opts = opts || {};
  var doc = window.document || (typeof document !== "undefined" ? document : null);
  var announce = typeof opts.announce === "function" ? opts.announce : function(){};
  var getPlaces = typeof opts.places === "function" ? opts.places : function(){ return []; };
  var onGo = typeof opts.onGo === "function" ? opts.onGo : function(){};
  var onClear = typeof opts.onClear === "function" ? opts.onClear : function(){};
  var id = "hqnavui-" + (++uid);
  var domL = [], alive = true, arrivedTimer = null;

  function mk(tag, cls, parent){
    var n = doc.createElement(tag);
    if(cls) n.className = cls;
    parent.appendChild(n);
    return n;
  }
  function on(n, type, fn){ n.addEventListener(type, fn); domL.push([n, type, fn]); }
  function setText(n, t){ if(n.textContent !== t) n.textContent = t; }
  function show(n, yes){ yes = !!yes; if(n.hidden !== !yes) n.hidden = !yes; }
  function safe(fn, a){ try { fn(a); } catch(e){ if(window.console) console.error(e); } }

  var root = mk("div", "hqnavui", el);

  // ---- the "Go to" panel ----
  var panel = mk("div", "hqnavui-panel", root);
  panel.setAttribute("role", "dialog");
  panel.setAttribute("aria-label", "Go to");
  panel.hidden = true;
  var head = mk("div", "hqnavui-head", panel);
  var title = mk("label", "hqnavui-title", head);
  title.textContent = "Go to";
  title.setAttribute("for", id + "-q");
  var closeBtn = mk("button", "hqnavui-x", head);
  closeBtn.setAttribute("type", "button");
  closeBtn.setAttribute("aria-label", "Close");
  closeBtn.textContent = "×";
  var input = mk("input", "hqnavui-q", panel);
  input.id = id + "-q";
  input.setAttribute("type", "search");
  input.type = "search";
  input.setAttribute("placeholder", "Search places");
  input.setAttribute("autocomplete", "off");
  input.setAttribute("spellcheck", "false");
  input.setAttribute("role", "combobox");
  input.setAttribute("aria-autocomplete", "list");
  input.setAttribute("aria-expanded", "false");
  input.setAttribute("aria-controls", id + "-list");
  var list = mk("ul", "hqnavui-list", panel);
  list.id = id + "-list";
  list.setAttribute("role", "listbox");
  list.setAttribute("aria-label", "Places");
  var empty = mk("p", "hqnavui-empty", panel);
  empty.hidden = true;

  var all = [], shown = [], rows = [], sel = -1, open = false;

  function setSel(i){
    if(!shown.length){ sel = -1; input.setAttribute("aria-activedescendant", ""); return; }
    i = Math.max(0, Math.min(shown.length - 1, i));
    if(sel >= 0 && rows[sel]){ rows[sel].classList.remove("on"); rows[sel].setAttribute("aria-selected", "false"); }
    sel = i;
    var r = rows[sel];
    r.classList.add("on");
    r.setAttribute("aria-selected", "true");
    input.setAttribute("aria-activedescendant", r.id);
    if(r.scrollIntoView){ try { r.scrollIntoView({block: "nearest"}); } catch(e){ /* old engines */ } }
  }
  function render(){
    shown = filterPlaces(all, input.value).slice(0, MAX_ROWS);
    while(list.children && list.children.length) list.removeChild(list.children[list.children.length - 1]);
    rows = [];
    sel = -1;
    for(var i = 0; i < shown.length; i++){
      var p = shown[i], li = mk("li", "hqnavui-row", list);
      li.id = id + "-o" + i;
      li.setAttribute("role", "option");
      li.setAttribute("aria-selected", "false");
      li.setAttribute("data-kind", String(p.kind || ""));
      li.setAttribute("data-i", String(i));
      var ic = mk("span", "hqnavui-icon", li);
      ic.setAttribute("aria-hidden", "true");
      ic.textContent = String(p.icon || KIND_ICON[p.kind] || "•");
      mk("span", "hqnavui-label", li).textContent = String(p.label || p.kind || "");
      mk("span", "hqnavui-dist", li).textContent = fmtDist(p.dist);
      rows.push(li);
    }
    empty.textContent = all.length ? "No places match" : "No places here yet";
    show(empty, !shown.length);
    show(list, !!shown.length);
    if(shown.length) setSel(0);
    else input.setAttribute("aria-activedescendant", "");
  }
  // One listener on the list for every row (rows are rebuilt as you type): mousedown keeps focus
  // in the search box, the click goes.
  function rowOf(t){
    for(; t && t !== list; t = t.parentNode){ if(t.getAttribute && t.getAttribute("data-i") != null) return +t.getAttribute("data-i"); }
    return -1;
  }
  on(list, "mousedown", function(e){ if(e.preventDefault) e.preventDefault(); });
  on(list, "click", function(e){ var i = rowOf(e.target); if(i >= 0) go(i); });
  function go(i){
    var p = shown[i];
    if(!p) return;
    close();
    safe(onGo, p);
  }
  function openPanel(){
    if(!alive) return;
    var got = [];
    try { got = getPlaces() || []; } catch(e){ got = []; if(window.console) console.error(e); }
    all = Array.isArray(got) ? got : [];
    input.value = "";
    open = true;
    show(panel, true);
    input.setAttribute("aria-expanded", "true");
    render();
    if(input.focus){ try { input.focus({preventScroll: true}); } catch(e){ input.focus(); } }
  }
  function close(){
    if(!open) return;
    var had = focusIn(panel);
    open = false;
    show(panel, false);
    input.setAttribute("aria-expanded", "false");
    if(had && el.focus){ try { el.focus({preventScroll: true}); } catch(e){ el.focus(); } }  // back to the game
  }
  function focusIn(n){
    for(var a = doc.activeElement; a; a = a.parentNode){ if(a === n) return true; }
    return false;
  }

  on(input, "input", render);
  on(closeBtn, "click", close);
  on(closeBtn, "mousedown", function(e){ if(e.preventDefault) e.preventDefault(); });

  // Keys inside our pieces never leak (see the header). Text typed into the search box keeps its
  // default action, or it would never reach the input.
  function contain(e, handled){
    e.hqnavHandled = true;
    if(e.stopPropagation) e.stopPropagation();
    if(handled || e.type === "keyup" || e.target !== input){ if(e.preventDefault) e.preventDefault(); }
  }
  function panelKey(e){
    var k = e.key, handled = false;
    if(e.type === "keydown"){
      handled = true;
      if(k === "ArrowDown" || k === "Down") setSel(sel + 1);
      else if(k === "ArrowUp" || k === "Up") setSel(sel - 1);
      else if(k === "PageDown") setSel(sel + 8);
      else if(k === "PageUp") setSel(sel - 8);
      else if((k === "Home" || k === "End") && e.target !== input) setSel(k === "Home" ? 0 : shown.length - 1);
      else if(k === "Enter"){ if(e.target === closeBtn) close(); else if(!e.repeat) go(sel); }
      else if(k === "Escape" || k === "Esc") close();
      else if((k === " " || k === "Spacebar") && e.target === closeBtn) close();
      else if(k === "Tab"){ handled = true; (e.target === input && !e.shiftKey ? closeBtn : input).focus(); }
      else handled = false;
    }
    contain(e, handled);
  }
  on(panel, "keydown", panelKey);
  on(panel, "keyup", panelKey);

  // ---- the banner ----
  var banner = mk("div", "hqnavui-banner", root);
  banner.setAttribute("role", "group");
  banner.setAttribute("aria-label", "Navigation");
  banner.hidden = true;
  var arrow = mk("div", "hqnavui-arrow", banner);
  arrow.setAttribute("aria-hidden", "true");
  var bMain = mk("div", "hqnavui-main", banner);
  var bLine = mk("div", "hqnavui-line", bMain);
  var bTo = mk("b", "hqnavui-to", bLine);
  var bRoad = mk("span", "hqnavui-road", bLine);
  var bSub = mk("div", "hqnavui-sub", bMain);
  var bLeft = mk("span", "hqnavui-left", bSub);
  var bDest = mk("span", "hqnavui-dest", bSub);
  var bHint = mk("div", "hqnavui-hint", bMain);
  bHint.hidden = true;
  var bText = mk("span", "hqnavui-sr", banner);       // the whole instruction, for screen readers
  var clear = mk("button", "hqnavui-x", banner);
  clear.setAttribute("type", "button");
  clear.setAttribute("aria-label", "End navigation");
  clear.textContent = "×";
  var lastStep = "", lastHint = "";

  function clearRoute(){
    banner_(null);
    safe(onClear);
  }
  on(clear, "click", clearRoute);
  on(clear, "mousedown", function(e){ if(e.preventDefault) e.preventDefault(); });
  on(banner, "keydown", function(e){
    var act = e.target === clear && (e.key === "Enter" || e.key === " " || e.key === "Spacebar") && !e.repeat;
    contain(e, true);
    if(act) clearRoute();
  });
  on(banner, "keyup", function(e){ contain(e, true); });

  function banner_(info){
    if(!alive) return;
    if(!info){
      if(!banner.hidden && focusIn(banner) && el.focus){ try { el.focus({preventScroll: true}); } catch(e){ el.focus(); } }
      show(banner, false);
      lastStep = lastHint = "";
      return;
    }
    var step = info.step || {}, kind = GLYPH[step.kind] ? String(step.kind) : "straight";
    var toNext = info.toNext, near = !(isFinite(+toNext) && +toNext >= NEAR_M);
    setText(arrow, GLYPH[kind]);
    if(arrow.getAttribute("data-kind") !== kind) arrow.setAttribute("data-kind", kind);
    setText(bTo, near ? "Now" : fmtDist(toNext));
    var text = maneuverText(step, toNext);
    var act = maneuverText(step, null);              // the instruction without "In ..."
    setText(bRoad, act);
    setText(bLeft, fmtDist(info.left) + " · " + fmtEta(info.eta_s));
    setText(bDest, info.dest ? String(info.dest) : "");
    show(bDest, !!info.dest);
    var hint = info.hint ? String(info.hint) : "";
    setText(bHint, hint);
    show(bHint, !!hint);
    setText(bText, text);
    show(banner, true);
    // Speak a new maneuver once (kind + road), and any new hint.
    var sig = kind + "|" + (step.road || "") + "|" + (step.at != null ? step.at : "");
    if(sig !== lastStep){ lastStep = sig; announce(text); }
    if(hint !== lastHint){ lastHint = hint; if(hint) announce(hint); }
  }

  // ---- the arrival card ----
  var card = mk("div", "hqnavui-arrived", root);
  card.setAttribute("role", "status");
  card.hidden = true;
  var cTitle = mk("b", "hqnavui-arr-title", card);
  cTitle.textContent = "You have arrived";
  var cPlace = mk("span", "hqnavui-arr-place", card);
  on(card, "keydown", function(e){ contain(e, true); });
  on(card, "keyup", function(e){ contain(e, true); });

  function arrived(label){
    if(!alive) return;
    var t = label ? String(label) : "";
    setText(cPlace, t);
    show(cPlace, !!t);
    show(card, true);
    announce(t ? "You have arrived at " + t : "You have arrived");
    if(arrivedTimer != null) window.clearTimeout(arrivedTimer);
    arrivedTimer = window.setTimeout(function(){ arrivedTimer = null; show(card, false); }, ARRIVED_MS);
  }

  function destroy(){
    alive = false;
    if(arrivedTimer != null) window.clearTimeout(arrivedTimer);
    arrivedTimer = null;
    for(var i = 0; i < domL.length; i++) domL[i][0].removeEventListener(domL[i][1], domL[i][2]);
    domL = [];
    if(root.parentNode) root.parentNode.removeChild(root);
  }

  return {
    open: openPanel,
    close: close,
    toggle: function(){ if(open) close(); else openPanel(); return open; },
    isOpen: function(){ return open; },
    banner: banner_,
    arrived: arrived,
    destroy: destroy,
    root: root
  };
}

HQV.hqnavui = {
  mount: mount,
  maneuverText: maneuverText,
  fmtDist: fmtDist,
  fmtEta: fmtEta,
  filterPlaces: filterPlaces,
  owns: owns,
  GLYPH: GLYPH,
  ARRIVED_MS: ARRIVED_MS
};
})();
