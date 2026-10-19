//! Per-edge-speed straight skeleton with courtyard boundaries. The wavefront
//! keeps the building on its left. At each event its contacts are split and
//! opposing segments canceled before reconnection, including simultaneous
//! collapses and hole/outer merges. ../../js/src/skeleton.ts is its twin.
const std = @import("std");
const Allocator = std.mem.Allocator;
const footprint = @import("footprint.zig");
const Point = footprint.Point;
const Polygon = footprint.Polygon;

pub const SkeletonPoint = struct {
    x: f64,
    y: f64,
    time: f64,

    fn point(self: SkeletonPoint) Point {
        return .{ .x = self.x, .y = self.y };
    }
};
pub const Face = struct { points: []SkeletonPoint, normal: Point };
pub const Skeleton = struct { faces: []Face, run: f64 };
pub const EdgeMotion = struct {
    speed: f64 = 1,
    change_time: f64 = std.math.inf(f64),
    after_speed: f64 = 1,
};
const Edge = struct { normal: Point, speed: f64 = 1, change_time: f64 = std.math.inf(f64), after_speed: f64 = 1, start: SkeletonPoint, end: SkeletonPoint };
const Vertex = struct { p: Point, velocity: Point };
const Loop = struct { edges: []Edge, vertices: []Vertex };
const Segment = struct { a: usize, b: usize, edge: Edge, parent: usize };
const Old = struct { edge: Edge, a: Point, b: Point, prev: usize, next: usize };
const none = std.math.maxInt(usize);

// Coordinates are normalized to unit extent. Contact tolerance accounts for
// rounding in event times; events are never advanced past their actual time.
const contact: f64 = 1e-9;
const parallel: f64 = 1e-12;

fn dot(a: Point, b: Point) f64 {
    return a.x * b.x + a.y * b.y;
}

fn velocity(left: Edge, right: Edge) ?Point {
    const a = left.normal;
    const b = right.normal;
    const det = a.x * b.y - a.y * b.x;
    if (@abs(det) <= parallel) return null;
    return .{ .x = (left.speed * b.y - right.speed * a.y) / det, .y = (right.speed * a.x - left.speed * b.x) / det };
}

fn at(v: Vertex, dt: f64) Point {
    return .{ .x = v.p.x + v.velocity.x * dt, .y = v.p.y + v.velocity.y * dt };
}

fn timed(p: Point, time: f64) SkeletonPoint {
    return .{ .x = p.x, .y = p.y, .time = time };
}

fn area2(points: []const SkeletonPoint) f64 {
    var sum: f64 = 0;
    for (points, 0..) |p, i| {
        const q = points[(i + 1) % points.len];
        sum += p.x * q.y - q.x * p.y;
    }
    return sum;
}

fn nextEvent(loops: []const Loop) f64 {
    var time = std.math.inf(f64);
    for (loops, 0..) |loop, li| {
        const count = loop.edges.len;
        for (loop.vertices, 0..) |v, i| {
            const w = loop.vertices[(i + 1) % count];
            const normal = loop.edges[i].normal;
            const length = normal.y * (w.p.x - v.p.x) - normal.x * (w.p.y - v.p.y);
            const rate = normal.y * (w.velocity.x - v.velocity.x) - normal.x * (w.velocity.y - v.velocity.y);
            if (rate < -parallel) {
                const dt = -length / rate;
                if (dt > contact and dt < time) time = dt;
            }
            for (loops, 0..) |other, oi| {
                for (other.edges, 0..) |edge, j| {
                    if (li == oi and (j == i or (j + 1) % count == i)) continue;
                    const a = other.vertices[j];
                    const b = other.vertices[(j + 1) % other.edges.len];
                    const gap = edge.normal.x * (v.p.x - a.p.x) + edge.normal.y * (v.p.y - a.p.y);
                    const speed = dot(edge.normal, v.velocity) - edge.speed;
                    if (gap <= contact or speed >= -parallel) continue;
                    const dt = -gap / speed;
                    if (dt <= contact or dt > time + contact) continue;
                    const p = at(v, dt);
                    const q = at(a, dt);
                    const r = at(b, dt);
                    const u = edge.normal.y * (p.x - q.x) - edge.normal.x * (p.y - q.y);
                    const len = edge.normal.y * (r.x - q.x) - edge.normal.x * (r.y - q.y);
                    if (u >= -contact and u <= len + contact) time = @min(time, dt);
                }
            }
        }
    }
    return time;
}

