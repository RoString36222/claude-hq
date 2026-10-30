"""The phone shell and its transit apps (games/hqphone.js, games/hqphoneapps.js, games/patchnotes.json), HQ 3.15
(docs/plans/transport-revamp.md 3.12, 3.13, 5.8).

node: the pure model (the app queue drained and a late push, either load order; ordering, one app per id, grid and
dock; badge sums with an explicit badge winning; the navigation stack's back and close; needsCity gating; the clock;
roving moves; owns only while open); the shell mounted into a tiny DOM shim against a fake host (open and close, focus
back to the opener, Esc back then close, owns(e), the "Open the City to use this" gate, badges on icons, a late app
appearing, the banner announcing its title only); the apps' models (planner options with legs, times, changes and the
below-ground notes, the departures list with chips and favourites, a board, the map projected north-up east-right with
interchanges, dashed underground stretches and water, vehicles, seeded seats and gates, the boarding-pass pattern, patch
notes newest first, achievements); and the apps rendered (Tickets planning, booking and checking in for free,
Departures expanding to a real table, the Transit map's SVG and its text list, Settings). Python: patchnotes.json
parses, newest first, 3.18.0 on top; no innerHTML and no Math.random in any of the phone's files.
Skipped when node is not installed. Stdlib only."""
import json
import os
import re
import shutil
import subprocess
import unittest

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
NODE = shutil.which("node")
FILES = ["games/hqphone.js", "games/hqphoneapps.js", "games/hqgallery.js", "games/hqphone.css"]


def read(*p):
    with open(os.path.join(ROOT, *p), encoding="utf-8") as f:
        return f.read()


def run(script):
    env = dict(os.environ, TZ="UTC")
    r = subprocess.run([NODE, "--input-type=module", "-"], input=(DOM + script).replace("%(root)s", json.dumps(ROOT)),
                       capture_output=True, text=True, cwd=ROOT, timeout=60, env=env)
    if r.returncode != 0:
        raise AssertionError(r.stderr or r.stdout)
    return json.loads(r.stdout.strip().splitlines()[-1])


# A DOM just big enough for the phone: elements (HTML and SVG), text, attributes, classList, events, focus, and the
# selectors the phone uses (tag, .class, [attr], [attr=value], comma lists, one descendant step). innerHTML throws.
DOM = r"""
import fs from "fs";
function El(tag, ns){ this.tagName = ns ? String(tag) : String(tag).toUpperCase(); this.ns = ns || null; this.children = []; this.parentNode = null;
  this.attrs = {}; this._cls = ""; this._text = ""; this.listeners = {}; this.style = {}; this.value = ""; this.tabIndex = 0; this.disabled = false;
  this.hidden = false; this.checked = false; this.open = false; }
Object.defineProperty(El.prototype, "innerHTML", {set: function(){ throw new Error("innerHTML used"); }, get: function(){ return ""; }});
Object.defineProperty(El.prototype, "outerHTML", {set: function(){ throw new Error("outerHTML used"); }, get: function(){ return ""; }});
El.prototype.insertAdjacentHTML = function(){ throw new Error("insertAdjacentHTML used"); };
Object.defineProperty(El.prototype, "className", {get: function(){ return this._cls; }, set: function(v){ this._cls = String(v); }});
Object.defineProperty(El.prototype, "firstChild", {get: function(){ return this.children[0] || null; }});
Object.defineProperty(El.prototype, "isConnected", {get: function(){ var n = this; while(n.parentNode) n = n.parentNode; return n === document.body || n === document.head; }});
Object.defineProperty(El.prototype, "textContent", {
  get: function(){ return this._text + this.children.map(function(c){ return c.textContent; }).join(""); },
  set: function(v){ this.children.forEach(function(c){ c.parentNode = null; }); this.children = []; this._text = String(v); }});
Object.defineProperty(El.prototype, "id", {get: function(){ return this.attrs.id || ""; }, set: function(v){ this.attrs.id = String(v); }});
Object.defineProperty(El.prototype, "classList", {get: function(){ var el = this; function L(){ return el._cls.split(/\s+/).filter(Boolean); }
  return {contains: function(c){ return L().indexOf(c) >= 0; }, add: function(c){ if(L().indexOf(c) < 0) el._cls = L().concat([c]).join(" "); },
          remove: function(c){ el._cls = L().filter(function(x){ return x !== c; }).join(" "); },
          toggle: function(c, on){ if(on === undefined) on = L().indexOf(c) < 0; if(on) this.add(c); else this.remove(c); return on; }}; }});
El.prototype.appendChild = function(c){ if(c.parentNode) c.parentNode.removeChild(c); c.parentNode = this; this.children.push(c); return c; };
El.prototype.removeChild = function(c){ var i = this.children.indexOf(c); if(i >= 0) this.children.splice(i, 1); c.parentNode = null; return c; };
El.prototype.setAttribute = function(k, v){ if(k === "class") this._cls = String(v); else this.attrs[k] = String(v); };
El.prototype.getAttribute = function(k){ return k in this.attrs ? this.attrs[k] : (k === "class" ? this._cls : null); };
El.prototype.removeAttribute = function(k){ delete this.attrs[k]; };
El.prototype.addEventListener = function(t, fn){ (this.listeners[t] = this.listeners[t] || []).push(fn); };
El.prototype.removeEventListener = function(t, fn){ this.listeners[t] = (this.listeners[t] || []).filter(function(f){ return f !== fn; }); };
El.prototype.contains = function(n){ while(n){ if(n === this) return true; n = n.parentNode; } return false; };
El.prototype.focus = function(){ document.activeElement = this; };
El.prototype.closest = function(sel){ var n = this; while(n && n.tagName){ if(matches(n, sel)) return n; n = n.parentNode; } return null; };
// events bubble (target up to the root), with onkeydown handlers too; stopPropagation stops it
El.prototype.fire = function(t, ev){
  ev = ev || {}; ev.type = t; ev.target = ev.target || this; ev.defaultPrevented = false;
  ev.preventDefault = function(){ ev.defaultPrevented = true; }; ev.stopped = false; ev.stopPropagation = function(){ ev.stopped = true; };
  var n = this;
  while(n && !ev.stopped){
    (n.listeners[t] || []).slice().forEach(function(fn){ fn(ev); });
    if(t === "keydown" && n.onkeydown) n.onkeydown(ev);
    if(t === "click" && n.onclick && n !== this) {}
    if(t === "click" && n.onclick) n.onclick(ev);
    n = n.parentNode;
  }
  if(!ev.stopped && n === null && t === "keydown") (window.listeners.keydown || []).slice().forEach(function(fn){ fn(ev); });
  return ev;
};
El.prototype.click = function(){ if(!this.disabled) this.fire("click"); };
El.prototype.key = function(key, extra){ var ev = Object.assign({key: key, code: key === "`" ? "Backquote" : key}, extra || {}); return this.fire("keydown", ev); };
function part(el, p){
  var m, re = /^([a-z0-9]*)((?:\.[\w-]+)*)((?:\[[^\]]+\])*)$/i; m = re.exec(p); if(!m) throw new Error("selector " + p);
  if(m[1] && String(el.tagName).toUpperCase() !== m[1].toUpperCase()) return false;
  var cls = m[2] ? m[2].split(".").filter(Boolean) : [];
  for(var i = 0; i < cls.length; i++) if(el._cls.split(/\s+/).indexOf(cls[i]) < 0) return false;
  var at = m[3] ? m[3].match(/\[[^\]]+\]/g) : [];
  for(var j = 0; j < at.length; j++){
    var a = /^\[([\w-]+)(?:=\"?([^\"\]]*)\"?)?\]$/.exec(at[j]);
    var v = a[1] === "hidden" ? (el.hidden ? "" : null) : el.getAttribute(a[1]);
    if(a[1] === "href" && v == null && el.href) v = el.href;
    if(v == null) return false; if(a[2] !== undefined && v !== a[2]) return false;
  }
  return true;
}
function matches(el, sel){ return sel.split(",").some(function(s){ return part(el, s.trim()); }); }
function all(root){ var out = []; (function walk(n){ n.children.forEach(function(c){ out.push(c); walk(c); }); })(root); return out; }
El.prototype.querySelectorAll = function(sel){
  var self = this;
  return all(this).filter(function(el){
    return sel.split(",").some(function(one){
      var parts = one.trim().split(/\s+/);
      if(!part(el, parts[parts.length - 1])) return false;
      if(parts.length === 1) return true;
      var p = el.parentNode; while(p && p !== self){ if(part(p, parts[0])) return true; p = p.parentNode; } return false;
    });
  });
};
El.prototype.querySelector = function(sel){ return this.querySelectorAll(sel)[0] || null; };
globalThis.document = {activeElement: null, head: new El("head"), body: new El("body"), documentElement: new El("html"),
  createElement: function(t){ return new El(t); }, createElementNS: function(ns, t){ return new El(t, ns); },
  createTextNode: function(t){ var e = new El("#text"); e._text = String(t); return e; },
  contains: function(n){ return document.body.contains(n) || document.head.contains(n); },
  getElementById: function(id){ return all(this.head).concat(all(this.body)).filter(function(e){ return e.id === id; })[0] || null; }};
globalThis.window = {HQV: {}, document: globalThis.document, CONFIG: {}, listeners: {},
  addEventListener: function(t, fn){ (this.listeners[t] = this.listeners[t] || []).push(fn); },
  removeEventListener: function(t, fn){ this.listeners[t] = (this.listeners[t] || []).filter(function(f){ return f !== fn; }); }};
const STORE = {};
window.localStorage = {getItem: function(k){ return k in STORE ? STORE[k] : null; }, setItem: function(k, v){ STORE[k] = String(v); }, removeItem: function(k){ delete STORE[k]; }};
function load(p){ new Function(fs.readFileSync(%(root)s + "/" + p, "utf8"))(); }
function find(root, text){ return all(root).filter(function(e){ return e.tagName === "BUTTON" && e.textContent === text; })[0] || null; }
function byLabel(root, l){ return all(root).filter(function(e){ return e.getAttribute("aria-label") === l; })[0] || null; }
function byCls(root, c){ return root.querySelectorAll("." + c); }
"""

