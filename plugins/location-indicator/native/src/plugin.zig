//! Source-free procedural location indicator for MapLibre Native's plugin ABI.
//! Frame callbacks produce complete clip-space vertices; no layer state
//! survives between plugin callbacks. See ../../spec.json for the contract
//! this file shares with the maplibre-gl-js implementation.

const std = @import("std");
const build_options = @import("build_options");
const c = @import("maplibre_native_c");

pub const layer_type_name = "location-puck";
pub const plugin_id = "org.maplibre.plugins.location-puck";
pub const plugin_version = "0.1.0";

fn str(comptime text: []const u8) c.mln_plugin_string {
    return .{ .data = text.ptr, .size = text.len };
}

// The shared fragment function (shaders/puck.glsl) compiles as GLSL and MSL.
const fragment = build_options.shade_glsl;

fn glslVertex(comptime vulkan: bool) []const u8 {
    return (if (vulkan)
        "layout(location=0) in vec4 a_position;\nlayout(location=1) in vec2 a_point;\nlayout(location=2) in vec4 a_style;\nlayout(location=3) in vec4 a_fill;\nlayout(location=4) in vec4 a_border;\n"
    else
        "in vec4 a_position;\nin vec2 a_point;\nin vec4 a_style;\nin vec4 a_fill;\nin vec4 a_border;\n") ++
        glslVaryings(vulkan, "out") ++
        "void main() { gl_Position=a_position; v_point=a_point; v_style=a_style; v_fill=a_fill; v_border=a_border;\n" ++
        (if (vulkan) "gl_Position.z=0.0; applySurfaceTransform();\n" else "gl_Position.z=-gl_Position.w;\n") ++ "}\n";
}

fn glslVaryings(comptime vulkan: bool, comptime direction: []const u8) []const u8 {
    return (if (vulkan) "layout(location=0) " else "") ++ direction ++ " vec2 v_point;\n" ++
        (if (vulkan) "layout(location=1) " else "") ++ direction ++ " vec4 v_style;\n" ++
        (if (vulkan) "layout(location=2) " else "") ++ direction ++ " vec4 v_fill;\n" ++
        (if (vulkan) "layout(location=3) " else "") ++ direction ++ " vec4 v_border;\n";
}

fn glslFragment(comptime vulkan: bool) []const u8 {
    return glslVaryings(vulkan, "in") ++
        (if (vulkan) "layout(location=0) out vec4 fragColor;\n" else "") ++
        "#define float2 vec2\n#define float4 vec4\n#define DX dFdx\n#define DY dFdy\n#define ATAN atan\n" ++ fragment ++
        "\nvoid main() { fragColor=shade(v_point,v_style,v_fill,v_border); }\n";
}

const metal =
    \\#define DX dfdx
    \\#define DY dfdy
    \\#define ATAN atan2
    \\struct VertexIn {
    \\    float4 position [[attribute(0)]];
    \\    float2 point [[attribute(1)]];
    \\    float4 style [[attribute(2)]];
    \\    float4 fill [[attribute(3)]];
    \\    float4 border [[attribute(4)]];
    \\};
    \\struct VertexOut {
    \\    float4 position [[position]];
    \\    float2 point;
    \\    float4 style;
    \\    float4 fill;
    \\    float4 border;
    \\};
    \\vertex VertexOut puckVertex(VertexIn v [[stage_in]]) {
    \\    return {float4(v.position.xy,0.0,v.position.w),v.point,v.style,v.fill,v.border};
    \\}
++ "\n" ++ fragment ++
    \\fragment float4 puckFragment(VertexOut v [[stage_in]]) {
    \\    return shade(v.point,v.style,v.fill,v.border);
    \\}
;

const sources = [_]c.mln_plugin_shader_source_v1{
    .{ .struct_size = @sizeOf(c.mln_plugin_shader_source_v1), .backend = c.MLN_PLUGIN_BACKEND_OPENGL, .vertex_source = str(glslVertex(false)), .fragment_source = str(glslFragment(false)) },
    .{ .struct_size = @sizeOf(c.mln_plugin_shader_source_v1), .backend = c.MLN_PLUGIN_BACKEND_VULKAN, .vertex_source = str(glslVertex(true)), .fragment_source = str(glslFragment(true)) },
    .{ .struct_size = @sizeOf(c.mln_plugin_shader_source_v1), .backend = c.MLN_PLUGIN_BACKEND_METAL, .vertex_source = str(metal), .vertex_entry_point = str("puckVertex"), .fragment_entry_point = str("puckFragment") },
};

const Vertex = extern struct {
    position: [4]f32,
    point: [2]f32,
    style: [4]f32,
    fill: [4]f32,
    border: [4]f32,
};

