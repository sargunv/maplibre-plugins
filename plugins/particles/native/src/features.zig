//! particle-features' callbacks: the tile layout on the layout workers
//! (layout.zig places the particle slots), update_uniform_block (uniform
//! id 1) and should_animate.
//!
//! A tile's bucket is one stream of a_emit vertices, one drawable and one
//! segment of at most 16383 quads over the shared quad index pattern. Every
//! vertex belongs to exactly one feature range, as the host requires of a
//! shader with property bindings: that is how the four data-driven
//! properties reach each feature's particles.

const std = @import("std");
const c = @import("maplibre_native_c");
const properties = @import("properties.zig");
const shaders = @import("shaders.zig");
const clock = @import("clock.zig");
const layout = @import("layout.zig");

const str = properties.str;
const allocator = std.heap.c_allocator;

/// One tile's layout plus the C views handed back to the host in
/// finish_layout, which must stay valid until destroy_layout.
const TileLayout = struct {
    geometry: layout.Layout,
    points: std.ArrayList(layout.Point) = .empty,
    paths: std.ArrayList([]const layout.Point) = .empty,
    ranges: std.ArrayList(c.mln_plugin_feature_vertex_range_v1) = .empty,
    segment: c.mln_plugin_segment_v1 = undefined,
    stream: c.mln_plugin_vertex_stream_v1 = undefined,
    drawable: c.mln_plugin_drawable_descriptor_v1 = undefined,

    fn deinit(self: *TileLayout) void {
        self.geometry.deinit();
        self.points.deinit(allocator);
        self.paths.deinit(allocator);
        self.ranges.deinit(allocator);
    }
};

pub fn createLayout(context: [*c]const c.mln_plugin_layout_context_v1, instance: [*c]?*anyopaque) callconv(.c) c.mln_plugin_status {
    if (context == null or instance == null or context.*.struct_size < @sizeOf(c.mln_plugin_layout_context_v1) or context.*.extent == 0) return c.MLN_PLUGIN_STATUS_INVALID_ARGUMENT;
    const tile = allocator.create(TileLayout) catch return c.MLN_PLUGIN_STATUS_CALLBACK_ERROR;
    tile.* = .{ .geometry = layout.Layout.init(allocator, context.*.extent) };
    instance.* = tile;
    return c.MLN_PLUGIN_STATUS_OK;
}

pub fn layoutFeature(instance: ?*anyopaque, feature: [*c]const c.mln_plugin_feature_v1) callconv(.c) c.mln_plugin_status {
    const tile: *TileLayout = @ptrCast(@alignCast(instance orelse return c.MLN_PLUGIN_STATUS_INVALID_ARGUMENT));
    if (feature == null or feature.*.struct_size < @sizeOf(c.mln_plugin_feature_v1)) return c.MLN_PLUGIN_STATUS_INVALID_ARGUMENT;
    const f = feature.*;
    const kind: layout.Kind = switch (f.geometry_type) {
        c.MLN_PLUGIN_GEOMETRY_POINT => .point,
        c.MLN_PLUGIN_GEOMETRY_LINESTRING => .line,
        c.MLN_PLUGIN_GEOMETRY_POLYGON => .polygon,
        else => return c.MLN_PLUGIN_STATUS_OK,
    };
    if (f.path_count == 0) return c.MLN_PLUGIN_STATUS_OK;
    if (f.path_offsets == null or (f.point_count > 0 and f.points == null)) return c.MLN_PLUGIN_STATUS_INVALID_ARGUMENT;
    const offsets = f.path_offsets[0 .. f.path_count + 1];
    if (offsets[0] != 0 or offsets[f.path_count] != f.point_count) return c.MLN_PLUGIN_STATUS_INVALID_ARGUMENT;
    for (offsets[0..f.path_count], offsets[1..]) |start, end| if (start > end) return c.MLN_PLUGIN_STATUS_INVALID_ARGUMENT;
    tile.points.clearRetainingCapacity();
    tile.paths.clearRetainingCapacity();
    tile.points.ensureTotalCapacity(allocator, f.point_count) catch return c.MLN_PLUGIN_STATUS_CALLBACK_ERROR;
    if (f.point_count > 0) {
        for (f.points[0..f.point_count]) |p| tile.points.appendAssumeCapacity(.{ .x = p.x, .y = p.y });
    }
    for (offsets[0..f.path_count], offsets[1..]) |start, end| {
        tile.paths.append(allocator, tile.points.items[start..end]) catch return c.MLN_PLUGIN_STATUS_CALLBACK_ERROR;
    }
    tile.geometry.add(kind, f.feature_index, tile.paths.items) catch return c.MLN_PLUGIN_STATUS_CALLBACK_ERROR;
    return c.MLN_PLUGIN_STATUS_OK;
}

