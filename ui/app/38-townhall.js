/* ================= HQ 3.x: the Town Hall (Cities) ================= */
// The panel behind a city's town hall door. The 3D city calls window.HQV.townHall.open(owner)
// (owner = a user id, or "commons") when you walk through it. Everyone sees the city card
// (name, tier and progress, population, treasury, tax) and the Market tab (goods, prices and
// stock, buy and sell). The owner also gets upgrades, treasury transfers (10% fee each way)
// and the privacy setting; the Arena enforces all of it, this only hides what you can't use.
// Data comes from the dashboard proxies (/api/arena/city/:owner, /api/arena/market/:owner and
// their POSTs, dashboard-rs/src/arena.rs), which check the owner id and allowlist every body.
// Built with textContent only: city names and goods come from other users.
var TOWNHALL = {owner:null, mine:false, tab:"city", city:null, market:null, err:null, msg:null, busy:false,
                qty:1, amount:100, opener:null, onClose:null, seq:0};
var TH_OWNER_RE = /^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|commons)$/;
var TH_TIER_NAMES = ["Village", "Town", "City", "Metropolis", "Capital"];
var TH_PRIVACY = [["arena", "Arena members"], ["friends", "Friends only"], ["closed", "Closed"]];
var TH_FEE_PCT = 10;          // the Arena takes 10% of a transfer, each way
var TH_MAX_QTY = 1000;        // the proxy's cap on one trade

function thEl(tag, cls, text){ var n = document.createElement(tag); if(cls) n.className = cls; if(text != null) n.textContent = String(text); return n; }
function thNum(v){ var n = Number(v); return isFinite(n) ? n : 0; }
function thFmt(v){ return Math.round(thNum(v)).toLocaleString("en-US"); }
function thWords(key){ var s = String(key || "").replace(/_/g, " "); return s.charAt(0).toUpperCase() + s.slice(1); }

/* ---- pure helpers (tests/test_townhall.py) ---- */
// {tier, name, pct, next}: next = the XP the next tier starts at, null at the top tier.
function thTierInfo(c){
  var tier = Math.max(1, Math.min(5, thNum(c && c.tier) | 0 || 1));
  var tx = (c && Array.isArray(c.tier_xp)) ? c.tier_xp : [];
  var next = tier < 5 && tx.length > tier ? thNum(tx[tier]) : null;
  var pct = tier >= 5 ? 100 : Math.max(0, Math.min(100, thNum(c && c.grow) / 10));
  return {tier: tier, name: TH_TIER_NAMES[tier - 1], pct: pct, next: next};
}
// What a transfer of `amount` costs: the fee (10%, rounded up) and what lands on the other side.
function thTransferQuote(amount){
  var a = Math.max(0, Math.floor(thNum(amount)));
  var fee = Math.ceil(a * TH_FEE_PCT / 100);
  return {amount: a, fee: fee, net: Math.max(0, a - fee)};
}
// GET /api/arena/market answers {good, price, stock}[]; tolerate a {goods: [...]} wrapper.
function thGoods(m){
  var rows = Array.isArray(m) ? m : (m && Array.isArray(m.goods) ? m.goods : []);
  return rows.filter(function(r){ return r && typeof r.good === "string"; });
}

