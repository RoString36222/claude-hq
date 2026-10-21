#!/usr/bin/env python3
"""Find, download and import 3D models of the catalogue's real vehicles (docs/plans/dealership-spec.md).

    python3 tools/vehicle_fetch.py search [--out DIR] [--only ID,ID]
        Search Sketchfab for every vehicle (no token needed), keep only licence-clean downloadable models,
        rank them, and write DIR/candidates.json + DIR/candidates.md (default DIR: ./vehicle-candidates).
    SKETCHFAB_TOKEN=... python3 tools/vehicle_fetch.py download --pick ID=UID [--pick ...] [--best]
        Download the chosen model (or each vehicle's best candidate with --best), normalise it with
        tools/vehicle_import.mjs (scale, +z forward, ground origin, named wheels, < 15k triangles, meshopt)
        to games/vehicles/<id>.glb, and fill its model3d entry (file, licence, author, source) in
        games/hqvehicles.json.

Sources. Sketchfab's Data API v3 is the only one with real-brand models that can be searched and fetched by
script: search is public, DOWNLOAD needs a (free) account's API token (Authorization: Token <key>), read from
SKETCHFAB_TOKEN and never written anywhere. Poly Pizza (CC0/CC-BY low poly) needs an API key even to search
and has generic cars, not branded ones, so it is not used.

Licences kept: CC0, CC-BY and CC-BY-SA. Each lets us modify (decimate, recolour) and ship the model with
credit; BY-SA only makes the converted .glb itself BY-SA (the game's code is not a derivative of it). Dropped:
NonCommercial and NoDerivs (we modify, and a licence must not hang on how the game is used), Sketchfab's
Standard/Free Standard/Editorial (no redistribution of the file in a public repo). Models named after game rips
(NFS, GTA, Forza...) are dropped too: their uploader's licence is not theirs to give.

Pure parts (licence_ok, score, rank, plan_transform) are tested by tests/test_vehicle_fetch.py without network.
"""
import argparse
import json
import math
import os
import re
import subprocess
import sys
import time
import urllib.parse
import urllib.request

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
CATALOGUE = os.path.join(ROOT, "games", "hqvehicles.json")
OUT_DIR = os.path.join(ROOT, "games", "vehicles")
API = "https://api.sketchfab.com/v3"
LICENCES = {"cc0": "CC0-1.0", "by": "CC-BY-4.0", "by-sa": "CC-BY-SA-4.0"}   # Sketchfab slug -> SPDX
LICENCE_BY_LABEL = {"CC0 Public Domain": "cc0", "CC Attribution": "by", "CC Attribution-ShareAlike": "by-sa"}
RIP = re.compile(r"\b(nfs|need for speed|gta|forza|gran turismo|assetto|ripped|rip|asphalt|midnight club|"
                 r"burnout|the crew|roblox|minecraft|gt7|gt sport|car parking multiplayer|beamng|euro truck)\b", re.I)
PACK = re.compile(r"\b(pack|collection|bundle|set of|kit)\b", re.I)
FACES_GOOD, FACES_MAX = 50_000, 400_000      # prefer under 50k (we decimate to 15k); never fetch over 400k
TRI_BUDGET = 15_000

