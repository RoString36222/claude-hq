"""Sound PR B, the sky, weather and ambient group: every sound of games/hqweather.js, hqspectacle.js, hqairbase.js,
hqairport3d.js, hqlobby.js and ocean.js heard where it is (the spatial API of games/engine.js).

Node imports the vendored three.js and loads games/engine.js against a fake Web Audio context (it has a StereoPanner,
so the voices really pan), then the modules the way hq3d loads them; it sets the listener itself, stubs the wall clock
(Date.now) and drives each module's update: a storm's strike and its thunder, a fireworks show and the park's rides
and fountain (Commons doc claude-hq@2), a flyover of the air base's jets, parked jets on the airfield's stands
(tests/fixtures/airfield_commons.json), the lobby's ambience and the sea, river and lakes. The engine's calls are
spied on (the real ones still run). Python checks: thunder and every burst from where they are (panned, the ambient
bus, the modules' own level curves and travel delay kept), the rain a bed, rides and fountain in their pools at their
places, the jets' roar per jet and the flyby boom at the jet, the stands' APUs, the lobby fountain at the centrepiece,
the water at its nearest point, and silence at the ambient or sfx volume 0. Skipped without node. Stdlib only."""
import json
import os
import shutil
import subprocess
import unittest

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
NODE = shutil.which("node")

