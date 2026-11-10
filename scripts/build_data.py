#!/usr/bin/env python3
"""Build per-county JSON for 商圈調查小幫手 from official shapefile + RIS population + stores."""
from __future__ import annotations

import json
import math
from collections import defaultdict
from pathlib import Path

import shapefile
from pyproj import Geod
from shapely.geometry import mapping, shape
from shapely.ops import unary_union
from shapely.validation import make_valid

ROOT = Path("/workspace/shangquan")
OUT = ROOT / "data"
RAW = Path("/tmp/sq-raw")
SHP = RAW / "shp" / "VILLAGE_NLSC_1150817"
GEOD = Geod(ellps="WGS84")

COUNTIES = [
    {"id": "taipei", "name": "臺北市", "code": "63000", "center": [121.5654, 25.0375], "zoom": 12},
    {"id": "newtaipei", "name": "新北市", "code": "65000", "center": [121.4628, 25.0169], "zoom": 10},
    {"id": "taoyuan", "name": "桃園市", "code": "68000", "center": [121.2256, 24.9536], "zoom": 11},
    {"id": "hsinchu_city", "name": "新竹市", "code": "10018", "center": [120.9739, 24.8066], "zoom": 12},
    {"id": "hsinchu_county", "name": "新竹縣", "code": "10004", "center": [121.0177, 24.8397], "zoom": 11},
]
NAME2META = {c["name"]: c for c in COUNTIES}
YEARS = {"now": "11509", "y1": "11409", "y5": "11009"}
SIMPLIFY = 0.0002  # ~22 m
DIST_SIMPLIFY = 0.00035
BRANDS = ("s711", "fami", "sbux", "mcd")


def ni(v):
    try:
        return int(str(v).replace(",", "").strip() or 0)
    except ValueError:
        return 0


def geom_area_km2(geom):
    if geom is None or geom.is_empty:
        return 0.0
    if geom.geom_type == "Polygon":
        a, _ = GEOD.geometry_area_perimeter(geom)
        return abs(a) / 1e6
    if geom.geom_type == "MultiPolygon":
        return sum(geom_area_km2(g) for g in geom.geoms)
    return 0.0


def clean_geom(geom):
    if geom is None or geom.is_empty:
        return None
    if not geom.is_valid:
        try:
            geom = make_valid(geom)
        except Exception:
            geom = geom.buffer(0)
    if geom.geom_type == "GeometryCollection":
        parts = [g for g in geom.geoms if g.geom_type in ("Polygon", "MultiPolygon") and not g.is_empty]
        if not parts:
            return None
        geom = unary_union(parts)
    if geom.geom_type not in ("Polygon", "MultiPolygon") or geom.is_empty:
        return None
    return geom


def simplify(geom, tol):
    if geom is None:
        return None
    s = geom.simplify(tol, preserve_topology=True)
    s = clean_geom(s)
    return s if s is not None else geom


def round_coords(obj, nd=6):
    if isinstance(obj, (list, tuple)):
        if obj and isinstance(obj[0], (int, float)):
            return [round(float(obj[0]), nd), round(float(obj[1]), nd)]
        return [round_coords(x, nd) for x in obj]
    return obj


def geom_json(geom):
    if geom is None:
        return None
    m = mapping(geom)
    m["coordinates"] = round_coords(m["coordinates"])
    return m


def bbox_of(geom):
    minx, miny, maxx, maxy = geom.bounds
    return [round(minx, 6), round(miny, 6), round(maxx, 6), round(maxy, 6)]


def centroid_ll(geom):
    c = geom.representative_point()
    return [round(c.x, 6), round(c.y, 6)]


