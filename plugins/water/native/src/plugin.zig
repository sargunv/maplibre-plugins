//! Animated shoreline layer for MapLibre Native's plugin ABI. The host feeds
//! water polygons from the layer's source; layout.zig turns their rings into
//! a band along the shoreline, and shaders/shore.glsl animates crests and
//! wash inside it. See ../../spec.json for the contract this file shares
//! with the maplibre-gl-js implementation.

const std = @import("std");
const builtin = @import("builtin");
const build_options = @import("build_options");
const c = @import("maplibre_native_c");
const layout = @import("layout.zig");

pub const layer_type_name = "water-shore";
pub const plugin_id = "org.maplibre.plugins.water";
pub const plugin_version = "0.1.0";

fn str(comptime text: []const u8) c.mln_plugin_string {
    return .{ .data = text.ptr, .size = text.len };
}

// ---------------------------------------------------------------------------
// Paint properties. Keep in sync with ../../spec.json; the "descriptors match
// the shared spec" test enforces it.
// ---------------------------------------------------------------------------

const PropertyKind = enum { float, color };

const Property = struct {
    name: []const u8,
    kind: PropertyKind,
    default: [4]f32,
    minimum: ?f32 = null,
    maximum: ?f32 = null,
    /// Field in DrawableUBO the host writes the evaluated value into.
    field: []const u8,
};

const properties = [_]Property{
    .{ .name = "shore-width", .kind = .float, .default = .{ 48, 0, 0, 0 }, .minimum = 0, .field = "shore_width" },
    .{ .name = "shore-color", .kind = .color, .default = .{ 0.62, 0.9, 0.96, 0.55 }, .field = "shore_color" },
    .{ .name = "foam-color", .kind = .color, .default = .{ 1, 1, 1, 0.92 }, .field = "foam_color" },
    .{ .name = "wave-count", .kind = .float, .default = .{ 3, 0, 0, 0 }, .minimum = 0, .maximum = 12, .field = "wave_count" },
    .{ .name = "wave-speed", .kind = .float, .default = .{ 0.3, 0, 0, 0 }, .minimum = -3, .maximum = 3, .field = "wave_speed" },
    .{ .name = "wave-wobble", .kind = .float, .default = .{ 0.5, 0, 0, 0 }, .minimum = 0, .maximum = 1, .field = "wave_wobble" },
    .{ .name = "foam-length", .kind = .float, .default = .{ 0.3, 0, 0, 0 }, .minimum = 0, .maximum = 1, .field = "foam_length" },
    .{ .name = "wash-strength", .kind = .float, .default = .{ 0.8, 0, 0, 0 }, .minimum = 0, .maximum = 1, .field = "wash_strength" },
    .{ .name = "opacity", .kind = .float, .default = .{ 1, 0, 0, 0 }, .minimum = 0, .maximum = 1, .field = "opacity" },
};

fn descriptor(comptime property: Property) c.mln_plugin_property_descriptor_v1 {
    const value_type: c.mln_plugin_value_type = if (property.kind == .color) c.MLN_PLUGIN_VALUE_COLOR else c.MLN_PLUGIN_VALUE_FLOAT;
    return .{
        .struct_size = @sizeOf(c.mln_plugin_property_descriptor_v1),
        .name = str(property.name),
        .type = value_type,
        .default_value = .{
            .struct_size = @sizeOf(c.mln_plugin_value),
            .type = value_type,
            .data = if (property.kind == .color)
                .{ .color_value = .{ .r = property.default[0], .g = property.default[1], .b = property.default[2], .a = property.default[3] } }
            else
                .{ .float_value = property.default[0] },
        },
        .expression_capabilities = c.MLN_PLUGIN_EXPRESSION_CAMERA,
        .supports_transitions = 1,
        .has_minimum = if (property.minimum != null) 1 else 0,
        .has_maximum = if (property.maximum != null) 1 else 0,
        .minimum = property.minimum orelse 0,
        .maximum = property.maximum orelse 0,
        .enum_values = null,
        .enum_value_count = 0,
    };
}

const property_descriptors = blk: {
    var result: [properties.len]c.mln_plugin_property_descriptor_v1 = undefined;
    for (properties, 0..) |property, i| result[i] = descriptor(property);
    break :blk result;
};

// ---------------------------------------------------------------------------
// Uniform block. The plugin fills the matrix and camera fields every frame;
// the host writes each bound paint property into its field afterwards. The
// layout is std140-compatible and mirrored by the shader declarations below.
// ---------------------------------------------------------------------------

const DrawableUBO = extern struct {
    matrix: [16]f32,
    /// pixels_to_tile_units, pixel_ratio, time in seconds, tile extent.
    camera: [4]f32,
    shore_color: [4]f32,
    foam_color: [4]f32,
    shore_width: f32,
    wave_count: f32,
    wave_speed: f32,
    wave_wobble: f32,
    foam_length: f32,
    wash_strength: f32,
    opacity: f32,
    padding: f32,
    /// One composite interpolation factor slot per bound property; the
    /// properties are camera-only, so the shader never reads them.
    interpolation: [12]f32,
};

comptime {
    std.debug.assert(@sizeOf(DrawableUBO) == 192);
    std.debug.assert(@offsetOf(DrawableUBO, "camera") == 64);
    std.debug.assert(@offsetOf(DrawableUBO, "shore_width") == 112);
    std.debug.assert(@offsetOf(DrawableUBO, "interpolation") == 144);
}

