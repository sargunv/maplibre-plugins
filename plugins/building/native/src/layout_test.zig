//! Runs every case in ../../fixtures/layout through the same checks as the
//! TypeScript twin's tests (../../js/src/layout.test.ts), then checks the
//! geometric invariants the shaders rely on and the semantics of each roof
//! shape.

const std = @import("std");
const testing = std.testing;
const Allocator = std.mem.Allocator;

const build_options = @import("build_options");
const fixture = @import("fixture.zig");
const layout = @import("layout.zig");
const BuildingLayout = layout.BuildingLayout;
const LayoutValues = layout.LayoutValues;
const max_segment_vertices = layout.max_segment_vertices;
const Point = layout.Point;
const roof_kind = layout.roof_kind;
const roof_underside = layout.roof_underside;
const Vertex = layout.Vertex;
const wall_bottom = layout.wall_bottom;
const wall_top = layout.wall_top;

/// Shapes drawn with smooth gradients, exempt from the planar check.
const smooth_shapes = [_][]const u8{ "round", "round_gabled", "cone", "dome", "onion" };

fn isSmooth(shape: []const u8) bool {
    for (smooth_shapes) |s| if (std.mem.eql(u8, s, shape)) return true;
    return false;
}

fn expectClose(actual: f64, expected: f64, what: []const u8) !void {
    if (!fixture.close(actual, expected)) {
        std.debug.print("{s}: {d} is not close to {d}\n", .{ what, actual, expected });
        return error.TestExpectedClose;
    }
}

/// Vitest's toBeCloseTo: |actual - expected| < 10^-digits / 2.
fn expectCloseTo(actual: f64, expected: f64, digits: comptime_int) !void {
    const tolerance = std.math.pow(f64, 10, -digits) / 2;
    if (!(@abs(actual - expected) < tolerance)) {
        std.debug.print("{d} is not close to {d} ({d} digits)\n", .{ actual, expected, digits });
        return error.TestExpectedCloseTo;
    }
}

fn lay(allocator: Allocator, rings: []const []const Point, values: LayoutValues) !BuildingLayout {
    var result: BuildingLayout = .init(allocator, 8192);
    errdefer result.deinit();
    try result.addFeature(rings, 0, values);
    return result;
}

fn isWall(v: Vertex) bool {
    return v.kind == wall_bottom or v.kind == wall_top;
}

/// The feature index of each feature's shape.
const ShapeOf = struct {
    map: ?*const std.AutoHashMapUnmanaged(u64, []const u8) = null,
    fallback: []const u8 = "flat",

    fn get(self: ShapeOf, feature_index: u64) []const u8 {
        if (self.map) |map| if (map.get(feature_index)) |shape| return shape;
        return self.fallback;
    }
};

/// Edges keyed by position and n, for the closed-surface check. Coarse
/// keys: facets meeting at one point may compute it a few ulps apart.
const VertexKey = struct { x: i64, y: i64, n: i64 };
const EdgeKey = struct { from: VertexKey, to: VertexKey };

/// JavaScript's Math.round: half-way cases go up.
fn jsRound(value: f64) i64 {
    return @intFromFloat(@floor(value + 0.5));
}

fn vertexKey(v: Vertex) VertexKey {
    return .{
        .x = jsRound(@as(f64, v.x) * 100),
        .y = jsRound(@as(f64, v.y) * 100),
        .n = jsRound(@as(f64, v.n) * 1e4),
    };
}

const Edges = struct {
    allocator: Allocator,
    counts: std.AutoHashMapUnmanaged(EdgeKey, u32) = .empty,
    ends: std.AutoHashMapUnmanaged(EdgeKey, [2]Vertex) = .empty,

    fn deinit(self: *Edges) void {
        self.counts.deinit(self.allocator);
        self.ends.deinit(self.allocator);
    }

    fn add(self: *Edges, a: Vertex, b: Vertex) !void {
        const ka = vertexKey(a);
        const kb = vertexKey(b);
        if (std.meta.eql(ka, kb)) return;
        const forward: EdgeKey = .{ .from = ka, .to = kb };
        const backward: EdgeKey = .{ .from = kb, .to = ka };
        const reverse = self.counts.get(backward) orelse 0;
        if (reverse > 0) {
            try self.counts.put(self.allocator, backward, reverse - 1);
        } else {
            try self.counts.put(self.allocator, forward, (self.counts.get(forward) orelse 0) + 1);
            try self.ends.put(self.allocator, forward, .{ a, b });
        }
    }
};

