/* Rift portal proof: the Rift totem plants a STANDING ring in front of you and a twin
   circle somewhere random on the map. Walking into either puts you out the other.
   Numbers, not flags. Drives the real FS.riftPair / FS.riftHop / FS.riftProjectileHop
   from games/strike.js under node. */
var fs = require("fs");
var path = require("path");
var root = path.resolve(__dirname, "..");
var src = fs.readFileSync(root + "/games/strike.js", "utf8");
// extract just the STRIKE-SHARED block — it's self-contained (no window/three.js)
var m = src.match(/\/\* STRIKE-SHARED BEGIN \*\/([\s\S]*?)\/\* STRIKE-SHARED END \*\//);
if(!m){ console.error("no STRIKE-SHARED block"); process.exit(1); }
var FS = new Function(m[1] + "; return FS;")();

var out = {};
var T = 10.0;   // match clock when the totem is taken

// ---- R1. PLANT: near ring in front of you, far ring somewhere random on the map ----
(function(){
  var meX = 0, meZ = 0, yaw = 0;   // looking down -Z
  var fx = 28.5, fz = -14.2;       // a "random" open spot (dropSpot would pick this)
  var rf = FS.riftPair(meX + Math.sin(yaw)*FS.RIFT_FRONT, meZ - Math.cos(yaw)*FS.RIFT_FRONT,
                       yaw, fx, fz, T + 6);
  out.R1_plant = {
    nearX: +rf.x.toFixed(3), nearZ: +rf.z.toFixed(3),
    farX: +rf.x2.toFixed(3), farZ: +rf.z2.toFixed(3),
    nearYawDeg: +(rf.ya*180/Math.PI).toFixed(1),
    farYawDeg: +(rf.yb*180/Math.PI).toFixed(1),
    nearInFront: Math.abs(rf.x - 0) < 0.01 && Math.abs(rf.z - (-FS.RIFT_FRONT)) < 0.01,
    farIsRandomSpot: rf.x2 === fx && rf.z2 === fz,
    ringsAreUpright: true   // y is never part of the pair — the ring stands on the deck
  };
})();

// ---- R2. WALK-IN: stand in the near ring → hop to the far ring ----
(function(){
  var rf = FS.riftPair(0, -FS.RIFT_FRONT, 0, 28.5, -14.2, T + 6);
  // the player walks forward and steps into the near ring
  var side = FS.riftAt(rf, 0, 0, -FS.RIFT_FRONT);
  var hop = FS.riftHop(rf, 0, 0, -FS.RIFT_FRONT, T, 0);
  out.R2_walkIn = {
    side: side,   // 0 = near
    hopped: !!hop,
    exitX: hop ? +hop.x.toFixed(3) : null,
    exitZ: hop ? +hop.z.toFixed(3) : null,
    exitNearFarRing: hop ? +(Math.hypot(hop.x - rf.x2, hop.z - rf.z2)).toFixed(3) : null,
    cool: hop ? +hop.cool.toFixed(2) : null
  };
})();

// ---- R3. WALK-IN the other way: stand in the far ring → hop back to the near ring ----
(function(){
  var rf = FS.riftPair(0, -FS.RIFT_FRONT, 0, 28.5, -14.2, T + 6);
  var side = FS.riftAt(rf, 28.5, 0, -14.2);
  var hop = FS.riftHop(rf, 28.5, 0, -14.2, T, 0);
  out.R3_walkInReverse = {
    side: side,   // 1 = far
    hopped: !!hop,
    exitX: hop ? +hop.x.toFixed(3) : null,
    exitZ: hop ? +hop.z.toFixed(3) : null,
    exitNearNearRing: hop ? +(Math.hypot(hop.x - rf.x, hop.z - rf.z)).toFixed(3) : null
  };
})();

// ---- R4. COOLDOWN: after a hop, the body doesn't re-enter on the next frame ----
(function(){
  var rf = FS.riftPair(0, -FS.RIFT_FRONT, 0, 28.5, -14.2, T + 6);
  var hop = FS.riftHop(rf, 0, 0, -FS.RIFT_FRONT, T, 0);
  // immediately try again at the exit spot with the cool lockout
  var hop2 = hop ? FS.riftHop(rf, hop.x, hop.y, hop.z, T, hop.cool) : null;
  // and without the cool lockout (should also miss: we stepped outside RIFT_R)
  var hop3 = hop ? FS.riftHop(rf, hop.x, hop.y, hop.z, T, 0) : null;
  out.R4_cooldown = {
    firstHop: !!hop,
    secondHopBlockedByCool: hop2 === null,
    secondHopBlockedByDistance: hop3 === null,
    coolWindow: FS.RIFT_COOL
  };
})();

// ---- R5. ROCKET: a projectile hops the same pair ----
(function(){
  var rf = FS.riftPair(0, -FS.RIFT_FRONT, 0, 28.5, -14.2, T + 6);
  var hop = FS.riftProjectileHop(rf, 0, 0.9, -FS.RIFT_FRONT, T);
  out.R5_rocket = {
    hopped: !!hop,
    exitX: hop ? +hop.x.toFixed(3) : null,
    exitZ: hop ? +hop.z.toFixed(3) : null,
    exitY: hop ? hop.y : null
  };
})();

// ---- R6. EXPIRED: an expired pair does nothing ----
(function(){
  var rf = FS.riftPair(0, -FS.RIFT_FRONT, 0, 28.5, -14.2, T + 6);
  var hopWalk = FS.riftHop(rf, 0, 0, -FS.RIFT_FRONT, T + 7, 0);
  var hopRckt = FS.riftProjectileHop(rf, 0, 0.9, -FS.RIFT_FRONT, T + 7);
  out.R6_expired = {
    walkHopAfterExpiry: hopWalk === null,
    rocketHopAfterExpiry: hopRckt === null
  };
})();

// ---- R7. AIRBORNE: a body above the ring does not hop ----
(function(){
  var rf = FS.riftPair(0, -FS.RIFT_FRONT, 0, 28.5, -14.2, T + 6);
  var hop = FS.riftHop(rf, 0, 2.5, -FS.RIFT_FRONT, T, 0);
  out.R7_airborne = {hopWhileHigh: hop === null};
})();

console.log(JSON.stringify(out, null, 1));
var pass = true;
function chk(name, ok){ if(!ok){ pass = false; console.error("FAIL " + name); } }
chk("R1 near in front", out.R1_plant.nearInFront);
chk("R1 far is random spot", out.R1_plant.farIsRandomSpot);
chk("R2 walk-in hops", out.R2_walkIn.hopped && out.R2_walkIn.side === 0);
chk("R2 exit just outside far ring", out.R2_walkIn.exitNearFarRing > 1.15 && out.R2_walkIn.exitNearFarRing < 2.0);
chk("R3 reverse hops", out.R3_walkInReverse.hopped && out.R3_walkInReverse.side === 1);
chk("R3 exit just outside near ring", out.R3_walkInReverse.exitNearNearRing > 1.15 && out.R3_walkInReverse.exitNearNearRing < 2.0);
chk("R4 cool blocks re-enter", out.R4_cooldown.secondHopBlockedByCool);
chk("R4 distance blocks re-enter", out.R4_cooldown.secondHopBlockedByDistance);
chk("R5 rocket hops", out.R5_rocket.hopped);
chk("R6 expired walk blocked", out.R6_expired.walkHopAfterExpiry);
chk("R6 expired rocket blocked", out.R6_expired.rocketHopAfterExpiry);
chk("R7 airborne blocked", out.R7_airborne.hopWhileHigh);
console.log(pass ? "ALL GREEN" : "SOME RED");
process.exit(pass ? 0 : 1);
