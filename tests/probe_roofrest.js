/* Roof-rest proof: a body that tops out onto a tower roof must STAND there,
   not hover in the dive silhouette. The city's groundY is street level, so
   `st.y <= gy` never fires at y=34 — the old check left every roof a "fall".
   Numbers, not flags. */
var fs = require("fs");
var path = require("path");
var root = path.resolve(__dirname, "..");
global.window = {HQV: {}};
new Function(fs.readFileSync(root + "/games/skystrike.js", "utf8"))();
var P = window.HQV.skystrike.pure;

var out = {};
var DT = 1/60;

function newSt(x, y, z, yaw, extra){
  var st = {x: x, y: y, z: z, vx: 0, vy: 0, vz: 0, yaw: yaw, jumps: 0,
            webSide: 1, t: 0, spaceWas: false, shiftWas: false};
  if(extra) for(var k in extra) st[k] = extra[k];
  return st;
}
function makeEnv(keys, heading, solidsFn){
  var fwd = (keys.KeyW ? 1 : 0) - (keys.KeyS ? 1 : 0);
  var side = (keys.KeyA ? 1 : 0) - (keys.KeyD ? 1 : 0);
  return {
    space: !!keys.Space, shift: !!(keys.ShiftLeft || keys.ShiftRight),
    w: !!keys.KeyW, fwd: fwd, side: side, heading: heading, calm: false,
    groundY: function(){ return 0; },
    blocked: function(){ return false; },
    solids: solidsFn, anchor: null
  };
}

// ---- R1. STAND ON A ROOF: body resting at the crest, no keys ----
(function(){
  var storey = {id: "storey", min: {x: -3.5, y: 0, z: -10.5}, max: {x: 3.5, y: 34, z: 10.5}};
  function solidsFn(){ return [storey]; }
  var st = newSt(-2.0, 34.02, 0, Math.PI/2);
  var modes = [], flips = 0, prev = null;
  for(var i = 0; i < 120; i++){
    var r = P.airFrame(st, makeEnv({}, Math.PI/2, solidsFn), DT);
    if(prev && prev !== r.mode) flips++;
    prev = r.mode;
    if(i < 6 || i % 20 === 0) modes.push({i: i, mode: r.mode, y: +st.y.toFixed(3), vy: +st.vy.toFixed(3)});
  }
  out.R1_standOnRoof = {
    finalMode: prev, flips: flips,
    finalY: +st.y.toFixed(3), expectedTop: 34.0,
    onRoof: Math.abs(st.y - 34) < 0.2,
    modes: modes
  };
})();

// ---- R2. CREST WALK-OFF: climb a 20 m tower and walk off the top ----
(function(){
  var storey = {id: "storey", min: {x: -3.5, y: 0, z: -10.5}, max: {x: 3.5, y: 20, z: 10.5}};
  function solidsFn(){ return [storey]; }
  var st = newSt(-4.2, 0, 0, Math.PI/2);
  var modes = [], flips = 0, prev = null, mounts = 0, inside = 0;
  for(var i = 0; i < 240; i++){
    var r = P.airFrame(st, makeEnv({KeyW: true}, Math.PI/2, solidsFn), DT);
    if(prev && prev !== r.mode) flips++;
    prev = r.mode;
    if(st._ledgeY != null && Math.abs(st._ledgeY - 20) < 0.5) mounts++;
    if(st.x >= storey.min.x && st.x <= storey.max.x && st.y < storey.max.y - 0.2 &&
       st.z >= storey.min.z && st.z <= storey.max.z) inside++;
    if(i < 8 || i % 30 === 0) modes.push({i: i, mode: r.mode, x: +st.x.toFixed(2), y: +st.y.toFixed(2), wall: !!st.wall});
  }
  out.R2_crestWalkOff = {
    finalMode: prev, flips: flips, mounts: mounts, inside: inside,
    finalY: +st.y.toFixed(2), finalX: +st.x.toFixed(2),
    finalWall: !!st.wall,
    modes: modes.slice(0, 12)
  };
})();

// ---- R3. SEAM: podium 0..6 + storey 0..34, climb the seam then the crest ----
(function(){
  var storey = {id: "storey", min: {x: -3.5, y: 0, z: -10.5}, max: {x: 3.5, y: 34, z: 10.5}};
  var podium = {id: "podium", min: {x: -5.5, y: 0, z: -13.5}, max: {x: 5.5, y: 6, z: 13.5}};
  function solidsFn(){ return [storey, podium]; }
  var st = newSt(-6.2, 0, 0, Math.PI/2);
  var modes = [], flips = 0, prev = null, mounts = 0, inside = 0;
  for(var i = 0; i < 420; i++){
    var r = P.airFrame(st, makeEnv({KeyW: true}, Math.PI/2, solidsFn), DT);
    if(prev && prev !== r.mode) flips++;
    prev = r.mode;
    if(st._ledgeY != null) mounts++;
    if(st.x >= storey.min.x && st.x <= storey.max.x && st.y < storey.max.y - 0.2 &&
       st.z >= storey.min.z && st.z <= storey.max.z) inside++;
    if(i < 8 || i % 40 === 0) modes.push({i: i, mode: r.mode, x: +st.x.toFixed(2), y: +st.y.toFixed(2), wall: !!st.wall});
  }
  out.R3_seamPodium = {
    finalMode: prev, flips: flips, mounts: mounts, inside: inside,
    finalY: +st.y.toFixed(2), finalX: +st.x.toFixed(2),
    finalWall: !!st.wall,
    modes: modes.slice(0, 14)
  };
})();

// ---- R4. roofRest pure helper: true on a roof top, false in the air ----
(function(){
  var storey = {id: "storey", min: {x: -3.5, y: 0, z: -10.5}, max: {x: 3.5, y: 34, z: 10.5}};
  function solidsFn(x, y, z){
    if(x >= storey.min.x - 1 && x <= storey.max.x + 1 &&
       z >= storey.min.z - 1 && z <= storey.max.z + 1) return [storey];
    return [];
  }
  var env = {solids: solidsFn};
  out.R4_roofRestPure = {
    onRoof: P.roofRest({x: 0, y: 34.02, z: 0, vy: 0}, env),
    aboveRoof: P.roofRest({x: 0, y: 40, z: 0, vy: 0}, env),
    besideRoof: P.roofRest({x: 10, y: 34.02, z: 0, vy: 0}, env),
    rising: P.roofRest({x: 0, y: 34.02, z: 0, vy: 2.0}, env),
    onStreet: P.roofRest({x: 0, y: 0, z: 0, vy: 0}, env)
  };
})();

process.stdout.write(JSON.stringify(out, null, 2));