/// Checks that hold for every layout, whatever its input.
fn checkInvariants(allocator: Allocator, result: *const BuildingLayout, extent: f64, shape_of: ShapeOf) !void {
    const vertices = result.vertices.items;
    const indices = result.indices.items;

    // Segments tile the buffers and stay within 16-bit indices.
    var vertex_offset: u32 = 0;
    var index_offset: u32 = 0;
    for (result.segments.items) |segment| {
        try testing.expectEqual(vertex_offset, segment.vertex_offset);
        try testing.expectEqual(index_offset, segment.index_offset);
        try testing.expect(segment.vertex_length <= max_segment_vertices);
        try testing.expectEqual(0, segment.index_length % 3);
        for (indices[segment.index_offset..][0..segment.index_length]) |index|
            try testing.expect(index < segment.vertex_length);
        vertex_offset += segment.vertex_length;
        index_offset += segment.index_length;
    }
    try testing.expectEqual(result.vertexCount(), vertex_offset);
    try testing.expectEqual(result.indexCount(), index_offset);

    // Ranges cover every vertex once, in order.
    var next: u32 = 0;
    for (result.ranges.items) |range| {
        try testing.expectEqual(next, range.first_vertex);
        try testing.expect(range.vertex_count > 0);
        next += range.vertex_count;
    }
    try testing.expectEqual(result.vertexCount(), next);

    for (vertices) |v| {
        try testing.expect(v.kind == wall_bottom or v.kind == wall_top or v.kind == roof_kind or v.kind == roof_underside);
        try testing.expect(v.n >= 0);
        try testing.expect(v.n <= 1);
        if (v.kind == wall_bottom) try testing.expectEqual(0, v.n);
        if (isWall(v)) try expectClose(std.math.hypot(@as(f64, v.gx), @as(f64, v.gy)), 1, "wall normal length");
    }

    var edges: Edges = .{ .allocator = allocator };
    defer edges.deinit();

    const all = try fixture.triangles(allocator, result);
    defer allocator.free(all);
    for (all) |tri| {
        const a = vertices[tri[0]];
        const b = vertices[tri[1]];
        const c = vertices[tri[2]];
        var feature_index: u64 = std.math.maxInt(u64);
        for (result.ranges.items) |range| {
            if (tri[0] < range.first_vertex + range.vertex_count) {
                feature_index = range.feature_index;
                break;
            }
        }
        const shape = shape_of.get(feature_index);
        if (isWall(a)) {
            try testing.expect(isWall(b) and isWall(c));
            try testing.expectEqual(a.gx, b.gx);
            try testing.expectEqual(a.gy, b.gy);
            // Core's winding: cross(b - a, c - a) against the outward normal.
            const u = [3]f64{ @as(f64, b.x) - a.x, @as(f64, b.y) - a.y, wallZ(b) - wallZ(a) };
            const w = [3]f64{ @as(f64, c.x) - a.x, @as(f64, c.y) - a.y, wallZ(c) - wallZ(a) };
            const nx = u[1] * w[2] - u[2] * w[1];
            const ny = u[2] * w[0] - u[0] * w[2];
            const nz = u[0] * w[1] - u[1] * w[0];
            try testing.expect(@abs(nz) < 1e-3 * std.math.hypot(nx, ny));
            try testing.expect(nx * a.gx + ny * a.gy < 0);
            // Only the top edge joins the roof.
            const corners = [3]Vertex{ a, b, c };
            var tops: usize = 0;
            var other: usize = 0;
            for (corners, 0..) |v, i| {
                if (v.kind == wall_top) tops += 1 else other = i;
            }
            if (tops == 2) try edges.add(corners[(other + 1) % 3], corners[(other + 2) % 3]);
            continue;
        }
        try testing.expect(a.kind == b.kind and b.kind == c.kind);
        const area2 = (@as(f64, b.x) - a.x) * (@as(f64, c.y) - a.y) - (@as(f64, b.y) - a.y) * (@as(f64, c.x) - a.x);
        if (a.kind == roof_kind) try testing.expect(area2 < 0) else try testing.expect(area2 > 0);
        if (!isSmooth(shape)) {
            // Planar: one gradient per triangle, and n follows it.
            try testing.expectEqual(a.gx, b.gx);
            try testing.expectEqual(a.gy, b.gy);
            try testing.expectEqual(a.gx, c.gx);
            try testing.expectEqual(a.gy, c.gy);
            for ([_]Vertex{ b, c }) |v| {
                const predicted = @as(f64, a.n) + @as(f64, a.gx) * (@as(f64, v.x) - a.x) + @as(f64, a.gy) * (@as(f64, v.y) - a.y);
                try testing.expect(@abs(predicted - v.n) < 2e-4);
            }
        }
        try edges.add(a, b);
        try edges.add(b, c);
        try edges.add(c, a);
    }

    // Closed surface: every roof edge meets another roof edge or a wall top
    // running the other way, except along tile cuts, which have no walls.
    var it = edges.counts.iterator();
    while (it.next()) |entry| {
        if (entry.value_ptr.* == 0) continue;
        const ends = edges.ends.get(entry.key_ptr.*).?;
        const a = ends[0];
        const b = ends[1];
        const on_cut = (a.x == b.x and (a.x < 0 or a.x > extent)) or
            (a.y == b.y and (a.y < 0 or a.y > extent));
        if (!on_cut or isWall(a)) {
            std.debug.print("open edge ({d}, {d}, n {d}, kind {d}) → ({d}, {d}, n {d})\n", .{ a.x, a.y, a.n, a.kind, b.x, b.y, b.n });
            return error.TestOpenEdge;
        }
    }
}