/// The part of the host's bucket finish_layout writes: everything up to the
/// feature vertex ranges. Frame features are for source-free layers only.
const bucket_size = properties.bucketSize("feature_vertex_range_count");

pub fn finishLayout(instance: ?*anyopaque, bucket: [*c]c.mln_plugin_bucket_v1) callconv(.c) c.mln_plugin_status {
    const tile: *TileLayout = @ptrCast(@alignCast(instance orelse return c.MLN_PLUGIN_STATUS_INVALID_ARGUMENT));
    if (bucket == null or bucket.*.struct_size < bucket_size) return c.MLN_PLUGIN_STATUS_INVALID_ARGUMENT;
    const out: *c.mln_plugin_bucket_v1 = @ptrCast(bucket);
    const geometry = &tile.geometry;
    geometry.finish() catch return c.MLN_PLUGIN_STATUS_CALLBACK_ERROR;
    tile.ranges.clearRetainingCapacity();
    for (geometry.ranges.items) |range| {
        tile.ranges.append(allocator, .{ .struct_size = @sizeOf(c.mln_plugin_feature_vertex_range_v1), .feature_index = range.feature_index, .drawable_key = 1, .first_vertex = range.first_vertex, .vertex_count = range.vertex_count }) catch return c.MLN_PLUGIN_STATUS_CALLBACK_ERROR;
    }
    const vertices = geometry.vertices.items;
    const quads = geometry.quads();
    tile.segment = .{ .struct_size = @sizeOf(c.mln_plugin_segment_v1), .vertex_offset = 0, .index_offset = 0, .vertex_length = 4 * quads, .index_length = 6 * quads };
    tile.stream = .{ .struct_size = @sizeOf(c.mln_plugin_vertex_stream_v1), .stream_id = 0, .data = @ptrCast(vertices.ptr), .data_size = vertices.len * @sizeOf(layout.Vertex), .vertex_count = 4 * quads, .stride = @sizeOf(layout.Vertex) };
    tile.drawable = .{ .struct_size = @sizeOf(c.mln_plugin_drawable_descriptor_v1), .drawable_key = 1, .shader_id = str(shaders.features_shader_id), .attributes = &shaders.features_vertex_bindings, .attribute_count = shaders.features_vertex_bindings.len, .segments = &tile.segment, .segment_count = 1 };
    // An empty tile reports nothing: the host rejects a stream without
    // vertices and drops a drawable without indices.
    properties.clearBucket(out);
    if (quads == 0) return c.MLN_PLUGIN_STATUS_OK;
    out.vertex_streams = &tile.stream;
    out.vertex_stream_count = 1;
    out.indices = &properties.quad_indices;
    out.index_count = 6 * @as(usize, quads);
    out.drawables = &tile.drawable;
    out.drawable_count = 1;
    out.feature_vertex_ranges = tile.ranges.items.ptr;
    out.feature_vertex_range_count = tile.ranges.items.len;
    return c.MLN_PLUGIN_STATUS_OK;
}

pub fn destroyLayout(instance: ?*anyopaque) callconv(.c) void {
    const tile: *TileLayout = @ptrCast(@alignCast(instance orelse return));
    tile.deinit();
    allocator.destroy(tile);
}

/// Fills the plugin-owned head of ParticleFeatureUBO; the host then writes
/// every property binding's value and interpolation factor after it.
pub fn updateUniformBlock(context: [*c]const c.mln_plugin_uniform_context_v1, uniform_id: u32, output: [*c]u8, output_size: usize) callconv(.c) c.mln_plugin_status {
    if (context == null or context.*.struct_size < @sizeOf(c.mln_plugin_uniform_context_v1) or output == null or uniform_id != shaders.features_uniform_id or output_size != @sizeOf(properties.FeatureUBO)) return c.MLN_PLUGIN_STATUS_INVALID_ARGUMENT;
    const ctx = context.*;
    var block = std.mem.zeroes(properties.FeatureUBO);
    block.matrix = ctx.tile_matrix;
    block.camera = .{ ctx.pixels_to_tile_units, ctx.pixel_ratio, @floatCast(clock.pluginTime()), ctx.camera_to_center_distance };
    block.screen = .{ ctx.pixels_to_gl_units[0], ctx.pixels_to_gl_units[1], @floatFromInt(ctx.viewport_width), @floatFromInt(ctx.viewport_height) };
    @memcpy(output[0..output_size], std.mem.asBytes(&block));
    return c.MLN_PLUGIN_STATUS_OK;
}

