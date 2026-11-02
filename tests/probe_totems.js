/* totem audit: for every totem the user named, count the WRITE sites (totemApply /
   take_totem / the MP apply mirror) against the gameplay READ sites (the places that
   actually change what happens — not the reset block, not the flag export, not the
   string in TOTEM_HELP). A totem with 0 gameplay readers is dead on that side.

   Also measures the two the user called out first:
     - Gravity Flip: the jump apex with gMult 0.42 vs 1.0, driven through the real FS.move
     - Time Rewind : how far the body actually travels back, measured on the same
                     hist buffer the game fills (3 frames vs 3 seconds)

   Numbers, not flags. Run: node tests/probe_totems.js */
var fs = require("fs");
var path = require("path");
var root = path.resolve(__dirname, "..");
var js = fs.readFileSync(root + "/games/strike.js", "utf8");
var rs = fs.readFileSync(root + "/backend/src/strike.rs", "utf8");
var m = js.match(/\/\* STRIKE-SHARED BEGIN \*\/([\s\S]*?)\/\* STRIKE-SHARED END \*\//);
if(!m){ console.error("no STRIKE-SHARED block"); process.exit(1); }
var FS = new Function(m[1] + "; return FS;")();

// ---- totem -> [state fields written] ----
var TOTEMS = [
  ["magnet",      ["magnetUntil"]],
  ["chain",       ["chainLeft"]],
  ["trap",        ["mines"]],
  ["mark",        ["hunterUntil"]],
  ["blink",       ["blinkLeft"]],
  ["bubble",      ["bubbles"]],
  ["wallrun",     ["wallrunUntil"]],
  ["secondwind",  ["secondWind"]],
  ["fakedeath",   ["fakeUntil"]],
  ["ghost",       ["ghostLeft"]],
  ["cluster",     ["clusterLeft"]],
  ["overclock",   ["overclockUntil"]],
  ["ricochet",    ["ricoLeft"]],
  ["infchamber",  ["infUntil"]],
  ["bodyswap",    []],                       // instant: swaps x/z, no window
  ["rally",       ["rallyUntil", "beacons"]],
  ["meteor",      ["meteors"]],
  ["chaos",       ["chaosUntil", "chaosNext"]],
  ["phoenix",     ["phoenixUntil"]],
  ["pocket",      ["pocketUntil"]],
  ["fate",        ["fateUntil", "fateUid"]],
  ["king",        ["kingUntil", "beacons"]],
  ["radarjam",    ["jamUntil"]],
  ["gravflip",    ["gravUntil"]],
  ["rewind",      ["secondWind", "hist"]]
];

// lines that are NOT a gameplay read: the match-reset block, the MP flag import, TOTEM_HELP,
// the MP apply mirror, and a pure totemApply write.
// NOTE: a line can BOTH read and reset a flag (`if(V.secondWind){ V.secondWind = false; ...}`),
// so noise is judged per-occurrence, not per-line.
function isNoiseLine(line){
  return /TOTEM_HELP/.test(line)
      || /P\.\w+\s*=\s*has\(/.test(line)
      || /if\(knd ===/.test(line)
      || /flag_extra|FLAG_/.test(line);
}
function readers(src, field, opts){
  opts = opts || {};
  var out = [], lines = src.split("\n");
  var re = new RegExp(field + "\\b", "g");
  for(var i = 0; i < lines.length; i++){
    var L = lines[i];
    if(isNoiseLine(L)) continue;
    if(!re.test(L)){ re.lastIndex = 0; continue; }
    re.lastIndex = 0;
    // keep the line if ANY occurrence of the field is a read (test, call, compare) —
    // i.e. the line is not a pure assignment like `V.field = 0` / `= false` / `= []`
    var pureAssign = new RegExp("(^|[;{}\\s])(V|P|self|p|kv|v|vic|mateP|best|tv|q)\\." + field + "\\s*=[^=+\\-|]").test(L)
                  && !new RegExp(field + "\\s*(\\+\\+|--|\\+=|-=|\\|=)|[!<>=]\\s*[^;]*" + field).test(L)
                  && !new RegExp(field + "\\s*&&|" + field + "\\s*\\|\\||!" + field + "|if\\s*\\([^)]*" + field).test(L);
    if(pureAssign) continue;
    out.push((i + 1) + ": " + L.trim().slice(0, 110));
  }
  return out;
}

var out = {js: {}, rs: {}, measure: {}};

TOTEMS.forEach(function(row){
  var kind = row[0], fields = row[1];
  var ent = {write: 0, read: 0, readAt: []};
  fields.forEach(function(f){
    var r = readers(js, f);
    ent.read += r.length;
    ent.readAt = ent.readAt.concat(r);
    var w = js.split("\n").filter(function(L){ return L.indexOf(f) >= 0; }).length;
    ent.write = w;   // every mention, for the "is it even wired" check
  });
  out.js[kind] = ent;
});

// ---- measure 1: Gravity Flip jump apex through the REAL FS.move ----
(function(){
  function apex(gMult){
    var s = {x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0, g: true};
    var map = {boxes: []};
    var top = 0;
    for(var i = 0; i < 240; i++){
      FS.move(map, s, 0, 0, i === 0, 1/60, false, 1, 1, gMult);
      if(s.y > top) top = s.y;
      if(i > 0 && s.g) break;
    }
    return top;
  }
  var normal = apex(1), flip = apex(0.42);
  out.measure.gravflip = {
    jumpApexNormalM: +normal.toFixed(3),
    jumpApexFlipM: +flip.toFixed(3),
    gainM: +(flip - normal).toFixed(3),
    gravityNormal: 18.0,
    gravityFlip: +(18.0 * 0.42).toFixed(2),
    wired: flip > normal + 0.2
  };
})();

// ---- measure 2: Time Rewind — how far the body really travels back ----
// Drive the REAL FS.histPush / FS.histAt helpers (the same ones the game calls every
// frame and on take). Walk forward at RUN (6 m/s) for 3 s at 60 fps, then rewind.
(function(){
  var frames = 180, dt = 1/60;
  var hist = [], x = 0;
  for(var i = 0; i < frames; i++){
    x += FS.RUN * dt;
    hist = FS.histPush(hist, i * dt, x, 0, 0);
  }
  var tEnd = (frames - 1) * dt;
  var rq = FS.histAt(hist, tEnd - FS.REWIND_S);
  var rewindDist = rq ? (x - rq[0]) : 0;
  var rewindSecs = rq ? (tEnd - (tEnd - FS.REWIND_S)) : 0;

  // what the help text promises: a full 3 s of travel at RUN
  var promised = FS.RUN * FS.REWIND_S;

  // is the sampler in the live path actually calling the helpers?
  var samplerWired = /FS\.histPush\(V\.hist/.test(js) && /FS\.histAt\(V\.hist/.test(js);

  out.measure.rewind = {
    claimedSeconds: FS.REWIND_S,
    histWindowS: FS.HIST_S,
    histSamplesPerSecond: 60,
    histBufferLen: hist.length,
    // what the code does NOW (driven through the real helpers)
    currentRewindDistM: +rewindDist.toFixed(3),
    currentRewindSeconds: +rewindSecs.toFixed(3),
    promisedRewindDistM: +promised.toFixed(3),
    wiredInGame: samplerWired,
    broken: rewindDist < 1.0 || !samplerWired
  };
})();

// ---- measure 3: Rust rewind depth vs its HISTORY window ----
(function(){
  var histS = (rs.match(/pub const HIST_S: f64 = ([\d.]+)/) || [])[1];
  var rewindS = (rs.match(/pub const REWIND_S: f64 = ([\d.]+)/) || [])[1];
  var histConst = (rs.match(/pub const HISTORY: f64 = ([\d.]+)/) || [])[1];
  var rewindGo  = /where_at\(t - REWIND_S\)/.test(rs);
  out.measure.rewindRust = {
    historyWindowS: histS ? +histS : (histConst ? +histConst : null),
    rewindSeconds: rewindS ? +rewindS : null,
    lagCompWindowS: histConst ? +histConst : null,
    rewindArmed: rewindGo,
    effectiveSeconds: rewindS && histS ? Math.min(+rewindS, +histS) : null
  };
})();

// ---- measure 4: the VISIBLE half — are the totem world props actually drawn? ----
// A totem whose state is pushed but has no mesh is the "nothing happens" symptom.
(function(){
  function wired(fn){
    return new RegExp("R\\." + fn + "\\s*=").test(js)
        && new RegExp("R3\\s*&&\\s*R3\\." + fn + "|R\\." + fn + "\\(").test(js);
  }
  out.measure.meshes = {
    addBeacon: wired("addBeacon"),
    addBubble: wired("addBubble"),
    addMine: wired("addMine"),
    addMeteorMark: wired("addMeteorMark"),
    addRift: wired("addRift"),
    // driven from the take path (totemApply) AND the MP snapshot
    beaconTakeHook: /if\(R3 && R3\.addBeacon\) R3\.addBeacon\(/.test(js),
    bubbleTakeHook: /if\(R3 && R3\.addBubble\) R3\.addBubble\(/.test(js),
    mineTakeHook: /if\(R3 && R3\.addMine\) R3\.addMine\(/.test(js),
    meteorTakeHook: /if\(R3 && R3\.addMeteorMark\) R3\.addMeteorMark\(/.test(js),
    beaconSnapHook: /V\.beacons\.forEach\(function\(bc\)\{ if\(R3 && R3\.addBeacon\)/.test(js),
    bubbleSnapHook: /V\.bubbles\.forEach\(function\(bb\)\{ if\(R3 && R3\.addBubble\)/.test(js),
    // hunterMarked is used (radar gold ring), not just defined
    hunterMarkedUsed: /hunterMarked\(P, t\)/.test(js)
  };
  var m4 = out.measure.meshes;
  m4.allDrawn = m4.addBeacon && m4.addBubble && m4.addMine && m4.addMeteorMark
             && m4.beaconTakeHook && m4.bubbleTakeHook && m4.mineTakeHook && m4.meteorTakeHook
             && m4.beaconSnapHook && m4.bubbleSnapHook && m4.hunterMarkedUsed;
})();

console.log(JSON.stringify(out, null, 1));
