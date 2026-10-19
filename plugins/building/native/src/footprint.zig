//! Footprint preparation: ring cleanup, MVT ring classification, tile clip
//! edges and the minimum-area bounding rectangle that frames a roof. Part of
//! the building layout; ../../js/src/footprint.ts is its twin and both are
//! tested against ../../fixtures/layout.
//!
//! Coordinates are tile units (x right, y down). Every comparison that picks
//! between near-equal candidates uses a relative tolerance and then the first
//! candidate, so the two twins make the same choices despite last-bit
//! differences in their floating point.
//!
//! Functions that return slices allocate them, and everything they allocate
//! along the way, from the allocator they are given: the layout passes an
//! arena that lives for one feature.

const std = @import("std");
const Allocator = std.mem.Allocator;

pub const Point = struct { x: f64, y: f64 };

/// Vertices closer than this to the line through their neighbors are
/// dropped, in tile units: it removes collinear points and the jitter that
/// int16 quantization leaves on straight walls.
pub const simplify_tolerance: f64 = 0.5;
/// Rings with a smaller area, in square tile units, are dropped.
pub const min_ring_area: f64 = 1;
/// Relative tolerance of every near-tie decision.
pub const tie: f64 = 1e-9;

/// Twice the signed area: positive for MVT exterior rings.
pub fn signedArea2(ring: []const Point) f64 {
    var sum: f64 = 0;
    for (ring, 0..) |p, i| {
        const q = ring[(i + 1) % ring.len];
        sum += p.x * q.y - q.x * p.y;
    }
    return sum;
}

pub fn cross(o: Point, a: Point, b: Point) f64 {
    return (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x);
}

fn same(a: Point, b: Point) bool {
    return a.x == b.x and a.y == b.y;
}

/// The bounding box of every point of the features one tile lays out. A
/// source clips its features to the tile plus a buffer along axis-aligned
/// lines, and nothing reaches beyond them, so the box's sides outside the
/// tile square are the only places a cut can lie.
pub const TileBounds = struct {
    min_x: f64 = std.math.inf(f64),
    min_y: f64 = std.math.inf(f64),
    max_x: f64 = -std.math.inf(f64),
    max_y: f64 = -std.math.inf(f64),

    /// Bounds with no cut lines: no edge lies on an infinite line.
    pub const no_cuts: TileBounds = .{};

    /// Grows the bounds to hold a point.
    pub fn add(self: *TileBounds, p: Point) void {
        self.min_x = @min(self.min_x, p.x);
        self.min_y = @min(self.min_y, p.y);
        self.max_x = @max(self.max_x, p.x);
        self.max_y = @max(self.max_y, p.y);
    }
};

/// Whether the ring edge a→b is an artificial cut of a tile-clipped
/// polygon: axis-aligned, outside the tile square (core fill-extrusion's
/// boundary-edge test) and on the side of the tile's bounds that faces away
/// from the tile, where the source's clip line lies. That last condition
/// keeps axis-aligned walls in the buffer from counting as cuts, unless one
/// happens to be the outermost point of the whole tile.
pub fn isClipEdge(a: Point, b: Point, extent: f64, bounds: TileBounds) bool {
    return (a.x == b.x and ((a.x < 0 and a.x == bounds.min_x) or (a.x > extent and a.x == bounds.max_x))) or
        (a.y == b.y and ((a.y < 0 and a.y == bounds.min_y) or (a.y > extent and a.y == bounds.max_y)));
}

/// Whether any edge of a ring is a cut.
pub fn hasClipEdge(ring: []const Point, extent: f64, bounds: TileBounds) bool {
    for (ring, 0..) |a, i| {
        if (isClipEdge(a, ring[(i + 1) % ring.len], extent, bounds)) return true;
    }
    return false;
}

fn onCutLine(p: Point, extent: f64, bounds: TileBounds) bool {
    return (p.x < 0 and p.x == bounds.min_x) or (p.x > extent and p.x == bounds.max_x) or
        (p.y < 0 and p.y == bounds.min_y) or (p.y > extent and p.y == bounds.max_y);
}

/// Whether a ring as the source gave it repeats a point on a cut line:
/// where the source clipped away a tip narrower than its grid, both
/// crossings round to that point and the cut edge has no length. One
/// closing point is not a repeat.
pub fn hasCollapsedCut(ring: []const Point, extent: f64, bounds: TileBounds) bool {
    var n = ring.len;
    if (n > 1 and same(ring[0], ring[n - 1])) n -= 1;
    for (ring[0..n], 0..) |p, i| {
        if (same(p, ring[(i + 1) % n]) and onCutLine(p, extent, bounds)) return true;
    }
    return false;
}

