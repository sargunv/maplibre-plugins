// Generates stations.geojson: a synthetic weather snapshot for the
// animated-icon weather demo. It is deterministic: the same inputs always
// give byte-identical output, so the checked-in file can be regenerated and
// compared.
//
//   node generate-stations.mjs [ne_50m_populated_places_simple.geojson] > stations.geojson
//
// Stations: world cities from Natural Earth 1:50m populated places (public
// domain), v5.1.0, pinned by commit and checked by SHA-256. Cities are taken
// greedily in order of population (national capitals count 4x), skipping any
// within MIN_KM of one already taken, until COUNT are chosen. Feature ids are
// that order, so ["id"] doubles as a prominence rank.
//
// Weather: not observed. Smooth random fields on the sphere (sums of plane
// waves with a fixed seed, wavelengths of roughly 2,500-6,500 km, the size of
// weather systems) are shaped by a crude January climatology: the ITCZ south
// of the equator, northern and southern storm tracks, subtropical dry belts
// and the big deserts, colder continental interiors in the northern winter,
// and altitude for a few highland capitals. Sun elevation at SNAPSHOT decides
// day or night; the diurnal cycle follows local solar time. Neighbouring
// stations therefore share weather, and the conditions follow latitude and
// season plausibly, but no value is a real observation.
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";

const NE_URL =
  "https://raw.githubusercontent.com/nvkelso/natural-earth-vector/117488dc884bad03366ff727eca013e434615127/geojson/ne_50m_populated_places_simple.geojson";
const NE_SHA256 =
  "8e70756b39fae9bcdc1e332bfc510c024c5edd3a13203ffd20092ee37b61d978";
const SNAPSHOT = "2026-01-15T15:00:00Z";
const SEED = 20260115;
const MIN_KM = 500;
const COUNT = 240;

/** Highland cities (m above sea level); lapse rate 6.5 °C per km. */
const ELEVATION_M = {
  "La Paz": 3640,
  Quito: 2850,
  Bogota: 2640,
  "Addis Ababa": 2355,
  "Mexico City": 2240,
  Sanaa: 2250,
  Asmara: 2325,
  Kabul: 1790,
  Nairobi: 1795,
  Thimphu: 2330,
  Kathmandu: 1400,
  Lhasa: 3650,
  Xining: 2275,
  Kunming: 1890,
  Denver: 1610,
  Johannesburg: 1750,
  Harare: 1490,
  Tehran: 1190,
  Lusaka: 1280,
  Kigali: 1567,
  Bishkek: 800,
  Ulaanbaatar: 1350,
  Cusco: 3400,
  Arequipa: 2335,
  Guatemala: 1500,
  "Guatemala City": 1500,
  "San Jose": 1170,
  Brasilia: 1170,
  Yerevan: 990,
  Windhoek: 1655,
  Gaborone: 1010,
  Antananarivo: 1280,
  Lilongwe: 1050,
};

// ------------------------------------------------------------------ input
async function loadPlaces(path) {
  let bytes;
  if (path) bytes = readFileSync(path);
  else if (existsSync("ne_50m_populated_places_simple.geojson")) {
    bytes = readFileSync("ne_50m_populated_places_simple.geojson");
  } else {
    const response = await fetch(NE_URL);
    if (!response.ok) throw new Error(`${NE_URL}: HTTP ${response.status}`);
    bytes = Buffer.from(await response.arrayBuffer());
  }
  const sha = createHash("sha256").update(bytes).digest("hex");
  if (sha !== NE_SHA256)
    throw new Error(
      `Natural Earth input has SHA-256 ${sha}, expected ${NE_SHA256}`,
    );
  return JSON.parse(bytes.toString("utf8")).features;
}

// ------------------------------------------------------------------ geometry
const RAD = Math.PI / 180;
const unit = (lon, lat) => [
  Math.cos(lat * RAD) * Math.cos(lon * RAD),
  Math.cos(lat * RAD) * Math.sin(lon * RAD),
  Math.sin(lat * RAD),
];
function km([lon1, lat1], [lon2, lat2]) {
  const h =
    Math.sin(((lat2 - lat1) * RAD) / 2) ** 2 +
    Math.cos(lat1 * RAD) *
      Math.cos(lat2 * RAD) *
      Math.sin(((lon2 - lon1) * RAD) / 2) ** 2;
  return 2 * 6371 * Math.asin(Math.sqrt(h));
}

