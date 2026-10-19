//! Ear-clipping triangulation of a footprint with holes. Part of the
//! building layout; ../../js/src/triangulate.ts is its twin. It is
//! deliberately simpler than earcut (no z-order hash, no local-intersection
//! cures) so the twins stay line-for-line portable and produce identical
//! triangles: holes are bridged into the outer ring (Eberly's "Triangulation
//! by Ear Clipping", §3), then ears are clipped in ring order. Where rings
//! touch at a point (and at bridge ends) the polygon visits a point more
//! than once: zero-width spikes are dropped as they appear, and an ear is
//! rejected when another visit of one of its corners has an edge running
//! into it. Input that is not a simple polygon still terminates: when a full
//! pass finds no ear, a degenerate vertex is dropped or, failing that, the
//! first convex vertex is clipped anyway.

const std = @import("std");
const Allocator = std.mem.Allocator;

const footprint = @import("footprint.zig");
const Point = footprint.Point;
const cross = footprint.cross;

pub const Triangulation = struct {
    /// The outer ring's points followed by each hole's.
    points: []Point,
    /// Index triples into `points`, each with positive signed area.
    triangles: []u32,

    pub fn deinit(self: Triangulation, allocator: Allocator) void {
        allocator.free(self.points);
        allocator.free(self.triangles);
    }
};

const HoleStart = struct { start: u32, length: u32, right: u32 };

const HoleOrder = struct {
    points: []const Point,
    holes: []const HoleStart,

    fn rightmost(self: HoleOrder, h: u32) Point {
        return self.points[self.holes[h].start + self.holes[h].right];
    }

    /// Rightmost first, then topmost, then input order.
    fn lessThan(self: HoleOrder, a: u32, b: u32) bool {
        const pa = self.rightmost(a);
        const pb = self.rightmost(b);
        if (pa.x != pb.x) return pa.x > pb.x;
        if (pa.y != pb.y) return pa.y < pb.y;
        return a < b;
    }
};

/// Triangulates an outer ring of positive area with holes of negative area
/// (as classifyRings returns them).
pub fn triangulate(allocator: Allocator, outer: []const Point, holes: []const []const Point) Allocator.Error!Triangulation {
    var points: std.ArrayList(Point) = .empty;
    errdefer points.deinit(allocator);
    try points.appendSlice(allocator, outer);
    // The polygon as a sequence of point indices; bridges repeat points.
    var polygon: std.ArrayList(u32) = .empty;
    defer polygon.deinit(allocator);
    for (0..outer.len) |i| try polygon.append(allocator, @intCast(i));
    const hole_starts = try allocator.alloc(HoleStart, holes.len);
    defer allocator.free(hole_starts);
    for (holes, hole_starts) |hole, *hole_start| {
        const start: u32 = @intCast(points.items.len);
        var right: u32 = 0;
        for (hole, 0..) |p, i| {
            const r = hole[right];
            if (p.x > r.x or (p.x == r.x and p.y < r.y)) right = @intCast(i);
            try points.append(allocator, p);
        }
        hole_start.* = .{ .start = start, .length = @intCast(hole.len), .right = right };
    }
    // Rightmost holes first, so each bridge sees the holes already merged.
    const order = try allocator.alloc(u32, holes.len);
    defer allocator.free(order);
    for (order, 0..) |*o, i| o.* = @intCast(i);
    std.mem.sort(u32, order, HoleOrder{ .points = points.items, .holes = hole_starts }, HoleOrder.lessThan);
    var loop: std.ArrayList(u32) = .empty;
    defer loop.deinit(allocator);
    for (order) |h| {
        const hole = hole_starts[h];
        const m = hole.start + hole.right;
        const at = findBridge(points.items, polygon.items, m) orelse continue;
        loop.clearRetainingCapacity();
        for (0..hole.length + 1) |k| try loop.append(allocator, hole.start + @as(u32, @intCast((hole.right + k) % hole.length)));
        try loop.append(allocator, polygon.items[at]);
        try polygon.insertSlice(allocator, at + 1, loop.items);
    }
    const triangles = try clipEars(allocator, points.items, polygon.items);
    errdefer allocator.free(triangles);
    return .{ .points = try points.toOwnedSlice(allocator), .triangles = triangles };
}

