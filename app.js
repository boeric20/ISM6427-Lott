/* Lott Weather: Open-Meteo dashboard (no build step, no API key) */

// ---------- Settings ----------
const NAME = "Bo Lott";
const DEFAULT_LOC = { name: "Clyde", region: "Texas", lat: 32.40596, lon: -99.49369 };
// Solar estimate assumptions (Open-Meteo returns irradiance, not panel output)
const ARRAY_KW = 6;
const TILT = 30;
const AZIMUTH = 0; // 0 = facing south in Open-Meteo
const SYSTEM_EFFICIENCY = 0.8; // inverter, wiring, heat and soiling losses
const FIRST_HISTORY_YEAR = 1940;

const API = {
  forecast: "https://api.open-meteo.com/v1/forecast",
  air: "https://air-quality-api.open-meteo.com/v1/air-quality",
  archive: "https://archive-api.open-meteo.com/v1/archive",
  geo: "https://geocoding-api.open-meteo.com/v1/search",
};

// ---------- State ----------
const state = {
  loc: DEFAULT_LOC,
  unit: read("unit", "F"),
  tab: "today",
  fc: null, // forecast
  aq: null, // air quality
  ly: null, // one year ago
  hist: null, // same date in past years
  months: null, // monthly means, this year vs last year
  histLoading: false,
};

// ---------- Small helpers ----------
const $ = (id) => document.getElementById(id);
const r = (n) => Math.round(n);
const deg = (n) => `${r(n)}°`;
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const sum = (a) => a.reduce((s, v) => s + (v || 0), 0);
const avg = (a) => sum(a) / a.length;
const path = (pts) => pts.map(([x, y], i) => `${i ? "L" : "M"}${x.toFixed(1)} ${y.toFixed(1)}`).join(" ");

function read(key, fallback) {
  try { return localStorage.getItem(key) || fallback; } catch (e) { return fallback; }
}
function write(key, value) {
  try { localStorage.setItem(key, value); } catch (e) {}
}

async function getJSON(base, params) {
  const res = await fetch(`${base}?${new URLSearchParams(params)}`);
  const data = await res.json().catch(() => ({}));
  if (!res.ok || data.error) throw new Error(data.reason || `HTTP ${res.status}`);
  return data;
}

