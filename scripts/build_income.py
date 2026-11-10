#!/usr/bin/env python3
"""Join FIA 112 village comprehensive-income tables to current village polygons.

Source: 財政部財政資訊中心「綜稅綜合所得總額各縣市鄉鎮村里統計分析表」112年度
(所得年 2023). Amounts are in 千元. The tables are filed tax data and do not
include tax-exempt income, government transfers, or separately-taxed income.
National dataset: https://data.gov.tw/dataset/103066
Per-county CSVs: https://www.fia.gov.tw/WEB/fia/ias/ias112/112_165-{A,F,H,O,J}.csv

Name mismatches (rare characters, bracketed glyphs) are normalised. Villages
created by 114–115 splits inherit the pre-split 里's published 112 figures;
納稅單位 is redistributed by current household counts so a circle covering
both the parent and the child does not double-count. 大園區海口里 combines the
112 海口里 + 原竹圍里 rows (the old 竹圍里 was merged into 海口里); the
current 竹圍里 (carved from 大海里 on 115-03-01) inherits 大海里.
"""
from __future__ import annotations

import csv
import io
import json
import sys
from pathlib import Path
from urllib.request import Request, urlopen

ROOT = Path(__file__).resolve().parents[1]
DATA = ROOT / "data"
CACHE = Path("/tmp/sq-raw/income")
CACHE.mkdir(parents=True, exist_ok=True)

FIA_FILES = {
    "A": {"county": "臺北市", "file": "taipei.json", "url": "https://www.fia.gov.tw/WEB/fia/ias/ias112/112_165-A.csv"},
    "F": {"county": "新北市", "file": "newtaipei.json", "url": "https://www.fia.gov.tw/WEB/fia/ias/ias112/112_165-F.csv"},
    "H": {"county": "桃園市", "file": "taoyuan.json", "url": "https://www.fia.gov.tw/WEB/fia/ias/ias112/112_165-H.csv"},
    "O": {"county": "新竹市", "file": "hsinchu_city.json", "url": "https://www.fia.gov.tw/WEB/fia/ias/ias112/112_165-O.csv"},
    "J": {"county": "新竹縣", "file": "hsinchu_county.json", "url": "https://www.fia.gov.tw/WEB/fia/ias/ias112/112_165-J.csv"},
}

# Simple 1-parent splits (parent kept its name; listed names are the new 里).
# 桃園市 115-03-01: https://cab.tycg.gov.tw/News_Content.aspx?n=7802&s=1600187
# 新北市 115-07-01: https://www.ca.ntpc.gov.tw/ (114年轄里編組調整案)
# 新竹縣新豐鄉 114-10-01: 松柏村分設明新村
SIMPLE_SPLITS = [
    ("桃園市", "桃園區", "同安里", ["藝文里"]),
    ("桃園市", "桃園區", "莊敬里", ["幸福里"]),
    ("桃園市", "桃園區", "大有里", ["民有里"]),
    ("桃園市", "中壢區", "青埔里", ["青航里", "青園里"]),
    ("桃園市", "中壢區", "過嶺里", ["松嶺里"]),
    ("桃園市", "八德區", "大和里", ["大盛里"]),
    ("桃園市", "龜山區", "文青里", ["文藝里"]),
    ("桃園市", "大園區", "南港里", ["新南里"]),
    ("桃園市", "大園區", "田心里", ["仁德里"]),
    ("桃園市", "大園區", "大海里", ["竹圍里"]),  # new 竹圍里; old 竹圍里 merged into 海口里
    ("新北市", "林口區", "南勢里", ["新林里", "力行里"]),
    ("新北市", "林口區", "湖南里", ["頭湖里", "文湖里"]),
    ("新北市", "淡水區", "崁頂里", ["新崁里", "新市里"]),
    ("新竹縣", "新豐鄉", "松柏村", ["明新村"]),
]

# Several parents redrawn together into parents + new children.
JOINT_SPLITS = [
    ("桃園市", "龜山區", ["樂善里", "長庚里"], ["文桃里", "文樂里", "長樂里"]),
    ("新北市", "五股區", ["成泰里", "成功里"], ["芳洲里"]),
]

