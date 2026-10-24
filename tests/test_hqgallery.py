"""The phone's Camera and Gallery (games/hqgallery.js), HQ 3.15 (docs/plans/transport-revamp.md 3.12 apps 10-11).

node: the photo store over a fake IndexedDB (add, newest-first listing, get, delete, the cap dropping the oldest, one
database "hq-gallery" with one "photos" store keyed by id), its fallbacks (no IndexedDB, open failing, a transaction
throwing after it opened: photos kept in memory and persistent() false), the pure helpers (file names, the cover crop,
prev / next wrapping); then the Camera (shutter by button and by Space on the viewfinder, the 3 s timer counting down
aloud, the shutter sound, no flash under Calm, the selfie switch undone on close) and the Gallery (grid, viewer,
next, delete asking first, save through a download link) rendered into a tiny DOM shim. Python: nothing in the file
uploads (no fetch / XMLHttpRequest / sendBeacon / WebSocket).
Skipped when node is not installed. Stdlib only."""
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


def run(script):
    env = dict(os.environ, TZ="UTC")
    src = (HEAD + script).replace("%(root)s", json.dumps(ROOT))
    r = subprocess.run([NODE, "--input-type=module", "-"], input=src, capture_output=True, text=True, cwd=ROOT,
                       timeout=60, env=env)
    if r.returncode != 0:
        raise AssertionError(r.stderr or r.stdout)
    return json.loads(r.stdout.strip().splitlines()[-1])


# A fake IndexedDB (asynchronous like the real one) with failure switches, and a small DOM for the two apps.
HEAD = r"""
import fs from "fs";
function FakeIDB(o){ this.o = o || {}; this.dbs = {}; this.opens = []; }
FakeIDB.prototype.open = function(name, ver){
  var self = this, req = {};
  this.opens.push([name, ver]);
  if(self.o.throwOpen) throw new Error("SecurityError");
  setTimeout(function(){
    if(self.o.failOpen){ req.error = new Error("nope"); req.onerror && req.onerror(); return; }
    var fresh = !self.dbs[name], db = self.dbs[name] = self.dbs[name] || new FakeDB(self);
    req.result = db;
    if(fresh && req.onupgradeneeded) req.onupgradeneeded();
    req.onsuccess && req.onsuccess();
  }, 0);
  return req;
};
function FakeDB(f){ this.f = f; this.stores = {}; var s = this.stores; this.objectStoreNames = {contains: function(n){ return n in s; }}; }
FakeDB.prototype.createObjectStore = function(n, o){ this.stores[n] = {keyPath: o.keyPath, data: {}}; };
FakeDB.prototype.transaction = function(n, mode){
  if(this.f.o.failTx) throw new Error("InvalidStateError");
  var st = this.stores[n], tx = {}, pending = 0;
  function req(fn){
    var r = {}; pending++;
    setTimeout(function(){ r.result = fn(); r.onsuccess && r.onsuccess(); pending--; if(!pending) setTimeout(function(){ tx.oncomplete && tx.oncomplete(); }, 0); }, 0);
    return r;
  }
  tx.objectStore = function(){ return {
    put: function(rec){ if(mode !== "readwrite") throw new Error("ReadOnly"); return req(function(){ st.data[rec[st.keyPath]] = rec; return rec[st.keyPath]; }); },
    get: function(id){ return req(function(){ return st.data[id]; }); },
    getAll: function(){ return req(function(){ return Object.keys(st.data).map(function(k){ return st.data[k]; }); }); },
    delete: function(id){ if(mode !== "readwrite") throw new Error("ReadOnly"); return req(function(){ delete st.data[id]; }); }
  }; };
  return tx;
};
function blob(n){ return {size: n, type: "image/png", tag: "b" + n}; }

function El(tag){ this.tagName = String(tag).toUpperCase(); this.children = []; this.parentNode = null; this.attrs = {}; this.className = "";
  this._text = ""; this.listeners = {}; this.style = {}; this.tabIndex = 0; this.hidden = false; this.disabled = false; }
Object.defineProperty(El.prototype, "innerHTML", {set: function(){ throw new Error("innerHTML used"); }, get: function(){ return ""; }});
Object.defineProperty(El.prototype, "firstChild", {get: function(){ return this.children[0] || null; }});
Object.defineProperty(El.prototype, "textContent", {get: function(){ return this._text + this.children.map(function(c){ return c.textContent; }).join(""); },
  set: function(v){ this.children = []; this._text = String(v); }});
Object.defineProperty(El.prototype, "id", {get: function(){ return this.attrs.id || ""; }, set: function(v){ this.attrs.id = String(v); }});
El.prototype.appendChild = function(c){ if(c.parentNode) c.parentNode.removeChild(c); c.parentNode = this; this.children.push(c); return c; };
El.prototype.removeChild = function(c){ var i = this.children.indexOf(c); if(i >= 0) this.children.splice(i, 1); c.parentNode = null; return c; };
El.prototype.setAttribute = function(k, v){ this.attrs[k] = String(v); };
El.prototype.getAttribute = function(k){ return k in this.attrs ? this.attrs[k] : null; };
El.prototype.addEventListener = function(t, fn){ (this.listeners[t] = this.listeners[t] || []).push(fn); };
El.prototype.focus = function(){ document.activeElement = this; };
El.prototype.click = function(){ (this.listeners.click || []).forEach(function(fn){ fn({}); }); if(this.tagName === "A") CLICKED.push([this.href, this.download]); };
function all(root){ var out = []; (function walk(n){ n.children.forEach(function(c){ out.push(c); walk(c); }); })(root); return out; }
function cls(root, c){ return all(root).filter(function(e){ return e.className.split(/\s+/).indexOf(c) >= 0; }); }
function btn(root, text){ return all(root).filter(function(e){ return e.tagName === "BUTTON" && (e.textContent === text || e.getAttribute("aria-label") === text); })[0] || null; }
const CLICKED = [];
globalThis.document = {activeElement: null, body: new El("body"), documentElement: new El("html"), createElement: function(t){ return new El(t); }};
document.documentElement.classList = {contains: function(){ return false; }};
let urlN = 0; const REVOKED = [];
globalThis.window = {HQV: {}, document: globalThis.document,
  URL: {createObjectURL: function(b){ urlN++; return "blob:" + urlN; }, revokeObjectURL: function(u){ REVOKED.push(u); }}};
function load(){ new Function(fs.readFileSync(%(root)s + "/games/hqgallery.js", "utf8"))(); }
const wait = function(ms){ return new Promise(function(r){ setTimeout(r, ms || 5); }); };
"""


