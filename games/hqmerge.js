/* Claude HQ: static mesh merging for the 3D city (HQV.hqMerge).
 *
 * Every HQ is built from ~150-250 small meshes, one draw call each. mergeStatic folds the static,
 * opaque ones into one mesh per material key, so a building costs a handful of draws.
 *   mergeStatic(THREE, group, opts) -> {group, before, after}
 *     Merges static child meshes of `group` (opaque MeshStandard/MeshLambert/MeshBasic, single
 *     material, no other texture slot than `map`, no skinning/instancing/morphs) into one mesh per
 *     key (type+color+emissive+roughness+metalness+map, plus the flags that change how it draws).
 *     Left alone: anything opts.keep(mesh) returns true for, anything with userData.door/anim/fade
 *     (on the mesh, its material, or any ancestor up to the group, since a moving parent moves it),
 *     transparent or invisible meshes, meshes with children, and keys with only one mesh.
 *     Transforms are baked relative to the group, so the merged meshes sit at the group's origin
 *     and the group can still be moved as a whole. before/after are draw counts (visible meshes).
 *     Source geometries are not disposed: builders share them between meshes.
 *   mat(THREE, key, make) -> a material cached by key (make() runs once per key), so builders share
 *     materials instead of making one per mesh.
 * Pure apart from THREE (passed in), so tests/test_hqmerge.py runs it under node against the
 * vendored three.js.
 */
