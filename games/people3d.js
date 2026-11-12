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
 *   HQV.people3d.gaitPlan(v, rel, rate) / gaitDrive(ch, plan, dt) (before the mixer step) / gaitPost(ch, dt) (after it):
 *                                 the measured gait: one phase for every locomotion clip, the stride lengthened past a
 *                                 jog, directional clips, planted feet held (HQV.gait is the pure part, for tests)
 */
(function(){
"use strict";
var HQV = window.HQV = window.HQV || {};

/* ---------- the gait (HQ 3.41): pure, so node tests and the crowds share it ----------
 * Measured from anims.glb at the drawn 1.7 m (games/proto: the stance foot's speed under the hips x the cycle):
 * Walk covers 1.43 m a cycle (0.86 m/s at timeScale 1), Run 2.0 m (2.0 m/s), Run_Back 2.05 m, Run_Left / Run_Right
 * 2.0 m. off: where that clip's left heel strikes, as a share of its cycle, less the walk's (0.035): every clip of the
 * blend is driven from ONE phase (a sync group), so a planted foot in one clip is planted in the others and the legs
 * never scissor through a walk / run crossfade. Past a jog the stride itself lengthens (k: the feet reach further
 * from the hips, by leg IK after the clips; gaitPost), so a fast run is longer strides and not only faster legs.
 * walkTo / runFrom: the walk / run crossfade (m/s); kMax the most stretch (the legs still reach the ground). */
var GAIT = {walk: {stride: 1.43, off: 0}, sprint: {stride: 2.0, off: 0.415}, back: {stride: 2.05, off: 0.28},
            left: {stride: 2.0, off: 0.95}, right: {stride: 2.0, off: 0.415},
            idleTo: 0.6, walkTo: 1.5, runFrom: 2.6, kPer: 0.12, kMax: 1.45, shuffle: 0.9, drop: 0.035};
var GAIT_CLIPS = ["walk", "sprint", "back", "left", "right"];
function smooth01(a, b, x){ var t = Math.max(0, Math.min(1, (x - a)/(b - a))); return t*t*(3 - 2*t); }
// v: ground speed (m/s, >= 0) at the drawn 1.7 m; rel: the way you move relative to your facing (rad: 0 ahead, +PI/2
// to your left, PI back); rate: your turn (rad/s, a shuffle when turning on the spot).
// -> {idle, walk, sprint, back, left, right (weights, sum 1), k (stride stretch), stride (m a cycle), cps (cycles/s)}
function gaitPlan(v, rel, rate){
  v = Math.max(0, +v || 0); rel = +rel || 0; rate = Math.abs(+rate || 0);
  var sh = v < GAIT.idleTo ? Math.min(1, rate/2.5)*(1 - v/GAIT.idleTo)*0.6 : 0;
  var idle = Math.max(0, 1 - v/GAIT.idleTo)*(1 - sh), go = 1 - idle;
  var c = Math.cos(rel), s = Math.sin(rel), fw = c > 0 ? c*c : 0, bk = c < 0 ? c*c : 0, lt = s > 0 ? s*s : 0, rt = s < 0 ? s*s : 0;
  if(sh > 0){ fw += bk + lt + rt; bk = lt = rt = 0; }                      // turning on the spot: the walk, a shuffle
  var r = smooth01(GAIT.walkTo, GAIT.runFrom, v);
  var P = {idle: idle, walk: go*fw*(1 - r), sprint: go*fw*r, back: go*bk, left: go*lt, right: go*rt};
  P.k = 1 + Math.min(GAIT.kMax - 1, Math.max(0, v - GAIT.runFrom)*GAIT.kPer);
  P.stride = gaitStride(P, P.k);
  P.cps = Math.max(v/P.stride, sh > 0 ? rate*GAIT.shuffle/GAIT.walk.stride : 0);
  return P;
}
// metres a cycle of a blend (weights w, stretch k): the walk's own stride, the run clips' stretched. Blended poses
// blend the feet's paths as vectors (ahead and to the left at once is a diagonal only cos 45 as long), so the stride
// is the length of the weighted sum of each clip's stride along its own way.
var GAIT_DIR = {walk: [0, 1], sprint: [0, 1], back: [0, -1], left: [1, 0], right: [-1, 0]};
function gaitStride(w, k){
  var sum = 0, x = 0, z = 0;
  GAIT_CLIPS.forEach(function(n){
    var a = Math.max(0, +w[n] || 0), m = a*GAIT[n].stride*(n === "walk" ? 1 : k);
    sum += a; x += m*GAIT_DIR[n][0]; z += m*GAIT_DIR[n][1];
  });
  return sum > 1e-6 ? Math.max(0.5, Math.hypot(x, z)/sum) : GAIT.walk.stride;
}
HQV.gait = {GAIT: GAIT, CLIPS: GAIT_CLIPS, plan: gaitPlan, stride: gaitStride};

var E = HQV.engine;
if(!E){ return; }

var FILES = ["woman-casual", "man-hoodie", "woman-adventurer", "man-adventurer", "woman-worker", "man-casual"];
var FEMALE = [true, false, true, false, true, false];
// the material that takes the outfit colour, per outfit (the rest keep the pack's own colours)
var TOP = {"woman-casual": ["White"], "man-hoodie": ["Purple"], "woman-adventurer": ["Green", "LightGreen"],
           "man-adventurer": ["Green"], "woman-worker": ["Worker_Vest"], "man-casual": ["Red_Dark"]};
var CH_H = 0.72;          // drawn height in model units (hq3d draws people 1.7 m: scale 1.7 / CH_H)
var HEAD_K = 2.0;         // head scale over the pack's: the toy proportions
var ANIM = {idle: "Idle", walk: "Walk", sprint: "Run", "emote-yes": "Wave", back: "Run_Back", left: "Run_Left", right: "Run_Right"};

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

// before posing over the clips: the bones come back to the clip's pose at the next mixer step (build's mark)
function mark(ch){ if(ch && ch.mark){ ch.mark(); } }
// the shin ends at a virtual ankle (the rig's feet are IK controls under Root, not children of the shin)
function legTo(ch, side, target, pole){
  var THREE = ch.L.THREE, B = ch.bones, K = ikLib(THREE), shin = B["LowerLeg" + side], foot = B["Foot" + side];
  if(!shin || !foot){ return; }
  mark(ch);
  var ankle = new THREE.Object3D();
  ankle.position.set(0, ch.legLen[side], 0);       // shin-bone units (its own scale is 1)
  shin.add(ankle);
  K.twoBone(B["UpperLeg" + side], shin, ankle, target, pole);
  var at = ankle.getWorldPosition(new THREE.Vector3());
  shin.remove(ankle);
  foot.position.copy(foot.parent.worldToLocal(at));
  foot.updateMatrixWorld(true);
}
function reach(ch, side, target, pole){
  var B = ch.bones, K = ikLib(ch.L.THREE);
  mark(ch);
  if(B["UpperArm" + side]){ K.twoBone(B["UpperArm" + side], B["LowerArm" + side], B["Wrist" + side], target, pole); }
}
// the hand's own frame, world space: f wrist -> middle knuckle, a index -> pinky knuckle (across the palm),
// n out of the palm (the way the fingers close), pl the palm's length
function handFrame(ch, side){
  var THREE = ch.L.THREE, B = ch.bones, w = B["Wrist" + side], m = B["Middle2" + side], i = B["Index2" + side], p = B["Pinky2" + side];
  if(!w || !m || !i || !p){ return null; }
  var W = w.getWorldPosition(new THREE.Vector3()), f = m.getWorldPosition(new THREE.Vector3()).sub(W), pl = f.length();
  f.normalize();
  var a = p.getWorldPosition(new THREE.Vector3()).sub(i.getWorldPosition(new THREE.Vector3()));
  a.addScaledVector(f, -a.dot(f)).normalize();
  // the palm faces the thigh in the pack's idle: -(f x a) on the left hand, +(f x a) on the right (a mirror)
  var n = new THREE.Vector3().crossVectors(f, a).multiplyScalar(side === "L" ? -1 : 1);
  return {w: W, f: f, a: a, n: n, pl: pl};
}
// turn a bone about a world axis
function rotW(THREE, bone, axis, ang){
  if(!bone || !ang){ return; }
  var qw = bone.getWorldQuaternion(new THREE.Quaternion()).premultiply(new THREE.Quaternion().setFromAxisAngle(axis, ang));
  bone.quaternion.copy(bone.parent.getWorldQuaternion(new THREE.Quaternion()).invert().multiply(qw));
  bone.updateMatrixWorld(true);
}
// close the fingers round a bar: each knuckle turns about the palm's across axis (f x n), so the fingertips sweep into
// the palm and not sideways; the thumb swings across under the bar. amount 0 open .. 1 a fist round a thin bar.
function grip(ch, side, amount){
  var THREE = ch.L.THREE, B = ch.bones, k = amount == null ? 0.85 : amount;
  mark(ch);
  var H = handFrame(ch, side); if(!H){ return; }
  var ax = new THREE.Vector3().crossVectors(H.f, H.n).normalize();
  var CURL = [0.12, 1.05, 1.0, 0.7], FK = {Index: 0.88, Middle: 1, Ring: 1.04, Pinky: 1.1};
  ["Index", "Middle", "Ring", "Pinky"].forEach(function(f){
    for(var j = 1; j <= 4; j++){ rotW(THREE, B[f + j + side], ax, CURL[j - 1] * FK[f] * k); }
  });
  // the thumb: across the palm (about the hand's long axis), then its two joints close
  var t1 = B["Thumb1" + side], t2 = B["Thumb2" + side], t3 = B["Thumb3" + side];
  if(t1 && t2){
    rotW(THREE, t1, H.f, (side === "L" ? 1 : -1) * 0.5 * k);
    var td = t2.getWorldPosition(new THREE.Vector3()).sub(t1.getWorldPosition(new THREE.Vector3())).normalize();
    var tax = new THREE.Vector3().crossVectors(td, H.n).normalize();
    rotW(THREE, t2, tax, 0.6 * k); rotW(THREE, t3, tax, 0.5 * k);
  }
}
// Hold a bar, a rim or a stick at world point `at`: o = {across (the bar's axis, the way index -> pinky should run),
// fdir (roughly where the fingers point), r (the bar's radius, world), curl, pole (the elbow's side)}. The wrist is
// placed so the bar lies across the palm at the knuckles, the hand turned to the bar, then the fingers close round it.
// Returns how far (world) the wrist stayed short of where it had to be.
function hold(ch, side, at, o){
  var THREE = ch.L.THREE, B = ch.bones, K = IK;
  if(!B["UpperArm" + side] || !K.twoBone){ return; }
  mark(ch);
  var ad = o.across.clone().normalize(), fd = o.fdir.clone().addScaledVector(ad, -o.fdir.dot(ad)).normalize();
  var nd = new THREE.Vector3().crossVectors(fd, ad).multiplyScalar(side === "L" ? -1 : 1);
  var H0 = handFrame(ch, side); if(!H0){ return; }
  var wt = at.clone().addScaledVector(fd, -H0.pl * (o.into == null ? 0.82 : o.into)).addScaledVector(nd, -(o.r || 0));
  K.twoBone(B["UpperArm" + side], B["LowerArm" + side], B["Wrist" + side], wt, o.pole);
  var miss = B["Wrist" + side].getWorldPosition(new THREE.Vector3()).distanceTo(wt);   // > 0: the arm could not reach
  var H = handFrame(ch, side), Mc = new THREE.Matrix4().makeBasis(H.f, H.a, H.n), Md = new THREE.Matrix4().makeBasis(fd, ad, nd);
  var q = new THREE.Quaternion().setFromRotationMatrix(Md.multiply(Mc.transpose()));
  var w = B["Wrist" + side], qw = w.getWorldQuaternion(new THREE.Quaternion()).premultiply(q);
  w.quaternion.copy(w.parent.getWorldQuaternion(new THREE.Quaternion()).invert().multiply(qw));
  w.updateMatrixWorld(true);
  grip(ch, side, o.curl == null ? 0.9 : o.curl);
  return miss;
}
// Seat on a vehicle: w = {seat, gripL, gripR, pegL, pegR} in world space. Call after the clips for this frame.
function seat(ch, w, opts){
  opts = opts || {};
  var THREE = ch.L.THREE, B = ch.bones, o = ch.o;
  if(!B.Hips){ return; }
  mark(ch);
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

/* ---------- the gait, driven (HQ 3.41) ---------- */
// One frame of locomotion, BEFORE the mixer step. P: gaitPlan(v, rel, rate); v the ground speed at the drawn 1.7 m.
// The weights ease (omega 10: a change of pace or direction crossfades) into ch.loco; ONE phase (ch.gait.ph)
// advances at the cadence the drawn blend needs (from the eased weights and stretch, so the planted foot keeps pace
// with the ground) and every locomotion clip is set to that phase plus its own offset, timeScale 0 (the phase owns
// their time). A character without a directional clip runs forward instead.
function gaitDrive(ch, P, dt){
  dt = Math.max(0, +dt || 0);
  var G = ch.gait || (ch.gait = {ph: 0, k: 1, rel: 0}), L = ch.loco || (ch.loco = {}), acts = ch.acts, e = 1 - Math.exp(-10*dt);
  var W = {idle: P.idle, walk: P.walk, sprint: P.sprint, back: P.back, left: P.left, right: P.right};
  ["back", "left", "right"].forEach(function(n){ if(!acts[n] && W[n]){ W.sprint += W[n]; W[n] = 0; } });
  if(!acts.sprint){ W.walk += W.sprint; W.sprint = 0; }
  ["idle"].concat(GAIT_CLIPS).forEach(function(n){ L[n] = (+L[n] || 0) + ((W[n] || 0) - (+L[n] || 0))*e; });
  G.k += (P.k - G.k)*e;
  if(P.rel != null){ var dr = Math.atan2(Math.sin(P.rel - G.rel), Math.cos(P.rel - G.rel)); G.rel += dr*e; }
  var S = gaitStride(L, G.k), cps = P.cps*(P.stride > 0 ? P.stride/S : 1);
  G.ph = ((G.ph + cps*dt) % 1 + 1) % 1; G.cps = cps;
  if(acts.idle){ acts.idle.enabled = true; if(!acts.idle.isRunning()){ acts.idle.play(); } acts.idle.timeScale = 1; acts.idle.setEffectiveWeight(L.idle); }
  GAIT_CLIPS.forEach(function(n){
    var a = acts[n]; if(!a){ return; }
    a.enabled = L[n] > 1e-3; if(!a.enabled){ return; }                // out of the blend: not evaluated
    if(!a.isRunning()){ a.play(); }
    a.setEffectiveWeight(L[n]); a.timeScale = 0;
    a.time = ((G.ph + GAIT[n].off) % 1)*a.getClip().duration;
  });
}
// After the mixer step (dt: this frame's): the longer stride, and the planted foot held where it landed.
// Stride: with ch.gait.k > 1 each foot's reach from the hips along the way you move is scaled by k, the hips a little
// lower so the planted foot still reaches the ground. Plant: a foot at the ground (within PLANT_Y of the body's feet
// level) is locked where it touched down for as long as it stays down, so the last few % the clips' own stance
// wobbles by never shows as a glide; it lets go smoothly (omega 30) as the foot lifts, at once if the body is pulled
// more than PLANT_MAX from it (a teleport, a shove). Each leg is then solved to its foot (two-bone IK).
var GV = null, PLANT_Y = 0.05, PLANT_MAX = 0.35;
function gaitPost(ch, dt){
  var G = ch.gait, B = ch.bones;
  if(!G || ch.cur !== "loco" || !B || !B.Hips || !ch.L){ if(G){ G.lk = null; } return; }
  var THREE = ch.L.THREE, o = ch.o;
  if(!GV){ GV = {q: new THREE.Quaternion(), s: new THREE.Vector3(), d: new THREE.Vector3(), f: new THREE.Vector3(), H: new THREE.Vector3(),
                 F: new THREE.Vector3(), K: new THREE.Vector3(), T: new THREE.Vector3(), P: new THREE.Vector3(), O: new THREE.Vector3(),
                 end: new THREE.Object3D(), K2: ikLib(THREE)}; }
  dt = Math.max(0, +dt || 0);
  var stretch = G.k > 1.003, lk = G.lk || (G.lk = {L: {on: false, w: 0, x: 0, z: 0}, R: {on: false, w: 0, x: 0, z: 0}});
  var standing = !stretch && !(G.cps > 0.01);                          // standing: the clip's feet do not move; locks ease off
  if(standing){ lk.L.on = lk.R.on = false; if(!lk.L.w && !lk.R.w){ return; } }
  mark(ch);
  o.updateMatrixWorld(true);
  o.getWorldQuaternion(GV.q); o.getWorldScale(GV.s); o.getWorldPosition(GV.O);
  var sc = GV.s.x*CH_H/1.7, t = stretch ? (G.k - 1)/(GAIT.kMax - 1) : 0, rel = 1 - Math.exp(-30*dt);
  GV.f.set(0, 0, 1).applyQuaternion(GV.q); GV.f.y = 0; GV.f.normalize();
  GV.d.set(Math.sin(G.rel), 0, Math.cos(G.rel)).applyQuaternion(GV.q); GV.d.y = 0; GV.d.normalize();
  B.Hips.getWorldPosition(GV.H);
  if(stretch){ GV.H.y -= GAIT.drop*t*sc; B.Hips.position.copy(B.Hips.parent.worldToLocal(GV.T.copy(GV.H))); B.Hips.updateMatrixWorld(true); }
  ["L", "R"].forEach(function(s){
    if(!B["Foot" + s] || !B["LowerLeg" + s]){ return; }
    var foot = B["Foot" + s], shin = B["LowerLeg" + s], P = lk[s];
    foot.getWorldPosition(GV.F); shin.getWorldPosition(GV.K);
    GV.T.copy(GV.F);
    if(stretch){ GV.T.addScaledVector(GV.d, ((GV.F.x - GV.H.x)*GV.d.x + (GV.F.z - GV.H.z)*GV.d.z)*(G.k - 1)); }
    var down = !standing && GV.T.y - GV.O.y < PLANT_Y*sc;
    if(down && !P.on){ P.on = true; P.x = GV.T.x; P.z = GV.T.z; P.w = 1; }
    else if(!down){ P.on = false; }
    if(P.on && Math.hypot(P.x - GV.T.x, P.z - GV.T.z) > PLANT_MAX*sc){ P.on = false; P.w = 0; }
    if(!P.on){ P.w -= P.w*rel; if(P.w < 1e-3){ P.w = 0; } }
    if(P.w > 0){ GV.T.x += (P.x - GV.T.x)*P.w; GV.T.z += (P.z - GV.T.z)*P.w; }
    if(!stretch && P.w === 0){ return; }                                 // the clip's own leg, untouched
    GV.P.copy(GV.K).addScaledVector(GV.f, 0.5*sc);
    // the leg's end is where the clip put this foot, in the shin's space (exact when nothing moves it), not legTo's ankle
    shin.add(GV.end); shin.updateMatrixWorld(true); GV.end.position.copy(shin.worldToLocal(GV.F.clone()));
    GV.K2.twoBone(B["UpperLeg" + s], shin, GV.end, GV.T, GV.P);
    GV.end.getWorldPosition(GV.F); shin.remove(GV.end);
    foot.position.copy(foot.parent.worldToLocal(GV.F)); foot.updateMatrixWorld(true);
  });
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

// [realism perf] People were never frustum-culled (a skinned mesh's bounds are its bind pose, so they were switched off
// wholesale): every person drew, and cast, from behind the camera too. A sub-mesh's own bind sphere does not hold its
// posed limbs (a sprinting shoe or a seated rider's hand swings 20-40 cm past it), so every skinned part of one person
// gets the same sphere: the whole body's, centred on the bind hips, radius the body's largest bind extent (about 1.7 m;
// measured over every clip, the wave's raised hand needs 0.98 of it, a stride, a seat's legs out front and IK grips
// less). Seats move o, never the hips, so the sphere follows the body.
var CULL_PAD = 1.5;
function cullable(THREE, root){
  root.updateMatrixWorld(true);
  var inv = new THREE.Matrix4().copy(root.matrixWorld).invert(), rel = new THREE.Matrix4();
  var box = new THREE.Box3(), gb = new THREE.Box3(), meshes = [], hips = null;
  root.traverse(function(n){
    if(n.isBone && !hips && /hips/i.test(n.name)){ hips = n; }
    if(!n.isMesh){ return; }
    n.frustumCulled = true;
    if(!n.isSkinnedMesh){ return; }
    if(!n.geometry.boundingBox){ n.geometry.computeBoundingBox(); }
    rel.multiplyMatrices(inv, n.matrixWorld);
    box.union(gb.copy(n.geometry.boundingBox).applyMatrix4(rel));
    meshes.push(n);
  });
  if(!meshes.length || box.isEmpty()){ return; }
  var c = hips ? hips.getWorldPosition(new THREE.Vector3()).applyMatrix4(inv) : box.getCenter(new THREE.Vector3());
  // CULL_PAD: the clips reach 0.98 of the bind extent from the hips (the wave's hand, a sprint's shoe); half as much
  // again holds a pose wider than any clip (an exosuit's spread flight, a bigger emote, an IK reach), for a few more draws
  var r = Math.max(box.max.y - box.min.y, box.max.x - box.min.x, box.max.z - box.min.z) * CULL_PAD;
  var lc = new THREE.Vector3(), sc = new THREE.Vector3();
  meshes.forEach(function(n){
    rel.multiplyMatrices(inv, n.matrixWorld);
    sc.setFromMatrixScale(rel);
    lc.copy(c).applyMatrix4(rel.invert());
    n.boundingSphere = new THREE.Sphere(lc.clone(), r / (Math.max(sc.x, sc.y, sc.z) || 1));
  });
}
// geometry detail: 1 for your own and the people near you, less for crowds (crowdHead)
var SEGK = 1;
function sg(n){ return Math.max(6, Math.round(n * SEGK)); }
function mat(THREE, hex, rough, extra){
  return new THREE.MeshStandardMaterial(Object.assign({color: hex, roughness: rough == null ? 0.7 : rough, metalness: 0}, extra || {}));
}

// smooth skull shape: the sphere with a softer, narrower jaw; k (number or fn of the unit direction) scales it
function skullGeo(THREE, rx, ry, rz, k){
  var g = new THREE.SphereGeometry(1, sg(40), sg(28)), p = g.attributes.position, d = new THREE.Vector3();
  for(var i = 0; i < p.count; i++){
    d.fromBufferAttribute(p, i);
    var jaw = d.y < 0 ? 1 - 0.16 * d.y * d.y : 1, kk = typeof k === "function" ? k(d) : k;
    p.setXYZ(i, d.x * rx * jaw * kk, d.y * ry * kk, d.z * rz * jaw * kk);
  }
  g.computeVertexNormals();
  return g;
}

function toyHead(L, skull, spec, female, file){
  // [load] build()'s heads: the geometry is made once per outfit and look, then shared (each person keeps its own
  // materials); crowds (no file) get their own, which they merge and dispose
  var hk = file ? [file, SEGK, spec[4] | 0, spec[5] | 0, spec[6] | 0, spec[7] === 1 ? 1 : 0, female ? 1 : 0].join("|") : null;
  var rec = hk ? HEADG[hk] : null, G0 = GREC;
  GREC = hk ? {list: rec || [], i: 0, replay: !!rec} : null;
  try { return toyHead0(L, skull, spec, female); }
  finally { if(hk && !rec){ HEADG[hk] = GREC.list; } GREC = G0; }
}
function toyHead0(L, skull, spec, female){
  var THREE = L.THREE, grp = new THREE.Group(); grp.name = "toy-head";
  var c = skull.getCenter(new THREE.Vector3()), sz = skull.getSize(new THREE.Vector3());
  var rx = sz.x * 0.5, ry = sz.y * 0.5, rz = sz.z * 0.44;
  function at(x, y, z){ return new THREE.Vector3(c.x + x*rx, c.y + y*ry, c.z + z*rz); }
  var chrome = spec[1] === 7;
  var skinHex = hexOf("skin", spec[1]) || "#f1c8a6", hairHex = hexOf("hairColor", spec[2]) || (female ? "#6b4228" : "#3a2a20");
  var skin = chrome ? new THREE.MeshStandardMaterial({color: "#c9d1db", roughness: 0.2, metalness: 0.9}) : mat(THREE, skinHex, 0.65);
  var hairM = mat(THREE, hairHex, 0.7), lit = spec[7] === 1;
  var eyeM = lit ? new THREE.MeshStandardMaterial({color: "#5ff3ff", emissive: "#5ff3ff", emissiveIntensity: 1.4}) : mat(THREE, "#2a1c16", 0.3);
  var head = new THREE.Mesh(G(function(){ return skullGeo(THREE, rx, ry, rz, 1); }), skin); head.position.copy(c); grp.add(head);
  // a neck down into the collar (the pack's own neck went with its head)
  var neck = new THREE.Mesh(G(function(){ return new THREE.CylinderGeometry(rx * 0.36, rx * 0.42, ry * 0.9, 16); }), skin);
  neck.position.copy(at(0, -1.05, -0.08)); grp.add(neck);
  [-1, 1].forEach(function(sx){
    var eye = new THREE.Mesh(G(function(){ return new THREE.SphereGeometry(1, sg(20), sg(14)); }), eyeM);
    eye.scale.set(rx * 0.11, ry * 0.15, rz * 0.06); eye.position.copy(at(sx * 0.36, -0.02, 0.93)); eye.rotation.y = sx * 0.35;
    grp.add(eye);
    if(!lit){
      var glint = new THREE.Mesh(G(function(){ return new THREE.SphereGeometry(1, sg(10), sg(8)); }), new THREE.MeshBasicMaterial({color: 0xffffff}));
      glint.scale.setScalar(rx * 0.03); glint.position.copy(at(sx * 0.33, 0.04, 0.985)); grp.add(glint);
    }
    var brow = new THREE.Mesh(G(function(){ return new THREE.CapsuleGeometry(rx * 0.025, rx * 0.16, 4, 8); }), hairM);
    brow.rotation.set(0, sx * 0.35, Math.PI / 2 + sx * 0.12); brow.position.copy(at(sx * 0.37, 0.24, 0.93)); grp.add(brow);
    var ear = new THREE.Mesh(G(function(){ return new THREE.SphereGeometry(1, sg(14), sg(10)); }), skin);
    ear.scale.set(rx * 0.08, ry * 0.17, rz * 0.13); ear.position.copy(at(sx * 0.98, -0.06, -0.05)); grp.add(ear);
  });
  var nose = new THREE.Mesh(G(function(){ return new THREE.SphereGeometry(1, sg(14), sg(10)); }), skin);
  nose.scale.set(rx * 0.07, ry * 0.06, rz * 0.06); nose.position.copy(at(0, -0.22, 0.99)); grp.add(nose);
  var mouth = new THREE.Mesh(G(function(){ return new THREE.TorusGeometry(rx * 0.09, rx * 0.017, 6, 16, Math.PI); }), mat(THREE, "#8a3b32", 0.5));
  mouth.rotation.set(-0.25, 0, Math.PI); mouth.scale.z = 0.3; mouth.position.copy(at(0, -0.40, 0.875)); grp.add(mouth);
  hairFor(THREE, grp, spec, female, hairM, c, rx, ry, rz, at);
  wear(THREE, grp, spec, at, rx, ry, rz, c);
  // [realism perf] the skull casts the head's shadow (and the hair and hats, the bigger parts); eyes, glints, brows, ears,
  // nose and mouth are each a shadow draw for a speck nobody sees
  grp.traverse(function(m){ if(m.isMesh){ m.castShadow = m === head || m.material === hairM || (m.geometry.boundingSphere || (m.geometry.computeBoundingSphere(), m.geometry.boundingSphere)).radius*Math.max(m.scale.x, m.scale.y, m.scale.z) > rx*0.45; } });
  return {g: grp, c: c, rx: rx, ry: ry, rz: rz, skin: skin, hair: hairM};
}

// a toy-head geometry: made (and recorded) or, for a look made before, the recorded one in the same order
var GREC = null;
function G(make){
  if(!GREC){ return make(); }
  if(GREC.replay){ var g0 = GREC.list[GREC.i++]; if(g0){ return g0; } GREC.replay = false; }
  var g = make(); g.userData.shared = true; GREC.list.push(g); return g;
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
    add(G(function(){ return skullGeo(THREE, rx, ry, rz, function(d){ return (d.z > 0.2 && d.y < 0.5) || d.y < -0.2 || (Math.abs(d.x) > 0.75 && d.y < 0.1) ? 0.95 : 1.012; }); }));
    return;
  }
  if(style === 2){
    var neon = new THREE.MeshStandardMaterial({color: "#5ff3ff", emissive: "#5ff3ff", emissiveIntensity: 1.1, roughness: 0.4});
    add(G(function(){ return skullGeo(THREE, rx, ry, rz, function(d){ return (d.z > 0.2 && d.y < 0.5) || d.y < -0.2 || (Math.abs(d.x) > 0.75 && d.y < 0.1) ? 0.95 : 1.01; }); }));
    for(var i = 0; i < 7; i++){
      var t = i / 6, a = -0.6 + t * 2.3, spike = new THREE.Mesh(G(function(){ return new THREE.ConeGeometry(rx * 0.12, ry * (0.42 - 0.1 * Math.abs(t - 0.4)), 8); }), neon);
      spike.position.set(c.x, c.y + Math.cos(a) * ry * 1.02, c.z + Math.sin(a) * rz * 1.02);
      spike.rotation.x = a; grp.add(spike);
    }
    return;
  }
  add(G(function(){ return shell(true, female ? -0.35 : -0.15); }));
  if(female && hat !== 4 && hat !== 1){
    var pts = [];
    for(var j = 0; j <= 12; j++){ var u = j / 12; pts.push(new THREE.Vector2(Math.sin(Math.min(1, u * 1.6) * Math.PI * 0.5) * rx * 0.42 * (1 - u * 0.55) + 0.002, -u * ry * 1.2)); }
    var tail = new THREE.Mesh(G(function(){ return new THREE.LatheGeometry(pts, 18); }), hairM);
    tail.position.copy(at(0, 0.48, -1.0)); tail.rotation.x = 0.75;
    var tie = new THREE.Mesh(G(function(){ return new THREE.TorusGeometry(rx * 0.12, rx * 0.04, 8, 16); }), mat(THREE, "#2b2b30", 0.6));
    tie.position.copy(tail.position); tie.rotation.x = Math.PI / 2 + 0.75;
    grp.add(tail, tie);
  }
}

// headwear (1 beanie, 2 cap, 3 headband, 4 party hat, 5 neural halo) and accessory (1 round glasses, 2 shades, 3 AR visor)
function wear(THREE, grp, spec, at, rx, ry, rz, c){
  var n0 = grp.children.length;
  wear0(THREE, grp, spec, at, rx, ry, rz, c);
  // headwear comes off under a car roof (games/hq3d.js hatsOf): tag what this added, except glasses and visors
  for(var i = n0; i < grp.children.length; i++){ if(!grp.children[i].userData.face){ grp.children[i].userData.hat = true; } }
}
function wear0(THREE, grp, spec, at, rx, ry, rz, c){
  var hw = spec[5] | 0, acc = spec[6] | 0, outfit = hexOf("outfitColor", spec[3]) || "#3f6fb3";
  if(hw === 1){
    var beanie = new THREE.Mesh(G(function(){ return skullGeo(THREE, rx, ry, rz, function(d){ return d.y > 0.18 ? 1.12 : 0.9; }); }), mat(THREE, outfit, 0.9));
    beanie.position.copy(c); grp.add(beanie);
    var cuff = new THREE.Mesh(G(function(){ return new THREE.TorusGeometry(1, 0.09, 8, 32); }), mat(THREE, outfit, 0.9));
    cuff.scale.set(rx * 1.08, rz * 1.08, ry * 0.9); cuff.rotation.x = Math.PI / 2; cuff.position.copy(at(0, 0.22, 0)); grp.add(cuff);
    var pom = new THREE.Mesh(G(function(){ return new THREE.SphereGeometry(rx * 0.16, sg(12), sg(10)); }), mat(THREE, "#f2f0ea", 1)); pom.position.copy(at(0, 1.18, 0)); grp.add(pom);
  } else if(hw === 2){
    var crown = new THREE.Mesh(G(function(){ return skullGeo(THREE, rx, ry, rz, function(d){ return d.y > 0.25 ? 1.1 : 0.9; }); }), mat(THREE, outfit, 0.8));
    crown.position.copy(c); grp.add(crown);
    var peak = new THREE.Mesh(G(function(){ return new THREE.CylinderGeometry(rx * 0.62, rx * 0.62, ry * 0.035, 24, 1, false, -Math.PI / 2, Math.PI); }), mat(THREE, outfit, 0.8));
    peak.position.copy(at(0, 0.28, 0.82)); peak.rotation.x = 0.12; grp.add(peak);
  } else if(hw === 3){
    var band = new THREE.Mesh(G(function(){ return new THREE.TorusGeometry(1, 0.06, 8, 40); }), mat(THREE, outfit, 0.8));
    band.scale.set(rx * 1.09, rz * 1.09, ry); band.rotation.x = Math.PI / 2 - 0.12; band.position.copy(at(0, 0.38, 0.02)); grp.add(band);
  } else if(hw === 4){
    var cone = new THREE.Mesh(G(function(){ return new THREE.ConeGeometry(rx * 0.42, ry * 1.0, 20); }), mat(THREE, "#ff5fa2", 0.6));
    cone.position.copy(at(0.15, 1.35, 0)); cone.rotation.z = -0.2; grp.add(cone);
  } else if(hw === 5){
    var halo = new THREE.Mesh(G(function(){ return new THREE.TorusGeometry(rx * 0.75, rx * 0.04, 8, 40); }),
      new THREE.MeshStandardMaterial({color: "#5ff3ff", emissive: "#5ff3ff", emissiveIntensity: 1.5}));
    halo.rotation.x = Math.PI / 2; halo.position.copy(at(0, 1.45, 0)); halo.userData.spin = true; grp.add(halo);
  }
  if(acc === 1 || acc === 2){
    var frame = mat(THREE, acc === 1 ? "#3b2a22" : "#111214", 0.4);
    var lens = acc === 2 ? new THREE.MeshStandardMaterial({color: "#141518", roughness: 0.1, metalness: 0.6}) : null;
    [-1, 1].forEach(function(sx){
      var ring = new THREE.Mesh(G(function(){ return new THREE.TorusGeometry(rx * 0.17, rx * 0.022, 8, 24); }), frame);
      ring.position.copy(at(sx * 0.36, -0.02, 1.02)); ring.rotation.y = sx * 0.3; ring.userData.face = true; grp.add(ring);
      if(lens){ var l = new THREE.Mesh(G(function(){ return new THREE.CircleGeometry(rx * 0.16, 20); }), lens); l.position.copy(ring.position); l.rotation.y = sx * 0.3; l.userData.face = true; grp.add(l); }
    });
    var bridge = new THREE.Mesh(G(function(){ return new THREE.CylinderGeometry(rx * 0.015, rx * 0.015, rx * 0.36, 6); }), frame);
    bridge.rotation.z = Math.PI / 2; bridge.position.copy(at(0, 0.0, 1.06)); bridge.userData.face = true; grp.add(bridge);
  } else if(acc === 3){
    var visor = new THREE.Mesh(G(function(){ return new THREE.CylinderGeometry(1, 1, ry * 0.26, 32, 1, true, -1.1, 2.2); }),
      new THREE.MeshStandardMaterial({color: "#5ff3ff", emissive: "#2aa9c9", emissiveIntensity: 0.9, transparent: true, opacity: 0.6, side: THREE.DoubleSide}));
    visor.scale.set(rx * 1.04, 1, rz * 1.06); visor.rotation.y = Math.PI / 2; visor.position.copy(at(0, 0.0, 0)); visor.userData.face = true; grp.add(visor);
  }
}

/* ---------- the body ---------- */
function recolour(L, mesh, spec, file){
  var THREE = L.THREE, mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
  var skin = hexOf("skin", spec[1]), chrome = spec[1] === 7, top = hexOf("outfitColor", spec[3]), tops = TOP[file] || [];
  var out = mats.map(function(m0){
    var m = m0.clone(), name = m.name || "";
    if(m.vertexColors && !mesh.geometry.attributes.color){ m.vertexColors = false; }   // (plainWhite)
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

// [load] per-outfit caches (build): PREP[file] {geo: original geometry -> softened, skull, legLen}; SITS[file|scale] clip;
// HEADG[look] the toy head's geometries, made once per outfit and look (toyHead)
var PREP = {}, SITS = {}, HEADG = {};
// a vertex colour that is plain opaque white everywhere changes nothing but costs a shader program of its own
// (USE_COLOR, USE_COLOR_ALPHA): dropped, so every body part is drawn by the one skinned program
function plainWhite(g){
  var c = g.attributes.color; if(!c){ return; }
  for(var i = 0; i < c.count; i++){
    for(var k = 0; k < c.itemSize; k++){ if(Math.abs(c.getComponent(i, k) - 1) > 1e-3){ return; } }
  }
  g.deleteAttribute("color");
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

// "sit": thighs level, shins down, the seat of the trousers at a chair's height (0.45 m when drawn 1.7 m tall, the old
// rig's sit and hq3d's SIT_H): the hip joints ride about 5 cm above what they sit on
function makeSit(ch, idle){
  var THREE = ch.L.THREE, B = ch.bones, o = ch.o, inner = ch.inner;
  var act = ch.mixer.clipAction(idle); act.play(); ch.mixer.update(0); act.stop();
  var keep = {}; ["Body", "UpperLegL", "UpperLegR", "LowerLegL", "LowerLegR", "FootL", "FootR"].forEach(function(n){
    if(B[n]){ keep[n] = {q: B[n].quaternion.clone(), p: B[n].position.clone()}; }
  });
  o.updateMatrixWorld(true);
  var want = 0.50 * CH_H / 1.7;     // hip height in o's units
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
      // [load] per outfit, once: the softened body geometry (shared by everyone wearing it), the skull, the legs
      var pre = PREP[file] || (PREP[file] = {geo: new Map(), skull: undefined, legLen: null});
      model.traverse(function(n){
        if(n.isBone){ bones[n.name] = n; }
        if(n.isMesh){
          n.castShadow = true; n.frustumCulled = false;
          if(/head/i.test(n.name) || (n.parent && /head/i.test(n.parent.name))){ heads.push(n); return; }
          var g0 = n.geometry, g = pre.geo.get(g0);
          if(!g){ g = g0.clone(); soften(g); plainWhite(g); g.userData.shared = true; pre.geo.set(g0, g); }
          n.geometry = g; recolour(L, n, spec, file);
        }
      });
      model.updateMatrixWorld(true);
      var legLen = pre.legLen ? {L: pre.legLen.L, R: pre.legLen.R} : {};
      if(!pre.legLen){
        ["L", "R"].forEach(function(s){
          var a = bones["LowerLeg" + s].getWorldPosition(new THREE.Vector3()), f = bones["Foot" + s].getWorldPosition(new THREE.Vector3());
          legLen[s] = a.distanceTo(f) * 0.93;
        });
        pre.legLen = {L: legLen.L, R: legLen.R};
      }
      if(pre.skull === undefined){ pre.skull = skullBox(THREE, model, bones.Head); }
      var skull = pre.skull ? pre.skull.clone() : null, head = null;
      heads.forEach(function(m){ m.visible = false; });
      if(bones.Head && skull){
        bones.Head.scale.setScalar(HEAD_K);
        head = toyHead(L, skull, spec, female, file);
        bones.Head.add(head.g);
      }
      ["WristL", "WristR"].forEach(function(b){ if(bones[b]){ bones[b].scale.setScalar(1.12); } });
      // normalise: o is CH_H tall with its feet at y 0
      var inner = new THREE.Group(); inner.add(model);
      var o = new THREE.Group(); o.add(inner); o.name = "person";
      o.updateMatrixWorld(true);
      var box = new THREE.Box3().setFromObject(o, true), h = box.max.y - box.min.y || 1, k = CH_H / h;
      inner.scale.setScalar(k); inner.position.y = -box.min.y * k;
      cullable(THREE, model);
      var mixer = new THREE.AnimationMixer(model), acts = {};
      // Posing on top of the clips (IK, seats, rails) must come off again before the next mixer step: three's mixer
      // writes a bone only when the clip's value changes, so a held clip (most of Idle, all of sit) never resets what
      // we added and it would pile up frame on frame. mark() snapshots every bone the first time a frame poses it;
      // the next update() puts them back first.
      var allBones = []; model.traverse(function(n){ if(n.isBone){ allBones.push(n); } });
      var snap = null, dirty = false, upd = mixer.update.bind(mixer);
      mixer.update = function(dt){
        if(dirty){ for(var i = 0; i < allBones.length; i++){ allBones[i].quaternion.copy(snap[i].q); allBones[i].position.copy(snap[i].p); } dirty = false; }
        return upd(dt);
      };
      Object.keys(ANIM).forEach(function(n){
        var cl = THREE.AnimationClip.findByName(clips, ANIM[n]);
        if(cl){ acts[n] = mixer.clipAction(cl); }
      });
      var ch = {o: o, inner: inner, model: model, mixer: mixer, acts: acts, cur: null, spec: spec, L: L, rig: "uni",
        bones: bones, legLen: legLen, head: head, scaleW: 1,
        mark: function(){
          if(dirty){ return; }
          if(!snap){ snap = allBones.map(function(b){ return {q: b.quaternion.clone(), p: b.position.clone()}; }); }
          else { for(var i = 0; i < allBones.length; i++){ snap[i].q.copy(allBones[i].quaternion); snap[i].p.copy(allBones[i].position); } }
          dirty = true;
        },
        update: function(t){
          if(head && !E.calm()){ head.g.traverse(function(m){ if(m.userData.spin){ m.rotation.z = t * 1.2; } }); }
        }};
      var idle = THREE.AnimationClip.findByName(clips, "Idle");
      if(idle){
        // [load] the sit pose is the same for one outfit drawn at one scale (the scale differs only with a tall hat)
        var sk = file + "|" + k.toFixed(6), sit = SITS[sk];
        if(sit === undefined){ try { sit = makeSit(ch, idle); } catch(e){ sit = null; /* no sit pose: standing fallback */ } SITS[sk] = sit; }
        if(sit){ acts.sit = mixer.clipAction(sit); }
      }
      // IK world units scale with how big o is drawn; callers set ch.scaleW = o's world scale when they seat it
      return ch;
    });
  });
}

/* ---------- crowds: light people for the City's residents (games/npcdraw.js, games/hqspectacle.js) ----------
 * Same bodies and toy heads, built to be drawn by the dozen: per outfit, one template whose body parts are merged
 * into a single skinned mesh and whose head is one mesh on the Head bone, every colour in a vertex colour, and the
 * recolourable parts (skin, top, hair) tagged by a slot attribute that the material's uniforms fill. A crowd
 * person is a clone of the template sharing its geometry: two draw calls, its own material (so its own colours)
 * and its own mixer, and recolour() changes the colours in place (pools hand a person on to someone else).
 *   HQV.people3d.crowd(base, variant) -> Promise<{o, mixer, acts, cur, rig, bones, recolour({skin, top, hair})}>
 *   variant {hair 0 own | 1 shaved, hat 0..3, acc 0..2} (the spec's hairStyle, headwear, accessory)
 */
var SLOT = {skin: 1, top: 2, hair: 3};
function crowdMat(THREE){
  var u = {uSkin: {value: new THREE.Color(0xf1c8a6)}, uTop: {value: new THREE.Color(0x3f6fb3)}, uHair: {value: new THREE.Color(0x3a2a20)}};
  var m = new THREE.MeshStandardMaterial({vertexColors: true, roughness: 0.72, metalness: 0});
  m.onBeforeCompile = function(sh){
    sh.uniforms.uSkin = u.uSkin; sh.uniforms.uTop = u.uTop; sh.uniforms.uHair = u.uHair;
    sh.vertexShader = sh.vertexShader.replace("#include <common>", "#include <common>\nattribute float aSlot;\nvarying float vSlot;")
      .replace("#include <begin_vertex>", "#include <begin_vertex>\nvSlot = aSlot;");
    sh.fragmentShader = sh.fragmentShader.replace("#include <common>", "#include <common>\nvarying float vSlot;\nuniform vec3 uSkin;\nuniform vec3 uTop;\nuniform vec3 uHair;")
      .replace("#include <color_fragment>", "#include <color_fragment>\nif(vSlot > 0.5){ diffuseColor.rgb *= vSlot < 1.5 ? uSkin : (vSlot < 2.5 ? uTop : uHair); }");
  };
  m.customProgramCacheKey = function(){ return "hq-crowd-person"; };
  m.userData.u = u;
  return m;
}
// geometries (each in the space `toSpace` maps it to) -> one non-indexed geometry with color + aSlot (+ skin attributes)
function mergeParts(THREE, parts, skinned){
  var n = 0;
  parts.forEach(function(pt){ pt.g = pt.g.index ? pt.g.toNonIndexed() : pt.g; n += pt.g.attributes.position.count; });
  var pos = new Float32Array(3*n), nrm = new Float32Array(3*n), col = new Float32Array(3*n), slot = new Float32Array(n);
  var si = skinned ? new Uint16Array(4*n) : null, sw = skinned ? new Float32Array(4*n) : null, o = 0, v = new THREE.Vector3();
  parts.forEach(function(pt){
    var g = pt.g, P = g.attributes.position, N = g.attributes.normal, nm = pt.m ? new THREE.Matrix3().getNormalMatrix(pt.m) : null;
    for(var i = 0; i < P.count; i++, o++){
      v.fromBufferAttribute(P, i); if(pt.m){ v.applyMatrix4(pt.m); } pos[3*o] = v.x; pos[3*o + 1] = v.y; pos[3*o + 2] = v.z;
      if(N){ v.fromBufferAttribute(N, i); if(nm){ v.applyMatrix3(nm).normalize(); } nrm[3*o] = v.x; nrm[3*o + 1] = v.y; nrm[3*o + 2] = v.z; }
      col[3*o] = pt.c.r; col[3*o + 1] = pt.c.g; col[3*o + 2] = pt.c.b; slot[o] = pt.slot;
      if(skinned){
        for(var k = 0; k < 4; k++){ si[4*o + k] = g.attributes.skinIndex.getComponent(i, k); sw[4*o + k] = g.attributes.skinWeight.getComponent(i, k); }
      }
    }
  });
  var out = new THREE.BufferGeometry();
  out.setAttribute("position", new THREE.BufferAttribute(pos, 3)); out.setAttribute("normal", new THREE.BufferAttribute(nrm, 3));
  out.setAttribute("color", new THREE.BufferAttribute(col, 3)); out.setAttribute("aSlot", new THREE.BufferAttribute(slot, 1));
  if(skinned){ out.setAttribute("skinIndex", new THREE.BufferAttribute(si, 4)); out.setAttribute("skinWeight", new THREE.BufferAttribute(sw, 4)); }
  out.computeBoundingSphere();
  return out;
}
var CROWD = {}, CROWD_HEAD = {};
// the body template for outfit `base`: {root, clips, sit, skull, female, file} (its head added per person: crowdHead)
function crowdTemplate(base){
  var file = FILES[base] || FILES[0];
  if(CROWD[file]){ return CROWD[file]; }
  return (CROWD[file] = E.lib().then(function(L){
    return Promise.all([E.loadGlb(L, "people", file), animsOf(L)]).then(function(r){
      var THREE = L.THREE, model = L.clone(r[0].scene), bones = {}, body = [], drop = [];
      model.traverse(function(n){
        if(n.isBone){ bones[n.name] = n; }
        if(n.isMesh){ if(n.isSkinnedMesh && !(/head/i.test(n.name) || (n.parent && /head/i.test(n.parent.name)))){ body.push(n); } else { drop.push(n); } }
      });
      model.updateMatrixWorld(true);
      var skull = bones.Head ? skullBox(THREE, model, bones.Head) : null, tops = TOP[file] || [];
      // every body part in one skinned mesh (one skeleton; each part's own bind matrix folded into its vertices)
      var sk = body[0].skeleton, bind = body[0].bindMatrix.clone(), bindInv = bind.clone().invert(), parts = [];
      body.forEach(function(m){
        var g = m.geometry.clone(); soften(g);
        var mats = Array.isArray(m.material) ? m.material : [m.material], fold = bindInv.clone().multiply(m.bindMatrix);
        var grp = g.groups.length > 1 ? g.groups : [{start: 0, count: 0, materialIndex: 0}];
        grp.forEach(function(gr){
          var mt = mats[gr.materialIndex] || mats[0], nm = mt.name || "", sub = g;
          if(g.groups.length > 1){ sub = g.clone(); sub.setIndex(Array.prototype.slice.call(g.index.array, gr.start, gr.start + gr.count)); }
          var slot = /^skin/i.test(nm) ? SLOT.skin : tops.indexOf(nm) >= 0 ? SLOT.top : 0;
          var c = slot ? new THREE.Color(1, 1, 1).multiplyScalar(/darker/i.test(nm) ? 0.85 : 1) : mt.color.clone();
          parts.push({g: sub, m: fold, c: c, slot: slot});
        });
      });
      var merged = new THREE.SkinnedMesh(mergeParts(THREE, parts, true), crowdMat(THREE));
      merged.name = "crowd-body"; merged.castShadow = true; merged.frustumCulled = false;
      body[0].parent.add(merged); merged.bind(sk, bind);
      body.concat(drop).forEach(function(m){ if(m.parent){ m.parent.remove(m); } });
      if(bones.Head){ bones.Head.scale.setScalar(HEAD_K); }
      ["WristL", "WristR"].forEach(function(b){ if(bones[b]){ bones[b].scale.setScalar(1.12); } });
      var inner = new THREE.Group(); inner.add(model);
      var o = new THREE.Group(); o.add(inner); o.name = "person";
      o.updateMatrixWorld(true);
      // measured with a plain toy head on, as build() measures its people
      var probe = skull && bones.Head ? toyHead(L, skull, [base, 0, 0, 0, 0, 0, 0, 0, 0, 0], FEMALE[base] || false).g : null;
      if(probe){ bones.Head.add(probe); o.updateMatrixWorld(true); }
      var box = new THREE.Box3().setFromObject(o, true), h = box.max.y - box.min.y || 1, k = CH_H / h;
      if(probe){ bones.Head.remove(probe); probe.traverse(function(m){ if(m.isMesh){ m.geometry.dispose(); m.material.dispose(); } }); }
      inner.scale.setScalar(k); inner.position.y = -box.min.y * k;
      var clips = r[1], idle = THREE.AnimationClip.findByName(clips, "Idle"), T = {root: o, clips: clips, sit: null, skull: skull, file: file, female: FEMALE[base] || false};
      if(idle){
        try {
          o.updateMatrixWorld(true);
          var legLen = {};
          ["L", "R"].forEach(function(sd){ legLen[sd] = bones["LowerLeg" + sd].getWorldPosition(new THREE.Vector3()).distanceTo(bones["Foot" + sd].getWorldPosition(new THREE.Vector3())) * 0.93; });
          var ch = {o: o, inner: inner, model: model, mixer: new THREE.AnimationMixer(model), bones: bones, legLen: legLen, L: L, scaleW: 1};
          T.sit = makeSit(ch, idle); ch.mixer.stopAllAction(); ch.mixer.uncacheRoot(model);
        } catch(e){ T.sit = null; }
      }
      return T;
    });
  }, function(e){ delete CROWD[file]; throw e; }));
}
// the merged toy head for a template and a variant, in head-bone space (no glow, no visor: crowds are seen from a way off)
function crowdHead(L, T, base, variant){
  var key = T.file + "|" + (variant.hair | 0) + "." + (variant.hat | 0) + "." + (variant.acc | 0);
  if(CROWD_HEAD[key] !== undefined){ return CROWD_HEAD[key]; }
  var THREE = L.THREE, geo = null;
  if(T.skull){
    SEGK = 0.45;
    var th; try { th = toyHead(L, T.skull, [base, 0, 0, 0, variant.hair | 0, variant.hat | 0, variant.acc | 0, 0, 0, 0], T.female); } finally { SEGK = 1; }
    var hp = [];
    th.g.updateMatrixWorld(true);
    th.g.traverse(function(m){
      if(!m.isMesh || m.material.transparent){ return; }
      var slot = m.userData.hat ? SLOT.top : m.material === th.skin ? SLOT.skin : m.material === th.hair ? SLOT.hair : 0;
      hp.push({g: m.geometry, m: m.matrixWorld.clone(), c: slot ? new THREE.Color(1, 1, 1) : m.material.color.clone(), slot: slot});
    });
    geo = mergeParts(THREE, hp, false);
    th.g.traverse(function(m){ if(m.isMesh){ m.geometry.dispose(); m.material.dispose(); } });
  }
  return (CROWD_HEAD[key] = geo);
}
function crowd(base, variant){
  base = Math.max(0, Math.min(FILES.length - 1, base | 0)); variant = variant || {};
  return Promise.all([E.lib(), crowdTemplate(base)]).then(function(r){
    var L = r[0], THREE = L.THREE, T = r[1], o = L.clone(T.root), bones = {}, model = o.children[0].children[0], mat = crowdMat(THREE);
    o.traverse(function(n){ if(n.isBone){ bones[n.name] = n; } if(n.isMesh){ n.material = mat; n.frustumCulled = false; } });
    var hg = crowdHead(L, T, base, variant);
    if(hg && bones.Head){ var hm = new THREE.Mesh(hg, mat); hm.name = "crowd-head"; hm.castShadow = true; bones.Head.add(hm); }
    cullable(THREE, o);
    var mixer = new THREE.AnimationMixer(model), acts = {};
    Object.keys(ANIM).forEach(function(n){ var cl = THREE.AnimationClip.findByName(T.clips, ANIM[n]); if(cl){ acts[n] = mixer.clipAction(cl); } });
    if(T.sit){ acts.sit = mixer.clipAction(T.sit); }
    var u = mat.userData.u;
    return {o: o, mixer: mixer, acts: acts, cur: null, rig: "uni", crowd: true, bones: bones, L: L, mat: mat, update: function(){},
      recolour: function(c){
        c = c || {};
        if(c.skin != null){ u.uSkin.value.set(c.skin); }
        if(c.top != null){ u.uTop.value.set(c.top); }
        if(c.hair != null){ u.uHair.value.set(c.hair); }
      },
      dispose: function(){ mat.dispose(); }};
  });
}

// the IK helpers need THREE, which arrives with the first build
var IK = {seat: seat, reach: reach, grip: grip, hold: hold, hand: handFrame, leg: legTo, mark: mark, twoBone: null, aim: null};
HQV.people3d = {FILES: FILES, FEMALE: FEMALE, TOP: TOP, CH_H: CH_H, ik: IK, crowd: crowd, GAIT: GAIT, gaitPlan: gaitPlan,
  gaitDrive: gaitDrive, gaitPost: gaitPost, build: function(spec){
  return build(spec).then(function(ch){
    if(!IK.twoBone){ var K = ikLib(ch.L.THREE); IK.twoBone = K.twoBone; IK.aim = K.aim; }
    return ch;
  });
}};
})();
