/* Claude HQ: the phone's Camera and Gallery (HQ 3.15 transport revamp, plan 3.12 apps 10-11, part `phone`).
 *
 * Camera   a viewfinder in the phone frame (host.viewfinder(canvas) when the integrator blits the 3D frame into it,
 *          else a host.photo() preview every second), shutter on the round button or Space / Enter on the
 *          viewfinder, front / back (host.selfie(on): the camrig selfie mode), a 3 s timer with a spoken countdown,
 *          grid lines, the shutter sound (host.sfx("shutter")) and a white flash (none under Calm or reduced motion).
 * Gallery  every photo in a grid, a viewer with previous / next, delete (asks first), save to disk through an
 *          <a download> object URL (revoked after). Photos are kept ONLY in this browser's IndexedDB ("hq-gallery",
 *          store "photos", records {id, at, world, blob}); never uploaded anywhere. Without IndexedDB (a private
 *          window, blocked storage) they are kept in memory until the page closes, and the Gallery says so.
 * Pure (node-tested, tests/test_hqgallery.py): HQV.hqGallery = {createStore(idbFactory, opts) -> store, sortRecs(recs),
 *   fileName(at), coverRect(sw, sh, dw, dh), step(i, dir, n), MAX, DB, STORE}
 *   store.add(blob, {at, world}) -> Promise<{id, at, world}>   store.list() -> Promise<[rec]> newest first
 *   store.get(id) -> Promise<rec | null>   store.remove(id) -> Promise<bool>   store.persistent() -> Promise<bool>
 * DOM: createElement / textContent only. Two apps pushed onto HQV.hqPhoneQueue: "camera" and "gallery".
 */
