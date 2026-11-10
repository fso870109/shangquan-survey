#!/usr/bin/env python3
"""Fetch chain-store locations and railway stations for northern Taiwan."""
from __future__ import annotations

import json
import time
import urllib.error
import urllib.parse
import urllib.request
import xml.etree.ElementTree as ET
from pathlib import Path

OUT = Path("/tmp/sq-raw/stores_raw.json")
UA = "ShangquanSurvey/1.0 (research; public store locator)"

COUNTIES = ["臺北市", "新北市", "桃園市", "新竹市", "新竹縣"]
CITY_ALIAS = {"臺北市": ["台北市", "臺北市"], "新北市": ["新北市"], "桃園市": ["桃園市"],
              "新竹市": ["新竹市"], "新竹縣": ["新竹縣"]}

# districts from shapefile
import shapefile

def districts_from_shp():
    sf = shapefile.Reader("/tmp/sq-raw/shp/VILLAGE_NLSC_1150817")
    d = {c: set() for c in COUNTIES}
    for rec in sf.iterRecords():
        r = rec.as_dict()
        c = r["COUNTYNAME"]
        if c in d and r["TOWNNAME"]:
            d[c].add(r["TOWNNAME"])
    return {c: sorted(v) for c, v in d.items()}


def http_get(url, headers=None, timeout=45):
    h = {"User-Agent": UA}
    if headers:
        h.update(headers)
    req = urllib.request.Request(url, headers=h)
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        return resp.read()


def fetch_711(districts):
    stores = []
    seen = set()
    for county, towns in districts.items():
        city_names = CITY_ALIAS[county]
        for town in towns:
            xml_bytes = None
            used_city = None
            for city in city_names:
                qs = urllib.parse.urlencode({"commandid": "SearchStore", "city": city, "town": town})
                url = f"https://emap.pcsc.com.tw/EMapSDK.aspx?{qs}"
                try:
                    xml_bytes = http_get(url, {"Referer": "https://emap.pcsc.com.tw/"})
                    if xml_bytes and b"<GeoPosition>" in xml_bytes:
                        used_city = city
                        break
                    if xml_bytes and b"<iMapSDKOutput>" in xml_bytes:
                        used_city = city
                        break
                except Exception as e:
                    print(f"  7-11 ERR {city}/{town}: {e}", flush=True)
                    xml_bytes = None
                time.sleep(0.15)
            n = 0
            if xml_bytes:
                try:
                    root = ET.fromstring(xml_bytes)
                    for poi in root.findall(".//GeoPosition"):
                        def txt(tag):
                            el = poi.find(tag)
                            return (el.text or "").strip() if el is not None else ""
                        sid = txt("POIID")
                        name = txt("POIName")
                        xs, ys = txt("X"), txt("Y")
                        addr = txt("Address")
                        if not xs or not ys:
                            continue
                        lng, lat = float(xs) / 1e6, float(ys) / 1e6
                        key = sid or f"{name}|{lng:.5f}|{lat:.5f}"
                        if key in seen:
                            continue
                        seen.add(key)
                        stores.append({
                            "brand": "s711",
                            "id": sid,
                            "name": name if name.endswith("門市") or "7-ELEVEN" in name else f"{name}",
                            "lat": round(lat, 6),
                            "lng": round(lng, 6),
                            "address": addr,
                            "county": county,
                            "district": town,
                            "source": "7-ELEVEN EMapSDK",
                        })
                        n += 1
                except ET.ParseError as e:
                    print(f"  7-11 XML parse fail {town}: {e} bytes={len(xml_bytes)}", flush=True)
            print(f"  7-11 {county}{town} ({used_city}): {n}", flush=True)
            time.sleep(0.2)
    return stores


def overpass(query, servers=None):
    servers = servers or [
        "https://overpass-api.de/api/interpreter",
        "https://overpass.kumi.systems/api/interpreter",
    ]
    data = urllib.parse.urlencode({"data": query}).encode()
    last = None
    for srv in servers:
        try:
            req = urllib.request.Request(srv, data=data, headers={"User-Agent": UA, "Content-Type": "application/x-www-form-urlencoded"})
            print(f"  Overpass POST {srv} ...", flush=True)
            with urllib.request.urlopen(req, timeout=240) as resp:
                return json.loads(resp.read().decode())
        except Exception as e:
            print(f"  Overpass fail {srv}: {e}", flush=True)
            last = e
            time.sleep(2)
    raise RuntimeError(f"Overpass failed: {last}")


def elem_ll(el):
    if "lat" in el and "lon" in el:
        return float(el["lat"]), float(el["lon"])
    c = el.get("center") or {}
    if "lat" in c:
        return float(c["lat"]), float(c["lon"])
    return None


def classify_brand(tags):
    b = (tags.get("brand") or "") + " " + (tags.get("name") or "") + " " + (tags.get("brand:zh") or "")
    wd = tags.get("brand:wikidata") or tags.get("operator:wikidata") or ""
    bl = b.lower()
    if wd == "Q259340" or "7-eleven" in bl or "7-11" in bl or "統一超商" in b or "7eleven" in bl.replace("-", ""):
        return "s711"
    if wd == "Q1195852" or "familymart" in bl or "全家" in b:
        return "fami"
    if wd == "Q37158" or "starbucks" in bl or "星巴克" in b:
        return "sbux"
    if wd == "Q38076" or "mcdonald" in bl or "麥當勞" in b:
        return "mcd"
    return None


