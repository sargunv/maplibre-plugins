// Equal-speed straight skeleton, including courtyard boundaries. The wavefront
// keeps the building on its left: outer rings shrink and holes expand. At an
// event, split its boundary at all contacts and cancel opposing segments before
// reconnecting it. This handles simultaneous collapses and hole/outer merges
// together, without depending on an arbitrary order of pairwise surgeries.
// ../../native/src/skeleton.zig is the matching implementation.
import { cross, type Point, type Polygon, signedArea2 } from "./footprint.ts";

export interface SkeletonPoint extends Point {
  time: number;
}

export interface SkeletonFace {
  points: SkeletonPoint[];
  /** Gradient of distance from the original eave. */
  normal: Point;
}

export interface Skeleton {
  faces: SkeletonFace[];
  run: number;
}

interface Edge {
  normal: Point;
  start: SkeletonPoint;
  end: SkeletonPoint;
}

interface Vertex extends Point {
  velocity: Point;
}

interface Loop {
  edges: Edge[];
  vertices: Vertex[];
}

interface Segment {
  a: number;
  b: number;
  edge: Edge;
  parent: number;
}

// All calculations use a footprint normalized to unit extent. Contact tests
// tolerate rounding in event times; they never move an event forward in time.
const CONTACT = 1e-9;
const PARALLEL = 1e-12;

function dot(a: Point, b: Point): number {
  return a.x * b.x + a.y * b.y;
}

function velocity(a: Point, b: Point): Point | null {
  const det = a.x * b.y - a.y * b.x;
  if (Math.abs(det) <= PARALLEL) return null;
  return { x: (b.y - a.y) / det, y: (a.x - b.x) / det };
}

function at(v: Vertex, dt: number): Point {
  return { x: v.x + v.velocity.x * dt, y: v.y + v.velocity.y * dt };
}

function nextEvent(loops: Loop[]): number {
  let time = Infinity;
  for (const loop of loops) {
    const count = loop.edges.length;
    for (let i = 0; i < count; i++) {
      const v = loop.vertices[i]!;
      const w = loop.vertices[(i + 1) % count]!;
      const normal = loop.edges[i]!.normal;
      const length = normal.y * (w.x - v.x) - normal.x * (w.y - v.y);
      const rate =
        normal.y * (w.velocity.x - v.velocity.x) -
        normal.x * (w.velocity.y - v.velocity.y);
      if (rate < -PARALLEL) {
        const dt = -length / rate;
        if (dt > CONTACT && dt < time) time = dt;
      }
      for (const other of loops) {
        for (let j = 0; j < other.edges.length; j++) {
          if (other === loop && (j === i || (j + 1) % count === i)) continue;
          const edge = other.edges[j]!;
          const a = other.vertices[j]!;
          const b = other.vertices[(j + 1) % other.edges.length]!;
          const gap = edge.normal.x * (v.x - a.x) + edge.normal.y * (v.y - a.y);
          const speed = dot(edge.normal, v.velocity) - 1;
          if (gap <= CONTACT || speed >= -PARALLEL) continue;
          const dt = -gap / speed;
          if (dt <= CONTACT || dt > time + CONTACT) continue;
          const p = at(v, dt);
          const q = at(a, dt);
          const r = at(b, dt);
          const u = edge.normal.y * (p.x - q.x) - edge.normal.x * (p.y - q.y);
          const length =
            edge.normal.y * (r.x - q.x) - edge.normal.x * (r.y - q.y);
          if (u >= -CONTACT && u <= length + CONTACT) time = Math.min(time, dt);
        }
      }
    }
  }
  return time;
}

