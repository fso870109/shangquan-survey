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

  const state = {
    meta: null,
    search: null,
    countyId: "taoyuan",
    data: null,
    cache: {},
    mode: "circle",
    center: { lat: 24.953317, lng: 121.22616 },
    radius: 500,
    placeName: "中壢車站",
    stats: null,
    tab: "age",
    compare: [],
    indicator: "density",
    selectedDistrict: null,
    brandFilter: "all",
    showRestaurants: false,
    restaurants: [],
  };

  let map, circleLayer, villageLayer, districtLayer, storeLayer, restoLayer, compareLayer;
  let centerMarker;
  let searchTimer = null;

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

  async function loadJSON(path) {
    const res = await fetch(path);
    if (!res.ok) throw new Error("無法載入 " + path);
    return res.json();
  }

  async function loadCounty(id, opts = {}) {
    if (state.cache[id]) {
      state.data = state.cache[id];
      state.countyId = id;
    } else {
      $("panelEmpty").hidden = false;
      $("panelEmpty").textContent = "正在載入" + countyName(id) + "資料…";
      $("panelBody").hidden = true;
      const data = await loadJSON("data/" + id + ".json");
      state.cache[id] = data;
      state.data = data;
      state.countyId = id;
    }
    $("countySelect").value = id;
    if (opts.fit !== false && state.mode === "admin") {
      map.fitBounds([[state.data.bbox[1], state.data.bbox[0]], [state.data.bbox[3], state.data.bbox[2]]], { padding: [20, 20] });
    }
  }

  function countyName(id) {
    const c = (state.meta?.counties || []).find((x) => x.id === id);
    return c ? c.name : id;
  }

  function findPlace(lat, lng) {
    const pt = turf.point([lng, lat]);
    let hit = null;
    for (const v of state.data.villages) {
      const b = v.bbox;
      if (lng < b[0] || lng > b[2] || lat < b[1] || lat > b[3]) continue;
      try {
        if (turf.booleanPointInPolygon(pt, turf.feature(v.g))) {
          hit = v;
          break;
        }
      } catch (e) { /* ignore */ }
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
    for (const v of state.data.villages) {
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
      feats.push(turf.feature(v.g, { name: v.name, district: v.district, ratio }));
    }
    hits.sort((a, b) => b.ratio - a.ratio);
    const density = areaKm2 ? pop / areaKm2 : 0;
    const avg = state.data.countyAvg;
    const chY1 = popY1 > 0 && popNowY1 / Math.max(pop, 1) >= 0.9 ? { abs: popNowY1 - popY1, pct: (100 * (popNowY1 - popY1)) / popY1 } : null;
    const chY5 = popY5 > 0 && popNowY5 / Math.max(pop, 1) >= 0.9 ? { abs: popNowY5 - popY5, pct: (100 * (popNowY5 - popY5)) / popY5 } : null;

    const storesIn = [];
    const nearest = { s711: null, fami: null, sbux: null, mcd: null };
    for (const s of state.data.stores) {
      const d = distM(lat, lng, s.lat, s.lng);
      const rec = { ...s, dist: d };
      if (!nearest[s.b] || d < nearest[s.b].dist) nearest[s.b] = rec;
      if (d <= radius) storesIn.push(rec);
    }
    storesIn.sort((a, b) => a.dist - b.dist);
    const count = { s711: 0, fami: 0, sbux: 0, mcd: 0 };
    storesIn.forEach((s) => { count[s.b] += 1; });
    const cvs = count.s711 + count.fami;
    const perCvs = cvs > 0 ? pop / cvs : null;

    const vill = findPlace(lat, lng);
    return {
      kind: "circle",
      lat, lng, radius, areaKm2, pop, hh, density,
      age, pm, pf,
      ageShare: shares(age, pop),
      chY1, chY5,
      hits, feats, storesIn, nearest, count, cvs, perCvs,
      vill,
      countyAvg: avg,
    };
  }

  function estimateDistrict(code) {
    const d = state.data.districts.find((x) => x.code === code);
    if (!d) return null;
    const count = { ...d.stores };
    const cvs = (count.s711 || 0) + (count.fami || 0);
    const storesIn = state.data.stores
      .filter((s) => s.d === d.name)
      .map((s) => ({ ...s, dist: distM(d.center[1], d.center[0], s.lat, s.lng) }))
      .sort((a, b) => a.dist - b.dist);
    const nearest = { s711: null, fami: null, sbux: null, mcd: null };
    for (const s of state.data.stores) {
      const dist = distM(d.center[1], d.center[0], s.lat, s.lng);
      if (!nearest[s.b] || dist < nearest[s.b].dist) nearest[s.b] = { ...s, dist };
    }
    const chY1 = d.popY1 ? { abs: d.pop - d.popY1, pct: (100 * (d.pop - d.popY1)) / d.popY1 } : null;
    const chY5 = d.popY5 ? { abs: d.pop - d.popY5, pct: (100 * (d.pop - d.popY5)) / d.popY5 } : null;
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
      hits: state.data.villages.filter((v) => v.dc === d.code).map((v) => ({ v, ratio: 1 })),
      feats: [],
      storesIn, nearest, count, cvs,
      perCvs: cvs > 0 ? d.pop / cvs : null,
      vill: null,
      countyAvg: state.data.countyAvg,
    };
  }

  function setCenter(lat, lng, name) {
    state.center = { lat, lng };
    state.selectedDistrict = null;
    centerMarker.setLatLng([lat, lng]);
    if (state.mode === "circle") {
      const vill = findPlace(lat, lng);
      state.placeName = name || (vill ? vill.district + vill.name : "地圖選點");
      state.stats = estimateCircle(lat, lng, state.radius);
      drawCircleMode();
      renderPanel();
      if (state.showRestaurants) loadRestaurants();
    }
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
    $("legend").hidden = true;
    drawCircleOnly(state.center.lat, state.center.lng, state.radius);
    villageLayer.clearLayers();
    if (state.stats?.feats?.length) villageLayer.addData({ type: "FeatureCollection", features: state.stats.feats });
    drawStores(state.stats?.storesIn || []);
    drawCompareMarkers();
    centerMarker.addTo(map);
    $("mapHint").hidden = false;
    $("radiusBar").hidden = false;
    $("adminBar").hidden = true;
    $("restoToggleWrap").hidden = false;
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

  function drawAdminMode() {
    circleLayer.clearLayers();
    villageLayer.clearLayers();
    storeLayer.clearLayers();
    restoLayer.clearLayers();
    if (map.hasLayer(centerMarker)) map.removeLayer(centerMarker);
    $("mapHint").hidden = true;
    $("radiusBar").hidden = true;
    $("adminBar").hidden = false;
    $("restoToggleWrap").hidden = true;
    const vals = state.data.districts.map(indicatorValue);
    const min = Math.min(...vals);
    const max = Math.max(...vals);
    districtLayer.clearLayers();
    districtLayer.options.style = (feat) => {
      const d = state.data.districts.find((x) => x.code === feat.properties.code);
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
      features: state.data.districts.map((d) => ({
        type: "Feature",
        properties: { code: d.code, name: d.name },
        geometry: d.geometry,
      })),
    };
    districtLayer.addData(fc);
    const legend = $("legend");
    const title = $("indicatorSelect").selectedOptions[0].textContent;
    const steps = 5;
    legend.innerHTML = `<div><strong>${title}</strong></div>` + Array.from({ length: steps }, (_, i) => {
      const a = min + ((max - min) * i) / steps;
      const b = min + ((max - min) * (i + 1)) / steps;
      const label = state.indicator === "cvs"
        ? `${Math.round(a)}–${Math.round(b)}`
        : state.indicator === "density"
          ? `${fmtInt(a)}–${fmtInt(b)}`
          : `${a.toFixed(1)}–${b.toFixed(1)}%`;
      return `<div class="row"><i style="background:${colorRamp((i + 0.5) / steps)}"></i>${label}</div>`;
    }).join("");
    legend.hidden = false;
    renderDistrictButtons();
    drawCompareMarkers();
    if (state.stats?.kind === "district" && state.stats.storesIn) {
      drawStores(state.stats.storesIn);
    }
  }

  function renderDistrictButtons() {
    const box = $("districtBtns");
    box.innerHTML = "";
    [...state.data.districts].sort((a, b) => a.name.localeCompare(b.name, "zh-Hant")).forEach((d) => {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "district-btn" + (state.selectedDistrict === d.code ? " active" : "");
      btn.textContent = d.name;
      btn.addEventListener("click", () => selectDistrict(d.code));
      box.appendChild(btn);
    });
  }

  function selectDistrict(code) {
    state.selectedDistrict = code;
    state.stats = estimateDistrict(code);
    const d = state.stats?.district;
    state.placeName = d ? d.name : "";
    if (d) {
      map.fitBounds([[d.bbox[1], d.bbox[0]], [d.bbox[3], d.bbox[2]]], { padding: [30, 30], maxZoom: 14 });
    }
    drawAdminMode();
    renderPanel();
  }

  function renderPanel() {
    const s = state.stats;
    if (!s) return;
    $("panelEmpty").hidden = true;
    $("panelBody").hidden = false;
    const avg = s.countyAvg;
    const county = state.data.name;
    if (s.kind === "circle") {
      $("placeKicker").textContent = "步行圈中心";
      const vill = s.vill;
      $("placeTitle").textContent = state.placeName;
      $("placeSub").textContent = vill
        ? `${county}　${vill.district}　${vill.name}`
        : `${county}　半徑 ${s.radius} 公尺（${RADIUS_WALK[s.radius] || ""}）`;
      $("villListWrap").hidden = false;
      $("villCount").textContent = `（${s.hits.length} 里）`;
      $("villList").innerHTML = s.hits.map((h) =>
        `<li><span>${h.v.district}${h.v.name}</span><span>覆蓋 ${(h.ratio * 100).toFixed(0)}%</span></li>`
      ).join("");
    } else {
      $("placeKicker").textContent = "行政區";
      $("placeTitle").textContent = s.district.name;
      $("placeSub").textContent = `${county}　全區統計（非步行圈估算）`;
      $("villListWrap").hidden = false;
      $("villCount").textContent = `（${s.hits.length} 里）`;
      $("villList").innerHTML = s.hits
        .sort((a, b) => b.v.pop - a.v.pop)
        .map((h) => `<li><span>${h.v.name}</span><span>${fmtInt(h.v.pop)} 人</span></li>`)
        .join("");
    }

    const densRatio = avg.density ? s.density / avg.density : null;
    let densNote = "";
    if (densRatio != null) {
      densNote = densRatio >= 1
        ? `約為${county}平均（${fmt1(avg.density)} 人/km²）的 ${fmt1(densRatio)} 倍`
        : `約為${county}平均（${fmt1(avg.density)} 人/km²）的 ${fmt1(densRatio)} 倍`;
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
    const avgShare = s.countyAvg.ageShare;
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
    const maxShare = Math.max(
      ...s.pm.map((x) => x / Math.max(s.pop, 1)),
      ...s.pf.map((x) => x / Math.max(s.pop, 1)),
      ...s.countyAvg.pm.map((x) => x / Math.max(s.countyAvg.pop, 1)),
      ...s.countyAvg.pf.map((x) => x / Math.max(s.countyAvg.pop, 1)),
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
      const cm = s.countyAvg.pm[i] / Math.max(s.countyAvg.pop, 1);
      const cf = s.countyAvg.pf[i] / Math.max(s.countyAvg.pop, 1);
      const mw = bar(m), fw = bar(f), cmw = bar(cm), cfw = bar(cf);
      return `
        <rect x="${mid - gap - mw}" y="${y}" width="${mw}" height="12" fill="#1d4e89"/>
        <rect x="${mid + gap}" y="${y}" width="${fw}" height="12" fill="#c43d66"/>
        <rect x="${mid - gap - cmw}" y="${y - 1}" width="${cmw}" height="14" fill="none" stroke="#1f1915" stroke-dasharray="3 2" stroke-width="1" opacity="0.7"/>
        <rect x="${mid + gap}" y="${y - 1}" width="${cfw}" height="14" fill="none" stroke="#1f1915" stroke-dasharray="3 2" stroke-width="1" opacity="0.7"/>
        <text x="${mid}" y="${y + 10}" text-anchor="middle" font-size="9" fill="#6d645c">${lab}</text>`;
    }).join("");
    $("ageSection").innerHTML = `
      <p class="src-note">色塊為本地點占比；黑色短線／虛線為${state.data.name}平均。</p>
      ${rows}
      <p class="pyramid-caption">人口金字塔（占總人口比；左男右女；虛線為縣市平均）</p>
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
      : `${state.data.name}${s.district.name}`;
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
        renderPanel();
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
          out.push({ kind, item, local: item.cid === state.countyId });
          if (out.length >= 20) break;
        }
      }
      if (out.length >= 20) break;
    }
    out.sort((a, b) => Number(b.local) - Number(a.local));
    if (!out.length) {
      box.innerHTML = "<li>沒有符合的結果</li>";
      box.hidden = false;
      return;
    }
    box.innerHTML = out.map((r, i) => {
      const it = r.item;
      const extra = [it.county, it.district, r.kind].filter(Boolean).join("　");
      return `<li data-i="${i}"><div>${it.name}${it.brand ? "　" + (BRANDS[it.brand]?.short || "") : ""}</div><div class="meta">${extra}</div></li>`;
    }).join("");
    box.hidden = false;
    box.querySelectorAll("li[data-i]").forEach((li) => {
      li.addEventListener("click", async () => {
        const r = out[Number(li.dataset.i)];
        box.hidden = true;
        $("searchInput").value = r.item.name;
        await pickSearch(r);
      });
    });
  }

  async function pickSearch(r) {
    const it = r.item;
    if (it.cid && it.cid !== state.countyId) {
      await loadCounty(it.cid, { fit: false });
    }
    if (state.mode === "admin" && r.kind === "行政區") {
      const d = state.data.districts.find((x) => x.name === it.name);
      if (d) selectDistrict(d.code);
      return;
    }
    if (state.mode === "admin") {
      state.mode = "circle";
      syncModeButtons();
    }
    map.setView([it.lat, it.lng], 16);
    setCenter(it.lat, it.lng, it.name);
  }

  function syncModeButtons() {
    $("btnModeCircle").classList.toggle("active", state.mode === "circle");
    $("btnModeAdmin").classList.toggle("active", state.mode === "admin");
  }

  async function setMode(mode) {
    state.mode = mode;
    syncModeButtons();
    if (mode === "admin") {
      if (!state.selectedDistrict) {
        const here = findPlace(state.center.lat, state.center.lng);
        const first = here
          ? state.data.districts.find((d) => d.name === here.district)
          : state.data.districts[0];
        if (first) state.selectedDistrict = first.code;
      }
      state.stats = estimateDistrict(state.selectedDistrict);
      state.placeName = state.stats?.district?.name || "";
      drawAdminMode();
      map.fitBounds([[state.data.bbox[1], state.data.bbox[0]], [state.data.bbox[3], state.data.bbox[2]]], { padding: [20, 20] });
      renderPanel();
    } else {
      districtLayer.clearLayers();
      map.setView([state.center.lat, state.center.lng], 15);
      setCenter(state.center.lat, state.center.lng, state.placeName);
    }
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
    $("footer").innerHTML = src.map((s) => {
      const dates = (s.dates || [s.date]).filter(Boolean).join("、");
      return `<div><strong>${s.name}</strong>　${s.org || ""}${dates ? "　" + dates : ""}${s.note ? "　" + s.note : ""}</div>`;
    }).join("") +
      `<div>${state.meta.method || ""}</div>
       <div>人口為戶籍登記數，非常住／實際居住人口。步行圈以村里多邊形與圓相交的面積比例估算，假設人口在村里內均勻分布。</div>`;
  }

  function bindUI() {
    $("btnModeCircle").addEventListener("click", () => setMode("circle"));
    $("btnModeAdmin").addEventListener("click", () => setMode("admin"));
    $("countySelect").addEventListener("change", async (e) => {
      const id = e.target.value;
      await loadCounty(id, { fit: true });
      if (state.mode === "admin") {
        state.selectedDistrict = state.data.districts[0]?.code || null;
        await setMode("admin");
      } else {
        const c = state.data.center;
        map.setView([c[1], c[0]], state.data.zoom || 12);
        setCenter(c[1], c[0], state.data.name + "中心");
      }
    });
    document.querySelectorAll("#radiusBar button").forEach((b) => {
      b.addEventListener("click", () => setRadius(Number(b.dataset.r)));
    });
    $("indicatorSelect").addEventListener("change", (e) => {
      state.indicator = e.target.value;
      if (state.mode === "admin") drawAdminMode();
    });
    $("searchInput").addEventListener("input", (e) => {
      clearTimeout(searchTimer);
      searchTimer = setTimeout(() => doSearch(e.target.value), 160);
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
      renderPanel();
    });
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
    const sel = $("countySelect");
    sel.innerHTML = state.meta.counties.map((c) => `<option value="${c.id}">${c.name}</option>`).join("");
    const dc = state.meta.defaultCenter || {};
    if (dc.lat) {
      state.center = { lat: dc.lat, lng: dc.lng };
      state.placeName = dc.name || "中壢車站";
      state.countyId = dc.cid || "taoyuan";
    }
    renderFooter();
    await loadCounty(state.countyId, { fit: false });
    map.setView([state.center.lat, state.center.lng], 16);
    setCenter(state.center.lat, state.center.lng, state.placeName);
    try {
      state.search = await loadJSON("data/search.json");
    } catch (e) {
      state.search = { villages: [], districts: [], stores: [], landmarks: [] };
    }
  }

  main().catch((err) => {
    console.error(err);
    $("panelEmpty").textContent = "載入失敗：" + err.message;
  });
})();
