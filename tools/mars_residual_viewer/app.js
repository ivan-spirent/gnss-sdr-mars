const MARS_MU = 4.282837e13;
const MARS_ROTATION_RATE = 7.088218e-5;
const MARS_A = 3396190.0;
const MARS_B = 3376200.0;
const MARS_F = (MARS_A - MARS_B) / MARS_A;
const DEG_TO_RAD = Math.PI / 180;
const TRUTH = { lat: 0, lon: 0, height: 0 };

const SOURCES = {
  satData: "/Mars%20Molli%2032%205%20min/5%20minutes%20IQ%2032%20SV%20Molli_scenario_data/sat_data_V1A1.csv",
  ephemeris: "/gps_mars_molli_32_5min_nav_ephemeris.xml",
  corrections: "/gps_mars_molli_32_5min_ephemeris_corrections_true_dynamic.csv",
  nmea: "/build/gnss_sdr_molli_true_dynamic_pvt.nmea"
};

const COLORS = [
  "#2f6db5", "#c2472b", "#258552", "#b46c11", "#156c7b",
  "#8f3f5d", "#6f7f87", "#9a6a23", "#4e7d4a", "#7d5da6"
];

const els = {
  statusLine: document.getElementById("statusLine"),
  reloadButton: document.getElementById("reloadButton"),
  toggleUsedOnly: document.getElementById("toggleUsedOnly"),
  residualRms: document.getElementById("residualRms"),
  residualNote: document.getElementById("residualNote"),
  eastDrift: document.getElementById("eastDrift"),
  eastNote: document.getElementById("eastNote"),
  worstTrend: document.getElementById("worstTrend"),
  worstTrendNote: document.getElementById("worstTrendNote"),
  selectedMetric: document.getElementById("selectedMetric"),
  selectedMetricNote: document.getElementById("selectedMetricNote"),
  residualCanvas: document.getElementById("residualCanvas"),
  residualLegend: document.getElementById("residualLegend"),
  eastCanvas: document.getElementById("eastCanvas"),
  selectedCanvas: document.getElementById("selectedCanvas"),
  selectedPrnLabel: document.getElementById("selectedPrnLabel"),
  rankingRows: document.getElementById("rankingRows")
};

const state = {
  residualsByPrn: new Map(),
  residuals: [],
  pvt: [],
  ranking: [],
  selectedPrn: null,
  usedOnly: true,
  colors: new Map()
};

function parseNumber(value, fallback = NaN) {
  const out = Number(value);
  return Number.isFinite(out) ? out : fallback;
}

function formatMeters(value) {
  if (!Number.isFinite(value)) return "-";
  const absValue = Math.abs(value);
  if (absValue >= 1000) return `${(value / 1000).toFixed(2)} km`;
  if (absValue >= 100) return `${value.toFixed(0)} m`;
  if (absValue >= 10) return `${value.toFixed(1)} m`;
  return `${value.toFixed(2)} m`;
}

function formatSlope(value) {
  if (!Number.isFinite(value)) return "-";
  return `${value.toFixed(2)} m/min`;
}

function formatCorr(value) {
  if (!Number.isFinite(value)) return "-";
  return value.toFixed(2);
}

function timeOfDaySeconds(timeS) {
  const day = 86400;
  return ((timeS % day) + day) % day;
}

function formatTime(seconds) {
  if (!Number.isFinite(seconds)) return "-";
  const daySeconds = ((seconds % 86400) + 86400) % 86400;
  const hh = Math.floor(daySeconds / 3600);
  const mm = Math.floor((daySeconds % 3600) / 60);
  const ss = daySeconds % 60;
  return `${String(hh).padStart(2, "0")}:${String(mm).padStart(2, "0")}:${ss.toFixed(ss % 1 ? 1 : 0).padStart(2, "0")}`;
}

async function fetchText(url) {
  const response = await fetch(`${url}?t=${Date.now()}`);
  if (!response.ok) {
    throw new Error(`${url} returned HTTP ${response.status}`);
  }
  return response.text();
}

function csvSplit(line) {
  const values = [];
  let current = "";
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const char = line[i];
    if (char === "\"") {
      quoted = !quoted;
    } else if (char === "," && !quoted) {
      values.push(current);
      current = "";
    } else {
      current += char;
    }
  }
  values.push(current);
  return values;
}