fn wallZ(v: Vertex) f64 {
    return if (v.kind == wall_bottom) 0 else 1 + @as(f64, v.n);
}

// ---- Layout fixtures ---------------------------------------------------------

test "finds the layout fixtures" {
    try testing.expect(build_options.layout_fixtures.len > 0);
    try testing.expectEqual(build_options.layout_fixture_names.len, build_options.layout_fixtures.len);
}

fn expectFixtureMatches(name: []const u8, text: []const u8) !void {
    const allocator = testing.allocator;
    var parsed = try fixture.parse(allocator, text);
    defer parsed.deinit();
    const case = parsed.value;
    var result = try fixture.layOut(allocator, case.extent, case.features);
    defer result.deinit();
    const expected = case.expected;
    try testing.expectEqual(expected.vertex_count, result.vertexCount());
    try testing.expectEqual(expected.index_count, result.indexCount());
    try testing.expectEqual(expected.segments.len, result.segments.items.len);
    for (expected.segments, result.segments.items) |e, s|
        try testing.expectEqual(e, [4]u32{ s.vertex_offset, s.index_offset, s.vertex_length, s.index_length });
    try testing.expectEqual(expected.ranges.len, result.ranges.items.len);
    for (expected.ranges, result.ranges.items) |e, r|
        try testing.expectEqual(e, [3]u64{ r.feature_index, r.first_vertex, r.vertex_count });

    const summaries = try fixture.summarize(allocator, &result);
    defer allocator.free(summaries);
    try testing.expectEqual(expected.summaries.len, summaries.len);
    var what_buffer: [256]u8 = undefined;
    for (summaries, expected.summaries, result.ranges.items) |s, e, range| {
        const what = try std.fmt.bufPrint(&what_buffer, "{s} feature {d}", .{ name, range.feature_index });
        errdefer std.debug.print("in {s}\n", .{what});
        try testing.expectEqual(e.vertices, s.vertices);
        try testing.expectEqual(e.triangles, s.triangles);
        for (s.sum_pos, e.sum_pos) |actual, wanted| try expectClose(actual, wanted, "sum_pos");
        for (s.sum_roof, e.sum_roof) |actual, wanted| try expectClose(actual, wanted, "sum_roof");
        try expectClose(s.weighted, e.weighted, "weighted");
        try testing.expectEqual(e.moment, s.moment);
    }

    if (expected.positions) |positions| {
        try testing.expectEqualSlices(u16, expected.indices.?, result.indices.items);
        const roofs = expected.roofs.?;
        try testing.expectEqual(positions.len, result.vertices.items.len);
        for (result.vertices.items, positions, roofs, 0..) |v, p, r, i| {
            errdefer std.debug.print("{s} vertex {d}\n", .{ name, i });
            for ([3]f32{ v.x, v.y, v.run }, p) |actual, wanted| try expectClose(actual, wanted, "position");
            for ([4]f32{ v.n, v.kind, v.gx, v.gy }, r) |actual, wanted| try expectClose(actual, wanted, "roof");
        }
    }
}