def fetch_overpass_brands():
    # bbox: S, W, N, E  northern Taiwan
    bbox = "24.35,120.85,25.32,122.07"
    q = f"""
[out:json][timeout:180];
(
  nwr["brand:wikidata"="Q1195852"]({bbox});
  nwr["brand"="FamilyMart"]({bbox});
  nwr["brand"="全家便利商店"]({bbox});
  nwr["name"~"全家"]["shop"="convenience"]({bbox});
  nwr["brand:wikidata"="Q37158"]({bbox});
  nwr["brand"="Starbucks"]({bbox});
  nwr["name"~"星巴克"]({bbox});
  nwr["brand:wikidata"="Q38076"]({bbox});
  nwr["brand"="McDonald's"]({bbox});
  nwr["name"~"麥當勞"]({bbox});
);
out center tags;
"""
    data = overpass(q)
    stores = []
    seen = set()
    for el in data.get("elements") or []:
        ll = elem_ll(el)
        if not ll:
            continue
        lat, lng = ll
        tags = el.get("tags") or {}
        brand = classify_brand(tags)
        if brand not in ("fami", "sbux", "mcd"):
            continue  # 7-11 from official API
        key = (brand, round(lat, 5), round(lng, 5))
        if key in seen:
            continue
        seen.add(key)
        name = tags.get("name") or tags.get("brand") or brand
        addr = tags.get("addr:full") or "".join(filter(None, [
            tags.get("addr:city", ""),
            tags.get("addr:district", ""),
            tags.get("addr:place", ""),
            tags.get("addr:street", ""),
            tags.get("addr:housenumber", ""),
        ]))
        stores.append({
            "brand": brand,
            "id": f"osm-{el.get('type')}-{el.get('id')}",
            "name": name,
            "lat": round(lat, 6),
            "lng": round(lng, 6),
            "address": addr,
            "county": "",
            "district": "",
            "source": "OpenStreetMap",
        })
    return stores


def fetch_stations():
    bbox = "24.35,120.85,25.32,122.07"
    q = f"""
[out:json][timeout:180];
(
  nwr["railway"="station"]({bbox});
  nwr["railway"="halt"]({bbox});
  nwr["station"="subway"]({bbox});
  nwr["station"="light_rail"]({bbox});
);
out center tags;
"""
    data = overpass(q)
    stations = []
    seen = set()
    for el in data.get("elements") or []:
        ll = elem_ll(el)
        if not ll:
            continue
        tags = el.get("tags") or {}
        name = tags.get("name") or tags.get("name:zh") or tags.get("name:zh-Hant")
        if not name:
            continue
        lat, lng = ll
        key = (name, round(lat, 4), round(lng, 4))
        if key in seen:
            continue
        seen.add(key)
        display = name
        if "站" not in name:
            display = name + "車站"
        stations.append({
            "name": display,
            "nameRaw": name,
            "lat": round(lat, 6),
            "lng": round(lng, 6),
            "kind": tags.get("station") or tags.get("railway"),
            "source": "OpenStreetMap",
        })
    return stations


def main():
    print("Reading districts from shapefile...", flush=True)
    districts = districts_from_shp()
    for c, t in districts.items():
        print(f"  {c}: {len(t)} districts", flush=True)

    print("Fetching 7-ELEVEN official locator...", flush=True)
    s711 = fetch_711(districts)
    print(f"  7-11 total {len(s711)}", flush=True)

    print("Fetching FamilyMart / Starbucks / McDonald's from OSM Overpass...", flush=True)
    osm = fetch_overpass_brands()
    from collections import Counter
    print(f"  OSM brands {Counter(s['brand'] for s in osm)}", flush=True)

    print("Fetching railway stations from OSM...", flush=True)
    stations = fetch_stations()
    print(f"  stations {len(stations)}", flush=True)

    payload = {
        "fetchedAt": time.strftime("%Y-%m-%dT%H:%M:%S+08:00"),
        "stores": s711 + osm,
        "stations": stations,
        "notes": {
            "s711": "統一超商官方電子地圖 EMapSDK SearchStore（2026-11-10）",
            "fami": "OpenStreetMap brand=FamilyMart / 全家（Overpass，2026-11-10）",
            "sbux": "OpenStreetMap brand=Starbucks / 星巴克（Overpass，2026-11-10）",
            "mcd": "OpenStreetMap brand=McDonald's / 麥當勞（Overpass，2026-11-10）",
            "stations": "OpenStreetMap railway=station/halt（Overpass，2026-11-10）",
        },
    }
    OUT.write_text(json.dumps(payload, ensure_ascii=False))
    print(f"Wrote {OUT} stores={len(payload['stores'])} stations={len(stations)}", flush=True)


if __name__ == "__main__":
    main()
