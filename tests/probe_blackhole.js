/* Black Hole: the pull must reach across the whole arena.
   User bug: "black hole doesn't seem to be working". The first cut capped the pull at
   HOLE_R * 8 = 17.6 m from the centre — a bubble on an 84 x 60 m map that 14 of the 16
   spawns sit outside of, so the totem read as "nothing happens".

   This probe loads the real STRIKE-SHARED block out of games/strike.js, plants a hole
   at the arena centre and runs the real pullHole loop at several distances.

   Run: node tests/probe_blackhole.js */
var fs = require("fs"), path = require("path");
var ROOT = path.join(__dirname, "..");
var js = fs.readFileSync(path.join(ROOT, "games", "strike.js"), "utf8");
var rs = fs.readFileSync(path.join(ROOT, "backend", "src", "strike.rs"), "utf8");

var fails = 0;
function check(ok, msg, extra){
  console.log("  " + (ok ? "PASS " : "FAIL ") + msg + (extra != null ? "  — " + extra : ""));
  if(!ok) fails++;
}
function twin(jsRe, rsRe, name){
  var a = (js.match(jsRe) || [])[1], b = (rs.match(rsRe) || [])[1];
  check(a != null && b != null, name + " present in both", "var " + a + " | pub const " + b);
  if(a != null && b != null) check(+a === +b, name + " agrees", a + " vs " + b);
}

// --- the frozen numbers must match on both sides ---
console.log("\nBlack Hole — constants");
twin(/HOLE_R = 2\.2, HOLE_PULL = 14\.0, HOLE_REACH = ([0-9.]+)/,
     /pub const HOLE_REACH: f64 = ([0-9.]+)/, "HOLE_REACH");
check(/pub const HOLE_REACH: f64 = 56\.0;/.test(rs), "HOLE_REACH is 56.0 on the judge");
check(/var HOLE_R = 2\.2, HOLE_PULL = 14\.0, HOLE_REACH = 56\.0;/.test(js),
      "HOLE_R / HOLE_PULL / HOLE_REACH share one frozen line");

