//! Roof shapes as height functions over a footprint. Part of the building
//! layout; ../../js/src/roof.ts is its twin and both are tested against
//! ../../fixtures/layout.
//!
//! A roof is described by n, its relative elevation: z = wallTop + n ×
//! roofHeight, with n = 0 at the eaves and 1 at the top. Roof families:
//!
//! - Frame shapes (gabled, half-hipped, skillion, gambrel, round,
//!   double_saltbox, saltbox, quadruple_saltbox, round_gabled) live
//!   in the roof frame: u along the ridge, v across it, centered on the
//!   footprint's minimum-area bounding rectangle, half-extents a (along u)
//!   and b (along v). Every one is concave, so it is written as the minimum
//!   of planes n = A·u + B·v + C; the region where a plane is the minimum is
//!   a convex facet, and the break lines (ridges, hips and gambrel
//!   breaks) are where facets meet. Curved ones (round, round_gabled) are
//!   strips of planes with smooth gradients.
//! - Skeleton shapes follow eaves and courtyards, with stationary gable ends.
//!   skeleton.ts / skeleton.zig compute the zero/one-speed wavefront; layout
//!   turns its time into roof elevation, with a slope break for mansards.
//! - Radial shapes (pyramidal, cone, dome, onion) are concentric copies of
//!   a base shrunk toward its center, following (height, scale) steps.
//!   layout keeps the footprint for pyramids and near-round towers; otherwise
//!   radial.zig supplies an inscribed circle surrounded by a flat terrace.
//! - Flat roofs (flat, many and every fallback) are n = 1: the roof sits at
//!   building-height and roof-height does not matter.
//! - Roofless copies (a footprint the source cut, with a shape that is not
//!   flat) are n = 0: walls up to the eaves and a flat lid there, below the
//!   real roof that a whole copy in another tile draws.
//!
//! The constants follow OSM2World (tordanik/OSM2World, core/.../building/
//! roof/*.java) unless noted. Every constant is computed in f64 one operation
//! at a time, as JavaScript does, so the twins round alike.

const std = @import("std");
const Allocator = std.mem.Allocator;

const footprint = @import("footprint.zig");
const BoundingRectangle = footprint.BoundingRectangle;
const Point = footprint.Point;
const tie = footprint.tie;
const spec = @import("spec.zig");
const RoofOrientation = spec.RoofOrientation;
const RoofShape = spec.RoofShape;
const skeleton = @import("skeleton.zig");

/// n = gx·x + gy·y + c in tile units.
pub const Plane = struct { gx: f64, gy: f64, c: f64 };

/// The roof frame: u along the ridge, v across it (front toward +v).
pub const Frame = struct {
    center: Point,
    u: Point,
    v: Point,
    /// Half the frame's extent along u.
    a: f64,
    /// Half the frame's extent along v.
    b: f64,
};

/// A curved frame shape: profile points (v, n) across the frame, sorted by
/// v, joined by planar strips. Strips in the same group share vertices and
/// get gradients interpolated between the break lines; groups meet at a
/// crease.
pub const StripProfile = struct {
    v: []const f64,
    n: []const f64,
    /// Group of each strip (v.len - 1 entries).
    groups: []const u32,
};

/// A radial profile step: (height, scale).
pub const Step = [2]f64;

pub const RoofModel = union(enum) {
    flat,
    /// A cut copy of a footprint: walls to the eaves and a lid at n = 0.
    /// The roof's frame needs the whole footprint, which this copy lacks.
    /// The payload is the run the copy would have if it were whole, for
    /// building-roof-angle's eave height: the real run is unknown here.
    roofless: f64,
    planes: PlaneRoof,
    radial: RadialRoof,
    skeleton: SkeletonRoof,
    complex: @import("complex.zig").ComplexRoof,

    /// The horizontal eave-to-ridge distance, in tile units (0 when flat).
    pub fn run(self: RoofModel) f64 {
        return switch (self) {
            .complex => |c| c.run,
            .flat => 0,
            .roofless => |r| r,
            .planes => |p| p.run,
            .radial => |r| r.run,
            .skeleton => |s| s.eave_run orelse s.geometry.run,
        };
    }
};

pub const SkeletonRoof = struct {
    geometry: skeleton.Skeleton,
    /// Optional strips in wavefront time, with the frame-strip gradient rules.
    profile: ?StripProfile = null,
    /// Capped roofs reach their top before the wavefront disappears.
    eave_run: ?f64 = null,
    stationary: []const bool = &.{},
};

pub const PlaneRoof = struct {
    /// Planes in tile coordinates; n is their minimum.
    planes: []const Plane,
    /// Horizontal eave-to-ridge distance, in tile units.
    run: f64,
    /// Present for curved shapes; plane i is strip i.
    strips: ?StripProfile = null,
    frame: Frame,
};