(function(){
"use strict";
var W = typeof window !== "undefined" ? window : globalThis;
var HQV = W.HQV = W.HQV || {};

var DB = "hq-gallery", STORE = "photos", VERSION = 1, MAX = 200;
var PREVIEW_MS = 1000, TIMER_S = 3;

/* ---------------------------------------------------------------- pure ---- */
function num(v, d){ v = +v; return isFinite(v) ? v : d; }
function pad2(n){ n = n | 0; return (n < 10 ? "0" : "") + n; }
function sortRecs(recs){
  return (recs || []).filter(function(r){ return r && typeof r.id === "string"; }).slice().sort(function(a, b){
    return num(b.at, 0) - num(a.at, 0) || (a.id < b.id ? 1 : a.id > b.id ? -1 : 0);
  });
}
function fileName(at){
  var d = new Date(num(at, 0));
  return "hq-photo-" + d.getFullYear() + pad2(d.getMonth() + 1) + pad2(d.getDate()) + "-" + pad2(d.getHours()) + pad2(d.getMinutes()) + pad2(d.getSeconds()) + ".png";
}
// the source rectangle that fills a dw x dh frame from a sw x sh image (centre crop)
function coverRect(sw, sh, dw, dh){
  sw = Math.max(1, num(sw, 1)); sh = Math.max(1, num(sh, 1)); dw = Math.max(1, num(dw, 1)); dh = Math.max(1, num(dh, 1));
  var s = Math.max(dw/sw, dh/sh), w = dw/s, h = dh/s;
  return {sx: (sw - w)/2, sy: (sh - h)/2, sw: w, sh: h};
}
function step(i, dir, n){ n = n | 0; if(n <= 0) return -1; return ((i | 0) + (dir < 0 ? -1 : 1) + n) % n; }

// The photo store: IndexedDB when it opens, else memory (persistent() says which).
function createStore(idb, opts){
  opts = opts || {};
  var max = Math.max(1, (opts.max | 0) || MAX), seq = 0, mem = [], dbP = null, useMem = !idb;
  function newId(at){ seq++; return "p" + Math.floor(at).toString(36) + "-" + seq.toString(36); }
  function open(){
    if(useMem) return Promise.resolve(null);
    if(dbP) return dbP;
    dbP = new Promise(function(res){
      var req;
      try { req = idb.open(DB, VERSION); } catch(e){ useMem = true; res(null); return; }
      if(!req){ useMem = true; res(null); return; }
      req.onupgradeneeded = function(){ try { var db = req.result; if(!db.objectStoreNames || !db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE, {keyPath: "id"}); } catch(e){} };
      req.onsuccess = function(){ res(req.result); };
      req.onerror = function(){ useMem = true; res(null); };
      req.onblocked = function(){ useMem = true; res(null); };
    });
    return dbP;
  }
  // one request in its own transaction -> Promise(result); any failure switches to memory and rejects
  function run(mode, fn){
    return open().then(function(db){
      if(!db) throw new Error("memory");
      return new Promise(function(res, rej){
        var tx, req;
        try { tx = db.transaction(STORE, mode); req = fn(tx.objectStore(STORE)); }
        catch(e){ rej(e); return; }
        var out;
        req.onsuccess = function(){ out = req.result; };
        req.onerror = function(){ rej(req.error || new Error("idb")); };
        tx.oncomplete = function(){ res(out); };
        tx.onerror = function(){ rej(tx.error || new Error("idb")); };
        tx.onabort = function(){ rej(tx.error || new Error("idb")); };
      });
    });
  }
  function fallback(e){ if(e && e.message !== "memory") useMem = true; }
  var S = {
    add: function(blob, meta){
      meta = meta || {};
      var at = num(meta.at, Date.now()), rec = {id: newId(at), at: at, world: typeof meta.world === "string" ? meta.world.slice(0, 80) : "", blob: blob};
      function toMem(){ mem.unshift(rec); mem = sortRecs(mem).slice(0, max); return {id: rec.id, at: rec.at, world: rec.world}; }
      if(useMem) return Promise.resolve(toMem());
      return run("readwrite", function(os){ return os.put(rec); }).then(function(){
        return S.list().then(function(all){
          var extra = all.slice(max);
          return Promise.all(extra.map(function(r){ return S.remove(r.id); }));
        }).then(function(){ return {id: rec.id, at: rec.at, world: rec.world}; });
      }, function(e){ fallback(e); return toMem(); });
    },
    list: function(){
      if(useMem) return Promise.resolve(sortRecs(mem));
      return run("readonly", function(os){ return os.getAll(); }).then(function(a){ return sortRecs((a || []).concat(mem)); },
        function(e){ fallback(e); return sortRecs(mem); });
    },
    get: function(id){
      var m = mem.filter(function(r){ return r.id === id; })[0] || null;
      if(useMem || m) return Promise.resolve(m);
      return run("readonly", function(os){ return os.get(String(id)); }).then(function(r){ return r || null; }, function(e){ fallback(e); return null; });
    },
    remove: function(id){
      var n = mem.length;
      mem = mem.filter(function(r){ return r.id !== id; });
      if(mem.length !== n) return Promise.resolve(true);
      if(useMem) return Promise.resolve(false);
      return run("readwrite", function(os){ return os.delete(String(id)); }).then(function(){ return true; }, function(e){ fallback(e); return false; });
    },
    persistent: function(){ return open().then(function(db){ return !!db && !useMem; }); }
  };
  return S;
}

var API = HQV.hqGallery = {createStore: createStore, sortRecs: sortRecs, fileName: fileName, coverRect: coverRect, step: step,
                           MAX: MAX, DB: DB, STORE: STORE, store: null};
function sharedStore(){
  if(API.store) return API.store;
  var idb = null;
  try { idb = W.indexedDB || null; } catch(e){ idb = null; }
  API.store = createStore(idb);
  return API.store;
}
API.sharedStore = sharedStore;

/* ----------------------------------------------------------------- DOM ---- */
var doc = W.document;
var Q = HQV.hqPhoneQueue = HQV.hqPhoneQueue || [];
var uidN = 0;
function uid(p){ uidN++; return "hg-" + p + "-" + uidN; }
function mk(tag, cls, parent, text){
  var n = doc.createElement(tag);
  if(cls) n.className = cls;
  if(text != null) n.textContent = text;
  if(parent) parent.appendChild(n);
  return n;
}
function btn(parent, text, cls, onClick, label){
  var b = mk("button", "hp-btn" + (cls ? " " + cls : ""), parent, text);
  b.type = "button";
  if(label) b.setAttribute("aria-label", label);
  if(onClick) b.addEventListener("click", onClick);
  return b;
}
function clear(n){ while(n && n.firstChild) n.removeChild(n.firstChild); }
function say(host, msg){ try { if(host && host.announce) host.announce(msg); else if(typeof W.announce === "function") W.announce(msg); } catch(e){} }
function hcall(host, name, args, def){
  try { if(host && typeof host[name] === "function"){ var v = host[name].apply(host, args || []); return v === undefined ? def : v; } } catch(e){}
  return def;
}
function calmNow(host){
  if(hcall(host, "calm", [], false) || hcall(host, "reducedMotion", [], false)) return true;
  var de = doc && doc.documentElement;
  if(de && de.classList && de.classList.contains("hq-calm")) return true;
  try { return !!(W.matchMedia && W.matchMedia("(prefers-reduced-motion: reduce)").matches); } catch(e){ return false; }
}
function objUrl(blob){ try { return W.URL && W.URL.createObjectURL && blob ? W.URL.createObjectURL(blob) : null; } catch(e){ return null; } }
function revoke(u){ try { if(u && W.URL && W.URL.revokeObjectURL) W.URL.revokeObjectURL(u); } catch(e){} }
function when(at){
  var d = new Date(num(at, 0));
  return d.getDate() + " " + ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"][d.getMonth()] + " " + pad2(d.getHours()) + ":" + pad2(d.getMinutes());
}
function photoOf(host){
  try { var p = host && typeof host.photo === "function" ? host.photo() : null; return p && typeof p.then === "function" ? p : Promise.resolve(p || null); }
  catch(e){ return Promise.resolve(null); }
}
function typingOrButton(t){ var tg = t && t.tagName ? String(t.tagName).toUpperCase() : ""; return tg === "BUTTON" || tg === "INPUT" || tg === "SELECT" || tg === "TEXTAREA" || tg === "A" || tg === "SUMMARY"; }

/* ----------------------------------------------------------------- Camera ---- */
function renderCamera(el, host, nav){
  var st = {grid: false, timer: false, selfie: false, busy: false, prevBusy: false, last: 0, count: null, timers: [], alive: true, thumbUrl: null};
  var store = sharedStore();
  var root = mk("div", "hp-app hg-cam", el);
  var vf = mk("div", "hg-vf", root);
  vf.tabIndex = 0;
  vf.setAttribute("role", "img");
  vf.setAttribute("aria-label", "Viewfinder. Space or Enter takes a photo.");
  var cv = mk("canvas", "hg-canvas", vf);
  cv.width = 324; cv.height = 432;
  cv.setAttribute("aria-hidden", "true");
  var gridEl = mk("div", "hg-grid", vf); gridEl.hidden = true; gridEl.setAttribute("aria-hidden", "true");
  for(var i = 0; i < 4; i++) mk("span", "hg-gl hg-gl" + i, gridEl);
  var countEl = mk("div", "hg-count", vf, ""); countEl.hidden = true; countEl.setAttribute("aria-hidden", "true");
  var flash = mk("div", "hg-flash", vf); flash.setAttribute("aria-hidden", "true");
  var bar = mk("div", "hg-controls", root);
  var thumb = btn(bar, "", "hg-thumb", function(){ if(nav && nav.open) nav.open("gallery"); }, "Open Gallery");
  var shutter = btn(bar, "", "hg-shutter", function(){ shoot(); }, "Take photo");
  var flip = btn(bar, "Selfie", "hg-flip", function(){
    st.selfie = !st.selfie;
    hcall(host, "selfie", [st.selfie], null);
    flip.setAttribute("aria-pressed", st.selfie ? "true" : "false");
    say(host, st.selfie ? "Front camera" : "Back camera");
  }, "Front camera");
  flip.setAttribute("aria-pressed", "false");
  var opts = mk("div", "hp-bar hg-opts", root);
  var gBtn = btn(opts, "Grid", "hp-ghost", function(){
    st.grid = !st.grid; gridEl.hidden = !st.grid; gBtn.setAttribute("aria-pressed", st.grid ? "true" : "false");
  }, "Grid lines");
  gBtn.setAttribute("aria-pressed", "false");
  var tBtn = btn(opts, "Timer 3 s", "hp-ghost", function(){
    st.timer = !st.timer; tBtn.setAttribute("aria-pressed", st.timer ? "true" : "false");
  }, "3 second timer");
  tBtn.setAttribute("aria-pressed", "false");
  var note = mk("p", "hp-hint", root, "Photos stay on this computer.");
  note.id = uid("note");
  var live = mk("p", "hp-sr", root, ""); live.setAttribute("role", "status");

  function later(fn, ms){ var t = setTimeout(function(){ st.timers = st.timers.filter(function(x){ return x !== t; }); if(st.alive) fn(); }, ms); st.timers.push(t); }
  function draw(src, w, h){
    var g = cv.getContext && cv.getContext("2d"); if(!g) return;
    var r = coverRect(w, h, cv.width, cv.height);
    try { g.drawImage(src, r.sx, r.sy, r.sw, r.sh, 0, 0, cv.width, cv.height); } catch(e){}
  }
  function drawBlob(blob){
    if(!blob) return Promise.resolve();
    if(typeof W.createImageBitmap === "function"){
      return W.createImageBitmap(blob).then(function(bm){ if(st.alive) draw(bm, bm.width, bm.height); if(bm.close) bm.close(); }, function(){});
    }
    return new Promise(function(res){
      var u = objUrl(blob); if(!u || typeof W.Image !== "function"){ res(); return; }
      var im = new W.Image();
      im.onload = function(){ if(st.alive) draw(im, im.naturalWidth, im.naturalHeight); revoke(u); res(); };
      im.onerror = function(){ revoke(u); res(); };
      im.src = u;
    });
  }
  function preview(){
    if(st.prevBusy || st.busy) return;
    if(hcall(host, "viewfinder", [cv], false) === true) return;     // the integrator blits the frame itself
    st.prevBusy = true;
    photoOf(host).then(function(b){ return drawBlob(b); }).then(function(){ st.prevBusy = false; }, function(){ st.prevBusy = false; });
  }
  function setThumb(){
    store.list().then(function(a){
      if(!st.alive) return;
      revoke(st.thumbUrl); st.thumbUrl = null; clear(thumb);
      if(a[0] && a[0].blob){ st.thumbUrl = objUrl(a[0].blob); if(st.thumbUrl){ var im = mk("img", "", thumb); im.alt = ""; im.src = st.thumbUrl; } }
      thumb.setAttribute("aria-label", "Open Gallery, " + a.length + (a.length === 1 ? " photo" : " photos"));
    });
  }
  function capture(){
    st.busy = true;
    hcall(host, "sfx", ["shutter"], null);
    if(!calmNow(host)){
      flash.className = "hg-flash";
      later(function(){ flash.className = "hg-flash hg-flash-on"; }, 0);
      later(function(){ flash.className = "hg-flash"; }, 260);
    }
    var me = hcall(host, "me", [], {}) || {};
    photoOf(host).then(function(blob){
      if(!blob){ st.busy = false; say(host, "The camera could not take a photo"); return; }
      drawBlob(blob);
      return store.add(blob, {at: Date.now(), world: typeof me.world === "string" ? me.world : ""}).then(function(){
        st.busy = false;
        live.textContent = "Photo saved to Gallery";
        say(host, "Photo saved to Gallery");
        setThumb();
      });
    }).then(null, function(){ st.busy = false; say(host, "The photo could not be saved"); });
  }
  function shoot(){
    if(st.busy || st.count != null) return;
    if(!st.timer){ capture(); return; }
    st.count = TIMER_S;
    countEl.hidden = false;
    (function tickDown(){
      if(st.count <= 0){ st.count = null; countEl.hidden = true; capture(); return; }
      countEl.textContent = String(st.count);
      say(host, String(st.count));
      st.count--;
      later(tickDown, 1000);
    })();
  }
  setThumb();
  preview();
  return {
    onKey: function(e){
      if((e.key === " " || e.key === "Spacebar" || e.key === "Enter") && !typingOrButton(e.target)){ shoot(); return true; }
      return false;
    },
    tick: function(ms){ if(ms - st.last >= PREVIEW_MS - 50){ st.last = ms; preview(); } },
    dispose: function(){
      st.alive = false;
      st.timers.forEach(function(t){ clearTimeout(t); }); st.timers = [];
      if(st.selfie) hcall(host, "selfie", [false], null);
      revoke(st.thumbUrl);
    },
    _shoot: shoot, _state: st
  };
}

/* ---------------------------------------------------------------- Gallery ---- */
var COLS = 3;
function renderGallery(el, host, nav){
  var st = {recs: [], urls: [], view: "grid", i: 0, confirm: false, alive: true, persistent: true};
  var store = sharedStore();
  var root = mk("div", "hp-app hg-gal", el);
  var info = mk("p", "hp-muted", root, "Loading…");
  info.setAttribute("role", "status");
  var body = mk("div", "", root);
  function freeUrls(){ st.urls.forEach(revoke); st.urls = []; }
  function load(then){
    Promise.all([store.list(), store.persistent()]).then(function(r){
      if(!st.alive) return;
      st.recs = r[0]; st.persistent = r[1];
      if(then) then(); else draw();
    });
  }
  function infoText(){
    var n = st.recs.length;
    return (n ? n + (n === 1 ? " photo" : " photos") : "No photos yet. Take one with the Camera.") +
           (st.persistent ? " Kept only on this computer, never uploaded." : " This browser can't store photos: they are kept until the page closes.");
  }
  function draw(){
    clear(body); freeUrls();
    info.textContent = infoText();
    if(st.view === "view" && st.recs.length) drawViewer(); else { st.view = "grid"; drawGrid(); }
  }
  function drawGrid(){
    if(nav && nav.title) nav.title("Gallery");
    if(!st.recs.length){ btn(body, "Open the Camera", "hp-primary", function(){ if(nav && nav.open) nav.open("camera"); }); return; }
    var ul = mk("ul", "hg-gridlist", body);
    ul.setAttribute("aria-label", "Photos");
    var items = [];
    st.recs.forEach(function(r, i){
      var li = mk("li", "", ul), b = mk("button", "hg-cell", li);
      b.type = "button";
      b.setAttribute("aria-label", "Photo " + (i + 1) + " of " + st.recs.length + ", " + when(r.at));
      b.tabIndex = i === st.i ? 0 : -1;
      var u = objUrl(r.blob); if(u){ st.urls.push(u); var im = mk("img", "", b); im.alt = ""; im.src = u; }
      else mk("span", "hg-noimg", b, when(r.at));
      b.addEventListener("click", function(){ st.i = i; st.view = "view"; draw(); });
      items.push(b);
    });
    if(st.i >= items.length) st.i = 0;
    items.forEach(function(b, k){ b.tabIndex = k === st.i ? 0 : -1; });
    ul.addEventListener("keydown", function(e){
      var i = items.indexOf(doc.activeElement); if(i < 0) return;
      var n = items.length, j = e.key === "ArrowRight" ? Math.min(n - 1, i + 1) : e.key === "ArrowLeft" ? Math.max(0, i - 1)
            : e.key === "ArrowDown" ? (i + COLS < n ? i + COLS : i) : e.key === "ArrowUp" ? (i - COLS >= 0 ? i - COLS : i)
            : e.key === "Home" ? 0 : e.key === "End" ? n - 1 : -1;
      if(j < 0) return;
      if(e.preventDefault) e.preventDefault();
      items.forEach(function(b, k){ b.tabIndex = k === j ? 0 : -1; });
      st.i = j; if(items[j].focus) items[j].focus();
    });
  }
  function drawViewer(){
    var r = st.recs[st.i];
    if(nav && nav.title) nav.title("Photo " + (st.i + 1) + " of " + st.recs.length);
    var fig = mk("figure", "hg-viewer", body);
    var u = objUrl(r.blob);
    if(u){ st.urls.push(u); var im = mk("img", "hg-big", fig); im.src = u; im.alt = "Photo " + (st.i + 1) + ", taken " + when(r.at); }
    mk("figcaption", "hp-hint", fig, when(r.at));
    var bar = mk("div", "hp-bar hg-vbar", body);
    var prev = btn(bar, "Previous", "", function(){ go(-1); }, "Previous photo");
    btn(bar, "Next", "", function(){ go(1); }, "Next photo");
    btn(bar, "Save", "", function(){ save(r); }, "Save to disk");
    btn(bar, "Delete", "hp-danger", function(){ st.confirm = true; drawConfirm(); }, "Delete this photo");
    btn(bar, "All photos", "hp-ghost", function(){ st.view = "grid"; draw(); });
    var cbox = mk("div", "hg-confirm", body); cbox.hidden = true; st.cbox = cbox;
    if(prev.focus) prev.focus();
  }
  function drawConfirm(){
    var c = st.cbox; if(!c) return;
    clear(c); c.hidden = false;
    c.setAttribute("role", "alertdialog");
    var hid = uid("del"); var p = mk("p", "", c, "Delete this photo? It can't be undone."); p.id = hid;
    c.setAttribute("aria-labelledby", hid);
    var bar = mk("div", "hp-bar", c);
    var yes = btn(bar, "Delete", "hp-danger hp-primary", function(){ removeCur(); });
    btn(bar, "Cancel", "", function(){ st.confirm = false; c.hidden = true; clear(c); });
    if(yes.focus) yes.focus();
  }
  function removeCur(){
    var r = st.recs[st.i]; if(!r) return;
    store.remove(r.id).then(function(){
      say(host, "Photo deleted");
      st.confirm = false;
      load(function(){ if(st.i >= st.recs.length) st.i = Math.max(0, st.recs.length - 1); if(!st.recs.length) st.view = "grid"; draw(); });
    });
  }
  function go(dir){
    var j = step(st.i, dir, st.recs.length); if(j < 0) return;
    st.i = j; draw();
    say(host, "Photo " + (st.i + 1) + " of " + st.recs.length);
  }
  function save(r){
    var u = objUrl(r.blob); if(!u){ say(host, "This photo can't be saved"); return; }
    var a = mk("a", "", doc.body); a.href = u; a.download = fileName(r.at);
    try { a.click(); } catch(e){}
    if(a.parentNode) a.parentNode.removeChild(a);
    setTimeout(function(){ revoke(u); }, 4000);
    say(host, "Photo saved to your downloads");
  }
  load();
  return {
    onKey: function(e){
      if(st.view !== "view") return false;
      if(e.key === "Escape"){ if(st.confirm){ st.confirm = false; if(st.cbox){ st.cbox.hidden = true; clear(st.cbox); } return true; } st.view = "grid"; draw(); return true; }
      if(st.confirm || typingOrButton(e.target) && (e.key === "Enter" || e.key === " ")) return false;
      if(e.key === "ArrowLeft"){ go(-1); return true; }
      if(e.key === "ArrowRight"){ go(1); return true; }
      return false;
    },
    dispose: function(){ st.alive = false; freeUrls(); },
    _state: st, _reload: load
  };
}

Q.push({id: "camera", name: "Camera", order: 60, dock: false, needsCity: true, render: renderCamera,
        glyph: "M4 8h3l2-3h6l2 3h3v11H4zM12 10a3.5 3.5 0 1 0 0 7 3.5 3.5 0 0 0 0-7z"});
Q.push({id: "gallery", name: "Gallery", order: 61, dock: false, needsCity: false, render: renderGallery,
        glyph: "M4 5h16v14H4zM4 16l5-5 4 4 3-3 4 4M15 9.5a1.5 1.5 0 1 0 0-.01"});
API.render = {camera: renderCamera, gallery: renderGallery};
})();