fn expectFixtureInvariants(text: []const u8) !void {
    const allocator = testing.allocator;
    var parsed = try fixture.parse(allocator, text);
    defer parsed.deinit();
    const case = parsed.value;
    var result = try fixture.layOut(allocator, case.extent, case.features);
    defer result.deinit();
    var shapes: std.AutoHashMapUnmanaged(u64, []const u8) = .empty;
    defer shapes.deinit(allocator);
    for (case.features) |f| {
        for (0..f.repeat) |k| try shapes.put(allocator, f.index + k, f.shape);
    }
    try checkInvariants(allocator, &result, @floatFromInt(case.extent), .{ .map = &shapes });
}

// Each fixture is checked even when an earlier one fails, so one run names
// every file that disagrees.

test "matches every layout fixture" {
    var failed: usize = 0;
    for (build_options.layout_fixture_names, build_options.layout_fixtures) |name, text| {
        expectFixtureMatches(name, text) catch |err| {
            std.debug.print("layout fixture {s} does not match: {s}\n", .{ name, @errorName(err) });
            failed += 1;
        };
    }
    try testing.expectEqual(0, failed);
}

test "keeps the invariants on every layout fixture" {
    var failed: usize = 0;
    for (build_options.layout_fixture_names, build_options.layout_fixtures) |name, text| {
        expectFixtureInvariants(text) catch |err| {
            std.debug.print("layout fixture {s} breaks an invariant: {s}\n", .{ name, @errorName(err) });
            failed += 1;
        };
    }
    try testing.expectEqual(0, failed);
}

// ---- Roof shapes -------------------------------------------------------------

/// A 300 × 160 rectangle centered on (1150, 1080): b = 80, a = 150.
const rectangle = [_]Point{
    .{ .x = 1000, .y = 1000 },
    .{ .x = 1300, .y = 1000 },
    .{ .x = 1300, .y = 1160 },
    .{ .x = 1000, .y = 1160 },
};

fn filter(allocator: Allocator, result: *const BuildingLayout, comptime keep: fn (Vertex) bool) ![]Vertex {
    var list: std.ArrayList(Vertex) = .empty;
    for (result.vertices.items) |v| if (keep(v)) try list.append(allocator, v);
    return list.items;
}

fn isRoof(v: Vertex) bool {
    return v.kind >= roof_kind;
}

fn isWallTop(v: Vertex) bool {
    return v.kind == wall_top;
}

/// The roof vertices of one feature laid out alone.
fn roofOf(allocator: Allocator, rings: []const []const Point, values: LayoutValues) ![]Vertex {
    const result = try lay(allocator, rings, values);
    return filter(allocator, &result, isRoof);
}

