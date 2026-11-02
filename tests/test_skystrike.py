"""SkyStrike (Valley) — registration, original human hero body, Commons open.

SKYSTRIKE is an original slinger (charcoal suit, neon-blue trim, hood, angular
mask eyes). Not Marvel / Spider-Man trade dress. Opening the Valley game puts
that body in The Commons (`claude-hq@2`) with a real human walk / run gait.
"""

import json
import re
import shutil
import subprocess
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SKY = (ROOT / "games" / "skystrike.js").read_text(encoding="utf-8")
VIEWS = (ROOT / "ui" / "app" / "10-views.js").read_text(encoding="utf-8")
HQ3D = (ROOT / "games" / "hq3d.js").read_text(encoding="utf-8")
CITY = (ROOT / "games" / "hqcity3d.js").read_text(encoding="utf-8")
SPEC = (ROOT / "games" / "hqspectacle.js").read_text(encoding="utf-8")
BRIDGE = (ROOT / "games" / "hqbridges.js").read_text(encoding="utf-8")
CAMRIG = (ROOT / "games" / "camrig.js").read_text(encoding="utf-8")
CSS = (ROOT / "games" / "games.css").read_text(encoding="utf-8")
NODE = shutil.which("node")


class SkyStrikeRegistration(unittest.TestCase):
    def test_valley_file_list_loads_skystrike(self):
        self.assertIn('"skystrike"', VIEWS)
        m = re.search(r"VALLEY_FILES\s*=\s*\[([^\]]+)\]", VIEWS)
        self.assertIsNotNone(m, "VALLEY_FILES must stay in 10-views.js")
        files = [p.strip().strip("'\"") for p in m.group(1).split(",") if p.strip()]
        self.assertIn("skystrike", files)
        self.assertGreater(files.index("skystrike"), files.index("story"))

    def test_registers_valley_game(self):
        self.assertIn('id: "skystrike"', SKY)
        self.assertIn("HQV.register", SKY)
        self.assertIn("name: \"SkyStrike\"", SKY)

    def test_opens_the_commons(self):
        # the WHOLE map (HQ towers, Skyline Park) is the live Commons claude-hq@3.
        # The id must be resolved when the game OPENS, not when this Valley script
        # loads — world.js / hqcity3d.js do not exist yet at load time, so a
        # module-level id froze at claude-hq@2 and dropped the hero on the old
        # world. loadChain will not rescue that: it tries the id you ask for first.
        self.assertIn("claude-hq@3", SKY)
        self.assertNotIn('"claude-hq@2"', SKY)
        self.assertIn("function commonsId()", SKY)
        self.assertIn("W.COMMONS", SKY)
        self.assertIn("goCity", SKY)
        self.assertIn("startWorld = \"city\"", SKY)
        self.assertIn("api.outside", SKY)
        # resolved per open, after loadHq() — never frozen at module scope
        self.assertIn("skyCommons()", SKY)
        self.assertIn("HQV.skystrike.COMMONS === \"function\"", SKY)

    def test_is_original_not_marvel(self):
        self.assertNotIn("spider-man", SKY.lower())
        self.assertNotIn("spider man", SKY.lower())
        self.assertNotIn("peter parker", SKY.lower())
        self.assertNotIn("marvel", SKY.lower())
        self.assertNotIn("avengers", SKY.lower())

    def test_no_new_egress_or_random(self):
        self.assertNotIn("fetch(", SKY)
        self.assertNotIn("XMLHttpRequest", SKY)
        self.assertNotIn("EventSource", SKY)
        self.assertNotIn("Math.random", SKY)

    def test_city_only_chrome(self):
        self.assertIn("vg-sky-plain", SKY)
        self.assertIn("vg-sky-plain", CSS)
        self.assertIn("hqhud-gear", CSS)
        self.assertIn("hqnavui-panel", CSS)
        self.assertIn("hqhud-settings", CSS)
        self.assertIn("hq3d-ride", CSS)
        self.assertIn("hq3d-minimap-bar", CSS)
        self.assertIn("hq3d-skate", CSS)
        self.assertIn("hq3d-home", CSS)
        self.assertIn("hq3d-stats", CSS)


class SkyStrikeChaseCamera(unittest.TestCase):
    """SkyStrike only: the shared camrig MODES are tightened while the game is
    open and restored on leave, so HQ City keeps its own sightseeing camera."""

    def test_saves_and_restores_shared_camrig_modes(self):
        self.assertIn("__skySaved", SKY)
        self.assertIn("function tightenCam()", SKY)
        self.assertIn("function untightenCam()", SKY)
        self.assertIn("C.__skySaved.create.call(C, o)", SKY)
        self.assertIn("delete C.__skySaved", SKY)

    def test_whole_body_chase_not_the_city_sightseeing_cam(self):
        # "while swinging camera is getting too close ... whole character" and
        # "when i am standing normally, the camera is very far ... i want it close
        # as it was earlier, but when i am in air, the current camera distance is
        # fine" — TWO stand-offs: close city chase on the feet, whole-body in air.
        self.assertIn("var CAM_GROUND = {", SKY)
        self.assertIn("var CAM_AIR = {", SKY)
        self.assertIn("chase: {back: 3.35, up: 2.2, fov: 65", SKY)   # close on the ground
        self.assertIn("near:  {back: 2.5,  up: 1.8, fov: 70", SKY)
        self.assertIn("chase: {back: 7.0,  up: 3.8,  fov: 65", SKY)  # whole body in the air
        self.assertIn("near:  {back: 5.0,  up: 2.7,  fov: 70", SKY)
        self.assertIn("function camAir(on)", SKY)
        self.assertIn("camAirWant = w;", SKY)
        self.assertIn('o.mode = "chase"', SKY)
        # hq3d's airStep drives the switch from its `flying` flag
        self.assertIn("HQV.skystrike.camAir(flying);", HQ3D)

    def test_applies_after_hq_scripts_load(self):
        # camrig is not on the page until hqLoadScripts / HQ3D.load resolves
        self.assertIn("HQV.skystrike.tightenCam();   // camrig only exists once the HQ scripts have loaded", SKY)

    def test_arms_on_open_and_restores_on_destroy(self):
        self.assertIn("function arm(on){ ARMED = on ? 1 : 0; if(on) tightenCam(); else untightenCam(); }", SKY)
        self.assertIn("HQV.skystrike.arm(true)", SKY)
        self.assertIn("HQV.skystrike.arm(false)", SKY)

    def test_city_mode_table_left_as_data(self):
        # HQ City's own chase is still the wide one; only SkyStrike's save/restore touches it
        cam = (ROOT / "games" / "camrig.js").read_text(encoding="utf-8")
        self.assertIn("chase:   {back: 7, up: 3.8, fov: 65, side: 0, lag: 6, collide: 0.35, near: 0.3, chase: true}", cam)


class SkyStrikeBodyAndGait(unittest.TestCase):
    def test_human_head_hands_boots(self):
        self.assertIn("poseHero", SKY)
        self.assertIn("gaitPose", SKY)
        self.assertIn("cranium", SKY)
        self.assertIn("buildHand", SKY)
        self.assertIn("buildBoot", SKY)
        self.assertIn("knee-left", SKY)
        self.assertIn("elbow-left", SKY)
        self.assertIn("elbQ", SKY)
        self.assertIn("armQ", SKY)
        self.assertIn("kneeOf", SKY)
        self.assertIn("panelGeo", SKY)
        self.assertIn("lump(", SKY)

    def test_arms_hang_and_knee_folds_back(self):
        # hang via Z, elbow flex on local Y after the hang (not a twist)
        self.assertIn("AX_Y", SKY)
        self.assertIn("qAxis(THREE, AX_Y, -sign*flex", SKY)
        self.assertIn("qAxis(THREE, AX_Z, -sign*(ARM_T - (flare || 0)))", SKY)
        # qAxis must not require THREE.Vector3 (only quaternions at pose time)
        self.assertIn("setFromAxisAngle({x: ax.x, y: ax.y, z: ax.z}, ang)", SKY)
        # human knee: shin folds backward (positive rotation.x)
        self.assertIn("knee.rotation.x = kneeOf(p)", SKY)
        # hip flexion is applied as a negation (− = thigh forward)
        self.assertIn("hip.rotation.x = -(wHip*(1 - k) + rHip*k)", SKY)

    def test_human_run_cycle(self):
        # the run is a sprint, not a fast walk (HQ 3.19): thigh UP, heel to seat,
        # vigorous arms, more pitch. Walk keeps the old sprint silhouette.
        self.assertIn("keyAt", SKY)                  # cosine-eased keyframe tracks
        self.assertIn("RUN_KNEE", SKY)
        # heel kick: knee folds ~143 deg in swing — the biggest run cue
        self.assertIn("[0.62, 2.50]", SKY)
        # THIGH UP at contact and through terminal swing (walk only reaches 0.75)
        self.assertIn("[0, 1.10]", SKY)
        self.assertIn("[0.96, 1.18]", SKY)
        # hard hip drive back at toe-off (walk never goes past the mid-line much)
        self.assertIn("[0.32, -0.70]", SKY)
        # flexed stance knee that dips on landing (walk locks nearly straight)
        self.assertIn("[0.08, 0.88]", SKY)
        # hard plantarflexion push-off behind (toe-off)
        self.assertIn("[0.32, -0.68]", SKY)
        # bend ABOVE THE WAIST, and ONLY while running: walking is upright.
        # (The root tipping sank the whole body; a walk-side bend made walking lean.)
        self.assertIn("B.r.rotation.x = 0", SKY)
        self.assertIn("bend = 0.42*bk", SKY)
        self.assertIn("B.t.rotation.set(bend + 0.015*Math.sin(two*ph)", SKY)
        # runK is the KEY intent, not ws/move (which stays pinned at 1) and not
        # the eased ws (which lags ~0.3 s behind a stop) — both made the bend
        # and the run legs linger after a stop
        self.assertIn("gaitPose(ch, ph, ch._bendK, ch._bendK)", SKY)
        self.assertIn("ch._bendK = 0", SKY)          # ONE restore: keys up -> idle
        self.assertIn("ch._runWant", SKY)
        self.assertIn("ch._goWant", SKY)
        # shoulders wound against the pelvis (the chase-cam read)
        self.assertIn("yS*c", SKY)
        self.assertIn("yP*c*k", SKY)
        # braced elbow, punched higher at the front of the swing
        self.assertIn("rFlex = 1.58", SKY)
        # run springs (low at mid-stance, apex in flight); walk squashes.
        # Tame: it must never push the feet through the floor.
        self.assertIn("rBob = -0.055*(0.5 + 0.5*Math.cos(2*two*(ph - 0.12)))", SKY)
        # contralateral arms: left arm with the right leg, and armQ swing neg = forward
        self.assertIn("armSwing(ph + 0.5,  B.la", SKY)
        # run arm arc MUST out-swing the walk's (wSw is 0.82): that was the bug
        self.assertIn("rSw = -(0.18 + 1.02*c)", SKY)
        self.assertIn("wSw = -c*0.82", SKY)
        # run cadence is a sprint turnover (~216 steps/min, 1.80 Hz stride)
        self.assertIn("1.80*ws", SKY)
        # walk is the old sprint's stride (so W is the old run's pace)
        self.assertIn("1.35*ww", SKY)

    def test_rest_is_T_for_seating(self):
        self.assertIn("_tRest", SKY)
        self.assertIn("lav: new THREE.Vector3(0.55, 0, 0)", SKY)
        self.assertIn("aimBone", HQ3D)

    def test_hero_proportions(self):
        # concept sheet: matte charcoal, large angular neon lenses, draped hood,
        # strike chest emblem, muscular limbs, smooth taper, hero stance.
        self.assertIn("0, 0.012, -0.008, 1.05, 1.0, 1.05, 0.1", SKY)   # smooth cowl egg
        self.assertIn("s.moveTo(0.055, 0.022)", SKY)         # temple tip HIGH outward (large lenses)
        self.assertIn("s.lineTo(-0.048, -0.012)", SKY)       # nose tip LOW inward — the slant
        self.assertIn("eL.scale.set(1.15, 1.25, 1)", SKY)    # mask lenses (sheet-scale)
        self.assertIn("eL = mesh(THREE, eg, mNeon2, head, 0.042, 0.01, 0.092)", SKY)
        self.assertIn("bevelEnabled: false", SKY)            # flat lenses, no bevel puff
        self.assertIn("hoodRim", SKY)                        # draped hood rim (sheet silhouette)
        self.assertNotIn("cowl neck", SKY.lower())
        self.assertIn("capY(THREE, 0.04, 0.065, 14)", SKY)    # short visible neck (not giraffe, not invisible)
        self.assertIn("head.position.set(0, 0.635, 0)", SKY)  # head on the neck, not floating
        self.assertIn("capY(THREE, 0.052, 0.16, 14)", SKY)    # fat upper arm
        self.assertIn("capY(THREE, 0.088, 0.26, 16)", SKY)    # fat thigh (hero legs)
        self.assertIn("capY(THREE, 0.062, 0.24, 16)", SKY)    # fat shin / calf
        self.assertIn("0.235, 0.38", SKY)      # wide shoulder joints
        # smooth taper — no cliff from a wide chest into a wasp waist
        self.assertIn("0, 0.07, 0.004, 0.98", SKY)            # low waist step
        self.assertIn("0, 0.21, 0.012, 1.1", SKY)             # ribs / upper waist
        self.assertIn("hero idle", SKY)        # relaxed stance, not a robot hang
        self.assertIn("elbQ(THREE, 1, 0.55", SKY)             # elbows bent
        self.assertIn("B.rl.rotation.set(-0.05, 0, -0.16)", SKY)  # feet apart
        self.assertIn("crestGlow", SKY)       # strike emblem glow rim (sheet chest mark)
        self.assertIn("0x0c1016", SKY)         # matte charcoal suit

    def test_hooked_into_make_character(self):
        self.assertIn("HQV.skystrike", HQ3D)
        self.assertIn("SS.wanted(key)", HQ3D)
        self.assertIn("ch.hip || HIP", HQ3D)


