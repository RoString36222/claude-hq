// Vehicle garage: every catalogue vehicle (games/hqvehiclemodels.js) in a grid, or one close up.
// /games/proto/garage.html?kind=bike|car&match=bmw&view=f34|r34|side|front|rear|top&lod=1&id=bmw-m3-competition
// Drag to orbit (single view). Uses the realism prototype's PMREM studio env so metals and paint read.
import * as THREE from "three";

const q = new URLSearchParams(location.search);
const VM = window.HQV.hqVehicleModels;
const renderer = new THREE.WebGLRenderer({antialias: true, preserveDrawingBuffer: true});
renderer.setPixelRatio(1);
renderer.setSize(innerWidth, innerHeight);
renderer.shadowMap.enabled = true; renderer.shadowMap.type = THREE.PCFShadowMap;
renderer.toneMapping = THREE.ACESFilmicToneMapping; renderer.toneMappingExposure = 1.05;
renderer.setScissorTest(true);
document.body.appendChild(renderer.domElement);

const scene = new THREE.Scene();
scene.background = new THREE.Color(0xe4ebe6);
scene.add(new THREE.HemisphereLight(0xf3f7ff, 0x8a9a5a, 1.1));
const sun = new THREE.DirectionalLight(0xfff3e2, 2.0);
sun.position.set(-6, 10, 4); sun.castShadow = true; sun.shadow.mapSize.set(2048, 2048); sun.shadow.bias = -0.0004;
Object.assign(sun.shadow.camera, {left: -4, right: 4, top: 4, bottom: -4, near: 1, far: 30});
scene.add(sun);
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
const ground = new THREE.Mesh(new THREE.CircleGeometry(6, 48), new THREE.MeshStandardMaterial({color: 0xc9cfc2, roughness: 1}));
ground.rotation.x = -Math.PI / 2; ground.receiveShadow = true; scene.add(ground);

const cat = await (await fetch("../vehicles/catalogue.json")).json();
let list = cat.vehicles.slice();
const starter = q.get("starter");
if(q.get("id")){ const ids = q.get("id").split(","); list = list.filter(v => ids.includes(v.id)); }
if(q.get("kind")){ const k = q.get("kind"); list = list.filter(v => String(v.class).startsWith(k + ".")); }
if(q.get("match")){ const m = new RegExp(q.get("match"), "i"); list = list.filter(v => m.test(v.id)); }
if(!starter){ list = list.filter(v => v.slot !== "starter"); }
else {   // the starters as games/hq3d.js builds them (STARTER_E there)
  list = [{id: "starter-city-hatch", "class": "car.hatch.starter", brand: "", model: "City hatchback", door: "hinged", paints: [{hex: "#2f7fd6"}], dims: {lengthM: 3.6, widthM: 1.7, heightM: 1.55, wheelbaseM: 2.4}},
          {id: "starter-street-bike", "class": "bike.naked.starter", brand: "", model: "Street bike", door: "none", paints: [{hex: "#d64545"}], spec: {cc: 250, cyl: 1, layout: "single"}, dims: {lengthM: 2.0, widthM: 0.8, heightM: 1.08, wheelbaseM: 1.36}}];
}
const lod = +q.get("lod") || 0;
const views = {f34: [0.75, 0.16], r34: [-2.4, 0.18], side: [Math.PI / 2, 0.03], front: [0, 0.06], rear: [Math.PI, 0.08], top: [Math.PI / 2, 1.2], fl: [2.35, 0.2], low: [0.6, 0.02]};
const [az0, el0] = views[q.get("view") || "f34"] || views.f34;
const items = list.map(v => {
  const hex = v.paints && v.paints[0] ? parseInt(String(v.paints[0].hex || "#888888").slice(1), 16) : 0x3366cc;
  const entry = v.slot === "starter" ? Object.assign({}, v, {starter: false}) : v;
  let rig = null, err = null;
  try { rig = VM.build(THREE, entry, hex, q.get("tune") ? {tune: JSON.parse(q.get("tune"))} : {}); } catch(e){ err = e; console.error(v.id, e.stack || e); }
  if(rig && rig.setLod){ rig.setLod(lod); }
  if(rig && q.get("doors")){ rig.setDoors && rig.setDoors(1, "both"); }
  if(rig && q.get("steer")){ rig.roll(0, +q.get("steer")); }
  return {v, rig, err};
});
const n = items.length, cols = +q.get("cols") || Math.min(n, Math.ceil(Math.sqrt(n * innerWidth / innerHeight / 1.6))), rows = Math.ceil(n / cols);
const labels = document.getElementById("labels");
const cam = new THREE.PerspectiveCamera(28, 1, 0.05, 200);
const orbit = {az: az0, el: el0, zoom: +q.get("zoom") || 1};
let drag = null;
addEventListener("pointerdown", e => { drag = [e.clientX, e.clientY]; });
addEventListener("pointerup", () => { drag = null; });
addEventListener("pointermove", e => { if(!drag){ return; } orbit.az -= (e.clientX - drag[0]) * 0.008; orbit.el = Math.max(-0.1, Math.min(1.4, orbit.el + (e.clientY - drag[1]) * 0.006)); drag = [e.clientX, e.clientY]; });
addEventListener("wheel", e => { orbit.zoom *= 1 + e.deltaY * 0.001; });
let tot = {tris: 0, dc: 0};
items.forEach((it, i) => {
  const d = document.createElement("div");
  const c = i % cols, r = Math.floor(i / cols), cw = innerWidth / cols, ch = innerHeight / rows;
  d.style.left = (c * cw + 4) + "px"; d.style.top = (r * ch + 4) + "px";
  const tr = it.rig ? VM.triangles(it.rig, lod) : 0, dc = it.rig ? VM.drawCalls(it.rig, lod) : 0;
  tot.tris += tr; tot.dc += dc;
  d.textContent = it.v.id + (it.err ? " ERR " + it.err.message : " · " + tr + " tris · " + dc + " dc");
  labels.appendChild(d);
});
document.getElementById("stats").textContent = n + " vehicles · avg " + Math.round(tot.tris / Math.max(1, n)) + " tris · " + (tot.dc / Math.max(1, n)).toFixed(1) + " dc (lod " + lod + ")";
function frame(){
  const cw = innerWidth / cols, ch = innerHeight / rows;
  items.forEach((it, i) => {
    if(!it.rig){ return; }
    const c = i % cols, r = Math.floor(i / cols), x = c * cw, y = innerHeight - (r + 1) * ch;
    renderer.setViewport(x, y, cw, ch); renderer.setScissor(x, y, cw, ch);
    scene.add(it.rig.g);
    const b = new THREE.Box3().setFromObject(it.rig.g), s = b.getSize(new THREE.Vector3()), ctr = b.getCenter(new THREE.Vector3());
    const rad = s.length() / 2;
    cam.aspect = cw / ch; cam.updateProjectionMatrix();
    const dist = rad / Math.sin(cam.fov * Math.PI / 360) * Math.max(1, 1.05 / cam.aspect) * 0.92 * orbit.zoom;
    cam.position.set(ctr.x + Math.sin(orbit.az) * Math.cos(orbit.el) * dist, ctr.y + Math.sin(orbit.el) * dist, ctr.z + Math.cos(orbit.az) * Math.cos(orbit.el) * dist);
    cam.lookAt(ctr);
    renderer.render(scene, cam);
    scene.remove(it.rig.g);
  });
  requestAnimationFrame(frame);
}
frame();
setTimeout(() => { window.__ready = true; }, 300);
