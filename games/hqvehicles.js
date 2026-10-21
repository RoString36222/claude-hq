/* Claude HQ: the vehicle catalogue (HQV.hqVehicles). Pure helpers, no THREE, no DOM.
 *
 * The data is games/vehicles/catalogue.json (docs/plans/dealership-spec.md): classes (kind, type, cc band,
 * tier) and the real vehicles in them, two per class. Adding a vehicle is one entry there; nothing here
 * changes.
 *   load()                 -> Promise<catalogue>   fetched once, then the same object
 *   bandOf(kind, cc, electric) -> the class band: bikes "400" | "950" | "over950", cars "2000" | "3000" |
 *                          "5000" | "over5000"; "ev" for an electric drivetrain
 *   classes(cat)           -> the classes, starter excluded, bikes before cars, each kind by type then band
 *   byClass(cat, classId)  -> that class's vehicles: slot 1, slot 2, then reserves
 *   onSale(cat)            -> the classes with 1 to 4 listed vehicles (slots 1-4; HQ 3.9): the dealership's
 *   get(cat, id)           -> a vehicle by id, or null
 */
(function(){
"use strict";
var HQV = window.HQV = window.HQV || {};

var URL = "/games/vehicles/catalogue.json";
var BIKE_BANDS = ["400", "950", "over950"], CAR_BANDS = ["2000", "3000", "5000", "over5000", "ev"];
var P = null;

function load(){
  if(!P) P = fetch(URL).then(function(r){ if(!r.ok) throw new Error("vehicles " + r.status); return r.json(); })
    .catch(function(e){ P = null; throw e; });      // a failed load may be tried again
  return P;
}

function bandOf(kind, cc, electric){
  if(electric) return "ev";
  cc = +cc || 0;
  if(kind === "bike") return cc <= 400 ? "400" : cc <= 950 ? "950" : "over950";
  return cc <= 2000 ? "2000" : cc <= 3000 ? "3000" : cc <= 5000 ? "5000" : "over5000";
}

function bandRank(c){
  var L = c.kind === "bike" ? BIKE_BANDS : CAR_BANDS, i = L.indexOf(c.band);
  return i < 0 ? 99 : i;
}

function classes(cat){
  return ((cat && cat.classes) || []).filter(function(c){ return c.id !== "starter"; }).slice().sort(function(a, b){
    if(a.kind !== b.kind) return a.kind === "bike" ? -1 : 1;
    if(a.type !== b.type) return a.type < b.type ? -1 : 1;
    return bandRank(a) - bandRank(b);
  });
}

// [3.9] a class lists 1 to 4 vehicles (slots 1-4); a reserve waits outside them
var MAX_SLOTS = 4;
function isSlot(v){ return v && typeof v.slot === "number" && v.slot >= 1 && v.slot <= MAX_SLOTS && v.slot % 1 === 0; }
function slotRank(v){ return isSlot(v) ? v.slot - 1 : MAX_SLOTS; }

function byClass(cat, classId){
  return ((cat && cat.vehicles) || []).filter(function(v){ return v.class === classId; })
    .sort(function(a, b){ return slotRank(a) - slotRank(b) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0); });
}

function onSale(cat){
  return classes(cat).filter(function(c){
    var s = byClass(cat, c.id).filter(isSlot);
    return s.length >= 1 && s.length <= MAX_SLOTS;
  });
}

function get(cat, id){
  var L = (cat && cat.vehicles) || [];
  for(var i = 0; i < L.length; i++) if(L[i].id === id) return L[i];
  return null;
}

HQV.hqVehicles = {load: load, bandOf: bandOf, classes: classes, byClass: byClass, onSale: onSale, isSlot: isSlot, MAX_SLOTS: MAX_SLOTS, get: get, URL: URL};
})();
