// Default location: Clyde, Texas (coordinates from Open-Meteo geocoding)
const DEFAULT = { name: "Clyde", region: "Texas", lat: 32.40596, lon: -99.49369 };

// WMO weather codes -> label + icon
const WMO = {
  0: ["Clear", "☀️", "🌙"], 1: ["Mostly Clear", "🌤️", "🌙"], 2: ["Partly Cloudy", "⛅", "☁️"], 3: ["Overcast", "☁️", "☁️"],
  45: ["Fog", "🌫️"], 48: ["Freezing Fog", "🌫️"],
  51: ["Light Drizzle", "🌦️"], 53: ["Drizzle", "🌦️"], 55: ["Heavy Drizzle", "🌧️"],
  56: ["Freezing Drizzle", "🌧️"], 57: ["Freezing Drizzle", "🌧️"],
  61: ["Light Rain", "🌦️"], 63: ["Rain", "🌧️"], 65: ["Heavy Rain", "🌧️"],
  66: ["Freezing Rain", "🌧️"], 67: ["Freezing Rain", "🌧️"],
  71: ["Light Snow", "🌨️"], 73: ["Snow", "🌨️"], 75: ["Heavy Snow", "❄️"], 77: ["Snow Grains", "🌨️"],
  80: ["Showers", "🌦️"], 81: ["Showers", "🌧️"], 82: ["Heavy Showers", "🌧️"],
  85: ["Snow Showers", "🌨️"], 86: ["Snow Showers", "❄️"],
  95: ["Thunderstorm", "⛈️"], 96: ["Thunderstorm, Hail", "⛈️"], 99: ["Thunderstorm, Hail", "⛈️"],
};

const label = (code) => (WMO[code] || ["Unknown"])[0];
const icon = (code, isDay = 1) => {
  const w = WMO[code] || ["", "❔"];
  return !isDay && w[2] ? w[2] : w[1];
};

const $ = (id) => document.getElementById(id);
const round = (n) => Math.round(n);

async function loadWeather({ name, region, lat, lon }) {
  $("place").textContent = region ? `${name}, ${region}` : name;
  $("condition").textContent = "Loading…";

  const params = new URLSearchParams({
    latitude: lat,
    longitude: lon,
    current: "temperature_2m,apparent_temperature,relative_humidity_2m,weather_code,wind_speed_10m,precipitation,is_day",
    hourly: "temperature_2m,weather_code,is_day",
    daily: "weather_code,temperature_2m_max,temperature_2m_min",
    temperature_unit: "fahrenheit",
    wind_speed_unit: "mph",
    precipitation_unit: "inch",
    timezone: "auto",
    forecast_days: 7,
    forecast_hours: 24,
  });

  try {
    const res = await fetch(`https://api.open-meteo.com/v1/forecast?${params}`);
    if (!res.ok) throw new Error(res.status);
    render(await res.json());
  } catch (err) {
    $("condition").textContent = "Unable to load weather.";
    console.error(err);
  }
}

function render({ current: c, hourly: h, daily: d }) {
  $("temp").textContent = `${round(c.temperature_2m)}°`;
  $("condition").textContent = label(c.weather_code);
  $("range").textContent = `H:${round(d.temperature_2m_max[0])}°  L:${round(d.temperature_2m_min[0])}°`;
  $("feels").textContent = `${round(c.apparent_temperature)}°`;
  $("humidity").textContent = `${c.relative_humidity_2m}%`;
  $("wind").textContent = `${round(c.wind_speed_10m)} mph`;
  $("precip").textContent = `${c.precipitation} in`;

  // Background theme
  const code = c.weather_code;
  document.body.className = !c.is_day ? "night" : code >= 51 ? "rain" : code >= 3 ? "cloudy" : "";

  // Hourly
  $("hourly").innerHTML = h.time
    .map((t, i) => {
      const hr = new Date(t).toLocaleTimeString([], { hour: "numeric" });
      return `<div class="hour">
        <span>${i === 0 ? "Now" : hr}</span>
        <span class="icon">${icon(h.weather_code[i], h.is_day[i])}</span>
        <span>${round(h.temperature_2m[i])}°</span>
      </div>`;
    })
    .join("");

  // Daily with temperature range bars
  const min = Math.min(...d.temperature_2m_min);
  const max = Math.max(...d.temperature_2m_max);
  const span = max - min || 1;
  $("daily").innerHTML = d.time
    .map((t, i) => {
      const day = i === 0 ? "Today" : new Date(`${t}T12:00`).toLocaleDateString([], { weekday: "short" });
      const lo = d.temperature_2m_min[i];
      const hi = d.temperature_2m_max[i];
      const left = ((lo - min) / span) * 100;
      const width = ((hi - lo) / span) * 100;
      return `<li>
        <span>${day}</span>
        <span class="icon">${icon(d.weather_code[i])}</span>
        <div class="bar-row">
          <span class="lo">${round(lo)}°</span>
          <div class="bar"><span style="left:${left}%;width:${width}%"></span></div>
          <span>${round(hi)}°</span>
        </div>
      </li>`;
    })
    .join("");
}

// City search via Open-Meteo geocoding
const results = $("results");
let timer;

$("query").addEventListener("input", (e) => {
  clearTimeout(timer);
  const q = e.target.value.trim();
  if (q.length < 2) return (results.hidden = true);
  timer = setTimeout(() => search(q), 300);
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
    const res = await fetch(`https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(q)}&count=5`);
    const data = await res.json();
    const list = data.results || [];
    results.innerHTML = "";
    list.forEach((p) => {
      const li = document.createElement("li");
      li.tabIndex = 0;
      const sub = [p.admin1, p.country].filter(Boolean).join(", ");
      const small = document.createElement("small");
      small.textContent = sub;
      li.append(`${p.name} `, small);
      li.onclick = () => {
        results.hidden = true;
        $("query").value = "";
        loadWeather({ name: p.name, region: p.admin1 || p.country, lat: p.latitude, lon: p.longitude });
      };
      li.onkeydown = (ev) => ev.key === "Enter" && li.click();
      results.appendChild(li);
    });
    results.hidden = list.length === 0;
  } catch (err) {
    console.error(err);
  }
}

loadWeather(DEFAULT);
