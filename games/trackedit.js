/* Valley: Track Editor (HQ 2.5 "Make + compete"). Paint a loop of road on a 16 x 16 grid
 * and it becomes a Kart Racing track: the editor walks the painted cells from the start
 * line and writes the F/S/L/R tile string the race engine (games/kart.js, the Arena's
 * kart.rs) already compiles. A live check says in plain words what is wrong until the
 * loop closes; then test-drive it solo, save it (up to 24 drafts in the Valley save,
 * workshop.kart), publish it to the Workshop when that is here, or race it in a room.
 *
 * What leaves the machine, and only when you race in a room or publish: the MapDoc
 * {kind:"kart", v:1, name, data:{tiles, scenery, theme:{sky, fog, ground}}}: the tiles,
 * the scenery, three colours and the name you typed. Nothing transcript-derived.
 */
(function(){
"use strict";
var HQV = window.HQV; if(!HQV || !HQV.api) return;
var api = HQV.api, E = HQV.engine || null;

var N = 16, MAX_DRAFTS = 24, DRAFT_MAX_BYTES = 8192;
var TILE_M = 15;     // metres per tile at the scale the Arena referees (kart.rs TILE)
var SCENERY = [["forest", "Forest"], ["tents", "Campsite"], ["empty", "Open fields"]];
// 8 swatches per colour, taken from the built-in tracks (plus a night) so any mix looks at home.
var SWATCH = {
  sky: ["#9fd3f0", "#f3c98b", "#b9c7e8", "#a4dcef", "#f0d59a", "#c9dcef", "#f4a98c", "#2b3a67"],
  fog: ["#cfe8f2", "#f6dcb4", "#dfe5f3", "#d7f0f6", "#f5e6c4", "#eef4fa", "#f8cfb9", "#4a5a85"],
  ground: ["#76b85a", "#d9a45f", "#8fae6a", "#5fa64e", "#69b98a", "#c9b25a", "#c98a45", "#e4eef4"]
};
var LOOKS = [["Meadow", 0, 0, 0], ["Canyon", 1, 1, 1], ["Peaks", 2, 2, 2], ["Lakeside", 3, 3, 4], ["Harvest", 4, 4, 5],
             ["Frost", 5, 5, 7], ["Sunset", 6, 6, 6], ["Night", 7, 7, 3]];
var FIELDS = [["sky", "Sky"], ["fog", "Haze"], ["ground", "Ground"]];

/* ---------- pure helpers (tests/test_trackedit.py runs these under node) ---------- */
/* TRACKEDIT-WALK BEGIN */
var TW = (function(){
  // kart.rs: CUSTOM_MIN_TILES / CUSTOM_MAX_TILES; headings as kart.rs DIRS (north = up the grid)
  var MIN_TILES = 8, MAX_TILES = 80;
  var DIRS = [[0, -1], [1, 0], [0, 1], [-1, 0]], DIR_NAMES = ["up", "right", "down", "left"];
  // cells: array of N*N 0/1; start: {c, r, d} or null. Returns {ok, tiles?, msg, bad:[idx], start}.
  function at(cells, n, c, r){ return c >= 0 && r >= 0 && c < n && r < n && cells[r*n + c] ? 1 : 0; }
  function count(cells){ var k = 0; for(var i = 0; i < cells.length; i++) if(cells[i]) k++; return k; }
  function where(n, i){ return "column "+(i % n + 1)+", row "+(Math.floor(i/n) + 1); }
  // a cell with road ahead and behind along d (d = 0..3)
  function straightAlong(cells, n, c, r, d){
    var a = DIRS[d], b = DIRS[(d + 2) % 4];
    return at(cells, n, c, r) && at(cells, n, c + a[0], r + a[1]) && at(cells, n, c + b[0], r + b[1]);
  }
  function autoStart(cells, n){
    for(var i = 0; i < n*n; i++){
      var c = i % n, r = Math.floor(i/n);
      if(straightAlong(cells, n, c, r, 0)) return {c: c, r: r, d: 0};
    }
    for(var j = 0; j < n*n; j++){
      var c2 = j % n, r2 = Math.floor(j/n);
      if(straightAlong(cells, n, c2, r2, 1)) return {c: c2, r: r2, d: 1};
    }
    return null;
  }
  function startsOf(cells, n){
    var out = [];
    [0, 1, 2, 3].forEach(function(d){
      for(var i = 0; i < n*n; i++){ var c = i % n, r = Math.floor(i/n); if(straightAlong(cells, n, c, r, d)) out.push({c: c, r: r, d: d}); }
    });
    return out;
  }
  // Greedy: straight on whenever the road goes straight on, else the only way left.
  function greedy(cells, n, st, total){
    var s0 = st.r*n + st.c, seen = {}, tiles = "F", h = st.d, cur, steps = 0, c = st.c + DIRS[h][0], r = st.r + DIRS[h][1], bad = [], i;
    seen[s0] = 1;
    while(steps++ < 400){
      cur = r*n + c;
      if(cur === s0) break;
      seen[cur] = 1;
      var opts = [];
      [h, (h + 1) % 4, (h + 3) % 4].forEach(function(dd){
        var nc = c + DIRS[dd][0], nr = r + DIRS[dd][1], ni = nr*n + nc;
        if(!at(cells, n, nc, nr)) return;
        if(ni === s0){ if(dd === st.d) opts.push(dd); return; }   // back over the line, the right way only
        if(!seen[ni]) opts.push(dd);
      });
      var go = opts.length && opts[0] === h ? h : opts.length === 1 ? opts[0] : -1;
      if(go < 0){
        bad.push(cur);
        return {ok: false, bad: bad, start: st, msg: opts.length
          ? "Fork at "+where(n, cur)+": the road can only go one way there."
          : "The loop doesn't close at "+where(n, cur)+": it has to come back over the start line, heading "+DIR_NAMES[st.d]+"."};
      }
      tiles += go === h ? "S" : go === (h + 1) % 4 ? "R" : "L";
      h = go; c += DIRS[h][0]; r += DIRS[h][1];
    }
    if(tiles.length !== total){
      for(i = 0; i < n*n; i++) if(cells[i] && !seen[i]) bad.push(i);
      return {ok: false, bad: bad, start: st, msg: (total - tiles.length)+" painted cell"+(total - tiles.length === 1 ? " isn't" : "s aren't")+" on the loop (from "+where(n, bad[0])+"): join them in or erase them."};
    }
    return {ok: true, tiles: tiles, bad: [], start: st, msg: ""};
  }
  // Roads painted side by side touch, so straight-on isn't always right: search for the
  // one loop through every painted cell (straight first, then right, then left), bounded.
  function search(cells, n, st, total){
    var s0 = st.r*n + st.c, seen = [], out = ["F"], budget = 40000;
    for(var i = 0; i < n*n; i++) seen.push(0);
    seen[s0] = 1;
    function rec(c, r, h, len){
      if(--budget < 0) return false;
      var cur = r*n + c;
      if(cur === s0) return h === st.d && len === total;
      if(!at(cells, n, c, r) || seen[cur] || len >= total) return false;
      seen[cur] = 1;
      for(var k = 0; k < 3; k++){
        var dd = k === 0 ? h : k === 1 ? (h + 1) % 4 : (h + 3) % 4;
        out.push(k === 0 ? "S" : k === 1 ? "R" : "L");
        if(rec(c + DIRS[dd][0], r + DIRS[dd][1], dd, len + 1)) return true;
        out.pop();
      }
      seen[cur] = 0;
      return false;
    }
    return rec(st.c + DIRS[st.d][0], st.r + DIRS[st.d][1], st.d, 1) ? out.join("") : null;
  }
  // fits(tiles): optional extra check (the starting grid); an automatic start prefers one that passes.
  function walk(cells, n, start, fits){
    var total = count(cells), bad = [], i, c, r;
    if(!total) return {ok: false, msg: "Paint a loop of road: click or drag over the grid, or move with the arrow keys and press Space.", bad: bad};
    for(i = 0; i < n*n; i++){
      if(!cells[i]) continue;
      c = i % n; r = Math.floor(i/n);
      var nb = at(cells, n, c, r - 1) + at(cells, n, c + 1, r) + at(cells, n, c, r + 1) + at(cells, n, c - 1, r);
      if(nb < 2) bad.push(i);
    }
    if(bad.length) return {ok: false, bad: bad, msg: "Dead end at "+where(n, bad[0])+": every road cell needs road on two sides."+(bad.length > 1 ? " ("+bad.length+" dead ends.)" : "")};
    if(total < MIN_TILES) return {ok: false, bad: bad, msg: "Too short: a track needs at least "+MIN_TILES+" cells (this one has "+total+")."};
    if(total > MAX_TILES) return {ok: false, bad: bad, msg: "Too long: at most "+MAX_TILES+" cells (this one has "+total+"). Erase some."};
    var mine = start && straightAlong(cells, n, start.c, start.r, start.d);
    var cands = mine ? [start] : startsOf(cells, n).slice(0, 24);
    if(!cands.length) return {ok: false, bad: bad, msg: "The start line needs a straight: paint a cell with road in front of it and behind it."};
    var first = null, firstErr = null;
    for(var k = 0; k < cands.length; k++){
      var st = cands[k], g = greedy(cells, n, st, total), tiles = g.ok ? g.tiles : search(cells, n, st, total);
      if(!tiles){ if(!firstErr) firstErr = g; continue; }
      var res = {ok: true, tiles: tiles, bad: [], start: st, msg: ""};
      if(!fits || fits(tiles)) return res;
      if(!first) first = res;
    }
    return first || firstErr;
  }

  // A tiles string back onto the grid: {cells, start} centred, or null if it can't fit.
  function place(tiles, n){
    if(typeof tiles !== "string" || !/^F[FSLR]*$/.test(tiles)) return null;
    var col = 0, row = 0, d = 0, pts = [], seen = {};
    for(var i = 0; i < tiles.length; i++){
      var ch = tiles.charAt(i), key = col+","+row;
      if(seen[key]) return null;
      seen[key] = 1; pts.push([col, row]);
      d = ch === "R" ? (d + 1) % 4 : ch === "L" ? (d + 3) % 4 : d;
      col += DIRS[d][0]; row += DIRS[d][1];
    }
    if(col !== 0 || row !== 0 || d !== 0) return null;
    var mnc = 1e9, mxc = -1e9, mnr = 1e9, mxr = -1e9;
    pts.forEach(function(p){ mnc = Math.min(mnc, p[0]); mxc = Math.max(mxc, p[0]); mnr = Math.min(mnr, p[1]); mxr = Math.max(mxr, p[1]); });
    if(mxc - mnc >= n || mxr - mnr >= n) return null;
    var oc = Math.floor((n - (mxc - mnc + 1))/2) - mnc, orr = Math.floor((n - (mxr - mnr + 1))/2) - mnr, cells = [];
    for(var k = 0; k < n*n; k++) cells.push(0);
    pts.forEach(function(p){ cells[(p[1] + orr)*n + p[0] + oc] = 1; });
    return {cells: cells, start: {c: oc, r: orr, d: 0}};
  }
  // name: 1-32 printable characters once trimmed, no < >, no links (kart.rs doc_name)
  function nameError(s){
    s = String(s == null ? "" : s).trim();
    if(!s.length || s.length > 32) return "Name it: 1 to 32 characters.";
    if(/[<>\u0000-\u001f\u007f-\u009f]/.test(s)) return "The name can't have < > or control characters.";
    if(/http/i.test(s)) return "No links in the name.";
    return "";
  }
  return {walk: walk, place: place, nameError: nameError, autoStart: autoStart, count: count, DIRS: DIRS, DIR_NAMES: DIR_NAMES,
          MIN_TILES: MIN_TILES, MAX_TILES: MAX_TILES};
})();
/* TRACKEDIT-WALK END */
var DIRS = TW.DIRS, DIR_NAMES = TW.DIR_NAMES;

/* ---------- the editor's state lives across mounts, so leaving to race keeps your work ---------- */
function blankCells(){ var a = []; for(var i = 0; i < N*N; i++) a.push(0); return a; }
var ED = {cells: blankCells(), start: null, name: "", scenery: "forest", theme: {sky: SWATCH.sky[0], fog: SWATCH.fog[0], ground: SWATCH.ground[0]},
          idx: -1, fixed: null, cur: {c: 7, r: 7}, tool: "paint", undo: [], dirty: false};
var PENDING_EDIT = null, CUR = null;

function wdrafts(){
  var s = api.save; if(!s) return [];
  if(!s.workshop || typeof s.workshop !== "object" || Array.isArray(s.workshop)) s.workshop = {};
  if(!Array.isArray(s.workshop.kart)) s.workshop.kart = [];
  return s.workshop.kart;
}
function validDoc(d){ return !!(d && typeof d === "object" && d.kind === "kart" && d.data && typeof d.data.tiles === "string"); }
function sig(){ return ED.cells.join("")+"|"+(ED.start ? ED.start.c+","+ED.start.r+","+ED.start.d : ""); }
// Does the 8-car starting grid sit on the road (kart.rs grid_fits)? A left turn into the line doesn't.
function gridFits(tiles){
  var KT = HQV.kartTrack; if(!KT || !KT.compileTrack) return true;
  try {
    var tr = KT.compileTrack(tiles);
    for(var k = 0; k < 8; k++){
      var g = KT.gridSlot(k), loc = KT.locate(tr, g[0], g[1]);
      if(!loc || Math.abs(loc[2]) > KT.ROAD_HALF) return false;
    }
    return true;
  } catch(e){ return false; }
}
function check(){
  if(ED.fixed && ED.fixed.sig === sig()) return {ok: true, tiles: ED.fixed.tiles, bad: [], start: ED.start, msg: ""};
  var res = TW.walk(ED.cells, N, ED.start, gridFits);
  if(res.ok && !gridFits(res.tiles))
    res = {ok: false, bad: [], start: res.start, msg: "The starting grid doesn't fit: make the cell behind the start line a straight (or move the start line)."};
  return res;
}
function docOf(res){
  return {kind: "kart", v: 1, name: String(ED.name).trim(),
          data: {tiles: res.tiles, scenery: ED.scenery, theme: {sky: ED.theme.sky.toLowerCase(), fog: ED.theme.fog.toLowerCase(), ground: ED.theme.ground.toLowerCase()}}};
}
function loadDoc(doc, idx){
  if(!validDoc(doc)) return false;
  var p = TW.place(doc.data.tiles, N); if(!p) return false;
  var th = doc.data.theme || {};
  ED.cells = p.cells; ED.start = p.start; ED.name = String(doc.name || "").slice(0, 32);
  ED.scenery = SCENERY.some(function(s){ return s[0] === doc.data.scenery; }) ? doc.data.scenery : "forest";
  FIELDS.forEach(function(f){ var v = th[f[0]]; ED.theme[f[0]] = typeof v === "string" && /^#[0-9a-fA-F]{6}$/.test(v) ? v.toLowerCase() : SWATCH[f[0]][0]; });
  ED.idx = idx == null ? -1 : idx; ED.undo = []; ED.dirty = false;
  ED.fixed = {tiles: doc.data.tiles, sig: sig()};
  return true;
}
function mapsOk(){ var A = window.ARENA; return !!(A && A.arena && A.arena.maps); }
function note(ev){ if(HQV.story && typeof HQV.story.note === "function"){ try { HQV.story.note(ev); } catch(e){} } }

/* =============================== the editor view =============================== */
function makeEditor(host){
  var V = {alive: true, drive: null, cell: 26, drag: null};
  var root = api.mk("div", "vg-te"), edit = api.mk("div", "vg-te-edit"), driveBox = api.mk("div", "vg-te-drive hidden");
  root.appendChild(edit); root.appendChild(driveBox); host.appendChild(root);
  edit.appendChild(api.mk("p", "vg-muted", "Paint a closed loop of road. The flag marks the start line; the race heads the way its arrow points. Then test-drive it, save it, and race it with friends."));

  // left: the grid
  var cols = api.mk("div", "vg-te-cols"), left = api.mk("div", "vg-te-left"), right = api.mk("div", "vg-te-right");
  cols.appendChild(left); cols.appendChild(right); edit.appendChild(cols);
  var toolRow = api.mk("div", "vg-row vg-te-tools"); toolRow.setAttribute("role", "group"); toolRow.setAttribute("aria-label", "Tool");
  var TOOLS = [["paint", "Paint road"], ["erase", "Erase"], ["start", "Start line"]], toolBtns = {};
  TOOLS.forEach(function(t){
    var b = api.btn(t[1], "vg-te-tool", function(){ ED.tool = t[0]; renderTools(); canvas.focus(); });
    toolBtns[t[0]] = b; toolRow.appendChild(b);
  });
  toolRow.appendChild(api.btn("Undo", "", function(){ undo(); canvas.focus(); }));
  toolRow.appendChild(api.btn("Clear", "", function(){
    if(api.save && ED.cells.some(function(x){ return x; }) && !window.confirm("Clear the grid?")) return;
    pushUndo(); ED.cells = blankCells(); ED.start = null; ED.fixed = null; ED.dirty = true; update();
  }));
  left.appendChild(toolRow);
  var canvas = api.mk("canvas", "vg-te-grid"); canvas.tabIndex = 0;
  canvas.setAttribute("role", "application");
  canvas.setAttribute("aria-roledescription", "track grid");
  canvas.setAttribute("aria-label", "Track grid, 16 by 16. Arrow keys move, Space paints, Delete erases, Enter puts the start line here (again to turn it), Control+Z undoes.");
  left.appendChild(canvas);
  var cursorSay = api.mk("p", "vg-te-cursor vg-muted"); cursorSay.setAttribute("aria-live", "polite");
  left.appendChild(cursorSay);
  left.appendChild(api.mk("p", "vg-muted vg-te-keys", "Keys: arrows move · Space paints · Delete erases · Enter: start line here (again to turn it) · Ctrl+Z undo"));

  // right: the check, the look, the actions, the drafts
  var status = api.mk("p", "vg-te-status"); status.setAttribute("role", "status"); status.setAttribute("aria-live", "polite");
  right.appendChild(status);
  var nameRow = api.mk("label", "vg-te-field"), nameIn = api.mk("input", "vg-te-input");
  nameRow.appendChild(api.mk("span", null, "Name")); nameIn.type = "text"; nameIn.maxLength = 32; nameIn.placeholder = "My track"; nameIn.autocomplete = "off";
  nameIn.addEventListener("input", function(){ ED.name = nameIn.value; ED.dirty = true; renderStatus(); });
  nameRow.appendChild(nameIn); right.appendChild(nameRow);
  var scRow = api.mk("label", "vg-te-field"), scSel = api.mk("select", "vg-select");
  scRow.appendChild(api.mk("span", null, "Scenery"));
  SCENERY.forEach(function(s){ var o = api.mk("option", null, s[1]); o.value = s[0]; scSel.appendChild(o); });
  scSel.addEventListener("change", function(){ ED.scenery = scSel.value; ED.dirty = true; drawPreview(); });
  scRow.appendChild(scSel); right.appendChild(scRow);
  var lookRow = api.mk("label", "vg-te-field"), lookSel = api.mk("select", "vg-select");
  lookRow.appendChild(api.mk("span", null, "Look like"));
  var o0 = api.mk("option", null, "Pick a look…"); o0.value = ""; lookSel.appendChild(o0);
  LOOKS.forEach(function(l, i){ var o = api.mk("option", null, l[0]); o.value = String(i); lookSel.appendChild(o); });
  lookSel.addEventListener("change", function(){
    var l = LOOKS[+lookSel.value]; lookSel.value = ""; if(!l) return;
    ED.theme = {sky: SWATCH.sky[l[1]], fog: SWATCH.fog[l[2]], ground: SWATCH.ground[l[3]]}; ED.dirty = true; renderSwatches(); drawPreview();
    say("Look: "+l[0]);
  });
  lookRow.appendChild(lookSel); right.appendChild(lookRow);
  var swBox = api.mk("div", "vg-te-swatches"); right.appendChild(swBox);
  var preview = api.mk("canvas", "vg-te-preview"); preview.setAttribute("aria-hidden", "true"); right.appendChild(preview);
  var actions = api.mk("div", "vg-row vg-te-actions"); right.appendChild(actions);
  var pubRow = api.mk("div", "vg-row vg-te-actions"); right.appendChild(pubRow);
  right.appendChild(api.mk("h4", "vg-golf-h", "Your tracks"));
  var draftBox = api.mk("ol", "vg-te-drafts"); right.appendChild(draftBox);

  function say(t){ if(E && E.say) E.say(t); }
  function where(c, r){ return "column "+(c + 1)+", row "+(r + 1); }

  /* ---------- edits ---------- */
  function pushUndo(){ ED.undo.push({cells: ED.cells.slice(), start: ED.start ? {c: ED.start.c, r: ED.start.r, d: ED.start.d} : null}); if(ED.undo.length > 60) ED.undo.shift(); }
  function undo(){
    var u = ED.undo.pop(); if(!u){ say("Nothing to undo"); return; }
    ED.cells = u.cells; ED.start = u.start; ED.dirty = true; update(); say("Undone");
  }
  function setCell(c, r, v){
    if(c < 0 || r < 0 || c >= N || r >= N) return false;
    var i = r*N + c; if(ED.cells[i] === v) return false;
    ED.cells[i] = v; ED.dirty = true;
    if(!v && ED.start && ED.start.c === c && ED.start.r === r) ED.start = null;
    return true;
  }
  function setStart(c, r){
    var cells = ED.cells, ok = function(d){
      var a = DIRS[d], b = DIRS[(d + 2) % 4];
      var at = function(x, y){ return x >= 0 && y >= 0 && x < N && y < N && cells[y*N + x]; };
      return at(c, r) && at(c + a[0], r + a[1]) && at(c + b[0], r + b[1]);
    };
    var cand = [0, 1, 2, 3].filter(ok);
    if(!cand.length){ say("The start line needs a straight: road in front and behind."); api.toast("The start line goes on a straight cell"); return; }
    pushUndo();
    var same = ED.start && ED.start.c === c && ED.start.r === r, d = cand[0];
    if(same){ var k = cand.indexOf(ED.start.d); d = cand[(k + 1) % cand.length]; }   // again: turn it round
    ED.start = {c: c, r: r, d: d}; ED.dirty = true; update();
    say("Start line at "+where(c, r)+", racing "+DIR_NAMES[d]);
  }

  /* ---------- pointer: click or drag to paint, touch too ---------- */
  function cellAt(ev){
    var b = canvas.getBoundingClientRect(), s = b.width/N;
    return {c: Math.floor((ev.clientX - b.left)/s), r: Math.floor((ev.clientY - b.top)/s)};
  }
  canvas.addEventListener("pointerdown", function(ev){
    var p = cellAt(ev); if(p.c < 0 || p.r < 0 || p.c >= N || p.r >= N) return;
    ev.preventDefault(); canvas.focus();
    ED.cur = {c: p.c, r: p.r};
    if(ED.tool === "start"){ setStart(p.c, p.r); return; }
    var v = ED.tool === "erase" ? 0 : ED.cells[p.r*N + p.c] ? 0 : 1;   // painting over road erases it
    pushUndo(); V.drag = {v: v, id: ev.pointerId};
    try { canvas.setPointerCapture(ev.pointerId); } catch(e){}
    if(setCell(p.c, p.r, v)) update(); else draw();
  });
  canvas.addEventListener("pointermove", function(ev){
    if(!V.drag || V.drag.id !== ev.pointerId) return;
    var p = cellAt(ev);
    if(setCell(p.c, p.r, V.drag.v)){ ED.cur = {c: p.c, r: p.r}; update(); }
  });
  function endDrag(){ if(V.drag){ V.drag = null; renderStatus(); } }
  canvas.addEventListener("pointerup", endDrag); canvas.addEventListener("pointercancel", endDrag);

  /* ---------- keyboard ---------- */
  canvas.addEventListener("keydown", function(ev){
    var k = ev.key, c = ED.cur.c, r = ED.cur.r, moved = false;
    if(k === "ArrowUp"){ r = Math.max(0, r - 1); moved = true; }
    else if(k === "ArrowDown"){ r = Math.min(N - 1, r + 1); moved = true; }
    else if(k === "ArrowLeft"){ c = Math.max(0, c - 1); moved = true; }
    else if(k === "ArrowRight"){ c = Math.min(N - 1, c + 1); moved = true; }
    else if(k === " " || k === "Spacebar"){
      ev.preventDefault(); pushUndo();
      if(setCell(c, r, 1)){ update(); say("Road at "+where(c, r)); } else { ED.undo.pop(); say("Already road"); }
      return;
    }
    else if(k === "Delete" || k === "Backspace"){
      ev.preventDefault(); pushUndo();
      if(setCell(c, r, 0)){ update(); say("Erased "+where(c, r)); } else { ED.undo.pop(); say("Nothing to erase"); }
      return;
    }
    else if(k === "Enter"){ ev.preventDefault(); setStart(c, r); return; }
    else if((k === "z" || k === "Z") && (ev.ctrlKey || ev.metaKey)){ ev.preventDefault(); undo(); return; }
    else return;
    ev.preventDefault();
    if(moved){
      ED.cur = {c: c, r: r};
      if(ev.shiftKey){ pushUndo(); if(setCell(c, r, ED.tool === "erase" ? 0 : 1)) update(); }   // Shift+arrows paints a line
      draw();
      var i = r*N + c, isStart = ED.start && ED.start.c === c && ED.start.r === r;
      cursorSay.textContent = where(c, r)+": "+(isStart ? "start line" : ED.cells[i] ? "road" : "empty");
    }
  });
  canvas.addEventListener("focus", draw); canvas.addEventListener("blur", draw);

  /* ---------- drawing ---------- */
  var TOK = E && E.tokens ? E.tokens() : {ink: "currentColor", muted: "gray", line: "gray", panel: "canvas", panel2: "canvas", brand: "royalblue", need: "crimson", good: "seagreen", gold: "goldenrod", bg2: "canvas"};
  var last = null;
  function size(){
    var w = Math.max(240, Math.min(480, (left.clientWidth || 448)));
    V.cell = Math.floor(w/N);
    var dpr = Math.min(window.devicePixelRatio || 1, 2), px = V.cell*N;
    if(canvas.width !== Math.round(px*dpr)){ canvas.width = Math.round(px*dpr); canvas.height = Math.round(px*dpr); }
    canvas.style.width = px+"px"; canvas.style.height = px+"px";
    return dpr;
  }
  function draw(){
    if(!V.alive) return;
    var dpr = size(), g = canvas.getContext("2d"), S = V.cell, T = TOK, res = last || check();
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.fillStyle = T.panel2; g.fillRect(0, 0, S*N, S*N);
    g.strokeStyle = T.line; g.lineWidth = 1; g.globalAlpha = 0.6;
    for(var i = 0; i <= N; i++){ g.beginPath(); g.moveTo(i*S + 0.5, 0); g.lineTo(i*S + 0.5, S*N); g.stroke(); g.beginPath(); g.moveTo(0, i*S + 0.5); g.lineTo(S*N, i*S + 0.5); g.stroke(); }
    g.globalAlpha = 1;
    var bad = {}; (res.bad || []).forEach(function(b){ bad[b] = 1; });
    if(res.ok) drawRoad(g, S, res);
    else {
      for(var j = 0; j < N*N; j++){
        if(!ED.cells[j]) continue;
        var x = (j % N)*S, y = Math.floor(j/N)*S;
        g.fillStyle = T.muted; g.globalAlpha = 0.75; g.fillRect(x + 2, y + 2, S - 4, S - 4); g.globalAlpha = 1;
      }
    }
    Object.keys(bad).forEach(function(b){
      var x = (b % N)*S, y = Math.floor(b/N)*S;
      g.strokeStyle = T.need; g.lineWidth = 3; g.strokeRect(x + 2.5, y + 2.5, S - 5, S - 5);
    });
    var st = res.start || ED.start;
    if(st && ED.cells[st.r*N + st.c]) drawStart(g, S, st);
    if(document.activeElement === canvas){
      g.strokeStyle = T.brand; g.lineWidth = 2; g.setLineDash([4, 3]);
      g.strokeRect(ED.cur.c*S + 1.5, ED.cur.r*S + 1.5, S - 3, S - 3); g.setLineDash([]);
    }
  }
  // the derived loop, drawn as road: straights as bands, corners as quarter rings
  function drawRoad(g, S, res){
    var T = TOK, st = res.start, h = st.d, c = st.c, r = st.r, w = S*0.9, tiles = res.tiles;
    g.lineCap = "butt";
    for(var i = 0; i < tiles.length; i++){
      var ch = tiles.charAt(i), o = ch === "R" ? (h + 1) % 4 : ch === "L" ? (h + 3) % 4 : h;
      var cx = c*S + S/2, cy = r*S + S/2;
      g.strokeStyle = T.ink; g.globalAlpha = 0.82; g.lineWidth = w;
      g.beginPath();
      if(o === h){
        g.moveTo(cx - DIRS[h][0]*S/2, cy - DIRS[h][1]*S/2); g.lineTo(cx + DIRS[h][0]*S/2, cy + DIRS[h][1]*S/2);
      } else {
        var e = DIRS[(h + 2) % 4], x = DIRS[o], px = cx + (e[0] + x[0])*S/2, py = cy + (e[1] + x[1])*S/2;
        var a0 = Math.atan2(cy + e[1]*S/2 - py, cx + e[0]*S/2 - px), a1 = Math.atan2(cy + x[1]*S/2 - py, cx + x[0]*S/2 - px);
        var dA = ((a1 - a0 + Math.PI*3) % (Math.PI*2)) - Math.PI;
        g.lineWidth = w*0.95; g.arc(px, py, S/2, a0, a0 + dA, dA < 0);
      }
      g.stroke(); g.globalAlpha = 1;
      // centre dashes
      g.strokeStyle = T.panel; g.lineWidth = 1.5; g.setLineDash([3, 4]); g.beginPath();
      if(o === h){ g.moveTo(cx - DIRS[h][0]*S/2, cy - DIRS[h][1]*S/2); g.lineTo(cx + DIRS[h][0]*S/2, cy + DIRS[h][1]*S/2); }
      else { g.arc(px, py, S/2, a0, a0 + dA, dA < 0); }
      g.stroke(); g.setLineDash([]);
      h = o; c += DIRS[h][0]; r += DIRS[h][1];
    }
  }
  function drawStart(g, S, st){
    var T = TOK, cx = st.c*S + S/2, cy = st.r*S + S/2, d = DIRS[st.d], px = -d[1], py = d[0];
    // the line across the road, chequered
    var q = S*0.2;
    for(var k = 0; k < 4; k++){
      g.fillStyle = k % 2 ? T.ink : T.panel;
      if(px) g.fillRect(cx + (k - 2)*q, cy - 2, q, 4); else g.fillRect(cx - 2, cy + (k - 2)*q, 4, q);
    }
    // the arrow: which way the race goes
    g.fillStyle = T.gold; g.strokeStyle = T.ink; g.lineWidth = 1;
    g.beginPath();
    g.moveTo(cx + d[0]*S*0.42, cy + d[1]*S*0.42);
    g.lineTo(cx + d[0]*S*0.12 + px*S*0.2, cy + d[1]*S*0.12 + py*S*0.2);
    g.lineTo(cx + d[0]*S*0.12 - px*S*0.2, cy + d[1]*S*0.12 - py*S*0.2);
    g.closePath(); g.fill(); g.stroke();
  }
  function drawPreview(){
    var dpr = Math.min(window.devicePixelRatio || 1, 2), W = 220, H = 64;
    if(preview.width !== Math.round(W*dpr)){ preview.width = Math.round(W*dpr); preview.height = Math.round(H*dpr); }
    var g = preview.getContext("2d"); g.setTransform(dpr, 0, 0, dpr, 0, 0);
    var sky = g.createLinearGradient(0, 0, 0, H*0.6); sky.addColorStop(0, ED.theme.sky); sky.addColorStop(1, ED.theme.fog);
    g.fillStyle = sky; g.fillRect(0, 0, W, H*0.6);
    g.fillStyle = ED.theme.ground; g.fillRect(0, H*0.6, W, H*0.4);
    g.fillStyle = TOK.ink; g.globalAlpha = 0.8;
    g.beginPath(); g.moveTo(W*0.44, H*0.6); g.lineTo(W*0.56, H*0.6); g.lineTo(W*0.75, H); g.lineTo(W*0.25, H); g.closePath(); g.fill(); g.globalAlpha = 1;
    // scenery hint: tree or tent marks on the ground (seeded, the same every time)
    var rnd = api.rng("trackedit:"+ED.scenery);
    for(var i = 0; i < (ED.scenery === "empty" ? 0 : 7); i++){
      var x = rnd() < 0.5 ? rnd()*W*0.3 : W*0.7 + rnd()*W*0.3, y = H*0.62 + rnd()*H*0.3;
      g.fillStyle = TOK.ink; g.globalAlpha = 0.5; g.beginPath();
      if(ED.scenery === "tents"){ g.moveTo(x, y - 7); g.lineTo(x + 6, y + 3); g.lineTo(x - 6, y + 3); }
      else { g.arc(x, y - 3, 4, 0, Math.PI*2); }
      g.fill(); g.globalAlpha = 1;
    }
  }

  /* ---------- panel ---------- */
  function renderTools(){
    TOOLS.forEach(function(t){ var b = toolBtns[t[0]], on = ED.tool === t[0]; b.classList.toggle("primary", on); b.setAttribute("aria-pressed", on ? "true" : "false"); });
  }
  function renderSwatches(){
    swBox.textContent = "";
    FIELDS.forEach(function(f){
      var row = api.mk("div", "vg-te-swrow"); row.setAttribute("role", "radiogroup"); row.setAttribute("aria-label", f[1]+" colour");
      row.appendChild(api.mk("span", "vg-te-swlabel", f[1]));
      SWATCH[f[0]].forEach(function(hex, i){
        var on = ED.theme[f[0]] === hex, b = api.mk("button", "vg-te-sw"+(on ? " on" : ""));
        b.type = "button"; b.style.background = hex;
        b.setAttribute("role", "radio"); b.setAttribute("aria-checked", on ? "true" : "false");
        b.setAttribute("aria-label", f[1]+" colour "+(i + 1)+" of 8"); b.tabIndex = on ? 0 : -1;
        b.addEventListener("click", function(){ ED.theme[f[0]] = hex; ED.dirty = true; renderSwatches(); drawPreview(); var n = swBox.querySelector('[data-f="'+f[0]+'"] .on'); if(n) n.focus(); });
        b.addEventListener("keydown", function(ev){
          var k = ev.key, j = k === "ArrowRight" || k === "ArrowDown" ? (i + 1) % 8 : k === "ArrowLeft" || k === "ArrowUp" ? (i + 7) % 8 : -1;
          if(j < 0) return;
          ev.preventDefault(); ED.theme[f[0]] = SWATCH[f[0]][j]; ED.dirty = true; renderSwatches(); drawPreview();
          var n = swBox.querySelector('[data-f="'+f[0]+'"] .on'); if(n) n.focus();
        });
        row.appendChild(b);
      });
      if(SWATCH[f[0]].indexOf(ED.theme[f[0]]) < 0){   // a loaded colour that isn't a swatch stays as it is
        var cur = api.mk("span", "vg-te-sw on"); cur.style.background = ED.theme[f[0]]; cur.setAttribute("aria-label", f[1]+": the track's own colour"); row.appendChild(cur);
      }
      row.setAttribute("data-f", f[0]);
      swBox.appendChild(row);
    });
  }
  function renderStatus(){
    var res = last || check(), nm = TW.nameError(ED.name);
    status.className = "vg-te-status "+(res.ok ? "ok" : "bad");
    var txt;
    if(res.ok){
      var corners = (res.tiles.match(/[LR]/g) || []).length;
      txt = "✓ Valid loop: "+res.tiles.length+" tiles, "+corners+" corner"+(corners === 1 ? "" : "s")+", "+(res.tiles.length*TILE_M)+" m a lap.";
      if(nm) txt += " "+nm;
    } else txt = res.msg;
    // the status is a live region: while a drag paints it waits for the pointer to lift
    if(!V.drag && status.textContent !== txt) status.textContent = txt;
    renderActions(res, nm);
  }
  function renderActions(res, nm){
    actions.textContent = ""; pubRow.textContent = "";
    var K = HQV.kartCustom, ready = res.ok && !nm;
    var td = api.btn("Test drive", "primary", function(){ testDrive(); });
    td.disabled = !res.ok || !K; actions.appendChild(td);
    var sv = api.btn(ED.idx >= 0 ? "Save changes" : "Save", "", function(){ save(); });
    sv.disabled = !ready; actions.appendChild(sv);
    if(ED.idx >= 0) actions.appendChild(api.btn("Save as new", "", function(){ ED.idx = -1; save(); }));
    if(K && HQV.mp && mapsOk()){
      var rr = api.btn("Race in room", "", function(){ raceInRoom(); });
      rr.disabled = !ready; pubRow.appendChild(rr);
    }
    if(typeof window.workshopPublish === "function"){
      var scope = api.mk("select", "vg-select"); scope.setAttribute("aria-label", "Publish to");
      [["public", "Everyone"], ["private", "Only me"]].forEach(function(s){ var o = api.mk("option", null, s[1]); o.value = s[0]; scope.appendChild(o); });
      var pb = api.btn("Publish", "", function(){ publish(scope.value); });
      pb.disabled = !ready; pubRow.appendChild(pb); pubRow.appendChild(scope);
    }
    if(!K) actions.appendChild(api.mk("span", "vg-muted", "Test drive needs Kart Racing (3D) on this page."));
    if(res.ok && nm) actions.appendChild(api.mk("span", "vg-muted", nm));
  }
  function renderDrafts(){
    draftBox.textContent = "";
    var list = wdrafts();
    if(!list.length){ draftBox.appendChild(api.mk("li", "vg-muted", "Nothing saved yet ("+MAX_DRAFTS+" at most).")); return; }
    list.forEach(function(d, i){
      if(!validDoc(d)) return;
      var li = api.mk("li", i === ED.idx ? "on" : null);
      li.appendChild(api.mk("b", null, String(d.name || "Untitled").slice(0, 32)));
      li.appendChild(api.mk("span", "vg-muted", " · "+d.data.tiles.length+" tiles "));
      li.appendChild(api.btn("Edit", "", function(){
        if(ED.dirty && !window.confirm("Drop the changes you haven't saved?")) return;
        if(loadDoc(d, i)){ syncInputs(); update(); say("Editing "+String(d.name || "")); } else api.toast("That track doesn't fit the grid");
      }));
      li.appendChild(api.btn("Delete", "", function(){
        if(!window.confirm("Delete "+String(d.name || "this track")+"?")) return;
        list.splice(i, 1);
        if(ED.idx === i) ED.idx = -1; else if(ED.idx > i) ED.idx--;
        api.persist(); renderDrafts(); renderStatus(); say("Deleted");
      }));
      draftBox.appendChild(li);
    });
    if(list.length >= MAX_DRAFTS) draftBox.appendChild(api.mk("li", "vg-muted", "That's "+MAX_DRAFTS+": delete one to save another."));
  }
  function syncInputs(){ nameIn.value = ED.name; scSel.value = ED.scenery; renderSwatches(); drawPreview(); renderTools(); renderDrafts(); }

  /* ---------- actions ---------- */
  function currentDoc(){
    var res = check(); if(!res.ok){ api.toast(res.msg); return null; }
    var nm = TW.nameError(ED.name); if(nm){ api.toast(nm); nameIn.focus(); return null; }
    return docOf(res);
  }
  function save(){
    var doc = currentDoc(); if(!doc) return;
    if(!api.save){ api.toast("The Valley save isn't loaded yet"); return; }
    if(JSON.stringify(doc).length >= DRAFT_MAX_BYTES){ api.toast("That track is too big to save (8 KB at most)"); return; }
    var list = wdrafts();
    if(ED.idx >= 0 && ED.idx < list.length) list[ED.idx] = doc;
    else {
      if(list.length >= MAX_DRAFTS){ api.toast("You have "+MAX_DRAFTS+" tracks: delete one first"); return; }
      list.push(doc); ED.idx = list.length - 1;
    }
    ED.dirty = false; ED.fixed = {tiles: doc.data.tiles, sig: sig()};
    api.persist(); renderDrafts(); renderStatus();
    api.toast("🛣️ Saved "+doc.name); say("Saved "+doc.name);
    note("make-save");
  }
  function publish(scope){
    var doc = currentDoc(); if(!doc || typeof window.workshopPublish !== "function") return;
    var p; try { p = window.workshopPublish(doc, scope); } catch(e){ p = null; }
    if(!p || typeof p.then !== "function"){ api.toast("Couldn't publish right now"); return; }
    p.then(function(r){
      if(r && r.map){ api.toast("📣 Published "+doc.name); say("Published "+doc.name); }
      else api.toast("Couldn't publish: "+String((r && r.error) || "try again").slice(0, 100));
    }, function(){ api.toast("Couldn't publish right now"); });
  }
  function raceInRoom(){
    var doc = currentDoc(); if(!doc || !HQV.kartCustom) return;
    if(!HQV.kartCustom.room(doc)) api.toast("Kart Racing isn't ready on this page");
  }
  function testDrive(){
    var res = check(); if(!res.ok || !HQV.kartCustom){ api.toast(res.msg || "Kart Racing isn't ready on this page"); return; }
    var doc = docOf(res); if(!doc.name) doc.name = "Test drive";
    edit.classList.add("hidden"); driveBox.classList.remove("hidden"); driveBox.textContent = "";
    V.drive = HQV.kartCustom.practice(driveBox, doc, {laps: 1, onExit: back});
    say("Test drive: "+res.tiles.length+" tiles. W to go.");
  }
  function back(){
    if(V.drive){ V.drive.destroy(); V.drive = null; }
    driveBox.textContent = ""; driveBox.classList.add("hidden"); edit.classList.remove("hidden");
    update(); canvas.focus();
  }

  function update(){
    if(!V.alive) return;
    if(ED.fixed && ED.fixed.sig !== sig()) ED.fixed = null;
    if(E && E.tokens) TOK = E.tokens();
    last = null; last = check();
    draw(); renderStatus();
  }
  function onResize(){ if(V.alive && !V.drive) draw(); }
  window.addEventListener("resize", onResize);

  if(PENDING_EDIT){
    var pe = PENDING_EDIT; PENDING_EDIT = null;
    if(!loadDoc(pe.doc, pe.idx)) api.toast("That track doesn't fit the 16 x 16 grid");
  }
  syncInputs(); update();
  V.destroy = function(){
    V.alive = false;
    if(V.drive){ V.drive.destroy(); V.drive = null; }
    window.removeEventListener("resize", onResize);
    root.remove();
  };
  V.pause = function(){ if(V.drive) V.drive.paused = true; };
  V.resume = function(){ if(V.drive) V.drive.paused = false; };
  V.check = check; V.ed = ED;   // smoke tests
  return V;
}

HQV.register({id: "make-kart", name: "Track Editor", icon: "🛣️", workshop: true,
  desc: "Paint a kart track, test-drive it, race it with friends",
  badge: function(){ var n = (api.save && api.save.workshop && Array.isArray(api.save.workshop.kart)) ? api.save.workshop.kart.length : 0; return n ? n+" saved" : ""; },
  mount: function(el){ if(CUR) CUR.destroy(); CUR = makeEditor(el); },
  unmount: function(){ if(CUR){ CUR.destroy(); CUR = null; } },
  pause: function(){ if(CUR) CUR.pause(); },
  resume: function(){ if(CUR) CUR.resume(); }});

// The Workshop's maker registry (31-workshop.js lists these under Make).
HQV.makers = HQV.makers || {};
HQV.makers.kart = {
  game: "make-kart", name: "Track Editor", icon: "🛣️",
  edit: function(doc){
    var list = wdrafts(), idx = -1, js = JSON.stringify(doc);
    list.forEach(function(d, i){ if(idx < 0 && JSON.stringify(d) === js) idx = i; });
    PENDING_EDIT = validDoc(doc) ? {doc: doc, idx: idx} : null;
    api.open("make-kart");
  },
  play: function(doc, opts){
    var K = HQV.kartCustom; if(!K) return false;
    return opts && opts.room ? K.room(doc) : K.solo(doc);
  },
  drafts: function(){ return wdrafts().filter(validDoc).map(function(d){ return JSON.parse(JSON.stringify(d)); }); }
};
HQV.trackEdit = {walk: TW.walk, place: TW.place, nameError: TW.nameError, debug: function(){ return CUR; }};
})();
