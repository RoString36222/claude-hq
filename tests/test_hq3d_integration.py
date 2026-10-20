"""3D City integration in games/hq3d.js, ui/app/22-hq.js and games/multi.js (3D city spec 2.8).

Source-level checks pin the wiring the spec asks for (load order, presence v2, the camera keys and
their guard, pointer lock, mouse buttons, idle, gamepad); the pure helpers of hq3d.js
(HQV.hq3dPure) run under node when it is installed. Stdlib only."""
import json
import math
import os
import re
import shutil
import subprocess
import unittest

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
HQ3D = os.path.join(ROOT, "games", "hq3d.js")
HQ_UI = os.path.join(ROOT, "ui", "app", "22-hq.js")
MULTI = os.path.join(ROOT, "games", "multi.js")
PROTOCOL = os.path.join(ROOT, "backend", "src", "protocol.rs")
NODE = shutil.which("node")


def read(p):
    with open(p, encoding="utf-8") as f:
        return f.read()


def func_body(src, name):
    """The text of `function name(...){ ... }` (brace matched; the sources keep braces out of strings here)."""
    m = re.search(r"function %s\([^)]*\)\s*\{" % re.escape(name), src)
    assert m, name
    i, depth = m.end(), 1
    while depth:
        c = src[i]
        depth += c == "{"
        depth -= c == "}"
        i += 1
    return src[m.start():i]


def assigned_body(src, lhs):
    """The function assigned as `lhs = function(...){ ... }`."""
    m = re.search(re.escape(lhs) + r" = function\([^)]*\)\s*\{", src)
    assert m, lhs
    i, depth = m.end(), 1
    while depth:
        c = src[i]
        depth += c == "{"
        depth -= c == "}"
        i += 1
    return src[m.start():i]


class LoadOrderAndProtocol(unittest.TestCase):
    def test_script_load_order(self):
        m = re.search(r"var HQ_SCRIPTS = (\[[^\]]*\]);", read(HQ_UI))
        self.assertTrue(m, "HQ_SCRIPTS list in 22-hq.js")
        self.assertEqual(json.loads(m.group(1)),
                         ["engine", "avatar3d", "hq3d", "hqlobby", "hqbase", "hqskate", "world", "worldgeom",
                          "worldbuild", "camrig", "hqhud", "hqcityparts", "hqcity", "hqmerge",
                          # Cities (3.0): the civic kit, residents, traffic, the sea, boats, travel
                          "hqcivic", "npcsim", "npcdraw", "traffic", "ocean", "hqboat", "hqheli", "hqtravel", "hqvoyage", "hqships", "hqbridges",
                          "hqair", "hqaircraft", "hqairbase",
                          # navigation (3.1): the router, the minimap, the route's chevrons, the Go to panel
                          "hqnav", "hqminimap", "hqroutefx", "hqnavui",
                          # rail (3.x): the lines between cities, their trains
                          "hqrail", "hqcity3d"])

    def test_multi_hq_range_covers_server(self):
        m = re.search(r"\bhq:\[(\d+),(\d+)\]", read(MULTI))
        self.assertTrue(m)
        lo, hi = int(m.group(1)), int(m.group(2))
        self.assertEqual((lo, hi), (1, 3))   # v3: Cities, a presence room per world ("isles")
        p = re.search(r'\("hq",\s*(\d+),', read(PROTOCOL))
        self.assertTrue(p, "hq row in protocol.rs")
        self.assertGreaterEqual(hi, int(p.group(1)))
        self.assertLessEqual(lo, int(p.group(1)))

    def test_presence_v2_send(self):
        body = func_body(read(HQ_UI), "hqNetSend")
        self.assertIn('var alt=hqNetCan("alt");', body)
        self.assertRegex(body, r'if\(w\.world==="city3d" && !alt\) return;')
        m = re.search(r"if\(alt && w\.h!=null\)\{([^}]*)\}", body)
        self.assertTrue(m, "h/p only behind the alt capability")
        self.assertIn("msg.h=Math.round(w.h*100)", m.group(1))
        self.assertIn("Math.max(-90, Math.min(90,", m.group(1))
        self.assertNotRegex(body.replace(m.group(0), ""), r"msg\.[hp]=")
        self.assertIn("msg.h,msg.p].join", body)   # both in the dedupe key
        # the city3d skip comes before anything is sent
        self.assertLess(body.index('w.world==="city3d"'), body.index("ws.send"))

    def test_presence_v2_receive(self):
        src = read(HQ3D)
        body = assigned_body(src, "inst.setPeers")
        self.assertIn('P.th = typeof p.h === "number" ? p.h/100 : null', body)
        self.assertIn('P.tp = typeof p.p === "number" ? p.p*PI/180 : 0', body)
        place = func_body(src, "placePeers")
        self.assertIn("P.w === (cur.net || cur.name)", place)
        self.assertIn("cur.skateBase", place)
        self.assertRegex(place, r"Math\.hypot\(P\.tx - P\.x, P\.tz - P\.z, [^)]*\) > 6")
        where = assigned_body(src, "inst.where")
        self.assertIn("cur.net || cur.name", where)
        self.assertIn("h: rigW ? avatar.g.position.y : null", where)


