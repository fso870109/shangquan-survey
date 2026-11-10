#!/usr/bin/env python3
"""Precompute walk-circle stats on a ~250m grid for the 點位預判器."""
from __future__ import annotations

import json
import math
import time
from pathlib import Path

import numpy as np
from pyproj import Geod
from shapely.geometry import Point, Polygon, mapping, shape
from shapely.strtree import STRtree

ROOT = Path("/workspace/shangquan")
DATA = ROOT / "data"
RAW = Path("/tmp/sq-raw")
GEOD = Geod(ellps="WGS84")

COUNTIES = ["taipei", "newtaipei", "taoyuan", "hsinchu_city", "hsinchu_county"]
SPACING = 250.0
RADII = (300, 500, 800)
MIN_POP_500 = 80
NULL_CH = -32768
CIRCLE_STEPS = 64


def poly_area(geom):
    if geom is None or geom.is_empty:
        return 0.0
    if geom.geom_type == "Polygon":
        a, _ = GEOD.geometry_area_perimeter(geom)
        return abs(a)
    if geom.geom_type == "MultiPolygon":
        return sum(poly_area(g) for g in geom.geoms)
    return 0.0


def geodesic_circle(lng, lat, radius_m, steps=CIRCLE_STEPS):
    coords = []
    for i in range(steps):
        az = 360.0 * i / steps
        elng, elat, _ = GEOD.fwd(lng, lat, az, radius_m)
        coords.append((elng, elat))
    coords.append(coords[0])
    return Polygon(coords)


def load_all():
    vills = []
    stores = []
    county_meta = []
    all_districts = []
    for cid in COUNTIES:
        d = json.loads((DATA / f"{cid}.json").read_text())
        county_meta.append({
            "id": cid,
            "name": d["name"],
            "bbox": d["bbox"],
            "districtNames": [x["name"] for x in d["districts"]],
        })
        for dist in d["districts"]:
            rec = {k: dist[k] for k in dist}
            rec["cid"] = cid
            rec["county"] = d["name"]
            all_districts.append(rec)
        for v in d["villages"]:
            g = shape(v["g"])
            if g.is_empty:
                continue
            if not g.is_valid:
                g = g.buffer(0)
            vills.append({
                "cid": cid,
                "county": d["name"],
                "name": v["name"],
                "district": v["district"],
                "pop": v["pop"],
                "hh": v["hh"],
                "popY1": v["popY1"],
                "popY5": v["popY5"],
                "age": v["age"],
                "g": g,
                "area_m2": poly_area(g) or (v["area"] * 1e6),
            })
        for s in d["stores"]:
            stores.append((s["lat"], s["lng"], s["b"]))
    return vills, stores, county_meta, all_districts


def write_districts(all_districts):
    dest = DATA / "districts.json"
    payload = {
        "counties": COUNTIES,
        "districts": all_districts,
    }
    dest.write_text(json.dumps(payload, ensure_ascii=False, separators=(",", ":")))
    print(f"wrote {dest.name} {dest.stat().st_size/1024:.0f} KB  n={len(all_districts)}", flush=True)


def haversine_m(lat, lng, lats, lngs):
    r = 6371000.0
    p1 = math.radians(lat)
    p2 = np.radians(lats)
    dp = np.radians(lats - lat)
    dl = np.radians(lngs - lng)
    a = np.sin(dp / 2) ** 2 + np.cos(p1) * np.cos(p2) * np.sin(dl / 2) ** 2
    return 2 * r * np.arcsin(np.sqrt(a))


def count_nearby(lat, lng, lats, lngs, extra, radii):
    """Return list[dict] of counts per radius. extra is brand codes or None for plain count."""
    if len(lats) == 0:
        return [{ "n": 0 } for _ in radii]
    max_r = max(radii)
    dlat = max_r / 110540.0 + 1e-4
    clat = math.cos(math.radians(lat)) or 1e-6
    dlng = max_r / (111320.0 * clat) + 1e-4
    mask = (np.abs(lats - lat) <= dlat) & (np.abs(lngs - lng) <= dlng)
    if not np.any(mask):
        base = {"n": 0}
        if extra is not None:
            base.update({"s711": 0, "fami": 0, "sbux": 0, "mcd": 0})
        return [dict(base) for _ in radii]
    slat = lats[mask]
    slng = lngs[mask]
    dist = haversine_m(lat, lng, slat, slng)
    out = []
    for r in radii:
        inside = dist <= r
        rec = {"n": int(np.count_nonzero(inside))}
        if extra is not None:
            br = extra[mask]
            rec["s711"] = int(np.count_nonzero(inside & (br == "s711")))
            rec["fami"] = int(np.count_nonzero(inside & (br == "fami")))
            rec["sbux"] = int(np.count_nonzero(inside & (br == "sbux")))
            rec["mcd"] = int(np.count_nonzero(inside & (br == "mcd")))
        out.append(rec)
    return out


