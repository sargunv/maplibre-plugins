//! Anchor geometry: one quad per point. Every point a tile owns becomes four
//! vertices around its anchor, which the vertex shader (shaders/place.glsl)
//! spreads over the animation's anchor box on screen or on the ground.
//!
//! This file is the twin of ../../js/src/layout.ts; both run the shared
//! fixtures in ../../fixtures/layout and must stay in step.
//!
//! Conventions:
//! - A tile owns the points in its square, 0 <= x < extent and
//!   0 <= y < extent. The copies of neighbouring tiles' points in the tile
//!   buffer are dropped, so every icon draws exactly once.
//! - Anchors sort stably by (y, x), so icons lower in the tile draw on top,
//!   as point symbols do at bearing 0. Equal anchors keep feature order.
//! - Each anchor has one FLOAT_X2 attribute per vertex, `anchor * 2 + corner`
//!   with corners (0,0), (1,0), (0,1), (1,1): the circle layer's trick, exact
//!   in f32 for tile coordinates. Two triangles index the four vertices.
//! - Segments split every 16383 anchors (65532 vertices) so 16-bit,
//!   segment-relative indices address them.
//! - One feature range per anchor covers its four vertices; a MultiPoint's
//!   anchors need not be adjacent once sorted.

const std = @import("std");

/// A point in tile coordinates.
pub const Point = struct { x: i32, y: i32 };

/// One vertex: `anchor * 2 + corner`.
pub const Vertex = extern struct {
    x: f32,
    y: f32,
};

pub const Segment = struct {
    vertex_offset: u32,
    index_offset: u32,
    vertex_length: u32 = 0,
    index_length: u32 = 0,
};

/// The vertices of one anchor, for the host's feature index.
pub const Range = struct {
    feature_index: u64,
    first_vertex: u32,
    vertex_count: u32,
};

pub const vertices_per_anchor = 4;
pub const indices_per_anchor = 6;
/// Vertices per segment: the largest multiple of four that 16-bit indices
/// address.
pub const max_segment_vertices: u32 = 65532;
/// Corner of each of an anchor's four vertices, in order.
pub const corners = [vertices_per_anchor][2]f32{ .{ 0, 0 }, .{ 1, 0 }, .{ 0, 1 }, .{ 1, 1 } };
/// The quad's two triangles, relative to the anchor's first vertex.
pub const quad_indices = [indices_per_anchor]u16{ 0, 1, 2, 1, 3, 2 };

const Anchor = struct {
    x: i32,
    y: i32,
    feature_index: u64,

    fn lessThan(_: void, a: Anchor, b: Anchor) bool {
        return a.y < b.y or (a.y == b.y and a.x < b.x);
    }
};