const attributes = blk: {
    var result: [5]c.mln_plugin_shader_attribute_v1 = undefined;
    for (.{ "position", "point", "style", "fill", "border" }, 0..) |name, i| {
        result[i] = .{ .struct_size = @sizeOf(c.mln_plugin_shader_attribute_v1), .attribute_id = i, .location = i, .name = str("a_" ++ name), .type = if (i == 1) c.MLN_PLUGIN_VERTEX_FLOAT_X2 else c.MLN_PLUGIN_VERTEX_FLOAT_X4 };
    }
    break :blk result;
};
const bindings = blk: {
    var result: [5]c.mln_plugin_attribute_binding_v1 = undefined;
    for (.{ "position", "point", "style", "fill", "border" }, 0..) |name, i| {
        result[i] = .{ .struct_size = @sizeOf(c.mln_plugin_attribute_binding_v1), .attribute_id = i, .stream_id = 0, .byte_offset = @offsetOf(Vertex, name) };
    }
    break :blk result;
};
const shaders = [_]c.mln_plugin_shader_descriptor_v1{.{
    .struct_size = @sizeOf(c.mln_plugin_shader_descriptor_v1),
    .shader_id = str("puck"),
    .sources = &sources,
    .source_count = sources.len,
    .attributes = &attributes,
    .attribute_count = attributes.len,
}};

fn floatProperty(
    comptime name: []const u8,
    comptime default: f32,
    comptime minimum: ?f32,
    comptime maximum: ?f32,
) c.mln_plugin_property_descriptor_v1 {
    return .{
        .struct_size = @sizeOf(c.mln_plugin_property_descriptor_v1),
        .name = str(name),
        .type = c.MLN_PLUGIN_VALUE_FLOAT,
        .default_value = .{
            .struct_size = @sizeOf(c.mln_plugin_value),
            .type = c.MLN_PLUGIN_VALUE_FLOAT,
            .data = .{ .float_value = default },
        },
        .expression_capabilities = c.MLN_PLUGIN_EXPRESSION_CAMERA,
        .supports_transitions = 1,
        .has_minimum = if (minimum != null) 1 else 0,
        .has_maximum = if (maximum != null) 1 else 0,
        .minimum = minimum orelse 0,
        .maximum = maximum orelse 0,
        .enum_values = null,
        .enum_value_count = 0,
    };
}

fn rotationProperty(comptime name: []const u8) c.mln_plugin_property_descriptor_v1 {
    var property = floatProperty(name, 0, null, null);
    property.type = c.MLN_PLUGIN_VALUE_ROTATION;
    property.default_value.type = c.MLN_PLUGIN_VALUE_ROTATION;
    return property;
}

fn colorProperty(
    comptime name: []const u8,
    comptime r: f32,
    comptime g: f32,
    comptime b: f32,
    comptime a: f32,
) c.mln_plugin_property_descriptor_v1 {
    return .{
        .struct_size = @sizeOf(c.mln_plugin_property_descriptor_v1),
        .name = str(name),
        .type = c.MLN_PLUGIN_VALUE_COLOR,
        .default_value = .{
            .struct_size = @sizeOf(c.mln_plugin_value),
            .type = c.MLN_PLUGIN_VALUE_COLOR,
            .data = .{ .color_value = .{ .r = r, .g = g, .b = b, .a = a } },
        },
        .expression_capabilities = c.MLN_PLUGIN_EXPRESSION_CAMERA,
        .supports_transitions = 1,
        .has_minimum = 0,
        .has_maximum = 0,
        .minimum = 0,
        .maximum = 0,
        .enum_values = null,
        .enum_value_count = 0,
    };
}

// Keep in sync with ../../spec.json; the "descriptors match the shared spec"
// test enforces it.
const property_descriptors = [_]c.mln_plugin_property_descriptor_v1{
    .{
        .struct_size = @sizeOf(c.mln_plugin_property_descriptor_v1),
        .name = str("position"),
        .type = c.MLN_PLUGIN_VALUE_DOUBLE2,
        .default_value = .{
            .struct_size = @sizeOf(c.mln_plugin_value),
            .type = c.MLN_PLUGIN_VALUE_DOUBLE2,
            .data = .{ .double2_value = .{ .x = 0, .y = 0 } },
        },
        .expression_capabilities = c.MLN_PLUGIN_EXPRESSION_CAMERA,
        .supports_transitions = 1,
        .has_minimum = 0,
        .has_maximum = 0,
        .minimum = 0,
        .maximum = 0,
        .enum_values = null,
        .enum_value_count = 0,
    },
    rotationProperty("bearing"),
    floatProperty("perspective-compensation", 0.85, 0, 1),
    floatProperty("tilt-displacement", 0, 0, null),
    floatProperty("bearing-radius", 18, 0, null),
    floatProperty("bearing-visible", 0, 0, 1),
    floatProperty("accuracy-radius", 0, 0, null),
    floatProperty("accuracy-border-width", 0, 0, null),
    floatProperty("bearing-accuracy", 0, 0, 180),
    floatProperty("bearing-accuracy-radius", 64, 0, null),
    floatProperty("shadow-radius", 0, 0, null),
    floatProperty("puck-radius", 8, 0, null),
    floatProperty("puck-border-width", 2, 0, null),
    colorProperty("puck-color", 0.17, 0.54, 0.94, 1.0),
    colorProperty("puck-border-color", 1.0, 1.0, 1.0, 1.0),
    colorProperty("accuracy-color", 0.17, 0.54, 0.94, 0.15),
    colorProperty("accuracy-border-color", 0.17, 0.54, 0.94, 0.4),
    colorProperty("bearing-accuracy-color", 0.17, 0.54, 0.94, 0.3),
    colorProperty("bearing-arrow-color", 1.0, 1.0, 1.0, 1.0),
    colorProperty("shadow-color", 0.0, 0.0, 0.0, 0.25),
};

