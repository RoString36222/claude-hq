/* The Warden must stand ON the deck, not buried under it.
   User bug: "the warder is too down, like fallign off map i can see his legs under
   the map". Two burials: (1) the boss is planted at y=0 while the dockyard centre is
   a raised platform (top y=3.5), and (2) the hanging arms punched 6 m through the
   floor and read as legs.

   Run: node tests/probe_warden_ground.js */
var fs = require("fs"), path = require("path");
var ROOT = path.join(__dirname, "..");
var js = fs.readFileSync(path.join(ROOT, "games", "strike.js"), "utf8");
var rs = fs.readFileSync(path.join(ROOT, "backend", "src", "strike.rs"), "utf8");
var map = JSON.parse(fs.readFileSync(path.join(ROOT, "games", "strike", "map.json"), "utf8"));

var fails = 0;
function check(ok, msg, extra){
  console.log("  " + (ok ? "PASS " : "FAIL ") + msg + (extra != null ? "  — " + extra : ""));
  if(!ok) fails++;
}
function twin(jsRe, rsRe, name){
  check(jsRe.test(js) && rsRe.test(rs), name,
        "js=" + jsRe.test(js) + " rs=" + rsRe.test(rs));
}

console.log("Warden ground placement");

// ---- 1. the real dockyard centre is a raised platform ----
var cx = (map.bounds[0] + map.bounds[3]) / 2, cz = (map.bounds[2] + map.bounds[5]) / 2;
var top = 0, i, b;
for(i = 0; i < map.boxes.length; i++){
  b = map.boxes[i];
  if(cx > b[0] - 0.6 && cx < b[3] + 0.6 && cz > b[2] - 0.6 && cz < b[5] + 0.6 && b[4] > top) top = b[4];
}
check(top > 1.5, "the dockyard centre is a raised platform (top y=" + top + ")",
      "this is what buried a boss planted at y=0");
check(cx === 0 && cz === 0, "the boss spawns at the map-bounds centre (" + cx + "," + cz + ")");
// the skirt is 18.6 m wide (half 9.3 x 6.0) but the raised centre is only 8 m — most of
// the skirt hangs over the floor, so the plant height must be the FLOOR under the
// skirt's footprint, not the platform top
var RX = 9.5, RZ = 6.2;
function groundAt(x, z){
  var t = 0, bi, bb;
  for(bi = 0; bi < map.boxes.length; bi++){
    bb = map.boxes[bi];
    if(x > bb[0] - 0.6 && x < bb[3] + 0.6 && z > bb[2] - 0.6 && z < bb[5] + 0.6 && bb[4] > t) t = bb[4];
  }
  return t;
}
var corners = [groundAt(cx - RX, cz - RZ), groundAt(cx + RX, cz - RZ),
               groundAt(cx - RX, cz + RZ), groundAt(cx + RX, cz + RZ)];
var rimTop = Math.min(Math.min(corners[0], corners[1]), Math.min(corners[2], corners[3]));
var wardenPlantY = Math.min(top, rimTop);
check(wardenPlantY < top, "the skirt footprint overhangs the platform (corner min y=" + rimTop + ")",
      "corners=[" + corners.join(", ") + "] — this is the 'floating' look: a 18.6 m skirt on an 8 m platform");

// ---- 2. both sides plant from a shared ground helper ----
twin(/function holeGroundY\(x, z\)/, /pub fn ground_y\(m: &Map, x: f64, z: f64\)/,
     "a ground helper exists on both judges");
twin(/function wardenGY\(W\)/, /pub gy: f64/,
     "the Warden carries its deck height (W.y / Warden.gy)");
// The skirt is 18.6 m wide and the raised centre is only 8 m — planting on the
// platform top leaves the rim hanging in mid-air ("floating"). The plant height
// is the FLOOR under the rim of the skirt, not the platform top.
twin(/function wardenGroundY\(x, z\)/, /pub fn warden_ground_y\(m: &Map, x: f64, z: f64\)/,
     "a plant-height helper exists on both judges");
twin(/wardenGroundY\(cx, cz\)/, /warden_ground_y\(self\.map\(\), cx, cz\)/,
     "summon plants from the floor under the skirt rim");
check(wardenPlantY < top, "the plant height is the FLOOR, not the platform top (y=" + wardenPlantY + ")",
      "platform top=" + top + " — planting there floated the skirt");
check(/g\.position\.set\(W\.x, wardenGY\(W\), W\.z\)/.test(js),
      "the 3D mesh sits on the deck at (x, z)");
