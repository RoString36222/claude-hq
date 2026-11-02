/* Live-path proof for 3.38.1: a shot-down drone drops 3 non-disaster totems at the
   wreck, detaches anyone swinging on that hull, and starts a random disaster; and
   disasters STACK (a new one never stops the old) with a log of what is happening.
   Numbers, not flags. Drives the REAL function bodies sliced out of games/strike.js.
   Run: node tests/probe_drone_disaster.js */
var fs = require("fs");
var path = require("path");
var root = path.resolve(__dirname, "..");
var src = fs.readFileSync(root + "/games/strike.js", "utf8");

// ---- slice a real `function name(...) { ... }` out of the file ----
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
function sliceVar(name){
  var i = src.indexOf("var " + name + " =");
  if(i < 0) throw new Error("missing var " + name);
  var j = src.indexOf(";", i);
  return src.slice(i, j + 1);
}

// ---- the sandbox the real bodies run in ----
var log = [];
var DISASTERS = ["sandstorm", "meteorshower", "hurricane", "thunder", "earthquake",
                 "shockring", "toxicfog", "absolutezero", "sinkhole", "emp"];
var TOTEM_ALL = ["mole","freeze","decoy","cloak","shield","wings","leap","speed","teleport",
                 "rift","mirror","gravflip","rewind","shock","magnet","chain","trap","mark","blink","bubble",
                 "wallrun","secondwind","fakedeath","ghost","cluster","overclock","ricochet","infchamber",
                 "bodyswap","rally","meteor","chaos","phoenix","pocket","fate","king","radarjam"];
var TOTEMS = {};
TOTEM_ALL.concat(DISASTERS).forEach(function(k){ TOTEMS[k] = {n: k}; });

var V = {
  disasters: [], disasterLog: [], disasterAt: 0,
  hookDrone: null, swingUntil: 0, hookTo: null, swingY: 0,
  me: {g: false, vy: 0, x: 0, y: 0, z: 0},
  dead: false, voidAt: 0,
  cursed: {}, items: {}
};
var MAP = {
  bounds: function(){ return [-30, 0, -30, 30, 0, 30]; },
  pickups: []
};
var R3 = {
  added: [],
  addTotem: function(idx, p){ this.added.push({idx: idx, kind: p.kind, at: p.at}); },
  ring: function(){ }, boom: function(){ }
};
function say(m){ log.push(m); }
function hashMatch(seed, salt){ var x = (seed ^ (salt*0x9e3779b9))|0; return ((x >>> 0) / 4294967295); }
function disKind(seed, salt, n){
  var nn = n || 1;
  var x = (Math.imul(seed, 0x9e3779b9) ^ Math.imul(salt, 0x85ebca6b)) | 0;
  x ^= x >>> 15;
  return (x >>> 0) % nn;
}
function disSpot(){ return [0, 0, 0]; }
function disZonesNear(){ return []; }
function liveSpots(){ return []; }
function dropPlan(){ return {totems: [0, 0, 0], packs: [0, 0], dis: [0, 0]}; }
function ensureDropSlots(){}
var totemCount = 0;
var DROP_SLOTS = 3, PACK_SLOTS = 2;
var DIS_WARN = 2.0, DIS_HOLD = {sandstorm: 12, meteorshower: 10, hurricane: 10, thunder: 8,
  earthquake: 8, shockring: 5, toxicfog: 12, absolutezero: 10, sinkhole: 8, emp: 5};
var DD_TOXIC_ZONES = 3;
var DD_SAND_SCATTER = 1.2, DD_WIND_SCATTER = 2.4, DD_EMP_SCATTER = 1.0;
function flashCenter(){}
var FS = {overlaps: function(){ return -1; }, targetAt: function(){ return [0, 7.5, 0]; },
          DRONE_PHASE: 1.3, RIFT_FRONT: 4};
var nowT = 100;

// the bodies under test — pulled from the file, not retyped
var body = [
  "var disLogK = 0;",
  sliceVar("DRONE_DOWN_SECS"),
  sliceFn("nonDisTotems"),
  sliceFn("droneTotemDrop"),
  sliceFn("droneDetach"),
  sliceFn("droneShootDown"),
  sliceFn("disStart"),
  sliceFn("disLog"),
  sliceFn("disClear"),
  sliceFn("disLive"),
  sliceFn("disKindLive"),
  sliceFn("disAimScatter"),
  "return {disasters: V.disasters, disStart: disStart, disClear: disClear, disLive: disLive,",
  "        disKindLive: disKindLive, disAimScatter: disAimScatter, disLog: disLog,",
  "        droneShootDown: droneShootDown, droneDetach: droneDetach, droneTotemDrop: droneTotemDrop,",
  "        nonDisTotems: nonDisTotems, V: V, sayLog: sayLog, R3: R3, DRONE_DOWN_SECS: DRONE_DOWN_SECS,",
  "        DRONE_TOTEMS: DRONE_TOTEMS};"
].join("\n");