const ubo_fields =
    \\    mat4 matrix;
    \\    vec4 camera;
    \\    vec4 shore_color;
    \\    vec4 foam_color;
    \\    float shore_width;
    \\    float wave_count;
    \\    float wave_speed;
    \\    float wave_wobble;
    \\    float foam_length;
    \\    float wash_strength;
    \\    float opacity;
    \\    float padding;
    \\    vec4 interpolation0;
    \\    vec4 interpolation1;
    \\    vec4 interpolation2;
    \\
;

// ---------------------------------------------------------------------------
// Shaders. The shared fragment function compiles as GLSL and MSL; each
// backend wraps it with its own declarations, following the host's
// conventions for attributes, uniform blocks and varyings.
// ---------------------------------------------------------------------------

const fragment_shared = build_options.shade_glsl;

/// Vertex attribute IDs. The two geometry attributes come from the layout;
/// the rest are the host's per-property attribute slots, which stay unused
/// because every property is camera-driven (and so arrives as a uniform).
/// A scalar packs both interpolation endpoints into one float2 slot; a
/// color needs a float4 slot for each endpoint.
const geometry_attribute_count = 2;

fn slotCount(comptime property: Property) usize {
    return if (property.kind == .color) 2 else 1;
}

/// The first attribute ID of a property's slot(s).
fn firstSlot(comptime index: usize) usize {
    comptime var id: usize = geometry_attribute_count;
    inline for (properties[0..index]) |property| id += slotCount(property);
    return id;
}

const paint_attribute_count = blk: {
    var count: usize = 0;
    for (properties) |property| count += slotCount(property);
    break :blk count;
};

fn propertyMacro(comptime property: Property) []const u8 {
    return comptime blk: {
        var name: [property.name.len]u8 = undefined;
        for (property.name, 0..) |ch, i| name[i] = if (std.ascii.isAlphanumeric(ch)) std.ascii.toUpper(ch) else '_';
        const upper = name;
        break :blk "MLN_PLUGIN_PROPERTY_" ++ upper ++ "_IS_UNIFORM";
    };
}

/// Attribute names: `a_<name>` for a packed scalar, `a_<name>_min` and
/// `a_<name>_max` for a color's two endpoints.
fn attributeName(comptime property: Property, comptime slot: usize) []const u8 {
    return comptime blk: {
        var name: [property.name.len]u8 = undefined;
        for (property.name, 0..) |ch, i| name[i] = if (ch == '-') '_' else ch;
        const snake = name;
        break :blk "a_" ++ snake ++ (if (property.kind == .color) (if (slot == 0) "_min" else "_max") else "");
    };
}

fn digits(comptime n: usize) []const u8 {
    return comptime if (n < 10) &[_]u8{'0' + @as(u8, n)} else digits(n / 10) ++ digits(n % 10);
}

/// The paint attribute declarations, guarded so they only exist for
/// data-driven properties, which this layer never has.
fn glslPaintAttributes(comptime vulkan: bool) []const u8 {
    return comptime blk: {
        @setEvalBranchQuota(100_000);
        var result: []const u8 = "";
        for (properties, 0..) |property, i| {
            result = result ++ "#if !" ++ propertyMacro(property) ++ "\n";
            for (0..slotCount(property)) |slot| {
                result = result ++ (if (vulkan) "layout(location=" ++ digits(firstSlot(i) + slot) ++ ") " else "") ++
                    "in " ++ (if (property.kind == .color) "vec4 " else "vec2 ") ++ attributeName(property, slot) ++ ";\n";
            }
            result = result ++ "#endif\n";
        }
        break :blk result;
    };
}

fn metalPaintAttributes() []const u8 {
    return comptime blk: {
        @setEvalBranchQuota(100_000);
        var result: []const u8 = "";
        for (properties, 0..) |property, i| {
            result = result ++ "#if !" ++ propertyMacro(property) ++ "\n";
            for (0..slotCount(property)) |slot| {
                result = result ++ "    " ++ (if (property.kind == .color) "float4 " else "float2 ") ++ attributeName(property, slot) ++ " [[attribute(" ++ digits(firstSlot(i) + slot) ++ ")]];\n";
            }
            result = result ++ "#endif\n";
        }
        break :blk result;
    };
}

const varying_names = [_][]const u8{ "v_pos", "v_shore", "v_foam", "v_wave", "v_params", "v_owner" };

fn glslVaryings(comptime vulkan: bool, comptime direction: []const u8) []const u8 {
    return comptime blk: {
        @setEvalBranchQuota(100_000);
        var result: []const u8 = "";
        for (varying_names, 0..) |name, i| {
            result = result ++ (if (vulkan) "layout(location=" ++ digits(i) ++ ") " else "") ++ direction ++ " vec4 " ++ name ++ ";\n";
        }
        break :blk result;
    };
}

/// Extrudes the inner vertices by the band width and hands the fragment
/// stage everything it needs, so the uniform block binds to one stage only.
const vertex_body =
    \\    // The band is clamped to half the reach to the opposite bank, so the
    \\    // two sides of a narrow channel meet instead of overlapping.
    \\    vec2 pos = a_pos + a_extrude.xy * min(u.shore_width * u.camera.x, a_extrude.w);
    \\    gl_Position = u.matrix * vec4(pos, 0.0, 1.0);
    \\    v_pos = vec4(pos, a_extrude.z, u.camera.z);
    \\    v_owner = vec4(a_pos, 0.0, 0.0);
    \\    v_shore = u.shore_color;
    \\    v_foam = u.foam_color;
    \\    v_wave = vec4(u.shore_width, u.wave_count, u.wave_speed, u.wave_wobble);
    \\    v_params = vec4(u.foam_length, u.wash_strength, u.opacity, u.camera.w);
    \\
;