function parseSatData(text) {
  const lines = text.split(/\r?\n/).filter((line) => line.trim());
  const headerIndex = lines.findIndex((line) => line.startsWith("TOW_ms,"));
  if (headerIndex < 0) return [];
  const headers = csvSplit(lines[headerIndex]);
  const rows = [];
  for (const line of lines.slice(headerIndex + 1)) {
    const values = csvSplit(line);
    if (values.length < headers.length) continue;
    const row = {};
    headers.forEach((header, index) => {
      row[header] = values[index];
    });
    const prn = parseNumber(row.Sat_PRN);
    const towMs = parseNumber(row.TOW_ms);
    const signalDb = parseNumber(row["Signal_dB Group A"], 0);
    const rangeM = parseNumber(row.Range);
    if (!Number.isFinite(prn) || !Number.isFinite(towMs) || !Number.isFinite(rangeM) || signalDb <= 0) {
      continue;
    }
    rows.push({ prn, towMs, rangeM, signalDb });
  }
  return rows;
}

function parseEphemerisXml(text) {
  const doc = new DOMParser().parseFromString(text, "application/xml");
  const parserError = doc.querySelector("parsererror");
  if (parserError) throw new Error("Ephemeris XML parse failed");
  const ephemerides = new Map();
  for (const item of doc.querySelectorAll("GNSS-SDR_ephemeris_map > item")) {
    const first = item.querySelector("first");
    const second = item.querySelector("second");
    if (!first || !second) continue;
    const prn = parseNumber(first.textContent);
    if (!Number.isFinite(prn)) continue;
    const eph = {};
    for (const child of second.children) {
      eph[child.tagName] = parseNumber(child.textContent);
    }
    eph.PRN = prn;
    ephemerides.set(prn, eph);
  }
  return ephemerides;
}

function parseCorrections(text) {
  const corrections = new Map();
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.split("#", 1)[0].trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const values = trimmed.split(",").map((value) => value.trim());
    const prn = parseNumber(values[0]);
    if (!Number.isFinite(prn)) continue;
    if (values.length >= 12) {
      corrections.set(prn, {
        referenceTowS: parseNumber(values[1], 0),
        deltaM0: parseNumber(values[2], 0),
        deltaOmega0: parseNumber(values[3], 0),
        deltaI0: parseNumber(values[4], 0),
        deltaOmega: parseNumber(values[5], 0),
        deltaSqrtA: parseNumber(values[6], 0),
        deltaM0Rate: parseNumber(values[7], 0),
        deltaOmega0Rate: parseNumber(values[8], 0),
        deltaI0Rate: parseNumber(values[9], 0),
        deltaOmegaRate: parseNumber(values[10], 0),
        deltaSqrtARate: parseNumber(values[11], 0)
      });
    } else if (values.length >= 6) {
      corrections.set(prn, {
        deltaM0: parseNumber(values[1], 0),
        deltaOmega0: parseNumber(values[2], 0),
        deltaI0: parseNumber(values[3], 0),
        deltaOmega: parseNumber(values[4], 0),
        deltaSqrtA: parseNumber(values[5], 0)
      });
    }
  }
  return corrections;
}

function correctedEphemeris(eph, correction = {}, timeS = NaN) {
  const referenceTowS = Number.isFinite(correction.referenceTowS) ? correction.referenceTowS : timeS;
  const dt = Number.isFinite(timeS) && Number.isFinite(referenceTowS) ? timeS - referenceTowS : 0;
  return {
    ...eph,
    M_0: eph.M_0 + (correction.deltaM0 || 0) + (correction.deltaM0Rate || 0) * dt,
    OMEGA_0: eph.OMEGA_0 + (correction.deltaOmega0 || 0) + (correction.deltaOmega0Rate || 0) * dt,
    i_0: eph.i_0 + (correction.deltaI0 || 0) + (correction.deltaI0Rate || 0) * dt,
    omega: eph.omega + (correction.deltaOmega || 0) + (correction.deltaOmegaRate || 0) * dt,
    sqrtA: eph.sqrtA + (correction.deltaSqrtA || 0) + (correction.deltaSqrtARate || 0) * dt
  };
}

function normalizeAngle(angle) {
  return ((angle + Math.PI) % (2 * Math.PI)) - Math.PI;
}