fn pointId(allocator: Allocator, points: *std.ArrayList(Point), p: Point) Allocator.Error!usize {
    for (points.items, 0..) |q, i| {
        if (@abs(p.x - q.x) <= contact and @abs(p.y - q.y) <= contact) return i;
    }
    try points.append(allocator, p);
    return points.items.len - 1;
}

const Stop = struct { id: usize, u: f64 };
fn lessStop(_: void, a: Stop, b: Stop) bool {
    return if (a.u != b.u) a.u < b.u else a.id < b.id;
}

fn advance(allocator: Allocator, loops: []const Loop, dt: f64, time: f64, faces: *std.ArrayList(Face)) Allocator.Error!?[]Loop {
    var points: std.ArrayList(Point) = .empty;
    var raw: std.ArrayList(Segment) = .empty;
    var old: std.ArrayList(Old) = .empty;
    for (loops) |loop| {
        const base = old.items.len;
        const count = loop.edges.len;
        const ids = try allocator.alloc(usize, count);
        for (loop.vertices, ids) |v, *id| id.* = try pointId(allocator, &points, at(v, dt));
        for (loop.edges, 0..) |edge, i| {
            const a = ids[i];
            const b = ids[(i + 1) % count];
            var updated = edge;
            if (edge.change_time <= time) {
                updated.speed = edge.after_speed;
                updated.change_time = std.math.inf(f64);
            }
            try raw.append(allocator, .{ .a = a, .b = b, .edge = updated, .parent = old.items.len });
            try old.append(allocator, .{ .edge = edge, .a = points.items[a], .b = points.items[b], .prev = base + (i + count - 1) % count, .next = base + (i + 1) % count });
        }
    }
    var segments: std.ArrayList(Segment) = .empty;
    for (raw.items) |segment| {
        if (segment.a == segment.b) continue;
        const a = points.items[segment.a];
        const b = points.items[segment.b];
        const dx = b.x - a.x;
        const dy = b.y - a.y;
        const length = @sqrt(dx * dx + dy * dy);
        var stops: std.ArrayList(Stop) = .empty;
        try stops.appendSlice(allocator, &.{ .{ .id = segment.a, .u = 0 }, .{ .id = segment.b, .u = length } });
        for (points.items, 0..) |p, id| {
            if (id == segment.a or id == segment.b) continue;
            const u = ((p.x - a.x) * dx + (p.y - a.y) * dy) / length;
            if (u <= contact or u >= length - contact) continue;
            if (@abs(footprint.cross(a, b, p)) <= contact * length) try stops.append(allocator, .{ .id = id, .u = u });
        }
        std.mem.sort(Stop, stops.items, {}, lessStop);
        for (0..stops.items.len - 1) |i| {
            const from = stops.items[i].id;
            const to = stops.items[i + 1].id;
            var opposite: ?usize = null;
            for (segments.items, 0..) |s, j| {
                if (s.a == to and s.b == from) {
                    opposite = j;
                    break;
                }
            }
            if (opposite) |j| {
                _ = segments.orderedRemove(j);
            } else {
                var piece = segment;
                piece.a = from;
                piece.b = to;
                try segments.append(allocator, piece);
            }
        }
    }
    const used = try allocator.alloc(bool, segments.items.len);
    @memset(used, false);
    var cycles: std.ArrayList(std.ArrayList(usize)) = .empty;
    for (0..segments.items.len) |start| {
        if (used[start]) continue;
        var cycle: std.ArrayList(usize) = .empty;
        var current = start;
        while (true) {
            if (used[current]) return null;
            used[current] = true;
            try cycle.append(allocator, current);
            const s = segments.items[current];
            const incoming: Point = .{ .x = points.items[s.b].x - points.items[s.a].x, .y = points.items[s.b].y - points.items[s.a].y };
            var best: ?usize = null;
            var best_turn = -std.math.inf(f64);
            for (segments.items, 0..) |candidate, j| {
                if (candidate.a != s.b) continue;
                const outgoing: Point = .{ .x = points.items[candidate.b].x - points.items[candidate.a].x, .y = points.items[candidate.b].y - points.items[candidate.a].y };
                const turn = std.math.atan2(incoming.x * outgoing.y - incoming.y * outgoing.x, dot(incoming, outgoing));
                if (turn > best_turn + parallel) {
                    best = j;
                    best_turn = turn;
                }
            }
            current = best orelse return null;
            if (current == start) break;
        }
        if (cycle.items.len >= 3) try cycles.append(allocator, cycle);
    }
    const continued = try allocator.alloc(bool, old.items.len);
    @memset(continued, false);
    var result: std.ArrayList(Loop) = .empty;
    for (cycles.items) |*cycle| {
        var merged = true;
        while (merged and cycle.items.len >= 3) {
            merged = false;
            for (cycle.items, 0..) |id, i| {
                const before = &segments.items[cycle.items[(i + cycle.items.len - 1) % cycle.items.len]];
                const current = segments.items[id];
                const a = before.edge.normal;
                const b = current.edge.normal;
                if (before.edge.speed == current.edge.speed and before.edge.change_time == current.edge.change_time and before.edge.after_speed == current.edge.after_speed and @abs(a.x * b.y - a.y * b.x) <= parallel and dot(a, b) > 0) {
                    before.b = current.b;
                    before.parent = none;
                    _ = cycle.orderedRemove(i);
                    merged = true;
                    break;
                }
            }
        }
        if (cycle.items.len < 3) continue;
        const edges = try allocator.alloc(Edge, cycle.items.len);
        const vertices = try allocator.alloc(Vertex, cycle.items.len);
        for (cycle.items, 0..) |id, i| {
            const s = segments.items[id];
            const prev = segments.items[cycle.items[(i + cycle.items.len - 1) % cycle.items.len]];
            const next = segments.items[cycle.items[(i + 1) % cycle.items.len]];
            const motion = velocity(prev.edge, s.edge) orelse return null;
            if (s.parent != none and prev.parent == old.items[s.parent].prev and next.parent == old.items[s.parent].next and s.edge.speed == old.items[s.parent].edge.speed and prev.edge.speed == old.items[prev.parent].edge.speed and next.edge.speed == old.items[next.parent].edge.speed) {
                continued[s.parent] = true;
                edges[i] = s.edge;
            } else {
                edges[i] = .{ .normal = s.edge.normal, .speed = s.edge.speed, .change_time = s.edge.change_time, .after_speed = s.edge.after_speed, .start = timed(points.items[s.a], time), .end = timed(points.items[s.b], time) };
            }
            vertices[i] = .{ .p = points.items[s.a], .velocity = motion };
        }
        try result.append(allocator, .{ .edges = edges, .vertices = vertices });
    }
    for (old.items, 0..) |item, i| {
        if (continued[i]) continue;
        const polygon = [_]SkeletonPoint{ item.edge.start, item.edge.end, timed(item.b, time), timed(item.a, time) };
        if (item.edge.speed > 0 and area2(&polygon) > contact * contact) try faces.append(allocator, .{ .points = try allocator.dupe(SkeletonPoint, &polygon), .normal = .{ .x = item.edge.normal.x / item.edge.speed, .y = item.edge.normal.y / item.edge.speed } });
    }
    return try result.toOwnedSlice(allocator);
}

