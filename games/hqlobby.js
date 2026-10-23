/* Claude HQ 2.0: the Lobby, the ground floor between the front door and Mission Control.
 *
 * The HQ revamp made it grand and yours (HQ Studio, games/hqstyle.js: int.themes.lobby and int.lobby): a double-
 * height hall with a mezzanine gallery, chandeliers, a ceiling (coffered, a glass skylight, beams, a dome or plain),
 * walls and floor in your finish, the lighting mood, a reception desk (curve, block, wood, marble or neon) with the
 * greeter bot, a centrepiece (a fountain, a statue, an aquarium column, a giant screen or an indoor tree), a seating
 * set, art or posters, rugs, signage with your HQ's name (on the wall, hanging, a floor monument or neon), an ambience
 * (heard only while Ambient sounds is on), and the decor you placed on its grid (games/hqdecor.js, instanced),
 * pet furniture among it (your pets come and use it: HQV.hqPets.lobby, when that is loaded).
 * Also: the "Today at HQ" screen, a check-in kiosk, the HQ Studio kiosk, security gates, the trophy case, and the
 * lifts: two up to Mission Control, one up to your Roof deck, one down to the B1 garage. The glass doors on the left
 * lead back outside.
 *
 * A floor of the 3D HQ: registered as HQV.hqWorlds.lobby and built by games/hq3d.js with its ctx helpers; returns
 * the world (see mount() in hq3d.js for the shape).
 */