function timediffWeekCrossover(timeS, toeS) {
  let dt = timeS - toeS;
  if (dt > 302400) dt -= 604800;
  if (dt < -302400) dt += 604800;
  return dt;
}

function satellitePosition(eph, timeS) {
  const semiMajorAxis = eph.sqrtA * eph.sqrtA;
  const meanMotion = Math.sqrt(MARS_MU / (semiMajorAxis ** 3)) + eph.delta_n;
  const tk = timediffWeekCrossover(timeS, eph.toe);
  const meanAnomaly = normalizeAngle(eph.M_0 + meanMotion * tk);
  const ecc = eph.ecc;
  let eccentricAnomaly = meanAnomaly;
  for (let i = 0; i < 30; i++) {
    const delta = (eccentricAnomaly - ecc * Math.sin(eccentricAnomaly) - meanAnomaly) /
      (1 - ecc * Math.cos(eccentricAnomaly));
    eccentricAnomaly -= delta;
    if (Math.abs(delta) < 1e-13) break;
  }

  const sinE = Math.sin(eccentricAnomaly);
  const cosE = Math.cos(eccentricAnomaly);
  let argumentLat = Math.atan2(Math.sqrt(1 - ecc * ecc) * sinE, cosE - ecc) + eph.omega;
  let radius = semiMajorAxis * (1 - ecc * cosE);
  let inclination = eph.i_0 + eph.idot * tk;

  const sin2u = Math.sin(2 * argumentLat);
  const cos2u = Math.cos(2 * argumentLat);
  argumentLat += (eph.Cus || 0) * sin2u + (eph.Cuc || 0) * cos2u;
  radius += (eph.Crs || 0) * sin2u + (eph.Crc || 0) * cos2u;
  inclination += (eph.Cis || 0) * sin2u + (eph.Cic || 0) * cos2u;

  const xOrb = radius * Math.cos(argumentLat);
  const yOrb = radius * Math.sin(argumentLat);
  const node = eph.OMEGA_0 + (eph.OMEGAdot - MARS_ROTATION_RATE) * tk - MARS_ROTATION_RATE * eph.toe;
  const cosNode = Math.cos(node);
  const sinNode = Math.sin(node);
  const cosI = Math.cos(inclination);
  return {
    x: xOrb * cosNode - yOrb * cosI * sinNode,
    y: xOrb * sinNode + yOrb * cosI * cosNode,
    z: yOrb * Math.sin(inclination)
  };
}

function marsGeodeticToEcef(latDeg, lonDeg, heightM) {
  const lat = latDeg * DEG_TO_RAD;
  const lon = lonDeg * DEG_TO_RAD;
  const e2 = MARS_F * (2 - MARS_F);
  const sinLat = Math.sin(lat);
  const cosLat = Math.cos(lat);
  const primeVertical = MARS_A / Math.sqrt(1 - e2 * sinLat * sinLat);
  return {
    x: (primeVertical + heightM) * cosLat * Math.cos(lon),
    y: (primeVertical + heightM) * cosLat * Math.sin(lon),
    z: (primeVertical * (1 - e2) + heightM) * sinLat
  };
}

function geometricRange(a, b) {
  return Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
}

function computeResiduals(satRows, ephemerides, corrections) {
  const receiver = marsGeodeticToEcef(TRUTH.lat, TRUTH.lon, TRUTH.height);
  const byPrn = new Map();
  const all = [];
  for (const row of satRows) {
    const eph = ephemerides.get(row.prn);
    if (!eph) continue;
    const timeS = row.towMs / 1000;
    const sat = satellitePosition(correctedEphemeris(eph, corrections.get(row.prn), timeS), timeS);
    const residual = geometricRange(sat, receiver) - row.rangeM;
    const sample = {
      prn: row.prn,
      x: timeOfDaySeconds(timeS),
      towMs: row.towMs,
      residual,
      signalDb: row.signalDb
    };
    if (!byPrn.has(row.prn)) byPrn.set(row.prn, []);
    byPrn.get(row.prn).push(sample);
    all.push(sample);
  }
  for (const samples of byPrn.values()) samples.sort((a, b) => a.x - b.x);
  return { byPrn, all };
}

function nmeaCoord(value, hemi) {
  if (!value) return NaN;
  const numeric = Number(value);
  const degrees = Math.floor(numeric / 100);
  const minutes = numeric - degrees * 100;
  const out = degrees + minutes / 60;
  return hemi === "S" || hemi === "W" ? -out : out;
}

