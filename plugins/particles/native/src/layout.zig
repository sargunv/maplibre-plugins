//! particle-features tile layout: the particle slots each feature of a tile
//! gets and where each is anchored, as `a_emit` vertices (properties.emit).
//! Particles are stateless, so a slot is only an identity: the shader
//! (particleFeatureSeed in ../../shaders/particle.glsl) hashes the anchor and
//! slot into its randoms and culls slots by particle-density, since layout
//! sees no paint.
//!
//! - Points: every point the tile owns (0 <= x, y < extent) gets 16 slots.
//! - Lines: every segment is clipped to the tile square (Liang–Barsky), and
//!   the tile that owns the clipped piece's midpoint keeps the piece. Slots
//!   are one per 32 tile units along each path: a piece gets the ones its
//!   length carries the path's running count past, so a densely sampled line
//!   gets no more than a straight one and a piece may get none. They are
//!   anchored at the piece's midpoint with its half length and compass
//!   direction, so their particles stay on the piece.
//! - Polygons: a 128-unit lattice over the tile with one jittered candidate
//!   per cell; each candidate inside the polygon (even-odd over every ring,
//!   so holes work) gets one slot. Candidates never leave their cell, so a
//!   tile only ever places its own.
//!
//! Ownership is half-open, so features in the buffers of neighbouring tiles
//! are laid out once across them. A tile keeps at most 16383 slots (one
//! segment of 16-bit indices). Past that every kind keeps its share: points
//! keep their lowest ranks, the ones particle-density draws first, and line
//! and polygon slots an even stride (Layout.finish).
//!
//! This file is the twin of ../../js/src/layout.ts; both are tested against
//! ../../fixtures/layout-{points,lines,polygons}.json. Every float step is
//! written out (rounding is floor(x + 0.5), products in one order) so the twin
//! reproduces it exactly.

const std = @import("std");
const build_options = @import("build_options");
const properties = @import("properties.zig");
const hash = @import("hash.zig");

const emit = properties.emit;
const spec = properties.layout;

/// Slots of one line piece at most (a full-tile diagonal needs 362).
pub const max_line_slots: u32 = 1023;

/// A tile point: the host's int16 tile coordinates.
pub const Point = struct { x: i32, y: i32 };

/// One a_emit value (x, y, z, w); see properties.emit.
pub const Vertex = [4]f32;

/// The vertices one feature kept, for the host's feature index.
pub const Range = struct {
    feature_index: u64,
    first_vertex: u32,
    vertex_count: u32,
};

pub const Kind = enum(u32) {
    point = emit.kind_point,
    line = emit.kind_line,
    polygon = emit.kind_polygon,
};

/// Slots that share one anchor: a point's 16, a line piece's, a polygon
/// cell's one.
const Group = struct {
    x: f32,
    y: f32,
    z: f32,
    kind: Kind,
    slots: u32,
};

/// A feature that produced groups: its own are the ones up to `group_end`.
const Feature = struct {
    index: u64,
    group_end: u32,
};

/// A non-horizontal polygon edge in quarter tile units, stored from its
/// lower end (x0, y0) to its upper end (x1, y1), y0 < y1.
const Edge = struct { x0: i64, y0: i64, x1: i64, y1: i64 };