(function(){
"use strict";
var HQV = window.HQV = window.HQV || {};
HQV.hqWorlds = HQV.hqWorlds || {};

var H = 12;          // the hall's height (double: the old lobby's 8 m walls, and a gallery above)
var GALLERY = 6.2;   // the mezzanine's floor
HQV.hqWorlds.lobby = function(c, w){
  var THREE = c.THREE, PI = c.PI, S = w.scene, R = 15;
  var mat = c.mat, emis = c.emis, box = c.box, cyl = c.cyl, sph = c.sph;
  var hits = [], doors = [], timeLights = [], D = HQV.hqDecor, ST = HQV.hqStyle;
  function style(){ var lk = c.look() || {}; return ST ? ST.clean(lk.style) : null; }

  // light: the mood sets the colours (rebuilt with the style)
  var hemi = new THREE.HemisphereLight(0xbcd7ff, 0x1a2430, 2.2); S.add(hemi);
  var sun = new THREE.DirectionalLight(0xffffff, 1.4); sun.position.set(18, 30, 14); sun.castShadow = true;
  sun.shadow.mapSize.set(2048, 2048); var sc = sun.shadow.camera; sc.left = -20; sc.right = 20; sc.top = 20; sc.bottom = -20; sc.far = 90;
  S.add(sun); S.add(sun.target);
  [[-2, 9, 2, 160], [6, 9, 4, 120], [0, 9, -9, 110]].forEach(function(p){ var l = new THREE.PointLight(0xffd9a0, p[3], 0, 2); l.position.set(p[0], p[1], p[2]); l.userData.base = p[3]; S.add(l); timeLights.push(l); });

  // the floor and the two walls (cut away on the camera's side): their finish is the style's (maps swapped on a change)
  var floorM = new THREE.MeshStandardMaterial({roughness: 0.3, metalness: 0.2});
  var floor = new THREE.Mesh(new THREE.PlaneGeometry(2*R, 2*R), floorM); floor.rotation.x = -PI/2; floor.receiveShadow = true; S.add(floor);
  var wallM = new THREE.MeshStandardMaterial({roughness: 0.85});
  function wallBox(w_, h_, d_, x, y, z){ var g = new THREE.BoxGeometry(w_, h_, d_), uv = g.attributes.uv, k = Math.max(w_, d_)/2.5, kv = h_/2.5;
    for(var i = 0; i < uv.count; i++) uv.setXY(i, uv.getX(i)*k, uv.getY(i)*kv); return c.add(new THREE.Mesh(g, wallM), x, y, z, S); }
  wallBox(2*R, H, 0.5, 0, H/2, -R - 0.25);
  wallBox(0.5, H, 11.5, -R - 0.25, H/2, -9.25); wallBox(0.5, H, 9.5, -R - 0.25, H/2, 10.25); wallBox(0.5, H - 6, 12, -R - 0.25, 6 + (H - 6)/2, 0);
  var trimM = mat(0x3a4a58, {metalness: 0.4, roughness: 0.4});
  box(2*R, 0.45, 0.9, trimM, 0, H + 0.05, -R - 0.1); box(0.9, 0.45, 2*R, trimM, -R - 0.1, H + 0.05, 0);
  box(2*R, 0.18, 0.3, trimM, 0, 0.09, -R + 0.15); box(0.3, 0.18, 2*R, trimM, -R + 0.15, 0.09, 0);    // skirting

  // the mezzanine gallery along the back and left walls: a slab, a glass balustrade, slim columns, uplights
  var slabM = mat(0xe6e1d8, {roughness: 0.5}), glassM = mat(0xbfe3f5, {transparent: true, opacity: 0.22, roughness: 0.05, metalness: 0.2});
  box(2*R, 0.35, 2.6, slabM, 0, GALLERY, -R + 1.3); box(2.6, 0.35, 2*R - 2.6, slabM, -R + 1.3, GALLERY, 1.3);
  box(2*R - 2.6, 1.0, 0.05, glassM, 1.3, GALLERY + 0.7, -R + 2.6, null, true); box(0.05, 1.0, 2*R - 2.6, glassM, -R + 2.6, GALLERY + 0.7, 1.3, null, true);
  var railM = mat(0xc9a227, {metalness: 0.9, roughness: 0.25});
  box(2*R - 2.6, 0.06, 0.08, railM, 1.3, GALLERY + 1.22, -R + 2.6); box(0.08, 0.06, 2*R - 2.6, railM, -R + 2.6, GALLERY + 1.22, 1.3);
  var colM = mat(0xdfe4e8, {roughness: 0.4});
  [[-6.2, -6.5], [6.2, -6.5]].forEach(function(p){ cyl(0.5, 0.5, H, colM, p[0], H/2, p[1], null, 24); cyl(0.66, 0.66, 0.25, railM, p[0], 0.12, p[1], null, 24); cyl(0.66, 0.66, 0.25, railM, p[0], H - 0.12, p[1], null, 24); });
  var uplM = new THREE.MeshBasicMaterial({color: 0xffd9a0, toneMapped: false});
  for(var ux = -12; ux <= 12; ux += 4) box(0.5, 0.05, 0.12, uplM, ux, GALLERY - 0.2, -R + 2.62, null, true);

  // "Today at HQ" on the left wall: live counts and a ticker
  var tick = c.canvasTex(1024, 400), tickS = c.screen(6.4, 2.5, tick.t); tickS.position.set(-R + 0.02, 3.8, -8.2); tickS.rotation.y = PI/2; S.add(tickS);
  box(0.2, 2.8, 6.8, mat(0x101a24, {metalness: 0.6}), -R - 0.02, 3.8, -8.2);
  var counts = {working: 0, needs: 0, idle: 0};
  function drawTicker(t){
    var g = tick.g; g.fillStyle = "#06111a"; g.fillRect(0, 0, 1024, 400);
    g.fillStyle = c.HEX.amber; g.font = "700 46px system-ui, sans-serif"; g.fillText("TODAY AT HQ", 34, 66);
    var rows = [["Working", String(counts.working)], ["Need you", String(counts.needs)], ["Idle", String(counts.idle)], ["HQ level", String(c.level())]];
    rows.forEach(function(r, i){ var x = 34 + (i % 2)*490, y = 150 + Math.floor(i/2)*84;
      g.fillStyle = "rgba(27,43,57,.9)"; c.rr(g, x, y - 46, 460, 64, 8); g.fill();
      g.fillStyle = c.HEX.muted; g.font = "600 28px system-ui, sans-serif"; g.fillText(r[0], x + 18, y - 4);
      g.fillStyle = i === 1 && counts.needs ? c.HEX.coral : c.HEX.ink; g.font = "600 32px ui-monospace, Menlo, monospace"; g.textAlign = "right"; g.fillText(r[1], x + 442, y - 2); g.textAlign = "left"; });
    g.fillStyle = "#0d1d29"; g.fillRect(0, 340, 1024, 60);
    var msg = "Take the lift to Mission Control  ·  Your crew is at their desks upstairs  ·  The Roof lift goes up to your helipad  ·  Style it all at the HQ Studio kiosk  ·  ";
    g.fillStyle = c.HEX.cyan; g.font = "600 28px ui-monospace, Menlo, monospace";
    var wd = g.measureText(msg).width, x0 = -((t*90) % wd); g.fillText(msg + msg + msg, x0, 380);
    tick.t.needsUpdate = true;
  }

  // the trophy case: what you have won (counts from the page)
  var tc = new THREE.Group(); tc.position.set(-10.2, 0, -R + 0.5); S.add(tc);
  var wood = mat(0x5a3b24, {roughness: 0.6}), gold = mat(0xd8b34a, {metalness: 0.9, roughness: 0.22}), silver = mat(0xc0c8d0, {metalness: 0.9, roughness: 0.22});
  box(4.2, 0.4, 1, wood, 0, 0.2, 0, tc); box(4.2, 0.2, 1, wood, 0, 4.1, 0, tc); box(0.15, 4, 1, wood, -2.05, 2.1, 0, tc); box(0.15, 4, 1, wood, 2.05, 2.1, 0, tc); box(4.2, 4, 0.08, mat(0x1b2530), 0, 2.1, -0.45, tc);
  [1.4, 2.5, 3.5].forEach(function(y){ box(3.9, 0.05, 0.85, mat(0xcfe6f5, {transparent: true, opacity: 0.4, roughness: 0.05}), 0, y, 0, tc); });
  [[-1.3, 1.43, gold, 1], [0, 1.43, silver, 0.8], [1.3, 1.43, gold, 0.9], [-0.8, 2.53, gold, 0.7], [0.8, 2.53, silver, 0.7], [0, 3.53, gold, 1.1]].forEach(function(tr){
    var g = new THREE.Group(); g.position.set(tr[0], tr[1], 0.05); g.scale.setScalar(tr[3]); tc.add(g);
    box(0.3, 0.12, 0.3, mat(0x2b2018), 0, 0.06, 0, g);
    var pts = [[0, 0], [0.06, 0], [0.04, 0.25], [0.18, 0.35], [0.2, 0.62], [0, 0.55]].map(function(q){ return new THREE.Vector2(q[0], q[1]); });
    c.add(new THREE.Mesh(new THREE.LatheGeometry(pts, 18), tr[2]), 0, 0.12, 0, g);
  });
  var tcTag = c.label("Trophy case", c.HEX.amber, 0.55); tcTag.position.set(-10.2, 5.0, -R + 1); S.add(tcTag);
  tc.traverse(function(o){ if(o.isMesh){ o.userData.tip = "Trophy case: your badges, shinies and best runs live in the Trophy Hall upstairs"; hits.push(o); } });

  // the lifts: a door each, with its indicator; walk up to one and its doors open
  var lifts = [];
  function liftDoor(x, z, ry, txt, col, d, light){
    var g = new THREE.Group(); g.position.set(x, 0, z); g.rotation.y = ry; S.add(g);
    box(2.9, 4.2, 0.25, mat(0x8d9aa6, {metalness: 0.85, roughness: 0.25}), 0, 2.1, 0, g);
    box(2.4, 3.5, 0.1, mat(0x0a1118), 0, 1.75, 0.1, g);
    var dm = mat(col, {metalness: 0.9, roughness: 0.2});
    var dl = box(1.18, 3.45, 0.08, dm, -0.6, 1.75, 0.18, g), dr = box(1.18, 3.45, 0.08, dm, 0.6, 1.75, 0.18, g);
    var it = c.canvasTex(512, 96, function(gg){ gg.fillStyle = "#06100a"; gg.fillRect(0, 0, 512, 96); gg.fillStyle = txt[1]; gg.font = "600 44px ui-monospace, Menlo, monospace"; gg.fillText(txt[0], 18, 62); });
    var ind = c.screen(2.2, 0.42, it.t); ind.position.set(0, 3.85, 0.14); g.add(ind);
    var lt = new THREE.PointLight(light, 0, 0, 2); lt.position.set(0, 2.2, 0.6); g.add(lt);
    g.traverse(function(o){ if(o.isMesh){ o.userData.door = d; hits.push(o); } });
    doors.push(d);
    return {dl: dl, dr: dr, open: 0, light: lt, front: d.front};
  }
  [8.2, 11.6].forEach(function(lx){
    lifts.push(liftDoor(lx, -R + 0.05, 0, ["▲ 3  Mission Control", c.HEX.amber], 0xb9c3cc, {view: "@mission", label: "Lift", tip: "Lift: up to Mission Control", front: new THREE.Vector3(lx, 0, -R + 1.8)}, 0xfff1d6));
  });
  var liftTag = c.label("Lifts · Mission Control", c.HEX.amber, 0.55); liftTag.position.set(9.9, 5.1, -R + 0.8); S.add(liftTag);
  // the HQ revamp: a lift up to your roof deck and its helipad (games/hqcity3d.js spawnFrom.roof)
  lifts.push(liftDoor(4.6, -R + 0.05, 0, ["▲ R  Roof · Helipad", c.HEX.green], 0x9fb0a0, {view: "@roof", kind: "lift", label: "Roof lift", tip: "Lift: up to your roof deck and helipad", front: new THREE.Vector3(4.6, 0, -R + 1.8)}, 0xd8ffe0));
  var roofTag = c.label("Lift · Roof & helipad", c.HEX.green, 0.5); roofTag.position.set(4.6, 4.9, -R + 0.8); S.add(roofTag);
  // [basement 3.4] a third lift on the right wall, down to the B1 basement garage (games/hqbasement.js)
  var b1 = (function(){
    var g = new THREE.Group(); g.position.set(R - 0.05, 0, -8); g.rotation.y = -PI/2; S.add(g);
    box(2.9, 4.2, 0.25, mat(0x8d9aa6, {metalness: 0.85, roughness: 0.25}), 0, 2.1, 0, g);
    box(2.4, 3.5, 0.1, mat(0x0a1118), 0, 1.75, 0.1, g);
    var dm = mat(0x2b3138, {metalness: 0.9, roughness: 0.18});
    var dl = box(1.18, 3.45, 0.08, dm, -0.6, 1.75, 0.18, g), dr = box(1.18, 3.45, 0.08, dm, 0.6, 1.75, 0.18, g);
    var it = c.canvasTex(512, 96, function(gg){ gg.fillStyle = "#100a06"; gg.fillRect(0, 0, 512, 96); gg.fillStyle = c.HEX.cyan; gg.font = "600 44px ui-monospace, Menlo, monospace"; gg.fillText("▼ B1  Garage", 18, 62); });
    var ind = c.screen(2.2, 0.42, it.t); ind.position.set(0, 3.85, 0.14); g.add(ind);
    var light = new THREE.PointLight(0xbfe9ff, 0, 0, 2); light.position.set(0, 2.2, 0.6); g.add(light);
    var d = {view: "@basement", kind: "lift", label: "Garage lift", tip: "Lift: down to your B1 basement garage", front: new THREE.Vector3(R - 1.8, 0, -8)};
    g.traverse(function(o){ if(o.isMesh){ o.userData.door = d; hits.push(o); } });
    doors.push(d);
    var tag = c.label("Lift · B1 Basement garage", c.HEX.cyan, 0.55); tag.position.set(R - 0.8, 5.1, -8); S.add(tag);
    return {dl: dl, dr: dr, open: 0, light: light};
  })();

  // entrance: glass wall and sliding doors on the left wall, the street beyond
  var outside = c.screen(14, 7, c.sky(false)); outside.position.set(-17, 3.5, 0); outside.rotation.y = PI/2; S.add(outside);
  var glassD = mat(0xbfe3f5, {transparent: true, opacity: 0.16, roughness: 0.05, metalness: 0.1}), frameM = mat(0x3a4652, {metalness: 0.8, roughness: 0.3});
  [-6, -3.6, 3.6, 6].forEach(function(z){ box(0.14, 6, 0.14, frameM, -R - 0.1, 3, z); });
  box(0.14, 0.14, 12, frameM, -R - 0.1, 6, 0); box(0.14, 0.14, 12, frameM, -R - 0.1, 4.3, 0);
  [[-4.8, 2.4], [4.8, 2.4]].forEach(function(p){ box(0.04, 6, p[1], glassD, -R - 0.1, 3, p[0]); });
  var slideL = box(0.06, 4.2, 1.8, glassD, -R - 0.05, 2.1, -0.9), slideR = box(0.06, 4.2, 1.8, glassD, -R - 0.05, 2.1, 0.9);
  var exit = {view: "@base", label: "Front door", tip: "Front door: out to the Base", front: new THREE.Vector3(-R + 1.6, 0, 0)};
  [slideL, slideR].forEach(function(o){ o.userData.door = exit; hits.push(o); });
  doors.push(exit);
  var mt = c.canvasTex(256, 128, function(g){ g.fillStyle = "#2b2018"; g.fillRect(0, 0, 256, 128); g.strokeStyle = c.HEX.amber; g.lineWidth = 4; g.strokeRect(8, 8, 240, 112); g.fillStyle = c.HEX.amber; g.font = "700 40px system-ui, sans-serif"; g.textAlign = "center"; g.fillText("WELCOME", 128, 78); });
  var mat1 = c.screen(2.6, 1.3, mt.t); mat1.rotation.set(-PI/2, 0, PI/2); mat1.position.set(-R + 1.6, 0.012, 0); S.add(mat1);
  var outTag = c.label("Front door · the Base", c.HEX.green, 0.55); outTag.position.set(-R + 0.4, 7.0, 0); S.add(outTag);

  // a lit path on the floor from the front door to the lifts (one instanced mesh)
  var guide = [[-R + 2.6, 0], [3.5, 0], [9.9, -6], [9.9, -R + 2.4]], dotsAt = [];
  for(var gi = 1; gi < guide.length; gi++){
    var a0 = guide[gi - 1], a1 = guide[gi], len = Math.hypot(a1[0] - a0[0], a1[1] - a0[1]), n = Math.floor(len/0.9);
    for(var k = 0; k < n; k++){ var u = k/n; dotsAt.push([a0[0] + (a1[0] - a0[0])*u, a0[1] + (a1[1] - a0[1])*u]); }
  }
  var dotM = new THREE.MeshBasicMaterial({color: c.COL.amber, transparent: true, opacity: 0.55, toneMapped: false}), dotGeo = new THREE.CircleGeometry(0.12, 12); dotGeo.rotateX(-PI/2);
  var dots = new THREE.InstancedMesh(dotGeo, dotM, dotsAt.length), dm4 = new THREE.Matrix4();
  dotsAt.forEach(function(p, i){ dm4.makeTranslation(p[0], 0.02, p[1]); dots.setMatrixAt(i, dm4); }); S.add(dots);
  var mcTag = c.label("Mission Control ↑", c.HEX.amber, 0.6); mcTag.position.set(9.9, 3.2, -R + 3.4); S.add(mcTag);

  // security gates, the check-in kiosk, and the HQ Studio kiosk (it opens the Studio)
  for(var gt = 0; gt < 5; gt++){
    var gz = -2.6 + gt*1.3; box(0.3, 1.05, 0.9, mat(0xd6dde3, {metalness: 0.6, roughness: 0.3}), -9.5, 0.525, gz);
    box(0.32, 0.04, 0.7, emis(0x0d1a24, c.COL.green, 1.6), -9.5, 1.07, gz, null, true);
  }
  function kioskAt(x, z, ry, draw){
    var g = new THREE.Group(); g.position.set(x, 0, z); g.rotation.y = ry; S.add(g);
    cyl(0.08, 0.14, 1.2, mat(0x3a4652, {metalness: 0.7}), 0, 0.6, 0, g, 10);
    var kt = c.canvasTex(256, 192, draw), kp = c.screen(0.68, 0.48, kt.t); kp.position.set(0, 1.42, 0.04); kp.rotation.x = -0.5; g.add(kp);
    box(0.75, 0.55, 0.06, mat(0x1d2128), 0, 1.4, 0, g).rotation.x = -0.5;
    return g;
  }
  kioskAt(-11.4, 5.6, PI/2 + 0.3, function(g){ g.fillStyle = "#08131c"; g.fillRect(0, 0, 256, 192); g.fillStyle = c.HEX.amber; g.font = "700 26px system-ui, sans-serif"; g.textAlign = "center"; g.fillText("CHECK IN", 128, 46); g.fillStyle = c.HEX.ink; g.font = "500 18px system-ui, sans-serif"; g.fillText("Visitors tap their card", 128, 82); g.strokeStyle = c.HEX.cyan; g.lineWidth = 4; c.rr(g, 78, 104, 100, 64, 10); g.stroke(); });
  var studioK = kioskAt(-7.0, -11.6, 0.4, function(g){ g.fillStyle = "#140c1c"; g.fillRect(0, 0, 256, 192); g.fillStyle = c.HEX.amber; g.font = "700 28px system-ui, sans-serif"; g.textAlign = "center"; g.fillText("HQ STUDIO", 128, 50);
    g.fillStyle = c.HEX.ink; g.font = "500 18px system-ui, sans-serif"; g.fillText("Style your tower,", 128, 90); g.fillText("lobby and floors", 128, 114); ["#ff6b5b", "#ffb347", "#6fd38a", "#5fd3e6", "#9b8cf0"].forEach(function(col, i){ g.fillStyle = col; g.fillRect(48 + i*34, 140, 26, 26); }); });
  var studioDoor = {view: null, kind: "studio", label: "HQ Studio", tip: "HQ Studio: style your tower, lobby and floors", front: new THREE.Vector3(-6.4, 0, -10.6)};
  studioK.traverse(function(o){ if(o.isMesh){ o.userData.door = studioDoor; hits.push(o); } });
  var skTag = c.label("HQ Studio", c.HEX.amber, 0.5); skTag.position.set(-7.0, 2.6, -11.6); S.add(skTag);

  // the greeter bot behind reception (its desk is the style's)
  var bot = new THREE.Group(); bot.position.set(0, 0, -10.8); S.add(bot);
  var botBody = new THREE.Group(); bot.add(botBody);
  var white = mat(0xf2f5f7, {roughness: 0.3, metalness: 0.2});
  cyl(0.45, 0.38, 0.9, white, 0, 1.45, 0, botBody); sph(0.45, white, 0, 1.9, 0, botBody).scale.y = 0.5;
  box(0.9, 0.6, 0.6, white, 0, 2.45, 0, botBody);
  var face = c.canvasTex(256, 160), facePlane = c.screen(0.78, 0.48, face.t); facePlane.position.set(0, 2.45, 0.305); botBody.add(facePlane);
  var arm = new THREE.Group(); arm.position.set(0.5, 1.7, 0); botBody.add(arm);
  var ag = new THREE.CylinderGeometry(0.07, 0.06, 0.55, 8); ag.translate(0, -0.27, 0); c.add(new THREE.Mesh(ag, white), 0, 0, 0, arm);
  var hover = c.glow(c.COL.cyan, 1.4, 0.6); hover.position.set(0, 0.6, 0); bot.add(hover);
  var botTag = c.label("Reception", c.HEX.cyan, 0.5); botTag.position.set(0, 3.3, 0); bot.add(botTag);
  function drawFace(t, wave){
    var g = face.g; g.fillStyle = "#08131c"; g.fillRect(0, 0, 256, 160); g.fillStyle = c.HEX.cyan;
    var blink = (t % 4) < 0.12;
    [88, 168].forEach(function(x){ if(blink) g.fillRect(x - 20, 70, 40, 6); else { c.rr(g, x - 16, 46, 32, 46, 14); g.fill(); } });
    g.strokeStyle = c.HEX.cyan; g.lineWidth = 6; g.beginPath(); g.arc(128, 104, 24, 0.2, PI - 0.2); g.stroke();
    if(wave){ g.fillStyle = c.HEX.amber; g.font = "700 26px system-ui, sans-serif"; g.textAlign = "center"; g.fillText("Hi!", 222, 34); g.textAlign = "left"; }
    face.t.needsUpdate = true;
  }

  /* ---------- what HQ Studio styles: rebuilt when the style changes ---------- */
  var dyn = null, dynKey = null, gridO = D ? D.grid(c, S, 13) : null, amb = null;
  var signTex = null;
  function drawSign(){
    if(!signTex) return;
    var g = signTex.g, look = c.look(), st = style(), font = st && HQV.hqTower ? HQV.hqTower.FONT[st.ext.font] : "700 {s}px system-ui, sans-serif";
    var col = st ? st.ext.signColor : "#fff5e6", L = st ? st.int.lobby : {signage: "wall"};
    g.clearRect(0, 0, 1024, 256); g.textAlign = "center";
    if(L.signage === "neon"){ g.shadowColor = col; g.shadowBlur = 24; }
    g.strokeStyle = c.HEX.amber; g.lineWidth = 8; g.lineCap = "round";
    if(L.signage !== "neon") for(var i = 0; i < 8; i++){ var a = i/8*PI*2; g.beginPath(); g.moveTo(140 + Math.cos(a)*18, 110 + Math.sin(a)*18); g.lineTo(140 + Math.cos(a)*62, 110 + Math.sin(a)*62); g.stroke(); }
    g.fillStyle = col; g.font = font.replace("{s}", 110); g.fillText(c.short((look.sign || "CLAUDE HQ").toUpperCase(), 14), L.signage === "neon" ? 512 : 570, 150);
    g.shadowBlur = 0; g.fillStyle = c.HEX.amber; g.font = "600 34px ui-monospace, Menlo, monospace"; g.fillText("MISSION CONTROL · ROOF · B1 GARAGE · ARENA", 570, 214);
    signTex.t.needsUpdate = true;
  }
  function build(){
    var st = style(); if(!st) return;
    var key = JSON.stringify([st.int.themes.lobby, st.int.lobby, st.int.items.filter(function(it){ return it.f === "lobby"; }), st.ext.signColor, st.ext.font, (c.look() || {}).sign]);
    if(key === dynKey) return; dynKey = key;
    if(dyn){ S.remove(dyn.g); if(dyn.items) dyn.items.dispose(); }
    var g = new THREE.Group(); g.name = "lobby-style"; S.add(g);
    dyn = {g: g, items: null, chand: [], water: [], blockers: [], fish: null, screen: null};
    var T = st.int.themes.lobby, L = st.int.lobby, Mo = D.MOODS[T.mood] || D.MOODS.warm;
    // the finishes and the light
    var ft = D.floorTex(c, T.floor); ft.wrapS = ft.wrapT = THREE.RepeatWrapping; ft.repeat.set(5, 5); floorM.map = ft; floorM.roughness = T.floor === "carpet" ? 0.95 : T.floor === "concrete" ? 0.8 : 0.3; floorM.needsUpdate = true;
    var wt = D.wallTex(c, T.wall); wt.wrapS = wt.wrapT = THREE.RepeatWrapping; wallM.map = wt; wallM.needsUpdate = true;
    hemi.color.set(Mo.hemi); hemi.groundColor.set(Mo.ground); timeLights.forEach(function(l){ l.color.set(Mo.lamp); l.userData.k = Mo.lampK; });
    uplM.color.set(Mo.lamp); dyn.mood = Mo;
    // the ceiling: a cornice frieze, and the kind's own frame (the camera looks in from above: open where it looks)
    var cm = mat(0xe8e2d6, {roughness: 0.6}), beamM = mat(0x6b4a32, {roughness: 0.7});
    if(L.ceiling === "coffer"){ for(var cx = -R + 2.5; cx < R; cx += 5) box(0.35, 0.6, 2*R, cm, cx, H - 0.3, 0, g); for(var cz = -R + 2.5; cz < -4; cz += 5) box(2*R, 0.6, 0.35, cm, 0, H - 0.3, cz, g); }
    else if(L.ceiling === "glass"){ var gm = mat(0xbfe3f5, {transparent: true, opacity: 0.12, roughness: 0.05}); c.add(new THREE.Mesh(new THREE.BoxGeometry(2*R, 0.05, 10), gm), 0, H, -R + 5, g, true); for(var gx = -R; gx <= R; gx += 2.5) box(0.08, 0.12, 10, railM, gx, H, -R + 5, g); }
    else if(L.ceiling === "beams"){ for(var bx = -R + 1.5; bx < R; bx += 3) box(0.4, 0.5, 2*R, beamM, bx, H - 0.25, 0, g); }
    else if(L.ceiling === "dome"){ var dmh = new THREE.Mesh(new THREE.SphereGeometry(6, 32, 12, 0, PI*2, 0, PI/2), mat(0xe8e2d6, {side: THREE.DoubleSide, transparent: true, opacity: 0.35})); dmh.position.set(-1.5, H - 0.5, -2); g.add(dmh);
      cyl(6.1, 6.1, 0.4, railM, -1.5, H - 0.5, -2, g, 48); }
    box(2*R, 0.3, 0.2, railM, 0, H - 0.6, -R + 0.1, g); box(0.2, 0.3, 2*R, railM, -R + 0.1, H - 0.6, 0, g);
    // chandeliers: gold rings with crystal drops (two instanced meshes for all of them) and a glow each
    var chandAt = [[-1.5, 3.4], [7.5, -4], [-8, -2]], crys = new THREE.InstancedMesh(new THREE.OctahedronGeometry(0.09), mat(0xeaf6ff, {roughness: 0.05, metalness: 0.3, emissive: new THREE.Color(Mo.lamp), emissiveIntensity: 0.6}), chandAt.length*36);
    var ringI = new THREE.InstancedMesh(new THREE.TorusGeometry(1, 0.04, 6, 32), railM, chandAt.length*3), m4 = new THREE.Matrix4(), q = new THREE.Quaternion(), e = new THREE.Euler(), sv = new THREE.Vector3(), pv = new THREE.Vector3(), ci = 0, ri = 0;
    chandAt.forEach(function(p){
      box(0.03, H - 8.6, 0.03, railM, p[0], 8.6 + (H - 8.6)/2, p[1], g, true);
      [[1.2, 8.6], [0.85, 8.3], [0.45, 8.0]].forEach(function(r){ e.set(PI/2, 0, 0); q.setFromEuler(e); pv.set(p[0], r[1], p[1]); sv.set(r[0], r[0], r[0]); m4.compose(pv, q, sv); ringI.setMatrixAt(ri++, m4);
        for(var j = 0; j < 12; j++){ var a = j/12*PI*2; m4.makeTranslation(p[0] + Math.cos(a)*r[0], r[1] - 0.22, p[1] + Math.sin(a)*r[0]); crys.setMatrixAt(ci++, m4); } });
      var gl = c.glow(Mo.lamp, 3.4, 0.55); gl.position.set(p[0], 8.2, p[1]); g.add(gl); dyn.chand.push(gl);
    });
    g.add(crys); g.add(ringI);
    // the sign with your HQ's name: on the back wall over reception, hanging from the ceiling, a monument by the door, or neon
    signTex = c.canvasTex(1024, 256);
    var sign = c.screen(9, 2.25, signTex.t, true);
    if(L.signage === "hanging"){ sign.position.set(0, 8.4, -6.8); [-4.2, 4.2].forEach(function(x){ box(0.02, H - 9.5, 0.02, railM, x, 9.5 + (H - 9.5)/2, -6.8, g, true); }); }
    else if(L.signage === "floor"){ sign.scale.setScalar(0.45); sign.position.set(-9.8, 1.35, 7.2); sign.rotation.y = PI/2 - 0.5; c.add(new THREE.Mesh(new THREE.BoxGeometry(0.4, 1.6, 4.4), mat(0x2b3440, {roughness: 0.4})), -10.0, 0.8, 7.2 - 0.05, g).rotation.y = -0.5; }
    else sign.position.set(0, 8.2, -R + 0.3);
    g.add(sign); drawSign();
    if(L.signage !== "hanging" && L.signage !== "floor"){ var slat = mat(L.signage === "neon" ? 0x1a1a24 : 0x8a5a35, {roughness: 0.7}); for(var sx = -6.5; sx <= 6.5; sx += 0.32) box(0.18, 7.0, 0.14, slat, sx, 3.5 + 3.1, -R + 0.08, g); }
    // reception
    var rec = new THREE.Group(); rec.position.set(0, 0, -9); g.add(rec);
    var top = {curve: 0xe8dccb, block: 0xf2f2f2, wood: 0x8a5a35, marble: 0xe6e2da, neon: 0x15151c}[L.reception], body = {curve: 0xd6dde3, block: 0xdcdcdc, wood: 0x6b4a32, marble: 0xd8d2c8, neon: 0x0e0e14}[L.reception];
    if(L.reception === "curve" || L.reception === "neon"){
      var arc = new THREE.Shape(); arc.absarc(0, 0, 3.4, PI, PI*2, false); arc.absarc(0, 0, 2.7, PI*2, PI, true);
      var topGeo = new THREE.ExtrudeGeometry(arc, {depth: 0.1, bevelEnabled: false}); topGeo.rotateX(-PI/2);
      c.add(new THREE.Mesh(topGeo, mat(top, {roughness: 0.35})), 0, 1.15, 0, rec);
      c.add(new THREE.Mesh(new THREE.CylinderGeometry(3.2, 3.2, 1.15, 48, 1, true, -PI/2, PI), mat(body, {roughness: 0.5, side: THREE.DoubleSide})), 0, 0.575, 0, rec);
      c.add(new THREE.Mesh(new THREE.CylinderGeometry(3.23, 3.23, 0.05, 48, 1, true, -PI/2, PI), new THREE.MeshBasicMaterial({color: L.reception === "neon" ? 0xff3d8b : c.COL.amber, side: THREE.DoubleSide, toneMapped: false})), 0, L.reception === "neon" ? 0.6 : 0.1, 0, rec, true);
    } else {
      box(6.2, 1.1, 1.0, mat(body, {roughness: L.reception === "marble" ? 0.25 : 0.6}), 0, 0.55, 1.6, rec); box(6.4, 0.08, 1.2, mat(top, {roughness: 0.3}), 0, 1.14, 1.6, rec);
      if(L.reception === "wood") for(var wx = -2.9; wx <= 2.9; wx += 0.3) box(0.12, 1.0, 0.04, mat(0x5a3b24), wx, 0.55, 2.12, rec);
      if(L.reception === "marble") box(6.3, 0.05, 0.05, railM, 0, 0.12, 2.12, rec);
    }
    dyn.blockers.push(function(x, z){ return Math.hypot(x, z + 9) < 3.6 && z > -12.5; });
    // the centrepiece, on the old hologram's spot
    var cx0 = -1.5, cz0 = 3.4, cen = new THREE.Group(); cen.position.set(cx0, 0, cz0); g.add(cen);
    var waterM = new THREE.MeshStandardMaterial({color: 0x2a7fa8, emissive: new THREE.Color(c.COL.cyan), emissiveIntensity: 0.35, transparent: true, opacity: 0.85, roughness: 0.05});
    if(L.centre === "fountain"){
      cyl(2.6, 2.7, 0.55, mat(0xd6d0c4, {roughness: 0.6}), 0, 0.27, 0, cen, 40); cyl(2.4, 2.4, 0.05, waterM, 0, 0.5, 0, cen, 40);
      cyl(0.5, 0.7, 1.4, mat(0xd6d0c4), 0, 1.0, 0, cen, 20); cyl(1.4, 1.2, 0.25, mat(0xd6d0c4), 0, 1.75, 0, cen, 28); cyl(1.25, 1.25, 0.04, waterM, 0, 1.86, 0, cen, 28);
      cyl(0.18, 0.25, 1.0, mat(0xd6d0c4), 0, 2.3, 0, cen, 12); cyl(0.6, 0.5, 0.18, mat(0xd6d0c4), 0, 2.85, 0, cen, 20);
      for(var j = 0; j < 12; j++){ var jg = c.glow(0x9fe3f0, 0.4, 0.9); cen.add(jg); dyn.water.push({g: jg, a: j/12*PI*2, o: (j % 4)/4}); }
      dyn.blockers.push(function(x, z){ return Math.hypot(x - cx0, z - cz0) < 3.0; });
    } else if(L.centre === "statue"){
      box(2.2, 1.2, 2.2, mat(0x3a4048, {roughness: 0.5}), 0, 0.6, 0, cen); var gd = mat(0xd8b34a, {metalness: 0.9, roughness: 0.25});
      sph(0.9, gd, 0, 2.3, 0, cen).scale.y = 1.2; [-0.45, 0.45].forEach(function(x){ c.add(new THREE.Mesh(new THREE.ConeGeometry(0.28, 0.8, 6), gd), x, 3.4, 0, cen).rotation.z = -x*0.7; });
      dyn.blockers.push(function(x, z){ return Math.abs(x - cx0) < 1.4 && Math.abs(z - cz0) < 1.4; });
    } else if(L.centre === "aquarium"){
      cyl(1.9, 1.9, 0.5, mat(0x1d2128, {metalness: 0.6}), 0, 0.25, 0, cen, 40); cyl(1.9, 1.9, 0.5, mat(0x1d2128, {metalness: 0.6}), 0, 7.25, 0, cen, 40);
      var tank = new THREE.Mesh(new THREE.CylinderGeometry(1.8, 1.8, 6.5, 40, 1, true), waterM); tank.position.y = 3.75; cen.add(tank);
      var fishI = new THREE.InstancedMesh(new THREE.ConeGeometry(0.12, 0.38, 6), mat(0xffa040, {emissive: new THREE.Color(0x803000), emissiveIntensity: 0.3}), 14); fishI.userData.anim = true; cen.add(fishI); dyn.fish = fishI;
      dyn.blockers.push(function(x, z){ return Math.hypot(x - cx0, z - cz0) < 2.2; });
    } else if(L.centre === "screen"){
      var sT = c.canvasTex(1024, 512); dyn.screen = sT; var sc2 = c.screen(10, 5, sT.t); sc2.position.set(0, 8.6, -R + 0.32 - cz0); sc2.rotation.y = 0; cen.add(sc2);
      sc2.position.set(-cx0, 9.0, -R + 2.75 - cz0);
      box(1.6, 0.9, 1.6, mat(0x2b3440), 0, 0.45, 0, cen); var hol = new THREE.Mesh(new THREE.IcosahedronGeometry(0.7, 1), new THREE.MeshBasicMaterial({color: c.COL.cyan, wireframe: true, transparent: true, opacity: 0.7, toneMapped: false})); hol.position.y = 1.8; hol.userData.anim = true; cen.add(hol); dyn.holo = hol;
      dyn.blockers.push(function(x, z){ return Math.abs(x - cx0) < 1.1 && Math.abs(z - cz0) < 1.1; });
    } else {
      cyl(2.0, 2.2, 0.8, mat(0x6b5a48, {roughness: 0.8}), 0, 0.4, 0, cen, 32); cyl(1.85, 1.85, 0.06, mat(0x3a2a1a), 0, 0.8, 0, cen, 32);
      cyl(0.25, 0.45, 5.2, mat(0x5a3d2a, {roughness: 0.9}), 0, 3.2, 0, cen, 10);
      [[0, 6.2, 0, 2.6], [1.3, 5.2, 0.6, 1.7], [-1.2, 5.4, -0.5, 1.8], [0.4, 4.6, -1.3, 1.4], [-0.6, 4.4, 1.3, 1.5]].forEach(function(f, i){ sph(f[3], mat([0x2f7d4a, 0x3c9a5a, 0x276b3e][i % 3], {roughness: 0.85}), f[0], f[1], f[2], cen).scale.y = 0.75; });
      dyn.blockers.push(function(x, z){ return Math.hypot(x - cx0, z - cz0) < 2.4; });
    }
    // the rug in front of the centrepiece and under the seating
    if(L.rug !== "none"){
      var rT = c.canvasTex(512, 512, function(gg, W){
        var R2 = c.rng(c.hashStr("rug" + L.rug)); gg.clearRect(0, 0, W, W);
        if(L.rug === "round"){ gg.fillStyle = "#3a5a7a"; gg.beginPath(); gg.arc(256, 256, 250, 0, 7); gg.fill(); gg.strokeStyle = "#e8d8b0"; gg.lineWidth = 10; for(var r2 = 60; r2 < 250; r2 += 50){ gg.beginPath(); gg.arc(256, 256, r2, 0, 7); gg.stroke(); } return; }
        gg.fillStyle = L.rug === "persian" ? "#7a2f3a" : L.rug === "stripe" ? "#e8e0d0" : "#1f2b3a"; gg.fillRect(0, 0, W, W);
        if(L.rug === "persian"){ gg.strokeStyle = "#d8b34a"; gg.lineWidth = 14; gg.strokeRect(24, 24, W - 48, W - 48); gg.fillStyle = "#2f4a7a"; gg.beginPath(); gg.ellipse(256, 256, 140, 90, 0, 0, 7); gg.fill();
          for(var i2 = 0; i2 < 60; i2++){ gg.fillStyle = ["#d8b34a", "#e8d8b0", "#2f4a7a"][i2 % 3]; gg.fillRect(40 + R2()*430, 40 + R2()*430, 8, 8); } }
        else if(L.rug === "stripe"){ for(var y2 = 0; y2 < W; y2 += 48){ gg.fillStyle = ["#c8743a", "#3f8f5a", "#2f4a7a"][(y2/48) % 3]; gg.fillRect(0, y2, W, 20); } }
        else { gg.strokeStyle = "#ffb347"; gg.lineWidth = 6; for(var gx2 = 0; gx2 < W; gx2 += 64) for(var gy2 = 0; gy2 < W; gy2 += 64){ gg.beginPath(); gg.moveTo(gx2, gy2 + 32); gg.lineTo(gx2 + 32, gy2); gg.lineTo(gx2 + 64, gy2 + 32); gg.lineTo(gx2 + 32, gy2 + 64); gg.closePath(); gg.stroke(); } }
      });
      var rm = new THREE.MeshStandardMaterial({map: rT.t, transparent: true, roughness: 0.95, depthWrite: false});
      var rug1 = new THREE.Mesh(new THREE.PlaneGeometry(7.5, 7.5), rm); rug1.rotation.x = -PI/2; rug1.position.set(cx0, 0.012, cz0); g.add(rug1);
      var rug2 = new THREE.Mesh(new THREE.PlaneGeometry(6, 5), rm); rug2.rotation.x = -PI/2; rug2.position.set(8.5, 0.012, 6.6); g.add(rug2);
    }
    // the seating set in the waiting area
    var wa = new THREE.Group(); wa.position.set(8.5, 0, 6.5); g.add(wa);
    var se = L.seating, fab = mat({lounge: 0x2a5a64, chesterfield: 0x5a2f1e, modular: 0x8a8f96, beanbag: 0xd16b1f, benches: 0x8a5a35}[se], {roughness: se === "chesterfield" ? 0.55 : 0.95}),
        cush = mat({lounge: 0x33707c, chesterfield: 0x6a3a26, modular: 0x6fd38a, beanbag: 0x3d6fd1, benches: 0x6b4a32}[se], {roughness: 0.9});
    if(se === "lounge" || se === "chesterfield"){
      box(4.4, 0.45, 1.1, fab, 0, 0.32, -1.9, wa); box(4.4, 0.9, 0.3, fab, 0, 0.75, -2.4, wa);
      [-1.45, 0, 1.45].forEach(function(x){ box(1.4, 0.18, 0.95, cush, x, 0.64, -1.85, wa); box(1.3, 0.55, 0.2, cush, x, 1.0, -2.2, wa); });
      box(1.1, 0.45, 3.0, fab, -2.75, 0.32, 0.1, wa); box(0.3, 0.9, 3.0, fab, -3.25, 0.75, 0.1, wa);
      if(se === "chesterfield") [-2.2, 2.2].forEach(function(x){ cyl(0.22, 0.22, 1.1, fab, x, 0.62, -1.9, wa, 12).rotation.x = PI/2; });
    } else if(se === "modular"){ [[-1.5, -1.9], [0, -1.9], [1.5, -1.9], [-2.6, -0.4], [-2.6, 1.0]].forEach(function(p, i){ box(1.3, 0.5, 1.3, i % 2 ? cush : fab, p[0], 0.25, p[1], wa); }); }
    else if(se === "beanbag"){ [[-1.6, -1.6], [0, -2.0], [1.6, -1.6], [-2.4, 0.6]].forEach(function(p, i){ var b = sph(0.75, i % 2 ? cush : fab, p[0], 0.45, p[1], wa); b.scale.set(1, 0.65, 1); }); }
    else { [-1.9, 1.2].forEach(function(z){ box(4.4, 0.12, 0.6, fab, 0, 0.48, z, wa); [-1.9, 1.9].forEach(function(x){ box(0.12, 0.45, 0.5, mat(0x2a2a2a), x, 0.22, z, wa); }); }); }
    box(2.2, 0.06, 1.2, mat(0x8a5a35, {roughness: 0.5}), 0, 0.52, 0, wa); [-1, 1].forEach(function(x){ box(0.08, 0.5, 1.0, mat(0x2a2a2a), x, 0.25, 0, wa); });
    var lampG = c.glow(Mo.lamp, 2.2, 0.45); lampG.position.set(2.8, 2.1, -2.2); wa.add(lampG); dyn.chand.push(lampG);
    dyn.blockers.push(function(x, z){ return x > 4.6 && x < 12.6 && z > 3.6 && z < 9.6; });
    // art: on the gallery's back wall and the left wall above the ticker
    if(L.art !== "none"){
      var artAt = [[-9, 9.3, -R + 0.3, 0], [-3, 9.3, -R + 0.3, 0], [3, 9.3, -R + 0.3, 0], [9, 9.3, -R + 0.3, 0], [-R + 0.3, 9.3, -6, PI/2], [-R + 0.3, 9.3, 6, PI/2]];
      artAt.forEach(function(a, i){
        var T2 = c.canvasTex(256, 192, function(gg, W, H2){
          var R3 = c.rng(c.hashStr("art" + L.art + i));
          if(L.art === "abstract"){ gg.fillStyle = "#f2ece0"; gg.fillRect(0, 0, W, H2); for(var s = 0; s < 7; s++){ gg.fillStyle = ["#ff6b5b", "#ffb347", "#5fd3e6", "#2a3c50", "#6fd38a", "#9b8cf0"][Math.floor(R3()*6)]; if(R3() < 0.5) gg.fillRect(R3()*W, R3()*H2, 30 + R3()*90, 20 + R3()*70); else { gg.beginPath(); gg.arc(R3()*W, R3()*H2, 15 + R3()*45, 0, 7); gg.fill(); } } }
          else if(L.art === "posters"){ gg.fillStyle = ["#2a3c50", "#b5473a", "#3f8f5a", "#7a52c7"][i % 4]; gg.fillRect(0, 0, W, H2); gg.fillStyle = "#ffffff"; gg.font = "800 34px system-ui, sans-serif"; gg.textAlign = "center"; gg.fillText(["SHIP IT", "STAY CURIOUS", "TESTS GREEN", "ONE MORE PR", "FOCUS", "BUILD"][i % 6], W/2, H2/2 + 8); gg.fillStyle = "#ffb347"; gg.fillRect(30, H2 - 40, W - 60, 6); }
          else if(L.art === "portraits"){ gg.fillStyle = "#2b2018"; gg.fillRect(0, 0, W, H2); var sk = ["#e8c4a0", "#c48a5a", "#8a5a3a", "#f0d0b0"][i % 4]; gg.fillStyle = "#4a3a2a"; gg.fillRect(70, 110, 116, 82); gg.fillStyle = sk; gg.beginPath(); gg.ellipse(128, 80, 36, 46, 0, 0, 7); gg.fill(); gg.fillStyle = ["#2a1a10", "#6a4a2a", "#d8b34a", "#1a1a1a"][i % 4]; gg.beginPath(); gg.ellipse(128, 52, 40, 24, 0, PI, 0); gg.fill(); }
          else { gg.fillStyle = "#0a0a12"; gg.fillRect(0, 0, W, H2); gg.strokeStyle = ["#ff3d8b", "#39f3ff", "#ffcf7a"][i % 3]; gg.lineWidth = 8; gg.shadowColor = gg.strokeStyle; gg.shadowBlur = 16; gg.beginPath(); if(i % 2) gg.arc(W/2, H2/2, 50, 0, 7); else { gg.moveTo(50, 140); gg.lineTo(110, 50); gg.lineTo(150, 110); gg.lineTo(210, 40); } gg.stroke(); }
        });
        var pic = new THREE.Mesh(new THREE.PlaneGeometry(3.2, 2.4), new THREE.MeshBasicMaterial({map: T2.t, toneMapped: L.art !== "neon"})); pic.position.set(a[0], a[1], a[2]); pic.rotation.y = a[3]; g.add(pic);
        if(L.art !== "neon" && L.art !== "posters"){ var fr = c.add(new THREE.Mesh(new THREE.BoxGeometry(3.5, 2.7, 0.08), railM), a[0] - (a[3] ? 0.05 : 0), a[1], a[2] - (a[3] ? 0 : 0.05), g); fr.rotation.y = a[3]; }
      });
    }
    // plants along the walls, and the decor you placed (instanced), pet furniture among it
    var placed = st.int.items.filter(function(it){ return it.f === "lobby"; });
    var plants = [{k: "palm", x: -13, z: -12, r: 0}, {k: "plant", x: -4, z: -13, r: 0}, {k: "palm", x: 13, z: -11, r: 0}, {k: "plant", x: -13, z: 13, r: 0}, {k: "palm", x: 13, z: 13, r: 0}]
      .filter(function(p){ return !placed.some(function(it){ return it.x === p.x && it.z === p.z; }); });
    dyn.items = D.items(c, g, plants.concat(placed));
    dyn.blockers.push(function(x, z){ return dyn.items.blocked(x, z); });
    // the ambience (only while Ambient sounds is on: engine.ambientLoop checks it on every set)
    if(amb){ amb.stop(); amb = null; }
    var AMB = {fountain: [900, 0.6, 0.05], nature: [500, 0.4, 0.04], city: [220, 0.5, 0.05], jazz: [650, 3, 0.025], lofi: [2800, 2, 0.02]}[L.ambience];
    dyn.amb = AMB || null;
    // your pets come to their furniture (feat/pets: HQV.hqPets.lobby); spots in lobby metres
    petsHook(st);
  }
  /* [pets] hook: HQV.hqPets.lobby(world, spots) with spots = [{x, z, kind: "bed" | "perch" | "tree" | "pen" | "bowl" | "water"}] */
  function petsHook(st){
    if(!(HQV.hqPets && HQV.hqPets.lobby) || !ST) return;
    try { HQV.hqPets.lobby(w, ST.petSpots(st).map(function(s){ return {x: s.x, z: s.z, kind: s.kind}; })); } catch(e){ if(window.console) console.warn("hqPets.lobby:", e); }
  }

  // what you cannot walk through
  function blocked(x, z){
    if(x < -R + 0.8 || x > R - 0.8 || z < -R + 1.2 || z > R - 0.8) return true;
    if(Math.abs(x + 6.2) < 0.7 && Math.abs(z + 6.5) < 0.7) return true;            // columns
    if(Math.abs(x - 6.2) < 0.7 && Math.abs(z + 6.5) < 0.7) return true;
    if(Math.hypot(x + 7.0, z + 11.6) < 0.5) return true;                            // the Studio kiosk
    if(dyn) for(var i = 0; i < dyn.blockers.length; i++) if(dyn.blockers[i](x, z)) return true;
    return false;
  }

  var acc = 0, fm4 = new THREE.Matrix4(), fq = new THREE.Quaternion(), fe = new THREE.Euler(), fp = new THREE.Vector3(), fs = new THREE.Vector3(1, 1, 1);
  w.floor = floor; w.hits = hits; w.doors = doors; w.span = 11; w.zoom = 1.1; w.camY = 1.6; w.follow = 0.6;
  w.bounds = [-R, R, -R, R];
  w.spawn = {x: 0, z: 6, yaw: PI};
  w.spawnFrom = {base: {x: -R + 2.4, z: 0, yaw: PI/2}, mission: {x: 9.9, z: -R + 2.6, yaw: 0},
                 basement: {x: R - 2.6, z: -8, yaw: -PI/2},   // [basement 3.4] out of the B1 lift
                 roof: {x: 4.6, z: -R + 2.6, yaw: 0}};        // [hq revamp] down the roof lift (from the City's roof deck)
  w.blocked = blocked;
  var nightNow = true;
  w.setTime = function(night){
    nightNow = night; var Mo = dyn && dyn.mood || (D ? D.MOODS.warm : {bg: [0x7fb2d6, 0x0a1520]});
    S.background = new THREE.Color(night ? Mo.bg[1] : Mo.bg[0]);
    hemi.intensity = night ? 1.8 : 2.4; sun.intensity = night ? 0.6 : 1.6;
    timeLights.forEach(function(l){ l.intensity = l.userData.base*(night ? 1 : 0.6)*(l.userData.k || 1); });
    outside.material.map = c.sky(!night); outside.material.needsUpdate = true;
  };
  w.onData = function(list){
    counts = {working: 0, needs: 0, idle: 0};
    (list || []).forEach(function(s){ var st = c.crewState(s); if(counts[st] != null) counts[st]++; });
  };
  w.onLook = function(){ build(); drawSign(); if(w.setTime) w.setTime(nightNow); };
  w.onEnter = function(){ if(dyn && dyn.amb && c.E && c.E.ambientLoop && !amb){ try { amb = c.E.ambientLoop(dyn.amb[0], dyn.amb[1]); } catch(e){ amb = null; } } };
  w.onLeave = function(){ if(amb){ amb.stop(); amb = null; } };
  // HQ Studio's Layout tab: the grid on this floor and its cursor (null: hidden)
  w.studioGrid = function(o){ if(!gridO) return; gridO.show(!!o && o.f === "lobby"); if(o) gridO.set(o.x, o.z); };
  // the Studio kiosk is a "door" with no view: hq3d opens HQ Studio (ctx.api.studio)
  w.update = function(t, dt, k){
    acc += dt; if(acc > 0.08){ acc = 0; drawTicker(t);
      if(dyn && dyn.screen){ var sg = dyn.screen.g; sg.fillStyle = "#06111a"; sg.fillRect(0, 0, 1024, 512); sg.fillStyle = c.HEX.amber; sg.font = "800 92px system-ui, sans-serif"; sg.textAlign = "center"; sg.fillText(c.short(((c.look() || {}).sign || "CLAUDE HQ").toUpperCase(), 14), 512, 210);
        sg.fillStyle = c.HEX.cyan; sg.font = "600 44px ui-monospace, Menlo, monospace"; sg.fillText(counts.working + " working · " + counts.needs + " need you · level " + c.level(), 512, 320); sg.textAlign = "left"; dyn.screen.t.needsUpdate = true; } }
    if(amb && dyn && dyn.amb) amb.set(dyn.amb[2]*(k > 0 ? 1 : 0.6));
    var av = c.avatar();
    var near = av && Math.hypot(av.x, av.z + 10) < 6.5;
    botBody.position.y = Math.sin(t*1.6)*0.08*k; hover.material.opacity = 0.45 + Math.sin(t*3)*0.15;
    arm.rotation.z = near ? 2.4 + Math.sin(t*7)*0.4*k : 0.15;
    if(((t*10) | 0) % 2 === 0) drawFace(t, near);
    dotM.opacity = 0.35 + 0.25*Math.sin(t*3*k);
    if(dyn){
      dyn.water.forEach(function(j){ var u = (t*0.8*k + j.o) % 1, r = 0.4 + u*1.6; j.g.position.set(Math.cos(j.a)*r, 3.0 + Math.sin(u*PI)*1.0 - u*1.6, Math.sin(j.a)*r); j.g.material.opacity = 0.9*(1 - u*0.6); });
      if(dyn.fish){ for(var i = 0; i < 14; i++){ var a = t*0.4*k + i*0.9, rr = 0.6 + (i % 4)*0.3; fe.set(PI/2, -a - PI/2, 0); fq.setFromEuler(fe); fp.set(Math.cos(a)*rr, 1.2 + (i*0.41 % 5.4), Math.sin(a)*rr); fm4.compose(fp, fq, fs); dyn.fish.setMatrixAt(i, fm4); } dyn.fish.instanceMatrix.needsUpdate = true; }
      if(dyn.holo){ dyn.holo.rotation.y = t*0.5*k; }
      if(dyn.items) dyn.items.update(t, dt, k);
    }
    lifts.forEach(function(L){
      var want = av && Math.hypot(av.x - L.front.x, av.z - L.front.z) < 3.2 ? 1 : 0;
      L.open += (want - L.open)*Math.min(1, dt*4); L.dl.position.x = -0.6 - L.open*1.05; L.dr.position.x = 0.6 + L.open*1.05; L.light.intensity = L.open*30;
    });
    if(b1){ var wb = av && Math.hypot(av.x - (R - 1.8), av.z + 8) < 3.2 ? 1 : 0;   // [basement 3.4] the B1 lift's doors
      b1.open += (wb - b1.open)*Math.min(1, dt*4); b1.dl.position.x = -0.6 - b1.open*1.05; b1.dr.position.x = 0.6 + b1.open*1.05; b1.light.intensity = b1.open*30; }
    var dOpen = av && Math.abs(av.x + R) < 4 && Math.abs(av.z) < 3 ? 1 : 0;
    slideL.userData.o = (slideL.userData.o || 0) + (dOpen - (slideL.userData.o || 0))*Math.min(1, dt*4);
    slideL.position.z = -0.9 - slideL.userData.o*1.7; slideR.position.z = 0.9 + slideL.userData.o*1.7;
  };
  if(D && ST) build();
  drawTicker(0); drawFace(0, false);
  return w;
};
})();