// Open-Meteo returns local times like "2026-11-01T17:45" (already in the location's time zone).
const hourOf = (s) => +s.slice(11, 13);
const minutesOf = (s) => hourOf(s) * 60 + +s.slice(14, 16);
function hourLabel(h) {
  h = ((h % 24) + 24) % 24;
  return h === 0 ? "12 AM" : h === 12 ? "12 PM" : (h % 12) + (h < 12 ? " AM" : " PM");
}
function timeLabel(s) {
  const h = hourOf(s), m = s.slice(14, 16);
  return `${h % 12 || 12}:${m} ${h < 12 ? "AM" : "PM"}`;
}
function dateParts(s) {
  const [y, m, d] = s.slice(0, 10).split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d));
}
const dayName = (s) => dateParts(s).toLocaleDateString("en-US", { weekday: "short", timeZone: "UTC" });
const dayLong = (s) => dateParts(s).toLocaleDateString("en-US", { weekday: "long", timeZone: "UTC" });
const monthDay = (s) => dateParts(s).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
const fullDate = (s) => dateParts(s).toLocaleDateString("en-US", { month: "long", day: "numeric", timeZone: "UTC" });
function addDays(s, n) {
  const d = dateParts(s);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
function hm(seconds) {
  const m = r(seconds / 60);
  return `${Math.floor(m / 60)}h ${m % 60}m`;
}
function compass(d) {
  return ["N", "NNE", "NE", "ENE", "E", "ESE", "SE", "SSE", "S", "SSW", "SW", "WSW", "W", "WNW", "NW", "NNW"][r(d / 22.5) % 16];
}

// WMO weather codes
const WMO = {
  0: "Clear", 1: "Mostly clear", 2: "Partly cloudy", 3: "Overcast", 45: "Fog", 48: "Freezing fog",
  51: "Light drizzle", 53: "Drizzle", 55: "Heavy drizzle", 56: "Freezing drizzle", 57: "Freezing drizzle",
  61: "Light rain", 63: "Rain", 65: "Heavy rain", 66: "Freezing rain", 67: "Freezing rain",
  71: "Light snow", 73: "Snow", 75: "Heavy snow", 77: "Snow grains",
  80: "Showers", 81: "Showers", 82: "Heavy showers", 85: "Snow showers", 86: "Snow showers",
  95: "Thunderstorms", 96: "Storms, hail", 99: "Storms, hail",
};
const cond = (c, isDay = 1) => (c <= 1 && !isDay ? (c === 0 ? "Clear night" : "Mostly clear") : WMO[c] || "Unknown");

function uvLevel(u) {
  return u < 3 ? "Low" : u < 6 ? "Moderate" : u < 8 ? "High" : u < 11 ? "Very high" : "Extreme";
}

// US AQI categories (EPA)
function aqiInfo(v) {
  if (v <= 50) return { name: "Good", color: "var(--good)", advice: "Fine for any outdoor activity." };
  if (v <= 100) return { name: "Moderate", color: "var(--warm)", advice: "Acceptable. Unusually sensitive people should limit long or heavy outdoor exertion." };
  if (v <= 150) return { name: "Unhealthy for sensitive groups", color: "var(--warm)", advice: "People with heart or lung disease, older adults and children should reduce long or heavy exertion outdoors." };
  if (v <= 200) return { name: "Unhealthy", color: "var(--bad)", advice: "Everyone should reduce long or heavy exertion outdoors." };
  if (v <= 300) return { name: "Very unhealthy", color: "var(--bad)", advice: "Avoid long or heavy exertion outdoors." };
  return { name: "Hazardous", color: "var(--bad)", advice: "Everyone should avoid outdoor activity." };
}
// Marker position on the AQI color bar (0-200 spread over two-thirds, 200-300+ over the rest)
const aqiPos = (v) => (v <= 200 ? (v / 200) * 66.7 : clamp(66.7 + ((v - 200) / 100) * 33.3, 0, 100));

// Approximate "good" upper limits in µg/m³, used to rank pollutants and label levels.
// PM2.5 and PM10 follow EPA AQI breakpoints; ozone and NO₂ are converted from ppb.
const POLLUTANTS = [
  { key: "pm2_5", name: "PM2.5", unit: "µg/m³", good: 9, moderate: 35.4 },
  { key: "pm10", name: "PM10", unit: "µg/m³", good: 54, moderate: 154 },
  { key: "ozone", name: "Ozone", unit: "µg/m³", good: 106, moderate: 137 },
  { key: "nitrogen_dioxide", name: "NO₂", unit: "µg/m³", good: 100, moderate: 188 },
  { key: "dust", name: "Dust", unit: "µg/m³", good: 20, moderate: 50, words: ["Low", "Moderate", "High"] },
  { key: "aerosol_optical_depth", name: "Aerosol depth", unit: "AOD", good: 0.3, moderate: 0.6, words: ["Clear", "Hazy", "Very hazy"] },
];
function pollLevel(p, v) {
  const w = p.words || ["Good", "Moderate", "High"];
  const i = v <= p.good ? 0 : v <= p.moderate ? 1 : 2;
  return { word: w[i], color: ["var(--good)", "var(--warm)", "var(--bad)"][i] };
}

// ---------- Data loading ----------
function forecastParams() {
  return {
    latitude: state.loc.lat,
    longitude: state.loc.lon,
    current: "temperature_2m,apparent_temperature,relative_humidity_2m,dew_point_2m,weather_code,wind_speed_10m,wind_direction_10m,wind_gusts_10m,uv_index,is_day,global_tilted_irradiance",
    minutely_15: "precipitation",
    forecast_minutely_15: 24,
    hourly: "temperature_2m,precipitation_probability,weather_code,is_day,shortwave_radiation,direct_normal_irradiance,diffuse_radiation,global_tilted_irradiance",
    daily: "weather_code,temperature_2m_max,temperature_2m_min,precipitation_sum,precipitation_probability_max,sunrise,sunset,uv_index_max,daylight_duration,sunshine_duration",
    tilt: TILT,
    azimuth: AZIMUTH,
    temperature_unit: state.unit === "C" ? "celsius" : "fahrenheit",
    wind_speed_unit: "mph",
    precipitation_unit: "inch",
    timezone: "auto",
    forecast_days: 16,
  };
}

function archiveParams(start, end, daily) {
  return {
    latitude: state.loc.lat,
    longitude: state.loc.lon,
    start_date: start,
    end_date: end,
    daily,
    temperature_unit: state.unit === "C" ? "celsius" : "fahrenheit",
    wind_speed_unit: "mph",
    precipitation_unit: "inch",
    timezone: "auto",
  };
}

let histRun = 0;
async function loadAll() {
  state.hist = state.months = state.ly = null;
  state.histLoading = false;
  histRun++;
  showStatus("Loading weather…");
  try {
    const [fc, aq] = await Promise.all([
      getJSON(API.forecast, forecastParams()),
      getJSON(API.air, {
        latitude: state.loc.lat,
        longitude: state.loc.lon,
        current: "us_aqi," + POLLUTANTS.map((p) => p.key).join(","),
        hourly: "us_aqi," + POLLUTANTS.map((p) => p.key).join(","),
        past_days: 1,
        forecast_days: 4,
        timezone: "auto",
      }).catch(() => null),
    ]);
    state.fc = fc;
    state.aq = aq;
    showStatus("");
  } catch (err) {
    console.error(err);
    showStatus("Unable to load weather. Check your connection and try again.");
    return;
  }
  renderAll();
  loadLastYear();
  if (state.tab === "history") loadHistory();
}

async function loadLastYear() {
  const today = state.fc.daily.time[0];
  let date = `${+today.slice(0, 4) - 1}${today.slice(4)}`;
  if (date.endsWith("02-29")) date = date.replace("02-29", "02-28");
  try {
    const d = await getJSON(API.archive, archiveParams(date, date,
      "weather_code,temperature_2m_max,temperature_2m_min,precipitation_sum,wind_speed_10m_max,wind_direction_10m_dominant,relative_humidity_2m_mean,sunshine_duration"));
    const v = (k) => d.daily[k][0];
    state.ly = {
      date, code: v("weather_code"), hi: v("temperature_2m_max"), lo: v("temperature_2m_min"),
      rain: v("precipitation_sum"), wind: v("wind_speed_10m_max"), dir: v("wind_direction_10m_dominant"),
      rh: v("relative_humidity_2m_mean"), sun: v("sunshine_duration"),
    };
  } catch (err) {
    console.error(err);
    state.ly = { error: true };
  }
  renderToday();
  if (state.tab === "history") renderHistory();
}

// History is loaded only when the History tab is opened.
// Open-Meteo counts every 2 weeks of data as one API call, so one 86-year request would cost
// over 2,000 calls. Instead we ask for the single calendar day in each year (1 call each) and
// cache the result in the browser for the rest of the day.
async function loadHistory() {
  if (!state.fc || state.hist || state.histLoading) return;
  state.histLoading = true;
  const run = ++histRun; // a newer load (new city or unit) makes this one stale
  const today = state.fc.daily.time[0];
  const thisYear = +today.slice(0, 4);
  const md = today.slice(5);
  const key = `hist:${state.loc.lat},${state.loc.lon}:${today}:${state.unit}`;
  let cached = null;
  try { cached = JSON.parse(read(key, "null")); } catch (e) {}

  if (cached) {
    state.hist = cached.hist;
    state.months = cached.months;
  } else {
    renderHistory();
    const years = [];
    for (let y = FIRST_HISTORY_YEAR; y < thisYear; y++) years.push(y);
    const out = [];
    let done = 0;
    const queue = years.slice();
    async function worker() {
      while (queue.length) {
        const y = queue.shift();
        const date = md === "02-29" ? `${y}-02-28` : `${y}-${md}`;
        try {
          const d = await getJSON(API.archive, archiveParams(date, date, "temperature_2m_max"));
          const t = d.daily.temperature_2m_max[0];
          if (t != null) out.push([y, t]);
        } catch (e) { /* skip a missing year */ }
        done++;
        if (done % 10 === 0) updateHistProgress(done, years.length);
      }
    }
    await Promise.all(Array.from({ length: 6 }, worker));
    out.sort((a, b) => a[0] - b[0]);

    // Monthly means for this year and last year (about 2 years of daily data)
    let months = null;
    try {
      const end = addDays(today, -6); // ERA5 archive runs about 5 days behind
      const d = await getJSON(API.archive, archiveParams(`${thisYear - 1}-01-01`, end, "temperature_2m_mean"));
      const groups = {};
      d.daily.time.forEach((t, i) => {
        const v = d.daily.temperature_2m_mean[i];
        if (v == null) return;
        (groups[t.slice(0, 7)] ||= []).push(v);
      });
      months = [];
      // Only months of this year that are fully covered by the archive
      const endMonthDone = addDays(end, 1).slice(5, 7) !== end.slice(5, 7);
      const lastFull = +end.slice(0, 4) < thisYear ? 0 : +end.slice(5, 7) - (endMonthDone ? 0 : 1);
      for (let m = 1; m <= lastFull; m++) {
        const mm = String(m).padStart(2, "0");
        const a = groups[`${thisYear}-${mm}`], b = groups[`${thisYear - 1}-${mm}`];
        if (a && b) months.push({ m, now: avg(a), last: avg(b) });
      }
    } catch (e) {
      console.error(e);
    }

    if (run !== histRun) return;
    state.hist = out;
    state.months = months;
    if (out.length) write(key, JSON.stringify({ hist: out, months }));
  }
  state.histLoading = false;
  renderHistory();
}

function updateHistProgress(done, total) {
  const el = $("hist-progress");
  if (el) el.textContent = `Loading ${done} of ${total} years…`;
}

// ---------- Rendering helpers ----------
const card = (span, label, body, aside = "", cls = "") =>
  `<div class="card span-${span} ${cls}"><div class="card-hd"><span class="label">${label}</span>${aside ? `<span class="aside">${aside}</span>` : ""}</div>${body}</div>`;

function idxNow() {
  const { hourly, current } = state.fc;
  const i = hourly.time.indexOf(current.time.slice(0, 13) + ":00");
  return i < 0 ? 0 : i;
}
function hoursOfDay(date) {
  const h = state.fc.hourly;
  return h.time.map((t, i) => (t.startsWith(date) ? i : -1)).filter((i) => i >= 0);
}
function solarKWh(date, uptoTime) {
  const h = state.fc.hourly;
  return sum(hoursOfDay(date).filter((i) => !uptoTime || h.time[i] <= uptoTime).map((i) => h.global_tilted_irradiance[i])) / 1000 * ARRAY_KW * SYSTEM_EFFICIENCY;
}

function pickSky() {
  const { current: c, daily: d } = state.fc;
  const code = c.weather_code;
  if (code >= 95 || (code >= 51 && code <= 67) || (code >= 80 && code <= 82)) return "storm";
  if (code === 3 || code === 45 || code === 48 || (code >= 71 && code <= 77) || code === 85 || code === 86) return "overcast";
  const now = minutesOf(c.time), rise = minutesOf(d.sunrise[0]), set = minutesOf(d.sunset[0]);
  if (Math.abs(now - set) <= 60 || Math.abs(now - rise) <= 45) return "dusk";
  return c.is_day ? "day" : "night";
}

// ---------- Today ----------
function renderToday() {
  const { current: c, hourly: h, daily: d, minutely_15: m15 } = state.fc;
  const i0 = idxNow();

  // Next 6 hours, every 15 minutes
  const p15 = m15.precipitation.map((v) => v || 0);
  const maxP = Math.max(0.05, ...p15);
  const wetAt = p15.findIndex((v) => v >= 0.005);
  const total6 = sum(p15);
  let nowHead, nowSub;
  if (wetAt < 0) {
    nowHead = "Dry for the next 6 hours";
    nowSub = "No precipitation expected.";
  } else if (wetAt === 0) {
    const dryAt = p15.findIndex((v, i) => i > 0 && v < 0.005);
    nowHead = dryAt > 0 ? `Precipitation until about ${timeLabel(m15.time[dryAt])}` : "Precipitation for the next few hours";
    nowSub = `About ${total6.toFixed(2)} in over the next 6 hours.`;
  } else {
    nowHead = `Dry until about ${timeLabel(m15.time[wetAt])}`;
    nowSub = `Then about ${total6.toFixed(2)} in through ${timeLabel(m15.time[m15.time.length - 1])}.`;
  }
  const nowBars = p15.map((v) => `<div style="height:${v ? Math.max(8, (v / maxP) * 90) : 3}px;background:${v ? "var(--cool)" : "var(--track)"}"></div>`).join("");
  const nowAxis = [0, 8, 16, 23].map((i) => `<span>${i ? hourLabel(hourOf(m15.time[i]) + (minutesOf(m15.time[i]) % 60 ? 1 : 0)) : "Now"}</span>`).join("");

  // Sun arc
  const rise = minutesOf(d.sunrise[0]), set = minutesOf(d.sunset[0]), now = minutesOf(c.time);
  const f = clamp((now - rise) / (set - rise), 0, 1);
  const sx = (110 - 100 * Math.cos(Math.PI * f)).toFixed(1), sy = (104 - 100 * Math.sin(Math.PI * f)).toFixed(1);
  const sunColor = c.is_day ? "var(--warm)" : "var(--faint)";

  // Next 24 hours
  const idx = Array.from({ length: 24 }, (_, k) => i0 + k).filter((i) => i < h.time.length);
  const T = idx.map((i) => h.temperature_2m[i]);
  const tMin = Math.min(...T), tMax = Math.max(...T), span = tMax - tMin || 1;
  const ty = (t) => 40 - ((t - tMin) / span) * 40;
  const pts = T.map((t, k) => [((k + 0.5) / T.length) * 1000, ty(t) + 22]);
  const line = path(pts);
  const area = `${line} L${pts[pts.length - 1][0]} 70 L${pts[0][0]} 70 Z`;
  const hrsLbl = idx.map((i, k) => `<span>${k ? hourLabel(hourOf(h.time[i])) : "Now"}</span>`).join("");
  const hrsTemp = T.map((t) => `<span style="padding-top:${Math.max(0, ty(t) - 2).toFixed(0)}px;text-shadow:0 1px 6px rgba(0,0,0,.25)">${deg(t)}</span>`).join("");
  const hrsPop = idx.map((i) => {
    const p = h.precipitation_probability[i] || 0;
    return `<div>${p >= 5 ? p + "%" : ""}<i style="height:${p >= 5 ? Math.max(2, p * 0.25) : 0}px"></i></div>`;
  }).join("");

  // 7 days
  const lo7 = Math.min(...d.temperature_2m_min.slice(0, 7)), hi7 = Math.max(...d.temperature_2m_max.slice(0, 7)), w7 = hi7 - lo7 || 1;
  const week = d.time.slice(0, 7).map((t, i) => {
    const lo = d.temperature_2m_min[i], hi = d.temperature_2m_max[i], p = d.precipitation_probability_max[i] || 0;
    return `<div class="week-row"><b>${i ? dayName(t) : "Today"}</b><span class="muted">${cond(d.weather_code[i])}</span><span class="p">${p >= 10 ? p + "%" : ""}</span><span class="lo">${deg(lo)}</span><div class="range"><i style="left:${((lo - lo7) / w7) * 100}%;width:${((hi - lo) / w7) * 100}%"></i></div><b>${deg(hi)}</b></div>`;
  }).join("");

  // Air quality summary
  let aqBody = `<p class="sub">Air quality data is unavailable right now.</p>`;
  if (state.aq) {
    const v = state.aq.current.us_aqi, info = aqiInfo(v);
    const main = POLLUTANTS.slice(0, 4).map((p) => ({ p, ratio: (state.aq.current[p.key] || 0) / p.good })).sort((a, b) => b.ratio - a.ratio)[0];
    aqBody = `<div style="display:flex;align-items:baseline;gap:10px"><span style="font-size:56px;font-weight:300;letter-spacing:-.04em;line-height:1">${r(v)}</span><span style="font-size:18px;font-weight:600;color:${info.color}">${info.name}</span></div>
      <div class="aqi-scale"><i style="left:${aqiPos(v)}%"></i></div>
      <p class="sub" style="margin-top:auto">Main pollutant: ${main.p.name}. ${info.advice}</p>`;
  }

  // One year ago
  let lyBody = `<div class="tiny">Loading…</div>`;
  if (state.ly && state.ly.error) lyBody = `<div class="tiny">Unavailable</div>`;
  else if (state.ly) {
    const diff = r(state.ly.hi - d.temperature_2m_max[0]);
    lyBody = `<div><div class="big">${deg(state.ly.hi)} <small>/ ${deg(state.ly.lo)}</small></div><div class="tiny">${diff === 0 ? "Same high as today" : `${Math.abs(diff)}° ${diff > 0 ? "warmer" : "cooler"} than today`}</div></div>`;
  }

  const uvNow = c.uv_index ?? 0, uvMax = d.uv_index_max[0] ?? 0;

  $("panel-today").innerHTML = `
    <div class="card bare hero span-5">
      <span class="label">Now</span>
      <div class="now-temp">${deg(c.temperature_2m)}</div>
      <div style="display:flex;flex-direction:column;gap:6px">
        <div class="now-cond">${cond(c.weather_code, c.is_day)}</div>
        <div class="now-meta"><span>H ${deg(d.temperature_2m_max[0])}</span><span>L ${deg(d.temperature_2m_min[0])}</span><span>Feels like ${deg(c.apparent_temperature)}</span></div>
      </div>
    </div>
    ${card(4, "Next 6 hours · every 15 min", `<div class="headline">${nowHead}</div><div class="sub">${nowSub}</div><div class="bars">${nowBars}</div><div class="axis">${nowAxis}</div>`)}
    ${card(3, "Sun &amp; UV", `
      <svg viewBox="0 0 220 112" style="width:100%;height:112px;overflow:visible" aria-hidden="true">
        <path d="M10 104 A100 100 0 0 1 210 104" fill="none" stroke="var(--faint)" stroke-width="1.5" stroke-dasharray="3 5"/>
        <line x1="0" y1="104" x2="220" y2="104" stroke="var(--line)"/>
        <circle cx="${sx}" cy="${sy}" r="18" fill="${sunColor}" opacity=".18"/><circle cx="${sx}" cy="${sy}" r="9" fill="${sunColor}"/>
      </svg>
      <div style="display:flex;justify-content:space-between;font-size:14px"><div><div class="tiny">Sunrise</div>${timeLabel(d.sunrise[0])}</div><div style="text-align:right"><div class="tiny">Sunset</div>${timeLabel(d.sunset[0])}</div></div>
      <div class="divider"></div>
      <div style="display:flex;justify-content:space-between;align-items:baseline;font-size:14px;gap:8px"><span class="muted">UV now ${r(uvNow)} · today's max</span><span style="font-size:20px;font-weight:600;white-space:nowrap">${uvMax.toFixed(1)} <span style="font-size:13px;font-weight:400" class="muted">${uvLevel(uvMax)}</span></span></div>`)}
    ${card(12, "Next 24 hours", `<div class="scroll-x"><div class="inner-w">
      <div class="hours hours-lbl">${hrsLbl}</div>
      <div class="hours-chart">
        <svg viewBox="0 0 1000 70" preserveAspectRatio="none" aria-hidden="true">
          <defs><linearGradient id="tg" x1="0" x2="0" y1="0" y2="1"><stop offset="0" stop-color="var(--warm)" stop-opacity=".35"/><stop offset="1" stop-color="var(--warm)" stop-opacity="0"/></linearGradient></defs>
          <path d="${area}" fill="url(#tg)"/><path d="${line}" fill="none" stroke="var(--warm)" stroke-width="2" vector-effect="non-scaling-stroke"/>
        </svg>
        <div class="hours">${hrsTemp}</div>
      </div>
      <div class="hours pop">${hrsPop}</div>
    </div></div>`, "Chance of precipitation in blue")}
    ${card(5, "7 days", `<div class="week">${week}</div>`, `<a href="#outlook">See 16-day →</a>`)}
    ${card(3, "Air quality", aqBody, "US AQI")}
    <div class="stack span-2">
      ${card(12, "Wind", `<div><div class="big">${r(c.wind_speed_10m)} <small>mph ${compass(c.wind_direction_10m)}</small></div><div class="tiny">Gusts ${r(c.wind_gusts_10m)}</div></div>`)}
      ${card(12, "Humidity", `<div><div class="big">${r(c.relative_humidity_2m)}%</div><div class="tiny">Dew point ${deg(c.dew_point_2m)}</div></div>`)}
    </div>
    <div class="stack span-2">
      ${card(12, "A year ago", lyBody)}
      ${card(12, "Solar today", `<div><div class="big">${solarKWh(d.time[0]).toFixed(1)} <small>kWh</small></div><div class="tiny">Est. for ${ARRAY_KW} kW array</div></div>`)}
    </div>`;
}

// ---------- Air quality ----------
function renderAir() {
  const el = $("panel-air");
  if (!state.aq) {
    el.innerHTML = card(12, "Air quality", `<p class="sub">Air quality data is unavailable right now.</p>`);
    return;
  }
  const { current: c, hourly: h } = state.aq;
  const v = c.us_aqi, info = aqiInfo(v);
  let i0 = h.time.indexOf(c.time.slice(0, 13) + ":00");
  if (i0 < 0) i0 = 24;

  // Next 3 days
  const next = h.us_aqi.slice(i0, i0 + 72).map((x) => x ?? 0);
  const times = h.time.slice(i0, i0 + 72);
  const top = Math.max(80, ...next) * 1.1;
  const peak = Math.max(...next), pi = next.indexOf(peak), peakInfo = aqiInfo(peak);
  const bars = next.map((x) => `<div class="b" style="height:${(x / top) * 100}%;background:${aqiInfo(x).color}"></div>`).join("");
  const dayLabels = [];
  times.forEach((t, k) => { if (k === 0 || hourOf(t) === 0) dayLabels.push(`<span style="position:absolute;left:${(k / times.length) * 100}%">${k === 0 ? "Now" : dayName(t)}</span>`); });
  const summary = peak <= 50
    ? `Stays in the good range. Highest is ${r(peak)} on ${dayLong(times[pi])} around ${hourLabel(hourOf(times[pi]))}.`
    : `Reaches ${peakInfo.name.toLowerCase()} levels (${r(peak)}) on ${dayLong(times[pi])} around ${hourLabel(hourOf(times[pi]))}.`;

  // Pollutants, last 24 hours
  const polls = POLLUTANTS.map((p) => {
    const series = h[p.key].slice(Math.max(0, i0 - 23), i0 + 1).filter((x) => x != null);
    const mn = Math.min(...series), mx = Math.max(...series), rg = mx - mn || 1;
    const spark = path(series.map((y, k) => [(k / Math.max(1, series.length - 1)) * 100, 28 - ((y - mn) / rg) * 26]));
    const val = c[p.key] ?? series[series.length - 1] ?? 0;
    const lvl = pollLevel(p, val);
    const shown = p.key === "aerosol_optical_depth" ? val.toFixed(2) : val < 10 ? val.toFixed(1) : r(val);
    return `<div class="poll"><div class="row"><b>${p.name}</b><span style="color:${lvl.color}">${lvl.word}</span></div>
      <div class="row"><div><span class="val">${shown}</span> <span class="tiny">${p.unit}</span></div>
      <svg viewBox="0 0 100 30" preserveAspectRatio="none" aria-hidden="true"><path d="${spark}" fill="none" stroke="var(--chart-mid)" stroke-width="1.5" vector-effect="non-scaling-stroke"/></svg></div></div>`;
  }).join("");

  el.innerHTML = `
    ${card(4, "Air quality index", `
      <div style="display:flex;align-items:baseline;gap:14px;flex-wrap:wrap"><span class="aqi-big">${r(v)}</span><span style="font-size:28px;font-weight:600;color:${info.color}">${info.name}</span></div>
      <div style="display:flex;flex-direction:column;gap:6px"><div class="aqi-scale lg"><i style="left:${aqiPos(v)}%"></i></div>
      <div class="axis" style="font-size:11px"><span>0</span><span>50</span><span>100</span><span>150</span><span>200</span><span>300</span></div></div>
      <p class="sub" style="margin-top:auto;font-size:15px">${info.advice}</p>`, "US AQI")}
    ${card(8, "Next 3 days · hourly", `
      <div class="headline">${summary}</div>
      <div class="aq-chart">${bars}<div class="ref" style="bottom:${(50 / top) * 100}%"><span>50 · Moderate</span></div></div>
      <div style="position:relative;height:16px;font-size:12px" class="muted">${dayLabels.join("")}</div>`)}
    ${card(12, "Pollutants · last 24 h", `<div class="pollutants">${polls}</div>`, "Current value, with the past 24 hours as a line")}`;
}

// ---------- 16-day ----------
function renderOutlook() {
  const d = state.fc.daily;
  const n = d.time.length;
  const tMin = Math.min(...d.temperature_2m_min) - 2, tMax = Math.max(...d.temperature_2m_max) + 2, H = 220;
  const cols = d.time.map((t, i) => {
    const hi = d.temperature_2m_max[i], lo = d.temperature_2m_min[i], p = d.precipitation_probability_max[i] || 0;
    const op = i < 7 ? 1 : i < 11 ? 0.72 : 0.5;
    return `<div class="d16 ${i === 0 ? "today" : ""}" style="opacity:${op}">
      <b>${i ? dayName(t) : "Today"}</b><span class="tiny">${monthDay(t)}</span><span class="c">${cond(d.weather_code[i])}</span>
      <span style="font-size:17px;font-weight:600;margin-top:4px">${deg(hi)}</span>
      <div class="col"><i style="top:${((tMax - hi) / (tMax - tMin)) * H}px;height:${((hi - lo) / (tMax - tMin)) * H}px"></i></div>
      <span class="muted" style="font-size:14px">${deg(lo)}</span>
      <div class="pp"><i style="height:${Math.max(2, p * 0.5)}px"></i>${p}%</div></div>`;
  }).join("");

  const rain = d.precipitation_sum.map((v) => v || 0);
  const rainTotal = sum(rain), rMax = Math.max(...rain), rMaxI = rain.indexOf(rMax);
  const rainBars = rain.map((v, i) => `<div><span>${v >= 0.01 ? v.toFixed(2) : ""}</span><i style="height:${v ? Math.max(3, (v / Math.max(rMax, 0.1)) * 100) : 2}px;background:var(--cool)"></i><span>${dayName(d.time[i]).slice(0, 2)}</span></div>`).join("");
  const uvBars = d.uv_index_max.map((v, i) => `<div><span>${(v ?? 0).toFixed(1)}</span><i style="height:${((v ?? 0) / 11) * 100}px;background:var(--warm)"></i><span>${dayName(d.time[i]).slice(0, 2)}</span></div>`).join("");

  $("panel-outlook").innerHTML = `
    ${card(12, `16-day forecast · ${monthDay(d.time[0])} – ${monthDay(d.time[n - 1])}`, `<div class="scroll-x"><div class="days16">${cols}</div></div>`, "Days 8–16 fade as forecast confidence drops")}
    ${card(6, `Rain total · ${n} days`, `
      <div style="display:flex;align-items:baseline;gap:10px;flex-wrap:wrap"><span style="font-size:36px;letter-spacing:-.02em">${rainTotal.toFixed(2)} in</span>
      <span class="sub">${rMax >= 0.01 ? `Most falls ${dayLong(d.time[rMaxI])}, ${monthDay(d.time[rMaxI])}` : "No meaningful rain in the forecast"}</span></div>
      <div class="vbars">${rainBars}</div>`)}
    ${card(6, "UV max &amp; daylight", `
      <div style="display:flex;align-items:baseline;gap:10px;flex-wrap:wrap"><span style="font-size:36px;letter-spacing:-.02em">${hm(d.daylight_duration[0])}</span>
      <span class="sub">of daylight today, ${hm(d.daylight_duration[n - 1])} by ${monthDay(d.time[n - 1])}</span></div>
      <div class="vbars">${uvBars}</div>`)}`;
}

// ---------- History ----------
function renderHistory() {
  const el = $("panel-history");
  if (!state.fc) return;
  const today = state.fc.daily.time[0];
  const thisYear = +today.slice(0, 4);
  const hiToday = state.fc.daily.temperature_2m_max[0];

  // One year ago card (shared with Today)
  let lyBody = `<div class="loading">Loading…</div>`;
  if (state.ly && state.ly.error) lyBody = `<p class="sub">Unavailable.</p>`;
  else if (state.ly) {
    const ly = state.ly, diff = r(ly.hi - hiToday);
    lyBody = `<div style="display:flex;align-items:baseline;gap:10px"><span style="font-size:72px;font-weight:300;letter-spacing:-.04em;line-height:1">${deg(ly.hi)}</span><span style="font-size:22px" class="muted">/ ${deg(ly.lo)}</span></div>
      <p style="font-size:15px">${cond(ly.code)}. ${diff === 0 ? "Same high as today's forecast." : `${Math.abs(diff)}° ${diff > 0 ? "warmer" : "cooler"} than today's forecast.`}</p>
      <div class="tiles2">
        <div class="inner"><span class="k">Rain</span><span class="v">${ly.rain.toFixed(2)} in</span></div>
        <div class="inner"><span class="k">Max wind</span><span class="v">${r(ly.wind)} mph ${compass(ly.dir)}</span></div>
        <div class="inner"><span class="k">Humidity</span><span class="v">${r(ly.rh)}%</span></div>
        <div class="inner"><span class="k">Sunshine</span><span class="v">${(ly.sun / 3600).toFixed(1)} h</span></div>
      </div>`;
  }
  const lyCard = card(4, `One year ago · ${fullDate(today)}, ${thisYear - 1}`, lyBody);

  if (!state.hist) {
    el.innerHTML = `
      ${card(8, `High on ${fullDate(today)} · ${FIRST_HISTORY_YEAR}–${thisYear - 1}`, `<div class="loading" id="hist-progress">Loading ${thisYear - FIRST_HISTORY_YEAR} years of records…</div>`)}
      ${lyCard}
      ${card(12, `${thisYear} vs. ${thisYear - 1} · monthly mean`, `<div class="loading">Loading…</div>`)}`;
    return;
  }

  // Same date through the years
  const yrs = state.hist;
  let histBody = `<p class="sub">Historical data is unavailable right now.</p>`;
  if (yrs.length > 2) {
    const temps = yrs.map((y) => y[1]).concat(hiToday);
    const lo = Math.floor((Math.min(...temps) - 3) / 5) * 5, hi = Math.ceil((Math.max(...temps) + 3) / 5) * 5;
    const x = (y) => ((y - FIRST_HISTORY_YEAR) / (thisYear - FIRST_HISTORY_YEAR)) * 1000;
    const yy = (t) => 200 - ((t - lo) / (hi - lo)) * 200;
    const mean = avg(yrs.map((y) => y[1]));
    const n = yrs.length, mx = avg(yrs.map((y) => y[0]));
    const slope = sum(yrs.map(([a, b]) => (a - mx) * (b - mean))) / sum(yrs.map(([a]) => (a - mx) ** 2));
    const trend = path([[x(FIRST_HISTORY_YEAR), yy(mean + slope * (FIRST_HISTORY_YEAR - mx))], [x(thisYear), yy(mean + slope * (thisYear - mx))]]);
    const dots = yrs.map(([y, t]) => `M${x(y).toFixed(1)} ${yy(t).toFixed(1)} l0.01 0`).join(" ");
    const rec = yrs.reduce((a, b) => (b[1] > a[1] ? b : a));
    const pct = r((yrs.filter((y) => y[1] < hiToday).length / n) * 100);
    const ticks = [0, 1, 2, 3, 4].map((k) => r(hi - ((hi - lo) * k) / 4));
    const xt = [FIRST_HISTORY_YEAR, 1960, 1980, 2000, thisYear];
    histBody = `
      <div style="font-size:20px;font-weight:500">Today's forecast high of ${deg(hiToday)} is warmer than ${pct}% of the past ${n} years.</div>
      <div class="chart">
        <div class="yaxis">${ticks.map((t) => `<span>${t}°</span>`).join("")}</div>
        <div class="plot">
          <svg viewBox="0 0 1000 200" preserveAspectRatio="none" aria-hidden="true">
            <line x1="0" x2="1000" y1="${yy(mean)}" y2="${yy(mean)}" stroke="var(--faint)" stroke-dasharray="4 4" vector-effect="non-scaling-stroke"/>
            <path d="${dots}" stroke="var(--chart-mid)" stroke-width="6" stroke-linecap="round" fill="none" vector-effect="non-scaling-stroke"/>
            <path d="${trend}" stroke="var(--warm)" stroke-width="2" fill="none" vector-effect="non-scaling-stroke"/>
            <path d="M${x(thisYear)} ${yy(hiToday)} l0.01 0" stroke="var(--warm)" stroke-width="12" stroke-linecap="round" fill="none" vector-effect="non-scaling-stroke"/>
          </svg>
          <div class="note" style="left:${x(rec[0]) / 10}%;top:${yy(rec[1]) / 2}%;transform:translate(-50%,-150%);color:var(--text)">Record ${deg(rec[1])} (${rec[0]})</div>
          <div class="note" style="right:-6px;top:${yy(hiToday) / 2}%;transform:translate(0,-170%);font-size:12px;font-weight:600;color:var(--warm)">${thisYear} · ${deg(hiToday)}</div>
          <div class="note" style="left:4px;top:${yy(mean) / 2}%;transform:translateY(-130%)">Avg ${deg(mean)}</div>
        </div>
      </div>
      <div class="xaxis">${xt.map((y) => `<span>${y}</span>`).join("")}</div>
      <div class="legend"><span><i class="swatch" style="background:var(--chart-mid);border-radius:50%;width:8px;height:8px"></i>Each year's high</span><span><i class="swatch" style="background:var(--warm);height:2px"></i>Trend</span><span><i class="swatch" style="border-top:1px dashed var(--faint);height:0"></i>Average</span></div>`;
  }

  // Monthly means
  let monthsBody = `<p class="sub">Monthly data is unavailable right now.</p>`;
  const ms = state.months;
  if (ms && ms.length) {
    const all = ms.flatMap((m) => [m.now, m.last]);
    const base = Math.floor(Math.min(...all) / 10) * 10 - 5, top = Math.max(...all);
    const hgt = (t) => ((t - base) / (top - base)) * 130 + 4;
    const warmer = ms.filter((m) => m.now > m.last).length;
    const names = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
    monthsBody = `
      <div style="font-size:20px;font-weight:500">${warmer} of ${ms.length} months ran warmer than in ${thisYear - 1}</div>
      <div class="months">${ms.map((m) => {
        const diff = m.now - m.last;
        return `<div><span style="color:${diff > 0 ? "var(--warm)" : "var(--cool)"}">${diff > 0 ? "+" : ""}${diff.toFixed(1)}°</span>
          <div class="pair"><i style="height:${hgt(m.last)}px;background:var(--chart-soft)"></i><i style="height:${hgt(m.now)}px;background:var(--warm)"></i></div>
          <span>${names[m.m - 1]}</span></div>`;
      }).join("")}</div>
      <div class="legend"><span><i class="swatch" style="background:var(--chart-soft)"></i>${thisYear - 1}</span><span><i class="swatch" style="background:var(--warm)"></i>${thisYear}</span></div>`;
  }

  el.innerHTML = `
    ${card(8, `High on ${fullDate(today)} · ${FIRST_HISTORY_YEAR}–${thisYear - 1}`, histBody, "ERA5 reanalysis")}
    ${lyCard}
    ${card(12, `${thisYear} vs. ${thisYear - 1} · monthly mean temperature`, monthsBody, "Complete months only")}`;
}

