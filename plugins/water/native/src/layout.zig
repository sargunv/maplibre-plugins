//! Shoreline band geometry. For every water polygon ring this builds a strip
//! that hugs the shoreline on the water side: an outer vertex on the shore
//! and an inner vertex carrying a unit extrusion vector, which the vertex
//! shader scales to the band width in pixels. The strip carries a 0..1
//! distance so the fragment shader can draw crests and wash analytically.
//!
//! This file is the twin of ../../js/src/layout.ts; both are tested against
//! the same fixtures and must stay in step.
//!
//! Conventions (Mapbox Vector Tile winding): the water lies on the left of
//! every ring edge in tile coordinates, for exterior rings and holes alike,
//! so the inward normal of an edge (dx, dy) is (-dy, dx). Rings keep the
//! tile's whole buffer (clipped only to a generous margin) so corners just
//! outside the tile still get their joins; the fragment shader then owns
//! each fragment by its shoreline point, so the buffered copies in
//! neighbouring tiles never double up and bands crossing a tile edge have
//! no gaps.

const std = @import("std");

pub const Point = struct { x: f64, y: f64 };

/// Interleaved vertex: tile-local position, unit extrusion, band distance,
/// and the extrusion limit in tile units (see `reach`).
pub const Vertex = extern struct {
    x: f32,
    y: f32,
    extrude_x: f32,
    extrude_y: f32,
    dist: f32,
    limit: f32,
};

pub const Segment = struct {
    vertex_offset: u32,
    index_offset: u32,
    vertex_length: u32 = 0,
    index_length: u32 = 0,
};

/// The vertices one source feature produced, for the host's feature index.
pub const Range = struct {
    feature_index: u64,
    first_vertex: u32,
    vertex_count: u32,
};

/// Vertices per segment stay addressable by 16-bit indices.
pub const max_segment_vertices: u32 = 65535;
/// Convex corners extend the band by at most this factor of its width.
pub const miter_limit: f64 = 2.0;
/// Reflex corners fan the band around the point in steps of at most 45°.
pub const fan_step: f64 = std.math.pi / 4.0;
/// How far beyond the tile square rings are kept, as a fraction of the
/// extent: wider than any source buffer, so buffered geometry survives.
pub const clip_margin: f64 = 0.5;
/// How far an extrusion looks for the opposite bank, in tile units. Past
/// this the band is unlimited, and the vertex shader clamps it to half the
/// reach so the two banks of a narrow channel meet in the middle instead of
/// overlapping.
pub const reach: f64 = 4096;
/// Limit stored for vertices whose extrusion hits nothing within `reach`.
pub const unlimited: f32 = 1e8;
const grid_cells: usize = 32;

const Pair = struct {
    outer: Point,
    extrude: Point,
    /// The feature edges sharing the outer point; the reach ray ignores them.
    exclude: [2]u32,
};

const FeatureEdge = struct { a: Point, b: Point };

const ClippedEdge = struct {
    a: Point,
    b: Point,
    normal: Point,
    direction: Point,
    starts_at_vertex: bool,
    ends_at_vertex: bool,
    /// Index of the ring edge this came from; consecutive kept edges join.
    ring_edge: usize,
    /// Index into the feature's edge list, for the reach cast.
    edge_id: u32,
};

