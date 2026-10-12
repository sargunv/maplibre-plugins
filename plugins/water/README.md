# Water

A `water-shore` layer: animated shoreline drawn from the water polygons a style
already loads. Along every coast, lake and island the layer paints a
shallow-water tint, breaking crests that roll in toward the shore, and a
bubbling wash right at the waterline. Everything is analytic in the fragment
shader, so it needs no textures and stays crisp at any pixel ratio.

The layer is tile-driven: point it at a vector source and the polygon layer
inside it (for OpenMapTiles styles, `openmaptiles` and `water`), optionally with
a filter. The native plugin renders on OpenGL, Vulkan, and Metal; the JS layer
renders on WebGL 2 under mercator and globe projections. Insert it right above
the style's water fill so roads and labels stay on top.

```json
{
  "id": "water-shore",
  "type": "water-shore",
  "source": "openmaptiles",
  "source-layer": "water",
  "filter": ["!=", ["get", "brunnel"], "tunnel"],
  "paint": {
    "shore-width": [
      "interpolate",
      ["exponential", 1.5],
      ["zoom"],
      10,
      6,
      13,
      24,
      16,
      64
    ],
    "wave-count": 3,
    "wave-speed": 0.3
  }
}
```

## How it works

Both implementations run the same layout over each tile's polygon rings: the
water lies on the left of every ring edge (Mapbox Vector Tile winding, for
exterior rings and holes alike), so each edge gets an inward normal and the ring
becomes a strip along the shoreline with a unit extrusion vector on its inner
vertices. Convex corners miter and reflex corners fan around the point. Rings
keep the tile's whole buffer, and the fragment shader owns each fragment by the
shoreline point it was extruded from, so bands reaching across a tile edge are
drawn exactly once, with no gaps and no doubling.

Each inner vertex also carries a reach: half the distance from its shoreline
point to the opposite bank of the same water feature, found by casting its
extrusion ray against the feature's other edges. The vertex shader clamps the
band to that reach, so the two sides of a river or inlet meet in the middle
instead of overlapping.

The vertex shader scales the extrusion to `shore-width` logical pixels; the
fragment shader draws the tint, crests and wash from the interpolated band
distance and a tile-periodic noise, so the pattern is seamless across tiles. The
animation clock is the plugin's own monotonic time: the map keeps repainting
while `wave-speed` is non-zero.

## Limits and future improvements

The band is an offset of the shoreline, not a partition of the water, so
wherever coastline features are shorter than the band width (piers, marinas,
jagged rock) adjacent strips overlap and the translucent tint doubles up into
streaks. The reach clamp removes the worst case (bands crossing a narrow
channel) but not overlap between neighbouring strips. The built-in layers face
the same choice: MapLibre's line layer has the identical artifact for wide
translucent lines, fills avoid it because their triangulation is a partition,
and heatmap sidesteps it with an offscreen pass. Three ways to finish the job,
and what each needs from the plugin API:

1. **Offscreen accumulation** (as heatmap does): render the band into a texture
   with max blending and composite once. Correct and cheap, but the plugin ABI
   gives layers no render targets or textures, so it is web-only today.
2. **Draw-once via depth or stencil** (as fill-extrusion opacity does with a
   depth pre-pass): each pixel keeps its first fragment. Native now exposes
   per-drawable stencil overlap suppression and depth writes. A stencil path
   needs to discard zero-coverage fragments and accept first-fragment shading
   where strips meet; enabling it alone can turn overlap streaks into gaps.
3. **A true inward offset of the water polygon** (a Clipper-style buffer or
   straight skeleton), which turns the band into a partition with an exact
   distance field. Needs nothing from the host; it is a substantial,
   robustness-sensitive algorithm to carry in both Zig and TypeScript.

Native's stencil control makes option 2 possible. Offscreen accumulation still
needs render targets and blending controls from the host.

### Upstream API work to watch

[Native #4685](https://github.com/maplibre/maplibre-native/pull/4685) proposes
ordered passes across all tiles in a layer, with depth/color writes, culling and
3D metadata. After API migration, this could make option 2 easier to test:
finish a layer-wide depth pre-pass before the color pass. The existing
first-fragment shading and transparent-coverage caveats still apply; ordered
passes alone do not solve overlapping shoreline geometry.

The proposal also adds evaluated style-light inputs for optional wave shading,
and IMAGE properties with Metal/Vulkan tile-atlas access for patterned water.
The implementation admits both backends even though the header comments say
Vulkan-only. These would require new properties and shader work in both plugin
implementations. Packed colors and reduced feature-state refills could also
reduce paint-buffer costs.

Offscreen accumulation still needs render targets and max blending, which the
proposal does not provide. It does not replace our carried extensions, and
adoption requires reconciling its descriptors/render passes with the current
host ABI and rebuilding the plugin. None of these changes is implemented here.

## Paint properties

The full property table, with types, defaults, and bounds, is
[spec.json](spec.json). `shore-width` is in logical pixels, so a zoom expression
like the one above keeps the band proportionate to the coastline detail at each
zoom. `wave-speed` is crests per second toward the shore; negative values send
them out to sea and `0` freezes the picture. `wave-wobble` bends and breaks the
crests, `foam-length` sets how far foam trails behind each one, and
`wash-strength` sets the bubbling strip at the waterline. Property changes
animate over the transition duration.

## Native

```bash
mise run //plugins/water/native:build   # zig-out/lib/libmaplibre-water.*
mise run //plugins/water/native:test
```

Load the library with the entry point `mln_water_register` before loading a
style that uses `water-shore`, then add the layer JSON above with the ordinary
add-layer call. Rendered-feature queries hit the water polygons themselves.

The plugin builds against the plugin ABI header alone and has no link dependency
on the host.

### Native host

Tile layout, animation and default-color premultiplication are upstream Native
features. Build against the plugin ABI header of the host that loads the
library, as the native viewer does.

## Web

```ts
import { WaterShoreLayer } from "@maplibre-plugins/water";

const shore = WaterShoreLayer.fromLayerJson(layerJson); // the JSON above
map.addLayer(shore, "landcover-ice-shelf"); // right above the water fill
shore.setPaintProperty("wave-count", 5);
shore.setPaint({ "wave-speed": 0.6 }, { duration: 500 });
shore.queryFeature(point); // the water polygon as GeoJSON, or null
```

The layer reads the tiles maplibre-gl-js has already loaded for the source, so
it adds no requests; it needs the source to be used by at least one style layer.
Paint values accept literals, CSS color strings, or zoom expressions.

## Development

Both implementations are tested against `spec.json` and share
`shaders/shore.glsl`; the two layouts share the same test fixtures. Preview the
web layer with `mise run web`, and the native one with:

```bash
mise run //apps/native-viewer:run water -- --before landcover-ice-shelf \
  --center 37.8685,-122.4335 --zoom 15.6 --bearing -25 --pitch 55
```

The viewer re-applies `examples/layer.json` whenever you save it.