/// Always animating. The host asks only while the layer is evaluated, and
/// a zoom change never re-evaluates a plugin layer, so a layer that stopped
/// while zoomed out of its effect would stay frozen.
pub fn shouldAnimate(_: [*c]const c.mln_plugin_property_value_v1, _: usize) callconv(.c) u8 {
    return 1;
}

// ---------------------------------------------------------------------------
// Tests: buckets the host accepts. layout.zig tests the placement itself
// against the shared fixtures.
// ---------------------------------------------------------------------------

test {
    _ = layout;
}

const ok: c.mln_plugin_status = c.MLN_PLUGIN_STATUS_OK;
const invalid: c.mln_plugin_status = c.MLN_PLUGIN_STATUS_INVALID_ARGUMENT;

/// The bytes of one vertex attribute type, as the host sizes it
/// (plugin::attributeType, gfx::VertexAttribute::getStrideOf); 0 for a type
/// it does not know.
fn attributeSize(attribute_type: c.mln_plugin_vertex_attribute_type) u32 {
    return switch (attribute_type) {
        c.MLN_PLUGIN_VERTEX_INT16, c.MLN_PLUGIN_VERTEX_UINT16 => 2,
        c.MLN_PLUGIN_VERTEX_INT16_X2, c.MLN_PLUGIN_VERTEX_UINT16_X2, c.MLN_PLUGIN_VERTEX_FLOAT, c.MLN_PLUGIN_VERTEX_UINT8_X4_NORMALIZED => 4,
        c.MLN_PLUGIN_VERTEX_FLOAT_X2 => 8,
        c.MLN_PLUGIN_VERTEX_FLOAT_X3 => 12,
        c.MLN_PLUGIN_VERTEX_FLOAT_X4 => 16,
        else => 0,
    };
}

/// The vertex count of the drawable with this key: the length of the
/// streams its attributes read. Null when there is none, as for the host,
/// which copies no drawable without attributes.
fn drawableVertexCount(bucket: c.mln_plugin_bucket_v1, key: u64) ?u32 {
    for (0..bucket.drawable_count) |i| {
        const drawable = bucket.drawables[i];
        if (drawable.drawable_key != key) continue;
        const binding = drawable.attributes[0];
        for (0..bucket.vertex_stream_count) |j| {
            if (bucket.vertex_streams[j].stream_id == binding.stream_id) return bucket.vertex_streams[j].vertex_count;
        }
    }
    return null;
}

