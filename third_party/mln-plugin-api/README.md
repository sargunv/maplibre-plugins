# MapLibre Native plugin ABI header

`mln/plugin/plugin_api.h` is the C plugin ABI that native plugins in this repo
compile against. It is copied from the patched MapLibre Native tree that
[maplibre-native-ffi](https://github.com/maplibre/maplibre-native-ffi) builds,
because the source-free layer, animation, rotation, frame-query, static texture,
and OpenGL attributes-by-name extensions the plugins rely on are still carried
as FFI patches (`0022`–`0029`) rather than upstream releases.

Source: the patched `third_party/maplibre-native-ffi` build (upstream `main`
plus `patches/maplibre-native-ffi/`), whose first plugin patches come from
[PR #731](https://github.com/maplibre/maplibre-native-ffi/pull/731); the texture
and attribute patches (`0028`, `0029`) are this repo's own.

Vendoring the header means a plugin builds and unit-tests with no native
library present; only the apps that load a plugin into a map need a real
maplibre-native-c install. Refresh the copy with
`mise run sync-plugin-header` after `mise run ffi:build` whenever the FFI pin
or patches change.
