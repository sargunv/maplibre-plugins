> **Vibe-coded. Not fit for use.** Everything in this repository was written by
> an AI coding agent as an experiment in what MapLibre Native's plugin API can
> and cannot do. It is unreviewed, untested beyond its own unit tests, depends
> on unmerged MapLibre Native patches, and may break, mislead, or disappear at
> any time. Do not build on it.

Layer plugins for MapLibre, each implemented twice from one shared spec:

- **Native**: a Zig shared library for MapLibre Native's C plugin ABI, loaded
  through [maplibre-native-ffi](https://github.com/maplibre/maplibre-native-ffi)
  with `mln_plugin_load_library`.
- **Web**: a TypeScript custom layer for maplibre-gl-js.

| Plugin                                           | Layer type      | Status                                 |
| ------------------------------------------------ | --------------- | -------------------------------------- |
| [location-indicator](plugins/location-indicator) | `location-puck` | native + web; needs FFI plugin patches |
| [water](plugins/water)                           | `water-shore`   | native + web; needs FFI plugin patches |
| [animated-icon](plugins/animated-icon)           | `animated-icon` | native + web; needs FFI plugin patches |

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
mise run //apps/native-viewer:run animated-icon -- --center 37.788,-122.4075 --zoom 16
mise run //apps/native-viewer:weather
```

The last one opens the animated-icon weather demo: 240 synthetic weather
stations drawn from an app-supplied catalog of Meteocons animations. Its icons
loop out of sync. Add `-- --layer
../../plugins/animated-icon/examples/weather/play-once.layer.json` to rest every
icon until you hover it, which plays it once (a click replays it). The gallery's
"Weather stations" page shows the same stations on the web.

See [AGENTS.md](AGENTS.md) for the repo layout and conventions.

## License

BSD 2-Clause; see [LICENSE](LICENSE). Third-party animations keep their own
licenses, listed in
[`plugins/animated-icon/animations/LICENSES.md`](plugins/animated-icon/animations/LICENSES.md).
The weather demo's stations come from Natural Earth, which is public domain;
their weather is made up.