fn glslVertex(comptime vulkan: bool) []const u8 {
    return comptime (if (vulkan) "layout(location=0) in vec2 a_pos;\nlayout(location=1) in vec4 a_extrude;\n" else "in vec2 a_pos;\nin vec4 a_extrude;\n") ++
        glslPaintAttributes(vulkan) ++
        (if (vulkan) "layout(std140, set = DRAWABLE_UBO_SET_INDEX, binding = MLN_PLUGIN_UNIFORM_0_BINDING) " else "layout(std140) ") ++
        "uniform ShoreDrawableUBO {\n" ++ ubo_fields ++ "} u;\n" ++
        glslVaryings(vulkan, "out") ++
        "void main() {\n" ++ vertex_body ++
        (if (vulkan) "    applySurfaceTransform();\n" else "") ++ "}\n";
}

fn glslFragment(comptime vulkan: bool) []const u8 {
    return comptime glslVaryings(vulkan, "in") ++
        (if (vulkan) "layout(location=0) out vec4 fragColor;\n" else "") ++
        "#define float2 vec2\n#define float4 vec4\n" ++ fragment_shared ++
        "\nvoid main() { fragColor = shoreShade(v_pos.xy, v_owner.xy, v_pos.z, v_shore, v_foam, v_wave, v_params, v_pos.w); }\n";
}

const metal =
    \\struct alignas(16) ShoreDrawableUBO {
    \\    float4x4 matrix;
    \\    float4 camera;
    \\    float4 shore_color;
    \\    float4 foam_color;
    \\    float shore_width;
    \\    float wave_count;
    \\    float wave_speed;
    \\    float wave_wobble;
    \\    float foam_length;
    \\    float wash_strength;
    \\    float opacity;
    \\    float padding;
    \\    float4 interpolation0;
    \\    float4 interpolation1;
    \\    float4 interpolation2;
    \\};
    \\struct VertexIn {
    \\    float2 a_pos [[attribute(0)]];
    \\    float4 a_extrude [[attribute(1)]];
    \\
++ metalPaintAttributes() ++
    \\};
    \\struct VertexOut {
    \\    float4 position [[position]];
    \\    float4 v_pos;
    \\    float4 v_shore;
    \\    float4 v_foam;
    \\    float4 v_wave;
    \\    float4 v_params;
    \\    float4 v_owner;
    \\};
    \\vertex VertexOut shoreVertex(VertexIn in [[stage_in]], constant ShoreDrawableUBO& u [[buffer(MLN_PLUGIN_UNIFORM_0_BINDING)]]) {
    \\    VertexOut out;
    \\    float2 pos = in.a_pos + in.a_extrude.xy * min(u.shore_width * u.camera.x, in.a_extrude.w);
    \\    out.position = u.matrix * float4(pos, 0.0, 1.0);
    \\    out.v_pos = float4(pos, in.a_extrude.z, u.camera.z);
    \\    out.v_owner = float4(in.a_pos, 0.0, 0.0);
    \\    out.v_shore = u.shore_color;
    \\    out.v_foam = u.foam_color;
    \\    out.v_wave = float4(u.shore_width, u.wave_count, u.wave_speed, u.wave_wobble);
    \\    out.v_params = float4(u.foam_length, u.wash_strength, u.opacity, u.camera.w);
    \\    return out;
    \\}
    \\
++ fragment_shared ++
    \\
    \\fragment float4 shoreFragment(VertexOut v [[stage_in]]) {
    \\    return shoreShade(v.v_pos.xy, v.v_owner.xy, v.v_pos.z, v.v_shore, v.v_foam, v.v_wave, v.v_params, v.v_pos.w);
    \\}
    \\
;

const sources = [_]c.mln_plugin_shader_source_v1{
    .{ .struct_size = @sizeOf(c.mln_plugin_shader_source_v1), .backend = c.MLN_PLUGIN_BACKEND_OPENGL, .vertex_source = str(glslVertex(false)), .fragment_source = str(glslFragment(false)) },
    .{ .struct_size = @sizeOf(c.mln_plugin_shader_source_v1), .backend = c.MLN_PLUGIN_BACKEND_VULKAN, .vertex_source = str(glslVertex(true)), .fragment_source = str(glslFragment(true)) },
    .{ .struct_size = @sizeOf(c.mln_plugin_shader_source_v1), .backend = c.MLN_PLUGIN_BACKEND_METAL, .vertex_source = str(metal), .vertex_entry_point = str("shoreVertex"), .fragment_entry_point = str("shoreFragment") },
};

const attributes = blk: {
    var result: [geometry_attribute_count + paint_attribute_count]c.mln_plugin_shader_attribute_v1 = undefined;
    result[0] = .{ .struct_size = @sizeOf(c.mln_plugin_shader_attribute_v1), .attribute_id = 0, .location = 0, .name = str("a_pos"), .type = c.MLN_PLUGIN_VERTEX_FLOAT_X2 };
    result[1] = .{ .struct_size = @sizeOf(c.mln_plugin_shader_attribute_v1), .attribute_id = 1, .location = 1, .name = str("a_extrude"), .type = c.MLN_PLUGIN_VERTEX_FLOAT_X4 };
    for (properties, 0..) |property, i| {
        for (0..slotCount(property)) |slot| {
            const id = firstSlot(i) + slot;
            result[id] = .{ .struct_size = @sizeOf(c.mln_plugin_shader_attribute_v1), .attribute_id = id, .location = id, .name = str(attributeName(property, slot)), .type = if (property.kind == .color) c.MLN_PLUGIN_VERTEX_FLOAT_X4 else c.MLN_PLUGIN_VERTEX_FLOAT_X2 };
        }
    }
    break :blk result;
};

