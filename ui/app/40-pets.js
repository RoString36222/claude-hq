/* ================= HQ 3.14: Pets ================= */
// Your pets (games/hqpets.js draws them): who you own, who is out with you, who lives in your HQ lobby, their
// names, colours, accessories and affection. With an Arena that lists the "pets" capability they are kept there
// (/api/arena/pets/*, dashboard-rs/src/arena.rs, backend/src/pets.rs checks every rule) and others see the ones out
// with you; otherwise they live in this browser (localStorage hq_pets) and only you see them.
// The Pets panel (Cmd-K "Pets", Settings, E at the City's Pet shop) is built with textContent only: names are typed
// by users. Not the session creatures: those are raised by your Claude Code sessions, these are adopted.
var PETS = {list: [], src: "local", level: 1, coins: 0, loaded: false, busy: false, err: null, msg: null, tab: "mine",
            sel: null, opener: null, pushedTo: null, lobbyFor: null, adoptSp: "shiba", adoptVar: 0, seq: 0};
var PETS_KEY = "hq_pets";
var PETS_ICON = {dog: "🐕", cat: "🐈", dragon: "🐉", dino: "🦖", serpent: "🐍"};
var PET_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

function petsLib(){ return (window.HQV && window.HQV.hqPets) || null; }
function petsEl(tag, cls, text){ var n = document.createElement(tag); if(cls) n.className = cls; if(text != null) n.textContent = String(text); return n; }
function petsArena(){ return !!(window.ARENA && ARENA.paired && typeof hqNetCan === "function" && hqNetCan("pets")); }
function petsLevel(){ var l = typeof myLevel === "function" ? myLevel() : null; return Math.max(1, (l && l.level) | 0 || ((STATE && STATE.season && STATE.season.level) | 0) || 1); }
function petsHex(n){ return "#" + ("000000" + ((n >>> 0) & 0xffffff).toString(16)).slice(-6); }

/* ---- pure helpers (tests/test_hqpets.py) ---- */
// A stored list, made safe: known species, clean names, numbers in range, at most 6, at most 2 out, ids unique.
function petsSanitize(raw){
  var L = petsLib(), out = [], seen = {}, act = 0;
  if(!L || !Array.isArray(raw)) return out;
  raw.forEach(function(p){
    if(!p || typeof p !== "object" || out.length >= L.MAX_OWNED) return;
    var sp = L.speciesOf(p.species), name = L.cleanName(p.name), id = typeof p.id === "string" && /^[A-Za-z0-9-]{1,40}$/.test(p.id) ? p.id : null;
    if(!sp || !name || !id || seen[id]) return;
    seen[id] = 1;
    var active = !!p.active && act < L.MAX_ACTIVE; if(active) act++;
    out.push({id: id, species: sp.id, variant: Math.max(0, Math.min(L.VARIANTS - 1, p.variant | 0)), name: name,
              acc: L.accOk(sp, p.acc) ? p.acc | 0 : 0, affection: Math.max(0, Math.min(L.AFF_MAX, p.affection | 0)),
              active: active, home: p.home !== false, adopted_at: +p.adopted_at || 0});
  });
  return out;
}
// The same adoption rules as the Arena, for a local (unpaired) adoption: free from its level, never past 6.
function petsLocalAdopt(list, species, variant, name, level, now){
  var L = petsLib(), sp = L && L.speciesOf(species), n = L && L.cleanName(name);
  if(!sp) return {err: "No such pet."};
  if(!n) return {err: "Names are 1 to 12 letters, digits, spaces, - or ', and kind."};
  var ok = L.canAdopt(sp, {level: level, owned: list.length, local: true});
  if(!ok.ok) return {err: ok.why};
  var out = list.filter(function(p){ return p.active; }).length;
  var id = "local-" + (now || Date.now()).toString(36) + "-" + (L.hashStr(n + list.length) % 46656).toString(36);
  var pet = {id: id, species: sp.id, variant: Math.max(0, Math.min(L.VARIANTS - 1, variant | 0)), name: n, acc: 1, affection: 0,
             active: out < L.MAX_ACTIVE, home: true, adopted_at: Math.floor((now || Date.now())/1000)};
  return {list: list.concat([pet]), pet: pet};
}
// A local edit with the Arena's checks: name, variant, accessories (a saddle only on the big ones), out (at most 2), home.
function petsLocalEdit(list, id, e){
  var L = petsLib(), i = -1;
  list.forEach(function(p, k){ if(p.id === id) i = k; });
  if(i < 0) return {err: "No such pet."};
  var p = Object.assign({}, list[i]), sp = L.speciesOf(p.species);
  if(e.name != null){ var n = L.cleanName(e.name); if(!n) return {err: "Names are 1 to 12 letters, digits, spaces, - or ', and kind."}; p.name = n; }
  if(e.variant != null) p.variant = Math.max(0, Math.min(L.VARIANTS - 1, e.variant | 0));
  if(e.acc != null){ if(!L.accOk(sp, e.acc)) return {err: "A saddle only fits the big ones."}; p.acc = e.acc | 0; }
  if(e.active === true && !p.active && list.filter(function(q){ return q.active; }).length >= L.MAX_ACTIVE) return {err: L.MAX_ACTIVE + " pets are out already: leave one at home first."};
  if(e.active != null) p.active = !!e.active;
  if(e.home != null) p.home = !!e.home;
  var out = list.slice(); out[i] = p;
  return {list: out, pet: p};
}