# a fake transit network: a tram T1 (a-b-c), a metro M1 (m1-m2-m3, m2 and m3 below ground) crossing the tram at b/m2,
# a link line IL to the Commons
FAKE = r"""
function svc(mode, lines, stops, extra){
  var S = {mode: mode, lines: function(){ return lines; }, stops: function(){ return stops; },
    stopsNear: function(x, z, r){ return stops.map(function(s){ return {id: s.id, name: s.name, mode: mode, lines: s.lines, dist: Math.hypot(s.x - x, s.z - z)}; })
      .filter(function(s){ return s.dist <= r; }).sort(function(a, b){ return a.dist - b.dist; }); },
    departures: function(id, ms, n){ return [0, 1, 2, 3, 4].slice(0, n).map(function(k){ return {line: lines[0].id, short: lines[0].short, to: stops[stops.length - 1].name, at: ms + 30000 + k*300000, plat: "1", boarding: k === 0 && id === "b", delay: 0}; }); },
    vehicles: function(ms){ return [{id: mode + "-v1", line: lines[0].id, mode: mode, x: stops[0].x, y: 0, z: stops[0].z + (ms % 1000), yaw: 0, speed: 8, doors: 0, load: 0.4, under: false}]; }};
  return Object.assign(S, extra || {});
}
const TRAM = svc("tram", [{id: "T1", mode: "tram", name: "Harbour - Hill", short: "T1", color: "#2a9d8f", stops: ["a", "b", "c"], headway: 300, loop: false}],
  [{id: "a", name: "Harbour Street", x: 0, y: 0, z: 0, mode: "tram", lines: ["T1"], kind: "stop", under: false},
   {id: "b", name: "Central", x: -400, y: 0, z: 0, mode: "tram", lines: ["T1"], kind: "stop", under: false},
   {id: "c", name: "Hill Square", x: -800, y: 0, z: 0, mode: "tram", lines: ["T1"], kind: "stop", under: false}]);
const METRO = svc("metro", [{id: "M1", mode: "metro", name: "Red", short: "M1", color: "#d62828", stops: ["m1", "m2", "m3"], headway: 120, loop: false}],
  [{id: "m1", name: "North Gate", x: -400, y: -14, z: 600, mode: "metro", lines: ["M1"], kind: "station", under: false},
   {id: "m2", name: "Central", x: -410, y: -14, z: 20, mode: "metro", lines: ["M1"], kind: "station", under: true},
   {id: "m3", name: "South Park", x: -400, y: -14, z: -600, mode: "metro", lines: ["M1"], kind: "station", under: true}]);
const RIDE = {
  _svc: [TRAM, METRO], services: function(){ return this._svc; },
  stopsNear: function(x, z, r){ var o = []; this._svc.forEach(function(s){ o = o.concat(s.stopsNear(x, z, r)); }); return o.sort(function(a, b){ return a.dist - b.dist; }); },
  plan: function(from, to, ms){
    var T = 1700000000000;
    return [
      {legs: [{mode: "walk", from: {x: 0, z: 0}, to: {x: 0, z: 0, name: "Harbour Street", stop: "a"}, secs: 60},
              {mode: "tram", line: "T1", short: "T1", from: "a", to: "b", fromName: "Harbour Street", toName: "Central", depart: ms + 120000, reach: ms + 300000},
              {mode: "metro", line: "M1", short: "M1", from: "m2", to: "m3", fromName: "Central", toName: "South Park", depart: ms + 420000, reach: ms + 600000}],
       depart: ms + 120000, leave: ms + 60000, reach: ms + 660000, changes: 1},
      {legs: [{mode: "tram", line: "T1", short: "T1", from: "a", to: "c", fromName: "Harbour Street", toName: "Hill Square", depart: ms + 60000, reach: ms + 700000}],
       depart: ms + 60000, leave: ms + 60000, reach: ms + 760000, changes: 0},
      {legs: [{mode: "link", line: "IL", short: "IL", from: "il", to: "cc", fromName: "Central", toName: "Commons Central", depart: ms + 300000, reach: ms + 900000, world: "claude-hq@3"}],
       depart: ms + 300000, leave: ms + 200000, reach: ms + 900000, changes: 0, world: "claude-hq@3"},
      {legs: [], depart: ms, reach: ms + 999999, changes: 0}
    ].slice(0, to && to.none ? 0 : 3);
  },
  tickets: (function(){ var L = []; return {add: function(t){ t.id = t.id || "T" + (L.length + 1); L.unshift(t); return t; }, list: function(){ return L.slice(); }, remove: function(id){ L = L.filter(function(t){ return t.id !== id; }); return true; }}; })(),
  achievements: {list: function(){ return [{id: "mole", name: "Mole", desc: "Ride a metro line end to end.", done: true, progress: 1},
                                            {id: "cabbie", name: "Cabbie", desc: "Drive 10 fares.", done: false, progress: 0.3}]; }}
};
const SAID = [], TRACKED = [], STARTED = [];
function makeHost(o){
  o = o || {};
  return Object.assign({announce: function(t){ SAID.push(t); }, toast: function(){}, now: function(){ return 1761300000000; },
    clock: function(){ return {h: 14, m: 5}; }, calm: function(){ return !!o.calm; }, reducedMotion: function(){ return false; },
    inCity: function(){ return o.inCity !== false; }, me: function(){ return {x: 10, z: 0, world: "user:abc@3", userId: "u1"}; },
    ride: RIDE, startRide: function(p){ STARTED.push(p); return {phase: "walk"}; },
    places: function(){ return [{id: "hq", name: "Your HQ", x: 100, z: 100, kind: "myhq"}, {id: "park", label: "City Park", x: -300, z: 50, kind: "park"}]; },
    air: {flights: function(ms){ return [{id: "IH12", to: "Commons", at: ms + 3600000}, {id: "IH14", to: "Isle B", at: ms + 7200000}]; },
          checkIn: function(f){ return {gate: "C4", boardsAt: f.at - 1200000}; }},
    travel: {link: function(w){ STARTED.push({link: w}); return {}; }},
    track: function(id){ TRACKED.push(id); return true; }, sfx: function(){}, selfie: function(){}}, o.extra || {});
}
"""


