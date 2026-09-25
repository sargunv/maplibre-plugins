# Particles

GPU particle effects as two layer types from one plugin:

- `particle-emitter`: one emitter per layer, with no source. Particles are born
  at a point or on a disc around `emitter-position`, or, as weather, in a volume
  in front of the camera that stays fixed to the world as you pan and zoom.
- `particle-features`: particles from every point, line and polygon of a vector
  source layer, such as sparkles over points of interest, flow along rivers, or
  fireflies over parks.

Both types share one stateless particle model and one shader core. A particle's
position, size and color are closed-form functions of its identity and age, so
the plugin keeps no per-particle state and uploads no geometry per frame. The
same model covers four effect families: weather (snow, rain, pollen), plumes
(fire, smoke), bursts (sparks, fountains, fireworks) and ambient life
(fireflies, bubbles, ripples).

The native plugin runs on Metal, OpenGL and Vulkan. Only Metal has been verified
at runtime; the OpenGL and Vulkan shaders are compile-checked, and the OpenGL ES
programs also link in WebGL 2. The JS layers render on WebGL 2 under the
mercator and globe projections; globe is JS only.

## Examples

Snow around the camera, from `examples/layer.json`:

```json
{
  "id": "snow",
  "type": "particle-emitter",
  "paint": {
    "emitter-kind": "weather",
    "particle-count": 7000,
    "particle-lifetime": [6, 10],
    "particle-direction": [0, -90],
    "particle-spread": [25, 0],
    "particle-speed": [35, 80],
    "particle-wind": [20, 8],
    "particle-wander": [16, 0.3],
    "particle-spin": [-90, 90],
    "particle-shape": "flake",
    "particle-size": [4, 8],
    "particle-size-clamp": [1.5, 20],
    "particle-color": "rgba(255,255,255,0.95)",
    "particle-fade": [0.25, 0.25],
    "particle-additive": [0, 0],
    "emitter-center-thinning": 0.4,
    "emitter-screen-tint": "rgba(70,82,105,0.4)",
    "emitter-vignette": 0.5
  }
}
```

Sparkles over shops, food and culture, colored, shaped and sized by each POI's
class and thinned by its rank, from `examples/poi-sparkles.json`:

```json
{
  "id": "poi-sparkles",
  "type": "particle-features",
  "source": "openmaptiles",
  "source-layer": "poi",
  "minzoom": 15,
  "filter": [
    "match",
    ["get", "class"],
    [
      "shop",
      "clothing_store",
      "grocery",
      "bakery",
      "alcohol_shop",
      "restaurant",
      "fast_food",
      "cafe",
      "bar",
      "beer",
      "ice_cream",
      "attraction",
      "museum",
      "art_gallery",
      "theatre",
      "cinema"
    ],
    true,
    false
  ],
  "paint": {
    "particle-density": [
      "interpolate",
      ["linear"],
      ["get", "rank"],
      1,
      12,
      40,
      4
    ],
    "particle-color": [
      "match",
      ["get", "class"],
      ["attraction", "museum", "art_gallery", "theatre", "cinema"],
      "#b44dff",
      ["restaurant", "fast_food", "cafe", "bar", "beer", "ice_cream"],
      "#ff5a3c",
      "#ffb400"
    ],
    "particle-shape": [
      "match",
      ["get", "class"],
      ["restaurant", "fast_food", "cafe", "bar", "beer", "ice_cream"],
      "glow",
      "star"
    ],
    "particle-size": [
      "match",
      ["get", "class"],
      ["attraction", "museum", "art_gallery", "theatre", "cinema"],
      ["literal", [18, 28]],
      ["restaurant", "fast_food", "cafe", "bar", "beer", "ice_cream"],
      ["literal", [8, 12]],
      ["literal", [12, 18]]
    ],
    "particle-lifetime": [0.8, 1.6],
    "particle-speed": [4, 12],
    "particle-direction": [0, 90],
    "particle-spread": [70, 0],
    "particle-gravity": 6,
    "particle-wander": [3, 1],
    "particle-fade": [0.1, 0.5],
    "particle-additive": [0.2, 0.2],
    "particle-twinkle": [0.5, 3]
  }
}
```

## Presets

Every file in [`examples/`](examples) is a style layer that both the gallery and
the native viewer load. Its `metadata` holds a title, a camera
(`maplibre-plugins:camera`) and, for some, the layer to insert before
(`maplibre-plugins:before`). The feature presets use the OpenMapTiles schema.
Open one in the native viewer with its flags from the table. The task opens
`layer.json` unless `--layer` names another file, and the viewer does not read
the metadata: a camera flag left out takes the viewer's default (bearing 12°,
pitch 30°), so every row sets all four.

```bash
mise run //apps/native-viewer:run particles -- <flags>
```

