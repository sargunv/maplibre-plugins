//! The building layer's hit test: a building is hit when the query
//! intersects its projected prism from building-base to building-height,
//! moved by building-translate, as maplibre-gl-js's
//! FillExtrusionStyleLayer.queryIntersectsFeature does (../../README.md,
//! "Hit testing"), except that the translation moves the prism, as it is
//! drawn, rather than the query's ground point. Core Native tests only the
//! 2D footprint. The TypeScript twin is ../../js/src/query.ts; both are
//! tested against ../../fixtures/query/prism.json.
//!
//! Coordinates: rings and query points in tile units, heights in meters,
//! and the tile matrix (column-major, like gl-matrix) from tile units and
//! meters to clip space. Everything is compared after the divide by w, in
//! normalized device coordinates: intersection is invariant under the
//! viewport's affine map, so the aspect ratio does not matter.

const std = @import("std");
const Allocator = std.mem.Allocator;

pub const Point = struct { x: f64, y: f64 };

pub const Paint = struct {
    /// building-height and building-base, in meters; clamped at 0 here.
    height: f64,
    base: f64,
    /// building-translate in logical pixels, [right, down].
    translate: [2]f64 = .{ 0, 0 },
    /// building-translate-anchor is viewport.
    translate_viewport: bool = false,
};

pub const Camera = struct {
    /// Tile units and meters to clip space.
    tile_matrix: [16]f64,
    pixels_to_tile_units: f64,
    /// Radians, as the host's query context carries it.
    bearing: f64,
};

/// A projected point, or null behind the camera (w ≤ 0).
fn project(m: [16]f64, x: f64, y: f64, z: f64) ?Point {
    const w = m[3] * x + m[7] * y + m[11] * z + m[15];
    if (!(w > 0)) return null;
    return .{
        .x = (m[0] * x + m[4] * y + m[8] * z + m[12]) / w,
        .y = (m[1] * x + m[5] * y + m[9] * z + m[13]) / w,
    };
}

/// building-translate in tile units, as MapLibre Native's
/// FeatureIndex::translateQueryGeometry computes it: pixels times tile units
/// per pixel, turned by -bearing (the host's bearing is the map's, negated)
/// for a viewport anchor.
pub fn translation(paint: Paint, camera: Camera) Point {
    var tx = paint.translate[0] * camera.pixels_to_tile_units;
    var ty = paint.translate[1] * camera.pixels_to_tile_units;
    if (paint.translate_viewport and (tx != 0 or ty != 0)) {
        const cosine = @cos(-camera.bearing);
        const sine = @sin(-camera.bearing);
        const x = tx * cosine - ty * sine;
        ty = tx * sine + ty * cosine;
        tx = x;
    }
    return .{ .x = tx, .y = ty };
}

/// Even-odd point in polygon over every ring (exteriors and holes alike).
fn ringsContain(rings: []const []const Point, p: Point) bool {
    var inside = false;
    for (rings) |ring| {
        if (ring.len < 3) continue;
        var j = ring.len - 1;
        for (ring, 0..) |a, i| {
            const b = ring[j];
            if ((a.y > p.y) != (b.y > p.y) and p.x < (b.x - a.x) * (p.y - a.y) / (b.y - a.y) + a.x) inside = !inside;
            j = i;
        }
    }
    return inside;
}

fn cross(a: Point, b: Point, p: Point) f64 {
    return (b.x - a.x) * (p.y - a.y) - (b.y - a.y) * (p.x - a.x);
}

fn segmentsIntersect(a: Point, b: Point, c: Point, d: Point) bool {
    if (@max(a.x, b.x) < @min(c.x, d.x) or @max(c.x, d.x) < @min(a.x, b.x) or
        @max(a.y, b.y) < @min(c.y, d.y) or @max(c.y, d.y) < @min(a.y, b.y)) return false;
    return cross(a, b, c) * cross(a, b, d) <= 0 and cross(c, d, a) * cross(c, d, b) <= 0;
}

/// Whether the projected query (a point, a line or a closed polygon such as
/// a box) intersects a polygon given by its rings, as maplibre-gl-js's
/// polygonIntersectsMultiPolygon does.
fn queryIntersects(query: []const Point, rings: []const []const Point) bool {
    if (query.len == 0) return false;
    for (query) |p| if (ringsContain(rings, p)) return true;
    if (query.len < 2) return false;
    for (rings) |ring| {
        if (ring.len < 2) continue;
        if (query.len >= 3 and ringsContain(&.{query}, ring[0])) return true;
        var j = ring.len - 1;
        for (ring, 0..) |a, i| {
            const b = ring[j];
            j = i;
            for (query[0 .. query.len - 1], query[1..]) |q0, q1| {
                if (segmentsIntersect(a, b, q0, q1)) return true;
            }
        }
    }
    return false;
}