// ---------- Solar ----------
function renderSolar() {
  const { current: c, hourly: h, daily: d } = state.fc;
  const today = d.time[0];
  const idx = hoursOfDay(today);
  const rise = hourOf(d.sunrise[0]), set = hourOf(d.sunset[0]) + 1;
  const dayIdx = idx.filter((i) => hourOf(h.time[i]) >= rise && hourOf(h.time[i]) <= set + 1);
  const hours = dayIdx.map((i) => hourOf(h.time[i]));
  const h0 = hours[0], h1 = hours[hours.length - 1];
  const vals = (k) => dayIdx.map((i) => h[k][i] || 0);
  const gti = vals("global_tilted_irradiance"), ghi = vals("shortwave_radiation"), dni = vals("direct_normal_irradiance"), dif = vals("diffuse_radiation");
  const yMax = Math.max(300, Math.ceil(Math.max(...gti, ...ghi, ...dni) / 300) * 300);
  // Hourly irradiance is the average over the preceding hour, so plot it at the half hour
  const sx = (hr) => ((hr - 0.5 - (h0 - 0.5)) / (h1 - h0)) * 1000;
  const sy = (w) => 300 - (w / yMax) * 300;
  const line = (arr) => path(arr.map((w, k) => [sx(hours[k]), sy(w)]));
  const ghiArea = `${line(ghi)} L${sx(h1)} 300 L${sx(h0)} 300 Z`;
  const nowHr = minutesOf(c.time) / 60;
  const nowX = clamp(sx(nowHr + 0.5), 0, 1000);
  const peak = Math.max(...gti), pk = gti.indexOf(peak);
  const xTicks = [];
  for (let t = h0; t <= h1; t += 3) xTicks.push(`<span>${hourLabel(t)}</span>`);

  const est = solarKWh(today), soFar = Math.min(est, solarKWh(today, c.time.slice(0, 13) + ":00"));
  const days7 = d.time.slice(0, 7).map((t) => ({ t, v: solarKWh(t) }));
  const best = days7.reduce((a, b) => (b.v > a.v ? b : a)), worst = days7.reduce((a, b) => (b.v < a.v ? b : a));
  const top7 = Math.max(...days7.map((x) => x.v), 1);
  const weekTotal = sum(days7.map((x) => x.v));
  const drop = best.v ? r((1 - worst.v / best.v) * 100) : 0;
  const nm = (t) => (t === today ? "Today" : dayLong(t));

  $("panel-solar").innerHTML = `
    ${card(8, "Irradiance today", `
      <div class="legend"><span><i class="swatch" style="background:var(--warm);height:3px"></i>Your panels (tilted ${TILT}°)</span><span><i class="swatch" style="background:var(--chart-soft)"></i>Global horizontal</span><span><i class="swatch" style="background:var(--chart-mid);height:3px"></i>Direct normal</span><span><i class="swatch" style="background:var(--cool);height:3px"></i>Diffuse</span></div>
      <div class="chart" style="min-height:260px;margin-top:14px">
        <div class="yaxis">${[1, 2 / 3, 1 / 3, 0].map((k) => `<span>${r(yMax * k)}</span>`).join("")}</div>
        <div class="plot">
          <svg viewBox="0 0 1000 300" preserveAspectRatio="none" aria-hidden="true">
            <path d="${ghiArea}" fill="var(--chart-soft)"/>
            <path d="${line(dni)}" fill="none" stroke="var(--chart-mid)" stroke-width="1.5" vector-effect="non-scaling-stroke"/>
            <path d="${line(dif)}" fill="none" stroke="var(--cool)" stroke-width="2" vector-effect="non-scaling-stroke"/>
            <path d="${line(gti)}" fill="none" stroke="var(--warm)" stroke-width="3" vector-effect="non-scaling-stroke"/>
            <line x1="${nowX}" x2="${nowX}" y1="0" y2="300" stroke="var(--text)" stroke-dasharray="3 3" vector-effect="non-scaling-stroke"/>
          </svg>
          <div class="note" style="left:${nowX / 10}%;top:0;transform:translateX(${nowX > 500 ? "-110%" : "10%"});color:var(--text)">Now · ${r(c.global_tilted_irradiance || 0)} W/m²</div>
          ${peak > 0 ? `<div class="note" style="left:${sx(hours[pk]) / 10}%;top:0;transform:translate(-50%,-130%);font-size:12px;font-weight:600;color:var(--warm)">Peak ${r(peak)} W/m² around ${hourLabel(hours[pk] - 1).replace(" ", "")}–${hourLabel(hours[pk]).replace(" ", "")}</div>` : ""}
        </div>
      </div>
      <div class="xaxis">${xTicks.join("")}</div>`, "W/m²")}
    ${card(4, "Your array", `
      <div class="chips"><span class="chip">${ARRAY_KW.toFixed(1)} kW</span><span class="chip">Tilt ${TILT}°</span><span class="chip">Facing south</span></div>
      <div style="margin-top:6px"><div class="sub">Estimated output today</div><div style="display:flex;align-items:baseline;gap:8px"><span class="solar-big">${est.toFixed(1)}</span><span style="font-size:20px" class="muted">kWh</span></div></div>
      <div style="display:flex;flex-direction:column;gap:6px"><div style="display:flex;justify-content:space-between;font-size:13px" class="muted"><span>Generated so far</span><span>${soFar.toFixed(1)} kWh · ${est ? r((soFar / est) * 100) : 0}%</span></div><div class="progress"><i style="width:${est ? (soFar / est) * 100 : 0}%"></i></div></div>
      <div class="tiles2">
        <div class="inner"><span class="k">Sunshine</span><span class="v">${(d.sunshine_duration[0] / 3600).toFixed(1)} of ${(d.daylight_duration[0] / 3600).toFixed(1)} h</span></div>
        <div class="inner"><span class="k">Peak power</span><span class="v">${((peak / 1000) * ARRAY_KW * SYSTEM_EFFICIENCY).toFixed(1)} kW</span></div>
      </div>
      <p class="tiny">Estimate: tilted irradiance × ${ARRAY_KW} kW × ${SYSTEM_EFFICIENCY * 100}% system efficiency. Not measured output.</p>`)}
    ${card(8, "Estimated production · next 7 days", `<div class="solar7">${days7.map((x) => `<div><b>${x.v.toFixed(1)}</b><i style="height:${(x.v / top7) * 140 + 2}px;background:${x === best ? "var(--warm)" : x.v < best.v * 0.5 ? "var(--chart-soft)" : "color-mix(in oklch, var(--warm) 55%, transparent)"}"></i><span>${x.t === today ? "Today" : dayName(x.t)}</span></div>`).join("")}</div>`, "kWh per day")}
    ${card(4, "This week", `
      <div style="font-size:20px;font-weight:500;line-height:1.35">${nm(best.t)} is the best day for solar, at about ${best.v.toFixed(1)} kWh.${drop >= 20 ? ` ${nm(worst.t)} produces the least, about ${drop}% less.` : " Output stays fairly steady all week."}</div>
      <div class="sub" style="margin-top:auto">Week total ≈ ${r(weekTotal)} kWh</div>`)}`;
}

