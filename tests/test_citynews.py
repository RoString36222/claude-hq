"""games/citynews.js (the City news ticker and incident alerts, city-sim plan 2.6) under node, against a stub event
director D and a tiny fake DOM (no jsdom).

Checks: the headline text per event kind and phase; the ticker's order (incidents first) and its deterministic
rotation; screen-reader announcements are rate-limited (one per ANN_GAP) and the ticker itself is not live; the
nearby toast (within 400 m, fresh, once per event, one per TOAST_GAP); alerts(ms) lists the live incidents only;
Calm swaps the line without the slide-in; destroy; plus source checks (textContent only, no Math.random) and the
CSS (Calm-gated animation). Skipped without node."""
import json
import os
import re
import shutil
import subprocess
import unittest

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
JS = os.path.join(ROOT, "games", "citynews.js")
CSS = os.path.join(ROOT, "games", "games.css")
NODE = shutil.which("node")


def read(p):
    with open(p, encoding="utf-8") as f:
        return f.read()


SCRIPT = r"""
const fs = require('fs');
const [JS] = process.argv.slice(1);
class CL { constructor(){ this.s = new Set(); } add(c){ this.s.add(c); } remove(c){ this.s.delete(c); } contains(c){ return this.s.has(c); } }
class El {
  constructor(tag){ this.tagName = tag.toUpperCase(); this.children = []; this.parentNode = null; this.className = '';
    this.attrs = {}; this.hidden = false; this.classList = new CL(); this.offsetWidth = 0; this.writes = [];
    this._t = ''; }
  get textContent(){ return this._t; }
  set textContent(v){ this._t = String(v); this.writes.push(this._t); }
  appendChild(c){ c.parentNode = this; this.children.push(c); return c; }
  removeChild(c){ this.children = this.children.filter(x => x !== c); c.parentNode = null; return c; }
  setAttribute(k, v){ this.attrs[k] = String(v); }
  getAttribute(k){ return k in this.attrs ? this.attrs[k] : null; }
}
const html = new El('html');
const document = {documentElement: html, createElement: t => new El(t)};
const window = {HQV: {}, document};
new Function('window', fs.readFileSync(JS, 'utf8'))(window);
const N = window.HQV.cityNews, out = {};

const H = 3600e3, DAY = 24*H;
const T0 = Date.UTC(2026, 9, 23, 10, 0, 0);          // 10:00 UTC, the city's clock (tzMin 0)
// stub events (m)
function ev(o){ return Object.assign({severity: 1, units: [], street: 'Elm Street', label: ''}, o); }
const fire = ev({id: 'f1', kind: 'fire', start: T0 - 60e3, end: T0 + 30*60e3, x: 100, z: 0, severity: 3,
                 units: [{kind: 'fire'}, {kind: 'fire'}, {kind: 'fire'}, {kind: 'police'}]});
const rob = ev({id: 'c1', kind: 'crime', start: T0 - 30e3, end: T0 + 10*60e3, x: 2000, z: 0, street: 'Ring Road', label: 'Bank robbery',
                units: [{kind: 'police'}, {kind: 'getaway'}]});
const med = ev({id: 'm1', kind: 'medical', start: T0 - 20e3, end: T0 + 10*60e3, x: 0, z: 3000, street: 'Oak Lane', units: [{kind: 'ambulance'}]});
const crash = ev({id: 'x1', kind: 'crash', start: T0 - 10e3, end: T0 + 10*60e3, x: -50, z: 50, street: 'Main Street'});
const match = ev({id: 'mt', kind: 'match', start: T0 + 9*H, end: T0 + 11*H, x: 0, z: 0});
const market = ev({id: 'mk', kind: 'market', start: T0 - 2*H, end: T0 + 2*H, x: 0, z: 0});
const patrol = ev({id: 'p1', kind: 'patrol', start: T0 - H, end: T0 + H, x: 0, z: 0});
let phases = {};
function stubD(list){
  const D = {calls: 0,
    active: ms => { D.calls++; return list.filter(e => e.start <= ms && ms < e.end); },
    events: (a, b) => list.filter(e => e.start < b && e.end > a),
    phase: (e, ms) => phases[e.id] || (ms < e.start ? 'reported' : ms >= e.end ? 'done' : 'responding'),
    at: ms => ({rush: 0, match: null, market: null, school: null, festival: null})};
  return D;
}

// ---- headline text ----
const D0 = stubD([fire, rob, med, crash, match, market, patrol]);
out.text = {
  fire: N.headline(fire, T0, D0, 0), rob: N.headline(rob, T0, D0, 0), med: N.headline(med, T0, D0, 0),
  crash: N.headline(crash, T0, D0, 0), match: N.headline(match, T0, D0, 0), market: N.headline(market, T0, D0, 0),
  matchNow: N.headline(match, T0 + 9.5*H, D0, 0), matchTomorrow: N.headline(match, T0 + 9*H - DAY, D0, 0),
  matchTz: N.headline(match, T0, D0, 330), patrol: N.headline(patrol, T0, D0, 0)
};
phases = {f1: 'onscene', c1: 'clearing'};
out.text.fireOn = N.headline(fire, T0, D0, 0); out.text.robCaught = N.headline(rob, T0, D0, 0);
phases = {f1: 'done'};
out.text.fireDone = N.headline(fire, T0, D0, 0);
phases = {};
out.order = N.headlines(D0, T0, 0).map(h => h.id);
// rotation: deterministic, and the line changes every ROT_MS
const L = N.headlines(D0, T0, 0);
out.rot = [N.rotation(L, T0).id, N.rotation(L, T0).id, N.rotation(L, T0 + N.ROT_MS).id, N.rotation([], T0)];

// ---- mounted: announcements, toasts, alerts ----
function mount(list, mePos, opts){
  const stage = new El('div'), said = [];
  const D = stubD(list);
  const nw = N.create(stage, D, Object.assign({say: t => said.push(t), me: () => mePos}, opts || {}));
  const root = stage.children[0];
  return {stage, said, D, nw, root, line: root.children[0], live: root.children[1]};
}
// three far-away incidents starting 5 s apart: only the first is announced at once, the next after the gap
const far = [0, 1, 2].map(i => ev({id: 'far' + i, kind: 'fire', start: T0 + i*5e3, end: T0 + 20*60e3, x: 5000 + i, z: 0,
                                   units: [{kind: 'fire'}]}));
const A = mount(far, {x: 0, z: 0});
const ann = [];
for(let t = T0; t <= T0 + 70e3; t += 250){ const n0 = A.live.writes.length; A.nw.update(t);
  if(A.live.writes.length > n0) ann.push([t - T0, A.live.textContent]); }
out.ann = ann;
out.liveAttrs = [A.live.getAttribute('aria-live'), A.line.getAttribute('aria-hidden'), A.root.getAttribute('aria-live')];
out.farSaid = A.said.length;
out.ticker = {text: A.line.textContent, hidden: A.root.hidden, kind: A.root.getAttribute('data-kind'), roll: A.line.classList.contains('citynews-roll')};
out.polls = A.D.calls;                                  // D.active read at most every POLL_MS (281 frames)

// a near fresh fire -> one toast; a second near one 5 s later -> none (TOAST_GAP); a near old one -> none
const near1 = ev({id: 'n1', kind: 'fire', start: T0, end: T0 + 600e3, x: 150, z: 100, units: [{kind: 'fire'}, {kind: 'fire'}]});
const near2 = ev({id: 'n2', kind: 'crash', start: T0 + 5e3, end: T0 + 600e3, x: -100, z: 0, street: 'Main Street'});
const near3 = ev({id: 'n3', kind: 'medical', start: T0 + 60e3, end: T0 + 600e3, x: 0, z: 390, street: 'Oak Lane'});
const old = ev({id: 'o1', kind: 'crime', start: T0 - 600e3, end: T0 + 600e3, x: 10, z: 10, label: 'Bank robbery'});
const B = mount([near1, near2, near3, old], {x: 0, z: 0});
for(let t = T0; t <= T0 + 120e3; t += 250) B.nw.update(t);
out.said = B.said;
// moving away: an event outside 400 m never toasts
const C = mount([ev({id: 'z', kind: 'fire', start: T0, end: T0 + 600e3, x: 401, z: 0})], {x: 0, z: 0});
for(let t = T0; t <= T0 + 5e3; t += 250) C.nw.update(t);
out.farToast = C.said.length;
// no me() (not in the City yet): no toast, no throw
const Dm = mount([near1], null); Dm.nw.update(T0); out.noMe = Dm.said.length;

// switched off (the "City news ticker" setting): no ticker, no toast, no announcement; alerts still answer;
// switched back on, nothing that started meanwhile pops up
let newsOn = false;
const Off = mount([near1], {x: 0, z: 0}, {enabled: () => newsOn});
for(let t = T0; t <= T0 + 3e3; t += 250) Off.nw.update(t);
out.off = {said: Off.said.length, hidden: Off.root.hidden, text: Off.line.textContent, live: Off.live.writes.length, alerts: Off.nw.alerts(T0).length};
newsOn = true;
for(let t = T0 + 3e3; t <= T0 + 6e3; t += 250) Off.nw.update(t);
out.backOn = {said: Off.said.length, hidden: Off.root.hidden};

// alerts: incidents only, not done, in m
phases = {x1: 'done'};
const E = mount([fire, rob, crash, match, market, patrol], {x: 0, z: 0});
out.alerts = E.nw.alerts(T0);
phases = {};
out.alertsLater = E.nw.alerts(T0 + DAY).length;

// Calm: the line is swapped without the slide-in
html.classList.add('hq-calm');
const F = mount([fire], {x: 9e9, z: 0}); F.nw.update(T0);
out.calm = {text: F.line.textContent, roll: F.line.classList.contains('citynews-roll')};
html.classList.remove('hq-calm');
// nothing on: hidden
const G = mount([], {x: 0, z: 0}); G.nw.update(T0);
out.empty = {hidden: G.root.hidden, text: G.line.textContent};
// destroy: gone, and update/alerts are inert after
F.nw.destroy(); F.nw.update(T0 + 1000);
out.destroyed = {children: F.stage.children.length, alerts: F.nw.alerts(T0).length};
// a D that throws or has nothing never breaks the HUD
const bad = N.create(new El('div'), {active(){ throw new Error('x'); }, events(){ return null; }}, {});
bad.update(T0); out.bad = bad.alerts(T0).length;
const none = N.create(new El('div'), null, {}); none.update(T0); out.none = none.alerts(T0).length;
process.stdout.write(JSON.stringify(out));
"""


