"""The boombox (ui/app/39-boombox.js, HQ 3.11): what presence carries while your Music room song plays,
how loud a boombox is with distance, and which one this page plays (the nearest in range on your floor,
never the song you already hear, nothing when it is out of range).

node loads the module against a small fake DOM and fake HQ3D / HQNET / MU (one node process for the
whole file). Skipped when node is not installed. Stdlib only."""
import json
import os
import shutil
import subprocess
import unittest

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
NODE = shutil.which("node")

HARNESS = r"""
var fs = require("fs"), root = %(root)s, out = {};
var frames = [], toasts = [];
function Frame(){ this.style = {}; this.listeners = {}; this.parentNode = null; this.contentWindow = {postMessage: function(){}}; }
Frame.prototype.addEventListener = function(k, f){ this.listeners[k] = f; };
Frame.prototype.setAttribute = function(){};
global.window = global; window.addEventListener = function(){};
global.document = {createElement: function(){ return new Frame(); },
                   body: {appendChild: function(f){ f.parentNode = this; frames.push(f); }, removeChild: function(f){ f.parentNode = null; }}};
global.location = {origin: "http://127.0.0.1:8765"};
global.setInterval = function(){ return 0; }; global.clearInterval = function(){};
global.toast = function(m){ toasts.push(m); };
global.VIEW = "hq";
var me = {world: "city3d", x: 0, z: 0, yaw: 0};
var boomOn = null;
global.HQ3D = {inst: {where: function(){ return me; }, setBoombox: function(on){ boomOn = on; }}};
global.HQNET = {peers: []};
global.MU = {tuned: false, st: null, offset: 0, volume: 80};
require("vm").runInThisContext(fs.readFileSync(root + "/ui/app/39-boombox.js", "utf8"));

var now = Date.now();
// Nothing playing: no boombox, nothing in presence.
boomTick();
out.idle = {net: boomNet(), on: boomOn};
// Tuned in and playing: the room song rides presence; paused or untuned: it does not.
MU.tuned = true; MU.st = {cur: {v: "dQw4w9WgXcQ", title: "x".repeat(200)}, playing: true, startAt: now - 5000.4};
out.playing = boomNet(); boomTick(); out.on = boomOn;
MU.st.playing = false; out.paused = boomNet();
MU.st.playing = true; MU.st.cur.v = "not an id"; out.badId = boomNet();
MU.tuned = false; boomTick(); out.offAgain = boomOn;
// The volume curve.
out.gain = [0, 4, 10, 20, 28, 40].map(function(d){ return Math.round(boomGain(d)*1000)/1000; });
// Peers: the nearest boombox on your floor, in range.
function peer(u, x, z, bb, w){ return {u: u, n: u, w: w || "city3d", x: x*100, z: z*100, bb: bb, bt: now - 1000, bn: "song " + u}; }
HQNET.peers = [peer("far", 25, 0, "aaaaaaaaaaa"), peer("near", 6, 0, "bbbbbbbbbbb"), peer("elsewhere", 1, 0, "ccccccccccc", "city3d:x"), {u: "none", w: "city3d", x: 0, z: 0}];
boomTick();
out.pick = {u: BOOM.u, v: BOOM.v, frames: frames.length, src: frames[0] && frames[0].src.split("?")[0], toasts: toasts.slice()};
// The one playing keeps the lead over one barely closer.
HQNET.peers = [peer("near", 6, 0, "bbbbbbbbbbb"), peer("close", 5, 0, "ddddddddddd")];
boomTick(); out.sticky = BOOM.u;
// The song you already hear from the Music tab is not played twice.
MU.tuned = true; MU.st = {cur: {v: "bbbbbbbbbbb", title: "t"}, playing: true, startAt: now};
HQNET.peers = [peer("near", 6, 0, "bbbbbbbbbbb")];
boomTick(); out.dupe = {frame: !!BOOM.frame};
MU.tuned = false;
// Out of range: nothing plays.
HQNET.peers = [peer("far", 40, 0, "aaaaaaaaaaa")];
boomTick(); out.far = {frame: !!BOOM.frame};
// Not in the HQ view: nothing plays.
HQNET.peers = [peer("near", 6, 0, "bbbbbbbbbbb")]; VIEW = "music";
boomTick(); out.view = {frame: !!BOOM.frame};
// Live sets (3.13.1): a DJ near you is heard live, quieter further off; walking away stops it.
VIEW = "hq"; MU.tuned = false; MU.st = null;
var listens = [], stops = 0, drawnLive = null;
global.muListen = function(peer){ listens.push(peer); MU.listen = {peer: peer, audio: {volume: 1}}; };
global.muListenStop = function(){ stops++; MU.listen = null; };
HQ3D.inst.setBoomLive = function(m){ drawnLive = m; };
MU.lives = {pA: {userId: "dj", who: "DJ"}};
HQNET.peers = [{u: "dj", n: "dj", w: "city3d", x: 1000, z: 0}];
boomTick(); out.live1 = {listens: listens.slice(), drawn: drawnLive, frame: !!BOOM.frame};
boomTick(); out.live1.vol = Math.round(MU.listen.audio.volume*1000)/1000;
HQNET.peers = [{u: "dj", n: "dj", w: "city3d", x: 4000, z: 0}];
boomTick(); out.live2 = {stops: stops, listen: MU.listen};
// a set you chose to listen to in the Music tab is left alone
MU.listen = {peer: "pA", audio: {volume: 1}};
HQNET.peers = [{u: "dj", n: "dj", w: "city3d", x: 1000, z: 0}];
boomTick(); out.manual = {listens: listens.length, vol: MU.listen.audio.volume, stops: stops};
// your own live set puts the boombox on you
MU.listen = null; MU.dj = {}; HQNET.peers = []; boomTick(); out.liveMe = {on: boomOn, net: boomNet()};
process.stdout.write(JSON.stringify(out));
"""


