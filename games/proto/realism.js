// Realism prototype: one adventure bike with the new rider, one car, in a soft lakeside scene.
// Open /games/proto/realism.html. Drag to orbit, wheel to zoom; buttons pick a view.
import * as THREE from "three";
import {buildAdventureBike} from "./bike.js";
import {loadCharacter, seat, LOOKS} from "./rider.js";
import {buildSportsSaloon} from "./car.js";

const renderer = new THREE.WebGLRenderer({antialias: true, preserveDrawingBuffer: true});
renderer.setPixelRatio(Math.min(2, window.devicePixelRatio));
renderer.setSize(innerWidth, innerHeight);
renderer.shadowMap.enabled = true; renderer.shadowMap.type = THREE.PCFShadowMap;
renderer.toneMapping = THREE.ACESFilmicToneMapping; renderer.toneMappingExposure = 1.05;
document.body.appendChild(renderer.domElement);

const scene = new THREE.Scene();
const SKY = 0xe4ebe6;
scene.background = new THREE.Color(SKY);
scene.fog = new THREE.Fog(SKY, 18, 70);
const camera = new THREE.PerspectiveCamera(32, innerWidth / innerHeight, 0.05, 300);

// light: soft sky fill, a warm key with soft shadows
scene.add(new THREE.HemisphereLight(0xf3f7ff, 0x8a9a5a, 1.25));
const sun = new THREE.DirectionalLight(0xfff3e2, 2.0);
sun.position.set(-6, 10, -4); sun.castShadow = true;
sun.shadow.mapSize.set(2048, 2048); sun.shadow.radius = 4; sun.shadow.bias = -0.0004;
Object.assign(sun.shadow.camera, {left: -5, right: 9, top: 7, bottom: -5, near: 1, far: 40});
scene.add(sun);

// image-based light: a soft studio dome (sky gradient, a bright softbox, a ground bounce) prefiltered by PMREM, so
// metals and paint have something to reflect; generated here, no texture files
{
  const env = new THREE.Scene();
  const dome = new THREE.Mesh(new THREE.SphereGeometry(10, 32, 16), new THREE.MeshBasicMaterial({side: THREE.BackSide, vertexColors: true}));
  const col = [], p = dome.geometry.attributes.position, top = new THREE.Color(0xcfdcec), mid = new THREE.Color(0xf6f4ee), low = new THREE.Color(0xa9b08e);
  for(let i = 0; i < p.count; i++){ const y = p.getY(i) / 10, c = y > 0 ? mid.clone().lerp(top, Math.min(1, y * 1.4)) : mid.clone().lerp(low, Math.min(1, -y * 1.6)); col.push(c.r, c.g, c.b); }
  dome.geometry.setAttribute("color", new THREE.Float32BufferAttribute(col, 3));
  env.add(dome);
  const box = new THREE.Mesh(new THREE.PlaneGeometry(6, 3), new THREE.MeshBasicMaterial({color: 0xffffff, side: THREE.DoubleSide}));
  box.position.set(-3, 6, -4); box.lookAt(0, 0, 0); env.add(box);
  const pm = new THREE.PMREMGenerator(renderer);
  scene.environment = pm.fromScene(env, 0.02).texture;
  scene.environmentIntensity = 0.9;
}

// ---- environment: grassy shore, a turquoise lake, a far hillside with little trees -------------------------------
const ground = new THREE.Mesh(new THREE.PlaneGeometry(80, 80, 40, 40), new THREE.MeshStandardMaterial({color: 0xa9b86a, roughness: 1}));
ground.rotation.x = -Math.PI / 2; ground.receiveShadow = true; scene.add(ground);
const lake = new THREE.Mesh(new THREE.CircleGeometry(22, 64), new THREE.MeshStandardMaterial({color: 0x7fd3c6, roughness: 0.25, metalness: 0.05}));
lake.rotation.x = -Math.PI / 2; lake.position.set(-14, 0.01, 18); scene.add(lake);
const shore = new THREE.Mesh(new THREE.RingGeometry(22, 23.2, 64), new THREE.MeshStandardMaterial({color: 0xd8d6a2, roughness: 1}));
shore.rotation.x = -Math.PI / 2; shore.position.set(-14, 0.012, 18); scene.add(shore);
const hill = new THREE.Mesh(new THREE.CylinderGeometry(60, 64, 6, 64, 1, true), new THREE.MeshStandardMaterial({color: 0xc9cfb8, roughness: 1, side: THREE.BackSide}));
hill.position.set(0, 2.5, 0); scene.add(hill);
const treeMat = new THREE.MeshStandardMaterial({color: 0x9aa58a, roughness: 1});
for(let i = 0; i < 70; i++){
  const a = i / 70 * Math.PI * 2 + Math.sin(i * 7.1) * 0.03, r = 55 + Math.sin(i * 3.7) * 2;
  const t = new THREE.Group();
  const trunk = new THREE.Mesh(new THREE.CylinderGeometry(0.15, 0.2, 2, 6), treeMat); trunk.position.y = 1;
  const crown = new THREE.Mesh(new THREE.SphereGeometry(1.2 + (i % 3) * 0.3, 8, 6), treeMat); crown.position.y = 2.6;
  t.add(trunk, crown); t.position.set(Math.cos(a) * r, 5.2, Math.sin(a) * r); scene.add(t);
}

// ---- the bike and its rider -------------------------------------------------------------------------------------
const bike = buildAdventureBike();
bike.g.position.set(0, 0, 0);
bike.g.rotation.y = 0.0;
scene.add(bike.g);

