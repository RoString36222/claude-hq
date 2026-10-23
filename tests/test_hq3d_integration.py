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
                         ["engine", "avatar3d", "hq3d", "hqpets", "hqpetride", "hqlobby",
                          # the basement garage (3.4): the car lift, the garage manager, its effects, B1 itself
                          "hqcarlift", "hqgaragemgr", "hqbasementfx", "hqbasement",
                          # the HQ revamp: HQ Studio's style document and the tower it styles (before the Base that builds it)
                          "hqstyle", "hqtower", "hqroof", "hqdecor", "hqbase", "hqskate", "world", "worldgeom",
                          "worldbuild", "camrig", "hqhud", "hqcityparts", "hqcity", "hqmerge",
                          # Cities (3.0): the civic kit, residents, traffic, the sea, boats, travel
                          "hqcivic", "npcsim", "npcdraw", "traffic", "ocean", "hqboat", "hqheli",
                          # vehicles (3.2): the catalogue, handling from specs, their bodies, the (temporary) Showroom
                          "hqvehicles", "hqvehiclephys", "hqvehiclemodels", "hqdrive", "hqvfx", "hqnetsmooth", "hqshowroom", "hqgarage", "hqdealer", "hqtuning", "hqcasinoui", "hqcasino", "hqcall",
                          "hqtravel", "hqvoyage", "hqships", "hqbridges",
                          # the airport: the airfield layout before the flights, the planes you fly (3.2), its ground, buildings, vehicles
                          "hqairfield", "hqair", "hqaircraft", "hqplane", "hqairport3d", "hqairbldg", "hqairground", "hqairbase",
                          # navigation (3.1): the router, the minimap, the route's chevrons, the Go to panel
                          "hqnav", "hqminimap", "hqroutefx", "hqnavui",
                          # rail (3.x): the lines between cities, their trains
                          "hqrail",
                          # the vehicle garage (3.4); City 3.2: the weather, the landmarks and the amusement park
                          "hqcarpark", "hqweather", "hqspectacle", "hqstunts", "hqgrenade", "hqtank", "hqcity3d"])

    def test_multi_hq_range_covers_server(self):
        m = re.search(r"\bhq:\[(\d+),(\d+)\]", read(MULTI))
        self.assertTrue(m)
        lo, hi = int(m.group(1)), int(m.group(2))
        self.assertEqual((lo, hi), (1, 4))   # v4: the catalogue vehicle you drive ("vehicles")
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
        # clamped to the Arena's +-500 m (ALT_H_MAX): a helicopter higher up would get the frame dropped
        self.assertIn("msg.h=Math.max(-50000, Math.min(50000, Math.round(w.h*100)))", m.group(1))
        self.assertIn("Math.max(-90, Math.min(90,", m.group(1))
        self.assertNotRegex(body.replace(m.group(0), ""), r"msg\.[hp]=")
        self.assertIn("msg.h,msg.p,msg.v,msg.vp,msg.bb,msg.bt,msg.ci,msg.cv,msg.cg,msg.vt,JSON.stringify(msg.pt||0),msg.vx,msg.vz,msg.yr,msg.rpm,msg.gl,JSON.stringify(msg.gn||0),JSON.stringify(msg.ta||0)].join", body)   # both in the dedupe key (and the vehicle, the boombox, the convoy, the tune, the pets)
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
        # a teleport (over 6 m from where they are drawn) lands at once; otherwise dead reckoning + a spring (HQ 3.2)
        self.assertRegex(place, r"Math\.hypot\(gx - P\.x, gz - P\.z, [^)]*\) > 6")
        self.assertIn("spring(P.x, P.sx || 0, gx, 10, dt)", place)
        self.assertIn("locomote(P.ch, P.fs, P.fr, dt)", place)
        where = assigned_body(src, "inst.where")
        self.assertIn("cur.net || cur.name", where)
        self.assertIn("h: rigW ? avatar.g.position.y : null", where)

    def test_presence_fly(self):
        # in a helicopter you send a = 7 (8: the attack one), only to an Arena that lists "fly"
        src = read(HQ3D)
        moving = assigned_body(src, "inst.moving")
        self.assertIn('ride.heli ? (ride.kind === "attack" ? 8 : 7)', moving)
        send = func_body(read(HQ_UI), "hqNetSend")
        self.assertIn('if((a===7 || a===8) && !hqNetCan("fly")) a = 0;', send)
        self.assertLess(send.index('hqNetCan("fly")'), send.index("var msg="))
        # others see them in it: the helicopter model at the height they send, its rotors turning
        self.assertIn('var PEER_VEHICLE = {3: "bike", 5: "car", 6: "moto", 7: "heli", 8: "attack", 9: "seaplane", 10: "prop", 11: "regional", 12: "airliner", 13: "petride", 14: "tank"};', src)
        place = func_body(src, "placePeers")
        self.assertIn("HQV.hqheli.model(ctx, vk, bikeColor(u))", place)
        self.assertIn("HQV.hqheli.animate(P.bike, P.hst, dt, isNight())", place)
        self.assertIn("if(vk && !VEHICLES[vk]) vk = null;", place)   # a page without games/hqheli.js

    def test_presence_plane(self):
        # HQ 3.2: flying a plane you send a = 9 (the seaplane) / 10 (the prop plane), only to an Arena that lists "plane"
        src = read(HQ3D)
        moving = assigned_body(src, "inst.moving")
        self.assertIn('ride.plane ? (ride.kind === "seaplane" ? 9 : ride.kind === "regional" ? 11 : ride.kind === "airliner" ? 12 : 10)', moving)
        send = func_body(read(HQ_UI), "hqNetSend")
        self.assertIn('if((a===9 || a===10) && !hqNetCan("plane")) a = 0;', send)
        self.assertLess(send.index('hqNetCan("plane")'), send.index("var msg="))
        # HQ 3.6: the airliners (11 the regional jet, 12 the narrow-body) go only to an Arena that lists "airliner",
        # else as the prop plane (10), which the "plane" check then drops to 0 where planes are unknown too
        self.assertIn('if((a===11 || a===12) && !hqNetCan("airliner")) a = 10;', send)
        self.assertLess(send.index('hqNetCan("airliner")'), send.index('hqNetCan("plane")'))
        place = func_body(src, "placePeers")
        self.assertIn("HQV.hqplane.model(ctx, vk, bikeColor(u))", place)
        self.assertIn("HQV.hqplane.animate(P.bike, P.pst, dt, isNight())", place)


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

    def test_orbit_left_or_right_drag_and_contextmenu(self):
        down = func_body(self.src, "onDown")
        # left- or right-drag orbits in the chase cameras (trackpads have no right-drag)
        self.assertIn("orbit: !!CHASE[m] && (e.button === 0 || e.button === 2)", down)
        # a left click that barely moved still walks / picks
        # (a drag on a ride, d.trip, looks around: never a click either)
        self.assertIn("if(!d || d.trip || d.moved > 5) return;", func_body(self.src, "onUp"))
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

    def test_mouse_steering_wiring(self):
        # [3.15] the camera gear's Mouse steering: in the chase cameras a plain click captures the mouse (never a
        # walk-to), which turns you and the camera together; panels, typing and other cameras give the cursor back
        down = func_body(self.src, "onDown")
        self.assertIn("if(CHASE[m] && steerOn() && locked()){ drag = null; if(e.button === 0 && !tkFire()) gnFire(); return; }", down)   # [3.16] fires
        self.assertIn("steer: !!CHASE[m] && steerOn()", down)
        up = func_body(self.src, "onUp")
        cap = "if(d.steer){ steerLock(); return; }"
        self.assertLess(up.index("if(o && o.door)"), up.index(cap))                     # doors and desks still pick
        self.assertLess(up.index(cap), up.index("pick(e, [].concat(cur.floor))"))        # the floor never walks you
        self.assertIn("if(CHASE[rig.mode]) steerLook(lx, ly); else HQV.camrig.input(rig, {look: [lx, ly]});",
                      func_body(self.src, "onMove"))
        self.assertIn("r.catch(function(){})", func_body(self.src, "steerLock"))         # a refused capture never throws
        look = func_body(self.src, "steerLook")
        self.assertIn("tripHeld()", look)
        self.assertIn("ride.mp = (ride.mp || 0) + dy", look)
        mv = func_body(self.src, "moveAvatar")
        self.assertLess(mv.index("if(steering() && !walkTo){"), mv.index("if(rigOn() && CHASE[rig.mode] && !walkTo){"))
        self.assertIn("HQV.camrig.absorb(rig, PI)", mv)
        self.assertIn("HQV.camrig.input(rig, {hold: true});", mv)
        self.assertIn("steerStep(", mv)
        self.assertIn("if(locked() && CHASE[m] && (!steerOn() || wantsCursor())) exitLock();", func_body(self.src, "rigFrame"))
        wc = func_body(self.src, "wantsCursor")
        for k in ("HQV.townHall.isOpen()", "cur.menuOpen()", "cur.bigMapOpen()", "HQV.hqGarageMgr.isOpen()", "tuneUi.isOpen()",
                  "dealUi.isOpen()", "showUi.isOpen()", "callUi.isOpen()", "typing(document.activeElement)"):
            self.assertIn(k, wc)
        self.assertIn('if(CHASE[prev] && !CHASE[now] && now !== "fp" && now !== "photo") exitLock();',
                      func_body(self.src, "modeChanged"))
        self.assertIn("mouseSteer: false", func_body(self.src, "hudSettings"))
        city = read(os.path.join(ROOT, "games", "hqcity3d.js"))
        self.assertIn("w.bigMapOpen = function(){ return !!(mm && mm.isBig()); };", city)

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
        self.assertIn('t.closest(".hqhud-gear, .hqhud-settings, .hqs")', func_body(self.src, "typing"))   # (and HQ Studio's panel)
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
        # never walk along anything that follows you: the camera's heading is read only once, as S goes down
        # (HQ 3.3.1: S walks you toward the camera; footStep latches it in faceGoal, and the camera holds meanwhile)
        self.assertEqual(mv.count("rig.moveYaw"), 2)
        self.assertIn("face: fwd < 0 && avatar.faceGoal == null && rig.moveYaw != null ? wrapPi(rig.moveYaw + PI) : null", mv)
        # idle / walk / sprint blended by your signed pace (S plays it backwards), and the lean into turns (HQ 3.2)
        self.assertIn("locomote(avatar.ch, avatar.speed, avatar.rate, dt)", mv)
        self.assertIn("leanStep(avatar.ch,", mv)
        # walking with a dragged camera turns you to face where it looks (camrig absorb)
        self.assertIn("HQV.camrig.absorb(rig, FOOT.steer*dt)", mv)
        self.assertIn("settleY(dt);", mv)
        self.assertIn("avatar.g.position.set(avatar.x, avatar.hy + avatar.hop, avatar.z)", mv)
        self.assertIn("spring(avatar.hy, avatar.hyV, gy, 18, dt)", func_body(self.src, "settleY"))

    def test_minimap_turns_with_the_camera(self):
        # HQ 3.2: the heading-up minimap turns by the camera's heading (camHeading), not the body's facing alone
        self.assertIn("view: camHeading()", self.src)
        self.assertIn("CHASE[rig.mode] ? rig.moveYaw : rig.lookYaw", func_body(self.src, "camHeading"))

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
// S walks you toward the camera (HQ 3.3.1): the most it ever turns past facing it, the camera holding through
// the release, and W handing the camera back
(function(){ var st = {yaw: 0}, most = 0; for(var i = 0; i < 120; i++){ st = H.footStep(st, {fwd: -1, face: Math.PI}, 1/60);
  var d = st.yaw < 0 ? st.yaw + 2*Math.PI : st.yaw; most = Math.max(most, d); } out.aboutMost = most; })();
