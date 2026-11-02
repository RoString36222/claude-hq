/* Step 1 of the frame analysis above: reproduce the two screenshots against a
   REAL stepped tower instead of the 24x24 test slab. The test tower is one box;
   the city stacks a storey + a podium + windows exactly near the tower's faces
   (span 110% full-width). Two live bugs live where the test world could not see
   them:

   (a) THROUGH THE BUILDING: the collision lookup near the tower's faces returns
       pane AABBs too, so bodyBlock can pick a window's paper-thin height instead
       of the storey, and pushOut may never see the overlapping mass.

   (b) FLOATING WHILE CLIMBING: the grip's face-pull reads CENTRE-to-FACE and
       holds gap=RAD, so the visible body can hang off the face while the centre
       is at 0.42 m contact; and a grip that releases to fall shows the pre-wall
       dive (the silhouette) for several frames while fallT ramps back up.

   Prints world numbers against the tower's boxes, not flags. */
var fs = require("fs");
var path = require("path");
var root = path.resolve(__dirname, "..");
global.window = {HQV: {}};
new Function(fs.readFileSync(root + "/games/skystrike.js", "utf8"))();
var P = window.HQV.skystrike.pure;

var out = {};
var DT = 1/60;

// ---- the stepped tower the screenshots actually have ----
// storey: 7x21 footprint, y 0..34  (the glass body)
// podium: wider, y 0..6            (the wider base)
// windows: the beige panes, stacked near the tower's walls
var storey = {id: "storey", min: {x: -3.5, y: 0, z: -10.5}, max: {x: 3.5, y: 34, z: 10.5}};
var podium = {id: "podium", min: {x: -5.5, y: 0, z: -13.5}, max: {x: 5.5, y: 6, z: 13.5}};
function windowsFor(box, i0){
  // mimic hqspectacle: spans = 110% of the box's width, exactly near its faces,
  // as THIN panes the collision lookup may return first
  var panes = [], wi = i0 || 0, face;
  for(face = 0; face < 4; face++){
    for(var row = 0; row < 4; row++){
      var y0 = box.min.y + 4 + row*7, y1 = y0 + 4.2;
      if(face === 0) panes.push({id: "win:"+(wi++), min: {x: box.min.x - 0.05, y: y0, z: box.min.z - 0.5}, max: {x: box.min.x + 0.05, y: y1, z: box.max.z + 0.5}});
      if(face === 1) panes.push({id: "win:"+(wi++), min: {x: box.max.x - 0.05, y: y0, z: box.min.z - 0.5}, max: {x: box.max.x + 0.05, y: y1, z: box.max.z + 0.5}});
      if(face === 2) panes.push({id: "win:"+(wi++), min: {x: box.min.x - 0.5, y: y0, z: box.min.z - 0.05}, max: {x: box.max.x + 0.5, y: y1, z: box.min.z + 0.05}});
      if(face === 3) panes.push({id: "win:"+(wi++), min: {x: box.min.x - 0.5, y: y0, z: box.max.z - 0.05}, max: {x: box.max.x + 0.5, y: y1, z: box.max.z + 0.05}});
    }
  }
  return panes;
}
var panes = windowsFor(storey, 0).concat(windowsFor(podium, 100));