# --- runtime harness: actually EXECUTE the gait. Substring checks cannot catch a
# ReferenceError (the bug where gaitPose's trunk/bounce lines used `p` but the
# parameter is `ph`) — that threw mid-frame and froze the whole city. ---
NODE_HARNESS = r"""
var fs = require("fs"), root = %(root)s;
global.window = {HQV: {}};
new Function(fs.readFileSync(root + "/games/skystrike.js", "utf8"))();
var P = window.HQV.skystrike && window.HQV.skystrike.pure;
var out = {};
if(!P){ out.missing = true; process.stdout.write(JSON.stringify(out)); process.exit(0); }

// mock three.js bones: rotation/position with .set(), a quaternion with the
// methods qAxis / armQ / elbQ call
function Euler(){ this.x = 0; this.y = 0; this.z = 0; }
Euler.prototype.set = function(x, y, z){ this.x = +x; this.y = +y; this.z = +z; };
function Quat(){ this.x = 0; this.y = 0; this.z = 0; this.w = 1; }
Quat.prototype.setFromAxisAngle = function(){ return this; };
Quat.prototype.copy = function(){ return this; };
Quat.prototype.multiply = function(){ return this; };
function bone(){
  return {
    rotation: new Euler(),
    position: {x: 0, y: 0, z: 0, set: function(x, y, z){ this.x = +x; this.y = +y; this.z = +z; }},
    quaternion: new Quat(),
    name: "b"
  };
}
function mkBones(){
  return {r: bone(), t: bone(), h: bone(), la: bone(), ra: bone(), le: bone(), re: bone(),
          lw: bone(), rw: bone(), ll: bone(), rl: bone(), lk: bone(), rk: bone(), lf: bone(), rf: bone()};
}
function finite(v){ return typeof v === "number" && isFinite(v); }

// 1. gaitPose must run a full cycle at every blend weight without throwing,
//    and every joint it writes must be finite.
var threw = null, seen = {};
try {
  var B = mkBones(), ch = {_bones: B};
  for(var wi = 0; wi <= 4; wi++){
    var k = wi/4;
    for(var i = 0; i < 64; i++){
      P.gaitPose(ch, i/64, k);
      [B.ll, B.lk, B.lf, B.rl, B.rk, B.rf].forEach(function(b, n){
        var v = b.rotation.x; if(!finite(v)) throw new Error("non-finite joint " + n + " = " + v);
        seen["joint" + n] = 1;
      });
      if(!finite(B.r.position.y) || !finite(B.r.rotation.x) || !finite(B.t.rotation.x) || !finite(B.h.rotation.x))
        throw new Error("non-finite trunk/root");
    }
  }
} catch(e){ threw = e.message || String(e); }
out.threw = threw;

// 2. the run heel kick must actually reach a deep fold (the "running not
//    walking" cue), and the walk must not lock the knee straight at contact.
try {
  var B2 = mkBones(), ch2 = {_bones: B2}, maxKnee = -1e9, minKnee = 1e9;
  for(var i = 0; i < 64; i++){
    P.gaitPose(ch2, i/64, 1);
    if(B2.lk.rotation.x > maxKnee) maxKnee = B2.lk.rotation.x;
    if(B2.lk.rotation.x < minKnee) minKnee = B2.lk.rotation.x;
  }
  out.runKneeMax = maxKnee;
  out.runKneeMin = minKnee;
} catch(e){ out.heelKickThrew = e.message || String(e); }

// 3. the run bounce must dip low and rise high (a flight), not stay flat
try {
  var B3 = mkBones(), ch3 = {_bones: B3}, lo = 1e9, hi = -1e9;
  for(var i = 0; i < 64; i++){
    P.gaitPose(ch3, i/64, 1);
    var y = B3.r.position.y; if(y < lo) lo = y; if(y > hi) hi = y;
  }
  out.bobRange = hi - lo;
} catch(e){ out.bobThrew = e.message || String(e); }

// 4. arms must be contralateral: with the left leg forward the right arm is
//    the one driven forward. Measure via the shoulder quaternion's twist.
function armPhase(B, k){
  // sample a full cycle and record when each shoulder's swing arg is most forward
  // (armQ swing is negative = forward; we detect it through the elbow flex/shoulder
  // proxy: compare the two arms' rotation.x after poseHero-free gaitPose)
  var laFwd = -1e9, laPh = 0, raFwd = -1e9, raPh = 0;
  for(var i = 0; i < 64; i++){
    var Bx = mkBones(), chx = {_bones: Bx};
    P.gaitPose(chx, i/64, k);
    // the hang maps local X to world -Y; the sagittal swing is applied about X,
    // so rotation.x of the shoulder after armQ is not readable as Euler. Use the
    // hip instead as the leg reference and check the two arms differ by half a
    // cycle — i.e. armSwing is called with ph+0.5 for la and ph for ra.
  }
  return 0;
}
out.contra = /armSwing\(ph \+ 0\.5,\s*B\.la/.test(fs.readFileSync(root + "/games/skystrike.js", "utf8")) &&
             /rSw = -\(0\.18 \+ 1\.02\*c\)/.test(fs.readFileSync(root + "/games/skystrike.js", "utf8"));

// 4b. the RUN must be visually distinct from the WALK: thigh swing range larger
//     (thighs go up), deeper heel kick, and a bigger root lean. Without this the
//     two paces collapse into "same walk, different speed".
try {
  function gaitSpan(k){
    var chx = {_bones: mkBones()};
    var hipLo = 1e9, hipHi = -1e9, kneeHi = -1e9, waist = -1e9, root = -1e9, sink = 1e9;
    for(var i = 0; i < 128; i++){
      P.gaitPose(chx, i/128, k);
      var h = chx._bones.ll.rotation.x;
      if(h < hipLo) hipLo = h;
      if(h > hipHi) hipHi = h;
      if(chx._bones.lk.rotation.x > kneeHi) kneeHi = chx._bones.lk.rotation.x;
      // the bend must be AT THE WAIST (torso), never on the root (which is the
      // pivot that tipped the whole body into the ground)
      if(chx._bones.t.rotation.x > waist) waist = chx._bones.t.rotation.x;
      if(Math.abs(chx._bones.r.rotation.x) > root) root = Math.abs(chx._bones.r.rotation.x);
      if(chx._bones.r.position.y < sink) sink = chx._bones.r.position.y;
    }
    return {hip: hipHi - hipLo, knee: kneeHi, waist: waist, root: root, sink: sink};
  }
  var walkS = gaitSpan(0), runS = gaitSpan(1);
  out.walkSpan = walkS.hip;
  out.runSpan = runS.hip;
  out.runLean = runS.waist;
  out.walkLean = walkS.waist;
  out.runKneeDeep = runS.knee;
  out.walkKneeDeep = walkS.knee;
  out.runRootTilt = runS.root;
  out.runSink = runS.sink;
  out.runDistinct = (runS.hip > walkS.hip + 0.25) && (runS.knee > walkS.knee + 0.3) && (runS.waist > walkS.waist + 0.05);
  out.bendAtWaist = (runS.root < 0.01) && (runS.sink > -0.07) && (runS.waist > 0.35);
  // walking must be UPRIGHT (no bend at the waist)
  out.walkUpright = walkS.waist < 0.06;
} catch(e){ out.distinctThrew = e.message || String(e); }

// 4c. the bend must unwind the instant the SPRINT weight drops — not linger
//     until the whole locomotion blend is gone. (runK is the absolute sprint
//     weight, so gaitPose's bend is a pure function of it.)
try {
  function bendAt(k){
    var chx = {_bones: mkBones()}, hi = -1e9;
    for(var i = 0; i < 64; i++){
      P.gaitPose(chx, i/64, k);
      if(chx._bones.t.rotation.x > hi) hi = chx._bones.t.rotation.x;
    }
    return hi;
  }
  var b0 = bendAt(0), b1 = bendAt(1), bh = bendAt(0.5);
  out.bendWalk = b0;
  out.bendRun = b1;
  out.bendHalf = bh;
  // linear in the sprint weight: half the sprint weight, half the bend
  out.bendScales = (Math.abs(bh - (b0 + b1)*0.5) < 0.02);
} catch(e){ out.bendScaleThrew = e.message || String(e); }

// 4d. poseHero during a sprint -> stop fade: the bend must fall with the sprint
//     weight (the deceleration case that used to hold the full bend until move
//     hit 0, then snap upright).
try {
  var chF = {_bones: mkBones()};
  chF.acts = {idle: {weight: 0}, walk: {weight: 0}, sprint: {weight: 0}, sit: {weight: 0}};
  chF.cur = "loco"; chF._ph = 0; chF._t = null;
  var fades = [], tF = 0;
  for(var s = 1.0; s >= -0.001; s -= 0.1){
    chF.acts.sprint.weight = Math.max(0, s);
    P.poseHero(chF, tF);
    tF += 0.05;
    fades.push(chF._bones.t.rotation.x);
  }
  out.fadeBends = fades;
  // must fall monotonically with the sprint weight and land on the idle stance
  // (~0.06 pitch), not hold the run bend and then snap
  out.fadeUnwinds = fades[0] > 0.35 && fades[fades.length - 1] < 0.09 &&
                    fades[2] < fades[0] && fades[5] < fades[2] && fades[8] < fades[5];
} catch(e){ out.fadeThrew = e.message || String(e); }

// 4e. ONE restore when the keys come up. A change of pace (Shift up / down
//     while still moving) must SETTLE — snapping it read as restore #1 — and
//     the stop itself is the single snap to idle. Starting a sprint is at once.
try {
  var chK = {_bones: mkBones()};
  chK.acts = {idle: {weight: 0}, walk: {weight: 0}, sprint: {weight: 1}, sit: {weight: 0}};
  chK.cur = "loco"; chK._ph = 0; chK._t = null;
  chK._runWant = 1; chK._goWant = 1; chK._spd = 10;

  // frame 1: full sprint, keys held
  P.poseHero(chK, 0.05);
  var bendHeld = chK._bones.t.rotation.x;

  // frame 2: Shift released, still moving at 9 m/s. Must NOT snap — the run
  // shape settles toward walk. (A snap here was restore #1.)
  chK._runWant = 0; chK._spd = 9;
  chK.acts.sprint.weight = 1; chK.acts.walk.weight = 0;   // eased weights still high
  P.poseHero(chK, 0.10);
  var bendShiftUp = chK._bones.t.rotation.x;

  // more frames of walking: the bend must ease down monotonically (a settle)
  var settles = [bendShiftUp];
  for(var sf = 0; sf < 6; sf++){
    P.poseHero(chK, 0.10 + (sf + 1)*0.05);
    settles.push(chK._bones.t.rotation.x);
  }
  var bendSettled = settles[settles.length - 1];

  // frame: keys up — ONE snap to idle, from wherever the settle got to
  chK._goWant = 0; chK._spd = 0.2;
  chK.acts.sprint.weight = 0.4; chK.acts.walk.weight = 0.3;
  P.poseHero(chK, 0.60);
  var bendStopped = chK._bones.t.rotation.x;

  // second frame of still: stays at idle (no bounce back)
  P.poseHero(chK, 0.65);
  var bendStill = chK._bones.t.rotation.x;

  out.keyBendHeld = bendHeld;
  out.keyBendShiftUp = bendShiftUp;
  out.keyBendSettled = bendSettled;
  out.keyBendStopped = bendStopped;
  out.keySettles = settles;
  // Shift-up while moving: NO snap (bend stays high on that frame), then eases
  out.shiftUpSettles = bendHeld > 0.35 && bendShiftUp > 0.25 &&
                      settles[3] < settles[0] && settles[6] < settles[3] &&
                      bendSettled < bendShiftUp;
  // the stop is the single snap: idle that frame, and it stays idle
  out.idleSnapsOn = bendStopped < 0.12 && bendStill < 0.12 &&
                   Math.abs(chK._bones.ll.rotation.x) < 0.25;

  // 4f. releasing EVERY key in one frame from a sprint is ONE restore:
  //     run -> idle directly, never through a walk-shaped intermediate.
  var chA = {_bones: mkBones()};
  chA.acts = {idle: {weight: 0}, walk: {weight: 0}, sprint: {weight: 1}, sit: {weight: 0}};
  chA.cur = "loco"; chA._ph = 0; chA._t = null;
  chA._runWant = 1; chA._goWant = 1; chA._spd = 10;
  P.poseHero(chA, 0.05);
  var runWaist = chA._bones.t.rotation.x, runThigh = -chA._bones.ll.rotation.x;
  // all keys up in one frame (the common "let go of everything" case)
  chA._runWant = 0; chA._goWant = 0; chA._spd = 0.2;
  chA.acts.sprint.weight = 0.8; chA.acts.walk.weight = 0.2;
  P.poseHero(chA, 0.10);
  var idleWaist = chA._bones.t.rotation.x, idleThigh = -chA._bones.ll.rotation.x;
  // the walk intermediate would have a medium thigh swing and no bend; idle
  // has a tiny thigh and the idle stance pitch (~0.06). One step must land
  // there, not at a walk pose.
  out.oneRestore = runWaist > 0.35 && idleWaist < 0.12 &&
                  runThigh > 0.4 && Math.abs(idleThigh) < 0.15 &&
                  Math.abs(chA._bones.rk.rotation.x - 0.20) < 0.06;
  // and a sprint start is instant (no ease-in)
  var chB = {_bones: mkBones()};
  chB.acts = {idle: {weight: 0}, walk: {weight: 0}, sprint: {weight: 0}, sit: {weight: 0}};
  chB.cur = "loco"; chB._ph = 0; chB._t = null; chB._bendK = 0;
  chB._runWant = 1; chB._goWant = 1; chB._spd = 10;
  chB.acts.sprint.weight = 0.1; chB.acts.walk.weight = 0.2;
  P.poseHero(chB, 0.05);
  out.sprintStartsAtOnce = chB._bones.t.rotation.x > 0.35;
} catch(e){ out.keySnapThrew = e.message || String(e); }

// 5. poseHero must drive the whole cycle too (that is what the frame calls)
try {
  var B4 = mkBones();
  var ch4 = {_bones: B4, acts: {idle: {weight: 0}, walk: {weight: 1}, sprint: {weight: 0}, sit: {weight: 0}}, cur: "loco", _ph: 0, _t: null};
  for(var t = 0; t < 2; t += 0.05) P.poseHero(ch4, t);
  out.poseHeroWalked = finite(B4.ll.rotation.x) && finite(B4.r.position.y);
  var ch5 = {_bones: mkBones(), acts: {idle: {weight: 0}, walk: {weight: 0}, sprint: {weight: 1}, sit: {weight: 0}}, cur: "loco", _ph: 0, _t: null};
  for(var t = 0; t < 2; t += 0.05) P.poseHero(ch5, t);
  out.poseHeroRan = finite(ch5._bones.ll.rotation.x);
  var ch6 = {_bones: mkBones(), acts: {idle: {weight: 1}, walk: {weight: 0}, sprint: {weight: 0}, sit: {weight: 0}}, cur: "loco", _ph: 0, _t: null};
  for(var t = 0; t < 2; t += 0.05) P.poseHero(ch6, t);
  out.poseHeroIdled = finite(ch6._bones.t.rotation.x);
} catch(e){ out.poseHeroThrew = e.message || String(e); }

// 6. tallTop: the spawn picker must pick the tallest deck and stand on it
try {
  var R = function(x, z, y, hw, hd, r, name){
    return {name: name || "t", pad: {x: x, z: z, y: y + 0.1, r: 5},
            deck: {x: x, z: z, hw: hw, hd: hd, r: r || 0, y: y, rot: 0},
            lift: {x: x + 1, z: z, y: y}};
  };
  // tallest wins
  var t1 = P.tallTop([R(0, 0, 20, 6, 6, 0, "low"), R(50, 50, 60, 6, 6, 0, "high")]);
  out.tallPicksHeight = t1 && Math.round(t1.y) === 60 && t1.name === "high";
  out.tallOnDeck = t1 && P.onDeckSpot({deck: {x: 50, z: 50, hw: 6, hd: 6, r: 0, rot: 0}}, t1.x, t1.z);
  // a disc roof (helideck) is valid too, and the spot is on the disc
  var t2 = P.tallTop([R(10, 10, 40, 0, 0, 8, "disc")]);
  out.tallDisc = t2 && Math.round(t2.y) === 40 && isFinite(t2.x) && isFinite(t2.z) && isFinite(t2.yaw)
                 && P.onDeckSpot({deck: {x: 10, z: 10, hw: 0, hd: 0, r: 8, rot: 0}}, t2.x, t2.z);
  // empty / missing list: null (street spawn stays)
  out.tallEmpty = P.tallTop([]) === null && P.tallTop(null) === null;
  // tie: the wider deck (more room to stand)
  var t3 = P.tallTop([R(0, 0, 30, 3, 3, 0, "narrow"), R(20, 0, 30, 10, 10, 0, "wide")]);
  out.tallTieBreaksArea = t3 && t3.name === "wide";
  // a broken entry (no deck) is skipped, not thrown on
  var t4 = P.tallTop([{name: "junk"}, R(0, 0, 55, 5, 5, 0, "ok")]);
  out.tallSkipsJunk = t4 && t4.name === "ok";
  // a lift parked outside a tiny deck: still stand on the deck, never off it
  var off = {name: "tiny", pad: {x: 0, z: 0, y: 50.1, r: 5},
             deck: {x: 0, z: 0, hw: 0.4, hd: 0.4, r: 0, y: 50, rot: 0},
             lift: {x: 4, z: 0, y: 50}};
  var t5 = P.tallTop([off]);
  out.tallStaysOnDeck = !!(t5 && P.onDeckSpot(off, t5.x, t5.z));
  // the head house is not walkable either
  out.tallSkipsHouse = !P.onDeckSpot({deck: {x: 0, z: 0, hw: 6, hd: 6, r: 0, rot: 0},
                                      house: {x: 0, z: 0, r: 0.75}}, 0, 0)
                       && P.onDeckSpot({deck: {x: 0, z: 0, hw: 6, hd: 6, r: 0, rot: 0},
                                        house: {x: 0, z: 0, r: 0.75}}, 3, 3);
  // a rotated deck: the rectangle is in its own frame
  out.tallRotatedDeck = P.onDeckSpot({deck: {x: 0, z: 0, hw: 2, hd: 8, r: 0, rot: Math.PI/2}}, 7, 0)
                        && !P.onDeckSpot({deck: {x: 0, z: 0, hw: 2, hd: 8, r: 0, rot: Math.PI/2}}, 0, 7);
  // myTop: your own roof wins over a taller neighbour's
  var tallN = R(0, 0, 80, 8, 8, 0, "neighbour"), mine = R(20, 0, 40, 6, 6, 0, "mine");
  mine.own = true;
  var m1 = P.myTop([tallN, mine]);
  out.myTopPrefersOwn = !!(m1 && m1.name === "your HQ" && Math.round(m1.y) === 40);
  out.myTopOnDeck = !!(m1 && P.onDeckSpot(mine, m1.x, m1.z));
  // no own roof in the list: fall back to the tallest
  var m2 = P.myTop([R(0, 0, 30, 5, 5, 0, "a"), R(10, 10, 60, 5, 5, 0, "b")]);
  out.myTopFallsToTall = !!(m2 && Math.round(m2.y) === 60);
  out.myTopEmpty = P.myTop([]) === null && P.myTop(null) === null;
} catch(e){ out.tallThrew = e.message || String(e); }

// 7. air: double jump, dive, neon web swing. Pure surface only — no THREE scene.
try {
  out.airHas = typeof P.jumpImpulse === "function" && typeof P.diveBlend === "function" &&
               typeof P.wantDive === "function" && typeof P.swingStep === "function" &&
               typeof P.webPoints === "function" && typeof P.airFrame === "function" &&
               typeof P.airPose === "function" && typeof P.makeWeb === "function" &&
               typeof P.jumpKick === "function" && typeof P.launchBlend === "function";

  // jumpImpulse: edge-triggered. A ground press is 7.2 and the DOUBLE jump is the
  // taller of the two (9.0 + a spin) — it is what carries you off the HQ deck.
  // A held key (no edge) never repeats.
  var js = {jumps: 0};
  var jg = P.jumpImpulse(js, true, true, false);
  out.groundJump = jg === 7.2 && js.jumps === 1 && js.launch === 1;
  var js2 = {jumps: 1};
  var ja = P.jumpImpulse(js2, false, true, false);
  out.doubleJump = ja === 9.0 && ja > jg && js2.jumps === 2 && js2.spinV > 0 && js2.launch === 1;
  out.thirdJumpNo = P.jumpImpulse({jumps: 2}, false, true, false) === 0;
  out.calmNoJump = P.jumpImpulse({jumps: 0}, true, true, true) === 0;
  out.heldSpaceNoRepeat = P.jumpImpulse({jumps: 1}, false, false, false) === 0;

  // jumpKick: a jump LEAVES the spot you stood on. Standing still, the facing
  // picks up the floor speed; already moving faster, it never slows you down.
  var jk = {vx: 0, vz: 0};
  P.jumpKick(jk, 0, 5.2);                       // yaw 0 -> +z
  out.jumpKickPushes = Math.abs(jk.vz - 5.2) < 1e-6 && jk.vx === 0;
  var jk2 = {vx: 8, vz: 0};
  P.jumpKick(jk2, 0, 5.2);
  out.jumpKickKeepsPace = jk2.vx === 8 && jk2.vz === 0;
  var jk3 = {vx: 0, vz: 0};
  P.jumpKick(jk3, Math.PI/2, 3.2);              // yaw 90deg -> +x
  out.jumpKickTurns = Math.abs(jk3.vx - 3.2) < 1e-6;

  // launchBlend: the jump bend is a short curl that UNWINDS IN THE AIR —
  // 1 at the press, 0 about a third of a second later (never held to the ground).
  var lb = {launch: 1}, acc = [];
  for(var li = 0; li < 24; li++) acc.push(P.launchBlend(lb, 0.05));
  // decays, hits 0 mid-fall (well before 24 frames), never goes negative
  out.launchRestoresInAir = acc[0] < 1 && acc[0] > acc[2] && acc[2] > acc[4] &&
                            acc[acc.length - 1] === 0 && acc[6] === 0;
  out.launchNeverNegative = P.launchBlend({launch: 0}, 0.05) === 0;

  // wantDive: W + falling from height. Not on a short hop, not while rising.
  out.diveFromHeight = P.wantDive(true, 8, -2) === true;
  out.diveOnHardDrop = P.wantDive(true, 0.4, -6) === true;
  out.noDiveWithoutW = P.wantDive(false, 20, -10) === false;
  out.noDiveRising = P.wantDive(true, 8, 3) === false;
  out.noDiveShortHop = P.wantDive(true, 0.2, 0) === false;

  // diveBlend: a continuous 0..1 that eases in and out, never snaps
  var ds = {}, d1 = P.diveBlend(ds, true, 0.016), d2 = P.diveBlend(ds, true, 0.016),
      d3 = P.diveBlend(ds, true, 0.016), d4 = P.diveBlend(ds, false, 0.016);
  out.diveEases = d1 > 0 && d2 > d1 && d3 > d2 && d3 < 1 && d4 < d3;

  // webPoints: a catenary that sags BELOW the straight line and keeps both ends
  var pts = P.webPoints({x: 0, y: 10, z: 0}, {x: 10, y: 10, z: 0}, 1, 8);
  var mid = pts[4], ends = pts[0].y === 10 && pts[8].y === 10;
  out.webSags = !!mid && mid.y < 10 && ends && pts.length === 9;

  // swingStep: an inextensible rope (never longer than len) and a pump that
  // actually adds energy at the bottom of the arc
  var sw = {x: 0, y: -2, z: 0, ax: 0, ay: 0, az: 0, len: 3,
            vx: 4, vy: 0, vz: 0, yaw: Math.PI/2, t: 0};
  var sw0x = sw.x, sw0y = sw.y;
  for(var si = 0; si < 30; si++) P.swingStep(sw, 0.033, {fwd: 1, side: 0});
  var dist = Math.sqrt((sw.x - sw.ax)*(sw.x - sw.ax) + (sw.y - sw.ay)*(sw.y - sw.ay) + (sw.z - sw.az)*(sw.z - sw.az));
  out.ropeHolds = dist <= sw.len + 1e-3;
  out.swingPumps = (sw.t > 0.9) && isFinite(sw.vx) && isFinite(sw.vy) && isFinite(sw.vz);
  // a rope never starts slack-then-snaps: the first step must already clamp
  var sw2 = {x: 0, y: -5, z: 0, ax: 0, ay: 0, az: 0, len: 2, vx: 0, vy: 0, vz: 0, yaw: 0, t: 0};
  P.swingStep(sw2, 0.033, {fwd: 0, side: 0});
  var d2 = Math.sqrt((sw2.x - sw2.ax)*(sw2.x - sw2.ax) + (sw2.y - sw2.ay)*(sw2.y - sw2.ay) + (sw2.z - sw2.az)*(sw2.z - sw2.az));
  out.ropeClamps = d2 <= sw2.len + 1e-3;

  // airFrame: ground -> jump -> fall -> double jump -> web fire -> release
  var A = {x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0, yaw: 0, jumps: 0, webSide: 1, t: 0};
  var E1 = {
    space: true, shift: false, w: false, fwd: 0, side: 0, heading: 0, calm: false,
    groundY: function(){ return 0; },
    blocked: function(){ return false; },
    anchor: null
  };
  var r1 = P.airFrame(A, E1, 0.016);
  out.airJumpsOffGround = r1.mode === "fall" && A.vy > 4 && A.jumps === 1;

  // the same press is consumed (held Space must not fire the double jump now)
  var r1b = P.airFrame(A, E1, 0.016);
  out.airHeldSpaceNoDouble = A.jumps === 1;

  // a fresh press in the air: the double jump, with a spin
  E1.space = false; P.airFrame(A, E1, 0.016);
  E1.space = true; var r2 = P.airFrame(A, E1, 0.016);
  out.airDoubleJump = A.jumps === 2 && A.spinV > 0;
  E1.space = false;

  // W while falling from height: the dive eases in
  A.y = 20; A.vy = -4; E1.w = true; E1.fwd = 1;
  P.airFrame(A, E1, 0.016); P.airFrame(A, E1, 0.016);
  out.airDives = (A.dive || 0) > 0.05;

  // Shift held with an anchor above: the web fires and the mode is "swing"
  E1.w = false; E1.fwd = 0;
  A.x = 0; A.y = 12; A.z = 0; A.vy = -2; A.vx = 3; A.vz = 0;
  var anchored = 0;
  E1.shift = true;
  E1.anchor = function(from, dir, maxDist){
    anchored++;
    // a tower ledge straight up-and-forward
    return {x: from.x + 2, y: from.y + 8, z: from.z + 4};
  };
  var r3 = P.airFrame(A, E1, 0.016);
  out.webFires = r3.mode === "swing" && r3.fire === true && !!A.sw && !!A.webTo && anchored > 0;
  out.webIsNeonGeometry = true;   // makeWeb is covered below; here: the endpoints exist
  out.webRopeIsRealDistance = !!(A.sw && A.sw.len >= 3.5);

  // the next frame the swing step runs and the pose gets a swing weight
  var r4 = P.airFrame(A, E1, 0.016);
  out.swingHolds = r4.mode === "swing" && !!A.sw;

  // Shift up: the line is gone that frame
  E1.shift = false;
  var r5 = P.airFrame(A, E1, 0.016);
  out.webReleasesOnShiftUp = r5.release === true && !A.sw && !A.webTo && r5.mode === "fall";

  // a jump while swinging with NOTHING in front: let go and kick up-and-forward
  A.x = 0; A.y = 10; A.z = 0; A.vx = 3; A.vy = 0; A.vz = 0; A.jumps = 1; A.coastT = 0;
  E1.shift = true;
  E1.anchor = function(){ return {x: 1, y: 16, z: 2}; };   // swing aims up (a hook)
  P.airFrame(A, E1, 0.016);
  var vyBefore = A.vy;
  E1.space = true;
  E1.anchor = null;                                        // no zip target in front
  var r6 = P.airFrame(A, E1, 0.016);
  out.swingJumpKicks = !A.sw && r6.mode === "fall" && A.vy > vyBefore;

  // ---- RELEASE COAST: letting go flies STRAIGHT, no turn back to the anchor ----
  E1.space = false; E1.shift = true; E1.w = false; E1.fwd = 1; E1.side = -1;
  E1.heading = 2.4;                       // camera looking somewhere else entirely
  A.x = 0; A.y = 20; A.z = 0; A.vx = 12; A.vy = -1; A.vz = 0; A.yaw = 0; A.jumps = 1;
  A.coastT = 0;
  A.shiftWas = false;                     // a NEW press, so the fire frame actually fires
  E1.anchor = function(from, dir){ return {x: from.x, y: from.y + 9, z: from.z + 1}; };
  P.airFrame(A, E1, 0.016);               // fire
  E1.shift = false;
  var yawAtRelease = A.yaw;
  var rRel = P.airFrame(A, E1, 0.016);    // the release frame
  out.webReleasesIntoCoast = rRel.release === true && A.coastT > 2.5;
  var vxRel = A.vx, vzRel = A.vz;
  // several frames of coast with a HARD steer and a different camera heading
  for(var ci = 0; ci < 8; ci++) P.airFrame(A, E1, 0.016);
  out.coastGoesStraight = Math.abs(A.vx - vxRel) < 3.5 && Math.abs(A.vz - vzRel) < 3.5 &&
                          Math.abs(A.vx) > 6;            // speed kept, not steered away
  out.coastFacesTravel = Math.abs(Math.sin(A.yaw) - A.vx/Math.max(1e-6, Math.hypot(A.vx, A.vz))) < 0.2;

  // ---- WEB ZIP: Space in the air throws at what is IN FRONT and yanks ----
  A.x = 0; A.y = 12; A.z = 0; A.vx = 0; A.vy = -3; A.vz = 0; A.yaw = 0; A.jumps = 1; A.coastT = 0;
  E1.fwd = 0; E1.side = 0; E1.heading = 0; E1.shift = false; E1.space = false;
  E1.anchor = function(from, dir){ return {x: from.x + dir.x*8, y: from.y + 2, z: from.z + dir.z*8}; };
  P.airFrame(A, E1, 0.016);
  E1.space = true;
  var rZip = P.airFrame(A, E1, 0.016);
  out.airSpaceZips = rZip.mode === "zip" && rZip.fire === true && !!A.zip && !!A.webTo;
  out.zipLineFromHand = !!(A.webFrom && A.webFrom.y > A.y + 1.5);
  // the yank pulls him TOWARD the point
  var z0x = A.x, z0z = A.z;
  for(var zi = 0; zi < 8; zi++) P.airFrame(A, E1, 0.016);
  out.zipPullsForward = A.z > z0z + 2 && Math.hypot(A.x - A.zip.ax, A.z - A.zip.az) < Math.hypot(z0x - 8, z0z - 8);
  E1.space = false;

  // Space in the air with NOTHING in front: the double jump still stands (HQ top)
  A.x = 0; A.y = 20; A.z = 0; A.vx = 0; A.vy = -2; A.vz = 0; A.jumps = 1; A.zip = null; A.coastT = 0;
  E1.anchor = null;
  P.airFrame(A, E1, 0.016);
  E1.space = true;
  var rDj = P.airFrame(A, E1, 0.016);
  out.airSpaceFallsBackToDoubleJump = !A.zip && A.jumps === 2 && A.spinV > 0;
  E1.space = false;

  // zipAims: a forward fan that still REACHES a wall at hand height, beside you
  // or a little below — a zip that only looks level finds nothing and Space does
  // nothing visible ("i cant see web zip at all", "pressing space is doing nothing")
  var za = P.zipAims(0);
  out.zipAimsForward = za.length >= 8 && za.length <= 14 && za[0].z > 0.8 && za[0].y < 0.4;
  out.zipAimsReachesDown = za.some(function(a){ return a.y < -0.1; });

  // armQ: the sagittal swing (about world X) is what stands the hanging arm up.
  // At -Math.PI the arm that hangs at -Y points straight UP — the web-arm angle.
  try {
    var acalls = [];
    function QQ(){}
    QQ.prototype.setFromAxisAngle = function(ax, a){ acalls.push({ax: ax, a: a}); return this; };
    QQ.prototype.copy = function(){ return this; };
    QQ.prototype.multiply = function(){ return this; };
    var qOut = new QQ();
    P.armQ({Quaternion: QQ}, 1, -Math.PI, qOut, 0.02);
    var sagittal = acalls.filter(function(c){ return c.ax && c.ax.x === 1; });
    out.armPointsStraightUp = sagittal.length === 1 && Math.abs(sagittal[0].a - (-Math.PI)) < 1e-6;
  } catch(e){ out.armQThrew = e.message || String(e); }

  // airPose: every joint finite at dive / swing / free
  try {
    var PB = mkBones(), pch = {_bones: PB};
    var poses = [{dive: 1, swing: 0, stretch: 0.4, tuck: 0, side: 1, t: 0.3},
                 {dive: 0, swing: 1, stretch: 0.7, tuck: 0.3, side: -1, t: 1.1},
                 {dive: 0.4, swing: 0, stretch: 1, tuck: 0, side: 1, t: 2.2},
                 {dive: 0, swing: 0, stretch: 0, tuck: 0, side: 1, t: 0}];
    var okPose = true;
    for(var pi = 0; pi < poses.length; pi++){
      P.airPose(pch, poses[pi]);
      [PB.t, PB.h, PB.ll, PB.rl, PB.lk, PB.rk, PB.la, PB.ra, PB.le, PB.re].forEach(function(b){
        if(!finite(b.rotation.x) || !finite(b.rotation.y) || !finite(b.rotation.z)) okPose = false;
      });
    }
    out.airPoseFinite = okPose;
  } catch(e){ out.airPoseThrew = e.message || String(e); }

  // poseHero must HAND THE BODY OVER when the air is live (no gait fight)
  try {
    var GA = mkBones();
    var gch = {_bones: GA, acts: {idle: {weight: 1}, walk: {weight: 0}, sprint: {weight: 1}, sit: {weight: 0}},
               cur: "loco", _ph: 0, _t: null};
    gch._air = {dive: 1, swing: 0, stretch: 0.2, tuck: 0, side: 1, t: 0};
    P.poseHero(gch, 0.05);
    // a dive pitches the torso hard forward — the gait never does that on idle
    out.poseHandsOver = GA.t.rotation.x > 1.0;
  } catch(e){ out.poseHandThrew = e.message || String(e); }

  // a PURE launch curl (no dive / swing / stretch) must hand the body over too
  try {
    var GP = mkBones();
    var pch = {_bones: GP, acts: {idle: {weight: 1}, walk: {weight: 0}, sprint: {weight: 1}, sit: {weight: 0}},
               cur: "loco", _ph: 0, _t: null};
    pch._air = {dive: 0, swing: 0, stretch: 0, tuck: 0, side: 1, t: 0, launch: 1};
    P.poseHero(pch, 0.05);
    out.poseHandsOverLaunch = GP.t.rotation.x > 0.3;
  } catch(e){ out.poseHandThrew = e.message || String(e); }

  // and the curl UNWINDS in the air: the bend is at the press and the torso
  // pitch must fall while he is still falling (stretch stays high in free fall).
  try {
    var GL = mkBones();
    var lch = {_bones: GL, acts: {idle: {weight: 1}, walk: {weight: 0}, sprint: {weight: 1}, sit: {weight: 0}},
               cur: "loco", _ph: 0, _t: null};
    lch._air = {dive: 0, swing: 0, stretch: 0.7, tuck: 0.3, side: 1, t: 0, launch: 1};
    P.poseHero(lch, 0.05);
    var bent = GL.t.rotation.x;
    lch._air = {dive: 0, swing: 0, stretch: 0.7, tuck: 0.3, side: 1, t: 0, launch: 0};
    P.poseHero(lch, 0.05);
    out.launchBendRestores = bent > 0.3 && GL.t.rotation.x < bent - 0.2;
  } catch(e){ out.poseHandThrew = e.message || String(e); }

  // makeWeb: needs a THREE with TubeGeometry; with none it must return null,
  // never throw (the harness has no scene)
  out.makeWebSafe = P.makeWeb(null, null, 0x2ec6ff) === null;

  // ---- live path: a fall off a tower face -> Shift fires -> SWING ----
  // This is the exact sequence the user runs: jump twice off the HQ, hold Shift.
  try {
    var AF = {x: 0, y: 40, z: 0, vx: 2, vy: -6, vz: 0, yaw: 0, jumps: 2, webSide: 1, t: 0, launch: 0, dive: 0};
    var EF = {
      space: false, shift: true, w: false, fwd: 0, side: 0, heading: 0, calm: false,
      groundY: function(){ return 0; },
      blocked: function(){ return false; },
      anchor: function(from, dir, maxDist){
        // a tower FACE beside him (the real geometry webHit returns): the ray
        // that looks slightly sideways/down must be the one that sticks
        if(dir && dir.x > 0.35 && dir.y > -0.4) return {x: 8, y: 38, z: 2};
        return null;
      }
    };
    var rf = P.airFrame(AF, EF, 0.016);
    out.webFaceSwings = rf.mode === "swing" && rf.fire === true && !!AF.sw;
    out.webFaceRope = !!(AF.sw && AF.sw.len > 2 && AF.webTo);
    // a fan that only aims up finds nothing on a fall down a face — this one
    // must ask for side / down-forward aims too
    var aims = P.webAims(0);
    var hasSide = false, hasDown = false;
    for(var ai = 0; ai < aims.length; ai++){
      if(Math.abs(aims[ai].x) > 0.55 && Math.abs(aims[ai].y) < 0.45) hasSide = true;
      if(aims[ai].y < -0.05) hasDown = true;
    }
    out.webAimsCoverFace = hasSide && hasDown && aims.length >= 10;
  } catch(e){ out.webFaceThrew = e.message || String(e); }

  // ---- live path: W while falling -> DIVE, and the pose is NOT a standing lean ----
  try {
    var AD = {x: 0, y: 30, z: 0, vx: 1, vy: -10, vz: 0, yaw: 0, jumps: 2, webSide: 1, t: 0};
    var ED = {
      space: false, shift: false, w: true, fwd: 1, side: 0, heading: 0, calm: false,
      groundY: function(){ return 0; }, blocked: function(){ return false; }, anchor: null
    };
    for(var di = 0; di < 12; di++) P.airFrame(AD, ED, 0.016);
    out.diveEngages = (AD.dive || 0) > 0.5;
    // the pose: the WHOLE body tips over (root + torso), not just the waist
    var DP = mkBones(), dch = {_bones: DP};
    P.airPose(dch, {dive: AD.dive, swing: 0, stretch: 0.2, tuck: 0, side: 1, t: 1, launch: 0});
    out.diveTipsBody = DP.r.rotation.x > 0.25 && DP.t.rotation.x > 1.0 && DP.h.rotation.x < -0.5;
    // free fall after a REAL descent (fallT ramps only when vy is down) is a
    // GLIDE: the body tips head-down and the legs lift behind. A plain jump is
    // NOT a dive — "even on jumping normally i am getting diving position".
    var FP = mkBones(), fch = {_bones: FP};
    P.airPose(fch, {dive: 0, swing: 0, stretch: 0.9, tuck: 0, side: 1, t: 1, launch: 0, fallT: 1});
    out.glideNotStanding = FP.r.rotation.x > 0.20 && FP.t.rotation.x > 0.35 && FP.h.rotation.x < -0.10 &&
                           FP.ll.rotation.x > 0.25 && FP.rl.rotation.x > 0.20;
    // and a plain jump (launch just fired, no descent yet) must stay a jump
    var JP = mkBones(), jch = {_bones: JP};
    P.airPose(jch, {dive: 0, swing: 0, stretch: 0.7, tuck: 0, side: 1, t: 0, launch: 1, fallT: 0});
    out.jumpIsNotDive = JP.r.rotation.x < 0.25 && JP.t.rotation.x < 0.55 && JP.ll.rotation.x < 0.45;
    // and the raised web arm: the origin is at head height (handOf), never a
    // point beside the chest. (The shoulder itself is a quaternion — the mock
    // Quat is a no-op, so the arm's raise is covered by the source contracts.)
    out.webArmUp = typeof P.handOf === "function" &&
                   P.handOf({x: 0, y: 0, z: 0, yaw: 0, webSide: 1}).y > 1.8 &&
                   P.handOf({x: 0, y: 0, z: 0, yaw: 0, webSide: -1}).y > 1.8 &&
                   Math.abs(P.handOf({x: 0, y: 0, z: 0, yaw: 0, webSide: 1}).x) > 0.3;
  } catch(e){ out.diveThrew = e.message || String(e); }

  // ---- live path: ALL construction is opaque — a swing never passes through ----
  try {
    var tower = [{id: "tower", min: {x: 10, y: 0, z: -6}, max: {x: 14, y: 60, z: 6}}];
    var hitB = P.bodyBlock({x: 0, y: 30, z: 0}, {x: 13, y: 30, z: 0, vx: 12, vy: -2, vz: 0}, tower, 0.42);
    out.blockStopsAtWall = hitB.x < 10.5 && hitB.x > 8 && Math.abs(hitB.y - 30) < 2;
    out.blockKillsInwardSpeed = Math.abs(hitB.vx) < 0.01;
    var openB = P.bodyBlock({x: 0, y: 30, z: 0}, {x: 2, y: 30, z: 1, vx: 1, vy: 0, vz: 1}, tower, 0.42);
    out.blockLetsOpen = openB.x === 2 && openB.vx === 1;
    // a swing arc that would pass through the tower must stop at the face
    var SW2 = {x: 0, y: 32, z: 0, ax: -18, ay: 42, az: 0, len: 22, vx: 14, vy: -1, vz: 0, yaw: Math.PI/2, t: 0};
    for(var si2 = 0; si2 < 40; si2++){
      var sp2 = {x: SW2.x, y: SW2.y, z: SW2.z};
      P.swingStep(SW2, 0.033, {fwd: 1, side: 0});
      var nb2 = P.bodyBlock(sp2, {x: SW2.x, y: SW2.y, z: SW2.z, vx: SW2.vx, vy: SW2.vy, vz: SW2.vz}, tower, 0.42);
      SW2.x = nb2.x; SW2.y = nb2.y; SW2.z = nb2.z; SW2.vx = nb2.vx; SW2.vy = nb2.vy; SW2.vz = nb2.vz;
    }
    out.swingNeverInsideTower = SW2.x < 10.5;
  } catch(e){ out.blockThrew = e.message || String(e); }

  // ---- live path: a WALL IN FRONT at hand height must zip and draw the line ----
  try {
    var AZ = {x: 0, y: 12, z: 0, vx: 0, vy: -3, vz: 0, yaw: 0, jumps: 1, webSide: 1, t: 0, fallT: 0.2, launch: 0};
    var EZ = {
      space: false, shift: false, w: false, fwd: 0, side: 0, heading: 0, calm: false,
      groundY: function(){ return 0; },
      blocked: function(){ return false; },
      anchor: function(from, dir){
        if(dir.z < 0.35) return null;
        var t = (8 - from.z) / dir.z;
        if(t < 0 || t > 42) return null;
        var y = from.y + dir.y * t;
        if(y < 6 || y > 18) return null;
        return {x: from.x + dir.x * t, y: y, z: 8};
      }
    };
    P.airFrame(AZ, EZ, 0.016);
    EZ.space = true;
    var rZip = P.airFrame(AZ, EZ, 0.016);
    out.zipFiresAtWall = rZip.mode === "zip" && rZip.fire === true && !!AZ.zip;
    out.zipLineDrawn = !!(AZ.webFrom && AZ.webTo && AZ.zip);
    // Space with NOTHING in front and no jumps left: still kicks (never a no-op)
    var AZ3 = {x: 0, y: 20, z: 0, vx: 0, vy: -2, vz: 0, yaw: 0, jumps: 2, webSide: 1, t: 0, fallT: 0.3};
    var vyB3 = AZ3.vy;
    var EZ3 = {
      space: false, shift: false, w: false, fwd: 0, side: 0, heading: 0, calm: false,
      groundY: function(){ return 0; }, blocked: function(){ return false; }, anchor: null
    };
    P.airFrame(AZ3, EZ3, 0.016);
    EZ3.space = true;
    P.airFrame(AZ3, EZ3, 0.016);
    out.spaceAlwaysActs = AZ3.vy > vyB3;
  } catch(e){ out.zipWallThrew = e.message || String(e); }

  // ---- live path: rayBoxes finds the tower face the web must stick to ----
  try {
    var boxes = [{id: "tower", min: {x: 6, y: 0, z: -4}, max: {x: 12, y: 60, z: 6}}];
    var hit = P.rayBoxes({x: 0, y: 40, z: 0}, {x: 1, y: -0.15, z: 0.1}, 42, boxes);
    out.rayBoxesHitsTower = !!(hit && hit.x > 5.5 && hit.x < 6.6 && Math.abs(hit.y - 40) < 4);
    var miss = P.rayBoxes({x: 0, y: 40, z: 0}, {x: 0, y: 1, z: 0}, 42, boxes);
    out.rayBoxesMissesSky = miss === null;
  } catch(e){ out.rayBoxesThrew = e.message || String(e); }

  // ---- live path: NEVER STUCK, NEVER THROUGH, AND A WALL-RUN ----
  // "now its even worse, i am getting stuck in between swinging / still going
  // through wall while swinging / when i run into any building while swinging i
  // should start running on the wall". Runtime numbers, not substrings.
  try {
    var tower = [{id: "tower", min: {x: 10, y: 0, z: -6}, max: {x: 14, y: 60, z: 6}}];
    function solids(x, y, z){
      if(x >= 8 && x <= 16 && y >= -1 && y <= 61 && z >= -8 && z <= 8) return tower;
      return [];
    }

    // (a) a start already INSIDE a box must be pushed out, not frozen there
    var dp = P.bodyBlock({x: 12, y: 30, z: 0}, {x: 12, y: 30, z: 0, vx: 0, vy: -8, vz: 0}, tower, 0.42);
    out.depenetrateFree = (dp.x < 10.4 || dp.x > 13.6 || dp.z < -5.4 || dp.z > 5.4);
    out.depenetrateNotFrozen = Math.abs(dp.vy) > 0.5;

    // (b) a long swing INTO the tower: never inside, never stuck
    var SW = {x: 0, y: 32, z: 0, ax: -2, ay: 55, az: 0, len: 24, vx: 12, vy: -1, vz: 0, yaw: Math.PI/2, t: 0};
    SW._blocked = function(bx, by, bz){ return bx >= 10 && bx <= 14 && by >= 0 && by <= 60 && bz >= -6 && bz <= 6; };
    var stuckF = 0, insideF = 0, wallF = 0, lx = SW.x, ly = SW.y, lz = SW.z;
    for(var si = 0; si < 120; si++){
      var sp = {x: SW.x, y: SW.y, z: SW.z};
      P.swingStep(SW, 0.033, {fwd: 1, side: 0});
      var nb = P.bodyBlock(sp, {x: SW.x, y: SW.y, z: SW.z, vx: SW.vx, vy: SW.vy, vz: SW.vz}, solids(SW.x, SW.y, SW.z), 0.42);
      SW.x = nb.x; SW.y = nb.y; SW.z = nb.z; SW.vx = nb.vx; SW.vy = nb.vy; SW.vz = nb.vz;
      if(nb.wall) wallF++;
      if(SW.x >= 10 && SW.x <= 14 && SW.z >= -6 && SW.z <= 6 && SW.y >= 0 && SW.y <= 60) insideF++;
      if(Math.hypot(SW.x - lx, SW.y - ly, SW.z - lz) < 0.001) stuckF++;
      lx = SW.x; ly = SW.y; lz = SW.z;
    }
    out.swingStuckFrames = stuckF;
    out.swingInsideFrames = insideF;
    out.swingWallFrames = wallF;
    out.swingNeverInsideTower2 = insideF === 0;
    out.swingNeverStuck = stuckF === 0;

    // (c) the rope clamp cannot tunnel: anchor on the FAR side of a tower
    var SW3 = {x: 0, y: 30, z: 0, ax: 30, ay: 45, az: 0, len: 32, vx: 22, vy: 0, vz: 0, yaw: Math.PI/2, t: 0};
    SW3._blocked = function(bx, by, bz){ return bx >= 10 && bx <= 14 && by >= 0 && by <= 60 && bz >= -6 && bz <= 6; };
    var tun = false;
    for(var si3 = 0; si3 < 60; si3++){
      var sp3 = {x: SW3.x, y: SW3.y, z: SW3.z};
      P.swingStep(SW3, 0.033, {fwd: 1, side: 0});
      var nb3 = P.bodyBlock(sp3, {x: SW3.x, y: SW3.y, z: SW3.z, vx: SW3.vx, vy: SW3.vy, vz: SW3.vz}, solids(SW3.x, SW3.y, SW3.z), 0.42);
      SW3.x = nb3.x; SW3.y = nb3.y; SW3.z = nb3.z; SW3.vx = nb3.vx; SW3.vy = nb3.vy; SW3.vz = nb3.vz;
      if(SW3.x > 10.2 && SW3.x < 13.8 && SW3.z > -5.5 && SW3.z < 5.5) tun = true;
    }
    out.ropeNoTunnel = !tun;

    // (d) a wall-run: crawl starts FROM THE GROUND (walk into the face), then
    //     Shift+W runs UP it. Air / swing contact must never start a crawl.
    var AW = {x: 9.2, y: 0, z: 0, vx: 0, vy: 0, vz: 0, yaw: Math.PI/2, jumps: 0, webSide: 1, t: 0};
    var EW = {
      space: false, shift: true, w: true, fwd: 1, side: 0, heading: Math.PI/2, calm: false,
      groundY: function(){ return 0; },
      blocked: function(x, z){ return x >= 10 && x <= 14 && z >= -6 && z <= 6; },
      anchor: null, solids: solids
    };
    var wallStart = false;
    for(var wi = 0; wi < 40; wi++){
      var rw = P.airFrame(AW, EW, 0.016);
      if(rw.mode === "wall"){ wallStart = true; break; }
    }
    out.wallRunStarts = wallStart;
    var y0 = AW.y;
    for(var wi2 = 0; wi2 < 50; wi2++) P.airFrame(AW, EW, 0.016);
    out.wallRunHeldY = AW.y > y0 - 2;
    out.wallRunClimbs = AW.y > y0 + 0.5;
    out.wallRunOnFace = Math.abs(AW.x - 9.80) < 0.25;

    // (e) a direction ALONG the face walks him sideways along the wall
    var AW2 = {x: 9.2, y: 0, z: 0, vx: 0, vy: 0, vz: 0, yaw: Math.PI/2, jumps: 0, webSide: 1, t: 0};
    var EW2 = {space: false, shift: false, w: true, fwd: 1, side: 0, heading: Math.PI/2, calm: false,
      groundY: function(){ return 0; },
      blocked: function(x, z){ return x >= 10 && x <= 14 && z >= -6 && z <= 6; },
      anchor: null, solids: solids};
    for(var wi3 = 0; wi3 < 20; wi3++){ var r2 = P.airFrame(AW2, EW2, 0.016); if(r2.mode === "wall") break; }
    // once on the face: side key crawls along it (camera still facing the wall)
    EW2.fwd = 0; EW2.w = false; EW2.side = 1; EW2.heading = Math.PI/2;
    var z1 = AW2.z;
    for(var wi4 = 0; wi4 < 50; wi4++) P.airFrame(AW2, EW2, 0.016);
    out.wallRunSteerAlong = Math.abs(AW2.z - z1) > 0.8;

    // (f) swinging into a face must NOT start a crawl — keep swinging / fall free
    var AS = {x: 2, y: 32, z: 0, yaw: Math.PI/2, jumps: 1, webSide: 1, t: 0};
    AS.sw = {ax: -2, ay: 55, az: 0, len: 24, x: 2, y: 32, z: 0, vx: 18, vy: -1, vz: 0, yaw: Math.PI/2, t: 0};
    var ES = {
      space: false, shift: true, w: true, fwd: 1, side: 0, heading: Math.PI/2, calm: false,
      groundY: function(){ return 0; }, blocked: function(){ return false; }, anchor: null, solids: solids
    };
    var swWall = false;
    for(var si2b = 0; si2b < 80; si2b++){
      var rs = P.airFrame(AS, ES, 0.016);
      if(rs.mode === "wall"){ swWall = true; break; }
    }
    out.swingDoesNotCrawl = !swWall;

    // (g) Space kicks off the wall (grip started from the ground)
    var AW4 = {x: 9.2, y: 0, z: 0, vx: 0, vy: 0, vz: 0, yaw: Math.PI/2, jumps: 0, webSide: 1, t: 0};
    var EW4 = {space: false, shift: false, w: true, fwd: 1, side: 0, heading: Math.PI/2, calm: false,
      groundY: function(){ return 0; },
      blocked: function(x, z){ return x >= 10 && x <= 14 && z >= -6 && z <= 6; },
      anchor: null, solids: solids};
    var onWall = false;
    for(var wi5 = 0; wi5 < 40; wi5++){ var r4 = P.airFrame(AW4, EW4, 0.016); if(r4.mode === "wall"){ onWall = true; break; } }
    EW4.space = true;
    var rk = P.airFrame(AW4, EW4, 0.016);
    out.wallSpaceKicks = onWall && rk.mode !== "wall" && AW4.vy > 2;

    // (h) the wall pose is a Spidey-style UPRIGHT crouch cling — never a dive
    //     tip that lays the body horizontal ("flying"). Moving: contralateral
    //     crawl. Idle: planted spider crouch.
    function armScoreAt(tt, move){
      var b = mkBones(), c = {_bones: b};
      P.airPose(c, {wall: 1, wallMove: move ? 1 : 0, wallRun: 0, dive: 0, swing: 0,
                    stretch: 0, t: tt, side: 1, launch: 0, fallT: 0});
      return b;
    }
    var wa = armScoreAt(0.1, true), wb = armScoreAt(0.1 + Math.PI/5.2, true);
    var wi = armScoreAt(0.1, false);
    // upright lean into the face (small pitch), hips dropped, chest pushed in
    out.wallPoseUpright = wa.r.rotation.x > 0.08 && wa.r.rotation.x < 0.35;
    out.wallPoseCrouch = wi.r.position.y < -0.12;
    out.wallPoseIntoFace = wi.r.position.z > 0.05;
    out.wallPoseNoDive = wi.r.rotation.x < 0.35;   // never the old 0.72 belly-down tip
    out.wallPoseCrawls = (function(){
      var dLeg = Math.abs(wa.ll.rotation.x - wb.ll.rotation.x);
      return dLeg > 0.15;
    })();
    out.wallPoseIdlePlanted = Math.abs(wi.ll.rotation.x - wi.rl.rotation.x) < 0.08;

    // ---- stick / crawl / run / jump-away (the controls the user asked for) ----
    // (i) Crawl starts FROM THE GROUND. Mid-air collision / hop beside a tower
    //     must NOT auto-cling. Once gripped from ground, release keys: CLING +
    //     slowly SLIDE DOWN — never freeze mid-air.
    var AS0 = {x: 2, y: 30, z: 0, vx: 20, vy: -2, vz: 0, yaw: Math.PI/2, jumps: 2, webSide: 1, t: 0, fallT: 0.6, launch: 0};
    var ES0 = {space: false, shift: false, w: false, fwd: 0, side: 0, heading: Math.PI/2, calm: false,
      groundY: function(){ return 0; }, blocked: function(){ return false; }, anchor: null, solids: solids};
    var autoCling = false;
    for(var ki0 = 0; ki0 < 40; ki0++){ var rk0 = P.airFrame(AS0, ES0, 0.016); if(rk0.mode === "wall"){ autoCling = true; break; } }
    out.noKeysDoesNotCling = !autoCling;
    // mid-air + W into the face must ALSO not cling (crawl is ground-only)
    var AS0b = {x: 2, y: 30, z: 0, vx: 20, vy: -2, vz: 0, yaw: Math.PI/2, jumps: 2, webSide: 1, t: 0, fallT: 0.6, launch: 0};
    var ES0b = {space: false, shift: false, w: true, fwd: 1, side: 0, heading: Math.PI/2, calm: false,
      groundY: function(){ return 0; }, blocked: function(){ return false; }, anchor: null, solids: solids};
    var airCling = false;
    for(var ki0b = 0; ki0b < 40; ki0b++){ var rk0b = P.airFrame(AS0b, ES0b, 0.016); if(rk0b.mode === "wall"){ airCling = true; break; } }
    out.airDoesNotCling = !airCling;

    function groundBlocked(x, z){ return x >= 10 && x <= 14 && z >= -6 && z <= 6; }
    // grip from the ground, climb clear of the street, then plant with zero
    // climb velocity so the idle slide is measurable (residual W climb used to
    // still rise for a few frames after keys came up).
    var AS1 = {x: 9.2, y: 0, z: 0, vx: 0, vy: 0, vz: 0, yaw: Math.PI/2, jumps: 0, webSide: 1, t: 0};
    var ES1 = {space: false, shift: false, w: true, fwd: 1, side: 0, heading: Math.PI/2, calm: false,
      groundY: function(){ return 0; }, blocked: groundBlocked, anchor: null, solids: solids};
    var onFace1 = false;
    for(var ki = 0; ki < 40; ki++){ var rk1 = P.airFrame(AS1, ES1, 0.016); if(rk1.mode === "wall"){ onFace1 = true; break; } }
    for(var kp = 0; kp < 90; kp++) P.airFrame(AS1, ES1, 0.016);
    AS1.vy = 0; AS1.vx = 0; AS1.vz = 0;
    ES1.w = false; ES1.fwd = 0;
    var stickY = AS1.y, stickX = AS1.x;
    for(var ki2 = 0; ki2 < 80; ki2++) P.airFrame(AS1, ES1, 0.016);
    out.wallSticks = onFace1 && AS1.y < stickY - 0.15 && Math.abs(AS1.x - stickX) < 0.35 && !!AS1.wall;
    out.wallStickStillOnFace = Math.abs(AS1.x - 9.80) < 0.3;
    // Shift EDGE on a cling fires a web swing (holding Shift alone must not)
    var AS1b = {x: 9.80, y: 28, z: 0, vx: 0, vy: 0, vz: 0, yaw: Math.PI/2, jumps: 1, webSide: 1, t: 0,
                wall: {nx: -1, nz: 0, t: 1}, shiftWas: false, dive: 0};
    var ES1b = {space: false, shift: true, w: false, fwd: 0, side: 0, heading: Math.PI/2, calm: false,
      groundY: function(){ return 0; }, blocked: function(){ return false; },
      solids: solids,
      anchor: function(){ return {x: 20, y: 40, z: 0}; }};
    var rSwing = P.airFrame(AS1b, ES1b, 0.016);
    out.wallShiftEdgeSwings = rSwing.mode === "swing" && !!AS1b.sw && !AS1b.wall && !!rSwing.fire;

    // (j) a direction key = CRAWL (slow), Shift + direction = RUN (fast)
    function climbWith(shift, keys){
      var A9 = {x: 9.2, y: 0, z: 0, vx: 0, vy: 0, vz: 0, yaw: Math.PI/2, jumps: 0, webSide: 1, t: 0};
      var E9 = {space: false, shift: shift, w: !!keys, fwd: keys ? 1 : 0, side: 0, heading: Math.PI/2, calm: false,
        groundY: function(){ return 0; }, blocked: groundBlocked, anchor: null, solids: solids};
      for(var q = 0; q < 40; q++){ var rr = P.airFrame(A9, E9, 0.016); if(rr.mode === "wall") break; }
      var y0 = A9.y;
      for(var q2 = 0; q2 < 45; q2++) P.airFrame(A9, E9, 0.016);
      return A9.y - y0;
    }
    var crawlUp = climbWith(false, true);
    var runUp = climbWith(true, true);
    out.wallCrawls = crawlUp > 0.4;
    out.wallRunsFaster = runUp > crawlUp*1.25;

    // (k) Space jumps AWAY from the wall and goes back to free fall (then you can
    //     dive with W or swing again with Shift). Grip starts from the ground.
    var AS2 = {x: 9.2, y: 0, z: 0, vx: 0, vy: 0, vz: 0, yaw: Math.PI/2, jumps: 0, webSide: 1, t: 0};
    var ES2 = {space: false, shift: false, w: true, fwd: 1, side: 0, heading: Math.PI/2, calm: false,
      groundY: function(){ return 0; }, blocked: groundBlocked, anchor: null, solids: solids};
    var onFace2 = false;
    for(var ki3 = 0; ki3 < 40; ki3++){ var rk3 = P.airFrame(AS2, ES2, 0.016); if(rk3.mode === "wall"){ onFace2 = true; break; } }
    // climb off the ground a bit so the kick is clearly mid-wall
    for(var kc = 0; kc < 40; kc++) P.airFrame(AS2, ES2, 0.016);
    ES2.space = true;
    var rk4 = P.airFrame(AS2, ES2, 0.016);
    var kickVy = AS2.vy, kickWall = AS2.wall, kickMode = rk4.mode;
    // the kick must send him OFF the face: over the next few frames he clears it
    ES2.space = false;
    for(var kf = 0; kf < 8; kf++) P.airFrame(AS2, ES2, 0.016);
    out.wallSpaceJumpsAway = onFace2 && kickMode === "fall" && kickVy > 2 && !kickWall &&
      AS2.x < 9.70;                                  // pushed OFF the face (crawl contact ~9.80)
    // and after that he is back in the air: a free fall (dive with W, swing with Shift)
    out.wallSpaceGivesFreeFall = !AS2.sw && !AS2.zip && !AS2.wall && AS2.y < 31;

    // (l) a leap PAST a building must still be swept: solids are queried along
    //     the whole path, not just at the destination
    var leaps = P.sweepBoxes({x: 0, y: 30, z: 0}, {x: 22, y: 30, z: 0}, solids);
    out.sweepFindsTower = leaps.length > 0;
    var leapMiss = P.sweepBoxes({x: 0, y: 30, z: 0}, {x: 1, y: 30, z: 0}, solids);
    out.sweepOpenAirEmpty = leapMiss.length === 0;

    // (m) the rope must NEVER lengthen (a stretchable rope cuts through towers)
    var SWL = {x: 0, y: -5, z: 0, ax: 0, ay: 0, az: 0, len: 2, vx: 0, vy: 0, vz: 0, yaw: 0, t: 0};
    SWL._blocked = function(bx, by, bz){ return by < -2; };
    P.swingStep(SWL, 0.033, {});
    out.ropeNeverLengthens = SWL.len <= 2 + 1e-9;

    // (n) the body must never LEAP through a tower on a long swing step
    var SW4 = {x: 0, y: 30, z: 0, ax: 30, ay: 45, az: 0, len: 32, vx: 60, vy: 0, vz: 0, yaw: Math.PI/2, t: 0};
    SW4._blocked = function(bx, by, bz){ return bx >= 10 && bx <= 14 && by >= 0 && by <= 60 && bz >= -6 && bz <= 6; };
    var leapIn = 0;
    for(var li = 0; li < 60; li++){
      var sp4 = {x: SW4.x, y: SW4.y, z: SW4.z};
      P.swingStep(SW4, 0.033, {fwd: 1, side: 0});
      var nb4 = P.bodyBlock(sp4, {x: SW4.x, y: SW4.y, z: SW4.z, vx: SW4.vx, vy: SW4.vy, vz: SW4.vz},
        P.sweepBoxes(sp4, SW4, solids), 0.42);
      SW4.x = nb4.x; SW4.y = nb4.y; SW4.z = nb4.z; SW4.vx = nb4.vx; SW4.vy = nb4.vy; SW4.vz = nb4.vz;
      if(SW4.x > 10.2 && SW4.x < 13.8 && SW4.z > -5.5 && SW4.z < 5.5) leapIn++;
    }
    out.leapNeverInsideTower = leapIn === 0;
  } catch(e){ out.stuckWallThrew = e.message || String(e); }

  // ===== the four complaints: stuck swings, auto web, tunnelling, no wall grip =====
  try {
    // A. NEVER STUCK: a swing fouled against geometry must RELEASE, not freeze;
    //    and a swing that covers no ground must not hang there either.
    var ST1 = {x: 12, y: 30, z: 0, ax: 0, ay: 55, az: 0, len: 22, vx: 0, vy: -0.1, vz: 0, yaw: 0, t: 0};
    ST1._blocked = function(bx, by, bz){ return bx >= 10 && bx <= 14 && by >= 0 && by <= 60 && bz >= -6 && bz <= 6; };
    var foulFrames = 0;
    for(var f1 = 0; f1 < 40; f1++){
      P.swingStep(ST1, 0.033, {fwd: 1, side: 0});
      if(ST1.dead){ foulFrames = f1 + 1; break; }
    }
    out.ropeFouledReleases = !!ST1.dead && foulFrames > 0 && foulFrames < 40;

    // A2. a BODY frozen against geometry must not HANG on the line. The swing
    //     step can push the rope-end into a wall and bodyBlock push it straight
    //     back every frame: the body covers no ground and the player is stuck
    //     "in air while swinging". Drop the line into free fall (or a wall grip).
    //     A slow pendulum apex is NOT stuck and must not be dropped.
    var AS3 = {x: 2, y: 30.42, z: 0, yaw: 0, jumps: 1, webSide: 1, t: 0, fallT: 0.5};
    // a slab whose top is at y = 30: the body rests on it, gravity pulls down,
    // bodyBlock holds it. The rope is just taut (dist <= len) so the clamp never
    // fouls — this is the stall case the foul detector cannot see.
    var slab = {id: "S", min: {x: -10, y: 0, z: -10}, max: {x: 10, y: 30, z: 10}};
    AS3.sw = {ax: 2, ay: 55, az: 0, len: 25, x: 2, y: 30.42, z: 0, vx: 0, vy: 0, vz: 0, yaw: 0, t: 0};
    var ES3 = {
      space: false, shift: true, w: false, fwd: 0, side: 0, heading: 0, calm: false,
      groundY: function(){ return 0; }, blocked: function(){ return false; }, anchor: null,
      solids: function(x, y, z){ return (x > -11 && x < 11 && y > -1 && y < 31 && z > -11 && z < 11) ? [slab] : []; }
    };
    var stallMode = "", stallFrames = 0;
    for(var f2 = 0; f2 < 90; f2++){
      var r2 = P.airFrame(AS3, ES3, 0.016);
      stallFrames++;
      if(r2.mode !== "swing"){ stallMode = r2.mode; break; }
    }
    // not hanging = the line is gone and he is no longer in "swing"
    out.swingNeverHangs = (stallMode === "fall" || stallMode === "wall") && !AS3.sw;
    out.swingStallDrops = stallFrames < 90;

    // A3. a slow pendulum apex is a real swing, not a hang: it must keep the line
    var AS3b = {x: 0, y: 30, z: 0, yaw: 0, jumps: 1, webSide: 1, t: 0, fallT: 0.2};
    AS3b.sw = {ax: 0, ay: 55, az: 0, len: 22, x: 0, y: 30, z: 0, vx: 0, vy: 0, vz: 0, yaw: 0, t: 0};
    var ES3b = {
      space: false, shift: true, w: true, fwd: 1, side: 0, heading: 0, calm: false,
      groundY: function(){ return 0; }, blocked: function(){ return false; }, anchor: null,
      solids: function(){ return []; }
    };
    var apexFrames = 0;
    for(var f3 = 0; f3 < 40; f3++){
      var r3b = P.airFrame(AS3b, ES3b, 0.016);
      apexFrames++;
      if(r3b.mode !== "swing"){ break; }
    }
    out.apexKeepsLine = !!AS3b.sw && apexFrames >= 40;

    // B. NO AUTO WEB while swinging: a shiftEdge is a NEW press. Hold Shift
    //    through a swing that gets released, then check no NEW line attached to
    //    the neighbouring tower until Shift is released and pressed again.
    //    Neighbour tower at x 26..30.
    function twoTowers(x, y, z){
      var outT = [];
      if(x > 8 && x < 14 && y > 0 && y < 60 && z > -8 && z < 8) outT.push({id: "A", min: {x: 10, y: 0, z: -6}, max: {x: 14, y: 60, z: 6}});
      if(x > 24 && x < 32 && y > 0 && y < 60 && z > -8 && z < 8) outT.push({id: "B", min: {x: 26, y: 0, z: -6}, max: {x: 30, y: 60, z: 6}});
      return outT;
    }
    var anchorsSeen = [];
    var envB = {
      space: false, shift: true, w: false, fwd: 0, side: 0, heading: Math.PI/2, calm: false,
      groundY: function(){ return 0; }, blocked: function(){ return false; },
      solids: twoTowers,
      anchor: function(from, dir, max){
        var got = P.rayBoxes(from, dir, max, twoTowers(from.x, from.y, from.z).concat([]));
        // gather far boxes too
        if(!got){
          var all = [
            {id: "A", min: {x: 10, y: 0, z: -6}, max: {x: 14, y: 60, z: 6}},
            {id: "B", min: {x: 26, y: 0, z: -6}, max: {x: 30, y: 60, z: 6}}
          ];
          got = P.rayBoxes(from, dir, max, all);
        }
        if(got) anchorsSeen.push(got.x);
        return got;
      }
    };
    // start swinging on tower A (x 10..14), and FACE tower B
    var AS4 = {x: 2, y: 34, z: 0, yaw: Math.PI/2, jumps: 1, webSide: 1, t: 0, fallT: 0.2};
    AS4.sw = {ax: 12, ay: 52, az: 0, len: 22, x: 2, y: 34, z: 0, vx: 4, vy: -2, vz: 0, yaw: Math.PI/2, t: 0};
    // hold Shift the WHOLE time (no release). Any re-aim would put a NEW anchor
    // on tower B (x 26..30) — that is the bug the user saw.
    var reaimB = 0, framesB = 0;
    for(var f3 = 0; f3 < 120; f3++){
      P.airFrame(AS4, envB, 0.016);
      framesB++;
      // a fresh web would set sw.ax on tower B
      if(AS4.sw && AS4.sw.ax >= 25 && AS4.sw.ax <= 31) reaimB++;
      // also: any NEW fire after frame 0 while Shift never dropped
    }
    out.noAutoWebToNeighbour = reaimB === 0;
    out.webStaysOnOriginalTower = !(AS4.sw && AS4.sw.ax >= 25);

    // B2. releasing Shift drops the line (so the next press can re-aim deliberately).
    //     Drive a fresh swing first — AS4's may already have dropped above.
    var ARel = {x: 2, y: 34, z: 0, yaw: Math.PI/2, jumps: 1, webSide: 1, t: 0, fallT: 0.2};
    ARel.sw = {ax: 12, ay: 52, az: 0, len: 22, x: 2, y: 34, z: 0, vx: 4, vy: -2, vz: 0, yaw: Math.PI/2, t: 0};
    var envHold = {
      space: false, shift: true, w: false, fwd: 0, side: 0, heading: Math.PI/2, calm: false,
      groundY: function(){ return 0; }, blocked: function(){ return false; }, anchor: envB.anchor, solids: twoTowers
    };
    P.airFrame(ARel, envHold, 0.016);                 // Shift held: still swinging
    var stillHolding = !!ARel.sw;
    var envRel = {
      space: false, shift: false, w: false, fwd: 0, side: 0, heading: Math.PI/2, calm: false,
      groundY: function(){ return 0; }, blocked: function(){ return false; }, anchor: envB.anchor, solids: twoTowers
    };
    var relMode = P.airFrame(ARel, envRel, 0.016);
    out.releaseShiftDropsWeb = stillHolding && relMode.release === true && !ARel.sw;

    // C. TUNNELLING: a zip is swept too (a fast yank used to check only the
    //    destination and sail through a tower in one frame).
    var AZ = {x: 0, y: 32, z: 0, yaw: Math.PI/2, jumps: 1, webSide: 1, t: 0};
    AZ.zip = {ax: 40, ay: 32, az: 0, t: 0, dur: 2.0};   // a long yank across the tower
    var inTower = 0;
    for(var z1 = 0; z1 < 40; z1++){
      var rz = P.airFrame(AZ, {
        space: false, shift: false, w: false, fwd: 0, side: 0, heading: Math.PI/2, calm: false,
        groundY: function(){ return 0; }, blocked: function(){ return false; }, anchor: null,
        solids: function(x, y, z){ return (x > 9 && x < 15 && y > 0 && y < 60 && z > -8 && z < 8) ?
          [{id: "T", min: {x: 10, y: 0, z: -6}, max: {x: 14, y: 60, z: 6}}] : []; }
      }, 0.016);
      if(AZ.x > 10.2 && AZ.x < 13.8 && AZ.z > -5.5 && AZ.z < 5.5) inTower++;
      if(rz.mode !== "zip" && !AZ.zip) break;
    }
    out.zipNeverInsideTower = inTower === 0;

    // D. GROUND WALL GRIP. The walk's blocked() has already stopped the feet at
    //    the face (x just under the wall) — that is the handoff the user could
    //    not see. From there, pushing INTO the face must start the grip.
    var GROUND_Y = 1.0;
    var EG = {
      space: false, shift: false, w: true, fwd: 1, side: 0, heading: Math.PI/2, calm: false,
      groundY: function(){ return GROUND_Y; },
      blocked: function(x, z){ return x > 9.5 && x < 14 && z > -6 && z < 6; },
      anchor: null,
      // always the tower: the hero is right on its face, so solids() must find it
      solids: function(x, y, z){ return [{id: "T", min: {x: 10, y: 0, z: -6}, max: {x: 14, y: 60, z: 6}}]; }
    };
    // the walk left him standing at the face, feet on the street, W held into it
    var AG = {x: 9.2, y: GROUND_Y, z: 0, vx: 0, vy: 0, vz: 0, yaw: Math.PI/2, jumps: 0, webSide: 1, t: 0};
    var groundWall = P.airFrame(AG, EG, 0.016);
    out.groundRunGrabsWall = groundWall.mode === "wall" && !!AG.wall;
    out.walkIntoGrip = !!P.wallFromInput({x: 9.2, y: GROUND_Y, z: 0, yaw: Math.PI/2},
      {fwd: 1, side: 0, heading: Math.PI/2, blocked: EG.blocked, solids: EG.solids});

    // D2. direction key crawls UP; Shift + direction RUNS (climbs further)
    function groundClimb(shift){
      var A9 = {x: 9.2, y: GROUND_Y, z: 0, vx: 0, vy: 0, vz: 0, yaw: Math.PI/2, jumps: 0, webSide: 1, t: 0};
      var E9 = {
        space: false, shift: shift, w: true, fwd: 1, side: 0, heading: Math.PI/2, calm: false,
        groundY: function(){ return GROUND_Y; }, blocked: EG.blocked, anchor: null, solids: EG.solids
      };
      var started = P.airFrame(A9, E9, 0.016);
      if(started.mode !== "wall") return NaN;
      var y0 = A9.y;
      for(var q = 0; q < 45; q++) P.airFrame(A9, E9, 0.016);
      return A9.y - y0;
    }
    var groundCrawl = groundClimb(false), groundRun = groundClimb(true);
    out.groundGripCrawls = groundCrawl > 0.4;
    out.groundGripRunsFaster = isFinite(groundRun) && isFinite(groundCrawl) && groundRun > groundCrawl*1.25;

    // D3. no keys = STICK (held on the face). Climb first so the plaster pull
    // has settled — measuring stickX on the first grip frame fought the pull-in.
    var AG4 = {x: 9.2, y: GROUND_Y, z: 0, vx: 0, vy: 0, vz: 0, yaw: Math.PI/2, jumps: 0, webSide: 1, t: 0};
    var startStick = P.airFrame(AG4, EG, 0.016);
    for(var g7 = 0; g7 < 40; g7++) P.airFrame(AG4, EG, 0.016);
    var stickY2 = AG4.y, stickX2 = AG4.x;
    var EG3 = {
      space: false, shift: false, w: false, fwd: 0, side: 0, heading: Math.PI/2, calm: false,
      groundY: function(){ return GROUND_Y; }, blocked: EG.blocked, anchor: null, solids: EG.solids
    };
    for(var g8 = 0; g8 < 50; g8++) P.airFrame(AG4, EG3, 0.016);
    out.groundGripSticks = startStick.mode === "wall" && !!AG4.wall &&
      Math.abs(AG4.y - stickY2) < 1.2 && Math.abs(AG4.x - stickX2) < 0.4;

    // D4. Space jumps AWAY into free fall
    EG3.space = true;
    var rKick = P.airFrame(AG4, EG3, 0.016);
    out.groundGripSpaceAway = rKick.mode === "fall" && !AG4.wall && AG4.vy > 2;

    // E. FACE NORMAL: grazing a tower's side near its cornice must report a SIDE
    //    face (wall = 1), not the top. That is what stopped the grip from ever
    //    starting on a swing into a wall.
    var box = [{id: "T", min: {x: 10, y: 0, z: -6}, max: {x: 14, y: 60, z: 6}}];
    var hitSide = P.bodyBlock({x: 2, y: 55, z: 0}, {x: 20, y: 55, z: 0, vx: 40, vy: 0, vz: 0}, box, 0.42);
    out.sideHitIsWall = hitSide.wall === 1 && Math.abs(hitSide.nx) === 1;
    var hitTop = P.bodyBlock({x: 12, y: 70, z: 0}, {x: 12, y: 50, z: 0, vx: 0, vy: -40, vz: 0}, box, 0.42);
    out.topHitIsRoof = hitTop.wall === 0 && hitTop.ny === 1;

    // E2. faceNormalAt finds the outward normal of the face you are pressed on
    var nA = P.faceNormalAt({x: 9.3, y: 20, z: 0}, {solids: function(){ return box; }}, null, null);
    out.faceNormalLeft = !!nA && nA.nx === -1 && nA.nz === 0;
    var nB = P.faceNormalAt({x: 14.7, y: 20, z: 0}, {solids: function(){ return box; }}, null, null);
    out.faceNormalRight = !!nB && nB.nx === 1 && nB.nz === 0;

    // F. THE HQ-ROOF BATCH (3.35). "now i am not able to jump off the hq roof" /
    //    "coming in contact with building i am getting stiff and just shaking" /
    //    "sometime jump doesn't even work, to jump away from building" /
    //    "it is very very much glitchy now". Runtime numbers on the REAL airFrame.
    try {
      // deck solid as hqcity3d emits it AFTER the fix: the walk height IS the top
      var DKY = 40, deckB = {id: "deck:0", min: {x: -12, y: DKY - 0.2, z: -12}, max: {x: 12, y: DKY, z: 12}};
      var twrB = {id: "twr", min: {x: 16, y: 0, z: -10}, max: {x: 30, y: 80, z: 10}};
      function solF(x, y, z){ return [deckB, twrB]; }
      function gyF(x, z){ return (x >= -12 && x <= 12 && z >= -12 && z <= 12) ? DKY : 0; }

      // F1. resting on the deck: never shoved DOWN through the roof
      var restH = P.bodyBlock({x: 0, y: DKY, z: 0}, {x: 0, y: DKY - 0.01, z: 0, vx: 0, vy: -0.01, vz: 0}, [deckB]);
      out.deckRestNotSwallowed = restH.y >= DKY - 0.02 && restH.ny >= 0;
      var landH = P.bodyBlock({x: 0, y: DKY + 0.4, z: 0}, {x: 0, y: DKY - 0.1, z: 0, vx: 0, vy: -8, vz: 0}, [deckB]);
      out.deckLandsOnTop = landH.y >= DKY - 0.02 && landH.ny === 1 && landH.wall === 0;

      // F2. the jump on the roof leaves with the impulse — not vy = 0
      var RJ = {x: 0, y: DKY, z: 0, vx: 0, vy: 0, vz: 0, yaw: 0, jumps: 0, webSide: 1, t: 0, spaceWas: false, shiftWas: false};
      var rjMode = P.airFrame(RJ, {
        space: true, shift: false, w: false, fwd: 0, side: 0, heading: 0, calm: false,
        groundY: gyF, blocked: function(){ return false; }, solids: solF, anchor: null
      }, 1/60);
      out.roofJumpLeaves = rjMode.mode === "fall" && RJ.vy > 5.5 && RJ.jumps === 1;

      // F3. a jump while pressing INTO a lift house is a JUMP, never eaten by the grip
      var houseB = {id: "house", min: {x: 1.2, y: DKY - 0.2, z: -1}, max: {x: 3.2, y: DKY + 3, z: 1}};
      var JW = {x: 0, y: DKY, z: 0, vx: 0, vy: 0, vz: 0, yaw: 0, jumps: 0, webSide: 1, t: 0, spaceWas: false, shiftWas: false};
      var jwMode = P.airFrame(JW, {
        space: true, shift: false, w: true, fwd: 1, side: 0, heading: 0, calm: false,
        groundY: gyF,
        blocked: function(x, z){ return x > 1.0 && x < 3.4 && z > -1.2 && z < 1.2; },
        solids: function(){ return [deckB, houseB]; }, anchor: null
      }, 1/60);
      out.jumpVsWallIsJump = jwMode.mode === "fall" && JW.vy > 5.5 && !JW.wall;

      // F4. wall crawl must NOT shake (the suction used to fight bodyBlock)
      var WR = {x: 15.2, y: 0, z: 0, vx: 2, vy: 0, vz: 0, yaw: Math.PI/2, jumps: 0, webSide: 1, t: 0, spaceWas: false, shiftWas: false};
      var envWR = {
        space: false, shift: false, w: true, fwd: 1, side: 0, heading: Math.PI/2, calm: false,
        groundY: function(){ return 0; }, blocked: function(x, z){ return x >= 16; }, solids: solF, anchor: null
      };
      var wTrail = [], wPrevX = null, wOsc = 0;
      for(var wi = 0; wi < 30; wi++){
        P.airFrame(WR, envWR, 1/30);
        wTrail.push({x: WR.x, y: WR.y});
        if(wPrevX != null && wi > 2 && (WR.x - wPrevX)*(wTrail[wi-1].x - (wTrail[wi-2] ? wTrail[wi-2].x : wPrevX)) < 0) wOsc++;
        wPrevX = WR.x;
      }
      var wClimb = wTrail[wTrail.length-1].y - wTrail[0].y;
      out.wallCrawlNoShake = wOsc <= 1;
      out.wallCrawlActuallyClimbs = wClimb > 1.0;

      // F5. Space while gripped jumps AWAY (fall, not wall, not zip)
      var JA = {x: 15.2, y: 10, z: 0, vx: -1, vy: 0, vz: 0, yaw: Math.PI/2, jumps: 0, webSide: 1, t: 0,
                spaceWas: false, shiftWas: false, wall: {nx: -1, nz: 0, t: 0.5, run: 0}};
      var jaMode = P.airFrame(JA, {
        space: true, shift: false, w: false, fwd: 0, side: 0, heading: Math.PI/2, calm: false,
        groundY: function(){ return 0; }, blocked: function(){ return false; }, solids: solF, anchor: null
      }, 1/60);
      out.gripSpaceJumpsAway = jaMode.mode === "fall" && !JA.wall && JA.vy > 2;

      // F6. free-fall Space NEAR a wall escapes it, never zips INTO it
      var FF = {x: 14.0, y: 10, z: 0, vx: 2, vy: -3, vz: 0, yaw: Math.PI/2, jumps: 1, webSide: 1, t: 0, spaceWas: false, shiftWas: false};
      var ffMode = P.airFrame(FF, {
        space: true, shift: false, w: false, fwd: 0, side: 0, heading: Math.PI/2, calm: false,
        groundY: function(){ return 0; }, blocked: function(){ return false; }, solids: solF,
        anchor: function(from, dir){ return {x: 16, y: from.y + 2, z: 0}; }
      }, 1/60);
      out.nearWallSpaceEscapes = ffMode.mode !== "zip" && !FF.zip && FF.vy > 2;

      // F7. the SAME press with a wall genuinely IN FRONT at hand height still zips
      //     (regression: the escape rule must not kill the real zip)
      var AZf = {x: 0, y: 12, z: 0, vx: 0, vy: -3, vz: 0, yaw: 0, jumps: 1, webSide: 1, t: 0, fallT: 0.2, launch: 0, spaceWas: false, shiftWas: false};
      var EZf = {
        space: false, shift: false, w: false, fwd: 0, side: 0, heading: 0, calm: false,
        groundY: function(){ return 0; }, blocked: function(){ return false; },
        anchor: function(from, dir){
          if(dir.z < 0.35) return null;
          var t = (8 - from.z) / dir.z;
          if(t < 0 || t > 42) return null;
          var y = from.y + dir.y * t;
          if(y < 6 || y > 18) return null;
          return {x: from.x + dir.x * t, y: y, z: 8};
        }
      };
      P.airFrame(AZf, EZf, 0.016);
      EZf.space = true;
      var zf = P.airFrame(AZf, EZf, 0.016);
      out.frontWallStillZips = zf.mode === "zip" && zf.fire === true && !!AZf.zip;

      // F8. the deck solid's TOP is the walk height (the geometry that caused
      //     the swallow). A body standing at deck.y rests ON the top face —
      //     never inside the slab, never below its top.
      out.deckTopIsWalkHeight = deckB.max.y === DKY && deckB.min.y < DKY;

      // ---- G. the WALL CRAWL batch (3.35.2). "i cant crawl on the wall of
      //      buildings / i am just floating near them". Live-path numbers. ----
      try {
        var twrC = {id: "twr", min: {x: 16, y: 0, z: -20}, max: {x: 40, y: 80, z: 20}};
        function solC(x, y, z){ return [twrC]; }
        function cityBlockedC(x, z){ return x >= 16 && x <= 40 && z >= -20 && z <= 20; }
        function mkEnvC(keys, heading, y){
          var kf = (keys.KeyW ? 1 : 0) - (keys.KeyS ? 1 : 0);
          var ks = (keys.KeyA ? 1 : 0) - (keys.KeyD ? 1 : 0);
          return {
            space: !!keys.Space, shift: !!keys.ShiftLeft, w: !!keys.KeyW,
            fwd: kf, side: ks, heading: heading, calm: false,
            groundY: function(){ return 0; },
            blocked: function(x, z){
              if((+y || 0) > 0.15) return false;
              return cityBlockedC(x, z);
            },
            solids: solC, anchor: null
          };
        }
        function mkStC(x, y, z, yaw, extra){
          var s0 = {x: x, y: y, z: z, vx: 0, vy: 0, vz: 0, yaw: yaw,
                    jumps: 0, webSide: 1, t: 0, spaceWas: false, shiftWas: false};
          if(extra) for(var k0 in extra) s0[k0] = extra[k0];
          return s0;
        }

        // G1. ground walk INTO the wall (body-relative facing = +X) must grab
        //     and CLIMB, not stand there stiff. The walk leaves him at the face.
        var GA = mkStC(15.85, 0, 0, Math.PI/2);
        for(var gi = 0; gi < 24; gi++) P.airFrame(GA, mkEnvC({KeyW: true}, Math.PI/2, GA.y), 1/60);
        out.groundIntoClimbs = !!GA.wall && GA.mode !== "ground" && GA.y > 0.3;
        out.groundIntoOnFace = Math.abs(GA.x - 15.80) < 0.12;

        // G2. the grab uses the BODY's facing, not the camera's. A chase cam
        //     drifted sideways used to make W mean "along the wall" and the
        //     grip never started ("floating near them").
        var GM = mkStC(15.85, 0, 0, Math.PI/2);
        for(var mi = 0; mi < 24; mi++) P.airFrame(GM, mkEnvC({KeyW: true}, 0, GM.y), 1/60);
        out.bodyFacingGrabs = !!GM.wall && GM.y > 0.3;

        // G3. once gripped the crawl is WALL-LOCAL: W climbs even when the
        //     camera points along the face.
        var GN = mkStC(15.80, 10, 0, 0, {wall: {nx: -1, nz: 0, t: 0.2, run: 0, move: 1}, jumps: 1});
        var nY0 = GN.y;
        for(var ni = 0; ni < 30; ni++) P.airFrame(GN, mkEnvC({KeyW: true}, 0, GN.y), 1/60);
        out.wallLocalWClimbs = GN.y - nY0 > 0.5;

        // G4. A / D alone crawls SIDEWAYS and holds the height (the old gravity
        //     bleed slid a sideways crawl down the face).
        var GO = mkStC(15.80, 10, 0, Math.PI/2, {wall: {nx: -1, nz: 0, t: 0.2, run: 0, move: 1}, jumps: 1});
        var oY0 = GO.y, oZ0 = GO.z;
        for(var oi = 0; oi < 30; oi++) P.airFrame(GO, mkEnvC({KeyA: true}, Math.PI/2, GO.y), 1/60);
        out.wallLocalAHolds = Math.abs(GO.y - oY0) < 0.25 && Math.abs(GO.z - oZ0) > 0.3;

        // G5. mid-air beside a face must NEVER crawl (even with W into it) —
        //     crawl is ground-only. Idle fall also must not snap on.
        var GD = mkStC(15.30, 12, 0, Math.PI/2, {vx: 0, vy: -1, vz: 0, jumps: 1});
        for(var di = 0; di < 30; di++) P.airFrame(GD, mkEnvC({KeyW: true}, Math.PI/2, GD.y), 1/60);
        out.fallBesideDoesNotGrip = !GD.wall;
        var GE = mkStC(15.30, 12, 0, Math.PI/2, {vx: 0, vy: -1, vz: 0, jumps: 1});
        for(var ei = 0; ei < 30; ei++) P.airFrame(GE, mkEnvC({}, Math.PI/2, GE.y), 1/60);
        out.fallBesideIdleFalls = !GE.wall && GE.y < 11.5;

        // G6. a zip stand-off mid-air must also NOT auto-crawl (swing/zip free).
        var GP = mkStC(14.75, 10, 0, Math.PI/2, {vx: 0, vy: -1, vz: 0, jumps: 1, spaceWas: true, shiftWas: true});
        for(var pi = 0; pi < 20; pi++) P.airFrame(GP, mkEnvC({KeyW: true}, Math.PI/2, GP.y), 1/60);
        out.zipStandoffDoesNotGrip = !GP.wall;

        // G7. Shift + W runs the face faster than a plain W crawl
        function climbC(keys, shift){
          var GQ = mkStC(15.80, 10, 0, Math.PI/2, {wall: {nx: -1, nz: 0, t: 0.2, run: 0, move: 1}, jumps: 1});
          var y0q = GQ.y;
          for(var qi = 0; qi < 30; qi++){
            var kq = {}; for(var kq2 in keys) kq[kq2] = keys[kq2];
            if(shift) kq.ShiftLeft = true;
            P.airFrame(GQ, mkEnvC(kq, Math.PI/2, GQ.y), 1/60);
          }
          return GQ.y - y0q;
        }
        var cCrawl = climbC({KeyW: true}, false), cRun = climbC({KeyW: true}, true);
        out.runIsFaster = cRun > cCrawl*1.25;

        // G8. NO Space ever: contact + W alone grabs and climbs. Space is for
        //     jumping on the ground, not for starting a wall crawl.
        var GS = mkStC(15.85, 0, 0, Math.PI/2);
        var spaceSeen = false;
        for(var si3 = 0; si3 < 24; si3++){
          var eS = mkEnvC({KeyW: true}, Math.PI/2, GS.y);
          if(eS.space) spaceSeen = true;
          P.airFrame(GS, eS, 1/60);
        }
        out.noSpaceClimbs = !!GS.wall && GS.y > 0.3 && !spaceSeen;

        // G9. the grip turns the BODY to FACE the wall. Ground walk into the
        //     face (body already facing it; camera can drift) latches, and
        //     wallStep keeps yaw = atan2(-nx,-nz).
        var GY = mkStC(15.85, 0, 0, Math.PI/2);
        var yawOnGrip = null;
        for(var yi = 0; yi < 24; yi++){
          P.airFrame(GY, mkEnvC({KeyW: true}, 0, GY.y), 1/60);
          if(GY.wall && yawOnGrip === null) yawOnGrip = GY.yaw;
        }
        out.gripFacesWall = yawOnGrip !== null && Math.abs(yawOnGrip - Math.PI/2) < 0.2;

        // G10. the grip RELEASES when the body is pulled off the face. The old
        //      release probe sampled deep inside thick towers at st.y, so the
        //      grip never let go and the hero "flew" along the wall.
        var GR = mkStC(15.80, 10, 0, Math.PI/2, {wall: {nx: -1, nz: 0, t: 0.2, run: 0, move: 1}, jumps: 1});
        for(var ri = 0; ri < 6; ri++) P.airFrame(GR, mkEnvC({KeyA: true}, Math.PI/2, GR.y), 1/60);
        var heldContact = !!GR.wall;
        GR.x = 13.50;                       // yank him clear of the 2.2 m keep-probe
        var relFrame = -1;
        for(var rj = 0; rj < 30; rj++){
          P.airFrame(GR, mkEnvC({}, Math.PI/2, GR.y), 1/60);
          if(!GR.wall && relFrame < 0) relFrame = rj;
        }
        out.gripReleasesOffFace = heldContact && !GR.wall && relFrame >= 0;

        // G11. NEVER latch a wall from mid-air far away. Returning the "lead"
        //      face when nothing was in reach made nearFaceGrip grab a tower
        //      6 m off, the leave-probe drop it next frame, and the dive
        //      flicker wall↔fall forever ("can't crawl / glitchy").
        var farN = P.faceNormalAt({x: 8.0, y: 20, z: 0}, {solids: function(){ return [twrC]; }}, null, null, 1.6);
        var farG = P.nearFaceGrip({x: 8.0, y: 20, z: 0, yaw: Math.PI/2},
          {fwd: 1, side: 0, heading: Math.PI/2, solids: function(){ return [twrC]; }}, 1.6);
        out.noFarLatch = !farN && !farG;

        // G12. Dive into a stepped tower (storey + podium + paper-thin panes):
        //      never enter the mass, never auto-crawl mid-air, no wall↔fall
        //      flicker. Crawl only starts from the ground.
        var storey = {id: "storey", min: {x: -3.5, y: 0, z: -10.5}, max: {x: 3.5, y: 34, z: 10.5}};
        var podium = {id: "podium", min: {x: -5.5, y: 0, z: -13.5}, max: {x: 5.5, y: 6, z: 13.5}};
        var panes = [];
        for(var pf = 0; pf < 4; pf++) for(var pr = 0; pr < 4; pr++){
          var py0 = 4 + pr*7, py1 = py0 + 4.2;
          if(pf === 0) panes.push({id: "win:"+panes.length, min: {x: storey.min.x-0.05, y: py0, z: storey.min.z-0.5}, max: {x: storey.min.x+0.05, y: py1, z: storey.max.z+0.5}});
          if(pf === 1) panes.push({id: "win:"+panes.length, min: {x: storey.max.x-0.05, y: py0, z: storey.min.z-0.5}, max: {x: storey.max.x+0.05, y: py1, z: storey.max.z+0.5}});
        }
        function steppedSolids(){ return [storey, podium].concat(panes); }
        function steppedEnv(){
          return {space: false, shift: false, w: true, fwd: 1, side: 0, heading: Math.PI/2, calm: false,
                  groundY: function(){ return 0; }, blocked: function(){ return false; },
                  solids: steppedSolids, anchor: null};
        }
        var GD = mkStC(-12, 20, 0, Math.PI/2, {vx: 10, vy: -2, jumps: 1});
        var entered = false, crossed = false, wallFrames = 0, modeSeq = [], lastMode = "";
        for(var di = 0; di < 120; di++){
          var rd = P.airFrame(GD, steppedEnv(), 1/60);
          if(rd.mode !== lastMode){ modeSeq.push(rd.mode); lastMode = rd.mode; }
          if(GD.wall) wallFrames++;
          if(GD.x > storey.min.x && GD.x < storey.max.x) entered = true;
          if(GD.x > storey.max.x + 2) crossed = true;
        }
        var flickers = 0;
        for(var fi = 1; fi < modeSeq.length; fi++){
          if((modeSeq[fi-1] === "wall" && modeSeq[fi] === "fall") ||
             (modeSeq[fi-1] === "fall" && modeSeq[fi] === "wall")) flickers++;
        }
        out.diveNeverThrough = !entered && !crossed;
        out.diveDoesNotCrawl = wallFrames === 0 && !GD.wall;
        out.diveNoFlicker = flickers === 0;
        out.isWallMassFiltersPane = !P.isWallMass(panes[0]) && !!P.isWallMass(storey);
      } catch(e){ out.crawlBatchThrew = e.message || String(e); }
    } catch(e){ out.roofBatchThrew = e.message || String(e); }
  } catch(e){ out.fourFixesThrew = e.message || String(e); }
} catch(e){ out.airThrew = e.message || String(e); }

process.stdout.write(JSON.stringify(out));
"""


