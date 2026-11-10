#!/usr/bin/env python3
"""Build data/markets.json from official government lists + OSM cross-check.

Never invents coordinates: official lat/lng, then OSM name match, then ArcGIS
address geocoding (PointAddress preferred), then drop the record and report it.
"""
from __future__ import annotations

import csv
import json
import math
import re
import time
import unicodedata
import urllib.parse
import urllib.request
from collections import Counter, defaultdict
from html.parser import HTMLParser
from pathlib import Path

from shapely.geometry import Point, shape
from shapely.strtree import STRtree

ROOT = Path("/workspace/shangquan")
RAW = Path("/tmp/sq-raw/markets")
OUT = ROOT / "data" / "markets.json"
CACHE_PATH = RAW / "geocode_cache.json"
OSM_PATH = RAW / "osm_market_names.json"

COUNTY_FILES = {
    "taipei": ROOT / "data" / "taipei.json",
    "newtaipei": ROOT / "data" / "newtaipei.json",
    "taoyuan": ROOT / "data" / "taoyuan.json",
    "hsinchu_city": ROOT / "data" / "hsinchu_city.json",
    "hsinchu_county": ROOT / "data" / "hsinchu_county.json",
}
COUNTY_ID = {
    "臺北市": "taipei", "台北市": "taipei",
    "新北市": "newtaipei",
    "桃園市": "taoyuan",
    "新竹市": "hsinchu_city",
    "新竹縣": "hsinchu_county",
}
CID_NAME = {v: k for k, v in COUNTY_ID.items() if k.startswith("臺") or k.startswith("新") or k.startswith("桃")}
CID_NAME["taipei"] = "臺北市"

NORTH = set(COUNTY_ID)

GENERIC_KEYS = {
    "第一", "第二", "第三", "中央", "公有", "南門", "北門", "東門", "西門",
    "和平", "忠孝", "仁愛", "信義", "成功", "中正", "民生", "市場", "黃昏",
    "早市", "臨時", "中山", "中正路",
}

SUPERMARKET_HINTS = (
    "超市", "全聯", "頂好", "愛買", "喜互惠", "台灣集寶", "7-11", "7月11日",
    "便利超商", "松青", "生鮮超級市場", "超級市場",
)

NON_TRADITIONAL = (
    "玉市", "藝文特區", "假日花市", "花市攤集", "美食廣場", "命理",
    "光華數位", "中山大樓", "野柳",
)

TYPE_PUBLIC = "公有市場"
TYPE_PRIVATE = "民有市場"
TYPE_VENDOR = "攤販集中區"
TYPE_TEMP = "臨時攤販集中場"
TYPE_DUSK = "黃昏市場"
TYPE_MORNING = "早市"

SOURCES = {
    "moea": {
        "name": "經濟部商業發展署 零售市場基本資料（全國）",
        "org": "經濟部商業發展署",
        "url": "https://data.gov.tw/dataset/59855",
        "file": "https://www.cto.moea.gov.tw/OD/零售市場基本資料.csv",
        "date": "資料集品管 2026-09-18；經 data.gov.tw 品質下載介面取得（2026-11-10）",
        "note": "cto.moea.gov.tw 直連會被 Cloudflare 攔截，改由 quality.data.gov.tw 下載。部分地址有錯字，能對上縣市名單時以縣市名單為準。",
    },
    "tpe_trad": {
        "name": "臺北市傳統市(商)場",
        "org": "臺北市市場處",
        "url": "https://data.gov.tw/dataset/121593",
        "date": "2026-10-13",
    },
    "tpe_private": {
        "name": "臺北市民有市場",
        "org": "臺北市市場處",
        "url": "https://data.gov.tw/dataset/132159",
        "date": "2026-03-18",
    },
    "tpe_vendor": {
        "name": "臺北市攤販集中場（臨時攤販集中場）",
        "org": "臺北市市場處",
        "url": "https://data.gov.tw/dataset/121594",
        "date": "2026-11-03",
        "note": "名單中的觀光夜市已排除。",
    },
    "ntpc_ms": {
        "name": "新北市公有市場及超市清冊",
        "org": "新北市市場處",
        "url": "https://data.gov.tw/dataset/125863",
        "date": "2026-08-11",
        "note": "清冊中的超市、夜市、美食廣場未列入傳統市場層。",
    },
    "ntpc_vendor": {
        "name": "新北市公有攤販集中場清冊",
        "org": "新北市市場處",
        "url": "https://data.gov.tw/dataset/125838",
        "date": "2025-12-03",
    },
    "ty_open": {
        "name": "桃園市內公有零售市場",
        "org": "桃園市政府經濟發展局",
        "url": "https://data.gov.tw/dataset/26075",
        "date": "2025-06-01",
    },
    "ty_edb": {
        "name": "桃園市公有零售市場介紹",
        "org": "桃園市政府經濟發展局",
        "url": "https://edb.tycg.gov.tw/taoyuanmarket.htm",
        "date": "頁面 2026-11-10 擷取（含 114 年 4 月開幕之忠貞公有零售市場）",
        "note": "已委外作為全聯／寶雅／純超市使用的公有市場用地不列入傳統市場競爭層；中壢第一公有零售市場改建後仍以官方名稱列入。",
    },
    "ty_roster": {
        "name": "桃園市市集名冊",
        "org": "桃園市政府經濟發展局",
        "url": "https://www.tycg.gov.tw/",
        "date": "市府下載檔 桃園市市集名冊.pdf（2026-11-10 取得）",
        "note": "含民有市場、黃昏市場與攤集區名稱；無名單地址者改以門牌地理編碼或 OSM 名稱對位。",
    },
    "hc_public": {
        "name": "新竹市公有零售市場名冊",
        "org": "新竹市政府",
        "url": "https://data.gov.tw/dataset/67539",
        "date": "2025-11-17",
    },
    "osm": {
        "name": "OpenStreetMap amenity=marketplace",
        "org": "OpenStreetMap 貢獻者（Geofabrik taiwan-latest.osm.pbf）",
        "url": "https://www.openstreetmap.org/copyright",
        "date": "2026-11-08 取得之台灣圖資",
        "note": "用來核對官方座標，並補上官方名單沒有、但 OSM 有標名稱的傳統市場／黃昏市場。夜市、批發市場、超市不列入。",
    },
}