pub const Layout = struct {
    allocator: std.mem.Allocator,
    extent: u32,
    /// Slots the tile keeps at most (spec layout.maxParticlesPerTile); the
    /// fixtures lower it to test the thinning by hand.
    max_slots: u32 = spec.max_particles_per_tile,
    groups: std.ArrayList(Group) = .empty,
    features: std.ArrayList(Feature) = .empty,
    /// Slots of every group, before the cap.
    slot_count: u64 = 0,
    /// Point groups, each of spec.point_slots slots.
    point_count: u64 = 0,
    /// finish() output: four vertices per kept slot, grouped by feature.
    vertices: std.ArrayList(Vertex) = .empty,
    ranges: std.ArrayList(Range) = .empty,
    edges: std.ArrayList(Edge) = .empty,
    band: std.ArrayList(Edge) = .empty,

    pub fn init(allocator: std.mem.Allocator, extent: u32) Layout {
        return .{ .allocator = allocator, .extent = extent };
    }

    pub fn deinit(self: *Layout) void {
        self.groups.deinit(self.allocator);
        self.features.deinit(self.allocator);
        self.vertices.deinit(self.allocator);
        self.ranges.deinit(self.allocator);
        self.edges.deinit(self.allocator);
        self.band.deinit(self.allocator);
    }

    /// Lays out one feature. Points may come one per path (vector tiles) or
    /// several per path (GeoJSON multipoints); every point counts. Features
    /// must come in the order their slots should be kept in.
    pub fn add(self: *Layout, kind: Kind, feature_index: u64, paths: []const []const Point) !void {
        const start = self.groups.items.len;
        switch (kind) {
            .point => for (paths) |path| for (path) |p| try self.addPoint(p),
            .line => for (paths) |path| {
                if (path.len < 2) continue;
                // The kept length of the path so far.
                var run: f64 = 0;
                for (path[0 .. path.len - 1], path[1..]) |a, b| try self.addSegment(a, b, &run);
            },
            .polygon => try self.addPolygon(paths),
        }
        if (self.groups.items.len > start) try self.features.append(self.allocator, .{ .index = feature_index, .group_end = @intCast(self.groups.items.len) });
    }

    fn addGroup(self: *Layout, group: Group) !void {
        try self.groups.append(self.allocator, group);
        self.slot_count += group.slots;
    }

    fn owns(self: *const Layout, x: f64, y: f64) bool {
        const e: f64 = @floatFromInt(self.extent);
        return x >= 0 and y >= 0 and x < e and y < e;
    }

    fn addPoint(self: *Layout, p: Point) !void {
        const x: f64 = @floatFromInt(p.x);
        const y: f64 = @floatFromInt(p.y);
        if (!self.owns(x, y)) return;
        try self.addGroup(.{ .x = @floatCast(x), .y = @floatCast(y), .z = 0, .kind = .point, .slots = spec.point_slots });
        self.point_count += 1;
    }

    /// One line segment: clipped to [0, extent]², kept when at least one
    /// tile unit long and its midpoint is this tile's. `run` is the kept
    /// length of its path before it; the piece adds its own.
    fn addSegment(self: *Layout, a: Point, b: Point, run: *f64) !void {
        const e: f64 = @floatFromInt(self.extent);
        const ax: f64 = @floatFromInt(a.x);
        const ay: f64 = @floatFromInt(a.y);
        const dx: f64 = @floatFromInt(b.x - a.x);
        const dy: f64 = @floatFromInt(b.y - a.y);
        // Liang–Barsky: p·t <= q for each side of the square.
        var t0: f64 = 0;
        var t1: f64 = 1;
        const sides = [4][2]f64{ .{ -dx, ax }, .{ dx, e - ax }, .{ -dy, ay }, .{ dy, e - ay } };
        for (sides) |side| {
            const p = side[0];
            const q = side[1];
            if (p == 0) {
                if (q < 0) return;
                continue;
            }
            const t = q / p;
            if (p < 0) t0 = @max(t0, t) else t1 = @min(t1, t);
        }
        if (t0 > t1) return;
        const x0 = ax + t0 * dx;
        const y0 = ay + t0 * dy;
        const x1 = ax + t1 * dx;
        const y1 = ay + t1 * dy;
        const length = @sqrt((x1 - x0) * (x1 - x0) + (y1 - y0) * (y1 - y0));
        if (length < 1) return;
        const mx = (x0 + x1) / 2;
        const my = (y0 + y1) / 2;
        if (!self.owns(mx, my)) return;
        // Compass direction (clockwise from north, y down) in 1024 steps. No
        // integer delta lies exactly on a step's rounding edge, and one within
        // an ulp of it is astronomically unlikely, so atan2 implementations
        // that differ in the last ulp still agree on the step.
        const theta = std.math.atan2(dx, -dy);
        const direction = @mod(round(theta / (2 * std.math.pi) * @as(f64, emit.line_angle_steps)), @as(f64, emit.line_angle_steps));
        const half_length = round(length / 2);
        // One slot per spacing along the path: the ones this piece's length
        // carries the path's count past.
        const spacing: f64 = spec.line_slot_spacing;
        const after = run.* + length;
        const slots = @min(round(after / spacing) - round(run.* / spacing), @as(f64, max_line_slots));
        run.* = after;
        if (slots == 0) return;
        try self.addGroup(.{
            .x = @floatCast(quarter(mx)),
            .y = @floatCast(quarter(my)),
            .z = @floatCast(direction * @as(f64, emit.line_length_steps) + half_length),
            .kind = .line,
            .slots = @intFromFloat(slots),
        });
    }

    /// Every lattice cell of the tile that the polygon's bounding box touches
    /// tests its jittered candidate; rows collect the edges their candidates
    /// can cross first.
    fn addPolygon(self: *Layout, rings: []const []const Point) !void {
        self.edges.clearRetainingCapacity();
        var min = Point{ .x = std.math.maxInt(i32), .y = std.math.maxInt(i32) };
        var max = Point{ .x = std.math.minInt(i32), .y = std.math.minInt(i32) };
        for (rings) |ring| {
            for (ring, 0..) |p, i| {
                min = .{ .x = @min(min.x, p.x), .y = @min(min.y, p.y) };
                max = .{ .x = @max(max.x, p.x), .y = @max(max.y, p.y) };
                // Rings close back to their first point; horizontal edges
                // (including a repeated closing point) never cross a scanline.
                const q = ring[(i + 1) % ring.len];
                if (p.y == q.y) continue;
                const ends: [2]Point = if (p.y < q.y) .{ p, q } else .{ q, p };
                try self.edges.append(self.allocator, .{ .x0 = quarters * ends[0].x, .y0 = quarters * ends[0].y, .x1 = quarters * ends[1].x, .y1 = quarters * ends[1].y });
            }
        }
        const extent: i64 = self.extent;
        const cell: i64 = spec.polygon_cell;
        const cells = @divFloor(extent, cell);
        if (self.edges.items.len == 0 or cells == 0) return;
        if (max.x < 0 or max.y < 0 or min.x >= extent or min.y >= extent) return;
        const a0 = std.math.clamp(@divFloor(@as(i64, min.x), cell), 0, cells - 1);
        const a1 = std.math.clamp(@divFloor(@as(i64, max.x), cell), 0, cells - 1);
        const b0 = std.math.clamp(@divFloor(@as(i64, min.y), cell), 0, cells - 1);
        const b1 = std.math.clamp(@divFloor(@as(i64, max.y), cell), 0, cells - 1);
        // Candidates sit at most a quarter cell from their cell's center.
        const reach = quarters * @divExact(cell, 4);
        var b = b0;
        while (b <= b1) : (b += 1) {
            const center_y = quarters * (cell * b + cell / 2);
            self.band.clearRetainingCapacity();
            for (self.edges.items) |edge| {
                if (edge.y0 <= center_y + reach and edge.y1 > center_y - reach) try self.band.append(self.allocator, edge);
            }
            if (self.band.items.len == 0) continue;
            var a = a0;
            while (a <= a1) : (a += 1) {
                const h = hash.pcg3d(.{ @intCast(a), @intCast(b), 0x51 });
                const x = quarters * (cell * a + cell / 2) + jitter(h[0]);
                const y = center_y + jitter(h[1]);
                if (!inside(self.band.items, x, y)) continue;
                try self.addGroup(.{ .x = quarterUnits(x), .y = quarterUnits(y), .z = 0, .kind = .polygon, .slots = 1 });
            }
        }
    }

    /// Writes four vertices per kept slot, feature by feature, and one range
    /// per feature that kept any. Past `max_slots` of T slots, each kind
    /// keeps its share: the Tp point slots Bp = floor(max·Tp/T), and the To
    /// line and polygon slots Bo = max - Bp. Exactly max are kept.
    /// - The shader draws a point's slots in rank order up to
    ///   particle-density, so points keep their lowest ranks: with Bp = k·P
    ///   + rem over P points, every point keeps ranks below k, and point p
    ///   (in feature and group order) also keeps rank k iff
    ///   floor((p+1)·rem/P) > floor(p·rem/P).
    /// - Line and polygon slots each draw a random share, so they keep an
    ///   even stride: the o-th (in the same order) is kept iff
    ///   floor((o+1)·Bo/To) > floor(o·Bo/To).
    pub fn finish(self: *Layout) !void {
        self.vertices.clearRetainingCapacity();
        self.ranges.clearRetainingCapacity();
        const total = self.slot_count;
        const cap: u64 = self.max_slots;
        const points = self.point_count;
        const point_total = spec.point_slots * points;
        const other_total = total - point_total;
        const point_budget = if (total > cap) cap * point_total / total else point_total;
        const other_budget = if (total > cap) cap - point_budget else other_total;
        const ranks = if (points > 0) point_budget / points else 0;
        const extra = point_budget - ranks * points;
        try self.vertices.ensureTotalCapacity(self.allocator, @intCast(4 * @min(total, cap)));
        var p: u64 = 0;
        var o: u64 = 0;
        var start: usize = 0;
        for (self.features.items) |feature| {
            const first: u32 = @intCast(self.vertices.items.len);
            for (self.groups.items[start..feature.group_end]) |group| {
                if (group.kind == .point) {
                    const kept = ranks + @intFromBool((p + 1) * extra / points > p * extra / points);
                    p += 1;
                    for (0..kept) |slot| self.addSlot(group, slot);
                } else for (0..group.slots) |slot| {
                    defer o += 1;
                    if ((o + 1) * other_budget / other_total > o * other_budget / other_total) self.addSlot(group, slot);
                }
            }
            start = feature.group_end;
            const count: u32 = @as(u32, @intCast(self.vertices.items.len)) - first;
            if (count > 0) try self.ranges.append(self.allocator, .{ .feature_index = feature.index, .first_vertex = first, .vertex_count = count });
        }
        std.debug.assert(self.vertices.items.len / 4 == @min(total, cap));
    }

    /// The four vertices of a group's slot of this rank, into the capacity
    /// finish() reserved.
    fn addSlot(self: *Layout, group: Group, slot: usize) void {
        const code: u32 = @as(u32, @intCast(slot)) * emit.slot_stride + @intFromEnum(group.kind);
        for (0..4) |corner| {
            const w: f32 = @floatFromInt(code + @as(u32, @intCast(corner)) * emit.corner_stride);
            self.vertices.appendAssumeCapacity(.{ group.x, group.y, group.z, w });
        }
    }

    /// Kept slots (quads) after finish().
    pub fn quads(self: *const Layout) u32 {
        return @intCast(self.vertices.items.len / 4);
    }
};

