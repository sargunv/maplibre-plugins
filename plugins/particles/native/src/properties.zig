//! Paint properties of both particle layer types, and the two host transport
//! layouts they travel through: the emitter's frame-table rows and the
//! features type's host bindings. Keep in sync with ../../spec.json; the tests
//! here and in plugin.zig hold every table to it, and shaders.zig generates
//! the shader side of both layouts from these tables.

const std = @import("std");
const c = @import("maplibre_native_c");

pub fn str(comptime text: []const u8) c.mln_plugin_string {
    return .{ .data = text.ptr, .size = text.len };
}

// ---------------------------------------------------------------------------
// Output buckets. The host allocates the bucket that build_frame and
// finish_layout fill and declares its size in struct_size: the host's own
// mln_plugin_bucket_v1, which may be shorter (an older header) or longer (a
// newer one) than the header this plugin was built with. Receivers must check
// struct_size before accessing other fields (plugin_api.h), so a callback
// refuses a bucket too short for the fields it writes, writes nothing past
// the host's size, and leaves struct_size as the host set it.
// ---------------------------------------------------------------------------

/// The bytes a bucket must hold to take every field up to and including
/// `last`.
pub fn bucketSize(comptime last: []const u8) u32 {
    return @offsetOf(c.mln_plugin_bucket_v1, last) + @sizeOf(@FieldType(c.mln_plugin_bucket_v1, last));
}

/// Zeroes the host's bucket after struct_size, up to the smaller of its
/// declared size and the bucket this plugin knows.
pub fn clearBucket(bucket: *c.mln_plugin_bucket_v1) void {
    const start = @sizeOf(@FieldType(c.mln_plugin_bucket_v1, "struct_size"));
    const end = @min(bucket.struct_size, @sizeOf(c.mln_plugin_bucket_v1));
    if (end > start) @memset(std.mem.asBytes(bucket)[start..end], 0);
}

/// Tests: a host's bucket storage with `size` declared, room past the v1
/// bucket this plugin knows, and every other byte a marker.
pub const HostBucket = struct {
    bytes: [@sizeOf(c.mln_plugin_bucket_v1) + 64]u8 align(@alignOf(c.mln_plugin_bucket_v1)) = @splat(0xA5),

    pub fn init(size: u32) HostBucket {
        var host: HostBucket = .{};
        host.bucket().struct_size = size;
        return host;
    }

    pub fn bucket(host: *HostBucket) *c.mln_plugin_bucket_v1 {
        return @ptrCast(&host.bytes);
    }

    /// struct_size is still `declared`, and no byte from `from` on was written.
    pub fn expectUntouchedFrom(host: *HostBucket, declared: u32, from: usize) !void {
        try std.testing.expectEqual(declared, host.bucket().struct_size);
        for (host.bytes[from..]) |byte| try std.testing.expectEqual(@as(u8, 0xA5), byte);
    }

    /// Written at most up to the smaller of the declared size and the v1
    /// bucket this plugin knows.
    pub fn expectWrittenWithin(host: *HostBucket, declared: u32) !void {
        try host.expectUntouchedFrom(declared, @min(declared, @sizeOf(c.mln_plugin_bucket_v1)));
    }
};

// ---------------------------------------------------------------------------
// Canonical paint table (spec.json `paint`, in canonical order).
// ---------------------------------------------------------------------------

pub const ValueType = enum { float, float2, color, enumeration, double2 };

/// spec.json `expressions`: "constant" allows literals only, "camera" also
/// zoom expressions. Data-driven properties are listed per layer type.
pub const Expression = enum { constant, camera };

pub const Property = struct {
    name: []const u8,
    type: ValueType,
    /// float: {v}; float2 and double2: {x, y}; color: straight-alpha rgba;
    /// enum: {index into `values`}.
    default: [4]f64,
    minimum: ?f32 = null,
    maximum: ?f32 = null,
    values: []const []const u8 = &.{},
    transition: bool = true,
    expressions: Expression = .camera,

    /// Components the value occupies in a shader vector.
    pub fn width(comptime self: Property) u3 {
        return switch (self.type) {
            .float, .enumeration => 1,
            .float2, .double2 => 2,
            .color => 4,
        };
    }
};

fn v1(x: f64) [4]f64 {
    return .{ x, 0, 0, 0 };
}
fn v2(x: f64, y: f64) [4]f64 {
    return .{ x, y, 0, 0 };
}

pub const shapes = [_][]const u8{ "circle", "glow", "star", "spark", "streak", "flake", "ring", "ripple", "smoke", "square" };