/* ---- network ---- */
function thGet(path){
  return fetch(path, {cache: "no-store"}).then(function(r){
    return r.json().then(function(j){ return {ok: r.ok, code: r.status, j: j}; }, function(){ return {ok: false, code: r.status, j: {}}; });
  });
}
function thPost(path, body){
  return fetch(path, {method: "POST", headers: {"Content-Type": "application/json", "X-HQ-Token": (typeof CSRF === "string" ? CSRF : "")},
                      body: JSON.stringify(body)}).then(function(r){
    return r.json().then(function(j){ return {ok: r.ok, code: r.status, j: j || {}}; }, function(){ return {ok: false, code: r.status, j: {}}; });
  });
}
function thErr(res, fallback){
  var j = (res && res.j) || {};
  if(res && res.code === 404 && !j.error) return "This city is closed to you.";
  return String(j.error || j.detail || fallback || "The Arena didn't answer.").slice(0, 200);
}
// Load the city and its market together; a reply for a city we have since left is dropped.
function thLoad(){
  var owner = TOWNHALL.owner, seq = ++TOWNHALL.seq;
  return Promise.all([thGet("/api/arena/city/" + owner), thGet("/api/arena/market/" + owner)]).then(function(rs){
    if(seq !== TOWNHALL.seq) return;
    var c = rs[0], m = rs[1];
    TOWNHALL.city = c.ok && c.j && typeof c.j === "object" ? c.j : null;
    TOWNHALL.err = TOWNHALL.city ? null : (c.code === 404 ? "This city is closed to you." : thErr(c));
    TOWNHALL.market = m.ok ? thGoods(m.j) : null;
  }, function(){
    if(seq !== TOWNHALL.seq) return;
    TOWNHALL.city = null; TOWNHALL.market = null; TOWNHALL.err = "HQ didn't answer.";
  }).then(function(){ if(seq === TOWNHALL.seq) thRefresh(); });
}
// One action: POST, say how it went, then reload the card and the market.
function thAct(path, body, done){
  if(TOWNHALL.busy) return Promise.resolve();
  TOWNHALL.busy = true; TOWNHALL.msg = null; thRefresh();
  return thPost(path, body).then(function(res){
    TOWNHALL.msg = res.ok ? {ok: true, text: done} : {ok: false, text: thErr(res)};
  }, function(){ TOWNHALL.msg = {ok: false, text: "HQ didn't answer."}; }).then(function(){
    TOWNHALL.busy = false;
    if(typeof announce === "function" && TOWNHALL.msg) announce(TOWNHALL.msg.text);
    return thLoad();
  });
}
function thBuild(key){ return thAct("/api/arena/city/" + TOWNHALL.owner + "/build", {upgrade: key}, thWords(key) + " upgraded."); }
function thTransfer(dir){
  var q = thTransferQuote(TOWNHALL.amount);
  if(q.amount < 1){ TOWNHALL.msg = {ok: false, text: "Enter how many coins to move."}; thRefresh(); return Promise.resolve(); }
  return thAct("/api/arena/city/" + TOWNHALL.owner + "/transfer", {amount: q.amount, dir: dir},
               dir === "in" ? "Moved " + thFmt(q.net) + " coins into the treasury." : "Moved " + thFmt(q.net) + " coins to your wallet.");
}
function thPrivacy(mode){ return thAct("/api/arena/city/" + TOWNHALL.owner + "/privacy", {mode: mode}, "Privacy saved."); }
function thTrade(good, side){
  var qty = Math.max(1, Math.min(TH_MAX_QTY, Math.floor(thNum(TOWNHALL.qty)) || 1));
  return thAct("/api/arena/market/" + TOWNHALL.owner + "/trade", {good: good, qty: qty, side: side},
               (side === "buy" ? "Bought " : "Sold ") + qty + " " + thWords(good) + ".");
}

