/* Live-path probe for the three screenshot complaints:
   (1) contact + W grabs WITHOUT Space
   (2) the grip faces the BODY into the wall (not along it)
   (3) leaving the face RELEASES the grip (no "flying along the wall")
   Drives the real airFrame / wallStep / nearFaceGrip. Prints numbers. */
var fs = require("fs");
var path = require("path");
var root = path.resolve(__dirname, "..");
global.window = {HQV: {}};
new Function(fs.readFileSync(root + "/games/skystrike.js", "utf8"))();
var P = window.HQV.skystrike.pure;

var out = {};
var DT = 1/60;
var tower = {id: "twr", min: {x: 16, y: 0, z: -20}, max: {x: 40, y: 80, z: 20}};
function solids(){ return [tower]; }
function groundY(){ return 0; }
function cityBlocked(x, z){ return x >= 16 && x <= 40 && z >= -20 && z <= 20; }
function makeEnv(keys, heading, y){
  var fwd = (keys.KeyW || keys.ArrowUp ? 1 : 0) - (keys.KeyS || keys.ArrowDown ? 1 : 0);
  var side = (keys.KeyA || keys.ArrowLeft ? 1 : 0) - (keys.KeyD || keys.ArrowRight ? 1 : 0);
  return {
    space: !!keys.Space, shift: !!(keys.ShiftLeft || keys.ShiftRight),
    w: !!keys.KeyW, fwd: fwd, side: side, heading: heading, calm: false,
    groundY: groundY,
    blocked: function(x, z){ if((+y || 0) > 0.15) return false; return cityBlocked(x, z); },
    solids: solids, anchor: null
  };
}
function newSt(x, y, z, yaw, extra){
  var st = {x: x, y: y, z: z, vx: 0, vy: 0, vz: 0, yaw: yaw, jumps: 0,
            webSide: 1, t: 0, spaceWas: false, shiftWas: false};
  if(extra) for(var k in extra) st[k] = extra[k];
  return st;
}

// ---------- 1. NO Space: walk into the face with W and grab + climb ----------
try {
  var st1 = newSt(15.85, 0, 0, Math.PI/2);
  var spaceNever = true;
  for(var i = 0; i < 24; i++){
    var e1 = makeEnv({KeyW: true}, Math.PI/2, st1.y);   // no Space anywhere
    if(e1.space) spaceNever = false;
    P.airFrame(st1, e1, DT);
  }
  out["1_noSpaceClimb"] = {
    grabbed: !!st1.wall, modeY: +st1.y.toFixed(3), x: +st1.x.toFixed(3),
    climbed: st1.y > 0.3, spaceUsed: !spaceNever
  };
} catch(e){ out["1_err"] = String(e); }

// ---------- 2. yaw faces INTO the wall on grip ----------
// Face outward normal is -X, so facing the wall is yaw = atan2(-nx,-nz) = PI/2.
// The body starts facing +Z (along the face) while the CAMERA points into it —
// the free-fall grip (nearFaceGrip) latches from the camera keys, and wallStep
// must then turn the BODY to face the wall so W climbs instead of crawling on.
try {
  var st2 = newSt(15.30, 12, 0, 0, {vx: 0, vy: -1, vz: 0, jumps: 1});
  var yawOnGrip = null, lastYaw = null;
  for(var i2 = 0; i2 < 24; i2++){
    var e2 = makeEnv({KeyW: true}, Math.PI/2, st2.y);   // camera INTO the wall
    P.airFrame(st2, e2, DT);
    if(st2.wall){
      if(yawOnGrip === null) yawOnGrip = st2.yaw;
      lastYaw = st2.yaw;
    }
  }
  var want = Math.atan2(1, 0);   // PI/2
  out["2_yawFacesWall"] = {
    grabbed: !!st2.wall || yawOnGrip !== null,
    yawOnGrip: yawOnGrip === null ? null : +yawOnGrip.toFixed(3),
    want: +want.toFixed(3),
    lastYaw: lastYaw === null ? null : +lastYaw.toFixed(3),
    facing: yawOnGrip === null ? "no-grip" : (Math.abs(yawOnGrip - want) < 0.2 ? "INTO" : "NOT-into"),
    climbed: +st2.y.toFixed(3),
    x: +st2.x.toFixed(3)
  };
} catch(e){ out["2_err"] = String(e); }

