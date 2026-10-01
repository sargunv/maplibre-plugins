# maplibre-native-ffi patches

`scripts/sync-ffi` applies these to `third_party/maplibre-native-ffi` on top of
the pinned upstream commit, as commits (`git am`). Each patch carries a focused
MapLibre Native change into the FFI's `patches/maplibre-native/` and its
`sync-submodules` list. Drop a patch when the Native pin includes its change.

The FFI pin is `f46ed3e464821c388335c40c849687cb5cc804d6`, with Native pinned to
`d695deef12fc64ee075a892c2d913c45fe8c7b42`.

Native `main` additionally includes
[per-drawable depth, stencil and culling (#4692)](https://github.com/maplibre/maplibre-native/pull/4692),
merged 2026-09-29 as `302960b`. That API is beyond the FFI's Native pin and
replaces none of this repo's carried extensions.

| Patch                                            | Native patch | Upstream / purpose                                                                                                                 |
| ------------------------------------------------ | ------------ | ---------------------------------------------------------------------------------------------------------------------------------- |
| `0001` plugin animated layers (`should_animate`) | `0027`       | [Native #4654](https://github.com/maplibre/maplibre-native/pull/4654), merged 2026-09-24 as `3db2ced`; still beyond the Native pin |
| `0002` source-free plugin layers (`build_frame`) | `0028`       | not yet proposed                                                                                                                   |
| `0003` plugin rotation properties                | `0029`       | not yet proposed                                                                                                                   |
| `0004` plugin frame queries (hit envelopes)      | `0030`       | not yet proposed                                                                                                                   |
| `0005` OpenGL uniform blocks of 8 KiB and larger | `0031`       | fixes an upstream crash; needed by large `animated-icon` catalogs                                                                  |
| `0006` plugin static textures (RGBA32F)          | `0032`       | needed by `animated-icon`                                                                                                          |
| `0007` plugin OpenGL attributes by name          | `0033`       | fixes data-driven plugin attributes; needed by `animated-icon` and `particle-features`                                             |

The animation backport matches the merged upstream change, including its field
order after `enable_stencil_overlap_dedup` and `enable_near_clipped_matrix`. The
plugins leave both flags off to retain their tile rendering behavior. Rebuild
plugin libraries against the refreshed vendored header: the descriptor layout
has changed.

To change a patch: edit and commit inside `third_party/maplibre-native-ffi` (one
commit per patch), then run `scripts/sync-ffi export`. To move the pin: check
out the new upstream commit in the submodule, stage that submodule pointer, and
re-run `scripts/sync-ffi`. After pulling changes to these patches, run `mise run
ffi:build`: it re-applies them when they change, also under the same pin.
