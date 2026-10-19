import { readFileSync } from "node:fs";

import { describe, expect, it } from "vite-plus/test";

import { cross, type Point, signedArea2 } from "./footprint.ts";
import { straightSkeleton, type Skeleton } from "./skeleton.ts";

interface Case {
  name: string;
  run?: number;
  rings: [number, number][][];
}
const cases: Case[] = JSON.parse(
  readFileSync(
    new URL("../../fixtures/skeleton/cases.json", import.meta.url),
    "utf8",
  ),
);
const ringsOf = (entry: Case): Point[][] =>
  entry.rings.map((r) => r.map(([x, y]) => ({ x, y })));
const skeletonOf = (rings: Point[][]): Skeleton => {
  const result = straightSkeleton({ outer: rings[0]!, holes: rings.slice(1) });
  expect(result).not.toBeNull();
  return result!;
};
function inside(p: Point, ring: Point[]): boolean {
  let result = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const a = ring[i]!,
      b = ring[j]!;
    if (
      a.y > p.y !== b.y > p.y &&
      p.x < ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y) + a.x
    )
      result = !result;
  }
  return result;
}
function checkCoverage(rings: Point[][], skeleton: Skeleton): void {
  const area = rings.reduce((sum, r) => sum + signedArea2(r), 0);
  expect(
    skeleton.faces.reduce((sum, f) => sum + signedArea2(f.points), 0),
  ).toBeCloseTo(area, 5);
  for (const face of skeleton.faces) {
    expect(Math.hypot(face.normal.x, face.normal.y)).toBeCloseTo(1, 10);
    const a = face.points[0]!;
    for (const p of face.points) {
      expect(p.time).toBeGreaterThanOrEqual(0);
      expect(p.time).toBeLessThanOrEqual(skeleton.run + 1e-8);
      expect(
        a.time + face.normal.x * (p.x - a.x) + face.normal.y * (p.y - a.y),
      ).toBeCloseTo(p.time, 7);
    }
  }
  const all = rings.flat();
  const minX = Math.min(...all.map((p) => p.x)),
    minY = Math.min(...all.map((p) => p.y));
  const width = Math.max(...all.map((p) => p.x)) - minX,
    height = Math.max(...all.map((p) => p.y)) - minY;
  // Offset samples avoid symmetric ridges; skip any that land on a face boundary.
  for (let x = 0; x < 29; x++)
    for (let y = 0; y < 29; y++) {
      const p = {
        x: minX + ((x + 0.371) * width) / 29,
        y: minY + ((y + 0.613) * height) / 29,
      };
      if (
        skeleton.faces.some((f) =>
          f.points.some(
            (a, i) =>
              Math.abs(cross(a, f.points[(i + 1) % f.points.length]!, p)) <
              1e-7,
          ),
        )
      )
        continue;
      const expected =
        inside(p, rings[0]!) && !rings.slice(1).some((r) => inside(p, r));
      expect(
        skeleton.faces.filter((f) => inside(p, f.points)).length,
        `coverage at ${p.x},${p.y}`,
      ).toBe(expected ? 1 : 0);
    }
}
describe("straight skeleton", () => {
  for (const entry of cases)
    it(entry.name, () => {
      const rings = ringsOf(entry),
        skeleton = skeletonOf(rings);
      if (entry.run !== undefined)
        expect(skeleton.run).toBeCloseTo(entry.run, 8);
      checkCoverage(rings, skeleton);
      const angle = 0.37,
        scale = 3.7;
      const transformed = rings.map((r) =>
        r.map((p) => ({
          x: 713 + scale * (p.x * Math.cos(angle) - p.y * Math.sin(angle)),
          y: -133 + scale * (p.x * Math.sin(angle) + p.y * Math.cos(angle)),
        })),
      );
      const moved = skeletonOf(transformed);
      expect(moved.run).toBeCloseTo(skeleton.run * scale, 7);
      checkCoverage(transformed, moved);
    });
  it("covers deterministic irregular footprints with courtyards", () => {
    let seed = 93251;
    const random = (): number =>
      (seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 2 ** 32;
    for (let i = 0; i < 40; i++) {
      const count = 7 + Math.floor(random() * 15);
      const outer = Array.from({ length: count }, (_, j) => {
        const angle = (2 * Math.PI * j) / count,
          r = 200 + random() * 100;
        return { x: r * Math.cos(angle), y: r * Math.sin(angle) };
      });
      const hole = [
        { x: -30, y: -50 },
        { x: -30, y: 50 },
        { x: 60, y: 50 },
        { x: 60, y: -50 },
      ];
      const rings = [outer, hole];
      checkCoverage(rings, skeletonOf(rings));
    }
  });
  it("rejects degenerate input without emitting partial roofs", () => {
    expect(
      straightSkeleton({
        outer: [
          { x: 0, y: 0 },
          { x: 10, y: 0 },
          { x: 20, y: 0 },
        ],
        holes: [],
      }),
    ).toBeNull();
  });
});