def parse_ages(row):
    """Return (age5 counts, pyramid_m 18, pyramid_f 18)."""
    age5 = [0, 0, 0, 0, 0]
    pm = [0] * 18
    pf = [0] * 18
    for age in range(0, 100):
        m = ni(row.get(f"people_age_{age:03d}_m"))
        f = ni(row.get(f"people_age_{age:03d}_f"))
        if age <= 14:
            age5[0] += m + f
        elif age <= 24:
            age5[1] += m + f
        elif age <= 44:
            age5[2] += m + f
        elif age <= 64:
            age5[3] += m + f
        else:
            age5[4] += m + f
        bin_i = min(age // 5, 17)  # 85+ in last
        pm[bin_i] += m
        pf[bin_i] += f
    m100 = ni(row.get("people_age_100up_m"))
    f100 = ni(row.get("people_age_100up_f"))
    age5[4] += m100 + f100
    pm[17] += m100
    pf[17] += f100
    return age5, pm, pf


def load_pop(year, county_name):
    path = RAW / "pop" / f"{year}_{county_name}.json"
    rows = json.loads(path.read_text())
    by_code = {}
    by_name = {}
    for row in rows:
        code = (row.get("district_code") or "").strip()
        site = (row.get("site_id") or "").strip()
        vill = (row.get("village") or "").strip()
        # skip district-level empty village if any
        if not vill:
            continue
        age5, pm, pf = parse_ages(row)
        rec = {
            "code": code,
            "site": site,
            "name": vill,
            "pop": ni(row.get("people_total")),
            "hh": ni(row.get("household_no")),
            "age": age5,
            "pm": pm,
            "pf": pf,
        }
        if code:
            by_code[code] = rec
        by_name[(site, vill)] = rec
    return by_code, by_name


def add_vec(a, b):
    for i, x in enumerate(b):
        a[i] += x


def shares(age, pop):
    if not pop:
        return [0, 0, 0, 0, 0]
    return [round(100.0 * x / pop, 2) for x in age]


def assign_store_county(store, district_geoms):
    """district_geoms: list of (county, district, geom) for point-in-polygon."""
    addr = store.get("address") or ""
    # normalize 台/臺
    naddr = addr.replace("台", "臺")
    for c in COUNTIES:
        if naddr.startswith(c["name"]) or addr.startswith(c["name"].replace("臺", "台")):
            store["county"] = c["name"]
            # try district from address
            rest = naddr[len(c["name"]):]
            return
    # point in polygon
    from shapely.geometry import Point
    pt = Point(store["lng"], store["lat"])
    for county, district, geom in district_geoms:
        if geom.covers(pt) or geom.intersects(pt.buffer(0.00001)):
            store["county"] = county
            store["district"] = store.get("district") or district
            return


def main():
    print("Loading population...", flush=True)
    pop = {}
    for c in COUNTIES:
        pop[c["name"]] = {}
        for key, year in YEARS.items():
            by_code, by_name = load_pop(year, c["name"])
            pop[c["name"]][key] = {"code": by_code, "name": by_name}
            print(f"  {year} {c['name']}: {len(by_code)} codes", flush=True)

    print("Loading stores/stations...", flush=True)
    raw_stores = json.loads((RAW / "stores_raw.json").read_text())
    all_stores = raw_stores["stores"]
    stations = raw_stores.get("stations") or []
    store_notes = raw_stores.get("notes") or {}
    print(f"  stores {len(all_stores)} stations {len(stations)}", flush=True)

    print("Reading shapefile...", flush=True)
    sf = shapefile.Reader(str(SHP))
    villages_by_county = defaultdict(list)
    unmatched_pop = defaultdict(int)
    matched = defaultdict(int)

    for sr in sf.iterShapeRecords():
        rec = sr.record.as_dict()
        cname = rec["COUNTYNAME"]
        if cname not in NAME2META:
            continue
        vname = (rec["VILLNAME"] or "").strip()
        if not vname:
            continue
        code = (rec["VILLCODE"] or "").strip()
        town = (rec["TOWNNAME"] or "").strip()
        geom = clean_geom(shape(sr.shape.__geo_interface__))
        if geom is None:
            print(f"  skip invalid geom {cname}{town}{vname}")
            continue
        area = round(geom_area_km2(geom), 6)
        simple = simplify(geom, SIMPLIFY)
        now_map = pop[cname]["now"]
        rec_now = now_map["code"].get(code) or now_map["name"].get((cname + town, vname))
        if not rec_now:
            unmatched_pop[cname] += 1
            rec_now = {"pop": 0, "hh": 0, "age": [0] * 5, "pm": [0] * 18, "pf": [0] * 18, "name": vname, "site": cname + town, "code": code}
        else:
            matched[cname] += 1

        def hist(which):
            m = pop[cname][which]
            r = m["code"].get(code) or m["name"].get((cname + town, vname))
            return r["pop"] if r else None

        villages_by_county[cname].append({
            "id": code,
            "name": vname,
            "district": town,
            "districtCode": (rec["TOWNCODE"] or "").strip(),
            "pop": rec_now["pop"],
            "hh": rec_now["hh"],
            "area": area,
            "popY1": hist("y1"),
            "popY5": hist("y5"),
            "age": rec_now["age"],
            "pm": rec_now["pm"],
            "pf": rec_now["pf"],
            "bbox": bbox_of(simple),
            "center": centroid_ll(simple),
            "_geom": simple,
            "_raw": geom,
        })

    for c in COUNTIES:
        print(f"  shp match {c['name']}: {matched[c['name']]} unmatched {unmatched_pop[c['name']]} villages {len(villages_by_county[c['name']])}", flush=True)

    # dissolve districts
    print("Dissolving districts...", flush=True)
    district_geoms_index = []  # for store assignment
    districts_by_county = {}
    for cname, vills in villages_by_county.items():
        groups = defaultdict(list)
        for v in vills:
            groups[(v["districtCode"], v["district"])].append(v)
        districts = []
        for (dcode, dname), vs in sorted(groups.items(), key=lambda x: x[0][1]):
            raws = [v["_raw"] for v in vs]
            union = clean_geom(unary_union(raws))
            if union is None:
                continue
            simple = simplify(union, DIST_SIMPLIFY)
            popn = sum(v["pop"] for v in vs)
            hh = sum(v["hh"] for v in vs)
            area = round(sum(v["area"] for v in vs), 6)
            age = [0] * 5
            pm = [0] * 18
            pf = [0] * 18
            for v in vs:
                add_vec(age, v["age"])
                add_vec(pm, v["pm"])
                add_vec(pf, v["pf"])
            y1s = [v["popY1"] for v in vs if v["popY1"] is not None]
            y5s = [v["popY5"] for v in vs if v["popY5"] is not None]
            # only report history if most villages matched
            popY1 = sum(y1s) if len(y1s) >= 0.9 * len(vs) else None
            popY5 = sum(y5s) if len(y5s) >= 0.9 * len(vs) else None
            districts.append({
                "code": dcode,
                "name": dname,
                "pop": popn,
                "hh": hh,
                "area": area,
                "density": round(popn / area, 1) if area else 0,
                "popY1": popY1,
                "popY5": popY5,
                "age": age,
                "pm": pm,
                "pf": pf,
                "bbox": bbox_of(simple),
                "center": centroid_ll(simple),
                "stores": {b: 0 for b in BRANDS},
                "geometry": geom_json(simple),
                "_geom": simple,
            })
            district_geoms_index.append((cname, dname, simple))
        districts_by_county[cname] = districts
        print(f"  {cname}: {len(districts)} districts", flush=True)

    # assign OSM stores to county/district via point-in-polygon
    print("Assigning stores to districts...", flush=True)
    from shapely.geometry import Point
    assigned = []
    skipped = 0
    for s in all_stores:
        if not s.get("county") or s["county"] not in NAME2META:
            pt = Point(s["lng"], s["lat"])
            hit = None
            # bbox prefilter omitted for simplicity; 70 districts is fine... wait we have ~70 districts
            for county, district, geom in district_geoms_index:
                minx, miny, maxx, maxy = geom.bounds
                if not (minx - 0.01 <= s["lng"] <= maxx + 0.01 and miny - 0.01 <= s["lat"] <= maxy + 0.01):
                    continue
                if geom.covers(pt):
                    hit = (county, district)
                    break
            if hit:
                s["county"], s["district"] = hit
            else:
                # address fallback
                naddr = (s.get("address") or "").replace("台", "臺")
                found = False
                for county, district, geom in district_geoms_index:
                    if county in naddr and district in naddr:
                        s["county"], s["district"] = county, district
                        found = True
                        break
                if not found:
                    skipped += 1
                    continue
        # increment district store count
        ds = districts_by_county.get(s["county"]) or []
        for d in ds:
            if d["name"] == s["district"]:
                d["stores"][s["brand"]] = d["stores"].get(s["brand"], 0) + 1
                break
        assigned.append(s)
    print(f"  assigned {len(assigned)} skipped {skipped}", flush=True)
    from collections import Counter
    print("  by brand", Counter(s["brand"] for s in assigned), flush=True)

    stores_by_county = defaultdict(list)
    for s in assigned:
        stores_by_county[s["county"]].append({
            "b": s["brand"],
            "n": s["name"],
            "lat": s["lat"],
            "lng": s["lng"],
            "a": s.get("address") or "",
            "d": s.get("district") or "",
        })

    # stations: assign county via PIP
    landmarks = []
    for st in stations:
        pt = Point(st["lng"], st["lat"])
        hit = None
        for county, district, geom in district_geoms_index:
            minx, miny, maxx, maxy = geom.bounds
            if not (minx <= st["lng"] <= maxx and miny <= st["lat"] <= maxy):
                continue
            if geom.covers(pt):
                hit = (county, district)
                break
        if not hit:
            continue
        landmarks.append({
            "name": st["name"],
            "nameRaw": st.get("nameRaw") or st["name"],
            "lat": st["lat"],
            "lng": st["lng"],
            "county": hit[0],
            "district": hit[1],
            "kind": "station",
        })
    print(f"  landmarks in scope {len(landmarks)}", flush=True)

    print("Writing county files...", flush=True)
    search_index = {"villages": [], "districts": [], "stores": [], "landmarks": []}
    county_summaries = []

    for c in COUNTIES:
        cname = c["name"]
        vills = villages_by_county[cname]
        dists = districts_by_county[cname]
        # county totals
        popn = sum(v["pop"] for v in vills)
        hh = sum(v["hh"] for v in vills)
        area = round(sum(v["area"] for v in vills), 4)
        age = [0] * 5
        pm = [0] * 18
        pf = [0] * 18
        for v in vills:
            add_vec(age, v["age"])
            add_vec(pm, v["pm"])
            add_vec(pf, v["pf"])
        y1s = [v["popY1"] for v in vills if v["popY1"] is not None]
        y5s = [v["popY5"] for v in vills if v["popY5"] is not None]
        popY1 = sum(y1s) if len(y1s) >= 0.9 * len(vills) else None
        popY5 = sum(y5s) if len(y5s) >= 0.9 * len(vills) else None
        xs, ys = [], []
        for v in vills:
            b = v["bbox"]
            xs += [b[0], b[2]]
            ys += [b[1], b[3]]
        bbox = [min(xs), min(ys), max(xs), max(ys)]
        out_vills = []
        for v in vills:
            out_vills.append({
                "id": v["id"],
                "name": v["name"],
                "district": v["district"],
                "dc": v["districtCode"],
                "pop": v["pop"],
                "hh": v["hh"],
                "area": v["area"],
                "popY1": v["popY1"],
                "popY5": v["popY5"],
                "age": v["age"],
                "pm": v["pm"],
                "pf": v["pf"],
                "bbox": v["bbox"],
                "center": v["center"],
                "g": geom_json(v["_geom"]),
            })
            search_index["villages"].append({
                "q": f"{cname}{v['district']}{v['name']}",
                "name": v["name"],
                "district": v["district"],
                "county": cname,
                "cid": c["id"],
                "lat": v["center"][1],
                "lng": v["center"][0],
            })
        out_dists = []
        for d in dists:
            dd = {k: d[k] for k in d if not k.startswith("_")}
            out_dists.append(dd)
            search_index["districts"].append({
                "q": f"{cname}{d['name']}",
                "name": d["name"],
                "county": cname,
                "cid": c["id"],
                "lat": d["center"][1],
                "lng": d["center"][0],
            })
        stores = stores_by_county.get(cname, [])
        for s in stores:
            search_index["stores"].append({
                "q": s["n"] + (s["a"] or ""),
                "name": s["n"],
                "brand": s["b"],
                "district": s["d"],
                "county": cname,
                "cid": c["id"],
                "lat": s["lat"],
                "lng": s["lng"],
            })
        payload = {
            "id": c["id"],
            "name": cname,
            "code": c["code"],
            "asOf": "2026-09",
            "asOfLabel": "民國115年9月",
            "history": {
                "y1": "2025-09",
                "y5": "2021-09",
                "y1Label": "民國114年9月",
                "y5Label": "民國110年9月",
            },
            "bbox": [round(x, 6) for x in bbox],
            "center": c["center"],
            "zoom": c["zoom"],
            "countyAvg": {
                "pop": popn,
                "hh": hh,
                "area": area,
                "density": round(popn / area, 1) if area else 0,
                "popY1": popY1,
                "popY5": popY5,
                "age": age,
                "ageShare": shares(age, popn),
                "pm": pm,
                "pf": pf,
            },
            "districts": out_dists,
            "villages": out_vills,
            "stores": stores,
        }
        dest = OUT / f"{c['id']}.json"
        dest.write_text(json.dumps(payload, ensure_ascii=False, separators=(",", ":")))
        size = dest.stat().st_size
        print(f"  wrote {dest.name} {size/1024:.0f} KB  vill={len(out_vills)} dist={len(out_dists)} stores={len(stores)} pop={popn}", flush=True)
        county_summaries.append({
            "id": c["id"],
            "name": cname,
            "code": c["code"],
            "file": f"data/{c['id']}.json",
            "center": c["center"],
            "zoom": c["zoom"],
            "bbox": payload["bbox"],
            "pop": popn,
            "districts": len(out_dists),
            "villages": len(out_vills),
            "stores": {b: sum(1 for s in stores if s["b"] == b) for b in BRANDS},
        })

    for lm in landmarks:
        cid = NAME2META[lm["county"]]["id"]
        aliases = [lm["name"], lm.get("nameRaw", "")]
        raw = lm.get("nameRaw") or lm["name"]
        if "火車站" not in raw:
            aliases.append(raw + "火車站")
        if "車站" not in raw:
            aliases.append(raw + "車站")
        search_index["landmarks"].append({
            "q": "".join(aliases),
            "name": lm["name"] if "站" in lm["name"] else raw + "車站",
            "county": lm["county"],
            "district": lm["district"],
            "cid": cid,
            "lat": lm["lat"],
            "lng": lm["lng"],
            "kind": "station",
        })

    meta = {
        "title": "商圈調查小幫手",
        "asOf": "2026-09",
        "asOfLabel": "民國115年9月",
        "scope": [c["name"] for c in COUNTIES],
        "counties": county_summaries,
        "defaultCounty": "taoyuan",
        "defaultCenter": {"name": "中壢火車站", "lat": 24.953317, "lng": 121.22616, "county": "桃園市", "cid": "taoyuan"},
        "brands": {
            "s711": {"name": "7-ELEVEN", "short": "7-11", "color": "#f97316"},
            "fami": {"name": "全家", "short": "全家", "color": "#16a34a"},
            "sbux": {"name": "星巴克", "short": "星巴克", "color": "#00704A"},
            "mcd": {"name": "麥當勞", "short": "麥當勞", "color": "#dc2626"},
        },
        "sources": [
            {
                "name": "村里戶數、單一年齡人口（新增區域代碼）",
                "org": "內政部戶政司",
                "url": "https://data.gov.tw/dataset/77132",
                "api": "https://www.ris.gov.tw/rs-opendata/api/v1/datastore/ODRP014/{yyyymm}",
                "dates": ["民國115年9月（現況）", "民國114年9月（近1年）", "民國110年9月（近5年）"],
                "note": "戶籍人口，非常住人口。",
            },
            {
                "name": "村里界圖（TWD97經緯度）VILLAGE_NLSC_1150817",
                "org": "內政部國土測繪中心",
                "url": "https://data.gov.tw/dataset/7438",
                "date": "2026-08-17",
                "note": "面積以 WGS84 橢球面積分計算；網頁繪製時對多邊形做了約 20 公尺簡化。",
            },
            {
                "name": "7-ELEVEN 門市",
                "org": "統一超商官方電子地圖 EMapSDK",
                "url": "https://emap.pcsc.com.tw/",
                "date": store_notes.get("s711", "2026-11-10"),
            },
            {
                "name": "全家、星巴克、麥當勞門市與車站",
                "org": "OpenStreetMap 貢獻者（Overpass API）",
                "url": "https://www.openstreetmap.org/copyright",
                "date": "2026-11-10",
                "note": "全家官方門市 API 目前無法取得，改以 OSM 標註；覆蓋率可能低於實際家數。",
            },
            {
                "name": "底圖",
                "org": "內政部國土測繪中心臺灣通用電子地圖（EMAP WMTS）",
                "url": "https://maps.nlsc.gov.tw/",
            },
        ],
        "method": "步行圈人口＝各村里戶籍人口 ×（圓與村里多邊形相交面積／村里面積）。人口密度＝估計人口／圓面積（πr²）。縣市平均以該縣市全部村里加總計算。",
    }
    (OUT / "meta.json").write_text(json.dumps(meta, ensure_ascii=False, indent=2))
    (OUT / "search.json").write_text(json.dumps(search_index, ensure_ascii=False, separators=(",", ":")))
    print(f"Wrote meta + search ({(OUT/'search.json').stat().st_size/1024:.0f} KB)", flush=True)
    print("DONE", flush=True)


if __name__ == "__main__":
    main()