var api = new Function(
  "DISASTERS","TOTEMS","TOTEM_ALL","V","MAP","R3","say","sayLog","hashMatch","disKind","disSpot",
  "disZonesNear","liveSpots","dropPlan","ensureDropSlots","DROP_SLOTS","PACK_SLOTS","FS",
  "DIS_WARN","DIS_HOLD","DD_TOXIC_ZONES","DD_SAND_SCATTER","DD_WIND_SCATTER","DD_EMP_SCATTER",
  "flashCenter","worldK",
  "var totemCount = 0;\n" + body
)(DISASTERS,TOTEMS,TOTEM_ALL,V,MAP,R3,say,log,hashMatch,disKind,disSpot,disZonesNear,liveSpots,
  dropPlan,ensureDropSlots,DROP_SLOTS,PACK_SLOTS,FS,
  DIS_WARN,DIS_HOLD,DD_TOXIC_ZONES,DD_SAND_SCATTER,DD_WIND_SCATTER,DD_EMP_SCATTER,
  flashCenter,0);

var out = {};
var T = nowT;

// ---- D1. shoot-down drops exactly 3 NON-disaster totems at the wreck ----
(function(){
  V.mdrones = null;
  var D = {i: 3, downUntil: 0};
  R3.added.length = 0;
  var wx = 12.0, wz = -7.5;
  var before = V.disasters.length;
  api.droneShootDown(D, [wx, 8.2, wz], T);
  out.D1_wreck = {
    downForSecs: +((D.downUntil - T)).toFixed(2),
    expect: api.DRONE_DOWN_SECS,
    deadX: D.deadX, deadZ: D.deadZ,
    totemsDropped: R3.added.length,
    expectTotems: api.DRONE_TOTEMS,
    kinds: R3.added.map(function(a){ return a.kind; }),
    anyDisasterKind: R3.added.some(function(a){ return DISASTERS.indexOf(a.kind) >= 0; }),
    allOnTheWreck: R3.added.every(function(a){
      return Math.hypot(a.at[0] - wx, a.at[2] - wz) <= 3.3;
    }),
    maxRadiusFromWreck: +Math.max.apply(null, R3.added.map(function(a){
      return Math.hypot(a.at[0] - wx, a.at[2] - wz);
    })).toFixed(2),
    disastersBefore: before,
    disastersAfter: V.disasters.length,
    oneDisasterAdded: V.disasters.length === before + 1,
    addedKind: V.disasters.length ? V.disasters[V.disasters.length - 1].kind : null,
    said: log.slice()
  };
})();

// ---- D2. a swinger on that hull is detached and dropped to the ground ----
(function(){
  var D = {i: 5, downUntil: 0};
  V.hookDrone = D;
  V.swingUntil = T + 2.5;
  V.hookTo = [1, 7, 2];
  V.swingY = 7.5;
  V.me.g = false; V.me.vy = 3.2; V.dead = false; V.voidAt = T;
  api.droneShootDown(D, [0, 8, 0], T);
  out.D2_detach = {
    swingUntilAfter: V.swingUntil,
    hookToAfter: V.hookTo,
    hookDroneAfter: V.hookDrone,
    swingYAfter: V.swingY,
    grounded: V.me.g === true,
    vyCleared: V.me.vy === 0,
    voidCleared: V.voidAt === 0,
    asIfNoDrone: V.swingUntil === 0 && V.hookTo === null && V.hookDrone === null
                 && V.swingY === 0 && V.me.g === true && V.me.vy === 0
  };
})();

// ---- D3. a shooter NOT on that hull is left alone ----
(function(){
  var D = {i: 7, downUntil: 0};
  var other = {i: 8, downUntil: 0};
  V.hookDrone = other; V.swingUntil = T + 2.5; V.hookTo = [1, 7, 2]; V.swingY = 7.5;
  api.droneShootDown(D, [0, 8, 0], T);
  out.D3_otherHullUntouched = {
    stillSwinging: V.swingUntil > T,
    stillHooked: V.hookDrone === other,
    swingY: V.swingY
  };
})();

// ---- D4. disasters STACK: a new one never stops the old ----
(function(){
  V.disasters.length = 0; V.disasterLog.length = 0; log.length = 0;
  api.disStart("sandstorm", T);
  var k1 = V.disasters.map(function(d){ return d.kind; });
  api.disStart("thunder", T + 1);
  var k2 = V.disasters.map(function(d){ return d.kind; });
  api.disStart("emp", T + 2);
  var k3 = V.disasters.map(function(d){ return d.kind; });
  // the cap is 6 — start 5 more, the oldest is shed
  ["hurricane","toxicfog","sinkhole","absolutezero","shockring"].forEach(function(k, i){
    api.disStart(k, T + 3 + i);
  });
  var k4 = V.disasters.map(function(d){ return d.kind; });
  out.D4_stack = {
    after1: k1, after2: k2, after3: k3,
    grewTo3: k3.length === 3,
    sandstormStillThere: k3.indexOf("sandstorm") >= 0,
    thunderStillThere: k3.indexOf("thunder") >= 0,
    empStillThere: k3.indexOf("emp") >= 0,
    cappedAt: k4.length,
    capIs6: k4.length === 6,
    oldestShed: k4.indexOf("sandstorm") < 0,
    newestKept: k4.indexOf("shockring") >= 0
  };
})();

