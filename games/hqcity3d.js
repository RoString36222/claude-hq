/* Claude HQ: Arena City in 3D, on the generated world: the Commons (claude-hq@2, else claude-hq@1)
 * or a personal island (user:<id>@2).
 *
 * The same City as games/hqcity.js (every open HQ has a building, every HQ tab has one, the
 * plaza has the fountain, the bike park and the skatepark), placed on the WorldDoc's lots and
 * sites instead of a grid: the terrain, roads and the city's other buildings come from
 * games/world.js (the doc and its queries) and games/worldbuild.js (the meshes).
 *
 * A floor of the 3D HQ: registered as HQV.hqWorlds.city3d; games/hq3d.js builds it under the
 * world name "city" and it reports w.net = "city3d", the presence floor, so legacy and 3D
 * clients never share a room. Everyone gets the same placement from the same list: HQs sorted
 * by user id take the HQ lots in rank order (assign), so people stand in the same places.
 * assign, placeLot, placeView and pickAt are pure (HQV.hqCity3d), so node can test them.
 *
 * Cities (3.0), on a v2 world (WorldDoc version 2; a v1 doc builds exactly as before):
 *   which world   HQV.hqCity3d.go(world, spawn) picks the next City's world (games/hq3d.js goCity builds
 *                 it again); else the Commons. A world that does not load falls back to the Commons, then
 *                 to claude-hq@1 (an Arena without @2), then hq3d's classic City.
 *   tier, grow    from GET /api/arena/city/<owner> (the Commons: owner "commons", fully grown); worldbuild
 *                 shows the world at that tier (min_tier) and so does everything below.
 *   civic         every civic and zone site from games/hqcivic.js; a door with a view opens its tab, the
 *                 town hall's opens HQV.townHall (ui/app/38-townhall.js).
 *   HQs           the Commons: each open HQ on the lot GET /api/arena/world/claude-hq@2/assign gives it
 *                 (by rank; else sorted by user id as on @1); an island: its owner's, by the town hall.
 *   residents     games/npcsim.js + npcdraw.js, ticked each frame inside NPC_BUDGET; E on one: its line.
 *   traffic       games/traffic.js (cars, buses, trams); E at a stop: pick a stop, wait, ride (the fare
 *                 goes through POST /api/arena/city/<owner>/fare).
 *   the sea       games/ocean.js (the water, the other islands from /api/arena/archipelago) and the boats
 *                 of games/hqboat.js at every dock; a boat that reaches another island lands you there.
 *   travel        E at a dock, port, station or airport: games/hqtravel.js trips (ferry, rail, plane, fast
 *                 travel), the ride's camera through w.camPose; the "My island" / "The Commons" button.
 *   net room      city3d:<world id> where the Arena's presence lists "isles" (protocol v3), else city3d.
 * The helpers below the first block (ownerOf .. travelPlaces) are pure and node-tested too.
 */