/// The host's checks on a tile bucket, check for check: PluginBucket::
/// copyGeometry (plugin_bucket.cpp) and the feature range rules of
/// PluginLayout (plugin_layout.cpp), for this type's one binding shader.
/// Returns why the host would reject the bucket, or null.
fn rejection(bucket: c.mln_plugin_bucket_v1, feature_count: u64) ?[]const u8 {
    if (bucket.struct_size < @sizeOf(c.mln_plugin_bucket_v1) or !std.math.isFinite(bucket.query_radius) or bucket.query_radius < 0) return "bucket header";
    if ((bucket.vertex_stream_count > 0 and bucket.vertex_streams == null) or (bucket.index_count > 0 and bucket.indices == null) or
        (bucket.drawable_count > 0 and bucket.drawables == null) or (bucket.feature_vertex_range_count > 0 and bucket.feature_vertex_ranges == null)) return "null array with a count";
    for (0..bucket.vertex_stream_count) |i| {
        const stream = bucket.vertex_streams[i];
        if (stream.struct_size < @sizeOf(c.mln_plugin_vertex_stream_v1) or stream.stride == 0 or stream.vertex_count == 0 or stream.data == null) return "stream";
        if (stream.data_size != @as(usize, stream.stride) * stream.vertex_count) return "stream data_size != stride * vertex_count";
        for (0..i) |j| if (bucket.vertex_streams[j].stream_id == stream.stream_id) return "duplicate stream id";
    }
    const shader = shaders.features_shaders[0];
    // The attributes the host feeds: each binding's minimum and maximum.
    var host_attributes: u32 = 0;
    for (shader.property_bindings[0..shader.property_binding_count]) |binding| {
        host_attributes |= @as(u32, 1) << @intCast(binding.minimum_attribute_id);
        host_attributes |= @as(u32, 1) << @intCast(binding.maximum_attribute_id);
    }
    for (0..bucket.drawable_count) |i| {
        const drawable = bucket.drawables[i];
        if (drawable.struct_size < @sizeOf(c.mln_plugin_drawable_descriptor_v1) or drawable.shader_id.data == null or drawable.shader_id.size == 0 or
            drawable.attribute_count == 0 or drawable.attributes == null or drawable.segment_count == 0 or drawable.segments == null) return "drawable";
        for (0..i) |j| if (bucket.drawables[j].drawable_key == drawable.drawable_key) return "duplicate drawable key";
        if (!std.mem.eql(u8, drawable.shader_id.data[0..drawable.shader_id.size], shaders.features_shader_id)) return "unknown shader";
        if (drawable.attribute_count + @popCount(host_attributes) != shader.attribute_count) return "attribute count";
        var bound: u32 = 0;
        var vertex_count: ?u32 = null;
        for (drawable.attributes[0..drawable.attribute_count]) |binding| {
            if (binding.struct_size < @sizeOf(c.mln_plugin_attribute_binding_v1)) return "attribute binding";
            const stream = for (0..bucket.vertex_stream_count) |j| {
                if (bucket.vertex_streams[j].stream_id == binding.stream_id) break bucket.vertex_streams[j];
            } else return "binding to a missing stream";
            const attribute = for (shader.attributes[0..shader.attribute_count]) |a| {
                if (a.attribute_id == binding.attribute_id) break a;
            } else return "unknown attribute";
            const size = attributeSize(attribute.type);
            if (size == 0) return "attribute type";
            const bit = @as(u32, 1) << @intCast(binding.attribute_id);
            if (host_attributes & bit != 0) return "attribute the host feeds";
            // Bounded by the vertex (the stream's stride), not the stream.
            if (binding.byte_offset > stream.stride or size > stream.stride - binding.byte_offset) return "attribute past the vertex";
            if (bound & bit != 0) return "duplicate attribute";
            bound |= bit;
            if (vertex_count != null and vertex_count.? != stream.vertex_count) return "streams of unequal length";
            vertex_count = stream.vertex_count;
        }
        for (drawable.segments[0..drawable.segment_count]) |segment| {
            if (segment.struct_size < @sizeOf(c.mln_plugin_segment_v1) or segment.index_offset > bucket.index_count or segment.index_length > bucket.index_count - segment.index_offset) return "segment indices";
            if (segment.vertex_offset > vertex_count.? or segment.vertex_length > vertex_count.? - segment.vertex_offset) return "segment vertices";
            for (segment.index_offset..segment.index_offset + segment.index_length) |j| if (bucket.indices[j] >= segment.vertex_length) return "index past the segment";
            // Also this plugin's own contract: whole quads, one 16-bit segment.
            if (segment.vertex_offset % 4 != 0 or segment.vertex_length % 4 != 0 or segment.index_length != segment.vertex_length / 4 * 6 or segment.vertex_length > 4 * properties.segment_quads) return "segment shape";
        }
        if (bucket.index_count == 0) return "drawable without indices (dropped silently)";
    }
    for (0..bucket.feature_vertex_range_count) |i| {
        const range = bucket.feature_vertex_ranges[i];
        if (range.struct_size < @sizeOf(c.mln_plugin_feature_vertex_range_v1) or range.feature_index >= feature_count) return "range";
        const count = drawableVertexCount(bucket, range.drawable_key) orelse return "range of a missing drawable";
        if (range.vertex_count == 0 or range.first_vertex > count or range.vertex_count > count - range.first_vertex) return "range bounds";
    }
    // Every vertex of each binding shader drawable in exactly one range.
    for (0..bucket.drawable_count) |i| {
        const drawable = bucket.drawables[i];
        const coverage = std.testing.allocator.alloc(u8, drawableVertexCount(bucket, drawable.drawable_key).?) catch return "out of memory";
        defer std.testing.allocator.free(coverage);
        @memset(coverage, 0);
        for (0..bucket.feature_vertex_range_count) |j| {
            const range = bucket.feature_vertex_ranges[j];
            if (range.drawable_key != drawable.drawable_key) continue;
            for (coverage[range.first_vertex .. range.first_vertex + range.vertex_count]) |*covered| {
                if (covered.* != 0) return "overlapping ranges";
                covered.* = 1;
            }
        }
        if (std.mem.indexOfScalar(u8, coverage, 0) != null) return "vertex outside every range";
    }
    return null;
}

fn testFeature(geometry: c.mln_plugin_geometry_type, points: []const c.mln_plugin_tile_point_v1, offsets: []const u32, index: u64) c.mln_plugin_feature_v1 {
    return .{
        .struct_size = @sizeOf(c.mln_plugin_feature_v1),
        .geometry_type = geometry,
        .feature_index = index,
        .points = points.ptr,
        .point_count = points.len,
        .path_offsets = offsets.ptr,
        .path_count = offsets.len - 1,
    };
}

