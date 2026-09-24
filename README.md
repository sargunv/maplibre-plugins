# maplibre-plugins

Layer plugins for MapLibre, each implemented twice from one shared spec:

- **Native**: a Zig shared library for MapLibre Native's C plugin ABI, loaded
  through [maplibre-native-ffi](https://github.com/maplibre/maplibre-native-ffi)
  with `mln_plugin_load_library`.
- **Web**: a TypeScript custom layer for maplibre-gl-js.

| Plugin                                           | Layer type      | Status                                 |
| ------------------------------------------------ | --------------- | -------------------------------------- |
| [location-indicator](plugins/location-indicator) | `location-puck` | native + web; needs FFI plugin patches |
| [water](plugins/water)                           | `water-shore`   | native + web; needs FFI plugin patches |

## Try it

The web gallery is published to
[code.sargunv.dev/maplibre-plugins](https://code.sargunv.dev/maplibre-plugins/)
on every push to `main`.

```bash
mise install
mise run web        # JS gallery with live controls
mise run test       # unit tests for both implementations
```

The native side needs a maplibre-native-c build that carries the plugin ABI
patches, which this repo vendors: a maplibre-native-ffi submodule plus
`patches/maplibre-native-ffi/`. Build it once, then open the viewer and edit
`plugins/location-indicator/examples/layer.json` while it runs:

```bash
mise run ffi:build
mise run //apps/native-viewer:run location-indicator
mise run //apps/native-viewer:run water -- --before landcover-ice-shelf
```

See [AGENTS.md](AGENTS.md) for the repo layout and conventions.
