# Location indicator

A `location-puck` layer: a procedural device location indicator (puck, border,
bearing arrow, bearing-accuracy sector, accuracy circle, shadow, and pulse ring)
at one geographic position. Every shape is drawn analytically in the fragment
shader, so the layer needs no sprite images and stays crisp at any pixel ratio.

The layer takes its position from a paint property and needs no style source.
The native plugin renders on OpenGL, Vulkan, and Metal; the JS layer renders on
WebGL 2 under mercator and globe projections.

## Driving the indicator

Set `position` to `[latitude, longitude]`, `bearing` to the heading in degrees
clockwise from north, and `accuracy-radius` to the horizontal accuracy in
meters. Set `bearing-visible` to 1 when the caller has a heading; the default 0
hides the arrow and the bearing-accuracy sector.

```json
{
  "id": "puck",
  "type": "location-puck",
  "paint": {
    "position": [37.7749, -122.4194],
    "bearing": 35,
    "accuracy-radius": 80,
    "bearing-visible": 1
  }
}
```

Sizes are logical pixels at the indicator, scaled by `perspective-compensation`
so the puck keeps its size as the map pitches away. `tilt-displacement` lifts
the puck and arrow up-screen and pushes the shadow down-screen under pitch; the
accuracy circle and sector stay on the ground.

Property changes animate over the transition duration (300 ms by default).
Bearings take the shortest arc, so 350 to 10 degrees animates through north. Use
continuous longitudes when animating across the antimeridian.

The full property table, with types, defaults, and bounds, is
[spec.json](spec.json). Sizes are logical pixels unless noted; a zero radius
hides its component. Components composite bottom to top: accuracy circle,
bearing-accuracy sector, shadow, pulse ring, bearing arrow, puck.

## Native

```bash
mise run //plugins/location-indicator/native:build   # zig-out/lib/libmaplibre-location-puck.*
mise run //plugins/location-indicator/native:test
```

Load the library with the FFI's plugin loader (`mln_plugin_load_library` or a
binding's `loadPlugin`) using the entry point `mln_location_puck_register`,
before loading a style that uses `location-puck`. Then add the layer JSON above
with the ordinary add-layer call. Rendered-feature queries return a GeoJSON
Point for hits on the arrow or puck envelopes.

The plugin builds against the plugin ABI header alone and has no link dependency
on the host.

### Required native patches

From `patches/maplibre-native-ffi/` this plugin needs every carried patch:

| Patch                                      | Used for                                                     |
| ------------------------------------------ | ------------------------------------------------------------ |
| `0001` plugin animated layers              | `should_animate` drives the pulse ring                       |
| `0002` source-free plugin layers           | `build_frame` supplies the geometry; the layer has no source |
| `0003` premultiplied plugin default colors | color defaults and values arrive premultiplied               |
| `0004` plugin rotation properties          | `bearing` transitions along the shortest arc                 |
| `0005` plugin frame queries                | rendered-feature hit envelopes for the puck and arrow        |

## Web

```ts
import { LocationPuckLayer } from "@maplibre-plugins/location-indicator";

const puck = LocationPuckLayer.fromLayerJson(layerJson); // the JSON above
map.addLayer(puck);
puck.setPaintProperty("position", [lat, lon]);
puck.setPaint({ bearing: 90, "bearing-visible": 1 }, { duration: 500 });
puck.queryFeature(point); // GeoJSON Feature or null
```

Paint values accept literals, CSS color strings, or zoom expressions, the same
inputs a style would give the native plugin.

## Development

Both implementations are tested against `spec.json` and share
`shaders/puck.glsl`. Preview the web layer with `mise run web`, and the native
one with `mise run //apps/native-viewer:run location-indicator`, which
re-applies `examples/layer.json` whenever you save it.
