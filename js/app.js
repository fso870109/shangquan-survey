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
    pop: { label: "人口", kind: "int" },
    y1: { label: "近1年人口成長率", kind: "pctSigned" },
    y5: { label: "近5年人口成長率", kind: "pctSigned" },
    perCvs: { label: "每家超商服務人數", kind: "int" },
    resto: { label: "OSM 餐廳數", kind: "int" },
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
    gridCache: {},
    predict: {
      metric: "age65",
      desc: true,
      minPop: 3000,
      maxPop: null,
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

  let map, circleLayer, villageLayer, districtLayer, storeLayer, restoLayer, compareLayer, predictLayer, heatLayer;
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
    d.open = !window.matchMedia("(max-width: 768px)").matches;
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

    return {
      kind: "circle",
      lat, lng, radius, areaKm2, pop, hh, density,
      age, pm, pf,
      ageShare: shares(age, pop),
      chY1, chY5,
      hits, feats, storesIn, nearest, count, cvs, perCvs,
      vill,
      homeCountyId: homeId,
      homeCountyName: home ? home.name : countyName(homeId),
      countyAvg: avg,
    };
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
    return {
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
      vill: null,
      homeCountyId: d.cid,
      homeCountyName: d.county || countyName(d.cid),
      countyAvg: avg,
    };
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
    await ensureCountiesForCircle(lat, lng, state.radius);
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
    heatLayer.clearLayers();
    predictLayer.clearLayers();
    if (map.hasLayer(centerMarker)) map.removeLayer(centerMarker);
    syncOverlay();
    const districts = visibleDistricts();
    const vals = districts.map(indicatorValue);
    const min = vals.length ? Math.min(...vals) : 0;
    const max = vals.length ? Math.max(...vals) : 1;
    districtLayer.clearLayers();
    districtLayer.options.style = (feat) => {
      const d = districts.find((x) => x.code === feat.properties.code);
      const v = d ? indicatorValue(d) : min;
      const t = max === min ? 0.5 : (v - min) / (max - min);
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
    renderMetricLegend($("indicatorSelect").selectedOptions[0].textContent, min, max, state.indicator);
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
      if (kind === "cvs" || kind === "int" || kind === "resto") label = `${Math.round(a)}–${Math.round(b)}`;
      else if (kind === "density") label = `${fmtInt(a)}–${fmtInt(b)}`;
      else if (kind === "pctSigned") label = `${fmtPct(a)}–${fmtPct(b)}`;
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
    const predict = state.mode === "predict";
    $("predictBody").hidden = !predict;
    if (predict) {
      $("panelEmpty").hidden = true;
      $("panelBody").hidden = true;
    }
  }

  function syncModeButtons() {
    $("btnModeCircle").classList.toggle("active", state.mode === "circle");
    $("btnModeAdmin").classList.toggle("active", state.mode === "admin");
    $("btnModePredict").classList.toggle("active", state.mode === "predict");
  }

  function syncOverlay() {
    $("radiusBar").hidden = state.mode !== "circle";
    $("adminBar").hidden = state.mode !== "admin";
    $("restoToggleWrap").hidden = state.mode !== "circle";
    if (state.mode === "admin") {
      $("mapHint").hidden = true;
    } else if (state.mode === "predict") {
      $("mapHint").hidden = false;
      $("mapHint").textContent = "調整條件後按開始篩選；點結果可查看該點步行圈";
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
        return `<li><span>${label}</span><span>覆蓋 ${(h.ratio * 100).toFixed(0)}%</span></li>`;
      }).join("");
    } else {
      $("placeKicker").textContent = "行政區";
      $("placeTitle").textContent = s.district.name;
      $("placeSub").textContent = `${s.district.county || county}　全區統計（非步行圈估算）`;
      $("villListWrap").hidden = false;
      $("villCount").textContent = `（${s.hits.length} 里）`;
      $("villList").innerHTML = s.hits
        .sort((a, b) => b.v.pop - a.v.pop)
        .map((h) => `<li><span>${h.v.name}</span><span>${fmtInt(h.v.pop)} 人</span></li>`)
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
    ].join("");

    $("btnCompare").disabled = state.compare.length >= 6;
    $("compareHint").textContent = state.compare.length >= 6 ? "最多比較 6 個地點" : `已加入 ${state.compare.length} / 6`;

    renderAge(s);
    renderBrands(s);
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
      await ensureDistricts();
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
    } else if (mode === "predict") {
      districtLayer.clearLayers();
      circleLayer.clearLayers();
      villageLayer.clearLayers();
      storeLayer.clearLayers();
      restoLayer.clearLayers();
      if (map.hasLayer(centerMarker)) map.removeLayer(centerMarker);
      syncOverlay();
      if (state.predict.ran) {
        drawPredictLayers();
        renderPredictList();
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
    return null;
  }

  function fmtPredictValue(metric, v) {
    if (v == null) return "—";
    const kind = PREDICT_METRICS[metric]?.kind;
    if (kind === "pct") return v.toFixed(1) + "%";
    if (kind === "pctSigned") return fmtPct(v);
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
      const parts = await Promise.all(ids.map(ensureGrid));
      cells = parts.flat();
    } catch (err) {
      status.textContent = "載入失敗：" + err.message;
      return;
    }
    const radius = state.predict.radius;
    const metric = state.predict.metric;
    const list = [];
    for (const c of cells) {
      if (state.predict.scopeDistrict && c.district !== state.predict.scopeDistrict) continue;
      const rec = c.byR[radius];
      if (!rec) continue;
      if (rec.pop < state.predict.minPop) continue;
      if (state.predict.maxPop != null && rec.pop > state.predict.maxPop) continue;
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
    status.textContent = `在 ${scopeLabel}、${radius}m、人口 ≥ ${fmtInt(state.predict.minPop)} 的格子中，依「${PREDICT_METRICS[metric].label}」列出前 ${picked.length} 名（已去除過近的點）。數字皆為戶籍人口估算。`;
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

  function renderFooter() {
    const src = state.meta.sources || [];
    const body = src.map((s) => {
      const dates = (s.dates || [s.date]).filter(Boolean).join("、");
      return `<div><strong>${s.name}</strong>　${s.org || ""}${dates ? "　" + dates : ""}${s.note ? "　" + s.note : ""}</div>`;
    }).join("") +
      `<div>${state.meta.method || ""}</div>
       <div>人口為戶籍登記數，非常住／實際居住人口。步行圈以村里多邊形與圓相交的面積比例估算，假設人口在村里內均勻分布。</div>
       <div>點位預判器的 OSM 餐廳數來自 OpenStreetMap 的 amenity=restaurant 節點，僅供參考。</div>`;
    $("footer").innerHTML = `<details class="sources" id="sourceDetails"><summary>資料來源</summary><div class="source-body">${body}</div></details>`;
    syncSourceDetails();
  }

  function bindUI() {
    $("btnModeCircle").addEventListener("click", () => setMode("circle"));
    $("btnModeAdmin").addEventListener("click", () => setMode("admin"));
    $("btnModePredict").addEventListener("click", () => setMode("predict"));
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
      if (state.mode !== "predict" && state.stats) renderPanel();
    });
    $("predictForm").addEventListener("submit", runPredict);
    $("predictCounty").addEventListener("change", fillPredictDistricts);
    $("predictHeat").addEventListener("change", () => {
      state.predict.showHeat = $("predictHeat").checked;
      if (state.predict.ran && state.mode === "predict") drawPredictLayers();
    });
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
    await ensureCounty(state.homeCountyId);
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
      };
    },
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
