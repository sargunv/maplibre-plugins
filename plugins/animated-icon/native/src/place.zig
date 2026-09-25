//! Icon placement on the screen, for hit testing. This is the twin of
//! ../../js/src/place.ts, and both are CPU twins of iconPlace() in
//! ../../shaders/place.glsl: the same anchor box, anchor point, offset,
//! rotation, perspective ratio and alignments, in double precision and
//! without the shader's one-device-pixel pad, which only widens the quad for
//! anti-aliasing. The shared fixtures in ../../fixtures/place check both.
//!
//! Screen coordinates are logical pixels with y down: a clip position maps
//! to x = (ndc.x + 1) / 2 · width and y = (1 − ndc.y) / 2 · height.

const std = @import("std");

/// icon-anchor's values, in spec.json's order: the enum index is the
/// position here.
pub const anchor_values = [_][]const u8{ "center", "left", "right", "top", "bottom", "top-left", "top-right", "bottom-left", "bottom-right" };
/// icon-rotation-alignment's and icon-pitch-alignment's values.
pub const alignment_values = [_][]const u8{ "auto", "map", "viewport" };

/// Paint values of one feature, enums as indices in spec.json's order.
pub const Resolved = struct {
    /// icon-animation's entry index; 0 is none.
    animation: u32,
    size: f64,
    /// Degrees clockwise.
    rotate: f64,
    opacity: f64,
    /// Logical pixels right and down, scaled by size.
    offset: [2]f64,
    anchor: u32,
    rotation_alignment: u32,
    pitch_alignment: u32,
};

/// The catalog entry of the animation.
pub const Entry = struct {
    /// Anchor box x0, y0, x1, y1 in canvas pixels.
    box: [4]f64,
    /// Logical pixels of the box's longer side at size 1.
    display_px: f64,
};

pub const View = struct {
    /// Tile units to clip space, column-major: the query's tile matrix.
    matrix: [16]f64,
    /// Logical pixels.
    viewport: [2]f64,
    /// Unused by corners(); harnesses use it for the device-pixel scale.
    pixel_ratio: f64,
    camera_to_center_distance: f64,
    pixels_to_tile_units: f64,
    /// Radians, as the host keeps it (IconDrawableUBO.view.y): the camera
    /// bearing negated.
    bearing: f64,
};

/// The box corners (0,0), (1,0), (0,1), (1,1) on the screen, in that order.
pub const Quad = [4][2]f64;

fn clip(v: View, x: f64, y: f64) [4]f64 {
    const m = v.matrix;
    return .{
        m[0] * x + m[4] * y + m[12],
        m[1] * x + m[5] * y + m[13],
        m[2] * x + m[6] * y + m[14],
        m[3] * x + m[7] * y + m[15],
    };
}

fn toScreen(v: View, c: [4]f64) ?[2]f64 {
    if (!(c[3] > 0)) return null;
    return .{ (c[0] / c[3] + 1) / 2 * v.viewport[0], (1 - c[1] / c[3]) / 2 * v.viewport[1] };
}

/// Tile units to screen pixels, or null behind the camera.
pub fn project(v: View, p: [2]f64) ?[2]f64 {
    return toScreen(v, clip(v, p[0], p[1]));
}

/// The fraction of the anchor box that icon-anchor puts on the anchor, by
/// enum index: center, left, right, top, bottom, top-left, top-right,
/// bottom-left, bottom-right.
fn anchorFraction(anchor: u32) [2]f64 {
    const x: f64 = if (anchor == 1 or anchor == 5 or anchor == 7) 0 else if (anchor == 2 or anchor == 6 or anchor == 8) 1 else 0.5;
    const y: f64 = if (anchor == 3 or anchor == 5 or anchor == 6) 0 else if (anchor == 4 or anchor == 7 or anchor == 8) 1 else 0.5;
    return .{ x, y };
}

/// Turns v clockwise on a y-down plane by the angle with cosine and sine cs.
fn turn(v: [2]f64, cos: f64, sin: f64) [2]f64 {
    return .{ v[0] * cos - v[1] * sin, v[0] * sin + v[1] * cos };
}

const box_corners = [4][2]f64{ .{ 0, 0 }, .{ 1, 0 }, .{ 0, 1 }, .{ 1, 1 } };

