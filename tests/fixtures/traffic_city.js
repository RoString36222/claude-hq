// A synthetic organic-style WorldDoc v2 for tests/test_traffic.py (games/traffic.js): a jittered 7 x 7 road
// grid, 200 m apart (cm, integer), arterials on the even rows and columns, the outer ring only from tier 3;
// a tier-2 bus loop round the centre and a tier-4 tram out and back along row 4, with their stops; fire,
// clinic and police stations. city(seed, n) -> doc; n (odd, default 7) grows the grid for the 200-car load test.
function city(seed, n){
  seed = seed | 0;
  function jit(i, k){ var h = Math.imul(i*7919 + k*104729 + seed*31337, 2654435761) >>> 0; return (h % 3001) - 1500; }
  var N = n > 7 ? n | 1 : 7, S = 20000, M = (N - 1) >> 1, nodes = [], edges = [], sites = [];
  function id(r, c){ return r*N + c; }
  for(var r = 0; r < N; r++) for(var c = 0; c < N; c++)
    nodes.push({id: id(r, c), x: (c - M)*S + jit(id(r, c), 1), y: 0, z: (r - M)*S + jit(id(r, c), 2)});
  function edge(a, b, art, tier){
    var A = nodes[a], B = nodes[b], mx = (A.x + B.x) >> 1, mz = (A.z + B.z) >> 1, bend = jit(a*N*N + b, 3) >> 1;
    var dx = B.x - A.x, dz = B.z - A.z, l = Math.round(Math.sqrt(dx*dx + dz*dz));
    var m = [mx + Math.round(-dz*bend/l), 0, mz + Math.round(dx*bend/l)];
    var e = {id: edges.length, a: a, b: b, "class": art ? "arterial" : "local", width: art ? 1600 : 900, walk: art ? 250 : 150,
             lanes: 1, name: "R" + edges.length, points: [[A.x, 0, A.z], m, [B.x, 0, B.z]]};
    if(tier > 1) e.min_tier = tier;
    edges.push(e);
  }
  for(r = 0; r < N; r++) for(c = 0; c < N; c++){
    if(c + 1 < N) edge(id(r, c), id(r, c + 1), r % 2 === 0, (r === 0 || r === N - 1) ? 3 : 1);
    if(r + 1 < N) edge(id(r, c), id(r + 1, c), c % 2 === 0, (c === 0 || c === N - 1) ? 3 : 1);
  }
  function mid(a, b, side){
    var A = nodes[a], B = nodes[b], e = edges.filter(function(x){ return (x.a === a && x.b === b) || (x.a === b && x.b === a); })[0];
    var m = e.points[1], dx = B.x - A.x, dz = B.z - A.z, l = Math.sqrt(dx*dx + dz*dz);
    return {x: Math.round(m[0] - dz/l*side), z: Math.round(m[2] + dx/l*side)};
  }
  var loop = [id(2, 2), id(2, 3), id(2, 4), id(3, 4), id(4, 4), id(4, 3), id(4, 2), id(3, 2), id(2, 2)], bstops = [];
  for(var i = 0; i + 1 < loop.length; i++){
    var p = mid(loop[i], loop[i + 1], 800), sid = "busstop:" + i;
    sites.push({id: sid, kind: "busstop", tier: 2, x: p.x, y: 0, z: p.z, w: 300, d: 600}); bstops.push(sid);
  }
  var tpath = [id(4, 1), id(4, 2), id(4, 3), id(4, 4), id(4, 5)], tstops = [];
  for(i = 0; i + 1 < tpath.length; i += 2){
    var q = mid(tpath[i], tpath[i + 1], 0), tid = "tramstop:" + i;
    sites.push({id: tid, kind: "tramstop", tier: 4, x: q.x, y: 0, z: q.z, w: 300, d: 2000}); tstops.push(tid);
  }
  sites.push({id: "fire:0", kind: "fire", tier: 1, x: nodes[id(1, 1)].x + 1500, y: 0, z: nodes[id(1, 1)].z + 1500, w: 2000, d: 2000});
  sites.push({id: "clinic:0", kind: "clinic", tier: 1, x: nodes[id(5, 5)].x - 1500, y: 0, z: nodes[id(5, 5)].z - 1500, w: 2000, d: 2000});
  sites.push({id: "police:0", kind: "police", tier: 2, x: nodes[id(1, 5)].x - 1500, y: 0, z: nodes[id(1, 5)].z + 1500, w: 2000, d: 2000});
  sites.push({id: "transit:0", kind: "transit", tier: 2, x: nodes[id(3, 3)].x, y: 0, z: nodes[id(3, 3)].z, w: 3000, d: 3000});
  return {id: "test:traffic@2", seed: "traffic", version: 2, profile: "commons", size_cm: 160000,
          layers: {roads: {nodes: nodes, edges: edges}, sites: sites,
                   transit: {lines: [{id: "B1", kind: "bus", tier: 2, stops: bstops, path: loop},
                                     {id: "T1", kind: "tram", tier: 4, stops: tstops, path: tpath}]}},
          hashes: {world: "test"}};
}
if(typeof module !== "undefined") module.exports = city;
