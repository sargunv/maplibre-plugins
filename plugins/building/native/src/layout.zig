//! Building geometry: walls and a roof:shape roof for every polygon of a
//! tile. This is the MapLibre Native twin of ../../js/src/layout.ts: the
//! same cleanup, frames, profiles and vertex order, tested against the same
//! fixtures (../../fixtures/layout). See ../../README.md for the contract
//! the shaders rely on.
//!
//! Vertex format: 7 float32, interleaved.
//!   a_pos  = (x, y, run): tile units; run is the feature's horizontal
//!            eave-to-ridge distance, which building-roof-angle turns into a
//!            roof height (0 for flat roofs).
//!   a_roof = (n, kind, gx, gy):
//!     n    relative roof elevation in [0, 1]; z = wallTop + n × roofHeight.
//!     kind 0 wall bottom (z = base, n = 0), 1 wall top (n follows the roof
//!          along the wall, so gable ends rise), 2 roof, 3 roof underside
//!          (an overhang: onion's bulge; its normal points down).
//!     gx, gy  walls: outward unit normal in tile coordinates. Roofs: the
//!          gradient of n per tile unit; the normal of the roof surface is
//!          ±(-roofHeight·gx, -roofHeight·gy, 1) with heights in tile units
//!          (+ for kind 2, - for kind 3).
//!
//! Winding: core fill-extrusion's. The tile frame (x right, y down, z up) is
//! left-handed, so in tile coordinates cross(b - a, c - a) of every triangle
//! points into the building, and every triangle is counter-clockwise on
//! screen seen from outside: front faces for back-face culling with CCW
//! front faces. Roof triangles have negative signed area (shoelace) in tile
//! coordinates and undersides positive.
//!
//! Sharing: piecewise-linear roofs share vertices only within one planar
//! facet (crisp ridges and hips); curved roofs share them within a smooth
//! group with interpolated gradients. Each wall edge is one planar strip,
//! split where the roof's break lines cross it.
//!
//! Tile copies: every tile draws every footprint it has, buffer copies
//! included, as core fill-extrusion does. A copy the source did not cut is
//! the same footprint in every tile up to a translation, so it is built in
//! a frame anchored on the footprint itself (its floored minimum corner):
//! every copy computes the same roof, bit for bit for integer coordinates.
//! A cut copy cannot know its roof, and draws roofless (see addPolygon).
//!
//! Memory: the output buffers use the layout's allocator; everything a
//! feature needs on the way (cleaned rings, triangulations, meshes) lives in
//! an arena freed when the feature is done. An allocation failure leaves the
//! output partly written; drop the whole layout then.

const std = @import("std");
const radial_base = @import("radial.zig");
const Allocator = std.mem.Allocator;

const footprint = @import("footprint.zig");
const classifyRings = footprint.classifyRings;
const isClipEdge = footprint.isClipEdge;
pub const TileBounds = footprint.TileBounds;
const minimumAreaRectangle = footprint.minimumAreaRectangle;
const Polygon = footprint.Polygon;
const roof = @import("roof.zig");
const directionVector = roof.directionVector;
const envelope = roof.envelope;
const frameFor = roof.frameFor;
const min_half_width = roof.min_half_width;
const Plane = roof.Plane;
const roofModel = roof.roofModel;
const RoofModel = roof.RoofModel;
const stripGradient = roof.stripGradient;
const spec = @import("spec.zig");
const RoofOrientation = spec.RoofOrientation;
const RoofShape = spec.RoofShape;
const triangulate = @import("triangulate.zig").triangulate;
const skeleton = @import("skeleton.zig");

/// Keep frame roofs on rectangles despite tile-grid rounding.
const rectangle_fill = 0.98;

pub const Point = footprint.Point;

/// One vertex as uploaded: a_pos (x, y, run), a_roof (n, kind, gx, gy).
pub const Vertex = extern struct {
    x: f32,
    y: f32,
    run: f32,
    n: f32,
    kind: f32,
    gx: f32,
    gy: f32,
};

/// Floats per vertex: a_pos (x, y, run), a_roof (n, kind, gx, gy).
pub const floats_per_vertex = 7;
/// Byte offsets of the two attributes in a vertex.
pub const pos_offset = @offsetOf(Vertex, "x");
pub const roof_offset = @offsetOf(Vertex, "n");

comptime {
    std.debug.assert(@sizeOf(Vertex) == floats_per_vertex * @sizeOf(f32));
    std.debug.assert(pos_offset == 0);
    std.debug.assert(roof_offset == 12);
}

pub const wall_bottom = 0;
pub const wall_top = 1;
pub const roof_kind = 2;
pub const roof_underside = 3;

/// Vertices per segment stay addressable by 16-bit indices.
pub const max_segment_vertices: u32 = 65535;
/// Radial roofs need their center at least this far, in tile units, inside
/// every edge of the footprint.
pub const min_kernel_distance: f64 = 0.5;
/// Clipped roof pieces with less area (tile units²) are dropped.
const min_piece_area: f64 = 1e-6;
/// Clipped points closer than this, in tile units, merge: where several
/// break lines meet, each facet computes the meeting point from a different
/// pair of lines, a few ulps apart.
pub const merge_distance: f64 = @as(f64, 1) / 1024;
/// Points where two planes differ by no more than this (in n) lie on their
/// break line. Without it, rounding puts points on a line on alternating
/// sides of it, which makes crossings at the wrong place, or none at all
/// (a division by zero) when the line runs along a triangle edge.
pub const on_line: f64 = 1e-9;

pub const Segment = struct {
    vertex_offset: u32,
    index_offset: u32,
    vertex_length: u32 = 0,
    index_length: u32 = 0,
};

/// The vertices one source feature produced.
pub const Range = struct {
    feature_index: u64,
    first_vertex: u32,
    vertex_count: u32,
};

/// The evaluated layout properties of one feature.
pub const LayoutValues = struct {
    /// building-roof-shape; unknown values draw flat roofs.
    shape: []const u8 = "",
    /// building-roof-orientation; unknown values mean along.
    orientation: []const u8 = "",
    /// building-roof-direction in degrees; negative means unset.
    direction: f64 = -1,
};