/// The screen corners of the icon's anchor box for an anchor in tile units,
/// or null when the icon collapses (none, size or opacity not positive) or a
/// corner is behind the camera.
pub fn corners(anchor: [2]f64, r: Resolved, e: Entry, v: View) ?Quad {
    const size = r.size;
    if (r.animation == 0 or !(size > 0) or !(r.opacity > 0)) return null;
    const projected = clip(v, anchor[0], anchor[1]);
    const center = toScreen(v, projected) orelse return null;
    const box = e.box;
    // Logical pixels per canvas pixel.
    const scale = e.display_px * size / @max(box[2] - box[0], box[3] - box[1]);
    const rotate_with_map = r.rotation_alignment == 1;
    const pitch_with_map = r.pitch_alignment == 1 or (r.pitch_alignment == 0 and rotate_with_map);
    const camera_to_center = v.camera_to_center_distance;
    const w = projected[3];
    const distance_ratio = if (pitch_with_map) w / camera_to_center else camera_to_center / w;
    const perspective = std.math.clamp(0.5 + 0.5 * distance_ratio, 0, 4);

    const fraction = anchorFraction(r.anchor);
    const ax = box[0] + (box[2] - box[0]) * fraction[0];
    const ay = box[1] + (box[3] - box[1]) * fraction[1];
    const angle = r.rotate * std.math.pi / 180;
    const cos = @cos(angle);
    const sin = @sin(angle);

    // East at the anchor, in screen pixels, for map rotation facing the
    // camera, like the shader's u_rotate_symbol direction.
    var east = [2]f64{ 1, 0 };
    if (!pitch_with_map and rotate_with_map) {
        const east_clip = clip(v, anchor[0] + 1, anchor[1]);
        const dx = (east_clip[0] / east_clip[3] - projected[0] / w) * v.viewport[0] / 2;
        const dy = -(east_clip[1] / east_clip[3] - projected[1] / w) * v.viewport[1] / 2;
        const length = std.math.hypot(dx, dy);
        if (length > 0) east = .{ dx / length, dy / length };
    }

    var result: Quad = undefined;
    for (box_corners, &result) |corner, *out| {
        const ux = box[0] + (box[2] - box[0]) * corner[0];
        const uy = box[1] + (box[3] - box[1]) * corner[1];
        var o = [2]f64{ (ux - ax) * scale + r.offset[0] * size, (uy - ay) * scale + r.offset[1] * size };
        o = turn(o, cos, sin);
        o = .{ o[0] * perspective, o[1] * perspective };
        if (pitch_with_map) {
            if (!rotate_with_map) o = turn(o, @cos(-v.bearing), @sin(-v.bearing));
            out.* = project(v, .{ anchor[0] + o[0] * v.pixels_to_tile_units, anchor[1] + o[1] * v.pixels_to_tile_units }) orelse return null;
        } else {
            if (rotate_with_map) o = turn(o, east[0], east[1]);
            out.* = .{ center[0] + o[0], center[1] + o[1] };
        }
    }
    return result;
}

/// The quad's corners in winding order.
fn ring(quad: Quad) [4][2]f64 {
    return .{ quad[0], quad[1], quad[3], quad[2] };
}