@unittest.skipUnless(NODE, "node not installed")
class Model(unittest.TestCase):
    def test_queue_registry_nav_badges(self):
        out = run(r"""
// an app pushed before the shell loads, one after it
(window.HQV.hqPhoneQueue = window.HQV.hqPhoneQueue || []).push({id: "early", name: "Early", order: 50, render: function(){}});
load("games/hqphone.js");
const P = window.HQV.hqPhone, M = P.model, o = {};
o.afterLoad = P.registry.list().map(function(a){ return a.id; });
o.queueLeft = window.HQV.hqPhoneQueue.length;
window.HQV.hqPhoneQueue.push({id: "late", name: "Late", order: 5, dock: true, render: function(){}});
window.HQV.hqPhoneQueue.push({id: "bad", name: "No render"});
window.HQV.hqPhoneQueue.push({id: "early", name: "Early 2", order: 50, render: function(){}});
o.afterPush = P.registry.list().map(function(a){ return [a.id, a.name]; });
o.grid = P.registry.grid().map(function(a){ return a.id; }); o.dock = P.registry.dock().map(function(a){ return a.id; });
// a fresh registry and queue: drain, then a late push, a second ingest adds no second hook
const R = M.createRegistry(), Qx = [{id: "b", order: 2, render: function(){}}, {id: "a", order: 2, render: function(){}}, {id: "c", order: 1, render: function(){}}];
let adds = 0;
o.drained = M.ingest(R, Qx, function(){ adds++; }); M.ingest(R, Qx, function(){ adds++; });
Qx.push({id: "z", order: 0, render: function(){}});
o.order = R.list().map(function(a){ return a.id; }); o.adds = adds; o.qlen = Qx.length;
// nav
const N = M.createNav();
o.n0 = N.back(); N.open("tickets"); N.open("map", {x: 1}); N.open("tickets");
o.nIds = N.ids(); o.b1 = N.back(); o.b2 = N.back(); o.b3 = N.back();
N.open("a"); N.open("a", {k: 2}); o.same = [N.depth(), N.top().arg];
// badges
const apps = [{id: "messages", badge: function(){ return 3; }}, {id: "phone", badge: function(){ return 1; }}, {id: "map"}, {id: "boom", badge: function(){ throw new Error("x"); }}];
o.b = M.badgeTotals(apps, {}, {}); o.bx = M.badgeTotals(apps, {phone: 0, map: 4}, {}); o.bneg = M.badgeTotals([{id: "x"}], {x: -5}, {});
o.gated = [M.gated({needsCity: true}, false), M.gated({needsCity: true}, true), M.gated({needsCity: false}, false), M.gated(null, false)];
o.clock = [M.clockText({h: 14, m: 5}, true), M.clockText({h: 14, m: 5}, false), M.clockText({h: 0, m: 7}, false), M.clockText({h: 9, m: 0}, true), M.clockText(null, true)];
o.moves = [M.gridMove(0, "ArrowRight", 10, 4), M.gridMove(9, "ArrowRight", 10, 4), M.gridMove(1, "ArrowDown", 10, 4), M.gridMove(7, "ArrowDown", 10, 4),
           M.gridMove(5, "ArrowUp", 10, 4), M.gridMove(2, "ArrowUp", 10, 4), M.gridMove(3, "Home", 10, 4), M.gridMove(3, "End", 10, 4), M.gridMove(3, "x", 10, 4)];
o.owns = [M.ownsKey(true, {type: "keydown", key: "w"}), M.ownsKey(false, {type: "keydown", key: "w"}), M.ownsKey(true, {type: "keyup"}), M.ownsKey(true, {type: "mousedown"})];
// prefs: localStorage over CONFIG, host hooks win
window.CONFIG.phoneClock24 = true;
o.p0 = P.prefs.get("phoneClock24"); P.prefs.set("phoneClock24", false); o.p1 = [P.prefs.get("phoneClock24"), window.CONFIG.phoneClock24];
o.pbad = P.prefs.set("cabClass", "rocket"); o.pcab = P.prefs.get("cabClass");
o.phost = P.prefs.get("cabClass", {settings: {get: function(k){ return k === "cabClass" ? "lux" : undefined; }}});
console.log(JSON.stringify(o));
""")
        self.assertEqual(out["afterLoad"], ["early"])
        self.assertEqual(out["queueLeft"], 0)                    # drained
        self.assertEqual(out["afterPush"], [["late", "Late"], ["early", "Early 2"]])   # late push lands; same id replaces; bad ignored
        self.assertEqual(out["grid"], ["early"])
        self.assertEqual(out["dock"], ["late"])
        self.assertEqual(out["drained"], 3)
        self.assertEqual(out["order"], ["z", "c", "a", "b"])     # order, then id
        self.assertEqual(out["adds"], 4)                          # three drained + one late push, not doubled
        self.assertEqual(out["qlen"], 0)
        self.assertEqual(out["n0"], "close")                      # Esc on home closes
        self.assertEqual(out["nIds"], ["map", "tickets"])         # reopening brings it to the top, no loops
        self.assertEqual([out["b1"], out["b2"], out["b3"]], ["map", "home", "close"])
        self.assertEqual(out["same"], [1, {"k": 2}])
        self.assertEqual(out["b"]["total"], 4)
        self.assertEqual(out["b"]["by"], {"messages": 3, "phone": 1, "map": 0, "boom": 0})
        self.assertEqual(out["bx"]["by"], {"messages": 3, "phone": 0, "map": 4, "boom": 0})   # explicit wins
        self.assertEqual(out["bx"]["total"], 7)
        self.assertEqual(out["bneg"]["total"], 0)
        self.assertEqual(out["gated"], [True, False, False, False])
        self.assertEqual(out["clock"], ["14:05", "2:05", "12:07", "09:00", "00:00"])
        self.assertEqual(out["moves"], [1, 9, 5, 7, 1, 2, 0, 9, -1])
        self.assertEqual(out["owns"], [True, False, True, False])
        self.assertTrue(out["p0"])
        self.assertEqual(out["p1"], [False, False])
        self.assertFalse(out["pbad"])
        self.assertEqual(out["pcab"], "go")
        self.assertEqual(out["phost"], "lux")


