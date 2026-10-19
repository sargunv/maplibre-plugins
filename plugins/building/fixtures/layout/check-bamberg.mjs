// Replay all roof graphs with source quantization, independently of graph rounding.
// node plugins/building/fixtures/layout/check-bamberg.mjs
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { NO_CUTS } from "../../js/src/footprint.ts";
import { BuildingLayout } from "../../js/src/layout.ts";

const features = JSON.parse(
  readFileSync(
    new URL("../../examples/osm/buildings.geojson", import.meta.url),
    "utf8",
  ),
).features.filter((f) => f.properties.roof_lines);
assert.equal(features.length, 97);
const tile = { z: 16, x: 34748, y: 22254 };
const expected = [36906271, 36906272, 36941239, 766466977];
for (const sourceExtent of [8192, 4096]) {
  const scale = sourceExtent * 2 ** tile.z;
  const project = ([lon, lat]) => {
    const sin = Math.sin((lat * Math.PI) / 180);
    return {
      x:
        ((Math.round((lon / 360 + 0.5) * scale) - tile.x * sourceExtent) *
          8192) /
        sourceExtent,
      y:
        ((Math.round(
          (0.5 - Math.log((1 + sin) / (1 - sin)) / (4 * Math.PI)) * scale,
        ) -
          tile.y * sourceExtent) *
          8192) /
        sourceExtent,
    };
  };
  const fallbacks = [];
  for (const f of features) {
    const layout = new BuildingLayout(8192, NO_CUTS, tile);
    layout.addFeature(
      f.geometry.coordinates.map((ring) => ring.map(project).reverse()),
      0,
      {
        shape: "complex",
        lines: JSON.stringify(f.properties.roof_lines),
      },
    );
    if (!layout.vertexCount || layout.vertex(0).run === 0) fallbacks.push(f.id);
  }
  console.log(
    `${sourceExtent}→8192: ${fallbacks.length}/${features.length} flat fallbacks: ${fallbacks.join(", ")}`,
  );
  assert.deepEqual(fallbacks, expected);
}
