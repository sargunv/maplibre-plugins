# maplibre-native-ffi patches

`scripts/sync-ffi` applies these to `third_party/maplibre-native-ffi` on top of
the pinned upstream commit, as commits (`git am`). Each patch is one focused
change intended for its own upstream PR; drop a patch once the pin moves past
it. Each one carries a MapLibre Native patch into the FFI's
`patches/maplibre-native/` and its `sync-submodules` list: `0001` to `0005` from
[maplibre-native-ffi#731](https://github.com/maplibre/maplibre-native-ffi/pull/731),
`0006` a fix for an upstream OpenGL crash, `0007` static data textures for
plugin shaders, and `0008` a fix for plugin vertex attributes on OpenGL.

| Patch                                            | Upstream                                                                                                                                           |
| ------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| `0001` plugin animated layers (`should_animate`) | [maplibre-native#4654](https://github.com/maplibre/maplibre-native/pull/4654), open                                                                |
| `0002` source-free plugin layers (`build_frame`) | not yet proposed                                                                                                                                   |
| `0003` premultiplied plugin default colors       | [maplibre-native#4663](https://github.com/maplibre/maplibre-native/pull/4663), merged 2026-09-21; drops when the FFI bumps its maplibre-native pin |
| `0004` plugin rotation properties                | not yet proposed                                                                                                                                   |
| `0005` plugin frame queries (hit envelopes)      | not yet proposed                                                                                                                                   |
| `0006` OpenGL uniform blocks of 8 KiB and larger | not yet proposed; fixes an upstream crash; needed by `animated-icon`                                                                               |
| `0007` plugin static textures (RGBA32F)          | not yet proposed; needed by `animated-icon`                                                                                                        |
| `0008` plugin OpenGL attributes by name          | not yet proposed; fixes data-driven plugin attributes on OpenGL; needed by `animated-icon`                                                         |

Only the core patches are carried; the plugins do not need the PR's C API loader
because the viewer loads plugin libraries itself.

To change a patch: edit and commit inside `third_party/maplibre-native-ffi` (one
commit per patch), then run `scripts/sync-ffi export`. To move the pin: check
out the new upstream commit in the submodule, commit the submodule pointer, and
re-run `scripts/sync-ffi`. After pulling changes to these patches, run
`scripts/sync-ffi` (or `mise run ffi:build`) again: it re-applies them when they
changed, also under the same pin.