pub const Layout = struct {
    allocator: std.mem.Allocator,
    extent: f64,
    vertices: std.ArrayList(Vertex) = .empty,
    indices: std.ArrayList(u16) = .empty,
    segments: std.ArrayList(Segment) = .empty,
    ranges: std.ArrayList(Range) = .empty,
    edges: std.ArrayList(ClippedEdge) = .empty,
    pairs: std.ArrayList(Pair) = .empty,
    clean: std.ArrayList(Point) = .empty,
    ring_ends: std.ArrayList(usize) = .empty,
    feature_edges: std.ArrayList(FeatureEdge) = .empty,
    /// Uniform grid over the clip square: feature edge ids per cell.
    grid: [grid_cells * grid_cells]std.ArrayList(u32) = @splat(.empty),

    pub fn init(allocator: std.mem.Allocator, extent: u32) Layout {
        return .{ .allocator = allocator, .extent = @floatFromInt(extent) };
    }

    pub fn deinit(self: *Layout) void {
        self.vertices.deinit(self.allocator);
        self.indices.deinit(self.allocator);
        self.segments.deinit(self.allocator);
        self.ranges.deinit(self.allocator);
        self.edges.deinit(self.allocator);
        self.pairs.deinit(self.allocator);
        self.clean.deinit(self.allocator);
        self.ring_ends.deinit(self.allocator);
        self.feature_edges.deinit(self.allocator);
        for (&self.grid) |*cell| cell.deinit(self.allocator);
    }

    /// Adds every ring of one polygon feature. Rings may repeat their first
    /// point at the end; rings with fewer than three distinct points are
    /// skipped.
    pub fn addPolygon(self: *Layout, rings: []const []const Point, feature_index: u64) !void {
        const first_vertex: u32 = @intCast(self.vertices.items.len);
        // Clean every ring first: the reach cast needs all of the feature's
        // edges before any ring's strip is built.
        self.clean.clearRetainingCapacity();
        self.ring_ends.clearRetainingCapacity();
        self.feature_edges.clearRetainingCapacity();
        for (&self.grid) |*cell| cell.clearRetainingCapacity();
        for (rings) |ring_in| {
            const start = self.clean.items.len;
            for (ring_in) |p| {
                const items = self.clean.items;
                if (items.len > start and items[items.len - 1].x == p.x and items[items.len - 1].y == p.y) continue;
                try self.clean.append(self.allocator, p);
            }
            var end = self.clean.items.len;
            while (end - start > 1 and self.clean.items[end - 1].x == self.clean.items[start].x and self.clean.items[end - 1].y == self.clean.items[start].y) end -= 1;
            self.clean.shrinkRetainingCapacity(end);
            if (end - start < 3) {
                self.clean.shrinkRetainingCapacity(start);
                continue;
            }
            try self.ring_ends.append(self.allocator, end);
        }
        var start: usize = 0;
        for (self.ring_ends.items) |end| {
            const ring = self.clean.items[start..end];
            for (ring, 0..) |p, i| try self.addFeatureEdge(p, ring[(i + 1) % ring.len]);
            start = end;
        }
        start = 0;
        var edge_base: u32 = 0;
        for (self.ring_ends.items) |end| {
            try self.addRing(self.clean.items[start..end], edge_base);
            edge_base += @intCast(end - start);
            start = end;
        }
        const count: u32 = @intCast(self.vertices.items.len - first_vertex);
        if (count > 0) try self.ranges.append(self.allocator, .{ .feature_index = feature_index, .first_vertex = first_vertex, .vertex_count = count });
    }

    fn cellCoordinate(self: *const Layout, v: f64) usize {
        const margin = self.extent * clip_margin;
        const size = (self.extent + 2 * margin) / @as(f64, @floatFromInt(grid_cells));
        const c = @floor((v + margin) / size);
        return @intFromFloat(std.math.clamp(c, 0, @as(f64, @floatFromInt(grid_cells - 1))));
    }

    fn addFeatureEdge(self: *Layout, a: Point, b: Point) !void {
        const id: u32 = @intCast(self.feature_edges.items.len);
        try self.feature_edges.append(self.allocator, .{ .a = a, .b = b });
        const x0 = self.cellCoordinate(@min(a.x, b.x));
        const x1 = self.cellCoordinate(@max(a.x, b.x));
        const y0 = self.cellCoordinate(@min(a.y, b.y));
        const y1 = self.cellCoordinate(@max(a.y, b.y));
        for (y0..y1 + 1) |y| for (x0..x1 + 1) |x| try self.grid[y * grid_cells + x].append(self.allocator, id);
    }

    /// Casts a ray from a pair's outer point along its extrusion and returns
    /// the extrusion limit in tile units: half the distance to the nearest
    /// other edge of the feature, or `unlimited`.
    fn limitFor(self: *const Layout, pair: Pair) f32 {
        const len = @sqrt(pair.extrude.x * pair.extrude.x + pair.extrude.y * pair.extrude.y);
        if (len < 1e-12) return unlimited;
        const d = Point{ .x = pair.extrude.x / len, .y = pair.extrude.y / len };
        const o = pair.outer;
        var best: f64 = reach;
        const margin = self.extent * clip_margin;
        const step = (self.extent + 2 * margin) / @as(f64, @floatFromInt(grid_cells)) * 0.5;
        var travelled: f64 = 0;
        var last_cell: usize = std.math.maxInt(usize);
        while (travelled <= best) : (travelled += step) {
            const x = o.x + d.x * travelled;
            const y = o.y + d.y * travelled;
            const cell = self.cellCoordinate(y) * grid_cells + self.cellCoordinate(x);
            if (cell == last_cell) continue;
            last_cell = cell;
            for (self.grid[cell].items) |id| {
                if (id == pair.exclude[0] or id == pair.exclude[1]) continue;
                const edge = self.feature_edges.items[id];
                if (rayHit(o, d, edge.a, edge.b)) |hit| {
                    if (hit > 1e-6 and hit < best) best = hit;
                }
            }
        }
        if (best >= reach) return unlimited;
        return @floatCast(best / (2 * len));
    }

    /// Distance along the ray (o, d) to segment ab, if they intersect.
    fn rayHit(o: Point, d: Point, a: Point, b: Point) ?f64 {
        const ex = b.x - a.x;
        const ey = b.y - a.y;
        const denominator = d.x * ey - d.y * ex;
        if (@abs(denominator) < 1e-12) return null;
        const wx = a.x - o.x;
        const wy = a.y - o.y;
        const s = (wx * ey - wy * ex) / denominator;
        const u = (wx * d.y - wy * d.x) / denominator;
        if (s < 0 or u < -1e-9 or u > 1 + 1e-9) return null;
        return s;
    }

    fn addRing(self: *Layout, ring: []const Point, edge_base: u32) !void {
        var area: f64 = 0;
        for (ring, 0..) |p, i| {
            const q = ring[(i + 1) % ring.len];
            area += p.x * q.y - q.x * p.y;
        }
        if (@abs(area) < 1e-9) return;

        // The artificial cuts of a buffered tile are axis-aligned edges on
        // the ring's bounding box, outside the tile square.
        var box = [4]f64{ ring[0].x, ring[0].y, ring[0].x, ring[0].y };
        for (ring) |p| box = .{ @min(box[0], p.x), @min(box[1], p.y), @max(box[2], p.x), @max(box[3], p.y) };
        self.edges.clearRetainingCapacity();
        for (ring, 0..) |p, i| {
            const q = ring[(i + 1) % ring.len];
            if (self.clipEdge(p, q, i, box)) |edge| {
                var kept = edge;
                kept.edge_id = edge_base + @as(u32, @intCast(i));
                try self.edges.append(self.allocator, kept);
            }
        }
        const edges = self.edges.items;
        if (edges.len == 0) return;

        // Consecutive kept edges join at their shared ring vertex when neither
        // was clipped there. A ring that joins everywhere is a closed loop.
        var start: usize = 0;
        var closed = true;
        for (edges, 0..) |edge, i| {
            const previous = edges[(i + edges.len - 1) % edges.len];
            if (!joins(previous, edge, ring.len)) {
                start = i;
                closed = false;
                break;
            }
        }

        var i: usize = 0;
        while (i < edges.len) {
            const edge = edges[(start + i) % edges.len];
            self.pairs.clearRetainingCapacity();
            if (closed) {
                try self.appendJoin(edges[(start + edges.len - 1) % edges.len], edge);
            } else {
                try self.pairs.append(self.allocator, .{ .outer = edge.a, .extrude = edge.normal, .exclude = .{ edge.edge_id, edge.edge_id } });
            }
            var previous = edge;
            i += 1;
            while (i < edges.len) : (i += 1) {
                const next = edges[(start + i) % edges.len];
                if (!joins(previous, next, ring.len)) break;
                try self.appendJoin(previous, next);
                previous = next;
            }
            if (closed) {
                // Every edge joined: close the loop by repeating the first
                // corner, which keeps the strip an open chain.
                try self.appendJoin(previous, edge);
            } else {
                try self.pairs.append(self.allocator, .{ .outer = previous.b, .extrude = previous.normal, .exclude = .{ previous.edge_id, previous.edge_id } });
            }
            try self.emitChain();
        }
    }

    /// Clips one ring edge to the tile square grown by `clip_margin`. Edges
    /// lying along a tile or buffer edge are the artificial cuts of a buffered
    /// tile, not shoreline, and are dropped.
    fn clipEdge(self: *const Layout, p: Point, q: Point, ring_edge: usize, box: [4]f64) ?ClippedEdge {
        const extent = self.extent;
        const dx = q.x - p.x;
        const dy = q.y - p.y;
        const len = @sqrt(dx * dx + dy * dy);
        if (len < 1e-9) return null;
        if (dx == 0 and ((p.x <= 0 and p.x == box[0]) or (p.x >= extent and p.x == box[2]))) return null;
        if (dy == 0 and ((p.y <= 0 and p.y == box[1]) or (p.y >= extent and p.y == box[3]))) return null;
        const margin = extent * clip_margin;
        var t0: f64 = 0;
        var t1: f64 = 1;
        const bounds = [_][2]f64{ .{ -dx, p.x + margin }, .{ dx, extent + margin - p.x }, .{ -dy, p.y + margin }, .{ dy, extent + margin - p.y } };
        for (bounds) |bound| {
            const denominator = bound[0];
            const numerator = bound[1];
            if (denominator == 0) {
                if (numerator < 0) return null;
                continue;
            }
            const t = numerator / denominator;
            if (denominator < 0) {
                if (t > t1) return null;
                if (t > t0) t0 = t;
            } else {
                if (t < t0) return null;
                if (t < t1) t1 = t;
            }
        }
        if (t1 <= t0) return null;
        return .{
            .a = .{ .x = p.x + dx * t0, .y = p.y + dy * t0 },
            .b = .{ .x = p.x + dx * t1, .y = p.y + dy * t1 },
            .normal = .{ .x = -dy / len, .y = dx / len },
            .direction = .{ .x = dx / len, .y = dy / len },
            .starts_at_vertex = t0 == 0,
            .ends_at_vertex = t1 == 1,
            .ring_edge = ring_edge,
            .edge_id = 0,
        };
    }

    fn joins(previous: ClippedEdge, next: ClippedEdge, ring_len: usize) bool {
        return previous.ends_at_vertex and next.starts_at_vertex and (previous.ring_edge + 1) % ring_len == next.ring_edge;
    }

    /// Appends the pair(s) at the vertex shared by two joined edges: a miter
    /// for convex water corners, a fan around reflex ones (where the water
    /// wraps around a point of land).
    fn appendJoin(self: *Layout, previous: ClippedEdge, next: ClippedEdge) !void {
        const n0 = previous.normal;
        const n1 = next.normal;
        const outer = next.a;
        const exclude = [2]u32{ previous.edge_id, next.edge_id };
        const cross = previous.direction.x * next.direction.y - previous.direction.y * next.direction.x;
        const dot = n0.x * n1.x + n0.y * n1.y;
        if (cross > 0 or (cross == 0 and dot >= 0)) {
            const mx = n0.x + n1.x;
            const my = n0.y + n1.y;
            const len2 = mx * mx + my * my;
            var extrude = n0;
            if (len2 > 1e-12) {
                var scale = 2.0 / len2;
                const miter_len = scale * @sqrt(len2);
                if (miter_len > miter_limit) scale *= miter_limit / miter_len;
                extrude = .{ .x = mx * scale, .y = my * scale };
            }
            try self.pairs.append(self.allocator, .{ .outer = outer, .extrude = extrude, .exclude = exclude });
            return;
        }
        const angle = -std.math.acos(std.math.clamp(dot, -1.0, 1.0));
        const steps: usize = @max(1, @as(usize, @intFromFloat(@ceil(@abs(angle) / fan_step - 1e-9))));
        for (0..steps + 1) |step| {
            const a = angle * @as(f64, @floatFromInt(step)) / @as(f64, @floatFromInt(steps));
            const c = @cos(a);
            const s = @sin(a);
            try self.pairs.append(self.allocator, .{ .outer = outer, .extrude = .{ .x = n0.x * c - n0.y * s, .y = n0.x * s + n0.y * c }, .exclude = exclude });
        }
    }

    /// Writes the pending pairs as one strip, splitting it across segments
    /// when it would overflow 16-bit indices.
    fn emitChain(self: *Layout) !void {
        const pairs = self.pairs.items;
        if (pairs.len < 2) return;
        var first: usize = 0;
        while (first + 1 < pairs.len) {
            if (self.segments.items.len == 0 or self.segments.items[self.segments.items.len - 1].vertex_length + 4 > max_segment_vertices) try self.startSegment();
            var segment = &self.segments.items[self.segments.items.len - 1];
            const room = (max_segment_vertices - segment.vertex_length) / 2;
            var count = pairs.len - first;
            if (count > room) {
                if (room < 2) {
                    try self.startSegment();
                    segment = &self.segments.items[self.segments.items.len - 1];
                    count = @min(count, max_segment_vertices / 2);
                } else count = room;
            }
            const base: u16 = @intCast(segment.vertex_length);
            for (pairs[first .. first + count]) |pair| {
                try self.vertices.append(self.allocator, .{ .x = @floatCast(pair.outer.x), .y = @floatCast(pair.outer.y), .extrude_x = 0, .extrude_y = 0, .dist = 0, .limit = 0 });
                try self.vertices.append(self.allocator, .{ .x = @floatCast(pair.outer.x), .y = @floatCast(pair.outer.y), .extrude_x = @floatCast(pair.extrude.x), .extrude_y = @floatCast(pair.extrude.y), .dist = 1, .limit = self.limitFor(pair) });
            }
            for (0..count - 1) |j| {
                const o: u16 = base + @as(u16, @intCast(j * 2));
                try self.indices.appendSlice(self.allocator, &.{ o, o + 1, o + 3, o, o + 3, o + 2 });
            }
            segment.vertex_length += @intCast(count * 2);
            segment.index_length += @intCast((count - 1) * 6);
            // The next run re-emits the last pair so the strip stays joined.
            first += count - 1;
        }
    }

    fn startSegment(self: *Layout) !void {
        try self.segments.append(self.allocator, .{ .vertex_offset = @intCast(self.vertices.items.len), .index_offset = @intCast(self.indices.items.len) });
    }
};