// ---------- Shell ----------
function renderHeader() {
  const { loc } = state;
  $("place").textContent = loc.region ? `${loc.name}, ${loc.region}` : loc.name;
  const hr = new Date().getHours();
  $("greeting").textContent = `${hr < 12 ? "Good morning" : hr < 17 ? "Good afternoon" : "Good evening"}, ${NAME}`;
  if (state.fc) {
    $("clock").textContent = new Date().toLocaleString("en-US", {
      weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit",
      timeZone: state.fc.timezone, timeZoneName: "short",
    }).replace(/, (\d)/, " · $1");
    document.documentElement.dataset.sky = pickSky();
  }
}

function renderAll() {
  renderHeader();
  renderToday();
  renderAir();
  renderOutlook();
  renderHistory();
  renderSolar();
}

function showStatus(msg) {
  const el = $("status");
  el.textContent = msg;
  el.hidden = !msg;
}

function setTab(tab) {
  if (!["today", "air", "outlook", "history", "solar"].includes(tab)) tab = "today";
  state.tab = tab;
  document.querySelectorAll("[data-tab]").forEach((b) => b.setAttribute("aria-selected", String(b.dataset.tab === tab)));
  document.querySelectorAll(".panel").forEach((p) => (p.hidden = p.id !== `panel-${tab}`));
  if (tab === "history") loadHistory();
}

