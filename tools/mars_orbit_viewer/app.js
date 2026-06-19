import * as THREE from "./vendor/three.module.js";

const MARS_RADIUS_KM = 3396.19;
const EARTH_RADIUS_KM = 6371;
const MARS_MU_M3_S2 = 4.282837e13;
const EARTH_CONTEXT_SEPARATION = 22000;
const EARTH_CONTEXT_ORBIT_SCALE = 0.18;
const TRUTH_POSITION = { latDeg: 30, lonDeg: 30, heightM: 30 };
const DEG = 180 / Math.PI;
const RAD = Math.PI / 180;

const COLORS = {
  mars: 0xc86038,
  marsDark: 0x552b24,
  earth: 0x3f7fc7,
  orbit: 0x5f8fd7,
  orbitDim: 0x52606b,
  captured: 0xd6a33b,
  selected: 0xf1e2a7,
  receiver: 0x3aa3a1,
  pvt: 0x70b86d,
  line: 0x6c7477,
  text: "#f3f1ea"
};

const PRN_COLORS = [
  0xd6a33b, 0x3aa3a1, 0x9a83d6, 0x70b86d,
  0xcf6058, 0x5f8fd7, 0xd5874f, 0x9ec66b
];

const DEFAULT_GEOJSON_SOURCES = [
  "/build/latest_pvt.geojson",
  "/build/PVT_260617_142203.geojson"
];

const DEFAULT_SCENARIO_SOURCES = {
  xml: [
    "/Mars-GPS-like-5min/GPS_orbits_mars%201.gps",
    "/Scenario%20Data/GPS_Mars.gps"
  ],
  sat: [
    "/Mars-GPS-like-5min/sat_data_V1A1.csv",
    "/Scenario%20Data/sat_data_V1A1.csv"
  ],
  motion: [
    "/Mars-GPS-like-5min/motion_V1.csv",
    "/Scenario%20Data/motion_V1.csv"
  ]
};

const state = {
  mode: "mars",
  playing: false,
  currentIndex: 0,
  selectedPrn: 15,
  showXml: true,
  showCaptured: true,
  showPvt: true,
  data: {
    orbits: [],
    capturedPrns: [],
    epochs: [],
    motion: [],
    pvt: [],
    nmeaUsed: new Set(),
    receiverFixes: []
  }
};

const els = {
  canvas: document.getElementById("sceneCanvas"),
  statusLine: document.getElementById("statusLine"),
  loadDefaults: document.getElementById("loadDefaults"),
  playButton: document.getElementById("playButton"),
  timeSlider: document.getElementById("timeSlider"),
  epochLabel: document.getElementById("epochLabel"),
  towLabel: document.getElementById("towLabel"),
  xmlCount: document.getElementById("xmlCount"),
  capturedCount: document.getElementById("capturedCount"),
  earthRange: document.getElementById("earthRange"),
  pvtCount: document.getElementById("pvtCount"),
  selectedPrn: document.getElementById("selectedPrn"),
  selectedDetails: document.getElementById("selectedDetails"),
  receiverDetails: document.getElementById("receiverDetails"),
  satSummary: document.getElementById("satSummary"),
  satTable: document.getElementById("satTable"),
  toggleXml: document.getElementById("toggleXml"),
  toggleCaptured: document.getElementById("toggleCaptured"),
  togglePvt: document.getElementById("togglePvt")
};

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x070808);
scene.fog = new THREE.FogExp2(0x070808, 0.000028);

const camera = new THREE.PerspectiveCamera(44, 1, 1, 100000);
const renderer = new THREE.WebGLRenderer({
  canvas: els.canvas,
  antialias: true,
  powerPreference: "high-performance"
});
renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));

const root = new THREE.Group();
const marsGroup = new THREE.Group();
const earthGroup = new THREE.Group();
const orbitGroup = new THREE.Group();
const markerGroup = new THREE.Group();
const labelGroup = new THREE.Group();
const pvtGroup = new THREE.Group();
const earthOrbitHalo = new THREE.Group();
const earthMarkerGroup = new THREE.Group();
scene.add(root);
root.add(marsGroup, earthGroup);
marsGroup.add(orbitGroup, markerGroup, labelGroup, pvtGroup);
earthGroup.add(earthOrbitHalo, earthMarkerGroup);

const ambient = new THREE.AmbientLight(0x8f8b82, 1.3);
const sun = new THREE.DirectionalLight(0xfff3d6, 2.4);
sun.position.set(-9000, 12000, 8000);
scene.add(ambient, sun);

const controls = {
  yaw: -0.72,
  pitch: 0.42,
  distance: 22000,
  target: new THREE.Vector3(0, 0, 0),
  dragging: false,
  lastX: 0,
  lastY: 0
};

const meshes = {
  mars: null,
  earth: null,
  receiver: null,
  receiverLabel: null,
  pvtLine: null,
  pvtEnd: null,
  orbits: new Map(),
  satMarkers: new Map(),
  satLabels: new Map(),
  earthLine: null,
  earthMars: null,
  earthMarsLabel: null,
  earthReceiver: null,
  earthSatMarkers: new Map()
};

