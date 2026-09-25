# Animated icon

An `animated-icon` layer: Lottie animations playing at every point of a source,
like a symbol layer whose icons move. An offline baker turns the animations into
a catalog of vector frames, so neither runtime parses Lottie. Every point
becomes one quad, and the fragment shader computes the anti-aliased coverage of
the current frame's curves analytically, so icons stay crisp at any size, pixel
ratio or pitch.

The layer is tile-driven: point it at a vector or GeoJSON source and, for a
vector source, the point layer inside it. The native plugin renders on OpenGL,
Vulkan and Metal; the JS layer renders on WebGL 2 under mercator and globe
projections. This is milestone M1:

- Each feature picks its own animation, phase, speed and playback mode, and
  every paint property except the two alignments accepts feature, composite and
  feature-state expressions.
- Apps register their own catalogs; the demo catalog stays built in.
- Icons can play once on hover, restarted through feature-state.
- Rendered-feature queries and the JS `queryFeatures` find icons.
- The baker covers the Core tier: precomps, trims, dashes, repeaters, gradients,
  opaque masks and mattes, markers and color slots.

```json
{
  "id": "animated-icon",
  "type": "animated-icon",
  "source": "openmaptiles",
  "source-layer": "poi",
  "filter": ["<=", ["get", "rank"], 14],
  "paint": {
    "icon-animation": [
      "match",
      ["get", "class"],
      ["bus", "railway"],
      "pulse",
      "pin"
    ],
    "icon-anchor": [
      "match",
      ["get", "class"],
      ["bus", "railway"],
      "center",
      "bottom"
    ],
    "icon-size": ["interpolate", ["linear"], ["zoom"], 14, 0.8, 18, 1.2],
    "icon-animation-offset": ["*", ["%", ["to-number", ["id"], 0], 97], 0.137]
  }
}
```

That is [`examples/layer.json`](examples/layer.json): transit stops pulse, other
points of interest get a bouncing pin, and each icon's phase comes from its
feature id so neighbours do not play in step.

## How it works

1. **Baker.** `baker/` is a Node script that evaluates each Lottie file of a
   manifest (`animations/*.json`) at the entry's frame rate, following
   lottie-web's rules for keyframes, transforms, shapes, modifiers and draw
   order. Skia (`canvaskit-wasm`, at bake time only) outlines strokes and bakes
   masks and mattes into path booleans. Every outline becomes closed quadratic
   curves, within 0.2 device pixels of the source at the entry's largest display
   size. Shapes that only move, turn or scale between frames are stored once.
   The result is a `.mlvc` catalog whose format is in
   [`catalog/FORMAT.md`](catalog/FORMAT.md).