In the gallery (`mise run web`), `?plugin=particles&preset=<file>` opens a
preset (the file name without `.json`), and `&t=<seconds>` freezes the particle
clock so every frame is the same.

| Preset                | Type                | Look                                                     | Viewer flags                                                                                                                                          |
| --------------------- | ------------------- | -------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| `layer.json` (snow)   | `particle-emitter`  | Snow drifting around the camera under an overcast tint   | `--center 37.7544,-122.4477 --zoom 14 --bearing 0 --pitch 50`                                                                                         |
| `rain.json`           | `particle-emitter`  | Slanted rain streaks under a dark vignette               | `--layer ../../plugins/particles/examples/rain.json --center 37.7897,-122.4 --zoom 15.5 --bearing 0 --pitch 60`                                       |
| `pollen.json`         | `particle-emitter`  | Golden pollen drifting on the wind over a park           | `--layer ../../plugins/particles/examples/pollen.json --center 37.7694,-122.4862 --zoom 15 --bearing 0 --pitch 45`                                    |
| `fire.json`           | `particle-emitter`  | A campfire at dusk: stretched flame tongues, in meters   | `--layer ../../plugins/particles/examples/fire.json --center 37.763,-122.5107 --zoom 20 --bearing 0 --pitch 60`                                       |
| `smoke.json`          | `particle-emitter`  | A smoke plume rising and drifting downwind               | `--layer ../../plugins/particles/examples/smoke.json --center 37.763,-122.5107 --zoom 18.2 --bearing 0 --pitch 60`                                    |
| `sparks.json`         | `particle-emitter`  | Sparks thrown up and falling back, at dusk               | `--layer ../../plugins/particles/examples/sparks.json --center 37.763,-122.5107 --zoom 19.5 --bearing 0 --pitch 55`                                   |
| `fountain.json`       | `particle-emitter`  | A fountain jet arcing back down                          | `--layer ../../plugins/particles/examples/fountain.json --center 37.7707,-122.4687 --zoom 18.8 --bearing 0 --pitch 60`                                |
| `fireworks.json`      | `particle-emitter`  | Four shells bursting in turn over a night tint           | `--layer ../../plugins/particles/examples/fireworks.json --center 37.8098,-122.4235 --zoom 16 --bearing 0 --pitch 50`                                 |
| `fireflies.json`      | `particle-emitter`  | Fireflies blinking over a meadow at night                | `--layer ../../plugins/particles/examples/fireflies.json --center 37.7684,-122.4861 --zoom 16.4 --bearing 0 --pitch 50`                               |
| `bubbles.json`        | `particle-emitter`  | Rings rising over a lake, in pixels                      | `--layer ../../plugins/particles/examples/bubbles.json --center 37.7708,-122.4942 --zoom 16.5 --bearing 0 --pitch 30`                                 |
| `poi-sparkles.json`   | `particle-features` | Sparkles over shops, food and culture, by class and rank | `--layer ../../plugins/particles/examples/poi-sparkles.json --center 37.788,-122.4075 --zoom 16.5 --bearing 0 --pitch 40`                             |
| `park-fireflies.json` | `particle-features` | Golden fireflies over every park and garden              | `--layer ../../plugins/particles/examples/park-fireflies.json --center 37.7694,-122.4862 --zoom 15 --bearing 0 --pitch 45`                            |
| `waterway-flow.json`  | `particle-features` | Streaks flowing along rivers, canals and streams         | `--layer ../../plugins/particles/examples/waterway-flow.json --center 52.3702,4.8952 --zoom 15 --bearing 0 --pitch 30`                                |
| `water-bubbles.json`  | `particle-features` | Ripples spreading on open water                          | `--layer ../../plugins/particles/examples/water-bubbles.json --center 37.808,-122.42 --zoom 13.5 --bearing 0 --pitch 45 --before landcover-ice-shelf` |

The presets are tuned for OpenFreeMap bright, the basemap of the gallery and the
viewer. Added light barely shows on a light basemap (see Limits), so the night
and dusk presets darken the map with `emitter-screen-tint` first, and the
daytime ones paint saturated colors over it.

## How it works

### The particle model

