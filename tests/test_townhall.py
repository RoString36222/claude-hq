"""Town Hall panel (ui/app/38-townhall.js, cities spec "dash"): renders a CityState and a market
without innerHTML, shows the owner-only controls only to the owner, and posts exactly the
bodies the dashboard proxies accept.

node loads the module against a small fake DOM whose innerHTML / outerHTML /
insertAdjacentHTML throw, and a fake fetch that answers from fixtures and records every request
(one node process for the whole file). Skipped when node is not installed. Stdlib only."""
import json
import os
import re
import shutil
import subprocess
import unittest

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SRC = os.path.join(ROOT, "ui", "app", "38-townhall.js")
NODE = shutil.which("node")
OWNER = "a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d"
HIDDEN = "99999999-9999-4999-8999-999999999999"
EVIL = "<img src=x onerror=alert(1)>"

CITY = {"owner": OWNER, "name": EVIL + " Harbour", "world": "user:%s@2" % OWNER, "tier": 2, "xp": 6500,
        "tier_xp": [0, 2000, 10000, 40000, 120000], "grow": 450, "treasury": 12345, "tax_pm": 25,
        "specialty": "tech", "upgrades": {"tax_office": 1, "park_<b>": 0}, "privacy": "friends", "population": 4210}
MARKET = [{"good": "tech", "price": 120, "stock": 40}, {"good": "fish", "price": 8, "stock": 300}, {"good": EVIL, "price": 1, "stock": 1}]