function nmeaTimeSeconds(value) {
  if (!value || value.length < 6) return NaN;
  return Number(value.slice(0, 2)) * 3600 + Number(value.slice(2, 4)) * 60 + Number(value.slice(4));
}

function parseNmea(text) {
  const points = [];
  let lastPoint = null;
  for (const line of text.split(/\r?\n/)) {
    if (!line.startsWith("$")) continue;
    const fields = line.split("*", 1)[0].split(",");
    const type = line.slice(3, 6);
    if (type === "GGA") {
      const fixQuality = Number(fields[6] || 0);
      if (fixQuality <= 0) continue;
      const lat = nmeaCoord(fields[2], fields[3]);
      const lon = nmeaCoord(fields[4], fields[5]);
      const height = Number(fields[9] || 0);
      const time = nmeaTimeSeconds(fields[1]);
      const east = (lon - TRUTH.lon) * DEG_TO_RAD * MARS_A * Math.cos(TRUTH.lat * DEG_TO_RAD);
      const north = (lat - TRUTH.lat) * DEG_TO_RAD * MARS_A;
      lastPoint = {
        x: time,
        time,
        lat,
        lon,
        height,
        east,
        north,
        horizontal: Math.hypot(east, north),
        nsats: Number(fields[7] || 0),
        used: new Set()
      };
      points.push(lastPoint);
    } else if (type === "GSA" && lastPoint) {
      lastPoint.used = new Set(fields.slice(3, 15).filter(Boolean).map(Number));
    }
  }
  return points.filter((point) => Number.isFinite(point.x) && Number.isFinite(point.east));
}

function rms(values) {
  if (!values.length) return NaN;
  return Math.sqrt(values.reduce((sum, value) => sum + value * value, 0) / values.length);
}

function linearSlopePerMinute(samples, key = "residual") {
  if (samples.length < 2) return NaN;
  const meanX = samples.reduce((sum, sample) => sum + sample.x, 0) / samples.length;
  const meanY = samples.reduce((sum, sample) => sum + sample[key], 0) / samples.length;
  let numerator = 0;
  let denominator = 0;
  for (const sample of samples) {
    const dx = sample.x - meanX;
    numerator += dx * (sample[key] - meanY);
    denominator += dx * dx;
  }
  return denominator > 0 ? (numerator / denominator) * 60 : NaN;
}

function correlation(pairs) {
  if (pairs.length < 3) return NaN;
  const meanA = pairs.reduce((sum, pair) => sum + pair[0], 0) / pairs.length;
  const meanB = pairs.reduce((sum, pair) => sum + pair[1], 0) / pairs.length;
  let numerator = 0;
  let denA = 0;
  let denB = 0;
  for (const [a, b] of pairs) {
    const da = a - meanA;
    const db = b - meanB;
    numerator += da * db;
    denA += da * da;
    denB += db * db;
  }
  return denA > 0 && denB > 0 ? numerator / Math.sqrt(denA * denB) : NaN;
}

function nearestPvtSample(x) {
  const points = state.pvt;
  if (!points.length) return null;
  let low = 0;
  let high = points.length - 1;
  while (low < high) {
    const mid = Math.floor((low + high) / 2);
    if (points[mid].x < x) low = mid + 1;
    else high = mid;
  }
  const candidates = [points[low], points[low - 1]].filter(Boolean);
  const nearest = candidates.reduce((best, item) => {
    if (!best) return item;
    return Math.abs(item.x - x) < Math.abs(best.x - x) ? item : best;
  }, null);
  return nearest && Math.abs(nearest.x - x) <= 0.75 ? nearest : null;
}