/// A vertex in the footprint's frame, before it is moved back to tile
/// units and narrowed to float32.
const Local = struct { x: f64, y: f64, run: f64, n: f64, kind: u8, gx: f64, gy: f64 };

fn vertex(x: f64, y: f64, run: f64, n: f64, kind: u8, gx: f64, gy: f64) Local {
    return .{ .x = x, .y = y, .run = run, .n = n, .kind = kind, .gx = gx, .gy = gy };
}

/// A vertex as uploaded, moved from the footprint's frame at `origin`.
fn output(v: Local, origin: Point) Vertex {
    return .{
        .x = @floatCast(v.x + origin.x),
        .y = @floatCast(v.y + origin.y),
        .run = @floatCast(v.run),
        .n = @floatCast(v.n),
        .kind = @floatFromInt(v.kind),
        .gx = @floatCast(v.gx),
        .gy = @floatCast(v.gy),
    };
}

/// A key for vertices shared within one mesh. A mesh keys its vertices
/// either by position or by (ring, corner), never both.
const Key = struct { a: u64, b: u64 };

fn pointKey(x: f64, y: f64) Key {
    // As the twin's string keys, -0 and 0 are the same point.
    return .{ .a = @bitCast(x + 0.0), .b = @bitCast(y + 0.0) };
}

fn ringKey(k: usize, i: usize) Key {
    return .{ .a = k, .b = i };
}

const apex_key: Key = .{ .a = std.math.maxInt(u64), .b = std.math.maxInt(u64) };

/// A group of vertices and triangles emitted together.
const Mesh = struct {
    allocator: Allocator,
    vertices: std.ArrayList(Local) = .empty,
    triangles: std.ArrayList(u32) = .empty,
    keys: std.AutoHashMapUnmanaged(Key, u32) = .empty,

    fn init(allocator: Allocator) Mesh {
        return .{ .allocator = allocator };
    }

    fn size(self: *const Mesh) u32 {
        return @intCast(self.vertices.items.len);
    }

    fn add(self: *Mesh, v: Local) Allocator.Error!u32 {
        try self.vertices.append(self.allocator, v);
        return self.size() - 1;
    }

    /// Adds a vertex once per key.
    fn shared(self: *Mesh, key: Key, v: Local) Allocator.Error!u32 {
        const entry = try self.keys.getOrPut(self.allocator, key);
        if (!entry.found_existing) entry.value_ptr.* = try self.add(v);
        return entry.value_ptr.*;
    }

    fn triangle(self: *Mesh, a: u32, b: u32, c: u32) Allocator.Error!void {
        try self.triangles.appendSlice(self.allocator, &.{ a, b, c });
    }
};

const ClipVertex = struct {
    x: f64,
    y: f64,
    /// Bits of the original triangle edges the vertex lies on.
    mask: u3,

    fn point(self: ClipVertex) Point {
        return .{ .x = self.x, .y = self.y };
    }
};

const Stop = struct { x: f64, y: f64, n: f64 };

const Cut = struct {
    t: f64,
    p: Point,

    fn lessThan(_: void, p: Cut, q: Cut) bool {
        return p.t < q.t;
    }
};

