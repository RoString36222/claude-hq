// The new character: Quaternius "Ultimate Modular" (CC0) humanoid, restyled toward a soft toy look (a bigger head,
// smooth shading, flat clothing colours, an optional ponytail), plus a small two-bone IK so it can sit a vehicle with
// its hands on the grips and its feet on the pegs.
import * as THREE from "three";
import {GLTFLoader} from "../vendor/three-gltf-loader.js";

const loader = new GLTFLoader();

export const LOOKS = {
  rider: {top: 0x8cbf5f, legs: 0x5a5f68, shoes: 0x7a4a2c, hair: 0x6b4228, skin: 0xf1c8a6, ponytail: true},
};

// Load a character, restyle it and return {o, bones, mixer, clips, height}.
export async function loadCharacter(url, look = LOOKS.rider, opts = {}){
  const gltf = await loader.loadAsync(url);
  if(opts.anims){ gltf.animations = (await loader.loadAsync(opts.anims)).animations; }
  const o = gltf.scene;
  const bones = {}, hairMeshes = [], headMeshes = [];
  o.traverse(n => { if(n.isBone){ bones[n.name] = n; } });

  // smooth, soft shading: weld the faceted low-poly vertices and recompute normals
  o.traverse(n => {
    if(!n.isMesh){ return; }
    n.castShadow = true; n.receiveShadow = false;
    const g = n.geometry;
    g.deleteAttribute("normal");
    const keep = {};
    for(const k of Object.keys(g.attributes)){ keep[k] = g.attributes[k]; }
    weldNormals(g);
    const mats = Array.isArray(n.material) ? n.material : [n.material];
    mats.forEach(m => recolour(m, look, n.name));
    n.frustumCulled = false;
    // the pack's shaggy low-poly hair goes; ours (below) is a smooth cap
    if(/head/i.test(n.name) || /head/i.test(n.parent?.name || "")){ headMeshes.push(n); }
  });

  // leg length to the ankle (the rig's feet are IK controls under Root, not children of the shin)
  o.updateMatrixWorld(true);
  const legLen = {};
  for(const s of ["L", "R"]){
    const a = bones[`LowerLeg${s}`].getWorldPosition(new THREE.Vector3()), f = bones[`Foot${s}`].getWorldPosition(new THREE.Vector3());
    legLen[s] = a.distanceTo(f) * 0.93;
  }

  // the hair cap is fitted to the old hair's box in head space before that hair is hidden
  let hairBox = null;
  if(hairMeshes.length && bones.Head){
    const inv = bones.Head.matrixWorld.clone().invert();
    hairBox = new THREE.Box3();
    hairMeshes.forEach(m => { const b = new THREE.Box3().setFromObject(m); hairBox.union(b.applyMatrix4(inv)); m.visible = false; });
  }

  // proportions: a bigger, rounder head and slightly bigger hands, like a stylised toy figure
  const s = opts.headScale ?? 1.35;
  if(bones.Head){ bones.Head.scale.setScalar(s); }
  if(bones.Neck){ bones.Neck.scale.setScalar(1.05); }
  ["WristL", "WristR"].forEach(b => bones[b] && bones[b].scale.setScalar(1.12));

  const skull = skullBox(o, bones.Head);
  if(bones.Head && skull){
    headMeshes.forEach(m => { m.visible = false; });
    bones.Head.add(toyHead(skull, look));
  }

  o.updateMatrixWorld(true);
  const box = new THREE.Box3().setFromObject(o);
  const mixer = new THREE.AnimationMixer(o);
  const clips = Object.fromEntries(gltf.animations.map(c => [c.name, c]));
  return {o, bones, mixer, clips, legLen, height: box.max.y - box.min.y};
}

// Average the normals of coincident vertices (keeps the mesh indexed and skinned) for soft shading.
function weldNormals(g){
  g.computeVertexNormals();
  const p = g.attributes.position, n = g.attributes.normal, map = new Map(), key = i =>
    `${Math.round(p.getX(i) * 1e4)},${Math.round(p.getY(i) * 1e4)},${Math.round(p.getZ(i) * 1e4)}`;
  for(let i = 0; i < p.count; i++){
    const k = key(i); let a = map.get(k);
    if(!a){ a = [0, 0, 0, []]; map.set(k, a); }
    a[0] += n.getX(i); a[1] += n.getY(i); a[2] += n.getZ(i); a[3].push(i);
  }
  for(const [, a] of map){
    const l = Math.hypot(a[0], a[1], a[2]) || 1;
    for(const i of a[3]){ n.setXYZ(i, a[0] / l, a[1] / l, a[2] / l); }
  }
  n.needsUpdate = true;
}