/// Rounds half up, the same in every twin (not Zig's @round or JS
/// Math.round, which disagree on negative halves).
fn round(x: f64) f64 {
    return @floor(x + 0.5);
}

/// Snaps a tile coordinate to the anchor grid (1/4 tile unit).
fn quarter(x: f64) f64 {
    const steps: f64 = emit.anchor_steps;
    return round(steps * x) / steps;
}

/// Anchor steps per tile unit, as polygon candidates count them.
const quarters: i64 = emit.anchor_steps;

fn quarterUnits(x: i64) f32 {
    return @as(f32, @floatFromInt(x)) / @as(f32, emit.anchor_steps);
}

/// A candidate's offset from its cell center in quarter tile units:
/// round4((u01(h) - 0.5)·64), in [-128, 128].
fn jitter(h: u32) i64 {
    const u: f64 = hash.unit(h);
    const offset = (u - 0.5) * @as(f64, spec.polygon_cell / 2);
    return @intFromFloat(round(@as(f64, emit.anchor_steps) * offset));
}

/// Even-odd test of (x, y) in quarter units against the edges: counts the
/// edges a ray to +x crosses, each edge spanning y0 <= y < y1 so a vertex on
/// the ray counts once. Exact: the crossing test is an integer comparison,
/// x < x0 + (y - y0)·(x1 - x0)/(y1 - y0) multiplied out. A point exactly on
/// an edge is inside only where the polygon extends to its +x side, so
/// polygons sharing an edge never both claim it.
fn inside(edges: []const Edge, x: i64, y: i64) bool {
    var odd = false;
    for (edges) |edge| {
        if (y < edge.y0 or y >= edge.y1) continue;
        if ((x - edge.x0) * (edge.y1 - edge.y0) < (y - edge.y0) * (edge.x1 - edge.x0)) odd = !odd;
    }
    return odd;
}