pub const BuildingLayout = struct {
    allocator: Allocator,
    extent: f64,
    /// The bounds of every feature of the tile, which locate its cut lines.
    /// Set them before adding features; the default has no cuts.
    bounds: TileBounds = .no_cuts,
    /// Where the polygon being built has its frame, in tile units.
    origin: Point = .{ .x = 0, .y = 0 },
    vertices: std.ArrayList(Vertex) = .empty,
    /// Segment-relative triangle indices.
    indices: std.ArrayList(u16) = .empty,
    segments: std.ArrayList(Segment) = .empty,
    ranges: std.ArrayList(Range) = .empty,

    pub fn init(allocator: Allocator, extent: u32) BuildingLayout {
        return .{ .allocator = allocator, .extent = @floatFromInt(extent) };
    }

    pub fn deinit(self: *BuildingLayout) void {
        self.vertices.deinit(self.allocator);
        self.indices.deinit(self.allocator);
        self.segments.deinit(self.allocator);
        self.ranges.deinit(self.allocator);
    }

    pub fn vertexCount(self: *const BuildingLayout) u32 {
        return @intCast(self.vertices.items.len);
    }

    pub fn indexCount(self: *const BuildingLayout) u32 {
        return @intCast(self.indices.items.len);
    }

    /// Adds one polygon feature: its rings in tile coordinates (MVT order
    /// and winding: each exterior followed by its holes) and its evaluated
    /// layout properties. Each exterior with its holes is one building.
    pub fn addFeature(
        self: *BuildingLayout,
        rings: []const []const Point,
        feature_index: u64,
        values: LayoutValues,
    ) Allocator.Error!void {
        var arena = std.heap.ArenaAllocator.init(self.allocator);
        defer arena.deinit();
        const scratch = arena.allocator();
        const first_vertex = self.vertexCount();
        const shape = std.meta.stringToEnum(RoofShape, values.shape) orelse .flat;
        const orientation = std.meta.stringToEnum(RoofOrientation, values.orientation) orelse .along;
        const direction = directionVector(values.direction);
        for (try classifyRings(scratch, rings, self.extent, self.bounds)) |polygon|
            try self.addPolygon(scratch, polygon, shape, orientation, direction);
        const vertex_count = self.vertexCount() - first_vertex;
        if (vertex_count > 0)
            try self.ranges.append(self.allocator, .{ .feature_index = feature_index, .first_vertex = first_vertex, .vertex_count = vertex_count });
    }

    /// Builds one polygon in its own frame. Every copy is drawn, in every
    /// tile that has it. An uncut copy gets its whole roof. A cut copy is
    /// roofless: walls up to the eaves and a lid there, which the real roof
    /// of an uncut copy in another tile covers wherever both are drawn (it
    /// is never below the eaves). Flat shapes and courtyards stay flat, as
    /// their whole footprint is. Walls on cut edges are skipped, as
    /// maplibre-gl-js's fill-extrusion does.
    fn addPolygon(
        self: *BuildingLayout,
        scratch: Allocator,
        polygon: Polygon,
        shape: RoofShape,
        orientation: RoofOrientation,
        direction: ?Point,
    ) Allocator.Error!void {
        const rings = try scratch.alloc([]const Point, 1 + polygon.holes.items.len);
        rings[0] = polygon.outer;
        for (rings[1..], polygon.holes.items) |*ring, hole| ring.* = hole;
        const walls = try scratch.alloc([]bool, rings.len);
        for (walls, rings) |*flags, ring| {
            flags.* = try scratch.alloc(bool, ring.len);
            for (flags.*, ring, 0..) |*flag, a, i| flag.* = !isClipEdge(a, ring[(i + 1) % ring.len], self.extent, self.bounds);
        }
        var min_x = std.math.inf(f64);
        var min_y = std.math.inf(f64);
        for (polygon.outer) |p| {
            min_x = @min(min_x, p.x);
            min_y = @min(min_y, p.y);
        }
        const origin: Point = .{ .x = @floor(min_x), .y = @floor(min_y) };
        var local: Polygon = .{ .outer = try toLocal(scratch, polygon.outer, origin), .cut = polygon.cut };
        for (polygon.holes.items) |hole| try local.holes.append(scratch, try toLocal(scratch, hole, origin));
        self.origin = origin;
        const model = if (local.cut)
            try cutModel(scratch, local, shape, orientation, direction)
        else
            try modelFor(scratch, local, shape, orientation, direction);
        if (model == .radial and model.radial.base == null and !radialFits(local.outer, model.radial.center))
            return self.build(scratch, local, .flat, walls);
        try self.build(scratch, local, model, walls);
    }

    /// `walls[r][i]`: whether edge i of ring r (outer, then holes) gets a
    /// wall.
    fn build(self: *BuildingLayout, scratch: Allocator, polygon: Polygon, model: RoofModel, walls: []const []const bool) Allocator.Error!void {
        const run = model.run();
        try self.addWalls(scratch, polygon.outer, walls[0], model, run, if (model == .skeleton) model.skeleton.stationary else &.{});
        for (polygon.holes.items, walls[1..]) |hole, flags| try self.addWalls(scratch, hole, flags, model, run, &.{});
        switch (model) {
            .flat => try self.addFlatRoof(scratch, polygon, 1, 0),
            .roofless => try self.addFlatRoof(scratch, polygon, 0, run),
            .planes => |planes| try self.addPlaneRoof(scratch, polygon, planes),
            .radial => |radial| {
                if (radial.base) |base| {
                    var terrace = polygon;
                    terrace.holes = .empty;
                    try terrace.holes.appendSlice(scratch, polygon.holes.items);
                    const hole = try scratch.dupe(Point, base);
                    std.mem.reverse(Point, hole);
                    try terrace.holes.append(scratch, hole);
                    try self.addFlatRoof(scratch, terrace, 0, run);
                }
                try self.addRadialRoof(scratch, radial.base orelse polygon.outer, radial);
            },
            .skeleton => |model_skeleton| try self.addSkeletonRoof(scratch, model_skeleton),
        }
    }

    // ---- Walls ---------------------------------------------------------------

    fn addWalls(self: *BuildingLayout, scratch: Allocator, ring: []const Point, walls: []const bool, model: RoofModel, run: f64, stationary: []const bool) Allocator.Error!void {
        for (ring, walls, 0..) |a, wall, i| {
            if (!wall) continue;
            const b = ring[(i + 1) % ring.len];
            const dx = b.x - a.x;
            const dy = b.y - a.y;
            const length = @sqrt(dx * dx + dy * dy);
            // Outward: the left of the edge for positive-area exteriors, and
            // into the courtyard for negative-area holes.
            const gx = dy / length;
            const gy = -dx / length;
            const stops = try wallStops(scratch, a, b, model, i < stationary.len and stationary[i]);
            var mesh: Mesh = .init(scratch);
            for (stops) |p| {
                _ = try mesh.add(vertex(p.x, p.y, run, 0, wall_bottom, gx, gy));
                _ = try mesh.add(vertex(p.x, p.y, run, p.n, wall_top, gx, gy));
            }
            for (0..stops.len - 1) |k| {
                const o: u32 = @intCast(2 * k);
                try mesh.triangle(o, o + 2, o + 1);
                try mesh.triangle(o + 1, o + 2, o + 3);
            }
            try self.emit(scratch, &mesh);
        }
    }

    // ---- Roofs ---------------------------------------------------------------

    fn addSkeletonRoof(self: *BuildingLayout, scratch: Allocator, model: roof.SkeletonRoof) Allocator.Error!void {
        const breaks = try skeletonBreaks(scratch, model);
        for (model.geometry.faces) |face| {
            for (0..breaks.len + 1) |band| {
                const points = try skeletonBand(scratch, face.points, breaks, band);
                if (points.len < 3) continue;
                const slope: f64 = if (model.mansard) (if (band == 0) 2 else 0.5) else 1;
                var mesh: Mesh = .init(scratch);
                // Preserve collinear event vertices; triangles need no extra center.
                var center: skeleton.SkeletonPoint = .{ .x = 0, .y = 0, .time = 0 };
                const length: f64 = @floatFromInt(points.len);
                for (points) |p| {
                    center.x += p.x / length;
                    center.y += p.y / length;
                    center.time += p.time / length;
                }
                _ = try mesh.add(skeletonVertex(center, model, face.normal, band, slope));
                for (points) |p| _ = try mesh.add(skeletonVertex(p, model, face.normal, band, slope));
                if (points.len == 3) {
                    if (triangleArea2(f32Point(.{ .x = points[0].x, .y = points[0].y }), f32Point(.{ .x = points[1].x, .y = points[1].y }), f32Point(.{ .x = points[2].x, .y = points[2].y })) > 0)
                        try mesh.triangle(1, 2, 3);
                } else for (points, 0..) |b, i| {
                    const c = points[(i + 1) % points.len];
                    if (triangleArea2(f32Point(.{ .x = center.x, .y = center.y }), f32Point(.{ .x = b.x, .y = b.y }), f32Point(.{ .x = c.x, .y = c.y })) > 0)
                        try mesh.triangle(0, @intCast(i + 1), @intCast((i + 1) % points.len + 1));
                }
                try self.emit(scratch, &mesh);
            }
        }
    }

    /// A triangulation at one n: 1 for flat roofs, 0 for roofless lids.
    fn addFlatRoof(self: *BuildingLayout, scratch: Allocator, polygon: Polygon, n: f64, run: f64) Allocator.Error!void {
        const holes = try scratch.alloc([]const Point, polygon.holes.items.len);
        for (holes, polygon.holes.items) |*hole, ring| hole.* = ring;
        const result = try triangulate(scratch, polygon.outer, holes);
        var mesh: Mesh = .init(scratch);
        var t: usize = 0;
        while (t < result.triangles.len) : (t += 3) {
            var ids: [3]u32 = undefined;
            for (&ids, result.triangles[t .. t + 3]) |*id, i| {
                const p = result.points[i];
                id.* = try mesh.shared(pointKey(p.x, p.y), vertex(p.x, p.y, run, n, roof_kind, 0, 0));
            }
            try mesh.triangle(ids[0], ids[1], ids[2]);
        }
        try self.emit(scratch, &mesh);
    }

    /// A frame shape: every footprint triangle is clipped to every facet, so
    /// each output triangle is planar. Crossings on a triangle edge are
    /// computed from the edge's original endpoints, so the triangles on both
    /// sides of an edge, and the wall below a footprint edge, get the same
    /// points.
    fn addPlaneRoof(self: *BuildingLayout, scratch: Allocator, polygon: Polygon, model: roof.PlaneRoof) Allocator.Error!void {
        const holes = try scratch.alloc([]const Point, polygon.holes.items.len);
        for (holes, polygon.holes.items) |*hole, ring| hole.* = ring;
        const result = try triangulate(scratch, polygon.outer, holes);
        const planes = model.planes;
        const frame = model.frame;
        // Facets that share vertices: one per plane, or one per strip group.
        var group_count: usize = planes.len;
        if (model.strips) |strips| {
            group_count = 0;
            for (strips.groups) |g| group_count = @max(group_count, g + 1);
        }
        for (0..group_count) |group| {
            var mesh: Mesh = .init(scratch);
            for (planes, 0..) |plane, k| {
                if (model.strips) |strips| {
                    if (strips.groups[k] != group) continue;
                } else if (k != group) continue;
                var t: usize = 0;
                while (t < result.triangles.len) : (t += 3) {
                    const corners = [3]Point{
                        result.points[result.triangles[t]],
                        result.points[result.triangles[t + 1]],
                        result.points[result.triangles[t + 2]],
                    };
                    const piece = try clipToFacet(scratch, corners, planes, k);
                    if (piece.len < 3 or area2(piece) <= 2 * min_piece_area) continue;
                    const ids = try scratch.alloc(u32, piece.len);
                    for (ids, piece) |*id, p| {
                        var gx = plane.gx;
                        var gy = plane.gy;
                        if (model.strips) |strips| {
                            const v = (p.x - frame.center.x) * frame.v.x +
                                (p.y - frame.center.y) * frame.v.y;
                            const slope = stripGradient(strips, k, v);
                            gx = slope * frame.v.x;
                            gy = slope * frame.v.y;
                        }
                        id.* = try mesh.shared(
                            pointKey(p.x, p.y),
                            vertex(p.x, p.y, model.run, envelope(planes, p.x, p.y), roof_kind, gx, gy),
                        );
                    }
                    for (1..piece.len - 1) |i| {
                        // Skip slivers that would vanish or flip in float32,
                        // judged in the footprint's frame so that every copy
                        // keeps the same triangles. (At its tile position, a
                        // sliver thinner than float32's rounding there may
                        // still flip: it is culled, a crack under a
                        // thousandth of a tile unit.)
                        if (triangleArea2(f32Point(piece[0].point()), f32Point(piece[i].point()), f32Point(piece[i + 1].point())) <= 0)
                            continue;
                        try mesh.triangle(ids[0], ids[i], ids[i + 1]);
                    }
                }
            }
            try self.emit(scratch, &mesh);
        }
    }

    /// A radial shape: rings of the footprint scaled toward the center by
    /// each profile step. Every band × edge quad is planar (n is linear in
    /// the scale, and the scale is linear across each edge's sector).
    fn addRadialRoof(self: *BuildingLayout, scratch: Allocator, outer: []const Point, model: roof.RadialRoof) Allocator.Error!void {
        const count = outer.len;
        // Gradient of the sector scale ρ (0 at the center, 1 on edge i).
        const sector = try scratch.alloc(Point, count);
        for (sector, 0..) |*g, i| {
            const a = outer[i];
            const b = outer[(i + 1) % count];
            const ex = b.x - a.x;
            const ey = b.y - a.y;
            const c = ex * (model.center.y - a.y) - ey * (model.center.x - a.x);
            g.* = .{ .x = ey / c, .y = -ex / c };
        }
        var radial: Radial = .{ .model = model, .outer = outer, .sector = sector };
        const bands = model.steps.len - 1;

        if (!model.smooth) {
            // One planar face per band and edge.
            for (0..bands) |k| {
                for (0..count) |i| {
                    var mesh: Mesh = .init(scratch);
                    radial.face = .{ .band = k, .edge = i };
                    try radial.radialFace(&mesh, k, i);
                    try self.emit(scratch, &mesh);
                }
            }
            return;
        }

        // Smooth groups: runs of bands facing the same way.
        var start: usize = 0;
        while (start < bands) {
            var end = start;
            while (end + 1 < bands and radial.kindOf(end + 1) == radial.kindOf(start)) end += 1;
            var mesh: Mesh = .init(scratch);
            radial.face = null;
            radial.group = .{ .start = start, .end = end };
            for (start..end + 1) |k| {
                for (0..count) |i| try radial.radialFace(&mesh, k, i);
            }
            try self.emit(scratch, &mesh);
            start = end + 1;
        }
    }

    // ---- Output --------------------------------------------------------------

    /// Appends a mesh's triangles, in order, to the current segment, starting
    /// a new one whenever the next triangle's new vertices would not fit.
    /// Vertices are written on first use, so a mesh may straddle segments.
    fn emit(self: *BuildingLayout, scratch: Allocator, mesh: *const Mesh) Allocator.Error!void {
        const map = try scratch.alloc(i32, mesh.vertices.items.len);
        @memset(map, -1);
        var segment: ?usize = if (self.segments.items.len > 0) self.segments.items.len - 1 else null;
        const triangles = mesh.triangles.items;
        var t: usize = 0;
        while (t < triangles.len) : (t += 3) {
            const tri = triangles[t .. t + 3];
            var fresh: u32 = 0;
            for (tri, 0..) |v, k| {
                if (map[v] < 0 and std.mem.indexOfScalar(u32, tri, v).? == k) fresh += 1;
            }
            if (segment == null or self.segments.items[segment.?].vertex_length + fresh > max_segment_vertices) {
                try self.segments.append(self.allocator, .{
                    .vertex_offset = self.vertexCount(),
                    .index_offset = self.indexCount(),
                });
                segment = self.segments.items.len - 1;
                @memset(map, -1);
            }
            const s = &self.segments.items[segment.?];
            for (tri) |v| {
                if (map[v] < 0) {
                    map[v] = @intCast(s.vertex_length);
                    s.vertex_length += 1;
                    // From the footprint's frame back to tile units.
                    try self.vertices.append(self.allocator, output(mesh.vertices.items[v], self.origin));
                }
            }
            // Meshes are built facing out by cross(b - a, c - a) in tile
            // coordinates; the output swaps b and c into core's winding.
            for ([3]u32{ tri[0], tri[2], tri[1] }) |v| try self.indices.append(self.allocator, @intCast(map[v]));
            s.index_length += 3;
        }
    }
};