// Material names in the Quaternius casual outfits -> our look.
function recolour(m, look, mesh = ""){
  const name = (m.name || "").toLowerCase();
  if(/feet/i.test(mesh) && name !== "skin"){ m.color.setHex(look.shoes); m.roughness = 0.7; return; }
  m.flatShading = false; m.roughness = 0.75; m.metalness = 0;
  if(name === "skin"){ m.color.setHex(look.skin); }
  else if(name.startsWith("hair") || name === "eyebrows"){ m.color.setHex(look.hair); }
  else if(name === "white" || name === "purple" || name === "lightblue"){ m.color.setHex(look.top); }
  else if(name === "orange" || name === "grey"){ m.color.setHex(look.legs); }
  else if(name === "brown"){ m.color.setHex(look.shoes); }
  m.needsUpdate = true;
}

// The skull in head-bone space: the bind-pose box of the skin vertices weighted mostly to the Head bone.
function skullBox(root, head){
  if(!head){ return null; }
  const box = new THREE.Box3(), v = new THREE.Vector3();
  root.traverse(m => {
    if(!m.isSkinnedMesh){ return; }
    const hi = m.skeleton.bones.indexOf(head);
    if(hi < 0){ return; }
    const mats = Array.isArray(m.material) ? m.material : [m.material];
    if(!mats.some(x => (x.name || "").toLowerCase() === "skin")){ return; }
    const g = m.geometry, p = g.attributes.position, si = g.attributes.skinIndex, sw = g.attributes.skinWeight;
    const toBone = m.skeleton.boneInverses[hi].clone().multiply(m.bindMatrix);
    for(let i = 0; i < p.count; i++){
      let w = 0;
      for(let k = 0; k < 4; k++){ if(si.getComponent(i, k) === hi){ w += sw.getComponent(i, k); } }
      if(w > 0.9){ box.expandByPoint(v.fromBufferAttribute(p, i).applyMatrix4(toBone)); }
    }
  });
  return box.isEmpty() ? null : box;
}

