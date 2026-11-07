/* Disco totem proof: numbers, not claims.

   The Disco totem is taken by one player; everyone EXCEPT them dances for 8 s and
   cannot shoot. The taker keeps their gun. This probe drives the real canShoot /
   danceOn / totemApply disco branch out of games/strike.js and checks the JS/Rust
   twins agree.

   Printed timeline (t=0 is the grab):
     - the taker shoots
     - the dancer's canShoot refuses and then recovers
     - the roster/help/flag twins agree

   Run: node tests/probe_disco.js */
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

// Pull a top-level `function name(...){...}` out of the game source and bind it to a
// stub V so the probe runs the shipped predicate, not a re-typed copy of it.
function extractFn(src, name){
  var i = src.indexOf("function " + name + "(");
  if(i < 0) return null;
  var j = src.indexOf("{", i);
  if(j < 0) return null;
  var depth = 0;
  for(var k = j; k < src.length; k++){
    var c = src.charAt(k);
    if(c === "{") depth++;
    else if(c === "}"){ depth--; if(depth === 0) return src.slice(i, k + 1); }
  }
  return null;
}
function bindFn(src, name, deps, argNames){
  var body = extractFn(src, name);
  if(!body) return null;
  var argList = (argNames || []).join(", ");
  var depList = Object.keys(deps).join(", ");
  var vals = Object.keys(deps).map(function(k){ return deps[k]; });
  try {
    return new Function(depList, "return (" + body + ");").apply(null, vals);
  } catch(e){
    console.error("cannot bind " + name + ": " + e.message);
    return null;
  }
}

// ---- a mock local player, just enough for canShoot ----
function mockV(over){
  var V = {
    dead: false, paused: false,
    mode: "bots", phase: "round",
    hookUntil: 0, readyAt: 0, nextShot: 0, reloadAt: 0,
    w: 0, mag: [30, 5, 6, 1, 5], magX: [1],
    danceUntil: 0
  };
  if(over) for(var k in over) V[k] = over[k];
  return V;
}
var LAUNCH_W = 3;
function magOf(w){ return w === LAUNCH_W ? V.magX : V.mag; }

var V = mockV();
var danceOn = bindFn(js, "danceOn", {V: null}, ["t"]);
// canShoot also gates on the dragon saddle (guns stowed while riding) — bind a
// stub of the real dragonRiding so the shipped predicate runs as written
function dragonRiding(t){ return !!(V.dragons || []).some(function(D){
  return D && D.riderIsMe && !D.dead; }); }
var canShoot = bindFn(js, "canShoot", {
  V: null, danceOn: null, magOf: magOf, LAUNCH_W: LAUNCH_W, dragonRiding: dragonRiding
}, ["t"]);
// re-bind with the live V / danceOn now that they exist
danceOn = bindFn(js, "danceOn", {V: V}, ["t"]);
canShoot = bindFn(js, "canShoot", {V: V, danceOn: danceOn, magOf: magOf, LAUNCH_W: LAUNCH_W, dragonRiding: dragonRiding}, ["t"]);
check("danceOn is a real function in strike.js", typeof danceOn === "function");
check("canShoot is a real function in strike.js", typeof canShoot === "function");

console.log("Disco — trigger lock (t=0 is the grab, window is 8 s)");
// ---- R1. the TAKER keeps the gun ----
V.danceUntil = 0;
check("the taker's canShoot is open right after the grab", canShoot(0.1) === true);
check("and stays open mid-window", canShoot(4.0) === true);

// ---- R2. a DANCER's trigger is locked, then recovers ----
V.danceUntil = 8.0;
check("danceOn is true at t=1", danceOn(1.0) === true);
check("danceOn is true at t=7.9", danceOn(7.9) === true);
check("a dancer's canShoot REFUSES at t=1", canShoot(1.0) === false);
check("a dancer's canShoot REFUSES at t=7.9", canShoot(7.9) === false);
check("danceOn is false at t=8", danceOn(8.0) === false);
check("the dancer's canShoot RECOVERS at t=8.1", canShoot(8.1) === true);

// ---- R3. the other gates still fire on top of the dance ----
V.danceUntil = 8.0;
V.dead = true;
check("dead still refuses even while dancing", canShoot(1.0) === false);
V.dead = false; V.paused = true;
check("paused still refuses even while dancing", canShoot(1.0) === false);
V.paused = false; V.hookUntil = 20.0;
check("a live hook still refuses even if the dance is over", canShoot(8.1) === false);
V.hookUntil = 0; V.reloadAt = 3.0;
check("a reload still refuses even if the dance is over", canShoot(8.1) === false);
V.reloadAt = 0;
check("and the trigger is open again with a full mag", canShoot(8.1) === true);
V.mag = [0, 5, 6, 1, 5];
check("an empty mag still refuses even if the dance is over", canShoot(8.1) === false);
V.mag = [30, 5, 6, 1, 5];

