# Binder fixtures

These fixtures check the data-driven binder in `../../src/value.ts` against
MapLibre Native itself. `../../src/binder.test.ts` runs every case.

- `cases.json` is written by hand. Each case compiles `value` for `property`,
  which is a property in the shape of a plugin's `spec.json`. The case then:
  - evaluates the value at each `evaluations` entry, with the entry's feature
    and feature state when it has them, and always without a feature;
  - reads the interpolation factor at each `factors` entry;
  - runs each `transitions` script. A script starts from `initial`, then each
    step either sets a value at `now` ms (with `duration` and `delay`) or
    samples at `now` and `zoom`.
- `expected.json` is generated from `cases.json` by `probe.cpp`, and is never
  edited by hand. The probe passes each case through the host's own code:
  - `convertPluginPropertyValue` and both `PluginPropertyValue::evaluate`
    overloads;
  - `interpolationFactor`, `isDataDriven`, `isZoomConstant` and
    `usesFeatureState`;
  - `PluginTransitioningPropertyValue`;
  - `PluginPaintPropertyBinder`, for the encoded vertex floats and uniforms
    (including enum indices).

  Numbers are the host's f32 or f64 values. Non-finite numbers are the strings
  `NaN`, `Infinity` and `-Infinity`.

## Regenerating `expected.json`

Regenerate it after changing `cases.json`.

The FFI builds MapLibre Native's core without its test targets, so the probe is
built by hand as a googletest program against an FFI build's static libraries.
Any host build that carries `patches/maplibre-native-ffi/` works: the binder
code paths do not depend on the texture or attribute patches. The committed file
came from an ANGLE (EGL) build.

1. **Compile** `probe.cpp`, `gtest-all.cc` and `gtest_main.cc`, using the flags
   that the FFI build's `compile_commands.json` records for
   `src/mln/renderer/layers/plugin_layer_tweaker.cpp`. Add the include
   directories `test/include`, `test/src` and `platform/default/include` of
   `third_party/maplibre-native-ffi/third_party/maplibre-native`, plus
   googletest's.
2. **Link** these libraries from the build:
   - `libmbgl-core.a` and the vendored libraries (nunicode, sqlite, parsedate,
     mlt-cpp, fastpfor, csscolorparser, harfbuzz, freetype);
   - the objects in `CMakeFiles/maplibre_native_c_objects.dir`;
   - the backend's libraries (for ANGLE, `-lEGL -lGLESv2`).
3. **Run** the program:

   ```sh
   BINDER_CASES=cases.json BINDER_EXPECTED=expected.json ./binder-probe
   ```

   Then run `pnpm exec dprint fmt` on `expected.json`.
