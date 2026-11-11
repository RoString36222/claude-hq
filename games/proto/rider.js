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
  const o = gltf.scene;
  const bones = {}, hairMeshes = [];
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
    mats.forEach(m => recolour(m, look));
    n.frustumCulled = false;
    // the pack's shaggy low-poly hair goes; ours (below) is a smooth cap
    if(mats.some(m => /^hair/i.test(m.name || ""))){ hairMeshes.push(n); }
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

  if(bones.Head && hairBox){ bones.Head.add(hairCap(hairBox, look)); }

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
function recolour(m, look){
  const name = (m.name || "").toLowerCase();
  m.flatShading = false; m.roughness = 0.75; m.metalness = 0;
  if(name === "skin"){ m.color.setHex(look.skin); }
  else if(name.startsWith("hair") || name === "eyebrows"){ m.color.setHex(look.hair); }
  else if(name === "white" || name === "purple" || name === "lightblue"){ m.color.setHex(look.top); }
  else if(name === "orange" || name === "grey"){ m.color.setHex(look.legs); }
  else if(name === "brown"){ m.color.setHex(look.shoes); }
  m.needsUpdate = true;
}

// Smooth hair, fitted to the box the pack's hair occupied (head-bone space, +y up, +z forward): a cap over the
// crown that comes lower at the back, a side-swept fringe, and (look.ponytail) a tied tail that droops back.
function hairCap(box, look){
  const grp = new THREE.Group(); grp.name = "hair";
  const mat = new THREE.MeshStandardMaterial({color: look.hair, roughness: 0.7});
  const c = box.getCenter(new THREE.Vector3()), sz = box.getSize(new THREE.Vector3());
  const rx = sz.x * 0.45, ry = sz.y * 0.5, rz = sz.z * 0.47;
  const cap = new THREE.Mesh(new THREE.SphereGeometry(1, 28, 18, 0, Math.PI * 2, 0, Math.PI * 0.56), mat);
  cap.scale.set(rx, ry, rz); cap.position.copy(c).add(new THREE.Vector3(0, -ry * 0.10, -rz * 0.04));
  const nape = new THREE.Mesh(new THREE.SphereGeometry(1, 20, 10, Math.PI * 1.05, Math.PI * 0.9, Math.PI * 0.5, Math.PI * 0.32), mat);
  nape.scale.set(rx * 0.99, ry, rz * 1.0); nape.position.copy(cap.position);
  grp.add(nape);
  const fringe = new THREE.Mesh(new THREE.SphereGeometry(1, 20, 10, -0.9, 1.9, Math.PI * 0.18, Math.PI * 0.3), mat);
  fringe.scale.set(rx * 1.03, ry * 1.0, rz * 1.06); fringe.position.copy(cap.position); fringe.rotation.set(0.05, 0.12, 0.05);
  grp.add(cap, fringe);
  if(look.ponytail){
    const pts = [];
    for(let i = 0; i <= 12; i++){ const t = i / 12; pts.push(new THREE.Vector2(Math.sin(Math.min(1, t * 1.6) * Math.PI * 0.5) * rx * 0.42 * (1 - t * 0.6) + 0.002, -t * ry * 1.5)); }
    const tail = new THREE.Mesh(new THREE.LatheGeometry(pts, 16), mat);
    tail.position.set(c.x, c.y + ry * 0.05, c.z - rz * 1.0); tail.rotation.x = 0.55;
    const tie = new THREE.Mesh(new THREE.TorusGeometry(rx * 0.18, rx * 0.05, 8, 16), new THREE.MeshStandardMaterial({color: 0x2b2b30, roughness: 0.6}));
    tie.position.copy(tail.position).add(new THREE.Vector3(0, -ry * 0.03, -rz * 0.02)); tie.rotation.x = Math.PI / 2 + 0.55;
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