const layout_context = c.mln_plugin_layout_context_v1{ .struct_size = @sizeOf(c.mln_plugin_layout_context_v1), .zoom = 14, .extent = 8192 };

fn emptyBucket() c.mln_plugin_bucket_v1 {
    var bucket = std.mem.zeroes(c.mln_plugin_bucket_v1);
    bucket.struct_size = @sizeOf(c.mln_plugin_bucket_v1);
    return bucket;
}

fn expectAccepted(bucket: c.mln_plugin_bucket_v1, feature_count: u64) !void {
    if (rejection(bucket, feature_count)) |why| {
        std.debug.print("host would reject the bucket: {s}\n", .{why});
        return error.RejectedBucket;
    }
}

test "a tile of points, lines and polygons becomes one bucket the host accepts" {
    var instance: ?*anyopaque = null;
    try std.testing.expectEqual(ok, createLayout(&layout_context, &instance));
    defer destroyLayout(instance);
    // Feature 0: two points as vector tiles send them (a path each), one in
    // the neighbour's buffer. Feature 1: a polyline. Feature 2: a point
    // outside the tile, which keeps nothing. Feature 3: a lake with an
    // island. Feature 4: a multipoint as GeoJSON sends it (one path).
    const points = [_]c.mln_plugin_tile_point_v1{ .{ .x = 100, .y = 200 }, .{ .x = 8192, .y = 10 } };
    try std.testing.expectEqual(ok, layoutFeature(instance, &testFeature(c.MLN_PLUGIN_GEOMETRY_POINT, &points, &.{ 0, 1, 2 }, 0)));
    const line = [_]c.mln_plugin_tile_point_v1{ .{ .x = 500, .y = 500 }, .{ .x = 1500, .y = 500 }, .{ .x = 1500, .y = 2500 } };
    try std.testing.expectEqual(ok, layoutFeature(instance, &testFeature(c.MLN_PLUGIN_GEOMETRY_LINESTRING, &line, &.{ 0, 3 }, 1)));
    const outside = [_]c.mln_plugin_tile_point_v1{.{ .x = -50, .y = 10 }};
    try std.testing.expectEqual(ok, layoutFeature(instance, &testFeature(c.MLN_PLUGIN_GEOMETRY_POINT, &outside, &.{ 0, 1 }, 2)));
    const lake = [_]c.mln_plugin_tile_point_v1{
        .{ .x = 3000, .y = 3000 }, .{ .x = 5000, .y = 3000 }, .{ .x = 5000, .y = 5000 }, .{ .x = 3000, .y = 5000 }, .{ .x = 3000, .y = 3000 },
        .{ .x = 3500, .y = 3500 }, .{ .x = 3500, .y = 4500 }, .{ .x = 4500, .y = 4500 }, .{ .x = 4500, .y = 3500 }, .{ .x = 3500, .y = 3500 },
    };
    try std.testing.expectEqual(ok, layoutFeature(instance, &testFeature(c.MLN_PLUGIN_GEOMETRY_POLYGON, &lake, &.{ 0, 5, 10 }, 3)));
    const multipoint = [_]c.mln_plugin_tile_point_v1{ .{ .x = 7000, .y = 7000 }, .{ .x = 7100, .y = 7000 } };
    try std.testing.expectEqual(ok, layoutFeature(instance, &testFeature(c.MLN_PLUGIN_GEOMETRY_POINT, &multipoint, &.{ 0, 2 }, 4)));

    var bucket = emptyBucket();
    try std.testing.expectEqual(ok, finishLayout(instance, &bucket));
    try expectAccepted(bucket, 5);
    try std.testing.expectEqual(@as(usize, 1), bucket.vertex_stream_count);
    try std.testing.expectEqual(@as(usize, 1), bucket.drawable_count);
    try std.testing.expectEqual(@as(u32, 16), bucket.vertex_streams[0].stride);
    try std.testing.expectEqual(@as(u64, 1), bucket.drawables[0].drawable_key);
    try std.testing.expectEqual(@as(usize, 1), bucket.drawables[0].segment_count);
    // One range per feature that kept slots, in feature order.
    try std.testing.expectEqual(@as(usize, 4), bucket.feature_vertex_range_count);
    const ranges = bucket.feature_vertex_ranges[0..4];
    try std.testing.expectEqual(@as(u64, 0), ranges[0].feature_index);
    try std.testing.expectEqual(@as(u32, 4 * 16), ranges[0].vertex_count);
    try std.testing.expectEqual(@as(u64, 1), ranges[1].feature_index);
    // 1000 / 32 and 2000 / 32 round to 31 and 63 slots.
    try std.testing.expectEqual(@as(u32, 4 * (31 + 63)), ranges[1].vertex_count);
    try std.testing.expectEqual(@as(u64, 3), ranges[2].feature_index);
    try std.testing.expectEqual(@as(u64, 4), ranges[3].feature_index);
    try std.testing.expectEqual(@as(u32, 4 * 32), ranges[3].vertex_count);
    const vertices: [*]const layout.Vertex = @ptrCast(@alignCast(bucket.vertex_streams[0].data));
    // The lake's candidates avoid the island.
    for (vertices[ranges[2].first_vertex .. ranges[2].first_vertex + ranges[2].vertex_count]) |v| {
        try std.testing.expect(v[0] > 3000 and v[0] < 5000 and v[1] > 3000 and v[1] < 5000);
        try std.testing.expect(!(v[0] > 3500 and v[0] < 4500 and v[1] > 3500 and v[1] < 4500));
    }
}

