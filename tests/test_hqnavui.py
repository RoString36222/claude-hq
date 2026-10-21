"""games/hqnavui.js (nav-river spec, "Client: the navigation UI"): the pure helpers and the mounted
Go to panel, banner and arrival card under node with a tiny fake DOM (no jsdom), plus source checks
of the module and games/hqnavui.css. The node parts are skipped without node."""
import json
import os
import re
import shutil
import subprocess
import unittest

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
JS = os.path.join(ROOT, "games", "hqnavui.js")
CSS = os.path.join(ROOT, "games", "hqnavui.css")

SCRIPT = r"""
const fs = require('fs');
// ---- a tiny fake DOM: just what hqnavui.js touches ----
class ClassList {
  constructor(el){ this.el = el; }
  _get(){ return this.el.className ? this.el.className.split(/\s+/).filter(Boolean) : []; }
  add(c){ const l = this._get(); if(!l.includes(c)) l.push(c); this.el.className = l.join(' '); }
  remove(c){ this.el.className = this._get().filter(x => x !== c).join(' '); }
  contains(c){ return this._get().includes(c); }
}
class El {
  constructor(tag){ this.tagName = tag.toUpperCase(); this.children = []; this.parentNode = null; this.className = '';
    this.attrs = {}; this.listeners = {}; this.style = {}; this.textContent = ''; this.hidden = false;
    this.classList = new ClassList(this); this.id = ''; this.value = ''; }
  appendChild(c){ c.parentNode = this; this.children.push(c); return c; }
  removeChild(c){ this.children = this.children.filter(x => x !== c); c.parentNode = null; return c; }
  setAttribute(k, v){ this.attrs[k] = String(v); }
  getAttribute(k){ return k in this.attrs ? this.attrs[k] : null; }
  addEventListener(t, f){ (this.listeners[t] = this.listeners[t] || []).push(f); }
  removeEventListener(t, f){ this.listeners[t] = (this.listeners[t] || []).filter(x => x !== f); }
  focus(){ document.activeElement = this; }
  closest(sel){
    const cls = sel.split(',').map(s => s.trim().replace(/^\./, ''));
    for(let n = this; n; n = n.parentNode){ if(n.classList && cls.some(c => n.classList.contains(c))) return n; }
    return null;
  }
  // bubble from this element up, like a real event (target fixed, stopPropagation honoured)
  fire(t, ev){
    ev = Object.assign({type: t, target: this, defaultPrevented: false, stopped: false,
      preventDefault(){ this.defaultPrevented = true; }, stopPropagation(){ this.stopped = true; }}, ev || {});
    for(let n = this; n && !ev.stopped; n = n.parentNode) (n.listeners[t] || []).slice().forEach(f => f(ev));
    return ev;
  }
  all(){ let out = [this]; this.children.forEach(c => { out = out.concat(c.all()); }); return out; }
}
const document = {createElement: t => new El(t), activeElement: null};
let timers = [], now = 0, tid = 0;
const window = {HQV: {}, document, console,
  setTimeout: (f, ms) => { timers.push({f, at: now + ms, id: ++tid}); return tid; },
  clearTimeout: id => { timers = timers.filter(t => t.id !== id); }};
function advance(ms){ now += ms; const due = timers.filter(t => t.at <= now); timers = timers.filter(t => t.at > now); due.forEach(t => t.f()); }
new Function('window', fs.readFileSync(process.argv[2], 'utf8'))(window);
const N = window.HQV.hqnavui, out = {};

// ---- pure helpers ----
out.dist = [0, -5, NaN, 0.4, 12.6, 999, 999.4, 999.6, 1000, 1200, 1249, 9940, 9960, 12345].map(N.fmtDist);
out.eta = [0, 59, 59.4, 59.6, 60, 89, 90, 3540, 3599, 3600, 3900, 7290, NaN].map(N.fmtEta);
const kinds = ['start', 'left', 'right', 'slight-left', 'slight-right', 'sharp-left', 'sharp-right', 'straight', 'uturn', 'bridge', 'arrive'];
out.text = {};
kinds.forEach(k => { out.text[k] = [N.maneuverText({kind: k, road: 'Patch Lane'}, 120), N.maneuverText({kind: k, road: 'Patch Lane'}, 8),
  N.maneuverText({kind: k}, 1500)]; });
out.textNull = [N.maneuverText(null, null), N.maneuverText({kind: 'left', road: 'Patch Lane'}, undefined)];
out.glyphs = kinds.map(k => N.GLYPH[k]);

const places = [
  {id: 'd1', kind: 'dock', label: 'River Dock', icon: '⚓', x: 10, z: 0, dist: 40},
  {id: 'h1', kind: 'hospital', label: 'City Hospital', icon: '', x: 0, z: 90, dist: 320},
  {id: 'p1', kind: 'port', label: 'Harbour Port', icon: '⚓', x: 0, z: 0, dist: 1200},
  {id: 'm1', kind: 'market', label: 'Riverside Market', icon: '🛒', x: 0, z: 0, dist: 2500},
  {id: 't1', kind: 'travel', label: 'The Commons (ferry)', icon: '⛴', x: 0, z: 0, dist: 3100}
];
out.filter = {
  all: N.filterPlaces(places, '').map(p => p.id),
  river: N.filterPlaces(places, 'RIVER').map(p => p.id),
  two: N.filterPlaces(places, 'river mark').map(p => p.id),
  kind: N.filterPlaces(places, 'port').map(p => p.id),
  none: N.filterPlaces(places, 'zzz').map(p => p.id),
  junk: N.filterPlaces(null, 'x').length
};

// ---- mounted ----
const stage = new El('div');
const said = [], went = [];
let cleared = 0, asked = 0;
const ui = N.mount(stage, {places: () => { asked++; return places; }, onGo: p => went.push(p.id), onClear: () => cleared++, announce: t => said.push(t)});
const byClass = c => stage.all().find(e => e.className.split(' ').includes(c));
const panel = byClass('hqnavui-panel'), input = byClass('hqnavui-q'), list = byClass('hqnavui-list');
const rows = () => list.children;
const sel = () => rows().findIndex(r => r.getAttribute('aria-selected') === 'true');
out.parts = ['hqnavui', 'hqnavui-panel', 'hqnavui-q', 'hqnavui-list', 'hqnavui-banner', 'hqnavui-arrived'].filter(c => !byClass(c));
out.closed = [ui.isOpen(), panel.hidden];
ui.open();
out.opened = [ui.isOpen(), panel.hidden, document.activeElement === input, input.getAttribute('aria-expanded'), asked];
out.rows = rows().map(r => r.children.map(c => c.textContent));
out.hospitalIcon = rows()[1].children[0].textContent;          // no icon of its own: the kind's
out.sel0 = sel();
out.activedesc = input.getAttribute('aria-activedescendant') === rows()[0].id;
const key = (target, k, type, extra) => target.fire(type || 'keydown', Object.assign({key: k}, extra || {}));
const evDown = key(input, 'ArrowDown');
key(input, 'ArrowDown');
out.sel2 = sel();
key(input, 'ArrowUp');
out.sel1 = sel();
for(let i = 0; i < 9; i++) key(input, 'ArrowDown');
out.selEnd = sel();                                             // clamped at the last row
for(let i = 0; i < 9; i++) key(input, 'ArrowUp');
out.selTop = sel();
out.downEv = [evDown.hqnavHandled === true, evDown.stopped, evDown.defaultPrevented];
// typing: a letter keeps its default (it must reach the input) but is still marked and stopped
const evA = key(input, 'a');
const evAUp = key(input, 'a', 'keyup');
const evSpace = key(input, ' ');
out.typeEv = [evA.hqnavHandled === true, evA.stopped, evA.defaultPrevented, evAUp.hqnavHandled === true, evAUp.stopped, evAUp.defaultPrevented,
  evSpace.stopped, evSpace.defaultPrevented];
// a key on the panel itself (not the input) is prevented too, and nothing reaches the stage
let stageGot = 0;
stage.addEventListener('keydown', () => stageGot++);
stage.addEventListener('keyup', () => stageGot++);
const evW = key(panel, 'w');
out.panelEv = [evW.hqnavHandled === true, evW.stopped, evW.defaultPrevented];
out.owns = [N.owns(evW), N.owns({target: input}), N.owns({target: stage}), N.owns({hqnavHandled: true, target: stage}), N.owns(null)];
// filter: "river" then ArrowDown + Enter goes to the second match
input.value = 'river'; input.fire('input');
out.filtered = rows().map(r => r.children[1].textContent);
out.filteredSel = sel();
key(input, 'ArrowDown');
const evEnter = key(input, 'Enter');
out.went1 = went.slice();
out.afterEnter = [ui.isOpen(), panel.hidden, document.activeElement === stage, evEnter.defaultPrevented];
// reopening resets the query and lists everything again
ui.open();
out.reopen = [input.value, rows().length];
input.value = 'zzz'; input.fire('input');
out.empty = [rows().length, byClass('hqnavui-empty').hidden, byClass('hqnavui-empty').textContent, list.hidden];
const evNo = key(input, 'Enter');
out.enterNone = [went.length, ui.isOpen()];
const evEsc = key(input, 'Escape');
out.esc = [ui.isOpen(), panel.hidden, evEsc.defaultPrevented, evEsc.stopped];
// click a row
ui.open();
const mdown = rows()[2].children[1].fire('mousedown');
rows()[2].children[1].fire('click');
out.click = [went.slice(), ui.isOpen(), mdown.defaultPrevented];
out.stageGot = stageGot;
// toggle
out.toggle = [ui.toggle(), ui.toggle()];

// ---- banner ----
const banner = byClass('hqnavui-banner'), arrow = byClass('hqnavui-arrow');
const btext = () => ({arrow: arrow.textContent, kind: arrow.getAttribute('data-kind'), to: byClass('hqnavui-to').textContent,
  road: byClass('hqnavui-road').textContent, left: byClass('hqnavui-left').textContent, dest: byClass('hqnavui-dest').textContent,
  destHidden: byClass('hqnavui-dest').hidden, hint: byClass('hqnavui-hint').textContent, hintHidden: byClass('hqnavui-hint').hidden,
  sr: byClass('hqnavui-sr').textContent, hidden: banner.hidden});
out.bannerOff = banner.hidden;
said.length = 0;
const info = {step: {kind: 'left', road: 'Patch Lane', at: 300}, toNext: 120, left: 1240, eta_s: 3900, dest: 'River Dock'};
ui.banner(info);
out.b1 = btext();
for(let i = 0; i < 5; i++) ui.banner(Object.assign({}, info, {toNext: 110 - i * 10}));
out.b1b = btext();
out.saidOnce = said.slice();
ui.banner({step: {kind: 'arrive', road: '', at: 900}, toNext: 5, left: 5, eta_s: 3, dest: 'River Dock', hint: 'Press E for the ferry'});
out.b2 = btext();
out.said2 = said.slice();
out.bannerKinds = {};
kinds.forEach((k, i) => { ui.banner({step: {kind: k, road: 'Patch Lane', at: i}, toNext: 200, left: 400, eta_s: 30}); out.bannerKinds[k] = btext(); });
ui.banner({step: {kind: 'warp'}, toNext: 50, left: 50, eta_s: 4});
out.bannerUnknown = btext().kind;
// X: click, and Enter/Space on keydown (marked and stopped)
const x = banner.children.find(c => c.className === 'hqnavui-x');
x.fire('click');
out.xClick = [cleared, banner.hidden];
ui.banner(info);
const evX = key(x, ' ');
out.xSpace = [cleared, banner.hidden, evX.hqnavHandled === true, evX.stopped, evX.defaultPrevented];
ui.banner(info);
const evX2 = key(x, 'Enter');
out.xEnter = [cleared, banner.hidden];
ui.banner(info);
const evB = key(banner, 'w');
out.bannerKey = [evB.hqnavHandled === true, evB.stopped, evB.defaultPrevented, cleared, banner.hidden];
ui.banner(null);
out.bannerNull = [banner.hidden, cleared];

// ---- arrival card ----
const card = byClass('hqnavui-arrived');
said.length = 0;
ui.arrived('River Dock');
out.card = [card.hidden, card.all().map(e => e.textContent).filter(Boolean), said.slice(), card.getAttribute('role')];
advance(N.ARRIVED_MS - 1);
out.cardBefore = card.hidden;
advance(2);
out.cardAfter = card.hidden;
ui.arrived('');
out.cardNoLabel = said[said.length - 1];

ui.destroy();
out.destroyed = stage.children.length;
ui.open(); ui.banner(info);                                     // after destroy: no-ops, no throw
console.log(JSON.stringify(out));
"""


