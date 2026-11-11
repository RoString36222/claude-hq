/* Claude HQ: the 3D people (HQ 3.41). Your character, peers, crew and riders, built from the Quaternius "Ultimate
 * Modular" characters (CC0, games/people/LICENSE-quaternius.txt; packed by tools/pack_people.py) with a soft toy
 * look: our own smooth head (big eyes, small nose, fitted hair styles) on the pack's bodies, flat clothing colours,
 * and a real humanoid skeleton (elbows, knees, fingers) so riders hold the grips and stand on the pegs.
 *
 * Same contract as games/avatar3d.js (which delegates here): the ten-number spec is unchanged
 *   [base, skin, hairColor, outfitColor, hairStyle, headwear, accessory, eyes, background, outfitStyle]
 * and build() resolves to {o, mixer, acts, cur, spec, L, update(t)} with o CH_H (0.72) tall, so everything that
 * scales a person by 1.7 / 0.72 keeps working, and acts holds idle / walk / sprint / sit / emote-yes.
 * Extras for code that knows the new rig: rig "uni", bones (by sanitised name: UpperArmL, LowerLegR, ...),
 * legLen {L, R}, head {c, rx, ry, rz} (head-bone space), and the IK helpers in HQV.people3d.ik.
 *
 *   HQV.people3d.build(spec) -> Promise<character>
 *   HQV.people3d.ik.twoBone(upper, lower, end, target, pole)   world-space two-bone solve
 *   HQV.people3d.ik.seat(ch, w)   w = {seat, gripL, gripR, pegL, pegR} world points (THREE.Vector3): hips on the
 *                                 seat, a forward lean, hands on the grips (fingers curled), feet on the pegs
 *   HQV.people3d.ik.reach(ch, side, target, pole) / grip(ch, side, amount)
 *   HQV.people3d.FILES / TOP (each outfit's recolourable top material)
 */
