(() => {
  const BRANDS = {
    s711: { name: "7-ELEVEN", short: "7-11", color: "#f97316" },
    fami: { name: "全家", short: "全家", color: "#16a34a" },
    sbux: { name: "星巴克", short: "星巴克", color: "#00704A" },
    mcd: { name: "麥當勞", short: "麥當勞", color: "#dc2626" },
  };
  const AGE_LABELS = ["0–14歲", "15–24歲", "25–44歲", "45–64歲", "65歲以上"];
  const PY_LABELS = ["0-4","5-9","10-14","15-19","20-24","25-29","30-34","35-39","40-44","45-49","50-54","55-59","60-64","65-69","70-74","75-79","80-84","85+"];
  const RADIUS_WALK = { 300: "約4分鐘", 500: "約7分鐘", 800: "約10分鐘" };
  const GRID_NULL = -32768;
  const PREDICT_METRICS = {
    age65: { label: "65歲以上占比", kind: "pct" },
    age2544: { label: "25–44歲占比", kind: "pct" },
    age014: { label: "0–14歲占比", kind: "pct" },
    age45p: { label: "45歲以上占比", kind: "pct" },
    age4564: { label: "45–64歲占比", kind: "pct" },
    pop: { label: "人口", kind: "int" },
    y1: { label: "近1年人口成長率", kind: "pctSigned" },
    y5: { label: "近5年人口成長率", kind: "pctSigned" },
    perCvs: { label: "每家超商服務人數", kind: "int" },
    perMkt: { label: "每市場服務人數", kind: "int" },
    mk: { label: "圈內市場數", kind: "int" },
    nearMkt: { label: "距最近市場", kind: "meters" },
    incMed: { label: "所得中位數", kind: "wan" },
    resto: { label: "OSM 餐廳數", kind: "int" },
  };
  const MARKET_TYPES = {
    "公有市場": { color: "#c2410c", short: "公" },
    "民有市場": { color: "#d97706", short: "民" },
    "攤販集中區": { color: "#0f766e", short: "攤" },
    "臨時攤販集中場": { color: "#0369a1", short: "臨" },
    "黃昏市場": { color: "#7c3aed", short: "黃" },
    "早市": { color: "#db2777", short: "早" },
  };

  const state = {
    meta: null,
    search: null,
    searchLoading: null,
    homeCountyId: "taoyuan",
    cache: {},
    loading: {},
    regionDistricts: null,
    mode: "circle",
    center: { lat: 24.953317, lng: 121.22616 },
    radius: 500,
    placeName: "中壢火車站",
    stats: null,
    tab: "age",
    compare: [],
    indicator: "density",
    selectedDistrict: null,
    adminCountyFilter: "",
    brandFilter: "all",
    showRestaurants: false,
    restaurants: [],
    showMarkets: true,
    markets: null,
    marketMeta: null,
    marketsLoading: null,
    income: null,
    incomeLoading: null,
    shopper: null,
    shopperLoading: null,
    gridCache: {},
    open: {
      scopeCounty: "taoyuan",
      scopeDistrict: "",
      radius: 800,
      topN: 10,
      minPop: 1000,
      minInc: null,
      wDemand: 5,
      wComp: 5,
      wInc: 0,
      showHeat: true,
      results: [],
      scored: [],
      demandValues: [],
      compValues: [],
      incValues: [],
      ran: false,
    },
    predict: {
      metric: "age65",
      desc: true,
      minPop: 3000,
      maxPop: null,
      maxMk: null,
      minInc: null,
      maxInc: null,
      scopeCounty: "taoyuan",
      scopeDistrict: "",
      radius: 500,
      topN: 10,
      showHeat: true,
      results: [],
      filtered: [],
      ran: false,
    },
  };

  let map, circleLayer, villageLayer, districtLayer, storeLayer, restoLayer, marketLayer, compareLayer, predictLayer, heatLayer;
  let centerMarker;
  let searchTimer = null;
  let centerSeq = 0;
  let heatRenderer = null;

  const $ = (id) => document.getElementById(id);

  function fmtInt(n) {
    if (n == null || Number.isNaN(n)) return "—";
    return Math.round(n).toLocaleString("zh-Hant-TW");
  }
  function fmt1(n) {
    if (n == null || Number.isNaN(n)) return "—";
    return Number(n).toLocaleString("zh-Hant-TW", { maximumFractionDigits: 1, minimumFractionDigits: 0 });
  }
  function fmtPct(n, digits = 1) {
    if (n == null || Number.isNaN(n)) return "—";
    const sign = n > 0 ? "+" : "";
    return sign + n.toFixed(digits) + "%";
  }
  function fmtPp(n) {
    if (n == null || Number.isNaN(n)) return "—";
    const sign = n > 0 ? "+" : "";
    return sign + n.toFixed(1) + " 個百分點";
  }
  function shares(age, pop) {
    if (!pop) return [0, 0, 0, 0, 0];
    return age.map((x) => (100 * x) / pop);
  }
  function distM(aLat, aLng, bLat, bLng) {
    const R = 6371000;
    const p1 = (aLat * Math.PI) / 180;
    const p2 = (bLat * Math.PI) / 180;
    const dp = ((bLat - aLat) * Math.PI) / 180;
    const dl = ((bLng - aLng) * Math.PI) / 180;
    const s = Math.sin(dp / 2) ** 2 + Math.cos(p1) * Math.cos(p2) * Math.sin(dl / 2) ** 2;
    return 2 * R * Math.asin(Math.sqrt(s));
  }
  function bboxOverlap(a, b) {
    return a[0] <= b[2] && a[2] >= b[0] && a[1] <= b[3] && a[3] >= b[1];
  }
  function circleBBox(lat, lng, radius) {
    const dLat = radius / 111320;
    const dLng = radius / (111320 * Math.max(0.2, Math.cos((lat * Math.PI) / 180)));
    return [lng - dLng, lat - dLat, lng + dLng, lat + dLat];
  }
  function polygons(geom) {
    if (!geom) return [];
    if (geom.type === "Polygon") return [{ type: "Feature", properties: {}, geometry: geom }];
    if (geom.type === "MultiPolygon") {
      return geom.coordinates.map((coords) => ({
        type: "Feature",
        properties: {},
        geometry: { type: "Polygon", coordinates: coords },
      }));
    }
    return [];
  }
  function intersectRatio(villGeom, circle) {
    const parts = polygons(villGeom);
    let iArea = 0;
    let vArea = 0;
    for (const p of parts) {
      vArea += turf.area(p);
      try {
        const inter = turf.intersect(p, circle);
        if (inter) iArea += turf.area(inter);
      } catch (e) {
        try {
          const inter = turf.intersect(turf.buffer(p, 0), circle);
          if (inter) iArea += turf.area(inter);
        } catch (e2) { /* skip sliver */ }
      }
    }
    if (vArea <= 0) return 0;
    return Math.min(1, iArea / vArea);
  }

  function countyName(id) {
    const c = (state.meta?.counties || []).find((x) => x.id === id);
    return c ? c.name : id;
  }
  function homeData() {
    return state.cache[state.homeCountyId] || null;
  }
  function iterCounties() {
    return Object.values(state.cache);
  }
  function countiesForBBox(b) {
    return (state.meta?.counties || []).filter((c) => bboxOverlap(c.bbox, b));
  }

  async function loadJSON(path) {
    const res = await fetch(path);
    if (!res.ok) throw new Error("無法載入 " + path);
    return res.json();
  }

  async function ensureCounty(id) {
    if (!id) return null;
    if (state.cache[id]) return state.cache[id];
    if (!state.loading[id]) {
      state.loading[id] = (async () => {
        const data = await loadJSON("data/" + id + ".json");
        data.villages.forEach((v) => { v.cid = id; v.county = data.name; });
        data.districts.forEach((d) => { d.cid = id; d.county = data.name; });
        if (state.income) attachIncomeToData(data);
        state.cache[id] = data;
        return data;
      })();
    }
    return state.loading[id];
  }

  async function ensureCountiesForCircle(lat, lng, radius) {
    const b = circleBBox(lat, lng, radius + 80);
    const list = countiesForBBox(b);
    await Promise.all(list.map((c) => ensureCounty(c.id)));
    return list;
  }

  async function ensureDistricts() {
    if (state.regionDistricts) return state.regionDistricts;
    const data = await loadJSON("data/districts.json");
    state.regionDistricts = data.districts;
    return state.regionDistricts;
  }

  async function ensureMarkets() {
    if (state.markets) return state.markets;
    if (!state.marketsLoading) {
      state.marketsLoading = loadJSON("data/markets.json").then((d) => {
        state.marketMeta = d;
        state.markets = d.markets || [];
        return state.markets;
      }).catch(() => {
        state.markets = [];
        return state.markets;
      });
    }
    return state.marketsLoading;
  }

  async function ensureIncome() {
    if (state.income) return state.income;
    if (!state.incomeLoading) {
      state.incomeLoading = loadJSON("data/income.json").then((d) => {
        state.income = d;
        Object.values(state.cache).forEach(attachIncomeToData);
        return d;
      }).catch(() => {
        state.income = { villages: {}, districts: {}, counties: {}, join: {} };
        return state.income;
      });
    }
    return state.incomeLoading;
  }

  function attachIncomeToData(data) {
    const inc = state.income;
    if (!inc || !data) return;
    const vill = inc.villages || {};
    data.villages.forEach((v) => {
      const rec = vill[v.id];
      if (rec) v.inc = rec;
    });
    const dists = inc.districts || {};
    data.districts.forEach((d) => {
      const rec = dists[d.code];
      if (rec) d.inc = rec;
    });
    const c = (inc.counties || {})[data.name];
    if (c && data.countyAvg) {
      data.countyAvg.incMed = c.medW;
      data.countyAvg.incAvg = c.avgW;
      data.countyAvg.incN = c.n;
    }
  }

  function fmtWan(thousand) {
    if (thousand == null || Number.isNaN(thousand)) return "—";
    return (thousand / 10).toLocaleString("zh-Hant-TW", {
      maximumFractionDigits: 1,
      minimumFractionDigits: 1,
    }) + " 萬";
  }

  function incomeWeighted(hits) {
    let w = 0, med = 0, avg = 0, nHits = 0;
    for (const h of hits) {
      const rec = h.v.inc;
      if (!rec || rec.n == null || rec.n <= 0 || rec.med == null) continue;
      const wt = rec.n * h.ratio;
      w += wt;
      med += rec.med * wt;
      avg += (rec.avg || 0) * wt;
      nHits += 1;
    }
    if (!w) return null;
    return { med: med / w, avg: avg / w, n: w, villages: nHits };
  }

  function districtIncome(d) {
    if (!d) return null;
    if (d.inc) return d.inc;
    return (state.income && state.income.districts && state.income.districts[d.code]) || null;
  }

  function countyIncomeOf(name) {
    return (state.income && state.income.counties && state.income.counties[name]) || null;
  }

  function circleCircleIntersectArea(r, R, d) {
    if (d >= r + R) return 0;
    if (d <= Math.abs(R - r)) {
      const rl = Math.min(r, R);
      return Math.PI * rl * rl;
    }
    const r2 = r * r, R2 = R * R;
    const a = Math.acos(Math.min(1, Math.max(-1, (d * d + r2 - R2) / (2 * d * r)))) * 2;
    const b = Math.acos(Math.min(1, Math.max(-1, (d * d + R2 - r2) / (2 * d * R)))) * 2;
    return 0.5 * (r2 * (a - Math.sin(a)) + R2 * (b - Math.sin(b)));
  }

  function approxVillageShare(v, lat, lng, radiusM) {
    const d = distM(lat, lng, v.center[1], v.center[0]);
    const villR = Math.sqrt((v.area * 1e6) / Math.PI);
    if (!(villR > 0)) return 0;
    const inter = circleCircleIntersectArea(radiusM, villR, d);
    return Math.min(1, inter / (v.area * 1e6));
  }

  function estimatePointIncome(lat, lng, radius) {
    return incomeWeighted(collectVillageShares(lat, lng, radius).filter((h) => h.v.inc));
  }
  function collectVillageShares(lat, lng, radius) {
    const cb = circleBBox(lat, lng, radius);
    const hits = [];
    for (const data of iterCounties()) {
      for (const v of data.villages) {
        if (!bboxOverlap(v.bbox, cb)) continue;
        const ratio = approxVillageShare(v, lat, lng, radius);
        if (ratio <= 0.002) continue;
        hits.push({ v, ratio });
      }
    }
    return hits;
  }

  async function ensureShopper() {
    if (state.shopper) return state.shopper;
    if (!state.shopperLoading) {
      state.shopperLoading = loadJSON("data/market_shopper.json").then((d) => {
        const adults = d.tainanPop.adults20;
        d.propensity = {};
        Object.entries(d.tainanPop.groups).forEach(([g, rec]) => {
          d.propensity[g] = rec.shopShare / (rec.pop / adults);
        });
        d.adultShopShareSum = 1 - (d.survey.ageShares.u20 || 0);
        state.shopper = d;
        return d;
      }).catch(() => {
        state.shopper = null;
        return null;
      });
    }
    return state.shopperLoading;
  }

  function shopperMeta() {
    return state.shopper;
  }

  function ageBinsFromHits(hits) {
    const bins = Array(18).fill(0);
    const fb = Array(18).fill(0);
    let wpop = 0;
    for (const h of hits) {
      const v = h.v;
      const r = h.ratio;
      if (!v.pm || !v.pf) continue;
      for (let i = 0; i < 18; i++) {
        bins[i] += ((v.pm[i] || 0) + (v.pf[i] || 0)) * r;
        fb[i] += (v.pf[i] || 0) * r;
      }
      wpop += (v.pop || 0) * r;
    }
    return { bins, fb, wpop };
  }

  function scaleBins(src, factor) {
    return src.map((x) => x * factor);
  }

  function shopperDemandFromBins(bins, fb) {
    const meta = shopperMeta();
    const empty = { demand: null, index: null, adults: 0, groups: {}, pop3059: 0, pop4059: 0, fem3069: 0 };
    if (!meta || !bins) return empty;
    const groups = {};
    let adults = 0;
    let raw = 0;
    Object.entries(meta.ageBins).forEach(([g, idxs]) => {
      const pop = idxs.reduce((s, i) => s + (bins[i] || 0), 0);
      groups[g] = pop;
      adults += pop;
      raw += pop * (meta.propensity[g] || 0);
    });
    const div = meta.adultShopShareSum || 1;
    const demand = raw / div;
    const index = adults > 0 ? (100 * demand) / adults : null;
    const pop3059 = (groups["30-39"] || 0) + (groups["40-49"] || 0) + (groups["50-59"] || 0);
    const pop4059 = (groups["40-49"] || 0) + (groups["50-59"] || 0);
    let fem3069 = 0;
    if (fb) {
      for (const i of [6, 7, 8, 9, 10, 11, 12, 13]) fem3069 += fb[i] || 0;
    }
    return { demand, index, adults, groups, pop3059, pop4059, fem3069 };
  }

  function attachShopperStats(stats, hits) {
    const { bins, fb } = ageBinsFromHits(hits || []);
    const d = shopperDemandFromBins(bins, fb);
    stats.shopDemand = d.demand;
    stats.shopIndex = d.index;
    stats.shopAdults = d.adults;
    stats.shopGroups = d.groups;
    stats.pop3059 = d.pop3059;
    stats.pop4059 = d.pop4059;
    stats.fem3069 = d.fem3069;
    const mk = stats.marketCount || 0;
    stats.perShopMkt = mk > 0 && d.demand != null ? d.demand / mk : null;
    stats.perShopMkt1 = d.demand != null ? d.demand / (mk + 1) : null;
    const scored = scoreAgainstOpenRun(d.demand, stats.perShopMkt1, stats.incMed, stats.radius);
    stats.shopScore = scored ? scored.score : null;
    stats.shopScoreParts = scored;
    return d;
  }

  function percentRanks(values) {
    const n = values.length;
    const ranks = new Array(n).fill(null);
    if (!n) return ranks;
    const order = values.map((v, i) => [v, i]).filter((x) => x[0] != null && !Number.isNaN(x[0]));
    order.sort((a, b) => a[0] - b[0]);
    const m = order.length;
    if (!m) return ranks;
    if (m === 1) {
      ranks[order[0][1]] = 50;
      return ranks;
    }
    for (let i = 0; i < m;) {
      let j = i;
      while (j < m && order[j][0] === order[i][0]) j += 1;
      const pct = (100 * ((i + j - 1) / 2)) / (m - 1);
      for (let k = i; k < j; k++) ranks[order[k][1]] = pct;
      i = j;
    }
    return ranks;
  }

  function percentileOf(value, arr) {
    if (value == null || !arr || !arr.length) return null;
    const vals = arr.filter((v) => v != null && !Number.isNaN(v));
    const n = vals.length;
    if (!n) return null;
    if (n === 1) return 50;
    let less = 0, ties = 0;
    for (const v of vals) {
      if (v < value) less += 1;
      else if (v === value) ties += 1;
    }
    return (100 * (less + (ties ? (ties - 1) / 2 : 0))) / (n - 1);
  }

  function composeScore(pD, pC, pI, wD, wC, wI) {
    let num = 0, den = 0;
    if (wD > 0 && pD != null) { num += wD * pD; den += wD; }
    if (wC > 0 && pC != null) { num += wC * pC; den += wC; }
    if (wI > 0 && pI != null) { num += wI * pI; den += wI; }
    if (!den) return null;
    return { score: num / den, pD, pC, pI, wD, wC, wI };
  }

  function scoreAgainstOpenRun(demand, perMkt1, incMed, radius) {
    const run = state.open;
    if (!run || !run.ran || !run.demandValues) return null;
    if (radius != null && run.radius !== radius) return null;
    const pD = percentileOf(demand, run.demandValues);
    const pC = percentileOf(perMkt1, run.compValues);
    const pI = incMed == null ? null : percentileOf(incMed, run.incValues);
    return composeScore(pD, pC, pI, run.wDemand, run.wComp, run.wInc);
  }


  function villIncomeNote(v) {
    if (!v || !v.inc || v.inc.med == null) return "所得無資料";
    let t = "中位數 " + fmtWan(v.inc.med);
    if (v.inc.how === "inherit" && v.inc.from) t += `（112年原屬${v.inc.from}）`;
    else if (v.inc.how === "merge" && v.inc.from) t += `（112年${v.inc.from}合併推估）`;
    else if (v.inc.how === "split-joint" && v.inc.from) t += `（112年${v.inc.from}共同分里）`;
    return t;
  }

  function incomeCompareNote(value, countyValue, countyName, kindLabel, scopeNote) {
    if (value == null) return "此範圍缺少所得資料";
    const bits = [];
    if (countyValue != null && countyName) {
      const diff = value - countyValue;
      if (Math.abs(diff) < 0.05) {
        bits.push(`與${countyName}各里加權平均相同（${fmtWan(countyValue)}）`);
      } else {
        const rel = diff > 0 ? "高出" : "低於";
        bits.push(`較${countyName}各里加權平均（${fmtWan(countyValue)}）${rel} ${fmtWan(Math.abs(diff))}`);
      }
    }
    if (scopeNote) bits.push(scopeNote);
    bits.push("綜所稅申報、不含免稅所得、所得年 112");
    return bits.join("。");
  }

  function marketColor(type) {
    return MARKET_TYPES[type]?.color || "#c2410c";
  }

  function collectMarkets(lat, lng, radius) {
    const all = state.markets || [];
    let nearest = null;
    const inside = [];
    for (const m of all) {
      const d = distM(lat, lng, m.lat, m.lng);
      const rec = { ...m, dist: d };
      if (!nearest || d < nearest.dist) nearest = rec;
      if (d <= radius) inside.push(rec);
    }
    inside.sort((a, b) => a.dist - b.dist);
    return { inside, nearest };
  }

  function attachMarketStats(stats, lat, lng, radius, pop) {
    const { inside, nearest } = collectMarkets(lat, lng, radius);
    stats.marketsIn = inside;
    stats.marketCount = inside.length;
    stats.nearestMarket = nearest;
    stats.perMkt = inside.length ? pop / inside.length : null;
    return stats;
  }

  function marketsForDistrict(d) {
    return (state.markets || []).filter((m) => m.cid === d.cid && m.district === d.name);
  }

  async function ensureSearch() {
    if (state.search) return state.search;
    if (!state.searchLoading) {
      state.searchLoading = loadJSON("data/search.json")
        .then((s) => { state.search = s; return s; })
        .catch(() => {
          state.search = { villages: [], districts: [], stores: [], landmarks: [] };
          return state.search;
        });
    }
    return state.searchLoading;
  }

  function initMap() {
    map = L.map("map", { zoomControl: false, attributionControl: true }).setView([state.center.lat, state.center.lng], 15);
    L.control.zoom({ position: "topright" }).addTo(map);
    L.tileLayer("https://wmts.nlsc.gov.tw/wmts/EMAP/default/GoogleMapsCompatible/{z}/{y}/{x}", {
      attribution: "底圖 © 內政部國土測繪中心",
      maxZoom: 19,
    }).addTo(map);
    villageLayer = L.geoJSON(null, {
      style: { color: "#fdba74", weight: 1, fillColor: "#fdba74", fillOpacity: 0.18 },
    }).addTo(map);
    districtLayer = L.geoJSON(null, {
      style: () => ({}),
      onEachFeature: (feat, layer) => {
        layer.on("click", () => selectDistrict(feat.properties.code));
      },
    }).addTo(map);
    circleLayer = L.layerGroup().addTo(map);
    storeLayer = L.layerGroup().addTo(map);
    restoLayer = L.layerGroup().addTo(map);
    marketLayer = L.layerGroup().addTo(map);
    compareLayer = L.layerGroup().addTo(map);
    heatLayer = L.layerGroup().addTo(map);
    predictLayer = L.layerGroup().addTo(map);
    centerMarker = L.marker([state.center.lat, state.center.lng], {
      draggable: true,
      icon: L.divIcon({ className: "center-icon", iconSize: [18, 18], iconAnchor: [9, 9] }),
    }).addTo(map);
    centerMarker.on("drag", (e) => {
      const ll = e.target.getLatLng();
      drawCircleOnly(ll.lat, ll.lng, state.radius);
    });
    centerMarker.on("dragend", (e) => {
      const ll = e.target.getLatLng();
      setCenter(ll.lat, ll.lng, null);
    });
    map.on("click", (e) => {
      if (state.mode !== "circle") return;
      setCenter(e.latlng.lat, e.latlng.lng, null);
    });
    refreshMapSize();
  }

  function refreshMapSize() {
    if (!map) return;
    requestAnimationFrame(() => {
      map.invalidateSize({ animate: false });
      setTimeout(() => { if (map) map.invalidateSize({ animate: false }); }, 200);
    });
  }

  function syncSourceDetails() {
    const d = $("sourceDetails");
    if (!d) return;
    d.open = false;
  }

  function drawCircleOnly(lat, lng, radius) {
    circleLayer.clearLayers();
    L.circle([lat, lng], {
      radius,
      color: "#d9480f",
      weight: 2,
      fillColor: "#d9480f",
      fillOpacity: 0.12,
    }).addTo(circleLayer);
  }

  function findPlace(lat, lng) {
    const pt = turf.point([lng, lat]);
    let hit = null;
    for (const data of iterCounties()) {
      for (const v of data.villages) {
        const b = v.bbox;
        if (lng < b[0] || lng > b[2] || lat < b[1] || lat > b[3]) continue;
        try {
          if (turf.booleanPointInPolygon(pt, turf.feature(v.g))) {
            hit = v;
            break;
          }
        } catch (e) { /* ignore */ }
      }
      if (hit) break;
    }
    return hit;
  }

  function estimateCircle(lat, lng, radius) {
    const circle = turf.circle([lng, lat], radius / 1000, { steps: 64, units: "kilometers" });
    const areaKm2 = Math.PI * (radius / 1000) ** 2;
    const cb = turf.bbox(circle);
    const hits = [];
    let pop = 0, hh = 0;
    const age = [0, 0, 0, 0, 0];
    const pm = Array(18).fill(0);
    const pf = Array(18).fill(0);
    let popNowY1 = 0, popY1 = 0, popNowY5 = 0, popY5 = 0;
    const feats = [];
    for (const data of iterCounties()) {
      for (const v of data.villages) {
        if (!bboxOverlap(v.bbox, cb)) continue;
        const ratio = intersectRatio(v.g, circle);
        if (ratio <= 0.002) continue;
        hits.push({ v, ratio });
        pop += v.pop * ratio;
        hh += v.hh * ratio;
        v.age.forEach((x, i) => { age[i] += x * ratio; });
        v.pm.forEach((x, i) => { pm[i] += x * ratio; });
        v.pf.forEach((x, i) => { pf[i] += x * ratio; });
        if (v.popY1 != null) {
          popNowY1 += v.pop * ratio;
          popY1 += v.popY1 * ratio;
        }
        if (v.popY5 != null) {
          popNowY5 += v.pop * ratio;
          popY5 += v.popY5 * ratio;
        }
        feats.push(turf.feature(v.g, { name: v.name, district: v.district, county: v.county, ratio }));
      }
    }
    hits.sort((a, b) => b.ratio - a.ratio);
    const density = areaKm2 ? pop / areaKm2 : 0;
    const vill = findPlace(lat, lng);
    let homeId = vill?.cid || state.homeCountyId;
    if (!vill && hits.length) {
      const weight = {};
      hits.forEach((h) => { weight[h.v.cid] = (weight[h.v.cid] || 0) + h.v.pop * h.ratio; });
      homeId = Object.entries(weight).sort((a, b) => b[1] - a[1])[0][0];
    }
    const home = state.cache[homeId];
    const avg = home?.countyAvg;
    const chY1 = popY1 > 0 && popNowY1 / Math.max(pop, 1) >= 0.9 ? { abs: popNowY1 - popY1, pct: (100 * (popNowY1 - popY1)) / popY1 } : null;
    const chY5 = popY5 > 0 && popNowY5 / Math.max(pop, 1) >= 0.9 ? { abs: popNowY5 - popY5, pct: (100 * (popNowY5 - popY5)) / popY5 } : null;

    const storesIn = [];
    const nearest = { s711: null, fami: null, sbux: null, mcd: null };
    for (const data of iterCounties()) {
      for (const s of data.stores) {
        const d = distM(lat, lng, s.lat, s.lng);
        const rec = { ...s, dist: d };
        if (!nearest[s.b] || d < nearest[s.b].dist) nearest[s.b] = rec;
        if (d <= radius) storesIn.push(rec);
      }
    }
    storesIn.sort((a, b) => a.dist - b.dist);
    const count = { s711: 0, fami: 0, sbux: 0, mcd: 0 };
    storesIn.forEach((s) => { count[s.b] += 1; });
    const cvs = count.s711 + count.fami;
    const perCvs = cvs > 0 ? pop / cvs : null;
    const mk = collectMarkets(lat, lng, radius);
    const inc = incomeWeighted(hits);
    const homeName = home ? home.name : countyName(homeId);
    const cInc = countyIncomeOf(homeName) || (avg && avg.incMed != null ? { medW: avg.incMed, avgW: avg.incAvg } : null);

    const out = {
      kind: "circle",
      lat, lng, radius, areaKm2, pop, hh, density,
      age, pm, pf,
      ageShare: shares(age, pop),
      chY1, chY5,
      hits, feats, storesIn, nearest, count, cvs, perCvs,
      marketsIn: mk.inside,
      marketCount: mk.inside.length,
      nearestMarket: mk.nearest,
      perMkt: mk.inside.length ? pop / mk.inside.length : null,
      incMed: inc ? inc.med : null,
      incAvg: inc ? inc.avg : null,
      incN: inc ? inc.n : null,
      countyIncMed: cInc ? cInc.medW : null,
      countyIncAvg: cInc ? cInc.avgW : null,
      vill,
      homeCountyId: homeId,
      homeCountyName: homeName,
      countyAvg: avg,
    };
    attachShopperStats(out, hits);
    return out;
  }

  function getDistrict(code) {
    if (state.regionDistricts) {
      return state.regionDistricts.find((x) => x.code === code) || null;
    }
    for (const data of iterCounties()) {
      const d = data.districts.find((x) => x.code === code);
      if (d) return d;
    }
    return null;
  }

  function visibleDistricts() {
    const all = state.regionDistricts
      || iterCounties().flatMap((c) => c.districts);
    if (!state.adminCountyFilter) return all;
    return all.filter((d) => d.cid === state.adminCountyFilter);
  }

  function estimateDistrict(code) {
    const d = getDistrict(code);
    if (!d) return null;
    const data = state.cache[d.cid];
    const count = { ...(d.stores || {}) };
    const cvs = (count.s711 || 0) + (count.fami || 0);
    const stores = data ? data.stores : [];
    const villages = data ? data.villages.filter((v) => v.dc === d.code) : [];
    const storesIn = stores
      .filter((s) => s.d === d.name)
      .map((s) => ({ ...s, dist: distM(d.center[1], d.center[0], s.lat, s.lng) }))
      .sort((a, b) => a.dist - b.dist);
    const nearest = { s711: null, fami: null, sbux: null, mcd: null };
    for (const s of stores) {
      const dist = distM(d.center[1], d.center[0], s.lat, s.lng);
      if (!nearest[s.b] || dist < nearest[s.b].dist) nearest[s.b] = { ...s, dist };
    }
    const chY1 = d.popY1 ? { abs: d.pop - d.popY1, pct: (100 * (d.pop - d.popY1)) / d.popY1 } : null;
    const chY5 = d.popY5 ? { abs: d.pop - d.popY5, pct: (100 * (d.pop - d.popY5)) / d.popY5 } : null;
    const avg = data?.countyAvg;
    const districtMarkets = marketsForDistrict(d)
      .map((m) => ({ ...m, dist: distM(d.center[1], d.center[0], m.lat, m.lng) }))
      .sort((a, b) => a.dist - b.dist);
    const dInc = districtIncome(d);
    const homeName = d.county || countyName(d.cid);
    const cInc = countyIncomeOf(homeName) || (avg && avg.incMed != null ? { medW: avg.incMed, avgW: avg.incAvg } : null);
    const out = {
      kind: "district",
      district: d,
      lat: d.center[1],
      lng: d.center[0],
      areaKm2: d.area,
      pop: d.pop,
      hh: d.hh,
      density: d.density,
      age: d.age,
      pm: d.pm,
      pf: d.pf,
      ageShare: shares(d.age, d.pop),
      chY1, chY5,
      hits: villages.map((v) => ({ v, ratio: 1 })),
      feats: [],
      storesIn, nearest, count, cvs,
      perCvs: cvs > 0 ? d.pop / cvs : null,
      marketsIn: districtMarkets,
      marketCount: districtMarkets.length,
      nearestMarket: districtMarkets[0] || null,
      perMkt: districtMarkets.length ? d.pop / districtMarkets.length : null,
      incMed: dInc ? dInc.med : null,
      incAvg: dInc ? dInc.avg : null,
      incN: dInc ? dInc.n : null,
      countyIncMed: cInc ? cInc.medW : null,
      countyIncAvg: cInc ? cInc.avgW : null,
      vill: null,
      homeCountyId: d.cid,
      homeCountyName: homeName,
      countyAvg: avg,
    };
    attachShopperStats(out, out.hits);
    return out;
  }

  async function setCenter(lat, lng, name) {
    const seq = ++centerSeq;
    state.center = { lat, lng };
    state.selectedDistrict = null;
    centerMarker.setLatLng([lat, lng]);
    if (state.mode !== "circle") return;
    const needed = countiesForBBox(circleBBox(lat, lng, state.radius + 80))
      .filter((c) => !state.cache[c.id]);
    if (needed.length && !state.stats) {
      $("panelEmpty").hidden = false;
      $("panelEmpty").textContent = "正在載入" + needed.map((c) => c.name).join("、") + "資料…";
      $("panelBody").hidden = true;
    }
    await Promise.all([
      ensureCountiesForCircle(lat, lng, state.radius),
      ensureMarkets(),
      ensureIncome(),
      ensureShopper(),
    ]);
    if (seq !== centerSeq) return;
    const vill = findPlace(lat, lng);
    state.stats = estimateCircle(lat, lng, state.radius);
    if (state.stats.homeCountyId) state.homeCountyId = state.stats.homeCountyId;
    if (!vill && !state.stats.hits.length) {
      state.placeName = name || "範圍外";
      $("panelEmpty").hidden = false;
      $("panelEmpty").textContent = "此位置不在資料範圍（臺北市、新北市、桃園市、新竹市、新竹縣）內，請點選範圍內的位置。";
      $("panelBody").hidden = true;
      drawCircleOnly(lat, lng, state.radius);
      villageLayer.clearLayers();
      storeLayer.clearLayers();
      drawMarkets([]);
      return;
    }
    state.placeName = name || (vill ? vill.district + vill.name : "地圖選點");
    drawCircleMode();
    renderPanel();
    if (state.showRestaurants) loadRestaurants();
  }

  function setRadius(r) {
    state.radius = r;
    document.querySelectorAll("#radiusBar button").forEach((b) => {
      b.classList.toggle("active", Number(b.dataset.r) === r);
    });
    if (state.mode === "circle") setCenter(state.center.lat, state.center.lng, state.placeName);
  }

  function drawCircleMode() {
    districtLayer.clearLayers();
    heatLayer.clearLayers();
    predictLayer.clearLayers();
    $("legend").hidden = true;
    drawCircleOnly(state.center.lat, state.center.lng, state.radius);
    villageLayer.clearLayers();
    if (state.stats?.feats?.length) villageLayer.addData({ type: "FeatureCollection", features: state.stats.feats });
    drawStores(state.stats?.storesIn || []);
    drawMarkets(state.stats?.marketsIn || []);
    drawCompareMarkers();
    if (!map.hasLayer(centerMarker)) centerMarker.addTo(map);
    syncOverlay();
  }

  function storeIcon(brand) {
    const color = (state.meta?.brands?.[brand]?.color) || BRANDS[brand].color;
    return L.divIcon({
      className: "",
      html: `<span style="display:block;width:12px;height:12px;border-radius:50%;background:${color};border:2px solid #fff;box-shadow:0 0 0 1px rgba(0,0,0,.25)"></span>`,
      iconSize: [12, 12],
      iconAnchor: [6, 6],
    });
  }

  function drawStores(list) {
    storeLayer.clearLayers();
    const filter = state.brandFilter;
    for (const s of list) {
      if (filter !== "all" && s.b !== filter) continue;
      const m = L.marker([s.lat, s.lng], { icon: storeIcon(s.b) });
      const label = (BRANDS[s.b]?.name || s.b) + "　" + s.n;
      m.bindPopup(`<strong>${label}</strong><br>${s.a || ""}${s.dist != null ? "<br>" + Math.round(s.dist) + " 公尺" : ""}`);
      m.addTo(storeLayer);
    }
  }

  function marketIcon(type, outside) {
    const color = marketColor(type);
    const short = MARKET_TYPES[type]?.short || "市";
    return L.divIcon({
      className: "",
      html: `<span class="mkt-pin${outside ? " out" : ""}" style="background:${color}">${short}</span>`,
      iconSize: [22, 22],
      iconAnchor: [11, 18],
    });
  }

  function drawMarkets(insideList) {
    if (!marketLayer) return;
    marketLayer.clearLayers();
    const countEl = $("marketToggleCount");
    const inside = insideList || state.stats?.marketsIn || [];
    if (countEl) {
      countEl.textContent = state.markets ? `（${inside.length}）` : "";
    }
    if (!state.showMarkets) return;
    const all = state.markets || [];
    if (!all.length) return;
    const isCircle = state.mode === "circle";
    const lat = state.center.lat, lng = state.center.lng;
    const radius = state.stats?.kind === "circle" ? state.stats.radius : state.radius;
    const reach = Math.max(radius + 800, radius * 2);
    const insideIds = new Set(inside.map((m) => m.id));
    for (const m of all) {
      let dist = m.dist;
      if (dist == null && isCircle) dist = distM(lat, lng, m.lat, m.lng);
      if (isCircle && dist > reach) continue;
      if (!isCircle && state.mode === "admin") {
        const d = getDistrict(state.selectedDistrict);
        // still show all markets; cheap at ~300 points
      }
      const outside = isCircle && !insideIds.has(m.id);
      const marker = L.marker([m.lat, m.lng], { icon: marketIcon(m.type, outside), zIndexOffset: outside ? 200 : 280 });
      const distTxt = dist != null ? `${Math.round(dist)} 公尺` : "";
      marker.bindPopup(
        `<strong>${m.name}</strong><br>${m.type}${m.hours ? "　" + m.hours : ""}` +
        `${distTxt ? "<br>" + distTxt : ""}` +
        `${m.address ? "<br>" + m.address : ""}` +
        `${m.note ? "<br><span class='src-note'>" + m.note + "</span>" : ""}`
      );
      marker.addTo(marketLayer);
    }
  }

  function drawCompareMarkers() {
    compareLayer.clearLayers();
    state.compare.forEach((c, i) => {
      const icon = L.divIcon({
        className: "compare-icon",
        html: String(i + 1),
        iconSize: [24, 24],
        iconAnchor: [12, 12],
      });
      L.marker([c.lat, c.lng], { icon, zIndexOffset: 500 }).addTo(compareLayer)
        .bindTooltip((i + 1) + ". " + c.label);
    });
  }

  function indicatorValue(d) {
    if (state.indicator === "density") return d.density;
    if (state.indicator === "age2544") return d.pop ? (100 * d.age[2]) / d.pop : 0;
    if (state.indicator === "age65") return d.pop ? (100 * d.age[4]) / d.pop : 0;
    if (state.indicator === "cvs") return (d.stores.s711 || 0) + (d.stores.fami || 0);
    if (state.indicator === "markets") return marketsForDistrict(d).length;
    if (state.indicator === "perMkt") {
      const n = marketsForDistrict(d).length;
      return n > 0 ? d.pop / n : null;
    }
    if (state.indicator === "incMed") {
      const rec = districtIncome(d);
      return rec && rec.med != null ? rec.med / 10 : null;
    }
    return 0;
  }

  function colorRamp(t) {
    const stops = ["#fff7ed", "#fed7aa", "#fb923c", "#ea580c", "#9a3412"];
    const i = Math.min(stops.length - 1, Math.max(0, Math.floor(t * (stops.length - 1))));
    return stops[i];
  }

  function fitBBoxes(items) {
    if (!items.length) return;
    let minx = 180, miny = 90, maxx = -180, maxy = -90;
    for (const d of items) {
      const b = d.bbox;
      minx = Math.min(minx, b[0]); miny = Math.min(miny, b[1]);
      maxx = Math.max(maxx, b[2]); maxy = Math.max(maxy, b[3]);
    }
    map.fitBounds([[miny, minx], [maxy, maxx]], { padding: [20, 20] });
  }

  function drawAdminMode() {
    circleLayer.clearLayers();
    villageLayer.clearLayers();
    storeLayer.clearLayers();
    restoLayer.clearLayers();
    if (state.mode === "admin") drawMarkets(state.stats?.marketsIn || []);
    heatLayer.clearLayers();
    predictLayer.clearLayers();
    if (map.hasLayer(centerMarker)) map.removeLayer(centerMarker);
    syncOverlay();
    const districts = visibleDistricts();
    const vals = districts.map(indicatorValue).filter((v) => v != null);
    const min = vals.length ? Math.min(...vals) : 0;
    const max = vals.length ? Math.max(...vals) : 1;
    districtLayer.clearLayers();
    districtLayer.options.style = (feat) => {
      const d = districts.find((x) => x.code === feat.properties.code);
      const raw = d ? indicatorValue(d) : min;
      const v = raw == null ? min : raw;
      const t = (raw == null) ? 0 : (max === min ? 0.5 : (v - min) / (max - min));
      const selected = state.selectedDistrict === feat.properties.code;
      return {
        color: selected ? "#1f1915" : "#ffffff",
        weight: selected ? 2.5 : 1,
        fillColor: colorRamp(t),
        fillOpacity: 0.78,
      };
    };
    const fc = {
      type: "FeatureCollection",
      features: districts.map((d) => ({
        type: "Feature",
        properties: { code: d.code, name: d.name, county: d.county },
        geometry: d.geometry,
      })),
    };
    districtLayer.addData(fc);
    const legendKind = (state.indicator === "markets" || state.indicator === "perMkt")
      ? "int"
      : (state.indicator === "incMed" ? "wan" : state.indicator);
    renderMetricLegend($("indicatorSelect").selectedOptions[0].textContent, min, max, legendKind);
    renderDistrictButtons();
    drawCompareMarkers();
    if (state.stats?.kind === "district" && state.stats.storesIn) {
      drawStores(state.stats.storesIn);
    }
  }

  function renderMetricLegend(title, min, max, kind) {
    const legend = $("legend");
    const steps = 5;
    legend.innerHTML = `<div><strong>${title}</strong></div>` + Array.from({ length: steps }, (_, i) => {
      const a = min + ((max - min) * i) / steps;
      const b = min + ((max - min) * (i + 1)) / steps;
      let label;
      if (kind === "cvs" || kind === "int" || kind === "resto" || kind === "markets" || kind === "perMkt") label = `${Math.round(a)}–${Math.round(b)}`;
      else if (kind === "density") label = `${fmtInt(a)}–${fmtInt(b)}`;
      else if (kind === "pctSigned") label = `${fmtPct(a)}–${fmtPct(b)}`;
      else if (kind === "wan") label = `${a.toFixed(1)}–${b.toFixed(1)} 萬`;
      else label = `${a.toFixed(1)}–${b.toFixed(1)}%`;
      return `<div class="row"><i style="background:${colorRamp((i + 0.5) / steps)}"></i>${label}</div>`;
    }).join("");
    legend.hidden = false;
  }

  function renderDistrictButtons() {
    const box = $("districtBtns");
    box.innerHTML = "";
    const districts = visibleDistricts();
    const showCounty = !state.adminCountyFilter;
    [...districts].sort((a, b) => {
      const c = (a.county || "").localeCompare(b.county || "", "zh-Hant");
      return c || a.name.localeCompare(b.name, "zh-Hant");
    }).forEach((d) => {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "district-btn" + (state.selectedDistrict === d.code ? " active" : "");
      btn.textContent = showCounty ? `${d.name}` : d.name;
      btn.title = `${d.county || ""}${d.name}`;
      btn.addEventListener("click", () => selectDistrict(d.code));
      box.appendChild(btn);
    });
  }

  async function selectDistrict(code) {
    const d0 = getDistrict(code);
    if (!d0) return;
    state.selectedDistrict = code;
    if (d0.cid) await ensureCounty(d0.cid);
    state.stats = estimateDistrict(code);
    const d = state.stats?.district;
    state.placeName = d ? d.name : "";
    if (state.stats?.homeCountyId) state.homeCountyId = state.stats.homeCountyId;
    if (d) {
      map.fitBounds([[d.bbox[1], d.bbox[0]], [d.bbox[3], d.bbox[2]]], { padding: [30, 30], maxZoom: 14 });
    }
    drawAdminMode();
    showPanelForMode();
    renderPanel();
  }

  function showPanelForMode() {
    const special = state.mode === "predict" || state.mode === "open";
    $("predictBody").hidden = state.mode !== "predict";
    if ($("openBody")) $("openBody").hidden = state.mode !== "open";
    if (special) {
      $("panelEmpty").hidden = true;
      $("panelBody").hidden = true;
    }
  }

  function syncModeButtons() {
    $("btnModeCircle").classList.toggle("active", state.mode === "circle");
    $("btnModeAdmin").classList.toggle("active", state.mode === "admin");
    $("btnModePredict").classList.toggle("active", state.mode === "predict");
    if ($("btnModeOpen")) $("btnModeOpen").classList.toggle("active", state.mode === "open");
  }

  function syncOverlay() {
    $("radiusBar").hidden = state.mode !== "circle";
    $("adminBar").hidden = state.mode !== "admin";
    $("restoToggleWrap").hidden = state.mode !== "circle";
    if ($("marketToggleWrap")) $("marketToggleWrap").hidden = state.mode === "predict" || state.mode === "open";
    if (state.mode === "admin") {
      $("mapHint").hidden = true;
    } else if (state.mode === "predict") {
      $("mapHint").hidden = false;
      $("mapHint").textContent = "調整條件後按開始篩選；點結果可查看該點步行圈";
    } else if (state.mode === "open") {
      $("mapHint").hidden = false;
      $("mapHint").textContent = "調整權重與範圍後按開始分析；點結果可查看該點步行圈";
    } else {
      $("mapHint").hidden = false;
      $("mapHint").textContent = "點地圖設定中心，或拖曳橘色圓點";
    }
  }

  function renderPanel() {
    const s = state.stats;
    if (!s) return;
    $("panelEmpty").hidden = true;
    $("panelBody").hidden = false;
    const avg = s.countyAvg;
    const county = s.homeCountyName || "";
    if (s.kind === "circle") {
      $("placeKicker").textContent = "步行圈中心";
      const vill = s.vill;
      $("placeTitle").textContent = state.placeName;
      $("placeSub").textContent = vill
        ? `${vill.county || county}　${vill.district}　${vill.name}`
        : `${county}　半徑 ${s.radius} 公尺（${RADIUS_WALK[s.radius] || ""}）`;
      $("villListWrap").hidden = false;
      const nCounty = new Set(s.hits.map((h) => h.v.county).filter(Boolean)).size;
      $("villCount").textContent = nCounty > 1
        ? `（跨 ${nCounty} 縣市、${s.hits.length} 里）`
        : `（${s.hits.length} 里）`;
      $("villList").innerHTML = s.hits.map((h) => {
        const label = nCounty > 1
          ? `${h.v.county || ""}${h.v.district}${h.v.name}`
          : `${h.v.district}${h.v.name}`;
        return `<li><span>${label}</span><span>覆蓋 ${(h.ratio * 100).toFixed(0)}%　${villIncomeNote(h.v)}</span></li>`;
      }).join("");
    } else {
      $("placeKicker").textContent = "行政區";
      $("placeTitle").textContent = s.district.name;
      $("placeSub").textContent = `${s.district.county || county}　全區統計（非步行圈估算）`;
      $("villListWrap").hidden = false;
      $("villCount").textContent = `（${s.hits.length} 里）`;
      $("villList").innerHTML = s.hits
        .sort((a, b) => b.v.pop - a.v.pop)
        .map((h) => `<li><span>${h.v.name}</span><span>${fmtInt(h.v.pop)} 人　${villIncomeNote(h.v)}</span></li>`)
        .join("");
    }

    const densRatio = avg && avg.density ? s.density / avg.density : null;
    let densNote = "";
    if (densRatio != null) {
      densNote = `約為${county}平均（${fmt1(avg.density)} 人/km²）的 ${fmt1(densRatio)} 倍`;
    }
    const popLabel = s.kind === "circle" ? "估計人口" : "人口";
    const hhLabel = s.kind === "circle" ? "估計戶數" : "戶數";
    const areaLabel = s.kind === "circle" ? `圈內面積 ${s.areaKm2.toFixed(2)} 平方公里` : `面積 ${fmt1(s.areaKm2)} 平方公里`;

    function changeCell(ch, label) {
      if (!ch) return metric(label, "資料不足", "缺少部分村里的歷史人口，故不推估");
      const cls = ch.abs > 0 ? "up" : ch.abs < 0 ? "down" : "";
      return metric(label, `${ch.abs > 0 ? "+" : ""}${fmtInt(ch.abs)}`, `${fmtPct(ch.pct)}　相對比較基準`, cls);
    }
    function metric(label, value, note, cls = "") {
      return `<div class="metric"><div class="label">${label}</div><div class="value ${cls}">${value}</div><div class="note">${note || ""}</div></div>`;
    }
    $("metricGrid").innerHTML = [
      metric(popLabel, fmtInt(s.pop), areaLabel),
      metric(hhLabel, fmtInt(s.hh), s.kind === "circle" ? "依村里面積比例估算" : ""),
      metric("人口密度", fmtInt(s.density) + " 人/km²", densNote, "wide"),
      changeCell(s.chY1, "近1年人口變化"),
      changeCell(s.chY5, "近5年人口變化"),
      metric("每家超商服務人數", s.perCvs == null ? "圈內無超商" : fmtInt(s.perCvs), `超商 ${s.cvs} 家（7-ELEVEN + 全家）`, "wide"),
      metric("傳統市場", String(s.marketCount || 0), s.kind === "circle" ? "步行圈內列管／對位市集" : "本區列管／對位市集"),
      metric("每市場服務人數", s.perMkt == null ? "此範圍沒有傳統市場" : fmtInt(s.perMkt),
        s.nearestMarket
          ? `最近：${s.nearestMarket.name}　${Math.round(s.nearestMarket.dist)} 公尺`
          : "",
        "wide"),
      metric("菜市場潛在客群", s.shopDemand == null ? "—" : fmtInt(s.shopDemand),
        s.shopIndex == null ? "年齡權重來自臺南市市場調查，套用到本地是假設"
          : `指數 ${fmt1(s.shopIndex)}（100＝與臺南市111年4月成年人口結構相同）。臺南調查權重，套用到本地是假設`),
      metric("開店評分", s.shopScore == null ? "尚未與網格比較" : fmt1(s.shopScore),
        s.shopScore == null
          ? "到「菜市場開店」用相同半徑分析後，即可看到與同批點位比較的評分"
          : `需求百分位 ${fmt1(s.shopScoreParts.pD)}、低競爭百分位 ${fmt1(s.shopScoreParts.pC)}` + (s.shopScoreParts.wI > 0 && s.shopScoreParts.pI != null ? `、所得百分位 ${fmt1(s.shopScoreParts.pI)}` : "")),
      metric("所得中位數", s.incMed == null ? "—" : fmtWan(s.incMed),
        incomeCompareNote(
          s.incMed, s.countyIncMed, county, "中位數",
          s.kind === "circle"
            ? "圈內各里中位數按納稅單位加權平均"
            : "本區申報中位數（財政部村里表合計列）"
        )),
      metric("所得平均數", s.incAvg == null ? "—" : fmtWan(s.incAvg),
        incomeCompareNote(
          s.incAvg, s.countyIncAvg, county, "平均數",
          s.kind === "circle"
            ? "圈內各里平均數按納稅單位加權平均"
            : "本區申報平均數（財政部村里表合計列）"
        )),
    ].join("");

    $("btnCompare").disabled = state.compare.length >= 6;
    $("compareHint").textContent = state.compare.length >= 6 ? "最多比較 6 個地點" : `已加入 ${state.compare.length} / 6`;

    renderAge(s);
    renderBrands(s);
    renderMarkets(s);
    renderOpenSection(s);
    renderRestaurants();
    showTab(state.tab);
  }

  function renderAge(s) {
    const county = s.homeCountyName || "";
    const avgShare = s.countyAvg ? s.countyAvg.ageShare : [0, 0, 0, 0, 0];
    const rows = AGE_LABELS.map((label, i) => {
      const pct = s.ageShare[i] || 0;
      const avg = avgShare[i] || 0;
      const delta = pct - avg;
      const dcls = delta > 0.15 ? "up" : delta < -0.15 ? "down" : "";
      return `<div class="age-row">
        <div>${label}</div>
        <div class="bar-wrap">
          <div class="bar" style="width:${Math.max(0, pct)}%"></div>
          <span class="avg-mark" style="left:${Math.max(0, Math.min(100, avg))}%"></span>
        </div>
        <div>${pct.toFixed(1)}%<div class="age-delta ${dcls}">${fmtPp(delta)}</div></div>
      </div>`;
    }).join("");
    const avgPm = s.countyAvg?.pm || Array(18).fill(0);
    const avgPf = s.countyAvg?.pf || Array(18).fill(0);
    const avgPop = s.countyAvg?.pop || 1;
    const maxShare = Math.max(
      ...s.pm.map((x) => x / Math.max(s.pop, 1)),
      ...s.pf.map((x) => x / Math.max(s.pop, 1)),
      ...avgPm.map((x) => x / Math.max(avgPop, 1)),
      ...avgPf.map((x) => x / Math.max(avgPop, 1)),
      0.001
    );
    const w = 340, h = 340, mid = 170, gap = 22, rowH = 16, top = 16;
    function bar(val) {
      return (val / maxShare) * 120;
    }
    const py = PY_LABELS.map((lab, i) => {
      const y = top + i * rowH;
      const m = s.pm[i] / Math.max(s.pop, 1);
      const f = s.pf[i] / Math.max(s.pop, 1);
      const cm = avgPm[i] / Math.max(avgPop, 1);
      const cf = avgPf[i] / Math.max(avgPop, 1);
      const mw = bar(m), fw = bar(f), cmw = bar(cm), cfw = bar(cf);
      return `
        <rect x="${mid - gap - mw}" y="${y}" width="${mw}" height="12" fill="#1d4e89"/>
        <rect x="${mid + gap}" y="${y}" width="${fw}" height="12" fill="#c43d66"/>
        <rect x="${mid - gap - cmw}" y="${y - 1}" width="${cmw}" height="14" fill="none" stroke="#1f1915" stroke-dasharray="3 2" stroke-width="1" opacity="0.7"/>
        <rect x="${mid + gap}" y="${y - 1}" width="${cfw}" height="14" fill="none" stroke="#1f1915" stroke-dasharray="3 2" stroke-width="1" opacity="0.7"/>
        <text x="${mid}" y="${y + 10}" text-anchor="middle" font-size="9" fill="#6d645c">${lab}</text>`;
    }).join("");
    $("ageSection").innerHTML = `
      <p class="src-note">色塊為本地點占比；黑色短線／虛線為比${county}平均。</p>
      ${rows}
      <p class="pyramid-caption">人口金字塔（占總人口比；左男右女；虛線為${county}平均）</p>
      <svg class="pyramid" viewBox="0 0 ${w} ${h}" role="img" aria-label="人口金字塔">
        <text x="${mid - 90}" y="12" font-size="11" fill="#1d4e89">男性</text>
        <text x="${mid + 50}" y="12" font-size="11" fill="#c43d66">女性</text>
        ${py}
      </svg>`;
  }

  function renderBrands(s) {
    const pop = s.pop || 0;
    const rows = ["s711", "fami", "sbux", "mcd"].map((b) => {
      const n = s.count[b] || 0;
      const per10k = pop ? (n / pop) * 10000 : 0;
      const near = s.nearest[b];
      const nearTxt = near ? `${Math.round(near.dist)} m（${near.n}）` : "—";
      return `<tr>
        <td><span class="dot" style="background:${BRANDS[b].color}"></span>${BRANDS[b].name}</td>
        <td>${n}</td>
        <td>${per10k.toFixed(2)}</td>
        <td>${nearTxt}</td>
      </tr>`;
    }).join("");
    const filters = [["all", "全部 " + s.storesIn.length]]
      .concat(["s711", "fami", "sbux", "mcd"].map((b) => [b, `${BRANDS[b].short} ${s.count[b] || 0}`]))
      .map(([k, lab]) => `<button type="button" data-brand="${k}" class="${state.brandFilter === k ? "active" : ""}">${lab}</button>`)
      .join("");
    const list = s.storesIn
      .filter((x) => state.brandFilter === "all" || x.b === state.brandFilter)
      .map((x) => `<li><span class="dot" style="background:${BRANDS[x.b].color}"></span><strong>${BRANDS[x.b].short} ${x.n}</strong>　${Math.round(x.dist)} m<br><span class="src-note">${x.a || x.d || ""}</span></li>`)
      .join("");
    $("brandSection").innerHTML = `
      <div class="brand-filters">${filters}</div>
      <table class="brand-table">
        <thead><tr><th>品牌</th><th>家數</th><th>每萬人</th><th>最近一家</th></tr></thead>
        <tbody>${rows}</tbody>
      </table>
      <p class="src-note">7-ELEVEN 來自官方電子地圖；全家、星巴克、麥當勞來自 OpenStreetMap，家數可能低於實際。</p>
      <ul class="store-list">${list || "<li>此範圍沒有選取品牌的門市</li>"}</ul>`;
    $("brandSection").querySelectorAll("[data-brand]").forEach((btn) => {
      btn.addEventListener("click", () => {
        state.brandFilter = btn.dataset.brand;
        drawStores(state.stats.storesIn || []);
        renderBrands(state.stats);
      });
    });
  }

  function renderMarkets(s) {
    const box = $("marketSection");
    if (!box || !s) return;
    const list = (s.marketsIn || []);
    const items = list.map((m) => {
      const dist = m.dist != null ? `${Math.round(m.dist)} 公尺` : "";
      return `<li><span class="dot" style="background:${marketColor(m.type)}"></span><strong>${m.name}</strong>　${m.type}${dist ? "　" + dist : ""}<br><span class="src-note">${m.address || ""}${m.hours ? "　" + m.hours : ""}</span></li>`;
    }).join("");
    const nearest = s.nearestMarket;
    let nearTxt = "";
    if (list.length === 0 && nearest) {
      nearTxt = `<p class="src-note">此範圍沒有列管傳統市場。最近一處是「${nearest.name}」（${nearest.type}），約 ${Math.round(nearest.dist)} 公尺。</p>`;
    }
    const legend = Object.entries(MARKET_TYPES).map(([k, v]) =>
      `<span><span class="dot" style="background:${v.color}"></span>${k}</span>`
    ).join("");
    box.innerHTML = `
      <div class="market-legend">${legend}</div>
      <p>此範圍有傳統市場 <strong>${list.length}</strong> 處${s.perMkt != null ? "；每市場約服務 " + fmtInt(s.perMkt) + " 人（戶籍人口估算）" : ""}。</p>
      ${nearTxt}
      <ul class="store-list">${items || "<li>此範圍沒有列管或對位到的傳統市場</li>"}</ul>
      <p class="src-note">以政府公布的公有／民有市場、攤販集中區與黃昏市場為主，並以 OpenStreetMap marketplace 核對、補遺。夜市、超市與批發市場不列入。未經列管的巷口早市若未出現在名單或 OSM，地圖上不會顯示。</p>`;
  }

  function renderRestaurants() {
    const box = $("restoSection");
    const tab = $("tabResto");
    if (!state.showRestaurants || state.mode !== "circle") {
      tab.hidden = true;
      return;
    }
    tab.hidden = false;
    if (!state.restaurants) {
      box.innerHTML = "<p class='src-note'>正在向 OpenStreetMap Overpass 查詢圈內餐廳…</p>";
      return;
    }
    const list = state.restaurants
      .map((r) => `<li><strong>${r.name}</strong>　${Math.round(r.dist)} m${r.cuisine ? "<br><span class='src-note'>" + r.cuisine + "</span>" : ""}</li>`)
      .join("");
    box.innerHTML = `<p>圈內 OSM 餐廳 ${state.restaurants.length} 家（僅供參考，並非營業登記完整名單）</p>
      <ul class="store-list">${list || "<li>此範圍沒有標註餐廳</li>"}</ul>`;
  }

  function showTab(tab) {
    state.tab = tab;
    document.querySelectorAll(".tabs [data-tab]").forEach((b) => b.classList.toggle("active", b.dataset.tab === tab));
    $("ageSection").hidden = tab !== "age";
    $("brandSection").hidden = tab !== "brand";
    $("marketSection").hidden = tab !== "market";
    if ($("openSection")) $("openSection").hidden = tab !== "open";
    $("restoSection").hidden = tab !== "resto";
  }

  function addCompare() {
    if (!state.stats || state.compare.length >= 6) return;
    const s = state.stats;
    const label = s.kind === "circle"
      ? `${state.placeName} ${s.radius}m`
      : `${s.homeCountyName || ""}${s.district.name}`;
    const key = s.kind === "circle"
      ? `c:${s.lat.toFixed(5)},${s.lng.toFixed(5)},${s.radius}`
      : `d:${s.district.code}`;
    if (state.compare.some((x) => x.key === key)) {
      $("compareHint").textContent = "這個地點已在比較表中";
      return;
    }
    state.compare.push({
      key, label,
      lat: s.lat, lng: s.lng,
      scope: s.kind === "circle" ? `${s.radius}m` : "全區",
      pop: s.pop,
      p2544: s.ageShare[2],
      p65: s.ageShare[4],
      cvs: s.cvs,
      sbux: s.count.sbux || 0,
      mcd: s.count.mcd || 0,
      marketCount: s.marketCount || 0,
      perMkt: s.perMkt,
      nearestMarket: s.nearestMarket ? `${s.nearestMarket.name} ${Math.round(s.nearestMarket.dist)}m` : "—",
      incMed: s.incMed,
      incAvg: s.incAvg,
      shopDemand: s.shopDemand,
      shopIndex: s.shopIndex,
      shopScore: s.shopScore,
    });
    renderCompare();
    drawCompareMarkers();
    $("compareHint").textContent = `已加入 ${state.compare.length} / 6`;
  }

  function renderCompare() {
    const wrap = $("compareWrap");
    if (!state.compare.length) {
      wrap.hidden = true;
      return;
    }
    wrap.hidden = false;
    const head = `<tr><th></th>${state.compare.map((c, i) => `<th>${i + 1}. ${c.label}<br><button type="button" class="btn-text" data-del="${i}">移除</button></th>`).join("")}</tr>`;
    const row = (label, fn) => `<tr><th>${label}</th>${state.compare.map((c) => `<td>${fn(c)}</td>`).join("")}</tr>`;
    $("compareTable").innerHTML = `<thead>${head}</thead><tbody>
      ${row("範圍", (c) => c.scope)}
      ${row("人口", (c) => fmtInt(c.pop))}
      ${row("25–44歲占比", (c) => c.p2544.toFixed(1) + "%")}
      ${row("65歲以上占比", (c) => c.p65.toFixed(1) + "%")}
      ${row("超商", (c) => c.cvs)}
      ${row("星巴克", (c) => c.sbux)}
      ${row("麥當勞", (c) => c.mcd)}
      ${row("傳統市場", (c) => c.marketCount ?? 0)}
      ${row("每市場服務人數", (c) => c.perMkt == null ? "無市場" : fmtInt(c.perMkt))}
      ${row("最近市場", (c) => c.nearestMarket || "—")}
      ${row("所得中位數", (c) => c.incMed == null ? "—" : fmtWan(c.incMed))}
      ${row("所得平均數", (c) => c.incAvg == null ? "—" : fmtWan(c.incAvg))}
      ${row("菜市場潛在客群", (c) => c.shopDemand == null ? "—" : fmtInt(c.shopDemand))}
      ${row("潛在客群指數", (c) => c.shopIndex == null ? "—" : fmt1(c.shopIndex))}
      ${row("開店評分", (c) => c.shopScore == null ? "—" : fmt1(c.shopScore))}
    </tbody>`;
    $("compareTable").querySelectorAll("[data-del]").forEach((b) => {
      b.addEventListener("click", () => {
        state.compare.splice(Number(b.dataset.del), 1);
        renderCompare();
        drawCompareMarkers();
        if (state.mode !== "predict") renderPanel();
      });
    });
  }

  function doSearch(q) {
    const box = $("searchResults");
    q = (q || "").trim();
    if (!q || !state.search) {
      box.hidden = true;
      return;
    }
    const nq = q.replace(/台/g, "臺");
    const groups = [
      ["車站", state.search.landmarks],
      ["行政區", state.search.districts],
      ["村里", state.search.villages],
      ["門市", state.search.stores],
    ];
    const out = [];
    for (const [kind, arr] of groups) {
      for (const item of arr) {
        const hay = (item.q || "") + (item.name || "");
        if (hay.includes(q) || hay.includes(nq)) {
          out.push({ kind, item });
        }
      }
    }
    out.sort((a, b) => {
      const aStart = a.item.name.startsWith(q) || a.item.name.startsWith(nq) ? 1 : 0;
      const bStart = b.item.name.startsWith(q) || b.item.name.startsWith(nq) ? 1 : 0;
      if (bStart !== aStart) return bStart - aStart;
      const near = (it) => it.cid === state.homeCountyId ? 1 : 0;
      return near(b.item) - near(a.item);
    });
    const clipped = out.slice(0, 20);
    if (!clipped.length) {
      box.innerHTML = "<li>沒有符合的結果</li>";
      box.hidden = false;
      return;
    }
    box.innerHTML = clipped.map((r, i) => {
      const it = r.item;
      const extra = [it.county, it.district, r.kind].filter(Boolean).join("　");
      return `<li data-i="${i}"><div>${it.name}${it.brand ? "　" + (BRANDS[it.brand]?.short || "") : ""}</div><div class="meta">${extra}</div></li>`;
    }).join("");
    box.hidden = false;
    box.querySelectorAll("li[data-i]").forEach((li) => {
      li.addEventListener("click", async () => {
        const r = clipped[Number(li.dataset.i)];
        box.hidden = true;
        $("searchInput").value = r.item.name;
        await pickSearch(r);
      });
    });
  }

  async function pickSearch(r) {
    const it = r.item;
    if (state.mode === "admin" && r.kind === "行政區") {
      await ensureDistricts();
      const d = (state.regionDistricts || []).find((x) => x.cid === it.cid && x.name === it.name);
      if (d) {
        await selectDistrict(d.code);
        return;
      }
    }
    if (state.mode !== "circle") {
      state.mode = "circle";
      syncModeButtons();
      showPanelForMode();
    }
    map.setView([it.lat, it.lng], 16);
    await setCenter(it.lat, it.lng, it.name);
  }

  async function setMode(mode) {
    state.mode = mode;
    syncModeButtons();
    showPanelForMode();
    if (mode === "admin") {
      $("panelEmpty").hidden = false;
      $("panelEmpty").textContent = "正在載入各行政區資料…";
      $("panelBody").hidden = true;
      await Promise.all([ensureDistricts(), ensureMarkets(), ensureIncome()]);
      if (!state.selectedDistrict) {
        await ensureCountiesForCircle(state.center.lat, state.center.lng, 50);
        const here = findPlace(state.center.lat, state.center.lng);
        const first = here
          ? (state.regionDistricts || []).find((d) => d.cid === here.cid && d.name === here.district)
          : (state.regionDistricts || [])[0];
        if (first) state.selectedDistrict = first.code;
      }
      if (state.selectedDistrict) {
        const d0 = getDistrict(state.selectedDistrict);
        if (d0?.cid) await ensureCounty(d0.cid);
        state.stats = estimateDistrict(state.selectedDistrict);
        state.placeName = state.stats?.district?.name || "";
        if (state.stats?.homeCountyId) state.homeCountyId = state.stats.homeCountyId;
      }
      drawAdminMode();
      fitBBoxes(visibleDistricts());
      showPanelForMode();
      if (state.stats) renderPanel();
    } else if (mode === "predict" || mode === "open") {
      districtLayer.clearLayers();
      circleLayer.clearLayers();
      villageLayer.clearLayers();
      storeLayer.clearLayers();
      restoLayer.clearLayers();
      if (marketLayer) marketLayer.clearLayers();
      if (map.hasLayer(centerMarker)) map.removeLayer(centerMarker);
      syncOverlay();
      if (mode === "predict" && state.predict.ran) {
        drawPredictLayers();
        renderPredictList();
      } else if (mode === "open" && state.open.ran) {
        drawOpenLayers();
        renderOpenList();
      } else {
        heatLayer.clearLayers();
        predictLayer.clearLayers();
        $("legend").hidden = true;
      }
      drawCompareMarkers();
    } else {
      districtLayer.clearLayers();
      heatLayer.clearLayers();
      predictLayer.clearLayers();
      map.setView([state.center.lat, state.center.lng], 15);
      await setCenter(state.center.lat, state.center.lng, state.placeName);
    }
    refreshMapSize();
  }

  function unpackGrid(payload) {
    const { cells, districts, villages, fields, radii, cid, county, nullChange } = payload;
    const nF = fields.length;
    const idx = Object.fromEntries(fields.map((f, i) => [f, i]));
    return cells.map((row) => {
      const lat = row[0] / 1e5;
      const lng = row[1] / 1e5;
      const district = districts[row[2]];
      const village = villages[row[3]];
      const byR = {};
      radii.forEach((r, i) => {
        const off = 4 + i * nF;
        const get = (name) => row[off + idx[name]];
        const rec = {
          pop: get("pop"),
          hh: get("hh"),
          y1: get("y1") === (nullChange ?? GRID_NULL) ? null : get("y1") / 10,
          y5: get("y5") === (nullChange ?? GRID_NULL) ? null : get("y5") / 10,
          age: [get("a0"), get("a1"), get("a2"), get("a3"), get("a4")],
          s711: get("s7"),
          fami: get("sf"),
          sbux: get("ss"),
          mcd: get("sm"),
          resto: get("rs"),
        };
        rec.cvs = rec.s711 + rec.fami;
        rec.perCvs = rec.cvs > 0 ? rec.pop / rec.cvs : null;
        rec.share = rec.pop ? rec.age.map((a) => (100 * a) / rec.pop) : [0, 0, 0, 0, 0];
        rec.density = rec.pop / (Math.PI * (r / 1000) ** 2);
        byR[r] = rec;
      });
      return { lat, lng, cid, county, district, village, byR };
    });
  }

  async function ensureGrid(cid) {
    if (state.gridCache[cid]) return state.gridCache[cid];
    const raw = await loadJSON("data/grid_" + cid + ".json");
    state.gridCache[cid] = unpackGrid(raw);
    return state.gridCache[cid];
  }

  function predictValue(cell, radius, metric) {
    const r = cell.byR[radius];
    if (!r) return null;
    if (metric === "age65") return r.share[4];
    if (metric === "age2544") return r.share[2];
    if (metric === "age014") return r.share[0];
    if (metric === "pop") return r.pop;
    if (metric === "y1") return r.y1;
    if (metric === "y5") return r.y5;
    if (metric === "perCvs") return r.perCvs;
    if (metric === "resto") return r.resto;
    if (metric === "age45p") return (r.share[3] || 0) + (r.share[4] || 0);
    if (metric === "age4564") return r.share[3];
    if (metric === "mk") return r.mk;
    if (metric === "perMkt") {
      if (r.mk == null) return null;
      return r.mk > 0 ? r.pop / r.mk : r.pop + 1e9;
    }
    if (metric === "nearMkt") return r.nearMkt;
    if (metric === "incMed") return r.incMed;
    return null;
  }

  function fmtPredictValue(metric, v) {
    if (v == null) return "—";
    const kind = PREDICT_METRICS[metric]?.kind;
    if (kind === "pct") return v.toFixed(1) + "%";
    if (kind === "pctSigned") return fmtPct(v);
    if (kind === "meters") return fmtInt(v) + " 公尺";
    if (metric === "perMkt" && v >= 1e9) return "尚無市場";
    if (kind === "wan") return fmtWan(v);
    return fmtInt(v);
  }

  function readPredictForm() {
    const maxRaw = $("predictMaxPop").value.trim();
    state.predict.metric = $("predictMetric").value;
    state.predict.desc = $("predictDir").value !== "asc";
    state.predict.minPop = Number($("predictMinPop").value || 0);
    state.predict.maxPop = maxRaw === "" ? null : Number(maxRaw);
    state.predict.scopeCounty = $("predictCounty").value;
    state.predict.scopeDistrict = $("predictDistrict").value;
    state.predict.radius = Number($("predictRadius").value);
    state.predict.topN = Number($("predictTopN").value);
    state.predict.showHeat = $("predictHeat").checked;
    const maxMkRaw = $("predictMaxMk") ? $("predictMaxMk").value.trim() : "";
    state.predict.maxMk = maxMkRaw === "" ? null : Number(maxMkRaw);
    const minIncRaw = $("predictMinInc") ? $("predictMinInc").value.trim() : "";
    const maxIncRaw = $("predictMaxInc") ? $("predictMaxInc").value.trim() : "";
    state.predict.minInc = minIncRaw === "" ? null : Number(minIncRaw);
    state.predict.maxInc = maxIncRaw === "" ? null : Number(maxIncRaw);
  }

  async function runPredict(ev) {
    if (ev) ev.preventDefault();
    readPredictForm();
    const status = $("predictStatus");
    const ids = state.predict.scopeCounty
      ? [state.predict.scopeCounty]
      : (state.meta.counties || []).map((c) => c.id);
    status.textContent = "正在載入網格資料…";
    $("predictResults").innerHTML = "";
    let cells = [];
    try {
      const parts = await Promise.all([
        ...ids.map(ensureGrid),
        ...ids.map(ensureCounty),
        ensureMarkets(),
        ensureIncome(),
      ]);
      cells = parts.slice(0, ids.length).flat();
    } catch (err) {
      status.textContent = "載入失敗：" + err.message;
      return;
    }
    const radius = state.predict.radius;
    const metric = state.predict.metric;
    const mkts = state.markets || [];
    const list = [];
    for (const c of cells) {
      if (state.predict.scopeDistrict && c.district !== state.predict.scopeDistrict) continue;
      const rec = c.byR[radius];
      if (!rec) continue;
      if (rec.pop < state.predict.minPop) continue;
      if (state.predict.maxPop != null && rec.pop > state.predict.maxPop) continue;
      let mk = 0, near = Infinity;
      for (const m of mkts) {
        const d = distM(c.lat, c.lng, m.lat, m.lng);
        if (d <= radius) mk += 1;
        if (d < near) near = d;
      }
      rec.mk = mk;
      rec.nearMkt = Number.isFinite(near) ? near : null;
      rec.perMkt = mk > 0 ? rec.pop / mk : null;
      const incEst = estimatePointIncome(c.lat, c.lng, radius);
      rec.incMed = incEst ? incEst.med : null;
      rec.incAvg = incEst ? incEst.avg : null;
      if (state.predict.maxMk != null && mk > state.predict.maxMk) continue;
      if (state.predict.minInc != null && (rec.incMed == null || rec.incMed / 10 < state.predict.minInc)) continue;
      if (state.predict.maxInc != null && (rec.incMed == null || rec.incMed / 10 > state.predict.maxInc)) continue;
      const v = predictValue(c, radius, metric);
      if (v == null) continue;
      list.push(c);
    }
    list.sort((a, b) => {
      const va = predictValue(a, radius, metric);
      const vb = predictValue(b, radius, metric);
      return state.predict.desc ? vb - va : va - vb;
    });
    const picked = [];
    for (const c of list) {
      if (picked.every((p) => distM(p.lat, p.lng, c.lat, c.lng) >= radius)) {
        picked.push(c);
        if (picked.length >= state.predict.topN) break;
      }
    }
    state.predict.results = picked;
    state.predict.filtered = list;
    state.predict.ran = true;
    const scopeLabel = state.predict.scopeDistrict
      ? (countyName(state.predict.scopeCounty) + state.predict.scopeDistrict)
      : (state.predict.scopeCounty ? countyName(state.predict.scopeCounty) : "北台灣五縣市");
    const extras = [];
    if (state.predict.maxPop != null) extras.push(`人口 ≤ ${fmtInt(state.predict.maxPop)}`);
    if (state.predict.maxMk != null) extras.push(`市場數 ≤ ${state.predict.maxMk}`);
    if (state.predict.minInc != null) extras.push(`所得中位數 ≥ ${state.predict.minInc} 萬`);
    if (state.predict.maxInc != null) extras.push(`所得中位數 ≤ ${state.predict.maxInc} 萬`);
    const extraTxt = extras.length ? "、" + extras.join("、") : "";
    status.textContent = `在 ${scopeLabel}、${radius}m、人口 ≥ ${fmtInt(state.predict.minPop)}${extraTxt} 的格子中，依「${PREDICT_METRICS[metric].label}」列出前 ${picked.length} 名（已去除過近的點）。人口為戶籍估算；所得為綜合所得稅申報資料（不含免稅所得，所得年 112）各里中位數之納稅單位加權平均。`;
    drawPredictLayers();
    renderPredictList();
    if (picked.length) {
      const b = L.latLngBounds(picked.map((c) => [c.lat, c.lng]));
      map.fitBounds(b, { padding: [40, 40], maxZoom: 14 });
    }
  }

  function drawPredictLayers() {
    heatLayer.clearLayers();
    predictLayer.clearLayers();
    const radius = state.predict.radius;
    const metric = state.predict.metric;
    const meta = PREDICT_METRICS[metric];
    if (state.predict.showHeat && state.predict.filtered.length) {
      if (!heatRenderer) heatRenderer = L.canvas({ padding: 0.35 });
      const vals = state.predict.filtered.map((c) => predictValue(c, radius, metric)).filter((v) => v != null);
      const min = Math.min(...vals);
      const max = Math.max(...vals);
      for (const c of state.predict.filtered) {
        const v = predictValue(c, radius, metric);
        if (v == null) continue;
        const t = max === min ? 0.5 : (v - min) / (max - min);
        L.circleMarker([c.lat, c.lng], {
          renderer: heatRenderer,
          radius: 9,
          stroke: false,
          fillColor: colorRamp(t),
          fillOpacity: 0.42,
        }).addTo(heatLayer);
      }
      renderMetricLegend(meta.label, min, max, meta.kind);
    } else {
      $("legend").hidden = true;
    }
    state.predict.results.forEach((c, i) => {
      const icon = L.divIcon({
        className: "compare-icon",
        html: String(i + 1),
        iconSize: [24, 24],
        iconAnchor: [12, 12],
      });
      const rec = c.byR[radius];
      const v = predictValue(c, radius, metric);
      L.marker([c.lat, c.lng], { icon, zIndexOffset: 700 })
        .bindTooltip(`${i + 1}. ${c.district}${c.village}　${fmtPredictValue(metric, v)}`)
        .on("click", () => openPredictorResult(c))
        .addTo(predictLayer);
    });
    drawCompareMarkers();
  }

  function renderPredictList() {
    const box = $("predictResults");
    const radius = state.predict.radius;
    const metric = state.predict.metric;
    if (!state.predict.results.length) {
      box.innerHTML = "<li>沒有符合條件的點，請放寬最低人口或其他條件。</li>";
      return;
    }
    box.innerHTML = state.predict.results.map((c, i) => {
      const rec = c.byR[radius];
      const v = predictValue(c, radius, metric);
      const loc = `${c.district}${c.village}`;
      const countyBit = state.predict.scopeCounty ? "" : `　${c.county}`;
      return `<li data-i="${i}">
        <div><span class="rank">${i + 1}.</span><span class="pred-title">${loc}</span>${countyBit}</div>
        <div class="pred-nums">
          ${PREDICT_METRICS[metric].label} ${fmtPredictValue(metric, v)}
          　人口 ${fmtInt(rec.pop)}　戶數 ${fmtInt(rec.hh)}
          　65歲以上 ${rec.share[4].toFixed(1)}%　25–44歲 ${rec.share[2].toFixed(1)}%
          　超商 ${rec.cvs}　每家超商 ${rec.perCvs == null ? "—" : fmtInt(rec.perCvs)} 人
          　市場 ${rec.mk ?? "—"}　每市場 ${rec.mk ? fmtInt(rec.pop / rec.mk) : "尚無市場"} 人
          ${rec.nearMkt != null ? "　最近市場 " + fmtInt(rec.nearMkt) + " 公尺" : ""}
          ${rec.incMed != null ? "　所得中位數 " + fmtWan(rec.incMed) : ""}
          ${rec.resto ? "　OSM 餐廳 " + rec.resto : ""}
        </div>
      </li>`;
    }).join("");
    box.querySelectorAll("li[data-i]").forEach((li) => {
      li.addEventListener("click", () => {
        const c = state.predict.results[Number(li.dataset.i)];
        if (c) openPredictorResult(c);
      });
    });
  }

  async function openPredictorResult(cell) {
    state.mode = "circle";
    syncModeButtons();
    showPanelForMode();
    map.setView([cell.lat, cell.lng], 16);
    await setCenter(cell.lat, cell.lng, cell.district + cell.village);
    $("panel").scrollIntoView({ block: "nearest" });
  }

  function fillCountySelects() {
    const opts = (state.meta.counties || []).map((c) => `<option value="${c.id}">${c.name}</option>`).join("");
    $("adminCountyFilter").innerHTML = `<option value="">全部縣市</option>` + opts;
    $("predictCounty").innerHTML = `<option value="">全區域</option>` + opts;
    $("predictCounty").value = "taoyuan";
    fillPredictDistricts();
    if ($("openCounty")) {
      $("openCounty").innerHTML = opts;
      $("openCounty").value = "taoyuan";
      fillOpenDistricts();
    }
  }

  function fillPredictDistricts() {
    const cid = $("predictCounty").value;
    const sel = $("predictDistrict");
    const names = cid ? (state.meta.counties.find((c) => c.id === cid)?.districtNames || []) : [];
    const prev = sel.value;
    sel.innerHTML = `<option value="">全部</option>` + names.map((n) => `<option value="${n}">${n}</option>`).join("");
    if (names.includes(prev)) sel.value = prev;
  }

  async function loadRestaurants() {
    state.restaurants = null;
    renderRestaurants();
    restoLayer.clearLayers();
    const q = `[out:json][timeout:25];node["amenity"="restaurant"](around:${state.radius},${state.center.lat},${state.center.lng});out;`;
    const servers = [
      "https://overpass-api.de/api/interpreter",
      "https://maps.mail.ru/osm/tools/overpass/api/interpreter",
    ];
    let data = null;
    for (const srv of servers) {
      try {
        const res = await fetch(srv, {
          method: "POST",
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
          body: "data=" + encodeURIComponent(q),
        });
        if (!res.ok) continue;
        data = await res.json();
        break;
      } catch (e) { /* try next */ }
    }
    if (!data) {
      state.restaurants = [];
      $("restoSection").innerHTML = "<p class='src-note'>目前無法連線 OpenStreetMap Overpass，請稍後再試。</p>";
      $("tabResto").hidden = false;
      return;
    }
    const list = [];
    const seen = new Set();
    for (const el of data.elements || []) {
      if (el.lat == null) continue;
      const name = (el.tags && (el.tags.name || el.tags["name:zh"])) || "未命名餐廳";
      const key = name + "|" + el.lat.toFixed(5) + "|" + el.lon.toFixed(5);
      if (seen.has(key)) continue;
      seen.add(key);
      const dist = distM(state.center.lat, state.center.lng, el.lat, el.lon);
      list.push({ name, lat: el.lat, lng: el.lon, dist, cuisine: el.tags?.cuisine || "" });
    }
    list.sort((a, b) => a.dist - b.dist);
    state.restaurants = list;
    list.forEach((r) => {
      L.circleMarker([r.lat, r.lng], { radius: 5, color: "#7c3aed", weight: 1, fillOpacity: 0.8 })
        .bindPopup(`<strong>${r.name}</strong><br>${Math.round(r.dist)} 公尺`)
        .addTo(restoLayer);
    });
    renderRestaurants();
    if (state.tab === "resto") showTab("resto");
  }

  function fillOpenDistricts() {
    const sel = $("openDistrict");
    if (!sel) return;
    const cid = $("openCounty").value;
    const names = cid ? (state.meta.counties.find((c) => c.id === cid)?.districtNames || []) : [];
    const prev = sel.value;
    sel.innerHTML = `<option value="">全部</option>` + names.map((n) => `<option value="${n}">${n}</option>`).join("");
    if (names.includes(prev)) sel.value = prev;
  }

  function syncOpenWeightLabels() {
    if ($("openWDemandVal")) $("openWDemandVal").textContent = $("openWDemand").value;
    if ($("openWCompVal")) $("openWCompVal").textContent = $("openWComp").value;
    if ($("openWIncVal")) $("openWIncVal").textContent = $("openWInc").value;
  }

  function readOpenForm() {
    if (!$("openForm")) return;
    state.open.scopeCounty = $("openCounty").value || "taoyuan";
    state.open.scopeDistrict = $("openDistrict").value;
    state.open.radius = Number($("openRadius").value);
    state.open.topN = Number($("openTopN").value);
    state.open.minPop = Number($("openMinPop").value || 0);
    const minIncRaw = $("openMinInc").value.trim();
    state.open.minInc = minIncRaw === "" ? null : Number(minIncRaw);
    state.open.wDemand = Number($("openWDemand").value);
    state.open.wComp = Number($("openWComp").value);
    state.open.wInc = Number($("openWInc").value);
    state.open.showHeat = $("openHeat").checked;
    syncOpenWeightLabels();
  }

  function applyOpenScores() {
    const rows = state.open.scored || [];
    const pD = percentRanks(rows.map((r) => r.demand));
    const pC = percentRanks(rows.map((r) => r.perShopMkt1));
    const pI = percentRanks(rows.map((r) => r.incMed));
    const wD = state.open.wDemand, wC = state.open.wComp, wI = state.open.wInc;
    rows.forEach((r, i) => {
      r.pDemand = pD[i];
      r.pComp = pC[i];
      r.pInc = r.incMed == null ? null : pI[i];
      const parts = composeScore(r.pDemand, r.pComp, r.pInc, wD, wC, wI);
      r.scoreParts = parts;
      r.score = parts ? parts.score : null;
    });
    rows.sort((a, b) => (b.score ?? -1) - (a.score ?? -1));
    const picked = [];
    const radius = state.open.radius;
    for (const r of rows) {
      if (r.score == null) continue;
      if (picked.every((p) => distM(p.lat, p.lng, r.lat, r.lng) >= radius)) {
        picked.push(r);
        if (picked.length >= state.open.topN) break;
      }
    }
    state.open.results = picked;
    return picked;
  }

  function serializeOpenRow(r, i) {
    return {
      rank: i + 1,
      county: r.county,
      district: r.district,
      village: r.village,
      lat: r.lat,
      lng: r.lng,
      pop: r.pop,
      shopDemand: r.demand,
      shopIndex: r.index,
      pop3059: r.pop3059,
      pop4059: r.pop4059,
      fem3069: r.fem3069,
      mk: r.mk,
      perShopMkt1: r.perShopMkt1,
      nearestMarket: r.nearName,
      nearMkt: r.near,
      incMed: r.incMed,
      score: r.score,
      pDemand: r.pDemand,
      pComp: r.pComp,
      pInc: r.pInc,
    };
  }

  async function runOpen(ev) {
    if (ev) ev.preventDefault();
    readOpenForm();
    const status = $("openStatus");
    const cid = state.open.scopeCounty;
    status.textContent = "正在載入網格與村里資料…";
    $("openResults").innerHTML = "";
    let cells = [];
    try {
      await Promise.all([ensureGrid(cid), ensureCounty(cid), ensureMarkets(), ensureIncome(), ensureShopper()]);
      cells = state.gridCache[cid] || [];
    } catch (err) {
      status.textContent = "載入失敗：" + err.message;
      return;
    }
    const radius = state.open.radius;
    const mkts = state.markets || [];
    const scored = [];
    const total = cells.length;
    let seen = 0;
    for (const c of cells) {
      seen += 1;
      if (seen % 500 === 0) {
        status.textContent = `正在估算第 ${seen}／${total} 格…`;
        await new Promise((r) => setTimeout(r, 0));
      }
      if (state.open.scopeDistrict && c.district !== state.open.scopeDistrict) continue;
      const rec = c.byR[radius];
      if (!rec) continue;
      if (rec.pop < state.open.minPop) continue;
      const hits = collectVillageShares(c.lat, c.lng, radius);
      let { bins, fb, wpop } = ageBinsFromHits(hits);
      if (wpop > 0 && rec.pop) {
        const fac = rec.pop / wpop;
        bins = scaleBins(bins, fac);
        fb = scaleBins(fb, fac);
      }
      const shop = shopperDemandFromBins(bins, fb);
      if (shop.demand == null) continue;
      const inc = incomeWeighted(hits.filter((h) => h.v.inc));
      const incMed = inc ? inc.med : null;
      if (state.open.minInc != null && (incMed == null || incMed / 10 < state.open.minInc)) continue;
      let mk = 0, near = Infinity, nearName = null;
      for (const m of mkts) {
        const d = distM(c.lat, c.lng, m.lat, m.lng);
        if (d <= radius) mk += 1;
        if (d < near) { near = d; nearName = m.name; }
      }
      scored.push({
        lat: c.lat,
        lng: c.lng,
        cid: c.cid,
        county: c.county,
        district: c.district,
        village: c.village,
        pop: rec.pop,
        hh: rec.hh,
        demand: shop.demand,
        index: shop.index,
        adults: shop.adults,
        groups: shop.groups,
        pop3059: shop.pop3059,
        pop4059: shop.pop4059,
        fem3069: shop.fem3069,
        mk,
        near: Number.isFinite(near) ? near : null,
        nearName,
        incMed,
        perShopMkt1: shop.demand / (mk + 1),
      });
    }
    state.open.scored = scored;
    state.open.demandValues = scored.map((r) => r.demand);
    state.open.compValues = scored.map((r) => r.perShopMkt1);
    state.open.incValues = scored.map((r) => r.incMed).filter((v) => v != null);
    const picked = applyOpenScores();
    state.open.ran = true;
    const scopeLabel = state.open.scopeDistrict
      ? countyName(cid) + state.open.scopeDistrict
      : countyName(cid);
    const extras = [];
    if (state.open.minPop) extras.push(`人口 ≥ ${fmtInt(state.open.minPop)}`);
    if (state.open.minInc != null) extras.push(`所得中位數 ≥ ${state.open.minInc} 萬`);
    status.textContent = `在 ${scopeLabel}、${radius}m${extras.length ? "、" + extras.join("、") : ""} 的 ${fmtInt(scored.length)} 個格子中，依開店評分列出前 ${picked.length} 名（已去除過近的點）。年齡權重來自臺南市市場調查，套用到本地是假設。`;
    drawOpenLayers();
    renderOpenList();
    if (picked.length) {
      const b = L.latLngBounds(picked.map((c) => [c.lat, c.lng]));
      map.fitBounds(b, { padding: [40, 40], maxZoom: 13 });
    }
  }

  function rescoreOpen() {
    if (!state.open.ran) return;
    readOpenForm();
    applyOpenScores();
    const status = $("openStatus");
    if (status && state.open.scored) {
      status.textContent = `已用目前權重重新計算評分，列出前 ${state.open.results.length} 名。需求 ${state.open.wDemand}、低競爭 ${state.open.wComp}、所得 ${state.open.wInc}。`;
    }
    if (state.mode === "open") {
      drawOpenLayers();
      renderOpenList();
    }
  }

  function drawOpenLayers() {
    heatLayer.clearLayers();
    predictLayer.clearLayers();
    if (state.open.showHeat && state.open.scored.length) {
      if (!heatRenderer) heatRenderer = L.canvas({ padding: 0.35 });
      const vals = state.open.scored.map((r) => r.score).filter((v) => v != null);
      const min = Math.min(...vals);
      const max = Math.max(...vals);
      for (const r of state.open.scored) {
        if (r.score == null) continue;
        const t = max === min ? 0.5 : (r.score - min) / (max - min);
        L.circleMarker([r.lat, r.lng], {
          renderer: heatRenderer,
          radius: 9,
          stroke: false,
          fillColor: colorRamp(t),
          fillOpacity: 0.42,
        }).addTo(heatLayer);
      }
      renderMetricLegend("開店評分", min, max, "int");
    } else {
      $("legend").hidden = true;
    }
    state.open.results.forEach((r, i) => {
      const icon = L.divIcon({
        className: "compare-icon",
        html: String(i + 1),
        iconSize: [24, 24],
        iconAnchor: [12, 12],
      });
      L.marker([r.lat, r.lng], { icon, zIndexOffset: 700 })
        .bindTooltip(`${i + 1}. ${r.district}${r.village}　評分 ${fmt1(r.score)}`)
        .on("click", () => openOpenResult(r))
        .addTo(predictLayer);
    });
    drawCompareMarkers();
  }

  function renderOpenList() {
    const box = $("openResults");
    if (!box) return;
    if (!state.open.results.length) {
      box.innerHTML = "<li>沒有符合條件的點，請放寬最低人口或其他條件。</li>";
      return;
    }
    box.innerHTML = state.open.results.map((r, i) => `
      <li data-i="${i}">
        <div><span class="rank">${i + 1}.</span><span class="pred-title">${r.district}${r.village}</span></div>
        <div class="pred-nums">
          開店評分 ${fmt1(r.score)}
          　潛在客群 ${fmtInt(r.demand)}（指數 ${fmt1(r.index)}）
          　40–59歲 ${fmtInt(r.pop4059)}　30–59歲 ${fmtInt(r.pop3059)}
          　女性30–69歲 ${fmtInt(r.fem3069)}
          　市場 ${r.mk}　每(市場+1)服務 ${fmtInt(r.perShopMkt1)} 人
          ${r.near != null ? "　最近 " + (r.nearName || "市場") + " " + fmtInt(r.near) + " 公尺" : ""}
          ${r.incMed != null ? "　所得中位數 " + fmtWan(r.incMed) : ""}
          　需求百分位 ${fmt1(r.pDemand)}　低競爭百分位 ${fmt1(r.pComp)}
        </div>
      </li>`).join("");
    box.querySelectorAll("li[data-i]").forEach((li) => {
      li.addEventListener("click", () => {
        const r = state.open.results[Number(li.dataset.i)];
        if (r) openOpenResult(r);
      });
    });
  }

  async function openOpenResult(row) {
    setRadius(state.open.radius);
    state.mode = "circle";
    syncModeButtons();
    showPanelForMode();
    map.setView([row.lat, row.lng], 16);
    await setCenter(row.lat, row.lng, row.district + row.village);
    state.tab = "open";
    showTab("open");
    const focus = $("openSection") || $("tabOpen");
    if (focus) focus.scrollIntoView({ block: "start" });
  }

  function renderOpenSection(s) {
    const box = $("openSection");
    if (!box) return;
    const meta = shopperMeta();
    if (!meta) {
      box.innerHTML = "<p class='src-note'>正在載入菜市場消費年齡權重…</p>";
      return;
    }
    const labels = {
      "20-29": "20–29歲", "30-39": "30–39歲", "40-49": "40–49歲",
      "50-59": "50–59歲", "60-69": "60–69歲", "70-79": "70–79歲", "80+": "80歲以上",
    };
    const adults = s.shopAdults || 0;
    const rows = Object.keys(meta.ageBins).map((g) => {
      const pop = (s.shopGroups && s.shopGroups[g]) || 0;
      const share = adults ? (100 * pop) / adults : 0;
      const shop = (meta.survey.ageShares[g] || 0) * 100;
      return `<div class="shop-row"><span>${labels[g]}</span><span class="shop-track"><i style="width:${Math.min(100, share)}%"></i></span><span>${share.toFixed(1)}%</span></div>
        <div class="shop-sub">圈內占20歲以上 ${share.toFixed(1)}%　臺南市場消費者 ${shop.toFixed(1)}%　消費傾向 ${meta.propensity[g].toFixed(2)}</div>`;
    }).join("");
    const mkNote = s.perShopMkt1 == null ? "" : `以潛在客群 ÷ (市場數 + 1) 計算，目前為 ${fmtInt(s.perShopMkt1)} 人。`;
    const scoreNote = s.shopScoreParts
      ? `<p>開店評分 <strong>${fmt1(s.shopScore)}</strong>＝（需求權重 ${s.shopScoreParts.wD} × 需求百分位 ${fmt1(s.shopScoreParts.pD)} + 低競爭權重 ${s.shopScoreParts.wC} × 低競爭百分位 ${fmt1(s.shopScoreParts.pC)}${s.shopScoreParts.wI > 0 && s.shopScoreParts.pI != null ? ` + 所得權重 ${s.shopScoreParts.wI} × 所得百分位 ${fmt1(s.shopScoreParts.pI)}` : ""}）÷ 權重總和。百分位是與「菜市場開店」同半徑、同範圍網格比較的結果。</p>`
      : `<p class="src-note">到「菜市場開店」用相同半徑分析後，這裡會顯示與同批點位比較的評分與百分位。</p>`;
    const mktList = (s.marketsIn || []).map((m) =>
      `<li><strong>${m.name}</strong>　${m.type || ""}　${Math.round(m.dist)} 公尺${m.address ? "<br>" + m.address : ""}</li>`
    ).join("");
    box.innerHTML = `
      <p class="src-warn">年齡權重來自臺南市市場處《${meta.survey.name}》（${meta.survey.surveyMonth}調查，${meta.survey.n}份有效問卷，${meta.survey.marketCount}處公有市場）。套用到桃園市與北台灣是假設，不是當地消費調查。女性消費者占 ${ (meta.survey.female*100).toFixed(1) }%，此比例未再另作加權。</p>
      <div class="open-kvs">
        <div><div class="k">菜市場潛在客群</div><div class="n">${s.shopDemand == null ? "—" : fmtInt(s.shopDemand)}</div></div>
        <div><div class="k">潛在客群指數</div><div class="n">${s.shopIndex == null ? "—" : fmt1(s.shopIndex)}</div></div>
        <div><div class="k">30–59歲人口</div><div class="n">${fmtInt(s.pop3059)}</div></div>
        <div><div class="k">40–59歲人口</div><div class="n">${fmtInt(s.pop4059)}</div></div>
        <div><div class="k">女性 30–69歲</div><div class="n">${fmtInt(s.fem3069)}</div></div>
        <div><div class="k">圈內傳統市場</div><div class="n">${s.marketCount || 0}</div></div>
      </div>
      <p>指數 100 代表成年人口的消費傾向與臺南市民國111年4月20歲以上人口結構相同。潛在客群 ＝ Σ（各年齡層人口 × 消費傾向）÷ 0.975；消費傾向 ＝ 該年齡層消費者占比 ÷ 臺南市同年齡層占20歲以上人口之比。</p>
      ${scoreNote}
      <p>${mkNote} 最近市場：${s.nearestMarket ? `${s.nearestMarket.name} ${Math.round(s.nearestMarket.dist)} 公尺` : "本次資料範圍內沒有對到市場"}。</p>
      <h4>年齡結構對照市場消費者</h4>
      ${rows}
      <p class="src-note">20歲以下、70–79歲、80歲以上在調查圖一未印出百分比；前兩項以外的剩餘 6.3% 依扇形角度量得為 2.5%、3.1%、0.7%。20歲以下不納入潛在客群（消費傾向分母為20歲以上人口）。圖一標示：20–29歲 9.5%、30–39歲 17.5%、40–49歲 26.1%、50–59歲 27.6%、60–69歲 13%。</p>
      <h4>附近傳統市場</h4>
      <ul class="store-list">${mktList || "<li>此範圍沒有列管或對位到的傳統市場</li>"}</ul>
    `;
  }


  function renderFooter() {
    const src = state.meta.sources || [];
    let body = src.map((s) => {
      const dates = (s.dates || [s.date]).filter(Boolean).join("、");
      return `<div><strong>${s.name}</strong>　${s.org || ""}${dates ? "　" + dates : ""}${s.note ? "　" + s.note : ""}</div>`;
    }).join("") +
      `<div>${state.meta.method || ""}</div>
       <div>人口為戶籍登記數，非常住／實際居住人口。步行圈以村里多邊形與圓相交的面積比例估算，假設人口在村里內均勻分布。</div>
       <div>點位預判器的 OSM 餐廳數來自 OpenStreetMap 的 amenity=restaurant 節點，僅供參考。</div>`;
    if (state.marketMeta) {
      const n = state.marketMeta.count || (state.markets || []).length;
      body += `<div><strong>傳統市場</strong>　經濟部商業發展署全國零售市場基本資料（<a href="https://data.gov.tw/dataset/59855">data.gov.tw 59855</a>，品管 2026-09-18）以及臺北市市場處、新北市市場處、桃園市政府經濟發展局、新竹市政府開放名單；座標以官方門牌地理編碼與 OpenStreetMap amenity=marketplace 核對、補遺（2026-11-10 建置，共 ${n} 處）。已排除夜市、超市／量販與批發市場。新北市民有攤集區等未公開名單、以及未經列管的巷口早市，不會出現在地圖上。</div>`;
    }
    if (state.income && state.income.source) {
      const j = state.income.join || {};
      const matched = j.matched != null ? j.matched : "";
      const polys = j.polygons != null ? j.polygons : "";
      body += `<div><strong>村里綜合所得</strong>　財政部財政資訊中心「綜稅綜合所得總額各縣市鄉鎮村里統計分析表」112年度（所得年 2023；<a href="https://data.gov.tw/dataset/103066">data.gov.tw 103066</a>）。此為綜合所得稅申報資料，不含免稅所得、政府移轉支出與分離課稅所得；原表金額單位為千元，畫面改以萬元顯示。步行圈數字為圈內各里中位數／平均數按納稅單位（申報戶）加權平均，再與所在縣市同樣口徑比較；行政區中位數取各區合計列。114–115年新設里沿用分里前原里的 112 年統計（對上 ${matched}/${polys} 里）。</div>`;
    }
    const shop = state.shopper;
    if (shop && shop.survey) {
      body += `<div><strong>菜市場消費年齡</strong>　${shop.survey.org}《${shop.survey.name}》（${shop.survey.surveyMonth}調查，報告${shop.survey.reportMonth}；${shop.survey.marketCount}處公有市場，有效問卷 ${shop.survey.n} 份）。圖一標示 20–29歲 9.5%、30–39歲 17.5%、40–49歲 26.1%、50–59歲 27.6%、60–69歲 13%；20歲以下、70–79歲、80歲以上未印百分比，依同一圓餅圖扇形量得剩餘 6.3% 分別為 2.5%、3.1%、0.7%。女性占 62.2%。消費傾向以各年齡層消費者占比除以臺南市民國111年4月戶政司 ODRP014 20歲以上人口占比。此權重套用到桃園市與北台灣是假設，不是當地消費調查。</div>`;
    }
    $("footer").innerHTML = `<details class="sources" id="sourceDetails"><summary>資料來源</summary><div class="source-body">${body}</div></details>`;
    syncSourceDetails();
  }

  function bindUI() {
    $("btnModeCircle").addEventListener("click", () => setMode("circle"));
    $("btnModeAdmin").addEventListener("click", () => setMode("admin"));
    $("btnModePredict").addEventListener("click", () => setMode("predict"));
    if ($("btnModeOpen")) $("btnModeOpen").addEventListener("click", () => setMode("open"));
    $("adminCountyFilter").addEventListener("change", (e) => {
      state.adminCountyFilter = e.target.value;
      if (state.mode === "admin") {
        drawAdminMode();
        fitBBoxes(visibleDistricts());
      }
    });
    document.querySelectorAll("#radiusBar button").forEach((b) => {
      b.addEventListener("click", () => setRadius(Number(b.dataset.r)));
    });
    $("indicatorSelect").addEventListener("change", (e) => {
      state.indicator = e.target.value;
      if (state.mode === "admin") drawAdminMode();
    });
    $("searchInput").addEventListener("focus", () => { ensureSearch(); });
    $("searchInput").addEventListener("input", (e) => {
      clearTimeout(searchTimer);
      searchTimer = setTimeout(async () => {
        await ensureSearch();
        doSearch(e.target.value);
      }, 160);
    });
    $("searchInput").addEventListener("keydown", (e) => {
      if (e.key === "Escape") $("searchResults").hidden = true;
    });
    document.addEventListener("click", (e) => {
      if (!e.target.closest(".search-box")) $("searchResults").hidden = true;
    });
    document.querySelectorAll(".tabs [data-tab]").forEach((b) => {
      b.addEventListener("click", () => showTab(b.dataset.tab));
    });
    $("btnCompare").addEventListener("click", addCompare);
    $("btnClearCompare").addEventListener("click", () => {
      state.compare = [];
      renderCompare();
      drawCompareMarkers();
      if (state.mode !== "predict" && state.mode !== "open" && state.stats) renderPanel();
    });
    $("predictForm").addEventListener("submit", runPredict);
    $("predictCounty").addEventListener("change", fillPredictDistricts);
    $("predictHeat").addEventListener("change", () => {
      state.predict.showHeat = $("predictHeat").checked;
      if (state.predict.ran && state.mode === "predict") drawPredictLayers();
    });
    if ($("openForm")) {
      $("openForm").addEventListener("submit", runOpen);
      $("openCounty").addEventListener("change", fillOpenDistricts);
      $("openHeat").addEventListener("change", () => {
        state.open.showHeat = $("openHeat").checked;
        if (state.open.ran && state.mode === "open") drawOpenLayers();
      });
      ["openWDemand", "openWComp", "openWInc"].forEach((id) => {
        $(id).addEventListener("input", () => {
          syncOpenWeightLabels();
          if (state.open.ran) rescoreOpen();
        });
      });
      $("openTopN").addEventListener("change", () => {
        if (state.open.ran) rescoreOpen();
      });
    }
    window.addEventListener("resize", () => {
      syncSourceDetails();
      refreshMapSize();
    });
    window.addEventListener("orientationchange", () => {
      setTimeout(() => { syncSourceDetails(); refreshMapSize(); }, 250);
    });
    if (window.visualViewport) {
      window.visualViewport.addEventListener("resize", refreshMapSize);
    }
    if ($("toggleMarkets")) {
      $("toggleMarkets").addEventListener("change", (e) => {
        state.showMarkets = e.target.checked;
        drawMarkets(state.stats?.marketsIn || []);
      });
    }
    $("toggleRestaurants").addEventListener("change", (e) => {
      state.showRestaurants = e.target.checked;
      if (state.showRestaurants) {
        loadRestaurants();
        showTab("resto");
      } else {
        restoLayer.clearLayers();
        state.restaurants = [];
        $("tabResto").hidden = true;
        if (state.tab === "resto") showTab("age");
      }
    });
  }

  async function main() {
    initMap();
    bindUI();
    state.meta = await loadJSON("data/meta.json");
    fillCountySelects();
    const dc = state.meta.defaultCenter || {};
    if (dc.lat) {
      state.center = { lat: dc.lat, lng: dc.lng };
      state.placeName = dc.name || "中壢火車站";
      state.homeCountyId = dc.cid || "taoyuan";
    }
    renderFooter();
    await Promise.all([ensureCounty(state.homeCountyId), ensureMarkets(), ensureIncome(), ensureShopper()]);
    renderFooter();
    map.setView([state.center.lat, state.center.lng], 16);
    await setCenter(state.center.lat, state.center.lng, state.placeName);
    refreshMapSize();
  }

  window.__sq = {
    go: async (lat, lng, name) => {
      if (state.mode !== "circle") {
        state.mode = "circle";
        syncModeButtons();
        showPanelForMode();
      }
      map.setView([lat, lng], 16);
      await setCenter(lat, lng, name || null);
    },
    stats: () => {
      const s = state.stats;
      if (!s) return null;
      return {
        kind: s.kind,
        pop: s.pop,
        hh: s.hh,
        radius: s.radius,
        home: s.homeCountyName,
        vill: s.vill ? `${s.vill.county || ""}${s.vill.district}${s.vill.name}` : null,
        counties: [...new Set((s.hits || []).map((h) => h.v.county).filter(Boolean))],
        hits: (s.hits || []).map((h) => ({
          name: `${h.v.county || ""}${h.v.district}${h.v.name}`,
          ratio: Math.round(h.ratio * 100),
        })),
        ageShare: s.ageShare,
        cvs: s.cvs,
        marketCount: s.marketCount || 0,
        perMkt: s.perMkt,
        nearestMarket: s.nearestMarket ? { name: s.nearestMarket.name, type: s.nearestMarket.type, dist: s.nearestMarket.dist, address: s.nearestMarket.address } : null,
        markets: (s.marketsIn || []).map((m) => ({
          name: m.name, type: m.type, dist: m.dist, address: m.address, district: m.district,
        })),
        incMed: s.incMed,
        incAvg: s.incAvg,
        incN: s.incN,
        countyIncMed: s.countyIncMed,
        countyIncAvg: s.countyIncAvg,
        shopDemand: s.shopDemand,
        shopIndex: s.shopIndex,
        shopScore: s.shopScore,
        shopAdults: s.shopAdults,
        pop3059: s.pop3059,
        pop4059: s.pop4059,
        fem3069: s.fem3069,
        perShopMkt1: s.perShopMkt1,
        hitIncome: (s.hits || []).map((h) => ({
          name: `${h.v.county || ""}${h.v.district}${h.v.name}`,
          ratio: Math.round(h.ratio * 1000) / 10,
          incMed: h.v.inc ? h.v.inc.med : null,
          incAvg: h.v.inc ? h.v.inc.avg : null,
          incN: h.v.inc ? h.v.inc.n : null,
          how: h.v.inc ? h.v.inc.how : null,
          from: h.v.inc ? h.v.inc.from : null,
        })),
      };
    },
    openResults: () => (state.open.results || []).map((r, i) => serializeOpenRow(r, i)),
    openTopByDistrict: (n) => {
      n = n || 3;
      const radius = state.open.radius;
      const byD = {};
      for (const r of state.open.scored || []) {
        if (r.score == null) continue;
        const list = byD[r.district] || (byD[r.district] = []);
        if (list.length >= n) continue;
        if (list.every((p) => distM(p.lat, p.lng, r.lat, r.lng) >= radius)) {
          list.push(serializeOpenRow(r, list.length));
        }
      }
      return byD;
    },
    openRunInfo: () => ({
      ran: state.open.ran,
      radius: state.open.radius,
      county: state.open.scopeCounty,
      district: state.open.scopeDistrict,
      scored: (state.open.scored || []).length,
      weights: { demand: state.open.wDemand, comp: state.open.wComp, inc: state.open.wInc },
      minPop: state.open.minPop,
    }),
    predictResults: () => state.predict.results.map((c, i) => {
      const rec = c.byR[state.predict.radius];
      return {
        rank: i + 1,
        county: c.county,
        district: c.district,
        village: c.village,
        lat: c.lat,
        lng: c.lng,
        pop: rec.pop,
        hh: rec.hh,
        share65: rec.share[4],
        share2544: rec.share[2],
        cvs: rec.cvs,
        perCvs: rec.perCvs,
        resto: rec.resto,
        mk: rec.mk,
        perMkt: rec.perMkt,
        nearMkt: rec.nearMkt,
        incMed: rec.incMed,
        incAvg: rec.incAvg,
        metric: state.predict.metric,
        value: predictValue(c, state.predict.radius, state.predict.metric),
      };
    }),
  };

  main().catch((err) => {
    console.error(err);
    $("panelEmpty").textContent = "載入失敗：" + err.message;
  });
})();
