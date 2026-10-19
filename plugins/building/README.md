# Building

A `building` layer: a replacement for `fill-extrusion` that draws walls and OSM
roofs (`roof:shape`), for StreetComplete-style views of OSM roof tagging. Each
building gets one of the 17 roof shapes of StreetComplete's roof quest, chosen
by its own tags, and is drawn like core fill-extrusion: lit by the style's light
(anchor, position, color and intensity), with the vertical gradient,
`translate`, opacity that never shows internal faces, a depth buffer shared with
other 3D layers, and 3D hit tests on the projected building.

The layer is tile-driven: point it at a polygon layer of a vector or GeoJSON
source. The native plugin renders on Metal, Vulkan and OpenGL ES, checked pixel
by pixel against core fill-extrusion on each (on macOS: Vulkan through MoltenVK,
OpenGL ES through ANGLE). The JS layer renders on WebGL 2 under the mercator
projection, and on the globe without terrain. Insert it below the style's
labels.

```json
{
  "id": "building-shapes",
  "type": "building",
  "source": "building-shapes",
  "layout": {
    "building-roof-shape": ["coalesce", ["get", "roof:shape"], "flat"],
    "building-roof-orientation": [
      "coalesce",
      ["get", "roof:orientation"],
      "along"
    ],
    "building-roof-direction": ["coalesce", ["get", "roof:direction"], -1]
  },
  "paint": {
    "building-height": ["get", "height"],
    "building-base": ["coalesce", ["get", "min_height"], 0],
    "building-roof-height": ["coalesce", ["get", "roof:height"], 0],
    "building-roof-angle": ["coalesce", ["get", "roof:angle"], 0],
    "building-color": "#e4dccf",
    "building-roof-color": [
      "match",
      ["get", "roof:shape"],
      ["flat", "many"],
      "#8e8e8e",
      ["dome", "onion", "cone"],
      "#6f9e8b",
      ["mansard", "gambrel"],
      "#4f5661",
      "#b35a3c"
    ],
    "building-opacity": 1,
    "building-translate": [0, 0],
    "building-translate-anchor": "map",
    "building-vertical-gradient": true
  }
}
```

That is [`examples/layer.json`](examples/layer.json), on the
[shapes example](examples/shapes/README.md): the roof properties come from the
features' OSM tags, the wall color is a constant (a uniform) and the roof color
depends on the shape (attributes), so both of the host's binding paths run.
[`examples/osm/layer.json`](examples/osm/layer.json) applies the Simple 3D
Buildings rules to real OSM tags.

## How it works