/* ---- rendering (textContent only) ---- */
function thButton(label, cls, tag, fn){
  var b = thEl("button", "hbtn" + (cls ? " " + cls : ""), label); b.type = "button";
  if(tag) b.setAttribute("data-th", tag);
  b.disabled = !!TOWNHALL.busy;
  b.addEventListener("click", fn);
  return b;
}
function thStat(box, label, value){
  var s = thEl("div", "th-stat"); s.appendChild(thEl("span", "th-stat-k", label)); s.appendChild(thEl("b", "th-stat-v", value)); box.appendChild(s);
}
function thRenderCity(box, c, mine){
  var ti = thTierInfo(c);
  var head = thEl("div", "th-head");
  head.appendChild(thEl("h3", "th-name", c.name || "Unnamed city"));
  head.appendChild(thEl("span", "th-tier", "Tier " + ti.tier + " · " + ti.name));
  box.appendChild(head);
  var prog = thEl("div", "th-prog");
  var bar = thEl("div", "th-bar"); bar.setAttribute("role", "progressbar");
  bar.setAttribute("aria-valuemin", "0"); bar.setAttribute("aria-valuemax", "100"); bar.setAttribute("aria-valuenow", String(Math.round(ti.pct)));
  var fill = thEl("div", "th-fill"); fill.style.width = ti.pct + "%"; bar.appendChild(fill); prog.appendChild(bar);
  prog.appendChild(thEl("span", "th-prog-label muted", ti.next == null ? "Top tier"
    : thFmt(c.xp) + " / " + thFmt(ti.next) + " XP to " + TH_TIER_NAMES[ti.tier]));
  box.appendChild(prog);
  var stats = thEl("div", "th-stats");
  thStat(stats, "Population", thFmt(c.population));
  thStat(stats, "Treasury", thFmt(c.treasury) + " coins");
  thStat(stats, "Tax", (thNum(c.tax_pm) / 10).toFixed(1) + "%");
  if(c.specialty) thStat(stats, "Specialty", thWords(c.specialty));
  box.appendChild(stats);

  var ups = thEl("section", "th-sec");
  ups.appendChild(thEl("h4", null, "Upgrades"));
  var keys = Object.keys((c.upgrades && typeof c.upgrades === "object") ? c.upgrades : {}).sort();
  if(!keys.length) ups.appendChild(thEl("p", "muted", "No upgrades yet."));
  keys.forEach(function(k){
    var row = thEl("div", "th-row");
    row.appendChild(thEl("span", "th-row-name", thWords(k)));
    row.appendChild(thEl("span", "th-row-v muted", "Level " + (thNum(c.upgrades[k]) | 0)));
    if(mine) row.appendChild(thButton("Buy", "on", "build:" + k, function(){ thBuild(k); }));
    ups.appendChild(row);
  });
  box.appendChild(ups);
  if(!mine) return;

  var tr = thEl("section", "th-sec");
  tr.appendChild(thEl("h4", null, "Treasury transfer"));
  var trow = thEl("div", "th-row");
  var amt = thEl("input", "th-input"); amt.type = "number"; amt.min = "1"; amt.step = "1"; amt.value = String(TOWNHALL.amount);
  amt.setAttribute("aria-label", "Coins to move"); amt.setAttribute("data-th", "amount");
  var q = thTransferQuote(TOWNHALL.amount);
  var fee = thEl("span", "th-fee muted", "10% fee: " + thFmt(q.fee) + " coins, " + thFmt(q.net) + " arrive");
  fee.setAttribute("data-th", "fee");
  amt.addEventListener("input", function(){
    TOWNHALL.amount = amt.value; var qq = thTransferQuote(amt.value);
    fee.textContent = "10% fee: " + thFmt(qq.fee) + " coins, " + thFmt(qq.net) + " arrive";
  });
  trow.appendChild(amt);
  trow.appendChild(thButton("Deposit", "", "transfer:in", function(){ thTransfer("in"); }));
  trow.appendChild(thButton("Withdraw", "", "transfer:out", function(){ thTransfer("out"); }));
  tr.appendChild(trow); tr.appendChild(fee);
  box.appendChild(tr);

  var pv = thEl("section", "th-sec");
  pv.appendChild(thEl("h4", null, "Who can visit"));
  var sel = thEl("select", "hbtn th-select"); sel.setAttribute("aria-label", "Who can visit"); sel.setAttribute("data-th", "privacy");
  TH_PRIVACY.forEach(function(p){ var o = thEl("option", null, p[1]); o.value = p[0]; sel.appendChild(o); });
  sel.value = TH_PRIVACY.some(function(p){ return p[0] === c.privacy; }) ? c.privacy : "arena";
  sel.disabled = !!TOWNHALL.busy;
  sel.addEventListener("change", function(){ thPrivacy(sel.value); });
  pv.appendChild(sel);
  box.appendChild(pv);
}
function thRenderMarket(box, goods){
  if(goods == null){ box.appendChild(thEl("p", "muted", "The market didn't answer.")); return; }
  if(!goods.length){ box.appendChild(thEl("p", "muted", "Nothing for sale here yet.")); return; }
  var qrow = thEl("div", "th-row");
  qrow.appendChild(thEl("span", "th-row-name", "Quantity"));
  var qty = thEl("input", "th-input"); qty.type = "number"; qty.min = "1"; qty.max = String(TH_MAX_QTY); qty.step = "1"; qty.value = String(TOWNHALL.qty);
  qty.setAttribute("aria-label", "Quantity"); qty.setAttribute("data-th", "qty");
  qty.addEventListener("input", function(){ TOWNHALL.qty = qty.value; });
  qrow.appendChild(qty); box.appendChild(qrow);
  var tbl = thEl("div", "th-goods");
  var hd = thEl("div", "th-good th-good-head");
  [["Good", null], ["Price", "th-num"], ["Stock", "th-num"], ["", null]].forEach(function(h){ hd.appendChild(thEl("span", h[1], h[0])); });
  tbl.appendChild(hd);
  goods.forEach(function(g){
    var r = thEl("div", "th-good");
    r.appendChild(thEl("span", "th-row-name", thWords(g.good)));
    r.appendChild(thEl("span", "th-num", thFmt(g.price)));
    r.appendChild(thEl("span", "th-num", thFmt(g.stock)));
    var acts = thEl("span", "th-acts");
    acts.appendChild(thButton("Buy", "on", "buy:" + g.good, function(){ thTrade(g.good, "buy"); }));
    acts.appendChild(thButton("Sell", "", "sell:" + g.good, function(){ thTrade(g.good, "sell"); }));
    r.appendChild(acts); tbl.appendChild(r);
  });
  box.appendChild(tbl);
}
// Fill `root` from a state {city, market, mine, tab, err, msg, busy}. Pure DOM building.
function thRender(root, s){
  root.textContent = "";
  var tabs = thEl("div", "th-tabs"); tabs.setAttribute("role", "tablist");
  [["city", "City"], ["market", "Market"]].forEach(function(t){
    var b = thEl("button", "th-tab" + (s.tab === t[0] ? " on" : ""), t[1]); b.type = "button";
    b.setAttribute("role", "tab"); b.setAttribute("aria-selected", s.tab === t[0] ? "true" : "false"); b.setAttribute("data-th", "tab:" + t[0]);
    b.addEventListener("click", function(){ TOWNHALL.tab = t[0]; thRefresh(); });
    tabs.appendChild(b);
  });
  root.appendChild(tabs);
  if(s.msg) root.appendChild(thEl("p", "th-msg" + (s.msg.ok ? " ok" : " bad"), s.msg.text));
  var box = thEl("div", "th-body"); root.appendChild(box);
  if(s.err){ box.appendChild(thEl("p", "th-msg bad", s.err)); return; }
  if(!s.city){ box.appendChild(thEl("p", "muted", "Loading…")); return; }
  if(s.tab === "market") thRenderMarket(box, s.market);
  else thRenderCity(box, s.city, !!s.mine);
}
function thRefresh(){ var b = document.getElementById("townHallBody"); if(b) thRender(b, TOWNHALL); }

