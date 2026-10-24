"""Sound PR B, the minigames and the UI: every 3D game hears from its own camera, and its world sounds are where they are.

Strikezone (games/strike.js): a missile's blast, the Arena's blast rows and a bot's rocket launch are placed at the blast
or the bot through the engine's spatial voices (the blast kind's distance fade, a pan to its side, the sound-travel
delay, the kind's four voices), run here as the very statements strike.js holds; with no ears (the 2D map view) they
play centred as before, nothing sounds at volume 0, and an engine without sfxAt gets the old calls. Kart Racing and
Valley Rally (games/kart.js, games/rally.js) mount under node in an Arena room on a small fake DOM: the other racers'
engines are pooled ("peer": the nearest three within 150 m, panned to their side), a car that finished or went quiet
idles in Kart, one the Arena stopped moving falls silent in Rally, out or away cars are never heard, a rally car
changes gear with its speed without hunting, the Ambient sounds slider does not touch them, and leaving the race stops
every voice and the ears. Your own engine, countdowns and game feedback stay centred, and the 2D games and the UI
(own AudioContexts, <audio>, the boombox's iframe volume) make no positional call. Skipped without node. Stdlib only."""
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


# An AudioContext with a StereoPanner (its nodes keep every scheduled value), storage, a clock, a permissive DOM and
# the Valley shell (api, register, the Arena room client), then games/engine.js with every engine voice recorded.
FAKE = r"""
const fs = require('fs'), path = require('path'), R0 = process.argv[1];
let now = 0, pnow = 0; const store = {hq_sfx: '0.5'}, nodes = [], errors = [];
function param(v){ const p = {value: v, ev: [],
  setTargetAtTime(x, t, tc){ p.ev.push(['T', x, t, tc]); }, cancelScheduledValues(t){ p.ev = p.ev.filter(e => e[2] < t); },
  setValueAtTime(x, t){ p.ev.push(['V', x, t]); }, exponentialRampToValueAtTime(x, t){ p.ev.push(['E', x, t]); },
  linearRampToValueAtTime(x, t){ p.ev.push(['L', x, t]); }}; return p; }
function node(kind){ const n = {kind, out: [], stops: [], connect(d){ n.out.push(d); return d; }, disconnect(){ n.out = []; },
  start(t){ n.started = t == null ? now : t; }, stop(t){ n.stops.push(t); }, frequency: param(0), detune: param(0), Q: param(0), type: '',
  playbackRate: param(1), setPeriodicWave(){}}; nodes.push(n); return n; }
class AC { constructor(){ this.state = 'running'; this.sampleRate = 8000; this.destination = {kind: 'dest'}; }
  get currentTime(){ return now; } resume(){ return Promise.resolve(); }
  createGain(){ const n = node('gain'); n.gain = param(1); return n; }
  createOscillator(){ return node('osc'); } createBiquadFilter(){ return node('filter'); } createBufferSource(){ return node('src'); }
  createWaveShaper(){ return node('shaper'); } createPeriodicWave(){ return {}; }
  createDynamicsCompressor(){ const n = node('comp'); ['threshold', 'knee', 'ratio', 'attack', 'release'].forEach(k => n[k] = param(0)); return n; }
  createStereoPanner(){ const n = node('pan'); n.pan = param(0); return n; }
  createBuffer(c, n){ const d = new Float32Array(n); return {getChannelData: () => d}; } }
const ctx2d = new Proxy({}, {get(t, k){ if(k in t) return t[k];                // a 2D context: drawing does nothing
  if(k === 'measureText') return () => ({width: 8});
  if(/^create(Linear|Radial|Conic)Gradient$|^createPattern$/.test(k)) return () => ({addColorStop(){}});
  if(k === 'getImageData') return () => ({data: new Uint8ClampedArray(4)});
  return typeof k === 'string' ? function(){} : undefined; }, set(t, k, v){ t[k] = v; return true; }});
function el(tag){
  const e = {tagName: String(tag || 'div').toUpperCase(), children: [], style: {}, dataset: {}, attrs: {}, textContent: '', className: '',
    hidden: false, disabled: false, value: '', checked: false, tabIndex: 0, width: 300, height: 150, clientWidth: 640, clientHeight: 400,
    parentNode: null,
    classList: {_s: new Set(), add(...k){ k.forEach(x => this._s.add(x)); }, remove(...k){ k.forEach(x => this._s.delete(x)); },
                toggle(k, on){ const v = on === undefined ? !this._s.has(k) : !!on; if(v) this._s.add(k); else this._s.delete(k); return v; },
                contains(k){ return this._s.has(k); }},
    appendChild(c){ if(c && typeof c === 'object'){ e.children.push(c); c.parentNode = e; } return c; },
    insertBefore(c){ return e.appendChild(c); }, removeChild(c){ e.children = e.children.filter(x => x !== c); if(c) c.parentNode = null; return c; },
    remove(){ if(e.parentNode) e.parentNode.removeChild(e); },
    setAttribute(k, v){ e.attrs[k] = String(v); }, getAttribute(k){ return k in e.attrs ? e.attrs[k] : null; }, removeAttribute(k){ delete e.attrs[k]; },
    addEventListener(){}, removeEventListener(){}, focus(){}, blur(){}, contains(){ return false; }, closest(){ return null; },
    querySelector(){ return null; }, querySelectorAll(){ return []; },
    getBoundingClientRect(){ return {left: 0, top: 0, right: 640, bottom: 400, width: 640, height: 400}; },
    getContext(k){ return k === '2d' ? ctx2d : null; },                       // no webgl2: the games draw their map views
    get firstChild(){ return e.children[0] || null; }};
  return e;
}
let rafCb = null;
const window = {HQV: {}, AudioContext: AC, devicePixelRatio: 1, innerWidth: 1280, innerHeight: 800,
  matchMedia: () => ({matches: false}), addEventListener(){}, removeEventListener(){}, getComputedStyle: () => ({getPropertyValue: () => ''})};
const document = {documentElement: el('html'), body: el('body'), head: el('head'), hidden: false,
  createElement: el, createTextNode: t => ({textContent: String(t)}), addEventListener(){}, removeEventListener(){}};
global.window = window; global.document = document;
global.localStorage = {getItem: k => k in store ? store[k] : null, setItem(k, v){ store[k] = String(v); }, removeItem(k){ delete store[k]; }};
global.performance = {now: () => pnow*1000};
global.getComputedStyle = window.getComputedStyle;
global.requestAnimationFrame = f => { rafCb = f; return 1; }; global.cancelAnimationFrame = () => {};
global.fetch = url => { const p = path.join(R0, String(url).replace(/^\//, '').split('?')[0]);
  return Promise.resolve({ok: true, status: 200, json: () => Promise.resolve(JSON.parse(fs.readFileSync(p, 'utf8')))}); };
global.console.error = (...a) => { errors.push(a.map(x => x && x.stack ? x.stack : String(x)).join(' ')); };   // a frame that threw
const mpRegs = {};
const api = {save: {}, persist(){}, toast(){}, calm: () => false, hash: s => { let h = 7; for(const c of String(s)) h = (h*31 + c.charCodeAt(0)) | 0; return h; },
  open(){}, mk(tag, cls, text){ const e = el(tag); if(cls) e.className = cls; if(text != null) e.textContent = String(text); return e; },
  btn(label, cls){ const b = el('button'); b.textContent = String(label); b.className = cls || ''; return b; }};
const MP = {handlers: {}, me: () => 'me', send(){ return true; }, st: () => null, register(id, icon, desc, fn){ mpRegs[id] = fn; }};
window.HQV.api = api; window.HQV.mp = MP; window.HQV.register = () => {};
function load(rel){ new Function('window', 'document', fs.readFileSync(path.join(R0, rel), 'utf8'))(window, document); }
load('games/engine.js');
const E = window.HQV.engine, S = E.spatial, out = {};
E.audioOut(); E.engineSound('v8').stop();            // the context, its buses and the engines' compressor, made before anything is counted
const engines = [], realEngine = E.engineSound;      // every engine voice a game makes, with each set() it was given
E.engineSound = function(kind, ex, real){
  const k0 = nodes.length, h = realEngine(kind, ex, real), mine = nodes.slice(k0);
  const rec = {kind, sets: [], stopped: 0, pan: mine.find(n => n.kind === 'pan')};
  engines.push(rec);
  return {set(rpm, opt){ rec.sets.push({rpm, opt: opt ? Object.assign({}, opt, {pos: opt.pos ? {x: opt.pos.x, y: opt.pos.y, z: opt.pos.z} : undefined}) : null});
                         return h.set(rpm, opt); },
          stop(){ rec.stopped++; return h.stop(); }};
};
const peerVoices = () => engines.filter(e => e.sets.some(s => s.opt && s.opt.sk === 'peer'));
const lastSet = e => e && e.sets.length ? e.sets[e.sets.length - 1] : null;
const lastT = p => { const e = p.ev.filter(x => x[0] === 'T'); return e.length ? e[e.length - 1][1] : p.value; };
const r4 = x => Math.round(x*1e4)/1e4;
async function settle(){ for(let i = 0; i < 6; i++) await new Promise(r => setImmediate(r)); }
function frameAt(T){ pnow = T; now = T; const f = rafCb; rafCb = null; if(f) f(T*1000); }   // the page, audio and frame clocks together
"""