const uniform_blocks = [_]c.mln_plugin_uniform_block_descriptor_v1{.{
    .struct_size = @sizeOf(c.mln_plugin_uniform_block_descriptor_v1),
    .uniform_id = 0,
    .name = str("ShoreDrawableUBO"),
    .byte_size = @sizeOf(DrawableUBO),
    .stage_mask = c.MLN_PLUGIN_SHADER_STAGE_VERTEX,
    .scope = c.MLN_PLUGIN_UNIFORM_DRAWABLE,
}};

const property_bindings = blk: {
    var result: [properties.len]c.mln_plugin_shader_property_binding_v1 = undefined;
    for (properties, 0..) |property, i| {
        result[i] = .{
            .struct_size = @sizeOf(c.mln_plugin_shader_property_binding_v1),
            .property_name = str(property.name),
            .encoding = if (property.kind == .color) c.MLN_PLUGIN_PROPERTY_ENCODING_COLOR else c.MLN_PLUGIN_PROPERTY_ENCODING_FLOAT,
            .uniform_id = 0,
            .uniform_byte_offset = @offsetOf(DrawableUBO, property.field),
            .minimum_attribute_id = firstSlot(i),
            .maximum_attribute_id = firstSlot(i) + slotCount(property) - 1,
            .interpolation_uniform_id = 0,
            .interpolation_uniform_byte_offset = @offsetOf(DrawableUBO, "interpolation") + i * @sizeOf(f32),
        };
    }
    break :blk result;
};

const shaders = [_]c.mln_plugin_shader_descriptor_v1{.{
    .struct_size = @sizeOf(c.mln_plugin_shader_descriptor_v1),
    .shader_id = str("shore"),
    .sources = &sources,
    .source_count = sources.len,
    .attributes = &attributes,
    .attribute_count = attributes.len,
    .uniform_blocks = &uniform_blocks,
    .uniform_block_count = uniform_blocks.len,
    .property_bindings = &property_bindings,
    .property_binding_count = property_bindings.len,
}};

// ---------------------------------------------------------------------------
// Layout callbacks (tile workers).
// ---------------------------------------------------------------------------

const Vertex = layout.Vertex;

const attribute_bindings = [_]c.mln_plugin_attribute_binding_v1{
    .{ .struct_size = @sizeOf(c.mln_plugin_attribute_binding_v1), .attribute_id = 0, .stream_id = 0, .byte_offset = @offsetOf(Vertex, "x") },
    .{ .struct_size = @sizeOf(c.mln_plugin_attribute_binding_v1), .attribute_id = 1, .stream_id = 0, .byte_offset = @offsetOf(Vertex, "extrude_x") },
};

/// One tile's layout: the geometry builder plus the C views handed back to
/// the host in finish_layout, which must outlive the callback until destroy.
const TileLayout = struct {
    geometry: layout.Layout,
    points: std.ArrayList(layout.Point) = .empty,
    rings: std.ArrayList([]const layout.Point) = .empty,
    segments: std.ArrayList(c.mln_plugin_segment_v1) = .empty,
    ranges: std.ArrayList(c.mln_plugin_feature_vertex_range_v1) = .empty,
    stream: c.mln_plugin_vertex_stream_v1 = undefined,
    drawable: c.mln_plugin_drawable_descriptor_v1 = undefined,

    fn deinit(self: *TileLayout) void {
        const a = self.geometry.allocator;
        self.geometry.deinit();
        self.points.deinit(a);
        self.rings.deinit(a);
        self.segments.deinit(a);
        self.ranges.deinit(a);
    }
};

const allocator = std.heap.c_allocator;

fn createLayout(context: [*c]const c.mln_plugin_layout_context_v1, instance: [*c]?*anyopaque) callconv(.c) c.mln_plugin_status {
    if (context == null or instance == null or context.*.struct_size < @sizeOf(c.mln_plugin_layout_context_v1) or context.*.extent == 0) return c.MLN_PLUGIN_STATUS_INVALID_ARGUMENT;
    const tile = allocator.create(TileLayout) catch return c.MLN_PLUGIN_STATUS_CALLBACK_ERROR;
    tile.* = .{ .geometry = layout.Layout.init(allocator, context.*.extent) };
    instance.* = tile;
    return c.MLN_PLUGIN_STATUS_OK;
}

fn layoutFeature(instance: ?*anyopaque, feature: [*c]const c.mln_plugin_feature_v1) callconv(.c) c.mln_plugin_status {
    const tile: *TileLayout = @ptrCast(@alignCast(instance orelse return c.MLN_PLUGIN_STATUS_INVALID_ARGUMENT));
    if (feature == null or feature.*.struct_size < @sizeOf(c.mln_plugin_feature_v1)) return c.MLN_PLUGIN_STATUS_INVALID_ARGUMENT;
    const f = feature.*;
    if (f.geometry_type != c.MLN_PLUGIN_GEOMETRY_POLYGON or f.path_count == 0) return c.MLN_PLUGIN_STATUS_OK;
    if (f.points == null or f.path_offsets == null) return c.MLN_PLUGIN_STATUS_INVALID_ARGUMENT;
    const offsets = f.path_offsets[0 .. f.path_count + 1];
    if (offsets[f.path_count] != f.point_count) return c.MLN_PLUGIN_STATUS_INVALID_ARGUMENT;
    tile.points.clearRetainingCapacity();
    tile.rings.clearRetainingCapacity();
    tile.points.ensureTotalCapacity(allocator, f.point_count) catch return c.MLN_PLUGIN_STATUS_CALLBACK_ERROR;
    for (f.points[0..f.point_count]) |p| tile.points.appendAssumeCapacity(.{ .x = @floatFromInt(p.x), .y = @floatFromInt(p.y) });
    for (0..f.path_count) |i| {
        if (offsets[i] > offsets[i + 1]) return c.MLN_PLUGIN_STATUS_INVALID_ARGUMENT;
        tile.rings.append(allocator, tile.points.items[offsets[i]..offsets[i + 1]]) catch return c.MLN_PLUGIN_STATUS_CALLBACK_ERROR;
    }
    tile.geometry.addPolygon(tile.rings.items, f.feature_index) catch return c.MLN_PLUGIN_STATUS_CALLBACK_ERROR;
    return c.MLN_PLUGIN_STATUS_OK;
}