# PDF 名冊中未出現在經濟部／經發局公有介紹的民有／黃昏／攤集名稱
TY_ROSTER_EXTRA = [
    ("中和南路攤集區", TYPE_VENDOR, "桃園市"),
    ("朝陽市場", TYPE_PRIVATE, "桃園市"),
    ("仲平黃昏市場", TYPE_DUSK, "桃園市"),
    ("同安黃昏市場", TYPE_DUSK, "桃園市"),
    ("南門綜合市場", TYPE_PRIVATE, "桃園市"),
    ("萬利市場", TYPE_PRIVATE, "桃園市"),
    ("青菓市場", TYPE_PRIVATE, "桃園市"),
    ("華勛市場", TYPE_PRIVATE, "桃園市"),
    ("幸福黃昏市場", TYPE_DUSK, "桃園市"),
    ("環東黃昏市場", TYPE_DUSK, "桃園市"),
    ("忠孝黃昏市場", TYPE_DUSK, "桃園市"),
    ("中福黃昏市場", TYPE_DUSK, "桃園市"),
    ("三德民有零售市場", TYPE_PRIVATE, "桃園市"),
    ("營盛黃昏市場", TYPE_DUSK, "桃園市"),
    ("365黃昏市場", TYPE_DUSK, "桃園市"),
    ("興達黃昏市場", TYPE_DUSK, "桃園市"),
    ("仁愛黃昏市場", TYPE_DUSK, "桃園市"),
    ("南華市場", TYPE_PRIVATE, "桃園市"),
    ("新華街市場", TYPE_PRIVATE, "桃園市"),
    ("中北黃昏市場", TYPE_DUSK, "桃園市"),
    ("志廣路市場", TYPE_PRIVATE, "桃園市"),
    ("崎頂黃昏市場", TYPE_DUSK, "桃園市"),
    ("萬大黃昏市場", TYPE_DUSK, "桃園市"),
    ("龍安黃昏市場", TYPE_DUSK, "桃園市"),
    ("力行觀光市場", TYPE_PRIVATE, "桃園市"),
    ("南昌西街市場", TYPE_PRIVATE, "桃園市"),
    ("和平市場", TYPE_PRIVATE, "桃園市"),
]


def nfkc(s: str) -> str:
    return unicodedata.normalize("NFKC", s or "").replace("\u3000", " ").strip()


def clean_text(s: str) -> str:
    s = nfkc(s)
    s = s.replace("臺臺", "臺").replace("&nbsp;", " ")
    s = s.replace("北", "北").replace("路", "路").replace("里", "里")
    s = s.replace("金", "金").replace("林", "林").replace("綠", "綠")
    s = re.sub(r"\s+", " ", s)
    return s.strip()


def read_csv(path: Path) -> list[dict]:
    raw = path.read_bytes()
    text = None
    for enc in ("utf-8-sig", "utf-8", "big5", "cp950", "big5hkscs"):
        try:
            text = raw.decode(enc)
            break
        except UnicodeDecodeError:
            continue
    if text is None:
        text = raw.decode("utf-8", "replace")
    return list(csv.DictReader(text.splitlines()))


def norm_name(s: str) -> str:
    s = clean_text(s).replace("台", "臺")
    s = re.sub(r"[（(].*?[)）]", "", s)
    for p in ("臺北市", "新北市", "桃園市", "新竹市", "新竹縣", "中壢市", "桃園縣"):
        s = s.replace(p, "")
    s = re.sub(r"(公有|民有|零售|傳統|臨時|觀光)", "", s)
    s = s.replace("市集", "市場").replace("攤集區", "攤販集中區")
    s = s.replace("攤集場", "攤販集中場").replace("集中區", "攤販集中區")
    s = re.sub(r"[\s\-–—,，.。、/／]", "", s)
    return s


def name_key(s: str) -> str:
    n = norm_name(s)
    n = n.replace("黃昏市場", "").replace("黃昏", "")
    n = n.replace("早市", "").replace("市場", "")
    n = n.replace("攤販集中場", "").replace("攤販集中區", "")
    return n


