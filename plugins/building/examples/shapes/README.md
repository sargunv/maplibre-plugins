# Roof shapes example

A synthetic grid of buildings showing every roof shape of the `building` layer.
It stands in an empty part of Letenské sady in Prague (50.0956–50.0986 N,
14.4113–14.4191 E), about 500 m north of the [OSM example](../osm/README.md).
The only things in the way are two flights of park steps and a shed.

- `buildings.geojson`: 170 Polygon features, one per line, with ids 1 to 170.
  dprint does not format `.geojson`.
- `source.json`: the GeoJSON source options, as the OSM example uses (see its
  [Source options](../osm/README.md#source-options)). Apps add `data`. The
  grid's tile edges do not depend on them (see below), but without `tolerance` 0
  MapLibre Native simplifies the 24-gon footprints to about 8 sides.
- `generate.mjs`: writes `buildings.geojson` and checks it (`node generate.mjs`;
  `--check` only checks that the file is current).
- The layer is [`../layer.json`](../layer.json), the plugin's example layer, on
  the source `building-shapes`.

A good first view is centered on 14.4152 E, 50.0971 N at zoom 17, with pitch 60.

## The grid

Columns, west to east, are the 17 values of `building-roof-shape` in `spec.json`
order: `flat`, `gabled`, `hipped`, `half-hipped`, `pyramidal`, `skillion`,
`gambrel`, `round`, `double_saltbox`, `saltbox`, `mansard`, `dome`,
`quadruple_saltbox`, `round_gabled`, `onion`, `cone` and `many`. Rows, north to
south:

| Row | Footprint                    | Variant                                  |
| --: | ---------------------------- | ---------------------------------------- |
|   1 | rectangle, 18 m × 11 m       | `along`                                  |
|   2 | rectangle                    | `across`                                 |
|   3 | rectangle                    | `roof:direction` 200                     |
|   4 | the rectangle turned 30°     | `along`                                  |
|   5 | turned rectangle             | `across`                                 |
|   6 | turned rectangle             | `roof:direction` 75                      |
|   7 | L, 18 m × 14 m with 8 m arms | `along`                                  |
|   8 | L                            | `across`                                 |
|   9 | 24-gon of radius 8 m         | `along`                                  |
|  10 | rectangle                    | `roof:angle` 35 instead of `roof:height` |

The radial shapes (`pyramidal`, `cone`, `dome`, `onion`) on the L-shape draw
flat roofs: the center of the L's bounding rectangle is outside its kernel, one
of the documented fallbacks.

Walls are 7 m high. `height` adds the shape's `roof:height`: 3 m for `skillion`,
4 m for `double_saltbox` and `quadruple_saltbox`, 5 m for most shapes, 6 m for
`pyramidal`, `gambrel`, `dome` and `round_gabled`, 8 m for `cone` and 9 m for
`onion`. `flat` and `many` are 9 m high. In the roof-angle row, `height` is 7 m
plus `tan(35°)` times the shape's run, so the roof fits above the walls.

## Properties

`label` (for example `"gabled, rectangle, along"`), `footprint`, `variant`,
`roof:shape`, `height` and, where set, `roof:height`, `roof:angle`,
`roof:orientation` and `roof:direction`. These use the OSM tag names, but the
values are already numbers and the layout's enum strings, so
[`../layer.json`](../layer.json) reads them with `get` and `coalesce`.

## Tile edges

A footprint that crosses a tile edge gets a flat roof (README, "Fallbacks"). The
grid's cells are one third of a zoom-18 tile in Web Mercator, about 32.7 m here,
aligned to zoom-18 tiles, and every building sits inside its cell. Every tile
edge at zoom 18 and below therefore runs between buildings. This holds with
`source.json` (maxzoom 15) and with a bare GeoJSON source (maxzoom 18), such as
the native viewer's `--geojson`.

`generate.mjs` checks this. It also checks that every exterior ring is
counterclockwise and every id unique. It lays out every feature in its zoom-15
tile with the TypeScript layout and checks that each roof is sloped or flat as
intended. It evaluates `../layer.json` with the MapLibre style spec on every
feature, which must give back the feature's own shape, orientation, direction,
heights and angle, with paint values in range. Finally it validates
`source.json`.