test "an empty tile reports no streams, drawables or indices" {
    var instance: ?*anyopaque = null;
    try std.testing.expectEqual(ok, createLayout(&layout_context, &instance));
    defer destroyLayout(instance);
    // Only geometry the tile does not own, and a degenerate line.
    const buffer_point = [_]c.mln_plugin_tile_point_v1{.{ .x = 8300, .y = 8300 }};
    try std.testing.expectEqual(ok, layoutFeature(instance, &testFeature(c.MLN_PLUGIN_GEOMETRY_POINT, &buffer_point, &.{ 0, 1 }, 0)));
    const dot = [_]c.mln_plugin_tile_point_v1{ .{ .x = 10, .y = 10 }, .{ .x = 10, .y = 10 } };
    try std.testing.expectEqual(ok, layoutFeature(instance, &testFeature(c.MLN_PLUGIN_GEOMETRY_LINESTRING, &dot, &.{ 0, 2 }, 1)));
    var bucket = emptyBucket();
    try std.testing.expectEqual(ok, finishLayout(instance, &bucket));
    try expectAccepted(bucket, 2);
    try std.testing.expectEqual(@as(usize, 0), bucket.vertex_stream_count);
    try std.testing.expectEqual(@as(usize, 0), bucket.drawable_count);
    try std.testing.expectEqual(@as(usize, 0), bucket.index_count);
    try std.testing.expectEqual(@as(usize, 0), bucket.feature_vertex_range_count);
}

test "a dense tile keeps one full segment" {
    var instance: ?*anyopaque = null;
    try std.testing.expectEqual(ok, createLayout(&layout_context, &instance));
    defer destroyLayout(instance);
    // Five polygons covering the tile: 5 x 4096 cells.
    const square = [_]c.mln_plugin_tile_point_v1{ .{ .x = -100, .y = -100 }, .{ .x = 8300, .y = -100 }, .{ .x = 8300, .y = 8300 }, .{ .x = -100, .y = 8300 }, .{ .x = -100, .y = -100 } };
    for (0..5) |i| try std.testing.expectEqual(ok, layoutFeature(instance, &testFeature(c.MLN_PLUGIN_GEOMETRY_POLYGON, &square, &.{ 0, 5 }, i)));
    var bucket = emptyBucket();
    try std.testing.expectEqual(ok, finishLayout(instance, &bucket));
    try expectAccepted(bucket, 5);
    try std.testing.expectEqual(@as(u32, 4 * properties.segment_quads), bucket.drawables[0].segments[0].vertex_length);
    try std.testing.expectEqual(@as(usize, 6 * properties.segment_quads), bucket.index_count);
    try std.testing.expectEqual(@as(usize, properties.quad_indices.len), bucket.index_count);
    try std.testing.expectEqual(@as(usize, 5), bucket.feature_vertex_range_count);
}