pub const Layout = struct {
    allocator: std.mem.Allocator,
    extent: i64,
    anchors: std.ArrayList(Anchor) = .empty,
    vertices: std.ArrayList(Vertex) = .empty,
    indices: std.ArrayList(u16) = .empty,
    segments: std.ArrayList(Segment) = .empty,
    ranges: std.ArrayList(Range) = .empty,

    pub fn init(allocator: std.mem.Allocator, extent: u32) Layout {
        return .{ .allocator = allocator, .extent = extent };
    }

    pub fn deinit(self: *Layout) void {
        self.anchors.deinit(self.allocator);
        self.vertices.deinit(self.allocator);
        self.indices.deinit(self.allocator);
        self.segments.deinit(self.allocator);
        self.ranges.deinit(self.allocator);
    }

    /// Adds the points of one feature: a Point, or every point of a
    /// MultiPoint. Points outside the tile square are dropped.
    pub fn addPoints(self: *Layout, points: []const Point, feature_index: u64) !void {
        for (points) |p| {
            if (p.x < 0 or p.y < 0 or p.x >= self.extent or p.y >= self.extent) continue;
            try self.anchors.append(self.allocator, .{ .x = p.x, .y = p.y, .feature_index = feature_index });
        }
    }

    /// Sorts the anchors and builds the vertices, indices, segments and
    /// ranges. Call once, after the last addPoints.
    pub fn finish(self: *Layout) !void {
        const anchors = self.anchors.items;
        // Block sort is stable: equal anchors keep the order they came in.
        std.sort.block(Anchor, anchors, {}, Anchor.lessThan);
        try self.vertices.ensureTotalCapacity(self.allocator, anchors.len * vertices_per_anchor);
        try self.indices.ensureTotalCapacity(self.allocator, anchors.len * indices_per_anchor);
        try self.ranges.ensureTotalCapacity(self.allocator, anchors.len);
        for (anchors) |anchor| {
            if (self.segments.items.len == 0 or self.segments.items[self.segments.items.len - 1].vertex_length + vertices_per_anchor > max_segment_vertices) {
                try self.segments.append(self.allocator, .{ .vertex_offset = @intCast(self.vertices.items.len), .index_offset = @intCast(self.indices.items.len) });
            }
            const segment = &self.segments.items[self.segments.items.len - 1];
            const base: u16 = @intCast(segment.vertex_length);
            self.ranges.appendAssumeCapacity(.{ .feature_index = anchor.feature_index, .first_vertex = @intCast(self.vertices.items.len), .vertex_count = vertices_per_anchor });
            const x: f32 = @floatFromInt(anchor.x * 2);
            const y: f32 = @floatFromInt(anchor.y * 2);
            for (corners) |corner| self.vertices.appendAssumeCapacity(.{ .x = x + corner[0], .y = y + corner[1] });
            for (quad_indices) |index| self.indices.appendAssumeCapacity(base + index);
            segment.vertex_length += vertices_per_anchor;
            segment.index_length += indices_per_anchor;
        }
    }
};

// ---------------------------------------------------------------------------
// Tests. Every case comes from ../../fixtures/layout, which
// ../../js/src/layout.test.ts runs through the same checks.
// ---------------------------------------------------------------------------

const fixtures = @import("layout_fixtures");

const Fixture = struct {
    description: []const u8,
    extent: u32,
    features: []const struct { index: u64, points: []const [2]i32 } = &.{},
    /// A MultiPoint of columns × rows points, generated column by column so
    /// the sort has to reorder them.
    grid: ?struct { index: u64, origin: [2]i32, step: [2]i32, columns: u32, rows: u32 } = null,
    expected: struct {
        anchor_count: usize,
        /// Draw order: [x, y, feature index] of every anchor.
        anchors: ?[]const [3]i64 = null,
        /// [anchor number, x, y, feature index] of some anchors.
        samples: []const [4]i64 = &.{},
        /// [vertex_offset, index_offset, vertex_length, index_length].
        segments: []const [4]u32,
        vertices: ?[]const [2]f32 = null,
        indices: ?[]const u16 = null,
    },
};

fn expectAnchor(layout: *const Layout, k: usize, x: i64, y: i64, feature_index: i64) !void {
    const first = layout.vertices.items[k * vertices_per_anchor];
    try std.testing.expectEqual(@as(f32, @floatFromInt(x * 2)), first.x);
    try std.testing.expectEqual(@as(f32, @floatFromInt(y * 2)), first.y);
    try std.testing.expectEqual(Range{ .feature_index = @intCast(feature_index), .first_vertex = @intCast(k * vertices_per_anchor), .vertex_count = vertices_per_anchor }, layout.ranges.items[k]);
}