function fmt(value, digits = 1) {
  return Number.isFinite(value) ? value.toFixed(digits) : "-";
}

function fmtInt(value) {
  return Number.isFinite(value) ? Math.round(value).toLocaleString() : "-";
}

function fmtTow(ms) {
  if (!Number.isFinite(ms)) return "-";
  const totalSeconds = Math.floor(ms / 1000);
  const day = Math.floor(totalSeconds / 86400);
  const seconds = totalSeconds % 86400;
  const hh = Math.floor(seconds / 3600);
  const mm = Math.floor((seconds % 3600) / 60);
  const ss = seconds % 60;
  const tod = `${String(hh).padStart(2, "0")}:${String(mm).padStart(2, "0")}:${String(ss).padStart(2, "0")}`;
  return day > 0 ? `D${day} ${tod}` : tod;
}

function splitCsv(line) {
  return line.split(",").map((value) => value.trim());
}

function parseCsvRows(text, headerLineIndex) {
  const lines = text.split(/\r?\n/).filter((line) => line.trim());
  const headers = splitCsv(lines[headerLineIndex]);
  return lines.slice(headerLineIndex + 1).map((line) => {
    const values = splitCsv(line);
    const row = {};
    headers.forEach((header, index) => {
      row[header] = values[index] ?? "";
    });
    return row;
  });
}

function num(row, key) {
  const value = Number(row[key]);
  return Number.isFinite(value) ? value : NaN;
}

function textOf(node, tag) {
  const child = node.getElementsByTagName(tag)[0];
  return child ? child.textContent.trim() : "";
}

function solveEccentricAnomaly(meanAnomaly, eccentricity) {
  let e = meanAnomaly;
  for (let i = 0; i < 8; i += 1) {
    e -= (e - eccentricity * Math.sin(e) - meanAnomaly) / (1 - eccentricity * Math.cos(e));
  }
  return e;
}

function orbitPosition(orbit, meanAnomalyOverride = null, towSeconds = null) {
  const mean = meanAnomalyOverride ?? orbit.meanAnomaly + orbit.meanMotion * ((towSeconds ?? orbit.toaSeconds) - orbit.toaSeconds);
  const eccentricAnomaly = solveEccentricAnomaly(mean, orbit.eccentricity);
  const cosE = Math.cos(eccentricAnomaly);
  const sinE = Math.sin(eccentricAnomaly);
  const r = orbit.aKm * (1 - orbit.eccentricity * cosE);
  const trueAnomaly = Math.atan2(
    Math.sqrt(1 - orbit.eccentricity * orbit.eccentricity) * sinE,
    cosE - orbit.eccentricity
  );
  const u = orbit.argPerigee + trueAnomaly;
  const cosU = Math.cos(u);
  const sinU = Math.sin(u);
  const cosO = Math.cos(orbit.raan);
  const sinO = Math.sin(orbit.raan);
  const cosI = Math.cos(orbit.inclination);
  const sinI = Math.sin(orbit.inclination);
  return new THREE.Vector3(
    r * (cosO * cosU - sinO * sinU * cosI),
    r * (sinO * cosU + cosO * sinU * cosI),
    r * (sinU * sinI)
  );
}

function llhToMars(latDeg, lonDeg, heightM = 0, surfaceOffsetKm = 0) {
  const lat = latDeg * RAD;
  const lon = lonDeg * RAD;
  const radius = MARS_RADIUS_KM + heightM / 1000 + surfaceOffsetKm;
  return new THREE.Vector3(
    radius * Math.cos(lat) * Math.cos(lon),
    radius * Math.cos(lat) * Math.sin(lon),
    radius * Math.sin(lat)
  );
}

function parseGpsXml(text) {
  const doc = new DOMParser().parseFromString(text, "application/xml");
  const nodes = [...doc.getElementsByTagName("satellite")];
  return nodes
    .map((node) => {
      const enabled = textOf(node, "enabled").toLowerCase() === "yes";
      const sqrtA = Number(textOf(node, "SQRT_A"));
      const aM = sqrtA * sqrtA;
      return {
        prn: Number(node.getAttribute("ID")),
        enabled,
        aM,
        aKm: aM / 1000,
        eccentricity: Number(textOf(node, "Eccentricity") || 0),
        inclination: Number(textOf(node, "Orbital_Inclination_rad") || 0),
        raan: Number(textOf(node, "Right_Ascen_at_TOA_rad") || 0),
        argPerigee: Number(textOf(node, "Argument_of_Perigee_rad") || 0),
        meanAnomaly: Number(textOf(node, "Mean_Anom_rad") || 0),
        toaSeconds: Number(textOf(node, "Time_of_Applicability_s") || 0),
        frame: textOf(node, "reference_frame")
      };
    })
    .filter((orbit) => orbit.enabled && Number.isFinite(orbit.prn) && Number.isFinite(orbit.aM))
    .map((orbit) => ({
      ...orbit,
      meanMotion: Math.sqrt(MARS_MU_M3_S2 / Math.pow(orbit.aM, 3))
    }));
}

