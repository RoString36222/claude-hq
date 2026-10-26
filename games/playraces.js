/* Claude HQ: City play, street races and checkpoint runs (HQ 3.22). Registers with HQV.cityPlay (games/cityplay.js).
 *
 * Eight to twelve routes per world, a pure function of (W, its seed, the City's tier): sprints from A to B on the
 * city's own streets (never the ring or the highway), one highway sprint (where the world has fast roads), circuits of
 * two or three laps and short time trials on foot or by bike. Checkpoints sit on road centrelines, about every 200 m
 * (trials: 100 m). Routes never avoid the week's market, parade or roadworks (citylife.closed): those are part of it.
 *
 *   Start: a small chequered gantry at each start. In a vehicle, stop under it (1 s) and the 3-2-1 begins; on foot, E.
 *   Run: the next checkpoint (a gold ring) and the one after (blue) are drawn, the City's route leads to the next; a
 *        checkpoint counts when you pass within CP_R (25 m) of it, else it stays the next one (and the run can't end).
 *        Timer and split against your best on the HUD; your best run's ghost (or one loaded with loadGhost) drives
 *        alongside you, a translucent car.
 *   Store (ctx.store, this browser only): "races:<seed>:best:<id>" {t, splits, at}, "races:<seed>:ghost:<id>" a
 *        compressed ghost (encodeGhost: one sample every GHOST_DT s, decimetres and centiradians, delta-coded base 36).
 *
 * Feature (HQV.cityPlay.live().feature("races")): routes() -> [summary], start(id), cancel(), setRoute(id) (a waypoint
 *   to its start), best(id) -> {t, splits, at} | null, ghost(id) -> [{t, x, z, yaw}] | null,
 *   loadGhost(id, samples | encoded, label) (race someone else's run), state() -> {phase, id, t, next, ...}.
 * Emits ctx.emit("race", {id, state: "armed" | "countdown" | "start" | "checkpoint" | "finish" | "abandon", time, ...}).
 * Pure (node-tested, tests/test_play_races.py): HQV.playRaces = {plan, encodeGhost, decodeGhost, fmt, ghostAt, CP_R, ...}.
 * A phone app "Races" lists them with best times and a Set route button. Nothing leaves the machine.
 */