(function(){
"use strict";
var HQV = window.HQV = window.HQV || {};
var E = HQV.engine;
if(!E){ return; }

var FILES = ["woman-casual", "man-hoodie", "woman-adventurer", "man-adventurer", "woman-worker", "man-casual"];
var FEMALE = [true, false, true, false, true, false];
// the material that takes the outfit colour, per outfit (the rest keep the pack's own colours)
var TOP = {"woman-casual": ["White"], "man-hoodie": ["Purple"], "woman-adventurer": ["Green", "LightGreen"],
           "man-adventurer": ["Green"], "woman-worker": ["Worker_Vest"], "man-casual": ["Red_Dark"]};
var CH_H = 0.72;          // drawn height in model units (hq3d draws people 1.7 m: scale 1.7 / CH_H)
var HEAD_K = 2.0;         // head scale over the pack's: the toy proportions
var ANIM = {idle: "Idle", walk: "Walk", sprint: "Run", "emote-yes": "Wave"};

function A3(){ return HQV.avatar3d || {}; }
function hexOf(pal, i){ var p = (A3().PALETTES || {})[pal]; return p && i > 0 && p[i] ? p[i] : null; }

/* ---------- loading ---------- */
var ANIMS_P = null;
function animsOf(L){
  // scale tracks are dropped: our bigger head and hands are bone scales the clips must not reset
  return ANIMS_P || (ANIMS_P = E.loadGlb(L, "people", "anims").then(function(g){
    return (g.animations || []).map(function(c){
      var k = c.clone(); k.tracks = k.tracks.filter(function(t){ return !/\.scale$/.test(t.name); }); return k;
    });
  },
    function(e){ ANIMS_P = null; throw e; }));
}

/* ---------- IK (world space) ---------- */
function ikLib(THREE){
  var a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3(), q = new THREE.Quaternion(),
      qw = new THREE.Quaternion(), qp = new THREE.Quaternion();
  // turn `bone` so the direction from it to world point `from` swings onto `to`
  function aim(bone, from, to){
    bone.getWorldPosition(a);
    var d0 = from.clone().sub(a), d1 = to.clone().sub(a);
    if(d0.lengthSq() < 1e-12 || d1.lengthSq() < 1e-12){ return; }
    q.setFromUnitVectors(d0.normalize(), d1.normalize());
    bone.getWorldQuaternion(qw); qw.premultiply(q);
    bone.parent.getWorldQuaternion(qp).invert();
    bone.quaternion.copy(qp.multiply(qw));
    bone.updateMatrixWorld(true);
  }
  // upper -> lower -> end reaches target, the middle joint bending toward pole
  function twoBone(upper, lower, end, target, pole){
    upper.updateMatrixWorld(true);
    upper.getWorldPosition(a); lower.getWorldPosition(b); end.getWorldPosition(c);
    var l1 = a.distanceTo(b), l2 = b.distanceTo(c), toT = target.clone().sub(a);
    var d = Math.min(l1 + l2 - 1e-4, Math.max(Math.abs(l1 - l2) + 1e-4, toT.length()));
    var u = toT.normalize(), v = pole.clone().sub(a);
    v.sub(u.clone().multiplyScalar(v.dot(u)));
    if(v.lengthSq() < 1e-10){ v.set(0, 0, 1); } v.normalize();
    var cosA = (l1*l1 + d*d - l2*l2) / (2*l1*d), sinA = Math.sqrt(Math.max(0, 1 - cosA*cosA));
    var knee = a.clone().addScaledVector(u, l1*cosA).addScaledVector(v, l1*sinA);
    aim(upper, b.clone(), knee);
    end.getWorldPosition(c);
    aim(lower, c.clone(), target);
  }
  return {aim: aim, twoBone: twoBone};
}

// the shin ends at a virtual ankle (the rig's feet are IK controls under Root, not children of the shin)
function legTo(ch, side, target, pole){
  var THREE = ch.L.THREE, B = ch.bones, K = ikLib(THREE), shin = B["LowerLeg" + side], foot = B["Foot" + side];
  if(!shin || !foot){ return; }
  var ankle = new THREE.Object3D();
  var s = new THREE.Vector3(); shin.getWorldScale(s);
  ankle.position.set(0, ch.legLen[side] / (s.y || 1), 0);
  shin.add(ankle);
  K.twoBone(B["UpperLeg" + side], shin, ankle, target, pole);
  var at = ankle.getWorldPosition(new THREE.Vector3());
  shin.remove(ankle);
  foot.position.copy(foot.parent.worldToLocal(at));
  foot.updateMatrixWorld(true);
}
function reach(ch, side, target, pole){
  var B = ch.bones, K = ikLib(ch.L.THREE);
  if(B["UpperArm" + side]){ K.twoBone(B["UpperArm" + side], B["LowerArm" + side], B["Wrist" + side], target, pole); }
}
function grip(ch, side, amount){
  var B = ch.bones, k = (amount == null ? 0.85 : amount) * 1.1, sgn = side === "L" ? -1 : 1;
  ["Index", "Middle", "Ring", "Pinky"].forEach(function(f){
    for(var j = 1; j <= 3; j++){ var b = B[f + j + side]; if(b){ b.rotation.z += sgn * k; } }
  });
  var t = B["Thumb2" + side]; if(t){ t.rotation.z += sgn * k * 0.5; }
}
// Seat on a vehicle: w = {seat, gripL, gripR, pegL, pegR} in world space. Call after the clips for this frame.
function seat(ch, w, opts){
  opts = opts || {};
  var THREE = ch.L.THREE, B = ch.bones, o = ch.o;
  if(!B.Hips){ return; }
  o.updateMatrixWorld(true);
  var hips = B.Hips.getWorldPosition(new THREE.Vector3());
  var lift = opts.hipLift != null ? opts.hipLift : 0.04 * (ch.scaleW || 1);
  o.position.add(w.seat.clone().sub(hips)).add(new THREE.Vector3(0, lift, 0));
  o.updateMatrixWorld(true);
  var lean = opts.lean != null ? opts.lean : 0.5;
  if(B.Abdomen){ B.Abdomen.rotation.x += lean * 0.5; }
  if(B.Chest){ B.Chest.rotation.x += lean * 0.5; }
  if(B.Neck){ B.Neck.rotation.x -= lean * 0.7; }
  o.updateMatrixWorld(true);
  var oq = o.getWorldQuaternion(new THREE.Quaternion());
  var fwd = new THREE.Vector3(0, 0, 1).applyQuaternion(oq), up = new THREE.Vector3(0, 1, 0);
  var side = new THREE.Vector3(1, 0, 0).applyQuaternion(oq);
  ["L", "R"].forEach(function(s){
    var sg = s === "L" ? 1 : -1, peg = s === "L" ? w.pegL : w.pegR, gr = s === "L" ? w.gripL : w.gripR;
    if(peg){
      var kneePole = peg.clone().addScaledVector(fwd, 0.6).addScaledVector(up, 0.5).addScaledVector(side, sg * 0.15);
      legTo(ch, s, peg.clone().addScaledVector(up, 0.06 * (ch.scaleW || 1)).addScaledVector(fwd, -0.03 * (ch.scaleW || 1)), kneePole);
    }
    if(gr){
      var elbow = gr.clone().addScaledVector(side, sg * 0.5).addScaledVector(up, -0.3).addScaledVector(fwd, -0.4);
      reach(ch, s, gr, elbow);
      grip(ch, s, opts.grip);
    }
  });
  o.updateMatrixWorld(true);
}

/* ---------- the toy head ---------- */
// the old head in head-bone space: the bind-pose box of skin vertices weighted to the Head bone
function skullBox(THREE, root, head){
  var box = new THREE.Box3(), v = new THREE.Vector3();
  root.traverse(function(m){
    if(!m.isSkinnedMesh){ return; }
    var hi = m.skeleton.bones.indexOf(head);
    if(hi < 0){ return; }
    var mats = Array.isArray(m.material) ? m.material : [m.material];
    if(!mats.some(function(x){ return /^skin$/i.test(x.name || ""); })){ return; }
    var g = m.geometry, p = g.attributes.position, si = g.attributes.skinIndex, sw = g.attributes.skinWeight;
    var toBone = m.skeleton.boneInverses[hi].clone().multiply(m.bindMatrix);
    for(var i = 0; i < p.count; i++){
      var wt = 0;
      for(var k = 0; k < 4; k++){ if(si.getComponent(i, k) === hi){ wt += sw.getComponent(i, k); } }
      if(wt > 0.9){ box.expandByPoint(v.fromBufferAttribute(p, i).applyMatrix4(toBone)); }
    }
  });
  return box.isEmpty() ? null : box;
}

function mat(THREE, hex, rough, extra){
  return new THREE.MeshStandardMaterial(Object.assign({color: hex, roughness: rough == null ? 0.7 : rough, metalness: 0}, extra || {}));
}

// smooth skull shape: the sphere with a softer, narrower jaw; k (number or fn of the unit direction) scales it
function skullGeo(THREE, rx, ry, rz, k){
  var g = new THREE.SphereGeometry(1, 40, 28), p = g.attributes.position, d = new THREE.Vector3();
  for(var i = 0; i < p.count; i++){
    d.fromBufferAttribute(p, i);
    var jaw = d.y < 0 ? 1 - 0.16 * d.y * d.y : 1, kk = typeof k === "function" ? k(d) : k;
    p.setXYZ(i, d.x * rx * jaw * kk, d.y * ry * kk, d.z * rz * jaw * kk);
  }
  g.computeVertexNormals();
  return g;
}

function toyHead(L, skull, spec, female){
  var THREE = L.THREE, grp = new THREE.Group(); grp.name = "toy-head";
  var c = skull.getCenter(new THREE.Vector3()), sz = skull.getSize(new THREE.Vector3());
  var rx = sz.x * 0.5, ry = sz.y * 0.5, rz = sz.z * 0.44;
  function at(x, y, z){ return new THREE.Vector3(c.x + x*rx, c.y + y*ry, c.z + z*rz); }
  var chrome = spec[1] === 7;
  var skinHex = hexOf("skin", spec[1]) || "#f1c8a6", hairHex = hexOf("hairColor", spec[2]) || (female ? "#6b4228" : "#3a2a20");
  var skin = chrome ? new THREE.MeshStandardMaterial({color: "#c9d1db", roughness: 0.2, metalness: 0.9}) : mat(THREE, skinHex, 0.65);
  var hairM = mat(THREE, hairHex, 0.7), lit = spec[7] === 1;
  var eyeM = lit ? new THREE.MeshStandardMaterial({color: "#5ff3ff", emissive: "#5ff3ff", emissiveIntensity: 1.4}) : mat(THREE, "#2a1c16", 0.3);
  var head = new THREE.Mesh(skullGeo(THREE, rx, ry, rz, 1), skin); head.position.copy(c); grp.add(head);
  // a neck down into the collar (the pack's own neck went with its head)
  var neck = new THREE.Mesh(new THREE.CylinderGeometry(rx * 0.36, rx * 0.42, ry * 0.9, 16), skin);
  neck.position.copy(at(0, -1.05, -0.08)); grp.add(neck);
  [-1, 1].forEach(function(sx){
    var eye = new THREE.Mesh(new THREE.SphereGeometry(1, 20, 14), eyeM);
    eye.scale.set(rx * 0.11, ry * 0.15, rz * 0.06); eye.position.copy(at(sx * 0.36, -0.02, 0.93)); eye.rotation.y = sx * 0.35;
    grp.add(eye);
    if(!lit){
      var glint = new THREE.Mesh(new THREE.SphereGeometry(1, 10, 8), new THREE.MeshBasicMaterial({color: 0xffffff}));
      glint.scale.setScalar(rx * 0.03); glint.position.copy(at(sx * 0.33, 0.04, 0.985)); grp.add(glint);
    }
    var brow = new THREE.Mesh(new THREE.CapsuleGeometry(rx * 0.025, rx * 0.16, 4, 8), hairM);
    brow.rotation.set(0, sx * 0.35, Math.PI / 2 + sx * 0.12); brow.position.copy(at(sx * 0.37, 0.24, 0.93)); grp.add(brow);
    var ear = new THREE.Mesh(new THREE.SphereGeometry(1, 14, 10), skin);
    ear.scale.set(rx * 0.08, ry * 0.17, rz * 0.13); ear.position.copy(at(sx * 0.98, -0.06, -0.05)); grp.add(ear);
  });
  var nose = new THREE.Mesh(new THREE.SphereGeometry(1, 14, 10), skin);
  nose.scale.set(rx * 0.07, ry * 0.06, rz * 0.06); nose.position.copy(at(0, -0.22, 0.99)); grp.add(nose);
  var mouth = new THREE.Mesh(new THREE.TorusGeometry(rx * 0.09, rx * 0.017, 6, 16, Math.PI), mat(THREE, "#8a3b32", 0.5));
  mouth.rotation.set(-0.25, 0, Math.PI); mouth.scale.z = 0.3; mouth.position.copy(at(0, -0.40, 0.875)); grp.add(mouth);
  hairFor(THREE, grp, spec, female, hairM, c, rx, ry, rz, at);
  wear(THREE, grp, spec, at, rx, ry, rz, c);
  grp.traverse(function(m){ if(m.isMesh){ m.castShadow = true; } });
  return {g: grp, c: c, rx: rx, ry: ry, rz: rz};
}

// hairStyle: 0 own (women: fringe + tied ponytail; men: short crop), 1 shaved, 2 neon crest
function hairFor(THREE, grp, spec, female, hairM, c, rx, ry, rz, at){
  var style = spec[4] | 0, hat = spec[5] | 0;
  var shell = function(fringe, back){
    return skullGeo(THREE, rx, ry, rz, function(d){
      var face = d.z > 0.12 && d.y < (fringe ? 0.40 : 0.48) - 0.3 * Math.max(0, Math.abs(d.x) - 0.35);
      var ears = Math.abs(d.x) > 0.75 && d.y < 0.08 && d.z > -0.35;
      var neck = d.y < back;
      if(face || ears || neck){ return 0.9; }
      return 1.07 + (d.y > 0.4 ? 0.04 * (d.y - 0.4) : 0) + (fringe && d.z > 0.4 && d.y > 0.36 ? 0.03 : 0);
    });
  };
  var add = function(g, m){ var h = new THREE.Mesh(g, m || hairM); h.position.copy(c); grp.add(h); return h; };
  if(style === 1){
    add(skullGeo(THREE, rx, ry, rz, function(d){ return (d.z > 0.2 && d.y < 0.5) || d.y < -0.2 || (Math.abs(d.x) > 0.75 && d.y < 0.1) ? 0.95 : 1.012; }));
    return;
  }
  if(style === 2){
    var neon = new THREE.MeshStandardMaterial({color: "#5ff3ff", emissive: "#5ff3ff", emissiveIntensity: 1.1, roughness: 0.4});
    add(skullGeo(THREE, rx, ry, rz, function(d){ return (d.z > 0.2 && d.y < 0.5) || d.y < -0.2 || (Math.abs(d.x) > 0.75 && d.y < 0.1) ? 0.95 : 1.01; }));
    for(var i = 0; i < 7; i++){
      var t = i / 6, a = -0.6 + t * 2.3, spike = new THREE.Mesh(new THREE.ConeGeometry(rx * 0.12, ry * (0.42 - 0.1 * Math.abs(t - 0.4)), 8), neon);
      spike.position.set(c.x, c.y + Math.cos(a) * ry * 1.02, c.z + Math.sin(a) * rz * 1.02);
      spike.rotation.x = a; grp.add(spike);
    }
    return;
  }
  add(shell(true, female ? -0.35 : -0.15));
  if(female && hat !== 4 && hat !== 1){
    var pts = [];
    for(var j = 0; j <= 12; j++){ var u = j / 12; pts.push(new THREE.Vector2(Math.sin(Math.min(1, u * 1.6) * Math.PI * 0.5) * rx * 0.42 * (1 - u * 0.55) + 0.002, -u * ry * 1.2)); }
    var tail = new THREE.Mesh(new THREE.LatheGeometry(pts, 18), hairM);
    tail.position.copy(at(0, 0.48, -1.0)); tail.rotation.x = 0.75;
    var tie = new THREE.Mesh(new THREE.TorusGeometry(rx * 0.12, rx * 0.04, 8, 16), mat(THREE, "#2b2b30", 0.6));
    tie.position.copy(tail.position); tie.rotation.x = Math.PI / 2 + 0.75;
    grp.add(tail, tie);
  }
}

// headwear (1 beanie, 2 cap, 3 headband, 4 party hat, 5 neural halo) and accessory (1 round glasses, 2 shades, 3 AR visor)
function wear(THREE, grp, spec, at, rx, ry, rz, c){
  var hw = spec[5] | 0, acc = spec[6] | 0, outfit = hexOf("outfitColor", spec[3]) || "#3f6fb3";
  if(hw === 1){
    var beanie = new THREE.Mesh(skullGeo(THREE, rx, ry, rz, function(d){ return d.y > 0.18 ? 1.12 : 0.9; }), mat(THREE, outfit, 0.9));
    beanie.position.copy(c); grp.add(beanie);
    var cuff = new THREE.Mesh(new THREE.TorusGeometry(1, 0.09, 8, 32), mat(THREE, outfit, 0.9));
    cuff.scale.set(rx * 1.08, rz * 1.08, ry * 0.9); cuff.rotation.x = Math.PI / 2; cuff.position.copy(at(0, 0.22, 0)); grp.add(cuff);
    var pom = new THREE.Mesh(new THREE.SphereGeometry(rx * 0.16, 12, 10), mat(THREE, "#f2f0ea", 1)); pom.position.copy(at(0, 1.18, 0)); grp.add(pom);
  } else if(hw === 2){
    var crown = new THREE.Mesh(skullGeo(THREE, rx, ry, rz, function(d){ return d.y > 0.25 ? 1.1 : 0.9; }), mat(THREE, outfit, 0.8));
    crown.position.copy(c); grp.add(crown);
    var peak = new THREE.Mesh(new THREE.CylinderGeometry(rx * 0.62, rx * 0.62, ry * 0.035, 24, 1, false, -Math.PI / 2, Math.PI), mat(THREE, outfit, 0.8));
    peak.position.copy(at(0, 0.28, 0.82)); peak.rotation.x = 0.12; grp.add(peak);
  } else if(hw === 3){
    var band = new THREE.Mesh(new THREE.TorusGeometry(1, 0.06, 8, 40), mat(THREE, outfit, 0.8));
    band.scale.set(rx * 1.09, rz * 1.09, ry); band.rotation.x = Math.PI / 2 - 0.12; band.position.copy(at(0, 0.38, 0.02)); grp.add(band);
  } else if(hw === 4){
    var cone = new THREE.Mesh(new THREE.ConeGeometry(rx * 0.42, ry * 1.0, 20), mat(THREE, "#ff5fa2", 0.6));
    cone.position.copy(at(0.15, 1.35, 0)); cone.rotation.z = -0.2; grp.add(cone);
  } else if(hw === 5){
    var halo = new THREE.Mesh(new THREE.TorusGeometry(rx * 0.75, rx * 0.04, 8, 40),
      new THREE.MeshStandardMaterial({color: "#5ff3ff", emissive: "#5ff3ff", emissiveIntensity: 1.5}));
    halo.rotation.x = Math.PI / 2; halo.position.copy(at(0, 1.45, 0)); halo.userData.spin = true; grp.add(halo);
  }
  if(acc === 1 || acc === 2){
    var frame = mat(THREE, acc === 1 ? "#3b2a22" : "#111214", 0.4);
    var lens = acc === 2 ? new THREE.MeshStandardMaterial({color: "#141518", roughness: 0.1, metalness: 0.6}) : null;
    [-1, 1].forEach(function(sx){
      var ring = new THREE.Mesh(new THREE.TorusGeometry(rx * 0.17, rx * 0.022, 8, 24), frame);
      ring.position.copy(at(sx * 0.36, -0.02, 1.02)); ring.rotation.y = sx * 0.3; grp.add(ring);
      if(lens){ var l = new THREE.Mesh(new THREE.CircleGeometry(rx * 0.16, 20), lens); l.position.copy(ring.position); l.rotation.y = sx * 0.3; grp.add(l); }
    });
    var bridge = new THREE.Mesh(new THREE.CylinderGeometry(rx * 0.015, rx * 0.015, rx * 0.36, 6), frame);
    bridge.rotation.z = Math.PI / 2; bridge.position.copy(at(0, 0.0, 1.06)); grp.add(bridge);
  } else if(acc === 3){
    var visor = new THREE.Mesh(new THREE.CylinderGeometry(1, 1, ry * 0.26, 32, 1, true, -1.1, 2.2),
      new THREE.MeshStandardMaterial({color: "#5ff3ff", emissive: "#2aa9c9", emissiveIntensity: 0.9, transparent: true, opacity: 0.6, side: THREE.DoubleSide}));
    visor.scale.set(rx * 1.04, 1, rz * 1.06); visor.rotation.y = Math.PI / 2; visor.position.copy(at(0, 0.0, 0)); grp.add(visor);
  }
}

/* ---------- the body ---------- */
function recolour(L, mesh, spec, file){
  var THREE = L.THREE, mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
  var skin = hexOf("skin", spec[1]), chrome = spec[1] === 7, top = hexOf("outfitColor", spec[3]), tops = TOP[file] || [];
  var out = mats.map(function(m0){
    var m = m0.clone(), name = m.name || "";
    m.flatShading = false; m.roughness = Math.max(0.55, m.roughness == null ? 0.7 : m.roughness); m.metalness = 0;
    if(/^skin/i.test(name)){
      if(chrome){ m.color.set("#c9d1db"); m.metalness = 0.9; m.roughness = 0.2; }
      else if(skin){ m.color.set(skin); if(/darker/i.test(name)){ m.color.multiplyScalar(0.85); } }
    } else if(top && tops.indexOf(name) >= 0){ m.color.set(top); }
    if(spec[9] === 1 && tops.indexOf(name) >= 0){ m.emissive = new THREE.Color("#ff3fb4"); m.emissiveIntensity = 0.12; }
    return m;
  });
  mesh.material = Array.isArray(mesh.material) ? out : out[0];
}

// average the normals of coincident vertices: soft shading on the faceted pack meshes, still indexed and skinned
function soften(g){
  g.computeVertexNormals();
  var p = g.attributes.position, n = g.attributes.normal, map = {}, keys = [];
  for(var i = 0; i < p.count; i++){
    var k = Math.round(p.getX(i) * 1e4) + "," + Math.round(p.getY(i) * 1e4) + "," + Math.round(p.getZ(i) * 1e4);
    var a = map[k];
    if(!a){ a = map[k] = [0, 0, 0, []]; keys.push(k); }
    a[0] += n.getX(i); a[1] += n.getY(i); a[2] += n.getZ(i); a[3].push(i);
  }
  keys.forEach(function(k){
    var a = map[k], l = Math.hypot(a[0], a[1], a[2]) || 1;
    a[3].forEach(function(i){ n.setXYZ(i, a[0] / l, a[1] / l, a[2] / l); });
  });
  n.needsUpdate = true;
}

// a static clip from the current pose of the given bones (quaternions) and foot controls (positions)
function poseClip(THREE, name, bones, moved){
  var tracks = [];
  bones.forEach(function(b){
    tracks.push(new THREE.QuaternionKeyframeTrack(b.name + ".quaternion", [0, 1], b.quaternion.toArray().concat(b.quaternion.toArray())));
  });
  moved.forEach(function(b){
    tracks.push(new THREE.VectorKeyframeTrack(b.name + ".position", [0, 1], b.position.toArray().concat(b.position.toArray())));
  });
  return new THREE.AnimationClip(name, 1, tracks);
}

// "sit": thighs level, shins down, hips at a chair's height (0.45 m when drawn 1.7 m tall, like the old rig's sit)
function makeSit(ch, idle){
  var THREE = ch.L.THREE, B = ch.bones, o = ch.o, inner = ch.inner;
  var act = ch.mixer.clipAction(idle); act.play(); ch.mixer.update(0); act.stop();
  var keep = {}; ["Body", "UpperLegL", "UpperLegR", "LowerLegL", "LowerLegR", "FootL", "FootR"].forEach(function(n){
    if(B[n]){ keep[n] = {q: B[n].quaternion.clone(), p: B[n].position.clone()}; }
  });
  o.updateMatrixWorld(true);
  var want = 0.45 * CH_H / 1.7;     // hip height in o's units
  var hipsW = B.Hips.getWorldPosition(new THREE.Vector3()), invO = o.matrixWorld.clone().invert();
  var hipsO = hipsW.clone().applyMatrix4(invO);
  var drop = hipsO.y - want, s = inner.scale.y;
  B.Body.position.y -= drop / s;
  o.updateMatrixWorld(true);
  var fwd = new THREE.Vector3(0, 0, 1), up = new THREE.Vector3(0, 1, 0);
  ["L", "R"].forEach(function(sd){
    var hip = B["UpperLeg" + sd].getWorldPosition(new THREE.Vector3());
    var thigh = B["UpperLeg" + sd].getWorldPosition(new THREE.Vector3()).distanceTo(B["LowerLeg" + sd].getWorldPosition(new THREE.Vector3()));
    var foot = new THREE.Vector3(hip.x, 0.012, hip.z + thigh * 1.02).applyMatrix4(o.matrixWorld);
    legTo(ch, sd, foot, hip.clone().add(fwd.clone().multiplyScalar(2)).add(up));
  });
  var clip = poseClip(THREE, "sit", [B.UpperLegL, B.UpperLegR, B.LowerLegL, B.LowerLegR].filter(Boolean),
    [B.Body, B.FootL, B.FootR].filter(Boolean));
  Object.keys(keep).forEach(function(n){ B[n].quaternion.copy(keep[n].q); B[n].position.copy(keep[n].p); });
  return clip;
}

function clampSpec(s){ var A = A3(); return A.clamp ? A.clamp(s) : (s || [0, 0, 0, 0, 0, 0, 0, 0, 0, 0]); }

function build(spec){
  spec = clampSpec(spec);
  var file = FILES[spec[0] | 0] || FILES[0], female = FEMALE[spec[0] | 0];
  return E.lib().then(function(L){
    return Promise.all([E.loadGlb(L, "people", file), animsOf(L)]).then(function(r){
      var THREE = L.THREE, gltf = r[0], clips = r[1];
      var model = L.clone(gltf.scene), bones = {}, heads = [];
      model.traverse(function(n){
        if(n.isBone){ bones[n.name] = n; }
        if(n.isMesh){
          n.castShadow = true; n.frustumCulled = false;
          if(/head/i.test(n.name) || (n.parent && /head/i.test(n.parent.name))){ heads.push(n); return; }
          n.geometry = n.geometry.clone(); soften(n.geometry); recolour(L, n, spec, file);
        }
      });
      model.updateMatrixWorld(true);
      var legLen = {};
      ["L", "R"].forEach(function(s){
        var a = bones["LowerLeg" + s].getWorldPosition(new THREE.Vector3()), f = bones["Foot" + s].getWorldPosition(new THREE.Vector3());
        legLen[s] = a.distanceTo(f) * 0.93;
      });
      var skull = skullBox(THREE, model, bones.Head), head = null;
      heads.forEach(function(m){ m.visible = false; });
      if(bones.Head && skull){
        bones.Head.scale.setScalar(HEAD_K);
        head = toyHead(L, skull, spec, female);
        bones.Head.add(head.g);
      }
      ["WristL", "WristR"].forEach(function(b){ if(bones[b]){ bones[b].scale.setScalar(1.12); } });
      // normalise: o is CH_H tall with its feet at y 0
      var inner = new THREE.Group(); inner.add(model);
      var o = new THREE.Group(); o.add(inner); o.name = "person";
      o.updateMatrixWorld(true);
      var box = new THREE.Box3().setFromObject(o, true), h = box.max.y - box.min.y || 1, k = CH_H / h;
      inner.scale.setScalar(k); inner.position.y = -box.min.y * k;
      // legLen was measured in model units before scaling; IK works in world units
      legLen.L *= k; legLen.R *= k;
      var mixer = new THREE.AnimationMixer(model), acts = {};
      Object.keys(ANIM).forEach(function(n){
        var cl = THREE.AnimationClip.findByName(clips, ANIM[n]);
        if(cl){ acts[n] = mixer.clipAction(cl); }
      });
      var ch = {o: o, inner: inner, model: model, mixer: mixer, acts: acts, cur: null, spec: spec, L: L, rig: "uni",
        bones: bones, legLen: legLen, head: head, scaleW: 1,
        update: function(t){
          if(head && !E.calm()){ head.g.traverse(function(m){ if(m.userData.spin){ m.rotation.z = t * 1.2; } }); }
        }};
      var idle = THREE.AnimationClip.findByName(clips, "Idle");
      if(idle){ try { acts.sit = mixer.clipAction(makeSit(ch, idle)); } catch(e){ /* no sit pose: standing fallback */ } }
      // IK world units scale with how big o is drawn; callers set ch.scaleW = o's world scale when they seat it
      return ch;
    });
  });
}

// the IK helpers need THREE, which arrives with the first build
var IK = {seat: seat, reach: reach, grip: grip, leg: legTo, twoBone: null, aim: null};
HQV.people3d = {FILES: FILES, FEMALE: FEMALE, TOP: TOP, CH_H: CH_H, ik: IK, build: function(spec){
  return build(spec).then(function(ch){
    if(!IK.twoBone){ var K = ikLib(ch.L.THREE); IK.twoBone = K.twoBone; IK.aim = K.aim; }
    return ch;
  });
}};
})();
