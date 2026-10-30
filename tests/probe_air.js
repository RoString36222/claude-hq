/* Live probe: drive the REAL airFrame / bodyBlock / wallStep with an HQ-roof-like
   env and a building-contact env. Prints numbers — no substring greps. */
var fs = require("fs");
var path = require("path");
var root = path.resolve(__dirname, "..");
global.window = {HQV: {}};
new Function(fs.readFileSync(root + "/games/skystrike.js", "utf8"))();
var P = window.HQV.skystrike.pure;

var out = {};

// ---------- world: an HQ roof deck at y=40 (walk height), a tower beside it ----------
// deck solid (as hqcity3d emits AFTER the fix): min.y = deck.y-0.2, max.y = deck.y
var DECK_Y = 40;
var deckBox = {id: "deck:0", min: {x: -12, y: DECK_Y - 0.2, z: -12}, max: {x: 12, y: DECK_Y, z: 12}};
// a tower wall to the east of the deck
var tower = {id: "twr", min: {x: 16, y: 0, z: -10}, max: {x: 30, y: 80, z: 10}};
// a low building (for the near-cornice / top-face case)
var lowB = {id: "low", min: {x: -40, y: 0, z: -40}, max: {x: -20, y: 6, z: -20}};

function solids(x, y, z){
  var list = [deckBox, tower, lowB];
  return list.filter(function(b){
    return Math.abs((b.min.x + b.max.x)/2 - x) < 60 && Math.abs((b.min.z + b.max.z)/2 - z) < 60;
  });
}

// groundY: the city's roof-aware one — deck height on the deck, street otherwise
function groundY(x, z){
  if(x >= -12 && x <= 12 && z >= -12 && z <= 12) return DECK_Y;
  return 0;
}

// ---------- 1. standing on the deck: does bodyBlock shove us through it? ----------
try {
  var prev = {x: 0, y: DECK_Y, z: 0};
  var next = {x: 0, y: DECK_Y - 0.01, z: 0, vx: 0, vy: -0.01, vz: 0};   // resting
  var hit = P.bodyBlock(prev, next, [deckBox]);
  out.deckRest = {y: hit.y, ny: hit.ny, wall: hit.wall, pushed: hit.y - (DECK_Y - 0.01)};
} catch(e){ out.deckRestErr = String(e); }

// a small hop DOWN onto the deck (the landing)
try {
  var prev2 = {x: 0, y: DECK_Y + 0.4, z: 0};
  var next2 = {x: 0, y: DECK_Y - 0.1, z: 0, vx: 0, vy: -8, vz: 0};
  var hit2 = P.bodyBlock(prev2, next2, [deckBox]);
  out.deckLand = {y: hit2.y, ny: hit2.ny, wall: hit2.wall, vy: hit2.vy};
} catch(e){ out.deckLandErr = String(e); }

// ---------- 2. ground jump on the roof: does airFrame actually jump? ----------
try {
  var st = {x: 0, y: DECK_Y, z: 0, vx: 0, vy: 0, vz: 0, yaw: 0, jumps: 0, spaceWas: false, shiftWas: false};
  var env = {
    space: true, shift: false, w: false, fwd: 0, side: 0,
    heading: 0, calm: false,
    groundY: groundY, blocked: function(x, z){ return false; },
    solids: solids, anchor: null
  };
  // two frames: first sets spaceWas, second should jump... actually spaceEdge is
  // true on the FIRST frame with space held and spaceWas false.
  var r = P.airFrame(st, env, 1/60);
  out.roofJump = {mode: r.mode, vy: st.vy, y: st.y, jumps: st.jumps, onGroundWas: (st.y <= groundY(st.x, st.z) + 0.06 && st.vy <= 0.01)};
} catch(e){ out.roofJumpErr = String(e); }

// ---------- 3. jump while pushing into the lift house (wallFromInput eats it?) ----------
try {
  // a lift house right beside the body
  var house = {id: "house", min: {x: 1.2, y: DECK_Y - 0.2, z: -1}, max: {x: 3.2, y: DECK_Y + 3, z: 1}};
  var st3 = {x: 0, y: DECK_Y, z: 0, vx: 0, vy: 0, vz: 0, yaw: 0, jumps: 0, spaceWas: false, shiftWas: false};
  var env3 = {
    space: true, shift: false, w: true, fwd: 1, side: 0,
    heading: 0, calm: false,
    groundY: groundY,
    blocked: function(x, z){ return x > 1.0 && x < 3.4 && z > -1.2 && z < 1.2; },
    solids: function(x, y, z){ return [deckBox, house]; },
    anchor: null
  };
  var r3 = P.airFrame(st3, env3, 1/60);
  out.jumpVsWall = {mode: r3.mode, vy: st3.vy, y: st3.y, wall: st3.wall ? 1 : 0, jumps: st3.jumps};
} catch(e){ out.jumpVsWallErr = String(e); }