/// The state of one radial roof, which the TypeScript twin keeps in
/// closures: corners are added through `corner`, which picks the vertex
/// (planar faces, or shared within a smooth group) as the twin does.
const Radial = struct {
    model: roof.RadialRoof,
    outer: []const Point,
    sector: []const Point,
    /// The band and edge of the planar face being built (flat-shaded).
    face: ?struct { band: usize, edge: usize } = null,
    /// The bands of the smooth group being built.
    group: struct { start: usize, end: usize } = .{ .start = 0, .end = 0 },

    fn slope(self: *const Radial, k: usize) f64 {
        const steps = self.model.steps;
        return (steps[k + 1][0] - steps[k][0]) / (steps[k + 1][1] - steps[k][1]);
    }

    fn kindOf(self: *const Radial, k: usize) u8 {
        return if (self.slope(k) <= 0) roof_kind else roof_underside;
    }

    fn point(self: *const Radial, k: usize, i: usize) Point {
        const r = self.model.steps[k][1];
        const q = self.outer[i % self.outer.len];
        const center = self.model.center;
        if (r == 1) return q;
        if (r == 0) return center;
        return .{
            .x = center.x + r * (q.x - center.x),
            .y = center.y + r * (q.y - center.y),
        };
    }

    fn ringSlope(self: *const Radial, k: usize) f64 {
        const before = k >= self.group.start + 1;
        const after = k <= self.group.end;
        if (before and after) return (self.slope(k - 1) + self.slope(k)) / 2;
        return if (before) self.slope(k - 1) else self.slope(k);
    }

    fn gradient(self: *const Radial, k: usize, i: usize) Point {
        const count = self.outer.len;
        const s = self.ringSlope(k);
        const g0 = self.sector[(i + count - 1) % count];
        const g1 = self.sector[i % count];
        return .{ .x = (s * (g0.x + g1.x)) / 2, .y = (s * (g0.y + g1.y)) / 2 };
    }

    /// The vertex of ring kk at footprint corner ii. `apex_of` is the band
    /// and edge of the face a pointed top belongs to.
    fn corner(self: *const Radial, mesh: *Mesh, kk: usize, ii: usize, apex_of: ?[2]usize) Allocator.Error!u32 {
        const steps = self.model.steps;
        const run = self.model.run;
        const center = self.model.center;
        if (self.face) |face| {
            const p = self.point(kk, ii);
            const s = self.slope(face.band);
            const g = self.sector[face.edge];
            return mesh.add(vertex(p.x, p.y, run, steps[kk][0], self.kindOf(face.band), s * g.x, s * g.y));
        }
        const kind = self.kindOf(self.group.start);
        if (steps[kk][1] == 0) {
            if (apex_of) |of| {
                if (self.model.pointed) {
                    // A pointed top: each face gets its own apex, with the
                    // mean gradient of its base.
                    const g0 = self.gradient(of[0], of[1]);
                    const g1 = self.gradient(of[0], of[1] + 1);
                    return mesh.add(vertex(center.x, center.y, run, steps[kk][0], kind, (g0.x + g1.x) / 2, (g0.y + g1.y) / 2));
                }
            }
            return mesh.shared(apex_key, vertex(center.x, center.y, run, steps[kk][0], kind, 0, 0));
        }
        const wrapped = ii % self.outer.len;
        const p = self.point(kk, wrapped);
        const g = self.gradient(kk, wrapped);
        return mesh.shared(ringKey(kk, wrapped), vertex(p.x, p.y, run, steps[kk][0], kind, g.x, g.y));
    }

    /// The triangles of band k across edge i, from ring k inward to ring
    /// k + 1.
    fn radialFace(self: *const Radial, mesh: *Mesh, k: usize, i: usize) Allocator.Error!void {
        const a = try self.corner(mesh, k, i, null);
        const b = try self.corner(mesh, k, i + 1, null);
        if (self.model.steps[k + 1][1] == 0) {
            try mesh.triangle(a, b, try self.corner(mesh, k + 1, i, .{ k, i }));
            return;
        }
        const c = try self.corner(mesh, k + 1, i + 1, null);
        const d = try self.corner(mesh, k + 1, i, null);
        try mesh.triangle(a, b, c);
        try mesh.triangle(a, c, d);
    }
};