@unittest.skipUnless(NODE, "node not installed")
class Shell(unittest.TestCase):
    def test_mount_open_close_keys_gate_badges_banner(self):
        out = run(FAKE + r"""
load("games/hqphone.js");
const P = window.HQV.hqPhone, o = {};
const stage = document.body.appendChild(document.createElement("div"));
const opener = document.body.appendChild(document.createElement("button")); opener.focus();
window.HQV.hqPhoneQueue.push({id: "msgs", name: "Messages", order: 20, dock: true, glyph: "M4 5h16v12H4z", render: function(el, host, nav){
  var p = document.createElement("p"); p.textContent = "inbox"; el.appendChild(p);
  var b = document.createElement("button"); b.textContent = "Open map"; b.addEventListener("click", function(){ nav.open("tmap"); }); el.appendChild(b);
  return {dispose: function(){ o.disposed = (o.disposed || 0) + 1; }}; }, badge: function(){ return 2; }});
window.HQV.hqPhoneQueue.push({id: "tmap", name: "Transit map", order: 32, needsCity: true, glyph: "M4 6h16", render: function(el){ var p = document.createElement("p"); p.textContent = "the map"; el.appendChild(p); return {}; }});
const host = makeHost({inCity: false});
const ui = P.mount(stage, host);
const back = document.getElementById("phoneBack");
o.hiddenAtStart = back.hidden; o.isOpen0 = ui.isOpen();
o.owns0 = ui.owns({type: "keydown", key: "w", target: document.body});
ui.open();
o.isOpen1 = ui.isOpen(); o.backHidden = back.hidden;
const dev = back.querySelector(".hqphone");
o.role = [dev.getAttribute("role"), dev.getAttribute("aria-modal"), !!document.getElementById(dev.getAttribute("aria-labelledby"))];
o.owns1 = ui.owns({type: "keydown", key: "w", target: document.body});
o.clock = back.querySelector(".hqphone-clock").textContent;
o.statusHidden = back.querySelector(".hqphone-status").getAttribute("aria-hidden");
const icons = byCls(back, "hqphone-icon").map(function(b){ return [b.getAttribute("data-app"), b.getAttribute("aria-label"), b.tabIndex]; });
o.icons = icons;
o.focusIn = document.activeElement && document.activeElement.getAttribute("data-app");
o.badge = back.querySelector("[data-app=msgs]").querySelector(".hqphone-badge").textContent;
ui.badge("msgs", 0);
o.badge0 = [back.querySelector("[data-app=msgs]").querySelector(".hqphone-badge").textContent, ui.badgeTotal()];
ui.badge("msgs", null);
o.badgeAgain = ui.badgeTotal();
// a WASD key inside the phone does not bubble out
let leaked = 0; document.body.addEventListener("keydown", function(){ leaked++; });
const ev = document.activeElement.key("w");
o.leaked = leaked; o.marked = !!ev.hqPhoneHandled;
// open the needsCity app outside the City: the gate
back.querySelector("[data-app=tmap]").click();
o.gate = back.querySelector(".hqphone-gate") ? back.querySelector(".hqphone-gate").textContent : null;
o.title = back.querySelector(".hqphone-apptitle").textContent;
o.labelled = dev.getAttribute("aria-labelledby") === back.querySelector(".hqphone-apptitle").id;
// Esc goes back home, Esc again closes and focus returns to the opener
document.activeElement.key("Escape");
o.afterEsc1 = [ui.isOpen(), back.querySelector(".hqphone-home").hidden];
document.activeElement.key("Escape");
o.afterEsc2 = [ui.isOpen(), back.hidden, document.activeElement === opener];
o.owns2 = ui.owns({type: "keydown", key: "w", target: document.body});
// open straight to an app; app-to-app navigation; Back button; Backquote closes
ui.open("msgs");
o.app = back.querySelector(".hqphone-body").textContent.indexOf("inbox") >= 0;
find(back, "Open map").click();
o.stack = ui.top();
find(back, "Back").click();
o.backTo = ui.top();
document.activeElement.key("`");
o.afterTick = [ui.isOpen(), o.disposed];
// a late app shows on the home screen
ui.open();
window.HQV.hqPhoneQueue.push({id: "zz", name: "Zed", order: 99, render: function(){ return {}; }});
o.late = !!back.querySelector("[data-app=zz]");
// Esc while focus is outside (the canvas clicked) still closes
document.body.focus(); document.body.key("Escape");
o.outsideEsc = ui.isOpen();
// the backdrop click closes
ui.open(); back.fire("click"); o.backdrop = ui.isOpen();
// the banner: title announced, never the text
SAID.length = 0;
ui.notify({app: "msgs", title: "New message", text: "secret words"});
const bn = stage.querySelector(".hqphone-banner");
o.banner = [bn.hidden, bn.textContent.indexOf("secret words") >= 0, SAID.slice()];
bn.click(); o.bannerOpens = [ui.isOpen(), ui.top()];
ui.dispose();
o.gone = !document.getElementById("phoneBack");
console.log(JSON.stringify(o)); process.exit(0);
""")
        self.assertTrue(out["hiddenAtStart"])
        self.assertFalse(out["isOpen0"])
        self.assertFalse(out["owns0"])                 # closed: the 3D view keeps its keys
        self.assertTrue(out["isOpen1"])
        self.assertFalse(out["backHidden"])
        self.assertEqual(out["role"], ["dialog", "true", True])
        self.assertTrue(out["owns1"])                  # open: WASD does not walk
        self.assertEqual(out["clock"], "2:05")         # 12 h by default
        self.assertEqual(out["statusHidden"], "true")
        ids = [i[0] for i in out["icons"]]
        self.assertEqual(ids, ["tmap", "msgs"])        # grid then dock
        self.assertEqual(out["icons"][1][1], "Messages, 2 new")
        self.assertEqual([i[2] for i in out["icons"]], [0, 0])   # one tab stop per group
        self.assertEqual(out["focusIn"], "tmap")
        self.assertEqual(out["badge"], "2")
        self.assertEqual(out["badge0"], ["", 0])
        self.assertEqual(out["badgeAgain"], 2)
        self.assertEqual(out["leaked"], 0)
        self.assertTrue(out["marked"])
        self.assertEqual(out["gate"], "Open the City to use this")
        self.assertEqual(out["title"], "Transit map")
        self.assertTrue(out["labelled"])
        self.assertEqual(out["afterEsc1"], [True, False])
        self.assertEqual(out["afterEsc2"], [False, True, True])
        self.assertFalse(out["owns2"])
        self.assertTrue(out["app"])
        self.assertEqual(out["stack"], "tmap")
        self.assertEqual(out["backTo"], "msgs")
        self.assertEqual(out["afterTick"], [False, 2])
        self.assertTrue(out["late"])
        self.assertFalse(out["outsideEsc"])
        self.assertFalse(out["backdrop"])
        self.assertFalse(out["banner"][0])
        self.assertTrue(out["banner"][1])              # shown on screen
        self.assertEqual(out["banner"][2], ["New message"])   # announced: the title only
        self.assertEqual(out["bannerOpens"], [True, "msgs"])
        self.assertTrue(out["gone"])


