//! Particle effects for MapLibre Native's plugin ABI. One library registers
//! two layer types that share one stateless particle model and one shader
//! core (../../shaders/particle.glsl and shape.glsl): `particle-emitter`, a
//! source-free emitter at a point, on a disc or as weather around the camera,
//! and `particle-features`, particles from every point, line and polygon of a
//! vector source layer. See ../../spec.json for the contract this file shares
//! with the maplibre-gl-js implementation.
//!
//! properties.zig holds the paint tables and transport layouts, shaders.zig
//! the shader sources and descriptors, emitter.zig and features.zig each
//! type's callbacks.

const std = @import("std");
const build_options = @import("build_options");
const c = @import("maplibre_native_c");
const properties = @import("properties.zig");
const shaders = @import("shaders.zig");
const emitter = @import("emitter.zig");
const features = @import("features.zig");

const str = properties.str;

pub const plugin_id = "org.maplibre.plugins.particles";
pub const plugin_version = "0.1.0";
pub const emitter_layer_type = "particle-emitter";
pub const features_layer_type = "particle-features";

const all_backends = c.MLN_PLUGIN_BACKEND_OPENGL | c.MLN_PLUGIN_BACKEND_VULKAN | c.MLN_PLUGIN_BACKEND_METAL;

const layer_types = [_]c.mln_plugin_layer_type_v1{
    .{
        .struct_size = @sizeOf(c.mln_plugin_layer_type_v1),
        .layer_type = str(emitter_layer_type),
        .backend_mask = all_backends,
        .properties = &properties.emitter_descriptors,
        .property_count = properties.emitter_descriptors.len,
        // Ignored for source-free layers.
        .geometry_type_mask = c.MLN_PLUGIN_GEOMETRY_POINT,
        .shaders = &shaders.emitter_shaders,
        .shader_count = shaders.emitter_shaders.len,
        .create_layout = null,
        .layout_feature = null,
        .finish_layout = null,
        .destroy_layout = null,
        .query_feature = null,
        .update_uniform_block = emitter.updateUniformBlock,
        .get_query_radius = null,
        .should_animate = emitter.shouldAnimate,
        .source_free = 1,
        .build_frame = emitter.buildFrame,
    },
    .{
        .struct_size = @sizeOf(c.mln_plugin_layer_type_v1),
        .layer_type = str(features_layer_type),
        .backend_mask = all_backends,
        .properties = &properties.features_descriptors,
        .property_count = properties.features_descriptors.len,
        .geometry_type_mask = c.MLN_PLUGIN_GEOMETRY_POINT | c.MLN_PLUGIN_GEOMETRY_LINESTRING | c.MLN_PLUGIN_GEOMETRY_POLYGON,
        .shaders = &shaders.features_shaders,
        .shader_count = shaders.features_shaders.len,
        .create_layout = features.createLayout,
        .layout_feature = features.layoutFeature,
        .finish_layout = features.finishLayout,
        .destroy_layout = features.destroyLayout,
        .query_feature = null,
        .update_uniform_block = features.updateUniformBlock,
        .get_query_radius = null,
        .should_animate = features.shouldAnimate,
        .source_free = 0,
        .build_frame = null,
    },
};

const plugin_descriptor = c.mln_plugin_descriptor_v1{
    .struct_size = @sizeOf(c.mln_plugin_descriptor_v1),
    .abi_version = c.MLN_PLUGIN_ABI_VERSION_1,
    .plugin_id = str(plugin_id),
    .plugin_version = str(plugin_version),
    .minimum_host_abi = c.MLN_PLUGIN_ABI_VERSION_1,
    .maximum_host_abi = c.MLN_PLUGIN_ABI_VERSION_1,
    .layer_types = &layer_types,
    .layer_type_count = layer_types.len,
};