fn wallTopsOf(allocator: Allocator, rings: []const []const Point, values: LayoutValues) ![]Vertex {
    const result = try lay(allocator, rings, values);
    return filter(allocator, &result, isWallTop);
}

test "runs a gabled ridge along the longer side, or across" {
    var arena = std.heap.ArenaAllocator.init(testing.allocator);
    defer arena.deinit();
    const allocator = arena.allocator();
    const along = try roofOf(allocator, &.{&rectangle}, .{ .shape = "gabled" });
    var ridge: usize = 0;
    for (along) |v| if (v.n == 1) {
        ridge += 1;
        try testing.expectEqual(1080, v.y);
    };
    try testing.expect(ridge > 0);
    for (along) |v| try expectCloseTo(@abs(v.gy), 1.0 / 80.0, 7);
    try testing.expectEqual(80, along[0].run);

    const across = try roofOf(allocator, &.{&rectangle}, .{ .shape = "gabled", .orientation = "across" });
    for (across) |v| if (v.n == 1) try testing.expectEqual(1150, v.x);
    try testing.expectEqual(150, across[0].run);
}

test "raises the gable end walls to the ridge" {
    var arena = std.heap.ArenaAllocator.init(testing.allocator);
    defer arena.deinit();
    const tops = try wallTopsOf(arena.allocator(), &.{&rectangle}, .{ .shape = "gabled" });
    var ridge: std.ArrayList([2]f32) = .empty;
    for (tops) |v| if (v.n == 1) try ridge.append(arena.allocator(), .{ v.x, v.y });
    try testing.expectEqualSlices([2]f32, &.{ .{ 1300, 1080 }, .{ 1000, 1080 } }, ridge.items);
}

test "turns the frame toward a set direction" {
    var arena = std.heap.ArenaAllocator.init(testing.allocator);
    defer arena.deinit();
    const allocator = arena.allocator();
    // 30° is nearer north than east: the ridge runs east-west.
    for (try roofOf(allocator, &.{&rectangle}, .{ .shape = "gabled", .direction = 30 })) |v|
        if (v.n == 1) try testing.expectEqual(1080, v.y);
    // 60° is nearer east: the ridge runs north-south, whatever orientation says.
    for (try roofOf(allocator, &.{&rectangle}, .{ .shape = "gabled", .direction = 60, .orientation = "along" })) |v|
        if (v.n == 1) try testing.expectEqual(1150, v.x);
}

test "slopes a skillion exactly down its direction" {
    var arena = std.heap.ArenaAllocator.init(testing.allocator);
    defer arena.deinit();
    const allocator = arena.allocator();
    const degrees: f64 = 200;
    const r = degrees * std.math.pi / 180.0;
    const d: Point = .{ .x = @sin(r), .y = -@cos(r) };
    const skillion = try roofOf(allocator, &.{&rectangle}, .{ .shape = "skillion", .direction = degrees });
    var min_n: f32 = std.math.inf(f32);
    var max_n: f32 = -std.math.inf(f32);
    for (skillion) |v| {
        const length = std.math.hypot(@as(f64, v.gx), @as(f64, v.gy));
        try expectCloseTo(-v.gx / length, d.x, 6);
        try expectCloseTo(-v.gy / length, d.y, 6);
        min_n = @min(min_n, v.n);
        max_n = @max(max_n, v.n);
    }
    try testing.expectEqual(0, min_n);
    try testing.expectEqual(1, max_n);
    // Without a direction it falls toward +v, south for this ridge.
    for (try roofOf(allocator, &.{&rectangle}, .{ .shape = "skillion" })) |v| try testing.expect(v.gy < 0);
}

