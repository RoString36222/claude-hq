/* Big Head totem proof: numbers, not claims.

   Pulls the REAL hitBoxes / rayPlayer out of games/strike.js's STRIKE-SHARED block and
   measures what the totem actually does to a headshot:
     - the head AABB at hs=1 vs hs=2 (width, height, and how far off-centre a shot can
       land and still read as a head)
     - a near-miss that misses at hs=1 and hits at hs=2
     - a chest shot that must NOT become a headshot at hs=2 (the body box never grows)
   Also locks the JS/Rust twins of BIG_HEAD_S, BIG_HEAD and FLAG_BIGHEAD.

   Run: node tests/probe_bighead.js */
var fs = require("fs");
var path = require("path");
var root = path.resolve(__dirname, "..");
var js = fs.readFileSync(root + "/games/strike.js", "utf8");
var rs = fs.readFileSync(root + "/backend/src/strike.rs", "utf8");
var m = js.match(/\/\* STRIKE-SHARED BEGIN \*\/([\s\S]*?)\/\* STRIKE-SHARED END \*\//);
if(!m){ console.error("no STRIKE-SHARED block"); process.exit(1); }
var FS = new Function(m[1] + "; return FS;")();

var fail = 0;
function check(name, ok, detail){
  console.log((ok ? "  PASS " : "  FAIL ") + name + (detail ? "  — " + detail : ""));
  if(!ok) fail++;
}

console.log("Big Head — head AABB (player at 0,0,0)");
function box(b){
  return "x[" + b[0].toFixed(2) + "," + b[3].toFixed(2) + "] y[" + b[1].toFixed(2) + "," + b[4].toFixed(2) +
         "] z[" + b[2].toFixed(2) + "," + b[5].toFixed(2) + "]";
}
var h1 = FS.hitBoxes(0, 0, 0, 1), h2 = FS.hitBoxes(0, 0, 0, 2);
var hD = FS.hitBoxes(0, 0, 0);   // omitted hs must mean ordinary
console.log("  hs=1 head " + box(h1[1]));
console.log("  hs=2 head " + box(h2[1]));
check("omitted hs == hs=1", box(hD[1]) === box(h1[1]));
check("body box never moves", box(h2[0]) === box(h1[0]), box(h1[0]));
var w1 = h1[1][3] - h1[1][0], w2 = h2[1][3] - h2[1][0];
var t1 = h1[1][4], t2 = h2[1][4];
check("head width doubles", Math.abs(w2 - 2 * w1) < 1e-9, w1.toFixed(2) + " -> " + w2.toFixed(2));
check("head top rises to 2.4", Math.abs(t2 - 2.4) < 1e-9, t1.toFixed(2) + " -> " + t2.toFixed(2));
check("head bottom stays at BODY_H", Math.abs(h2[1][1] - FS.BODY_H) < 1e-9);

console.log("\nBig Head — a near-miss becomes a headshot");
// shooter at z=10 looking down -z at a target's head height; ray offset 0.40 m to the
// side: outside the ordinary head (half-width 0.25), inside the big head (half-width 0.50)
function shotAt(offsetX, y, hs){
  var o = [offsetX, y, 10.0];
  var d = [0, 0, -1];
  return FS.rayPlayer(o, d, 0, 0, 0, 20, hs);
}
var miss = shotAt(0.40, 1.65, 1);
var hit = shotAt(0.40, 1.65, 2);
check("offset 0.40 @ head height misses at hs=1", miss === null || miss[1] === false, JSON.stringify(miss));
check("offset 0.40 @ head height IS a headshot at hs=2", !!(hit && hit[1] === true), JSON.stringify(hit));
check("and it lands nearer than the 10 m standoff", !!(hit && hit[0] > 9 && hit[0] < 10), hit && hit[0].toFixed(3));

var mid = shotAt(0.35, 2.05, 2);
check("offset 0.35 @ y=2.05 (above the old top) is a headshot at hs=2", !!(mid && mid[1] === true), JSON.stringify(mid));
var mid1 = shotAt(0.35, 2.05, 1);
check("the same shot is a miss at hs=1", mid1 === null, JSON.stringify(mid1));

console.log("\nBig Head — a chest shot must NOT become a headshot");
// straight through the chest: y=1.0, dead centre. Must read as body at both scales.
var chest1 = shotAt(0, 1.0, 1), chest2 = shotAt(0, 1.0, 2);
check("chest shot is body at hs=1", !!(chest1 && chest1[1] === false), JSON.stringify(chest1));
check("chest shot is STILL body at hs=2", !!(chest2 && chest2[1] === false), JSON.stringify(chest2));
// and one just under the old head bottom: y=1.35, still body
var under1 = shotAt(0, 1.35, 1), under2 = shotAt(0, 1.35, 2);
check("y=1.35 is body at hs=1", !!(under1 && under1[1] === false), JSON.stringify(under1));
check("y=1.35 is STILL body at hs=2", !!(under2 && under2[1] === false), JSON.stringify(under2));

console.log("\nBig Head — JS/Rust twins");
function twin(jsRe, rsRe, label){
  var j = js.match(jsRe), r = rs.match(rsRe);
  check(label + " present in both", !!(j && r), (j ? j[0] : "js?") + " | " + (r ? r[0] : "rs?"));
  if(j && r){
    var jv = j[1].replace(/_/g, ""), rv = r[1].replace(/_/g, "");
    check(label + " agrees", jv === rv || parseFloat(jv) === parseFloat(rv), jv + " vs " + rv);
  }
}
twin(/var BIG_HEAD_S = ([0-9.]+)/, /pub const BIG_HEAD_S: f64 = ([0-9.]+)/, "BIG_HEAD_S");
twin(/bighead:\s*\{hue:\s*"#ff8fab"[^}]*dur:\s*([0-9.]+)/, /pub const BIG_HEAD: f64 = ([0-9.]+)/, "BIG_HEAD dur");
twin(/var FLAG_BIGHEAD = ([0-9_]+)/, /pub const FLAG_BIGHEAD: i64 = ([0-9_]+)/, "FLAG_BIGHEAD");

check("bighead is in the JS TOTEMS table", /bighead:\s*\{hue:\s*"#ff8fab"/.test(js));
check("bighead is in the Rust TOTEM_KINDS", /"bighead"/.test(rs));
check("bighead has TOTEM_HELP text", /bighead:\s*"/.test(js));
check("all three JS rosters carry bighead",
      (js.match(/"radarjam","bighead","disco","banana","lava","goose","reverse","blackhole","roulette"\]/g) || []).length === 3,
      ((js.match(/"radarjam","bighead","disco","banana","lava","goose","reverse","blackhole","roulette"\]/g) || []).length) + " of 3");
check("hitBoxes takes hs in JS", /function hitBoxes\(x, y, z, hs\)/.test(js));
check("hit_boxes takes hs in Rust", /pub fn hit_boxes\(x: f64, y: f64, z: f64, hs: f64\)/.test(rs));
check("rayPlayer takes hs in JS", /function rayPlayer\(o, d, x, y, z, maxd, hs\)/.test(js));
check("ray_player takes hs in Rust", /pub fn ray_player\(.*hs: f64\)/.test(rs));
check("every JS hit call passes headScaleAt", (js.match(/FS\.rayPlayer\([^)]*headScaleAt/g) || []).length === 5,
      (js.match(/FS\.rayPlayer\([^)]*headScaleAt/g) || []).length + " of 5 rayPlayer sites");
check("the JS rocket hitBoxes passes headScaleAt", /FS\.hitBoxes\([^)]*headScaleAt/.test(js));

console.log("\n" + (fail ? "FAILURES: " + fail : "ALL PASS"));
process.exit(fail ? 1 : 0);
