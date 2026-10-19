//! OSM-style building layer for MapLibre Native's plugin ABI: a replacement
//! for fill-extrusion that draws walls and roof:shape roofs. The host feeds
//! the source's polygons with their evaluated layout properties; layout.zig
//! builds walls and roofs, shaders.zig wraps the shared shader code
//! (../../shaders) that positions and lights them as core fill-extrusion
//! does, and query.zig hit-tests the projected prisms. See ../../spec.json
//! for the properties and ../../README.md ("Rendering") for the contract
//! this file shares with the maplibre-gl-js twin.

const std = @import("std");
const build_options = @import("build_options");
const c = @import("maplibre_native_c");
const layout = @import("layout.zig");
const query = @import("query.zig");
const shaders = @import("shaders.zig");
const spec = @import("spec.zig");

pub const layer_type_name = spec.layer_type;
pub const plugin_id = "org.maplibre.plugins.building";
pub const plugin_version = "0.1.0";

fn str(comptime text: []const u8) c.mln_plugin_string {
    return .{ .data = text.ptr, .size = text.len };
}

// ---------------------------------------------------------------------------
// Properties. Keep in sync with ../../spec.json, layout table first, then the
// paint table, each in spec order (the host's definition order); the
// "descriptors match the shared spec" test enforces it.
// ---------------------------------------------------------------------------

const Kind = enum { float, float2, color, enumeration, boolean };

const Property = struct {
    name: []const u8,
    kind: Kind,
    /// float: {v}; float2: {x, y}; color: straight-alpha rgba; boolean: {0 or 1}.
    default: [4]f32 = .{ 0, 0, 0, 0 },
    /// Enum values; the first is the default.
    values: []const []const u8 = &.{},
    minimum: ?f32 = null,
    maximum: ?f32 = null,
    /// Feature and composite expressions (and feature-state for paint).
    data_driven: bool = false,
    is_layout: bool = false,
};

fn enumNames(comptime E: type) []const []const u8 {
    return comptime blk: {
        const fields = @typeInfo(E).@"enum".fields;
        var names: [fields.len][]const u8 = undefined;
        for (fields, 0..) |field, i| names[i] = field.name;
        const final = names;
        break :blk &final;
    };
}

const properties = [_]Property{
    .{ .name = "building-roof-shape", .kind = .enumeration, .values = enumNames(spec.RoofShape), .data_driven = true, .is_layout = true },
    .{ .name = "building-roof-orientation", .kind = .enumeration, .values = enumNames(spec.RoofOrientation), .data_driven = true, .is_layout = true },
    .{ .name = "building-roof-direction", .kind = .float, .default = .{ -1, 0, 0, 0 }, .minimum = -1, .maximum = 360, .data_driven = true, .is_layout = true },
    .{ .name = "building-height", .kind = .float, .minimum = 0, .data_driven = true },
    .{ .name = "building-base", .kind = .float, .minimum = 0, .data_driven = true },
    .{ .name = "building-roof-height", .kind = .float, .default = .{ 3, 0, 0, 0 }, .minimum = 0, .data_driven = true },
    .{ .name = "building-roof-angle", .kind = .float, .minimum = 0, .maximum = 89, .data_driven = true },
    .{ .name = "building-color", .kind = .color, .default = .{ 0, 0, 0, 1 }, .data_driven = true },
    .{ .name = "building-roof-color", .kind = .color, .default = .{ 0, 0, 0, 1 }, .data_driven = true },
    .{ .name = "building-opacity", .kind = .float, .default = .{ 1, 0, 0, 0 }, .minimum = 0, .maximum = 1 },
    .{ .name = "building-translate", .kind = .float2 },
    .{ .name = "building-translate-anchor", .kind = .enumeration, .values = &.{ "map", "viewport" } },
    .{ .name = "building-vertical-gradient", .kind = .boolean, .default = .{ 1, 0, 0, 0 } },
};

fn valueType(kind: Kind) c.mln_plugin_value_type {
    return switch (kind) {
        .float => c.MLN_PLUGIN_VALUE_FLOAT,
        .float2 => c.MLN_PLUGIN_VALUE_FLOAT2,
        .color => c.MLN_PLUGIN_VALUE_COLOR,
        .enumeration => c.MLN_PLUGIN_VALUE_STRING,
        .boolean => c.MLN_PLUGIN_VALUE_BOOLEAN,
    };
}

fn enumStrings(comptime values: []const []const u8) []const c.mln_plugin_string {
    return comptime blk: {
        var result: [values.len]c.mln_plugin_string = undefined;
        for (values, 0..) |text, i| result[i] = str(text);
        const final = result;
        break :blk &final;
    };
}

fn descriptor(comptime property: Property) c.mln_plugin_property_descriptor_v1 {
    const value_type = valueType(property.kind);
    const d = property.default;
    const data: c.mln_plugin_value_data = switch (property.kind) {
        .float => .{ .float_value = d[0] },
        .float2 => .{ .float2_value = .{ .x = d[0], .y = d[1] } },
        .color => .{ .color_value = .{ .r = d[0], .g = d[1], .b = d[2], .a = d[3] } },
        .enumeration => .{ .string_value = str(property.values[0]) },
        .boolean => .{ .boolean_value = @intFromFloat(d[0]) },
    };
    var capabilities: u32 = c.MLN_PLUGIN_EXPRESSION_CAMERA;
    if (property.data_driven) {
        capabilities |= c.MLN_PLUGIN_EXPRESSION_FEATURE | c.MLN_PLUGIN_EXPRESSION_COMPOSITE;
        if (!property.is_layout) capabilities |= c.MLN_PLUGIN_EXPRESSION_FEATURE_STATE;
    }
    const values = if (property.kind == .enumeration) enumStrings(property.values) else &[_]c.mln_plugin_string{};
    return .{
        .struct_size = @sizeOf(c.mln_plugin_property_descriptor_v1),
        .name = str(property.name),
        .type = value_type,
        .default_value = .{ .struct_size = @sizeOf(c.mln_plugin_value), .type = value_type, .data = data },
        .expression_capabilities = capabilities,
        // Layout values never transition; enums and booleans are discrete.
        .supports_transitions = @intFromBool(!property.is_layout and property.kind != .enumeration and property.kind != .boolean),
        .has_minimum = @intFromBool(property.minimum != null),
        .has_maximum = @intFromBool(property.maximum != null),
        .minimum = property.minimum orelse 0,
        .maximum = property.maximum orelse 0,
        .enum_values = if (values.len > 0) values.ptr else null,
        .enum_value_count = values.len,
        .is_layout = @intFromBool(property.is_layout),
    };
}