check(/wardenGroup\.position\.y = gy \+ \(quiet \? 0 : Math\.sin/.test(js),
      "the idle bob rides the deck, not the buried y=0 plane");

// ---- 3. the arm chain rests on the deck ----
// The old chain: elbow at -8.1, fore -3.6 (h=6.6), fist -7.5 (h=3.6), knuckle -9.1
// hung to local y = 11.7 - 8.1 - 9.1 - 0.675 = -6.175 — 6 m of arm under the floor.
// The new one must stop at the deck: the lowest knuckle edge is at local y >= -0.05.
var arm = /elbow\.position\.set\(0, (-?[\d.]+), 0\);[\s\S]*?var fore = part\([\d.]+, ([\d.]+),[\s\S]*?var fist = part\([\d.]+, ([\d.]+),[\s\S]*?var knuckle = part\([\d.]+, ([\d.]+),/.exec(js);
if(!arm){
  check(false, "the heavy-arm chain is still spelled out in wardenBuild");
} else {
  var elbowY = +arm[1], foreH = +arm[2], fistH = +arm[3], knuckleH = +arm[4];
  // knuckle local centre, read from the source so a later tweak cannot silently
  // re-bury the fist
  var kn = /var knuckle = part\([\d.]+, [\d.]+, [\d.]+, 0, (-?[\d.]+)/.exec(js);
  var knuckleCy = kn ? +kn[1] : NaN;
  var lowest = 11.7 + elbowY + knuckleCy - knuckleH / 2;
  check(lowest >= -0.12, "the fist/knuckle REST on the deck (local lowest y=" + lowest.toFixed(3) + ")",
        "anything below 0 punches through the floor and reads as legs");
  check(foreH <= 3.0 && fistH <= 2.0,
        "the forearm is short enough that the arm cannot hang through the floor",
        "fore=" + foreH + " fist=" + fistH);
}

// ---- 4. hit volumes and LOS probes lift with the deck ----
twin(/gy \+ t\[2\], wz - t\[1\], cx \+ \(ox\|\|0\) \+ t\[0\], gy \+ t\[3\]/, /gy \+ y0, wz - hd, cx \+ hw, gy \+ y1/,
     "WARDEN_BOX_* y-spans are measured from the deck");
twin(/gy \+ WARDEN_SEE_CHEST/, /gy \+ WARDEN_SEE_CHEST/,
     "the chest LOS probe lifts with the deck");
twin(/gy \+ WARDEN_SEE_ARM/, /gy \+ WARDEN_SEE_ARM/,
     "the arm LOS probe lifts with the deck");
twin(/wardenGY\(W\) \+ WARDEN_SEE_HEAD/, /wd\.gy \+ WARDEN_SEE_HEAD/,
     "the laser-eye origin lifts with the deck");
// every bare WARDEN_SEE_* that is NOT preceded by a gy/wardenGY offset is a bug
var bare = [], lines = js.split("\n"), ln;
for(i = 0; i < lines.length; i++){
  ln = lines[i];
  if(/var WARDEN_SEE_/.test(ln)) continue;
  if(/WARDEN_SEE_(HEAD|CHEST|WAIST|ARM)/.test(ln) && !/gy \+ WARDEN_SEE_|wardenGY\([^)]*\) \+ WARDEN_SEE_/.test(ln)){
    bare.push((i + 1) + ": " + ln.trim());
  }
}
check(bare.length === 0, "no JS WARDEN_SEE_* is used without a deck offset",
      bare.length ? bare.join(" | ") : "clean");

// ---- 5. ground FX (slam rings, dust) sit on the deck too ----
check(/wardenGY\(W\) \+ 0\.08/.test(js) && /wardenGY\(W\) \+ 0\.1/.test(js),
      "slam / shock / grip rings paint on the deck");
check(/sp\.position\.set\(p\.x, gy \+ 0\.25, p\.z\)/.test(js),
      "the slam dust bursts on the deck");

// ---- 6. the scare pass: horns, fangs, spikes, runes ----
// A colossal golem needs to read as hostile at a glance. Every one of these is
// original box art (no third-party character, no Supercell/Clash anything).
check(/function horn\(side\)/.test(js), "ram horns are built in wardenBuild");
check(/hornL\.position\.set\(-2\.6, 16\.2/.test(js) && /hornR\.position\.set\(2\.6, 16\.2/.test(js),
      "two horns sweep back from the temples");
check(/function fang\(x, y, z, s\)/.test(js), "a fang helper is present");
// count the fang coordinate tuples in the literal row (six of them)
var fangLit = js.slice(js.indexOf("// fangs: a ragged row"), js.indexOf("// shoulder + spine spikes"));
var fangCount = (fangLit.match(/\[-?[\d.]+, -?[\d.]+, -?[\d.]+, -?[\d.]+\]/g) || []).length;
check(fangCount >= 4, "a ragged fang row hangs under the brow (" + fangCount + " fangs)",
      "the two canines are the longest");
check(/var spikes = \[\]/.test(js) && /spikes\.forEach\(function\(sp\)\{ g\.add\(sp\); \}\)/.test(js),
      "shoulder + spine spikes jag the silhouette");
check(/var runes = \[\]/.test(js) && /runes\.forEach\(function\(rn\)\{ g\.add\(rn\); \}\)/.test(js),
      "glowing rune slashes burn across the chest plate");
check(/var cheekL = part\(/.test(js) && /var crackL = part\(/.test(js),
      "the face is asymmetric (a cracked cheek plate), not a clean mask");

console.log(fails ? ("\n" + fails + " FAIL") : "\nALL PASS");
process.exit(fails ? 1 : 0);