pub const RadialRoof = struct {
    /// (height, scale) from the eaves (0, 1) to the top (1, 0).
    steps: []const Step,
    /// Smooth gradients shared between faces, or one planar face each.
    smooth: bool,
    /// The top is a point with slope: no shared apex vertex.
    pointed: bool,
    center: Point,
    run: f64,
    /// A circular base above a flat terrace, when the footprint is not round.
    base: ?[]const Point = null,
};

/// Footprints whose bounding rectangle is thinner than this get flat roofs.
pub const min_half_width: f64 = 1;
/// OSM2World HalfHippedRoof: the hip is 1/6 of the end wall from each side.
pub const half_hipped_inset: f64 = @as(f64, 1) / 6;
/// OSM2World RoofWithRidge: a ridge end moves at most 0.4 × the ridge line.
pub const ridge_offset_cap: f64 = 0.4;
/// OSM2World SaltboxRoof: the ridge sits 0.7 of the width from the front.
pub const saltbox_ridge: f64 = 0.7;
/// double_saltbox and quadruple_saltbox are a gabled and a hipped roof cut
/// off by a flat top, as Streets GL's QuadrupleSaltboxRoofBuilder and
/// StreetComplete's roof_*_saltbox quest drawings show. The faces run this
/// fraction of the half-width in from the eaves: StreetComplete's drawings
/// measure 0.29 (Streets GL uses 0.5).
pub const flat_top_inset: f64 = 0.3;
/// OSM2World DomeRoof: ten height rings, scale sqrt(1 - h²).
pub const dome_steps: [10]Step = blk: {
    var steps: [10]Step = undefined;
    for (&steps, 0..) |*step, k| {
        const h: f64 = @as(f64, @floatFromInt(k)) / 9;
        step.* = .{ h, @sqrt(1 - h * h) };
    }
    break :blk steps;
};
/// OSM2World OnionRoof's spindle steps.
pub const onion_steps = [_]Step{
    .{ 0, 1 },
    .{ 0.15, 0.8 },
    .{ 0.52, 1 },
    .{ 0.72, 0.7 },
    .{ 0.82, 0.15 },
    .{ 1, 0 },
};
pub const cone_steps = [_]Step{ .{ 0, 1 }, .{ 1, 0 } };

// cos(15° k) for k = 0..6, from square roots so both twins round alike.
const sqrt2: f64 = @sqrt(@as(f64, 2));
const sqrt3: f64 = @sqrt(@as(f64, 3));
const sqrt6: f64 = @sqrt(@as(f64, 6));
const cos15_table = [7]f64{
    1,
    (sqrt6 + sqrt2) / 4,
    sqrt3 / 2,
    sqrt2 / 2,
    0.5,
    (sqrt6 - sqrt2) / 4,
    0,
};
fn cos15(k: usize) f64 {
    return if (k <= 6) cos15_table[k] else -cos15_table[12 - k];
}
fn sin15(k: usize) f64 {
    return if (k <= 6) cos15_table[6 - k] else cos15_table[k - 6];
}

/// round: a semicircular barrel vault across v, in 15° strips.
pub fn roundProfile(allocator: Allocator, b: f64) Allocator.Error!StripProfile {
    const v = try allocator.alloc(f64, 13);
    const n = try allocator.alloc(f64, 13);
    for (0..13) |k| {
        v[k] = -b * cos15(k);
        n[k] = sin15(k);
    }
    const groups = try allocator.alloc(u32, 12);
    @memset(groups, 0);
    return .{ .v = v, .n = n, .groups = groups };
}

/// round_gabled: "gabled, but the two slopes are rounded" (OSM wiki,
/// Tag:roof:shape=round_gabled). An equilateral pointed arch: each side is
/// an arc of radius 2b centered on the opposite eave, vertical at the
/// eaves and meeting the other at a crisp ridge at 60°, in 15° strips.
pub fn roundGabledProfile(allocator: Allocator, b: f64) Allocator.Error!StripProfile {
    const v = try allocator.alloc(f64, 9);
    const n = try allocator.alloc(f64, 9);
    for (0..5) |k| {
        v[k] = b - 2 * b * cos15(k);
        n[k] = (2 * sin15(k)) / sqrt3;
    }
    for (0..4) |j| {
        const k = 3 - j;
        v[5 + j] = -(b - 2 * b * cos15(k));
        n[5 + j] = (2 * sin15(k)) / sqrt3;
    }
    const groups = try allocator.dupe(u32, &.{ 0, 0, 0, 0, 1, 1, 1, 1 });
    return .{ .v = v, .n = n, .groups = groups };
}

