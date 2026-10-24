"""The phone's comms apps (games/hqphonecomms.js) and the page's social side (ui/app/41-phone.js), HQ 3.15
(docs/plans/transport-revamp.md 3.12 apps 7-9, 5.11).

node: the pure helpers (the 160 / 200 counters, times, the contact merge, bubble expiry, the opt-in gate, the call
screen's words); the three apps rendered into a tiny DOM shim against a fake host and a fake hqPhoneSocial (Messages:
threads, a thread, the first send asking for the opt-in then sending, Esc back; Nearby: the opt-in gate, the 200
counter, posting; Phone: an incoming call, the ring sound, accept, the service numbers); and 41-phone.js's store
(threads deduped and capped, unread, mute, block, the toast never carrying the text unless Messages is open, the
announcement carrying the count only, the opt-in 409). Python: neither file ever touches innerHTML.
Skipped when node is not installed. Stdlib only."""
import json
import os
import re
import shutil
import subprocess
import unittest

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
NODE = shutil.which("node")


def read(*p):
    with open(os.path.join(ROOT, *p), encoding="utf-8") as f:
        return f.read()


def run(script):
    env = dict(os.environ, TZ="UTC")
    r = subprocess.run([NODE, "--input-type=module", "-"], input=script % {"root": json.dumps(ROOT)},
                       capture_output=True, text=True, cwd=ROOT, timeout=60, env=env)
    if r.returncode != 0:
        raise AssertionError(r.stderr or r.stdout)
    return json.loads(r.stdout.strip().splitlines()[-1])


# A DOM just big enough for the apps: elements, text, attributes, events, and the selectors the apps use
# (tag, .class, [attr], [attr=value], one descendant step). Setting innerHTML throws.
DOM = r"""
function El(tag){ this.tagName = String(tag).toUpperCase(); this.children = []; this.parentNode = null; this.attrs = {};
  this.className = ""; this._text = ""; this.listeners = {}; this.style = {}; this.value = ""; this.tabIndex = 0; this.disabled = false; }
Object.defineProperty(El.prototype, "innerHTML", {set: function(){ throw new Error("innerHTML used"); }, get: function(){ return ""; }});
Object.defineProperty(El.prototype, "firstChild", {get: function(){ return this.children[0] || null; }});
Object.defineProperty(El.prototype, "textContent", {
  get: function(){ return this._text + this.children.map(function(c){ return c.textContent; }).join(""); },
  set: function(v){ this.children.forEach(function(c){ c.parentNode = null; }); this.children = []; this._text = String(v); }});
Object.defineProperty(El.prototype, "id", {get: function(){ return this.attrs.id || ""; }, set: function(v){ this.attrs.id = String(v); }});
Object.defineProperty(El.prototype, "classList", {get: function(){ var el = this; return {contains: function(c){ return el.className.split(/\s+/).indexOf(c) >= 0; }}; }});
El.prototype.appendChild = function(c){ if(c.parentNode) c.parentNode.removeChild(c); c.parentNode = this; this.children.push(c); return c; };
El.prototype.removeChild = function(c){ var i = this.children.indexOf(c); if(i >= 0) this.children.splice(i, 1); c.parentNode = null; return c; };
El.prototype.setAttribute = function(k, v){ this.attrs[k] = String(v); };
El.prototype.getAttribute = function(k){ return k in this.attrs ? this.attrs[k] : (k === "class" ? this.className : null); };
El.prototype.addEventListener = function(t, fn){ (this.listeners[t] = this.listeners[t] || []).push(fn); };
El.prototype.contains = function(n){ while(n){ if(n === this) return true; n = n.parentNode; } return false; };
El.prototype.focus = function(){ document.activeElement = this; };
El.prototype.fire = function(t, ev){ ev = ev || {}; ev.preventDefault = function(){}; ev.target = this;
  (this.listeners[t] || []).forEach(function(fn){ fn(ev); }); if(t === "keydown" && this.onkeydown) this.onkeydown(ev);
  if(t === "keydown" && this.parentNode && this.parentNode.onkeydown) this.parentNode.onkeydown(ev); };
El.prototype.click = function(){ if(!this.disabled) this.fire("click"); };
function part(el, p){
  var m, re = /^([a-z0-9]*)((?:\.[\w-]+)*)((?:\[[^\]]+\])*)$/i; m = re.exec(p); if(!m) throw new Error("selector " + p);
  if(m[1] && el.tagName !== m[1].toUpperCase()) return false;
  var cls = m[2] ? m[2].split(".").filter(Boolean) : [];
  for(var i = 0; i < cls.length; i++) if(el.className.split(/\s+/).indexOf(cls[i]) < 0) return false;
  var at = m[3] ? m[3].match(/\[[^\]]+\]/g) : [];
  for(var j = 0; j < at.length; j++){
    var a = /^\[([\w-]+)(?:=\"?([^\"\]]*)\"?)?\]$/.exec(at[j]); var v = el.getAttribute(a[1]);
    if(v == null) return false; if(a[2] !== undefined && v !== a[2]) return false;
  }
  return true;
}
function all(root){ var out = []; (function walk(n){ n.children.forEach(function(c){ out.push(c); walk(c); }); })(root); return out; }
El.prototype.querySelectorAll = function(sel){
  var parts = sel.trim().split(/\s+/), self = this;
  return all(this).filter(function(el){
    if(!part(el, parts[parts.length - 1])) return false;
    if(parts.length === 1) return true;
    var p = el.parentNode; while(p && p !== self){ if(part(p, parts[0])) return true; p = p.parentNode; } return false;
  });
};
El.prototype.querySelector = function(sel){ return this.querySelectorAll(sel)[0] || null; };
globalThis.document = {activeElement: null, head: new El("head"), body: new El("body"), documentElement: new El("html"),
  createElement: function(t){ return new El(t); }, createTextNode: function(t){ var e = new El("#text"); e._text = String(t); return e; },
  getElementById: function(id){ return all(this.head).concat(all(this.body)).filter(function(e){ return e.id === id; })[0] || null; }};
globalThis.window = {HQV: {}, document: globalThis.document, CONFIG: {}};
function find(root, text){ return all(root).filter(function(e){ return e.tagName === "BUTTON" && e.textContent === text; })[0] || null; }
function texts(root){ return root.textContent; }
"""


