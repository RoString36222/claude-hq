#!/usr/bin/env python3
"""Pack Quaternius "Ultimate Modular" characters (CC0) for games/people/: glTF with an embedded base64 buffer ->
compact GLB. Outfit files keep meshes + skin only (no animations); one extra file keeps only the animations (with
the skeleton nodes they target), shared by every outfit since all six use the same rig and bone names.
Stdlib only.  usage: tools/pack_people.py <src_dir> <out_dir>"""
import base64, json, struct, sys, os

OUTFITS = [("W_Casual", "woman-casual"), ("M_Hoodie", "man-hoodie"), ("W_Adventurer", "woman-adventurer"),
           ("M_Adventurer", "man-adventurer"), ("W_Worker", "woman-worker"), ("M_Casual2", "man-casual")]

def load(path):
    g = json.load(open(path))
    uri = g["buffers"][0]["uri"]
    return g, base64.b64decode(uri.split(",", 1)[1])

def compact(g, blob, keep_anims, keep_meshes):
    g = json.loads(json.dumps(g))
    if not keep_anims:
        g.pop("animations", None)
    if not keep_meshes:
        for n in g["nodes"]:
            n.pop("mesh", None); n.pop("skin", None)
        g.pop("meshes", None); g.pop("skins", None); g.pop("materials", None)
        g.pop("textures", None); g.pop("images", None); g.pop("samplers", None)
    used = set()
    for m in g.get("meshes", []):
        for p in m["primitives"]:
            used.update(p["attributes"].values())
            if "indices" in p: used.add(p["indices"])
            for t in p.get("targets", []): used.update(t.values())
    for s in g.get("skins", []):
        if "inverseBindMatrices" in s: used.add(s["inverseBindMatrices"])
    for a in g.get("animations", []):
        for sm in a["samplers"]: used.update([sm["input"], sm["output"]])
    used = sorted(used)
    remap = {old: new for new, old in enumerate(used)}
    out, views, accs = bytearray(), [], []
    for old in used:
        a = dict(g["accessors"][old]); v = g["bufferViews"][a["bufferView"]]
        start = v.get("byteOffset", 0) + a.get("byteOffset", 0)
        comp = {5120: 1, 5121: 1, 5122: 2, 5123: 2, 5125: 4, 5126: 4}[a["componentType"]]
        ncomp = {"SCALAR": 1, "VEC2": 2, "VEC3": 3, "VEC4": 4, "MAT4": 16}[a["type"]]
        size = comp * ncomp
        stride = v.get("byteStride", size)
        data = b"".join(blob[start + i * stride: start + i * stride + size] for i in range(a["count"]))
        while len(out) % 4: out.append(0)
        nv = {"buffer": 0, "byteOffset": len(out), "byteLength": len(data)}
        if "target" in v: nv["target"] = v["target"]
        out += data; views.append(nv)
        a["bufferView"] = len(views) - 1; a.pop("byteOffset", None); accs.append(a)
    for m in g.get("meshes", []):
        for p in m["primitives"]:
            p["attributes"] = {k: remap[v] for k, v in p["attributes"].items()}
            if "indices" in p: p["indices"] = remap[p["indices"]]
            if "targets" in p: p["targets"] = [{k: remap[v] for k, v in t.items()} for t in p["targets"]]
    for s in g.get("skins", []):
        if "inverseBindMatrices" in s: s["inverseBindMatrices"] = remap[s["inverseBindMatrices"]]
    for a in g.get("animations", []):
        for sm in a["samplers"]: sm["input"] = remap[sm["input"]]; sm["output"] = remap[sm["output"]]
    g["accessors"], g["bufferViews"] = accs, views
    g["buffers"] = [{"byteLength": len(out)}]
    return g, bytes(out)

def write_glb(path, g, blob):
    js = json.dumps(g, separators=(",", ":")).encode()
    js += b" " * ((4 - len(js) % 4) % 4)
    blob += b"\0" * ((4 - len(blob) % 4) % 4)
    total = 12 + 8 + len(js) + 8 + len(blob)
    with open(path, "wb") as f:
        f.write(struct.pack("<III", 0x46546C67, 2, total))
        f.write(struct.pack("<II", len(js), 0x4E4F534A)); f.write(js)
        f.write(struct.pack("<II", len(blob), 0x004E4942)); f.write(blob)

def main(src, dst):
    os.makedirs(dst, exist_ok=True)
    for name, out in OUTFITS:
        g, b = load(os.path.join(src, name + ".gltf"))
        cg, cb = compact(g, b, keep_anims=False, keep_meshes=True)
        write_glb(os.path.join(dst, out + ".glb"), cg, cb)
    g, b = load(os.path.join(src, OUTFITS[0][0] + ".gltf"))
    cg, cb = compact(g, b, keep_anims=True, keep_meshes=False)
    write_glb(os.path.join(dst, "anims.glb"), cg, cb)

if __name__ == "__main__":
    main(sys.argv[1], sys.argv[2])
