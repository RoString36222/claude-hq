/* Live-path proof for earthquake + sinkhole: do they damage, slow, and paint?
   Drives the REAL worldTick disaster block sliced out of games/strike.js, plus the
   REAL disStart / disSpot / markDamage / fxStart geometry. Numbers, not flags.
   Run: node tests/probe_quake_sink.js */
var fs = require("fs");
var path = require("path");
var root = path.resolve(__dirname, "..");
var src = fs.readFileSync(root + "/games/strike.js", "utf8");

function sliceFn(name){
  var i = src.indexOf("function " + name + "(");
  if(i < 0) throw new Error("missing function " + name);
  var j = src.indexOf("{", i), depth = 0, k = j;
  for(; k < src.length; k++){
    if(src[k] === "{") depth++;
    else if(src[k] === "}"){ depth--; if(depth === 0) break; }
  }
  return src.slice(i, k + 1);
}
function sliceVarBlock(from, to){
  var i = src.indexOf(from);
  var j = src.indexOf(to, i);
  if(i < 0 || j < 0) throw new Error("missing block " + from + " .. " + to);
  return src.slice(i, j);
}
// the disaster apply loop inside worldTick (the `for(var dI...` through its closing brace)
function sliceDisasterLoop(){
  var i = src.indexOf("// ---- Wave D: Arena Disasters (solo runs them; MP the server judges) ----");
  if(i < 0) throw new Error("missing Wave D comment");
  var j = src.indexOf("for(var dI = 0;", i);
  if(j < 0) throw new Error("missing dI loop");
  var k = src.indexOf("{", j), depth = 0, m = k;
  for(; m < src.length; m++){
    if(src[m] === "{") depth++;
    else if(src[m] === "}"){ depth--; if(depth === 0) break; }
  }
  // also grab the clock + expire block that sits just before it
  var head = src.slice(i, j);
  return head + src.slice(j, m + 1);
}

// ---- constants (verbatim from the file) ----
var DISASTERS = ["sandstorm", "meteorshower", "hurricane", "thunder", "earthquake",
                 "shockring", "toxicfog", "absolutezero", "sinkhole", "emp"];
var TOTEM_ALL = ["mole","freeze","decoy","cloak","shield","wings","leap","speed","teleport",
                 "rift","mirror","gravflip","rewind","shock","magnet","chain","trap","mark","blink","bubble",
                 "wallrun","secondwind","fakedeath","ghost","cluster","overclock","ricochet","infchamber",
                 "bodyswap","rally","meteor","chaos","phoenix","pocket","fate","king","radarjam"];
var TOTEMS = {};
TOTEM_ALL.concat(DISASTERS).forEach(function(k){ TOTEMS[k] = {n: k}; });

var DIS_WARN = 2.0, DIS_GAP = 45, DIS_FIRST = 30;
var DIS_HOLD = {sandstorm: 12, meteorshower: 10, hurricane: 10, thunder: 8,
  earthquake: 8, shockring: 5, toxicfog: 12, absolutezero: 10, sinkhole: 8, emp: 5};
var DD_METEOR_R = 3.5, DD_METEOR_DMG = 45, DD_METEOR_WARN = 1.0, DD_METEOR_GAP = 0.55;
var DD_THUNDER_R = 2.8, DD_THUNDER_DMG = 55, DD_THUNDER_WARN = 0.7, DD_THUNDER_GAP = 0.45;
var DD_QUAKE_R = 2.5, DD_QUAKE_DMG = 25, DD_QUAKE_WARN = 0.8, DD_QUAKE_GAP = 0.7;
var DD_SHOCK_R = 28, DD_SHOCK_DMG = 30, DD_SHOCK_KNOCK = 12;
var DD_TOXIC_R = 5, DD_TOXIC_DMG = 8, DD_TOXIC_ZONES = 3, DD_TOXIC_CHIP_DMG = 3;
var DD_SINK_R = 4.5, DD_SINK_DMG = 12, DD_SINK_PULL = 4;
var DD_WIND_R = 6, DD_WIND_PUSH = 7.5, DD_WIND_DMG = 3;
var DD_SAND_DMG = 3, DD_ZERO_DMG = 4, DD_EMP_DMG = 2;
var DD_NEAR_R = 0.35, DD_NEAR_MIN = 0.45;
var DD_THUNDER_BLIND = 0.45, DD_METEOR_BLIND = 0.35, DD_SHOCK_BLIND = 0.55;
var DD_QUAKE_SLOW = 1.2, DD_TOXIC_SLOW = 0.75, DD_SINK_SLOW = 0.65, DD_WIND_SLOW = 0.7;
var DD_SAND_SCATTER = 1.2, DD_WIND_SCATTER = 2.4, DD_EMP_SCATTER = 1.0, DD_SLOW_MULT = 0.65;