/** Reconnect all contacts at once; the resulting loops still have interior left. */
function advance(
  loops: Loop[],
  dt: number,
  time: number,
  faces: SkeletonFace[],
): Loop[] | null {
  const points: Point[] = [];
  const pointId = (p: Point): number => {
    const found = points.findIndex(
      (q) => Math.abs(p.x - q.x) <= CONTACT && Math.abs(p.y - q.y) <= CONTACT,
    );
    if (found >= 0) return found;
    points.push(p);
    return points.length - 1;
  };
  const raw: Segment[] = [];
  const old: { edge: Edge; a: Point; b: Point; prev: number; next: number }[] =
    [];
  for (const loop of loops) {
    const base = old.length;
    const count = loop.edges.length;
    const ids = loop.vertices.map((v) => pointId(at(v, dt)));
    for (let i = 0; i < count; i++) {
      const a = ids[i]!;
      const b = ids[(i + 1) % count]!;
      const edge = loop.edges[i]!;
      raw.push({ a, b, edge, parent: old.length });
      old.push({
        edge,
        a: points[a]!,
        b: points[b]!,
        prev: base + ((i + count - 1) % count),
        next: base + ((i + 1) % count),
      });
    }
  }
  const segments: Segment[] = [];
  for (const segment of raw) {
    if (segment.a === segment.b) continue;
    const a = points[segment.a]!;
    const b = points[segment.b]!;
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const length = Math.sqrt(dx * dx + dy * dy);
    const stops = [
      { id: segment.a, u: 0 },
      { id: segment.b, u: length },
    ];
    for (let id = 0; id < points.length; id++) {
      if (id === segment.a || id === segment.b) continue;
      const p = points[id]!;
      const u = ((p.x - a.x) * dx + (p.y - a.y) * dy) / length;
      if (u <= CONTACT || u >= length - CONTACT) continue;
      if (Math.abs(cross(a, b, p)) <= CONTACT * length) stops.push({ id, u });
    }
    stops.sort((a, b) => a.u - b.u || a.id - b.id);
    for (let i = 0; i + 1 < stops.length; i++) {
      const a = stops[i]!.id;
      const b = stops[i + 1]!.id;
      const opposite = segments.findIndex((s) => s.a === b && s.b === a);
      if (opposite >= 0) segments.splice(opposite, 1);
      else segments.push({ ...segment, a, b });
    }
  }
  const used = new Set<number>();
  const cycles: number[][] = [];
  for (let start = 0; start < segments.length; start++) {
    if (used.has(start)) continue;
    const cycle: number[] = [];
    let current = start;
    do {
      if (used.has(current)) return null;
      used.add(current);
      cycle.push(current);
      const s = segments[current]!;
      const incoming = {
        x: points[s.b]!.x - points[s.a]!.x,
        y: points[s.b]!.y - points[s.a]!.y,
      };
      let best = -1;
      let bestTurn = -Infinity;
      for (let j = 0; j < segments.length; j++) {
        const candidate = segments[j]!;
        if (candidate.a !== s.b) continue;
        const outgoing = {
          x: points[candidate.b]!.x - points[candidate.a]!.x,
          y: points[candidate.b]!.y - points[candidate.a]!.y,
        };
        const turn = Math.atan2(
          incoming.x * outgoing.y - incoming.y * outgoing.x,
          dot(incoming, outgoing),
        );
        if (turn > bestTurn + PARALLEL) {
          best = j;
          bestTurn = turn;
        }
      }
      if (best < 0) return null;
      current = best;
    } while (current !== start);
    if (cycle.length >= 3) cycles.push(cycle);
  }
  const continued = new Set<number>();
  const result: Loop[] = [];
  for (const cycle of cycles) {
    let merged = true;
    while (merged && cycle.length >= 3) {
      merged = false;
      for (let i = 0; i < cycle.length; i++) {
        const before = segments[cycle[(i + cycle.length - 1) % cycle.length]!]!;
        const current = segments[cycle[i]!]!;
        const a = before.edge.normal;
        const b = current.edge.normal;
        if (Math.abs(a.x * b.y - a.y * b.x) <= PARALLEL && dot(a, b) > 0) {
          before.b = current.b;
          before.parent = -1;
          cycle.splice(i, 1);
          merged = true;
          break;
        }
      }
    }
    if (cycle.length < 3) continue;
    const edges: Edge[] = [];
    const vertices: Vertex[] = [];
    for (let i = 0; i < cycle.length; i++) {
      const s = segments[cycle[i]!]!;
      const prev = segments[cycle[(i + cycle.length - 1) % cycle.length]!]!;
      const next = segments[cycle[(i + 1) % cycle.length]!]!;
      const motion = velocity(prev.edge.normal, s.edge.normal);
      if (!motion) return null;
      const original = old[s.parent];
      if (
        original &&
        prev.parent === original.prev &&
        next.parent === original.next
      ) {
        continued.add(s.parent);
        edges.push(s.edge);
      } else {
        edges.push({
          normal: s.edge.normal,
          start: { ...points[s.a]!, time },
          end: { ...points[s.b]!, time },
        });
      }
      vertices.push({ ...points[s.a]!, velocity: motion });
    }
    result.push({ edges, vertices });
  }
  for (let i = 0; i < old.length; i++) {
    if (continued.has(i)) continue;
    const { edge, a, b } = old[i]!;
    const polygon = [edge.start, edge.end, { ...b, time }, { ...a, time }];
    if (signedArea2(polygon) > CONTACT * CONTACT)
      faces.push({ points: polygon, normal: edge.normal });
  }
  return result;
}

