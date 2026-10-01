# maplibre-native-ffi patches

`scripts/sync-ffi` applies these to `third_party/maplibre-native-ffi` on top of
the pinned upstream commit, as commits (`git am`). Each patch carries a focused
MapLibre Native change into the FFI's `patches/maplibre-native/` and its
`sync-submodules` list. Drop a patch when the Native pin includes its change.

The FFI pin is `19a00da6e0e410f6b345b3e6dfa46d8934be78d9`, with Native pinned to
`b2c5c0aff4d645c04cd37cdde33fc992d955f06b`.

| Patch                                            | Native patch | Purpose                                                           |
| ------------------------------------------------ | ------------ | ----------------------------------------------------------------- |
| `0001` source-free plugin layers (`build_frame`) | `0030`       | per-frame geometry without a style source                         |
| `0002` plugin rotation properties                | `0031`       | shortest-arc rotation transitions                                 |
| `0003` plugin frame queries                      | `0032`       | hit envelopes for source-free rendered features                   |
| `0004` OpenGL uniform blocks of 8 KiB and larger | `0033`       | large `animated-icon` catalog headers                             |
| `0005` plugin static textures (RGBA32F)          | `0034`       | `animated-icon` catalog data                                      |
| `0006` plugin OpenGL attributes by name          | `0035`       | data-driven attributes in `animated-icon` and `particle-features` |

Animation, default-color premultiplication, near-clipped tile matrices and
[per-drawable depth, stencil and culling](https://github.com/maplibre/maplibre-native/pull/4692)
are upstream. Tile-driven drawables explicitly select read-only depth to retain
their previous behavior; the new descriptor's zero depth mode disables depth
testing. The source-free path retains read-only depth and no stencil or culling.
Plugin libraries must be rebuilt against the refreshed vendored header.

To change a patch: edit and commit inside `third_party/maplibre-native-ffi` (one
commit per patch), then run `scripts/sync-ffi export`. To move the pin: check
out the new upstream commit in the submodule, stage that submodule pointer, and
re-run `scripts/sync-ffi`. After pulling changes to these patches, run `mise run
ffi:build`: it re-applies them when they change, also under the same pin.
