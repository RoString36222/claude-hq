/* Hurricane vortex: the column takes you — numbers, not claims.

   The old hurricane was a radial shove: anyone inside got nudged a bit and walked
   out. It is now a real vortex. A body that steps inside the walking wind column is
   LIFTED off the deck, spun around the core, and held there with no way to walk out
   (wishes are zeroed, the grip is re-asserted every tick, and it lingers a beat
   after you leave the column so the spin does not staccato as the column walks).

   Both judges carry it: `inWindCatch` in games/strike.js and `wind_catch` in
   backend/src/strike.rs, on the same five numbers.

   Run: node tests/probe_warden_vortex.js */
var fs = require("fs");
var path = require("path");
var root = path.resolve(__dirname, "..");
var js = fs.readFileSync(root + "/games/strike.js", "utf8");
var rs = fs.readFileSync(root + "/backend/src/strike.rs", "utf8");

var fail = 0;
function check(name, ok, detail){
  console.log((ok ? "  PASS " : "  FAIL ") + name + (detail ? "  — " + detail : ""));
  if(!ok) fail++;
}
function twin(name, jsRe, rsRe){
  check(name, jsRe.test(js) && rsRe.test(rs),
        "js=" + jsRe.test(js) + " rs=" + rsRe.test(rs));
}

console.log("Hurricane — a real vortex, not a shove");

// ---- 1. the five twin numbers ----
var NUMS = [
  ["DD_WIND_CATCH_R", /DD_WIND_CATCH_R = 3\.6/, /DD_WIND_CATCH_R: f64 = 3\.6/],
  ["DD_WIND_TOP",     /DD_WIND_TOP = 4\.2/,     /DD_WIND_TOP: f64 = 4\.2/],
  ["DD_WIND_LIFT",    /DD_WIND_LIFT = 3\.2/,    /DD_WIND_LIFT: f64 = 3\.2/],
  ["DD_WIND_SPIN",    /DD_WIND_SPIN = 2\.6/,    /DD_WIND_SPIN: f64 = 2\.6/],
  ["DD_WIND_CATCH",   /DD_WIND_CATCH = 1\.6/,   /DD_WIND_CATCH: f64 = 1\.6/]
];
NUMS.forEach(function(n){ twin(n[0] + " is spelled once on each side", n[1], n[2]); });

// ---- 2. the catch owns the body ----
twin("both judges carry a catch helper", /function inWindCatch\(/, /fn wind_catch\(/);
check("JS starts the orbit where the body stands (no teleport onto the ring)",
      /var phH = Math\.atan2\(V\.me\.z - colH\[1\], V\.me\.x - colH\[0\]\)/.test(js));
check("Rust starts the orbit where the body stands (no teleport onto the ring)",
      /p\.vortex_phase = \(p\.z - wz\)\.atan2\(p\.x - wx\)/.test(rs));

// ---- 3. it lifts, and it tops out ----
twin("the updraught climbs to DD_WIND_TOP and stops",
     /s\.y = Math\.min\(DD_WIND_TOP, \(s\.y \|\| 0\) \+ \(lift \|\| 0\) \* \(dt \|\| 0\.016\)\)/,
     /p\.y = \(p\.y \+ lift \* dt\)\.min\(DD_WIND_TOP\)/);

// ---- 4. no way to walk out ----
check("JS the grip owns the body — no FS.move while swirling",
      /if\(!dropping && !flying && !swinging && !swirling\)\{/.test(js));
check("JS a swirling body is spun with the column (the camera turns with it)",
      /V\.yaw \+= DD_WIND_SPIN \* dt/.test(js));
check("Rust skips step() while gripped (gravity must not yank you back down)",
      /\} else if vortexed_now \{/.test(rs) && /no step\(\) and no gravity/.test(rs));
twin("the grip is held a beat past the column (no staccato)",
     /gripH\.until = Math\.max\(gripH\.until\|0, t \+ DD_WIND_CATCH\)/,
     /if p\.vortex_until < t \+ DD_WIND_CATCH \{[\s\S]*?p\.vortex_until = t \+ DD_WIND_CATCH/);

// ---- 5. everyone suffers, not just you ----
check("JS grips solo bots too", /ai\.body\.vortex/.test(js) && /vortexB/.test(js));
check("Rust grips every non-immune player",
      /for j in 0..self\.players\.len\(\) \{[\s\S]*?Self::wind_catch\(/.test(rs));

// ---- 6. the old shove is gone ----
check("JS no longer shoves radially outward",
      !/shoveH = DD_WIND_PUSH/.test(js) && !/shoveHB/.test(js));
check("Rust no longer shoves radially outward",
      !/let shove = DD_WIND_PUSH/.test(rs));

// ---- 7. the referee does not rubber-band the orbit ----
check("Rust lets the orbit through the speed cap (it is the column, not a dash)",
      /p\.slip_until > t \|\| p\.hole_drag > t \|\| p\.vortex_until > t/.test(rs));
check("Rust parks the air clock while gripped (the updraught is not a fall)",
      /let vortex_let_up = p\.vortex_until > t/.test(rs));

// ---- 8. the help text tells the truth ----
check("the disaster card promises the lift and the spin",
      /it takes you: lifted into the air and spun around the core with no way to walk out/.test(js));
check("the live banner says it will pick you up",
      /WIND COLUMN — it will pick you up and spin you/.test(js));

console.log(fail === 0 ? "\nVortex — all checks green." : "\nFAILURES: " + fail);
process.exit(fail === 0 ? 0 : 1);
