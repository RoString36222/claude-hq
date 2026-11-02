/* Live-path probe for the WALL CRAWL handoff. Drives the real airFrame / wallStep /
   wallFromInput / faceNormalAt with the SAME key mapping hq3d's airStep uses
   (keys.KeyW -> fwd, camHeading -> env.heading). Prints numbers — no greps.

   The user's report: "i cant crawl on the wall of buildings / i am just floating
   near them". That is the body NEAR a face with no grip, so this probe walks the
   real handoff: keys -> heading -> wallFromInput / fallHit -> wallStep climb. */
var fs = require("fs");
var path = require("path");
var root = path.resolve(__dirname, "..");
global.window = {HQV: {}};
new Function(fs.readFileSync(root + "/games/skystrike.js", "utf8"))();
var P = window.HQV.skystrike.pure;

var out = {};
var DT = 1/60;

// --- world: a tall tower with its west face at x=16 (outward normal -X) ---
var tower = {id: "twr", min: {x: 16, y: 0, z: -20}, max: {x: 40, y: 80, z: 20}};
var deckBox = {id: "deck:0", min: {x: -12, y: 39.8, z: -12}, max: {x: 12, y: 40, z: 12}};
function solids(x, y, z){ return [tower, deckBox]; }
function groundY(x, z){
  if(x >= -12 && x <= 12 && z >= -12 && z <= 12) return 40;
  return 0;
}
// the city's blocked: the tower is solid on the street
function cityBlocked(x, z){ return x >= 16 && x <= 40 && z >= -20 && z <= 20; }

// hq3d airStep's env.blocked: FALSE once the feet are above the surface
function makeEnv(keys, heading, y){
  var fwd = (keys.KeyW || keys.ArrowUp ? 1 : 0) - (keys.KeyS || keys.ArrowDown ? 1 : 0);
  var side = (keys.KeyA || keys.ArrowLeft ? 1 : 0) - (keys.KeyD || keys.ArrowRight ? 1 : 0);
  return {
    space: !!keys.Space,
    shift: !!(keys.ShiftLeft || keys.ShiftRight),
    w: !!(keys.KeyW || keys.ArrowUp),
    fwd: fwd, side: side,
    heading: heading,
    calm: false,
    groundY: groundY,
    blocked: function(x, z){
      if((+y || 0) > groundY(x, z) + 0.15) return false;
      return cityBlocked(x, z);
    },
    solids: solids,
    anchor: null
  };
}

function newSt(x, y, z, yaw, extra){
  var st = {x: x, y: y, z: z, vx: 0, vy: 0, vz: 0, yaw: yaw, jumps: 0, spaceWas: false, shiftWas: false};
  if(extra) for(var k in extra) st[k] = extra[k];
  return st;
}

// ---------- A. ground walk INTO the wall (W held, heading = facing = +X) ----------
// The WALK owns x/z on the feet and stops the body at the building's edge —
// start him there (x just under the face at 16), the way the live walk leaves him.
try {
  var stA = newSt(15.85, 0, 0, Math.PI/2);
  var trailA = [];
  for(var i = 0; i < 24; i++){
    var envA = makeEnv({KeyW: true}, Math.PI/2, stA.y);
    var rA = P.airFrame(stA, envA, DT);
    trailA.push({i: i, mode: rA.mode, x: +stA.x.toFixed(3), y: +stA.y.toFixed(3),
                 vy: +stA.vy.toFixed(2), wall: stA.wall ? 1 : 0});
  }
  out.A_groundInto = {
    finalMode: trailA[trailA.length-1].mode,
    wall: stA.wall ? 1 : 0,
    climb: +(stA.y - 0).toFixed(3),
    x: +stA.x.toFixed(3),
    modes: trailA.map(function(t){ return t.mode; }).join(",")
  };
} catch(e){ out.A_groundIntoErr = String(e); }

// ---------- B. classic mode: camHeading() is null -> heading = avatar.yaw ----------
// The walk stops the body at the face (x just under 16), same as case A.
try {
  var stB = newSt(15.85, 0, 0, Math.PI/2);
  for(var i = 0; i < 24; i++){
    var envB = makeEnv({KeyW: true}, null, stB.y);   // heading null: wallStep falls back to st.yaw
    var rB = P.airFrame(stB, envB, DT);
  }
  out.B_classicHeading = {
    mode: rB.mode, wall: stB.wall ? 1 : 0, climb: +stB.y.toFixed(3), x: +stB.x.toFixed(3)
  };
} catch(e){ out.B_classicHeadingErr = String(e); }