/* ---- the modal ---- */
function thModal(){
  var back = document.getElementById("townHallBack"); if(back) return back;
  back = thEl("div", "tcard-back th-back"); back.id = "townHallBack"; back.setAttribute("aria-hidden", "true");
  var m = thEl("div", "tcard-modal th-modal"); m.setAttribute("role", "dialog"); m.setAttribute("aria-modal", "true"); m.setAttribute("aria-labelledby", "townHallTitle");
  var top = thEl("div", "tcard-top");
  var t = thEl("b", null, "Town Hall"); t.id = "townHallTitle";
  var x = thEl("button", "hbtn icon ghost", "✕"); x.type = "button"; x.id = "townHallClose"; x.setAttribute("aria-label", "Close");
  top.appendChild(t); top.appendChild(x); m.appendChild(top);
  var body = thEl("div", "th-panel"); body.id = "townHallBody"; m.appendChild(body);
  back.appendChild(m); document.body.appendChild(back);
  x.addEventListener("click", thClose);
  back.addEventListener("click", function(e){ if(e.target === back) thClose(); });
  // Keys typed here (amounts, Escape) never reach the 3D city underneath.
  back.addEventListener("keydown", function(e){
    e.stopPropagation();
    if(e.key === "Escape"){ e.preventDefault(); thClose(); }
  });
  return back;
}
// Open the town hall of `owner` (a user id or "commons"). opts.mine marks your own city
// (else it is yours when owner is your Arena user id); opts.onClose runs when it closes.
function thOpen(owner, opts){
  owner = String(owner || "");
  if(!TH_OWNER_RE.test(owner)) return false;
  opts = opts || {};
  var you = window.ARENA && ARENA.you && ARENA.you.userId;
  TOWNHALL.owner = owner; TOWNHALL.mine = owner !== "commons" && (opts.mine === true || (!!you && you === owner));
  TOWNHALL.tab = opts.tab === "market" ? "market" : "city";
  TOWNHALL.city = null; TOWNHALL.market = null; TOWNHALL.err = null; TOWNHALL.msg = null; TOWNHALL.busy = false;
  TOWNHALL.onClose = typeof opts.onClose === "function" ? opts.onClose : null;
  var back = thModal();
  if(document.pointerLockElement && document.exitPointerLock){ try { document.exitPointerLock(); } catch(e){} }
  if(!back.classList.contains("open")) TOWNHALL.opener = document.activeElement;
  back.classList.add("open"); back.setAttribute("aria-hidden", "false");
  thRefresh();
  var x = document.getElementById("townHallClose"); if(x && x.focus) x.focus();
  thLoad();
  return true;
}
function thClose(){
  var back = document.getElementById("townHallBack"); if(!back || !back.classList.contains("open")) return;
  back.classList.remove("open"); back.setAttribute("aria-hidden", "true");
  TOWNHALL.seq++;
  var o = TOWNHALL.opener, cb = TOWNHALL.onClose; TOWNHALL.opener = null; TOWNHALL.onClose = null;
  if(o && o.focus && o.isConnected){ try { o.focus(); } catch(e){} }
  if(cb){ try { cb(); } catch(e){} }
}
function thIsOpen(){ var back = document.getElementById("townHallBack"); return !!(back && back.classList.contains("open")); }

window.HQV = window.HQV || {};
window.HQV.townHall = {open: thOpen, close: thClose, isOpen: thIsOpen, render: thRender,
                       tierInfo: thTierInfo, transferQuote: thTransferQuote, goods: thGoods};