@unittest.skipUnless(NODE, "node not installed")
class Pure(unittest.TestCase):
    def test_helpers(self):
        out = run(r"""
import fs from "fs";
const root = %(root)s;
globalThis.window = {HQV: {}};
new Function(fs.readFileSync(root + "/games/hqphonecomms.js", "utf8"))();
const P = window.HQV.hqPhoneComms, o = {};
o.c1 = P.counter("  hi  ", 160); o.c2 = P.counter("\u{1F44B}".repeat(160), 160); o.c3 = P.counter("x".repeat(201), 200);
o.c4 = P.counter(null, 160);
const noon = Date.UTC(2026, 9, 23, 12, 5);
o.t24 = P.fmtTime(Date.UTC(2026, 9, 23, 14, 5), true, noon); o.t12 = P.fmtTime(Date.UTC(2026, 9, 23, 14, 5), false, noon);
o.tam = P.fmtTime(Date.UTC(2026, 9, 23, 0, 7), false, noon);
o.tweek = P.fmtTime(Date.UTC(2026, 9, 20, 9, 0), true, noon); o.told = P.fmtTime(Date.UTC(2026, 9, 3, 9, 0), true, noon);
o.d = [P.fmtDur(7), P.fmtDur(750), P.fmtDur(3723), P.fmtDur(-3)];
o.ticks = [P.tickLabel("sent"), P.tickLabel("delivered"), P.tickLabel(undefined)];
o.merge = P.mergeContacts([[{id: "b", name: "Bea"}, {id: "me", name: "Me"}], [{id: "b", name: "B2", handle: "bea"}, {id: "c", name: "Cy"}],
                           [{id: "x", name: "Blocked"}, {id: "d", handle: "dee"}], [{id: "c", name: "C3"}, null, {id: 5}]], "me", ["x"]);
o.mergeMax = P.mergeContacts([[{id: "a"}, {id: "b"}, {id: "c"}]], null, [], 2).map(function(c){ return c.id; });
o.bub = P.liveBubbles([{userId: "a", text: "hi", until: 10500}, {userId: "b", text: "x", until: 9000}, {userId: "c", text: "y", until: 12000}], 10000, false);
o.bubCalm = P.liveBubbles([{userId: "a", text: "hi", until: 10500}], 10000, true);
o.opt = [P.needsOptIn({smsSend: true}, "smsSend"), P.needsOptIn({smsSend: false}, "smsSend"), P.needsOptIn(null, "near"), P.needsOptIn({calls: "yes"}, "calls")];
o.calls = [P.callLabel("ringing", "in"), P.callLabel("ringing", "out"), P.callLabel("live", "out", 65), P.callLabel("declined", "out"),
           P.callLabel("missed", "in"), P.callLabel("ended"), P.callLabel("unreachable", "out")];
o.svc = P.SERVICES.map(function(s){ return [s.name, s.app, s.arg]; });
o.apps = (window.HQV.hqPhoneQueue || []).length;
console.log(JSON.stringify(o));
""")
        self.assertEqual(out["c1"], {"n": 2, "left": 158, "over": False, "label": "2/160"})
        self.assertEqual(out["c2"]["n"], 160)            # code points, as the Arena counts them
        self.assertFalse(out["c2"]["over"])
        self.assertTrue(out["c3"]["over"])
        self.assertEqual(out["c3"]["left"], -1)
        self.assertEqual(out["c4"]["n"], 0)
        self.assertEqual(out["t24"], "14:05")
        self.assertEqual(out["t12"], "2:05 pm")
        self.assertEqual(out["tam"], "12:07 am")
        self.assertEqual(out["tweek"], "Tue 09:00")
        self.assertEqual(out["told"], "3 Oct")
        self.assertEqual(out["d"], ["0:07", "12:30", "1:02:03", "0:00"])
        self.assertEqual(out["ticks"], ["Sent", "Delivered", "Sent"])
        m = out["merge"]
        self.assertEqual([c["id"] for c in m], ["b", "c", "d"])    # one each, in priority order, never me or blocked
        self.assertEqual(m[0]["name"], "Bea")                      # the first list's name wins
        self.assertEqual(m[0]["handle"], "bea")                    # a later list fills a missing handle
        self.assertEqual(m[0]["src"], [0, 1])
        self.assertEqual(m[1]["src"], [1, 3])
        self.assertEqual(m[2]["name"], "dee")
        self.assertEqual(out["mergeMax"], ["a", "b"])
        self.assertEqual([b["userId"] for b in out["bub"]], ["a", "c"])   # b expired
        self.assertAlmostEqual(out["bub"][0]["alpha"], 0.5)               # fading in its last second
        self.assertEqual(out["bub"][1]["alpha"], 1)
        self.assertEqual(out["bubCalm"][0]["alpha"], 1)                   # Calm: no fade
        self.assertEqual(out["opt"], [False, True, True, True])
        self.assertEqual(out["calls"], ["Incoming call", "Calling…", "1:05", "They declined", "Missed call", "Call ended",
                                        "They are not here right now"])
        self.assertEqual(out["svc"], [["Claude Cabs", "cabs", None], ["Dealership", "dealer", None],
                                      ["Heli dispatch", "cabs", {"cls": "heli"}], ["Water taxi", "cabs", {"cls": "water"}]])
        self.assertEqual(out["apps"], 0)   # no document: the pure half only


