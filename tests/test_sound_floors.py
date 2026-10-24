"""Sound PR B on the 3D HQ's other floors: your Base's campus (games/hqbase.js, its tower games/hqtower.js) and the
classic Arena City (games/hqcity.js) are heard where they are, as the 3D City is.

Node imports the vendored three.js, loads games/engine.js against a fake Web Audio context (with a StereoPanner) and
the floors in page order, and builds each with a stub hq3d ctx: the Base at level 40 (the plaza fountain from 5, the
helicopter on the west wing from 20, the kart track from 35) and at level 1, and Arena City with three HQs (as built,
and again with its towers broad, grand 1: since 3.19 a helicopter stands only on a wing, which the grid's tight lots
lack). The engine's makers are spied on (the real ones still run). Python checks: the karts are engines ("single") at
their places in the vehicle kind's pool with the cars going round the ring road, the fountain an E.loop "fountain" at
its water, the rooftop helicopter a rotor in the heli kind's pool (on Arena City's broad lots, from each lot's frame to
the street's; none heard where none is drawn); nothing without ears; onLeave, soundPause and destroy let every voice
go, and the next frame makes them again.
Skipped without node. Stdlib only."""
import json
import os
import shutil
import subprocess
import unittest

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
NODE = shutil.which("node")

HARNESS = r"""
import fs from "fs";
const root = %(root)s;
const THREE = await import(root + "/games/vendor/three-module.js");
// ---- a fake Web Audio context: nodes remember their stops, params what was scheduled on them
let now = 0, pnow = 0;
function param(v){ const p = {value: v, ev: [], setTargetAtTime(x, t){ p.ev.push([x, t]); }, setValueAtTime(x, t){ p.ev.push([x, t]); },
  exponentialRampToValueAtTime(x, t){ p.ev.push([x, t]); }, linearRampToValueAtTime(x, t){ p.ev.push([x, t]); },
  cancelScheduledValues(t){ p.ev = p.ev.filter(e => e[1] < t); }}; return p; }
function node(k){ const n = {k: k, outs: [], stops: [], connect(d){ n.outs.push(d); return d; }, disconnect(){}, start(){}, stop(t){ n.stops.push(t); }, setPeriodicWave(){},
  frequency: param(0), detune: param(0), Q: param(0), type: "", playbackRate: param(1), gain: param(1), pan: param(0)}; return n; }
class AC { constructor(){ this.state = "running"; this.sampleRate = 8000; this.destination = node("dest"); }
  get currentTime(){ return now; } resume(){ return Promise.resolve(); }
  createGain(){ return node("gain"); } createOscillator(){ return node("osc"); } createBiquadFilter(){ return node("filter"); }
  createBufferSource(){ return node("src"); } createWaveShaper(){ return node("shaper"); } createPeriodicWave(){ return {}; }
  createStereoPanner(){ return node("pan"); }
  createDynamicsCompressor(){ const n = node("comp"); ["threshold", "knee", "ratio", "attack", "release"].forEach(k => n[k] = param(0)); return n; }
  createBuffer(ch, n){ const d = new Float32Array(n); return {length: n, getChannelData: () => d}; } }
const store = {hq_sfx: "0.5"};
globalThis.localStorage = {getItem: k => k in store ? store[k] : null, setItem(k, v){ store[k] = String(v); }};
globalThis.performance = {now: () => pnow*1000};
globalThis.window = {HQV: {}, AudioContext: AC, matchMedia: () => ({matches: false})};
globalThis.document = {documentElement: {classList: {contains: () => false}}};
for (const f of ["engine", "hqstyle", "hqtower", "hqroof", "hqdecor", "hqbase", "hqskate", "world", "hqcityparts", "hqcity", "traffic"])
  new Function(fs.readFileSync(root + "/games/" + f + ".js", "utf8"))();
const HQV = window.HQV, E = HQV.engine, S = E.spatial, out = {};
E.audioOut();
// ---- spies: what the floors ask of the engine
const made = [];
const wrap = (rec, h) => ({set(){ rec.sets.push([].slice.call(arguments)); if(h && h.set) h.set.apply(h, arguments); },
                           stop(){ rec.stops++; if(h && h.stop) h.stop(); }, alive(){ return !!(h && h.alive && h.alive()); }});
const realEng = E.engineSound, realLoop = E.loop;
E.engineSound = function(kind){ const rec = {what: "engine", kind, sets: [], stops: 0}; made.push(rec); return wrap(rec, realEng.apply(E, arguments)); };
E.loop = function(name){ const rec = {what: "loop", kind: name, sets: [], stops: 0}; made.push(rec); return wrap(rec, realLoop.apply(E, arguments)); };
const r3 = v => Math.round(v*1000)/1000, pt = p => p ? [r3(p.x), r3(p.y), r3(p.z)] : null;
const last = rec => rec.sets[rec.sets.length - 1];
function summary(from){
  return made.slice(from).map(r => {
    const s = last(r), o = s ? (r.what === "engine" ? s[1] : s[1]) : null;
    return {what: r.what, kind: r.kind, sk: o && o.sk || null, id: o && o.pos && o.pos.id || null, pos: o && o.pos ? pt(o.pos) : null, sets: r.sets.length, stops: r.stops,
            rpm: r.what === "engine" && s ? s[0] : null};
  });
}
/* ---------- a stub hq3d ctx: real THREE objects, no DOM ---------- */
function hashStr(s){ var h = 2166136261 >>> 0; s = String(s); for(var i = 0; i < s.length; i++){ h ^= s.charCodeAt(i); h = Math.imul(h, 16777619) >>> 0; } return h >>> 0; }
function rng(seed){ var a = seed >>> 0 || 1; return function(){ a = (a + 0x6D2B79F5) >>> 0; var t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0)/4294967296; }; }
function mat(c, o){ return new THREE.MeshStandardMaterial(Object.assign({color: c, roughness: 0.7, metalness: 0.08}, o || {})); }
function emis(c, e, ei, o){ var m = mat(c, o); m.emissive = new THREE.Color(e); m.emissiveIntensity = ei; return m; }
function add(o, x, y, z, p){ o.position.set(x, y, z); if(p) p.add(o); return o; }
var noop2d = new Proxy({}, {get(t, k){ return k === "measureText" ? function(){ return {width: 10}; } : (k === "createLinearGradient" || k === "createRadialGradient") ? function(){ return {addColorStop(){}}; } : function(){}; }, set(){ return true; }});
function tagged(name){ var g = new THREE.Group(); g.name = name; return g; }
var LEVEL = 40, LIST = [], scene = null;
var c = {THREE: THREE, PI: Math.PI, COL: {amber: 0xffb347, cyan: 0x5fd3e6, green: 0x6fd38a, coral: 0xff6b5b}, HEX: {green: "#6fd38a", amber: "#ffb347", cyan: "#5fd3e6", coral: "#ff6b5b", ink: "#e9eff3"},
  STATE_HEX: {}, E: {calm(){ return false; }}, rng: rng, hashStr: hashStr, mat: mat, emis: emis,
  add(o, x, y, z, p){ return add(o, x, y, z, p || scene); },
  box(w, h, d, m, x, y, z, p){ return add(new THREE.Mesh(new THREE.BoxGeometry(w, h, d), m), x, y, z, p || scene); },
  cyl(rt, rb, h, m, x, y, z, p, seg){ return add(new THREE.Mesh(new THREE.CylinderGeometry(rt, rb, h, seg || 12), m), x, y, z, p || scene); },
  sph(r, m, x, y, z, p){ return add(new THREE.Mesh(new THREE.SphereGeometry(r, 8, 6), m), x, y, z, p || scene); },
  canvasTex(w, h, draw){ if(draw) draw(noop2d, w, h); return {c: null, g: noop2d, t: new THREE.Texture()}; },
  screen(w, h, t){ return new THREE.Mesh(new THREE.PlaneGeometry(w, h), new THREE.MeshBasicMaterial({map: t})); },
  glow(col, s, o){ return new THREE.Sprite(new THREE.SpriteMaterial({color: col, opacity: o, transparent: true})); },
  label(t){ return tagged("label:" + t); }, glyph(){ return new THREE.Sprite(new THREE.SpriteMaterial()); },
  short(s, n){ s = String(s || ""); return s.length > n ? s.slice(0, n) : s; }, crewState(){ return "idle"; },
  character(){}, anim(){}, level(){ return LEVEL; }, look(){ return {}; }, sessions(){ return []; },
  car(a){ var g = tagged("car"); g.add(new THREE.Mesh(new THREE.BoxGeometry(1.7, 1, 3.6), mat(a))); return {g: g}; },
  moto(a){ return {g: tagged("moto")}; }, bike(a){ return {g: tagged("bike")}; }, board(){ return {g: tagged("board")}; },
  avatar(){ return {x: 0, z: 0}; }, view(){ return {yaw: 0.6, pitch: 0.7}; },
  api: {city(){ return LIST; }, cityReturn(){ return null; }, viewTitle(){ return null; }}};
let T = 0;
function frames(w, n){ for(let i = 0; i < n; i++){ now += 1/60; pnow += 1/60; T += 1/60; w.update(T, 1/60, 1); } }
// the rooftop helicopters as drawn: each tower's helicopter body (a 0.8 m sphere, 12 x 8, stretched 1.5 x) -> its group
function drawnHelis(S0){
  S0.updateMatrixWorld(true); const v = new THREE.Vector3(), o = [];
  S0.traverse(m => { const g = m.geometry && m.geometry.parameters; if(m.isMesh && g && m.geometry.type === "SphereGeometry" && g.radius === 0.8 && g.widthSegments === 12 && g.heightSegments === 8 && m.scale.x === 1.5){ m.parent.getWorldPosition(v); o.push([r3(v.x), r3(v.y + 1.9), r3(v.z)]); } });
  return o;
}

/* ---------- the Base at level 40: the karts, the cars on the ring road, the fountain, the helicopter ---------- */
{
  const w = {scene: new THREE.Scene(), name: "base"}; scene = w.scene;
  HQV.hqWorlds.base(c, w); w.setTime(true);
  const k0 = made.length;
  E.listener({x: -31, y: 1.6, z: 0, yaw: 0});                    // at the kart track
  frames(w, 20);
  out.base = {made: summary(k0), pools: S.state().pools, helis: drawnHelis(w.scene), hooks: [typeof w.onLeave, typeof w.soundPause, typeof w.destroy]};
  // nothing without ears
  const k1 = made.length; E.listener(null); frames(w, 5); out.base.noEars = made.length - k1;
  // leave: every voice goes; come back: made again
  E.listener({x: -31, y: 1.6, z: 0, yaw: 0}); frames(w, 2);
  w.onLeave(); out.base.left = {pools: S.state().pools, unstopped: made.slice(k0).filter(r => !r.stops).map(r => r.kind)};
  const k2 = made.length; frames(w, 3); out.base.again = made.length - k2;
  w.soundPause(); out.base.paused = made.slice(k0).filter(r => !r.stops).length;
  frames(w, 3); w.destroy(); out.base.destroyed = made.slice(k0).filter(r => !r.stops).length;
  // by the fountain, facing +z (its right is -x): the fountain's water just ahead
  const k3 = made.length; E.listener({x: 0, y: 1.6, z: 4, yaw: 0}); frames(w, 3);
  out.base.fountain = summary(k3).filter(r => r.kind === "fountain");
  w.onLeave();
}
/* ---------- the Base at level 1: no fountain, karts or helicopter yet, only the ring road ---------- */
{
  LEVEL = 1;
  const w = {scene: new THREE.Scene(), name: "base"}; scene = w.scene;
  HQV.hqWorlds.base(c, w); w.setTime(true);
  const k0 = made.length; E.listener({x: 18, y: 1.6, z: 0, yaw: 0}); frames(w, 10);
  out.base1 = {made: summary(k0).map(r => [r.what, r.kind, r.sk, r.id]), pools: S.state().pools};
  w.onLeave();
  LEVEL = 40;
}
/* ---------- Arena City (the classic street): the plaza fountain, the cars round the edge, each lot's helicopter ---------- */
{
  LIST = Array.from({length: 3}, (_, i) => ({userId: "c" + i, level: 25 + i, isYou: i === 1, look: {paint: "#224466", accent: "#ff8800"}, crew: {working: 1, needs: i}, cos: {}}));
  const w = {scene: new THREE.Scene(), name: "city"}; scene = w.scene;
  HQV.hqWorlds.city(c, w); w.setTime(true);
  const L = HQV.hqCityLayout(LIST), P = L.plaza;
  const k0 = made.length;
  E.listener({x: P.x, y: 1.6, z: P.z + 7, yaw: Math.PI});        // at the plaza
  frames(w, 20);
  out.city = {made: summary(k0), pools: S.state().pools, plaza: [P.x, P.z], helis: drawnHelis(w.scene), lots: L.lots.map(l => [l.x, l.z, l.rot])};
  w.onLeave(); out.city.left = {pools: S.state().pools, unstopped: made.slice(k0).filter(r => !r.stops).map(r => r.kind)};
}
/* ---------- Arena City with broad towers: since 3.19 a helicopter stands only on a wing, and the grid's tight lots
   (grand 0) have none, so its towers are built at grand 1 here to hear each lot's helicopter where it is drawn ---------- */
{
  const realB = HQV.hqBuilding;
  HQV.hqBuilding = function(c0, o){ return realB(c0, Object.assign({}, o, {grand: 1})); };
  const w = {scene: new THREE.Scene(), name: "city"}; scene = w.scene;
  HQV.hqWorlds.city(c, w); w.setTime(true);
  const L = HQV.hqCityLayout(LIST), P = L.plaza;
  const k0 = made.length;
  E.listener({x: P.x, y: 1.6, z: P.z + 7, yaw: Math.PI});        // at the plaza
  frames(w, 20);
  out.cityBroad = {made: summary(k0), pools: S.state().pools, helis: drawnHelis(w.scene)};
  w.onLeave(); out.cityBroad.left = {pools: S.state().pools, unstopped: made.slice(k0).filter(r => !r.stops).map(r => r.kind)};
  HQV.hqBuilding = realB;
}
console.log(JSON.stringify(out));
"""