pub const canonical = [_]Property{
    .{ .name = "emitter-kind", .type = .enumeration, .default = v1(0), .values = &.{ "point", "circle", "weather" }, .transition = false, .expressions = .constant },
    .{ .name = "emitter-position", .type = .double2, .default = v2(0, 0) },
    .{ .name = "emitter-radius", .type = .float, .default = v1(0), .minimum = 0 },
    .{ .name = "emitter-height", .type = .float2, .default = v2(0, 0) },
    .{ .name = "particle-space", .type = .enumeration, .default = v1(1), .values = &.{ "screen", "ground", "world" }, .transition = false, .expressions = .constant },
    .{ .name = "particle-scale", .type = .float, .default = v1(1), .minimum = 0 },
    .{ .name = "particle-count", .type = .float, .default = v1(256), .minimum = 0, .maximum = 16384 },
    .{ .name = "particle-density", .type = .float, .default = v1(8), .minimum = 0, .maximum = 100 },
    .{ .name = "particle-lifetime", .type = .float2, .default = v2(1, 2), .transition = false, .expressions = .constant },
    .{ .name = "particle-explosiveness", .type = .float, .default = v1(0), .minimum = 0, .maximum = 1, .transition = false, .expressions = .constant },
    .{ .name = "particle-burst-interval", .type = .float2, .default = v2(0, 0), .transition = false, .expressions = .constant },
    .{ .name = "particle-burst-groups", .type = .float, .default = v1(1), .minimum = 1, .maximum = 16, .transition = false, .expressions = .constant },
    .{ .name = "particle-seed", .type = .float, .default = v1(0), .minimum = 0, .maximum = 65535, .transition = false, .expressions = .constant },
    .{ .name = "particle-speed", .type = .float2, .default = v2(20, 40) },
    .{ .name = "particle-direction", .type = .float2, .default = v2(0, 90) },
    .{ .name = "particle-spread", .type = .float2, .default = v2(15, 0) },
    .{ .name = "particle-gravity", .type = .float, .default = v1(0) },
    .{ .name = "particle-drag", .type = .float, .default = v1(0), .minimum = 0, .maximum = 50 },
    .{ .name = "particle-wind", .type = .float2, .default = v2(0, 0) },
    .{ .name = "particle-wander", .type = .float2, .default = v2(0, 0.5) },
    .{ .name = "particle-spin", .type = .float2, .default = v2(0, 0) },
    .{ .name = "particle-shape", .type = .enumeration, .default = v1(1), .values = &shapes, .transition = false },
    .{ .name = "particle-size", .type = .float2, .default = v2(6, 10) },
    .{ .name = "particle-growth", .type = .float, .default = v1(1), .minimum = 0, .maximum = 16 },
    .{ .name = "particle-size-clamp", .type = .float2, .default = v2(0.5, 128) },
    .{ .name = "particle-stretch", .type = .float, .default = v1(0), .minimum = 0, .maximum = 2 },
    .{ .name = "particle-color", .type = .color, .default = .{ 1, 0.9, 0.6, 1 } },
    .{ .name = "particle-color-end", .type = .color, .default = .{ 0, 0, 0, 0 } },
    .{ .name = "particle-color-variation", .type = .float2, .default = v2(0, 0) },
    .{ .name = "particle-opacity", .type = .float, .default = v1(1), .minimum = 0, .maximum = 1 },
    .{ .name = "particle-fade", .type = .float2, .default = v2(0.1, 0.3) },
    .{ .name = "particle-additive", .type = .float2, .default = v2(0, 0) },
    .{ .name = "particle-twinkle", .type = .float2, .default = v2(0, 2) },
    .{ .name = "emitter-center-thinning", .type = .float, .default = v1(0), .minimum = 0, .maximum = 1 },
    .{ .name = "emitter-screen-tint", .type = .color, .default = .{ 0, 0, 0, 0 } },
    .{ .name = "emitter-vignette", .type = .float, .default = v1(0), .minimum = 0, .maximum = 1 },
};

pub fn find(comptime name: []const u8) Property {
    return comptime blk: {
        @setEvalBranchQuota(100_000);
        for (canonical) |property| {
            if (std.mem.eql(u8, property.name, name)) break :blk property;
        }
        @compileError("unknown paint property " ++ name);
    };
}

pub fn contains(comptime names: []const []const u8, comptime name: []const u8) bool {
    return comptime blk: {
        @setEvalBranchQuota(100_000);
        for (names) |candidate| {
            if (std.mem.eql(u8, candidate, name)) break :blk true;
        }
        break :blk false;
    };
}