2. **Catalog.** Every frame of every animation stays resident in one RGBA32F
   data texture, `u_art`, 1024 or 2048 texels wide. A frame is a list of ops (up
   to 64): a bounding box, an affine map into the shape's local units, a shape,
   and a paint (solid, linear or radial gradient). Shapes and gradients are
   shared records, and each shape carries band lists that tell a pixel which of
   its curves can matter. A small uniform block, `IconCatalogUBO`, holds the
   clock and one 32-byte header per animation: anchor box, display size, loop
   rate, frame count and first frame
   ([FORMAT.md, "Header block"](catalog/FORMAT.md#header-block-and-shader-defines)).
3. **Layout.** Every point a tile owns becomes one quad: four vertices on the
   anchor. Points in the tile's buffer are dropped, so each is drawn once.
   Anchors are sorted by `y` so lower icons draw on top. Data-driven paint
   values ride along as vertex attributes; `shaders/properties.glsl` reads each
   property from its attribute or its uniform.
4. **Placement and timing.** `shaders/place.glsl` spreads the quad over the
   animation's anchor box as MapLibre places point-symbol icons. It applies
   size, anchor, offset, rotation, both alignments and the symbol perspective
   scaling, and grows the quad by one device pixel for the edge anti-aliasing.
   It also picks the frame: the playhead is `clock × speed + offset` seconds,
   and the mode loops it, bounces it or plays it once. An integer clamp keeps
   even a NaN playhead inside the animation
   ([FORMAT.md, "Timing"](catalog/FORMAT.md#timing)).
5. **Coverage.** `shaders/icon.glsl` walks the frame's ops, skips those whose
   box misses the pixel, and maps the pixel into the op's local units. There it
   casts a horizontal and a vertical ray (Slug's dual-ray method) through only
   the curves of the pixel's band, from the pixel outward, stopping at the first
   curve wholly behind the ray. It composites the ops source-over, recolors, and
   then applies `icon-opacity` to the finished icon, so a fading icon never
   shows its internal overlaps
   ([FORMAT.md, "Coverage"](catalog/FORMAT.md#coverage)). Every loop bound and
   texel row is clamped, so no value, however malformed, reads outside the
   texture or loops without bound.

## Baking animations

```bash
mise run bake         # rebake whatever is stale: catalogs, the demo's JS copy, the fixtures
mise run bake:check   # rebake everything in memory and fail on any byte difference (CI)
```

`mise run check` and the pre-commit hook only compare the hashes in
`catalog/stamps.json`: for each baked output, the hash of everything it is baked
from (manifest, Lottie and license files, the baker's sources, the JS catalog
reader, the canvaskit version) and the hash of what was written. That check
takes well under a second; a full bake of the demo and weather catalogs takes
about 6 s. The baker's CLI has two more modes:

```bash
node plugins/animated-icon/baker/src/cli.ts bake <manifest.json> [-o <out.mlvc>] [--fps <n>] [--notice <file>]
node plugins/animated-icon/baker/src/cli.ts census [--bake] [--sample <k>] <files or dirs...>
```

`bake` bakes an app's own manifest anywhere, without stamps. `census` sorts
Lottie files by the profile tier they need and, with `--bake`, bakes every
`k`-th file the profile accepts to measure how many really fit.

A manifest in `animations/` is baked by `mise run bake` when it has `output`:

| Field    | Meaning                                                                                              |
| -------- | ---------------------------------------------------------------------------------------------------- |
| `output` | the `.mlvc` to write, relative to the manifest                                                       |
| `js`     | a TypeScript module with the catalog as base64 and its credits in a `/*! */` comment (the demo only) |
| `notice` | a plain-text file with every entry's credit and license text, for catalogs apps ship (weather)       |
| `fps`    | the frame rate of entries without their own (default 60)                                             |

Each entry of `animations` becomes one `icon-animation` value, in file order
after `"none"`:

| Field          | Meaning                                                                                                                       |
| -------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| `name`         | the enum value styles use: `[a-z0-9][a-z0-9_#-]*`, never `none`                                                               |
| `file`         | the Lottie JSON, relative to the manifest                                                                                     |
| `displayPx`    | logical pixels of the anchor box's longer side at `icon-size` 1                                                               |
| `maxDisplayPx` | device pixels of that side at the largest size drawn; sets the curve tolerance (default `4 × displayPx`)                      |
| `box`          | the anchor box: by default the union of every frame's shapes, `"canvas"` for the Lottie canvas, or `[x0, y0, x1, y1]`         |
| `fps`          | this entry's frame rate                                                                                                       |
| `markers`      | `true`, or a list of names: add Lottie markers as entries named `<name>#<marker>`, each a window of the animation's frames    |
| `slots`        | `{ "primary": ["#e53935"], "secondary": [...] }`: solid colors (within ΔE 2) that `icon-color` recolors, or M2's second color |
| `tint`         | put every solid color in the primary slot                                                                                     |
| `ignore`       | profile feature ids to drop knowingly instead of rejecting, e.g. `["opacity-isolation"]`                                      |
| `heavy`        | accept an animation over the cost or size limits                                                                              |
| `credit`       | for third-party art: who made it and where it comes from                                                                      |
| `license`      | for third-party art: its license file, relative to the manifest; the JS module or notice file carries it                      |

An unknown or malformed field fails the bake with an error naming it, and the
baker parses its own output with the runtimes' reader before writing it.

The baker accepts the **Core** profile tier:

- **Core-0**: shape, null and solid layers with parenting; `ip`/`op` and hidden
  items; transforms including skew and split position; bezier, hold and spatial
  keyframes; groups, paths with morphs, rectangles, ellipses and stars; nonzero
  and even-odd fills; strokes with their caps, joins and miter limits; animated
  colors and opacities.
- **Core**: precomps with their start time, stretch and time remap, as long as
  their content stays inside the precomp's bounds; auto-orient; trim paths in
  both modes; dashes with any number of pairs; repeaters; round corners;
  `loopIn` and `loopOut` expressions (the whole expression, literal arguments);
  linear and radial gradients with up to 8 stops; opaque masks (add, subtract,
  intersect, inverted, expanded) and opaque alpha mattes, baked into the shapes
  as path booleans; color slots (`"sid": "primary"` or `"secondary"`); and
  markers. Merge paths mode 1 is accepted and ignored, as lottie-web does.

Anything else is an error, never a silent approximation. The error names the
JSON path, the feature and the profile tier that would add it, for example
`layers[3].ks.o: translucent layers or groups over overlapping shapes need
profile tier Composite (M3); or ignore it to fold the opacity into each shape
(ignore id "opacity-isolation")`. Listing the id in `ignore` drops that feature
instead. Inert data, such as expression controls and markers that no entry asks
for, is noted in the report.

Before writing, the baker checks each animation's cost and size and prints a
report:

- **Cost.** Curve visits per pixel of the costliest frame, measured by
  `baker/src/shade.ts`, the CPU twin of the fragment shader; above 16 it warns,
  and above 64 it fails unless `heavy` is set. The report also converts this to
  microseconds per icon. That figure is a design-research estimate for a
  UBO-reading port on an Apple M5; the M1 texture shader is unmeasured.
- **Size.** An animation over 1 MB fails unless `heavy` is set, with a hint to
  bake at `--fps 30`. The catalog must fit a 2048 × 2048 texture.
- **Structure.** At most 64 ops per frame and 256 curves per band.

The demo catalog is 0.35 MB: `pulse` costs 9.4 visits per pixel, `pin` 6.6 and
`clear-day` 3.1. The weather catalog is 0.60 MB, at most 3.7 visits per pixel
except `sleet` and `snow` (5.8 and 5.7).

**Coverage of real animations.** The Core tier accepts all 519 files of each
Meteocons set (flat, line, fill and monochrome). Baking every eighth file at 30
fps, every sampled flat, line and monochrome file bakes; 36 of 65 fill files do,
and the other 29 need isolated group opacity (Composite). Of the 40 animations
in the design's corpus of files from the web, 25 (63%) pass the profile and 19
(48%) bake. The profile turns away 13 canvases over 512 px, a blend mode, an
effect and a general expression; the bake turns away isolated opacity (3 files),
83 draws in one frame, a precomp overflowing its bounds and a translucent matte.

**Fidelity.** Baked frames 0, 1/3 and 2/3 of each file, compared with
lottie-web's SVG renderer, give each Core feature this lowest PSNR. Real files
come from the design's corpus (`files/`) or Meteocons fill (`fill/`); features
that no real, bakeable file uses are checked on synthetic files only. Frames
that both renderers draw identically are left out.

| Feature                                | Real file                              | Real    | Synthetic |
| -------------------------------------- | -------------------------------------- | ------- | --------- |
| precomps                               | `files/pulse-material_loader`          | 37.3 dB | 46.8 dB   |
| time remap                             |                                        |         | 46.8 dB   |
| auto-orient                            | `files/pulse-material_loader`          | 37.3 dB | 49.7 dB   |
| trim mode 1                            | `files/pin-tg_proximity_set`           | 32.5 dB | 40.0 dB   |
| trim mode 2                            |                                        |         | 39.2 dB   |
| dashes, one pair                       | `fill/umbrella-wind-alt`               | 36.8 dB |           |
| dashes, several pairs                  |                                        |         | 38.8 dB   |
| repeaters                              |                                        |         | 46.1 dB   |
| round corners                          |                                        |         | 44.5 dB   |
| `loopOut`                              | `files/pulse-loading_gradient_strokes` | 38.9 dB | 47.6 dB   |
| `loopIn`                               |                                        |         | 47.6 dB   |
| linear gradients                       | `fill/avalanche-danger-alert`          | 40.5 dB | 37.9 dB   |
| radial gradients                       |                                        |         | 47.6 dB   |
| color slots                            |                                        |         | 40.5 dB   |
| markers                                |                                        |         | 41.3 dB   |
| add masks                              | `fill/avalanche-danger-alert`          | 40.5 dB |           |
| subtract masks                         | `fill/extreme-day-drizzle`             | 36.7 dB |           |
| intersect, inverted and expanded masks |                                        |         | 45.0 dB   |
| alpha mattes                           | `files/wx-day_night_cycle`             | 36.6 dB | 40.5 dB   |
| inverted alpha mattes                  |                                        |         | 39.4 dB   |

The synthetic linear gradient is a gradient stroke. The weather icons score
36.3–40.5 dB and the demo's 36.4–43.2 dB. No file scores under 30 dB.

## Paint properties

The full property table, with bounds and docs, is [spec.json](spec.json).

| Property                  | Type     | Default     | Expressions | `-transition` |
| ------------------------- | -------- | ----------- | ----------- | ------------- |
| `icon-animation`          | enum     | `"none"`    | data-driven | no            |
| `icon-size`               | float    | `1`         | data-driven | yes           |
| `icon-rotate`             | rotation | `0`         | data-driven | yes           |
| `icon-opacity`            | float    | `1`         | data-driven | yes           |
| `icon-color`              | color    | transparent | data-driven | yes           |
| `icon-offset`             | float2   | `[0, 0]`    | data-driven | yes           |
| `icon-anchor`             | enum     | `"center"`  | data-driven | no            |
| `icon-rotation-alignment` | enum     | `"auto"`    | camera      | no            |
| `icon-pitch-alignment`    | enum     | `"auto"`    | camera      | no            |
| `icon-animation-speed`    | float    | `1`         | data-driven | yes           |
| `icon-animation-offset`   | float    | `0`         | data-driven | yes           |
| `icon-animation-mode`     | enum     | `"loop"`    | data-driven | no            |

"Data-driven" takes constants and zoom, feature, composite and feature-state
expressions; "camera" takes constants and zoom expressions.

- **`icon-animation`** takes `"none"` or a catalog name, markers included. A
  literal the catalog lacks is a style error; an expression that evaluates to an
  unknown name draws nothing.
- **Size.** `icon-size` scales the entry's `displayPx`.
- **Offset.** `icon-offset` is `[right, down]` logical pixels, scaled by the
  size, and turns with `icon-rotate`.
- **Anchor and alignment.** `icon-anchor`, `icon-rotation-alignment` and
  `icon-pitch-alignment` mean what they mean for symbol icons: auto rotation is
  viewport, and auto pitch follows the rotation alignment.
- **`icon-color`** recolors the `primary` slot. Its alpha is the strength: at 0
  the authored colors stay, and at 1 the hue is replaced while each shape keeps
  its own alpha.
- **`icon-opacity`** applies to the composited icon.
- **Playback.** `icon-animation-speed` multiplies the playback rate, clamped to
  −4..4; 0 holds the frame at the offset, and negative plays backwards.
  `icon-animation-offset` adds seconds to the playhead: a per-feature value such
  as `["id"]` desynchronizes icons. `icon-animation-mode` is `loop`, `alternate`
  (forward, then backward) or `once` (the first frame before the playhead
  reaches 0, the last frame after one loop).

Numeric, rotation, color and offset changes animate over the transition
duration, but only between constants. A change to a data-driven value snaps at
once. A change from one to a constant keeps the old per-feature values until the
transition ends and then switches, natively as well; give it a zero-duration
`-transition` to switch at once. A constant speed change therefore sweeps the
playhead through `clock × Δspeed` seconds while it transitions, which strobes;
give the switch `"icon-animation-speed-transition": {"duration": 0}` to jump
instead. Enum properties take no `-transition`. MapLibre Native still holds
their old value until the style's transition ends (300 ms by default) and then
switches, and the JS layer does the same. The JS layer switches at once when
`setPaintProperty` gets a zero duration; natively only a zero style transition
does. A speed or offset expression that returns NaN or an infinity still draws
some frame of the animation: both sides pass the value to the shader, whose
integer clamp keeps the frame inside the animation.

## The clock and playing once

Icons play on the plugin's clock: seconds since its first read (natively) or
page load (JS), wrapped into [0, 4096). Read it with `clockSeconds()` in JS or
`mln_animated_icon_clock_seconds()` natively. For deterministic renders, such as
tests and screenshots, pin it with `setClockOverride(seconds)` or
`mln_animated_icon_set_clock(seconds)`; `null` or NaN restores the live clock.

To play an icon once on demand, rest it with a negative playhead and restart it
through feature-state:

```json
"icon-animation-mode": "once",
"icon-animation-speed": 1,
"icon-animation-speed-transition": { "duration": 0, "delay": 0 },
"icon-animation-offset": ["-", 0, ["number", ["feature-state", "start"], 8192]]
```

```ts
map.setFeatureState({ source: "stations", id }, { start: clockSeconds() });
```

Take `start` from the plugin clock, never from wall time: the playhead is a
32-bit float, and at `Date.now() / 1000` one step of it is two minutes. The
weather demo's [README](examples/weather/README.md#play-once-on-hover) has the
whole recipe, natively too.

## Hit testing

In JS, `layer.queryFeatures(point)` returns every icon under a screen point,
topmost first, as GeoJSON features with their source; `queryFeature(point)`
returns the topmost and `hitTest(point)` whether there is one. Natively,
`mln_render_session_query_rendered_features` finds the layer's icons through the
plugin's `query_feature` and `get_query_radius` callbacks. Both test the icon's
quad without the anti-aliasing pad, with the same placement math
(`native/src/place.zig` and `js/src/place.ts`, tested against
`fixtures/place/`). On the globe, the JS layer projects anchors as gl-js's globe
shaders do, through the transition to mercator too. The host evaluates
data-driven values at the tile's zoom for queries, and the JS layer mirrors it
(limit 12).

## App catalogs

The demo catalog (`pulse`, `pin`, `clear-day`) is built in. An app can bake its
own with `cli.ts bake` and register it instead:

- **Native:** call `mln_animated_icon_register_catalog(register_fn, bytes, size,
  error, capacity)` in place of `mln_animated_icon_register`. The plugin copies
  the bytes, parses and validates them, and lists the catalog's names as
  `icon-animation`'s values. A process holds one catalog (limit 1); registering
  the same bytes again is harmless, and different bytes fail with a conflict.
- **JS:** `const catalog = await loadCatalog(url)`, then pass `{ catalog }` to
  `AnimatedIconLayer.fromLayerJson` or the constructor. Each layer can have its
  own.

Both readers reject a malformed catalog with the same message, naming the first
problem, for example `animation 2 "pin": frame 7: op 3: shape: horizontal band
4: list entry 9 is not a curve index`.

## Native

```bash
mise run //plugins/animated-icon/native:build   # zig-out/lib/libmaplibre-animated-icon.*
mise run //plugins/animated-icon/native:test
```

| Symbol                               | Use                                                             |
| ------------------------------------ | --------------------------------------------------------------- |
| `mln_animated_icon_register`         | register the layer type with the built-in demo catalog          |
| `mln_animated_icon_register_catalog` | register it with an app catalog instead                         |
| `mln_animated_icon_clock_seconds`    | the animation clock, for feature-state starts                   |
| `mln_animated_icon_set_clock`        | pin the clock (tests, screenshots); NaN restores the live clock |

Register before loading a style that uses `animated-icon`, then add the layer
JSON above with the ordinary add-layer call. The build embeds
`catalog/demo.mlvc`; like an app catalog, it is parsed and validated at
registration. Registration lists the catalog's animations as `icon-animation`'s
values, generates the shaders' constants, and hands the catalog's texels to the
host as a static texture.

The plugin builds against the plugin ABI header alone and has no link dependency
on the host.

### Required native patches

From `patches/maplibre-native-ffi/` this plugin needs:

| Patch                                | Used for                                                                                   |
| ------------------------------------ | ------------------------------------------------------------------------------------------ |
| `0001` plugin animated layers        | `should_animate` keeps the map repainting while the layer plays                            |
| `0004` plugin rotation properties    | `icon-rotate` transitions along the shortest arc                                           |
| `0005` plugin frame queries          | the bucket's layout only (see below)                                                       |
| `0006` OpenGL uniform blocks ≥ 8 KiB | catalogs of more than 254 animations on OpenGL, whose header block outgrows the 8 KiB page |
| `0007` plugin static textures        | the catalog texture that holds every frame, so each icon picks its own animation and phase |
| `0008` plugin OpenGL attributes      | data-driven paint attributes land in the right shader inputs on OpenGL                     |

`0006` matters only for OpenGL and OpenGL ES builds, and only for catalogs whose
header block exceeds 8 KiB; Metal and Vulkan draw such blocks without it. `0007`
is required on every backend. `0008` is required on OpenGL whenever a layer
mixes data-driven and constant properties: without it the host matches
attributes by position, not name, and data-driven values reach the wrong inputs.
The plugin uses no feature of `0002` (source-free layers): the extra
`source_free` and `build_frame` fields it zeroes are ignored by a host without
them. It uses no feature of `0005` either and returns no frame features, but the
vendored header's `mln_plugin_bucket_v1` ends with `0005`'s `frame_features`, so
`finish_layout` rejects a host's smaller bucket. It does not need premultiplied
default colors (`0003`): `icon-color` defaults to transparent, which is the same
premultiplied or not. The patches form one stacked series, though, so a host
carries `0001` to `0008`.

## Weather demo

`examples/weather/` holds a second catalog in use: 240 synthetic weather
stations, each drawing one of 12 Meteocons animations from
`catalog/weather.mlvc` (0.60 MB, baked at 30 fps with `wind` at 60 from
[`animations/weather.json`](animations/weather.json)). Its
[README](examples/weather/README.md) describes the fixture and the layers.

- **Gallery:** the "Weather stations" page loads the catalog at run time, on a
  dark basemap with station labels, condition filters, a playback switch
  (desynced, in sync, on hover once, paused) and a popup per station.
- **Viewer:** `mise run //apps/native-viewer:weather` opens the same layer,
  stations and catalog natively, with icons looping out of sync. With `--
  --layer ../../plugins/animated-icon/examples/weather/play-once.layer.json`,
  every icon rests until hovering plays it once, and a click replays it.

The viewer's flags for this are generic: `--catalog <file>` with
`--catalog-entry <symbol>` registers an app catalog, `--geojson <id>=<file>`
adds a GeoJSON source, and `--play-once <source>` with `--clock-symbol <symbol>`
sets `{"start": <clock>}` on the hovered or clicked feature. For scripted runs,
`--hover-at <x>,<y>@<s>` and `--click-at <x>,<y>@<s>` replay input `<s>` seconds
after the first frame, and `--exit-after <s>` quits.

## Limits and future improvements

Most limits come from the plugin API; each item names what would lift it.
Patches `0009` (frame context) and `0010` (uniform-only bindings) are planned
for M2 and not yet in `patches/maplibre-native-ffi/`.

1. **One catalog per native process, registered by the app.** The host keeps one
   descriptor per plugin id and layer type, so a process registers either the
   demo or one app catalog, before any style uses the layer, and the style
   cannot name a catalog or add animations. The host lends plugins no resource
   loader, and enum values are fixed at registration. The JS layer takes a
   catalog per layer. Fix: resource loading for plugins, with enum values
   resolved per style layer.
2. **Playback is a formula, not a state.** An icon's frame is a function of the
   clock, speed, offset and mode, so "play once" needs the app to write the
   clock into feature-state, and nothing can wait for an animation to end. Fix:
   a feature-state change timestamp available to shaders.
3. **The catalog must fit one texture.** Every frame of every animation stays
   resident: at most 4,194,304 texels (a 2048 × 2048 RGBA32F texture, 64 MiB),
   510 animations (254 on OpenGL without `0006`), 64 ops per frame and 256
   curves per band. Bake at `--fps 30` to halve a catalog. Fix: fp16 curves or
   dynamic textures that stream frames.
4. **The plugin keeps its own clock.** Frames come from the plugin's monotonic
   clock, not the host's frame time, so playback cannot follow the map's time.
   The clock wraps every 4096 s, so a played-once icon returns to its first
   frame about every 68 minutes. Fix: the frame time in the uniform context
   (patch `0009`, planned for M2).
5. **Natively, the map repaints whenever the layer sets `icon-animation`.**
   `should_animate` sees paint values without features: a data-driven
   `icon-animation` reads as `"none"` there, and a hover-gated speed as its
   default. So the plugin keeps repainting whenever the property is set, even
   when every icon is paused, transparent or constant `"none"`, and even when no
   icon is in view. The host also evaluates a plugin layer again only while it
   animates or transitions, never on a zoom change, because
   `RenderPluginStyleLayer` never sets `styleDependencies`, so no zoom-dependent
   value could safely stop it. The JS layer sees its own expressions and stops
   for a uniform `"none"`, zero opacity, zero size or zero speed. Fix: a flag
   telling `should_animate` which properties depend on the feature, or
   per-bucket statistics as `get_query_radius` gets.
6. **Enum changes wait for the style transition.** A property registered without
   transitions still goes through the style-wide transition. For a string that
   means holding the old value until it ends. Fix: skip transitions for
   properties that declare `supports_transitions = 0`.
7. **Placement matches symbols only at roll 0 and pitch ≤ 90°, and natively
   within half a pixel.** The uniform context has no pitch or roll. The host
   also hands plugins the pixel-aligned tile matrix, unlike the circle and
   symbol matrices: native icons sit up to half a logical pixel from the web
   layer's, while MapLibre Native's circles match gl-js's exactly. Fix: pitch,
   roll and the unaligned matrix in the uniform context (patch `0009`, planned
   for M2).
8. **No collision.** Icons behave as if `icon-allow-overlap` and
   `icon-ignore-placement` were always on: they never avoid labels and never
   fade. Fix: plugin participation in the collision index.
9. **Draw order is per tile.** Icons sort by tile `y` at layout, which matches
   screen order only at bearing 0, and there is no `symbol-sort-key` because
   layout never sees properties. Across tiles the order is unspecified: natively
   plugin drawables draw in creation order and the JS layer in gl-js's tile
   order, so where icons from two tiles overlap the two can differ. Fix:
   layout-evaluated plugin properties and a per-frame draw order.
10. **Icons can double while tiles load.** A parent tile and its loading
    children may both draw, and both answer queries, with no stencil or
    cross-tile identity to drop the duplicates. Fix: a stencil or depth hook for
    plugin layers.
11. **Every visible icon costs every frame.** With no render targets, a resting
    icon cannot be cached as an image. Band lists and the median ray split keep
    each pixel's work to the curves near it, but nothing has been timed on this
    shader: the cost figures in the bake report are design-research estimates,
    and there is no density guidance for phones yet.
12. **Queries evaluate data-driven values at the tile's zoom.** The host
    evaluates camera values at the render zoom but data-driven ones at the
    tile's integer zoom, so a data-driven size that changes with zoom makes the
    hit box differ from the drawn icon between integer zooms. The JS layer
    mirrors it. Natively, rendered-feature queries also return nothing at pitch
    80° and above, for built-in layers too. Fix: the render zoom in the query
    context.
13. **Camera-only properties still take attribute slots.** The host counts every
    declared property attribute against its limit of 16 even when it compiles
    the property as a uniform: this layer declares 14, which leaves room for
    M2's `icon-secondary-color` only. Fix: uniform-only property bindings (patch
    `0010`, planned for M2).
14. **Only baked Lottie, up to the Core tier.** Translucent masks and mattes,
    isolated group opacity, merge modes 2–5, highlight gradients and precomp
    clipping arrive with Composite (M3); luma mattes, blend modes, effects and
    general expressions are later or never. Only the color slots change at
    runtime, and M1 draws the secondary slot as authored. Fix for runtime
    Lottie: dynamic plugin textures.
15. **A constant speed change scrubs the playhead.** Speed transitions like any
    number, so during a transition the playhead sweeps through `clock × Δspeed`
    seconds. Set `icon-animation-speed-transition` to a zero duration where a
    speed switches, as `play-once.layer.json` and the gallery do.
16. **Feature-state costs a refill.** Natively, once a source has any feature
    state, every data-driven attribute of every stated feature is rewritten each
    frame. That is cheap for a few hundred hovered stations; for large sets,
    remove states with `removeFeatureState` when they no longer matter.
17. **Three copies of an app catalog.** Natively the plugin keeps a copy, the
    host's registry another, and the GPU the texture. The texel section, and so
    the registry copy and the GPU texture, is capped at 64 MiB (2048 × 2048
    RGBA32F texels); the plugin's copy of the file adds the header, records and
    names. The JS layer uploads its catalog once per layer.
18. **High precision is unverified on phones.** The catalog is read with `highp`
    samplers and integers throughout. GLSL ES defaults samplers to `lowp`, which
    would quantize the texels, and no phone GPU has been tested.
19. **Composite values follow the host's quirks.** A composite (zoom and
    feature) rotation interpolates linearly, the long way across 0°/360°, and
    enum steps resolve at the tile's integer zoom. The JS layer mirrors both.
20. **JS only.**
    - The source needs a built-in layer. gl-js loads a source's tiles only while
      a visible built-in layer uses it, so the JS layer always adds its own
      hidden circle layer, `<id>-tiles`, with the layer's visibility and zoom
      range, and removes it with the layer.
    - gl-js drops custom layers when the WebGL context is lost, so the app has
      to add the layer again after `webglcontextrestored`, as the gallery does.
    - The layer reads decoded tiles through gl-js internals (all in
      `js/src/gljs.ts`, checked at run time), so a gl-js update can break it; it
      then throws once and stops drawing. MLT sources go through the same path
      but are tested only against fakes.
    - On the globe, hit tests place icons with a CPU copy of gl-js's
      `projectTile` (`js/src/globe.ts`), so a change to gl-js's globe projection
      needs the same change there.

## Web

```ts
import {
  AnimatedIconLayer,
  clockSeconds,
  loadCatalog,
} from "@maplibre-plugins/animated-icon";

const icons = AnimatedIconLayer.fromLayerJson(layerJson); // the JSON above
map.addLayer(icons);
icons.setPaintProperty("icon-animation", "pulse", { duration: 0 });
icons.setPaint(
  { "icon-size": 1.5, "icon-color": "#2a8ae6" },
  { duration: 500 },
);
icons.queryFeature(point); // the topmost icon's feature, or null

const catalog = await loadCatalog("weather.mlvc"); // an app catalog
const weather = AnimatedIconLayer.fromLayerJson(weatherJson, { catalog });
```

Leave out `source-layer` for a GeoJSON source. Paint values accept literals, CSS
color strings or expressions, the same inputs a style gives the native plugin.
Without a `catalog`, the layer draws the same built-in demo catalog as the
native plugin.

## Development

Both runtimes are tested against `spec.json` and share
`shaders/properties.glsl`, `shaders/place.glsl` and `shaders/icon.glsl`. Each
native file has a TypeScript twin, and each pair shares fixtures:

- **Catalog readers** (`native/src/catalog.zig` and `js/src/catalog.ts`): the
  valid and malformed catalogs and timing samples in `fixtures/catalog/`, which
  the baker generates.
- **Layouts** (`native/src/layout.zig` and `js/src/layout.ts`):
  `fixtures/layout/`.
- **Placement and hit tests** (`native/src/place.zig` and `js/src/place.ts`):
  the camera cases in `fixtures/place/`, generated by `generate.mjs` there.
- **Shader sources:** the vertex and fragment sections the native OpenGL and the
  WebGL 2 sources must share word for word are pinned in
  `fixtures/shaders/sections.glsl`.
- **Coverage:** `baker/src/shade.ts` is the fragment shader's algorithm in
  32-bit floats, and the baker's tests check it against brute force.

`@maplibre-plugins/paint` evaluates data-driven values the way the host does,
checked against expectations the host itself generated
(`packages/paint/fixtures/binder/`).

Preview the web layer with `mise run web`, and the native one with:

```bash
mise run //apps/native-viewer:run animated-icon -- \
  --center 37.788,-122.4075 --zoom 16 --pitch 30
```

The viewer re-applies `examples/layer.json` whenever you save it.

## Credits and licenses

- The coverage in `shaders/icon.glsl` follows Eric Lengyel's Slug algorithm
  ("GPU-Centered Font Rendering Directly from Glyph Outlines", JCGT 2017). Its
  root selection is ported from Slug's reference pixel shader (Copyright 2017
  Eric Lengyel, MIT), whose notice the shader keeps.
- The baker reproduces lottie-web's evaluation rules (MIT) and outlines strokes
  with Skia through `canvaskit-wasm` (BSD-3-Clause), which is a development
  dependency only.
- `clear-day` in the demo catalog and the 12 animations of the weather catalog
  are from [Meteocons](https://github.com/basmilius/meteocons) by Bas Milius
  (MIT): the line set for the demo, the flat set for the weather catalog.
  `pulse` and `pin` were written for this repository and share its BSD-2-Clause
  license. The baked catalogs are derived from these files, so their licenses
  apply to them; see [`animations/LICENSES.md`](animations/LICENSES.md). The
  generated JS module carries the MIT notice in a `/*! */` comment, which the JS
  package and the gallery bundle keep. `catalog/weather.mlvc.LICENSE.txt`
  carries it for the weather catalog, which the gallery links from its
  attribution. Whoever redistributes the native library, which embeds the demo
  catalog, must include `animations/meteocons/LICENSE`.
- The weather stations are Natural Earth 1:50m populated places (public domain);
  their weather is synthetic.
