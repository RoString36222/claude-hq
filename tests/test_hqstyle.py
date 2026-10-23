"""HQ Studio's style document (games/hqstyle.js), the interiors it styles (games/hqdecor.js, games/hqlobby.js) and the
Studio panel's wiring (ui/app/40-studio.js).

The schema exists three times and must match: games/hqstyle/schema.json (the browser's copy), backend/data/hqstyle.json
(what the Arena validates with; tests/test_game_data_sync.py keeps the two byte-identical) and SCHEMA in hqstyle.js.
Then, under node: defaults and presets are valid, check() refuses what the Arena refuses (unknown keys, bad enums and
colours, too many items, two on one cell, off the grid, too big), clean() turns anything into a valid document, the
layout's limits hold, the lobby's pet spots come out of its pet furniture and water, the lobby builds every set piece
with your decor instanced and calls the pets' hook, Mission Control takes its theme and furniture. Stdlib only."""
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


HARNESS = r"""
import fs from "fs";
const root = %(root)s;
const THREE = await import(root + "/games/vendor/three-module.js");
globalThis.window = {HQV: {}};
const HQV = window.HQV;
for (const f of ["hqstyle", "hqtower", "hqdecor", "hqlobby"]) new Function(fs.readFileSync(root + "/games/" + f + ".js", "utf8"))();
const S = HQV.hqStyle, out = {};
out.schema = S.SCHEMA;
function ok(d){ return S.check(d).ok; }
var d0 = S.defaults();
out.defaultsOk = ok(d0);
out.presets = Object.keys(S.PRESETS).map(k => [k, ok(S.preset(k)), S.preset(k).ext.preset, S.preset(k).ext.facade]);
out.lobbyPresets = Object.keys(S.LOBBY_PRESETS).map(k => [k, ok(S.lobbyPreset(k)), S.lobbyPreset(k).int.lobby.preset]);
out.random = [ok(S.randomise("a")), JSON.stringify(S.randomise("a")) === JSON.stringify(S.randomise("a")), JSON.stringify(S.randomise("a")) !== JSON.stringify(S.randomise("b"))];
function bad(f){ var d = JSON.parse(JSON.stringify(d0)); f(d); return S.check(d).ok; }
out.rejects = {
  unknownTop: bad(d => { d.x = 1; }), unknownExt: bad(d => { d.ext.wat = "a"; }), badEnum: bad(d => { d.ext.crown = "castle"; }),
  badColour: bad(d => { d.ext.body = "red"; }), badColour2: bad(d => { d.ext.body = "#12345g"; }), v2: bad(d => { d.v = 2; }),
  roofDup: bad(d => { d.ext.roof = ["tank", "tank"]; }), roofBad: bad(d => { d.ext.roof = ["pool"]; }), balcony: bad(d => { d.ext.balcony = "yes"; }),
  floorName: bad(d => { d.int.themes.attic = {}; }), themeKey: bad(d => { d.int.themes.lobby.sofa = "x"; }), lobbyKey: bad(d => { d.int.lobby.centre = "volcano"; }),
  intKey: bad(d => { d.int.extra = 1; }), offGrid: bad(d => { d.int.items = [{k: "plant", f: "lobby", x: 14, z: 0, r: 0}]; }),
  float: bad(d => { d.int.items = [{k: "plant", f: "lobby", x: 1.5, z: 0, r: 0}]; }), rot: bad(d => { d.int.items = [{k: "plant", f: "lobby", x: 1, z: 0, r: 4}]; }),
  kind: bad(d => { d.int.items = [{k: "cannon", f: "lobby", x: 1, z: 0, r: 0}]; }), extraItemKey: bad(d => { d.int.items = [{k: "plant", f: "lobby", x: 1, z: 0, r: 0, y: 2}]; }),
  sameCell: bad(d => { d.int.items = [{k: "plant", f: "lobby", x: 1, z: 0, r: 0}, {k: "palm", f: "lobby", x: 1, z: 0, r: 1}]; }),
  perFloor: bad(d => { d.int.items = []; for(var i = 0; i < 33; i++) d.int.items.push({k: "plant", f: "lobby", x: -13 + i % 27, z: Math.floor(i/27), r: 0}); }),
  total: bad(d => { d.int.items = []; for(var i = 0; i < 49; i++) d.int.items.push({k: "plant", f: i < 25 ? "lobby" : "mission", x: -13 + i % 25, z: 0, r: 0}); }),
  tooBig: bad(d => { d.pad = "x".repeat(9000); })
};
out.accepts = {sameCellOtherFloor: bad(d => { d.int.items = [{k: "plant", f: "lobby", x: 1, z: 0, r: 0}, {k: "palm", f: "mission", x: 1, z: 0, r: 1}]; }),
  partial: S.check({v: 1, ext: {crown: "dome"}}).ok, upper: S.check({v: 1, ext: {body: "#ABCDEF"}}).style.ext.body};
out.clean = [S.check(S.clean(null)).ok, S.check(S.clean({v: 9, ext: {facade: "<script>", body: "red", roof: "x"}, int: {items: [{k: "plant", f: "lobby", x: 0, z: 0, r: 0}, {k: "x"}, 5]}})).ok,
  S.clean({v: 1, int: {items: [{k: "plant", f: "lobby", x: 0, z: 0, r: 0}, {k: "palm", f: "lobby", x: 0, z: 0, r: 0}]}}).int.items.length];
// placement: replaces on a cell, the per-floor cap, remove
var d = S.defaults(), full = d;
for(var i = 0; i < 32; i++) full = S.place(full, {k: "plant", f: "lobby", x: -13 + i % 27, z: Math.floor(i/27), r: 0});
out.place = {n: full.int.items.length, over: S.place(full, {k: "plant", f: "lobby", x: 5, z: 5, r: 0}) === null, replace: S.place(full, {k: "palm", f: "lobby", x: -13, z: 0, r: 2}).int.items.length,
  other: S.place(full, {k: "palm", f: "mission", x: 0, z: 0, r: 0}).int.items.length, removed: S.remove(full, "lobby", -13, 0).int.items.length, bad: S.place(d, {k: "plant", f: "lobby", x: 40, z: 0, r: 0})};
// the lobby's pet spots: pet furniture -> kind, the centrepiece's water; other floors' furniture not
var pd = S.defaults();
[["petbed", 2, 2], ["cattree", 3, 2], ["perch", 4, 2], ["perchbig", 5, 5], ["dinopen", -5, 5], ["bowl", 6, 2], ["pond", -6, -2], ["plant", 7, 2]].forEach(function(p){ pd = S.place(pd, {k: p[0], f: "lobby", x: p[1], z: p[2], r: 0}); });
pd = S.place(pd, {k: "petbed", f: "mission", x: 0, z: 0, r: 0});
out.pets = S.petSpots(pd).map(s => [s.kind, s.x, s.z]);
pd.int.lobby.centre = "statue"; out.petsNoWater = S.petSpots(pd).filter(s => s.kind === "water").length;
/* ---------- the lobby, built with a customised style ---------- */
var noop2d = new Proxy({}, {get(t, k){ return k === "measureText" ? function(){ return {width: 10}; } : (k === "createLinearGradient" || k === "createRadialGradient") ? function(){ return {addColorStop(){}}; } : function(){}; }, set(){ return true; }});
function mat(c, o){ return new THREE.MeshStandardMaterial(Object.assign({color: c}, o || {})); }
var scene = null;
function add(o, x, y, z, p){ o.position.set(x, y, z); (p || scene).add(o); return o; }
var STYLE = null, petCalls = [];
var c = {THREE, PI: Math.PI, COL: {amber: 0xffb347, cyan: 0x5fd3e6, green: 0x6fd38a, coral: 0xff6b5b}, HEX: {green: "#6fd38a", amber: "#ffb347", cyan: "#5fd3e6", ink: "#e9eff3", muted: "#8e9aa6", coral: "#ff6b5b"},
  E: {calm(){ return false; }, ambientLoop(){ return {set(){}, stop(){}}; }}, mat, emis(cl, e, ei, o){ var m = mat(cl, o); m.emissive = new THREE.Color(e); m.emissiveIntensity = ei; return m; }, add,
  box(w, h, dd, m, x, y, z, p){ return add(new THREE.Mesh(new THREE.BoxGeometry(w, h, dd), m), x, y, z, p); },
  cyl(rt, rb, h, m, x, y, z, p, seg){ return add(new THREE.Mesh(new THREE.CylinderGeometry(rt, rb, h, seg || 12), m), x, y, z, p); },
  sph(r, m, x, y, z, p){ return add(new THREE.Mesh(new THREE.SphereGeometry(r, 8, 6), m), x, y, z, p); },
  canvasTex(w, h, draw){ if(draw) draw(noop2d, w, h); return {c: null, g: noop2d, t: new THREE.Texture()}; },
  screen(w, h, t, tr){ return new THREE.Mesh(new THREE.PlaneGeometry(w, h), new THREE.MeshBasicMaterial({map: t, transparent: !!tr})); },
  glow(col){ return new THREE.Sprite(new THREE.SpriteMaterial({color: col, transparent: true})); }, label(){ return new THREE.Sprite(new THREE.SpriteMaterial()); },
  short(s, n){ s = String(s || ""); return s.length > n ? s.slice(0, n) : s; }, rr(){}, sky(){ return new THREE.Texture(); }, level(){ return 7; }, crewState(){ return "idle"; },
  rng(seed){ var a = seed >>> 0 || 1; return function(){ a = (a + 0x6D2B79F5) >>> 0; var t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0)/4294967296; }; },
  hashStr: S.hashStr, look(){ return {sign: "Ann", style: STYLE}; }, avatar(){ return {x: 0, z: 6}; }};
HQV.hqPets = {lobby(w, spots){ petCalls.push(spots.map(s => s.kind).sort().join(",")); }};
function lobby(st){ STYLE = st; var w = {scene: new THREE.Scene(), name: "lobby"}; scene = w.scene; HQV.hqWorlds.lobby(c, w); w.setTime(true); w.update(1, 0.05, 1); return w; }
function draws(w){ var n = 0; w.scene.traverse(o => { if((o.isMesh || o.isSprite) && o.visible) n++; }); return n; }
var L0 = lobby(null), base = draws(L0);
out.lobby = {};
var Lsch = S.SCHEMA.int.lobby;
Object.keys(Lsch).forEach(function(k){ out.lobby[k] = Lsch[k].enum.map(function(v){ var st = S.defaults(); st.int.lobby[k] = v; try { var w = lobby(st); return [v, draws(w) > 30]; } catch(e){ return [v, String(e).slice(0, 120)]; } }); });
["wall", "floor", "mood"].forEach(function(k){ out.lobby["theme:" + k] = S.SCHEMA.int.theme[k].enum.map(function(v){ var st = S.defaults(); st.int.themes.lobby[k] = v; try { lobby(st); return [v, true]; } catch(e){ return [v, String(e).slice(0, 120)]; } }); });
// your decor: forty items of one kind cost as many draws as one; their cells are blocked; a rug is not
var many = S.defaults(); for(var j = 0; j < 30; j++) many = S.place(many, {k: "plant", f: "lobby", x: -12 + (j % 10)*2, z: 9 + Math.floor(j/10)*2, r: 0});
var one = S.place(S.defaults(), {k: "plant", f: "lobby", x: -12, z: 9, r: 0});
out.decor = {many: draws(lobby(many)), one: draws(lobby(one))};
var rugd = S.place(S.place(S.defaults(), {k: "rug", f: "lobby", x: 0, z: 10, r: 0}), {k: "piano", f: "lobby", x: 4, z: 11, r: 0}), Lr = lobby(rugd);
out.decor.rugBlocks = Lr.blocked(0, 10); out.decor.pianoBlocks = Lr.blocked(4, 11); out.decor.studioGrid = typeof Lr.studioGrid === "function";
petCalls.length = 0; lobby(pd); out.petCalls = petCalls.slice();
// [3.13] with the real Pets module (games/hqpets.js): one HQV.hqPets.lobby call per build, carrying the furniture's spots;
// a restyle with nothing changed calls it no more; without HQ Studio (no hqStyle) the lobby still calls it once, spotless
new Function(fs.readFileSync(root + "/games/hqpets.js", "utf8"))();
var realLobby = HQV.hqPets.lobby, realCalls = [];
HQV.hqPets.lobby = function(w, spots){ realCalls.push(spots == null ? null : spots.length); return realLobby(w, spots); };
var Lp = lobby(pd); out.realPets = {calls: realCalls.slice(), home: Lp.petHome ? Lp.petHome.spots.map(s => s.kind).sort().join(",") : null};
realCalls.length = 0; Lp.onLook(); out.realPets.again = realCalls.length;
var ST0 = HQV.hqStyle; HQV.hqStyle = undefined; realCalls.length = 0;
try { var Ln = lobby(pd); out.realPets.noStudio = realCalls.slice(); out.realPets.noStudioHome = Ln.petHome ? Ln.petHome.spots.length : null; }
catch(e){ out.realPets.noStudio = String(e).slice(0, 200); }
HQV.hqStyle = ST0;
// Mission Control's theme: a furniture set changes the desks (apply says so), the decor is instanced, blocked
var ms = new THREE.Scene(), fl = new THREE.Mesh(new THREE.PlaneGeometry(30, 30), new THREE.MeshStandardMaterial()), wm = new THREE.MeshStandardMaterial({color: 0x2a3d4f});
var MS = HQV.hqDecor.mission(c, ms, {floor: fl, wallM: wm, lamps: [new THREE.PointLight()], room: 15});
var md = S.defaults(); md.int.themes.mission.furn = "gamer"; md.int.themes.mission.floor = "checker"; md = S.place(md, {k: "arcade", f: "mission", x: 10, z: 10, r: 1});
out.mission = {first: MS.apply(md), again: MS.apply(md), furn: MS.furn().top, floorMap: !!fl.material.map, blocked: MS.blocked(10, 10), free: MS.blocked(0, 0), reset: MS.apply(null)};
// [3.13.2] the Layout tab's ghost: fit() (snap, overlap, walk-over pieces, edges, caps) and the grid's ghost on the floor
var D = HQV.hqDecor, LIM = S.SCHEMA.int.items, lay = [{k: "piano", f: "lobby", x: 0, z: 0, r: 0}, {k: "rug", f: "lobby", x: 6, z: 6, r: 0}];
function F(it){ var r = D.fit(lay, Object.assign({f: "lobby", r: 0}, it), LIM); return [r.ok, !!r.replace]; }
var fullFloor = []; for(var q = 0; q < 32; q++) fullFloor.push({k: "plant", f: "lobby", x: -13 + q % 27, z: -13 + Math.floor(q/27)*2, r: 0});
out.fit = {free: F({k: "plant", x: 5, z: -5}), onPiano: F({k: "plant", x: 1, z: 1}), sameCell: F({k: "palm", x: 0, z: 0}), rugOverPiano: F({k: "rug", x: 1, z: 0}),
  onRug: F({k: "sofa", x: 7, z: 6}), edge: F({k: "bookshelf", x: 13, z: 0}), edgeTurned: F({k: "bookshelf", x: 13, z: 0, r: 1}), otherFloor: D.fit(lay, {k: "plant", f: "mission", x: 1, z: 1, r: 0}, LIM).ok,
  full: D.fit(fullFloor, {k: "plant", f: "lobby", x: 5, z: 5, r: 0}, LIM).ok, fullReplace: D.fit(fullFloor, {k: "palm", f: "lobby", x: -13, z: -13, r: 0}, LIM).ok,
  cells: D.cellsOf({k: "piano", x: 3, z: 3, r: 1}).length, noKind: D.fit(lay, {k: "cannon", f: "lobby", x: 0, z: 0, r: 0}, LIM).ok};
var gs = new THREE.Scene(), G = D.grid(c, gs, 13);
G.set(3, 4, {k: "piano", r: 0, ok: false}); var g1 = G.ghost();
G.set(5, 4, {k: "piano", r: 0, ok: true}); var g2 = G.ghost(), gp = gs.getObjectByName("hq-studio-ghost");
G.set(5, 4, {k: "plant", r: 1, ok: true});
out.ghost = {first: g1, moved: g2, at: [gp.position.x, gp.position.z], kids: gp.children.length, swapped: G.ghost().k, off: (G.set(1, 1, {}), G.ghost())};
// [3.13.2] the Exterior tab's live tower: the City's own make(), rebuilt (debounced) on change, the old one disposed
var fakeR = {disposed: 0, renders: 0, setPixelRatio(){}, setSize(){}, setClearColor(){}, render(){ this.renders++; }, dispose(){ this.disposed++; }, forceContextLoss(){}};
var LOOK = {sign: "Ann", style: S.preset("deco")};
var P = HQV.hqTower.preview(c, {clientWidth: 360, clientHeight: 250}, {renderer: function(){ return fakeR; }, look: function(){ return LOOK; }, level: function(){ return 12; }, calm: function(){ return false; }});
var i0 = P.info(), sharedMap = null, sharedGone = 0;
P.scene.traverse(function(o){ if(!sharedMap && o.material && o.material.map && o.material.map.userData && o.material.map.userData.shared) sharedMap = o.material.map; });
if(sharedMap) sharedMap.addEventListener("dispose", function(){ sharedGone++; });
LOOK = {sign: "Ann", style: S.preset("tokyo")}; P.set(true); var i1 = P.info();
P.set(); P.set(); var pend = P.info().pending, mid = P.info().builds;
await new Promise(r => setTimeout(r, 200)); var i2 = P.info();
P.focus("roof"); var roof = P.info().part; P.focus("street"); var street = P.info().part; P.night(true);
P.tick(1); P.tick(1.1);
P.dispose();
out.preview = {first: i0.builds, rebuilt: i1.builds, freed: i1.freed > 0, debounced: [pend, mid, i2.builds], roof, street, night: P.info().night, sharedKept: !!sharedMap && sharedGone === 0,
  renders: fakeR.renders > 0, disposed: fakeR.disposed, after: P.info().children};
console.log(JSON.stringify(out));
"""