// generous span: every query returns everything near a face (the 110% clue)
function solidsGenerous(x, y, z){ return [storey, podium].concat(panes); }
// strict span: buildingsIn/merged grid returns ONLY the boxes the touched tiles share
function insideStrict(x, y, z, box){
  // a pane or tower is returned only when the query point is within the boxes the
  // tile actually merges — near the tower face the tile carries only the pane row,
  // NOT the storey behind it
  var inStorey = x > storey.min.x - 40 && x < storey.max.x + 40 && z > storey.min.z - 40 && z < storey.max.z + 40;
  // strict: the storey is NOT returned 1 m off its face (tile clipping); the pane row is
  if(Math.min(Math.abs(x - storey.min.x), Math.abs(x - storey.max.x),
              Math.abs(z - storey.min.z), Math.abs(z - storey.max.z)) > 0.9) inStorey = false;
  var outPanes = [];
  for(var i = 0; i < panes.length; i++){
    var p = panes[i];
    if(x >= p.min.x - 0.6 && x <= p.max.x + 0.6 && y >= p.min.y - 0.6 && y <= p.max.y + 0.6 &&
       z >= p.min.z - 0.6 && z <= p.max.z + 0.6) outPanes.push(p);
  }
  return (inStorey ? [storey] : []).concat(outPanes);
}
function groundY(){ return 0; }
function makeEnv(keys, heading, y, solidsFn){
  var fwd = (keys.KeyW ? 1 : 0) - (keys.KeyS ? 1 : 0);
  var side = (keys.KeyA ? 1 : 0) - (keys.KeyD ? 1 : 0);
  return {
    space: !!keys.Space, shift: !!(keys.ShiftLeft || keys.ShiftRight),
    w: !!keys.KeyW, fwd: fwd, side: side, heading: heading, calm: false,
    groundY: groundY,
    blocked: function(x, z){ return x >= storey.min.x && x <= storey.max.x && z >= storey.min.z && z <= storey.max.z; },
    solids: solidsFn, anchor: null
  };
}
function newSt(x, y, z, yaw, extra){
  var st = {x: x, y: y, z: z, vx: 0, vy: 0, vz: 0, yaw: yaw, jumps: 0,
            webSide: 1, t: 0, spaceWas: false, shiftWas: false};
  if(extra) for(var k in extra) st[k] = extra[k];
  return st;
}
function insideAny(x, y, z, boxes, rad){
  rad = rad == null ? 0 : rad;
  for(var i = 0; i < boxes.length; i++){
    var b = boxes[i];
    if(x >= b.min.x - rad && x <= b.max.x + rad && y >= b.min.y && y <= b.max.y &&
       z >= b.min.z - rad && z <= b.max.z + rad) return b.id || "box";
  }
  return null;
}

// ---------- T1. DRIVE THROUGH: dive at the storey face with speed ----------
["generous", "strict"].forEach(function(span){
  var solidsFn = span === "generous" ? solidsGenerous : solidsStrict;
  function solidsStrict(x, y, z){ return insideStrict(x, y, z); }
  var st = newSt(-12, 20, 0, Math.PI/2, {vx: 10, vy: -2, vz: 0, jumps: 1});
  var frames = [], crossed = false, entered = null;
  for(var i = 0; i < 90; i++){
    var e = makeEnv({KeyW: true}, Math.PI/2, st.y, solidsFn);
    P.airFrame(st, e, DT);
    var inB = insideAny(st.x, st.y, st.z, [storey, podium], 0);
    if(inB && !entered) entered = {frame: i, box: inB, x: +st.x.toFixed(2), y: +st.y.toFixed(2)};
    if(st.x > storey.max.x + 2 && !crossed) crossed = {frame: i, x: +st.x.toFixed(2)};
    if(i % 10 === 0) frames.push({i: i, mode: st.wall ? "wall" : "air",
      x: +st.x.toFixed(2), y: +st.y.toFixed(2), inB: inB});
  }
  out["T1_" + span] = {
    entered: entered,
    crossed: crossed,
    wall: !!st.wall,
    frames: frames.filter(function(f){ return f.inB; }).slice(0, 8)
  };
});