const property_descriptors = blk: {
    var result: [properties.len]c.mln_plugin_property_descriptor_v1 = undefined;
    for (properties, 0..) |property, i| result[i] = descriptor(property);
    break :blk result;
};

/// A property's value by name, from a host property array.
fn value(props: []const c.mln_plugin_property_value_v1, comptime name: []const u8) ?c.mln_plugin_value {
    for (props) |property| {
        if (property.name.size == name.len and property.name.data != null and std.mem.eql(u8, property.name.data[0..name.len], name)) return property.value;
    }
    return null;
}

fn floatValue(props: []const c.mln_plugin_property_value_v1, comptime name: []const u8, default: f32) f32 {
    const v = value(props, name) orelse return default;
    return if (v.type == c.MLN_PLUGIN_VALUE_FLOAT and std.math.isFinite(v.data.float_value)) v.data.float_value else default;
}

fn float2Value(props: []const c.mln_plugin_property_value_v1, comptime name: []const u8) c.mln_plugin_float2 {
    const v = value(props, name) orelse return .{ .x = 0, .y = 0 };
    return if (v.type == c.MLN_PLUGIN_VALUE_FLOAT2) v.data.float2_value else .{ .x = 0, .y = 0 };
}

fn stringValue(props: []const c.mln_plugin_property_value_v1, comptime name: []const u8) []const u8 {
    const v = value(props, name) orelse return "";
    if (v.type != c.MLN_PLUGIN_VALUE_STRING or v.data.string_value.data == null) return "";
    return v.data.string_value.data[0..v.data.string_value.size];
}

/// An enum layout value as its static tag name, so it outlives the host's
/// borrowed string; unknown values give "" (the layout's fallback).
fn enumTag(comptime E: type, text: []const u8) []const u8 {
    const tag = std.meta.stringToEnum(E, text) orelse return "";
    return @tagName(tag);
}

/// The layout values from a host property array: the context's (camera
/// expressions) or a feature's own.
fn layoutValues(props: []const c.mln_plugin_property_value_v1) layout.LayoutValues {
    return .{
        .shape = enumTag(spec.RoofShape, stringValue(props, "building-roof-shape")),
        .orientation = enumTag(spec.RoofOrientation, stringValue(props, "building-roof-orientation")),
        .direction = floatValue(props, "building-roof-direction", -1),
    };
}

// ---------------------------------------------------------------------------
// Layout callbacks (tile workers).
// ---------------------------------------------------------------------------

const Vertex = layout.Vertex;
const drawable_key: u64 = 1;

const attribute_bindings = [_]c.mln_plugin_attribute_binding_v1{
    .{ .struct_size = @sizeOf(c.mln_plugin_attribute_binding_v1), .attribute_id = shaders.pos_attribute, .stream_id = 0, .byte_offset = layout.pos_offset },
    .{ .struct_size = @sizeOf(c.mln_plugin_attribute_binding_v1), .attribute_id = shaders.roof_attribute, .stream_id = 0, .byte_offset = layout.roof_offset },
};

/// One tile's layout: the geometry builder plus the C views handed back to
/// the host in finish_layout, which must outlive the callback until destroy.
const TileLayout = struct {
    geometry: layout.BuildingLayout,
    /// The layout values of the tile, for features the host sends without
    /// their own (an older host).
    tile_values: layout.LayoutValues,
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
    if (context.*.property_count > 0 and context.*.properties == null) return c.MLN_PLUGIN_STATUS_INVALID_ARGUMENT;
    const props = if (context.*.property_count > 0) context.*.properties[0..context.*.property_count] else &[_]c.mln_plugin_property_value_v1{};
    const tile = allocator.create(TileLayout) catch return c.MLN_PLUGIN_STATUS_CALLBACK_ERROR;
    tile.* = .{ .geometry = layout.BuildingLayout.init(allocator, context.*.extent), .tile_values = layoutValues(props) };
    instance.* = tile;
    return c.MLN_PLUGIN_STATUS_OK;
}

/// Whether the host's feature struct carries per-feature layout values.
fn hasLayoutProperties(feature: *const c.mln_plugin_feature_v1) bool {
    return feature.struct_size >= @offsetOf(c.mln_plugin_feature_v1, "layout_property_count") + @sizeOf(usize) and
        (feature.layout_property_count == 0 or feature.layout_properties != null);
}

