//! The emitter's CPU half, in f64: the camera part of the frame-table header
//! from build_frame's context, and one layer's table row from its evaluated
//! paint (properties.TableUBO). emitter.zig runs the table protocol around
//! them.
//!
//! Twin of ../../js/src/record.ts. The row, the pool size and the weather
//! pools must agree between the two; ../../fixtures/record.json holds the
//! shared cases. Its expected outputs come from this file: after changing the
//! cases below or the packing, run `UPDATE_FIXTURES=1 zig build test` in
//! native/ (it rewrites ../fixtures/record.json), then `pnpm exec dprint fmt
//! plugins/particles/fixtures/record.json` from the repo root.

const std = @import("std");
const build_options = @import("build_options");
const c = @import("maplibre_native_c");
const properties = @import("properties.zig");

const Header = properties.Header;
const Lane = properties.Lane;

/// One layer's 15 vec4 of the table (properties.Lane).
pub const Row = [properties.row_vec4s][4]f32;
/// The table header (properties.Header).
pub const HeaderBlock = [properties.header_vec4s][4]f32;

pub const tile_size: f64 = 512;
/// MapLibre Native's Earth radius (util::EARTH_RADIUS_M), which sets its
/// pixels per meter.
pub const earth_radius: f64 = 6378137;
/// Web Mercator's latitude limit in degrees.
pub const max_latitude: f64 = 85.051128779806604;
/// Pool sizes are powers of two up to this many particles.
pub const max_pool: u32 = 16384;
/// particle-count's maximum, where the shader clamps it (@clamp
/// particle-count).
pub const max_count: f32 = properties.find("particle-count").maximum.?;

/// The camera fields of build_frame's context that the header and the row
/// need.
pub const Frame = struct {
    zoom: f64,
    center_latitude: f64,
    center_longitude: f64,
    /// Radians.
    pitch: f64,
    /// Logical pixels.
    camera_to_center_distance: f64,
    /// Mercator world pixels (y down) and meters up to clip, column-major.
    proj_matrix: [16]f64,

    pub fn fromContext(context: *const c.mln_plugin_frame_context_v1) Frame {
        return .{
            .zoom = context.zoom,
            .center_latitude = context.center_latitude,
            .center_longitude = context.center_longitude,
            .pitch = context.pitch,
            .camera_to_center_distance = context.camera_to_center_distance,
            .proj_matrix = context.proj_matrix,
        };
    }

    /// Whether the frame can place anything: a finite camera and
    /// projection, and a positive camera-to-center distance.
    pub fn valid(frame: Frame) bool {
        if (!(frame.camera_to_center_distance > 0) or !(@abs(frame.center_latitude) <= 90)) return false;
        for ([_]f64{ frame.zoom, frame.center_longitude, frame.pitch, frame.camera_to_center_distance }) |v| {
            if (!std.math.isFinite(v)) return false;
        }
        for (frame.proj_matrix) |v| if (!std.math.isFinite(v)) return false;
        return true;
    }
};

pub fn worldSize(zoom: f64) f64 {
    return tile_size * @exp2(zoom);
}

/// Web Mercator world pixels (x east, y south) at this world size, from
/// degrees. The center of build_frame's context is unwrapped, as is the
/// center proj_matrix translates by, so neither is wrapped here.
pub fn mercator(latitude: f64, longitude: f64, world_size: f64) [2]f64 {
    const phi = std.math.clamp(latitude, -max_latitude, max_latitude) * std.math.pi / 180;
    return .{
        (longitude + 180) / 360 * world_size,
        (0.5 - @log(@tan(std.math.pi / 4.0 + phi / 2)) / (2 * std.math.pi)) * world_size,
    };
}

/// The latitude in degrees of a Mercator world pixel row.
pub fn latitudeOf(y: f64, world_size: f64) f64 {
    return (2 * std.math.atan(@exp((0.5 - y / world_size) * 2 * std.math.pi)) - std.math.pi / 2.0) * 180 / std.math.pi;
}

/// World pixels per meter on the ground at this latitude, as MapLibre Native
/// scales heights.
pub fn pixelsPerMeter(latitude: f64, world_size: f64) f64 {
    const phi = std.math.clamp(latitude, -max_latitude, max_latitude) * std.math.pi / 180;
    return world_size / (2 * std.math.pi * earth_radius * @cos(phi));
}

// ---------------------------------------------------------------------------
// Header: the per-map camera, shared by every emitter row of a frame.
// ---------------------------------------------------------------------------

/// proj_matrix · translate(center): the projection of world pixels relative
/// to the frame center, so the f32 shader never sees world-sized offsets.
/// Only column 3 changes.
fn relativeProjection(proj: [16]f64, center: [2]f64) [16]f64 {
    var result = proj;
    for (0..4) |r| result[12 + r] = proj[r] * center[0] + proj[4 + r] * center[1] + proj[12 + r];
    return result;
}

/// The projection's z scale. MapLibre Native multiplies the z column by the
/// pixels per meter at the latitude of the camera's ground position
/// (Camera::getWorldToCamera), so this is that formula at the eye, which is
/// exact at every pitch; reading it back from the w row would divide by
/// cos(pitch), which vanishes at 90 degrees. A projection with no eye
/// (axonometric) falls back to the center latitude.
fn cameraPixelsPerMeter(frame: Frame, eye: ?[3]f64, center: [2]f64, world_size: f64) f64 {
    const latitude = if (eye) |e| latitudeOf(center[1] + e[1], world_size) else frame.center_latitude;
    return pixelsPerMeter(latitude, world_size);
}

/// The camera's eye: the point P maps to clip x = y = w = 0, from the null
/// space of those three rows (x, y in world pixels from the frame center,
/// z in meters). Null when P has no center of projection. Scaling P's z
/// column changes only z, so x and y do not depend on the z scale.
fn eyePosition(p: [16]f64) ?[3]f64 {
    const rows = [3]usize{ 0, 1, 3 };
    var a: [3][3]f64 = undefined;
    var b: [3]f64 = undefined;
    for (rows, 0..) |r, i| {
        for (0..3) |k| a[i][k] = p[4 * k + r];
        b[i] = -p[12 + r];
    }
    const det = determinant(a);
    if (det == 0 or !std.math.isFinite(det)) return null;
    var eye: [3]f64 = undefined;
    for (0..3) |k| {
        // Cramer's rule: column k replaced by b.
        var m = a;
        for (0..3) |i| m[i][k] = b[i];
        eye[k] = determinant(m) / det;
        if (!std.math.isFinite(eye[k])) return null;
    }
    return eye;
}

fn determinant(m: [3][3]f64) f64 {
    return m[0][0] * (m[1][1] * m[2][2] - m[1][2] * m[2][1]) -
        m[0][1] * (m[1][0] * m[2][2] - m[1][2] * m[2][0]) +
        m[0][2] * (m[1][0] * m[2][1] - m[1][1] * m[2][0]);
}

pub const Pools = struct {
    /// (phase east, phase north, phase up in [0, 1), scale s_p)
    pool0: [4]f64,
    pool1: [4]f64,
    /// (pool 0 weight, pool 1 weight, eye altitude px, 0)
    weights: [4]f64,
};

fn fract(x: f64) f64 {
    return x - @floor(x);
}