// ---------------------------------------------------------------------------
// Tests. The fixtures and expectations mirror ../../js/src/layout.test.ts.
// ---------------------------------------------------------------------------

fn ringOf(comptime points: []const [2]f64) []const Point {
    const result = comptime blk: {
        var out: [points.len]Point = undefined;
        for (points, 0..) |p, i| out[i] = .{ .x = p[0], .y = p[1] };
        break :blk out;
    };
    return &result;
}

fn expectVertex(v: Vertex, x: f64, y: f64, ex: f64, ey: f64, dist: f64) !void {
    try std.testing.expectApproxEqAbs(@as(f32, @floatCast(x)), v.x, 1e-3);
    try std.testing.expectApproxEqAbs(@as(f32, @floatCast(y)), v.y, 1e-3);
    try std.testing.expectApproxEqAbs(@as(f32, @floatCast(ex)), v.extrude_x, 1e-5);
    try std.testing.expectApproxEqAbs(@as(f32, @floatCast(ey)), v.extrude_y, 1e-5);
    try std.testing.expectApproxEqAbs(@as(f32, @floatCast(dist)), v.dist, 1e-6);
}

test "a square inside the tile becomes a closed strip with inward miters" {
    var layout = Layout.init(std.testing.allocator, 8192);
    defer layout.deinit();
    try layout.addPolygon(&.{ringOf(&.{ .{ 1000, 1000 }, .{ 7000, 1000 }, .{ 7000, 7000 }, .{ 1000, 7000 }, .{ 1000, 1000 } })}, 7);
    // Four corners plus the repeated first pair close the loop.
    try std.testing.expectEqual(@as(usize, 10), layout.vertices.items.len);
    try std.testing.expectEqual(@as(usize, 24), layout.indices.items.len);
    try expectVertex(layout.vertices.items[0], 1000, 1000, 0, 0, 0);
    try expectVertex(layout.vertices.items[1], 1000, 1000, 1, 1, 1);
    try expectVertex(layout.vertices.items[3], 7000, 1000, -1, 1, 1);
    try expectVertex(layout.vertices.items[5], 7000, 7000, -1, -1, 1);
    try expectVertex(layout.vertices.items[7], 1000, 7000, 1, -1, 1);
    try expectVertex(layout.vertices.items[9], 1000, 1000, 1, 1, 1);
    try std.testing.expectEqualSlices(u16, &.{ 0, 1, 3, 0, 3, 2 }, layout.indices.items[0..6]);
    try std.testing.expectEqual(@as(usize, 1), layout.segments.items.len);
    try std.testing.expectEqual(@as(u32, 10), layout.segments.items[0].vertex_length);
    try std.testing.expectEqual(@as(u32, 24), layout.segments.items[0].index_length);
    try std.testing.expectEqual(@as(usize, 1), layout.ranges.items.len);
    try std.testing.expectEqual(Range{ .feature_index = 7, .first_vertex = 0, .vertex_count = 10 }, layout.ranges.items[0]);
}

