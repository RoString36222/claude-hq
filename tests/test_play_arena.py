"""City play: the Arena games (games/playarena.js, HQ 3.22): co-op deliveries, Cops & robber and ghost races.

Under node on the @3 fixture with the real City play core and the real jobs, police heat and races features, two fake
players ("ann" and "bob", each their own City instance) whose presence goes through the same check the page uses
(readNet, after a JSON round trip) and whose ghost frames are delivered by hand: every new presence field is validated
(oversize, bad charset, out of range, wrong shape), a co-op job round trips (the partner starts the same job, either
drop advances it for both, both are paid), Cops & robber is won by a bust, by lasting three minutes and by staying out
of sight for 30 s, and a ghost race swaps ghosts only between the two in it. And the page, hq3d.js and the Arena carry
exactly these fields behind the "cityplay" capability. Skipped without node."""
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


SCRIPT = r"""
var fs = require("fs"), zlib = require("zlib"), root = %(root)s;
global.window = {HQV: {}};
for (var f of ["world", "worldgeom", "hqnav", "citylife", "cityplay", "playjobs", "playheat", "playraces", "playarena"])
  new Function(fs.readFileSync(root + "/games/" + f + ".js", "utf8"))();
var H = window.HQV, WD = H.world, CP = H.cityPlay, A = H.playArena, out = {};
var W = WD.pack(JSON.parse(zlib.gunzipSync(fs.readFileSync(root + "/tests/fixtures/claude-hq@3.json.gz")).toString("utf8")));

/* ---- the wire checks ---- */
var long = "x".repeat(65);
out.write = {
  good: [A.writeNet({pk: 1, pi: "bob", pq: [2, 0, 10, -20, 30, 40]}), A.writeNet({pk: 2, pj: "ann_1"}), A.writeNet({pk: 2, pq: [1, 3, 180]}),
         A.writeNet({pk: 3, pq: [16777215, 360000]}), A.writeNet({pk: 1, pq: [3, 5]})],
  bad: [{pk: 0}, {pk: 4}, {pk: 1.5}, {pk: "1"}, {pi: "bob"}, {pk: 1, pi: ""}, {pk: 1, pi: "a b"}, {pk: 1, pi: long}, {pk: 1, pi: "<b>"},
        {pk: 1, pi: "a", pj: "b"}, {pk: 1, pj: 7}, {pk: 1, pq: []}, {pk: 1, pq: [1, 0, 1]}, {pk: 1, pq: [4, 0]}, {pk: 1, pq: [1, 6]},
        {pk: 1, pq: [1, 0, 10241, 0, 0, 0]}, {pk: 1, pq: [1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]}, {pk: 1, pq: [1, 0.5]},
        {pk: 2, pq: [4, 0, 0]}, {pk: 2, pq: [1, 6, 0]}, {pk: 2, pq: [1, 1, 181]}, {pk: 2, pq: [1, 1]},
        {pk: 3, pq: [16777216, 0]}, {pk: 3, pq: [0, 360001]}, {pk: 3, pq: [-1, 0]}, {pk: 3, pq: ["1", 0]}].map(function(o){ return A.writeNet(o); })
};
out.read = {
  good: A.readNet({u: "x", pk: 1, pi: "bob", pq: [1, 0, 1, 2, 3, 4]}),
  none: A.readNet({u: "x", x: 1}),
  bad: [{pk: 1, pi: "<script>"}, {pk: 1, pj: long}, {pk: 9}, {pk: 1, pq: "1,2"}, {pk: 1, pq: [1, 0, 1, 2, 3]}, {pk: 3, pq: [1.5, 0]},
        {pk: 2, pi: "a", pj: "b"}, {pk: 1, pq: [1, 0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]}].map(function(o){ return A.readNet(o); })
};
out.ghost = {ok: A.ghostOk("sprint-1a", "g1:1,-2,a", 100),
  bad: [A.ghostOk("sprint/1", "g1:1", 100), A.ghostOk("x".repeat(41), "g1:1", 100), A.ghostOk("r", "g1:1", 0), A.ghostOk("r", "g1:1", 360001),
        A.ghostOk("r", "g1:A", 1), A.ghostOk("r", "g1:<b>", 1), A.ghostOk("r", "g2:1", 1), A.ghostOk("r", "g1:" + "1".repeat(12000), 1), A.ghostOk("r", "g1:1", 1.5)]};
out.judge = [A.tagJudge({t: 10, unseen: 5}), A.tagJudge({t: 180, unseen: 0}), A.tagJudge({t: 20, unseen: 30}), A.tagJudge({t: 200, busted: true})];
var sp = {kind: "van", from: {x: 12.34, z: -56.78}, stops: [{x: 1, z: 2}, {x: -1023.9, z: 1024}]};
out.pq = A.jobToPq(sp, 1); out.back = A.pqToJob(out.pq);

/* ---- two players ---- */
var ms = Date.UTC(2026, 9, 26, 12);
function player(id, nm){
  var P = {id: id, n: nm, me: {x: 0, y: 0, z: 0, yaw: 0}, motion: {speed: 0, ride: null}, toasts: [], tele: [], other: null, ghosts: []};
  P.c = {players: function(){
           var o = P.other; if(!o) return [];
           var raw = JSON.parse(JSON.stringify(Object.assign({u: o.id, n: o.n, x: Math.round(o.me.x*100), z: Math.round(o.me.z*100)}, o.arena.net() || {})));
           return [{u: raw.u, n: raw.n, x: raw.x/100, z: raw.z/100, play: A.readNet(raw)}];
         },
         teleport: function(x, z){ P.tele.push([x, z]); P.me.x = x; P.me.z = z; }};
  P.api = {me: function(){ return id; }, netCan: function(c){ return c === "cityplay"; }, toast: function(t){ P.toasts.push(t); },
           playGhost: function(to, r, g, t){ if(!A.ghostOk(r, g, t)) return false; P.ghosts.push({to: to, r: r, g: g, t: t}); return true; }};
  P.play = CP.create(null, {W: W, worldId: W.id, c: P.c, api: P.api, blocked: function(){ return false; }, groundY: function(){ return 0; }});
  P.arena = P.play.feature("arena"); P.jobs = P.play.feature("jobs"); P.heat = P.play.feature("heat"); P.races = P.play.feature("races");
  return P;
}
function pair(){ var a = player("ann", "Ann"), b = player("bob", "Bob"); a.other = b; b.other = a; return [a, b]; }
// deliver queued ghost frames as the Arena would ({type, from, r, g, t})
function relay(a, b){
  [[a, b], [b, a]].forEach(function(x){ var q = x[0].ghosts.splice(0); q.forEach(function(m){ if(m.to === x[1].id) x[1].arena.onGhost({type: "ghost", from: {userId: x[0].id, displayName: x[0].n}, r: m.r, g: m.g, t: m.t}); }); });
}
function step(ps, secs){
  for(var i = 0; i < Math.round(secs*20); i++){
    ms += 50;
    ps.forEach(function(P){ P.play.update(0.05, {ms: ms, local: ms, me: P.me, motion: Object.assign({yaw: 0}, P.motion)}); });
    relay(ps[0], ps[1]);
  }
}
function at(P, p){ P.me.x = p.x; P.me.z = p.z; }

/* co-op delivery */
(function(){
  var ab = pair(), a = ab[0], b = ab[1], o = out.coop = {};
  step(ab, 0.1);
  var offer = a.jobs.offers().filter(function(x){ return x.kind === "delivery" && x.stops.length >= 2; })[0] || a.jobs.offers().filter(function(x){ return x.kind === "delivery"; })[0];
  o.offer = !!offer;
  o.noJob = a.arena.invite("bob", 1).reason;
  a.jobs.start(offer.id);
  at(b, {x: a.me.x + 200, z: a.me.z}); o.far = a.arena.invite("bob", 1).reason;
  at(b, {x: a.me.x + 10, z: a.me.z});
  o.inv = a.arena.invite("bob", 1).ok;
  step(ab, 0.2);
  o.netA = a.arena.net();
  o.invites = b.arena.invites().map(function(i){ return [i.u, i.kind, i.ok]; });
  o.acc = b.arena.accept("ann").ok;
  var sa = a.jobs.spec(), sb = b.jobs.spec();
  o.same = sb && sb.kind === sa.kind && sb.stops.length === sa.stops.length && Math.hypot(sb.from.x - sa.from.x, sb.from.z - sa.from.z) < 1.5 &&
           sb.stops.every(function(s, i){ return Math.hypot(s.x - sa.stops[i].x, s.z - sa.stops[i].z) < 1.5; });
  step(ab, 0.3);
  o.member = a.arena.state().members.map(function(m){ return m.u; });
  o.netB = b.arena.net();
  // bob picks up, ann drops the first parcel, bob the rest
  at(b, sb.from); step(ab, 0.5); o.after1 = [a.jobs.spec().step, b.jobs.spec().step];
  at(a, sa.stops[0]); step(ab, 0.5); o.after2 = [a.jobs.spec() ? a.jobs.spec().step : "done", b.jobs.spec() ? b.jobs.spec().step : "done"];
  for(var k = 1; k < sb.stops.length; k++){ at(b, sb.stops[k]); step(ab, 0.5); }
  step(ab, 0.5);
  o.done = [a.jobs.stats().done.delivery, b.jobs.stats().done.delivery];
  o.rep = [a.jobs.stats().rep, b.jobs.stats().rep];
  step(ab, 7);
  o.ended = [a.arena.state(), b.arena.state(), a.arena.net(), b.arena.net()];
})();

/* Cops & robber: a bust */
function tagGame(o, place){
  var ab = pair(), a = ab[0], b = ab[1];
  step(ab, 0.1);
  at(b, {x: a.me.x + 20, z: a.me.z});
  o.inv = a.arena.invite("bob", 2).ok;
  step(ab, 0.2);
  o.acc = b.arena.accept("ann").ok;
  step(ab, 0.5);
  o.phase = a.arena.state().phase; o.stars = a.heat.stars(); o.cops = a.heat.chasers().length;
  o.copSees = b.arena.net();
  o.robberNet = a.arena.net();
  place(a, b, o);
  o.robber = a.arena.state(); o.cop = b.arena.state();
  o.toastsA = a.toasts.slice(-2); o.toastsB = b.toasts.slice(-2);
  o.repA = a.play.ctx.store.get("rep", 0); o.repB = b.play.ctx.store.get("rep", 0);
  step(ab, 7);
  o.over = [a.arena.state(), b.arena.state(), a.heat.stars()];
  return o;
}
out.bust = tagGame({}, function(a, b, o){
  at(b, {x: a.me.x + 2, z: a.me.z}); a.motion.speed = 0;
  step([a, b], 2); o.notYet = a.arena.state().phase;
  step([a, b], 3);
  o.final = a.arena.net(); o.tele = a.tele.length;
});
out.time = tagGame({}, function(a, b, o){
  at(b, {x: a.me.x + 40, z: a.me.z}); a.motion = {speed: 6, ride: null};
  step([a, b], 100); o.mid = [a.arena.state().phase, a.heat.stars()];
  step([a, b], 82);
});
out.lost = tagGame({}, function(a, b, o){
  at(b, {x: a.me.x + 400, z: a.me.z}); a.motion = {speed: 6, ride: null};
  step([a, b], 25); o.mid = a.arena.state().phase;
  step([a, b], 7);
});

/* ghost race */
(function(){
  var ab = pair(), a = ab[0], b = ab[1], o = out.ghostRace = {};
  var R = a.races.routes(), r = R[0], K = "races:" + a.play.ctx.seed + ":";
  var gA = H.playRaces.encodeGhost([{x: 1, z: 2, yaw: 0}, {x: 2, z: 3, yaw: 0.1}, {x: 3, z: 4, yaw: 0.2}]);
  var gB = H.playRaces.encodeGhost([{x: 5, z: 2, yaw: 0}, {x: 6, z: 3, yaw: 0.1}, {x: 7, z: 4, yaw: 0.2}]);
  step(ab, 0.1);
  at(b, {x: a.me.x + 5, z: a.me.z});
  o.noGhost = a.arena.invite("bob", 3, {route: r.id}).reason;
  a.play.ctx.store.set(K + "ghost:" + r.id, gA); a.play.ctx.store.set(K + "best:" + r.id, {t: 61.25, splits: [], at: 0});
  b.play.ctx.store.set(K + "ghost:" + r.id, gB); b.play.ctx.store.set(K + "best:" + r.id, {t: 59.5, splits: [], at: 0});
  o.badRoute = a.arena.invite("bob", 3, {route: "../x"}).reason;
  o.inv = a.arena.invite("bob", 3, {route: r.id}).ok;
  step(ab, 0.2);
  o.invites = b.arena.invites().map(function(i){ return [i.kind, i.route === r.id]; });
  // a ghost from someone not in a race with you is ignored
  o.stranger = b.arena.onGhost({type: "ghost", from: {userId: "eve"}, r: r.id, g: gA, t: 100});
  o.acc = b.arena.accept("ann").ok;
  step(ab, 0.5);
  o.loadedB = b.toasts.some(function(t){ return /Ann's ghost \(1:01.3\)/.test(t); });
  o.loadedA = a.toasts.some(function(t){ return /Bob's ghost \(0:59.5\)/.test(t); });
  o.netA = a.arena.net(); o.netB = b.arena.net(); o.hash = A.routeHash(r.id);
  o.wrongRoute = a.arena.onGhost({type: "ghost", from: {userId: "bob"}, r: R[1].id, g: gB, t: 100});
  o.badChars = a.arena.onGhost({type: "ghost", from: {userId: "bob"}, r: r.id, g: "g1:<img>", t: 100});
  o.theirBest = a.arena.state().members[0].best;
  b.arena.leave(); step(ab, 0.5);
  o.afterLeave = [a.arena.state().members.length, b.arena.net()];
})();

console.log(JSON.stringify(out));
"""