# Surviving village absorbed another village that later reused its name elsewhere.
MERGES = [
    # 原竹圍里併入海口里（115-03-01）。FIA 112 竹圍里 is the old village.
    ("桃園市", "大園區", ["海口里", "竹圍里"], "海口里"),
]

REPL = {
    "臺": "台",
    "舘": "館",
    "羣": "群",
    "峯": "峰",
    "濓": "濂",
    "𥕢": "曹",
    "\U000fffb5": "獇",  # FIA private-use glyph for 獇寮里
}


def norm(s: str) -> str:
    s = (s or "").strip().replace("\u3000", "").replace(" ", "")
    s = s.replace("[", "").replace("]", "")
    for a, b in REPL.items():
        s = s.replace(a, b)
    return s


def num(val):
    if val is None:
        return None
    s = str(val).strip().replace(",", "")
    if s == "" or s == "-":
        return None
    try:
        f = float(s)
    except ValueError:
        return None
    return f


def download(code: str, url: str) -> Path:
    dest = CACHE / f"112_165-{code}.csv"
    if dest.exists() and dest.stat().st_size > 1000:
        return dest
    req = Request(url, headers={"User-Agent": "shangquan-survey/income (research)"})
    with urlopen(req, timeout=40) as resp:
        dest.write_bytes(resp.read())
    return dest


def parse_fia(path: Path, county: str):
    raw = path.read_text(encoding="utf-8-sig")
    rows = list(csv.DictReader(io.StringIO(raw)))
    villages = []
    totals = []
    other = []
    for r in rows:
        keys = {(k or "").lstrip("\ufeff").strip(): v for k, v in r.items()}
        citydist = (keys.get("縣市別") or "").strip()
        vill = (keys.get("村里") or "").strip()
        dist = citydist
        for variant in (county, county.replace("臺", "台"), county.replace("台", "臺")):
            if citydist.startswith(variant):
                dist = citydist[len(variant):]
                break
        rec = {
            "district": dist,
            "vill": vill,
            "n": num(keys.get("納稅單位(戶)") or keys.get("納稅單位")),
            "sum": num(keys.get("綜合所得總額")),
            "avg": num(keys.get("平均數")),
            "med": num(keys.get("中位數")),
            "q1": num(keys.get("第一分位數")),
            "q3": num(keys.get("第三分位數")),
        }
        if dist in ("其他",) or vill in ("其他",):
            other.append(rec)
            continue
        if vill == "合計":
            totals.append(rec)
            continue
        villages.append(rec)
    return villages, totals, other


def wavg(recs, key):
    w = sum((r.get("n") or 0) for r in recs)
    if w <= 0:
        return None
    s = 0.0
    ww = 0.0
    for r in recs:
        if r.get(key) is None or not r.get("n"):
            continue
        s += r[key] * r["n"]
        ww += r["n"]
    return s / ww if ww else None


def compact(rec, how, src=None, n=None):
    out = {
        "n": round(n if n is not None else rec["n"], 2),
        "avg": rec.get("avg"),
        "med": rec.get("med"),
        "q1": rec.get("q1"),
        "q3": rec.get("q3"),
        "how": how,
    }
    if src:
        out["from"] = src
    return out