/// Drops repeated points, the closing point, collinear points and spikes,
/// until no vertex is within `simplify_tolerance` of the line through its
/// neighbors. The endpoints of clip edges are kept unless both of their
/// edges are clip edges, so cuts never merge into real walls. Returns an
/// empty ring when fewer than three points remain.
pub fn simplifyRing(allocator: Allocator, input: []const Point, extent: f64, bounds: TileBounds) Allocator.Error![]Point {
    var ring: std.ArrayList(Point) = .empty;
    errdefer ring.deinit(allocator);
    for (input) |p| {
        if (ring.items.len > 0 and same(ring.items[ring.items.len - 1], p)) continue;
        try ring.append(allocator, p);
    }
    while (ring.items.len > 1 and same(ring.items[ring.items.len - 1], ring.items[0])) _ = ring.pop();
    var changed = true;
    while (changed and ring.items.len >= 3) {
        changed = false;
        var i: usize = 0;
        while (i < ring.items.len and ring.items.len >= 3) {
            const n = ring.items.len;
            const a = ring.items[(i + n - 1) % n];
            const b = ring.items[i];
            const c = ring.items[(i + 1) % n];
            if (removable(a, b, c, extent, bounds)) {
                _ = ring.orderedRemove(i);
                changed = true;
            } else i += 1;
        }
    }
    if (ring.items.len < 3) ring.clearRetainingCapacity();
    return ring.toOwnedSlice(allocator);
}

fn removable(a: Point, b: Point, c: Point, extent: f64, bounds: TileBounds) bool {
    if (same(a, b) or same(b, c)) return true;
    const clip_before = isClipEdge(a, b, extent, bounds);
    const clip_after = isClipEdge(b, c, extent, bounds);
    if (clip_before != clip_after) return false;
    if (clip_before) return isClipEdge(a, c, extent, bounds) and cross(a, b, c) == 0;
    const dx = c.x - a.x;
    const dy = c.y - a.y;
    const length = @sqrt(dx * dx + dy * dy);
    // Neighbors (nearly) on top of each other: b is the tip of a spike.
    if (length <= simplify_tolerance) return true;
    return @abs(cross(a, c, b)) <= simplify_tolerance * length;
}

/// One polygon of a feature: an exterior ring and its holes.
pub const Polygon = struct {
    /// Positive area (MVT exterior winding).
    outer: []Point,
    /// Negative area each.
    holes: std.ArrayList([]Point) = .empty,
    /// Whether the source cut this copy of the footprint at a clip line:
    /// some ring has a clip edge, or repeats a point on a cut line. An uncut
    /// copy is the whole footprint, the same in every tile up to a
    /// translation.
    cut: bool,
};

/// Groups a feature's rings into polygons as core's classifyRings does: the
/// first usable ring's winding marks exteriors, and every ring of the other
/// winding is a hole of the exterior before it. Rings are simplified first
/// and dropped when they degenerate. Exteriors come out with positive area
/// and holes with negative area, whatever the input winding.
pub fn classifyRings(allocator: Allocator, rings: []const []const Point, extent: f64, bounds: TileBounds) Allocator.Error![]Polygon {
    var polygons: std.ArrayList(Polygon) = .empty;
    var exterior_sign: f64 = 0;
    for (rings) |input| {
        const ring = try simplifyRing(allocator, input, extent, bounds);
        if (ring.len < 3) continue;
        const area2 = signedArea2(ring);
        if (@abs(area2) < 2 * min_ring_area) continue;
        const sign: f64 = if (area2 > 0) 1 else -1;
        if (exterior_sign == 0) exterior_sign = sign;
        const cut = hasClipEdge(ring, extent, bounds) or hasCollapsedCut(input, extent, bounds);
        if (sign == exterior_sign) {
            if (sign < 0) std.mem.reverse(Point, ring);
            try polygons.append(allocator, .{ .outer = ring, .cut = cut });
        } else {
            if (polygons.items.len == 0) continue;
            const polygon = &polygons.items[polygons.items.len - 1];
            if (sign > 0) std.mem.reverse(Point, ring);
            try polygon.holes.append(allocator, ring);
            polygon.cut = polygon.cut or cut;
        }
    }
    return polygons.toOwnedSlice(allocator);
}

