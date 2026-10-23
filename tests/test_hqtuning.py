"""The Tuning shop (games/hqtuning.js, HQ 3.13; the Arena's half is backend/src/tuning.rs and its tests).

node: the canonical tune and presence's short code (the same bytes the Arena writes), plate validation (and the same
banned list as the Arena), every catalogue vehicle built with the heaviest tune against the budgets (cars <= 16 draw
calls and < 8k triangles, bikes <= 12 and < 6k) with its rider anchors, wheels and radius unchanged, the material half
applied live, the starters' tune, the exhaust's change to the engine note, where the shop stands (the lot nearest the
dealership, from tier 2, in Go to as "Tuning shop"), the workshop and the panel under a DOM stub. The Python side checks
the wiring (hq3d, the City, presence, the garage manager's Tune, the basement's plinths, the proxy). Skipped without
node. Stdlib only."""
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
  this.style = {}; this.hidden = false; this.disabled = false; this._t = ""; this.className = ""; this.type = ""; this.title = ""; this.value = ""; }
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
El.prototype.fire = function(t, e){ (this.ls[t] || []).slice().forEach(f => f(Object.assign({target: this}, e || {}))); };
El.prototype.click = function(){ this.fire("click"); };
globalThis.document = {createElement: t => new El(t), documentElement: new El("html")};
const store = {};
globalThis.window = {HQV: {}, document: globalThis.document, localStorage: {getItem: k => store[k] || null, setItem(k, v){ store[k] = String(v); }}};
for (const f of ["world", "hqmerge", "hqvehicles", "hqvehiclemodels", "hqnav", "hqdealer", "hqgarage", "hqtuning"])
  new Function(fs.readFileSync(root + "/games/" + f + ".js", "utf8"))();
const H = window.HQV, TN = H.hqTuning, VM = H.hqVehicleModels, WD = H.world;
const cat = JSON.parse(fs.readFileSync(root + "/games/vehicles/catalogue.json", "utf8"));
const out = {};

/* ---------- the tune and its code ---------- */
const full = {finish: "pearl", color: "#12AB9F", two_tone: "stripe", color2: "#ffffff", rim: 5, rim_color: "#c9a227", rim_size: 2, tint: 3, wing: "gt", exhaust: "titanium", plate: "hq 42-x"};
out.code = TN.encode(full, "car");
out.back = TN.decode(out.code, "car");
out.stock = [TN.encode({}, "car"), TN.encode(TN.defaults(), "bike"), TN.isStock({}, "car"), TN.isStock(full, "car")];
out.bikeNorm = TN.normalize({wing: "gt", two_tone: "roof", color2: "#000000", exhaust: "quad"}, "bike");
out.bikeEx = TN.normalize({exhaust: "underseat"}, "bike").exhaust;
out.badDecode = ["", "0001000--", "9001000---", "0001000---TOOLONGPLATE", "0001000--x", "0001000---hq", "0201000---", "0001000---FUCK", "0004000---", 7]
  .map(c => TN.decode(c, "car"));
out.plates = ["", "HQ 42-X", "abcd1234", "  hq   7 ", "ABCDEFGHI", "HQ!", "SH1T", "B1-TCH", "5EX", "N4Z1"].map(s => { const r = TN.plateCheck(s); return [r.ok, r.text]; });
out.banned = TN.BANNED;
out.exhaustOf = [TN.exhaustOf(full), TN.exhaustOf({exhaust: "stock"}), TN.exhaustOf(null)];

/* ---------- every catalogue vehicle, heaviest tune: budgets, anchors and the rig unchanged ---------- */
const v3 = () => new THREE.Vector3();
function wpos(o){ o.updateWorldMatrix(true, false); return o.getWorldPosition(v3()).toArray().map(n => Math.round(n*1e4)/1e4); }
function rigInfo(r){ r.g.updateMatrixWorld(true); return {R: r.R, radii: r.radii, seat: wpos(r.seat), grips: r.grips.map(g => g ? wpos(g) : null), feet: r.feet.map(f => f ? wpos(f) : null),
  wheels: r.wheels.map(w => wpos(w)), steer: Array.isArray(r.steer) ? r.steer.map(s => s.name) : r.steer.name}; }
