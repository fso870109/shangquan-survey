#!/usr/bin/env python3
import json
from pathlib import Path
from playwright.sync_api import sync_playwright

BASE = "http://127.0.0.1:8877"
SHOT = Path("/workspace/shangquan/shots")
SHOT.mkdir(exist_ok=True)
OUT = Path("/tmp/sq-raw/income/ui_test.json")
OUT.parent.mkdir(parents=True, exist_ok=True)

def wait_stats(page, timeout=40000):
    page.wait_for_function("() => window.__sq && window.__sq.stats && window.__sq.stats() && window.__sq.stats().incMed != null", timeout=timeout)
    return page.evaluate("() => window.__sq.stats()")

def main():
    out = {}
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True)
        desktop = browser.new_context(viewport={"width": 1280, "height": 800}, locale="zh-TW")
        page = desktop.new_page()
        page.goto(BASE + "/index.html", wait_until="domcontentloaded", timeout=30000)
        stats500 = wait_stats(page)
        page.wait_for_timeout(700)
        page.screenshot(path=str(SHOT / "feat-income-desktop-zhongli-500.png"))
        # expand village list
        page.evaluate("document.querySelector('#villListWrap')?.setAttribute('open','')")
        page.wait_for_timeout(300)
        page.screenshot(path=str(SHOT / "feat-income-desktop-zhongli-500-vills.png"))

        # admin choropleth 所得中位數, 中壢區
        page.click("#btnModeAdmin")
        page.wait_for_timeout(1500)
        page.select_option("#indicatorSelect", "incMed")
        page.wait_for_timeout(800)
        picked = page.evaluate("""async () => {
          const districts = document.querySelectorAll('#districtBtns button');
          for (const b of districts) {
            if (b.textContent.includes('中壢')) { b.click(); return b.textContent; }
          }
          return null;
        }""")
        page.wait_for_timeout(1500)
        admin = page.evaluate("() => window.__sq.stats()")
        page.screenshot(path=str(SHOT / "feat-income-desktop-admin-zhongli.png"))

        # predictor
        page.click("#btnModePredict")
        page.wait_for_timeout(400)
        page.select_option("#predictMetric", "perMkt")
        page.select_option("#predictDir", "desc")
        page.fill("#predictMinPop", "5000")
        page.fill("#predictMinInc", "70")
        page.select_option("#predictCounty", "taoyuan")
        page.select_option("#predictRadius", "800")
        page.select_option("#predictTopN", "10")
        page.click("#predictRun")
        page.wait_for_function(
            "() => window.__sq && window.__sq.predictResults && window.__sq.predictResults().length > 0",
            timeout=120000,
        )
        page.wait_for_timeout(600)
        preds = page.evaluate("() => window.__sq.predictResults()")
        status = page.evaluate("() => document.getElementById('predictStatus')?.textContent")
        page.screenshot(path=str(SHOT / "feat-income-desktop-predict.png"))

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
        mpage.wait_for_timeout(700)
        mpage.screenshot(path=str(SHOT / "feat-income-mobile-zhongli-500.png"), full_page=True)
        # scroll to income metrics
        mpage.evaluate("document.querySelector('.metric-grid')?.scrollIntoView()")
        mpage.wait_for_timeout(200)
        mpage.screenshot(path=str(SHOT / "feat-income-mobile-zhongli-500-metrics.png"))
        mobile.close()
        browser.close()

    out = {
        "desktop500": stats500,
        "adminZhongli": admin,
        "adminPicked": picked,
        "predict": preds,
        "predictStatus": status,
        "mobile500": mstats,
    }
    OUT.write_text(json.dumps(out, ensure_ascii=False, indent=2))
    print("wrote", OUT)
    print("=== 500m income ===")
    print("incMed", stats500.get("incMed"), "incAvg", stats500.get("incAvg"),
          "countyMed", stats500.get("countyIncMed"), "countyAvg", stats500.get("countyIncAvg"))
    print("home", stats500.get("home"), "pop", stats500.get("pop"))
    for h in stats500.get("hitIncome") or []:
        print(f"  {h['name']} 覆蓋 {h['ratio']}% 中位數 {h.get('incMed')} 平均 {h.get('incAvg')} {h.get('how') or ''} {h.get('from') or ''}")
    print("=== admin 中壢 ===")
    print("kind", admin.get("kind"), "incMed", admin.get("incMed"), "incAvg", admin.get("incAvg"), "picked", picked)
    print("=== predict ===")
    print(status)
    for r in preds:
        print(f"  {r['rank']} {r['district']}{r['village']} pop={r['pop']:.0f} mk={r.get('mk')} perMkt={r.get('perMkt')} incMed={r.get('incMed')} near={r.get('nearMkt')}")
    print("=== mobile ===")
    print("incMed", mstats.get("incMed"), "incAvg", mstats.get("incAvg"))

if __name__ == "__main__":
    main()