// ---- sandbox state ----
var V = {
  mode: "solo", warden: null,
  disasters: [], disasterLog: [], disasterAt: 0, worldK: 0,
  me: {x: 0, y: 0, z: 0, g: false}, hp: 100, dead: false,
  players: {}, order: [], team: 0, protUntil: 0, booms: [], disasterMarks: [],
  slowUntil: 0, blindUntil: 0, shakeAt: -10, chaosUntil: 0, beacons: [], mines: [],
  captureAt: null, crateAt: 0, fuseAt: 0
};
var MAP = {
  bounds: [-30, -1, -24, 30, 12, 24],
  boxes: [],
  pickups: []
};
var R3 = {events: [], disaster: function(kind, on, D){ this.events.push({kind: kind, on: on, D: D}); },
          boom: function(){}, ring: function(){}};
function say(m){}
function hashMatch(seed, salt){ var x = (seed ^ (salt*0x9e3779b9))|0; return ((x >>> 0) / 4294967295); }
function disKind(seed, salt, n){
  var nn = n || 1;
  var x = (Math.imul(seed, 0x9e3779b9) ^ Math.imul(salt, 0x85ebca6b)) | 0;
  x ^= x >>> 15;
  return (x >>> 0) % nn;
}
function clamp(v, a, b){ return v < a ? a : (v > b ? b : v); }
function flashCenter(){}
function endBotLife(){}
function myId(){ return "me"; }
function others(){
  return V.order.filter(function(u){ return u !== "me"; }).map(function(u){ return V.players[u]; });
}
function meShielded(t){ return !!(V.protUntil && t < V.protUntil); }
function botShielded(P, t){ return !!(P && P.protUntil && t < P.protUntil); }
function hasRoof(x, y, z){
  for(var i = 0; i < MAP.boxes.length; i++){
    var b = MAP.boxes[i];
    if(b[1] > y + 1.45 && b[1] <= y + 5.0
       && x + 0.25 > b[0] && x - 0.25 < b[3]
       && z + 0.25 > b[2] && z - 0.25 < b[5]) return true;
  }
  return false;
}
function wardenTick(){}
function dropPlan(){ return {totems: [0, 0, 0], packs: [0, 0], dis: [0, 0]}; }
function ensureDropSlots(){}
function dropSpot(){ return [0, 0, 0]; }
var FS = {
  markDamage: function(dist, r, dmg){
    r = +r; if(!(r > 0)) r = 1;
    dist = Math.max(0, +dist);
    var u = Math.min(1, dist / r), near = DD_NEAR_R, min = DD_NEAR_MIN;
    var k = u <= near ? 1 : min + (1 - min) * (1 - (u - near) / (1 - near));
    return Math.max(1, Math.round((dmg|0) * k));
  },
  overlaps: function(){ return -1; }
};
var nowT = 100;

// ---- the real bodies ----
var body = [
  "var disLogK = 0;",
  sliceFn("markDamage"),
  sliceFn("hasRoof"),
  sliceFn("disSpot"),
  sliceFn("disZonesNear"),
  sliceFn("liveSpots"),
  sliceFn("disStart"),
  sliceFn("disLog"),
  sliceFn("disClear"),
  sliceFn("disLive"),
  sliceFn("disAny"),
  sliceFn("disKindLive"),
  sliceFn("disAimScatter"),
  sliceDisasterLoop(),
  "return {disStart: disStart, disLive: disLive, disSpot: disSpot,",
  "        runDisasters: function(dt, t){",
  "          // the real Wave D block above closes over these",
  "        },",
  "        V: V, R3: R3};"
].join("\n");