def estimate_point(lat, lng, vills, tree, store_lat, store_lng, store_b, resto_lat, resto_lng):
    results = []
    # query once with largest circle
    big = geodesic_circle(lng, lat, max(RADII), CIRCLE_STEPS)
    cand_idx = [int(i) for i in tree.query(big)]
    store_counts = count_nearby(lat, lng, store_lat, store_lng, store_b, RADII)
    resto_counts = count_nearby(lat, lng, resto_lat, resto_lng, None, RADII)
    for ri, radius in enumerate(RADII):
        circle = geodesic_circle(lng, lat, radius, CIRCLE_STEPS) if radius != max(RADII) else big
        pop = hh = 0.0
        age = [0.0, 0.0, 0.0, 0.0, 0.0]
        popNowY1 = popY1 = popNowY5 = popY5 = 0.0
        for i in cand_idx:
            v = vills[i]
            g = v["g"]
            if not g.intersects(circle):
                continue
            if circle.contains(g):
                ratio = 1.0
            else:
                inter = g.intersection(circle)
                if inter.is_empty or v["area_m2"] <= 0:
                    continue
                ratio = min(1.0, poly_area(inter) / v["area_m2"])
            if ratio <= 0.002:
                continue
            pop += v["pop"] * ratio
            hh += v["hh"] * ratio
            for k in range(5):
                age[k] += v["age"][k] * ratio
            if v["popY1"] is not None:
                popNowY1 += v["pop"] * ratio
                popY1 += v["popY1"] * ratio
            if v["popY5"] is not None:
                popNowY5 += v["pop"] * ratio
                popY5 += v["popY5"] * ratio
        def ch_pct(now, old, total):
            if old > 0 and total > 0 and now / max(total, 1) >= 0.9:
                return int(round(1000.0 * (now - old) / old))  # percent * 10
            return NULL_CH
        sc = store_counts[ri]
        rec = [
            int(round(pop)),
            int(round(hh)),
            ch_pct(popNowY1, popY1, pop),
            ch_pct(popNowY5, popY5, pop),
            int(round(age[0])),
            int(round(age[1])),
            int(round(age[2])),
            int(round(age[3])),
            int(round(age[4])),
            sc["s711"],
            sc["fami"],
            sc["sbux"],
            sc["mcd"],
            resto_counts[ri]["n"],
        ]
        results.append(rec)
    return results


def generate_points(vills, tree):
    # region bbox from villages
    xs, ys = [], []
    for v in vills:
        minx, miny, maxx, maxy = v["g"].bounds
        xs += [minx, maxx]
        ys += [miny, maxy]
    minx, maxx = min(xs), max(xs)
    miny, maxy = min(ys), max(ys)
    dlat = SPACING / 110540.0
    points = []
    lat = miny + dlat * 0.5
    n_try = 0
    while lat <= maxy:
        dlng = SPACING / (111320.0 * max(0.2, math.cos(math.radians(lat))))
        lng = minx + dlng * 0.5
        while lng <= maxx:
            n_try += 1
            pt = Point(lng, lat)
            home = None
            for i in tree.query(pt):
                v = vills[int(i)]
                if v["g"].covers(pt):
                    home = v
                    break
            if home:
                points.append((round(lat, 6), round(lng, 6), home))
            lng += dlng
        lat += dlat
    print(f"grid candidates tried={n_try} inside villages={len(points)}", flush=True)
    return points


