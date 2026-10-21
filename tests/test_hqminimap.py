"""games/hqminimap.js (the 3D City minimap, nav-river spec 3.1): the pure view maths and the mounted
minimap under node, with a tiny fake DOM and a stub canvas 2D context that counts its calls (no jsdom).

Checks: toMini/fromMini round-trip in both modes and at several zooms, and point the right way
(N = +z up, E = -x right north-up; where you face is up heading-up); zoomFor; a click on a turned
map picks the right world point; setWorld draws the @2 Commons, a tier-1 and a tier-5 island, the
@1 grid and a synthetic river without throwing (the river's water only when there is one, fewer
roads at tier 1); frame() never touches the static layer; DPR sizing, the buttons, wheel and keys
(which never leak), destroy; plus source checks (textContent only, ease not Math.min(1, dt)) and
the CSS. Skipped without node."""
import json
import os
import re
import shutil
import subprocess
import unittest

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
JS = os.path.join(ROOT, "games", "hqminimap.js")
CSS = os.path.join(ROOT, "games", "hqminimap.css")
FIX = os.path.join(ROOT, "tests", "fixtures")
NODE = shutil.which("node")


def read(p):
    with open(p, encoding="utf-8") as f:
        return f.read()

SCRIPT = r"""
const fs = require('fs'), zlib = require('zlib');
const [JS, WORLD, AT1, AT2, ISLAND] = process.argv.slice(1);
// ---- a stub 2D context: counts every call, remembers the fillStyle of each fill ----
function fakeCtx(cv){
  const ctx = {canvas: cv, calls: 0, fills: [], strokes: 0, images: [], log: {}};
  ['save','restore','translate','rotate','scale','beginPath','moveTo','lineTo','arcTo','closePath','arc','rect',
   'quadraticCurveTo','bezierCurveTo','fillRect','clearRect','setTransform','fillText','strokeText','clip'].forEach(k => {
    ctx[k] = (...a) => { ctx.calls++; ctx.log[k] = (ctx.log[k] || 0) + 1; };
  });
  ctx.fill = () => { ctx.calls++; ctx.fills.push(ctx.fillStyle); };
  ctx.stroke = () => { ctx.calls++; ctx.strokes++; };
  ctx.drawImage = (img, ...a) => { ctx.calls++; ctx.images.push([img, a]); };
  ctx.measureText = t => ({width: String(t).length * 6});
  return ctx;
}
class El {
  constructor(tag){ this.tagName = tag.toUpperCase(); this.children = []; this.parentNode = null; this.className = '';
    this.attrs = {}; this.listeners = {}; this.style = {}; this.textContent = ''; this.hidden = false; this.id = '';
    this.width = 300; this.height = 150; this.clientWidth = 0; this.clientHeight = 0; }
  appendChild(c){ c.parentNode = this; this.children.push(c); return c; }
  removeChild(c){ this.children = this.children.filter(x => x !== c); c.parentNode = null; return c; }
  setAttribute(k, v){ this.attrs[k] = String(v); }
  getAttribute(k){ return k in this.attrs ? this.attrs[k] : null; }
  addEventListener(t, f){ (this.listeners[t] = this.listeners[t] || []).push(f); }
  removeEventListener(t, f){ this.listeners[t] = (this.listeners[t] || []).filter(x => x !== f); }
  fire(t, ev){ ev = Object.assign({type: t, target: this, defaultPrevented: false, stopped: false,
      preventDefault(){ this.defaultPrevented = true; }, stopPropagation(){ this.stopped = true; }}, ev || {});
    (this.listeners[t] || []).slice().forEach(f => f(ev)); return ev; }
  click(){ return this.fire('click'); }
  getContext(k){ return this.tagName === 'CANVAS' && k === '2d' ? (this._ctx = this._ctx || fakeCtx(this)) : null; }
  getBoundingClientRect(){ return this._rect || {left: 0, top: 0, width: 200, height: 200}; }
  all(){ let out = [this]; this.children.forEach(c => { out = out.concat(c.all()); }); return out; }
}
const made = [];
const document = {createElement: t => { const e = new El(t); made.push(e); return e; }};
const winL = {};
let clock = 1000;
const window = {
  HQV: {}, document, devicePixelRatio: 1, console,
  performance: {now: () => clock},
  addEventListener(t, f){ (winL[t] = winL[t] || []).push(f); },
  removeEventListener(t, f){ winL[t] = (winL[t] || []).filter(x => x !== f); },
  getComputedStyle: () => ({getPropertyValue: n => n === '--bg' ? ' #0c0d10' : ''})
};
new Function('window', fs.readFileSync(WORLD, 'utf8'))(window);
new Function('window', fs.readFileSync(JS, 'utf8'))(window);
const M = window.HQV.hqminimap, WD = window.HQV.world, out = {};
const gz = p => JSON.parse(zlib.gunzipSync(fs.readFileSync(p)).toString('utf8'));

// ---- pure: round trips, orientation, zoomFor ----
let worst = 0, n = 0;
for(const mode of ['heading', 'north'])
  for(const span of [60, 220, 600, 1500])
    for(const yaw of [0, 0.7, -2.1, Math.PI, 5.5]){
      const V = M.viewFor(mode, 123.4, -456.7, yaw, span, 200, 200);
      for(const [x, z] of [[123.4, -456.7], [0, 0], [200, -400], [-50.5, -500.25], [400, 100]]){
        const p = M.toMini(V, x, z), w = M.fromMini(V, p[0], p[1]);
        worst = Math.max(worst, Math.abs(w[0] - x), Math.abs(w[1] - z)); n++;
      }
      for(const [px, py] of [[0, 0], [200, 200], [37, 151], [100, 124]]){
        const w = M.fromMini(V, px, py), p = M.toMini(V, w[0], w[1]);
        worst = Math.max(worst, Math.abs(p[0] - px), Math.abs(p[1] - py)); n++;
      }
    }
out.round = {worst, n};
const N = M.viewFor('north', 0, 0, 1.2, 200, 200, 200);
out.north = {anchor: M.toMini(N, 0, 0), up: M.toMini(N, 0, 50), east: M.toMini(N, -50, 0)};
const H0 = M.viewFor('heading', 10, 20, Math.PI/2, 200, 200, 200);   // facing +x (west)
out.heading = {anchor: M.toMini(H0, 10, 20), ahead: M.toMini(H0, 60, 20), right: M.toMini(H0, 10, 70)};
out.zoom = [0, 1.6, 5, 10, 16.67, 30, -16.67, NaN, null].map(v => M.zoomFor(v));
let mono = true, prev = 0;
for(let v = 0; v <= 40; v += 0.25){ const z = M.zoomFor(v); if(z < prev - 1e-9) mono = false; prev = z; }
out.zoomMono = mono;

// ---- fixtures ----
const at1 = WD.pack(gz(AT1)), at2 = WD.pack(gz(AT2)), isl = WD.pack(gz(ISLAND));
// a synthetic river on the Commons: from past the east coast (x ~ 891 m) inland to a basin near (300, 50) m
const basin = [];
for(let i = 0; i < 16; i++){ const a = i/16*2*Math.PI; basin.push([30000 + Math.round(7900*Math.cos(a)), 5000 + Math.round(7900*Math.sin(a))]); }
const river = {center: [[89113, 0], [60000, 3000], [30000, 5000]], width_cm: 3600, basin: {x: 30000, z: 5000, r: 7900},
  poly: [[95000, -1800], [95000, 1800], [37000, 6800]].concat(basin.slice(4, 13)).concat([[37000, 3200]])};

// ---- mounted ----
// a ResizeObserver that hands its callback out, so a test can fire it (Chrome's loop error comes from sizing the
// canvas inside that callback)
const roCbs = [];
window.ResizeObserver = class { constructor(cb){ roCbs.push(cb); } observe(){} disconnect(){} };
const stage = new El('div');
const picks = [], said = []; let expanded = 0;
const mm = M.mount(stage, {onPick: (x, z) => picks.push([x, z]), onExpand: () => expanded++, announce: t => said.push(t)});
const root = stage.children[0];
root.clientWidth = 200; root.clientHeight = 200;
const all = root.all(), byClass = c => all.find(e => e.className.split(' ').includes(c));
const cv = byClass('hq3d-minimap-canvas');
out.parts = ['hq3d-minimap', 'hq3d-minimap-canvas', 'hq3d-minimap-in', 'hq3d-minimap-out', 'hq3d-minimap-mode', 'hq3d-minimap-expand'].filter(c => !byClass(c));
out.buttons = all.filter(e => e.tagName === 'BUTTON').map(b => [b.textContent, b.getAttribute('aria-label'), b.getAttribute('type')]);
out.defaultMode = mm.mode();

function draws(W, tier, o){
  const before = made.length;
  let err = null;
  try { mm.setWorld(W, tier, o); } catch(e){ err = String(e && e.stack || e); }
  const L = mm.layers(), g = L.static && L.static._ctx;
  return {err, w: L.static && L.static.width, places: L.places, strokes: g ? g.strokes : 0,
          water: g ? g.fills.filter(f => f === '#1a4a6b').length : 0, land: g ? g.fills.filter(f => f === '#1d2620').length : 0,
          made: made.length - before};
}
out.fx = {
  at1: draws(at1, null, {}),
  at2: draws(at2, 5, {}),
  noRiver: draws(Object.assign(Object.create(at2), {river: null}), 5, {}),
  isl1: draws(isl, 1, {}),
  isl5: draws(isl, 5, {}),
  river: draws(at2, 5, {river}),
  riverOnW: draws(Object.assign(Object.create(at2), {river}), 5, {}),
  hostPlaces: draws(at2, 5, {places: [{id: 'dock:0', kind: 'dock', x: 800, z: 0}, {id: 'myhq', kind: 'myhq', x: 10, z: 10},
                                      {id: 'x', kind: 'bogus', x: 0, z: 0}, {id: 'y', kind: 'hq', x: 'nope', z: 1}]})
};

// frame(): the static layer is untouched, the overlay blits it
mm.setWorld(at2, 5, {river});
const L = mm.layers(), sg = L.static._ctx, ag = L.atlas._ctx, og = cv._ctx;
const sCalls = sg.calls, aCalls = ag.calls;
const route = new Float64Array(4000);
for(let i = 0; i < 2000; i++){ route[2*i] = i*0.5; route[2*i + 1] = Math.sin(i/50)*40; }
const others = []; for(let i = 0; i < 20; i++) others.push({x: i*7, z: -i*5, col: 0x3fa66a + i});
og.images = [];
let t0 = process.hrtime.bigint();
const FR = 400;
for(let i = 0; i < FR; i++){ clock += 16; mm.frame({x: 20 + i*0.1, z: 5, yaw: 0.3 + i*0.01, speed: 8, route, waypoint: {x: 600, z: 40}, others}); }
let t1 = process.hrtime.bigint();
out.frame = {staticSame: sg.calls === sCalls, atlasSame: aCalls === ag.calls, msPer: Number(t1 - t0)/1e6/FR,
  blitStatic: og.images.filter(x => x[0] === L.static).length, blitAtlas: og.images.filter(x => x[0] === L.atlas).length,
  texts: og.log.fillText || 0};
// a world with no static layer yet, or none at all, still frames
mm.setWorld(null); let noWorld = null; try { mm.frame({x: 0, z: 0, yaw: 0}); } catch(e){ noWorld = String(e); }
out.noWorld = noWorld;
mm.setWorld(at2, 5, {river});

// the span eases to zoomFor(speed): walking for a while settles at 220 m, driving fast at 600 m
for(let i = 0; i < 300; i++){ clock += 16; mm.frame({x: 0, z: 0, yaw: 0, speed: 0}); }
out.spanWalk = mm.view().span;
for(let i = 0; i < 300; i++){ clock += 16; mm.frame({x: 0, z: 0, yaw: 0, speed: 25}); }
out.spanDrive = mm.view().span;
// an explicit dt wins and a hitch (10 s) is clamped, never overshooting
mm.frame({x: 0, z: 0, yaw: 0, speed: 0, dt: 10});
out.spanHitch = mm.view().span;

// a click on a turned, heading-up map: the world point under it
const P = {x: 100, z: -50, yaw: 0.7};
for(let i = 0; i < 300; i++){ clock += 16; mm.frame(Object.assign({speed: 0}, P)); }
const V = mm.view();
cv._rect = {left: 500, top: 300, width: 200, height: 200};
const ev = cv.fire('click', {clientX: 600, clientY: 340});
const want = M.fromMini(V, 100, 40);
// straight above you by 50 px is 50 px of map ahead of you: forward = (sin yaw, cos yaw)
cv.fire('click', {clientX: 600, clientY: 300 + 200*0.62 - 50});
const d = 50*V.span/200;
out.click = {got: picks[0], want, stopped: ev.stopped, ahead: picks[1], aheadWant: [P.x + Math.sin(P.yaw)*d, P.z + Math.cos(P.yaw)*d],
             rot: V.rot, ay: V.ay};
// the CSS box scaled (a transform): px are mapped through the rect's size
cv._rect = {left: 0, top: 0, width: 100, height: 100};
cv.fire('click', {clientX: 50, clientY: 50});
out.clickScaled = {got: picks[2], want: M.fromMini(V, 100, 100)};
cv.fire('click', {clientX: 150, clientY: 50});     // outside the box: nothing
out.picksAfterOutside = picks.length;

// buttons: zoom, mode, expand
const bIn = byClass('hq3d-minimap-in'), bOut = byClass('hq3d-minimap-out'), bMode = byClass('hq3d-minimap-mode'), bExp = byClass('hq3d-minimap-expand');
const spanBefore = mm.view().span;
bIn.click(); for(let i = 0; i < 300; i++){ clock += 16; mm.frame(Object.assign({speed: 0}, P)); }
out.zoomIn = mm.view().span / spanBefore;
for(let i = 0; i < 6; i++) bOut.click();
for(let i = 0; i < 300; i++){ clock += 16; mm.frame(Object.assign({speed: 0}, P)); }
out.zoomOutMax = mm.view().span / 220;
root.fire('wheel', {deltaY: -100}); root.fire('wheel', {deltaY: -100});
for(let i = 0; i < 300; i++){ clock += 16; mm.frame(Object.assign({speed: 0}, P)); }
out.wheel = mm.view().span / 220;
const wheelEv = root.fire('wheel', {deltaY: 0});
out.wheelPrevented = [wheelEv.defaultPrevented, wheelEv.stopped];
bMode.click();
mm.frame(Object.assign({speed: 0}, P));
out.north = Object.assign(out.north, {mode: mm.mode(), pressed: bMode.getAttribute('aria-pressed'), rot: mm.view().rot, ay: mm.view().ay, dataMode: root.getAttribute('data-mode')});
mm.setMode('heading');
out.backToHeading = [mm.mode(), bMode.getAttribute('aria-pressed')];
mm.setMode('bogus');
out.bogusMode = mm.mode();
bExp.click();
out.expanded = expanded;
out.said = said.slice();

// keys never leak; Enter on a button presses it once
const k1 = root.fire('keydown', {key: 'Enter', target: bExp});
const k2 = root.fire('keyup', {key: 'Enter', target: bExp});
const k3 = root.fire('keydown', {key: 'w', target: bIn});
const k4 = root.fire('keydown', {key: 'Tab', target: bIn});
out.keys = {expanded: expanded, enter: [k1.defaultPrevented, k1.stopped], up: [k2.defaultPrevented, k2.stopped],
            w: [k3.defaultPrevented, k3.stopped], tab: [k4.defaultPrevented, k4.stopped]};

// DPR: the canvas is CSS size x devicePixelRatio
window.devicePixelRatio = 2;
const stage2 = new El('div');
const mm2 = M.mount(stage2, {});
const r2 = stage2.children[0]; r2.clientWidth = 160; r2.clientHeight = 160;
mm2.setWorld(isl, 3, {});
mm2.frame({x: 0, z: 0, yaw: 0});
const cv2 = r2.all().find(e => e.tagName === 'CANVAS');
out.dpr = [cv2.width, cv2.height, mm2.view().w, mm2.layers().atlas.height];

// a resize: the observer callback writes nothing (no layout change inside it); the next frame() sizes the canvas
r2.clientWidth = 200; r2.clientHeight = 200;
const roW = cv2.width;
roCbs.forEach(cb => cb([]));
const inCb = cv2.width;
mm2.frame({x: 0, z: 0, yaw: 0});
out.ro = {observers: roCbs.length, before: roW, inCallback: inCb, afterFrame: cv2.width, w: mm2.view().w};

// the big map (M): grows north-up over the whole world, a drag pans without a waypoint, Escape closes it
const scrim = stage.children[1];
clock += 16; mm.frame(Object.assign({speed: 0}, P));
const sm = mm.view().span, rotSmall = mm.view().rot;
mm.expand(true);
const clsOpen = root.className, scrimOpen = scrim.className;
root.clientWidth = 900; root.clientHeight = 600; roCbs.forEach(cb => cb([]));
for(let i = 0; i < 300; i++){ clock += 16; mm.frame(Object.assign({speed: 0}, P)); }
const VB = mm.view();
cv._rect = {left: 0, top: 0, width: 900, height: 600};
const nPick = picks.length;
cv.fire('pointerdown', {button: 0, clientX: 400, clientY: 300});
cv.fire('pointermove', {buttons: 1, clientX: 500, clientY: 300});
cv.fire('click', {clientX: 500, clientY: 300});
for(let i = 0; i < 300; i++){ clock += 16; mm.frame(Object.assign({speed: 0}, P)); }
const VP = mm.view();
cv.fire('pointerdown', {button: 0, clientX: 450, clientY: 300}); cv.fire('click', {clientX: 450, clientY: 300});
const esc = root.fire('keydown', {key: 'Escape', target: cv});
for(let i = 0; i < 300; i++){ clock += 16; mm.frame(Object.assign({speed: 0}, P)); }
out.big = {cls: clsOpen, scrim: scrimOpen, small: sm, span: VB.span, w: VB.w, rot: VB.rot, ay: VB.ay,
           dragPick: picks.length - nPick, panDx: VP.x - VB.x, pickAfter: picks.length - nPick, esc: esc.stopped,
           after: [mm.isBig(), Math.round(mm.view().rot*1000)/1000, mm.view().ay, Math.round(rotSmall*1000)/1000, root.className]};

// destroy: gone from the stage, listeners off
mm.destroy(); mm2.destroy();
out.destroyed = {children: stage.children.length, clickL: (cv.listeners.click || []).length, resize: (winL.resize || []).length};
mm.frame({x: 0, z: 0, yaw: 0});
process.stdout.write(JSON.stringify(out));
"""


