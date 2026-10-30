/* Claude HQ: the generated world as THREE meshes (Arena City claude-hq@1, organic claude-hq@2 and islands).
 *
 * HQV.worldbuild.create(c, W, opts) -> wb builds the 8 x 8 tiles of games/worldgeom.js in a worker
 * (games/worldbuild-worker.js), or on the main thread in idle slices when no worker can start, and
 * keeps them at the right detail for the camera:
 *   terrain   per 64 m chunk: lod0 < 160 m, lod1 < 480 m, lod2 beyond (x lodScale, fixed at create); map mode lod2 everywhere
 *   roads     near (< 300 m): asphalt, marks, kerb+walk; beyond: asphalt with marks merged only
 *   buildings detail 0 (window quads) < 350 m, else detail 1 (a box); window bands come from the body
 *             shader (fract(worldY / 3.5)), lit at night; faded lots get a screen-door dither
 *   props     instanced trees + lamps per tile (< 300 m); world-wide instanced parked cars, sign plates,
 *             gantry frames and gantry plates (refilled with what is within 300 m; hidden in map mode); with city life
 *             (games/citylife.js) the footpaths' furniture too, one world-wide instanced mesh per kind (FURN)
 *   hours     with city life a window's lit attribute is its use's code: wb.setHour(h) (the City's local hour, 0..24)
 *             lights it by HQV.cityLife.LIT_GLSL (offices by day, homes in the evening, shops in opening hours);
 *             code 1 stays lit every night as before, and the detail-1 body rows follow the lot's use the same way
 *   ground    (v2 docs) block pavements, lot / plaza pads and the beach, merged into the tile's terrain mesh
 *   sea       (island docs) one water plane at Layers.island.sea_cm, its normals rippled by waterPhase(clock):
 *             a pure function of the clock (cam.time s, else performance.now), so it is frame-rate independent
 *   river     (island docs with Layers.river) one mesh for the world: worldgeom riverWater, calm water RIVER_LIFT over
 *             sea level in the mounted ocean's calm material (games/ocean.js riverMaterial()), else the plane's
 *   bridges   per tile, one mesh of deck slabs, fascias, abutments and railings (worldgeom roadTile's `bridge`);
 *             opts.gap leaves every bridge's pieces over the water out (games/hqbridges.js draws opening spans there)
 *             (HQ 3.29: an interchange's decks, parapets, piers and the T's slab ride in the same mesh: 1 per tile they cross)
 *             (HQ 3.34: in a doc with decks its lit attribute lights the lamp heads and downlights at night, M.bridgeLit:
 *             the same one mesh per tile, no new key)
 *   tunnels   (HQ 3.30) per tile a tunnel or cutting crosses, one mesh (`tunnel`) of their roads, marks, barrier,
 *             retaining walls, the tunnel's walls, ceiling, walkways, portals and ceiling lights (lit 1: emissive, always
 *             on; HQ 3.34: a cutting's wall lights lit 2, at night only), drawn before the sea and marking the stencil, so
 *             the sea is not drawn down a cutting or in the tunnel
 *   water     (@3 docs with Layers.water) world-wide: every lake, canal and the marina as one mesh (worldgeom waterGeo) in
 *             the river's calm material (games/ocean.js riverMaterial(); the lakes in its calm lake variant: aLake = 1,
 *             smaller ripples and more of the sky), quays, the breakwater, lily pads and reeds as one vertex-coloured
 *             mesh, the shore foam as one more (wb.water = {surface, works, foam}); bank strips ride in the terrain tiles
 * Tiers: opts.tier / wb.setTier(t) show the world as city tier t shows it (worldgeom view); a tier change rebuilds
 * only the tiles and products worldgeom.tierDiff names, and a job that finishes at a stale tier is redone.
 * Draw calls: <= 8 per tile within 300 m, <= 4 beyond, + 4 world-wide (+ 1 sea on an island; + at most 6 for city life's
 * furniture, one per kind within 300 m); a river adds 1 world-wide
 * and 1 per tile a bridge crosses (HQ 3.30: and 1 per tile a tunnel or cutting crosses); @3 water adds at most 3 world-wide (surface, works, foam). A terrain hole (@3) is cut
 * out of the tiles' own meshes and adds none.
 * HQV.worldbuild.governor is pure (node-tested): frame times -> quality level, pixel ratio, shadows (LOD scale stays fixed).
 * No THREE, no DOM at load time: THREE comes from c.THREE inside create().
 */
