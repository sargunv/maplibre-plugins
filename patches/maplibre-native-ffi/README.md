# maplibre-native-ffi patches

`scripts/sync-ffi` applies these to `third_party/maplibre-native-ffi` on top of
the pinned upstream commit, as commits (`git am`). Each patch carries a focused
MapLibre Native change into the FFI's `patches/maplibre-native/` and its
`sync-submodules` list. Drop a patch when the host includes its change.

The FFI pin is `4da98bb271d6b6aa8e1516a023abf9c2fc546256`, with Native pinned to
`254d0a872407c15e9ea4211691af0abeb7e18f16`.

| Patch                                            | Native patch | Purpose                                         |
| ------------------------------------------------ | ------------ | ----------------------------------------------- |
| `0001` source-free plugin layers (`build_frame`) | `0042`       | per-frame geometry without a style source       |
| `0002` plugin rotation properties                | `0043`       | shortest-arc rotation transitions               |
| `0003` plugin frame queries                      | `0044`       | hit envelopes for source-free rendered features |
| `0004` plugin static textures (RGBA32F)          | `0045`       | `animated-icon` catalog data                    |

Animation, default-color premultiplication, near-clipped tile matrices and
[per-drawable depth, stencil and culling](https://github.com/maplibre/maplibre-native/pull/4692)
are upstream. Tile-driven drawables explicitly select read-only depth to retain
their previous behavior; the new descriptor's zero depth mode disables depth
testing. The source-free path retains read-only depth and no stencil or culling.
Plugin libraries must be rebuilt against the refreshed vendored header.

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
capture and avoids the failure. OpenGL and Vulkan were not run locally.

To change a patch: edit and commit inside `third_party/maplibre-native-ffi` (one
commit per patch), then run `scripts/sync-ffi export`. To move the pin: check
out the new upstream commit in the submodule, stage that submodule pointer, and
re-run `scripts/sync-ffi`. After pulling changes to these patches, run `mise run
ffi:build`: it re-applies them when they change, also under the same pin.
