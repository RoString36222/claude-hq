"""games/hqhud.js (3D city HUD, build spec 2.6): the pure helpers and the mounted HUD under node,
with a tiny fake DOM (no jsdom), plus a source check of the `/* 3D city HUD */` CSS section.
The node parts are skipped without node."""
import json
import os
import re
import shutil
import subprocess
import unittest

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
JS = os.path.join(ROOT, "games", "hqhud.js")
CSS = os.path.join(ROOT, "ui", "hq.css")

SCRIPT = r"""
const fs = require('fs');
// ---- a tiny fake DOM: just what hqhud.js touches ----
class ClassList {
  constructor(el){ this.el = el; }
  _get(){ return this.el.className ? this.el.className.split(/\s+/).filter(Boolean) : []; }
  add(c){ const l = this._get(); if(!l.includes(c)) l.push(c); this.el.className = l.join(' '); }
  remove(c){ this.el.className = this._get().filter(x => x !== c).join(' '); }
  contains(c){ return this._get().includes(c); }
  toggle(c, on){ on = on === undefined ? !this.contains(c) : on; on ? this.add(c) : this.remove(c); return on; }
}
const calls = [], texts = [], rots = [];
function fakeCtx(){
  const ctx = {};
  ['save','restore','translate','rotate','beginPath','moveTo','arcTo','closePath','fill','stroke','arc',
   'fillText','strokeText','clearRect','setTransform'].forEach(k => { ctx[k] = (...a) => {
     calls.push(k); if(k === 'fillText') texts.push(a[0]); if(k === 'rotate') rots.push(a[0]); }; });
  ctx.measureText = t => ({width: String(t).length * 7});
  return ctx;
}
class El {
  constructor(tag){ this.tagName = tag.toUpperCase(); this.children = []; this.parentNode = null; this.className = '';
    this.attrs = {}; this.listeners = {}; this.style = {}; this.textContent = ''; this.hidden = false;
    this.classList = new ClassList(this); this.id = ''; this.value = ''; this.checked = false; }
  appendChild(c){ c.parentNode = this; this.children.push(c); return c; }
  removeChild(c){ this.children = this.children.filter(x => x !== c); c.parentNode = null; return c; }
  setAttribute(k, v){ this.attrs[k] = String(v); }
  getAttribute(k){ return k in this.attrs ? this.attrs[k] : null; }
  addEventListener(t, f){ (this.listeners[t] = this.listeners[t] || []).push(f); }
  removeEventListener(t, f){ this.listeners[t] = (this.listeners[t] || []).filter(x => x !== f); }
  fire(t, ev){ ev = Object.assign({type: t, defaultPrevented: false, preventDefault(){ this.defaultPrevented = true; }, stopPropagation(){}}, ev || {});
    (this.listeners[t] || []).slice().forEach(f => f(ev)); return ev; }
  focus(){ document.activeElement = this; }
  getContext(){ return this.tagName === 'CANVAS' ? (this._ctx = this._ctx || fakeCtx()) : null; }
  all(){ let out = [this]; this.children.forEach(c => { out = out.concat(c.all()); }); return out; }
}
const document = {createElement: t => new El(t), activeElement: null, documentElement: new El('html')};
const store = {};
let timers = [], now = 0;
const window = {
  HQV: {}, document, devicePixelRatio: 1,
  localStorage: {getItem: k => (k in store ? store[k] : null), setItem: (k, v) => { store[k] = String(v); }},
  setTimeout: (f, ms) => { timers.push({f, at: now + ms, id: timers.length + 1}); return timers.length; },
  clearTimeout: id => { timers = timers.filter(t => t.id !== id); },
  getComputedStyle: () => ({getPropertyValue: n => '#123'}),
  console
};
function advance(ms){ now += ms; const due = timers.filter(t => t.at <= now); timers = timers.filter(t => t.at > now); due.forEach(t => t.f()); }
new Function('window', fs.readFileSync(process.argv[2], 'utf8'))(window);
const H = window.HQV.hqhud, out = {};

// ---- pure helpers ----
out.layout = H.layoutLabels([
  {id: 'street', x: 50, y: 50, w: 40, h: 12, pri: 1},
  {id: 'shield', x: 55, y: 52, w: 20, h: 18, pri: 7},
  {id: 'hq', x: 200, y: 50, w: 60, h: 20, pri: 6},
  {id: 'peer', x: 210, y: 55, w: 30, h: 16, pri: 5},
  {id: 'avenue', x: 120, y: 120, w: 50, h: 14, pri: 2},
  {id: 'off', x: 5, y: 150, w: 40, h: 14, pri: 3},
  {id: 'rot', x: 120, y: 150, w: 80, h: 10, angle: Math.PI/2, pri: 1}
], 300, 200).map(c => c.id);
let worst = 0, minA = 9, maxA = -9;
for(let i = 0; i < 720; i++){
  const t = i / 720 * 2 * Math.PI, a = H.labelAngle(0, 0, Math.cos(t), Math.sin(t));
  minA = Math.min(minA, a); maxA = Math.max(maxA, a);
  // same line as the segment (parallel), never reversed by more than 90 deg from "left to right"
  const cross = Math.abs(Math.cos(t) * Math.sin(a) - Math.sin(t) * Math.cos(a));
  worst = Math.max(worst, cross);
}
out.angle = {min: minA, max: maxA, worst, flip: H.labelAngle(10, 0, 0, 0), up: H.labelAngle(0, 10, 0, 0), down: H.labelAngle(0, 0, 0, 10)};
out.ticks0 = H.compassTicks(0);
out.ticksE = H.compassTicks(-Math.PI/2);      // turned right a quarter: heading east (-x)
out.ticksOdd = H.compassTicks(0.3);
out.kmh = [H.kmh(10), H.kmh(0), H.kmh(13.9), H.kmh(null), H.kmh('x')];
out.junk = [H.loadSettings('{not json'), H.loadSettings(null), H.loadSettings('[1,2]'),
  H.loadSettings({fov: 500, sens: -4, invertY: 'yes', reduced: true, headBob: 0, quality: 'ultra', preferred: 'cine'}),
  H.loadSettings(JSON.stringify({fov: 70, sens: 2.5, preferred: 'fp', quality: 'low'}))];

// ---- mounted HUD ----
const stage = new El('div'); stage.clientWidth = 400; stage.clientHeight = 300;
const said = [];
const hud = H.mount(stage, {announce: t => said.push(t)});
const all = stage.all();
const byClass = c => all.find(e => e.className.split(' ').includes(c));
const root = byClass('hqhud'), gear = byClass('hqhud-gear'), panel = byClass('hqhud-settings');
out.parts = ['hqhud','hqhud-chip','hqhud-cross','hqhud-prompt','hqhud-speed','hqhud-compass','hqhud-labels','hqhud-vignette','hqhud-gear','hqhud-settings']
  .filter(c => !byClass(c));
out.canvasTag = byClass('hqhud-labels').tagName;
out.gearTag = gear.tagName;
out.ariaControls = gear.getAttribute('aria-controls') === panel.id && !!panel.id;
out.closed = [gear.getAttribute('aria-expanded'), panel.hidden];
gear.fire('click');
out.opened = [gear.getAttribute('aria-expanded'), panel.hidden];
const inputs = panel.all().filter(e => e.tagName === 'INPUT' || e.tagName === 'SELECT');
const labels = panel.all().filter(e => e.tagName === 'LABEL');
out.unlabelled = inputs.filter(i => !labels.some(l => l.getAttribute('for') === i.id && l.textContent)).map(i => i.id);
out.controls = inputs.map(i => [i.id.replace(/^hqhud-settings-\d+-/, ''), i.type || i.tagName, i.getAttribute('min'), i.getAttribute('max')]);
const got = [];
hud.onSettings(s => got.push(s));
const fov = inputs.find(i => /-fov$/.test(i.id));
fov.value = '88'; fov.fire('input');
const inv = inputs.find(i => /-invertY$/.test(i.id));
inv.checked = true; inv.fire('change');
const pref = inputs.find(i => /-preferred$/.test(i.id));
pref.value = 'near'; pref.fire('change');
out.got = got.slice();
out.stored = JSON.parse(store.hq_cam);
out.hudSettings = hud.settings();
hud.setSettings({preferred: 'fp'});
out.afterSet = [JSON.parse(store.hq_cam).preferred, got.length, pref.value];
// a no-op change fires nothing; a slider's 'change' after its 'input' fires once in all
const n0 = got.length;
hud.setSettings({preferred: 'fp'});
fov.value = '90'; fov.fire('input'); fov.fire('change');
out.noop = got.length - n0;
hud.setSettings({fov: 88});
// a mouse press does not focus the gear; Space/Enter on the gear stop there
out.gearMouse = gear.fire('mousedown').defaultPrevented;
let stopped = false;
gear.fire('keydown', {key: 'Enter', code: 'Enter', stopPropagation(){ stopped = true; }});
gear.fire('keydown', {key: 'Enter', code: 'Enter'});
out.gearStop = stopped;
panel.fire('keydown', {key: 'Escape'});
out.escaped = [gear.getAttribute('aria-expanded'), panel.hidden, document.activeElement === gear];
hud.openSettings(true);
out.reopen = gear.getAttribute('aria-expanded');
hud.openSettings();
out.toggled = gear.getAttribute('aria-expanded');
// Enter/Space on the gear toggle on keydown, even when a host capture listener already preventDefaulted Space
let ev = gear.fire('keydown', {key: ' ', code: 'Space', defaultPrevented: true});
out.spaceOpen = [gear.getAttribute('aria-expanded'), panel.hidden, ev.defaultPrevented];
ev = gear.fire('keydown', {key: 'Enter', code: 'Enter'});
out.enterClose = [gear.getAttribute('aria-expanded'), panel.hidden];
gear.fire('keydown', {key: 'a', code: 'KeyA'});
out.otherKey = gear.getAttribute('aria-expanded');
// invalid partial values keep the current setting instead of resetting it
hud.setSettings({fov: 85});
hud.setSettings({preferred: 'map', fov: NaN, quality: 'ultra', invertY: 'yes'});
out.invalidKept = hud.settings();
hud.setPreferred('far');
out.setPreferred = [hud.settings().preferred, JSON.parse(store.hq_cam).preferred];
hud.setSettings({preferred: 'fp', fov: 88});

// chip: shows the label, announces once, clears after 1.4 s
const chip = byClass('hqhud-chip');
hud.setMode('chase', 'Chase camera');
out.chipOn = [chip.textContent, chip.classList.contains('on')];
for(let i = 0; i < 10; i++) hud.frame({mode: 'chase', hudOn: true, yaw: 0, speed: null});
advance(1399);
out.chip1399 = chip.textContent;
advance(2);
out.chip1401 = [chip.textContent, chip.classList.contains('on')];   // fading out: text kept
advance(400);
out.chip1801 = [chip.textContent, chip.classList.contains('on')];
out.said = said.slice();

// a chase frame: compass, speed, prompt
const proj = (x, y, z) => ({x: 200 + x * 2, y: 150 + z * 2, vis: true});
hud.frame({mode: 'fp', hudOn: true, yaw: 0, speed: 12.5, vehicle: 'car', prompt: "E  Enter Maya's HQ", crosshair: true, vignette: 0.4, project: proj, peers: []});
const prompt = byClass('hqhud-prompt');
out.fp = {root: root.hidden, cross: byClass('hqhud-cross').hidden, prompt: prompt.hidden, promptText: prompt.all().map(e => e.textContent).filter(Boolean),
  speed: byClass('hqhud-speed').hidden, speedText: byClass('hqhud-speed').all().map(e => e.textContent).join(' '),
  compass: byClass('hqhud-compass').hidden, vig: byClass('hqhud-vignette').style.opacity, labels: byClass('hqhud-labels').hidden,
  tickN: byClass('hqhud-compass').all().filter(e => e.textContent === 'N').map(e => e.style.left)};
for(let i = 0; i < 5; i++) hud.frame({mode: 'fp', hudOn: true, yaw: 0, speed: 12.5, prompt: "E  Enter Maya's HQ", crosshair: true, vignette: 0.4});
out.promptSaid = said.filter(t => /Maya/.test(t));
hud.frame({mode: 'chase', hudOn: true, yaw: 0, speed: null, prompt: null, crosshair: false, vignette: 0});
out.chase = {cross: byClass('hqhud-cross').hidden, prompt: prompt.hidden, speed: byClass('hqhud-speed').hidden,
  vigHidden: byClass('hqhud-vignette').hidden, vig: byClass('hqhud-vignette').style.opacity};
// hudOn false while focus is in the open panel: the panel closes and focus goes to the stage
hud.openSettings(true);
out.focusBefore = panel.all().includes(document.activeElement);
hud.frame({mode: 'photo', hudOn: false});
out.off = root.hidden;
out.offPanel = [panel.hidden, gear.getAttribute('aria-expanded'), document.activeElement === stage];

// map labels
hud.setLabels({
  roads: [
    {name: 'Maple Street', cls: 'street', ref: null, pts: [[-80, -20], [-40, -20], [0, -20], [40, -20], [80, -20]], len: 160},
    {name: 'Tiny Lane', cls: 'street', ref: null, pts: [[50, 40], [52, 40]], len: 2},
    {name: 'Gate Highway', cls: 'highway', ref: 'H1', pts: [[-95, 60], [-40, 60], [0, 60], [40, 60], [95, 60]], len: 190},
    {name: 'Ring Road', cls: 'ring', ref: 'R1', pts: [[-60, -70], [-60, 0], [-60, 70]], len: 140}
  ],
  hqs: [{userId: 'u1', name: 'Maya', x: 20, y: 0, z: 20, you: false}, {userId: 'me', name: 'You', x: -20, y: 0, z: 20, you: true}]
});
calls.length = 0; texts.length = 0; rots.length = 0;
const projYs = [];
const projG = (x, y, z) => { projYs.push([x, y, z]); return proj(x, y, z); };
const ground = (x, z) => 7;
hud.frame({mode: 'map', hudOn: true, yaw: 0, speed: null, mapSpan: 200, project: projG, ground, peers: [{n: 'Sam', x: 30, y: 0, z: -40}]});
out.roadY = projYs.filter(p => p[0] === -40 && p[2] === -20).map(p => p[1]);   // a Maple Street point
out.glyphs = {whole: texts.includes('Maple Street'), letters: ['M', 'a', 'p'].every(c => texts.includes(c))};
out.map = {counts: hud.labelCounts(), labels: byClass('hqhud-labels').hidden, compass: byClass('hqhud-compass').hidden, drew: calls.filter(c => c === 'fillText').length};
calls.length = 0;
hud.frame({mode: 'map', hudOn: true, yaw: 0, speed: null, mapSpan: 200, project: proj, peers: [{n: 'Sam', x: 30, y: 0, z: -40}]});
out.redraw = calls.filter(c => c === 'fillText').length;     // unchanged view: no redraw
document.documentElement.setAttribute('data-theme', 'dark-ish');
calls.length = 0;
hud.frame({mode: 'map', hudOn: true, yaw: 0, speed: null, mapSpan: 200, project: proj, peers: [{n: 'Sam', x: 30, y: 0, z: -40}]});
out.themeRedraw = calls.filter(c => c === 'fillText').length;  // theme switch: colours re-read, redrawn
// a curved road alone: its glyphs turn with the curve
hud.setLabels({roads: [{name: 'Bend Avenue', cls: 'avenue', ref: null, len: 110,
  pts: Array.from({length: 13}, (_, i) => [60 + 35 * Math.cos(Math.PI * (0.5 + i / 24)), -50 + 35 * Math.sin(Math.PI * (0.5 + i / 24))])}], hqs: []});
rots.length = 0;
hud.frame({mode: 'map', hudOn: true, yaw: 0, speed: null, mapSpan: 200, project: proj, peers: []});
out.bend = rots.slice();
// a bend whose chord is near vertical (tangents 50..130 deg): no glyph is drawn upside down
hud.setLabels({roads: [{name: 'Very Long Bend Avenue', cls: 'avenue', ref: null, len: 170,
  pts: Array.from({length: 17}, (_, i) => { const t = (-40 + 5 * i) * Math.PI / 180; return [10 + 60 * Math.cos(t), 60 * Math.sin(t)]; })}], hqs: []});
rots.length = 0;
hud.frame({mode: 'map', hudOn: true, yaw: 0, speed: null, mapSpan: 200, project: proj, peers: []});
out.vbend = rots.slice();

hud.destroy();
out.destroyed = stage.children.length;
console.log(JSON.stringify(out));
"""