function parseSatData(text) {
  const rows = parseCsvRows(text, 4)
    .filter((row) => row.Sat_type === "GPS")
    .map((row) => ({
      towMs: num(row, "TOW_ms"),
      channel: num(row, "Channel"),
      prn: num(row, "Sat_PRN"),
      rangeKm: num(row, "Range") / 1000,
      pseudoRangeKm: num(row, "P-Range Group A") / 1000,
      azimuthRad: num(row, "Azimuth"),
      elevationRad: num(row, "Elevation"),
      antennaAzimuthRad: num(row, "Ant_azimuth"),
      antennaElevationRad: num(row, "Ant_elevation"),
      signalDb: num(row, "Signal_dB Group A"),
      dopplerHz: num(row, "Doppler_shift Group A"),
      rangeRate: num(row, "Range_rate"),
      posKm: new THREE.Vector3(num(row, "Sat_Pos_X") / 1000, num(row, "Sat_Pos_Y") / 1000, num(row, "Sat_Pos_Z") / 1000)
    }))
    .filter((row) => Number.isFinite(row.towMs) && Number.isFinite(row.prn));

  const byTow = new Map();
  rows.forEach((row) => {
    const key = String(row.towMs);
    if (!byTow.has(key)) byTow.set(key, []);
    byTow.get(key).push(row);
  });

  return [...byTow.entries()]
    .map(([tow, sats]) => ({
      towMs: Number(tow),
      seconds: (Number(tow) - rows[0].towMs) / 1000,
      sats: sats.sort((a, b) => a.prn - b.prn)
    }))
    .sort((a, b) => a.towMs - b.towMs);
}

function parseMotion(text) {
  return parseCsvRows(text, 1)
    .map((row) => ({
      towMs: num(row, "TOW_ms"),
      eciKm: new THREE.Vector3(num(row, "Pos_X_ECI") / 1000, num(row, "Pos_Y_ECI") / 1000, num(row, "Pos_Z_ECI") / 1000),
      velEciKmS: new THREE.Vector3(num(row, "Vel_X_ECI") / 1000, num(row, "Vel_Y_ECI") / 1000, num(row, "Vel_Z_ECI") / 1000),
      latRad: num(row, "Ant1_Lat"),
      lonRad: num(row, "Ant1_Long"),
      gdop: num(row, "Ant1_GDOP"),
      pdop: num(row, "Ant1_PDOP"),
      hdop: num(row, "Ant1_HDOP")
    }))
    .filter((row) => Number.isFinite(row.towMs));
}

function parseGeojson(text) {
  if (!text.trim()) return [];
  try {
    const data = JSON.parse(text);
    const coords = data.geometry && data.geometry.coordinates;
    const points = data.geometry && data.geometry.type === "MultiPoint" ? coords : [coords];
    return points
      .filter((point) => Array.isArray(point) && point.length >= 2)
      .map((point) => ({
        lon: Number(point[0]),
        lat: Number(point[1]),
        heightM: Number(point[2] || 0)
      }))
      .filter((point) => Number.isFinite(point.lat) && Number.isFinite(point.lon));
  } catch {
    return [];
  }
}

function nmeaCoord(value, hemi) {
  const raw = Number(value);
  if (!Number.isFinite(raw)) return NaN;
  const degrees = Math.floor(raw / 100);
  const minutes = raw - degrees * 100;
  const signed = degrees + minutes / 60;
  return hemi === "S" || hemi === "W" ? -signed : signed;
}

function nmeaTimeSeconds(value) {
  if (!value) return NaN;
  const hh = Number(value.slice(0, 2));
  const mm = Number(value.slice(2, 4));
  const ss = Number(value.slice(4));
  if (![hh, mm, ss].every(Number.isFinite)) return NaN;
  return hh * 3600 + mm * 60 + ss;
}

function nmeaDateText(value) {
  if (!value || value.length < 6) return "";
  const day = value.slice(0, 2);
  const month = value.slice(2, 4);
  const year = `20${value.slice(4, 6)}`;
  return `${year}-${month}-${day}`;
}

function receiverTimeText(fix) {
  if (!fix) return "-";
  const seconds = Number.isFinite(fix.todSeconds) ? fix.todSeconds : 0;
  const hh = Math.floor(seconds / 3600);
  const mm = Math.floor((seconds % 3600) / 60);
  const ss = seconds - hh * 3600 - mm * 60;
  const tod = `${String(hh).padStart(2, "0")}:${String(mm).padStart(2, "0")}:${ss.toFixed(2).padStart(5, "0")}`;
  return fix.dateText ? `${fix.dateText} ${tod}` : tod;
}

function parseNmeaUsed(text) {
  const used = new Set();
  text.split(/\r?\n/).forEach((line) => {
    if (!line.startsWith("$") || line.slice(3, 6) !== "GSA") return;
    const body = line.split("*")[0];
    body.split(",").slice(3, 15).forEach((value) => {
      const prn = Number(value);
      if (Number.isFinite(prn) && prn > 0) used.add(prn);
    });
  });
  return used;
}

