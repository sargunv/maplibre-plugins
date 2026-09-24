# maplibre-plugins

A monorepo of MapLibre layer plugins. Each plugin has a shared spec, a native
implementation for MapLibre Native's C plugin ABI (loaded through
[maplibre-native-ffi](https://github.com/maplibre/maplibre-native-ffi)), and a
maplibre-gl-js implementation, plus apps to preview them live.

## Project map

- `plugins/<name>/` — one plugin.
  - `spec.json` — the shared contract: layer type, paint properties, defaults.
    Both implementations are tested against it.
  - `shaders/*.glsl` — shader code shared by both implementations. The Zig build
    reads it directly; `scripts/sync-shaders.mjs` mirrors it into
    `js/src/generated/`.
  - `examples/layer.json` — a style-layer JSON that the gallery and the native
    viewer both load.
  - `native/` — Zig plugin built as a shared library (`zig build`), unit tests
    (`zig build test`). Builds against `third_party/mln-plugin-api` alone, so it
    needs no native library.
  - `js/` — TypeScript package implementing a maplibre-gl-js custom layer with
    the same paint properties.
  - Source-free plugins (the puck) build their geometry every frame; tile-driven
    plugins (water) get the source's features per tile through the layout
    callbacks, and the JS twin reads the same tiles from the map's tile manager.
- `packages/paint/` — `@maplibre-plugins/paint`: paint evaluation and
  MapLibre-style transitions shared by every JS plugin layer.
- `apps/web/` — Vite gallery: the JS plugins on a live map with spec-driven
  controls (`apps/web/src/controls.ts`). `mise run web`.
- `apps/native-viewer/` — windowed Zig viewer (SDL3) that loads a native plugin
  into maplibre-native-c and shows its example layer on a live map, re-applying
  the layer JSON whenever the file changes.
- `third_party/maplibre-native-ffi/` — git submodule pinned to upstream `main`;
  `scripts/sync-ffi` applies `patches/maplibre-native-ffi/` on top.
- `third_party/mln-plugin-api/` — vendored plugin ABI header so plugins build
  and unit-test without the FFI build (see its README).
- `patches/maplibre-native-ffi/` — upstream-staged changes carried here until
  they land (currently the plugin ABI patches from FFI PR #731).
- `scripts/` — repo maintenance scripts (`sync-ffi`, `sync-shaders.mjs`).

## Dev tool commands

```bash
mise install            # toolchain (hk, dprint, node, pnpm, zig); pnpm installs on first task
mise run check          # formatters + linters (dprint, vp check) in check mode
mise run fix            # same, applying fixes
mise run test           # JS unit tests + every native plugin's Zig tests
mise run build          # JS packages + gallery + native plugin libraries
mise run web            # gallery dev server with live reload (http://localhost:5173)
mise run ffi:build      # sync + patch + build maplibre-native-ffi for this host (slow once)
mise run native-info    # which maplibre-native-c install the native apps use
mise run //apps/native-viewer:run location-indicator     # windowed live viewer
mise run //apps/native-viewer:run water -- --before landcover-ice-shelf --zoom 15
mise run //plugins/location-indicator/native:test
mise tasks ls --all     # everything
```

The native viewer needs a maplibre-native-c install (headers, library, and
`share/maplibre-native-c/artifact.json`). `mise run ffi:build` produces one from
the patched submodule at `third_party/maplibre-native-ffi/build/<host
preset>/install`; override with `MLN_FFI_DIR` (another checkout) or
`MLN_NATIVE_INSTALL_DIR`, for example in a gitignored `mise.local.toml`. The
plugin layers only work against a build that carries the patches in
`patches/maplibre-native-ffi/`; an unpatched FFI release does not have the
source-free plugin layer ABI yet.

Moving the FFI pin: check out the new upstream commit in the submodule, commit
the submodule pointer, run `scripts/sync-ffi` (which re-applies the patches),
fix any conflicts by editing and committing inside the submodule, then
`scripts/sync-ffi export`. Refresh `third_party/mln-plugin-api` with `mise run
sync-plugin-header` after `ffi:build`.

## Project invariants

- `spec.json` is the source of truth for a plugin's paint properties. Change it
  first; the Zig and JS spec-parity tests then tell you what to update.
- Shared shader code lives only in `plugins/<name>/shaders/`. Never edit
  `js/src/generated/`; run `node scripts/sync-shaders.mjs`.
- Each plugin README lists which of `patches/maplibre-native-ffi/` it requires
  and what for; update it when a plugin starts using a new host feature.
- Geometry builders come in twins (`native/src/layout.zig` and
  `js/src/layout.ts`) tested against the same fixtures; change both.
- Native plugins never link maplibre-native-c: the host passes the register
  function into the plugin's entry point.
- JS layers render premultiplied colors and keep the same component order,
  sizes, and transition behavior as the native plugin.