// ---------- 4. walk into a tower wall: does the grip crawl or freeze/shake? ----------
try {
  var st4 = {x: 15.2, y: 0, z: 0, vx: 2, vy: 0, vz: 0, yaw: Math.PI/2, jumps: 0, spaceWas: false, shiftWas: false};
  var env4 = {
    space: false, shift: false, w: true, fwd: 1, side: 0,
    heading: Math.PI/2, calm: false,
    groundY: function(){ return 0; },
    blocked: function(x, z){ return x >= 16; },
    solids: solids, anchor: null
  };
  var trail = [];
  for(var i = 0; i < 30; i++){
    var r4 = P.airFrame(st4, env4, 1/30);
    trail.push({i: i, mode: r4.mode, x: +st4.x.toFixed(3), y: +st4.y.toFixed(3), z: +st4.z.toFixed(3),
                vx: +st4.vx.toFixed(2), vy: +st4.vy.toFixed(2),
                wall: st4.wall ? {nx: +st4.wall.nx.toFixed(2), nz: +st4.wall.nz.toFixed(2), run: st4.wall.run, t: +st4.wall.t.toFixed(2)} : null});
  }
  out.wallRunTrail = trail;
  // shake measure: frame-to-frame position oscillation
  var osc = 0, stuck = 0;
  for(var i = 1; i < trail.length; i++){
    var dx = trail[i].x - trail[i-1].x, dy = trail[i].y - trail[i-1].y, dz = trail[i].z - trail[i-1].z;
    var d = Math.sqrt(dx*dx + dy*dy + dz*dz);
    if(d < 0.01) stuck++;
    if(i > 2 && (trail[i].x - trail[i-1].x)*(trail[i-1].x - trail[i-2].x) < 0) osc++;
  }
  out.wallRun = {stuckFrames: stuck, xOscillations: osc, finalMode: trail[trail.length-1].mode,
                 finalPos: [trail[trail.length-1].x, trail[trail.length-1].y, trail[trail.length-1].z],
                 climb: trail[trail.length-1].y - trail[0].y};
} catch(e){ out.wallRunErr = String(e); }

// ---------- 5. Space while gripped: jump AWAY or zip INTO the wall? ----------
// spaceWas:false so the FIRST frame carries a real Space edge (the bug the user
// hit: "sometime jump doesn't even work, to jump away from building").
try {
  var st5 = {x: 15.2, y: 10, z: 0, vx: -1, vy: 0, vz: 0, yaw: Math.PI/2, jumps: 0, spaceWas: false, shiftWas: false,
             wall: {nx: -1, nz: 0, t: 0.5, run: 0}};
  var env5 = {
    space: true, shift: false, w: false, fwd: 0, side: 0,
    heading: Math.PI/2, calm: false,
    groundY: function(){ return 0; },
    blocked: function(){ return false; },
    solids: solids, anchor: null
  };
  var r5 = P.airFrame(st5, env5, 1/60);
  out.jumpAway = {mode: r5.mode, vx: st5.vx, vy: st5.vy, x: st5.x, wall: st5.wall ? 1 : 0, zip: st5.zip ? 1 : 0};
} catch(e){ out.jumpAwayErr = String(e); }

// ---------- 6. free-fall Space near a wall: zip INTO it or jump away? ----------
try {
  var st6 = {x: 14.0, y: 10, z: 0, vx: 2, vy: -3, vz: 0, yaw: Math.PI/2, jumps: 1, spaceWas: false, shiftWas: false};
  var env6 = {
    space: true, shift: false, w: false, fwd: 0, side: 0,
    heading: Math.PI/2, calm: false,
    groundY: function(){ return 0; },
    blocked: function(){ return false; },
    solids: solids,
    anchor: function(from, dir, maxDist){
      // a fake anchor: the tower face right in front
      return {x: 16, y: from.y + 2, z: 0};
    }
  };
  var r6 = P.airFrame(st6, env6, 1/60);
  out.zipOrJump = {mode: r6.mode, fire: r6.fire, zip: st6.zip ? 1 : 0, vx: st6.vx, vy: st6.vy, x: st6.x};
} catch(e){ out.zipOrJumpErr = String(e); }

// ---------- 7. pushOut direction when resting on the deck slab ----------
try {
  var prev7 = {x: 0, y: DECK_Y + 0.05, z: 0};
  var next7 = {x: 0, y: DECK_Y - 0.05, z: 0, vx: 0, vy: -1, vz: 0};
  var hit7 = P.bodyBlock(prev7, next7, [deckBox]);
  out.pushDir = {y: hit7.y, ny: hit7.ny, expectUp: hit7.y >= DECK_Y - 0.01};
} catch(e){ out.pushDirErr = String(e); }

// ---------- 8. wall contact: faceNormalAt stability over frames ----------
try {
  var st8 = {x: 15.4, y: 5, z: 0};
  var flips = 0, last = null;
  for(var i = 0; i < 20; i++){
    var n = P.faceNormalAt(st8, {solids: solids}, -1, 0);
    var key = n ? (n.nx + "," + n.nz) : "null";
    if(last && key !== last) flips++;
    last = key;
    st8.x = 15.4 + Math.sin(i*0.7)*0.05;
    st8.z = Math.cos(i*0.5)*0.05;
  }
  out.faceFlips = flips;
  out.faceLast = last;
} catch(e){ out.faceFlipsErr = String(e); }

process.stdout.write(JSON.stringify(out, null, 2));
