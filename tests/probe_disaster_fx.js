/* Live-path proof for disaster VISUALS: does every kind actually build a scene?
   Drives the REAL fxNew / fxTex / fxPart / fxStart / fxTick sliced out of games/strike.js
   against a THREE stub that counts meshes, lines, sprites and per-kind artefacts.
   Numbers, not flags. Run: node tests/probe_disaster_fx.js */
var fs = require("fs");
var path = require("path");
var root = path.resolve(__dirname, "..");
var src = fs.readFileSync(root + "/games/strike.js", "utf8");

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
function sliceIndentFn(name){
  // the indented ones (inside the R3 closure): "    function name("
  var needle = "function " + name + "(";
  var i = src.indexOf(needle);
  while(i >= 0){
    // prefer the one that is indented (4 spaces) — those are the fx helpers
    var ls = src.lastIndexOf("\n", i) + 1;
    if(src.slice(ls, i) === "    " || src.slice(ls, i) === "\t") return sliceFn(name);
    i = src.indexOf(needle, i + 1);
  }
  return sliceFn(name);
}

// ---- THREE stub: counts what the real code builds ----
function Mesh(geo, mat){
  this.geometry = geo; this.material = mat;
  this.position = {x:0,y:0,z:0,set:function(x,y,z){this.x=x;this.y=y;this.z=z;},};
  this.rotation = {x:0,y:0,z:0,set:function(x,y,z){this.x=x;this.y=y;this.z=z;}};
  this.scale = {x:1,y:1,z:1,setScalar:function(s){this.x=s;this.y=s;this.z=s;},set:function(a,b,c){this.x=a;this.y=b;this.z=c;}};
  this.visible = true; this.userData = {};
  THREE_STATS.meshes++;
}
function Line(geo, mat){
  this.geometry = geo; this.material = mat;
  this.position = {x:0,y:0,z:0,set:function(x,y,z){this.x=x;this.y=y;this.z=z;}};
  this.rotation = {x:0,y:0,z:0,set:function(x,y,z){this.x=x;this.y=y;this.z=z;}};
  this.scale = {x:1,y:1,z:1,setScalar:function(s){this.x=s;this.y=s;this.z=s;}};
  this.visible = true; this.userData = {};
  THREE_STATS.lines++;
}
function Sprite(mat){
  this.material = mat;
  this.position = {x:0,y:0,z:0,set:function(x,y,z){this.x=x;this.y=y;this.z=z;}};
  this.rotation = {x:0,y:0,z:0,set:function(x,y,z){this.x=x;this.y=y;this.z=z;}};
  this.scale = {x:1,y:1,z:1,setScalar:function(s){this.x=s;this.y=s;this.z=s;}};
  this.visible = true; this.userData = {};
  THREE_STATS.sprites++;
}
function Group(){
  this.children = []; this.position = {x:0,y:0,z:0,set:function(x,y,z){this.x=x;this.y=y;this.z=z;}};
  this.rotation = {x:0,y:0,z:0,set:function(x,y,z){this.x=x;this.y=y;this.z=z;}};
  this.scale = {x:1,y:1,z:1,setScalar:function(s){this.x=s;this.y=s;this.z=s;}};
  this.add = function(o){ this.children.push(o); return this; };
  this.remove = function(o){ var i = this.children.indexOf(o); if(i>=0) this.children.splice(i,1); return this; };
  THREE_STATS.groups++;
}
function Geo(){ this.points = null; }
Geo.prototype.setFromPoints = function(p){ this.points = p; return this; };
Geo.prototype.rotateX = function(){ return this; };
Geo.prototype.dispose = function(){};
function BoxGeometry(){ THREE_STATS.geos++; return new Geo(); }
function CylinderGeometry(){ THREE_STATS.geos++; return new Geo(); }
function CircleGeometry(){ THREE_STATS.geos++; return new Geo(); }
function RingGeometry(){ THREE_STATS.geos++; return new Geo(); }
function ConeGeometry(){ THREE_STATS.geos++; return new Geo(); }
function PlaneGeometry(){ THREE_STATS.geos++; return new Geo(); }
function BufferGeometry(){ THREE_STATS.geos++; return new Geo(); }
function MeshBasicMaterial(o){ Object.assign(this, o || {}); THREE_STATS.mats++; }
function MeshLambertMaterial(o){ Object.assign(this, o || {}); THREE_STATS.mats++; }
function LineBasicMaterial(o){ Object.assign(this, o || {}); THREE_STATS.mats++; }
function SpriteMaterial(o){ Object.assign(this, o || {}); THREE_STATS.mats++; }
function CanvasTexture(){ this.colorSpace = ""; }
// fxTex paints into a canvas — stub just enough for it to run
var document = {
  createElement: function(tag){
    return {
      width: 32, height: 32,
      getContext: function(){
        return {
          createRadialGradient: function(){
            return {addColorStop: function(){}};
          },
          fillRect: function(){},
          fillStyle: null
        };
      }
    };
  }
};

