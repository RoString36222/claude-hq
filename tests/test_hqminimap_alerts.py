"""games/hqminimap.js frame({alerts}) (city-sim plan 2.6): the incident markers, under node with a fake DOM and a
stub 2D context that records fills and the alpha of each stroke.

Checks: each known alert kind draws its disc colour; unknown kinds and bad points are skipped; at most ALERT_MAX are
drawn; the ring pulses (its alpha changes with time) unless Calm (html.hq-calm, or frame({calm: true})), where it is
steady; an alert off the map is drawn on the rim without a ring; frames without alerts draw none. Skipped without
node."""
import json
import os
import shutil
import subprocess
import unittest

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
JS = os.path.join(ROOT, "games", "hqminimap.js")
NODE = shutil.which("node")

SCRIPT = r"""
const fs = require('fs');
const [JS] = process.argv.slice(1);
function fakeCtx(cv){
  const ctx = {canvas: cv, fills: [], strokes: [], arcs: [], globalAlpha: 1};
  ['save','restore','translate','rotate','scale','beginPath','moveTo','lineTo','closePath','rect','quadraticCurveTo',
   'bezierCurveTo','fillRect','clearRect','setTransform','fillText','strokeText','drawImage'].forEach(k => { ctx[k] = () => {}; });
  ctx.arc = (x, y, r) => ctx.arcs.push([x, y, r]);
  ctx.fill = () => ctx.fills.push(ctx.fillStyle);
  ctx.stroke = () => ctx.strokes.push([ctx.strokeStyle, Math.round(ctx.globalAlpha*1000)/1000]);
  return ctx;
}
class CL { constructor(){ this.s = new Set(); } add(c){ this.s.add(c); } remove(c){ this.s.delete(c); } contains(c){ return this.s.has(c); } }
class El {
  constructor(tag){ this.tagName = tag.toUpperCase(); this.children = []; this.parentNode = null; this.className = '';
    this.attrs = {}; this.listeners = {}; this.style = {}; this.textContent = ''; this.classList = new CL();
    this.width = 300; this.height = 150; this.clientWidth = 200; this.clientHeight = 200; }
  appendChild(c){ c.parentNode = this; this.children.push(c); return c; }
  removeChild(c){ this.children = this.children.filter(x => x !== c); return c; }
  setAttribute(k, v){ this.attrs[k] = String(v); }
  addEventListener(t, f){ (this.listeners[t] = this.listeners[t] || []).push(f); }
  removeEventListener(){}
  getContext(k){ return this.tagName === 'CANVAS' ? (this._ctx = this._ctx || fakeCtx(this)) : null; }
  getBoundingClientRect(){ return {left: 0, top: 0, width: 200, height: 200}; }
}
const html = new El('html');
let clock = 1000;
const window = {HQV: {}, devicePixelRatio: 1, performance: {now: () => clock},
  document: {documentElement: html, createElement: t => new El(t)},
  addEventListener(){}, removeEventListener(){},
  getComputedStyle: () => ({getPropertyValue: () => ' #0c0d10'})};
new Function('window', fs.readFileSync(JS, 'utf8'))(window);
const M = window.HQV.hqminimap, out = {};
const stage = new El('div');
const mm = M.mount(stage, {});
const cv = stage.children[0].children[0], g = cv.getContext('2d');
const col = M.ALERT;
const ALL = [{x: 20, z: 10, kind: 'fire'}, {x: -20, z: 10, kind: 'medical'}, {x: 0, z: -30, kind: 'crime'},
             {x: 10, z: -10, kind: 'crash'}, {x: 0, z: 0, kind: 'parade'}, {x: NaN, z: 0, kind: 'fire'}, null];
function frame(alerts, extra){
  g.fills = []; g.strokes = []; g.arcs = [];
  mm.frame(Object.assign({x: 0, z: 0, yaw: 0, speed: 0, dt: 0.016, alerts}, extra || {}));
  const ring = k => g.strokes.filter(s => s[0] === col[k].col).map(s => s[1]);
  return {fills: Object.keys(col).map(k => g.fills.filter(f => f === col[k].col).length), ring: ring('fire')};
}
out.kinds = Object.keys(col);
out.all = frame(ALL);
out.none = frame([]);
out.noKey = frame(undefined);
const pulse = []; for(let i = 0; i < 6; i++){ clock += 230; pulse.push(frame([ALL[0]]).ring[0]); }
out.pulse = pulse;
const calmF = []; for(let i = 0; i < 6; i++){ clock += 230; calmF.push(frame([ALL[0]], {calm: true}).ring[0]); }
out.calmFlag = calmF;
html.classList.add('hq-calm');
const calmC = []; for(let i = 0; i < 6; i++){ clock += 230; calmC.push(frame([ALL[0]]).ring[0]); }
out.calmClass = calmC;
html.classList.remove('hq-calm');
// off the map (5 km away): a disc on the rim, no ring
const off = frame([{x: 5000, z: 0, kind: 'fire'}]);
out.off = {fills: off.fills[0], rings: off.ring.length};
// many alerts: capped
out.many = frame(Array.from({length: 40}, (_, i) => ({x: i, z: i, kind: 'fire'}))).fills[0];
mm.destroy();
process.stdout.write(JSON.stringify(out));
"""


@unittest.skipUnless(NODE, "node not installed")
class MinimapAlertsTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        r = subprocess.run([NODE, "-e", SCRIPT, "--", JS], capture_output=True, text=True, timeout=60)
        if r.returncode != 0:
            raise AssertionError(r.stderr)
        cls.o = json.loads(r.stdout)

    def test_kinds_drawn(self):
        self.assertEqual(self.o["kinds"], ["fire", "medical", "crime", "crash"])
        self.assertEqual(self.o["all"]["fills"], [1, 1, 1, 1], "one disc per known kind; bad points and kinds skipped")
        self.assertEqual(self.o["none"]["fills"], [0, 0, 0, 0])
        self.assertEqual(self.o["noKey"]["fills"], [0, 0, 0, 0])

    def test_pulse_unless_calm(self):
        self.assertGreater(len(set(self.o["pulse"])), 2, "the ring pulses")
        self.assertEqual(len(set(self.o["calmFlag"])), 1, "steady with calm: true")
        self.assertEqual(len(set(self.o["calmClass"])), 1, "steady under html.hq-calm")

    def test_off_map_and_cap(self):
        self.assertEqual(self.o["off"], {"fills": 1, "rings": 0})
        self.assertEqual(self.o["many"], 16)


if __name__ == "__main__":
    unittest.main()
