/* Helpers tools/graphics_tour.py loads into the page (?hqsmoke=1), after tools/transit_tour.js: put the avatar at a
   spot, hold a camera on it, and find the ring's tunnel and cutting with the page's own HQV.world.tunnelsOf.
   Each returns a JSON string. Test-only: never part of the HQ page. */
(function(){
var D = function(){ return window.HQ3D_DEBUG; };
var GT = window.__gt = {};
function J(v){ try { return JSON.stringify(v); } catch(e){ return String(v); } }
// back on the street: no held camera, not below it, the chase camera
GT.reset = function(){
  var T = D().transit;
  if(T){ T.shotClear(); T.under(false); }
  D().mode("chase");
  return "1";
};
// the avatar at (x, z) facing yaw (so the tiles round it are built), then (with pos/look) a held camera
GT.go = function(x, z, yaw, pos, look, fov){
  GT.reset();
  D().teleport(x, z, yaw);
  if(pos && look) D().transit.cam({pos: pos, look: look, fov: fov || 60});
  return J({x: x, z: z});
};
// a metro station below the street (the first one, as tools/ui_smoke.py's underground check)
GT.metro = function(){
  GT.reset();
  var T = D().transit, s = T ? (T.stops("metro") || [])[0] : null;
  return J(s ? T.go(s.id) : {err: "no metro station"});
};
// the middle of the first tunnel and the first cutting of the world you are in (world.js tunnelsOf): the point, its
// road height (m) and the road's direction there
GT.tunnels = function(){
  var WQ = window.HQV && window.HQV.world, W = WQ && WQ.current ? WQ.current(D().world()) : null;
  if(!W || !WQ.tunnelsOf) return J({err: "no world"});
  function mid(t){
    var P = t.pts, half = t.len/2, s = 0;
    for(var i = 1; i < P.length; i++){
      var a = P[i-1], b = P[i], l = Math.sqrt((b[0]-a[0])*(b[0]-a[0]) + (b[2]-a[2])*(b[2]-a[2]));
      if(s + l >= half || i === P.length - 1){
        var f = l ? Math.min(1, (half - s)/l) : 0;
        return {edge: t.edge, x: a[0] + (b[0]-a[0])*f, y: a[1] + (b[1]-a[1])*f, z: a[2] + (b[2]-a[2])*f, dx: (b[0]-a[0])/(l || 1), dz: (b[2]-a[2])/(l || 1), len: t.len};
      }
      s += l;
    }
    return null;
  }
  var T = WQ.tunnelsOf(W) || [], tun = T.filter(function(t){ return t.kind === "tunnel"; })[0], cut = T.filter(function(t){ return t.kind === "cutting"; })[0];
  return J({tunnel: tun ? mid(tun) : null, cutting: cut ? mid(cut) : null});
};
})();