Each particle slot lives life after life: it is born once per period, the
longest lifetime or `particle-burst-interval` if that is longer, and lives a
lifetime drawn from `particle-lifetime`. So `particle-count` and
`particle-density` count slots, and about count × mean lifetime / period of them
are alive at once: 75% with the default lifetime of 1 to 2 s, fewer when bursts
leave idle gaps. A slot's birth phase comes from a hash of its identity: evenly
spread over time, or, as `particle-explosiveness` rises, gathered into bursts
that `particle-burst-interval` and `particle-burst-groups` schedule. Motion is
closed-form: a launch velocity inside a cone (`particle-direction`,
`particle-spread`), exponential air drag, gravity, wind, and a smooth wander
that is zero at birth. Over its life a particle grows by `particle-growth`,
blends from `particle-color` to `particle-color-end`, fades in and out,
twinkles, and slides between painting over the map and adding light. The clock
is the plugin's own, wrapped at 4096 s, and the period snaps to the nearest one
that fits a whole number of times into 4096 s and still holds the longest
lifetime, so nothing pops at the wrap. `particle-count` changes fade particles
in and out over a ramp an eighth of the count wide instead of popping them. The
ramp is centered on the count and reaches a sixteenth of the count past it, and
each emitter's pool of particles is the smallest power of two that holds the
whole ramp. The largest pool, 16384 particles, holds it up to a count of 15420;
above that the top of the ramp falls outside it, and 16384 shows about 16128
particles (count / 64 fewer).

Particles smaller than a few pixels would flicker as they move between pixel
centers, so a sprite under 4 physical px is drawn 4 px wide with its own area's
light (lower alpha), and a streak thinner than 2 physical px is drawn 2 px wide
the same way. A ripple's rings keep a width of at least one pixel and their
light, so ripples dim below about 20 physical px (sooner under pitch).

### Spaces

`particle-space` sets how an emitter sits on the map. `screen` draws in the
screen plane in pixels, like an icon. `ground` draws east and north on the map
plane in pixels, with up pointing up the screen, so everything shrinks with
distance under pitch. `world` is true 3D in meters and scales with the map like
a building. `particle-scale` multiplies every length and speed, so a zoom
expression on it grows a pixel-space effect with the map. Feature particles are
always in ground space.

In ground and world space the map plane is the ground: a particle that sinks
below altitude 0 fades out over one size and then dies. That holds in ground
space too, where the ground is invisible and down is down the screen, so a
negative `emitter-height`, a downward launch or positive gravity shows a
particle only until it is one size below its emitter. Screen space has no
ground.

### The emitter frame table

A particle moves every frame, so the shader must animate it from static vertex
bytes, and for that it needs the camera and the paint in a uniform. A
source-free layer's `update_uniform_block` gets neither: its context has no
camera, and it does not say which layer it is filling. Only `build_frame` sees
both. So every frame, `build_frame` computes the camera in f64 (a projection
relative to the frame center, and the weather volume) and this layer's row (its
placement and every paint value), and puts the row into a thread-local table.
The layer's vertices carry only a vertex index and a row number. Every layer's
uniform update then copies the whole table into its one 4032-byte block, and the
shader reads its own row. Vertex bytes change only when the pool size or the row
changes, so camera moves, paint changes, transitions, zoom expressions and a
moving emitter rebuild nothing.

This is the first rung of the design's fallback ladder, and the one in use. It
relies on host ordering the ABI does not document: every layer's `build_frame`
of a frame runs before that frame's uniform updates, on the same thread
(`renderer_impl.cpp`, verified at runtime; see Limits). The table holds 16 rows,
so at most 16 visible emitter layers draw per map. The block stays at 4032
bytes, under Metal's 4 KiB `setVertexBytes` path and under the 8 KiB at which
OpenGL uniform blocks currently fail, and each shader uses one block (Vulkan
allows two). If the ordering ever breaks, the next rung bakes each layer's row
into 15 vertex attributes and keeps only the camera in the block, and the last
one bakes the camera into the vertices as well.

### Weather

A weather emitter fills a box-sized window just ahead of the camera, cut from a
lattice that is fixed to the world: panning moves through the particles, with
parallax, and the window sits 0.4 box ahead of the eye along the view so most of
it is on screen. Two pools of particles, anchored at alternating integer zoom
levels, scale about the eye and crossfade with the zoom, so zooming descends
through the snow without a pop at integer zooms. Particles fade near the window
edges, right in front of the eye and at the ground; `emitter-center-thinning`
thins them around the vanishing point of `particle-direction` (wind, gravity and
wander do not move it). About 10 to 15 percent of the weather count lands on
screen at pitch 0 to 60.

### Tile pools and density

