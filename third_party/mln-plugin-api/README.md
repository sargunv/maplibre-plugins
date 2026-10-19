# MapLibre Native plugin ABI header

`mln/plugin/plugin_api.h` is the C plugin ABI that native plugins in this repo
compile against. It is copied from the patched MapLibre Native tree that
[maplibre-native-ffi](https://github.com/maplibre/maplibre-native-ffi) builds.

Source: FFI `44d24a1cfd9cb1b1b25a8c36e8e2472f0e392e18`, Native
`254d0a872407c15e9ea4211691af0abeb7e18f16`, plus the six patches in
[`patches/maplibre-native-ffi/`](../../patches/maplibre-native-ffi/README.md)
(Native patch numbers `0042`–`0047`): the draft
[maplibre-native#4685](https://github.com/maplibre/maplibre-native/pull/4685)
(draw passes, 3D and light inputs, layout, boolean and image properties,
instancing), source-free layers, rotation properties, frame queries, static
textures and per-feature layout properties. Animation, default-color
premultiplication, near-clipped tile matrices, per-drawable depth/stencil/culling
and camera-paint reevaluation on zoom changes are upstream. OpenGL large uniform
blocks and attribute-name matching are carried by the FFI.

#4685 changes the ABI (value type numbers, removed and inserted layer-type
fields, larger structs), so plugin libraries built against an older copy of this
header are rejected at registration.

Vendoring the header means a plugin builds and unit-tests with no native
library present; only the apps that load a plugin into a map need a real
maplibre-native-c install. Refresh the copy with
`mise run sync-plugin-header` after `mise run ffi:build` whenever the FFI pin
or patches change. Rebuild every plugin library when the header changes.
