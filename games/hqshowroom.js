/* Claude HQ: the Showroom (HQV.hqShowroom), a TEMPORARY picker for every catalogue vehicle until the
 * dealership (docs/plans/dealership-spec.md) replaces it: free, no ownership yet.
 *
 * Classes are grouped Bikes / Cars, then by type and cc band (HQV.hqVehicles.classes order); each vehicle shows
 * its brand, model, key specs and paint swatches. Picking one calls onPick(id, paintHex): games/hq3d.js puts it
 * at your garage (or beside you) to drive.
 *   groups(cat)            -> [{kind, label, types: [{type, label, classes: [{id, label, vehicles: [v]}]}]}]  (pure)
 *   specLine(v)            -> "2993 cc six · 510 PS · 0-100 3.9 s · 290 km/h · RWD"                      (pure)
 *   mount(stageEl, {catalogue() -> cat | null, onPick(id, hex), announce}) -> ui
 *     ui.open() / ui.close() / ui.toggle() / ui.isOpen() / ui.destroy()
 *   owns(e)                -> true for a key event inside the panel (the host's capture-phase handler skips it)
 * Keys inside the panel never reach the dashboard's shortcuts or the avatar (stopPropagation; Escape closes).
 * textContent only.
 */
(function(){
"use strict";
var HQV = (typeof window !== "undefined" ? window : globalThis).HQV = (typeof window !== "undefined" ? window : globalThis).HQV || {};

var TYPE_LABEL = {naked: "Naked", sport: "Sport", adventure: "Adventure", cruiser: "Cruiser", scooter: "Scooter", dirt: "Dirt", classic: "Classic", hypersport: "Hypersport",
                  hatch: "Hatchback", sedan: "Sedan", coupe: "Coupé", suv: "SUV", pickup: "Pickup", hyper: "Hypercar", super: "Supercar"};
var KIND_LABEL = {bike: "Bikes", car: "Cars"};
var OWN = ".hqshowroom";

function classesOf(cat){
  if(HQV.hqVehicles && HQV.hqVehicles.classes) return HQV.hqVehicles.classes(cat);
  return ((cat && cat.classes) || []).filter(function(c){ return c.id !== "starter"; });
}
function vehiclesOf(cat, id){
  if(HQV.hqVehicles && HQV.hqVehicles.byClass) return HQV.hqVehicles.byClass(cat, id);
  return ((cat && cat.vehicles) || []).filter(function(v){ return v["class"] === id; });
}

function groups(cat){
  var out = [], K = {};
  classesOf(cat).forEach(function(c){
    var vs = vehiclesOf(cat, c.id);
    if(!vs.length) return;
    var k = K[c.kind];
    if(!k){ k = K[c.kind] = {kind: c.kind, label: KIND_LABEL[c.kind] || c.kind, types: [], T: {}}; out.push(k); }
    var t = k.T[c.type];
    if(!t){ t = k.T[c.type] = {type: c.type, label: TYPE_LABEL[c.type] || c.type, classes: []}; k.types.push(t); }
    t.classes.push({id: c.id, label: c.label || c.id, vehicles: vs});
  });
  out.forEach(function(k){ delete k.T; });
  return out;
}

function engineWord(sp){
  if(sp.electric) return "electric";
  var lay = String(sp.layout || ""), cyl = +sp.cyl || 0;
  if(lay) return lay.replace(/-/g, " ");
  return cyl ? cyl + " cyl" : "";
}
function specLine(v){
  var sp = (v && v.spec) || {}, bits = [];
  if(sp.electric) bits.push("electric");
  else if(+sp.cc > 0) bits.push(Math.round(+sp.cc) + " cc " + engineWord(sp));
  if(+sp.powerKw > 0) bits.push(Math.round(+sp.powerKw*1.35962) + " PS");
  if(+sp.zeroTo100s > 0) bits.push("0-100 " + (+sp.zeroTo100s).toFixed(1) + " s");
  if(+sp.topKmh > 0) bits.push(Math.round(+sp.topKmh) + " km/h");
  if(sp.drive && String(v["class"] || "").indexOf("car.") === 0) bits.push(String(sp.drive).toUpperCase());
  return bits.join(" · ");
}

function inside(t){ return !!(t && t.closest && t.closest(OWN)); }
function owns(e){ return !!(e && (e.hqShowroomHandled || inside(e.target))); }

function mount(stage, opts){
  opts = opts || {};
  var doc = (typeof document !== "undefined" ? document : null);
  var getCat = typeof opts.catalogue === "function" ? opts.catalogue : function(){ return null; };
  var onPick = typeof opts.onPick === "function" ? opts.onPick : function(){};
  var announce = typeof opts.announce === "function" ? opts.announce : function(){};
  var listeners = [], open = false, sel = {};          // sel: id -> chosen paint index

  function mk(tag, cls, parent, text){
    var n = doc.createElement(tag);
    if(cls) n.className = cls;
    if(text != null) n.textContent = text;
    if(parent) parent.appendChild(n);
    return n;
  }
  function on(n, ev, fn){ n.addEventListener(ev, fn); listeners.push([n, ev, fn]); }

  var root = mk("div", "hqshowroom", stage); root.hidden = true;
  root.setAttribute("role", "dialog"); root.setAttribute("aria-label", "Showroom");
  var head = mk("div", "hqshowroom-head", root);
  mk("div", "hqshowroom-title", head, "🚗 Showroom");
  mk("div", "hqshowroom-note", head, "Temporary: every vehicle is free to try until the dealership opens.");
  var closeBtn = mk("button", "hqshowroom-close", head, "✕"); closeBtn.type = "button"; closeBtn.setAttribute("aria-label", "Close the showroom");
  var tabs = mk("div", "hqshowroom-tabs", root); tabs.setAttribute("role", "tablist");
  var body = mk("div", "hqshowroom-body", root);
  var kindNow = "car";

  function render(){
    while(tabs.firstChild) tabs.removeChild(tabs.firstChild);
    while(body.firstChild) body.removeChild(body.firstChild);
    var cat = getCat();
    if(!cat){ mk("div", "hqshowroom-empty", body, "Loading the vehicles…"); return; }
    var G = groups(cat);
    if(!G.some(function(k){ return k.kind === kindNow; }) && G[0]) kindNow = G[0].kind;
    G.forEach(function(k){
      var t = mk("button", "hqshowroom-tab" + (k.kind === kindNow ? " on" : ""), tabs, k.label);
      t.type = "button"; t.setAttribute("role", "tab"); t.setAttribute("aria-selected", k.kind === kindNow ? "true" : "false");
      on(t, "click", function(){ kindNow = k.kind; render(); });
    });
    G.filter(function(k){ return k.kind === kindNow; }).forEach(function(k){
      k.types.forEach(function(t){
        var sec = mk("section", "hqshowroom-type", body);
        mk("h3", null, sec, t.label);
        t.classes.forEach(function(c){
          var row = mk("div", "hqshowroom-class", sec);
          mk("div", "hqshowroom-class-label", row, c.label);
          var cards = mk("div", "hqshowroom-cards", row);
          c.vehicles.forEach(function(v){ card(cards, v); });
        });
      });
    });
  }
  function card(parent, v){
    var paints = (v.paints || []).filter(function(p){ return p && /^#[0-9a-fA-F]{6}$/.test(p.hex); });
    var c = mk("div", "hqshowroom-card" + (v.slot === "reserve" ? " reserve" : ""), parent);
    mk("div", "hqshowroom-brand", c, v.brand || "");
    mk("div", "hqshowroom-model", c, (v.model || v.id) + (v.slot === "reserve" ? " (reserve)" : ""));
    mk("div", "hqshowroom-spec", c, specLine(v));
    var sw = mk("div", "hqshowroom-paints", c);
    var pi = sel[v.id] || 0;
    var label = mk("div", "hqshowroom-paint-name", c, paints[pi] ? paints[pi].name : "");
    paints.forEach(function(p, i){
      var b = mk("button", "hqshowroom-swatch" + (i === pi ? " on" : ""), sw);
      b.type = "button"; b.style.background = p.hex; b.title = p.name; b.setAttribute("aria-label", p.name);
      on(b, "click", function(){ sel[v.id] = i; render(); });
    });
    var go = mk("button", "hqshowroom-go", c, (String(v["class"] || "").indexOf("bike.") === 0 ? "Ride it" : "Drive it"));
    go.type = "button";
    on(go, "click", function(){
      var p = paints[sel[v.id] || 0];
      close();
      onPick(v.id, p ? p.hex : null);
      announce((v.brand ? v.brand + " " : "") + (v.model || v.id) + " is waiting for you. Press E to get in.");
    });
  }

  function contain(e){
    e.hqShowroomHandled = true;
    if(e.stopPropagation) e.stopPropagation();
    if(e.type === "keydown" && e.key === "Escape"){ if(e.preventDefault) e.preventDefault(); close(); }
  }
  on(root, "keydown", contain); on(root, "keyup", contain);
  on(closeBtn, "click", function(){ close(); });

  function openP(){
    if(open) return; open = true; root.hidden = false; render();
    var f = root.querySelector(".hqshowroom-tab.on") || closeBtn; if(f && f.focus) f.focus();
  }
  function close(){ if(!open) return; open = false; root.hidden = true; if(opts.onClose) opts.onClose(); }
  return {
    open: openP, close: close, toggle: function(){ if(open) close(); else openP(); }, isOpen: function(){ return open; },
    render: render, root: root,
    destroy: function(){ listeners.forEach(function(l){ l[0].removeEventListener(l[1], l[2]); }); listeners = []; if(root.parentNode) root.parentNode.removeChild(root); }
  };
}

HQV.hqShowroom = {groups: groups, specLine: specLine, mount: mount, owns: owns};
})();