// ---------------------------------------------------------------------------
// Tests. The shared fixtures pin every output; js/src/layout.test.ts reads
// the same files.
// ---------------------------------------------------------------------------

fn jsonInt(value: std.json.Value) !i64 {
    return switch (value) {
        .integer => |i| i,
        .float => |f| if (@floor(f) == f) @intFromFloat(f) else error.NotAnInteger,
        else => error.NotAnInteger,
    };
}

fn jsonF32(value: std.json.Value) !f32 {
    return switch (value) {
        .integer => |i| @floatFromInt(i),
        .float => |f| @floatCast(f),
        else => error.NotANumber,
    };
}

/// FNV-1a (32-bit) over the vertex stream as the host receives it: four
/// little-endian f32 per vertex.
pub fn digest(vertices: []const Vertex) u32 {
    var hasher = std.hash.Fnv1a_32.init();
    for (vertices) |vertex| for (vertex) |component| {
        var bytes: [4]u8 = undefined;
        std.mem.writeInt(u32, &bytes, @bitCast(component), .little);
        hasher.update(&bytes);
    };
    return hasher.final();
}

/// Runs every case of one fixture file:
/// {"cases": [{"name", "extent"?, "maxParticles"?,
///   "features": [{"index", "type": "point"|"line"|"polygon", "paths": [[[x, y], ...], ...]}],
///   "expected": {"slotCount", "segment": {"vertexLength", "indexLength"},
///     "ranges": [[featureIndex, firstVertex, vertexCount], ...],
///     "slots"?: [[x, y, z, w], ...] (per kept slot, corner 0; corner k adds 4k to w),
///     "digest"?: fnv1a32 of the vertex stream}}]}
fn expectFixture(text: []const u8) !void {
    const allocator = std.testing.allocator;
    var parsed = try std.json.parseFromSlice(std.json.Value, allocator, text, .{});
    defer parsed.deinit();
    const cases = parsed.value.object.get("cases").?.array.items;
    try std.testing.expect(cases.len > 0);
    var points: std.ArrayList(Point) = .empty;
    defer points.deinit(allocator);
    var paths: std.ArrayList([]const Point) = .empty;
    defer paths.deinit(allocator);
    for (cases) |case_value| {
        const case = case_value.object;
        const name = case.get("name").?.string;
        errdefer std.debug.print("layout fixture case failed: {s}\n", .{name});
        var layout = Layout.init(allocator, if (case.get("extent")) |e| @intCast(try jsonInt(e)) else 8192);
        defer layout.deinit();
        if (case.get("maxParticles")) |m| layout.max_slots = @intCast(try jsonInt(m));
        for (case.get("features").?.array.items) |feature_value| {
            const feature = feature_value.object;
            const kind = std.meta.stringToEnum(Kind, feature.get("type").?.string) orelse return error.UnknownKind;
            const path_values = feature.get("paths").?.array.items;
            points.clearRetainingCapacity();
            paths.clearRetainingCapacity();
            for (path_values) |path| for (path.array.items) |p| try points.append(allocator, .{ .x = @intCast(try jsonInt(p.array.items[0])), .y = @intCast(try jsonInt(p.array.items[1])) });
            var start: usize = 0;
            for (path_values) |path| {
                try paths.append(allocator, points.items[start .. start + path.array.items.len]);
                start += path.array.items.len;
            }
            try layout.add(kind, @intCast(try jsonInt(feature.get("index").?)), paths.items);
        }
        try layout.finish();

        const expected = case.get("expected").?.object;
        try std.testing.expectEqual(try jsonInt(expected.get("slotCount").?), @as(i64, @intCast(layout.slot_count)));
        const segment = expected.get("segment").?.object;
        try std.testing.expectEqual(try jsonInt(segment.get("vertexLength").?), @as(i64, @intCast(layout.vertices.items.len)));
        try std.testing.expectEqual(try jsonInt(segment.get("indexLength").?), @as(i64, 6 * layout.quads()));
        const ranges = expected.get("ranges").?.array.items;
        try std.testing.expectEqual(ranges.len, layout.ranges.items.len);
        for (ranges, layout.ranges.items) |range, actual| {
            const r = range.array.items;
            try std.testing.expectEqual(Range{ .feature_index = @intCast(try jsonInt(r[0])), .first_vertex = @intCast(try jsonInt(r[1])), .vertex_count = @intCast(try jsonInt(r[2])) }, actual);
        }
        var checked = false;
        if (expected.get("slots")) |slots| {
            checked = true;
            try std.testing.expectEqual(slots.array.items.len, layout.quads());
            for (slots.array.items, 0..) |slot, i| {
                for (0..4) |corner| {
                    const actual = layout.vertices.items[4 * i + corner];
                    const values = slot.array.items;
                    for (0..3) |k| try std.testing.expectEqual(try jsonF32(values[k]), actual[k]);
                    try std.testing.expectEqual(try jsonF32(values[3]) + @as(f32, @floatFromInt(4 * corner)), actual[3]);
                }
            }
        }
        if (expected.get("digest")) |d| {
            checked = true;
            try std.testing.expectEqual(try jsonInt(d), @as(i64, digest(layout.vertices.items)));
        }
        try std.testing.expect(checked);
    }
}

