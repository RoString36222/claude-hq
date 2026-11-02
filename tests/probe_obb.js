/* Oriented-lot solids: a v2 building's facade is a rotated box. The air path
   used to collide only with the axis-aligned lot rect, so the rotated corners
   stuck out with no solid and a swing sailed through them. Prove:
   (a) an OBB corner that sits outside buildingRect is still blocked by bodyBlock
       when the solid carries `obb`;
   (b) empty air in the fat AABB corner (outside the OBB) is NOT blocked. */
var fs = require("fs");
var path = require("path");
var root = path.resolve(__dirname, "..");
global.window = {HQV: {}};
new Function(fs.readFileSync(root + "/games/skystrike.js", "utf8"))();
var P = window.HQV.skystrike.pure;

// Square footprint centred at origin, rotated 45° (F = east), hu=hv=5
// OBB corners sit at ~7.07 m on the axes — outside an axis-aligned 5x5 rect.
var F = {x: 1, z: 0}, hu = 5, hv = 5;
var ex = Math.abs(F.z)*hu + Math.abs(F.x)*hv; // 5
var ez = Math.abs(F.x)*hu + Math.abs(F.z)*hv; // 5
// Wait: F=(1,0) means door faces +x; local u = across = (0,-1)? 
// world: abs(dx*F.z - dz*F.x) <= hu  => abs(-dz) <= hu => |z|<=5
//        abs(dx*F.x + dz*F.z) <= hv  => abs(dx) <= hv => |x|<=5
// That's axis-aligned. Use F at 45°.
F = {x: Math.SQRT1_2, z: Math.SQRT1_2};
ex = Math.abs(F.z)*hu + Math.abs(F.x)*hv; // ~7.07
ez = Math.abs(F.x)*hu + Math.abs(F.z)*hv; // ~7.07
var aabb = {id: "obb", min: {x: -ex, y: 0, z: -ez}, max: {x: ex, y: 40, z: ez},
            obb: {ox: 0, oz: 0, fx: F.x, fz: F.z, hu: hu, hv: hv}};
// old (broken) solid: only the inset axis-aligned rect that missed the corners
var oldRect = {id: "old", min: {x: -5, y: 0, z: -5}, max: {x: 5, y: 40, z: 5}};

// A corner of the rotated square: along F diagonal, at distance hu*sqrt(2) from centre
// For 45° square, a corner in world is at (0, ±hu*√2) or (±hu*√2, 0) approximately.
// Local (u,v)=(hu,hv)=(5,5) -> world:
// u axis = (F.z, -F.x) = (√2/2, -√2/2), v axis = (F.x, F.z) = (√2/2, √2/2)
// corner = o + u*hu_dir + v*hv_dir = 5*(u_hat + v_hat) = 5*(√2, 0) = (5√2, 0) ≈ (7.07, 0)
var corner = {x: 5*Math.SQRT2, y: 20, z: 0}; // on the OBB corner, OUTSIDE oldRect

function diveAt(boxes, from, to){
  return P.bodyBlock(from, {x: to.x, y: to.y, z: to.z, vx: to.x-from.x, vy: 0, vz: to.z-from.z}, boxes, 0.42);
}

var from = {x: 12, y: 20, z: 0};
var out = {};

// (a) with OBB: dive into the corner — must stop before entering
var hitObb = diveAt([aabb], from, {x: 0, y: 20, z: 0});
out.obbStopsCorner = hitObb.x > corner.x - 1.0 && hitObb.wall === 1 && hitObb.x < 12;
out.obbHitX = +hitObb.x.toFixed(3);
out.obbNx = hitObb.nx; out.obbNz = hitObb.nz;

// (a2) old rect alone: the same dive sails past the corner into the centre
var hitOld = diveAt([oldRect], from, {x: 0, y: 20, z: 0});
out.oldMissesCorner = hitOld.x < 6; // stopped at oldRect face x=5, AFTER passing visual corner at 7.07
out.oldHitX = +hitOld.x.toFixed(3);

// (b) empty air in fat AABB corner, outside OBB: e.g. (7, 7) is in AABB (|x|,|z|<7.07)
// but outside OBB (local |u| or |v| > 5)
// Point (6.5, 6.5): u = 6.5*√2/2 - 6.5*(-√2/2) wait
// u = dx*fz - dz*fx = 6.5*√2/2 - 6.5*√2/2 = 0
// v = dx*fx + dz*fz = 6.5*√2/2 + 6.5*√2/2 = 6.5*√2 ≈ 9.2 > hv=5 → outside OBB
// And |6.5| < 7.07 → inside fat AABB
var emptyFrom = {x: 9, y: 20, z: 9};
var emptyTo = {x: 6.5, y: 20, z: 6.5};
var hitEmpty = diveAt([aabb], emptyFrom, emptyTo);
out.emptyAirFree = Math.abs(hitEmpty.x - 6.5) < 0.05 && Math.abs(hitEmpty.z - 6.5) < 0.05 && !hitEmpty.wall;
out.emptyHit = {x: +hitEmpty.x.toFixed(3), z: +hitEmpty.z.toFixed(3), wall: hitEmpty.wall};

// (c) centre of OBB: must push out
var mid = P.bodyBlock({x: 0.1, y: 20, z: 0.1}, {x: 0.1, y: 20, z: 0.1, vx: 0, vy: 0, vz: 0}, [aabb], 0.42);
var midR = Math.sqrt(mid.x*mid.x + mid.z*mid.z);
out.insidePushedOut = midR > 4.5;
out.insideAt = {x: +mid.x.toFixed(3), z: +mid.z.toFixed(3), r: +midR.toFixed(3)};

process.stdout.write(JSON.stringify(out, null, 2));
if(!(out.obbStopsCorner && out.oldMissesCorner && out.emptyAirFree && out.insidePushedOut)){
  process.exitCode = 1;
}
