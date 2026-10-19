//! Inscribed circles for radial roofs; ../../js/src/radial.ts is its twin.
const std = @import("std");
const Allocator = std.mem.Allocator;
const footprint = @import("footprint.zig");
const Point = footprint.Point;
const Polygon = footprint.Polygon;

fn distance(p: Point, rings: []const []const Point) f64 {
    var inside = false;
    var nearest = std.math.inf(f64);
    for (rings) |ring| {
        for (ring, 0..) |a, i| {
            const b = ring[(i + 1) % ring.len];
            if ((a.y > p.y) != (b.y > p.y) and p.x < a.x + (b.x - a.x) * (p.y - a.y) / (b.y - a.y)) inside = !inside;
            const dx = b.x - a.x;
            const dy = b.y - a.y;
            const t = std.math.clamp(((p.x - a.x) * dx + (p.y - a.y) * dy) / (dx * dx + dy * dy), 0, 1);
            const x = p.x - (a.x + t * dx);
            const y = p.y - (a.y + t * dy);
            nearest = @min(nearest, x * x + y * y);
        }
    }
    return @as(f64, if (inside) 1 else -1) * @sqrt(nearest);
}

/// Keep existing towers, including rounded tile-grid copies of regular polygons.
pub fn roundFootprint(outer: []const Point, center: Point) bool {
    if (outer.len < 12) return false;
    var min = std.math.inf(f64);
    var max: f64 = 0;
    for (outer) |p| {
        const dx = p.x - center.x;
        const dy = p.y - center.y;
        const r = dx * dx + dy * dy;
        min = @min(min, r);
        max = @max(max, r);
    }
    return min >= 0.95 * 0.95 * max;
}

const Cell = struct { x: f64, y: f64, half: f64, d: f64, bound: f64 };
fn cell(rings: []const []const Point, x: f64, y: f64, half: f64) Cell {
    const d = distance(.{ .x = x, .y = y }, rings);
    return .{ .x = x, .y = y, .half = half, .d = d, .bound = d + half * @sqrt(@as(f64, 2)) };
}
fn lessCell(_: void, a: Cell, b: Cell) bool {
    if (a.bound != b.bound) return a.bound < b.bound;
    return if (a.x != b.x) a.x < b.x else a.y < b.y;
}
pub const Circle = struct { center: Point, run: f64, base: []Point };

/// Polylabel's distance bound, searched depth-first in the footprint's local frame.
pub fn inscribedCircle(allocator: Allocator, polygon: Polygon, seed: Point, limit: f64) Allocator.Error!?Circle {
    const rings = try allocator.alloc([]const Point, polygon.holes.items.len + 1);
    rings[0] = polygon.outer;
    for (rings[1..], polygon.holes.items) |*ring, hole| ring.* = hole;
    var best = seed;
    var radius = distance(best, rings);
    var min_x = std.math.inf(f64);
    var min_y = std.math.inf(f64);
    var max_x = -std.math.inf(f64);
    var max_y = -std.math.inf(f64);
    for (polygon.outer) |p| {
        min_x = @min(min_x, p.x);
        min_y = @min(min_y, p.y);
        max_x = @max(max_x, p.x);
        max_y = @max(max_y, p.y);
    }
    const tolerance = @max(0.5, limit / 128);
    var pending: std.ArrayList(Cell) = .empty;
    try pending.append(allocator, cell(rings, (min_x + max_x) / 2, (min_y + max_y) / 2, @max(max_x - min_x, max_y - min_y) / 2));
    while (pending.items.len > 0 and radius + tolerance < limit) {
        const c = pending.pop().?;
        if (c.d > radius) {
            best = .{ .x = c.x, .y = c.y };
            radius = c.d;
        }
        if (c.bound <= radius + tolerance) continue;
        const h = c.half / 2;
        var children = [_]Cell{ cell(rings, c.x - h, c.y - h, h), cell(rings, c.x + h, c.y - h, h), cell(rings, c.x - h, c.y + h, h), cell(rings, c.x + h, c.y + h, h) };
        std.mem.sort(Cell, &children, {}, lessCell);
        try pending.appendSlice(allocator, &children);
    }
    // Keep a half-unit gap so the terrace hole never touches another boundary.
    const run = radius - 0.5;
    if (run < 1) return null;
    const base = try allocator.alloc(Point, 32);
    for (base, 0..) |*p, i| {
        const angle = 2 * std.math.pi * @as(f64, @floatFromInt(i)) / 32;
        p.* = .{ .x = best.x + run * @cos(angle), .y = best.y + run * @sin(angle) };
    }
    return .{ .center = best, .run = run, .base = base };
}