function parseNmeaReceiver(text) {
  const fixes = [];
  const datesByTime = new Map();
  let firstTod = null;
  text.split(/\r?\n/).forEach((line) => {
    if (!line.startsWith("$")) return;
    const body = line.split("*")[0];
    const fields = body.split(",");
    const type = fields[0].slice(3);
    if (type === "RMC" && fields[1] && fields[9]) {
      datesByTime.set(fields[1], nmeaDateText(fields[9]));
      return;
    }
    if (type !== "GGA") return;
    const todSeconds = nmeaTimeSeconds(fields[1]);
    if (!Number.isFinite(todSeconds)) return;
    if (firstTod === null) firstTod = todSeconds;
    const fix = {
      relativeSeconds: todSeconds - firstTod,
      todSeconds,
      dateText: datesByTime.get(fields[1]) || "",
      lat: nmeaCoord(fields[2], fields[3]),
      lon: nmeaCoord(fields[4], fields[5]),
      quality: Number(fields[6]),
      satellites: Number(fields[7]),
      hdop: Number(fields[8]),
      heightM: Number(fields[9])
    };
    if (Number.isFinite(fix.lat) && Number.isFinite(fix.lon)) fixes.push(fix);
  });
  return fixes;
}

async function fetchText(url) {
  const response = await fetch(url, { cache: "no-store" });
  if (!response.ok) throw new Error(`${response.status} ${url}`);
  return response.text();
}

async function fetchFirstText(urls) {
  for (const url of urls) {
    try {
      return await fetchText(url);
    } catch {
      // Try the next stable result artifact.
    }
  }
  return "";
}

async function fetchFirstSource(urls) {
  for (const url of urls) {
    try {
      return { text: await fetchText(url), url };
    } catch {
      // Try the next stable result artifact.
    }
  }
  return { text: "", url: "" };
}

function makeMarsTexture() {
  const canvas = document.createElement("canvas");
  canvas.width = 1024;
  canvas.height = 512;
  const ctx = canvas.getContext("2d");
  const gradient = ctx.createLinearGradient(0, 0, canvas.width, canvas.height);
  gradient.addColorStop(0, "#b65332");
  gradient.addColorStop(0.48, "#d58458");
  gradient.addColorStop(1, "#7c3c30");
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  for (let i = 0; i < 1200; i += 1) {
    const x = Math.random() * canvas.width;
    const y = Math.random() * canvas.height;
    const r = 1 + Math.random() * 8;
    ctx.fillStyle = Math.random() > 0.5 ? "rgba(82, 43, 34, 0.22)" : "rgba(242, 182, 124, 0.16)";
    ctx.beginPath();
    ctx.ellipse(x, y, r * (1.5 + Math.random() * 2.5), r, Math.random() * Math.PI, 0, Math.PI * 2);
    ctx.fill();
  }
  return new THREE.CanvasTexture(canvas);
}

function makeLabel(text, color = COLORS.text) {
  const canvas = document.createElement("canvas");
  canvas.width = 256;
  canvas.height = 96;
  const ctx = canvas.getContext("2d");
  ctx.font = "700 34px system-ui, sans-serif";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillStyle = "rgba(8, 9, 9, 0.62)";
  ctx.roundRect(20, 20, 216, 56, 14);
  ctx.fill();
  ctx.fillStyle = color;
  ctx.fillText(text, 128, 49);
  const texture = new THREE.CanvasTexture(canvas);
  const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: texture, transparent: true, depthWrite: false }));
  sprite.scale.set(900, 338, 1);
  return sprite;
}

function colorForPrn(prn) {
  return PRN_COLORS[Math.abs(prn) % PRN_COLORS.length];
}

function makeSphere(radius, color, segments = 48, texture = null) {
  const material = new THREE.MeshStandardMaterial({
    color,
    map: texture,
    roughness: 0.88,
    metalness: 0.02
  });
  return new THREE.Mesh(new THREE.SphereGeometry(radius, segments, Math.max(16, segments / 2)), material);
}

function lineFromPoints(points, color, opacity = 1, linewidth = 1) {
  const geometry = new THREE.BufferGeometry().setFromPoints(points);
  const material = new THREE.LineBasicMaterial({ color, transparent: opacity < 1, opacity, linewidth });
  return new THREE.Line(geometry, material);
}

