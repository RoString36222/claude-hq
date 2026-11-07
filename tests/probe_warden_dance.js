/* Warden disco proof: numbers, not claims.

   Taking the Disco totem while The Warden is up must put the boss on the floor for
   the same 8 s window the fighters dance — arms pumping overhead alternately, a
   mirror ball over the crest — and every attack (slam / laser / grip / disaster)
   is held until the groove ends. A Disco window that is already live when the boss
   rises is picked up at summon. Both judges carry the clock; the `wd` snapshot row
   appends ms_dance.

   Run: node tests/probe_warden_dance.js */
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

// ---- 1. both judges carry a dance clock on the boss ----
check("JS wardenDanceOn exists", /function wardenDanceOn\(W, t\)/.test(js));
check("Rust Warden carries dance_until", /pub dance_until: f64,/.test(rs));
check("JS stores it on the boss as danceUntil",
      /V\.warden\.danceUntil = t \+ d/.test(js));
check("Rust stores it on the boss as dance_until",
      /wd\.dance_until = t \+ DISCO/.test(rs));

// ---- 2. the disco arm actually stamps the boss ----
var discoJs = js.match(/if\(kind === "disco"\)\{[\s\S]*?\n    \}/);
check("JS totemApply disco arm stamps the boss", !!discoJs && /V\.warden\.danceUntil = t \+ d/.test(discoJs[0]));
var discoRs = rs.match(/"disco" => \{[\s\S]*?\n            \}/);
check("Rust totem_apply disco arm stamps the boss", !!discoRs && /wd\.dance_until = t \+ DISCO/.test(discoRs[0]));
check("JS disco drops any in-flight telegraph",
      !!discoJs && /V\.warden\.slabArm = 0/.test(discoJs[0]) && /V\.warden\.laserOn = 0/.test(discoJs[0]));
check("Rust disco drops any in-flight telegraph",
      !!discoRs && /wd\.slab_arm = 0\.0/.test(discoRs[0]) && /wd\.laser_on = 0\.0/.test(discoRs[0]));

// ---- 3. attacks are held for the whole window ----
var tickJs = js.match(/function wardenTick\(dt, t\)\{[\s\S]*?\n  \}/);
check("JS wardenTick early-returns while dancing",
      !!tickJs && /if\(wardenDanceOn\(W, t\)\)\{/.test(tickJs[0]));
var tickRs = rs.match(/fn warden_tick\(&mut self, t: f64\) \{[\s\S]*?\n    \}/);
check("Rust warden_tick early-returns while dancing",
      !!tickRs && /if wd\.dance_until > t \{/.test(tickRs[0]));
// the hold must sit before the first attack arm, not after it
if(tickJs){
  var hold = tickJs[0].indexOf("if(wardenDanceOn(W, t))");
  var slam = tickJs[0].indexOf("body turn");
  check("JS hold sits before the body-turn / attack arms", hold >= 0 && slam > hold, "hold@" + hold + " turn@" + slam);
}
if(tickRs){
  var holdR = tickRs[0].indexOf("if wd.dance_until > t");
  var turnR = tickRs[0].indexOf("body turn");
  check("Rust hold sits before the body-turn / attack arms", holdR >= 0 && turnR > holdR, "hold@" + holdR + " turn@" + turnR);
}

// ---- 4. a live window at summon is picked up ----
var summonJs = js.match(/function wardenSummon\(t\)\{[\s\S]*?\n  \}/);
check("JS summon joins a live disco window",
      !!summonJs && /V\.warden\.danceUntil = left/.test(summonJs[0]));
var summonRs = rs.match(/fn warden_summon\(&mut self, t: f64\) \{[\s\S]*?\n    \}/);
check("Rust summon joins a live disco window",
      !!summonRs && /wd\.dance_until = left/.test(summonRs[0]));

// ---- 5. the groove is visible ----
check("JS mirror ball hangs over the crest",
      /wBall\.position\.set\(0, 20\.2, 0\)/.test(js));
check("JS mirror ball is only visible while dancing",
      /wardenParts\.discoBall\.visible = dancing/.test(js));
check("JS arms pump overhead alternately in the dance",
      /if\(dancing\)\{\s*\n\s*var dp = \(t \* 5\.2\) \+ \(side > 0 \? Math\.PI : 0\);/.test(js));
check("JS head wobbles during the dance",
      /wardenParts\.head\.rotation\.z = Math\.sin\(t \* 3\.2\) \* 0\.18/.test(js));

// ---- 6. the wire carries it (and old Arenas degrade) ----
check("JS snap parse reads ms_dance at index 16",
      /V\.warden\.danceUntil = \(wd\.length > 16 && \+wd\[16\] > 0\)/.test(js));
check("Rust snap row appends ms-dance",
      /if wd\.dance_until > t \{ ms\(wd\.dance_until\) \} else \{ 0 \}/.test(rs));
check("JS snap comment names ms_dance", /ms_dance/.test(js));
check("Rust snap comment names ms-dance", /ms-dance/.test(rs));

// ---- 7. the HUD chip counts the boss as a dancer ----
check("liveEffects disco chip counts the Warden",
      /wardenDanceOn\(null, t\) \|\| others\(\)\.some/.test(js));

// ---- 8. the help text says the boss dances too ----
check("TOTEM_HELP mentions The Warden",
      /disco:\s*"For 8s everyone but you breaks into a disco dance[^"]*The Warden too/.test(js));

console.log(fail === 0 ? "\nALL PASS" : "\n" + fail + " FAIL");
process.exit(fail === 0 ? 0 : 1);