/// Points along a wall top where its slope changes, with n: the ends and
/// every crossing of a break line between two facets of the roof.
fn wallStops(scratch: Allocator, a: Point, b: Point, model: RoofModel, stationary: bool) Allocator.Error![]const Stop {
    if (model == .skeleton and stationary) {
        const m = model.skeleton;
        const run = m.geometry.run;
        const dx = b.x - a.x;
        const dy = b.y - a.y;
        const length2 = dx * dx + dy * dy;
        const TimedStop = struct {
            x: f64,
            y: f64,
            time: f64,
            t: f64,
            fn less(_: void, p: @This(), q: @This()) bool {
                return p.t < q.t;
            }
        };
        var stops: std.ArrayList(TimedStop) = .empty;
        try stops.appendSlice(scratch, &.{ .{ .x = a.x, .y = a.y, .time = 0, .t = 0 }, .{ .x = b.x, .y = b.y, .time = 0, .t = 1 } });
        const breaks = try skeletonBreaks(scratch, m);
        for (m.geometry.faces) |face| {
            for (0..breaks.len + 1) |band| {
                const points = try skeletonBand(scratch, face.points, breaks, band);
                for (points) |p| {
                    const t = ((p.x - a.x) * dx + (p.y - a.y) * dy) / length2;
                    if (t < -1e-9 or t > 1 + 1e-9 or @abs(dx * (p.y - a.y) - dy * (p.x - a.x)) > 1e-7 * length2) continue;
                    var found = false;
                    for (stops.items) |*s| {
                        // Use the frame-wall merge tolerance for events that collapse in float32.
                        if (near(.{ .x = s.x, .y = s.y }, .{ .x = p.x, .y = p.y })) {
                            s.time = @max(s.time, p.time);
                            found = true;
                            break;
                        }
                    }
                    if (!found) try stops.append(scratch, .{ .x = p.x, .y = p.y, .time = p.time, .t = t });
                }
            }
        }
        std.mem.sort(TimedStop, stops.items, {}, TimedStop.less);
        const result = try scratch.alloc(Stop, stops.items.len);
        for (result, stops.items) |*s, p| s.* = .{ .x = p.x, .y = p.y, .n = skeletonHeight(p.time, run, m.mansard, m.profile) };
        return result;
    }
    const planes = switch (model) {
        .planes => |p| p.planes,
        else => {
            const n: f64 = if (model == .flat) 1 else 0;
            return scratch.dupe(Stop, &.{
                .{ .x = a.x, .y = a.y, .n = n },
                .{ .x = b.x, .y = b.y, .n = n },
            });
        },
    };
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const length2 = dx * dx + dy * dy;
    var cuts: std.ArrayList(Cut) = .empty;
    for (planes, 0..) |plane_k, k| {
        for (planes[k + 1 ..]) |plane_j| {
            const line = difference(plane_k, plane_j);
            if (side(evaluate(line, a)) * side(evaluate(line, b)) >= 0) continue;
            // A real break: both planes are the roof there.
            const p = crossing(a, b, line);
            const n = rawEnvelope(planes, p);
            if (@abs(evaluate(plane_k, p) - n) > 1e-9 or
                @abs(evaluate(plane_j, p) - n) > 1e-9)
                continue;
            try cuts.append(scratch, .{ .t = ((p.x - a.x) * dx + (p.y - a.y) * dy) / length2, .p = p });
        }
    }
    // A stable sort, so equal crossings keep their pair order.
    std.mem.sort(Cut, cuts.items, {}, Cut.lessThan);
    var stops: std.ArrayList(Stop) = .empty;
    try stops.append(scratch, .{ .x = a.x, .y = a.y, .n = envelope(planes, a.x, a.y) });
    for (cuts.items) |cut| {
        const p = cut.p;
        const last = stops.items[stops.items.len - 1];
        if (near(p, .{ .x = last.x, .y = last.y }) or near(p, b)) continue;
        try stops.append(scratch, .{ .x = p.x, .y = p.y, .n = envelope(planes, p.x, p.y) });
    }
    try stops.append(scratch, .{ .x = b.x, .y = b.y, .n = envelope(planes, b.x, b.y) });
    return stops.items;
}