# The spec's grid (docs/plans/dealership-spec.md), used when games/hqvehicles.json is not there yet.
# gen: the generation code a match should carry; length: metres, nose to tail.
SPEC_GRID = [
    ("ktm-390-duke", "bike", "KTM", "390 Duke", "2024", 2.00, ["ktm 390 duke", "390 duke"]),
    ("bmw-g-310-r", "bike", "BMW", "G 310 R", "", 2.00, ["bmw g310r", "bmw g 310 r", "bmw g 310"]),
    ("ktm-990-duke", "bike", "KTM", "990 Duke", "2024", 2.10, ["ktm 990 duke", "ktm duke 990", "ktm duke"]),
    ("bmw-f-900-r", "bike", "BMW", "F 900 R", "", 2.14, ["bmw f900r", "bmw f 900 r", "bmw f 900"]),
    ("ktm-1390-super-duke-r", "bike", "KTM", "1390 Super Duke R", "", 2.20,
     ["ktm 1390 super duke", "ktm super duke", "ktm 1290 super duke"]),
    ("bmw-s-1000-r", "bike", "BMW", "S 1000 R", "", 2.09, ["bmw s1000r", "bmw s 1000 r", "bmw s1000"]),
    ("bmw-g-310-rr", "bike", "BMW", "G 310 RR", "", 2.00, ["bmw g310rr", "bmw g 310 rr"]),
    ("bmw-s-1000-rr", "bike", "BMW", "S 1000 RR", "", 2.07, ["bmw s1000rr", "bmw s 1000 rr"]),
    ("bmw-m-1000-rr", "bike", "BMW", "M 1000 RR", "", 2.07, ["bmw m1000rr", "bmw m 1000 rr"]),
    ("bmw-g-310-gs", "bike", "BMW", "G 310 GS", "", 2.08, ["bmw g310gs", "bmw g 310 gs"]),
    ("bmw-r-1300-gs", "bike", "BMW", "R 1300 GS", "", 2.21, ["bmw r1300gs", "bmw r 1300 gs", "bmw r1250gs", "bmw r 1200 gs", "bmw gs"]),
    ("ktm-rc-390", "bike", "KTM", "RC 390", "", 1.98, ["ktm rc 390", "ktm rc390"]),
    ("ktm-390-adventure", "bike", "KTM", "390 Adventure", "", 2.15, ["ktm 390 adventure", "ktm adventure"]),
    ("ktm-1390-super-adventure", "bike", "KTM", "1390 Super Adventure", "", 2.30,
     ["ktm 1390 super adventure", "ktm 1290 super adventure", "ktm adventure"]),
    ("bmw-m135", "car", "BMW", "M135 xDrive", "F70", 4.36, ["bmw m135", "bmw 1 series", "bmw m135i"]),
    ("bmw-330li", "car", "BMW", "330Li", "G28", 4.82, ["bmw 330li", "bmw 3 series g20", "bmw 330i"]),
    ("bmw-m3-competition", "car", "BMW", "M3 Competition", "G80", 4.79, ["bmw m3 g80", "bmw m3 competition"]),
    ("bmw-m340i", "car", "BMW", "M340i", "G20", 4.71, ["bmw m340i", "bmw 3 series g20"]),
    ("bmw-m5", "car", "BMW", "M5", "G90", 5.10, ["bmw m5 g90", "bmw m5 2025", "bmw m5"]),
    ("bmw-m2", "car", "BMW", "M2", "G87", 4.58, ["bmw m2 g87", "bmw m2 2023", "bmw m2"]),
    ("bmw-m4-csl", "car", "BMW", "M4 CSL", "G82", 4.80, ["bmw m4 csl", "bmw m4 g82", "bmw m4"]),
    ("bmw-x5-40i", "car", "BMW", "X5 xDrive40i", "G05", 4.92, ["bmw x5 g05", "bmw x5"]),
    ("bmw-x3-m50", "car", "BMW", "X3 M50", "G45", 4.76, ["bmw x3 m50", "bmw x3 g45", "bmw x3"]),
    ("bmw-x5-m-competition", "car", "BMW", "X5 M Competition", "F95", 4.94, ["bmw x5 m f95", "bmw x5m"]),
    ("bmw-xm", "car", "BMW", "XM", "G09", 5.11, ["bmw xm"]),
    ("bugatti-chiron-super-sport", "car", "Bugatti", "Chiron Super Sport", "", 4.61,
     ["bugatti chiron super sport", "bugatti chiron"]),
    ("bugatti-tourbillon", "car", "Bugatti", "Tourbillon", "", 4.67, ["bugatti tourbillon"]),
    ("bmw-i4-m50", "car", "BMW", "i4 M50", "G26", 4.79, ["bmw i4 m50", "bmw i4"]),
    ("bmw-i7-m70", "car", "BMW", "i7 M70", "G70", 5.39, ["bmw i7", "bmw 7 series g70"]),
    ("bugatti-veyron", "car", "Bugatti", "Veyron 16.4", "", 4.46, ["bugatti veyron"]),
]