test "turns a saltbox's long face toward its direction" {
    var arena = std.heap.ArenaAllocator.init(testing.allocator);
    defer arena.deinit();
    // Facing north: front eaves on y = 1000, ridge 0.7 × 160 behind them,
    // back eaves at n = 4/7.
    const saltbox = try roofOf(arena.allocator(), &.{&rectangle}, .{ .shape = "saltbox", .direction = 0 });
    for (saltbox) |v| {
        if (v.n == 1) try expectCloseTo(v.y, 1112, 3);
        if (v.y == 1000) try testing.expectEqual(0, v.n);
        if (v.y == 1160) try expectCloseTo(v.n, 4.0 / 7.0, 6);
    }
    try expectCloseTo(saltbox[0].run, 112, 4);
}

test "gives a hipped roof equal slopes" {
    var arena = std.heap.ArenaAllocator.init(testing.allocator);
    defer arena.deinit();
    const allocator = arena.allocator();
    for (try roofOf(allocator, &.{&rectangle}, .{ .shape = "hipped" })) |v|
        try expectCloseTo(std.math.hypot(@as(f64, v.gx), @as(f64, v.gy)), 1.0 / 80.0, 7);
    // On a square the hips meet in a point.
    const square = [_]Point{ .{ .x = 0, .y = 0 }, .{ .x = 200, .y = 0 }, .{ .x = 200, .y = 200 }, .{ .x = 0, .y = 200 } };
    for (try roofOf(allocator, &.{&square}, .{ .shape = "hipped" })) |v|
        if (v.n == 1) try testing.expect(v.x == 100 and v.y == 100);
}

test "cuts a half-hipped roof's hips at 2/3 of the end wall" {
    var arena = std.heap.ArenaAllocator.init(testing.allocator);
    defer arena.deinit();
    const tops = try wallTopsOf(arena.allocator(), &.{&rectangle}, .{ .shape = "half-hipped" });
    var found = false;
    for (tops) |v| {
        if (v.x != 1300) continue;
        // b / 3 = 26.67 either side of the ridge line.
        if (@abs(@as(f64, v.y) - 1080) <= 80.0 / 3.0 + 1e-3) try expectCloseTo(v.n, 2.0 / 3.0, 5);
        found = found or @abs(@as(f64, v.n) - 2.0 / 3.0) < 1e-6;
    }
    try testing.expect(found);
}

test "breaks gambrel and mansard faces at n = 2/3, b/3 in from the eaves" {
    var arena = std.heap.ArenaAllocator.init(testing.allocator);
    defer arena.deinit();
    const allocator = arena.allocator();
    // Gambrel's gable walls show the break; mansard's walls are all eaves.
    var breaks: usize = 0;
    for (try wallTopsOf(allocator, &.{&rectangle}, .{ .shape = "gambrel" })) |v| {
        if (@abs(@as(f64, v.n) - 2.0 / 3.0) >= 1e-6) continue;
        breaks += 1;
        try expectCloseTo(@abs(@as(f64, v.y) - 1080), 160.0 / 3.0, 3);
    }
    try testing.expect(breaks > 0);
    breaks = 0;
    for (try roofOf(allocator, &.{&rectangle}, .{ .shape = "mansard" })) |v| {
        if (@abs(@as(f64, v.n) - 2.0 / 3.0) < 1e-6) breaks += 1;
    }
    try testing.expect(breaks > 0);
}

test "tops the saltbox variants with a flat roof" {
    var arena = std.heap.ArenaAllocator.init(testing.allocator);
    defer arena.deinit();
    for ([_][]const u8{ "double_saltbox", "quadruple_saltbox" }) |shape| {
        errdefer std.debug.print("{s}\n", .{shape});
        var top: usize = 0;
        for (try roofOf(arena.allocator(), &.{&rectangle}, .{ .shape = shape })) |v| {
            if (v.gx == 0 and v.gy == 0) {
                top += 1;
                try testing.expectEqual(1, v.n);
            } else {
                // The faces rise over 0.3 b.
                try expectCloseTo(std.math.hypot(@as(f64, v.gx), @as(f64, v.gy)), 1.0 / 24.0, 6);
            }
        }
        try testing.expect(top > 0);
    }
}

