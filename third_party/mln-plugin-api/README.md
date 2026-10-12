# MapLibre Native plugin ABI header

`mln/plugin/plugin_api.h` is the C plugin ABI that native plugins in this repo
compile against. It is copied from the patched MapLibre Native tree that
[maplibre-native-ffi](https://github.com/maplibre/maplibre-native-ffi) builds.

Source: FFI `6f5a662093873a5a690de34fe21f6329b58e77e3`, Native
`43e10605cd5b8b24d1cd411ce9544b70130fc040`, plus the four patches in
[`patches/maplibre-native-ffi/`](../../patches/maplibre-native-ffi/README.md)
(Native patch numbers `0040`–`0043`). Animation, default-color premultiplication,
stencil overlap deduplication, near-clipped tile matrices, per-drawable
depth/stencil/culling and camera-paint reevaluation on zoom changes are upstream.
OpenGL large uniform blocks and attribute-name matching are carried by the FFI.

Vendoring the header means a plugin builds and unit-tests with no native
library present; only the apps that load a plugin into a map need a real
maplibre-native-c install. Refresh the copy with
`mise run sync-plugin-header` after `mise run ffi:build` whenever the FFI pin
or patches change. Rebuild every plugin library when the header changes.
