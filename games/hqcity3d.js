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
 *                 town hall's opens HQV.townHall (ui/app/38-townhall.js). In full within CIVIC_NEAR of the
 *                 camera, beyond it (and from the map's height) as boxes in one InstancedMesh.
 *   HQs           the Commons: each open HQ on the lot GET /api/arena/world/claude-hq@2/assign gives it
 *                 (by rank; else sorted by user id as on @1); an island: its owner's, by the town hall.
 *   residents     games/npcsim.js + npcdraw.js, ticked each frame inside NPC_BUDGET; E on one: its line.
 *   traffic       games/traffic.js (cars, buses, trams); E at a stop: pick a stop, wait, ride (the fare
 *                 goes through POST /api/arena/city/<owner>/fare).
 *   the sea       games/ocean.js (the water, the other islands from /api/arena/archipelago) and the boats
 *                 of games/hqboat.js moored alongside every dock's pier (its deck is walked on, and the
 *                 sea's land for the boats); a boat that reaches another island lands you there.
 *   travel        E at a dock, port, station or airport: games/hqtravel.js trips (ferry, rail, plane, fast
 *                 travel), the ride's camera through w.camPose; the "My island" / "The Commons" button.
 *   net room      city3d:<world id> where the Arena's presence lists "isles" (protocol v3), else city3d.
 * Navigation (3.1, every 3D City, v1 too): the minimap (games/hqminimap.js), the Go to panel and the route banner
 * (hqnavui.js, N or the Go to button), chevrons and a pillar (hqroutefx.js) along hqnav.js's road route; while a
 * menu or the panel is open no key reaches the page's shortcuts or moves you.
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
// Where an HQ's garage goes (hqcityparts lotExtras): {x, z} its middle and s (1: the car and bikes on its +x
// side, as on @1; -1 mirrored), all in the HQ's frame. An @1 lot: the legacy spot. A v2 lot: the first spot,
// nearest the legacy one, where the garage stands inside the lot's polygon, clear of the HQ (and its wings) and
// of the walk to its door; null when there is none.
function inRing(P, x, z){
  var inside = false;
  for(var i = 0, j = P.length - 1; i < P.length; j = i++){
    var xi = P[i][0], zi = P[i][1], xj = P[j][0], zj = P[j][1];
    if((zi > z) !== (zj > z) && x < (xj - xi)*(z - zi)/(zj - zi) + xi) inside = !inside;
  }
  return inside;
}
function garagePlace(lot, p, wings){
  var G = HQV.hqLotExtras.garage;
  if(!lot || !lot.poly || lot.poly.length < 3) return {x: G.x, z: G.z, s: 1};
  var P = lot.poly.map(function(q){ return [q[0]/100, q[1]/100]; }), hw = G.w/2 + 0.3, hd = G.d/2 + 0.3;
  // the HQ's footprint (hqBoxes: the tower, then each wing) and the walk from its door to the front
  var keep = [[0, 0, 4.8, 3.8], [0, HQ_DOOR + 6, 1.6, 6]];
  if(wings >= 1) keep.push([-10.5, 0.5, 3, 2.8]);
  if(wings >= 2) keep.push([10.5, 0.5, 3, 2.8]);
  function fits(x, z){
    for(var k = 0; k < keep.length; k++){ var K = keep[k]; if(Math.abs(x - K[0]) < hw + K[2] && Math.abs(z - K[1]) < hd + K[3]) return false; }
    for(var i = -1; i <= 1; i++) for(var j = -1; j <= 1; j++){ var w = toWorld(p, x + i*hw, z + j*hd); if(!inRing(P, w.x, w.z)) return false; }
    return true;
  }
  var best = null;
  for(var gx = -30; gx <= 30; gx += 0.5) for(var gz = -16; gz <= 16; gz += 0.5){
    if(!fits(gx, gz)) continue;
    var d = (Math.abs(gx) - G.x)*(Math.abs(gx) - G.x) + (gz - G.z)*(gz - G.z) + (gz < 0 ? 400 : 0);   // in front of the HQ first
    if(!best || d < best.d) best = {x: gx, z: gz, s: gx < 0 ? -1 : 1, d: d};
  }
  return best && {x: best.x, z: best.z, s: best.s};
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
// The city's numbers for the stats panel: the CityState's (population, tier, growth, treasury, specialty) and a
// happiness index, 0..100: the share of homes and workplaces at this tier within reach (straight line) of each
// service and of a park, averaged. Buses count from tier 2, when they start running. The generator keeps the
// services in reach as a city grows, so in practice the parks move it: a big city that has outgrown its parks.
var SERVICES = [
  {key: "safety", label: "Fire cover", kinds: {fire: 1}, r: 800},
  {key: "police", label: "Police", kinds: {police: 1}, r: 800},
  {key: "health", label: "Clinics", kinds: {clinic: 1, hospital: 1}, r: 600},
  {key: "schools", label: "Schools", kinds: {school: 1, university: 1}, r: 1000},
  {key: "transit", label: "Transit", kinds: {busstop: 1, tramstop: 1, transit: 1}, r: 250, tier: 2},
  {key: "green", label: "Parks", districts: {3: 1, 8: 1}, r: 300}          // a park block or the plaza
];
var TIER_NAMES = ["Village", "Town", "City", "Metropolis", "Capital"];     // as the Town Hall panel (38-townhall.js)
function cityStats(W, tier, st){
  tier = Math.max(1, Math.min(5, tier | 0 || 1));
  var lots = ((W && W.lots) || []).filter(function(l){ return l && (l.min_tier == null || (l.min_tier | 0) <= tier); });
  var sites = ((W && W.sites) || []).filter(function(s){ return s && (s.tier == null || (s.tier | 0) <= tier); });
  var parts = [], sum = 0;
  SERVICES.forEach(function(S){
    if(!lots.length || (S.tier && tier < S.tier)) return;
    var at = S.districts ? ((W && W.blocks) || []).filter(function(b){ return b && S.districts[b.district]; })
                         : sites.filter(function(s){ return S.kinds[s.kind]; });
    var r2 = S.r*S.r*1e4, n = 0;   // cm
    lots.forEach(function(l){
      for(var i = 0; i < at.length; i++){ var dx = l.x - at[i].x, dz = l.z - at[i].z; if(dx*dx + dz*dz <= r2){ n++; return; } }
    });
    var share = n/lots.length;
    parts.push({key: S.key, label: S.label, pct: Math.round(share*100)}); sum += share;
  });
  st = st && typeof st === "object" ? st : {};
  var num = function(v){ return typeof v === "number" && isFinite(v) ? v : null; };
  return {tier: tier, tierName: TIER_NAMES[tier - 1], grow: Math.max(0, Math.min(1000, num(st.grow) || 0)),
          population: num(st.population), treasury: num(st.treasury), specialty: typeof st.specialty === "string" ? st.specialty : null,
          happiness: parts.length ? Math.round(sum/parts.length*100) : null, parts: parts, homes: lots.length};
}
// where a site's door is (m): its centre, out along its front past its depth
function doorOf(s){ var f = frontOf(s), r = (s.d || 0)/200 + 1; return {x: s.x/100 + f[0]*r, z: s.z/100 + f[1]*r, yaw: Math.atan2(f[0], f[1])}; }
// a site's back, a metre out (m): a dock's or a port's land side, where its front reaches out over the water
function backOf(s){ var f = frontOf(s), r = (s.d || 0)/200 + 1; return {x: s.x/100 - f[0]*r, z: s.z/100 - f[1]*r}; }
// the travel terminal (dock, port, transit hub, airport) whose door is within reach of (x, z), else null; a dock
// or a port from its land side too (where navigation brings you: hqnav's door for it)
function terminalAt(W, tier, x, z){
  var best = null, bd = TERMINAL_R;
  ((W && W.sites) || []).forEach(function(s){
    if(!TERMINALS[s.kind] || (s.tier != null && (s.tier | 0) > tier)) return;
    var d = doorOf(s), dd = Math.hypot(x - d.x, z - d.z);
    if(s.kind === "dock" || s.kind === "port"){ var b = backOf(s); dd = Math.min(dd, Math.hypot(x - b.x, z - b.z)); }
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
  assignIsland: assignIsland, garagePlace: garagePlace, civicSites: civicSites, doorOf: doorOf, backOf: backOf, terminalAt: terminalAt, stopMenu: stopMenu,
  waitText: waitText, travelPlaces: travelPlaces, netRoom: netRoom, simZones: simZones, cityStats: cityStats};
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
  var spx = null, wx = null, wxKey = "";       // the landmarks and the park (games/hqspectacle.js); the weather (games/hqweather.js)

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
  function paintSky(n, wl){
    var cs = SKY[n ? "night" : "day"].map(function(h){ return new THREE.Color(h); }), tmp = new THREE.Color();
    if(wl && wl.tintK > 0){                       // weather (games/hqweather.js): overcast, darker by night
      var tc = new THREE.Color(n ? HQV.hqWeather.lerpHex(wl.tint, 0, 0.84) : wl.tint);
      cs.forEach(function(cc, i){ cc.lerp(tc, wl.tintK*(i === 0 ? 0.8 : 1)); });
    }
    if(wl && wl.flash > 0.05){ var fl = new THREE.Color(0xdfe8ff); cs.forEach(function(cc){ cc.lerp(fl, wl.flash*0.6); }); }
    var P = skyGeo.attributes.position;
    for(var i = 0; i < P.count; i++){
      var y = Math.max(0, P.getY(i));
      if(y < 0.35) tmp.copy(cs[2]).lerp(cs[1], y/0.35); else tmp.copy(cs[1]).lerp(cs[0], (y - 0.35)/0.65);
      skyCol[i*3] = tmp.r; skyCol[i*3 + 1] = tmp.g; skyCol[i*3 + 2] = tmp.b;
    }
    skyGeo.attributes.color.needsUpdate = true;
    stars.visible = !!n && !(wl && wl.cloud > 0.75);
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
  var civics = [], civicG = new THREE.Group(), boatG = new THREE.Group(), boats = [], civicLod = null, decks = [];
  var oc = null, sea = null, arch = null, tsim = null, tview = null, nsim = null, ndraw = null;
  var bus = null, menu = null, menuKey = null, talkL = null, ui = null, statsEl = null, statsAt = 0, fadeEl = null, landing = false, npcSkip = 0;

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
    var ae = Math.min(11, (E.lot.d || 0)/200 - HQ_DZ);
    E.garage = garagePlace(E.lot, p, B.wings);
    var X = E.garage ? parts.lotExtras(c, g, HQV.hqPlated ? HQV.hqPlated(HQV.hqLotColors(h.look), h) : HQV.hqLotColors(h.look), p.rot, function(x, z){ return toWorld(p, x, z); }, ae, h.userId, E.garage)
                     : {glows: [], car: null, items: []};
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
    if(air) air.props(mine).forEach(function(b){ bikes.push(b); });       // air: the helicopters (and your own, by your HQ)
    planeProps.forEach(function(b){ bikes.push(b); });                     // planes: the seaplane at the dock, the prop plane at the airport
    var back = api.cityReturn && api.cityReturn(), ret = hqs.filter(function(E){ return E.h.userId === back; })[0];
    w.spawn = at(ret || mine); w.spawnFrom = {lobby: at(mine)};
    if(V2){
      w.home = mine ? at(mine) : null;                  // Return to HQ (T): your door, on this world
      // arriving by a trip, a boat or the island button: where it lands you (a dock, a station, the plaza)
      if(arriveAt){ var ax = +arriveAt.x || 0, az = +arriveAt.z || 0, ay = +arriveAt.yaw || 0;
        w.spawn = {x: ax, y: groundY(ax, az), z: az, yaw: ay, camYaw: ay + PI + 0.55}; }
    }
    navRefresh();
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
    if(bridges && bridges.blockedAt(x, z)) return true;                      // an opening bridge's gap or barrier
    if(sea && !sea.land(x, z)) return true;                                    // the sea: take a boat
    if(civics.length && civicBlocked(x, z)) return true;
    if(spx && spx.blocked(x, z)) return true;                               // landmarks, the park's fence, gate and rides
    if(air && air.blocked(x, z)) return true;                              // air: hangars, the tower, the base's fence
    if(fount && Math.hypot(x - fount.g.position.x, z - fount.g.position.z) < fount.R + 0.35) return true;   // the fountain
    if(skate && SP.walkBlocked(x - skate.cx, z - skate.cz)) return true;      // its ramps (on foot or wheels; boards ride them)
    var all = hqs.concat(views);
    for(var i = 0; i < all.length; i++){
      var L = all[i], rx = x - L.x, rz = z - L.z;
      if(Math.abs(rx) > 30 || Math.abs(rz) > 30) continue;
      var c0 = Math.cos(-L.rot), s0 = Math.sin(-L.rot), lx = rx*c0 + rz*s0, lz = -rx*s0 + rz*c0;   // into its own frame
      if(L.B && L.B.blockedLocal(lx, lz)) return true;
      // its garage, and its car (where it stands: you may have parked it in the street) unless you drive it
      // (moved into the legacy garage's frame when it stands elsewhere on a v2 lot; none when it has no garage)
      var GP = L.garage, G0 = HQV.hqLotExtras.garage;
      if(L.kind === "hq" && GP){
        var gl = function(x, z){ return {x: G0.x + GP.s*(x - GP.x), z: G0.z + (z - GP.z)}; }, q = gl(lx, lz), k = L.car && gl(L.car.g.position.x, L.car.g.position.z);
        if(HQV.hqLotExtraBlocked(q.x, q.z, !L.car || L.car.g.visible, k && {x: k.x, z: k.z, yaw: L.car.g.rotation.y*GP.s})) return true;
      }
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
    var dy = decks.length ? HQV.hqCivic.deckAt(decks, x, z) : null;        // a pier's deck, over the water
    var ay = air ? air.groundAt(x, z) : null; if(ay != null) return ay;    // air: the helipads, the base's apron
    return dy != null ? dy : WD.groundAt(W, x, z);
  }

  /* ---------- Cities: a v2 world's civic buildings, residents, traffic, sea, boats and travel ---------- */
  var MENU_CSS = "position:absolute;left:50%;top:18%;transform:translateX(-50%);z-index:6;min-width:260px;max-width:min(440px,92%);" +
    "display:grid;gap:6px;padding:12px 14px;border-radius:12px;color:var(--ink);background:color-mix(in srgb,var(--panel) 94%,transparent);" +
    "border:1px solid var(--line);box-shadow:var(--shadow-lg);font-size:13px";
  var ITEM_CSS = "text-align:left;padding:7px 10px;border-radius:8px;border:1px solid var(--line);background:var(--panel2,var(--panel));color:var(--ink);cursor:pointer;font:inherit";
  var CIVIC_NEAR = 180;      // m (camera height counts): a civic building nearer than this is drawn in full, the
                             // rest as their masses' boxes, every one in one InstancedMesh (hqcivic's lod)
  var PROP_FAR = 200;        // m: a bike, board or boat further than this from the camera is not drawn
  var CLEAR_UNDER = 2.4;     // m: a civic mass whose underside is higher than this off its site's ground does not block
  var BOAT_SIDE = 3;         // m: the two boats moored either side of a berth (a dock with no pier drawn)
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
    decks = []; civics.forEach(function(B){ (B.decks || []).forEach(function(d){ decks.push(d); }); });
    buildLod();
  }
  // every civic building's masses as tinted boxes in one InstancedMesh; a building drawn in full hides its own
  function buildLod(){
    if(civicLod){ civicG.remove(civicLod); civicLod.geometry.dispose(); civicLod.material.dispose(); civicLod = null; }
    var n = 0;
    civics.forEach(function(B){ B.lod0 = n; n += (B.lod || []).length; B.far = null; });
    if(!n) return;
    var geo = new THREE.BoxGeometry(1, 1, 1); geo.translate(0, 0.5, 0);
    civicLod = new THREE.InstancedMesh(geo, mat(0xc4cad1, {roughness: 0.85}), n);
    civicLod.name = "civic:lod"; civicLod.receiveShadow = true; civicLod.frustumCulled = false;
    var col = new THREE.Color();
    civics.forEach(function(B){ (B.lod || []).forEach(function(b, i){ civicLod.setColorAt(B.lod0 + i, col.setHex(B.tint != null ? B.tint : 0xffffff)); }); });
    civicG.add(civicLod);
  }
  var lodM = new THREE.Matrix4(), lodQ = new THREE.Quaternion(), lodP = new THREE.Vector3(), lodS = new THREE.Vector3(), lodUp = new THREE.Vector3(0, 1, 0);
  function lodShow(B, on){
    B.far = on;
    if(!civicLod) return;
    (B.lod || []).forEach(function(b, i){
      lodQ.setFromAxisAngle(lodUp, b.rot); lodP.set(b.x, b.y0, b.z);
      if(on) lodS.set(b.w, Math.max(0.01, b.y1 - b.y0), b.d); else lodS.set(0, 0, 0);
      civicLod.setMatrixAt(B.lod0 + i, lodM.compose(lodP, lodQ, lodS));
    });
    civicLod.instanceMatrix.needsUpdate = true;
  }
  function civicBlocked(x, z){
    for(var i = 0; i < civics.length; i++){
      var bx = civics[i].boxes || [];
      for(var j = 0; j < bx.length; j++){
        var b = bx[j]; if(!(x >= b.min.x && x <= b.max.x && z >= b.min.z && z <= b.max.z)) continue;
        // a turned mass's AABB reaches past its walls (onto the road): test the mass itself; a roof or canopy
        // standing clear of the ground (a market hall's, a station's) leaves the ground under it open
        var o = b.o; if(!o) return true;
        if(o.y0 > CLEAR_UNDER) continue;
        var dx = x - o.x, dz = z - o.z, cr = Math.cos(o.rot), sr = Math.sin(o.rot);
        if(Math.abs(dx*cr - dz*sr) <= o.hw && Math.abs(dx*sr + dz*cr) <= o.hd) return true;
      }
    }
    return false;
  }
  // the sea (games/ocean.js), the boats at every berth (games/hqboat.js), the other islands
  function setupSea(){
    if(!W.island || !HQV.ocean) return;
    var doc = WD.docOf(W);
    sea = HQV.ocean.seaOf(doc, null, tier); w.sea = sea;     // the bridges open at this tier are decks over the river
    // the piers stand on the water: you walk them, and a boat comes up against them as against the shore
    var coast = sea.land;
    sea.land = function(x, z){ return coast(x, z) || (decks.length > 0 && HQV.hqCivic.deckAt(decks, x, z) != null); };
    var river = HQV.ocean.riverOf(doc), riverY = HQV.ocean.RIVER_Y || 0;     // the river is calm water, RIVER_Y up
    try { oc = HQV.ocean.mount(c, S); oc.g.position.y = sea.y; if(oc.setRiver) oc.setRiver(river); if(wb && wb.sea) wb.sea.visible = false; } catch(e){ oc = null; }
    S.add(boatG);
    if(HQV.hqboat) sea.docks.forEach(function(d, n){
      var site = siteById(d.id); if(site && site.tier != null && (site.tier | 0) > tier) return;
      // moored alongside the pier, a boat each side near its head: in reach of the deck's edge, in sight from it
      var P = site && HQV.hqCivic && HQV.hqCivic.pierOf ? HQV.hqCivic.pierOf(site)[0] : null;
      ["rowboat", "jetski"].forEach(function(kind, j){
        var sg = j ? 1 : -1, x = d.x + Math.cos(d.yaw)*BOAT_SIDE*sg, z = d.z - Math.sin(d.yaw)*BOAT_SIDE*sg;
        if(P){ var lat = (P.w/2 + 1)*sg; x = P.head[0] - P.dir[0]*2.5 + P.dir[1]*lat; z = P.head[1] - P.dir[1]*2.5 - P.dir[0]*lat; }
        var col = [0x2f6f9f, 0xc8323c, 0x2f8f5b, 0xe8b730][(n*2 + j) % 4], B = HQV.hqboat.model(c, kind, col, 0xf2f2f2);
        B.g.position.set(x, sea.y + (river && river.inWater(x, z) ? riverY : 0), z); B.g.rotation.y = d.yaw; boatG.add(B.g);
        boats.push({g: B.g, x: x, z: z, yaw: d.yaw, color: col, accent: 0xf2f2f2, kind: kind, id: "boat:" + d.id + ":" + kind, stay: true,
                    float: {draft: HQV.hqboat.VEHICLES[kind].draft || 0}});
      });
    });
    getArch().then(function(a){ if(!dead && a) HQV.ocean.setArchipelago(archMetres(a), worldId); }, function(){});
  }
  function siteById(id){ for(var i = 0; i < W.sites.length; i++) if(W.sites[i].id === id) return W.sites[i]; return null; }
  // Moored boats and seaplanes ride the swell (HQ 3.2): they used to sit at sea level while the drawn waves rose
  // through their hulls. Only those within PROP_FAR of the camera, a heave and a gentle roll; flat in Calm.
  function floatParked(cam){
    var list = boats.concat(planeProps);
    for(var i = 0; i < list.length; i++){
      var b = list[i]; if(!b.g.visible || !b.float) continue;
      if(Math.abs(b.x - cam.x) > PROP_FAR || Math.abs(b.z - cam.z) > PROP_FAR) continue;
      var y = sea.surface(b.x, b.z) - b.float.draft, sw = sea.swell(b.x + 1.5, b.z) - sea.swell(b.x - 1.5, b.z);
      b.g.position.y = y; b.y = y; b.g.rotation.z = sea.flat ? 0 : Math.max(-0.06, Math.min(0.06, sw*0.25));
    }
  }
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
      if(n >= 1 && n <= 9 && items[n - 1] && !items[n - 1].off){ e.preventDefault(); closeMenu(); items[n - 1].fn(); return; }
      for(var k = 0; k < items.length; k++) if(items[k].key && e.code === items[k].key && !e.metaKey && !e.ctrlKey && !e.altKey){ e.preventDefault(); closeMenu(); items[k].fn(); return; }
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
    var ac = airCarry(); if(ac) return ac;                                                  // AIR: your window seat
    if(mine(NAV.voy) && VOY) return seatPose(NAV.voy);
    if(NAV.cruise && NAV.cruise.city === worldId && NAV.cruise.phase === "aboard") return cruiseSeat();          // big ships
    if(rail && rail.riding()) return rail.carry();        // rail
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
          if(o.mode === "plane" && airOn()) return;                                       // AIR: the real flights (airMenu)
          if(o.self || (o.mode === "rail" && rail && rail.has(to.world))) return;     // rail: the real train instead
          var txt = MODE_NAME[o.mode] + " to " + to.name + " · " + Math.round(o.seconds) + " s" + (o.fee ? " · " + o.fee + " coin" : "");
          if(o.departs) txt += " · sails in " + waitText(o.departs - Date.now());
          if(o.mode === "ferry" && ferryOn()){
            var dep = VOY.nextSailing(worldId, to.world, Date.now());
            if(dep - Date.now() < 8000) dep += VOY.EVERY;
            txt = "⛴ Ferry to " + to.name + " · sails in " + waitText(dep - Date.now()) + " · you ride it across";
            items.push({text: txt, fn: function(){ boardFerry(to); }});
            return;
          }
          items.push({text: txt, fn: function(){ startTrip(o.mode, from, to, site); }});
        });
        airMenu(site, to, items);                                                         // AIR: flights and seaplanes
      });
      bigShipItems(site, items);                                                                        // big ships
      if(rail && site.kind === "transit") items = rail.rows(a).concat(items);      // rail
      // at the dock of a city with an airport, the flights are at the airport: say so, and N routes you there (HQ 3.2)
      var apS = site.kind === "dock" && airOn() ? airportHere() : null;
      if(apS) items = items.slice(0, 8).concat([{text: "\u2708 Flights leave from the airport · press N to go there", key: "KeyN",
                                                fn: function(){ navToSite(apS, "the airport"); }}]);
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


  /* ---------- ferries (games/hqvoyage.js routes, games/hqships.js ships) ----------
     Every route from here to another city has a ferry each way every VOY.EVERY ms, the same on every client: they
     wait at the berth before sailing, steam down the river and out to sea. Board one at the dock (E): you sit on its
     sun deck (w.carry) for the whole crossing; the next city is built while you sail and you move into it mid-sea
     (hq3d's swapCity) with no loading screen, then sail up its river and step off at its dock. Hold Space for full ahead. */
  var VOY = HQV.hqVoyage, SHIPS = HQV.hqShips;
  var ferryT = null, ferryPool = [], ferryRoutes = null, ferryG = null, myFerry = null;
  var FERRY_SHOW = 3200, FERRY_MAX = 8, FERRY_SEP = 42;
  // ships keep to their starboard side of the channel (5 m in a river, 40 m at sea), easing onto the centre line
  // over the last 120 m to a berth, so ferries bound opposite ways pass each other instead of meeting head on
  function keepRight(p, R){
    var k = Math.max(0, Math.min(1, Math.min(p.along, R.len - p.along)/120)), off = (p.leg === "sea" ? 40 : 5)*k;
    return {x: p.x - Math.cos(p.yaw)*off, z: p.z + Math.sin(p.yaw)*off, yaw: p.yaw, speed: p.speed, along: p.along, leg: p.leg, u: p.u};
  }
  function ferryOn(){ return !!(V2 && VOY && SHIPS && HQV.hqboat && sea && W && VOY.berthOf(W)); }
  function hereArch(){ var h = here(); return {x: h.x, z: h.z}; }
  function shipSfx(n){ if(HQV.engine && HQV.engine.sfx) HQV.engine.sfx(n); }
  function setupFerries(){
    if(!ferryOn()) return;
    ferryG = new THREE.Group(); ferryG.name = "ferries"; S.add(ferryG);
    getArch().then(function(a){
      if(dead || !a) return;
      var hp = hereArch(), A = {world: worldId, x: hp.x, z: hp.z, W: W};
      ferryRoutes = travelPlaces(a, worldId, me).slice(0, 6).map(function(to){
        var B = {world: to.world, x: to.x, z: to.z, W: null};
        return {to: to, out: VOY.route(A, B), inb: VOY.route(B, A)};
      });
    }, function(){});
  }
  function ferryModel(name){
    if(!ferryT) ferryT = SHIPS.ferry(c, {name: name || (worldId === COMMONS ? "Commons Star" : "Island Star")});
    return ferryT.clone();
  }
  function waterY(x, z, t){
    if(!sea) return 0;
    // the shared surface (ocean.js: the drawn sea's clock, flat in Calm); a big hull heaves 0.35 of the swell. (It
    // used to scale the river's raised level too, sinking a ferry 0.2 m into the river.)
    if(sea.level) return sea.level(x, z) + sea.swell(x, z, t)*0.35;
    var v = sea.wave ? sea.wave(x, z, t) : 0;
    return sea.y + (isFinite(v) ? v*0.35 : 0);
  }
  // a ship at an archipelago pose, drawn in this city's frame
  function placeShip(F, p, t, dt){
    var hp = hereArch(), x = p.x - hp.x, z = p.z - hp.z;
    F.g.position.set(x, waterY(x, z, t), z);
    F.g.rotation.set(Math.sin(t*0.6 + x*0.01)*0.012, p.yaw, Math.sin(t*0.45 + z*0.01)*0.02);
    F.update(dt, p.speed, night);
    F.g.visible = true;
  }
  function ferryStep(t, dt){
    if(!ferryG) return;
    var now = Date.now(), hp = hereArch(), shown = [], V = NAV.voy, docked = null;
    (ferryRoutes || []).forEach(function(r){
      VOY.sailings(worldId, r.to.world, now, r.out.T*1000, 60000).forEach(function(dep){
        if(V && V.dep === dep && V.from === worldId && V.to === r.to.world) return;          // yours: drawn on its own
        var tt = (now - dep)/1000;
        if(tt < 0){ if(!docked || dep < docked.dep) docked = {dep: dep, p: VOY.poseAt(r.out, 0), docked: true}; return; }
        if(tt <= r.out.T) shown.push(keepRight(VOY.poseAt(r.out, tt), r.out));
      });
      VOY.sailings(r.to.world, worldId, now, r.inb.T*1000, 0).forEach(function(dep){
        var tt = (now - dep)/1000; if(tt < 0 || tt > r.inb.T) return;
        var p = VOY.poseAt(r.inb, tt);
        if(r.inb.len - p.along < 160) return;                                                // tied up: its passengers are ashore
        shown.push(keepRight(p, r.inb));
      });
    });
    if(docked && !(V && V.from === worldId && (now - V.dep) < 0)){ docked.p.docked = true; shown.push(docked.p); }   // the next sailing waits at the berth
    // never two hulls in one place: yours first, then ships under way, then the one at the berth; a ship within
    // SEP m of one already kept is not drawn (two routes leaving one berth together sail as one)
    var kept = mine(V) ? [shipPose(V)] : [];
    shown = shown.filter(function(p){ return Math.hypot(p.x - hp.x, p.z - hp.z) < FERRY_SHOW; })
      .sort(function(a, b){ return (a.docked ? 1 : 0) - (b.docked ? 1 : 0); })
      .filter(function(p){
        if(kept.some(function(q){ return Math.hypot(p.x - q.x, p.z - q.z) < FERRY_SEP; })) return false;
        kept.push(p); return true;
      }).slice(0, FERRY_MAX);
    while(ferryPool.length < shown.length){ var F = ferryModel(); ferryG.add(F.g); ferryPool.push(F); }
    ferryPool.forEach(function(F, i){ if(i < shown.length) placeShip(F, shown[i], t, dt); else F.g.visible = false; });
    if(c.active && c.active(w)){ HQV.hqCity3d.ferry = w.ferry; HQV.hqCity3d.__bridges = bridges; }   // for tools
    voyStep(t, dt);
  }

  // your voyage: NAV.voy = {R, dep (ms), warp (s), from, to, name, seat}; both cities (the one you left until the
  // swap, the one you are bound for after it) draw your ferry and seat you on it
  function voyT(V){ return Math.min(V.R.T, (Date.now() - V.dep)/1000 + V.warp); }
  function mine(V){ return V && (V.from === worldId || V.to === worldId); }
  function voyPose(V){ return VOY.poseAt(V.R, Math.max(0, voyT(V))); }
  function shipPose(V){ return keepRight(voyPose(V), V.R); }
  function seatPose(V){
    var p = shipPose(V), hp = hereArch(), x = p.x - hp.x, z = p.z - hp.z, cy = Math.cos(p.yaw), sy = Math.sin(p.yaw);
    var S0 = myFerry && myFerry.seats[V.seat % myFerry.seats.length], sx = S0 ? S0.position.x : 2.2, sh = S0 ? S0.position.y : SHIPS.SUN_DECK + 0.8, sz = S0 ? S0.position.z : -9.5;
    return {x: x + sx*cy + sz*sy, y: waterY(x, z, Date.now()/1000) + sh - 0.35, z: z - sx*sy + sz*cy, yaw: p.yaw};
  }
  function boardFerry(to){
    if(!ferryOn()){ say("No ferry runs from here."); return; }
    say("Checking the timetable to " + to.name + "…");
    WD.load({id: to.world}).then(function(W2){
      if(dead) return;
      var hp = hereArch(), now = Date.now();
      var R = VOY.route({world: worldId, x: hp.x, z: hp.z, W: W}, {world: to.world, x: to.x, z: to.z, W: W2 && W2.v >= 2 ? W2 : null});
      var dep = VOY.nextSailing(worldId, to.world, now);
      if(dep - now < 8000) dep += VOY.EVERY;                                                // too late for this one: the next
      NAV.voy = {R: R, dep: dep, warp: 0, from: worldId, to: to.world, name: to.name, seat: Math.floor(now/1000) % 6, swapped: false, built: false};
      shipSfx("door");
      say("Aboard the ferry to " + to.name + ". It sails in " + waitText(dep - now) + ". E gets you off before it sails.");
    }, function(){ say("The timetable didn't load: no ferry right now."); });
  }
  function minSep(){
    var L = ferryPool.concat(myFerry ? [myFerry] : []).filter(function(F){ return F.g.visible; }).map(function(F){ return F.g.position; }), m = Infinity;
    for(var i = 0; i < L.length; i++) for(var j = i + 1; j < L.length; j++) m = Math.min(m, Math.hypot(L[i].x - L[j].x, L[i].z - L[j].z));
    return isFinite(m) ? Math.round(m) : null;
  }
  // for tools (headless shots, tests): board the ferry to a world (or the first route), the voyage's state, a skip ahead
  w.ferry = {
    board: function(world){ return getArch().then(function(a){ var L = travelPlaces(a, worldId, me), to = L.filter(function(p){ return p.world === world; })[0] || L[0]; if(to) boardFerry(to); return to ? to.world : null; }); },
    state: function(){ var V = NAV.voy; return V ? {t: voyT(V), T: V.R.T, hand: V.R.hand, len: V.R.len, from: V.from, to: V.to, swapped: V.swapped, here: worldId,
                                                    ships: ferryPool.filter(function(F){ return F.g.visible; }).length, minSep: minSep()} : {here: worldId, ships: ferryPool.filter(function(F){ return F.g.visible; }).length, minSep: minSep()}; },
    skip: function(s){ var V = NAV.voy; if(V){ if(Date.now() < V.dep){ V.warp += (V.dep - Date.now())/1000; } V.warp += +s || 0; } }
  };
  function voyLeave(){ NAV.voy = null; voyHud(null); if(myFerry) myFerry.g.visible = false; }
  function voyStep(t, dt){
    var V = NAV.voy;
    if(!mine(V)){ if(myFerry) myFerry.g.visible = false; if(!V) voyHud(null); return; }
    if(!myFerry){ myFerry = ferryModel(V.to === worldId ? "Island Star" : null); ferryG.add(myFerry.g); }
    var tt = (Date.now() - V.dep)/1000 + V.warp;
    if(tt > 0 && c.held && c.held("Space")) V.warp += dt*7;                                  // full ahead: eight times as fast
    tt = voyT(V);
    var p = shipPose(V);
    placeShip(myFerry, p, t, dt);
    if(tt >= 0 && !V.built && V.from === worldId){ V.built = true; if(c.prebuildCity) c.prebuildCity(V.to); shipSfx("go"); say("All aboard! Sailing for " + V.name + "."); }
    // mid-sea, once the next city is built: move into it (nothing on screen changes but the city ahead)
    if(V.from === worldId && tt >= V.R.hand && !V.swapped && c.cityBuilt && c.cityBuilt(V.to)){ V.swapped = true; if(!(c.swapCity && c.swapCity(V.to))) V.swapped = false; }
    if(V.to === worldId && tt >= V.R.T){
      var dock = VOY.berthOf(W), s = dock && siteById(dock.site), sp = s ? HQV.hqTravel.spawnAt(worldId, s) : null;
      voyLeave();
      if(HQV.hqTravel.markVisited) HQV.hqTravel.markVisited(worldId);
      if(sp && c.teleport) c.teleport(sp.x, sp.z, sp.yaw);
      shipSfx("levelup");
      say("Welcome to " + (cityState && cityState.name ? cityState.name : V.name || "the city") + ".");
      return;
    }
    voyHud(V, tt, p);
  }
  // one panel for the whole voyage (NAV.hud), shared by the city you left and the one you sail into
  function voyHud(V, tt, p){
    if(!c.el || typeof document === "undefined") return;
    var voyEl = NAV.hud;
    if(!V){ if(voyEl){ if(voyEl.parentNode) voyEl.parentNode.removeChild(voyEl); NAV.hud = null; NAV.hudKey = ""; } return; }
    if(voyEl && voyEl.parentNode !== c.el){ c.el.appendChild(voyEl); }
    if(!voyEl){
      voyEl = document.createElement("div"); voyEl.className = "hq3d-voyage"; voyEl.setAttribute("role", "status");
      ["icon", "main", "bar", "hint"].forEach(function(k){ var d = document.createElement("div"); d.className = "hq3d-voyage-" + k; voyEl.appendChild(d); });
      voyEl.children[0].textContent = "⛴";
      var fill = document.createElement("span"); voyEl.children[2].appendChild(fill);
      c.el.appendChild(voyEl);
      NAV.hud = voyEl; NAV.hudKey = "";
    }
    voyEl.hidden = false;
    var left = Math.max(0, V.R.T - tt), where = tt < 0 ? "At the berth" : p.leg === "sea" ? "At sea" : p.u < 0.5 ? "Down the river" : "Up the river to the dock";
    var main = tt < 0 ? "Ferry to " + V.name + " · sails in " + waitText(-tt*1000)
             : "Ferry to " + V.name + " · " + where + " · " + waitText(left*1000/((c.held && c.held("Space")) ? 8 : 1)) + " to go";
    var key = main + "|" + Math.round(Math.max(0, tt)/Math.max(1, V.R.T)*200);
    if(key === NAV.hudKey) return;
    NAV.hudKey = key;
    voyEl.children[1].textContent = main;
    voyEl.children[2].firstChild.style.width = (Math.max(0, Math.min(1, tt/V.R.T))*100).toFixed(1) + "%";
    voyEl.children[3].textContent = tt < 0 ? "E: get off before it sails" : (c.held && c.held("Space")) ? "Full ahead!" : "Hold Space: full ahead · drag to look around";
  }

  /* ---- opening bridges (games/hqbridges.js) ----
     The bridges over the river open for the ferries: worldbuild leaves their decks over the water out (opts.gap) and
     hqbridges draws the approach and the moving spans; the ferries' poses (the pool and yours) drive them, blocked()
     keeps you and your car off a gap, and traffic.js cars brake at a lowered barrier (its obstacles). */
  var bridges = null;
  function bridgesSetup(){
    if(!HQV.hqBridges || !W || !W.river) return;
    try { bridges = HQV.hqBridges.create(c, W, S, {tier: tier}); w.bridges = bridges; } catch(e){ bridges = null; }
  }
  function bridgesStep(dt){
    if(!bridges) return;
    var ships = [];
    // ferries, and seaplanes taxiing on the river (on the water: low, not flying over)
    var hulls = ferryPool.concat(myFerry ? [myFerry] : []);
    if(typeof airPool !== "undefined" && airPool) airPool.sea.concat(myPlane ? [myPlane] : []).forEach(function(P){
      if(P && P.g && P.g.visible && sea && P.g.position.y < sea.y + 4) hulls.push(P);
    });
    hulls.forEach(function(F){
      var p = F.g.position, v = 0;
      if(!F.g.visible){ F.brPos = null; return; }
      if(F.brPos && dt > 0) v = Math.hypot(p.x - F.brPos.x, p.z - F.brPos.z)/dt;
      F.brPos = {x: p.x, z: p.z};
      ships.push({x: p.x, z: p.z, yaw: F.g.rotation.y, speed: v < 200 ? v : 0});
    });
    bridges.update(dt, ships);
  }
  function bridgesDestroy(){ if(bridges){ try { bridges.dispose(); } catch(e){} bridges = null; w.bridges = null; } }
  /* ---- end opening bridges ---- */
  /* ========== AIR: the airline network (games/hqair.js flights, games/hqaircraft.js models) ==========
     Scheduled flights from here to the other cities, the same on every client (AIR.flights): airliners between
     airports (the Commons always, an island at tier 5), seaplanes dock to dock wherever an end has no airport.
     E at the airport (or, in a town without one, at the dock) books one (airMenu, from openTravelMenu): you sit in a
     window seat (w.carry -> airCarry) and the camera is a chase camera outside the plane (w.camPose -> airCam; drag
     to look round). The next city is built while you fly and you move into it at the flight's handover (furthest
     from both cities), then land and step out at its airport (its dock). Hold Space to fast-forward. Scenic traffic
     crosses high over the archipelago with contrails. The airport gets its runway, lights and stand (airDress).
     Hooks outside this block: setupAir() with setupFerries(), airStep() in w.update, airDestroy() in citiesDestroy,
     airCarry() in w.carry, airUse() in w.use, two lines in openTravelMenu. */
  var AIR = HQV.hqAir, CRAFT = HQV.hqAircraft;
  var airG = null, airDress = null, airJetT = null, airSeaT = null, airPool = {jet: [], sea: []}, airRoutes = null, airPlaces = null;
  var myPlane = null, airAmbPool = [], airTrailPool = [], airTrails = null, airNight = null, airPtrOn = false;
  var airLook = {yaw: 0, pitch: 0.16, drag: null, camYaw: null, auto: 0};
  var AIR_SHOW = 6500, AIR_MAX = 4, AIR_AMB = 5;
  function airOn(){ return !!(V2 && AIR && CRAFT && HQV.hqShips && W && HQV.hqTravel); }
  function airportIn(W2, t2){ return W2 ? civicSites(W2, t2, ["airport"])[0] || null : null; }
  function airportHere(){ return airportIn(W, tier); }
  function airRunwayY(W2, s){ return Math.max(0, WD.groundAt(W2, s.x/100, s.z/100)) + 0.3; }
  // a jet when both ends have an airport (the Commons, an island at tier 5), else a seaplane (dock to dock)
  function airKind(to){ return airportHere() && (to.world === COMMONS || (to.tier | 0) >= 5) ? "jet" : "sea"; }
  function airEndHere(kind, toward){
    var hp = hereArch(), ap = airportHere();
    if(kind === "jet") return ap ? AIR.airportEnd(ap, hp.x, hp.z, airRunwayY(W, ap)) : null;
    return VOY && VOY.berthOf(W) ? AIR.dockEnd(W, hp.x, hp.z, toward) : null;
  }
  function airModel(kind){
    if(kind === "jet"){ if(!airJetT) airJetT = CRAFT.airliner(c, {}); return airJetT.clone(); }
    if(!airSeaT) airSeaT = CRAFT.seaplane(c, {}); return airSeaT.clone();
  }
  function setupAir(){
    if(!airOn()) return;
    airG = new THREE.Group(); airG.name = "air"; S.add(airG);
    var ap = airportHere();
    if(ap){
      try {
        airDress = CRAFT.airport(c, AIR.airportEnd(ap, 0, 0, airRunwayY(W, ap)), {ground: function(x, z){ return WD.heightAt(W, x, z); }, site: ap, tier: tier});
        airG.add(airDress.g);
      } catch(e){ airDress = null; }
    }
    airTrails = CRAFT.contrails(c);
    if(c.el && !airPtrOn){ airPtrOn = true; ["pointerdown", "pointermove", "pointerup", "pointercancel"].forEach(function(k){ c.el.addEventListener(k, airPtr, true); }); }
    getArch().then(function(a){
      if(dead || !a) return;
      var hp = hereArch(), places = travelPlaces(a, worldId, me), A = {world: worldId, x: hp.x, z: hp.z};
      airPlaces = places.concat([A]);
      airRoutes = places.slice(0, 6).map(function(to){
        var kind = airKind(to), eh = airEndHere(kind, [to.x, to.z]); if(!eh) return null;
        var et = kind === "jet" ? AIR.nominalAirport(to.x, to.z, [hp.x, hp.z]) : AIR.dockEnd(null, to.x, to.z, [hp.x, hp.z]), B = {world: to.world, x: to.x, z: to.z};
        return {to: to, kind: kind, out: AIR.route(kind, A, B, {a: eh, b: et}), inb: AIR.route(kind, B, A, {a: et, b: eh})};
      }).filter(Boolean);
    }, function(){});
  }
  function airPtr(e){
    if(!airMine(NAV.flight)){ airLook.drag = null; return; }
    if(e.type === "pointerdown"){ airLook.drag = {x: e.clientX, y: e.clientY}; return; }
    if(e.type !== "pointermove"){ airLook.drag = null; return; }
    if(!airLook.drag) return;
    var dx = e.movementX != null ? e.movementX : e.clientX - airLook.drag.x, dy = e.movementY != null ? e.movementY : e.clientY - airLook.drag.y;
    airLook.drag = {x: e.clientX, y: e.clientY};
    airLook.yaw -= dx*0.006; airLook.pitch = Math.max(-0.25, Math.min(1.3, airLook.pitch + dy*0.004));
  }
  // a plane at an archipelago pose, drawn in this city's frame (a seaplane rides the waves when it is down)
  function placePlane(P, p, kind, t, dt){
    var hp = hereArch(), x = p.x - hp.x, z = p.z - hp.z, y = p.y;
    if(kind === "sea" && !p.air) y = Math.max(y, waterY(x, z, t) - 0.15);
    P.place(p, x, y, z);
    P.update(dt, t, night, p.gear, p.speed);
  }
  function airStep(t, dt){
    if(!airG) return;
    var now = Date.now(), hp = hereArch(), F = NAV.flight, shown = {jet: [], sea: []}, wait = {jet: null, sea: null};
    if(airDress){ if(airNight !== night){ airNight = night; airDress.setNight(night); if(airTrails) airTrails.setNight(night); } airDress.update(t); }
    (airRoutes || []).forEach(function(r){
      [[r.out, worldId, r.to.world], [r.inb, r.to.world, worldId]].forEach(function(x){
        var R = x[0];
        AIR.flights(x[1], x[2], now, R.T*1000, x[1] === worldId ? 100000 : 0).forEach(function(dep){
          if(F && F.dep === dep && F.from === x[1] && F.to === x[2]) return;                 // yours: drawn on its own
          var tt = (now - dep)/1000;
          if(tt < 0){ var wk = wait[r.kind]; if(!wk || dep < wk.dep) wait[r.kind] = {dep: dep, p: AIR.poseAt(R, 0)}; return; }
          if(tt > R.T) return;
          var p = AIR.poseAt(R, tt);
          if(p.phase === "parked") return;
          if(Math.hypot(p.x - hp.x, p.z - hp.z) < AIR_SHOW) shown[r.kind].push(p);
        });
      });
    });
    ["jet", "sea"].forEach(function(k){
      var L = shown[k];
      if(wait[k] && !(F && airMine(F) && F.from === worldId && F.kind === k && Date.now() < F.dep)) L.unshift(wait[k].p);   // the next one waits at the stand
      L = L.slice(0, AIR_MAX);
      var pool = airPool[k];
      while(pool.length < L.length){ var P = airModel(k); airG.add(P.g); pool.push(P); }
      pool.forEach(function(P, i){ if(i < L.length) placePlane(P, L[i], k, t, dt); else P.g.visible = false; });
    });
    // scenic traffic, high over the archipelago, contrails behind
    var amb = airPlaces ? AIR.ambient(airPlaces, now, hp.x, hp.z, AIR_SHOW).slice(0, AIR_AMB) : [];
    while(airAmbPool.length < amb.length){ var Q = airModel("jet"); airG.add(Q.g); airAmbPool.push(Q); var tr = airTrails.add(); airG.add(tr); airTrailPool.push(tr); }
    airAmbPool.forEach(function(P, i){
      var a = amb[i];
      if(!a){ P.g.visible = false; airTrailPool[i].visible = false; return; }
      placePlane(P, {x: a.x, y: a.y, z: a.z, yaw: a.yaw, pitch: 0.03, roll: 0, gear: 0, speed: a.speed}, "jet", t, dt);
      airTrails.set(airTrailPool[i], [a.trail[0][0] - hp.x, a.trail[0][1], a.trail[0][2] - hp.z], [a.trail[1][0] - hp.x, a.trail[1][1], a.trail[1][2] - hp.z]);
    });
    if(c.active && c.active(w)) HQV.hqCity3d.air = w.air;
    flightStep(t, dt);
  }
  // your flight: NAV.flight = {R, dep (ms), warp (s), from, to, name, kind}; both cities draw your plane and seat you
  function airMine(F){ return F && (F.from === worldId || F.to === worldId); }
  function flightT(F){ return Math.min(F.R.T, (Date.now() - F.dep)/1000 + F.warp); }
  function flightPose(F){ return AIR.poseAt(F.R, Math.max(0, flightT(F))); }
  function airCarry(){
    var F = NAV.flight; if(!airMine(F) || !AIR) return null;
    var p = flightPose(F), hp = hereArch(), x = p.x - hp.x, z = p.z - hp.z, cy = Math.cos(p.yaw), sy = Math.sin(p.yaw);
    var s = myPlane ? myPlane.seat : [-1.4, 3.5, 2], sx = s[0], sz = s[2];
    return {x: x + sx*cy + sz*sy, y: p.y + s[1], z: z - sx*sy + sz*cy, yaw: p.yaw};
  }
  // the chase camera outside your plane: behind it, its heading eased, turned and raised by a drag
  var tripCamPose = w.camPose;
  w.camPose = function(){ return airCam() || tripCamPose(); };
  function airCam(){
    var F = NAV.flight; if(!airMine(F) || !myPlane || !myPlane.g.visible) return null;
    var P = myPlane.g.position, D = F.kind === "jet" ? 64 : 30, yaw = (airLook.camYaw || 0) + airLook.yaw + airLook.auto, pit = airLook.pitch;
    var cx = P.x - Math.sin(yaw)*Math.cos(pit)*D, cz = P.z - Math.cos(yaw)*Math.cos(pit)*D, cy = P.y + 3 + Math.sin(pit)*D;
    var gy = (W && Math.abs(cx) < W.half && Math.abs(cz) < W.half ? Math.max(WD.groundAt(W, cx, cz), sea ? sea.y : 0) : 0) + 2.5;
    return {frame: "here", camera: true, pos: {x: cx, y: Math.max(cy, gy), z: cz}, look: {x: P.x, y: P.y + 3, z: P.z}, up: {x: 0, y: 1, z: 0}, fov: 55};
  }
  function airBoard(to){
    if(!airOn()){ say("No flights from here."); return; }
    say("Checking the departures for " + to.name + "…");
    WD.load({id: to.world}).then(function(W2){
      if(dead) return;
      W2 = W2 && W2.v >= 2 && W2.id === to.world ? W2 : null;
      var hp = hereArch(), now = Date.now(), t2 = to.world === COMMONS ? 5 : Math.max(1, to.tier | 0), apT = airportIn(W2, t2);
      var kind = airportHere() && (W2 ? !!apT : airKind(to) === "jet") ? "jet" : "sea", eh = airEndHere(kind, [to.x, to.z]);
      if(!eh){ say("No flight to " + to.name + " leaves from here."); return; }
      var et = kind === "jet" ? (apT ? AIR.airportEnd(apT, to.x, to.z, airRunwayY(W2, apT)) : AIR.nominalAirport(to.x, to.z, [hp.x, hp.z])) : AIR.dockEnd(W2, to.x, to.z, [hp.x, hp.z]);
      var R = AIR.route(kind, {world: worldId, x: hp.x, z: hp.z}, {world: to.world, x: to.x, z: to.z}, {a: eh, b: et});
      var dep = AIR.nextFlight(worldId, to.world, now);
      if(dep - now < 8000) dep += AIR.EVERY;
      if(myPlane){ myPlane.dispose(); myPlane = null; }
      NAV.flight = {R: R, dep: dep, warp: 0, from: worldId, to: to.world, name: to.name, kind: kind, swapped: false, built: false};
      airLook.camYaw = null; airLook.yaw = 0; airLook.pitch = 0.16;
      shipSfx("door");
      say((kind === "jet" ? "Boarding the flight to " : "Boarding the seaplane to ") + to.name + ": a window seat. It leaves in " + waitText(dep - now) + ". E gets you off before it does.");
    }, function(){ say("The departures board didn't load: no flight right now."); });
  }
  // for tools (headless shots, tests): book a flight to a world (or the first place), its state, a skip ahead, the look
  w.air = {
    board: function(world){ return getArch().then(function(a){ var L = travelPlaces(a, worldId, me), to = L.filter(function(p){ return p.world === world; })[0] || L[0]; if(to) airBoard(to); return to ? to.world : null; }); },
    state: function(){
      var F = NAV.flight, p = F ? flightPose(F) : null, vis = function(L){ return L.filter(function(P){ return P.g.visible; }).length; };
      return F ? {t: flightT(F), T: F.R.T, hand: F.R.hand, kind: F.kind, from: F.from, to: F.to, swapped: F.swapped, here: worldId, phase: p.phase, y: p.y, speed: p.speed,
                  planes: vis(airPool.jet.concat(airPool.sea)), ambient: vis(airAmbPool)}
               : {here: worldId, planes: vis(airPool.jet.concat(airPool.sea)), ambient: vis(airAmbPool)};
    },
    skip: function(s){ var F = NAV.flight; if(F){ if(Date.now() < F.dep){ F.warp += (F.dep - Date.now())/1000; } F.warp += +s || 0; } },
    look: function(yaw, pitch){ airLook.yaw = +yaw || 0; if(pitch != null) airLook.pitch = +pitch; },
    // ride a route given whole (an AIR.route; e.g. into this city from another), t s into it
    ride: function(R, name, t){ if(myPlane){ myPlane.dispose(); myPlane = null; } airLook.camYaw = null;
      NAV.flight = {R: R, dep: Date.now() - (+t || 0)*1000, warp: 0, from: R.from, to: R.to, name: name || "here", kind: R.kind, swapped: true, built: true}; },
    stand: function(){ var ap = airportHere(); return ap ? {door: doorOf(ap), end: AIR.airportEnd(ap, 0, 0, airRunwayY(W, ap))} : null; }
  };
  function airLeave(){ NAV.flight = null; airHud(null); if(myPlane) myPlane.g.visible = false; }
  function flightStep(t, dt){
    var F = NAV.flight;
    if(!airMine(F)){ if(myPlane) myPlane.g.visible = false; if(!F) airHud(null); return; }
    if(!myPlane){ myPlane = airModel(F.kind); airG.add(myPlane.g); }
    var tt = (Date.now() - F.dep)/1000 + F.warp;
    if(tt > 0 && c.held && c.held("Space")) F.warp += dt*7;                                   // eight times as fast
    tt = flightT(F);
    var p = flightPose(F);
    placePlane(myPlane, p, F.kind, t, dt);
    airLook.camYaw = airLook.camYaw == null ? p.yaw : airLook.camYaw + Math.atan2(Math.sin(p.yaw - airLook.camYaw), Math.cos(p.yaw - airLook.camYaw))*(1 - Math.exp(-dt*1.6));
    // at the stand the terminal is behind the tail: watch from off the nose until the roll starts, then swing round
    var autoGoal = F.from === worldId && tt < F.R.tRoll ? 2.5 : 0;
    airLook.auto += (autoGoal - airLook.auto)*(1 - Math.exp(-dt*(autoGoal ? 6 : 0.8)));
    if(tt >= 0 && !F.built && F.from === worldId){ F.built = true; if(c.prebuildCity) c.prebuildCity(F.to); shipSfx("go"); say((F.kind === "jet" ? "Cabin crew, seats for take-off. " : "Off we go. ") + "Next stop " + F.name + "."); }
    if(F.from === worldId && tt >= F.R.hand && !F.swapped && c.cityBuilt && c.cityBuilt(F.to)){ F.swapped = true; if(!(c.swapCity && c.swapCity(F.to))) F.swapped = false; }
    if(F.to === worldId && tt >= F.R.T){
      var s = F.kind === "jet" ? airportHere() : null, b = !s && VOY ? VOY.berthOf(W) : null;
      if(!s && b) s = siteById(b.site);
      var sp = s ? HQV.hqTravel.spawnAt(worldId, s) : null;
      airLeave();
      if(HQV.hqTravel.markVisited) HQV.hqTravel.markVisited(worldId);
      if(sp && c.teleport) c.teleport(sp.x, sp.z, sp.yaw);
      shipSfx("levelup");
      say("Welcome to " + (cityState && cityState.name ? cityState.name : F.name || "the city") + ".");
      return;
    }
    airHud(F, tt, p);
  }
  // E while booked: off the plane before it leaves (back to the terminal's door), else a word from the crew
  function airUse(){
    var F = NAV.flight; if(!airMine(F)) return false;
    if(flightT(F) < 0 && F.from === worldId){
      var s = F.kind === "jet" ? airportHere() : null, b = !s && VOY ? VOY.berthOf(W) : null; if(!s && b) s = siteById(b.site);
      var sp = s && HQV.hqTravel.spawnAt(worldId, s); airLeave(); if(sp && c.teleport) c.teleport(sp.x, sp.z, sp.yaw); say("You stayed on the ground.");
    } else say("You're flying. Sit back, or hold Space to hurry along.");
    return true;
  }
  // the travel menu's flights to one place: at the airport (jets, or seaplanes from the dock where `to` has no
  // airport), or at the dock of a town with no airport (seaplanes)
  function airMenu(site, to, items){
    if(!airOn()) return;
    var apH = airportHere(), kind = airKind(to);
    if(site.kind === "airport" ? !apH : !(site.kind === "dock" && !apH)) return;
    if(kind === "sea" && !(VOY && VOY.berthOf(W))) return;
    var now = Date.now(), dep = AIR.nextFlight(worldId, to.world, now); if(dep - now < 8000) dep += AIR.EVERY;
    items.push({text: (kind === "jet" ? "✈ Flight to " : "🛩 Seaplane to ") + to.name + " · boarding, departs in " + waitText(dep - now) + (kind === "sea" && site.kind === "airport" ? " · from the dock" : ""),
                fn: function(){ airBoard(to); }});
  }
  var PHASE_TXT = {taxi: "taxiing", takeoff: "taking off", climb: "climbing", cruise: "cruising", descent: "descending", approach: "on approach",
                   flare: "landing", rollout: "landing", parked: "at the gate"};
  function airHud(F, tt, p){
    if(!c.el || typeof document === "undefined") return;
    var el = NAV.airHud;
    if(!F){ if(el){ if(el.parentNode) el.parentNode.removeChild(el); NAV.airHud = null; NAV.airKey = ""; } return; }
    if(el && el.parentNode !== c.el) c.el.appendChild(el);
    if(!el){
      el = document.createElement("div"); el.className = "hq3d-voyage hq3d-flight"; el.setAttribute("role", "status");
      ["icon", "main", "bar", "hint"].forEach(function(k){ var d = document.createElement("div"); d.className = "hq3d-voyage-" + k; el.appendChild(d); });
      el.children[2].appendChild(document.createElement("span"));
      c.el.appendChild(el); NAV.airHud = el; NAV.airKey = "";
    }
    el.children[0].textContent = F.kind === "jet" ? "✈" : "🛩";
    var fast = c.held && c.held("Space"), who = (F.kind === "jet" ? "Flight to " : "Seaplane to ") + F.name, left = Math.max(0, F.R.T - tt);
    var main = tt < 0 ? who + " · boarding, departs in " + waitText(-tt*1000)
             : who + " · " + (p.phase === "taxi" && p.along < F.R.sLift ? "taxiing out" : PHASE_TXT[p.phase] || p.phase) + " · " + waitText(left*1000/(fast ? 8 : 1));
    var key = main + "|" + Math.round(Math.max(0, tt)/Math.max(1, F.R.T)*200);
    if(key === NAV.airKey) return;
    NAV.airKey = key;
    el.children[1].textContent = main;
    el.children[2].firstChild.style.width = (Math.max(0, Math.min(1, tt/F.R.T))*100).toFixed(1) + "%";
    el.children[3].textContent = tt < 0 ? "E: get off before it leaves · drag to look around" : fast ? "Fast-forward" : "Hold Space: fast-forward · drag to look around";
  }
  function airDestroy(){
    if(airPtrOn && c.el){ ["pointerdown", "pointermove", "pointerup", "pointercancel"].forEach(function(k){ c.el.removeEventListener(k, airPtr, true); }); airPtrOn = false; }
    airPool.jet.concat(airPool.sea, airAmbPool).forEach(function(P){ P.dispose(); }); airPool = {jet: [], sea: []}; airAmbPool = [];
    airTrailPool.forEach(function(o){ if(o.parent) o.parent.remove(o); }); airTrailPool = [];
    if(myPlane){ myPlane.dispose(); myPlane = null; }
    if(airJetT){ airJetT.dispose(); airJetT = null; } if(airSeaT){ airSeaT.dispose(); airSeaT = null; }
    if(airTrails){ airTrails.dispose(); airTrails = null; } if(airDress){ airDress.dispose(); airDress = null; }
    if(airG){ S.remove(airG); airG = null; }
  }
  /* ========== end AIR ========== */
  /* ---------- big ships: the cruise ship and the cargo ships (games/hqvoyage.js fleet, games/hqships.js models) ----------
     Sea-only loops round the whole archipelago, the same on every client (VOY.fleet from the archipelago alone, timed
     by Date.now()). This City draws the ones within BIG_SHOW of it, one pooled clone per ship. At a port (tier 3+), E
     lists the cruise ship when it calls here within CRUISE_SOON and the cargo ships' next calls (board one, or wait for it).
     Aboard (NAV.cruise, w.carry) you sit on a pool-deck lounger (a cargo ship: its bridge wing); hold Space for full ahead; the next stop's City is
     built on the way and you move into it mid-sea (prebuildCity / swapCity, as the ferry); E at anchor goes ashore.
     Separation: a ferry under a cruise ship's hull is hidden, a cargo ship eases aside (or hides) off any other ship. */
  var BIG_SHOW = 4000, CRUISE_SOON = 6*60*1000, CARGO_AHEAD = 30*60*1000, BIG_GAP = 12;
  var bigFleet = null, bigCityL = null, bigG = null, bigTpl = {}, bigShips = {}, myCruise = null, bigPins = {};
  function bigOn(){ return !!(V2 && VOY && VOY.fleet && SHIPS && SHIPS.cruise && HQV.hqboat && sea); }
  function setupBigShips(){
    if(!bigOn()) return;
    bigG = new THREE.Group(); bigG.name = "bigships"; S.add(bigG);
    getArch().then(function(a){ if(!dead && a){ bigFleet = VOY.fleet(archMetres(a)); bigCityL = VOY.bigCities(archMetres(a)); } }, function(){});
  }
  function bigModel(sh){
    var key = sh.kind + ":" + sh.name;
    if(!bigTpl[key]) bigTpl[key] = sh.kind === "cruise" ? SHIPS.cruise(c, {name: sh.name, funnel: sh.k ? 0xc0392b : null})
                                                        : SHIPS.cargo(c, {name: sh.name, seed: 7 + sh.k*13, funnel: [0xc0392b, 0x1f5fa8, 0x239b56, 0xd4ac0d, 0x7d3c98, 0xe67e22][sh.k % 6]});
    var F = bigTpl[key].clone(); bigG.add(F.g); return F;
  }
  function bigHalf(kind){ return kind === "cruise" ? SHIPS.CRUISE.LENGTH/2 : kind === "cargo" ? SHIPS.CARGO.LENGTH/2 : SHIPS.LENGTH/2; }
  // a big ship at an archipelago pose: its heading eased (no snapping round at an anchorage), side-stepped by off m
  function placeBig(F, p, off, t, dt){
    var hp = hereArch(), yaw = F.yaw == null ? p.yaw : F.yaw + wrapA(p.yaw - F.yaw)*(1 - Math.exp(-dt*0.7));
    F.yaw = yaw;
    var x = p.x - hp.x - Math.cos(yaw)*off, z = p.z - hp.z + Math.sin(yaw)*off;
    F.g.position.set(x, waterY(x, z, t)*0.4, z);
    F.g.rotation.set(Math.sin(t*0.3 + x*0.01)*0.004, yaw, Math.sin(t*0.25 + z*0.01)*0.008);
    F.update(dt, p.speed, night);
    F.g.visible = true;
  }
  function wrapA(a){ while(a > Math.PI) a -= 2*Math.PI; while(a < -Math.PI) a += 2*Math.PI; return a; }
  function bigStep(t, dt){
    if(!bigG || !bigFleet) return;
    var now = Date.now(), hp = hereArch(), C = NAV.cruise, mineC = C && C.city === worldId && C.phase === "aboard" ? C : null;
    var solid = [];                                                         // placed hulls: {x, z, r}
    if(myFerry && myFerry.g.visible) solid.push({x: myFerry.g.position.x, z: myFerry.g.position.z, r: bigHalf("ferry")});
    // the cruise ships first (yours at your own pace), then the cargo ships round them
    bigFleet.cruise.concat(bigFleet.cargo).forEach(function(sh){
      var id = sh.kind + sh.k, F = bigShips[id], p = bigPins[id] ? bigPin(bigPins[id]) : VOY.shipAt(sh, now, 0);
      var near = Math.hypot(p.x - hp.x, p.z - hp.z) < BIG_SHOW && !(mineC && sh.kind === mineC.kind && sh.k === mineC.k);
      if(!near){ if(F) F.g.visible = false; return; }
      if(!F) F = bigShips[id] = bigModel(sh);
      var r = bigHalf(sh.kind), lx = p.x - hp.x, lz = p.z - hp.z;
      if(sh.kind === "cargo"){
        // step aside from what is already there (eased), and stay hidden while still on top of it
        var want = 0, cy = Math.cos(p.yaw), sy = Math.sin(p.yaw);
        solid.forEach(function(o){
          var dx = o.x - lx, dz = o.z - lz, d = Math.hypot(dx, dz), need = o.r + r + BIG_GAP - d;
          if(need > 0){ var side = -(dx*cy - dz*sy) >= 0 ? 1 : -1; want += side*need; }
        });
        F.off = (F.off || 0) + (Math.max(-200, Math.min(200, want)) - (F.off || 0))*(1 - Math.exp(-dt*0.4));
        placeBig(F, p, F.off, t, dt);
        var gx = F.g.position.x, gz = F.g.position.z;
        if(solid.some(function(o){ return Math.hypot(o.x - gx, o.z - gz) < o.r + r; })) F.g.visible = false;
        else solid.push({x: gx, z: gz, r: r});
      } else { placeBig(F, p, 0, t, dt); solid.push({x: lx, z: lz, r: r}); }
    });
    cruiseStep(t, dt, solid);
    // ferries under a cruise ship's hull: hidden (not yours)
    ferryPool.forEach(function(F){
      if(!F.g.visible) return;
      if(solid.some(function(o){ return o.r > SHIPS.LENGTH && Math.hypot(o.x - F.g.position.x, o.z - F.g.position.z) < o.r + bigHalf("ferry"); })) F.g.visible = false;
    });
    if(c.active && c.active(w)) HQV.hqCity3d.ships = w.ships;
  }
  // the port menu's lines: the cruise ship calling here soon, and the cargo ships' next calls
  function bigShipItems(site, items){
    if(!bigFleet || !site || site.kind !== "port") return;
    var now = Date.now(), add = [];
    bigFleet.cruise.forEach(function(sh){
      var call = VOY.calls(sh, worldId, now, CRUISE_SOON)[0];
      if(!call) return;
      if(call.here) add.push({text: "🛳 Board the cruise ship " + sh.name + " · at anchor, sails in " + waitText(call.leave - now), fn: function(){ cruiseBoard(sh, site); }});
      else add.push({text: "🛳 Cruise ship " + sh.name + " calls in " + waitText(call.arrive - now) + " · wait here to board", fn: function(){ cruiseWait(sh, site, call); }});
    });
    var cargo = [];
    bigFleet.cargo.forEach(function(sh){ var call = VOY.calls(sh, worldId, now, CARGO_AHEAD)[0]; if(call) cargo.push({sh: sh, call: call}); });
    cargo.sort(function(a, b){ return a.call.arrive - b.call.arrive; }).slice(0, 2).forEach(function(o){
      if(o.call.here) add.push({text: "📦 Ride the cargo ship " + o.sh.name + " · unloading " + o.sh.boxes + " containers · leaves in " + waitText(o.call.leave - now),
                                fn: function(){ cruiseBoard(o.sh, site); }});
      else add.push({text: "📦 Cargo ship " + o.sh.name + " calls in " + waitText(o.call.arrive - now) + " · wait here to ride", fn: function(){ cruiseWait(o.sh, site, o.call); }});
    });
    if(!add.length) add.push({text: "🛳 No cruise ship calls here in the next " + Math.round(CRUISE_SOON/60000) + " min", fn: function(){ say(bigFleet.cruise.length ? cruiseWhen() : "No cruise ship sails these waters."); }});
    Array.prototype.unshift.apply(items, add);
  }
  function cruiseWhen(){
    var now = Date.now(), best = null;
    bigFleet.cruise.forEach(function(sh){ var call = VOY.calls(sh, worldId, now, sh.R.T*1000)[0]; if(call && (!best || call.arrive < best.call.arrive)) best = {sh: sh, call: call}; });
    return best ? "The " + best.sh.name + " next calls here in " + waitText(best.call.arrive - Date.now()) + "." : "The cruise ship doesn't call here.";
  }
  // NAV.cruise = {phase: "wait" | "aboard", kind ("cruise" | "cargo"), k, name, city (the City drawing you), warp (s), seat,
  // pre (the City being built)}
  function cruiseWait(sh, site, call){
    var d = doorOf(site);
    NAV.cruise = {phase: "wait", kind: sh.kind, k: sh.k, name: sh.name, city: worldId, arrive: call.arrive, at: {x: d.x, z: d.z}, site: site.id};
    say("The " + sh.name + " calls in " + waitText(call.arrive - Date.now()) + ". Stay at the port; E stops waiting.");
  }
  function cruiseBoard(sh, site){
    NAV.cruise = {phase: "aboard", kind: sh.kind, k: sh.k, name: sh.name, city: worldId, warp: 0, seat: Math.floor(Date.now()/1000) % 12, pre: null, from: worldId};
    shipSfx("door");
    say(sh.kind === "cargo" ? "A launch takes you out to the " + sh.name + ". The captain gives you a seat on the bridge wing."
                            : "A tender takes you out to the " + sh.name + ". Find a lounger by the pool.");
  }
  function cruiseShip(C){ return bigFleet && (bigFleet[C.kind] || []).filter(function(sh){ return sh.k === C.k; })[0]; }
  function cruiseStep(t, dt, solid){
    var C = NAV.cruise;
    if(!C || C.city !== worldId){ if(myCruise) myCruise.g.visible = false; if(!C) bigHud(null); return; }
    var sh = cruiseShip(C); if(!sh) return;
    if(C.phase === "wait"){
      var av = c.avatar();
      if(av && Math.hypot(av.x - C.at.x, av.z - C.at.z) > 120){ NAV.cruise = null; bigHud(null); say("You left the port."); return; }
      if(Date.now() >= C.arrive){ cruiseBoard(sh); return; }
      bigHud("Waiting for the " + C.name + " · calls in " + waitText(C.arrive - Date.now()), "E: stop waiting", 0);
      return;
    }
    if(c.held && c.held("Space")) C.warp += dt*7;                                    // full ahead: eight times as fast
    var tl = VOY.loopT(sh, Date.now(), C.warp), p = VOY.poseAt(sh.R, tl), ns = VOY.nextStop(sh, tl);
    if(myCruise && myCruise.id !== sh.kind + sh.k){ myCruise.dispose(); myCruise = null; }
    if(!myCruise){ myCruise = bigModel(sh); myCruise.id = sh.kind + sh.k; }
    placeBig(myCruise, p, 0, t, dt);
    solid.push({x: myCruise.g.position.x, z: myCruise.g.position.z, r: bigHalf(sh.kind)});
    var to = ns && ns.stop, here = hereArch();
    // the next stop's City, built on the way; moved into once nearer it than this one
    if(to && to.world !== worldId && !ns.at){
      if(C.pre !== to.world && c.prebuildCity){ C.pre = to.world; c.prebuildCity(to.world); }
      var tc = cityAt(to.world);
      if(tc && Math.hypot(p.x - tc.x, p.z - tc.z) < Math.hypot(p.x - here.x, p.z - here.z) && c.cityBuilt && c.cityBuilt(to.world)){
        C.city = to.world; if(!(c.swapCity && c.swapCity(to.world))) C.city = worldId;
      }
    }
    var name = to ? (to.world === worldId && cityState && cityState.name ? cityState.name : to.name) : "";
    if(ns && ns.at) bigHud("At anchor off " + name + " · sails in " + waitText(ns.leaveS*1000), to.world === worldId ? "E: go ashore · hold Space: sail on" : "Coming in to anchor…", 1);
    else bigHud("On the " + C.name + " · next stop " + name + " · " + waitText((ns ? ns.inS : 0)*1000/((c.held && c.held("Space")) ? 8 : 1)),
                (c.held && c.held("Space")) ? "Full ahead!" : "Hold Space: full ahead · drag to look around", ns ? Math.max(0, 1 - ns.inS/600) : 0);
  }
  function cityAt(world){ return (bigCityL || []).filter(function(o){ return o.world === world; })[0] || null; }
  // where you sit aboard (w.carry)
  function cruiseSeat(){
    var F = myCruise; if(!F || !F.g.visible) return null;
    var S0 = F.seats[NAV.cruise.seat % F.seats.length], g = F.g, cy = Math.cos(g.rotation.y), sy = Math.sin(g.rotation.y);
    return {x: g.position.x + S0.position.x*cy + S0.position.z*sy, y: g.position.y + S0.position.y - 0.35, z: g.position.z - S0.position.x*sy + S0.position.z*cy, yaw: g.rotation.y};
  }
  // E: stop waiting; ashore at anchor here; else a word
  function cruiseUse(){
    var C = NAV.cruise;
    if(!C || C.city !== worldId) return false;
    if(C.phase === "wait"){ NAV.cruise = null; bigHud(null); say("You stopped waiting."); return true; }
    var sh = cruiseShip(C), ns = sh && VOY.nextStop(sh, VOY.loopT(sh, Date.now(), C.warp));
    if(!(ns && ns.at)){ say("You're at sea. Sit back, or hold Space for full ahead."); return true; }
    if(ns.stop.world !== worldId){ say("Coming in to anchor. A moment…"); return true; }
    var site = (W.sites || []).filter(function(s){ return s.kind === "port" && !(s.tier != null && (s.tier | 0) > tier); })[0], b = VOY.berthOf(W);
    if(!site && b) site = siteById(b.site);
    var sp = site ? HQV.hqTravel.spawnAt(worldId, site) : null;
    NAV.cruise = null; bigHud(null); if(myCruise) myCruise.g.visible = false;
    if(HQV.hqTravel.markVisited) HQV.hqTravel.markVisited(worldId);
    if(sp && c.teleport) c.teleport(sp.x, sp.z, sp.yaw);
    shipSfx("levelup");
    say("The " + (C.kind === "cargo" ? "launch" : "tender") + " lands you at the port. Welcome to " + (cityState && cityState.name ? cityState.name : ns.stop.name) + ".");
    return true;
  }
  // the cruise panel (its own element: the ferry's panel goes when no ferry voyage runs)
  function bigHud(main, hint, frac){
    if(!c.el || typeof document === "undefined") return;
    var el = NAV.bigHud;
    if(main == null){ if(el){ if(el.parentNode) el.parentNode.removeChild(el); NAV.bigHud = null; NAV.bigKey = ""; } return; }
    if(el && el.parentNode !== c.el) c.el.appendChild(el);
    if(!el){
      el = document.createElement("div"); el.className = "hq3d-voyage hq3d-cruise"; el.setAttribute("role", "status");
      ["icon", "main", "bar", "hint"].forEach(function(k){ var d = document.createElement("div"); d.className = "hq3d-voyage-" + k; el.appendChild(d); });
      el.children[0].textContent = "🛳"; el.children[2].appendChild(document.createElement("span"));
      c.el.appendChild(el); NAV.bigHud = el; NAV.bigKey = "";
    }
    var icon = NAV.cruise && NAV.cruise.kind === "cargo" ? "📦" : "🛳", key = icon + main + "|" + hint + "|" + Math.round((frac || 0)*100);
    if(key === NAV.bigKey) return;
    NAV.bigKey = key;
    el.children[0].textContent = icon;
    el.children[1].textContent = main; el.children[3].textContent = hint || "";
    el.children[2].firstChild.style.width = (Math.max(0, Math.min(1, frac || 0))*100).toFixed(1) + "%";
  }
  // for tools (headless shots, tests): the fleet's poses near here, board a cruise ship now, skip ahead aboard
  w.ships = {
    state: function(){
      var hp = hereArch(), now = Date.now(), C = NAV.cruise;
      return {here: worldId, cruise: C ? {phase: C.phase, kind: C.kind, k: C.k, city: C.city, warp: C.warp, pre: C.pre} : null,
        ships: bigFleet ? bigFleet.cruise.concat(bigFleet.cargo).map(function(sh){ var p = VOY.shipAt(sh, now, 0), ns = VOY.nextStop(sh, VOY.loopT(sh, now, 0));
          var F = bigShips[sh.kind + sh.k];
          return {kind: sh.kind, k: sh.k, name: sh.name, x: p.x - hp.x, z: p.z - hp.z, yaw: p.yaw, speed: p.speed, T: sh.R.T, shown: !!(F && F.g.visible),
                  next: ns ? {world: ns.stop.world, name: ns.stop.name, inS: ns.inS, at: ns.at} : null}; }) : null};
    },
    board: function(k, kind){ var sh = bigFleet && (bigFleet[kind || "cruise"] || [])[k | 0]; if(sh) cruiseBoard(sh); return !!sh; },
    skip: function(s){ if(NAV.cruise && NAV.cruise.phase === "aboard") NAV.cruise.warp += +s || 0; },
    // seconds (at warp 0) until the cruise (or kind) ship k next anchors off world
    until: function(k, world, kind){ var sh = bigFleet && (bigFleet[kind || "cruise"] || [])[k | 0]; var call = sh && VOY.calls(sh, world || worldId, Date.now(), sh.R.T*1000)[0]; return call ? (call.arrive - Date.now())/1000 : null; },
    menu: function(){ var it = []; bigShipItems({kind: "port"}, it); return it.map(function(i){ return i.text; }); },
    ashore: function(){ return cruiseUse(); },
    // headless shots only: hold a ship at a local pose {x, z, yaw, speed} (null lets it sail on)
    pin: function(kind, k, o){ bigPins[kind + (k | 0)] = o || null; }
  };
  function bigPin(o){ var hp = hereArch(); return {x: hp.x + (+o.x || 0), z: hp.z + (+o.z || 0), yaw: +o.yaw || 0, speed: +o.speed || 0}; }
  /* ---------- rail (games/hqrail.js): built lines, their viaducts, stations and trains; ride one between cities ----------
     GET /api/arena/rail lists the built lines; each one touching this city is drawn (elevated over the streets, on piers
     across the sea) with its trains on the shared timetable. At the station (E) the menu offers a ride on each line and,
     for your own island, building a line (POST /api/arena/rail/build, paid from your island's treasury). Riding works as
     the ferry: a seat in the second car (w.carry), the next city built on the way and swapped in mid-sea, Space for the
     express. Everything lives in HQV.hqRail.mount; this block only wires it to the City. */
  var rail = null;
  function setupRail(){
    if(!HQV.hqRail || !HQV.hqRail.mount || !W || !HQV.hqRail.stationOf(W)) return;
    try {
      rail = HQV.hqRail.mount(c, w, {W: W, world: worldId, tier: tier, me: me, sea: sea ? sea.y : 0, night: night, here: hereArch, arch: getArch, get: getJson, post: postJson,
        say: say, places: function(a){ return travelPlaces(a, worldId, me); }, ground: groundY,
        spawnAt: function(wid, s){ return HQV.hqTravel && HQV.hqTravel.spawnAt ? HQV.hqTravel.spawnAt(wid, s) : null; }});
      w.rail = rail.tools;
    } catch(e){ rail = null; }
  }
  /* ---------- end rail ---------- */

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
    if(best){
      var s = siteById(best.id), P = s && HQV.hqCivic && HQV.hqCivic.pierOf ? HQV.hqCivic.pierOf(s)[0] : null;
      if(P) return {x: P.head[0] - P.dir[0]*1.5, z: P.head[1] - P.dir[1]*1.5, yaw: Math.atan2(-P.dir[0], -P.dir[1])};   // up onto its pier's head
      if(s){ var f = frontOf(s); return {x: s.x/100 - f[0]*2, z: s.z/100 - f[1]*2, yaw: Math.atan2(-f[0], -f[1])}; }
    }
    var sx = Math.sin(st.yaw), sz = Math.cos(st.yaw);
    if(sea.land(st.x + sx*2.5, st.z + sz*2.5) && sea.land(st.x + sx*4, st.z + sz*4)) return {x: st.x + sx*4, z: st.z + sz*4, yaw: st.yaw};
    return null;
  };

  /* ========== AIR: helicopters, helipads, the air base, the carrier, the jets (games/hqheli.js, games/hqair.js) ==========
     Everything of theirs is in this block; elsewhere in this file the hooks are single lines marked "// air:". */
  var air = null, heliGo = null;
  function airSetup(){
    if(!HQV.hqAirbase || !HQV.hqheli || !W) return;
    try { air = HQV.hqAirbase.create(c, S, {W: W, sea: sea, commons: worldId === COMMONS, civics: civics, blocked: blocked, groundY: groundY, night: night}); }
    catch(e){ air = null; HQV.hqAirbase.err = String((e && e.stack) || e); if(window.console) console.warn("hqair:", e); }
  }
  // what a helicopter lands on or runs into here: the ground, the water, every roof (the world's buildings, the HQs,
  // the civic masses: their camera boxes), the air base and the carrier's deck
  w.heliFloor = function(x, z){
    var off = !W || Math.abs(x) > W.half || Math.abs(z) > W.half, y = off ? (sea ? sea.y : 0) : groundY(x, z);
    if(sea && !off && !sea.land(x, z)) y = Math.max(y, sea.y + 0.3);
    if(!off){
      buildingsIn(x, x, z, z).concat(placedIn(x, x, z, z)).forEach(function(b){
        if(x >= b.min.x && x <= b.max.x && z >= b.min.z && z <= b.max.z && b.max.y > y) y = b.max.y; });
    }
    var a = air ? air.floor(x, z) : null;
    return a != null && a > y ? a : y;
  };
  // stepping out of a helicopter that has landed: beside it on land, a roof pad's building's door; never at sea
  w.heliLand = function(st){
    if(air) return air.landSpot(st);
    return st && st.ground && (!sea || sea.land(st.x + 3*Math.cos(st.yaw), st.z - 3*Math.sin(st.yaw))) ? {x: st.x + 3*Math.cos(st.yaw), z: st.z - 3*Math.sin(st.yaw), yaw: st.yaw} : null;
  };
  // Flying on: out over the sea toward another island, its City is built while you fly (hq3d's prebuildCity) and you
  // fly into it once you are nearer it than this one (swapCity, keeping the helicopter: no loading screen); if it
  // cannot be built that way, HQV.hqTravel.arrive lands you there (the loading screen) as a boat does.
  w.onHeli = function(h){
    if(!h || !V2 || !HQV.ocean || landing || !arch) return;
    var st = h.st, dh = Math.hypot(st.x, st.z);
    if(!heliGo){
      if(dh < (island() ? HQV.ocean.COAST_R.island : HQV.ocean.COAST_R.commons) + 150) return;
      var q = HQV.ocean.nearestIsland(st.x, st.z);
      if(!q || !worldOk(q.world) || q.shore > 1600) return;
      heliGo = {world: q.world, x: q.x, z: q.z, d0: q.dist, name: q.name || "the island", built: !!(c.prebuildCity && c.prebuildCity(q.world))};
      say("Flying on to " + heliGo.name + "…");
      return;
    }
    var dn = Math.hypot(st.x - heliGo.x, st.z - heliGo.z);
    if(dn > heliGo.d0 + 600){ heliGo = null; return; }                    // turned away: another island, or home
    if(heliGo.built && dn < dh && c.cityBuilt && c.cityBuilt(heliGo.world)){
      var G = heliGo; heliGo = null; landing = true;
      if(c.swapCity && c.swapCity(G.world, {dx: G.x, dz: G.z})){ if(HQV.hqTravel && HQV.hqTravel.markVisited) HQV.hqTravel.markVisited(G.world); }
      else { landing = false; heliGo = G; G.built = false; }
      return;
    }
    if(!heliGo.built && dn < HQV.ocean.COAST_R.island + 300 && HQV.hqTravel){
      landing = true; say("Landing on " + heliGo.name + "…");
      HQV.hqTravel.arrive(heliGo.world, null, travelHooks()).then(function(sp){ if(sp && sp.failed) landing = false; });
    }
  };
  /* ========== end AIR ========== */

  /* ========== PLANES (HQ 3.2): the seaplane at the dock and the prop plane at the airport (games/hqplane.js) ==========
     A seaplane moors off the main berth (the Commons' dock, your island's), facing out over the water; a prop plane
     stands at every airport (the Commons always, an island at tier 5) on the runway's apron by the threshold. hq3d flies
     them over w.planeEnv: the floor (w.heliFloor, plus the runway decks out over the water), open water and its
     surface (ocean.js sea.surface: the boats' and ferries' own), and the runways; w.planeHome is where a crash puts a
     plane back. */
  var planeProps = [], runways = [], planeG = null, PLANE_CLEAR = [[0, 0], [9, 0], [-9, 0], [0, 8], [0, -8], [6, 5], [-6, 5]];
  function planesSetup(){
    if(!HQV.hqplane || !HQV.hqAircraft || !HQV.hqShips || !W) return;
    planeG = new THREE.Group(); planeG.name = "planes"; S.add(planeG);
    var ap = airportHere() || null;
    if(ap && AIR){
      var end = AIR.airportEnd(ap, 0, 0, airRunwayY(W, ap)), u = end.dir, thr = end.thr, ry = Math.atan2(u[0], u[1]);
      runways.push({thr: thr, dir: u, len: end.len, y: end.y, a0: -20, a1: end.len + 25, hw: 15});
      // its stand: beside the runway's deck by the threshold, clear of the airliners' stand (on the centreline 25 m
      // back, 36 m of wing) and of their takeoff roll: flat ground on whichever side has it, else the deck's edge
      var spot = null, base = air && air.base, side = [-30, 30, -36, 36];
      if(base) side.sort(function(a, c2){ function d(bb){ return -Math.hypot(thr[0] + u[1]*bb - base.x, thr[1] - u[0]*bb - base.z); } return d(a) - d(c2); });   // away from the air base's fence
      side.some(function(bb){
        var x = thr[0] + u[0]*20 + u[1]*bb, z = thr[1] + u[1]*20 - u[0]*bb, gy0 = groundY(x, z);
        if(sea && !sea.land(x, z)) return false;
        if(Math.abs(gy0 - end.y) > 1.2 || Math.abs(groundY(x + u[0]*6, z + u[1]*6) - gy0) > 0.8 || blocked(x, z)) return false;
        spot = {x: x, y: gy0, z: z}; return true;
      });
      if(!spot) spot = {x: thr[0] + u[0]*60 + u[1]*12, y: end.y, z: thr[1] + u[1]*60 - u[0]*12};
      addPlane("prop", spot.x, spot.y, spot.z, ry, 0x2f6f9f, 0xf2f2f2, "plane:prop:" + ap.id, null);
    }
    // the seaplane: on the water down the river from the main berth (the way the airline's seaplanes taxi out,
    // hqvoyage.inland), past where they tie up (45 m), facing down-river toward the sea; the clearest spot 60..200 m on
    var b = VOY && VOY.berthOf ? VOY.berthOf(W) : null, path = b && VOY.inland ? VOY.inland(W) : null;
    if(b && path && path.length > 1 && sea && sea.surface){
      var site = siteById(b.site), along = 0, best = null, bs = -1;
      for(var i = 1; i < path.length && along < 200; i++){
        var ax = path[i - 1][0], az = path[i - 1][1], L = Math.hypot(path[i][0] - ax, path[i][1] - az) || 1, f = [(path[i][0] - ax)/L, (path[i][1] - az)/L];
        for(var u = 0; u < L; u += 5){
          var d = along + u; if(d < 60 || d > 200) continue;
          var x = ax + f[0]*u, z = az + f[1]*u;
          var score = PLANE_CLEAR.filter(function(o){ var lx = o[0], lz = o[1]; return !sea.boat.land(x + lx*f[1] + lz*f[0], z - lx*f[0] + lz*f[1]); }).length;
          if(score > bs){ bs = score; best = {x: x, z: z, yaw: Math.atan2(f[0], f[1])}; }
        }
        along += L;
      }
      if(best && !sea.boat.land(best.x, best.z))
        addPlane("seaplane", best.x, sea.surface(best.x, best.z) - 0.25, best.z, best.yaw, 0xd0262b, 0xf2f2f2, "plane:sea:" + (site ? site.id : "berth"), {draft: 0.25});
    }
    if(bikes && planeProps.length) planeProps.forEach(function(p){ if(bikes.indexOf(p) < 0) bikes.push(p); });
  }
  function addPlane(kind, x, y, z, yaw, col, acc, id, flt){
    var B = HQV.hqplane.model(c, kind, col, acc); B.g.position.set(x, y, z); B.g.rotation.y = yaw; planeG.add(B.g);
    HQV.hqplane.animate(B, null, 0, night);
    planeProps.push({g: B.g, x: x, y: y, z: z, yaw: yaw, kind: kind, color: col, accent: acc, id: id, stay: true, float: flt, B: B,
                     home0: {x: x, y: y, z: z, yaw: yaw}});
  }
  w.planes = function(){ return planeProps.map(function(p){ return {kind: p.kind, x: p.x, y: p.y, z: p.z, yaw: p.yaw, id: p.id}; }); };   // (tools)
  function planesDestroy(){ if(planeG && planeG.parent) planeG.parent.remove(planeG); planeG = null; planeProps = []; runways = []; }
  // a point on a runway's deck (its a0..a1 along, hw either side): that runway, else null
  function runwayAt(x, z){
    for(var i = 0; i < runways.length; i++){
      var R0 = runways[i], dx = x - R0.thr[0], dz = z - R0.thr[1], a = dx*R0.dir[0] + dz*R0.dir[1], bb = dx*R0.dir[1] - dz*R0.dir[0];
      if(a >= R0.a0 && a <= R0.a1 && Math.abs(bb) <= R0.hw) return R0;
    }
    return null;
  }
  // the camera's floor (hq3d rigFrame): the ground, and over open water the water's surface plus 0.5 m, so a chase
  // camera behind a boat or low over the sea never dips under the waves (it used to follow the sea bed) (3.2)
  w.camGround = function(x, z){
    var g = groundY(x, z);
    if(sea && sea.surface && (!W || Math.abs(x) > W.half || Math.abs(z) > W.half || !sea.boat.land(x, z))) g = Math.max(g, sea.surface(x, z) + 0.5);
    return g;
  };
  w.planeEnv = {
    floor: function(x, z){ var R0 = runwayAt(x, z), f = w.heliFloor(x, z); return R0 ? Math.max(R0.y, R0.y > f - 2 ? R0.y : f) : f; },
    water: function(x, z){ if(runwayAt(x, z)) return false; var off = !W || Math.abs(x) > W.half || Math.abs(z) > W.half; return !!sea && (off || !sea.boat.land(x, z)); },
    waterY: function(x, z){ return sea && sea.surface ? sea.surface(x, z) : (sea ? sea.y : 0); },
    runway: function(x, z){ return !!runwayAt(x, z); }
  };
  // where a crashed plane goes back to: the nearest of its kind's places here (else null: where you took it from)
  w.planeHome = function(kind, x, z){
    var best = null, bd = Infinity;
    planeProps.forEach(function(p){ if(p.kind !== kind) return; var d = Math.hypot(p.home0.x - x, p.home0.z - z); if(d < bd){ bd = d; best = p.home0; } });
    return best;
  };
  /* ========== end PLANES ========== */

  /* ========== AIR NAVIGATION (HQ 3.2): the Go to list, the waypoint and the approach while you fly ==========
     The ground's navigation, flown: the same Go to panel (N), minimap click and banner, with the air's own
     destinations first (the runways here, the seaplane's landing lane off the river mouth, helipads, the other
     islands). The route is a straight line (no roads) drawn on the minimap, the light pillar stands at the
     destination, and a runway or a water lane gets its approach: rings down a 3° glideslope from the final approach
     fix and a touchdown marker. w.airGuide() is what the flight HUD (hq3d guideDraw) and the autopilot follow. */
  var GS = Math.tan(3*Math.PI/180), FAF = 1500, apprG = null, apprFor = null;
  function airNavPlaces(m, me0){
    var out = [], craft = m.craft;
    function add(p){ p.dist = Math.hypot(p.door.x - me0.x, p.door.z - me0.z); out.push(p); }
    // runways (land toward the threshold, from out over the sea: as the airliners do), for planes and helicopters
    runways.forEach(function(R0, i){
      var td = {x: R0.thr[0] + R0.dir[0]*(R0.len - 70), z: R0.thr[1] + R0.dir[1]*(R0.len - 70)};
      add({id: "air:runway:" + i, kind: "runway", label: "Runway (the airport)", icon: "\u2708", x: td.x, z: td.z, door: td,
           air: {kind: "runway", td: td, hdg: Math.atan2(-R0.dir[0], -R0.dir[1]), y: R0.y}});
    });
    // the seaplane's landing lane: off the river's mouth, landing toward it (hqair's dockEnd)
    if((craft === "seaplane" || !craft) && AIR && VOY && VOY.berthOf && VOY.berthOf(W) && sea){
      var e = AIR.dockEnd(W, 0, 0, [0, 0]), td2 = {x: e.thr[0] + e.dir[0]*370, z: e.thr[1] + e.dir[1]*370};
      add({id: "air:lane", kind: "lane", label: "Water landing lane (the river mouth)", icon: "\uD83D\uDEE9", x: td2.x, z: td2.z, door: td2,
           air: {kind: "lane", td: td2, hdg: Math.atan2(-e.dir[0], -e.dir[1]), y: sea.y}});
    }
    // helipads (helicopters)
    if(craft === "heli" && air && air.pads) air.pads.forEach(function(P, i){
      add({id: "air:pad:" + i, kind: "pad", label: P.at && P.at.kind ? "Helipad (" + P.at.kind + ")" : "Helipad", icon: "H", x: P.x, z: P.z, door: {x: P.x, z: P.z},
           air: {kind: "pad", td: {x: P.x, z: P.z}, hdg: null, y: P.y}});
    });
    // the other islands: fly there (you fly into their city on the way, as a helicopter does)
    if(arch){
      var hp = hereArch();
      travelPlaces(arch, worldId, me).forEach(function(to){
        var x = to.x - hp.x, z = to.z - hp.z;
        add({id: "air:city:" + to.world, kind: "city", label: "Fly to " + to.name, icon: "\uD83C\uDFDD", x: x, z: z, door: {x: x, z: z}, air: null});
      });
    }
    out.sort(function(a, b){ return a.dist - b.dist; });
    return out;
  }
  // where to fly now: straight to the destination, or (a runway or a lane, still far out or off its line) to its final
  // approach fix first; on final, the glideslope: gs > 0 above it, < 0 below (-1..1 = +-half the slope's height)
  function airGuideNow(me0){
    if(!route || route.done || route.mode !== "air") return null;
    var m = c.motion ? c.motion() : null, y = m ? m.y : 0, A = route.air;
    var to = {x: route.x, z: route.z}, via = null, alt = null, gs = null;
    if(A && A.hdg != null){
      var bx = -Math.sin(A.hdg), bz = -Math.cos(A.hdg);                   // from touchdown back along the approach
      var dx = me0.x - A.td.x, dz = me0.z - A.td.z, along = dx*bx + dz*bz, off = Math.abs(dx*bz - dz*bx);
      var faf = {x: A.td.x + bx*FAF, z: A.td.z + bz*FAF};
      if(along > FAF + 200 || along < 0 || off > Math.max(120, along*0.3)){ via = faf; alt = A.y + GS*FAF + 20; }   // not on final yet
      else { var gy = A.y + GS*Math.max(0, along); alt = gy; gs = Math.max(-1, Math.min(1, (y - gy)/Math.max(8, GS*along*0.5))); }
    } else if(A) alt = A.y + 30;
    else alt = Math.max(120, y);
    var tgt = via || to, dist = Math.hypot(tgt.x - me0.x, tgt.z - me0.z);
    return {label: route.label, bearing: Math.atan2(tgt.x - me0.x, tgt.z - me0.z), dist: dist, alt: alt, gs: gs, to: tgt, via: via};
  }
  w.airGuide = function(){ var me0 = c.avatar(); return me0 ? airGuideNow(me0) : null; };
  // the approach's rings down the glideslope and the touchdown marker (one InstancedMesh, one plane), for the route's
  // runway or lane; null hides them. Static meshes: nothing animates (Calm needs nothing).
  function approachShow(A){
    if(A === apprFor) return;
    apprFor = A;
    if(apprG){ S.remove(apprG); apprG.traverse(function(o){ if(o.geometry) o.geometry.dispose(); if(o.material) o.material.dispose(); }); apprG = null; }
    if(!A || A.hdg == null) return;
    apprG = new THREE.Group(); apprG.name = "approach";
    var bx = -Math.sin(A.hdg), bz = -Math.cos(A.hdg), n = 6, im = new THREE.InstancedMesh(new THREE.TorusGeometry(9, 0.45, 6, 28),
      new THREE.MeshBasicMaterial({color: 0x5fd3e6, transparent: true, opacity: 0.75, depthWrite: false, fog: false, toneMapped: false}), n);
    var m4 = new THREE.Matrix4(), q = new THREE.Quaternion().setFromEuler(new THREE.Euler(0, A.hdg, 0)), sc = new THREE.Vector3(1, 1, 1);
    for(var i = 0; i < n; i++){
      var d = 220 + i*(FAF - 220)/(n - 1), p = new THREE.Vector3(A.td.x + bx*d, A.y + GS*d + 2, A.td.z + bz*d);
      m4.compose(p, q, sc); im.setMatrixAt(i, m4);
    }
    im.instanceMatrix.needsUpdate = true; im.frustumCulled = false; apprG.add(im);
    var tdz = new THREE.Mesh(new THREE.PlaneGeometry(A.kind === "lane" ? 30 : 18, 90),
      new THREE.MeshBasicMaterial({color: 0x5fd3e6, transparent: true, opacity: 0.28, depthWrite: false, fog: false, toneMapped: false, polygonOffset: true, polygonOffsetFactor: -4}));
    tdz.rotation.order = "YXZ"; tdz.rotation.set(-Math.PI/2, A.hdg, 0);              // flat, along the landing heading
    tdz.position.set(A.td.x - bx*20, A.y + 0.08, A.td.z - bz*20); apprG.add(tdz);
    S.add(apprG);
  }
  /* ========== end AIR NAVIGATION ========== */

  // the residents this City draws (read-only, for tests and tools)
  w.npcSim = function(){ return nsim; };
  // E: a resident's line, a stop's lines, a terminal's trips (and E again cancels a wait)
  w.use = function(p){
    if(!V2 || !p) return false;
    if(menu){ closeMenu(); return true; }
    if(bus){ if(bus.phase === "wait"){ bus = null; say("You stopped waiting."); } return true; }
    if(NAV.trip && NAV.trip.phase === "boarding"){ NAV.trip = null; say("You stayed ashore."); return true; }
    if(airUse()) return true;                                                             // AIR: booked on a flight
    if(cruiseUse()) return true;                                                                        // big ships
    if(mine(NAV.voy)){
      if(Date.now() < NAV.voy.dep && NAV.voy.from === worldId){ var b = VOY.berthOf(W), bs = b && siteById(b.site), sp = bs && HQV.hqTravel.spawnAt(worldId, bs); voyLeave(); if(sp && c.teleport) c.teleport(sp.x, sp.z, sp.yaw); say("You stayed ashore."); }
      else say("You're at sea. Sit back, or hold Space for full ahead.");
      return true;
    }
    if(rail && rail.use()) return true;                  // rail: off the train before it leaves
    if(ndraw){
      var line = ndraw.talk({x: p.x, z: p.z}, npcMs());
      if(line && line.text){ showTalk(line); return true; }
    }
    var rs = rail && rail.station(p.x, p.z); if(rs){ openTravelMenu(rs); return true; }   // rail: at the station's door, before its bus bay
    if(tsim){ var st = tsim.stopsNear(p.x, p.z, STOP_R)[0]; if(st){ openStopMenu(st); return true; } }
    var tm = HQV.hqTravel ? terminalAt(W, tier, p.x, p.z) : null;
    if(tm){ if(route && route.travel) navClear(); openTravelMenu(tm); return true; }     // the ferry you were routed to
    return false;
  };
  // a stop's or a terminal's menu, or the Go to panel: hq3d's keys stand still (the keys are theirs)
  w.menuOpen = function(){ return !!menu || !!(nui && nui.isOpen()); };
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
  // the city's stats, top right: name, tier and growth, population, happiness (and what it is made of), treasury
  function statsUi(){
    if(!V2 || !c.el || typeof document === "undefined") return;
    if(!statsEl) statsAt = Date.now();
    else if(statsEl.parentNode) statsEl.parentNode.removeChild(statsEl);
    statsEl = document.createElement("div"); statsEl.className = "hq3d-stats"; c.el.appendChild(statsEl);
    var K = cityStats(W, tier, cityState), fmt = function(v){ return v == null ? "–" : Math.round(v).toLocaleString(); };
    var name = island() ? String((cityState && cityState.name) || "An island").slice(0, 32) : "The Commons";
    function row(label, value, title){
      var r = document.createElement("div"); r.className = "hq3d-stat";
      var a = document.createElement("span"); a.textContent = label; var b = document.createElement("b"); b.textContent = value;
      r.appendChild(a); r.appendChild(b); if(title) r.title = title; statsEl.appendChild(r); return r;
    }
    var h = document.createElement("div"); h.className = "hq3d-stats-name"; h.textContent = name; statsEl.appendChild(h);
    row("Tier", K.tier + " · " + K.tierName, K.tier < 5 ? Math.round(K.grow/10) + "% of the way to the next tier" : "Fully grown");
    var bar = document.createElement("div"); bar.className = "hq3d-stats-bar"; var fill = document.createElement("i");
    fill.style.width = (K.tier < 5 ? K.grow/10 : 100) + "%"; bar.appendChild(fill); statsEl.appendChild(bar);
    row("Population", fmt(K.population));
    var hp = row("Happiness", K.happiness == null ? "–" : K.happiness + " / 100",
                 K.parts.map(function(p){ return p.label + ": " + p.pct + "% of buildings in reach"; }).join("\n"));
    hp.setAttribute("data-mood", K.happiness == null ? "" : K.happiness >= 75 ? "good" : K.happiness >= 50 ? "ok" : "low");
    row("Treasury", K.treasury == null ? "–" : fmt(K.treasury) + " coins");
    if(K.specialty) row("Specialty", K.specialty.charAt(0).toUpperCase() + K.specialty.slice(1));
    // the forecast (games/hqweather.js): now, and what the next spell brings and when
    if(wx){ var fc = wx.forecast(1), mins = Math.max(1, Math.round((fc[1].at - Date.now())/60000));
      row("Weather", fc[0].icon + " " + fc[0].name, fc[1].kind === fc[0].kind ? "Staying " + fc[0].name.toLowerCase() + " for now" : fc[1].name + " in " + mins + " min"); }
  }
  function citiesSetup(){
    buildCivic(); S.add(civicG);
    setupSea(); bridgesSetup(); setupLife(); buildUi(); statsUi(); setupFerries(); setupBigShips(); setupAir(); setupRail();
    airSetup();                                                            // air: helipads, the air base, the carrier, jets
    planesSetup();                                                         // planes: the seaplane and the prop plane (HQ 3.2)
    if(worldId === COMMONS) getJson("/api/arena/world/" + COMMONS + "/assign").then(function(rows){
      if(dead || !Array.isArray(rows)) return; assignRows = rows; sig = null; build();
    }, function(){});
  }
  function citiesUpdate(t, dt, k, cam){
    var nowMs = Date.now();
    if(statsEl && nowMs - statsAt > 60000){ statsAt = nowMs; fetchCity().then(function(){ if(!dead) statsUi(); }); }
    // civic buildings near the camera are drawn in full, the rest (the map's too, from up there) as boxes
    civics.forEach(function(B){
      if(cam && cam.x != null){
        var d = Math.hypot(B.x - cam.x, B.z - cam.z, (+cam.y || 0) - B.y), full = B.g.visible ? d < CIVIC_NEAR : d < CIVIC_NEAR - HQ_FAR_HYST;
        if(B.g.visible !== full || B.far !== !full){ B.g.visible = full; lodShow(B, !full); }
      }
      if(B.g.visible) B.animate(t, dt, k);
    });
    // bikes, boards and boats far from the camera are not drawn: their meshes sit in an inner group, as
    // hq3d hides the prop itself (g.visible) while you ride it
    if(cam && cam.x != null) bikes.forEach(function(b){
      var gp = b.g.position, P = b.g.parent, wx = b.x != null ? b.x : gp.x, wz = b.z != null ? b.z : gp.z, wy = P ? P.position.y + gp.y : gp.y;
      var vis = Math.hypot(wx - cam.x, wz - cam.z, (+cam.y || 0) - wy) < PROP_FAR, inner = b.inner;
      if(!inner){
        if(vis) return;
        inner = b.inner = new THREE.Group(); inner.name = "prop-near";
        while(b.g.children.length) inner.add(b.g.children[0]);
        b.g.add(inner);
      }
      if(inner.visible !== vis) inner.visible = vis;
    });
    var me0 = (cam && cam.avatar) || c.avatar() || {x: 0, z: 0};
    if(sea){ var calmSea = !!(c.E && c.E.calm && c.E.calm()); sea.flat = calmSea; sea.clock = calmSea ? 0 : t; }   // = the drawn sea's (oc.step)
    if(sea && sea.surface && cam && cam.x != null) floatParked(cam);
    if(oc && cam){
      oc.step(t, dt, cam);
      if(boatNow) oc.wake([{id: "you", x: boatNow.st.x, z: boatNow.st.z, yaw: boatNow.st.yaw, speed: boatNow.st.speed || 0, beam: boatNow.beam}]);
    }
    if(tsim && tview){
      var obs = boatNow ? [] : [{x: me0.x, z: me0.z, r: 1}];
      if(bridges) obs = obs.concat(bridges.obstacles());
      try { tview.update(tsim.at(nowMs, {x: cam ? cam.x : me0.x, z: cam ? cam.z : me0.z}, 320, obs), nowMs); } catch(e){}
    }
    if(ndraw && cam){
      if(npcSkip > 0) npcSkip--;
      else {
        var t0 = typeof performance !== "undefined" ? performance.now() : 0;
        ndraw.update(npcMs(), {x: cam.x, y: cam.y, z: cam.z}, me0, dt);
        var used = typeof performance !== "undefined" ? performance.now() - t0 : 0;
        if(used > NPC_BUDGET) npcSkip = 1;
      }
    }
    if(talkL && nowMs > talkL.until){ S.remove(talkL.o); disposeTree(talkL.o); talkL = null; }
    busStep();
    if(air) air.update(t, dt, k, cam);                                     // air: jets, the radar
    var tp = tripStep();
    fadeTo(tp && (tp.frame === "from" ? NAV.trip && NAV.trip.from === worldId : true) ? tp.fade || 0 : 0);
  }
  function citiesDestroy(){
    closeMenu();
    if(ui && ui.parentNode) ui.parentNode.removeChild(ui);
    if(statsEl && statsEl.parentNode) statsEl.parentNode.removeChild(statsEl);
    if(fadeEl && fadeEl.parentNode) fadeEl.parentNode.removeChild(fadeEl);
    if(tview){ try { tview.dispose(); } catch(e){} }
    if(ndraw){ try { ndraw.dispose(); } catch(e){} }
    if(oc){ try { oc.dispose(); } catch(e){} }
    S.remove(civicG); S.remove(boatG);
    if(air){ air.destroy(); air = null; }                                  // air:
    ferryPool.forEach(function(F){ F.dispose(); }); ferryPool = []; if(myFerry){ myFerry.dispose(); myFerry = null; }
    if(ferryT){ ferryT.dispose(); ferryT = null; } if(ferryG){ S.remove(ferryG); ferryG = null; }
    bridgesDestroy();
    airDestroy();                                                                         // AIR
    planesDestroy();
    Object.keys(bigShips).forEach(function(k){ bigShips[k].dispose(); }); bigShips = {}; if(myCruise){ myCruise.dispose(); myCruise = null; }   // big ships
    Object.keys(bigTpl).forEach(function(k){ bigTpl[k].dispose(); }); bigTpl = {}; if(bigG){ S.remove(bigG); bigG = null; }
    if(rail){ rail.destroy(); rail = null; }                // rail
  }

  /* ---------- navigation (HQ 3.1): the minimap, the Go to panel, the route banner, chevrons and the pillar ---------- */
  // games/hqnav.js routes on the roads open at this tier (v1's too); hqminimap, hqroutefx and hqnavui draw it. A
  // waypoint comes from the panel (N, the Go to button), a minimap click or a click on the ground on the map (M);
  // the route starts from you: "drive" on a car, motorbike or bicycle, a straight line on a boat, else "walk".
  // Rerouted when you stray (needsReroute), cleared on arrival (the card) or by the banner's X. A travel place
  // (the ferry) routes to its dock's land side, and there the banner says "Press E for the ferry".
  var NAV_SNAP = 40;           // m: a picked point snaps to a road this near, else stays where it was picked
  var NAV_BOAT_V = 6;          // m/s: a boat's ETA, straight across the water
  var NAV_BOAT_ARRIVE = 15;    // m: a boat arrives this near its waypoint
  var NAV_REROUTE_MS = 3000;   // at most one reroute this often
  var mm = null, nui = null, fx = null, goBtn = null, navKeyFn = null, route = null, navTier = 5, navSig = null;
  function navMode(){
    var m = c.motion ? c.motion() : null;
    return m && m.air ? "air" : m && m.boat ? "boat" : m && (m.ride === "car" || m.ride === "moto" || m.ride === "bike") ? "drive" : "walk";
  }
  function navGraph(){ return HQV.hqnav.graph(W, navTier); }
  function navPlaces(){
    var me0 = c.avatar() || {x: 0, z: 0};
    var list = HQV.hqnav.places(W, navTier, {x: me0.x, z: me0.z, me: me, island: V2 && island(),
      hqs: hqs.map(function(E){ return {userId: E.h.userId, name: E.name || E.h.name, lot: E.lot}; })});
    var m = c.motion ? c.motion() : null;
    return m && m.air ? airNavPlaces(m, me0).concat(list) : list;
  }
  function fmtM(m){ return HQV.hqnavui ? HQV.hqnavui.fmtDist(m) : Math.round(m) + " m"; }
  // dest: {x, z, label, kind, air?: an approach (airPlaces)}
  function navTo(dest){
    route = {x: dest.x, z: dest.z, label: dest.label || "the pin", kind: dest.kind || "pin", travel: dest.kind === "travel",
             R: null, mode: null, at: 0, done: false, air: dest.air || null};
    navRoute();
    say("Route to " + route.label + (route.R ? ", " + fmtM(route.R.len) : "") + ".");
  }
  function navRoute(){
    var me0 = c.avatar(); if(!route || !me0) return;
    route.mode = navMode(); route.at = Date.now();
    if(route.mode === "air"){                            // flying: straight there, the approach marked (approachShow)
      route.R = null; approachShow(route.air);
      if(fx){ fx.setRoute(null, groundY); fx.setWaypoint({x: route.x, y: route.air ? route.air.y : groundY(route.x, route.z), z: route.z}); }
      return;
    }
    approachShow(null);
    route.R = route.mode === "boat" ? null : HQV.hqnav.route(navGraph(), {x: me0.x, z: me0.z}, {x: route.x, z: route.z}, route.mode);
    if(fx){ fx.setRoute(route.R ? route.R.pts : null, groundY); fx.setWaypoint({x: route.x, y: groundY(route.x, route.z), z: route.z}); }
  }
  function navToSite(site, label){
    if(!site || !HQV.hqnav) return;
    var d = HQV.hqnav.doorOf(site); navTo({x: d.x, z: d.z, label: label || site.name || site.kind, kind: site.kind});
  }
  function navClear(){
    route = null; approachShow(null);
    if(fx){ fx.setRoute(null, groundY); fx.setWaypoint(null); }
    if(nui) nui.banner(null);
  }
  // a minimap click or a click on the map: the nearest road within NAV_SNAP, else the point itself
  function navPick(x, z){
    if(!W || !HQV.hqnav) return false;
    var p = HQV.hqnav.snap(navGraph(), x, z), e = p && p.d < NAV_SNAP ? W.edges[p.ei] : null;
    navTo(e ? {x: p.x, z: p.z, label: e.name || "the pin", kind: "pin"} : {x: x, z: z, label: "the pin", kind: "pin"});
    return true;
  }
  function navArrive(){
    if(route.travel){ route.done = true; return; }     // the banner stays on the quay: E for the ferry
    var label = route.label; navClear();
    if(nui) nui.arrived(label);
  }
  function navStep(dt, cam){
    var me0 = c.avatar(); if(!me0 || (!mm && !fx && !nui)) return;
    var m = c.motion ? c.motion() : null, pts = null, info = null;
    if(route && !route.done){
      var mode = navMode();
      if(mode !== route.mode) navRoute();                 // on or off a vehicle: the route for the new way
      if(mode === "air"){
        var G = airGuideNow(me0), dd = Math.hypot(route.x - me0.x, route.z - me0.z), mm0 = c.motion ? c.motion() : null;
        if(dd < (route.air ? 60 : 120) && (!route.air || (mm0 && mm0.y - groundY(me0.x, me0.z) < 3))) navArrive();
        else if(G){
          pts = G.via ? new Float64Array([me0.x, me0.z, G.via.x, G.via.z, route.x, route.z]) : new Float64Array([me0.x, me0.z, route.x, route.z]);
          var hd = Math.round(((-G.bearing*180/Math.PI) % 360 + 360) % 360);
          info = {step: {kind: "fly", road: "Fly " + ("00" + hd).slice(-3) + "°" + (G.via ? " to the final approach" : G.gs != null ? " down the glideslope" : "")}, toNext: G.dist, left: dd,
                  eta_s: dd/Math.max(10, mm0 ? mm0.speed : 10), hint: G.gs != null ? "On final: follow the rings down to the runway" : ""};
        }
      } else if(route.R){
        var P = HQV.hqnav.progress(route.R, me0.x, me0.z);
        if(P.arrived) navArrive();
        else {
          if(HQV.hqnav.needsReroute(P, mode) && Date.now() - route.at > NAV_REROUTE_MS){ navRoute(); if(api.announce) api.announce("Rerouting"); }
          if(route.R) P = HQV.hqnav.progress(route.R, me0.x, me0.z);
          pts = route.R ? route.R.pts : null;
          info = {step: P.next, toNext: P.toNext, left: P.left, eta_s: route.R && route.R.len > 0 ? route.R.eta_s*P.left/route.R.len : 0};
        }
      } else {
        // a boat, or no road goes there: straight for it
        var d = Math.hypot(route.x - me0.x, route.z - me0.z), boat = mode === "boat";
        if(d < (boat ? NAV_BOAT_ARRIVE : HQV.hqnav.ARRIVE.walk)) navArrive();
        else {
          pts = new Float64Array([me0.x, me0.z, route.x, route.z]);
          info = {step: {kind: "straight", road: boat ? "Across the water" : "Off the road"}, toNext: d, left: d, eta_s: d/(boat ? NAV_BOAT_V : HQV.hqnav.SPEED.walk)};
        }
      }
    }
    if(route && route.done) info = {step: {kind: "arrive", road: route.label}, toNext: 0, left: 0, eta_s: 0, hint: "Press E for the ferry"};
    if(info) info.dest = route.label;
    if(nui) nui.banner(info);
    if(fx) fx.update(dt, me0, cam);
    if(mm) mm.frame({x: me0.x, z: me0.z, yaw: m ? m.yaw : 0, view: m && m.view != null ? m.view : null, speed: m ? m.speed : 0, route: pts,
                     waypoint: route ? {x: route.x, z: route.z} : null, others: c.others ? c.others() : [], dt: dt});
  }
  // the minimap's places: civic sites and the HQs as they are placed now (redrawn only when the HQs change)
  function navRefresh(){
    if(!mm) return;
    var key = hqs.map(function(E){ return E.h.userId + ":" + (E.lot && E.lot.id); }).join(",");
    if(key === navSig) return; navSig = key;
    try { mm.setWorld(W, navTier, {places: navPlaces()}); } catch(e){}
  }
  function typingIn(t){ var tag = (t && t.tagName || "").toLowerCase(); return tag === "input" || tag === "textarea" || tag === "select" || !!(t && t.isContentEditable); }
  // While a stop's or a terminal's menu or the Go to panel is open, no key reaches the page's shortcuts (W is not
  // the Workshop) or moves you (hq3d stands still on w.menuOpen); the panel stops its own. Else N opens the panel.
  function navKey(e){
    if(dead || (c.active && !c.active(w))) return;
    if(menu || (nui && nui.isOpen())){
      if(HQV.hqnavui && HQV.hqnavui.owns(e)) return;
      e.stopPropagation();
      var t = e.target, onItem = !!(menu && t && t.tagName === "BUTTON" && menu.contains && menu.contains(t));
      if(e.key !== "Tab" && !(onItem && (e.key === "Enter" || e.key === " "))) e.preventDefault();
      if(e.type === "keydown" && e.key === "Escape" && !menu && nui) nui.close();
      return;
    }
    if(mm && mm.isBig() && e.key === "Escape" && !typingIn(e.target)){
      e.stopPropagation(); e.preventDefault();
      if(e.type === "keydown") mm.expand(false);
      return;
    }
    if(nui && e.type === "keydown" && e.code === "KeyN" && !e.repeat && !e.metaKey && !e.ctrlKey && !e.altKey && !typingIn(e.target)){
      e.preventDefault(); e.stopPropagation(); nui.open();
    }
  }
  function navSetup(){
    if(!HQV.hqnav || !W || !c.el || typeof document === "undefined") return;
    navTier = V2 ? tier : 5;
    var announce = function(t){ if(api.announce) api.announce(t); };
    if(HQV.hqroutefx){ try { fx = HQV.hqroutefx.create(c, S); } catch(e){ fx = null; } }
    if(HQV.hqminimap){
      try { mm = HQV.hqminimap.mount(c.el, {onPick: navPick, onExpand: function(){ mm.expand(); }, announce: announce}); navRefresh(); }
      catch(e){ if(mm){ try { mm.destroy(); } catch(e2){} } mm = null; }
    }
    if(HQV.hqnavui){
      try {
        nui = HQV.hqnavui.mount(c.el, {places: navPlaces, onClear: navClear, announce: announce,
          onGo: function(p){ navTo({x: p.door.x, z: p.door.z, label: p.label, kind: p.kind, air: p.air || null}); }});
      } catch(e){ nui = null; }
    }
    if(nui){
      // under the My island / The Commons button (or under Return to HQ where there is none)
      goBtn = document.createElement("button"); goBtn.type = "button"; goBtn.className = "hq3d-home hq3d-goto";
      goBtn.style.top = ui ? "92px" : "52px"; goBtn.textContent = "🧭 Go to (N)"; goBtn.title = "Find a place and get directions";
      goBtn.addEventListener("click", function(){ nui.toggle(); });
      c.el.appendChild(goBtn);
    }
    navKeyFn = navKey;
    window.addEventListener("keydown", navKeyFn, true); window.addEventListener("keyup", navKeyFn, true);
    overlays(!c.active || c.active(w));                    // built before you arrive: shown by onEnter
  }
  // in another floor (the Lobby, your Base) the City's overlays are hidden
  function overlays(on){
    [mm && mm.el, nui && nui.root, goBtn, ui, statsEl].forEach(function(el){ if(el && el.style){ el.hidden = !on; el.style.display = on ? "" : "none"; } });
    if(!on){ closeMenu(); if(nui) nui.close(); }
  }
  w.onLeave = function(){ overlays(false); };
  w.onEnter = function(){ overlays(true); };
  w.mapWaypoint = function(x, z){ return navPick(x, z); };
  // for tests and tools: the route as it stands
  w.nav = function(){ return {route: route ? {x: route.x, z: route.z, label: route.label, kind: route.kind, mode: route.mode, done: route.done, R: route.R} : null,
                              minimap: mm, ui: nui, fx: fx, places: W && HQV.hqnav ? navPlaces : null, goTo: navTo, clear: navClear, step: navStep}; };
  function navDestroy(){
    if(navKeyFn){ window.removeEventListener("keydown", navKeyFn, true); window.removeEventListener("keyup", navKeyFn, true); navKeyFn = null; }
    if(mm){ try { mm.destroy(); } catch(e){} mm = null; }
    if(nui){ try { nui.destroy(); } catch(e){} nui = null; }
    if(fx){ try { fx.dispose(); } catch(e){} fx = null; }
    if(goBtn && goBtn.parentNode) goBtn.parentNode.removeChild(goBtn);
    goBtn = null; route = null;
  }

  /* ---------- loading: the world doc, then every tile drawable ---------- */
  function setup(doc){
    if(dead) throw new Error("world unavailable: closed");     // hq3d gave up on us (timeout): build nothing
    W = doc;
    // landmarks and the park claim their lots and block before anything indexes or builds the world
    if(V2 && HQV.hqSpectacle) try { HQV.hqSpectacle.claim(W, tier); } catch(e){}
    indexBuildings();
    wb = HQV.worldbuild.create(c, W, V2 ? {scene: S, quality: 2, tier: tier, gap: !!(HQV.hqBridges && W.river)} : {scene: S, quality: 2});
    S.add(wb.root); S.add(staticG); S.add(hqG);
    if(V2 && HQV.hqSpectacle && W.spectacle) try {
      spx = HQV.hqSpectacle.create(c, W, {scene: S, ground: groundY, owner: owner, night: night, say: say, avatar: function(){ return c.avatar(); },
        city: function(){ return cityState; }, post: postJson});
    } catch(e){ spx = null; }
    if(V2 && HQV.hqWeather) try { wx = HQV.hqWeather.create(c, {scene: S, world: worldId, say: say, ground: groundY}); wx.setNight(night); } catch(e){ wx = null; }
    buildStatic();
    if(V2) citiesSetup();
    build();
    navSetup();
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
    if(spx){ spx.destroy(); spx = null; }
    if(wx){ wx.destroy(); wx = null; }
    if(wb){ wb.destroy(); wb = null; }
    S.remove(staticG); S.remove(hqG);
    citiesDestroy();
    navDestroy();
  };

  /* ---------- the world contract ---------- */
  // the presence room: per world where the Arena knows rooms per world ("isles"), else the 3D City's
  Object.defineProperty(w, "net", {get: function(){ return V2 ? netRoom(worldId, !!(api.netCan && api.netCan("isles"))) : "city3d"; },
    configurable: true});
  w.world = function(){ return worldId; };
  // Riding in the park (games/hqspectacle.js) comes first: it holds you in your seat and owns the camera.
  (function(){
    var carry0 = w.carry, cam0 = w.camPose, use0 = w.use;
    w.carry = function(){ var p = spx && spx.carry(); return p || (carry0 ? carry0.apply(w, arguments) : null); };
    w.camPose = function(){ var p = spx && spx.camPose(); return p || (cam0 ? cam0.apply(w, arguments) : null); };
    w.use = function(p){ if(spx && spx.use(p)) return true; return use0 ? use0.apply(w, arguments) : false; };
    // for tools and tests: what the park and the weather are doing
    w.spectacle = function(){ return spx; };
    w.weather = function(){ return wx; };
  })();
  w.hits = hits; w.doors = doors; w.span = 18; w.zoom = 0.8; w.camY = 2.5; w.follow = 1; w.camPitch = 0.72;
  w.bounds = [-1018, 1018, -1018, 1018];
  w.camModes = ["map", "far", "chase", "near", "fp", "classic", "photo", "cine"];
  w.startMode = "chase";           // the full 3D map view is heavy: M grows the minimap instead (w.bigMap)
  w.bigMap = function(){ if(!mm) return false; mm.expand(); return true; };
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
    civics.forEach(function(B){ B.setNight(n); }); if(oc) oc.setTime(n); if(rail) rail.setNight(n);
    if(air) air.setNight(n);                                               // air:
    if(spx) spx.setNight(n); if(wx) wx.setNight(n); wxKey = ""; };
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
    if(V2) ferryStep(t, dt);
    if(V2) bridgesStep(dt);
    if(V2) airStep(t, dt);                                                                // AIR
    if(V2) bigStep(t, dt);                                                                              // big ships
    if(rail) rail.update(t, dt, cam);                     // rail
    if(spx) spx.update(t, dt, cam);
    if(wx) weatherApply(wx.update(t, dt, cam));
    navStep(dt, cam);
  };
  // The weather dims the sun and the sky light, pulls the fog in and tints it, leans the sky to its overcast and
  // lights everything for a moment under lightning; the sky is repainted only when how it looks changes.
  function weatherApply(wl){
    if(!wl) return;
    var f = wl.flash || 0, base = night ? 0x0f1f30 : 0xb8dcf2, tint = night ? HQV.hqWeather.lerpHex(wl.tint, 0, 0.84) : wl.tint;
    hemi.intensity = (night ? 1.3 : 2.4)*(1 - wl.dim*0.45) + f*3.5;
    sun.intensity = (night ? 0.7 : 2.4)*(1 - wl.dim*0.85) + f*1.2;
    fog.near = wl.fogNear; fog.far = Math.max(wl.fogFar, wl.fogNear + 40);
    fog.color.setHex(HQV.hqWeather.lerpHex(base, tint, wl.tintK));
    if(f > 0.05) fog.color.lerp(new THREE.Color(0xdfe8ff), f*0.45);
    var key = (night ? "n" : "d") + Math.round(wl.tintK*40) + ":" + wl.tint + ":" + Math.round(f*10) + ":" + (wl.cloud > 0.75 ? 1 : 0);
    if(key !== wxKey){ wxKey = key; paintSky(night, wl); }
  }
  w.setTime(night);
  return w;
};
})();
