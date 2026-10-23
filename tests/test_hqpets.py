"""Pets (games/hqpets.js, ui/app/40-pets.js, HQ 3.14; the Arena's half is backend/src/pets.rs and its tests).

One node process loads the vendored three.js and games/hqpets.js against a stub `window` and checks: the roster
against the Arena's (index for index), every species' model within its draw-call and triangle budget, the ice
dragon's look and each dragon's element, names, presence encoding, following (round a corner, never into a wall,
teleporting back), fetch, the idle state machine (deterministic, gentle in Calm), riding along, the lobby API
(spawn, spots by kind, greet, home / out with E), the runtime headless, and the Pet shop on the Commons fixture.
Then the UI wiring by reading the files. Skipped when node is not installed. Stdlib only."""
import json
import os
import re
import shutil
import subprocess
import unittest

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
NODE = shutil.which("node")

HARNESS = r"""
var fs = require("fs"), url = require("url"), zlib = require("zlib"), root = process.argv[1];
import(url.pathToFileURL(root + "/games/vendor/three-module.js").href).then(function(THREE){
  global.window = {HQV: {}};
  ["world", "hqnav", "hqdealer", "hqcasino", "hqpets"].forEach(function(f){ new Function(fs.readFileSync(root + "/games/" + f + ".js", "utf8"))(); });
  var H = window.HQV, P = H.hqPets, out = {};
  out.roster = P.SPECIES.map(function(s){ return [s.id, s.minLevel, s.price, s.saddle, s.grows, s.kind]; });
  out.consts = {MAX_OWNED: P.MAX_OWNED, MAX_ACTIVE: P.MAX_ACTIVE, NAME_MAX: P.NAME_MAX, VARIANTS: P.VARIANTS, ACC_MAX: P.ACC_MAX, STAGE_AT: P.STAGE_AT, BAD: P.BAD_WORDS};
  // ---- models: every species, every variant, all accessories, every stage, posed through every animation ----
  out.models = {};
  var ANIMS = ["stand", "walk", "run", "carry", "sit", "look", "sleep", "sniff", "wag", "groom", "yawn", "shake", "stretch", "stomp", "roar", "breath", "puff",
               "wings", "fly", "swim", "float", "slither", "coil", "spin", "beg", "roll", "big"];
  P.SPECIES.forEach(function(sp){
    var worst = {meshes: 0, tris: 0, drawn: 0}, sizes = [];
    for(var v = 0; v < P.VARIANTS; v++) for(var g = 0; g < 3; g++){
      var M = P.model(THREE, {species: sp.id, variant: v, acc: sp.saddle ? 31 : 23, stage: g, name: "Rex"}), st = P.newState(7, 0, 0, 0);
      ANIMS.forEach(function(a){ st.anim = a; st.ph = 2.1; st.trick = {t: 0.5, dur: 1.6}; P.pose(M, st, 1.3, false); P.pose(M, st, 1.3, true); });
      var n = 0; M.g.traverse(function(o){ if(o.isMesh || o.isInstancedMesh) n++; });
      worst.meshes = Math.max(worst.meshes, M.meshes); worst.drawn = Math.max(worst.drawn, n); worst.tris = Math.max(worst.tris, M.tris);
      if(v === 0) sizes.push(Math.round(M.scale*100)/100);
    }
    var M0 = P.model(THREE, {species: sp.id, variant: 0, acc: 0});
    var finite = true; M0.g.updateMatrixWorld(true); M0.g.traverse(function(o){ if(o.geometry){ var a = o.geometry.attributes.position.array; for(var i = 0; i < a.length; i++) if(!isFinite(a[i])) finite = false; } });
    out.models[sp.id] = {meshes: worst.meshes, drawn: worst.drawn, tris: worst.tris, sizes: sizes, fin: sp.fin, fx: sp.fx || null, legs: !!(M0.limbs && M0.legs.length), wings: !!M0.wingMesh, eyes: M0.eyes.length,
                         segs: M0.segs ? M0.segs.count : 0, glow: !!M0.glow, finite: finite,
                         mat: M0.parts.body.material.type, transparent: !!M0.parts.body.material.transparent, metal: M0.parts.body.material.metalness};
  });
  // the ice dragon's frost-tipped wings: the tips' vertex colours are white
  var ice = P.model(THREE, {species: "icedragon", variant: 0}), cw = ice.wingMesh.geometry.attributes.color.array, white = 0;
  for(var i = 0; i < cw.length; i += 3) if(cw[i] > 0.95 && cw[i + 1] > 0.95 && cw[i + 2] > 0.95) white++;
  out.iceTips = white;
  // wings fold against the body on the ground and open in flight (the wrist's span, both sides)
  function spanOf(M){ var a = M.wingMesh.geometry.attributes.position.array, mx = 0; for(var i = 0; i < a.length; i += 3) mx = Math.max(mx, Math.abs(a[i])); return mx; }
  var fd = P.model(THREE, {species: "firedragon", variant: 0}), fs0 = P.newState(3, 0, 0, 0);
  fs0.anim = "stand"; P.pose(fd, fs0, 2, false); var folded = {span: spanOf(fd), open: fd.wing.open};
  fs0.anim = "fly"; P.pose(fd, fs0, 2.3, false); var flying = {span: spanOf(fd), open: fd.wing.open};
  var flaps = []; for(var ft = 0; ft < 10; ft++){ P.pose(fd, fs0, 3 + ft*0.06, false); flaps.push(Math.round(fd.wingMesh.geometry.attributes.position.array[13]*1000)); }
  out.wings = {folded: folded, flying: flying, flaps: flaps, L: fd.dims.L};
  // eyes and a blink; jointed legs (upper and lower apart, a knee between)
  var dg = P.model(THREE, {species: "corgi", variant: 0}), ds = P.newState(5, 0, 0, 0), lids = [];
  for(var bt = 0; bt < 80; bt++){ ds.anim = "stand"; P.pose(dg, ds, bt*0.05, false); lids.push(dg.blink > 0.5 ? 1 : 0); }
  ds.anim = "sleep"; P.pose(dg, ds, 9, false);
  out.eyes = {n: dg.eyes.length, blinked: lids.indexOf(1) >= 0, open: lids.indexOf(0) >= 0, asleep: dg.blink, legs: dg.legs.length, knees: dg.legs.map(function(l){ return l.l1 > 0 && l.l2 > 0; })};
  // gait: a walking leg's foot moves forward and back
  var ws = P.newState(5, 0, 0, 0), zs = []; ws.anim = "walk"; ws.speed = 1.5;
  for(var wi = 0; wi < 8; wi++){ ws.ph = wi*0.25; P.pose(dg, ws, 10 + wi*0.1, false); var mt = new THREE.Matrix4(); dg.limbs.getMatrixAt(dg.legs[0].k, mt); zs.push(new THREE.Vector3().setFromMatrixPosition(mt).z); }
  out.gait = Math.max.apply(null, zs) - Math.min.apply(null, zs);
  // ---- names ----
  out.names = ["  Rex  ", "Mr  Biscuit", "O'Malley", "R2-D2", "", "   ", "--", "<b>hi</b>", "Zoë", "xxxxxxxxxxxxx", "Sh1tz", "fUcK", "b1tch", "a$$hole", "Scunthorpe", 7, null].map(P.cleanName);
  // ---- adoption rules ----
  var sp = P.speciesOf;
  out.adopt = {
    corgi: P.canAdopt(sp("corgi"), {level: 1, owned: 0}), iceLow: P.canAdopt(sp("icedragon"), {level: 3, coins: 100, owned: 0}),
    iceCoins: P.canAdopt(sp("icedragon"), {level: 3, coins: 800, owned: 0}), iceLevel: P.canAdopt(sp("icedragon"), {level: 10, owned: 0}),
    iceLocal: P.canAdopt(sp("icedragon"), {level: 3, coins: 9999, owned: 0, local: true}), full: P.canAdopt(sp("corgi"), {level: 50, owned: 6}),
    gold: [sp("golddragon").minLevel, sp("golddragon").price]
  };
  // ---- presence ----
  var pets = [{species: "icedragon", variant: 2, acc: 5, affection: 200, name: " Frost ", active: true}, {species: "corgi", variant: 9, acc: 8, affection: 0, name: "Waffles"},
              {species: "tabby", variant: 0, acc: 0, affection: 0, name: "Third"}];
  out.enc = P.encode(pets);
  out.dec = P.decode(out.enc).map(function(p){ return [p.sp.id, p.variant, p.acc, p.stage, p.name]; });
  out.decBad = P.decode([[22, 0, 0, 0, "A"], [0, 4, 0, 0, "A"], [0, 0, 8, 0, "A"], [0, 0, 0, 3, "A"], [0, 0, 0, 0, "Sh1t"], [0.5, 0, 0, 0, "A"], "x", [11, 0, 8, 2, "Ok"]]).length;
  out.decMax = P.decode([[0, 0, 0, 0, "A"], [1, 0, 0, 0, "B"], [2, 0, 0, 0, "C"]]).length;
  // ---- following round a corner: a wall at x in [2, 4], z in [-50, 6]; you walk north up x = 0 then east along z = 10 ----
  function wall(x, z){ return x > 2 && x < 4 && z < 6; }
  var trail = [], st = P.newState(42, 0, -2, 0), dog = sp("shiba"), maxD = 0, inWall = 0, tele = 0, o = {x: 0, z: 0, yaw: 0, speed: 1.6};
  for(var k = 0; k < 900; k++){
    var dt = 1/60;
    if(o.z < 10){ o.z += 1.6*dt; o.yaw = 0; } else { o.x += 1.6*dt; o.yaw = Math.PI/2; }
    P.trailPush(trail, o.x, o.z);
    var ev = P.step(st, {owner: o, slot: 0, sp: dog, trail: trail, blocked: wall, calm: false}, dt);
    ev.forEach(function(e){ if(e.type === "teleport") tele++; });
    if(wall(st.x, st.z)) inWall++;
    if(k > 120) maxD = Math.max(maxD, Math.hypot(o.x - st.x, o.z - st.z));
  }
  out.follow = {maxD: maxD, inWall: inWall, tele: tele, end: Math.hypot(o.x - st.x, o.z - st.z), behind: (o.x - st.x) > 0.3};
  // you teleport 60 m: it is back beside you at once
  o.x += 60; var ev2 = P.step(st, {owner: o, slot: 0, sp: dog, trail: P.trailPush(trail, o.x, o.z), blocked: null}, 1/60);
  out.teleport = {ev: ev2.map(function(e){ return e.type; }), d: Math.hypot(o.x - st.x, o.z - st.z)};
  // boxed in: stuck, then beside you
  var box = function(x, z){ return Math.abs(x - 100) < 3 && Math.abs(z) < 3 && !(Math.abs(x - 100) < 1 && Math.abs(z) < 1); };
  var st2 = P.newState(5, 100, 0, 0), o2 = {x: 100, z: 8, yaw: 0, speed: 0}, evs = [];
  for(k = 0; k < 240; k++) P.step(st2, {owner: o2, slot: 0, sp: dog, trail: [], blocked: box}, 1/60).forEach(function(e){ evs.push(e.type); });
  out.stuck = {teleported: evs.indexOf("teleport") >= 0, d: Math.hypot(o2.x - st2.x, o2.z - st2.z)};
  // ---- fetch ----
  out.land = P.throwBall({x: 0, z: 0, yaw: Math.PI/2}, wall, 11);
  out.landOpen = P.throwBall({x: 0, z: 0, yaw: 0}, null, 11);
  var st3 = P.newState(9, 0, -1, 0), o3 = {x: 0, z: 0, yaw: 0, speed: 0}, ball = {x: 0, z: 8, landed: true, fresh: true}, got = [];
  for(k = 0; k < 600 && got.indexOf("drop") < 0; k++){ P.step(st3, {owner: o3, slot: 0, sp: dog, trail: [], blocked: null, ball: ball, fetcher: true}, 1/60).forEach(function(e){ got.push(e.type); }); ball.fresh = false; }
  out.fetch = {events: got.filter(function(e){ return e === "pickup" || e === "drop"; }), steps: k, back: Math.hypot(st3.x, st3.z)};
  // ---- the idle state machine: the same pet does the same things; Calm only gentle ones; a long wait is a nap ----
  function idles(seed, calm, n, kind){
    var s = P.newState(seed, 0, -1.5, 0), seq = [], o4 = {x: 0, z: 0, yaw: 0, speed: 0};
    for(var j = 0; j < n; j++){ P.step(s, {owner: o4, slot: 0, sp: sp(kind || "shiba"), trail: [], blocked: null, calm: calm}, 1/20); if(seq[seq.length - 1] !== s.anim) seq.push(s.anim); }
    return seq;
  }
  out.idle = {a: idles(11, false, 600), b: idles(11, false, 600), c: idles(12, false, 600), calm: idles(11, true, 900, "trex").concat(idles(3, true, 900, "firedragon")),
              wild: idles(4, false, 1200, "trex").concat(idles(5, false, 1200, "firedragon")), nap: idles(2, false, 1400).slice(-1)[0]};
  // ---- reactions: you break into a run beside it: an excited hop ----
  var st5 = P.newState(1, 0, -1.5, 0); P.step(st5, {owner: {x: 0, z: 0, yaw: 0, speed: 0}, slot: 0, sp: dog, trail: []}, 0.1);
  out.excited = P.step(st5, {owner: {x: 0, z: 0, yaw: 0, speed: 6}, slot: 0, sp: dog, trail: []}, 0.016).map(function(e){ return e.type; });
  out.excitedCalm = P.step(P.newState(1, 0, -1.5, 0), {owner: {x: 0, z: 0, yaw: 0, speed: 6}, slot: 0, sp: dog, trail: [], calm: true}, 0.016).map(function(e){ return e.type; });
  // ---- vehicles: a dog hops in a fast car and out when you stop; a dragon flies wide of a plane; a serpent swims by a boat ----
  var st6 = P.newState(3, 0, -1.5, 0), carEv = [];
  P.step(st6, {owner: {x: 0, z: 0, yaw: 0, speed: 20, ride: {kind: "car", speed: 20}}, slot: 0, sp: dog, trail: []}, 0.05).forEach(function(e){ carEv.push(e.type); });
  var hid = st6.hidden;
  P.step(st6, {owner: {x: 50, z: 0, yaw: 0, speed: 0}, slot: 0, sp: dog, trail: []}, 0.05).forEach(function(e){ carEv.push(e.type); });
  out.car = {events: carEv, hidden: hid, after: st6.hidden, d: Math.hypot(st6.x - 50, st6.z)};
  var st7 = P.newState(3, 0, 0, 0), plane = {x: 0, z: 0, yaw: 0, speed: 60, ride: {kind: "prop", speed: 60, air: true, h: 120}};
  for(k = 0; k < 300; k++){ plane.z += 60/60; P.step(st7, {owner: plane, slot: 0, sp: sp("icedragon"), trail: []}, 1/60); }
  out.plane = {anim: st7.anim, side: Math.abs(st7.x - plane.x), y: st7.y, d: Math.hypot(st7.x - plane.x, st7.z - plane.z)};
  var st8 = P.newState(3, 0, 0, 0), boat = {x: 0, z: 0, yaw: 0, speed: 8, ride: {kind: "boat", speed: 8, boat: true, h: 0}};
  for(k = 0; k < 120; k++){ boat.z += 8/60; P.step(st8, {owner: boat, slot: 1, sp: sp("seaserpent"), trail: []}, 1/60); }
  out.boat = {anim: st8.anim, side: st8.x - boat.x, y: st8.y};
  // ---- the lobby API: spots by kind; stay-home pets wander inside, nap on their spot, greet you ----
  var spots = [{x: 1, z: 1, kind: "bed"}, {x: 2, z: 2, kind: "perch"}, {x: 3, z: 3, kind: "tree"}, {x: 4, z: 4, kind: "pen"}, {x: 5, z: 5, kind: "water"}, {x: 6, z: 6, kind: "bowl"},
               {x: 7, z: 7, kind: "bed"}, {x: "x", z: 1, kind: "bed"}, {x: 9, z: 9, kind: "throne"}];
  out.spotFor = ["shiba", "tabby", "icedragon", "trex", "seaserpent"].map(function(id){ var s = P.spotFor(sp(id), spots, 1); return s ? s.kind + "@" + s.x : null; });
  out.spotNone = P.spotFor(sp("trex"), [{x: 1, z: 1, kind: "bed"}], 0);
  var world = {bounds: [-15, 15, -15, 15]}, home = P.lobby(world, spots);
  out.lobbyApi = {spots: home.spots.length, kinds: home.spots.map(function(s){ return s.kind; }), bounds: home.bounds, bad: P.lobby(null, spots)};
  function lblock(x, z){ return Math.abs(x) < 2 && Math.abs(z) < 2; }
  var LS = [0, 1, 2].map(function(i){ var s = P.newState(100 + i, -6 + i*4, 8, 0); s.id = "p" + i; s.mode = "idle"; s.until = 0; return s; }), lev = [], outB = 0, inB = 0;
  var kinds = ["shiba", "tabby", "icedragon"];
  for(k = 0; k < 3600; k++){
    LS.forEach(function(s, i){
      var mates = LS.map(function(m, j){ return {id: m.id, x: m.x, z: m.z, kind: sp(kinds[j]).kind}; });
      P.lobbyStep(s, {sp: sp(kinds[i]), i: i, owner: {x: 0, z: 12, yaw: Math.PI}, bounds: world.bounds, blocked: lblock, spots: home.spots, calm: false, mates: mates, greet: k === 10}, 1/30)
        .forEach(function(e){ lev.push(e.type + (e.spot ? ":" + e.spot : "")); });
      if(s.x < -15.5 || s.x > 15.5 || s.z < -15.5 || s.z > 15.5) outB++;
      if(lblock(s.x, s.z)) inB++;
    });
  }
  out.lobbyRun = {greets: lev.filter(function(e){ return e === "greet"; }).length, naps: lev.filter(function(e){ return e.indexOf("nap") === 0; }), outB: outB, inB: inB,
                  idles: lev.filter(function(e){ return e === "idle"; }).length};
  // ---- the runtime, headless: yours follow, B / U / O, E in your lobby, net(), others' pets culled past 80 m ----
  var said = [], cares = [], toggles = [], scene = new THREE.Scene();
  var K = P.create({THREE: THREE}, {calm: function(){ return false; }, say: function(t){ said.push(t); }, onCare: function(id, k){ cares.push(k); }, onToggle: function(id, o){ toggles.push([id, o]); }});
  K.setOwned([{id: "a", species: "corgi", variant: 1, name: "Waffles", acc: 3, affection: 300, active: true, home: true},
              {id: "b", species: "icedragon", variant: 0, name: "Frost", acc: 9, affection: 160, active: true, home: true},
              {id: "c", species: "tabby", variant: 0, name: "Mittens", acc: 0, affection: 0, active: false, home: true},
              {id: "d", species: "seaserpent", variant: 0, name: "Nessie", acc: 0, affection: 0, active: false, home: false}]);
  var me = {x: 0, z: 0, yaw: 0, speed: 0}, frames = 0;
  function fr(info){ frames++; K.frame(Object.assign({t: frames/60, dt: 1/60, scene: scene, world: {name: "city"}, worldName: "city", owner: me, blocked: null, ground: null, peers: []}, info || {})); }
  for(k = 0; k < 120; k++){ me.z += 0.03; me.speed = 1.8; fr(); }
  me.speed = 0; for(k = 0; k < 60; k++) fr();
  out.rt = {out: K.out().map(function(p){ return p.name; }), net: K.net(), stats: K.stats()};
  K.key("KeyB", {x: me.x, z: me.z, yaw: 0}, null); for(k = 0; k < 900; k++) fr();
  K.key("KeyU", {x: K.out()[0].x, z: K.out()[0].z, yaw: 0}, null);
  var o5 = K.out()[0]; K.key("KeyO", {x: o5.x, z: o5.z, yaw: 0}, null);
  out.rt.cares = cares; out.rt.said = said.length;
  // a stranger 20 m away with two pets, another 120 m away: the near one's are drawn, the far one's not
  var peers = [{u: "near", x: 20, z: 0, yaw: 0, speed: 0, pt: [[13, 0, 8, 0, "Rexy"], [6, 1, 16, 0, "Miso"]]}, {u: "far", x: 120, z: 0, yaw: 0, speed: 0, pt: [[0, 0, 0, 0, "Bo"]]},
               {u: "bad", x: 5, z: 0, yaw: 0, pt: [[99, 0, 0, 0, "X"]]}];
  for(k = 0; k < 10; k++) fr({peers: peers});
  var vis = {}; scene.traverse(function(o){ if(o.name === "pet-tag" && o.parent.visible) vis[o.parent.uuid] = 1; });
  out.rt.peers = {remote: K.stats().remote, drawn: K.stats().drawn};
  // your lobby: the stay-home tabby (not out, home) appears; E beside it takes it out
  var lobbyW = {name: "lobby", bounds: [-15, 15, -15, 15]}; P.lobby(lobbyW, [{x: 3, z: 3, kind: "tree"}]);
  var scene2 = new THREE.Scene();
  for(k = 0; k < 30; k++) fr({scene: scene2, world: lobbyW, worldName: "lobby"});
  out.rt.lobby = K.stats().lobby;
  for(k = 0; k < 400; k++) fr({scene: scene2, world: lobbyW, worldName: "lobby"});
  // [3.13.5] E needs you still and facing it: back to every pet, nothing is offered; turned to the nearest, it is
  function nearestAny(){ var b = null, bd = 1e9; K.out().concat(K.lobbyOut ? K.lobbyOut() : []).forEach(function(q){ var d = Math.hypot(q.x - me.x, q.z - me.z); if(q.x != null && d < bd){ bd = d; b = q; } }); return b; }
  var q0 = nearestAny(), yawTo = function(q){ return Math.atan2(q.x - me.x, q.z - me.z); };
  me.yaw = yawTo(q0) + Math.PI; fr({scene: scene2, world: lobbyW, worldName: "lobby"});
  out.rt.backNear = K.near ? K.near.p.name : null;
  me.yaw = yawTo(q0); fr({scene: scene2, world: lobbyW, worldName: "lobby", busy: true});
  out.rt.busyNear = K.near ? K.near.p.name : null;                                 // a door / lift / ride here: E is theirs
  me.speed = 1.5; fr({scene: scene2, world: lobbyW, worldName: "lobby"}); out.rt.movingNear = K.near ? K.near.p.name : null; me.speed = 0;
  fr({scene: scene2, world: lobbyW, worldName: "lobby"});
  out.rt.near = K.near ? [K.near.kind, K.near.p.name, +Math.hypot(q0.x - me.x, q0.z - me.z).toFixed(2)] : null;
  if(K.near) K.key("KeyE", me, null);
  out.rt.toggles = toggles;
  // facing (pure): still, within the distance, within 45 degrees of where you look
  var F = P.facing;
  out.facing = {ahead: F({x: 0, z: 0, yaw: 0, speed: 0}, 0, 1.2, 1.5), side: F({x: 0, z: 0, yaw: 0, speed: 0}, 1.2, 0, 1.5), behind: F({x: 0, z: 0, yaw: 0, speed: 0}, 0, -1.2, 1.5),
    edge: F({x: 0, z: 0, yaw: 0, speed: 0}, 0.8, 1.0, 1.5), far: F({x: 0, z: 0, yaw: 0, speed: 0}, 0, 1.8, 1.5), moving: F({x: 0, z: 0, yaw: 0, speed: 2}, 0, 1.2, 1.5),
    riding: F({x: 0, z: 0, yaw: 0, speed: 0, ride: {kind: "car"}}, 0, 1.2, 1.5), turned: F({x: 0, z: 0, yaw: Math.PI/2, speed: 0}, 1.2, 0, 1.5), D: [P.LEAVE_D, P.TAKE_D]};
  // the list arrives late (the Arena answers after the lobby is up): the stay-home pets appear then, and again on a change
  var K2 = P.create({THREE: THREE}, {}), scene3 = new THREE.Scene(), lw2 = {name: "lobby", bounds: [-15, 15, -15, 15]}; P.lobby(lw2, null);
  function fr2(){ frames++; K2.frame({t: frames/60, dt: 1/60, scene: scene3, world: lw2, worldName: "lobby", owner: {x: 0, z: 6, yaw: Math.PI, speed: 0}, peers: []}); }
  for(k = 0; k < 10; k++) fr2();
  out.late = {before: K2.stats().lobby};
  K2.setOwned([{id: "h", species: "retriever", name: "het", active: false, home: true}, {id: "s", species: "firedragon", name: "SWASti", active: false, home: true},
               {id: "r", species: "raptor", name: "raptu", active: false, home: true}]);
  fr2(); out.late.after = K2.stats().lobby; out.late.mine = K2.stats().mine;
  K2.setOwned([{id: "h", species: "retriever", name: "het", active: true, home: true}, {id: "s", species: "firedragon", name: "SWASti", active: false, home: true},
               {id: "r", species: "raptor", name: "raptu", active: false, home: true}]);
  fr2(); out.late.changed = [K2.stats().lobby, K2.stats().mine];
  K2.dispose();
  // a host's lobby on a visit
  K.setLobby([{species: "golddragon", variant: 0, acc: 0, stage: 2, name: "Sol"}]);
  for(k = 0; k < 5; k++) fr({scene: scene2, world: lobbyW, worldName: "lobby"});
  out.rt.visit = K.stats().lobby;
  K.dispose();
  out.rt.left = 0; scene.traverse(function(o){ if(/^pet-/.test(o.name)) out.rt.left++; }); scene2.traverse(function(o){ if(/^pet-/.test(o.name)) out.rt.left++; });
  // ---- the Pet shop on the Commons ----
  var gz = function(p){ return JSON.parse(zlib.gunzipSync(fs.readFileSync(p)).toString("utf8")); };
  var W = H.world.pack(gz(root + "/tests/fixtures/claude-hq@2.json.gz")); W.id = "claude-hq@2";
  H.hqDealer.place(W, 5); H.hqCasino.place(W, 5);
  var s = P.place(W), lot = s && W.lots.filter(function(l){ return l.id === s.lot; })[0], again = P.place(W), cc = H.world.cacheCopy(W);
  out.shop = s ? {id: s.id, kind: s.kind, lotKind: lot.kind, same: again === s, notTaken: W.sites.filter(function(x){ return x.kind === "dealer" || x.kind === "casino"; }).every(function(d){ return d.lot !== s.lot; }),
                  places: H.hqnav.places(W, 5, {x: 0, z: 0}).filter(function(p){ return p.kind === "petshop"; }).map(function(p){ return p.label + "|" + p.icon; }),
                  cached: cc.sites.some(function(x){ return x.kind === "petshop"; }) || cc.lots.some(function(l){ return l.kind === "petshop"; })} : null;
  if(s){
    var B = P.build({THREE: THREE, box: function(w, h, d, m, x, y, z, p){ var o = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), m); o.position.set(x, y, z); p.add(o); return o; },
                     mat: function(c){ return new THREE.MeshStandardMaterial({color: c}); }, canvasTex: function(){ return {t: new THREE.Texture()}; }}, s, {night: true});
    B.animate(1, 0.016, 1);
    out.shopB = {doors: B.door && isFinite(B.door.x), near: B.near(B.door.x, B.door.z), inside: B.inside(B.x, B.z), boxes: B.boxes.length, lod: B.lod.length};
  }
  // ---- the real models: none under node without a loader (the procedural pet stays); each GLB rigs, recolours, plays ----
  out.fallback = {models: K.stats().models, rigged: K.out().length};
  return Promise.all([import(url.pathToFileURL(root + "/games/vendor/three-gltf-loader.js").href), import(url.pathToFileURL(root + "/games/vendor/three-skeleton-utils.js").href)]).then(function(m){
    var loader = new m[0].GLTFLoader(), files = {};
    Object.keys(P.MODELS).forEach(function(id){ files[P.MODELS[id].f] = 1; });
    return Promise.all(Object.keys(files).map(function(f){ var b = fs.readFileSync(root + "/games/pets/" + f + ".glb");
      return new Promise(function(res, rej){ loader.parse(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength), "", function(gl){ res([f, gl]); }, rej); }); })).then(function(list){
      var G = {}; list.forEach(function(x){ G[x[0]] = x[1]; });
      out.rigs = {};
      Object.keys(P.MODELS).forEach(function(id){
        var M = P.model(THREE, {species: id, variant: 2, acc: P.speciesOf(id).saddle ? 31 : 23, stage: 1}), R = P.rig(THREE, G[P.MODELS[id].f], m[1].clone, M);
        M.rig = R; M.P.add(R.wrap); var st = P.newState(4, 0, 0, 0), plays = {};
        var eyeGap = null;
        if(R.lids){ var E = R.wrap.getObjectByName("pet-eyes"), M0w = new THREE.Matrix4(); R.wrap.updateMatrixWorld(true);
          var vs = [], pp = R.geo.attributes.position, v3 = new THREE.Vector3(); for(var q0 = 0; q0 < pp.count; q0++) vs.push(v3.fromBufferAttribute(pp, q0).clone().applyMatrix4(R.skin.matrixWorld));
          var ep = E.geometry.attributes.position, sums = {}; for(var q1 = 0; q1 < ep.count; q1++){ v3.fromBufferAttribute(ep, q1).applyMatrix4(E.matrixWorld); var sd = v3.x > 0 ? "r" : "l", S0 = sums[sd] || (sums[sd] = [0, 0, 0, 0]); S0[0] += v3.x; S0[1] += v3.y; S0[2] += v3.z; S0[3]++; }
          eyeGap = Object.keys(sums).map(function(kk){ var S0 = sums[kk], c3 = new THREE.Vector3(S0[0]/S0[3], S0[1]/S0[3], S0[2]/S0[3]); return Math.round(Math.min.apply(null, vs.map(function(p3){ return p3.distanceTo(c3); }))*1000)/1000; }); out.eyedbg = out.eyedbg || {}; out.eyedbg[id] = [Object.keys(sums).map(function(kk){ var S0 = sums[kk]; return [S0[0]/S0[3], S0[1]/S0[3], S0[2]/S0[3]].map(function(x){ return Math.round(x*100)/100; }); }), R.hb.min.toArray().map(function(x){ return Math.round(x*100)/100; }), R.hb.max.toArray().map(function(x){ return Math.round(x*100)/100; })]; }
        ["stand", "walk", "run", "sit", "sleep", "sniff", "roar", "wag", "roll", "spin", "big", "look"].forEach(function(a, i){ st.anim = a; st.speed = a === "run" ? 6 : 1.5; st.trick = {t: 0.5, dur: 1.6};
          for(var j = 0; j < 5; j++) P.pose(M, st, i + j*0.05, false, {x: 1, z: 3}); plays[a] = R.cur ? R.cur.getClip().name : null; });
        var n = 0; R.wrap.traverse(function(o){ if(o.isMesh) n++; });
        var box = new THREE.Box3().setFromObject(R.wrap, true), c = R.geo.attributes.color.array, pal = new THREE.Color(M.sp.pal[2][0]);
        var hit = 0; for(var q = 0; q < c.length; q += 3) if(Math.abs(c[q] - pal.r) < 1e-3 && Math.abs(c[q + 1] - pal.g) < 1e-3 && Math.abs(c[q + 2] - pal.b) < 1e-3) hit++;
        // far away: the pose freezes and refreshes every 8th frame
        M.lod = true; var t0 = R.mixer.time, ups = 0; for(var f2 = 0; f2 < 16; f2++){ P.pose(M, st, 20 + f2*0.02, false, null); if(R.mixer.time !== t0){ ups++; t0 = R.mixer.time; } } var frozen = ups >= 1 && ups <= 2;
        out.rigs[id] = {meshes: n, counted: R.meshes, clips: Object.keys(R.acts).sort(), plays: plays, len: Math.round((box.max.z - box.min.z)*100)/100, h: Math.round((box.max.y - box.min.y)*100)/100,
                        feet: Math.round(box.min.y*100)/100, coloured: hit, lids: !!R.lids, eyeGap: eyeGap, hx: R.hb ? Math.round((R.hb.max.x - R.hb.min.x)*100)/100 : null, frozen: frozen, mouth: !!M.mouthP, collar: !!R.wrap.getObjectByName("pet-acc-neck"), hat: !!R.wrap.getObjectByName("pet-acc-head")};
      });
      console.log(JSON.stringify(out));
    });
  });
}).catch(function(e){ console.error(e && e.stack || e); process.exit(1); });
"""