fn finishLayout(instance: ?*anyopaque, bucket: [*c]c.mln_plugin_bucket_v1) callconv(.c) c.mln_plugin_status {
    const tile: *TileLayout = @ptrCast(@alignCast(instance orelse return c.MLN_PLUGIN_STATUS_INVALID_ARGUMENT));
    if (bucket == null or bucket.*.struct_size < @sizeOf(c.mln_plugin_bucket_v1)) return c.MLN_PLUGIN_STATUS_INVALID_ARGUMENT;
    const geometry = &tile.geometry;
    tile.segments.clearRetainingCapacity();
    tile.ranges.clearRetainingCapacity();
    for (geometry.segments.items) |segment| {
        if (segment.index_length == 0) continue;
        tile.segments.append(allocator, .{ .struct_size = @sizeOf(c.mln_plugin_segment_v1), .vertex_offset = segment.vertex_offset, .index_offset = segment.index_offset, .vertex_length = segment.vertex_length, .index_length = segment.index_length }) catch return c.MLN_PLUGIN_STATUS_CALLBACK_ERROR;
    }
    for (geometry.ranges.items) |range| {
        tile.ranges.append(allocator, .{ .struct_size = @sizeOf(c.mln_plugin_feature_vertex_range_v1), .feature_index = range.feature_index, .drawable_key = 1, .first_vertex = range.first_vertex, .vertex_count = range.vertex_count }) catch return c.MLN_PLUGIN_STATUS_CALLBACK_ERROR;
    }
    const vertices = geometry.vertices.items;
    tile.stream = .{ .struct_size = @sizeOf(c.mln_plugin_vertex_stream_v1), .stream_id = 0, .data = @ptrCast(vertices.ptr), .data_size = vertices.len * @sizeOf(Vertex), .vertex_count = @intCast(vertices.len), .stride = @sizeOf(Vertex) };
    tile.drawable = .{ .struct_size = @sizeOf(c.mln_plugin_drawable_descriptor_v1), .drawable_key = 1, .shader_id = str("shore"), .attributes = &attribute_bindings, .attribute_count = attribute_bindings.len, .segments = tile.segments.items.ptr, .segment_count = tile.segments.items.len };
    const empty = vertices.len == 0 or tile.segments.items.len == 0;
    bucket.* = .{
        .struct_size = @sizeOf(c.mln_plugin_bucket_v1),
        .vertex_streams = if (empty) null else &tile.stream,
        .vertex_stream_count = if (empty) 0 else 1,
        .indices = geometry.indices.items.ptr,
        .index_count = if (empty) 0 else geometry.indices.items.len,
        .drawables = if (empty) null else &tile.drawable,
        .drawable_count = if (empty) 0 else 1,
        .query_radius = 0,
        .feature_vertex_ranges = if (empty) null else tile.ranges.items.ptr,
        .feature_vertex_range_count = if (empty) 0 else tile.ranges.items.len,
    };
    return c.MLN_PLUGIN_STATUS_OK;
}

fn destroyLayout(instance: ?*anyopaque) callconv(.c) void {
    const tile: *TileLayout = @ptrCast(@alignCast(instance orelse return));
    tile.deinit();
    allocator.destroy(tile);
}

// ---------------------------------------------------------------------------
// Render-thread callbacks.
// ---------------------------------------------------------------------------

/// The time wraps every 4096 s so it keeps sub-millisecond precision as a
/// float; the shader only uses it through periodic functions of the phase.
pub const time_wrap_seconds: f64 = 4096;

/// Seconds from a monotonic clock, for the animation. The plugin keeps no
/// frame state, and tile-driven layers get no timestamp from the host.
fn monotonicSeconds() f64 {
    if (builtin.os.tag == .windows) {
        const windows = std.os.windows;
        var counter: windows.LARGE_INTEGER = 0;
        var frequency: windows.LARGE_INTEGER = 1;
        _ = windows.kernel32.QueryPerformanceCounter(&counter);
        _ = windows.kernel32.QueryPerformanceFrequency(&frequency);
        return @as(f64, @floatFromInt(counter)) / @as(f64, @floatFromInt(frequency));
    }
    var ts: std.c.timespec = undefined;
    if (std.c.clock_gettime(.MONOTONIC, &ts) != 0) return 0;
    return @as(f64, @floatFromInt(ts.sec)) + @as(f64, @floatFromInt(ts.nsec)) / 1e9;
}

fn updateUniformBlock(context: [*c]const c.mln_plugin_uniform_context_v1, uniform_id: u32, output: [*c]u8, output_size: usize) callconv(.c) c.mln_plugin_status {
    if (context == null or context.*.struct_size < @sizeOf(c.mln_plugin_uniform_context_v1) or uniform_id != 0 or output == null or output_size != @sizeOf(DrawableUBO)) return c.MLN_PLUGIN_STATUS_INVALID_ARGUMENT;
    var block = std.mem.zeroes(DrawableUBO);
    block.matrix = context.*.tile_matrix;
    block.camera = .{ context.*.pixels_to_tile_units, context.*.pixel_ratio, @floatCast(@mod(monotonicSeconds(), time_wrap_seconds)), 8192 };
    @memcpy(output[0..output_size], std.mem.asBytes(&block));
    return c.MLN_PLUGIN_STATUS_OK;
}

