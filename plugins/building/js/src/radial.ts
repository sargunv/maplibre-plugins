// Inscribed circles for radial roofs; ../../native/src/radial.zig is its twin.
import type { Point, Polygon } from "./footprint.ts";

/** Signed distance to the closest boundary, including courtyard edges. */
function distance(p: Point, rings: readonly (readonly Point[])[]): number {
  let inside = false;
  let nearest = Infinity;
  for (const ring of rings) {
    for (let i = 0; i < ring.length; i++) {
      const a = ring[i]!;
      const b = ring[(i + 1) % ring.length]!;
      if (
        a.y > p.y !== b.y > p.y &&
        p.x < a.x + ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y)
      )
        inside = !inside;
      const dx = b.x - a.x;
      const dy = b.y - a.y;
      const t = Math.max(
        0,
        Math.min(
          1,
          ((p.x - a.x) * dx + (p.y - a.y) * dy) / (dx * dx + dy * dy),
        ),
      );
      const x = p.x - (a.x + t * dx);
      const y = p.y - (a.y + t * dy);
      nearest = Math.min(nearest, x * x + y * y);
    }
  }
  return (inside ? 1 : -1) * Math.sqrt(nearest);
}

/** Keep existing towers, including the rounded tile-grid copies of regular polygons. */
export function roundFootprint(
  outer: readonly Point[],
  center: Point,
): boolean {
  if (outer.length < 12) return false;
  let min = Infinity;
  let max = 0;
  for (const p of outer) {
    const dx = p.x - center.x;
    const dy = p.y - center.y;
    const r = dx * dx + dy * dy;
    min = Math.min(min, r);
    max = Math.max(max, r);
  }
  return min >= 0.95 * 0.95 * max;
}

/** Polylabel's distance bound, searched depth-first in the footprint's local frame. */
export function inscribedCircle(
  polygon: Polygon,
  seed: Point,
  limit: number,
): { center: Point; run: number; base: Point[] } | null {
  const rings = [polygon.outer, ...polygon.holes];
  let best = seed;
  let radius = distance(best, rings);
  let minX = Infinity,
    minY = Infinity,
    maxX = -Infinity,
    maxY = -Infinity;
  for (const p of polygon.outer) {
    minX = Math.min(minX, p.x);
    minY = Math.min(minY, p.y);
    maxX = Math.max(maxX, p.x);
    maxY = Math.max(maxY, p.y);
  }
  const tolerance = Math.max(0.5, limit / 128);
  const cell = (x: number, y: number, half: number) => {
    const d = distance({ x, y }, rings);
    return { x, y, half, d, bound: d + half * Math.sqrt(2) };
  };
  const pending = [
    cell(
      (minX + maxX) / 2,
      (minY + maxY) / 2,
      Math.max(maxX - minX, maxY - minY) / 2,
    ),
  ];
  while (pending.length && radius + tolerance < limit) {
    const c = pending.pop()!;
    if (c.d > radius) {
      best = { x: c.x, y: c.y };
      radius = c.d;
    }
    if (c.bound <= radius + tolerance) continue;
    const h = c.half / 2;
    const children = [
      cell(c.x - h, c.y - h, h),
      cell(c.x + h, c.y - h, h),
      cell(c.x - h, c.y + h, h),
      cell(c.x + h, c.y + h, h),
    ];
    children.sort((a, b) => a.bound - b.bound || a.x - b.x || a.y - b.y);
    pending.push(...children);
  }
  // Keep a half-unit gap so the terrace hole never touches another boundary.
  const run = radius - 0.5;
  if (run < 1) return null;
  const base = Array.from({ length: 32 }, (_, i) => {
    const angle = (2 * Math.PI * i) / 32;
    return {
      x: best.x + run * Math.cos(angle),
      y: best.y + run * Math.sin(angle),
    };
  });
  return { center: best, run, base };
}