APPS = DOM + r"""
import fs from "fs";
const root = %(root)s;
// a fake hqPhoneSocial with the 5.11 shape
const calls = [], log = [];
const S = {
  en: {smsSend: false, near: false, calls: false},
  enabled(){ return Object.assign({}, this.en); },
  setEnabled(k, on){ calls.push(["setEnabled", k, on]); this.en[k] = on; return Promise.resolve({ok: true, on: on}); },
  sms: {
    T: {bob: [{id: "m1", me: false, text: "hey there", at: Date.UTC(2026, 9, 23, 9, 0), state: "delivered"}]},
    viewingNow: null, fns: [],
    threads(){ return [{id: "bob", name: "Bob", handle: "bobby", unread: 2, at: Date.UTC(2026, 9, 23, 9, 0), last: {text: "hey there", me: false}, muted: false, blocked: false}]; },
    thread(id){ return (this.T[id] || []).slice(); },
    viewing(v){ this.viewingNow = v; },
    touch(){}, MAX: 160,
    send(id, text){ calls.push(["send", id, text]);
      if(!S.en.smsSend) return Promise.resolve({ok: false, optIn: true});
      this.T[id] = (this.T[id] || []).concat([{id: "m2", me: true, text: text, at: Date.now(), state: "sent"}]);
      this.fns.forEach(function(f){ f(); }); return Promise.resolve({ok: true, id: "m2"}); },
    block(id, on){ calls.push(["block", id, on]); return Promise.resolve([]); }, blocked(){ return []; },
    mute(id, on){ calls.push(["mute", id, on]); }, muted(){ return []; },
    report(id, m){ calls.push(["report", id, m]); return Promise.resolve({ok: true}); },
    directory(q){ calls.push(["dir", q]); return Promise.resolve([{id: "zed", name: "Zed", handle: "zed"}]); },
    onChange(fn){ this.fns.push(fn); return function(){}; }, unread(){ return 2; }
  },
  near: {
    F: [], fns: [], MAX: 200,
    post(t){ calls.push(["post", t]); this.F.push({from: "me", name: "You", text: t, at: Date.now(), dist: 0, mine: true}); this.fns.forEach(function(f){ f(); }); return true; },
    feed(){ return this.F.slice(); }, onChange(fn){ this.fns.push(fn); return function(){}; },
    bubbles(){ return [{userId: "u1", name: "Ann", text: "hi", until: Date.now() + 3000}]; },
    people(){ return [{id: "u1", name: "Ann", dist: 12}]; }
  },
  calls: {
    inc: [], fns: [],
    contacts(){ return [{id: "u1", name: "Ann", online: true}]; },
    ring(id, name){ calls.push(["ring", id]); return null; },
    onIncoming(fn){ this.inc.push(fn); return function(){}; }, onChange(fn){ this.fns.push(fn); return function(){}; },
    active(){ return null; }, recent(){ return [{id: "c1", userId: "u1", name: "Ann", dir: "in", at: Date.now(), secs: 0, missed: true}]; }
  }
};
const sfx = [], said = [], opened = [], titles = [];
const host = {social: S, announce(t){ said.push(t); }, sfx(n){ sfx.push(n); }, calm(){ return false; }, inCity(){ return true; },
              me(){ return {userId: "me"}; }, owners(){ return [{id: "own1", name: "Island owner"}]; }};
const nav = {back(){}, open(a, arg){ opened.push([a, arg]); }, title(t){ titles.push(t); }, setBadge(){}};
new Function(fs.readFileSync(root + "/games/hqphonecomms.js", "utf8"))();
const Q = window.HQV.hqPhoneQueue, app = {}; Q.forEach(function(a){ app[a.id] = a; });
const o = {ids: Q.map(function(a){ return [a.id, a.dock, a.needsCity, typeof a.glyph]; })};
window.hqPhoneSocial = S;
const tick = () => new Promise(r => setTimeout(r, 0));

// ---- Messages ----
let el = document.createElement("div");
let ui = app.messages.render(el, host, nav);
o.css = !!document.getElementById("hqPhoneCommsCss");
o.listItems = el.querySelectorAll(".pc-item").map(function(b){ return b.getAttribute("aria-label"); });
o.rove = el.querySelectorAll(".pc-item").map(function(b){ return b.tabIndex; });
o.badge = app.messages.badge(host);
el.querySelectorAll(".pc-item")[0].click();
o.threadText = texts(el).indexOf("hey there") >= 0;
o.viewing = S.sms.viewingNow;
o.log = !!el.querySelector("[role=log]");
let inp = el.querySelector("[data-k=compose]");
inp.value = "x".repeat(161); inp.fire("input");
o.over = el.querySelector(".pc-count").textContent; o.sendDisabled = find(el, "Send").disabled;
inp.value = "  hello bob  "; inp.fire("input");
o.count = el.querySelector(".pc-count").textContent;
find(el, "Send").click(); await tick(); await tick();
o.optinShown = texts(el).indexOf("Turn on sending text messages?") >= 0;
find(el, "Turn on and send").click(); await tick(); await tick(); await tick();
o.afterOptin = texts(el).indexOf("hello bob") >= 0;
o.ticksShown = texts(el).indexOf("Sent") >= 0;
find(el, "Options").click();
o.menu = el.querySelectorAll(".pc-menu button").map(function(b){ return b.textContent; });
find(el, "Mute").click();
o.esc1 = ui.onKey({key: "Escape"}); o.backToList = !!el.querySelector(".pc-item") && texts(el).indexOf("New message") >= 0;
o.esc2 = ui.onKey({key: "Escape"});
find(el, "New message").click();
o.suggested = el.querySelectorAll(".pc-item").map(function(b){ return b.getAttribute("data-k"); });
ui.dispose(); o.viewingAfter = S.sms.viewingNow;

// ---- Nearby ----
el = document.createElement("div");
ui = app.nearby.render(el, host, nav);
o.nearGate = texts(el).indexOf("Chat with people near you?") >= 0 && !el.querySelector("input");
find(el, "Turn on Nearby").click(); await tick(); await tick();
o.nearOn = !!el.querySelector("input");
o.nearPeople = texts(el).indexOf("Ann · 12 m") >= 0;
inp = el.querySelector("input"); inp.value = "y".repeat(201); inp.fire("input");
o.nearOver = find(el, "Send").disabled;
inp.value = "hi all"; inp.fire("input"); inp.fire("keydown", {key: "Enter"});
o.nearFeed = texts(el).indexOf("hi all") >= 0; o.nearCleared = inp.value;
o.bubbles = window.HQV.hqPhoneComms.bubbles().map(function(b){ return [b.userId, b.text, b.alpha]; });
ui.dispose();

// ---- Phone ----
el = document.createElement("div");
ui = app.phone.render(el, host, nav);
o.phoneGate = texts(el).indexOf("Turn on calls?") >= 0;
o.tabs = el.querySelectorAll("[role=tab]").map(function(t){ return [t.textContent, t.getAttribute("aria-selected"), t.tabIndex]; });
find(el, "Turn on calls").click(); await tick(); await tick();
o.contacts = el.querySelectorAll(".pc-item").map(function(b){ return b.getAttribute("aria-label"); });
el.querySelectorAll(".pc-item")[0].click();
o.ringCalled = calls.filter(function(c){ return c[0] === "ring"; }).length;
// an incoming call
let st = "ringing"; const fns = [];
const h = {id: "c9", peer: "u1", name: "Ann", dir: "in", state(){ return st; }, seconds(){ return 65; }, onState(f){ fns.push(f); },
           mute(){}, muted(){ return false; }, accept(){ calls.push(["accept"]); st = "live"; fns.forEach(function(f){ f(st); }); },
           decline(){ st = "declined"; }, hangup(){ st = "ended"; fns.forEach(function(f){ f(st); }); }};
S.calls.inc.forEach(function(f){ f(h); });
o.incoming = texts(el).indexOf("Incoming call") >= 0 && !!find(el, "Accept") && !!find(el, "Decline");
o.vibrate = !!el.querySelector(".pc-vibrate");
ui.tick(10000); ui.tick(10500); ui.tick(12100);
o.sfx = sfx.slice();
find(el, "Accept").click();
o.live = texts(el).indexOf("1:05") >= 0 && !!find(el, "Mute") && !!find(el, "Hang up");
find(el, "Hang up").click();
o.ended = texts(el).indexOf("Call ended") >= 0;
ui.dispose();
el = document.createElement("div");
ui = app.phone.render(el, host, nav);
el.querySelectorAll("[role=tab]")[2].click();
el.querySelectorAll(".pc-item").forEach(function(b){ b.click(); });
o.opened = opened;
el.querySelectorAll("[role=tab]")[1].click();
o.recent = texts(el).indexOf("Missed") >= 0;
o.titles = titles.indexOf("Messages") >= 0 && titles.indexOf("Bob") >= 0 && titles.indexOf("Nearby") >= 0 && titles.indexOf("Phone") >= 0;
o.calls = calls;
console.log(JSON.stringify(o));
"""


