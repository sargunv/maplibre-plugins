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
const Side = struct { a: usize, b: usize, t: usize, c: usize };
const Pair = struct { key: [2]usize, sides: [2]Side = undefined, count: usize = 0 };
fn key(a: usize, b: usize) [2]usize {
    return if (a < b) .{ a, b } else .{ b, a };
}
fn same(a: [2]usize, b: [2]usize) bool {
    return a[0] == b[0] and a[1] == b[1];
}
fn triangle(points: []const RoofPoint, a: usize, b: usize, c: usize) [3]usize {
    return if (cross(points[a].point(), points[b].point(), points[c].point()) > 0) .{ a, b, c } else .{ b, a, c };
}

/// Insert vertices, then flip crossed diagonals to recover the mapped constraints.
pub fn complexRoof(scratch: Allocator, polygon: Polygon, text: []const u8, tile_id: ?Tile, extent: f64, origin: Point, run: f64) Allocator.Error!?ComplexRoof {
    const tile = tile_id orelse return null;
    if (text.len > 65536) return null;
    const Data = struct { vertices: []const []const f64, edges: []const []const usize };
    const parsed = std.json.parseFromSlice(Data, scratch, text, .{ .ignore_unknown_fields = true }) catch |err| return if (err == error.OutOfMemory) error.OutOfMemory else null;
    defer parsed.deinit();
    const data = parsed.value;
    if (data.vertices.len == 0 or data.vertices.len > 192 or data.edges.len > 576) return null;
    var count = polygon.outer.len;
    for (polygon.holes.items) |ring| count += ring.len;
    if (count > 192 or run < 1) return null;
    const base = try triangulate(scratch, polygon.outer, polygon.holes.items);
    var points: std.ArrayList(RoofPoint) = .empty;
    for (base.points) |p| try points.append(scratch, .{ .x = p.x, .y = p.y, .n = 0 });
    var triangles: std.ArrayList(usize) = .empty;
    for (base.triangles) |i| try triangles.append(scratch, i);
    var ids: std.ArrayList(usize) = .empty;
    const rings = try scratch.alloc([]const Point, 1 + polygon.holes.items.len);
    rings[0] = polygon.outer;
    for (rings[1..], polygon.holes.items) |*r, h| r.* = h;
    for (data.vertices) |v| {
        if (v.len != 3) return null;
        for (v) |value| if (!std.math.isFinite(value)) return null;
        if (@abs(v[0]) > 180 or @abs(v[1]) > 85.051129 or v[2] < 0 or v[2] > 1) return null;
        const scale = extent * std.math.pow(f64, 2, @floatFromInt(tile.z));
        const sin = @sin(v[1] * std.math.pi / 180);
        var p: RoofPoint = .{ .x = @floor((v[0] / 360 + 0.5) * scale + 0.5) - @as(f64, @floatFromInt(tile.x)) * extent - origin.x, .y = @floor((0.5 - @log((1 + sin) / (1 - sin)) / (4 * std.math.pi)) * scale + 0.5) - @as(f64, @floatFromInt(tile.y)) * extent - origin.y, .n = v[2] };
        // Cleanup removes nearly collinear eave nodes; snap them back to the boundary.
        var nearest: f64 = 0.75 * 0.75;
        var snapped = p.point();
        for (rings) |ring| for (ring, 0..) |a, i| {
            const b = ring[(i + 1) % ring.len];
            const t = std.math.clamp(along(a, b, p.point()), 0, 1);
            const q: Point = .{ .x = a.x + t * (b.x - a.x), .y = a.y + t * (b.y - a.y) };
            const d = (q.x - p.x) * (q.x - p.x) + (q.y - p.y) * (q.y - p.y);
            if (d < nearest) {
                nearest = d;
                snapped = q;
            }
        };
        p.x = snapped.x;
        p.y = snapped.y;
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
    for (data.edges) |edge| {
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
            var recovered = false;
            var edges: std.ArrayList(Pair) = .empty;
            var attempt: usize = 0;
            while (attempt < points.items.len * points.items.len) : (attempt += 1) {
                edges.clearRetainingCapacity();
                var t: usize = 0;
                while (t < triangles.items.len) : (t += 3) for (0..3) |k| {
                    const side: Side = .{ .a = triangles.items[t + k], .b = triangles.items[t + (k + 1) % 3], .c = triangles.items[t + (k + 2) % 3], .t = t };
                    const pair_key = key(side.a, side.b);
                    var index: usize = edges.items.len;
                    for (edges.items, 0..) |pair, j| if (same(pair.key, pair_key)) {
                        index = j;
                        break;
                    };
                    if (index == edges.items.len) try edges.append(scratch, .{ .key = pair_key });
                    const pair = &edges.items[index];
                    if (pair.count < 2) pair.sides[pair.count] = side;
                    pair.count += 1;
                };
                for (edges.items) |pair| if (same(pair.key, target)) {
                    recovered = true;
                    break;
                };
                if (recovered) break;
                var flipped = false;
                for (edges.items) |pair| {
                    if (pair.count != 2) continue;
                    var locked = false;
                    for (fixed.items) |k| if (same(k, pair.key)) {
                        locked = true;
                        break;
                    };
                    if (locked) continue;
                    const e = pair.sides[0];
                    const f = pair.sides[1];
                    const ps = points.items;
                    if (!crosses(ps[u].point(), ps[v].point(), ps[e.a].point(), ps[e.b].point()) or !crosses(ps[e.a].point(), ps[e.b].point(), ps[e.c].point(), ps[f.c].point())) continue;
                    if (attempt % 2 == 0 and crosses(ps[u].point(), ps[v].point(), ps[e.c].point(), ps[f.c].point())) continue;
                    @memcpy(triangles.items[e.t..][0..3], &triangle(ps, e.c, f.c, e.a));
                    @memcpy(triangles.items[f.t..][0..3], &triangle(ps, f.c, e.c, e.b));
                    flipped = true;
                    break;
                }
                if (!flipped and attempt % 2 == 1) return null;
            }
            if (!recovered) return null;
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
