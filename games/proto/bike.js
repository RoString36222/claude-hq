// Adventure bike, modelled from the BMW R 1300 GS's real layout (2024 spec: wheelbase 1,518 mm, length 2,212 mm,
// seat 850 mm, 120/70 R19 front and 170/60 R17 rear, boxer twin with its cylinders out to the sides, shaft drive
// in a single-sided swingarm, upswept silencer on the right). Livery is an original tricolour (no badges or logos).
// Returns a rig like games/hqvehiclemodels.js: {g, wheels, steer, anchors:{seat, gripL, gripR, pegL, pegR}}.
import * as THREE from "three";
import {roundedBox, profile, smoothProfile, decal, tube, rod, tyre, knobs, Kit, std, place, flipX, taperX} from "./parts.js";

export function buildAdventureBike(opts = {}){
  const paint = opts.paint || {base: 0xf3f3ef, a: 0xd3242b, b: 0x24398f};
  const M = {
    white: std(paint.base, 0.32, 0.0),
    red: std(paint.a, 0.34, 0.0),
    blue: std(paint.b, 0.36, 0.0),
    black: std(0x1d1e21, 0.55, 0.05),
    frame: std(0x2b2d31, 0.45, 0.35),
    alu: std(0xb8bcc1, 0.32, 0.75),
    steel: std(0xd7dbe0, 0.2, 0.9),
    engine: std(0x7d8187, 0.45, 0.55),
    fins: std(0x2a2b2e, 0.6, 0.3),
    rubber: std(0x161618, 0.92, 0.0),
    seat: std(0x232428, 0.85, 0.0),
    gold: std(0xc9a14a, 0.35, 0.8),
    glass: new THREE.MeshPhysicalMaterial({color: 0x9fb4c4, roughness: 0.05, metalness: 0, transmission: 0.6,
      transparent: true, opacity: 0.45, side: THREE.DoubleSide}),
    lamp: new THREE.MeshStandardMaterial({color: 0xffffff, emissive: 0xeaf4ff, emissiveIntensity: 1.6}),
    amber: new THREE.MeshStandardMaterial({color: 0xffa21a, emissive: 0xff8a00, emissiveIntensity: 0.6, roughness: 0.3}),
    tail: new THREE.MeshStandardMaterial({color: 0xff2a2a, emissive: 0xc00000, emissiveIntensity: 0.7, roughness: 0.3}),
    screen: new THREE.MeshStandardMaterial({color: 0x0b1420, emissive: 0x2c6b8f, emissiveIntensity: 0.5, roughness: 0.2}),
  };
  const g = new THREE.Group(); g.name = "adventure-bike";
  const K = new Kit(M);

  // ---- key points (metres) -------------------------------------------------------------------------------------
  const WB = 1.518, FZ = WB / 2, RZ = -WB / 2;
  const RF = 0.33, RR = 0.322;                 // 19" front, 17" rear, outer radius
  const HEAD = new THREE.Vector3(0, 1.0, 0.44); // steering head (rake ~27 deg to the front axle)
  const PIVOT = new THREE.Vector3(0, 0.50, -0.10);

  // ---- body: tank, shrouds, front mask, beak, screen ----------------------------------------------------------
  // tank / airbox cover: rises from the seat to the headstock
  K.add("white", taperX(smoothProfile([[0.40, 1.08], [0.20, 1.09], [0.04, 1.0], [-0.04, 0.92], [0.08, 0.87], [0.30, 0.90], [0.44, 0.98]], 0.40, 0.05), 0.30, -0.04, 1.0, 0.55));
  // radiator shrouds: big side panels that carry the livery
  const shroud = () => smoothProfile([[0.46, 1.05], [0.30, 1.07], [0.14, 0.96], [0.12, 0.84], [0.24, 0.76], [0.42, 0.80], [0.50, 0.94]], 0.045, 0.016);
  K.pair("white", shroud, 0.175, 0, 0, 0, 0.10, 0);
  // livery: red sweep at the front, blue band, red accent (decals sit 1 mm off the shroud's outer face)
  const dec = (key, pts, x, ry) => {
    const make = () => decal(pts);
    K.pair(key, make, x, 0, 0, 0, ry, 0);
  };
  dec("red", [[0.49, 1.00], [0.34, 1.05], [0.26, 0.98], [0.40, 0.88], [0.50, 0.90]], 0.199, 0.10);
  dec("blue", [[0.40, 0.88], [0.26, 0.98], [0.20, 0.94], [0.16, 0.86], [0.30, 0.80], [0.44, 0.82]], 0.199, 0.10);
  dec("red", [[0.30, 0.80], [0.16, 0.86], [0.15, 0.82], [0.26, 0.775]], 0.199, 0.10);
  // front mask around the headlight, and the beak below it
  K.add("white", smoothProfile([[0.66, 1.22], [0.52, 1.24], [0.44, 1.10], [0.48, 0.92], [0.62, 0.88], [0.72, 1.02]], 0.30, 0.04));
  K.add("red", smoothProfile([[0.78, 0.90], [0.62, 0.92], [0.52, 0.84], [0.66, 0.78], [0.88, 0.80]], 0.17, 0.025));
  K.add("black", smoothProfile([[0.66, 0.79], [0.54, 0.84], [0.50, 0.78], [0.80, 0.74]], 0.12, 0.012));
  // headlight: the X-shaped LED cluster as two crossed bars and a round centre
  K.add("black", roundedBox(0.20, 0.17, 0.05, 0.03), 0, 1.04, 0.715, -0.35);
  [0.5, -0.5].forEach(a => K.add("lamp", roundedBox(0.17, 0.022, 0.02, 0.01), 0, 1.04, 0.738, -0.35, 0, a));
  K.add("lamp", new THREE.CylinderGeometry(0.034, 0.034, 0.02, 20), 0, 1.04, 0.735, Math.PI / 2 - 0.35);
  // windscreen and its black frame
  K.add("glass", smoothProfile([[0.62, 1.22], [0.66, 1.25], [0.58, 1.50], [0.52, 1.49], [0.56, 1.30]], 0.36, 0.006));
  K.add("black", roundedBox(0.30, 0.03, 0.06, 0.012), 0, 1.24, 0.60, -0.4);
  // TFT dash behind the screen
  K.add("black", roundedBox(0.20, 0.13, 0.04, 0.012), 0, 1.25, 0.50, -0.6);
  K.add("screen", roundedBox(0.17, 0.10, 0.006, 0.004), 0, 1.255, 0.483, -0.6);

  // ---- seat and tail -------------------------------------------------------------------------------------------
  K.add("seat", smoothProfile([[0.06, 0.94], [-0.04, 0.88], [-0.30, 0.89], [-0.40, 0.96], [-0.70, 0.98], [-0.74, 0.93],
    [-0.42, 0.85], [-0.10, 0.83], [0.08, 0.86]], 0.32, 0.045));
  K.add("white", smoothProfile([[-0.40, 0.88], [-0.76, 0.93], [-0.86, 0.90], [-0.80, 0.82], [-0.44, 0.78]], 0.24, 0.03));
  K.add("red", decal([[-0.48, 0.86], [-0.80, 0.91], [-0.82, 0.88], [-0.52, 0.83]]), 0.122, 0, 0);
  K.add("red", flipX(decal([[-0.48, 0.86], [-0.80, 0.91], [-0.82, 0.88], [-0.52, 0.83]])), -0.122, 0, 0);
  // luggage rack: two rails and a cross plate behind the pillion
  K.pair("alu", () => tube([[0.10, 0.99, -0.62], [0.10, 1.0, -0.80], [0.06, 0.99, -0.88]], 0.009, 12, 8), 0, 0, 0);
  K.add("alu", roundedBox(0.20, 0.012, 0.18, 0.005), 0, 0.995, -0.80);
  // tail light, indicators, plate hanger
  K.add("tail", roundedBox(0.13, 0.05, 0.03, 0.012), 0, 0.89, -0.875);
  K.add("black", roundedBox(0.14, 0.035, 0.18, 0.01), 0, 0.82, -0.94, 0.5);
  K.add("black", roundedBox(0.19, 0.13, 0.008, 0.004), 0, 0.73, -1.0, 0.15);
  K.pair("black", () => rod([0, 0, 0], [0.09, 0, -0.02], 0.006), 0.07, 0.80, -0.98);
  K.pair("amber", () => roundedBox(0.03, 0.022, 0.05, 0.01), 0.175, 0.80, -1.0);

  // ---- frame, engine, exhaust -------------------------------------------------------------------------------------
  // steel main frame: twin spars from the headstock back and down to the swingarm pivot
  K.pair("frame", () => tube([[0.04, 1.0, 0.42], [0.12, 0.90, 0.20], [0.14, 0.80, -0.02], [0.14, 0.58, -0.10]], 0.022, 16, 10), 0, 0, 0);
  // bolt-on rear frame
  K.pair("frame", () => tube([[0.13, 0.84, -0.04], [0.11, 0.86, -0.40], [0.09, 0.88, -0.70]], 0.014, 12, 8), 0, 0, 0);
  K.pair("frame", () => tube([[0.14, 0.60, -0.12], [0.11, 0.80, -0.48]], 0.012, 8, 8), 0, 0, 0);
  // boxer twin: crankcase, gearbox, the two cylinders out to each side with their fins and valve covers
  K.add("engine", roundedBox(0.30, 0.30, 0.40, 0.06), 0, 0.50, 0.24);
  K.add("engine", roundedBox(0.24, 0.26, 0.28, 0.05), 0, 0.53, -0.02);
  const cyl = () => {
    const parts = [new THREE.CylinderGeometry(0.075, 0.08, 0.20, 18).rotateZ(Math.PI / 2).translate(0.25, 0, 0)];
    for(let i = 0; i < 6; i++){ parts.push(new THREE.CylinderGeometry(0.094, 0.094, 0.008, 18).rotateZ(Math.PI / 2).translate(0.18 + i * 0.026, 0, 0)); }
    return parts;
  };
  [1, -1].forEach(s => cyl().forEach(c => { if(s < 0){ flipX(c); } K.add("fins", c, 0, 0.55, 0.34); }));
  K.pair("alu", () => roundedBox(0.09, 0.19, 0.22, 0.04), 0.39, 0.56, 0.34);
  K.pair("black", () => roundedBox(0.012, 0.10, 0.14, 0.005), 0.437, 0.56, 0.34);
  // aluminium skid plate under the engine
  K.add("alu", smoothProfile([[0.52, 0.42], [0.40, 0.30], [0.0, 0.27], [-0.12, 0.33], [0.0, 0.32], [0.40, 0.34]], 0.30, 0.01));
  // exhaust: headers out of each head, under the engine to the right, then the upswept silencer
  K.add("steel", tube([[0.36, 0.48, 0.42], [0.22, 0.34, 0.50], [0.0, 0.31, 0.36], [-0.10, 0.33, 0.06]], 0.024, 24, 10));
  K.add("steel", tube([[-0.36, 0.48, 0.42], [-0.22, 0.34, 0.50], [-0.12, 0.31, 0.30], [-0.12, 0.33, 0.06]], 0.024, 24, 10));
  K.add("steel", tube([[-0.11, 0.33, 0.06], [-0.16, 0.38, -0.18], [-0.20, 0.50, -0.34]], 0.032, 16, 10));
  const can = new THREE.CylinderGeometry(0.068, 0.075, 0.42, 6, 1);
  K.add("steel", can, -0.215, 0.60, -0.50, Math.PI / 2 + 0.30, 0, 0);
  K.add("black", new THREE.CylinderGeometry(0.06, 0.068, 0.05, 6), -0.215, 0.665, -0.715, Math.PI / 2 + 0.30, 0, 0);
  K.add("black", new THREE.CylinderGeometry(0.024, 0.024, 0.05, 12), -0.215, 0.675, -0.745, Math.PI / 2 + 0.30, 0, 0);

  // ---- rear: single-sided swingarm with the shaft drive on the right, shock, hugger ---------------------------------
  K.add("alu", tube([[-0.12, 0.50, -0.10], [-0.13, 0.43, -0.40], [-0.12, 0.34, -0.72]], 0.04, 12, 12));
  K.add("alu", tube([[-0.11, 0.42, -0.14], [-0.12, 0.30, -0.45], [-0.11, 0.28, -0.70]], 0.016, 10, 8));
  K.add("engine", roundedBox(0.09, 0.15, 0.17, 0.05), -0.12, RR, RZ);
  K.add("black", rod([0.0, 0.42, -0.36], [0.0, 0.78, -0.22], 0.024), 0, 0, 0);
  K.add("gold", tube([[0, 0.48, -0.334], [0, 0.72, -0.235]], 0.034, 4, 10));
  K.add("black", smoothProfile([[RZ + 0.30, RR + 0.36], [RZ + 0.05, RR + 0.38], [RZ - 0.12, RR + 0.30], [RZ + 0.02, RR + 0.35], [RZ + 0.30, RR + 0.32]], 0.16, 0.01));

  // ---- front: telescopic fork, mudguard, calipers --------------------------------------------------------------------
  const steer = new THREE.Group(); steer.name = "steer";
  steer.position.copy(HEAD);
  const KS = new Kit(M);
  const fz = FZ - HEAD.z, fy = RF - HEAD.y;     // axle relative to the head
  KS.pair("steel", () => rod([0.105, 0.02, 0.0], [0.105, fy * 0.45, fz * 0.45], 0.024), 0, 0, 0);
  KS.pair("gold", () => rod([0.105, fy * 0.45, fz * 0.45], [0.105, fy + 0.04, fz], 0.032), 0, 0, 0);
  KS.add("black", roundedBox(0.28, 0.05, 0.10, 0.015), 0, 0.0, 0.0, -0.47);
  KS.add("black", roundedBox(0.26, 0.04, 0.09, 0.015), 0, -0.16, 0.08, -0.47);
  KS.add("white", smoothProfile([[fz + 0.24, fy + RF + 0.06], [fz - 0.02, fy + RF + 0.10], [fz - 0.26, fy + RF - 0.02],
    [fz - 0.02, fy + RF + 0.06], [fz + 0.22, fy + RF + 0.02]], 0.15, 0.008));
  KS.pair("black", () => roundedBox(0.04, 0.10, 0.07, 0.015), 0.125, fy + 0.10, fz - 0.10);
  // handlebar, grips, hand guards, levers, mirrors
  const bar = [[0.40, 0.16, -0.06], [0.30, 0.15, -0.02], [0.14, 0.12, 0.01], [0, 0.11, 0.01], [-0.14, 0.12, 0.01], [-0.30, 0.15, -0.02], [-0.40, 0.16, -0.06]];
  KS.add("black", tube(bar, 0.013, 30, 10));
  KS.pair("rubber", () => rod([0.33, 0.152, -0.03], [0.45, 0.165, -0.075], 0.019, 0.019, 12), 0, 0, 0);
  KS.pair("black", () => smoothProfile([[0.06, 0.03], [0.0, 0.06], [-0.06, 0.02], [-0.02, -0.03], [0.05, -0.02]], 0.12, 0.012), 0.39, 0.17, -0.0, 0, 0.35, 0);
  KS.pair("alu", () => rod([0.27, 0.15, 0.02], [0.40, 0.15, 0.0], 0.006), 0, 0, 0);
  KS.pair("black", () => rod([0.24, 0.16, 0.0], [0.30, 0.34, 0.0], 0.007), 0, 0, 0);
  KS.pair("black", () => roundedBox(0.12, 0.07, 0.025, 0.012), 0.315, 0.36, 0.0, 0, 0.2, 0.15);
  KS.build(steer);
  g.add(steer);

  // ---- foot controls and pegs ------------------------------------------------------------------------------------
  K.pair("black", () => roundedBox(0.09, 0.03, 0.05, 0.01), 0.20, 0.44, -0.10);
  K.pair("alu", () => roundedBox(0.04, 0.10, 0.06, 0.012), 0.15, 0.48, -0.11);
  K.add("alu", rod([0.16, 0.44, -0.08], [0.18, 0.47, 0.10], 0.008), 0, 0, 0);   // gear lever (left)
  K.add("alu", rod([-0.16, 0.43, -0.08], [-0.18, 0.42, 0.10], 0.009), 0, 0, 0);  // brake pedal (right)
  K.add("black", rod([0.14, 0.40, -0.04], [0.17, 0.35, -0.34], 0.013), 0, 0, 0); // side stand, folded up
  K.build(g);

  // ---- wheels: tyre, knobbly tread, black rim, cross-spokes, hub, discs ---------------------------------------------
  const wheel = (R, rimR, w, front) => {
    const wg = new THREE.Group();
    const KW = new Kit(M);
    KW.add("rubber", tyre(rimR, R - 0.012, w, 56));
    knobs(R - 0.016, w, 34, 0.034, 0.014).forEach(k => KW.add("rubber", k));
    KW.add("black", new THREE.TorusGeometry(rimR, 0.014, 8, 56).rotateY(Math.PI / 2));
    KW.add("alu", new THREE.CylinderGeometry(0.045, 0.045, w * 0.9, 16).rotateZ(Math.PI / 2));
    for(let i = 0; i < 32; i++){
      const a = i / 32 * Math.PI * 2, side = i % 2 ? 1 : -1, a2 = a + side * 0.35;
      KW.add("steel", rod([side * w * 0.3, Math.cos(a) * 0.045, Math.sin(a) * 0.045], [side * 0.012, Math.cos(a2) * (rimR - 0.01), Math.sin(a2) * (rimR - 0.01)], 0.0025, 0.0025, 4));
    }
    const disc = (x, r) => {
      KW.add("steel", new THREE.CylinderGeometry(r, r, 0.005, 40, 1, false).rotateZ(Math.PI / 2).translate(x, 0, 0));
      KW.add("alu", new THREE.CylinderGeometry(r * 0.42, r * 0.42, 0.007, 20).rotateZ(Math.PI / 2).translate(x, 0, 0));
    };
    if(front){ disc(0.10, 0.152); disc(-0.10, 0.152); } else { disc(0.09, 0.138); }
    KW.build(wg);
    return wg;
  };
  const wf = wheel(RF, 0.245, 0.12, true);
  const wfHold = new THREE.Group(); wfHold.position.set(0, RF - HEAD.y, FZ - HEAD.z); wfHold.add(wf); steer.add(wfHold);
  const wr = wheel(RR, 0.216, 0.17, false); wr.position.set(0, RR, RZ); g.add(wr);
  // rear caliper (left, behind the disc)
  const cal = new THREE.Mesh(roundedBox(0.04, 0.08, 0.06, 0.012), M.black); cal.position.set(0.11, RR + 0.10, RZ - 0.08); g.add(cal);

  g.traverse(o => { if(o.isMesh){ o.castShadow = true; } });

  // rider anchors (bike-local): seat contact, grips and pegs
  const anchors = {
    seat: new THREE.Vector3(0, 0.88, -0.13),
    gripL: new THREE.Vector3(0.395, HEAD.y + 0.16, HEAD.z - 0.055),
    gripR: new THREE.Vector3(-0.395, HEAD.y + 0.16, HEAD.z - 0.055),
    pegL: new THREE.Vector3(0.20, 0.47, -0.10),
    pegR: new THREE.Vector3(-0.20, 0.47, -0.10),
  };
  return {g, wheels: [wf, wr], steer, anchors, radii: [RF, RR], mats: M};
}