@unittest.skipUnless(NODE, "node not installed")
class AppModels(unittest.TestCase):
    def test_models(self):
        out = run(FAKE + r"""
load("games/hqphoneapps.js");
const A = window.HQV.hqPhoneApps, o = {};
const ms = Date.UTC(2026, 9, 24, 14, 0) - 330*60000;   // [3.23] 14:00 on the City's clock (Koramangala, IST)
const look = function(mode, id){ var s = null; [TRAM, METRO].forEach(function(v){ if(v.mode === mode) v.stops().forEach(function(t){ if(t.id === id) s = t; }); }); return s; };
const opts = RIDE.plan({x: 0, z: 0}, {x: 1, z: 1}, ms);
const pm = A.planModel(opts, ms, true, look);
o.n = pm.length; o.sum = pm.map(function(p){ return p.summary; }); o.badges = pm.map(function(p){ return p.badges; });
o.legs0 = pm[0].legs.map(function(l){ return [l.kind, l.text, l.sub, l.under, l.notes || []]; });
o.world = [pm[2].world, pm[2].legs[0].notes];
o.label = pm[0].label;
o.tooMany = A.planModel(opts.concat(opts), ms, true, look).length;
// departures: chips, favourites first (even far away), distances
A.favs.reset();
o.dAll = A.departuresModel(RIDE, {x: 10, z: 0}, ms, {favs: []}).map(function(r){ return [r.key, r.distText]; });
o.dTram = A.departuresModel(RIDE, {x: 10, z: 0}, ms, {chip: "tram", favs: []}).map(function(r){ return r.key; });
o.dRail = A.departuresModel(RIDE, {x: 10, z: 0}, ms, {chip: "rail", favs: []}).length;
o.togg = [A.favs.toggle("metro:m3"), A.favs.list(), A.favs.toggle("metro:m3"), A.favs.list()];
A.favs.toggle("metro:m3");
o.dFav = A.departuresModel(RIDE, {x: 10, z: 0}, ms, {favs: A.favs.list(), r: 100}).map(function(r){ return [r.key, r.fav]; });
o.chips = A.CHIPS.map(function(c){ return c.name; });
o.chipMatch = [A.chipMatch("rail", "link"), A.chipMatch("rail", "tram"), A.chipMatch("all", "x"), A.chipMatch("ferry", "ferry")];
o.board = A.boardModel(TRAM, "b", ms, true, 4);
o.boardNone = A.boardModel(null, "b", ms, true, 4);
// the map: north up (+z at the top), east (-x) on the right; interchange at Central (tram b + metro m2 within 60 m)
const water = {bodies: [{id: "lake:0", kind: "lake", poly: [-200, 100, -300, 100, -300, 200, -200, 200]}]};
const mm = A.mapModel([TRAM, METRO], {water: water});
const P = function(key){ return mm.stations.filter(function(s){ return s.keys.indexOf(key) >= 0; })[0]; };
o.harbour = [P("tram:a").u, P("tram:a").v]; o.hill = [P("tram:c").u, P("tram:c").v];
o.north = [P("metro:m1").v, P("metro:m3").v];
o.central = [P("tram:b").interchange, P("tram:b").lines, P("tram:b") === P("metro:m2")];
o.nStations = mm.stations.length;
o.inBox = mm.stations.every(function(s){ return s.u >= 40 && s.u <= 960 && s.v >= 40 && s.v <= 960; });
o.segs = mm.lines.map(function(l){ return [l.id, l.color, l.segs.map(function(s){ return [s.under, s.pts.length]; })]; });
o.water = mm.water.map(function(w){ return [w.kind, w.pts.length]; });
o.chipMap = A.mapModel([TRAM, METRO], {chip: "metro"}).lines.map(function(l){ return l.id; });
o.badColor = A.mapModel([svc("bus", [{id: "B1", short: "B1", color: "red;x", stops: ["a"]}], [{id: "a", name: "A", x: 0, z: 0}])], {}).lines[0].color;
const B = A.boundsOf([[0, 0], [-100, 50]]);
o.proj = [A.project(B, 0, 0), A.project(B, -100, 50)];
o.veh = A.vehiclesModel([TRAM, METRO], 500, mm.bounds, "all").map(function(v){ return [v.id, v.short, v.color]; });
o.vehTram = A.vehiclesModel([TRAM, METRO], 500, mm.bounds, "tram").length;
// check-in: seeded, preference kept, the same twice
o.seatW = A.seatFor("IH12", "u1", "window"); o.seatA = A.seatFor("IH12", "u1", "aisle"); o.seatW2 = A.seatFor("IH12", "u1", "window");
o.seatsWin = ["f1", "f2", "f3", "f4", "f5", "f6"].map(function(f){ return A.seatFor(f, "u", "window").slice(-1); });
o.seatsAisle = ["f1", "f2", "f3", "f4", "f5", "f6"].map(function(f){ return A.seatFor(f, "u", "aisle").slice(-1); });
o.gate = [A.gateFor("IH12"), A.gateFor("IH12"), A.gateFor("IH13")];
o.pat = [JSON.stringify(A.passPattern("x")) === JSON.stringify(A.passPattern("x")), JSON.stringify(A.passPattern("x")) === JSON.stringify(A.passPattern("y")), A.passPattern("x").bars.every(function(b){ return b.x + b.w <= 204; })];
o.notes = A.notesModel({entries: [{version: "3.9.0", title: "a", body: "x"}, {version: "3.15.0", title: "b", body: "y"}, {version: "3.10.2", title: "c"}, {title: "no version"}, {version: "3.10.10", title: "d", body: 5}]}).map(function(e){ return [e.version, e.body]; });
o.cmp = [A.cmpVersion("3.10.0", "3.9.9"), A.cmpVersion("3.9", "3.9.0"), A.cmpVersion("1.0.0", "1.0.0")];
o.ach = A.achModel(RIDE.achievements.list(), {score: 1234.4, fares: 7, rating: 4.86});
o.achNo = A.achModel([], null).driver;
o.fmt = [A.fmtMins(59), A.fmtMins(3700), A.fmtDist(950), A.fmtDist(1250), A.fmtDist(12500), A.fmtClock(ms, true), A.fmtClock(ms, false)];
console.log(JSON.stringify(o)); process.exit(0);
""")
        self.assertEqual(out["n"], 3)
        self.assertEqual(out["sum"][0], "14:01 - 14:11 · 11 min · 1 change")
        self.assertEqual(out["sum"][1], "14:01 - 14:12 · 13 min · direct")
        self.assertEqual(out["badges"], [["T1", "M1"], ["T1"], ["IL"]])
        l0 = out["legs0"]
        self.assertEqual(l0[0][:2], ["walk", "Walk 1 min to Harbour Street"])
        self.assertEqual(l0[1][1], "Tram T1: Harbour Street to Central")
        self.assertEqual(l0[1][2], "14:02 - 14:05")
        self.assertFalse(l0[1][3])
        self.assertTrue(l0[2][3])                      # the metro leg is below ground at both ends
        self.assertEqual(len(l0[2][4]), 2)
        self.assertIn("45 s", l0[2][4][0])
        self.assertEqual(out["world"][0], "claude-hq@3")
        self.assertIn("Island Link", out["world"][1][0])
        self.assertIn("by T1 then M1", out["label"])
        self.assertEqual(out["tooMany"], 3)
        self.assertEqual(out["dAll"][0], ["tram:a", "10 m"])
        self.assertEqual([k for k, _ in out["dAll"]], ["tram:a", "tram:b", "metro:m2", "metro:m1", "metro:m3", "tram:c"])
        self.assertEqual(out["dTram"], ["tram:a", "tram:b", "tram:c"])
        self.assertEqual(out["dRail"], 0)
        self.assertEqual(out["togg"], [True, ["metro:m3"], False, []])
        self.assertEqual(out["dFav"], [["metro:m3", True], ["tram:a", False]])   # a far favourite still shows, first
        self.assertEqual(out["chips"], ["All", "Bus", "Tram", "Metro", "Rail", "Ferry", "Gondola"])
        self.assertEqual(out["chipMatch"], [True, False, True, True])
        self.assertEqual(out["board"][0], {"badge": "T1", "dest": "Hill Square", "due": "boarding", "plat": "1"})
        self.assertEqual(out["board"][1]["due"], "5 min")
        self.assertEqual(len(out["board"]), 4)
        self.assertEqual(out["boardNone"], [])
        # Harbour (x 0) is east of Hill (x -800): -x is east, so Hill is on the right
        self.assertLess(out["harbour"][0], out["hill"][0])
        self.assertLess(out["north"][0], out["north"][1])    # m1 (z +600) above m3 (z -600)
        self.assertEqual(out["central"], [True, ["M1", "T1"], True])
        self.assertEqual(out["nStations"], 5)
        self.assertTrue(out["inBox"])
        self.assertEqual(out["segs"], [["T1", "#2a9d8f", [[False, 3]]], ["M1", "#d62828", [[False, 2], [True, 2]]]])
        self.assertEqual(out["water"], [["lake", 4]])
        self.assertEqual(out["chipMap"], ["M1"])
        self.assertIsNone(out["badColor"])
        (a, b) = out["proj"]
        self.assertLess(a[0], b[0])                      # x 0 -> left of x -100
        self.assertGreater(a[1], b[1])                   # z 0 -> below z 50
        self.assertEqual(out["veh"], [["metro-v1", "M1", "#d62828"], ["tram-v1", "T1", "#2a9d8f"]])
        self.assertEqual(out["vehTram"], 1)
        self.assertEqual(out["seatW"], out["seatW2"])
        self.assertIn(out["seatW"][-1], "AF")
        self.assertIn(out["seatA"][-1], "CD")
        self.assertTrue(all(s in "AF" for s in out["seatsWin"]))
        self.assertTrue(all(s in "CD" for s in out["seatsAisle"]))
        self.assertEqual(out["gate"][0], out["gate"][1])
        self.assertRegex(out["gate"][0], r"^[ABC]\d{1,2}$")
        self.assertEqual(out["pat"], [True, False, True])
        self.assertEqual(out["notes"], [["3.15.0", "y"], ["3.10.10", ""], ["3.10.2", ""], ["3.9.0", "x"]])
        self.assertEqual(out["cmp"], [1, -1, 0])
        self.assertEqual(out["ach"]["done"], 1)
        self.assertEqual(out["ach"]["items"][1]["pct"], 30)
        self.assertEqual(out["ach"]["driver"], {"score": 1234, "fares": 7, "rating": "4.9"})
        self.assertIsNone(out["achNo"])
        self.assertEqual(out["fmt"], ["1 min", "1 h 02 min", "950 m", "1.3 km", "13 km", "14:00", "2:00 pm"])