out.cat = [];
for (const v of cat.vehicles.filter(v => v.slot !== "starter")){
  const r0 = VM.build(THREE, v, 0x3366cc), bike = r0.kind === "bike", base = JSON.stringify(rigInfo(r0)), row = {id: v.id, kind: r0.kind, tris: 0, dc: 0, same: true, dc0: VM.drawCalls(r0)};
  for (let rim = 0; rim < 6; rim++) for (const two of bike ? ["stripe", "livery"] : ["roof", "stripe", "livery"]){
    const t = Object.assign({}, full, {rim, two_tone: two, wing: bike ? "none" : "gt", exhaust: bike ? "endcan" : "titanium"});
    const r = VM.build(THREE, v, 0x3366cc, {tune: t});
    row.tris = Math.max(row.tris, VM.triangles(r)); row.dc = Math.max(row.dc, VM.drawCalls(r));
    if(JSON.stringify(rigInfo(r)) !== base){ row.same = false; row.diff = [rim, two]; }
  }
  out.cat.push(row);
}
/* ---------- the materials, live; shared geometry; the plate ---------- */
const m3 = cat.vehicles.filter(v => v.id === "bmw-m3-competition")[0], rr = cat.vehicles.filter(v => v.id === "bmw-s-1000-rr")[0];
const a = VM.build(THREE, m3, 0x111111, {tune: full}), b = VM.build(THREE, m3, 0xeeeeee, {tune: full}), s0 = VM.build(THREE, m3, 0x111111);
const geo = r => r.meshes.filter(m => m.userData.mk !== "plate").map(m => m.geometry.uuid).sort().join();
const glass = r => r.meshes.filter(m => m.userData.mk === "glass").map(m => m.material);
out.live = {sharedTuned: geo(a) === geo(b), stockApart: geo(a) !== geo(s0), plate: a.meshes.filter(m => m.userData.mk === "plate").length,
  plate0: s0.meshes.filter(m => m.userData.mk === "plate").length, dcPlus: VM.drawCalls(a) - VM.drawCalls(s0),
  map: !!a.paint.map, mapW: a.paint.map ? a.paint.map.image.width : 0, finish: [a.paint.metalness, a.paint.roughness],
  ownGlass: glass(a)[0] !== glass(s0)[0], glassOpacity: glass(a)[0].opacity,
  matLive: a.setTune(Object.assign({}, full, {finish: "matte", tint: 1, color: "#00ff00"})), finish2: [a.paint.metalness, a.paint.roughness],
  geoLive: a.setTune(Object.assign({}, full, {rim: 1})), plateLive: a.setTune(Object.assign({}, full, {plate: ""})),
  stockFinish: [s0.paint.metalness, s0.paint.roughness], sameGeo: VM.sameGeo(full, Object.assign({}, full, {tint: 0}), "car")};