function createSceneObjects() {
  marsGroup.clear();
  earthGroup.clear();
  orbitGroup.clear();
  markerGroup.clear();
  labelGroup.clear();
  pvtGroup.clear();
  earthOrbitHalo.clear();
  earthMarkerGroup.clear();
  meshes.orbits.clear();
  meshes.satMarkers.clear();
  meshes.satLabels.clear();
  meshes.earthSatMarkers.clear();

  const marsTexture = makeMarsTexture();
  meshes.mars = makeSphere(MARS_RADIUS_KM, COLORS.mars, 72, marsTexture);
  marsGroup.add(meshes.mars);

  const wire = new THREE.Mesh(
    new THREE.SphereGeometry(MARS_RADIUS_KM * 1.002, 36, 18),
    new THREE.MeshBasicMaterial({ color: 0xf0c0a5, wireframe: true, transparent: true, opacity: 0.09 })
  );
  marsGroup.add(wire);
  marsGroup.add(orbitGroup, markerGroup, labelGroup, pvtGroup);

  const receiverPos = llhToMars(TRUTH_POSITION.latDeg, TRUTH_POSITION.lonDeg, TRUTH_POSITION.heightM, 55);
  meshes.receiver = makeSphere(110, COLORS.receiver, 24);
  meshes.receiver.position.copy(receiverPos);
  marsGroup.add(meshes.receiver);
  meshes.receiverLabel = makeLabel("RX 30/30", "#bdf4ed");
  meshes.receiverLabel.position.copy(receiverPos.clone().multiplyScalar(1.06));
  labelGroup.add(meshes.receiverLabel);

  createOrbitLines();
  createPvtTrack();
  createEarthContextObjects();
}

function createOrbitLines() {
  const captured = new Set(state.data.capturedPrns);
  state.data.orbits.forEach((orbit) => {
    const points = [];
    const samples = 192;
    for (let i = 0; i <= samples; i += 1) {
      points.push(orbitPosition(orbit, (i / samples) * Math.PI * 2));
    }
    const line = lineFromPoints(points, captured.has(orbit.prn) ? colorForPrn(orbit.prn) : COLORS.orbitDim, captured.has(orbit.prn) ? 0.92 : 0.22);
    orbitGroup.add(line);
    meshes.orbits.set(orbit.prn, line);

    const marker = makeSphere(captured.has(orbit.prn) ? 88 : 44, captured.has(orbit.prn) ? colorForPrn(orbit.prn) : COLORS.orbitDim, 20);
    markerGroup.add(marker);
    meshes.satMarkers.set(orbit.prn, marker);
    if (captured.has(orbit.prn)) {
      const label = makeLabel(`PRN ${String(orbit.prn).padStart(2, "0")}`, "#fff2c6");
      labelGroup.add(label);
      meshes.satLabels.set(orbit.prn, label);
    }
  });
}

function createPvtTrack() {
  if (!state.data.pvt.length) return;
  const points = state.data.pvt.map((point) => llhToMars(point.lat, point.lon, point.heightM, 75));
  meshes.pvtLine = lineFromPoints(points, COLORS.pvt, 0.95);
  pvtGroup.add(meshes.pvtLine);
  meshes.pvtEnd = makeSphere(80, COLORS.pvt, 20);
  meshes.pvtEnd.position.copy(points[points.length - 1]);
  pvtGroup.add(meshes.pvtEnd);
}

function createEarthContextObjects() {
  const earth = makeSphere(700, COLORS.earth, 48);
  earthGroup.add(earth);
  meshes.earth = earth;
  const earthLabel = makeLabel("Earth", "#d7e9ff");
  earthLabel.scale.set(720, 270, 1);
  earthLabel.position.set(0, 1000, 0);
  earthGroup.add(earthLabel);

  meshes.earthLine = lineFromPoints([new THREE.Vector3(), new THREE.Vector3(EARTH_CONTEXT_SEPARATION, 0, 0)], COLORS.line, 0.65);
  earthGroup.add(meshes.earthLine);
  meshes.earthMars = makeSphere(400, COLORS.mars, 40, makeMarsTexture());
  earthGroup.add(meshes.earthMars);
  meshes.earthMarsLabel = makeLabel("Mars / RX", "#ffd6bd");
  meshes.earthMarsLabel.scale.set(900, 338, 1);
  earthGroup.add(meshes.earthMarsLabel);
  meshes.earthReceiver = makeSphere(70, COLORS.receiver, 16);
  earthGroup.add(meshes.earthReceiver);

  const captured = new Set(state.data.capturedPrns);
  state.data.orbits
    .filter((orbit) => captured.has(orbit.prn))
    .forEach((orbit) => {
      const points = [];
      const samples = 144;
      for (let i = 0; i <= samples; i += 1) {
        points.push(orbitPosition(orbit, (i / samples) * Math.PI * 2).multiplyScalar(EARTH_CONTEXT_ORBIT_SCALE));
      }
      const line = lineFromPoints(points, colorForPrn(orbit.prn), 0.75);
      earthOrbitHalo.add(line);
      const marker = makeSphere(46, colorForPrn(orbit.prn), 16);
      earthMarkerGroup.add(marker);
      meshes.earthSatMarkers.set(orbit.prn, marker);
    });
  earthGroup.add(earthOrbitHalo, earthMarkerGroup);
}

function nearestMotion(towMs) {
  const motion = state.data.motion;
  if (!motion.length) return null;
  let best = motion[0];
  let bestDiff = Math.abs(best.towMs - towMs);
  for (const row of motion) {
    const diff = Math.abs(row.towMs - towMs);
    if (diff < bestDiff) {
      best = row;
      bestDiff = diff;
    }
  }
  return best;
}

function currentEpoch() {
  return state.data.epochs[state.currentIndex] || null;
}