@unittest.skipUnless(NODE, "node not installed")
class AppsRendered(unittest.TestCase):
    def test_tickets_departures_map_settings(self):
        out = run(FAKE + r"""
load("games/hqphone.js"); load("games/hqphoneapps.js");
const A = window.HQV.hqPhoneApps, o = {};
const host = makeHost();
const nav = {back: function(){}, open: function(){}, title: function(){}, setBadge: function(){}, close: function(){ o.closed = true; }};
// Tickets: plan to a place, three options, Book (free) and Go
let el = document.body.appendChild(document.createElement("div"));
A.render.tickets(el, host, nav, null);
const tabs = el.querySelectorAll("[role=tab]").map(function(t){ return [t.textContent, t.getAttribute("aria-selected")]; });
o.tabs = tabs;
const selects = el.querySelectorAll("select");
o.toOptions = selects[1].querySelectorAll("option").map(function(x){ return x.textContent; });
selects[1].value = "p:park";
find(el, "Plan journey").click();
o.options = el.querySelectorAll(".hp-option").length;
o.optLabel = el.querySelector(".hp-option").getAttribute("aria-label");
o.legText = el.querySelector(".hp-option").querySelectorAll(".hp-legtext").map(function(x){ return x.textContent; });
byLabel(el.querySelector(".hp-option"), "Book option 1 (free)").click();
o.booked = RIDE.tickets.list().map(function(t){ return [t.kind, t.line, t.fromName, t.toName]; });
byLabel(el.querySelector(".hp-option"), "Go now with option 1").click();
o.started = STARTED.length; o.closed = !!o.closed;
// no destination chosen: says so
selects[1].value = ""; find(el, "Plan journey").click();
o.noDest = el.querySelector(".hp-results").textContent;
// My tickets
el.querySelectorAll("[role=tab]")[1].click();
o.mine = el.querySelectorAll(".hp-ticket").length;
// Check-in: window seat, a pass card with a decorative pattern
el.querySelectorAll("[role=tab]")[2].click();
o.flights = el.querySelectorAll(".hp-flight").map(function(f){ return f.textContent; });
find(el, "Check in").click();
const pass = el.querySelector(".hp-pass");
o.pass = [pass.getAttribute("aria-label"), pass.querySelector("svg").getAttribute("aria-hidden"), pass.querySelectorAll("rect").length > 5];
o.passTicket = RIDE.tickets.list()[0];
o.free = pass.textContent.indexOf("Free") >= 0 && el.textContent.indexOf("coin") < 0;
// Departures: chips (a radiogroup), expand to a real table, favourites
let el2 = document.body.appendChild(document.createElement("div"));
const dep = A.render.departures(el2, host, nav);
const rg = el2.querySelector("[role=radiogroup]");
o.chips = [rg.getAttribute("aria-label"), rg.querySelectorAll("[role=radio]").length, rg.querySelectorAll("[aria-checked=true]")[0].textContent];
o.stops = el2.querySelectorAll(".hp-stopname").map(function(x){ return x.textContent; });
const exp = el2.querySelector(".hp-stopbtn");
o.exp0 = exp.getAttribute("aria-expanded");
exp.click();
const tbl = el2.querySelector("table");
o.table = [exp.getAttribute("aria-expanded"), tbl.querySelectorAll("th").map(function(t){ return [t.textContent, t.getAttribute("scope")]; }), tbl.querySelectorAll("tbody tr").length, tbl.querySelector("caption").textContent];
dep.tick(Date.now() + 10000);
o.afterTick = el2.querySelector("table").querySelectorAll("tbody tr").length;
rg.querySelectorAll("[role=radio]")[3].click();      // Metro
o.metroStops = el2.querySelectorAll(".hp-stopname").map(function(x){ return x.textContent; });
const star = el2.querySelector(".hp-star"); star.click();
o.star = [star.getAttribute("aria-pressed"), A.favs.list()];
// arrows move the chip selection
rg.querySelectorAll("[role=radio]")[3].focus();
rg.key("ArrowRight");
o.arrow = rg.querySelectorAll("[aria-checked=true]")[0].textContent;
// Transit map: lines, stations, water, vehicles, the text list; a station shows its board; Track
window.HQV.world = {waterOf: function(){ return {bodies: [{id: "lake:0", kind: "lake", poly: [-200, 100, -300, 100, -300, 200, -200, 200]}]}; }};
const host2 = makeHost({extra: {doc: function(){ return {id: "w"}; }}});
let el3 = document.body.appendChild(document.createElement("div"));
const map = A.render.map(el3, host2, nav);
const svg = el3.querySelector("svg");
o.map = [svg.querySelectorAll("polyline").length, svg.querySelectorAll(".hp-line-under").length, svg.querySelectorAll(".hp-ring").length,
         svg.querySelectorAll(".hp-tick").length, svg.querySelectorAll("polygon").length, svg.querySelectorAll(".hp-veh").length,
         svg.querySelectorAll("polyline")[0].style.stroke];
o.vstyle = svg.querySelectorAll(".hp-veh")[0].style.transform;
const v0 = svg.querySelectorAll(".hp-veh")[0].style.transform;
map.tick(1761300000000 + 400); map.tick(1761300000000 + 1500);
o.vmoved = svg.querySelectorAll(".hp-veh")[0].style.transform !== v0;
o.list = el3.querySelector("details").querySelectorAll("button").map(function(b){ return b.textContent; });
el3.querySelector("details").querySelectorAll("button")[1].click();
o.stationBoard = [el3.querySelector(".hp-dtitle").textContent, el3.querySelector(".hp-mapdetail").querySelectorAll("table").length];
svg.querySelectorAll(".hp-veh")[0].fire("click");
find(el3, "Track").click();
o.tracked = TRACKED.slice();
const vb0 = svg.getAttribute("viewBox");
find(el3, "+").click(); const vb1 = svg.getAttribute("viewBox");
svg.key("ArrowRight"); const vb2 = svg.getAttribute("viewBox");
o.zoom = [vb0, vb1 !== vb0, vb2 !== vb1];
// Settings: local prefs and the social opt-ins with their "what is shared" lines
const soc = {on: {smsSend: false, near: true, calls: false}, enabled: function(){ return this.on; }, setEnabled: function(k, v){ this.on[k] = v; o.setEn = [k, v]; return Promise.resolve({ok: true}); }};
let el4 = document.body.appendChild(document.createElement("div"));
A.render.settings(el4, makeHost({extra: {social: soc}}), nav);
const boxes = el4.querySelectorAll("input");
o.settings = boxes.map(function(b){ return [b.parentNode.textContent.trim(), b.checked, !!document.getElementById(b.getAttribute("aria-describedby"))]; });
boxes[2].checked = true; boxes[2].fire("change");
o.clock24 = window.HQV.hqPhone.prefs.get("phoneClock24");
boxes[3].checked = true; boxes[3].fire("change");
await new Promise(function(r){ setTimeout(r, 5); });
o.cab = el4.querySelector("select").value;
// Achievements and Patch notes render without a City
let el5 = document.body.appendChild(document.createElement("div"));
window.HQV.hqCabs = {driverStats: function(){ return {score: 50, fares: 2, rating: 5}; }};
A.render.achievements(el5, host, nav);
o.ach = [el5.querySelectorAll("[role=progressbar]").map(function(p){ return p.getAttribute("aria-valuenow"); }), el5.querySelector(".hp-driver").textContent];
window.fetch = function(url){ o.fetched = url; return Promise.resolve({json: function(){ return Promise.resolve(JSON.parse(fs.readFileSync(%(root)s + "/games/patchnotes.json", "utf8"))); }}); };
let el6 = document.body.appendChild(document.createElement("div"));
A.render.notes(el6, host, nav);
await new Promise(function(r){ setTimeout(r, 5); });
const det = el6.querySelectorAll("details");
o.notes = [det.length, det[0].open, det[1].open, det[0].querySelector("summary").textContent];
// registered apps
o.ids = window.HQV.hqPhone.registry.list().map(function(a){ return [a.id, a.dock, a.needsCity]; });
console.log(JSON.stringify(o)); process.exit(0);
""")
        self.assertEqual(out["tabs"], [["Plan", "true"], ["My tickets", "false"], ["Check-in", "false"]])
        self.assertIn("Your HQ", out["toOptions"])
        self.assertIn("City Park", out["toOptions"])
        self.assertIn("Central (Tram)", out["toOptions"])
        self.assertIn("The Commons (Island Link)", out["toOptions"])   # you are on an island
        self.assertEqual(out["options"], 3)
        self.assertIn("Option 1", out["optLabel"])
        self.assertEqual(out["legText"][0], "Walk 1 min to Harbour Street")
        self.assertEqual(out["booked"], [["ticket", "T1 > M1", "Harbour Street", "South Park"]])
        self.assertEqual(out["started"], 1)
        self.assertTrue(out["closed"])
        self.assertIn("Choose a destination", out["noDest"])
        self.assertEqual(out["mine"], 2)               # Book + Go both keep a free ticket
        self.assertEqual(len(out["flights"]), 2)
        self.assertIn("seat", out["pass"][0])
        self.assertIn("gate C4", out["pass"][0])
        self.assertEqual(out["pass"][1], "true")
        self.assertTrue(out["pass"][2])
        self.assertEqual(out["passTicket"]["kind"], "pass")
        self.assertIn(out["passTicket"]["seat"][-1], "AF")   # window by default
        self.assertTrue(out["free"])
        self.assertEqual(out["chips"], ["Modes", 7, "All"])
        self.assertEqual(out["stops"][0], "Harbour Street")
        self.assertEqual(out["exp0"], "false")
        self.assertEqual(out["table"][0], "true")
        self.assertEqual(out["table"][1], [["Line", "col"], ["To", "col"], ["Plat.", "col"], ["Due", "col"]])
        self.assertEqual(out["table"][2], 4)
        self.assertEqual(out["table"][3], "Departures from Harbour Street")
        self.assertEqual(out["afterTick"], 4)
        self.assertEqual(out["metroStops"], ["Central", "North Gate", "South Park"])
        self.assertEqual(out["star"], ["true", ["metro:m2"]])
        self.assertEqual(out["arrow"], "Rail")
        self.assertEqual(out["map"][:6], [3, 1, 1, 4, 1, 2])
        self.assertEqual(out["map"][6], "#2a9d8f")
        self.assertTrue(out["vstyle"].startswith("translate("))
        self.assertTrue(out["vmoved"])
        self.assertIn("Central (change for M1)", out["list"])
        self.assertEqual(out["stationBoard"], ["Central", 1])
        self.assertEqual(out["tracked"], ["metro-v1"])
        self.assertEqual(out["zoom"], ["0.0 0.0 1000.0 1000.0", True, True])
        st = out["settings"]
        self.assertEqual([s[0] for s in st], ["Transit voice", "Announcements as text only", "24-hour clock",
                                              "Send text messages (SMS)", "Nearby chat", "Calls"])
        self.assertEqual([s[1] for s in st], [True, False, False, False, True, False])
        self.assertTrue(all(s[2] for s in st))          # every switch says what it shares
        self.assertTrue(out["clock24"])
        self.assertEqual(out["setEn"], ["smsSend", True])
        self.assertEqual(out["cab"], "go")
        self.assertEqual(out["ach"][0], ["100", "30"])
        self.assertIn("Score50", out["ach"][1])
        # one <details> per entry, newest open; summary reads "<version> <title>" — all from the file
        _n = json.loads(read("games", "patchnotes.json"))["entries"]
        self.assertEqual(out["notes"][0], len(_n))
        self.assertTrue(out["notes"][1])
        self.assertFalse(out["notes"][2])
        self.assertEqual(out["notes"][3], _n[0]["version"] + " " + _n[0]["title"])
        ids = {i[0]: i for i in out["ids"]}
        for k in ("tickets", "departures", "map", "achievements", "notes", "settings"):
            self.assertIn(k, ids)
        self.assertTrue(ids["tickets"][1])              # in the dock
        self.assertTrue(ids["map"][2])                  # needs the City
        self.assertFalse(ids["notes"][2])


