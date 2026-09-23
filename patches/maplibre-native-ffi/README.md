# maplibre-native-ffi patches

`scripts/sync-ffi` applies these to `third_party/maplibre-native-ffi` on top of
the pinned upstream commit, as commits (`git am`). Each patch is one focused
change intended for its own upstream PR; drop a patch once the pin moves past
it. All five currently carry a MapLibre Native patch from
[maplibre-native-ffi#731](https://github.com/maplibre/maplibre-native-ffi/pull/731)
into the FFI's `patches/maplibre-native/` and its `sync-submodules` list.

| Patch                                            | Upstream                                                                                                                                           |
| ------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| `0001` plugin animated layers (`should_animate`) | [maplibre-native#4654](https://github.com/maplibre/maplibre-native/pull/4654), open                                                                |
| `0002` source-free plugin layers (`build_frame`) | not yet proposed                                                                                                                                   |
| `0003` premultiplied plugin default colors       | [maplibre-native#4663](https://github.com/maplibre/maplibre-native/pull/4663), merged 2026-09-21; drops when the FFI bumps its maplibre-native pin |
| `0004` plugin rotation properties                | not yet proposed                                                                                                                                   |
| `0005` plugin frame queries (hit envelopes)      | not yet proposed                                                                                                                                   |

Only the core patches are carried; the plugins do not need the PR's C API loader
because the viewer loads plugin libraries itself.

To change a patch: edit and commit inside `third_party/maplibre-native-ffi` (one
commit per patch), then run `scripts/sync-ffi export`. To move the pin: check
out the new upstream commit in the submodule, commit the submodule pointer, and
re-run `scripts/sync-ffi`.