@unittest.skipUnless(NODE, "node not installed")
class Store(unittest.TestCase):
    def test_store_fake_idb(self):
        out = run(r"""
load();
const G = window.HQV.hqGallery, o = {};
const idb = new FakeIDB();
const S = G.createStore(idb, {max: 3});
o.persistent = await S.persistent();
const a = await S.add(blob(1), {at: 1000, world: "user:x@3"});
const b = await S.add(blob(2), {at: 3000, world: "claude-hq@3"});
const c = await S.add(blob(3), {at: 2000});
o.meta = [a, Object.keys(b).sort()];
o.ids = [a.id === b.id, b.id === c.id];
o.list = (await S.list()).map(function(r){ return [r.at, r.world, r.blob.tag]; });
o.get = (await S.get(a.id)).blob.tag; o.getNone = await S.get("nope");
o.del = await S.remove(c.id);
o.afterDel = (await S.list()).map(function(r){ return r.at; });
// the cap drops the oldest
await S.add(blob(4), {at: 4000}); await S.add(blob(5), {at: 5000});
o.capped = (await S.list()).map(function(r){ return r.at; });
o.db = [idb.opens[0], Object.keys(idb.dbs), Object.keys(idb.dbs["hq-gallery"].stores), idb.dbs["hq-gallery"].stores.photos.keyPath];
o.opens = idb.opens.length;     // opened once
// a second store on the same database sees the same photos (they persist)
const S2 = G.createStore(idb);
o.again = (await S2.list()).length;
// no IndexedDB / open fails / open throws / a transaction throws: memory, persistent() false, still works
const M = G.createStore(null);
await M.add(blob(9), {at: 9}); await M.add(blob(8), {at: 10});
o.mem = [await M.persistent(), (await M.list()).map(function(r){ return r.at; }), await M.remove((await M.list())[0].id), (await M.list()).length];
const F = G.createStore(new FakeIDB({failOpen: true}));
await F.add(blob(1), {at: 1});
o.failOpen = [await F.persistent(), (await F.list()).length];
const T = G.createStore(new FakeIDB({throwOpen: true}));
await T.add(blob(1), {at: 1});
o.throwOpen = [await T.persistent(), (await T.list()).length];
const X = G.createStore(new FakeIDB({failTx: true}));
const xr = await X.add(blob(1), {at: 77});
o.failTx = [!!xr.id, await X.persistent(), (await X.list()).map(function(r){ return r.at; })];
// pure helpers
o.name = G.fileName(Date.UTC(2026, 9, 24, 9, 5, 7));
o.cover = [G.coverRect(1600, 900, 300, 400), G.coverRect(100, 100, 50, 50)];
o.step = [G.step(0, 1, 3), G.step(2, 1, 3), G.step(0, -1, 3), G.step(0, 1, 0)];
o.sorted = G.sortRecs([{id: "a", at: 1}, {id: "c", at: 2}, {id: "b", at: 2}, null, {at: 5}]).map(function(r){ return r.id; });
o.queue = window.HQV.hqPhoneQueue.map(function(a){ return [a.id, a.needsCity, a.order]; });
console.log(JSON.stringify(o)); process.exit(0);
""")
        self.assertTrue(out["persistent"])
        self.assertEqual(out["meta"][0]["at"], 1000)
        self.assertEqual(out["meta"][0]["world"], "user:x@3")
        self.assertEqual(out["meta"][1], ["at", "id", "world"])     # the blob is not handed back
        self.assertEqual(out["ids"], [False, False])
        self.assertEqual(out["list"], [[3000, "claude-hq@3", "b2"], [2000, "", "b3"], [1000, "user:x@3", "b1"]])   # newest first
        self.assertEqual(out["get"], "b1")
        self.assertIsNone(out["getNone"])
        self.assertTrue(out["del"])
        self.assertEqual(out["afterDel"], [3000, 1000])
        self.assertEqual(out["capped"], [5000, 4000, 3000])
        self.assertEqual(out["db"], [["hq-gallery", 1], ["hq-gallery"], ["photos"], "id"])
        self.assertEqual(out["opens"], 1)
        self.assertEqual(out["again"], 3)
        self.assertEqual(out["mem"], [False, [10, 9], True, 1])
        self.assertEqual(out["failOpen"], [False, 1])
        self.assertEqual(out["throwOpen"], [False, 1])
        self.assertEqual(out["failTx"], [True, False, [77]])
        self.assertEqual(out["name"], "hq-photo-20261024-090507.png")
        c0 = out["cover"][0]
        self.assertAlmostEqual(c0["sh"], 900)
        self.assertAlmostEqual(c0["sw"], 675)
        self.assertAlmostEqual(c0["sx"], 462.5)
        self.assertEqual(out["cover"][1], {"sx": 0, "sy": 0, "sw": 100, "sh": 100})
        self.assertEqual(out["step"], [1, 0, 2, -1])
        self.assertEqual(out["sorted"], ["c", "b", "a"])
        self.assertEqual(out["queue"], [["camera", True, 60], ["gallery", False, 61]])


