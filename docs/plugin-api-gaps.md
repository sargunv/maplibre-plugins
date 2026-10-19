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
  - building: a roof frame needs the whole footprint. Every tile draws its own
    copy, as core fill-extrusion does, and whole copies compute the same roof,
    but a copy the source cut at its buffer cannot, and draws roofless (walls to
    the eaves and a lid). So a building larger than the buffer, cut in every
    tile, draws roofless everywhere; none of the Bamberg example's 1,318 sloped
    roofs does with its buffer of 256
    ([Tile copies](../plugins/building/README.md#tile-copies)). The cut lines
    are inferred from the bounds of the tile's features, as the layout context
    has no buffer.
  - water: bands reaching across a tile edge would draw twice.
  - animated-icon: icons double while parent and child tiles both draw
    ([limit 10](../plugins/animated-icon/README.md#limits-and-future-improvements)).
  - particles: fallback tiles draw twice and plumes vanish with their tile
    (limit 12).
- Workaround: building draws every copy, cut copies roofless, and needs GeoJSON
  buffers larger than its buildings; water's fragment shader owns each fragment
  by the shoreline point it was extruded from; animated-icon and particles
  accept the doubling.
- Host fix: unclipped feature geometry, or each feature's unclipped bounds in
  the layout callbacks (building), or a stable feature id to stitch pieces
  across tiles as Mapbox's fill-extrusion does for its edge features, or a
  polygon analogue of GeoJSON's `lineMetrics`, which already tells a line's
  clipped range; a cross-tile index like symbols', or the set of tiles being
  drawn.

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

- Hits: building cannot order 3D hits nearest first natively. Its hits come in
  the host's order, as core fill-extrusion's do: by source order within a tile,
  last feature first. The web twin sorts nearest first by gl-js's
  `getIntersectionDistance`, as gl-js orders fill-extrusion
  ([Hit testing](../plugins/building/README.md#hit-testing)).
- Host fix: return an intersection distance, as gl-js's
  `getIntersectionDistance`, and sort 3D layers' hits by it.

**The broad phase searches around the ground point only.** Native unprojects the
query to the ground and searches each tile's grid around that point, padded by
`get_query_radius` pixels × `maxPitchScaleFactor` × tile units per pixel at the
camera zoom (`tile_pyramid.cpp`, `geometry_tile.cpp`, `feature_index.cpp`), and
only queries the tiles the padded box reaches. The callback gets bucket
statistics and camera paint but no zoom, latitude or viewport. A prism `H`
meters tall covers pixels up to `H × ppm × F` from its footprint, `ppm = 512 ×
2^zoom / (2π × 6378137 × cos latitude)` and `F = hypot(aspect × t, t × cos
pitch + sin pitch) / cos pitch` with `t = tan(fov / 2)`, so a radius without the
zoom is either a miss or a scan of every tile. Core fill-extrusion has the same
broad phase and returns only its translation; its narrow phase tests the 2D
footprint, so it misses these buildings too.

- Hits: building returns `|building-translate|`, as core does, and tests the
  projected prism of each candidate. The render test's query grids (every 20th
  pixel's center at 1200 × 800, `mise run
  //plugins/building/native:render-test`) miss 51% and 50% of the drawn points
  in the shapes example at pitch 60 and 55 (zoom 17.3 and 17.6), 13% top down,
  and 25%, 25% and 3% in Bamberg (pitch 60 at 16.5, 58 at 17.6, top down). The
  web twin tests every building and misses none
  ([Plugin API gaps](../plugins/building/README.md#plugin-api-gaps)).
- Measured with a test build that took the zoom from the environment, on the
  shapes example and the earlier Prague demo: padding by the formula with the
  bucket's maximum `building-height` brought every grid to 0.3% or less, so the
  formula is right, but Prague's 99 m spire padded the search past a whole tile
  at pitch 60, and a query took about 6 ms instead of 0.02 (a radius that scans
  every rendered tile: 8 ms, the same misses). The prism's sky above sloped
  roofs then starts to hit too (95 of the shapes grid's 1545 undrawn points
  against 1).
- Workaround: none that is both safe and cheap.
- Host fix: query 3D layers (`is_3d` plugins and core fill-extrusion) along a
  camera query geometry, as gl-js does: the hull of the query's ground points
  and the ground point under the camera, matched against the grid's cells
  (gl-js's `cameraQueryGeometry` with `polygonIntersectsBox` in `grid3D`). A
  building can only cover the query pixel if its footprint is between the ground
  point and the camera, so this needs no height, zoom or ABI change and offers
  far fewer candidates than a radius. Alternatively pass the zoom, the tile's
  latitude and the viewport to `get_query_radius` (an ABI change), at the cost
  measured above.

Against gl-js, then, the native building layer lacks a camera query geometry, a
3D grid and depth-ordered results. All three are host gaps that core Native's
fill-extrusion shares; the layer's narrow phase already matches gl-js's prism
test (and moves the prism rather than the query by the translation). On both
platforms the hit volume is the prism, not the roof's shape.

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
  building's render test passes on OpenGL ES through ANGLE), animated-icon
  (both).
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
- **Zig on macOS 27.** Zig 0.16's Mach-O unwinder does not know the arm64
  compact-unwind mode `FRAME_PAUTH_LR` that macOS 27's system libraries use
  ([ziglang/zig#37310](https://codeberg.org/ziglang/zig/issues/37310)), so
  unwinding off the main thread panics and then hangs on its own lock. That hung
  Debug viewer builds, whose debug allocator recorded a trace per allocation on
  the runtime thread; the viewer's allocator now records none, and Debug runs.
  The fix ([#37318](https://codeberg.org/ziglang/zig/pulls/37318), merged
  2026-10-18) is milestoned for Zig 0.17.1, with no 0.16 backport; see the patch
  README for what can still hit it.

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