/// A ring moved into the frame at `origin`.
fn toLocal(scratch: Allocator, ring: []const Point, origin: Point) Allocator.Error![]Point {
    const result = try scratch.alloc(Point, ring.len);
    for (result, ring) |*q, p| q.* = .{ .x = p.x - origin.x, .y = p.y - origin.y };
    return result;
}

/// The roof model of an uncut footprint, or flat for one a shape cannot
/// take.
fn modelFor(
    scratch: Allocator,
    polygon: Polygon,
    shape: RoofShape,
    orientation: RoofOrientation,
    direction: ?Point,
) Allocator.Error!RoofModel {
    if (shape == .flat or shape == .many) return .flat;
    const rect = try minimumAreaRectangle(scratch, polygon.outer) orelse return .flat;
    if (rect.half_short < min_half_width) return .flat;
    if (shape == .hipped or shape == .mansard) {
        const geometry = (try skeleton.straightSkeleton(scratch, polygon)) orelse return .flat;
        if (geometry.run < min_half_width) return .flat;
        return .{ .skeleton = .{ .geometry = geometry, .mansard = shape == .mansard } };
    }
    var concave = false;
    for (polygon.outer, 0..) |p, i| {
        const ring = polygon.outer;
        if (footprint.cross(ring[(i + ring.len - 1) % ring.len], p, ring[(i + 1) % ring.len]) < 0) concave = true;
    }
    if ((shape == .gabled or shape == .gambrel or shape == .double_saltbox or shape == .quadruple_saltbox or shape == .round or shape == .round_gabled) and
        (shape == .gabled or shape == .gambrel or polygon.holes.items.len > 0 or concave) and
        (polygon.holes.items.len > 0 or footprint.signedArea2(polygon.outer) < rectangle_fill * 8 * rect.half_long * rect.half_short))
    {
        const hips = (try skeleton.straightSkeleton(scratch, polygon)) orelse return .flat;
        const ends = try skeleton.gableEnds(scratch, polygon.outer, hips);
        const has_ends = std.mem.indexOfScalar(bool, ends, true) != null;
        if (has_ends or polygon.holes.items.len > 0) {
            const capped = shape == .double_saltbox or shape == .quadruple_saltbox;
            const geometry = if (has_ends and shape != .quadruple_saltbox) (try skeleton.weightedSkeleton(scratch, polygon, ends)) orelse return .flat else hips;
            if (geometry.run < min_half_width) return .flat;
            return .{ .skeleton = .{ .geometry = geometry, .mansard = shape == .gambrel, .stationary = if (shape == .quadruple_saltbox) &.{} else ends, .profile = try skeletonProfile(scratch, shape, geometry.run), .eave_run = if (capped) roof.flat_top_inset * geometry.run else null } };
        }
    }
    if (polygon.holes.items.len > 0 and shape == .pyramidal) return .flat;
    const frame = frameFor(rect, orientation, direction);
    var model = try roofModel(scratch, shape, rect, frame, polygon.outer, direction);
    if (model != .radial or shape == .pyramidal) return model;
    if (polygon.holes.items.len == 0 and radial_base.roundFootprint(polygon.outer, model.radial.center) and radialFits(polygon.outer, model.radial.center)) return model;
    const circle = (try radial_base.inscribedCircle(scratch, polygon, model.radial.center, rect.half_short)) orelse return .flat;
    model.radial.center = circle.center;
    model.radial.run = circle.run;
    model.radial.base = circle.base;
    return model;
}