var rel = run(run({yaw: 0}, {fwd: -1, face: Math.PI}, 1, 60), {}, 0.6, 60);
out.release = [rel.travelYaw, rel.speed];
var onW = run(rel, {fwd: 1}, 0.5, 60);
out.onW = [onW.travelYaw, onW.speed, onW.yaw];
var turn = run(z, {turn: 1}, 1, 60);
out.turn = [turn.rate, turn.yaw, turn.travelYaw];
out.turnR = run(z, {turn: -1}, 1, 60).rate;
var a30 = run(z, {fwd: 1, turn: 1}, 1, 30), a120 = run(z, {fwd: 1, turn: 1}, 1, 120);
out.fps = [a30.yaw, a120.yaw, a30.speed, a120.speed];
out.still = [run(z, {}, 1, 60).travelYaw, H.travelYawOf(1, 0, 0), H.travelYawOf(1, 2, 0), H.travelYawOf(0, -1, 0),
             H.travelYawOf(1, 0, 0, 1.1), H.travelYawOf(1, 0, 0, 1 + Math.PI), run(turn, {}, 1, 60).travelYaw];
out.loco = [0, 0.5, 2, 4, 5.6, 7, -2.6].map(function(v){ return H.locoWeights(v, 0); });
out.locoShuffle = H.locoWeights(0, 3.6);
out.stop = run(run(z, {fwd: 1}, 1, 60), {}, 0.05, 60).speed;
// [3.15] mouse steering: W along your facing, S back at FOOT.back of the pace (signed), A to your left (+x facing +z),
// the mouse's turn added to your facing, and with no key down you coast on the way you were going
function runS(st, inp, secs, fps){ var n = Math.round(secs*fps); for(var i = 0; i < n; i++) st = H.steerStep(st, inp, 1/fps); return st; }
var sw = runS({yaw: 0.5}, {fwd: 1}, 1, 60), sb = runS({yaw: 0.5}, {fwd: -1}, 1, 60), sa = runS({yaw: 0}, {side: 1}, 1, 60);
var sc = runS(sa, {}, 0.05, 60), sr = runS({yaw: 0}, {fwd: 1, run: true}, 1, 60);
out.steer = {w: [sw.speed, sw.mdx, sw.mdz, sw.yaw], back: [sb.speed, sb.mdx, sb.mdz, sb.yaw], left: [sa.speed, sa.mdx, sa.mdz],
             coast: [sc.speed, sc.mdx, sc.mdz], run: sr.speed, turn: H.steerStep({yaw: 0.2}, {turn: 0.3}, 1/60).yaw,
             wrap: H.steerStep({yaw: 3}, {turn: 0.5}, 1/60).yaw, junk: H.steerStep(null, null, NaN)};
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

    def test_mouse_steering_step(self):
        st = self.o["steer"]
        speed, mdx, mdz, yaw = st["w"]
        self.assertAlmostEqual(speed, 4, delta=0.01)                                     # W: FOOT.walk along your facing
        self.assertAlmostEqual(mdx, math.sin(0.5), places=6)
        self.assertAlmostEqual(mdz, math.cos(0.5), places=6)
        self.assertAlmostEqual(yaw, 0.5, places=9)                                       # never turns to face where you go
        speed, mdx, mdz, yaw = st["back"]
        self.assertAlmostEqual(speed, -4*0.65, delta=0.01)                               # S: FOOT.back of the pace, signed
        self.assertAlmostEqual(mdx, math.sin(0.5), places=6)                             # (you go -md while it is negative)
        self.assertAlmostEqual(mdz, math.cos(0.5), places=6)
        self.assertAlmostEqual(yaw, 0.5, places=9)
        speed, mdx, mdz = st["left"]
        self.assertAlmostEqual(speed, 4, delta=0.01)                                     # A: a step to your left
        self.assertAlmostEqual(mdx, 1, places=6)
        self.assertAlmostEqual(mdz, 0, places=6)
        speed, mdx, mdz = st["coast"]
        self.assertGreater(speed, 0.5)                                                   # let go: you coast the same way
        self.assertLess(speed, 4)
        self.assertAlmostEqual(mdx, 1, places=6)
        self.assertAlmostEqual(st["run"], 7, delta=0.02)
        self.assertAlmostEqual(st["turn"], 0.5, places=9)                                # the mouse's turn is the body's
        self.assertAlmostEqual(st["wrap"], 3.5 - 2*math.pi, places=9)
        self.assertEqual(st["junk"]["speed"], 0)

    def test_foot_speed_springs(self):
        self.assertLess(self.o["wFirst"], 0.5)               # no instant 0 -> 4
        early, walk, sprint = self.o["w"]
        self.assertGreater(early, 1)
        self.assertLess(early, 4)
        self.assertAlmostEqual(walk, 4, delta=0.01)
        self.assertAlmostEqual(sprint, 7, delta=0.02)
        self.assertLess(self.o["stop"], 4)                    # eases down, not a hard stop
        self.assertGreater(self.o["stop"], 1)

    def test_s_walks_you_toward_the_camera(self):
        # HQ 3.3.1: S turns you to face the camera (critically damped, no overshoot) and walks you toward it while the
        # camera holds its heading (travelYaw null) and only backs up; it keeps holding through the release until W.
        speed, yaw, travel = self.o["back"]                                              # no inp.face: faces yaw0 + PI
        self.assertAlmostEqual(speed, 4, delta=0.15)
        self.assertAlmostEqual(math.cos(yaw - (0.7 + math.pi)), 1, delta=1e-3)
        self.assertIsNone(travel)                                                         # the camera holds
        self.assertLessEqual(self.o["aboutMost"], math.pi + 0.01)                        # never turns past facing it
        rtravel, rspeed = self.o["release"]
        self.assertIsNone(rtravel)                                                        # still holding after the release
        self.assertAlmostEqual(rspeed, 0, delta=0.1)
        wtravel, wspeed, wyaw = self.o["onW"]
        self.assertIsNotNone(wtravel)                                                     # W: the camera comes round behind
        self.assertAlmostEqual(math.cos(wtravel - wyaw), 1, delta=1e-6)
        self.assertGreater(wspeed, 3)

    def test_turn_rate_springs(self):
        rate, yaw, travel = self.o["turn"]
        # HQ 3.2: 3.6 rad/s (was 2.4) on a snappier spring (omega 18, was 10)
        self.assertAlmostEqual(rate, 3.6, delta=0.01)
        self.assertGreater(yaw % (2*math.pi), 3.0)           # A turns left: yaw grows (~3.5 rad: wrapped past PI)
        self.assertAlmostEqual(travel, yaw, places=9)         # turning on the spot: headed where you face
        self.assertAlmostEqual(self.o["turnR"], -3.6, delta=0.01)

    def test_foot_step_frame_rate_independent(self):
        y30, y120, s30, s120 = self.o["fps"]
        self.assertAlmostEqual(y30, y120, delta=0.02)
        self.assertAlmostEqual(s30, s120, places=6)

    def test_travel_yaw_when_still(self):
        self.assertEqual(self.o["still"][:2], [None, None])   # from a standstill: none (the camera holds)
        self.assertEqual(self.o["still"][2], 1)
        self.assertAlmostEqual(self.o["still"][3], math.pi, places=9)
        # standing still after heading where you face: still your facing (the camera settles behind you, HQ 3.2);
        # after a back-step (last headed facing + PI): none, the camera holds where it swung to
        self.assertEqual(self.o["still"][4], 1)
        self.assertIsNone(self.o["still"][5])
        self.assertIsNotNone(self.o["still"][6])

    def test_locomotion_blend(self):
        L = self.o["loco"]
        for w in L:
            self.assertAlmostEqual(w["idle"] + w["walk"] + w["sprint"], 1, places=9)
        self.assertEqual((L[0]["idle"], L[0]["walk"]), (1, 0))       # still: idle
        self.assertGreater(L[1]["idle"], 0.4); self.assertGreater(L[1]["walk"], 0.4)   # setting off: a crossfade
        self.assertEqual(L[3]["walk"], 1)                              # walking pace
        self.assertGreater(L[4]["sprint"], 0); self.assertGreater(L[4]["walk"], 0)   # speeding up: both
        self.assertEqual(L[5]["sprint"], 1)
        # the playback rate follows the ground speed (no gliding), backwards when stepping back
        self.assertAlmostEqual(L[3]["walkTs"] / L[2]["walkTs"], 2, places=9)
        self.assertLess(L[6]["walkTs"], 0)
        sh = self.o["locoShuffle"]                                     # turning on the spot: a shuffle
        self.assertGreater(sh["walk"], 0.3); self.assertGreater(sh["walkTs"], 0)

if __name__ == "__main__":
    unittest.main()
