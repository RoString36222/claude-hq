"""HQ Exosuit (games/hqexo.js): the armour fits your own character, within budget, and poses finite, whatever it is given.

One node process loads the vendored three.js (and its GLTFLoader), games/people3d.js and games/hqexo.js, builds real
people from games/people/*.glb (+ anims.glb) as hq3d does (the humanoid rig: elbows, knees, fingers, IK feet, our big toy
head) and puts every frame x paint x finish x glow on the first body and every frame on all six; counts the armour's
draw calls and triangles (at most 4 and 10k); checks the helmet covers the toy head, the boots sit on the feet, the hair
and hat hide and the clothes turn to the undersuit; poses each in the air (hover, cruise, boost, swim, landed) and on
foot through odd clocks (NaN, a step back, a long stall) after the idle clip (and a jolt) has moved the bones, and
checks every bone stays finite and the joints bend the right way (knees, elbows, palms and soles to the jets); runs
every suit-up style forward and in reverse (the reverse strips the layer: the character's own scale, update, clothes
and headwear back); docks; and round-trips presence `ex`. The Kenney rig (games/golf) still wears and flies every frame
as the fallback. Then the wiring, by reading the files: the scripts load, hq3d wears the suit on you and on peers, U
summons it, the lobby has the Suit-Up Centre, presence `ex` goes out only where the Arena lists "exo", the Arena keeps it
(backend/src/valley/hq.rs), and the suit's sound goes through the engine's shared output. Skipped when node is not
installed. Stdlib only."""
import json
import os
import shutil
import subprocess
import unittest

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
NODE = shutil.which("node")