var THREE_STATS = {meshes:0, lines:0, sprites:0, groups:0, geos:0, mats:0};
var THREE = {
  Sprite: Sprite, SpriteMaterial: SpriteMaterial,
  Mesh: Mesh, Group: Group, Line: Line,
  BoxGeometry: BoxGeometry, CylinderGeometry: CylinderGeometry, CircleGeometry: CircleGeometry,
  RingGeometry: RingGeometry, ConeGeometry: ConeGeometry, PlaneGeometry: PlaneGeometry,
  BufferGeometry: BufferGeometry,
  MeshBasicMaterial: MeshBasicMaterial, MeshLambertMaterial: MeshLambertMaterial,
  LineBasicMaterial: LineBasicMaterial,
  CanvasTexture: CanvasTexture,
  Vector3: function(x,y,z){ this.x=x; this.y=y; this.z=z; },
  DoubleSide: 2, BackSide: 1, SRGBColorSpace: "srgb"
};

function resetStats(){ THREE_STATS = {meshes:0, lines:0, sprites:0, groups:0, geos:0, mats:0}; }

// ---- closures the fx helpers expect ----
var V = {booms: [], disasters: [], disasterMarks: []};
var MAP = {bounds: [-30, -1, -24, 30, 12, 24], boxes: [], pickups: []};
var TOTEMS = {};
var DIS = ["sandstorm","meteorshower","hurricane","thunder","earthquake","shockring",
           "toxicfog","absolutezero","sinkhole","emp"];
DIS.forEach(function(k){ TOTEMS[k] = {n: k}; });
var DD_SINK_R = 4.5, DD_TOXIC_R = 5, DD_TOXIC_ZONES = 3, DD_WIND_R = 6;
var FS = {
  mb32: function(a){ a = (a|0) + 0x6D2B79F5; var t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; },
  overlaps: function(){ return -1; }
};
function hashMatch(seed, salt){ var x = (seed ^ (salt*0x9e3779b9))|0; return ((x >>> 0) / 4294967295); }
function clamp(v,a,b){ return v<a?a:(v>b?b:v); }
function disSpot(seed, salt){
  var x = FS.mb32((seed + salt) & 0xFFFF), z = FS.mb32((seed + salt*3) & 0xFFFF);
  return [(x - 0.5) * 40, 0, (z - 0.5) * 30];
}
function boltPts(seed, salt, x0, y0, z0, x1, y1, z1, segs, jitter){
  var pts = [];
  for(var i = 0; i <= segs; i++){
    var u = i / segs;
    var j = (i === 0 || i === segs) ? 0 : (FS.mb32((seed + salt*7 + i*13) & 0xFFFF) - 0.5) * (jitter || 1) * 2;
    pts.push([x0 + (x1 - x0) * u + j, y0 + (y1 - y0) * u, z0 + (z1 - z0) * u + j * 0.6]);
  }
  return pts;
}
function boltBranch(pts, seed, salt, at){
  if(!pts || pts.length < 2) return null;
  var i = Math.min(pts.length - 2, Math.max(0, at|0));
  var p = pts[i];
  return [p, [p[0] + 1.2, p[1] - 2, p[2] + 0.8]];
}