const stats = {};
let rider = null;
try {
  rider = await loadCharacter("assets/W_Casual.gltf", LOOKS.rider);
  const want = 1.62;   // standing height in metres
  rider.o.scale.setScalar(want / rider.height);
  rider.o.rotation.y = bike.g.rotation.y;
  scene.add(rider.o);
  // a neutral base pose first (first frame of Idle), then seat it
  if(rider.clips.Idle){ const a = rider.mixer.clipAction(rider.clips.Idle); a.play(); rider.mixer.update(0); a.stop(); }
  const w = k => bike.g.localToWorld(bike.anchors[k].clone());
  seat(rider, {seat: w("seat"), gripL: w("gripL"), gripR: w("gripR"), pegL: w("pegL"), pegR: w("pegR")});
} catch(e){ console.error("rider failed", e); }

// ---- the car, with a second character standing beside it for scale -------------------------------------------------
const car = buildSportsSaloon();
car.g.position.set(4.2, 0, 1.0); car.g.rotation.y = -0.35;
scene.add(car.g);
let walker = null;
try {
  walker = await loadCharacter("assets/W_Casual.gltf", Object.assign({}, LOOKS.rider, {top: 0xd9e1e8, legs: 0x3d4a66}));
  walker.o.scale.setScalar(1.62 / walker.height);
  walker.o.position.set(2.75, 0, 2.2); walker.o.rotation.y = -0.6;
  scene.add(walker.o);
  if(walker.clips.Idle){ walker.mixer.clipAction(walker.clips.Idle).play(); }
} catch(e){ console.error("walker failed", e); }

// ---- views, orbit -------------------------------------------------------------------------------------------------
const VIEWS = {
  "Rear 3/4": {target: [0, 0.85, 0.0], az: -2.45, el: 0.16, dist: 4.2},
  "Rear left": {target: [0, 0.85, 0.0], az: 2.55, el: 0.14, dist: 4.0},
  "Side": {target: [0, 0.75, 0.0], az: Math.PI / 2, el: 0.05, dist: 4.4},
  "Front 3/4": {target: [0, 0.85, 0.1], az: 0.7, el: 0.12, dist: 4.0},
  "Rider close": {target: [0, 1.2, 0.0], az: -2.0, el: 0.15, dist: 2.2},
  "Face": {target: [2.75, 1.42, 2.2], az: -0.6, el: 0.05, dist: 1.1},
  "Face 3/4": {target: [2.75, 1.42, 2.2], az: 0.3, el: 0.12, dist: 1.1},
  "Car 3/4": {target: [4.2, 0.65, 1.0], az: 0.55, el: 0.12, dist: 7.2},
  "Car rear": {target: [4.2, 0.65, 1.0], az: 2.75, el: 0.14, dist: 6.6},
  "Car nose": {target: [4.6, 0.6, 2.9], az: 0.15, el: 0.1, dist: 3.4},
  "Car side": {target: [4.2, 0.6, 1.0], az: 1.22, el: 0.04, dist: 7.0},
};
const orbit = {target: new THREE.Vector3(), az: 0, el: 0, dist: 4};
function setView(name){
  const v = VIEWS[name]; orbit.target.set(...v.target); orbit.az = v.az; orbit.el = v.el; orbit.dist = v.dist;
  document.querySelectorAll("#ui button").forEach(b => b.classList.toggle("on", b.textContent === name));
}
const ui = document.getElementById("ui");
Object.keys(VIEWS).forEach(n => { const b = document.createElement("button"); b.textContent = n; b.onclick = () => setView(n); ui.appendChild(b); });
const q = new URLSearchParams(location.search);
setView(q.get("view") || "Rear 3/4");
let drag = null;
addEventListener("pointerdown", e => { drag = [e.clientX, e.clientY]; });
addEventListener("pointerup", () => { drag = null; });
addEventListener("pointermove", e => {
  if(!drag){ return; }
  orbit.az -= (e.clientX - drag[0]) * 0.008; orbit.el = THREE.MathUtils.clamp(orbit.el + (e.clientY - drag[1]) * 0.006, -0.1, 1.3);
  drag = [e.clientX, e.clientY];
});
addEventListener("wheel", e => { orbit.dist = THREE.MathUtils.clamp(orbit.dist * (1 + e.deltaY * 0.001), 1, 20); });
addEventListener("resize", () => { renderer.setSize(innerWidth, innerHeight); camera.aspect = innerWidth / innerHeight; camera.updateProjectionMatrix(); });

const clock = new THREE.Clock();
function frame(){
  const dt = clock.getDelta();
  if(walker){ walker.mixer.update(dt); }
  const t = orbit.target;
  camera.position.set(t.x + Math.sin(orbit.az) * Math.cos(orbit.el) * orbit.dist, t.y + Math.sin(orbit.el) * orbit.dist,
    t.z + Math.cos(orbit.az) * Math.cos(orbit.el) * orbit.dist);
  camera.lookAt(t);
  renderer.render(scene, camera);
  requestAnimationFrame(frame);
}
frame();
const info = renderer.info.render;
setTimeout(() => {
  let tris = 0; bike.g.traverse(o => { if(o.isMesh){ tris += (o.geometry.index ? o.geometry.index.count : o.geometry.attributes.position.count) / 3; } });
  document.getElementById("stats").textContent = `bike ${Math.round(tris)} tris · frame ${info.triangles} tris, ${info.calls} draws`;
  window.__ready = true;
}, 300);