// ---------- T2. FLOAT: climb the face and report WORLD x each frame ----------
// The bad frame is not "off the storey's face" (a stepped HQ podium puts you
// legally 2 m out on the podium until the crawl tops it). It is "off the face
// the grip is HOLDING" — once wallStep has chosen the tall face, the crawl must
// run ON it within a beat, not hover off it while st.wall is set.
["generous", "strict"].forEach(function(span){
  function solidsStrict(x, y, z){ return insideStrict(x, y, z); }
  var solidsFn = span === "generous" ? solidsGenerous : solidsStrict;
  var st = newSt(-4.2, 0, 0, Math.PI/2);
  var trail = [], worstOffHeld = 0, wallFrames = 0, fallFrames = 0;
  var heldFaceX = null;
  for(var i = 0; i < 120; i++){
    var e = makeEnv({KeyW: true}, Math.PI/2, st.y, solidsFn);
    P.airFrame(st, e, DT);
    if(st.wall) wallFrames++; else fallFrames++;
    if(st.wall){
      // the face the grip holds: west-most rising solid this frame (tall) wins
      var fl = solidsFn(st.x, st.y + 1.0, st.z), target = null, towerTop = -1e9;
      for(var fi = 0; fi < fl.length; fi++){
        var fb = fl[fi];
        if(!fb || !fb.min) continue;
        var vh = fb.max.y - fb.min.y; if(vh < 1.3) continue;
        if(fb.max.y - fb.min.y > towerTop){ towerTop = fb.max.y - fb.min.y; }
        if(fb.max.y > st.y + 1.6 && (target == null || fb.min.x < target)) target = fb.min.x;
      }
      heldFaceX = target;
      if(target != null){
        var off = target - st.x;          // centre-to-held-face
        worstOffHeld = Math.max(worstOffHeld, off);
      }
    }
    if(i % 15 === 0) trail.push({i: i, mode: st.wall ? "wall" : "air",
      x: +st.x.toFixed(3), y: +st.y.toFixed(3),
      offStorey: +(storey.min.x - st.x).toFixed(2),
      offHeld: heldFaceX != null ? +(heldFaceX - st.x).toFixed(2) : null});
  }
  out["T2_" + span] = {
    wallFrames: wallFrames, fallFrames: fallFrames,
    worstOffHeldFace: +worstOffHeld.toFixed(3),  // must settle to ~0.42
    finalX: +st.x.toFixed(3),
    climbY: +st.y.toFixed(3),
    trail: trail
  };
});

// ---------- T3. RELEASE: Space off the face must LEAVE it, not re-grab ----------
(function(){
  function solidsFn(x, y, z){ return solidsGenerous(x, y, z); }
  var st = newSt(-4.0, 12, 0, Math.PI/2, {wall: {nx: -1, nz: 0, t: 0.2, run: 0}, jumps: 1});
  for(var i = 0; i < 8; i++) P.airFrame(st, makeEnv({KeyW: true}, Math.PI/2, st.y, solidsFn), DT);
  // the actual escape: Space as a fresh press with NO direction key, then let go
  var seq = [], regripped = -1;
  for(var j = 0; j < 30; j++){
    var keys = j === 0 ? {Space: true} : {};
    var r = P.airFrame(st, makeEnv(keys, Math.PI/2, st.y, solidsFn), DT);
    if(j > 0 && st.wall && regripped < 0) regripped = j;
    seq.push({f: j, mode: r.mode, wall: !!st.wall, x: +st.x.toFixed(3), vy: +st.vy.toFixed(2)});
  }
  out.T3_spaceReleases = {
    leftFace: seq.length > 2 && !seq[1].wall,
    regrippedAt: regripped,                     // true re-attachment frame, or -1
    seq: seq.slice(0, 12)
  };
  // and a geometry leave (the probe drops the grip far from any face it can return to)
  var st2 = newSt(-4.0, 12, 0, Math.PI/2, {wall: {nx: -1, nz: 0, t: 0.2, run: 0}, jumps: 1});
  st2.x = -9.0;                       // walk left: no face in the 1.6 m reach
  var left2 = true, heldAfterYank = true;
  for(var k = 0; k < 10; k++){
    P.airFrame(st2, makeEnv({KeyW: false}, Math.PI/2, st2.y, solidsFn), DT);
    if(!st2.wall) left2 = true;
    heldAfterYank = !!st2.wall;
  }
  out.T3_geomReleases = {stillGripped: heldAfterYank, x: +st2.x.toFixed(3)};
})();

process.stdout.write(JSON.stringify(out, null, 2));