/// The two weather octave pools. Pool p is anchored at the absolute zoom of
/// parity p nearest below or above (Z_p), scales its box by s_p = 2^(zoom -
/// Z_p) and fades with the zoom's distance from Z_p, so crossing an integer
/// zoom re-anchors only the pool whose weight is 0. Each pool's phase is the
/// eye's position in its lattice of boxes, box pixels wide at Z_p: the shader
/// wraps particles into the box around the eye by it, which keeps them fixed
/// to the world. eye_x and eye_y are absolute world pixels at `zoom`;
/// eye_altitude is in pixels. The same function as weatherPools in
/// js/src/model.ts, operation for operation.
pub fn weatherPools(zoom: f64, eye_x: f64, eye_y: f64, eye_altitude: f64, box: f64) Pools {
    const n = @floor(zoom);
    const f = zoom - n;
    // Two's complement, like the JS `n & 1`, so negative zooms agree too.
    const odd: u1 = @truncate(@as(u64, @bitCast(@as(i64, @intFromFloat(n)))));
    var result: Pools = undefined;
    for (0..2) |p| {
        const anchor = if (odd == p) n else n + 1;
        const scale = @exp2(zoom - anchor);
        const weight = if (anchor == n) 1 - f else f;
        const pool = [4]f64{ fract(eye_x / scale / box), fract(-eye_y / scale / box), fract(eye_altitude / (scale * box)), scale };
        if (p == 0) result.pool0 = pool else result.pool1 = pool;
        result.weights[p] = weight;
    }
    result.weights[2] = eye_altitude;
    result.weights[3] = 0;
    return result;
}

fn vec4(v: [4]f64) [4]f32 {
    return .{ @floatCast(v[0]), @floatCast(v[1]), @floatCast(v[2]), @floatCast(v[3]) };
}

/// The header parts build_frame owns: P_rel (h0-h3), ppm at the camera and
/// pitch (h6.zw), the eye (h7) and the weather pools (h8-h10). The clock,
/// the screen and h6.xy come from the uniform context and stay 0 here.
pub fn header(frame: Frame) HeaderBlock {
    var h = std.mem.zeroes(HeaderBlock);
    const world_size = worldSize(frame.zoom);
    const center = mercator(frame.center_latitude, frame.center_longitude, world_size);
    const p = relativeProjection(frame.proj_matrix, center);
    for (0..4) |column| h[column] = vec4(p[4 * column ..][0..4].*);
    const found = eyePosition(p);
    const ppm = cameraPixelsPerMeter(frame, found, center, world_size);
    const ppm32: f32 = @floatCast(ppm);
    h[@intFromEnum(Header.view)] = .{ 0, 0, ppm32, @floatCast(frame.pitch) };
    // Straight above the center at the camera distance when P has no eye.
    const eye = found orelse [3]f64{ 0, 0, frame.camera_to_center_distance / ppm };
    const eye32 = [3]f32{ @floatCast(eye[0]), @floatCast(eye[1]), @floatCast(eye[2]) };
    // The box is the camera distance, in pixels at Z_p.
    const box = frame.camera_to_center_distance;
    h[@intFromEnum(Header.eye)] = .{ eye32[0], eye32[1], eye32[2], @floatCast(box) };
    // Phases from the eye the shader projects (its f32 value), so the
    // lattice stays fixed to the world to the last bit.
    const altitude = @as(f64, eye32[2]) * @as(f64, ppm32);
    const pools = weatherPools(frame.zoom, center[0] + eye32[0], center[1] + eye32[1], altitude, box);
    h[@intFromEnum(Header.pool0)] = vec4(pools.pool0);
    h[@intFromEnum(Header.pool1)] = vec4(pools.pool1);
    h[@intFromEnum(Header.weights)] = vec4(pools.weights);
    return h;
}

// ---------------------------------------------------------------------------
// Row: one emitter layer's paint.
// ---------------------------------------------------------------------------

fn valueIndex(comptime property: []const u8, comptime value: []const u8) f64 {
    return comptime blk: {
        for (properties.find(property).values, 0..) |candidate, i| {
            if (std.mem.eql(u8, candidate, value)) break :blk @floatFromInt(i);
        }
        @compileError(property ++ " has no value " ++ value);
    };
}

const weather_kind = valueIndex("emitter-kind", "weather");
const world_space = valueIndex("particle-space", "world");

/// The index of an enum's string value, or its default's for an unknown one
/// (the host's ENUM_FLOAT rule).
fn enumIndex(comptime property: properties.Property, value: c.mln_plugin_value) f64 {
    const s = value.data.string_value;
    const text = if (s.size == 0 or s.data == null) "" else s.data[0..s.size];
    inline for (property.values, 0..) |candidate, i| {
        if (std.mem.eql(u8, candidate, text)) return i;
    }
    return property.default[0];
}

fn rgba(value: c.mln_plugin_value) [4]f64 {
    const color = value.data.color_value;
    return .{ color.r, color.g, color.b, color.a };
}

/// The ranks the count prefix can show for any target up to `count`
/// (particlePrefix in shaders/particle.glsl): its ramp, max(1, count / 8)
/// ranks wide and centered on the target, reaches rank target - 0.5 +
/// max(0.5, count / 16), so a pool with fewer ranks cuts off particles that
/// should show. `count` is finite and at least 0. Twin of prefixRanks in
/// record.ts.
pub fn prefixRanks(count: f32) u32 {
    const n: f64 = count;
    return @intFromFloat(@ceil(n - 0.5 + @max(0.5, n / 16)));
}

/// The particles a layer's vertex bytes carry: the ranks of the count
/// prefix's whole ramp (prefixRanks), rounded up to a power of two of at
/// least 64 for point and circle emitters. Weather draws two octaves from one
/// pool, alternate particles each, so it keeps twice a power of two of at
/// least 32 ranks. Both stop at max_pool particles, which holds the whole
/// ramp up to a count of 15420, or 7710 for weather; past that the pool cuts
/// the top of the ramp, and a weather octave shows at most 8192 particles.
pub fn poolSize(count: f32, weather: bool) u32 {
    const ranks = prefixRanks(if (count > 0) @min(count, max_count) else 0);
    if (weather) return @min(2 * std.math.ceilPowerOfTwoAssert(u32, @max(ranks, 32)), max_pool);
    return @min(std.math.ceilPowerOfTwoAssert(u32, @max(ranks, 64)), max_pool);
}

pub const Emitter = struct {
    row: Row,
    /// Pool size (particles) for the vertex bytes.
    pool: u32,
    /// Whether the layer draws anything. False with no particles (count or
    /// opacity 0) and no screen tint, or for a point or circle emitter at an
    /// unusable position; the layer then gets no row and no drawables.
    visible: bool,
};

pub const PackError = error{ PropertyCount, StructSize, ValueType };

