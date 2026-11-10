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

全家官方門市 API（api.map.com.tw）目前無法取得有效資料，故改用 OSM。OSM 門市覆蓋率可能低於實際家數。

人口為**戶籍人口**，非常住人口。步行圈人口以「圓與村里多邊形相交面積／村里面積 × 村里人口」估算。

## 重建資料

```bash
python3 scripts/fetch_stores.py   # 需先有村里界 shapefile
python3 scripts/build_data.py
```
