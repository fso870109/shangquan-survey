# 商圈調查小幫手

北台灣（臺北市、新北市、桃園市、新竹市、新竹縣）步行圈／行政區人口與連鎖品牌查詢工具。靜態網站，資料預先計算為 JSON。

## 資料來源

| 資料 | 來源 | 日期 |
| --- | --- | --- |
| 村里戶數、單一年齡人口 | 內政部戶政司 ODRP014（[data.gov.tw/dataset/77132](https://data.gov.tw/dataset/77132)） | 現況：民國115年9月；近1年：114年9月；近5年：110年9月 |
| 村里界 | 內政部國土測繪中心 VILLAGE_NLSC_1150817（[data.gov.tw/dataset/7438](https://data.gov.tw/dataset/7438)） | 2026-08-17 |
| 7-ELEVEN 門市 | 統一超商官方電子地圖 EMapSDK SearchStore | 2026-11-10 |
| 全家、星巴克、麥當勞、車站 | OpenStreetMap（Geofabrik `taiwan-latest.osm.pbf`） | 2026-11-08 |
| 底圖 | 內政部國土測繪中心臺灣通用電子地圖 EMAP WMTS | — |
| 全國零售市場基本資料 | 經濟部商業發展署（[data.gov.tw/dataset/59855](https://data.gov.tw/dataset/59855)） | 品管 2026-09-18 |
| 臺北市傳統市(商)場、民有市場、攤販集中場 | 臺北市市場處 | 2026-03～2026-11 |
| 新北市公有市場及超市清冊、公有攤販集中場 | 新北市市場處 | 2025-12、2026-08 |
| 桃園市公有零售市場與市集名冊 | 桃園市政府經濟發展局 | 2025-06 開放資料；介紹頁與名冊 2026-11-10 擷取 |
| 新竹市公有零售市場名冊 | 新竹市政府（[data.gov.tw/dataset/67539](https://data.gov.tw/dataset/67539)） | 2025-11-17 |
| 傳統市場座標核對與補遺 | OpenStreetMap amenity=marketplace | 2026-11-08 |
| 綜稅綜合所得總額各縣市鄉鎮村里統計分析表 | 財政部財政資訊中心（[data.gov.tw/dataset/103066](https://data.gov.tw/dataset/103066)） | 112年度（所得年 2023） |

全家官方門市 API（api.map.com.tw）目前無法取得有效資料，故改用 OSM。OSM 門市覆蓋率可能低於實際家數。

人口為**戶籍人口**，非常住人口。步行圈人口以「圓與村里多邊形相交面積／村里面積 × 村里人口」估算；圓若跨縣市會加總所有相交村里，比較基準為中心點所在縣市平均。

村里所得來自財政部綜合所得稅申報資料（不含免稅所得、政府移轉支出與分離課稅所得；金額原表為千元）。步行圈顯示各里中位數／平均數按納稅單位加權平均，並與所在縣市同樣口徑比較；行政區則採用各區合計列。114–115 年新設里沿用分里前原里的 112 年統計，納稅單位依現況戶數比例拆分。

點位預判器以約 250 公尺間距網格預先計算 300／500／800m 步行圈估算（`scripts/build_grid.py`），上榜點會再以約一個半徑的距離去重。

## 重建資料

```bash
python3 scripts/fetch_stores.py   # 需先有村里界 shapefile
python3 scripts/build_data.py
python3 scripts/build_grid.py   # 點位預判器網格
python3 scripts/build_markets.py  # 傳統市場（政府名單 + OSM 核對）
python3 scripts/build_income.py   # 村里綜合所得（財政部 112 年度表）
```
