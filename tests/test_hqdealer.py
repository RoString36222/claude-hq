"""The dealership (games/hqdealer.js, docs/plans/dealership-spec.md "The dealership").

node: where it stands (place() turns one of the world's building lots into the "dealer:0" site: the same lot on
every client, from tier 2, idempotent; Go to lists it), the layout (turntables inside the hall, bays on the
forecourt), the panel model (Bikes / Cars, both vehicles of each on-sale class; free and unlocked unless the data
says otherwise), the building with the vendored three.js (draw calls, the hall's boxes, the door, a turning vehicle
per turntable) and the panel under a DOM stub (Test drive, Get it, keys kept). The Python side checks the wiring in
games/hq3d.js and games/hqcity3d.js. Skipped when node is not installed. Stdlib only."""
import json
import os
import re
import shutil
import subprocess
import unittest

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
NODE = shutil.which("node")
FIX = os.path.join(ROOT, "tests", "fixtures")


def read(*p):
    with open(os.path.join(ROOT, *p), encoding="utf-8") as f:
        return f.read()


HARNESS = r"""
import fs from "fs";
import zlib from "zlib";
const root = %(root)s;
const THREE = await import(root + "/games/vendor/three-module.js");
/* ---------- a small DOM ---------- */
function El(tag){ this.tagName = String(tag).toLowerCase(); this.children = []; this.parentNode = null; this.attrs = {}; this.ls = {};
  this.style = {}; this.hidden = false; this.disabled = false; this._t = ""; this.className = ""; this.type = ""; this.title = ""; }
El.prototype.appendChild = function(k){ k.parentNode = this; this.children.push(k); return k; };
El.prototype.removeChild = function(k){ var i = this.children.indexOf(k); if(i >= 0) this.children.splice(i, 1); k.parentNode = null; return k; };
Object.defineProperty(El.prototype, "firstChild", {get(){ return this.children[0] || null; }});
Object.defineProperty(El.prototype, "textContent", {get(){ return this._t + this.children.map(k => k.textContent).join(""); }, set(v){ this.children = []; this._t = String(v); }});
Object.defineProperty(El.prototype, "classList", {get(){ var el = this; return {
  contains(c){ return (" " + el.className + " ").indexOf(" " + c + " ") >= 0; },
  add(c){ if(!this.contains(c)) el.className = (el.className + " " + c).trim(); },
  remove(c){ el.className = (" " + el.className + " ").replace(" " + c + " ", " ").trim(); },
  toggle(c, on){ if(on === undefined) on = !this.contains(c); if(on) this.add(c); else this.remove(c); }}; }});
El.prototype.setAttribute = function(k, v){ this.attrs[k] = String(v); };
El.prototype.getAttribute = function(k){ return this.attrs[k]; };
El.prototype.addEventListener = function(t, f){ (this.ls[t] = this.ls[t] || []).push(f); };
El.prototype.removeEventListener = function(t, f){ var L = this.ls[t] || [], i = L.indexOf(f); if(i >= 0) L.splice(i, 1); };
El.prototype.all = function(){ var o = [this]; this.children.forEach(k => { o = o.concat(k.all()); }); return o; };
El.prototype.querySelectorAll = function(sel){ var cs = sel.split(".").filter(Boolean); return this.all().slice(1).filter(n => cs.every(c => n.classList.contains(c))); };
El.prototype.querySelector = function(sel){ return this.querySelectorAll(sel)[0] || null; };
El.prototype.closest = function(sel){ var c = sel.replace(".", ""); for(var n = this; n; n = n.parentNode) if(n.classList && n.classList.contains(c)) return n; return null; };
El.prototype.focus = function(){};
El.prototype.click = function(){ (this.ls.click || []).slice().forEach(f => f({target: this})); };
globalThis.document = {createElement: t => new El(t), documentElement: new El("html")};
globalThis.window = {HQV: {}, document: globalThis.document};
for (const f of ["world", "hqmerge", "hqvehicles", "hqvehiclemodels", "hqshowroom", "hqnav", "hqdealer"])
  new Function(fs.readFileSync(root + "/games/" + f + ".js", "utf8"))();
const H = window.HQV, WD = H.world, D = H.hqDealer;
const gz = p => JSON.parse(zlib.gunzipSync(fs.readFileSync(p)).toString("utf8"));
const cat0 = JSON.parse(fs.readFileSync(root + "/games/vehicles/catalogue.json", "utf8"));
// everything is free and unlocked (the owner's call): price 0, minLevel 0, whatever this branch's file says
const cat = JSON.parse(JSON.stringify(cat0)); cat.vehicles.forEach(v => { v.price = 0; v.minLevel = 0; });
const out = {};

/* ---------- placement ---------- */
function placed(file, id, tier){
  const W = WD.pack(gz(file)); W.id = id;
  const lots = W.lots.length, s = D.place(W, tier);
  if(!s) return {site: null, lots: lots};
  const lot = W.lots.filter(l => l.id === s.lot)[0], F = D.frame(s), legend = W.districts.legend;
  const again = D.place(W, tier);
  const places = H.hqnav.places(W, tier, {x: 0, z: 0}).filter(p => p.kind === "dealer");
  return {site: {id: s.id, kind: s.kind, tier: s.tier, lot: s.lot, x: s.x, z: s.z, name: s.name, flagship: s.flagship},
    lotKind: lot.kind, district: legend[lot.district | 0], F: {w: F.w, d: F.d}, same: again === s,
    dealers: W.sites.filter(x => x.kind === "dealer").length, buildingLots: W.lots.filter(l => l.kind === "building").length,
    places: places.map(p => ({label: p.label, icon: p.icon})), pick: D.pick(WD.pack(gz(file))).lot.id};
}
// the live Commons is @3 (D2); the @2 id (an older Arena) is the same place, also the flagship
out.commons = placed(%(commons)s, "claude-hq@3", 5);
out.commons2 = placed(%(commons)s, "claude-hq@3", 2);
out.commons1 = placed(%(commons)s, "claude-hq@3", 1);
out.commonsV2 = placed(%(commons)s, "claude-hq@2", 5);
out.island = placed(%(island)s, "user:x@3", 3);
out.isCommons = ["claude-hq@3", "claude-hq@2", WD.COMMONS, "claude-hq@1", "user:x@3", null].map(D.isCommons);

/* ---------- layout ---------- */
const items = [];
for (let i = 0; i < 18; i++) items.push({kind: "car"});
for (let i = 0; i < 14; i++) items.push({kind: "bike"});
out.layoutBig = D.layout({w: 80, d: 60}, items, true);
out.layoutSmall = D.layout({w: 32, d: 25}, items, false);

/* ---------- the panel model ---------- */
out.model = D.model(cat, {level: 1, owned: ["bmw-m2"], garage: true});
out.modelNoGarage = D.model(cat, {level: 1, garage: false});
const paid = JSON.parse(JSON.stringify(cat)); paid.vehicles.forEach(v => { if(v.id === "bmw-m2"){ v.price = 12000; v.minLevel = 20; } });
out.modelPaid = D.model(paid, {level: 3, garage: true});
out.prices = [D.priceText(0), D.priceText(1500), D.priceText(125000)];

/* ---------- the building ---------- */
function mat(c, o){ return new THREE.MeshStandardMaterial(Object.assign({color: c, roughness: 0.7}, o || {})); }
function add(o, x, y, z, p){ o.position.set(x, y, z); p.add(o); return o; }
var c = {THREE: THREE, mat: mat, box(w, h, d, m, x, y, z, p){ return add(new THREE.Mesh(new THREE.BoxGeometry(w, h, d), m), x, y, z, p); },
  cyl(rt, rb, h, m, x, y, z, p, seg){ return add(new THREE.Mesh(new THREE.CylinderGeometry(rt, rb, h, seg || 12), m), x, y, z, p); },
  canvasTex(w, h, draw){ return {t: new THREE.Texture()}; }, glow(col, s, o){ return new THREE.Sprite(new THREE.SpriteMaterial({color: col, opacity: o, transparent: true})); }};
const Wc = WD.pack(gz(%(commons)s)); Wc.id = "claude-hq@3";
const site = D.place(Wc, 5), B = D.build(c, site, {tier: 5, night: true, catalogue: cat});
B.g.updateMatrixWorld(true);
let dc = 0, veh = [], inst = 0;
B.g.traverse(o => { if((o.isMesh || o.isSprite) && o.visible){ dc++; if(o.isInstancedMesh) inst++; if(/^dealer-vehicle:/.test(o.name)) veh.push(o); } });
const r0 = veh.length ? veh[0].rotation.y : 0; B.animate(1, 0.5, 1); const r1 = veh.length ? veh[0].rotation.y : 0;
const F = D.frame(site), cr = Math.cos(F.rot), sr = Math.sin(F.rot);
const local = p => ({x: (p.x - F.cx)*cr - (p.z - F.cz)*sr, z: (p.x - F.cx)*sr + (p.z - F.cz)*cr});
out.build = {dc: dc, vehicles: veh.length, cells: B.layout.cells.length, onSale: H.hqVehicles.onSale(cat).reduce((n, c) => n + H.hqVehicles.byClass(cat, c.id).filter(v => H.hqVehicles.isSlot(v, cat)).length, 0), hall: B.layout.hall, FW: [D.frame(site).w, D.frame(site).d], inst: inst, turned: r1 - r0,
  boxes: B.boxes.length, lod: B.lod.length, doors: B.doors.map(d => ({kind: d.kind, live: d.live, hit: !!B.hits[0] && B.hits[0].userData.door === d})),
  forecourt: B.forecourt.map(local), door: local(B.door), F: {w: F.w, d: F.d}, x: B.x, z: B.z, top: B.top,
  insideDoor: B.inside(B.forecourt[0].x, B.forecourt[0].z), insideFar: B.inside(B.x + 500, B.z + 500),
  vehTris: veh.length ? veh[0].geometry.getAttribute("position").count/3 : 0};
B.setNight(false); B.setNight(true);

/* ---------- the panel ---------- */
const stage = new El("div"), calls = {test: [], get: [], close: 0};
const ui = D.mountPanel(stage, {catalogue: () => cat, level: () => 1, garage: () => true, owned: () => Promise.resolve(["bmw-m2"]),
  onTest(id, hex){ calls.test.push([id, hex]); }, onGet(id, hex){ calls.get.push([id, hex]); return Promise.resolve({ok: true, text: "Delivered to the garage — press C to call it."}); },
  onClose(){ calls.close++; }, name: "Flagship Dealership"});
ui.open();
const root2 = ui.root, tabs = root2.querySelectorAll("hqdealer-tab".replace(/^/, ".")).map(t => t.textContent);
const cards = root2.querySelectorAll(".hqdealer-card"), gets = root2.querySelectorAll(".hqdealer-get");
out.panel = {open: ui.isOpen(), tabs: tabs, cards: cards.length, getText: gets.map(b => b.textContent).filter((v, i, a) => a.indexOf(v) === i),
  getDisabled: gets.filter(b => b.disabled).length, pairs: root2.querySelectorAll(".hqdealer-pair").map(p => p.children.length),
  title: root2.querySelector(".hqdealer-title").textContent};
gets[0].click();
await new Promise(r => setTimeout(r, 10));
out.panel.status = root2.querySelector(".hqdealer-status").textContent;
// keys inside the panel stay there; Escape closes (the cards were drawn again after Get it: the live ones)
const live = root2.querySelector(".hqdealer-card");
var ev = {type: "keydown", key: "w", target: live, stopped: false, prevented: false, stopPropagation(){ this.stopped = true; }, preventDefault(){ this.prevented = true; }};
(root2.ls.keydown || []).forEach(f => f(ev));
out.panel.keyStopped = ev.stopped; out.panel.owns = D.owns({target: live}); out.panel.ownsOutside = D.owns({target: stage});
root2.querySelectorAll(".hqdealer-test")[1].click();
out.panel.afterTest = ui.isOpen();
out.calls = calls;

/* ---------- the phone's Dealership call: remote mode ---------- */
const buys = [], bought = [];
let failNext = false;
H.hqGarage = {buy(id, paint){ buys.push([id, paint]); return Promise.resolve(failNext ? {error: "nope", status: 500} : {id: "0b8e4c1a-3f2d-4e5b-9a6c-7d8e9f0a1b2c"}); }};
const stage2 = new El("div"), rcalls = {get: 0};
const ui2 = D.mountPanel(stage2, {remote: true, catalogue: () => cat, level: () => 1, garage: () => true, owned: () => Promise.resolve([]),
  onGet(){ rcalls.get++; return Promise.resolve({ok: true, text: "not this"}); }, onBought(r){ bought.push(r); }, name: "Claude Motors"});
ui2.open();
const r2 = ui2.root;
out.remote = {tests: r2.querySelectorAll(".hqdealer-test").length, note: r2.querySelector(".hqdealer-note").textContent,
              gets: r2.querySelectorAll(".hqdealer-get").length};
// pick the second paint of the first card, then Get it
const firstCard = r2.querySelector(".hqdealer-card"), sw = firstCard.querySelectorAll(".hqdealer-swatch");
if(sw[1]) sw[1].click();
firstCard.querySelector(".hqdealer-get").click();
await new Promise(r => setTimeout(r, 10));
out.remote.status = r2.querySelector(".hqdealer-status").textContent;
out.remote.buys = buys.slice(); out.remote.bought = bought.slice(); out.remote.onGet = rcalls.get;
// a failed buy says so and calls nothing
failNext = true;
r2.querySelectorAll(".hqdealer-get")[1].click(); await new Promise(r => setTimeout(r, 10));
out.remote.failStatus = r2.querySelector(".hqdealer-status").textContent;
out.remote.boughtAfterFail = bought.length;
console.log(JSON.stringify(out));
"""