// ---------------------------------------------------------------------------
// Layer types: each lists its properties in host definition order, a
// subsequence of the canonical order. A property both types list has one
// definition (the canonical entry above).
// ---------------------------------------------------------------------------

pub const emitter_names = [_][]const u8{
    "emitter-kind",            "emitter-position",        "emitter-radius",        "emitter-height",
    "particle-space",          "particle-scale",          "particle-count",        "particle-lifetime",
    "particle-explosiveness",  "particle-burst-interval", "particle-burst-groups", "particle-seed",
    "particle-speed",          "particle-direction",      "particle-spread",       "particle-gravity",
    "particle-drag",           "particle-wind",           "particle-wander",       "particle-spin",
    "particle-shape",          "particle-size",           "particle-growth",       "particle-size-clamp",
    "particle-stretch",        "particle-color",          "particle-color-end",    "particle-color-variation",
    "particle-opacity",        "particle-fade",           "particle-additive",     "particle-twinkle",
    "emitter-center-thinning", "emitter-screen-tint",     "emitter-vignette",
};

pub const features_names = [_][]const u8{
    "particle-density", "particle-lifetime", "particle-speed",    "particle-direction", "particle-spread",
    "particle-gravity", "particle-wander",   "particle-shape",    "particle-size",      "particle-stretch",
    "particle-color",   "particle-fade",     "particle-additive", "particle-twinkle",
};

/// Features properties that may depend on the feature (FEATURE | COMPOSITE).
pub const features_data_driven = [_][]const u8{ "particle-density", "particle-shape", "particle-size", "particle-color" };

/// spec.json layerTypes.particle-features.layout; layout.zig lays tiles out
/// with these.
pub const layout = struct {
    pub const point_slots: u32 = 16;
    pub const line_slot_spacing: u32 = 32;
    pub const polygon_cell: u32 = 128;
    pub const max_particles_per_tile: u32 = 16383;
};

pub fn capabilities(comptime property: Property, comptime data_driven: bool) u32 {
    const base: u32 = switch (property.expressions) {
        .constant => c.MLN_PLUGIN_EXPRESSION_NONE,
        .camera => c.MLN_PLUGIN_EXPRESSION_CAMERA,
    };
    return if (data_driven) base | c.MLN_PLUGIN_EXPRESSION_FEATURE | c.MLN_PLUGIN_EXPRESSION_COMPOSITE else base;
}

fn enumStrings(comptime values: []const []const u8) []const c.mln_plugin_string {
    return comptime blk: {
        var result: [values.len]c.mln_plugin_string = undefined;
        for (values, 0..) |value, i| result[i] = str(value);
        const final = result;
        break :blk &final;
    };
}

pub fn valueType(comptime property: Property) c.mln_plugin_value_type {
    return switch (property.type) {
        .float => c.MLN_PLUGIN_VALUE_FLOAT,
        .float2 => c.MLN_PLUGIN_VALUE_FLOAT2,
        .double2 => c.MLN_PLUGIN_VALUE_DOUBLE2,
        .color => c.MLN_PLUGIN_VALUE_COLOR,
        .enumeration => c.MLN_PLUGIN_VALUE_STRING,
    };
}

fn defaultData(comptime property: Property) c.mln_plugin_value_data {
    const d = property.default;
    const f: [4]f32 = .{ @floatCast(d[0]), @floatCast(d[1]), @floatCast(d[2]), @floatCast(d[3]) };
    return switch (property.type) {
        .float => .{ .float_value = f[0] },
        .float2 => .{ .float2_value = .{ .x = f[0], .y = f[1] } },
        .double2 => .{ .double2_value = .{ .x = d[0], .y = d[1] } },
        .color => .{ .color_value = .{ .r = f[0], .g = f[1], .b = f[2], .a = f[3] } },
        .enumeration => .{ .string_value = str(property.values[@intFromFloat(d[0])]) },
    };
}

pub fn descriptor(comptime property: Property, comptime data_driven: bool) c.mln_plugin_property_descriptor_v1 {
    const values = enumStrings(property.values);
    return .{
        .struct_size = @sizeOf(c.mln_plugin_property_descriptor_v1),
        .name = str(property.name),
        .type = valueType(property),
        .default_value = .{ .struct_size = @sizeOf(c.mln_plugin_value), .type = valueType(property), .data = defaultData(property) },
        .expression_capabilities = capabilities(property, data_driven),
        .supports_transitions = @intFromBool(property.transition),
        .has_minimum = @intFromBool(property.minimum != null),
        .has_maximum = @intFromBool(property.maximum != null),
        .minimum = property.minimum orelse 0,
        .maximum = property.maximum orelse 0,
        .enum_values = if (values.len == 0) null else values.ptr,
        .enum_value_count = values.len,
    };
}