const bk = VM.build(THREE, rr, 0x111111, {tune: {exhaust: "underseat", rim: 3, two_tone: "livery", color2: "#000000", plate: "RR 1"}});
out.bike = {dc: VM.drawCalls(bk), plate: bk.meshes.filter(m => m.userData.mk === "plate").length, map: !!bk.paint.map};
/* ---------- the starters: hq3d's own models, tuned in place ---------- */
function starterRig(){
  const g = new THREE.Group(), M = {paint: new THREE.MeshStandardMaterial({color: 0x123456}), accent: new THREE.MeshStandardMaterial({color: 0xffffff}),
    rim: new THREE.MeshStandardMaterial({color: 0x888888}), glass: new THREE.MeshStandardMaterial({opacity: 0.26, transparent: true}), tint: new THREE.MeshStandardMaterial({opacity: 0.5, transparent: true}),
    chrome: new THREE.MeshStandardMaterial()};
  const body = new THREE.Mesh(new THREE.BoxGeometry(2, 1.6, 4), M.paint); body.position.y = 0.8; g.add(body);
  const w = new THREE.Group(); w.name = "wheel-0"; const rim = new THREE.Mesh(new THREE.CylinderGeometry(0.3, 0.3, 0.2), M.rim); rim.userData.mk = "rim"; w.add(rim); g.add(w);
  return {g, M};
}
const calls = [];
const ctx = {THREE, car(p, acc, plate){ calls.push(["car", p, acc, plate]); return starterRig(); }, moto(p, acc, plate){ calls.push(["moto", p, acc, plate]); return starterRig(); }};
const st = VM.build(ctx, {id: "starter-car", starter: true}, 0x123456, {tune: full, accent: 0xabcdef, plate: "MY HQ"});
const stPlain = VM.build(ctx, {id: "starter-car", starter: true}, 0x123456, {plate: "MY HQ"});
const ex = st.g.getObjectByName("tune:extras");
out.starter = {calls, paint: st.M.paint.color.getHexString(), accent: st.M.accent.color.getHexString(), rim: st.M.rim.color.getHexString(),
  glass: st.M.glass.opacity, extras: ex ? ex.children.length : 0, rimScale: st.g.getObjectByName("wheel-0").children[0].scale.y,
  plainExtras: !!stPlain.g.getObjectByName("tune:extras")};
/* ---------- the engine note ---------- */
{
  const w2 = {HQV: {}, matchMedia: () => ({matches: false})};
  new Function("window", "document", fs.readFileSync(root + "/games/engine.js", "utf8"))(w2, {documentElement: {classList: {contains: () => false}}});
  const E = w2.HQV.engine, P = (k, x) => E.engineProfile(k, x);
  out.engine = {exhausts: E.exhausts, stock: P("v8"), sport: P("v8", "sport"), titanium: P("v8", "titanium"), quad: P("v8", "quad"), endcan: P("single", "endcan"),
    underseat: P("twin", "underseat"), ev: P("electric", "sport") === P("electric"), same: P("v8", "nope") === P("v8"), untouched: P("v8") === P("v8")};
}
/* ---------- the store: starters in localStorage ---------- */
let saved = null; const unsub = TN.onChange(k => { saved = k; });
const r1 = await TN.save("starter:moto", {exhaust: "slipon", plate: "zoom"}, null, "bike");
out.store = {r1, saved, of: TN.of("starter:moto"), none: TN.of("starter:car")};
await TN.save("starter:moto", {}, null, "bike"); out.store.cleared = TN.of("starter:moto"); unsub();
// owned: through the proxy, into hqGarage's cache
H.hqGarage._io.fetch = (u, o) => Promise.resolve({ok: true, status: 200, json: () => Promise.resolve(u.indexOf("/mine") > 0 ? {vehicles: [{id: "a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d", vehicle_id: "bmw-m3-competition", paint: 0}]} : (out.posted = [u, JSON.parse(o.body)], {ok: true, tuning: JSON.parse(o.body).tuning, paint: 1}))});
TN._io.fetch = H.hqGarage._io.fetch;
await H.hqGarage.mine();
const r2 = await TN.save("own:a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d", full, 1, "car");
out.owned = {r2, of: TN.of("own:a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d"), paint: H.hqGarage.cached()[0].paint, bad: await TN.save("own:../x", full, 0, "car")};