/// Whether the query (ground points, tile units) hits the building prism of
/// a feature's rings, moved by building-translate.
pub fn intersects(
    allocator: Allocator,
    rings: []const []const Point,
    query: []const Point,
    paint: Paint,
    camera: Camera,
) Allocator.Error!bool {
    if (query.len == 0) return false;
    const shift = translation(paint, camera);
    const m = camera.tile_matrix;
    const height = @max(paint.height, 0);
    const base = @max(paint.base, 0);

    const projected_query = try allocator.alloc(Point, query.len);
    defer allocator.free(projected_query);
    for (query, projected_query) |p, *out| out.* = project(m, p.x, p.y, 0) orelse return false;

    var count: usize = 0;
    for (rings) |ring| count += ring.len;
    const points = try allocator.alloc(?Point, 2 * count);
    defer allocator.free(points);
    const tops = try allocator.alloc([]const Point, rings.len);
    defer allocator.free(tops);
    const top_points = try allocator.alloc(Point, count);
    defer allocator.free(top_points);

    // The top polygon, all rings, unless part of it is behind the camera.
    var top_visible = true;
    var offset: usize = 0;
    for (rings, 0..) |ring, r| {
        for (ring, 0..) |p, i| {
            const top = project(m, p.x + shift.x, p.y + shift.y, height);
            points[2 * (offset + i)] = top;
            points[2 * (offset + i) + 1] = project(m, p.x + shift.x, p.y + shift.y, base);
            if (top) |t| top_points[offset + i] = t else top_visible = false;
        }
        tops[r] = top_points[offset .. offset + ring.len];
        offset += ring.len;
    }
    if (top_visible and queryIntersects(projected_query, tops)) return true;

    // Every wall quad [topA, topB, baseB, baseA] in front of the camera.
    offset = 0;
    for (rings) |ring| {
        defer offset += ring.len;
        if (ring.len < 2) continue;
        for (0..ring.len) |i| {
            const k = (i + 1) % ring.len;
            if (ring[i].x == ring[k].x and ring[i].y == ring[k].y) continue;
            const top_a = points[2 * (offset + i)] orelse continue;
            const base_a = points[2 * (offset + i) + 1] orelse continue;
            const top_b = points[2 * (offset + k)] orelse continue;
            const base_b = points[2 * (offset + k) + 1] orelse continue;
            const face = [_]Point{ top_a, top_b, base_b, base_a };
            if (queryIntersects(projected_query, &.{&face})) return true;
        }
    }
    return false;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

/// Tile units straight down onto NDC: x' = x / 4096 - 1, y' = 1 - y / 4096,
/// with z ignored.
const top_down = [16]f64{ 1.0 / 4096.0, 0, 0, 0, 0, -1.0 / 4096.0, 0, 0, 0, 0, 1, 0, -1, 1, 0, 1 };

/// As top_down, but each meter lifts a point 10 tile units up the screen, as
/// a pitched view does.
const oblique = blk: {
    var m = top_down;
    m[9] = 10.0 / 4096.0;
    break :blk m;
};

const square = [_]Point{ .{ .x = 1000, .y = 1000 }, .{ .x = 2000, .y = 1000 }, .{ .x = 2000, .y = 2000 }, .{ .x = 1000, .y = 2000 }, .{ .x = 1000, .y = 1000 } };

fn hits(rings: []const []const Point, point: Point, paint: Paint, matrix: [16]f64) !bool {
    const query = [_]Point{point};
    return intersects(std.testing.allocator, rings, &query, paint, .{ .tile_matrix = matrix, .pixels_to_tile_units = 4, .bearing = 0 });
}

test "a top-down query hits the footprint and misses the ground around it" {
    const rings = [_][]const Point{&square};
    try std.testing.expect(try hits(&rings, .{ .x = 1500, .y = 1500 }, .{ .height = 10, .base = 0 }, top_down));
    try std.testing.expect(!try hits(&rings, .{ .x = 2500, .y = 1500 }, .{ .height = 10, .base = 0 }, top_down));
    try std.testing.expect(!try hits(&rings, .{ .x = 500, .y = 500 }, .{ .height = 10, .base = 0 }, top_down));
}

test "a pitched query hits the walls and roof above the footprint" {
    const rings = [_][]const Point{&square};
    // 100 tile units north of the footprint: the 20 m building's top is
    // drawn 200 units up the screen, so it covers this ground point.
    const north = Point{ .x = 1500, .y = 900 };
    try std.testing.expect(try hits(&rings, north, .{ .height = 20, .base = 0 }, oblique));
    try std.testing.expect(!try hits(&rings, north, .{ .height = 5, .base = 0 }, oblique));
    // Far above the roof misses; a raised base lifts the hit area too.
    try std.testing.expect(!try hits(&rings, .{ .x = 1500, .y = 600 }, .{ .height = 20, .base = 0 }, oblique));
    try std.testing.expect(!try hits(&rings, .{ .x = 1500, .y = 1950 }, .{ .height = 20, .base = 10 }, oblique));
    try std.testing.expect(try hits(&rings, .{ .x = 1500, .y = 1850 }, .{ .height = 20, .base = 10 }, oblique));
    // Negative heights clamp at 0, like the shader.
    try std.testing.expect(!try hits(&rings, north, .{ .height = -20, .base = -5 }, oblique));
}

test "holes are not hit from above" {
    const hole = [_]Point{ .{ .x = 1300, .y = 1300 }, .{ .x = 1300, .y = 1700 }, .{ .x = 1700, .y = 1700 }, .{ .x = 1700, .y = 1300 } };
    const rings = [_][]const Point{ &square, &hole };
    try std.testing.expect(!try hits(&rings, .{ .x = 1500, .y = 1500 }, .{ .height = 10, .base = 0 }, top_down));
    try std.testing.expect(try hits(&rings, .{ .x = 1100, .y = 1500 }, .{ .height = 10, .base = 0 }, top_down));
}

test "translate moves the hit area by pixels times tile units per pixel" {
    const rings = [_][]const Point{&square};
    // 200 px right at 4 tile units per pixel: the building moves 800 units.
    const paint = Paint{ .height = 10, .base = 0, .translate = .{ 200, 0 } };
    try std.testing.expect(try hits(&rings, .{ .x = 2500, .y = 1500 }, paint, top_down));
    try std.testing.expect(!try hits(&rings, .{ .x = 1100, .y = 1500 }, paint, top_down));
    // A viewport anchor turns it with the map: at a bearing of 90° (the
    // map turned so east points down the screen) 200 px right is 800 units
    // north.
    const query = [_]Point{.{ .x = 1500, .y = 700 }};
    try std.testing.expect(try intersects(std.testing.allocator, &rings, &query, .{ .height = 10, .base = 0, .translate = .{ 200, 0 }, .translate_viewport = true }, .{ .tile_matrix = top_down, .pixels_to_tile_units = 4, .bearing = std.math.pi / 2.0 }));
}

test "a box query hits a building it overlaps without containing a corner" {
    const rings = [_][]const Point{&square};
    const box = [_]Point{ .{ .x = 1400, .y = 500 }, .{ .x = 1600, .y = 500 }, .{ .x = 1600, .y = 2500 }, .{ .x = 1400, .y = 2500 }, .{ .x = 1400, .y = 500 } };
    try std.testing.expect(try intersects(std.testing.allocator, &rings, &box, .{ .height = 0, .base = 0 }, .{ .tile_matrix = top_down, .pixels_to_tile_units = 4, .bearing = 0 }));
}

test "points behind the camera never hit" {
    const rings = [_][]const Point{&square};
    var behind = top_down;
    // w = 1 - z / 5: the top of a 10 m building is behind the camera, and
    // so is every wall, whose top corners are. A flat one is in front.
    behind[11] = -0.2;
    try std.testing.expect(!try hits(&rings, .{ .x = 1500, .y = 1500 }, .{ .height = 10, .base = 0 }, behind));
    try std.testing.expect(try hits(&rings, .{ .x = 1500, .y = 1500 }, .{ .height = 0, .base = 0 }, behind));
}

test "fixtures/query/prism.json, shared with the TypeScript twin" {
    const build_options = @import("build_options");
    const Case = struct {
        name: []const u8,
        matrix: [16]f64,
        rings: []const []const [2]f64,
        base: f64,
        height: f64,
        translate: [2]f64,
        translateAnchor: []const u8,
        bearing: f64,
        pixelsToTileUnits: f64,
        grid: struct { x0: f64, y0: f64, dx: f64, dy: f64 },
        hits: []const []const u8,
    };
    const parsed = try std.json.parseFromSlice(struct { cases: []const Case }, std.testing.allocator, build_options.query_fixture_json, .{ .ignore_unknown_fields = true });
    defer parsed.deinit();
    var arena = std.heap.ArenaAllocator.init(std.testing.allocator);
    defer arena.deinit();
    const a = arena.allocator();
    for (parsed.value.cases) |c| {
        const rings = try a.alloc([]const Point, c.rings.len);
        for (c.rings, rings) |ring, *out| {
            const points = try a.alloc(Point, ring.len);
            for (ring, points) |p, *q| q.* = .{ .x = p[0], .y = p[1] };
            out.* = points;
        }
        const paint = Paint{ .height = c.height, .base = c.base, .translate = c.translate, .translate_viewport = std.mem.eql(u8, c.translateAnchor, "viewport") };
        // The host's bearing is the map's, negated.
        const camera = Camera{ .tile_matrix = c.matrix, .pixels_to_tile_units = c.pixelsToTileUnits, .bearing = -c.bearing };
        for (c.hits, 0..) |row, r| {
            for (row, 0..) |expected, k| {
                const point = [_]Point{.{ .x = c.grid.x0 + @as(f64, @floatFromInt(k)) * c.grid.dx, .y = c.grid.y0 + @as(f64, @floatFromInt(r)) * c.grid.dy }};
                const hit = try intersects(std.testing.allocator, rings, &point, paint, camera);
                if (hit != (expected == '#')) {
                    std.debug.print("{s}: row {d} column {d} ({d}, {d}) expected {c}\n", .{ c.name, r, k, point[0].x, point[0].y, expected });
                    return error.TestUnexpectedResult;
                }
            }
        }
    }
}