function computeRanking() {
  const pvt = state.pvt;
  const lastTime = Math.max(...pvt.map((point) => point.x));
  const lateStart = Number.isFinite(lastTime) ? lastTime - 90 : -Infinity;
  const ranking = [];
  for (const [prn, samples] of state.residualsByPrn.entries()) {
    const late = samples.filter((sample) => sample.x >= lateStart);
    const usedPairs = [];
    let usedCount = 0;
    for (const sample of late) {
      const pvtSample = nearestPvtSample(sample.x);
      if (pvtSample && pvtSample.used.has(prn)) {
        usedCount++;
        usedPairs.push([sample.residual, pvtSample.east]);
      }
    }
    const lateResiduals = late.map((sample) => sample.residual);
    const corr = correlation(usedPairs);
    const slope = linearSlopePerMinute(late);
    ranking.push({
      prn,
      slope,
      lateRms: rms(lateResiduals),
      lateMean: lateResiduals.length ? lateResiduals.reduce((sum, value) => sum + value, 0) / lateResiduals.length : NaN,
      corr,
      usedCount,
      score: Math.abs(slope || 0) * (Number.isFinite(corr) ? Math.abs(corr) + 0.25 : 0.25) * Math.log2(usedCount + 2)
    });
  }
  ranking.sort((a, b) => b.score - a.score);
  state.ranking = ranking;
  if (!state.selectedPrn && ranking.length) state.selectedPrn = ranking[0].prn;
}

function setCanvasSize(canvas) {
  const rect = canvas.getBoundingClientRect();
  const dpr = window.devicePixelRatio || 1;
  const width = Math.max(320, Math.floor(rect.width));
  const height = Math.max(180, Number(canvas.getAttribute("height")) || Math.floor(rect.height));
  canvas.width = Math.floor(width * dpr);
  canvas.height = Math.floor(height * dpr);
  const ctx = canvas.getContext("2d");
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  return { ctx, width, height };
}

function extent(values, padRatio = 0.08) {
  const finite = values.filter(Number.isFinite);
  if (!finite.length) return [0, 1];
  let min = Math.min(...finite);
  let max = Math.max(...finite);
  if (min === max) {
    min -= 1;
    max += 1;
  }
  const pad = (max - min) * padRatio;
  return [min - pad, max + pad];
}

function drawEmpty(canvas, message) {
  const { ctx, width, height } = setCanvasSize(canvas);
  ctx.clearRect(0, 0, width, height);
  ctx.fillStyle = "#63717a";
  ctx.font = "13px sans-serif";
  ctx.textAlign = "center";
  ctx.fillText(message, width / 2, height / 2);
}

function drawAxes(ctx, width, height, bounds, label, color = "#63717a") {
  const plot = { left: 58, right: width - 16, top: 18, bottom: height - 34 };
  ctx.clearRect(0, 0, width, height);
  ctx.strokeStyle = "#d8e0e3";
  ctx.lineWidth = 1;
  ctx.font = "11px sans-serif";
  ctx.fillStyle = color;
  ctx.textAlign = "right";
  ctx.textBaseline = "middle";

  for (let i = 0; i <= 4; i++) {
    const y = plot.top + (plot.bottom - plot.top) * i / 4;
    const value = bounds.yMax - (bounds.yMax - bounds.yMin) * i / 4;
    ctx.beginPath();
    ctx.moveTo(plot.left, y);
    ctx.lineTo(plot.right, y);
    ctx.stroke();
    ctx.fillText(formatMeters(value), plot.left - 8, y);
  }

  ctx.textAlign = "center";
  ctx.textBaseline = "top";
  for (let i = 0; i <= 4; i++) {
    const x = plot.left + (plot.right - plot.left) * i / 4;
    const value = bounds.xMin + (bounds.xMax - bounds.xMin) * i / 4;
    ctx.beginPath();
    ctx.moveTo(x, plot.top);
    ctx.lineTo(x, plot.bottom);
    ctx.stroke();
    ctx.fillText(formatTime(value), x, plot.bottom + 9);
  }

  ctx.save();
  ctx.translate(14, (plot.top + plot.bottom) / 2);
  ctx.rotate(-Math.PI / 2);
  ctx.textAlign = "center";
  ctx.fillText(label, 0, 0);
  ctx.restore();
  return plot;
}

function makeTransform(plot, bounds) {
  const xScale = (plot.right - plot.left) / (bounds.xMax - bounds.xMin || 1);
  const yScale = (plot.bottom - plot.top) / (bounds.yMax - bounds.yMin || 1);
  return {
    x(value) {
      return plot.left + (value - bounds.xMin) * xScale;
    },
    y(value) {
      return plot.bottom - (value - bounds.yMin) * yScale;
    }
  };
}