Both twins lay out each tile's polygons the same way (`native/src/layout.zig`
and `js/src/layout.ts`, tested against `fixtures/layout/`). A footprint is
cleaned up and gets a roof frame from its minimum-area bounding rectangle, and
its walls and roof become one mesh, built with that feature's roof shape,
orientation and direction. The vertices carry relative roof elevations rather
than heights: the shared vertex shader (`shaders/building.glsl`) turns them into
meters from the paint properties, so heights, colors and roof angles change
without a new layout, and only the three layout properties lay tiles out again.
The shader lights every vertex exactly as core fill-extrusion does, and three
draw passes give opaque or translucent buildings (see [Rendering](#rendering)).

### Geometry

1. Rings are classified as core's `classifyRings` does: the first ring's winding
   marks exteriors. Each exterior with its holes is one building. Every tile
   draws every footprint it has, buffer copies included, and a copy the source
   cut draws roofless (see [Tile copies](#tile-copies)).
2. Each ring is cleaned up. Repeated, closing and collinear points are dropped,
   and so are spikes and jitter within 0.5 tile units. Rings with fewer than 3
   points or an area under 1 unit² are dropped.
3. The footprint is moved into a frame anchored on its own floored minimum
   corner, so every tile's copy computes the same roof. The roof frame comes
   from the exterior's minimum-area bounding rectangle, found with rotating
   calipers. `u` runs along the ridge, `v` across it with half-width `b`, and
   `a` is the half-length.
   - `along` puts `u` on the long side and `across` on the short side.
   - A set direction instead turns `+v`, the front, toward the rectangle axis
     closest to the direction. On a tie, it uses the short side's axis.
   - Without a direction, `+v` is `u` turned 90° clockwise on the map, with `u`
     pointing toward +x (or +y when vertical).
4. The roof is built from one of three families:
   - **Frame shapes** are concave height functions over the frame, written as
     the minimum of planes. The footprint is ear-clipped, and every triangle is
     clipped to every plane's facet, so each output triangle is planar. Points
     within `1e-9` (in `n`) of a break line count as on it, so rounding never
     makes a crossing where a line runs along or through a triangle's edge or
     corner.
   - **Radial shapes** are copies of the footprint shrunk toward the frame
     center, following a profile of (height, scale) steps.
   - **Flat roofs** are a triangulation at `n = 1`, and **roofless** cut copies
     one at `n = 0`.

### Roof shapes

The Source column names where each profile's constants come from.

| Shape             | Definition                                                                                                                                  | Source                                                                           |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| flat, many        | `n = 1`                                                                                                                                     |                                                                                  |
| gabled            | `1 - abs(v)/b`                                                                                                                              | OSM2World                                                                        |
| hipped            | Equal slopes: the straight skeleton of the rectangle. Across a short frame, the hips meet in a point.                                       | none: equal slopes                                                               |
| half-hipped       | Hips keep the side slope and start `min(b/3, 0.8a)` in from the ends, so the end walls rise to `n = 2/3`.                                   | OSM2World `HalfHippedRoof` (1/6 of the end wall, capped at 0.4 × the ridge line) |
| skillion          | One plane. A set direction slopes it down exactly that way, over the footprint's extent along it. Otherwise it falls toward `+v` over `2b`. | OSM2World                                                                        |
| gambrel           | `min(1 - abs(v)/2b, 2 - 2·abs(v)/b)`: breaks at `n = 2/3`, `b/3` in from the eaves                                                          | OSM2World `GambrelRoof`                                                          |
| mansard           | The gambrel profile on all four sides. Ridge ends sit `min(2b/3, 0.8a)` in from the ends.                                                   | OSM2World `MansardRoof`                                                          |
| saltbox           | Equal slopes, with the ridge 0.7 of the width from the front eaves. The back eaves stop at `n = 4/7`.                                       | OSM2World `SaltboxRoof` (Streets GL uses a back eave at 0.2 instead)             |
| round             | A semicircular barrel vault across `v` in 15° strips, with smooth gradients. Its gable walls follow the arc.                                | OSM2World / Streets GL (Streets GL uses 10° steps)                               |
| round_gabled      | An equilateral pointed arch: each side is an arc of radius `2b` centered on the opposite eave. The two smooth sides meet at a crisp ridge.  | OSM wiki: "gabled, but the 2 roof slopes are rounded"                            |
| double_saltbox    | A gabled roof cut off by a flat top. The faces rise over `0.3b`.                                                                            | StreetComplete `roof_double_saltbox` drawing                                     |
| quadruple_saltbox | A hipped roof cut off by a flat top, with equal slopes over `0.3b`.                                                                         | StreetComplete drawing; Streets GL `QuadrupleSaltboxRoofBuilder` (uses `0.5b`)   |
| pyramidal         | Radial, one band to the apex, flat-shaded                                                                                                   | OSM2World                                                                        |
| cone              | Radial, one band, smooth. Each face gets its own apex vertex.                                                                               | OSM2World                                                                        |
| dome              | Radial: ten rings with scale `sqrt(1 - h²)`, smooth, with a shared flat apex                                                                | OSM2World `DomeRoof`                                                             |
| onion             | Radial: OSM2World's spindle steps. The bulge between `h = 0.15` and `0.52` overhangs (kind 3).                                              | OSM2World `OnionRoof`                                                            |

`double_saltbox`, `quadruple_saltbox` and `round_gabled` are not documented on
the OSM wiki's `roof:shape` page. The definitions above come from
StreetComplete's quest drawings (`app/src/commonMain/composeResources/drawable/
roof_*.xml`), measured as a flat top spanning about 70% of the width, and from
Streets GL and the wiki's `Tag:roof:shape=round_gabled` page.

`run` is `b` for most shapes. It is the face's own run for the saltbox variants
(`0.3b`), `1.4b` for saltbox, the slope extent for skillion, and half the
bounding rectangle's short side for radial shapes.

### Tile copies

The host hands a plugin each feature clipped to one tile plus its buffer, and
every tile that has a footprint draws it, buffer copies included, as core
fill-extrusion does. Where copies overlap, they are the same building: depth
(`LEQUAL`) keeps one, and the translucent passes' stencil blends each pixel once
across the layer's tiles. So a building appears as soon as any tile that has it
is drawn, also while its neighbors load.

- A copy the source did not cut is the whole footprint, the same in every tile
  up to a translation. It gets its full roof, whether it lies inside the tile,
  across its edge or only in its buffer. The layout builds it in a frame
  anchored on the footprint's own floored minimum corner, so every copy computes
  the same roof: bit for bit for integer tile coordinates (both twins' tests
  move footprints by ±extent and compare).
- A copy the source cut cannot know its roof: its frame needs the whole
  footprint. It draws roofless: walls up to the eaves and a flat lid at `n = 0`
  there, in the roof color. The real roof is never below the eaves, so wherever
  a whole copy is drawn it covers the cut one. Flat shapes and footprints with
  courtyards draw their flat roof, as their whole footprint does. The lid
  carries the run the piece would have if it were whole, which only
  `building-roof-angle` reads: with `building-roof-height` the eaves are exact,
  with an angle they are an estimate.
- A cut is a ring edge on an axis-aligned line outside the tile square `[0,
  extent]` that is also the outermost coordinate of all the features the tile
  lays out on that side: a source clips everything along the same lines, so
  nothing reaches beyond them. A point repeated there is a cut that collapsed
  (both crossings of a tip narrower than the grid rounded to it). An
  axis-aligned wall elsewhere in the buffer, and an edge exactly on the tile
  border, is not a cut. Cut edges get no wall, as maplibre-gl-js's
  fill-extrusion skips its `isBoundaryEdge`s (MapLibre Native draws every edge).
  An axis-aligned wall that happens to be a tile's outermost coordinate, with no
  cut on that side, counts as a cut there and that copy draws roofless: harmless
  where another tile draws the building whole, but a lone axis-aligned building
  across a tile edge, with nothing farther out in either tile, draws roofless in
  both.

A copy is whole when the building reaches no further than the buffer beyond the
tile's square, so a building smaller than the buffer is whole in every tile
whose square it reaches. Only a building larger than the buffer can be cut in
all of them and draw roofless everywhere. The examples load their GeoJSON with
`maxzoom` 15, `buffer` 256 and `tolerance` 0 (the OSM example's
[Source options](examples/osm/README.md#source-options)): half a tile, 390 m at
zoom 15 in Bamberg. Tiled as maplibre-gl-js does, each of the Bamberg example's
1,318 sloped roofs is whole in every tile whose square it reaches, the 49 that
cross a zoom-15 tile edge included; the 280 cut copies lie in farther tiles'
buffers. With `buffer` 64 one of them, a 111 m hall, is cut in a tile it
crosses, and another tile draws it whole. The shapes example is laid out so that
no tile edge up to zoom 18 crosses a building.

### Fallbacks

These cases get a flat roof, and their walls are still drawn (copies the source
cut draw roofless instead, see [Tile copies](#tile-copies)):

- `flat`, `many`, and unknown shape values. Unknown orientations mean `along`.
- Footprints with holes. Courtyard walls face into the courtyard.
- Footprints whose bounding rectangle is thinner than 2 tile units, or a
  skillion whose extent along its direction is less than 2 tile units.
- Radial shapes whose center is not at least 0.5 tile units inside every edge
  (outside the footprint's kernel, such as an L-shape).

### Vertex contract

The layout writes 7 float32 per vertex, and the shaders rely on this layout:

- `a_pos = (x, y, run)`: `x` and `y` in tile units. `run` is the feature's
  horizontal eave-to-ridge distance in tile units. `building-roof-angle` turns
  it into a roof height (`tan(angle) × run`), and it is 0 for flat roofs.
  Roofless copies carry the run the piece would have if it were whole.
- `a_roof = (n, kind, gx, gy)`:
  - `n` in [0, 1] is the relative roof elevation: `z = wallTop + n ×
    roofHeight`, with `roofHeight = min(roof height, height - base)` and
    `wallTop = height - roofHeight`. Flat roofs use `n = 1`, so they sit at
    `height` whatever the roof height. Roofless copies use `n = 0` on their wall
    tops and lid (kind 2, gradient 0), so they stop at `wallTop`, the eaves of
    the real roof. The shaders need nothing else to tell them apart.
  - `kind`: 0 is a wall bottom (`z = base`). 1 is a wall top (`n` follows the
    roof along the wall, so gable ends rise). 2 is the roof. 3 is a roof
    underside: an overhang (the onion's bulge), whose normal points down.
  - For walls, `(gx, gy)` is the outward unit normal in tile coordinates. For
    roofs it is the gradient of `n` per tile unit, and the surface normal is
    `±normalize(-roofHeight·gx, -roofHeight·gy, 1)` with heights converted to
    tile units (+ for kind 2, - for kind 3).

Winding: core fill-extrusion's, walls and roofs alike. The tile frame (x right,
y down, z up) is left-handed, so in tile coordinates `cross(b - a, c - a)` of
every triangle points into the building, and every triangle is counterclockwise
on screen seen from outside. Those are the front faces of back-face culling with
counterclockwise front faces (`MLN_PLUGIN_CULL_BACK_CCW`, WebGL's default
`frontFace(CCW)`). In tile coordinates roof triangles have a negative shoelace
area and undersides a positive one. The layout builds its meshes facing out and
swaps each triangle's last two indices on output.

Piecewise-linear roofs share vertices only within one planar facet, which gives
crisp ridges, hips and breaks. Curved roofs share vertices within a smooth group
and carry interpolated gradients. Each wall edge is one planar strip, split
where the roof's break lines cross it, so the wall tops meet the roof boundary
exactly. Vertices are grouped into segments of at most 65535, and every feature
gets one vertex range.

## Rendering

The layer draws like core fill-extrusion, plus roofs. It uses the same
per-vertex lighting from the style light (color, intensity, position and
anchor), the vertical gradient and `translate`. Opacity applies after depth, so
no internal face shows. The layer shares the depth buffer with other 3D layers,
and its hit test projects each building's prism, as maplibre-gl-js does.
[`fixtures/render/contract.json`](fixtures/render/contract.json) holds the
tables below in machine-readable form. Both twins test their shader tables
against it.

### Where the code goes

| File                                      | Contents                                                                                                                                                 |
| ----------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `shaders/building.glsl`                   | `buildingVertex`: heights, normals, core's lighting. Shared by every backend.                                                                            |
| `shaders/attributes.glsl`                 | The attribute declarations, through a `BUILDING_ATTRIBUTE(l, t, n)` macro                                                                                |
| `shaders/uniforms.glsl`                   | `BuildingDrawableUBO`'s members, in order, with their byte offsets                                                                                       |
| `shaders/properties.glsl`                 | One macro per bound paint property: the uniform, or the attribute mixed by its factor                                                                    |
| `shaders/vertex.glsl`                     | The vertex main's shared body, which leaves `BuildingVertex o`                                                                                           |
| `native/src/shaders.zig`                  | The OpenGL (GLSL ES 3.00), Vulkan (GLSL 450) and Metal (MSL) wrappers, the shader descriptor and the offline dump; `build.zig` reads `../shaders/*.glsl` |
| `native/src/plugin.zig`                   | Descriptors, layout callbacks, `update_uniform_block`, `evaluate_layer`, `query_feature`, `get_query_radius`                                             |
| `native/src/query.zig`, `js/src/query.ts` | The hit-test twins, both tested against `fixtures/query/prism.json` (written by its `generate.mjs` from the TypeScript twin)                             |
| `js/src/shaders.ts`                       | The WebGL 2 wrapper over `js/src/generated/*.glsl.ts`, with one program per `IS_UNIFORM` key, and the contract's tables, tested against `contract.json`  |
| `js/src/layer.ts`                         | The custom layer (`renderingMode: "3d"`), with `attributes.ts` (RGBA8 packing), `light.ts`, `tiles.ts`, `paint.ts` and `gljs.ts`                         |

The `.glsl` files compile unchanged as GLSL ES 3.00, GLSL 450 and MSL with
fast-math. Each wrapper first defines `float2`, `float3`, `float4` and
`float4x4` (GLSL only), then `BUILDING_ATTRIBUTE` and `BUILDING_ATTR`, then the
`MLN_PLUGIN_PROPERTY_<NAME>_IS_UNIFORM` macros. The native host prepends those;
the web twin prints them for each program. Then it includes `attributes.glsl`,
declares the block around `uniforms.glsl`, includes `building.glsl` and
`properties.glsl`, and writes the vertex main around `vertex.glsl`. It sets the
position from `u.tile_matrix * float4(o.position, 1.0)`, sets `v_color =
o.color` (smooth), and on Vulkan calls `applySurfaceTransform()`. The fragment
stage writes `v_color`, or `float4(0.0)` when `MLN_PLUGIN_COLOR_WRITE` is 0. The
vertex stage never reads that macro, so the depth-only pass and the color pass
compute identical positions. The dialect rules are at the top of
`building.glsl`. `node scripts/sync-shaders.mjs` mirrors the files into
`js/src/generated/`.

### Attributes and paint bindings

One shader, `building`, has twelve attributes, each with an id equal to its
location. The layout's stream 0 has a stride of 28 bytes: `a_pos` is at byte 0
and `a_roof` at byte 12. Every other attribute is the host's paint binding of a
property.

| Id | Attribute                                | Type                  | Property                     | Encoding        | Uniform offset | Factor offset |
| -- | ---------------------------------------- | --------------------- | ---------------------------- | --------------- | -------------: | ------------: |
| 0  | `a_pos`                                  | `FLOAT_X3`            | (layout)                     |                 |                |               |
| 1  | `a_roof`                                 | `FLOAT_X4`            | (layout)                     |                 |                |               |
| 2  | `a_height`                               | `FLOAT_X2` (packed)   | `building-height`            | `FLOAT`         |            160 |           128 |
| 3  | `a_base`                                 | `FLOAT_X2` (packed)   | `building-base`              | `FLOAT`         |            164 |           132 |
| 4  | `a_roof_height`                          | `FLOAT_X2` (packed)   | `building-roof-height`       | `FLOAT`         |            168 |           136 |
| 5  | `a_roof_angle`                           | `FLOAT_X2` (packed)   | `building-roof-angle`        | `FLOAT`         |            172 |           140 |
| 6  | `a_color_min`, 7 `a_color_max`           | `UINT8_X4_NORMALIZED` | `building-color`             | `COLOR_RGBA8`   |             64 |           144 |
| 8  | `a_roof_color_min`, 9 `a_roof_color_max` | `UINT8_X4_NORMALIZED` | `building-roof-color`        | `COLOR_RGBA8`   |             80 |           148 |
| 10 | `a_opacity`                              | `FLOAT_X2` (packed)   | `building-opacity`           | `FLOAT`         |            176 |           152 |
| 11 | `a_vertical_gradient`                    | `FLOAT_X2` (packed)   | `building-vertical-gradient` | `BOOLEAN_FLOAT` |            180 |           156 |

- Numbers pack [min, max] into one float2: the binding names the same attribute
  for both ends.
- Colors are premultiplied, stored as `floor(clamp(c, 0, 1) × 255)` in bytes, as
  core packs data-driven colors (and #4685's fill-extrusion with this encoding).
  Uniform colors stay float4.
- `building-opacity` and `building-vertical-gradient` are camera only, so they
  always arrive in the block; the host makes every binding name attributes.
- `building-translate` and `-translate-anchor` have no binding: the host applies
  them to `tile_matrix` (see below). Layout properties need none.

The web twin binds the same locations. `@maplibre-plugins/paint` evaluates the
values (it has a `boolean` type for the vertical gradient) and fills floats as
the host's binders do; `js/src/attributes.ts` packs them for the GPU, numbers as
float pairs and colors as the host's truncated bytes, 8 bytes per bound
property.

### Uniform block

`BuildingDrawableUBO`, uniform id 0, is 192 bytes, vertex stage only, and uses
`MLN_PLUGIN_UNIFORM_DRAWABLE` scope. One block holds everything. The binders'
interpolation factors must sit in a drawable-scope block, and OpenGL and Metal
allow one block per stage slot, so the layer-wide light is copied into every
drawable's block.

| Offset | Member                         | Written by                                             |
| -----: | ------------------------------ | ------------------------------------------------------ |
|      0 | `tile_matrix`                  | `update_uniform_block`: the context's `tile_matrix`    |
|     64 | `color`                        | binder (`building-color`)                              |
|     80 | `roof_color`                   | binder (`building-roof-color`)                         |
|     96 | `light_color`                  | callback: rgb `light_color`, a `light_intensity`       |
|    112 | `light_position`               | callback: xyz `light_direction`, w 0                   |
|    128 | `interpolation0`               | binders: height, base, roof-height, roof-angle         |
|    144 | `interpolation1`               | binders: color, roof-color, opacity, vertical-gradient |
|    160 | `height` … `vertical_gradient` | binders, 4 bytes each in binding order                 |
|    184 | `meters_per_tile_unit`         | callback, from the tile id (below)                     |
|    188 | `pad0`                         | zero                                                   |

The callback zeroes the block and fills its own members. The host's binders then
write their ranges. The web twin fills all of it for each tile, from its own
evaluation.

### Tile units and meters

`building-roof-angle` turns `run` (tile units) into meters, and the roof normal
needs the roof height in tile units. Both use the meters per tile unit at the
tile's center latitude, computed in f64 on the CPU from the canonical tile id
(`tile_x`, `tile_y`, `tile_z` in the uniform context; the canonical
`OverscaledTileID` on the web):

```
n   = 2^tile_z
lat = atan(sinh(π (1 − 2 (tile_y + 0.5) / n)))
meters_per_tile_unit = 2π R cos(lat) / (n × 8192)
```

8192 is the tile extent. The uniform context does not carry it, but Native
normalizes geometry to 8192 and maplibre-gl-js uses the same extent. `R` is each
host's earth radius: 6378137 on Native (`util::EARTH_RADIUS_M`) and 6371008.8 in
maplibre-gl-js (`earthRadius`). Each host's projection matrix scales meters to
pixels with its own radius at the camera center's latitude. Using the same
radius cancels it, so a roof angle renders as the true angle in both hosts. The
tile center's latitude differs from the camera's by under 0.05% within a z14
tile. The block has `meters_per_tile_unit` 0 when the tile id is missing, and
roofs are then lit as if flat.

### Shading

The shading is `buildingVertex` in `shaders/building.glsl`, per vertex. The
fragment stage only interpolates it, as core does.

- Heights: `height` and `base` clamp at 0. `roofHeight` is `tan(min(angle, 89°))
  × run × meters_per_tile_unit` when `building-roof-angle` is above 0, else
  `building-roof-height`, clamped to `[0, max(height − base, 0)]`. `wallTop =
  max(base, height − roofHeight)`. `z = base` at wall bottoms (kind 0), else
  `wallTop + n × roofHeight`. Flat roofs have `n = 1`, so they sit at `height`
  whatever the roof height, and a flat building is a fill-extrusion. Roofless
  copies have `n = 0` and stop at `wallTop`. With `base ≥ height` the building
  collapses to a roof at `base`.
- Normals in tile coordinates: walls (kinds 0 and 1) use `(gx, gy, 0)`. Roofs
  use `normalize(−rise·gx, −rise·gy, 1)` with `rise = roofHeight /
  meters_per_tile_unit`, negated for undersides (kind 3).
- Color: walls take `building-color` and roofs `building-roof-color`, both
  premultiplied with their alpha ignored, as core does.
- Light, exactly core's (Native's `fill_extrusion.vertex.glsl`):
  ```
  luminance   = dot(color.rgb, (0.2126, 0.7152, 0.0722))
  directional = clamp(dot(N, (−L.x, −L.y, L.z)), 0, 1)
  directional = mix(1 − I, max(1 − luminance + I, 1), directional)
  walls:  directional ×= (1 − g) + g × clamp((t + base) × sqrt(height / 150), mix(0.7, 0.98, 1 − I), 1)
  rgb   = clamp((color.rgb + 0.03) × directional × C, mix(0, 0.3, 1 − C), 1)
  out   = (rgb, 1) × opacity
  ```
  `L` is core's `u_lightpos`, `I` the intensity, `C` the light color, `g` the
  vertical gradient (0 or 1), and `t` is 0 at wall bottoms and 1 at wall tops.
  Core lights walls with an inward normal against `L` and roofs with `(0,
  0, 1)`. The outward normal against `L` mirrored in x and y is the same for
  both, and carries over to sloped roofs. The gradient uses `building-height`
  (the roof top) as core's uses the extrusion height, so it matches a
  fill-extrusion of the same height. Like Native, it applies to every wall.
  maplibre-gl-js tests `normal.y != 0`, which skips walls facing exactly east or
  west.
- `L` is the style light's Cartesian position, `sphericalToCartesian([r,
  azimuthal, polar])` with 90° added to the azimuth. With a `viewport` anchor it
  is rotated by the bearing `b` (radians, clockwise from north): `(cos b·x − sin
  b·y, sin b·x + cos b·y, z)`. Native supplies it as `light_direction`. The web
  twin computes it from `map.style.light` as maplibre-gl-js's
  `fillExtrusionUniformValues` does. A style without `light` gets the defaults:
  viewport anchor, position `[1.15, 210, 30]`, white, intensity 0.5.

### Draw passes, opacity and translate

The layer type sets `is_3d = 1`, `enable_near_clipped_matrix = 1` (core's
unaligned near-clipped matrix, as #4685's fill-extrusion) and three passes. It
must always declare passes. The carried host gives an `is_3d` layer without them
2D depth (see `patches/maplibre-native-ffi/README.md`).

| Pass | Depth test | Depth write | Color | Blend | Stencil dedup | Cull       |
| ---- | ---------- | ----------- | ----- | ----- | ------------- | ---------- |
| 0    | yes        | yes         | yes   | yes   | no            | `BACK_CCW` |
| 1    | yes        | yes         | no    | no    | no            | `BACK_CCW` |
| 2    | yes        | yes         | yes   | yes   | yes           | `BACK_CCW` |

`evaluate_layer` returns `enabled_passes` 0 when `building-opacity ≤ 0`, `0b001`
(the single opaque pass) when it is 1, and `0b110` otherwise. The otherwise case
writes every building into depth first, then draws only the nearest surface,
once per pixel (one stencil reference across the layer, so a building that
several tiles draw, each its own copy, does not blend twice; the render test
checks it on a building drawn by four tiles). It also returns
`building-translate` and whether the anchor is `viewport`. The host folds that
translation into `tile_matrix`, as core fill-extrusion does. Every drawable
culls back faces with counterclockwise front faces, which the layout's winding
provides.

Each bucket has one drawable, key 1, with shader `building`. It uses the
layout's segments, and its feature vertex ranges name that key. `should_animate`
is null. The bucket's `query_radius` is 0, and `get_query_radius` returns
`|building-translate|`, as #4685's does.

The web twin does the same with WebGL state, in the depth range maplibre-gl-js
gives 3D custom layers. It uses `depthFunc(LEQUAL)`, `cullFace(BACK)` and
`frontFace(CCW)`, with premultiplied blending `(ONE, ONE_MINUS_SRC_ALPHA)`. The
depth-only pass draws every tile with `colorMask` false (instead of a
`MLN_PLUGIN_COLOR_WRITE` 0 program) before the color pass. The color pass takes
its stencil reference from maplibre-gl-js's `painter.stencilModeFor3D()`
(`NOTEQUAL` to a fresh id, `REPLACE`), as core fill-extrusion does; that keeps
the painter's stencil ids and clipping-mask cache right. It is internal API
(`js/src/gljs.ts`), and without it the pass draws undeduplicated. Each tile's
block sits at an aligned offset of one uniform buffer, bound per draw with
`bindBufferRange`. The block's `tile_matrix` is the mercator tile matrix with
the translation applied as `translatePosMatrix` does, but the vertex shader
projects through maplibre-gl-js's `projectTileFor3D(o.position.xy + u_translate,
o.position.z)` prelude instead, so the layer also draws on the globe;
`u_translate` is a plain uniform outside the shared block. On the globe the
lighting stays mercator's (gl-js also turns its normals onto the sphere) and hit
tests use the mercator matrix. Terrain is out of scope.

### Hit testing

A building is hit when the query intersects its projected prism from `base` to
`height`, moved by `building-translate` as it is drawn. This is maplibre-gl-js's
`FillExtrusionStyleLayer.queryIntersectsFeature`, except for the translation:
gl-js moves the query's ground point by `−translate` instead, which misses the
translated walls and roofs of tall buildings in a perspective view by up to a
few pixels. Core Native tests only the 2D footprint. Both twins:

1. Take the feature's `building-height` and `building-base`, evaluated at the
   camera's zoom with the feature's state and clamped at 0, and
   `building-translate` and its anchor. On Native these are the evaluated
   properties `query_feature` receives (the host evaluates them at the camera
   zoom, as gl-js does).
2. Turn the translation into tile units: `translate × pixels_to_tile_units`,
   rotated by the map's bearing for a viewport anchor (Native's
   `FeatureIndex::translateQueryGeometry`, whose `bearing` is the map's
   negated).
3. Project the query points at `z = 0`, and every footprint ring vertex plus the
   translation at `z = base` and at `z = height`, with the untranslated tile
   matrix (the query context's `tile_matrix` on Native), then divide by w. A
   ring or face with a vertex at w ≤ 0 is behind the camera and not hit.
4. Report a hit when the projected query intersects the projected top polygon
   (all rings, holes included) or any wall quad `[topA, topB, baseB, baseA]`.
   That is maplibre-gl-js's `checkIntersection`.

[`fixtures/query/prism.json`](fixtures/query/prism.json) pins both twins: hit
maps over grids of ground points for top-down and pitched perspective cameras,
courtyards, raised bases, clamped heights, map and viewport translations, and a
close, tall, translated building where moving the query instead of the prism
gives different answers.

The prism does not include an onion bulge beyond the footprint, and it counts
the sky above a sloped roof, up to the ridge's height, as a hit.

Which buildings get tested, and in what order, follows each platform's core
layer:

- **Native** tests only the candidates its host finds, as for core
  fill-extrusion. The host unprojects the query to the ground and searches the
  tile's grid around that ground point, padded by `get_query_radius` (pixels,
  times `maxPitchScaleFactor`, times tile units per pixel at the camera zoom),
  and queries only the tiles that padded box reaches. The plugin returns
  `|building-translate|`, as core does, so a building is a candidate only when
  its footprint's bounding box holds the ground point; a tall building whose
  walls or roof cover the point from elsewhere is not (see
  [Plugin API gaps](#plugin-api-gaps)). Core then tests the 2D footprint; this
  layer tests the projected prism, as gl-js does, so it also hits walls and
  roofs drawn away from the footprint, and (unlike core) not the ground under a
  raised `building-base`. Hits come in the host's order: by source order within
  a tile, last feature first, as core orders every non-symbol layer, not by
  depth (`query_feature` returns a boolean). With no padding only the tile that
  holds the ground point is queried, so each building comes back once.
- **Web** tests every building of every tile drawn in the last frame, so it
  finds every building whose prism covers the point, and sorts the hits nearest
  first by maplibre-gl-js's `getIntersectionDistance`, as gl-js orders
  fill-extrusion hits. It keeps one hit per feature id (the nearest copy).

Both run the same prism test, pinned by the same fixture, so where Native finds
a building the web twin does too; the web twin's extra hits are the buildings
Native's broad phase never offered.

## Layout and paint properties

[`spec.json`](spec.json) is the property table, with types, defaults, ranges and
docs. Geometry and topology are layout properties, evaluated per feature when a
tile is laid out (no transitions, no feature-state). Everything else is paint,
as for `fill-extrusion`.

| Layout                      | Default | Meaning                                                                     |
| --------------------------- | ------- | --------------------------------------------------------------------------- |
| `building-roof-shape`       | `flat`  | One of StreetComplete's 17 `roof:shape` values. `many` draws a flat roof.   |
| `building-roof-orientation` | `along` | `along` puts the ridge along the longer side of the bounding rectangle.     |
| `building-roof-direction`   | `-1`    | `roof:direction` in degrees. Negative means unset, and orientation decides. |

Paint properties follow `fill-extrusion`'s:

- `building-height` is the top of the roof and `building-base` the bottom of the
  walls, in meters above the ground (OSM `height` and `min_height`).
- The roof's own height is `building-roof-height`, meters from the eaves to the
  ridge, or, when `building-roof-angle` is above 0, the angle over the shape's
  run. It is clamped to fit between the base and the height; flat roofs sit at
  `building-height` whatever it is.
- `building-color` colors the walls and `building-roof-color` the roof. Both
  default to black, as `fill-extrusion-color` does.
- `building-opacity` applies to the whole layer after depth, so walls and roofs
  never show through each other.
- `building-translate`, `building-translate-anchor` and
  `building-vertical-gradient` (a boolean) work as fill-extrusion's.

The heights, the roof angle and both colors accept feature, composite and
feature-state expressions; opacity, translate and the gradient are camera only.
Numbers and colors transition; the anchor and the gradient switch. The Simple 3D
Buildings rules (3 m per level, `roof:levels`, `min_height`,
`building:min_level`) belong in style expressions.

To alias other OSM values, use a match expression, for example `["match",
["get", "roof:shape"], ["lean_to", "shed"], "skillion", ...]`.

## StreetComplete

The layer is meant for StreetComplete's views of roofs: showing the roof tags a
user has mapped, and previewing an answer to the roof shape quest. To wire it
up:

- **Source.** Write the buildings of StreetComplete's local OSM data into a
  GeoJSON source: one polygon per `building` way or multipolygon and per
  `building:part`, with the tags as properties. Apply Simple 3D Buildings while
  writing it, as [`examples/osm/generate.mjs`](examples/osm/README.md) does:
  drop outlines that have parts (the layer cannot), leave out underground
  buildings, and turn units, compass points and colour names into numbers and
  `#rrggbb` (style expressions cannot parse them). Load it with the options of
  [`examples/osm/source.json`](examples/osm/source.json); with a buffer smaller
  than the buildings, those across tile edges are cut in every tile and draw
  roofless, and without `tolerance` 0 Native simplifies small and round
  footprints.
- **Style.** Keep the rules in the layer's expressions.
  [`examples/osm/layer.json`](examples/osm/layer.json) has 3 m per level,
  `roof:levels`, `min_height`, `building:min_level`, default roof heights per
  shape, OSM aliases of `roof:shape` values, and colors from `building:colour`,
  `roof:colour` and the materials. `building-roof-shape` takes StreetComplete's
  17 values as they are.
- **Feature ids.** MapLibre Native has no `promoteId`, so feature-state (hover,
  selection) needs top-level numeric GeoJSON ids. Ways and relations share
  number spaces; the example adds 10^12 to relation ids.
- **Previewing a roof shape.** The roof shape, orientation and direction are
  layout properties: they cannot read feature-state, and changing them lays the
  tiles out again. To preview an answer on the selected building, write the
  candidate tag into that feature and call the source's `setData`. Or draw the
  selected building in a second `building` layer, filtered to its id with a
  constant `building-roof-shape`, and filter it out of the main layer. A
  highlight is paint, so feature-state can drive it, as the gallery's OSM roofs
  page does.
- **Host.** The native plugin needs a host built with this repo's FFI patches
  (see [Required native patches](#required-native-patches)); a stock MapLibre
  Native SDK cannot load it.

## Examples

- [`examples/layer.json`](examples/layer.json): the example layer the gallery
  and the native viewer load. It draws the shapes example from the source
  `building-shapes`, reading its properties directly. The wall color is a
  constant (a uniform) and the roof color depends on the shape (attributes), so
  it exercises both binding paths.
- [`examples/shapes/`](examples/shapes/README.md): a synthetic grid of 170
  buildings in an empty part of Letenské sady, Prague. It covers all 17 roof
  shapes on a rectangle, a rotated rectangle, an L-shape and a round footprint,
  with `along`, `across`, direction and roof-angle variants. Every tile edge up
  to zoom 18 runs between the buildings, so it draws the same with any GeoJSON
  source options.
- [`examples/osm/`](examples/osm/README.md): real OSM buildings of Bamberg's old
  town with their roof tagging, and a layer with the Simple 3D Buildings rules
  that colours roofs by whether `roof:shape` is tagged.

## Native

```bash
mise run //plugins/building/native:build          # zig-out/lib/libmaplibre-building.*
mise run //plugins/building/native:test
mise run //plugins/building/native:shader-check   # every shader variant through glslang and Metal
mise run //plugins/building/native:render-test    # offscreen renders and checks (macOS; Metal, or MLN_NATIVE_PRESET's backend)
```

Load the library with the FFI's plugin loader (`mln_plugin_load_library` or a
binding's `loadPlugin`) using the entry point `mln_building_register`, before
loading a style that uses `building`. Then add the source and the layer JSON
with the ordinary add-source and add-layer calls. Rendered-feature queries hit
buildings through the plugin's prism test ([Hit testing](#hit-testing)), within
the broad-phase limit under [Plugin API gaps](#plugin-api-gaps).

The plugin builds against the plugin ABI header alone and has no link dependency
on the host. Preview it with:

```bash
mise run //apps/native-viewer:run building   # the shapes grid, zoom 17, pitch 60
mise run //apps/native-viewer:building-osm   # OSM buildings of Bamberg's old town
```

The viewer re-applies the layer JSON whenever you save it; a change to a layout
property lays the tiles out again. Its `--geojson <id>=<file>` and
`--geojson-options <id>=<source.json>` flags add the sources.

### Required native patches

From `patches/maplibre-native-ffi/` this plugin needs:

| Patch                                              | Used for                                                                                                                                                                                                                                  |
| -------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `0001` plugin fill-extrusion rendering API (#4685) | `is_3d`, the three draw passes, `evaluate_layer` (pass mask and translate), the near-clipped matrix, the light, zoom and tile id in the uniform context, layout properties, `BOOLEAN` values, `COLOR_RGBA8` and `BOOLEAN_FLOAT` encodings |
| `0006` plugin feature layout properties            | each feature's roof shape, orientation and direction on `mln_plugin_feature_v1`                                                                                                                                                           |

It uses no feature of `0002`–`0005`, but the vendored header's structs include
their fields, and the plugin checks the layout and uniform contexts against the
header's full sizes, so it needs a host with the whole stack, `0001` to `0006`.
The layer must always declare its draw passes: the carried host gives an `is_3d`
layer without them 2D depth, unlike #4685. For OpenGL, the FFI's attribute-name
matching (`0035`) binds the attributes when uniform and data-driven properties
mix.

## Web

```ts
import { BuildingLayer } from "@maplibre-plugins/building";

map.addSource("building-shapes", { ...sourceJson, data }); // source.json plus data
const buildings = BuildingLayer.fromLayerJson(layerJson); // the JSON above
map.addLayer(buildings, firstSymbolLayerId); // below the labels
buildings.setPaintProperty("building-opacity", 0.6, { duration: 300 });
buildings.setLayoutProperty("building-roof-shape", "hipped"); // lays every tile out again
buildings.queryFeatures(point); // every building under the point, nearest first
```

The layer reads the tiles maplibre-gl-js has already loaded for the source,
vector or GeoJSON, so it adds no requests. gl-js loads a source's tiles only
while a built-in layer uses it, so the layer adds a hidden fill layer,
`<id>-tiles`, with its own visibility and zoom range. Paint values accept
literals, CSS color strings or expressions, the same inputs a style gives the
native plugin; feature-state works with GeoJSON ids or `promoteId`.
`queryFeatures` returns GeoJSON features with their source and their evaluated
roof layout values, one per feature id. Every tile draws its own copy of a
building, so one without an id comes back once per tile that has it under the
point, as core `queryRenderedFeatures` may return a feature once per tile. After
a WebGL context loss maplibre-gl drops custom layers: add the same layer again,
as the gallery does.

`mise run web` shows two gallery pages: "Buildings" (the shapes grid, with the
spec-driven controls, the style light, and a core fill-extrusion layer to
compare) and "OSM roofs (Bamberg)" (hover highlight and a popup with the roof
tags).

## Limits and future improvements

[docs/plugin-api-gaps.md](../../docs/plugin-api-gaps.md) collects the plugin API
gaps of every plugin in this repo, with workarounds and the host fixes that
would close them. The ones that limit this layer are under
[Plugin API gaps](#plugin-api-gaps) below.

1. **Frame roofs follow the bounding rectangle.** On footprints that are not
   rectangles (L, T or irregular outlines), gabled, hipped, mansard and the
   other frame shapes are the rectangle's roof clipped to the footprint, so
   ridges and hips do not follow the arms of an L. Fix: a straight skeleton of
   the footprint for hipped and mansard roofs, and ridges along its arms for
   gabled ones, in both twins.
2. **Radial shapes copy the footprint.** A dome or onion on a rectangle is a
   rectangular bulb, and on footprints whose center is outside their kernel (an
   L) radial shapes fall back to flat. Fix: blend the profile toward a circle
   inscribed in the footprint.
3. **Buildings larger than the buffer draw roofless.** A copy the source cut at
   its buffer cannot know its roof and draws roofless, walls to the eaves and a
   lid ([Tile copies](#tile-copies)); a building is cut in every tile only when
   it is larger than the buffer. No building of the Bamberg example is, with its
   buffer of 256, but vector tiles often have small buffers. The web twin's
   `queryFeatures` still reports the tagged shape for them. Fix: unclipped
   feature bounds from the host (see the gap below).
4. **Cut copies guess some things.** A roofless lid sits exactly at the eaves
   with `building-roof-height`; with `building-roof-angle` its run, and so its
   eaves, come from the piece, and can stand above the real roof's eaves where a
   whole copy is drawn too (the Bamberg example has no `roof:angle`). An
   axis-aligned wall that is a tile's outermost coordinate is taken for a cut
   there, so in a sparse tile a lone axis-aligned building across its edge draws
   roofless. A cut whose crossings a vector tile encoder merged into one point
   is taken for a whole footprint.
5. **Holes flatten roofs.** Footprints with courtyards get flat roofs.
6. **Building parts are the source's job.** The layer draws every polygon it is
   given. Simple 3D Buildings' rules for `building:part` (drop the outline that
   has parts; parts do not inherit the outline's tags) and `type=building`
   relations must be applied when the data is written, as the OSM example does.
   `roof:ridge` and `roof:edge` ways are not used. Coplanar faces of overlapping
   parts z-fight.
7. **Triangulation.** Rings that touch at a point triangulate correctly: an ear
   is never clipped across a copy of one of its corners whose boundary runs into
   it, and zero-width spikes are dropped first. Chains of courtyards touching
   each other and the exterior can still make the ear clipper overlap a triangle
   with a courtyard (about 1 in 250 random configurations of touching diamonds
   in testing). Earcut has the same class of failure; a fix would split the
   polygon at its pinch points first. Footprints that intersect themselves are
   not repaired: the triangulator terminates, but the roof may overlap itself or
   leave gaps. Where several break lines meet on very thin footprints (a few
   tile units across), facets can compute their meeting point up to about 0.01
   tile units apart, leaving a crack far below a pixel.
8. **Hit tests.** Natively, tall buildings in pitched views are hard to hit:
   queries miss about half of the drawn points in pitched views of the shapes
   grid and a quarter in Bamberg. Native orders hits by source order, not depth
   (see below, and [Hit testing](#hit-testing)). In both twins the prism does
   not include an onion bulge beyond the footprint and counts the sky above a
   sloped roof, up to the ridge.
9. **Backends.** The render test passes on Metal, Vulkan (MoltenVK) and OpenGL
   ES (ANGLE), all on Apple GPUs; Vulkan and OpenGL drivers elsewhere (Linux,
   Windows, Android) were not run, and `shader-check` compiles their shaders
   offline. The web layer was checked in Chromium on ANGLE's Metal backend.
10. **Globe and terrain.** On the globe (web only, checked visually) the
    lighting stays mercator's and hit tests use the mercator matrix, so queries
    are approximate while the globe transition is above 0. Terrain is not
    supported.
11. **Data-driven colors are 8-bit.** They are packed as `COLOR_RGBA8`, on
    Native as on the web; uniform colors stay float.
12. **No roof textures.** `roof:material` can pick a color in the style, but not
    a texture. #4685's `IMAGE` properties and pattern atlas could add one on
    Vulkan and Metal only.
13. **Vertical gradient on east and west walls.** The shader follows Native,
    which darkens every wall; maplibre-gl-js's core layer skips walls facing
    exactly east or west, so the web layer differs from gl-js's own
    fill-extrusion there (by up to 29/255 in testing).

### Plugin API gaps

The full ledger is [docs/plugin-api-gaps.md](../../docs/plugin-api-gaps.md). For
this layer:

- Features arrive clipped to the tile and its buffer, with nothing about the
  rest of the footprint, so a copy the source cut draws roofless, and only a
  building smaller than the buffer is sure of a whole copy
  ([Tile copies](#tile-copies)). The cut lines themselves are inferred from the
  tile's bounds, as the layout context has no buffer. A host fix: each feature's
  unclipped bounds (or its whole outline) in the layout callbacks, or a stable
  feature id to stitch the pieces across tiles as Mapbox's fill-extrusion does
  for its edge features, or a polygon analogue of GeoJSON's `lineMetrics`, which
  already carries the clipped range of a line.
- `query_feature` returns only a boolean, so Native cannot order 3D hits by
  depth; they come in the host's source order. A host fix: return an
  intersection distance, as gl-js's `getIntersectionDistance` gives, and sort 3D
  layers' hits by it.
- The uniform context has no tile extent and no meters-to-pixels scale, so
  `meters_per_tile_unit` comes from the tile id. The ABI's only cull modes are
  none and `BACK_CCW`, so the layout uses core's winding.
- Camera-only paint properties reach a shader only through a binding, which
  needs vertex attributes (ids 10 and 11 here are never bound) and an
  interpolation slot in a drawable-scope block.
- Native's broad phase searches around the query's ground point, padded by
  `get_query_radius` in pixels at the camera zoom, and that callback gets
  neither the zoom nor the latitude. A prism `H` meters tall can cover a pixel
  up to `H × ppm × F` pixels from its footprint, with `ppm = 512 × 2^zoom / (2π
  × 6378137 × cos latitude)` and `F = hypot(aspect × t, t × cos pitch + sin
  pitch) / cos pitch`, `t = tan(fov / 2) = 1/3` (the host's
  `maxPitchScaleFactor` is already folded in), so without the zoom the plugin
  cannot pad by height. It returns `|building-translate|`, as core and #4685's
  plugin do, and the grid finds a building only when the query's ground point is
  in its footprint's bounding box; there the projected prism decides. So the
  roof of a turned rectangle that covers ground in a corner of its box is hit,
  though its 2D footprint is not, but a query high up one of Bamberg Cathedral's
  13 m wide, 72 m towers in a pitched view at zoom 16.5 misses it. The render
  test's query grids (every 20th pixel's center, 1200 × 800) measure it: Native
  misses 51% of the drawn points in the shapes example at zoom 17.3 and pitch
  60, 50% at 17.6 and 55, 13% top down, and 25%, 25% and 3% in Bamberg (pitch 60
  at 16.5, 58 at 17.6, top down). The web twin tests every building and misses
  none. Padding by the formula above, with the zoom handed in by a test build,
  brought every grid (the shapes example's and those of the earlier Prague demo)
  to 0.3% or less, but cost: one 99 m spire in Prague padded the search past a
  whole tile, so a query there took about 6 ms instead of 0.02 (a full scan took
  8), and the sky above sloped roofs started to hit (95 of the shapes grid's
  1545 undrawn points). A host fix: search 3D layers along a camera query
  geometry, as maplibre-gl-js does (no height or zoom needed, and only buildings
  between the ground point and the camera are offered), or pass the zoom and
  tile latitude to `get_query_radius`
  ([the ledger](../../docs/plugin-api-gaps.md#queries)).
- Draw passes are per layer and all-or-nothing, and the carried host gives an
  `is_3d` layer without passes 2D depth, so the layer always declares its three
  passes.
- Native has no `promoteId`, and its geojson-vt simplifies tiles at the source's
  maxzoom unless `tolerance` is 0 (see the OSM example's
  [Source options](examples/osm/README.md#source-options)).

## Development

```bash
pnpm --filter @maplibre-plugins/building test
mise run //plugins/building/native:test             # the Zig twin, no native library needed
node plugins/building/fixtures/layout/generate.mjs   # rewrite the fixtures
pnpm exec dprint fmt plugins/building/fixtures/layout/*.json
node plugins/building/fixtures/query/generate.mjs    # rewrite the hit-test fixtures
node plugins/building/js/scripts/contact-sheet.ts    # /tmp/building-contact-sheet.svg (+ .png on macOS)
node plugins/building/js/scripts/fuzz.ts 1 300       # random footprints against the layout invariants
node scripts/sync-shaders.mjs                        # mirror shaders/*.glsl into js/src/generated/
node plugins/building/examples/shapes/generate.mjs   # rewrite and check the shapes example
mise run //plugins/building/native:shader-check      # every native shader variant through glslang and Metal
mise run //plugins/building/native:render-test       # offscreen renders and checks (macOS; Metal, or MLN_NATIVE_PRESET's backend)
mise run //apps/native-viewer:run building           # the shapes grid in the native viewer
mise run //apps/native-viewer:building-osm           # the Bamberg OSM demo in the native viewer
```

The render test (`native/render/render.py`, after `mise run ffi:build`) draws
the shapes grid and the Bamberg demo at pitched, rotated, top-down, translucent,
translated and map-anchored-light cameras, and a scene beside core
fill-extrusion, to `/tmp/building-native/*.png`, and both on a zoom-15 tile
corner, where every tile draws its copy of the buildings across it. It checks
that a flat building shades exactly like a core fill-extrusion of the same color
and height (roof, south wall and, lit from the west-northwest, west wall), that
a translucent building drawn by four tiles blends once, and that queries hit
footprints and prisms and miss open ground. Six cameras also query a grid of
pixels and report how many drawn points no query hits (the broad-phase gap under
[Plugin API gaps](#plugin-api-gaps)); each fails above a ceiling just over
today's share, so a narrow phase that stops hitting shows up. Look at the images
too.

It renders on the install's backend. For Vulkan (MoltenVK and the Vulkan loader
from Homebrew, `brew install molten-vk vulkan-loader`) or OpenGL ES (the ANGLE
build that the preset downloads), build that preset once and run the test with
the same `MLN_NATIVE_PRESET`; the PNGs go to `/tmp/building-native-vulkan` or
`/tmp/building-native-opengl`:

```bash
MLN_NATIVE_PRESET=macos-arm64-vulkan mise run ffi:build
MLN_NATIVE_PRESET=macos-arm64-vulkan mise run //plugins/building/native:render-test
MLN_NATIVE_PRESET=macos-arm64-egl mise run ffi:build
MLN_NATIVE_PRESET=macos-arm64-egl mise run //plugins/building/native:render-test
```

The three backends pass the same checks with the same sampled colors. Their
frames differ only where coplanar OSM surfaces z-fight (under 0.1% of the pixels
in the cathedral views) and in single edge pixels.

The fixtures in `fixtures/layout/` are written by the TypeScript layout, and the
Zig twin must reproduce them. Their format and summary formula are documented in
`js/src/fixture.ts` (read by `native/src/fixture.zig`). `zig build test` embeds
every `*.json` in that directory, so a new fixture needs no build change.

The twins mirror each other file by file, so a change to one has a counterpart
in the other:

| TypeScript (`js/src/`) | Zig (`native/src/`)  | Contents                                           |
| ---------------------- | -------------------- | -------------------------------------------------- |
| `footprint.ts`         | `footprint.zig`      | ring cleanup and classification, bounding frame    |
| `triangulate.ts`       | `triangulate.zig`    | ear clipping with hole bridges                     |
| `roof.ts`              | `roof.zig`           | roof frames, planes, profiles                      |
| `layout.ts`            | `layout.zig`         | walls, roofs, vertex output and segments           |
| `spec.ts`              | `spec.zig`           | the layout table's enums (paint with `plugin.zig`) |
| `fixture.ts`           | `fixture.zig`        | the fixture format and summaries                   |
| `layout.test.ts`       | `layout_test.zig`    | fixtures, invariants and per-shape semantics       |
| `footprint.test.ts`    | `footprint_test.zig` | footprint and triangulator unit tests              |

Both twins work in f64 one operation at a time in the same order and round to
float32 only on output, so their fixture summaries agree to the 12 significant
digits the fixtures record.

## Credits and licenses

The OSM example's data is © OpenStreetMap contributors, available under the Open
Database License; its notice is
[`examples/osm/buildings.geojson.LICENSE.txt`](examples/osm/buildings.geojson.LICENSE.txt).
Credit it wherever the data is shown, as the gallery's OSM roofs page and the
`building-osm` viewer task do. The shapes example is synthetic and has no OSM
data; its coordinates were only checked against OSM for an empty spot.

The lighting and vertical gradient follow MapLibre Native's fill-extrusion
shader, and the hit test maplibre-gl-js's fill-extrusion query, both
BSD-licensed. The roof profiles follow the definitions credited in
[Roof shapes](#roof-shapes): OSM2World, Streets GL, StreetComplete's roof quest
drawings and the OSM wiki.