def main():
    attached = {}  # village id -> rec
    districts_out = {}
    notes = []
    join = {
        "polygons": 0,
        "direct": 0,
        "alias": 0,
        "inherited": 0,
        "merged": 0,
        "unmatchedPoly": [],
        "unmatchedFia": [],
    }
    county_out = {}

    for code, meta in FIA_FILES.items():
        county = meta["county"]
        path = download(code, meta["url"])
        # prefer already-downloaded probe file if download somehow empty
        if path.stat().st_size < 1000:
            probe = CACHE / f"probe_{code}.csv"
            if probe.exists():
                path = probe
        fia_vills, fia_tot, _fia_other = parse_fia(path, county)
        poly = json.loads((DATA / meta["file"]).read_text())
        villages = poly["villages"]
        join["polygons"] += len(villages)

        by_key = {}
        for v in villages:
            by_key[(norm(v["district"]), norm(v["name"]))] = v

        fia_by_key = {}
        unmatched_fia = []
        used_poly = set()
        used_fia = set()

        for rec in fia_vills:
            k = (norm(rec["district"]), norm(rec["vill"]))
            fia_by_key[k] = rec
            v = by_key.get(k)
            if v:
                attached[v["id"]] = compact(rec, "direct")
                used_poly.add(v["id"])
                used_fia.add(k)
                join["direct"] += 1
            else:
                unmatched_fia.append(rec)

        still_fia = []
        for rec in unmatched_fia:
            k = (norm(rec["district"]), norm(rec["vill"]))
            if k in used_fia:
                continue
            # already handled
            still_fia.append(rec)
        join["unmatchedFia"].extend(
            f"{county}{r['district']}{r['vill']}" for r in still_fia
        )

        # district official 合計
        dist_code = {d["name"]: d["code"] for d in poly["districts"]}
        for rec in fia_tot:
            dc = dist_code.get(rec["district"])
            if not dc:
                # try normalised
                for name, c in dist_code.items():
                    if norm(name) == norm(rec["district"]):
                        dc = c
                        break
            if not dc:
                notes.append(f"{county} 合計列無法對上行政區：{rec['district']}")
                continue
            districts_out[dc] = {
                "n": rec["n"],
                "avg": rec["avg"],
                "med": rec["med"],
                "q1": rec["q1"],
                "q3": rec["q3"],
                "how": "official-total",
                "county": county,
                "district": rec["district"],
            }

        def find_poly(district, name):
            return by_key.get((norm(district), norm(name)))

        def find_fia(district, name):
            return fia_by_key.get((norm(district), norm(name)))

        # Special merge: 海口里 absorbs old 竹圍里, before 大海里→新竹圍里 inherit.
        for m_county, m_dist, sources, target_name in MERGES:
            if m_county != county:
                continue
            src_recs = []
            missing = []
            for nm in sources:
                r = find_fia(m_dist, nm)
                if not r:
                    missing.append(nm)
                else:
                    src_recs.append(r)
            target = find_poly(m_dist, target_name)
            if missing or not target or not src_recs:
                notes.append(f"合併失敗 {county}{m_dist} {'+'.join(sources)} → {target_name}: missing {missing}")
                continue
            n = sum(r["n"] or 0 for r in src_recs)
            merged = {
                "n": n,
                "avg": wavg(src_recs, "avg"),
                "med": wavg(src_recs, "med"),
                "q1": wavg(src_recs, "q1"),
                "q3": wavg(src_recs, "q3"),
            }
            attached[target["id"]] = compact(
                merged, "merge", src="、".join(sources), n=n
            )
            used_poly.add(target["id"])
            join["merged"] += 1
            # If current 竹圍里 was name-matched to old 竹圍里, drop that false match
            # so the subsequent 大海里 split can claim it.
            reused = [nm for nm in sources if nm != target_name]
            for nm in reused:
                p = find_poly(m_dist, nm)
                if p and p["id"] in attached and attached[p["id"]].get("how") == "direct":
                    del attached[p["id"]]
                    used_poly.discard(p["id"])
                    join["direct"] -= 1
                    notes.append(
                        f"{county}{m_dist}{nm} 名稱與已裁撤之舊里相同，已改為沿用分出它的原里，不沿用舊{nm}的 112 年數字"
                    )

        def redistribute(group_polys, src_recs, how, src_label):
            n = sum(r["n"] or 0 for r in src_recs)
            if n <= 0 or not group_polys:
                return 0
            stats = {
                "n": n,
                "avg": wavg(src_recs, "avg"),
                "med": wavg(src_recs, "med"),
                "q1": wavg(src_recs, "q1"),
                "q3": wavg(src_recs, "q3"),
            }
            total_hh = sum((v.get("hh") or 0) for v in group_polys)
            count = 0
            for v in group_polys:
                share_n = n * ((v.get("hh") or 0) / total_hh) if total_hh else n / len(group_polys)
                is_new = v["name"] not in {r["vill"] for r in src_recs} and norm(v["name"]) not in {
                    norm(r["vill"]) for r in src_recs
                }
                attached[v["id"]] = compact(
                    stats,
                    "inherit" if is_new else how,
                    src=src_label,
                    n=share_n,
                )
                used_poly.add(v["id"])
                if is_new:
                    count += 1
            return count

        for s_county, s_dist, parent, children in SIMPLE_SPLITS:
            if s_county != county:
                continue
            src = find_fia(s_dist, parent)
            parent_poly = find_poly(s_dist, parent)
            child_polys = [find_poly(s_dist, c) for c in children]
            if not src or not parent_poly or any(c is None for c in child_polys):
                notes.append(f"分里對應失敗 {county}{s_dist}{parent} → {children}")
                continue
            n_new = redistribute(
                [parent_poly] + child_polys, [src], "split", parent
            )
            join["inherited"] += n_new

        for s_county, s_dist, parents, children in JOINT_SPLITS:
            if s_county != county:
                continue
            src_recs = [find_fia(s_dist, p) for p in parents]
            parent_polys = [find_poly(s_dist, p) for p in parents]
            child_polys = [find_poly(s_dist, c) for c in children]
            if any(x is None for x in src_recs + parent_polys + child_polys):
                notes.append(f"共同分里對應失敗 {county}{s_dist} {parents} → {children}")
                continue
            n_new = redistribute(
                parent_polys + child_polys, src_recs, "split-joint", "、".join(parents)
            )
            join["inherited"] += n_new

        unmatched_poly = [
            f"{county}{v['district']}{v['name']}"
            for v in villages
            if v["id"] not in attached
        ]
        join["unmatchedPoly"].extend(unmatched_poly)

        matched = [attached[v["id"]] for v in villages if v["id"] in attached]
        county_out[county] = {
            "id": poly["id"],
            "n": round(sum(r["n"] or 0 for r in matched), 2),
            "avgW": wavg(matched, "avg"),
            "medW": wavg(matched, "med"),
            "villages": len(villages),
            "matched": len(matched),
        }
        print(
            f"{county}: poly {len(villages)}  matched {len(matched)}  "
            f"direct-ish {sum(1 for v in villages if attached.get(v['id'], {}).get('how') == 'direct')}  "
            f"unmatched {len(unmatched_poly)}"
        )
        if unmatched_poly:
            print("  unmatched", unmatched_poly)

    rate = (join["polygons"] - len(join["unmatchedPoly"])) / join["polygons"] if join["polygons"] else 0
    join["matched"] = join["polygons"] - len(join["unmatchedPoly"])
    join["rate"] = round(rate, 4)
    # alias count: name-normalised matches are included in direct; report charset notes separately
    join["notes"] = notes + [
        "「其他」「合計」列不對入村里多邊形；合計列作為該鄉鎮市區的官方中位數／平均數。",
        "114–115 年分出的新里沿用分里前原里的 112 年中位數與平均數，納稅單位依現況戶數比例拆分。",
        "龜山區文桃里、文樂里、長樂里由樂善里與長庚里共同調整分出；五股區芳洲里由成泰里與成功里共同調整分出。這些里的中位數為原里納稅單位加權平均，並非獨立申報中位數。",
        "大園區海口里為 112 年海口里與原竹圍里合併推估；現竹圍里沿用原大海里（航空城安置街廓新設）。",
    ]

    out = {
        "year": 112,
        "incomeYear": 2023,
        "unit": "千元",
        "label": "綜合所得稅申報資料，不含免稅所得、政府移轉支出與分離課稅所得。所得年 112（2023）。",
        "source": {
            "name": "綜稅綜合所得總額各縣市鄉鎮村里統計分析表",
            "org": "財政部財政資訊中心",
            "dataset": "https://data.gov.tw/dataset/103066",
            "pageUpdated": "2026-09-23",
            "files": [
                {"county": m["county"], "url": m["url"], "code": code}
                for code, m in FIA_FILES.items()
            ],
        },
        "join": join,
        "counties": county_out,
        "districts": districts_out,
        "villages": attached,
    }
    dest = DATA / "income.json"
    dest.write_text(json.dumps(out, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    print(f"wrote {dest} ({dest.stat().st_size} bytes)")
    print(
        f"join {join['matched']}/{join['polygons']} = {join['rate']:.1%}  "
        f"direct {join['direct']} inherited {join['inherited']} merged {join['merged']}"
    )
    if join["unmatchedPoly"]:
        print("UNMATCHED POLYGONS remain:", join["unmatchedPoly"])
        return 1
    if notes:
        print("notes:")
        for n in notes:
            print(" -", n)
    return 0


if __name__ == "__main__":
    sys.exit(main())
