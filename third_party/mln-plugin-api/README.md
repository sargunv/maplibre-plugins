# MapLibre Native plugin ABI header

`mln/plugin/plugin_api.h` is the C plugin ABI that native plugins in this repo
compile against. It is copied from the patched MapLibre Native tree that
[maplibre-native-ffi](https://github.com/maplibre/maplibre-native-ffi) builds.

Source: FFI `4da98bb271d6b6aa8e1516a023abf9c2fc546256`, Native
`254d0a872407c15e9ea4211691af0abeb7e18f16`, plus the four patches in
[`patches/maplibre-native-ffi/`](../../patches/maplibre-native-ffi/README.md)
(Native patch numbers `0042`–`0045`). Animation, default-color premultiplication,
stencil overlap deduplication, near-clipped tile matrices, per-drawable
depth/stencil/culling and camera-paint reevaluation on zoom changes are upstream.
OpenGL large uniform blocks and attribute-name matching are carried by the FFI.

Vendoring the header means a plugin builds and unit-tests with no native
library present; only the apps that load a plugin into a map need a real
maplibre-native-c install. Refresh the copy with
`mise run sync-plugin-header` after `mise run ffi:build` whenever the FFI pin
or patches change. Rebuild every plugin library when the header changes.