fn value(props: []const c.mln_plugin_property_value_v1, comptime name: []const u8) ?c.mln_plugin_value {
    for (props) |property| {
        if (property.name.size == name.len and property.name.data != null and std.mem.eql(u8, property.name.data[0..name.len], name)) return property.value;
    }
    return null;
}

/// The map keeps repainting while crests move; a zero speed freezes every
/// animation, so the layer then renders like a static style layer.
fn shouldAnimate(props: [*c]const c.mln_plugin_property_value_v1, count: usize) callconv(.c) u8 {
    if (props == null or count == 0) return 0;
    const speed = value(props[0..count], "wave-speed") orelse return 0;
    const opacity = value(props[0..count], "opacity") orelse return 0;
    return @intFromBool(speed.data.float_value != 0 and opacity.data.float_value > 0);
}

const layer_type = c.mln_plugin_layer_type_v1{
    .struct_size = @sizeOf(c.mln_plugin_layer_type_v1),
    .layer_type = str(layer_type_name),
    .backend_mask = c.MLN_PLUGIN_BACKEND_OPENGL | c.MLN_PLUGIN_BACKEND_VULKAN | c.MLN_PLUGIN_BACKEND_METAL,
    .properties = &property_descriptors,
    .property_count = property_descriptors.len,
    .geometry_type_mask = c.MLN_PLUGIN_GEOMETRY_POLYGON,
    .shaders = &shaders,
    .shader_count = shaders.len,
    .create_layout = createLayout,
    .layout_feature = layoutFeature,
    .finish_layout = finishLayout,
    .destroy_layout = destroyLayout,
    .query_feature = null,
    .update_uniform_block = updateUniformBlock,
    .get_query_radius = null,
    .should_animate = shouldAnimate,
    .source_free = 0,
    .build_frame = null,
};

const plugin_descriptor = c.mln_plugin_descriptor_v1{
    .struct_size = @sizeOf(c.mln_plugin_descriptor_v1),
    .abi_version = c.MLN_PLUGIN_ABI_VERSION_1,
    .plugin_id = str(plugin_id),
    .plugin_version = str(plugin_version),
    .minimum_host_abi = c.MLN_PLUGIN_ABI_VERSION_1,
    .maximum_host_abi = c.MLN_PLUGIN_ABI_VERSION_1,
    .layer_types = &layer_type,
    .layer_type_count = 1,
};

