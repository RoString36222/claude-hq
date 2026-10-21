"""HQ 3.4 garage manager (games/hqgaragemgr.js): basement <-> common multi-storey transfers.

node: HQV.hqGarageMgr against a fake fetch and a stub DOM. plan() (full, same, starter, lowest free bay, the
out-on-the-street warning, a bay swap), homes() falling back to available:false on 404 / a network error, an
optimistic transfer that rolls back on 409 and emits twice, a successful transfer refreshing hqGarage.mine(true)
and posting only {home[, bay]} with the CSRF header, and the panel built with textContent only (a stub document
that records innerHTML writes; a malicious catalogue name renders as literal text). Skipped without node."""
import json
import os
import shutil
import subprocess
import unittest

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
NODE = shutil.which("node")
A = "a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d"
B = "b1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d"
C = "c1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d"

HARNESS = r"""
import fs from "fs";
const root = %(root)s, A = %(a)s, B = %(b)s, C = %(c)s;
let innerHTMLWrites = 0;
class Node {
  constructor(tag){ this.tagName = String(tag).toUpperCase(); this.children = []; this.parentNode = null; this._text = "";
    this.attrs = {}; this.style = {}; this.listeners = {}; this.hidden = false; this.disabled = false; this.className = ""; this.id = ""; }
  appendChild(c){ if(c.parentNode) c.parentNode.removeChild(c); c.parentNode = this; this.children.push(c); return c; }
  removeChild(c){ this.children = this.children.filter(x => x !== c); c.parentNode = null; return c; }
  get firstChild(){ return this.children[0] || null; }
  set textContent(v){ this.children = []; this._text = String(v); }
  get textContent(){ return this._text + this.children.map(c => c.textContent).join(""); }
  set innerHTML(v){ innerHTMLWrites++; }
  get innerHTML(){ return ""; }
  setAttribute(k, v){ this.attrs[k] = String(v); }
  getAttribute(k){ return k in this.attrs ? this.attrs[k] : null; }
  addEventListener(t, f){ (this.listeners[t] = this.listeners[t] || []).push(f); }
  dispatch(t, ev){ (this.listeners[t] || []).forEach(f => f(Object.assign({target: this, preventDefault(){}, stopPropagation(){}}, ev))); }
  focus(){ doc.activeElement = this; }
  contains(n){ for(let x = n; x; x = x.parentNode) if(x === this) return true; return false; }
  insertAdjacentHTML(){ innerHTMLWrites++; }
}
class Text extends Node { constructor(t){ super("#text"); this._text = t; } }
const doc = {activeElement: null, createElement: t => new Node(t), createTextNode: t => new Text(t),
  getElementById(id){ let f = null; (function w(n){ if(n.id === id) f = n; n.children.forEach(w); })(doc.documentElement); return f; }};
doc.documentElement = new Node("html"); doc.head = doc.documentElement.appendChild(new Node("head")); doc.body = doc.documentElement.appendChild(new Node("body"));
globalThis.document = doc;
globalThis.window = {HQV: {}};
globalThis.CSRF = "tok";
new Function(fs.readFileSync(root + "/games/hqgaragemgr.js", "utf8"))();
const M = window.HQV.hqGarageMgr, calls = [];
let replies = [];
M._io.fetch = (u, o) => {
  calls.push({u, method: (o && o.method) || "GET", body: o && o.body ? JSON.parse(o.body) : null, tok: o && o.headers && o.headers["X-HQ-Token"]});
  const r = replies.shift();
  if(r === "net") return Promise.reject(new Error("down"));
  const [status, body] = r;
  return Promise.resolve({status, ok: status >= 200 && status < 300, json: () => Promise.resolve(body)});
};
let mineCalls = [];
let owned = [{id: A, vehicle_id: "bmw-m2", paint: 1, parked: null}, {id: B, vehicle_id: "ktm-390-duke", paint: 0, parked: null},
             {id: C, vehicle_id: "evil", paint: 0, parked: {world: "claude-hq@2", x: 10.4, z: -3.6, yaw: 0}}];
window.HQV.hqGarage = {cached: () => owned, mine: f => { mineCalls.push(!!f); return Promise.resolve(owned); }, onChange: () => () => {}};
window.HQV.hqVehicles = {load: () => Promise.resolve(window.__cat), get: (cat, id) => cat.vehicles.find(v => v.id === id) || null};
window.__cat = {classes: [{id: "car.coupe", label: "Coupe"}], vehicles: [
  {id: "bmw-m2", "class": "car.coupe", brand: "BMW", model: "M2", spec: {cc: 2993, powerKw: 338, topKmh: 285}, paints: [{name: "Blue", hex: "#1c69d4"}, {name: "Red", hex: "#c43a2a"}]},
  {id: "evil", "class": "car.coupe", brand: "<img src=x onerror=alert(1)>", model: "<b>pwn</b>", spec: {}, paints: [{name: "x", hex: "red;background:url(x)"}]}]};
const out = {};
const tick = () => new Promise(r => setTimeout(r, 0));

// plan
const L = owned, homesB = {[A]: {home: "basement", bay: 0}};
out.planLowest = M.plan(L, {[A]: {home: "basement", bay: 0}}, 4, {id: B, to: "basement"});
out.planFull = M.plan(L, homesB, 1, {id: B, to: "basement"});
out.planSame = M.plan(L, homesB, 4, {id: A, to: "basement"});
out.planSameCp = M.plan(L, homesB, 4, {id: B, to: "carpark"});
out.planStarter = M.plan(L, homesB, 4, {id: "lot:u1:car", to: "carpark"});
out.planUnknown = M.plan(L, homesB, 4, {id: "d1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d", to: "basement"});
out.planOut = M.plan(L, homesB, 4, {id: C, to: "basement"});
out.planGap = M.plan(L, {[A]: {home: "basement", bay: 1}}, 4, {id: B, to: "basement"});
out.planSwap = M.plan(L, {[A]: {home: "basement", bay: 0}, [B]: {home: "basement", bay: 2}}, 4, {id: A, to: "basement", bay: 2});
out.planLocked = M.plan(L, homesB, 4, {id: B, to: "basement", bay: 7});

// homes: 404 -> unavailable
replies.push([404, {detail: "nope"}]);
out.h404 = await M.homes();
out.homeOf404 = M.homeOf(A);
replies.push("net");
out.hNet = await M.homes(true);
// deduped + real
replies.push([200, {homes: {[A]: {home: "basement", bay: 0}, [B]: {home: "carpark", bay: null}, "../x": {home: "basement", bay: 3}}, basement: {max: 4, used: 1}}]);
const p1 = M.homes(true), p2 = M.homes(true);
out.dedup = p1 === p2;
out.h = await p1;
out.homeOfA = M.homeOf(A); out.bayOfA = M.bayOf(A); out.homeOfB = M.homeOf(B); out.bayOfB = M.bayOf(B);

// optimistic transfer, 409 rollback
let emits = []; const un = M.onChange(H => emits.push(JSON.parse(JSON.stringify(H))));
replies.push([409, {detail: "basement full"}]);
mineCalls = [];
try { await M.transfer(B, "basement"); out.rej = null; } catch(e){ out.rej = e; }
out.emits409 = emits.length;
out.optimistic = emits[0] && emits[0].homes[B];
out.rolledBack = M.homeOf(B);
out.after409 = emits[emits.length - 1].basement;

// success
emits = [];
replies.push([200, {ok: true, home: {home: "basement", bay: 1}, basement: {max: 4, used: 2}}]);
mineCalls = [];
out.ok = await M.transfer(B, "basement");
out.okCall = calls[calls.length - 1];
out.mineCalls = mineCalls;
out.bayB = M.bayOf(B);
out.emitsOk = emits.length;
replies.push([200, {ok: true, home: {home: "carpark", bay: null}, basement: {max: 4, used: 1}}]);
await M.transfer(A, "carpark");
out.cpCall = calls[calls.length - 1];
try { await M.transfer("lot:u:car", "carpark"); } catch(e){ out.starterRej = e; }
un();

// panel
let valets = []; window.HQV.hqBasementFx = {valet: (id, to) => valets.push([id, to])};
out.opened = M.open({from: "basement"});
await tick(); await tick();
out.isOpen = M.isOpen();
const dlg = doc.body.children[0].children[0];
out.role = dlg.getAttribute("role"); out.modal = dlg.getAttribute("aria-modal");
out.text = doc.body.textContent;
let swatches = []; (function w(n){ if(n.className === "hqgm-sw") swatches.push(n.style.background); n.children.forEach(w); })(doc.body);
out.swatches = swatches;
let buttons = []; (function w(n){ if(n.tagName === "BUTTON") buttons.push(n); n.children.forEach(w); })(doc.body);
out.buttons = buttons.map(b => b.textContent);
// press "Bring to basement" on B (in common garage now)
const bring = buttons.find(b => b.textContent === "Bring to basement");
replies.push([200, {ok: true, home: {home: "basement", bay: 0}, basement: {max: 4, used: 2}}]);
bring.dispatch("click", {});
await tick(); await tick(); await tick();
out.valets = valets;
// Esc closes
doc.body.children[0].dispatch("keydown", {key: "Escape"});
out.closed = !M.isOpen();
out.innerHTMLWrites = innerHTMLWrites;

// unavailable panel note
M._reset();
window.HQV.hqGarage = {cached: () => owned, mine: () => Promise.resolve(owned), onChange: () => () => {}};
replies.push([404, {}]);
M.open({from: "carpark"});
await tick(); await tick();
let note = null, btns = 0; (function w(n){ if(n.className === "hqgm-note") note = n; if(n.tagName === "BUTTON" && n.textContent !== "Close") btns++; n.children.forEach(w); })(doc.body);
out.noteShown = note && !note.hidden; out.noteText = note && note.textContent; out.transferButtons = btns;
M.close();

// kiosk without a ctx
out.kioskNull = M.kiosk(null, "carpark");
class Obj { constructor(){ this.children = []; this.position = {set(){}}; this.rotation = {}; this.userData = {}; } add(c){ this.children.push(c); } }
let meshes = 0; const mk = () => { meshes++; return new Obj(); };
const kctx = {THREE: {Group: Obj}, mat: () => ({}), emis: () => ({}), cyl: (a,b,c,m,x,y,z,p) => { const o = mk(); p.add(o); return o; },
  box: (w,h,d,m,x,y,z,p) => { const o = mk(); p.add(o); return o; }, canvasTex: (w, h, d) => ({t: {}}), screen: () => mk(), glow: () => new Obj()};
const K = M.kiosk(kctx, "basement");
out.kiosk = {hits: K.hits.length, doors: K.hits.every(h => h.userData.door === K.door && h.userData.tip === "Garage manager"),
  gDoor: K.g.userData.door.view, from: K.door.from, meshes};
console.log(JSON.stringify(out));
"""