HARNESS = r"""
import fs from "fs";
import zlib from "zlib";
const root = %(root)s;
const THREE = await import(root + "/games/vendor/three-module.js");
// ---- a fake Web Audio context: nodes remember where they connect, params the values scheduled on them
let now = 0;
function param(v){ const p = {value: v, ev: [], setTargetAtTime(x, t){ p.ev.push([x, t]); }, setValueAtTime(x, t){ p.ev.push([x, t]); },
  exponentialRampToValueAtTime(x, t){ p.ev.push([x, t]); }, linearRampToValueAtTime(x, t){ p.ev.push([x, t]); },
  cancelScheduledValues(t){ p.ev = p.ev.filter(e => e[1] < t); }}; return p; }
function node(k){ const n = {k: k, outs: [], connect(d){ n.outs.push(d); return d; }, disconnect(){}, start(){}, stop(){}, setPeriodicWave(){},
  frequency: param(0), detune: param(0), Q: param(0), type: "", playbackRate: param(1), gain: param(1), pan: param(0), delayTime: param(0)}; return n; }
class AC { constructor(){ this.state = "running"; this.sampleRate = 8000; this.destination = node("dest"); }
  get currentTime(){ return now; } resume(){ return Promise.resolve(); }
  createGain(){ return node("gain"); } createOscillator(){ return node("osc"); } createBiquadFilter(){ return node("filter"); }
  createBufferSource(){ return node("src"); } createWaveShaper(){ return node("shaper"); } createPeriodicWave(){ return {}; }
  createStereoPanner(){ return node("pan"); } createDelay(){ return node("delay"); }
  createDynamicsCompressor(){ const n = node("comp"); ["threshold", "knee", "ratio", "attack", "release"].forEach(k => n[k] = param(0)); return n; }
  createBuffer(ch, n, sr){ const d = new Float32Array(n); return {sampleRate: sr, length: n, getChannelData: () => d}; } }
const store = {hq_sfx: "0.5"};
globalThis.localStorage = {getItem: k => k in store ? store[k] : null, setItem(k, v){ store[k] = String(v); }};
globalThis.window = {HQV: {}, AudioContext: AC, matchMedia: () => ({matches: false})};
globalThis.self = window;
globalThis.document = {documentElement: {classList: {contains: () => false}}};
let NOW = 1792000000000; Date.now = () => NOW;
for (const f of ["engine", "world", "hqnav", "ocean", "hqheli", "hqmerge", "hqairbase", "hqairport3d", "hqweather", "hqspectacle",
                 "hqstyle", "hqtower", "hqdecor", "hqlobby"]) new Function(fs.readFileSync(root + "/games/" + f + ".js", "utf8"))();
const H = window.HQV, E = H.engine, WD = H.world, out = {};
E.audioOut();                                            // the context and its buses (a browser makes them on the first gesture)
const AMB = E.ambientOut().out;
// ---- spies: what the modules ask of the engine (the real calls still run)
const calls = {spatialOut: [], sfxAt: [], loop: [], pool: [], engineSound: [], ambientLoop: []};
function spy(name, wrap){ const f = E[name]; E[name] = function(){ const args = [].slice.call(arguments), r = f.apply(E, args); calls[name].push({args: args, r: r}); return wrap ? wrap(r, args) : r; }; }
function recordSet(h){ const s = h.set; h.sets = []; h.set = function(){ const a = [].slice.call(arguments); h.sets.push(a); return s.apply(h, a); }; return h; }
spy("spatialOut"); spy("sfxAt"); spy("loop"); spy("engineSound", recordSet); spy("ambientLoop", recordSet);
spy("pool", function(P, args){ const u = P.update; P.kind = args[0]; P.voices = (args[1] || {}).voices; P.update = function(list){ P.last = list; P.ids = u.call(P, list); return P.ids; }; return P; });
const pools = kind => calls.pool.filter(c => c.args[0] === kind).map(c => c.r);
const live = () => E.spatial.state().pools;
const r3 = v => Math.round(v*1000)/1000;
const pt = p => p ? [r3(p.x), r3(p.y), r3(p.z)] : null;
// a voice from spatialOut: its pan and where its panner goes
function voice(V){ if(!V) return null; const pn = V.out.outs[0]; return {pan: pn && pn.k === "pan" ? pn.pan.value : null, amb: !!pn && pn.outs[0] === AMB, d: V.d, delay: V.delay}; }
function rng(seed){ var a = seed >>> 0 || 1; return function(){ a = (a + 0x6D2B79F5) >>> 0; var t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0)/4294967296; }; }
const noop2d = new Proxy({}, {get(t, k){ return k === "measureText" ? function(){ return {width: 10}; } : (k === "createLinearGradient" || k === "createRadialGradient") ? function(){ return {addColorStop(){}}; } : function(){}; }, set(){ return true; }});
const canvasTex = (w, h, draw) => { if(draw) draw(noop2d, w, h); return {c: null, g: noop2d, t: new THREE.Texture()}; };
const mat = (cl, o) => new THREE.MeshStandardMaterial(Object.assign({color: cl}, o || {}));
const raw = JSON.parse(zlib.gunzipSync(fs.readFileSync(root + "/tests/fixtures/claude-hq@2.json.gz")).toString("utf8"));
const W = WD.pack(raw);

/* ---------- the weather: a storm's strike, its thunder from there; the rain a bed ---------- */
{
  const X = H.hqWeather, world = "snd-wx";
  let slot = 116000; while(!(X.kindAt(world, slot) === "storm" && X.kindAt(world, slot - 1) === "storm")) slot++;
  const strikes = [];
  for(let s = slot*X.SLOT/1000 + 100; strikes.length < 2; s += X.STRIKE_WIN) X.strikes(world, s).forEach(q => { if(strikes.length < 2 && (!strikes.length || q.t > strikes[0].t + 2)) strikes.push(q); });
  const wx = X.create({THREE, E, rng, canvasTex}, {scene: new THREE.Scene(), world, ground: () => 0});
  function strike(st, east){
    const cam = {x: st.x + east, y: 2, z: st.z, mode: "classic"};
    E.listener({x: cam.x, y: cam.y, z: cam.z, yaw: 0});            // facing +z: its right is -x, toward the strike
    const n0 = calls.spatialOut.length;
    NOW = Math.round((st.t + 0.1)*1000); now += 0.1; wx.update(1, 0.016, cam);
    NOW += Math.round((east/343 + 0.2)*1000); now += 1; wx.update(2, 0.016, cam);
    return calls.spatialOut.slice(n0).filter(c => c.args[0] === "thunder");
  }
  const th = strike(strikes[0], 300);
  E.ambientSetVolume(0); const off = strike(strikes[1], 300); E.ambientSetVolume(1);
  const hiss = calls.ambientLoop.filter(c => c.args[0] === 2600)[0];
  out.weather = {n: th.length, at: th.length ? pt(th[0].args[1]) : null, want: [r3(strikes[0].x), 0, r3(strikes[0].z)], opt: th.length ? th[0].args[2] : null,
    voice: th.length ? voice(th[0].r) : null, offN: off.length, offVoice: off.length ? off[0].r : "none",
    rain: hiss ? {args: hiss.args.length, sk: hiss.args[2] === undefined ? null : hiss.args[2], sets: hiss.r.sets.slice(0, 2).map(a => [a.length, a[2] === undefined ? null : a[2]])} : null};
  wx.destroy();
}

/* ---------- the park: fireworks from their bursts, the rides and the fountain in their pools ---------- */
{
  const SP = H.hqSpectacle; SP.claim(W, 5);
  const P = W.spectacle.park, ground = (x, z) => WD.groundAt(W, x, z), gy = ground(P.x, P.z);
  const cr = Math.cos(P.rot), sr = Math.sin(P.rot), toW = (lx, lz) => ({x: P.x + lx*cr + lz*sr, z: P.z - lx*sr + lz*cr});
  const spx = SP.create({THREE, E, L: {tex: {load: () => new THREE.Texture()}}, rng, canvasTex}, W, {scene: new THREE.Scene(), ground, night: true});
  const cam = {x: P.x + 12, y: gy + 2, z: P.z, mode: "classic"};
  E.listener({x: cam.x, y: cam.y, z: cam.z, yaw: 0});
  const sec = Math.floor(1792000000/SP.SHOW_EVERY)*SP.SHOW_EVERY + 40;      // 40 s into a show, by night
  NOW = sec*1000; now += 1;
  const n0 = calls.spatialOut.length;
  spx.update(1, 0.016, cam);
  const fw = calls.spatialOut.slice(n0).filter(c => c.args[0] === "firework");
  const want = SP.shells(P.w/2, P.d/2, sec - SP.FW_LIVE, sec + SP.FW_RISE + 0.05).filter(s => s.t <= sec).map(s => { const w = toW(s.burst.x, s.burst.z); return [r3(w.x), r3(gy + s.burst.y), r3(w.z)]; });
  out.fireworks = {n: fw.length, at: fw.map(c => pt(c.args[1])), want: want,
    opts: fw.map(c => { const p = c.args[1], d = Math.hypot(p.x - cam.x, p.y - cam.y, p.z - cam.z); return [c.args[2].gain, c.args[2].delay, r3(c.args[2].dur - (d/343 + 3))]; }),
    voices: fw.map(c => voice(c.r)), live: (E.spatial.state().live.firework || []).length};
  // the rides and the fountain: every frame the park is drawn, each source where its ride is (the world's frame)
  const speeds = [], ids = {};
  for(let k = 0; k < 160; k++){ NOW = (sec + 600 + k*0.75)*1000; now += 0.75; spx.update(2 + k, 0.75, cam);
    const tp = pools("train")[0]; if(tp && tp.last && tp.last[0]) speeds.push(tp.last[0].speed); }
  const dbg = spx.debug(), entry = {}; dbg.rides.forEach(r => { entry[r.id] = r.entry; });
  const src = {};
  ["fountain", "train", "gondola"].forEach(k => { const p = pools(k)[0]; (p && p.last || []).forEach(s => { src[s.id] = {kind: k, loop: s.loop || null, lvl: s.lvl,
    off: entry[s.id] ? r3(Math.hypot(s.x - entry[s.id].x, s.z - entry[s.id].z)) : null,
    inPark: (function(){ const dx = s.x - P.x, dz = s.z - P.z, lx = dx*cr - dz*sr, lz = dx*sr + dz*cr; return Math.abs(lx) <= P.w/2 + 2 && Math.abs(lz) <= P.d/2 + 2; })()}; }); });
  out.park = {pools: ["fountain", "train", "gondola"].map(k => { const p = pools(k)[0]; return p ? [k, p.voices, (p.ids || []).length] : [k, null, null]; }),
    sources: src, loops: calls.loop.map(c => c.args[0] + "/" + (c.args[1] || "")).filter((v, i, a) => a.indexOf(v) === i).sort(),
    stopped: speeds.some(v => v === 0), fast: Math.max.apply(null, speeds.concat([0])), lagoon: !!(spx.debug() && src.lagoon),
    gondolaPicked: (pools("gondola")[0] || {}).ids || []};
  spx.destroy();
  out.park.after = Object.keys(live()).filter(k => k === "fountain" || k === "train" || k === "gondola");
}

/* ---------- the air base: each jet's roar where it flies, the flyby boom from the jet ---------- */
{
  const A = H.hqAirbase, sea = H.ocean.seaOf(raw, null, 5);
  const air = A.create({THREE, mat}, new THREE.Group(), {W, sea, commons: true, civics: []});
  // a flyover sortie, its lead jet near the middle of its run
  let ms = Math.floor(1792000000000/A.CYCLE)*A.CYCLE, J = null;
  for(let n = 0; n < 60 && !J; n++, ms += A.CYCLE){ const L = A.jetsAt(ms + 23000, {cx: 0, cz: 0, seed: air.seed, carrier: air.carrier}); if(L.length === 2 && L[0].v === A.JET.fly) J = {ms: ms + 23000, L}; }
  const p = J.L[0], hx = Math.sin(p.yaw), hz = Math.cos(p.yaw), rx = -Math.cos(p.yaw), rz = Math.sin(p.yaw);
  // the listener 150 m to the lead's left, facing the way it flies: the jets are on its right
  const ear = {x: p.x - rx*150, y: p.y - 40, z: p.z - rz*150};
  E.listener({x: ear.x, y: ear.y, z: ear.z, yaw: p.yaw});
  NOW = J.ms; now += 1;
  const s0 = calls.sfxAt.length, l0 = calls.loop.length;
  air.update(1, 0.016, 1, ear);
  const jp = pools("jet")[0];
  const booms = calls.sfxAt.slice(s0);
  out.jets = {pool: jp ? [jp.voices, jp.ids] : null, srcs: jp ? jp.last.map(s => [s.id, r3(s.lvl), pt(s), pt(J.L.filter(q => q.id === s.id)[0])]) : null,
    pans: jp ? jp.last.map(s => r3(E.hear("jet", s).pan)) : null, loops: calls.loop.slice(l0).map(c => c.args[0] + "/" + c.args[1]),
    booms: booms.map(c => [c.args[0], c.args[2] && c.args[2].kind, pt(c.args[1]), c.r])};
  NOW += 100; now += 0.1; const s1 = calls.sfxAt.length; air.update(1.1, 0.1, 1, ear); out.jets.again = calls.sfxAt.length - s1;
  store.hq_sfx = "0"; NOW += 100; now += 0.1; air.update(1.2, 0.1, 1, ear); out.jets.mute = jp ? jp.ids.length : null; store.hq_sfx = "0.5";
  air.destroy();
  out.jets.after = "jet" in live();
}

/* ---------- the airport: each parked jet's APU on its stand ---------- */
{
  const L = JSON.parse(fs.readFileSync(root + "/tests/fixtures/airfield_commons.json", "utf8"));
  const ap = H.hqAirport3d.create({THREE, E, mat, canvasTex}, L, {ground: (x, z) => WD.heightAt(W, x, z), night: false});
  const S = {}; L.stands.forEach(s => { S[s.id] = s; });
  const hp = {x: 100, z: -50};
  const tr = {parked: [["1", "jet"], ["2", "jet"], ["4", "jet"], ["3", "amphib"]].map(q => ({stand: q[0], x: S[q[0]].x + hp.x, z: S[q[0]].z + hp.z, yaw: S[q[0]].yaw, kind: q[1]}))};
  E.listener({x: S["1"].x + 20, y: L.y + 1.6, z: S["1"].z + 5, yaw: 0});
  now += 1;
  const e0 = calls.engineSound.length;
  ap.update(0.016, 1, null);
  const sp = pools("plane")[0], none = sp ? sp.ids.slice() : null;
  ap.update(0.016, 1.016, null, tr, hp);
  const made = calls.engineSound.slice(e0);
  out.airport = {pool: sp ? [sp.voices, sp.ids] : null, none: none, srcs: sp ? sp.last.map(s => [s.id, pt(s)]) : null,
    want: [["stand:1", [S["1"].x, r3(L.y + 3), S["1"].z]], ["stand:2", [S["2"].x, r3(L.y + 3), S["2"].z]], ["stand:4", [S["4"].x, r3(L.y + 3), S["4"].z]]],
    made: made.map(c => c.args[0]), set: made.length ? made[0].r.sets.slice(-1).map(a => [a[0], a[1].thr, a[1].sk, !!a[1].pos]) : null};
  ap.dispose();
  out.airport.after = "plane" in live();
}

/* ---------- the lobby: a fountain from the centrepiece, the other ambiences beds ---------- */
{
  const S = H.hqStyle;
  let scene = null, STYLE = null;
  const add = (o, x, y, z, p) => { o.position.set(x, y, z); (p || scene).add(o); return o; };
  const c = {THREE, PI: Math.PI, COL: {amber: 0xffb347, cyan: 0x5fd3e6, green: 0x6fd38a, coral: 0xff6b5b}, HEX: {green: "#6fd38a", amber: "#ffb347", cyan: "#5fd3e6", ink: "#e9eff3", muted: "#8e9aa6", coral: "#ff6b5b"},
    E, mat, emis(cl, e, ei, o){ const m = mat(cl, o); m.emissive = new THREE.Color(e); m.emissiveIntensity = ei; return m; }, add,
    box(w, h, dd, m, x, y, z, p){ return add(new THREE.Mesh(new THREE.BoxGeometry(w, h, dd), m), x, y, z, p); },
    cyl(rt, rb, h, m, x, y, z, p, seg){ return add(new THREE.Mesh(new THREE.CylinderGeometry(rt, rb, h, seg || 12), m), x, y, z, p); },
    sph(r, m, x, y, z, p){ return add(new THREE.Mesh(new THREE.SphereGeometry(r, 8, 6), m), x, y, z, p); },
    canvasTex, screen(w, h, t, tr){ return new THREE.Mesh(new THREE.PlaneGeometry(w, h), new THREE.MeshBasicMaterial({map: t, transparent: !!tr})); },
    glow(col){ return new THREE.Sprite(new THREE.SpriteMaterial({color: col, transparent: true})); }, label(){ return new THREE.Sprite(new THREE.SpriteMaterial()); },
    short(s, n){ s = String(s || ""); return s.length > n ? s.slice(0, n) : s; }, rr(){}, sky(){ return new THREE.Texture(); }, level(){ return 7; }, crewState(){ return "idle"; },
    rng, hashStr: S.hashStr, look(){ return {sign: "Ann", style: STYLE}; }, avatar(){ return {x: 0, z: 6}; }};
  function lobby(amb){
    const st = S.defaults(); st.int.lobby.ambience = amb; STYLE = st;
    const w = {scene: new THREE.Scene(), name: "lobby"}; scene = w.scene;
    H.hqWorlds.lobby(c, w); w.setTime(true);
    const a0 = calls.ambientLoop.length;
    w.onEnter(); w.update(1, 0.05, 1); w.update(1.05, 0.05, 1);
    const L = calls.ambientLoop.slice(a0)[0];
    w.onLeave();
    return L ? {args: L.args.map(v => v === undefined ? null : v), set: L.r.sets.slice(-1).map(a => [a[0], a[1], a[2] ? pt(a[2]) : null])[0]} : null;
  }
  E.listener({x: 5, y: 1.6, z: 3.4, yaw: 0});                    // east of the centrepiece, facing +z: it is on the right
  out.lobby = {fountain: lobby("fountain"), jazz: lobby("jazz"), pan: r3(E.hear("fountain", {x: -1.5, y: 1.5, z: 3.4}).pan)};
}

/* ---------- the water: the sea's surf on the coast, the river and the lakes at their banks or under you ---------- */
{
  const O = H.ocean, sq = (cx, cz, h) => [[cx - h, cz - h], [cx + h, cz - h], [cx + h, cz + h], [cx - h, cz + h]];
  const coast = sq(0, 0, 500), rpoly = [[-100, 0], [100, 0], [100, 20], [-100, 20]];
  const river = {poly: rpoly, inWater: O.landTest([rpoly])};
  const lakeP = sq(300, 300, 50), isl = sq(300, 300, 10), inL = O.landTest([lakeP]), inI = O.landTest([isl]);
  const Wd = {bodies: [{id: "lake:0", kind: "lake", poly: lakeP, islands: [isl], y: -1, inWater: (x, z) => inL(x, z) && !inI(x, z)}], coast: coast};
  const calm = O.calmOf(river, Wd), H0 = (x, z) => O.waterHeard({x, z}, coast, calm, -4).map(s => [s.id, r3(s.x), r3(s.y), r3(s.z), s.lvl]);
  out.water = {beach: H0(480, 0), inland: H0(380, -200), pier: H0(520, 0), onRiver: H0(0, 10), byRiver: H0(0, 50), island: H0(300, 300), onLake: H0(300, 280),
    none: O.waterHeard(null, coast, calm, -4).length, M: O.WATER_M};
  // waterOf hands the mounted ocean the coast
  const d3 = JSON.parse(zlib.gunzipSync(fs.readFileSync(root + "/tests/fixtures/claude-hq@3.json.gz")).toString("utf8"));
  out.water.coastOf = JSON.stringify(O.waterOf(d3).coast) === JSON.stringify(O.coastOf(d3)) && O.coastOf(d3).length >= 3;
  // mounted: step() keeps the nearest two in its pool
  const oc = O.mount({THREE, E}, new THREE.Scene()); oc.g.position.y = -4; oc.setRiver(river); oc.setWater(Wd);
  E.listener({x: 480, y: -2, z: 10, yaw: 0}); now += 1;
  oc.step(1, 0.016, {x: 480, y: -2, z: 10});
  const wp = pools("water")[0];
  out.water.mounted = wp ? [wp.voices, wp.ids, wp.last.map(s => s.id)] : null;
  out.water.loops = calls.loop.filter(c => c.args[0] === "water").length;
  oc.dispose();
  out.water.after = "water" in live();
  // @1 and @2 have no water layer (waterOf is null): the coast comes on its own (setCoast, before setWater as the City
  // calls them), so the surf is heard on their beaches too; ears 5 m off the first coast vertex
  for (const f of ["claude-hq@2", "island@2", "claude-hq@3"]){
    const d = JSON.parse(zlib.gunzipSync(fs.readFileSync(root + "/tests/fixtures/" + f + ".json.gz")).toString("utf8")), C = O.coastOf(d), v = C[0];
    const surf = withCoast => {
      const o2 = O.mount({THREE, E}, new THREE.Scene()); o2.g.position.y = -4;
      o2.setRiver(O.riverOf(d)); if(withCoast) o2.setCoast(C); o2.setWater(O.waterOf(d));
      E.listener({x: v[0] + 5, y: 1.6, z: v[1], yaw: 0}); now += 1;
      o2.step(1, 0.016, {x: v[0] + 5, y: 1.6, z: v[1]});
      const wp = pools("water").slice(-1)[0], ids = wp && wp.ids ? wp.ids.slice() : null; o2.dispose(); return ids;
    };
    out.water[f] = {waterOf: !!O.waterOf(d), coast: C.length, heard: surf(true), before: surf(false)};
  }
  const o3 = O.mount({THREE, E}, new THREE.Scene()); o3.setCoast(null); o3.setCoast([[0, 0], [1, 1]]);
  E.listener({x: 0, y: 1.6, z: 0, yaw: 0}); o3.step(1, 0.016, {x: 0, y: 1.6, z: 0});
  out.water.badCoast = pools("water").slice(-1)[0].ids; o3.dispose();
}
console.log(JSON.stringify(out));
"""