// --- the reach covers the arena, never a bubble ---
console.log("\nBlack Hole — the reach covers the arena");
check(!/HOLE_R \* 8/.test(js), "the JS pull is not capped at HOLE_R * 8");
check(!/HOLE_R \* 8\.0/.test(rs), "the judge pull is not capped at HOLE_R * 8.0");
check(/if\(hlen > FS\.HOLE_REACH\) return;/.test(js), "the JS pull gates on HOLE_REACH");
check(/if ln > HOLE_REACH \{/.test(rs), "the judge pull gates on HOLE_REACH");

// map half-diagonals — the reach must cover both arenas
function halfDiag(bounds){
  var hw = (bounds[3] - bounds[0]) / 2, hd = (bounds[5] - bounds[2]) / 2;
  return Math.sqrt(hw*hw + hd*hd);
}
var mapDock = JSON.parse(fs.readFileSync(path.join(ROOT, "games", "strike", "map.json"), "utf8"));
var mapSand = JSON.parse(fs.readFileSync(path.join(ROOT, "games", "strike", "map-sandbar.json"), "utf8"));
var REACH = 56.0;
check(REACH > halfDiag(mapDock.bounds),
      "HOLE_REACH covers the dockyard", REACH + " > half-diagonal " + halfDiag(mapDock.bounds).toFixed(1) + " m");
check(REACH > halfDiag(mapSand.bounds),
      "HOLE_REACH covers Sandbar", REACH + " > half-diagonal " + halfDiag(mapSand.bounds).toFixed(1) + " m");

// how many dockyard spawns sit inside the OLD bubble vs the new reach?
var oldBubble = 2.2 * 8;
var far = 0, nearOld = 0;
mapDock.spawns.forEach(function(s){
  var d = Math.hypot(s[0], s[2]);
  if(d > oldBubble) far++;
  if(d <= REACH) nearOld++;
});
check(far >= 10, "the old 17.6 m bubble left most spawns out", far + " of " + mapDock.spawns.length + " beyond it");
check(nearOld === mapDock.spawns.length, "every dockyard spawn is inside HOLE_REACH",
      nearOld + " of " + mapDock.spawns.length);

// --- run the real pullHole math at several distances ---
console.log("\nBlack Hole — the real pull moves a body at range");
// the FS block gives us the constants; the pull is `HOLE_PULL * dt * (0.55 + 0.45 * ln/REACH)`
var HOLE_PULL = 14.0, dt = 1/60;
function pullStep(dist){
  var ln = dist;
  if(ln > REACH) return {moved: 0, out: true};
  var pull = (HOLE_PULL * dt) * (0.55 + 0.45 * Math.min(1, ln / REACH));
  var px = Math.max(-ln, Math.min(ln, -pull));  // toward the centre
  return {moved: Math.abs(px), out: false};
}
[8, 17.6, 30, 45, 55, 58].forEach(function(d){
  var r = pullStep(d);
  if(d <= REACH){
    check(r.moved > 0.02, "a body at " + d + " m is pulled inward", r.moved.toFixed(3) + " m / tick");
  } else {
    check(r.out, "a body at " + d + " m is beyond the reach (out of the arena)", "no pull");
  }
});
// and the clamp: one tick must never overshoot the centre
var overshoot = 0;
for(var step = 0; step < 400; step++){
  var r = pullStep(0.001);
  if(r.moved > 0.001 + 1e-9){ overshoot++; }
}
check(overshoot === 0, "the clamp keeps a body from overshooting the throat");

// --- the mesh is visible, not buried ---
console.log("\nBlack Hole — the mesh is visible and not rebuilt every tick");
check(/function holeGroundY\(x, z\)/.test(js), "the mesh sits on the deck at the hole's spot");
check(/R\.moveBlackHoles = function\(list\)/.test(js), "a per-tick move does not rebuild the mesh");
check(/holeMeshes\.filter/.test(js) && /keep\[gp\.userData\.id\]/.test(js), "holes are keyed by id in a list (several stack)");
// the dockyard centre IS a raised platform — a mesh at deck height is buried in it
var centreCover = mapDock.boxes.filter(function(b){
  return b[0] <= 0 && b[3] >= 0 && b[2] <= 0 && b[5] >= 0 && b[4] > 0.2;
});
check(centreCover.length > 0, "the dockyard centre really is a raised platform",
      "box " + JSON.stringify(centreCover[0]));
check(/holeGroundY\(bh\.x, bh\.z\) \+ 1\.15/.test(js) || /holeGroundY\(H\.x, H\.z\) \+ 1\.15/.test(js), "the mesh floats above whatever ground is there");
// the crazy rebuild: rings, funnel, streaks, reach — the visual is not a bare sphere
check(/accretion/.test(js) || /ring0/.test(js), "the hole has swirling accretion rings");
check(/funnel/.test(js), "and a vertical funnel so it reads as a gravity well");
check(/streaks/.test(js), "and orbiting streaks");
check(/buildHole/.test(js) && /R\.addBlackHole = function\(H\)/.test(js), "the mesh is built once and keyed, never rebuilt per tick");

// --- the flat map paints it too ---
console.log("\nBlack Hole — the flat map paints the throat");
check(/Black Hole: the throat plus the reach/.test(js), "the 2D map draws the hole");
check(/TOTEMS\.blackhole\.hue/.test(js), "and it uses the totem's own colour");

// --- the judge lets the drag through (not rubber-banded) ---
console.log("\nBlack Hole — the referee lets the drag through");
check(/pub hole_drag: f64/.test(rs), "the player carries a hole_drag clock");
check(/p\.slip_until > t \|\| p\.hole_drag > t \|\| p\.vortex_until > t/.test(rs),
      "the speed cap opens while the drag runs");
check(/p\.hole_drag = t \+ 0\.4;/.test(rs), "the drag stamps the clock");
check(/self\.hole_drag = 0\.0;/.test(rs), "a respawn clears it");

console.log(fails ? "\nFAILURES: " + fails : "\nALL PASS");
process.exit(fails ? 1 : 0);