fn descriptors(comptime names: []const []const u8, comptime data_driven: []const []const u8) [names.len]c.mln_plugin_property_descriptor_v1 {
    @setEvalBranchQuota(100_000);
    var result: [names.len]c.mln_plugin_property_descriptor_v1 = undefined;
    for (names, 0..) |name, i| result[i] = descriptor(find(name), contains(data_driven, name));
    return result;
}

pub const emitter_descriptors = descriptors(&emitter_names, &.{});
pub const features_descriptors = descriptors(&features_names, &features_data_driven);

// ---------------------------------------------------------------------------
// Emitter transport: the frame table. One LAYER-scope,
// vertex-only block holds the per-map camera header and one 15-vec4 row per
// visible emitter layer; the vertex bytes carry only (vertex index, row).
// ---------------------------------------------------------------------------

pub const max_rows = 16;
pub const row_vec4s = 15;
pub const header_vec4s = 12;

pub const TableUBO = extern struct {
    header: [header_vec4s][4]f32,
    rows: [max_rows * row_vec4s][4]f32,
};

comptime {
    // Under Metal's 4 KiB setVertexBytes threshold (mtl/buffer_resource.cpp),
    // and under the 8 KiB page at which the host's OpenGL uniform buffer
    // allocator currently fails (gl/buffer_allocator.cpp; OpenGL itself
    // allows at least 16 KiB). Every member is a vec4, so std140 and MSL
    // agree.
    std.debug.assert(@sizeOf(TableUBO) == 4032);
    std.debug.assert(@offsetOf(TableUBO, "rows") == 192);
}

/// Header vec4s. h0-h3 hold P_rel, the frame's projection relative to the
/// frame center (world px, y down, z in meters -> clip), column-major.
pub const Header = enum(u8) {
    p_rel0 = 0,
    p_rel1 = 1,
    p_rel2 = 2,
    p_rel3 = 3,
    /// (plugin time mod W, W, row count, 1)
    clock = 4,
    /// (pixels_to_gl_units.xy, viewport width, height)
    screen = 5,
    /// (camera-to-center distance, pixel ratio, ppm at the camera, pitch rad)
    view = 6,
    /// (eye x, y world px from the frame center, eye z meters, box px)
    eye = 7,
    /// (phase east, north, up in [0, 1), scale) of weather pool 0
    pool0 = 8,
    pool1 = 9,
    /// (pool 0 weight, pool 1 weight, eye altitude px, 0)
    weights = 10,
    reserved = 11,
};

/// Row vec4s. Lanes color..area are ParticleParams (shaders/particle.glsl),
/// in its member order; `member` names them there.
pub const Lane = enum(u8) {
    /// (E_rel.x, E_rel.y world px from the frame center, ppm_e, scale)
    placement = 0,
    color = 1,
    color_end = 2,
    size = 3,
    size_spin = 4,
    fade_add = 5,
    sparkle = 6,
    timing = 7,
    emission = 8,
    launch = 9,
    cone = 10,
    air = 11,
    area = 12,
    tint = 13,
    extra = 14,

    pub fn member(comptime lane: Lane) []const u8 {
        return switch (lane) {
            .color => "color",
            .color_end => "colorEnd",
            .size => "size",
            .size_spin => "sizeSpin",
            .fade_add => "fadeAdd",
            .sparkle => "sparkle",
            .timing => "timing",
            .emission => "emission",
            .launch => "launch",
            .cone => "cone",
            .air => "air",
            .area => "area",
            .placement, .tint, .extra => @compileError("not a ParticleParams lane"),
        };
    }
};

pub const first_params_lane = Lane.color;
pub const last_params_lane = Lane.area;

/// How an emitter property reaches its row.
pub const Use = enum {
    /// The value's components, raw in spec units, from lane.component on.
    raw,
    /// As raw, clamped to the spec bounds by the packer (no shader clamp).
    clamped,
    /// Packed into the identity (emission.w) as `weight` times the value:
    /// seed + 65536 * (shape + 16 * space + 64 * kind). Exact below 2^24.
    identity,
    /// particle-color and particle-color-end: premultiplied as the host
    /// delivers them, times opacity; colorEnd is painted over color.
    color,
    /// particle-opacity: folded into the color and colorEnd lanes, clamped.
    opacity,
    /// emitter-position: E_rel in f64 on the CPU (placement.xy, and ppm_e in
    /// placement.z in world space).
    position,
};

pub const LaneUse = struct {
    name: []const u8,
    use: Use,
    lane: Lane,
    component: u2 = 0,
    weight: f64 = 1,
};