(function(){
"use strict";
var root = typeof window !== "undefined" ? window : self;
var HQV = root.HQV = root.HQV || {};
function WQ(){ return HQV.world; }

var CP_R = 25;           // m: a checkpoint counts when you pass this close to it
var START_R = 11;        // m from a start: you are at it
var HOLD_S = 1;          // s stopped at a start in a vehicle before the countdown
var COUNT_S = 3;         // s of 3-2-1
var FALSE_M = 8;         // m moved during the countdown: a false start
var LOST_M = 900;        // m from the next checkpoint: the run is abandoned
var GHOST_DT = 0.2;      // s between ghost samples
var GHOST_MAX = 4000;    // samples kept (over 13 minutes)
var SPACING = 200, TRIAL_SPACING = 100, LEAD = 12;

function cm(v){ return (+v || 0)/100; }
function hashStr(s){ var h = 2166136261 >>> 0; s = String(s == null ? "" : s); for(var i = 0; i < s.length; i++){ h ^= s.charCodeAt(i); h = Math.imul(h, 16777619) >>> 0; } return h >>> 0; }
function mulberry32(a){ a = a >>> 0; return function(){ a = (a + 0x6D2B79F5) >>> 0; var t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0)/4294967296; }; }
function wrapA(a){ a = +a || 0; while(a > Math.PI) a -= 2*Math.PI; while(a < -Math.PI) a += 2*Math.PI; return a; }
function fmt(t){
  t = Math.max(0, +t || 0);
  var m = Math.floor(t/60), s = t - m*60, ss = s.toFixed(1);
  if(s < 10) ss = "0" + ss;
  return m + ":" + ss;
}
function fmtSplit(d){ d = +d || 0; return (d < 0 ? "-" : "+") + Math.abs(d).toFixed(1); }

/* ---------- the road graph ---------- */
function roadKind(cls){
  if(HQV.cityLife && HQV.cityLife.road) return HQV.cityLife.road(cls).kind;
  return /highway|ring|express|ramp|flyover|underpass/.test(String(cls)) ? "fast" : "main";
}
function graph(W, tier){
  var nodes = {}, adj = {}, edges = [];
  (W.nodes || []).forEach(function(n){ nodes[n.id] = {x: cm(n.x), z: cm(n.z)}; });
  (W.edges || []).forEach(function(e){
    if(tier != null && e.min_tier != null && (e.min_tier | 0) > tier) return;
    if(!nodes[e.a] || !nodes[e.b] || e.a === e.b) return;
    var p = e.pts || [], P = [];
    for(var i = 0; i + 2 < p.length; i += 3) P.push({x: p[i]/100, z: p[i + 2]/100});
    if(P.length < 2) return;
    var len = 0;
    for(i = 1; i < P.length; i++) len += Math.hypot(P[i].x - P[i - 1].x, P[i].z - P[i - 1].z);
    if(len < 1) return;
    var E = {id: e.id, a: e.a, b: e.b, P: P, len: len, kind: roadKind(e.cls), name: e.name || "", half: cm(e.width)/2 - cm(e.walk)};
    edges.push(E);
    (adj[e.a] = adj[e.a] || []).push({E: E, to: e.b, fwd: true});
    (adj[e.b] = adj[e.b] || []).push({E: E, to: e.a, fwd: false});
  });
  Object.keys(adj).forEach(function(k){ adj[k].sort(function(a, b){ return a.E.id - b.E.id || (a.fwd ? 0 : 1) - (b.fwd ? 0 : 1); }); });
  return {nodes: nodes, adj: adj, edges: edges};
}
// a walk out of node s, never back through a node, weighted by w(step); stops at len >= target
function walk(G, s, rnd, target, w){
  var seen = {}, steps = [], node = s, len = 0;
  seen[s] = true;
  for(var n = 0; n < 200 && len < target; n++){
    var opts = (G.adj[node] || []).filter(function(o){ return !seen[o.to]; }), tot = 0;
    var ws = opts.map(function(o){ var x = Math.max(0, w(o, steps)); tot += x; return x; });
    if(!(tot > 0)) break;
    var u = rnd()*tot, k = 0;
    for(; k < opts.length - 1; k++){ u -= ws[k]; if(u < 0) break; }
    var o = opts[k];
    steps.push(o); seen[o.to] = true; node = o.to; len += o.E.len;
  }
  return {steps: steps, len: len, end: node, seen: seen};
}
// the shortest way from a to b (Dijkstra), edges in avoid cost x20, nodes in ban never entered (but b)
function shortest(G, a, b, avoid, ban){
  var dist = {}, prev = {}, heap = [[0, a]], done = {};
  dist[a] = 0;
  function push(it){ heap.push(it); var i = heap.length - 1; while(i > 0){ var p = (i - 1) >> 1; if(heap[p][0] <= heap[i][0]) break; var t = heap[p]; heap[p] = heap[i]; heap[i] = t; i = p; } }
  function pop(){
    var top = heap[0], last = heap.pop();
    if(heap.length){ heap[0] = last; var i = 0; for(;;){ var l = 2*i + 1, r = l + 1, m = i; if(l < heap.length && heap[l][0] < heap[m][0]) m = l; if(r < heap.length && heap[r][0] < heap[m][0]) m = r; if(m === i) break; var t = heap[m]; heap[m] = heap[i]; heap[i] = t; i = m; } }
    return top;
  }
  heap = []; push([0, a]);
  while(heap.length){
    var it = pop(), node = it[1];
    if(done[node]) continue;
    done[node] = true;
    if(String(node) === String(b)) break;
    (G.adj[node] || []).forEach(function(o){
      if(ban && ban[o.to] && String(o.to) !== String(b)) return;
      var c = it[0] + o.E.len*(avoid && avoid[o.E.id] ? 20 : 1) + (o.E.kind === "fast" ? o.E.len*3 : 0);
      if(dist[o.to] == null || c < dist[o.to]){ dist[o.to] = c; prev[o.to] = o; push([c, o.to]); }
    });
  }
  if(!done[b]) return null;
  var steps = [], cur = b;
  while(String(cur) !== String(a)){ var o = prev[cur]; if(!o) return null; steps.unshift(o); cur = o.fwd ? o.E.a : o.E.b; }
  return steps;
}
function polyOf(steps){
  var P = [];
  steps.forEach(function(o){
    var Q = o.fwd ? o.E.P : o.E.P.slice().reverse();
    for(var i = 0; i < Q.length; i++){
      var q = Q[i], l = P[P.length - 1];
      if(l && Math.hypot(l.x - q.x, l.z - q.z) < 0.05) continue;
      P.push({x: q.x, z: q.z, half: o.E.half});
    }
  });
  return P;
}
function cumOf(P){ var c = [0]; for(var i = 1; i < P.length; i++) c.push(c[i - 1] + Math.hypot(P[i].x - P[i - 1].x, P[i].z - P[i - 1].z)); return c; }
function pointAt(P, C, s){
  var L = C[C.length - 1]; s = Math.max(0, Math.min(L, s));
  var k = 0; while(k < P.length - 2 && C[k + 1] < s) k++;
  var a = P[k], b = P[k + 1], sl = C[k + 1] - C[k] || 1, t = (s - C[k])/sl;
  return {x: a.x + (b.x - a.x)*t, z: a.z + (b.z - a.z)*t, yaw: Math.atan2(b.x - a.x, b.z - a.z), half: Math.max(a.half || 0, b.half || 0)};
}
function gate(p){ return {x: +p.x.toFixed(2), z: +p.z.toFixed(2), yaw: +p.yaw.toFixed(3), w: +Math.max(6, Math.min(16, (p.half || 5) + 2)).toFixed(2)}; }

var KINDN = {sprint: "Sprint", circuit: "Circuit", trial: "Time trial"};
function nameOf(kind, steps, hw){
  var names = steps.map(function(o){ return o.E.name; }).filter(function(n){ return n; });
  var a = names[0] || "the Commons", b = names[names.length - 1] || "the edge of town";
  if(hw) return "Highway sprint: " + a;
  if(kind === "circuit") return a + " Circuit";
  if(kind === "trial") return a + " time trial";
  return a === b ? a + " sprint" : a + " to " + b;
}

// one route from a list of steps: {id, kind, name, mode, laps, lap, len, start, cps, edges, highway}
function routeOf(kind, steps, laps, spacing, hw){
  var P = polyOf(steps), C = cumOf(P), L = C[C.length - 1];
  if(P.length < 2 || L < 2*LEAD) return null;
  var cps = [], st = pointAt(P, C, LEAD);
  if(kind === "circuit"){
    var m = Math.max(3, Math.round(L/spacing));
    for(var lap = 0; lap < laps; lap++) for(var j = 1; j <= m; j++){
      var s = LEAD + j*L/m; if(s > L) s -= L;
      var g = gate(pointAt(P, C, s)); g.lap = lap + 1; cps.push(g);
    }
  } else {
    var run = L - LEAD, n = Math.max(2, Math.round(run/spacing));
    for(var i = 1; i <= n; i++){ var g2 = gate(pointAt(P, C, LEAD + i*run/n)); g2.lap = 1; cps.push(g2); }
  }
  var ids = steps.map(function(o){ return o.E.id; });
  var len = kind === "circuit" ? L*laps : L - LEAD;
  return {id: kind + "-" + (hashStr(kind + ":" + laps + ":" + ids.join(",")) % 1679616).toString(36),
    kind: kind, name: nameOf(kind, steps, hw), mode: kind === "trial" ? "foot" : "drive", laps: kind === "circuit" ? laps : 1,
    lap: Math.round(kind === "circuit" ? L : L - LEAD), len: Math.round(len), highway: !!hw,
    start: gate(st), cps: cps, edges: ids};
}

var PLAN = typeof WeakMap === "function" ? new WeakMap() : null;
function plan(W, seed, tier){
  if(!W) return [];
  var key = String(seed) + ":" + (tier == null ? "all" : tier), memo = PLAN && PLAN.get(W);
  if(memo && memo[key]) return memo[key];
  var G = graph(W, tier), rnd = mulberry32(hashStr("races:" + seed)), out = [];
  var ids = Object.keys(G.adj).filter(function(k){ return G.adj[k].length; }).sort(function(a, b){ return (+a) - (+b) || (a < b ? -1 : 1); });
  if(!ids.length) return [];
  function farFromOthers(r){ return out.every(function(o){ return Math.hypot(o.start.x - r.start.x, o.start.z - r.start.z) > 150 && o.id !== r.id; }); }
  function pickNode(pred){
    for(var t = 0; t < 40; t++){ var id = ids[Math.floor(rnd()*ids.length)]; if(!pred || pred(id)) return id; }
    return ids[Math.floor(rnd()*ids.length)];
  }
  var notFast = function(o){ return o.E.kind === "fast" ? 0.02 : o.E.kind === "main" ? 1.4 : 1; };
  function tryAdd(r){ if(r && farFromOthers(r)){ out.push(r); return true; } return false; }
  // 1. the highway sprint: along the fast roads
  var fastNodes = ids.filter(function(k){ return G.adj[k].some(function(o){ return o.E.kind === "fast"; }); });
  for(var t1 = 0; t1 < 30 && fastNodes.length; t1++){
    var s1 = fastNodes[Math.floor(rnd()*fastNodes.length)], w1 = walk(G, s1, rnd, 1500 + rnd()*1500, function(o){ return o.E.kind === "fast" ? 1 : 0.01; });
    var fl = 0; w1.steps.forEach(function(o){ if(o.E.kind === "fast") fl += o.E.len; });
    if(w1.len >= 1000 + LEAD && w1.len <= 4000 && fl >= 0.6*w1.len && tryAdd(routeOf("sprint", w1.steps, 1, SPACING, true))) break;
  }
  // 2. sprints on the city's streets
  var want = {sprint: 5, circuit: 3, trial: 2}, got = {sprint: 0, circuit: 0, trial: 0};
  for(var t2 = 0; t2 < 80 && got.sprint < want.sprint; t2++){
    var w2 = walk(G, pickNode(), rnd, 1000 + rnd()*2400, notFast);
    var fast2 = w2.steps.some(function(o){ return o.E.kind === "fast"; });
    if(w2.len >= 1000 + LEAD && w2.len <= 4000 && !fast2 && tryAdd(routeOf("sprint", w2.steps, 1, SPACING))) got.sprint++;
  }
  // 3. circuits: out along one way, back along another to the start
  for(var t3 = 0; t3 < 120 && got.circuit < want.circuit; t3++){
    var s3 = pickNode(), lapT = 550 + rnd()*800, w3 = walk(G, s3, rnd, lapT/2, notFast);
    if(w3.steps.length < 2) continue;
    var used = {}, ban = {};
    w3.steps.forEach(function(o){ used[o.E.id] = true; });
    Object.keys(w3.seen).forEach(function(k){ if(String(k) !== String(s3) && String(k) !== String(w3.end)) ban[k] = true; });
    var back = shortest(G, w3.end, s3, used, ban);
    if(!back || !back.length) continue;
    var all = w3.steps.concat(back), lapL = 0, twice = false, ue = {};
    all.forEach(function(o){ lapL += o.E.len; if(ue[o.E.id]) twice = true; ue[o.E.id] = true; });
    if(twice || all.some(function(o){ return o.E.kind === "fast"; })) continue;
    var laps = lapL*3 <= 4000 ? 3 : 2;
    if(lapL*laps < 1000 || lapL*laps > 4000) continue;
    if(tryAdd(routeOf("circuit", all, laps, SPACING))) got.circuit++;
  }
  // 4. time trials on foot or by bike: short, on quiet streets
  for(var t4 = 0; t4 < 80 && got.trial < want.trial; t4++){
    var w4 = walk(G, pickNode(), rnd, 450 + rnd()*450, function(o){ return o.E.kind === "fast" ? 0 : o.E.kind === "main" ? 0.4 : 1.5; });
    if(w4.len >= 400 && w4.len <= 1100 && tryAdd(routeOf("trial", w4.steps, 1, TRIAL_SPACING))) got.trial++;
  }
  // (a world with too few: relax the spacing between starts)
  for(var t5 = 0; t5 < 60 && out.length < 8; t5++){
    var w5 = walk(G, pickNode(), rnd, 1000 + rnd()*1500, notFast);
    var r5 = w5.len >= 1000 + LEAD && w5.len <= 4000 ? routeOf("sprint", w5.steps, 1, SPACING) : null;
    if(r5 && out.every(function(o){ return o.id !== r5.id && Math.hypot(o.start.x - r5.start.x, o.start.z - r5.start.z) > 40; })) out.push(r5);
  }
  out = out.slice(0, 12);
  if(PLAN){ if(!memo){ memo = {}; PLAN.set(W, memo); } memo[key] = out; }
  return out;
}

/* ---------- ghosts ---------- */
// samples [{x, z, yaw}] (one per GHOST_DT s) -> "g1:" + base-36 deltas of decimetres and centiradians
function encodeGhost(samples){
  var o = [], px = 0, pz = 0, py = 0;
  (samples || []).slice(0, GHOST_MAX).forEach(function(s){
    if(!s) return;
    var x = Math.round((+(s.x != null ? s.x : s[0]) || 0)*10), z = Math.round((+(s.z != null ? s.z : s[1]) || 0)*10), y = Math.round(wrapA(s.yaw != null ? s.yaw : s[2])*100);
    var dy = y - py; if(dy > 314) dy -= 628; else if(dy < -314) dy += 628;
    o.push((x - px).toString(36), (z - pz).toString(36), dy.toString(36));
    px = x; pz = z; py = y;
  });
  return "g1:" + o.join(",");
}
function decodeGhost(str){
  if(Array.isArray(str)) return str.slice(0, GHOST_MAX).map(function(s, i){
    s = s || {};
    var x = +(s.x != null ? s.x : s[0]), z = +(s.z != null ? s.z : s[1]), y = +(s.yaw != null ? s.yaw : s[2]);
    return {t: +(i*GHOST_DT).toFixed(2), x: isFinite(x) ? x : 0, z: isFinite(z) ? z : 0, yaw: isFinite(y) ? wrapA(y) : 0};
  });
  if(typeof str !== "string" || str.slice(0, 3) !== "g1:") return null;
  var a = str.slice(3) ? str.slice(3).split(",") : [], out = [], x = 0, z = 0, y = 0;
  for(var i = 0; i + 2 < a.length && out.length < GHOST_MAX; i += 3){
    var dx = parseInt(a[i], 36), dz = parseInt(a[i + 1], 36), dy = parseInt(a[i + 2], 36);
    if(!isFinite(dx) || !isFinite(dz) || !isFinite(dy)) return null;
    x += dx; z += dz; y += dy;
    out.push({t: +(out.length*GHOST_DT).toFixed(2), x: x/10, z: z/10, yaw: wrapA(y/100)});
  }
  return out;
}
// where a ghost is t s into its run (null after its end)
function ghostAt(G, t){
  if(!G || !G.length || !(t >= 0)) return null;
  var f = t/GHOST_DT, i = Math.floor(f);
  if(i >= G.length - 1) return null;
  var a = G[i], b = G[i + 1], k = f - i;
  return {x: a.x + (b.x - a.x)*k, z: a.z + (b.z - a.z)*k, yaw: a.yaw + wrapA(b.yaw - a.yaw)*k};
}
// distance from c to the segment a-b
function segDist(a, b, c){
  var dx = b.x - a.x, dz = b.z - a.z, l2 = dx*dx + dz*dz, t = l2 > 0 ? ((c.x - a.x)*dx + (c.z - a.z)*dz)/l2 : 0;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(a.x + dx*t - c.x, a.z + dz*t - c.z);
}

/* ---------- the feature ---------- */
function create(ctx){
  var W = ctx.W, THREE = ctx.THREE, S = ctx.scene;
  var R = plan(W, ctx.seed, ctx.tier), byId = {};
  R.forEach(function(r){ byId[r.id] = r; });
  var K = "races:" + ctx.seed + ":";
  var st = {phase: "idle", id: null, t: 0, hold: 0, count: 0, next: 0, splits: [], rec: [], recT: 0, last: null, lostT: 0, offT: 0, endT: 0, armed: null, rival: {}};
  var me = null, mo = null, lastMs = 0;
  var g = null, ringCur = null, ringNext = null, ghostM = null, gantries = [];

  function vehicle(m){ return !!(m && m.ride && !m.air && !m.boat); }
  function footOk(m){ return !m || !m.ride || /bike|skate|board|scooter/.test(String(m.ride)); }
  function fits(r, m){ return r.mode === "foot" ? footOk(m) && !(m && (m.air || m.boat)) : vehicle(m); }
  function bestOf(id){ var b = ctx.store.get(K + "best:" + id, null); return b && typeof b === "object" && +b.t > 0 ? b : null; }
  function ghostOf(id){ var s = ctx.store.get(K + "ghost:" + id, null); return typeof s === "string" ? decodeGhost(s) : null; }

  /* ----- drawing (only with THREE and a scene) ----- */
  if(THREE && S){
    g = new THREE.Group(); g.name = "cityplay-races"; S.add(g);
    // the gantries: posts and a chequered banner, two InstancedMeshes for every start
    var n = R.length, chk = new Uint8Array(16*2*4);
    for(var y = 0; y < 2; y++) for(var x = 0; x < 16; x++){ var on = (x + y) % 2 === 0, k = 4*(y*16 + x); chk[k] = chk[k + 1] = chk[k + 2] = on ? 240 : 24; chk[k + 3] = 255; }
    var tex = new THREE.DataTexture(chk, 16, 2, THREE.RGBAFormat); tex.magFilter = THREE.NearestFilter; tex.minFilter = THREE.NearestFilter; tex.needsUpdate = true;
    var posts = new THREE.InstancedMesh(new THREE.BoxGeometry(0.35, 6, 0.35), new THREE.MeshLambertMaterial({color: 0x2a2f38}), Math.max(1, 2*n));
    var flags = new THREE.InstancedMesh(new THREE.BoxGeometry(1, 1.2, 0.12), new THREE.MeshBasicMaterial({map: tex}), Math.max(1, n));
    var m4 = new THREE.Matrix4(), q = new THREE.Quaternion(), e3 = new THREE.Euler(), v3 = new THREE.Vector3(), sc = new THREE.Vector3();
    R.forEach(function(r, i){
      var s0 = r.start, gy = ctx.groundY(s0.x, s0.z), lx = Math.cos(s0.yaw), lz = -Math.sin(s0.yaw), hw = s0.w + 0.6;
      q.setFromEuler(e3.set(0, s0.yaw, 0));
      [-1, 1].forEach(function(sg, j){ m4.compose(v3.set(s0.x + lx*hw*sg, gy + 3, s0.z + lz*hw*sg), q, sc.set(1, 1, 1)); posts.setMatrixAt(2*i + j, m4); });
      m4.compose(v3.set(s0.x, gy + 5.6, s0.z), q, sc.set(2*hw, 1, 1)); flags.setMatrixAt(i, m4);
      gantries.push({x: s0.x, z: s0.z});
    });
    posts.count = 2*n; flags.count = n;
    posts.instanceMatrix.needsUpdate = true; flags.instanceMatrix.needsUpdate = true;
    g.add(posts); g.add(flags);
    var ringG = new THREE.TorusGeometry(1, 0.06, 8, 48);
    ringCur = new THREE.Mesh(ringG, new THREE.MeshBasicMaterial({color: 0xffd040, transparent: true, opacity: 0.85, depthWrite: false}));
    ringNext = new THREE.Mesh(ringG, new THREE.MeshBasicMaterial({color: 0x5fd3e6, transparent: true, opacity: 0.4, depthWrite: false}));
    ringCur.visible = ringNext.visible = false; g.add(ringCur); g.add(ringNext);
    ghostM = new THREE.Group(); ghostM.visible = false;
    var gmat = new THREE.MeshBasicMaterial({color: 0x9fd8ff, transparent: true, opacity: 0.33, depthWrite: false});
    var body = new THREE.Mesh(new THREE.BoxGeometry(1.9, 0.8, 4.3), gmat); body.position.y = 0.7; ghostM.add(body);
    var cab = new THREE.Mesh(new THREE.BoxGeometry(1.6, 0.6, 2.2), gmat); cab.position.set(0, 1.4, -0.2); ghostM.add(cab);
    var walker = new THREE.Mesh(new THREE.CylinderGeometry(0.3, 0.3, 1.7, 10), gmat); walker.position.y = 0.85; walker.visible = false; ghostM.add(walker);
    ghostM.userData = {body: body, cab: cab, walker: walker};
    g.add(ghostM);
  }
  function placeRing(m, cp){
    if(!m) return;
    if(!cp){ m.visible = false; return; }
    var gy = ctx.groundY(cp.x, cp.z);
    m.position.set(cp.x, gy + cp.w*0.82, cp.z); m.rotation.set(0, cp.yaw, 0); m.scale.set(cp.w, cp.w, cp.w*0.6); m.visible = true;
  }
  function showRings(){
    var r = byId[st.id];
    if(!r || st.phase !== "run"){ placeRing(ringCur, null); placeRing(ringNext, null); return; }
    placeRing(ringCur, r.cps[st.next]); placeRing(ringNext, r.cps[st.next + 1] || null);
    if(ringCur) ringCur.material.color.setHex(st.next === r.cps.length - 1 ? 0x7dff8a : 0xffd040);
  }
  function showGhost(){
    if(!ghostM) return;
    var r = byId[st.id], G = r && (st.rival[r.id] ? st.rival[r.id].samples : st.ghost);
    var p = st.phase === "run" && G ? ghostAt(G, st.t) : null;
    if(!p){ ghostM.visible = false; return; }
    ghostM.visible = true;
    var foot = r.mode === "foot", U = ghostM.userData;
    U.body.visible = U.cab.visible = !foot; U.walker.visible = foot;
    ghostM.position.set(p.x, ctx.groundY(p.x, p.z), p.z); ghostM.rotation.set(0, p.yaw, 0);
  }

  /* ----- the run ----- */
  function hud(text, o){ ctx.hud.set("race", text, o); }
  function hudOff(){ ctx.hud.clear("race"); ctx.hud.clear("race2"); }
  function emit(state, extra){ var d = {id: st.id, state: state, time: +st.t.toFixed(2)}; if(extra) for(var k in extra) d[k] = extra[k]; ctx.emit("race", d); }
  function reset(){
    st.phase = "idle"; st.id = null; st.t = 0; st.hold = 0; st.count = 0; st.next = 0; st.splits = []; st.rec = []; st.recT = 0; st.ghost = null; st.lostT = 0; st.offT = 0;
    showRings(); showGhost();
  }
  function countdown(r){
    st.phase = "count"; st.id = r.id; st.count = COUNT_S; st.armed = null; st.from = me ? {x: me.x, z: me.z} : {x: r.start.x, z: r.start.z};
    st.ghost = ghostOf(r.id);
    var b = bestOf(r.id);
    ctx.say(r.name + (b ? ". Your best: " + fmt(b.t) : "") + (st.rival[r.id] ? ". Racing " + st.rival[r.id].label : ""));
    if(HQV.cityLife && HQV.cityLife.closed && lastMs){
      try {
        var cl = HQV.cityLife.closed(W, lastMs), hit = null;
        r.edges.forEach(function(id){ if(cl[id] && !hit) hit = cl[id]; });
        if(hit) ctx.hud.set("race2", "Heads up: " + (hit === "roadworks" ? "roadworks" : hit === "market" ? "the market" : "the parade") + " on this route", {colour: "#ffd27a"});
      } catch(e){}
    }
    emit("countdown", {name: r.name});
  }
  function begin(){
    var r = byId[st.id];
    st.phase = "run"; st.t = 0; st.next = 0; st.splits = []; st.rec = []; st.recT = 0; st.lostT = 0; st.offT = 0;
    st.last = me ? {x: me.x, z: me.z} : {x: r.start.x, z: r.start.z};
    record();
    hud("GO!", {colour: "#7dff8a"});
    showRings(); route();
    emit("start", {name: r.name});
  }
  function route(){ var r = byId[st.id], cp = r && r.cps[st.next]; if(cp) ctx.waypoint(cp.x, cp.z, "Checkpoint " + (st.next + 1)); }
  function record(){ if(me && st.rec.length < GHOST_MAX) st.rec.push({x: me.x, z: me.z, yaw: me.yaw || 0}); }
  function abandon(why){
    var id = st.id;
    if(!id) return;
    emit("abandon", {why: why || ""});
    ctx.say(why || "Race abandoned.");
    hud(why || "Race abandoned", {colour: "#ff9a8a"}); st.endT = 4;
    reset();
  }
  function finish(){
    var r = byId[st.id], t = st.t, b = bestOf(r.id), pb = !b || t < b.t;
    if(pb){
      ctx.store.set(K + "best:" + r.id, {t: +t.toFixed(2), splits: st.splits.map(function(x){ return +x.toFixed(2); }), at: lastMs || 0});
      record();
      ctx.store.set(K + "ghost:" + r.id, encodeGhost(st.rec));
    }
    var line = "Finish " + fmt(t) + (pb ? (b ? "  New best! " + fmtSplit(t - b.t) : "  First time set") : "  Best " + fmt(b.t));
    hud(line, {colour: pb ? "#7dff8a" : "#ffffff"}); ctx.hud.clear("race2"); st.endT = 6;
    ctx.say((pb ? "New best on " : "Finished ") + r.name + ": " + fmt(t));
    emit("finish", {time: +t.toFixed(2), best: +(pb ? t : b.t).toFixed(2), pb: pb, name: r.name});
    reset();
  }
  function step(dt){
    var r = byId[st.id];
    if(st.phase === "count"){
      if(me && st.from && Math.hypot(me.x - st.from.x, me.z - st.from.z) > FALSE_M){ abandon("False start"); return; }
      st.count -= dt;
      if(st.count <= 0){ begin(); return; }
      hud(String(Math.ceil(st.count)), {colour: "#ffd040"});
      return;
    }
    if(st.phase !== "run" || !r) return;
    st.t += dt;
    st.recT += dt;
    while(st.recT >= GHOST_DT){ st.recT -= GHOST_DT; record(); }
    if(!fits(r, mo)){ st.offT += dt; if(st.offT > 3){ abandon(r.mode === "foot" ? "Race abandoned: on foot or by bike only" : "Race abandoned: you left your vehicle"); return; } }
    else st.offT = 0;
    var cur = me ? {x: me.x, z: me.z} : st.last, took = false;
    while(r.cps[st.next] && segDist(st.last, cur, r.cps[st.next]) <= CP_R){
      st.splits.push(st.t); took = true;
      var b = bestOf(r.id), bs = b && b.splits && b.splits[st.next];
      st.next++;
      if(st.next >= r.cps.length){ st.last = cur; finish(); return; }
      emit("checkpoint", {i: st.next, of: r.cps.length, split: bs != null ? +(st.t - bs).toFixed(2) : null});
      if(bs != null) ctx.hud.set("race2", "Split " + fmtSplit(st.t - bs), {colour: st.t - bs <= 0 ? "#7dff8a" : "#ff9a8a"});
    }
    st.last = cur;
    if(took){ showRings(); route(); }
    var cp = r.cps[st.next], d = Math.hypot(cur.x - cp.x, cur.z - cp.z);
    if(d > LOST_M){ st.lostT += dt; if(st.lostT > 5){ abandon("Race abandoned: too far from the route"); return; } } else st.lostT = 0;
    var nx = r.cps[st.next + 1], missed = nx && d > 60 && Math.hypot(cur.x - nx.x, cur.z - nx.z) < d;
    hud((r.laps > 1 ? "Lap " + cp.lap + "/" + r.laps + "  " : "") + "CP " + (st.next + 1) + "/" + r.cps.length + "  " + fmt(st.t) + (missed ? "  Missed a checkpoint: go back" : ""),
        {colour: missed ? "#ff9a8a" : "#ffffff"});
    showGhost();
  }
  function startNear(){
    for(var i = 0; i < R.length; i++){ var r = R[i]; if(me && Math.hypot(me.x - r.start.x, me.z - r.start.z) <= START_R) return r; }
    return null;
  }
  var nearShown = null;
  function idle(dt){
    var r = startNear();
    if(!r){ if(nearShown){ ctx.hud.clear("race"); nearShown = null; } st.hold = 0; return; }
    var b = bestOf(r.id), tail = b ? "  Best " + fmt(b.t) : "";
    if(r.mode === "drive" || (mo && mo.ride)){
      if(!fits(r, mo)){ hud(r.name + ": " + (r.mode === "drive" ? "bring a car or a bike" : "on foot or by bike") + tail); nearShown = r.id; st.hold = 0; return; }
      var sp = mo ? +mo.speed || 0 : 0;
      if(sp < 1.5){ st.hold += dt; if(st.hold >= HOLD_S){ st.hold = 0; nearShown = null; countdown(r); return; } }
      else st.hold = 0;
      hud("Stop under the flag to start: " + r.name + tail); nearShown = r.id;
    } else { hud(r.name + ": press E to start" + tail); nearShown = r.id; }
  }

  return {
    update: function(dt, f){
      f = f || {}; dt = Math.max(0, Math.min(0.5, +dt || 0));
      me = f.me || me; mo = f.motion || null; lastMs = f.local || f.ms || lastMs;
      if(st.endT > 0){ st.endT -= dt; if(st.endT <= 0){ hudOff(); nearShown = null; } }
      if(st.phase === "idle"){ if(!(st.endT > 0)) idle(dt); return; }
      step(dt);
    },
    prompt: function(p){
      if(st.phase !== "idle" || (mo && mo.ride)) return null;
      for(var i = 0; i < R.length; i++){ var r = R[i]; if(r.mode === "foot" && Math.hypot(p.x - r.start.x, p.z - r.start.z) <= START_R) return "E  Start " + r.name; }
      return null;
    },
    use: function(p){
      if(st.phase !== "idle" || (mo && mo.ride)) return false;
      for(var i = 0; i < R.length; i++){ var r = R[i]; if(r.mode === "foot" && Math.hypot(p.x - r.start.x, p.z - r.start.z) <= START_R){ me = me || {x: p.x, z: p.z, yaw: p.yaw || 0}; countdown(r); return true; } }
      return false;
    },
    on: function(kind, d){ if(kind === "teleport" && st.phase !== "idle") abandon(); },
    routes: function(){
      return R.map(function(r){ var b = bestOf(r.id); return {id: r.id, kind: r.kind, kindName: KINDN[r.kind], name: r.name, mode: r.mode, laps: r.laps, len: r.len, highway: r.highway,
        start: {x: r.start.x, z: r.start.z, yaw: r.start.yaw}, cps: r.cps.map(function(c){ return {x: c.x, z: c.z, yaw: c.yaw, w: c.w, lap: c.lap}; }), edges: r.edges.slice(), best: b ? b.t : null}; });
    },
    start: function(id){
      var r = byId[id]; if(!r || st.phase !== "idle") return false;
      if(me && Math.hypot(me.x - r.start.x, me.z - r.start.z) <= START_R){ countdown(r); return true; }
      st.armed = id; ctx.waypoint(r.start.x, r.start.z, r.name); emit("armed", {name: r.name}); return true;
    },
    setRoute: function(id){ var r = byId[id]; if(!r) return false; st.armed = id; ctx.waypoint(r.start.x, r.start.z, r.name); ctx.say("Route set to the start of " + r.name); return true; },
    cancel: function(){ if(st.phase === "idle") return false; abandon("Race cancelled"); return true; },
    best: function(id){ var b = bestOf(id); return b ? {t: b.t, splits: (b.splits || []).slice(), at: b.at || 0} : null; },
    ghost: function(id){ return ghostOf(id); },
    ghostRaw: function(id){ var s = ctx.store.get(K + "ghost:" + id, null); return typeof s === "string" ? s : null; },
    loadGhost: function(id, samples, label){
      if(!byId[id]) return false;
      if(samples == null){ delete st.rival[id]; return true; }
      var G = decodeGhost(samples);
      if(!G || G.length < 2) return false;
      st.rival[id] = {samples: G, label: String(label == null ? "a rival" : label).replace(/[\u0000-\u001f]/g, "").slice(0, 32) || "a rival"};
      return true;
    },
    state: function(){ return {phase: st.phase, id: st.id, t: +st.t.toFixed(2), next: st.next, of: st.id && byId[st.id] ? byId[st.id].cps.length : 0, armed: st.armed}; },
    dispose: function(){
      hudOff();
      if(g && S){ S.remove(g); g.traverse(function(o){ if(o.geometry) o.geometry.dispose(); if(o.material){ if(o.material.map) o.material.map.dispose(); o.material.dispose(); } }); }
      g = null;
    }
  };
}

if(HQV.cityPlay) HQV.cityPlay.register({id: "races", order: 30, create: create});

/* ---------- the phone app ---------- */
var GLYPH = "M5 21V4M5 4h12l-2 4 2 4H5M9 4v8M13 4v8M5 8h12";
function mk(tag, cls, parent, text){
  var e = document.createElement(tag);
  if(cls) e.className = cls;
  if(text != null) e.textContent = String(text);
  if(parent) parent.appendChild(e);
  return e;
}
function feature(){ var L = HQV.cityPlay && HQV.cityPlay.live && HQV.cityPlay.live(); return L ? L.feature("races") : null; }
function renderApp(el){
  var root = mk("div", "hp-app", el), F = feature();
  if(!F){ mk("p", "hp-muted", root, "Races appear when the City is loaded."); return {dispose: function(){}}; }
  var list = F.routes();
  mk("p", "hp-muted", root, list.length + " routes in this city. Stop under a chequered flag to start; on foot, press E. Best times stay on this computer.");
  var ul = mk("ul", "hp-list", root); ul.setAttribute("aria-label", "Races");
  list.forEach(function(r){
    var li = mk("li", "hp-card", ul);
    mk("b", "", li, r.name);
    mk("span", "hp-legsub", li, r.kindName + (r.laps > 1 ? ", " + r.laps + " laps" : "") + ", " + (r.len >= 1000 ? (r.len/1000).toFixed(1) + " km" : r.len + " m") +
       (r.mode === "foot" ? ", on foot or by bike" : r.highway ? ", highway" : ""));
    mk("span", "", li, r.best != null ? "Best " + fmt(r.best) : "No time yet");
    var b = mk("button", "hp-btn hp-primary", li, "Set route");
    b.type = "button"; b.setAttribute("aria-label", "Set route to the start of " + r.name);
    b.addEventListener("click", function(){ var G = feature(); if(G) G.setRoute(r.id); b.textContent = "Route set"; });
  });
  return {dispose: function(){}};
}
(HQV.hqPhoneQueue = HQV.hqPhoneQueue || []).push({id: "races", name: "Races", order: 40, glyph: GLYPH, dock: false, needsCity: true, render: renderApp});

HQV.playRaces = {plan: plan, graph: graph, encodeGhost: encodeGhost, decodeGhost: decodeGhost, ghostAt: ghostAt, fmt: fmt, segDist: segDist,
  CP_R: CP_R, START_R: START_R, HOLD_S: HOLD_S, COUNT_S: COUNT_S, GHOST_DT: GHOST_DT, create: create};
})();