// ---------- 3. grip RELEASES when the body is pulled off the face ----------
try {
  var st3 = newSt(15.56, 10, 0, Math.PI/2, {wall: {nx: -1, nz: 0, t: 0.2, run: 0}, jumps: 1});
  // crawl a few frames to confirm the grip holds at contact
  for(var i3 = 0; i3 < 6; i3++) P.airFrame(st3, makeEnv({KeyA: true}, Math.PI/2, st3.y), DT);
  var heldAtContact = !!st3.wall;
  // now YANK him 2.0 m off the face (x: 15.56 -> 13.56) with NO keys
  st3.x = 13.56;
  var releasedAt = -1;
  for(var j3 = 0; j3 < 30; j3++){
    P.airFrame(st3, makeEnv({}, Math.PI/2, st3.y), DT);
    if(!st3.wall && releasedAt < 0) releasedAt = j3;
  }
  out["3_releaseWhenPulled"] = {
    heldAtContact: heldAtContact,
    releasedAtFrame: releasedAt,
    stillGrippedAfterYank: !!st3.wall,
    xAfter: +st3.x.toFixed(3),
    ok: heldAtContact && !st3.wall && releasedAt >= 0
  };
} catch(e){ out["3_err"] = String(e); }

// ---------- 4. the OLD bug's shape: a deep probe kept the grip while floating ----------
// (sanity: at contact the grip must hold through 30 idle frames)
try {
  var st4 = newSt(15.56, 10, 0, Math.PI/2, {wall: {nx: -1, nz: 0, t: 0.2, run: 0}, jumps: 1});
  for(var i4 = 0; i4 < 30; i4++) P.airFrame(st4, makeEnv({}, Math.PI/2, st4.y), DT);
  out["4_holdsAtContact"] = {
    stillGripped: !!st4.wall, x: +st4.x.toFixed(3), y: +st4.y.toFixed(3),
    ok: !!st4.wall && Math.abs(st4.x - 15.56) < 0.2
  };
} catch(e){ out["4_err"] = String(e); }

// ---------- 5. pose: the crawl alternates limbs (not a static fly pose) ----------
try {
  function poseLegs(tt){
    var mk = function(){
      function Euler(){ this.x = 0; this.y = 0; this.z = 0; }
      Euler.prototype.set = function(x, y, z){ this.x = +x; this.y = +y; this.z = +z; };
      function Quat(){ this.x = 0; this.y = 0; this.z = 0; this.w = 1; }
      Quat.prototype.setFromAxisAngle = function(){ return this; };
      Quat.prototype.copy = function(){ return this; };
      Quat.prototype.multiply = function(){ return this; };
      function bone(){
        return {
          rotation: new Euler(),
          position: {x: 0, y: 0, z: 0, set: function(x, y, z){ this.x = +x; this.y = +y; this.z = +z; }},
          quaternion: new Quat(), name: "b"
        };
      }
      return {
        r: bone(), t: bone(), h: bone(),
        ll: bone(), rl: bone(), lk: bone(), rk: bone(), lf: bone(), rf: bone(),
        la: bone(), ra: bone(), le: bone(), re: bone()
      };
    }
    var b = mk(), c = {_bones: b};
    P.airPose(c, {wall: 1, dive: 0, swing: 0, stretch: 0, t: tt, side: 1, launch: 0, fallT: 0.2, wallRun: 0});
    return b;
  }
  var p1 = poseLegs(0.10);
  var p2 = poseLegs(0.10 + Math.PI/4.6);
  var dL = Math.abs(p1.ll.rotation.x - p2.ll.rotation.x);
  var dR = Math.abs(p1.rl.rotation.x - p2.rl.rotation.x);
  var rootSweep = p1.r.rotation.x;
  out["5_crawlPose"] = {
    rootSweepX: +rootSweep.toFixed(3),
    leftLegDelta: +dL.toFixed(3),
    rightLegDelta: +dR.toFixed(3),
    alternates: dL > 0.15 || dR > 0.15,
    plastered: rootSweep > 0.4
  };
} catch(e){ out["5_err"] = String(e); }

process.stdout.write(JSON.stringify(out, null, 2));