/* ---- storage ---- */
function petsLocalLoad(){ try { return petsSanitize(JSON.parse(localStorage.getItem(PETS_KEY) || "[]")); } catch(e){ return []; } }
function petsLocalSave(){ if(PETS.src !== "local") return; try { localStorage.setItem(PETS_KEY, JSON.stringify(PETS.list)); } catch(e){} }
function petsGet(path){
  return fetch(path, {cache: "no-store"}).then(function(r){ return r.json().then(function(j){ return {ok: r.ok, status: r.status, j: j || {}}; }, function(){ return {ok: false, status: r.status, j: {}}; }); });
}
function petsPostArena(path, body){ return typeof arenaPost === "function" ? arenaPost(path, body) : Promise.reject(new Error("no arena")); }
function petsWhy(res, fallback){ var j = (res && res.j) || {}; return String(j.error || j.detail || fallback || "The Arena didn't answer.").slice(0, 200); }
function petsLoad(){
  var seq = ++PETS.seq;
  if(!petsArena()){
    PETS.src = "local"; PETS.list = petsLocalLoad(); PETS.level = petsLevel(); PETS.loaded = true; petsChanged(); return Promise.resolve();
  }
  return petsGet("/api/arena/pets/mine").then(function(res){
    if(seq !== PETS.seq) return;
    if(!res.ok){ PETS.err = petsWhy(res); PETS.src = "local"; PETS.list = petsLocalLoad(); }
    else { PETS.src = "arena"; PETS.list = petsSanitize(res.j.pets || []); PETS.level = Math.max(1, res.j.level | 0); PETS.coins = Math.max(0, res.j.coins | 0); PETS.err = null; }
    PETS.loaded = true; petsChanged();
  }).catch(function(){ if(seq === PETS.seq){ PETS.src = "local"; PETS.list = petsLocalLoad(); PETS.loaded = true; petsChanged(); } });
}
// Something changed: the 3D HQ gets the new list, the panel redraws, a local list is saved
function petsChanged(){ petsLocalSave(); petsPush(true); petsRender(); }
function petsPush(force){
  var inst = window.HQ3D && HQ3D.inst;
  if(!inst || !inst.setPets) return;
  if(force || PETS.pushedTo !== inst){ PETS.pushedTo = inst; inst.setPets(PETS.list.slice()); }
  // visiting someone: their lobby's pets (an open HQ only; the Arena checks)
  var host = HQ3D.visit ? (HQ3D.visit.userId || HQ3D.visit.id || null) : null;
  if(host !== PETS.lobbyFor){
    PETS.lobbyFor = host;
    if(!host){ if(inst.setLobbyPets) inst.setLobbyPets(null); }
    else if(petsArena() && /^[0-9a-f-]{36}$/.test(host)){
      petsGet("/api/arena/pets/home?u=" + encodeURIComponent(host)).then(function(res){
        if(PETS.lobbyFor !== host || !HQ3D.inst || !HQ3D.inst.setLobbyPets) return;
        var L = petsLib(); if(!L) return;
        var list = (res.ok && Array.isArray(res.j.pets) ? res.j.pets : []).filter(function(p){ return p && L.speciesOf(p.species) && L.cleanName(p.name); }).slice(0, L.MAX_OWNED);
        HQ3D.inst.setLobbyPets(list);
      }).catch(function(){});
    } else if(inst.setLobbyPets) inst.setLobbyPets([]);
  }
}
// [3.13.5] a refresh: the 3D HQ is often up before the Arena's capabilities arrive, so the first load fell back to this
// browser's local list (none) and stayed there: your pets were gone till you opened the Pets panel. Once the Arena
// says "pets", load again from it (once per page; a failed Arena load keeps the local list and its error).
function petsTick(){
  if(!(window.HQ3D && HQ3D.inst)) return;
  if(!PETS.loaded && petsLib()) petsLoad();
  else if(PETS.loaded && PETS.src === "local" && !PETS.err && !PETS.busy && !PETS.arenaTried && petsArena()){ PETS.arenaTried = true; petsLoad(); }
  else petsPush(false);
}
setInterval(petsTick, 1000);

