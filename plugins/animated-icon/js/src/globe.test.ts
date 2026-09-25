import { describe, expect, it } from "vite-plus/test";

import { globeProjection, globeProjector, sphereAt } from "./globe.ts";

const WORLD = [0, 0, 1 / 8192, 1 / 8192] as const;
/** Tile units of the world tile 0/0/0 at a longitude and latitude. */
function tilePoint(lng: number, lat: number): [number, number] {
  const phi = (lat * Math.PI) / 180;
  const y = (1 - Math.log(Math.tan(Math.PI / 4 + phi / 2)) / Math.PI) / 2;
  return [(lng / 360 + 0.5) * 8192, y * 8192];
}

const IDENTITY = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];

describe("sphereAt", () => {
  it("puts longitude around y and latitude up, as projectToSphere does", () => {
    const at = (lng: number, lat: number) =>
      sphereAt(WORLD, ...tilePoint(lng, lat)).map((v) => +v.toFixed(9) + 0);
    expect(at(0, 0)).toEqual([0, 0, 1]);
    expect(at(90, 0)).toEqual([1, 0, 0]);
    expect(at(-90, 0)).toEqual([-1, 0, 0]);
    const h = +Math.SQRT1_2.toFixed(9);
    expect(at(0, 45)).toEqual([0, h, h]);
    expect(at(0, -45)).toEqual([0, -h, h]);
  });

  it("reads the tile's mercator offset and scale", () => {
    // Tile 1/1/0 is the north-east quarter: its (0, 8192) is lng 0, lat 0.
    expect(
      sphereAt([0.5, 0, 1 / 2 / 8192, 1 / 2 / 8192], 0, 8192).map(
        (v) => +v.toFixed(9) + 0,
      ),
    ).toEqual([0, 0, 1]);
  });
});

describe("globeProjector", () => {
  const fallback = [2, 0, 0, 0, 0, 3, 0, 0, 0, 0, 1, 0, 5, 7, 0, 1];
  const data = (transition: number) => ({
    mainMatrix: IDENTITY,
    fallbackMatrix: fallback,
    tileMercatorCoords: WORLD,
    clippingPlane: [0, 0, 1, 0] as [number, number, number, number],
    projectionTransition: transition,
  });

  it("is the tile matrix at transition 0", () => {
    expect(globeProjector(data(0))(10, 20)).toEqual([25, 67, 0, 1]);
  });

  it("is the sphere through mainMatrix at transition 1, with the horizon in z", () => {
    const project = globeProjector(data(1));
    expect(project(...tilePoint(0, 0)).map((v) => +v.toFixed(9) + 0)).toEqual([
      0, 0, 0, 1,
    ]);
    // On the horizon plane: z = w, still drawn.
    expect(project(...tilePoint(90, 0)).map((v) => +v.toFixed(9) + 0)).toEqual([
      1, 0, 1, 1,
    ]);
    // The far side clips.
    expect(project(...tilePoint(170, 0))[3]).toBe(-1);
  });

  it("blends x, y and w by the transition and z over its last 80%", () => {
    const [x, y] = tilePoint(0, 0);
    const flat = [2 * x + 5, 3 * y + 7, 0, 1];
    const got = globeProjector(data(0.5))(x, y);
    expect(got[0]).toBeCloseTo(flat[0]! / 2, 9);
    expect(got[1]).toBeCloseTo(flat[1]! / 2, 9);
    expect(got[2]).toBeCloseTo(0, 9);
    expect(got[3]).toBeCloseTo(1, 9);
    // lng 60: globe z = (1 - cos 60°) · w, weighted by (0.5 - 0.2) / 0.8.
    const z = globeProjector(data(0.5))(...tilePoint(60, 0))[2];
    expect(z).toBeCloseTo(0.5 * 0.375, 9);
  });

  it("copies what it keeps", () => {
    const main = Float32Array.from(IDENTITY);
    const kept = globeProjection({ ...data(1), mainMatrix: main });
    main[0] = 9;
    expect(kept.mainMatrix[0]).toBe(1);
  });
});