test "the acceptance mimic rejects what the host rejects" {
    var instance: ?*anyopaque = null;
    try std.testing.expectEqual(ok, createLayout(&layout_context, &instance));
    defer destroyLayout(instance);
    const points = [_]c.mln_plugin_tile_point_v1{ .{ .x = 100, .y = 200 }, .{ .x = 300, .y = 400 } };
    try std.testing.expectEqual(ok, layoutFeature(instance, &testFeature(c.MLN_PLUGIN_GEOMETRY_POINT, points[0..1], &.{ 0, 1 }, 0)));
    try std.testing.expectEqual(ok, layoutFeature(instance, &testFeature(c.MLN_PLUGIN_GEOMETRY_POINT, points[1..2], &.{ 0, 1 }, 1)));
    var bucket = emptyBucket();
    try std.testing.expectEqual(ok, finishLayout(instance, &bucket));
    try expectAccepted(bucket, 2);
    // A feature index past the source layer, a gap, an overlap, a short
    // stream and an index past its segment.
    try std.testing.expect(rejection(bucket, 1) != null);
    var ranges = [2]c.mln_plugin_feature_vertex_range_v1{ bucket.feature_vertex_ranges[0], bucket.feature_vertex_ranges[1] };
    var broken = bucket;
    broken.feature_vertex_ranges = &ranges;
    ranges[1].first_vertex += 4;
    ranges[1].vertex_count -= 4;
    try std.testing.expectEqualStrings("vertex outside every range", rejection(broken, 2).?);
    ranges[1] = bucket.feature_vertex_ranges[1];
    ranges[1].first_vertex -= 4;
    ranges[1].vertex_count += 4;
    try std.testing.expectEqualStrings("overlapping ranges", rejection(broken, 2).?);
    ranges[1] = bucket.feature_vertex_ranges[1];
    ranges[1].drawable_key = 2;
    try std.testing.expectEqualStrings("range of a missing drawable", rejection(broken, 2).?);
    var stream = bucket.vertex_streams[0];
    stream.data_size -= 16;
    broken = bucket;
    broken.vertex_streams = &stream;
    try std.testing.expect(rejection(broken, 2) != null);
    broken = bucket;
    broken.index_count = 6 * 33;
    var segment = bucket.drawables[0].segments[0];
    segment.index_length = 6 * 33;
    var drawable = bucket.drawables[0];
    drawable.segments = &segment;
    broken.drawables = &drawable;
    try std.testing.expectEqualStrings("index past the segment", rejection(broken, 2).?);

    // The host bounds an attribute by the vertex, not the stream: a_emit
    // (16 bytes) at offset 4 of a 16-byte vertex, or in an 8-byte one.
    var binding = bucket.drawables[0].attributes[0];
    binding.byte_offset = 4;
    drawable = bucket.drawables[0];
    drawable.attributes = &binding;
    broken = bucket;
    broken.drawables = &drawable;
    try std.testing.expectEqualStrings("attribute past the vertex", rejection(broken, 2).?);
    stream = bucket.vertex_streams[0];
    stream.stride = 8;
    stream.data_size = 8 * @as(usize, stream.vertex_count);
    broken = bucket;
    broken.vertex_streams = &stream;
    try std.testing.expectEqualStrings("attribute past the vertex", rejection(broken, 2).?);
    // A shader id with no bytes, and two drawables with one key.
    drawable = bucket.drawables[0];
    drawable.shader_id = .{ .data = null, .size = 0 };
    broken = bucket;
    broken.drawables = &drawable;
    try std.testing.expectEqualStrings("drawable", rejection(broken, 2).?);
    const twins = [2]c.mln_plugin_drawable_descriptor_v1{ bucket.drawables[0], bucket.drawables[0] };
    broken = bucket;
    broken.drawables = &twins;
    broken.drawable_count = 2;
    try std.testing.expectEqualStrings("duplicate drawable key", rejection(broken, 2).?);
}

test "finish_layout checks the host's bucket size and writes only inside it" {
    const HostBucket = properties.HostBucket;
    const point = [_]c.mln_plugin_tile_point_v1{.{ .x = 100, .y = 200 }};
    // A host whose bucket ends right after the feature ranges (a header
    // before frame features), the v1 bucket, and a longer one than this
    // plugin knows: each gets the same bucket and nothing past its size, and
    // keeps its struct_size. An empty tile clears only what fits.
    for ([_]u32{ bucket_size, @sizeOf(c.mln_plugin_bucket_v1), @sizeOf(c.mln_plugin_bucket_v1) + 64 }) |size| {
        for ([_]bool{ false, true }) |empty| {
            var instance: ?*anyopaque = null;
            try std.testing.expectEqual(ok, createLayout(&layout_context, &instance));
            defer destroyLayout(instance);
            if (!empty) try std.testing.expectEqual(ok, layoutFeature(instance, &testFeature(c.MLN_PLUGIN_GEOMETRY_POINT, &point, &.{ 0, 1 }, 0)));
            var host = HostBucket.init(size);
            try std.testing.expectEqual(ok, finishLayout(instance, host.bucket()));
            try host.expectWrittenWithin(size);
            const out = host.bucket().*;
            try std.testing.expectEqual(@as(usize, if (empty) 0 else 1), out.drawable_count);
            try std.testing.expectEqual(@as(usize, if (empty) 0 else 1), out.feature_vertex_range_count);
            if (!empty) try std.testing.expectEqual(@as(u32, 4 * 16), out.feature_vertex_ranges[0].vertex_count);
        }
    }
    // One byte short of the feature ranges: refused and untouched.
    var instance: ?*anyopaque = null;
    try std.testing.expectEqual(ok, createLayout(&layout_context, &instance));
    defer destroyLayout(instance);
    try std.testing.expectEqual(ok, layoutFeature(instance, &testFeature(c.MLN_PLUGIN_GEOMETRY_POINT, &point, &.{ 0, 1 }, 0)));
    var short = HostBucket.init(bucket_size - 1);
    try std.testing.expectEqual(invalid, finishLayout(instance, short.bucket()));
    try short.expectUntouchedFrom(bucket_size - 1, @sizeOf(@FieldType(c.mln_plugin_bucket_v1, "struct_size")));
}

