# maplibre-native-ffi patches

`scripts/sync-ffi` applies these to `third_party/maplibre-native-ffi` on top of
the pinned upstream commit, as commits (`git am`). Each patch carries a focused
MapLibre Native change into the FFI's `patches/maplibre-native/` and its
`sync-submodules` list. Drop a patch when the host includes its change.

The FFI pin is `44d24a1cfd9cb1b1b25a8c36e8e2472f0e392e18`, with Native pinned to
`254d0a872407c15e9ea4211691af0abeb7e18f16`.

| Patch                                              | Native patch | Purpose                                                                                   |
| -------------------------------------------------- | ------------ | ----------------------------------------------------------------------------------------- |
| `0001` plugin fill-extrusion rendering API (#4685) | `0042`       | draw passes, 3D/light/tile inputs, layout and image properties, instancing for `building` |
| `0002` source-free plugin layers (`build_frame`)   | `0043`       | per-frame geometry without a style source                                                 |
| `0003` plugin rotation properties                  | `0044`       | shortest-arc rotation transitions                                                         |
| `0004` plugin frame queries                        | `0045`       | hit envelopes for source-free rendered features                                           |
| `0005` plugin static textures (RGBA32F)            | `0046`       | `animated-icon` catalog data                                                              |
| `0006` plugin feature layout properties            | `0047`       | per-feature `building-roof-*` layout values and the tile id for `building` layout         |

`0001` vendors the draft
[maplibre-native#4685](https://github.com/maplibre/maplibre-native/pull/4685)
(head `c068ede8bd4a3c859c449bd073c0da3a67857f46`), rebased onto the Native pin.
It changes the plugin ABI: `BOOLEAN` and `IMAGE` take value types 5 and 6, so
`DOUBLE2` and `ROTATION` move to 7 and 8; `enable_stencil_overlap_dedup` is
gone; the layer type, shader, segment, attribute binding, uniform and layout
context structs grow. The host rejects descriptors shorter than its own structs,
so every plugin library must be rebuilt against the refreshed vendored header.

Animation, default-color premultiplication, near-clipped tile matrices and
[per-drawable depth, stencil and culling](https://github.com/maplibre/maplibre-native/pull/4692)
are upstream. A layer without draw passes keeps that per-drawable behavior:
tile-driven drawables explicitly select read-only depth to retain their previous
behavior, and the descriptor's zero depth mode disables depth testing. A layer
with draw passes ignores the per-drawable fields. This differs from #4685 for an
`is_3d` layer without draw passes: #4685 marks each of its drawables 3D with a
read-only 3D depth mask, while here only `enable_stencil_overlap` drawables are
3D and the others keep 2D depth. A 3D layer should declare its passes. The
source-free path retains read-only depth and no stencil or culling, and rejects
draw passes, `is_3d`, image properties and tile pattern textures.

The PR's fill-extrusion plugin, a reference for the `building` shaders, is in
the FFI's `patches/maplibre-native/0042-vulkan-fill-extrusion-plugin.patch` and,
after `mise run ffi:build`, in
`third_party/maplibre-native-ffi/third_party/maplibre-native/plugins/fill-extrusion/`:
`shared/cpp/fill_extrusion.cpp` (layout, draw passes, uniforms),
`shared/cpp/shaders.hpp` (Vulkan GLSL and Metal), `shared/cpp/rounded.hpp` and
`README.md`.

## Patch audit, 2026-10-18

The FFI pin moves from `4da98bb2` to `44d24a1c`. Its eleven commits concern
Apple framework packaging, Android Prefab, docs and tooling; none changes
`patches/maplibre-native/` or `sync-submodules`, and the Native pin is still
`254d0a87`. FFI's patches still end at `0041`, so ours become `0042`–`0046`.

#4685 was rebased from its base `3db2ced5` onto `254d0a87` plus the FFI's own
Native patches, as one squashed change. Since that base, upstream added
per-drawable depth, stencil and culling
([#4692](https://github.com/maplibre/maplibre-native/pull/4692)) and plugin
camera-paint reevaluation
([#4721](https://github.com/maplibre/maplibre-native/pull/4721)). Conflict
decisions:

- Drawable descriptors keep #4692's `depth_mode`, `enable_stencil_overlap`,
  `cull_back_faces`, `blend_mode` and `reserved` after #4685's fields. The
  registry records whether a layer declared draw passes; a layer without them
  still gets one translucent pass, but each drawable selects its state exactly
  as upstream does, and #4685's 3D depth-mask override applies only to declared
  passes. Pass-0 draw priority and the pattern-atlas tweaker apply to both.
- `enable_stencil_overlap_dedup` is removed, as #4685 does; its job moves to a
  stencil-dedup draw pass on an `is_3d` layer. #4692's per-drawable
  `enable_stencil_overlap` stays.
- #4721's style-dependency refresh survives #4685's evaluation rewrite
  unchanged; layout properties are excluded from paint evaluation as #4685 does.
- `LayerManager::registerLayerFactories` takes #4685's `replaceBuiltins`
  parameter with upstream's `hasLayerType` outside the plugin-only block.
- The rendering and layout tests merge both sides: descriptors carry #4685's
  segment and binding fields with #4692's read-only depth, and the
  should-animate test plugin's paint property becomes camera-only, since the
  base now makes it data-driven without a paint binding.
- The PR's header said instancing and pattern atlases are Vulkan-only, while its
  merged Metal port allows Metal too; the comments now say so.
- The PR's `plugins/fill-extrusion`, `plugins/ngon-layer` and `platform/glfw`
  changes are kept. Native's `mln-plugin-api-tests` target compiles the
  fill-extrusion geometry tests and links the plugin, and ngon needs the new
  shader-descriptor fields. The FFI builds Native core-only, so none of this
  reaches the FFI library.

Rebasing our four patches on top:

- Source-free layers (`0043`) moved the bucket geometry copy into
  `PluginBucket::copyGeometry`, which had silently dropped #4692's skipping of
  paint bindings whose attributes the shader does not declare. The copy now
  carries #4692 and #4685 (element offsets, instance ranges, primitive vertex
  counts), `hasSameGeometry` compares the instance fields, and the frame path
  binds element offsets and instanced attributes. Frame properties now include
  layout properties, evaluated at the camera zoom.
- Rotation (`0044`) and `DOUBLE2` take value types 8 and 7; the registry,
  binders and property conversions handle `BOOLEAN` and `IMAGE` alongside them.
- Frame queries (`0045`) applied without conflicts.
- Static textures (`0046`) append `textures` and `texture_count` after #4685's
  `tile_pattern_texture` and `instanced`. The pattern atlas takes sampler
  binding 0, so a shader with an atlas cannot declare static texture id 0, and
  the uniform context's `pattern_texture_size` reads slot 0 only from atlas
  shaders.

Our extensions stay append-only within their structs: `source_free` and
`build_frame` after `should_animate`, static textures after #4685's shader
fields, frame features at the end of the query context. #4685 itself inserts its
layer-type fields before `enable_near_clipped_matrix`, so its layout is the PR's
to settle.

Open Native PRs touching the plugin API were checked on 2026-10-18. The sky
([#4534](https://github.com/maplibre/maplibre-native/pull/4534)) and globe
([#4533](https://github.com/maplibre/maplibre-native/pull/4533)) PRs append
projection fields to the uniform and query contexts and describe globe depth for
drawables. A 3D building layer does not need them on Mercator, and they would
conflict with #4685's uniform-context fields, so neither is carried.
[#4707](https://github.com/maplibre/maplibre-native/pull/4707) and
[#4708](https://github.com/maplibre/maplibre-native/pull/4708) remain FFI
`0034`/`0035`. [#4382](https://github.com/maplibre/maplibre-native/pull/4382),
[#3999](https://github.com/maplibre/maplibre-native/pull/3999) and
[#3958](https://github.com/maplibre/maplibre-native/pull/3958) propose other
plugin systems or protocol handlers.

#4685's layout properties accept camera expressions only, and `layout_feature`
receives no per-feature property values. The `building` layer's
`building-roof-shape`, `-orientation` and `-direction` are feature-dependent, so
`0006` extends them.

## Feature layout properties (`0006`), 2026-10-18

`0006` lets a layout property (`is_layout`) declare `FEATURE` and `COMPOSITE`
expression capabilities, as core's data-driven layout properties do. Layout
properties still cannot transition or use `feature-state`, image layout
properties stay camera-only, and source-free layers still reject every
data-driven property. A layout property needs no shader binding.

- During tile layout the host evaluates every layout property for each feature
  that passes the filter, at the tile's overscaled zoom (COMPOSITE included) and
  with the canonical tile id for `within`/`distance`. It passes the values to
  `layout_feature` in two fields appended to `mln_plugin_feature_v1`:
  `layout_properties` and `layout_property_count`, in definition order, with the
  names and order of `mln_plugin_layout_context_v1.properties`. Plugins read
  them only when `struct_size` covers them.
- A null result, a value of the wrong type, a non-finite number or a string
  outside `enum_values` falls back to the default, matching maplibre-gl-js's
  evaluation of enum properties. Numbers are not clamped to the descriptor's
  range; the range still validates constants.
- `create_layout` keeps one value per layout property. A feature-dependent value
  has no tile-wide value, so it reads as the default there; `explicitly_set`
  still reports that the style sets it.
- `mln_plugin_layout_context_v1` appends `tile_x`, `tile_y` and `tile_z`, named
  as in the uniform context. The context's `zoom` is the overscaled z, so there
  is no separate field for it.
- `query_feature` receives the same appended feature fields, evaluated for the
  queried feature at the query zoom (the camera zoom, as for paint since FFI
  `0028`), without the tile id. Its property array now carries the style's
  layout values too: before `0006` it passed every layout property's default,
  because layout properties are not part of paint evaluation.

#4685 already parses plugin layout properties from the style's `layout` object,
serializes them back there, and re-lays out tiles when one changes, because
`hasLayoutDifference` compares layout values. An unscoped `setProperty`, which
the C API's `mln_map_set_layer_property` and therefore the native viewer's
reload path use, reaches the same path. Native tests cover this.

New tests in Native's `test/plugin`:

- `PluginLayout.EvaluatesLayoutPropertiesPerFeature` and
  `PluginLayout.LayoutPropertiesDefaultWhenUnset` check that feature and
  composite values reach `layout_feature`, that camera-only values still work,
  the order of the values (paint properties left out), the fallbacks for enum,
  type and missing values, `explicitly_set`, and the tile id and zoom.
- `PluginRendering.LayoutPropertyChangesLayOutTilesAgain` loads a style with a
  data-driven layout value, checks the pixels and the hit test, and checks that
  each `setProperty` (constant, expression, `null`, a value outside the enum)
  lays the tile out again with the new values.
- `PluginApi.LayoutPropertiesValidateScopeSerializeAndInvalidateGeometry` now
  rejects `FEATURE_STATE`, data-driven image layout properties and data-driven
  layout properties on source-free layers, accepts `FEATURE` and `COMPOSITE`
  with no shader binding, and parses and serializes a data-driven layout
  expression while rejecting `feature-state` in it.

The Native fill-extrusion README, which #4685 adds, still says layout properties
cannot use feature expressions. The FFI's sync removes every file a patch
touches before applying it, so a later patch cannot edit a file an earlier patch
adds; the sentence stays until #4685 changes or the sync learns to remove only
created files.

## Independent verification, 2026-10-18

The host work above was checked again from scratch:

- `scripts/sync-ffi` is a no-op on the exported stack. `scripts/sync-ffi force`
  replays all six patches onto the pin with the same FFI tree (`8f9457ab`), the
  next sync is a no-op, and a fresh export is byte-identical.
- Native `254d0a87` plus the FFI's patches through `0041`, then `0042`–`0047`
  applied with `git apply`, gives exactly the tree that `mise run ffi:build`
  leaves in `third_party/maplibre-native`, and its `plugin_api.h` is
  byte-identical to the vendored copy.
- `0042` against `gh pr diff 4685` (head still `c068ede8`): the same 54 files.
  The changed lines match the PR in all but five files. Those differences are
  the ones listed in the audit above: the header's draw-pass, drawable and
  Vulkan-and-Metal comments, `explicitDrawPasses` in the registry, the
  per-drawable state branch in `render_plugin_style_layer.cpp` (its cull
  condition is the same as upstream #4692's), and the rendering-test helper
  merge. Nothing else from the PR is dropped or altered.
- The FFI build, its C API tests, the out-of-tree Native plugin tests (61 of 63,
  the same two static-texture byte counts failing), every plugin's Zig tests,
  the JS tests other than the in-progress `plugins/building/js`, `mise run
  build`, `mise run bake:check`, `mise run check`, the location-indicator render
  test, the viewer's unit tests and the ReleaseSafe smoke runs listed below all
  pass again. The default Debug viewer still hit the Zig unwinder panic
  described under 2026-10-12, and hung in it; it no longer does (next section).

## Debug viewer, Vulkan and OpenGL, 2026-10-18

**Debug viewer.** The panic is
[ziglang/zig#37310](https://codeberg.org/ziglang/zig/issues/37310): Zig 0.16's
Mach-O unwinder (`std.debug.SelfInfo.MachO`) has no case for the arm64
compact-unwind mode `FRAME_PAUTH_LR` (5), which macOS 27's system libraries use.
Unwinding into such a frame panics with "switch on corrupt value" while holding
the debug-info lock, and the panic handler then waits on that lock forever.
[#37318](https://codeberg.org/ziglang/zig/pulls/37318) fixes it; it was merged
on 2026-10-18 for the 0.17.1 milestone, so 0.16.0 and 0.17.0 lack it, and there
is no 0.16 backport. The repo stays on Zig 0.16.0.

On this host (macOS 27.0.1, Zig 0.16.0) a probe program shows where it bites:
the main thread's stack ends in dyld and unwinds fine, but every spawned
thread's ends in `libsystem_pthread`, whose entry frame has the new mode.

- Capturing or printing a stack trace off the main thread hangs: a
  `DebugAllocator` that records traces (the Debug default, 6 frames),
  `std.debug.captureCurrentStackTrace`/`dumpCurrentStackTrace`, and Debug's
  `unexpected_error_tracing` (an unexpected errno dumps a trace).
- A panic or segfault off the main thread prints the Zig frames, then aborts
  with "aborting due to recursive panic" instead of hanging.

The viewer's runtime thread allocated through a trace-recording
`DebugAllocator`, so Debug builds hung before the map existed. `main.zig` now
uses `DebugAllocator(.{ .stack_trace_frames = 0 })`, and the runtime thread
allocates only through it; `init_args.gpa` (start.zig's allocator, which still
records traces in Debug) stays on the main thread. Restoring the default frames
reproduces the hang at once. With the change the default Debug viewer runs every
task against the Metal install: `run building`, `building-osm` (with a scripted
click hit), `run location-indicator`, `run water`, `run animated-icon`, `run
particles` and `weather` (click hit) each reach `--exit-after` with status 0.
Left as is: an unexpected errno on the runtime thread would still hang a Debug
build, and a panic there loses the frames below the thread entry. Both go away
with Zig 0.17.1; ReleaseSafe avoids the allocator path entirely.

**Vulkan and OpenGL ES.** The FFI's `macos-arm64-vulkan` (MoltenVK and the
Vulkan loader from Homebrew, as its `mise.macos.toml` sets up) and
`macos-arm64-egl` (the ANGLE build pinned in `third_party/angle/manifest.json`,
downloaded at configure time) presets build this patch stack in their own
`build/<preset>` directories; `MLN_NATIVE_PRESET=<preset> mise run ffi:build`
builds one and points the native apps at it. Their installed `plugin_api.h` is
byte-identical to the vendored header, and the FFI's C API tests pass on both.

- The building render test passes all 23 cameras on Metal, Vulkan and OpenGL ES:
  every query, and the four core fill-extrusion pixel comparisons with the same
  sampled colors on all three. Against Metal the frames differ only where
  coplanar OSM parts z-fight (at most 0.085% of the pixels, in the castle views)
  and in single edge pixels.
- The Debug viewer, built against each install, runs every task above to
  `--exit-after` with no native diagnostics, the scripted clicks included. These
  smoke runs check logs and queries, not pixels.

Both run on the same Apple GPU: MoltenVK and ANGLE translate to Metal. They
exercise Native's Vulkan and OpenGL renderers, our patches' paths through them
and the plugins' GLSL, but not other drivers. A Linux runner (Mesa's lavapipe
for Vulkan, EGL on llvmpipe or a GPU) or Windows with a Vulkan SDK would cover
those. location-indicator's render test is still Metal-only.

## Plugin migration and validation, 2026-10-18

The four plugins build against the refreshed vendored header with one source
change each: they no longer set the removed `enable_stencil_overlap_dedup`
(always 0). Every other new field defaults to zero in Zig's translated structs,
which keeps the previous behavior: no draw passes, so each drawable keeps its
read-only depth and no stencil or culling; no `is_3d`, `evaluate_layer`,
instancing or pattern atlas; zero element offsets and instance ranges; no layout
properties. The plugins name `DOUBLE2` and `ROTATION` through the header's
constants, so the renumbering needs no source change. The native viewer loads
plugins through the installed `maplibre-native-c` header and needed no change.

particles' test-only copy of the host's registration checks follows the new
registry: layout-property and draw-pass validation, the source-free `is_3d` and
pattern-texture rejections, the new encodings and value types, and the reworded
transition error. Four mutations cover the new rules. The plugin READMEs give
the new outer numbers: location-indicator needs `0002`–`0004`, animated-icon
`0003`–`0005`, particles `0002`, and water none, but each needs a host with the
whole stack because the structs it is built against include every patch.

Against the macOS ARM64 Metal install of this stack (header byte-identical to
the vendored copy):

- Each plugin's `zig build test` passes (location-indicator 6, water 14,
  animated-icon 30, particles 76 tests), as do `zig build` and ReleaseSafe
  builds. `mise run test`, `mise run build` and `mise run bake:check` pass.
  `mise run check` fails only on the in-progress `plugins/building/` files.
- The location-indicator render test passes all eight Metal fixture cameras,
  pixels and rendered-feature hit/miss queries included.
- The native viewer's unit tests pass. ReleaseSafe Metal smoke runs of the
  location puck, water shore, the animated-icon POI layer, the particle emitter
  (`layer.json`, `fireworks`) and particle features (`park-fireflies`,
  `waterway-flow`) register, add their layers and run to `--exit-after` with no
  native diagnostics. In the animated-icon weather demo a scripted click and a
  scripted hover hit station 14 through the plugin's hit test and start its
  play-once (`play-once.layer.json` for the hover).
- The paint package's binder probe (`packages/paint/fixtures/binder/probe.cpp`),
  rebuilt against this install's `mbgl-core`, reproduces the committed
  `expected.json` exactly, so #4685's evaluation rewrite leaves the encoded
  vertex and uniform values the JS twins mirror unchanged.

The smoke runs check logs, queries and exit status, not pixels: screen capture
returned black frames in this environment. OpenGL and Vulkan were not run.

## Validation of `0006`, 2026-10-18

The six exported patches pass `scripts/sync-ffi`, which is then a no-op, and
`mise run ffi:build` re-patches maplibre-native from the patch files and builds
the macOS ARM64 Metal FFI. The FFI's C API tests pass. The vendored header is
refreshed from that install.

In the same out-of-tree harness as below, 61 of 63 Native plugin tests pass,
including the four new and changed ones. The two failures are the static-texture
byte counts described below, unchanged. Replacing the per-feature evaluation
with the tile value makes the new layout and rendering tests fail. OpenGL and
Vulkan were not run. The plugin libraries and the native viewer were not rebuilt
against the new header, which `0001` makes ABI-incompatible.

## Validation, 2026-10-18

The five exported patches replay cleanly through `scripts/sync-ffi force`, the
next sync is a no-op, and a second export is byte-identical. The macOS ARM64
Metal FFI build and C API tests pass.

Native's `test/plugin` suites and the fill-extrusion geometry tests do not build
in the FFI's core-only configuration. They were built out of tree against the
FFI's `mbgl-core` and platform objects, with Native's headless frontend and
googletest `b514bdc8`. 58 of 60 tests pass. The two failures,
`StaticTexturesUploadOncePerRenderer` and
`StaticTexturesUploadAgainForALaterRenderer`, count 36 uploaded texture bytes
where they expect 32. The previous stack fails them identically in the same
harness, so the extra 4 bytes predate this rebase. The fill-extrusion render
tests, OpenGL and Vulkan were not run, and the plugin libraries were not rebuilt
against the new ABI.

## Patch audit, 2026-10-16

The FFI update includes
[#818](https://github.com/maplibre/maplibre-native-ffi/pull/818), which retires
its Windows file URL, custom geometry query, frame statistics and locale error
patches after their Native merges. It also replaces its combined render-update
publication patch with the remaining source/image, tile-selection and built-in
location-indicator bearing-accuracy changes. Those are FFI-owned patches; none
replaces one of our four plugin extensions.

Native's unpatched `include/mln/plugin/plugin_api.h` is byte-for-byte unchanged
between the old and new pins. It still lacks `build_frame`, DOUBLE2 coordinates,
ROTATION values, frame query envelopes and static textures. All four local
patches remain required. Their Native diffs are unchanged; only their FFI
integration context and inner filenames were refreshed. Native patch numbers
move from `0040`-`0043` to `0042`-`0045` because FFI now uses `0040` and `0041`.
The outer patch numbers (`0001`-`0004`) stay the same.

For our location indicator, `0001` supplies per-frame geometry, camera and
geographic helpers, and double-precision position paint; `0002` interpolates
`bearing` across north on the shortest arc; `0003` exposes the generated puck
and arrow envelopes to rendered-feature queries. It does not use `0004`, which
supplies animated-icon's catalog textures. FFI's bearing-accuracy patches
(`0021` and `0041`) extend Native's built-in location-indicator layer, a
separate implementation from our `location-puck` plugin.

OpenGL large uniform blocks (`0034`) and attribute-name matching (`0035`) remain
FFI-owned. The puck needs attribute-name matching for its OpenGL vertex inputs;
its lack of a large uniform block means it does not need the 8 KiB allocator
fix. The previous retirement of those local copies still stands.

## Validation, 2026-10-16

All four exported patches replay cleanly through `scripts/sync-ffi force`, and
the next sync is a no-op. The macOS ARM64 Metal FFI build and C API tests pass.
Refreshing the vendored header from that install produces no byte changes. All
JS and native plugin tests/builds, repository format/lint checks and the full
catalog rebake check pass.

The location-indicator render test passes all eight Metal fixture cameras,
including pixel checks and rendered-feature hit/miss queries. The native viewer
unit tests pass against the refreshed FFI install. OpenGL and Vulkan were not
run locally.

## Patch audit, 2026-10-12

Two local patches have been retired because upstream FFI now carries them:

| Previous local patch                             | Replacement in upstream FFI               | Native status                                                        |
| ------------------------------------------------ | ----------------------------------------- | -------------------------------------------------------------------- |
| `0004` OpenGL uniform blocks of 8 KiB and larger | `0034-opengl-large-uniform-blocks.patch`  | [#4707](https://github.com/maplibre/maplibre-native/pull/4707), open |
| `0006` plugin OpenGL attributes by name          | `0035-plugin-gl-attributes-by-name.patch` | [#4708](https://github.com/maplibre/maplibre-native/pull/4708), open |

The allocator alignment and dedicated-buffer update fixes match our former
patch. The FFI's attribute fix matches reflected attributes by name and includes
regressions for reordered locations and uniform/feature-driven paint bindings.
These fixes are still required; retirement transfers their maintenance to the
FFI rather than relying on a Native merge. The former static-texture patch
`0005` is now `0004`. Remaining Native patches use `0040`–`0043` to avoid the
FFI's existing patch numbers. Only static-texture test include context needed
rebasing; the other three Native diffs apply unchanged.

The new Native pin includes
[#4721](https://github.com/maplibre/maplibre-native/pull/4721), which
reevaluates plugin camera paint on zoom changes. It also includes the
location-indicator color-transition fix and Lab/HCL interpolation expressions.
Source-free callbacks, DOUBLE2 coordinates, rotation values, frame query
envelopes and static data textures remain absent from upstream Native's C plugin
API, so none of the four remaining patches can be retired.

Native `main` was also checked at
[`3749417d220bd2a8daa791992045b6bfc6085ecd`](https://github.com/maplibre/maplibre-native/commit/3749417d220bd2a8daa791992045b6bfc6085ecd).
There are four commits beyond the FFI's Native pin, with no C plugin API or
plugin renderer changes. The only core fix is
[#4718](https://github.com/maplibre/maplibre-native/pull/4718), which makes
custom geometry queries safe before data arrives; FFI already carries it as
`0031`. The other commits concern CI and the iOS header/build setup. No
additional Native pin override is needed for these plugins.

Relevant open work to watch:

- [#4685](https://github.com/maplibre/maplibre-native/pull/4685) extends the C
  API for a Vulkan fill-extrusion plugin: ordered passes, 3D/light/matrix
  inputs, layer evaluation, layout/image properties, atlas access and
  instancing. Vulkan instancing and the extra uniform inputs could address
  particle limits, but do not replace our source-free or static-texture
  contracts. Its BOOLEAN and IMAGE value IDs (5 and 6) collide with our DOUBLE2
  and ROTATION IDs, and its descriptors change, so adopting it requires an
  explicit ABI migration.
- [#4715](https://github.com/maplibre/maplibre-native/pull/4715) adds a
  plugin-enabled iOS XCFramework and an Objective-C wrapper for plugin layers.
  It concerns SDK distribution rather than our FFI host or carried extensions.
- [#4382](https://github.com/maplibre/maplibre-native/pull/4382) proposes a
  separate C++ plugin system; it does not replace this repo's C ABI.
- [#4706](https://github.com/maplibre/maplibre-native/pull/4706) fixes stale
  shared OpenGL index-buffer bindings;
  [#4627](https://github.com/maplibre/maplibre-native/pull/4627) changes 2D
  depth handling and Metal stencil caching. Watch these for rendering artifacts;
  neither retires a local plugin extension.

## Validation, 2026-10-12

The four exported patches reapply cleanly through `scripts/sync-ffi force`, and
another sync is a no-op. The macOS ARM64 Metal FFI build and C API tests pass,
as do all native plugin tests/builds, the viewer build/tests, and repository
format/lint checks. The refreshed installed plugin header changes only a
comment; its ABI layout is unchanged.

Location-indicator, animated-icon weather stations and particle-emitter pass
short Metal viewer smoke runs in `ReleaseSafe`. The default Debug viewer hits a
Zig 0.16 macOS stack-unwinder panic while the debug allocator captures a trace
on the runtime thread, before map creation. The sampled stack points to
`debug.SelfInfo.MachO.unwindFrameInner`; ReleaseSafe disables allocator stack
capture and avoids the failure. (This is
[ziglang/zig#37310](https://codeberg.org/ziglang/zig/issues/37310); the viewer
avoids it in Debug since 2026-10-18, see "Debug viewer, Vulkan and OpenGL".)
OpenGL and Vulkan were not run locally.

To change a patch: edit and commit inside `third_party/maplibre-native-ffi` (one
commit per patch), then run `scripts/sync-ffi export`. To move the pin: check
out the new upstream commit in the submodule, stage that submodule pointer, and
re-run `scripts/sync-ffi`. After pulling changes to these patches, run `mise run
ffi:build`: it re-applies them when they change, also under the same pin.
