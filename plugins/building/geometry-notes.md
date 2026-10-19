# Roof geometry follow-up

This work builds on [PR #5](https://github.com/sargunv/maplibre-plugins/pull/5),
which added equal-speed skeletons for hipped and mansard roofs.

## Gable ends and arms

Gabled and gambrel roofs now use a zero/one-speed wavefront on footprints with
recognizable arms. The ordinary skeleton identifies terminal triangular hips;
their eaves stay stationary in a second skeleton. The adjacent faces meet above
the original eave, and the wall top follows that boundary. Gambrel applies the
same slope break as mansard. Both twins use the same event order and face math.

The end rule is conservative: both end corners must be convex, the neighboring
sides must point roughly opposite (dot product at most -0.8 after
normalization), and the complete hip must be triangular. One hip may span
several event faces. Collinear but separate ends, as on a U, are tested
separately. L, T and U fixtures assert two, three and two ends respectively, and
check coverage and valleys. Near-coincident events on thin rotated gables are
merged at the existing wall tolerance, 1/1024 tile unit, to avoid float32 wall
slivers.

The automatic rule ignores global orientation and direction on arms and
courtyards. A single global ridge axis cannot follow both arms of an L.
Footprints without holes that fill at least 98% of their bounding rectangle keep
the frame model, including direction and orientation. This admits grid rounding
of rectangles without changing their established output. Existing rectangle,
rotated rectangle, square and full-vertex rectangle fixtures remain unchanged.
Other unholed footprints with no qualifying end also keep the frame.

Moving unweighted skeleton apexes was rejected because shared junctions would
need to be repaired after the move. Rectangle decomposition would introduce a
second set of rules for overlaps, valleys and holes. Stationary edges keep those
contacts in the existing event solver; the preliminary skeleton costs time but
makes end selection depend on the whole footprint rather than just edge length.

Half-hipped remains a frame roof. Its ends would need to start moving above a
chosen height, with a decision about local versus global break height on arms of
unequal width. A constant nonzero weight changes the end's slope, not its
vertical lower gable. Saltbox and the flat-top saltbox variants also retain
their frame profiles: asymmetry and plateau termination need explicit rules at
arm junctions. This round partially closes the gable-family work, concentrating
on gabled and gambrel rather than changing the meaning of the other shapes.

## Courtyards and mansard

Gabled and gambrel courtyards use the skeleton. Hole edges always move; a closed
wing with no terminal hip has a continuous hipped ridge. This is an inferred
roof, not evidence of the building's actual ridge layout.

All other frame shapes now use the existing hole-aware triangulator before
clipping triangles to their facets. Courtyard walls follow the height field.
Their ridges can end at a courtyard wall; this is preferable to silently drawing
flat, although it does not infer separate roofs for individual wings. Pyramidal,
cone, dome and onion stay flat with holes: shrinking their rings toward one
center does not define a suitable courtyard roof.

Mansard is unchanged after inspecting the contact sheet and native renders, the
[OSM wiki drawing](https://wiki.openstreetmap.org/wiki/Key:roof:shape), and
OSM2World's `MansardRoof` and `RoofWithRidge` sources. Both profiles break at
two-thirds roof height after one-third of the side run. OSM2World places the
ridge ends one-third of the end width inward, capped at 0.4 times the ridge
length; the skeleton uses equal inward distances on all eaves. That changes the
hips, but retains the steep lower and shallow upper faces that distinguish a
mansard. A flat top would change that profile and is unnecessary for
recognition.

## Cost and fallbacks

`node plugins/building/js/scripts/roof-benchmark.ts` measures whole polygons
projected and rounded to the zoom-16 tile grid, without tile cuts. The tagged
pass uses each `roof:shape` with default orientation and direction; forced
passes apply one shape to every polygon. Counts are polygons, not source tile
copies. Times below are milliseconds for the entire dataset, median of three
passes after one warmup on Node 24.21.0, macOS arm64. They vary with JIT and
machine load. The baseline is PR #5's head, `b328f0a`.

| Dataset and shape         | Polygons | Flat before / after | Time before / after |
| ------------------------- | -------: | ------------------: | ------------------: |
| Bamberg, tagged non-flat  |    1,319 |               3 / 2 |             33 / 71 |
| Bamberg, forced gabled    |    3,091 |              14 / 0 |            30 / 212 |
| Bamberg, forced gambrel   |    3,091 |              14 / 0 |            50 / 211 |
| Bamberg, forced hipped    |    3,091 |               0 / 0 |           132 / 138 |
| Bamberg, forced mansard   |    3,091 |               0 / 0 |           130 / 133 |
| Invalides, tagged         |        3 |               0 / 0 |             44 / 42 |
| Invalides, forced gabled  |        3 |               3 / 0 |           0.68 / 86 |
| Invalides, forced gambrel |        3 |               3 / 0 |           0.46 / 74 |

No footprint in these passes produced an empty mesh. The faster Invalides
baseline for gabled/gambrel only triangulated flat roofs. These are geometry
timings, not web frame times or native worker timings, and they do not measure
source clipping. The tagged pass includes unsupported shape strings, which also
count as flat. See the README for the separate tile-copy measurements.

Rounded regular polygons of radius 2,000 tile units take about 5, 13 and 35 ms
at 64, 128 and 192 vertices after this change (baseline 5, 12 and 25 ms). At
1,000 vertices the cap returns immediately; this is a fallback timing, not a
1,000-vertex skeleton benchmark. There is no basis for raising the 192-vertex
cap. A queue with local event recomputation and indexed split candidates would
be a separate algorithmic change. A worker would move the web work off the main
thread but not reduce it. Simplifying only the roof would separate its eaves
from the walls, so it is not used here.

## Cut copies and validation

Cut copies still draw walls and a lid at the eaves. Complete geometry or
precomputed roof data is needed to improve that; bounds alone cannot reconstruct
a skeleton. The [API gap ledger](../../docs/plugin-api-gaps.md) records the
GeoJSON, vector-tile and cross-worker tradeoffs. No host patch or FFI rebuild is
part of this change.

Shared fixtures now include T arms, additional stationary-edge skeleton cases,
and Invalides with gabled/gambrel. A paired unit test covers the thin-gable wall
regression. The shapes gallery adds T, U and courtyard rows. Native render cases
include close views of L/T/U and courtyard gabled/gambrel roofs. The contact
sheet shows all shapes on the same footprints. Rectangle fixtures are unchanged.

Fuzz seed 1, 300 iterations, reports zero failing layouts. Its separate touching
courtyard triangulations fail on 7 of 3,000 cases, exactly as on the baseline;
these are the already-documented chains of touching holes. The triangulator is
unchanged. Very thin roof triangles retain the existing float32 limitation:
rounding after tile translation can collapse or flip a subpixel strip. Removing
such strips indiscriminately creates unmatched long edges, so this change only
merges wall stops and keeps the existing roof triangulation. Tests assert
coverage and stationarity independently of the generated fixture summaries; the
twins also check normals, closed surfaces, planarity and translated copies.