const accuracy_segments = 72;
const component_quads = 4;

const Frame = struct {
    vertices: [accuracy_segments * 3 + component_quads * 4]Vertex = undefined,
    indices: [accuracy_segments * 3 + component_quads * 6]u16 = undefined,
    vertex_count: u16 = 0,
    index_count: u16 = 0,
    segment: c.mln_plugin_segment_v1 = undefined,
    stream: c.mln_plugin_vertex_stream_v1 = undefined,
    drawable: c.mln_plugin_drawable_descriptor_v1 = undefined,
    query_points: [2][4]c.mln_plugin_double2 = undefined,
    query_polygons: [2]c.mln_plugin_query_polygon_v1 = undefined,
    query_count: usize = 0,
    feature: c.mln_plugin_frame_feature_v1 = undefined,
    feature_json: [256]u8 = undefined,
    feature_json_size: usize = 0,

    fn append(self: *Frame, positions: []const [4]f64, points: []const [2]f64, style: [4]f32, fill: [4]f32, border: [4]f32) void {
        const base = self.vertex_count;
        for (positions, points) |position, point| {
            self.vertices[self.vertex_count] = .{ .position = .{ @floatCast(position[0]), @floatCast(position[1]), @floatCast(position[2]), @floatCast(position[3]) }, .point = .{ @floatCast(point[0]), @floatCast(point[1]) }, .style = style, .fill = fill, .border = border };
            self.vertex_count += 1;
        }
        const offsets = [_]u16{ 0, 1, 2, 0, 2, 3 };
        for (offsets[0..if (positions.len == 3) @as(usize, 3) else 6]) |offset| {
            self.indices[self.index_count] = base + offset;
            self.index_count += 1;
        }
    }

    fn quad(self: *Frame, center: [4]f64, x: [4]f64, y: [4]f64, style: [4]f32, fill: [4]f32, border: [4]f32) void {
        const corners = [4][2]f64{ .{ -1.15, -1.15 }, .{ 1.15, -1.15 }, .{ 1.15, 1.15 }, .{ -1.15, 1.15 } };
        var positions: [4][4]f64 = undefined;
        for (corners, 0..) |corner, i| for (0..4) |j| {
            positions[i][j] = center[j] + corner[0] * x[j] + corner[1] * y[j];
        };
        self.append(&positions, &corners, style, fill, border);
    }

    fn queryQuad(self: *Frame, center: [2]f64, radius: f64, bearing: f64) void {
        const axes = rotate(.{ radius, 0, 0, 0 }, .{ 0, radius, 0, 0 }, bearing);
        for ([_][2]f64{ .{ -1, -1 }, .{ 1, -1 }, .{ 1, 1 }, .{ -1, 1 } }, 0..) |corner, i| {
            self.query_points[self.query_count][i] = .{ .x = center[0] + corner[0] * axes[0][0] + corner[1] * axes[1][0], .y = center[1] + corner[0] * axes[0][1] + corner[1] * axes[1][1] };
        }
        self.query_polygons[self.query_count] = .{ .struct_size = @sizeOf(c.mln_plugin_query_polygon_v1), .points = &self.query_points[self.query_count], .point_count = 4 };
        self.query_count += 1;
    }

    fn output(self: *Frame, bucket: *c.mln_plugin_bucket_v1) void {
        self.segment = .{ .struct_size = @sizeOf(c.mln_plugin_segment_v1), .vertex_length = self.vertex_count, .index_length = self.index_count };
        self.stream = .{ .struct_size = @sizeOf(c.mln_plugin_vertex_stream_v1), .data = @ptrCast(&self.vertices), .data_size = self.vertex_count * @sizeOf(Vertex), .vertex_count = self.vertex_count, .stride = @sizeOf(Vertex) };
        self.drawable = .{ .struct_size = @sizeOf(c.mln_plugin_drawable_descriptor_v1), .drawable_key = 1, .shader_id = str("puck"), .attributes = &bindings, .attribute_count = bindings.len, .segments = &self.segment, .segment_count = 1 };
        self.feature = .{ .struct_size = @sizeOf(c.mln_plugin_frame_feature_v1), .geojson = .{ .data = &self.feature_json, .size = self.feature_json_size }, .polygons = &self.query_polygons, .polygon_count = self.query_count };
        bucket.* = .{ .struct_size = @sizeOf(c.mln_plugin_bucket_v1), .vertex_streams = &self.stream, .vertex_stream_count = 1, .indices = &self.indices, .index_count = self.index_count, .drawables = &self.drawable, .drawable_count = if (self.vertex_count == 0) 0 else 1, .frame_features = &self.feature, .frame_feature_count = if (self.query_count == 0) 0 else 1 };
    }
};