test "point layout matches the shared fixture" {
    try expectFixture(build_options.fixture_layout_points);
}

test "line layout matches the shared fixture" {
    try expectFixture(build_options.fixture_layout_lines);
}

test "polygon layout matches the shared fixture" {
    try expectFixture(build_options.fixture_layout_polygons);
}

fn pathsOf(comptime paths: []const []const [2]i32) []const []const Point {
    const result = comptime blk: {
        var out: [paths.len][]const Point = undefined;
        for (paths, 0..) |path, i| {
            const points = inner: {
                var ps: [path.len]Point = undefined;
                for (path, 0..) |p, j| ps[j] = .{ .x = p[0], .y = p[1] };
                break :inner ps;
            };
            out[i] = &points;
        }
        break :blk out;
    };
    return &result;
}

test "points are owned half-open and keep their 16 slots in order" {
    var layout = Layout.init(std.testing.allocator, 8192);
    defer layout.deinit();
    try layout.add(.point, 3, pathsOf(&.{ &.{.{ 0, 8191 }}, &.{.{ 8192, 5 }}, &.{.{ -1, 5 }}, &.{.{ 5, 8192 }} }));
    try layout.finish();
    try std.testing.expectEqual(@as(u64, 16), layout.slot_count);
    try std.testing.expectEqual(@as(usize, 64), layout.vertices.items.len);
    for (layout.vertices.items, 0..) |v, i| {
        const slot: f32 = @floatFromInt(i / 4);
        const corner: f32 = @floatFromInt(i % 4);
        try std.testing.expectEqual(Vertex{ 0, 8191, 0, slot * 16 + corner * 4 }, v);
    }
    try std.testing.expectEqual(Range{ .feature_index = 3, .first_vertex = 0, .vertex_count = 64 }, layout.ranges.items[0]);
}