@unittest.skipUnless(NODE, "node is not installed")
class FloorSounds(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        src = HARNESS.replace("%(root)s", json.dumps(ROOT))
        r = subprocess.run([NODE, "--input-type=module", "-e", src], capture_output=True, text=True, timeout=300)
        if r.returncode != 0:
            raise AssertionError("node failed:\n" + r.stderr[-4000:])
        cls.o = json.loads(r.stdout.strip().splitlines()[-1])

    def test_the_karts_and_the_ring_road_cars_are_engines_where_they_are(self):
        b = self.o["base"]
        karts = [m for m in b["made"] if m["what"] == "engine" and (m["id"] or "").startswith("kart:")]
        self.assertEqual(sorted(m["id"] for m in karts), ["kart:0", "kart:1", "kart:2"], "the three karts, at the track")
        self.assertTrue(all(m["kind"] == "single" and m["sk"] == "vehicle" for m in karts))
        for m in karts:
            x, y, z = m["pos"]
            self.assertLess(abs(x + 31), 4.5)                   # on the track round (-31, 0): 4.4 by 8 m
            self.assertLess(abs(z), 8.1)
            self.assertGreater(m["sets"], 10)                   # every frame
        ids = b["pools"]["vehicle"]
        self.assertEqual(len(ids), 6, "the vehicle kind's six voices")
        self.assertTrue(set(ids) >= {"kart:0", "kart:1", "kart:2"})
        self.assertTrue(all(i.startswith("kart:") or i.startswith("ring:") for i in ids), ids)

    def test_the_rooftop_helicopter_is_a_rotor_where_it_is_drawn(self):
        b = self.o["base"]
        self.assertEqual(b["pools"]["heli"], ["heli"])
        rot = [m for m in b["made"] if m["kind"] == "rotor"]
        self.assertEqual(len(rot), 1)
        self.assertEqual(rot[0]["sk"], "heli")
        self.assertEqual(len(b["helis"]), 1)
        for got, want in zip(rot[0]["pos"], b["helis"][0]):
            self.assertAlmostEqual(got, want, delta=0.2)        # its rotor, as it hops
        self.assertTrue(2800 <= rot[0]["rpm"] <= 5600)

    def test_the_plaza_fountain(self):
        f = self.o["base"]["fountain"]
        self.assertEqual(len(f), 1)
        self.assertEqual(f[0]["what"], "loop")
        self.assertEqual(f[0]["pos"], [0, 1.6, 10.4])          # its falling water
        self.assertGreater(f[0]["sets"], 2)

    def test_no_ears_nothing_made(self):
        self.assertEqual(self.o["base"]["noEars"], 0)

    def test_leaving_lets_every_voice_go(self):
        b = self.o["base"]
        self.assertEqual(b["hooks"], ["function", "function", "function"])
        self.assertEqual(b["left"]["unstopped"], [], "onLeave: every engine and loop stopped")
        self.assertNotIn("vehicle", b["left"]["pools"])
        self.assertNotIn("heli", b["left"]["pools"])
        self.assertGreater(b["again"], 0, "the next frame makes them again")
        self.assertEqual(b["paused"], 0, "soundPause too")
        self.assertEqual(b["destroyed"], 0, "and destroy")

    def test_a_young_base_has_only_its_ring_road(self):
        b = self.o["base1"]
        self.assertTrue(b["made"])
        for what, kind, sk, i in b["made"]:
            self.assertEqual((what, sk), ("engine", "vehicle"))
            self.assertTrue(i.startswith("ring:"), i)
        self.assertEqual(b["pools"].get("heli", []), [], "no helicopter before level 20")

    def test_arena_city_street(self):
        c = self.o["city"]
        f = [m for m in c["made"] if m["kind"] == "fountain"]
        self.assertEqual(len(f), 1)
        px, pz = c["plaza"]
        self.assertEqual(f[0]["pos"], [px, 1.6, pz])            # hqcityparts' fountain: its water
        cars = c["pools"]["vehicle"]
        self.assertTrue(cars and all(i.startswith("edge:") for i in cars), cars)
        # 3.19's massing: the grid's tight lots (grand 0) have no wing, so no helicopter stands there, and none is heard
        self.assertEqual(c["helis"], [])
        self.assertEqual([m for m in c["made"] if m["kind"] == "rotor"], [])
        self.assertEqual(c["pools"].get("heli", []), [])
        self.assertEqual(c["left"]["unstopped"], [])

    def test_arena_city_helicopters_where_they_are_drawn(self):
        c = self.o["cityBroad"]                                 # the same street, its towers built broad (grand 1)
        rot = [m for m in c["made"] if m["kind"] == "rotor"]
        self.assertEqual(len(c["helis"]), 3, "three lots, a helicopter on each tower")
        self.assertEqual(len(rot), 2, "the heli kind's two voices: the nearest two")
        self.assertEqual(sorted(c["pools"]["heli"]), sorted(m["id"] for m in rot))
        for m in rot:                                           # each from its lot's frame to the street's: where it is drawn
            self.assertTrue(any(all(abs(a - b) < 0.2 for a, b in zip(m["pos"], h)) for h in c["helis"]), (m["pos"], c["helis"]))
        self.assertEqual(c["left"]["unstopped"], [])


class Source(unittest.TestCase):
    def read(self, name):
        with open(os.path.join(ROOT, "games", name), encoding="utf-8") as f:
            return f.read()

    def test_house_rules(self):
        for name in ("hqbase.js", "hqcity.js", "hqtower.js"):
            self.assertNotIn("Math.random(", self.read(name), name)
        base = self.read("hqbase.js")
        self.assertIn('if(!E || typeof E.pool !== "function" || typeof E.engineSound !== "function") return null;', base)   # an older engine: silent
        self.assertIn("HQV.hqStreetSound = streetSound;", base)
        self.assertIn("if(!snd && !(snd = HQV.hqStreetSound ? HQV.hqStreetSound() : null)) return;", self.read("hqcity.js"))


if __name__ == "__main__":
    unittest.main()