test "vaults a round roof over a semicircle" {
    var arena = std.heap.ArenaAllocator.init(testing.allocator);
    defer arena.deinit();
    var east: usize = 0;
    for (try wallTopsOf(arena.allocator(), &.{&rectangle}, .{ .shape = "round" })) |v| {
        if (v.gx != 1) continue;
        east += 1;
        const s = (@as(f64, v.y) - 1080) / 80;
        try expectCloseTo(v.n, @sqrt(@max(0, 1 - s * s)), 5);
    }
    try testing.expectEqual(13, east);
}

test "gives round_gabled a crisp ridge between two smooth sides" {
    var arena = std.heap.ArenaAllocator.init(testing.allocator);
    defer arena.deinit();
    var up = false;
    var down = false;
    for (try roofOf(arena.allocator(), &.{&rectangle}, .{ .shape = "round_gabled" })) |v| {
        if (v.n != 1) continue;
        up = up or v.gy > 0;
        down = down or v.gy < 0;
        try testing.expectEqual(1080, v.y);
    }
    try testing.expect(up and down);
}

fn regularPolygon(comptime count: usize, center: f64, radius: f64) [count]Point {
    var points: [count]Point = undefined;
    for (&points, 0..) |*p, i| {
        const angle = 2 * std.math.pi * @as(f64, @floatFromInt(i)) / count;
        p.* = .{
            .x = @floor(center + radius * @cos(angle) + 0.5),
            .y = @floor(center + radius * @sin(angle) + 0.5),
        };
    }
    return points;
}

test "builds radial roofs toward the center" {
    var arena = std.heap.ArenaAllocator.init(testing.allocator);
    defer arena.deinit();
    const allocator = arena.allocator();
    for (try roofOf(allocator, &.{&rectangle}, .{ .shape = "pyramidal" })) |v|
        if (v.n == 1) try testing.expect(v.x == 1150 and v.y == 1080);
    // A pointed cone gets one apex per face; a dome shares a flat apex.
    const circle = regularPolygon(16, 3000, 150);
    var apexes: usize = 0;
    for (try roofOf(allocator, &.{&circle}, .{ .shape = "cone" })) |v| {
        if (v.n == 1) apexes += 1;
    }
    try testing.expectEqual(16, apexes);
    apexes = 0;
    for (try roofOf(allocator, &.{&circle}, .{ .shape = "dome" })) |v| {
        if (v.n != 1) continue;
        apexes += 1;
        try testing.expect(v.gx == 0 and v.gy == 0);
    }
    try testing.expectEqual(1, apexes);
    // The onion's bulge overhangs its neck.
    var underside = false;
    for (try roofOf(allocator, &.{&circle}, .{ .shape = "onion" })) |v| underside = underside or v.kind == roof_underside;
    try testing.expect(underside);
}

fn expectFlat(allocator: Allocator, rings: []const []const Point, values: LayoutValues) !void {
    const result = try lay(allocator, rings, values);
    const roofs = try filter(allocator, &result, isRoof);
    try testing.expect(roofs.len > 0);
    for (roofs) |v| try testing.expectEqual([4]f32{ 1, 0, 0, 0 }, [4]f32{ v.n, v.gx, v.gy, v.run });
    for (try filter(allocator, &result, isWallTop)) |v| try testing.expectEqual(1, v.n);
}

const courtyard = [_]Point{
    .{ .x = 1100, .y = 1050 },
    .{ .x = 1100, .y = 1100 },
    .{ .x = 1200, .y = 1100 },
    .{ .x = 1200, .y = 1050 },
};

test "falls back to flat roofs" {
    var arena = std.heap.ArenaAllocator.init(testing.allocator);
    defer arena.deinit();
    const allocator = arena.allocator();
    const l_shape = [_]Point{
        .{ .x = 1000, .y = 1000 },
        .{ .x = 1160, .y = 1000 },
        .{ .x = 1160, .y = 1140 },
        .{ .x = 1360, .y = 1140 },
        .{ .x = 1360, .y = 1300 },
        .{ .x = 1000, .y = 1300 },
    };
    try expectFlat(allocator, &.{&l_shape}, .{ .shape = "pyramidal" });
    try expectFlat(allocator, &.{&l_shape}, .{ .shape = "dome" });
    try expectFlat(allocator, &.{&rectangle}, .{ .shape = "many" });
    try expectFlat(allocator, &.{&rectangle}, .{ .shape = "lean_to" });
    try expectFlat(allocator, &.{ &rectangle, &courtyard }, .{ .shape = "gabled" });
}

