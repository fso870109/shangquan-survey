#!/usr/bin/env python3
import json
from pathlib import Path
from playwright.sync_api import sync_playwright

BASE = "http://127.0.0.1:8877"
SHOT = Path("/workspace/shangquan/shots")
SHOT.mkdir(exist_ok=True)
OUT = Path("/tmp/sq-raw/open/ui_test.json")
OUT.parent.mkdir(parents=True, exist_ok=True)

DISTRICTS = [
    "桃園區", "中壢區", "平鎮區", "八德區", "楊梅區", "蘆竹區",
    "龜山區", "龍潭區", "大溪區", "大園區", "觀音區", "新屋區", "復興區",
]


def wait_stats(page, timeout=40000):
    page.wait_for_function(
        "() => window.__sq && window.__sq.stats && window.__sq.stats() && window.__sq.stats().shopDemand != null",
        timeout=timeout,
    )
    return page.evaluate("() => window.__sq.stats()")


def run_open_analysis(page):
    page.click("#btnModeOpen")
    page.wait_for_timeout(400)
    defaults = page.evaluate("""() => ({
      county: document.getElementById('openCounty')?.value,
      district: document.getElementById('openDistrict')?.value,
      radius: document.getElementById('openRadius')?.value,
      topN: document.getElementById('openTopN')?.value,
      minPop: document.getElementById('openMinPop')?.value,
      wD: document.getElementById('openWDemand')?.value,
      wC: document.getElementById('openWComp')?.value,
      wI: document.getElementById('openWInc')?.value,
      countyOpts: [...document.getElementById('openCounty').options].map(o => ({v:o.value, t:o.textContent})),
      districtOpts: [...document.getElementById('openDistrict').options].map(o => o.textContent),
      visible: !document.getElementById('openBody').hidden,
    })""")
    page.click("#openRun")
    page.wait_for_function(
        "() => window.__sq && window.__sq.openResults && window.__sq.openResults().length > 0",
        timeout=180000,
    )
    page.wait_for_timeout(800)
    payload = page.evaluate("""() => ({
      results: window.__sq.openResults(),
      byDistrict: window.__sq.openTopByDistrict(3),
      info: window.__sq.openRunInfo(),
      status: document.getElementById('openStatus')?.textContent,
      listCount: document.querySelectorAll('#openResults li').length,
    })""")
    payload["defaults"] = defaults
    return payload


