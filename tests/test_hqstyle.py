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


if __name__ == "__main__":
    unittest.main()