/// Packs one emitter layer's row (properties.Lane) from its paint values in
/// definition order, as build_frame receives them. Every lane holds the raw
/// value in spec units, with three exceptions:
///   - color and colorEnd: the host's premultiplied colors times the clamped
///     particle-opacity, with particle-color-end painted over particle-color
///     (end + color · (1 - end.a));
///   - emission.w: the identity, seed + 65536 · (shape + 16 · space + 64 ·
///     kind), exact in f32; the seed is floored into [0, 65535] (the host
///     eases it despite supports_transitions = 0);
///   - placement: the emitter's world pixels from the frame center at its
///     nearest world copy (0 for weather), and its pixels per meter in world
///     space (else 1).
/// emitter-vignette is clamped to [0, 1], as particle-opacity is; the shader
/// clamps everything else. Arithmetic is f64 with one rounding to f32 per
/// component.
pub fn pack(values: []const c.mln_plugin_property_value_v1, frame: Frame) PackError!Emitter {
    if (values.len != properties.emitter_lanes.len) return error.PropertyCount;
    var row = std.mem.zeroes(Row);
    var identity: f64 = 0;
    var kind: f64 = 0;
    var space: f64 = 0;
    var color: [4]f64 = @splat(0);
    var color_end: [4]f64 = @splat(0);
    var opacity: f64 = 1;
    var position: c.mln_plugin_double2 = .{ .x = 0, .y = 0 };
    inline for (properties.emitter_lanes, 0..) |entry, i| {
        const property = comptime properties.find(entry.name);
        if (values[i].struct_size < @sizeOf(c.mln_plugin_property_value_v1)) return error.StructSize;
        const value = values[i].value;
        if (value.struct_size < @sizeOf(c.mln_plugin_value)) return error.StructSize;
        if (value.type != comptime properties.valueType(property)) return error.ValueType;
        const lane = &row[@intFromEnum(entry.lane)];
        switch (entry.use) {
            .raw => switch (property.type) {
                .float => lane[entry.component] = value.data.float_value,
                .float2 => {
                    lane[entry.component] = value.data.float2_value.x;
                    lane[entry.component + 1] = value.data.float2_value.y;
                },
                .color => lane.* = vec4(rgba(value)),
                .enumeration, .double2 => @compileError(entry.name ++ " cannot be packed raw"),
            },
            .clamped => lane[entry.component] = std.math.clamp(value.data.float_value, property.minimum.?, property.maximum.?),
            .identity => {
                const part: f64 = switch (property.type) {
                    .enumeration => enumIndex(property, value),
                    .float => @floor(std.math.clamp(@as(f64, value.data.float_value), property.minimum.?, property.maximum.?)),
                    else => @compileError(entry.name ++ " cannot be packed into the identity"),
                };
                identity += entry.weight * part;
                if (comptime std.mem.eql(u8, entry.name, "emitter-kind")) kind = part;
                if (comptime std.mem.eql(u8, entry.name, "particle-space")) space = part;
            },
            .color => if (entry.lane == .color) {
                color = rgba(value);
            } else {
                color_end = rgba(value);
            },
            .opacity => opacity = std.math.clamp(@as(f64, value.data.float_value), 0, 1),
            .position => position = value.data.double2_value,
        }
    }
    row[@intFromEnum(Lane.emission)][3] = @floatCast(identity);
    for (0..4) |k| {
        row[@intFromEnum(Lane.color)][k] = @floatCast(color[k] * opacity);
        row[@intFromEnum(Lane.color_end)][k] = @floatCast((color_end[k] + color[k] * (1 - color_end[3])) * opacity);
    }

    const weather = kind == weather_kind;
    const placement = &row[@intFromEnum(Lane.placement)];
    placement[0] = 0;
    placement[1] = 0;
    placement[2] = 1;
    var positioned = true;
    if (!weather) {
        positioned = std.math.isFinite(position.x) and std.math.isFinite(position.y) and @abs(position.x) <= 90;
        if (positioned) {
            const world_size = worldSize(frame.zoom);
            const center = mercator(frame.center_latitude, frame.center_longitude, world_size);
            var e = mercator(position.x, position.y, world_size);
            // The copy nearest the frame center: one copy is drawn.
            e[0] += world_size * @floor((center[0] - e[0]) / world_size + 0.5);
            placement[0] = @floatCast(e[0] - center[0]);
            placement[1] = @floatCast(e[1] - center[1]);
            if (space == world_space) placement[2] = @floatCast(pixelsPerMeter(position.x, world_size));
        }
    }
    const count = row[@intFromEnum(Lane.emission)][0];
    const particles = count > 0 and opacity > 0;
    const tinted = row[@intFromEnum(Lane.tint)][3] > 0;
    return .{ .row = row, .pool = poolSize(count, weather), .visible = positioned and (particles or tinted) };
}

// ---------------------------------------------------------------------------
// Test helpers, shared with emitter.zig's tests.
// ---------------------------------------------------------------------------