// The host copies this scratch output before calling another layer. Uniform
// callbacks never read it, and thread exit releases it without an allocation.
threadlocal var scratch: Frame = .{};

fn value(properties: []const c.mln_plugin_property_value_v1, comptime name: []const u8) c.mln_plugin_value {
    for (properties) |property| {
        if (property.name.size == name.len and property.name.data != null and std.mem.eql(u8, property.name.data[0..name.len], name)) return property.value;
    }
    unreachable; // The host supplies every declared property, including defaults.
}
fn number(properties: []const c.mln_plugin_property_value_v1, comptime name: []const u8) f64 {
    return value(properties, name).data.float_value;
}
fn color(properties: []const c.mln_plugin_property_value_v1, comptime name: []const u8, opacity: f64) [4]f32 {
    const v = value(properties, name).data.color_value;
    const a: f32 = @floatCast(opacity);
    return .{ v.r * a, v.g * a, v.b * a, v.a * a };
}
fn mul(v: [4]f64, scale: f64) [4]f64 {
    return .{ v[0] * scale, v[1] * scale, v[2] * scale, v[3] * scale };
}
fn rotate(x: [4]f64, y: [4]f64, angle: f64) [2][4]f64 {
    var result: [2][4]f64 = undefined;
    const sn = @sin(angle);
    const cs = @cos(angle);
    for (0..4) |i| {
        result[0][i] = x[i] * cs + y[i] * sn;
        result[1][i] = -x[i] * sn + y[i] * cs;
    }
    return result;
}

fn projectWorld(m: [16]f64, x: f64, y: f64) [4]f64 {
    var result: [4]f64 = undefined;
    for (0..4) |i| result[i] = m[i] * x + m[4 + i] * y + m[12 + i];
    return result;
}