test "a hole fans the band around its reflex corners" {
    var layout = Layout.init(std.testing.allocator, 8192);
    defer layout.deinit();
    // An island: opposite winding, so the water is outside the ring.
    try layout.addPolygon(&.{ringOf(&.{ .{ 3000, 3000 }, .{ 3000, 5000 }, .{ 5000, 5000 }, .{ 5000, 3000 } })}, 0);
    // Each 90° corner fans through three extrusions (0°, -45°, -90°), and the
    // first corner repeats to close the loop.
    try std.testing.expectEqual(@as(usize, 2 * (4 * 3 + 3)), layout.vertices.items.len);
    try expectVertex(layout.vertices.items[1], 3000, 3000, 0, -1, 1);
    try expectVertex(layout.vertices.items[3], 3000, 3000, -std.math.sqrt1_2, -std.math.sqrt1_2, 1);
    try expectVertex(layout.vertices.items[5], 3000, 3000, -1, 0, 1);
    try expectVertex(layout.vertices.items[7], 3000, 5000, -1, 0, 1);
    try expectVertex(layout.vertices.items[9], 3000, 5000, -std.math.sqrt1_2, std.math.sqrt1_2, 1);
    try expectVertex(layout.vertices.items[11], 3000, 5000, 0, 1, 1);
    try expectVertex(layout.vertices.items[29], 3000, 3000, -1, 0, 1);
}

