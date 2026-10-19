//! Explicit roof lines; ../../js/src/complex.ts is the twin.
const std = @import("std");
const Allocator = std.mem.Allocator;
const footprint = @import("footprint.zig");
const Point = footprint.Point;
const Polygon = footprint.Polygon;
const cross = footprint.cross;
const triangulate = @import("triangulate.zig").triangulate;
pub const Tile = struct { z: u8, x: u32, y: u32 };
pub const RoofPoint = struct {
    x: f64,
    y: f64,
    n: f64,
    pub fn point(p: @This()) Point {
        return .{ .x = p.x, .y = p.y };
    }
};
pub const ComplexRoof = struct { points: []const RoofPoint, triangles: []const usize, run: f64 };
const eps = 1e-7;
fn along(a: Point, b: Point, p: Point) f64 {
    return ((p.x - a.x) * (b.x - a.x) + (p.y - a.y) * (b.y - a.y)) / ((b.x - a.x) * (b.x - a.x) + (b.y - a.y) * (b.y - a.y));
}
fn on(a: Point, b: Point, p: Point) bool {
    const t = along(a, b, p);
    return t >= -eps and t <= 1 + eps and @abs(cross(a, b, p)) < eps;
}
fn crosses(a: Point, b: Point, c: Point, d: Point) bool {
    return cross(a, b, c) * cross(a, b, d) < -eps and cross(c, d, a) * cross(c, d, b) < -eps;
}
const Stop = struct {
    i: usize,
    t: f64,
    fn less(_: void, a: @This(), b: @This()) bool {
        return if (a.t != b.t) a.t < b.t else a.i < b.i;
    }
};
fn key(a: usize, b: usize) [2]usize {
    return if (a < b) .{ a, b } else .{ b, a };
}
fn same(a: [2]usize, b: [2]usize) bool {
    return a[0] == b[0] and a[1] == b[1];
}
pub const RoofGraph = struct { vertices: std.ArrayList(RoofPoint) = .empty, edges: std.ArrayList([2]usize) = .empty };

fn snap(p: RoofPoint, polygon: Polygon) RoofPoint {
    var nearest: f64 = 0.75 * 0.75;
    var snapped = p;
    var r: usize = 0;
    while (r <= polygon.holes.items.len) : (r += 1) {
        const ring = if (r == 0) polygon.outer else polygon.holes.items[r - 1];
        for (ring, 0..) |a, i| {
            const b = ring[(i + 1) % ring.len];
            const t = std.math.clamp(along(a, b, p.point()), 0, 1);
            const q: RoofPoint = .{ .x = a.x + t * (b.x - a.x), .y = a.y + t * (b.y - a.y), .n = p.n };
            const d = (q.x - p.x) * (q.x - p.x) + (q.y - p.y) * (q.y - p.y);
            if (d < nearest) {
                nearest = d;
                snapped = q;
            }
        }
    }
    return snapped;
}
fn inside(ring: []const Point, p: Point) bool {
    var result = false;
    for (ring, 0..) |a, i| {
        const b = ring[(i + 1) % ring.len];
        if (on(a, b, p)) return true;
        if ((a.y > p.y) != (b.y > p.y) and p.x < a.x + (p.y - a.y) * (b.x - a.x) / (b.y - a.y)) result = !result;
    }
    return result;
}
fn contains(polygon: Polygon, p: Point) bool {
    var r: usize = 0;
    while (r <= polygon.holes.items.len) : (r += 1) {
        const ring = if (r == 0) polygon.outer else polygon.holes.items[r - 1];
        for (ring, 0..) |a, i| if (on(a, ring[(i + 1) % ring.len], p)) return true;
    }
    if (!inside(polygon.outer, p)) return false;
    for (polygon.holes.items) |ring| if (inside(ring, p)) return false;
    return true;
}
fn number(value: std.json.Value) ?f64 {
    return switch (value) {
        .integer => |v| @floatFromInt(v),
        .float => |v| if (std.math.isFinite(v)) v else null,
        else => null,
    };
}