# BMW chassis codes look like E46, F80, G80: a different one in a name means another generation.
CHASSIS = re.compile(r"\b([efgu]\d{2})\b", re.I)
YEAR = re.compile(r"\b(19[5-9]\d|20[0-4]\d)\b")


def norm(s):
    return re.sub(r"[^a-z0-9 ]+", " ", (s or "").lower().replace("-", " ")).split()


def compact(s):
    return re.sub(r"[^a-z0-9]+", "", (s or "").lower())


def vehicles():
    """[{id, kind, brand, model, gen, lengthM, queries}] from the catalogue, else the spec's grid."""
    if os.path.exists(CATALOGUE):
        with open(CATALOGUE, encoding="utf-8") as f:
            cat = json.load(f)
        out = []
        for v in cat.get("vehicles", []):
            m3 = v.get("model3d") or {}
            dims = v.get("dims") or {}
            length = m3.get("lengthM") or dims.get("lengthM") or (4.6 if str(v.get("class", "")).startswith("car") else 2.1)
            kind = "car" if str(v.get("class", "")).startswith("car") else "bike"
            gen = v.get("gen") or v.get("generation") or ""
            q = v.get("search") or [f"{v['brand']} {v['model']}".lower()]
            out.append({"id": v["id"], "kind": kind, "brand": v["brand"], "model": v["model"], "gen": gen,
                        "lengthM": float(length), "queries": q})
        if out:
            return out
    return [{"id": i, "kind": k, "brand": b, "model": m, "gen": g, "lengthM": L, "queries": q}
            for i, k, b, m, g, L, q in SPEC_GRID]


# ---------------------------------------------------------------- pure: licence and ranking --

def licence_ok(result):
    """The Sketchfab slug of a licence we may use ('cc0' | 'by' | 'by-sa'), else None."""
    lic = result.get("license") or {}
    slug = lic.get("slug") or LICENCE_BY_LABEL.get(lic.get("label", ""))
    if slug not in LICENCES:
        return None
    if not result.get("isDownloadable", True):
        return None
    return slug


def faces_of(result):
    a = (result.get("archives") or {}).get("glb") or (result.get("archives") or {}).get("gltf") or {}
    return a.get("faceCount") or result.get("faceCount") or 0


def textures_of(result):
    a = (result.get("archives") or {}).get("glb") or (result.get("archives") or {}).get("gltf") or {}
    return a.get("textureCount") or 0


def score(v, result):
    """How well a search result fits vehicle v (higher is better); None when it must not be used."""
    if not licence_ok(result):
        return None
    name = result.get("name") or ""
    text = name + " " + " ".join(t.get("name", "") if isinstance(t, dict) else str(t) for t in result.get("tags") or [])
    if RIP.search(name):
        return None
    faces = faces_of(result)
    if faces > FACES_MAX:
        return None
    words = set(norm(text))
    joined = compact(text)
    s = 0.0
    if v["brand"].lower() in words or compact(v["brand"]) in joined:
        s += 20
    else:
        s -= 25
    model_words = [w for w in norm(v["model"]) if w not in ("xdrive",)]
    hit = sum(1 for w in model_words if w in words or w in joined)
    s += 30 * hit / max(1, len(model_words))
    if compact(v["model"]) in joined:              # "S 1000 RR" written "s1000rr"
        s += 15
    gen = (v.get("gen") or "").lower()
    codes = {c.lower() for c in CHASSIS.findall(text)}
    years = {int(y) for y in YEAR.findall(text)}
    if gen and re.fullmatch(r"[efgu]\d{2}", gen):
        if gen in codes:
            s += 25
        elif codes:
            s -= 30                                 # another generation of the same car
    elif gen and re.fullmatch(r"\d{4}", gen) and years:
        s += 10 if any(abs(y - int(gen)) <= 1 for y in years) else -10
    if len(codes) >= 3 or PACK.search(name):
        s -= 25                                     # a multi-vehicle pack, not this vehicle
    if years and max(years) < 2010:
        s -= 15                                     # the spec's vehicles are all current models
    if v["kind"] == "bike" and words & {"car", "sedan", "coupe", "suv"}:
        s -= 20
    if v["kind"] == "car" and words & {"bike", "motorcycle", "motorbike"}:
        s -= 20
    # size: under 50k faces is what we want; heavier is fine (we decimate) but worse, a few hundred is a toy
    if faces <= 0:
        s -= 5
    elif faces <= FACES_GOOD:
        s += 10
    else:
        s += 10 - 10 * math.log2(faces / FACES_GOOD)
    if faces and faces < 1500:
        s -= 10
    if textures_of(result):
        s += 5
    s += min(5.0, math.log10(1 + (result.get("likeCount") or 0)))
    if "low poly" in name.lower() or "lowpoly" in joined:
        s += 3
    return round(s, 2)