test "edges are clipped to the margin and tile-edge cuts are dropped" {
    var layout = Layout.init(std.testing.allocator, 8192);
    defer layout.deinit();
    try layout.addPolygon(&.{ringOf(&.{ .{ -6000, 2000 }, .{ 4000, 2000 }, .{ 4000, 6000 }, .{ -6000, 6000 } })}, 0);
    // One open chain clipped at the margin: the top edge, the right edge, the bottom edge.
    try std.testing.expectEqual(@as(usize, 8), layout.vertices.items.len);
    try std.testing.expectEqual(@as(usize, 18), layout.indices.items.len);
    try expectVertex(layout.vertices.items[0], -4096, 2000, 0, 0, 0);
    try expectVertex(layout.vertices.items[1], -4096, 2000, 0, 1, 1);
    try expectVertex(layout.vertices.items[3], 4000, 2000, -1, 1, 1);
    try expectVertex(layout.vertices.items[5], 4000, 6000, -1, -1, 1);
    try expectVertex(layout.vertices.items[7], -4096, 6000, 0, -1, 1);

    // Geometry in the tile buffer is kept whole, so a corner just outside
    // the tile still gets its miter.
    var buffered = Layout.init(std.testing.allocator, 8192);
    defer buffered.deinit();
    try buffered.addPolygon(&.{ringOf(&.{ .{ -100, 2000 }, .{ 4000, 1500 }, .{ 4000, 6000 }, .{ -200, 6000 } })}, 0);
    try std.testing.expectEqual(@as(usize, 10), buffered.vertices.items.len);
    try expectVertex(buffered.vertices.items[0], -100, 2000, 0, 0, 0);
    try std.testing.expectApproxEqAbs(@as(f32, 1), buffered.vertices.items[1].dist, 0);

    // A polygon cut exactly along the tile edge contributes no shoreline there.
    var cut = Layout.init(std.testing.allocator, 8192);
    defer cut.deinit();
    try cut.addPolygon(&.{ringOf(&.{ .{ 0, 0 }, .{ 4000, 0 }, .{ 4000, 4000 }, .{ 0, 4000 } })}, 0);
    try std.testing.expectEqual(@as(usize, 6), cut.vertices.items.len);
    try expectVertex(cut.vertices.items[0], 4000, 0, 0, 0, 0);
    try expectVertex(cut.vertices.items[5], 0, 4000, 0, -1, 1);

    // Entirely outside the margin: nothing, and no feature range.
    var outside = Layout.init(std.testing.allocator, 8192);
    defer outside.deinit();
    try outside.addPolygon(&.{ringOf(&.{ .{ -9000, -9000 }, .{ -5000, -9000 }, .{ -5000, -5000 }, .{ -9000, -5000 } })}, 0);
    try std.testing.expectEqual(@as(usize, 0), outside.vertices.items.len);
    try std.testing.expectEqual(@as(usize, 0), outside.ranges.items.len);
}