// Our own head, replacing the pack's 334-triangle one: a smooth rounded skull fitted to the old head's box (head-bone
// space, +y up, +z forward), big simple eyes with a catch-light, brows, a small nose and mouth, ears, and hair as a
// shell of the same skull (so it always fits) with a brow hairline, and an optional tied ponytail.
function toyHead(skull, look){
  const grp = new THREE.Group(); grp.name = "toy-head";
  const c = skull.getCenter(new THREE.Vector3()), sz = skull.getSize(new THREE.Vector3());
  const rx = sz.x * 0.5, ry = sz.y * 0.5, rz = sz.z * 0.44;
  const at = (x, y, z) => new THREE.Vector3(c.x + x * rx, c.y + y * ry, c.z + z * rz);
  const skin = new THREE.MeshStandardMaterial({color: look.skin, roughness: 0.65});
  const hairM = new THREE.MeshStandardMaterial({color: look.hair, roughness: 0.7});
  const dark = new THREE.MeshStandardMaterial({color: 0x2a1c16, roughness: 0.3});
  const shape = (k, lift = 0) => {
    const g = new THREE.SphereGeometry(1, 48, 32), p = g.attributes.position, d = new THREE.Vector3();
    for(let i = 0; i < p.count; i++){
      d.fromBufferAttribute(p, i);
      const jaw = d.y < 0 ? 1 - 0.16 * (-d.y) * (-d.y) : 1;     // a softer, narrower jaw
      const kk = typeof k === "function" ? k(d) : k;
      p.setXYZ(i, d.x * rx * jaw * kk, (d.y * ry + lift) * kk, d.z * rz * jaw * kk);
    }
    g.computeVertexNormals();
    return g;
  };
  const head = new THREE.Mesh(shape(1), skin); head.position.copy(c); grp.add(head);
  // eyes: dark ovals with a white catch-light; brows; nose; mouth
  for(const sx of [-1, 1]){
    const eye = new THREE.Mesh(new THREE.SphereGeometry(1, 20, 14), dark);
    eye.scale.set(rx * 0.11, ry * 0.15, rz * 0.06); eye.position.copy(at(sx * 0.36, -0.02, 0.93)); eye.rotation.y = sx * 0.35;
    const glint = new THREE.Mesh(new THREE.SphereGeometry(1, 10, 8), new THREE.MeshBasicMaterial({color: 0xffffff}));
    glint.scale.setScalar(rx * 0.03); glint.position.copy(at(sx * 0.33, 0.04, 0.985));
    const brow = new THREE.Mesh(new THREE.CapsuleGeometry(rx * 0.025, rx * 0.16, 4, 8), hairM);
    brow.rotation.z = Math.PI / 2 + sx * 0.12; brow.position.copy(at(sx * 0.37, 0.24, 0.93)); brow.rotation.y = sx * 0.35;
    const ear = new THREE.Mesh(new THREE.SphereGeometry(1, 14, 10), skin);
    ear.scale.set(rx * 0.08, ry * 0.17, rz * 0.13); ear.position.copy(at(sx * 0.98, -0.06, -0.05));
    grp.add(eye, glint, brow, ear);
  }
  const nose = new THREE.Mesh(new THREE.SphereGeometry(1, 14, 10), skin);
  nose.scale.set(rx * 0.07, ry * 0.06, rz * 0.06); nose.position.copy(at(0, -0.22, 0.99)); grp.add(nose);
  const mouth = new THREE.Mesh(new THREE.TorusGeometry(rx * 0.09, rx * 0.017, 6, 16, Math.PI), new THREE.MeshStandardMaterial({color: 0x8a3b32, roughness: 0.5}));
  mouth.rotation.z = Math.PI; mouth.scale.z = 0.3; mouth.position.copy(at(0, -0.40, 0.875)); mouth.rotation.x = -0.25; grp.add(mouth);
  // hair: the same skull shape, a little bigger, with the face and the neck pulled inside the head
  const hairGeo = shape(d => {
    const face = d.z > 0.12 && d.y < 0.40 - 0.3 * Math.max(0, Math.abs(d.x) - 0.35);
    const ears = Math.abs(d.x) > 0.75 && d.y < 0.08 && d.z > -0.35;
    const neck = d.y < -0.35;
    if(face || ears || neck){ return 0.9; }
    return 1.07 + (d.y > 0.4 ? 0.04 * (d.y - 0.4) : 0) + (d.z > 0.4 && d.y > 0.36 ? 0.03 : 0);
  });
  const hair = new THREE.Mesh(hairGeo, hairM); hair.position.copy(c); grp.add(hair);
  if(look.ponytail){
    const pts = [];
    for(let i = 0; i <= 12; i++){ const t = i / 12; pts.push(new THREE.Vector2(Math.sin(Math.min(1, t * 1.6) * Math.PI * 0.5) * rx * 0.42 * (1 - t * 0.55) + 0.002, -t * ry * 1.2)); }
    const tail = new THREE.Mesh(new THREE.LatheGeometry(pts, 18), hairM);
    tail.position.copy(at(0, 0.48, -1.0)); tail.rotation.x = 0.75;
    const tie = new THREE.Mesh(new THREE.TorusGeometry(rx * 0.12, rx * 0.04, 8, 16), new THREE.MeshStandardMaterial({color: 0x2b2b30, roughness: 0.6}));
    tie.position.copy(tail.position); tie.rotation.x = Math.PI / 2 + 0.75;
    grp.add(tail, tie);
  }
  grp.traverse(m => { if(m.isMesh){ m.castShadow = true; } });
  return grp;
}

// ---- IK -----------------------------------------------------------------------------------------------------------
const _a = new THREE.Vector3(), _b = new THREE.Vector3(), _c = new THREE.Vector3(), _q = new THREE.Quaternion(),
  _qw = new THREE.Quaternion(), _qp = new THREE.Quaternion();

// Rotate `bone` (in world space) so the direction from it to `from` turns toward `to`.
function aimBone(bone, from, to){
  bone.getWorldPosition(_a);
  const d0 = from.clone().sub(_a).normalize(), d1 = to.clone().sub(_a).normalize();
  _q.setFromUnitVectors(d0, d1);
  bone.getWorldQuaternion(_qw);
  _qw.premultiply(_q);
  bone.parent.getWorldQuaternion(_qp).invert();
  bone.quaternion.copy(_qp.multiply(_qw));
  bone.updateMatrixWorld(true);
}

