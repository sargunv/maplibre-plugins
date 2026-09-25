# Weather stations example

A synthetic weather snapshot for the `animated-icon` weather demo: 240 world
cities, each with a condition that picks a Meteocons animation from the weather
catalog. The gallery's "Weather stations" page and the native viewer's `weather`
task both load these files.

- `stations.geojson`: the fixture. One feature per line, so diffs stay small;
  dprint does not format `.geojson`. Feature ids run from 1 in order of
  prominence, so `["id"]` works both as a rank for zoom-dependent density and as
  a seed for per-feature phase. The ids are top-level, because the native map
  has no `promoteId`.
- `generate-stations.mjs`: writes it. The output is deterministic: `node
  generate-stations.mjs > stations.geojson` reproduces the file byte for byte.
  The script downloads the Natural Earth input from a pinned commit and checks
  its SHA-256.
- `layer.json`: the `animated-icon` layer. It picks each station's animation
  from `condition` and `is_day`, offsets each icon's phase by its id so
  neighbours do not play in step, plays windier stations faster, and grows the
  icons with zoom. Its filter thins the stations by rank: 40 below zoom 2, 80
  from zoom 2, 160 from zoom 3 and all 240 from zoom 4.
- `play-once.layer.json`: the same layer, except that every icon rests on its
  first frame until the app plays it once (see below).
- `labels.layer.json`: a symbol layer with each station's name and temperature,
  under the same filter. Only the gallery draws it.

The catalog is [`../../animations/weather.json`](../../animations/weather.json),
baked into `../../catalog/weather.mlvc`: 12 animations from the Meteocons flat
set. `clear` and `partly-cloudy` pick the day or night icon by `is_day`,
`thunderstorm` draws `thunderstorms-rain`, and every other condition draws the
animation of the same name.

## Properties

| Property         | Meaning                                                                                                   |
| ---------------- | --------------------------------------------------------------------------------------------------------- |
| `name`           | city name from Natural Earth                                                                              |
| `country`        | ISO 3166-1 alpha-2 code (alpha-3 where Natural Earth has none)                                            |
| `condition`      | `clear`, `partly-cloudy`, `overcast`, `fog`, `drizzle`, `rain`, `sleet`, `snow`, `thunderstorm` or `wind` |
| `is_day`         | whether the sun is up at the snapshot time                                                                |
| `temperature`    | °C                                                                                                        |
| `wind_speed`     | km/h                                                                                                      |
| `wind_direction` | degrees the wind blows from, in steps of 10                                                               |
| `cloud_cover`    | %                                                                                                         |
| `precipitation`  | mm/h                                                                                                      |

## Play once on hover

`play-once.layer.json` replaces the playback properties of `layer.json`:

```json
"icon-animation-mode": "once",
"icon-animation-speed": 1,
"icon-animation-speed-transition": { "duration": 0, "delay": 0 },
"icon-animation-offset": ["-", 0, ["number", ["feature-state", "start"], 8192]]
```

The playhead is `clock * speed + offset` seconds, where `clock` is the plugin
clock, which wraps within [0, 4096). A station with no `start` state has the
offset −8192, so its playhead is negative and the `once` icon shows its first
frame. Setting the station's `start` state to the current plugin clock starts
the playhead at 0: the icon plays once and holds its last frame. Setting it
again replays it. The zero-length speed transition keeps a switch from
`layer.json`'s paint from sweeping the playhead through the animation.

Take `start` from the plugin clock, never from wall time: the playhead counts on
that clock, and a wall-clock time such as `Date.now() / 1000` is far too large
for its 32-bit float. In the gallery:

```ts
import { clockSeconds } from "@maplibre-plugins/animated-icon";

let hovered: number | null = null;
map.on("mousemove", (event) => {
  const ids = layer.queryFeatures(event.point).map((f) => Number(f.id));
  const id = ids.length > 0 ? Math.min(...ids) : null;
  if (id !== null && id !== hovered) {
    map.setFeatureState({ source: "stations", id }, { start: clockSeconds() });
  }
  hovered = id;
});
```

Where icons overlap, the smallest id wins, so the gallery and the native viewer
pick the same station. Natively, read the clock with
`mln_animated_icon_clock_seconds()` and set `{"start": <clock>}` with
`mln_map_set_feature_state`; the viewer's `--play-once stations` flag does this
on hover, and replays on click:

```sh
mise run //apps/native-viewer:weather -- --layer ../../plugins/animated-icon/examples/weather/play-once.layer.json
```

When the clock wraps, about every 68 minutes, a played icon returns to its first
frame.

## Sources and license

- The station points are Natural Earth 1:50m populated places, v5.1.0 (commit
  `117488dc`), which is public domain. Cities are taken in order of population
  (national capitals count 4 times), skipping any within 500 km of a city
  already taken, until 240 are chosen.
- The weather is synthetic. It is not observed or forecast data. It is made up
  for the snapshot time 2026-01-15 15:00 UTC: smooth random fields with a fixed
  seed, shaped by a rough January climatology. The script's header explains the
  method.
- The fixture, the script and the layer files are covered by the repository's
  BSD-2-Clause license. The icons are Meteocons by Bas Milius, under the MIT
  license; see [`../../animations/LICENSES.md`](../../animations/LICENSES.md).
