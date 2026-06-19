const MARS_EQUATORIAL_RADIUS_M = 3396190;
const MARS_POLAR_RADIUS_M = 3376200;
const MARS_RADIUS_M = MARS_EQUATORIAL_RADIUS_M;
const MARS_FLATTENING = (MARS_EQUATORIAL_RADIUS_M - MARS_POLAR_RADIUS_M) / MARS_EQUATORIAL_RADIUS_M;
const DEG_TO_RAD = Math.PI / 180;
const TRUTH_POSITION = {
  lat: 30,
  lon: 30,
  height: 80
};
const COLORS = {
  start: "#2f6db5",
  lock: "#156c7b",
  nav: "#b46c11",
  nmea: "#7a5f12",
  loss: "#b43434",
  pvt: "#258552",
  firstFix: "#2f6db5",
  finalFix: "#c2472b",
  error: "#c2472b",
  iAxis: "#2f6db5",
  qAxis: "#c2472b",
  mixed: "#7a5f12",
  reference: "#8f3f5d",
  visible: "#6f7f87",
  below: "#9b6a5d",
  grid: "#d8e0e3",
  text: "#192025",
  muted: "#63717a"
};

const DEFAULT_SOURCES = {
  log: [
    "/build/gnss_sdr_gps_like_iau_probe.log",
    "/build/gnss_sdr_run_fixed.log"
  ],
  nmea: ["/build/gnss_sdr_pvt.nmea"],
  geojson: ["/build/latest_pvt.geojson", "/build/PVT_260617_142203.geojson"],
  iq: ["/build/gnss_sdr_gps_like_iq_summary.json"]
};

const state = {
  raw: { log: "", nmea: "", geojson: "", iq: "" },
  files: {},
  events: [],
  channels: new Map(),
  navMessages: [],
  diagnostics: [],
  pvtLog: [],
  pvtNmea: [],
  pvtGeojson: [],
  skySamples: [],
  skyEpochIndex: null,
  satCounts: [],
  currentFilter: "all"
};

const els = {
  statusLine: document.getElementById("statusLine"),
  loadDefaults: document.getElementById("loadDefaults"),
  logFile: document.getElementById("logFile"),
  nmeaFile: document.getElementById("nmeaFile"),
  geojsonFile: document.getElementById("geojsonFile"),
  summaryGrid: document.getElementById("summaryGrid"),
  timelineCanvas: document.getElementById("timelineCanvas"),
  cn0Canvas: document.getElementById("cn0Canvas"),
  skyCanvas: document.getElementById("skyCanvas"),
  mapCanvas: document.getElementById("mapCanvas"),
  satCanvas: document.getElementById("satCanvas"),
  errorCanvas: document.getElementById("errorCanvas"),
  iqCanvas: document.getElementById("iqCanvas"),
  channelTable: document.querySelector("#channelTable tbody"),
  eventList: document.getElementById("eventList"),
  cn0Range: document.getElementById("cn0Range"),
  skySummary: document.getElementById("skySummary"),
  skyTimeSlider: document.getElementById("skyTimeSlider"),
  skyEpochLabel: document.getElementById("skyEpochLabel"),
  pvtOffset: document.getElementById("pvtOffset"),
  satCountSummary: document.getElementById("satCountSummary"),
  errorSummary: document.getElementById("errorSummary"),
  iqSummary: document.getElementById("iqSummary"),
  channelSummary: document.getElementById("channelSummary")
};

function stripAnsi(text) {
  return text.replace(/\x1B(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~])/g, "");
}

function fmtSeconds(value) {
  if (!Number.isFinite(value)) return "-";
  const seconds = Math.max(0, Math.round(value));
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return m > 0 ? `${m}m ${s}s` : `${s}s`;
}

function fmtTimeOfDay(value) {
  if (!Number.isFinite(value)) return "-";
  const wrapped = ((value % 86400) + 86400) % 86400;
  const hh = Math.floor(wrapped / 3600);
  const mm = Math.floor((wrapped % 3600) / 60);
  const ss = wrapped - hh * 3600 - mm * 60;
  return `${String(hh).padStart(2, "0")}:${String(mm).padStart(2, "0")}:${ss.toFixed(1).padStart(4, "0")}`;
}

function fmtNumber(value, digits = 2) {
  return Number.isFinite(value) ? value.toFixed(digits) : "-";
}

function fmtMeters(value) {
  if (!Number.isFinite(value)) return "-";
  const abs = Math.abs(value);
  if (abs >= 100000) return `${(value / 1000).toFixed(0)} km`;
  if (abs >= 1000) return `${(value / 1000).toFixed(1)} km`;
  return `${value.toFixed(0)} m`;
}

function fmtRatio(value) {
  return Number.isFinite(value) ? value.toFixed(2) : "-";
}

function utcSecondsFromText(text) {
  const match = String(text || "").match(/(\d{2}):(\d{2}):(\d{2}(?:\.\d+)?)/);
  if (!match) return NaN;
  return Number(match[1]) * 3600 + Number(match[2]) * 60 + Number(match[3]);
}

function emptyIqStats(stage = "all") {
  return {
    stage,
    samples: 0,
    sumAbsI: 0,
    sumAbsQ: 0,
    sumPowerI: 0,
    sumPowerQ: 0,
    maxAbsI: 0,
    maxAbsQ: 0
  };
}

function channelRecord(channel) {
  const key = String(channel);
  if (!state.channels.has(key)) {
    state.channels.set(key, {
      channel: Number(channel),
      prn: null,
      startTime: null,
      bitLockTime: null,
      navCount: 0,
      subframes: new Set(),
      cn0: [],
      iq: {
        tracking_emit_symbol: emptyIqStats("tracking_emit_symbol"),
        tracking_post_lock_ms: emptyIqStats("tracking_post_lock_ms"),
        tracking_prompt_1ms: emptyIqStats("tracking_prompt_1ms"),
        all: emptyIqStats("all")
      },
      losses: 0,
      events: []
    });
  }
  return state.channels.get(key);
}

function updateIqStats(stats, promptI, promptQ) {
  const absI = Math.abs(promptI);
  const absQ = Math.abs(promptQ);
  stats.samples += 1;
  stats.sumAbsI += absI;
  stats.sumAbsQ += absQ;
  stats.sumPowerI += promptI * promptI;
  stats.sumPowerQ += promptQ * promptQ;
  stats.maxAbsI = Math.max(stats.maxAbsI, absI);
  stats.maxAbsQ = Math.max(stats.maxAbsQ, absQ);
}

function mergeIqStats(target, source) {
  const samples = Number(source.samples || source.n || 0);
  if (!samples) return;
  target.samples += samples;
  target.sumAbsI += Number(source.sumAbsI || source.ai || 0);
  target.sumAbsQ += Number(source.sumAbsQ || source.aq || 0);
  target.sumPowerI += Number(source.sumPowerI || source.pi || 0);
  target.sumPowerQ += Number(source.sumPowerQ || source.pq || 0);
  target.maxAbsI = Math.max(target.maxAbsI, Number(source.maxAbsI || 0));
  target.maxAbsQ = Math.max(target.maxAbsQ, Number(source.maxAbsQ || 0));
}

function recordIqSample(channelNumber, prn, stage, promptI, promptQ) {
  if (!Number.isFinite(channelNumber) || !Number.isFinite(promptI) || !Number.isFinite(promptQ)) return;
  const channel = channelRecord(channelNumber);
  if (Number.isFinite(prn)) channel.prn = prn;
  if (!channel.iq[stage]) channel.iq[stage] = emptyIqStats(stage);
  updateIqStats(channel.iq[stage], promptI, promptQ);
  updateIqStats(channel.iq.all, promptI, promptQ);
}