function drawLine(ctx, points, tx, color, width = 1.6, alpha = 1, key = "residual") {
  if (points.length < 2) return;
  ctx.save();
  ctx.globalAlpha = alpha;
  ctx.strokeStyle = color;
  ctx.lineWidth = width;
  ctx.beginPath();
  let started = false;
  for (const point of points) {
    const x = tx.x(point.x);
    const y = tx.y(point[key]);
    if (!started) {
      ctx.moveTo(x, y);
      started = true;
    } else {
      ctx.lineTo(x, y);
    }
  }
  ctx.stroke();
  ctx.restore();
}

function colorForPrn(prn) {
  if (!state.colors.has(prn)) {
    state.colors.set(prn, COLORS[state.colors.size % COLORS.length]);
  }
  return state.colors.get(prn);
}

function displayedPrns() {
  const all = [...state.residualsByPrn.keys()].sort((a, b) => a - b);
  if (!state.usedOnly) return all;
  const used = new Set();
  for (const point of state.pvt) {
    for (const prn of point.used) used.add(prn);
  }
  return all.filter((prn) => used.has(prn));
}

function drawResidualChart() {
  if (!state.residuals.length) {
    drawEmpty(els.residualCanvas, "No residual samples");
    return;
  }
  const prns = displayedPrns();
  const visibleSamples = prns.flatMap((prn) => state.residualsByPrn.get(prn) || []);
  const [xMin, xMax] = extent(visibleSamples.map((sample) => sample.x), 0.01);
  const [yMin, yMax] = extent(visibleSamples.map((sample) => sample.residual), 0.12);
  const { ctx, width, height } = setCanvasSize(els.residualCanvas);
  const plot = drawAxes(ctx, width, height, { xMin, xMax, yMin, yMax }, "range residual");
  const tx = makeTransform(plot, { xMin, xMax, yMin, yMax });

  for (const prn of prns) {
    const selected = prn === state.selectedPrn;
    drawLine(
      ctx,
      state.residualsByPrn.get(prn) || [],
      tx,
      colorForPrn(prn),
      selected ? 2.8 : 1.2,
      selected ? 1 : 0.42
    );
  }
}

function drawEastChart() {
  if (!state.pvt.length) {
    drawEmpty(els.eastCanvas, "No NMEA PVT samples");
    return;
  }
  const [xMin, xMax] = extent(state.pvt.map((point) => point.x), 0.01);
  const [yMin, yMax] = extent(state.pvt.map((point) => point.east), 0.12);
  const { ctx, width, height } = setCanvasSize(els.eastCanvas);
  const plot = drawAxes(ctx, width, height, { xMin, xMax, yMin, yMax }, "east error");
  const tx = makeTransform(plot, { xMin, xMax, yMin, yMax });
  drawLine(ctx, state.pvt, tx, "#156c7b", 2.2, 1, "east");
}

function drawSelectedChart() {
  const prn = state.selectedPrn;
  const residuals = state.residualsByPrn.get(prn) || [];
  if (!prn || residuals.length < 2 || !state.pvt.length) {
    drawEmpty(els.selectedCanvas, "Select a PRN");
    return;
  }

  const xValues = residuals.map((point) => point.x).concat(state.pvt.map((point) => point.x));
  const [xMin, xMax] = extent(xValues, 0.01);
  const [yMin, yMax] = extent(residuals.map((point) => point.residual).concat(state.pvt.map((point) => point.east)), 0.12);
  const { ctx, width, height } = setCanvasSize(els.selectedCanvas);
  const plot = drawAxes(ctx, width, height, { xMin, xMax, yMin, yMax }, "meters");
  const tx = makeTransform(plot, { xMin, xMax, yMin, yMax });
  drawLine(ctx, residuals, tx, colorForPrn(prn), 2.2, 1, "residual");
  drawLine(ctx, state.pvt, tx, "#156c7b", 1.8, 0.78, "east");

  ctx.fillStyle = colorForPrn(prn);
  ctx.font = "12px sans-serif";
  ctx.fillText(`PRN ${prn} residual`, plot.left + 70, plot.top + 12);
  ctx.fillStyle = "#156c7b";
  ctx.fillText("east error", plot.left + 175, plot.top + 12);
}

function renderLegend() {
  els.residualLegend.innerHTML = "";
  for (const prn of displayedPrns()) {
    const button = document.createElement("button");
    button.className = prn === state.selectedPrn ? "active" : "";
    button.innerHTML = `<i style="background:${colorForPrn(prn)}"></i>PRN ${prn}`;
    button.addEventListener("click", () => {
      state.selectedPrn = prn;
      render();
    });
    els.residualLegend.appendChild(button);
  }
}