/// Finds where to bridge the hole vertex m into the polygon: the position
/// of a polygon vertex that m sees, found by casting a ray toward +x.
/// Returns null when the ray hits nothing (a hole outside its exterior).
fn findBridge(points: []const Point, polygon: []const u32, m: u32) ?usize {
    const mp = points[m];
    var hit_x = std.math.inf(f64);
    var found: ?usize = null;
    const n = polygon.len;
    for (0..n) |i| {
        const a = points[polygon[i]];
        const b = points[polygon[(i + 1) % n]];
        if (a.y == b.y) continue;
        if (mp.y < @min(a.y, b.y) or mp.y > @max(a.y, b.y)) continue;
        const x = a.x + ((mp.y - a.y) * (b.x - a.x)) / (b.y - a.y);
        if (x < mp.x or x >= hit_x) continue;
        hit_x = x;
        if (x == a.x and mp.y == a.y) {
            found = i;
        } else if (x == b.x and mp.y == b.y) {
            found = (i + 1) % n;
        } else {
            found = if (a.x >= b.x) i else (i + 1) % n;
        }
    }
    var candidate = found orelse return null;
    const p = points[polygon[candidate]];
    const hit: Point = .{ .x = hit_x, .y = mp.y };
    if (!(p.x == hit.x and p.y == hit.y)) {
        // A reflex vertex inside the triangle (m, hit, p) may block the view
        // of p; the one closest in angle to the ray is visible instead.
        var best_tan = std.math.inf(f64);
        var best_distance = std.math.inf(f64);
        for (0..n) |i| {
            const r = points[polygon[i]];
            if (i == candidate or (r.x == p.x and r.y == p.y)) continue;
            if (convexAt(points, polygon, i)) continue;
            if (!pointInTriangle(mp, hit, p, r)) continue;
            const dx = r.x - mp.x;
            if (dx <= 0) continue;
            const tan = @abs(r.y - mp.y) / dx;
            const distance = dx * dx + (r.y - mp.y) * (r.y - mp.y);
            if (tan < best_tan or (tan == best_tan and distance < best_distance)) {
                best_tan = tan;
                best_distance = distance;
                candidate = i;
            }
        }
    }
    // A bridged point appears more than once; pick the copy whose interior
    // wedge contains the bridge.
    const chosen = points[polygon[candidate]];
    for (0..n) |k| {
        const i = (candidate + k) % n;
        const r = points[polygon[i]];
        if (r.x != chosen.x or r.y != chosen.y) continue;
        const before = points[polygon[(i + n - 1) % n]];
        const after = points[polygon[(i + 1) % n]];
        if (wedgeContains(before, r, after, mp)) return i;
    }
    return candidate;
}

fn convexAt(points: []const Point, polygon: []const u32, i: usize) bool {
    const n = polygon.len;
    return cross(
        points[polygon[(i + n - 1) % n]],
        points[polygon[i]],
        points[polygon[(i + 1) % n]],
    ) > 0;
}

/// Whether m lies in the interior wedge at p of a positive-area ring.
fn wedgeContains(a: Point, p: Point, c: Point, m: Point) bool {
    const left = cross(a, p, m) >= 0;
    const right = cross(p, c, m) >= 0;
    return if (cross(a, p, c) > 0) left and right else left or right;
}

/// Whether the direction from v to p lies strictly inside the angle from
/// v→u counter-clockwise (positive cross) to v→w, an angle under 180°.
fn inAngle(v: Point, u: Point, w: Point, p: Point) bool {
    return cross(v, u, p) > 0 and cross(v, p, w) > 0;
}

/// Inclusive point-in-triangle test for either winding.
fn pointInTriangle(a: Point, b: Point, c: Point, p: Point) bool {
    const d1 = cross(a, b, p);
    const d2 = cross(b, c, p);
    const d3 = cross(c, a, p);
    const negative = d1 < 0 or d2 < 0 or d3 < 0;
    const positive = d1 > 0 or d2 > 0 or d3 > 0;
    return !(negative and positive);
}