/// Validate JSON token types before conversion: std.json's typed numeric parser
/// also accepts numeric strings, unlike the JS contract.
pub fn partitionRoofGraph(scratch: Allocator, polygons: []const Polygon, text: []const u8, tile_id: ?Tile, extent: f64) Allocator.Error!?[]?RoofGraph {
    const tile = tile_id orelse return null;
    if (text.len > 65536) return null;
    const parsed = std.json.parseFromSlice(std.json.Value, scratch, text, .{ .duplicate_field_behavior = .use_last }) catch |err| return if (err == error.OutOfMemory) error.OutOfMemory else null;
    defer parsed.deinit();
    if (parsed.value != .object) return null;
    const vertices = parsed.value.object.get("vertices") orelse return null;
    const edges = parsed.value.object.get("edges") orelse return null;
    if (vertices != .array or edges != .array or vertices.array.items.len == 0 or vertices.array.items.len > 192 or edges.array.items.len > 576) return null;
    // Work in a small local frame so world-coordinate boundary snaps retain precision.
    const local = try scratch.alloc(Polygon, polygons.len);
    const origins = try scratch.alloc(Point, polygons.len);
    for (polygons, local, origins) |polygon, *p, *origin| {
        origin.* = polygon.outer[0];
        const outer = try scratch.alloc(Point, polygon.outer.len);
        for (outer, polygon.outer) |*q, v| q.* = .{ .x = v.x - origin.x, .y = v.y - origin.y };
        p.* = .{ .outer = outer, .cut = polygon.cut };
        for (polygon.holes.items) |ring| {
            const hole = try scratch.alloc(Point, ring.len);
            for (hole, ring) |*q, v| q.* = .{ .x = v.x - origin.x, .y = v.y - origin.y };
            try p.holes.append(scratch, hole);
        }
    }
    const graphs = try scratch.alloc(?RoofGraph, polygons.len);
    for (graphs) |*g| g.* = .{};
    const owners = try scratch.alloc(usize, vertices.array.items.len);
    const ids = try scratch.alloc(usize, vertices.array.items.len);
    for (vertices.array.items, 0..) |value, i| {
        if (value != .array or value.array.items.len != 3) return null;
        var v: [3]f64 = undefined;
        for (&v, value.array.items) |*n, token| n.* = number(token) orelse return null;
        if (@abs(v[0]) > 180 or @abs(v[1]) > 85.051129 or v[2] < 0 or v[2] > 1) return null;
        const scale = extent * std.math.pow(f64, 2, @floatFromInt(tile.z));
        const sin = @sin(v[1] * std.math.pi / 180);
        const p: RoofPoint = .{ .x = @floor((v[0] / 360 + 0.5) * scale + 0.5) - @as(f64, @floatFromInt(tile.x)) * extent, .y = @floor((0.5 - @log((1 + sin) / (1 - sin)) / (4 * std.math.pi)) * scale + 0.5) - @as(f64, @floatFromInt(tile.y)) * extent, .n = v[2] };
        var owner: ?usize = null;
        for (local, origins, 0..) |polygon, origin, j| if (contains(polygon, snap(.{ .x = p.x - origin.x, .y = p.y - origin.y, .n = p.n }, polygon).point())) {
            owner = j;
            break;
        };
        const j = owner orelse return null;
        owners[i] = j;
        ids[i] = graphs[j].?.vertices.items.len;
        try graphs[j].?.vertices.append(scratch, p);
    }
    const bad = try scratch.alloc(bool, polygons.len);
    @memset(bad, false);
    for (edges.array.items) |value| {
        if (value != .array or value.array.items.len != 2) return null;
        var edge: [2]usize = undefined;
        for (&edge, value.array.items) |*id, token| {
            const n = number(token) orelse return null;
            if (n < 0 or n >= @as(f64, @floatFromInt(ids.len)) or @floor(n) != n) return null;
            id.* = @intFromFloat(n);
        }
        const a = edge[0];
        const b = edge[1];
        if (owners[a] != owners[b]) {
            bad[owners[a]] = true;
            bad[owners[b]] = true;
        } else try graphs[owners[a]].?.edges.append(scratch, .{ ids[a], ids[b] });
    }
    for (graphs, bad) |*g, invalid| if (invalid or g.*.?.vertices.items.len == 0) {
        g.* = null;
    };
    return graphs;
}