/** Returns null for degenerate topology or an unresolved numerical event. */
export function straightSkeleton(
  polygon: Pick<Polygon, "outer" | "holes">,
): Skeleton | null {
  const all = [polygon.outer, ...polygon.holes];
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const ring of all)
    for (const p of ring) {
      minX = Math.min(minX, p.x);
      minY = Math.min(minY, p.y);
      maxX = Math.max(maxX, p.x);
      maxY = Math.max(maxY, p.y);
    }
  const scale = Math.max(maxX - minX, maxY - minY);
  if (!(scale > 0)) return null;
  let loops: Loop[] = [];
  let count = 0;
  let area = 0;
  for (const ring of all) {
    if (ring.length < 3) return null;
    const points = ring.map((p) => ({
      x: (p.x - minX) / scale,
      y: (p.y - minY) / scale,
      time: 0,
    }));
    const edges = points.map((a, i) => {
      const b = points[(i + 1) % points.length]!;
      const dx = b.x - a.x;
      const dy = b.y - a.y;
      const length = Math.sqrt(dx * dx + dy * dy);
      return {
        normal: { x: -(b.y - a.y) / length, y: (b.x - a.x) / length },
        start: a,
        end: b,
      };
    });
    const vertices: Vertex[] = [];
    for (let i = 0; i < points.length; i++) {
      const motion = velocity(
        edges[(i + edges.length - 1) % edges.length]!.normal,
        edges[i]!.normal,
      );
      if (!motion) return null;
      vertices.push({ ...points[i]!, velocity: motion });
    }
    loops.push({ edges, vertices });
    count += ring.length;
    area += signedArea2(points);
  }
  const faces: SkeletonFace[] = [];
  const initial = advance(loops, 0, 0, faces);
  if (!initial) return null;
  loops = initial;
  let time = 0;
  for (let step = 0; loops.length && step < count * 4; step++) {
    const dt = nextEvent(loops);
    if (!Number.isFinite(dt)) return null;
    time += dt;
    const next = advance(loops, dt, time, faces);
    if (!next) return null;
    loops = next;
  }
  if (loops.length || !(time > CONTACT)) return null;
  const covered = faces.reduce(
    (sum, face) => sum + signedArea2(face.points),
    0,
  );
  if (Math.abs(covered - area) > Math.max(area, 1) * 1e-7) return null;
  // A face can continue through an event on its neighbor. Insert the event's
  // vertices on both faces, so the roof triangulation has no T-junctions.
  const corners = faces.flatMap((face) => face.points);
  // Zero-time hole merges may remove a collinear eave vertex. Keep the roof
  // boundary split there so it still matches the original wall edges.
  for (const ring of all)
    for (const p of ring)
      corners.push({
        x: (p.x - minX) / scale,
        y: (p.y - minY) / scale,
        time: 0,
      });
  for (const face of faces) {
    const boundary: SkeletonPoint[] = [];
    for (let i = 0; i < face.points.length; i++) {
      const a = face.points[i]!;
      const b = face.points[(i + 1) % face.points.length]!;
      const dx = b.x - a.x;
      const dy = b.y - a.y;
      const length = Math.sqrt(dx * dx + dy * dy);
      if (length <= CONTACT) continue;
      const stops = [{ u: 0, p: a }];
      for (const p of corners) {
        const u = ((p.x - a.x) * dx + (p.y - a.y) * dy) / (length * length);
        if (u <= CONTACT || u >= 1 - CONTACT) continue;
        if (
          Math.abs(cross(a, b, p)) > CONTACT * length ||
          Math.abs(p.time - (a.time + u * (b.time - a.time))) > CONTACT
        )
          continue;
        if (!stops.some((s) => Math.abs(s.u - u) * length <= CONTACT))
          stops.push({ u, p });
      }
      stops.sort((a, b) => a.u - b.u);
      boundary.push(...stops.map((s) => s.p));
    }
    face.points = boundary;
  }
  return {
    faces: faces.map((face) => ({
      normal: face.normal,
      points: face.points.map((p) => ({
        x: p.x * scale + minX,
        y: p.y * scale + minY,
        time: p.time * scale,
      })),
    })),
    run: time * scale,
  };
}