def rank(v, results, keep=5):
    """The best `keep` usable results for v, deduplicated by uid, best first: [(score, result)]."""
    seen, out = set(), []
    for r in results:
        uid = r.get("uid")
        if not uid or uid in seen:
            continue
        seen.add(uid)
        sc = score(v, r)
        if sc is not None:
            out.append((sc, r))
    out.sort(key=lambda t: (-t[0], faces_of(t[1]) or 1e9))
    return out[:keep]


def candidate(sc, r):
    thumbs = sorted((r.get("thumbnails") or {}).get("images") or [], key=lambda i: abs((i.get("width") or 0) - 720))
    slug = licence_ok(r)
    return {"uid": r["uid"], "score": sc, "name": r.get("name"), "licence": LICENCES[slug], "licenceSlug": slug,
            "author": ((r.get("user") or {}).get("displayName") or (r.get("user") or {}).get("username")),
            "authorUrl": (r.get("user") or {}).get("profileUrl"),
            "source": r.get("viewerUrl"), "faces": faces_of(r), "textures": textures_of(r),
            "thumbnail": thumbs[0]["url"] if thumbs else None}


# ---------------------------------------------------------------- pure: normalisation --

def plan_transform(bbox, length_m, kind, flip=False):
    """The similarity transform that puts a model in the City's frame.

    bbox: {min: [x, y, z], max: [x, y, z]} in the model's units, y up (glTF). The long horizontal axis is the
    vehicle's length; it becomes +z (forward; flip=True when the source faces the other way). The model is scaled
    so its length is length_m, centred on x/z, and stood on y = 0. Returns {scale, rotY (radians), offset [x, y, z]}
    applied as: p' = rotY(p * scale) + offset.
    """
    mn, mx = bbox["min"], bbox["max"]
    dx, dz = mx[0] - mn[0], mx[2] - mn[2]
    if dx <= 0 and dz <= 0:
        raise ValueError("empty bounding box")
    along_x = dx > dz
    L = dx if along_x else dz
    scale = length_m / L
    rot = (-math.pi / 2 if along_x else 0.0) + (math.pi if flip else 0.0)
    cx, cy0, cz = (mn[0] + mx[0]) / 2 * scale, mn[1] * scale, (mn[2] + mx[2]) / 2 * scale
    c, s = math.cos(rot), math.sin(rot)
    # rotation about y: x' = x c + z s, z' = -x s + z c (three.js / glTF right-handed)
    ox, oz = -(cx * c + cz * s), -(-cx * s + cz * c)
    return {"scale": scale, "rotY": rot, "offset": [ox, -cy0, oz]}


def apply(t, p):
    x, y, z = (q * t["scale"] for q in p)
    c, s = math.cos(t["rotY"]), math.sin(t["rotY"])
    return [x * c + z * s + t["offset"][0], y + t["offset"][1], -x * s + z * c + t["offset"][2]]


def decimate_ratio(faces, budget=TRI_BUDGET):
    """The meshopt simplify ratio that brings `faces` triangles under the budget (1 = keep all)."""
    if faces <= budget:
        return 1.0
    return max(0.01, round(budget / faces * 0.95, 4))