test "a line piece is owned by the tile holding its midpoint, once across a seam" {
    // The same segment seen from the tile on each side of x = 8192.
    var left = Layout.init(std.testing.allocator, 8192);
    defer left.deinit();
    try left.add(.line, 0, pathsOf(&.{&.{ .{ 8000, 100 }, .{ 8400, 100 } }}));
    try left.finish();
    var right = Layout.init(std.testing.allocator, 8192);
    defer right.deinit();
    try right.add(.line, 0, pathsOf(&.{&.{ .{ -192, 100 }, .{ 208, 100 } }}));
    try right.finish();
    // Left keeps [8000, 8192]: 192 long, 6 slots; right keeps [0, 208]: 7.
    try std.testing.expectEqual(@as(u64, 6), left.slot_count);
    try std.testing.expectEqual(@as(u64, 7), right.slot_count);
    // East is step 256; the half lengths are 96 and 104.
    try std.testing.expectEqual(Vertex{ 8096, 100, 256 * 8192 + 96, 1 }, left.vertices.items[0]);
    try std.testing.expectEqual(Vertex{ 104, 100, 256 * 8192 + 104, 1 }, right.vertices.items[0]);
    try std.testing.expectEqual(@as(f32, 5 * 16 + 3 * 4 + 1), left.vertices.items[left.vertices.items.len - 1][3]);

    // A segment lying on the shared edge belongs to the tile it starts.
    var edge = Layout.init(std.testing.allocator, 8192);
    defer edge.deinit();
    try edge.add(.line, 0, pathsOf(&.{ &.{ .{ 8192, 100 }, .{ 8192, 900 } }, &.{ .{ 0, 100 }, .{ 0, 900 } } }));
    try edge.finish();
    try std.testing.expectEqual(@as(u64, 25), edge.slot_count);
    try std.testing.expectEqual(Vertex{ 0, 500, 512 * 8192 + 400, 1 }, edge.vertices.items[0]);
}

test "polygon candidates follow even-odd, so holes stay empty" {
    var solid = Layout.init(std.testing.allocator, 8192);
    defer solid.deinit();
    try solid.add(.polygon, 0, pathsOf(&.{&.{ .{ 1024, 1024 }, .{ 2048, 1024 }, .{ 2048, 2048 }, .{ 1024, 2048 }, .{ 1024, 1024 } }}));
    try solid.finish();
    // 8 x 8 cells lie wholly inside: every candidate of them is kept.
    try std.testing.expectEqual(@as(u64, 64), solid.slot_count);
    var holed = Layout.init(std.testing.allocator, 8192);
    defer holed.deinit();
    try holed.add(.polygon, 0, pathsOf(&.{
        &.{ .{ 1024, 1024 }, .{ 2048, 1024 }, .{ 2048, 2048 }, .{ 1024, 2048 } },
        &.{ .{ 1280, 1280 }, .{ 1280, 1792 }, .{ 1792, 1792 }, .{ 1792, 1280 } },
    }));
    try holed.finish();
    try std.testing.expectEqual(@as(u64, 64 - 16), holed.slot_count);
    for (holed.vertices.items) |v| {
        try std.testing.expect(!(v[0] > 1280 and v[0] < 1792 and v[1] > 1280 and v[1] < 1792));
        try std.testing.expectEqual(@as(f32, 0), v[2]);
        try std.testing.expectEqual(@as(u32, emit.kind_polygon), @as(u32, @intFromFloat(v[3])) % 4);
        // Quarter-unit anchors within a quarter cell of their cell's center.
        const cx = @mod(v[0], 128);
        try std.testing.expect(cx >= 32 and cx <= 96 and @floor(v[0] * 4) == v[0] * 4);
    }
}