// ------------------------------------------------------------------ random fields
function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const random = mulberry32(SEED);
/** A smooth field on the unit sphere with zero mean and unit variance. */
function field(waves = 12, minOmega = 6, maxOmega = 16) {
  const terms = [];
  for (let k = 0; k < waves; k++) {
    const z = 2 * random() - 1,
      phi = 2 * Math.PI * random(),
      r = Math.sqrt(1 - z * z);
    terms.push({
      d: [r * Math.cos(phi), r * Math.sin(phi), z],
      omega: minOmega + (maxOmega - minOmega) * random(),
      phase: 2 * Math.PI * random(),
      a: 0.5 + random(),
    });
  }
  const norm = Math.sqrt(terms.reduce((s, t) => s + (t.a * t.a) / 2, 0));
  return (v) =>
    terms.reduce(
      (s, t) =>
        s +
        t.a *
          Math.sin(
            t.omega * (t.d[0] * v[0] + t.d[1] * v[1] + t.d[2] * v[2]) + t.phase,
          ),
      0,
    ) / norm;
}
const precipField = field();
const cloudField = field();
const tempField = field(10, 4, 10);
const windField = field();
const pressureField = field(10, 4, 10);
const fogField = field(12, 10, 20);

// ------------------------------------------------------------------ climate
const gauss = (x, mu, sigma) => Math.exp(-(((x - mu) / sigma) ** 2));
const box = (lat, lon, [lat0, lat1], [lon0, lon1]) =>
  lat >= lat0 && lat <= lat1 && lon >= lon0 && lon <= lon1;

/** January wetness: positive where it tends to rain, negative where it rarely does. */
function wetness(lat, lon) {
  let w =
    1.1 * gauss(lat, -6, 11) +
    0.55 * gauss(lat, 52, 10) +
    0.45 * gauss(lat, -50, 8) -
    0.9 * gauss(lat, 25, 7) -
    0.6 * gauss(lat, -27, 7);
  if (box(lat, lon, [14, 34], [-18, 75])) w -= 1.3; // Sahara, Arabia, Thar
  if (box(lat, lon, [-32, -4], [-82, -69])) w -= 1.1; // Peru and Atacama coast
  if (box(lat, lon, [35, 49], [50, 92])) w -= 0.6; // Central Asian steppe
  if (box(lat, lon, [30, 55], [95, 125])) w -= 0.7; // dry Chinese and Mongolian winter
  if (box(lat, lon, [-35, -20], [15, 30])) w -= 0.3; // Kalahari
  return w;
}
/** January mean temperature at sea level, °C. */
function climate(lat, lon) {
  const a = Math.abs(lat);
  let t =
    lat >= 0
      ? lat < 15
        ? 26
        : 26 - 0.75 * (lat - 15)
      : a < 15
        ? 27
        : a < 35
          ? 27 - 0.2 * (a - 15)
          : 23 - 0.6 * (a - 35);
  if (box(lat, lon, [40, 72], [-30, 40]))
    t += 8 * Math.min(1, Math.max(0, (30 - lon) / 40)); // Gulf Stream: mild western Europe
  if (box(lat, lon, [35, 65], [-160, -120])) t += 6; // Pacific coast of North America
  if (box(lat, lon, [40, 72], [-115, -60]))
    t -= 7 + (box(lat, lon, [45, 72], [-115, -85]) ? 6 : 0); // North American interior, prairies
  if (box(lat, lon, [42, 75], [40, 180])) t -= 6 + 14 * gauss(lon, 125, 30); // Russian and Siberian interior
  if (box(lat, lon, [25, 55], [100, 145])) t -= 6; // East Asian winter monsoon
  return t;
}

// ------------------------------------------------------------------ sun
const snapshot = new Date(SNAPSHOT);
const utcHours = snapshot.getUTCHours() + snapshot.getUTCMinutes() / 60;
const dayOfYear = Math.floor(
  (snapshot - Date.UTC(snapshot.getUTCFullYear(), 0, 0)) / 86400000,
);
const declination = -23.44 * Math.cos(((2 * Math.PI) / 365) * (dayOfYear + 10));
function sun(lat, lon) {
  const solarHour = (((utcHours + lon / 15) % 24) + 24) % 24;
  const hourAngle = (solarHour - 12) * 15;
  const elevation =
    Math.asin(
      Math.sin(lat * RAD) * Math.sin(declination * RAD) +
        Math.cos(lat * RAD) *
          Math.cos(declination * RAD) *
          Math.cos(hourAngle * RAD),
    ) / RAD;
  return { solarHour, elevation };
}

