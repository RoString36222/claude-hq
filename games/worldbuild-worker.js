/* Claude HQ: builds world tiles off the main thread (classic worker; see games/worldbuild.js).
 *   -> {op:"init", W}                                        <- {op:"ready", hash}
 *   -> {op:"tile", id, tx, tz, lods, want:[...], tier?}      <- {op:"tile", id, tx, tz, tier?, terrain?, roads?, ground?, buildings0?, buildings1?, props?}
 *                                                            <- {op:"error", id, message}
 * `tier` builds the tile as that city tier shows the world (HQV.worldgeom.view; each tier's view is cached here).
 * Typed arrays are transferred back. Nothing here leaves the machine.
 */
importScripts("/games/world.js", "/games/worldgeom.js");
(function(){
"use strict";
var W = null;
self.onmessage = function(ev){
  var m = ev.data || {};
  try {
    if(m.op === "init"){
      W = m.W || null;
      self.postMessage({op: "ready", hash: W ? W.hash : null});
      return;
    }
    if(m.op === "tile"){
      if(!W) throw new Error("not initialised");
      var out = self.HQV.worldgeom.buildTile(W, m);
      self.postMessage(out, self.HQV.worldgeom.transferables(out));
    }
  } catch(e){
    self.postMessage({op: "error", id: m.id, message: String((e && e.message) || e)});
  }
};
})();