@unittest.skipUnless(NODE, "node not installed")
class CityNewsTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        r = subprocess.run([NODE, "-e", SCRIPT, "--", JS], capture_output=True, text=True, timeout=60)
        if r.returncode != 0:
            raise AssertionError(r.stderr)
        cls.o = json.loads(r.stdout)

    def test_headline_text(self):
        t = self.o["text"]
        self.assertEqual(t["fire"], "\U0001F692 Fire at Elm Street — 3 engines responding")
        self.assertEqual(t["fireOn"], "\U0001F692 Fire at Elm Street — 3 engines on scene")
        self.assertEqual(t["fireDone"], "")
        self.assertEqual(t["rob"], "\U0001F693 Bank robbery: chase on Ring Road")
        self.assertEqual(t["robCaught"], "\U0001F693 Bank robbery: suspects caught on Ring Road")
        self.assertEqual(t["med"], "\U0001F691 Medical emergency on Oak Lane — ambulance responding")
        self.assertTrue(t["crash"].startswith("\U0001F6A7 Crash at Main Street"))
        self.assertEqual(t["match"], "\U0001F3DF️ Match tonight 19:00")
        self.assertEqual(t["matchNow"], "\U0001F3DF️ Match on now at the stadium")
        self.assertEqual(t["matchTomorrow"], "\U0001F3DF️ Match tomorrow 19:00")
        self.assertEqual(t["matchTz"], "\U0001F3DF️ Match tomorrow 00:30")   # UTC+5:30: 19:00 UTC is 00:30
        self.assertEqual(t["market"], "\U0001F6CD️ Market day")
        self.assertEqual(t["patrol"], "")

    def test_order_and_rotation(self):
        self.assertEqual(self.o["order"], ["f1", "c1", "m1", "x1", "mk", "mt"])
        r = self.o["rot"]
        self.assertEqual(r[0], r[1])
        self.assertNotEqual(r[0], r[2])
        self.assertIsNone(r[3])

    def test_announcements_rate_limited(self):
        ann = self.o["ann"]
        self.assertGreaterEqual(len(ann), 2)
        self.assertEqual(ann[0][0], 0)
        for a, b in zip(ann, ann[1:]):
            self.assertGreaterEqual(b[0] - a[0], 30000, "at most one announcement per 30 s")
        self.assertTrue(all("Fire at Elm Street" in a[1] for a in ann))
        self.assertEqual(self.o["liveAttrs"], ["polite", "true", None], "only the hidden region is live, not the ticker")
        self.assertEqual(self.o["farSaid"], 0, "far incidents never toast")

    def test_ticker(self):
        tk = self.o["ticker"]
        self.assertFalse(tk["hidden"])
        self.assertEqual(tk["kind"], "fire")
        self.assertTrue(tk["text"].startswith("\U0001F692 Fire at"))
        self.assertTrue(tk["roll"], "slides in when not Calm")
        self.assertLessEqual(self.o["polls"], 150, "D.active is polled, not read every frame")
        self.assertEqual(self.o["empty"], {"hidden": True, "text": ""})

    def test_nearby_toast(self):
        said = self.o["said"]
        self.assertEqual(len(said), 2, said)   # n1 at once; n2 inside TOAST_GAP: none; n3 at +60 s; o1 old: none
        self.assertEqual(said[0], "Nearby: \U0001F692 Fire at Elm Street — 2 engines responding")
        self.assertTrue(said[1].startswith("Nearby: \U0001F691 Medical emergency on Oak Lane"))
        self.assertEqual(self.o["farToast"], 0)
        self.assertEqual(self.o["noMe"], 0)

    def test_news_can_be_switched_off(self):
        self.assertEqual(self.o["off"], {"said": 0, "hidden": True, "text": "", "live": 0, "alerts": 1})
        self.assertEqual(self.o["backOn"], {"said": 0, "hidden": False}, "back on: the ticker shows, no stale pop-up")

    def test_alerts(self):
        al = self.o["alerts"]
        self.assertEqual(sorted(a["kind"] for a in al), ["crime", "fire"])
        f = [a for a in al if a["kind"] == "fire"][0]
        self.assertEqual((f["x"], f["z"]), (100, 0))
        self.assertEqual(self.o["alertsLater"], 0)

    def test_calm_and_destroy(self):
        self.assertTrue(self.o["calm"]["text"].startswith("\U0001F692"))
        self.assertFalse(self.o["calm"]["roll"])
        self.assertEqual(self.o["destroyed"], {"children": 0, "alerts": 0})
        self.assertEqual([self.o["bad"], self.o["none"]], [0, 0])

    def test_source_rules(self):
        src = read(JS)
        for bad in ("innerHTML", "outerHTML", "insertAdjacentHTML", "document.write", "eval(", "fetch(",
                    "XMLHttpRequest", "Math.random"):
            self.assertNotIn(bad, src)
        self.assertIn("HQV.cityNews = ", src)
        self.assertNotIn("let ", src)
        self.assertNotIn("const ", src)

    def test_css(self):
        css = read(CSS)
        self.assertIn(".citynews{", css)
        self.assertIn("html.hq-calm .citynews-roll{animation:none}", css)
        self.assertRegex(css, r"@media \(prefers-reduced-motion:reduce\)\{ \.citynews-roll\{animation:none\} \}")
        block = css[css.index("/* ==== city news ticker"):]
        block = block[:block.index("@media (prefers-reduced-motion:reduce){ .citynews-roll")]
        self.assertIsNone(re.search(r"#[0-9a-fA-F]{3,8}\b", block), "semantic tokens only")


if __name__ == "__main__":
    unittest.main()