/// Each successful ear pass removes a vertex; invalid cavities return immediately.
fn fillCavity(scratch: Allocator, points: []const RoofPoint, ring: *std.ArrayList(usize), result: *std.ArrayList(usize)) Allocator.Error!bool {
    while (ring.items.len > 2) {
        var clipped = false;
        for (ring.items, 0..) |b, i| {
            const a = ring.items[(i + ring.items.len - 1) % ring.items.len];
            const c = ring.items[(i + 1) % ring.items.len];
            if (cross(points[a].point(), points[b].point(), points[c].point()) <= eps) continue;
            var blocked = false;
            for (ring.items) |p| if (p != a and p != b and p != c and
                cross(points[a].point(), points[b].point(), points[p].point()) >= -eps and
                cross(points[b].point(), points[c].point(), points[p].point()) >= -eps and
                cross(points[c].point(), points[a].point(), points[p].point()) >= -eps)
            {
                blocked = true;
                break;
            };
            if (blocked) continue;
            try result.appendSlice(scratch, &.{ a, b, c });
            _ = ring.orderedRemove(i);
            clipped = true;
            break;
        }
        if (!clipped) return false;
    }
    return true;
}

/// Insert vertices, then replace each crossed triangle strip with two cavities.
pub fn complexRoof(scratch: Allocator, polygon: Polygon, graph: ?RoofGraph, origin: Point, run: f64) Allocator.Error!?ComplexRoof {
    const data = graph orelse return null;
    var count = polygon.outer.len;
    for (polygon.holes.items) |ring| count += ring.len;
    if (count > 192 or run < 1) return null;
    const base = try triangulate(scratch, polygon.outer, polygon.holes.items);
    var points: std.ArrayList(RoofPoint) = .empty;
    for (base.points) |p| try points.append(scratch, .{ .x = p.x, .y = p.y, .n = 0 });
    var triangles: std.ArrayList(usize) = .empty;
    for (base.triangles) |i| try triangles.append(scratch, i);
    var ids: std.ArrayList(usize) = .empty;
    for (data.vertices.items) |v| {
        const p = snap(.{ .x = v.x - origin.x, .y = v.y - origin.y, .n = v.n }, polygon);
        var found: ?usize = null;
        for (points.items, 0..) |q, i| if (@abs(p.x - q.x) < eps and @abs(p.y - q.y) < eps) {
            found = i;
            break;
        };
        if (found) |i| {
            points.items[i].n = p.n;
            try ids.append(scratch, i);
            continue;
        }
        if (points.items.len >= 192) return null;
        const id = points.items.len;
        var next: std.ArrayList(usize) = .empty;
        var inserted = false;
        var i: usize = 0;
        while (i < triangles.items.len) : (i += 3) {
            const tri = triangles.items[i..][0..3];
            var sides: [3]f64 = undefined;
            for (0..3) |k| sides[k] = cross(points.items[tri[k]].point(), points.items[tri[(k + 1) % 3]].point(), p.point());
            if (sides[0] < -eps or sides[1] < -eps or sides[2] < -eps) {
                try next.appendSlice(scratch, tri);
                continue;
            }
            inserted = true;
            for (0..3) |k| if (sides[k] > eps) {
                try next.appendSlice(scratch, &.{ tri[k], tri[(k + 1) % 3], id });
            };
        }
        if (!inserted) return null;
        triangles = next;
        try points.append(scratch, p);
        try ids.append(scratch, id);
    }
    var fixed: std.ArrayList([2]usize) = .empty;
    for (data.edges.items) |edge| {
        if (edge.len != 2 or edge[0] >= ids.items.len or edge[1] >= ids.items.len) return null;
        const a = ids.items[edge[0]];
        const b = ids.items[edge[1]];
        if (a == b) continue;
        var stops: std.ArrayList(Stop) = .empty;
        for (points.items, 0..) |p, i| if (on(points.items[a].point(), points.items[b].point(), p.point())) {
            try stops.append(scratch, .{ .i = i, .t = along(points.items[a].point(), points.items[b].point(), p.point()) });
        };
        std.mem.sort(Stop, stops.items, {}, Stop.less);
        var s: usize = 1;
        while (s < stops.items.len) : (s += 1) {
            const u = stops.items[s - 1].i;
            const v = stops.items[s].i;
            const target = key(u, v);
            const Pair = struct { first: usize, second: ?usize = null, count: usize = 1 };
            var edges: std.AutoHashMapUnmanaged([2]usize, Pair) = .empty;
            defer edges.deinit(scratch);
            var t: usize = 0;
            while (t < triangles.items.len) : (t += 3) for (0..3) |k| {
                const pair = try edges.getOrPut(scratch, key(triangles.items[t + k], triangles.items[t + (k + 1) % 3]));
                if (pair.found_existing) {
                    pair.value_ptr.second = t;
                    pair.value_ptr.count += 1;
                } else pair.value_ptr.* = .{ .first = t };
            };
            if (!edges.contains(target)) {
                const ps = points.items;
                var current: ?usize = null;
                t = 0;
                while (t < triangles.items.len) : (t += 3) {
                    const tri = triangles.items[t..][0..3];
                    if (std.mem.indexOfScalar(usize, tri, u) == null) continue;
                    for (0..3) |k| if (crosses(ps[u].point(), ps[v].point(), ps[tri[k]].point(), ps[tri[(k + 1) % 3]].point())) {
                        current = t;
                        break;
                    };
                    if (current != null) break;
                }
                var at = current orelse return null;
                const removed = try scratch.alloc(bool, triangles.items.len / 3);
                @memset(removed, false);
                var left: std.ArrayList(usize) = .empty;
                var right: std.ArrayList(usize) = .empty;
                try left.append(scratch, u);
                try right.append(scratch, u);
                var entry: ?[2]usize = null;
                // Each step consumes a new triangle, never an attempt budget.
                while (true) {
                    if (removed[at / 3]) return null;
                    removed[at / 3] = true;
                    const tri = triangles.items[at..][0..3];
                    if (std.mem.indexOfScalar(usize, tri, v) != null) break;
                    var next: ?usize = null;
                    for (0..3) |k| {
                        const a1 = tri[k];
                        const b1 = tri[(k + 1) % 3];
                        const pair_key = key(a1, b1);
                        if (entry) |e| {
                            if (same(e, pair_key)) continue;
                        }
                        if (!crosses(ps[u].point(), ps[v].point(), ps[a1].point(), ps[b1].point())) continue;
                        const pair = edges.get(pair_key).?;
                        if (pair.count != 2) return null;
                        const second = pair.second orelse return null;
                        for (fixed.items) |f| if (same(f, pair_key)) return null;
                        for ([_]usize{ a1, b1 }) |id| {
                            const side = if (cross(ps[u].point(), ps[v].point(), ps[id].point()) > 0) &left else &right;
                            if (side.items[side.items.len - 1] != id) try side.append(scratch, id);
                        }
                        next = if (pair.first == at) second else pair.first;
                        entry = pair_key;
                        break;
                    }
                    at = next orelse return null;
                }
                try left.append(scratch, v);
                try right.append(scratch, v);
                std.mem.reverse(usize, left.items);
                var replacement: std.ArrayList(usize) = .empty;
                if (!try fillCavity(scratch, ps, &left, &replacement) or !try fillCavity(scratch, ps, &right, &replacement)) return null;
                var next: std.ArrayList(usize) = .empty;
                t = 0;
                while (t < triangles.items.len) : (t += 3) if (!removed[t / 3]) {
                    try next.appendSlice(scratch, triangles.items[t..][0..3]);
                };
                try next.appendSlice(scratch, replacement.items);
                triangles = next;
            }
            try fixed.append(scratch, target);
        }
    }
    return .{ .points = points.items, .triangles = triangles.items, .run = run };
}

pub fn complexStops(scratch: Allocator, a: Point, b: Point, model: ComplexRoof) Allocator.Error![]const RoofPoint {
    var stops: std.ArrayList(Stop) = .empty;
    for (model.points, 0..) |p, i| if (on(a, b, p.point())) {
        try stops.append(scratch, .{ .i = i, .t = along(a, b, p.point()) });
    };
    std.mem.sort(Stop, stops.items, {}, Stop.less);
    const result = try scratch.alloc(RoofPoint, stops.items.len);
    for (result, stops.items) |*p, s| p.* = model.points[s.i];
    return result;
}