// ---------- C. ground, W held but heading ALONG the face (not into it) ----------
// face outward normal is -X; heading 0 makes W go +Z (along the face). The walk
// left him at the face. A walk PARALLEL to a wall on the ground should NOT grab
// it — that is walking past, not into. But once he is near the face and using
// keys in free fall, nearFaceGrip must latch (see D).
try {
  var stC = newSt(15.85, 0, 0, 0);
  for(var i = 0; i < 24; i++){
    var envC = makeEnv({KeyW: true}, 0, stC.y);
    var rC = P.airFrame(stC, envC, DT);
  }
  out.C_groundAlong = {
    mode: rC.mode, wall: stC.wall ? 1 : 0,
    climb: +stC.y.toFixed(3), z: +stC.z.toFixed(3), x: +stC.x.toFixed(3)
  };
} catch(e){ out.C_groundAlongErr = String(e); }

// ---------- D. FREE FALL beside the wall (0.70 m off the face, NO collision), W into it ----------
// This is the user's "floating near them": the body is near a face, no sweep hit,
// so fallHit is null and — if the code is as written — no grip ever starts.
try {
  var stD = newSt(15.30, 12, 0, Math.PI/2, {vx: 0, vy: -1.0, vz: 0, jumps: 1});
  var modesD = [];
  for(var i = 0; i < 30; i++){
    var envD = makeEnv({KeyW: true}, Math.PI/2, stD.y);
    var rD = P.airFrame(stD, envD, DT);
    modesD.push(rD.mode);
  }
  out.D_fallBesideW = {
    finalMode: modesD[modesD.length-1],
    wall: stD.wall ? 1 : 0,
    y: +stD.y.toFixed(3), x: +stD.x.toFixed(3),
    vy: +stD.vy.toFixed(2),
    climbed: +(stD.y - 12).toFixed(3),
    modeSeq: modesD.filter(function(m, i){ return i === 0 || m !== modesD[i-1]; }).join(">")
  };
} catch(e){ out.D_fallBesideWErr = String(e); }

// ---------- E. FREE FALL beside the wall, NO keys (pure "floating near them") ----------
try {
  var stE = newSt(15.30, 12, 0, Math.PI/2, {vx: 0, vy: -1.0, vz: 0, jumps: 1});
  var modesE = [];
  for(var i = 0; i < 30; i++){
    var envE = makeEnv({}, Math.PI/2, stE.y);
    var rE = P.airFrame(stE, envE, DT);
    modesE.push(rE.mode);
  }
  out.E_fallBesideIdle = {
    finalMode: modesE[modesE.length-1],
    wall: stE.wall ? 1 : 0,
    y: +stE.y.toFixed(3), x: +stE.x.toFixed(3),
    vy: +stE.vy.toFixed(2)
  };
} catch(e){ out.E_fallBesideIdleErr = String(e); }

// ---------- F. FREE FALL moving INTO the wall (sweep hits) + W ----------
try {
  var stF = newSt(15.0, 12, 0, Math.PI/2, {vx: 3.0, vy: -2.0, vz: 0, jumps: 1});
  var modesF = [];
  for(var i = 0; i < 30; i++){
    var envF = makeEnv({KeyW: true}, Math.PI/2, stF.y);
    var rF = P.airFrame(stF, envF, DT);
    modesF.push(rF.mode);
  }
  out.F_fallIntoW = {
    finalMode: modesF[modesF.length-1],
    wall: stF.wall ? 1 : 0,
    y: +stF.y.toFixed(3), x: +stF.x.toFixed(3),
    climbFromContact: +(stF.y - 12).toFixed(3),
    modeSeq: modesF.filter(function(m, i){ return i === 0 || m !== modesF[i-1]; }).join(">")
  };
} catch(e){ out.F_fallIntoWErr = String(e); }