/// Identity class weights and the placement kind values it packs.
pub const identity = struct {
    pub const shape: f64 = 65536;
    pub const space: f64 = 65536 * 16;
    pub const kind: f64 = 65536 * 64;
    /// Emitter kinds are emitter-kind's indices; features pack this one.
    pub const feature_kind: f64 = 3;
};

/// Every emitter property, in type order, and where it goes in the row.
pub const emitter_lanes = [_]LaneUse{
    .{ .name = "emitter-kind", .use = .identity, .lane = .emission, .component = 3, .weight = identity.kind },
    .{ .name = "emitter-position", .use = .position, .lane = .placement, .component = 0 },
    .{ .name = "emitter-radius", .use = .raw, .lane = .area, .component = 0 },
    .{ .name = "emitter-height", .use = .raw, .lane = .area, .component = 1 },
    .{ .name = "particle-space", .use = .identity, .lane = .emission, .component = 3, .weight = identity.space },
    .{ .name = "particle-scale", .use = .raw, .lane = .placement, .component = 3 },
    .{ .name = "particle-count", .use = .raw, .lane = .emission, .component = 0 },
    .{ .name = "particle-lifetime", .use = .raw, .lane = .timing, .component = 0 },
    .{ .name = "particle-explosiveness", .use = .raw, .lane = .emission, .component = 1 },
    .{ .name = "particle-burst-interval", .use = .raw, .lane = .timing, .component = 2 },
    .{ .name = "particle-burst-groups", .use = .raw, .lane = .emission, .component = 2 },
    .{ .name = "particle-seed", .use = .identity, .lane = .emission, .component = 3, .weight = 1 },
    .{ .name = "particle-speed", .use = .raw, .lane = .launch, .component = 0 },
    .{ .name = "particle-direction", .use = .raw, .lane = .launch, .component = 2 },
    .{ .name = "particle-spread", .use = .raw, .lane = .cone, .component = 0 },
    .{ .name = "particle-gravity", .use = .raw, .lane = .cone, .component = 2 },
    .{ .name = "particle-drag", .use = .raw, .lane = .cone, .component = 3 },
    .{ .name = "particle-wind", .use = .raw, .lane = .air, .component = 0 },
    .{ .name = "particle-wander", .use = .raw, .lane = .air, .component = 2 },
    .{ .name = "particle-spin", .use = .raw, .lane = .size_spin, .component = 2 },
    .{ .name = "particle-shape", .use = .identity, .lane = .emission, .component = 3, .weight = identity.shape },
    .{ .name = "particle-size", .use = .raw, .lane = .size, .component = 0 },
    .{ .name = "particle-growth", .use = .raw, .lane = .size, .component = 2 },
    .{ .name = "particle-size-clamp", .use = .raw, .lane = .size_spin, .component = 0 },
    .{ .name = "particle-stretch", .use = .raw, .lane = .size, .component = 3 },
    .{ .name = "particle-color", .use = .color, .lane = .color, .component = 0 },
    .{ .name = "particle-color-end", .use = .color, .lane = .color_end, .component = 0 },
    .{ .name = "particle-color-variation", .use = .raw, .lane = .sparkle, .component = 2 },
    .{ .name = "particle-opacity", .use = .opacity, .lane = .color, .component = 0 },
    .{ .name = "particle-fade", .use = .raw, .lane = .fade_add, .component = 0 },
    .{ .name = "particle-additive", .use = .raw, .lane = .fade_add, .component = 2 },
    .{ .name = "particle-twinkle", .use = .raw, .lane = .sparkle, .component = 0 },
    .{ .name = "emitter-center-thinning", .use = .raw, .lane = .area, .component = 3 },
    .{ .name = "emitter-screen-tint", .use = .raw, .lane = .tint, .component = 0 },
    .{ .name = "emitter-vignette", .use = .clamped, .lane = .extra, .component = 0 },
};

/// Row components no property writes directly: placement.z (ppm_e, derived
/// from emitter-position and particle-space) and the rest of `extra`.
pub const derived_components = [_]struct { lane: Lane, component: u2 }{
    .{ .lane = .placement, .component = 2 },
    .{ .lane = .extra, .component = 1 },
    .{ .lane = .extra, .component = 2 },
    .{ .lane = .extra, .component = 3 },
};

// ---------------------------------------------------------------------------
// Features transport: host bindings. One geometry attribute
// (a_emit) plus one binding per property; the host writes each value into
// the drawable's FeatureUBO, or into the binding's attributes when the value
// depends on the feature.
// ---------------------------------------------------------------------------

