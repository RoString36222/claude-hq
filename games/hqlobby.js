/* Claude HQ 2.0: the Lobby, the ground floor between the front door and Mission Control.
 *
 * Reception (a floating greeter bot that waves when you come near), the building's
 * sign, a trophy case, the "Today at HQ" screen with live counts, a check-in kiosk,
 * security gates, a waiting area, and two lifts up to Mission Control. The glass
 * doors on the left lead back outside to the Base.
 *
 * A floor of the 3D HQ: registered as HQV.hqWorlds.lobby and built by games/hq3d.js
 * with its ctx helpers; returns the world (see mount() in hq3d.js for the shape).
 */
(function(){
"use strict";
var HQV = window.HQV = window.HQV || {};
HQV.hqWorlds = HQV.hqWorlds || {};

HQV.hqWorlds.lobby = function(c, w){
  var THREE = c.THREE, PI = c.PI, S = w.scene, R = 15;
  var mat = c.mat, emis = c.emis, box = c.box, cyl = c.cyl, sph = c.sph;
  var hits = [], doors = [], timeLights = [];

  // light
  var hemi = new THREE.HemisphereLight(0xbcd7ff, 0x1a2430, 2.2); S.add(hemi);
  var sun = new THREE.DirectionalLight(0xffffff, 1.4); sun.position.set(18, 30, 14); sun.castShadow = true;
  sun.shadow.mapSize.set(2048, 2048); var sc = sun.shadow.camera; sc.left = -20; sc.right = 20; sc.top = 20; sc.bottom = -20; sc.far = 90;
  S.add(sun); S.add(sun.target);
  [[-2, 6, 2, 140], [6, 6, 4, 110], [0, 6, -9, 90]].forEach(function(p){ var l = new THREE.PointLight(0xffd9a0, p[3], 0, 2); l.position.set(p[0], p[1], p[2]); l.userData.base = p[3]; S.add(l); timeLights.push(l); });

  // floor: big stone tiles with a little veining
  var fl = c.canvasTex(1024, 1024, function(g, W){
    var u = W/30, Rn = c.rng(31); g.fillStyle = "#3b4651"; g.fillRect(0, 0, W, W);
    for(var i = 0; i < 10; i++) for(var j = 0; j < 10; j++){
      var l = 26 + Rn()*5; g.fillStyle = "hsl(205,12%," + l + "%)"; g.fillRect(i*3*u + 2, j*3*u + 2, 3*u - 4, 3*u - 4);
      g.strokeStyle = "rgba(255,255,255,.05)"; g.lineWidth = 1;
      for(var v = 0; v < 3; v++){ g.beginPath(); g.moveTo(i*3*u + Rn()*3*u, j*3*u); g.bezierCurveTo(i*3*u + Rn()*3*u, j*3*u + u, i*3*u + Rn()*3*u, j*3*u + 2*u, i*3*u + Rn()*3*u, j*3*u + 3*u); g.stroke(); }
    }
  });
  var floor = new THREE.Mesh(new THREE.PlaneGeometry(2*R, 2*R), new THREE.MeshStandardMaterial({map: fl.t, roughness: 0.3, metalness: 0.25}));
  floor.rotation.x = -PI/2; floor.receiveShadow = true; S.add(floor);

  // walls (cut away on the camera's side), a wooden slat wall behind reception, and the sign
  var wallM = mat(0x2e3c49, {roughness: 0.85});
  box(2*R, 8, 0.5, wallM, 0, 4, -R - 0.25);
  box(0.5, 8, 11.5, wallM, -R - 0.25, 4, -9.25); box(0.5, 8, 9.5, wallM, -R - 0.25, 4, 10.25); box(0.5, 2, 12, wallM, -R - 0.25, 7, 0);
  box(2*R, 0.35, 0.8, mat(0x3a4a58), 0, 8.05, -R - 0.1); box(0.8, 0.35, 2*R, mat(0x3a4a58), -R - 0.1, 8.05, 0);
  var slat = mat(0x8a5a35, {roughness: 0.7});
  for(var x = -6.5; x <= 6.5; x += 0.32) box(0.18, 7.6, 0.14, slat, x, 3.8, -R + 0.08);
  var signTex = c.canvasTex(1024, 256), sign = c.screen(9, 2.25, signTex.t, true); sign.position.set(0, 5.1, -R + 0.25); S.add(sign);
  function drawSign(){
    var g = signTex.g, look = c.look(); g.clearRect(0, 0, 1024, 256); g.textAlign = "center";
    g.strokeStyle = c.HEX.amber; g.lineWidth = 8; g.lineCap = "round";
    for(var i = 0; i < 8; i++){ var a = i/8*PI*2; g.beginPath(); g.moveTo(140 + Math.cos(a)*18, 110 + Math.sin(a)*18); g.lineTo(140 + Math.cos(a)*62, 110 + Math.sin(a)*62); g.stroke(); }
    g.fillStyle = "#fff5e6"; g.font = "700 120px system-ui, sans-serif"; g.fillText(c.short((look.sign || "CLAUDE HQ").toUpperCase(), 14), 570, 150);
    g.fillStyle = c.HEX.amber; g.font = "600 34px ui-monospace, Menlo, monospace"; g.fillText("MISSION CONTROL · LAB · GYM · ARENA", 570, 214);
    signTex.t.needsUpdate = true;
  }
  drawSign();
  var sg = c.glow(c.COL.amber, 13, 0.25); sg.position.set(0, 5.1, -R + 0.5); S.add(sg);

  // reception: a curved counter from an extruded arc, and the greeter bot behind it
  var arc = new THREE.Shape(); arc.absarc(0, 0, 3.4, PI, PI*2, false); arc.absarc(0, 0, 2.7, PI*2, PI, true);
  var topGeo = new THREE.ExtrudeGeometry(arc, {depth: 0.1, bevelEnabled: false}); topGeo.rotateX(-PI/2);
  var rec = new THREE.Group(); rec.position.set(0, 0, -9); S.add(rec);
  c.add(new THREE.Mesh(topGeo, mat(0xe8dccb, {roughness: 0.35})), 0, 1.15, 0, rec);
  c.add(new THREE.Mesh(new THREE.CylinderGeometry(3.2, 3.2, 1.15, 48, 1, true, -PI/2, PI), mat(0xd6dde3, {roughness: 0.5, side: THREE.DoubleSide})), 0, 0.575, 0, rec);
  c.add(new THREE.Mesh(new THREE.CylinderGeometry(3.23, 3.23, 0.05, 48, 1, true, -PI/2, PI), new THREE.MeshBasicMaterial({color: c.COL.amber, side: THREE.DoubleSide, toneMapped: false})), 0, 0.1, 0, rec, true);
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

  // columns
  [-6.2, 6.2].forEach(function(x){ cyl(0.5, 0.5, 8, mat(0xdfe4e8, {roughness: 0.4}), x, 4, -6.5, null, 24); cyl(0.62, 0.62, 0.2, mat(0x8a5a35), x, 0.1, -6.5, null, 24); });

  // trophy case: what you have won (counts from the page)
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

  // "Today at HQ" on the left wall: live counts and a ticker
  var tick = c.canvasTex(1024, 400), tickS = c.screen(6.4, 2.5, tick.t); tickS.position.set(-R + 0.02, 4.6, -8.2); tickS.rotation.y = PI/2; S.add(tickS);
  box(0.2, 2.8, 6.8, mat(0x101a24, {metalness: 0.6}), -R - 0.02, 4.6, -8.2);
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
    var msg = "Take the lift to Mission Control  ·  Your crew is at their desks upstairs  ·  The Valley and the Arena are through the doors upstairs  ·  ";
    g.fillStyle = c.HEX.cyan; g.font = "600 28px ui-monospace, Menlo, monospace";
    var wd = g.measureText(msg).width, x0 = -((t*90) % wd); g.fillText(msg + msg + msg, x0, 380);
    tick.t.needsUpdate = true;
  }

  // lifts up to Mission Control
  var lifts = [];
  [8.2, 11.6].forEach(function(lx){
    var g = new THREE.Group(); g.position.set(lx, 0, -R + 0.05); S.add(g);
    box(2.9, 4.2, 0.25, mat(0x8d9aa6, {metalness: 0.85, roughness: 0.25}), 0, 2.1, 0, g);
    box(2.4, 3.5, 0.1, mat(0x0a1118), 0, 1.75, 0.1, g);
    var dm = mat(0xb9c3cc, {metalness: 0.9, roughness: 0.22});
    var dl = box(1.18, 3.45, 0.08, dm, -0.6, 1.75, 0.18, g), dr = box(1.18, 3.45, 0.08, dm, 0.6, 1.75, 0.18, g);
    var it = c.canvasTex(512, 96, function(gg){ gg.fillStyle = "#06100a"; gg.fillRect(0, 0, 512, 96); gg.fillStyle = c.HEX.amber; gg.font = "600 44px ui-monospace, Menlo, monospace"; gg.fillText("▲ 3  Mission Control", 18, 62); });
    var ind = c.screen(2.2, 0.42, it.t); ind.position.set(0, 3.85, 0.14); g.add(ind);
    var light = new THREE.PointLight(0xfff1d6, 0, 0, 2); light.position.set(0, 2.2, 0.6); g.add(light);
    var front = new THREE.Vector3(lx, 0, -R + 1.8);
    var d = {view: "@mission", label: "Lift", tip: "Lift: up to Mission Control", front: front};
    g.traverse(function(o){ if(o.isMesh){ o.userData.door = d; hits.push(o); } });
    doors.push(d); lifts.push({dl: dl, dr: dr, open: 0, light: light, x: lx});
  });
  var liftTag = c.label("Lifts · Mission Control", c.HEX.amber, 0.55); liftTag.position.set(9.9, 5.1, -R + 0.8); S.add(liftTag);

  // entrance: glass wall and sliding doors on the left wall, the street beyond
  var outside = c.screen(14, 7, c.sky(false)); outside.position.set(-17, 3.5, 0); outside.rotation.y = PI/2; S.add(outside);
  var glassM = mat(0xbfe3f5, {transparent: true, opacity: 0.16, roughness: 0.05, metalness: 0.1}), frameM = mat(0x3a4652, {metalness: 0.8, roughness: 0.3});
  [-6, -3.6, 3.6, 6].forEach(function(z){ box(0.14, 6, 0.14, frameM, -R - 0.1, 3, z); });
  box(0.14, 0.14, 12, frameM, -R - 0.1, 6, 0); box(0.14, 0.14, 12, frameM, -R - 0.1, 4.3, 0);
  [[-4.8, 2.4], [4.8, 2.4]].forEach(function(p){ box(0.04, 6, p[1], glassM, -R - 0.1, 3, p[0]); });
  var slideL = box(0.06, 4.2, 1.8, glassM, -R - 0.05, 2.1, -0.9), slideR = box(0.06, 4.2, 1.8, glassM, -R - 0.05, 2.1, 0.9);
  var exit = {view: "@base", label: "Front door", tip: "Front door: out to the Base", front: new THREE.Vector3(-R + 1.6, 0, 0)};
  [slideL, slideR].forEach(function(o){ o.userData.door = exit; hits.push(o); });
  doors.push(exit);
  var mt = c.canvasTex(256, 128, function(g){ g.fillStyle = "#2b2018"; g.fillRect(0, 0, 256, 128); g.strokeStyle = c.HEX.amber; g.lineWidth = 4; g.strokeRect(8, 8, 240, 112); g.fillStyle = c.HEX.amber; g.font = "700 40px system-ui, sans-serif"; g.textAlign = "center"; g.fillText("WELCOME", 128, 78); });
  var mat1 = c.screen(2.6, 1.3, mt.t); mat1.rotation.set(-PI/2, 0, PI/2); mat1.position.set(-R + 1.6, 0.012, 0); S.add(mat1);
  var outTag = c.label("Front door · the Base", c.HEX.green, 0.55); outTag.position.set(-R + 0.4, 7.0, 0); S.add(outTag);

  // security gates and a check-in kiosk
  for(var gt = 0; gt < 5; gt++){
    var gz = -2.6 + gt*1.3; box(0.3, 1.05, 0.9, mat(0xd6dde3, {metalness: 0.6, roughness: 0.3}), -9.5, 0.525, gz);
    box(0.32, 0.04, 0.7, emis(0x0d1a24, c.COL.green, 1.6), -9.5, 1.07, gz, null, true);
  }
  var kiosk = new THREE.Group(); kiosk.position.set(-11.4, 0, 5.6); kiosk.rotation.y = PI/2 + 0.3; S.add(kiosk);
  cyl(0.08, 0.14, 1.2, mat(0x3a4652, {metalness: 0.7}), 0, 0.6, 0, kiosk, 10);
  var kt = c.canvasTex(256, 192, function(g){ g.fillStyle = "#08131c"; g.fillRect(0, 0, 256, 192); g.fillStyle = c.HEX.amber; g.font = "700 26px system-ui, sans-serif"; g.textAlign = "center"; g.fillText("CHECK IN", 128, 46); g.fillStyle = c.HEX.ink; g.font = "500 18px system-ui, sans-serif"; g.fillText("Visitors tap their card", 128, 82); g.strokeStyle = c.HEX.cyan; g.lineWidth = 4; c.rr(g, 78, 104, 100, 64, 10); g.stroke(); });
  var kp = c.screen(0.68, 0.48, kt.t); kp.position.set(0, 1.42, 0.04); kp.rotation.x = -0.5; kiosk.add(kp);
  box(0.75, 0.55, 0.06, mat(0x1d2128), 0, 1.4, 0, kiosk).rotation.x = -0.5;

  // waiting area
  var wa = new THREE.Group(); wa.position.set(8.5, 0, 6.5); S.add(wa);
  var fabric = mat(0x2a5a64, {roughness: 0.95}), cush = mat(0x33707c, {roughness: 0.95});
  box(4.4, 0.45, 1.1, fabric, 0, 0.32, -1.9, wa); box(4.4, 0.9, 0.3, fabric, 0, 0.75, -2.4, wa);
  [-1.45, 0, 1.45].forEach(function(x){ box(1.4, 0.18, 0.95, cush, x, 0.64, -1.85, wa); box(1.3, 0.55, 0.2, cush, x, 1.0, -2.2, wa); });
  box(1.1, 0.45, 3.0, fabric, -2.75, 0.32, 0.1, wa); box(0.3, 0.9, 3.0, fabric, -3.25, 0.75, 0.1, wa);
  box(2.2, 0.06, 1.2, mat(0x8a5a35, {roughness: 0.5}), 0, 0.52, 0, wa);
  var lampG = c.glow(0xffd9a0, 2.2, 0.45); lampG.position.set(2.8, 2.1, -2.2); wa.add(lampG);

  // the logo in the floor, and a hologram of a creature over it
  var inlay = c.canvasTex(512, 512, function(g){
    g.strokeStyle = c.HEX.amber; g.lineWidth = 8; g.beginPath(); g.arc(256, 256, 240, 0, 7); g.stroke();
    for(var i = 0; i < 8; i++){ var a = i/8*PI*2; g.lineWidth = 14; g.lineCap = "round"; g.beginPath(); g.moveTo(256 + Math.cos(a)*40, 256 + Math.sin(a)*40); g.lineTo(256 + Math.cos(a)*140, 256 + Math.sin(a)*140); g.stroke(); }
  });
  var inl = new THREE.Mesh(new THREE.CircleGeometry(2.6, 64), new THREE.MeshBasicMaterial({map: inlay.t, transparent: true, opacity: 0.8, depthWrite: false, toneMapped: false}));
  inl.rotation.x = -PI/2; inl.position.set(-1.5, 0.013, 3.4); S.add(inl);
  var holo = new THREE.Group(); holo.position.set(-1.5, 1.9, 3.4); S.add(holo);
  var wire = new THREE.MeshBasicMaterial({color: c.COL.cyan, wireframe: true, transparent: true, opacity: 0.7, toneMapped: false});
  var hb = new THREE.Mesh(new THREE.SphereGeometry(0.7, 14, 10), wire); hb.scale.y = 0.9; holo.add(hb);
  [-0.35, 0.35].forEach(function(x){ var e = new THREE.Mesh(new THREE.ConeGeometry(0.2, 0.55, 6), wire); e.position.set(x, 0.78, 0); e.rotation.z = -x*0.8; holo.add(e); });

  c.plant(-13.6, -11.4, 1.3, 12); c.plant(-4.6, -13.6, 1.1, 13); c.plant(13.5, -10, 1.3, 14); c.plant(-13.4, 13.4, 1.2, 15); c.plant(13.2, 13.2, 1.1, 16);

  // what you cannot walk through
  function blocked(x, z){
    if(x < -R + 0.8 || x > R - 0.8 || z < -R + 1.2 || z > R - 0.8) return true;
    if(Math.hypot(x, z + 9) < 3.6 && z > -12.5) return true;                       // reception counter
    if(x > 4.6 && x < 12.6 && z > 3.6 && z < 9.6) return true;                      // waiting area
    if(Math.abs(x + 6.2) < 0.7 && Math.abs(z + 6.5) < 0.7) return true;            // columns
    if(Math.abs(x - 6.2) < 0.7 && Math.abs(z + 6.5) < 0.7) return true;
    return false;
  }

  var acc = 0;
  w.floor = floor; w.hits = hits; w.doors = doors; w.span = 11; w.zoom = 1.1; w.camY = 1.6; w.follow = 0.6;
  w.bounds = [-R, R, -R, R];
  w.spawn = {x: 0, z: 6, yaw: PI};
  w.spawnFrom = {base: {x: -R + 2.4, z: 0, yaw: PI/2}, mission: {x: 9.9, z: -R + 2.6, yaw: 0}};
  w.blocked = blocked;
  w.setTime = function(night){
    S.background = new THREE.Color(night ? 0x0a1520 : 0x7fb2d6);
    hemi.intensity = night ? 1.8 : 2.4; sun.intensity = night ? 0.6 : 1.6;
    timeLights.forEach(function(l){ l.intensity = l.userData.base*(night ? 1 : 0.6); });
    outside.material.map = c.sky(!night); outside.material.needsUpdate = true;
  };
  w.onData = function(list){
    counts = {working: 0, needs: 0, idle: 0};
    (list || []).forEach(function(s){ var st = c.crewState(s); if(counts[st] != null) counts[st]++; });
  };
  w.onLook = function(){ drawSign(); };
  w.update = function(t, dt, k){
    acc += dt; if(acc > 0.08){ acc = 0; drawTicker(t); }
    var av = c.avatar();
    var near = av && Math.hypot(av.x, av.z + 10) < 6.5;
    botBody.position.y = Math.sin(t*1.6)*0.08*k; hover.material.opacity = 0.45 + Math.sin(t*3)*0.15;
    arm.rotation.z = near ? 2.4 + Math.sin(t*7)*0.4*k : 0.15;
    if(((t*10) | 0) % 2 === 0) drawFace(t, near);
    holo.rotation.y = t*0.5*k; holo.position.y = 1.9 + Math.sin(t*1.4)*0.1*k;
    lifts.forEach(function(L){
      var want = av && Math.hypot(av.x - L.x, av.z + R - 1.8) < 3.2 ? 1 : 0;
      L.open += (want - L.open)*Math.min(1, dt*4); L.dl.position.x = -0.6 - L.open*1.05; L.dr.position.x = 0.6 + L.open*1.05; L.light.intensity = L.open*30;
    });
    var dOpen = av && Math.abs(av.x + R) < 4 && Math.abs(av.z) < 3 ? 1 : 0;
    slideL.userData.o = (slideL.userData.o || 0) + (dOpen - (slideL.userData.o || 0))*Math.min(1, dt*4);
    slideL.position.z = -0.9 - slideL.userData.o*1.7; slideR.position.z = 0.9 + slideL.userData.o*1.7;
  };
  drawTicker(0); drawFace(0, false);
  return w;
};
})();