// ---- D5. the log names what is happening ----
(function(){
  V.disasters.length = 0; V.disasterLog.length = 0;
  api.disStart("sandstorm", T);
  api.disStart("thunder", T + 1);
  var msgs = V.disasterLog.map(function(e){ return e.msg; });
  api.disClear(T + 2, "sandstorm");
  var after = V.disasterLog.map(function(e){ return e.msg; });
  out.D5_log = {
    entriesAfter2Starts: msgs.length,
    namesSandstorm: msgs.some(function(m){ return /sandstorm/i.test(m); }),
    namesThunder: msgs.some(function(m){ return /thunder/i.test(m); }),
    afterOneClear: after.length,
    saysOver: after[after.length - 1],
    logCappedAt8: V.disasterLog.length <= 8,
    clearedOnlyThatKind: V.disasters.map(function(d){ return d.kind; })
  };
})();

// ---- D6. disKindLive / disAimScatter see EVERY live one ----
(function(){
  V.disasters.length = 0;
  api.disStart("sandstorm", T);          // warn 2 s, hold 12 s
  api.disStart("emp", T);
  var tLive = T + 2.5;                    // past the warn
  out.D6_liveAndScatter = {
    sandstormLive: api.disKindLive(tLive, "sandstorm"),
    empLive: api.disKindLive(tLive, "emp"),
    thunderNotLive: !api.disKindLive(tLive, "thunder"),
    scatterSeesBoth: api.disAimScatter(tLive),
    // sandstorm 1.2, emp 1.0 → the max is 1.2
    maxScatter: +api.disAimScatter(tLive).toFixed(2),
    beforeWarnIsNotLive: !api.disKindLive(T + 0.5, "sandstorm")
  };
})();

// ---- D7. a second shoot-down ADDS a disaster rather than replacing ----
(function(){
  V.disasters.length = 0; V.disasterLog.length = 0;
  api.disStart("sandstorm", T);
  var D = {i: 1, downUntil: 0};
  api.droneShootDown(D, [5, 8, 5], T + 1);
  out.D7_shootDownAdds = {
    count: V.disasters.length,
    sandstormStillLive: V.disasters.some(function(d){ return d.kind === "sandstorm"; }),
    oneMore: V.disasters.length === 2
  };
})();

// ---- D8. the totem roster never includes a disaster kind ----
(function(){
  var ALL = api.nonDisTotems();
  out.D8_roster = {
    n: ALL.length,
    expect: 45,   // personal roster only — never a disaster kind (37 + bighead + disco + Wave F six)
    anyDisaster: ALL.some(function(k){ return DISASTERS.indexOf(k) >= 0; }),
    allInPersonalSet: ALL.every(function(k){ return TOTEM_ALL.indexOf(k) >= 0; })
  };
})();

console.log(JSON.stringify(out, null, 2));
var ok = true;
function need(c, m){ if(!c){ ok = false; console.error("FAIL " + m); } }
need(out.D1_wreck.downForSecs === 6, "D1 down for 6 s");
need(out.D1_wreck.totemsDropped === 3, "D1 exactly 3 totems");
need(!out.D1_wreck.anyDisasterKind, "D1 no disaster kind");
need(out.D1_wreck.allOnTheWreck, "D1 totems on the wreck");
need(out.D1_wreck.oneDisasterAdded, "D1 one disaster added");
need(out.D2_detach.asIfNoDrone, "D2 swinger detached to the ground");
need(out.D3_otherHullUntouched.stillSwinging, "D3 other hull untouched");
need(out.D4_stack.grewTo3 && out.D4_stack.sandstormStillThere, "D4 disasters stack");
need(out.D4_stack.capIs6, "D4 cap at 6");
need(out.D5_log.namesSandstorm && out.D5_log.namesThunder, "D5 log names them");
need(out.D6_liveAndScatter.sandstormLive && out.D6_liveAndScatter.empLive, "D6 both live");
need(out.D6_liveAndScatter.maxScatter === 1.2, "D6 max scatter 1.2");
need(out.D7_shootDownAdds.oneMore, "D7 shoot-down adds");
need(out.D8_roster.n === 45 && !out.D8_roster.anyDisaster, "D8 roster clean");
console.log(ok ? "ALL_OK" : "HAD_FAILURES");
process.exit(ok ? 0 : 1);