@unittest.skipUnless(shutil.which("node"), "node not installed")
class NavUiNodeTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        r = subprocess.run(["node", "-", JS], input=SCRIPT, capture_output=True, text=True, timeout=30)
        if r.returncode != 0:
            raise AssertionError(r.stderr)
        cls.o = json.loads(r.stdout)

    def test_fmt_dist(self):
        self.assertEqual(self.o["dist"], ["0 m", "0 m", "0 m", "0 m", "13 m", "999 m", "999 m", "1 km", "1 km", "1.2 km",
                                          "1.2 km", "9.9 km", "10 km", "12 km"])

    def test_fmt_eta(self):
        self.assertEqual(self.o["eta"], ["0 s", "59 s", "59 s", "1 min", "1 min", "1 min", "2 min", "59 min", "1 h", "1 h",
                                         "1 h 5 min", "2 h 2 min", "0 s"])

    def test_maneuver_text(self):
        t = self.o["text"]
        self.assertEqual(t["left"][0], "In 120 m turn left onto Patch Lane")
        self.assertEqual(t["left"][1], "Turn left onto Patch Lane")         # close: no "In 8 m"
        self.assertEqual(t["left"][2], "In 1.5 km turn left")
        self.assertEqual(t["right"][0], "In 120 m turn right onto Patch Lane")
        self.assertEqual(t["slight-left"][0], "In 120 m bear left onto Patch Lane")
        self.assertEqual(t["slight-right"][1], "Bear right onto Patch Lane")
        self.assertEqual(t["sharp-left"][0], "In 120 m turn sharp left onto Patch Lane")
        self.assertEqual(t["sharp-right"][2], "In 1.5 km turn sharp right")
        self.assertEqual(t["straight"][0], "In 120 m continue straight onto Patch Lane")
        self.assertEqual(t["uturn"][0], "In 120 m make a U-turn on Patch Lane")
        self.assertEqual(t["uturn"][2], "In 1.5 km make a U-turn")
        self.assertEqual(t["bridge"][0], "In 120 m cross the bridge on Patch Lane")
        self.assertEqual(t["bridge"][2], "In 1.5 km cross the bridge")
        self.assertEqual(t["arrive"][0], "In 120 m arrive at your destination")
        self.assertEqual(t["arrive"][1], "Arrive at your destination")
        self.assertEqual(t["start"][0], "Head along Patch Lane")
        self.assertEqual(t["start"][2], "Head to the route")
        self.assertEqual(self.o["textNull"], ["Continue straight", "Turn left onto Patch Lane"])
        self.assertTrue(all(self.o["glyphs"]))
        self.assertEqual(len(set(self.o["glyphs"][1:7])), 6)                   # the six turns differ

    def test_filter(self):
        f = self.o["filter"]
        self.assertEqual(f["all"], ["d1", "h1", "p1", "m1", "t1"])
        self.assertEqual(f["river"], ["d1", "m1"])                              # case-insensitive, order kept
        self.assertEqual(f["two"], ["m1"])                                      # every word must match
        self.assertEqual(f["kind"], ["p1"])
        self.assertEqual(f["none"], [])
        self.assertEqual(f["junk"], 0)

    def test_panel(self):
        o = self.o
        self.assertEqual(o["parts"], [])
        self.assertEqual(o["closed"], [False, True])
        self.assertEqual(o["opened"], [True, False, True, "true", 1])
        self.assertEqual(o["rows"][0], ["⚓", "River Dock", "40 m"])
        self.assertEqual(o["rows"][2], ["⚓", "Harbour Port", "1.2 km"])
        self.assertEqual(len(o["rows"]), 5)
        self.assertEqual(o["hospitalIcon"], "✚")
        self.assertEqual(o["sel0"], 0)
        self.assertTrue(o["activedesc"])

    def test_keyboard_selection_and_enter(self):
        o = self.o
        self.assertEqual((o["sel2"], o["sel1"], o["selEnd"], o["selTop"]), (2, 1, 4, 0))
        self.assertEqual(o["filtered"], ["River Dock", "Riverside Market"])
        self.assertEqual(o["filteredSel"], 0)
        self.assertEqual(o["went1"], ["m1"])
        self.assertEqual(o["afterEnter"], [False, True, True, True])
        self.assertEqual(o["reopen"], ["", 5])
        self.assertEqual(o["empty"], [0, False, "No places match", True])
        self.assertEqual(o["enterNone"], [1, True])                            # Enter with no match: nothing
        self.assertEqual(o["click"], [["m1", "p1"], False, True])
        self.assertEqual(o["toggle"], [True, False])

    def test_esc_closes(self):
        self.assertEqual(self.o["esc"], [False, True, True, True])

    def test_keys_never_leak(self):
        o = self.o
        self.assertEqual(o["downEv"], [True, True, True])
        # a letter or Space typed into the search box: marked and stopped, default kept (it types)
        self.assertEqual(o["typeEv"], [True, True, False, True, True, True, True, False])
        self.assertEqual(o["panelEv"], [True, True, True])
        self.assertEqual(o["owns"], [True, True, False, True, False])
        self.assertEqual(o["stageGot"], 0)
        self.assertEqual(o["bannerKey"], [True, True, True, 3, False])

    def test_banner(self):
        o = self.o
        self.assertTrue(o["bannerOff"])
        b1 = o["b1"]
        self.assertFalse(b1["hidden"])
        self.assertEqual(b1["arrow"], "←")
        self.assertEqual(b1["kind"], "left")
        self.assertEqual(b1["to"], "120 m")
        self.assertEqual(b1["road"], "Turn left onto Patch Lane")
        self.assertEqual(b1["left"], "1.2 km · 1 h 5 min")
        self.assertEqual(b1["dest"], "River Dock")
        self.assertFalse(b1["destHidden"])
        self.assertTrue(b1["hintHidden"])
        self.assertEqual(b1["sr"], "In 120 m turn left onto Patch Lane")
        self.assertEqual(o["b1b"]["to"], "70 m")
        self.assertEqual(o["saidOnce"], ["In 120 m turn left onto Patch Lane"])   # once per step, not per frame
        b2 = o["b2"]
        self.assertEqual((b2["arrow"], b2["to"], b2["road"], b2["left"]), ("◎", "Now", "Arrive at your destination", "5 m · 3 s"))
        self.assertEqual((b2["hint"], b2["hintHidden"]), ("Press E for the ferry", False))
        self.assertEqual(o["said2"][1:], ["Arrive at your destination", "Press E for the ferry"])
        bk = o["bannerKinds"]
        for k, road in (("left", "Turn left onto Patch Lane"), ("right", "Turn right onto Patch Lane"),
                        ("slight-left", "Bear left onto Patch Lane"), ("slight-right", "Bear right onto Patch Lane"),
                        ("sharp-left", "Turn sharp left onto Patch Lane"), ("sharp-right", "Turn sharp right onto Patch Lane"),
                        ("straight", "Continue straight onto Patch Lane"), ("uturn", "Make a U-turn on Patch Lane"),
                        ("bridge", "Cross the bridge on Patch Lane"), ("arrive", "Arrive at your destination"),
                        ("start", "Head along Patch Lane")):
            self.assertEqual(bk[k]["road"], road, k)
            self.assertEqual(bk[k]["kind"], k)
            self.assertEqual(bk[k]["to"], "200 m")
            self.assertEqual(bk[k]["left"], "400 m · 30 s")
            self.assertTrue(bk[k]["destHidden"])
        self.assertEqual(o["bannerUnknown"], "straight")

    def test_banner_clear(self):
        o = self.o
        self.assertEqual(o["xClick"], [1, True])
        self.assertEqual(o["xSpace"], [2, True, True, True, True])
        self.assertEqual(o["xEnter"], [3, True])
        self.assertEqual(o["bannerNull"], [True, 3])                           # banner(null) is not a clear

    def test_arrival_card(self):
        o = self.o
        self.assertEqual(o["card"], [False, ["You have arrived", "River Dock"], ["You have arrived at River Dock"], "status"])
        self.assertFalse(o["cardBefore"])
        self.assertTrue(o["cardAfter"])
        self.assertEqual(o["cardNoLabel"], "You have arrived")
        self.assertEqual(o["destroyed"], 0)