/// The model of a cut copy: flat where the whole footprint is flat too (a
/// flat shape, or an unsupported courtyard shape), else
/// roofless, with the run the piece would have if it were whole. Its eaves
/// sit exactly at the real roof's with building-roof-height; with
/// building-roof-angle the run is an estimate.
fn cutModel(
    scratch: Allocator,
    polygon: Polygon,
    shape: RoofShape,
    orientation: RoofOrientation,
    direction: ?Point,
) Allocator.Error!RoofModel {
    if (shape == .flat or shape == .many or (polygon.holes.items.len > 0 and shape == .pyramidal)) return .flat;
    const rect = try minimumAreaRectangle(scratch, polygon.outer) orelse return .{ .roofless = 0 };
    const frame = frameFor(rect, orientation, direction);
    const model = try roofModel(scratch, shape, rect, frame, polygon.outer, direction);
    return .{ .roofless = if (model == .flat) rect.half_short else model.run() };
}

fn skeletonProfile(scratch: Allocator, shape: RoofShape, run: f64) Allocator.Error!?roof.StripProfile {
    if (shape == .double_saltbox or shape == .quadruple_saltbox)
        return .{ .v = try scratch.dupe(f64, &.{ 0, roof.flat_top_inset * run, run }), .n = try scratch.dupe(f64, &.{ 0, 1, 1 }), .groups = try scratch.dupe(u32, &.{ 0, 1 }) };
    if (shape != .round and shape != .round_gabled) return null;
    var profile = if (shape == .round) try roof.roundProfile(scratch, run) else try roof.roundGabledProfile(scratch, run);
    // Keep both halves for the ridge gradient: round is smooth, pointed creased.
    const times = try scratch.alloc(f64, profile.v.len);
    for (times, profile.v) |*t, v| t.* = v + run;
    profile.v = times;
    return profile;
}

fn skeletonBreaks(scratch: Allocator, model: roof.SkeletonRoof) Allocator.Error![]const f64 {
    if (model.profile) |profile| {
        var count: usize = 1;
        while (count < profile.v.len and profile.v[count] < model.geometry.run) : (count += 1) {}
        return profile.v[1..count];
    }
    return if (model.mansard) try scratch.dupe(f64, &.{model.geometry.run / 3}) else &.{};
}

fn skeletonBand(scratch: Allocator, points: []const skeleton.SkeletonPoint, breaks: []const f64, band: usize) Allocator.Error![]const skeleton.SkeletonPoint {
    var result = points;
    if (band > 0) result = try clipSkeletonFace(scratch, result, breaks[band - 1], false);
    if (band < breaks.len) result = try clipSkeletonFace(scratch, result, breaks[band], true);
    return result;
}

fn skeletonVertex(p: skeleton.SkeletonPoint, model: roof.SkeletonRoof, normal: Point, band: usize, slope: f64) Local {
    const run = model.geometry.run;
    const gx = if (model.profile) |profile| stripGradient(profile, band, p.time) * normal.x else slope * normal.x / run;
    const gy = if (model.profile) |profile| stripGradient(profile, band, p.time) * normal.y else slope * normal.y / run;
    return vertex(p.x, p.y, model.eave_run orelse run, skeletonHeight(p.time, run, model.mansard, model.profile), roof_kind, gx, gy);
}

fn skeletonHeight(time: f64, run: f64, mansard: bool, strips: ?roof.StripProfile) f64 {
    if (strips) |profile| {
        var band: usize = 0;
        while (band + 2 < profile.v.len and time > profile.v[band + 1]) : (band += 1) {}
        const t = std.math.clamp((time - profile.v[band]) / (profile.v[band + 1] - profile.v[band]), 0, 1);
        return profile.n[band] + t * (profile.n[band + 1] - profile.n[band]);
    }
    return std.math.clamp(if (mansard) @min(2 * time / run, 0.5 + 0.5 * time / run) else time / run, 0, 1);
}