function recordIqAggregate(channelNumber, prn, stage, stats) {
  if (!Number.isFinite(channelNumber) || !stats || stage === "all") return;
  const channel = channelRecord(channelNumber);
  if (Number.isFinite(prn)) channel.prn = prn;
  if (!channel.iq[stage]) channel.iq[stage] = emptyIqStats(stage);
  mergeIqStats(channel.iq[stage], stats);
  mergeIqStats(channel.iq.all, stats);
}

function iqSummaryFromStats(stats) {
  if (!stats || !stats.samples) return null;
  const meanAbsI = stats.sumAbsI / stats.samples;
  const meanAbsQ = stats.sumAbsQ / stats.samples;
  const rmsI = Math.sqrt(stats.sumPowerI / stats.samples);
  const rmsQ = Math.sqrt(stats.sumPowerQ / stats.samples);
  const ratio = meanAbsI > 0 ? meanAbsQ / meanAbsI : Number.POSITIVE_INFINITY;
  const qFraction = meanAbsI + meanAbsQ > 0 ? meanAbsQ / (meanAbsI + meanAbsQ) : 0.5;
  const dominance = ratio >= 1.25 ? "Q" : ratio <= 0.8 ? "I" : "mixed";
  return {
    stage: stats.stage,
    samples: stats.samples,
    meanAbsI,
    meanAbsQ,
    rmsI,
    rmsQ,
    ratio,
    qFraction,
    dominance
  };
}

function bestIqSummary(channel) {
  if (!channel || !channel.iq) return null;
  const stages = ["tracking_emit_symbol", "tracking_post_lock_ms", "tracking_prompt_1ms", "all"];
  for (const stage of stages) {
    const summary = iqSummaryFromStats(channel.iq[stage]);
    if (summary) return summary;
  }
  return null;
}

function iqStageLabel(stage) {
  if (stage === "tracking_emit_symbol") return "telemetry prompt";
  if (stage === "tracking_post_lock_ms") return "post-lock 1 ms";
  if (stage === "tracking_prompt_1ms") return "pre-lock 1 ms";
  return "all prompt";
}

function parseDiagFields(line) {
  const fields = {};
  for (const match of line.matchAll(/([A-Za-z0-9_]+)=([^\s]+)/g)) {
    fields[match[1]] = match[2];
  }
  return fields;
}

function addEvent(event) {
  state.events.push(event);
  if (event.channel !== undefined && event.channel !== null) {
    const channel = channelRecord(event.channel);
    channel.events.push(event);
  }
}

function receiverSecondsFromLine(line) {
  const minMatch = line.match(/Current receiver time:\s*(\d+)\s*min\s*(\d+)\s*s/);
  if (minMatch) return Number(minMatch[1]) * 60 + Number(minMatch[2]);
  const secMatch = line.match(/Current receiver time:\s*(\d+)\s*s/);
  if (secMatch) return Number(secMatch[1]);
  return null;
}

function parseLog(text) {
  let currentSec = 0;
  const clean = stripAnsi(text);
  const lines = clean.split(/\r?\n/);

  for (const line of lines) {
    if (!line.trim()) continue;
    const receiverSec = receiverSecondsFromLine(line);
    if (receiverSec !== null) {
      currentSec = receiverSec;
      continue;
    }

    if (line.includes("MARS_SYNC_DIAG") && line.includes("prompt_i=") && line.includes("prompt_q=")) {
      const fields = parseDiagFields(line);
      const stage = fields.stage;
      const supportedStage =
        stage === "tracking_emit_symbol" ||
        stage === "tracking_post_lock_ms" ||
        stage === "tracking_prompt_1ms";
      if (supportedStage) {
        recordIqSample(
          Number(fields.channel),
          Number(fields.prn),
          stage,
          Number(fields.prompt_i),
          Number(fields.prompt_q)
        );
      }
      continue;
    }

    let match = line.match(/Tracking of GPS L1 C\/A signal started on channel\s+(\d+)\s+for satellite GPS PRN\s+(\d+)/);
    if (match) {
      const channel = channelRecord(match[1]);
      channel.prn = Number(match[2]);
      channel.startTime = channel.startTime ?? currentSec;
      addEvent({
        type: "start",
        time: currentSec,
        channel: Number(match[1]),
        prn: Number(match[2]),
        label: `Channel ${match[1]} PRN ${Number(match[2])}`,
        raw: line
      });
      continue;
    }

    match = line.match(/tracking bit synchronization locked in channel\s+(\d+)\s+for satellite GPS PRN\s+(\d+)/i);
    if (match) {
      const channel = channelRecord(match[1]);
      channel.prn = Number(match[2]);
      channel.bitLockTime = channel.bitLockTime ?? currentSec;
      addEvent({
        type: "lock",
        time: currentSec,
        channel: Number(match[1]),
        prn: Number(match[2]),
        label: `Channel ${match[1]} PRN ${Number(match[2])}`,
        raw: line
      });
      continue;
    }

    match = line.match(/New GPS NAV message received in channel\s+(\d+):\s+subframe\s+(\d+)\s+from satellite GPS PRN\s+(\d+).*CN0=([0-9.]+)/);
    if (match) {
      const channel = channelRecord(match[1]);
      const cn0 = Number(match[4]);
      channel.prn = Number(match[3]);
      channel.navCount += 1;
      channel.subframes.add(Number(match[2]));
      channel.cn0.push({ time: currentSec, value: cn0, prn: Number(match[3]) });
      const event = {
        type: "nav",
        time: currentSec,
        channel: Number(match[1]),
        prn: Number(match[3]),
        subframe: Number(match[2]),
        cn0,
        label: `Channel ${match[1]} PRN ${Number(match[3])} subframe ${match[2]} CN0 ${cn0}`,
        raw: line
      };
      state.navMessages.push(event);
      addEvent(event);
      continue;
    }

    match = line.match(/Loss of lock in channel\s+(\d+)/);
    if (match) {
      const channel = channelRecord(match[1]);
      channel.losses += 1;
      addEvent({
        type: "loss",
        time: currentSec,
        channel: Number(match[1]),
        prn: channel.prn,
        label: `Channel ${match[1]}`,
        raw: line
      });
      continue;
    }

    match = line.match(/\[PVT_MARS\]\s+t_ms=(\d+).*count=(\d+).*stored=(\d+)/);
    if (match) {
      const point = {
        type: "diag",
        time: Number(match[1]) / 1000,
        rawCount: Number(match[2]),
        storedCount: Number(match[3]),
        raw: line
      };
      state.diagnostics.push(point);
      state.satCounts.push({
        source: "observables",
        time: point.time,
        count: point.storedCount
      });
      continue;
    }

    match = line.match(/First position fix at\s+(.+?)\s+is Lat =\s+([-0-9.eE+]+)\s+\[deg\], Long =\s+([-0-9.eE+]+)\s+\[deg\], Height=\s+([-0-9.eE+]+)/);
    if (match) {
      const point = {
        type: "pvt",
        fixType: "first",
        time: currentSec,
        utc: match[1],
        utcSeconds: utcSecondsFromText(match[1]),
        lat: Number(match[2]),
        lon: Number(match[3]),
        height: Number(match[4]),
        observations: null
      };
      state.pvtLog.push(point);
      addEvent({
        type: "pvt",
        time: currentSec,
        label: `First fix ${fmtNumber(point.lat, 6)}, ${fmtNumber(point.lon, 6)}`,
        raw: line
      });
      continue;
    }

    match = line.match(/Position at\s+(.+?)\s+using\s+(\d+)\s+observations is Lat =\s+([-0-9.eE+]+)\s+\[deg\], Long =\s+([-0-9.eE+]+)\s+\[deg\], Height =\s+([-0-9.eE+]+)/);
    if (match) {
      const point = {
        type: "pvt",
        fixType: "solution",
        time: currentSec,
        utc: match[1],
        utcSeconds: utcSecondsFromText(match[1]),
        observations: Number(match[2]),
        lat: Number(match[3]),
        lon: Number(match[4]),
        height: Number(match[5])
      };
      state.pvtLog.push(point);
      state.satCounts.push({
        source: "pvt",
        time: currentSec,
        count: point.observations
      });
      addEvent({
        type: "pvt",
        time: currentSec,
        observations: point.observations,
        label: `${point.observations} obs ${fmtNumber(point.lat, 6)}, ${fmtNumber(point.lon, 6)}`,
        raw: line
      });
    }
  }
}