pub const FeatureUBO = extern struct {
    /// tile units -> clip (the uniform context's tile_matrix)
    matrix: [16]f32,
    /// (pixels_to_tile_units, pixel ratio, plugin time mod W, camera-to-center distance)
    camera: [4]f32,
    /// (pixels_to_gl_units.xy, viewport width, height)
    screen: [4]f32,
    color: [4]f32,
    size: [2]f32,
    lifetime: [2]f32,
    speed: [2]f32,
    direction: [2]f32,
    spread: [2]f32,
    wander: [2]f32,
    fade: [2]f32,
    additive: [2]f32,
    twinkle: [2]f32,
    density: f32,
    shape: f32,
    gravity: f32,
    stretch: f32,
    pad: [2]f32,
    /// Binding k's composite interpolation factor at 208 + 4k.
    interpolation: [16]f32,
};

comptime {
    std.debug.assert(@sizeOf(FeatureUBO) == 272);
    std.debug.assert(@offsetOf(FeatureUBO, "camera") == 64);
    std.debug.assert(@offsetOf(FeatureUBO, "color") == 96);
    std.debug.assert(@offsetOf(FeatureUBO, "density") == 184);
    std.debug.assert(@offsetOf(FeatureUBO, "interpolation") == 208);
}

pub const FeatureBinding = struct {
    name: []const u8,
    /// FeatureUBO field, and the attribute stem `a_particle_<field>`.
    field: []const u8,
    /// Attribute id and location of the value; a color's maximum takes the
    /// next one.
    attribute: u32,

    pub fn property(comptime self: FeatureBinding) Property {
        return find(self.name);
    }

    pub fn slots(comptime self: FeatureBinding) u32 {
        return if (self.property().type == .color) 2 else 1;
    }

    pub fn dataDriven(comptime self: FeatureBinding) bool {
        return contains(&features_data_driven, self.name);
    }

    /// Scalars and enums pack both endpoints into one float2, a float2 into
    /// one float4; a color needs a float4 per endpoint.
    pub fn attributeType(comptime self: FeatureBinding) c.mln_plugin_vertex_attribute_type {
        return switch (self.property().type) {
            .float, .enumeration => c.MLN_PLUGIN_VERTEX_FLOAT_X2,
            .float2, .color => c.MLN_PLUGIN_VERTEX_FLOAT_X4,
            .double2 => @compileError("DOUBLE2 cannot be bound"),
        };
    }

    pub fn encoding(comptime self: FeatureBinding) c.mln_plugin_property_encoding_v1 {
        return switch (self.property().type) {
            .float => c.MLN_PLUGIN_PROPERTY_ENCODING_FLOAT,
            .float2 => c.MLN_PLUGIN_PROPERTY_ENCODING_FLOAT2,
            .color => c.MLN_PLUGIN_PROPERTY_ENCODING_COLOR,
            .enumeration => c.MLN_PLUGIN_PROPERTY_ENCODING_ENUM_FLOAT,
            .double2 => @compileError("DOUBLE2 cannot be bound"),
        };
    }

    pub fn attributeName(comptime self: FeatureBinding, comptime slot: u32) []const u8 {
        return "a_particle_" ++ self.field ++ if (self.slots() == 2) (if (slot == 0) "_min" else "_max") else "";
    }
};

/// Binding k is the features type's k-th property. The four data-driven
/// properties take the lowest locations (1-5) so the GL location ladder
/// (shaders.zig) only has to count those.
pub const feature_bindings = [_]FeatureBinding{
    .{ .name = "particle-density", .field = "density", .attribute = 4 },
    .{ .name = "particle-lifetime", .field = "lifetime", .attribute = 6 },
    .{ .name = "particle-speed", .field = "speed", .attribute = 7 },
    .{ .name = "particle-direction", .field = "direction", .attribute = 8 },
    .{ .name = "particle-spread", .field = "spread", .attribute = 9 },
    .{ .name = "particle-gravity", .field = "gravity", .attribute = 14 },
    .{ .name = "particle-wander", .field = "wander", .attribute = 10 },
    .{ .name = "particle-shape", .field = "shape", .attribute = 5 },
    .{ .name = "particle-size", .field = "size", .attribute = 3 },
    .{ .name = "particle-stretch", .field = "stretch", .attribute = 15 },
    .{ .name = "particle-color", .field = "color", .attribute = 1 },
    .{ .name = "particle-fade", .field = "fade", .attribute = 11 },
    .{ .name = "particle-additive", .field = "additive", .attribute = 12 },
    .{ .name = "particle-twinkle", .field = "twinkle", .attribute = 13 },
};