(function(){
"use strict";
var HQV = window.HQV = window.HQV || {};
HQV.hqWorlds = HQV.hqWorlds || {};

var PI = Math.PI;
var HQ_DZ = 2;              // an HQ stands this far in front of its lot's middle (the legacy HQ_Z)
var HQ_DOOR = 4.8;          // its door, in front of the building's middle (as hqcity.js lot().door)
var VIEW_BACK = 7;          // a view building's middle, this far behind its site's front edge
var VIEW_DOOR = 4.7;        // a view building's door, in front of its middle (hqbase.js VB_D/2 + 1.2)
var PAD_UP = 0.05;          // an HQ lot's paved slab stands this far above the ground; its buildings on top
var BUCKET = 64;            // the building index (camHit, occluderItems), metres
var FADE_EVERY = 0.15;      // classic mode: which buildings hide you, this often (s), as hqcity.js
var FADE_OP = 0.16;         // a faded building's opacity (as hqbase.js)
var FADE_TAU = 0.083;       // the fade's time constant (s): ~95% of the way in 0.25 s
var HQ_FAR = 250;           // an HQ (and its lot extras) further than this from the camera is not drawn (m)
var HQ_FAR_HYST = 10;       // ... and comes back inside HQ_FAR - this (no flicker on the edge)
// an HQ lot's paving tint by its district (legend name), over the paving texture; others plain
var PAVE = {hq: 0xffffff, plaza: 0xf2ece2, civic: 0xe8ecef, commercial: 0xdde4ec, residential: 0xefe2d0, industrial: 0xd2d0cb};

function byUser(a, b){ return a.userId < b.userId ? -1 : a.userId > b.userId ? 1 : 0; }
function hqLots(W){
  return ((W && W.lots) || []).filter(function(l){ return l && l.kind === "hq"; })
    .sort(function(a, b){ return ((a.rank | 0) - (b.rank | 0)) || ((a.id | 0) - (b.id | 0)); });
}
// Who stands on which HQ lot: [{lot, h}]. HQs with a string userId sorted by userId, HQ lots by
// rank; the i-th HQ gets the i-th lot. More HQs than lots: the first N, but you always stay
// (you replace the last one kept). The same for every viewer of the same list.
function assign(list, W){
  var lots = hqLots(W), n = lots.length;
  var hs = (list || []).filter(function(h){ return h && typeof h.userId === "string"; }).sort(byUser);
  if(hs.length > n){
    var you = -1;
    for(var i = 0; i < hs.length; i++) if(hs[i].isYou){ you = i; break; }
    var kept = hs.slice(0, n);
    if(n > 0 && you >= n) kept[n - 1] = hs[you];
    hs = kept;
  }
  return hs.map(function(h, k){ return {lot: lots[k], h: h}; });
}
function turn(o){ var s = o && o.facing === "south" ? -1 : 1; return {s: s, rot: s > 0 ? 0 : PI}; }
// An HQ's building on its lot (m): the door faces the lot's facing ("north" = +z), or on a v2 lot
// its front (any direction, out to its road).
function placeLot(lot){
  lot = lot || {}; var door = lot.door || [];
  if(lot.front && lot.front.length === 2){
    var fv = frontOf(lot);
    return {x: (lot.x || 0)/100 + HQ_DZ*fv[0], y: (door[1] || 0)/100, z: (lot.z || 0)/100 + HQ_DZ*fv[1], rot: Math.atan2(fv[0], fv[1])};
  }
  var f = turn(lot);
  return {x: (lot.x || 0)/100, y: (door[1] || 0)/100, z: (lot.z || 0)/100 + HQ_DZ*f.s, rot: f.rot};
}
// A view building on its site (m): set back so its door and steps stay on the site.
function placeView(site){
  site = site || {}; var f = turn(site);
  return {x: (site.x || 0)/100, y: (site.y || 0)/100, z: (site.z || 0)/100 + f.s*((site.d || 0)/200 - VIEW_BACK), rot: f.rot};
}
// a point in a placed thing's own frame (lx, lz; +z is its front) -> the world
function toWorld(p, lx, lz){ var cr = Math.cos(p.rot), sr = Math.sin(p.rot); return {x: p.x + lx*cr + lz*sr, z: p.z - lx*sr + lz*cr}; }
// the HQ entry whose lot holds (x, z) (m), else null. entries: [{lot, ...}]
function pickAt(entries, x, z){
  var xc = x*100, zc = z*100;
  for(var i = 0; i < (entries || []).length; i++){
    var l = entries[i].lot;
    if(l && Math.abs(xc - l.x) <= l.w/2 && Math.abs(zc - l.z) <= l.d/2) return entries[i];
  }
  return null;
}
// segment from -> to against an axis-aligned box {min, max}: the entry t in [0, 1], or 1 (clear)
function segBox(from, to, b){
  var t0 = 0, t1 = 1, ax = ["x", "y", "z"];
  for(var i = 0; i < 3; i++){
    var a = ax[i], d = to[a] - from[a];
    if(Math.abs(d) < 1e-9){ if(from[a] < b.min[a] || from[a] > b.max[a]) return 1; continue; }
    var u = (b.min[a] - from[a])/d, v = (b.max[a] - from[a])/d;
    if(u > v){ var tt = u; u = v; v = tt; }
    if(u > t0) t0 = u; if(v < t1) t1 = v;
    if(t0 > t1) return 1;
  }
  return t0;
}
// The sun's shadow box centred on p, moved onto its own texel grid: p's light-space x and y (the
// shadow camera looks along -dir, up +y, as three's lookAt) snapped to multiples of texel, so the
// shadow map samples the same world points as the box follows you (no crawl). dir: towards the sun.
function snapShadow(p, dir, texel){
  p = p || {}; var px = +p.x || 0, py = +p.y || 0, pz = +p.z || 0;
  var dl = Math.hypot(dir.x, dir.y, dir.z) || 1, zx = dir.x/dl, zy = dir.y/dl, zz = dir.z/dl;
  var xl = Math.hypot(zz, zx) || 1, xx = zz/xl, xz = -zx/xl;                   // x = up x z (up = +y): (z.z, 0, -z.x)
  var yx = zy*xz, yy = zz*xx - zx*xz, yz = -zy*xx;                              // y = z x x
  var a = px*xx + pz*xz, b = px*yx + py*yy + pz*yz, d = px*zx + py*zy + pz*zz;
  if(texel > 0){ a = Math.round(a/texel)*texel; b = Math.round(b/texel)*texel; }
  return {x: a*xx + b*yx + d*zx, y: b*yy + d*zy, z: a*xz + b*yz + d*zz};
}
// what is part of an HQ's look (its building is rebuilt when it changes); crew counts are not
function hqKey(E){ var h = E.h || {}; return JSON.stringify([h.userId, (E.lot || {}).id, h.level, h.look, h.cos, !!h.isYou]); }
function crewText(h){ var crew = (h && h.crew) || {}; return (h && h.isYou ? "You · " : "") + (crew.working | 0) + " working · " + (crew.needs | 0) + " need them"; }
// A mesh mergeStatic must leave alone: doors and anything tagged animated or fading, materials
// something changes later (lit by night, blinking, scrolling, a canvas), see-through ones, and
// several materials on one mesh. Plain opaque stone, steel and paint merge.
function keepMesh(o){
  if(!o || !o.isMesh || o.isInstancedMesh || o.isSkinnedMesh) return true;
  var u = o.userData || {}; if(u.door || u.anim || u.fade || u.wave != null) return true;
  var m = o.material; if(!m || Array.isArray(m)) return true;
  if(m.transparent || m.map || m.emissiveMap || m.alphaMap) return true;
  return !!(m.emissive && m.emissiveIntensity > 0 && (m.emissive.r || m.emissive.g || m.emissive.b));
}
// o lies under one of roots ({uuid: 1}), looking up to (not past) top
function under(o, roots, top){ for(var p = o; p && p !== top; p = p.parent) if(roots[p.uuid]) return true; return false; }

/* ---------- Cities (v2 worlds): pure helpers ---------- */
var COMMONS = "claude-hq@2", LEGACY = "claude-hq@1";
var ISLAND_RE = /^user:([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})@2$/;
var UID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
var NOT_CIVIC = {fountain: 1, skatepark: 1, bikepark: 1, spawn: 1, "view-building": 1};   // the plaza's own parts
var TERMINALS = {dock: 1, port: 1, transit: 1, airport: 1};
var STOP_R = 14, TERMINAL_R = 24;           // E reaches a stop / a terminal's door within this (m)
// a world's owner for /api/arena/city/<owner>: an island's user id, else the Commons
function ownerOf(world){ var m = ISLAND_RE.exec(String(world || "")); return m ? m[1] : "commons"; }
function islandOf(uid){ return UID_RE.test(String(uid || "")) ? "user:" + uid + "@2" : null; }
function worldOk(world){ return world === COMMONS || world === LEGACY || ISLAND_RE.test(String(world || "")); }
// a lot's or a site's door direction: its Q16 front (v2), else its facing
function frontOf(o){
  var f = o && o.front;
  if(f && f.length === 2){ var fx = (+f[0] || 0)/65536, fz = (+f[1] || 0)/65536, l = Math.hypot(fx, fz); if(l > 1e-6) return [fx/l, fz/l]; }
  return o && o.facing === "south" ? [0, -1] : [0, 1];
}
// The Commons' HQ towers by the Arena's assignment (rows [{user, lot_rank}]): each HQ on the list with
// a row takes the HQ lot of that rank; one without a row has no tower until a rank frees up.
function assignRanks(list, rows, W){
  var byRank = {}; hqLots(W).forEach(function(l){ byRank[l.rank | 0] = l; });
  var rank = {}; (rows || []).forEach(function(r){ if(r && typeof r.user === "string" && r.lot_rank >= 0) rank[r.user] = r.lot_rank | 0; });
  return (list || []).filter(function(h){ return h && typeof h.userId === "string" && rank[h.userId] != null && byRank[rank[h.userId]]; })
    .sort(byUser).map(function(h){ return {lot: byRank[rank[h.userId]], h: h}; });
}
// An island's one HQ lot (rank 0, by the town hall) holds its owner's HQ: theirs from the list, or
// yours (you, on your own island, even while your HQ is closed to the street).
function assignIsland(list, owner, me, W){
  var lot = hqLots(W)[0]; if(!lot) return [];
  var h = (list || []).filter(function(x){ return x && x.userId === owner; })[0];
  if(!h && owner === me) h = {userId: me, isYou: true, level: 1};
  return h ? [{lot: lot, h: h}] : [];
}
// the sites the civic kit builds at this tier (a site's tier; none: from the start)
function civicSites(W, tier, kinds){
  return ((W && W.sites) || []).filter(function(s){
    return s && !NOT_CIVIC[s.kind] && (!kinds || kinds.indexOf(s.kind) >= 0) && (s.tier == null || (s.tier | 0) <= tier);
  });
}
// where a site's door is (m): its centre, out along its front past its depth
function doorOf(s){ var f = frontOf(s), r = (s.d || 0)/200 + 1; return {x: s.x/100 + f[0]*r, z: s.z/100 + f[1]*r, yaw: Math.atan2(f[0], f[1])}; }
// the travel terminal (dock, port, transit hub, airport) whose door is within reach of (x, z), else null
function terminalAt(W, tier, x, z){
  var best = null, bd = TERMINAL_R;
  ((W && W.sites) || []).forEach(function(s){
    if(!TERMINALS[s.kind] || (s.tier != null && (s.tier | 0) > tier)) return;
    var d = doorOf(s), dd = Math.hypot(x - d.x, z - d.z);
    if(dd < bd){ bd = dd; best = s; }
  });
  return best;
}
// a stop's menu: for every line calling at it, the next vehicle and the stops it goes on to
// ({line, kind, arrive (ms), to: [stop ids, in calling order]}), soonest first
function stopMenu(sim, stopId, nowMs){
  if(!sim || !sim.lines) return [];
  var out = [];
  sim.lines().forEach(function(L){
    var ids = L.stops.map(function(s){ return s.id; }), at = ids.indexOf(String(stopId));
    if(at < 0) return;
    var nx = sim.nextArrival(stopId, nowMs, L.id); if(!nx) return;
    var to = ids.slice(at + 1).concat(ids.slice(0, at)).filter(function(id, i, a){ return id !== String(stopId) && a.indexOf(id) === i; });
    if(to.length) out.push({line: L.id, kind: L.kind, arrive: nx.arrive, to: to});
  });
  return out.sort(function(a, b){ return a.arrive - b.arrive || (a.line < b.line ? -1 : 1); });
}
function waitText(ms){ var s = Math.max(0, Math.round(ms/1000)); return s < 60 ? s + " s" : Math.floor(s/60) + " min " + (s % 60) + " s"; }
// Where you can travel from `here`: your island first, then the Commons, then the other islands you may
// visit by name. arch: GET /api/arena/archipelago (cm) -> places in metres, as hqtravel wants them.
function travelPlaces(arch, here, me){
  arch = arch || {}; var out = [], mine = islandOf(me);
  function place(o, name){ return {world: o.world, name: name, x: (+o.x || 0)/100, z: (+o.z || 0)/100, tier: o.tier != null ? Math.max(1, Math.min(5, o.tier | 0)) : 5}; }
  var isl = (Array.isArray(arch.islands) ? arch.islands : []).filter(function(o){ return o && ISLAND_RE.test(String(o.world || "")) && isFinite(+o.x) && isFinite(+o.z); });
  var own = isl.filter(function(o){ return o.world === mine; })[0];
  if(own && own.world !== here) out.push(place(own, "My island"));
  if(arch.commons && here !== COMMONS) out.push(place({world: COMMONS, x: arch.commons.x, z: arch.commons.z, tier: 5}, "The Commons"));
  isl.filter(function(o){ return o.world !== mine && o.world !== here; })
    .sort(function(a, b){ return String(a.name) < String(b.name) ? -1 : String(a.name) > String(b.name) ? 1 : (a.world < b.world ? -1 : 1); })
    .forEach(function(o){ out.push(place(o, String(o.name || "An island").slice(0, 40))); });
  return out;
}
// The generator's zone job tables ({job, start_min, end_min, share_pm}: minutes and per-mille) as
// games/npcsim.js reads them ({job, from, to, n}: hours and a weight); other shapes pass as they are.
function simZones(zones){
  if(!Array.isArray(zones)) return zones;
  return zones.map(function(z){
    if(!z || !Array.isArray(z.jobs)) return z;
    return Object.assign({}, z, {jobs: z.jobs.map(function(j){
      return j && j.start_min != null ? {job: j.job, from: (+j.start_min || 0)/60, to: (+j.end_min || 0)/60, n: +j.share_pm || 0} : j;
    })});
  });
}
// the presence room: a world's own where the Arena knows rooms per world ("isles"), else the 3D City's
function netRoom(world, isles){ return isles && worldOk(world) ? "city3d:" + world : "city3d"; }

HQV.hqCity3d = {assign: assign, placeLot: placeLot, placeView: placeView, toWorld: toWorld, pickAt: pickAt, segBox: segBox,
  snapShadow: snapShadow, hqKey: hqKey, keepMesh: keepMesh, HQ_DOOR: HQ_DOOR, VIEW_DOOR: VIEW_DOOR, HQ_FAR: HQ_FAR,
  COMMONS: COMMONS, ownerOf: ownerOf, islandOf: islandOf, worldOk: worldOk, frontOf: frontOf, assignRanks: assignRanks,
  assignIsland: assignIsland, civicSites: civicSites, doorOf: doorOf, terminalAt: terminalAt, stopMenu: stopMenu,
  waitText: waitText, travelPlaces: travelPlaces, netRoom: netRoom, simZones: simZones};
// Which world the next City is built on, and where you arrive in it (games/hq3d.js goCity). A trip
// that is still landing (a plane) rides across the rebuild in NAV.trip.
var NAV = {world: null, spawn: null, trip: null};
HQV.hqCity3d.go = function(world, spawn){ NAV.world = worldOk(world) ? world : null; NAV.spawn = spawn || null; };
HQV.hqCity3d.target = function(){ return NAV.world || COMMONS; };

// Fading, eased: a fading building's materials stay transparent for good (set once, before they
// are first drawn), so going see-through is an opacity tween, never a shader recompile
// (needsUpdate) or a shadow toggle. L.fade: {g, on (the goal), a (0 solid .. 1 faded), mats}.
function fadeGoal(L, on){ if(L.fade) L.fade.on = on; }
function fadeStep(L, dt, k){
  var F = L.fade; if(!F || !F.mats) return;
  var goal = F.on ? 1 : 0; if(F.a === goal) return;
  F.a = k < 1 || !(dt > 0) ? goal : goal + (F.a - goal)*Math.exp(-dt/FADE_TAU);   // Calm: no tween
  if(Math.abs(F.a - goal) < 0.004) F.a = goal;
  F.mats.forEach(function(r){ r.m.opacity = r.op + (Math.min(r.op, FADE_OP) - r.op)*F.a; r.m.depthWrite = F.a < 0.05 ? r.dw : false; });
}

HQV.hqWorlds.city3d = function(c, w){
  var THREE = c.THREE, S = w.scene, COL = c.COL, HEX = c.HEX;
  var mat = c.mat, emis = c.emis, box = c.box, cyl = c.cyl, sph = c.sph;
  var WD = HQV.world, parts = HQV.hqCityParts, SP = HQV.hqSkatePark;
  var api = c.api || {};
  var hits = [], doors = [], night = true, W = null, wb = null, dead = false;

  var hemi = new THREE.HemisphereLight(0xbcd7ff, 0x223322, 2.2); S.add(hemi);
  var sun = new THREE.DirectionalLight(0xffffff, 2.2); sun.position.set(40, 70, 30); sun.castShadow = true;
  sun.shadow.mapSize.set(2048, 2048); S.add(sun); S.add(sun.target);
  // The sky is a dome centred on the camera every frame: it moves with the camera but never turns with
  // it, so the stars keep their place in the sky as you look around. (It was a flat S.background, which
  // is pinned to the screen: turning swept the world past stars that stayed put, and looked trippy.)
  // Drawn first, behind everything (no depth test or write), never fogged.
  var SKY = {night: [0x040a12, 0x0b1826, 0x16304a], day: [0x4a92d4, 0x7fb6e2, 0xcfe8f7]};   // zenith, mid, horizon
  var skyGeo = new THREE.SphereGeometry(1, 32, 16), skyCol = new Float32Array(skyGeo.attributes.position.count*3);
  skyGeo.setAttribute("color", new THREE.BufferAttribute(skyCol, 3));
  var sky = new THREE.Mesh(skyGeo, new THREE.MeshBasicMaterial({vertexColors: true, side: THREE.BackSide,
    depthWrite: false, depthTest: false, fog: false, toneMapped: false}));
  sky.renderOrder = -1000; sky.frustumCulled = false; S.add(sky);
  var stars = (function(){
    var R = c.rng(9), n = 900, pos = new Float32Array(n*3), col = new Float32Array(n*3);
    for(var i = 0; i < n; i++){
      var y = 0.06 + 0.94*R(), a = R()*Math.PI*2, r = Math.sqrt(1 - y*y), b = 0.3 + 0.7*R()*R(), warm = R() < 0.15;
      pos[i*3] = r*Math.cos(a)*0.98; pos[i*3 + 1] = y*0.98; pos[i*3 + 2] = r*Math.sin(a)*0.98;
      col[i*3] = b; col[i*3 + 1] = b*(warm ? 0.9 : 1); col[i*3 + 2] = b*(warm ? 0.78 : 1);
    }
    var g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.BufferAttribute(pos, 3)); g.setAttribute("color", new THREE.BufferAttribute(col, 3));
    var p = new THREE.Points(g, new THREE.PointsMaterial({size: 1.7, sizeAttenuation: false, vertexColors: true,
      depthWrite: false, depthTest: false, fog: false, toneMapped: false}));
    p.renderOrder = -999; p.frustumCulled = false; sky.add(p);
    return p;
  })();
  // vertex colours by height: horizon -> mid by 0.35 up, mid -> zenith above that; below the horizon stays horizon
  function paintSky(n){
    var cs = SKY[n ? "night" : "day"].map(function(h){ return new THREE.Color(h); }), tmp = new THREE.Color();
    var P = skyGeo.attributes.position;
    for(var i = 0; i < P.count; i++){
      var y = Math.max(0, P.getY(i));
      if(y < 0.35) tmp.copy(cs[2]).lerp(cs[1], y/0.35); else tmp.copy(cs[1]).lerp(cs[0], (y - 0.35)/0.65);
      skyCol[i*3] = tmp.r; skyCol[i*3 + 1] = tmp.g; skyCol[i*3 + 2] = tmp.b;
    }
    skyGeo.attributes.color.needsUpdate = true;
    stars.visible = !!n;
  }
  var fog = new THREE.Fog(0x0f1f30, 300, 1600);
  var paveT = c.canvasTex(256, 256, function(g){ g.fillStyle = "#3b4c5c"; g.fillRect(0, 0, 256, 256); g.strokeStyle = "rgba(255,255,255,.08)"; g.lineWidth = 2;
    for(var i = 0; i <= 256; i += 32){ g.beginPath(); g.moveTo(i, 0); g.lineTo(i, 256); g.stroke(); g.beginPath(); g.moveTo(0, i); g.lineTo(256, i); g.stroke(); } });
  paveT.t.wrapS = paveT.t.wrapT = THREE.RepeatWrapping; paveT.t.repeat.set(7, 5);

  var staticG = new THREE.Group(), hqG = new THREE.Group();
  var hqs = [], views = [], civic = [], freeLots = [];   // placed things (entries below)
  var lampGlows = [], parkBikes = [], bikes = [], cars = [];
  var fount = null, skate = null, plaza = {x: 0, y: 0, z: 0}, sig = null;
  var bIdx = null;                                      // building lots by 64 m bucket: [{id, min, max}]
  // Cities (a v2 world): which world, whose, how grown, and what runs on it
  var want = NAV.world || COMMONS, arriveAt = NAV.spawn, worldId = LEGACY, V2 = false;
  NAV.spawn = null;
  var me = (api.me && api.me()) || null, owner = "commons", tier = 5, grow = 1000, cityState = null, assignRows = null;
  var civics = [], civicG = new THREE.Group(), boatG = new THREE.Group(), boats = [];
  var oc = null, sea = null, arch = null, tsim = null, tview = null, nsim = null, ndraw = null;
  var bus = null, menu = null, menuKey = null, talkL = null, ui = null, fadeEl = null, landing = false, npcSkip = 0;

  function ground(x, z){ return W ? WD.groundAt(W, x, z) : 0; }
  function site(id){ for(var i = 0; i < W.sites.length; i++) if(W.sites[i].id === id) return W.sites[i]; return null; }
  function siteC(s){ return {x: s.x/100, y: s.y/100, z: s.z/100}; }

  /* ---------- the building index: AABBs of the world's own buildings, for the camera ---------- */
  function indexBuildings(){
    var nb = Math.max(1, Math.ceil(W.sizeCm/100/BUCKET)), half = W.half, B = [];
    for(var i = 0; i < nb*nb; i++) B.push([]);
    function bOf(v){ return Math.max(0, Math.min(nb - 1, Math.floor((v + half)/BUCKET))); }
    W.lots.forEach(function(l){
      if(l.kind !== "building") return;
      var R = WD.buildingRect(l), g0 = ground(R.x0, R.z0), g1 = ground(R.x1, R.z0), g2 = ground(R.x0, R.z1), g3 = ground(R.x1, R.z1);
      var top = Math.max(g0, g1, g2, g3) + Math.max(1, l.floors | 0)*3.5 + 1.5;
      var it = {id: l.id, min: {x: R.x0, y: Math.min(g0, g1, g2, g3) - 1, z: R.z0}, max: {x: R.x1, y: top, z: R.z1}};
      for(var bz = bOf(R.z0); bz <= bOf(R.z1); bz++) for(var bx = bOf(R.x0); bx <= bOf(R.x1); bx++) B[bz*nb + bx].push(it);
    });
    bIdx = {nb: nb, b: B, bOf: bOf};
  }
  // building-lot AABBs touching the box x0..x1, z0..z1 (each once)
  function buildingsIn(x0, x1, z0, z1){
    var out = [], seen = {}, I = bIdx; if(!I) return out;
    for(var bz = I.bOf(z0); bz <= I.bOf(z1); bz++) for(var bx = I.bOf(x0); bx <= I.bOf(x1); bx++){
      var L = I.b[bz*I.nb + bx];
      for(var i = 0; i < L.length; i++){ var it = L[i]; if(seen[it.id]) continue; seen[it.id] = 1;
        if(it.max.x >= x0 && it.min.x <= x1 && it.max.z >= z0 && it.min.z <= z1) out.push(it); }
    }
    return out;
  }
  // placed buildings (HQs, view buildings) as {id, min, max}: one box per part (an HQ's tower and wings)
  function placedIn(x0, x1, z0, z1){
    var out = [];
    hqs.concat(views).forEach(function(E){ (E.boxes || []).forEach(function(b){
      if(b.max.x >= x0 && b.min.x <= x1 && b.max.z >= z0 && b.min.z <= z1) out.push({id: E.oid, min: b.min, max: b.max}); }); });
    // civic buildings (v2): the camera keeps out of them too
    civics.forEach(function(B, n){ (B.boxes || []).forEach(function(b){
      if(b.max.x >= x0 && b.min.x <= x1 && b.max.z >= z0 && b.min.z <= z1) out.push({id: "civic:" + n, min: b.min, max: b.max}); }); });
    return out;
  }
  // the box (lot-local centre cx, cz, half sizes hw, hd, height top) in world coordinates
  function aabbOf(p, cx, cz, hw, hd, top){
    var a = toWorld(p, cx - hw, cz - hd), b = toWorld(p, cx + hw, cz + hd);
    return {min: {x: Math.min(a.x, b.x), y: p.y - 0.5, z: Math.min(a.z, b.z)}, max: {x: Math.max(a.x, b.x), y: p.y + top, z: Math.max(a.z, b.z)}};
  }
  // an HQ's boxes, matching hqBuilding's blockedLocal: the tower, then each wing (so the ground beside it stays clear)
  function hqBoxes(p, B){
    var top = B.top(), out = [aabbOf(p, 0, 0, 4.8, 3.8, top)];
    if(B.wings >= 1) out.push(aabbOf(p, -10.5, 0.5, 3, 2.8, top));
    if(B.wings >= 2) out.push(aabbOf(p, 10.5, 0.5, 3, 2.8, top));
    return out;
  }

  /* ---------- what is built once: the plaza, the view buildings, the civic plazas, the traffic ---------- */
  function buildStatic(){
    var fs = site("fountain:0"), ss = site("skatepark:0"), bs = site("bikepark:0");
    if(fs){ plaza = siteC(fs); fount = parts.fountain(c, staticG, plaza.x, plaza.y, plaza.z); }
    if(bs){ var bc = siteC(bs); parkBikes = parts.bikePark(c, staticG, bc.x, bc.y, bc.z, PI); }   // rot PI: the bikes face the fountain
    if(ss){ var sc = siteC(ss); skate = parts.skatePark(c, staticG, sc.x, sc.y, sc.z, {boardsSide: -1}); if(skate) skate.y = sc.y; }
    w.skatepark = skate; w.skateBase = skate ? skate.y : plaza.y;
    // one building per HQ tab, on view-building:0..12 in id order
    (HQV.hqViews || []).forEach(function(v, k){
      var s = site("view-building:" + k); if(!s) return;
      var p = placeView(s), dw = toWorld(p, 0, VIEW_DOOR);
      var V = HQV.hqViewBuilding(c, v, {doorFront: function(){ return new THREE.Vector3(dw.x, p.y, dw.z); }});
      V.g.position.set(p.x, p.y, p.z); V.g.rotation.y = p.rot; staticG.add(V.g); V.setNight(night);
      V.hits.forEach(function(o){ hits.push(o); }); V.doors.forEach(function(d){ doors.push(d); });
      merge(V.g, null, V);
      views.push({kind: "view", oid: "view:" + v.view, x: p.x, y: p.y, z: p.z, rot: p.rot, B: V, H: V.top() + 2, fade: {g: V.g, on: false},
        boxes: [aabbOf(p, 0, 0, 5, 4, V.top())]});
    });
    // the view-building sites no tab needs: a small civic plaza, a bench and a tree
    var benchM = mat(0x6b4f3a, {roughness: 0.8}), legM = mat(0x2b3a48, {metalness: 0.6});
    W.sites.forEach(function(s){
      var m = /^view-building:(\d+)$/.exec(s.id || ""); if(!m || (m[1] | 0) < (HQV.hqViews || []).length) return;
      var p = placeView(s), g = new THREE.Group(); g.position.set(p.x, p.y, p.z); g.rotation.y = p.rot; staticG.add(g);
      box(1.8, 0.08, 0.5, benchM, -1.6, 0.45, 0, g); box(1.8, 0.4, 0.06, benchM, -1.6, 0.7, -0.24, g);
      box(0.08, 0.45, 0.45, legM, -2.4, 0.22, 0, g); box(0.08, 0.45, 0.45, legM, -0.8, 0.22, 0, g);
      cyl(0.2, 0.28, 1.2, mat(0x5a3d2a), 1.8, 0.6, 0, g, 8); sph(1.2, mat(0x3c8a4f, {roughness: 0.9}), 1.8, 2.1, 0, g);
      var tr = toWorld(p, 1.8, 0);
      civic.push({p: p, tree: tr});
    });
    // traffic: a few cars up and down the streets round the middle, on the left of their lane
    // (a v2 world has games/traffic.js instead)
    var near = V2 ? [] : W.edges.filter(function(e){
      if((e.cls !== "street" && e.cls !== "avenue") || e.pts.length < 6) return false;
      var n = e.pts.length/3, m = (n >> 1)*3, mx = e.pts[m]/100, mz = e.pts[m + 2]/100;
      return mx*mx + mz*mz < 250*250;
    }).sort(function(a, b){ return WD.hash32(W.hash + ":car:" + a.id) - WD.hash32(W.hash + ":car:" + b.id) || a.id - b.id; }).slice(0, 6);
    [0xd14a5c, 0x4a7bd1, 0xe0e4e8, 0xffb347, 0x3fa66a, 0x8a4ad1].forEach(function(col, n){
      var e = near[n]; if(!e) return;
      var pts = [], len = [0], P = e.pts;
      for(var i = 0; i < P.length; i += 3){ pts.push({x: P[i]/100, y: P[i + 1]/100, z: P[i + 2]/100}); if(i) len.push(len[len.length - 1] + Math.hypot(pts[pts.length - 1].x - pts[pts.length - 2].x, pts[pts.length - 1].z - pts[pts.length - 2].z)); }
      var k = c.car(col, 0xe0e4e8).g;      // the drivable car's model: wheels on the ground, nose to +z
      staticG.add(k);
      var v = 5 + (n % 3), lane = (e.width - 2*e.walk)/400;
      cars.push({g: k, pts: pts, len: len, s: (n*0.37 % 1)*len[len.length - 1], dir: n % 2 ? -1 : 1, v: v, lane: lane,
        turn: 0, T: Math.max(0.6, PI*lane/v)});
    });
    // the plaza parts, civic plazas: one mesh per material; never the view buildings (they fade),
    // the bikes and boards (you ride them) or the traffic
    var roots = {};
    views.forEach(function(V){ roots[V.fade.g.uuid] = 1; });
    parkBikes.forEach(function(b){ roots[b.g.uuid] = 1; });
    if(skate) skate.boards.forEach(function(b){ roots[b.g.uuid] = 1; });
    cars.forEach(function(cr){ roots[cr.g.uuid] = 1; });
    merge(staticG, roots);
    views.forEach(tagFade); fadePrep(views);
  }
  // Up and down one street. At each end the car U-turns on a half circle round the end point,
  // from its lane to the other one, at its own speed (no snap).
  function carStep(cr, dt, k){
    var L = cr.len[cr.len.length - 1]; if(!(L > 0)) return;
    if(cr.turn > 0){ cr.turn -= dt*k; if(cr.turn <= 0){ cr.turn = 0; cr.dir = -cr.dir; } }
    else { cr.s += cr.dir*cr.v*dt*k; if(cr.s > L || cr.s < 0){ cr.s = cr.s > L ? L : 0; cr.turn = cr.T; } }
    var i = 1; while(i < cr.len.length - 1 && cr.len[i] < cr.s) i++;
    var a = cr.pts[i - 1], b = cr.pts[i], seg = (cr.len[i] - cr.len[i - 1]) || 1, u = Math.max(0, Math.min(1, (cr.s - cr.len[i - 1])/seg));
    var yaw = Math.atan2((b.x - a.x)*cr.dir, (b.z - a.z)*cr.dir), off = cr.lane;
    if(cr.turn > 0) yaw -= PI*(1 - cr.turn/cr.T);      // turning right, across the road: the offset sweeps round the end point
    cr.g.position.set(a.x + (b.x - a.x)*u + off*Math.cos(yaw), a.y + (b.y - a.y)*u + 0.04, a.z + (b.z - a.z)*u - off*Math.sin(yaw));
    cr.g.rotation.y = yaw;
  }

  /* ---------- the HQs: one rebuilt only when its look, level, cos or isYou changes ---------- */
  var slabM = new THREE.MeshStandardMaterial({map: paveT.t, roughness: 0.9});
  var freeT = c.canvasTex(256, 64, function(g){ g.fillStyle = "#0b1622"; g.fillRect(0, 0, 256, 64); g.fillStyle = "#e9eff3"; g.font = "700 34px system-ui, sans-serif";
    g.textAlign = "center"; g.textBaseline = "middle"; g.fillText("FREE LOT", 128, 34); });
  var lotsG = null, lotsSig = null, forceYou = false;
  // HQV.hqMerge.mergeStatic (games/hqmerge.js) on g, sub-groups and all, when it is loaded.
  // roots: what stays as it is (with everything under it); B: a building whose animate() moves
  // parts of g (rotor, karts, banners, icon): those stay too.
  function merge(g, roots, B){
    var M = HQV.hqMerge; if(!M || typeof M.mergeStatic !== "function") return;
    roots = Object.assign({}, roots || {}, B ? moving(B, g) : {});
    // keep() is asked of each mesh and of each group above it: a group is kept only as a root or a moving part
    M.mergeStatic(THREE, g, {keep: function(o){ return (o.isMesh && keepMesh(o)) || under(o, roots, g); }});
  }
  // {uuid: 1} of what B.animate moves under g: its pose at two times, compared (dt 0: no twinkle)
  function moving(B, g){
    if(typeof B.animate !== "function") return {};
    function pose(){ var s = {}; g.traverse(function(o){ s[o.uuid] = o.position.toArray().concat(o.quaternion.toArray(), o.scale.toArray(), [o.visible ? 1 : 0]).join(","); }); return s; }
    var a = pose(); B.animate(3.7, 0, 1); var b = pose(); B.animate(11.3, 0, 1); var d = pose(), out = {};
    Object.keys(a).forEach(function(id){ if(a[id] !== b[id] || a[id] !== d[id]) out[id] = 1; });
    return out;
  }
  // Ready the faders in list (each L.fade.g) for fading: a material used outside its building is
  // copied for it first (so fading one building never fades another), then every one is made
  // transparent once and remembers its opacity and depth write.
  function fadePrep(list){
    var use = {};                                      // material uuid -> {who uses it: 1}
    function note(o, who){ (Array.isArray(o.material) ? o.material : [o.material]).forEach(function(m){
      if(!m) return; var u = use[m.uuid] = use[m.uuid] || {}; u[who] = 1; }); }
    [hqG, staticG].forEach(function(R){ R.traverse(function(o){ if(o.isMesh) note(o, o.userData.fadeOid || "-"); }); });
    list.forEach(function(L){
      if(!L.fade || L.fade.mats) return;
      var mats = [], seen = {};
      L.fade.g.traverse(function(o){
        if(!o.isMesh) return;
        var arr = Array.isArray(o.material) ? o.material.slice() : [o.material];
        arr.forEach(function(m, i){
          if(!m) return;
          if(Object.keys(use[m.uuid] || {}).length > 1){ m = m.clone(); arr[i] = m; }
          if(seen[m.uuid]) return; seen[m.uuid] = 1;
          mats.push({m: m, op: m.opacity, dw: m.depthWrite}); m.transparent = true;
        });
        o.material = Array.isArray(o.material) ? arr : arr[0];
      });
      L.fade.mats = mats; L.fade.a = 0;
    });
  }
  function tagFade(L){ L.fade.g.traverse(function(o){ if(o.isMesh) o.userData.fadeOid = L.oid; }); }
  // Dispose what g (just taken out of the scene) used and nothing in the scene still does.
  function disposeTree(g){
    var keep = {}, gone = {};
    function mats(o){ return Array.isArray(o.material) ? o.material : o.material ? [o.material] : []; }
    S.traverse(function(o){
      if(o.geometry) keep[o.geometry.uuid] = 1;
      mats(o).forEach(function(m){ keep[m.uuid] = 1; texOf(m).forEach(function(t){ keep[t.uuid] = 1; }); });
    });
    [paveT.t, freeT.t, slabM].forEach(function(t){ keep[t.uuid] = 1; });
    function drop(x){ if(x && !keep[x.uuid]) gone[x.uuid] = x; }
    g.traverse(function(o){
      if(o.geometry && !o.isSprite) drop(o.geometry);          // a sprite's geometry is three's shared quad
      mats(o).forEach(function(m){ drop(m); texOf(m).forEach(drop); });
    });
    Object.keys(gone).forEach(function(id){ if(typeof gone[id].dispose === "function") gone[id].dispose(); });
  }
  function texOf(m){ var out = []; ["map", "emissiveMap", "alphaMap", "normalMap", "roughnessMap", "metalnessMap", "aoMap", "bumpMap"].forEach(function(k){ if(m[k] && m[k].isTexture) out.push(m[k]); }); return out; }
  function building(E){
    var h = E.h, cos = h.cos || {}, crew = h.crew || {}, name = HQV.hqCityName(h), p = E;
    var g = new THREE.Group(); g.position.set(p.x, p.y + PAD_UP, p.z); g.rotation.y = p.rot; hqG.add(g); E.g = g;
    var pad = new THREE.Mesh(new THREE.PlaneGeometry(30, 15), new THREE.MeshStandardMaterial({map: paveT.t, roughness: 0.9}));
    pad.rotation.x = -PI/2; pad.position.set(0, 0.02, 1.5); pad.receiveShadow = true; g.add(pad);
    if(h.isYou){ var ring = new THREE.Mesh(new THREE.RingGeometry(14.6, 15.1, 64), new THREE.MeshBasicMaterial({color: COL.amber, transparent: true, opacity: 0.5, toneMapped: false}));
      ring.rotation.x = -PI/2; ring.position.set(0, 0.04, 0.5); ring.scale.y = 0.45; g.add(ring); }
    var B = HQV.hqBuilding(c, {
      level: function(){ return Math.max(1, h.level | 0); },
      look: function(){ return Object.assign({}, h.look || {}, {sign: name, decor: cos.decor}); },
      live: function(){ return (crew.working | 0) + (crew.needs | 0); },
      campus: false,
      door: {view: h.isYou ? "@lobby" : "visit:" + h.userId, label: name, userId: h.userId,
             tip: h.isYou ? "Your HQ: go in" : name + ": walk in as a visitor"},
      doorFront: function(){ return new THREE.Vector3(E.door.x, p.y, E.door.z); }
    });
    g.add(B.g); B.setLive((crew.working | 0) + (crew.needs | 0)); B.setNight(night);
    E.subText = crewText(h);
    E.sub = c.label(E.subText, HEX.green, 0.7); E.sub.position.set(0, B.top() + 5.6, 0); g.add(E.sub);
    B.hits.forEach(function(o){ hits.push(o); }); B.doors.forEach(function(d){ doors.push(d); });
    E.B = B; E.H = B.top() + 2; E.fade = {g: B.g, on: false}; E.name = name;
    E.boxes = hqBoxes(p, B);
    // the garage apron stops at the lot's front edge (the building stands HQ_DZ in front of the lot's middle)
    var X = parts.lotExtras(c, g, HQV.hqLotColors(h.look), p.rot, function(x, z){ return toWorld(p, x, z); }, Math.min(11, (E.lot.d || 0)/200 - HQ_DZ), h.userId);
    E.glows = X.glows; E.car = X.car; E.items = X.items;
    // the building (its own meshes: it fades), then the lot round it: pad, garage, apron; never
    // the car, motorbike and bicycle (you ride them)
    merge(B.g, null, B);
    var roots = {}; roots[B.g.uuid] = 1; X.items.forEach(function(b){ roots[b.g.uuid] = 1; });
    merge(g, roots);
    tagFade(E);
  }
  // an HQ's crew changed: its windows and the line under its name, not its building
  function crewUpdate(E, h){
    E.h = h; var crew = h.crew || {}, t = crewText(h);
    E.B.setLive((crew.working | 0) + (crew.needs | 0));
    if(t === E.subText) return;
    var old = E.sub; E.subText = t;
    E.sub = c.label(t, HEX.green, 0.7); E.sub.position.copy(old.position); E.g.add(E.sub);
    E.g.remove(old); disposeTree(old);
  }
  function unbuild(E){
    E.B.hits.forEach(function(o){ var i = hits.indexOf(o); if(i >= 0) hits.splice(i, 1); });
    E.B.doors.forEach(function(d){ var i = doors.indexOf(d); if(i >= 0) doors.splice(i, 1); });
    hqG.remove(E.g); disposeTree(E.g);
  }
  function build(){
    if(!W) return;
    var list = (api.city && api.city()) || [];
    var key = JSON.stringify(list.map(function(h){ return [h.userId, h.level, h.look, h.cos, h.crew, !!h.isYou]; }));
    if(key === sig && !forceYou) return; sig = key;
    var old = {}; hqs.forEach(function(E){ old[E.oid] = E; });
    var next = [], made = [];
    placements(list).forEach(function(a){
      var p = placeLot(a.lot), d = toWorld(p, 0, HQ_DOOR);
      var E = {kind: "hq", oid: "hq:" + a.h.userId, lot: a.lot, h: a.h, x: p.x, y: p.y, z: p.z, rot: p.rot, door: {x: d.x, z: d.z}};
      var O = old[E.oid];
      if(O && hqKey(O) === hqKey(E) && !(forceYou && a.h.isYou)){ delete old[E.oid]; crewUpdate(O, a.h); next.push(O); return; }
      next.push(E); made.push(E);
    });
    forceYou = false;
    Object.keys(old).forEach(function(id){ unbuild(old[id]); });
    hqs = next;
    made.forEach(building);
    fadePrep(made);
    lampGlows = []; bikes = parkBikes.slice(); if(skate) skate.boards.forEach(function(b){ bikes.push(b); });
    boats.forEach(function(b){ bikes.push(b); });
    hqs.forEach(function(E){ E.glows.forEach(function(gl){ lampGlows.push(gl); }); E.items.forEach(function(b){ bikes.push(b); }); });
    buildLots();
    // arriving: at your own door, or the door of the HQ you just visited; else the plaza's spawn
    var mine = hqs.filter(function(E){ return E.h.isYou; })[0];
    var back = api.cityReturn && api.cityReturn(), ret = hqs.filter(function(E){ return E.h.userId === back; })[0];
    w.spawn = at(ret || mine); w.spawnFrom = {lobby: at(mine)};
    if(V2){
      w.home = mine ? at(mine) : null;                  // Return to HQ (T): your door, on this world
      // arriving by a trip, a boat or the island button: where it lands you (a dock, a station, the plaza)
      if(arriveAt){ var ax = +arriveAt.x || 0, az = +arriveAt.z || 0, ay = +arriveAt.yaw || 0;
        w.spawn = {x: ax, y: groundY(ax, az), z: az, yaw: ay, camYaw: ay + PI + 0.55}; }
    }
    applyTime();
  }
  // who stands on which HQ lot: v1 as ever; the Commons by the Arena's ranks; an island, its owner
  function placements(list){
    if(!V2) return assign(list, W);
    if(island()) return assignIsland(list, owner, me, W);
    return assignRows ? assignRanks(list, assignRows, W) : assign(list, W);
  }
  // every HQ lot's paved slab (one draw call), the empty ones' "Free lot" signs and the City's
  // name: rebuilt when which lots are taken changes
  function buildLots(){
    var taken = {}; hqs.forEach(function(E){ taken[E.lot.id] = 1; });
    var ls = JSON.stringify(Object.keys(taken).sort());
    if(ls === lotsSig && lotsG) return; lotsSig = ls;
    if(lotsG){ hqG.remove(lotsG); disposeTree(lotsG); }
    lotsG = new THREE.Group(); hqG.add(lotsG); freeLots = [];
    var lots = hqLots(W).filter(function(l){ return l.min_tier == null || (l.min_tier | 0) <= tier; });
    var slabs = new THREE.InstancedMesh(new THREE.BoxGeometry(1, 1, 1), slabM, Math.max(1, lots.length));
    var m4 = new THREE.Matrix4(), q = new THREE.Quaternion(), one = new THREE.Vector3(1, 1, 1), tint = new THREE.Color();
    var legend = (W.districts && W.districts.legend) || [];
    lots.forEach(function(l, n){
      var y = ((l.door || [])[1] || 0)/100, pv = PAVE[legend[l.district | 0]];
      m4.compose(new THREE.Vector3(l.x/100, y + (PAD_UP - 3)/2, l.z/100), q, new THREE.Vector3(l.w/100, 3 + PAD_UP, l.d/100)); slabs.setMatrixAt(n, m4);   // y-3 .. y+0.05
      slabs.setColorAt(n, tint.setHex(pv != null ? pv : 0xffffff));
      if(!taken[l.id]) freeLots.push(l);
    });
    slabs.count = V2 ? 0 : lots.length; slabs.receiveShadow = true; if(!V2) lotsG.add(slabs);   // v2: the lots' own ground
    if(freeLots.length){
      var plate = new THREE.InstancedMesh(new THREE.BoxGeometry(2.4, 0.6, 0.08), new THREE.MeshBasicMaterial({map: freeT.t, toneMapped: false}), freeLots.length);
      var post = new THREE.InstancedMesh(new THREE.CylinderGeometry(0.05, 0.05, 0.9, 6), mat(0x2b3a48, {metalness: 0.6}), freeLots.length);
      var up = new THREE.Vector3(0, 1, 0);
      freeLots.forEach(function(l, n){
        var f = turn(l), y = ((l.door || [])[1] || 0)/100 + PAD_UP, xf = l.x/100, zf = l.z/100 + f.s*(l.d/200 - 1.5), rot = f.rot;
        if(V2 && l.front){ var fv = frontOf(l), dd = Math.max(1, Math.min(l.w, l.d)/200 - 1.5); xf = l.x/100 + fv[0]*dd; zf = l.z/100 + fv[1]*dd; rot = Math.atan2(fv[0], fv[1]); }
        q.setFromAxisAngle(up, rot);
        m4.compose(new THREE.Vector3(xf, y + 1.05, zf), q, one); plate.setMatrixAt(n, m4);
        m4.compose(new THREE.Vector3(xf, y + 0.45, zf), q, one); post.setMatrixAt(n, m4);
      });
      lotsG.add(plate); lotsG.add(post);
    }
    var nb = hqs.length;
    var cname = !V2 ? "Arena City" : island() ? String((cityState && cityState.name) || "An island").slice(0, 32) : "The Commons";
    var cityL = c.label(cname + (V2 && island() ? "" : " · " + nb + " HQ" + (nb === 1 ? "" : "s")), HEX.amber, 1.3); cityL.position.set(plaza.x, plaza.y + 6.4, plaza.z); lotsG.add(cityL);
  }
  // where you stand arriving at an HQ (on the street side, looking at its front, a little off-axis)
  function at(E){
    if(E){ var dx = Math.sin(E.rot), dz = Math.cos(E.rot), x = E.door.x + dx*2.6, z = E.door.z + dz*2.6;
      return {x: x, y: groundY(x, z), z: z, yaw: Math.atan2(dx, dz), camYaw: E.rot + 0.55}; }
    var s = W && site("spawn:0"), sx = s ? s.x/100 : plaza.x, sz = s ? s.z/100 : plaza.z + 7;
    return {x: sx, y: groundY(sx, sz), z: sz, yaw: 0, camYaw: 0.55};
  }

  function applyTime(){
    hqs.concat(views).forEach(function(E){ if(E.B) E.B.setNight(night); });
    lampGlows.forEach(function(g){ g.material.opacity = night ? 0.85 : 0.08; });
  }
  function blocked(x, z){
    if(!W) return true;
    if(WD.blockedAt(W, x, z)) return true;
    if(sea && !sea.land(x, z)) return true;                                    // the sea: take a boat
    if(civics.length && civicBlocked(x, z)) return true;
    if(fount && Math.hypot(x - fount.g.position.x, z - fount.g.position.z) < fount.R + 0.35) return true;   // the fountain
    if(skate && SP.walkBlocked(x - skate.cx, z - skate.cz)) return true;      // its ramps (on foot or wheels; boards ride them)
    var all = hqs.concat(views);
    for(var i = 0; i < all.length; i++){
      var L = all[i], rx = x - L.x, rz = z - L.z;
      if(Math.abs(rx) > 30 || Math.abs(rz) > 30) continue;
      var c0 = Math.cos(-L.rot), s0 = Math.sin(-L.rot), lx = rx*c0 + rz*s0, lz = -rx*s0 + rz*c0;   // into its own frame
      if(L.B && L.B.blockedLocal(lx, lz)) return true;
      // its garage, and its car (where it stands: you may have parked it in the street) unless you drive it
      if(L.kind === "hq" && HQV.hqLotExtraBlocked(lx, lz, !L.car || L.car.g.visible, L.car && {x: L.car.g.position.x, z: L.car.g.position.z, yaw: L.car.g.rotation.y})) return true;
    }
    for(var j = 0; j < civic.length; j++){
      var C = civic[j];
      if(Math.hypot(x - C.tree.x, z - C.tree.z) < 0.5) return true;
      var b = toWorld(C.p, -1.6, 0); if(Math.abs(x - b.x) < 1.1 && Math.abs(z - b.z) < 1.1) return true;   // the bench (either way round)
    }
    return false;
  }
  function groundY(x, z){
    if(!W) return 0;
    if(skate && SP.inPark(x - skate.cx, z - skate.cz)) return skate.y;      // the park's flat pad; the skater adds its ramps
    return WD.groundAt(W, x, z);
  }

  /* ---------- Cities: a v2 world's civic buildings, residents, traffic, sea, boats and travel ---------- */
  var MENU_CSS = "position:absolute;left:50%;top:18%;transform:translateX(-50%);z-index:6;min-width:260px;max-width:min(440px,92%);" +
    "display:grid;gap:6px;padding:12px 14px;border-radius:12px;color:var(--ink);background:color-mix(in srgb,var(--panel) 94%,transparent);" +
    "border:1px solid var(--line);box-shadow:var(--shadow-lg);font-size:13px";
  var ITEM_CSS = "text-align:left;padding:7px 10px;border-radius:8px;border:1px solid var(--line);background:var(--panel2,var(--panel));color:var(--ink);cursor:pointer;font:inherit";
  var CIVIC_FAR = 320;       // m: a civic building further than this from the camera is not drawn
  var NPC_BUDGET = 3;        // ms: residents whose update took longer than this update every other frame
  var TALK_SHOW = 5;         // s a resident's line stays over their head
  function island(){ return worldId !== COMMONS && worldId !== LEGACY; }
  function say(t){ if(!t) return; if(api.announce) api.announce(t); if(api.toast) api.toast(t); }
  function npcMs(){ return HQV.npcSim && HQV.npcSim.localMs ? HQV.npcSim.localMs(new Date(Date.now())) : Date.now(); }
  function within(p, ms){
    return new Promise(function(res, rej){ var t = setTimeout(function(){ rej(new Error("timeout")); }, ms); Promise.resolve(p).then(function(v){ clearTimeout(t); res(v); }, function(e){ clearTimeout(t); rej(e); }); });
  }
  function getJson(path){
    var f = api.arenaGet || function(u){ return fetch(u, {cache: "no-store"}).then(function(r){ if(!r.ok) throw new Error("HTTP " + r.status); return r.json(); }); };
    try { return within(f(path), 4000); } catch(e){ return Promise.reject(e); }
  }
  function postJson(path, body){
    if(!api.arenaPost) return Promise.reject(new Error("offline"));
    try { return Promise.resolve(api.arenaPost(path, body)); } catch(e){ return Promise.reject(e); }
  }
  // the city's tier and growth: the owner's CityState (an unreachable Arena: a tier-1 island, the full Commons)
  function fetchCity(){
    return getJson("/api/arena/city/" + encodeURIComponent(owner)).then(function(st){
      cityState = st && typeof st === "object" ? st : null;
      if(cityState){ tier = Math.max(1, Math.min(5, cityState.tier | 0 || 1)); grow = Math.max(0, Math.min(1000, +cityState.grow || 0)); }
    }, function(){ tier = owner === "commons" ? 5 : 1; grow = owner === "commons" ? 1000 : 0; });
  }
  // The world: the one asked for, else the Commons, else claude-hq@1 (an Arena without @2).
  function loadChain(){
    var ids = [want]; if(want !== COMMONS) ids.push(COMMONS); ids.push(LEGACY);
    var err = null;
    function next(i){
      if(i >= ids.length) return Promise.reject(err || new Error("world unavailable"));
      return WD.load({id: ids[i]}).then(function(doc){ worldId = doc && worldOk(doc.id) ? doc.id : ids[i]; return doc; },
                                        function(e){ err = e; return next(i + 1); });
    }
    return next(0).then(function(doc){
      V2 = !!doc && (doc.v | 0) >= 2;
      if(!V2) return doc;
      owner = ownerOf(worldId);
      if(worldId !== want) say(want === COMMONS ? "" : "That island isn't available; you're in the Commons.");
      return fetchCity().then(function(){ return doc; });
    });
  }

  // civic and zone buildings (games/hqcivic.js), at this tier; the town hall's door opens its panel
  function buildCivic(){
    civics.forEach(function(B){ civicG.remove(B.g); B.hits.forEach(function(o){ var i = hits.indexOf(o); if(i >= 0) hits.splice(i, 1); });
      B.doors.forEach(function(d){ var i = doors.indexOf(d); if(i >= 0) doors.splice(i, 1); }); disposeTree(B.g); });
    civics = [];
    if(!HQV.hqCivic) return;
    civicSites(W, tier, HQV.hqCivic.KINDS ? Object.keys(HQV.hqCivic.KINDS) : null).forEach(function(site){
      // the town hall's door is the Town Hall panel's (its tab, Live, is the page's home anyway)
      if(site.kind === "townhall") site = Object.assign({}, site, {view: null});
      var B;
      try { B = HQV.hqCivic.build(c, site, {tier: tier, night: night}); } catch(e){ return; }
      civicG.add(B.g); civics.push(B);
      B.hits.forEach(function(o){ hits.push(o); });
      B.doors.forEach(function(d){ if(d.live) doors.push(d); });
    });
  }
  function civicBlocked(x, z){
    for(var i = 0; i < civics.length; i++){
      var bx = civics[i].boxes || [];
      for(var j = 0; j < bx.length; j++){ var b = bx[j]; if(x >= b.min.x && x <= b.max.x && z >= b.min.z && z <= b.max.z) return true; }
    }
    return false;
  }
  // the sea (games/ocean.js), the boats at every berth (games/hqboat.js), the other islands
  function setupSea(){
    if(!W.island || !HQV.ocean) return;
    var doc = WD.docOf(W);
    sea = HQV.ocean.seaOf(doc); w.sea = sea;
    try { oc = HQV.ocean.mount(c, S); oc.g.position.y = sea.y; if(wb && wb.sea) wb.sea.visible = false; } catch(e){ oc = null; }
    S.add(boatG);
    if(HQV.hqboat) sea.docks.forEach(function(d, n){
      var site = siteById(d.id); if(site && site.tier != null && (site.tier | 0) > tier) return;
      ["rowboat", "jetski"].forEach(function(kind, j){
        var side = j ? 3 : -3, x = d.x + Math.cos(d.yaw)*side, z = d.z - Math.sin(d.yaw)*side;
        var col = [0x2f6f9f, 0xc8323c, 0x2f8f5b, 0xe8b730][(n*2 + j) % 4], B = HQV.hqboat.model(c, kind, col, 0xf2f2f2);
        B.g.position.set(x, sea.y, z); B.g.rotation.y = d.yaw; boatG.add(B.g);
        boats.push({g: B.g, x: x, z: z, yaw: d.yaw, color: col, accent: 0xf2f2f2, kind: kind, id: "boat:" + d.id + ":" + kind, stay: true});
      });
    });
    getArch().then(function(a){ if(!dead && a) HQV.ocean.setArchipelago(archMetres(a), worldId); }, function(){});
  }
  function siteById(id){ for(var i = 0; i < W.sites.length; i++) if(W.sites[i].id === id) return W.sites[i]; return null; }
  function archMetres(a){
    function m(o){ return Object.assign({}, o, {x: (+o.x || 0)/100, z: (+o.z || 0)/100}); }
    return {commons: a.commons ? m(a.commons) : null, islands: (Array.isArray(a.islands) ? a.islands : []).map(m)};
  }
  function getArch(){
    if(arch) return Promise.resolve(arch);
    return getJson("/api/arena/archipelago").then(function(a){ arch = a && typeof a === "object" ? a : null; return arch; });
  }
  // traffic, buses and trams (games/traffic.js), and the residents (games/npcsim.js, npcdraw.js)
  function setupLife(){
    var doc = WD.docOf(W);
    if(HQV.traffic){
      try {
        tsim = HQV.traffic.create(doc, {tier: tier, grow: grow, seed: W.id, onFare: payFare});
        tview = HQV.traffic.view(c); S.add(tview.group);
      } catch(e){ tsim = null; tview = null; }
    }
    if(HQV.npcSim && HQV.npcDraw){
      try {
        var sdoc = Object.assign({}, doc, {layers: Object.assign({}, doc.layers, {zones: simZones(doc.layers.zones)})});
        nsim = HQV.npcSim.create(sdoc, {tier: tier, grow: grow, seed: W.seed || W.id});
        ndraw = HQV.npcDraw.create(THREE, S, nsim, {lib: c.L});
      } catch(e){ nsim = null; ndraw = null; }
    }
  }
  // a ride's fare goes to this city's treasury (the owner rides free; an unpaired page rides free too)
  function payFare(f){
    var kind = f && (f.kind === "tram" ? "tram" : f.kind === "fast" ? "fast" : "bus");
    postJson("/api/arena/city/" + encodeURIComponent(owner) + "/fare", {kind: kind}).then(function(r){
      if(r && r.ok === false && r.j && (r.j.error || r.j.detail)) say(String(r.j.error || r.j.detail).slice(0, 120));
    }, function(){});
  }

  /* the menus: a stop's lines, a terminal's trips; plain DOM, textContent only */
  function closeMenu(){
    if(menuKey){ window.removeEventListener("keydown", menuKey, true); menuKey = null; }
    if(menu && menu.parentNode) menu.parentNode.removeChild(menu);
    menu = null;
  }
  function openMenu(title, items){
    closeMenu();
    var el = c.el; if(!el || typeof document === "undefined") return;
    try { if(document.pointerLockElement && document.exitPointerLock) document.exitPointerLock(); } catch(e){}
    var m = document.createElement("div"); m.className = "hqcity-menu"; m.setAttribute("role", "dialog"); m.setAttribute("aria-label", title);
    m.style.cssText = MENU_CSS;
    var h = document.createElement("b"); h.textContent = title; m.appendChild(h);
    var first = null;
    items.forEach(function(it, i){
      var b = document.createElement("button"); b.type = "button"; b.style.cssText = ITEM_CSS;
      b.textContent = (i < 9 ? (i + 1) + ". " : "") + it.text; b.disabled = !!it.off;
      b.addEventListener("click", function(){ closeMenu(); it.fn(); });
      m.appendChild(b); if(!first && !it.off) first = b;
    });
    if(!items.length){ var p = document.createElement("span"); p.textContent = "Nothing leaves from here right now."; m.appendChild(p); }
    var x = document.createElement("button"); x.type = "button"; x.style.cssText = ITEM_CSS; x.textContent = "Close (Esc)";
    x.addEventListener("click", closeMenu); m.appendChild(x);
    el.appendChild(m); menu = m;
    menuKey = function(e){
      if(e.type !== "keydown") return;
      if(e.key === "Escape" || e.code === "KeyE"){ e.preventDefault(); closeMenu(); return; }
      var n = parseInt(e.key, 10);
      if(n >= 1 && n <= 9 && items[n - 1] && !items[n - 1].off){ e.preventDefault(); closeMenu(); items[n - 1].fn(); }
    };
    window.addEventListener("keydown", menuKey, true);
    try { (first || x).focus(); } catch(e){}
  }
  function stopName(id){
    var s = siteById(id); if(!s) return String(id);
    var r = WD.nearestRoad(W, s.x/100, s.z/100, 40);
    return (r && r.name ? r.name : String(id)) + (s.kind === "tramstop" ? " (tram)" : "");
  }
  function openStopMenu(stop){
    var now = Date.now(), items = [];
    stopMenu(tsim, stop.id, now).forEach(function(L){
      L.to.slice(0, 6).forEach(function(to){
        items.push({text: (L.kind === "tram" ? "Tram " : "Bus ") + L.line.split(":")[1] + " to " + stopName(to) + " · in " + waitText(L.arrive - now),
          fn: function(){ waitFor(stop, L.line, to); }});
      });
    });
    openMenu("Stop: " + stopName(stop.id), items.slice(0, 9));
  }
  function waitFor(stop, line, to){
    var trip = tsim && tsim.rideTo(line, stop.id, to, Date.now());
    if(!trip){ say("That line isn't running from here now."); return; }
    bus = {trip: trip, phase: "wait", at: {x: stop.x, z: stop.z}};
    say("The " + trip.kind + " to " + stopName(to) + " comes in " + waitText(trip.arrive - Date.now()) + ". Fare " + trip.fare.coins + " coins. E cancels.");
  }
  function busStep(){
    if(!bus) return;
    var now = Date.now(), av = c.avatar();
    if(bus.phase === "wait"){
      if(av && Math.hypot(av.x - bus.at.x, av.z - bus.at.z) > STOP_R*2){ bus = null; say("You left the stop."); return; }
      if(now >= bus.trip.arrive){ bus.phase = "ride"; bus.trip.pay(); say("All aboard."); }
    } else if(bus.phase === "ride" && now >= bus.trip.reach){
      var p = bus.trip.pose(now), right = 3.5;       // step off onto the kerb, on the right of travel
      var x = p.x - Math.cos(p.yaw)*right, z = p.z + Math.sin(p.yaw)*right;
      bus = null; if(c.teleport) c.teleport(x, z, p.yaw); say("You're at your stop.");
    }
  }
  // where you stand while a trip holds you: the bus seat, or the terminal you leave from
  w.carry = function(){
    if(bus && bus.phase === "ride"){ var p = bus.trip.pose(Date.now()); return {x: p.x, y: p.y + 0.5, z: p.z, yaw: p.yaw}; }
    var T = NAV.trip;
    if(T && T.from === worldId && (T.phase === "boarding" || T.phase === "paying" || T.phase === "riding" || T.phase === "holding") && T.hold) return T.hold;
    return null;
  };

  // travel between islands (games/hqtravel.js): a dock, port, station or airport offers trips
  function here(){
    var a = arch || {}, o = worldId === COMMONS ? a.commons : (a.islands || []).filter(function(i){ return i && i.world === worldId; })[0];
    return {world: worldId, tier: tier, doc: WD.docOf(W), city: cityState, name: cityState && cityState.name, x: o ? (+o.x || 0)/100 : 0, z: o ? (+o.z || 0)/100 : 0};
  }
  var MODE_NAME = {ferry: "Ferry", rail: "Train", plane: "Plane", fast: "Fast travel"};
  function openTravelMenu(site){
    getArch().then(function(a){
      if(dead) return;
      var from = here(), items = [];
      travelPlaces(a, worldId, me).forEach(function(to){
        HQV.hqTravel.options(from, to, Date.now()).forEach(function(o){
          if(o.self) return;
          var txt = MODE_NAME[o.mode] + " to " + to.name + " · " + Math.round(o.seconds) + " s" + (o.fee ? " · " + o.fee + " coin" : "");
          if(o.departs) txt += " · sails in " + waitText(o.departs - Date.now());
          items.push({text: txt, fn: function(){ startTrip(o.mode, from, to, site); }});
        });
      });
      openMenu(siteTitle(site), items.slice(0, 9));
    }, function(){ say("The Arena didn't answer: no trips right now."); });
  }
  function siteTitle(s){ return s.kind === "transit" ? "Station" : s.kind === "airport" ? "Airport" : s.kind === "port" ? "Port" : "Dock"; }
  function travelHooks(){
    return {
      fetchDoc: function(world){ return WD.load({id: world}).then(function(W2){ if(!W2 || (W2.v | 0) < 2 || W2.id !== world) throw new Error("bad doc"); return WD.docOf(W2); }); },
      fetchCity: function(world){ return getJson("/api/arena/city/" + encodeURIComponent(ownerOf(world))).then(null, function(){ return null; }); },
      // the City is built on arrival from the doc just loaded (world.js keeps it in memory)
      buildWorld: function(){ return Promise.resolve(true); },
      fare: function(kind){ return postJson("/api/arena/city/" + encodeURIComponent(owner) + "/fare", {kind: "fast"}).then(function(r){ if(r && r.ok === false) throw new Error("fare"); return r; }); },
      onArrive: function(sp){
        if(!sp || sp.failed){ NAV.trip = null; if(sp && c.teleport) c.teleport(sp.x, sp.z, sp.yaw); say((sp && sp.message) || "The trip didn't work out."); return; }
        if(c.goCity) c.goCity(sp.world, sp);
      },
      now: function(){ return Date.now(); }
    };
  }
  function startTrip(mode, from, to, site){
    var me0 = c.avatar() || {x: 0, z: 0}, d = site ? doorOf(site) : {x: me0.x, z: me0.z, yaw: 0};
    var T = HQV.hqTravel.start(mode, from, to, travelHooks());
    if(!T || !T.ok){ say((T && T.error) || "That way isn't open."); return; }
    T.hold = {x: d.x, y: groundY(d.x, d.z), z: d.z, yaw: d.yaw};
    NAV.trip = T;
    say(mode === "ferry" ? "The ferry to " + to.name + " sails in " + waitText(T.departAt - Date.now()) + ". E gets off before it sails."
      : MODE_NAME[mode] + " to " + to.name + ".");
  }
  function tripStep(){
    var T = NAV.trip; if(!T) return null;
    var ph = T.update();
    if(ph === "done" || ph === "failed"){ var p = T.pose(); if(!(p.fade > 0.01)){ NAV.trip = null; return null; } return p; }
    return T.pose();
  }
  // the ride's camera, in the world its frame belongs to
  w.camPose = function(){
    var T = NAV.trip; if(!T) return null;
    var p = T.pose(); if(!p) return null;
    if((p.frame === "from" && T.from !== worldId) || (p.frame === "to" && T.to !== worldId)) return null;
    return p;
  };
  function fadeTo(a){
    if(!c.el || typeof document === "undefined") return;
    if(!fadeEl){ if(!(a > 0.001)) return; fadeEl = document.createElement("div"); fadeEl.setAttribute("aria-hidden", "true");
      fadeEl.style.cssText = "position:absolute;inset:0;z-index:5;pointer-events:none;background:var(--bg,var(--panel));opacity:0"; c.el.appendChild(fadeEl); }
    fadeEl.style.opacity = String(Math.max(0, Math.min(1, a || 0)));
  }

  // a boat that reaches another island lands you on its dock; the wake behind yours
  var boatNow = null;
  w.onBoat = function(b){
    boatNow = b;
    if(!b || !V2 || landing || !HQV.ocean || !HQV.hqTravel || !arch) return;
    var q = HQV.ocean.nearestIsland(b.st.x, b.st.z);
    if(!q || !q.arrive || !worldOk(q.world)) return;
    landing = true; say("Mooring at " + (q.name || "the island") + "…");
    HQV.hqTravel.arrive(q.world, null, travelHooks()).then(function(sp){ if(sp && sp.failed) landing = false; });
  };
  // stepping ashore from a boat: at a berth (onto its dock), or with the bow on a beach
  w.boatLand = function(st){
    if(!sea || !st) return null;
    var best = null, bd = 12;
    sea.docks.forEach(function(d){ var dd = Math.hypot(st.x - d.x, st.z - d.z); if(dd < bd){ bd = dd; best = d; } });
    if(best){ var s = siteById(best.id); if(s){ var f = frontOf(s); return {x: s.x/100 - f[0]*2, z: s.z/100 - f[1]*2, yaw: Math.atan2(-f[0], -f[1])}; } }
    var sx = Math.sin(st.yaw), sz = Math.cos(st.yaw);
    if(sea.land(st.x + sx*2.5, st.z + sz*2.5) && sea.land(st.x + sx*4, st.z + sz*4)) return {x: st.x + sx*4, z: st.z + sz*4, yaw: st.yaw};
    return null;
  };

  // E: a resident's line, a stop's lines, a terminal's trips (and E again cancels a wait)
  w.use = function(p){
    if(!V2 || !p) return false;
    if(menu){ closeMenu(); return true; }
    if(bus){ if(bus.phase === "wait"){ bus = null; say("You stopped waiting."); } return true; }
    if(NAV.trip && NAV.trip.phase === "boarding"){ NAV.trip = null; say("You stayed ashore."); return true; }
    if(ndraw){
      var line = ndraw.talk({x: p.x, z: p.z}, npcMs());
      if(line && line.text){ showTalk(line); return true; }
    }
    if(tsim){ var st = tsim.stopsNear(p.x, p.z, STOP_R)[0]; if(st){ openStopMenu(st); return true; } }
    var tm = HQV.hqTravel ? terminalAt(W, tier, p.x, p.z) : null;
    if(tm){ openTravelMenu(tm); return true; }
    return false;
  };
  w.menuOpen = function(){ return !!menu; };
  function showTalk(line){
    if(talkL){ S.remove(talkL.o); disposeTree(talkL.o); }
    var o = c.label(String(line.text).slice(0, 90), HEX.green, 0.55); o.position.set(line.x, (line.y || groundY(line.x, line.z)) + 2.4, line.z); S.add(o);
    talkL = {o: o, until: Date.now() + TALK_SHOW*1000};
    if(api.announce) api.announce(String(line.text));
  }
  // the town hall's door: its panel (yours: owner controls; the Commons: none)
  w.townHall = function(){
    if(!HQV.townHall || !HQV.townHall.open) return;
    HQV.townHall.open(owner, {mine: !!me && owner === me});
  };
  // "My island" in the Commons, "The Commons" on an island: straight there (going home is free)
  function buildUi(){
    if(!V2 || !c.el || typeof document === "undefined" || ui) return;
    var to = island() ? COMMONS : islandOf(me);
    if(!to) return;
    ui = document.createElement("button"); ui.type = "button"; ui.className = "hq3d-home"; ui.style.top = "52px";
    ui.textContent = island() ? "⛲ The Commons" : "🏝 My island";
    ui.title = island() ? "Back to the Commons" : "Go to your own island";
    ui.addEventListener("click", function(){ if(NAV.trip || bus) return; if(c.goCity) c.goCity(to, null); });
    c.el.appendChild(ui);
  }
  function citiesSetup(){
    buildCivic(); S.add(civicG);
    setupSea(); setupLife(); buildUi();
    if(worldId === COMMONS) getJson("/api/arena/world/" + COMMONS + "/assign").then(function(rows){
      if(dead || !Array.isArray(rows)) return; assignRows = rows; sig = null; build();
    }, function(){});
  }
  function citiesUpdate(t, dt, k, cam){
    var nowMs = Date.now();
    // civic buildings far from the camera are not drawn (the map shows them all), as the HQs
    civics.forEach(function(B){
      if(cam && cam.x != null){
        var d = Math.hypot(B.x - cam.x, B.z - cam.z), vis = (cam.mode === "map") || (B.g.visible ? d < CIVIC_FAR : d < CIVIC_FAR - HQ_FAR_HYST);
        if(B.g.visible !== vis) B.g.visible = vis;
      }
      if(B.g.visible) B.animate(t, dt, k);
    });
    var me0 = (cam && cam.avatar) || c.avatar() || {x: 0, z: 0};
    if(oc && cam){
      oc.step(t, dt, cam);
      if(boatNow) oc.wake([{id: "you", x: boatNow.st.x, z: boatNow.st.z, yaw: boatNow.st.yaw, speed: boatNow.st.speed || 0, beam: boatNow.beam}]);
    }
    if(tsim && tview){
      var obs = boatNow ? [] : [{x: me0.x, z: me0.z, r: 1}];
      try { tview.update(tsim.at(nowMs, {x: cam ? cam.x : me0.x, z: cam ? cam.z : me0.z}, 320, obs), nowMs); } catch(e){}
    }
    if(ndraw && cam){
      if(npcSkip > 0) npcSkip--;
      else {
        var t0 = typeof performance !== "undefined" ? performance.now() : 0;
        ndraw.update(npcMs(), {x: cam.x, z: cam.z}, me0, dt);
        var used = typeof performance !== "undefined" ? performance.now() - t0 : 0;
        if(used > NPC_BUDGET) npcSkip = 1;
      }
    }
    if(talkL && nowMs > talkL.until){ S.remove(talkL.o); disposeTree(talkL.o); talkL = null; }
    busStep();
    var tp = tripStep();
    fadeTo(tp && (tp.frame === "from" ? NAV.trip && NAV.trip.from === worldId : true) ? tp.fade || 0 : 0);
  }
  function citiesDestroy(){
    closeMenu();
    if(ui && ui.parentNode) ui.parentNode.removeChild(ui);
    if(fadeEl && fadeEl.parentNode) fadeEl.parentNode.removeChild(fadeEl);
    if(tview){ try { tview.dispose(); } catch(e){} }
    if(ndraw){ try { ndraw.dispose(); } catch(e){} }
    if(oc){ try { oc.dispose(); } catch(e){} }
    S.remove(civicG); S.remove(boatG);
  }

  /* ---------- loading: the world doc, then every tile drawable ---------- */
  function setup(doc){
    if(dead) throw new Error("world unavailable: closed");     // hq3d gave up on us (timeout): build nothing
    W = doc; indexBuildings();
    wb = HQV.worldbuild.create(c, W, V2 ? {scene: S, quality: 2, tier: tier} : {scene: S, quality: 2});
    S.add(wb.root); S.add(staticG); S.add(hqG);
    buildStatic();
    if(V2) citiesSetup();
    build();
    wb.setNight(night);
    return wb.ready;
  }
  w.whenReady = new Promise(function(res, rej){
    if(!WD || !HQV.worldbuild || !parts){ rej(new Error("world unavailable: client")); return; }
    loadChain().then(setup).then(function(){ res(w); }, rej);
  });
  w.whenReady.catch(function(){});      // hq3d.js handles it; no unhandled-rejection noise if it never asks
  // A newer world doc than the one this City was built on (the cached one, then the server's after a re-pin):
  // nothing here rebuilds in place. w.stale asks hq3d to drop this world and make a fresh one when you next enter the City.
  w.stale = false;
  if(WD && WD.onChange) WD.onChange(function(nw){ if(!dead && W && nw && nw.hash !== W.hash) w.stale = true; }, want);
  // hq3d's fallback to the legacy City (timeout, rejection) drops this world: stop the tiles and their worker
  w.destroy = function(){
    dead = true;
    if(wb){ wb.destroy(); wb = null; }
    S.remove(staticG); S.remove(hqG);
    citiesDestroy();
  };

  /* ---------- the world contract ---------- */
  // the presence room: per world where the Arena knows rooms per world ("isles"), else the 3D City's
  Object.defineProperty(w, "net", {get: function(){ return V2 ? netRoom(worldId, !!(api.netCan && api.netCan("isles"))) : "city3d"; },
    configurable: true});
  w.world = function(){ return worldId; };
  w.hits = hits; w.doors = doors; w.span = 18; w.zoom = 0.8; w.camY = 2.5; w.follow = 1; w.camPitch = 0.72;
  w.bounds = [-1018, 1018, -1018, 1018];
  w.camModes = ["map", "far", "chase", "near", "fp", "classic", "photo", "cine"];
  w.startMode = "map";
  if(arriveAt) w.startMode = "chase";            // off a ferry, a train, a boat: on the ground, not over the map
  w.skateBase = 0; w.skatepark = null;
  w.spawn = {x: 0, y: 0, z: 10, yaw: 0, camYaw: 0.55}; w.spawnFrom = {lobby: w.spawn};
  w.blocked = blocked;
  w.groundY = groundY;
  Object.defineProperty(w, "bikes", {get: function(){ return bikes; }, configurable: true});
  Object.defineProperty(w, "floor", {get: function(){ return wb ? wb.terrainMeshes() : []; }, configurable: true});
  // hq3d's quality governor and the ?hqsmoke stats line reach the tiles through these
  w.setQuality = function(q){ if(wb) wb.setQuality(q); };
  w.stats = function(){ return wb ? wb.stats() : {}; };
  w.onCity = function(){ build(); };
  w.onLook = function(){ forceYou = true; build(); };      // your own look: your building again
  w.camHit = function(from, to){
    if(!W) return 1;
    var t = WD.rayGround(W, from, to);
    var x0 = Math.min(from.x, to.x), x1 = Math.max(from.x, to.x), z0 = Math.min(from.z, to.z), z1 = Math.max(from.z, to.z);
    if(Math.hypot(to.x - from.x, to.z - from.z) > 60){ var u = 60/Math.hypot(to.x - from.x, to.z - from.z);   // only what is within 60 m
      x0 = Math.min(from.x, from.x + (to.x - from.x)*u); x1 = Math.max(from.x, from.x + (to.x - from.x)*u);
      z0 = Math.min(from.z, from.z + (to.z - from.z)*u); z1 = Math.max(from.z, from.z + (to.z - from.z)*u); }
    buildingsIn(x0, x1, z0, z1).concat(placedIn(x0, x1, z0, z1)).forEach(function(b){ var h = segBox(from, to, b); if(h < t) t = h; });
    return t;
  };
  w.occluderItems = function(x, y, z){
    if(!W) return [];
    return buildingsIn(x - 40, x + 40, z - 40, z + 40).map(function(b){ return {id: b.id, min: b.min, max: b.max}; })
      .concat(placedIn(x - 40, x + 40, z - 40, z + 40));
  };
  w.setFaded = function(ids){
    ids = ids || [];
    if(wb) wb.setFaded(ids.filter(function(id){ return typeof id === "number"; }).slice(0, 8));
    hqs.concat(views).forEach(function(E){ fadeGoal(E, ids.indexOf(E.oid) >= 0); });
  };
  w.mapPick = function(x, z){
    var E = pickAt(hqs, x, z);
    if(E) return {kind: "hq", you: !!E.h.isYou, userId: E.h.userId, door: {x: E.door.x, z: E.door.z}, name: E.name, lot: {x: E.lot.x/100, z: E.lot.z/100}};
    return {kind: "point", x: x, z: z};
  };
  w.mapInfo = function(){
    return {roads: W ? WD.roadLabels(W) : [],
      hqs: hqs.map(function(E){ return {userId: E.h.userId, name: E.name, x: E.lot.x/100, y: E.y, z: E.lot.z/100, you: !!E.h.isYou}; })};
  };
  w.setTime = function(n){ night = n; S.background = null; paintSky(n); fog.color.set(n ? 0x0f1f30 : 0xb8dcf2);
    hemi.intensity = n ? 1.3 : 2.4; sun.intensity = n ? 0.7 : 2.4; sun.color.set(n ? 0xa9b8ff : 0xfff2dc);
    if(wb) wb.setNight(n); applyTime();
    civics.forEach(function(B){ B.setNight(n); }); if(oc) oc.setTime(n); };
  // Fading: in classic the buildings between you and hq3d's orthographic view (as hqbase.js
  // hqCutaway decides it); in every rig mode hq3d passes the occluders to w.setFaded. Switching
  // between the two clears the other's fades. Either way the fade itself eases (fadeStep).
  function cutawayGoals(){
    var me = c.avatar(), v = c.view && c.view(); if(!me || !v) return;
    var ux = Math.sin(v.yaw), uz = Math.cos(v.yaw), tp = Math.max(0.2, Math.tan(v.pitch));
    hqs.concat(views).forEach(function(L){
      var vx = L.x - me.x, vz = L.z - me.z, along = vx*ux + vz*uz, side = Math.abs(vx*uz - vz*ux);
      fadeGoal(L, along > 2 && side < (L.side || 14) && along < L.H/tp + 8);
    });
  }
  var fadeAcc = 0, lastMode = null, shadowKey = "", SUN_DIR = {x: 0.45, y: 0.79, z: 0.34};
  w.update = function(t, dt, k, cam){
    var mode = (cam && cam.mode) || "classic";
    // the sky dome sits on the camera (position only), just inside its far plane
    if(cam){ sky.position.set(cam.x || 0, cam.y || 0, cam.z || 0); sky.scale.setScalar(Math.min(2400, (cam.far || 500)*0.9)); }
    if(mode !== lastMode){
      if(lastMode === "classic") hqs.concat(views).forEach(function(E){ fadeGoal(E, false); });
      if(mode === "classic") w.setFaded([]);
      lastMode = mode;
    }
    if(mode === "classic"){ fadeAcc += dt; if(fadeAcc > FADE_EVERY){ fadeAcc = 0; cutawayGoals(); } }
    hqs.concat(views).forEach(function(E){ fadeStep(E, dt, k); });
    if(wb && cam && cam.frustum){ if(V2) cam.time = Date.now()/1000; wb.update(cam); }   // the shared clock: the same water everywhere
    S.fog = mode === "map" ? null : fog;
    // HQs far from the camera are not drawn (the map shows them all)
    if(cam && cam.x != null) hqs.forEach(function(E){
      var d = Math.hypot(E.x - cam.x, E.z - cam.z), vis = mode === "map" || (E.g.visible ? d < HQ_FAR : d < HQ_FAR - HQ_FAR_HYST);
      if(E.g.visible !== vis) E.g.visible = vis;
    });
    // the sun's shadow box follows you (the whole map in map mode), on its texel grid
    var me = (cam && cam.avatar) || c.avatar() || {x: 0, z: 0}, map = mode === "map", R = map ? 1024 : 60, D = map ? 1500 : 120;
    var ay = me.y != null ? me.y : groundY(me.x, me.z);
    var sp = map ? {x: 0, y: 0, z: 0} : snapShadow({x: me.x, y: ay, z: me.z}, SUN_DIR, 2*R/(sun.shadow.mapSize.x || 2048));
    sun.target.position.set(sp.x, sp.y, sp.z);
    sun.position.set(sp.x + SUN_DIR.x*D, sp.y + SUN_DIR.y*D, sp.z + SUN_DIR.z*D);
    var key = R + ":" + D;
    if(key !== shadowKey){ shadowKey = key; var sc = sun.shadow.camera; sc.left = -R; sc.right = R; sc.top = R; sc.bottom = -R; sc.near = 1; sc.far = 2*D + 200; sc.updateProjectionMatrix(); }
    hqs.concat(views).forEach(function(E){ if(E.B && (!E.g || E.g.visible)) E.B.animate(t, dt, k); });
    if(fount) fount.step(t);
    cars.forEach(function(cr){ carStep(cr, dt, k); });
    if(V2) citiesUpdate(t, dt, k, cam);
  };
  w.setTime(night);
  return w;
};
})();
