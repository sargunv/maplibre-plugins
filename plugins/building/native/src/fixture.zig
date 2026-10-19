//! The layout fixture format (../../fixtures/layout/*.json), the twin of
//! ../../js/src/fixture.ts, which documents it in full. Each fixture lays
//! out its features in order into one BuildingLayout and records the output:
//! counts, segments and ranges exactly, and per feature a summary of its
//! float32 vertices and segment-relative indices:
//!
//!   vertices   the feature's vertex count (its range)
//!   triangles  triangles whose first vertex is in the range
//!   sum_pos    Σ (x, y, run) over the range, in vertex order, in f64
//!   sum_roof   Σ (n, kind, gx, gy) likewise
//!   weighted   Σ (i + 1) · (x + y + run + n + kind + gx + gy) / vertices,
//!              i the vertex's position in the range
//!   moment     Σ (t + 1) · (i0 + 2·i1 + 3·i2) over the feature's triangles,
//!              t the triangle's position among them and i the vertex
//!              positions in the range (orientation-sensitive)
//!
//! Values compare with |a - b| <= 1e-6 + 1e-6·|b|, loose enough for the
//! last-bit differences between the twins' math and tight enough to catch
//! any change of logic.

const std = @import("std");
const Allocator = std.mem.Allocator;

const layout = @import("layout.zig");
const BuildingLayout = layout.BuildingLayout;
const Point = layout.Point;

pub const FixtureFeature = struct {
    index: u64,
    /// Rings of [x, y] tile points.
    rings: []const []const [2]f64,
    shape: []const u8,
    orientation: []const u8 = "along",
    direction: f64 = -1,
    /// Lays the feature out this many times, with consecutive indices.
    repeat: u32 = 1,
    label: ?[]const u8 = null,
};

pub const Summary = struct {
    vertices: u32,
    triangles: u32,
    sum_pos: [3]f64,
    sum_roof: [4]f64,
    weighted: f64,
    moment: i64,
};

pub const Expected = struct {
    vertex_count: u32,
    index_count: u32,
    /// [vertex_offset, index_offset, vertex_length, index_length].
    segments: []const [4]u32,
    /// [feature index, first vertex, vertex count].
    ranges: []const [3]u64,
    summaries: []const Summary,
    /// Every vertex's (x, y, run), when recorded.
    positions: ?[]const [3]f64 = null,
    /// Every vertex's (n, kind, gx, gy), when recorded.
    roofs: ?[]const [4]f64 = null,
    indices: ?[]const u16 = null,
};

pub const Fixture = struct {
    description: []const u8,
    extent: u32,
    features: []const FixtureFeature,
    expected: Expected,
};

pub fn parse(allocator: Allocator, text: []const u8) !std.json.Parsed(Fixture) {
    return std.json.parseFromSlice(Fixture, allocator, text, .{});
}

/// Lays out a fixture's features, as one tile: the bounds of all of them
/// locate its cut lines. The caller owns the result.
pub fn layOut(allocator: Allocator, extent: u32, features: []const FixtureFeature) !BuildingLayout {
    var result: BuildingLayout = .init(allocator, extent);
    errdefer result.deinit();
    for (features) |feature| for (feature.rings) |ring| for (ring) |p| result.bounds.add(.{ .x = p[0], .y = p[1] });
    var points: std.ArrayList(Point) = .empty;
    defer points.deinit(allocator);
    var rings: std.ArrayList([]const Point) = .empty;
    defer rings.deinit(allocator);
    for (features) |feature| {
        points.clearRetainingCapacity();
        rings.clearRetainingCapacity();
        for (feature.rings) |ring| for (ring) |p| try points.append(allocator, .{ .x = p[0], .y = p[1] });
        var start: usize = 0;
        for (feature.rings) |ring| {
            try rings.append(allocator, points.items[start .. start + ring.len]);
            start += ring.len;
        }
        for (0..feature.repeat) |k| {
            try result.addFeature(rings.items, feature.index + k, .{
                .shape = feature.shape,
                .orientation = feature.orientation,
                .direction = feature.direction,
            });
        }
    }
    return result;
}

/// The global vertex numbers of every triangle, in output order.
pub fn triangles(allocator: Allocator, result: *const BuildingLayout) ![][3]u32 {
    var list: std.ArrayList([3]u32) = .empty;
    errdefer list.deinit(allocator);
    const indices = result.indices.items;
    for (result.segments.items) |segment| {
        var t: u32 = 0;
        while (t < segment.index_length) : (t += 3) {
            const o = segment.index_offset + t;
            try list.append(allocator, .{
                segment.vertex_offset + indices[o],
                segment.vertex_offset + indices[o + 1],
                segment.vertex_offset + indices[o + 2],
            });
        }
    }
    return list.toOwnedSlice(allocator);
}

/// One summary per range. The caller owns the result.
pub fn summarize(allocator: Allocator, result: *const BuildingLayout) ![]Summary {
    const all = try triangles(allocator, result);
    defer allocator.free(all);
    const summaries = try allocator.alloc(Summary, result.ranges.items.len);
    for (result.ranges.items, summaries) |range, *summary| {
        var sum_pos: [3]f64 = @splat(0);
        var sum_roof: [4]f64 = @splat(0);
        var weighted: f64 = 0;
        for (0..range.vertex_count) |i| {
            const v = result.vertices.items[range.first_vertex + i];
            const values = [layout.floats_per_vertex]f32{ v.x, v.y, v.run, v.n, v.kind, v.gx, v.gy };
            var total: f64 = 0;
            for (values, 0..) |value, c| {
                if (c < 3) sum_pos[c] += value else sum_roof[c - 3] += value;
                total += value;
            }
            weighted += @as(f64, @floatFromInt(i + 1)) * total;
        }
        var count: u32 = 0;
        var moment: i64 = 0;
        const end = range.first_vertex + range.vertex_count;
        for (all) |tri| {
            if (tri[0] < range.first_vertex or tri[0] >= end) continue;
            const a: i64 = @as(i64, tri[0]) - range.first_vertex;
            const b: i64 = @as(i64, tri[1]) - range.first_vertex;
            const c: i64 = @as(i64, tri[2]) - range.first_vertex;
            moment += (@as(i64, count) + 1) * (a + 2 * b + 3 * c);
            count += 1;
        }
        summary.* = .{
            .vertices = range.vertex_count,
            .triangles = count,
            .sum_pos = sum_pos,
            .sum_roof = sum_roof,
            .weighted = weighted / @as(f64, @floatFromInt(@max(range.vertex_count, 1))),
            .moment = moment,
        };
    }
    return summaries;
}

pub fn close(actual: f64, expected: f64) bool {
    return @abs(actual - expected) <= 1e-6 + 1e-6 * @abs(expected);
}