/// The a_emit packing, shared by layout.zig and the features
/// shader. Every component is an exact f32 integer:
///   x, y  anchor in tile units, a multiple of 1 / anchor_steps
///   z     lines: angle step * line_length_steps + half length (tile units);
///         0 otherwise
///   w     slot * slot_stride + corner * corner_stride + kind
pub const emit = struct {
    pub const kind_point: u32 = 0;
    pub const kind_line: u32 = 1;
    pub const kind_polygon: u32 = 2;
    pub const corner_stride: u32 = 4;
    pub const slot_stride: u32 = 16;
    pub const anchor_steps: u32 = 4;
    pub const line_length_steps: u32 = 8192;
    pub const line_angle_steps: u32 = 1024;
};

comptime {
    // The shader decodes w and z with shifts and masks.
    std.debug.assert(std.math.isPowerOfTwo(emit.corner_stride) and emit.slot_stride == 4 * emit.corner_stride);
    std.debug.assert(std.math.isPowerOfTwo(emit.line_length_steps) and emit.line_angle_steps * emit.line_length_steps <= 1 << 24);
}

/// a_emit (location 0) plus every binding slot.
pub const feature_attribute_count = blk: {
    var count: u32 = 1;
    for (feature_bindings) |binding| count += binding.slots();
    break :blk count;
};

pub fn interpolationOffset(comptime k: usize) u32 {
    return @offsetOf(FeatureUBO, "interpolation") + 4 * k;
}

comptime {
    std.debug.assert(feature_bindings.len == features_names.len);
    for (feature_bindings, features_names) |binding, name| std.debug.assert(std.mem.eql(u8, binding.name, name));
}

// ---------------------------------------------------------------------------
// Shared geometry: quads as two triangles, in segments of at most 16383
// quads (65532 vertices) that all index one immutable u16 pattern.
// ---------------------------------------------------------------------------

pub const segment_quads: u32 = 16383;

pub const quad_indices: [segment_quads * 6]u16 = blk: {
    @setEvalBranchQuota(200_000);
    var result: [segment_quads * 6]u16 = undefined;
    for (0..segment_quads) |k| {
        const base: u16 = @intCast(4 * k);
        result[6 * k ..][0..6].* = .{ base, base + 1, base + 2, base, base + 2, base + 3 };
    }
    break :blk result;
};

// ---------------------------------------------------------------------------
// Tests: budget and coverage (spec parity lives in plugin.zig).
// ---------------------------------------------------------------------------

test "every emitter property reaches the row exactly once, and every row component is accounted for" {
    try std.testing.expectEqual(emitter_names.len, emitter_lanes.len);
    var written = [_][4]u8{.{ 0, 0, 0, 0 }} ** row_vec4s;
    var identity_weights: f64 = 0;
    var opacity_folded = false;
    inline for (emitter_lanes, emitter_names) |entry, name| {
        try std.testing.expectEqualStrings(name, entry.name);
        const property = comptime find(entry.name);
        const lane = @intFromEnum(entry.lane);
        switch (entry.use) {
            .raw, .clamped, .color => {
                if (entry.use == .color) try std.testing.expectEqual(ValueType.color, property.type);
                if (entry.use == .clamped) try std.testing.expect(property.minimum != null and property.maximum != null);
                for (@as(usize, entry.component)..@as(usize, entry.component) + property.width()) |component| written[lane][component] += 1;
            },
            .identity => {
                try std.testing.expect(property.type == .enumeration or property.type == .float);
                try std.testing.expectEqual(Lane.emission, entry.lane);
                try std.testing.expectEqual(@as(u2, 3), entry.component);
                identity_weights += entry.weight;
            },
            .opacity => {
                try std.testing.expectEqual(Lane.color, entry.lane);
                opacity_folded = true;
            },
            .position => {
                try std.testing.expectEqual(ValueType.double2, property.type);
                written[lane][0] += 1;
                written[lane][1] += 1;
            },
        }
    }
    try std.testing.expect(opacity_folded);
    written[@intFromEnum(Lane.emission)][3] += 1;
    for (derived_components) |d| written[@intFromEnum(d.lane)][d.component] += 1;
    for (written, 0..) |lane, i| for (lane, 0..) |count, component| {
        errdefer std.debug.print("row lane {d} component {d} written {d} times\n", .{ i, component, count });
        try std.testing.expectEqual(@as(u8, 1), count);
    };
    // The identity packs seed, shape, space and kind without overlap, and
    // stays an exact float below 2^24 (seed < 2^16, shape < 16, space < 4,
    // kind <= 3).
    try std.testing.expectEqual(1 + identity.shape + identity.space + identity.kind, identity_weights);
    try std.testing.expect(find("particle-seed").maximum.? < identity.shape);
    try std.testing.expect(shapes.len <= 16);
    try std.testing.expect(find("particle-space").values.len <= 4);
    try std.testing.expectEqual(@as(f64, @floatFromInt(find("emitter-kind").values.len)), identity.feature_kind);
    try std.testing.expect(65535 + identity.shape * 15 + identity.space * 3 + identity.kind * identity.feature_kind < 1 << 24);
}