test "faces courtyard walls into the courtyard" {
    var arena = std.heap.ArenaAllocator.init(testing.allocator);
    defer arena.deinit();
    const result = try lay(arena.allocator(), &.{ &rectangle, &courtyard }, .{ .shape = "flat" });
    var inner: usize = 0;
    for (result.vertices.items) |v| {
        if (!(isWall(v) and v.x >= 1100 and v.x <= 1200 and v.y >= 1050 and v.y <= 1100)) continue;
        inner += 1;
        // Toward the courtyard's center (1150, 1075).
        try testing.expect(v.gx * (1150 - v.x) + v.gy * (1075 - v.y) > 0);
    }
    try testing.expectEqual(16, inner);
}

test "skips walls on tile cuts and flattens the roof" {
    var arena = std.heap.ArenaAllocator.init(testing.allocator);
    defer arena.deinit();
    const allocator = arena.allocator();
    const cut = [_]Point{
        .{ .x = -128, .y = 2000 },
        .{ .x = 200, .y = 2000 },
        .{ .x = 200, .y = 2200 },
        .{ .x = -128, .y = 2200 },
    };
    const result = try lay(allocator, &.{&cut}, .{ .shape = "gabled" });
    const walls = try filter(allocator, &result, isWall);
    for (walls) |v| try testing.expect(!(v.x == -128 and v.gx == -1));
    try testing.expectEqual(12, walls.len);
    for (try filter(allocator, &result, isRoof)) |v| try testing.expectEqual(1, v.n);
}

test "draws a footprint in the one tile that owns it" {
    var arena = std.heap.ArenaAllocator.init(testing.allocator);
    defer arena.deinit();
    const allocator = arena.allocator();
    // The same building seen from the tile west of the edge and the tile
    // east of it: crossing the edge, it is flat in both.
    const west = [_]Point{ .{ .x = 8100, .y = 3000 }, .{ .x = 8300, .y = 3000 }, .{ .x = 8300, .y = 3160 }, .{ .x = 8100, .y = 3160 } };
    const east = [_]Point{ .{ .x = -92, .y = 3000 }, .{ .x = 108, .y = 3000 }, .{ .x = 108, .y = 3160 }, .{ .x = -92, .y = 3160 } };
    for ([_][]const Point{ &west, &east }) |ring| {
        const roof = try roofOf(allocator, &.{ring}, .{ .shape = "gabled" });
        try testing.expect(roof.len > 0);
        for (roof) |v| try testing.expectEqual(1, v.n);
    }
    // Only in the buffer: the tile east of the edge owns it.
    const buffer = [_]Point{ .{ .x = 8200, .y = 3000 }, .{ .x = 8300, .y = 3000 }, .{ .x = 8300, .y = 3160 }, .{ .x = 8200, .y = 3160 } };
    const skipped = try lay(allocator, &.{&buffer}, .{ .shape = "gabled" });
    try testing.expectEqual(0, skipped.vertexCount());
    try testing.expectEqual(0, skipped.ranges.items.len);
}

test "starts a new segment before 65536 vertices" {
    const circle = regularPolygon(32, 4000, 300);
    var result: BuildingLayout = .init(testing.allocator, 8192);
    defer result.deinit();
    for (0..200) |i| try result.addFeature(&.{&circle}, i, .{ .shape = "round" });
    try testing.expect(result.vertexCount() > max_segment_vertices);
    try testing.expect(result.segments.items.len > 1);
    try checkInvariants(testing.allocator, &result, 8192, .{ .fallback = "round" });
}