const FaceStop = struct { u: f64, p: SkeletonPoint };
fn lessFaceStop(_: void, a: FaceStop, b: FaceStop) bool {
    return a.u < b.u;
}

/// Everything allocated here belongs to the caller's per-feature scratch arena.
/// Null means degenerate topology or an unresolved numerical event.
/// The most vertices (all rings together) a skeleton is built for, as in the
/// TypeScript twin: the event search is about cubic, so larger footprints get
/// a flat roof.
pub const max_skeleton_vertices = 192;

pub fn straightSkeleton(allocator: Allocator, polygon: Polygon) Allocator.Error!?Skeleton {
    return weightedSkeleton(allocator, polygon, &.{});
}

pub fn weightedSkeleton(allocator: Allocator, polygon: Polygon, stationary: []const bool) Allocator.Error!?Skeleton {
    return movingSkeleton(allocator, polygon, stationary, &.{});
}

pub fn movingSkeleton(allocator: Allocator, polygon: Polygon, stationary: []const bool, motions: []const []const EdgeMotion) Allocator.Error!?Skeleton {
    var total = polygon.outer.len;
    for (polygon.holes.items) |hole| total += hole.len;
    if (total > max_skeleton_vertices) return null;
    const all = try allocator.alloc([]const Point, 1 + polygon.holes.items.len);
    all[0] = polygon.outer;
    for (all[1..], polygon.holes.items) |*ring, hole| ring.* = hole;
    var min_x = std.math.inf(f64);
    var min_y = std.math.inf(f64);
    var max_x = -std.math.inf(f64);
    var max_y = -std.math.inf(f64);
    for (all) |ring| for (ring) |p| {
        min_x = @min(min_x, p.x);
        min_y = @min(min_y, p.y);
        max_x = @max(max_x, p.x);
        max_y = @max(max_y, p.y);
    };
    const scale = @max(max_x - min_x, max_y - min_y);
    if (!(scale > 0)) return null;
    var loops = try allocator.alloc(Loop, all.len);
    var count: usize = 0;
    var area: f64 = 0;
    for (all, loops, 0..) |ring, *loop, r| {
        if (ring.len < 3) return null;
        const points = try allocator.alloc(SkeletonPoint, ring.len);
        for (ring, points) |p, *q| q.* = .{ .x = (p.x - min_x) / scale, .y = (p.y - min_y) / scale, .time = 0 };
        const edges = try allocator.alloc(Edge, ring.len);
        for (points, edges, 0..) |a, *edge, i| {
            const b = points[(i + 1) % points.len];
            const dx = b.x - a.x;
            const dy = b.y - a.y;
            const length = @sqrt(dx * dx + dy * dy);
            const motion: EdgeMotion = if (r < motions.len and i < motions[r].len) motions[r][i] else .{ .speed = if (r == 0 and i < stationary.len and stationary[i]) 0 else 1 };
            edge.* = .{ .normal = .{ .x = -dy / length, .y = dx / length }, .speed = motion.speed, .change_time = motion.change_time / scale, .after_speed = motion.after_speed, .start = a, .end = b };
        }
        const vertices = try allocator.alloc(Vertex, ring.len);
        for (vertices, 0..) |*v, i| {
            const motion = velocity(edges[(i + edges.len - 1) % edges.len], edges[i]) orelse return null;
            v.* = .{ .p = points[i].point(), .velocity = motion };
        }
        loop.* = .{ .edges = edges, .vertices = vertices };
        count += ring.len;
        area += area2(points);
    }
    var faces: std.ArrayList(Face) = .empty;
    loops = (try advance(allocator, loops, 0, 0, &faces)) orelse return null;
    var time: f64 = 0;
    var step: usize = 0;
    while (loops.len > 0 and step < count * 4) : (step += 1) {
        var dt = nextEvent(loops);
        for (loops) |loop| for (loop.edges) |edge| {
            dt = @min(dt, edge.change_time - time);
        };
        if (!std.math.isFinite(dt)) return null;
        time += dt;
        loops = (try advance(allocator, loops, dt, time, &faces)) orelse return null;
    }
    if (loops.len > 0 or !(time > contact)) return null;
    var covered: f64 = 0;
    for (faces.items) |face| covered += area2(face.points);
    if (@abs(covered - area) > @max(area, 1) * 1e-7) return null;

    // Continuing faces need their neighbors' event vertices too: conforming
    // boundaries avoid T-junctions in the final roof mesh.
    var corners: std.ArrayList(SkeletonPoint) = .empty;
    for (faces.items) |face| try corners.appendSlice(allocator, face.points);
    // Zero-time hole merges can remove collinear eave vertices needed by walls.
    for (all) |ring| for (ring) |p| {
        try corners.append(allocator, .{ .x = (p.x - min_x) / scale, .y = (p.y - min_y) / scale, .time = 0 });
    };
    for (faces.items) |*face| {
        var boundary: std.ArrayList(SkeletonPoint) = .empty;
        for (face.points, 0..) |a, i| {
            const b = face.points[(i + 1) % face.points.len];
            const dx = b.x - a.x;
            const dy = b.y - a.y;
            const length = @sqrt(dx * dx + dy * dy);
            if (length <= contact) continue;
            var stops: std.ArrayList(FaceStop) = .empty;
            try stops.append(allocator, .{ .u = 0, .p = a });
            for (corners.items) |p| {
                const u = ((p.x - a.x) * dx + (p.y - a.y) * dy) / (length * length);
                if (u <= contact or u >= 1 - contact) continue;
                if (@abs(footprint.cross(a.point(), b.point(), p.point())) > contact * length or @abs(p.time - (a.time + u * (b.time - a.time))) > contact) continue;
                var found = false;
                for (stops.items) |s| {
                    if (@abs(s.u - u) * length <= contact) {
                        found = true;
                        break;
                    }
                }
                if (!found) try stops.append(allocator, .{ .u = u, .p = p });
            }
            std.mem.sort(FaceStop, stops.items, {}, lessFaceStop);
            for (stops.items) |s| try boundary.append(allocator, s.p);
        }
        face.points = try boundary.toOwnedSlice(allocator);
    }
    for (faces.items) |face| for (face.points) |*p| {
        p.x = p.x * scale + min_x;
        p.y = p.y * scale + min_y;
        p.time *= scale;
    };
    return .{ .faces = try faces.toOwnedSlice(allocator), .run = time * scale };
}