@unittest.skipUnless(NODE, "node is not installed")
class BoomboxTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        src = HARNESS % {"root": json.dumps(ROOT)}
        r = subprocess.run([NODE, "-e", src], capture_output=True, text=True, timeout=60)
        if r.returncode:
            raise AssertionError(r.stderr)
        cls.out = json.loads(r.stdout)

    def test_presence_carries_the_room_song_only_while_it_plays(self):
        o = self.out
        self.assertIsNone(o["idle"]["net"])
        self.assertFalse(o["idle"]["on"])
        p = o["playing"]
        self.assertEqual(p["bb"], "dQw4w9WgXcQ")
        self.assertIsInstance(p["bt"], int)
        self.assertEqual(len(p["bn"]), 80)               # the Arena's cap
        self.assertTrue(o["on"])
        self.assertIsNone(o["paused"])
        self.assertIsNone(o["badId"])
        self.assertFalse(o["offAgain"])

    def test_it_gets_quieter_with_distance_and_stops_at_the_edge(self):
        g = self.out["gain"]
        self.assertEqual(g[0], 1)
        self.assertEqual(g[1], 1)
        self.assertTrue(g[1] > g[2] > g[3] > g[4])
        self.assertEqual(g[4], 0)
        self.assertEqual(g[5], 0)

    def test_the_nearest_boombox_on_your_floor_plays(self):
        p = self.out["pick"]
        self.assertEqual((p["u"], p["v"], p["frames"]), ("near", "bbbbbbbbbbb", 1))
        self.assertEqual(p["src"], "https://www.youtube-nocookie.com/embed/bbbbbbbbbbb")
        heard = [t for t in p["toasts"] if "'s boombox" in t]
        self.assertEqual(len(heard), 1)
        self.assertIn("song near", heard[0])
        self.assertEqual(self.out["sticky"], "near")

    def test_nothing_plays_twice_out_of_range_or_off_the_hq(self):
        self.assertFalse(self.out["dupe"]["frame"])
        self.assertFalse(self.out["far"]["frame"])
        self.assertFalse(self.out["view"]["frame"])


    def test_a_live_set_is_heard_near_its_dj(self):
        o = self.out
        self.assertEqual(o["live1"]["listens"], ["pA"])
        self.assertEqual(o["live1"]["drawn"], {"dj": 1})
        self.assertFalse(o["live1"]["frame"])
        self.assertEqual(o["live1"]["vol"], 0.45)        # 10 m off: (18/24)^2 of the 80 volume
        self.assertEqual(o["live2"], {"stops": 1, "listen": None})
        self.assertEqual(o["manual"], {"listens": 1, "vol": 1, "stops": 1})
        self.assertTrue(o["liveMe"]["on"])
        self.assertIsNone(o["liveMe"]["net"])            # presence carries songs only; live sets go by MU.lives


class PageSendsIt(unittest.TestCase):
    def test_presence_carries_the_boombox_only_where_the_arena_knows_it(self):
        with open(os.path.join(ROOT, "ui", "app", "22-hq.js"), encoding="utf-8") as f:
            hq = f.read()
        self.assertIn('var bb = hqNetCan("boombox") && typeof boomNet==="function" ? boomNet() : null;', hq)
        self.assertIn("msg.bb,msg.bt,", hq, "a new song is sent at once")


if __name__ == "__main__":
    unittest.main()
