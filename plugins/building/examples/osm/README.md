# OSM buildings example

Real OpenStreetMap buildings with their roof tagging, for the `building` layer:
Prague's Malá Strana and Hradčany, a 1.4 km by 1.4 km box with the castle, St.
Vitus Cathedral (about 130 parts, 99 m high), St. Nicholas Church and the
palaces around them.

- `buildings.geojson`: 1,688 features, 859 buildings and 829 building parts,
  about 0.9 MB. One feature per line, so diffs stay small; dprint does not
  format `.geojson`.
- `buildings.geojson.LICENSE.txt`: the ODbL notice. The data is © OpenStreetMap
  contributors. Credit it wherever the data is shown.
- `generate.mjs`: writes both files (`node generate.mjs`; `--refresh` fetches
  again instead of using the cache).
- `layer.json`: the `building` layer, with the Simple 3D Buildings rules as
  style expressions.
- `source.json`: the GeoJSON source options to load `buildings.geojson` with.
  Apps add `data`.
- `check.mjs`: checks the GeoJSON, `source.json` and `layer.json` against
  `../../spec.json` (`node check.mjs`). With the JS package's dependencies
  installed it also parses every expression with the MapLibre style spec and
  evaluates it on every feature.

A good first view is centered on 14.4040 E, 50.0885 N at zoom 16.5, with pitch
60.

## Why this area

Candidates were compared with one Overpass tag survey of the buildings and parts
in 1.2 km to 1.4 km boxes: Bamberg, Český Krumlov, Gdańsk, Goslar, Kraków,
Lublin, the Moscow Kremlin, Munich, Nördlingen, Olomouc, Prague (four boxes),
Quedlinburg, Regensburg, Suzdal, Telč, Toruń, Vienna and Wrocław. This box had
`roof:shape` on 53% of them, second only to the Kremlin (59%), and 16 distinct
values, tied with Munich for the most: towers and spires, `dome` and `onion`
church roofs, `mansard` palaces, and many `height`, `roof:height`,
`roof:direction` and colour tags. Munich and Regensburg have more `gambrel` and
the saltbox family but almost no `mansard` or `half-hipped`, and fewer heights;
Bamberg has the most `gambrel` (159) and `mansard` (97) but few heights or
colours; the Kremlin is mapped in more detail, but almost all of it as parts,
and with fewer kinds of roof.

`roof:shape` in the output, after outlines with parts are dropped:

| `roof:shape`      | features |
| ----------------- | -------: |
| (none)            |      746 |
| `gabled`          |      227 |
| `flat`            |      199 |
| `skillion`        |      175 |
| `hipped`          |      160 |
| `pyramidal`       |      108 |
| `dome`            |       20 |
| `mansard`         |       17 |
| `onion`           |       13 |
| `round`           |        9 |
| `many`            |        4 |
| `side_hipped`     |        4 |
| `half-hipped`     |        3 |
| `cone`            |        1 |
| `gambrel`         |        1 |
| `triple_skillion` |        1 |

Other tags: `building:levels` 899, `roof:material` 597, `roof:colour` 357,
`roof:height` 356, `height` 349, `name` 234, `building:colour` 182,
`roof:direction` 174, `roof:levels` 120, `min_height` 112, `building:material`
76, `roof:orientation` 43, `building:min_level` 8, `roof:angle` 3. `saltbox`,
`double_saltbox`, `quadruple_saltbox` and `round_gabled` do not occur here.

## How it is made

`generate.mjs` asks the Overpass API for every way and relation with `building`,
`building:part` or `type=building`, and everything they reference, in the box
plus 200 m. The query is pinned with `[date:"2026-10-01T00:00:00Z"]`, so it
returns the same data whenever it runs. The response is cached in
`.cache/overpass/` (gitignored) and parsed as JSON only; from the same response
the output is byte-identical.