@unittest.skipUnless(NODE, "node not installed")
class HqGarageMgr(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        src = HARNESS % {"root": json.dumps(ROOT), "a": json.dumps(A), "b": json.dumps(B), "c": json.dumps(C)}
        r = subprocess.run([NODE, "--input-type=module", "-e", src], capture_output=True, text=True, timeout=60)
        if r.returncode != 0:
            raise AssertionError(r.stderr[-3000:])
        cls.o = json.loads(r.stdout.strip().splitlines()[-1])

    def test_plan(self):
        o = self.o
        self.assertEqual(o["planLowest"], {"ok": True, "bay": 1})
        self.assertEqual(o["planGap"]["bay"], 0, "the lowest free bay")
        self.assertEqual(o["planFull"], {"ok": False, "reason": "full"})
        self.assertEqual(o["planSame"]["reason"], "same")
        self.assertEqual(o["planSameCp"]["reason"], "same")
        self.assertEqual(o["planStarter"], {"ok": False, "reason": "starter"})
        self.assertEqual(o["planUnknown"]["reason"], "unknown")
        self.assertTrue(o["planOut"]["ok"])
        self.assertEqual(o["planOut"]["reason"], "out", "a warning, not a block")
        self.assertIn("brings it home", o["planOut"]["warn"])
        self.assertEqual(o["planSwap"], {"ok": True, "bay": 2, "swap": {"id": B, "bay": 0}})
        self.assertEqual(o["planLocked"]["reason"], "full", "a bay beyond max is locked")

    def test_homes_falls_back(self):
        self.assertEqual(self.o["h404"], {"available": False, "homes": {}, "basement": {"max": 0, "used": 0}})
        self.assertEqual(self.o["homeOf404"], "carpark")
        self.assertFalse(self.o["hNet"]["available"])

    def test_homes_cleaned_and_deduped(self):
        o = self.o
        self.assertTrue(o["dedup"])
        self.assertEqual(sorted(o["h"]["homes"].keys()), sorted([A, B]), "a bad id is dropped")
        self.assertEqual((o["homeOfA"], o["bayOfA"], o["homeOfB"], o["bayOfB"]), ("basement", 0, "carpark", None))

    def test_optimistic_rollback(self):
        o = self.o
        self.assertEqual(o["emits409"], 2, "optimistic emit, then the rollback")
        self.assertEqual(o["optimistic"], {"home": "basement", "bay": 1})
        self.assertEqual(o["rolledBack"], "carpark")
        self.assertEqual(o["after409"], {"max": 4, "used": 1})
        self.assertEqual(o["rej"]["code"], "full")
        self.assertNotIn("basement full", o["rej"]["msg"].lower().replace("your basement is full", ""), "a mapped message")

    def test_transfer_posts_clean_body_and_refreshes(self):
        o = self.o
        c = o["okCall"]
        self.assertEqual((c["u"], c["method"], c["tok"]), ("/api/arena/vehicles/" + B + "/home", "POST", "tok"))
        self.assertEqual(c["body"], {"home": "basement"})
        self.assertEqual(o["cpCall"]["body"], {"home": "carpark"})
        self.assertIn(True, o["mineCalls"], "hqGarage.mine(true)")
        self.assertEqual(o["bayB"], 1)
        self.assertEqual(o["emitsOk"], 2)
        self.assertEqual(o["starterRej"]["code"], "starter")

    def test_panel_text_only(self):
        o = self.o
        self.assertTrue(o["opened"] and o["isOpen"])
        self.assertEqual((o["role"], o["modal"]), ("dialog", "true"))
        self.assertEqual(o["innerHTMLWrites"], 0)
        self.assertIn("<b>pwn</b>", o["text"], "a malicious name is literal text")
        self.assertIn("Basement (B1) 1/4", o["text"])
        self.assertIn("Common multi-storey", o["text"])
        self.assertIn("Starter (showcase)", o["text"])
        self.assertIn("Out — near claude hq (10, -4)", o["text"])
        self.assertNotIn("tok", o["text"])
        self.assertIn("#c43a2a", o["swatches"], "paint index -> catalogue hex")
        self.assertNotIn("red;background:url(x)", o["swatches"])
        self.assertIn("Send to common garage", o["buttons"])
        self.assertIn("Bring to basement", o["buttons"])
        self.assertEqual(o["valets"], [[A, "basement"]], "A is in the common garage now")
        self.assertTrue(o["closed"])

    def test_unavailable_note(self):
        self.assertTrue(self.o["noteShown"])
        self.assertEqual(self.o["noteText"], "Garage transfers need the newer Arena")
        self.assertEqual(self.o["transferButtons"], 0)

    def test_kiosk_door(self):
        k = self.o["kioskNull"]
        self.assertEqual(k["door"]["view"], "garage:open")
        self.assertEqual(k["door"]["from"], "carpark")
        self.assertEqual(k["door"]["tip"], "Garage manager")
        self.assertEqual(k["hits"], [])
        k = self.o["kiosk"]
        self.assertEqual((k["hits"], k["doors"], k["gDoor"], k["from"]), (3, True, "garage:open", "basement"))
        self.assertLessEqual(k["meshes"], 6, "a handful of draw calls")


class Source(unittest.TestCase):
    def test_no_innerhtml_or_random(self):
        with open(os.path.join(ROOT, "games", "hqgaragemgr.js"), encoding="utf-8") as f:
            src = f.read()
        self.assertNotIn("innerHTML", src)
        self.assertNotIn("Math.random", src)
        self.assertNotIn("let ", src)
        self.assertNotIn("const ", src)


if __name__ == "__main__":
    unittest.main()