// ---------- G. already gripped, W into the face: does it climb? ----------
try {
  var stG = newSt(15.42, 10, 0, Math.PI/2, {wall: {nx: -1, nz: 0, t: 0.2, run: 0}, jumps: 1});
  var y0 = stG.y;
  for(var i = 0; i < 30; i++){
    var envG = makeEnv({KeyW: true}, Math.PI/2, stG.y);
    var rG = P.airFrame(stG, envG, DT);
  }
  out.G_gripInto = {
    mode: rG.mode, wall: stG.wall ? 1 : 0,
    climb: +(stG.y - y0).toFixed(3), x: +stG.x.toFixed(3), y: +stG.y.toFixed(3)
  };
} catch(e){ out.G_gripIntoErr = String(e); }

// ---------- H. already gripped, A along the face ----------
try {
  var stH = newSt(15.42, 10, 0, Math.PI/2, {wall: {nx: -1, nz: 0, t: 0.2, run: 0}, jumps: 1});
  var y0h = stH.y, z0h = stH.z;
  for(var i = 0; i < 30; i++){
    var envH = makeEnv({KeyA: true}, Math.PI/2, stH.y);   // side=+1 -> with heading PI/2 that is -X? see airStep
    var rH = P.airFrame(stH, envH, DT);
  }
  out.H_gripAlong = {
    mode: rH.mode, wall: stH.wall ? 1 : 0,
    climb: +(stH.y - y0h).toFixed(3), z: +(stH.z - z0h).toFixed(3), x: +stH.x.toFixed(3)
  };
} catch(e){ out.H_gripAlongErr = String(e); }

// ---------- I. already gripped, NO keys: the stick (is that "floating"?) ----------
try {
  var stI = newSt(15.42, 10, 0, Math.PI/2, {wall: {nx: -1, nz: 0, t: 0.2, run: 0}, jumps: 1, vy: -3});
  var y0i = stI.y;
  for(var i = 0; i < 30; i++){
    var envI = makeEnv({}, Math.PI/2, stI.y);
    var rI = P.airFrame(stI, envI, DT);
  }
  out.I_gripIdle = {
    mode: rI.mode, wall: stI.wall ? 1 : 0,
    dy: +(stI.y - y0i).toFixed(3), vy: +stI.vy.toFixed(3), y: +stI.y.toFixed(3)
  };
} catch(e){ out.I_gripIdleErr = String(e); }

// ---------- J. gap audit: bodyBlock stop distance vs faceNormalAt reach ----------
try {
  var stJ = newSt(15.0, 10, 0, Math.PI/2, {vx: 6, vy: 0, vz: 0, jumps: 1});
  var hitJ = P.bodyBlock({x: 15.0, y: 10, z: 0}, {x: 15.6, y: 10, z: 0, vx: 6, vy: 0, vz: 0}, [tower]);
  var nJ = P.faceNormalAt({x: hitJ.x, y: 10, z: 0}, {solids: solids}, null, null);
  var nJ2 = P.faceNormalAt({x: hitJ.x, y: 10, z: 0}, {solids: solids}, null, null, 0.45);
  out.J_gap = {
    stopX: +hitJ.x.toFixed(3), wall: hitJ.wall, nx: hitJ.nx, nz: hitJ.nz,
    distToFace: +(16 - hitJ.x).toFixed(3),
    faceAtDefaultReach: nJ ? (nJ.nx + "," + nJ.nz) : "null",
    faceAt045: nJ2 ? (nJ2.nx + "," + nJ2.nz) : "null"
  };
} catch(e){ out.J_gapErr = String(e); }

// ---------- K. wallFromInput alone at the stop distance ----------
try {
  var stK = newSt(15.58, 10, 0, Math.PI/2);
  var envK = makeEnv({KeyW: true}, Math.PI/2, 10);
  var nK = P.wallFromInput(stK, envK);
  out.K_wallFromInput = nK ? {nx: nK.nx, nz: nK.nz} : null;
} catch(e){ out.K_wallFromInputErr = String(e); }

// ---------- L. the "pressed" check: env.blocked returns FALSE in the air ----------
try {
  var yAir = 12;
  var envL = makeEnv({KeyW: true}, Math.PI/2, yAir);
  out.L_blockedInAir = {
    ahead: envL.blocked(15.5, 0),     // in the air: always false (hq3d's gate)
    onStreet: (function(){
      var e2 = makeEnv({KeyW: true}, Math.PI/2, 0);
      return e2.blocked(15.5, 0);
    })()
  };
} catch(e){ out.L_blockedInAirErr = String(e); }