function parseIqSummary(text) {
  if (!text.trim()) return;
  try {
    const data = JSON.parse(text);
    const channels = Array.isArray(data.channels) ? data.channels : [];
    channels.forEach((entry) => {
      const channelNumber = Number(entry.channel);
      const prn = Number(entry.prn);
      const stages = entry.stages || {};
      Object.entries(stages).forEach(([stage, stats]) => {
        if (
          stage === "tracking_emit_symbol" ||
          stage === "tracking_post_lock_ms" ||
          stage === "tracking_prompt_1ms"
        ) {
          recordIqAggregate(channelNumber, prn, stage, stats);
        }
      });
    });
  } catch (error) {
    console.warn("I/Q summary parse failed", error);
  }
}

function nmeaCoord(value, hemi) {
  if (!value) return NaN;
  const dot = value.indexOf(".");
  const degWidth = dot > 4 ? 3 : 2;
  const deg = Number(value.slice(0, degWidth));
  const min = Number(value.slice(degWidth));
  let out = deg + min / 60;
  if (hemi === "S" || hemi === "W") out *= -1;
  return out;
}

function timeOfDaySeconds(value) {
  if (!value || value.length < 6) return NaN;
  const hh = Number(value.slice(0, 2));
  const mm = Number(value.slice(2, 4));
  const ss = Number(value.slice(4));
  return hh * 3600 + mm * 60 + ss;
}

function nmeaEpochKey(time, fallback) {
  return Number.isFinite(time) ? time.toFixed(3) : fallback;
}

function parseNmea(text) {
  const lines = text.split(/\r?\n/);
  let firstSec = null;
  let currentTime = NaN;
  let currentUtcSeconds = NaN;
  let untimedEpoch = -1;
  let currentUntimedKey = "epoch-0";
  const skyByKey = new Map();
  const usedByKey = new Map();

  for (const line of lines) {
    if (!line.startsWith("$")) continue;
    const star = line.indexOf("*");
    const body = star >= 0 ? line.slice(0, star) : line;
    const fields = body.split(",");
    const type = fields[0].slice(-3);

    if (type === "GGA") {
      const tod = timeOfDaySeconds(fields[1]);
      if (firstSec === null && Number.isFinite(tod)) firstSec = tod;
      const point = {
        source: "nmea",
        time: Number.isFinite(tod) && firstSec !== null ? tod - firstSec : state.pvtNmea.length,
        utcSeconds: tod,
        lat: nmeaCoord(fields[2], fields[3]),
        lon: nmeaCoord(fields[4], fields[5]),
        quality: Number(fields[6]),
        satellites: Number(fields[7]),
        hdop: Number(fields[8]),
        height: Number(fields[9])
      };
      if (Number.isFinite(point.lat) && Number.isFinite(point.lon)) {
        state.pvtNmea.push(point);
        state.satCounts.push({
          source: "nmea",
          time: point.time,
          count: point.satellites
        });
      }
      currentTime = point.time;
      currentUtcSeconds = tod;
    }

    if (type === "GSA") {
      const key = nmeaEpochKey(currentTime, currentUntimedKey);
      const usedPrns = new Set(
        fields
          .slice(3, 15)
          .map((value) => Number(value))
          .filter((value) => Number.isFinite(value) && value > 0)
      );
      usedByKey.set(key, usedPrns);
      const epoch = skyByKey.get(key);
      if (epoch) epoch.usedPrns = usedPrns;
    }

    if (type === "GSV") {
      const messageNumber = Number(fields[2]);
      const total = Number(fields[3]);
      if (!Number.isFinite(currentTime) && messageNumber === 1) {
        untimedEpoch += 1;
        currentUntimedKey = `epoch-${untimedEpoch}`;
      }
      const key = nmeaEpochKey(currentTime, currentUntimedKey);
      if (!skyByKey.has(key)) {
        skyByKey.set(key, {
          source: "nmea",
          time: Number.isFinite(currentTime) ? currentTime : skyByKey.size,
          utcSeconds: currentUtcSeconds,
          totalVisible: Number.isFinite(total) ? total : 0,
          usedPrns: usedByKey.get(key) || new Set(),
          satellites: []
        });
      }
      const epoch = skyByKey.get(key);
      if (Number.isFinite(total)) epoch.totalVisible = Math.max(epoch.totalVisible || 0, total);

      for (let i = 4; i < fields.length - 3; i += 4) {
        const prnText = (fields[i] || "").trim();
        const elevationText = (fields[i + 1] || "").trim();
        const azimuthText = (fields[i + 2] || "").trim();
        const cn0Text = (fields[i + 3] || "").trim();
        if (!prnText || !elevationText || !azimuthText) continue;
        const prn = Number(prnText);
        const elevation = Number(elevationText);
        const azimuth = Number(azimuthText);
        const cn0 = cn0Text ? Number(cn0Text) : NaN;
        if (Number.isFinite(prn) && Number.isFinite(elevation) && Number.isFinite(azimuth)) {
          const sample = {
            prn,
            elevation,
            azimuth,
            cn0: Number.isFinite(cn0) ? cn0 : null
          };
          const existing = epoch.satellites.find((sat) => sat.prn === prn);
          if (existing) Object.assign(existing, sample);
          else epoch.satellites.push(sample);
        }
        if (Number.isFinite(prn) && Number.isFinite(cn0)) {
          state.navMessages.push({
            type: "nav",
            source: "nmea",
            time: Number.isFinite(currentTime) ? currentTime : skyByKey.size,
            prn,
            cn0,
            elevation,
            azimuth,
            label: `PRN ${prn} CN0 ${cn0}`,
            totalVisible: total
          });
        }
      }
    }
  }

  state.skySamples = [...skyByKey.values()]
    .filter((epoch) => epoch.satellites.length > 0)
    .map((epoch) => ({
      ...epoch,
      satellites: epoch.satellites.sort((a, b) => a.azimuth - b.azimuth)
    }))
    .sort((a, b) => a.time - b.time);
}

function parseGeojson(text) {
  if (!text.trim()) return;
  try {
    const data = JSON.parse(text);
    const coords = data.geometry && data.geometry.coordinates;
    if (!Array.isArray(coords)) return;
    const points = data.geometry.type === "MultiPoint" ? coords : [coords];
    state.pvtGeojson = points
      .filter((p) => Array.isArray(p) && p.length >= 2)
      .map((p, index) => ({
        source: "geojson",
        time: index,
        lon: Number(p[0]),
        lat: Number(p[1]),
        height: Number(p[2] || 0)
      }))
      .filter((p) => Number.isFinite(p.lat) && Number.isFinite(p.lon));
  } catch (error) {
    console.warn("GeoJSON parse failed", error);
  }
}

function resetParsed() {
  state.events = [];
  state.channels = new Map();
  state.navMessages = [];
  state.diagnostics = [];
  state.pvtLog = [];
  state.pvtNmea = [];
  state.pvtGeojson = [];
  state.skySamples = [];
  state.skyEpochIndex = null;
  state.satCounts = [];
}

function parseAll() {
  resetParsed();
  if (state.raw.log) parseLog(state.raw.log);
  if (state.raw.iq) parseIqSummary(state.raw.iq);
  if (state.raw.nmea) parseNmea(state.raw.nmea);
  if (state.raw.geojson) parseGeojson(state.raw.geojson);
  state.events.sort((a, b) => (a.time ?? 0) - (b.time ?? 0));
  renderAll();
}