class Hq3dSource(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.src = read(HQ3D)

    def test_world_routing(self):
        self.assertIn('get("world")', self.src)
        self.assertIn('q === "old"', self.src)
        self.assertIn('localStorage.getItem("hq_city_impl")', self.src)
        mk = func_body(self.src, "makeWorld")
        self.assertIn('cityImpl() !== "old"', mk)
        self.assertIn("HQV.hqWorlds.city3d", mk)
        fb = func_body(self.src, "cityFallback")
        self.assertIn("The 3D city is not available, showing the classic City", fb)

    def test_enter_world_guard(self):
        ew = func_body(self.src, "enterWorld")
        self.assertIn("if(entering === name) return;", ew)
        self.assertIn("entering = name;", ew)
        self.assertIn("if(entering !== name || worlds[name] !== w) return;", ew)
        self.assertIn("15000", ew)
        self.assertIn("w.whenReady.then(", ew)

    def test_camera_keys_inside_guard(self):
        body = func_body(self.src, "camKey")
        self.assertTrue(body.split("\n")[1].strip().startswith("if(!rigOn()"), "guard first")
        self.assertIn("cur.camModes", func_body(self.src, "rigOn"))
        m = re.search(r"var CAM_KEYS = \{([^}]*)\}", self.src)
        for k in ["KeyV", "KeyM", "KeyP", "KeyQ", "KeyR", "KeyZ", "KeyC"]:
            self.assertIn(k + ": 1", m.group(1))
        self.assertIn("if(!CAM_KEYS[e.code]) return false;\n    e.preventDefault();", body)
        for k in ["e.metaKey", "e.ctrlKey", "e.altKey", "typing(e.target)", "inst.running"]:
            self.assertIn(k, body)
        self.assertIn('e.code === "KeyV") camCycle(e.shiftKey ? -1 : 1)', body)
        self.assertIn('e.code === "KeyM") mapToggle()', body)
        self.assertIn('e.code === "KeyP") photoToggle()', body)
        self.assertIn("photoShot()", body)
        self.assertIn("if(camKey(e)) return;", func_body(self.src, "onKey"))

    def test_picks_use_concat_floor(self):
        self.assertNotIn("[cur.floor]", self.src)
        self.assertIn("pick(e, [].concat(cur.floor))", func_body(self.src, "onUp"))
        self.assertIn("[].concat(cur.floor", func_body(self.src, "mapClick"))
        self.assertIn("ray.setFromCamera(ptr, curCam())", func_body(self.src, "pick"))

    def test_orbit_right_button_and_contextmenu(self):
        down = func_body(self.src, "onDown")
        self.assertIn("orbit: !!CHASE[m] && e.button === 2", down)
        ctx = func_body(self.src, "onContext")
        self.assertIn("if(rigOn() && CHASE[rig.mode]) e.preventDefault();", ctx)
        # the only contextmenu listener is onContext (no unconditional preventDefault anywhere)
        self.assertEqual(self.src.count("contextmenu"), 1)
        self.assertIn('canvas.addEventListener("contextmenu", onContext)', self.src)

    def test_rotation_order(self):
        self.assertIn('avatar.g.rotation.order = "YXZ"', self.src)
        self.assertIn('P.g.rotation.order = "YXZ"', self.src)
        self.assertIn("avatar.g.rotation.x = -ride.pitch; avatar.g.rotation.z = ride.roll;", self.src)
        self.assertIn("P.g.rotation.x = -P.pitch", self.src)

    def test_exit_pointer_lock(self):
        self.assertIn("document.exitPointerLock()", func_body(self.src, "exitLock"))
        self.assertIn("exitLock()", assigned_body(self.src, "inst.pause"))
        self.assertIn("exitLock()", assigned_body(self.src, "inst.destroy"))
        self.assertIn("exitLock()", func_body(self.src, "enterWorld"))
        mc = func_body(self.src, "modeChanged")
        self.assertIn('if((prev === "fp" || prev === "photo") && now !== "fp" && now !== "photo") exitLock();', mc)

    def test_idle_not_armed_in_map_or_photo(self):
        rf = func_body(self.src, "rigFrame")
        self.assertIn('if(rig.mode === "map" || rig.mode === "photo" || rig.mode === "cine") idleT = 0;', rf)
        self.assertIn('else if((idleT += dt) > 45){ idleT = 0; C.setMode(rig, "cine"); }', rf)
        self.assertIn("C.setMode(rig, rig.prev", func_body(self.src, "noteInput"))

    def test_gamepad_polled_only_after_connect(self):
        self.assertIn('window.addEventListener("gamepadconnected", onPadOn)', self.src)
        self.assertIn('window.addEventListener("gamepaddisconnected", onPadOff)', self.src)
        poll = func_body(self.src, "padPoll")
        self.assertIn("if(!pad.on || !navigator.getGamepads) return;", poll)
        self.assertLess(poll.index("pad.on"), poll.index("navigator.getGamepads()"))
        self.assertIn("pad.on = true", func_body(self.src, "onPadOn"))

    def test_map_click_on_other_hq_flies(self):
        mc = func_body(self.src, "mapClick")
        self.assertIn('if(a.act === "dive"){ dismount(true); placeAvatar(a.x, a.z, a.yaw); C.dive(rig, rigTarget()); }', mc)
        self.assertIn("else { C.flyMap(rig, a.x, a.z, a.span);", mc)

    def test_classic_on_terrain(self):
        # Classic's ortho target follows the ground in rig worlds (groundAt is 0 everywhere else)
        self.assertNotRegex(self.src, r"view\.goal\.set\([^;]*, cur\.camY \|\| 1\.4,")
        self.assertIn("groundAt(avatar.x, avatar.z) + (cur.camY || 1.4) + st.y*0.7", self.src)
        self.assertIn("return cur && cur.camModes && cur.groundY ? cur.groundY(x, z) : 0;", func_body(self.src, "groundAt"))

    def test_builder_requests(self):
        self.assertIn('t.closest(".hqhud-gear, .hqhud-settings")', func_body(self.src, "typing"))
        self.assertIn("C.occluders(pose.pos, pose.focus || pose.look,", self.src)
        self.assertNotIn("occluders(pose.pos, pose.look,", self.src)
        self.assertIn('if(rig.mode === "cine" && rig.wake)', func_body(self.src, "rigFrame"))
        self.assertIn("ground: groundAt})", func_body(self.src, "rigFrame"))
        mk = func_body(self.src, "makeWorld")
        self.assertIn("old.stale === true && old !== cur", mk)
        self.assertIn("old.destroy()", mk)
        self.assertIn("seed: 1", func_body(self.src, "rigEnter"))
        self.assertIn('q.get("yaw")', func_body(self.src, "smokeParams"))
        sf = func_body(self.src, "smokeFrame")
        self.assertLess(sf.index("smokeTeleport("), sf.index("smokeRide("))
        self.assertIn("cur.spawnFrom.lobby", sf)


    def test_body_relative_chase_controls(self):
        self.assertNotIn("moveLatch", self.src)
        self.assertNotIn("lastOrbit", self.src)
        mv = func_body(self.src, "moveAvatar")
        self.assertIn("if(rigOn() && CHASE[rig.mode] && !walkTo){", mv)
        self.assertIn("footStep(", mv)
        self.assertNotIn("back = true", mv)
        self.assertNotIn("rig.moveYaw", mv)           # never walk along anything that follows you
        # the walk plays at your signed pace (S plays it backwards)
        self.assertIn('setAnim(avatar.ch, "walk", avatar.speed/FOOT.walk)', mv)
        self.assertIn("settleY(dt);", mv)
        self.assertIn("avatar.g.position.set(avatar.x, avatar.hy + avatar.hop, avatar.z)", mv)
        self.assertIn("spring(avatar.hy, avatar.hyV, gy, 18, dt)", func_body(self.src, "settleY"))

    def test_rig_target_contract(self):
        rt = func_body(self.src, "rigTarget")
        for k in ["travelYaw:", "turnRate: avatar.rate", "y: avatar.g.position.y", "speed:", "moving:", "lean:", "vehicle:"]:
            self.assertIn(k, rt)

    def test_frame_rate_independent_smoothing(self):
        self.assertNotRegex(self.src, r"Math\.min\(1, *dt *\*")
        fr = func_body(self.src, "frame")
        self.assertIn("ts/1000", fr)
        self.assertEqual(fr.count("nearBike()"), 1)
        # one E prompt per vehicle: the ride pill; the HUD prompt is for doors only (and never scans for bikes)
        hp = func_body(self.src, "hudPrompt")
        self.assertNotIn("nearBike", hp)
        self.assertNotIn("Ride the", hp)
        self.assertIn("doorUnderCrosshair", hp)

    def test_quality_never_recompiles(self):
        q = func_body(self.src, "setQuality")
        self.assertNotIn("shadowMap.enabled", q)
        self.assertNotIn("needsUpdate", q)
        self.assertIn("o.isDirectionalLight", q)
        self.assertEqual(self.src.count("shadowMap.enabled"), 1)   # set once, at start

    def test_mission_redraw_only_in_mission(self):
        up = assigned_body(self.src, "inst.update")
        self.assertIn("if(cur === worlds.mission) refreshMission(); else missionDirty = true;", up)
        self.assertNotIn("drawWall(", up)
        self.assertIn("missionDirty) refreshMission()", func_body(self.src, "enterWorld"))

    def test_probe_hook(self):
        m = re.search(r"probe: function\(\)\{.*?\}; \}", self.src, re.S)
        self.assertTrue(m)
        for k in ["travelYaw:", "turnRate:", "heading:", "moveYaw:", "lookYaw:", "cam:"]:
            self.assertIn(k, m.group(0))

NODE_HARNESS = r"""
var fs = require("fs"), root = %(root)s;
global.window = {HQV: {}};
new Function(fs.readFileSync(root + "/games/hq3d.js", "utf8"))();
var H = window.HQV.hq3dPure, out = {};
function B(ids){ var b = []; for(var i = 0; i < 16; i++) b.push({pressed: ids.indexOf(i) >= 0}); return b; }
out.loaded = !!H && !window.HQV.hq3d;                   // pure part only: no engine under node
out.dz = [H.padToInput([0.1, -0.14, 0.149, 0], B([])).move, H.padToInput([0.5, -1, 0, 0.2], B([])).move,
          H.padToInput([0, 0, -0.9, 0.16], B([])).look];
var a = H.padToInput([0, 0, 0, 0], B([5])), b = H.padToInput([0, 0, 0, 0], B([5]), a.pressed),
    c = H.padToInput([0, 0, 0, 0], B([4]), b.pressed), d = H.padToInput([0, 0, 0, 0], B([]), c.pressed);
out.cycles = [a.cycle, b.cycle, c.cycle, d.cycle];
var y1 = H.padToInput([], B([3])), y2 = H.padToInput([], B([3]), y1.pressed);
out.map = [y1.map, y2.map];
var a1 = H.padToInput([], B([0])), a2 = H.padToInput([], B([0]), a1.pressed);
out.hop = [a1.hop, a2.hop, H.padToInput([], B([])).hop];
var x1 = H.padToInput([], B([2])), x2 = H.padToInput([], B([2]), x1.pressed);
out.use = [x1.use, x2.use];
out.idle = H.padToInput([0.05, 0, 0, 0], B([])).any;
out.bools = H.padToInput([0, 0, 0, 0], [false, false, false, true, false, true]).map;
var pose = {pos: {x: 0, y: 1.65, z: 0}, look: {x: 0, y: 1.65, z: 10}};
var doors = [{label: "near", front: {x: 0.5, z: 2.5}}, {label: "far", front: {x: 0, z: 2.9 + 1}}, {label: "off", front: {x: 3, z: 2}}];
function lab(d){ return d ? d.label : null; }
out.doorHit = lab(H.doorUnderCrosshair(pose, doors, 3));
out.doorMissSide = lab(H.doorUnderCrosshair(pose, [doors[2]], 3));
out.doorRange = [lab(H.doorUnderCrosshair(pose, [{label: "r", front: {x: 0, z: 2.9}}], 3)),
                 lab(H.doorUnderCrosshair(pose, [{label: "r", front: {x: 0, z: 3.5}}], 3))];
out.doorBehind = lab(H.doorUnderCrosshair(pose, [{label: "b", front: {x: 0, z: -2}}], 3));
out.doorEdge = [lab(H.doorUnderCrosshair(pose, [{label: "e", front: {x: 1.15, z: 2}}], 3)),
                lab(H.doorUnderCrosshair(pose, [{label: "e", front: {x: 1.25, z: 2}}], 3))];
out.doorSky = lab(H.doorUnderCrosshair({pos: pose.pos, look: {x: 0, y: 12, z: 2}}, [{label: "s", front: {x: 0, y: 0, z: 2.5}}], 3));
out.doorNone = [H.doorUnderCrosshair(null, doors, 3), H.doorUnderCrosshair(pose, [], 3)];
out.shot = H.shotName(new Date(2026, 9, 19, 8, 5, 3));
out.shot2 = H.shotName(new Date(2026, 0, 2, 23, 59, 9));
out.impl = [H.cityImplOf("?world=old", null), H.cityImplOf("?a=1&world=old", null), H.cityImplOf("", "old"),
            H.cityImplOf("?world=new", null), H.cityImplOf("", null), H.cityImplOf(null, "3d")];
out.clickYou = H.mapClickAction({kind: "hq", you: true, userId: "u", door: {x: 10, z: 5}, name: "Mine", lot: {x: 10, z: 0}});
out.clickOther = H.mapClickAction({kind: "hq", you: false, userId: "v", door: {x: 40, z: 5}, name: "Maya's HQ", lot: {x: 40, z: 0}});
out.clickPoint = H.mapClickAction({kind: "point", x: 7, z: -3});
out.clickNull = H.mapClickAction(null);
// springs and on-foot steps
function run(st, inp, secs, fps){ var n = Math.round(secs*fps); for(var i = 0; i < n; i++) st = H.footStep(st, inp, 1/fps); return st; }
var z = {yaw: 0, rate: 0, rateV: 0, speed: 0, speedV: 0};
out.springExact = [H.spring(0, 0, 1, 10, 0.5)[0], (function(){ var a = [0, 0]; for(var i = 0; i < 50; i++) a = H.spring(a[0], a[1], 1, 10, 0.01); return a[0]; })()];
out.ease = [H.ease(4, 0), H.ease(4, 0.25), H.ease(-1, 1)];
out.wFirst = H.footStep(z, {fwd: 1}, 1/60).speed;
out.w = [run(z, {fwd: 1}, 0.1, 60).speed, run(z, {fwd: 1}, 1, 60).speed, run(z, {fwd: 1, run: true}, 1, 60).speed];
var back = run({yaw: 0.7, rate: 0, rateV: 0, speed: 0, speedV: 0}, {fwd: -1}, 1, 60);
out.back = [back.speed, back.yaw, back.travelYaw];
var turn = run(z, {turn: 1}, 1, 60);
out.turn = [turn.rate, turn.yaw, turn.travelYaw];
out.turnR = run(z, {turn: -1}, 1, 60).rate;
var a30 = run(z, {fwd: 1, turn: 1}, 1, 30), a120 = run(z, {fwd: 1, turn: 1}, 1, 120);
out.fps = [a30.yaw, a120.yaw, a30.speed, a120.speed];
out.still = [run(z, {}, 1, 60).travelYaw, H.travelYawOf(1, 0, 0), H.travelYawOf(1, 2, 0), H.travelYawOf(0, -1, 0)];
out.stop = run(run(z, {fwd: 1}, 1, 60), {}, 0.05, 60).speed;
process.stdout.write(JSON.stringify(out));
"""


@unittest.skipUnless(NODE, "node is not installed")
class Hq3dPure(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        r = subprocess.run([NODE, "-"], input=NODE_HARNESS % {"root": json.dumps(ROOT)}, capture_output=True,
                           text=True, timeout=60)
        if r.returncode:
            raise AssertionError(r.stderr)
        cls.o = json.loads(r.stdout)

    def test_loads_without_engine(self):
        self.assertTrue(self.o["loaded"])

    def test_pad_dead_zone(self):
        self.assertEqual(self.o["dz"][0], [0, 0])
        mv = self.o["dz"][1]
        self.assertAlmostEqual(mv[0], (0.5 - 0.15)/0.85, places=6)
        self.assertEqual(mv[1], -1)
        lk = self.o["dz"][2]
        self.assertLess(lk[0], -0.8)
        self.assertGreater(lk[1], 0)
        self.assertLess(lk[1], 0.02)
        self.assertFalse(self.o["idle"])

    def test_pad_bumper_edges(self):
        self.assertEqual(self.o["cycles"], [1, 0, -1, 0])   # RB press, held, LB press, released

    def test_pad_y_map_a_hop_x_use(self):
        self.assertEqual(self.o["map"], [True, False])
        self.assertEqual(self.o["hop"], [True, True, False])  # A is held like Space
        self.assertEqual(self.o["use"], [True, False])
        self.assertTrue(self.o["bools"])                     # plain booleans work as buttons too

    def test_door_under_crosshair(self):
        self.assertEqual(self.o["doorHit"], "near")
        self.assertIsNone(self.o["doorMissSide"])
        self.assertEqual(self.o["doorRange"], ["r", None])
        self.assertIsNone(self.o["doorBehind"])
        self.assertEqual(self.o["doorEdge"], ["e", None])
        self.assertIsNone(self.o["doorSky"])
        self.assertEqual(self.o["doorNone"], [None, None])

    def test_shot_name(self):
        self.assertEqual(self.o["shot"], "claude-hq-20261019-080503.png")
        self.assertEqual(self.o["shot2"], "claude-hq-20260102-235909.png")

    def test_city_impl(self):
        self.assertEqual(self.o["impl"], ["old", "old", "old", "3d", "3d", "3d"])

    def test_map_click_actions(self):
        you = self.o["clickYou"]
        self.assertEqual(you["act"], "dive")
        self.assertEqual((you["x"], you["z"]), (10, 5))
        self.assertAlmostEqual(you["yaw"], 0.0)              # facing out of the lot, toward +z
        self.assertEqual(self.o["clickOther"], {"act": "fly", "x": 40, "z": 0, "span": 44, "name": "Maya's HQ"})
        self.assertEqual(self.o["clickPoint"], {"act": "fly", "x": 7, "z": -3})
        self.assertIsNone(self.o["clickNull"])


    def test_spring_and_ease(self):
        a, b = self.o["springExact"]
        self.assertAlmostEqual(a, b, places=9)              # one 0.5 s step == fifty 10 ms steps
        self.assertEqual(self.o["ease"][0], 0)
        self.assertAlmostEqual(self.o["ease"][1], 1 - math.exp(-1), places=9)
        self.assertEqual(self.o["ease"][2], 0)

    def test_foot_speed_springs(self):
        self.assertLess(self.o["wFirst"], 0.5)               # no instant 0 -> 4
        early, walk, sprint = self.o["w"]
        self.assertGreater(early, 1)
        self.assertLess(early, 4)
        self.assertAlmostEqual(walk, 4, delta=0.01)
        self.assertAlmostEqual(sprint, 7, delta=0.02)
        self.assertLess(self.o["stop"], 4)                    # eases down, not a hard stop
        self.assertGreater(self.o["stop"], 1)

    def test_s_steps_back_facing_forward(self):
        speed, yaw, travel = self.o["back"]
        self.assertAlmostEqual(speed, -4*0.65, delta=0.01)
        self.assertAlmostEqual(yaw, 0.7, places=9)           # no turning
        self.assertAlmostEqual(travel, 0.7 - math.pi, places=6)

    def test_turn_rate_springs(self):
        rate, yaw, travel = self.o["turn"]
        self.assertAlmostEqual(rate, 2.4, delta=0.01)
        self.assertGreater(yaw, 1.5)                          # A turns left: yaw grows
        self.assertLess(yaw, 2.4)                             # the rate eased in
        self.assertAlmostEqual(travel, yaw, places=9)         # turning on the spot: headed where you face
        self.assertAlmostEqual(self.o["turnR"], -2.4, delta=0.01)

    def test_foot_step_frame_rate_independent(self):
        y30, y120, s30, s120 = self.o["fps"]
        self.assertAlmostEqual(y30, y120, delta=0.02)
        self.assertAlmostEqual(s30, s120, places=6)

    def test_travel_yaw_null_when_still(self):
        self.assertEqual(self.o["still"][:2], [None, None])
        self.assertEqual(self.o["still"][2], 1)
        self.assertAlmostEqual(self.o["still"][3], math.pi, places=9)

if __name__ == "__main__":
    unittest.main()