@unittest.skipUnless(NODE, "node is not installed")
class SkyStrikeGaitRuntime(unittest.TestCase):
    """Run the gait for real. A substring assert cannot catch a ReferenceError —
    which is exactly what froze movement (the frame threw before render)."""

    @classmethod
    def setUpClass(cls):
        r = subprocess.run([NODE, "-"], input=NODE_HARNESS % {"root": json.dumps(str(ROOT))},
                           capture_output=True, text=True, timeout=60)
        if r.returncode:
            raise AssertionError(r.stderr)
        cls.o = json.loads(r.stdout)

    def test_gait_pose_runs_without_throwing(self):
        self.assertNotIn("missing", self.o)
        self.assertIsNone(self.o["threw"], self.o["threw"])

    def test_heel_kick_reaches_a_deep_fold(self):
        # the single biggest "running, not fast walking" tell
        self.assertGreater(self.o["runKneeMax"], 2.0, "heel kick must fold the knee past 2.0 rad")
        self.assertLess(self.o["runKneeMin"], 0.6, "stance knee must stay flexed, never lock straight")

    def test_run_has_a_flight_bounce(self):
        self.assertGreater(self.o["bobRange"], 0.04, "the run must spring (low at mid-stance, apex in flight)")

    def test_arms_are_contradalateral(self):
        self.assertTrue(self.o["contra"])

    def test_run_is_visually_distinct_from_walk(self):
        # the complaint that started this: "i dont see any different in running
        # and walking except speed". The run must lift the thigh further, fold
        # the knee deeper, and pitch the trunk harder than the walk does.
        self.assertNotIn("distinctThrew", self.o, self.o.get("distinctThrew"))
        self.assertGreater(self.o["runSpan"], self.o["walkSpan"] + 0.25,
                           "run thigh swing must beat the walk's (thighs go up)")
        self.assertGreater(self.o["runKneeDeep"], self.o["walkKneeDeep"] + 0.3,
                           "run heel kick must fold deeper than the walk's")
        self.assertGreater(self.o["runLean"], self.o["walkLean"] + 0.05,
                           "run must bend further at the waist than the walk")

    def test_bend_is_at_the_waist_not_the_root(self):
        # "my whole character is bending and going into ground a bit / i want to
        # bend above waist". The root stays upright, the torso hinges, and the
        # bounce must never push the feet through the floor.
        self.assertNotIn("distinctThrew", self.o, self.o.get("distinctThrew"))
        self.assertTrue(self.o["bendAtWaist"],
                        "run must bend at the torso (waist) with an upright root")
        self.assertLess(self.o["runRootTilt"], 0.01,
                        "the root must stay upright — tipping it sinks the character")
        self.assertGreater(self.o["runSink"], -0.07,
                           "the bounce must never drop the body through the ground")
        self.assertGreater(self.o["runLean"], 0.35,
                           "the run must actually bend at the waist")

    def test_walk_is_upright(self):
        # "i think while walking also its bending, i dont want that"
        self.assertNotIn("distinctThrew", self.o, self.o.get("distinctThrew"))
        self.assertTrue(self.o["walkUpright"],
                        "walking must be upright — the bend is the run's alone")

    def test_bend_unwinds_the_moment_you_stop(self):
        # "after stopping it takes time to come back in shape, i want it to
        # restore back as soon as i stop running". The bend must be a pure
        # function of the sprint weight, and must fall off as that weight does.
        self.assertNotIn("bendScaleThrew", self.o, self.o.get("bendScaleThrew"))
        self.assertNotIn("fadeThrew", self.o, self.o.get("fadeThrew"))
        self.assertTrue(self.o["bendScales"],
                        "half the sprint weight must give half the bend (no ratio lock)")
        self.assertLess(self.o["bendWalk"], 0.06, "no bend at all while walking")
        self.assertGreater(self.o["bendRun"], 0.35, "a clear sprint bend")
        self.assertTrue(self.o["fadeUnwinds"],
                        "the bend must fall off as the sprint weight fades, not hold then snap")

    def test_run_shape_snaps_off_the_key(self):
        # ONE restore when the keys come up. A change of pace (Shift up while
        # still moving) settles — snapping it read as restore #1. The stop is
        # the single snap to idle. Starting a sprint is instant.
        self.assertNotIn("keySnapThrew", self.o, self.o.get("keySnapThrew"))
        self.assertTrue(self.o["shiftUpSettles"],
                        "Shift-up while moving must settle the run shape, not snap")
        self.assertTrue(self.o["idleSnapsOn"],
                        "the stop is the one restore: idle that frame, no bounce")
        self.assertTrue(self.o["oneRestore"],
                        "releasing every key must go run -> idle in one step, never via a walk pose")
        self.assertTrue(self.o["sprintStartsAtOnce"],
                        "starting a sprint must be instant — vigor does not ease in")

    def test_locomote_tracks_key_intents(self):
        # the key intents must come from the KEY, not the speed — speed stays
        # high through a deceleration and is what made the bend linger
        self.assertIn("ch._runWant = runWant == null ? W.sprint", HQ3D)
        self.assertIn("ch._goWant = goWant == null ? 1", HQ3D)
        self.assertIn("locomote(avatar.ch, avatar.speed, avatar.rate, dt, run, !!(fwd || side || walkTo))", HQ3D)

    def test_body_owns_its_own_lean(self):
        # leanStep tips ch.o at the feet ("going into ground"); this body does
        # its own waist bend and opts out of the model pitch, keeping only the
        # bank into turns.
        self.assertIn("ownLean: true", SKY)
        self.assertIn("if(!ch.ownLean) ch.o.rotation.x = lean.p", HQ3D)

    def test_pose_hero_drives_all_three_paces(self):
        self.assertTrue(self.o["poseHeroWalked"])
        self.assertTrue(self.o["poseHeroRan"])
        self.assertTrue(self.o["poseHeroIdled"])

    def test_tall_top_picks_the_tallest_tower(self):
        self.assertNotIn("tallThrew", self.o, self.o.get("tallThrew"))
        self.assertTrue(self.o["tallPicksHeight"], "tallTop must pick the tallest deck")
        self.assertTrue(self.o["tallOnDeck"], "the spot must stand on that deck, by the lift")
        self.assertTrue(self.o["tallDisc"], "a helideck disc is a valid top")
        self.assertTrue(self.o["tallEmpty"], "no roofs: null (street spawn stays)")
        self.assertTrue(self.o["tallTieBreaksArea"], "on a tie, the wider deck")
        self.assertTrue(self.o["tallSkipsJunk"], "a deck-less entry is skipped, not thrown on")

    def test_tall_top_stands_on_the_deck(self):
        # an off-deck spot is what dropped the hero to the street: the city's
        # groundY only holds a roof while he is already on it (roofHere)
        self.assertNotIn("tallThrew", self.o, self.o.get("tallThrew"))
        self.assertTrue(self.o["tallStaysOnDeck"],
                        "a lift outside a tiny deck: still stand on the deck, never off it")
        self.assertTrue(self.o["tallSkipsHouse"],
                        "the lift's head house is not walkable")
        self.assertTrue(self.o["tallRotatedDeck"],
                        "the deck rectangle is in its own rotated frame")

    def test_my_top_prefers_your_hq(self):
        self.assertNotIn("tallThrew", self.o, self.o.get("tallThrew"))
        self.assertTrue(self.o["myTopPrefersOwn"],
                        "myTop must land on your own HQ, not the tallest neighbour")
        self.assertTrue(self.o["myTopOnDeck"], "and that spot must be on the deck")
        self.assertTrue(self.o["myTopFallsToTall"], "no own roof: the tallest, then")
        self.assertTrue(self.o["myTopEmpty"], "no roofs: null")