def main():
    out = {}
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True)
        desktop = browser.new_context(viewport={"width": 1280, "height": 800}, locale="zh-TW")
        page = desktop.new_page()
        page.goto(BASE + "/index.html", wait_until="domcontentloaded", timeout=30000)
        stats500 = wait_stats(page)
        page.wait_for_timeout(500)

        payload = run_open_analysis(page)
        page.screenshot(path=str(SHOT / "feat-open-desktop-taoyuan-top.png"), full_page=True)
        # crop-ish second shot of just the panel list: scroll results into view
        page.evaluate("document.getElementById('openResults')?.scrollIntoView()")
        page.wait_for_timeout(200)
        page.screenshot(path=str(SHOT / "feat-open-desktop-taoyuan-list.png"))

        page.evaluate("document.querySelector('#openResults li')?.click()")
        page.wait_for_function(
            "() => window.__sq && window.__sq.stats && window.__sq.stats().kind === 'circle' && window.__sq.stats().shopDemand != null",
            timeout=40000,
        )
        page.wait_for_timeout(800)
        circle = page.evaluate("""() => {
          const tab = document.getElementById('tabOpen');
          const sec = document.getElementById('openSection');
          return {
            stats: window.__sq.stats(),
            tabActive: tab && tab.classList.contains('active'),
            sectionHidden: sec ? sec.hidden : null,
            sectionText: sec ? sec.innerText.slice(0, 500) : null,
            radius: document.querySelector('#radiusBar button.active')?.dataset.r,
          };
        }""")
        page.screenshot(path=str(SHOT / "feat-open-desktop-circle.png"), full_page=True)
        desktop.close()

        mobile = browser.new_context(
            viewport={"width": 412, "height": 915},
            locale="zh-TW",
            user_agent=("Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 "
                        "(KHTML, like Gecko) Chrome/122.0.0.0 Mobile Safari/537.36"),
            is_mobile=True,
            has_touch=True,
        )
        mpage = mobile.new_page()
        mpage.goto(BASE + "/index.html", wait_until="domcontentloaded", timeout=30000)
        mstats = wait_stats(mpage)
        mpage.wait_for_timeout(400)
        mpayload = run_open_analysis(mpage)
        mpage.screenshot(path=str(SHOT / "feat-open-mobile-taoyuan.png"), full_page=True)
        mobile.close()
        browser.close()

    out = {
        "desktop500": {
            "shopDemand": stats500.get("shopDemand"),
            "shopIndex": stats500.get("shopIndex"),
            "shopScore": stats500.get("shopScore"),
            "pop4059": stats500.get("pop4059"),
            "pop": stats500.get("pop"),
            "home": stats500.get("home"),
            "radius": stats500.get("radius"),
        },
        "open": payload,
        "circleAfterClick": {
            "shopDemand": (circle.get("stats") or {}).get("shopDemand"),
            "shopIndex": (circle.get("stats") or {}).get("shopIndex"),
            "shopScore": (circle.get("stats") or {}).get("shopScore"),
            "pop4059": (circle.get("stats") or {}).get("pop4059"),
            "marketCount": (circle.get("stats") or {}).get("marketCount"),
            "nearestMarket": (circle.get("stats") or {}).get("nearestMarket"),
            "radius": circle.get("radius"),
            "statsRadius": (circle.get("stats") or {}).get("radius"),
            "tabActive": circle.get("tabActive"),
            "sectionHidden": circle.get("sectionHidden"),
            "sectionText": circle.get("sectionText"),
            "place": (circle.get("stats") or {}).get("vill"),
        },
        "mobile500": {
            "shopDemand": mstats.get("shopDemand"),
            "shopIndex": mstats.get("shopIndex"),
            "pop": mstats.get("pop"),
        },
        "mobileOpen": {
            "defaults": mpayload.get("defaults"),
            "info": mpayload.get("info"),
            "status": mpayload.get("status"),
            "n": len(mpayload.get("results") or []),
            "top1": (mpayload.get("results") or [None])[0],
        },
    }
    OUT.write_text(json.dumps(out, ensure_ascii=False, indent=2))
    print("wrote", OUT)
    print("=== defaults ===")
    print(payload["defaults"])
    print("=== info ===")
    print(payload["info"])
    print("=== status ===")
    print(payload["status"])
    print("=== top 10 ===")
    for r in payload["results"]:
        print(
            f"  {r['rank']} {r['district']}{r['village']} demand={r['shopDemand']:.1f} "
            f"idx={r['shopIndex']:.2f} 4059={r['pop4059']:.1f} mk={r['mk']} "
            f"near={r['nearestMarket']} {None if r['nearMkt'] is None else round(r['nearMkt'])}m "
            f"inc={r['incMed']} score={r['score']:.2f}"
        )
    print("=== by district ===")
    by = payload["byDistrict"]
    for d in DISTRICTS:
        rows = by.get(d) or []
        print(f"-- {d} ({len(rows)})")
        for r in rows:
            print(
                f"  {r['rank']} {r['district']}{r['village']} demand={r['shopDemand']:.1f} "
                f"4059={r['pop4059']:.1f} mk={r['mk']} near={r['nearestMarket']} "
                f"{None if r['nearMkt'] is None else round(r['nearMkt'])}m "
                f"inc={r['incMed']} score={r['score']:.2f}"
            )
    missing = [d for d in DISTRICTS if d not in by]
    extra = [d for d in by if d not in DISTRICTS]
    print("missing districts", missing)
    print("extra districts", extra)
    print("=== circle after click ===")
    print(out["circleAfterClick"])
    print("=== mobile ===")
    print(out["mobileOpen"]["status"], "n", out["mobileOpen"]["n"])


if __name__ == "__main__":
    main()