/* ---------- where it stands ---------- */
const gz = p => JSON.parse(zlib.gunzipSync(fs.readFileSync(p)).toString("utf8"));
function placed(file, id, tier){
  const W = WD.pack(gz(file)); W.id = id;
  const d = H.hqDealer.place(W, tier), s = TN.place(W, tier);
  if(!s) return {site: null};
  const lot = W.lots.filter(l => l.id === s.lot)[0], F = H.hqDealer.frame(s);
  const nearest = W.lots.filter(l => l.kind === "building" && H.hqDealer.frame(l).w >= 18 && H.hqDealer.frame(l).d >= 16)
    .map(l => { const f = H.hqDealer.frame(l); return Math.hypot(f.cx - d.x/100, f.cz - d.z/100); }).sort((x, y) => x - y)[0];
  return {site: {id: s.id, kind: s.kind, tier: s.tier, name: s.name}, lotKind: lot.kind, same: TN.place(W, tier) === s, F: {w: F.w, d: F.d},
    fromDealer: Math.hypot(F.cx - d.x/100, F.cz - d.z/100), nearestOther: nearest,
    places: H.hqnav.places(W, tier, {x: 0, z: 0}).filter(p => p.kind === "tuning").map(p => ({label: p.label, icon: p.icon})),
    dealerLot: d.lot !== s.lot, Wc: W};
}
const pc = placed(%(commons)s, "claude-hq@2", 5);
out.place = Object.assign({}, pc, {Wc: undefined});
out.place1 = placed(%(commons)s, "claude-hq@2", 1).site;
out.island = placed(%(island)s, "user:x@2", 3).site;

/* ---------- the workshop ---------- */
function mat(c, o){ return new THREE.MeshStandardMaterial(Object.assign({color: c, roughness: 0.7}, o || {})); }
function add(o, x, y, z, p){ o.position.set(x, y, z); p.add(o); return o; }
var c = {THREE, mat, box(w, h, d, m, x, y, z, p){ return add(new THREE.Mesh(new THREE.BoxGeometry(w, h, d), m), x, y, z, p); },
  cyl(rt, rb, h, m, x, y, z, p, seg){ return add(new THREE.Mesh(new THREE.CylinderGeometry(rt, rb, h, seg || 12), m), x, y, z, p); },
  canvasTex(w, h, draw){ return {t: new THREE.Texture()}; }, glow(col, s, o){ return new THREE.Sprite(new THREE.SpriteMaterial({color: col, opacity: o, transparent: true})); }};
const site = TN.place(pc.Wc, 5), B = TN.build(c, site, {tier: 5, night: true});
let dc = 0; B.g.traverse(o => { if((o.isMesh || o.isSprite) && o.visible) dc++; });
B.setNight(false); B.setNight(true);
out.build = {dc, doors: B.doors.map(d => ({kind: d.kind, live: d.live, label: d.label, hit: B.hits[0].userData.door === d})), boxes: B.boxes.length, lod: B.lod.length,
  insideDoor: B.inside(B.door.x, B.door.z), insideFar: B.inside(B.x + 500, B.z + 500), top: B.top, kind: B.kind};

/* ---------- the panel ---------- */
const stage = new El("div"), saves = [];
const items = [{key: "own:x", title: "BMW M3 Competition", kind: "car", entry: m3, paints: m3.paints, paint: 0, tune: null, ev: false},
               {key: "starter:moto", title: "Your starter motorbike", kind: "bike", entry: {id: "starter-moto", kind: "bike", starter: true}, baseHex: 0x334455, paints: [], paint: 0, tune: null}];
const ui = TN.mountPanel(stage, {three: THREE, ctx, vehicles: () => items, plate: () => "Claude's HQ",
  save(it, t, p){ saves.push([it.key, t, p]); return Promise.resolve({ok: true, text: "Done: saved to your garage."}); }});
ui.open({key: "own:x"});
const R = ui.root, q = s => R.querySelectorAll(s);
out.panel = {role: R.getAttribute("role"), tabs: q(".hqtune-tab").map(t => t.textContent), saveDisabled: R.querySelector(".hqtune-save").disabled,
  options: q(".hqtune-pick")[0].children.map(o => o.textContent)};