pub const testing = struct {
    /// Paint values in emitter definition order, as build_frame delivers
    /// them.
    pub const Paint = [properties.emitter_names.len]c.mln_plugin_property_value_v1;

    pub fn index(comptime name: []const u8) usize {
        return comptime blk: {
            for (properties.emitter_names, 0..) |candidate, i| {
                if (std.mem.eql(u8, candidate, name)) break :blk i;
            }
            @compileError("not an emitter property: " ++ name);
        };
    }

    /// Every property at its default, colors premultiplied as the host
    /// delivers them.
    pub fn defaults() Paint {
        var paint: Paint = undefined;
        for (properties.emitter_descriptors, 0..) |d, i| {
            paint[i] = .{ .struct_size = @sizeOf(c.mln_plugin_property_value_v1), .name = d.name, .value = d.default_value, .explicitly_set = 0 };
            if (d.type == c.MLN_PLUGIN_VALUE_COLOR) {
                const v = &paint[i].value.data.color_value;
                v.* = .{ .r = v.r * v.a, .g = v.g * v.a, .b = v.b * v.a, .a = v.a };
            }
        }
        return paint;
    }

    pub fn setFloat(paint: *Paint, comptime name: []const u8, v: f32) void {
        paint[index(name)].value.data.float_value = v;
    }

    pub fn setFloat2(paint: *Paint, comptime name: []const u8, x: f32, y: f32) void {
        paint[index(name)].value.data.float2_value = .{ .x = x, .y = y };
    }

    pub fn setPosition(paint: *Paint, latitude: f64, longitude: f64) void {
        paint[index("emitter-position")].value.data.double2_value = .{ .x = latitude, .y = longitude };
    }

    /// A straight-alpha color, premultiplied as the host delivers it.
    pub fn setColor(paint: *Paint, comptime name: []const u8, r: f32, g: f32, b: f32, a: f32) void {
        paint[index(name)].value.data.color_value = .{ .r = r * a, .g = g * a, .b = b * a, .a = a };
    }

    pub fn setEnum(paint: *Paint, comptime name: []const u8, comptime value: []const u8) void {
        _ = comptime valueIndex(name, value);
        paint[index(name)].value.data.string_value = properties.str(value);
    }

    /// Where the camera looks: zoom, center [lat, lon], pitch and bearing in
    /// degrees, viewport in logical pixels.
    pub const Camera = struct {
        zoom: f64,
        center: [2]f64,
        pitch: f64 = 0,
        bearing: f64 = 0,
        width: f64 = 800,
        height: f64 = 600,
        /// A top-down projection with no perspective and no eye, like
        /// location-indicator's test context: clip = (2 / width, -2 / height)
        /// times world pixels from the center.
        orthographic: bool = false,
    };

    const Mat4 = [16]f64;

    fn multiply(a: Mat4, b: Mat4) Mat4 {
        var out: Mat4 = undefined;
        for (0..4) |col| for (0..4) |row| {
            var sum: f64 = 0;
            for (0..4) |k| sum += a[k * 4 + row] * b[col * 4 + k];
            out[col * 4 + row] = sum;
        };
        return out;
    }

    fn columns(c0: [4]f64, c1: [4]f64, c2: [4]f64, c3: [4]f64) Mat4 {
        return c0 ++ c1 ++ c2 ++ c3;
    }

    fn scaling(x: f64, y: f64, z: f64) Mat4 {
        return columns(.{ x, 0, 0, 0 }, .{ 0, y, 0, 0 }, .{ 0, 0, z, 0 }, .{ 0, 0, 0, 1 });
    }

    fn translation(x: f64, y: f64, z: f64) Mat4 {
        return columns(.{ 1, 0, 0, 0 }, .{ 0, 1, 0, 0 }, .{ 0, 0, 1, 0 }, .{ x, y, z, 1 });
    }

    /// A MapLibre Native-like frame projection: perspective (36.87° vertical
    /// field of view) · flip y · camera distance · pitch · bearing · world
    /// pixels from the center, with z in meters scaled at the latitude of the
    /// camera's own ground position, as the host does.
    pub fn frame(camera: Camera) Frame {
        const fov: f64 = 0.6435011087932844;
        const distance = 0.5 * camera.height / @tan(fov / 2.0);
        const world_size = worldSize(camera.zoom);
        const center = mercator(camera.center[0], camera.center[1], world_size);
        var result: Frame = .{
            .zoom = camera.zoom,
            .center_latitude = camera.center[0],
            .center_longitude = camera.center[1],
            .pitch = camera.pitch * std.math.pi / 180,
            .camera_to_center_distance = @as(f32, @floatCast(distance)),
            .proj_matrix = undefined,
        };
        if (camera.orthographic) {
            result.proj_matrix = multiply(scaling(2 / camera.width, -2 / camera.height, 1), translation(-center[0], -center[1], 0));
            return result;
        }
        const f = 1 / @tan(fov / 2.0);
        const near = distance / 50;
        const far = distance * 20;
        const perspective = columns(
            .{ f / (camera.width / camera.height), 0, 0, 0 },
            .{ 0, f, 0, 0 },
            .{ 0, 0, (far + near) / (near - far), -1 },
            .{ 0, 0, 2 * far * near / (near - far), 0 },
        );
        const pitch = result.pitch;
        const pitched = columns(.{ 1, 0, 0, 0 }, .{ 0, @cos(pitch), @sin(pitch), 0 }, .{ 0, -@sin(pitch), @cos(pitch), 0 }, .{ 0, 0, 0, 1 });
        const angle = -camera.bearing * std.math.pi / 180;
        const turned = columns(.{ @cos(angle), @sin(angle), 0, 0 }, .{ -@sin(angle), @cos(angle), 0, 0 }, .{ 0, 0, 1, 0 }, .{ 0, 0, 0, 1 });
        const view = multiply(multiply(multiply(multiply(perspective, scaling(1, -1, 1)), translation(0, 0, -distance)), pitched), turned);
        // The eye's x and y do not depend on the z scale: find the camera's
        // ground latitude first, then scale z there.
        const eye = eyePosition(view).?;
        const eye_latitude = latitudeOf(center[1] + eye[1], world_size);
        result.proj_matrix = multiply(multiply(view, translation(-center[0], -center[1], 0)), scaling(1, 1, pixelsPerMeter(eye_latitude, world_size)));
        return result;
    }

    pub fn context(paint: *const Paint, f: Frame, time: f64) c.mln_plugin_frame_context_v1 {
        return .{
            .struct_size = @sizeOf(c.mln_plugin_frame_context_v1),
            .properties = paint,
            .property_count = paint.len,
            .time_seconds = time,
            .zoom = f.zoom,
            .center_latitude = f.center_latitude,
            .center_longitude = f.center_longitude,
            .bearing = 0,
            .pitch = f.pitch,
            .viewport_width = 800,
            .viewport_height = 600,
            .pixel_ratio = 2,
            .pixels_to_gl_units = .{ 2.0 / 800.0, -2.0 / 600.0 },
            .camera_to_center_distance = @floatCast(f.camera_to_center_distance),
            .project_state = null,
            .proj_matrix = f.proj_matrix,
            .project_mercator = null,
            .destination = null,
        };
    }
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

const expectEqual = std.testing.expectEqual;

fn rowLane(row: Row, comptime l: Lane) [4]f32 {
    return row[@intFromEnum(l)];
}

test "pool sizes hold the count ramp in powers of two, weather octaves in pairs" {
    const point = [_][2]f32{ .{ 0, 64 }, .{ -5, 64 }, .{ std.math.nan(f32), 64 }, .{ 1, 64 }, .{ 60, 64 }, .{ 61, 128 }, .{ 64, 128 }, .{ 600, 1024 }, .{ 1000, 2048 }, .{ 1024, 2048 }, .{ 15420, 16384 }, .{ 15421, 16384 }, .{ 20000, 16384 } };
    for (point) |case| try expectEqual(@as(u32, @intFromFloat(case[1])), poolSize(case[0], false));
    const weather = [_][2]f32{ .{ 0, 64 }, .{ 30, 64 }, .{ 31, 128 }, .{ 3500, 8192 }, .{ 7710, 16384 }, .{ 7711, 16384 }, .{ 8192, 16384 }, .{ std.math.inf(f32), 16384 } };
    for (weather) |case| try expectEqual(@as(u32, @intFromFloat(case[1])), poolSize(case[0], true));
}

/// particlePrefix in shaders/particle.glsl, in f32 as the GPU runs it.
fn shaderPrefix(target: f32, rank: f32, count: f32) f32 {
    const ramp = @max(1.0, 0.125 * count);
    return std.math.clamp((target - rank - 0.5) / ramp + 0.5, 0.0, 1.0) * std.math.clamp(2.0 * target / ramp, 0.0, 1.0);
}

test "the pool holds the whole count ramp for every count up to where it is capped" {
    // The ramp reaches furthest at the full count (a weather octave's target
    // is count x weight, at most the count), so the first rank past the pool
    // shows nothing there, and the last rank of the reach still shows.
    // Weather octaves take alternate particles, half the pool's ranks each.
    // The last count each cap holds is tight.
    for ([_]struct { weather: bool, octaves: u32, last: f32 }{ .{ .weather = false, .octaves = 1, .last = 15420 }, .{ .weather = true, .octaves = 2, .last = 7710 } }) |kind| {
        var n: u32 = 0;
        while (n <= 4 * @as(u32, @intFromFloat(max_count))) : (n += 1) {
            const count = 0.25 * @as(f32, @floatFromInt(n));
            const pool = poolSize(count, kind.weather);
            if (count > kind.last) {
                try expectEqual(max_pool, pool);
                continue;
            }
            const ranks = pool / kind.octaves;
            try std.testing.expect(ranks >= prefixRanks(count));
            try expectEqual(@as(f32, 0), shaderPrefix(count, @floatFromInt(ranks), count));
            if (count > 0) try std.testing.expect(shaderPrefix(count, @floatFromInt(prefixRanks(count) - 1), count) > 0);
        }
        try std.testing.expect(kind.octaves * prefixRanks(kind.last) <= max_pool);
        try std.testing.expect(kind.octaves * prefixRanks(kind.last + 1) > max_pool);
    }
    try expectEqual(@as(u32, 1088), prefixRanks(1024));
}

test "mercator and pixels per meter" {
    const world_size = worldSize(0);
    try expectEqual(@as(f64, 512), world_size);
    const origin = mercator(0, 0, world_size);
    try std.testing.expectApproxEqAbs(@as(f64, 256), origin[0], 1e-12);
    try std.testing.expectApproxEqAbs(@as(f64, 256), origin[1], 1e-12);
    // North is up (y decreases), and the Mercator limit is the world's top.
    try std.testing.expect(mercator(10, 0, world_size)[1] < 256);
    try std.testing.expectApproxEqAbs(@as(f64, 0), mercator(90, 0, world_size)[1], 1e-9);
    try std.testing.expectApproxEqAbs(@as(f64, 512), mercator(0, 180, world_size)[0], 1e-12);
    for ([_]f64{ -80, -16.5, 0, 37.77, 85 }) |latitude| try std.testing.expectApproxEqAbs(latitude, latitudeOf(mercator(latitude, 0, 1e6)[1], 1e6), 1e-9);
    // At the equator one pixel of zoom 0 is the circumference / 512 meters.
    try std.testing.expectApproxEqRel(512 / (2 * std.math.pi * earth_radius), pixelsPerMeter(0, world_size), 1e-15);
    try std.testing.expectApproxEqRel(2 * pixelsPerMeter(0, world_size), pixelsPerMeter(60, world_size), 1e-12);
}

test "the eye is the projection's center, and ppm is the host's at the camera latitude" {
    for ([_]f64{ 0, 30, 60 }) |pitch| {
        for ([_]f64{ 0, -35 }) |bearing| {
            const f = testing.frame(.{ .zoom = 15.3, .center = .{ 37.77, -122.42 }, .pitch = pitch, .bearing = bearing });
            const h = header(f);
            const world_size = worldSize(f.zoom);
            const center = mercator(f.center_latitude, f.center_longitude, world_size);
            const p = relativeProjection(f.proj_matrix, center);
            const eye = eyePosition(p).?;
            for ([_]usize{ 0, 1, 3 }) |r| {
                const clip = p[r] * eye[0] + p[4 + r] * eye[1] + p[8 + r] * eye[2] + p[12 + r];
                try std.testing.expect(@abs(clip) < 1e-6);
            }
            // The eye sits the camera distance from the center, pitch from
            // the vertical: straight up at pitch 0.
            const e = h[@intFromEnum(Header.eye)];
            const ppm = h[@intFromEnum(Header.view)][2];
            const ground = @sqrt(@as(f64, e[0]) * e[0] + @as(f64, e[1]) * e[1]);
            try std.testing.expectApproxEqAbs(f.camera_to_center_distance * @sin(f.pitch), ground, 1e-3);
            try std.testing.expectApproxEqRel(f.camera_to_center_distance * @cos(f.pitch), @as(f64, e[2]) * ppm, 1e-6);
            // ppm_cam is the Mercator ppm at the eye's ground latitude.
            try std.testing.expectApproxEqRel(pixelsPerMeter(latitudeOf(center[1] + eye[1], world_size), world_size), @as(f64, ppm), 1e-6);
            try expectEqual(@as(f32, @floatCast(f.pitch)), h[@intFromEnum(Header.view)][3]);
        }
    }
}

test "ppm_cam stays the host's through 90 degrees of pitch and past it" {
    // The host allows pitch up to 180 degrees (util::PITCH_MAX, setMaxPitch),
    // and the w row's cos(pitch) vanishes at 90.
    for ([_]f64{ 85, 89.95, 89.99, 90, 110 }) |pitch| {
        errdefer std.debug.print("pitch {d}\n", .{pitch});
        const f = testing.frame(.{ .zoom = 15, .center = .{ 37.77, -122.42 }, .pitch = pitch });
        const h = header(f);
        const world_size = worldSize(f.zoom);
        const center = mercator(f.center_latitude, f.center_longitude, world_size);
        const e = h[@intFromEnum(Header.eye)];
        const ppm = h[@intFromEnum(Header.view)][2];
        try std.testing.expectApproxEqRel(pixelsPerMeter(latitudeOf(center[1] + e[1], world_size), world_size), @as(f64, ppm), 1e-6);
        // The eye's height: the camera distance times cos(pitch), in pixels.
        try std.testing.expectApproxEqAbs(f.camera_to_center_distance * @cos(f.pitch), @as(f64, e[2]) * ppm, 1e-3);
    }
}

test "P_rel projects world pixels around the center like proj_matrix does absolute ones" {
    const f = testing.frame(.{ .zoom = 19, .center = .{ 37.77, -122.42 }, .pitch = 55, .bearing = 20 });
    const h = header(f);
    const world_size = worldSize(f.zoom);
    const center = mercator(f.center_latitude, f.center_longitude, world_size);
    for ([_][3]f64{ .{ 0, 0, 0 }, .{ 120.25, -40.5, 0 }, .{ -300, 200, 25 } }) |offset| {
        for (0..4) |r| {
            const absolute = f.proj_matrix[r] * (center[0] + offset[0]) + f.proj_matrix[4 + r] * (center[1] + offset[1]) + f.proj_matrix[8 + r] * offset[2] + f.proj_matrix[12 + r];
            var relative: f64 = 0;
            for (0..3) |k| relative += @as(f64, h[k][r]) * offset[k];
            relative += h[3][r];
            try std.testing.expectApproxEqAbs(absolute, relative, 1e-4 * @max(1, @abs(absolute)));
        }
    }
}

test "weather pools cross an integer zoom without a pop" {
    // Just below and above zoom 14, the pool anchored at 14 keeps its scale
    // and phase; the other re-anchors from 13 to 15 while its weight is 0.
    const below = weatherPools(14 - 1e-9, 1000, 2000, 300, 900);
    const above = weatherPools(14 + 1e-9, 1000, 2000, 300, 900);
    try std.testing.expectApproxEqAbs(@as(f64, 1), below.pool0[3], 1e-8);
    try std.testing.expectApproxEqAbs(@as(f64, 1), above.pool0[3], 1e-8);
    for (0..3) |k| try std.testing.expectApproxEqAbs(below.pool0[k], above.pool0[k], 1e-8);
    try std.testing.expectApproxEqAbs(@as(f64, 1), below.weights[0], 1e-8);
    try std.testing.expectApproxEqAbs(@as(f64, 1), above.weights[0], 1e-8);
    try std.testing.expectApproxEqAbs(@as(f64, 0), below.weights[1], 1e-8);
    try std.testing.expectApproxEqAbs(@as(f64, 0), above.weights[1], 1e-8);
    try std.testing.expectApproxEqAbs(@as(f64, 2), below.pool1[3], 1e-8);
    try std.testing.expectApproxEqAbs(@as(f64, 0.5), above.pool1[3], 1e-8);
    // Midway both pools weigh half, and the weights always sum to 1.
    const middle = weatherPools(14.5, 0, 0, 0, 900);
    try expectEqual(@as(f64, 0.5), middle.weights[0]);
    try expectEqual(@as(f64, 0.5), middle.weights[1]);
    // A pan by one box at the pool's anchor zoom leaves its phase unchanged.
    const moved = weatherPools(14.25, 1000 + 900 * @exp2(0.25), 2000, 300, 900);
    const here = weatherPools(14.25, 1000, 2000, 300, 900);
    try std.testing.expectApproxEqAbs(here.pool0[0], moved.pool0[0], 1e-9);
}

test "the row: premultiplied colors times opacity, end painted over, identity and clamps" {
    var paint = testing.defaults();
    testing.setColor(&paint, "particle-color", 1, 0.8, 0.4, 0.5);
    testing.setColor(&paint, "particle-color-end", 0.2, 0.4, 1, 0.25);
    testing.setFloat(&paint, "particle-opacity", 0.8);
    testing.setEnum(&paint, "emitter-kind", "circle");
    testing.setEnum(&paint, "particle-space", "screen");
    testing.setEnum(&paint, "particle-shape", "spark");
    testing.setFloat(&paint, "particle-seed", 41.75);
    testing.setFloat(&paint, "emitter-vignette", 1.5);
    testing.setColor(&paint, "emitter-screen-tint", 0, 0.5, 1, 0.5);
    testing.setFloat2(&paint, "particle-lifetime", 0.7, 1.3);
    testing.setFloat(&paint, "particle-scale", 2);
    const f = testing.frame(.{ .zoom = 16, .center = .{ 37.77, -122.42 }, .pitch = 40 });
    testing.setPosition(&paint, 37.77, -122.42);
    const e = try pack(&paint, f);
    try std.testing.expect(e.visible);
    // The default 256 particles reach rank 272 of the ramp.
    try expectEqual(@as(u32, 512), e.pool);
    const color = [4]f64{ 0.5, 0.4, 0.2, 0.5 };
    const end = [4]f64{ 0.05, 0.1, 0.25, 0.25 };
    for (0..4) |k| {
        try std.testing.expectApproxEqAbs(color[k] * 0.8, rowLane(e.row, .color)[k], 1e-6);
        try std.testing.expectApproxEqAbs((end[k] + color[k] * 0.75) * 0.8, rowLane(e.row, .color_end)[k], 1e-6);
    }
    // seed 41 + 65536 · (spark 3 + 16 · screen 0 + 64 · circle 1)
    try expectEqual(@as(f32, 41 + 65536 * (3 + 64)), rowLane(e.row, .emission)[3]);
    try expectEqual([4]f32{ 256, 0, 1, rowLane(e.row, .emission)[3] }, rowLane(e.row, .emission));
    try expectEqual([4]f32{ 0.7, 1.3, 0, 0 }, rowLane(e.row, .timing));
    try expectEqual([4]f32{ 0, 0.25, 0.5, 0.5 }, rowLane(e.row, .tint));
    try expectEqual([4]f32{ 1, 0, 0, 0 }, rowLane(e.row, .extra));
    // At the center: no offset; not world space: ppm_e 1.
    try expectEqual([4]f32{ 0, 0, 1, 2 }, rowLane(e.row, .placement));
    // Raw lanes carry spec defaults untouched.
    try expectEqual([4]f32{ 20, 40, 0, 90 }, rowLane(e.row, .launch));
    try expectEqual([4]f32{ 6, 10, 1, 0 }, rowLane(e.row, .size));
}

test "the row: the emitter's nearest copy, and meters in world space" {
    var paint = testing.defaults();
    testing.setEnum(&paint, "particle-space", "world");
    // The frame center is unwrapped past the antimeridian; the emitter
    // just west of it sits in the copy one world east.
    const f = testing.frame(.{ .zoom = 12, .center = .{ -16.5, 180.25 }, .pitch = 30 });
    testing.setPosition(&paint, -16.51, -179.8);
    const e = try pack(&paint, f);
    const world_size = worldSize(12);
    const placement = rowLane(e.row, .placement);
    // -179.8 is 180.2 in the center's copy: 0.05 degrees west, a little south.
    try std.testing.expectApproxEqAbs(-0.05 / 360.0 * world_size, placement[0], 1e-3);
    try std.testing.expect(placement[1] > 50 and placement[1] < 70);
    try std.testing.expectApproxEqRel(pixelsPerMeter(-16.51, world_size), placement[2], 1e-6);
    // Every copy of the same place packs the same offset.
    for ([_]f64{ 180.2, 180.2 - 720, -179.8 + 1080 }) |longitude| {
        testing.setPosition(&paint, -16.51, longitude);
        const other = rowLane((try pack(&paint, f)).row, .placement);
        for (0..3) |k| try std.testing.expectApproxEqAbs(placement[k], other[k], 1e-3);
    }
}

test "nothing to draw and unusable positions give an invisible emitter" {
    const f = testing.frame(.{ .zoom = 14, .center = .{ 0, 0 } });
    var paint = testing.defaults();
    try std.testing.expect((try pack(&paint, f)).visible);
    testing.setFloat(&paint, "particle-count", 0);
    try std.testing.expect(!(try pack(&paint, f)).visible);
    // A tint alone still draws.
    testing.setColor(&paint, "emitter-screen-tint", 0, 0, 0, 0.3);
    try std.testing.expect((try pack(&paint, f)).visible);
    testing.setColor(&paint, "emitter-screen-tint", 0, 0, 0, 0);
    testing.setFloat(&paint, "particle-count", 100);
    testing.setFloat(&paint, "particle-opacity", 0);
    try std.testing.expect(!(try pack(&paint, f)).visible);
    testing.setFloat(&paint, "particle-opacity", 1);
    testing.setPosition(&paint, 91, 0);
    try std.testing.expect(!(try pack(&paint, f)).visible);
    testing.setPosition(&paint, 0, std.math.inf(f64));
    try std.testing.expect(!(try pack(&paint, f)).visible);
    // Weather ignores the position.
    testing.setEnum(&paint, "emitter-kind", "weather");
    const weather = try pack(&paint, f);
    try std.testing.expect(weather.visible);
    try expectEqual([4]f32{ 0, 0, 1, 1 }, rowLane(weather.row, .placement));
    // Wrong arity, value types or struct sizes are rejected.
    try std.testing.expectError(error.PropertyCount, pack(paint[0..34], f));
    const count = testing.index("particle-count");
    paint[count].struct_size -= 1;
    try std.testing.expectError(error.StructSize, pack(&paint, f));
    paint[count].struct_size += 1;
    paint[count].value.struct_size -= 1;
    try std.testing.expectError(error.StructSize, pack(&paint, f));
    paint[count].value.struct_size += 1;
    paint[count].value.type = c.MLN_PLUGIN_VALUE_FLOAT2;
    try std.testing.expectError(error.ValueType, pack(&paint, f));
}

test "an unknown enum string packs the default" {
    const f = testing.frame(.{ .zoom = 14, .center = .{ 0, 0 } });
    var paint = testing.defaults();
    paint[testing.index("particle-shape")].value.data.string_value = properties.str("hexagon");
    // glow (1) + 16 · ground (1) + 64 · point (0)
    try expectEqual(@as(f32, 65536 * 17), rowLane((try pack(&paint, f)).row, .emission)[3]);
}

// ---------------------------------------------------------------------------
// The shared fixture (../../fixtures/record.json).
// ---------------------------------------------------------------------------

/// The cases record.json is generated from. Paint overrides are JSON with
/// straight-alpha colors; the fixture stores every property as the host
/// delivers it (f32, colors premultiplied).
const fixture_cases = [_]struct { name: []const u8, camera: testing.Camera, paint: []const u8 }{
    .{
        .name = "point in ground space, defaults, looking straight down",
        .camera = .{ .zoom = 14, .center = .{ 37.7544, -122.4477 } },
        .paint =
        \\{ "emitter-position": [37.7544, -122.4477] }
        ,
    },
    .{
        .name = "circle in world space off center, pitched and turned camera, colors over life",
        .camera = .{ .zoom = 18.5, .center = .{ 37.763, -122.5107 }, .pitch = 60, .bearing = 30 },
        .paint =
        \\{ "emitter-kind": "circle", "emitter-position": [37.76312, -122.51055], "emitter-radius": 5, "emitter-height": [0, 1],
        \\  "particle-space": "world", "particle-scale": 1.5, "particle-count": 600, "particle-lifetime": [0.7, 1.3], "particle-seed": 42.7,
        \\  "particle-speed": [2, 5], "particle-spread": [20, 0], "particle-gravity": -6, "particle-drag": 1.2, "particle-wind": [1, 0.3],
        \\  "particle-wander": [1.2, 1.6], "particle-size": [4, 8], "particle-growth": 0.3, "particle-size-clamp": [2, 200],
        \\  "particle-color": [1, 0.8235, 0.4784, 1], "particle-color-end": [1, 0.2314, 0.1216, 0.9], "particle-color-variation": [10, 0],
        \\  "particle-opacity": 0.8, "particle-fade": [0.06, 0.45], "particle-additive": [1, 0.4], "particle-twinkle": [0.3, 8] }
        ,
    },
    .{
        .name = "screen-space bursts with a tint, vignette past its maximum",
        .camera = .{ .zoom = 15.4, .center = .{ 37.8078, -122.4235 }, .pitch = 30, .bearing = -15 },
        .paint =
        \\{ "emitter-position": [37.8071, -122.4242], "particle-space": "screen", "particle-count": 2400,
        \\  "particle-burst-groups": 4, "particle-explosiveness": 1, "particle-burst-interval": [2.8, 0.9], "particle-lifetime": [1.8, 2.6],
        \\  "particle-direction": [45, 10], "particle-spread": [180, 0], "particle-speed": [52, 68], "particle-spin": [-90, 90],
        \\  "particle-shape": "spark", "particle-stretch": 0.045, "particle-color": [1, 0.302, 0.4275, 1],
        \\  "particle-color-end": [1, 0.8235, 0.549, 0.6], "particle-color-variation": [12, 180],
        \\  "emitter-screen-tint": [0, 0.0196, 0.0784, 0.35], "emitter-vignette": 1.5 }
        ,
    },
    .{
        .name = "weather just below an integer zoom",
        .camera = .{ .zoom = 13.999, .center = .{ 37.7544, -122.4477 }, .pitch = 50, .bearing = -20 },
        .paint =
        \\{ "emitter-kind": "weather", "particle-count": 3500, "particle-lifetime": [6, 10], "particle-direction": [0, -90],
        \\  "particle-spread": [25, 0], "particle-speed": [35, 80], "particle-wind": [20, 8], "particle-wander": [16, 0.3],
        \\  "particle-spin": [-90, 90], "particle-shape": "flake", "particle-size": [2.5, 5], "particle-size-clamp": [1.2, 14],
        \\  "particle-color": [1, 1, 1, 0.92], "particle-fade": [0.25, 0.25], "particle-additive": [0.1, 0.1],
        \\  "emitter-center-thinning": 0.4, "emitter-screen-tint": [0.8824, 0.9098, 0.9608, 0.18], "emitter-vignette": 0.6 }
        ,
    },
    .{
        .name = "weather just above an integer zoom, position ignored",
        .camera = .{ .zoom = 14.001, .center = .{ 37.7544, -122.4477 }, .pitch = 50, .bearing = -20 },
        .paint =
        \\{ "emitter-kind": "weather", "emitter-position": [95, 0], "particle-count": 3500, "particle-lifetime": [6, 10],
        \\  "particle-direction": [0, -90], "particle-spread": [25, 0], "particle-speed": [35, 80], "particle-shape": "flake" }
        ,
    },
    .{
        .name = "antimeridian: unwrapped center, the emitter's nearest copy",
        .camera = .{ .zoom = 12, .center = .{ -16.5, 180.25 }, .pitch = 20, .bearing = 90 },
        .paint =
        \\{ "emitter-kind": "circle", "emitter-position": [-16.51, -179.8], "emitter-radius": 40, "particle-count": 64 }
        ,
    },
    .{
        .name = "tint only: no particles, the smallest pool",
        .camera = .{ .zoom = 16, .center = .{ 37.7684, -122.4861 }, .pitch = 45 },
        .paint =
        \\{ "emitter-position": [37.7684, -122.4861], "particle-count": 0, "emitter-screen-tint": [0.0157, 0.0314, 0.1098, 0.45] }
        ,
    },
    .{
        .name = "nothing to draw: no particles and no tint",
        .camera = .{ .zoom = 16, .center = .{ 37.7684, -122.4861 } },
        .paint =
        \\{ "emitter-position": [37.7684, -122.4861], "particle-count": 0 }
        ,
    },
    .{
        .name = "unusable position",
        .camera = .{ .zoom = 16, .center = .{ 37.7684, -122.4861 } },
        .paint =
        \\{ "emitter-position": [91, 0] }
        ,
    },
    .{
        .name = "orthographic projection: no perspective, no eye",
        .camera = .{ .zoom = 2, .center = .{ 10, 20 }, .orthographic = true },
        .paint =
        \\{ "emitter-position": [12, 25], "particle-count": 16384 }
        ,
    },
};

fn jsonNumber(v: std.json.Value) !f64 {
    return switch (v) {
        .integer => |i| @floatFromInt(i),
        .float => |f| f,
        else => error.NotANumber,
    };
}

fn jsonF32(v: std.json.Value) !f32 {
    return @floatCast(try jsonNumber(v));
}

/// Sets one property from JSON: a number, [x, y] (float2 or [lat, lon]),
/// [r, g, b, a] or an enum string. `premultiply` premultiplies colors
/// given straight.
fn setJson(paint: *testing.Paint, name: []const u8, v: std.json.Value, premultiply: bool) !void {
    inline for (properties.emitter_names, 0..) |candidate, i| {
        if (std.mem.eql(u8, candidate, name)) {
            const property = comptime properties.find(candidate);
            const data = &paint[i].value.data;
            switch (property.type) {
                .float => data.float_value = try jsonF32(v),
                .float2 => data.float2_value = .{ .x = try jsonF32(v.array.items[0]), .y = try jsonF32(v.array.items[1]) },
                .double2 => data.double2_value = .{ .x = try jsonNumber(v.array.items[0]), .y = try jsonNumber(v.array.items[1]) },
                .color => {
                    const a = try jsonF32(v.array.items[3]);
                    const k: f32 = if (premultiply) a else 1;
                    data.color_value = .{ .r = try jsonF32(v.array.items[0]) * k, .g = try jsonF32(v.array.items[1]) * k, .b = try jsonF32(v.array.items[2]) * k, .a = a };
                },
                .enumeration => {
                    // Point at the static value, so the paint outlives the JSON.
                    inline for (property.values) |value| {
                        if (std.mem.eql(u8, value, v.string)) {
                            data.string_value = properties.str(value);
                            return;
                        }
                    }
                    return error.UnknownEnumValue;
                },
            }
            return;
        }
    }
    return error.UnknownProperty;
}

/// A fixture case's paint: the defaults with its JSON overrides, colors
/// premultiplied as the host delivers them.
fn casePaint(allocator: std.mem.Allocator, overrides_json: []const u8) !testing.Paint {
    var paint = testing.defaults();
    var overrides = try std.json.parseFromSlice(std.json.Value, allocator, overrides_json, .{});
    defer overrides.deinit();
    for (overrides.value.object.keys(), overrides.value.object.values()) |name, v| try setJson(&paint, name, v, true);
    return paint;
}

/// Every property of `actual` holds exactly the value of `expected`.
fn expectPaint(expected: *const testing.Paint, actual: *const testing.Paint) !void {
    inline for (properties.emitter_names, 0..) |name, i| {
        errdefer std.debug.print("paint property {s}\n", .{name});
        const property = comptime properties.find(name);
        const a = expected[i].value.data;
        const b = actual[i].value.data;
        switch (property.type) {
            .float => try expectEqual(a.float_value, b.float_value),
            .float2 => try expectEqual(a.float2_value, b.float2_value),
            .double2 => try expectEqual(a.double2_value, b.double2_value),
            .color => try expectEqual(a.color_value, b.color_value),
            .enumeration => try std.testing.expectEqualStrings(a.string_value.data[0..a.string_value.size], b.string_value.data[0..b.string_value.size]),
        }
    }
}

fn writeVec(jw: *std.json.Stringify, values: []const f32) !void {
    try jw.beginArray();
    for (values) |v| try jw.write(@as(f64, v));
    try jw.endArray();
}

fn writeCase(jw: *std.json.Stringify, name: []const u8, f: Frame, paint: *const testing.Paint) !void {
    try jw.beginObject();
    try jw.objectField("name");
    try jw.write(name);
    try jw.objectField("frame");
    try jw.beginObject();
    try jw.objectField("zoom");
    try jw.write(f.zoom);
    try jw.objectField("center");
    try jw.write([2]f64{ f.center_latitude, f.center_longitude });
    try jw.objectField("pitch");
    try jw.write(f.pitch);
    try jw.objectField("cameraToCenterDistance");
    try jw.write(f.camera_to_center_distance);
    try jw.objectField("projMatrix");
    try jw.write(f.proj_matrix);
    try jw.endObject();
    try jw.objectField("paint");
    try jw.beginObject();
    inline for (properties.emitter_names, 0..) |name_i, i| {
        const property = comptime properties.find(name_i);
        const data = paint[i].value.data;
        try jw.objectField(name_i);
        switch (property.type) {
            .float => try jw.write(@as(f64, data.float_value)),
            .float2 => try writeVec(jw, &.{ data.float2_value.x, data.float2_value.y }),
            .double2 => try jw.write([2]f64{ data.double2_value.x, data.double2_value.y }),
            .color => try writeVec(jw, &.{ data.color_value.r, data.color_value.g, data.color_value.b, data.color_value.a }),
            .enumeration => try jw.write(data.string_value.data[0..data.string_value.size]),
        }
    }
    try jw.endObject();
    const e = try pack(paint, f);
    const h = header(f);
    try jw.objectField("expected");
    try jw.beginObject();
    try jw.objectField("visible");
    try jw.write(e.visible);
    try jw.objectField("poolSize");
    try jw.write(e.pool);
    try jw.objectField("header");
    try jw.beginObject();
    try jw.objectField("pRel");
    try jw.beginArray();
    for (h[0..4]) |column| try writeVec(jw, &column);
    try jw.endArray();
    const view = h[@intFromEnum(Header.view)];
    try jw.objectField("ppmCam");
    try jw.write(@as(f64, view[2]));
    try jw.objectField("pitch");
    try jw.write(@as(f64, view[3]));
    inline for (.{ .{ "eye", Header.eye }, .{ "pool0", Header.pool0 }, .{ "pool1", Header.pool1 }, .{ "weights", Header.weights } }) |field| {
        try jw.objectField(field[0]);
        try writeVec(jw, &h[@intFromEnum(field[1])]);
    }
    try jw.endObject();
    try jw.objectField("row");
    if (e.visible) {
        try jw.beginArray();
        for (e.row) |vec| try writeVec(jw, &vec);
        try jw.endArray();
    } else try jw.write(null);
    try jw.endObject();
    try jw.endObject();
}

const fixture_comment = "Inputs and outputs of native/src/record.zig, the emitter's CPU half. frame: the build_frame context fields it reads (zoom, center [lat, lon] unwrapped, pitch in radians, camera-to-center distance, proj_matrix column-major, z in meters). paint: all 35 particle-emitter properties in definition order as MapLibre Native delivers them: f32 numbers, [x, y] for float2 and [lat, lon] for emitter-position, premultiplied [r, g, b, a] colors, enum strings. expected.header: the header parts build_frame writes (P_rel columns, ppm at the camera, pitch, eye (x, y px from the center, z m, box px), the two weather pools and weights; the pools come from the stored f32 eye and ppmCam). expected.row: the 15-vec4 table row, null when nothing is drawn. Frame values are f64; paint and expected values are f32, compared exactly. Regenerate with UPDATE_FIXTURES=1 zig build test in native/, then dprint fmt this file.";

fn generateFixture(allocator: std.mem.Allocator) ![]u8 {
    var out: std.Io.Writer.Allocating = .init(allocator);
    errdefer out.deinit();
    var jw: std.json.Stringify = .{ .writer = &out.writer, .options = .{ .whitespace = .indent_2 } };
    try jw.beginObject();
    try jw.objectField("$comment");
    try jw.write(fixture_comment);
    try jw.objectField("cases");
    try jw.beginArray();
    for (fixture_cases) |case| {
        const paint = try casePaint(allocator, case.paint);
        try writeCase(&jw, case.name, testing.frame(case.camera), &paint);
    }
    try jw.endArray();
    try jw.endObject();
    try out.writer.writeByte('\n');
    return out.toOwnedSlice();
}

fn expectVec(expected: std.json.Value, actual: []const f32) !void {
    try expectEqual(actual.len, expected.array.items.len);
    for (expected.array.items, actual) |e, a| try expectEqual(try jsonF32(e), a);
}

test "record.json: every case's frame and paint give its header and row" {
    const allocator = std.testing.allocator;
    if (std.c.getenv("UPDATE_FIXTURES")) |_| {
        const text = try generateFixture(allocator);
        defer allocator.free(text);
        // Run from native/, where mise and `zig build` run.
        // Silent: the build runner fails a test that writes to stderr.
        try std.Io.Dir.cwd().writeFile(std.testing.io, .{ .sub_path = "../fixtures/record.json", .data = text });
        return;
    }
    var parsed = try std.json.parseFromSlice(std.json.Value, allocator, build_options.fixture_record, .{});
    defer parsed.deinit();
    const cases = parsed.value.object.get("cases").?.array.items;
    // The fixture is generated from fixture_cases: a stale one (another
    // case, camera, paint override or spec default) fails here.
    try expectEqual(fixture_cases.len, cases.len);
    for (cases, fixture_cases) |case, source| {
        const name = case.object.get("name").?.string;
        errdefer std.debug.print("record.json case: {s}\n", .{name});
        try std.testing.expectEqualStrings(source.name, name);
        const frame_json = case.object.get("frame").?.object;
        const center = frame_json.get("center").?.array.items;
        var f: Frame = .{
            .zoom = try jsonNumber(frame_json.get("zoom").?),
            .center_latitude = try jsonNumber(center[0]),
            .center_longitude = try jsonNumber(center[1]),
            .pitch = try jsonNumber(frame_json.get("pitch").?),
            .camera_to_center_distance = try jsonNumber(frame_json.get("cameraToCenterDistance").?),
            .proj_matrix = undefined,
        };
        for (frame_json.get("projMatrix").?.array.items, 0..) |v, i| f.proj_matrix[i] = try jsonNumber(v);
        try std.testing.expect(f.valid());
        try expectEqual(testing.frame(source.camera), f);

        var paint = testing.defaults();
        const paint_json = case.object.get("paint").?.object;
        try expectEqual(properties.emitter_names.len, paint_json.count());
        for (paint_json.keys(), paint_json.values(), properties.emitter_names) |key, v, expected_name| {
            try std.testing.expectEqualStrings(expected_name, key);
            try setJson(&paint, key, v, false);
        }
        try expectPaint(&try casePaint(allocator, source.paint), &paint);

        const expected = case.object.get("expected").?.object;
        const e = try pack(&paint, f);
        try expectEqual(expected.get("visible").?.bool, e.visible);
        try expectEqual(@as(u32, @intFromFloat(try jsonNumber(expected.get("poolSize").?))), e.pool);
        const h = header(f);
        const expected_header = expected.get("header").?.object;
        for (expected_header.get("pRel").?.array.items, 0..) |column, i| try expectVec(column, &h[i]);
        try expectEqual(try jsonF32(expected_header.get("ppmCam").?), h[@intFromEnum(Header.view)][2]);
        try expectEqual(try jsonF32(expected_header.get("pitch").?), h[@intFromEnum(Header.view)][3]);
        try expectVec(expected_header.get("eye").?, &h[@intFromEnum(Header.eye)]);
        try expectVec(expected_header.get("pool0").?, &h[@intFromEnum(Header.pool0)]);
        try expectVec(expected_header.get("pool1").?, &h[@intFromEnum(Header.pool1)]);
        try expectVec(expected_header.get("weights").?, &h[@intFromEnum(Header.weights)]);
        switch (expected.get("row").?) {
            .null => try std.testing.expect(!e.visible),
            .array => |vecs| {
                try expectEqual(e.row.len, vecs.items.len);
                for (vecs.items, e.row) |vec, actual| try expectVec(vec, &actual);
            },
            else => return error.MalformedFixture,
        }
    }
}