fn lessThanXY(_: void, a: Point, b: Point) bool {
    return a.x < b.x or (a.x == b.x and a.y < b.y);
}

/// Andrew's monotone chain; counter-clockwise in a y-up frame.
pub fn convexHull(allocator: Allocator, points: []const Point) Allocator.Error![]Point {
    const sorted = try allocator.dupe(Point, points);
    defer allocator.free(sorted);
    std.mem.sort(Point, sorted, {}, lessThanXY);
    var hull: std.ArrayList(Point) = .empty;
    errdefer hull.deinit(allocator);
    for (sorted) |p| {
        while (hull.items.len >= 2 and
            cross(hull.items[hull.items.len - 2], hull.items[hull.items.len - 1], p) <= 0)
            _ = hull.pop();
        try hull.append(allocator, p);
    }
    const lower = hull.items.len + 1;
    var i = sorted.len -% 2;
    while (i < sorted.len) : (i -%= 1) {
        const p = sorted[i];
        while (hull.items.len >= lower and
            cross(hull.items[hull.items.len - 2], hull.items[hull.items.len - 1], p) <= 0)
            _ = hull.pop();
        try hull.append(allocator, p);
    }
    _ = hull.pop();
    return hull.toOwnedSlice(allocator);
}

/// The minimum-area bounding rectangle of a footprint.
pub const BoundingRectangle = struct {
    center: Point,
    /// Unit vector along the longer side (the first found on a tie).
    long: Point,
    /// Unit vector along the shorter side, `long` turned a quarter.
    short: Point,
    /// Half the longer side's length.
    half_long: f64,
    /// Half the shorter side's length.
    half_short: f64,
};

/// Rotating calipers over the convex hull: the rectangle has a side along
/// one hull edge, so trying every edge finds the smallest. Null when the
/// points are collinear.
pub fn minimumAreaRectangle(allocator: Allocator, points: []const Point) Allocator.Error!?BoundingRectangle {
    const hull = try convexHull(allocator, points);
    defer allocator.free(hull);
    if (hull.len < 3) return null;
    const origin = hull[0];
    const Best = struct { ux: f64, uy: f64, min: [2]f64, max: [2]f64 };
    var best: ?Best = null;
    var best_area = std.math.inf(f64);
    for (hull, 0..) |a, i| {
        const b = hull[(i + 1) % hull.len];
        const ex = b.x - a.x;
        const ey = b.y - a.y;
        const length = @sqrt(ex * ex + ey * ey);
        if (length == 0) continue;
        const ux = ex / length;
        const uy = ey / length;
        var min_u = std.math.inf(f64);
        var max_u = -std.math.inf(f64);
        var min_v = std.math.inf(f64);
        var max_v = -std.math.inf(f64);
        for (hull) |p| {
            const dx = p.x - origin.x;
            const dy = p.y - origin.y;
            const u = dx * ux + dy * uy;
            const v = dy * ux - dx * uy;
            min_u = @min(min_u, u);
            max_u = @max(max_u, u);
            min_v = @min(min_v, v);
            max_v = @max(max_v, v);
        }
        const area = (max_u - min_u) * (max_v - min_v);
        if (area < best_area * (1 - tie)) {
            best_area = area;
            best = .{ .ux = ux, .uy = uy, .min = .{ min_u, min_v }, .max = .{ max_u, max_v } };
        }
    }
    const found = best orelse return null;
    if (!(best_area > 0)) return null;
    const ux = found.ux;
    const uy = found.uy;
    // v = (-uy, ux): the edge direction turned a quarter.
    const vx = -uy;
    const vy = ux;
    const mid_u = (found.min[0] + found.max[0]) / 2;
    const mid_v = (found.min[1] + found.max[1]) / 2;
    const center: Point = .{
        .x = origin.x + ux * mid_u + vx * mid_v,
        .y = origin.y + uy * mid_u + vy * mid_v,
    };
    const half_u = (found.max[0] - found.min[0]) / 2;
    const half_v = (found.max[1] - found.min[1]) / 2;
    if (half_v > half_u * (1 + tie)) {
        return .{
            .center = center,
            .long = .{ .x = vx, .y = vy },
            .short = .{ .x = -ux, .y = -uy },
            .half_long = half_v,
            .half_short = half_u,
        };
    }
    return .{
        .center = center,
        .long = .{ .x = ux, .y = uy },
        .short = .{ .x = vx, .y = vy },
        .half_long = half_u,
        .half_short = half_v,
    };
}
