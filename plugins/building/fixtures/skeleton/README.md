# Straight-skeleton regression footprints

`cases.json` contains synthetic event regressions. The layout generator runs
each through both hipped and mansard roofs for Zig/TypeScript parity. Direct
skeleton tests also check analytic runs, unit slopes, sampled coverage without
overlaps, and invariance under translation, rotation and scaling.

`invalides.geojson` contains the three courtyard wings of Hotel des Invalides,
Paris: OpenStreetMap relations 3311813, 3311814 and 3311815, from the 2026-10-01
snapshot. Each is tagged `roof:shape=hipped`; the footprints contain three, five
and two courtyards. The layout fixture generator projects these footprints onto
the zoom-15 tile grid and exercises both hipped and mansard roofs. The
JavaScript and Zig tests read the resulting shared layout fixture.

Data copyright OpenStreetMap contributors, available under the
[Open Database License 1.0](https://opendatacommons.org/licenses/odbl/1-0/).
Individual contents are available under the
[Database Contents License](https://opendatacommons.org/licenses/dbcl/1-0/). See
[OpenStreetMap's copyright page](https://www.openstreetmap.org/copyright). The
extract retains building and roof tags and normalized numeric properties from
the OSM demo generator.