// The disaster loop body we sliced is a statement list, not a function — wrap it.
var loopCode = sliceDisasterLoop();
var wrappedLoop = "function runDisasters(dt, t){\n" + loopCode + "\n}";

var params = [
  "DISASTERS","TOTEMS","TOTEM_ALL","V","MAP","R3","say","hashMatch","disKind","clamp",
  "flashCenter","endBotLife","myId","others","meShielded","botShielded","hasRoof",
  "wardenTick","dropPlan","ensureDropSlots","dropSpot","FS","now",
  "DIS_WARN","DIS_GAP","DIS_FIRST","DIS_HOLD",
  "DD_METEOR_R","DD_METEOR_DMG","DD_METEOR_WARN","DD_METEOR_GAP",
  "DD_THUNDER_R","DD_THUNDER_DMG","DD_THUNDER_WARN","DD_THUNDER_GAP",
  "DD_QUAKE_R","DD_QUAKE_DMG","DD_QUAKE_WARN","DD_QUAKE_GAP",
  "DD_SHOCK_R","DD_SHOCK_DMG","DD_SHOCK_KNOCK",
  "DD_TOXIC_R","DD_TOXIC_DMG","DD_TOXIC_ZONES","DD_TOXIC_CHIP_DMG",
  "DD_SINK_R","DD_SINK_DMG","DD_SINK_PULL",
  "DD_WIND_R","DD_WIND_PUSH","DD_WIND_DMG",
  "DD_SAND_DMG","DD_ZERO_DMG","DD_EMP_DMG",
  "DD_NEAR_R","DD_NEAR_MIN",
  "DD_THUNDER_BLIND","DD_METEOR_BLIND","DD_SHOCK_BLIND",
  "DD_QUAKE_SLOW","DD_TOXIC_SLOW","DD_SINK_SLOW","DD_WIND_SLOW",
  "DD_SAND_SCATTER","DD_WIND_SCATTER","DD_EMP_SCATTER","DD_SLOW_MULT"
];
var bodyCode = "var disLogK = 0;\n" +
  sliceFn("disSpot") + "\n" +
  sliceFn("disZonesNear") + "\n" +
  sliceFn("liveSpots") + "\n" +
  sliceFn("disStart") + "\n" +
  sliceFn("disLog") + "\n" +
  sliceFn("disClear") + "\n" +
  sliceFn("disLive") + "\n" +
  sliceFn("disAny") + "\n" +
  sliceFn("disKindLive") + "\n" +
  sliceFn("disAimScatter") + "\n" +
  wrappedLoop + "\n" +
  "return {disStart: disStart, disLive: disLive, disSpot: disSpot, disZonesNear: disZonesNear, " +
  "runDisasters: runDisasters, V: V, R3: R3, DIS_HOLD: DIS_HOLD, DIS_WARN: DIS_WARN};";

var build = Function.bind.apply(Function, [null].concat(params.concat([bodyCode])));
var api = build()(
  DISASTERS,TOTEMS,TOTEM_ALL,V,MAP,R3,say,hashMatch,disKind,clamp,
  flashCenter,endBotLife,myId,others,meShielded,botShielded,hasRoof,
  wardenTick,dropPlan,ensureDropSlots,dropSpot,FS,function(){ return nowT; },
  DIS_WARN,DIS_GAP,DIS_FIRST,DIS_HOLD,
  DD_METEOR_R,DD_METEOR_DMG,DD_METEOR_WARN,DD_METEOR_GAP,
  DD_THUNDER_R,DD_THUNDER_DMG,DD_THUNDER_WARN,DD_THUNDER_GAP,
  DD_QUAKE_R,DD_QUAKE_DMG,DD_QUAKE_WARN,DD_QUAKE_GAP,
  DD_SHOCK_R,DD_SHOCK_DMG,DD_SHOCK_KNOCK,
  DD_TOXIC_R,DD_TOXIC_DMG,DD_TOXIC_ZONES,DD_TOXIC_CHIP_DMG,
  DD_SINK_R,DD_SINK_DMG,DD_SINK_PULL,
  DD_WIND_R,DD_WIND_PUSH,DD_WIND_DMG,
  DD_SAND_DMG,DD_ZERO_DMG,DD_EMP_DMG,
  DD_NEAR_R,DD_NEAR_MIN,
  DD_THUNDER_BLIND,DD_METEOR_BLIND,DD_SHOCK_BLIND,
  DD_QUAKE_SLOW,DD_TOXIC_SLOW,DD_SINK_SLOW,DD_WIND_SLOW,
  DD_SAND_SCATTER,DD_WIND_SCATTER,DD_EMP_SCATTER,DD_SLOW_MULT);