// ---------- M. LIVE PATH: body-relative heading on the ground ----------
// hq3d's chase walk is body-relative (W along avatar.yaw). airStep now hands the
// grip st.yaw, so a camera that drifted sideways cannot stop the grab. Walked
// into the wall (avatar.yaw = +X = PI/2), camera heading is ALONG it (0).
try {
  var stM = newSt(15.85, 0, 0, Math.PI/2);
  for(var i = 0; i < 24; i++){
    var envM = makeEnv({KeyW: true}, 0, stM.y);   // camera heading is sideways
    var rM = P.airFrame(stM, envM, DT);
  }
  out.M_bodyFacingGrab = {
    mode: rM.mode, wall: stM.wall ? 1 : 0,
    climb: +stM.y.toFixed(3), x: +stM.x.toFixed(3)
  };
} catch(e){ out.M_bodyFacingGrabErr = String(e); }

// ---------- N. WALL-LOCAL crawl: once gripped, W always climbs ----------
try {
  var stN = newSt(15.56, 10, 0, 0, {wall: {nx: -1, nz: 0, t: 0.2, run: 0}, jumps: 1});
  var yN0 = stN.y;
  for(var i = 0; i < 30; i++){
    var envN = makeEnv({KeyW: true}, 0, stN.y);   // camera heading is ALONG the face
    var rN = P.airFrame(stN, envN, DT);
  }
  out.N_wallLocalW = {
    mode: rN.mode, wall: stN.wall ? 1 : 0,
    climb: +(stN.y - yN0).toFixed(3)
  };
} catch(e){ out.N_wallLocalWErr = String(e); }

// ---------- O. WALL-LOCAL: A alone crawls sideways and HOLDS height ----------
try {
  var stO = newSt(15.56, 10, 0, Math.PI/2, {wall: {nx: -1, nz: 0, t: 0.2, run: 0}, jumps: 1});
  var yO0 = stO.y, zO0 = stO.z;
  for(var i = 0; i < 30; i++){
    var envO = makeEnv({KeyA: true}, Math.PI/2, stO.y);
    var rO = P.airFrame(stO, envO, DT);
  }
  out.O_wallLocalA = {
    mode: rO.mode, wall: stO.wall ? 1 : 0,
    dy: +(stO.y - yO0).toFixed(3), dz: +(stO.z - zO0).toFixed(3)
  };
} catch(e){ out.O_wallLocalAErr = String(e); }

// ---------- P. zip stand-off (1.25 m): the grip must still find the face ----------
try {
  var stP = newSt(14.75, 10, 0, Math.PI/2, {vx: 0, vy: -1, vz: 0, jumps: 1, spaceWas: true, shiftWas: true});
  for(var i = 0; i < 20; i++){
    var envP = makeEnv({KeyW: true}, Math.PI/2, stP.y);
    var rP = P.airFrame(stP, envP, DT);
  }
  out.P_zipStandoff = {
    mode: rP.mode, wall: stP.wall ? 1 : 0,
    x: +stP.x.toFixed(3), climb: +(stP.y - 10).toFixed(3),
    distToFace: +(16 - stP.x).toFixed(3)
  };
} catch(e){ out.P_zipStandoffErr = String(e); }

// ---------- Q. Shift + W runs the face faster than a plain W crawl ----------
try {
  function climbN(keys, shift){
    var stQ = newSt(15.56, 10, 0, Math.PI/2, {wall: {nx: -1, nz: 0, t: 0.2, run: 0}, jumps: 1});
    var y0 = stQ.y;
    for(var i = 0; i < 30; i++){
      var k = {}; for(var kk in keys) k[kk] = keys[kk];
      if(shift) k.ShiftLeft = true;
      var envQ = makeEnv(k, Math.PI/2, stQ.y);
      P.airFrame(stQ, envQ, DT);
    }
    return +(stQ.y - y0).toFixed(3);
  }
  var qCrawl = climbN({KeyW: true}, false);
  var qRun = climbN({KeyW: true}, true);
  out.Q_runFaster = {crawl: qCrawl, run: qRun, ok: qRun > qCrawl*1.25};
} catch(e){ out.Q_runFasterErr = String(e); }

process.stdout.write(JSON.stringify(out, null, 2));
