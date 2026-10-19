//! Unit tests of the footprint helpers and the triangulator, the twin of
//! ../../js/src/footprint.test.ts. Both twins are also covered through the
//! shared layout fixtures; these pin the pieces' own contracts.

const std = @import("std");
const testing = std.testing;

const footprint = @import("footprint.zig");
const classifyRings = footprint.classifyRings;
const isClipEdge = footprint.isClipEdge;
const minimumAreaRectangle = footprint.minimumAreaRectangle;
const Point = footprint.Point;
const signedArea2 = footprint.signedArea2;
const simplifyRing = footprint.simplifyRing;
const triangulate = @import("triangulate.zig").triangulate;

fn ring(comptime points: []const [2]f64) []const Point {
    const result = comptime blk: {
        var out: [points.len]Point = undefined;
        for (points, &out) |p, *q| q.* = .{ .x = p[0], .y = p[1] };
        break :blk out;
    };
    return &result;
}

const square = ring(&.{ .{ 0, 0 }, .{ 100, 0 }, .{ 100, 100 }, .{ 0, 100 } });

fn triangleArea2(points: []const Point, t: []const u32, i: usize) f64 {
    const a = points[t[i]];
    const b = points[t[i + 1]];
    const c = points[t[i + 2]];
    return (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
}

fn sumArea2(points: []const Point, triangles: []const u32) f64 {
    var sum: f64 = 0;
    var t: usize = 0;
    while (t < triangles.len) : (t += 3) sum += triangleArea2(points, triangles, t);
    return sum;
}

test "simplifyRing drops repeated, closing, collinear and spike points" {
    var arena = std.heap.ArenaAllocator.init(testing.allocator);
    defer arena.deinit();
    const simplified = try simplifyRing(arena.allocator(), ring(&.{
        .{ 0, 0 },    .{ 0, 0 },     .{ 50, 0 },   .{ 100, 0 }, .{ 100, 50 }, .{ 180, 50 },
        .{ 100, 50 }, .{ 100, 100 }, .{ 50, 100 }, .{ 0, 100 }, .{ 0, 0 },
    }), 8192, .no_cuts);
    try testing.expectEqualSlices(Point, square, simplified);
}

test "simplifyRing drops jitter within half a unit and keeps larger kinks" {
    var arena = std.heap.ArenaAllocator.init(testing.allocator);
    defer arena.deinit();
    const allocator = arena.allocator();
    try testing.expectEqual(3, (try simplifyRing(allocator, ring(&.{ .{ 0, 0 }, .{ 1000, 0 }, .{ 2000, 1 }, .{ 2000, 1000 } }), 8192, .no_cuts)).len);
    try testing.expectEqual(4, (try simplifyRing(allocator, ring(&.{ .{ 0, 0 }, .{ 1000, 1 }, .{ 2000, 0 }, .{ 2000, 1000 } }), 8192, .no_cuts)).len);
}

test "simplifyRing never merges a tile cut into a real wall" {
    var arena = std.heap.ArenaAllocator.init(testing.allocator);
    defer arena.deinit();
    // (-128, 500) is nearly collinear with its neighbors but ends a cut.
    const input = ring(&.{
        .{ -128, 100 }, .{ 100, 100 }, .{ 100, 2000 }, .{ -127, 2000 }, .{ -128, 500 },
    });
    var bounds: footprint.TileBounds = .no_cuts;
    for (input) |p| bounds.add(p);
    const contains = struct {
        fn f(points: []const Point) bool {
            for (points) |p| if (p.x == -128 and p.y == 500) return true;
            return false;
        }
    }.f;
    try testing.expect(contains(try simplifyRing(arena.allocator(), input, 8192, bounds)));
    // Without a cut line there, it is jitter on a wall.
    try testing.expect(!contains(try simplifyRing(arena.allocator(), input, 8192, .no_cuts)));
}

test "simplifyRing returns nothing for rings that collapse" {
    var arena = std.heap.ArenaAllocator.init(testing.allocator);
    defer arena.deinit();
    try testing.expectEqual(0, (try simplifyRing(arena.allocator(), ring(&.{ .{ 0, 0 }, .{ 10, 0 }, .{ 20, 0 } }), 8192, .no_cuts)).len);
}

fn edge(ax: f64, ay: f64, bx: f64, by: f64) bool {
    // A tile whose features reach x = -128 and y = 8320.
    const bounds: footprint.TileBounds = .{ .min_x = -128, .min_y = 100, .max_x = 8000, .max_y = 8320 };
    return isClipEdge(.{ .x = ax, .y = ay }, .{ .x = bx, .y = by }, 8192, bounds);
}

test "isClipEdge accepts axis-aligned edges on the tile's bounds outside the tile" {
    try testing.expect(edge(-128, 200, -128, 300));
    try testing.expect(edge(0, 8320, 50, 8320));
    // Inside the tile, on its border, or slanted: never a cut.
    try testing.expect(!edge(0, 200, 0, 300));
    try testing.expect(!edge(-128, 200, -127, 300));
    // Outside the tile but not on its bounds: a real wall in the buffer.
    try testing.expect(!edge(-100, 200, -100, 300));
    try testing.expect(!edge(0, 8300, 50, 8300));
    // On the bounds but inside the tile: the clip line is beyond it.
    try testing.expect(!edge(8000, 200, 8000, 300));
    try testing.expect(!edge(0, 100, 50, 100));
    try testing.expect(!isClipEdge(.{ .x = -1, .y = 0 }, .{ .x = -1, .y = 50 }, 8192, .no_cuts));
}

test "hasCollapsedCut finds cuts that collapsed to a repeated point" {
    var arena = std.heap.ArenaAllocator.init(testing.allocator);
    defer arena.deinit();
    const bounds: footprint.TileBounds = .{ .min_x = -128, .min_y = 100, .max_x = 8000, .max_y = 8320 };
    const tip = ring(&.{ .{ -128, 500 }, .{ -128, 500 }, .{ 0, 400 }, .{ 100, 600 } });
    try testing.expect(footprint.hasCollapsedCut(tip, 8192, bounds));
    // Closed, and repeated at the wrap.
    try testing.expect(footprint.hasCollapsedCut(ring(&.{ .{ -128, 500 }, .{ 0, 400 }, .{ 100, 600 }, .{ -128, 500 }, .{ -128, 500 } }), 8192, bounds));
    // A closing point, or a repeat off the cut lines, is not a cut.
    try testing.expect(!footprint.hasCollapsedCut(ring(&.{ .{ -128, 500 }, .{ 0, 400 }, .{ 100, 600 }, .{ -128, 500 } }), 8192, bounds));
    try testing.expect(!footprint.hasCollapsedCut(ring(&.{ .{ 10, 500 }, .{ 10, 500 }, .{ 0, 400 }, .{ 100, 600 } }), 8192, bounds));
    try testing.expect((try classifyRings(arena.allocator(), &.{tip}, 8192, bounds))[0].cut);
}

test "TileBounds holds every point it is given" {
    var bounds: footprint.TileBounds = .no_cuts;
    for ([_]Point{ .{ .x = 5, .y = 6 }, .{ .x = -3, .y = 9 }, .{ .x = 2, .y = -4 } }) |p| bounds.add(p);
    try testing.expectEqual(footprint.TileBounds{ .min_x = -3, .min_y = -4, .max_x = 5, .max_y = 9 }, bounds);
}

test "classifyRings groups holes under the exterior before them and normalizes winding" {
    var arena = std.heap.ArenaAllocator.init(testing.allocator);
    defer arena.deinit();
    const allocator = arena.allocator();
    const hole = ring(&.{ .{ 20, 20 }, .{ 20, 80 }, .{ 80, 80 }, .{ 80, 20 } });
    const other = ring(&.{ .{ 200, 0 }, .{ 300, 0 }, .{ 300, 100 }, .{ 200, 100 } });
    const polygons = try classifyRings(allocator, &.{ square, hole, other }, 8192, .no_cuts);
    try testing.expectEqual(2, polygons.len);
    try testing.expectEqual(1, polygons[0].holes.items.len);
    try testing.expect(signedArea2(polygons[0].outer) > 0);
    try testing.expect(signedArea2(polygons[0].holes.items[0]) < 0);

    // The same feature in reversed winding classifies the same way.
    var reversed: [3][]const Point = undefined;
    for (&reversed, [_][]const Point{ square, hole, other }) |*r, original| {
        const copy = try allocator.dupe(Point, original);
        std.mem.reverse(Point, copy);
        r.* = copy;
    }
    const again = try classifyRings(allocator, &reversed, 8192, .no_cuts);
    try testing.expectEqual(2, again.len);
    try testing.expectEqual(1, again[0].holes.items.len);
    try testing.expect(signedArea2(again[0].outer) > 0);
    try testing.expect(signedArea2(again[0].holes.items[0]) < 0);
}

const cut_bounds: footprint.TileBounds = .{ .min_x = -128, .min_y = -128, .max_x = 8320, .max_y = 8320 };

fn cutAt(allocator: std.mem.Allocator, comptime x0: f64, comptime y0: f64, comptime x1: f64, comptime y1: f64) !bool {
    const box = ring(&.{ .{ x0, y0 }, .{ x1, y0 }, .{ x1, y1 }, .{ x0, y1 } });
    return (try classifyRings(allocator, &.{box}, 8192, cut_bounds))[0].cut;
}

test "classifyRings marks polygons the source cut" {
    var arena = std.heap.ArenaAllocator.init(testing.allocator);
    defer arena.deinit();
    const allocator = arena.allocator();
    // The tile's features reach x = -128 and x = 8320.
    try testing.expect(try cutAt(allocator, -128, 0, 100, 100));
    try testing.expect(try cutAt(allocator, 8000, 8000, 8320, 8320));
    try testing.expect(try cutAt(allocator, -128, -128, 8320, 8320));
    // Crossing the tile's edge or only in its buffer, but whole.
    try testing.expect(!try cutAt(allocator, -64, 0, 100, 100));
    try testing.expect(!try cutAt(allocator, -100, -100, -1, -1));
    try testing.expect(!try cutAt(allocator, 8192, 0, 8300, 100));
    try testing.expect(!try cutAt(allocator, 0, 0, 100, 100));
    // A courtyard cannot be cut alone, but a cut exterior marks the polygon.
    const outer = ring(&.{ .{ -128, 0 }, .{ 300, 0 }, .{ 300, 300 }, .{ -128, 300 } });
    const hole = ring(&.{ .{ 100, 100 }, .{ 100, 200 }, .{ 200, 200 }, .{ 200, 100 } });
    const polygon = (try classifyRings(allocator, &.{ outer, hole }, 8192, cut_bounds))[0];
    try testing.expectEqual(1, polygon.holes.items.len);
    try testing.expect(polygon.cut);
}

test "minimumAreaRectangle finds the sides of a rotated rectangle" {
    const c = @cos(std.math.pi / 6.0);
    const s = @sin(std.math.pi / 6.0);
    var corners: [4]Point = undefined;
    for (&corners, [_][2]f64{ .{ -150, -80 }, .{ 150, -80 }, .{ 150, 80 }, .{ -150, 80 } }) |*p, q| {
        p.* = .{ .x = 1000 + q[0] * c - q[1] * s, .y = 1000 + q[0] * s + q[1] * c };
    }
    const rect = (try minimumAreaRectangle(testing.allocator, &corners)).?;
    try testing.expectApproxEqAbs(150, rect.half_long, 1e-6);
    try testing.expectApproxEqAbs(80, rect.half_short, 1e-6);
    try testing.expectApproxEqAbs(1000, rect.center.x, 1e-6);
    try testing.expectApproxEqAbs(1000, rect.center.y, 1e-6);
    try testing.expectApproxEqAbs(1, @abs(rect.long.x * c + rect.long.y * s), 1e-9);
    try testing.expectApproxEqAbs(0, rect.long.x * rect.short.x + rect.long.y * rect.short.y, 1e-12);
}

test "minimumAreaRectangle returns null for collinear points" {
    try testing.expectEqual(null, try minimumAreaRectangle(testing.allocator, ring(&.{ .{ 0, 0 }, .{ 10, 10 }, .{ 20, 20 } })));
}

test "triangulate covers a concave polygon with positive triangles" {
    const u = ring(&.{ .{ 0, 0 }, .{ 100, 0 }, .{ 100, 200 }, .{ 300, 200 }, .{ 300, 0 }, .{ 400, 0 }, .{ 400, 300 }, .{ 0, 300 } });
    const result = try triangulate(testing.allocator, u, &.{});
    defer result.deinit(testing.allocator);
    try testing.expectEqual(3 * (u.len - 2), result.triangles.len);
    var t: usize = 0;
    while (t < result.triangles.len) : (t += 3) try testing.expect(triangleArea2(result.points, result.triangles, t) > 0);
    try testing.expectEqual(signedArea2(u), sumArea2(result.points, result.triangles));
}

test "triangulate bridges holes" {
    const outer = ring(&.{ .{ 0, 0 }, .{ 400, 0 }, .{ 400, 300 }, .{ 0, 300 } });
    const holes = [_][]const Point{
        ring(&.{ .{ 50, 50 }, .{ 50, 100 }, .{ 150, 100 }, .{ 150, 50 } }),
        ring(&.{ .{ 250, 150 }, .{ 250, 250 }, .{ 350, 250 }, .{ 350, 150 } }),
    };
    const result = try triangulate(testing.allocator, outer, &holes);
    defer result.deinit(testing.allocator);
    var t: usize = 0;
    while (t < result.triangles.len) : (t += 3) try testing.expect(triangleArea2(result.points, result.triangles, t) > 0);
    const expected = signedArea2(outer) + signedArea2(holes[0]) + signedArea2(holes[1]);
    try testing.expectEqual(expected, sumArea2(result.points, result.triangles));
}

test "triangulate keeps holes open where rings touch at a point" {
    const outer = ring(&.{ .{ 0, 0 }, .{ 400, 0 }, .{ 400, 300 }, .{ 0, 300 } });
    const cases = [_][]const []const Point{
        // A hole touching the exterior at a corner.
        &.{ring(&.{ .{ 0, 0 }, .{ 50, 100 }, .{ 100, 50 } })},
        // Two holes touching at a corner.
        &.{
            ring(&.{ .{ 50, 50 }, .{ 50, 150 }, .{ 150, 150 }, .{ 150, 50 } }),
            ring(&.{ .{ 150, 150 }, .{ 150, 250 }, .{ 250, 250 }, .{ 250, 150 } }),
        },
    };
    for (cases) |holes| {
        const result = try triangulate(testing.allocator, outer, holes);
        defer result.deinit(testing.allocator);
        var t: usize = 0;
        while (t < result.triangles.len) : (t += 3) try testing.expect(triangleArea2(result.points, result.triangles, t) > 0);
        var expected = signedArea2(outer);
        for (holes) |hole| expected += signedArea2(hole);
        try testing.expectEqual(expected, sumArea2(result.points, result.triangles));
    }
}

test "triangulate does not span a ring that touches itself" {
    // Two squares meeting at (100, 100), as one ring.
    const pinched = ring(&.{ .{ 0, 0 }, .{ 100, 0 }, .{ 100, 100 }, .{ 200, 100 }, .{ 200, 200 }, .{ 100, 200 }, .{ 100, 100 }, .{ 0, 100 } });
    const result = try triangulate(testing.allocator, pinched, &.{});
    defer result.deinit(testing.allocator);
    try testing.expectEqual(signedArea2(pinched), sumArea2(result.points, result.triangles));
}

test "triangulate terminates on a self-intersecting ring" {
    const bowtie = ring(&.{ .{ 0, 0 }, .{ 100, 100 }, .{ 100, 0 }, .{ 0, 100 } });
    const result = try triangulate(testing.allocator, bowtie, &.{});
    defer result.deinit(testing.allocator);
    try testing.expect(result.triangles.len <= 6);
}