HARNESS = r"""
var fs = require("fs"), root = %(root)s, CITY = %(city)s, MARKET = %(market)s, OWNER = %(owner)s, HIDDEN = %(hidden)s;
var out = {htmlWrites: 0};
function Classes(n){ this.n = n; }
Classes.prototype.list = function(){ return String(this.n.className || "").split(/\s+/).filter(Boolean); };
Classes.prototype.add = function(c){ var l = this.list(); if(l.indexOf(c) < 0) l.push(c); this.n.className = l.join(" "); };
Classes.prototype.remove = function(c){ this.n.className = this.list().filter(function(x){ return x !== c; }).join(" "); };
Classes.prototype.contains = function(c){ return this.list().indexOf(c) >= 0; };
function Node(tag){ this.tagName = tag.toUpperCase(); this.children = []; this.attrs = {}; this.style = {}; this.listeners = {};
  this._text = ""; this.className = ""; this.parentNode = null; this.classList = new Classes(this); this.disabled = false; this.value = ""; }
Object.defineProperty(Node.prototype, "textContent", {
  get: function(){ return this._text + this.children.map(function(c){ return c.textContent; }).join(""); },
  set: function(v){ this.children.forEach(function(c){ c.parentNode = null; }); this.children = []; this._text = String(v); }});
["innerHTML", "outerHTML"].forEach(function(k){ Object.defineProperty(Node.prototype, k, {
  get: function(){ return ""; }, set: function(){ out.htmlWrites++; throw new Error(k + " write"); }}); });
Node.prototype.insertAdjacentHTML = function(){ out.htmlWrites++; throw new Error("insertAdjacentHTML"); };
Node.prototype.appendChild = function(c){ c.parentNode = this; this.children.push(c); return c; };
Node.prototype.setAttribute = function(k, v){ this.attrs[k] = String(v); };
Node.prototype.getAttribute = function(k){ return k in this.attrs ? this.attrs[k] : null; };
Node.prototype.addEventListener = function(t, f){ (this.listeners[t] = this.listeners[t] || []).push(f); };
Node.prototype.fire = function(t, e){ e = e || {}; e.target = e.target || this; e.preventDefault = function(){}; e.stopPropagation = function(){};
  (this.listeners[t] || []).forEach(function(f){ f(e); }); };
Node.prototype.focus = function(){ document.activeElement = this; };
Object.defineProperty(Node.prototype, "isConnected", {get: function(){ var n = this; while(n.parentNode) n = n.parentNode; return n === document.body; }});
function walk(n, f){ f(n); n.children.forEach(function(c){ walk(c, f); }); }
function all(n){ var a = []; walk(n, function(x){ a.push(x); }); return a; }
function byTag(n, tag){ return all(n).filter(function(x){ return x.getAttribute("data-th") === tag; })[0]; }
function tags(n){ return all(n).map(function(x){ return x.getAttribute("data-th"); }).filter(Boolean); }
global.document = {body: new Node("body"), activeElement: null, pointerLockElement: null,
  createElement: function(t){ return new Node(t); },
  getElementById: function(id){ return all(document.body).filter(function(x){ return x.id === id; })[0] || null; }};
global.window = global;
global.CSRF = "tok";
global.ARENA = {you: null};
var announced = []; global.announce = function(m){ announced.push(m); };
var sent = [];
function reply(status, body){ return Promise.resolve({ok: status >= 200 && status < 300, status: status, json: function(){ return Promise.resolve(body); }}); }
global.fetch = function(url, init){
  sent.push({url: url, method: (init && init.method) || "GET", body: init && init.body ? JSON.parse(init.body) : null,
             token: init && init.headers ? init.headers["X-HQ-Token"] : null});
  if(url.indexOf("/api/arena/city/" + HIDDEN) === 0) return reply(404, {detail: "no such city", error: "no such city"});
  if(url === "/api/arena/city/" + OWNER || url === "/api/arena/city/commons") return reply(200, CITY);
  if(url.indexOf("/api/arena/market/") === 0 && url.slice(-6) !== "/trade") return reply(200, MARKET);
  if(/\/privacy$/.test(url)) return reply(403, {error: "owner only"});
  return reply(200, {ok: true});
};
function settle(){ return new Promise(function(r){ setTimeout(r, 0); }).then(function(){ return new Promise(function(r){ setTimeout(r, 0); }); }); }

new Function(fs.readFileSync(root + "/ui/app/38-townhall.js", "utf8"))();
var TH = window.HQV.townHall;

(async function(){
  // Pure helpers.
  out.tier = [TH.tierInfo(CITY), TH.tierInfo({tier: 5, grow: 10, tier_xp: CITY.tier_xp}), TH.tierInfo({}), TH.tierInfo({tier: 9, grow: 5000})];
  out.quote = [TH.transferQuote(100), TH.transferQuote(15), TH.transferQuote(-3), TH.transferQuote("7")];
  out.goods = [TH.goods(MARKET).length, TH.goods({goods: MARKET}).length, TH.goods(null).length, TH.goods([null, {good: 3}, {good: "x"}]).length];

  // Owner render from the fixture.
  var r1 = new Node("div");
  TH.render(r1, {city: CITY, market: MARKET, mine: true, tab: "city"});
  var fill = all(r1).filter(function(x){ return x.className === "th-fill"; })[0];
  var bar = all(r1).filter(function(x){ return x.className === "th-bar"; })[0];
  out.owner = {text: r1.textContent, tags: tags(r1), fill: fill.style.width, now: bar.getAttribute("aria-valuenow"),
               privacy: byTag(r1, "privacy").value, img: all(r1).filter(function(x){ return x.tagName === "IMG" || x.tagName === "SCRIPT"; }).length};
  // A visitor: no owner controls, the market still trades.
  var r2 = new Node("div");
  TH.render(r2, {city: CITY, market: MARKET, mine: false, tab: "city"});
  out.visitor = {text: r2.textContent, tags: tags(r2)};
  var r3 = new Node("div");
  TH.render(r3, {city: CITY, market: MARKET, mine: false, tab: "market"});
  out.market = {text: r3.textContent, tags: tags(r3)};
  var r4 = new Node("div");
  TH.render(r4, {city: null, market: null, mine: false, tab: "city", err: "This city is closed to you."});
  out.err = r4.textContent;

  // The modal: bad ids never fetch.
  out.badOpen = ["../x", "commons/x", "Commons", "", OWNER.toUpperCase()].map(function(o){ return TH.open(o); });
  out.sentAfterBad = sent.length;

  // Open your own city, act on it.
  out.opened = TH.open(OWNER, {mine: true});
  await settle();
  var body = document.getElementById("townHallBody");
  out.modal = {open: TH.isOpen(), text: body.textContent, gets: sent.map(function(s){ return s.method + " " + s.url; })};
  sent.length = 0;
  byTag(body, "build:tax_office").fire("click"); await settle();
  var amt = byTag(document.getElementById("townHallBody"), "amount"); amt.value = "250"; amt.fire("input");
  out.fee = byTag(document.getElementById("townHallBody"), "fee").textContent;
  byTag(document.getElementById("townHallBody"), "transfer:in").fire("click"); await settle();
  byTag(document.getElementById("townHallBody"), "transfer:out").fire("click"); await settle();
  var sel = byTag(document.getElementById("townHallBody"), "privacy"); sel.value = "closed"; sel.fire("change"); await settle();
  out.privacyMsg = document.getElementById("townHallBody").textContent;
  byTag(document.getElementById("townHallBody"), "tab:market").fire("click");
  var q = byTag(document.getElementById("townHallBody"), "qty"); q.value = "5000"; q.fire("input");
  byTag(document.getElementById("townHallBody"), "sell:tech").fire("click"); await settle();
  out.posts = sent.filter(function(s){ return s.method === "POST"; });
  out.after = document.getElementById("townHallBody").textContent;
  // Escape closes and calls back.
  var closed = 0;
  TH.open("commons", {mine: true, onClose: function(){ closed++; }}); await settle();
  out.commonsTags = tags(document.getElementById("townHallBody"));
  document.getElementById("townHallBack").fire("keydown", {key: "Escape"});
  out.closed = {isOpen: TH.isOpen(), calls: closed};
  // A city hidden from you.
  TH.open(HIDDEN); await settle();
  out.hidden = document.getElementById("townHallBody").textContent;
  // ARENA.you marks your own city without opts.
  ARENA.you = {userId: OWNER}; TH.open(OWNER); await settle();
  out.youTags = tags(document.getElementById("townHallBody"));
  out.announced = announced;
  process.stdout.write(JSON.stringify(out));
})().catch(function(e){ console.error(e && e.stack || e); process.exit(1); });
"""