@unittest.skipUnless(NODE, "node not installed")
class Apps(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.o = run(APPS)

    def test_registered_per_the_shell_contract(self):
        o = self.o
        self.assertEqual(o["ids"], [["messages", True, False, "string"], ["nearby", False, False, "string"],
                                    ["phone", True, False, "string"]])
        self.assertTrue(o["css"])

    def test_messages(self):
        o = self.o
        self.assertEqual(len(o["listItems"]), 1)
        self.assertIn("Bob, 2 unread", o["listItems"][0])
        self.assertEqual(o["rove"], [0])
        self.assertEqual(o["badge"], 2)
        self.assertTrue(o["threadText"] and o["log"])
        self.assertEqual(o["viewing"], "bob")
        self.assertEqual(o["over"], "161/160 too long")
        self.assertTrue(o["sendDisabled"])
        self.assertEqual(o["count"], "9/160")
        # the first send asks for the one-time opt-in, then sends what was typed
        self.assertTrue(o["optinShown"])
        self.assertTrue(o["afterOptin"] and o["ticksShown"])
        sends = [c for c in o["calls"] if c[0] == "send"]
        self.assertEqual(sends, [["send", "bob", "hello bob"], ["send", "bob", "hello bob"]])
        self.assertIn(["setEnabled", "smsSend", True], o["calls"])
        self.assertEqual(o["menu"], ["Mute", "Block", "Report"])
        self.assertIn(["mute", "bob", True], o["calls"])
        self.assertTrue(o["esc1"] and o["backToList"])
        self.assertFalse(o["esc2"])   # on the list Esc belongs to the shell
        # suggestions: here now, nearby, recent senders, island owners; one each
        self.assertEqual(o["suggested"], ["c:u1", "c:bob", "c:own1"])
        self.assertIsNone(o["viewingAfter"])

    def test_nearby(self):
        o = self.o
        self.assertTrue(o["nearGate"])
        self.assertIn(["setEnabled", "near", True], o["calls"])
        self.assertTrue(o["nearOn"] and o["nearPeople"])
        self.assertTrue(o["nearOver"])
        self.assertIn(["post", "hi all"], o["calls"])
        self.assertTrue(o["nearFeed"])
        self.assertEqual(o["nearCleared"], "")
        self.assertEqual(o["bubbles"], [["u1", "hi", 1]])

    def test_phone(self):
        o = self.o
        self.assertTrue(o["phoneGate"])
        self.assertEqual(o["tabs"], [["Contacts", "true", 0], ["Recent", "false", -1], ["Services", "false", -1]])
        self.assertEqual(o["contacts"], ["Call Ann"])
        self.assertEqual(o["ringCalled"], 1)
        self.assertTrue(o["incoming"])
        self.assertTrue(o["vibrate"])                 # not Calm
        self.assertEqual(o["sfx"], ["ring", "ring"])  # every 2 s while it rings
        self.assertIn(["accept"], o["calls"])
        self.assertTrue(o["live"])
        self.assertTrue(o["ended"])
        self.assertEqual(o["opened"], [["cabs", None], ["dealer", None], ["cabs", {"cls": "heli"}], ["cabs", {"cls": "water"}]])
        self.assertTrue(o["recent"])
        self.assertTrue(o["titles"])


STORE = r"""
import fs from "fs";
const root = %(root)s;
const toasts = [], said = [], logged = [], posts = [], sent = [];
let inbox = [], optin = false;
const store = {};
globalThis.window = globalThis;
globalThis.localStorage = {getItem(k){ return k in store ? store[k] : null; }, setItem(k, v){ store[k] = String(v); }};
globalThis.ARENA = {paired: true, you: {userId: "me"}};
globalThis.CONFIG = {phoneNear: true, phoneCalls: true};
globalThis.CSRF = "t";
globalThis.toast = function(m){ toasts.push(m); };
globalThis.announce = function(m){ said.push(m); };
globalThis.logEvent = function(i, t){ logged.push(t); };
globalThis.postConfig = function(b){ posts.push(["config", b]); return Promise.resolve({ok: true, j: {}}); };
const reply = (status, j) => Promise.resolve({ok: status < 300, status: status, json(){ return Promise.resolve(j); }});
globalThis.fetch = function(url, init){
  const body = init && init.body ? JSON.parse(init.body) : null;
  posts.push([url, body]);
  if(url.indexOf("/api/arena/sms/inbox") === 0) return reply(200, {messages: inbox});
  if(url.indexOf("/api/arena/sms/me") === 0) return reply(200, {on: optin, blocks: ["blk"], unread: 0});
  if(url === "/api/arena/sms/send"){ if(!optin) return reply(409, {detail: "turn on sending in Settings first"}); return reply(200, {ok: true, id: "s" + posts.length}); }
  if(url === "/api/arena/sms/optin"){ optin = body.on; return reply(200, {on: optin}); }
  if(url.indexOf("/api/arena/sms/status") === 0) return reply(200, {delivered: ["s_first"]});
  return reply(200, {ok: true});
};
globalThis.setInterval = function(){ return 0; };
globalThis.setTimeout = function(f){ return 0; };
globalThis.HQNET = {ws: {readyState: 1, send(s){ sent.push(JSON.parse(s)); }, addEventListener(){}}, me: "me",
                    peers: [{u: "p1", n: "Pia"}, {u: "me", n: "Me"}, {u: "blk", n: "Blocked"}]};
new Function(fs.readFileSync(root + "/ui/app/41-phone.js", "utf8"))();
const P = window.hqPhoneSocial, o = {};
const tick = () => new Promise(r => setImmediate(r));
o.keys = Object.keys(P).sort(); o.sms = Object.keys(P.sms).sort(); o.near = Object.keys(P.near).sort(); o.calls = Object.keys(P.calls).sort();
await P.sms.refresh(); await tick();
o.blocked = P.sms.blocked();
// the live push: shown, counted, toast without the text, announce with the count only
P.onSocket({type: "sms", id: "a1", from: {id: "bob", name: "Bob", handle: "bobby"}, text: "secret plans", at: 1000});
await tick();
o.threads = P.sms.threads().map(function(t){ return [t.id, t.name, t.unread, t.last && t.last.text]; });
o.unread = P.sms.unread();
o.toast1 = toasts.slice(); o.said1 = said.slice(); o.logged = logged.slice();
// a duplicate (the inbox repeats it) is not counted twice; a blocked sender is dropped
inbox = [{id: "a1", from: {id: "bob", name: "Bob", handle: "bobby"}, text: "secret plans", at: 1000},
         {id: "a2", from: {id: "blk", name: "B", handle: "b"}, text: "spam", at: 1001}];
P.onSocket({type: "sms", id: "a1", from: {id: "bob", name: "Bob"}, text: "secret plans", at: 1000});
await tick(); await tick();
o.unread2 = P.sms.unread(); o.blockedThread = P.sms.thread("blk").length;
o.ack = posts.filter(function(p){ return p[0] === "/api/arena/sms/ack"; }).map(function(p){ return p[1]; });
// mute: no unread badge, no toast
P.sms.mute("bob", true); o.unreadMuted = P.sms.unread(); o.muted = P.sms.muted();
toasts.length = 0; said.length = 0;
P.onSocket({type: "sms", id: "a3", from: {id: "bob", name: "Bob"}, text: "more", at: 1002}); await tick();
o.mutedToasts = toasts.length; o.mutedSaid = said.length;
P.sms.mute("bob", false);
// Messages open (viewing the list): the text may show in the toast
P.sms.viewing(true); toasts.length = 0;
P.onSocket({type: "sms", id: "a4", from: {id: "cat", name: "Cat"}, text: "hello there", at: 1003}); await tick();
o.toastOpen = toasts.slice();
P.sms.viewing("bob"); o.unreadAfterView = P.sms.threads().filter(function(t){ return t.id === "bob"; })[0].unread;
P.sms.viewing(null);
// sending: the 409 asks for the opt-in, then it goes
o.send1 = await P.sms.send("bob", "hi");
o.optin = await P.setEnabled("smsSend", true);
o.send2 = await P.sms.send("bob", " hi bob ");
o.sendLong = await P.sms.send("bob", "x".repeat(161));
o.sendBadId = await P.sms.send("../x", "hi");
o.thread = P.sms.thread("bob").map(function(m){ return [m.me, m.text, m.state]; });
o.enabled = P.enabled();
// caps: 200 a thread, 50 threads
for(let i = 0; i < 230; i++) P.onSocket({type: "sms", id: "f" + i, from: {id: "flood", name: "F"}, text: "n" + i, at: 2000 + i});
await tick();
o.floodLen = P.sms.thread("flood").length; o.floodFirst = P.sms.thread("flood")[0].text;
for(let i = 0; i < 60; i++) P.onSocket({type: "sms", id: "t" + i, from: {id: "u" + i, name: "U"}, text: "x", at: 5000 + i});
await tick();
o.threadCount = P.sms.threads().length;
o.stored = JSON.parse(store["hq_phone_sms"] || "{}") ? Object.keys(JSON.parse(store["hq_phone_sms"])).length : 0;
// nearby: near_on on the socket, post, an incoming line, bubbles
P.onSocket({type: "noop"});
o.nearPost = P.near.post("  hello nearby  ");
o.nearSent = sent.filter(function(m){ return m.type === "say"; });
P.onSocket({type: "say", from: {userId: "p1", displayName: "Pia"}, data: {kind: "near", text: "hey", d: 12}});
o.feed = P.near.feed().map(function(f){ return [f.name, f.text, f.dist, f.mine]; });
o.bubbles = P.near.bubbles().map(function(b){ return [b.userId, b.text]; });
o.nearLong = P.near.post("y".repeat(300)) && sent[sent.length - 1].data.text.length;
// calls: contacts from the room, never me or a blocked player; a ring goes out on the socket
o.contacts = P.calls.contacts();
const h = P.calls.ring("p1", "Pia");
o.ring = [h && h.state(), sent.filter(function(m){ return m.type === "ring"; }).map(function(m){ return [m.to, /^c[0-9a-f]{16}$/.test(m.id)]; })];
P.onSocket({type: "ring_ans", from: {userId: "p1"}, id: h.id, ok: false});
o.declined = h.state(); o.recent = P.calls.recent().map(function(r){ return [r.userId, r.dir, r.missed]; });
// an incoming ring with calls off is ignored
CONFIG.phoneCalls = false; let inc = 0; P.calls.onIncoming(function(){ inc++; });
P.onSocket({type: "ring", from: {userId: "p1", displayName: "Pia"}, id: "cabc"});
CONFIG.phoneCalls = true;
P.onSocket({type: "ring", from: {userId: "p1", displayName: "Pia"}, id: "cdef"});
o.incoming = inc;
console.log(JSON.stringify(o));
"""


@unittest.skipUnless(NODE, "node not installed")
class Store(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.o = run(STORE)

    def test_the_api_is_the_contract(self):
        o = self.o
        for k in ["enabled", "setEnabled", "sms", "near", "calls"]:
            self.assertIn(k, o["keys"])
        for k in ["threads", "thread", "send", "block", "blocked", "mute", "muted", "report", "directory", "onChange", "unread"]:
            self.assertIn(k, o["sms"])
        for k in ["post", "feed", "onChange", "bubbles"]:
            self.assertIn(k, o["near"])
        for k in ["contacts", "ring", "onIncoming", "recent"]:
            self.assertIn(k, o["calls"])

    def test_incoming_messages(self):
        o = self.o
        self.assertEqual(o["blocked"], ["blk"])
        self.assertEqual(o["threads"], [["bob", "Bob", 1, "secret plans"]])
        self.assertEqual(o["unread"], 1)
        # the toast names the sender and never carries the text while Messages is closed
        self.assertEqual(o["toast1"], ["Bob: New message"])
        self.assertEqual(o["said1"], ["1 new message"])
        self.assertTrue(all("secret" not in t for t in o["toast1"] + o["said1"] + o["logged"]))
        self.assertEqual(o["logged"], ["New message from Bob"])
        self.assertEqual(o["unread2"], 1)
        self.assertEqual(o["blockedThread"], 0)
        self.assertIn({"upto": "a2"}, o["ack"])
        self.assertEqual(o["unreadMuted"], 0)
        self.assertEqual(o["muted"], ["bob"])
        self.assertEqual((o["mutedToasts"], o["mutedSaid"]), (0, 0))
        self.assertEqual(o["toastOpen"], ["Cat: hello there"])
        self.assertEqual(o["unreadAfterView"], 0)

    def test_sending(self):
        o = self.o
        self.assertFalse(o["send1"]["ok"])
        self.assertTrue(o["send1"]["optIn"])
        self.assertEqual(o["optin"], {"ok": True, "on": True})
        self.assertTrue(o["send2"]["ok"])
        self.assertFalse(o["sendLong"]["ok"])
        self.assertFalse(o["sendBadId"]["ok"])
        self.assertEqual(o["thread"][-1], [True, "hi bob", "sent"])
        self.assertEqual(o["enabled"], {"smsSend": True, "near": True, "calls": True})

    def test_caps(self):
        o = self.o
        self.assertEqual(o["floodLen"], 200)
        self.assertEqual(o["floodFirst"], "n30")
        self.assertEqual(o["threadCount"], 50)
        self.assertEqual(o["stored"], 50)

    def test_nearby_and_calls(self):
        o = self.o
        self.assertTrue(o["nearPost"])
        self.assertEqual(o["nearSent"][0], {"type": "say", "data": {"kind": "near", "text": "hello nearby"}})
        self.assertEqual(o["feed"], [["You", "hello nearby", 0, True], ["Pia", "hey", 12, False]])
        self.assertEqual(o["bubbles"], [["me", "hello nearby"], ["p1", "hey"]])
        self.assertEqual(o["nearLong"], 200)
        self.assertEqual(o["contacts"], [{"id": "p1", "name": "Pia", "online": True}])
        self.assertEqual(o["ring"], ["ringing", [["p1", True]]])
        self.assertEqual(o["declined"], "declined")
        self.assertEqual(o["recent"], [["p1", "out", False]])
        self.assertEqual(o["incoming"], 1)


class NoInnerHTML(unittest.TestCase):
    def test_no_innerhtml_and_no_math_random(self):
        for p in (("ui", "app", "41-phone.js"), ("games", "hqphonecomms.js")):
            src = read(*p)
            self.assertNotIn("innerHTML", src, p)
            self.assertNotIn("insertAdjacentHTML", src, p)
            self.assertNotIn("Math.random", src, p)

    def test_the_settings_section_says_what_is_shared(self):
        src = read("ui", "app", "16-settings.js")
        for k in ["setPhoneSms", "phoneNear", "phoneCalls", "transitVoice", "phoneClock24", "cabClass"]:
            self.assertIn(k, src)
        block = src[src.index("/* ---- [3.15] the phone:"):]
        self.assertNotIn("innerHTML", block)
        self.assertEqual(len(re.findall(r'hint:"', block)), 5)


if __name__ == "__main__":
    unittest.main()
