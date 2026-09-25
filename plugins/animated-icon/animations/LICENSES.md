# Animation sources

Every Lottie file the catalog manifests list, where it comes from, and its
license. Each baked catalog is derived from its manifest's files, so their
licenses apply to it too:

- `catalog.json` bakes the demo catalog, `../catalog/demo.mlvc`, and its copy in
  `../js/src/generated/catalog.ts`.
- `weather.json` bakes the weather-stations app catalog,
  `../catalog/weather.mlvc`.

| File                                                  | Source                                    | License                                    |
| ----------------------------------------------------- | ----------------------------------------- | ------------------------------------------ |
| `pulse.json`                                          | Written for this repository               | BSD-2-Clause, see the repository `LICENSE` |
| `pin.json`                                            | Written for this repository               | BSD-2-Clause, see the repository `LICENSE` |
| `meteocons/clear-day.json`                            | Meteocons by Bas Milius, `line/clear-day` | MIT, see `meteocons/LICENSE`               |
| `meteocons/flat/<name>.json` (12 files, listed below) | Meteocons by Bas Milius, `flat/<name>`    | MIT, see `meteocons/LICENSE`               |

Each manifest names every third-party file's `credit` and `license`. The baker
writes their notices into the demo's generated JS module as a `/*! */` comment,
which bundlers keep, and into `../catalog/weather.mlvc.LICENSE.txt`, which apps
ship beside the weather catalog. The native library embeds the demo catalog
without a notice, so whoever redistributes it must include `meteocons/LICENSE`.

## Meteocons

- Package: `@meteocons/lottie` 3.0.0-next.10 on npm
  (<https://registry.npmjs.org/@meteocons/lottie/-/lottie-3.0.0-next.10.tgz>,
  sha256 `12aaa45d679af3f8f1f20c45b95b493f538d9add1ae2371f75f7df6c857bc9d0`).
  Upstream repository: <https://github.com/basmilius/meteocons>. The npm
  `latest` release, 0.1.0, ships no LICENSE file; this prerelease does.
- `meteocons/clear-day.json` is `package/line/clear-day.json` (sha256
  `73b98ad21f416edde13ac572429e416efd976f90d4a0383a84510c5d094a5269`),
  reformatted by dprint; its data is unchanged.
- `meteocons/LICENSE` is `package/LICENSE`, unchanged.

The demo's `clear-day` comes from the line set because M0's profile baked no
masks, dashes or gradients: of the 519 line icons in this release, 151 bake
under it, and the other 368 need masks (349), dashed strokes (21) or gradients
(4), some more than one.

### Flat set

The weather catalog draws the flat style. On a map at 32 to 48 px, the line
set's clouds are pale outline rings that vanish, and the fill set draws the same
shapes as flat plus a gradient and a 1 px outline on every cloud: 3 to 5 times
the curve visits per pixel, for no visible difference at 48 px, and its bolt
icons also need opacity isolation. The flat files need the baker's Core tier:
subtract masks at full opacity with animated paths (`overcast`,
`partly-cloudy-day` and `partly-cloudy-night`) and a dashed stroke whose offset
marches (`wind`). None uses gradients. Every file is a 128×128 canvas at 60 fps
with a 6 s loop, and all of them draw near-white clouds, so they need a dark
basemap.

| File                                      | Source                                  | Package file sha256                                                | Changes                               |
| ----------------------------------------- | --------------------------------------- | ------------------------------------------------------------------ | ------------------------------------- |
| `meteocons/flat/clear-day.json`           | `package/flat/clear-day.json`           | `a28caaf9bf54b786b48dd15755f8d1270d6509f3e18bdc403113ff48f5c74c88` | reformatted by dprint; data unchanged |
| `meteocons/flat/clear-night.json`         | `package/flat/clear-night.json`         | `dc20e67c010b02057e0ee1ebea4e0a68569fcd38279e5c7418aa9f652b755128` | reformatted by dprint; data unchanged |
| `meteocons/flat/partly-cloudy-day.json`   | `package/flat/partly-cloudy-day.json`   | `83123c2c78493c26b6ab87e89ae742430dad22ef59616e3454d3efbb042d9d32` | reformatted by dprint; data unchanged |
| `meteocons/flat/partly-cloudy-night.json` | `package/flat/partly-cloudy-night.json` | `62db05898557ea1e7aae87a96a2d5fb063d27500f9a8b32e239dbd2ab34c818e` | reformatted by dprint; data unchanged |
| `meteocons/flat/overcast.json`            | `package/flat/overcast.json`            | `21efe645cee49ac3c2090859cb0d81672ff03556a253cb80392c59c83de83b5f` | reformatted by dprint; data unchanged |
| `meteocons/flat/fog.json`                 | `package/flat/fog.json`                 | `1fa5fad5a59b2129b000e49565d6a0a8fcfc8a79c775bfac5e2d7bce9df705d3` | reformatted by dprint; data unchanged |
| `meteocons/flat/drizzle.json`             | `package/flat/drizzle.json`             | `548ee79ed2769242efcc148a08524bcc4f50d11515af9416aa146e8ed4c2e42e` | reformatted by dprint; data unchanged |
| `meteocons/flat/rain.json`                | `package/flat/rain.json`                | `c514422722fa3c3e36c01f551cc76e5d3a5b19282b7e267590e1f5ad4b9dcb0c` | reformatted by dprint; data unchanged |
| `meteocons/flat/sleet.json`               | `package/flat/sleet.json`               | `c665091144ce05d713878afbe86dde225272a548e3662d5bc8314f1b283ecc4e` | reformatted by dprint; data unchanged |
| `meteocons/flat/snow.json`                | `package/flat/snow.json`                | `822d02500dd10d5c22ebc68f34bec2f250e54bd68654f340db6435a4c1551081` | reformatted by dprint; data unchanged |
| `meteocons/flat/thunderstorms-rain.json`  | `package/flat/thunderstorms-rain.json`  | `fa55e531f90267e093efc212a8edb873197e64e1ee11a5ef07d3d48f17ec3adf` | reformatted by dprint; data unchanged |
| `meteocons/flat/wind.json`                | `package/flat/wind.json`                | `a8b94b02f3b9f683d0bedda8cbe222025f765df035426ba80339a8cc4b79de3d` | reformatted by dprint; data unchanged |