function activePvtPoints() {
  if (state.pvtNmea.length > 0) return state.pvtNmea;
  if (state.pvtLog.length > 0) return state.pvtLog;
  return state.pvtGeojson;
}

function pvtStats(points) {
  if (!points.length) return null;
  const meanLat = points.reduce((sum, point) => sum + point.lat, 0) / points.length;
  const meanLon = points.reduce((sum, point) => sum + point.lon, 0) / points.length;
  const east = meanLon * DEG_TO_RAD * MARS_RADIUS_M * Math.cos(meanLat * DEG_TO_RAD);
  const north = meanLat * DEG_TO_RAD * MARS_RADIUS_M;
  const radial = Math.hypot(east, north);
  return { meanLat, meanLon, east, north, radial };
}

function marsGeodeticToCartesian(latDeg, lonDeg, heightM = 0) {
  const lat = latDeg * DEG_TO_RAD;
  const lon = lonDeg * DEG_TO_RAD;
  const height = Number.isFinite(heightM) ? heightM : 0;
  const e2 = MARS_FLATTENING * (2 - MARS_FLATTENING);
  const sinLat = Math.sin(lat);
  const cosLat = Math.cos(lat);
  const primeVertical = MARS_EQUATORIAL_RADIUS_M / Math.sqrt(1 - e2 * sinLat * sinLat);
  return {
    x: (primeVertical + height) * cosLat * Math.cos(lon),
    y: (primeVertical + height) * cosLat * Math.sin(lon),
    z: (primeVertical * (1 - e2) + height) * sinLat
  };
}

function truthLabel() {
  return `truth ${fmtNumber(TRUTH_POSITION.lat, 6)}, ${fmtNumber(TRUTH_POSITION.lon, 6)}, h ${fmtNumber(TRUTH_POSITION.height, 0)} m`;
}

function pvtErrorSeries(points = activePvtPoints()) {
  const truth = marsGeodeticToCartesian(TRUTH_POSITION.lat, TRUTH_POSITION.lon, TRUTH_POSITION.height);
  return points
    .map((point, index) => {
      const height = Number.isFinite(point.height) ? point.height : 0;
      const position = marsGeodeticToCartesian(point.lat, point.lon, height);
      const east = (point.lon - TRUTH_POSITION.lon) * DEG_TO_RAD * MARS_EQUATORIAL_RADIUS_M * Math.cos(TRUTH_POSITION.lat * DEG_TO_RAD);
      const north = (point.lat - TRUTH_POSITION.lat) * DEG_TO_RAD * MARS_EQUATORIAL_RADIUS_M;
      const up = height - TRUTH_POSITION.height;
      const dx = position.x - truth.x;
      const dy = position.y - truth.y;
      const dz = position.z - truth.z;
      const simTime = Number.isFinite(point.utcSeconds)
        ? point.utcSeconds
        : Number.isFinite(point.time)
          ? point.time
          : index;
      return {
        point,
        simTime,
        timeIsTod: Number.isFinite(point.utcSeconds),
        east,
        north,
        up,
        horizontal: Math.hypot(east, north),
        error3d: Math.hypot(dx, dy, dz)
      };
    })
    .filter((sample) => Number.isFinite(sample.simTime) && Number.isFinite(sample.error3d));
}

function pvtErrorStats(points = activePvtPoints()) {
  const samples = pvtErrorSeries(points);
  if (!samples.length) return null;
  const rms = Math.sqrt(samples.reduce((sum, sample) => sum + sample.error3d ** 2, 0) / samples.length);
  const max = Math.max(...samples.map((sample) => sample.error3d));
  const final = samples[samples.length - 1].error3d;
  return { samples, rms, max, final };
}

function niceLimit(value) {
  if (!Number.isFinite(value) || value <= 0) return 1;
  const exponent = Math.floor(Math.log10(value));
  const base = 10 ** exponent;
  const scaled = value / base;
  const nice = scaled <= 1 ? 1 : scaled <= 2 ? 2 : scaled <= 5 ? 5 : 10;
  return nice * base;
}

function renderSummary() {
  const points = activePvtPoints();
  const errorStats = pvtErrorStats(points);
  const firstFix = state.pvtLog.find((point) => point.fixType === "first") || points[0];
  const maxObs = Math.max(0, ...state.satCounts.map((point) => point.count || 0));
  const maxCn0 = Math.max(0, ...state.navMessages.map((event) => event.cn0 || 0));
  const channels = [...state.channels.values()].length;
  const navCount = state.navMessages.filter((event) => event.source !== "nmea").length;

  const metrics = [
    {
      label: "Channels",
      value: channels || "-",
      note: `${state.events.filter((event) => event.type === "start").length} starts`
    },
    {
      label: "Bit Locks",
      value: state.events.filter((event) => event.type === "lock").length || "-",
      note: `${state.events.filter((event) => event.type === "loss").length} lock losses`
    },
    {
      label: "NAV Frames",
      value: navCount || "-",
      note: maxCn0 ? `Peak CN0 ${fmtNumber(maxCn0, 1)} dB-Hz` : "No CN0"
    },
    {
      label: "First Fix",
      value: firstFix ? fmtSeconds(firstFix.time) : "-",
      note: firstFix && firstFix.utc ? firstFix.utc : "No fix"
    },
    {
      label: "PVT Points",
      value: points.length || "-",
      note: maxObs ? `${maxObs} max observations` : "No solution"
    },
    {
      label: "3D Error",
      value: errorStats ? fmtMeters(errorStats.rms) : "-",
      note: errorStats ? `final ${fmtMeters(errorStats.final)}` : "No trajectory"
    }
  ];

  els.summaryGrid.innerHTML = metrics
    .map((metric) => `
      <article class="metric">
        <div class="label">${metric.label}</div>
        <div class="value">${metric.value}</div>
        <div class="note">${metric.note}</div>
      </article>
    `)
    .join("");
}

function resizeCanvas(canvas) {
  const ratio = window.devicePixelRatio || 1;
  const rect = canvas.getBoundingClientRect();
  const width = Math.max(320, Math.floor(rect.width));
  const height = Math.max(220, Math.floor(rect.height));
  canvas.width = Math.floor(width * ratio);
  canvas.height = Math.floor(height * ratio);
  const ctx = canvas.getContext("2d");
  ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
  return { ctx, width, height };
}

function drawEmpty(canvas, message) {
  const { ctx, width, height } = resizeCanvas(canvas);
  ctx.clearRect(0, 0, width, height);
  ctx.fillStyle = "#fbfcfd";
  ctx.fillRect(0, 0, width, height);
  ctx.strokeStyle = COLORS.grid;
  ctx.strokeRect(0.5, 0.5, width - 1, height - 1);
  ctx.fillStyle = COLORS.muted;
  ctx.font = "13px system-ui, sans-serif";
  ctx.textAlign = "center";
  ctx.fillText(message, width / 2, height / 2);
}

function drawAxes(ctx, width, height, left, top, right, bottom, xLabel, yLabel) {
  ctx.strokeStyle = COLORS.grid;
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(left, top);
  ctx.lineTo(left, height - bottom);
  ctx.lineTo(width - right, height - bottom);
  ctx.stroke();
  ctx.fillStyle = COLORS.muted;
  ctx.font = "11px system-ui, sans-serif";
  ctx.textAlign = "right";
  if (yLabel) ctx.fillText(yLabel, left - 8, top + 4);
  ctx.textAlign = "right";
  if (xLabel) ctx.fillText(xLabel, width - right, height - bottom + 18);
}