def read(p):
    with open(p, encoding="utf-8") as f:
        return f.read()


@unittest.skipUnless(NODE, "node not installed")
class TownHallPanel(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        js = HARNESS % {"root": json.dumps(ROOT), "city": json.dumps(CITY), "market": json.dumps(MARKET),
                        "owner": json.dumps(OWNER), "hidden": json.dumps(HIDDEN)}
        p = subprocess.run([NODE, "-e", js], capture_output=True, text=True, timeout=60)
        if p.returncode:
            raise AssertionError(p.stderr)
        cls.o = json.loads(p.stdout)

    def test_never_writes_html(self):
        self.assertEqual(self.o["htmlWrites"], 0)
        self.assertEqual(self.o["owner"]["img"], 0)
        # Hostile names and goods arrive as text.
        self.assertIn(EVIL + " Harbour", self.o["owner"]["text"])
        self.assertIn("Park <b>", self.o["owner"]["text"])

    def test_city_card_from_the_fixture(self):
        t = self.o["owner"]["text"]
        for want in ("Tier 2 · Town", "6,500 / 10,000 XP to City", "Population", "4,210", "12,345 coins", "2.5%", "Tech",
                     "Tax office", "Level 1", "Upgrades", "Treasury transfer", "Who can visit"):
            self.assertIn(want, t)
        self.assertEqual(self.o["owner"]["fill"], "45%")
        self.assertEqual(self.o["owner"]["now"], "45")
        self.assertEqual(self.o["owner"]["privacy"], "friends")

    def test_owner_only_controls(self):
        own, vis = set(self.o["owner"]["tags"]), set(self.o["visitor"]["tags"])
        self.assertTrue({"build:tax_office", "build:park_<b>", "transfer:in", "transfer:out", "amount", "fee", "privacy"} <= own)
        self.assertFalse([t for t in vis if t.startswith(("build:", "transfer:")) or t in ("privacy", "amount", "fee")])
        self.assertNotIn("Treasury transfer", self.o["visitor"]["text"])
        self.assertIn("Tax office", self.o["visitor"]["text"])
        # The Commons has no owner, and ARENA.you marks your own city.
        self.assertNotIn("privacy", self.o["commonsTags"])
        self.assertIn("privacy", self.o["youTags"])

    def test_market_tab_for_visitors(self):
        m = self.o["market"]
        self.assertTrue({"buy:tech", "sell:tech", "buy:fish", "sell:fish", "qty", "tab:market", "tab:city"} <= set(m["tags"]))
        for want in ("Tech", "120", "40", "Fish", "300", EVIL):
            self.assertIn(want, m["text"])

    def test_helpers(self):
        t = self.o["tier"]
        self.assertEqual((t[0]["tier"], t[0]["name"], t[0]["pct"], t[0]["next"]), (2, "Town", 45, 10000))
        self.assertEqual((t[1]["tier"], t[1]["pct"], t[1]["next"]), (5, 100, None))
        self.assertEqual((t[2]["tier"], t[2]["pct"]), (1, 0))
        self.assertEqual((t[3]["tier"], t[3]["name"], t[3]["pct"]), (5, "Capital", 100))
        self.assertEqual([(q["amount"], q["fee"], q["net"]) for q in self.o["quote"]], [(100, 10, 90), (15, 2, 13), (0, 0, 0), (7, 1, 6)])
        self.assertEqual(self.o["goods"], [3, 3, 0, 1])

    def test_bad_owner_never_fetches(self):
        self.assertEqual(self.o["badOpen"], [False] * 5)
        self.assertEqual(self.o["sentAfterBad"], 0)

    def test_open_loads_and_posts_the_proxy_bodies(self):
        self.assertTrue(self.o["opened"])
        self.assertTrue(self.o["modal"]["open"])
        self.assertEqual(sorted(self.o["modal"]["gets"]), ["GET /api/arena/city/" + OWNER, "GET /api/arena/market/" + OWNER])
        self.assertIn(EVIL + " Harbour", self.o["modal"]["text"])
        self.assertEqual(self.o["fee"], "10% fee: 25 coins, 225 arrive")
        base = "/api/arena/city/" + OWNER
        self.assertEqual([(p["url"], p["body"]) for p in self.o["posts"]], [
            (base + "/build", {"upgrade": "tax_office"}),
            (base + "/transfer", {"amount": 250, "dir": "in"}),
            (base + "/transfer", {"amount": 250, "dir": "out"}),
            (base + "/privacy", {"mode": "closed"}),
            ("/api/arena/market/" + OWNER + "/trade", {"good": "tech", "qty": 1000, "side": "sell"}),
        ])
        self.assertTrue(all(p["token"] == "tok" for p in self.o["posts"]))
        # The Arena's refusal is shown; a success is announced.
        self.assertIn("owner only", self.o["privacyMsg"])
        self.assertIn("Sold 1000 Tech.", self.o["after"])
        self.assertIn("Tax office upgraded.", self.o["announced"])

    def test_close_and_hidden_city(self):
        self.assertEqual(self.o["closed"], {"isOpen": False, "calls": 1})
        self.assertIn("This city is closed to you.", self.o["hidden"])
        self.assertIn("This city is closed to you.", self.o["err"])


class Wiring(unittest.TestCase):
    def test_source_has_no_html_sinks(self):
        src = read(SRC)
        for bad in ("innerHTML", "outerHTML", "insertAdjacentHTML", "document.write", "eval(", "Math.min(1, dt"):
            self.assertNotIn(bad, src)
        # Only local /api/ paths are fetched.
        for url in re.findall(r"""fetch\(\s*([^,)]+)""", src):
            self.assertIn(url.strip(), ("path",))
        self.assertEqual(sorted(set(re.findall(r'"(/api/[a-z/]+)', src))), ["/api/arena/city/", "/api/arena/market/"])

    def test_loaded_by_the_page_and_styled(self):
        html = read(os.path.join(ROOT, "index.html"))
        self.assertIn("//@include ui/app/37-notch-invite.js\n//@include ui/app/38-townhall.js\n", html)
        css = read(os.path.join(ROOT, "ui", "hq.css"))
        for sel in (".th-modal", ".th-bar", ".th-fill", ".th-tab.on", ".th-good"):
            self.assertIn(sel + "{", css)


if __name__ == "__main__":
    unittest.main()