fn clipSkeletonFace(scratch: Allocator, points: []const skeleton.SkeletonPoint, time: f64, below: bool) Allocator.Error![]const skeleton.SkeletonPoint {
    var result: std.ArrayList(skeleton.SkeletonPoint) = .empty;
    for (points, 0..) |a, i| {
        const b = points[(i + 1) % points.len];
        // Retain event vertices on the break in both bands, including collinear ones.
        const sa = side((a.time - time) / time);
        const sb = side((b.time - time) / time);
        if (if (below) sa <= 0 else sa >= 0) try result.append(scratch, a);
        if (sa * sb < 0) {
            const t = (time - a.time) / (b.time - a.time);
            try result.append(scratch, .{ .x = a.x + t * (b.x - a.x), .y = a.y + t * (b.y - a.y), .time = time });
        }
    }
    return result.toOwnedSlice(scratch);
}

/// Whether every edge of a positive-area ring is visible from the center.
fn radialFits(outer: []const Point, center: Point) bool {
    for (outer, 0..) |a, i| {
        const b = outer[(i + 1) % outer.len];
        const ex = b.x - a.x;
        const ey = b.y - a.y;
        const c = ex * (center.y - a.y) - ey * (center.x - a.x);
        if (!(c > min_kernel_distance * @sqrt(ex * ex + ey * ey))) return false;
    }
    return true;
}

fn near(p: Point, q: Point) bool {
    return @abs(p.x - q.x) <= merge_distance and @abs(p.y - q.y) <= merge_distance;
}

fn evaluate(plane: Plane, p: Point) f64 {
    return plane.gx * p.x + plane.gy * p.y + plane.c;
}

fn difference(p: Plane, q: Plane) Plane {
    return .{ .gx = p.gx - q.gx, .gy = p.gy - q.gy, .c = p.c - q.c };
}

fn rawEnvelope(planes: []const Plane, p: Point) f64 {
    var n = std.math.inf(f64);
    for (planes) |plane| n = @min(n, evaluate(plane, p));
    return n;
}

/// Where segment ab crosses the line f = 0, computed from the
/// lexicographically smaller endpoint so it does not depend on direction.
fn crossing(a_in: Point, b_in: Point, line: Plane) Point {
    var a = a_in;
    var b = b_in;
    if (b.x < a.x or (b.x == a.x and b.y < a.y)) std.mem.swap(Point, &a, &b);
    const fa = evaluate(line, a);
    const fb = evaluate(line, b);
    if (fa == 0) return a;
    if (fb == 0) return b;
    const t = fa / (fa - fb);
    return .{ .x = a.x + t * (b.x - a.x), .y = a.y + t * (b.y - a.y) };
}

/// Sutherland–Hodgman clip of a triangle to the facet of plane k: the
/// region where it is no higher than every other plane. Vertices remember
/// which triangle edges they lie on, so crossings on an edge use its
/// original endpoints.
fn clipToFacet(scratch: Allocator, corners: [3]Point, planes: []const Plane, k: usize) Allocator.Error![]const ClipVertex {
    var polygon: std.ArrayList(ClipVertex) = .empty;
    try polygon.appendSlice(scratch, &.{
        .{ .x = corners[0].x, .y = corners[0].y, .mask = 0b101 },
        .{ .x = corners[1].x, .y = corners[1].y, .mask = 0b011 },
        .{ .x = corners[2].x, .y = corners[2].y, .mask = 0b110 },
    });
    var out: std.ArrayList(ClipVertex) = .empty;
    for (planes, 0..) |plane_j, j| {
        if (polygon.items.len == 0) break;
        if (j == k) continue;
        const line = difference(planes[k], plane_j);
        if (line.gx == 0 and line.gy == 0) {
            // Parallel planes: k is never lower, or the same plane, which
            // the first of the two owns.
            if (line.c > 0 or (line.c == 0 and j < k)) return &.{};
            continue;
        }
        out.clearRetainingCapacity();
        const items = polygon.items;
        for (items, 0..) |p, i| {
            const q = items[(i + 1) % items.len];
            const sp = side(evaluate(line, p.point()));
            const sq = side(evaluate(line, q.point()));
            if (sp <= 0) try out.append(scratch, p);
            if (sp * sq < 0) {
                // On a triangle edge, cross the edge itself, so the triangle
                // on its other side and the wall below it get the same
                // point.
                const common = p.mask & q.mask;
                const e: usize = if (common == 0b001) 0 else if (common == 0b010) 1 else 2;
                const a = corners[e];
                const b = corners[(e + 1) % 3];
                const c = if (common != 0 and
                    side(evaluate(line, a)) * side(evaluate(line, b)) < 0)
                    crossing(a, b, line)
                else
                    crossing(p.point(), q.point(), line);
                try out.append(scratch, .{ .x = c.x, .y = c.y, .mask = common });
            }
        }
        std.mem.swap(std.ArrayList(ClipVertex), &polygon, &out);
    }
    // Merge repeated and nearly repeated points (a line through a vertex,
    // or several lines meeting).
    var result: std.ArrayList(ClipVertex) = .empty;
    for (polygon.items) |p| {
        if (result.items.len > 0 and near(result.items[result.items.len - 1].point(), p.point())) continue;
        try result.append(scratch, p);
    }
    while (result.items.len > 1 and near(result.items[0].point(), result.items[result.items.len - 1].point()))
        _ = result.pop();
    return result.items;
}

/// -1, 0 or 1: which side of a break line a plane difference puts a point.
fn side(f: f64) i32 {
    return if (f > on_line) 1 else if (f < -on_line) -1 else 0;
}

fn area2(polygon: []const ClipVertex) f64 {
    var sum: f64 = 0;
    for (polygon, 0..) |p, i| {
        const q = polygon[(i + 1) % polygon.len];
        sum += p.x * q.y - q.x * p.y;
    }
    return sum;
}

fn f32Point(p: Point) Point {
    return .{ .x = @as(f32, @floatCast(p.x)), .y = @as(f32, @floatCast(p.y)) };
}

fn triangleArea2(a: Point, b: Point, c: Point) f64 {
    return (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
}

test {
    _ = @import("footprint_test.zig");
    _ = @import("layout_test.zig");
    _ = spec;
}