test "a chain leaving the margin runs through the ring start as one strip" {
    var layout = Layout.init(std.testing.allocator, 8192);
    defer layout.deinit();
    // A wedge whose tip pokes out beyond the clip margin.
    try layout.addPolygon(&.{ringOf(&.{ .{ 2000, 2000 }, .{ 4000, -7000 }, .{ 6000, 2000 }, .{ 6000, 6000 }, .{ 2000, 6000 } })}, 3);
    // One open chain from where the tip re-enters, around the ring, to where it leaves.
    try std.testing.expectEqual(@as(usize, 12), layout.vertices.items.len);
    try std.testing.expectEqual(@as(usize, 30), layout.indices.items.len);
    try expectVertex(layout.vertices.items[0], 4000 + 2000 * 2904.0 / 9000.0, -4096, 0, 0, 0);
    try expectVertex(layout.vertices.items[2], 6000, 2000, 0, 0, 0);
    try expectVertex(layout.vertices.items[8], 2000, 2000, 0, 0, 0);
    try expectVertex(layout.vertices.items[10], 2000 + 2000 * 6096.0 / 9000.0, -4096, 0, 0, 0);
    try std.testing.expectEqual(Range{ .feature_index = 3, .first_vertex = 0, .vertex_count = 12 }, layout.ranges.items[0]);
}

