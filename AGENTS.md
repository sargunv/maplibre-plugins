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
    viewer both load. animated-icon also has `examples/weather/`: a synthetic
    weather-stations GeoJSON fixture and its layers, shared by the gallery's
    "Weather stations" page and the viewer's `weather` task.
  - `native/` — Zig plugin built as a shared library (`zig build`), unit tests
    (`zig build test`). Builds against `third_party/mln-plugin-api` alone, so it
    needs no native library.
  - `js/` — TypeScript package implementing a maplibre-gl-js custom layer with
    the same paint properties.
  - `fixtures/` — shared test fixtures that the Zig and TypeScript twins both
    load (animated-icon): `catalog/` (readers and timing), `layout/`, `place/`
    (placement and hit tests, with the generator that writes them), and
    `shaders/sections.glsl`, the shader text the native OpenGL and WebGL 2
    sources must share word for word.
  - `animations/`, `baker/`, `catalog/` (animated-icon only) — Lottie sources, a
    Node baker that compiles them, and the baked `.mlvc` catalogs. Every
    `animations/*.json` manifest with an `"output"` is baked by `mise run bake`:
    `catalog.json` into the demo catalog `catalog/demo.mlvc`, which the native
    plugin embeds and the JS package carries as `js/src/generated/catalog.ts`,
    and `weather.json` into `catalog/weather.mlvc` (plus its license notice), an
    app catalog that the weather demo loads at run time. `catalog/stamps.json`
    records the input and output hashes of every baked file, including
    `fixtures/catalog/`.
  - Source-free plugins (the puck) build their geometry every frame; tile-driven
    plugins (water, animated-icon) get the source's features per tile through
    the layout callbacks, and the JS twin reads the same tiles from the map's
    tile manager.
  - `plugins/particles/` registers two layer types from one library: the
    source-free `particle-emitter` and the tile-driven `particle-features`. Its
    `spec.json` has a canonical top-level `paint` table plus each type's list
    under `layerTypes`, and `fixtures/` holds the fixtures its Zig and
    TypeScript twins (layout, camera record, hash) are both tested against.
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
  they land: the plugin ABI patches from FFI PR #731 (`0001`–`0005`), an OpenGL
  uniform block fix (`0006`), static data textures for plugin shaders (`0007`),
  and plugin vertex attributes matched by name on OpenGL (`0008`).
- `scripts/` — repo maintenance scripts (`sync-ffi`, `sync-shaders.mjs`).

## Dev tool commands

```bash
mise install            # toolchain (hk, dprint, node, pnpm, zig); pnpm installs on first task
mise run check          # formatters + linters (dprint, vp check) in check mode
mise run fix            # same, applying fixes
mise run test           # JS unit tests + every native plugin's Zig tests
mise run build          # JS packages + gallery + native plugin libraries
mise run web            # gallery dev server with live reload (http://localhost:5173)
mise run bake           # re-bake stale animated-icon catalogs, the JS copy and fixtures
mise run bake:check     # full in-memory re-bake, fails on any byte difference (CI)
mise run ffi:build      # sync + patch + build maplibre-native-ffi for this host (slow once)
mise run native-info    # which maplibre-native-c install the native apps use
mise run //apps/native-viewer:run location-indicator     # windowed live viewer
mise run //apps/native-viewer:run water -- --before landcover-ice-shelf --zoom 15
mise run //apps/native-viewer:weather   # animated-icon weather stations (add --layer …/play-once.layer.json to hover-play)
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

After a pull that changes `patches/maplibre-native-ffi/`, run `mise run
ffi:build` again, even when the pin did not move. `scripts/sync-ffi` stamps what
it applied, re-applies the patches when they change, and makes the next FFI
build re-patch maplibre-native when its patches changed. It stops instead of
guessing when the submodule also has commits that `patches/` lacks:
`scripts/sync-ffi export` keeps them, `scripts/sync-ffi force` discards them. If
a build still lacks a patch, for example after the submodule's commits were
changed by hand, start over:

```bash
scripts/sync-ffi force
rm -f "$(git -C third_party/maplibre-native-ffi/third_party/maplibre-native rev-parse --git-dir)/mln-ffi-sync.stamp"
mise run ffi:build
```

## Project invariants

- `spec.json` is the source of truth for a plugin's paint properties. Change it
  first; the Zig and JS spec-parity tests then tell you what to update.
- Shared shader code lives only in `plugins/<name>/shaders/`. Never edit
  `js/src/generated/`; run `node scripts/sync-shaders.mjs`.
- Each plugin README lists which of `patches/maplibre-native-ffi/` it requires
  and what for; update it when a plugin starts using a new host feature.
- Geometry builders come in twins (`native/src/layout.zig` and
  `js/src/layout.ts`) tested against the same fixtures; change both. So do the
  animated-icon catalog readers (`catalog.zig` and `catalog.ts`, against
  `fixtures/catalog/`) and placement and hit tests (`place.zig` and `place.ts`,
  against `fixtures/place/`).
- animated-icon's shader sections (attributes, uniform blocks, varyings and the
  two `main`s) are pinned in `fixtures/shaders/sections.glsl`, which the Zig and
  JS tests match against the generated OpenGL and WebGL 2 sources. Changing one
  means changing `plugin.zig`, `js/src/shaders.ts` and that file together.
- Baked files are generated: never edit `catalog/*.mlvc`,
  `catalog/weather.mlvc.LICENSE.txt`, `catalog/stamps.json`,
  `js/src/generated/catalog.ts` or `fixtures/catalog/` by hand. Change
  `animations/` or `baker/` and run `mise run bake`; `mise run check` fails
  while they are stale, and CI's `mise run bake:check` re-bakes them in full.
- animated-icon's native `should_animate` returns whether `icon-animation` is
  set at all: the host evaluates it without a feature, so any other value,
  including a data-driven animation, speed or opacity, is not a safe reason to
  stop repainting.
- Native plugins never link maplibre-native-c: the host passes the register
  function into the plugin's entry point.
- JS layers render premultiplied colors and keep the same component order,
  sizes, and transition behavior as the native plugin.
