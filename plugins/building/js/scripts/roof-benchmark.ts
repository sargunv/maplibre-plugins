// Whole footprints at zoom 16, rounded to the tile grid, without buffer cuts.
// Run before and after geometry changes with the same Node version.
import { readFileSync } from "node:fs";

import { NO_CUTS, signedArea2, type Point } from "../src/footprint.ts";
import { BuildingLayout } from "../src/layout.ts";
import { straightSkeleton } from "../src/skeleton.ts";

for (const name of ["examples/osm/buildings", "fixtures/skeleton/invalides"]) {
  const data = JSON.parse(
    readFileSync(new URL(`../../${name}.geojson`, import.meta.url), "utf8"),
  );
  const cases: { rings: Point[][]; shape: string }[] = [];
  for (const feature of data.features) {
    const polygons =
      feature.geometry.type === "Polygon"
        ? [feature.geometry.coordinates]
        : feature.geometry.coordinates;
    for (const polygon of polygons) {
      const projected = polygon.map((ring: number[][]) =>
        ring.map(([lon, lat]) => ({
          x: Math.round(((lon! + 180) / 360) * 8192 * 2 ** 16),
          y: Math.round(
            ((1 - Math.asinh(Math.tan((lat! * Math.PI) / 180)) / Math.PI) / 2) *
              8192 *
              2 ** 16,
          ),
        })),
      );
      const origin = projected[0][0];
      const rings = projected.map((ring: Point[], i: number) => {
        const local = ring.map((p) => ({
          x: p.x - origin.x + 3000,
          y: p.y - origin.y + 3000,
        }));
        if (signedArea2(local) > 0 !== (i === 0)) local.reverse();
        return local;
      });
      cases.push({ rings, shape: feature.properties["roof:shape"] ?? "flat" });
    }
  }
  for (const override of [
    null,
    "gabled",
    "gambrel",
    "hipped",
    "mansard",
    "cone",
    "dome",
    "onion",
  ]) {
    const times: number[] = [];
    let flat = 0,
      empty = 0,
      count = 0;
    for (let pass = 0; pass < 4; pass++) {
      flat = 0;
      empty = 0;
      count = 0;
      const start = performance.now();
      for (const entry of cases) {
        const shape = override ?? entry.shape;
        if (shape === "flat" || shape === "many") continue;
        count++;
        const layout = new BuildingLayout(8192, NO_CUTS);
        layout.addFeature(entry.rings, 0, { shape });
        if (!layout.vertexCount) empty++;
        else if (layout.vertex(0).run === 0) flat++;
      }
      if (pass) times.push(performance.now() - start);
    }
    times.sort((a, b) => a - b);
    console.log(
      JSON.stringify({
        dataset: name,
        shape: override ?? "tagged",
        count,
        flat,
        empty,
        medianMs: times[1],
      }),
    );
  }
}
for (const n of [64, 128, 192, 1000]) {
  const outer = Array.from({ length: n }, (_, i) => ({
    x: Math.round(2000 * Math.cos((i * 2 * Math.PI) / n)),
    y: Math.round(2000 * Math.sin((i * 2 * Math.PI) / n)),
  }));
  const times: number[] = [];
  for (let i = 0; i < 6; i++) {
    const start = performance.now();
    straightSkeleton({ outer, holes: [] });
    if (i) times.push(performance.now() - start);
  }
  times.sort((a, b) => a - b);
  console.log(JSON.stringify({ vertices: n, medianMs: times[2] }));
}