def haversine(lat1, lng1, lat2, lng2) -> float:
    r = 6371000.0
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dp = math.radians(lat2 - lat1)
    dl = math.radians(lng2 - lng1)
    h = math.sin(dp / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    return 2 * r * math.asin(math.sqrt(h))


def parse_dms(val) -> float | None:
    if val is None:
        return None
    s = clean_text(str(val))
    if not s:
        return None
    try:
        return float(s)
    except ValueError:
        pass
    m = re.match(r"^(\d+)\s*[°º]\s*(\d+)\s*['′]\s*([\d.]+)\s*[\"″']?\s*$", s)
    if not m:
        return None
    deg, minutes, seconds = int(m.group(1)), int(m.group(2)), float(m.group(3))
    if minutes >= 60 or seconds >= 60:
        return None
    return deg + minutes / 60.0 + seconds / 3600.0


def parse_float(val) -> float | None:
    if val is None or val == "":
        return None
    try:
        n = float(str(val).strip())
    except ValueError:
        return None
    if not math.isfinite(n):
        return None
    return n


def looks_night(name: str, hours: str = "", extra: str = "") -> bool:
    blob = f"{name} {hours} {extra}"
    if "夜市" in blob:
        return True
    return False


def looks_supermarket(name: str, note: str = "", extra: str = "") -> bool:
    # extra is only consulted when it is a short official type/note, not a long intro
    extra_bit = extra if extra and len(extra) < 48 else ""
    blob = f"{name} | {note} | {extra_bit}"
    return any(h in blob for h in SUPERMARKET_HINTS)


def classify(name: str, hours: str = "", official_type: str | None = None) -> str:
    n = clean_text(name)
    h = clean_text(hours)
    if official_type in (TYPE_DUSK, TYPE_VENDOR, TYPE_TEMP, TYPE_PUBLIC, TYPE_PRIVATE, TYPE_MORNING):
        # still let dusk / vendor tokens in the name win when more specific
        pass
    if "黃昏" in n or "黃昏" in h:
        return TYPE_DUSK
    if "臨時攤販" in n or "臨時賣店" in n or "臨時攤棚" in n:
        if "成功市場" in n or "市場" in n and "攤販" not in n and "臨時攤棚" in n:
            return TYPE_PUBLIC
        return TYPE_TEMP
    if any(x in n for x in ("攤販集中", "攤集區", "攤集場", "集中區", "集中場")):
        if "臨時" in n:
            return TYPE_TEMP
        return TYPE_VENDOR
    if official_type == TYPE_DUSK:
        return TYPE_DUSK
    if official_type == TYPE_VENDOR:
        return TYPE_VENDOR
    if official_type == TYPE_TEMP:
        return TYPE_TEMP
    if official_type == TYPE_MORNING and "公有" not in n and "民有" not in n:
        return TYPE_MORNING
    if "民有" in n or official_type == TYPE_PRIVATE:
        return TYPE_PRIVATE
    if "公有" in n or official_type == TYPE_PUBLIC:
        return TYPE_PUBLIC
    return official_type or TYPE_PRIVATE


def classify_hours(hours: str, name: str = "") -> str:
    h = clean_text(hours)
    n = clean_text(name)
    if "黃昏" in h or "黃昏" in n:
        return "黃昏"
    if "夜市" in h or "夜市" in n:
        return "夜市"
    if any(x in h for x in ("全日", "全天", "24H", "24時")):
        return "全日"
    if h:
        return "早市" if ("早" in h or "上午" in h or h.startswith("0") or h.startswith("5") or h.startswith("6") or h.startswith("7")) else h
    if "早市" in n:
        return "早市"
    return ""


def expand_address(addr: str, county: str = "", district: str = "") -> str:
    addr = clean_text(addr)
    if not addr:
        return ""
    addr = addr.replace("臺臺北市", "臺北市")
    if county:
        c_alt = county.replace("臺", "台")
        if county not in addr and c_alt not in addr:
            if district and district not in addr:
                addr = county + district + addr
            else:
                addr = county + addr
        elif district and district not in addr:
            addr = addr.replace(county, county + district, 1)
            addr = addr.replace(c_alt, county + district, 1)
    return addr


def skip_reason(name: str, hours: str = "", note: str = "", extra: str = "") -> str | None:
    blob = f"{name} {hours} {note} {extra}"
    if looks_night(name, hours, extra):
        return "夜市"
    h = clean_text(hours)
    if h in ("16-24", "16:00-24:00", "16:00-00:00") and "黃昏" not in name:
        return "夜市"
    if looks_supermarket(name, note, extra):
        return "超市／量販"
    if any(x in blob for x in NON_TRADITIONAL):
        return "非生鮮傳統市場"
    if "批發市場" in name or "運銷" in name or "肉品市場" in name:
        return "批發市場"
    if "果菜市場" in name and "零售" not in name:
        return "批發市場"
    if any(x in name for x in ("樂華攤集", "樂華夜市")):
        return "夜市"
    if "中正觀光市場" in name:
        return "非生鮮傳統市場"
    return None


TY_SUPERMARKET_SITES = (
    ("樂善", "龜山"),
    ("新路", "龜山"),
    ("大竹公有", "蘆竹"),
    ("僑愛", "大溪"),
    ("新富公有", "平鎮"),
    ("觀音多功能", "觀音"),
)


def is_excluded_site(name: str, district: str = "", address: str = "") -> bool:
    blob = name + district + address
    if "平鎮" in blob and "第一公有" in name:
        return True
    if "延平路一段2號" in address.replace(" ", "") and "第一" in name:
        return True
    for key, area in TY_SUPERMARKET_SITES:
        if key in name and (area in district or area in address or area in name):
            return True
        if key in name and not district and not address:
            return True
    return False


class VillageIndex:
    def __init__(self):
        self.rows = []
        geoms = []
        for cid, path in COUNTY_FILES.items():
            data = json.loads(path.read_text())
            cname = data["name"]
            for v in data["villages"]:
                g = shape(v["g"])
                self.rows.append({
                    "cid": cid,
                    "county": cname,
                    "district": v["district"],
                    "village": v["name"],
                    "geom": g,
                })
                geoms.append(g)
        self.tree = STRtree(geoms)
        self.geoms = geoms
        print(f"village index {len(self.rows)}")

    def locate(self, lat: float, lng: float) -> dict | None:
        pt = Point(lng, lat)
        try:
            idxs = list(self.tree.query(pt, predicate="intersects"))
        except Exception:
            idxs = []
        for i in idxs:
            row = self.rows[int(i)]
            try:
                if row["geom"].intersects(pt):
                    return row
            except Exception:
                continue
        # nearest village within 250 m (degrees approx)
        try:
            idxs = list(self.tree.query(pt.buffer(0.003)))
        except Exception:
            idxs = []
        best = None
        best_d = 1e9
        for i in idxs:
            row = self.rows[int(i)]
            d = row["geom"].distance(pt) * 111320
            if d < best_d:
                best, best_d = row, d
        if best is not None and best_d <= 250:
            return best
        return None


class Geocoder:
    def __init__(self):
        if CACHE_PATH.exists():
            self.cache = json.loads(CACHE_PATH.read_text())
        else:
            self.cache = {}
        self.hits = 0
        self.misses = 0

    def save(self):
        CACHE_PATH.write_text(json.dumps(self.cache, ensure_ascii=False))

    def lookup(self, query: str) -> list[dict]:
        query = clean_text(query)
        if not query:
            return []
        if query in self.cache:
            self.hits += 1
            return self.cache[query]
        self.misses += 1
        url = (
            "https://geocode.arcgis.com/arcgis/rest/services/World/GeocodeServer/"
            "findAddressCandidates?f=json&maxLocations=5&countryCode=TWN&outFields="
            + urllib.parse.quote("Score,Addr_type,Match_addr,City,Region,PlaceName,Nbrhd,Postal")
            + "&singleLine=" + urllib.parse.quote(query)
        )
        req = urllib.request.Request(url, headers={"User-Agent": "ShangquanSurvey/1.0 (market geocoding)"})
        try:
            with urllib.request.urlopen(req, timeout=20) as resp:
                data = json.loads(resp.read().decode("utf-8"))
        except Exception as exc:
            print(f"  geocode fail {query}: {exc}")
            data = {"candidates": []}
        out = []
        for c in data.get("candidates") or []:
            loc = c.get("location") or {}
            attrs = c.get("attributes") or {}
            lat, lng = loc.get("y"), loc.get("x")
            if lat is None or lng is None:
                continue
            out.append({
                "lat": float(lat),
                "lng": float(lng),
                "score": float(c.get("score") or attrs.get("Score") or 0),
                "addr_type": attrs.get("Addr_type") or "",
                "match": attrs.get("Match_addr") or c.get("address") or "",
                "city": attrs.get("City") or "",
                "region": attrs.get("Region") or "",
                "place": attrs.get("PlaceName") or "",
            })
        self.cache[query] = out
        time.sleep(0.12)
        return out

    def pick(self, query: str, expect_county: str = "", expect_district: str = "", near=None) -> dict | None:
        cands = self.lookup(query)
        if not cands:
            return None
        scored = []
        for c in cands:
            if c["score"] < 75:
                continue
            region = (c["region"] or "").replace("台", "臺")
            city = (c["city"] or "").replace("台", "臺")
            match = (c["match"] or "").replace("台", "臺")
            if expect_county:
                exp = expect_county.replace("台", "臺")
                if region and exp not in region and region not in exp and exp not in match:
                    continue
            if expect_district and expect_district not in city and expect_district not in match:
                # keep, but do not boost
                pass
            score = c["score"]
            if c["addr_type"] == "PointAddress":
                score += 15
            elif c["addr_type"] in ("StreetAddress", "StreetInt"):
                score += 8
            if expect_district and expect_district in city:
                score += 10
            if near:
                d = haversine(near[0], near[1], c["lat"], c["lng"])
                if d < 250:
                    score += 20
                elif d < 600:
                    score += 10
                elif d > 4000:
                    score -= 25
            scored.append((score, c))
        if not scored:
            for c in cands:
                if 21.8 < c["lat"] < 25.4 and 119.9 < c["lng"] < 122.1:
                    return c
            return None
        scored.sort(key=lambda x: -x[0])
        top = [c for sc, c in scored if sc >= scored[0][0] - 1]
        if near and len(top) > 1:
            top.sort(key=lambda c: haversine(near[0], near[1], c["lat"], c["lng"]))
            return top[0]
        return scored[0][1]


def load_osm() -> tuple[list[dict], list[dict]]:
    items = json.loads(OSM_PATH.read_text())
    cleaned, hints = [], []
    for it in items:
        name = clean_text(it.get("name") or "")
        rec = {**it, "name": name, "key": name_key(name), "norm": norm_name(name)}
        if name:
            hints.append(rec)
        if it.get("highway") or it.get("public_transport"):
            if not it.get("marketplace"):
                continue
        amenity = it.get("amenity") or ""
        if amenity in ("bus_stop", "bicycle_rental", "parking", "parking_entrance", "parcel_locker") and not it.get("marketplace"):
            continue
        if amenity == "restaurant" and not it.get("marketplace"):
            continue
        if name:
            cleaned.append(rec)
    print(f"OSM usable named features {len(cleaned)} / raw {len(items)} hints={len(hints)}")
    return cleaned, hints


def osm_excluded(it: dict) -> bool:
    name = it.get("name") or ""
    blob = name + " " + (it.get("shop") or "") + " " + (it.get("amenity") or "")
    if not name:
        return True
    if looks_night(name):
        return True
    if any(x in blob for x in (
        "批發", "運銷", "肉品市場", "果菜市場", "魚市場", "花市", "玉市",
        "農民市集", "假日市集", "假日花園", "Farmer", "Jasons", "珠寶",
        "鐘錶", "超市", "全聯", "觀光夜市", "夜市", "合作社",
        "跳蚤", "多肉", "直銷中心", "漁港", "漁產品",
        "農場", "農民市場", "部落市集", "波光", "古美", "樂善里",
    )):
        return True
    if name in ("黃昏市場", "市場", "早市", "市集"):
        return True
    if it.get("shop") == "supermarket":
        return True
    return False


def name_similar(a: str, b: str) -> bool:
    ka, kb = name_key(a), name_key(b)
    if not ka or not kb:
        return False
    if ka == kb:
        return ka not in GENERIC_KEYS
    if ka in GENERIC_KEYS or kb in GENERIC_KEYS:
        return False
    if len(ka) >= 2 and len(kb) >= 2 and (ka in kb or kb in ka):
        return True
    na, nb = norm_name(a), norm_name(b)
    if na and nb and (na == nb or na in nb or nb in na) and min(len(na), len(nb)) >= 4:
        return True
    return False


class MarketDB:
    def __init__(self, villages: VillageIndex, geocoder: Geocoder, osm: list[dict], hints: list[dict] | None = None):
        self.villages = villages
        self.geocoder = geocoder
        self.osm = osm
        self.hints = hints or osm
        self.items: list[dict] = []
        self.unmatched: list[dict] = []
        self.skipped = Counter()

    def hint_near(self, name: str, district: str = "", county: str = ""):
        """Approximate location from any similarly named OSM object, including bus stops."""
        scored = []
        for it in self.hints:
            if not it.get("name"):
                continue
            sim = name_similar(name, it["name"]) or (name_key(name) and name_key(name) == it.get("key"))
            if not sim:
                continue
            scored.append(it)
        if not scored:
            return None
        if len(scored) == 1:
            return scored[0]["lat"], scored[0]["lng"]
        # if many "第一市場" hits, we cannot use them without more context
        if name_key(name) in GENERIC_KEYS:
            return None
        return None

    def match_osm(self, name: str, lat=None, lng=None, county: str = "", district: str = "") -> dict | None:
        scored = []
        for it in self.osm:
            if not it["name"]:
                continue
            close = False
            if lat is not None and lng is not None:
                d = haversine(lat, lng, it["lat"], it["lng"])
                if d <= 250:
                    close = True
                elif d > 2500:
                    continue
            else:
                d = None
            sim = name_similar(name, it["name"])
            if not sim and not close:
                continue
            if not sim and close and not it.get("marketplace"):
                continue
            if looks_night(it["name"]):
                continue
            if sim and lat is None and county:
                pass
            score = 0
            if sim:
                score += 50
            if it.get("marketplace"):
                score += 20
            if d is not None:
                score += max(0, 30 - d / 20)
            scored.append((score, d if d is not None else 1e9, it))
        if not scored:
            return None
        scored.sort(key=lambda x: (-x[0], x[1]))
        best_score, best_d, best = scored[0]
        if best_score < 50 and (best_d is None or best_d > 80):
            return None
        if not name_similar(name, best["name"]) and (best_d is None or best_d > 80):
            return None
        return best

    def resolve(self, rec: dict) -> dict | None:
        name = rec["name"]
        county = rec.get("county") or ""
        district = rec.get("district") or ""
        addr = rec.get("address") or ""
        lat, lng = rec.get("lat"), rec.get("lng")
        geo = rec.get("geo") or ""
        osm_hit = None
        hint = None
        exp_county = (county or "").replace("台", "臺")
        if lat is not None and lng is not None:
            loc0 = self.villages.locate(lat, lng)
            if not loc0 or (exp_county and loc0["county"] != exp_county):
                lat = lng = None
                rec["lat"] = rec["lng"] = None
                geo = ""

        if lat is not None and lng is not None:
            osm_hit = self.match_osm(name, lat, lng, county, district)
        if (lat is None or lng is None) and addr:
            if hint is None:
                # Generic names like 第一市場: pick an OSM hint that sits near an address candidate
                cands = self.geocoder.lookup(addr)
                key = name_key(name)
                best = None
                best_d = 1e9
                for it in self.hints:
                    if not it.get("name"):
                        continue
                    if not (name_similar(name, it["name"]) or (key and key == it.get("key"))):
                        continue
                    for c in cands:
                        d = haversine(it["lat"], it["lng"], c["lat"], c["lng"])
                        if d < best_d:
                            best, best_d = it, d
                if best is not None and best_d < 800:
                    hint = (best["lat"], best["lng"])
            picked = self.geocoder.pick(addr, county, district, near=hint)
            if picked:
                lat, lng = picked["lat"], picked["lng"]
                geo = "arcgis-address"
                osm_hit = self.match_osm(name, lat, lng, county, district)
                # snap to a nearby marketplace polygon centroid if it is clearly the same place
                if osm_hit and osm_hit.get("marketplace") and name_similar(name, osm_hit["name"]):
                    d = haversine(lat, lng, osm_hit["lat"], osm_hit["lng"])
                    if d < 180:
                        lat, lng = osm_hit["lat"], osm_hit["lng"]
                        geo = "osm-near-address"
        if (lat is None or lng is None):
            osm_hit = self.match_osm(name, None, None, county, district)
            if osm_hit and name_similar(name, osm_hit["name"]):
                loc0 = self.villages.locate(osm_hit["lat"], osm_hit["lng"])
                if loc0 and (not county or loc0["county"] == county.replace("台", "臺") or loc0["county"] == county):
                    lat, lng = osm_hit["lat"], osm_hit["lng"]
                    geo = "osm-name"
                    rec["osm"] = osm_hit.get("osm")
        if (lat is None or lng is None):
            picked = self.geocoder.pick(f"{county}{district}{name}", county, district, near=hint)
            if picked:
                lat, lng = picked["lat"], picked["lng"]
                geo = "arcgis-name"
                osm_hit = self.match_osm(name, lat, lng, county, district)

        if lat is None or lng is None:
            self.unmatched.append(rec)
            return None

        loc = self.villages.locate(lat, lng)
        exp_county = (county or "").replace("台", "臺")
        if loc and exp_county and loc["county"] != exp_county:
            loc = None
        if not loc:
            self.unmatched.append({**rec, "why": "outside-scope-or-wrong-county", "lat": lat, "lng": lng})
            return None
        rec["cid"] = loc["cid"]
        rec["county"] = loc["county"]
        rec["district"] = loc["district"]
        rec["village"] = loc["village"]

        if osm_hit:
            rec["osm"] = osm_hit.get("osm")
            rec["osmName"] = osm_hit.get("name")

        rec["lat"] = round(float(lat), 6)
        rec["lng"] = round(float(lng), 6)
        rec["geo"] = geo or rec.get("geo") or "given"
        rec["address"] = addr
        # Make generic official names distinguishable on the map
        dname = (rec.get("district") or "").replace("區", "").replace("鄉", "").replace("鎮", "").replace("市", "")
        if rec["name"] in ("第一公有零售市場", "第二公有零售市場", "第三公有零售市場", "第一公有市場", "第二公有市場") and dname:
            rec["name"] = dname + rec["name"]
        return rec

    def add(self, rec: dict):
        if is_excluded_site(rec.get("name") or "", rec.get("district") or "", rec.get("address") or ""):
            self.skipped["超市／量販"] += 1
            return
        reason = skip_reason(rec["name"], rec.get("hours", ""), rec.get("note", ""), rec.get("extra", ""))
        if reason:
            self.skipped[reason] += 1
            return
        rec["name"] = clean_text(rec["name"])
        rec["address"] = expand_address(rec.get("address") or "", rec.get("county") or "", rec.get("district") or "")
        rec["type"] = classify(rec["name"], rec.get("hours", ""), rec.get("type"))
        rec["hours"] = classify_hours(rec.get("hours", ""), rec["name"])
        rec["sources"] = rec.get("sources") or []
        placed = self.resolve(rec)
        if not placed:
            return
        self.items.append(placed)

    def merge(self):
        kept: list[dict] = []
        for rec in self.items:
            partner = None
            for other in kept:
                d = haversine(other["lat"], other["lng"], rec["lat"], rec["lng"])
                if other["cid"] != rec["cid"] and d > 200:
                    continue
                same_name = name_similar(other["name"], rec["name"]) or norm_name(other["name"]) == norm_name(rec["name"])
                if same_name and d < 600:
                    partner = other
                    break
                if d < 70:
                    partner = other
                    break
            if not partner:
                kept.append(rec)
                continue
            # merge into partner
            partner["sources"] = sorted(set(partner.get("sources", []) + rec.get("sources", [])))
            if rec.get("osm") and not partner.get("osm"):
                partner["osm"] = rec["osm"]
                partner["osmName"] = rec.get("osmName")
            # prefer longer / more complete address
            def addr_score(a):
                a = a or ""
                sc = min(len(a), 50)
                if "號" in a: sc += 40
                if "巷內" in a or "一帶" in a or "路口" in a: sc -= 20
                return sc
            if addr_score(rec.get("address")) > addr_score(partner.get("address")):
                partner["address"] = rec["address"]
            # prefer more specific type
            rank = {TYPE_DUSK: 5, TYPE_TEMP: 4, TYPE_VENDOR: 3, TYPE_PUBLIC: 2, TYPE_PRIVATE: 1, TYPE_MORNING: 3}
            if rec["type"] == TYPE_PUBLIC or partner["type"] == TYPE_PUBLIC:
                if "攤販" not in partner["name"] or "公有" in partner["name"] or "公有" in rec["name"]:
                    partner["type"] = TYPE_PUBLIC if ("公有" in rec["name"] or "公有" in partner["name"] or partner["type"] == TYPE_PUBLIC) else partner["type"]
            elif rank.get(rec["type"], 0) > rank.get(partner["type"], 0):
                partner["type"] = rec["type"]
            # prefer official coords / osm marketplace over name geocode
            geo_rank = {"official-coord": 5, "dms": 4, "osm-name": 3, "arcgis-address": 2, "arcgis-name": 1, "given": 3}
            if geo_rank.get(rec.get("geo"), 0) > geo_rank.get(partner.get("geo"), 0):
                partner["lat"], partner["lng"] = rec["lat"], rec["lng"]
                partner["geo"] = rec["geo"]
            # prefer the more official-looking name
            if "公有" in rec["name"] and "公有" not in partner["name"]:
                partner["name"] = rec["name"]
            elif len(rec["name"]) > len(partner["name"]) and name_similar(rec["name"], partner["name"]):
                if "公有" in rec["name"] or "黃昏" in rec["name"] or "攤販" in rec["name"]:
                    partner["name"] = rec["name"]
            if rec.get("note") and not partner.get("note"):
                partner["note"] = rec["note"]
            if rec.get("hours") and not partner.get("hours"):
                partner["hours"] = rec["hours"]
        self.items = kept

    def add_osm_only(self):
        added = 0
        for it in self.osm:
            if not it.get("marketplace"):
                continue
            if osm_excluded(it):
                continue
            loc = self.villages.locate(it["lat"], it["lng"])
            if not loc:
                continue
            too_close = False
            for rec in self.items:
                d = haversine(rec["lat"], rec["lng"], it["lat"], it["lng"])
                if d < 80:
                    too_close = True
                    break
                if name_similar(rec["name"], it["name"]) and rec.get("cid") == loc["cid"]:
                    too_close = True
                    if not rec.get("osm") and d < 400:
                        rec["osm"] = it.get("osm")
                        rec["osmName"] = it.get("name")
                    break
                if name_similar(rec["name"], it["name"]) and d < 400:
                    too_close = True
                    if not rec.get("osm"):
                        rec["osm"] = it.get("osm")
                        rec["osmName"] = it.get("name")
                    break
            if too_close:
                continue
            typ = classify(it["name"])
            self.items.append({
                "name": it["name"],
                "type": typ,
                "hours": classify_hours("", it["name"]),
                "lat": it["lat"],
                "lng": it["lng"],
                "address": it.get("addr") or "",
                "county": loc["county"],
                "cid": loc["cid"],
                "district": loc["district"],
                "village": loc["village"],
                "sources": ["osm"],
                "osm": it.get("osm"),
                "geo": "osm-only",
                "note": "官方開放名單未收錄，座標來自 OpenStreetMap amenity=marketplace",
            })
            added += 1
        print(f"OSM-only added {added}")


def ingest_moea(db: MarketDB):
    rows = read_csv(RAW / "moea_retail_markets.csv")
    n = 0
    for r in rows:
        county = clean_text(r.get("縣市") or "").replace("台北市", "臺北市")
        if county not in NORTH:
            continue
        name = clean_text(r.get("市集名稱") or "")
        addr = clean_text(r.get("市集地址") or "")
        addr = addr.replace("萬區", "萬里區").replace("北洲區", "蘆洲區").replace("臺臺北市", "臺北市").replace("瑪鋉北", "瑪鋉路")
        hours = clean_text(r.get("營業時間") or "")
        note = clean_text(r.get("備註") or "")
        # parse district from address if present
        district = ""
        m = re.search(r"(.{2,3}[區鄉鎮市])", addr)
        if m and m.group(1) not in ("新北市", "桃園市", "臺北市", "新竹市", "新竹縣"):
            district = m.group(1)
        rec = {
            "name": name,
            "address": expand_address(addr, county, district),
            "county": county,
            "district": district,
            "hours": hours,
            "note": note,
            "sources": ["moea"],
        }
        # known bad MOEA address: 土城公有零售市場 pointed at 三峽
        if "土城公有" in name:
            rec["address"] = "新北市土城區中正路18號"
            rec["district"] = "土城區"
            rec["county"] = "新北市"
        db.add(rec)
        n += 1
    print(f"ingested MOEA north {n}")


def ingest_tpe_traditional(db: MarketDB):
    rows = read_csv(RAW / "tpe_traditional.csv")
    for r in rows:
        name = clean_text(r.get("stitle") or "")
        addr = clean_text(r.get("xAddress") or "")
        lat = parse_float(r.get("GTag_latitude"))
        lng = parse_float(r.get("GTag_longitude"))
        db.add({
            "name": name,
            "address": expand_address(addr, "臺北市"),
            "county": "臺北市",
            "lat": lat, "lng": lng,
            "geo": "official-coord",
            "type": TYPE_PUBLIC if "民有" not in name else TYPE_PRIVATE,
            "sources": ["tpe_trad"],
        })
    print(f"ingested Taipei traditional {len(rows)}")


def ingest_tpe_private(db: MarketDB):
    rows = read_csv(RAW / "tpe_private.csv")
    for r in rows:
        name = clean_text(r.get("市場名稱") or "")
        addr = clean_text(r.get("市場地址") or "")
        district = clean_text(r.get("行政區") or "")
        db.add({
            "name": name,
            "address": expand_address(addr, "臺北市", district),
            "county": "臺北市",
            "district": district,
            "type": TYPE_PRIVATE,
            "note": clean_text(r.get("備註") or ""),
            "sources": ["tpe_private"],
        })
    print(f"ingested Taipei private {len(rows)}")


def ingest_tpe_vendors(db: MarketDB):
    rows = read_csv(RAW / "tpe_vendors.csv")
    n = 0
    for r in rows:
        district = clean_text(r.get("stitle") or "") + "區"
        if district.endswith("區區"):
            district = district[:-1]
        street = clean_text(r.get("xbody") or "")
        addr = clean_text(r.get("xAddress") or "")
        hours = f"{r.get('xstartTime') or ''}-{r.get('xendTime') or ''}"
        name = street if "攤" in street or "市場" in street or "夜市" in street else f"{street}攤販集中場"
        lat = parse_dms(r.get("GTag_latitude"))
        lng = parse_dms(r.get("GTag_longitude"))
        # filter obviously invalid Taipei coords
        if lat is not None and not (24.9 < lat < 25.3):
            lat = None
        if lng is not None and not (121.3 < lng < 122.0):
            lng = None
        rec = {
            "name": name,
            "address": expand_address(addr, "臺北市", district if district != "區" else ""),
            "county": "臺北市",
            "district": district if len(district) >= 3 else "",
            "hours": hours,
            "type": TYPE_TEMP,
            "sources": ["tpe_vendor"],
        }
        if lat is not None and lng is not None:
            rec["lat"], rec["lng"], rec["geo"] = lat, lng, "dms"
        db.add(rec)
        n += 1
    print(f"ingested Taipei vendors {n}")


def ingest_ntpc(db: MarketDB):
    rows = read_csv(RAW / "ntpc_market_supermarket.csv")
    for r in rows:
        typ = clean_text(r.get("types") or "")
        name = clean_text(r.get("name") or "")
        extra = typ
        rec = {
            "name": name,
            "address": clean_text(r.get("address") or ""),
            "county": "新北市",
            "district": clean_text(r.get("town") or ""),
            "hours": typ,
            "sources": ["ntpc_ms"],
            "extra": extra,
        }
        if typ == "黃昏市場":
            rec["type"] = TYPE_DUSK
        elif "攤販" in name or "攤集" in name:
            rec["type"] = TYPE_VENDOR if "臨時" not in name else TYPE_TEMP
        elif typ in ("早市", "早市及黃昏市場", "早、午市", "店家"):
            rec["type"] = TYPE_PUBLIC
        db.add(rec)
    rows = read_csv(RAW / "ntpc_vendor.csv")
    for r in rows:
        name = clean_text(r.get("public_open－air_market") or r.get("public_open-air_market") or "")
        typ = clean_text(r.get("types") or "")
        rec = {
            "name": name,
            "address": clean_text(r.get("address") or ""),
            "county": "新北市",
            "district": clean_text(r.get("town") or ""),
            "hours": typ,
            "type": TYPE_DUSK if "黃昏" in typ or "黃昏" in name else TYPE_VENDOR,
            "sources": ["ntpc_vendor"],
            "extra": typ,
        }
        db.add(rec)
    print("ingested NTPC lists")


def parse_ty_intro() -> list[dict]:
    text = (RAW / "ty_intro.html").read_text(encoding="utf-8", errors="replace")
    tables = re.findall(r"<table[\s\S]*?</table>", text, re.I)
    if not tables:
        return []
    t = max(tables, key=len)
    rows = re.findall(r"<tr[\s\S]*?</tr>", t, re.I)
    out = []
    for row in rows:
        cells = re.findall(r"<t[dh][^>]*>([\s\S]*?)</t[dh]>", row, re.I)
        cells = [" ".join(re.sub("<[^>]+>", " ", c).split()) for c in cells]
        if len(cells) < 3 or cells[0] == "各區":
            continue
        out.append({
            "district": clean_text(cells[0]),
            "name": clean_text(cells[1]),
            "address": clean_text(cells[2]),
            "intro": clean_text(cells[3] if len(cells) > 3 else ""),
            "feature": clean_text(cells[4] if len(cells) > 4 else ""),
        })
    return out


def ingest_taoyuan(db: MarketDB):
    # city open data (older, missing 忠貞 / some rebuild notes)
    for r in read_csv(RAW / "ty_public.csv"):
        name = clean_text(r.get("市場名稱") or "")
        feat = clean_text(r.get("特色說明") or "") + clean_text(r.get("市場介紹") or "")
        rec = {
            "name": re.sub(r"[-－]委外.*$", "", name).replace("(委外)", "").strip(),
            "address": expand_address(clean_text(r.get("地址") or ""), "桃園市", clean_text(r.get("各區") or "")),
            "county": "桃園市",
            "district": clean_text(r.get("各區") or ""),
            "type": TYPE_PUBLIC,
            "sources": ["ty_open"],
            "extra": feat,
            "note": "",
        }
        db.add(rec)

    for r in parse_ty_intro():
        raw_name = r["name"]
        feat = r["intro"] + " " + r["feature"]
        # exclude supermarket-only outsourced sites
        supermarket_only = any(x in raw_name for x in ("樂善", "新路", "大竹", "僑愛", "新富")) and (
            "全聯" in raw_name or "全聯" in feat or "生鮮超市" in feat or "超級市場" in feat
        )
        if supermarket_only or ("平鎮" in r["district"] and "第一公有" in raw_name) or (
            "觀音" in raw_name or ("觀音" in r["district"] and "超市" in feat)
        ):
            db.skipped["超市／量販"] += 1
            continue
        if "夜市" in raw_name:
            db.skipped["夜市"] += 1
            continue
        name = re.sub(r"[（(]委外.*?[)）]", "", raw_name).strip()
        name = name.replace("(委外-麗陽公司)", "").replace("(委外)", "").strip()
        note = ""
        if "中壢" in r["district"] and "第一公有" in name:
            note = "106年拆除改建，現由麗陽公司經營商場空間；官方名稱仍為第一公有零售市場。"
        if "東門" in name and "20攤" in feat:
            note = "原攤商約 20 攤進駐，其餘樓層有超市等其他使用。"
        rec = {
            "name": name if "公有" in name or "永和" in name or "忠貞" in name else name,
            "address": expand_address(r["address"], "桃園市", r["district"]),
            "county": "桃園市",
            "district": r["district"],
            "type": TYPE_PUBLIC,
            "sources": ["ty_edb"],
            "note": note,
            "extra": feat,
        }
        db.add(rec)

    for name, typ, county in TY_ROSTER_EXTRA:
        db.add({
            "name": name,
            "county": county,
            "type": typ,
            "sources": ["ty_roster"],
            "address": "",
        })
    print("ingested Taoyuan lists")


def ingest_hsinchu(db: MarketDB):
    for r in read_csv(RAW / "hc_public.csv"):
        db.add({
            "name": clean_text(r.get("市場名稱") or ""),
            "address": expand_address(clean_text(r.get("地址") or ""), "新竹市"),
            "county": "新竹市",
            "hours": clean_text(r.get("營業週期") or ""),
            "type": TYPE_PUBLIC,
            "sources": ["hc_public"],
        })
    print("ingested Hsinchu City public list")


def dump(db: MarketDB):
    markets = []
    for i, rec in enumerate(sorted(db.items, key=lambda x: (x.get("county") or "", x.get("district") or "", x["name"])), 1):
        markets.append({
            "id": f"m{i:04d}",
            "name": rec["name"],
            "type": rec["type"],
            "hours": rec.get("hours") or "",
            "lat": rec["lat"],
            "lng": rec["lng"],
            "address": rec.get("address") or "",
            "county": rec.get("county") or "",
            "cid": rec.get("cid") or "",
            "district": rec.get("district") or "",
            "note": rec.get("note") or "",
            "src": rec.get("sources") or [],
            "osm": rec.get("osm") or "",
            "geo": rec.get("geo") or "",
        })

    by_county = Counter(m["county"] for m in markets)
    by_type = Counter(m["type"] for m in markets)
    by_district = Counter(f"{m['county']}{m['district']}" for m in markets)

    # coverage vs AOC 114 Q4 published aggregates
    aoc = {
        "臺北市": "傳統市場 公有51 民有5；攤集區 公有6 民有28",
        "新北市": "傳統市場 公有34 民有6；攤集區 公有8 民有125（民有攤集區開放資料幾乎未公布）",
        "桃園市": "傳統市場 公有18 民有34；攤集區 公有0 民有1",
        "新竹市": "傳統市場 公有10 民有0；攤集區 公有3",
        "新竹縣": "傳統市場 公有12 民有0；攤集區 公有6 民有1",
    }
    gaps = [
        "經濟部全國檔直連 cto.moea.gov.tw 被 Cloudflare 阻擋，改由 data.gov.tw 品質下載介面取得。",
        "夜市、超市／全聯／量販、美食廣場、批發市場、玉市與觀光賣店不列入傳統市場競爭層。",
        "桃園部分公有市場用地已委外作為全聯或百貨（樂善、新路、大竹、僑愛、新富、觀音多功能場館、平鎮第一／寶雅），未列入。中壢第一公有零售市場改建為商場後仍依官方名稱列入。",
        "新北市民有攤販集中區官方統計約 125 處，開放資料僅公布少數公有攤集區；其餘若 OSM 有標 marketplace 才補上。",
        "未經列管的早市、巷口菜市若未出現在官方名單或 OSM marketplace，不會出現在地圖上，請勿把空白當成該地沒有市集。",
        f"無法定位而未列入：{len(db.unmatched)} 筆。",
    ]
    for county, desc in aoc.items():
        gaps.append(f"{county}監察院／經濟部 114 年第 4 季列管統計為「{desc}」；本層實際收入 {by_county.get(county, 0)} 處（口徑含 OSM 補遺、且已排除夜市與超市）。")

    payload = {
        "generated": "2026-11-10",
        "count": len(markets),
        "byCounty": dict(by_county),
        "byType": dict(by_type),
        "byDistrict": {k: v for k, v in by_district.items() if v},
        "types": [
            {"id": TYPE_PUBLIC, "color": "#c2410c", "label": TYPE_PUBLIC},
            {"id": TYPE_PRIVATE, "color": "#d97706", "label": TYPE_PRIVATE},
            {"id": TYPE_VENDOR, "color": "#0f766e", "label": TYPE_VENDOR},
            {"id": TYPE_TEMP, "color": "#0369a1", "label": TYPE_TEMP},
            {"id": TYPE_DUSK, "color": "#7c3aed", "label": TYPE_DUSK},
            {"id": TYPE_MORNING, "color": "#db2777", "label": TYPE_MORNING},
        ],
        "sources": list(SOURCES.values()),
        "gaps": gaps,
        "unmatched": [
            {"name": u.get("name"), "address": u.get("address"), "county": u.get("county"), "why": u.get("why", "geocode-failed")}
            for u in db.unmatched
        ],
        "skipped": dict(db.skipped),
        "markets": markets,
    }
    OUT.write_text(json.dumps(payload, ensure_ascii=False, separators=(",", ":")))
    print(f"wrote {OUT} count={len(markets)} bytes={OUT.stat().st_size}")
    print("by county", dict(by_county))
    print("by type", dict(by_type))
    print("skipped", dict(db.skipped))
    print("unmatched", len(db.unmatched))
    for u in db.unmatched:
        print("  unmatched:", u.get("name"), u.get("address"), u.get("county"), u.get("why", ""))
    for key in ("桃園市中壢區", "桃園市平鎮區"):
        print(key, by_district.get(key, 0), [m["name"] for m in markets if key == m["county"] + m["district"]])
    # Zhongli station distances
    slat, slng = 24.953317, 121.22616
    nearby = []
    for m in markets:
        d = haversine(slat, slng, m["lat"], m["lng"])
        if d <= 1200:
            nearby.append((d, m))
    nearby.sort()
    print("near 中壢火車站:")
    for d, m in nearby:
        print(f"  {d:7.0f}m {m['type']:8} {m['name']} | {m['address']} | {m['geo']}")


def main():
    RAW.mkdir(parents=True, exist_ok=True)
    villages = VillageIndex()
    geocoder = Geocoder()
    osm, hints = load_osm()
    db = MarketDB(villages, geocoder, osm, hints)
    ingest_moea(db)
    ingest_tpe_traditional(db)
    ingest_tpe_private(db)
    ingest_tpe_vendors(db)
    ingest_ntpc(db)
    ingest_taoyuan(db)
    ingest_hsinchu(db)
    print(f"raw placed before merge {len(db.items)} unmatched {len(db.unmatched)}")
    db.merge()
    print(f"after merge {len(db.items)}")
    db.add_osm_only()
    db.merge()
    print(f"after OSM merge {len(db.items)}")
    geocoder.save()
    print(f"geocode cache hits={geocoder.hits} misses={geocoder.misses}")
    dump(db)


if __name__ == "__main__":
    main()