(function(){
"use strict";
var HQV = window.HQV = window.HQV || {};

var TYPES = {MeshStandardMaterial: 1, MeshLambertMaterial: 1, MeshBasicMaterial: 1};
// texture slots that make a material unmergeable (only `map` is carried over, via uv)
var SLOTS = ["lightMap", "aoMap", "emissiveMap", "bumpMap", "normalMap", "displacementMap", "roughnessMap",
             "metalnessMap", "alphaMap", "envMap", "specularMap"];
var CACHE = {};

function mat(THREE, key, make){
  key = String(key);
  return Object.prototype.hasOwnProperty.call(CACHE, key) ? CACHE[key] : (CACHE[key] = make(THREE));
}

function flagged(o){ var u = o && o.userData; return !!(u && (u.door || u.anim || u.fade)); }
function hex(c){ return c && c.getHexString ? c.getHexString() : "-"; }

// The material key, or null when this material cannot be merged.
function matKey(THREE, m){
  if(!m || Array.isArray(m) || !TYPES[m.type] || m.transparent || (m.opacity != null && m.opacity < 1) || m.visible === false) return null;
  if(flagged(m) || m.onBeforeCompile !== THREE.Material.prototype.onBeforeCompile) return null;
  for(var i = 0; i < SLOTS.length; i++) if(m[SLOTS[i]]) return null;
  return [m.type, hex(m.color), hex(m.emissive), m.emissiveIntensity != null ? m.emissiveIntensity : "-",
          m.roughness != null ? m.roughness : "-", m.metalness != null ? m.metalness : "-", m.map ? m.map.uuid : "-",
          m.side | 0, m.vertexColors ? 1 : 0, m.flatShading ? 1 : 0, m.fog === false ? 0 : 1,
          m.wireframe ? 1 : 0, m.alphaTest || 0].join("|");
}

// Is this mesh static and mergeable under `group`?
function mergeable(THREE, mesh, group, keep){
  if(!mesh.isMesh || mesh.isSkinnedMesh || mesh.isInstancedMesh || !mesh.visible || mesh.children.length) return false;
  var g = mesh.geometry;
  if(!g || !g.isBufferGeometry || !g.attributes.position) return false;
  if(g.morphAttributes && Object.keys(g.morphAttributes).length) return false;
  if(g.drawRange && (g.drawRange.start !== 0 || isFinite(g.drawRange.count))) return false;
  if(flagged(mesh) || (keep && keep(mesh))) return false;
  for(var p = mesh.parent; p && p !== group; p = p.parent) if(flagged(p) || !p.visible || (keep && keep(p))) return false;
  return true;
}

function drawCount(group){
  var n = 0;
  group.traverseVisible(function(o){
    if(!(o.isMesh || o.isSprite || o.isLine || o.isPoints)) return;
    n += Array.isArray(o.material) && o.geometry && o.geometry.groups.length ? o.geometry.groups.length : 1;
  });
  return n;
}

// One BufferGeometry from [{geo, matrix}], positions/normals baked by each matrix.
function mergeInto(THREE, items, wantUv, wantColor){
  var nv = 0, ni = 0, i, k;
  items.forEach(function(it){
    var g = it.geo, c = g.attributes.position.count;
    nv += c; ni += g.index ? g.index.count : c;
  });
  var pos = new Float32Array(nv*3), nor = new Float32Array(nv*3), uv = wantUv ? new Float32Array(nv*2) : null;
  var col = wantColor ? new Float32Array(nv*3) : null;
  var idx = nv > 65535 ? new Uint32Array(ni) : new Uint16Array(ni);
  var nm = new THREE.Matrix3(), v = new THREE.Vector3(), vo = 0, io = 0;
  items.forEach(function(it){
    var g = it.geo, m = it.matrix, P = g.attributes.position, N = g.attributes.normal, U = g.attributes.uv, C = g.attributes.color;
    if(!N){ g = g.clone(); g.computeVertexNormals(); N = g.attributes.normal; }
    nm.getNormalMatrix(m);
    var n = P.count, flip = m.determinant() < 0;
    for(i = 0; i < n; i++){
      v.set(P.getX(i), P.getY(i), P.getZ(i)).applyMatrix4(m);
      pos[(vo + i)*3] = v.x; pos[(vo + i)*3 + 1] = v.y; pos[(vo + i)*3 + 2] = v.z;
      v.set(N.getX(i), N.getY(i), N.getZ(i)).applyMatrix3(nm).normalize();
      nor[(vo + i)*3] = v.x; nor[(vo + i)*3 + 1] = v.y; nor[(vo + i)*3 + 2] = v.z;
      if(uv){ uv[(vo + i)*2] = U ? U.getX(i) : 0; uv[(vo + i)*2 + 1] = U ? U.getY(i) : 0; }
      if(col){ col[(vo + i)*3] = C ? C.getX(i) : 1; col[(vo + i)*3 + 1] = C ? C.getY(i) : 1; col[(vo + i)*3 + 2] = C ? C.getZ(i) : 1; }
    }
    var I = g.index, cnt = I ? I.count : n;
    for(k = 0; k < cnt; k += 3){
      var a = I ? I.getX(k) : k, b = I ? I.getX(k + 1) : k + 1, c = I ? I.getX(k + 2) : k + 2;
      idx[io + k] = vo + a;
      idx[io + k + 1] = vo + (flip ? c : b);   // a mirroring transform flips the winding back
      idx[io + k + 2] = vo + (flip ? b : c);
    }
    vo += n; io += cnt;
  });
  var out = new THREE.BufferGeometry();
  out.setAttribute("position", new THREE.BufferAttribute(pos, 3));
  out.setAttribute("normal", new THREE.BufferAttribute(nor, 3));
  if(uv) out.setAttribute("uv", new THREE.BufferAttribute(uv, 2));
  if(col) out.setAttribute("color", new THREE.BufferAttribute(col, 3));
  out.setIndex(new THREE.BufferAttribute(idx, 1));
  out.computeBoundingBox(); out.computeBoundingSphere();
  return out;
}

function mergeStatic(THREE, group, opts){
  opts = opts || {};
  var before = drawCount(group), buckets = {}, order = [];
  group.updateMatrixWorld(true);
  var inv = new THREE.Matrix4().copy(group.matrixWorld).invert();
  group.traverse(function(o){
    if(o === group || !mergeable(THREE, o, group, opts.keep)) return;
    var mk = matKey(THREE, o.material);
    if(mk == null) return;
    var key = mk+"#"+(o.castShadow ? 1 : 0)+(o.receiveShadow ? 1 : 0)+(o.frustumCulled ? 1 : 0)+"|"+(o.renderOrder | 0);
    if(!buckets[key]){ buckets[key] = []; order.push(key); }
    buckets[key].push(o);
  });
  order.forEach(function(key, n){
    var list = buckets[key];
    if(list.length < 2) return;
    var m0 = list[0], material = m0.material;
    var items = list.map(function(o){ return {geo: o.geometry, matrix: new THREE.Matrix4().multiplyMatrices(inv, o.matrixWorld)}; });
    var geo = mergeInto(THREE, items, !!material.map, !!material.vertexColors);
    var mesh = new THREE.Mesh(geo, material);
    mesh.name = "hqmerge:"+n;
    mesh.castShadow = m0.castShadow; mesh.receiveShadow = m0.receiveShadow;
    mesh.frustumCulled = m0.frustumCulled; mesh.renderOrder = m0.renderOrder;
    mesh.userData.merged = list.length;
    list.forEach(function(o){ if(o.parent) o.parent.remove(o); });
    group.add(mesh);
  });
  return {group: group, before: before, after: drawCount(group)};
}

HQV.hqMerge = {mergeStatic: mergeStatic, mat: mat, matKey: matKey, drawCount: drawCount};
})();
