#!/usr/bin/env python3
import json
import time
from pathlib import Path
from playwright.sync_api import sync_playwright

BASE = "http://127.0.0.1:8877"
SHOT = Path("/workspace/shangquan/shots")
SHOT.mkdir(exist_ok=True)
OUT = Path("/tmp/sq-raw/markets/ui_test.json")

def wait_stats(page, timeout=30000):
    page.wait_for_function("() => window.__sq && window.__sq.stats && window.__sq.stats()", timeout=timeout)
    return page.evaluate("() => window.__sq.stats()")

def run_desktop(page):
    page.set_viewport_size({"width": 1280, "height": 800})
    page.goto(BASE + "/index.html", wait_until="domcontentloaded", timeout=30000)
    stats500 = wait_stats(page)
    page.wait_for_timeout(800)
    page.screenshot(path=str(SHOT / "feat-markets-desktop-zhongli-500.png"), full_page=True)
    page.click("#tabMarket")
    page.wait_for_timeout(400)
    page.screenshot(path=str(SHOT / "feat-markets-desktop-zhongli-500-list.png"), full_page=True)

    # 800m should include 中壢第一 (533m)
    page.click("#radiusBar button[data-r='800']")
    page.wait_for_timeout(1200)
    stats800 = wait_stats(page)

    # 平鎮／忠貞
    page.evaluate("() => window.__sq.go(24.928719, 121.253007, '忠貞市場')")
    page.wait_for_timeout(1500)
    stats_zz = wait_stats(page)
    page.screenshot(path=str(SHOT / "feat-markets-desktop-pingzhen-zhongzhen.png"), full_page=True)

    # predictor
    page.click("#btnModePredict")
    page.wait_for_timeout(400)
    page.select_option("#predictMetric", "perMkt")
    page.select_option("#predictDir", "desc")
    page.fill("#predictMinPop", "5000")
    page.select_option("#predictCounty", "taoyuan")
    page.select_option("#predictRadius", "800")
    page.select_option("#predictTopN", "10")
    page.click("#predictRun")
    page.wait_for_function(
        "() => window.__sq && window.__sq.predictResults && window.__sq.predictResults().length > 0",
        timeout=90000,
    )
    page.wait_for_timeout(600)
    preds = page.evaluate("() => window.__sq.predictResults()")
    page.screenshot(path=str(SHOT / "feat-markets-desktop-predict-permkt.png"), full_page=True)
    return {
        "stats500": stats500,
        "stats800": stats800,
        "statsZhongzhen": stats_zz,
        "predict": preds,
    }

def run_mobile(page):
    page.set_viewport_size({"width": 412, "height": 915})
    page.goto(BASE + "/index.html", wait_until="domcontentloaded", timeout=30000)
    stats = wait_stats(page)
    page.wait_for_timeout(800)
    page.screenshot(path=str(SHOT / "feat-markets-mobile-zhongli-500.png"), full_page=True)
    page.click("#tabMarket")
    page.wait_for_timeout(400)
    page.evaluate("document.getElementById('marketSection')?.scrollIntoView()")
    page.wait_for_timeout(300)
    page.screenshot(path=str(SHOT / "feat-markets-mobile-zhongli-500-list.png"), full_page=True)
    return stats

def main():
    out = {}
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True)
        desktop = browser.new_context(
            viewport={"width": 1280, "height": 800},
            locale="zh-TW",
        )
        dpage = desktop.new_page()
        out["desktop"] = run_desktop(dpage)
        desktop.close()

        mobile = browser.new_context(
            viewport={"width": 412, "height": 915},
            locale="zh-TW",
            user_agent=(
                "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 "
                "(KHTML, like Gecko) Chrome/122.0.0.0 Mobile Safari/537.36"
            ),
            is_mobile=True,
            has_touch=True,
        )
        mpage = mobile.new_page()
        out["mobile"] = run_mobile(mpage)
        mobile.close()
        browser.close()
    OUT.write_text(json.dumps(out, ensure_ascii=False, indent=2))
    print("wrote", OUT)
    d = out["desktop"]
    print("=== 500m ===")
    print("count", d["stats500"].get("marketCount"), "nearest", d["stats500"].get("nearestMarket"))
    print("inside", d["stats500"].get("markets"))
    print("=== 800m ===")
    print("count", d["stats800"].get("marketCount"))
    for m in d["stats800"].get("markets") or []:
        print(f"  {m['dist']:.0f} {m['name']} {m['type']} {m.get('address')}")
    print("=== 忠貞 500m ===")
    print("count", d["statsZhongzhen"].get("marketCount"), "nearest", d["statsZhongzhen"].get("nearestMarket"))
    for m in d["statsZhongzhen"].get("markets") or []:
        print(f"  {m['dist']:.0f} {m['name']} {m['type']}")
    print("=== predict top10 ===")
    for r in d["predict"]:
        print(f"  {r['rank']} {r['district']}{r['village']} pop={r['pop']} mk={r.get('mk')} perMkt={r.get('perMkt')} near={r.get('nearMkt')} value={r.get('value')}")
    print("mobile count", out["mobile"].get("marketCount"), "nearest", out["mobile"].get("nearestMarket"))

if __name__ == "__main__":
    main()