STRIKE = FAKE + r"""
const src = fs.readFileSync(path.join(R0, 'games', 'strike.js'), 'utf8');
const booms = src.match(/if\(E\.sfxAt\) E\.sfxAt\("boom"[^\n]*?else E\.sfx\("boom"\);/g) || [];
const shot = (src.match(/if\(E\.sfxAt\) E\.sfxAt\("shot"[^\n]*?else E\.sfx\("shot", \{w: LAUNCH_W\}\);/) || [''])[0];
const fn = s => new Function('E', 'x', 'y', 'z', 'P', 'FS', 'LAUNCH_W', s);
const BOT = {ai: {body: {y: 0}}}, FSx = {EYE: 1.6};
E.listener({x: 0, y: 1.6, z: 0, yaw: Math.PI/2});           // your eyes, facing +x: their right is +z
now = 20;
// one statement run: the voice it made (its first node), the pan, when its sources start, the filters' bands
function blast(stmt, x, y, z){
  now += 3;                                                  // the last one has ended: its voice is free
  const k = nodes.length; fn(stmt)(E, x, y, z, BOT, FSx, 3); const m = nodes.slice(k);
  if(!m.length) return null;
  const v = m[0], p = m.find(n => n.kind === 'pan'), srcs = m.filter(n => n.kind === 'src' || n.kind === 'osc');
  return {voice: v.kind, g: r4(v.gain.value), pan: p ? r4(p.pan.value) : null, start: r4(Math.min.apply(null, srcs.map(n => n.started)) - now),
          bands: m.filter(n => n.kind === 'filter').map(n => n.frequency.value), master: !!(p && p.out[0] === E.audioOut().out)};
}
out.found = {booms: booms.length, shot: !!shot};
out.boom = booms.map(b => ({ahead5: blast(b, 5, 1.6, 0), right60: blast(b, 0, 1.6, 60), left60: blast(b, 0, 1.6, -60), far: blast(b, 450, 1.6, 0)}));
out.want = {g60: r4(S.falloff('blast', 60)), d60: r4(60/343), d5: r4(5/343), g40: r4(S.falloff('blast', 40)), d40: r4(40/343)};
out.shot = {right40: blast(shot, 0, 99, 40), left40: blast(shot, 0, 99, -40)};   // from the bot's eyes (its body + EYE), not y
// the blast kind's four voices: a fifth as far off as the rest is not heard, a nearer one takes the farthest's voice
now += 3;
[20, 20, 20, 20].forEach(d => fn(booms[0])(E, d, 1.6, 0, BOT, FSx, 3));
const live4 = (S.state().live.blast || []).length, k5 = nodes.length;
fn(booms[0])(E, 20, 1.6, 0, BOT, FSx, 3); const made5 = nodes.length - k5;
fn(booms[0])(E, 8, 1.6, 0, BOT, FSx, 3);
out.voices = {live4, made5, after: (S.state().live.blast || []).map(e => Math.round(e.d)).sort((a, b) => a - b)};
E.ambientSetVolume(0); out.ambient0 = blast(booms[0], 5, 1.6, 0); E.ambientSetVolume(1);       // a blast is not ambience
E.listener(null); out.noEars = blast(booms[0], 0, 1.6, 60);                                     // the 2D map view: the old sound
E.listener({x: 0, y: 1.6, z: 0, yaw: Math.PI/2});
store.hq_sfx = '0'; out.muted = blast(booms[0], 5, 1.6, 0); store.hq_sfx = '0.5';             // Game sounds 0 (Calm's default)
const calls = [], OLD = {sfx: (n, o) => calls.push([n, o || null])};                          // an engine from before sfxAt
booms.forEach(b => fn(b)(OLD, 1, 2, 3, BOT, FSx, 3)); fn(shot)(OLD, 1, 2, 3, BOT, FSx, 3);
out.old = calls;
console.log(JSON.stringify(out));
"""