@unittest.skipUnless(NODE, "node not installed")
class Apps(unittest.TestCase):
    def test_camera_and_gallery(self):
        out = run(r"""
load();
const G = window.HQV.hqGallery, o = {};
G.store = G.createStore(new FakeIDB());
const SAID = [], SFX = [], SELFIE = [];
let calm = false, shots = 0;
const host = {announce: function(t){ SAID.push(t); }, calm: function(){ return calm; }, reducedMotion: function(){ return false; },
  me: function(){ return {world: "user:x@3"}; }, sfx: function(n){ SFX.push(n); }, selfie: function(on){ SELFIE.push(on); },
  photo: function(){ shots++; return Promise.resolve(blob(100 + shots)); }};
const nav = {open: function(id){ o.opened = id; }, title: function(t){ o.title = t; }};
// Camera
const el = document.body.appendChild(document.createElement("div"));
const cam = window.HQV.hqGallery.render.camera(el, host, nav);
await wait(10);
const vf = cls(el, "hg-vf")[0];
o.vf = [vf.getAttribute("role"), vf.tabIndex, vf.getAttribute("aria-label")];
btn(el, "Take photo").click();
await wait(20);
o.after1 = [(await G.store.list()).length, SFX.slice(), SAID.indexOf("Photo saved to Gallery") >= 0, cls(el, "hg-flash")[0].className];
// Space on the viewfinder takes one; Space on a button is the button's
o.space = [cam.onKey({key: " ", target: vf}), cam.onKey({key: " ", target: btn(el, "Grid lines")})];
await wait(20);
o.after2 = (await G.store.list()).length;
// the 3 s timer, counted aloud; Calm: no flash
calm = true; SAID.length = 0;
btn(el, "3 second timer").click();
o.timerPressed = btn(el, "3 second timer").getAttribute("aria-pressed");
btn(el, "Take photo").click();
o.count = cls(el, "hg-count")[0].textContent;
await wait(3200);
await wait(20);
o.timer = [SAID.slice(0, 3), (await G.store.list()).length, cls(el, "hg-flash")[0].className];
// grid, selfie, undone on close
btn(el, "Grid lines").click();
o.grid = [cls(el, "hg-grid")[0].hidden, btn(el, "Grid lines").getAttribute("aria-pressed")];
btn(el, "Front camera").click();
cam.dispose();
o.selfie = SELFIE;
// Gallery: grid, viewer, next, delete asks first, save
const el2 = document.body.appendChild(document.createElement("div"));
const gal = window.HQV.hqGallery.render.gallery(el2, host, nav);
await wait(20);
o.info = all(el2).filter(function(e){ return e.getAttribute("role") === "status"; })[0].textContent;
const cells = cls(el2, "hg-cell");
o.cells = [cells.length, cells[0].getAttribute("aria-label"), cells.map(function(c){ return c.tabIndex; })];
cells[0].click();
o.viewer = [!!cls(el2, "hg-big")[0], o.title];
btn(el2, "Next photo").click();
o.next = o.title;
o.arrow = [gal.onKey({key: "ArrowLeft", target: el2}), o.title];
btn(el2, "Save to disk").click();
o.saved = CLICKED.slice();
btn(el2, "Delete this photo").click();
const conf = cls(el2, "hg-confirm")[0];
o.confirm = [conf.hidden, conf.getAttribute("role"), (await G.store.list()).length];
btn(conf, "Delete").click();
await wait(30);
o.deleted = [(await G.store.list()).length, SAID.indexOf("Photo deleted") >= 0];
o.esc = gal.onKey({key: "Escape", target: el2});
gal.dispose();
o.revoked = REVOKED.length > 0;
console.log(JSON.stringify(o)); process.exit(0);
""")
        self.assertEqual(out["vf"][0], "img")
        self.assertEqual(out["vf"][1], 0)
        self.assertIn("Space", out["vf"][2])
        self.assertEqual(out["after1"][0], 1)
        self.assertEqual(out["after1"][1], ["shutter"])
        self.assertTrue(out["after1"][2])
        self.assertEqual(out["space"], [True, False])
        self.assertEqual(out["after2"], 2)
        self.assertEqual(out["timerPressed"], "true")
        self.assertEqual(out["count"], "3")
        self.assertEqual(out["timer"][0], ["3", "2", "1"])
        self.assertEqual(out["timer"][1], 3)
        self.assertEqual(out["timer"][2], "hg-flash")          # Calm: no flash
        self.assertEqual(out["grid"], [False, "true"])
        self.assertEqual(out["selfie"], [True, False])         # front camera, then back on close
        self.assertIn("3 photos", out["info"])
        self.assertIn("never uploaded", out["info"])
        self.assertEqual(out["cells"][0], 3)
        self.assertIn("Photo 1 of 3", out["cells"][1])
        self.assertEqual(out["cells"][2], [0, -1, -1])
        self.assertEqual(out["viewer"], [True, "Photo 1 of 3"])
        self.assertEqual(out["next"], "Photo 2 of 3")
        self.assertEqual(out["arrow"], [True, "Photo 1 of 3"])
        self.assertEqual(len(out["saved"]), 1)
        self.assertTrue(out["saved"][0][0].startswith("blob:"))
        self.assertRegex(out["saved"][0][1], r"^hq-photo-\d{8}-\d{6}\.png$")
        self.assertEqual(out["confirm"], [False, "alertdialog", 3])   # asks first; nothing deleted yet
        self.assertEqual(out["deleted"], [2, True])
        self.assertTrue(out["esc"])
        self.assertTrue(out["revoked"])


class Static(unittest.TestCase):
    def test_never_uploads(self):
        src = read("games", "hqgallery.js")
        self.assertNotRegex(src, r"\bfetch\s*\(|XMLHttpRequest|sendBeacon|WebSocket|EventSource")
        self.assertNotRegex(src, r"\.innerHTML|outerHTML|insertAdjacentHTML")
        self.assertNotIn("Math.random", src)
        self.assertIn('"hq-gallery"', src)


if __name__ == "__main__":
    unittest.main()
