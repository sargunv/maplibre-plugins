// Dense interior graphs exercise constrained insertion independently of the
// roof surface closure check. Every case must recover its segment, cover the
// square exactly, and keep positive triangles. No flat fallback is permitted.
// node plugins/building/js/scripts/graph-fuzz.ts [seed] [iterations]
import { complexRoof, partitionRoofGraph } from "../src/complex.ts";
import { cross, type Polygon } from "../src/footprint.ts";

let state = Number(process.argv[2] ?? 1) >>> 0;
const seed = state,
  iterations = Number(process.argv[3] ?? 1000);
const random = () => {
  state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
  return state / 2 ** 32;
};
const tile = { z: 16, x: 34748, y: 22254 },
  extent = 8192,
  scale = extent * 2 ** tile.z;
const polygon: Polygon = {
  outer: [
    { x: 0, y: 0 },
    { x: 1000, y: 0 },
    { x: 1000, y: 1000 },
    { x: 0, y: 1000 },
  ],
  holes: [],
  cut: false,
};
let failures = 0,
  maximumMs = 0;
for (let i = 0; i < iterations; i++) {
  const positions = Array.from({ length: 188 }, () => ({
    x: 1 + Math.floor(random() * 998),
    y: 1 + Math.floor(random() * 998),
  }));
  const vertices = positions.map(({ x, y }) => [
    ((x + tile.x * extent) / scale) * 360 - 180,
    (Math.atan(Math.sinh(Math.PI * (1 - (2 * (y + tile.y * extent)) / scale))) *
      180) /
      Math.PI,
    1,
  ]);
  const text = JSON.stringify({ vertices, edges: [[0, 187]] });
  const start = performance.now();
  const graph = partitionRoofGraph([polygon], text, tile, extent)[0]!;
  const roof = complexRoof(polygon, graph, { x: 0, y: 0 }, 500);
  maximumMs = Math.max(maximumMs, performance.now() - start);
  let area = 0,
    valid = !!roof;
  const meshEdges = new Set<string>();
  const key = (a: number, b: number) => (a < b ? `${a},${b}` : `${b},${a}`);
  if (roof) {
    for (let t = 0; t < roof.triangles.length; t += 3) {
      const tri = roof.triangles.slice(t, t + 3);
      const a = cross(
        roof.points[tri[0]!]!,
        roof.points[tri[1]!]!,
        roof.points[tri[2]!]!,
      );
      if (a <= 0) valid = false;
      area += a;
      for (let k = 0; k < 3; k++)
        meshEdges.add(key(tri[k]!, tri[(k + 1) % 3]!));
    }
    const a = positions[0]!,
      b = positions[187]!;
    const stops = roof.points
      .map((p, id) => ({
        p,
        id,
        t: (p.x - a.x) * (b.x - a.x) + (p.y - a.y) * (b.y - a.y),
      }))
      .filter(
        ({ p, t }) =>
          (a.x !== b.x || a.y !== b.y) &&
          cross(a, b, p) === 0 &&
          t >= 0 &&
          t <= (b.x - a.x) ** 2 + (b.y - a.y) ** 2,
      )
      .sort((a, b) => a.t - b.t);
    for (let k = 1; k < stops.length; k++)
      if (!meshEdges.has(key(stops[k - 1]!.id, stops[k]!.id))) valid = false;
  }
  if (!valid || area !== 2000000) {
    failures++;
    if (failures <= 3)
      console.log(JSON.stringify({ i, valid, area, graph: JSON.parse(text) }));
  }
}
console.log(
  JSON.stringify({ seed, iterations, vertices: 188, failures, maximumMs }),
);
process.exitCode = failures ? 1 : 0;