UI = r"""
var fs = require("fs"), root = process.argv[1], store = {};
global.window = global; global.HQV = {}; window.HQV = global.HQV;
global.localStorage = {getItem: function(k){ return store[k] == null ? null : store[k]; }, setItem: function(k, v){ store[k] = String(v); }};
global.document = {getElementById: function(){ return null; }, createElement: function(){ return {}; }};
global.setInterval = function(){ return 0; }; global.STATE = {season: {level: 3}};
new Function(fs.readFileSync(root + "/games/hqpets.js", "utf8"))();
require("vm").runInThisContext(fs.readFileSync(root + "/ui/app/40-pets.js", "utf8"));
var U = window.HQV.petsUi, out = {};
out.sanitize = U.sanitize([{id: "a", species: "corgi", name: "Bo", variant: 9, acc: 8, affection: 5000, active: true},
  {id: "a", species: "corgi", name: "Dup"}, {id: "b", species: "unicorn", name: "X"}, {id: "c", species: "tabby", name: "<x>"},
  {id: "d", species: "trex", name: "Rex", acc: 8, active: true}, {id: "e", species: "husky", name: "Snow", active: true}, "junk", null]);
var r1 = U.localAdopt([], "shiba", 2, " Mochi ", 1, 1700000000000), r2 = U.localAdopt(r1.list, "icedragon", 0, "Frost", 3, 1700000000001),
    r3 = U.localAdopt(r1.list, "icedragon", 0, "Frost", 10, 1700000000002), r4 = U.localAdopt(r3.list, "tabby", 0, "Third", 1, 1700000000003),
    r5 = U.localAdopt(r1.list, "tabby", 0, "b1tch", 1, 1);
out.adopt = {first: r1.pet, low: r2.err, ok: r3.pet && r3.pet.active, third: r4.pet && r4.pet.active, rude: r5.err};
var full = r4.list; for(var i = 0; i < 3; i++) full = U.localAdopt(full, "corgi", 0, "C" + i, 1, 1800000000000 + i).list;
out.full = U.localAdopt(full, "corgi", 0, "Seven", 1, 2).err;
var id3 = r4.pet.id, e1 = U.localEdit(r4.list, id3, {active: true}), e2 = U.localEdit(r4.list, r1.pet.id, {acc: 8}), e3 = U.localEdit(r4.list, r3.pet.id, {acc: 9, name: "Glacier", home: false}),
    e4 = U.localEdit(r4.list, "nope", {home: true}), e5 = U.localEdit(r4.list, r1.pet.id, {name: "<script>"});
out.edit = {third: e1.err, saddle: e2.err, ok: e3.pet && [e3.pet.acc, e3.pet.name, e3.pet.home], none: e4.err, bad: e5.err};
// [3.13.5] a refresh: the HQ is up before the Arena's capabilities arrive
var can = false, gets = 0, pushed = [];
global.ARENA = {paired: true}; global.hqNetCan = function(c){ return c === "pets" && can; };
global.HQ3D = {inst: {setPets: function(l){ pushed.push(l.length); }, setLobbyPets: function(){}}};
global.fetch = function(u){ gets++; return Promise.resolve({ok: true, status: 200, json: function(){ return Promise.resolve({pets: [
  {id: "11111111-1111-4111-8111-111111111111", species: "retriever", name: "het", active: true, home: true},
  {id: "22222222-2222-4222-8222-222222222222", species: "firedragon", name: "SWASti", active: false, home: true},
  {id: "33333333-3333-4333-8333-333333333333", species: "raptor", name: "raptu", active: false, home: true}], level: 9}); }}); };
var tick = function(){ return new Promise(function(r){ U.tick(); setTimeout(r, 5); }); }, Ps = function(){ return PETS; };
tick().then(function(){
  out.late = {first: [Ps().src, Ps().list.length]};
  can = true; return tick();
}).then(function(){ return tick(); }).then(function(){
  var L = Ps().list;
  out.late.then = [Ps().src, L.length, L.filter(function(p){ return p.active; }).length, L.filter(function(p){ return p.home && !p.active; }).length];
  out.late.pushed = pushed[pushed.length - 1];
  return tick().then(function(){ return tick(); });
}).then(function(){ out.late.again = gets; console.log(JSON.stringify(out)); });
"""