test "every features property has exactly one binding and the attributes fill all 16 slots" {
    try std.testing.expectEqual(@as(u32, c.MLN_PLUGIN_MAX_VERTEX_ATTRIBUTES), feature_attribute_count);
    var owner = [_]u8{0} ** 16;
    owner[0] = 1; // a_emit
    var covered = std.mem.zeroes([@sizeOf(FeatureUBO)]u8);
    inline for (feature_bindings, 0..) |binding, k| {
        for (binding.attribute..binding.attribute + binding.slots()) |id| owner[id] += 1;
        const size: usize = switch (comptime binding.property().type) {
            .float, .enumeration => 4,
            .float2 => 8,
            .color => 16,
            .double2 => unreachable,
        };
        const offset = @offsetOf(FeatureUBO, binding.field);
        try std.testing.expectEqual(size, @sizeOf(@FieldType(FeatureUBO, binding.field)));
        for (offset..offset + size) |i| covered[i] += 1;
        for (interpolationOffset(k)..interpolationOffset(k) + 4) |i| covered[i] += 1;
        // Data-driven attributes take the lowest locations, in one block.
        if (binding.dataDriven()) try std.testing.expect(binding.attribute + binding.slots() <= 6);
        if (!binding.dataDriven()) try std.testing.expect(binding.attribute >= 6);
    }
    for (owner) |count| try std.testing.expectEqual(@as(u8, 1), count);
    // Host-written ranges never overlap each other or the plugin's fields.
    for (covered, 0..) |count, i| {
        const plugin_owned = i < @offsetOf(FeatureUBO, "color") or (i >= @offsetOf(FeatureUBO, "pad") and i < @offsetOf(FeatureUBO, "interpolation"));
        const unused_interpolation = i >= interpolationOffset(feature_bindings.len);
        try std.testing.expectEqual(@as(u8, if (plugin_owned or unused_interpolation) 0 else 1), count);
    }
    // Every data-driven property of the type is bound.
    inline for (features_data_driven) |name| try std.testing.expect(contains(&features_names, name));
}

test "descriptors follow the canonical table" {
    try std.testing.expectEqual(@as(usize, 35), emitter_descriptors.len);
    try std.testing.expectEqual(@as(usize, 14), features_descriptors.len);
    const shape = features_descriptors[7];
    try std.testing.expectEqualStrings("particle-shape", shape.name.data[0..shape.name.size]);
    try std.testing.expectEqual(@as(c_uint, c.MLN_PLUGIN_VALUE_STRING), shape.type);
    try std.testing.expectEqualStrings("glow", shape.default_value.data.string_value.data[0..shape.default_value.data.string_value.size]);
    try std.testing.expectEqual(@as(usize, 10), shape.enum_value_count);
    try std.testing.expectEqual(@as(u32, c.MLN_PLUGIN_EXPRESSION_CAMERA | c.MLN_PLUGIN_EXPRESSION_FEATURE | c.MLN_PLUGIN_EXPRESSION_COMPOSITE), shape.expression_capabilities);
    try std.testing.expectEqual(@as(u8, 0), shape.supports_transitions);
    // The emitter's copy of the same property is camera-only.
    try std.testing.expectEqual(@as(u32, c.MLN_PLUGIN_EXPRESSION_CAMERA), emitter_descriptors[20].expression_capabilities);
    const lifetime = features_descriptors[1];
    try std.testing.expectEqual(@as(u32, c.MLN_PLUGIN_EXPRESSION_NONE), lifetime.expression_capabilities);
    try std.testing.expectEqual(@as(f32, 2), lifetime.default_value.data.float2_value.y);
}

test "quad index pattern" {
    try std.testing.expectEqualSlices(u16, &.{ 0, 1, 2, 0, 2, 3, 4, 5, 6, 4, 6, 7 }, quad_indices[0..12]);
    try std.testing.expectEqual(@as(u16, 4 * (segment_quads - 1) + 3), quad_indices[quad_indices.len - 1]);
    try std.testing.expect(4 * segment_quads <= 65536);
}