@unittest.skipUnless(shutil.which("node"), "node not installed")
class HudNodeTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        r = subprocess.run(["node", "-", JS], input=SCRIPT, capture_output=True, text=True, timeout=30)
        if r.returncode != 0:
            raise AssertionError(r.stderr)
        cls.o = json.loads(r.stdout)

    def test_layout_labels(self):
        kept = self.o["layout"]
        self.assertIn("shield", kept)
        self.assertNotIn("street", kept)            # overlaps the shield, lower priority
        self.assertIn("hq", kept)
        self.assertNotIn("peer", kept)              # overlaps the HQ name
        self.assertIn("avenue", kept)
        self.assertNotIn("off", kept)               # sticks out of the view
        self.assertNotIn("rot", kept)               # rotated 90 deg its box is 80 px tall: hits the avenue
        self.assertEqual(kept[0], "shield")         # priority order

    def test_label_angle_never_upside_down(self):
        a = self.o["angle"]
        self.assertGreater(a["min"], -1.5707964)
        self.assertLessEqual(a["max"], 1.5707964)
        self.assertLess(a["worst"], 1e-9)           # still along the segment
        self.assertAlmostEqual(a["flip"], 0.0)      # right-to-left reads left-to-right
        self.assertAlmostEqual(a["up"], 1.5707963, places=6)
        self.assertAlmostEqual(a["down"], 1.5707963, places=6)

    def test_compass_ticks(self):
        t0 = self.o["ticks0"]
        self.assertEqual(len(t0), 13)
        n = [t for t in t0 if t["label"] == "N"]
        self.assertEqual(len(n), 1)
        self.assertAlmostEqual(n[0]["x"], 0.0)      # facing +z = north, centred
        self.assertEqual(sorted(t["label"] for t in t0 if t["label"]), ["E", "N", "W"])
        self.assertEqual([t["deg"] for t in t0], [270, 285, 300, 315, 330, 345, 0, 15, 30, 45, 60, 75, 90])
        xs = [t["x"] for t in t0]
        self.assertEqual(xs[0], -1)
        self.assertEqual(xs[-1], 1)
        for a, b in zip(xs, xs[1:]):
            self.assertAlmostEqual(b - a, 15 / 90)  # 15 deg spacing over a 180 deg window
        e = [t for t in self.o["ticksE"] if t["label"] == "E"]
        self.assertAlmostEqual(e[0]["x"], 0.0)
        odd = self.o["ticksOdd"]
        self.assertTrue(all(-1 <= t["x"] <= 1 and t["deg"] % 15 == 0 for t in odd))
        self.assertEqual(len(odd), 12)

    def test_kmh(self):
        self.assertEqual(self.o["kmh"], [36, 0, 50, 0, 0])

    def test_load_settings(self):
        defaults = {"fov": 65, "sens": 1, "invertY": False, "reduced": False, "headBob": True, "quality": "auto", "preferred": "chase",
                    "news": True}                    # the City news ticker: on unless switched off
        junk, none, arr, clamped, good = self.o["junk"]
        self.assertEqual(junk, defaults)
        self.assertEqual(none, defaults)
        self.assertEqual(arr, defaults)
        self.assertEqual(clamped, dict(defaults, fov=100, sens=0.2, reduced=True))
        self.assertEqual(good, dict(defaults, fov=70, sens=2.5, preferred="fp", quality="low"))

    def test_dom_parts_and_settings_panel(self):
        o = self.o
        self.assertEqual(o["parts"], [])
        self.assertEqual(o["canvasTag"], "CANVAS")
        self.assertEqual(o["gearTag"], "BUTTON")
        self.assertTrue(o["ariaControls"])
        self.assertEqual(o["closed"], ["false", True])
        self.assertEqual(o["opened"], ["true", False])
        self.assertEqual(o["unlabelled"], [])
        ctl = {c[0]: c for c in o["controls"]}
        for k in ("fov", "sens", "invertY", "reduced", "headBob", "quality", "preferred"):
            self.assertIn(k, ctl)
        self.assertEqual(ctl["fov"][1:], ["range", "60", "100"])
        self.assertEqual(ctl["sens"][1:], ["range", "0.2", "3"])
        self.assertEqual(ctl["invertY"][1], "checkbox")
        self.assertEqual(ctl["quality"][1], "SELECT")
        self.assertEqual(len(o["got"]), 3)
        self.assertEqual(o["got"][0]["fov"], 88)
        self.assertTrue(o["got"][1]["invertY"])
        self.assertEqual(o["got"][2]["preferred"], "near")
        self.assertEqual(o["stored"]["fov"], 88)
        self.assertEqual(o["stored"]["preferred"], "near")
        self.assertEqual(o["hudSettings"], o["stored"])
        self.assertEqual(o["afterSet"], ["fp", 4, "fp"])
        self.assertEqual(o["escaped"], ["false", True, True])
        self.assertEqual(o["reopen"], "true")
        self.assertEqual(o["toggled"], "false")
        self.assertEqual(o["spaceOpen"], ["true", False, True])
        self.assertEqual(o["enterClose"], ["false", True])
        self.assertEqual(o["otherKey"], "false")
        inv = o["invalidKept"]
        self.assertEqual((inv["preferred"], inv["fov"], inv["quality"], inv["invertY"]), ("fp", 85, "auto", True))
        self.assertEqual(o["setPreferred"], ["far", "far"])
        self.assertEqual(o["noop"], 1)
        self.assertTrue(o["gearMouse"])
        self.assertTrue(o["gearStop"])

    def test_chip_clears_after_1_4_s(self):
        o = self.o
        self.assertEqual(o["chipOn"], ["Chase camera", True])
        self.assertEqual(o["chip1399"], "Chase camera")
        self.assertEqual(o["chip1401"], ["Chase camera", False])
        self.assertEqual(o["chip1801"], ["", False])
        self.assertEqual(o["said"], ["Chase camera"])   # once, not per frame

    def test_frame(self):
        fp = self.o["fp"]
        self.assertFalse(fp["root"])
        self.assertFalse(fp["cross"])
        self.assertFalse(fp["prompt"])
        self.assertEqual(fp["promptText"], ["E", "Enter Maya's HQ"])
        self.assertFalse(fp["speed"])
        self.assertIn("45", fp["speedText"])
        self.assertFalse(fp["compass"])
        self.assertEqual(fp["vig"], "0.4")
        self.assertTrue(fp["labels"])               # map labels only in map mode
        self.assertEqual(fp["tickN"], ["50.00%"])
        self.assertEqual(self.o["chase"], {"cross": True, "prompt": True, "speed": True, "vigHidden": False, "vig": "0"})
        self.assertEqual(self.o["promptSaid"], ["Press E to enter Maya's HQ"])   # once, not per frame
        self.assertTrue(self.o["off"])              # hudOn false hides everything
        self.assertTrue(self.o["focusBefore"])
        self.assertEqual(self.o["offPanel"], [True, "false", True])

    def test_map_labels(self):
        m = self.o["map"]
        c = m["counts"]
        self.assertGreater(c["roads"], 0)
        self.assertGreater(c["shields"], 0)
        self.assertEqual(c["hqs"], 2)
        self.assertEqual(c["peers"], 1)
        self.assertLessEqual(c["roads"], 3)          # "Tiny Lane" is shorter than its text
        self.assertFalse(m["labels"])
        self.assertTrue(m["compass"])
        self.assertGreater(m["drew"], 0)
        self.assertEqual(self.o["redraw"], 0)
        self.assertGreater(self.o["themeRedraw"], 0)
        self.assertTrue(self.o["roadY"])
        self.assertTrue(all(y == 7 for y in self.o["roadY"]))   # roads projected on the ground, not y = 0
        self.assertEqual(self.o["glyphs"], {"whole": False, "letters": True})   # glyph by glyph

    def test_curved_label_follows_road(self):
        self.assertTrue(self.o["bend"])
        self.assertGreater(max(self.o["bend"]) - min(self.o["bend"]), 0.3)   # glyph angles turn with the curve
        for a in self.o["bend"]:
            self.assertLessEqual(abs(a), 1.5707964)   # the bend reads left to right here
        for a in self.o["vbend"]:
            self.assertLessEqual(abs(a), 3.1415927 / 2 + 0.35)
        self.assertEqual(self.o["destroyed"], 0)