/// The plugin's entry point. The host resolves this symbol from the shared
/// library and passes its own register function, so the plugin binary never
/// links maplibre-native-c.
export fn mln_water_register(
    register_fn: c.mln_plugin_register_function_v1,
    error_message: [*c]u8,
    error_message_capacity: usize,
) c.mln_plugin_status {
    const register_impl = register_fn orelse return c.MLN_PLUGIN_STATUS_INVALID_ARGUMENT;
    return register_impl(&plugin_descriptor, error_message, error_message_capacity);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

test {
    _ = layout;
}

fn jsonNumber(v: std.json.Value) f64 {
    return switch (v) {
        .integer => |i| @floatFromInt(i),
        .float => |f| f,
        else => std.math.nan(f64),
    };
}

test "descriptors match the shared spec" {
    const testing_allocator = std.testing.allocator;
    var parsed = try std.json.parseFromSlice(std.json.Value, testing_allocator, build_options.spec_json, .{});
    defer parsed.deinit();
    const spec = parsed.value.object;
    try std.testing.expectEqualStrings(layer_type_name, spec.get("layerType").?.string);
    try std.testing.expectEqualStrings("polygon", spec.get("geometry").?.string);
    const native = spec.get("native").?.object;
    try std.testing.expectEqualStrings(plugin_id, native.get("pluginId").?.string);
    try std.testing.expectEqualStrings(plugin_version, native.get("pluginVersion").?.string);
    try std.testing.expectEqualStrings("mln_water_register", native.get("entryPoint").?.string);

    const paint = spec.get("paint").?.object;
    try std.testing.expectEqual(paint.count(), property_descriptors.len);
    // Declaration order is the host's property order; keep it identical.
    var it = paint.iterator();
    var index: usize = 0;
    while (it.next()) |entry| : (index += 1) {
        const d = property_descriptors[index];
        try std.testing.expectEqualStrings(entry.key_ptr.*, d.name.data[0..d.name.size]);
        const property = entry.value_ptr.object;
        const type_name = property.get("type").?.string;
        const default = property.get("default").?;
        if (std.mem.eql(u8, type_name, "float")) {
            try std.testing.expectEqual(@as(c_uint, c.MLN_PLUGIN_VALUE_FLOAT), d.type);
            try std.testing.expectApproxEqAbs(@as(f32, @floatCast(jsonNumber(default))), d.default_value.data.float_value, 1e-6);
        } else if (std.mem.eql(u8, type_name, "color")) {
            try std.testing.expectEqual(@as(c_uint, c.MLN_PLUGIN_VALUE_COLOR), d.type);
            const rgba = default.array.items;
            const actual = d.default_value.data.color_value;
            try std.testing.expectApproxEqAbs(@as(f32, @floatCast(jsonNumber(rgba[0]))), actual.r, 1e-6);
            try std.testing.expectApproxEqAbs(@as(f32, @floatCast(jsonNumber(rgba[1]))), actual.g, 1e-6);
            try std.testing.expectApproxEqAbs(@as(f32, @floatCast(jsonNumber(rgba[2]))), actual.b, 1e-6);
            try std.testing.expectApproxEqAbs(@as(f32, @floatCast(jsonNumber(rgba[3]))), actual.a, 1e-6);
        } else return error.UnknownSpecType;
        const minimum = property.get("minimum");
        const maximum = property.get("maximum");
        try std.testing.expectEqual(@as(u8, if (minimum != null) 1 else 0), d.has_minimum);
        try std.testing.expectEqual(@as(u8, if (maximum != null) 1 else 0), d.has_maximum);
        if (minimum) |v| try std.testing.expectApproxEqAbs(@as(f32, @floatCast(jsonNumber(v))), d.minimum, 1e-6);
        if (maximum) |v| try std.testing.expectApproxEqAbs(@as(f32, @floatCast(jsonNumber(v))), d.maximum, 1e-6);
    }
}

test "property bindings cover every property with distinct uniform ranges" {
    var covered = std.mem.zeroes([@sizeOf(DrawableUBO)]u8);
    inline for (properties, 0..) |property, i| {
        const binding = property_bindings[i];
        const size: usize = if (property.kind == .color) 16 else 4;
        for (binding.uniform_byte_offset..binding.uniform_byte_offset + size) |j| {
            try std.testing.expectEqual(@as(u8, 0), covered[j]);
            covered[j] = 1;
        }
        for (binding.interpolation_uniform_byte_offset..binding.interpolation_uniform_byte_offset + 4) |j| {
            try std.testing.expectEqual(@as(u8, 0), covered[j]);
            covered[j] = 1;
        }
        try std.testing.expect(binding.maximum_attribute_id < attributes.len);
        // Colors need two endpoint attributes; scalars pack both into one.
        try std.testing.expectEqual(@as(u32, if (property.kind == .color) 1 else 0), binding.maximum_attribute_id - binding.minimum_attribute_id);
        const minimum = attributes[binding.minimum_attribute_id];
        try std.testing.expectEqualStrings(attributeName(property, 0), minimum.name.data[0..minimum.name.size]);
    }
    // The plugin-owned fields stay clear of the host's ranges.
    for (0..@offsetOf(DrawableUBO, "shore_color")) |i| try std.testing.expectEqual(@as(u8, 0), covered[i]);
    try std.testing.expectEqual(@as(usize, 13), attributes.len);
    for (attributes, 0..) |attribute, i| try std.testing.expectEqual(@as(u32, @intCast(i)), attribute.attribute_id);
}

test "shader sources declare the expected interface" {
    const gl = glslVertex(false);
    try std.testing.expect(std.mem.indexOf(u8, gl, "layout(std140) uniform ShoreDrawableUBO") != null);
    try std.testing.expect(std.mem.indexOf(u8, gl, "#if !MLN_PLUGIN_PROPERTY_SHORE_WIDTH_IS_UNIFORM\nin vec2 a_shore_width;") != null);
    try std.testing.expect(std.mem.indexOf(u8, gl, "in vec4 a_foam_color_min;\nin vec4 a_foam_color_max;") != null);
    const vk = glslVertex(true);
    try std.testing.expect(std.mem.indexOf(u8, vk, "set = DRAWABLE_UBO_SET_INDEX, binding = MLN_PLUGIN_UNIFORM_0_BINDING") != null);
    try std.testing.expect(std.mem.indexOf(u8, vk, "applySurfaceTransform();") != null);
    try std.testing.expect(std.mem.indexOf(u8, glslFragment(true), "layout(location=0) out vec4 fragColor;") != null);
    try std.testing.expect(std.mem.indexOf(u8, metal, "[[buffer(MLN_PLUGIN_UNIFORM_0_BINDING)]]") != null);
    try std.testing.expect(std.mem.indexOf(u8, metal, "float4 a_shore_color_min [[attribute(3)]];\n    float4 a_shore_color_max [[attribute(4)]];") != null);
    try std.testing.expect(std.mem.indexOf(u8, metal, "float2 a_wave_count [[attribute(7)]];") != null);
}

fn testFeature(points: []const c.mln_plugin_tile_point_v1, offsets: []const u32, index: u64) c.mln_plugin_feature_v1 {
    return .{
        .struct_size = @sizeOf(c.mln_plugin_feature_v1),
        .geometry_type = c.MLN_PLUGIN_GEOMETRY_POLYGON,
        .feature_index = index,
        .points = points.ptr,
        .point_count = points.len,
        .path_offsets = offsets.ptr,
        .path_count = offsets.len - 1,
    };
}

test "layout callbacks build a bucket the host accepts" {
    const context = c.mln_plugin_layout_context_v1{ .struct_size = @sizeOf(c.mln_plugin_layout_context_v1), .zoom = 12, .extent = 8192 };
    var instance: ?*anyopaque = null;
    try std.testing.expectEqual(@as(c.mln_plugin_status, c.MLN_PLUGIN_STATUS_OK), createLayout(&context, &instance));
    defer destroyLayout(instance);
    // A lake with an island: an exterior ring and a hole, plus a point
    // feature the polygon-only mask ignores.
    const points = [_]c.mln_plugin_tile_point_v1{
        .{ .x = 1000, .y = 1000 }, .{ .x = 7000, .y = 1000 }, .{ .x = 7000, .y = 7000 }, .{ .x = 1000, .y = 7000 }, .{ .x = 1000, .y = 1000 },
        .{ .x = 3000, .y = 3000 }, .{ .x = 3000, .y = 5000 }, .{ .x = 5000, .y = 5000 }, .{ .x = 5000, .y = 3000 }, .{ .x = 3000, .y = 3000 },
    };
    const offsets = [_]u32{ 0, 5, 10 };
    try std.testing.expectEqual(@as(c.mln_plugin_status, c.MLN_PLUGIN_STATUS_OK), layoutFeature(instance, &testFeature(&points, &offsets, 4)));
    var point_feature = testFeature(points[0..1], &[_]u32{ 0, 1 }, 5);
    point_feature.geometry_type = c.MLN_PLUGIN_GEOMETRY_POINT;
    try std.testing.expectEqual(@as(c.mln_plugin_status, c.MLN_PLUGIN_STATUS_OK), layoutFeature(instance, &point_feature));

    var bucket = std.mem.zeroes(c.mln_plugin_bucket_v1);
    bucket.struct_size = @sizeOf(c.mln_plugin_bucket_v1);
    try std.testing.expectEqual(@as(c.mln_plugin_status, c.MLN_PLUGIN_STATUS_OK), finishLayout(instance, &bucket));
    try std.testing.expectEqual(@as(usize, 1), bucket.vertex_stream_count);
    try std.testing.expectEqual(@as(usize, 1), bucket.drawable_count);
    const stream = bucket.vertex_streams[0];
    try std.testing.expectEqual(@as(u32, 10 + 30), stream.vertex_count);
    try std.testing.expectEqual(@as(usize, stream.vertex_count * @sizeOf(Vertex)), stream.data_size);
    try std.testing.expectEqual(@as(u32, @sizeOf(Vertex)), stream.stride);
    // One range covers every vertex of the only polygon feature.
    try std.testing.expectEqual(@as(usize, 1), bucket.feature_vertex_range_count);
    try std.testing.expectEqual(@as(u64, 4), bucket.feature_vertex_ranges[0].feature_index);
    try std.testing.expectEqual(@as(u32, 0), bucket.feature_vertex_ranges[0].first_vertex);
    try std.testing.expectEqual(stream.vertex_count, bucket.feature_vertex_ranges[0].vertex_count);
    const drawable = bucket.drawables[0];
    try std.testing.expectEqual(@as(usize, 1), drawable.segment_count);
    try std.testing.expectEqual(stream.vertex_count, drawable.segments[0].vertex_length);
    try std.testing.expectEqual(@as(usize, drawable.segments[0].index_length), bucket.index_count);
    for (bucket.indices[0..bucket.index_count]) |index| try std.testing.expect(index < drawable.segments[0].vertex_length);
    try std.testing.expectEqual(@as(usize, 2), drawable.attribute_count);

    // An empty tile reports no drawables rather than empty streams.
    var empty_instance: ?*anyopaque = null;
    try std.testing.expectEqual(@as(c.mln_plugin_status, c.MLN_PLUGIN_STATUS_OK), createLayout(&context, &empty_instance));
    defer destroyLayout(empty_instance);
    var empty = std.mem.zeroes(c.mln_plugin_bucket_v1);
    empty.struct_size = @sizeOf(c.mln_plugin_bucket_v1);
    try std.testing.expectEqual(@as(c.mln_plugin_status, c.MLN_PLUGIN_STATUS_OK), finishLayout(empty_instance, &empty));
    try std.testing.expectEqual(@as(usize, 0), empty.drawable_count);
    try std.testing.expectEqual(@as(usize, 0), empty.vertex_stream_count);
}

test "uniform block carries the tile matrix and a wrapped clock" {
    var context = std.mem.zeroes(c.mln_plugin_uniform_context_v1);
    context.struct_size = @sizeOf(c.mln_plugin_uniform_context_v1);
    context.pixels_to_tile_units = 16;
    context.pixel_ratio = 2;
    for (0..16) |i| context.tile_matrix[i] = @floatFromInt(i);
    var output: [@sizeOf(DrawableUBO)]u8 = undefined;
    try std.testing.expectEqual(@as(c.mln_plugin_status, c.MLN_PLUGIN_STATUS_OK), updateUniformBlock(&context, 0, &output, output.len));
    const block: *const DrawableUBO = @ptrCast(@alignCast(&output));
    try std.testing.expectEqual(@as(f32, 5), block.matrix[5]);
    try std.testing.expectEqual(@as(f32, 16), block.camera[0]);
    try std.testing.expectEqual(@as(f32, 2), block.camera[1]);
    try std.testing.expect(block.camera[2] >= 0 and block.camera[2] < time_wrap_seconds);
    try std.testing.expectEqual(@as(f32, 8192), block.camera[3]);
    try std.testing.expectEqual(@as(c.mln_plugin_status, c.MLN_PLUGIN_STATUS_INVALID_ARGUMENT), updateUniformBlock(&context, 1, &output, output.len));
    try std.testing.expectEqual(@as(c.mln_plugin_status, c.MLN_PLUGIN_STATUS_INVALID_ARGUMENT), updateUniformBlock(&context, 0, &output, output.len - 1));
}

test "animation follows wave speed and opacity" {
    var props: [properties.len]c.mln_plugin_property_value_v1 = undefined;
    for (property_descriptors, 0..) |d, i| props[i] = .{ .struct_size = @sizeOf(c.mln_plugin_property_value_v1), .name = d.name, .value = d.default_value };
    try std.testing.expectEqual(@as(u8, 1), shouldAnimate(&props, props.len));
    props[4].value.data.float_value = 0;
    try std.testing.expectEqual(@as(u8, 0), shouldAnimate(&props, props.len));
    props[4].value.data.float_value = -1;
    try std.testing.expectEqual(@as(u8, 1), shouldAnimate(&props, props.len));
    props[8].value.data.float_value = 0;
    try std.testing.expectEqual(@as(u8, 0), shouldAnimate(&props, props.len));
}
