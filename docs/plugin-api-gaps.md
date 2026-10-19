# Plugin API gaps

What MapLibre Native's C plugin API lacks for the plugins in this repo, with
what each plugin does about it. The API is the one these plugins build against:
the FFI pin plus
[`patches/maplibre-native-ffi/`](../patches/maplibre-native-ffi/README.md)
(`0001`–`0006`), as vendored in
[`third_party/mln-plugin-api`](../third_party/mln-plugin-api/mln/plugin/plugin_api.h).
The plugin READMEs have the details; this page collects the gaps in one place
and links to them.

Each entry gives what is missing, which plugins hit it and how, the current
workaround, the carried patch that fills it (if any), the upstream status, and
what a proper host fix would be. Entries were checked against the vendored
header and the plugins' code on 2026-10-19.

Plugin READMEs: [location-indicator](../plugins/location-indicator/README.md),
[water](../plugins/water/README.md),
[animated-icon](../plugins/animated-icon/README.md#limits-and-future-improvements),
[particles](../plugins/particles/README.md#limits-and-future-improvements) and
[building](../plugins/building/README.md#limits-and-future-improvements).

## Upstream work referenced here

| Reference                                                                       | What                                                                   | Status (2026-10-19)            |
| ------------------------------------------------------------------------------- | ---------------------------------------------------------------------- | ------------------------------ |
| [Native #4685](https://github.com/maplibre/maplibre-native/pull/4685)           | fill-extrusion plugin rendering API: passes, 3D, light, layout, images | open, draft; carried as `0001` |
| [Native #4692](https://github.com/maplibre/maplibre-native/pull/4692)           | per-drawable depth, stencil and culling                                | merged                         |
| [Native #4721](https://github.com/maplibre/maplibre-native/pull/4721)           | reevaluate plugin camera paint when the zoom changes                   | merged                         |
| [Native #4707](https://github.com/maplibre/maplibre-native/pull/4707)           | OpenGL uniform blocks of 8 KiB and more                                | open; FFI carries it (`0034`)  |
| [Native #4708](https://github.com/maplibre/maplibre-native/pull/4708)           | OpenGL plugin attributes matched by name                               | open; FFI carries it (`0035`)  |
| [Native #4703](https://github.com/maplibre/maplibre-native/pull/4703)           | hit-test paint evaluated at the camera zoom                            | open; FFI carries it (`0028`)  |
| [Native #4704](https://github.com/maplibre/maplibre-native/pull/4704)           | query filters evaluated at the overscaled zoom                         | open; FFI carries it (`0029`)  |
| [Native #4533](https://github.com/maplibre/maplibre-native/pull/4533)           | globe projection, with projection fields for plugins                   | open; not carried              |
| [Native #4534](https://github.com/maplibre/maplibre-native/pull/4534)           | sky, with projection fields for plugins                                | open; not carried              |
| [style-spec #1881](https://github.com/maplibre/maplibre-style-spec/issues/1881) | proposed `["scale"]` expression: meters per pixel at the camera target | open proposal                  |

Patches `0002`–`0006` are this repo's own extensions; no upstream pull request
for them was found on 2026-10-19.

## Filled by carried patches

| Patch                                   | Fills                                                                                                                                                                      | Used by                                 |
| --------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------- |
| `0001` fill-extrusion rendering API     | draw passes, `is_3d`, `evaluate_layer`, light, zoom and tile id in the uniform context, layout, `BOOLEAN` and `IMAGE` properties, `COLOR_RGBA8`, instancing, pattern atlas | building                                |
| `0002` source-free plugin layers        | `build_frame`: per-frame geometry without a source; camera and geographic helpers; `DOUBLE2` values                                                                        | location-indicator, particles (emitter) |
| `0003` plugin rotation properties       | `ROTATION` values that transition along the shortest arc                                                                                                                   | location-indicator, animated-icon       |
| `0004` plugin frame queries             | hit envelopes for source-free features                                                                                                                                     | location-indicator                      |
| `0005` plugin static textures           | static RGBA32F data textures for plugin shaders                                                                                                                            | animated-icon                           |
| `0006` plugin feature layout properties | feature-dependent layout values per feature, tile id in the layout context                                                                                                 | building                                |

## Geometry and layout inputs

**Feature-dependent layout properties.** #4685's layout properties accept camera
expressions only and are evaluated once per tile, and `mln_plugin_feature_v1`
carried no property values.

- Hits: building's `building-roof-shape`, `-orientation` and `-direction` are
  per feature.
- Workaround: none that keeps roofs per feature.
- Carried: `0006` appends `layout_properties` to the feature and allows
  `FEATURE` and `COMPOSITE` on `is_layout` properties.
- Still missing: data-driven `IMAGE` layout properties (rejected at
  registration); range clamping of data-driven layout values (gl-js does not
  clamp either; building's layout reads any negative direction as unset, and its
  shader clamps the data-driven roof angle); `query_feature` gets the layout
  values at the camera zoom without a tile id, so zoom-dependent or
  `within`/`distance` layout expressions can differ from the layout's.
- Host fix: take `0006` into #4685 or a follow-up.

**Tile id and overscale in the layout context.** The layout context had only the
zoom and extent.

- Hits: particles' polygon placement re-rolls when the canonical tile changes
  and repeats per tile
  ([limit 13](../plugins/particles/README.md#limits-and-future-improvements)).
- Carried: `0006` appends `tile_x`, `tile_y`, `tile_z`; the context's `zoom` is
  the overscaled z. No plugin reads them yet.
- Host fix: take `0006` upstream.

**Layer filters lose global state.** The plugin layout evaluates a layer's
`filter` without the style's global state, unlike the built-in layouts
(`plugin_layout.cpp`).

- Hits: particles (`["global-state", …]` in a filter sees no values).
- Workaround: none. Host fix: pass global state to the filter context.

**Only tile-clipped geometry, and no cross-tile identity.** A plugin sees each
feature clipped to one tile plus its buffer, with a tile-local `feature_index`
and no feature id, and does not know which neighboring tiles are drawn.

- Hits:
  - building: a roof frame cannot be computed the same way in every tile a
    building spans. Footprints crossing a tile edge get flat roofs (32 of the
    Prague example's 739 non-flat roofs), and footprints only in a buffer are
    skipped, so they are missing while their owning tile loads
    ([Tile ownership](../plugins/building/README.md#tile-ownership)).
  - water: bands reaching across a tile edge would draw twice.
  - animated-icon: icons double while parent and child tiles both draw
    ([limit 10](../plugins/animated-icon/README.md#limits-and-future-improvements)).
  - particles: fallback tiles draw twice and plumes vanish with their tile
    (limit 12).
- Workaround: building owns each footprint by tile and needs large GeoJSON
  buffers; water's fragment shader owns each fragment by the shoreline point it
  was extruded from; animated-icon and particles accept the doubling.
- Host fix: unclipped feature geometry, or a stable feature id with its full
  bounds; a cross-tile index like symbols', or the set of tiles being drawn.

**Source-free layers.** Upstream plugin layers need a style source.

- Hits: location-indicator (one position), particles' `particle-emitter`.
- Carried: `0002` (`build_frame`, frame camera, geographic helpers, `DOUBLE2`).
  It rejects draw passes, `is_3d`, image properties and pattern textures on
  source-free layers.
- Still missing: world copies and globe (particles limit 18); see also the
  uniform-context and frame-table entries below.
- Host fix: upstream `0002`.

## Rendering state and passes

**Draw passes, 3D depth and culling.** Upstream drawables get per-drawable
depth, stencil and culling (#4692) but no ordered passes across a layer's tiles
or 3D depth.

- Hits: building needs fill-extrusion's opaque pass, depth pre-pass and
  stencil-deduplicated translucent pass
  ([Draw passes](../plugins/building/README.md#draw-passes-opacity-and-translate)).
  water's draw-once idea (option 2 in its
  [limits](../plugins/water/README.md#limits-and-future-improvements)) needs a
  layer-wide depth pre-pass.
- Carried: `0001` (#4685).
- Still missing:
  - Passes are per layer and all-or-nothing: a layer that declares passes
    ignores the per-drawable depth, stencil and cull fields, so walls and roofs
    with different state need pass masks.
  - Cull modes are `NONE` and `BACK_CCW` only. building winds its layout as core
    does to fit.
  - The carried merge differs from #4685 for an `is_3d` layer without passes: it
    gets 2D depth. building always declares its passes. Fix: use `is3D ||
    enable_stencil_overlap` in that branch, or reject `is_3d` without passes.
  - Translucent non-3D layers still get near-plane z, and OpenGL collapses depth
    per layer (particles limit 11).
- Host fix: land #4685, with a CW cull mode.

**No render targets, compute or blend modes.** Plugins draw straight into the
frame with premultiplied-over blending.

- Hits: water's offscreen accumulation with max blending; particles' additive
  light, trails and bloom (limits 9 and 10); animated-icon cannot cache a
  resting icon (limit 11).
- Workaround: overlap tolerated (water), screen tints (particles).
- Host fix: offscreen passes with blend modes, as heatmap uses internally. #4685
  does not add them.

**Camera-only paint still needs an attribute.** A paint property reaches a
shader only through a binding, which needs a declared vertex attribute (counted
against `MLN_PLUGIN_MAX_VERTEX_ATTRIBUTES`, 16) and an interpolation slot in a
drawable-scope block.

- Hits: animated-icon declares 14 attributes (limit 13); particles'
  `particle-features` is capped at 14 properties (limit 1); building declares
  never-bound attributes 10 and 11 for its opacity and gradient, and copies the
  layer-wide light into every drawable's block because a block holding binding
  factors must be drawable-scope.
- Host fix: a uniform-only binding kind, or evaluated paint in a layer-scope
  block.

**Uniform context inputs.** `0001` adds the render zoom, canonical tile id and
wrap, and the evaluated light. Still missing: frame time, pitch and roll, the
tile extent, and a meters-to-pixels scale.

- Hits: animated-icon and particles run their own clocks (animated-icon limit 4,
  particles limit 5); animated-icon's placement needs pitch and roll (limit 7);
  building derives `meters_per_tile_unit` from the tile id and assumes extent
  8192
  ([Tile units and meters](../plugins/building/README.md#tile-units-and-meters));
  particles has no world space on `particle-features` (limit 14), and its
  altitude scale differs from gl-js at low zoom (limit 21).
- Upstream: #4533 and #4534 append projection fields that conflict with #4685's;
  not carried.
- Host fix: append frame time, pitch, roll, extent and meters per pixel.

**`build_frame` cannot write uniforms, and the uniform callback has no layer
identity.** The source-free uniform context also has no camera.

- Hits: particles' emitter keeps a thread-local frame table, capped at 16
  visible emitter layers, that relies on `build_frame` running before the
  uniform callbacks (limits 2 and 3).
- Host fix: `build_frame` returns layer-block bytes, or the uniform context
  carries a per-layer user-data pointer and the frame camera.

**Instancing and the pattern atlas are Vulkan and Metal only.** `0001` (#4685)
adds both, and the registry rejects them on OpenGL. The atlas takes sampler
binding 0, so a shader with it cannot use static texture id 0.

- Hits: nobody uses them yet. particles (limit 7) and animated-icon would
  instance their quads; OpenGL would keep the current path.
- Host fix: an OpenGL path (attribute divisors).

## Resources and textures

**Static data textures.** Upstream plugins get no textures.

- Hits: animated-icon's catalog.
- Carried: `0005`: up to 3 RGBA32F textures per shader, 2048 × 2048, nearest
  filtering, fragment stage.
- Still missing: dynamic or streamed textures (animated-icon limits 3 and 14),
  filtered sprite textures (particles limit 9; #4685's `IMAGE` properties and
  atlas give sprites on Vulkan and Metal only), a resource loader for plugins.
- Host fix: upstream `0005`, then dynamic textures.

**Registration is per process.** The host keeps one descriptor per plugin id and
layer type, and enum values are fixed at registration.

- Hits: animated-icon registers one catalog per process, and a style cannot name
  one (limit 1).
- Host fix: resource loading for plugins, with enum values resolved per style
  layer.

## Evaluation and expressions

**Value types.** Upstream has no rotation, double-precision or boolean values.

- Carried: `0002` `DOUBLE2` (location-indicator `position`, particles
  `emitter-position`); `0003` `ROTATION` (location-indicator `bearing`,
  animated-icon `icon-rotate`); `0001` `BOOLEAN` with `BOOLEAN_FLOAT` and packed
  `COLOR_RGBA8` colors (building).
- Still missing: `DOUBLE2` cannot be bound; arrays, ramps and an age input
  (particles limit 17); composite rotations interpolate the long way
  (animated-icon limit 19).

**`supports_transitions = 0` is not honored.** Such a property still goes
through the style transition, and strings hold their old value until it ends.

- Hits: animated-icon (limit 6), particles (limit 4); the JS twins mirror it.
- Host fix: treat it as an instant change.

**`should_animate` sees no features, visibility or zoom range.**
Feature-dependent values evaluate without a feature.

- Hits: animated-icon repaints whenever `icon-animation` is set (limit 5);
  particles keeps repainting while hidden (limit 15).
- Upstream: #4721 (merged) reevaluates camera paint on zoom.
- Host fix: tell `should_animate` which properties depend on the feature, and
  skip layers that do not render.

**No ground scale in expressions.** Styles can size by zoom but not in meters,
because pixels per meter also depend on latitude.

- Hits: location-indicator computes its accuracy circle in meters itself;
  building computes `meters_per_tile_unit` for roof angles; particles' `world`
  space computes meters itself. water's `shore-width` is in pixels.
- Upstream: style-spec #1881 proposes `["scale"]`, meters per pixel at the
  camera target. It would let styles give widths and radii in meters, but would
  not replace the plugins' own per-vertex math.

## Queries

**Source-free hit testing.** Upstream queries need tile features.

- Hits: location-indicator's puck and arrow. Carried: `0004`.

**`query_feature` returns a boolean.** It cannot report depth.

- Hits: building cannot order 3D hits nearest first natively (the web twin
  does).
- Host fix: return an intersection distance, as gl-js's
  `getIntersectionDistance`.

**The broad phase searches around the ground point only.** `get_query_radius`
gets bucket statistics and camera paint but no zoom, latitude or pitch, so it
cannot pad by a building's projected height.

- Hits: building. Measured at pitch 60, Native misses 48% of the buildings'
  pixels in the shapes example (zoom 17.3) and 23% in Prague (zoom 16.5); the
  web twin misses none
  ([Plugin API gaps](../plugins/building/README.md#plugin-api-gaps)).
- Workaround: none; padding by a guess would test every building on every tile.
- Host fix: pass the zoom and tile latitude to `get_query_radius`, or query 3D
  layers with a camera query geometry as gl-js does.

**Query evaluation zoom and context.** FFI `0028` (#4703) evaluates hit-test
paint at the camera zoom and `0029` (#4704) query filters at the overscaled
zoom. The query context has no canonical tile id.

- Hits: building relies on camera-zoom heights. animated-icon's limit 12 and its
  JS twin still describe and mirror the tile zoom; not re-checked against
  `0028`. Rendered-feature queries return nothing at pitch 80° and above, for
  built-in layers too.
- Host fix: merge #4703 and #4704; add the tile id to the query context.

## ABI and compatibility

**Hosts reject older struct sizes.** Every plugin-to-host struct must have
`struct_size` of at least the host's own `sizeof`, so "optional, introduced
after X" in the header only means a pointer may be null.

- Hits: every plugin binary must be rebuilt for each patch stack. water,
  animated-icon, particles and building in turn reject host structs shorter than
  their header's, so each needs a host with `0001`–`0006` (particles limit 24,
  water's [Native host](../plugins/water/README.md#native-host)).
- #4685 makes it worse: it inserts layer-type fields before
  `enable_near_clipped_matrix`, removes `enable_stencil_overlap_dedup`, and
  renumbers `DOUBLE2` and `ROTATION` to 7 and 8. Zig's translated structs
  default new fields to zero, so Zig plugins with designated initializers keep
  compiling; C plugins with positional initializers would not.
- Host fix: accept every `struct_size` since the first v1 layout and read
  missing trailing fields as zero; make #4685 append-only.

**OpenGL attribute matching and large uniform blocks.** Upstream OpenGL indexes
the filtered attribute list by location and crashes on uniform blocks of 8 KiB
and more.

- Hits: location-indicator, `particle-features` and building (attribute gaps;
  building's OpenGL path is compile-checked only), animated-icon (both).
- Carried by the FFI: `0035` (#4708) and `0034` (#4707).

**Backend limits not in the header.** Metal's `setVertexBytes` takes at most 4
KiB, so particles keeps its blocks below that. Metal compiles with fast-math and
OpenGL ES defaults to `mediump` and `lowp` samplers, with no per-plugin control
(particles limit 19, animated-icon limit 18).

## Tooling and hosts

- **Silent failures.** A bucket with `index_count == 0` is dropped without a
  log; MSL compile errors log every frame with line numbers about 243 lines off
  (particles limit 20).
- **Native tests outside the FFI build.** The FFI builds Native core-only, so
  Native's `test/plugin` suites and #4685's fill-extrusion plugin are not built
  by `mise run ffi:build`; they need an out-of-tree harness. In it, two
  static-texture tests count 36 uploaded bytes on Metal where they expect 32;
  the cause is not found. See the patch README's validation notes.
- **FFI patch sync.** `sync-submodules` cleans every path a patch touches before
  applying it, so a later patch cannot edit a file an earlier one creates.
  #4685's fill-extrusion README therefore still says layout properties cannot
  use feature expressions. Fix: clean only created paths.
- **No `promoteId` in Native.** Feature-state needs top-level numeric GeoJSON
  ids. building's OSM example offsets relation ids by 10^12 to keep them apart
  from way ids. The web twins read ids through gl-js's feature index, which
  honors `promoteId`.
- **GeoJSON simplification at maxzoom.** Native's geojson-vt-cpp still
  simplifies tiles at the source's maxzoom (it keeps points with `p.z >
  sq_tolerance`, and that tolerance is 0 there), unlike gl-js. Round footprints
  become octagons and small parts vanish, in core layers too. building's
  examples set `"tolerance": 0`
  ([Source options](../plugins/building/examples/osm/README.md#source-options)).
- **Native viewer reload.** Properties removed from the layer JSON are not reset
  on reload; only present keys are set. Setting removed keys to `null` would fix
  it.
- **Zig on macOS 27.** Zig 0.16's Mach-O unwinder panics on macOS 27 system
  frames, which crashed Debug viewer builds while the debug allocator recorded
  stack traces. The viewer now records none.

## maplibre-gl-js custom layers

The web twins meet gaps on the gl-js side; each plugin isolates the internals it
reads in `js/src/gljs.ts` (or the layer), checked at run time.

- **Tiles load only for built-in layers.** A source's tiles load only while a
  visible built-in layer uses it, so animated-icon and building add a hidden
  `<id>-tiles` helper layer and water and particles need a companion layer.
- **Tile data and the transform are internal.** The layers read decoded tiles,
  the feature index and the transform through undocumented members, so a gl-js
  update can break them.
- **3D stencil and the evaluated light are internal.** building takes its
  translucent pass's stencil reference from `painter.stencilModeFor3D()` and the
  transitioning light from `map.style.light`; without them the pass draws
  undeduplicated or uses the raw light.
- **Context loss.** gl-js drops custom layers when the WebGL context is lost;
  apps add them again.
- **Overzoom.** Past a vector source's maxzoom gl-js splits tiles instead of
  overscaling them, unless the map sets `zoomLevelsToOverscale: undefined`
  (particles limit 23).
- **gl-js's own fill-extrusion query** moves the query by `−translate` instead
  of moving the prism, which misses translated walls of tall buildings by a few
  pixels in perspective. building's hit test moves the prism
  ([Hit testing](../plugins/building/README.md#hit-testing)).