/// The ring being clipped: a doubly linked list over the polygon's
/// positions.
const EarRing = struct {
    points: []const Point,
    polygon: []const u32,
    prev: []usize,
    next: []usize,
    triangles: *std.ArrayList(u32),
    allocator: Allocator,

    fn at(self: EarRing, i: usize) Point {
        return self.points[self.polygon[i]];
    }

    fn area(self: EarRing, i: usize) f64 {
        return cross(self.at(self.prev[i]), self.at(i), self.at(self.next[i]));
    }

    fn remove(self: EarRing, i: usize) void {
        self.next[self.prev[i]] = self.next[i];
        self.prev[self.next[i]] = self.prev[i];
    }

    fn isEar(self: EarRing, i: usize) bool {
        const a = self.at(self.prev[i]);
        const b = self.at(i);
        const c = self.at(self.next[i]);
        if (cross(a, b, c) <= 0) return false;
        var j = self.next[self.next[i]];
        while (j != self.prev[i]) : (j = self.next[j]) {
            const p = self.at(j);
            // Another copy of a corner (a bridge end, or rings touching at
            // a point) blocks the ear when the boundary leaves it into the
            // ear.
            const corner: ?[2]Point = if (p.x == a.x and p.y == a.y)
                .{ b, c }
            else if (p.x == b.x and p.y == b.y)
                .{ c, a }
            else if (p.x == c.x and p.y == c.y)
                .{ a, b }
            else
                null;
            if (corner) |uw| {
                if (inAngle(p, uw[0], uw[1], self.at(self.prev[j])) or
                    inAngle(p, uw[0], uw[1], self.at(self.next[j])))
                    return false;
                continue;
            }
            if (self.area(j) <= 0 and pointInTriangle(a, b, c, p)) return false;
        }
        return true;
    }

    fn isSpike(self: EarRing, i: usize) bool {
        const a = self.at(self.prev[i]);
        const b = self.at(i);
        const c = self.at(self.next[i]);
        return cross(a, b, c) == 0 and
            (a.x - b.x) * (c.x - b.x) + (a.y - b.y) * (c.y - b.y) >= 0;
    }

    fn emit(self: EarRing, i: usize) Allocator.Error!void {
        try self.triangles.appendSlice(self.allocator, &.{ self.polygon[self.prev[i]], self.polygon[i], self.polygon[self.next[i]] });
    }
};

fn clipEars(allocator: Allocator, points: []const Point, polygon: []const u32) Allocator.Error![]u32 {
    var triangles: std.ArrayList(u32) = .empty;
    errdefer triangles.deinit(allocator);
    const n = polygon.len;
    if (n < 3) return triangles.toOwnedSlice(allocator);
    const prev = try allocator.alloc(usize, n);
    defer allocator.free(prev);
    const next = try allocator.alloc(usize, n);
    defer allocator.free(next);
    for (0..n) |i| {
        prev[i] = (i + n - 1) % n;
        next[i] = (i + 1) % n;
    }
    const ring: EarRing = .{
        .points = points,
        .polygon = polygon,
        .prev = prev,
        .next = next,
        .triangles = &triangles,
        .allocator = allocator,
    };
    var remaining = n;
    var i: usize = 0;
    var stall: usize = 0;
    while (remaining > 3) {
        if (ring.isSpike(i)) {
            // A repeated point, or a zero-width spike where rings touch: it
            // encloses nothing, and leaving it would let an ear span the
            // pinch.
            ring.remove(i);
            remaining -= 1;
            i = next[i];
            stall = 0;
            continue;
        }
        if (ring.isEar(i)) {
            try ring.emit(i);
            ring.remove(i);
            remaining -= 1;
            i = next[i];
            stall = 0;
            continue;
        }
        i = next[i];
        stall += 1;
        if (stall < remaining) continue;
        // A full pass without an ear: drop a degenerate vertex, else force
        // the first convex one.
        stall = 0;
        var fixed: ?usize = null;
        var j = i;
        for (0..remaining) |_| {
            if (ring.area(j) == 0) {
                fixed = j;
                break;
            }
            j = next[j];
        }
        if (fixed) |f| {
            ring.remove(f);
            remaining -= 1;
            i = next[f];
            continue;
        }
        j = i;
        for (0..remaining) |_| {
            if (ring.area(j) > 0) {
                fixed = j;
                break;
            }
            j = next[j];
        }
        const f = fixed orelse return triangles.toOwnedSlice(allocator);
        try ring.emit(f);
        ring.remove(f);
        remaining -= 1;
        i = next[f];
    }
    if (ring.area(i) > 0) try ring.emit(i);
    return triangles.toOwnedSlice(allocator);
}