test "a candidate on a shared edge belongs to exactly one polygon" {
    // Cell (10, 10)'s candidate, and two rectangles meeting on a vertical
    // line through it (the lattice pattern is the same in every tile).
    const h = hash.pcg3d(.{ 10, 10, 0x51 });
    const x4 = quarters * (128 * 10 + 64) + jitter(h[0]);
    const y4 = quarters * (128 * 10 + 64) + jitter(h[1]);
    const edges_left = [_]Edge{ .{ .x0 = 4 * 1000, .y0 = 4 * 1000, .x1 = 4 * 1000, .y1 = 4 * 1500 }, .{ .x0 = x4, .y0 = 4 * 1000, .x1 = x4, .y1 = 4 * 1500 } };
    const edges_right = [_]Edge{ .{ .x0 = x4, .y0 = 4 * 1000, .x1 = x4, .y1 = 4 * 1500 }, .{ .x0 = 4 * 1500, .y0 = 4 * 1000, .x1 = 4 * 1500, .y1 = 4 * 1500 } };
    try std.testing.expect(!inside(&edges_left, x4, y4) and inside(&edges_right, x4, y4));
    // On a horizontal edge it belongs to the polygon on its +y side: edges
    // span y0 <= y < y1.
    const square = [_]Edge{ .{ .x0 = 0, .y0 = 0, .x1 = 0, .y1 = 40 }, .{ .x0 = 40, .y0 = 0, .x1 = 40, .y1 = 40 } };
    try std.testing.expect(inside(&square, 20, 0) and !inside(&square, 20, 40));
    // A vertex on the ray (the apex of a diamond) is crossed once.
    const diamond = [_]Edge{
        .{ .x0 = 0, .y0 = 0, .x1 = -40, .y1 = 40 },
        .{ .x0 = 0, .y0 = 0, .x1 = 40, .y1 = 40 },
        .{ .x0 = -40, .y0 = 40, .x1 = 0, .y1 = 80 },
        .{ .x0 = 40, .y0 = 40, .x1 = 0, .y1 = 80 },
    };
    try std.testing.expect(inside(&diamond, 0, 40));
    try std.testing.expect(inside(&diamond, -39, 40));
    try std.testing.expect(!inside(&diamond, 40, 40));
    try std.testing.expect(!inside(&diamond, -80, 40));
    try std.testing.expect(inside(&diamond, 0, 1) and inside(&diamond, 0, 79));
    try std.testing.expect(!inside(&diamond, 0, 0) and !inside(&diamond, 0, 80));
}

test "the cap keeps every point's lowest ranks, the next one spread evenly" {
    var layout = Layout.init(std.testing.allocator, 8192);
    defer layout.deinit();
    layout.max_slots = 10;
    try layout.add(.point, 0, pathsOf(&.{&.{ .{ 10, 10 }, .{ 20, 20 } }}));
    try layout.add(.point, 1, pathsOf(&.{&.{.{ 30, 30 }}}));
    try layout.finish();
    try std.testing.expectEqual(@as(u64, 48), layout.slot_count);
    try std.testing.expectEqual(@as(u32, 10), layout.quads());
    // 10 = 3·3 + 1: ranks 0-2 everywhere, and rank 3 for the third point.
    const kept = [_]u32{ 0, 1, 2, 0, 1, 2, 0, 1, 2, 3 };
    for (kept, 0..) |rank, i| try std.testing.expectEqual(@as(f32, @floatFromInt(rank * 16)), layout.vertices.items[4 * i][3]);
    try std.testing.expectEqual(Range{ .feature_index = 0, .first_vertex = 0, .vertex_count = 24 }, layout.ranges.items[0]);
    try std.testing.expectEqual(Range{ .feature_index = 1, .first_vertex = 24, .vertex_count = 16 }, layout.ranges.items[1]);

    // Under the cap nothing is thinned; a feature thinned to nothing gets no range.
    var thin = Layout.init(std.testing.allocator, 8192);
    defer thin.deinit();
    thin.max_slots = 1;
    try thin.add(.point, 0, pathsOf(&.{&.{.{ 10, 10 }}}));
    try thin.add(.point, 1, pathsOf(&.{&.{.{ 20, 20 }}}));
    try thin.finish();
    try std.testing.expectEqual(@as(usize, 1), thin.ranges.items.len);
    try std.testing.expectEqual(@as(u64, 1), thin.ranges.items[0].feature_index);
}