/// The plugin's entry point. The host resolves this symbol from the shared
/// library and passes its own register function, so the plugin binary never
/// links maplibre-native-c.
export fn mln_particles_register(
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

fn jsonNumber(v: std.json.Value) f64 {
    return switch (v) {
        .integer => |i| @floatFromInt(i),
        .float => |f| f,
        else => std.math.nan(f64),
    };
}

fn contains(list: []const std.json.Value, name: []const u8) bool {
    for (list) |item| if (std.mem.eql(u8, item.string, name)) return true;
    return false;
}

test {
    _ = properties;
    _ = shaders;
    _ = emitter;
    _ = features;
    _ = @import("hash.zig");
    _ = @import("clock.zig");
}

test "the entry point hands the host a descriptor it accepts" {
    const Host = struct {
        var seen: ?*const c.mln_plugin_descriptor_v1 = null;
        fn register(descriptor: [*c]const c.mln_plugin_descriptor_v1, message: [*c]u8, capacity: usize) callconv(.c) c.mln_plugin_status {
            seen = descriptor;
            if (registry.check(descriptor)) |failure| {
                const n = @min(failure.len, capacity - 1);
                @memcpy(message[0..n], failure[0..n]);
                message[n] = 0;
                return c.MLN_PLUGIN_STATUS_INVALID_ARGUMENT;
            }
            message[0] = 0;
            return c.MLN_PLUGIN_STATUS_OK;
        }
    };
    var message: [256]u8 = undefined;
    try std.testing.expectEqual(@as(c.mln_plugin_status, c.MLN_PLUGIN_STATUS_INVALID_ARGUMENT), mln_particles_register(null, &message, message.len));
    const status = mln_particles_register(Host.register, &message, message.len);
    errdefer std.debug.print("host: {s}\n", .{std.mem.sliceTo(&message, 0)});
    try std.testing.expectEqual(@as(c.mln_plugin_status, c.MLN_PLUGIN_STATUS_OK), status);
    try std.testing.expectEqual(@as(?*const c.mln_plugin_descriptor_v1, &plugin_descriptor), Host.seen);
}

test "spec.json follows the schema rules" {
    var parsed = try std.json.parseFromSlice(std.json.Value, std.testing.allocator, build_options.spec_json, .{});
    defer parsed.deinit();
    const spec = parsed.value.object;
    const native = spec.get("native").?.object;
    try std.testing.expectEqualStrings(plugin_id, native.get("pluginId").?.string);
    try std.testing.expectEqualStrings(plugin_version, native.get("pluginVersion").?.string);
    try std.testing.expectEqualStrings("maplibre-particles", native.get("library").?.string);
    try std.testing.expectEqualStrings("mln_particles_register", native.get("entryPoint").?.string);

    const canonical = spec.get("paint").?.object;
    try std.testing.expectEqual(@as(usize, 36), canonical.count());
    const canonical_names = canonical.keys();
    for (canonical_names, canonical.values()) |name, value| {
        const property = value.object;
        const type_name = property.get("type").?.string;
        const default = property.get("default").?;
        // Transitions default to true; enums cannot transition on the host.
        const transition = if (property.get("transition")) |t| t.bool else true;
        if (property.get("expressions")) |e| {
            try std.testing.expect(std.mem.eql(u8, e.string, "constant") or std.mem.eql(u8, e.string, "camera"));
        }
        // Bounds belong to floats only; float2 components carry clamps instead.
        const is_float = std.mem.eql(u8, type_name, "float");
        if (!is_float) {
            try std.testing.expect(property.get("minimum") == null and property.get("maximum") == null);
        }
        if (is_float) {
            const x = jsonNumber(default);
            if (property.get("minimum")) |m| try std.testing.expect(x >= jsonNumber(m));
            if (property.get("maximum")) |m| try std.testing.expect(x <= jsonNumber(m));
        } else if (std.mem.eql(u8, type_name, "float2")) {
            const components = property.get("components").?.array.items;
            try std.testing.expectEqual(@as(usize, 2), components.len);
            try std.testing.expectEqual(@as(usize, 2), default.array.items.len);
            for (components, default.array.items) |component, d| {
                _ = component.object.get("name").?.string;
                const clamp = component.object.get("clamp") orelse continue;
                const lo = jsonNumber(clamp.array.items[0]);
                const hi = jsonNumber(clamp.array.items[1]);
                try std.testing.expect(lo <= jsonNumber(d) and jsonNumber(d) <= hi);
            }
        } else if (std.mem.eql(u8, type_name, "color")) {
            try std.testing.expectEqual(@as(usize, 4), default.array.items.len);
            for (default.array.items) |channel| try std.testing.expect(jsonNumber(channel) >= 0 and jsonNumber(channel) <= 1);
        } else if (std.mem.eql(u8, type_name, "enum")) {
            try std.testing.expect(!transition);
            try std.testing.expect(contains(property.get("values").?.array.items, default.string));
        } else if (std.mem.eql(u8, type_name, "double2")) {
            try std.testing.expectEqual(@as(usize, 2), default.array.items.len);
        } else {
            std.debug.print("{s}: unknown type {s}\n", .{ name, type_name });
            return error.UnknownSpecType;
        }
    }

    const types = spec.get("layerTypes").?.object;
    try std.testing.expectEqual(@as(usize, 2), types.count());
    const emitter_spec = types.get(emitter_layer_type).?.object;
    const features_spec = types.get(features_layer_type).?.object;
    try std.testing.expect(emitter_spec.get("sourceFree").?.bool);
    try std.testing.expect(!features_spec.get("sourceFree").?.bool);
    try std.testing.expectEqual(@as(usize, 35), emitter_spec.get("paint").?.array.items.len);
    try std.testing.expectEqual(@as(usize, 14), features_spec.get("paint").?.array.items.len);
    try std.testing.expect(!contains(emitter_spec.get("paint").?.array.items, "particle-density"));
    try std.testing.expect(emitter_spec.get("dataDriven") == null);
    const geometry = features_spec.get("geometry").?.array.items;
    try std.testing.expectEqual(@as(usize, 3), geometry.len);
    inline for (.{ "point", "linestring", "polygon" }) |g| try std.testing.expect(contains(geometry, g));
    const layout = features_spec.get("layout").?.object;
    try std.testing.expectEqual(@as(f64, 16), jsonNumber(layout.get("pointSlots").?));
    try std.testing.expectEqual(@as(f64, 32), jsonNumber(layout.get("lineSlotSpacing").?));
    try std.testing.expectEqual(@as(f64, 128), jsonNumber(layout.get("polygonCell").?));
    try std.testing.expectEqual(@as(f64, 16383), jsonNumber(layout.get("maxParticlesPerTile").?));

    // Each type lists its properties in host order, a subsequence of the
    // canonical table; data-driven properties are listed and not constant.
    for (types.values()) |layer_type| {
        var next: usize = 0;
        for (layer_type.object.get("paint").?.array.items) |item| {
            while (next < canonical_names.len and !std.mem.eql(u8, canonical_names[next], item.string)) next += 1;
            if (next == canonical_names.len) {
                std.debug.print("{s} is not defined or out of canonical order\n", .{item.string});
                return error.NotASubsequence;
            }
            next += 1;
        }
        if (layer_type.object.get("dataDriven")) |data_driven| {
            for (data_driven.array.items) |item| {
                try std.testing.expect(contains(layer_type.object.get("paint").?.array.items, item.string));
                const expressions = canonical.get(item.string).?.object.get("expressions");
                try std.testing.expect(expressions == null or !std.mem.eql(u8, expressions.?.string, "constant"));
            }
        }
    }
    // Every canonical property belongs to at least one type.
    for (canonical_names) |name| {
        try std.testing.expect(contains(emitter_spec.get("paint").?.array.items, name) or contains(features_spec.get("paint").?.array.items, name));
    }
}

/// One `// @clamp <name> <lo> <hi> [<lo> <hi>]` line of particle.glsl.
const ClampMarker = struct {
    name: []const u8,
    bounds: [4]?f64,
    count: usize,
};

fn parseClampMarkers(allocator: std.mem.Allocator, source: []const u8) !std.ArrayList(ClampMarker) {
    var markers: std.ArrayList(ClampMarker) = .empty;
    errdefer markers.deinit(allocator);
    var lines = std.mem.splitScalar(u8, source, '\n');
    while (lines.next()) |line| {
        const rest = std.mem.trim(u8, line, " \r");
        if (!std.mem.startsWith(u8, rest, "// @clamp ")) continue;
        var tokens = std.mem.tokenizeScalar(u8, rest["// @clamp ".len..], ' ');
        var marker: ClampMarker = .{ .name = tokens.next() orelse return error.MalformedClamp, .bounds = @splat(null), .count = 0 };
        while (tokens.next()) |token| : (marker.count += 1) {
            if (marker.count == 4) return error.MalformedClamp;
            marker.bounds[marker.count] = if (std.mem.eql(u8, token, "-")) null else try std.fmt.parseFloat(f64, token);
        }
        try markers.append(allocator, marker);
    }
    return markers;
}

fn expectBound(expected: ?std.json.Value, actual: ?f64) !void {
    if (expected) |e| {
        try std.testing.expectEqual(@as(?f64, jsonNumber(e)), actual);
    } else try std.testing.expectEqual(@as(?f64, null), actual);
}

test "shader @clamp block matches the spec bounds" {
    var parsed = try std.json.parseFromSlice(std.json.Value, std.testing.allocator, build_options.spec_json, .{});
    defer parsed.deinit();
    const canonical = parsed.value.object.get("paint").?.object;
    var markers = try parseClampMarkers(std.testing.allocator, build_options.particle_glsl);
    defer markers.deinit(std.testing.allocator);
    try std.testing.expect(markers.items.len > 0);

    for (markers.items) |marker| {
        errdefer std.debug.print("@clamp {s}\n", .{marker.name});
        const property = canonical.get(marker.name).?.object;
        const type_name = property.get("type").?.string;
        if (std.mem.eql(u8, type_name, "float")) {
            try std.testing.expectEqual(@as(usize, 2), marker.count);
            try expectBound(property.get("minimum"), marker.bounds[0]);
            try expectBound(property.get("maximum"), marker.bounds[1]);
        } else if (std.mem.eql(u8, type_name, "float2")) {
            try std.testing.expectEqual(@as(usize, 4), marker.count);
            for (property.get("components").?.array.items, 0..) |component, i| {
                const clamp = component.object.get("clamp");
                try expectBound(if (clamp) |range| range.array.items[0] else null, marker.bounds[2 * i]);
                try expectBound(if (clamp) |range| range.array.items[1] else null, marker.bounds[2 * i + 1]);
            }
        } else return error.ClampOnUnclampableType;
    }

    // Every bounded float and clamped float2 has a marker, except the two the
    // CPU packers clamp before the values reach a shader.
    const packer_clamped = [_][]const u8{ "particle-opacity", "emitter-vignette" };
    for (canonical.keys(), canonical.values()) |name, value| {
        const property = value.object;
        const bounded = property.get("minimum") != null or property.get("maximum") != null or blk: {
            const components = property.get("components") orelse break :blk false;
            for (components.array.items) |component| {
                if (component.object.get("clamp") != null) break :blk true;
            }
            break :blk false;
        };
        var marked = false;
        for (markers.items) |marker| marked = marked or std.mem.eql(u8, marker.name, name);
        var packed_on_cpu = false;
        for (packer_clamped) |p| packed_on_cpu = packed_on_cpu or std.mem.eql(u8, p, name);
        errdefer std.debug.print("{s}\n", .{name});
        try std.testing.expectEqual(bounded and !packed_on_cpu, marked);
    }
}

test "fixtures hold a cases array" {
    const fixtures = [_][]const u8{
        build_options.fixture_hash,
        build_options.fixture_record,
        build_options.fixture_layout_points,
        build_options.fixture_layout_lines,
        build_options.fixture_layout_polygons,
    };
    for (fixtures) |fixture| {
        var parsed = try std.json.parseFromSlice(std.json.Value, std.testing.allocator, fixture, .{});
        defer parsed.deinit();
        _ = parsed.value.object.get("cases").?.array;
    }
}

fn slice(s: c.mln_plugin_string) []const u8 {
    return if (s.size == 0) "" else s.data[0..s.size];
}

fn expectDescriptorMatches(spec: std.json.ObjectMap, d: c.mln_plugin_property_descriptor_v1, data_driven: bool) !void {
    const type_name = spec.get("type").?.string;
    const default = spec.get("default").?;
    const expected_type: c.mln_plugin_value_type = if (std.mem.eql(u8, type_name, "float"))
        c.MLN_PLUGIN_VALUE_FLOAT
    else if (std.mem.eql(u8, type_name, "float2"))
        c.MLN_PLUGIN_VALUE_FLOAT2
    else if (std.mem.eql(u8, type_name, "color"))
        c.MLN_PLUGIN_VALUE_COLOR
    else if (std.mem.eql(u8, type_name, "enum"))
        c.MLN_PLUGIN_VALUE_STRING
    else if (std.mem.eql(u8, type_name, "double2"))
        c.MLN_PLUGIN_VALUE_DOUBLE2
    else
        return error.UnknownSpecType;
    try std.testing.expectEqual(expected_type, d.type);
    try std.testing.expectEqual(expected_type, d.default_value.type);
    const value = d.default_value.data;
    switch (expected_type) {
        c.MLN_PLUGIN_VALUE_FLOAT => try std.testing.expectEqual(@as(f32, @floatCast(jsonNumber(default))), value.float_value),
        c.MLN_PLUGIN_VALUE_FLOAT2 => {
            try std.testing.expectEqual(@as(f32, @floatCast(jsonNumber(default.array.items[0]))), value.float2_value.x);
            try std.testing.expectEqual(@as(f32, @floatCast(jsonNumber(default.array.items[1]))), value.float2_value.y);
        },
        c.MLN_PLUGIN_VALUE_DOUBLE2 => {
            try std.testing.expectEqual(jsonNumber(default.array.items[0]), value.double2_value.x);
            try std.testing.expectEqual(jsonNumber(default.array.items[1]), value.double2_value.y);
        },
        c.MLN_PLUGIN_VALUE_COLOR => {
            const rgba = [4]f32{ value.color_value.r, value.color_value.g, value.color_value.b, value.color_value.a };
            for (default.array.items, rgba) |expected, actual| try std.testing.expectEqual(@as(f32, @floatCast(jsonNumber(expected))), actual);
        },
        c.MLN_PLUGIN_VALUE_STRING => {
            try std.testing.expectEqualStrings(default.string, slice(value.string_value));
            const values = spec.get("values").?.array.items;
            try std.testing.expectEqual(values.len, d.enum_value_count);
            for (values, d.enum_values[0..d.enum_value_count]) |expected, actual| try std.testing.expectEqualStrings(expected.string, slice(actual));
        },
        else => unreachable,
    }
    if (expected_type != c.MLN_PLUGIN_VALUE_STRING) try std.testing.expectEqual(@as(usize, 0), d.enum_value_count);
    const minimum = spec.get("minimum");
    const maximum = spec.get("maximum");
    try std.testing.expectEqual(@as(u8, @intFromBool(minimum != null)), d.has_minimum);
    try std.testing.expectEqual(@as(u8, @intFromBool(maximum != null)), d.has_maximum);
    if (minimum) |m| try std.testing.expectEqual(@as(f32, @floatCast(jsonNumber(m))), d.minimum);
    if (maximum) |m| try std.testing.expectEqual(@as(f32, @floatCast(jsonNumber(m))), d.maximum);
    const transition = if (spec.get("transition")) |t| t.bool else true;
    try std.testing.expectEqual(@as(u8, @intFromBool(transition)), d.supports_transitions);
    const constant = if (spec.get("expressions")) |e| std.mem.eql(u8, e.string, "constant") else false;
    var capabilities: u32 = if (constant) c.MLN_PLUGIN_EXPRESSION_NONE else c.MLN_PLUGIN_EXPRESSION_CAMERA;
    if (data_driven) capabilities |= c.MLN_PLUGIN_EXPRESSION_FEATURE | c.MLN_PLUGIN_EXPRESSION_COMPOSITE;
    try std.testing.expectEqual(capabilities, d.expression_capabilities);
}

test "descriptors match the shared spec" {
    var parsed = try std.json.parseFromSlice(std.json.Value, std.testing.allocator, build_options.spec_json, .{});
    defer parsed.deinit();
    const spec = parsed.value.object;
    const canonical = spec.get("paint").?.object;
    const types = spec.get("layerTypes").?.object;
    for (layer_types) |layer| {
        const name = slice(layer.layer_type);
        const spec_type = types.get(name).?.object;
        const names = spec_type.get("paint").?.array.items;
        const data_driven: []const std.json.Value = if (spec_type.get("dataDriven")) |list| list.array.items else &.{};
        // Declaration order is the host's property order; keep it identical.
        try std.testing.expectEqual(names.len, layer.property_count);
        for (names, layer.properties[0..layer.property_count]) |expected, d| {
            errdefer std.debug.print("{s}: {s}\n", .{ name, expected.string });
            try std.testing.expectEqualStrings(expected.string, slice(d.name));
            try expectDescriptorMatches(canonical.get(expected.string).?.object, d, contains(data_driven, expected.string));
        }
        try std.testing.expectEqual(@as(u8, @intFromBool(spec_type.get("sourceFree").?.bool)), layer.source_free);
        if (spec_type.get("geometry")) |geometry| {
            var mask: u32 = 0;
            for (geometry.array.items) |g| {
                if (std.mem.eql(u8, g.string, "point")) mask |= c.MLN_PLUGIN_GEOMETRY_POINT;
                if (std.mem.eql(u8, g.string, "linestring")) mask |= c.MLN_PLUGIN_GEOMETRY_LINESTRING;
                if (std.mem.eql(u8, g.string, "polygon")) mask |= c.MLN_PLUGIN_GEOMETRY_POLYGON;
            }
            try std.testing.expectEqual(mask, layer.geometry_type_mask);
        }
    }
    try std.testing.expectEqual(@as(usize, 2), types.count());
    try std.testing.expectEqualStrings(emitter_layer_type, slice(layer_types[0].layer_type));
    try std.testing.expectEqualStrings(features_layer_type, slice(layer_types[1].layer_type));
    const layout = types.get(features_layer_type).?.object.get("layout").?.object;
    try std.testing.expectEqual(@as(f64, properties.layout.point_slots), jsonNumber(layout.get("pointSlots").?));
    try std.testing.expectEqual(@as(f64, properties.layout.line_slot_spacing), jsonNumber(layout.get("lineSlotSpacing").?));
    try std.testing.expectEqual(@as(f64, properties.layout.polygon_cell), jsonNumber(layout.get("polygonCell").?));
    try std.testing.expectEqual(@as(f64, properties.layout.max_particles_per_tile), jsonNumber(layout.get("maxParticlesPerTile").?));
    try std.testing.expectEqual(properties.segment_quads, properties.layout.max_particles_per_tile);

    // The canonical table here is spec.json's, in order.
    try std.testing.expectEqual(canonical.count(), properties.canonical.len);
    for (canonical.keys(), canonical.values(), 0..) |name, value, i| {
        errdefer std.debug.print("canonical {s}\n", .{name});
        const d = inline for (properties.canonical, 0..) |property, j| {
            if (i == j) break properties.descriptor(property, false);
        } else unreachable;
        try std.testing.expectEqualStrings(name, slice(d.name));
        try expectDescriptorMatches(value.object, d, false);
    }
}

test "a property both types list has one definition" {
    var shared: usize = 0;
    for (properties.emitter_descriptors) |a| {
        for (properties.features_descriptors) |b| {
            if (!std.mem.eql(u8, slice(a.name), slice(b.name))) continue;
            shared += 1;
            const data = c.MLN_PLUGIN_EXPRESSION_FEATURE | c.MLN_PLUGIN_EXPRESSION_COMPOSITE;
            var b_camera = b;
            b_camera.expression_capabilities &= ~@as(u32, data);
            try std.testing.expectEqual(a.expression_capabilities, b_camera.expression_capabilities);
            try std.testing.expectEqual(a.type, b.type);
            try std.testing.expectEqualSlices(u8, std.mem.asBytes(&a.default_value.data)[0 .. @sizeOf(f32) * 4], std.mem.asBytes(&b.default_value.data)[0 .. @sizeOf(f32) * 4]);
            try std.testing.expectEqual(a.supports_transitions, b.supports_transitions);
            try std.testing.expectEqual(a.has_minimum, b.has_minimum);
            try std.testing.expectEqual(a.has_maximum, b.has_maximum);
            try std.testing.expectEqual(a.minimum, b.minimum);
            try std.testing.expectEqual(a.maximum, b.maximum);
            try std.testing.expectEqual(a.enum_value_count, b.enum_value_count);
        }
    }
    // Every features property but particle-density is also an emitter one.
    try std.testing.expectEqual(properties.features_descriptors.len - 1, shared);
}

test "both types always animate" {
    inline for (.{ properties.emitter_descriptors, properties.features_descriptors }, 0..) |descriptors, i| {
        var values: [descriptors.len]c.mln_plugin_property_value_v1 = undefined;
        for (descriptors, 0..) |d, j| values[j] = .{ .struct_size = @sizeOf(c.mln_plugin_property_value_v1), .name = d.name, .value = d.default_value };
        try std.testing.expectEqual(@as(u8, 1), layer_types[i].should_animate.?(&values, values.len));
    }
}

/// The host's registration checks (MapLibre Native plugin_registry.cpp:
/// registerPlugin, appendShaders, appendProperties), reimplemented against
/// the C descriptor, so a descriptor the host would reject fails here first.
/// check() returns the host's error message, or null when it accepts. Both
/// uniform block rules are applied: OpenGL and Metal allow one block per
/// packed stage slot, Vulkan two blocks per shader (maxUBOCountPerDrawable).
const registry = struct {
    const vulkan_max_blocks = 2;
    const data_dependencies = c.MLN_PLUGIN_EXPRESSION_FEATURE | c.MLN_PLUGIN_EXPRESSION_COMPOSITE | c.MLN_PLUGIN_EXPRESSION_FEATURE_STATE;
    const valid_capabilities = c.MLN_PLUGIN_EXPRESSION_CAMERA | data_dependencies;
    const valid_geometry = c.MLN_PLUGIN_GEOMETRY_POINT | c.MLN_PLUGIN_GEOMETRY_LINESTRING | c.MLN_PLUGIN_GEOMETRY_POLYGON;

    fn validString(s: c.mln_plugin_string) bool {
        return s.data != null and s.size > 0;
    }

    fn validOptionalString(s: c.mln_plugin_string) bool {
        return s.size == 0 or s.data != null;
    }

    fn validBackendMask(mask: u32) bool {
        return mask & all_backends != 0 and mask & ~@as(u32, all_backends) == 0;
    }

    fn encodingSize(encoding: c.mln_plugin_property_encoding_v1) u32 {
        return switch (encoding) {
            c.MLN_PLUGIN_PROPERTY_ENCODING_FLOAT, c.MLN_PLUGIN_PROPERTY_ENCODING_ENUM_FLOAT => 4,
            c.MLN_PLUGIN_PROPERTY_ENCODING_FLOAT2 => 8,
            c.MLN_PLUGIN_PROPERTY_ENCODING_COLOR => 16,
            else => 0,
        };
    }

    fn encodingAlignment(encoding: c.mln_plugin_property_encoding_v1) u32 {
        return @min(encodingSize(encoding), 16);
    }

    fn unpackedType(encoding: c.mln_plugin_property_encoding_v1) c.mln_plugin_vertex_attribute_type {
        return switch (encoding) {
            c.MLN_PLUGIN_PROPERTY_ENCODING_FLOAT, c.MLN_PLUGIN_PROPERTY_ENCODING_ENUM_FLOAT => c.MLN_PLUGIN_VERTEX_FLOAT,
            c.MLN_PLUGIN_PROPERTY_ENCODING_FLOAT2 => c.MLN_PLUGIN_VERTEX_FLOAT_X2,
            c.MLN_PLUGIN_PROPERTY_ENCODING_COLOR => c.MLN_PLUGIN_VERTEX_FLOAT_X4,
            else => 0,
        };
    }

    fn findBlock(shader: c.mln_plugin_shader_descriptor_v1, id: u32) ?c.mln_plugin_uniform_block_descriptor_v1 {
        for (shader.uniform_blocks[0..shader.uniform_block_count]) |block| {
            if (block.uniform_id == id) return block;
        }
        return null;
    }

    fn findAttribute(shader: c.mln_plugin_shader_descriptor_v1, id: u32) ?c.mln_plugin_shader_attribute_v1 {
        for (shader.attributes[0..shader.attribute_count]) |a| {
            if (a.attribute_id == id) return a;
        }
        return null;
    }

    fn checkShader(shader: c.mln_plugin_shader_descriptor_v1, backend_mask: u32) ?[]const u8 {
        if (shader.struct_size < @sizeOf(c.mln_plugin_shader_descriptor_v1) or !validString(shader.shader_id) or
            shader.source_count == 0 or shader.sources == null or shader.attribute_count == 0 or shader.attributes == null)
            return "plugin shader descriptor is malformed";

        var source_backends: u32 = 0;
        for (shader.sources[0..shader.source_count]) |source| {
            const metal = source.backend == c.MLN_PLUGIN_BACKEND_METAL;
            if (source.struct_size < @sizeOf(c.mln_plugin_shader_source_v1) or !validBackendMask(source.backend) or
                source.backend & (source.backend -% 1) != 0 or !validString(source.vertex_source) or
                !validOptionalString(source.fragment_source) or !validOptionalString(source.vertex_entry_point) or
                !validOptionalString(source.fragment_entry_point) or (!metal and !validString(source.fragment_source)) or
                (metal and (!validString(source.vertex_entry_point) or !validString(source.fragment_entry_point))) or
                source_backends & source.backend != 0)
                return "plugin shader source is malformed or duplicated";
            source_backends |= source.backend;
        }
        if (source_backends & backend_mask != backend_mask) return "plugin shader does not provide every declared backend";

        var ids: u32 = 0;
        var locations: u32 = 0;
        for (shader.attributes[0..shader.attribute_count]) |a| {
            if (a.struct_size < @sizeOf(c.mln_plugin_shader_attribute_v1) or !validString(a.name) or
                a.attribute_id >= c.MLN_PLUGIN_MAX_VERTEX_ATTRIBUTES or a.location >= c.MLN_PLUGIN_MAX_VERTEX_ATTRIBUTES or
                a.type < c.MLN_PLUGIN_VERTEX_INT16 or a.type > c.MLN_PLUGIN_VERTEX_UINT8_X4_NORMALIZED or
                ids & (@as(u32, 1) << @intCast(a.attribute_id)) != 0 or locations & (@as(u32, 1) << @intCast(a.location)) != 0)
                return "plugin shader attribute is malformed or duplicated";
            ids |= @as(u32, 1) << @intCast(a.attribute_id);
            locations |= @as(u32, 1) << @intCast(a.location);
        }
        // Sorted, the locations must run 0..n-1.
        if (locations != (@as(u32, 1) << @intCast(shader.attribute_count)) - 1)
            return "plugin shader attribute locations must be contiguous and start at zero";

        if (shader.uniform_block_count != 0 and shader.uniform_blocks == null) return "plugin shader uniform block array is missing";
        var stage_slots: u32 = 0;
        const blocks = if (shader.uniform_block_count == 0) &[_]c.mln_plugin_uniform_block_descriptor_v1{} else shader.uniform_blocks[0..shader.uniform_block_count];
        for (blocks, 0..) |block, i| {
            const stages = c.MLN_PLUGIN_SHADER_STAGE_VERTEX | c.MLN_PLUGIN_SHADER_STAGE_FRAGMENT;
            var duplicate = false;
            for (blocks[0..i]) |previous| {
                duplicate = duplicate or previous.uniform_id == block.uniform_id or std.mem.eql(u8, slice(previous.name), slice(block.name));
            }
            if (block.struct_size < @sizeOf(c.mln_plugin_uniform_block_descriptor_v1) or !validString(block.name) or
                block.byte_size == 0 or block.byte_size % 16 != 0 or block.stage_mask == 0 or
                (block.scope != c.MLN_PLUGIN_UNIFORM_DRAWABLE and block.scope != c.MLN_PLUGIN_UNIFORM_LAYER and block.scope != c.MLN_PLUGIN_UNIFORM_DRAWABLE_ARRAY) or
                block.stage_mask & ~@as(u32, stages) != 0 or duplicate)
                return "plugin shader uniform block is malformed or duplicated";
            if (i >= vulkan_max_blocks) return "plugin shader declares too many drawable uniform blocks";
            const slot: u5 = if (block.stage_mask == c.MLN_PLUGIN_SHADER_STAGE_VERTEX) 0 else if (block.stage_mask == c.MLN_PLUGIN_SHADER_STAGE_FRAGMENT) 1 else 2;
            if (stage_slots & (@as(u32, 1) << slot) != 0) return "plugin shader declares more than one drawable uniform block for a packed stage slot";
            stage_slots |= @as(u32, 1) << slot;
        }

        if (shader.property_binding_count != 0 and shader.property_bindings == null) return "plugin shader property binding array is missing";
        const bindings = if (shader.property_binding_count == 0) &[_]c.mln_plugin_shader_property_binding_v1{} else shader.property_bindings[0..shader.property_binding_count];
        var bound_attributes: u32 = 0;
        for (bindings, 0..) |binding, i| {
            if (binding.struct_size < @sizeOf(c.mln_plugin_shader_property_binding_v1)) return "plugin shader property binding is malformed";
            const size = encodingSize(binding.encoding);
            const packed_pair = binding.minimum_attribute_id == binding.maximum_attribute_id;
            const attribute_type: c.mln_plugin_vertex_attribute_type = if (packed_pair)
                (if (size == 4) c.MLN_PLUGIN_VERTEX_FLOAT_X2 else c.MLN_PLUGIN_VERTEX_FLOAT_X4)
            else
                unpackedType(binding.encoding);
            const uniform = findBlock(shader, binding.uniform_id);
            const interpolation = findBlock(shader, binding.interpolation_uniform_id);
            const minimum = findAttribute(shader, binding.minimum_attribute_id);
            const maximum = findAttribute(shader, binding.maximum_attribute_id);
            var duplicate_name = false;
            for (bindings[0..i]) |previous| duplicate_name = duplicate_name or std.mem.eql(u8, slice(previous.property_name), slice(binding.property_name));
            const min_bit = @as(u32, 1) << @intCast(binding.minimum_attribute_id % 32);
            const max_bit = @as(u32, 1) << @intCast(binding.maximum_attribute_id % 32);
            const reused = bound_attributes & min_bit != 0 or (!packed_pair and bound_attributes & max_bit != 0);
            bound_attributes |= min_bit | max_bit;
            if (slice(binding.property_name).len == 0 or size == 0 or duplicate_name or (packed_pair and size > 8) or reused or
                uniform == null or interpolation == null or interpolation.?.scope == c.MLN_PLUGIN_UNIFORM_LAYER or
                binding.uniform_byte_offset % encodingAlignment(binding.encoding) != 0 or binding.interpolation_uniform_byte_offset % 4 != 0 or
                binding.uniform_byte_offset > uniform.?.byte_size or size > uniform.?.byte_size - binding.uniform_byte_offset or
                binding.interpolation_uniform_byte_offset > interpolation.?.byte_size or 4 > interpolation.?.byte_size - binding.interpolation_uniform_byte_offset or
                minimum == null or maximum == null or minimum.?.type != attribute_type or maximum.?.type != attribute_type)
                return "plugin shader property binding is malformed";
        }
        // Value and interpolation ranges share one list per block.
        for (bindings, 0..) |a, i| {
            const a_ranges = [2][3]u32{
                .{ a.uniform_id, a.uniform_byte_offset, a.uniform_byte_offset + encodingSize(a.encoding) },
                .{ a.interpolation_uniform_id, a.interpolation_uniform_byte_offset, a.interpolation_uniform_byte_offset + 4 },
            };
            if (a_ranges[0][0] == a_ranges[1][0] and a_ranges[0][1] < a_ranges[1][2] and a_ranges[1][1] < a_ranges[0][2])
                return "plugin shader property bindings contain overlapping uniform ranges";
            for (bindings[0..i]) |b| {
                const b_ranges = [2][3]u32{
                    .{ b.uniform_id, b.uniform_byte_offset, b.uniform_byte_offset + encodingSize(b.encoding) },
                    .{ b.interpolation_uniform_id, b.interpolation_uniform_byte_offset, b.interpolation_uniform_byte_offset + 4 },
                };
                for (a_ranges) |x| for (b_ranges) |y| {
                    if (x[0] == y[0] and x[1] < y[2] and y[1] < x[2]) return "plugin shader property bindings contain overlapping uniform ranges";
                };
            }
        }
        return null;
    }

    fn checkProperties(layer: c.mln_plugin_layer_type_v1) ?[]const u8 {
        if (layer.property_count != 0 and layer.properties == null) return "plugin property array is missing";
        const list = layer.properties[0..layer.property_count];
        for (list, 0..) |p, i| {
            if (p.struct_size < @sizeOf(c.mln_plugin_property_descriptor_v1) or !validString(p.name) or
                p.default_value.struct_size < @sizeOf(c.mln_plugin_value) or p.default_value.type != p.type or
                (p.type == c.MLN_PLUGIN_VALUE_STRING and !validOptionalString(p.default_value.data.string_value)) or
                p.expression_capabilities & ~@as(u32, valid_capabilities) != 0)
                return "plugin property descriptor is malformed";
            const transitionable = switch (p.type) {
                c.MLN_PLUGIN_VALUE_FLOAT, c.MLN_PLUGIN_VALUE_ROTATION, c.MLN_PLUGIN_VALUE_FLOAT2, c.MLN_PLUGIN_VALUE_COLOR, c.MLN_PLUGIN_VALUE_DOUBLE2 => true,
                else => false,
            };
            if (p.supports_transitions != 0 and !transitionable) return "plugin transitions require an interpolatable paint property";
            if (p.type < c.MLN_PLUGIN_VALUE_FLOAT or p.type > c.MLN_PLUGIN_VALUE_ROTATION) return "plugin property default value has the wrong type";
            for (list[0..i]) |previous| {
                if (std.mem.eql(u8, slice(previous.name), slice(p.name))) return "plugin descriptor contains duplicate property names";
            }
            if (p.enum_value_count != 0) {
                if (p.enum_values == null or p.type != c.MLN_PLUGIN_VALUE_STRING) return "plugin property enum values require a string property";
                const values = p.enum_values[0..p.enum_value_count];
                var default_allowed = false;
                for (values, 0..) |value, j| {
                    if (!validString(value)) return "plugin property enum contains an empty value";
                    for (values[0..j]) |previous| {
                        if (std.mem.eql(u8, slice(previous), slice(value))) return "plugin property enum contains duplicate values";
                    }
                    default_allowed = default_allowed or std.mem.eql(u8, slice(value), slice(p.default_value.data.string_value));
                }
                if (!default_allowed) return "plugin property enum default is not an allowed value";
            }
            if (p.has_minimum != 0 and p.has_maximum != 0 and p.minimum > p.maximum) return "plugin property has an invalid numeric range";
            if (p.type == c.MLN_PLUGIN_VALUE_FLOAT or p.type == c.MLN_PLUGIN_VALUE_ROTATION) {
                const v = p.default_value.data.float_value;
                if ((p.has_minimum != 0 and v < p.minimum) or (p.has_maximum != 0 and v > p.maximum)) return "plugin property default is outside its numeric range";
            }
        }
        return null;
    }

    fn findProperty(layer: c.mln_plugin_layer_type_v1, name: []const u8) ?c.mln_plugin_property_descriptor_v1 {
        for (layer.properties[0..layer.property_count]) |p| {
            if (std.mem.eql(u8, slice(p.name), name)) return p;
        }
        return null;
    }

    pub fn check(descriptor: *const c.mln_plugin_descriptor_v1) ?[]const u8 {
        const d = descriptor.*;
        if (d.struct_size < @sizeOf(c.mln_plugin_descriptor_v1) or d.abi_version != c.MLN_PLUGIN_ABI_VERSION_1 or
            d.minimum_host_abi > c.MLN_PLUGIN_ABI_VERSION_1 or d.maximum_host_abi < c.MLN_PLUGIN_ABI_VERSION_1)
            return "plugin ABI is not compatible with host ABI 1";
        if (!validString(d.plugin_id) or !validString(d.plugin_version) or d.layer_types == null or d.layer_type_count == 0)
            return "plugin descriptor is missing an id, version, or layer registration";
        const layers = d.layer_types[0..d.layer_type_count];
        for (layers, 0..) |layer, i| {
            if (layer.struct_size < @sizeOf(c.mln_plugin_layer_type_v1) or !validString(layer.layer_type) or !validBackendMask(layer.backend_mask))
                return "plugin layer type is malformed or has no supported backend";
            if (layer.source_free > 1) return "plugin layer source_free must be 0 or 1";
            const source_free = layer.source_free != 0;
            if (!source_free and (layer.create_layout == null or layer.layout_feature == null or layer.finish_layout == null or
                layer.destroy_layout == null or layer.geometry_type_mask == 0 or layer.geometry_type_mask & ~@as(u32, valid_geometry) != 0))
                return "geometry plugin requires source layout callbacks and a valid geometry mask";
            if (source_free and layer.build_frame == null) return "source-free plugin layers require a frame callback";
            if (!source_free and layer.build_frame != null) return "frame callbacks apply only to source-free plugin layers";
            for (layers[0..i]) |previous| {
                if (std.mem.eql(u8, slice(previous.layer_type), slice(layer.layer_type))) return "plugin descriptor contains duplicate layer types";
            }
            if (layer.shader_count == 0 or layer.shaders == null) return "host-drawable plugin layers must declare at least one shader";
            const shader_list = layer.shaders[0..layer.shader_count];
            var needs_uniform_callback = false;
            for (shader_list, 0..) |shader, j| {
                for (shader_list[0..j]) |previous| {
                    if (std.mem.eql(u8, slice(previous.shader_id), slice(shader.shader_id))) return "plugin layer contains duplicate shader ids";
                }
                if (checkShader(shader, layer.backend_mask)) |failure| return failure;
                needs_uniform_callback = needs_uniform_callback or shader.uniform_block_count != 0;
            }
            if (needs_uniform_callback and layer.update_uniform_block == null) return "plugin layer declares uniforms without an update callback";
            if (checkProperties(layer)) |failure| return failure;
            for (shader_list) |shader| {
                if (shader.property_binding_count == 0) continue;
                for (shader.property_bindings[0..shader.property_binding_count]) |binding| {
                    const property = findProperty(layer, slice(binding.property_name)) orelse
                        return "plugin shader property binding references an incompatible paint property";
                    const matches = switch (property.type) {
                        c.MLN_PLUGIN_VALUE_FLOAT, c.MLN_PLUGIN_VALUE_ROTATION => binding.encoding == c.MLN_PLUGIN_PROPERTY_ENCODING_FLOAT,
                        c.MLN_PLUGIN_VALUE_FLOAT2 => binding.encoding == c.MLN_PLUGIN_PROPERTY_ENCODING_FLOAT2,
                        c.MLN_PLUGIN_VALUE_COLOR => binding.encoding == c.MLN_PLUGIN_PROPERTY_ENCODING_COLOR,
                        c.MLN_PLUGIN_VALUE_STRING => property.enum_value_count != 0 and binding.encoding == c.MLN_PLUGIN_PROPERTY_ENCODING_ENUM_FLOAT,
                        else => false,
                    };
                    if (!matches) return "plugin shader property binding references an incompatible paint property";
                }
            }
            for (layer.properties[0..layer.property_count]) |property| {
                if (source_free and property.expression_capabilities & data_dependencies != 0)
                    return "source-free plugin layers cannot declare data-driven properties";
                if (property.expression_capabilities & data_dependencies == 0) continue;
                var bound = false;
                for (shader_list) |shader| {
                    if (shader.property_binding_count == 0) continue;
                    for (shader.property_bindings[0..shader.property_binding_count]) |binding| bound = bound or std.mem.eql(u8, slice(binding.property_name), slice(property.name));
                }
                if (!bound) return "data-driven plugin properties require a shader property binding";
            }
        }
        return null;
    }
};

/// A writable copy of the descriptor, for feeding the registry mimic
/// descriptors the host must reject.
const Mutable = struct {
    layers: [2]c.mln_plugin_layer_type_v1,
    emitter_properties: [properties.emitter_descriptors.len]c.mln_plugin_property_descriptor_v1,
    features_properties: [properties.features_descriptors.len]c.mln_plugin_property_descriptor_v1,
    shaders: [2]c.mln_plugin_shader_descriptor_v1,
    blocks: [2][2]c.mln_plugin_uniform_block_descriptor_v1,
    attributes: [properties.feature_attribute_count]c.mln_plugin_shader_attribute_v1,
    bindings: [properties.feature_bindings.len]c.mln_plugin_shader_property_binding_v1,
    descriptor: c.mln_plugin_descriptor_v1,

    fn init(self: *Mutable) void {
        self.layers = layer_types;
        self.emitter_properties = properties.emitter_descriptors;
        self.features_properties = properties.features_descriptors;
        self.shaders = .{ shaders.emitter_shaders[0], shaders.features_shaders[0] };
        for (&self.shaders, &self.blocks) |*shader, *blocks| {
            blocks[0] = shader.uniform_blocks[0];
            blocks[1] = blocks[0];
            shader.uniform_blocks = blocks;
        }
        @memcpy(&self.attributes, shaders.features_shaders[0].attributes[0..properties.feature_attribute_count]);
        @memcpy(&self.bindings, shaders.features_shaders[0].property_bindings[0..properties.feature_bindings.len]);
        self.shaders[1].attributes = &self.attributes;
        self.shaders[1].property_bindings = &self.bindings;
        self.layers[0].properties = &self.emitter_properties;
        self.layers[1].properties = &self.features_properties;
        self.layers[0].shaders = &self.shaders[0];
        self.layers[1].shaders = &self.shaders[1];
        self.descriptor = plugin_descriptor;
        self.descriptor.layer_types = &self.layers;
    }
};

test "the registry mimic accepts the descriptor and rejects what the host rejects" {
    var m: Mutable = undefined;
    m.init();
    try std.testing.expectEqual(@as(?[]const u8, null), registry.check(&m.descriptor));

    const Mutation = struct { expected: []const u8, apply: *const fn (*Mutable) void };
    const mutations = [_]Mutation{
        .{ .expected = "source-free plugin layers cannot declare data-driven properties", .apply = struct {
            fn f(x: *Mutable) void {
                x.emitter_properties[20].expression_capabilities |= c.MLN_PLUGIN_EXPRESSION_FEATURE;
            }
        }.f },
        .{ .expected = "plugin transitions require an interpolatable paint property", .apply = struct {
            fn f(x: *Mutable) void {
                x.features_properties[7].supports_transitions = 1;
            }
        }.f },
        .{ .expected = "plugin shader property binding is malformed", .apply = struct {
            fn f(x: *Mutable) void {
                x.blocks[1][0].scope = c.MLN_PLUGIN_UNIFORM_LAYER;
            }
        }.f },
        .{ .expected = "plugin shader property binding is malformed", .apply = struct {
            fn f(x: *Mutable) void {
                x.bindings[10].maximum_attribute_id = x.bindings[10].minimum_attribute_id;
            }
        }.f },
        .{ .expected = "plugin shader property bindings contain overlapping uniform ranges", .apply = struct {
            fn f(x: *Mutable) void {
                x.bindings[1].interpolation_uniform_byte_offset = x.bindings[0].interpolation_uniform_byte_offset;
            }
        }.f },
        .{ .expected = "plugin shader property bindings contain overlapping uniform ranges", .apply = struct {
            fn f(x: *Mutable) void {
                x.bindings[0].interpolation_uniform_byte_offset = x.bindings[0].uniform_byte_offset;
            }
        }.f },
        .{
            .expected = "plugin shader attribute locations must be contiguous and start at zero",
            .apply = struct {
                fn f(x: *Mutable) void {
                    // Drop location 3 by moving the last attribute into its place.
                    x.attributes[3] = x.attributes[15];
                    x.shaders[1].attribute_count = 15;
                }
            }.f,
        },
        .{ .expected = "plugin shader uniform block is malformed or duplicated", .apply = struct {
            fn f(x: *Mutable) void {
                x.blocks[0][0].byte_size = 4030;
            }
        }.f },
        .{ .expected = "plugin shader declares more than one drawable uniform block for a packed stage slot", .apply = struct {
            fn f(x: *Mutable) void {
                x.blocks[0][1].uniform_id = 7;
                x.blocks[0][1].name = str("Other");
                x.shaders[0].uniform_block_count = 2;
            }
        }.f },
        .{ .expected = "plugin property enum default is not an allowed value", .apply = struct {
            fn f(x: *Mutable) void {
                x.emitter_properties[0].default_value.data.string_value = str("line");
            }
        }.f },
        .{
            .expected = "data-driven plugin properties require a shader property binding",
            .apply = struct {
                fn f(x: *Mutable) void {
                    // Unbind particle-color.
                    x.bindings[10] = x.bindings[x.bindings.len - 1];
                    x.shaders[1].property_binding_count -= 1;
                }
            }.f,
        },
        .{ .expected = "frame callbacks apply only to source-free plugin layers", .apply = struct {
            fn f(x: *Mutable) void {
                x.layers[1].build_frame = layer_types[0].build_frame;
            }
        }.f },
    };
    for (mutations) |mutation| {
        m.init();
        mutation.apply(&m);
        const failure = registry.check(&m.descriptor) orelse {
            std.debug.print("accepted, expected: {s}\n", .{mutation.expected});
            return error.TestUnexpectedAccept;
        };
        try std.testing.expectEqualStrings(mutation.expected, failure);
    }
}

test "drawables feed exactly the attributes the host does not" {
    // The host requires the drawable's attribute bindings plus every
    // binding's attribute ids to be the shader's declared attributes
    // (plugin_bucket.cpp copyGeometry).
    inline for (.{ .{ shaders.emitter_shaders[0], &shaders.emitter_vertex_bindings }, .{ shaders.features_shaders[0], &shaders.features_vertex_bindings } }) |pair| {
        const shader = pair[0];
        var fed: u32 = 0;
        for (pair[1]) |binding| {
            try std.testing.expectEqual(@as(u32, 0), fed & (@as(u32, 1) << @intCast(binding.attribute_id)));
            fed |= @as(u32, 1) << @intCast(binding.attribute_id);
        }
        if (shader.property_binding_count != 0) {
            for (shader.property_bindings[0..shader.property_binding_count]) |binding| {
                for (binding.minimum_attribute_id..binding.maximum_attribute_id + 1) |id| {
                    try std.testing.expectEqual(@as(u32, 0), fed & (@as(u32, 1) << @intCast(id)));
                    fed |= @as(u32, 1) << @intCast(id);
                }
            }
        }
        try std.testing.expectEqual((@as(u32, 1) << @intCast(shader.attribute_count)) - 1, fed);
        // The host binds location 0 on GL by the first attribute's name.
        try std.testing.expectEqual(@as(u32, 0), shader.attributes[0].location);
        try std.testing.expectEqual(@as(u32, 0), pair[1][0].attribute_id);
    }
}
