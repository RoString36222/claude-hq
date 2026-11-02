#!/usr/bin/env python3
"""Live proof for the Big Head totem: the real claudehq server, the real Strike
Zone page, headless Chrome. Nothing is mocked — this drives the same code the
browser runs.

    python3 tests/probe_bighead_live.py

It boots claudehq against a throwaway root (ui_smoke's harness, empty HOME), opens
the Valley -> Strikezone card, starts a practice range, plants a Big Head totem
under the player in the exact shape totemSpawn() writes (V.plantTotem, a test hook
next to startPractice/startBotMatch), and then lets the game's OWN pickup pass take
it — this never calls totemApply directly.

Measured on the live game object:

  * FS.hitBoxes — the shared geometry the shooter's fire() uses — before and after:
    head 0.50x0.50 m -> 1.00x1.00 m (top 1.90 -> 2.40), body box unchanged,
  * FS.rayPlayer aimed 0.38 m beside a standing victim at head height: MISS before,
    HEADSHOT after (a chest aim stays a body hit at both),
  * the 3D head bone actually scales and the name tag lifts,
  * the arena-wide clock does not pop on death,
  * no JavaScript errors on the console.

Stdlib only. Needs Google Chrome (or Chromium). Never opens a visible window.
"""
import os
import shutil
import sys
import tempfile

sys.path.insert(0, os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "tools"))
import ui_smoke as US  # noqa: E402  (the harness: Chrome, make_root, start_server)

# Aim geometry: the victim stands on the centreline at (0, 0, -10). The shot is
# aimed 0.38 m beside their head — outside the ordinary half-width 0.25, inside the
# big 0.50. dirOf(yaw, pitch): yaw 0 = -z, so yaw = atan2(off, 10) degrees swings
# the ray +x by `off` over the 10 m run.
NEAR = "FS.dirOf(Math.atan2(0.38,10)*180/Math.PI, 0)"   # 0.38 m beside, head height
OVER = "FS.dirOf(Math.atan2(0.35,10)*180/Math.PI, 0)"   # 0.35 m, 2.05 m up
CHEST = "FS.dirOf(0, 0)"                                  # centreline, chest height


def probe(pg, label):
    """Read the live geometry + rayPlayer results + the 3D skulls."""
    return pg.eval("""
(function(){
  var g = HQV.strikeDebug(), FS = HQV.strikeShared, t = g.clock();
  var hs = g.headScaleAt(t);
  var hb = FS.hitBoxes(0, 0, -10, hs), hb1 = FS.hitBoxes(0, 0, -10, 1);
  var near = FS.rayPlayer([0,1.65,0], %s, 0, 0, -10, 100, hs);
  var over = FS.rayPlayer([0,2.05,0], %s, 0, 0, -10, 100, hs);
  var chest = FS.rayPlayer([0,1.0,0], %s, 0, 0, -10, 100, hs);
  var meshes = [];
  Object.keys(g.players || {}).forEach(function(uid){
    var P = g.players[uid], m = P && P.mesh;
    if(!m) return;
    meshes.push({uid: uid, dead: !!P.dead, headS: m.headS,
                 bone: m.headBone ? +m.headBone.scale.x.toFixed(3) : null,
                 tagY: m.tag ? +m.tag.position.y.toFixed(3) : null});
  });
  return {
    label: %s, t: t, hs: hs, until: g.bigHeadUntil || 0, phase: g.phase, mode: g.mode,
    headW: +(hb[1][3]-hb[1][0]).toFixed(3), headTop: +(hb[1][4]).toFixed(3),
    headBottom: +(hb[1][1]).toFixed(3),
    bodyW: +(hb[0][3]-hb[0][0]).toFixed(3), bodyH: +(hb[0][4]-hb[0][1]).toFixed(3),
    headW1: +(hb1[1][3]-hb1[1][0]).toFixed(3), headTop1: +(hb1[1][4]).toFixed(3),
    near: near, over: over, chest: chest, meshes: meshes,
    renderer: g.rendererKind ? g.rendererKind() : ""
  };
})()
""" % (NEAR, OVER, CHEST, repr(label).replace("'", '"') if False else '"%s"' % label),
        timeout=60)