HARNESS = r"""
var fs = require("fs"), url = require("url"), root = process.argv[1], V = root + "/games/vendor/";
Promise.all([import(url.pathToFileURL(V + "three-module.js").href), import(url.pathToFileURL(V + "three-gltf-loader.js").href),
             import(url.pathToFileURL(V + "three-skeleton-utils.js").href)]).then(function(mods){
  var T = mods[0], loader = new mods[1].GLTFLoader(), L = {THREE: T, loader: loader, clone: mods[2].clone}, cache = {};
  global.window = {HQV: {}};
  window.HQV.engine = {calm: function(){ return false; }, lib: function(){ return Promise.resolve(L); },
    loadGlb: function(L0, kit, name){ var k = kit + "/" + name; return cache[k] || (cache[k] = new Promise(function(res, rej){
      var b = fs.readFileSync(root + "/games/" + k + ".glb"); loader.parse(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength), "", res, rej); })); }};
  new Function(fs.readFileSync(root + "/games/people3d.js", "utf8"))();
  new Function(fs.readFileSync(root + "/games/hqexo.js", "utf8"))();
  var X = window.HQV.hqExo, PP = window.HQV.people3d, S0 = 1.7/PP.CH_H;
  var specs = []; for(var b = 0; b < 6; b++) for(var c = 0; c < 4; c++) specs.push([b, c, c, c, c % 3, c === 1 ? 1 : c === 2 ? 5 : 0, c, 0, 0, 0]);
  return Promise.all(specs.map(function(s){ return PP.build(s); })).then(function(pool){ run(T, X, pool, specs, S0); });
}).catch(function(e){ console.error(e && e.stack || e); process.exit(1); });

function run(T, X, pool, specs, S0){
  var out = {built: 0, posed: 0, bad: [], budget: {}, over: [], seq: {}, rt: [], refused: 0, odd: 0, fit: {}, bones: null, strip: [], kenney: null};
  var next = {};
  // a person of base b (0-5) as hq3d draws one (1.7 m), idle playing, nothing worn
  function person(b){
    var k = next[b] = ((next[b] || 0) + 1) % 4, ch = pool[b*4 + k];
    if(ch._exo) X.strip(ch);
    ch._fly = null; ch.base = S0; ch.o.scale.setScalar(S0); ch.o.position.set(0, 0, 0); ch.o.rotation.set(0, 0, 0);
    if(ch.o.parent) ch.o.parent.remove(ch.o);
    if(ch.mixer){ ch.mixer.stopAllAction(); if(ch.acts.idle) ch.acts.idle.reset().play(); ch.mixer.update(0.2); }
    return ch;
  }
  var ODD = [{}, {f: NaN, p: NaN, fin: NaN, g: NaN}, {f: -3, p: -1, fin: -9, g: -2}, {f: 99, p: 1e9, fin: 7, g: 1e6}, {f: "flux", p: "2", fin: "1", g: "x"}, null];
  var CLOCK = [0, 0, 0.016, NaN, 0.5, -0.4, 30, 30, 1e6, 0.016];
  var FLY = [null, {mode: "hover"}, {mode: "cruise", speed: 30}, {mode: "cruise", speed: NaN, boost: true}, {mode: "swim", speed: 4}, {mode: "landed"}, {mode: "nonsense"}, null];
  function finite(ch){ var ok = true; ch.o.updateMatrixWorld(true); ch.o.traverse(function(o){ var e = o.matrixWorld.elements; for(var i = 0; i < 16; i++) if(!isFinite(e[i])) ok = false; }); return ok; }
  // the clips: the mixer's idle, and a jolt on the limbs now and then (a stand-in for any other clip)
  function clip(ch, t, dt){ ch.mixer.update(isFinite(dt) && dt > 0 && dt < 1 ? dt : 1/60);
    if(((t*7) | 0) % 5 === 0) ["UpperArmL", "LowerLegR", "Chest", "Head"].forEach(function(n, i){ ch.bones[n].rotation.x += Math.sin(t + i)*0.2; }); }
  function posed(ch, tag){
    var t = 1;
    FLY.forEach(function(fl){ ch._fly = fl; for(var f = 0; f < CLOCK.length; f++){ var k = CLOCK[f]; t = isFinite(k) ? t + k : NaN; clip(ch, t || 0, k); ch.update(t); out.posed++; if(!isFinite(t)) t = 1; } });
    if(!finite(ch)) out.bad.push(tag);
    ch._fly = null; for(var f2 = 0; f2 < 60; f2++){ t += 1/60; clip(ch, t, 1/60); ch.update(t); }   // landed: the pose blends out within a second
    var r = ch.bones.Root; if(r.quaternion.w < 0.999 || Math.abs(r.position.x) + Math.abs(r.position.y) > 1e-6) out.bad.push(tag + ": the root left tilted on landing");
    if(ch._exo && ch._exo.tilt) out.bad.push(tag + ": still posed");
  }
  // the world box of an armour mesh's skinned vertices carried by one bone
  function skinned(ch, k, boneName){
    var m = ch._exo.meshes.filter(function(x){ return x.name === "exo-" + k; })[0], bi = ch._exo.M.bi[boneName], bb = new T.Box3(), v = new T.Vector3();
    if(!m) return bb; ch.o.updateMatrixWorld(true); m.skeleton.update();
    var si = m.geometry.attributes.skinIndex;
    for(var i = 0; i < si.count; i++){ if(boneName && si.getX(i) !== bi) continue; m.getVertexPosition(i, v); bb.expandByPoint(v.applyMatrix4(m.matrixWorld)); }
    return bb;
  }
  var FILES = ["woman-casual", "man-hoodie", "woman-adventurer", "man-adventurer", "woman-worker", "man-casual"];
  FILES.forEach(function(file, bi){
    var ch = person(bi);
    X.FRAMES.forEach(function(F, fi){
      for(var p = 0; p < X.PAINTS.length; p++) for(var fin = 0; fin < X.FINISHES.length; fin++) for(var g = 0; g < X.GLOWS.length; g++){
        if(bi && (p || fin || g)) continue;                    // every look on the first body, every frame on all six
        var ok = X.wear(T, ch, {f: fi, p: p, fin: fin, g: g}); out.built++;
        if(!ok){ out.bad.push(file + "/" + F.id + ": did not fit"); continue; }
        var s = X.stats(ch); out.budget[F.id] = s; out.maxTris = Math.max(out.maxTris || 0, s.tris); if(s.draws > 4 || s.tris > 10000) out.over.push([file, F.id, p, fin, g, s]);
      }
      var c2 = person(bi); c2.o.updateMatrixWorld(true);
      var skull = new T.Box3().setFromObject(c2.head.g.children[0]);
      var hatOn = c2.head.g.visible, cloth = []; c2.o.traverse(function(n){ if(n.isSkinnedMesh && n.visible) cloth.push(n.material.color ? n.material.color.getHex() : (n.material[0] && n.material[0].color.getHex())); });
      X.wear(T, c2, {f: fi}); c2.o.updateMatrixWorld(true);
      var hb = skinned(c2, "A", "Head"), feet = skinned(c2, "A", "FootL").union(skinned(c2, "A", "FootR")), soles = skinned(c2, "D", "FootL"), top = c2.bones.Head.getWorldPosition(new T.Vector3());
      var dyed = []; c2.o.traverse(function(n){ if(n.isSkinnedMesh && n.visible && !n.userData.exo) dyed.push(n.material.color ? n.material.color.getHex() : (n.material[0] && n.material[0].color.getHex())); });
      out.fit[file + "/" + F.id] = {scale: c2.o.scale.x, helmet: hb.min.x <= skull.min.x && hb.max.x >= skull.max.x && hb.max.y >= skull.max.y && hb.max.z >= skull.max.z && hb.min.z <= skull.min.z,
        feet: feet.min.y > -0.08 && soles.min.y > -0.08 && soles.min.y < 0.1, hat: c2.head.g.visible, hatWas: hatOn, dyed: JSON.stringify(dyed) !== JSON.stringify(cloth)};
      posed(c2, file + "/" + F.id);
      X.strip(c2);
      var back = []; c2.o.traverse(function(n){ if(n.isSkinnedMesh && n.visible && !n.userData.exo) back.push(n.material.color ? n.material.color.getHex() : (n.material[0] && n.material[0].color.getHex())); });
      out.strip.push([Math.abs(c2.o.scale.x - S0) < 1e-6, c2.head.g.visible, !!c2._exo, !c2.o.getObjectByName("exo-A"), JSON.stringify(back) === JSON.stringify(cloth)]);
      if(bi > 1) return;
      ["gantry", "summon", "flow", "drop"].forEach(function(st){ [false, true].forEach(function(rev){
        var ch3 = person(bi); X.wear(T, ch3, {f: fi}); var S = X.seq(T, ch3, st, {reverse: rev}), r = null, n = 0, locks = 0;
        for(; n < 2000; n++){ clip(ch3, n/60, 1/60); r = X.seqStep(S, n % 7 ? 1/60 : (n % 3 ? NaN : -1)); if(r.lock) locks++; if(r.done) break; }
        var shown = ch3._exo ? ch3._exo.meshes.every(function(m){ return m.visible; }) : false;
        out.seq[file + "/" + F.id + "/" + st + (rev ? "/off" : "")] = {done: !!(r && r.done), steps: n, locks: locks, shown: shown, left: S.g.parent ? 1 : 0, finite: finite(ch3),
          stripped: !ch3._exo, scale: ch3.o.scale.x/S0};
      }); });
    });
  });
  out.bones = X.BONES_UNI;
  // ---- the flight pose's targets, the bank's limit, the thrusters (in a scene: two draws, finite, pointing the right way) ----
  out.tg = {hover: X.targets({mode: "hover", speed: 0, agl: 8}), cruise: X.targets({mode: "cruise", speed: 40}), fast: X.targets({mode: "cruise", speed: 200}),
            boost: X.targets({mode: "cruise", speed: 80, boost: true}), landed: X.targets({mode: "landed"}), low: X.targets({mode: "hover", agl: 0.2}),
            none: X.targets(null), odd: X.targets({mode: "cruise", speed: NaN, agl: "x", vs: Infinity, boost: "yes"})};
  out.bank = [X.BANK_MAX, X.bankFor(9, 300), X.bankFor(-9, 300), X.bankFor(0.5, 60), X.bankFor(0.5, 0), X.bankFor(NaN, NaN), X.bankFor(Infinity, 1), X.bankFor(1, -Infinity)];
  out.fx = {}; out.joints = {};
  X.FRAMES.forEach(function(F, fi){
    var sc = new T.Scene(), ch = person(fi % 6); sc.add(ch.o); X.wear(T, ch, {f: fi, g: fi % 5}); var t = 1, r = {ok: true, max: 0, idle: 0, dirs: {}};
    function check(){ var s = X.stats(ch); r.max = Math.max(r.max, s.draws + s.fx); if(s.fx > 2) r.ok = false; var Fx = ch._exo.fx; if(!Fx) return;
      [Fx.fl.instanceMatrix.array, Fx.ia.array, Fx.pp.array, Fx.pc.array, Fx.ps.array].forEach(function(a){ for(var i = 0; i < a.length; i++) if(!isFinite(a[i])) r.ok = false; }); }
    var ODDF = [{mode: "hover", agl: NaN, turn: "q"}, {mode: "cruise", speed: Infinity, boost: 1, vs: -1e9, spin: NaN}, {mode: "cruise", speed: -5, turn: 1e9, agl: -3},
                {mode: "swim", speed: 4}, {mode: "landed"}, {mode: "?"}, null];
    ODDF.forEach(function(fl){ ch._fly = fl; for(var i = 0; i < 25; i++){ var dt = [1/60, 0, NaN, -1, 5, 1/30][i % 6]; t = isFinite(dt) ? t + dt : NaN; clip(ch, t || 0, dt); ch.update(t); check(); if(!isFinite(t)) t = 2; } });
    if(!finite(ch)) r.ok = false;
    var W = function(n){ return ch.bones[n].getWorldPosition(new T.Vector3()); };
    [["hover", {mode: "hover", speed: 0, agl: 6}], ["cruise", {mode: "cruise", speed: 50}], ["boost", {mode: "cruise", speed: 90, boost: true}], ["landed", {mode: "landed"}]].forEach(function(q){
      ch._fly = q[1]; for(var i = 0; i < 150; i++){ t += 1/60; clip(ch, t, 1/60); ch.update(t); } check(); var Fx = ch._exo.fx;
      ch.o.updateMatrixWorld(true);
      var hip = W("UpperLegL"), knee = W("LowerLegL"), ank = W("FootL"), sh = W("UpperArmL"), el = W("LowerArmL"), wr = W("WristL"), hd = W("Head"), hp = W("Hips");
      var ang = function(a, b, c){ var u = a.clone().sub(b).normalize(), v = c.clone().sub(b).normalize(); return Math.acos(Math.max(-1, Math.min(1, u.dot(v)))); };
      if(fi === 0) out.joints[q[0]] = {knee: Math.PI - ang(hip, knee, ank), elbow: Math.PI - ang(sh, el, wr), handBelowHead: wr.y < hd.y, armAlongBody: sh.clone().sub(wr).normalize().dot(hd.clone().sub(hp).normalize()),
        footShin: ank.distanceTo(knee)/ch.o.scale.x, bodyUp: hd.clone().sub(hp).normalize().toArray()};
      r.dirs[q[0]] = {boot: Fx.nd[0].toArray(), palm: Fx.nd[2].toArray(), palmR: Fx.nd[3].toArray(), tilt: ch._exo.s.tilt, fx: X.stats(ch).fx,
                      len: new T.Vector3().setFromMatrixColumn(new T.Matrix4().fromArray(Fx.fl.instanceMatrix.array, 0), 1).length(),
                      trail: Array.from(Fx.ps.array.slice(4 + 16)).filter(function(x){ return x > 0; }).length,
                      dust: Array.from(Fx.ps.array.slice(4, 20)).filter(function(x){ return x > 0; }).length}; });
    ch._fly = {mode: "hover", speed: 0, agl: 0.5}; for(var i = 0; i < 60; i++){ t += 1/60; ch.update(t); } r.dustLow = Array.from(ch._exo.fx.ps.array.slice(4, 20)).filter(function(x){ return x > 0; }).length;
    ch._fly = null; for(var i2 = 0; i2 < 90; i2++){ t += 1/60; ch.update(t); } r.idle = X.stats(ch).fx;
    X.strip(ch); var left = 0; sc.traverse(function(o){ if(o.name === "exo-flames" || o.name === "exo-glow") left++; }); r.left = left;
    out.fx[F.id] = r;
  });
  var lone = person(0); X.wear(T, lone, {}); lone._fly = {mode: "cruise", speed: 50}; for(var i = 0; i < 20; i++) lone.update(1 + i/60); out.portrait = X.stats(lone).fx;
  ODD.forEach(function(o, i){ var ch = person(i % 6); X.wear(T, ch, o); posed(ch, "odd" + i); out.odd++; });
  var plain = person(1); var sm = []; plain.o.traverse(function(n){ if(n.isSkinnedMesh) sm.push(n); }); sm.forEach(function(n){ n.parent.remove(n); }); out.noskin = X.wear(T, plain, {});
  sm.forEach(function(n, i){ (i ? sm[0].parent : plain.model).add(n); });
  for(var f = 0; f < 6; f++) for(var m = 1; m <= 6; m++){ var e = X.encode({f: f, p: (f*3) % 9, fin: f % 4, g: f % 5}, m), d = X.decode(e); out.rt.push([e, d && [d.f, d.p, d.fin, d.g, d.m]]); }
  [[6, 0, 0, 0, 2], [0, 9, 0, 0, 2], [0, 0, 4, 0, 2], [0, 0, 0, 5, 2], [0, 0, 0, 0, 0], [0, 0, 0, 0, 7], [0, 0, 0, 0], [0.5, 0, 0, 0, 2], "x", null, [-1, 0, 0, 0, 2]]
    .forEach(function(a){ if(X.decode(a) === null) out.refused++; });
  out.styles = X.FRAMES.map(function(F, i){ return [F.id, X.styleFor(i, "bay"), X.styleFor(i, "city")]; });
  out.wanted = [X.wanted("you:me"), X.peer("u1", [2, 0, 0, 0, 4]) && X.wanted("peer:u1"), X.peer("u1", null), X.wanted("peer:u1")];
  out.sound = [typeof X.sound, X.sfx("clank", 0.5), X.sfx("nope"), (X.sound(null, 1/60), X.sound({}, NaN), "quiet")];
  // ---- [3.38.0] docking on the roof: the reverse onto the gantry, the parked suit, park / unpark with odd inputs ----
  var store = {}; window.localStorage = {getItem: function(k){ return k in store ? store[k] : null; }, setItem: function(k, v){ store[k] = String(v); }};
  out.dock = {odd: [X.park(T, null), X.park(T, {}), X.park(T, person(0)), X.unpark(null), X.unpark({}) === undefined].map(function(v){ return v == null || v === true; }), runs: []};
  X.FRAMES.forEach(function(F, fi){
    var ch = person(fi % 6); X.wear(T, ch, {f: fi, g: fi % 5}); clip(ch, 0.7, 1/60); ch.o.updateMatrixWorld(true);
    var P = X.park(T, ch), to = new T.Vector3(3, 0.2, -2), S = X.seq(T, ch, "gantry", {reverse: true, to: to, rdur: 2.2}), r = null, n = 0, eyes = [];
    for(; n < 2000; n++){ r = X.seqStep(S, n % 9 ? 1/60 : NaN); eyes.push(r.eyes); if(r.done) break; }
    var fin2 = true; P.meshes.forEach(function(m){ var a = m.geometry.attributes.position.array; for(var i = 0; i < a.length; i++) if(!isFinite(a[i])) fin2 = false; });
    var root = ch.bones.Root, posed2 = false; ch.o.traverse(function(o){ if(o.name.indexOf("exo") === 0) posed2 = true; });
    var s = X.parkStats(P); X.unpark(P); X.unpark(P);
    out.dock.runs.push({f: F.id, done: !!(r && r.done), steps: n, stripped: !ch._exo, left: S.g.parent ? 1 : 0, draws: s.draws, finite: fin2 && finite(ch),
      fade: eyes[0] > 0.9 && eyes[eyes.length - 1] < 0.05, tilt: root.quaternion.w < 0.999, posed: posed2, scale: ch.o.scale.x/S0, after: X.parkStats(P).draws});
  });
  var rig = X.dockRig(T), rd = 0; rig.traverse(function(o){ if(o.isMesh) rd++; }); out.dock.rig = rd;
  out.dock.pk = [X.parked(), X.setParked(1.25), (X.save({f: 2}), X.parked()), X.load().f, X.setParked(NaN), X.setParked("x"), X.setParked(null), X.setParked(Infinity), X.load().f];
  var st = {x: -50, y: 20, z: 30, yaw: 0}, A = X.dockPlan(st, {x: 4, y: 40, z: -3}), top = -1e9, k = 0;
  for(; k < 2000 && !X.dockStep(A, st, k % 5 ? 1/60 : NaN); k++) top = Math.max(top, st.y);
  out.dock.auto = {done: A.done, mode: st.mode, off: Math.hypot(st.x - 4, st.z + 3, st.y - 40), top: top, steps: k, plan: [X.dockPlan(null, {}), X.dockPlan({x: NaN, y: 0, z: 0}, {x: 0, y: 0, z: 0})],
                   again: X.dockStep(A, st, 1), none: X.dockStep(null, st, 1)};
  out.kenney = kenney(T, X);
  console.log(JSON.stringify(out));
}
// the fallback: a Kenney Mini Character (games/golf, the old 7-bone rig) still wears every frame and flies
function kenney(T, X){
  var root = process.argv[1], fs = require("fs");
  function glb(name){
    var b = fs.readFileSync(root + "/games/golf/" + name + ".glb"), jl = b.readUInt32LE(12), j = JSON.parse(b.slice(20, 20 + jl).toString());
    var bin = b.slice(20 + jl + 8), NC = {SCALAR: 1, VEC3: 3, VEC4: 4, MAT4: 16}, CT = {5126: Float32Array, 5123: Uint16Array, 5121: Uint8Array, 5125: Uint32Array};
    function acc(i){ var a = j.accessors[i], v = j.bufferViews[a.bufferView], n = NC[a.type], C = CT[a.componentType], es = C.BYTES_PER_ELEMENT;
      var off = (v.byteOffset || 0) + (a.byteOffset || 0), st = v.byteStride || n*es, o = new C(a.count*n);
      for(var k = 0; k < a.count; k++){ var r = bin.slice(off + k*st, off + k*st + n*es), u = new Uint8Array(n*es); for(var q = 0; q < n*es; q++) u[q] = r[q]; o.set(new C(u.buffer), k*n); }
      return o; }
    var sk = j.skins[0], objs = j.nodes.map(function(n, i){ var o = sk.joints.indexOf(i) >= 0 ? new T.Bone() : new T.Object3D(); o.name = n.name || "";
      if(n.translation) o.position.fromArray(n.translation); if(n.rotation) o.quaternion.fromArray(n.rotation); if(n.scale) o.scale.fromArray(n.scale); return o; });
    j.nodes.forEach(function(n, i){ (n.children || []).forEach(function(c){ objs[i].add(objs[c]); }); });
    var g = new T.Group(); j.scenes[j.scene || 0].nodes.forEach(function(i){ g.add(objs[i]); });
    var ibm = acc(sk.inverseBindMatrices), bones = sk.joints.map(function(i){ return objs[i]; });
    var skel = new T.Skeleton(bones, bones.map(function(_, k){ return new T.Matrix4().fromArray(ibm, k*16); })), meshes = [];
    j.nodes.forEach(function(n, i){ if(n.mesh == null) return; var pr = j.meshes[n.mesh].primitives[0], A = pr.attributes, geo = new T.BufferGeometry();
      geo.setAttribute("position", new T.BufferAttribute(acc(A.POSITION), 3)); geo.setAttribute("skinIndex", new T.Uint16BufferAttribute(Array.from(acc(A.JOINTS_0)), 4));
      geo.setAttribute("skinWeight", new T.BufferAttribute(acc(A.WEIGHTS_0), 4)); if(pr.indices != null) geo.setIndex(new T.BufferAttribute(acc(pr.indices), 1));
      var m = new T.SkinnedMesh(geo, new T.MeshStandardMaterial()); m.name = n.name; objs[i].name += "-node"; objs[i].parent.add(m); m.position.copy(objs[i].position); meshes.push(m); });
    g.updateMatrixWorld(true); meshes.forEach(function(m){ m.bind(skel, m.matrixWorld); });
    var head = g.getObjectByName("head"), hg = new T.Group(); hg.add(new T.Mesh(new T.BoxGeometry(0.1, 0.1, 0.1))); head.add(hg);
    var ch = {o: g, base: 2.1, mixer: {update: function(){}}, acts: {}, cur: "idle", hat: hg, skel: skel}; g.scale.setScalar(2.1);
    return ch;
  }
  var r = {fits: 0, over: [], bad: [], fx: 0, seq: 0, hat: true, bones: null}, sc = new T.Scene();
  X.FRAMES.forEach(function(F, fi){
    var ch = glb(["character-female-a", "character-male-c"][fi % 2]); sc.add(ch.o);
    if(!X.wear(T, ch, {f: fi})){ r.bad.push(F.id + ": did not fit"); return; } r.fits++; r.hat = r.hat && !ch.hat.visible;
    var s = X.stats(ch); if(s.draws > 4 || s.tris > 2500) r.over.push([F.id, s]);
    var t = 1; [{mode: "hover", agl: 6}, {mode: "cruise", speed: 50}, {mode: "cruise", speed: 90, boost: true}, {mode: "swim"}, {mode: "landed"}, null].forEach(function(fl){
      ch._fly = fl; for(var i = 0; i < 60; i++){ t += 1/60; ch.update(t); r.fx = Math.max(r.fx, X.stats(ch).fx); } });
    var ok = true; ch.o.updateMatrixWorld(true); ch.o.traverse(function(o){ o.matrixWorld.elements.forEach(function(e){ if(!isFinite(e)) ok = false; }); }); if(!ok) r.bad.push(F.id + ": not finite");
    if(ch.o.getObjectByName("root").quaternion.w < 0.999) r.bad.push(F.id + ": root left tilted");
    var S = X.seq(T, ch, "gantry", {}), q = null; for(var n = 0; n < 2000; n++){ q = X.seqStep(S, 1/60); if(q.done) break; } if(q && q.done && ch._exo) r.seq++;
    X.strip(ch); if(ch.o.scale.x !== 2.1 || !ch.hat.visible) r.bad.push(F.id + ": strip");
    r.bones = ch.skel.bones.map(function(b){ return b.name; });
  });
  return r;
}
"""