/* ---- actions ---- */
function petsSay(msg, bad){ PETS.msg = msg ? {t: msg, bad: !!bad} : null; petsRender(); if(msg && typeof announce === "function") announce(msg); }
function petsAdopt(species, variant, name){
  if(PETS.busy) return;
  var L = petsLib(); if(!L) return;
  if(PETS.src !== "arena"){
    var r = petsLocalAdopt(PETS.list, species, variant, name, petsLevel(), Date.now());
    if(r.err){ petsSay(r.err, true); return; }
    PETS.list = r.list; PETS.sel = r.pet.id; PETS.tab = "mine"; petsChanged(); petsSay("Welcome home, " + r.pet.name + "!");
    return;
  }
  var n = L.cleanName(name); if(!n){ petsSay("Names are 1 to 12 letters, digits, spaces, - or ', and kind.", true); return; }
  PETS.busy = true; petsRender();
  petsPostArena("/api/arena/pets/adopt", {species: species, variant: variant | 0, name: n}).then(function(res){
    PETS.busy = false;
    if(!res.ok){ petsSay(petsWhy(res), true); return; }
    PETS.coins = Math.max(0, res.j.coins | 0);
    var pet = petsSanitize([res.j.pet])[0]; if(pet){ PETS.list = PETS.list.concat([pet]); PETS.sel = pet.id; }
    PETS.tab = "mine"; petsChanged();
    petsSay("Welcome home, " + n + "!" + (res.j.paid ? " (" + (res.j.paid | 0) + " Poke Coins)" : ""));
  }).catch(function(){ PETS.busy = false; petsSay("The Arena didn't answer.", true); });
}
function petsEdit(id, e, okMsg){
  if(PETS.busy) return Promise.resolve(false);
  if(PETS.src !== "arena"){
    var r = petsLocalEdit(PETS.list, id, e);
    if(r.err){ petsSay(r.err, true); return Promise.resolve(false); }
    PETS.list = r.list; petsChanged(); if(okMsg) petsSay(okMsg);
    return Promise.resolve(true);
  }
  if(!PET_ID_RE.test(id)) return Promise.resolve(false);
  PETS.busy = true; petsRender();
  return petsPostArena("/api/arena/pets/" + id + "/edit", e).then(function(res){
    PETS.busy = false;
    if(!res.ok){ petsSay(petsWhy(res), true); return false; }
    var pet = petsSanitize([res.j.pet])[0];
    if(pet) PETS.list = PETS.list.map(function(p){ return p.id === id ? pet : p; });
    petsChanged(); if(okMsg) petsSay(okMsg);
    return true;
  }).catch(function(){ PETS.busy = false; petsSay("The Arena didn't answer.", true); return false; });
}
function petsRelease(id){
  var p = PETS.list.filter(function(q){ return q.id === id; })[0]; if(!p) return;
  if(!window.confirm("Rehome " + p.name + "? They go to a loving home and leave your HQ for good.")) return;
  var done = function(){ PETS.list = PETS.list.filter(function(q){ return q.id !== id; }); PETS.sel = null; petsChanged(); petsSay(p.name + " went to a loving home."); };
  if(PETS.src !== "arena"){ done(); return; }
  if(!PET_ID_RE.test(id)) return;
  petsPostArena("/api/arena/pets/" + id + "/release", {}).then(function(res){ if(res.ok) done(); else petsSay(petsWhy(res), true); }).catch(function(){ petsSay("The Arena didn't answer.", true); });
}
// petting, fetch and tricks in the 3D HQ (games/hqpets.js -> hq3d api.petCare): affection, at most 40 a day per pet
function petsCare(id, kind){
  var p = PETS.list.filter(function(q){ return q.id === id; })[0]; if(!p) return;
  var gain = kind === "fetch" ? 2 : 1, L = petsLib();
  if(PETS.src !== "arena"){
    var day = Math.floor(Date.now()/86400000), k = "hq_pets_care", c = {};
    try { c = JSON.parse(localStorage.getItem(k) || "{}") || {}; } catch(e){ c = {}; }
    var used = c[id] && c[id][0] === day ? c[id][1] | 0 : 0, got = Math.max(0, Math.min(gain, 40 - used, L.AFF_MAX - p.affection));
    c[id] = [day, used + got]; try { localStorage.setItem(k, JSON.stringify(c)); } catch(e){}
    if(got){ p.affection += got; petsAfter(p, got); }
    return;
  }
  if(!PET_ID_RE.test(id)) return;
  petsPostArena("/api/arena/pets/" + id + "/care", {kind: kind}).then(function(res){
    if(!res.ok || !res.j) return;
    var got = res.j.gained | 0; p.affection = Math.max(0, Math.min(L.AFF_MAX, res.j.affection | 0));
    if(got) petsAfter(p, got);
  }).catch(function(){});
}
function petsAfter(p, got){
  var L = petsLib(), sp = L.speciesOf(p.species), before = L.stageOf(sp, p.affection - got), now = L.stageOf(sp, p.affection);
  var tb = L.tricksFor(sp, p.affection - got).length, ta = L.tricksFor(sp, p.affection);
  petsLocalSave();
  if(now > before){ petsPush(true); if(typeof toast === "function") toast(p.name + " grew! 🐉", "level"); }
  else if(ta.length > tb && typeof toast === "function") toast(p.name + " learned " + ta[ta.length - 1].label + " (O)", "level");
  petsRender();
}
// F in your lobby (games/hqpets.js): take a stay-home pet out, or leave one of yours there
function petsToggleOut(id, out){
  var p = PETS.list.filter(function(q){ return q.id === id; })[0]; if(!p) return;
  if(out && PETS.list.filter(function(q){ return q.active; }).length >= petsLib().MAX_ACTIVE){ if(typeof toast === "function") toast("Two pets are out already: leave one here first (stand facing it and press F)", "level"); return; }
  petsEdit(id, out ? {active: true} : {active: false, home: true}, out ? p.name + " comes along!" : p.name + " stays in the lobby.").then(function(ok){
    if(ok && typeof toast === "function") toast(out ? p.name + " comes along!" : p.name + " stays in the lobby", "level");
  });
}