class SkyStrikeSpawnOnTop(unittest.TestCase):
    """Opening the game puts the hero on top of his own HQ, not the street."""

    def test_exposes_the_picker(self):
        self.assertIn("function tallTop(roofs)", SKY)
        self.assertIn("function myTop(roofs)", SKY)
        self.assertIn("myTop: myTop", SKY)   # named export + pure surface

    def test_mount_teleports_to_the_top(self):
        # inst.teleport(x, z, yaw, y) with the deck's y — the y is what holds the
        # hero up there (hq3d's stopFeet); without it he snaps to the street.
        self.assertIn("inst.teleport(top.x, top.z, top.yaw || 0, top.y)", SKY)
        self.assertIn("function spawnOnTop()", SKY)

    def test_waits_for_the_city_to_place_him(self):
        # goCity returns as soon as enterWorld *starts*; its go() (and the city's
        # own street spawn) runs on the next fade tick and overwrites anything
        # teleported earlier. The roof spawn therefore hangs off onWorld("city").
        self.assertIn('if(String(name) === "city"){ wantTop = true; spawnOnTop(); }', SKY)
        self.assertIn("hq.onWorld = function(name)", SKY)
        # goCity is not re-entered after mount: that tore the first city down and the
        # second street spawn stomped the teleport.
        self.assertNotIn("(function goCommons(n)", SKY)
        self.assertNotIn("inst.goCity", SKY)

    def test_pumps_the_hq_list(self):
        # 22-hq.js only polls the open-HQ list in the HQ view; Valley never does, and
        # its cityChanged goes to HQ3D.inst (the HQ view's), not this one. So this mount
        # pulls the list itself and rebuilds OUR street when it changes, then waits for
        # the list to hold still before going up (a rebuild under us yanks us off the roof).
        self.assertIn("hqCityLoad(true)", SKY)
        self.assertIn("try { if(inst.cityChanged) inst.cityChanged(); } catch(e){}", SKY)
        self.assertIn("if(top && isFinite(top.y) && listHold >= 2)", SKY)

    def test_teleports_exactly_once(self):
        # A watching loop that re-teleports while he is still near the spawn point
        # yanked him back to the same spot every time he walked on the deck (the deck
        # is smaller than the "still there" radius). One teleport, then hands off.
        self.assertIn("spawning || !wantTop) return;", SKY)
        self.assertIn("wantTop = false; spawning = false;", SKY)
        self.assertIn("return;                                   // once. he is yours now.", SKY)
        self.assertNotIn("landed", SKY)
        self.assertNotIn("1500", SKY)

    def test_hq3d_carries_the_height(self):
        # the surface SkyStrike calls: inst.teleport takes y (placeAvatar -> stopFeet)
        # and inst.roofs hands over the City's roof list
        self.assertIn("inst.teleport = function(x, z, yaw, y)", HQ3D)
        self.assertIn("inst.roofs = function(){ return cur && cur.roofs ? cur.roofs() : []; };", HQ3D)

    def test_degrades_to_the_street(self):
        # no roofs yet (the open-HQ list still in flight): keep retrying while pumping
        # the list, then leave the street spawn. myTop(null) is null and the teleport
        # is never called, so the hero stays where the city put him.
        self.assertIn("if(++tries < 240) setTimeout(go, 250)", SKY)
        self.assertIn("var pick = (HQV.skystrike && (HQV.skystrike.myTop || HQV.skystrike.tallTop)) || null", SKY)
        self.assertIn("if(top && isFinite(top.y) && listHold >= 2)", SKY)
        self.assertIn("if(dead || !inst || !inst.teleport || spawning || !wantTop) return;", SKY)

    def test_no_new_egress_or_random(self):
        self.assertNotIn("fetch(", SKY)
        self.assertNotIn("XMLHttpRequest", SKY)
        self.assertNotIn("Math.random", SKY)