fn runFixture(name: []const u8, json: []const u8) !void {
    errdefer std.debug.print("layout fixture {s} failed\n", .{name});
    const allocator = std.testing.allocator;
    const parsed = try std.json.parseFromSlice(Fixture, allocator, json, .{ .ignore_unknown_fields = true });
    defer parsed.deinit();
    const fixture = parsed.value;

    var layout = Layout.init(allocator, fixture.extent);
    defer layout.deinit();
    var points: std.ArrayList(Point) = .empty;
    defer points.deinit(allocator);
    for (fixture.features) |feature| {
        points.clearRetainingCapacity();
        for (feature.points) |p| try points.append(allocator, .{ .x = p[0], .y = p[1] });
        try layout.addPoints(points.items, feature.index);
    }
    if (fixture.grid) |grid| {
        points.clearRetainingCapacity();
        for (0..grid.columns) |column| for (0..grid.rows) |row| {
            try points.append(allocator, .{ .x = grid.origin[0] + @as(i32, @intCast(column)) * grid.step[0], .y = grid.origin[1] + @as(i32, @intCast(row)) * grid.step[1] });
        };
        try layout.addPoints(points.items, grid.index);
    }
    try layout.finish();

    const expected = fixture.expected;
    try std.testing.expectEqual(expected.anchor_count * vertices_per_anchor, layout.vertices.items.len);
    try std.testing.expectEqual(expected.anchor_count * indices_per_anchor, layout.indices.items.len);
    try std.testing.expectEqual(expected.anchor_count, layout.ranges.items.len);
    if (expected.anchors) |anchors| {
        try std.testing.expectEqual(expected.anchor_count, anchors.len);
        for (anchors, 0..) |a, k| try expectAnchor(&layout, k, a[0], a[1], a[2]);
    }
    for (expected.samples) |s| try expectAnchor(&layout, @intCast(s[0]), s[1], s[2], s[3]);

    try std.testing.expectEqual(expected.segments.len, layout.segments.items.len);
    for (expected.segments, layout.segments.items) |e, actual| {
        try std.testing.expectEqual(Segment{ .vertex_offset = e[0], .index_offset = e[1], .vertex_length = e[2], .index_length = e[3] }, actual);
    }
    if (expected.vertices) |vertices| {
        try std.testing.expectEqual(vertices.len, layout.vertices.items.len);
        for (vertices, layout.vertices.items) |e, actual| try std.testing.expectEqual(Vertex{ .x = e[0], .y = e[1] }, actual);
    }
    if (expected.indices) |indices| try std.testing.expectEqualSlices(u16, indices, layout.indices.items);

    // Every anchor is a quad of its own four vertices, with the corners in
    // order and the indices relative to its segment.
    var anchor: usize = 0;
    for (layout.segments.items) |segment| {
        try std.testing.expect(segment.vertex_length <= max_segment_vertices);
        try std.testing.expectEqual(@as(u32, @intCast(anchor * vertices_per_anchor)), segment.vertex_offset);
        try std.testing.expectEqual(@as(u32, @intCast(anchor * indices_per_anchor)), segment.index_offset);
        for (0..segment.vertex_length / vertices_per_anchor) |local| {
            const vertices = layout.vertices.items[anchor * vertices_per_anchor ..][0..vertices_per_anchor];
            for (vertices, corners) |v, corner| {
                try std.testing.expectEqual(vertices[0].x + corner[0], v.x);
                try std.testing.expectEqual(vertices[0].y + corner[1], v.y);
            }
            const indices = layout.indices.items[anchor * indices_per_anchor ..][0..indices_per_anchor];
            for (indices, quad_indices) |index, offset| try std.testing.expectEqual(@as(u16, @intCast(local * vertices_per_anchor)) + offset, index);
            anchor += 1;
        }
    }
    try std.testing.expectEqual(expected.anchor_count, anchor);

    // The ranges cover every vertex exactly once, as the host requires of
    // buckets with property bindings.
    const covered = try allocator.alloc(bool, layout.vertices.items.len);
    defer allocator.free(covered);
    @memset(covered, false);
    for (layout.ranges.items) |range| {
        for (range.first_vertex..range.first_vertex + range.vertex_count) |v| {
            try std.testing.expect(!covered[v]);
            covered[v] = true;
        }
    }
    for (covered) |v| try std.testing.expect(v);
}

test "layout fixtures" {
    try std.testing.expect(fixtures.names.len > 0);
    for (fixtures.names, fixtures.files) |name, json| try runFixture(name, json);
}