test "extrusions are limited to half the distance to the opposite bank" {
    var layout = Layout.init(std.testing.allocator, 8192);
    defer layout.deinit();
    // A channel 200 units wide: every inner vertex may extrude 100 units,
    // including the mitered corners, whose diagonal rays hit the far bank
    // at 200·√2 with a √2-long extrusion.
    try layout.addPolygon(&.{ringOf(&.{ .{ 1000, 1000 }, .{ 7000, 1000 }, .{ 7000, 1200 }, .{ 1000, 1200 } })}, 0);
    for (layout.vertices.items, 0..) |v, i| {
        if (i % 2 == 0) continue;
        try std.testing.expectApproxEqAbs(@as(f32, 100), v.limit, 1e-3);
    }
    // A square's corner ray hits the opposite corner; past `reach` the limit is off.
    var wide = Layout.init(std.testing.allocator, 8192);
    defer wide.deinit();
    try wide.addPolygon(&.{ringOf(&.{ .{ 1000, 1000 }, .{ 3500, 1000 }, .{ 3500, 3500 }, .{ 1000, 3500 } })}, 0);
    try std.testing.expectApproxEqAbs(@as(f32, 1250), wide.vertices.items[1].limit, 1e-2);
    var huge = Layout.init(std.testing.allocator, 8192);
    defer huge.deinit();
    try huge.addPolygon(&.{ringOf(&.{ .{ 4096, -3000 }, .{ 11000, 4096 }, .{ 4096, 11000 }, .{ -3000, 4096 } })}, 0);
    try std.testing.expectEqual(unlimited, huge.vertices.items[1].limit);
    // An island inside a lake limits the lake's band and its own.
    var lake = Layout.init(std.testing.allocator, 8192);
    defer lake.deinit();
    try lake.addPolygon(&.{ ringOf(&.{ .{ 1000, 1000 }, .{ 7000, 1000 }, .{ 7000, 7000 }, .{ 1000, 7000 } }), ringOf(&.{ .{ 3000, 3000 }, .{ 3000, 5000 }, .{ 5000, 5000 }, .{ 5000, 3000 } }) }, 0);
    // Lake corner (1000,1000) along (1,1) hits the island corner at 2000·√2.
    try std.testing.expectApproxEqAbs(@as(f32, 1000), lake.vertices.items[1].limit, 1e-2);
    // Island edge x=3000 extrudes toward x=1000: limit 1000.
    try std.testing.expectApproxEqAbs(@as(f32, 1000), lake.vertices.items[10 + 5].limit, 1e-2);
}