function currentTowSeconds() {
  const epoch = currentEpoch();
  return epoch ? epoch.towMs / 1000 : 0;
}

function nearestReceiverFix(seconds) {
  const fixes = state.data.receiverFixes;
  if (!fixes.length || !Number.isFinite(seconds)) return null;
  let best = fixes[0];
  let bestDiff = Math.abs(best.relativeSeconds - seconds);
  for (const fix of fixes) {
    const diff = Math.abs(fix.relativeSeconds - seconds);
    if (diff < bestDiff) {
      best = fix;
      bestDiff = diff;
    }
  }
  return best;
}

function updateMarsScene() {
  const towSec = currentTowSeconds();
  const captured = new Set(state.data.capturedPrns);
  const visibleRows = new Map((currentEpoch()?.sats || []).map((sat) => [sat.prn, sat]));
  orbitGroup.visible = state.showXml;
  pvtGroup.visible = state.showPvt;
  markerGroup.visible = state.showCaptured;
  labelGroup.visible = true;

  state.data.orbits.forEach((orbit) => {
    const pos = orbitPosition(orbit, null, towSec);
    const marker = meshes.satMarkers.get(orbit.prn);
    if (marker) {
      marker.position.copy(pos);
      marker.visible = captured.has(orbit.prn) ? state.showCaptured : state.showXml;
      const satRow = visibleRows.get(orbit.prn);
      const isSelected = orbit.prn === state.selectedPrn;
      const baseScale = captured.has(orbit.prn) ? 1 : 0.72;
      marker.scale.setScalar(isSelected ? 1.8 : baseScale);
      if (satRow) {
        marker.material.color.set(satRow.antennaElevationRad >= 0 ? colorForPrn(orbit.prn) : COLORS.orbitDim);
      }
    }
    const label = meshes.satLabels.get(orbit.prn);
    if (label) {
      label.position.copy(pos.clone().multiplyScalar(1.075));
      label.visible = state.showCaptured;
    }
    const orbitLine = meshes.orbits.get(orbit.prn);
    if (orbitLine) {
      orbitLine.visible = captured.has(orbit.prn) ? state.showXml : state.showXml;
      orbitLine.material.opacity = captured.has(orbit.prn) ? 0.92 : 0.22;
    }
  });
}

function updateEarthScene() {
  const epoch = currentEpoch();
  const motion = nearestMotion(epoch?.towMs || 0);
  if (!motion) return;
  const unit = motion.eciKm.clone().normalize();
  const marsPos = unit.multiplyScalar(EARTH_CONTEXT_SEPARATION);
  meshes.earthMars.position.copy(marsPos);
  meshes.earthMarsLabel.position.copy(marsPos.clone().add(new THREE.Vector3(0, 850, 0)));
  meshes.earthReceiver.position.copy(marsPos.clone().add(new THREE.Vector3(430, 0, 0)));

  const lineGeom = new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(), marsPos]);
  meshes.earthLine.geometry.dispose();
  meshes.earthLine.geometry = lineGeom;

  earthOrbitHalo.position.copy(marsPos);
  earthMarkerGroup.position.copy(marsPos);
  const towSec = currentTowSeconds();
  state.data.orbits.forEach((orbit) => {
    const marker = meshes.earthSatMarkers.get(orbit.prn);
    if (marker) {
      marker.position.copy(orbitPosition(orbit, null, towSec).multiplyScalar(EARTH_CONTEXT_ORBIT_SCALE));
      marker.visible = state.showCaptured;
    }
  });
  earthOrbitHalo.visible = state.showXml;
  earthMarkerGroup.visible = state.showCaptured;
}

function updateScene() {
  marsGroup.visible = state.mode === "mars";
  earthGroup.visible = state.mode === "earth";
  updateMarsScene();
  updateEarthScene();
  renderHud();
}

function detailsHtml(items) {
  return items
    .map(([label, value]) => `<div class="detail"><span>${label}</span><strong>${value}</strong></div>`)
    .join("");
}

