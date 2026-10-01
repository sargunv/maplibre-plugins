# MapLibre Native plugin ABI header

`mln/plugin/plugin_api.h` is the C plugin ABI that native plugins in this repo
compile against. It is copied from the patched MapLibre Native tree that
[maplibre-native-ffi](https://github.com/maplibre/maplibre-native-ffi) builds.

Source: FFI `f46ed3e464821c388335c40c849687cb5cc804d6`, Native
`d695deef12fc64ee075a892c2d913c45fe8c7b42`, plus the seven patches in
[`patches/maplibre-native-ffi/`](../../patches/maplibre-native-ffi/README.md)
(Native patch numbers `0027`–`0033`). Default-color premultiplication, stencil
overlap deduplication and near-clipped tile matrices are upstream. Animation
is a backport of merged Native #4654; the other extensions remain carried here.

Vendoring the header means a plugin builds and unit-tests with no native
library present; only the apps that load a plugin into a map need a real
maplibre-native-c install. Refresh the copy with
`mise run sync-plugin-header` after `mise run ffi:build` whenever the FFI pin
or patches change. Rebuild every plugin library when the header changes.