fn buildFrame(context: [*c]const c.mln_plugin_frame_context_v1, bucket: [*c]c.mln_plugin_bucket_v1) callconv(.c) c.mln_plugin_status {
    if (context == null or bucket == null) return c.MLN_PLUGIN_STATUS_INVALID_ARGUMENT;
    const ctx: *const c.mln_plugin_frame_context_v1 = @ptrCast(context);
    if (ctx.struct_size < @sizeOf(c.mln_plugin_frame_context_v1) or ctx.project_mercator == null or ctx.destination == null or ctx.properties == null or ctx.property_count != property_descriptors.len or !(ctx.camera_to_center_distance > 0)) return c.MLN_PLUGIN_STATUS_INVALID_ARGUMENT;
    const props = ctx.properties[0..ctx.property_count];
    const pos = value(props, "position").data.double2_value;
    if (!std.math.isFinite(pos.x) or !std.math.isFinite(pos.y) or @abs(pos.x) > 90) return c.MLN_PLUGIN_STATUS_INVALID_ARGUMENT;
    var cx: f64 = 0;
    var cy: f64 = 0;
    ctx.project_mercator.?(ctx, pos.x, pos.y, &cx, &cy);
    const m = ctx.proj_matrix;
    const center = projectWorld(m, cx, cy);
    scratch.vertex_count = 0;
    scratch.index_count = 0;
    scratch.query_count = 0;
    if (!std.math.isFinite(center[3]) or center[3] <= 0 or ctx.viewport_width == 0 or ctx.viewport_height == 0) {
        scratch.output(@ptrCast(bucket));
        return c.MLN_PLUGIN_STATUS_OK;
    }
    const world_x: [4]f64 = m[0..4].*;
    const world_y: [4]f64 = m[4..8].*;
    // World pixels per screen pixel at the indicator: the perspective ratio
    // the built-in layers use, clip w over the camera-to-center distance.
    const pixel_world_size = center[3] / @as(f64, ctx.camera_to_center_distance);
    const compensation = number(props, "perspective-compensation");
    const scale = (1 - compensation) + std.math.clamp(pixel_world_size, 0.8, 10.1) * compensation;
    // Tilt displacement moves along screen-up on the ground. The host's bearing
    // is the negated camera bearing in radians, so screen-up in world pixels
    // (y down) is (-sin, -cos).
    const displacement = ctx.pitch * number(props, "tilt-displacement") * scale * pixel_world_size;
    const shift = [2]f64{ -@sin(ctx.bearing) * displacement, -@cos(ctx.bearing) * displacement };
    const top_world = [2]f64{ cx + shift[0], cy + shift[1] };
    const top = projectWorld(m, top_world[0], top_world[1]);
    const shadow_center = projectWorld(m, cx - shift[0], cy - shift[1]);
    const bearing = std.math.degreesToRadians(number(props, "bearing"));
    const ground_direction = rotate(mul(world_x, scale), mul(world_y, scale), bearing);
    const clear = [4]f32{ 0, 0, 0, 0 };
    const ratio: f32 = ctx.pixel_ratio;
    const accuracy = number(props, "accuracy-radius");
    if (accuracy > 0) {
        // Core constructs the accuracy boundary with CheapRuler destinations.
        // Extra extent leaves room for analytic coverage outside the true radius.
        for (0..accuracy_segments) |i| {
            var positions: [3][4]f64 = .{ center, undefined, undefined };
            var points: [3][2]f64 = .{ .{ 0, 0 }, undefined, undefined };
            for (0..2) |j| {
                const angle = @as(f64, @floatFromInt(i + j)) * 360.0 / accuracy_segments;
                var lat: f64 = 0;
                var lon: f64 = 0;
                ctx.destination.?(ctx, pos.x, pos.y, accuracy * 1.15, angle, &lat, &lon);
                if (!std.math.isFinite(lat) or !std.math.isFinite(lon) or @abs(lat) > 90) return c.MLN_PLUGIN_STATUS_INVALID_ARGUMENT;
                var x: f64 = 0;
                var y: f64 = 0;
                ctx.project_mercator.?(ctx, lat, lon, &x, &y);
                positions[j + 1] = projectWorld(m, x, y);
                points[j + 1] = .{ 1.15 * @sin(std.math.degreesToRadians(angle)), -1.15 * @cos(std.math.degreesToRadians(angle)) };
            }
            scratch.append(&positions, &points, .{ 0, @as(f32, @floatCast(number(props, "accuracy-border-width"))) * ratio, 0, 0 }, color(props, "accuracy-color", 1), color(props, "accuracy-border-color", 1));
        }
    }
    const visible = number(props, "bearing-visible");
    const sector_radius = number(props, "bearing-accuracy-radius");
    const sector_angle = number(props, "bearing-accuracy");
    if (visible > 0 and sector_radius > 0 and sector_angle > 0) {
        scratch.quad(center, mul(ground_direction[0], sector_radius), mul(ground_direction[1], sector_radius), .{ 1, 0, @floatCast(std.math.degreesToRadians(sector_angle)), 0 }, color(props, "bearing-accuracy-color", visible), clear);
    }
    const shadow = number(props, "shadow-radius");
    if (shadow > 0) scratch.quad(shadow_center, mul(ground_direction[0], shadow), mul(ground_direction[1], shadow), .{ 2, 0, 0, 0 }, color(props, "shadow-color", 1), clear);
    const radius = number(props, "puck-radius");
    const border = number(props, "puck-border-width");
    const outer = if (radius > 0) radius + border else 0;
    // The arrow rides with the puck: both lift under tilt displacement while
    // the shadow, accuracy circle, and sector stay on the ground.
    const arrow_radius = number(props, "bearing-radius");
    if (visible > 0 and arrow_radius > 0) {
        scratch.quad(top, mul(ground_direction[0], arrow_radius), mul(ground_direction[1], arrow_radius), .{ 3, 0, 0, 0 }, color(props, "bearing-arrow-color", visible), clear);
        scratch.queryQuad(top_world, arrow_radius * scale, bearing);
    }
    if (outer > 0) {
        scratch.quad(top, mul(ground_direction[0], outer), mul(ground_direction[1], outer), .{ 0, @floatCast(border / outer), 0, 1 }, color(props, "puck-color", 1), color(props, "puck-border-color", 1));
        scratch.queryQuad(top_world, outer * scale, bearing);
    }
    const json = std.fmt.bufPrint(&scratch.feature_json, "{{\"type\":\"Feature\",\"geometry\":{{\"type\":\"Point\",\"coordinates\":[{},{}]}},\"properties\":{{}}}}", .{ pos.y, pos.x }) catch return c.MLN_PLUGIN_STATUS_INVALID_ARGUMENT;
    scratch.feature_json_size = json.len;
    scratch.output(@ptrCast(bucket));
    return c.MLN_PLUGIN_STATUS_OK;
}