@unittest.skipUnless(NODE, "node not installed")
class MinimapTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        r = subprocess.run([NODE, "-e", SCRIPT, "--", JS, os.path.join(ROOT, "games", "world.js"),
                            os.path.join(FIX, "claude-hq@1.json.gz"), os.path.join(FIX, "claude-hq@2.json.gz"),
                            os.path.join(FIX, "island@2.json.gz")],
                           capture_output=True, text=True, timeout=120)
        if r.returncode != 0:
            raise AssertionError(r.stderr)
        cls.o = json.loads(r.stdout)

    def test_round_trip(self):
        self.assertEqual(self.o["round"]["n"], 360)
        self.assertLess(self.o["round"]["worst"], 1e-6)

    def test_orientation(self):
        n, h = self.o["north"], self.o["heading"]
        self.assertAlmostEqual(n["anchor"][0], 100)
        self.assertAlmostEqual(n["anchor"][1], 100)
        self.assertAlmostEqual(n["up"][0], 100)
        self.assertLess(n["up"][1], 100)                  # N (+z) is up north-up, whatever the yaw
        self.assertGreater(n["east"][0], 100)             # E (-x) is right
        self.assertAlmostEqual(n["east"][1], 100)
        self.assertAlmostEqual(h["anchor"][1], 124)       # heading-up anchors 62% down
        self.assertAlmostEqual(h["ahead"][0], 100)        # facing +x: a point ahead is straight up
        self.assertLess(h["ahead"][1], 124)
        self.assertGreater(h["right"][0], 100)            # facing west, north (+z) is on your right
        self.assertAlmostEqual(h["right"][1], 124)

    def test_zoom_for(self):
        z = self.o["zoom"]
        self.assertEqual(z[0], 220)
        self.assertEqual(z[1], 220)
        self.assertTrue(220 < z[2] < z[3] < 600)
        self.assertAlmostEqual(z[4], 600, places=1)
        self.assertEqual(z[5], 600)
        self.assertEqual(z[6], z[4])                      # reversing counts as speed
        self.assertEqual(z[7], 220)
        self.assertEqual(z[8], 220)
        self.assertTrue(self.o["zoomMono"])

    def test_span_eases(self):
        self.assertAlmostEqual(self.o["spanWalk"], 220, places=2)
        self.assertAlmostEqual(self.o["spanDrive"], 600, places=2)
        self.assertGreater(self.o["spanHitch"], 220)       # 10 s clamps to 0.25 s: still on the way down
        self.assertLess(self.o["spanHitch"], 600)

    def test_click_rotated(self):
        c = self.o["click"]
        self.assertAlmostEqual(c["rot"], -0.7)
        for a, b in zip(c["got"], c["want"]):
            self.assertAlmostEqual(a, b, places=6)
        for a, b in zip(c["ahead"], c["aheadWant"]):
            self.assertAlmostEqual(a, b, places=4)
        self.assertTrue(c["stopped"])
        for a, b in zip(self.o["clickScaled"]["got"], self.o["clickScaled"]["want"]):
            self.assertAlmostEqual(a, b, places=6)
        self.assertEqual(self.o["picksAfterOutside"], 3)

    def test_set_world_fixtures(self):
        fx = self.o["fx"]
        for k, v in fx.items():
            self.assertIsNone(v["err"], k)
            self.assertGreater(v["w"], 1000, k)
            self.assertGreater(v["strokes"], 100, k)
        self.assertEqual(fx["at1"]["places"], 0)           # @1 has no civic sites
        self.assertGreater(fx["at2"]["places"], 10)        # the Commons' civic sites
        self.assertEqual(fx["at1"]["water"], 0)
        self.assertEqual(fx["at2"]["water"], 1)            # the generated river (W.river)
        self.assertEqual(fx["noRiver"]["water"], 0)
        self.assertEqual(fx["river"]["water"], 1)
        self.assertEqual(fx["riverOnW"]["water"], 1)       # W.river when the host passes none
        self.assertGreaterEqual(fx["at2"]["land"], 1)
        self.assertLess(fx["isl1"]["strokes"], fx["isl5"]["strokes"])   # roads above the tier are left out
        self.assertLess(fx["isl1"]["places"], fx["isl5"]["places"])
        self.assertEqual(fx["hostPlaces"]["places"], 2)     # unknown kinds and junk coordinates dropped

    def test_frame_keeps_static(self):
        f = self.o["frame"]
        self.assertTrue(f["staticSame"])
        self.assertTrue(f["atlasSame"])
        self.assertEqual(f["blitStatic"], 400)
        self.assertGreater(f["blitAtlas"], 0)
        self.assertEqual(f["texts"], 400)                  # the N marker
        self.assertLess(f["msPer"], 1.0)
        self.assertIsNone(self.o["noWorld"])

    def test_dom(self):
        self.assertEqual(self.o["parts"], [])
        self.assertEqual(self.o["defaultMode"], "heading")
        for text, label, typ in self.o["buttons"]:
            self.assertTrue(text)
            self.assertTrue(label)
            self.assertEqual(typ, "button")
        self.assertAlmostEqual(self.o["zoomIn"], 1/1.5, places=3)
        self.assertAlmostEqual(self.o["zoomOutMax"], 1.5**3, places=3)   # clamped at 3 steps out
        self.assertAlmostEqual(self.o["wheel"], 1.5, places=3)
        self.assertEqual(self.o["wheelPrevented"], [True, True])
        n = self.o["north"]
        self.assertEqual([n["mode"], n["pressed"], n["rot"], n["ay"], n["dataMode"]], ["north", "true", 0, 0.5, "north"])
        self.assertEqual(self.o["backToHeading"], ["heading", "false"])
        self.assertEqual(self.o["bogusMode"], "heading")
        self.assertEqual(self.o["expanded"], 1)
        self.assertIn("Minimap: north up", self.o["said"])

    def test_big_map(self):
        b = self.o["big"]
        self.assertIn("hq3d-minimap-big", b["cls"].split())
        self.assertIn("hq3d-minimap-scrim-on", b["scrim"].split())
        self.assertEqual(b["w"], 900)                       # the canvas follows the grown box
        self.assertGreater(b["span"], 2000)                 # the whole world (2048 m and its sea margin)
        self.assertAlmostEqual(b["rot"], 0, places=3)       # swung north-up
        self.assertAlmostEqual(b["ay"], 0.5, places=3)
        self.assertEqual(b["dragPick"], 1)                  # the drag set no waypoint; the later plain click did
        self.assertAlmostEqual(b["panDx"], 100*b["span"]/900, delta=1)    # grab and drag right: the view moves west (+x)
        self.assertTrue(b["esc"])
        isBig, rot, ay, rotSmall, cls = b["after"]
        self.assertFalse(isBig)
        self.assertEqual(rot, rotSmall)                     # back to heading-up
        self.assertEqual(ay, 0.62)
        self.assertNotIn("hq3d-minimap-big", cls.split())

    def test_keys_never_leak(self):
        k = self.o["keys"]
        self.assertEqual(k["expanded"], 2)                 # Enter pressed the expand button once
        self.assertEqual(k["enter"], [True, True])
        self.assertEqual(k["up"], [True, True])
        self.assertEqual(k["w"], [True, True])
        self.assertEqual(k["tab"], [False, True])          # Tab still moves focus, but never leaks

    def test_dpr(self):
        self.assertEqual(self.o["dpr"], [320, 320, 160, 40])

    def test_resize_observer_never_sizes_in_its_callback(self):
        ro = self.o["ro"]
        self.assertEqual(ro["observers"], 2)
        self.assertEqual(ro["inCallback"], ro["before"], "no canvas write inside the ResizeObserver callback")
        self.assertEqual([ro["afterFrame"], ro["w"]], [400, 200], "the next frame sizes it (DPR 2)")

    def test_destroy(self):
        self.assertEqual(self.o["destroyed"], {"children": 0, "clickL": 0, "resize": 0})

    def test_source_rules(self):
        src = read(JS)
        for bad in ("innerHTML", "outerHTML", "insertAdjacentHTML", "document.write", "eval(", "fetch(", "XMLHttpRequest"):
            self.assertNotIn(bad, src)
        self.assertIsNone(re.search(r"Math\.min\(\s*1\s*,[^)]*dt", src), "use ease(k, dt), never Math.min(1, dt*k)")
        self.assertIn("HQV.hqminimap = ", src)

    def test_css(self):
        css = read(CSS)
        box = re.search(r"\.hq3d-minimap\{([^}]*)\}", css).group(1)
        for want in ("right:12px", "bottom:12px", "width:200px", "height:200px", "overflow:hidden"):
            self.assertIn(want, box)
        narrow = re.search(r"@media \(max-width:699\.98px\)\{(.*?)\n\}", css, re.S).group(1)
        self.assertIn("width:160px", narrow)
        self.assertIn(".hq3d-drive{right:184px}", narrow)
        self.assertIn(".hq3d-drive{right:224px}", css)


if __name__ == "__main__":
    unittest.main()