var out = {};
var T = nowT;

// ---- Q1. earthquake: mark damage + slow on a player standing under a mark ----
(function(){
  V.disasters = []; V.hp = 100; V.dead = false; V.slowUntil = 0;
  V.me.x = 0; V.me.z = 0; V.protUntil = 0;
  var D = api.disStart("earthquake", T);
  // force a mark right on the player
  D.marks = [{id: 1, x: 0, z: 0, hitAt: T + DIS_WARN + 0.1, r: DD_QUAKE_R, oh: false, dmg: DD_QUAKE_DMG, dis: "earthquake"}];
  D.hitAt = T + DIS_WARN + 100; // don't spawn more marks during the probe
  api.runDisasters(0.05, T + DIS_WARN + 0.15);
  out.q1 = {
    hpAfter: V.hp,
    dmgDealt: 100 - V.hp,
    slowFor: +(V.slowUntil - (T + DIS_WARN + 0.15)).toFixed(3),
    slowConst: DD_QUAKE_SLOW,
    markConst: DD_QUAKE_DMG,
    expectedMarkDmg: FS.markDamage(0, DD_QUAKE_R, DD_QUAKE_DMG),
    booms: V.booms.length
  };
})();

// ---- Q2. earthquake: a player AWAY from every mark takes nothing ----
(function(){
  V.disasters = []; V.hp = 100; V.dead = false; V.slowUntil = 0;
  V.me.x = 20; V.me.z = 18; V.protUntil = 0;
  var D = api.disStart("earthquake", T);
  D.marks = [{id: 2, x: -20, z: -18, hitAt: T + DIS_WARN + 0.1, r: DD_QUAKE_R, oh: false, dmg: DD_QUAKE_DMG, dis: "earthquake"}];
  D.hitAt = T + DIS_WARN + 100;
  api.runDisasters(0.05, T + DIS_WARN + 0.15);
  out.q2 = {hpAfter: V.hp, dmgDealt: 100 - V.hp, slowFor: +(V.slowUntil - (T + DIS_WARN + 0.15)).toFixed(3)};
})();

// ---- S1. sinkhole pit shape: what disStart stores vs what damage indexes ----
(function(){
  V.disasters = []; V.hp = 100; V.dead = false; V.slowUntil = 0;
  V.protUntil = 0;
  var D = api.disStart("sinkhole", T);
  var pit = D.pit;
  // the REAL damage line, copied from worldTick
  var sspot = (D.pit && D.pit.length === 2)
    ? D.pit
    : api.disSpot((Math.imul(D.seed|0, 2654435761) + 47) >>> 0, 5);
  out.s1 = {
    disStartPit: pit,
    pitLength: pit ? pit.length : null,
    damageUses: [sspot[0], sspot[1]],
    damageIndexesAs: "x,z",
    fxUses: pit ? [pit[0], pit[2]] : null,
    fxIndexesAs: "x,z (via pitSpot[0], pitSpot[2] when length!==2)",
    shapeMatch: pit && pit.length === 2
  };
})();

// ---- S2. sinkhole: player STANDING on the visible pit ----
(function(){
  V.disasters = []; V.hp = 100; V.dead = false; V.slowUntil = 0;
  V.protUntil = 0;
  var D = api.disStart("sinkhole", T);
  // stand on the FX pit: FX reads [pit[0], pit[2]] (or the disSpot fallback)
  var sspotFx = (D.pit && D.pit.length === 2) ? [D.pit[0], 0, D.pit[1]] : D.pit;
  V.me.x = sspotFx[0]; V.me.z = sspotFx[2];
  D.hitAt = T + DIS_WARN; // first pulse fires immediately
  var x0 = V.me.x, z0 = V.me.z;
  api.runDisasters(0.05, T + DIS_WARN + 0.05);
  out.s2 = {
    playerAt: [+V.me.x.toFixed(3), +V.me.z.toFixed(3)],
    fxPitAt: [+sspotFx[0].toFixed(3), +sspotFx[2].toFixed(3)],
    hpAfter: V.hp,
    dmgDealt: 100 - V.hp,
    slowFor: +(V.slowUntil - (T + DIS_WARN + 0.05)).toFixed(3),
    slowConst: DD_SINK_SLOW,
    pullMovedMe: +(Math.hypot(V.me.x - x0, V.me.z - z0)).toFixed(4),
    pitConst: DD_SINK_R
  };
})();