const layer_type = c.mln_plugin_layer_type_v1{
    .struct_size = @sizeOf(c.mln_plugin_layer_type_v1),
    .layer_type = str(layer_type_name),
    .backend_mask = c.MLN_PLUGIN_BACKEND_OPENGL | c.MLN_PLUGIN_BACKEND_VULKAN | c.MLN_PLUGIN_BACKEND_METAL,
    .properties = &property_descriptors,
    .property_count = property_descriptors.len,
    .geometry_type_mask = c.MLN_PLUGIN_GEOMETRY_POINT,
    .shaders = &shaders,
    .shader_count = shaders.len,
    .create_layout = null,
    .layout_feature = null,
    .finish_layout = null,
    .destroy_layout = null,
    .query_feature = null,
    .update_uniform_block = null,
    .get_query_radius = null,
    // No animation of its own: paint transitions repaint through the host.
    .should_animate = null,
    .source_free = 1,
    .build_frame = buildFrame,
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
export fn mln_location_puck_register(
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

fn testProject(_: [*c]const c.mln_plugin_frame_context_v1, latitude: f64, longitude: f64, x: [*c]f64, y: [*c]f64) callconv(.c) void {
    x[0] = longitude;
    y[0] = latitude;
}

fn testDestination(_: [*c]const c.mln_plugin_frame_context_v1, lat: f64, lon: f64, distance: f64, bearing: f64, out_lat: [*c]f64, out_lon: [*c]f64) callconv(.c) void {
    out_lat[0] = lat - distance / 100_000 * @cos(std.math.degreesToRadians(bearing));
    out_lon[0] = lon + distance / 100_000 * @sin(std.math.degreesToRadians(bearing));
}

fn testProperties() [property_descriptors.len]c.mln_plugin_property_value_v1 {
    var properties: [property_descriptors.len]c.mln_plugin_property_value_v1 = undefined;
    for (property_descriptors, 0..) |property, i| {
        properties[i] = .{ .struct_size = @sizeOf(c.mln_plugin_property_value_v1), .name = property.name, .value = property.default_value };
    }
    return properties;
}

fn testSet(properties: []c.mln_plugin_property_value_v1, name: []const u8, v: f64) void {
    for (properties) |*property| {
        if (std.mem.eql(u8, property.name.data[0..property.name.size], name)) property.value.data.float_value = @floatCast(v);
    }
}

fn testContext(properties: []const c.mln_plugin_property_value_v1) c.mln_plugin_frame_context_v1 {
    return .{
        .struct_size = @sizeOf(c.mln_plugin_frame_context_v1),
        .properties = properties.ptr,
        .property_count = properties.len,
        .viewport_width = 200,
        .viewport_height = 200,
        .pixel_ratio = 1,
        .pixels_to_gl_units = .{ 0.01, -0.01 },
        // Clip w is 1 everywhere, so one world pixel is one screen pixel.
        .camera_to_center_distance = 1,
        .proj_matrix = .{ 0.01, 0, 0, 0, 0, -0.01, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1 },
        .project_mercator = testProject,
        .destination = testDestination,
    };
}

test "descriptors match the shared spec" {
    const allocator = std.testing.allocator;
    var parsed = try std.json.parseFromSlice(std.json.Value, allocator, build_options.spec_json, .{});
    defer parsed.deinit();
    const spec = parsed.value.object;
    try std.testing.expectEqualStrings(layer_type_name, spec.get("layerType").?.string);
    const native = spec.get("native").?.object;
    try std.testing.expectEqualStrings(plugin_id, native.get("pluginId").?.string);
    try std.testing.expectEqualStrings(plugin_version, native.get("pluginVersion").?.string);
    try std.testing.expectEqualStrings("mln_location_puck_register", native.get("entryPoint").?.string);

    const paint = spec.get("paint").?.object;
    try std.testing.expectEqual(paint.count(), property_descriptors.len);
    // Declaration order is the host's property order; keep it identical.
    var it = paint.iterator();
    var index: usize = 0;
    while (it.next()) |entry| : (index += 1) {
        const descriptor = property_descriptors[index];
        try std.testing.expectEqualStrings(entry.key_ptr.*, descriptor.name.data[0..descriptor.name.size]);
        const property = entry.value_ptr.object;
        const type_name = property.get("type").?.string;
        const default = property.get("default").?;
        if (std.mem.eql(u8, type_name, "double2")) {
            try std.testing.expectEqual(@as(c_uint, c.MLN_PLUGIN_VALUE_DOUBLE2), descriptor.type);
            try std.testing.expectEqual(jsonNumber(default.array.items[0]), descriptor.default_value.data.double2_value.x);
            try std.testing.expectEqual(jsonNumber(default.array.items[1]), descriptor.default_value.data.double2_value.y);
        } else if (std.mem.eql(u8, type_name, "rotation")) {
            try std.testing.expectEqual(@as(c_uint, c.MLN_PLUGIN_VALUE_ROTATION), descriptor.type);
            try std.testing.expectApproxEqAbs(@as(f32, @floatCast(jsonNumber(default))), descriptor.default_value.data.float_value, 1e-6);
        } else if (std.mem.eql(u8, type_name, "float")) {
            try std.testing.expectEqual(@as(c_uint, c.MLN_PLUGIN_VALUE_FLOAT), descriptor.type);
            try std.testing.expectApproxEqAbs(@as(f32, @floatCast(jsonNumber(default))), descriptor.default_value.data.float_value, 1e-6);
        } else if (std.mem.eql(u8, type_name, "color")) {
            try std.testing.expectEqual(@as(c_uint, c.MLN_PLUGIN_VALUE_COLOR), descriptor.type);
            const rgba = default.array.items;
            const actual = descriptor.default_value.data.color_value;
            try std.testing.expectApproxEqAbs(@as(f32, @floatCast(jsonNumber(rgba[0]))), actual.r, 1e-6);
            try std.testing.expectApproxEqAbs(@as(f32, @floatCast(jsonNumber(rgba[1]))), actual.g, 1e-6);
            try std.testing.expectApproxEqAbs(@as(f32, @floatCast(jsonNumber(rgba[2]))), actual.b, 1e-6);
            try std.testing.expectApproxEqAbs(@as(f32, @floatCast(jsonNumber(rgba[3]))), actual.a, 1e-6);
        } else return error.UnknownSpecType;
        const minimum = property.get("minimum");
        const maximum = property.get("maximum");
        try std.testing.expectEqual(@as(u8, if (minimum != null) 1 else 0), descriptor.has_minimum);
        try std.testing.expectEqual(@as(u8, if (maximum != null) 1 else 0), descriptor.has_maximum);
        if (minimum) |v| try std.testing.expectApproxEqAbs(@as(f32, @floatCast(jsonNumber(v))), descriptor.minimum, 1e-6);
        if (maximum) |v| try std.testing.expectApproxEqAbs(@as(f32, @floatCast(jsonNumber(v))), descriptor.maximum, 1e-6);
    }
}

fn jsonNumber(v: std.json.Value) f64 {
    return switch (v) {
        .integer => |i| @floatFromInt(i),
        .float => |f| f,
        else => std.math.nan(f64),
    };
}

test "frames carry independent subpixel positions at large world coordinates" {
    var props = testProperties();
    props[0].value.data.double2_value = .{ .x = 0, .y = 1_000_000_000.25 };
    var ctx = testContext(&props);
    ctx.proj_matrix[12] = -10_000_000;
    var bucket = std.mem.zeroes(c.mln_plugin_bucket_v1);
    try std.testing.expectEqual(@as(c.mln_plugin_status, c.MLN_PLUGIN_STATUS_OK), buildFrame(&ctx, &bucket));
    const first = scratch.vertices;
    props[0].value.data.double2_value.y += 0.5;
    try std.testing.expectEqual(@as(c.mln_plugin_status, c.MLN_PLUGIN_STATUS_OK), buildFrame(&ctx, &bucket));
    for (0..4) |i| try std.testing.expectApproxEqAbs(@as(f32, 0.005), scratch.vertices[i].position[0] - first[i].position[0], 0.000001);
}

test "accuracy follows host destinations without integer quantization" {
    var props = testProperties();
    var ctx = testContext(&props);
    var bucket = std.mem.zeroes(c.mln_plugin_bucket_v1);
    for ([_]f64{ 0.001, 5000 }) |radius| {
        testSet(&props, "accuracy-radius", radius);
        try std.testing.expectEqual(@as(c.mln_plugin_status, c.MLN_PLUGIN_STATUS_OK), buildFrame(&ctx, &bucket));
        try std.testing.expectApproxEqRel(@as(f32, @floatCast(1.15 * radius / 100_000 * 0.01)), scratch.vertices[1].position[1], 0.000001);
        try std.testing.expectEqual(@as(u16, 220), scratch.vertex_count);
    }
}

test "hidden components and unusable positions emit no geometry" {
    var props = testProperties();
    testSet(&props, "puck-radius", 0);
    var ctx = testContext(&props);
    var bucket = std.mem.zeroes(c.mln_plugin_bucket_v1);
    try std.testing.expectEqual(@as(c.mln_plugin_status, c.MLN_PLUGIN_STATUS_OK), buildFrame(&ctx, &bucket));
    try std.testing.expectEqual(@as(usize, 0), bucket.drawable_count);
    testSet(&props, "puck-radius", 8);
    ctx.proj_matrix[15] = -1;
    try std.testing.expectEqual(@as(c.mln_plugin_status, c.MLN_PLUGIN_STATUS_OK), buildFrame(&ctx, &bucket));
    try std.testing.expectEqual(@as(usize, 0), bucket.drawable_count);
    props[0].value.data.double2_value.x = 91;
    try std.testing.expectEqual(@as(c.mln_plugin_status, c.MLN_PLUGIN_STATUS_INVALID_ARGUMENT), buildFrame(&ctx, &bucket));
}

test "tilt displacement lifts the puck and arrow and lowers the shadow" {
    var props = testProperties();
    testSet(&props, "shadow-radius", 12);
    testSet(&props, "tilt-displacement", 10);
    testSet(&props, "bearing-visible", 1);
    var ctx = testContext(&props);
    ctx.pitch = 0.5;
    var bucket = std.mem.zeroes(c.mln_plugin_bucket_v1);
    try std.testing.expectEqual(@as(c.mln_plugin_status, c.MLN_PLUGIN_STATUS_OK), buildFrame(&ctx, &bucket));
    // Shadow, arrow, puck: the shadow moves down-screen, the arrow and puck
    // up-screen, by pitch × displacement pixels (0.5 × 10 = 5 world pixels).
    try std.testing.expectApproxEqAbs(@as(f32, -0.05), (scratch.vertices[0].position[1] + scratch.vertices[2].position[1]) / 2, 0.000001);
    try std.testing.expectApproxEqAbs(@as(f32, 0.05), (scratch.vertices[4].position[1] + scratch.vertices[6].position[1]) / 2, 0.000001);
    try std.testing.expectApproxEqAbs(@as(f32, 0.05), (scratch.vertices[8].position[1] + scratch.vertices[10].position[1]) / 2, 0.000001);
    try std.testing.expectEqual(@as(usize, 2), scratch.query_count);
    try std.testing.expectApproxEqAbs(@as(f64, -5), (scratch.query_points[0][0].y + scratch.query_points[0][2].y) / 2, 0.000001);
    try std.testing.expectApproxEqAbs(@as(f64, -5), (scratch.query_points[1][0].y + scratch.query_points[1][2].y) / 2, 0.000001);
    // A camera bearing of 90° (host bearing -π/2) turns screen-up into east.
    ctx.bearing = -std.math.pi / 2.0;
    try std.testing.expectEqual(@as(c.mln_plugin_status, c.MLN_PLUGIN_STATUS_OK), buildFrame(&ctx, &bucket));
    try std.testing.expectApproxEqAbs(@as(f32, 0.05), (scratch.vertices[8].position[0] + scratch.vertices[10].position[0]) / 2, 0.000001);
    try std.testing.expectApproxEqAbs(@as(f32, 0), (scratch.vertices[8].position[1] + scratch.vertices[10].position[1]) / 2, 0.000001);
    ctx.bearing = 0;
    testSet(&props, "puck-radius", 0);
    try std.testing.expectEqual(@as(c.mln_plugin_status, c.MLN_PLUGIN_STATUS_OK), buildFrame(&ctx, &bucket));
    try std.testing.expectEqual(@as(usize, 1), scratch.query_count);
    try std.testing.expectEqual(@as(u16, 8), scratch.vertex_count);
    testSet(&props, "shadow-radius", 0);
    testSet(&props, "bearing-visible", 0);
    testSet(&props, "puck-radius", 8);
    // Two screen pixels per world pixel (w = 1, camera distance 2): core clamps
    // the inverse scale to 0.8.
    ctx.camera_to_center_distance = 2;
    try std.testing.expectEqual(@as(c.mln_plugin_status, c.MLN_PLUGIN_STATUS_OK), buildFrame(&ctx, &bucket));
    const compensated_width = scratch.vertices[1].position[0] - scratch.vertices[0].position[0];
    try std.testing.expectApproxEqAbs(@as(f32, 2 * 1.15 * 10 * 0.01 * (0.15 + 0.8 * 0.85)), compensated_width, 0.000001);
    testSet(&props, "perspective-compensation", 0);
    try std.testing.expectEqual(@as(c.mln_plugin_status, c.MLN_PLUGIN_STATUS_OK), buildFrame(&ctx, &bucket));
    try std.testing.expectApproxEqAbs(@as(f32, 2 * 1.15 * 10 * 0.01), scratch.vertices[1].position[0] - scratch.vertices[0].position[0], 0.000001);
    // Far from the camera (w = 3) the puck grows by the compensated ratio.
    ctx.camera_to_center_distance = 1;
    ctx.proj_matrix[15] = 3;
    testSet(&props, "perspective-compensation", 1);
    try std.testing.expectEqual(@as(c.mln_plugin_status, c.MLN_PLUGIN_STATUS_OK), buildFrame(&ctx, &bucket));
    try std.testing.expectApproxEqAbs(@as(f32, 2 * 1.15 * 10 * 0.01 * 3), scratch.vertices[1].position[0] - scratch.vertices[0].position[0], 0.000001);
}