# ---------------------------------------------------------------- network --

def get_json(url, token=None, tries=3):
    req = urllib.request.Request(url, headers={"User-Agent": "claude-hq-vehicle-fetch/1"})
    if token:
        req.add_header("Authorization", "Token " + token)
    for i in range(tries):
        try:
            with urllib.request.urlopen(req, timeout=30) as r:
                return json.load(r)
        except urllib.error.HTTPError as e:
            if e.code == 429 and i + 1 < tries:
                time.sleep(5 * (i + 1))
                continue
            raise
    return None


def search(q, pages=2):
    out, url = [], f"{API}/search?" + urllib.parse.urlencode({
        "type": "models", "q": q, "downloadable": "true", "max_face_count": FACES_MAX,
        "count": 24, "sort_by": "-likeCount"})
    for _ in range(pages):
        d = get_json(url)
        if not d:
            break
        out += d.get("results") or []
        url = d.get("next")
        if not url:
            break
        time.sleep(0.4)
    return out


def cmd_search(a):
    os.makedirs(a.out, exist_ok=True)
    only = set(a.only.split(",")) if a.only else None
    report = []
    for v in vehicles():
        if only and v["id"] not in only:
            continue
        results = []
        for q in v["queries"]:
            try:
                results += search(q)
            except Exception as e:                    # one failed query does not lose the rest
                print(f"  ! {v['id']}: {q}: {e}", file=sys.stderr)
            time.sleep(0.4)
        best = [candidate(sc, r) for sc, r in rank(v, results)]
        report.append({"id": v["id"], "brand": v["brand"], "model": v["model"], "gen": v.get("gen"),
                       "searched": len(results), "candidates": best})
        b = best[0] if best else None
        print(f"{v['id']:28s} {('%s %s %dk faces score %s' % (b['licence'], b['name'][:40], b['faces'] // 1000, b['score'])) if b else 'none found'}")
    with open(os.path.join(a.out, "candidates.json"), "w", encoding="utf-8") as f:
        json.dump(report, f, indent=1)
    with open(os.path.join(a.out, "candidates.md"), "w", encoding="utf-8") as f:
        f.write("# Vehicle model candidates (Sketchfab, CC0 / CC-BY / CC-BY-SA, downloadable)\n\n")
        f.write("| vehicle | # | score | model | licence | author | faces | tex | thumbnail |\n|---|---|---|---|---|---|---|---|---|\n")
        for e in report:
            if not e["candidates"]:
                f.write(f"| {e['brand']} {e['model']} | - | - | none found | | | | | |\n")
            for i, c in enumerate(e["candidates"]):
                f.write(f"| {e['brand']} {e['model'] if i == 0 else ''} | {i + 1} | {c['score']} | [{c['name']}]({c['source']}) | "
                        f"{c['licence']} | {c['author']} | {c['faces']} | {c['textures']} | ![]({c['thumbnail']}) |\n")
    print(f"wrote {a.out}/candidates.json and candidates.md")