// scene stubs
var scene = {
  fog: {near: 36, far: 120, color: {set: function(){}, getHex: function(){ return 0xabcdef; }}},
  background: {set: function(){}, getHex: function(){ return 0x123456; }}
};
var sun = {intensity: 1.8};
var hemi = {intensity: 1.1};
var fill = {intensity: 0.4};
var dyn = new Group();
var R = {boom: function(){}, ring: function(){}, disaster: function(){}};

// ---- slice + bind the real helpers ----
function build(){
  var params = ["THREE","V","MAP","TOTEMS","DD_SINK_R","DD_TOXIC_R","DD_TOXIC_ZONES","DD_WIND_R",
                "FS","hashMatch","clamp","disSpot","boltPts","boltBranch",
                "scene","sun","hemi","fill","dyn","document","R"];
  var body = [
    "var fxList = [], fxBase = null, fxMarkSeen = {}, fxBoomSeen = {};",
    "var TEX_SNOW = null, TEX_DUST = null, TEX_TOXIC = null, TEX_ROCK = null, TEX_FIRE = null, TEX_FROST = null;",
    sliceIndentFn("fxNew"),
    sliceIndentFn("fxTex"),
    sliceIndentFn("fxEnsureTex"),
    sliceIndentFn("fxPart"),
    sliceIndentFn("fxStop"),
    sliceIndentFn("fxStart"),
    sliceIndentFn("fxTick"),
    "return {fxNew:fxNew, fxTex:fxTex, fxPart:fxPart, fxStop:fxStop, fxStart:fxStart, fxTick:fxTick, fxList: function(){ return fxList; }};"
  ].join("\n");
  // Function.bind.apply pre-fills the param list + body; calling build() yields the fn,
  // then we invoke THAT with the real values (never append values after the body).
  var makeFn = Function.bind.apply(Function, [null].concat(params.concat([body])));
  var fn = makeFn();
  return fn(THREE, V, MAP, TOTEMS, DD_SINK_R, DD_TOXIC_R, DD_TOXIC_ZONES, DD_WIND_R,
    FS, hashMatch, clamp, disSpot, boltPts, boltBranch, scene, sun, hemi, fill, dyn, document, R);
}

var api = build();
var out = {kinds: {}, errors: []};

function countTree(g, acc){
  acc = acc || {meshes:0, lines:0, sprites:0, groups:0};
  if(!g || !g.children) return acc;
  for(var i = 0; i < g.children.length; i++){
    var c = g.children[i];
    if(c && c.children && c.add) { acc.groups++; countTree(c, acc); }
    else if(c && c.geometry && c.material && c.geometry.points !== undefined && c.material && c.material.opacity !== undefined && c.material.color !== undefined && !c.isMeshFlag){
      // Mesh vs Line: Lines have geometry.points used with setFromPoints; meshes have materials without points usage
      if(c.material && (c.material.color !== undefined) && c.geometry && c.geometry.points === null && c.material.opacity !== undefined && c.rotation){
        acc.meshes++;
      } else {
        acc.lines++;
      }
    }
    else if(c && c.material && c.material.map !== undefined) acc.sprites++;
    else if(c && c.material && c.material.opacity !== undefined) acc.meshes++;
  }
  return acc;
}

// Better: tag via constructor name
function countByCtor(g, acc){
  acc = acc || {Mesh:0, Line:0, Sprite:0, Group:0};
  if(!g || !g.children) return acc;
  for(var i = 0; i < g.children.length; i++){
    var c = g.children[i];
    if(!c) continue;
    if(c instanceof Sprite) acc.Sprite++;
    else if(c instanceof Line) acc.Line++;
    else if(c instanceof Mesh) acc.Mesh++;
    else if(c instanceof Group){ acc.Group++; countByCtor(c, acc); }
  }
  return acc;
}