It then applies
[Simple 3D Buildings](https://wiki.openstreetmap.org/wiki/Simple_3D_Buildings):

- Closed ways and `type=multipolygon` relations become polygons; multipolygon
  rings are joined from their member ways.
- A building outline is dropped when it has parts: the `outline` of a
  `type=building` relation with `part` members, or an outline that contains a
  part's interior point (the smallest one, when outlines nest). Parts do not
  inherit tags from their outline.
- `location=underground` and `building=underground` are left out.
- A feature is kept when the interior point of its building lies in the box (for
  a part, its outline's), so no building loses parts at the edge.

Feature ids are top-level and numeric, so feature-state works without
`promoteId`, which the native map lacks: a way keeps its OSM id, a relation gets
10^12 plus its id. Rings are rounded to 10^-7 degrees and wound as RFC 7946
requires.

## Properties

Every feature has `osm` (`way/123` or `relation/123`) and `kind` (`building` or
`part`), then these OSM tags, verbatim, where they are set: `building`,
`building:part`, `height`, `min_height`, `building:levels`,
`building:min_level`, `roof:shape`, `roof:height`, `roof:angle`, `roof:levels`,
`roof:direction`, `roof:orientation`, `roof:colour`, `building:colour`,
`roof:material`, `building:material` and `name`.

Style expressions cannot parse units, compass points or colour names, so the
values of these tags are also normalized, where they parse:

| Property             | From                 | Value                                                                   |
| -------------------- | -------------------- | ----------------------------------------------------------------------- |
| `height_m`           | `height`             | meters; `12`, `12.5`, `12,5`, `12 m`, `40 ft`, `40'` and `10'6"` parse  |
| `min_height_m`       | `min_height`         | meters, as `height_m`                                                   |
| `roof_height_m`      | `roof:height`        | meters, as `height_m`                                                   |
| `levels`             | `building:levels`    | number                                                                  |
| `min_level`          | `building:min_level` | number                                                                  |
| `roof_levels`        | `roof:levels`        | number                                                                  |
| `roof_angle_deg`     | `roof:angle`         | degrees, above 0 and below 90                                           |
| `roof_direction_deg` | `roof:direction`     | degrees clockwise from north in [0, 360); compass points `N` to `NNW`   |
| `roof_orientation`   | `roof:orientation`   | `along` or `across`                                                     |
| `building_color`     | `building:colour`    | `#rrggbb`, from hex (with or without `#`), CSS names, `sand`, `copper`… |
| `roof_color`         | `roof:colour`        | `#rrggbb`, as `building_color`                                          |

Of the values here, only `building:colour` and `roof:colour` needed it: `sand`
and `copper` are not CSS colours. Multiple values (`a;b`) use the first.

## The layer

`layer.json` reads the normalized properties:

- `building-roof-shape`: `roof:shape`, with other OSM values aliased: `pitched`,
  `gable` and `crosspitched` are `gabled`; `hip` and `side_hipped` are `hipped`;
  `half_hipped`, `side_half-hipped` and `hipped-and-gabled` are `half-hipped`;
  `pyramid` is `pyramidal`; `lean_to`, `monopitch`, `mono-pitched`, `shed` and
  `single` are `skillion`; `barrel` and `arched` are `round`; `spherical` and
  `half-dome` are `dome`; `conical` is `cone`. Anything else, and no tag, is
  `flat`.
- `building-roof-orientation` and `building-roof-direction`: from
  `roof:orientation` and `roof:direction`; -1 leaves the direction unset.
- `building-height`: `height`, else 3 m per level plus the roof height for a
  tagged non-flat roof. Without `building:levels` it assumes 2 levels, or one
  above `building:min_level`.
- `building-base`: `min_height`, else 3 m per `building:min_level`.
- `building-roof-height`: `roof:height`, else 3 m per `roof:levels`, else 2 m
  for `skillion`, 4 m for `pyramidal` and `dome`, 6 m for `onion` and `cone`,
  and 3 m for other shapes.
- `building-roof-angle`: `roof:angle`, unless `roof:height` is set. A total
  height from levels then still counts the default roof height above.
- `building-color` and `building-roof-color`: `building:colour` and
  `roof:colour`, else by `building:material` and `roof:material` (tiles, copper,
  slate, stone, metal, glass and others), else by shape: terracotta for pitched
  roofs, patinated copper for domes, onions and cones, grey for flat roofs, and
  light grey for buildings without `roof:shape`, so unmapped roofs stand out.

One part, `way/1046842474`, has `building:levels=3` and `building:min_level=3`,
so its base is its height and it draws nothing.

## Source options

`source.json` is `{"type": "geojson", "maxzoom": 15, "buffer": 256, "tolerance":
0}`:

- `maxzoom` 15: closer zooms reuse the zoom-15 tiles, whose footprints keep
  about 0.1 m precision here. At the default 18 the tiles are only 98 m wide
  here and most buildings would be cut by tile edges.
- `tolerance` 0: no simplification. maplibre-gl-js does not simplify tiles at
  the source's maxzoom, but MapLibre Native's geojson-vt-cpp does (it keeps only
  the points its simplification ranked above the zero tolerance, `p.z >
  sq_tolerance`), so with the default 0.375 Native draws a round footprint as an
  octagon and drops small parts, in core layers as in this one.
- `buffer` 256: half a tile, 390 m at zoom 15 and 50° N, more than the largest
  footprint (250 m). Every building is then whole in every tile it touches. The
  building layer draws footprints cut by a tile's buffer with flat roofs and no
  walls along the cut, so a smaller buffer would flatten the roofs of buildings
  near tile edges.