@unittest.skipUnless(NODE, "node not installed")
class PlayArena(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        r = subprocess.run([NODE, "-e", SCRIPT % {"root": json.dumps(ROOT)}], capture_output=True, text=True, timeout=300)
        if r.returncode:
            raise AssertionError(r.stderr[-3000:])
        cls.o = json.loads(r.stdout.strip().splitlines()[-1])

    def test_every_field_is_checked_on_the_way_out_and_in(self):
        w = self.o["write"]
        self.assertTrue(all(w["good"]), w["good"])
        self.assertEqual(w["bad"], [None]*len(w["bad"]))
        r = self.o["read"]
        self.assertEqual(r["good"], {"pk": 1, "pi": "bob", "pj": None, "pq": [1, 0, 1, 2, 3, 4]})
        self.assertIsNone(r["none"])
        self.assertEqual(r["bad"], [None]*len(r["bad"]))
        self.assertTrue(self.o["ghost"]["ok"])
        self.assertEqual(self.o["ghost"]["bad"], [False]*len(self.o["ghost"]["bad"]))

    def test_job_places_go_in_decimetres(self):
        self.assertEqual(self.o["pq"], [3, 1, 123, -568, 10, 20, -10239, 10240])
        self.assertEqual(self.o["back"], {"kind": "van", "step": 1, "from": {"x": 12.3, "z": -56.8}, "stops": [{"x": 1, "z": 2}, {"x": -1023.9, "z": 1024}]})

    def test_tag_judge(self):
        self.assertEqual(self.o["judge"], [None, {"phase": 2, "why": "time"}, {"phase": 2, "why": "lost"}, {"phase": 3, "why": "busted"}])

    def test_coop_round_trip(self):
        o = self.o["coop"]
        self.assertTrue(o["offer"])
        self.assertEqual(o["noJob"], "nojob")
        self.assertEqual(o["far"], "far")
        self.assertTrue(o["inv"])
        self.assertEqual(o["netA"]["pk"], 1)
        self.assertEqual(o["netA"]["pi"], "bob")
        self.assertEqual(o["netA"]["pq"][0], 2)          # a delivery
        self.assertEqual(o["invites"], [["ann", 1, True]])
        self.assertTrue(o["acc"])
        self.assertTrue(o["same"], "the partner runs the same job")
        self.assertEqual(o["member"], ["bob"])
        self.assertEqual(o["netB"], {"pk": 1, "pj": "ann", "pq": [2, 0]})
        self.assertEqual(o["after1"], [1, 1], "bob's pickup counts for ann")
        self.assertEqual(o["after2"][0], o["after2"][1], "ann's drop counts for bob")
        self.assertEqual(o["done"], [1, 1])
        self.assertTrue(o["rep"][0] > 0 and o["rep"][1] > 0, o["rep"])
        self.assertEqual(o["ended"], [None, None, None, None])

    def test_tag_bust(self):
        o = self.o["bust"]
        self.assertTrue(o["inv"] and o["acc"])
        self.assertEqual(o["phase"], 1)
        self.assertGreaterEqual(o["stars"], 2)
        self.assertEqual(o["cops"], 0, "no police cars: the players are the police")
        self.assertEqual(o["copSees"], {"pk": 2, "pj": "ann"})
        self.assertEqual(o["robberNet"]["pq"][:2], [1, 2])
        self.assertEqual(o["notYet"], 1)
        self.assertEqual(o["final"]["pq"][0], 3)
        self.assertEqual(o["tele"], 1, "busted: to the station")
        self.assertEqual(o["repA"], 0, "a game costs the robber no rep")
        self.assertEqual(o["repB"], 3)
        self.assertEqual(o["over"], [None, None, 0])

    def test_tag_robber_lasts_three_minutes(self):
        o = self.o["time"]
        self.assertEqual(o["mid"], [1, 3])
        self.assertEqual(o["robber"]["phase"], 2)
        self.assertEqual(o["robber"]["why"], "time")
        self.assertEqual(o["repA"], 5)
        self.assertEqual(o["repB"], 0)
        self.assertTrue(any("got away" in t for t in o["toastsB"]), o["toastsB"])

    def test_tag_robber_out_of_sight(self):
        o = self.o["lost"]
        self.assertEqual(o["mid"], 1)
        self.assertEqual(o["robber"]["phase"], 2)
        self.assertEqual(o["robber"]["why"], "lost")

    def test_ghost_race_swaps_ghosts_only_between_its_players(self):
        o = self.o["ghostRace"]
        self.assertEqual(o["noGhost"], "route")
        self.assertEqual(o["badRoute"], "route")
        self.assertTrue(o["inv"])
        self.assertEqual(o["invites"], [[3, True]])
        self.assertFalse(o["stranger"])
        self.assertTrue(o["acc"])
        self.assertTrue(o["loadedB"] and o["loadedA"])
        self.assertEqual(o["netA"], {"pk": 3, "pq": [o["hash"], 6125]})
        self.assertEqual(o["netB"], {"pk": 3, "pj": "ann", "pq": [o["hash"], 5950]})
        self.assertFalse(o["wrongRoute"])
        self.assertFalse(o["badChars"])
        self.assertEqual(o["theirBest"], 5950)
        self.assertEqual(o["afterLeave"], [0, None])


@unittest.skipUnless(NODE, "node not installed")
class ArenaApp(unittest.TestCase):
    def test_the_app_invites_and_accepts_by_keyboard_reachable_buttons(self):
        import sys
        sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
        from test_hqphone import DOM
        script = DOM + r"""
import zlib from "zlib";
const R = %(root)s;
for (const f of ["world", "worldgeom", "hqnav", "citylife", "cityplay", "hqphone", "hqphoneapps", "playjobs", "playheat", "playraces", "playarena"]) load("games/" + f + ".js");
const HQV = window.HQV, o = {};
const W = HQV.world.pack(JSON.parse(zlib.gunzipSync(fs.readFileSync(R + "/tests/fixtures/claude-hq@3.json.gz")).toString("utf8")));
// eve stands 12 m away and invites you to Cops & robber (her name is markup: it must stay text)
const eve = {u: "eve", n: "<img src=x>", x: 12, z: 0, play: HQV.playArena.readNet({pk: 2, pi: "me_1", pq: [0, 0, 180]})};
const toasts = [];
const live = HQV.cityPlay.create(null, {W: W, c: {players: function(){ return [eve]; }}, api: {me: function(){ return "me_1"; }, netCan: function(c){ return c === "cityplay"; }, toast: function(t){ toasts.push(t); }},
                                         blocked: function(){ return false; }, groundY: function(){ return 0; }});
const T0 = Date.UTC(2026, 9, 26, 8, 15);
live.update(0.05, {ms: T0, local: T0, me: {x: 0, y: 0, z: 0, yaw: 0}, motion: {ride: null, speed: 0}});
const app = HQV.hqPhone.registry.get("arena");
o.app = app ? [app.name, app.needsCity] : null;
const said = [], nav = {close: function(){ o.closed = true; }, back: function(){}, open: function(){}, title: function(){}, setBadge: function(){}};
const el = document.body.appendChild(document.createElement("div"));
const h = app.render(el, {announce: function(t){ said.push(t); }}, nav);
const btns = el.querySelectorAll("button");
o.labels = btns.map(function(b){ return b.textContent; });
o.markup = el.querySelectorAll("img").length;
o.toast = toasts.length;
const acc = btns.filter(function(b){ return b.textContent === "Accept"; })[0];
o.accDisabled = acc.disabled;
acc.click();
o.said = said.slice(); o.state = HQV.playArena.live().state();
o.net = HQV.playArena.net();
h.tick(); h.dispose(); live.dispose();
console.log(JSON.stringify(o));
"""
        r = subprocess.run([NODE, "--input-type=module", "-"], input=script.replace("%(root)s", json.dumps(ROOT)),
                           capture_output=True, text=True, cwd=ROOT, timeout=120, env=dict(os.environ, TZ="UTC"))
        if r.returncode:
            raise AssertionError(r.stderr[-3000:])
        o = json.loads(r.stdout.strip().splitlines()[-1])
        self.assertEqual(o["app"], ["Arena play", True])
        for t in ("Leave game", "Accept", "Decline", "Co-op job", "Cops & robber", "Ghost race"):
            self.assertIn(t, o["labels"])
        self.assertEqual(o["markup"], 0)
        self.assertEqual(o["toast"], 1)
        self.assertFalse(o["accDisabled"])
        self.assertEqual(o["state"]["role"], "guest")
        self.assertEqual(o["state"]["kind"], 2)
        self.assertEqual(o["net"], {"pk": 2, "pj": "eve"})


class Wiring(unittest.TestCase):
    def test_the_page_sends_only_checked_fields_behind_the_capability(self):
        ui = read("ui", "app", "22-hq.js")
        self.assertIn('var pg = hqNetCan("cityplay") && HQ3D.inst.playNet ? HQ3D.inst.playNet() : null;', ui)
        self.assertIn('+","+[msg.pk,msg.pi,msg.pj,JSON.stringify(msg.pq||0)].join(",")', ui)   # a change goes at once
        body = ui[ui.index("function hqPlayGhost"):ui.index("function hqPlayWatch")]
        self.assertIn('hqNetCan("cityplay")', body)
        self.assertIn("g.length>12000", body)
        self.assertIn('/^g1:[0-9a-z,-]*$/', body)

    def test_hq3d_checks_on_receipt(self):
        hq = read("games", "hq3d.js")
        self.assertIn("P.play = HQV.playArena && HQV.playArena.readNet ? HQV.playArena.readNet(p) : null;", hq)
        self.assertIn("inst.playNet = function(){", hq)

    def test_the_arena_lists_and_checks_it(self):
        proto = read("backend", "src", "protocol.rs")
        self.assertEqual(len(re.findall(r'"phone", "cityplay", "convoy"', proto)), 2)
        hq = read("backend", "src", "valley", "hq.rs")
        self.assertIn("fn read_play(", hq)
        self.assertIn("pub const PLAY_Q_LEN: usize = 12;", hq)
        main = read("backend", "src", "main.rs")
        self.assertIn('if kind == Some("ghost") {', main)
        cp = read("backend", "src", "cityplay.rs")
        self.assertIn("pub const GHOST_MAX: usize = 12_000;", cp)

    def test_the_privacy_note(self):
        self.assertIn("cityplay", read("AGENTS.md"))


if __name__ == "__main__":
    unittest.main()
