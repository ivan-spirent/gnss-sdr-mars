const SUMMARY_URL = "/build/molli_3d_validation_summary.json";
const LATEX_URL = "/docs/mars_molli_results_section.tex";
const DISPLAY_WINDOW_S = 180;

const fmt = new Intl.NumberFormat("en", { maximumFractionDigits: 3 });
const fmt2 = new Intl.NumberFormat("en", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const fmtSci = new Intl.NumberFormat("en", { notation: "scientific", maximumSignificantDigits: 3 });
const PAPER_FONT = '"Times New Roman", Times, "TeX Gyre Termes", serif';
const AXIS_COLOR = "#000000";
const MUTED_COLOR = "#333333";
const GRID_COLOR = "#d9d9d9";
const PAGE_COLOR = "#ffffff";
const SERIES_ORANGE = "#c85235";

let paperRows = [];
let caption = "";
let latexSection = "";

function m(value, digits = 2) {
  if (value === null || value === undefined || Number.isNaN(value)) return "n/a";
  return `${Number(value).toFixed(digits)} m`;
}

function s(value, digits = 2) {
  if (value === null || value === undefined || Number.isNaN(value)) return "n/a";
  return `${Number(value).toFixed(digits)} s`;
}

function smallSeconds(value) {
  if (value === null || value === undefined || Number.isNaN(value)) return "n/a";
  return `${fmtSci.format(value)} s`;
}

function setText(id, value) {
  const el = document.getElementById(id);
  if (el) el.textContent = value;
}

function metricCard(label, value, sub) {
  const div = document.createElement("div");
  div.className = "metric";
  div.innerHTML = `<div class="label">${label}</div><div class="value">${value}</div><div class="sub">${sub}</div>`;
  return div;
}

function percentileLine(value, label, unit = "m") {
  if (value === null || value === undefined || Number.isNaN(value)) return null;
  return { y: value, label: `${label} = ${Number(value).toFixed(2)} ${unit}` };
}

function finiteValues(values) {
  return values.filter((value) => Number.isFinite(value));
}

function mean(values) {
  const finite = finiteValues(values);
  return finite.length ? finite.reduce((sum, value) => sum + value, 0) / finite.length : NaN;
}

function rms(values) {
  const finite = finiteValues(values);
  return finite.length ? Math.sqrt(finite.reduce((sum, value) => sum + value * value, 0) / finite.length) : NaN;
}

function percentile(values, pct) {
  const finite = finiteValues(values).sort((a, b) => a - b);
  if (!finite.length) return NaN;
  const index = (finite.length - 1) * pct / 100;
  const lower = Math.floor(index);
  const upper = Math.ceil(index);
  if (lower === upper) return finite[lower];
  return finite[lower] * (upper - index) + finite[upper] * (index - lower);
}

function stddev(values) {
  const finite = finiteValues(values);
  if (finite.length < 2) return 0;
  const avg = mean(finite);
  return Math.sqrt(finite.reduce((sum, value) => sum + (value - avg) ** 2, 0) / finite.length);
}

function linearSlope(xs, ys) {
  const pairs = xs.map((x, index) => ({ x, y: ys[index] })).filter((p) => Number.isFinite(p.x) && Number.isFinite(p.y));
  if (pairs.length < 2) return NaN;
  const avgX = mean(pairs.map((p) => p.x));
  const avgY = mean(pairs.map((p) => p.y));
  const numerator = pairs.reduce((sum, p) => sum + (p.x - avgX) * (p.y - avgY), 0);
  const denominator = pairs.reduce((sum, p) => sum + (p.x - avgX) ** 2, 0);
  return denominator ? numerator / denominator : NaN;
}

function windowedData(data) {
  const series = (data.series || []).filter((point) => Number.isFinite(point.sim_time_s) && point.sim_time_s <= DISPLAY_WINDOW_S);
  if (!series.length) return { ...data, series };

  const residuals = series.map((p) => p.residual_rms_m);
  const errors3d = series.map((p) => p.err3d);
  const vertical = series.map((p) => Math.abs(p.vertical));
  const clockBiasM = series.map((p) => p.clock_bias_m);
  const clockBiasS = series.map((p) => p.clock_bias_s);
  const simTime = series.map((p) => p.sim_time_s);
  const residualRows = series.reduce((sum, p) => sum + (Number.isFinite(p.residual_count) ? p.residual_count : 0), 0);
  const satCounts = series.map((p) => p.nsat);
  const clockPeakToPeakM = Math.max(...clockBiasM) - Math.min(...clockBiasM);
  const speedOfLight = 299792458;

  return {
    ...data,
    mode: `3D Single PVT, RAIM/FDE on, RTKLIB orbit-matched satellite propagation; displayed interval 0-${DISPLAY_WINDOW_S} s`,
    series,
    run: {
      ...data.run,
      last_fix_rx_time_ms: series[series.length - 1].rx_time_ms,
      epoch_count: series.length,
      residual_row_count: residualRows,
      satellites_per_fix_min: Math.min(...satCounts),
      satellites_per_fix_max: Math.max(...satCounts),
      nmea_sentence_counts: {
        ...data.run.nmea_sentence_counts,
        GGA: series.length,
        GSA: series.length
      }
    },
    metrics: {
      ...data.metrics,
      pseudorange_residual_rms_m_mean: mean(residuals),
      pseudorange_residual_rms_m_95: percentile(residuals, 95),
      pseudorange_residual_rms_m_max: Math.max(...residuals),
      position_3d_error_m_95: percentile(errors3d, 95),
      position_3d_error_m_rms: rms(errors3d),
      position_3d_error_m_max: Math.max(...errors3d),
      vertical_abs_error_m_95: percentile(vertical, 95),
      vertical_abs_error_m_rms: rms(vertical),
      vertical_abs_error_m_max: Math.max(...vertical),
      receiver_clock_bias_stability_std_s: stddev(clockBiasS),
      receiver_clock_bias_stability_std_m: stddev(clockBiasM),
      receiver_clock_bias_peak_to_peak_s: clockPeakToPeakM / speedOfLight,
      receiver_clock_bias_peak_to_peak_m: clockPeakToPeakM,
      receiver_clock_bias_linear_drift_m_per_s: linearSlope(simTime, clockBiasM)
    }
  };
}

function niceStep(range, targetTicks, integerOnly = false) {
  if (!Number.isFinite(range) || range <= 0) return 1;
  const raw = range / Math.max(1, targetTicks);
  const magnitude = 10 ** Math.floor(Math.log10(raw));
  const normalized = raw / magnitude;
  let nice = 10;
  if (normalized <= 1) nice = 1;
  else if (normalized <= 2) nice = 2;
  else if (normalized <= 5) nice = 5;
  let step = nice * magnitude;
  if (integerOnly && step < 1) step = 1;
  return step;
}

function niceExtent(min, max, targetTicks, integerOnly = false) {
  const step = niceStep(max - min, targetTicks, integerOnly);
  const axisMin = Math.floor(min / step) * step;
  const axisMax = Math.ceil(max / step) * step;
  const ticks = [];
  const limit = Math.max(2, Math.round((axisMax - axisMin) / step) + 1);
  for (let i = 0; i < limit; i++) {
    const value = axisMin + i * step;
    if (value > axisMax + step * 0.5) break;
    ticks.push(Number(value.toFixed(10)));
  }
  return { min: axisMin, max: axisMax, step, ticks };
}

function fixedExtent(min, max, step) {
  const ticks = [];
  for (let value = min; value <= max + step * 0.5; value += step) {
    ticks.push(Number(value.toFixed(10)));
  }
  return { min, max, step, ticks };
}

function drawChart(canvas, series, options) {
  const rect = canvas.getBoundingClientRect();
  const dpr = window.devicePixelRatio || 1;
  canvas.width = Math.max(1, Math.round(rect.width * dpr));
  canvas.height = Math.max(1, Math.round(rect.height * dpr));
  const ctx = canvas.getContext("2d");
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

  const width = rect.width;
  const height = rect.height;
  const pad = { left: 68, right: 24, top: 22, bottom: 54 };
  const plotW = width - pad.left - pad.right;
  const plotH = height - pad.top - pad.bottom;
  ctx.clearRect(0, 0, width, height);
  ctx.fillStyle = PAGE_COLOR;
  ctx.fillRect(0, 0, width, height);

  const points = series.filter((p) => Number.isFinite(p.x) && Number.isFinite(p.y));
  if (!points.length) {
    ctx.fillStyle = "#667587";
    ctx.fillText("No data", pad.left, pad.top + 18);
    return;
  }

  const xMin = Math.min(...points.map((p) => p.x));
  const xMax = Math.max(...points.map((p) => p.x));
  let yMin = options.yMin ?? Math.min(0, Math.min(...points.map((p) => p.y)));
  let yMax = options.yMax ?? Math.max(...points.map((p) => p.y));
  if (options.lines) {
    for (const line of options.lines) {
      if (line) yMax = Math.max(yMax, line.y);
    }
  }
  if (Math.abs(yMax - yMin) < 1e-9) yMax = yMin + 1;
  yMax += (yMax - yMin) * ((options.yPadFactor ?? 1.08) - 1);

  const displayScale = options.unit === "m" && Math.max(Math.abs(yMin), Math.abs(yMax)) <= 2 ? 100 : 1;
  const displayUnit = displayScale === 100 ? "cm" : options.unit;
  const yIntegerTicks = displayScale === 100 || options.unit === "m" || options.unit === "sats";
  const xAxis = Number.isFinite(options.xMin) && Number.isFinite(options.xMax) && Number.isFinite(options.xTickStep)
    ? fixedExtent(options.xMin, options.xMax, options.xTickStep)
    : niceExtent(xMin, xMax, Math.max(3, Math.floor(plotW / 130)), true);
  const yAxis = Number.isFinite(options.yMin) && Number.isFinite(options.yMax) && Number.isFinite(options.yTickStep)
    ? fixedExtent(options.yMin * displayScale, options.yMax * displayScale, options.yTickStep * displayScale)
    : niceExtent(yMin * displayScale, yMax * displayScale, 4, yIntegerTicks);
  const yAxisMin = yAxis.min / displayScale;
  const yAxisMax = yAxis.max / displayScale;

  const xScale = (x) => pad.left + ((x - xAxis.min) / Math.max(1e-9, xAxis.max - xAxis.min)) * plotW;
  const yScale = (y) => pad.top + (1 - (y - yAxisMin) / Math.max(1e-9, yAxisMax - yAxisMin)) * plotH;

  const labelBox = (text, x, y, align = "left", baseline = "middle", fill = PAGE_COLOR, color = AXIS_COLOR) => {
    const metrics = ctx.measureText(text);
    const h = 16;
    let boxX = x;
    if (align === "right") boxX = x - metrics.width;
    if (align === "center") boxX = x - metrics.width / 2;
    const boxY = baseline === "bottom" ? y - h : baseline === "top" ? y : y - h / 2;
    ctx.fillStyle = fill;
    ctx.fillRect(boxX - 4, boxY, metrics.width + 8, h);
    ctx.fillStyle = color;
    ctx.textAlign = align;
    ctx.textBaseline = baseline;
    ctx.fillText(text, x, y);
  };

  ctx.strokeStyle = GRID_COLOR;
  ctx.lineWidth = 0.8;
  ctx.fillStyle = AXIS_COLOR;
  ctx.font = `9pt ${PAPER_FONT}`;
  ctx.textAlign = "right";
  ctx.textBaseline = "middle";
  for (const value of yAxis.ticks) {
    const y = yScale(value / displayScale);
    ctx.beginPath();
    ctx.moveTo(pad.left, y);
    ctx.lineTo(width - pad.right, y);
    ctx.stroke();
    ctx.fillText(`${Math.round(value)}${displayUnit ? " " + displayUnit : ""}`, pad.left - 8, y);
  }

  ctx.strokeStyle = AXIS_COLOR;
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(pad.left, pad.top);
  ctx.lineTo(pad.left, height - pad.bottom);
  ctx.lineTo(width - pad.right, height - pad.bottom);
  ctx.stroke();

  ctx.textAlign = "center";
  ctx.textBaseline = "top";
  for (const value of xAxis.ticks) {
    const x = xScale(value);
    if (x < pad.left - 1 || x > width - pad.right + 1) continue;
    ctx.fillText(String(Math.round(value)), x, height - pad.bottom + 14);
  }

  ctx.fillStyle = AXIS_COLOR;
  ctx.textAlign = "right";
  ctx.textBaseline = "alphabetic";
  ctx.fillText("simulation time (s)", width - pad.right, height - 12);

  if (options.lines) {
    ctx.setLineDash([5, 5]);
    ctx.lineWidth = 1.2;
    for (const line of options.lines) {
      if (!line) continue;
      const y = yScale(line.y);
      ctx.strokeStyle = line.color || "#c85235";
      ctx.beginPath();
      ctx.moveTo(pad.left, y);
      ctx.lineTo(width - pad.right, y);
      ctx.stroke();
      ctx.fillStyle = line.color || AXIS_COLOR;
      const labelY = Math.max(pad.top + 14, Math.min(height - pad.bottom - 8, y - 4));
      labelBox(line.label, width - pad.right - 8, labelY, "right", "bottom", PAGE_COLOR, line.color || AXIS_COLOR);
    }
    ctx.setLineDash([]);
  }

  ctx.beginPath();
  points.forEach((p, i) => {
    const x = xScale(p.x);
    const y = yScale(p.y);
    if (i === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  });
  ctx.strokeStyle = options.color || "#1b7284";
  ctx.lineWidth = 1.6;
  ctx.stroke();

  if (options.fill) {
    ctx.lineTo(xScale(points[points.length - 1].x), yScale(yAxisMin));
    ctx.lineTo(xScale(points[0].x), yScale(yAxisMin));
    ctx.closePath();
    ctx.fillStyle = options.fill;
    ctx.fill();
  }
}

function buildPaperRows(data) {
  const run = data.run;
  const metrics = data.metrics;
  return [
    ["Pseudorange residual RMS", `${m(metrics.pseudorange_residual_rms_m_mean)} mean; ${m(metrics.pseudorange_residual_rms_m_95)} 95%`, "Per-epoch RMS of RTKLIB post-fit pseudorange residuals over used PRNs."],
    ["3D position error (95%)", m(metrics.position_3d_error_m_95), "95th percentile of ECEF-derived 3D error against Mars truth 0 deg, 0 deg, 0 m."],
    ["Vertical error (95%)", m(metrics.vertical_abs_error_m_95), "95th percentile of absolute radial/up error relative to the Mars ellipsoid truth height."],
    ["Receiver clock bias stability", `${m(metrics.receiver_clock_bias_stability_std_m)} std; ${m(metrics.receiver_clock_bias_peak_to_peak_m)} peak-to-peak`, "Standard deviation and peak-to-peak variation of solved receiver clock bias over valid PVT epochs."],
    ["Time-to-first-fix (TTFF)", s(metrics.time_to_first_fix_s), `First valid 3D PVT epoch relative to simulator TOW ${run.sim_start_tow_ms} ms.`]
  ];
}

function renderTable(rows) {
  const tbody = document.querySelector("#paperTable tbody");
  tbody.innerHTML = "";
  for (const row of rows) {
    const tr = document.createElement("tr");
    for (const cell of row) {
      const td = document.createElement("td");
      td.textContent = cell;
      tr.appendChild(td);
    }
    tbody.appendChild(tr);
  }
}

function markdownTable(rows) {
  const header = ["Metric", "Result", "Definition"];
  const lines = [
    `| ${header.join(" | ")} |`,
    `| ${header.map(() => "---").join(" | ")} |`
  ];
  for (const row of rows) lines.push(`| ${row.join(" | ")} |`);
  return lines.join("\n");
}

async function copyText(text) {
  await navigator.clipboard.writeText(text);
}

function render(data) {
  const run = data.run;
  const metrics = data.metrics;
  const series = data.series || [];
  paperRows = buildPaperRows(data);

  setText("subtitle", `${data.mode}; truth ${data.truth.lat_deg} deg lat, ${data.truth.lon_deg} deg lon, ${data.truth.height_m} m`);
  setText("runSummary", `0-${DISPLAY_WINDOW_S} s | ${run.epoch_count} epochs | ${run.satellites_per_fix_min}-${run.satellites_per_fix_max} satellites`);
  setText("residualSummary", `mean ${m(metrics.pseudorange_residual_rms_m_mean)} | 95% ${m(metrics.pseudorange_residual_rms_m_95)}`);
  setText("error3dSummary", `RMS ${m(metrics.position_3d_error_m_rms)} | 95% ${m(metrics.position_3d_error_m_95)}`);
  setText("verticalSummary", `RMS ${m(metrics.vertical_abs_error_m_rms)} | 95% ${m(metrics.vertical_abs_error_m_95)}`);
  setText("clockSummary", `std ${m(metrics.receiver_clock_bias_stability_std_m)} | drift ${metrics.receiver_clock_bias_linear_drift_m_per_s.toFixed(3)} m/s`);
  setText("fixSummary", `TTFF ${s(metrics.time_to_first_fix_s)} | ${run.nmea_sentence_counts.GGA} GGA fixes`);

  const grid = document.getElementById("metricGrid");
  grid.innerHTML = "";
  grid.appendChild(metricCard("Residual RMS", m(metrics.pseudorange_residual_rms_m_mean), `95% ${m(metrics.pseudorange_residual_rms_m_95)}`));
  grid.appendChild(metricCard("3D Error 95%", m(metrics.position_3d_error_m_95), `RMS ${m(metrics.position_3d_error_m_rms)}`));
  grid.appendChild(metricCard("Vertical 95%", m(metrics.vertical_abs_error_m_95), `max ${m(metrics.vertical_abs_error_m_max)}`));
  grid.appendChild(metricCard("Clock Stability", m(metrics.receiver_clock_bias_stability_std_m), `${smallSeconds(metrics.receiver_clock_bias_stability_std_s)} std`));
  grid.appendChild(metricCard("TTFF", s(metrics.time_to_first_fix_s), `${run.satellites_per_fix_min}-${run.satellites_per_fix_max} sats/fix`));

  renderTable(paperRows);

  const x = (p) => p.sim_time_s;
  drawChart(document.getElementById("residualCanvas"), series.map((p) => ({ x: x(p), y: p.residual_rms_m })), {
    unit: "m",
    color: SERIES_ORANGE,
    xMin: 0,
    xMax: DISPLAY_WINDOW_S,
    xTickStep: 60,
    lines: [percentileLine(metrics.pseudorange_residual_rms_m_95, "95%")]
  });
  drawChart(document.getElementById("error3dCanvas"), series.map((p) => ({ x: x(p), y: p.err3d })), {
    unit: "m",
    color: SERIES_ORANGE,
    xMin: 0,
    xMax: DISPLAY_WINDOW_S,
    xTickStep: 60,
    yMin: 0,
    yMax: 12,
    yTickStep: 2,
    lines: [percentileLine(metrics.position_3d_error_m_95, "95%")]
  });
  drawChart(document.getElementById("verticalCanvas"), series.map((p) => ({ x: x(p), y: p.vertical })), {
    unit: "m",
    color: SERIES_ORANGE,
    xMin: 0,
    xMax: DISPLAY_WINDOW_S,
    xTickStep: 60,
    lines: [percentileLine(metrics.vertical_abs_error_m_95, "95%")]
  });
  drawChart(document.getElementById("clockCanvas"), series.map((p) => ({ x: x(p), y: p.clock_bias_m - series[0].clock_bias_m })), {
    unit: "m",
    color: SERIES_ORANGE,
    xMin: 0,
    xMax: DISPLAY_WINDOW_S,
    xTickStep: 60
  });
  drawChart(document.getElementById("fixCanvas"), series.map((p) => ({ x: x(p), y: p.nsat })), {
    unit: "sats",
    color: SERIES_ORANGE,
    xMin: 0,
    xMax: DISPLAY_WINDOW_S,
    xTickStep: 60,
    yMin: 0,
    yMax: 10,
    yTickStep: 2
  });

  caption = `Mars Molli 32 SV 3D validation over the first ${DISPLAY_WINDOW_S} s of simulation using GPS L1 C/A-like signals, GPS time, RAIM/FDE enabled, Earth ionosphere/troposphere models disabled, and RTKLIB orbit-matched satellite propagation. Across ${run.epoch_count} valid PVT epochs, the mean pseudorange residual RMS was ${m(metrics.pseudorange_residual_rms_m_mean)}, 3D position error 95% was ${m(metrics.position_3d_error_m_95)}, vertical error 95% was ${m(metrics.vertical_abs_error_m_95)}, receiver clock-bias stability was ${m(metrics.receiver_clock_bias_stability_std_m)} standard deviation, and TTFF was ${s(metrics.time_to_first_fix_s)}.`;
  setText("captionText", caption);
}

async function init() {
  try {
    const [response, latexResponse] = await Promise.all([
      fetch(SUMMARY_URL, { cache: "no-store" }),
      fetch(LATEX_URL, { cache: "no-store" })
    ]);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    if (!latexResponse.ok) throw new Error(`LaTeX HTTP ${latexResponse.status}`);
    const data = windowedData(await response.json());
    latexSection = await latexResponse.text();
    render(data);
    setText("latexText", latexSection);
  } catch (error) {
    setText("subtitle", `Unable to load ${SUMMARY_URL}: ${error.message}`);
    setText("latexText", `Unable to load ${LATEX_URL}: ${error.message}`);
  }
}

document.getElementById("copyMarkdown").addEventListener("click", () => copyText(markdownTable(paperRows)));
document.getElementById("copyCaption").addEventListener("click", () => copyText(caption));
document.getElementById("copyLatex").addEventListener("click", () => copyText(latexSection));
window.addEventListener("resize", () => init());
init();