class Static(unittest.TestCase):
    def test_patchnotes(self):
        j = json.loads(read("games", "patchnotes.json"))
        e = j["entries"]
        self.assertGreaterEqual(len(e), 8)
        self.assertTrue(e[0]["title"])
        # the newest note is the version we ship, so the phone's Notes app never opens stale
        app = read("dashboard-rs", "src", "app.rs")
        self.assertIn('APP_VERSION: &str = "%s"' % e[0]["version"], app)
        for x in e:
            self.assertIsInstance(x["version"], str)
            self.assertIsInstance(x["title"], str)
            self.assertIsInstance(x["body"], str)
            self.assertNotIn("**", x["body"])
            self.assertNotIn("<", x["title"])
        ver = [tuple(int(p) for p in x["version"].split(".")) for x in e]
        self.assertEqual(ver, sorted(ver, reverse=True))     # newest first
        self.assertNotIn("coin", e[0]["body"].replace("no coins", ""))   # everything free (D4)

    def test_no_innerhtml_no_random(self):
        for f in FILES:
            src = read(*f.split("/"))
            self.assertNotRegex(src, r"\.innerHTML|outerHTML|insertAdjacentHTML|document\.write", f)
            self.assertNotIn("Math.random", src, f)

    def test_css_tokens_and_motion_gates(self):
        css = read("games", "hqphone.css")
        self.assertNotRegex(css, r"#[0-9a-fA-F]{3,8}\b")     # tokens only
        for anim in ("hqphone-up", "hqphone-drop", "hg-flash"):
            self.assertIn(anim, css)
        self.assertIn("html.hq-calm", css)
        self.assertIn("prefers-reduced-motion: reduce", css)
        self.assertIn("html.hq-large-text", css)
        self.assertIn("max-width: 600px", css)
        self.assertIn("width:360px", css)
        self.assertIn("border-radius:22px", css)


if __name__ == "__main__":
    unittest.main()