/// Picks the roof frame on a bounding rectangle. A set direction (degrees
/// clockwise from north, the way the main face looks) turns +v toward the
/// rectangle axis closest to it (the shorter side's axis on a tie);
/// otherwise orientation picks the ridge axis and +v is u turned 90°
/// clockwise on the map, with u pointing east-ish (+x, or +y when
/// vertical).
pub fn frameFor(rect: BoundingRectangle, orientation: RoofOrientation, direction: ?Point) Frame {
    var u: Point = undefined;
    var v: Point = undefined;
    if (direction) |d| {
        const along_long = @abs(rect.long.x * d.x + rect.long.y * d.y);
        const along_short = @abs(rect.short.x * d.x + rect.short.y * d.y);
        v = if (along_long > along_short + tie) rect.long else rect.short;
        if (v.x * d.x + v.y * d.y < 0) v = .{ .x = -v.x, .y = -v.y };
        u = .{ .x = v.y, .y = -v.x };
    } else {
        u = if (orientation == .across) rect.short else rect.long;
        if (u.x < 0 or (u.x == 0 and u.y < 0)) u = .{ .x = -u.x, .y = -u.y };
        v = .{ .x = -u.y, .y = u.x };
    }
    const u_is_long = @abs(u.x * rect.long.x + u.y * rect.long.y) >
        @abs(u.x * rect.short.x + u.y * rect.short.y);
    return .{
        .center = rect.center,
        .u = u,
        .v = v,
        .a = if (u_is_long) rect.half_long else rect.half_short,
        .b = if (u_is_long) rect.half_short else rect.half_long,
    };
}

/// Unit vector of a roof:direction, or null when unset.
pub fn directionVector(degrees: f64) ?Point {
    if (!(degrees >= 0) or !std.math.isFinite(degrees)) return null;
    const radians = (@rem(degrees, 360) * std.math.pi) / 180;
    // North is -y in tile coordinates, east is +x.
    return .{ .x = @sin(radians), .y = -@cos(radians) };
}

/// A frame plane n = A·u + B·v + C in tile coordinates.
fn framePlane(frame: Frame, A: f64, B: f64, C: f64) Plane {
    const gx = A * frame.u.x + B * frame.v.x;
    const gy = A * frame.u.y + B * frame.v.y;
    return .{ .gx = gx, .gy = gy, .c = C - (gx * frame.center.x + gy * frame.center.y) };
}

fn stripPlanes(allocator: Allocator, frame: Frame, profile: StripProfile) Allocator.Error![]const Plane {
    const planes = try allocator.alloc(Plane, profile.v.len - 1);
    for (planes, 0..) |*plane, j| {
        const slope = (profile.n[j + 1] - profile.n[j]) / (profile.v[j + 1] - profile.v[j]);
        plane.* = framePlane(frame, 0, slope, profile.n[j] - slope * profile.v[j]);
    }
    return planes;
}

/// Frame planes as (A, B, C) rows.
fn planesModel(allocator: Allocator, frame: Frame, list: []const [3]f64, run: f64) Allocator.Error!RoofModel {
    const planes = try allocator.alloc(Plane, list.len);
    for (planes, list) |*plane, row| plane.* = framePlane(frame, row[0], row[1], row[2]);
    return .{ .planes = .{ .planes = planes, .run = run, .frame = frame } };
}

fn radialModel(rect: BoundingRectangle, steps: []const Step, smooth: bool, pointed: bool) RoofModel {
    return .{ .radial = .{
        .steps = steps,
        .smooth = smooth,
        .pointed = pointed,
        .center = rect.center,
        .run = rect.half_short,
    } };
}

fn curvedModel(allocator: Allocator, frame: Frame, strips: StripProfile) Allocator.Error!RoofModel {
    return .{ .planes = .{
        .planes = try stripPlanes(allocator, frame, strips),
        .run = frame.b,
        .strips = strips,
        .frame = frame,
    } };
}