(function(){
"use strict";
var root = typeof window !== "undefined" ? window : self;
var HQV = root.HQV = root.HQV || {};

var NEAR = 300, PROPS_NEAR = 300, B0_NEAR = 350, LOD0 = 160, LOD1 = 480, SHADOW_NEAR = 120, HYST = 12;
var LOD_SCALE = [0.6, 0.8, 1], TREE_DENSITY = [0.5, 0.8, 1], MAX_INFLIGHT = 2;
var TREE_COL = {pine: [0.17, 0.36, 0.20], round: [0.30, 0.52, 0.24]};
// city life's footpath furniture: the kinds (one world-wide instanced mesh each) and the radius each one blocks (m)
var FURN = ["bench", "bin", "bikerack", "newsstand", "stall", "table"], FURN_R = {bench: 0.6, bin: 0.3, bikerack: 0.5, newsstand: 0.9, stall: 0.9, table: 0.8};
var FURN_CELL = 8;
// the sea plane spans the world three times over; its ripples repeat every WATER_LOOP s (integer wave speeds below)
var SEA_SPAN = 3, WATER_LOOP = 600, ALL_TIERS = 1e9;

function clamp(v, a, b){ return v < a ? a : (v > b ? b : v); }
// worldgeom colours are sRGB 0..1; vertex colours are read in linear space
function lin(c){ return c < 0.04045 ? c/12.92 : Math.pow((c + 0.055)/1.055, 2.4); }
function linArray(a){ var o = new Float32Array(a.length); for(var i = 0; i < a.length; i++) o[i] = lin(a[i]); return o; }

/* ---------- quality governor (pure) ---------- */
// level 2 = pixel ratio min(dpr, 1.5); 1 = 1; 0 = 0.75 and no shadows. Rolling mean over 90 frames:
// above 19 ms for 2 s of frames -> one level down; below 13 ms for 6 s -> one level up, never above the start.
// A level that failed this session needs 60 s of fast frames before it is tried again, so alternating load
// cannot make it oscillate. lodScale is always 1: quality changes pixel ratio and shadows only (a LOD change
// would re-request tiles and churn the worker exactly when the frame budget is short).
var governor = {
  create: function(o){
    o = o || {};
    var dpr = o.dpr > 0 ? +o.dpr : ((root && root.devicePixelRatio) || 1);
    var start = o.start != null ? clamp(o.start|0, 0, 2) : 2;
    return {target: o.target > 0 ? +o.target : 16.7, start: start, level: start, dpr: dpr, buf: [], sum: 0, slow: 0, fast: 0, failed: [false, false, false]};
  },
  step: function(gov, frameMs){
    var ms = +frameMs;
    if(ms > 0 && ms < 1000){
      gov.buf.push(ms); gov.sum += ms;
      if(gov.buf.length > 90) gov.sum -= gov.buf.shift();
      var mean = gov.sum/gov.buf.length;
      gov.slow = mean > 19 ? gov.slow + ms : 0;
      gov.fast = mean < 13 ? gov.fast + ms : 0;
      if(gov.slow >= 2000 && gov.level > 0){ gov.failed[gov.level] = true; gov.level--; governor.reset(gov); }
      else if(gov.level < gov.start && gov.fast >= (gov.failed[gov.level + 1] ? 60000 : 6000)){ gov.level++; governor.reset(gov); }
    }
    return governor.out(gov);
  },
  reset: function(gov){ gov.buf = []; gov.sum = 0; gov.slow = 0; gov.fast = 0; },
  out: function(gov){
    var l = gov.level;
    return {level: l, pixelRatio: l === 2 ? Math.min(gov.dpr, 1.5) : (l === 1 ? 1 : 0.75), shadows: l > 0, lodScale: 1};
  }
};

/* ---------- pure helpers ---------- */
function mergeGeo(list){
  list = list.filter(function(g){ return g && g.idx && g.idx.length; });
  var nv = 0, ni = 0;
  list.forEach(function(g){ nv += g.pos.length; ni += g.idx.length; });
  var o = {pos: new Float32Array(nv), nrm: new Float32Array(nv), col: new Float32Array(nv), idx: new Uint32Array(ni)}, pv = 0, pi = 0;
  list.forEach(function(g){
    o.pos.set(g.pos, pv); o.nrm.set(g.nrm, pv); o.col.set(g.col, pv);
    var base = pv/3;
    for(var i = 0; i < g.idx.length; i++) o.idx[pi + i] = g.idx[i] + base;
    pv += g.pos.length; pi += g.idx.length;
  });
  return o;
}
// a copy of G raised by dy: far marks merged into the asphalt lose their polygon offset, and 2 cm is below depth
// precision past 300 m (about 2 cm there, 7 cm at 600 m with a 0.3 m near plane)
var FAR_MARK_LIFT = 0.15;
function lifted(G, dy){
  if(!G || !G.pos) return G;
  var pos = new Float32Array(G.pos);
  for(var i = 1; i < pos.length; i += 3) pos[i] += dy;
  return {pos: pos, nrm: G.nrm, col: G.col, idx: G.idx};
}
// The road surfaces' grain, from the fragment's world position alone (no texture, no UVs; the same at every LOD and in
// the far mesh): the asphalt's tone drifts in broad patches (worn and resurfaced stretches) and finer mottling, and
// carries an aggregate speckle; a sidewalk's or median's flat top (not a kerb's face, not a planted verge, apron or
// hedge: green) is laid in RD_SLAB m slabs, each its own shade, with darker joints. The fine detail fades out by its
// screen-space footprint (fwidth), so it never shimmers in the distance.
var RD_GLSL = "varying vec3 vRdW;\nvarying float vRdNy;\n" +
  // (a hash with no sin: world metres times 14 overrun sin's precision on some GPUs and band)
  "float rdH(vec2 p){ vec3 q = fract(vec3(p.xyx)*0.1031); q += dot(q, q.yzx + 33.33); return fract((q.x + q.y)*q.z); }\n" +
  "float rdN(vec2 p){ vec2 i = floor(p), f = fract(p); f = f*f*(3.0 - 2.0*f);\n" +
  "  return mix(mix(rdH(i), rdH(i + vec2(1.0, 0.0)), f.x), mix(rdH(i + vec2(0.0, 1.0)), rdH(i + vec2(1.0, 1.0)), f.x), f.y); }\n";
// (RD_LIFT: the asphalt's vertex colour, near black in linear light, lifted to a weathered mid-dark grey the grain shows on)
var RD_LIFT = 1.3;
var ASPHALT_GLSL = "vec2 rdP = vRdW.xz; float rdFw = length(fwidth(rdP));\n" +
  "float rdK = " + RD_LIFT.toFixed(2) + " + (rdN(rdP*0.045) - 0.5)*0.34 + (rdN(rdP*0.37 + 17.0) - 0.5)*0.16;\n" +
  "rdK += (rdH(floor(rdP*14.0)) - 0.5)*0.24*clamp(1.0 - rdFw*9.0, 0.0, 1.0);\n" +
  "diffuseColor.rgb *= rdK;";
// (and its roughness drifts a little with the patches: polished wheel tracks, rougher fresh stretches)
var ASPHALT_ROUGH = "roughnessFactor = clamp(roughnessFactor + (rdN(vRdW.xz*0.12 + 5.0) - 0.5)*0.12, 0.0, 1.0);";
var RD_SLAB = 0.6;
var PAVING_GLSL = "vec2 rdP = vRdW.xz/" + RD_SLAB.toFixed(2) + "; float rdFw = length(fwidth(rdP));\n" +
  "float rdTop = smoothstep(0.85, 0.95, vRdNy)*step(diffuseColor.g, max(diffuseColor.r, diffuseColor.b) + 0.04);\n" +
  "vec2 rdF = abs(fract(rdP) - 0.5); float rdJ = smoothstep(0.455, 0.49, max(rdF.x, rdF.y))*clamp(1.0 - rdFw*3.0, 0.0, 1.0);\n" +
  "float rdS = (rdH(floor(rdP)) - 0.5)*0.10 + (rdN(vRdW.xz*0.2) - 0.5)*0.08;\n" +
  "diffuseColor.rgb *= 1.0 + rdTop*(rdS - 0.22*rdJ);";
function lodFor(d, s, cur){
  var t0 = LOD0*s, t1 = LOD1*s, want = d < t0 ? 0 : (d < t1 ? 1 : 2);
  if(cur != null && cur !== want){
    var edge = Math.abs(cur - want) === 1 ? (Math.min(cur, want) === 0 ? t0 : t1) : -1;
    if(edge > 0 && Math.abs(d - edge) < HYST) return cur;
  }
  return want;
}
// the water's phase (radians, 0..2 pi) at clock `sec`: every ripple speed is a whole number of turns per WATER_LOOP,
// so the wrap is seamless, and the phase depends on the clock only (never on frame times)
function waterPhase(sec){
  var t = +sec;
  if(!isFinite(t)) t = 0;
  return (((t % WATER_LOOP) + WATER_LOOP) % WATER_LOOP)/WATER_LOOP*2*Math.PI;
}
function tierOf(t){ return t != null && t !== "" && isFinite(+t) ? Math.floor(+t) : null; }
function now(){ return root.performance && root.performance.now ? root.performance.now() : Date.now(); }
function idle(fn){
  if(root.requestIdleCallback) return root.requestIdleCallback(fn, {timeout: 200});
  return setTimeout(function(){ fn({timeRemaining: function(){ return 8; }}); }, 1);
}

/* ---------- create ---------- */
function create(c, W, opts){
  opts = opts || {};
  var THREE = c.THREE, Gm = HQV.worldgeom, NT = Gm.NT, TILE = Gm.TILE, ORIGIN = Gm.ORIGIN;
  var quality = opts.quality != null ? clamp(opts.quality|0, 0, 2) : 2, lodScale = LOD_SCALE[quality], shadowsOn = quality > 0;
  var wb = {root: new THREE.Group()}, destroyed = false, nextId = 1, readyLeft = NT*NT;
  wb.root.name = "worldbuild";
  var U = {uNight: {value: 0}, uHour: {value: 20}, uFade: {value: [-1, -1, -1, -1, -1, -1, -1, -1]}, uPostUv: {value: new THREE.Vector2(0, 0)}, uWaterT: {value: 0},
           uSnow: {value: 0}, uWet: {value: 0}};   // what the weather has left on the ground (settle)
  // tier: null shows every item (ALL_TIERS in tierDiff); ground and sea only exist in v2 / island docs
  var tier = tierOf(opts.tier), hasGround = Gm.hasGround(W), seaY = Gm.seaY(W), diffs = {};
  var M = materials();
  var resolveReady, rejectReady;
  wb.ready = new Promise(function(res, rej){ resolveReady = res; rejectReady = rej; });
  wb.ready.catch(function(){});

  var tiles = [];
  for(var tz = 0; tz < NT; tz++) for(var tx = 0; tx < NT; tx++){
    var g = new THREE.Group();
    g.name = "tile " + tx + "," + tz;
    wb.root.add(g);
    tiles.push({tx: tx, tz: tz, x0: ORIGIN + tx*TILE, z0: ORIGIN + tz*TILE, g: g, lods: null, pending: false, initial: true, d: 0,
                // 3 m over the tile for instanced props (tree crowns, lamp arms); mesh() grows it over overhanging ribbons/buildings
                box: new THREE.Box3(new THREE.Vector3(ORIGIN + tx*TILE - 3, -50, ORIGIN + tz*TILE - 3), new THREE.Vector3(ORIGIN + (tx + 1)*TILE + 3, 200, ORIGIN + (tz + 1)*TILE + 3)),
                ylo: Infinity, yhi: -Infinity, m: {}});
  }
  var world = {parked: [], signs: [], gantries: [], furniture: [], built: false, meshes: {}, refillAt: null, furnGrid: null, knocked: {}, nKnocked: 0};

  /* ----- materials and shader patches ----- */
  function std(o){ return new THREE.MeshStandardMaterial(Object.assign({vertexColors: true, roughness: 0.85, metalness: 0}, o || {})); }
  function offset(m, f){ m.polygonOffset = true; m.polygonOffsetFactor = f; m.polygonOffsetUnits = f; return m; }
  function patch(m, key, vtx, frag){
    m.onBeforeCompile = function(sh){
      sh.uniforms.uNight = U.uNight; sh.uniforms.uHour = U.uHour; sh.uniforms.uFade = U.uFade; sh.uniforms.uPostUv = U.uPostUv;
      vtx(sh); frag(sh);
    };
    m.customProgramCacheKey = function(){ return "hq-wb-" + key; };
    return m;
  }
  // the hour's lit windows (games/citylife.js); without city life every code is the old flag: 0 dark, else lit at night
  var LIT_GLSL = "uniform float uHour;\n" + (HQV.cityLife && HQV.cityLife.LIT_GLSL ? HQV.cityLife.LIT_GLSL : "float hqLitAt(float code, float h){ return step(0.5, code); }");
  function rep(src, chunk, add){ return src.replace("#include <" + chunk + ">", "#include <" + chunk + ">\n" + add); }
  var FADE = "for(int i = 0; i < 8; i++){ if(abs(vBid - uFade[i]) < 0.5){ vec2 q = mod(floor(gl_FragCoord.xy), 2.0); if(q.x + q.y > 0.5) discard; } }";
  function bidVertex(sh){
    sh.vertexShader = rep(sh.vertexShader, "common", "attribute float bid;\nattribute float lit;\nvarying float vBid;\nvarying float vLit;\nvarying vec3 vWPos;\nvarying float vNy;");
    sh.vertexShader = rep(sh.vertexShader, "begin_vertex", "vBid = bid; vLit = lit; vNy = normal.y; vWPos = (modelMatrix * vec4(position, 1.0)).xyz;");
  }
  function bidPars(sh){
    sh.fragmentShader = rep(sh.fragmentShader, "common", "uniform float uNight;\nuniform float uFade[8];\nvarying float vBid;\nvarying float vLit;\nvarying vec3 vWPos;\nvarying float vNy;");
    sh.fragmentShader = rep(sh.fragmentShader, "clipping_planes_fragment", FADE);
  }
  // building body: faded-lot dither; with `bands`, window rows from fract(worldY / 3.5) on vertical walls, lit at night
  function bodyMat(bands){
    return patch(std({roughness: 0.85}), bands ? "body" : "body0", function(sh){
      sh.vertexShader = rep(sh.vertexShader, "common", "attribute float bid;\nattribute float lit;\nvarying float vBid;\nvarying float vUse;\nvarying vec3 vWPos;\nvarying float vNy;");
      sh.vertexShader = rep(sh.vertexShader, "begin_vertex", "vBid = bid; vUse = lit; vNy = normal.y; vWPos = (modelMatrix * vec4(position, 1.0)).xyz;");
    }, function(sh){
      sh.fragmentShader = rep(sh.fragmentShader, "common", "uniform float uNight;\nuniform float uFade[8];\nvarying float vBid;\nvarying float vUse;\nvarying vec3 vWPos;\nvarying float vNy;\n" + LIT_GLSL + "\nfloat hqPane(){\n  float wall = 1.0 - step(0.5, abs(vNy));\n  float fy = fract(vWPos.y / 3.5);\n  float fc = fract((vWPos.x + vWPos.z) / 2.6);\n  return wall * step(0.28, fy) * step(fy, 0.68) * step(0.18, fc) * step(fc, 0.82);\n}");
      sh.fragmentShader = rep(sh.fragmentShader, "clipping_planes_fragment", FADE);
      if(!bands) return;
      sh.fragmentShader = rep(sh.fragmentShader, "color_fragment", "float hqP = hqPane();\ndiffuseColor.rgb *= 1.0 - 0.38 * hqP;");
      sh.fragmentShader = rep(sh.fragmentShader, "emissivemap_fragment",
        "float hqH = fract(sin(dot(vec3(vBid, floor(vWPos.y / 3.5), floor((vWPos.x + vWPos.z) / 2.6)), vec3(12.9898, 78.233, 37.719))) * 43758.5453);\n" +
        // a lot with a use (city life: vUse = 2 + its LIT index) lights its rows by the hour, the rest as before
        "float hqOn = vUse < 1.5 ? step(0.55, hqH) : hqLitAt(floor(vUse + 0.5) + hqH * 0.999, uHour);\n" +
        "totalEmissiveRadiance += uNight * hqP * hqOn * vec3(1.0, 0.78, 0.45) * 0.6;");
    });
  }
  function materials(){
    var m = {};
    m.terrain = std({roughness: 0.95});
    m.asphalt = offset(roadSurface(std({roughness: 0.9}), "asphalt", ASPHALT_GLSL, ASPHALT_ROUGH), -1);
    m.marks = offset(std({roughness: 0.7}), -2);
    m.walk = offset(roadSurface(std({roughness: 0.85}), "walk", PAVING_GLSL), -3);
    m.body = bodyMat(true);
    m.body0 = bodyMat(false);   // detail 0 has real window quads: no shader rows (they would z-fight with them)
    // window quads: per-vertex lit code (games/citylife.js: by use and hour; 1 every night), emissive only at night
    m.win = offset(patch(std({roughness: 0.3, metalness: 0.25, emissive: new THREE.Color(0xffc985), emissiveIntensity: 0.5}), "win", bidVertex, function(sh){
      bidPars(sh);
      sh.fragmentShader = rep(sh.fragmentShader, "common", LIT_GLSL);
      sh.fragmentShader = rep(sh.fragmentShader, "emissivemap_fragment", "totalEmissiveRadiance *= hqLitAt(vLit, uHour) * uNight;");
    }), -1);
    // the instance colour tints the foliage only; the trunk (lit = 1 in the tree prototype) keeps its own colour
    m.trees = patch(std({roughness: 0.9}), "tree", function(sh){
      sh.vertexShader = rep(sh.vertexShader, "common", "attribute float lit;");
      sh.vertexShader = rep(sh.vertexShader, "color_vertex", "#ifdef USE_INSTANCING_COLOR\n  if(lit > 0.5) vColor.xyz = color.xyz;\n#endif");
    }, function(){});
    m.lamps = patch(std({roughness: 0.6, emissive: new THREE.Color(0xffe2a8), emissiveIntensity: 1.6}), "lamp", function(sh){
      sh.vertexShader = rep(sh.vertexShader, "common", "attribute float lit;\nvarying float vLit;");
      sh.vertexShader = rep(sh.vertexShader, "begin_vertex", "vLit = lit;");
    }, function(sh){
      sh.fragmentShader = rep(sh.fragmentShader, "common", "uniform float uNight;\nvarying float vLit;");
      sh.fragmentShader = rep(sh.fragmentShader, "emissivemap_fragment", "totalEmissiveRadiance *= vLit * uNight;");
    });
    m.cars = std({roughness: 0.45, metalness: 0.2});
    if(seaY != null || W.water) m.water = waterMat();
    if(W.water){
      m.works = std({roughness: 0.8});
      m.foam = offset(new THREE.MeshBasicMaterial({vertexColors: true, transparent: true, opacity: 0.5, depthWrite: false}), -1);
    }
    m.frame = new THREE.MeshStandardMaterial({color: 0x8a9096, roughness: 0.5, metalness: 0.5});
    m.bridge = std({roughness: 0.8});
    // [3.34] a doc with decks: the same, its lamp heads and downlights (lit 1) emissive at night
    m.bridgeLit = patch(std({roughness: 0.8, emissive: new THREE.Color(0xffe2a8), emissiveIntensity: 1.6}), "bridgelit", function(sh){
      sh.vertexShader = rep(sh.vertexShader, "common", "attribute float lit;\nvarying float vLit;");
      sh.vertexShader = rep(sh.vertexShader, "begin_vertex", "vLit = lit;");
    }, function(sh){
      sh.fragmentShader = rep(sh.fragmentShader, "common", "uniform float uNight;\nvarying float vLit;");
      sh.fragmentShader = rep(sh.fragmentShader, "emissivemap_fragment", "totalEmissiveRadiance *= vLit * uNight;");
    });
    // [3.30] a tunnel's and its cuttings' roads and structure, and its ceiling lights (always on): drawn before the sea
    // (games/ocean.js, renderOrder -10), marking the stencil (1) wherever they draw so the sea skips those pixels, as
    // games/hqmetro.js's street works do: the Commons' sea plane lies 4 m down, over the cuttings' and the tunnel's road
    // (its lights: lit = 1, emissive day and night; [3.34] a cutting's wall lights: lit = 2, emissive at night only)
    m.tunnel = stencilMark(patch(std({roughness: 0.85, emissive: new THREE.Color(0xfff1d6), emissiveIntensity: 1.3}), "tunnel", function(sh){
      sh.vertexShader = rep(sh.vertexShader, "common", "attribute float lit;\nvarying float vLit;");
      sh.vertexShader = rep(sh.vertexShader, "begin_vertex", "vLit = lit;");
    }, function(sh){
      sh.fragmentShader = rep(sh.fragmentShader, "common", "uniform float uNight;\nvarying float vLit;");
      sh.fragmentShader = rep(sh.fragmentShader, "emissivemap_fragment", "totalEmissiveRadiance *= vLit > 1.5 ? uNight : vLit;");
    }));
    ["terrain", "asphalt", "marks", "walk", "body", "body0", "trees", "bridge", "bridgeLit", "works", "tunnel"].forEach(function(k){ settle(m[k]); });
    return m;
  }
  function roadSurface(m, key, frag, rough){
    return patch(m, "rd-" + key, function(sh){
      sh.vertexShader = rep(sh.vertexShader, "common", "varying vec3 vRdW;\nvarying float vRdNy;");
      sh.vertexShader = rep(sh.vertexShader, "begin_vertex", "vRdW = (modelMatrix * vec4(position, 1.0)).xyz; vRdNy = normal.y;");
    }, function(sh){
      sh.fragmentShader = rep(sh.fragmentShader, "common", RD_GLSL);
      sh.fragmentShader = rep(sh.fragmentShader, "color_fragment", frag);
      if(rough) sh.fragmentShader = rep(sh.fragmentShader, "roughnessmap_fragment", rough);
    });
  }
  function stencilMark(m){ m.stencilWrite = true; m.stencilRef = 1; m.stencilFunc = THREE.AlwaysStencilFunc; m.stencilZPass = THREE.ReplaceStencilOp; return m; }
  // What the weather leaves on the ground (HQ 3.2, games/hqweather.js settled): snow lying in patches on whatever faces
  // up -- roads, pavements, grass, roofs, tree crowns -- and, after rain, surfaces darker and glossier where wet.
  // A patch on top of the material's own (the windows' rows, the trees' sway), keyed apart so they compile once.
  function settle(m){
    if(!m || m.userData.settled) return m;
    m.userData.settled = true;
    var prev = m.onBeforeCompile, prevKey = m.customProgramCacheKey;
    m.onBeforeCompile = function(sh, r){
      if(prev) prev.call(m, sh, r);
      sh.uniforms.uSnow = U.uSnow; sh.uniforms.uWet = U.uWet; sh.uniforms.uSetNight = U.uNight;
      sh.vertexShader = rep(sh.vertexShader, "common", "varying vec3 vSetW;");
      sh.vertexShader = rep(sh.vertexShader, "begin_vertex", "vSetW = (modelMatrix * vec4(transformed, 1.0)).xyz;");
      sh.fragmentShader = rep(sh.fragmentShader, "common", "uniform float uSnow;\nuniform float uWet;\nuniform float uSetNight;\nvarying vec3 vSetW;\n" +
        "float setH(vec2 p){ return fract(sin(dot(p, vec2(127.1, 311.7)))*43758.5453); }\n" +
        "float setN(vec2 p){ vec2 i = floor(p), f = fract(p); f = f*f*(3.0 - 2.0*f);\n" +
        "  return mix(mix(setH(i), setH(i + vec2(1.0, 0.0)), f.x), mix(setH(i + vec2(0.0, 1.0)), setH(i + vec2(1.0, 1.0)), f.x), f.y); }");
      sh.fragmentShader = rep(sh.fragmentShader, "normal_fragment_maps",
        "float setUp = clamp(dot(normal, normalize((viewMatrix*vec4(0.0, 1.0, 0.0, 0.0)).xyz)), 0.0, 1.0);\n" +
        // snow: where it faces up, in drifts and bare patches (two octaves of noise on the ground plane)
        "float setPatch = setN(vSetW.xz*0.32)*0.62 + setN(vSetW.xz*1.9)*0.38;\n" +
        "float setS = smoothstep(0.6, 0.92, setUp)*smoothstep(1.0 - uSnow, 1.0 - uSnow + 0.22, setPatch);\n" +
        "diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.92, 0.94, 0.97), setS*0.9);\n" +
        "roughnessFactor = mix(roughnessFactor, 0.8, setS);\n" +
        // wet: darker and glossier, more so on what lies flat, less where the snow is
        "float setWt = uWet*smoothstep(0.35, 0.85, setUp)*(1.0 - setS);\n" +
        "diffuseColor.rgb *= 1.0 - 0.3*setWt;\n" +
        "roughnessFactor = mix(roughnessFactor, 0.16, setWt*0.85);");
      // and a wet surface's sheen: the sky caught at a low angle (Fresnel), most down the street, dim at night
      sh.fragmentShader = rep(sh.fragmentShader, "emissivemap_fragment",
        "float setF = pow(1.0 - clamp(dot(normal, normalize(-vViewPosition)), 0.0, 1.0), 5.0);\n" +
        "totalEmissiveRadiance += vec3(0.40, 0.45, 0.50)*setWt*setF*0.14*(1.0 - 0.8*uSetNight);");
    };
    m.customProgramCacheKey = function(){ return (prevKey ? prevKey.call(m) : "std") + "+settle"; };
    return m;
  }
  // the sea: a plain colour (no vertex colours on the plane); the normal is tilted by a few travelling cosines of the
  // world position, phase uWaterT (waterPhase), with whole-number speeds so the pattern loops every WATER_LOOP s
  function waterMat(){
    var m = new THREE.MeshStandardMaterial({color: 0x23667f, roughness: 0.22, metalness: 0.05});
    m.onBeforeCompile = function(sh){
      sh.uniforms.uWaterT = U.uWaterT;
      sh.vertexShader = rep(sh.vertexShader, "common", "varying vec3 vWPos;");
      sh.vertexShader = rep(sh.vertexShader, "begin_vertex", "vWPos = (modelMatrix * vec4(position, 1.0)).xyz;");
      sh.fragmentShader = rep(sh.fragmentShader, "common", "uniform float uWaterT;\nvarying vec3 vWPos;");
      sh.fragmentShader = rep(sh.fragmentShader, "normal_fragment_maps",
        "vec2 hqW = vWPos.xz;\n" +
        "float hqDx = 0.035*cos(hqW.x*0.21 + uWaterT*86.0) + 0.02*cos((hqW.x + hqW.y)*0.37 + uWaterT*124.0);\n" +
        "float hqDz = 0.035*cos(hqW.y*0.17 - uWaterT*67.0) + 0.02*cos((hqW.x - hqW.y)*0.33 + uWaterT*105.0);\n" +
        "normal = normalize(normal + (viewMatrix * vec4(-hqDx, 0.0, -hqDz, 0.0)).xyz);");
    };
    m.customProgramCacheKey = function(){ return "hq-wb-water"; };
    return m;
  }
  // sign/gantry plates: one atlas, per-instance uv offset (aUvo); aPost vertices use the plain atlas cell
  function plateMaterial(tex){
    var m = new THREE.MeshBasicMaterial({map: tex});
    m.onBeforeCompile = function(sh){
      sh.uniforms.uPostUv = U.uPostUv;
      sh.vertexShader = rep(sh.vertexShader, "common", "attribute vec2 aUvo;\nattribute float aPost;\nuniform vec2 uPostUv;");
      sh.vertexShader = rep(sh.vertexShader, "uv_vertex", "#ifdef USE_MAP\n  vMapUv = aPost > 0.5 ? uPostUv : vMapUv + aUvo;\n#endif");
    };
    m.customProgramCacheKey = function(){ return "hq-wb-plate"; };
    return m;
  }

  /* ----- geometry helpers ----- */
  function bufGeo(G){
    if(!G || !G.idx || !G.idx.length) return null;
    var bg = new THREE.BufferGeometry();
    bg.setAttribute("position", new THREE.BufferAttribute(G.pos, 3));
    bg.setAttribute("normal", new THREE.BufferAttribute(G.nrm, 3));
    bg.setAttribute("color", new THREE.BufferAttribute(linArray(G.col), 3));
    if(G.bid) bg.setAttribute("bid", new THREE.BufferAttribute(G.bid, 1));
    if(G.lit) bg.setAttribute("lit", new THREE.BufferAttribute(G.lit, 1));
    else if(G.bid) bg.setAttribute("lit", new THREE.BufferAttribute(new Float32Array(G.pos.length/3), 1));
    bg.setIndex(new THREE.BufferAttribute(G.idx, 1));
    bg.computeBoundingSphere(); bg.computeBoundingBox();
    return bg;
  }
  function mesh(G, mat, T){
    var bg = bufGeo(G);
    if(!bg) return null;
    var me = new THREE.Mesh(bg, mat);
    me.matrixAutoUpdate = false; me.receiveShadow = true;
    if(T){
      var bb = bg.boundingBox;
      T.ylo = Math.min(T.ylo, bb.min.y); T.yhi = Math.max(T.yhi, bb.max.y);
      // road pieces and buildings are assigned by their midpoint / centre and may reach past the tile edge
      T.box.min.x = Math.min(T.box.min.x, bb.min.x); T.box.max.x = Math.max(T.box.max.x, bb.max.x);
      T.box.min.z = Math.min(T.box.min.z, bb.min.z); T.box.max.z = Math.max(T.box.max.z, bb.max.z);
    }
    return me;
  }
  // a small coloured part list -> one non-indexed BufferGeometry (position, normal, color, lit, optional aPost/uv)
  function parts(list){
    var P = [], N = [], C = [], L = [], A = [], UV = [];
    list.forEach(function(p){
      var gm = p.g.index ? p.g.toNonIndexed() : p.g;
      if(p.m) gm.applyMatrix4(p.m);
      var pos = gm.attributes.position.array, nrm = gm.attributes.normal.array, uv = gm.attributes.uv ? gm.attributes.uv.array : null;
      for(var i = 0; i < pos.length/3; i++){
        P.push(pos[3*i], pos[3*i+1], pos[3*i+2]); N.push(nrm[3*i], nrm[3*i+1], nrm[3*i+2]);
        C.push(lin(p.c[0]), lin(p.c[1]), lin(p.c[2])); L.push(p.lit || 0); A.push(p.post || 0);
        UV.push(uv ? uv[2*i]*(p.us || 1) : 0, uv ? uv[2*i+1]*(p.vs || 1) : 0);
      }
    });
    var bg = new THREE.BufferGeometry();
    bg.setAttribute("position", new THREE.Float32BufferAttribute(P, 3));
    bg.setAttribute("normal", new THREE.Float32BufferAttribute(N, 3));
    bg.setAttribute("color", new THREE.Float32BufferAttribute(C, 3));
    bg.setAttribute("lit", new THREE.Float32BufferAttribute(L, 1));
    bg.setAttribute("aPost", new THREE.Float32BufferAttribute(A, 1));
    bg.setAttribute("uv", new THREE.Float32BufferAttribute(UV, 2));
    return bg;
  }
  function at(x, y, z, ry, rx){
    var m = new THREE.Matrix4().makeRotationFromEuler(new THREE.Euler(rx || 0, ry || 0, 0, "YXZ"));
    m.setPosition(x, y, z);
    return m;
  }
  var proto = {};
  function protos(){
    if(proto.tree) return proto;
    proto.tree = parts([
      {g: new THREE.CylinderGeometry(0.12, 0.18, 1.8, 5), m: at(0, 0.9, 0), c: [0.38, 0.27, 0.18], lit: 1},   // lit = trunk: no instance tint
      {g: new THREE.ConeGeometry(1.5, 2.6, 6), m: at(0, 2.6, 0), c: [1, 1, 1]},
      {g: new THREE.ConeGeometry(1.1, 2.2, 6), m: at(0, 4.0, 0), c: [0.92, 0.95, 0.92]}
    ]);
    proto.lamp = parts([
      {g: new THREE.CylinderGeometry(0.06, 0.09, 5.2, 6), m: at(0, 2.6, 0), c: [0.32, 0.34, 0.36]},
      {g: new THREE.BoxGeometry(0.08, 0.08, 1.3), m: at(0, 5.15, 0.6), c: [0.32, 0.34, 0.36]},
      {g: new THREE.BoxGeometry(0.34, 0.12, 0.55), m: at(0, 5.05, 1.2), c: [1, 0.95, 0.82], lit: 1}
    ]);
    proto.car = parts([
      {g: new THREE.BoxGeometry(1.7, 0.6, 4.0), m: at(0, 0.6, 0), c: [1, 1, 1]},
      {g: new THREE.BoxGeometry(1.5, 0.55, 2.0), m: at(0, 1.17, -0.2), c: [0.16, 0.18, 0.22]},
      {g: new THREE.BoxGeometry(1.76, 0.5, 0.62), m: at(0, 0.3, 1.3), c: [0.08, 0.08, 0.09]},
      {g: new THREE.BoxGeometry(1.76, 0.5, 0.62), m: at(0, 0.3, -1.3), c: [0.08, 0.08, 0.09]}
    ]);
    // posts reach GANTRY_SINK under the road so they meet ground that falls away beside it (cuttings bury them)
    var gp = Gm.GANTRY_POST, gs = Gm.GANTRY_SINK;
    proto.frame = parts([
      {g: new THREE.BoxGeometry(0.3, 6.6 + gs, 0.3), m: at(-gp, (6.6 - gs)/2, 0), c: [1, 1, 1]},
      {g: new THREE.BoxGeometry(0.3, 6.6 + gs, 0.3), m: at(gp, (6.6 - gs)/2, 0), c: [1, 1, 1]},
      {g: new THREE.BoxGeometry(12.9, 0.5, 0.4), m: at(0, 6.45, 0), c: [1, 1, 1]}
    ]);
    return proto;
  }
  // city life's furniture, low-poly, front (+z) to the road; parts with lit 0 take the instance colour (a stall's
  // canopy, a parasol), the rest keep their own (the tree material's rule)
  function furnProtos(){
    if(proto.bench) return proto;
    var wood = [0.55, 0.38, 0.22], iron = [0.18, 0.19, 0.2], green = [0.16, 0.32, 0.22], steel = [0.62, 0.64, 0.66], B = THREE.BoxGeometry, Cy = THREE.CylinderGeometry;
    proto.bench = parts([
      {g: new B(1.7, 0.06, 0.46), m: at(0, 0.45, 0.02), c: wood, lit: 1}, {g: new B(1.7, 0.36, 0.05), m: at(0, 0.72, -0.2, 0, -0.18), c: wood, lit: 1},
      {g: new B(0.07, 0.45, 0.46), m: at(-0.72, 0.22, 0), c: iron, lit: 1}, {g: new B(0.07, 0.45, 0.46), m: at(0.72, 0.22, 0), c: iron, lit: 1}]);
    proto.bin = parts([{g: new Cy(0.26, 0.23, 0.9, 8), m: at(0, 0.45, 0), c: green, lit: 1}, {g: new Cy(0.29, 0.29, 0.06, 8), m: at(0, 0.93, 0), c: iron, lit: 1}]);
    var rack = [];
    [-0.8, 0, 0.8].forEach(function(x){
      rack.push({g: new B(0.05, 0.8, 0.05), m: at(x, 0.4, -0.3), c: steel, lit: 1}, {g: new B(0.05, 0.8, 0.05), m: at(x, 0.4, 0.3), c: steel, lit: 1},
                {g: new B(0.05, 0.05, 0.65), m: at(x, 0.8, 0), c: steel, lit: 1});
    });
    proto.bikerack = parts(rack);
    proto.newsstand = parts([
      {g: new B(1.6, 2.1, 1.1), m: at(0, 1.05, -0.1), c: green, lit: 1}, {g: new B(1.9, 0.12, 1.5), m: at(0, 2.16, 0), c: iron, lit: 1},
      {g: new B(1.3, 0.75, 0.04), m: at(0, 1.35, 0.46), c: [0.86, 0.84, 0.76], lit: 1}, {g: new B(1.6, 0.08, 0.35), m: at(0, 0.95, 0.6), c: wood, lit: 1}]);
    var st = [{g: new B(2.0, 0.85, 0.9), m: at(0, 0.43, 0), c: wood, lit: 1}, {g: new B(2.4, 0.08, 1.6), m: at(0, 2.25, 0.1, 0, 0.08), c: [1, 1, 1]},
              {g: new B(2.4, 0.3, 0.03), m: at(0, 2.08, 0.9), c: [1, 1, 1]}];
    [[-1.1, -0.6], [1.1, -0.6], [-1.1, 0.8], [1.1, 0.8]].forEach(function(q){ st.push({g: new B(0.06, 2.25, 0.06), m: at(q[0], 1.12, q[1]), c: iron, lit: 1}); });
    proto.stall = parts(st);
    var tb = [{g: new Cy(0.42, 0.42, 0.04, 10), m: at(0, 0.74, 0), c: [0.9, 0.9, 0.88], lit: 1}, {g: new Cy(0.04, 0.04, 2.3, 5), m: at(0, 1.15, 0), c: iron, lit: 1},
              {g: new THREE.ConeGeometry(1.35, 0.45, 8), m: at(0, 2.3, 0), c: [1, 1, 1]}];
    [0, 2.1, 4.2].forEach(function(a){
      var x = Math.sin(a)*0.72, z = Math.cos(a)*0.72;
      tb.push({g: new B(0.42, 0.05, 0.42), m: at(x, 0.45, z, a), c: wood, lit: 1}, {g: new B(0.42, 0.42, 0.05), m: at(x + Math.sin(a)*0.2, 0.68, z + Math.cos(a)*0.2, a), c: wood, lit: 1},
              {g: new B(0.04, 0.45, 0.04), m: at(x, 0.22, z), c: iron, lit: 1});
    });
    proto.table = parts(tb);
    return proto;
  }
  function plateGeo(w, h, y0, z, post, cell){
    // front face carries the cell uv (0..cell.u, 0..cell.v); back face and post use the plain cell
    var list = [
      {g: new THREE.PlaneGeometry(w, h), m: at(0, y0 + h/2, z + 0.03), c: [1, 1, 1], us: cell.u, vs: cell.v},
      {g: new THREE.PlaneGeometry(w, h), m: at(0, y0 + h/2, z - 0.03, Math.PI), c: [1, 1, 1], post: 1}
    ];
    if(post) list.push({g: new THREE.BoxGeometry(0.08, y0 + h, 0.08), m: at(0, (y0 + h)/2, z - 0.06), c: [1, 1, 1], post: 1});
    return parts(list);
  }

  /* ----- per tile results ----- */
  function drop(T, k){
    var me = T.m[k];
    if(!me) return;
    T.g.remove(me);
    if(me.geometry) me.geometry.dispose();
    T.m[k] = null;
  }
  function set(T, k, me){
    drop(T, k);
    if(me){ me.name = k; T.g.add(me); T.m[k] = me; }
  }
  function instanced(geom, mat, list, place, T, k){
    if(!list.length){ drop(T, k); return; }
    var im = new THREE.InstancedMesh(geom, mat, list.length), mtx = new THREE.Matrix4(), q = new THREE.Quaternion(),
        p = new THREE.Vector3(), s = new THREE.Vector3(), col = new THREE.Color(), e = new THREE.Euler(0, 0, 0, "YXZ");
    list.forEach(function(o, i){
      var r = place(o, i);
      e.set(0, r.yaw || 0, 0); q.setFromEuler(e); p.set(o.x, o.y, o.z); s.set(r.sx || 1, r.sy || 1, r.sz || 1);
      mtx.compose(p, q, s); im.setMatrixAt(i, mtx);
      if(r.c){ col.setRGB(r.c[0], r.c[1], r.c[2], THREE.SRGBColorSpace); im.setColorAt(i, col); }
    });
    im.instanceMatrix.needsUpdate = true;
    if(im.instanceColor) im.instanceColor.needsUpdate = true;
    im.computeBoundingSphere();
    im.receiveShadow = true; im.matrixAutoUpdate = false;
    im.userData.full = list.length;
    // geometry is shared (proto): never dispose it with the tile
    var old = T.m[k];
    if(old){ T.g.remove(old); if(old.dispose) old.dispose(); }
    im.name = k; T.g.add(im); T.m[k] = im;
  }
  function order(list){
    // a fixed pseudo-random order so a density cut drops trees evenly, not a strip of the tile
    return list.map(function(o, i){ return {o: o, h: (Math.imul(i + 1, 2654435761) >>> 0)}; })
               .sort(function(a, b){ return a.h - b.h; }).map(function(a){ return a.o; });
  }
  function apply(T, m){
    if(m.ground) T.ground = m.ground;
    if(m.terrain){ T.terrain = hasGround ? m.terrain : null; T.lods = m.lods || null; }
    // v2 ground rides in the terrain mesh (no extra draw call); a @1 tile keeps its terrain buffers as they came
    if(m.terrain || (m.ground && T.terrain)){
      set(T, "terrain", mesh(hasGround ? mergeGeo([T.terrain, T.ground]) : m.terrain, M.terrain, T));
      if(T.m.terrain) T.m.terrain.userData.tile = T.tx + "," + T.tz;
    }
    if(m.roads){
      set(T, "asphalt", mesh(m.roads.asphalt, M.asphalt, T));
      set(T, "marks", mesh(m.roads.marks, M.marks, T));
      set(T, "kerbwalk", mesh(mergeGeo([m.roads.kerb, m.roads.walk]), M.walk, T));
      set(T, "roadfar", mesh(mergeGeo([m.roads.asphalt, lifted(m.roads.marks, FAR_MARK_LIFT)]), M.asphalt, T));
      set(T, "bridge", mesh(m.roads.bridge, m.roads.bridge && m.roads.bridge.lit ? M.bridgeLit : M.bridge, T));   // none in a doc without bridges ([3.34] lit: a doc with decks)
      set(T, "tunnel", mesh(m.roads.tunnel, M.tunnel, T));   // [3.30] none in a doc without tunnels
      if(T.m.tunnel) T.m.tunnel.renderOrder = -20;          // (before the sea: the stencil)
    }
    if(m.buildings1) set(T, "body1", mesh(m.buildings1.body, M.body, T));
    if(m.buildings0){ set(T, "body0", mesh(m.buildings0.body, M.body0, T)); set(T, "win0", mesh(m.buildings0.win, M.win, T)); T.b0 = true; }
    if(m.props){
      var P = protos();
      instanced(P.tree, M.trees, order(m.props.trees), function(o){
        var pine = o.kind === "pine", c = TREE_COL[pine ? "pine" : "round"], s = o.s || 1;
        return {yaw: (o.x*7.13 + o.z*3.71) % 6.283, sx: s*(pine ? 0.75 : 1.15), sy: s*(pine ? 1.3 : 0.85), sz: s*(pine ? 0.75 : 1.15), c: c};
      }, T, "trees");
      instanced(P.lamp, M.lamps, m.props.lamps, function(o){ return {yaw: o.yaw}; }, T, "lamps");
      T.pp = {parked: m.props.parked, signs: m.props.signs, gantries: m.props.gantries, furniture: m.props.furniture || []};
      if(!T.propsIn){
        T.propsIn = true;
        world.parked = world.parked.concat(m.props.parked);
        world.signs = world.signs.concat(m.props.signs);
        world.gantries = world.gantries.concat(m.props.gantries);
        world.furniture = world.furniture.concat(T.pp.furniture);
      } else world.stale = true;   // a tier change: the world-wide lists are rebuilt once every tile's props are in
      applyDensity(T);
    }
    if(T.ylo < Infinity){ T.box.min.y = T.ylo - 1; T.box.max.y = T.yhi + 1; }
  }
  function applyDensity(T){
    var t = T.m.trees;
    if(t) t.count = Math.max(0, Math.round(t.userData.full*TREE_DENSITY[quality]));
  }

  /* ----- world-wide instanced props (built once every tile is in) ----- */
  function buildWorldProps(){
    if(world.built || destroyed) return;
    world.built = true;
    var P = protos(), keys = ["#"], meta = {};
    world.signs.forEach(function(s){ var k = "S|" + s.name + "|" + (s.ref || ""); s.key = k; if(!meta[k]){ meta[k] = {kind: "S", name: s.name, ref: s.ref}; keys.push(k); } });
    world.gantries.forEach(function(g){ var k = "G|" + g.text; g.key = k; if(!meta[k]){ meta[k] = {kind: "G", text: g.text, ref: g.ref, ring: g.text.indexOf("→") >= 0}; keys.push(k); } });
    var lay = Gm.nameAtlasLayout(keys), cw = lay.cell.w, ch = lay.cell.h, W2 = lay.cols*cw, H2 = lay.rows*ch;
    var tex = (c.canvasTex ? c.canvasTex(W2, H2, draw) : null);
    function draw(g2){
      Object.keys(lay.index).forEach(function(k){
        var i = lay.index[k], x = (i % lay.cols)*cw, y = Math.floor(i/lay.cols)*ch, md = meta[k];
        if(k === "#"){ g2.fillStyle = "#6f7378"; g2.fillRect(x, y, cw, ch); return; }
        var bg = md.kind === "S" ? "#1d5e3f" : (md.ring ? "#b7861c" : "#1d5e3f");
        g2.fillStyle = bg; g2.fillRect(x, y, cw, ch);
        g2.strokeStyle = "#f2f2ee"; g2.lineWidth = 2; g2.strokeRect(x + 3, y + 3, cw - 6, ch - 6);
        var tx2 = x + 12, text = md.kind === "S" ? md.name : md.text;
        if(md.ref){
          // route shield
          g2.fillStyle = "#f2f2ee"; g2.fillRect(x + 10, y + 9, 46, 30);
          g2.fillStyle = "#1b1f24"; g2.font = "bold 20px system-ui, sans-serif"; g2.textAlign = "center"; g2.textBaseline = "middle";
          g2.fillText(String(md.ref), x + 33, y + 25);
          tx2 = x + 64;
          if(md.kind === "G" && text.indexOf(md.ref) === 0) text = text.slice(String(md.ref).length).replace(/^\s+/, "");
        }
        g2.fillStyle = "#f6f6f2"; g2.textAlign = "left"; g2.textBaseline = "middle";
        var fs = 24;
        g2.font = "bold " + fs + "px system-ui, sans-serif";
        while(fs > 12 && g2.measureText(text).width > x + cw - 10 - tx2){ fs -= 2; g2.font = "bold " + fs + "px system-ui, sans-serif"; }
        g2.fillText(text, tx2, y + ch/2 + 1);
      });
    }
    if(!tex){ world.noAtlas = true; }
    var cu = 1/lay.cols, cv = 1/lay.rows;
    U.uPostUv.value.set(0.5*cu, 1 - 0.5*cv);   // the "#" cell (index 0): top-left
    var plateMat = tex ? plateMaterial(tex.t) : new THREE.MeshBasicMaterial({color: 0x1d5e3f});
    world.tex = tex; world.plateMat = plateMat; world.layout = lay;
    function uvOf(k){ var i = lay.index[k] || 0; return [(i % lay.cols)*cu, 1 - (Math.floor(i/lay.cols) + 1)*cv]; }
    world.signs.forEach(function(s){ s.uv = uvOf(s.key); });
    world.gantries.forEach(function(g){ g.uv = uvOf(g.key); });
    function wwMesh(geom, mat, n, withUv){
      var im = new THREE.InstancedMesh(geom, mat, Math.max(1, n));
      im.count = 0; im.frustumCulled = false; im.matrixAutoUpdate = false;
      if(withUv){ geom.setAttribute("aUvo", new THREE.InstancedBufferAttribute(new Float32Array(2*Math.max(1, n)), 2)); }
      wb.root.add(im);
      return im;
    }
    var cell = {u: cu, v: cv};
    world.meshes.parked = wwMesh(P.car, M.cars, world.parked.length);
    world.meshes.parked.castShadow = false;
    world.meshes.signs = wwMesh(plateGeo(2.4, 0.45, 2.4, 0, true, cell), plateMat, world.signs.length, true);
    world.meshes.frames = wwMesh(P.frame, M.frame, world.gantries.length);
    world.meshes.plates = wwMesh(plateGeo(6.0, 1.125, 4.95, 0.25, false, cell), plateMat, world.gantries.length, true);
    // city life: one mesh per furniture kind (none without it), and the grid furnitureAt reads
    var nk = {};
    world.furniture.forEach(function(o){ nk[o.kind] = (nk[o.kind] || 0) + 1; });
    var FP = world.furniture.length ? furnProtos() : null;
    FURN.forEach(function(k){ if(nk[k] && FP[k]){ var im = world.meshes["f:" + k] = wwMesh(FP[k], M.trees, nk[k]); im.castShadow = false; im.name = "furniture " + k; } });
    world.furnGrid = furnGrid(world.furniture);
    world.refillAt = null;
  }
  // the world-wide props again, from every tile's current props (after a tier change)
  function rebuildWorldProps(){
    Object.keys(world.meshes).forEach(function(k){ var im = world.meshes[k]; if(im){ wb.root.remove(im); im.geometry.dispose(); if(im.dispose) im.dispose(); } });
    if(world.plateMat) world.plateMat.dispose();
    if(world.tex && world.tex.t) world.tex.t.dispose();
    world.parked = []; world.signs = []; world.gantries = []; world.furniture = [];
    tiles.forEach(function(T){
      if(!T.pp) return;
      world.parked = world.parked.concat(T.pp.parked); world.signs = world.signs.concat(T.pp.signs); world.gantries = world.gantries.concat(T.pp.gantries);
      world.furniture = world.furniture.concat(T.pp.furniture || []);
    });
    world.meshes = {}; world.built = false; world.stale = false;
    buildWorldProps();
  }
  function refillWorld(cx, cz, map){
    var mm = world.meshes;
    if(!mm.parked) return;
    var r2 = PROPS_NEAR*PROPS_NEAR, mtx = new THREE.Matrix4(), q = new THREE.Quaternion(), p = new THREE.Vector3(),
        one = new THREE.Vector3(1, 1, 1), col = new THREE.Color(), e = new THREE.Euler(0, 0, 0, "YXZ");
    function near(o){ var dx = o.x - cx, dz = o.z - cz; return !map && dx*dx + dz*dz < r2; }
    function put(im, i, o, yaw){ e.set(0, yaw, 0); q.setFromEuler(e); p.set(o.x, o.y, o.z); mtx.compose(p, q, one); im.setMatrixAt(i, mtx); }
    var n = 0;
    world.parked.forEach(function(o){ if(!near(o)) return; put(mm.parked, n, o, o.yaw); col.setHex(o.color); mm.parked.setColorAt(n, col); n++; });
    mm.parked.count = n;
    n = 0;
    var su = mm.signs.geometry.attributes.aUvo;
    world.signs.forEach(function(o){ if(!near(o)) return; put(mm.signs, n, o, o.yaw); su.setXY(n, o.uv[0], o.uv[1]); n++; });
    mm.signs.count = n;
    var nf = 0, np = 0, pu = mm.plates.geometry.attributes.aUvo;
    world.gantries.forEach(function(o){
      if(!near(o)) return;
      if(o.frame) put(mm.frames, nf++, o, o.yaw);
      put(mm.plates, np, o, o.yaw); pu.setXY(np, o.uv[0], o.uv[1]); np++;
    });
    mm.frames.count = nf; mm.plates.count = np;
    var fm = [], fn = {};
    world.furniture.forEach(function(o){
      var im = mm["f:" + o.kind];
      if(!im || !near(o) || (world.nKnocked && world.knocked[furnKeyOf(o)])) return;   // [play-street] knocked over: city play draws it
      var i = fn[o.kind] || 0;
      put(im, i, o, o.yaw);
      if(o.c){ col.setRGB(o.c[0], o.c[1], o.c[2], THREE.SRGBColorSpace); im.setColorAt(i, col); }
      fn[o.kind] = i + 1;
    });
    FURN.forEach(function(k){ var im = mm["f:" + k]; if(im){ im.count = fn[k] || 0; fm.push(im); } });
    [mm.parked, mm.signs, mm.frames, mm.plates].concat(fm).forEach(function(im){
      im.instanceMatrix.needsUpdate = true;
      if(im.instanceColor) im.instanceColor.needsUpdate = true;
      if(im.geometry.attributes.aUvo) im.geometry.attributes.aUvo.needsUpdate = true;
      im.visible = im.count > 0;
    });
    world.refillAt = {x: cx, z: cz, map: map};
  }

  // furniture by FURN_CELL m cell (each in every cell its radius reaches, + 0.5 m for a pad), for furnitureAt
  function furnKey(i, j){ return (i + 4096)*8192 + (j + 4096); }
  // [play-street] one piece of furniture's key (its kind and place, to the decimetre): what furnitureKnock takes
  function furnKeyOf(o){ return o.kind + ":" + Math.round(o.x*10) + ":" + Math.round(o.z*10); }
  function furnGrid(list){
    if(!list.length) return null;
    var G = {};
    list.forEach(function(o){
      var r = (FURN_R[o.kind] || 0.5) + 0.5;
      for(var i = Math.floor((o.x - r)/FURN_CELL); i <= Math.floor((o.x + r)/FURN_CELL); i++)
        for(var j = Math.floor((o.z - r)/FURN_CELL); j <= Math.floor((o.z + r)/FURN_CELL); j++){ var k = furnKey(i, j); (G[k] = G[k] || []).push(o); }
    });
    return G;
  }

  /* ----- jobs: worker first, main thread in idle slices as the fallback ----- */
  var worker = null, workerUp = false, useWorker = false, queue = [], inflight = {}, nIn = 0, idleOn = false;
  // the tiles (per product) that differ between two tiers, cached per pair
  function diffOf(a, b){
    var k = a + ">" + b;
    return diffs[k] || (diffs[k] = Gm.tierDiff(W, a == null ? ALL_TIERS : a, b == null ? ALL_TIERS : b));
  }
  var PRODUCT = {terrain: "terrain", roads: "roads", ground: "ground", buildings0: "buildings", buildings1: "buildings", props: "props"};
  function markDirty(T, p){ (T.dirty = T.dirty || {})[p] = true; }
  function done(T, m, job){
    T.pending = false;
    if(destroyed) return;
    apply(T, m);
    var jt = job ? job.tier : tier, key = T.tx + "," + T.tz;
    if(jt !== tier){
      // built at a tier that is no longer shown: redo whatever this tile shows differently now
      var d = diffOf(jt, tier);
      Object.keys(d).forEach(function(p){ if(d[p].indexOf(key) >= 0) markDirty(T, p); });
    } else if(T.dirty){
      Object.keys(PRODUCT).forEach(function(k){ if(m[k] && (k !== "buildings1" || m.buildings0 || !T.b0)) delete T.dirty[PRODUCT[k]]; });
      if(!Object.keys(T.dirty).length) T.dirty = null;
    }
    if(T.initial){
      T.initial = false;
      if(--readyLeft === 0){ buildWorldProps(); resolveReady(wb); }
    }
  }
  var warned = false;
  function warn(err){ if(warned) return; warned = true; try { console.warn("hq-worldbuild: tile failed: " + ((err && err.message) || err)); } catch(e){} }
  function fail(err){ if(readyLeft > 0) rejectReady(err instanceof Error ? err : new Error(String(err))); }
  function onMessage(ev){
    var m = ev.data || {};
    if(m.op === "ready"){ workerUp = true; pump(); return; }
    var job = inflight[m.id];
    if(!job) return;
    delete inflight[m.id]; nIn--;
    if(m.op === "error"){ toMain("worker job: " + m.message, job); return; }
    done(job.T, m, job);
    pump();
  }
  // move everything to the main thread (the worker died or cannot build)
  function toMain(why, job){
    if(useWorker){
      try { console.warn("hq-worldbuild: main-thread fallback (" + why + ")"); } catch(e){}
      useWorker = false;
      if(worker){ try { worker.terminate(); } catch(e){} worker = null; }
    }
    var back = Object.keys(inflight).map(function(k){ return inflight[k]; });
    if(job) back.push(job);
    inflight = {}; nIn = 0;
    queue = back.concat(queue);
    pump();
  }
  function startWorker(){
    if(opts.worker === false || typeof root.Worker !== "function") return;
    try {
      worker = new root.Worker("/games/worldbuild-worker.js");
      useWorker = true;
      worker.onmessage = onMessage;
      worker.onerror = function(e){ if(e && e.preventDefault) e.preventDefault(); toMain("error " + ((e && e.message) || "")); };
      var Wc = {};
      for(var k in W) if(Object.prototype.hasOwnProperty.call(W, k)) Wc[k] = W[k];
      Wc.index = null;   // world.js rebuilds its lazy index in the worker
      worker.postMessage({op: "init", W: Wc});
    } catch(e){ worker = null; useWorker = false; }
  }
  function send(job){
    if(useWorker){
      if(!workerUp) return false;
      inflight[job.id] = job; nIn++;
      try { worker.postMessage({op: "tile", id: job.id, tx: job.tx, tz: job.tz, lods: job.lods, want: job.want, tier: job.tier, gap: job.gap}); }
      catch(e){ toMain("post " + e.message); }
      return true;
    }
    return false;
  }
  function pump(){
    if(destroyed) return;
    if(useWorker){
      while(nIn < MAX_INFLIGHT && queue.length && workerUp) send(queue.shift());
      return;
    }
    if(idleOn || !queue.length) return;
    idleOn = true;
    idle(function(dl){
      idleOn = false;
      if(destroyed) return;
      var n = 0;
      while(queue.length && (n === 0 || (dl && dl.timeRemaining && dl.timeRemaining() > 2))){
        var job = queue.shift(), m;
        n++;
        try { m = Gm.buildTile(W, job); } catch(err){ job.T.pending = false; warn(err); fail(err); continue; }
        done(job.T, m, job);
      }
      pump();
    });
  }
  function request(T, want, lods){
    T.pending = true;
    var job = {id: nextId++, T: T, tx: T.tx, tz: T.tz, lods: lods, want: want, tier: tier};
    if(opts.gap) job.gap = true;
    queue.push(job);
  }

  /* ----- per frame ----- */
  function tileDist(T, x, z){
    var dx = Math.max(T.x0 - x, 0, x - (T.x0 + TILE)), dz = Math.max(T.z0 - z, 0, z - (T.z0 + TILE));
    return Math.sqrt(dx*dx + dz*dz);
  }
  function wantLods(T, x, z, map){
    var out = [];
    for(var cz = 0; cz < 4; cz++) for(var cx = 0; cx < 4; cx++){
      if(map){ out.push(2); continue; }
      var mx = T.x0 + cx*64 + 32, mz = T.z0 + cz*64 + 32, d = Math.sqrt((mx - x)*(mx - x) + (mz - z)*(mz - z));
      out.push(lodFor(d, lodScale, T.lods ? T.lods[cz*4 + cx] : null));
    }
    return out;
  }
  function same(a, b){
    if(!a || !b || a.length !== b.length) return false;
    for(var i = 0; i < a.length; i++) if(a[i] !== b[i]) return false;
    return true;
  }
  var stats = {drawCalls: 0, triangles: 0, tiles: 0, pending: 0, worker: false};
  function tris(me){
    if(!me || !me.visible || !me.geometry) return 0;
    var g = me.geometry, n = g.index ? g.index.count : g.attributes.position.count;
    return me.isInstancedMesh ? n/3*me.count : n/3;
  }
  wb.update = function(cam){
    if(destroyed || !cam) return;
    var x = +cam.x || 0, z = +cam.z || 0, map = cam.mode === "map", fr = cam.frustum || null;
    var dc = 0, tri = 0, nt = 0, req = [];
    // queued (not yet started) work is re-decided below from the fresh camera
    queue = queue.filter(function(j){ if(j.T.initial) return true; j.T.pending = false; return false; });
    tiles.forEach(function(T){
      var d = tileDist(T, x, z), m = T.m;
      T.d = d;
      if(T.initial) return;
      var vis = !fr || fr.intersectsBox(T.box);
      T.g.visible = vis;
      // what this tile should be built at
      var lods = wantLods(T, x, z, map), b0 = !map && d < B0_NEAR*lodScale;
      if(!T.pending){
        var want = [], dirty = T.dirty || {};
        if(!same(lods, T.lods) || dirty.terrain) want.push("terrain");
        if(dirty.roads) want.push("roads");
        if(dirty.ground && hasGround) want.push("ground");
        if(dirty.buildings) want.push("buildings1");
        if((b0 && !T.b0) || (dirty.buildings && T.b0)) want.push("buildings0");
        if(dirty.props) want.push("props");
        if(want.length) req.push({T: T, want: want, lods: lods, d: d});
      }
      if(!b0 && T.b0 && d > 2*B0_NEAR){ drop(T, "body0"); drop(T, "win0"); T.b0 = false; }   // free far detail
      var near = !map && d < NEAR, useB0 = b0 && !!T.b0;
      if(m.asphalt) m.asphalt.visible = near;
      if(m.marks) m.marks.visible = near;
      if(m.kerbwalk) m.kerbwalk.visible = near;
      if(m.roadfar) m.roadfar.visible = !near;
      if(m.body0) m.body0.visible = useB0;
      if(m.win0) m.win0.visible = useB0;
      if(m.body1) m.body1.visible = !useB0;
      var pr = !map && d < PROPS_NEAR;
      if(m.trees) m.trees.visible = pr;
      if(m.lamps) m.lamps.visible = pr;
      var cast = shadowsOn && !map && d < SHADOW_NEAR;
      ["body0", "body1", "trees", "lamps", "bridge"].forEach(function(k){ if(m[k]) m[k].castShadow = cast; });
      if(vis){
        nt++;
        for(var k in m){ var me = m[k]; if(me && me.visible && (!me.isInstancedMesh || me.count > 0)){ dc++; tri += tris(me); } }
      }
    });
    // requests: nearest first
    req.sort(function(a, b){ return a.d - b.d; }).forEach(function(r){ if(!r.T.pending) request(r.T, r.want, r.lods); });
    pump();
    // world-wide props within 300 m (refill when the camera moved 15 m or the mode changed); after a tier change
    // they are rebuilt once no tile still owes its props
    if(world.built && world.stale && tiles.every(function(T){ return !(T.dirty && T.dirty.props); })){ rebuildWorldProps(); world.refillAt = null; }
    var rf = world.refillAt;
    if(world.built && (!rf || rf.map !== map || Math.abs(rf.x - x) > 15 || Math.abs(rf.z - z) > 15)) refillWorld(x, z, map);
    ["parked", "signs", "frames", "plates"].concat(FURN.map(function(k){ return "f:" + k; })).forEach(function(k){
      var im = world.meshes[k];
      if(im && im.visible && im.count > 0){ dc++; tri += tris(im); }
    });
    if(sea){
      U.uWaterT.value = waterPhase(isFinite(+cam.time) && cam.time != null ? +cam.time : now()/1000);
      // never frustum-toggled: it spans every view, and its owner may hide it for good (the City does, under the ocean)
      if(sea.visible){ dc++; tri += tris(sea); }
    }
    // the mounted ocean's calm water (its tint, glint and ripples, no waves), else the sea plane's
    var om = (river || lakes) && HQV.ocean && HQV.ocean.riverMaterial ? HQV.ocean.riverMaterial() : null;
    if(river){
      river.material = om || M.water;
      river.visible = !fr || fr.intersectsObject(river);
      if(river.visible){ dc++; tri += tris(river); }
    }
    // @3 water: the bodies' surface (calm, lakes in the lake variant), quays and the rest, the foam
    [lakes, works, foam].forEach(function(me){
      if(!me) return;
      if(me === lakes) me.material = om || M.water;
      me.visible = !fr || fr.intersectsObject(me);
      if(me.visible){ dc++; tri += tris(me); }
    });
    stats = {drawCalls: dc, triangles: Math.round(tri), tiles: nt, pending: queue.length + nIn, worker: useWorker};
  };
  // show the world as city tier t: only the tiles (and products) tierDiff names are rebuilt; -> how many tiles
  wb.setTier = function(t){
    t = tierOf(t);
    if(destroyed || t === tier) return 0;
    var d = diffOf(tier, t), n = {};
    tier = t;
    tiles.forEach(function(T){
      var key = T.tx + "," + T.tz;
      Object.keys(d).forEach(function(p){ if(d[p].indexOf(key) >= 0){ markDirty(T, p); n[key] = 1; } });
    });
    return Object.keys(n).length;
  };
  wb.tier = function(){ return tier; };
  wb.setNight = function(on){ U.uNight.value = on ? 1 : 0; };
  // the City's local hour (0..24) for city life's lit windows and shopfronts (citylife.js litAt / LIT_GLSL)
  wb.setHour = function(h){ h = +h; if(isFinite(h)) U.uHour.value = ((h % 24) + 24) % 24; };
  // the footpath furniture standing at (x, z) (its kind, with `pad` m more reach), else null: the drawn props at the
  // current tier, for blocked()
  wb.furnitureAt = function(x, z, pad){
    var G = world.furnGrid;
    if(!G) return null;
    var L = G[furnKey(Math.floor(x/FURN_CELL), Math.floor(z/FURN_CELL))];
    if(!L) return null;
    pad = +pad || 0;
    for(var i = 0; i < L.length; i++){
      var o = L[i], r = FURN_R[o.kind] + pad, dx = x - o.x, dz = z - o.z;
      if(dx*dx + dz*dz < r*r && !(world.nKnocked && world.knocked[furnKeyOf(o)])) return o.kind;
    }
    return null;
  };
  // [play-street] the piece itself ({kind, x, y, z, yaw, c?}, a knocked-over one skipped) at (x, z) with pad m more reach
  wb.furnitureNear = function(x, z, pad){
    var G = world.furnGrid; if(!G) return null;
    var L = G[furnKey(Math.floor(x/FURN_CELL), Math.floor(z/FURN_CELL))]; if(!L) return null;
    pad = +pad || 0;
    var best = null, bd = Infinity;
    for(var i = 0; i < L.length; i++){
      var o = L[i], r = FURN_R[o.kind] + pad, dx = x - o.x, dz = z - o.z, d = dx*dx + dz*dz;
      if(d < r*r && d < bd && !(world.nKnocked && world.knocked[furnKeyOf(o)])){ bd = d; best = o; }
    }
    return best;
  };
  wb.furnitureKey = furnKeyOf;
  // [play-street] knock a piece over (on) or stand it up again: a knocked one is not drawn here and does not block
  wb.furnitureKnock = function(o, on){
    if(!o || !o.kind) return false;
    var k = furnKeyOf(o), was = !!world.knocked[k];
    if(!!on === was) return false;
    if(on){ world.knocked[k] = 1; world.nKnocked++; } else { delete world.knocked[k]; world.nKnocked = Math.max(0, world.nKnocked - 1); }
    var R = world.refillAt;
    if(R && !R.map) refillWorld(R.x, R.z, R.map);
    return true;
  };
  // [play-street] a one-off copy of a piece (its kind's own geometry and material, its colour) for city play to move:
  // an InstancedMesh of one at the origin; dispose it with .dispose() (the geometry and material stay the City's)
  wb.furnitureMesh = function(o){
    var im = o && world.meshes["f:" + o.kind]; if(!im) return null;
    var m = new THREE.InstancedMesh(im.geometry, im.material, 1);
    m.setMatrixAt(0, new THREE.Matrix4());
    if(o.c){ m.setColorAt(0, new THREE.Color().setRGB(o.c[0], o.c[1], o.c[2], THREE.SRGBColorSpace)); }
    m.frustumCulled = false; m.castShadow = false; m.name = "furniture " + o.kind + " (knocked)";
    return m;
  };
  // the weather on the ground (games/hqweather.js settled): snow cover and wetness, 0..1 each
  wb.setGround = function(snow, wet){ U.uSnow.value = Math.max(0, Math.min(1, +snow || 0)); U.uWet.value = Math.max(0, Math.min(1, +wet || 0)); };
  wb.settle = settle;                                       // for the City's own materials (the park)
  wb.setFaded = function(ids){
    var v = U.uFade.value, k = 0;
    (ids || []).forEach(function(id){ var n = typeof id === "number" ? id : (typeof id === "string" && /^\d+$/.test(id) ? +id : NaN); if(k < 8 && isFinite(n)) v[k++] = n; });
    for(; k < 8; k++) v[k] = -1;
  };
  wb.terrainMeshes = function(){ return tiles.map(function(T){ return T.m.terrain; }).filter(Boolean); };
  // runtime quality (governor or Settings pin) toggles shadows only; LOD scale and tree density stay as created
  wb.setQuality = function(q){ shadowsOn = clamp(q|0, 0, 2) > 0; };
  wb.stats = function(){ return {drawCalls: stats.drawCalls, triangles: stats.triangles, tiles: stats.tiles, pending: queue.length + nIn, worker: useWorker}; };
  wb.destroy = function(){
    if(destroyed) return;
    destroyed = true;
    if(worker){ try { worker.terminate(); } catch(e){} worker = null; }
    queue = []; inflight = {};
    tiles.forEach(function(T){ Object.keys(T.m).forEach(function(k){ var me = T.m[k]; if(me && !me.isInstancedMesh && me.geometry) me.geometry.dispose(); if(me && me.isInstancedMesh && me.dispose) me.dispose(); }); });
    Object.keys(world.meshes).forEach(function(k){ var im = world.meshes[k]; if(im){ im.geometry.dispose(); if(im.dispose) im.dispose(); } });
    if(sea) sea.geometry.dispose();
    if(river) river.geometry.dispose();
    [lakes, works, foam].forEach(function(me){ if(me) me.geometry.dispose(); });
    Object.keys(proto).forEach(function(k){ proto[k].dispose(); });
    Object.keys(M).forEach(function(k){ M[k].dispose(); });
    if(world.plateMat) world.plateMat.dispose();
    if(world.tex && world.tex.t) world.tex.t.dispose();
    if(wb.root.parent) wb.root.parent.remove(wb.root);
    fail(new Error("worldbuild destroyed"));
  };

  // the sea: one plane at sea level, SEA_SPAN times the world across
  var sea = null;
  if(seaY != null){
    var span = SEA_SPAN*NT*TILE;
    sea = new THREE.Mesh(new THREE.PlaneGeometry(span, span, 1, 1), M.water);
    sea.name = "sea"; sea.rotation.x = -Math.PI/2; sea.position.y = seaY; sea.receiveShadow = true;
    sea.updateMatrix(); sea.matrixAutoUpdate = false;
    wb.root.add(sea);
  }
  wb.sea = sea;
  // the river's water: one mesh over Layers.river.poly just over sea level (worldgeom riverWater; none without a sea)
  var river = null, rg = seaY != null && W.river ? bufGeo(Gm.riverWater(W)) : null;
  if(rg){
    rg.setAttribute("aLake", new THREE.BufferAttribute(new Float32Array(rg.attributes.position.count), 1));   // river, not lake
    river = new THREE.Mesh(rg, M.water);
    river.name = "river"; river.receiveShadow = true; river.matrixAutoUpdate = false;
    wb.root.add(river);
  }
  wb.river = river;
  // @3 water (worldgeom waterGeo): one mesh for every body's surface, one for quays, breakwater and plants, one of foam
  var lakes = null, works = null, foam = null;
  if(W.water){
    var wg = Gm.waterGeo(W), sg = bufGeo(wg.surface);
    if(sg){
      sg.setAttribute("aLake", new THREE.BufferAttribute(wg.surface.lit, 1));
      lakes = new THREE.Mesh(sg, M.water);
      lakes.name = "water"; lakes.receiveShadow = true; lakes.matrixAutoUpdate = false;
      wb.root.add(lakes);
    }
    works = mesh(wg.works, M.works);
    if(works){ works.name = "waterworks"; works.castShadow = true; wb.root.add(works); }
    foam = mesh(wg.foam, M.foam);
    if(foam){ foam.name = "foam"; foam.receiveShadow = false; foam.renderOrder = 1; wb.root.add(foam); }
  }
  wb.water = {surface: lakes, works: works, foam: foam};

  // first pass: every tile at lod 2 with roads, far buildings and props (and the v2 ground), nearest the centre first
  tiles.slice().sort(function(a, b){
    return Math.hypot(a.x0 + TILE/2, a.z0 + TILE/2) - Math.hypot(b.x0 + TILE/2, b.z0 + TILE/2);
  }).forEach(function(T){
    request(T, hasGround ? ["terrain", "roads", "ground", "buildings1", "props"] : ["terrain", "roads", "buildings1", "props"],
            [2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2]);
  });
  startWorker();
  pump();
  return wb;
}

HQV.worldbuild = {create: create, governor: governor, mergeGeo: mergeGeo, lodFor: lodFor, waterPhase: waterPhase,
                  LIMITS: {near: NEAR, props: PROPS_NEAR, b0: B0_NEAR, lod0: LOD0, lod1: LOD1, shadow: SHADOW_NEAR}};
})();