fn layoutFeature(instance: ?*anyopaque, feature: [*c]const c.mln_plugin_feature_v1) callconv(.c) c.mln_plugin_status {
    const tile: *TileLayout = @ptrCast(@alignCast(instance orelse return c.MLN_PLUGIN_STATUS_INVALID_ARGUMENT));
    if (feature == null or feature.*.struct_size < @offsetOf(c.mln_plugin_feature_v1, "layout_properties")) return c.MLN_PLUGIN_STATUS_INVALID_ARGUMENT;
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
    const values = if (hasLayoutProperties(feature))
        layoutValues(if (f.layout_property_count > 0) f.layout_properties[0..f.layout_property_count] else &.{})
    else
        tile.tile_values;
    tile.geometry.addFeature(tile.rings.items, f.feature_index, values) catch return c.MLN_PLUGIN_STATUS_CALLBACK_ERROR;
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
        tile.ranges.append(allocator, .{ .struct_size = @sizeOf(c.mln_plugin_feature_vertex_range_v1), .feature_index = range.feature_index, .drawable_key = drawable_key, .first_vertex = range.first_vertex, .vertex_count = range.vertex_count }) catch return c.MLN_PLUGIN_STATUS_CALLBACK_ERROR;
    }
    const vertices = geometry.vertices.items;
    tile.stream = .{ .struct_size = @sizeOf(c.mln_plugin_vertex_stream_v1), .stream_id = 0, .data = @ptrCast(vertices.ptr), .data_size = vertices.len * @sizeOf(Vertex), .vertex_count = @intCast(vertices.len), .stride = @sizeOf(Vertex) };
    // The layer's draw passes select depth, stencil and culling, so the
    // drawable's own depth_mode, stencil and cull fields stay zero.
    tile.drawable = .{ .struct_size = @sizeOf(c.mln_plugin_drawable_descriptor_v1), .drawable_key = drawable_key, .shader_id = str(shaders.shader_id), .attributes = &attribute_bindings, .attribute_count = attribute_bindings.len, .segments = tile.segments.items.ptr, .segment_count = tile.segments.items.len };
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

/// MapLibre Native's util::EARTH_RADIUS_M, the radius of its projection, so
/// a roof angle renders as the true angle (../../README.md, "Tile units and
/// meters").
pub const earth_radius_m: f64 = 6378137;

/// Meters per tile unit at the center latitude of a canonical tile.
pub fn metersPerTileUnit(tile_x: u32, tile_y: u32, tile_z: u8, extent: f64) f64 {
    _ = tile_x;
    const n = std.math.pow(f64, 2, @floatFromInt(tile_z));
    const y = (@as(f64, @floatFromInt(tile_y)) + 0.5) / n;
    const latitude = std.math.atan(std.math.sinh(std.math.pi * (1 - 2 * y)));
    return 2 * std.math.pi * earth_radius_m * @cos(latitude) / (n * extent);
}

fn updateUniformBlock(context: [*c]const c.mln_plugin_uniform_context_v1, uniform_id: u32, output: [*c]u8, output_size: usize) callconv(.c) c.mln_plugin_status {
    if (context == null or context.*.struct_size < @sizeOf(c.mln_plugin_uniform_context_v1) or uniform_id != shaders.uniform_id or output == null or output_size != @sizeOf(shaders.DrawableUBO)) return c.MLN_PLUGIN_STATUS_INVALID_ARGUMENT;
    const ctx = context.*;
    // The binders write the property values and factors after this.
    var block = std.mem.zeroes(shaders.DrawableUBO);
    block.tile_matrix = ctx.tile_matrix;
    block.light_color = .{ ctx.light_color[0], ctx.light_color[1], ctx.light_color[2], ctx.light_intensity };
    block.light_position = .{ ctx.light_direction[0], ctx.light_direction[1], ctx.light_direction[2], 0 };
    block.meters_per_tile_unit = @floatCast(metersPerTileUnit(ctx.tile_x, ctx.tile_y, ctx.tile_z, spec.extent));
    @memcpy(output[0..output_size], std.mem.asBytes(&block));
    return c.MLN_PLUGIN_STATUS_OK;
}

/// Passes 0 (opaque), 1 (depth only) and 2 (translucent, deduplicated), as
/// #4685's fill-extrusion declares them; every one culls back faces with
/// counter-clockwise front faces, the layout's winding.
const draw_passes = [_]c.mln_plugin_draw_pass_v1{
    .{ .struct_size = @sizeOf(c.mln_plugin_draw_pass_v1), .depth_test = 1, .depth_write = 1, .color_write = 1, .blend = 1, .stencil_dedup = 0, .cull = c.MLN_PLUGIN_CULL_BACK_CCW },
    .{ .struct_size = @sizeOf(c.mln_plugin_draw_pass_v1), .depth_test = 1, .depth_write = 1, .color_write = 0, .blend = 0, .stencil_dedup = 0, .cull = c.MLN_PLUGIN_CULL_BACK_CCW },
    .{ .struct_size = @sizeOf(c.mln_plugin_draw_pass_v1), .depth_test = 1, .depth_write = 1, .color_write = 1, .blend = 1, .stencil_dedup = 1, .cull = c.MLN_PLUGIN_CULL_BACK_CCW },
};

/// The enabled passes for a layer opacity: none when invisible, the opaque
/// pass at 1, else depth first and then only the nearest surface, once per
/// pixel, so no internal face shows.
pub fn enabledPasses(opacity: f32) u32 {
    if (!(opacity > 0)) return 0;
    return if (opacity >= 1) 0b001 else 0b110;
}

fn isViewport(props: []const c.mln_plugin_property_value_v1) bool {
    return std.mem.eql(u8, stringValue(props, "building-translate-anchor"), "viewport");
}

fn evaluateLayer(props: [*c]const c.mln_plugin_property_value_v1, count: usize, output: [*c]c.mln_plugin_layer_evaluation_v1) callconv(.c) c.mln_plugin_status {
    if (output == null or output.*.struct_size < @sizeOf(c.mln_plugin_layer_evaluation_v1) or (count > 0 and props == null)) return c.MLN_PLUGIN_STATUS_INVALID_ARGUMENT;
    const values = if (count > 0) props[0..count] else &[_]c.mln_plugin_property_value_v1{};
    output.*.enabled_passes = enabledPasses(floatValue(values, "building-opacity", 1));
    output.*.translation = float2Value(values, "building-translate");
    output.*.translation_anchor_viewport = @intFromBool(isViewport(values));
    return c.MLN_PLUGIN_STATUS_OK;
}

/// The broad phase needs no padding beyond the translation: the precise test
/// projects the prism (see ../../README.md, "Plugin API gaps", for the tall
/// buildings this misses).
fn queryRadius(_: [*c]const c.mln_plugin_property_statistics_v1, _: usize, props: [*c]const c.mln_plugin_property_value_v1, count: usize) callconv(.c) f32 {
    if (props == null or count == 0) return 0;
    const translate = float2Value(props[0..count], "building-translate");
    const radius = std.math.hypot(translate.x, translate.y);
    return if (std.math.isFinite(radius)) radius else 0;
}