function renderRanking() {
  els.rankingRows.innerHTML = "";
  for (const item of state.ranking) {
    const tr = document.createElement("tr");
    if (item.prn === state.selectedPrn) tr.classList.add("selected");
    tr.innerHTML = `
      <td>PRN ${item.prn}</td>
      <td>${formatSlope(item.slope)}</td>
      <td>${formatMeters(item.lateRms)}</td>
      <td>${formatCorr(item.corr)}</td>
      <td>${item.usedCount}</td>
    `;
    tr.addEventListener("click", () => {
      state.selectedPrn = item.prn;
      render();
    });
    els.rankingRows.appendChild(tr);
  }
}

function renderMetrics() {
  const residualValues = state.residuals.map((sample) => sample.residual);
  els.residualRms.textContent = formatMeters(rms(residualValues));
  els.residualNote.textContent = `${state.residuals.length} samples, ${state.residualsByPrn.size} PRNs`;

  if (state.pvt.length) {
    const first = state.pvt[0];
    const last = state.pvt[state.pvt.length - 1];
    els.eastDrift.textContent = formatMeters(last.east - first.east);
    els.eastNote.textContent = `final east ${formatMeters(last.east)}, ${state.pvt.length} fixes`;
  } else {
    els.eastDrift.textContent = "-";
    els.eastNote.textContent = "No NMEA fixes";
  }

  const worst = state.ranking[0];
  if (worst) {
    els.worstTrend.textContent = `PRN ${worst.prn}`;
    els.worstTrendNote.textContent = `${formatSlope(worst.slope)}, corr ${formatCorr(worst.corr)}`;
  } else {
    els.worstTrend.textContent = "-";
    els.worstTrendNote.textContent = "-";
  }

  const selected = state.ranking.find((item) => item.prn === state.selectedPrn);
  if (selected) {
    els.selectedMetric.textContent = `PRN ${selected.prn}`;
    els.selectedMetricNote.textContent = `${formatSlope(selected.slope)}, late RMS ${formatMeters(selected.lateRms)}`;
    els.selectedPrnLabel.textContent = `PRN ${selected.prn}, corr ${formatCorr(selected.corr)}`;
  } else {
    els.selectedMetric.textContent = "-";
    els.selectedMetricNote.textContent = "-";
    els.selectedPrnLabel.textContent = "click a PRN row";
  }
}

function render() {
  renderMetrics();
  renderLegend();
  renderRanking();
  drawResidualChart();
  drawEastChart();
  drawSelectedChart();
  els.toggleUsedOnly.classList.toggle("active", state.usedOnly);
}

async function loadDefaults() {
  els.statusLine.textContent = "Loading scenario residual inputs...";
  const [satText, ephText, correctionText, nmeaText] = await Promise.all([
    fetchText(SOURCES.satData),
    fetchText(SOURCES.ephemeris),
    fetchText(SOURCES.corrections),
    fetchText(SOURCES.nmea)
  ]);

  const satRows = parseSatData(satText);
  const corrections = parseCorrections(correctionText);
  const residualResult = computeResiduals(satRows, parseEphemerisXml(ephText), corrections);
  state.residualsByPrn = residualResult.byPrn;
  state.residuals = residualResult.all;
  state.pvt = parseNmea(nmeaText).sort((a, b) => a.x - b.x);
  state.colors.clear();
  for (const prn of [...state.residualsByPrn.keys()].sort((a, b) => a - b)) colorForPrn(prn);
  computeRanking();
  els.statusLine.textContent = `Loaded ${state.residuals.length} residual samples and ${state.pvt.length} PVT fixes`;
  render();
}

els.reloadButton.addEventListener("click", () => {
  loadDefaults().catch((error) => {
    console.error(error);
    els.statusLine.textContent = `Load failed: ${error.message}`;
  });
});

els.toggleUsedOnly.addEventListener("click", () => {
  state.usedOnly = !state.usedOnly;
  render();
});

window.addEventListener("resize", () => render());

loadDefaults().catch((error) => {
  console.error(error);
  els.statusLine.textContent = `Load failed: ${error.message}`;
});
