import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vite-plus/test";

import { prismHit, translationInTileUnits } from "./query.ts";

/** A column-major perspective camera looking down at the tile from above. */
function topDown(): Float64Array {
  // x, y in tile units (0..8192) to [-1, 1], z in meters up toward the
  // camera; w = 1 - z / 1000, so taller points grow away from the center.
  const s = 2 / 8192;
  return Float64Array.from([
    s,
    0,
    0,
    0,
    0,
    -s,
    0,
    0,
    0,
    0,
    -1e-2,
    -1e-3,
    -1,
    1,
    0.5,
    1,
  ]);
}

/** A camera tilted so walls facing +y (south) are visible. */
function tilted(): Float64Array {
  const s = 2 / 8192;
  return Float64Array.from([
    s,
    0,
    0,
    0,
    0,
    -s,
    0,
    0,
    0,
    0.02,
    -1e-4,
    0,
    -1,
    1,
    0.5,
    1,
  ]);
}

const square = [
  [
    { x: 4000, y: 4000 },
    { x: 4200, y: 4000 },
    { x: 4200, y: 4200 },
    { x: 4000, y: 4200 },
  ],
];

function ndc(m: Float64Array, x: number, y: number, z: number) {
  const w = m[3]! * x + m[7]! * y + m[11]! * z + m[15]!;
  return {
    x: (m[0]! * x + m[4]! * y + m[8]! * z + m[12]!) / w,
    y: (m[1]! * x + m[5]! * y + m[9]! * z + m[13]!) / w,
  };
}

describe("prismHit", () => {
  it("hits the top polygon and misses outside it", () => {
    const m = topDown();
    expect(prismHit(square, 0, 20, m, ndc(m, 4100, 4100, 20))).not.toBeNull();
    expect(prismHit(square, 0, 20, m, ndc(m, 4300, 4100, 0))).toBeNull();
  });

  it("hits a wall the top does not cover", () => {
    const m = tilted();
    // Halfway up the south wall: below the projected top, above the base.
    const q = ndc(m, 4100, 4200, 10);
    const top = ndc(m, 4100, 4200, 20);
    expect(q.y).not.toBeCloseTo(top.y, 6);
    expect(prismHit(square, 0, 20, m, q)).not.toBeNull();
    // A flat building has no wall there.
    expect(prismHit(square, 0, 0, m, q)).toBeNull();
  });

  it("orders hits by depth and clamps heights at 0", () => {
    const m = topDown();
    const q = ndc(m, 4100, 4100, 0);
    const low = prismHit(square, 0, 5, m, q)!;
    const high = prismHit(square, 0, 50, m, q)!;
    expect(high).toBeLessThan(low);
    expect(prismHit(square, -10, -5, m, q)).toBe(prismHit(square, 0, 0, m, q));
  });

  it("collapses a building whose base is above its height to the base", () => {
    const m = tilted();
    // Halfway up a 10 to 20 m prism: drawn as a flat roof at 20 m, so no hit.
    const q = ndc(m, 4100, 4200, 15);
    expect(prismHit(square, 20, 10, m, q)).toBeNull();
    expect(prismHit(square, 10, 20, m, q)).not.toBeNull();
    const top = ndc(m, 4100, 4100, 20);
    expect(prismHit(square, 20, 10, m, top)).toBe(
      prismHit(square, 20, 20, m, top),
    );
  });

  it("takes the top's depth from a ring that is not degenerate", () => {
    const m = topDown();
    const q = ndc(m, 4100, 4100, 20);
    const sliver = [
      { x: 0, y: 0 },
      { x: 10, y: 0 },
      { x: 20, y: 0 },
    ];
    expect(prismHit([sliver, ...square], 0, 20, m, q)).toBe(
      prismHit(square, 0, 20, m, q),
    );
  });

  it("never hits a face behind the camera", () => {
    const m = topDown();
    const behind = Float64Array.from(m);
    behind[15] = -1;
    behind[11] = 0;
    expect(prismHit(square, 0, 20, behind, { x: 0, y: 0 })).toBeNull();
  });
});

describe("translationInTileUnits", () => {
  it("scales pixels to tile units and turns a viewport anchor by the bearing", () => {
    expect(translationInTileUnits([50, 10], false, 1, 4)).toEqual([200, 40]);
    // At a bearing of 90° the map's east points down the screen, so a
    // viewport translation to the right moves the building south (+y).
    const [x, y] = translationInTileUnits([50, 0], true, Math.PI / 2, 4);
    expect(x).toBeCloseTo(0, 9);
    expect(y).toBeCloseTo(200, 9);
  });

  it("moves the prism, as it is drawn", () => {
    const m = topDown();
    const t: [number, number] = [200, 0];
    expect(prismHit(square, 0, 20, m, ndc(m, 4300, 4100, 0), t)).not.toBeNull();
    expect(prismHit(square, 0, 20, m, ndc(m, 4100, 4100, 0), t)).toBeNull();
    // The translated top, where the building is drawn, is hit too.
    expect(
      prismHit(square, 0, 20, m, ndc(m, 4390, 4100, 20), t),
    ).not.toBeNull();
  });
});

/** ../../fixtures/query/prism.json, shared with the native twin. */
interface QueryFixture {
  cases: Array<{
    name: string;
    matrix: number[];
    rings: [number, number][][];
    base: number;
    height: number;
    translate: [number, number];
    translateAnchor: "map" | "viewport";
    bearing: number;
    pixelsToTileUnits: number;
    grid: { x0: number; y0: number; dx: number; dy: number };
    hits: string[];
  }>;
}

const fixture = JSON.parse(
  readFileSync(
    join(
      dirname(fileURLToPath(import.meta.url)),
      "../../fixtures/query/prism.json",
    ),
    "utf8",
  ),
) as QueryFixture;

describe("fixtures/query/prism.json", () => {
  for (const c of fixture.cases) {
    it(c.name, () => {
      const m = Float64Array.from(c.matrix);
      const rings = c.rings.map((ring) => ring.map(([x, y]) => ({ x, y })));
      const t = translationInTileUnits(
        c.translate,
        c.translateAnchor === "viewport",
        c.bearing,
        c.pixelsToTileUnits,
      );
      const rows = c.hits.map((row, r) =>
        Array.from({ length: row.length }, (_, k) => k)
          .map((k) => {
            const q = ndc(
              m,
              c.grid.x0 + k * c.grid.dx,
              c.grid.y0 + r * c.grid.dy,
              0,
            );
            return prismHit(rings, c.base, c.height, m, q, t) === null
              ? "."
              : "#";
          })
          .join(""),
      );
      expect(rows).toEqual(c.hits);
    });
  }
});