def main():
    t0 = time.time()
    print("loading county JSON...", flush=True)
    vills, stores, county_meta, all_districts = load_all()
    print(f"  villages={len(vills)} stores={len(stores)} districts={len(all_districts)}", flush=True)
    write_districts(all_districts)

    geoms = [v["g"] for v in vills]
    tree = STRtree(geoms)

    store_lat = np.array([s[0] for s in stores], dtype=np.float64)
    store_lng = np.array([s[1] for s in stores], dtype=np.float64)
    store_b = np.array([s[2] for s in stores])

    resto_path = RAW / "restaurants.json"
    if resto_path.exists():
        resto = json.loads(resto_path.read_text())["items"]
        resto_lat = np.array([r["lat"] for r in resto], dtype=np.float64)
        resto_lng = np.array([r["lng"] for r in resto], dtype=np.float64)
        print(f"  restaurants={len(resto)}", flush=True)
    else:
        resto_lat = np.zeros(0)
        resto_lng = np.zeros(0)
        print("  no restaurant file, rs will be 0", flush=True)

    # validate 中壢火車站
    lat0, lng0 = 24.953317, 121.22616
    chk = estimate_point(lat0, lng0, vills, tree, store_lat, store_lng, store_b, resto_lat, resto_lng)
    print("validate 中壢火車站 300/500/800 pop,hh:", [(r[0], r[1]) for r in chk], flush=True)

    print("generating grid points...", flush=True)
    points = generate_points(vills, tree)

    by_cid = {c: [] for c in COUNTIES}
    village_index = {c: {} for c in COUNTIES}
    district_index = {c: {} for c in COUNTIES}
    kept = skipped = 0
    t1 = time.time()
    for i, (lat, lng, home) in enumerate(points):
        recs = estimate_point(lat, lng, vills, tree, store_lat, store_lng, store_b, resto_lat, resto_lng)
        pop500 = recs[1][0]
        if pop500 < MIN_POP_500:
            skipped += 1
            continue
        cid = home["cid"]
        dmap = district_index[cid]
        vmap = village_index[cid]
        if home["district"] not in dmap:
            dmap[home["district"]] = len(dmap)
        if home["name"] not in vmap:
            vmap[home["name"]] = len(vmap)
        row = [
            int(round(lat * 1e5)),
            int(round(lng * 1e5)),
            dmap[home["district"]],
            vmap[home["name"]],
        ]
        for rec in recs:
            row.extend(rec)
        by_cid[cid].append(row)
        kept += 1
        if (i + 1) % 4000 == 0:
            elapsed = time.time() - t1
            rate = (i + 1) / max(elapsed, 0.01)
            eta = (len(points) - i - 1) / max(rate, 0.01)
            print(f"  {i+1}/{len(points)} kept={kept} skipped={skipped} {rate:.0f}/s eta={eta:.0f}s", flush=True)

    fields = ["pop", "hh", "y1", "y5", "a0", "a1", "a2", "a3", "a4", "s7", "sf", "ss", "sm", "rs"]
    index = {"spacingM": SPACING, "radii": list(RADII), "minPop500": MIN_POP_500, "files": {}}
    for cid in COUNTIES:
        cells = by_cid[cid]
        dnames = [None] * len(district_index[cid])
        for name, i in district_index[cid].items():
            dnames[i] = name
        vnames = [None] * len(village_index[cid])
        for name, i in village_index[cid].items():
            vnames[i] = name
        cname = next(c["name"] for c in county_meta if c["id"] == cid)
        payload = {
            "spacingM": SPACING,
            "radii": list(RADII),
            "cid": cid,
            "county": cname,
            "minPop500": MIN_POP_500,
            "fields": fields,
            "nullChange": NULL_CH,
            "districts": dnames,
            "villages": vnames,
            "n": len(cells),
            "cells": cells,
            "note": "步行圈為戶籍人口×（圓與村里相交面積／村里面積）之估算，非常住人口。y1/y5 為近1年／近5年變化百分比×10，-32768 代表資料不足。a0–a4 為 0–14／15–24／25–44／45–64／65+ 估計人數。s7/sf/ss/sm 為 7-ELEVEN／全家／星巴克／麥當勞家數。rs 為 OSM amenity=restaurant 節點數。",
        }
        dest = DATA / f"grid_{cid}.json"
        dest.write_text(json.dumps(payload, ensure_ascii=False, separators=(",", ":")))
        index["files"][cid] = {"file": f"data/grid_{cid}.json", "n": len(cells), "bytes": dest.stat().st_size}
        print(f"wrote {dest.name} {dest.stat().st_size/1024:.0f} KB cells={len(cells)}", flush=True)

    # vicinity check
    print("\n中壢火車站 vicinity cells (within ~200m), 500m pop:", flush=True)
    near = []
    for row in by_cid["taoyuan"]:
        lat = row[0] / 1e5
        lng = row[1] / 1e5
        dlat = (lat - lat0) * 110540
        dlng = (lng - lng0) * 111320 * math.cos(math.radians(lat0))
        dist = math.hypot(dlat, dlng)
        if dist <= 220:
            pop500 = row[4 + 14]  # header 4 + first radius 14 = start of 500
            near.append((dist, lat, lng, pop500, row[4 + 14 + 8]))  # a4? wait rec: pop,hh,y1,y5,a0.. so age65 is index 8 in rec → 4+14+8
    # cell layout: [lat_e5, lng_e5, di, vi, ...r300(14), ...r500(14), ...r800(14)]
    # r500 starts at 4+14=18: pop,hh,y1,y5,a0,a1,a2,a3,a4
    near = []
    for row in by_cid["taoyuan"]:
        lat = row[0] / 1e5
        lng = row[1] / 1e5
        dlat = (lat - lat0) * 110540
        dlng = (lng - lng0) * 111320 * math.cos(math.radians(lat0))
        dist = math.hypot(dlat, dlng)
        if dist <= 250:
            base = 4 + 14
            near.append((round(dist), lat, lng, row[base], row[base + 1], row[base + 8]))
    near.sort()
    for item in near[:12]:
        print(" ", item, flush=True)

    (DATA / "grid_index.json").write_text(json.dumps(index, ensure_ascii=False, indent=2))
    print(f"\ndone kept={kept} skipped_lowpop={skipped} elapsed={time.time()-t0:.1f}s", flush=True)


if __name__ == "__main__":
    main()