fn cross(o: [2]f64, a: [2]f64, b: [2]f64) f64 {
    return (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
}

/// Whether p lies inside or on the (convex) quad.
pub fn hitPoint(quad: Quad, p: [2]f64) bool {
    const points = ring(quad);
    var positive = false;
    var negative = false;
    for (0..4) |i| {
        const side = cross(points[i], points[(i + 1) % 4], p);
        if (side > 0) positive = true;
        if (side < 0) negative = true;
    }
    return !(positive and negative);
}

/// The interval of the points' projections onto axis.
fn extent(points: []const [2]f64, axis: [2]f64) [2]f64 {
    var min = std.math.inf(f64);
    var max = -std.math.inf(f64);
    for (points) |p| {
        const d = p[0] * axis[0] + p[1] * axis[1];
        min = @min(min, d);
        max = @max(max, d);
    }
    return .{ min, max };
}

/// Whether any edge normal of points separates them from others.
fn separates(points: []const [2]f64, others: []const [2]f64) bool {
    for (points, 0..) |a, i| {
        const b = points[(i + 1) % points.len];
        const axis = [2]f64{ a[1] - b[1], b[0] - a[0] };
        if (axis[0] == 0 and axis[1] == 0) continue;
        const own = extent(points, axis);
        const other = extent(others, axis);
        if (own[1] < other[0] or other[1] < own[0]) return true;
    }
    return false;
}

/// Whether the quad and a query ring overlap, touching included. The ring is
/// treated as convex (the separating axis test), as a query box is; a
/// closing point equal to the first is fine.
pub fn hitPolygon(quad: Quad, polygon: []const [2]f64) bool {
    if (polygon.len == 0) return false;
    const points = ring(quad);
    return !separates(&points, polygon) and !separates(polygon, &points);
}

/// The farthest an icon of the entry reaches from its anchor at size 1, in
/// logical pixels: the box diagonal at display size.
pub fn entryRadius(e: Entry) f64 {
    const width = e.box[2] - e.box[0];
    const height = e.box[3] - e.box[1];
    return std.math.hypot(width, height) * e.display_px / @max(width, height);
}

// ---------------------------------------------------------------------------
// Tests. The fixture tests mirror ../../js/src/place.test.ts.
// ---------------------------------------------------------------------------

/// A parsed fixture file and the accessors the tests share with plugin.zig's
/// query tests.
pub const Fixture = struct {
    parsed: std.json.Parsed(std.json.Value),

    pub fn parse(allocator: std.mem.Allocator, bytes: []const u8) !Fixture {
        return .{ .parsed = try std.json.parseFromSlice(std.json.Value, allocator, bytes, .{}) };
    }

    pub fn deinit(self: *Fixture) void {
        self.parsed.deinit();
    }

    fn root(self: Fixture) std.json.ObjectMap {
        return self.parsed.value.object;
    }

    pub fn view(self: Fixture) View {
        const v = self.root().get("view").?.object;
        var result: View = .{
            .matrix = undefined,
            .viewport = vec2(v.get("viewport").?),
            .pixel_ratio = number(v.get("pixel_ratio").?),
            .camera_to_center_distance = number(v.get("camera_to_center_distance").?),
            .pixels_to_tile_units = number(v.get("pixels_to_tile_units").?),
            .bearing = number(v.get("bearing").?),
        };
        for (v.get("matrix").?.array.items, &result.matrix) |item, *out| out.* = number(item);
        return result;
    }

    pub fn entries(self: Fixture) []const std.json.Value {
        return self.root().get("entries").?.array.items;
    }

    /// The entry of an animation name: its enum index (1-based; 0 when the
    /// name is unknown, which draws as none) and geometry.
    pub fn entry(self: Fixture, name: []const u8) struct { index: u32, entry: Entry } {
        for (self.entries(), 1..) |item, i| {
            const object = item.object;
            if (!std.mem.eql(u8, object.get("name").?.string, name)) continue;
            var box: [4]f64 = undefined;
            for (object.get("box").?.array.items, &box) |b, *out| out.* = number(b);
            return .{ .index = @intCast(i), .entry = .{ .box = box, .display_px = number(object.get("display_px").?) } };
        }
        return .{ .index = 0, .entry = .{ .box = .{ 0, 0, 1, 1 }, .display_px = 0 } };
    }

    pub fn cases(self: Fixture) []const std.json.Value {
        return self.root().get("cases").?.array.items;
    }

    pub fn number(value: std.json.Value) f64 {
        return switch (value) {
            .integer => |i| @floatFromInt(i),
            .float => |f| f,
            else => std.math.nan(f64),
        };
    }

    pub fn vec2(value: std.json.Value) [2]f64 {
        const items = value.array.items;
        return .{ number(items[0]), number(items[1]) };
    }
};

pub fn enumIndex(values: []const []const u8, name: []const u8) u32 {
    for (values, 0..) |value, i| {
        if (std.mem.eql(u8, value, name)) return @intCast(i);
    }
    return 0;
}

test "every placement fixture: corners, point and ring hits" {
    const fixtures = @import("place_fixtures");
    var files: usize = 0;
    var null_cases: usize = 0;
    var anchors_seen = [_]bool{false} ** anchor_values.len;
    for (fixtures.names, fixtures.files) |name, bytes| {
        if (!std.mem.endsWith(u8, name, ".json")) continue;
        files += 1;
        var fixture = try Fixture.parse(std.testing.allocator, bytes);
        defer fixture.deinit();
        const view = fixture.view();
        for (fixture.cases(), 0..) |item, case_index| {
            errdefer std.debug.print("{s} case {d}\n", .{ name, case_index });
            const case = item.object;
            const props = case.get("properties").?.object;
            const animation = fixture.entry(props.get("icon-animation").?.string);
            const anchor = enumIndex(&anchor_values, props.get("icon-anchor").?.string);
            anchors_seen[anchor] = true;
            const resolved = Resolved{
                .animation = animation.index,
                .size = Fixture.number(props.get("icon-size").?),
                .rotate = Fixture.number(props.get("icon-rotate").?),
                .opacity = Fixture.number(props.get("icon-opacity").?),
                .offset = Fixture.vec2(props.get("icon-offset").?),
                .anchor = anchor,
                .rotation_alignment = enumIndex(&alignment_values, props.get("icon-rotation-alignment").?.string),
                .pitch_alignment = enumIndex(&alignment_values, props.get("icon-pitch-alignment").?.string),
            };
            const quad = corners(Fixture.vec2(case.get("anchor").?), resolved, animation.entry, view);
            const expected_json = case.get("corners").?;
            if (expected_json == .null) {
                null_cases += 1;
                try std.testing.expect(quad == null);
                try std.testing.expectEqual(@as(usize, 0), case.get("hits").?.array.items.len);
                continue;
            }
            var expected: Quad = undefined;
            for (expected_json.array.items, &expected) |corner, *out| out.* = Fixture.vec2(corner);
            const actual = quad orelse return error.TestExpectedCorners;
            for (actual, expected) |a, e| {
                for (0..2) |k| try std.testing.expect(@abs(a[k] - e[k]) <= 1e-6 * @max(1, @abs(e[k])));
            }
            for (case.get("hits").?.array.items) |p| try std.testing.expect(hitPoint(expected, Fixture.vec2(p)));
            for (case.get("misses").?.array.items) |p| try std.testing.expect(!hitPoint(expected, Fixture.vec2(p)));
            for ([_][]const u8{ "ring_hits", "ring_misses" }) |key| {
                for (case.get(key).?.array.items) |ring_json| {
                    var points: [16][2]f64 = undefined;
                    const items = ring_json.array.items;
                    for (items, 0..) |p, i| points[i] = Fixture.vec2(p);
                    try std.testing.expectEqual(key[5] == 'h', hitPolygon(expected, points[0..items.len]));
                }
            }
        }
    }
    try std.testing.expect(files >= 8);
    try std.testing.expect(null_cases >= 3);
    for (anchors_seen) |seen| try std.testing.expect(seen);
}

test "hit tests count edges, lone points and segments" {
    const square = Quad{ .{ 0, 0 }, .{ 10, 0 }, .{ 0, 10 }, .{ 10, 10 } };
    try std.testing.expect(hitPoint(square, .{ 5, 5 }));
    try std.testing.expect(hitPoint(square, .{ 10, 5 }));
    try std.testing.expect(!hitPoint(square, .{ 10.01, 5 }));
    try std.testing.expect(hitPolygon(square, &.{.{ 5, 5 }}));
    try std.testing.expect(!hitPolygon(square, &.{.{ 15, 5 }}));
    try std.testing.expect(hitPolygon(square, &.{ .{ -5, 5 }, .{ 15, 5 } }));
    try std.testing.expect(hitPolygon(square, &.{ .{ -1, -1 }, .{ 11, -1 }, .{ 11, 11 }, .{ -1, 11 } }));
    try std.testing.expect(hitPolygon(square, &.{ .{ 2, 2 }, .{ 3, 2 }, .{ 3, 3 }, .{ 2, 2 } }));
    try std.testing.expect(!hitPolygon(square, &.{ .{ 11, 0 }, .{ 12, 0 }, .{ 12, 1 } }));
    try std.testing.expect(!hitPolygon(square, &.{}));
    // Inside the diamond's bounding box but past its edge.
    const diamond = Quad{ .{ 5, 0 }, .{ 10, 5 }, .{ 0, 5 }, .{ 5, 10 } };
    try std.testing.expect(!hitPoint(diamond, .{ 1, 1 }));
    try std.testing.expect(!hitPolygon(diamond, &.{ .{ 0, 0 }, .{ 1.5, 0 }, .{ 0, 1.5 } }));
}

test "placement maps clip space to y-down pixels and collapses like the shader" {
    var flat = View{
        .matrix = .{ 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1 },
        .viewport = .{ 200, 100 },
        .pixel_ratio = 1,
        .camera_to_center_distance = 1,
        .pixels_to_tile_units = 1,
        .bearing = 0,
    };
    try std.testing.expectEqual([2]f64{ 100, 50 }, project(flat, .{ 0, 0 }).?);
    try std.testing.expectEqual([2]f64{ 200, 0 }, project(flat, .{ 1, 1 }).?);
    const resolved = Resolved{ .animation = 1, .size = 1, .rotate = 0, .opacity = 1, .offset = .{ 0, 0 }, .anchor = 0, .rotation_alignment = 0, .pitch_alignment = 0 };
    const entry = Entry{ .box = .{ 0, 0, 10, 20 }, .display_px = 40 };
    try std.testing.expect(corners(.{ 0, 0 }, resolved, entry, flat) != null);
    var none = resolved;
    none.animation = 0;
    try std.testing.expect(corners(.{ 0, 0 }, none, entry, flat) == null);
    var nan_size = resolved;
    nan_size.size = std.math.nan(f64);
    try std.testing.expect(corners(.{ 0, 0 }, nan_size, entry, flat) == null);
    var clear = resolved;
    clear.opacity = 0;
    try std.testing.expect(corners(.{ 0, 0 }, clear, entry, flat) == null);
    flat.matrix[15] = -1;
    try std.testing.expect(project(flat, .{ 0, 0 }) == null);
    try std.testing.expect(corners(.{ 0, 0 }, resolved, entry, flat) == null);
    try std.testing.expectEqual(@as(f64, 100), entryRadius(.{ .box = .{ 0, 0, 30, 40 }, .display_px = 80 }));
}