def css_section():
    with open(CSS, encoding="utf-8") as f:
        s = f.read()
    i = s.find("/* 3D city HUD")
    return s[i:] if i >= 0 else ""


class HudCssTests(unittest.TestCase):
    def test_section_exists(self):
        self.assertIn(".hqhud{", css_section())

    def test_tokens_only(self):
        sec = re.sub(r"/\*.*?\*/", "", css_section(), flags=re.S)
        self.assertIsNone(re.search(r"#[0-9a-fA-F]{3,8}\b", sec))
        self.assertIsNone(re.search(r"\b(rgba?|hsla?)\(", sec))

    def test_motion_gated(self):
        sec = re.sub(r"/\*.*?\*/", "", css_section(), flags=re.S)
        media = re.search(r"@media\s*\(prefers-reduced-motion:\s*reduce\)\s*\{(.*)\}\s*$", sec, re.S)
        self.assertIsNotNone(media)
        reduced = media.group(1)
        body = sec[:media.start()]
        animated = []
        for sel, decl in re.findall(r"([^{}]+)\{([^{}]*)\}", body):
            sel = sel.strip()
            if sel.startswith("html.hq-calm") or sel.startswith("@keyframes"):
                continue
            if re.search(r"\b(transition|animation)\s*:\s*(?!none)", decl):
                animated += [s.strip() for s in sel.split(",")]
        self.assertTrue(animated)
        calm = " ".join(sel for sel, decl in re.findall(r"([^{}]+)\{([^{}]*)\}", body)
                        if sel.strip().startswith("html.hq-calm") and re.search(r"(transition|animation)\s*:\s*none", decl))
        for s in animated:
            self.assertIn("html.hq-calm " + s, calm, s)
            self.assertRegex(reduced, re.escape(s) + r"[^{]*\{[^}]*(transition|animation)\s*:\s*none", s)


if __name__ == "__main__":
    unittest.main()
