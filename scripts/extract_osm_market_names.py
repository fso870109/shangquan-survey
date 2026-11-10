"""Extract OSM features in northern Taiwan whose name looks like a market.

Writes /tmp/sq-raw/markets/osm_market_names.json with
name, lat, lng, osm id, and the main tags. amenity=marketplace features are
flagged so the merge step can prefer them.
"""
import json
import re
import time
from pathlib import Path

import osmium

BBOX = (24.42, 120.87, 25.31, 122.01)
PBF = Path("/tmp/sq-raw/taiwan.osm.pbf")
OUT = Path("/tmp/sq-raw/markets/osm_market_names.json")
NAME_RE = re.compile(r"(市場|市集|黃昏|攤販|攤集|早市|菜市)")


def inside(lat, lon):
    return BBOX[0] <= lat <= BBOX[2] and BBOX[1] <= lon <= BBOX[3]


class H(osmium.SimpleHandler):
    def __init__(self):
        super().__init__()
        self.items = []

    def _add(self, o, kind, lat, lon):
        tags = o.tags
        name = tags.get("name") or tags.get("name:zh") or tags.get("name:zh-Hant") or ""
        is_mkt = tags.get("amenity") == "marketplace" or tags.get("shop") == "marketplace"
        if not name and not is_mkt:
            return
        if not is_mkt and not NAME_RE.search(name):
            return
        if not inside(lat, lon):
            return
        self.items.append({
            "osm": f"{kind}/{o.id}",
            "name": name,
            "lat": round(lat, 6),
            "lng": round(lon, 6),
            "marketplace": bool(is_mkt),
            "amenity": tags.get("amenity") or "",
            "shop": tags.get("shop") or "",
            "building": tags.get("building") or "",
            "highway": tags.get("highway") or "",
            "public_transport": tags.get("public_transport") or "",
            "opening_hours": tags.get("opening_hours") or "",
            "addr": " ".join(x for x in [tags.get("addr:city") or "", tags.get("addr:district") or "", tags.get("addr:street") or "", tags.get("addr:housenumber") or ""] if x),
        })

    def node(self, n):
        if n.location.valid():
            self._add(n, "node", n.location.lat, n.location.lon)

    def way(self, w):
        tags = w.tags
        name = tags.get("name") or ""
        is_mkt = tags.get("amenity") == "marketplace" or tags.get("shop") == "marketplace"
        if not is_mkt and not NAME_RE.search(name):
            return
        lats, lons = [], []
        try:
            for n in w.nodes:
                if n.location.valid():
                    lats.append(n.location.lat)
                    lons.append(n.location.lon)
        except Exception:
            return
        if lats:
            self._add(w, "way", sum(lats) / len(lats), sum(lons) / len(lons))


def main():
    t0 = time.time()
    h = H()
    h.apply_file(str(PBF), locations=True)
    OUT.write_text(json.dumps(h.items, ensure_ascii=False))
    n_m = sum(1 for x in h.items if x["marketplace"])
    print(f"named market-like features={len(h.items)} (marketplace={n_m}) in {time.time()-t0:.1f}s")


if __name__ == "__main__":
    main()