test "degenerate rings and repeated points are ignored" {
    var layout = Layout.init(std.testing.allocator, 8192);
    defer layout.deinit();
    try layout.addPolygon(&.{ ringOf(&.{ .{ 100, 100 }, .{ 200, 200 }, .{ 300, 300 } }), ringOf(&.{ .{ 500, 500 }, .{ 500, 500 } }), ringOf(&.{ .{ 1000, 1000 }, .{ 1000, 1000 }, .{ 2000, 1000 }, .{ 2000, 2000 }, .{ 1000, 2000 }, .{ 1000, 1000 } }) }, 0);
    // Only the square survives; its duplicate point makes a zero-length edge that is skipped.
    try std.testing.expectEqual(@as(usize, 10), layout.vertices.items.len);
    try std.testing.expectEqual(@as(usize, 1), layout.ranges.items.len);
}

test "long chains split across 16-bit segments and stay joined" {
    var layout = Layout.init(std.testing.allocator, 8192);
    defer layout.deinit();
    // A jagged coast with 40000 points; its reflex corners fan, so the strip
    // needs several segments.
    const count = 40000;
    const points = try std.testing.allocator.alloc(Point, count);
    defer std.testing.allocator.free(points);
    for (0..count) |i| {
        const t = @as(f64, @floatFromInt(i)) / count;
        points[i] = .{ .x = 100 + 8000 * t, .y = if (i % 2 == 0) 100 else 150 };
    }
    points[count - 1] = .{ .x = 4000, .y = 8000 };
    try layout.addPolygon(&.{points}, 1);
    try std.testing.expect(layout.segments.items.len >= 2);
    var total: usize = 0;
    for (layout.segments.items, 0..) |segment, i| {
        try std.testing.expect(segment.vertex_length <= max_segment_vertices);
        try std.testing.expectEqual(@as(u32, @intCast(total)), segment.vertex_offset);
        total += segment.vertex_length;
        for (layout.indices.items[segment.index_offset .. segment.index_offset + segment.index_length]) |index| try std.testing.expect(index < segment.vertex_length);
        if (i == 0) continue;
        // The pair that straddles a split ends one segment and starts the next.
        const previous = layout.segments.items[i - 1];
        const tail = layout.vertices.items[previous.vertex_offset + previous.vertex_length - 2];
        const head = layout.vertices.items[segment.vertex_offset];
        try std.testing.expectEqual(tail.x, head.x);
        try std.testing.expectEqual(tail.y, head.y);
        try std.testing.expectEqual(previous.index_offset + previous.index_length, segment.index_offset);
    }
    try std.testing.expectEqual(layout.vertices.items.len, total);
    try std.testing.expectEqual(Range{ .feature_index = 1, .first_vertex = 0, .vertex_count = @intCast(total) }, layout.ranges.items[0]);
}