@unittest.skipUnless(NODE, "node is not installed")
class HqStyle(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        r = subprocess.run([NODE, "--input-type=module", "-e", HARNESS.replace("%(root)s", json.dumps(ROOT))], capture_output=True, text=True, timeout=300)
        if r.returncode != 0:
            raise AssertionError("node failed:\n" + r.stderr[-4000:])
        cls.out = json.loads(r.stdout)

    def test_schema_copies_match(self):
        js = self.out["schema"]
        self.assertEqual(js, json.loads(read("games", "hqstyle", "schema.json")))
        self.assertEqual(js, json.loads(read("backend", "data", "hqstyle.json")))

    def test_defaults_presets_random(self):
        self.assertTrue(self.out["defaultsOk"])
        self.assertEqual(len(self.out["presets"]), 6)
        for name, ok, pre, fac in self.out["presets"]:
            self.assertTrue(ok, name); self.assertEqual(pre, name); self.assertEqual(fac, name)
        for name, ok, pre in self.out["lobbyPresets"]:
            self.assertTrue(ok, name); self.assertEqual(pre, name)
        self.assertEqual(self.out["random"], [True, True, True])

    def test_check_refuses_what_the_arena_refuses(self):
        for k, v in self.out["rejects"].items():
            with self.subTest(case=k):
                self.assertFalse(v)
        a = self.out["accepts"]
        self.assertTrue(a["sameCellOtherFloor"]); self.assertTrue(a["partial"]); self.assertEqual(a["upper"], "#abcdef")
        self.assertEqual(self.out["clean"], [True, True, 1])

    def test_layout_limits(self):
        p = self.out["place"]
        self.assertEqual(p["n"], 32)
        self.assertTrue(p["over"])
        self.assertEqual(p["replace"], 32)
        self.assertEqual(p["other"], 33)
        self.assertEqual(p["removed"], 31)
        self.assertIsNone(p["bad"])

    def test_pet_spots(self):
        self.assertEqual(sorted(self.out["pets"]), sorted([["bed", 2, 2], ["tree", 3, 2], ["perch", 4, 2], ["perch", 5, 5], ["pen", -5, 5], ["bowl", 6, 2], ["water", -6, -2], ["water", -1.5, 3.4]]))
        self.assertEqual(self.out["petsNoWater"], 1)
        self.assertEqual(self.out["petCalls"], ["bed,bowl,pen,perch,perch,tree,water"])   # the pond (the statue holds no water)

    def test_lobby_spawns_pets_exactly_once_with_its_spots(self):
        """[3.13] pets + the revamp: one HQV.hqPets.lobby call per lobby build (no second, spotless call from the pets
        branch's old hook), the furniture's spots reach the Pets module, and a lobby without HQ Studio still has pets."""
        rp = self.out["realPets"]
        self.assertEqual(rp["calls"], [7])
        self.assertEqual(rp["home"], "bed,bowl,pen,perch,perch,tree,water")
        self.assertEqual(rp["again"], 0)
        self.assertEqual(rp["noStudio"], [None])
        self.assertEqual(rp["noStudioHome"], 0)
        src = read("games", "hqlobby.js")
        self.assertNotIn("w.petSpots", src)
        self.assertEqual(src.count("HQV.hqPets.lobby(w,"), 2)   # petsHook, and the no-Studio fallback in the else branch

    def test_lobby_builds_every_option(self):
        for k, rows in self.out["lobby"].items():
            for v, ok in rows:
                with self.subTest(option=k, value=v):
                    self.assertIs(ok, True)

    def test_decor_is_instanced(self):
        d = self.out["decor"]
        self.assertEqual(d["many"], d["one"], "thirty plants cost what one does")
        self.assertFalse(d["rugBlocks"]); self.assertTrue(d["pianoBlocks"]); self.assertTrue(d["studioGrid"])

    def test_layout_ghost_fit_and_snap(self):
        f = self.out["fit"]
        self.assertEqual(f["free"], [True, False])
        self.assertEqual(f["onPiano"], [False, False], "a plant on the piano's 2x2 is red")
        self.assertEqual(f["sameCell"], [True, True], "the same cell replaces (as HQV.hqStyle.place does)")
        self.assertEqual(f["rugOverPiano"], [True, False], "rugs are walked over: they overlap anything")
        self.assertEqual(f["onRug"], [True, False])
        self.assertEqual(f["edge"], [False, False], "a bookshelf at x=13 runs off the floor")
        self.assertEqual(f["edgeTurned"], [True, False], "turned, it fits")
        self.assertTrue(f["otherFloor"]); self.assertFalse(f["full"]); self.assertTrue(f["fullReplace"])
        self.assertEqual(f["cells"], 4); self.assertFalse(f["noKind"])
        g = self.out["ghost"]
        self.assertEqual(g["first"]["k"], "piano:0"); self.assertFalse(g["first"]["ok"])
        self.assertTrue(g["moved"]["ok"]); self.assertEqual(g["at"], [5, 4])
        self.assertEqual(g["kids"], 1, "the old ghost is disposed, not stacked")
        self.assertEqual(g["swapped"], "plant:1"); self.assertIsNone(g["off"])

    def test_exterior_preview_builds_and_disposes(self):
        p = self.out["preview"]
        self.assertEqual(p["first"], 1); self.assertEqual(p["rebuilt"], 2); self.assertTrue(p["freed"])
        self.assertEqual(p["debounced"], [True, 2, 3], "two quick changes: one rebuild, after the pause")
        self.assertEqual(p["roof"], "roof"); self.assertEqual(p["street"], "street"); self.assertTrue(p["night"])
        self.assertTrue(p["sharedKept"], "the shared facade tiles survive a rebuild")
        self.assertTrue(p["renders"]); self.assertEqual(p["disposed"], 1); self.assertEqual(p["after"], 0)
        tw = read("games", "hqtower.js")
        self.assertIn("preview: preview", tw)
        hq = read("games", "hq3d.js")
        self.assertIn("HQV.hqTower.preview(ctx, cv", hq)
        self.assertIn("inst.studioView = function", hq)

    def test_mission_theme(self):
        m = self.out["mission"]
        self.assertTrue(m["first"]); self.assertFalse(m["again"]); self.assertEqual(m["furn"], 0x15151c)
        self.assertTrue(m["floorMap"]); self.assertTrue(m["blocked"]); self.assertFalse(m["free"]); self.assertTrue(m["reset"])

    def test_ui_wiring(self):
        idx = read("index.html")
        self.assertIn("//@include ui/app/40-studio.js", idx)
        self.assertIn('id="setStudio"', idx)
        self.assertIn('id="hqStudioBtn"', idx)
        st = read("ui", "app", "40-studio.js")
        for want in ('"/api/arena/hq/style"', 'hqNetCan("hqstyle")', "hqStudioCity", 'role","dialog"', 'aria-modal","true"', '"tablist"', '"radiogroup"', "hqStyleDoc", "Escape"):
            self.assertIn(want, st)
        self.assertNotIn("innerHTML", st, "the Studio builds its DOM with textContent")
        self.assertNotRegex(st, r"Math\.random\(")
        hq = read("ui", "app", "22-hq.js")
        self.assertIn("style: typeof hqStyleDoc===\"function\" ? hqStyleDoc() : null", hq)
        self.assertIn("hqStudioCity(HQ_CITY.list)", hq)
        self.assertIn("style: p.style||null", hq)                                  # a visit wears their style
        self.assertIn("hqStudioOpen", read("ui", "app", "14-overlays.js"))           # Cmd-K
        css = read("ui", "hq.css")
        studio = css[css.index("/* HQ Studio"):]
        self.assertNotRegex(studio, r"#[0-9a-fA-F]{3,6}\b", "theme tokens only")
        self.assertIn("html.hq-calm .hqs-chip", studio)
        self.assertIn("prefers-reduced-motion", studio)
        server = read("dashboard-rs", "src", "server.rs")
        self.assertIn('"/api/arena/hq/style"', server)
        self.assertIn('"hqstyle"', read("backend", "src", "protocol.rs"))
        self.assertTrue(os.path.exists(os.path.join(ROOT, "backend", "migrations", "0021_hq_custom.sql")))




# [3.13.2] the panel itself, on a tiny fake DOM: every click previews live in the 3D scene behind it, closing without Save
# puts the saved look (and your view) back, Save keeps it; the tabs are one row; the Layout tab drives the 3D ghost
UI_HARNESS = r"""
import fs from "fs";
const root = %(root)s;
const reg = {};
class El {
  constructor(tag){ this.tagName = tag.toUpperCase(); this.children = []; this.parentNode = null; this.attrs = {}; this.ls = {}; this._t = ""; this.dataset = {}; this.style = {}; this.scrollTop = 0; this.tabIndex = -1;
    const me = this; this.classList = {s: new Set(), add(...c){ c.forEach(x => this.s.add(x)); }, remove(...c){ c.forEach(x => this.s.delete(x)); }, contains(c){ return this.s.has(c); }, toggle(c, on){ if(on === undefined) on = !this.s.has(c); on ? this.s.add(c) : this.s.delete(c); return on; }}; }
  set id(v){ this._id = v; reg[v] = this; } get id(){ return this._id; }
  set className(v){ this.classList.s = new Set(String(v).split(/\s+/).filter(Boolean)); } get className(){ return [...this.classList.s].join(" "); }
  set textContent(v){ this.children.forEach(c => c.parentNode = null); this.children = []; this._t = String(v); } get textContent(){ return this._t + this.children.map(c => c.textContent).join(""); }
  appendChild(c){ if(c.parentNode) c.parentNode.removeChild(c); c.parentNode = this; this.children.push(c); return c; }
  removeChild(c){ this.children = this.children.filter(x => x !== c); c.parentNode = null; return c; }
  replaceChild(n, o){ const i = this.children.indexOf(o); if(n.parentNode) n.parentNode.removeChild(n); this.children[i] = n; n.parentNode = this; o.parentNode = null; return o; }
  setAttribute(k, v){ this.attrs[k] = String(v); } getAttribute(k){ return this.attrs[k] == null ? null : this.attrs[k]; }
  addEventListener(t, f){ (this.ls[t] = this.ls[t] || []).push(f); }
  fire(t, e){ (this.ls[t] || []).forEach(f => f(Object.assign({preventDefault(){}, stopPropagation(){}, target: this}, e || {}))); }
  click(){ this.fire("click"); } focus(){ document.activeElement = this; }
  querySelector(){ return null; } getBoundingClientRect(){ return {left: 0, top: 0, right: 0, width: 0, height: 0}; } getContext(){ return null; }
  all(){ return [this].concat(...this.children.map(c => c.all())); }
}
globalThis.window = globalThis; window.HQV = {};
globalThis.document = {createElement: t => new El(t), body: new El("body"), activeElement: null, documentElement: new El("html"), hidden: false, querySelector(){ return null; }};
globalThis.$ = id => (reg[id] && reg[id].parentNode !== null || id === "hqStudio") ? reg[id] || null : null;
globalThis.getComputedStyle = () => ({getPropertyValue(){ return ""; }});
globalThis.location = {search: ""};
const LS = {}; globalThis.localStorage = {getItem: k => LS[k] == null ? null : LS[k], setItem(k, v){ LS[k] = String(v); }, removeItem(k){ delete LS[k]; }};
globalThis.requestAnimationFrame = () => 1; globalThis.cancelAnimationFrame = () => {};
globalThis.toast = () => {}; globalThis.announce = () => {};
for (const f of ["hqstyle", "hqdecor"]) new Function(fs.readFileSync(root + "/games/" + f + ".js", "utf8"))();
const looks = [], views = [], grids = [];
globalThis.HQ3D = {visit: false, inst: {lookChanged(){ looks.push(JSON.stringify(hqStyleDoc() && hqStyleDoc().int.themes.mission)); }, cityChanged(){},
  studioGrid(o){ grids.push(o); }, studioView(o){ views.push(o); }, studioState(){ return null; }}};
(0, eval)(fs.readFileSync(root + "/ui/app/40-studio.js", "utf8"));
const out = {};
function chip(group, text){ return reg.hqsBody.all().find(e => e.attrs.role === "radio" && e.parentNode && e.parentNode.attrs["aria-label"] === group && e.textContent === text); }
// Floors: live, then close without saving
hqStudioOpen("floors");
out.view0 = views[views.length - 1];
const panel = reg.hqStudio.children[0];
out.layout = panel.children.map(c => c.className);
out.tabRow = reg["hqsTab-ext"].parentNode.className;
const n0 = looks.length;
chip("Walls", "Brick").click();
out.live = {wall: hqStyleDoc().int.themes.mission.wall, applied: looks.length > n0, last: JSON.parse(looks[looks.length - 1]).wall};
chip("Lighting", "Neon").click();
hqStudioClose(false);
out.revert = {draft: HQ_STUDIO.draft, wall: (hqStyleDoc() || S0()).int.themes.mission.wall, mood: (hqStyleDoc() || S0()).int.themes.mission.mood, applied: JSON.parse(looks[looks.length - 1] || "null"), view: views[views.length - 1], saved: LS.hq_style || null};
function S0(){ return HQV.hqStyle.defaults(); }
// Save keeps it
hqStudioOpen("floors"); chip("Walls", "Brick").click(); hqStudioSave(); hqStudioClose(false);
out.saved = {wall: hqStyleDoc().int.themes.mission.wall, local: JSON.parse(LS.hq_style).int.themes.mission.wall};
// Layout: the main view places from above; the 3D pointer moves the ghost and places
hqStudioOpen("layout");
const v = views[views.length - 1];
out.place = {f: v.f, place: v.place, cb: typeof v.cb.hover};
v.cb.hover(4, -3); out.ghost = grids[grids.length - 1];
v.cb.place(4, -3); out.placed = HQ_STUDIO.draft.int.items.filter(i => i.x === 4 && i.z === -3).length;
v.cb.key("rotate"); out.rot = HQ_STUDIO.rot;
v.cb.hover(4, -3); out.ghostRed = grids[grids.length - 1];
v.cb.remove(4, -3); out.removed = HQ_STUDIO.draft.int.items.filter(i => i.x === 4 && i.z === -3).length;
hqStudioClose(false); out.gridOff = grids[grids.length - 1];
console.log(JSON.stringify(out));
"""


@unittest.skipUnless(NODE, "node is not installed")
class HqStudioPanel(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        r = subprocess.run([NODE, "--input-type=module", "-e", UI_HARNESS.replace("%(root)s", json.dumps(ROOT))], capture_output=True, text=True, timeout=120)
        if r.returncode != 0:
            raise AssertionError("node failed:\n" + r.stderr[-4000:])
        cls.out = json.loads(r.stdout)

    def test_live_apply_and_revert_without_save(self):
        o = self.out
        self.assertEqual(o["view0"]["f"], "mission", "the Floors tab frames Mission Control")
        self.assertEqual(o["live"], {"wall": "brick", "applied": True, "last": "brick"})
        r = o["revert"]
        self.assertIsNone(r["draft"]); self.assertEqual(r["wall"], "slate"); self.assertEqual(r["mood"], "warm")
        self.assertIsNone(r["view"], "your own view back"); self.assertIsNone(r["saved"])
        self.assertEqual(o["saved"], {"wall": "brick", "local": "brick"})

    def test_single_row_of_tabs(self):
        self.assertEqual(self.out["layout"], ["modal-h", "hqs-tabs", "modal-b hqs-body", "hqs-foot"])
        css = read("ui", "hq.css")
        self.assertIn(".hqs-tabs{display:flex;gap:4px;flex-wrap:nowrap", css)
        self.assertIn("width:min(392px,100%)", css)
        self.assertIn(".hqs-pv{position:sticky", css)

    def test_layout_drives_the_3d_ghost(self):
        o = self.out
        self.assertEqual(o["place"], {"f": "lobby", "place": True, "cb": "function"})
        self.assertEqual({k: o["ghost"][k] for k in ("f", "x", "z", "k", "ok")}, {"f": "lobby", "x": 4, "z": -3, "k": "plant", "ok": True})
        self.assertEqual(o["placed"], 1); self.assertEqual(o["rot"], 1)
        self.assertTrue(o["ghostRed"]["ok"], "the same cell replaces: still green")
        self.assertEqual(o["removed"], 0); self.assertIsNone(o["gridOff"])


if __name__ == "__main__":
    unittest.main()