q(".hqtune-chip").filter(b => b.textContent === "Matte")[0].click();
q(".hqtune-chip").filter(b => b.textContent === "Stripes")[0].click();
out.panel.afterChips = ui.draft();
q(".hqtune-tab").filter(t => t.textContent === "Plate")[0].click();
const pin = R.querySelector(".hqtune-plate").children[0];
out.panel.placeholder = pin.placeholder;
pin.value = "sh1t"; pin.fire("input"); out.panel.badPlate = [R.querySelector(".hqtune-tip").textContent, ui.draft().plate];
pin.value = "fast 1"; pin.fire("input"); out.panel.goodPlate = ui.draft().plate;
q(".hqtune-tab").filter(t => t.textContent === "Aero")[0].click();
q(".hqtune-chip").filter(b => b.textContent === "GT wing")[0].click();
R.querySelector(".hqtune-save").click(); await new Promise(r => setTimeout(r, 0));
out.panel.saves = saves; out.panel.status = R.querySelector(".hqtune-status").textContent;
// a bike: no wing, no tint
const pick = R.querySelector(".hqtune-pick"); pick.value = "starter:moto"; pick.fire("change");
out.panel.bikeTabs = q(".hqtune-tab").map(t => t.textContent); out.panel.cur = ui.current();
q(".hqtune-tab").filter(t => t.textContent === "Exhaust")[0].click();
out.panel.bikeEx = q(".hqtune-chip").map(b => b.textContent);
let esc = false; const ev = {type: "keydown", key: "Escape", stopPropagation(){}, preventDefault(){ esc = true; }};
R.fire("keydown", ev); out.panel.closed = !ui.isOpen(); out.panel.owns = TN.owns({target: R.querySelector(".hqtune-save")});
console.log(JSON.stringify(out));
"""


@unittest.skipUnless(NODE, "node is not installed")
class Tuning(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        src = HARNESS % {"root": json.dumps(ROOT), "commons": json.dumps(os.path.join(FIX, "claude-hq@2.json.gz")),
                         "island": json.dumps(os.path.join(FIX, "island@2.json.gz"))}
        r = subprocess.run([NODE, "--input-type=module", "-e", src], capture_output=True, text=True, timeout=600)
        if r.returncode:
            raise AssertionError(r.stderr[-3000:])
        cls.o = json.loads(r.stdout.strip().splitlines()[-1])

    def test_the_code_is_the_arenas(self):
        o = self.o
        # the same bytes as backend/src/tuning.rs's test (the_presence_code_is_short_and_round_trips)
        self.assertEqual(o["code"], "325333312ab9fffffffc9a227HQ_42-X")
        self.assertIn('"325333312ab9fffffffc9a227HQ_42-X"', read("backend", "src", "tuning.rs"))
        self.assertLessEqual(len(o["code"]), 33)
        self.assertEqual(o["back"]["color"], "#12ab9f")
        self.assertEqual((o["back"]["plate"], o["back"]["wing"], o["back"]["exhaust"], o["back"]["rim_size"]), ("HQ 42-X", "gt", "titanium", 2))
        self.assertEqual(o["stock"], ["0001000---", "0001000---", True, False])
        self.assertEqual(o["badDecode"], [None]*10)
        # a bike: no wing, no roof, its own exhausts
        self.assertEqual((o["bikeNorm"]["wing"], o["bikeNorm"]["two_tone"], o["bikeNorm"]["exhaust"]), ("none", "none", "stock"))
        self.assertEqual(o["bikeEx"], "underseat")
        self.assertEqual(o["exhaustOf"], ["titanium", None, None])

    def test_plates(self):
        self.assertEqual(self.o["plates"], [[True, ""], [True, "HQ 42-X"], [True, "ABCD1234"], [True, "HQ 7"], [False, "ABCDEFGHI"],
                                            [False, "HQ!"], [False, "SH1T"], [False, "B1-TCH"], [False, "5EX"], [False, "N4Z1"]])
        rs = read("backend", "src", "tuning.rs")
        body = rs.split("pub const BANNED")[1].split("];")[0]
        self.assertEqual(re.findall(r'"([A-Z]+)"', body), self.o["banned"], "the page and the Arena filter the same words")

    def test_budgets_with_the_heaviest_tune(self):
        for r in self.o["cat"]:
            car = r["kind"] == "car"
            self.assertLessEqual(r["dc"], 16 if car else 12, r)
            self.assertLess(r["tris"], 8000 if car else 6000, r)
            self.assertLessEqual(r["dc"] - r["dc0"], 1, ("a tune adds one mesh at most: the plate", r))
            self.assertTrue(r["same"], ("the rider's anchors, the wheels, the radius are the stock rig's", r))
        self.assertGreaterEqual(len(self.o["cat"]), 40)

    def test_materials_live_and_shared_geometry(self):
        L = self.o["live"]
        self.assertTrue(L["sharedTuned"], "two copies of one tune share their geometry")
        self.assertTrue(L["stockApart"], "a tuned blueprint is its own")
        self.assertEqual((L["plate"], L["plate0"], L["dcPlus"]), (1, 0, 1))
        self.assertTrue(L["map"]); self.assertEqual(L["mapW"], 2, "two-tone: a 2 x 1 texel paint")
        self.assertEqual(L["finish"], [0.45, 0.14], "pearl")
        self.assertTrue(L["ownGlass"]); self.assertAlmostEqual(L["glassOpacity"], 0.92)
        self.assertTrue(L["matLive"], "finish, tint and colour change live")
        self.assertEqual(L["finish2"], [0.12, 0.86], "matte")
        self.assertFalse(L["geoLive"], "a rim design needs a rebuild")
        self.assertFalse(L["plateLive"], "so does taking the plate away")
        self.assertEqual(L["stockFinish"], [0.55, 0.3], "an untuned vehicle keeps its old paint")
        self.assertTrue(L["sameGeo"])
        self.assertLessEqual(self.o["bike"]["dc"], 12)
        self.assertEqual((self.o["bike"]["plate"], self.o["bike"]["map"]), (1, True))

    def test_the_starters(self):
        s = self.o["starter"]
        self.assertEqual(s["calls"][0], ["car", 0x123456, 0xabcdef, "HQ 42-X"], "the plate's text goes to hq3d's own car")
        self.assertEqual(s["calls"][1], ["car", 0x123456, None, "MY HQ"], "untuned: the HQ's name stays")
        self.assertEqual((s["paint"], s["accent"], s["rim"]), ("12ab9f", "ffffff", "c9a227"))
        self.assertAlmostEqual(s["glass"], 0.92)
        self.assertEqual(s["extras"], 2, "a wing in the paint and the tips: two meshes")
        self.assertAlmostEqual(s["rimScale"], 1.08)
        self.assertFalse(s["plainExtras"])

    def test_the_engine_note(self):
        e = self.o["engine"]
        self.assertEqual(sorted(e["exhausts"]), ["endcan", "quad", "slipon", "sport", "titanium", "underseat"])
        st, sp, ti, qd = e["stock"], e["sport"], e["titanium"], e["quad"]
        self.assertGreater(sp["gain"], st["gain"]); self.assertGreater(sp["grit"], st["grit"]); self.assertGreater(sp["cut"][1], st["cut"][1])   # louder, raspier
        self.assertGreater(ti["pops"], sp["pops"]); self.assertGreater(ti["pops"], st["pops"])                                                     # titanium crackles most
        self.assertGreater(qd["sub"], st["sub"])
        self.assertGreater(e["endcan"]["pops"], 0.7); self.assertGreater(e["underseat"]["gain"], 0.045)
        self.assertLess(sp["gain"]/st["gain"], 1.3, "slightly")
        self.assertTrue(e["ev"] and e["same"] and e["untouched"], "an electric motor and stock keep their own profile")
        src = read("games", "engine.js")
        self.assertIn("function engineSound(kind, ex){\n  var P = engineProfile(kind, ex);", src)
        self.assertIn("E.engineSound(V.eng, ride.tune && HQV.hqTuning ? HQV.hqTuning.exhaustOf(ride.tune) : null)", read("games", "hq3d.js"))

    def test_the_store(self):
        s = self.o["store"]
        self.assertTrue(s["r1"]["ok"]); self.assertEqual(s["saved"], "starter:moto")
        self.assertEqual((s["of"]["exhaust"], s["of"]["plate"]), ("slipon", "ZOOM"))
        self.assertIsNone(s["none"]); self.assertIsNone(s["cleared"], "stock clears it")
        o = self.o["owned"]
        self.assertTrue(o["r2"]["ok"]); self.assertEqual(o["of"]["wing"], "gt"); self.assertEqual(o["paint"], 1)
        self.assertFalse(o["bad"]["ok"])
        self.assertEqual(self.o["posted"][0], "/api/arena/vehicles/a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d/tuning")
        self.assertEqual(set(self.o["posted"][1]), {"tuning", "paint"})

    def test_where_it_stands(self):
        p = self.o["place"]
        self.assertEqual(p["site"], {"id": "tuning:0", "kind": "tuning", "tier": 2, "name": "Tuning shop"})
        self.assertEqual(p["lotKind"], "tuning"); self.assertTrue(p["same"]); self.assertTrue(p["dealerLot"])
        self.assertGreaterEqual(p["F"]["w"], 18); self.assertGreaterEqual(p["F"]["d"], 16)
        self.assertLess(p["fromDealer"], p["nearestOther"] + 60, "about the nearest big-enough lot to the dealership")
        self.assertEqual(p["places"], [{"label": "Tuning shop", "icon": "🔧"}])
        self.assertIsNone(self.o["place1"], "not below tier 2")
        self.assertIsNotNone(self.o["island"])

    def test_the_workshop(self):
        b = self.o["build"]
        self.assertEqual(b["kind"], "tuning")
        self.assertEqual(b["doors"], [{"kind": "tuning", "live": True, "label": "Tuning shop", "hit": True}])
        self.assertEqual((b["boxes"], b["lod"]), (1, 1))
        self.assertTrue(b["insideDoor"]); self.assertFalse(b["insideFar"])
        self.assertLess(b["dc"], 60)

    def test_the_panel(self):
        p = self.o["panel"]
        self.assertEqual(p["role"], "dialog")
        self.assertEqual(p["tabs"], ["Paint", "Wheels", "Windows", "Aero", "Exhaust", "Plate"])
        self.assertTrue(p["saveDisabled"], "nothing to save yet")
        self.assertEqual(p["options"], ["BMW M3 Competition", "Your starter motorbike"])
        self.assertEqual((p["afterChips"]["finish"], p["afterChips"]["two_tone"]), ("matte", "stripe"))
        self.assertTrue(p["afterChips"]["color2"])
        self.assertEqual(p["placeholder"], "CLAUDE'S HQ")
        self.assertEqual(p["badPlate"], ["Pick other letters for the plate.", ""])
        self.assertEqual(p["goodPlate"], "FAST 1")
        key, t, paint = p["saves"][0]
        self.assertEqual((key, t["finish"], t["wing"], t["plate"], paint), ("own:x", "matte", "gt", "FAST 1", 0))
        self.assertEqual(p["status"], "Done: saved to your garage.")
        self.assertEqual(p["bikeTabs"], ["Paint", "Wheels", "Exhaust", "Plate"])
        self.assertEqual(p["cur"], "starter:moto")
        self.assertEqual(p["bikeEx"], ["Stock", "Slip-on", "Under-seat", "End can"])
        self.assertTrue(p["closed"]); self.assertTrue(p["owns"])


class Wiring(unittest.TestCase):
    def test_the_page_loads_and_opens_it(self):
        hq = read("ui", "app", "22-hq.js")
        self.assertIn('"hqdealer","hqtuning"', hq)
        self.assertIn('hqtuning:1', hq)
        src = read("games", "hq3d.js")
        self.assertIn('tuning: {open: function(){ return tuneOpen(); }}', src)
        self.assertIn('else if(d.kind === "tuning") tuneOpen();', src)
        self.assertIn("HQV.hqTuning.host = function(key){ return tuneOpen(key); };", src)
        self.assertIn("if(tuneUi && tuneUi.isOpen()){", src)
        city = read("games", "hqcity3d.js")
        i = city.index("tuningSite = HQV.hqTuning.place(W, tier)")
        self.assertGreater(i, city.index("casinoSite = HQV.hqCasino.place(W, tier)"), "after the dealership and the casino")
        self.assertLess(i, city.index("wb = HQV.worldbuild.create(c, W"), "before worldbuild sees the lots")
        self.assertIn("HQV.hqTuning.build(c, tuningSite", city)
        self.assertIn("c.tuning.open()", city)
        self.assertIn('tuning: ["Tuning shop", "🔧"]', read("games", "hqnav.js"))
        mm = read("games", "hqminimap.js")
        self.assertIn('tuning: {col: "#b8452c", g: "wrench"}', mm)
        self.assertIn('"tuning"', mm.split("var POI_ORDER")[1].split("\n")[0])

    def test_presence_is_gated_and_compact(self):
        hq = read("ui", "app", "22-hq.js")
        self.assertIn('var vt = (a===5 || a===6) && hqNetCan("tuning") && HQ3D.inst.tuneCode ? HQ3D.inst.tuneCode() : null;', hq)
        self.assertIn("msg.cg,msg.vt].join", hq)
        self.assertIn('"convoy", "tuning"]', read("backend", "src", "protocol.rs"))
        src = read("games", "hq3d.js")
        self.assertIn("inst.tuneCode = function(){", src)
        self.assertIn("HQV.hqVehicleModels.build(ctx, Vc, ph, {tune: ptn})", src)
        self.assertIn('vk + ":" + P.vp : vk) + (vk && P.vt ? "~" + P.vt : "")', src)

    def test_owned_vehicles_garage_and_basement(self):
        src = read("games", "hq3d.js")
        self.assertIn('{tune: HQV.hqTuning && o.ownId != null ? HQV.hqTuning.of("own:" + o.ownId) : null}', src)   # the City's props
        self.assertIn("HQV.hqVehicleModels.build(ctx, Vc, b.color, {tune: tn})", src)                            # the one you get in
        self.assertIn("M: V.M};", src)
        b1 = read("games", "hqbasement.js")
        self.assertIn("HQV.hqVehicleModels.build(c, entry, hex, {tune: r.tune})", b1)
        self.assertIn("b.tsig === r.tsig", b1)
        self.assertIn('Tn.onChange(function(key){', b1)
        gm = read("games", "hqgaragemgr.js")
        self.assertIn('"hqgm-btn hqgm-tune", "Tune"', gm)
        self.assertIn("HQV.hqTuning.openFor(tk)", gm)
        self.assertIn("tuning: v.tuning && typeof v.tuning === \"object\"", read("games", "hqgarage.js"))
        self.assertIn('vehicle_tuning_target(path)', read("dashboard-rs", "src", "server.rs"))
        self.assertIn('"/v1/vehicles/:id/tuning"', read("backend", "src", "tuning.rs"))
        self.assertTrue(os.path.exists(os.path.join(ROOT, "backend", "migrations", "0020_vehicle_tuning.sql")))

    def test_house_rules(self):
        src = read("games", "hqtuning.js")
        self.assertNotIn("innerHTML", src)
        self.assertNotIn("Math.random", src)
        self.assertNotIn("let ", src.split("(function(){", 1)[1])
        css = read("games", "games.css")
        block = css.split(".hqtune{")[1].split("/* ====")[0]
        self.assertNotRegex(block, r"#[0-9a-fA-F]{3,6}\b", "the panel's CSS uses the theme tokens")
        self.assertNotIn("animation", block)


if __name__ == "__main__":
    unittest.main()