KART = FAKE + r"""
load('games/kart.js');
(async () => {
  const ctx = {box: el('div')};
  mpRegs.kart(ctx);
  await settle();                                            // tracks.json
  const P = (uid, car, x, z, extra) => Object.assign({user: {userId: uid, displayName: uid}, car, slot: 0, place: 1, lap: 1,
                                                      x: x*100, z: z*100, r: 0, away: false, dnf: false, fin: null}, extra || {});
  const players = [P('me', 0, 0, 0), P('a', 1, 10, 0), P('b', 2, 0, 30), P('c', 3, -50, 0), P('d', 4, 0, -80),
                   P('e', 1, 3, 0, {away: true}), P('f', 0, 0, 140), P('g', 2, 200, 0)];
  const pos = {}; players.forEach(p => { pos[p.user.userId] = [p.x/100, p.z/100]; });
  frameAt(9);
  MP.handlers.kart.on({ev: 'kart', race: {phase: 'race', track: 'meadow', laps: 3, raceMs: 1000, scale: 1.5, tracks: ['meadow'], players}});
  E.listener({x: 0, y: 3, z: 0, yaw: 0});                    // the camera over your car, facing +z: its right is -x
  const quiet = {};                                          // cars the Arena stops sending
  const snap = () => MP.handlers.kart.on({ev: 'snap', cars: Object.keys(pos).filter(u => u !== 'me' && !quiet[u])
    .map(u => ({u, x: pos[u][0]*100, z: pos[u][1]*100, r: 0, s: 200, lap: 1}))});      // 20 m/s each
  let T = 10;
  const run = sec => { const end = T + sec; for(; T < end; T += 1/60){ if(Math.round(T*60) % 3 === 0) snap(); frameAt(T); } };
  run(1);
  const voice = k => peerVoices().find(e => e.kind === k);
  const own = engines.filter(e => e.sets.length && e.sets.every(s => !s.opt || (!s.opt.pos && !s.opt.sk)));
  out.first = {pool: S.state().pools.peer, kinds: peerVoices().map(e => e.kind),
               a: lastSet(voice('diesel')), b: lastSet(voice('turbo')), c: lastSet(voice('hotrod')),
               pan: ['diesel', 'turbo', 'hotrod'].map(k => voice(k) ? r4(lastT(voice(k).pan.pan)) : null),
               own: own.map(e => e.kind), ownSets: own.length ? own[0].sets.length : 0};
  E.ambientSetVolume(0); run(0.2); out.ambient0 = S.state().pools.peer; E.ambientSetVolume(1);   // engines are not ambience
  MP.handlers.kart.on({ev: 'finish', user: 'b', ms: 61000, place: 1});                         // b takes the flag
  run(0.3); out.finished = lastSet(voice('turbo'));
  quiet.c = 1; run(2.5); out.stale = lastSet(voice('hotrod')); out.moving = (lastSet(voice('diesel')) || {}).rpm;   // c goes quiet
  MP.handlers.kart.on({ev: 'dnf', user: 'a'});                                                 // a is out: d takes its voice
  run(0.3); out.dnf = {pool: S.state().pools.peer, d: lastSet(voice('bike'))};
  store.hq_sfx = '0'; run(0.1); out.muted = S.state().pools.peer; store.hq_sfx = '0.5';
  E.listener(null); const k0 = engines.length; run(0.1); out.noEars = {pool: S.state().pools.peer, made: engines.length - k0};
  E.listener({x: 0, y: 3, z: 0, yaw: 0}); run(0.2); out.back = S.state().pools.peer;
  const peers = peerVoices();
  ctx.stop();                                                                                   // leave the race
  out.destroyed = {pool: S.state().pools.peer || null, stopped: peers.every(e => e.stopped > 0), listener: E.listenerAt()};
  out.errors = errors;
  console.log(JSON.stringify(out));
})().catch(e => { console.log(JSON.stringify({crash: String(e && e.stack || e), errors})); });
"""