class NavUiSourceTests(unittest.TestCase):
    def setUp(self):
        with open(JS, encoding="utf-8") as f:
            self.js = f.read()
        with open(CSS, encoding="utf-8") as f:
            self.css = f.read()

    def test_text_content_only(self):
        for bad in ("innerHTML", "outerHTML", "insertAdjacentHTML", "document.write", "eval(", "Math.min(1, dt",
                    "fetch(", "XMLHttpRequest", "WebSocket"):
            self.assertNotIn(bad, self.js, bad)

    def test_header_documents_the_key_contract(self):
        head = self.js[:self.js.index("(function(){")]
        self.assertIn("hqnavHandled", head)
        self.assertIn("HQV.hqnavui.owns", head)

    def test_css_tokens_only(self):
        sec = re.sub(r"/\*.*?\*/", "", self.css, flags=re.S)
        self.assertIsNone(re.search(r"#[0-9a-fA-F]{3,8}\b", sec))
        self.assertIsNone(re.search(r"\b(rgba?|hsla?)\(", sec))
        for tok in ("--panel", "--ink", "--line", "--brand", "--muted"):
            self.assertIn("var(" + tok, sec)

    def test_banner_instruction_wraps_not_cut(self):
        road = re.search(r"\.hqnavui-road\{([^}]*)\}", self.css).group(1)
        self.assertNotIn("nowrap", road, "a cut-off 'Turn left onto Stash Av...' hides the road")
        self.assertIn("-webkit-line-clamp:2", road)

    def test_css_motion_gated(self):
        sec = re.sub(r"/\*.*?\*/", "", self.css, flags=re.S)
        animated = []
        for sel, decl in re.findall(r"([^{}@]+)\{([^{}]*)\}", sec):
            sel = sel.strip()
            if sel.startswith("html.hq-calm") or sel in ("from", "to"):
                continue
            if re.search(r"\b(transition|animation)\s*:\s*(?!none)", decl):
                animated += [s.strip() for s in sel.split(",")]
        self.assertTrue(animated)
        for s in animated:
            self.assertRegex(sec, r"html\.hq-calm " + re.escape(s) + r"[^{]*\{[^}]*(transition|animation)\s*:\s*none")
            self.assertRegex(sec, r"prefers-reduced-motion:\s*reduce\)\s*\{[^}]*" + re.escape(s) + r"[^{]*\{[^}]*(transition|animation)\s*:\s*none")


if __name__ == "__main__":
    unittest.main()