@unittest.skipUnless(NODE, "node is not installed")
class SkyWeatherAmbientSound(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        r = subprocess.run([NODE, "--input-type=module", "-e", HARNESS.replace("%(root)s", json.dumps(ROOT))],
                           capture_output=True, text=True, timeout=300)
        if r.returncode != 0:
            raise AssertionError("node failed:\n" + r.stderr[-4000:])
        cls.o = json.loads(r.stdout.strip().splitlines()[-1])

    def close(self, a, b, tol=1e-3):
        self.assertEqual(len(a), len(b))
        for x, y in zip(a, b):
            self.assertAlmostEqual(x, y, delta=tol)

    def test_thunder_comes_from_the_strike(self):
        w = self.o["weather"]
        self.assertEqual(w["n"], 1)
        self.close(w["at"], w["want"])                           # the strike's place, on the ground
        self.assertEqual(w["opt"], {"gain": 1, "delay": False, "dur": 3.4})   # thunderVol stays its level, the queue its delay
        v = w["voice"]
        self.assertGreater(v["pan"], 0.3)                         # the strike is on the listener's right
        self.assertTrue(v["amb"])                                 # through the Ambient sounds volume
        self.assertEqual(v["delay"], 0)
        self.assertAlmostEqual(v["d"], 300, delta=3)

    def test_thunder_is_silent_at_ambient_zero(self):
        w = self.o["weather"]
        self.assertEqual(w["offN"], 1)                            # asked for, and nothing built
        self.assertIsNone(w["offVoice"])

    def test_the_rain_is_a_bed_round_you(self):
        r = self.o["weather"]["rain"]
        self.assertIsNotNone(r)
        self.assertEqual(r["args"], 2)                            # no spatial kind: no place, no pan
        for n, pos in r["sets"]:
            self.assertIsNone(pos)

    def test_each_burst_comes_from_where_it_bursts(self):
        f = self.o["fireworks"]
        self.assertGreater(f["n"], 0)
        self.assertEqual(f["n"], len(f["want"]))
        for at in f["at"]:
            self.assertTrue(any(all(abs(a - b) < 1e-3 for a, b in zip(at, w)) for w in f["want"]), at)
        for gain, delay, dur in f["opts"]:
            self.assertEqual(gain, 1)                             # boomVol stays its level
            self.assertIs(delay, False)                           # t0 already waits d/343
            self.assertAlmostEqual(dur, 0, delta=1e-3)            # the voice lasts the wait and the echo
        heard = [v for v in f["voices"] if v]
        self.assertTrue(heard)
        for v in heard:
            self.assertTrue(v["amb"])
            self.assertIsNotNone(v["pan"])
        self.assertLessEqual(f["live"], 6)                        # the six nearest shells at most

    def test_the_rides_and_the_fountain_are_heard_where_they_are(self):
        p = self.o["park"]
        pools = {k: (v, n) for k, v, n in p["pools"]}
        self.assertEqual(pools["train"][0], 1)
        self.assertEqual(pools["gondola"][0], 2)
        self.assertEqual(pools["fountain"][0], 1)
        s = p["sources"]
        self.assertEqual(s["coaster"]["kind"], "train")
        self.assertTrue(s["coaster"]["inPark"])
        for rid, loop in (("wheel", "hum"), ("carousel", "hum"), ("drop", "jet-roar"), ("swing", "jet-roar")):
            self.assertIn(rid, s)
            self.assertEqual(s[rid]["kind"], "gondola", rid)
            self.assertEqual(s[rid]["loop"], loop, rid)
            self.assertLess(s[rid]["off"], 30, rid)                # by its own station's steps: the world's frame, not the park's
            self.assertTrue(0 <= s[rid]["lvl"] <= 1, rid)
        if "galleon" in s:
            self.assertEqual(s["galleon"]["loop"], "jet-roar")
            self.assertLess(s["galleon"]["off"], 30)
        if p["lagoon"]:
            self.assertEqual(s["lagoon"]["kind"], "fountain")
            self.assertTrue(s["lagoon"]["inPark"])
            self.assertIn("fountain/", p["loops"])
        self.assertLessEqual(len(p["gondolaPicked"]), 2)
        self.assertIn("train-run/train", p["loops"])
        self.assertTrue({"hum/gondola", "jet-roar/gondola"} & set(p["loops"]))
        self.assertTrue(p["stopped"])                             # silent while the train waits in its station
        self.assertGreater(p["fast"], 12)                         # and running hard down the drop
        self.assertEqual(p["after"], [])                          # destroy() lets every pool go

    def test_each_jet_roars_where_it_flies(self):
        j = self.o["jets"]
        self.assertEqual(j["pool"][0], 2)
        self.assertEqual(sorted(j["pool"][1]), ["a", "b"])
        for jid, lvl, at, want in j["srcs"]:
            self.close(at, want)                                  # each at its own jet
            self.assertAlmostEqual(lvl, 1, places=3)              # a flyover's afterburners lit
        for pan in j["pans"]:
            self.assertGreater(pan, 0.3)                          # both on the listener's right
        self.assertEqual(j["loops"], ["jet-roar/jet", "jet-roar/jet"])
        self.assertEqual(j["mute"], 0)                            # sfx volume 0: nothing plays
        self.assertFalse(j["after"])

    def test_the_flyby_boom_is_at_the_jet_once_a_sortie(self):
        j = self.o["jets"]
        names = sorted(b[0] for b in j["booms"])
        self.assertEqual(names, ["door", "door", "shot", "shot"])     # once for each of the pair
        srcs = [s[3] for s in j["srcs"]]
        for name, kind, at, played in j["booms"]:
            self.assertEqual(kind, "jet")
            self.assertTrue(any(all(abs(a - b) < 1e-3 for a, b in zip(at, w)) for w in srcs), at)
        self.assertEqual([b[3] for b in j["booms"][:2]], [True, True])   # the lead's (the wingman's may find the jet voices taken)
        self.assertEqual(j["again"], 0)

    def test_parked_jets_run_their_apus_on_their_stands(self):
        a = self.o["airport"]
        self.assertEqual(a["none"], [])                           # no traffic handed in: silent
        self.assertEqual(a["pool"][0], 1)                         # one (the City's moving aircraft have their own pool)
        self.assertEqual(a["pool"][1], ["stand:1"])               # the nearest
        self.assertEqual([s[0] for s in a["srcs"]], [w[0] for w in a["want"]])   # jets only: the amphibian has no APU
        for (sid, at), (wid, want) in zip(a["srcs"], a["want"]):
            self.close(at, want)                                  # the traffic's frame moved to the city's
        self.assertEqual(a["made"], ["jet"])
        self.assertEqual(a["set"], [[900, 0, "plane", True]])     # idling, as the plane kind
        self.assertFalse(a["after"])

    def test_the_lobby_fountain_is_at_the_centrepiece(self):
        L = self.o["lobby"]
        self.assertEqual(L["fountain"]["args"], [900, 0.6, "fountain"])
        g, fq, pos = L["fountain"]["set"]
        self.assertAlmostEqual(g, 0.05)
        self.close(pos, [-1.5, 1.5, 3.4])
        self.assertGreater(L["pan"], 0)                           # east of it, facing +z: on the right
        self.assertEqual(L["jazz"]["args"], [650, 3, None])       # a bed: no kind
        self.assertIsNone(L["jazz"]["set"][2])

    def test_the_sea_washes_on_the_nearest_coast(self):
        w = self.o["water"]
        self.assertEqual(w["beach"], [["sea", 500, -4, 0, 1]])
        self.assertEqual(w["pier"], [["sea", 500, -4, 0, 1]])    # out past the coast: still the shore you hear
        self.assertEqual(w["inland"], [])                         # 120 m in: too far
        self.assertEqual(w["M"], 60)
        self.assertEqual(w["none"], 0)
        self.assertTrue(w["coastOf"])

    def test_calm_water_is_under_you_or_at_its_bank(self):
        w = self.o["water"]
        self.assertEqual(w["onRiver"], [["river", 0, -3.7, 10, 0.6]])     # on the river: right under you, RIVER_Y up
        self.assertEqual(w["byRiver"], [["river", 0, -3.7, 20, 0.6]])     # beside it: its nearest bank
        self.assertEqual(w["island"], [["lake:0", 290, -1, 300, 0.5]])    # on the lake's island: its own shore, not the lake's
        self.assertEqual(w["onLake"], [["lake:0", 300, -1, 280, 0.5]])

    def test_the_surf_on_every_world_version(self):
        w = self.o["water"]
        for f in ("claude-hq@2", "island@2"):
            self.assertFalse(w[f]["waterOf"], f)                 # no water layer on @2
            self.assertGreaterEqual(w[f]["coast"], 3, f)
            self.assertIn("sea", w[f]["heard"], f)               # setCoast: the beach is heard
            self.assertNotIn("sea", w[f]["before"], f)           # (waterOf's coast alone left @2 silent)
        self.assertIn("sea", w["claude-hq@3"]["heard"])
        self.assertIn("sea", w["claude-hq@3"]["before"])         # @3 had it through waterOf, and still does
        self.assertEqual(w["badCoast"], [])

    def test_the_mounted_ocean_plays_the_nearest_water(self):
        w = self.o["water"]
        voices, ids, srcs = w["mounted"]
        self.assertEqual(voices, 2)
        self.assertEqual(ids, ["sea"])
        self.assertEqual(srcs, ["sea"])
        self.assertEqual(w["loops"], 1)
        self.assertFalse(w["after"])


class SourceRules(unittest.TestCase):
    def read(self, name):
        with open(os.path.join(ROOT, "games", name), encoding="utf-8") as f:
            return f.read()

    def test_nothing_random_is_heard(self):
        for name in ("hqweather.js", "hqspectacle.js", "hqairbase.js", "hqairport3d.js", "hqlobby.js", "ocean.js"):
            self.assertNotIn("Math.random(", self.read(name), name)

    def test_older_engines_are_guarded(self):
        self.assertIn('E.spatialOut ? E.spatialOut("thunder"', self.read("hqweather.js"))
        self.assertIn('E.spatialOut ? E.spatialOut("firework"', self.read("hqspectacle.js"))
        base = self.read("hqairbase.js")
        self.assertIn("var roarP = E.pool && E.loop ?", base)
        self.assertIn('if(E.sfxAt){ E.sfxAt("door", p, {kind: "jet"}); E.sfxAt("shot", p, {kind: "jet"}); } else if(E.sfx)', base)
        self.assertIn("var standP = E.pool && E.engineSound ?", self.read("hqairport3d.js"))
        self.assertIn("var waterP = E.pool && E.loop && E.listenerAt ?", self.read("ocean.js"))

    def test_the_city_hands_the_ocean_its_coast(self):
        c = self.read("hqcity3d.js")
        i = c.index("oc.setCoast(HQV.ocean.coastOf(doc));")
        self.assertLess(i, c.index("oc.setWater(HQV.ocean.waterOf(doc));"))   # before setWater: a null layer keeps it

    def test_the_city_hands_the_airport_its_parked_jets(self):
        # the stands' APUs play only with the City's airport traffic (the parked jets as drawn) and its frame offset
        self.assertIn("ap3.update(dt, t, cam && cam.x != null ? {position: {x: cam.x, y: cam.y, z: cam.z}} : null, "
                      "{parked: apParkedList(tr, hp)}, hp);", self.read("hqcity3d.js"))


if __name__ == "__main__":
    unittest.main()