/// The roof model of one footprint. `outer` is the exterior ring (positive
/// area) and is only read by skillion's exact direction. For skeleton shapes,
/// layout builds the full model; this function supplies only a cut-copy run.
pub fn roofModel(
    allocator: Allocator,
    shape: RoofShape,
    rect: BoundingRectangle,
    frame: Frame,
    outer: []const Point,
    direction: ?Point,
) Allocator.Error!RoofModel {
    const a = frame.a;
    const b = frame.b;
    switch (shape) {
        .gabled => return planesModel(allocator, frame, &.{
            .{ 0, -1 / b, 1 },
            .{ 0, 1 / b, 1 },
        }, b),
        .hipped, .mansard => {
            // Whole footprints use the skeleton; cut copies only need a run estimate.
            return .{ .roofless = rect.half_short };
        },
        .@"half-hipped" => {
            // The hip planes keep the side slope and are cut off by the end
            // walls: their ridge ends sit an inset in from the ends.
            const inset = @min(2 * b * half_hipped_inset, ridge_offset_cap * 2 * a);
            return planesModel(allocator, frame, &.{
                .{ 0, -1 / b, 1 },
                .{ 0, 1 / b, 1 },
                .{ -1 / b, 0, 1 + (a - inset) / b },
                .{ 1 / b, 0, 1 + (a - inset) / b },
            }, b);
        },
        .skillion => {
            if (direction) |d| {
                // The exact direction: highest at the vertex furthest against it.
                var min = std.math.inf(f64);
                var max = -std.math.inf(f64);
                for (outer) |p| {
                    const along = p.x * d.x + p.y * d.y;
                    min = @min(min, along);
                    max = @max(max, along);
                }
                const run = max - min;
                if (!(run >= 2 * min_half_width)) return .flat;
                const planes = try allocator.dupe(Plane, &.{
                    .{ .gx = -d.x / run, .gy = -d.y / run, .c = max / run },
                });
                return .{ .planes = .{ .planes = planes, .run = run, .frame = frame } };
            }
            return planesModel(allocator, frame, &.{.{ 0, -1 / (2 * b), 0.5 }}, 2 * b);
        },
        // OSM2World GambrelRoof: the upper slope halves the lower one, with
        // the break 2/3 of the way from the ridge at n = 2/3.
        .gambrel => return planesModel(allocator, frame, &.{
            .{ 0, -1 / (2 * b), 1 },
            .{ 0, 1 / (2 * b), 1 },
            .{ 0, -2 / b, 2 },
            .{ 0, 2 / b, 2 },
        }, b),
        .round => return curvedModel(allocator, frame, try roundProfile(allocator, b)),
        .round_gabled => return curvedModel(allocator, frame, try roundGabledProfile(allocator, b)),
        .double_saltbox => {
            const r = flat_top_inset * b;
            return planesModel(allocator, frame, &.{
                .{ 0, 0, 1 },
                .{ 0, -1 / r, b / r },
                .{ 0, 1 / r, b / r },
            }, r);
        },
        .quadruple_saltbox => {
            const r = flat_top_inset * b;
            const end = @min(r, a);
            return planesModel(allocator, frame, &.{
                .{ 0, 0, 1 },
                .{ 0, -1 / r, b / r },
                .{ 0, 1 / r, b / r },
                .{ -1 / end, 0, a / end },
                .{ 1 / end, 0, a / end },
            }, r);
        },
        .saltbox => {
            // Equal slopes with the ridge moved back: the long face looks
            // toward +v and runs to the front eaves, the back eaves stop at
            // n = 4/7.
            const run = 2 * b * saltbox_ridge;
            const ridge = b - run;
            return planesModel(allocator, frame, &.{
                .{ 0, -1 / run, 1 + ridge / run },
                .{ 0, 1 / run, 1 - ridge / run },
            }, run);
        },
        .pyramidal => return radialModel(rect, &cone_steps, false, true),
        .cone => return radialModel(rect, &cone_steps, true, true),
        .dome => return radialModel(rect, &dome_steps, true, false),
        .onion => return radialModel(rect, &onion_steps, true, true),
        .flat, .many, .complex => return .flat,
    }
}

/// n at a point: the minimum of the planes, clamped to [0, 1].
pub fn envelope(planes: []const Plane, x: f64, y: f64) f64 {
    var n = std.math.inf(f64);
    for (planes) |p| n = @min(n, p.gx * x + p.gy * y + p.c);
    return @min(@max(n, 0), 1);
}

fn profileSlope(profile: StripProfile, k: usize) f64 {
    return (profile.n[k + 1] - profile.n[k]) / (profile.v[k + 1] - profile.v[k]);
}

/// dn/dv of a curved frame shape at frame coordinate v inside strip j:
/// interpolated between the break lines' gradients, each the mean of the
/// slopes of the strips in its group on either side.
pub fn stripGradient(profile: StripProfile, j: usize, v: f64) f64 {
    const group = profile.groups[j];
    const v0 = profile.v[j];
    const v1 = profile.v[j + 1];
    const t = @min(@max((v - v0) / (v1 - v0), 0), 1);
    return atBreak(profile, group, j) * (1 - t) + atBreak(profile, group, j + 1) * t;
}

/// The gradient at break k, which lies between strips k - 1 and k.
fn atBreak(profile: StripProfile, group: u32, k: usize) f64 {
    const before = k >= 1 and profile.groups[k - 1] == group;
    const after = k < profile.groups.len and profile.groups[k] == group;
    if (before and after) return (profileSlope(profile, k - 1) + profileSlope(profile, k)) / 2;
    return if (before) profileSlope(profile, k - 1) else profileSlope(profile, k);
}