function renderTimeline() {
  const channels = [...state.channels.values()].sort((a, b) => a.channel - b.channel);
  const timelineEvents = state.events.filter((event) => Number.isFinite(event.time));
  if (!channels.length && !timelineEvents.length) {
    drawEmpty(els.timelineCanvas, "Load a receiver log");
    return;
  }

  const { ctx, width, height } = resizeCanvas(els.timelineCanvas);
  ctx.clearRect(0, 0, width, height);
  const left = 68;
  const right = 24;
  const top = 18;
  const bottom = 34;
  const pvtRowHeight = 34;
  const rowHeight = Math.max(24, (height - top - bottom - pvtRowHeight) / Math.max(1, channels.length));
  const maxTime = Math.max(1, ...timelineEvents.map((event) => event.time));
  const x = (time) => left + (time / maxTime) * (width - left - right);

  ctx.fillStyle = "#fbfcfd";
  ctx.fillRect(0, 0, width, height);
  ctx.strokeStyle = COLORS.grid;
  ctx.lineWidth = 1;

  for (let i = 0; i <= 6; i++) {
    const gx = left + (i / 6) * (width - left - right);
    ctx.beginPath();
    ctx.moveTo(gx, top);
    ctx.lineTo(gx, height - bottom);
    ctx.stroke();
    ctx.fillStyle = COLORS.muted;
    ctx.font = "11px system-ui, sans-serif";
    ctx.textAlign = "center";
    ctx.fillText(fmtSeconds((i / 6) * maxTime), gx, height - 10);
  }

  channels.forEach((channel, index) => {
    const y = top + index * rowHeight + rowHeight / 2;
    ctx.strokeStyle = index % 2 ? "#edf2f4" : "#e3eaed";
    ctx.beginPath();
    ctx.moveTo(left, y);
    ctx.lineTo(width - right, y);
    ctx.stroke();
    ctx.fillStyle = COLORS.text;
    ctx.font = "12px system-ui, sans-serif";
    ctx.textAlign = "right";
    ctx.fillText(`Ch ${channel.channel}`, left - 10, y + 4);
    ctx.fillStyle = COLORS.muted;
    ctx.fillText(`P${channel.prn ?? "-"}`, left - 10, y + 18);
  });

  const channelY = (channelNumber) => {
    const index = channels.findIndex((channel) => channel.channel === channelNumber);
    return index >= 0 ? top + index * rowHeight + rowHeight / 2 : height - bottom - pvtRowHeight / 2;
  };

  for (const event of timelineEvents) {
    const px = x(event.time);
    const py = event.type === "pvt" ? height - bottom - 12 : channelY(event.channel);
    if (event.type === "start") {
      ctx.fillStyle = COLORS.start;
      ctx.fillRect(px - 4, py - 4, 8, 8);
    } else if (event.type === "lock") {
      ctx.fillStyle = COLORS.lock;
      ctx.beginPath();
      ctx.arc(px, py, 4.5, 0, Math.PI * 2);
      ctx.fill();
    } else if (event.type === "nav") {
      ctx.fillStyle = COLORS.nav;
      const r = Math.max(3, Math.min(7, (event.cn0 || 35) / 9));
      ctx.beginPath();
      ctx.arc(px, py, r, 0, Math.PI * 2);
      ctx.fill();
    } else if (event.type === "loss") {
      ctx.strokeStyle = COLORS.loss;
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(px - 5, py - 5);
      ctx.lineTo(px + 5, py + 5);
      ctx.moveTo(px + 5, py - 5);
      ctx.lineTo(px - 5, py + 5);
      ctx.stroke();
      ctx.lineWidth = 1;
    } else if (event.type === "pvt") {
      ctx.strokeStyle = COLORS.pvt;
      ctx.beginPath();
      ctx.moveTo(px, top);
      ctx.lineTo(px, height - bottom);
      ctx.stroke();
      ctx.fillStyle = COLORS.pvt;
      ctx.beginPath();
      ctx.arc(px, py, 4, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  ctx.fillStyle = COLORS.muted;
  ctx.font = "11px system-ui, sans-serif";
  ctx.textAlign = "right";
  ctx.fillText("PVT", left - 10, height - bottom - 8);
}

function renderCn0() {
  const messages = state.navMessages
    .filter((event) => Number.isFinite(event.cn0) && Number.isFinite(event.time))
    .sort((a, b) => a.time - b.time);

  if (!messages.length) {
    els.cn0Range.textContent = "";
    drawEmpty(els.cn0Canvas, "No CN0 messages");
    return;
  }

  const { ctx, width, height } = resizeCanvas(els.cn0Canvas);
  ctx.clearRect(0, 0, width, height);
  const left = 44;
  const right = 18;
  const top = 18;
  const bottom = 32;
  const maxTime = Math.max(1, ...messages.map((event) => event.time));
  const minCn0 = Math.min(...messages.map((event) => event.cn0), 30);
  const maxCn0 = Math.max(...messages.map((event) => event.cn0), 55);
  const x = (time) => left + (time / maxTime) * (width - left - right);
  const y = (value) => height - bottom - ((value - minCn0) / (maxCn0 - minCn0 || 1)) * (height - top - bottom);
  const prns = [...new Set(messages.map((event) => event.prn))].sort((a, b) => a - b);
  const palette = ["#2f6db5", "#c2472b", "#258552", "#b46c11", "#6b5cb8", "#156c7b", "#9d4d7d"];

  ctx.fillStyle = "#fbfcfd";
  ctx.fillRect(0, 0, width, height);
  drawAxes(ctx, width, height, left, top, right, bottom, "time", "CN0");

  ctx.strokeStyle = "#edf2f4";
  for (let i = 0; i <= 4; i++) {
    const gy = top + (i / 4) * (height - top - bottom);
    ctx.beginPath();
    ctx.moveTo(left, gy);
    ctx.lineTo(width - right, gy);
    ctx.stroke();
  }

  prns.forEach((prn, index) => {
    const series = messages.filter((event) => event.prn === prn);
    ctx.strokeStyle = palette[index % palette.length];
    ctx.lineWidth = 2;
    ctx.beginPath();
    series.forEach((event, pointIndex) => {
      const px = x(event.time);
      const py = y(event.cn0);
      if (pointIndex === 0) ctx.moveTo(px, py);
      else ctx.lineTo(px, py);
    });
    ctx.stroke();
    ctx.fillStyle = palette[index % palette.length];
    series.forEach((event) => {
      ctx.beginPath();
      ctx.arc(x(event.time), y(event.cn0), 3, 0, Math.PI * 2);
      ctx.fill();
    });
  });

  ctx.font = "11px system-ui, sans-serif";
  ctx.textAlign = "left";
  prns.slice(0, 8).forEach((prn, index) => {
    const lx = left + index * 54;
    ctx.fillStyle = palette[index % palette.length];
    ctx.fillRect(lx, 8, 10, 3);
    ctx.fillStyle = COLORS.muted;
    ctx.fillText(`PRN ${prn}`, lx + 14, 11);
  });

  els.cn0Range.textContent = `${fmtNumber(minCn0, 1)}-${fmtNumber(maxCn0, 1)} dB-Hz`;
}

function renderSkyPlot() {
  const samples = state.skySamples;
  if (!samples.length) {
    els.skySummary.textContent = "";
    els.skyEpochLabel.textContent = "";
    els.skyTimeSlider.disabled = true;
    els.skyTimeSlider.max = "0";
    els.skyTimeSlider.value = "0";
    drawEmpty(els.skyCanvas, "No NMEA GSV sky data");
    return;
  }

  const maxIndex = samples.length - 1;
  if (!Number.isInteger(state.skyEpochIndex)) state.skyEpochIndex = maxIndex;
  state.skyEpochIndex = Math.max(0, Math.min(maxIndex, state.skyEpochIndex));
  const epoch = samples[state.skyEpochIndex];
  const usedPrns = epoch.usedPrns instanceof Set ? epoch.usedPrns : new Set(epoch.usedPrns || []);

  els.skyTimeSlider.disabled = samples.length <= 1;
  els.skyTimeSlider.max = String(maxIndex);
  els.skyTimeSlider.value = String(state.skyEpochIndex);
  els.skySummary.textContent = `${epoch.satellites.length}/${epoch.totalVisible || epoch.satellites.length} visible`;
  els.skyEpochLabel.textContent = `${fmtSeconds(epoch.time)} | ${fmtTimeOfDay(epoch.utcSeconds)}`;

  const { ctx, width, height } = resizeCanvas(els.skyCanvas);
  ctx.clearRect(0, 0, width, height);
  ctx.fillStyle = "#fbfcfd";
  ctx.fillRect(0, 0, width, height);

  const cx = width / 2;
  const cy = height / 2 + 8;
  const radius = Math.max(80, Math.min(width, height) / 2 - 34);
  const ringElevations = [0, 30, 60];

  ctx.strokeStyle = COLORS.grid;
  ctx.lineWidth = 1;
  ringElevations.forEach((elevation) => {
    const r = ((90 - elevation) / 90) * radius;
    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, Math.PI * 2);
    ctx.stroke();
    ctx.fillStyle = COLORS.muted;
    ctx.font = "11px system-ui, sans-serif";
    ctx.textAlign = "left";
    ctx.fillText(`${elevation}`, cx + 6, cy - r + 12);
  });

  ctx.strokeStyle = "#e8eef1";
  [0, 45, 90, 135, 180, 225, 270, 315].forEach((azimuth) => {
    const rad = azimuth * Math.PI / 180;
    ctx.beginPath();
    ctx.moveTo(cx, cy);
    ctx.lineTo(cx + Math.sin(rad) * radius, cy - Math.cos(rad) * radius);
    ctx.stroke();
  });

  const cardinal = [
    ["N", 0, -1],
    ["E", 1, 0],
    ["S", 0, 1],
    ["W", -1, 0]
  ];
  ctx.fillStyle = COLORS.text;
  ctx.font = "12px system-ui, sans-serif";
  ctx.textAlign = "center";
  cardinal.forEach(([label, dx, dy]) => {
    ctx.fillText(label, cx + dx * (radius + 16), cy + dy * (radius + 16) + 4);
  });

  epoch.satellites.forEach((sat) => {
    const elevation = Math.max(0, Math.min(90, sat.elevation));
    const azimuthRad = sat.azimuth * Math.PI / 180;
    const r = ((90 - elevation) / 90) * radius;
    const x = cx + Math.sin(azimuthRad) * r;
    const y = cy - Math.cos(azimuthRad) * r;
    const cn0 = Number.isFinite(sat.cn0) ? sat.cn0 : 38;
    const size = Math.max(5, Math.min(10, 4 + (cn0 - 30) / 5));
    const used = usedPrns.has(sat.prn);

    ctx.fillStyle = used ? COLORS.pvt : COLORS.visible;
    ctx.strokeStyle = used ? "#ffffff" : "#f7fafb";
    ctx.lineWidth = used ? 2.5 : 1.5;
    ctx.beginPath();
    ctx.arc(x, y, size, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();

    ctx.fillStyle = COLORS.text;
    ctx.font = "11px system-ui, sans-serif";
    ctx.textAlign = "center";
    ctx.fillText(String(sat.prn).padStart(2, "0"), x, y - size - 5);
  });

  const usedCount = epoch.satellites.filter((sat) => usedPrns.has(sat.prn)).length;
  ctx.fillStyle = COLORS.muted;
  ctx.font = "11px system-ui, sans-serif";
  ctx.textAlign = "left";
  ctx.fillText("NMEA GSV", 12, height - 12);
  ctx.textAlign = "right";
  ctx.fillText(`GSA used ${usedCount}`, width - 12, height - 12);
}

function renderMap() {
  const points = activePvtPoints();
  if (!points.length) {
    els.pvtOffset.textContent = "";
    drawEmpty(els.mapCanvas, "No PVT positions");
    return;
  }

  const projected = points.map((point) => {
    const latRad = point.lat * Math.PI / 180;
    const lonRad = point.lon * Math.PI / 180;
    return {
      east: lonRad * MARS_RADIUS_M * Math.cos(latRad),
      north: latRad * MARS_RADIUS_M,
      point
    };
  });
  const stats = pvtStats(points);
  const maxExtent = Math.max(250, ...projected.map((p) => Math.max(Math.abs(p.east), Math.abs(p.north))));
  const padded = maxExtent * 1.18;

  const { ctx, width, height } = resizeCanvas(els.mapCanvas);
  ctx.clearRect(0, 0, width, height);
  const pad = 32;
  const plot = Math.min(width - pad * 2, height - pad * 2);
  const ox = width / 2;
  const oy = height / 2;
  const scale = plot / (padded * 2);
  const x = (east) => ox + east * scale;
  const y = (north) => oy - north * scale;

  ctx.fillStyle = "#fbfcfd";
  ctx.fillRect(0, 0, width, height);
  ctx.strokeStyle = "#edf2f4";
  ctx.lineWidth = 1;
  for (let i = -2; i <= 2; i++) {
    ctx.beginPath();
    ctx.moveTo(x(-padded), y(i * padded / 2));
    ctx.lineTo(x(padded), y(i * padded / 2));
    ctx.moveTo(x(i * padded / 2), y(-padded));
    ctx.lineTo(x(i * padded / 2), y(padded));
    ctx.stroke();
  }

  ctx.strokeStyle = COLORS.muted;
  ctx.beginPath();
  ctx.moveTo(x(-padded), y(0));
  ctx.lineTo(x(padded), y(0));
  ctx.moveTo(x(0), y(-padded));
  ctx.lineTo(x(0), y(padded));
  ctx.stroke();

  ctx.strokeStyle = COLORS.pvt;
  ctx.lineWidth = 2;
  ctx.beginPath();
  projected.forEach((p, index) => {
    if (index === 0) ctx.moveTo(x(p.east), y(p.north));
    else ctx.lineTo(x(p.east), y(p.north));
  });
  ctx.stroke();

  projected.forEach((p, index) => {
    ctx.fillStyle = index === 0 ? COLORS.firstFix : index === projected.length - 1 ? COLORS.finalFix : COLORS.pvt;
    ctx.beginPath();
    ctx.arc(x(p.east), y(p.north), index === 0 || index === projected.length - 1 ? 4.5 : 2.5, 0, Math.PI * 2);
    ctx.fill();
  });

  ctx.strokeStyle = COLORS.reference;
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(x(0) - 6, y(0));
  ctx.lineTo(x(0) + 6, y(0));
  ctx.moveTo(x(0), y(0) - 6);
  ctx.lineTo(x(0), y(0) + 6);
  ctx.stroke();

  ctx.fillStyle = COLORS.muted;
  ctx.font = "11px system-ui, sans-serif";
  ctx.textAlign = "left";
  const finalPoint = points[points.length - 1];
  const finalPositionLabel = `final lat ${fmtNumber(finalPoint.lat, 6)} deg, lon ${fmtNumber(finalPoint.lon, 6)} deg`;
  ctx.fillText(finalPositionLabel, 12, 14);
  ctx.fillText(`h ${fmtNumber(finalPoint.height, 1)} m`, 12, 28);
  ctx.fillText(`extent +/-${fmtNumber(padded, 0)} m`, 12, height - 12);
  els.pvtOffset.textContent = stats ? `${finalPositionLabel}, h ${fmtNumber(finalPoint.height, 1)} m` : "";
}

function renderError() {
  if (!els.errorCanvas) return;
  const samples = pvtErrorSeries();
  if (!samples.length) {
    if (els.errorSummary) els.errorSummary.textContent = "";
    drawEmpty(els.errorCanvas, "No PVT positions");
    return;
  }

  const stats = pvtErrorStats();
  if (els.errorSummary) {
    els.errorSummary.textContent = `RMS ${fmtMeters(stats.rms)} | max ${fmtMeters(stats.max)} | final ${fmtMeters(stats.final)}`;
  }

  const { ctx, width, height } = resizeCanvas(els.errorCanvas);
  ctx.clearRect(0, 0, width, height);
  const left = 64;
  const right = 22;
  const top = 20;
  const bottom = 44;
  const minTime = Math.min(...samples.map((sample) => sample.simTime));
  const maxTime = Math.max(...samples.map((sample) => sample.simTime));
  const span = maxTime - minTime || 1;
  const maxError = Math.max(...samples.map((sample) => sample.error3d));
  const yMax = niceLimit(maxError * 1.08);
  const useTimeOfDay = samples.some((sample) => sample.timeIsTod);
  const x = (time) => left + ((time - minTime) / span) * (width - left - right);
  const y = (value) => height - bottom - (value / yMax) * (height - top - bottom);

  ctx.fillStyle = "#fbfcfd";
  ctx.fillRect(0, 0, width, height);
  drawAxes(ctx, width, height, left, top, right, bottom, useTimeOfDay ? "simulation time" : "time", "3D error");

  for (let i = 0; i <= 4; i++) {
    const value = (i / 4) * yMax;
    const gy = y(value);
    ctx.strokeStyle = "#edf2f4";
    ctx.beginPath();
    ctx.moveTo(left, gy);
    ctx.lineTo(width - right, gy);
    ctx.stroke();
    ctx.fillStyle = COLORS.muted;
    ctx.font = "11px system-ui, sans-serif";
    ctx.textAlign = "right";
    ctx.fillText(fmtMeters(value), left - 8, gy + 4);
  }

  const xTickCount = width < 520 ? 2 : 4;
  for (let i = 0; i <= xTickCount; i++) {
    const time = minTime + (i / xTickCount) * span;
    const gx = x(time);
    ctx.strokeStyle = "#edf2f4";
    ctx.beginPath();
    ctx.moveTo(gx, top);
    ctx.lineTo(gx, height - bottom);
    ctx.stroke();
    ctx.fillStyle = COLORS.muted;
    ctx.font = "11px system-ui, sans-serif";
    ctx.textAlign = "center";
    ctx.fillText(useTimeOfDay ? fmtTimeOfDay(time) : fmtSeconds(time), gx, height - 12);
  }

  ctx.beginPath();
  samples.forEach((sample, index) => {
    const px = x(sample.simTime);
    const py = y(sample.error3d);
    if (index === 0) ctx.moveTo(px, py);
    else ctx.lineTo(px, py);
  });
  ctx.lineTo(x(samples[samples.length - 1].simTime), height - bottom);
  ctx.lineTo(x(samples[0].simTime), height - bottom);
  ctx.closePath();
  ctx.fillStyle = "rgba(194, 71, 43, 0.11)";
  ctx.fill();

  ctx.strokeStyle = COLORS.error;
  ctx.lineWidth = 2.25;
  ctx.beginPath();
  samples.forEach((sample, index) => {
    const px = x(sample.simTime);
    const py = y(sample.error3d);
    if (index === 0) ctx.moveTo(px, py);
    else ctx.lineTo(px, py);
  });
  ctx.stroke();

  const endpoints = [
    { sample: samples[0], color: COLORS.firstFix },
    { sample: samples[samples.length - 1], color: COLORS.finalFix }
  ];
  endpoints.forEach(({ sample, color }) => {
    ctx.fillStyle = color;
    ctx.strokeStyle = "#ffffff";
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.arc(x(sample.simTime), y(sample.error3d), 4.5, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
  });

  ctx.fillStyle = COLORS.muted;
  ctx.font = "11px system-ui, sans-serif";
  ctx.textAlign = "left";
  ctx.fillText(truthLabel(), left, 12);
}

function renderIqDominance() {
  if (!els.iqCanvas) return;
  const rows = [...state.channels.values()]
    .map((channel) => ({
      channel,
      summary: bestIqSummary(channel)
    }))
    .filter((row) => row.summary)
    .sort((a, b) => a.channel.channel - b.channel.channel);

  if (!rows.length) {
    if (els.iqSummary) els.iqSummary.textContent = "";
    drawEmpty(els.iqCanvas, "No prompt I/Q diagnostics in receiver log");
    return;
  }

  const counts = rows.reduce((acc, row) => {
    acc[row.summary.dominance] = (acc[row.summary.dominance] || 0) + 1;
    return acc;
  }, {});
  const stageCounts = rows.reduce((acc, row) => {
    acc[row.summary.stage] = (acc[row.summary.stage] || 0) + 1;
    return acc;
  }, {});
  const primaryStage = Object.entries(stageCounts).sort((a, b) => b[1] - a[1])[0]?.[0] || "all";
  if (els.iqSummary) {
    els.iqSummary.textContent = `${counts.I || 0} I | ${counts.Q || 0} Q | ${counts.mixed || 0} mixed, ${iqStageLabel(primaryStage)}`;
  }

  const { ctx, width, height } = resizeCanvas(els.iqCanvas);
  ctx.clearRect(0, 0, width, height);
  ctx.fillStyle = "#fbfcfd";
  ctx.fillRect(0, 0, width, height);

  const left = 86;
  const right = 126;
  const top = 28;
  const bottom = 30;
  const plotWidth = width - left - right;
  const rowHeight = Math.max(24, Math.min(42, (height - top - bottom) / rows.length));
  const barHeight = Math.max(12, Math.min(18, rowHeight * 0.52));

  ctx.fillStyle = COLORS.muted;
  ctx.font = "11px system-ui, sans-serif";
  ctx.textAlign = "left";
  ctx.fillText("|I| share", left, 14);
  ctx.textAlign = "right";
  ctx.fillText("|Q| share", left + plotWidth, 14);
  ctx.textAlign = "center";
  ctx.fillText("balanced", left + plotWidth / 2, 14);

  ctx.strokeStyle = COLORS.grid;
  ctx.beginPath();
  ctx.moveTo(left + plotWidth / 2, top - 6);
  ctx.lineTo(left + plotWidth / 2, height - bottom + 4);
  ctx.stroke();

  rows.forEach(({ channel, summary }, index) => {
    const y = top + index * rowHeight + rowHeight / 2;
    const barY = y - barHeight / 2;
    const qWidth = plotWidth * summary.qFraction;
    const iWidth = plotWidth - qWidth;

    ctx.fillStyle = index % 2 ? "#f8fafb" : "#ffffff";
    ctx.fillRect(0, top + index * rowHeight, width, rowHeight);

    ctx.fillStyle = COLORS.text;
    ctx.font = "12px system-ui, sans-serif";
    ctx.textAlign = "right";
    ctx.fillText(`Ch ${channel.channel}`, left - 12, y - 2);
    ctx.fillStyle = COLORS.muted;
    ctx.fillText(`P${channel.prn ?? "-"}`, left - 12, y + 12);

    ctx.fillStyle = "rgba(47, 109, 181, 0.18)";
    ctx.fillRect(left, barY, iWidth, barHeight);
    ctx.fillStyle = "rgba(194, 71, 43, 0.18)";
    ctx.fillRect(left + iWidth, barY, qWidth, barHeight);

    ctx.fillStyle = COLORS.iAxis;
    ctx.fillRect(left, barY, iWidth, barHeight);
    ctx.fillStyle = COLORS.qAxis;
    ctx.fillRect(left + iWidth, barY, qWidth, barHeight);

    ctx.strokeStyle = "#ffffff";
    ctx.lineWidth = 1.5;
    ctx.strokeRect(left, barY, plotWidth, barHeight);
    ctx.lineWidth = 1;

    const dominanceColor =
      summary.dominance === "I" ? COLORS.iAxis :
        summary.dominance === "Q" ? COLORS.qAxis :
          COLORS.mixed;
    ctx.fillStyle = dominanceColor;
    ctx.font = "700 12px system-ui, sans-serif";
    ctx.textAlign = "left";
    ctx.fillText(`${summary.dominance}-dom`, left + plotWidth + 14, y - 3);
    ctx.fillStyle = COLORS.muted;
    ctx.font = "11px system-ui, sans-serif";
    ctx.fillText(`Q/I ${fmtRatio(summary.ratio)} | ${summary.samples}`, left + plotWidth + 14, y + 11);
  });

  ctx.fillStyle = COLORS.muted;
  ctx.font = "11px system-ui, sans-serif";
  ctx.textAlign = "left";
  ctx.fillText("classification uses mean absolute prompt values", left, height - 8);
}

function renderSatCounts() {
  const counts = state.satCounts
    .filter((point) => Number.isFinite(point.time) && Number.isFinite(point.count))
    .sort((a, b) => a.time - b.time);

  if (!counts.length) {
    els.satCountSummary.textContent = "";
    drawEmpty(els.satCanvas, "No fix observability samples");
    return;
  }

  const { ctx, width, height } = resizeCanvas(els.satCanvas);
  ctx.clearRect(0, 0, width, height);
  const left = 38;
  const right = 18;
  const top = 18;
  const bottom = 32;
  const maxTime = Math.max(1, ...counts.map((point) => point.time));
  const maxCount = Math.max(4, ...counts.map((point) => point.count));
  const x = (time) => left + (time / maxTime) * (width - left - right);
  const y = (value) => height - bottom - (value / maxCount) * (height - top - bottom);

  ctx.fillStyle = "#fbfcfd";
  ctx.fillRect(0, 0, width, height);
  drawAxes(ctx, width, height, left, top, right, bottom, "time", "sats");

  for (let i = 1; i <= maxCount; i++) {
    ctx.strokeStyle = i === 3 ? "rgba(37, 133, 82, 0.45)" : "#edf2f4";
    ctx.beginPath();
    ctx.moveTo(left, y(i));
    ctx.lineTo(width - right, y(i));
    ctx.stroke();
    ctx.fillStyle = COLORS.muted;
    ctx.font = "11px system-ui, sans-serif";
    ctx.textAlign = "right";
    ctx.fillText(String(i), left - 8, y(i) + 4);
  }

  const groups = ["observables", "pvt", "nmea"];
  const palette = { observables: COLORS.start, pvt: COLORS.pvt, nmea: COLORS.nmea };
  groups.forEach((group) => {
    const series = counts.filter((point) => point.source === group);
    if (!series.length) return;
    ctx.strokeStyle = palette[group];
    ctx.lineWidth = 2;
    ctx.beginPath();
    series.forEach((point, index) => {
      const px = x(point.time);
      const py = y(point.count);
      if (index === 0) ctx.moveTo(px, py);
      else ctx.lineTo(px, py);
    });
    ctx.stroke();
  });

  els.satCountSummary.textContent = `max ${Math.max(...counts.map((point) => point.count))}`;
}

function renderChannelTable() {
  const channels = [...state.channels.values()].sort((a, b) => a.channel - b.channel);
  els.channelSummary.textContent = channels.length ? `${channels.length} channels` : "";
  if (!channels.length) {
    els.channelTable.innerHTML = `<tr><td colspan="9" class="muted">No channels parsed</td></tr>`;
    return;
  }
  els.channelTable.innerHTML = channels
    .map((channel) => {
      const cn0Values = channel.cn0.map((sample) => sample.value);
      const cn0Text = cn0Values.length ? `${fmtNumber(Math.max(...cn0Values), 1)}` : "-";
      const iq = bestIqSummary(channel);
      const iqText = iq ? `${iq.dominance}` : "-";
      const iqRatio = iq ? fmtRatio(iq.ratio) : "-";
      return `
        <tr>
          <td>${channel.channel}</td>
          <td>${channel.prn ?? "-"}</td>
          <td>${fmtSeconds(channel.startTime)}</td>
          <td>${fmtSeconds(channel.bitLockTime)}</td>
          <td>${channel.navCount || "-"}</td>
          <td>${cn0Text}</td>
          <td>${iqText}</td>
          <td>${iqRatio}</td>
          <td>${channel.losses || "-"}</td>
        </tr>
      `;
    })
    .join("");
}

function renderEvents() {
  const filter = state.currentFilter;
  const events = state.events
    .filter((event) => filter === "all" || event.type === filter)
    .slice(-220)
    .reverse();

  if (!events.length) {
    els.eventList.innerHTML = `<div class="empty">No events parsed</div>`;
    return;
  }

  els.eventList.innerHTML = events
    .map((event) => `
      <article class="event">
        <div class="time">${fmtSeconds(event.time)}</div>
        <div class="stage">${event.type.toUpperCase()}</div>
        <div class="details">${event.label || event.raw || ""}</div>
      </article>
    `)
    .join("");
}

function renderAll() {
  const names = Object.entries(state.files).map(([key, value]) => `${key}: ${value}`);
  els.statusLine.textContent = names.length ? names.join(" | ") : "No receiver artifacts loaded";
  renderSummary();
  renderTimeline();
  renderCn0();
  renderSkyPlot();
  renderMap();
  renderSatCounts();
  renderError();
  renderIqDominance();
  renderChannelTable();
  renderEvents();
}

async function readFileInput(input, key) {
  const file = input.files && input.files[0];
  if (!file) return;
  const text = await file.text();
  state.raw[key] = text;
  state.files[key] = file.name;
  parseAll();
}

async function fetchText(url) {
  const response = await fetch(url, { cache: "no-store" });
  if (!response.ok) throw new Error(`${response.status} ${url}`);
  return response.text();
}

async function fetchFirstText(urls) {
  const errors = [];
  for (const url of urls) {
    try {
      return { text: await fetchText(url), url };
    } catch (error) {
      errors.push(error);
    }
  }
  throw errors[errors.length - 1] || new Error("No source URLs");
}

async function loadDefaults() {
  els.statusLine.textContent = "Loading build outputs...";
  const sources = Object.entries(DEFAULT_SOURCES);

  const results = await Promise.allSettled(
    sources.map(async ([key, urls]) => {
      const { text, url } = await fetchFirstText(urls);
      state.raw[key] = text;
      state.files[key] = url;
    })
  );

  const loaded = results.filter((result) => result.status === "fulfilled").length;
  if (!loaded) {
    els.statusLine.textContent = "Build outputs were not reachable from this URL";
  } else {
    els.statusLine.textContent = `Loaded ${loaded}/${sources.length} build outputs`;
  }
  parseAll();
}

function installHandlers() {
  els.loadDefaults.addEventListener("click", loadDefaults);
  els.logFile.addEventListener("change", () => readFileInput(els.logFile, "log"));
  els.nmeaFile.addEventListener("change", () => readFileInput(els.nmeaFile, "nmea"));
  els.geojsonFile.addEventListener("change", () => readFileInput(els.geojsonFile, "geojson"));
  els.skyTimeSlider.addEventListener("input", () => {
    state.skyEpochIndex = Number(els.skyTimeSlider.value);
    renderSkyPlot();
  });

  document.querySelectorAll(".filter").forEach((button) => {
    button.addEventListener("click", () => {
      document.querySelectorAll(".filter").forEach((item) => item.classList.remove("active"));
      button.classList.add("active");
      state.currentFilter = button.dataset.filter;
      renderEvents();
    });
  });

  window.addEventListener("resize", () => {
    renderTimeline();
    renderCn0();
    renderSkyPlot();
    renderMap();
    renderSatCounts();
    renderError();
    renderIqDominance();
  });
}

installHandlers();
renderAll();
loadDefaults();