function renderHud() {
  const epoch = currentEpoch();
  const motion = nearestMotion(epoch?.towMs || 0);
  const receiverFix = nearestReceiverFix(epoch?.seconds || 0);
  const earthDistanceKm = motion ? motion.eciKm.length() : NaN;
  const selected = epoch?.sats.find((sat) => sat.prn === state.selectedPrn);
  els.epochLabel.textContent = epoch ? `T+${fmt(epoch.seconds, 0)} s` : "-";
  els.towLabel.textContent = epoch ? `TOW ${fmtTow(epoch.towMs)}` : "-";
  els.timeSlider.max = String(Math.max(0, state.data.epochs.length - 1));
  els.timeSlider.value = String(state.currentIndex);
  els.xmlCount.textContent = state.data.orbits.length || "-";
  els.capturedCount.textContent = state.data.capturedPrns.length || "-";
  els.earthRange.textContent = Number.isFinite(earthDistanceKm) ? `${fmt(earthDistanceKm / 1e6, 2)}M km` : "-";
  els.pvtCount.textContent = state.data.pvt.length || "-";
  els.selectedPrn.textContent = `PRN ${String(state.selectedPrn).padStart(2, "0")}`;
  els.selectedDetails.innerHTML = detailsHtml([
    ["Range", selected ? `${fmt(selected.rangeKm, 1)} km` : "-"],
    ["Antenna El", selected ? `${fmt(selected.antennaElevationRad * DEG, 1)} deg` : "-"],
    ["Azimuth", selected ? `${fmt(selected.antennaAzimuthRad * DEG, 1)} deg` : "-"],
    ["Doppler", selected ? `${fmt(selected.dopplerHz, 0)} Hz` : "-"],
    ["Range Rate", selected ? `${fmt(selected.rangeRate, 1)} m/s` : "-"],
    ["Signal", selected ? `${fmt(selected.signalDb, 1)} dB` : "-"],
    ["NMEA Used", state.data.nmeaUsed.has(state.selectedPrn) ? "yes" : "no"]
  ]);
  const pvtMean = pvtMeanOffset();
  els.receiverDetails.innerHTML = detailsHtml([
    ["Truth Lat/Lon", `${TRUTH_POSITION.latDeg.toFixed(6)}, ${TRUTH_POSITION.lonDeg.toFixed(6)}`],
    ["Truth Height", `${fmt(TRUTH_POSITION.heightM, 1)} m`],
    ["Scenario TOW", epoch ? fmtTow(epoch.towMs) : "-"],
    ["Receiver NMEA Time", receiverTimeText(receiverFix)],
    ["Receiver Lat/Lon", receiverFix ? `${fmt(receiverFix.lat, 6)}, ${fmt(receiverFix.lon, 6)}` : "-"],
    ["Receiver Height", receiverFix ? `${fmt(receiverFix.heightM, 1)} m` : "-"],
    ["Receiver Sats", receiverFix ? fmt(receiverFix.satellites, 0) : "-"],
    ["Mars Radius", `${fmt(MARS_RADIUS_KM, 1)} km`],
    ["ECI Range", Number.isFinite(earthDistanceKm) ? `${fmt(earthDistanceKm / 1e6, 3)}M km` : "-"],
    ["ECI Velocity", motion ? `${fmt(motion.velEciKmS.length(), 2)} km/s` : "-"],
    ["PVT Mean E/N", pvtMean ? `${fmt(pvtMean.eastM, 0)} / ${fmt(pvtMean.northM, 0)} m` : "-"],
    ["PVT Radial", pvtMean ? `${fmt(pvtMean.radialM, 0)} m` : "-"]
  ]);
  renderSatTable(epoch);
}

function renderSatTable(epoch) {
  const sats = epoch?.sats || [];
  els.satSummary.textContent = sats.length ? `${sats.length} PRNs` : "-";
  els.satTable.innerHTML = sats
    .map((sat) => {
      const selected = sat.prn === state.selectedPrn ? "selected" : "";
      return `
        <tr class="${selected}" data-prn="${sat.prn}">
          <td><span class="prn-cell"><i class="swatch" style="background:#${colorForPrn(sat.prn).toString(16).padStart(6, "0")}"></i>${String(sat.prn).padStart(2, "0")}</span></td>
          <td>${fmt(sat.rangeKm, 0)} km</td>
          <td>${fmt(sat.antennaElevationRad * DEG, 1)} deg</td>
          <td>${fmt(sat.dopplerHz, 0)} Hz</td>
          <td>${fmt(sat.signalDb, 1)}</td>
        </tr>
      `;
    })
    .join("");
  els.satTable.querySelectorAll("tr").forEach((row) => {
    row.addEventListener("click", () => {
      state.selectedPrn = Number(row.dataset.prn);
      updateScene();
    });
  });
}

function pvtMeanOffset() {
  if (!state.data.pvt.length) return null;
  const meanLat = state.data.pvt.reduce((sum, point) => sum + point.lat, 0) / state.data.pvt.length;
  const meanLon = state.data.pvt.reduce((sum, point) => sum + point.lon, 0) / state.data.pvt.length;
  const eastM = (meanLon - TRUTH_POSITION.lonDeg) * RAD * MARS_RADIUS_KM * 1000 * Math.cos(meanLat * RAD);
  const northM = (meanLat - TRUTH_POSITION.latDeg) * RAD * MARS_RADIUS_KM * 1000;
  return { meanLat, meanLon, eastM, northM, radialM: Math.hypot(eastM, northM) };
}

function setMode(mode) {
  state.mode = mode;
  document.querySelectorAll(".mode").forEach((button) => {
    button.classList.toggle("active", button.dataset.mode === mode);
  });
  if (mode === "mars") {
    controls.target.set(0, 0, 0);
    controls.distance = 22000;
    controls.yaw = -0.72;
    controls.pitch = 0.42;
  } else {
    controls.target.set(EARTH_CONTEXT_SEPARATION * 0.52, 0, 0);
    controls.distance = 36000;
    controls.yaw = -0.55;
    controls.pitch = 0.36;
  }
  updateScene();
}