def read(*p):
    with open(os.path.join(ROOT, *p), encoding="utf-8") as f:
        return f.read()


@unittest.skipUnless(NODE, "node not installed")
class PetsEngine(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        r = subprocess.run([NODE, "-e", HARNESS, ROOT], capture_output=True, text=True, timeout=240)
        if r.returncode:
            raise AssertionError(r.stderr[-3000:])
        cls.o = json.loads(r.stdout.strip().splitlines()[-1])

    def test_the_roster_matches_the_arena(self):
        rs = read("backend", "src", "pets.rs")
        rust = [[m[0], int(m[1]), int(m[2]), m[3] == "true", m[4] == "true"]
                for m in re.findall(r'sp\("(\w+)", (\d+), (\d+), (true|false), (true|false)\)', rs)]
        self.assertEqual([r[:5] for r in self.o["roster"]], rust, "index for index: presence sends the index")
        self.assertEqual(len(rust), 22)
        c = self.o["consts"]
        for k, rk in [("MAX_OWNED", "MAX_OWNED: i64"), ("MAX_ACTIVE", "MAX_ACTIVE: i64"), ("VARIANTS", "VARIANTS: i64"), ("ACC_MAX", "ACC_MAX: i64")]:
            self.assertEqual(int(re.search(r"pub const " + re.escape(rk) + r" = (\d+);", rs).group(1)), c[k], k)
        self.assertIn("pub const NAME_MAX: usize = %d;" % c["NAME_MAX"], rs)
        self.assertIn("pub const STAGE_AT: [i64; 2] = [%d, %d];" % tuple(c["STAGE_AT"]), rs)
        bad = re.search(r"pub const BAD_WORDS: &\[&str\] = &\[(.*?)\];", rs, re.S).group(1)
        self.assertEqual(re.findall(r'"(\w+)"', bad), c["BAD"], "the same word filter both sides")
        kinds = {r[0]: r[5] for r in self.o["roster"]}
        self.assertEqual(sorted(k for k, v in kinds.items() if v == "dragon"),
                         ["crystaldragon", "firedragon", "golddragon", "icedragon", "shadowdragon", "stormdragon", "wyvern"])
        self.assertEqual(sorted(k for k, v in kinds.items() if v == "dino"), ["brachio", "raptor", "stego", "trex", "triceratops"])
        self.assertEqual(kinds["seaserpent"], "serpent")
        self.assertEqual(sum(1 for v in kinds.values() if v in ("dog", "cat")), 9)

    def test_models_stay_inside_their_budgets(self):
        for sid, m in self.o["models"].items():
            self.assertLessEqual(m["meshes"], 6, sid)          # + its name tag: at most 7 draw calls a pet
            self.assertEqual(m["meshes"], m["drawn"], sid)
            self.assertLessEqual(m["tris"], 4500, sid)
            self.assertTrue(m["finite"], sid)
            self.assertEqual(m["mat"], "MeshStandardMaterial", sid)
        M = self.o["models"]
        self.assertTrue(all(M[s]["legs"] for s in M if s != "seaserpent"))
        self.assertTrue(M["seaserpent"]["segs"] == 10 and not M["seaserpent"]["legs"] and not M["seaserpent"]["wings"], "a long wingless serpent")
        self.assertTrue(all(M[s]["wings"] for s in M if s.endswith("dragon") or s == "wyvern"))
        # dragons grow: hatchling, young, grown
        self.assertEqual(M["icedragon"]["sizes"], [0.7, 1, 1.35])
        self.assertEqual(M["corgi"]["sizes"], [1, 1, 1])

    def test_eyes_legs_and_wings_move(self):
        e = self.o["eyes"]
        self.assertEqual(e["n"], 2)
        self.assertTrue(e["blinked"] and e["open"], "it blinks now and then")
        self.assertEqual(e["asleep"], 1, "eyes shut asleep")
        self.assertTrue(e["legs"] == 4 and all(e["knees"]), "jointed legs")
        self.assertGreater(self.o["gait"], 0.03, "a walking paw steps forward and back")
        self.assertTrue(all(m["eyes"] == 2 for m in self.o["models"].values()))
        w = self.o["wings"]
        self.assertLess(w["folded"]["open"], 0.1)
        self.assertEqual(w["flying"]["open"], 1)
        self.assertGreater(w["flying"]["span"], w["folded"]["span"] + w["L"]*0.4, "wings spread in flight, folded on the ground")
        self.assertGreater(len(set(w["flaps"])), 5, "they flap")

    def test_real_models(self):
        # CC0 Quaternius models, vendored with their licence; under node (no loader) the procedural pets stay
        lic = read("games", "pets", "LICENSE-quaternius.txt")
        self.assertIn("CC0 1.0", lic)
        self.assertIn("quaternius.com/packs/animateddinosaurs.html", lic)
        self.assertEqual(self.o["fallback"]["models"], 0)
        self.assertRegex(read("dashboard-rs", "src", "server.rs"), r"vehicles\|pets\)/")
        total = 0
        for f in os.listdir(os.path.join(ROOT, "games", "pets")):
            if f.endswith(".glb"):
                self.assertRegex(f, r"^[a-z][a-z0-9-]{0,40}\.glb$")
                total += os.path.getsize(os.path.join(ROOT, "games", "pets", f))
        self.assertLess(total, 6 * 1024 * 1024, "pet models stay small")
        for sid, r in self.o["rigs"].items():
            self.assertEqual(r["meshes"], r["counted"], sid)
            self.assertLessEqual(r["meshes"], 6, sid)
            self.assertTrue({"idle", "walk", "run"} <= set(r["clips"]), sid)
            self.assertEqual((r["plays"]["walk"], r["plays"]["run"], r["plays"]["stand"]), ("walk", "run", "idle"), sid)
            self.assertGreater(r["coloured"], 10, sid + ": recoloured for its variant")
            self.assertTrue(r["frozen"] and r["mouth"] and r["collar"] and r["hat"], sid)
            self.assertGreater(r["len"], 0.5, sid)
            self.assertGreater(r["feet"], -0.2, sid)
        self.assertEqual(self.o["rigs"]["trex"]["plays"]["roar"], "roar")
        self.assertEqual(self.o["rigs"]["shiba"]["plays"]["sniff"], "sniff")
        self.assertTrue(self.o["rigs"]["triceratops"]["lids"], "eyes (with lids) added where the model has none")
        for sid in ("triceratops", "stego", "brachio"):
            r = self.o["rigs"][sid]
            self.assertTrue(r["eyeGap"] and all(g < r["hx"]*0.3 for g in r["eyeGap"]), sid + ": the added eyes sit on its head")

    def test_each_dragon_has_its_own_look_and_element(self):
        M = self.o["models"]
        self.assertEqual((M["icedragon"]["fin"], M["icedragon"]["fx"]), ("ice", "ice"))
        self.assertGreaterEqual(self.o["iceTips"], 4, "frost-tipped wings")
        self.assertEqual((M["firedragon"]["fx"], M["stormdragon"]["fx"]), ("fire", "storm"))
        self.assertTrue(M["stormdragon"]["glow"] and M["shadowdragon"]["glow"], "glowing eyes")
        self.assertEqual((M["crystaldragon"]["fin"], M["crystaldragon"]["fx"], M["crystaldragon"]["transparent"]), ("crystal", "sparkle", True))
        self.assertEqual((M["shadowdragon"]["fin"], M["shadowdragon"]["fx"], M["shadowdragon"]["transparent"]), ("shadow", "wisp", True))
        self.assertEqual((M["golddragon"]["fin"], M["golddragon"]["fx"]), ("gold", "glitter"))
        self.assertGreater(M["golddragon"]["metal"], 0.8, "polished gold")
        src = read("games", "hqpets.js")
        self.assertIn("FIN.ice.emissiveIntensity = night ?", src, "a cold glow at night")
        self.assertIn("FIN.shadow.opacity = night ?", src, "see-through at night")
        self.assertIn("if(!cm) elementFx(", src, "effects are off in Calm")
        self.assertNotIn("Math.random", src)

    def test_rarity_and_adoption_rules(self):
        a = self.o["adopt"]
        self.assertEqual((a["corgi"]["ok"], a["corgi"]["price"]), (True, 0))
        self.assertFalse(a["iceLow"]["ok"])
        self.assertEqual((a["iceCoins"]["ok"], a["iceCoins"]["price"]), (True, 800))
        self.assertEqual((a["iceLevel"]["ok"], a["iceLevel"]["price"]), (True, 0))
        self.assertFalse(a["iceLocal"]["ok"], "no coins offline: free at its level")
        self.assertFalse(a["full"]["ok"])
        rares = [r for r in self.o["roster"] if r[0] != "golddragon"]
        self.assertTrue(all(r[1] < a["gold"][0] and r[2] < a["gold"][1] for r in rares), "the golden dragon is the rarest")

    def test_names(self):
        self.assertEqual(self.o["names"], ["Rex", "Mr Biscuit", "O'Malley", "R2-D2"] + [None]*13)

    def test_presence_encoding(self):
        self.assertEqual(self.o["enc"], [[11, 2, 5, 1, "Frost"], [2, 3, 0, 0, "Waffles"]], "two at most, clamped, no saddle on a corgi")
        self.assertEqual(self.o["dec"], [["icedragon", 2, 5, 1, "Frost"], ["corgi", 3, 0, 0, "Waffles"]])
        self.assertEqual(self.o["decBad"], 1, "only the well-formed ice dragon")
        self.assertEqual(self.o["decMax"], 2)

    def test_following_round_a_corner(self):
        f = self.o["follow"]
        self.assertEqual(f["inWall"], 0, "never inside a building")
        self.assertEqual(f["tele"], 0, "no teleport on a normal walk")
        self.assertLess(f["maxD"], 4.5)
        self.assertLess(f["end"], 3)
        self.assertTrue(f["behind"])
        self.assertIn("teleport", self.o["teleport"]["ev"])
        self.assertLess(self.o["teleport"]["d"], 2.5)
        self.assertTrue(self.o["stuck"]["teleported"])
        self.assertLess(self.o["stuck"]["d"], 2.5)

    def test_fetch(self):
        self.assertLess(self.o["land"]["d"], 2.6, "a ball thrown at a wall lands short of it")
        self.assertAlmostEqual(self.o["landOpen"]["d"], 11, delta=0.01)
        f = self.o["fetch"]
        self.assertEqual(f["events"], ["pickup", "drop"])
        self.assertLess(f["back"], 1.2)

    def test_idles_are_deterministic_and_gentle_in_calm(self):
        i = self.o["idle"]
        self.assertEqual(i["a"], i["b"], "the same pet does the same things")
        self.assertNotEqual(i["a"], i["c"])
        self.assertGreater(len(set(i["a"])), 2)
        rough = {"shake", "stretch", "wings", "puff", "breath", "stomp", "roar"}
        self.assertFalse(rough & set(i["calm"]), i["calm"])
        self.assertTrue(rough & set(i["wild"]))
        self.assertEqual(i["nap"], "sleep", "a long wait ends in a nap")
        self.assertEqual(self.o["excited"], ["excited"])
        self.assertEqual(self.o["excitedCalm"], [])

    def test_riding_along(self):
        c = self.o["car"]
        self.assertEqual(c["events"], ["board", "hopout"])
        self.assertTrue(c["hidden"])
        self.assertFalse(c["after"])
        self.assertLess(c["d"], 2.5)
        p = self.o["plane"]
        self.assertEqual(p["anim"], "fly")
        self.assertGreater(p["side"], 12, "a safe offset from a plane")
        self.assertGreater(p["y"], 100)
        b = self.o["boat"]
        self.assertEqual(b["anim"], "swim")
        self.assertGreater(abs(b["side"]), 3)

    def test_the_lobby_api(self):
        self.assertEqual(self.o["spotFor"], ["bed@7", "tree@3", "perch@2", "pen@4", "water@5"])
        self.assertIsNone(self.o["spotNone"])
        api = self.o["lobbyApi"]
        self.assertEqual(api["spots"], 7, "bad spots (no number, unknown kind) dropped")
        self.assertEqual(api["bounds"], [-15, 15, -15, 15])
        self.assertIsNone(api["bad"])
        run = self.o["lobbyRun"]
        self.assertEqual(run["greets"], 3, "each pet greets you once")
        self.assertEqual((run["outB"], run["inB"]), (0, 0), "they stay on the floor, off what is blocked")
        self.assertTrue(run["naps"], "they nap on their spots")
        self.assertTrue(all(n in ("nap:bed", "nap:tree", "nap:perch") for n in run["naps"]))
        self.assertGreater(run["idles"], 5)

    def test_the_runtime_headless(self):
        rt = self.o["rt"]
        self.assertEqual(rt["out"], ["Waffles", "Frost"])
        self.assertEqual(rt["net"], [[2, 1, 3, 0, "Waffles"], [11, 0, 9, 1, "Frost"]])
        self.assertEqual(rt["stats"]["mine"], 2)
        self.assertIn("fetch", rt["cares"])
        self.assertIn("pet", rt["cares"])
        self.assertGreaterEqual(rt["said"], 3)
        self.assertEqual(rt["peers"]["remote"], 3, "two near, one far (the bad one dropped)")
        self.assertEqual(rt["peers"]["drawn"], 4, "yours and the near stranger's; the far one's culled")
        self.assertEqual(rt["lobby"], 1, "the stay-home tabby; the serpent lives elsewhere")
        self.assertEqual(rt["near"][0] in ("lobby", "mine"), True)
        self.assertLessEqual(rt["near"][2], 2.2)
        self.assertIsNone(rt["backNear"], "your back to them: E is not a pet's")
        self.assertIsNone(rt["busyNear"], "a door, lift or ride here: E is theirs")
        self.assertIsNone(rt["movingNear"], "walking: E is not a pet's")
        self.assertEqual(len(rt["toggles"]), 1)
        self.assertEqual(rt["visit"], 1, "a host's lobby pet on a visit")
        self.assertEqual(rt["left"], 0, "dispose takes everything away")

    def test_e_needs_facing_and_distance(self):
        f = self.o["facing"]
        self.assertEqual(f["D"], [1.5, 2.2])
        self.assertAlmostEqual(f["ahead"], 1.2, places=3)
        self.assertAlmostEqual(f["turned"], 1.2, places=3)
        self.assertGreaterEqual(f["edge"], 0, "38 degrees off: still facing it")
        for k in ("side", "behind", "far", "moving", "riding"):
            self.assertEqual(f[k], -1, k)

    def test_lobby_pets_after_a_late_list(self):
        L = self.o["late"]
        self.assertEqual(L["before"], 0)
        self.assertEqual((L["after"], L["mine"]), (3, 0), "the list arrives after the lobby: all three stay-home pets appear")
        self.assertEqual(L["changed"], [2, 1], "one taken out: it follows, two stay")

    def test_e_priority_door_before_pet(self):
        hq = read("games", "hq3d.js")
        key = hq[hq.index("function petsKey(e)"):hq.index("function petsKey(e)") + 600]
        self.assertIn('e.code === "KeyE" && (ride || !PK.near || useHere())', key, "a door, lift or ride wins E over a pet")
        self.assertLess(hq.index("if(petsKey(e)) return;"), hq.index("if(useKey()) e.preventDefault()"))
        use = hq[hq.index("function useHere()"):hq.index("function useKey()")]
        for want in ("nearBike() >= 0", "doorUnderCrosshair(pose, curDoors(), 3)", "cur.prompt", "USE_DOOR_D", "!!d.roof === up"):
            self.assertIn(want, use)
        self.assertIn("busy: useHere()", hq)

    def test_the_pet_shop(self):
        s = self.o["shop"]
        self.assertIsNotNone(s)
        self.assertEqual((s["id"], s["kind"], s["lotKind"], s["same"], s["notTaken"], s["cached"]), ("petshop:0", "petshop", "petshop", True, True, False))
        self.assertEqual(s["places"], ["Pet shop (Paws & Claws)|🐾"])
        b = self.o["shopB"]
        self.assertEqual((b["doors"], b["near"], b["inside"], b["boxes"], b["lod"]), (True, True, True, 1, 1))


@unittest.skipUnless(NODE, "node not installed")
class PetsUiLogic(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        r = subprocess.run([NODE, "-e", UI, ROOT], capture_output=True, text=True, timeout=60)
        if r.returncode:
            raise AssertionError(r.stderr[-3000:])
        cls.o = json.loads(r.stdout.strip().splitlines()[-1])

    def test_pets_reload_from_the_arena(self):
        # [3.13.5] the 3D HQ up before the Arena's capabilities: the first load is this browser's (empty) list; once the
        # Arena says "pets" the next tick loads from it, so a refresh keeps your pets (out ones follow, home ones in the lobby)
        self.assertEqual(self.o["late"], {"first": ["local", 0], "then": ["arena", 3, 1, 2], "pushed": 3, "again": 1})


    def test_a_stored_list_is_made_safe(self):
        s = self.o["sanitize"]
        self.assertEqual([p["id"] for p in s], ["a", "d", "e"])
        self.assertEqual((s[0]["variant"], s[0]["acc"], s[0]["affection"]), (3, 0, 1000))
        self.assertEqual(s[1]["acc"], 8, "a saddle on a T-Rex")
        self.assertEqual([p["active"] for p in s], [True, True, False], "two out at most")

    def test_local_adoption_and_edits_follow_the_arena_rules(self):
        a = self.o["adopt"]
        self.assertEqual((a["first"]["name"], a["first"]["variant"], a["first"]["active"], a["first"]["home"]), ("Mochi", 2, True, True))
        self.assertIn("level 10", a["low"])
        self.assertTrue(a["ok"])
        self.assertFalse(a["third"], "the third waits at home")
        self.assertTrue(a["rude"])
        self.assertTrue(self.o["full"])
        e = self.o["edit"]
        self.assertTrue(e["third"] and e["saddle"] and e["none"] and e["bad"])
        self.assertEqual(e["ok"], [9, "Glacier", False])


class PetsWiring(unittest.TestCase):
    def test_the_page_and_the_hq_are_wired(self):
        html, hq, net = read("index.html"), read("games", "hq3d.js"), read("ui", "app", "22-hq.js")
        self.assertIn("//@include ui/app/40-pets.js", html)
        self.assertIn('id="setPetsOpen"', html)
        self.assertIn('"hq3d","hqpets","hqpetride","hqlobby"', net)
        self.assertIn("hqpets:1", net)
        self.assertIn('hqNetCan("pets")', net)
        self.assertIn("msg.pt=pt.slice(0,2)", net)
        self.assertIn("JSON.stringify(msg.pt||0)", net, "a changed pet re-sends presence")
        self.assertIn("petCare:", net)
        self.assertIn("petToggle:", net)
        for hook in ["petsFrame(t, dt);", "if(petsKey(e)) return;", "P.pt = Array.isArray(p.pt)", "inst.setPets = function", "inst.petsNet = function",
                     "inst.setLobbyPets = function", "PK.dispose()"]:
            self.assertIn(hook, hq)
        self.assertEqual(hq.count("[pets 3.14]"), 5, "small marked hooks only")
        cmdk = read("ui", "app", "14-overlays.js")
        self.assertIn('label:"Pets"', cmdk)
        self.assertIn('label:"Adopt a pet"', cmdk)
        self.assertIn('$("petsBack")', read("ui", "app", "09-drawer.js"))
        self.assertIn("HQV.hqPets.lobby(w, ST.petSpots(st)", read("games", "hqlobby.js"))   # the revamp's lobby feeds its pet furniture (3.13)
        city = read("games", "hqcity3d.js")
        self.assertIn("HQV.hqPets.place(W)", city)
        self.assertIn('HQV.petsUi.open("adopt")', city)
        self.assertIn('petshop: ["Pet shop", "🐾"]', read("games", "hqnav.js"))

    def test_the_panel_is_safe(self):
        ui = read("ui", "app", "40-pets.js")
        self.assertNotIn("innerHTML", ui)
        self.assertNotIn("Math.random", ui)
        self.assertIn('back.addEventListener("keydown", function(e){ e.stopPropagation();', ui, "keys typed here never reach the 3D HQ")
        for path in ["/api/arena/pets/mine", "/api/arena/pets/adopt", "/api/arena/pets/home?u="]:
            self.assertIn(path, ui)
        self.assertIn("PET_ID_RE.test(id)", ui)
        css = read("ui", "hq.css")
        block = css[css.index("/* the Pets panel"):]
        self.assertNotRegex(block, r"#[0-9a-fA-F]{3,6}\b", "theme tokens only")
        self.assertIn("html.hq-calm .pets-sw", block)
        self.assertIn("prefers-reduced-motion", block)

    def test_the_arena_side_is_wired(self):
        self.assertTrue(os.path.exists(os.path.join(ROOT, "backend", "migrations", "0022_pets.sql")))
        mig = read("backend", "migrations", "0022_pets.sql")
        self.assertIn("CREATE TABLE IF NOT EXISTS owned_pets", mig)
        self.assertIn("home INTEGER NOT NULL DEFAULT 1 CHECK (home IN (0, 1))", mig)
        self.assertIn('"convoy", "tuning", "pets", "hqstyle", "motion", "petride", "grenade", "tank"]', read("backend", "src", "protocol.rs"))
        self.assertIn("read_pets(msg.get(\"pt\"))", read("backend", "src", "valley", "hq.rs"))
        self.assertIn(".merge(pets::routes())", read("backend", "src", "main.rs"))
        srv = read("dashboard-rs", "src", "server.rs")
        self.assertIn('"/api/arena/pets/adopt"', srv)
        self.assertIn("pet_post_target(&path).is_none()", srv)


if __name__ == "__main__":
    unittest.main()