def read(*p):
    with open(os.path.join(ROOT, *p), encoding="utf-8") as f:
        return f.read()


@unittest.skipUnless(NODE, "node not installed")
class ExoBudget(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        r = subprocess.run([NODE, "-e", HARNESS, ROOT], capture_output=True, text=True, timeout=300)
        assert r.returncode == 0, r.stderr[-3000:]
        cls.o = json.loads(r.stdout.strip().splitlines()[-1])

    def test_it_fits_the_humanoid_on_all_six_bodies(self):
        o = self.o
        for n in ("Root", "Body", "Hips", "Chest", "Head", "UpperArmL", "LowerArmR", "WristL", "UpperLegR", "LowerLegL", "FootR"):
            self.assertIn(n, o["bones"])
        self.assertEqual(o["built"], 6*9*4*5 + 5*6)
        self.assertEqual(len(o["fit"]), 36)
        for k, f in o["fit"].items():
            self.assertTrue(f["helmet"], k + ": the helmet covers the big toy head")
            self.assertTrue(f["feet"], k + ": the boots sit on the feet")
            self.assertTrue(f["hatWas"], k)
            self.assertFalse(f["hat"], k + ": the head, hair and hat hide under the helmet")
            self.assertTrue(f["dyed"], k + ": the clothes turn to the undersuit")
            self.assertAlmostEqual(f["scale"], 1.7/0.72*(1.3 if "/bulwark" in k else 1), places=5)
        for s in o["strip"]:
            self.assertEqual(s, [True, True, False, True, True], "strip: own scale, head, no armour, own clothes")
        self.assertFalse(o["noskin"], "no skinned skeleton: no suit, no crash")

    def test_the_kenney_fallback_still_suits_up(self):
        k = self.o["kenney"]
        self.assertEqual(sorted(k["bones"]), sorted(["root", "torso", "head", "arm-left", "arm-right", "leg-left", "leg-right"]))
        self.assertEqual(k["fits"], 6)
        self.assertEqual(k["bad"], [])
        self.assertEqual(k["over"], [])
        self.assertTrue(k["hat"])
        self.assertEqual(k["fx"], 2)
        self.assertEqual(k["seq"], 6)

    def test_every_frame_paint_finish_and_glow_within_budget(self):
        o = self.o
        self.assertEqual(o["over"], [], "armour over 4 draw calls or 10k triangles")
        self.assertEqual(sorted(o["budget"]), ["abyss", "bulwark", "flux", "sentinel", "stratos", "strider"])
        for k, s in o["budget"].items():
            self.assertLessEqual(s["draws"], 4, k)
            self.assertLessEqual(s["tris"], 10000, k)
            self.assertGreater(s["tris"], 6000, k + ": a real suit of layered plates, not a few boxes")
        self.assertEqual(o["budget"]["abyss"]["draws"], 4, "abyss alone has the glass dome")
        self.assertEqual(o["budget"]["sentinel"]["draws"], 3)

    def test_flight_pose_targets_at_hover_cruise_and_boost(self):
        g, deg = self.o["tg"], 3.14159265 / 180
        self.assertLess(g["hover"]["tilt"], 10 * deg, "hover: upright")
        self.assertGreater(g["hover"]["lsp"], 0.06, "hover: legs a little apart")
        self.assertGreater(g["hover"]["aOut"], 0.25, "hover: arms down and a little out")
        self.assertGreater(g["hover"]["knee"], 0.3, "hover: knees a little bent")
        self.assertGreater(g["hover"]["ext"], 1.0, "hover: wrists back, palms down")
        self.assertEqual(g["hover"]["crouch"], 0)
        self.assertTrue(70 * deg <= g["cruise"]["tilt"] <= 80 * deg, g["cruise"]["tilt"])
        self.assertTrue(70 * deg <= g["fast"]["tilt"] <= 80 * deg, g["fast"]["tilt"])
        self.assertGreater(g["boost"]["tilt"], 84 * deg, "boost: nearly flat")
        self.assertLessEqual(g["boost"]["tilt"], 90 * deg)
        self.assertTrue(0.03 < g["cruise"]["lsp"] < 0.09, "cruise: legs together, parted a little so both read")
        self.assertLess(g["cruise"]["aSw"], 0, "cruise: arms back along the body")
        self.assertLess(g["boost"]["aOut"], g["cruise"]["aOut"], "boost: arms tucked")
        self.assertLess(g["boost"]["knee"], g["cruise"]["knee"])
        self.assertEqual(g["landed"]["crouch"], 1)
        self.assertEqual(g["landed"]["land"], 1, "landing: feet planted, the knees take it")
        self.assertGreater(g["low"]["crouch"], 0.5, "take-off / landing: a crouch")
        self.assertLess(g["hover"]["thrust"], g["cruise"]["thrust"])
        self.assertLess(g["cruise"]["thrust"], g["boost"]["thrust"])
        self.assertEqual(g["none"]["thrust"], 0)
        for k, v in g["odd"].items():
            self.assertIsInstance(v, (int, float), k)

    def test_the_joints_bend_the_right_way(self):
        j, deg = self.o["joints"], 3.14159265 / 180
        self.assertTrue(10 * deg < j["hover"]["knee"] < 45 * deg, j["hover"]["knee"])
        self.assertGreater(j["landed"]["knee"], 50 * deg, "landing: the knees absorb it")
        self.assertLess(j["boost"]["knee"], j["cruise"]["knee"], "boost: legs straight")
        for m in ("hover", "cruise", "boost"):
            self.assertGreater(j[m]["armAlongBody"], 0.85, m + ": the arms down along the body")
            self.assertTrue(j[m]["handBelowHead"], m)
        for m, r in j.items():
            self.assertAlmostEqual(r["footShin"], j["hover"]["footShin"], delta=0.01, msg=m + ": the foot stays on the shin")
        self.assertGreater(j["hover"]["bodyUp"][1], 0.95, "hover: upright")
        self.assertGreater(j["boost"]["bodyUp"][2], j["cruise"]["bodyUp"][2], "boost: flatter than a cruise")

    def test_the_bank_is_limited(self):
        b = self.o["bank"]
        self.assertAlmostEqual(b[0], 60 * 3.14159265 / 180, delta=0.02)
        self.assertAlmostEqual(b[1], b[0])
        self.assertAlmostEqual(b[2], -b[0])
        self.assertGreater(b[3], 0.5, "a cruise turn banks well over")
        self.assertLess(abs(b[4]), 0.1, "on the spot: hardly")
        self.assertEqual(b[5], 0)
        self.assertTrue(all(abs(x) <= b[0] + 1e-9 for x in b[1:]))

    def test_thrusters_two_draws_finite_and_aimed(self):
        fx = self.o["fx"]
        self.assertEqual(sorted(fx), ["abyss", "bulwark", "flux", "sentinel", "stratos", "strider"])
        for k, r in fx.items():
            self.assertTrue(r["ok"], k + ": finite under odd inputs, at most 2 draws")
            self.assertLessEqual(r["max"], 6, k + ": armour + flames at most 6 draw calls")
            self.assertEqual(r["idle"], 0, k + ": no flames once landed")
            self.assertEqual(r["left"], 0, k + ": strip takes the flames out of the scene")
            d = r["dirs"]
            for m in ("hover", "cruise", "boost"):
                self.assertEqual(d[m]["fx"], 2, k + m)
            self.assertLess(d["hover"]["boot"][1], -0.9, k + ": hover: the boots jet down")
            self.assertLess(d["hover"]["palm"][1], -0.8, k + ": hover: the palms jet down")
            self.assertLess(d["cruise"]["boot"][2], -0.9, k + ": cruise: the boots jet back")
            self.assertLess(d["cruise"]["palm"][2], -0.9, k + ": cruise: the palms jet back")
            self.assertLess(d["boost"]["palm"][2], -0.8, k + ": boost: both palms back")
            self.assertLess(d["boost"]["palmR"][2], -0.8, k)
            self.assertLess(d["hover"]["len"], d["cruise"]["len"], k + ": short in a hover, long at cruise")
            self.assertLess(d["cruise"]["len"], d["boost"]["len"], k + ": longer on a boost")
            self.assertGreater(d["boost"]["trail"], 5, k + ": a boost leaves a trail")
            self.assertEqual(d["cruise"]["trail"], 0, k)
            self.assertEqual(d["cruise"]["dust"], 0, k + ": no dust up high")
            self.assertGreater(r["dustLow"], 8, k + ": a dust ring hovering low")
        self.assertEqual(self.o["portrait"], 0, "not in a scene (a portrait): no flames")

    def test_poses_stay_finite_with_odd_inputs_and_clocks(self):
        self.assertEqual(self.o["bad"], [])
        self.assertEqual(self.o["odd"], 6)
        self.assertGreater(self.o["posed"], 36*8*10)

    def test_every_suit_up_style_ends_on_the_body(self):
        seq = self.o["seq"]
        self.assertEqual(len(seq), 2*6*4*2)
        for k, s in seq.items():
            self.assertTrue(s["done"], k)
            self.assertTrue(s["finite"], k)
            self.assertEqual(s["left"], 0, k + ": its pieces are gone once it ends")
            if k.endswith("/off"):
                self.assertTrue(s["stripped"], k + ": off strips the layer")
                self.assertAlmostEqual(s["scale"], 1, places=5)
                continue
            self.assertTrue(s["shown"], k + ": the merged armour shows once the pieces land")
            self.assertGreater(s["locks"], 3, k)
            self.assertLess(s["steps"], 400, k)

    def test_docking_parks_the_suit_and_unsuits_you(self):
        d = self.o["dock"]
        self.assertTrue(all(d["odd"]), "park / unpark with nothing worn or nothing at all: null, no crash")
        self.assertEqual(len(d["runs"]), 6)
        for r in d["runs"]:
            self.assertTrue(r["done"] and r["stripped"], r["f"] + ": the reverse completes and the layer comes off")
            self.assertLess(r["steps"], 400, r["f"])
            self.assertEqual(r["left"], 0, r["f"] + ": its pieces are gone")
            self.assertTrue(1 <= r["draws"] <= 4, r["f"] + ": the parked suit is the armour layer, 4 draws at most")
            self.assertEqual(r["after"], 0, r["f"] + ": unpark frees it (twice is fine)")
            self.assertTrue(r["finite"] and r["fade"], r["f"] + ": finite, and the eyes fade")
            self.assertFalse(r["tilt"] or r["posed"], r["f"] + ": nothing left posed or tilted")
            self.assertAlmostEqual(r["scale"], 1, places=5)
        self.assertLessEqual(d["rig"], 2, "the gantry: 2 draws")
        self.assertEqual(d["pk"], [None, 1.25, 1.25, 2, None, None, None, None, 2], "parked: kept beside the look, odd values clear it")
        a = d["auto"]
        self.assertTrue(a["done"] and a["mode"] == "landed", "the auto-dock lands")
        self.assertLess(a["off"], 1e-6, "on the dock")
        self.assertGreaterEqual(a["top"], 46 - 1e-6, "climbs over the roof first")
        self.assertEqual(a["plan"], [None, None])
        self.assertTrue(a["again"])
        self.assertFalse(a["none"])
        s = read("games", "hq3d.js")
        self.assertIn('if(EXO.auto && (inp.fwd || inp.back || inp.left || inp.right)) exoAutoCancel(', s, "WASD hands it back")
        self.assertIn('if(EXO.auto && e.key === "Escape")', s, "and Esc")
        self.assertIn("exoLand(); avatar.hy = A.R.dock.y;", s)
        self.assertIn("    exoDock(A.R);", s, "landed by the auto-dock: docked, and unsuited")
        self.assertIn("XO.me.on = false;", s)

    def test_styles_presence_and_who_wears_a_suit(self):
        o = self.o
        for e, d in o["rt"]:
            self.assertEqual(e, d)
        self.assertEqual(o["refused"], 11)
        st = {f: [b, c] for f, b, c in o["styles"]}
        self.assertEqual(st["sentinel"], ["gantry", "summon"])
        self.assertEqual(st["stratos"], ["gantry", "summon"])
        self.assertEqual(st["bulwark"], ["drop", "drop"])
        self.assertEqual(st["flux"], ["flow", "flow"])
        self.assertEqual(o["wanted"][0], None, "not suited: your own body")
        self.assertEqual(o["wanted"][1]["f"], 2, "a peer's ex picks their suit")
        self.assertIsNone(o["wanted"][3], "and none once they take it off")
        self.assertEqual(o["sound"], ["function", False, False, "quiet"], "no engine, no audio: silent, no crash")


class ExoWiring(unittest.TestCase):
    def test_the_page_loads_and_sends_the_suit(self):
        hq = read("ui", "app", "22-hq.js")
        for f in ("hqexo", "hqexoride", "hqexohud"):
            self.assertIn('"%s"' % f, hq)
        self.assertIn('hqNetCan("exo")', hq)
        self.assertIn("msg.ex=ex.slice()", hq)

    def test_hq3d_builds_suits_and_takes_the_keys(self):
        s = read("games", "hq3d.js")
        self.assertIn("XO.wanted(key)", s)
        self.assertIn("XO.wear(THREE, ch, l)", s, "a suit is armour over the character, not a body of its own")
        self.assertNotIn("XO.build(", s)
        self.assertIn("HQV.hqExo.peer(p.u, p.ex)", s)
        self.assertIn('e.code !== "KeyU"', s)
        self.assertIn("if(exoKey(e)) return;", s)
        self.assertLess(s.index("if(exoKey(e)) return;"), s.index("if(petsKey(e)) return;"), "U: the suit's before a pet's")
        self.assertIn("ctx.exoBay", s)
        self.assertIn("XO.sound(avatar.ch, dt)", s, "your own suit's sound, each frame")
        x = read("games", "hqexo.js")
        self.assertIn("E.audioOut()", x, "the suit's sound goes through the engine's shared output (volume, mute, calm)")
        self.assertIn("ua && !ua.hasBeenActive", x, "and never before a gesture")
        self.assertNotIn("new AudioContext", x)
        self.assertNotIn("fetch(", x)
        self.assertIn("EXO.black = 6", s, "the cut to black: six frames")
        lob = read("games", "hqlobby.js")
        self.assertIn("HQV.hqExo.bay(c, w,", lob)
        self.assertIn("w.use = function(p)", lob)
        cam = read("games", "camrig.js")
        self.assertIn("exo:     {", cam)
        self.assertIn("<kbd>U</kbd> summons your exosuit", read("index.html"))

    def test_the_customiser_opens_at_the_kiosk_and_from_the_side_panel(self):
        s = read("games", "hq3d.js")
        self.assertIn('if(what === "kiosk") return exoPanel("bay");', s)
        self.assertIn("inst.exoPanel = function()", s)
        self.assertIn('id="hqExoBtn"', read("index.html"))
        self.assertIn('$("hqExoBtn")', read("ui", "app", "22-hq.js"))
        self.assertIn("z-index:99;", read("games", "hqexo.js"), "above the page's overlays (z 80 scrims)")

    def test_go_to_flies_by_air_while_suited(self):
        city = read("games", "hqcity3d.js")
        self.assertIn('return m && m.exo ? "exo" :', city, "suited, the route is by air, not by road")
        self.assertIn('if(route.mode === "exo"){', city)
        self.assertIn("w.exoGuide = function()", city)
        self.assertIn('" · bearing "', city)
        self.assertIn("exo: exoNav()", read("games", "hq3d.js"))
        hud = read("games", "hqexohud.js")
        self.assertIn("function draw(S, cam, targets, frameId, tint, wp)", hud)
        self.assertIn("cx.translate(0, tY)", hud, "the heading tape moves below the nav banner")
        self.assertIn("cur.exoGuide()", read("games", "hq3d.js"))
        self.assertIn("info.quiet", read("games", "hqnavui.js"), "a countdown is not spoken every frame")

    def test_the_arena_keeps_ex(self):
        proto = read("backend", "src", "protocol.rs")
        self.assertEqual(proto.count('"airliner", "exo", "boombox"'), 2)
        hq = read("backend", "src", "valley", "hq.rs")
        self.assertIn("fn read_exo(", hq)
        self.assertIn('m.insert("ex".into()', hq)


if __name__ == "__main__":
    unittest.main()