function updateCamera() {
  const cosPitch = Math.cos(controls.pitch);
  const offset = new THREE.Vector3(
    Math.cos(controls.yaw) * cosPitch,
    Math.sin(controls.pitch),
    Math.sin(controls.yaw) * cosPitch
  ).multiplyScalar(controls.distance);
  camera.position.copy(controls.target).add(offset);
  camera.lookAt(controls.target);
}

function resize() {
  const rect = els.canvas.getBoundingClientRect();
  const width = Math.max(320, Math.floor(rect.width));
  const height = Math.max(260, Math.floor(rect.height));
  renderer.setSize(width, height, false);
  camera.aspect = width / height;
  camera.updateProjectionMatrix();
}

function tick() {
  if (state.playing && state.data.epochs.length) {
    state.currentIndex = (state.currentIndex + 1) % state.data.epochs.length;
    updateScene();
  }
  updateCamera();
  renderer.render(scene, camera);
  requestAnimationFrame(tick);
}

function installHandlers() {
  window.addEventListener("resize", resize);
  els.canvas.addEventListener("pointerdown", (event) => {
    controls.dragging = true;
    controls.lastX = event.clientX;
    controls.lastY = event.clientY;
    els.canvas.setPointerCapture(event.pointerId);
  });
  els.canvas.addEventListener("pointermove", (event) => {
    if (!controls.dragging) return;
    const dx = event.clientX - controls.lastX;
    const dy = event.clientY - controls.lastY;
    controls.lastX = event.clientX;
    controls.lastY = event.clientY;
    controls.yaw -= dx * 0.006;
    controls.pitch = Math.max(-1.28, Math.min(1.28, controls.pitch + dy * 0.006));
  });
  els.canvas.addEventListener("pointerup", () => {
    controls.dragging = false;
  });
  els.canvas.addEventListener("wheel", (event) => {
    event.preventDefault();
    controls.distance = Math.max(3500, Math.min(70000, controls.distance * (event.deltaY > 0 ? 1.1 : 0.9)));
  }, { passive: false });

  document.querySelectorAll(".mode").forEach((button) => {
    button.addEventListener("click", () => setMode(button.dataset.mode));
  });
  els.loadDefaults.addEventListener("click", loadDefaults);
  els.playButton.addEventListener("click", () => {
    state.playing = !state.playing;
    els.playButton.textContent = state.playing ? "Pause" : "Play";
  });
  els.timeSlider.addEventListener("input", () => {
    state.currentIndex = Number(els.timeSlider.value);
    state.playing = false;
    els.playButton.textContent = "Play";
    updateScene();
  });
  els.toggleXml.addEventListener("change", () => {
    state.showXml = els.toggleXml.checked;
    updateScene();
  });
  els.toggleCaptured.addEventListener("change", () => {
    state.showCaptured = els.toggleCaptured.checked;
    updateScene();
  });
  els.togglePvt.addEventListener("change", () => {
    state.showPvt = els.togglePvt.checked;
    updateScene();
  });
}

async function loadDefaults() {
  state.playing = false;
  els.playButton.textContent = "Play";
  els.statusLine.textContent = "Loading scenario data...";
  const [xmlSource, satSource, motionSource, geojson, nmea] = await Promise.all([
    fetchFirstSource(DEFAULT_SCENARIO_SOURCES.xml),
    fetchFirstSource(DEFAULT_SCENARIO_SOURCES.sat),
    fetchFirstSource(DEFAULT_SCENARIO_SOURCES.motion),
    fetchFirstText(DEFAULT_GEOJSON_SOURCES),
    fetchText("/build/gnss_sdr_pvt.nmea").catch(() => "")
  ]);

  const orbits = parseGpsXml(xmlSource.text);
  const epochs = parseSatData(satSource.text);
  const motion = parseMotion(motionSource.text);
  const pvt = parseGeojson(geojson);
  const nmeaUsed = parseNmeaUsed(nmea);
  const receiverFixes = parseNmeaReceiver(nmea);
  const capturedPrns = [...new Set(epochs.flatMap((epoch) => epoch.sats.map((sat) => sat.prn)))].sort((a, b) => a - b);
  state.data = { orbits, epochs, motion, pvt, capturedPrns, nmeaUsed, receiverFixes };
  state.currentIndex = Math.max(0, Math.min(state.currentIndex, epochs.length - 1));
  state.selectedPrn = capturedPrns.includes(state.selectedPrn) ? state.selectedPrn : capturedPrns[0];
  const scenarioName = xmlSource.url.includes("Mars-GPS-like-5min") ? "GPS-like 5 min" : "Mars SPIR";
  els.statusLine.textContent = `${scenarioName}: ${orbits.length} XML satellites, ${capturedPrns.length} captured PRNs, ${epochs.length} scenario epochs`;
  createSceneObjects();
  resize();
  updateScene();
}

installHandlers();
resize();
createSceneObjects();
tick();
loadDefaults().catch((error) => {
  console.error(error);
  els.statusLine.textContent = `Load failed: ${error.message}`;
});