// Two-bone IK: upper -> lower -> end reaches `target`, bending toward `pole` (all world space).
export function solveTwoBone(upper, lower, end, target, pole){
  upper.updateMatrixWorld(true);
  upper.getWorldPosition(_a); lower.getWorldPosition(_b); end.getWorldPosition(_c);
  const l1 = _a.distanceTo(_b), l2 = _b.distanceTo(_c);
  const toT = target.clone().sub(_a), d = THREE.MathUtils.clamp(toT.length(), Math.abs(l1 - l2) + 1e-3, l1 + l2 - 1e-3);
  const u = toT.normalize();
  const v = pole.clone().sub(_a); v.sub(u.clone().multiplyScalar(v.dot(u))).normalize();
  const cosA = (l1 * l1 + d * d - l2 * l2) / (2 * l1 * d), sinA = Math.sqrt(Math.max(0, 1 - cosA * cosA));
  const knee = _a.clone().add(u.clone().multiplyScalar(l1 * cosA)).add(v.multiplyScalar(l1 * sinA));
  aimBone(upper, _b.clone(), knee);
  lower.getWorldPosition(_b); end.getWorldPosition(_c);
  aimBone(lower, _c.clone(), target);
}

// Curl the fingers into a grip (amount 0..1).
export function grip(bones, side, amount = 0.9){
  for(const f of ["Index", "Middle", "Ring", "Pinky"]){
    for(let j = 1; j <= 3; j++){ const b = bones[`${f}${j}${side}`]; if(b){ b.rotation.z += (side === "L" ? -1 : 1) * amount * 1.1; } }
  }
}

// Seat the character on a vehicle: hips at the seat, a forward lean, hands on the grips and feet on the pegs.
// `world` gives the vehicle's anchors in world space.
export function seat(ch, world, opts = {}){
  const B = ch.bones, o = ch.o;
  o.updateMatrixWorld(true);
  // place the root so the hips land on the seat
  const hips = B.Hips.getWorldPosition(new THREE.Vector3());
  o.position.add(world.seat.clone().sub(hips)).add(new THREE.Vector3(0, opts.hipLift ?? 0.07, 0));
  o.updateMatrixWorld(true);
  // lean the upper body forward from the abdomen and chest
  const lean = opts.lean ?? 0.55;
  B.Abdomen.rotation.x += lean * 0.5; B.Chest.rotation.x += lean * 0.5;
  if(B.Neck){ B.Neck.rotation.x -= lean * 0.7; }
  o.updateMatrixWorld(true);
  const fwd = new THREE.Vector3(0, 0, 1).applyQuaternion(o.getWorldQuaternion(new THREE.Quaternion()));
  const up = new THREE.Vector3(0, 1, 0);
  // legs: knees forward and slightly out; the shin ends at a virtual ankle, then the foot control follows it
  for(const s of ["L", "R"]){
    const peg = s === "L" ? world.pegL : world.pegR;
    const knee = peg.clone().add(fwd.clone().multiplyScalar(0.6)).add(up.clone().multiplyScalar(0.5));
    const ankle = new THREE.Object3D();
    ankle.position.set(0, ch.legLen[s] / o.scale.x, 0);
    B[`LowerLeg${s}`].add(ankle);
    const target = peg.clone().add(up.clone().multiplyScalar(0.06)).add(fwd.clone().multiplyScalar(-0.03));
    solveTwoBone(B[`UpperLeg${s}`], B[`LowerLeg${s}`], ankle, target, knee);
    const foot = B[`Foot${s}`], at = ankle.getWorldPosition(new THREE.Vector3());
    foot.position.copy(foot.parent.worldToLocal(at));
    B[`LowerLeg${s}`].remove(ankle);
    // arms: elbows out, slightly down
    const gr = s === "L" ? world.gripL : world.gripR;
    const out = gr.clone().sub(world.seat).setY(0).setZ(0).normalize();
    const elbow = gr.clone().add(out.multiplyScalar(0.5)).add(up.clone().multiplyScalar(-0.3)).add(fwd.clone().multiplyScalar(-0.4));
    solveTwoBone(B[`UpperArm${s}`], B[`LowerArm${s}`], B[`Wrist${s}`], gr, elbow);
    grip(B, s, 0.85);
  }
  o.updateMatrixWorld(true);
}