def cmd_download(a):
    token = os.environ.get("SKETCHFAB_TOKEN")
    if not token:
        sys.exit("SKETCHFAB_TOKEN is not set (a free Sketchfab account: Settings -> Password & API -> API token)")
    picks = dict(p.split("=", 1) for p in a.pick or [])
    if a.best:
        with open(os.path.join(a.out, "candidates.json"), encoding="utf-8") as f:
            for e in json.load(f):
                if e["candidates"] and e["id"] not in picks:
                    picks[e["id"]] = e["candidates"][0]["uid"]
    vs = {v["id"]: v for v in vehicles()}
    os.makedirs(OUT_DIR, exist_ok=True)
    for vid, uid in picks.items():
        v = vs.get(vid)
        if not v:
            print(f"  ! unknown vehicle {vid}"); continue
        meta = get_json(f"{API}/models/{uid}")
        slug = licence_ok(meta)
        if not slug:
            print(f"  ! {vid}: {uid} is not CC0/CC-BY/CC-BY-SA downloadable; skipped"); continue
        links = get_json(f"{API}/models/{uid}/download", token=token)
        url = (links.get("glb") or {}).get("url")
        if not url:
            print(f"  ! {vid}: no glb archive"); continue
        raw = os.path.join(a.out, f"{vid}.source.glb")
        urllib.request.urlretrieve(url, raw)            # a signed, expiring URL: no token in it
        dst = os.path.join(OUT_DIR, f"{vid}.glb")
        try:
            info = import_model(raw, dst, v, flip=vid in set((a.flip or "").split(",")))
        except RuntimeError as e:
            print(f"  ! {vid}: import failed: {e}"); continue
        record = {"file": f"vehicles/{vid}.glb", "licence": LICENCES[slug],
                  "author": (meta.get("user") or {}).get("displayName") or (meta.get("user") or {}).get("username"),
                  "source": meta.get("viewerUrl"), "lengthM": v["lengthM"],
                  "paintMaterial": info.get("paintMaterial"), "wheels": info.get("wheels"), "tris": info.get("tris")}
        fill_catalogue(vid, record)
        print(f"{vid}: {record['licence']} by {record['author']} -> {dst} ({info.get('tris')} tris, {info.get('bytes')} bytes)")


def node_json(*argv):
    r = subprocess.run(["node", os.path.join(ROOT, "tools", "vehicle_import.mjs"), *argv], capture_output=True, text=True)
    if r.returncode:
        raise RuntimeError(r.stderr[-800:])
    return json.loads(r.stdout.strip().splitlines()[-1])


def import_model(src, dst, v, flip=False):
    """Measure src, plan its transform here (tested maths), then let vehicle_import.mjs apply it."""
    m = node_json(src, "--bbox")
    plan = plan_transform(m["bbox"], v["lengthM"], v["kind"], flip=flip)
    plan["ratio"] = decimate_ratio(m["tris"])
    os.makedirs(os.path.dirname(dst), exist_ok=True)
    return node_json(src, dst, "--plan", json.dumps(plan), "--kind", v["kind"], "--budget", str(TRI_BUDGET))


def fill_catalogue(vid, record):
    """Write model3d into games/hqvehicles.json (only when the catalogue exists and lists the vehicle)."""
    if not os.path.exists(CATALOGUE):
        print(f"  (no {CATALOGUE}: model3d for {vid} not recorded)")
        return
    with open(CATALOGUE, encoding="utf-8") as f:
        cat = json.load(f)
    for v in cat.get("vehicles", []):
        if v["id"] == vid:
            v["model3d"] = {**(v.get("model3d") or {}), **record}
    with open(CATALOGUE, "w", encoding="utf-8") as f:
        json.dump(cat, f, indent=2, ensure_ascii=False)
        f.write("\n")


def cmd_import(a):
    v = {x["id"]: x for x in vehicles()}.get(a.vehicle)
    if not v:
        sys.exit(f"unknown vehicle {a.vehicle}")
    dst = a.dst or os.path.join(OUT_DIR, f"{a.vehicle}.glb")
    print(json.dumps(import_model(a.src, dst, v, flip=a.flip)))


def main():
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    sub = ap.add_subparsers(dest="cmd", required=True)
    s = sub.add_parser("search")
    s.add_argument("--out", default="vehicle-candidates")
    s.add_argument("--only")
    d = sub.add_parser("download")
    d.add_argument("--out", default="vehicle-candidates")
    d.add_argument("--pick", action="append", help="VEHICLE_ID=SKETCHFAB_UID")
    d.add_argument("--best", action="store_true", help="each vehicle's top candidate from candidates.json")
    d.add_argument("--flip", help="comma-separated vehicle ids whose source model faces backwards")
    i = sub.add_parser("import", help="normalise a local .glb (a model obtained by hand) for one vehicle")
    i.add_argument("vehicle")
    i.add_argument("src")
    i.add_argument("--dst")
    i.add_argument("--flip", action="store_true")
    a = ap.parse_args()
    {"search": cmd_search, "download": cmd_download, "import": cmd_import}[a.cmd](a)


if __name__ == "__main__":
    main()