@unittest.skipUnless(NODE, "node not installed")
class DealerNode(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        src = HARNESS % {"root": json.dumps(ROOT), "commons": json.dumps(os.path.join(FIX, "claude-hq@2.json.gz")),
                         "island": json.dumps(os.path.join(FIX, "island@2.json.gz"))}
        r = subprocess.run([NODE, "--input-type=module", "-e", src], capture_output=True, text=True, timeout=300)
        if r.returncode:
            raise AssertionError(r.stderr[-3000:])
        cls.o = json.loads(r.stdout.strip().splitlines()[-1])
        cls.cat = json.loads(read("games", "vehicles", "catalogue.json"))
        cls.slots = {c["id"]: c["slots"] for c in cls.cat["classes"] if "slots" in c}   # [3.17] a class listing more than 4

    def test_the_commons_flagship_takes_one_building_lot(self):
        c = self.o["commons"]
        s = c["site"]
        self.assertEqual((s["id"], s["kind"], s["tier"]), ("dealer:0", "dealer", 2))
        self.assertTrue(s["flagship"])
        self.assertEqual(s["name"], "Flagship Dealership")
        self.assertEqual(c["lotKind"], "dealer", "worldbuild draws no building on its lot")
        self.assertIn(c["district"], ("commercial", "downtown", "office", "finance", "oldtown", "tech", "media", "studio"))
        self.assertGreaterEqual(c["F"]["w"], 30)
        self.assertGreaterEqual(c["F"]["d"], 24)
        self.assertTrue(c["same"], "place() again: the same site, not a second one")
        self.assertEqual(c["dealers"], 1)
        self.assertEqual(c["pick"], s["lot"], "every client picks the same lot")
        self.assertEqual(c["places"], [{"label": "Flagship Dealership", "icon": "🚘"}], "Go to lists it")

    def test_live_commons_ids(self):
        """D2: the Commons is claude-hq@3 now; the @2 id is the same place (both get the flagship)."""
        self.assertTrue(self.o["commonsV2"]["site"]["flagship"])
        self.assertEqual(self.o["commonsV2"]["site"]["lot"], self.o["commons"]["site"]["lot"])
        self.assertEqual(self.o["isCommons"], [True, True, True, False, False, False])
        self.assertNotIn('"claude-hq@2"', read("games", "hqdealer.js"))

    def test_remote_mode_for_the_phone(self):
        r = self.o["remote"]
        self.assertEqual(r["tests"], 0, "no test drive from a phone")
        self.assertIn("Delivered to your carpark", r["note"])
        self.assertGreater(r["gets"], 0)
        self.assertEqual(len(r["buys"]), 1, "Get it goes through HQV.hqGarage.buy")
        self.assertEqual(r["buys"][0][1], 1, "with the paint's index")
        self.assertEqual(r["onGet"], 0, "opts.onGet is not used in remote mode")
        self.assertEqual(len(r["bought"]), 1)
        self.assertEqual(r["bought"][0]["vehicleId"], r["buys"][0][0])
        self.assertEqual(r["bought"][0]["id"], "0b8e4c1a-3f2d-4e5b-9a6c-7d8e9f0a1b2c")
        self.assertIn("Delivered to your carpark", r["status"])
        self.assertIn("didn't work", r["failStatus"])
        self.assertEqual(r["boughtAfterFail"], 1, "a failed buy reports nothing bought")

    def test_from_tier_2_only(self):
        self.assertIsNotNone(self.o["commons2"]["site"])
        self.assertIsNone(self.o["commons1"]["site"])
        self.assertEqual(self.o["commons2"]["site"]["lot"], self.o["commons"]["site"]["lot"], "the same lot whatever the tier")

    def test_an_island_gets_one_too(self):
        i = self.o["island"]
        self.assertIsNotNone(i["site"])
        self.assertFalse(i["site"]["flagship"])
        self.assertEqual(i["site"]["name"], "Dealership")

    def test_layout_fits_the_hall_and_the_forecourt(self):
        for key in ("layoutBig", "layoutSmall"):
            L = self.o[key]
            h = L["hall"]
            self.assertGreater(len(L["cells"]), 0, key)
            for cell in L["cells"]:
                self.assertGreaterEqual(cell["x"] - cell["r"], h["x0"], key)
                self.assertLessEqual(cell["x"] + cell["r"], h["x1"], key)
                self.assertGreaterEqual(cell["z"] - cell["r"], h["z0"], key)
                self.assertLessEqual(cell["z"] + cell["r"], h["z1"], key)
            cs = L["cells"]
            for i in range(len(cs)):
                for j in range(i + 1, len(cs)):
                    a, b = cs[i], cs[j]
                    self.assertGreaterEqual(((a["x"] - b["x"])**2 + (a["z"] - b["z"])**2)**0.5, a["r"] + b["r"] - 1e-6, key + ": turntables overlap")
            self.assertGreaterEqual(len(L["slots"]), 2, key)
            for s in L["slots"]:
                self.assertGreater(s["z"], h["z1"], key + ": a bay is out on the forecourt")
                self.assertLess(abs(s["x"]), L["W"]/2, key)
        self.assertEqual(len(self.o["layoutBig"]["cells"]), 32, "the flagship fits the whole lineup")
        self.assertLess(len(self.o["layoutSmall"]["cells"]), 32, "a small showroom shows what fits")

    def test_panel_model_is_free_and_unlocked(self):
        M = self.o["model"]["tabs"]
        self.assertEqual([t["kind"] for t in M], ["car", "bike"])
        on_sale = 0
        for t in M:
            for s in t["sections"]:
                for c in s["classes"]:
                    self.assertTrue(1 <= len(c["vehicles"]) <= self.slots.get(c["id"], 4), c["id"])   # 3.9: 1 to 4 a class ([3.17] or its slots)
                    on_sale += 1
                    for v in c["vehicles"]:
                        self.assertFalse(v["locked"], v["id"])
                        self.assertTrue(v["canGet"], v["id"])
                        self.assertEqual(v["action"], "Yours · repaint" if v["id"] == "bmw-m2" else "Get it", v["id"])
                        self.assertEqual(v["priceText"], "Free", v["id"])
        by_class = {}
        for v in self.cat["vehicles"]:
            if isinstance(v.get("slot"), int) and 1 <= v["slot"] <= self.slots.get(v["class"], 4):
                by_class.setdefault(v["class"], []).append(v)
        self.assertEqual(on_sale, sum(1 for k, vs in by_class.items() if 1 <= len(vs) <= self.slots.get(k, 4)))
        m2 = [v for t in M for s in t["sections"] for c in s["classes"] for v in c["vehicles"] if v["id"] == "bmw-m2"][0]
        self.assertEqual(m2["owned"], 1)

    def test_panel_model_without_a_garage_and_with_prices(self):
        v0 = self.o["modelNoGarage"]["tabs"][0]["sections"][0]["classes"][0]["vehicles"][0]
        self.assertFalse(v0["canGet"])
        self.assertEqual(v0["action"], "Getting vehicles opens soon")
        m2 = [v for t in self.o["modelPaid"]["tabs"] for s in t["sections"] for c in s["classes"] for v in c["vehicles"] if v["id"] == "bmw-m2"][0]
        self.assertTrue(m2["locked"])
        self.assertEqual(m2["action"], "Needs level 20")
        self.assertEqual(m2["priceText"], "12,000 coins")
        self.assertEqual(self.o["prices"], ["Free", "1,500 coins", "125,000 coins"])

    def test_the_building(self):
        b = self.o["build"]
        self.assertEqual(b["vehicles"], b["cells"], "a vehicle on every turntable")
        self.assertEqual(b["vehicles"], b["onSale"], "the flagship shows every vehicle on sale")
        self.assertLessEqual(b["dc"], 90, "draw calls: one per vehicle, the rest merged or instanced")
        self.assertEqual(b["inst"], 2, "the turntables and their rims: two InstancedMeshes")
        self.assertLess(b["vehTris"], 6000)          # the detailed stand-ins (3.5.5), baked to one draw per turntable
        self.assertGreater(b["turned"], 0, "the turntables turn")
        self.assertGreaterEqual(b["boxes"], 1)
        self.assertGreaterEqual(b["lod"], 1)
        self.assertEqual(b["doors"], [{"kind": "dealer", "live": True, "hit": True}])
        self.assertGreaterEqual(len(b["forecourt"]), 4)
        for p in b["forecourt"]:
            self.assertGreater(p["z"], b["door"]["z"], "the bays are in front of the door")
            self.assertLess(p["z"], b["F"]["d"]/2)
        self.assertTrue(b["insideDoor"])
        self.assertFalse(b["insideFar"])

    def test_the_panel(self):
        p = self.o["panel"]
        self.assertTrue(p["open"])
        self.assertEqual(p["tabs"], ["Cars", "Bikes"])
        self.assertEqual(p["getText"], ["Get it"])
        self.assertEqual(p["getDisabled"], 0)
        self.assertTrue(all(1 <= n <= 4 for n in p["pairs"]), "1 to 4 vehicles in every class (two columns, wrapping)")
        self.assertGreaterEqual(max(p["pairs"]), 3)      # a class of three (car.suv.5000) shows them all
        self.assertEqual(p["title"], "🚘 Flagship Dealership")
        self.assertEqual(len(self.o["calls"]["get"]), 1)
        gid, hexc = self.o["calls"]["get"][0]
        self.assertTrue(re.match(r"^#[0-9a-fA-F]{6}$", hexc))
        self.assertEqual(p["status"], "Delivered to the garage — press C to call it.")
        self.assertTrue(p["keyStopped"], "keys in the panel never reach the page or the avatar")
        self.assertTrue(p["owns"])
        self.assertFalse(p["ownsOutside"])
        self.assertEqual(len(self.o["calls"]["test"]), 1)
        self.assertFalse(p["afterTest"], "Test drive closes the panel")


class DealerWiring(unittest.TestCase):
    def test_hq3d(self):
        src = read("games", "hq3d.js")
        self.assertIn('else if(d.kind === "dealer") dealerOpen();', src)
        self.assertIn("dealer: {open: function(){ return dealerOpen(); }}", src, "the ctx hook the City's E calls")
        self.assertIn("HQV.hqDealer.owns(e)", src, "the dealer panel keeps its keys")
        self.assertIn("testStep(dt);", src)
        self.assertIn('SHOW_DEV && HQV.hqShowroom', src, "the temporary Showroom only behind ?dev=1")
        self.assertIn("delivered to the garage — press C to call it", src)

    def test_hqcity3d(self):
        src = read("games", "hqcity3d.js")
        i = src.index("dealerSite = HQV.hqDealer.place(W, tier)")
        self.assertLess(i, src.index("wb = HQV.worldbuild.create(c, W"), "placed before worldbuild sees the lots")
        self.assertLess(i, src.index("indexBuildings();\n    wb = HQV.worldbuild"), "and before the building index")
        self.assertIn("HQV.hqDealer.build(c, dealerSite", src)
        self.assertIn("c.dealer.open()", src)

    def test_scripts_and_icons(self):
        self.assertIn('"hqdealer"', read("ui", "app", "22-hq.js"))
        self.assertIn('dealer: ["Dealership", "🚘"]', read("games", "hqnav.js"))
        mm = read("games", "hqminimap.js")
        self.assertIn('dealer: {col: "#1c66b5", g: "car"}', mm)
        self.assertIn('"dealer"', mm.split("var POI_ORDER")[1].split("\n")[0])
        css = read("games", "games.css")
        self.assertIn(".hqdealer{", css)
        block = css.split(".hqdealer{")[1].split("/* ====")[0]
        self.assertNotRegex(block, r"#[0-9a-fA-F]{3,6}\b", "the panel's CSS uses the theme tokens")

    def test_panel_is_text_only(self):
        src = read("games", "hqdealer.js")
        self.assertNotIn("innerHTML", src)
        self.assertNotIn("Math.random", src)


if __name__ == "__main__":
    unittest.main()