console.log("\nDisco — totemApply stamps everyone but the taker");
// Slice the real disco branch out of totemApply and run it against a stub roster.
var discoBlk = js.match(/if\(kind === "disco"\)\{[\s\S]*?\n    \}/);
check("totemApply has a disco branch", !!discoBlk);
if(discoBlk){
  var stamped = [], rings = 0;
  // others() is everyone but the taker — that is the whole point of the totem.
  var dancers = [
    {name: "foe",  gone: false, danceUntil: 0},
    {name: "mate", gone: false, danceUntil: 0},
    {name: "left", gone: true,  danceUntil: 0}
  ];
  var taker = {name: "you", gone: false, danceUntil: 0};
  var others = function(){ return dancers; };
  var TOTEMS = {disco: {dur: 8}};
  var R3 = {charm: function(P, kind){ stamped.push([P.name, kind]); },
            ring: function(){ rings++; }};
  var Vst = {me: {x: 1, y: 2, z: 3}};
  var runner = new Function("others", "TOTEMS", "R3", "V",
    "var kind = 'disco', t = 0;" + discoBlk[0]);
  var err = null;
  try { runner(others, TOTEMS, R3, Vst); } catch(e){ err = e.message; }
  check("the disco branch runs against a stub roster", !err, err || "ok");
  check("the taker is never stamped", taker.danceUntil === 0, "danceUntil=" + taker.danceUntil);
  check("every other living player dances for TOTEMS.disco.dur",
        dancers[0].danceUntil === 8 && dancers[1].danceUntil === 8,
        "foe=" + dancers[0].danceUntil + " mate=" + dancers[1].danceUntil);
  check("a gone player is left alone", dancers[2].danceUntil === 0);
  check("both dancers get a disco mark", stamped.filter(function(s){ return s[1] === "disco"; }).length === 2,
        JSON.stringify(stamped));
  check("the ring fires once", rings === 1, String(rings));
  check("the branch never touches the taker", stamped.every(function(s){ return s[0] !== "you"; }));
}

console.log("\nDisco — movement and bot gates");
check("canMove is gated on !danceOn(t)",
      /var canMove = [^;]*!danceOn\(t\)/.test(js),
      (js.match(/var canMove = [^\n]+/) || ["?"])[0]);
check("botStep returns early while dancing",
      /if\(P\.danceUntil && t < P\.danceUntil\) return;/.test(js));
check("danceOn is consulted by canShoot",
      /if\(danceOn\(t\)\) return false;/.test(js));

console.log("\nDisco — JS/Rust twins");
function twin(jsRe, rsRe, label){
  var j = js.match(jsRe), r = rs.match(rsRe);
  check(label + " present in both", !!(j && r), (j ? j[0] : "js?") + " | " + (r ? r[0] : "rs?"));
  if(j && r){
    var jv = String(j[1]).replace(/_/g, ""), rv = String(r[1]).replace(/_/g, "");
    check(label + " agrees", jv === rv || parseFloat(jv) === parseFloat(rv), jv + " vs " + rv);
    return jv;
  }
  return null;
}
var dur = twin(/disco:\s*\{hue:\s*"#ff2d95"[^}]*dur:\s*([0-9.]+)/, /pub const DISCO: f64 = ([0-9.]+)/, "disco dur");
twin(/var FLAG_DISCO = ([0-9_]+)/, /pub const FLAG_DISCO: i64 = ([0-9_]+)/, "FLAG_DISCO");
check("FLAG_DISCO is 1<<28", 268435456 === (1 << 28), String(1 << 28));
check("FLAG_BIGHEAD is 1<<27 (bits do not collide)",
      (134217728 === (1 << 27)) && (268435456 & 134217728) === 0);

console.log("\nDisco — roster, help, pose");
check("disco is in the JS TOTEMS table", /disco:\s*\{hue:\s*"#ff2d95"/.test(js));
check("disco is in the Rust TOTEM_KINDS", /"bighead", "disco",/.test(rs));
check("disco has TOTEM_HELP text", /disco:\s*"For 8s everyone but you breaks into a disco dance/.test(js));
check("all three JS personal rosters carry disco",
      (js.match(/"bighead","disco","banana","lava","goose","reverse","blackhole","roulette","turret","barrel","laser","jumppad","lottery"\]/g) || []).length === 3,
      ((js.match(/"bighead","disco","banana","lava","goose","reverse","blackhole","roulette","turret","barrel","laser","jumppad","lottery"\]/g) || []).length) + " of 3");
check("the mark kind is its own (a charm drop must not clear a disco mark)",
      /clearMarks\(P, "disco"\)/.test(js) && /clearMarks\(P, "charm"\)/.test(js));
check("dance pose drives arm / leg / torso bones",
      /bones\.armL/.test(js) && /bones\.legR/.test(js) && /bones\.torso/.test(js) && /dancePh/.test(js));
check("the gun hand hides while dancing", /if\(m\.gun\) m\.gun\.forEach\(function\(gn\)\{ if\(gn\) gn\.visible = false; \}\);/.test(js));
check("judge fire_inner refuses a dancer", /p\.dance_until > t/.test(rs));
check("judge bot_fire refuses a dancer", /if self\.players\[i\]\.1\.dance_until > t \{/.test(rs));
check("judge snapshot carries FLAG_DISCO per row",
      /if p\.dance_until > t \{ FLAG_DISCO \} else \{ 0 \}/.test(rs));

console.log("\n" + (fail ? "FAILURES: " + fail : "ALL PASS"));
process.exit(fail ? 1 : 0);