// ---- S3. sinkhole: player at (pit.x, 0) — the point the DAMAGE code thinks is the pit ----
(function(){
  V.disasters = []; V.hp = 100; V.dead = false; V.slowUntil = 0;
  V.protUntil = 0;
  var D = api.disStart("sinkhole", T);
  var sspot = (D.pit && D.pit.length === 2)
    ? D.pit
    : api.disSpot((Math.imul(D.seed|0, 2654435761) + 47) >>> 0, 5);
  V.me.x = sspot[0]; V.me.z = sspot[1];   // where DAMAGE thinks the pit is
  D.hitAt = T + DIS_WARN;
  api.runDisasters(0.05, T + DIS_WARN + 0.05);
  out.s3 = {
    playerAt: [+V.me.x.toFixed(3), +V.me.z.toFixed(3)],
    damagePitAt: [+sspot[0].toFixed(3), +sspot[1].toFixed(3)],
    hpAfter: V.hp,
    dmgDealt: 100 - V.hp
  };
})();

// ---- V1. visual: does fxStart build geometry for both kinds? ----
// (the fx* helpers close over THREE — here we only check the judge hands the FX
//  the frozen geometry and that R.disaster is called with it)
(function(){
  R3.events.length = 0;
  V.disasters = [];
  var Dq = api.disStart("earthquake", T);
  var Ds = api.disStart("sinkhole", T + 0.01);
  out.v1 = {
    quakeR3: R3.events.filter(function(e){ return e.kind === "earthquake" && e.on; }).length,
    sinkR3: R3.events.filter(function(e){ return e.kind === "sinkhole" && e.on; }).length,
    quakeSeed: Dq.seed,
    quakeZones: Dq.zones,
    sinkPit: Ds.pit,
    sinkSeed: Ds.seed
  };
})();

// ---- Q3. earthquake: the 3D mark ring is coloured differently from a meteor ----
(function(){
  // static read of the colour pick in fxTick — the user's "no visual" complaint
  var colLine = src.match(/color: \(Mk\.dis === "thunder"[\s\S]{0,120}/);
  out.q3 = {markColourPick: colLine ? colLine[0].replace(/\s+/g, " ").slice(0, 120) : "NOT FOUND"};
})();

console.log(JSON.stringify(out, null, 2));

// ---- verdicts ----
var fails = [];
if(out.q1.dmgDealt <= 0) fails.push("Q1 earthquake mark dealt " + out.q1.dmgDealt + " dmg");
if(out.q1.slowFor <= 0) fails.push("Q1 earthquake slow was " + out.q1.slowFor + "s");
if(out.q2.dmgDealt !== 0) fails.push("Q2 away-from-mark took " + out.q2.dmgDealt + " dmg");
if(!out.s1.shapeMatch) fails.push("S1 D.pit length is " + out.s1.pitLength + " (damage wants 2)");
if(out.s2.dmgDealt <= 0) fails.push("S2 player ON the visible pit took " + out.s2.dmgDealt + " dmg (expected ~" + DD_SINK_DMG + ")");
if(out.s2.slowFor <= 0) fails.push("S2 pit slow was " + out.s2.slowFor + "s");
if(out.v1.quakeR3 <= 0) fails.push("V1 R.disaster never fired for earthquake");
if(out.v1.sinkR3 <= 0) fails.push("V1 R.disaster never fired for sinkhole");

if(fails.length){
  console.log("\nFAIL:");
  fails.forEach(function(f){ console.log("  - " + f); });
  process.exitCode = 1;
} else {
  console.log("\nALL_OK");
}