Each tile's layout reserves particle slots: 16 per point, one every 32 tile
units along each line, and one per 128-tile-unit cell inside each polygon. A
line's clipped segments (its pieces) get the slots their length carries the
line's running count past, so a densely sampled line gets no more than a
straight one. A tile keeps at most 16383 slots; past that it keeps every point's
lowest-ranked slots, the ones `particle-density` draws first, and an even share
of the line and polygon slots. A tile owns a point, and a line piece's midpoint,
only inside its half-open square, so particles are never doubled on tile seams.
The shader keeps a share of the slots from `particle-density` and the zoom. At a
tile's own zoom its line slots are 2 px apart and its polygon cells 8 px wide,
and both spacings double toward the next integer zoom as the tile is drawn
larger, so a line holds a density of at most 50 per 100 px at an integer zoom
and 25 just below the next one, and a polygon 156 (above the maximum density
of 100) and 39 per 100 × 100 px. Up to 25 for lines and 39 for polygons, screen
density holds across zoom until the tile's pool saturates beyond the source's
max zoom; a higher density shows in full only near each integer zoom and falls
toward those ceilings as the zoom rises. Line particles flow along their own
segment (azimuth 0 follows the line's drawing direction), so a river bends its
flow.

### The GL attribute ladder

The four data-driven properties of `particle-features` (color, size, density,
shape) reach the shader as vertex attributes. An upstream OpenGL host maps each
active attribute by its linked location used as an index into its list of
non-uniform attributes, so the generated GL source declares each data-driven
attribute with a literal location that depends on which of the earlier ones are
data-driven: a compacted `#if` ladder, which puts every attribute at its index.
Patch `0008` makes the host match attributes by name instead, and the ladder's
locations are then just explicit locations, so the same source is correct with
or without it. Metal and Vulkan use the declared locations. A comptime flag
(`gl_location_ladder` in `native/src/shaders.zig`) switches OpenGL to the
declared locations too, for when every host carries `0008`.

## Paint properties

The full table, with types, defaults, bounds, units and docs, is
[spec.json](spec.json). Its top-level `paint` table is canonical; each layer
type lists the properties it takes. A type that does not list a property uses
the property's default.

| Property                   | Type    | Default            | Emitter | Features      | Notes                                      |
| -------------------------- | ------- | ------------------ | ------- | ------------- | ------------------------------------------ |
| `emitter-kind`             | enum    | `"point"`          | ✓       |               | literal only; no transition                |
| `emitter-position`         | double2 | `[0, 0]`           | ✓       |               | [lat°, lon°]                               |
| `emitter-radius`           | float   | `0`                | ✓       |               | space                                      |
| `emitter-height`           | float2  | `[0, 0]`           | ✓       |               | space                                      |
| `particle-space`           | enum    | `"ground"`         | ✓       |               | literal only; no transition                |
| `particle-scale`           | float   | `1`                | ✓       |               |                                            |
| `particle-count`           | float   | `256`              | ✓       |               | particles                                  |
| `particle-density`         | float   | `8`                |         | ✓ data-driven |                                            |
| `particle-lifetime`        | float2  | `[1, 2]`           | ✓       | ✓             | literal only; no transition; s             |
| `particle-explosiveness`   | float   | `0`                | ✓       |               | literal only; no transition                |
| `particle-burst-interval`  | float2  | `[0, 0]`           | ✓       |               | literal only; no transition; [s, fraction] |
| `particle-burst-groups`    | float   | `1`                | ✓       |               | literal only; no transition                |
| `particle-seed`            | float   | `0`                | ✓       |               | literal only; no transition                |
| `particle-speed`           | float2  | `[20, 40]`         | ✓       | ✓             | space/s                                    |
| `particle-direction`       | float2  | `[0, 90]`          | ✓       | ✓             | deg                                        |
| `particle-spread`          | float2  | `[15, 0]`          | ✓       | ✓             |                                            |
| `particle-gravity`         | float   | `0`                | ✓       | ✓             | space/s²                                   |
| `particle-drag`            | float   | `0`                | ✓       |               | 1/s                                        |
| `particle-wind`            | float2  | `[0, 0]`           | ✓       |               | space/s                                    |
| `particle-wander`          | float2  | `[0, 0.5]`         | ✓       | ✓             | [space, Hz]                                |
| `particle-spin`            | float2  | `[0, 0]`           | ✓       |               | deg/s                                      |
| `particle-shape`           | enum    | `"glow"`           | ✓       | ✓ data-driven | no transition                              |
| `particle-size`            | float2  | `[6, 10]`          | ✓       | ✓ data-driven | space                                      |
| `particle-growth`          | float   | `1`                | ✓       |               |                                            |
| `particle-size-clamp`      | float2  | `[0.5, 128]`       | ✓       |               | px                                         |
| `particle-stretch`         | float   | `0`                | ✓       | ✓             | s                                          |
| `particle-color`           | color   | `[1, 0.9, 0.6, 1]` | ✓       | ✓ data-driven |                                            |
| `particle-color-end`       | color   | `[0, 0, 0, 0]`     | ✓       |               |                                            |
| `particle-color-variation` | float2  | `[0, 0]`           | ✓       |               | deg                                        |
| `particle-opacity`         | float   | `1`                | ✓       |               |                                            |
| `particle-fade`            | float2  | `[0.1, 0.3]`       | ✓       | ✓             | fraction of life                           |
| `particle-additive`        | float2  | `[0, 0]`           | ✓       | ✓             |                                            |
| `particle-twinkle`         | float2  | `[0, 2]`           | ✓       | ✓             | [fraction, Hz]                             |
| `emitter-center-thinning`  | float   | `0`                | ✓       |               |                                            |
| `emitter-screen-tint`      | color   | `[0, 0, 0, 0]`     | ✓       |               |                                            |
| `emitter-vignette`         | float   | `0`                | ✓       |               |                                            |

- **Units by space.** Lengths and speeds marked `space` are pixels in `screen`
  and `ground` space and meters in `world` space; `particle-size-clamp` is
  always in screen pixels.
- **Pairs.** A `float2` packs two related values, named by its components in
  spec.json: a `[min, max]` range picked per particle, a start/end pair over
  life, or two parameters of one effect. Each component is clamped to its range
  in the shader and never rejected.
- **End color.** `particle-color-end` is painted over `particle-color` by the
  end of life: fully opaque means exactly that color, and transparent (the
  default) keeps `particle-color`.
- **Literal-only properties.** `particle-lifetime`, the burst properties and
  `particle-seed` take literals only and declare no transition, because a change
  reshuffles every particle's timing. The host still eases them over the style
  transition (see Limits), and the JS layers do the same.
- **Counts.** A point or circle emitter has up to 16384 particle slots. Every
  count up to 15420 shows in full, and 16384 shows about 16128 (see The particle
  model). Weather draws two zoom octaves of at most 8192 particles each from one
  pool, so its count is effective up to 8192: counts up to 7710 show in full,
  and 8192 shows about 8064. `particle-opacity` 0 (or `particle-count` 0) with a
  transparent screen tint draws nothing at all, so a zoom-faded effect costs
  nothing where it has faded out only if it fades its tint too, as the rain
  preset does below zoom 10.
- **Density.** `particle-density` is particle slots per point feature (at most
  16), per 100 px of line, or per 100 × 100 px of polygon; as with
  `particle-count`, about density × mean lifetime / period of them are alive at
  once. Across a whole zoom level lines hold at most 25 per 100 px and polygons
  39 per 100 × 100 px (see Tile pools and density).
- **Data-driven properties.** On `particle-features`, `particle-color`,
  `particle-size`, `particle-density` and `particle-shape` accept feature
  expressions; data-driven values do not transition. `feature-state` is not
  supported: the plugin does not declare that capability, so the host rejects an
  expression that reads it, and the JS layers do the same.

## Required native patches

From `patches/maplibre-native-ffi/` this plugin needs:

| Patch                                | `particle-emitter` | `particle-features` | Used for                                                                                                                                                                    |
| ------------------------------------ | ------------------ | ------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `0001` plugin animated layers        | ✓                  | ✓                   | `should_animate` keeps the map repainting (always 1, see Limits)                                                                                                            |
| `0002` source-free plugin layers     | ✓                  | ✓ (library)         | `build_frame` and the DOUBLE2 `emitter-position`. Both types live in one descriptor, so a host without `0002` rejects the whole library.                                    |
| `0003` premultiplied default colors  | ✓                  | ✓                   | color defaults arrive premultiplied like evaluated colors                                                                                                                   |
| `0004` rotation properties           | –                  | –                   | not used: azimuths are float2 components, which transition linearly                                                                                                         |
| `0005` frame queries                 | –                  | –                   | not used: particles are not hit-testable                                                                                                                                    |
| `0006` OpenGL uniform blocks ≥ 8 KiB | –                  | –                   | not needed: the emitter's block is 4032 bytes and the features block smaller, below OpenGL's 8 KiB page (and Metal's 4 KiB `setVertexBytes` limit); keep them there         |
| `0007` plugin static textures        | –                  | –                   | not used: the shapes are procedural. The library builds against the header with the texture fields and leaves them zero.                                                    |
| `0008` OpenGL attributes by name     | –                  | –                   | not required: the GL location ladder (see How it works) puts the data-driven attributes where a host without `0008` looks for them, and a host with it matches them by name |

Like the other plugins, build the library against the plugin ABI header of the
host it loads into, as the native viewer does (`-Dplugin-api-include-dir`): the
patch set changes struct sizes, and a host rejects a descriptor struct smaller
than its own (see Limits).

## Limits and future improvements

Each entry gives the gap, what it costs here, and the ABI change that would
close it.

1. **Bindings cost vertex-attribute slots even when uniform.**
   `particle-features` takes 14 properties to the emitter's 35: no drag, wind,
   spin, bursts, growth, end color, opacity, scale, space or meters. _Fix:_ a
   uniform-only binding kind, or evaluated paint in the uniform context.
2. **`build_frame` cannot write uniforms, and `update_uniform_block` gets no
   layer identity.** This is why the emitter needs the frame table. The location
   indicator never needed one: it draws a handful of quads and a 72-triangle
   accuracy circle with no clock-driven animation, so its `build_frame` projects
   every vertex through the frame's matrix on the CPU and bakes the paint into
   the vertex bytes, and new bytes on each camera move cost nothing at that
   size. Particles are thousands of quads that move every frame, so they must
   animate on the GPU from static bytes, and the shader then needs the camera
   and the paint in a uniform that the source-free uniform callback cannot fill
   on its own. The table depends on the undocumented `build_frame`-before-
   uniforms ordering (`renderer_impl.cpp:257-285`, verified at runtime across
   camera jumps) and on a row index baked into the vertices. It caps a map at 16
   visible emitter layers (the 17th fails its frame and the host logs an error
   every frame), hiding a layer moves the rows after it (those layers rebuild
   once), and a frame whose drawables fail to draw can leave stale rows. _Fix:_
   `build_frame` returns layer-block bytes, or the uniform context gets a
   per-layer user-data pointer.
3. **The source-free uniform context has no camera** (identity matrix; no
   center, zoom, pitch or time). The camera travels through the same
   thread-local table. _Fix:_ frame matrix, zoom, pitch and time in the uniform
   context.
4. **`supports_transitions = 0` does not stop transitions** (host bug,
   `render_plugin_style_layer.cpp:133-151`). Lifetime, burst and seed changes
   scramble particle timing for the whole style transition (300 ms by default),
   and enums switch at its end. The JS layers mirror this. _Fix:_ honor
   `supports_transitions = 0` as an instant change.
5. **No host time in the uniform or layout contexts.** The plugin runs its own
   clock: no pause, no time scale, and still rendering is undefined
   (`MLN_PARTICLES_TIME` pins it for tests). `build_frame` gets `time_seconds`,
   but in still mode (`MapMode::Static` and `Tile`) every render of every map
   has the same one, so the frame table tells frames and maps apart by camera.
   _Fix:_ frame time in the uniform context.
6. **No per-layer state or frame delta.** The model is stateless: no collisions,
   attractors, sub-emitters or persistent trails, and weather uses an octave
   crossfade.
7. **No instancing, point sprites or attribute divisors; 16-bit indices.**
   Per-particle data is repeated for all four corners, and a segment holds at
   most 16383 quads. _Fix:_ instance count and step rate (the engine supports
   both).
8. **Unchanged source-free frames still pay for copy, compare and index
   validation, and any byte change rebuilds everything.** Measured 0.07 ms/MiB
   static and 0.3 ms/MiB changed; a full 16384-particle pool is 512 KiB of
   vertex bytes, so about 0.04 ms per frame while nothing changes. _Fix:_ an
   "unchanged" flag or retained buffers.
9. **No sprite textures, render targets or compute.** Procedural shapes only: no
   sprite images, trails, bloom or rain distortion. Patch `0007` adds static
   RGBA32F data textures read by exact texel, which suits lookup tables, not
   filtered sprites.
10. **Fixed premultiplied-over blending.** Additive light comes only from alpha
    0, which saturates to white or vanishes on light basemaps; the presets work
    around it with screen tints and painted colors. _Fix:_ expose an additive
    color mode.
11. **Read-only depth, near-plane z; OpenGL collapses depth per layer.**
    Occlusion by 3D buildings is inconsistent across backends.
12. **No tile clipping or stencil.** Fallback tiles draw twice, and plumes
    vanish with their tile.
13. **The layout gets only zoom and extent.** Above the source's max zoom a
    tile's slots keep spreading apart on screen, so the density ceilings keep
    falling (2× per zoom for lines, 4× for polygons), particle placement
    re-rolls whenever the canonical tile changes, there are no feature ids, and
    polygons smaller than a cell may get no particles. The layout hashes
    tile-local positions, so a polygon covering whole tiles repeats one pattern
    in each. Polygon particles spawn within half a cell of their cell's
    candidate, which is 4 px at a tile's own zoom but 32 px at 8× overscale, so
    particles can land outside small polygons. The host also evaluates the
    layer's `filter` without the style's global state (host bug,
    `plugin_layout.cpp`; the built-in layouts pass it), so a filter reading
    `["global-state", …]` sees no values. _Fix:_ the canonical tile id and
    overscale in the layout context, and global state in the filter context.
14. **The uniform context lacks zoom, latitude and meters per pixel.** No world
    space on `particle-features`.
15. **`should_animate` gets no visibility, zoom range or expression information,
    and `styleDependencies` is never set** (host bug). Both types always
    animate, so a hidden particle layer keeps the map repainting: remove the
    layer instead of hiding it. _Fix:_ set `styleDependencies`, and skip
    `should_animate` for layers that do not render.
16. **OpenGL attribute mapping indexes the filtered list** (host bug,
    `shader_program_gl.cpp:176`). Patch `0008` maps by name, but upstream hosts
    do not yet, so data-driven properties on `particle-features` keep the
    compacted location ladder, which works either way. _Fix:_ land `0008`
    upstream, then drop the ladder.
17. **Property types.** No arrays, ramps or a particle-age expression input, so
    curves over life are start/end pairs. FLOAT2 bounds and the enum membership
    of expression results are not validated (the shader clamps). DOUBLE2 cannot
    be bound.
18. **Source-free layers get no world copies and no globe.** `project_mercator`
    unwraps against the wrapped center, so the plugin does its own Mercator and
    draws the one copy nearest the center. _Fix:_ a copy list or
    `renderWorldCopies` in the frame context.
19. **Metal fast-math and OpenGL mediump defaults, with no per-plugin control.**
    Float hi/lo emulation drifts (6 px at z19, measured), so large offsets are
    computed on the CPU in f64.
20. **Silent failures.** A bucket with `index_count == 0` is dropped without a
    log; MSL compile errors log every frame, with line numbers about 243 lines
    off.
21. **z scale.** The host scales altitude by meters per pixel at the camera's
    ground latitude; maplibre-gl-js uses the center latitude. Native and JS
    differ at low zoom and high pitch (14% at z4, pitch 60).
22. **Line pieces.** Slots follow a line's length, so density holds on detailed
    lines, and a short piece may get none. But each slot's particles stay on the
    piece it is anchored to and die at its ends, so on lines of many short
    segments they live only as long as they take to cross their piece. Slow
    particles with a long `particle-stretch` read best, as in the waterway
    preset.
23. **Web.** The source needs a companion visible style layer to load tiles.
    Past a vector source's max zoom maplibre-gl splits tiles instead of
    overscaling them, which lays particles out differently from native; create
    the map with `zoomLevelsToOverscale: undefined` for the same placement. MLT
    tiles are not read. Globe frames are the tangent plane at each emitter or
    feature anchor, the horizon cull is per anchor, and feature density follows
    Mercator tiles, so it thickens toward the poles. Terrain is ignored on both
    sides: particles sit at sea level. The layers read typed but undocumented
    maplibre-gl internals (`map.painter.transform`, the tile managers, raw tile
    data).
24. **`struct_size` versioning works only if hosts accept older sizes.** A host
    patch that grows a v1 descriptor struct and rejects the old `struct_size`
    breaks every existing plugin binary. Patch `0007` grows
    `mln_plugin_shader_descriptor_v1` by its texture fields and marks them
    optional in the header, but the registry still requires `struct_size` of at
    least its own size (`plugin_registry.cpp`), so a host with `0007` refuses a
    library built against an older header ("plugin shader descriptor is
    malformed") until it is rebuilt. The plugin holds itself to the rule in the
    other direction: it refuses an output bucket too short for the fields it
    writes and writes nothing past the host's size. _Fix:_ hosts accept every
    `struct_size` since the first v1 layout and read missing trailing fields as
    zero.

Considered and rejected: rebuilding every particle's clip position on the CPU
(rebuilds on every camera move), a float hi/lo camera stash (fast-math drift), a
`should_animate` paint stash (no layer identity), deriving meters from the tile
matrix (limit 14), and JS world copies (breaks parity with native).

## Native

```bash
mise run //plugins/particles/native:build   # zig-out/lib/libmaplibre-particles.*
mise run //plugins/particles/native:test
mise run //plugins/particles/native:shader-check
```

Load the library with the entry point `mln_particles_register` before loading a
style that uses either layer type, then add layer JSON like the examples with
the ordinary add-layer call. Particles are not hit-testable.

Two environment variables help testing: `MLN_PARTICLES_TIME=<seconds>` freezes
the plugin clock, and `MLN_PARTICLES_DEBUG=1` logs to stderr whenever a frame's
rows change (row count, pool sizes, layers over the limit, the camera), "pool
rebuilt N=…, row=…" whenever the vertex bytes handed to a row change, and
frame-table anomalies.

The plugin builds against the plugin ABI header alone and has no link dependency
on the host. Preview it with `mise run //apps/native-viewer:run particles`
(snow), or any preset with the flags above; the viewer re-applies the layer file
whenever you save it.

Cost, measured on an Apple M5 Pro (Metal, 800 × 600, ReleaseFast plugin and
harness, 300 frames rendered back to back, median of three runs): an empty
background style renders in 0.34 ms per frame of CPU time; snow at 7000 and at
16384 (pool 16384, 65540 vertices) in 0.47–0.49 ms, and a point emitter or
fireworks at 16384 in 0.55–0.61 ms, with 0.33–0.50 ms of GPU time against 0.28
ms. The four feature presets on OpenFreeMap bright cost within 0.02 ms of CPU
time and 0.13 ms of GPU time of the same view without the layer, and four
GeoJSON feature layers (no data-driven property, color, size and shape, and all
four) cost 0.12 ms of CPU time over the same style without them. Laying out a
tile takes 0.2 ms for 3000 points, 1 ms for a 20000-vertex polygon and 3.3 ms
for 5000 lines of 20 segments (thinned to 16383 particles). The process keeps
one copy of each table row's vertex bytes, shared by all render threads, for its
lifetime: the largest pool the row has used, at most 512 KiB per row (8 MiB for
all 16).

## Web

```ts
import {
  ParticleEmitterLayer,
  ParticleFeaturesLayer,
} from "@maplibre-plugins/particles";

map.addLayer(ParticleEmitterLayer.fromLayerJson(snowJson));
map.addLayer(ParticleFeaturesLayer.fromLayerJson(poiSparklesJson));

const fixed = ParticleEmitterLayer.fromLayerJson(fireJson, {
  clock: () => 12.5,
});
map.addLayer(fixed);
fixed.setPaintProperty("particle-color", "#ff8040");
fixed.setPaint({ "particle-count": 400 }, { duration: 500 });
```

Paint values accept literals, CSS color strings, or zoom expressions; the
feature layer also accepts feature expressions for its data-driven properties
and takes a `filter`. `fromLayerJson(json, { transition, clock })` takes the
same JSON as the native plugin; `clock` (`() => number`, seconds) replaces the
animation clock for deterministic frames, and `toLayerJson()` returns the layer
as style JSON. The layers need WebGL 2 and repaint only while visible and in
their zoom range.

`ParticleFeaturesLayer` reads the tiles maplibre-gl-js has already loaded for
its source, so it adds no requests, but the source must be used by at least one
visible style layer. It reads vector (MVT) and GeoJSON sources; leave out
`source-layer` for GeoJSON. For the same particle placement as native beyond the
source's max zoom, create the map with `zoomLevelsToOverscale: undefined`, as
the gallery does. After a WebGL context loss maplibre-gl drops custom layers:
add the same layer instance again.

At the same camera and clock, the JS layers match the native plugin to within
1.3 px (particle mask centroid) and 0.6% (coverage) on every preset. That
comparison ran the gallery in headless Chromium on SwiftShader; the JS layers
have not been checked on a hardware GPU.

## Development

Both implementations are tested against `spec.json` and share the shaders in
`shaders/`: `particle.glsl` (the model), `emitter.glsl` (an emitter row's clip
frame) and `shape.glsl` (the sprites). The fixtures in `fixtures/` pin the
twins:

- `hash.json` comes from `js/src/hash.ts`; `native/src/hash.zig` is checked
  against it.
- `model.json` holds inputs and outputs of `js/src/model.ts`, a TypeScript port
  of `particle.glsl`. The layers never run that port, so `js/src/model.test.ts`
  checks `model.json` against it and against `particle.glsl` itself, compiled
  for the CPU and run in f64 and in f32 on every input of `model.json` and
  `hash.json`: `mise run test` evaluates the shader both implementations draw
  with. The same file rasterizes `shape.glsl` on the CPU to check how small
  particles and ripples land on the pixel grid. The native tests do not read
  `model.json`.
- `record.json` comes from `native/src/record.zig` (the emitter's camera header
  and table row); `js/src/record.ts` is checked against it.
- `layout-*.json` pin both layout twins, `native/src/layout.zig` and
  `js/src/layout.ts`, byte for byte.

The `@clamp` comments in `shaders/particle.glsl` are the single list of
shader-side clamps, checked against spec.json on both sides. The spec tests also
validate every preset in `examples/` against its layer type, and
`js/src/docs.test.ts` checks what this README and the spec docs promise: the
viewer flags in the presets table against each preset's camera, zoom-faded
presets drawing nothing where they have faded out, and the numbers given for
alive particles, the count ramp and feature densities.

No test in the repo runs a shader on a GPU; the Metal and WebGL runtime checks
described above ran outside it. The unit tests run `particle.glsl` and
`shape.glsl` on the CPU, but not `emitter.glsl` or the backend wrappers.

`mise run //plugins/particles/native:shader-check` compiles every generated
native shader, `emitter.glsl` included, offline behind replica host preludes:
GLSL ES 3.00 and Vulkan GLSL 450 with `glslangValidator`, and MSL 2.4 with
fast-math through the Metal compiler (on macOS; skipped elsewhere). It is a
manual task, in neither `mise run test` nor CI, because it needs
`glslangValidator`: run it after changing a shader or the native shader
wrappers. The emitter ships on the frame table, the first rung of the fallback
ladder described under How it works.