RALLY = FAKE + r"""
window.HQV.rallyPhysics = require(path.join(R0, 'games', 'rally', 'physics.js'));
window.HQV.rallyStage = require(path.join(R0, 'games', 'rally', 'stage.js'));
window.HQV.rallyScene = {};                                  // no WebGL2 here: the map view
load('games/rally.js');
(async () => {
  const ctx = {box: el('div')}, Sg = window.HQV.rallyStage;
  mpRegs.rally(ctx);
  await settle();
  const on = m => MP.handlers.rally.on(m, {});
  const srv = T => Math.round(5e6 + T*1000);                 // the Arena's clock (ms)
  frameAt(9);
  on({ev: 'lobby', players: [{uid: 'me', name: 'Me', car: 0}, {uid: 'a', name: 'A', car: 1}, {uid: 'b', name: 'B', car: 2},
                             {uid: 'c', name: 'C', car: 0}, {uid: 'd', name: 'D', car: 1}, {uid: 'e', name: 'E', car: 2}], host: 'me', phase: 'running'});
  on({ev: 'rally', stage: Sg.build({seed: 'pinewood-run', biome: 'forest', night: false, length: 3000}).doc, key: 'c-0123456789ab', name: 'Pinewood'});
  on({ev: 'go', at: srv(9), countdown: 3});
  const C = window.HQV.rallyDebug().car, x0 = C.p[0], y0 = C.p[1], z0 = C.p[2];
  E.listener({x: x0, y: y0 + 2, z: z0, yaw: 0});            // the camera over your car
  const cars = {a: {dx: 8, dz: 0, v: 0}, b: {dx: 0, dz: 60, v: 20}, c: {dx: -100, dz: 0, v: 20}, d: {dx: 0, dz: -130, v: 20}, e: {dx: 0, dz: 170, v: 20}};
  const quiet = {};
  const snap = T => on({ev: 'snap', t: srv(T), cars: Object.keys(cars).filter(u => !quiet[u]).map(u => ({uid: u,
    x: Math.round((x0 + cars[u].dx)*100), z: Math.round((z0 + cars[u].dz)*100), y: Math.round(y0*100), yaw: 0, v: Math.round(cars[u].v*10)}))});
  let T = 10;
  const run = (sec, each) => { const end = T + sec; for(; T < end; T += 1/60){ if(each) each(T); if(Math.round(T*60) % 4 === 0) snap(T); frameAt(T); } };
  run(1);
  const own = engines.filter(e => e.sets.length && e.sets.every(s => !s.opt || (!s.opt.pos && !s.opt.sk)));
  out.first = {pool: S.state().pools.peer, kinds: peerVoices().map(e => e.kind).sort(), b: lastSet(peerVoices().find(e => e.kind === 'four')),
               own: own.map(e => e.kind)};
  const six = peerVoices().find(e => e.kind === 'six') || {sets: []}, k0 = six.sets.length;   // a (the six) from a standstill to 45 m/s
  run(6, T2 => { cars.a.v = Math.min(45, Math.max(0, (T2 - 11)*7.5)); });
  const ramp = six.sets.slice(k0);
  out.ramp = {gears: ramp.map(s => s.opt.gear), rpm: [Math.min.apply(null, ramp.map(s => s.rpm)), Math.max.apply(null, ramp.map(s => s.rpm))].map(Math.round)};
  cars.a.v = 0; run(1);                                     // stopped, then round its 1-2 shift (17.55 m/s)
  const k1 = six.sets.length;
  run(3, T2 => { cars.a.v = 17.55 + 0.3*Math.sin(T2*9); });
  const g = six.sets.slice(k1).map(s => s.opt.gear);
  out.hunt = {changes: g.filter((x, i) => i && x !== g[i - 1]).length, last: g[g.length - 1]};
  quiet.a = 1; run(1.5); out.stale = S.state().pools.peer;  // a stops reporting: silent after a second
  const peers = peerVoices();
  ctx.stop();
  out.destroyed = {pool: S.state().pools.peer || null, stopped: peers.every(e => e.stopped > 0), listener: E.listenerAt()};
  out.errors = errors;
  console.log(JSON.stringify(out));
})().catch(e => { console.log(JSON.stringify({crash: String(e && e.stack || e), errors})); });
"""