DIS.forEach(function(kind){
  resetStats();
  // wipe the closed-over fxList and the scene so each kind starts clean
  var lst = api.fxList();
  while(lst.length) lst.pop();
  dyn.children.length = 0;
  try {
    var D = {
      kind: kind,
      seed: 17,
      warnAt: 100,
      until: 110,
      ring: 8,
      zones: [[-5, 0], [4, 3], [0, -6]],
      pit: [4.9, -4.5],
      marks: [{x: 1, z: 2, r: 3, hitAt: 104, dis: kind}]
    };
    api.fxStart(kind, D);
    var F = api.fxList()[0];
    if(!F) throw new Error("fxStart produced no fxList entry");
    var counts = countByCtor(F.group);
    // one tick, then one more — proves the animation path does not throw
    api.fxTick(0.016, 100.5, false);
    api.fxTick(0.016, 101.0, true);
    var after = countByCtor(F.group);
    out.kinds[kind] = {
      built: true,
      meshes: counts.Mesh, lines: counts.Line, sprites: counts.Sprite, nestedGroups: counts.Group,
      afterTickMeshes: after.Mesh, afterTickSprites: after.Sprite,
      hasWarn: !!F.warn, hasPit: !!F.pit, hasThroat: !!F.throat, hasCoreGlow: !!F.coreGlow,
      hasPlates: !!(F.plates && F.plates.length), plateN: (F.plates && F.plates.length) || 0,
      hasRing: !!F.ring, hasRing2: !!F.ring2, hasRing3: !!F.ring3,
      hasCol: !!F.col, hasSheath: !!F.sheath, hasWall: !!F.wall,
      hasBolt: !!F.bolt, hasBoltBranch2: !!F.boltBranch2, hasFlash: !!F.flash,
      hasSheet: !!F.sheet, hasWash: !!F.wash,
      bits: F.bits.length, clouds: (F.clouds || []).length
    };
  } catch(e){
    out.kinds[kind] = {built: false, error: String(e && e.message || e)};
    out.errors.push(kind + ": " + (e && e.stack || e));
  }
});

// --- expected artefacts per kind (what "scary" means here) ---
var EXPECT = {
  sandstorm:      function(k){ return k.built && k.hasWall && k.sprites >= 400; },
  meteorshower:   function(k){ return k.built && k.sprites >= 80; },
  hurricane:      function(k){ return k.built && k.hasCol && k.hasSheath && k.sprites >= 100; },
  thunder:        function(k){ return k.built && k.hasBolt && k.hasBoltBranch2 && k.hasFlash; },
  earthquake:     function(k){ return k.built && k.hasPlates && k.plateN >= 10 && k.lines >= 16 && k.sprites >= 70; },
  shockring:      function(k){ return k.built && k.hasRing && k.hasRing2 && k.hasRing3; },
  toxicfog:       function(k){ return k.built && k.clouds >= 6; },
  absolutezero:   function(k){ return k.built && k.hasSheet && k.sprites >= 280 && k.meshes >= 36; },
  sinkhole:       function(k){ return k.built && k.hasPit && k.hasThroat && k.hasCoreGlow && k.sprites >= 50; },
  emp:            function(k){ return k.built && k.hasWash && k.sprites >= 26; }
};
var pass = 0, fail = 0;
DIS.forEach(function(kind){
  var k = out.kinds[kind];
  var ok = !!(k && EXPECT[kind](k));
  out.kinds[kind].expectPass = ok;
  if(ok) pass++; else fail++;
});

out.pass = pass; out.fail = fail;
console.log(JSON.stringify(out, null, 2));
if(fail === 0 && out.errors.length === 0){ console.log("\nALL_OK  (10/10 disaster scenes built + ticked)"); process.exit(0); }
console.log("\nFAILED  pass=" + pass + " fail=" + fail);
process.exit(1);
