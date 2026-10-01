# MapLibre Native plugin ABI header

`mln/plugin/plugin_api.h` is the C plugin ABI that native plugins in this repo
compile against. It is copied from the patched MapLibre Native tree that
[maplibre-native-ffi](https://github.com/maplibre/maplibre-native-ffi) builds.

Source: FFI `19a00da6e0e410f6b345b3e6dfa46d8934be78d9`, Native
`b2c5c0aff4d645c04cd37cdde33fc992d955f06b`, plus the six patches in
[`patches/maplibre-native-ffi/`](../../patches/maplibre-native-ffi/README.md)
(Native patch numbers `0030`–`0035`). Animation, default-color premultiplication,
stencil overlap deduplication, near-clipped tile matrices and per-drawable
depth/stencil/culling are upstream.

Vendoring the header means a plugin builds and unit-tests with no native
library present; only the apps that load a plugin into a map need a real
maplibre-native-c install. Refresh the copy with
`mise run sync-plugin-header` after `mise run ffi:build` whenever the FFI pin
or patches change. Rebuild every plugin library when the header changes.