test "layout rejects malformed features and ignores unknown geometry" {
    var instance: ?*anyopaque = null;
    try std.testing.expectEqual(ok, createLayout(&layout_context, &instance));
    defer destroyLayout(instance);
    const points = [_]c.mln_plugin_tile_point_v1{ .{ .x = 100, .y = 200 }, .{ .x = 300, .y = 400 } };
    try std.testing.expectEqual(invalid, layoutFeature(instance, &testFeature(c.MLN_PLUGIN_GEOMETRY_POINT, &points, &.{ 0, 1 }, 0)));
    try std.testing.expectEqual(invalid, layoutFeature(instance, &testFeature(c.MLN_PLUGIN_GEOMETRY_LINESTRING, &points, &.{ 0, 3, 2 }, 0)));
    var null_points = testFeature(c.MLN_PLUGIN_GEOMETRY_POINT, &points, &.{ 0, 2 }, 0);
    null_points.points = null;
    try std.testing.expectEqual(invalid, layoutFeature(instance, &null_points));
    try std.testing.expectEqual(ok, layoutFeature(instance, &testFeature(0, &points, &.{ 0, 2 }, 0)));
    try std.testing.expectEqual(invalid, layoutFeature(null, &testFeature(c.MLN_PLUGIN_GEOMETRY_POINT, &points, &.{ 0, 2 }, 0)));
    var bad_context = layout_context;
    bad_context.extent = 0;
    var other: ?*anyopaque = null;
    try std.testing.expectEqual(invalid, createLayout(&bad_context, &other));
    try std.testing.expectEqual(@as(?*anyopaque, null), other);
}

test "the uniform block carries the tile matrix, camera and screen" {
    var context = std.mem.zeroes(c.mln_plugin_uniform_context_v1);
    context.struct_size = @sizeOf(c.mln_plugin_uniform_context_v1);
    for (0..16) |i| context.tile_matrix[i] = @floatFromInt(i);
    context.pixels_to_tile_units = 16;
    context.pixel_ratio = 2;
    context.camera_to_center_distance = 700;
    context.pixels_to_gl_units = .{ 0.0025, -0.004 };
    context.viewport_width = 800;
    context.viewport_height = 500;
    var output: [@sizeOf(properties.FeatureUBO)]u8 align(@alignOf(properties.FeatureUBO)) = @splat(0xAA);
    try std.testing.expectEqual(ok, updateUniformBlock(&context, shaders.features_uniform_id, &output, output.len));
    const block: *const properties.FeatureUBO = @ptrCast(@alignCast(&output));
    try std.testing.expectEqual(context.tile_matrix, block.matrix);
    try std.testing.expectEqual(@as(f32, 16), block.camera[0]);
    try std.testing.expectEqual(@as(f32, 2), block.camera[1]);
    try std.testing.expect(block.camera[2] >= 0 and block.camera[2] < clock.wrap_seconds);
    try std.testing.expectEqual(@as(f32, 700), block.camera[3]);
    try std.testing.expectEqual([4]f32{ 0.0025, -0.004, 800, 500 }, block.screen);
    // The host-written part starts zeroed.
    try std.testing.expectEqual(@as(f32, 0), block.density);
    try std.testing.expectEqual(@as(f32, 0), block.interpolation[13]);
    try std.testing.expectEqual(invalid, updateUniformBlock(&context, 0, &output, output.len));
    try std.testing.expectEqual(invalid, updateUniformBlock(&context, shaders.features_uniform_id, &output, output.len - 16));
    context.struct_size = 4;
    try std.testing.expectEqual(invalid, updateUniformBlock(&context, shaders.features_uniform_id, &output, output.len));
}