/// Terminal hip faces between roughly parallel sides become vertical gables.
pub fn gableEnds(allocator: Allocator, outer: []const Point, skeleton: Skeleton) Allocator.Error![]bool {
    const result = try allocator.alloc(bool, outer.len);
    @memset(result, false);
    const tolerance = skeleton.run * 1e-7;
    for (outer, 0..) |a, i| {
        const b = outer[(i + 1) % outer.len];
        const prev = outer[(i + outer.len - 1) % outer.len];
        const next = outer[(i + 2) % outer.len];
        if (footprint.cross(prev, a, b) <= 0 or footprint.cross(a, b, next) <= 0) continue;
        const ux = a.x - prev.x;
        const uy = a.y - prev.y;
        const vx = next.x - b.x;
        const vy = next.y - b.y;
        if (ux * vx + uy * vy > -0.8 * @sqrt((ux * ux + uy * uy) * (vx * vx + vy * vy))) continue;
        const dx = b.x - a.x;
        const dy = b.y - a.y;
        const length = @sqrt(dx * dx + dy * dy);
        const nx = -dy / length;
        const ny = dx / length;
        // Events on neighboring arms can divide one terminal hip into several faces.
        var points: std.ArrayList(SkeletonPoint) = .empty;
        var area: f64 = 0;
        for (skeleton.faces) |face| {
            if (@abs(face.normal.x - nx) >= 1e-7 or @abs(face.normal.y - ny) >= 1e-7) continue;
            var matches = true;
            for (face.points) |p| {
                const along = (dx * (p.x - a.x) + dy * (p.y - a.y)) / length;
                if (along < -tolerance or along > length + tolerance or @abs(nx * (p.x - a.x) + ny * (p.y - a.y) - p.time) > tolerance) matches = false;
            }
            if (!matches) continue;
            area += area2(face.points);
            try points.appendSlice(allocator, face.points);
        }
        var apex: ?SkeletonPoint = null;
        for (points.items) |p| {
            if (apex == null or p.time > apex.?.time) apex = p;
        }
        const tip = apex orelse continue;
        if (tip.time <= tolerance or @abs(area - footprint.cross(a, b, tip.point())) > tolerance * length) continue;
        var inside = true;
        for (points.items) |p| {
            if (footprint.cross(b, tip.point(), p.point()) < -tolerance * length or footprint.cross(tip.point(), a, p.point()) < -tolerance * length) inside = false;
        }
        result[i] = inside;
    }
    return result;
}

/// A regular n-gon of radius 2000 tile units, with positive area.
fn regularPolygon(points: []Point) Polygon {
    for (points, 0..) |*p, i| {
        const a = 2 * std.math.pi * @as(f64, @floatFromInt(i)) / @as(f64, @floatFromInt(points.len));
        p.* = .{ .x = @round(4096 + 2000 * @cos(a)), .y = @round(4096 + 2000 * @sin(a)) };
    }
    if (footprint.signedArea2(points) < 0) std.mem.reverse(Point, points);
    return .{ .outer = points, .cut = false };
}

test "footprints over max_skeleton_vertices get no skeleton" {
    var arena = std.heap.ArenaAllocator.init(std.testing.allocator);
    defer arena.deinit();
    var at_cap: [max_skeleton_vertices]Point = undefined;
    try std.testing.expect(try straightSkeleton(arena.allocator(), regularPolygon(&at_cap)) != null);
    var over: [max_skeleton_vertices + 1]Point = undefined;
    try std.testing.expect(try straightSkeleton(arena.allocator(), regularPolygon(&over)) == null);
}