// ------------------------------------------------------------------ one station
function weather(lon, lat, name) {
  const v = unit(lon, lat);
  const { solarHour, elevation } = sun(lat, lon);
  const isDay = elevation > -0.833;
  const precip = 0.9 * precipField(v) + wetness(lat, lon);
  const cloud = 0.6 * precip + 0.55 * cloudField(v);
  const cover = Math.round(Math.min(100, Math.max(0, 45 + 38 * cloud)));
  const diurnal =
    5 *
    (1 - (0.6 * cover) / 100) *
    Math.cos(((solarHour - 15) / 24) * 2 * Math.PI);
  const altitude = (ELEVATION_M[name] ?? 0) * -0.0065;
  const temperature = Math.round(
    climate(lat, lon) +
      altitude +
      diurnal +
      4 * tempField(v) -
      1.5 * Math.max(0, precip),
  );
  // Geostrophic-ish direction: along the isobars of a smooth pressure field,
  // lows on the left in the north and on the right in the south.
  const e = 1e-3;
  const dpdx =
    (pressureField(unit(lon + e / Math.max(0.05, Math.cos(lat * RAD)), lat)) -
      pressureField(unit(lon - e / Math.max(0.05, Math.cos(lat * RAD)), lat))) /
    (2 * e);
  const dpdy =
    (pressureField(unit(lon, lat + e)) - pressureField(unit(lon, lat - e))) /
    (2 * e);
  const s = lat >= 0 ? 1 : -1;
  const [u, w] = [-dpdy * s, dpdx * s];
  const windDirection =
    (Math.round(((((Math.atan2(-u, -w) / RAD) % 360) + 360) % 360) / 10) * 10) %
    360;
  const windSpeed = Math.round(
    Math.max(
      0,
      9 +
        8 * windField(v) +
        16 * gauss(Math.abs(lat), 52, 12) +
        7 * Math.max(0, precip),
    ),
  );

  let condition;
  let rate = 0;
  if (precip > 1.05) {
    if (temperature <= 0) condition = "snow";
    else if (temperature <= 2) condition = "sleet";
    else if (temperature >= 21 && precip > 1.55) condition = "thunderstorm";
    else if (precip > 1.3) condition = "rain";
    else condition = "drizzle";
    const excess = precip - 1.05;
    rate = {
      snow: 0.4 + 1.5 * excess,
      sleet: 0.6 + 1.5 * excess,
      thunderstorm: 6 + 12 * excess,
      rain: 1 + 5 * excess,
      drizzle: 0.1 + 0.6 * excess,
    }[condition];
  } else if (
    fogField(v) > 0.6 &&
    windSpeed < 20 &&
    cover > 30 &&
    (!isDay || solarHour < 10) &&
    temperature > -10 &&
    temperature < 20
  ) {
    condition = "fog";
  } else if (windSpeed >= 36) {
    condition = "wind";
  } else if (cover >= 80) condition = "overcast";
  else if (cover >= 35) condition = "partly-cloudy";
  else condition = "clear";
  const cloudCover =
    condition === "fog"
      ? 100
      : ["snow", "sleet", "rain", "drizzle", "thunderstorm"].includes(condition)
        ? Math.max(cover, 80)
        : condition === "overcast"
          ? cover
          : condition === "clear"
            ? Math.min(cover, 30)
            : cover;
  return {
    condition,
    isDay,
    temperature,
    windSpeed,
    windDirection,
    cloudCover,
    precipitation: Math.round(rate * 10) / 10,
  };
}

// ------------------------------------------------------------------ main
const places = (await loadPlaces(process.argv[2])).map((f) => ({
  p: f.properties,
  c: f.geometry.coordinates,
}));
const score = (x) => x.p.pop_max * (x.p.adm0cap ? 4 : 1);
places.sort((a, b) => score(b) - score(a) || a.p.ne_id - b.p.ne_id);
const chosen = [];
for (const place of places) {
  if (chosen.length >= COUNT) break;
  if (chosen.every((c) => km(c.c, place.c) >= MIN_KM)) chosen.push(place);
}
const round3 = (x) => Math.round(x * 1000) / 1000;
const features = chosen.map(({ p, c }, i) => {
  const name = p.name.replace(/\s+/g, " ").trim();
  const wx = weather(c[0], c[1], name);
  return {
    type: "Feature",
    id: i + 1,
    geometry: { type: "Point", coordinates: [round3(c[0]), round3(c[1])] },
    properties: {
      name,
      country: /^[A-Z]{2}$/.test(p.iso_a2 ?? "") ? p.iso_a2 : p.adm0_a3,
      condition: wx.condition,
      is_day: wx.isDay,
      temperature: wx.temperature,
      wind_speed: wx.windSpeed,
      wind_direction: wx.windDirection,
      cloud_cover: wx.cloudCover,
      precipitation: wx.precipitation,
    },
  };
});

// One feature per line: small diffs, and dprint leaves .geojson alone.
const header = {
  type: "FeatureCollection",
  snapshot: SNAPSHOT,
  synthetic: true,
  sources:
    "Stations: Natural Earth 1:50m populated places v5.1.0 (public domain). Weather: synthetic, from generate-stations.mjs; not observations.",
  units: {
    temperature: "°C",
    wind_speed: "km/h",
    wind_direction: "degrees, direction the wind blows from",
    cloud_cover: "%",
    precipitation: "mm/h",
  },
};
const head = JSON.stringify(header).slice(0, -1);
process.stdout.write(
  `${head},"features":[\n${features.map((f) => JSON.stringify(f)).join(",\n")}\n]}\n`,
);

const counts = {};
for (const f of features) {
  const k =
    f.properties.condition +
    (["clear", "partly-cloudy"].includes(f.properties.condition)
      ? f.properties.is_day
        ? "-day"
        : "-night"
      : "");
  counts[k] = (counts[k] ?? 0) + 1;
}
process.stderr.write(
  `${features.length} stations; ${JSON.stringify(counts)}\n`,
);