function setTheme(choice) {
  const root = document.documentElement;
  if (choice === "system") delete root.dataset.theme;
  else root.dataset.theme = choice;
  write("theme", choice);
  document.querySelectorAll("[data-theme-choice]").forEach((b) => b.setAttribute("aria-checked", String(b.dataset.themeChoice === choice)));
}

function setUnit(unit, reload = true) {
  state.unit = unit;
  write("unit", unit);
  document.querySelectorAll("[data-unit]").forEach((b) => b.setAttribute("aria-checked", String(b.dataset.unit === unit)));
  if (reload) loadAll();
}

// Tabs use the URL hash so each screen has its own link (#air, #history, ...)
document.querySelectorAll("[data-tab]").forEach((b) => b.addEventListener("click", () => { location.hash = b.dataset.tab; }));
window.addEventListener("hashchange", () => setTab(location.hash.slice(1)));
document.querySelectorAll("[data-theme-choice]").forEach((b) => b.addEventListener("click", () => setTheme(b.dataset.themeChoice)));
document.querySelectorAll("[data-unit]").forEach((b) => b.addEventListener("click", () => setUnit(b.dataset.unit)));

// City search (Open-Meteo geocoding)
const results = $("results");
let searchTimer;
$("query").addEventListener("input", (e) => {
  clearTimeout(searchTimer);
  const q = e.target.value.trim();
  if (q.length < 2) { results.hidden = true; return; }
  searchTimer = setTimeout(() => search(q), 300);
});
$("search").addEventListener("submit", (e) => {
  e.preventDefault();
  results.querySelector("li")?.click();
});
document.addEventListener("click", (e) => {
  if (!e.target.closest("#search")) results.hidden = true;
});

async function search(q) {
  try {
    const data = await getJSON(API.geo, { name: q, count: 6 });
    const list = data.results || [];
    results.innerHTML = "";
    list.forEach((p) => {
      const li = document.createElement("li");
      li.tabIndex = 0;
      const small = document.createElement("small");
      small.textContent = [p.admin1, p.country].filter(Boolean).join(", ");
      li.append(`${p.name} `, small);
      li.onclick = () => {
        results.hidden = true;
        $("query").value = "";
        state.loc = { name: p.name, region: p.admin1 || p.country, lat: p.latitude, lon: p.longitude };
        renderHeader();
        loadAll();
      };
      li.onkeydown = (ev) => { if (ev.key === "Enter") li.click(); };
      results.appendChild(li);
    });
    results.hidden = list.length === 0;
  } catch (err) {
    console.error(err);
  }
}

// ---------- Start ----------
setTheme(read("theme", "system"));
setUnit(state.unit, false);
setTab(location.hash.slice(1));
renderHeader();
loadAll();
setInterval(renderHeader, 60 * 1000);
setInterval(loadAll, 15 * 60 * 1000);