fn queryFeature(
    feature: [*c]const c.mln_plugin_feature_v1,
    query_geometry: [*c]const c.mln_plugin_tile_point_v1,
    query_count: usize,
    context: [*c]const c.mln_plugin_query_context_v1,
    props: [*c]const c.mln_plugin_property_value_v1,
    property_count: usize,
) callconv(.c) u8 {
    if (feature == null or query_geometry == null or query_count == 0 or context == null or context.*.struct_size < @sizeOf(c.mln_plugin_query_context_v1)) return 0;
    if (feature.*.struct_size < @offsetOf(c.mln_plugin_feature_v1, "layout_properties")) return 0;
    const f = feature.*;
    if (f.geometry_type != c.MLN_PLUGIN_GEOMETRY_POLYGON or f.path_count == 0 or f.points == null or f.path_offsets == null) return 0;
    const offsets = f.path_offsets[0 .. f.path_count + 1];
    if (offsets[f.path_count] != f.point_count) return 0;
    const values = if (property_count > 0 and props != null) props[0..property_count] else &[_]c.mln_plugin_property_value_v1{};

    var arena = std.heap.ArenaAllocator.init(allocator);
    defer arena.deinit();
    const scratch = arena.allocator();
    const points = scratch.alloc(query.Point, f.point_count) catch return 0;
    for (f.points[0..f.point_count], points) |p, *out| out.* = .{ .x = @floatFromInt(p.x), .y = @floatFromInt(p.y) };
    const rings = scratch.alloc([]const query.Point, f.path_count) catch return 0;
    for (rings, 0..) |*ring, i| {
        if (offsets[i] > offsets[i + 1]) return 0;
        ring.* = points[offsets[i]..offsets[i + 1]];
    }
    const query_points = scratch.alloc(query.Point, query_count) catch return 0;
    for (query_geometry[0..query_count], query_points) |p, *out| out.* = .{ .x = @floatFromInt(p.x), .y = @floatFromInt(p.y) };
    const translate = float2Value(values, "building-translate");
    const hit = query.intersects(scratch, rings, query_points, .{
        .height = floatValue(values, "building-height", 0),
        .base = floatValue(values, "building-base", 0),
        .translate = .{ translate.x, translate.y },
        .translate_viewport = isViewport(values),
    }, .{
        .tile_matrix = context.*.tile_matrix,
        .pixels_to_tile_units = context.*.pixels_to_tile_units,
        .bearing = context.*.bearing,
    }) catch return 0;
    return @intFromBool(hit);
}