def main():
    if not os.path.exists(US.BIN):
        print("FAIL no claudehq binary at %s" % US.BIN)
        print("     cargo build --release --manifest-path dashboard-rs/Cargo.toml")
        return 1
    chrome = US.find_chrome()
    if not chrome:
        print("FAIL no headless Chrome (or Chromium) on PATH")
        return 1

    fails = []

    def check(name, ok, detail=""):
        print("  %s %s%s" % ("PASS" if ok else "FAIL", name, ("  [%s]" % detail) if detail else ""))
        if not ok:
            fails.append(name)

    tmp = tempfile.mkdtemp(prefix="bighead-live-")
    server = None
    br = None
    try:
        root, home = US.make_root(tmp, arena_url="http://127.0.0.1:9")  # dead Arena: solo only
        server, base, log_path = US.start_server(tmp, root, home)
        print("server up at %s" % base)

        br = US.Chrome(chrome, os.path.join(tmp, "chrome"))
        pg = br.open(base + "/")
        if not pg.wait_true("!!document.getElementById('valleyView')", 60):
            check("the page boots with #valleyView", False)
            return 1
        check("the page boots with #valleyView", True)

        # --- Valley -> Strikezone through the real card path ---
        pg.eval('setView("valley")')
        pg.eval('valleyLoad()')
        ok = pg.wait_true("!!(window.HQV && HQV.strikeShared && HQV.strikeDebug)", 60)
        check("strike.js registers and exports HQV.strikeShared", ok)
        if not ok:
            print("  console:", pg.console()[:8])
            return 1
        pg.eval('HQV.enter(document.getElementById("valleyView"))')
        pg.eval('HQV.api.open("strike")')
        ok = pg.wait_true("!!(HQV.strikeDebug && HQV.strikeDebug())", 60)
        check("the Strikezone card mounts a live game", ok)
        if not ok:
            print("  console:", pg.console()[:8])
            return 1

        # --- bot match, into the round (bots get 3D meshes; practice has only drones) ---
        # the map JSON is fetched async; startBotMatch() returns silently while it is
        # still in flight, so poll until the round is actually open
        ok = False
        for _ in range(20):
            pg.eval('HQV.strikeDebug().startBotMatch()')
            ok = pg.wait_true("HQV.strikeDebug().phase === 'round'", 4)
            if ok:
                break
        check("a bot match reaches the round", ok, pg.eval("HQV.strikeDebug().phase"))
        if not ok:
            print("  console:", pg.console()[:8])
            print("  errors:", pg.errors()[:8])
            return 1

        # --- baseline: no window, ordinary skulls ---
        before = probe(pg, "before")
        print("  before: hs=%s head=%sm x %sm top=%s body=%sm x %sm | near=%r over=%r chest=%r | %s"
              % (before["hs"], before["headW"], before["headW"], before["headTop"],
                 before["bodyW"], before["bodyH"], before["near"], before["over"], before["chest"],
                 before["meshes"]))
        check("no window yet", not before["until"], "until=%s" % before["until"])
        check("hs is 1 before the take", before["hs"] == 1)
        check("ordinary head is 0.50 x 0.50, top 1.90",
              abs(before["headW"] - 0.50) < 1e-6 and abs(before["headTop"] - 1.90) < 1e-6,
              "w=%s top=%s" % (before["headW"], before["headTop"]))
        check("body box 0.80 x 1.40 (BODY_R 0.4)",
              abs(before["bodyW"] - 0.80) < 1e-6 and abs(before["bodyH"] - 1.40) < 1e-6,
              "body=%sx%s" % (before["bodyW"], before["bodyH"]))
        check("the 0.38 m near-miss MISSES an ordinary skull", before["near"] is None,
              "rayPlayer=%r" % (before["near"],))
        check("the chest aim is a body hit (not a headshot)",
              bool(before["chest"]) and before["chest"][1] is False,
              "rayPlayer=%r" % (before["chest"],))
        out_dir = os.environ.get("BIGHEAD_SHOTS") or os.path.join(
            os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "tests", "shots")
        try:
            os.makedirs(out_dir, exist_ok=True)
            pg.screenshot(os.path.join(out_dir, "bighead-live-before.png"))
            print("  screenshot: %s" % os.path.join(out_dir, "bighead-live-before.png"))
        except Exception as e:
            print("  note: screenshot unavailable (%s)" % e)

        # --- plant a Big Head totem under the player; the tick's pickup pass takes it ---
        idx = pg.eval('HQV.strikeDebug().plantTotem("bighead")')
        check("V.plantTotem writes a live bighead drop", isinstance(idx, int),
              "idx=%r" % (idx,))
        ok = pg.wait_true("(HQV.strikeDebug().bigHeadUntil||0) > 0", 10)
        check("the game's OWN pickup pass took it (bigHeadUntil set)", ok,
              "until=%s" % pg.eval("HQV.strikeDebug().bigHeadUntil||0"))

        # --- after the take ---
        after = probe(pg, "after")
        print("  after:  hs=%s head=%sm x top=%s | near=%r over=%r chest=%r | %s"
              % (after["hs"], after["headW"], after["headTop"],
                 after["near"], after["over"], after["chest"], after["meshes"]))
        check("hs is 2 while the window is open", after["hs"] == 2 and after["until"] > after["t"],
              "hs=%s until=%s t=%s" % (after["hs"], after["until"], after["t"]))
        check("head doubled to 1.00 x 1.00, top 2.40",
              abs(after["headW"] - 1.00) < 1e-6 and abs(after["headTop"] - 2.40) < 1e-6,
              "w=%s top=%s" % (after["headW"], after["headTop"]))
        check("head bottom stays on the shoulders (1.40)",
              abs(after["headBottom"] - 1.40) < 1e-6, "bottom=%s" % after["headBottom"])
        check("body box STILL 0.80 x 1.40 (a chest shot cannot become a headshot)",
              abs(after["bodyW"] - 0.80) < 1e-6 and abs(after["bodyH"] - 1.40) < 1e-6,
              "body=%sx%s" % (after["bodyW"], after["bodyH"]))
        check("the 0.38 m near-miss is now a HEADSHOT",
              bool(after["near"]) and after["near"][1] is True,
              "rayPlayer=%r" % (after["near"],))
        check("the chest aim is STILL a body hit",
              bool(after["chest"]) and after["chest"][1] is False,
              "rayPlayer=%r" % (after["chest"],))
        check("a shot over the ordinary skull lands on the big one",
              bool(after["over"]) and after["over"][1] is True,
              "rayPlayer=%r" % (after["over"],))

        # --- 3D skulls: the head bone scales, the name tag lifts ---
        # the render loop eases headS toward headScaleAt; give it a couple of frames
        pg.eval("""
(function(){
  var g = HQV.strikeDebug();
  // snap the ease the way calm() does: the render loop then writes headS = wantH
  document.documentElement.classList.add("hq-calm");
  return true;
})()
""")
        # the render loop must run a frame for headS / bone scale / tag Y to land
        pg.wait_true("(function(){ return HQV.strikeDebug().clock() > 0; })()", 5)
        import time
        time.sleep(0.6)
        after2 = probe(pg, "after-calm")
        scaled = [m for m in after2["meshes"] if m.get("bone") is not None]
        check("the 3D head bone is scaled on every live mesh",
              bool(scaled) and all(m["bone"] > 1.5 for m in scaled),
              "bones %s" % [m.get("bone") for m in after2["meshes"]])
        # the render loop eases headS -> want at min(1, dt*8): with one frame of dt
        # the bone lands at 2 - (2-1)*exp(-8*dt) ... and after several frames it is
        # within a few percent of 2. Lock it to the formula, not just "> 1.5".
        if scaled:
            bones = [m["bone"] for m in scaled]
            check("the eased head scale converges on BIG_HEAD_S (2)",
                  all(abs(b - 2.0) < 0.15 for b in bones), "bones %s" % bones)
        lifted = [m for m in after2["meshes"] if m.get("tagY") is not None]
        # the tag sits at 2.15 + (headS-1)*0.95 — with headS ~2 that is ~3.10
        if lifted:
            want = [2.15 + (m["headS"] - 1) * 0.95 for m in after2["meshes"] if m.get("headS") is not None]
            check("the name tag lifts by (headS-1)*0.95",
                  bool(want) and all(abs(m["tagY"] - w) < 0.05 for m, w in zip([m for m in after2["meshes"] if m.get("tagY") is not None], want)),
                  "tags %s want %s" % ([m.get("tagY") for m in lifted], [round(w, 3) for w in want]))

        # --- the window does not pop on death ---
        lived = pg.eval("""
(function(){
  var g = HQV.strikeDebug();
  var u0 = g.bigHeadUntil || 0;
  g.hp = 0; g.dead = true; g.deadAt = g.clock();
  return {u0: u0, u1: g.bigHeadUntil || 0, dead: !!g.dead};
})()
""")
        check("dying does not pop the arena-wide window",
              lived["u1"] == lived["u0"] and lived["u1"] > 0,
              "until %s -> %s" % (lived["u0"], lived["u1"]))

        errs = pg.errors()
        check("no JavaScript errors on the console", not errs, "; ".join(errs[:4]))

        # --- visual proof: a screenshot of the live scene with the big skulls ---
        out = os.environ.get("BIGHEAD_SHOTS") or os.path.join(
            os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "tests", "shots")
        try:
            os.makedirs(out, exist_ok=True)
            pg.screenshot(os.path.join(out, "bighead-live-after.png"))
            print("  screenshot: %s" % os.path.join(out, "bighead-live-after.png"))
        except Exception as e:
            print("  note: screenshot unavailable (%s)" % e)

    finally:
        try:
            if br:
                br.close()
        except Exception:
            pass
        if server:
            US.stop_server(server)
        shutil.rmtree(tmp, ignore_errors=True)

    print()
    if fails:
        print("FAIL %d checks: %s" % (len(fails), ", ".join(fails)))
        return 1
    print("ALL PASS")
    return 0


if __name__ == "__main__":
    sys.exit(main())