def run(script):
    r = subprocess.run([NODE, "-e", script, ROOT], capture_output=True, text=True, timeout=120)
    if r.returncode:
        raise AssertionError(r.stderr[-4000:])
    o = json.loads(r.stdout.strip().splitlines()[-1])
    if "crash" in o:
        raise AssertionError(o["crash"] + "\n" + "\n".join(o.get("errors") or []))
    return o


@unittest.skipUnless(NODE, "node is not installed")
class StrikeBlastsAndRockets(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.o = run(STRIKE)

    def test_the_statements_are_there(self):
        self.assertEqual(self.o["found"], {"booms": 2, "shot": True})     # a missile's blast, the Arena's blast rows, a bot's rocket

    def test_a_blast_is_heard_where_it_goes_off(self):
        w = self.o["want"]
        for b in self.o["boom"]:
            near = b["ahead5"]
            self.assertEqual((near["voice"], near["g"], near["pan"]), ("gain", 1, 0))   # within 10 m: full, straight ahead: centred
            self.assertAlmostEqual(near["start"], w["d5"], places=3)                    # sound travels: 5/343 s
            self.assertEqual(near["bands"], [1100, 170, 420])                           # the core's boom synth (silent before)
            self.assertTrue(near["master"])                                             # the Game sounds volume, not ambience
            right, left = b["right60"], b["left60"]
            self.assertAlmostEqual(right["g"], w["g60"], places=3)                     # the blast kind's fade, not full volume
            self.assertLess(right["g"], 0.2)
            self.assertGreater(right["pan"], 0.8)                                       # on your right: right
            self.assertLess(left["pan"], -0.8)
            self.assertAlmostEqual(right["start"], w["d60"], places=3)
            self.assertIsNone(b["far"])                                                 # past 400 m: nothing is made

    def test_a_bots_rocket_launch_is_at_the_bot(self):
        w = self.o["want"]
        r, l = self.o["shot"]["right40"], self.o["shot"]["left40"]
        self.assertAlmostEqual(r["g"], w["g40"], places=3)                     # no longer full volume wherever the bot is
        self.assertGreater(r["pan"], 0.8)
        self.assertLess(l["pan"], -0.8)
        self.assertAlmostEqual(r["start"], w["d40"], places=3)
        self.assertEqual(r["bands"], [1800])                                   # still the launcher's shot (opt.w passes through)

    def test_voices_ears_volume_and_old_engines(self):
        o = self.o
        self.assertEqual(o["voices"]["live4"], 4)                              # the blast kind's four voices
        self.assertEqual(o["voices"]["made5"], 0)                              # a fifth as far off is not heard
        self.assertEqual(o["voices"]["after"], [8, 20, 20, 20])                # a nearer one takes the farthest's voice
        self.assertIsNotNone(o["ambient0"])                                    # Ambient sounds at 0% does not mute a blast
        n = o["noEars"]
        self.assertEqual((n["g"], n["pan"], n["start"]), (1, 0, 0))            # no ears (2D map view): centred, full, at once
        self.assertIsNone(o["muted"])                                          # Game sounds 0 (mute, Calm): nothing
        self.assertEqual(o["old"], [["boom", None], ["boom", None], ["shot", {"w": 3}]])   # an engine without sfxAt


@unittest.skipUnless(NODE, "node is not installed")
class KartRacersEngines(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.o = run(KART)

    def test_the_nearest_three_are_heard_where_they_are(self):
        o = self.o
        self.assertEqual(o["errors"], [])
        f = o["first"]
        self.assertEqual(f["pool"], ["a/1", "b/2", "c/3"])                     # nearest first; e (away, 3 m) and g (200 m) never
        self.assertEqual(sorted(f["kinds"]), ["diesel", "hotrod", "turbo"])    # each car's own engine voice
        for k, xz in (("a", (10, 0)), ("b", (0, 30)), ("c", (-50, 0))):
            s = f[k]
            self.assertEqual(s["opt"]["sk"], "peer")
            self.assertAlmostEqual(s["opt"]["pos"]["x"], xz[0], places=3)
            self.assertAlmostEqual(s["opt"]["pos"]["z"], xz[1], places=3)
            self.assertAlmostEqual(s["rpm"], 900 + 6500 * 20 / 30, places=3)   # the revs of a car at 20 m/s
            self.assertEqual(s["opt"]["speed"], 20)
        self.assertLess(f["pan"][0], -0.5)                                     # a is on the camera's left
        self.assertEqual(f["pan"][1], 0)                                       # b is straight ahead
        self.assertGreater(f["pan"][2], 0.5)                                   # c is on its right
        self.assertEqual(f["own"], ["v8"])                                     # your own engine: no position, as before
        self.assertGreater(f["ownSets"], 0)
        self.assertEqual(o["ambient0"], f["pool"])                             # not ambience: the Ambient slider leaves them

    def test_finished_quiet_and_out_cars(self):
        o = self.o
        self.assertEqual((o["finished"]["rpm"], o["finished"]["opt"]["speed"]), (900, 0))   # after the flag: idling
        self.assertEqual((o["stale"]["rpm"], o["stale"]["opt"]["speed"]), (900, 0))         # no word for 2 s: idling
        self.assertGreater(o["moving"], 900)
        self.assertEqual(o["dnf"]["pool"], ["b/2", "c/3", "d/4"])              # out of the race: silent; the next one in
        self.assertIsNotNone(o["dnf"]["d"])
        self.assertAlmostEqual(o["dnf"]["d"]["opt"]["pos"]["z"], -80, places=3)

    def test_volume_ears_and_leaving(self):
        o = self.o
        self.assertEqual(o["muted"], [])                                       # Game sounds 0: nothing
        self.assertEqual(o["noEars"], {"pool": [], "made": 0})                 # no view: nothing
        self.assertEqual(o["back"], ["b/2", "c/3", "d/4"])
        self.assertEqual(o["destroyed"], {"pool": None, "stopped": True, "listener": None})


@unittest.skipUnless(NODE, "node is not installed")
class RallyDriversEngines(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.o = run(RALLY)

    def test_the_nearest_three_are_heard_where_they_are(self):
        o = self.o
        self.assertEqual(o["errors"], [])
        f = o["first"]
        self.assertEqual(f["pool"], ["a/1", "b/2", "c/0"])                     # nearest first; d (130 m) waits, e (170 m) never
        self.assertEqual(f["kinds"], ["four", "six", "turbo4"])                # each car's own engine voice
        self.assertEqual(f["b"]["opt"]["sk"], "peer")
        self.assertEqual(f["b"]["opt"]["speed"], 20)
        self.assertEqual(f["own"], ["turbo4"])                                 # your own engine: no position, as before

    def test_gears_follow_the_speed_without_hunting(self):
        r = self.o["ramp"]
        self.assertEqual(r["gears"], sorted(r["gears"]))                       # up through the box as it speeds up
        self.assertEqual(r["gears"][0], 1)
        self.assertGreaterEqual(max(r["gears"]), 4)
        self.assertGreaterEqual(r["rpm"][0], 900)                              # inside the game's 900..7600
        self.assertLessEqual(r["rpm"][1], 7600)
        self.assertEqual(self.o["hunt"], {"changes": 1, "last": 2})            # round a shift point: one upshift, no hunting

    def test_a_car_the_arena_stopped_moving_falls_silent(self):
        o = self.o
        self.assertEqual(o["stale"], ["b/2", "c/0", "d/1"])
        self.assertEqual(o["destroyed"], {"pool": None, "stopped": True, "listener": None})


class EveryCameraIsTheEars(unittest.TestCase):
    """Each 3D game sets the listener from the camera it renders with, and clears it when it goes."""
    CASES = [
        ("fps.js", r"if\(E\.listener\) E\.listener\(camera\);[^\n]*\n\s*renderer\.render\(scene, camera\);"),
        ("platformer.js", r"if\(E\.listener\) E\.listener\(camera\);[^\n]*\n\s*renderer\.render\(scene, camera\);"),
        ("golf.js", r"HQV\.engine\.listener\) HQV\.engine\.listener\(camera\);[^\n]*\n\s*renderer\.render\(scene, camera\);"),
        ("bowling.js", r"if\(E\.listener\) E\.listener\(th\.cam\);[^\n]*\n\s*th\.r\.render\(th\.scene, th\.cam\);"),
        ("gp.js", r"R3\.render\([^\n]*\n\s*if\(E\.listener\) E\.listener\(R3\.camera\);"),
        ("rally.js", r"R3\.render\([^\n]*\n\s*if\(E\.listener\) E\.listener\(R3\.camera\);"),
        ("kart.js", r"if\(E\.listener\) E\.listener\(camera\);[^\n]*\n\s*renderer\.render\(scene, camera\);"),
        ("strike.js", r"if\(E\.listener\) E\.listener\(camera\);[^\n]*\n\s*renderer\.render\(scene, camera\);"),
    ]

    def test_listener_from_the_rendered_camera(self):
        for name, pat in self.CASES:
            self.assertRegex(read("games", name), pat, name)

    def test_cleared_when_the_game_goes(self):
        for name, _ in self.CASES:
            src = read("games", name)
            i = src.index("LaneView.prototype.destroy = function(){" if name == "bowling.js" else "V.destroy = function(){")
            self.assertIn("listener(null)", src[i:i + 400], name)

    def test_guarded_for_older_engines(self):
        for name, _ in self.CASES:
            src = read("games", name)
            for m in re.finditer(r"[\w.]*listener\(", src):
                line = src[:m.start()].rsplit("\n", 1)[-1]
                self.assertRegex(line, r"if\((E\.listener|window\.HQV && HQV\.engine && HQV\.engine\.listener)\) $", name)


class OwnAndUiSoundsStayCentred(unittest.TestCase):
    def test_strike_keeps_your_own_shots_centred(self):
        src = read("games", "strike.js")
        self.assertIn('E.sfx("shot", {w: V.w});', src)                        # your shot, at your ears
        self.assertIn('if(m.k === myId()) E.sfx("hit");', src)                # your kill's tick
        self.assertEqual(src.count('E.sfx("boom")'), src.count('else E.sfx("boom")'))   # a centred boom only for old engines
        self.assertEqual(src.count('E.sfx("shot", {w: LAUNCH_W})'), src.count('else E.sfx("shot", {w: LAUNCH_W})'))

    def test_own_engines_keep_no_position(self):
        self.assertIn("V.eng.set(C.rpm, {thr: thr > 0 ? thr : 0});", read("games", "kart.js"))
        self.assertIn("{thr: C.tel.throttle, gear: C.tel.gear});", read("games", "rally.js"))
        for name in ("kart.js", "rally.js"):
            src = read("games", name)
            self.assertIn("if(!E.pool", src, name)                             # an engine from before pools: no peers, no error
            self.assertEqual(src.count("peersStop()"), 3, name)                # defined, and called on reset and on leaving

    def test_two_d_games_and_ui_make_no_positional_call(self):
        files = [("games", f) for f in ("td.js", "typerace.js", "fishart.js", "fishing.js", "multi.js")]
        files += [("ui", "app", f) for f in ("03-store.js", "08-alerts.js", "09-drawer.js", "19-arena-rooms.js", "20-arena-voice.js",
                                             "23-progress.js", "27-play.js", "29-music.js", "39-boombox.js")]
        for parts in files:
            src = read(*parts)
            self.assertNotRegex(src, r"sfxAt\(|spatialOut\(|\.pool\(|E\.loop\(|engine\.loop\(|\.listener\(|\.hear\(", "/".join(parts))
        self.assertIn('HQV.engine.sfx("levelup")', read("ui", "app", "23-progress.js"))
        self.assertIn('HQV.engine.sfx("go")', read("ui", "app", "27-play.js"))


if __name__ == "__main__":
    unittest.main()