/* ---- the panel ---- */
function petsModal(){
  var back = document.getElementById("petsBack"); if(back) return back;
  back = petsEl("div", "tcard-back pets-back"); back.id = "petsBack"; back.setAttribute("aria-hidden", "true");
  var m = petsEl("div", "tcard-modal pets-modal"); m.setAttribute("role", "dialog"); m.setAttribute("aria-modal", "true"); m.setAttribute("aria-labelledby", "petsTitle");
  var top = petsEl("div", "tcard-top");
  var t = petsEl("b", null, "🐾 Pets"); t.id = "petsTitle";
  var x = petsEl("button", "hbtn icon ghost", "✕"); x.type = "button"; x.id = "petsClose"; x.setAttribute("aria-label", "Close");
  top.appendChild(t); top.appendChild(x); m.appendChild(top);
  var body = petsEl("div", "pets-panel"); body.id = "petsBody"; m.appendChild(body);
  back.appendChild(m); document.body.appendChild(back);
  x.addEventListener("click", petsClose);
  back.addEventListener("click", function(e){ if(e.target === back) petsClose(); });
  back.addEventListener("keydown", function(e){ e.stopPropagation(); if(e.key === "Escape"){ e.preventDefault(); petsClose(); } });
  return back;
}
// games/hqpets.js (the roster and rules) comes with the 3D HQ; opened before that, the panel fetches it alone
function petsNeedLib(then){
  if(petsLib()){ then(); return; }
  if(PETS.libLoading) return;
  PETS.libLoading = true;
  var sc = document.createElement("script"); sc.src = "/games/hqpets.js"; sc.async = true;
  sc.onload = function(){ PETS.libLoading = false; then(); }; sc.onerror = function(){ PETS.libLoading = false; petsRender(); };
  document.head.appendChild(sc);
}
function petsOpen(tab){
  var back = petsModal();
  petsNeedLib(function(){ petsRender(); petsLoad(); });
  if(document.pointerLockElement && document.exitPointerLock){ try { document.exitPointerLock(); } catch(e){} }
  if(!back.classList.contains("open")) PETS.opener = document.activeElement;
  PETS.tab = tab === "adopt" ? "adopt" : "mine"; PETS.msg = null;
  back.classList.add("open"); back.setAttribute("aria-hidden", "false");
  petsRender(); petsLoad();
  var x = document.getElementById("petsClose"); if(x && x.focus) x.focus();
  return true;
}
function petsClose(){
  var back = document.getElementById("petsBack"); if(!back || !back.classList.contains("open")) return;
  back.classList.remove("open"); back.setAttribute("aria-hidden", "true");
  var o = PETS.opener; PETS.opener = null; if(o && o.focus && o.isConnected){ try { o.focus(); } catch(e){} }
}
function petsIsOpen(){ var b = document.getElementById("petsBack"); return !!(b && b.classList.contains("open")); }
function petsSwatches(sp, cur, onPick, label){
  var row = petsEl("div", "pets-swatches"); row.setAttribute("role", "radiogroup"); row.setAttribute("aria-label", label);
  sp.pal.forEach(function(pal, i){
    var b = petsEl("button", "pets-sw" + (i === cur ? " on" : "")); b.type = "button"; b.setAttribute("role", "radio"); b.setAttribute("aria-checked", i === cur ? "true" : "false");
    b.setAttribute("aria-label", "Colours " + (i + 1)); b.tabIndex = i === cur ? 0 : -1;
    b.style.background = "linear-gradient(135deg," + petsHex(pal[0]) + " 0 55%," + petsHex(pal[1]) + " 55% 80%," + petsHex(pal[2]) + " 80%)";
    b.addEventListener("click", function(){ onPick(i); });
    b.addEventListener("keydown", function(e){ if(e.key === "ArrowRight" || e.key === "ArrowLeft"){ e.preventDefault(); onPick((i + (e.key === "ArrowRight" ? 1 : sp.pal.length - 1)) % sp.pal.length); setTimeout(function(){ var on = document.querySelector("#petsBody .pets-sw.on"); if(on) on.focus(); }, 0); } });
    row.appendChild(b);
  });
  return row;
}
function petsRender(){
  var box = document.getElementById("petsBody"); if(!box) return;
  var L = petsLib(); box.textContent = "";
  if(!L){ box.appendChild(petsEl("p", "muted", "Pets need the 3D HQ: open it once (H) and come back.")); return; }
  var tabs = petsEl("div", "th-tabs"); tabs.setAttribute("role", "tablist");
  [["mine", "Your pets (" + PETS.list.length + "/" + L.MAX_OWNED + ")"], ["adopt", "Adopt"]].forEach(function(tb){
    var b = petsEl("button", "th-tab" + (PETS.tab === tb[0] ? " on" : ""), tb[1]); b.type = "button"; b.setAttribute("role", "tab"); b.setAttribute("aria-selected", PETS.tab === tb[0] ? "true" : "false");
    b.addEventListener("click", function(){ PETS.tab = tb[0]; PETS.msg = null; petsRender(); }); tabs.appendChild(b);
  });
  box.appendChild(tabs);
  var where = petsEl("p", "muted pets-src", PETS.src === "arena" ? "Kept on the Arena: friends see the pets out with you." + (PETS.coins ? " You have " + PETS.coins + " Poke Coins." : "")
    : "Kept in this browser (pair with an Arena that has pets for friends to see them).");
  box.appendChild(where);
  if(PETS.msg){ var mg = petsEl("p", "th-msg " + (PETS.msg.bad ? "bad" : "ok"), PETS.msg.t); mg.setAttribute("role", PETS.msg.bad ? "alert" : "status"); box.appendChild(mg); }
  if(PETS.tab === "adopt") petsRenderAdopt(box, L); else petsRenderMine(box, L);
}
function petsRenderMine(box, L){
  if(!PETS.list.length){
    box.appendChild(petsEl("p", null, "No pets yet. Dogs and cats are free to adopt; dragons, dinosaurs and the sea serpent unlock with your HQ level."));
    var go = petsEl("button", "hbtn on", "Adopt a pet"); go.type = "button"; go.addEventListener("click", function(){ PETS.tab = "adopt"; petsRender(); }); box.appendChild(go);
    return;
  }
  box.appendChild(petsEl("p", "muted", "Out with you (at most " + L.MAX_ACTIVE + ") follow you; the rest live in your HQ lobby. Keys: B throw a ball, U pet, O a trick, E in the lobby take one out or leave one there."));
  var ul = petsEl("ul", "pets-list");
  PETS.list.forEach(function(p){
    var sp = L.speciesOf(p.species), li = petsEl("li", "pets-card"), head = petsEl("div", "pets-head");
    var ic = petsEl("span", "pets-ic", PETS_ICON[sp.kind] || "🐾"); ic.setAttribute("aria-hidden", "true"); ic.style.background = petsHex(sp.pal[p.variant][0]);
    var nm = petsEl("b", "pets-name", p.name), sub = petsEl("small", "muted", sp.name + (sp.grows ? " · " + ["hatchling", "young", "grown"][L.stageOf(sp, p.affection)] : ""));
    var tx = petsEl("div", "pets-t"); tx.appendChild(nm); tx.appendChild(sub);
    head.appendChild(ic); head.appendChild(tx);
    var aff = petsEl("meter", "pets-aff"); aff.min = 0; aff.max = L.AFF_MAX; aff.value = p.affection; aff.setAttribute("aria-label", "Affection " + p.affection + " of " + L.AFF_MAX);
    head.appendChild(aff); li.appendChild(head);
    // out / home
    var row = petsEl("div", "th-row");
    function chk(label, on, fn, dis){ var l = petsEl("label", "dex-toggle"), c = petsEl("input"); c.type = "checkbox"; c.checked = !!on; c.disabled = !!dis || PETS.busy; c.addEventListener("change", function(){ fn(c.checked); }); l.appendChild(c); l.appendChild(document.createTextNode(" " + label)); return l; }
    row.appendChild(chk("Out with you", p.active, function(v){ petsEdit(p.id, {active: v}, v ? p.name + " comes along." : p.name + " stays behind."); }));
    row.appendChild(chk("Lives in the lobby", p.home, function(v){ petsEdit(p.id, {home: v}); }));
    li.appendChild(row);
    // rename
    var rn = petsEl("div", "th-row"), inp = petsEl("input"); inp.type = "text"; inp.maxLength = L.NAME_MAX; inp.value = p.name; inp.setAttribute("aria-label", "Rename " + p.name); inp.autocomplete = "off";
    var save = petsEl("button", "hbtn", "Rename"); save.type = "button"; save.disabled = PETS.busy;
    save.addEventListener("click", function(){ petsEdit(p.id, {name: inp.value}, "Renamed."); });
    inp.addEventListener("keydown", function(e){ if(e.key === "Enter"){ e.preventDefault(); save.click(); } });
    rn.appendChild(inp); rn.appendChild(save); li.appendChild(rn);
    // colours and accessories
    li.appendChild(petsSwatches(sp, p.variant, function(i){ petsEdit(p.id, {variant: i}); }, p.name + "'s colours"));
    var ac = petsEl("div", "th-row pets-acc");
    L.ACC_NAMES.forEach(function(a){
      var bit = L.ACC[a[0]], fits = a[0] !== "saddle" || sp.saddle;
      if(!fits) return;
      ac.appendChild(chk(a[1], p.acc & bit, function(v){ petsEdit(p.id, {acc: v ? (p.acc | bit) : (p.acc & ~bit)}); }));
    });
    li.appendChild(ac);
    var tr = L.tricksFor(sp, p.affection), nx = L.nextTrick(sp, p.affection);
    li.appendChild(petsEl("small", "muted", "Tricks: " + tr.map(function(x){ return x.label; }).join(", ") + (nx ? " · next: " + nx.label + " at " + nx.at + " affection" : "")));
    var rel = petsEl("button", "hbtn ghost pets-rel", "Rehome…"); rel.type = "button"; rel.addEventListener("click", function(){ petsRelease(p.id); });
    li.appendChild(rel);
    ul.appendChild(li);
  });
  box.appendChild(ul);
}
function petsRenderAdopt(box, L){
  var level = PETS.src === "arena" ? PETS.level : petsLevel();
  box.appendChild(petsEl("p", "muted", "Paws & Claws, the City's Pet shop (Go to: Pet shop). Dogs and cats are free. The rarer ones are free from their HQ level" +
    (PETS.src === "arena" ? ", or can be adopted sooner for Poke Coins." : ".") + " You're level " + level + "."));
  var grid = petsEl("div", "pets-grid"); grid.setAttribute("role", "radiogroup"); grid.setAttribute("aria-label", "Choose a pet");
  ["dog", "cat", "dino", "dragon", "serpent"].forEach(function(kind){
    L.SPECIES.filter(function(s){ return s.kind === kind; }).forEach(function(sp){
      var ok = L.canAdopt(sp, {level: level, coins: PETS.coins, owned: PETS.list.length, local: PETS.src !== "arena"});
      var b = petsEl("button", "pets-pick" + (PETS.adoptSp === sp.id ? " on" : "")); b.type = "button"; b.setAttribute("role", "radio"); b.setAttribute("aria-checked", PETS.adoptSp === sp.id ? "true" : "false");
      var ic = petsEl("span", "pets-ic", PETS_ICON[sp.kind]); ic.setAttribute("aria-hidden", "true"); ic.style.background = petsHex(sp.pal[0][0]);
      var nm = petsEl("b", null, sp.name);
      var st = petsEl("small", ok.ok ? "pets-ok" : "muted", level >= sp.minLevel ? "Free" : (PETS.src === "arena" ? "Level " + sp.minLevel + " or " + sp.price + " coins" : "Level " + sp.minLevel));
      b.appendChild(ic); b.appendChild(nm); b.appendChild(st);
      b.addEventListener("click", function(){ PETS.adoptSp = sp.id; PETS.adoptVar = 0; petsRender(); var on = document.querySelector("#petsBody .pets-pick.on"); if(on) on.focus(); });
      grid.appendChild(b);
    });
  });
  box.appendChild(grid);
  var sp = L.speciesOf(PETS.adoptSp) || L.SPECIES[0], ok = L.canAdopt(sp, {level: level, coins: PETS.coins, owned: PETS.list.length, local: PETS.src !== "arena"});
  var form = petsEl("div", "pets-form");
  form.appendChild(petsEl("b", null, sp.name + " · " + L.KIND_LABEL[sp.kind] + (sp.grows ? " (grows with affection)" : "")));
  form.appendChild(petsSwatches(sp, PETS.adoptVar, function(i){ PETS.adoptVar = i; petsRender(); }, "Colours"));
  var row = petsEl("div", "th-row"), inp = petsEl("input"); inp.type = "text"; inp.id = "petsName"; inp.maxLength = L.NAME_MAX; inp.placeholder = "Name (1 to 12 letters)"; inp.autocomplete = "off"; inp.setAttribute("aria-label", "Your new pet's name");
  var go = petsEl("button", "hbtn on", ok.ok ? (ok.price ? "Adopt for " + ok.price + " coins" : "Adopt") : "Locked"); go.type = "button"; go.disabled = !ok.ok || PETS.busy;
  go.addEventListener("click", function(){ petsAdopt(sp.id, PETS.adoptVar, inp.value); });
  inp.addEventListener("keydown", function(e){ if(e.key === "Enter"){ e.preventDefault(); go.click(); } });
  row.appendChild(inp); row.appendChild(go); form.appendChild(row);
  if(!ok.ok) form.appendChild(petsEl("small", "muted", ok.why));
  box.appendChild(form);
}

window.HQV = window.HQV || {};
window.HQV.petsUi = {open: petsOpen, close: petsClose, isOpen: petsIsOpen, render: petsRender, load: petsLoad,
                     tick: petsTick, sanitize: petsSanitize, localAdopt: petsLocalAdopt, localEdit: petsLocalEdit};
(function(){ var b = document.getElementById("setPetsOpen"); if(b) b.addEventListener("click", function(){ if(typeof closeSettings === "function") closeSettings(); petsOpen("mine"); }); })();