test "a saturated tile of points draws particle-density per point as far as the budget goes" {
    // A dense city center's POI tile (3681 points), and a line and a polygon
    // sharing it.
    const allocator = std.testing.allocator;
    var layout = Layout.init(allocator, 8192);
    defer layout.deinit();
    const count = 3681;
    for (0..count) |i| {
        const x: i32 = @intCast(i % 61 * 130 + 7);
        const y: i32 = @intCast(i / 61 * 130 + 7);
        const point = [_]Point{.{ .x = x, .y = y }};
        const path = [_][]const Point{&point};
        try layout.add(.point, i, &path);
    }
    try layout.add(.line, count, pathsOf(&.{&.{ .{ 0, 4000 }, .{ 8000, 4000 } }}));
    try layout.add(.polygon, count + 1, pathsOf(&.{&.{ .{ 0, 0 }, .{ 2048, 0 }, .{ 2048, 2048 }, .{ 0, 2048 } }}));
    try layout.finish();
    const point_total: u64 = 16 * count;
    const total = layout.slot_count;
    try std.testing.expectEqual(point_total + 250 + 256, total);
    try std.testing.expectEqual(@as(u32, 16383), layout.quads());
    // Points keep floor(16383·Tp/T) slots: 4 ranks each and a fifth for an
    // even spread of the rest.
    const budget = 16383 * point_total / total;
    const ranks = budget / count;
    const extra = budget - ranks * count;
    try std.testing.expectEqual(@as(u64, 4), ranks);
    var fifth: u64 = 0;
    var last_fifth: ?usize = null;
    for (layout.ranges.items[0..count], 0..) |range, i| {
        try std.testing.expectEqual(@as(u64, i), range.feature_index);
        const slots = range.vertex_count / 4;
        try std.testing.expect(slots == ranks or slots == ranks + 1);
        // Ranks 0, 1, ... in order, with no gaps.
        for (0..slots) |rank| {
            const w: u32 = @intFromFloat(layout.vertices.items[range.first_vertex + 4 * rank][3]);
            try std.testing.expectEqual(@as(u32, @intCast(rank)), w / emit.slot_stride);
        }
        if (slots > ranks) {
            // Spread evenly: the points with the extra rank are at most
            // P / rem (rounded up) apart.
            if (last_fifth) |previous| try std.testing.expect(i - previous <= (count + extra - 1) / extra);
            last_fifth = i;
            fifth += 1;
        }
    }
    try std.testing.expectEqual(extra, fifth);
    // The line and the polygon share the rest.
    var others: u64 = 0;
    for (layout.ranges.items[count..]) |range| others += range.vertex_count / 4;
    try std.testing.expectEqual(16383 - budget, others);
}

test "line slots stay 32 units apart along a path however densely it is sampled" {
    const allocator = std.testing.allocator;
    var points: std.ArrayList(Point) = .empty;
    defer points.deinit(allocator);
    // A 3200-unit line: 100 slots at every vertex spacing.
    for ([_]i32{ 3200, 64, 48, 47, 40, 20, 16, 8, 2 }) |step| {
        points.clearRetainingCapacity();
        var x: i32 = 100;
        while (x < 3300) : (x += step) try points.append(allocator, .{ .x = x, .y = 500 });
        try points.append(allocator, .{ .x = 3300, .y = 500 });
        var layout = Layout.init(allocator, 8192);
        defer layout.deinit();
        try layout.add(.line, 0, &.{points.items});
        try layout.finish();
        errdefer std.debug.print("step {d}\n", .{step});
        try std.testing.expectEqual(@as(u64, 100), layout.slot_count);
    }
    // A 64-gon of radius 20 (126 units around) gets 4 slots, not one per
    // side.
    points.clearRetainingCapacity();
    var length: f64 = 0;
    for (0..65) |i| {
        const angle = @as(f64, @floatFromInt(i % 64)) * std.math.tau / 64;
        try points.append(allocator, .{ .x = @intFromFloat(@round(1000 + 20 * @cos(angle))), .y = @intFromFloat(@round(1000 + 20 * @sin(angle))) });
        if (i > 0) {
            const a = points.items[i - 1];
            const b = points.items[i];
            length += std.math.hypot(@as(f64, @floatFromInt(b.x - a.x)), @as(f64, @floatFromInt(b.y - a.y)));
        }
    }
    var ring = Layout.init(allocator, 8192);
    defer ring.deinit();
    try ring.add(.line, 0, &.{points.items});
    try ring.finish();
    try std.testing.expectEqual(@as(u64, @intFromFloat(round(length / 32))), ring.slot_count);
    try std.testing.expectEqual(@as(u64, 4), ring.slot_count);
}