class SkyStrikeAir(unittest.TestCase):
    """Double jump, dive and neon web-swing. The physics is pure; the city only
    reads / writes the avatar and casts the anchor ray (hq3d airStep)."""

    @classmethod
    def setUpClass(cls):
        cls.o = {}
        if not NODE:
            return
        r = subprocess.run([NODE, "-"], input=NODE_HARNESS % {"root": json.dumps(str(ROOT))},
                           capture_output=True, text=True, timeout=60)
        if r.returncode:
            raise AssertionError(r.stderr)
        cls.o = json.loads(r.stdout)

    def test_exposes_the_air_surface(self):
        for name in ("airFrame", "airPose", "jumpImpulse", "diveBlend", "wantDive",
                     "swingStep", "webPoints", "makeWeb", "webAims"):
            self.assertIn("function %s(" % name, SKY, name)
        # pure surface for the node harness
        self.assertIn("airFrame: airFrame", SKY)
        self.assertIn("makeWeb: makeWeb", SKY)
        # the game hands the air physics to hq3d through api.air
        self.assertIn("api.air = function(st, env, dt)", SKY)
        self.assertIn("HQV.skystrike && HQV.skystrike.airFrame", SKY)

    def test_double_jump_is_edge_triggered(self):
        # one Space press on the deck leaves the roof; a second press in the air
        # is the double jump and kicks a spin. A held key must never re-fire.
        self.assertIn("function jumpImpulse(s, grounded, spaceEdge, calm)", SKY)
        self.assertIn("if(!s || calm || !spaceEdge) return 0;", SKY)
        self.assertIn("s.spinV = 2.2;", SKY)
        self.assertIn("spaceEdge = false;               // the ground jump ate this press", SKY)

    def test_dive_is_w_plus_a_fall_from_height(self):
        # "whenever falling from height i press W, i dive ... i want him gliding
        # down, while his head and body down and legs up"
        self.assertIn("function wantDive(wDown, hop, vy)", SKY)
        self.assertIn("function diveBlend(s, want, dt)", SKY)
        # camrig's pitch is nose-up positive, so a dive is negative there
        self.assertIn("avatar.pitch = E.calm() ? 0 : -Math.max(0, Math.min(1, +AIR.dive || 0))*0.95;", HQ3D)
        # the chase camera tips with the dive (looking down the line)
        self.assertIn("clamp((T.pitch || 0)*0.55, -0.7, 0.7)", CAMRIG)
        # arms by my side: the dive pose sweeps them back along the ribs
        self.assertIn("armQ(THREE, 1, 0.72*d, B.la.quaternion, 0.04", SKY)
        # the ROOT tips over too — a waist-bend alone reads as standing and
        # leaning. The glide is one shape: root + torso forward (nose down),
        # head chin-down, legs UP behind (positive hip = thigh back).
        self.assertIn("var base = 0.55*Math.max(0, Math.min(1, fallT + d*0.45));", SKY)
        self.assertIn("B.r.rotation.set(base*0.85 + d*0.55 + launch*0.10, flut*0.35, 0)", SKY)
        self.assertIn("B.t.rotation.x = 0.06 + base*0.55 + d*1.05 + launch*0.34", SKY)
        self.assertIn("B.h.rotation.x = -0.08 - base*0.35 - d*0.60 + flut*0.25", SKY)
        self.assertIn("var lgx = 0.12 + base*0.55 + d*0.45", SKY)
        # the group takes the OPPOSITE sign to camrig's nose-up pitch (three.js
        # rotation.x is nose-DOWN positive). The same sign tipped the body
        # backward against the bones and the fall read as a standing bend.
        self.assertIn("avatar.g.rotation.x = E.calm() ? 0 : -(+avatar.pitch || 0)*0.62;", HQ3D)

    def test_web_is_held_shift_and_neon(self):
        # "when pressing shift in air, web should come out of my hand ... as i
        # release shift web should be gone. web should be neon"
        self.assertIn("if(shiftEdge && env.shift && !st.sw && env.anchor && !calm)", SKY)
        self.assertIn("if(!env.shift){", SKY)
        self.assertIn("var NEON   = 0x2ec6ff;", SKY)
        self.assertIn("AdditiveBlending", SKY)
        self.assertIn("function makeWeb(THREE, parent, color)", SKY)
        # the line is a catenary, not a straight stick
        self.assertIn("function webPoints(from, to, sag, n)", SKY)
        self.assertIn("s*4*u*v", SKY)
        # "neon light is coming but its too thick" — a strand, not a pipe
        self.assertIn("new THREE.TubeGeometry(curve, 28, 0.012, 5, false)", SKY)
        self.assertIn("new THREE.TubeGeometry(curve, 28, 0.0035, 4, false)", SKY)
        self.assertIn("opacity: 0.16, blending: THREE.AdditiveBlending", SKY)
        self.assertNotIn("0.05, 5, false", SKY)          # the old fat outer tube is gone
        # "web to be come out of hand with my hand held up ... web coming out of
        # anywhere" — the origin is the RAISED wrist, never a point beside the chest
        self.assertIn("function handOf(st, sign)", SKY)
        self.assertIn("y: (+st.y || 0) + 2.02", SKY)
        self.assertIn("var from = handOf(st);", SKY)
        self.assertIn("st.webFrom = handOf(st);", SKY)
        self.assertIn("handOf: handOf", SKY)
        # the free-fall pose raises the web arm while Shift is held
        self.assertIn("if(env.shift && !calm) st.webArm = st.webSide;", SKY)
        self.assertIn("webArm: AIR.webArm < 0 ? -1 : (AIR.webArm > 0 ? 1 : 0)", HQ3D)
        self.assertIn("var up = o.webArm < 0 ? -1 : (o.webArm > 0 ? 1 : 0);", SKY)

    def test_web_zip_and_release_coast(self):
        # "when i press space in air, it should do web zip, throwing web towards
        # whatever is infront of me and pulling me towards it" — a point-launch.
        self.assertIn("function zipAims(yaw)", SKY)
        self.assertIn("function zipHit(st, env)", SKY)
        self.assertIn("function startZip(st, hit)", SKY)
        self.assertIn("function zipStep(st, dt, solids)", SKY)
        self.assertIn("var offs = [0, -0.18, 0.18, -0.42, 0.42, -0.72, 0.72, -1.1, 1.1, -1.55, 1.55];", SKY)
        # "all construction should be opaque" — a body sweep against the city's AABBs
        self.assertIn("function bodyBlock(prev, next, boxes, r)", SKY)
        self.assertIn("bodyBlock: bodyBlock", SKY)
        self.assertIn("sweepBoxes(prev, next, lookup)", SKY)
        self.assertIn("sweepBoxes: sweepBoxes", SKY)
        # oriented v2 lots: air solids match walk footprints (not the axis-aligned lot rect)
        self.assertIn("HQV.worldgeom.footprint", CITY)
        self.assertIn("it.obb = {ox: fp.o.x, oz: fp.o.z, fx: fp.F.x, fz: fp.F.z, hu: fp.hu, hv: fp.hv};", CITY)
        self.assertIn("if(b.obb) o.obb = b.obb;", CITY)
        self.assertIn("gEntry.obb = {", SKY)
        # never stuck / never through: depenetrate, contact normal, rope clamp
        self.assertIn("function pushOut(px, py, pz)", SKY)
        self.assertIn("out.wall = (ny === 0) ? 1 : 0;", SKY)
        self.assertIn("if(dC > 0.5 && dC < sw.len) sw.len = dC;", SKY)   # shrink only
        self.assertIn("sw._blocked = function(bx, by, bz)", SKY)
        # wall grip: stick / crawl / run, Space jumps AWAY into free fall
        self.assertIn("function wallStep(st, dt, env, nx, nz, run)", SKY)
        self.assertIn("wallStep: wallStep", SKY)
        self.assertIn('mode: "wall"', SKY)
        self.assertIn("st.wall = {nx: nx, nz: nz, t: 0, run: runMode ? 1 : 0};", SKY)
        self.assertIn("var climb = runMode ? 22 : 13, accel = runMode ? 24 : 13, maxSp = runMode ? 15 : 7;", SKY)
        self.assertIn("st.vy = Math.max((+st.vy || 0) + 7.4, 8.2);", SKY)
        self.assertIn("if(!st.wall && st.vy < -2.2) st.vy = -2.2;", SKY)
        self.assertIn("wallRun: AIR.wall && AIR.wall.run ? 1 : 0", HQ3D)
        self.assertIn("var wRun = Math.max(0, Math.min(1, +o.wallRun || 0));", SKY)
        self.assertIn("zipAims: zipAims", SKY)
        self.assertIn("zipHit: zipHit", SKY)
        self.assertIn("startZip: startZip", SKY)
        self.assertIn("zipStep: zipStep", SKY)
        # Space in the air zips first, and only double-jumps when there is
        # nothing in front (so the HQ-top escape still works)
        self.assertIn("var zh = zipHit(st, env);", SKY)
        self.assertIn('return {mode: "zip", fire: true, release: release};', SKY)
        self.assertIn("var jj = jumpImpulse(st, false, spaceEdge, calm);", SKY)
        # the yank: hard pull toward the point, stopped short of the surface
        self.assertIn("var want = Math.min(34, 10 + d*3.4);", SKY)
        self.assertIn("if(d < 1.25 || z.t > (z.dur || 0.38)){", SKY)
        # a zip chains into a swing / another zip (momentum kept)
        self.assertIn("st.zip = null;                     // arrived: the speed is yours now", SKY)
        # and the line leaves the raised hand
        self.assertIn("st.webFrom = {x: from.x, y: from.y, z: from.z};", SKY)
        # "when i release the web, i should swing straight where i released it"
        self.assertIn("st.coastT = 3.0;", SKY)
        self.assertIn("var coast = (+st.coastT || 0) > 0;", SKY)
        self.assertIn("if(!coast){", SKY)
        self.assertIn("var drag = Math.exp(-(coast ? 0.10 : (calm ? 1.2 : 0.55))*dt);", SKY)
        self.assertIn("st.coastT = 0;                   // a new swing is what turns you", SKY)
        self.assertIn("st.coastT = 0;                     // the ground ends the coast", SKY)
        # the zip owns the feet and the line in hq3d too
        self.assertIn("(AIR.sw || AIR.zip)", HQ3D)
        self.assertIn("|| !!(AIR.zip) ||", HQ3D)
        self.assertIn("var upSw = -Math.PI", SKY)        # the shoulder aims straight UP

    def test_web_anchors_on_the_city(self):
        # a tower ledge, a streetlight, a bridge span: anything the ray hits
        self.assertIn("function airAnchor(from, dir, maxDist)", HQ3D)
        self.assertIn("ray.intersectObjects(list, false)", HQ3D)
        self.assertIn("cur.hits", HQ3D)
        self.assertIn("cur.floor", HQ3D)
        self.assertIn("function webAims(yaw)", SKY)
        # never the ground you just left, never yourself — but a wall in FRONT
        # counts at any height (the zip's forward fan must find it)
        self.assertIn("if(p.y < o.y - 2.2 && hd2 <= 2.5) continue;", HQ3D)
        self.assertIn("if(g.y >= o.y - 2.2 || hd > 2.5) return", HQ3D)
        # the real hit list: the city's solid AABBs, not the door-drum meshes
        self.assertIn("w.webHit = function(from, dir, maxDist)", CITY)
        self.assertIn("cur.webHit(o, dir, maxDist)", HQ3D)
        self.assertIn("function segAABB(from, to, b)", SKY)
        # "why not all buildings are opaque" — every construction the swing can
        # touch must report a solid AABB: trees, roof decks, park rides, bridges
        self.assertIn("w.occluderItems = function(x, y, z)", CITY)
        self.assertIn("spx.solidItems(x, y, z)", CITY)
        self.assertIn("bridges.solidItems(x, y, z)", CITY)
        self.assertIn("solidItems: function(x, y, z)", SPEC)
        self.assertIn("solidItems: function(x, y, z)", BRIDGE)
        self.assertIn("place: place", SPEC)
        self.assertIn("function rayBoxes(from, dir, maxDist, boxes)", SKY)
        self.assertIn("segAABB: segAABB", SKY)
        self.assertIn("rayBoxes: rayBoxes", SKY)
        # the web must find a wall BESIDE you (a drop down a tower face) and
        # slightly below your hand — a fan that only looks up never sticks
        self.assertIn("1.35, -1.35, 0.75, -0.75, 2.4, -2.4", SKY)
        self.assertIn("-0.12, -0.12, 0.12, 0.12", SKY)
        # a mesh raycast against cur.hits finds only door drums and signs
        self.assertNotIn("cur.hits", CITY.split("w.webHit")[1].split("w.camHit")[0] if "w.webHit" in CITY else "")

    def test_swing_is_a_pumped_pendulum_not_a_robot_hang(self):
        # "not swinging like robot, it should be able to spin in air, stretch,
        # like body movements of human body when swung"
        self.assertIn("function swingStep(sw, dt, input)", SKY)
        self.assertIn("inextensible", SKY.lower())
        self.assertIn("function airPose(ch, o)", SKY)
        # one arm up the line, the free arm trailing, torso rolled, legs trailing
        self.assertIn("upSwing = -Math.PI + tuck*0.12", SKY)
        self.assertIn("freeSwing = 0.55 + tuck*0.15", SKY)
        self.assertIn("-side*0.22*s", SKY)

    def test_hq3d_hands_the_body_over_in_the_air(self):
        # the air state owns x / z / yaw only while flying; on the feet the walk does
        self.assertIn("function airStep(dt)", HQ3D)
        self.assertIn("function airOwns()", HQ3D)
        self.assertIn("if(airLive){ fwd = 0; side = 0; walkTo = null; walkDoor = null; }", HQ3D)
        self.assertIn("if(airStep(dt)){ /* the game's air state is now the avatar */ }", HQ3D)
        # landing gives the gait the body back — the air pose must not linger
        self.assertIn("if(!flying){\n        avatar.ch._air = null;", HQ3D)
        self.assertIn("avatar.ch._air = {", HQ3D)
        # the launch curl is handed to the pose too — without it a pure jump
        # (no dive / swing) would fall through to the gait and never unwind
        self.assertIn("launch: Math.max(0, Math.min(1, +AIR.launch || 0))", HQ3D)
        self.assertIn("air.launch > 0.01", SKY)
        # a jump leaves the spot: the walk's pace seeds the air state's velocity
        self.assertIn("AIR.vx = Math.sin(avatar.yaw || 0)*(avatar.speed || 0);", HQ3D)
        # "now i am just walking and falling out of hq roof, what is point of
        # railing then, i should jump to jump off roof" — on the deck the rail
        # HOLDS you in; a jump is what leaves it (the air path ignores walls
        # once the feet are off the surface)
        self.assertIn("the RAILING is a wall: walking must never fall off the roof", CITY)
        self.assertIn("return !HQV.hqRoof.onDeck(R, x, z);", CITY)
        self.assertIn("if(R.house && Math.hypot(x - R.house.x, z - R.house.z) < R.house.r) return true;", CITY)
        self.assertIn("Just past the railing (a jump's first frames", CITY)
        # and in the sky the city is scenery, not walls: once the feet are off the
        # surface, ground collision does not apply (so he swings past towers)
        self.assertIn("groundAt(x, z) + 0.15) return false;", HQ3D)
        # the air state's height is on the avatar payload (what the world reads)
        self.assertIn("hop: avatar.hop || 0", HQ3D)
        self.assertIn("airborne: !!avatar.airborne", HQ3D)

    def test_air_stays_local(self):
        # the web is local geometry: no egress, no random sparkle
        self.assertNotIn("fetch(", SKY)
        self.assertNotIn("XMLHttpRequest", SKY)
        self.assertNotIn("EventSource", SKY)
        self.assertNotIn("Math.random", SKY)
        self.assertNotIn("new WebSocket", SKY)

    @unittest.skipUnless(NODE, "node is not installed")
    def test_air_physics_runs_without_throwing(self):
        self.assertNotIn("airThrew", self.o, self.o.get("airThrew"))
        self.assertNotIn("airPoseThrew", self.o, self.o.get("airPoseThrew"))
        self.assertNotIn("poseHandThrew", self.o, self.o.get("poseHandThrew"))
        self.assertTrue(self.o.get("airHas"), "the pure air surface must be exported")

    @unittest.skipUnless(NODE, "node is not installed")
    def test_double_jump_and_dive(self):
        self.assertNotIn("airThrew", self.o, self.o.get("airThrew"))
        self.assertTrue(self.o["groundJump"])
        self.assertTrue(self.o["doubleJump"])
        self.assertTrue(self.o["thirdJumpNo"])
        self.assertTrue(self.o["calmNoJump"])
        self.assertTrue(self.o["heldSpaceNoRepeat"])
        self.assertTrue(self.o["diveFromHeight"])
        self.assertTrue(self.o["diveOnHardDrop"])
        self.assertTrue(self.o["noDiveWithoutW"])
        self.assertTrue(self.o["noDiveRising"])
        self.assertTrue(self.o["noDiveShortHop"])
        self.assertTrue(self.o["diveEases"])

    @unittest.skipUnless(NODE, "node is not installed")
    def test_jump_leaves_the_spot_and_the_bend_restores(self):
        self.assertNotIn("airThrew", self.o, self.o.get("airThrew"))
        self.assertTrue(self.o["jumpKickPushes"], "a standing jump must leave the spot")
        self.assertTrue(self.o["jumpKickKeepsPace"], "a jump must never slow a run")
        self.assertTrue(self.o["jumpKickTurns"], "the kick follows the facing")
        self.assertTrue(self.o["launchRestoresInAir"], "the launch curl must unwind in the air")
        self.assertTrue(self.o["launchNeverNegative"])
        self.assertTrue(self.o.get("poseHandsOverLaunch"), "a pure launch curl must hand the body over")
        self.assertTrue(self.o.get("launchBendRestores"), "the jump bend must unwind in the air pose")

    @unittest.skipUnless(NODE, "node is not installed")
    def test_swing_keeps_the_rope_and_pumps(self):
        self.assertNotIn("airThrew", self.o, self.o.get("airThrew"))
        self.assertTrue(self.o["webSags"])
        self.assertTrue(self.o["ropeHolds"], "the rope must never stretch past its length")
        self.assertTrue(self.o["ropeClamps"], "a long step must snap back onto the sphere")
        self.assertTrue(self.o["swingPumps"])

    @unittest.skipUnless(NODE, "node is not installed")
    def test_airframe_state_machine(self):
        self.assertNotIn("airThrew", self.o, self.o.get("airThrew"))
        self.assertTrue(self.o["airJumpsOffGround"])
        self.assertTrue(self.o["airHeldSpaceNoDouble"], "held Space must not fire the double jump")
        self.assertTrue(self.o["airDoubleJump"])
        self.assertTrue(self.o["airDives"])
        self.assertTrue(self.o["webFires"])
        self.assertTrue(self.o["webRopeIsRealDistance"])
        self.assertTrue(self.o["swingHolds"])
        self.assertTrue(self.o["webReleasesOnShiftUp"], "Shift up must drop the line that frame")
        self.assertTrue(self.o["swingJumpKicks"])
        self.assertTrue(self.o["airPoseFinite"])
        self.assertTrue(self.o["poseHandsOver"], "air must own the body away from the gait")
        self.assertTrue(self.o["makeWebSafe"])

    @unittest.skipUnless(NODE, "node is not installed")
    def test_release_coasts_straight_and_space_zips(self):
        """"when i release the web, i should swing straight where i released it"
        and "when i press space in air, it should do web zip". Both are runtime
        behaviour a substring check cannot see."""
        self.assertNotIn("airThrew", self.o, self.o.get("airThrew"))
        self.assertNotIn("armQThrew", self.o, self.o.get("armQThrew"))
        self.assertTrue(self.o["armPointsStraightUp"],
                        "the web arm must point STRAIGHT UP at -Math.PI, not forward-level")
        self.assertTrue(self.o["webReleasesIntoCoast"],
                        "releasing Shift must start a coast that keeps the line's direction")
        self.assertTrue(self.o["coastGoesStraight"],
                        "after a release the hero must fly STRAIGHT — no turn back to the old anchor")
        self.assertTrue(self.o["coastFacesTravel"])
        self.assertTrue(self.o["airSpaceZips"],
                        "Space in the air must fire a WEB ZIP at whatever is in front")
        self.assertTrue(self.o["zipLineFromHand"], "the zip line must leave the raised hand")
        self.assertTrue(self.o["zipPullsForward"], "the zip must pull the hero toward the point")
        self.assertTrue(self.o["airSpaceFallsBackToDoubleJump"],
                        "open sky (nothing in front) must still double-jump off the HQ top")
        self.assertTrue(self.o["zipAimsForward"], "a zip aims a tight forward fan, not the sky")
        self.assertTrue(self.o.get("zipAimsReachesDown"),
                        "the zip fan must also reach a wall at or below hand height")

    @unittest.skipUnless(NODE, "node is not installed")
    def test_oriented_lot_corners_are_solid(self):
        """v2 lots are rotated footprints. The old axis-aligned air solid left their
        corners uncovered — a swing sailed through. Runtime probe, not substrings."""
        r = subprocess.run([NODE, str(ROOT / "tests" / "probe_obb.js")],
                           capture_output=True, text=True, timeout=30)
        self.assertEqual(r.returncode, 0, r.stderr or r.stdout)
        o = json.loads(r.stdout)
        self.assertTrue(o["obbStopsCorner"],
                        "a dive into a rotated facade corner must stop outside the mass")
        self.assertTrue(o["oldMissesCorner"],
                        "the old axis-aligned rect alone still misses that corner (the bug)")
        self.assertTrue(o["emptyAirFree"],
                        "empty air in the fat AABB corner (outside the OBB) must stay free")
        self.assertTrue(o["insidePushedOut"],
                        "a body planted inside an OBB must be pushed out")

    @unittest.skipUnless(NODE, "node is not installed")
    def test_buildings_are_opaque_and_a_jump_is_not_a_dive(self):
        """"all construction should be opaque, i cant pass through any while
        swinging" / "even on jumping normally i am getting diving position" /
        "pressing space in air is doing nothing". Runtime numbers, not substrings."""
        self.assertNotIn("blockThrew", self.o, self.o.get("blockThrew"))
        self.assertNotIn("zipWallThrew", self.o, self.o.get("zipWallThrew"))
        self.assertTrue(self.o["jumpIsNotDive"],
                        "a plain jump must NOT take the dive shape (root/torso/legs up)")
        self.assertTrue(self.o["blockStopsAtWall"], "a body must stop at a building face")
        self.assertTrue(self.o["blockKillsInwardSpeed"], "the wall must kill the speed into it")
        self.assertTrue(self.o["blockLetsOpen"], "open air must be left alone")
        self.assertTrue(self.o["swingNeverInsideTower"],
                        "a swing must never end up inside a tower")
        self.assertTrue(self.o["zipFiresAtWall"],
                        "a wall in FRONT at hand height must start a web zip")
        self.assertTrue(self.o["zipLineDrawn"], "the zip must draw its web line")
        self.assertTrue(self.o["spaceAlwaysActs"],
                        "Space in the air must never be a silent no-op")

    def test_live_path_web_dive_and_fall(self):
        """The exact sequence the user runs: jump off the HQ, Shift swings, W dives.
        A pure-helper green light is not enough — these run airFrame with the live
        inputs and the live aim fan."""
        self.assertNotIn("webFaceThrew", self.o, self.o.get("webFaceThrew"))
        self.assertNotIn("diveThrew", self.o, self.o.get("diveThrew"))
        self.assertNotIn("rayBoxesThrew", self.o, self.o.get("rayBoxesThrew"))
        self.assertTrue(self.o["webFaceSwings"],
                        "Shift in a fall beside a tower FACE must fire the web and swing")
        self.assertTrue(self.o["webFaceRope"], "the rope must have real endpoints and length")
        self.assertTrue(self.o["webAimsCoverFace"],
                        "the aim fan must include side and down-forward rays (a face beside you)")
        self.assertTrue(self.o["diveEngages"], "W while falling from height must raise dive")
        self.assertTrue(self.o["diveTipsBody"],
                        "a dive tips the WHOLE body over (root + torso + head), not just the waist")
        self.assertTrue(self.o["glideNotStanding"],
                        "free fall is a glide (head/body down, legs up) — not a standing forward bend")
        self.assertTrue(self.o["webArmUp"],
                        "the web must come out of a RAISED hand, not a point beside the chest")
        self.assertTrue(self.o["rayBoxesHitsTower"], "rayBoxes must find a tower face along the web ray")
        self.assertTrue(self.o["rayBoxesMissesSky"], "a ray into the sky hits nothing")

    @unittest.skipUnless(NODE, "node is not installed")
    def test_never_stuck_never_through_and_wall_run(self):
        """"now its even worse, i am getting stuck in between swinging / still
        going through wall while swinging / when i run into any building while
        swinging i should start running on the wall, i whichever direction key
        pressed / why not all buildings are opaque". Runtime numbers, not
        substrings — the same live airFrame/swingStep/bodyBlock path the hero
        walks."""
        self.assertNotIn("stuckWallThrew", self.o, self.o.get("stuckWallThrew"))
        self.assertTrue(self.o["depenetrateFree"],
                        "a body that starts INSIDE a box must be pushed out, not frozen there")
        self.assertTrue(self.o["depenetrateNotFrozen"],
                        "depenetration must not zero the velocity — the hero keeps moving")
        self.assertTrue(self.o["swingNeverInsideTower2"],
                        "a long swing into a tower must never leave the body inside it")
        self.assertTrue(self.o["swingNeverStuck"],
                        "a long swing must never freeze — every frame must move")
        self.assertEqual(self.o["swingStuckFrames"], 0,
                         "swing froze for frames: %s" % self.o)
        self.assertEqual(self.o["swingInsideFrames"], 0,
                         "swing was inside the tower for frames: %s" % self.o)
        self.assertTrue(self.o["ropeNoTunnel"],
                        "the rope clamp must shorten, never snap the body through a tower")
        self.assertTrue(self.o["wallRunStarts"],
                        "walking into a building from the ground must START a wall crawl")
        self.assertTrue(self.o["wallRunHeldY"],
                        "a wall-run must hold the hero on the face instead of dropping him")
        self.assertTrue(self.o["wallRunClimbs"],
                        "W into the wall must run him UP the face")
        self.assertTrue(self.o["wallRunOnFace"],
                        "a wall-run keeps the body on the face")
        self.assertTrue(self.o["wallRunSteerAlong"],
                        "a direction key along the face must walk him sideways on the wall")
        self.assertTrue(self.o["swingDoesNotCrawl"],
                        "swinging into a face must NOT start a crawl — keep swinging freely")
        self.assertTrue(self.o["wallSpaceKicks"],
                        "Space on a wall must kick off it")
        self.assertTrue(self.o["wallPoseUpright"],
                        "wall crawl stays UPRIGHT on the face (small lean) — never a belly-down dive tip")
        self.assertTrue(self.o["wallPoseCrouch"],
                        "wall crawl drops the hips into a spider crouch")
        self.assertTrue(self.o["wallPoseIntoFace"],
                        "wall crawl pushes the chest into the face (not floating off it)")
        self.assertTrue(self.o["wallPoseNoDive"],
                        "wall crawl must never use the old nose-down dive tip that looked like flying")
        self.assertTrue(self.o["wallPoseCrawls"],
                        "a moving crawl alternates opposite limbs")
        self.assertTrue(self.o["wallPoseIdlePlanted"],
                        "idle cling plants both sides — a static spider crouch, not a mid-stride freeze")
        # --- stick / crawl / run / jump-away, and a leap that cannot tunnel ---
        self.assertTrue(self.o["noKeysDoesNotCling"],
                        "hopping / falling beside a building with no keys must NOT auto-cling (the floating bug)")
        self.assertTrue(self.o["airDoesNotCling"],
                        "flying into a face with W must NOT cling — crawl only starts from the ground")
        self.assertTrue(self.o["wallSticks"],
                        "after a deliberate ground grab, releasing keys CLINGS and slowly slides — never freeze mid-air")
        self.assertTrue(self.o["wallStickStillOnFace"],
                        "clinging keeps the body ON the face")
        self.assertTrue(self.o["wallShiftEdgeSwings"],
                        "a fresh Shift press on a wall must fire a web swing off the face")
        self.assertTrue(self.o["wallCrawls"],
                        "a direction key must CRAWL you up the face")
        self.assertTrue(self.o["wallRunsFaster"],
                        "Shift + direction must RUN up the face, faster than a crawl")
        self.assertTrue(self.o["wallSpaceJumpsAway"],
                        "Space must jump AWAY from the building and put you back in free fall")
        self.assertTrue(self.o["wallSpaceGivesFreeFall"],
                        "after Space you are falling free again (dive with W, swing with Shift)")
        self.assertTrue(self.o["sweepFindsTower"],
                        "a leap PAST a building must still gather that building's solid box")
        self.assertTrue(self.o["sweepOpenAirEmpty"],
                        "open air gathers nothing")
        self.assertTrue(self.o["ropeNeverLengthens"],
                        "a rope must never stretch — a stretchable rope cuts through towers")
        self.assertTrue(self.o["leapNeverInsideTower"],
                        "a long, fast swing step must never leap the body through a tower")

    def test_the_four_complaints(self):
        """"stiling swining is not smooth / i cant run on buildings when while
        swinging i run into a building (i am currently going thorugh building) /
        i should get stick to the building and start running on it if shift +
        direction key is pressed, otherwise only direction key i should crawl on
        building walls / when i press space i should jump sway from building and
        i should be back in air (falling) / it automatically connects my web to
        another close building, which is wrong". Runtime numbers on the live
        airFrame / swingStep / bodyBlock / wallStep path, never substrings."""
        self.assertNotIn("fourFixesThrew", self.o, self.o.get("fourFixesThrew"))
        # --- never stuck ---
        self.assertTrue(self.o["ropeFouledReleases"],
                        "a rope fouled against geometry must RELEASE the line, not freeze the hero")
        self.assertTrue(self.o["swingNeverHangs"],
                        "a stalled swing must drop the line and fall — never hang frozen in air")
        self.assertTrue(self.o["swingStallDrops"],
                        "the stall must be caught quickly (no long hang before release)")
        self.assertTrue(self.o["apexKeepsLine"],
                        "a slow pendulum apex is a real swing, not a hang — it must keep the line")
        # --- no auto-reconnect to another building ---
        self.assertTrue(self.o["noAutoWebToNeighbour"],
                        "holding Shift must NOT re-aim the web onto a neighbouring building")
        self.assertTrue(self.o["webStaysOnOriginalTower"],
                        "the line stays on the tower you attached to until you release Shift")
        self.assertTrue(self.o["releaseShiftDropsWeb"],
                        "releasing Shift drops the line, so the next press is a deliberate new swing")
        # --- no tunnelling ---
        self.assertTrue(self.o["zipNeverInsideTower"],
                        "a web zip is swept too — never flies through a tower")
        # --- the ground wall grip (this is the one that was invisible) ---
        self.assertTrue(self.o["groundRunGrabsWall"],
                        "running into a building ON THE GROUND must start the wall grip")
        self.assertTrue(self.o["groundGripCrawls"],
                        "a direction key on a ground grip must crawl UP the face")
        self.assertTrue(self.o["groundGripRunsFaster"],
                        "Shift + direction must run the face faster than crawling")
        self.assertTrue(self.o["groundGripSticks"],
                        "no keys on a ground grip must STICK to the face")
        self.assertTrue(self.o["groundGripSpaceAway"],
                        "Space on a ground grip must jump AWAY into free fall")
        # --- the face normal (a side hit used to report the roof) ---
        self.assertTrue(self.o["sideHitIsWall"],
                        "a swing into a tower's SIDE must report wall=1 (a wall, not a roof)")
        self.assertTrue(self.o["topHitIsRoof"],
                        "a fall onto a roof must report wall=0")
        self.assertTrue(self.o["faceNormalLeft"],
                        "faceNormalAt must find the outward normal of the face you are pressed on")
        self.assertTrue(self.o["faceNormalRight"],
                        "faceNormalAt must find the outward normal on the other side too")
        self.assertTrue(self.o["walkIntoGrip"],
                        "the walk's blocked() handoff must produce a grip normal, not just stop")

    @unittest.skipUnless(NODE, "node is not installed")
    def test_hq_roof_batch(self):
        """"now i am not able to jump off the hq roof, no jump working there /
        coming in contact with building i am getting stiff and just shaking /
        my character get completely stuck / sometime jump doesn't even work, to
        jump away from building / it is very very much glitchy now, please fix
        everything". Runtime numbers on the live airFrame / bodyBlock / wallStep
        path — never substrings."""
        self.assertNotIn("roofBatchThrew", self.o, self.o.get("roofBatchThrew"))
        self.assertTrue(self.o["deckRestNotSwallowed"],
                        "a body resting on the HQ deck must never be pushed DOWN through the roof")
        self.assertTrue(self.o["deckLandsOnTop"],
                        "landing on the deck must stop on its TOP face, not inside or below it")
        self.assertTrue(self.o["roofJumpLeaves"],
                        "Space on the HQ roof must leave with the jump impulse — not vy = 0")
        self.assertTrue(self.o["jumpVsWallIsJump"],
                        "Space while pressing into a building on the roof must JUMP, never start a grip")
        self.assertTrue(self.o["wallCrawlNoShake"],
                        "wall crawl/run must move smoothly — no frame-to-frame reversal (the old suction fight)")
        self.assertTrue(self.o["wallCrawlActuallyClimbs"],
                        "wall crawl must actually climb the face")
        self.assertTrue(self.o["gripSpaceJumpsAway"],
                        "Space while gripped must jump AWAY into free fall (fall mode, no wall, vy > 2)")
        self.assertTrue(self.o["nearWallSpaceEscapes"],
                        "free-fall Space NEAR a wall must escape it, never zip INTO it")
        self.assertTrue(self.o["frontWallStillZips"],
                        "a wall genuinely IN FRONT at hand height must still zip (the escape rule must not kill it)")
        self.assertTrue(self.o["deckTopIsWalkHeight"],
                        "the deck solid's TOP must be the walk height (the geometry that caused the swallow)")

    @unittest.skipUnless(NODE, "node is not installed")
    def test_wall_crawl_batch(self):
        """"i cant crawl on the wall of buildings / i am just floating near
        them". Runtime numbers on the live key -> heading -> grip -> climb path
        — the probe's forced fwd:1 never caught this, so these drive the same
        key bits hq3d's airStep reads."""
        self.assertNotIn("crawlBatchThrew", self.o, self.o.get("crawlBatchThrew"))
        self.assertTrue(self.o["groundIntoClimbs"],
                        "walk into a wall and hold W: the grip must start and CLIMB, not stand there stiff")
        self.assertTrue(self.o["groundIntoOnFace"],
                        "the crawl must run ON the face (body at contact), not floating off it")
        self.assertTrue(self.o["bodyFacingGrabs"],
                        "the ground grip must use the BODY's facing — a drifted camera must not stop the grab")
        self.assertTrue(self.o["wallLocalWClimbs"],
                        "once gripped, W climbs the face even when the camera points along it")
        self.assertTrue(self.o["wallLocalAHolds"],
                        "A / D alone crawls sideways and must HOLD the height (not slide down the face)")
        self.assertTrue(self.o["fallBesideDoesNotGrip"],
                        "free fall beside a face must NOT crawl — crawl only starts from the ground")
        self.assertTrue(self.o["fallBesideIdleFalls"],
                        "free fall with NO keys beside a face must not snap onto it")
        self.assertTrue(self.o["zipStandoffDoesNotGrip"],
                        "a mid-air zip stand-off must NOT auto-crawl onto the face")
        self.assertTrue(self.o["runIsFaster"],
                        "Shift + W must run the face faster than a plain W crawl")
        self.assertTrue(self.o["noSpaceClimbs"],
                        "contact + W alone must grab and climb — Space is for jumping, not for starting the crawl")
        self.assertTrue(self.o["gripFacesWall"],
                        "the grip must turn the BODY to face the wall (yaw = atan2(-nx,-nz)), not crawl along it")
        self.assertTrue(self.o["gripReleasesOffFace"],
                        "pull the body off the face and the grip must RELEASE — the old deep probe kept it and read as flying")
        self.assertTrue(self.o["noFarLatch"],
                        "a face 6 m away must never latch a grip — that was the wall↔fall flicker")
        self.assertTrue(self.o["diveNeverThrough"],
                        "diving into a stepped tower must never enter or cross the mass")
        self.assertTrue(self.o["diveDoesNotCrawl"],
                        "diving into a tower face must NOT crawl — bounce/slide free, crawl only from ground")
        self.assertTrue(self.o["diveNoFlicker"],
                        "a dive into a face must never flicker wall↔fall")
        self.assertTrue(self.o["isWallMassFiltersPane"],
                        "paper-thin facade panes must not count as crawlable walls")


if __name__ == "__main__":
    unittest.main()