const layer_type = c.mln_plugin_layer_type_v1{
    .struct_size = @sizeOf(c.mln_plugin_layer_type_v1),
    .layer_type = str(layer_type_name),
    .backend_mask = c.MLN_PLUGIN_BACKEND_OPENGL | c.MLN_PLUGIN_BACKEND_VULKAN | c.MLN_PLUGIN_BACKEND_METAL,
    .properties = &property_descriptors,
    .property_count = property_descriptors.len,
    .geometry_type_mask = c.MLN_PLUGIN_GEOMETRY_POLYGON,
    .shaders = &shaders.descriptors,
    .shader_count = shaders.descriptors.len,
    .create_layout = createLayout,
    .layout_feature = layoutFeature,
    .finish_layout = finishLayout,
    .destroy_layout = destroyLayout,
    .query_feature = queryFeature,
    .update_uniform_block = updateUniformBlock,
    .get_query_radius = queryRadius,
    .replace_builtin = 0,
    .is_3d = 1,
    // Always explicit: the carried host gives an is_3d layer without passes
    // 2D depth (../../README.md, "Draw passes, opacity and translate").
    .draw_passes = &draw_passes,
    .draw_pass_count = draw_passes.len,
    .evaluate_layer = evaluateLayer,
    .enable_near_clipped_matrix = 1,
    .should_animate = null,
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
export fn mln_building_register(
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
    _ = query;
    _ = shaders;
}

fn jsonNumber(v: std.json.Value) f64 {
    return switch (v) {
        .integer => |i| @floatFromInt(i),
        .float => |f| f,
        else => std.math.nan(f64),
    };
}

fn expectDescriptor(name: []const u8, entry: std.json.ObjectMap, d: c.mln_plugin_property_descriptor_v1, is_layout: bool) !void {
    errdefer std.debug.print("property {s}\n", .{name});
    try std.testing.expectEqualStrings(name, d.name.data[0..d.name.size]);
    try std.testing.expectEqual(@as(u8, @intFromBool(is_layout)), d.is_layout);
    const type_name = entry.get("type").?.string;
    const default = entry.get("default").?;
    const actual = d.default_value.data;
    var transitionable = true;
    if (std.mem.eql(u8, type_name, "float")) {
        try std.testing.expectEqual(@as(c_uint, c.MLN_PLUGIN_VALUE_FLOAT), d.type);
        try std.testing.expectApproxEqAbs(@as(f32, @floatCast(jsonNumber(default))), actual.float_value, 1e-6);
    } else if (std.mem.eql(u8, type_name, "float2")) {
        try std.testing.expectEqual(@as(c_uint, c.MLN_PLUGIN_VALUE_FLOAT2), d.type);
        try std.testing.expectApproxEqAbs(@as(f32, @floatCast(jsonNumber(default.array.items[0]))), actual.float2_value.x, 1e-6);
        try std.testing.expectApproxEqAbs(@as(f32, @floatCast(jsonNumber(default.array.items[1]))), actual.float2_value.y, 1e-6);
    } else if (std.mem.eql(u8, type_name, "color")) {
        try std.testing.expectEqual(@as(c_uint, c.MLN_PLUGIN_VALUE_COLOR), d.type);
        const rgba = default.array.items;
        try std.testing.expectApproxEqAbs(@as(f32, @floatCast(jsonNumber(rgba[0]))), actual.color_value.r, 1e-6);
        try std.testing.expectApproxEqAbs(@as(f32, @floatCast(jsonNumber(rgba[1]))), actual.color_value.g, 1e-6);
        try std.testing.expectApproxEqAbs(@as(f32, @floatCast(jsonNumber(rgba[2]))), actual.color_value.b, 1e-6);
        try std.testing.expectApproxEqAbs(@as(f32, @floatCast(jsonNumber(rgba[3]))), actual.color_value.a, 1e-6);
    } else if (std.mem.eql(u8, type_name, "enum")) {
        transitionable = false;
        try std.testing.expectEqual(@as(c_uint, c.MLN_PLUGIN_VALUE_STRING), d.type);
        try std.testing.expectEqualStrings(default.string, actual.string_value.data[0..actual.string_value.size]);
        const values = entry.get("values").?.array.items;
        try std.testing.expectEqual(values.len, d.enum_value_count);
        for (values, d.enum_values[0..d.enum_value_count]) |expected, got| try std.testing.expectEqualStrings(expected.string, got.data[0..got.size]);
    } else if (std.mem.eql(u8, type_name, "boolean")) {
        transitionable = false;
        try std.testing.expectEqual(@as(c_uint, c.MLN_PLUGIN_VALUE_BOOLEAN), d.type);
        try std.testing.expectEqual(@as(u8, @intFromBool(default.bool)), actual.boolean_value);
    } else return error.UnknownSpecType;
    if (!std.mem.eql(u8, type_name, "enum")) try std.testing.expectEqual(@as(usize, 0), d.enum_value_count);

    const minimum = entry.get("minimum");
    const maximum = entry.get("maximum");
    try std.testing.expectEqual(@as(u8, if (minimum != null) 1 else 0), d.has_minimum);
    try std.testing.expectEqual(@as(u8, if (maximum != null) 1 else 0), d.has_maximum);
    if (minimum) |v| try std.testing.expectApproxEqAbs(@as(f32, @floatCast(jsonNumber(v))), d.minimum, 1e-6);
    if (maximum) |v| try std.testing.expectApproxEqAbs(@as(f32, @floatCast(jsonNumber(v))), d.maximum, 1e-6);

    // "expressions" absent means camera; data-driven paint allows
    // feature-state unless "featureState" is false.
    const expressions = if (entry.get("expressions")) |e| e.string else "camera";
    var capabilities: u32 = c.MLN_PLUGIN_EXPRESSION_CAMERA;
    if (std.mem.eql(u8, expressions, "data-driven")) {
        capabilities |= c.MLN_PLUGIN_EXPRESSION_FEATURE | c.MLN_PLUGIN_EXPRESSION_COMPOSITE;
        const feature_state = if (entry.get("featureState")) |s| s.bool else true;
        if (feature_state) capabilities |= c.MLN_PLUGIN_EXPRESSION_FEATURE_STATE;
    } else try std.testing.expectEqualStrings("camera", expressions);
    try std.testing.expectEqual(capabilities, d.expression_capabilities);
    const transition = if (entry.get("transition")) |t| t.bool else transitionable;
    try std.testing.expectEqual(@as(u8, @intFromBool(transition)), d.supports_transitions);
}

test "descriptors match the shared spec" {
    var parsed = try std.json.parseFromSlice(std.json.Value, std.testing.allocator, build_options.spec_json, .{});
    defer parsed.deinit();
    const root = parsed.value.object;
    try std.testing.expectEqualStrings(layer_type_name, root.get("layerType").?.string);
    try std.testing.expectEqualStrings("polygon", root.get("geometry").?.string);
    const native = root.get("native").?.object;
    try std.testing.expectEqualStrings(plugin_id, native.get("pluginId").?.string);
    try std.testing.expectEqualStrings(plugin_version, native.get("pluginVersion").?.string);
    try std.testing.expectEqualStrings("mln_building_register", native.get("entryPoint").?.string);

    // Declaration order is the host's property order: layout, then paint.
    const layout_table = root.get("layout").?.object;
    const paint_table = root.get("paint").?.object;
    try std.testing.expectEqual(layout_table.count() + paint_table.count(), property_descriptors.len);
    var index: usize = 0;
    inline for (.{ .{ layout_table, true }, .{ paint_table, false } }) |table| {
        var it = table[0].iterator();
        while (it.next()) |entry| : (index += 1) {
            try expectDescriptor(entry.key_ptr.*, entry.value_ptr.object, property_descriptors[index], table[1]);
        }
    }
    // Every bound property is a paint property, in paint order.
    var paint_names = paint_table.iterator();
    var bound: usize = 0;
    while (paint_names.next()) |entry| {
        if (bound < shaders.bindings.len and std.mem.eql(u8, entry.key_ptr.*, shaders.bindings[bound].property)) bound += 1;
    }
    try std.testing.expectEqual(shaders.bindings.len, bound);
}

test "the layer type matches the rendering contract" {
    var parsed = try std.json.parseFromSlice(std.json.Value, std.testing.allocator, build_options.render_contract_json, .{});
    defer parsed.deinit();
    const contract = parsed.value.object;
    try std.testing.expectEqualStrings(layer_type_name, contract.get("layerType").?.string);
    try std.testing.expectEqual(contract.get("is3d").?.bool, layer_type.is_3d == 1);
    try std.testing.expectEqual(contract.get("enableNearClippedMatrix").?.bool, layer_type.enable_near_clipped_matrix == 1);

    const stream = contract.get("vertexStream").?.object;
    try std.testing.expectEqual(stream.get("stride").?.integer, @sizeOf(Vertex));
    const stream_attributes = stream.get("attributes").?.array.items;
    try std.testing.expectEqual(stream_attributes.len, attribute_bindings.len);
    for (stream_attributes, attribute_bindings) |expected, actual| {
        const name = expected.object.get("name").?.string;
        const attribute = shaders.attributes[actual.attribute_id];
        try std.testing.expectEqualStrings(name, attribute.name.data[0..attribute.name.size]);
        try std.testing.expectEqual(expected.object.get("byteOffset").?.integer, actual.byte_offset);
        try std.testing.expectEqual(stream.get("streamId").?.integer, actual.stream_id);
    }

    const passes = contract.get("drawPasses").?.array.items;
    try std.testing.expectEqual(passes.len, draw_passes.len);
    for (passes, draw_passes) |expected, actual| {
        const pass = expected.object;
        try std.testing.expectEqual(pass.get("depthTest").?.bool, actual.depth_test == 1);
        try std.testing.expectEqual(pass.get("depthWrite").?.bool, actual.depth_write == 1);
        try std.testing.expectEqual(pass.get("colorWrite").?.bool, actual.color_write == 1);
        try std.testing.expectEqual(pass.get("blend").?.bool, actual.blend == 1);
        try std.testing.expectEqual(pass.get("stencilDedup").?.bool, actual.stencil_dedup == 1);
        try std.testing.expectEqualStrings("CULL_BACK_CCW", pass.get("cull").?.string);
        try std.testing.expectEqual(@as(c_uint, c.MLN_PLUGIN_CULL_BACK_CCW), actual.cull);
    }
    for (contract.get("enabledPasses").?.array.items) |entry| {
        const opacity: f32 = @floatCast(jsonNumber(entry.object.get("opacity").?));
        try std.testing.expectEqual(@as(u32, @intCast(entry.object.get("mask").?.integer)), enabledPasses(opacity));
    }
    const radius = contract.get("lighting").?.object.get("earthRadius").?.object.get("native").?;
    try std.testing.expectEqual(earth_radius_m, jsonNumber(radius));
    try std.testing.expectEqual(@as(f64, @floatFromInt(contract.get("lighting").?.object.get("tileExtent").?.integer)), @as(f64, spec.extent));
}

fn propertyArray(comptime n: usize) [n]c.mln_plugin_property_value_v1 {
    var props: [n]c.mln_plugin_property_value_v1 = undefined;
    for (property_descriptors[0..n], 0..) |d, i| props[i] = .{ .struct_size = @sizeOf(c.mln_plugin_property_value_v1), .name = d.name, .value = d.default_value };
    return props;
}

fn propertyIndex(comptime name: []const u8) usize {
    inline for (properties, 0..) |property, i| {
        if (comptime std.mem.eql(u8, property.name, name)) return i;
    }
    @compileError("unknown property " ++ name);
}

fn testFeature(points: []const c.mln_plugin_tile_point_v1, offsets: []const u32, index: u64, layout_props: []const c.mln_plugin_property_value_v1) c.mln_plugin_feature_v1 {
    return .{
        .struct_size = @sizeOf(c.mln_plugin_feature_v1),
        .geometry_type = c.MLN_PLUGIN_GEOMETRY_POLYGON,
        .feature_index = index,
        .points = points.ptr,
        .point_count = points.len,
        .path_offsets = offsets.ptr,
        .path_count = offsets.len - 1,
        .layout_properties = layout_props.ptr,
        .layout_property_count = layout_props.len,
    };
}

/// An MVT exterior ring (positive shoelace area in tile coordinates) of a
/// 2000 x 1000 rectangle, closed.
const rectangle = [_]c.mln_plugin_tile_point_v1{ .{ .x = 1000, .y = 1000 }, .{ .x = 3000, .y = 1000 }, .{ .x = 3000, .y = 2000 }, .{ .x = 1000, .y = 2000 }, .{ .x = 1000, .y = 1000 } };

fn layoutBucket(instance: ?*anyopaque) !c.mln_plugin_bucket_v1 {
    var bucket = std.mem.zeroes(c.mln_plugin_bucket_v1);
    bucket.struct_size = @sizeOf(c.mln_plugin_bucket_v1);
    try std.testing.expectEqual(@as(c.mln_plugin_status, c.MLN_PLUGIN_STATUS_OK), finishLayout(instance, &bucket));
    return bucket;
}

/// The roof vertices (kind 2) of a bucket and their largest n.
fn roofSummary(bucket: c.mln_plugin_bucket_v1) struct { count: usize, max_n: f32, max_run: f32 } {
    const stream = bucket.vertex_streams[0];
    const vertices: []const Vertex = @as([*]const Vertex, @ptrCast(@alignCast(stream.data)))[0..stream.vertex_count];
    var count: usize = 0;
    var max_n: f32 = 0;
    var max_run: f32 = 0;
    for (vertices) |v| {
        if (v.kind != layout.roof_kind) continue;
        count += 1;
        max_n = @max(max_n, v.n);
        max_run = @max(max_run, v.run);
    }
    return .{ .count = count, .max_n = max_n, .max_run = max_run };
}

test "layout callbacks build a bucket from each feature's own layout values" {
    const tile_props = propertyArray(3);
    const context = c.mln_plugin_layout_context_v1{ .struct_size = @sizeOf(c.mln_plugin_layout_context_v1), .zoom = 15, .extent = 8192, .properties = &tile_props, .property_count = tile_props.len, .tile_x = 17680, .tile_y = 11102, .tile_z = 15 };
    var instance: ?*anyopaque = null;
    try std.testing.expectEqual(@as(c.mln_plugin_status, c.MLN_PLUGIN_STATUS_OK), createLayout(&context, &instance));
    defer destroyLayout(instance);

    // A gabled roof from the feature's values, over the tile's flat default.
    var gabled = propertyArray(3);
    gabled[propertyIndex("building-roof-shape")].value.data.string_value = str("gabled");
    const offsets = [_]u32{ 0, rectangle.len };
    try std.testing.expectEqual(@as(c.mln_plugin_status, c.MLN_PLUGIN_STATUS_OK), layoutFeature(instance, &testFeature(&rectangle, &offsets, 7, &gabled)));
    // A point feature is ignored by the polygon-only layer.
    var point_feature = testFeature(rectangle[0..1], &[_]u32{ 0, 1 }, 8, &.{});
    point_feature.geometry_type = c.MLN_PLUGIN_GEOMETRY_POINT;
    try std.testing.expectEqual(@as(c.mln_plugin_status, c.MLN_PLUGIN_STATUS_OK), layoutFeature(instance, &point_feature));

    const bucket = try layoutBucket(instance);
    try std.testing.expectEqual(@as(usize, 1), bucket.vertex_stream_count);
    try std.testing.expectEqual(@as(usize, 1), bucket.drawable_count);
    const stream = bucket.vertex_streams[0];
    try std.testing.expectEqual(@as(u32, 28), stream.stride);
    try std.testing.expectEqual(@as(usize, stream.vertex_count * @sizeOf(Vertex)), stream.data_size);
    try std.testing.expectEqual(@as(usize, 1), bucket.feature_vertex_range_count);
    try std.testing.expectEqual(@as(u64, 7), bucket.feature_vertex_ranges[0].feature_index);
    try std.testing.expectEqual(drawable_key, bucket.feature_vertex_ranges[0].drawable_key);
    try std.testing.expectEqual(stream.vertex_count, bucket.feature_vertex_ranges[0].vertex_count);
    const drawable = bucket.drawables[0];
    try std.testing.expectEqualStrings(shaders.shader_id, drawable.shader_id.data[0..drawable.shader_id.size]);
    try std.testing.expectEqual(drawable_key, drawable.drawable_key);
    try std.testing.expectEqual(@as(usize, 2), drawable.attribute_count);
    try std.testing.expectEqual(@as(u32, 12), drawable.attributes[1].byte_offset);
    var indices: usize = 0;
    for (drawable.segments[0..drawable.segment_count]) |segment| {
        indices += segment.index_length;
        for (bucket.indices[segment.index_offset..][0..segment.index_length]) |index| try std.testing.expect(index < segment.vertex_length);
    }
    try std.testing.expectEqual(bucket.index_count, indices);
    // The gabled ridge reaches n = 1 above eaves at n = 0, with a run of half
    // the rectangle's short side.
    const roof = roofSummary(bucket);
    try std.testing.expect(roof.count > 0);
    try std.testing.expectEqual(@as(f32, 1), roof.max_n);
    try std.testing.expectApproxEqAbs(@as(f32, 500), roof.max_run, 1e-3);
}

test "features without their own layout values take the tile's" {
    var tile_props = propertyArray(3);
    tile_props[propertyIndex("building-roof-shape")].value.data.string_value = str("hipped");
    const context = c.mln_plugin_layout_context_v1{ .struct_size = @sizeOf(c.mln_plugin_layout_context_v1), .zoom = 15, .extent = 8192, .properties = &tile_props, .property_count = tile_props.len };
    var instance: ?*anyopaque = null;
    try std.testing.expectEqual(@as(c.mln_plugin_status, c.MLN_PLUGIN_STATUS_OK), createLayout(&context, &instance));
    defer destroyLayout(instance);
    const offsets = [_]u32{ 0, rectangle.len };
    var feature = testFeature(&rectangle, &offsets, 1, &.{});
    // An older host's feature ends before layout_properties.
    feature.struct_size = @offsetOf(c.mln_plugin_feature_v1, "layout_properties");
    try std.testing.expectEqual(@as(c.mln_plugin_status, c.MLN_PLUGIN_STATUS_OK), layoutFeature(instance, &feature));
    try std.testing.expectApproxEqAbs(@as(f32, 500), roofSummary(try layoutBucket(instance)).max_run, 1e-3);

    // Unknown shape strings draw flat roofs: run 0.
    var unknown = propertyArray(3);
    unknown[propertyIndex("building-roof-shape")].value.data.string_value = str("triple_skillion");
    var flat_instance: ?*anyopaque = null;
    try std.testing.expectEqual(@as(c.mln_plugin_status, c.MLN_PLUGIN_STATUS_OK), createLayout(&context, &flat_instance));
    defer destroyLayout(flat_instance);
    try std.testing.expectEqual(@as(c.mln_plugin_status, c.MLN_PLUGIN_STATUS_OK), layoutFeature(flat_instance, &testFeature(&rectangle, &offsets, 1, &unknown)));
    const flat = roofSummary(try layoutBucket(flat_instance));
    try std.testing.expectEqual(@as(f32, 0), flat.max_run);
    try std.testing.expectEqual(@as(f32, 1), flat.max_n);

    // An empty tile reports no drawables rather than empty streams.
    var empty_instance: ?*anyopaque = null;
    try std.testing.expectEqual(@as(c.mln_plugin_status, c.MLN_PLUGIN_STATUS_OK), createLayout(&context, &empty_instance));
    defer destroyLayout(empty_instance);
    const empty = try layoutBucket(empty_instance);
    try std.testing.expectEqual(@as(usize, 0), empty.drawable_count);
    try std.testing.expectEqual(@as(usize, 0), empty.vertex_stream_count);
}

test "uniform block carries the tile matrix, the light and meters per tile unit" {
    var context = std.mem.zeroes(c.mln_plugin_uniform_context_v1);
    context.struct_size = @sizeOf(c.mln_plugin_uniform_context_v1);
    for (0..16) |i| context.tile_matrix[i] = @floatFromInt(i);
    context.light_color = .{ 1, 0.5, 0.25 };
    context.light_intensity = 0.4;
    context.light_direction = .{ 0.1, 0.2, 0.9 };
    // Prague at zoom 15.
    context.tile_x = 17680;
    context.tile_y = 11102;
    context.tile_z = 15;
    var output: [@sizeOf(shaders.DrawableUBO)]u8 = undefined;
    try std.testing.expectEqual(@as(c.mln_plugin_status, c.MLN_PLUGIN_STATUS_OK), updateUniformBlock(&context, 0, &output, output.len));
    const block: *const shaders.DrawableUBO = @ptrCast(@alignCast(&output));
    try std.testing.expectEqual(@as(f32, 5), block.tile_matrix[5]);
    try std.testing.expectEqual([4]f32{ 1, 0.5, 0.25, 0.4 }, block.light_color);
    try std.testing.expectEqual([4]f32{ 0.1, 0.2, 0.9, 0 }, block.light_position);
    // A z15 tile is 2πR cos(lat) / 2^15 ≈ 785 m wide at 50.09° N.
    try std.testing.expectApproxEqRel(@as(f32, 785.0 / 8192.0), block.meters_per_tile_unit, 2e-3);
    try std.testing.expectEqual(@as(f32, 0), block.height);
    try std.testing.expectEqual([4]f32{ 0, 0, 0, 0 }, block.interpolation1);
    try std.testing.expectEqual(@as(c.mln_plugin_status, c.MLN_PLUGIN_STATUS_INVALID_ARGUMENT), updateUniformBlock(&context, 1, &output, output.len));
    try std.testing.expectEqual(@as(c.mln_plugin_status, c.MLN_PLUGIN_STATUS_INVALID_ARGUMENT), updateUniformBlock(&context, 0, &output, output.len - 1));
    // The equator's z0 tile: 2πR / 8192.
    try std.testing.expectApproxEqRel(2 * std.math.pi * earth_radius_m / 8192.0, metersPerTileUnit(0, 0, 0, 8192), 1e-12);
}

test "layer evaluation enables passes by opacity and hands the translation over" {
    var props = propertyArray(properties.len);
    var output = c.mln_plugin_layer_evaluation_v1{ .struct_size = @sizeOf(c.mln_plugin_layer_evaluation_v1), .enabled_passes = 0b111 };
    try std.testing.expectEqual(@as(c.mln_plugin_status, c.MLN_PLUGIN_STATUS_OK), evaluateLayer(&props, props.len, &output));
    try std.testing.expectEqual(@as(u32, 0b001), output.enabled_passes);
    try std.testing.expectEqual(@as(u8, 0), output.translation_anchor_viewport);
    props[propertyIndex("building-opacity")].value.data.float_value = 0.5;
    props[propertyIndex("building-translate")].value.data.float2_value = .{ .x = 3, .y = -4 };
    props[propertyIndex("building-translate-anchor")].value.data.string_value = str("viewport");
    try std.testing.expectEqual(@as(c.mln_plugin_status, c.MLN_PLUGIN_STATUS_OK), evaluateLayer(&props, props.len, &output));
    try std.testing.expectEqual(@as(u32, 0b110), output.enabled_passes);
    try std.testing.expectEqual(@as(f32, 3), output.translation.x);
    try std.testing.expectEqual(@as(f32, -4), output.translation.y);
    try std.testing.expectEqual(@as(u8, 1), output.translation_anchor_viewport);
    try std.testing.expectEqual(@as(f32, 5), queryRadius(null, 0, &props, props.len));
    props[propertyIndex("building-opacity")].value.data.float_value = 0;
    try std.testing.expectEqual(@as(c.mln_plugin_status, c.MLN_PLUGIN_STATUS_OK), evaluateLayer(&props, props.len, &output));
    try std.testing.expectEqual(@as(u32, 0), output.enabled_passes);
}

test "query_feature tests the projected prism with the feature's heights" {
    var props = propertyArray(properties.len);
    props[propertyIndex("building-height")].value.data.float_value = 20;
    const offsets = [_]u32{ 0, rectangle.len };
    const feature = testFeature(&rectangle, &offsets, 1, &.{});
    var context = std.mem.zeroes(c.mln_plugin_query_context_v1);
    context.struct_size = @sizeOf(c.mln_plugin_query_context_v1);
    context.pixels_to_tile_units = 4;
    // x' = x / 4096 - 1, y' = 1 - (y - 10 z) / 4096: each meter lifts a point
    // 10 tile units up the screen.
    context.tile_matrix = .{ 1.0 / 4096.0, 0, 0, 0, 0, -1.0 / 4096.0, 0, 0, 0, 10.0 / 4096.0, 1, 0, -1, 1, 0, 1 };
    const inside = [_]c.mln_plugin_tile_point_v1{.{ .x = 2000, .y = 1500 }};
    const above = [_]c.mln_plugin_tile_point_v1{.{ .x = 2000, .y = 900 }};
    const ground = [_]c.mln_plugin_tile_point_v1{.{ .x = 2000, .y = 2500 }};
    try std.testing.expectEqual(@as(u8, 1), queryFeature(&feature, &inside, 1, &context, &props, props.len));
    try std.testing.expectEqual(@as(u8, 1), queryFeature(&feature, &above, 1, &context, &props, props.len));
    try std.testing.expectEqual(@as(u8, 0), queryFeature(&feature, &ground, 1, &context, &props, props.len));
    props[propertyIndex("building-height")].value.data.float_value = 5;
    try std.testing.expectEqual(@as(u8, 0), queryFeature(&feature, &above, 1, &context, &props, props.len));
}

test "registration hands the host the descriptor" {
    const Capture = struct {
        var registered: ?*const c.mln_plugin_descriptor_v1 = null;
        fn register(d: [*c]const c.mln_plugin_descriptor_v1, _: [*c]u8, _: usize) callconv(.c) c.mln_plugin_status {
            registered = d;
            return c.MLN_PLUGIN_STATUS_OK;
        }
    };
    try std.testing.expectEqual(@as(c.mln_plugin_status, c.MLN_PLUGIN_STATUS_OK), mln_building_register(Capture.register, null, 0));
    const registered = Capture.registered.?.layer_types[0];
    try std.testing.expectEqualStrings("building", registered.layer_type.data[0..registered.layer_type.size]);
    try std.testing.expectEqual(@as(usize, 3), registered.draw_pass_count);
    try std.testing.expectEqual(@as(u8, 1), registered.is_3d);
    try std.testing.expectEqual(@as(c.mln_plugin_status, c.MLN_PLUGIN_STATUS_INVALID_ARGUMENT), mln_building_register(null, null, 0));
}
