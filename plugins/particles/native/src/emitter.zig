//! particle-emitter's callbacks: build_frame and the frame table
//! (properties.TableUBO), update_uniform_block (uniform id 0) and
//! should_animate.
//!
//! The frame table. A source-free layer's uniform callback gets no camera and
//! no layer identity, and build_frame cannot write uniforms. So each
//! build_frame packs its layer's paint into one row of a thread-local table
//! (record.pack) and its map's camera into the table header (record.header),
//! and the vertex bytes carry only (vertex index, row). Every layer's uniform
//! update copies the whole table into its LAYER block, and the shader reads
//! its own row. This relies on the host running every layer's build_frame of
//! a frame before that frame's uniform updates, on the same thread, which
//! MapLibre Native's renderer does (renderer_impl.cpp: updateLayers, then the
//! layer groups' tweakers) and the ABI does not promise.
//!
//! One table serves one frame of one map. build_frame starts a new table
//! when a uniform update has read the current one (the frame was drawn), or
//! when the frame time or the camera changed: a new frame, or another map on
//! this thread. Time alone cannot tell them apart in MapMode::Static and
//! Tile, where every render of every map gets time_point::max, so a render
//! that drew no row would otherwise leave its camera in the table for the
//! next. Every layer of one frame reads the same TransformState, so their
//! frames are bit-identical and they share one table.
//!
//! Rows go to layers in build_frame order, so hiding a layer moves the rows
//! after it: their bytes change and the host rebuilds those layers once. At
//! most 16 emitter layers per map draw; the 17th fails its frame. If a frame
//! builds rows that no uniform update reads (its drawables failed) and the
//! host re-renders it at the same time and camera, the rows pile up until
//! that limit.
//!
//! The vertex bytes depend only on the row and the pool size, so camera
//! moves, paint changes, transitions and a moving emitter leave them
//! byte-identical and the host keeps its drawables and buffers.
//!
//! MLN_PARTICLES_DEBUG=1 logs to stderr whenever a frame's rows change (row
//! count, pool sizes, layers over the limit, and the camera), "pool rebuilt
//! N=..., row=..." when the vertex bytes handed out for a row change, and
//! protocol anomalies.

const std = @import("std");
const c = @import("maplibre_native_c");
const properties = @import("properties.zig");
const shaders = @import("shaders.zig");
const clock = @import("clock.zig");
const record = @import("record.zig");

const str = properties.str;
const Header = properties.Header;
const max_rows = properties.max_rows;
const row_vec4s = properties.row_vec4s;

const Table = struct {
    /// What every layer's uniform update copies: the header's camera part
    /// and the clock from the frame that started the table, and one row per
    /// drawn layer (the rest are 0). The update adds the row count, the
    /// screen and h6.xy.
    block: properties.TableUBO = std.mem.zeroes(properties.TableUBO),
    /// Rows handed out this frame.
    count: u8 = 0,
    /// Each row's pool size, and the layers turned away this frame, for the
    /// debug log.
    pools: [max_rows]u32 = @splat(0),
    rejected: u32 = 0,
    /// A uniform update read the table: the next build_frame starts anew.
    consumed: bool = false,
    /// build_frame's time_seconds and camera for the frame the table
    /// belongs to.
    time: f64 = std.math.nan(f64),
    frame: ?record.Frame = null,
};

threadlocal var table: Table = .{};

fn startTable(time: f64, frame: record.Frame) void {
    if (table.count > 0 and !table.consumed) debug.print("table reset before any uniform update read its {d} rows (new time or camera)", .{table.count});
    table.count = 0;
    table.rejected = 0;
    table.consumed = false;
    table.time = time;
    table.frame = frame;
    table.block = .{ .header = record.header(frame), .rows = std.mem.zeroes(@FieldType(properties.TableUBO, "rows")) };
    // One clock reading per frame: every layer animates at the same instant.
    table.block.header[@intFromEnum(Header.clock)] = .{ @floatCast(clock.pluginTime()), @floatCast(clock.wrap_seconds), 0, 1 };
}

/// The part of the host's bucket build_frame writes: the streams, indices
/// and drawables. Frame features (for hit-testing) are never written.
const bucket_size = properties.bucketSize("drawable_count");

/// A frame with nothing to draw: the host removes the layer's drawables.
fn emptyBucket(bucket: *c.mln_plugin_bucket_v1) c.mln_plugin_status {
    properties.clearBucket(bucket);
    return c.MLN_PLUGIN_STATUS_OK;
}

/// Once per visible layer per frame, before the frame's uniform updates:
/// packs the layer's row and returns its (static) vertex bytes.
pub fn buildFrame(context: [*c]const c.mln_plugin_frame_context_v1, bucket: [*c]c.mln_plugin_bucket_v1) callconv(.c) c.mln_plugin_status {
    if (context == null or bucket == null) return c.MLN_PLUGIN_STATUS_INVALID_ARGUMENT;
    const ctx: *const c.mln_plugin_frame_context_v1 = @ptrCast(context);
    const out: *c.mln_plugin_bucket_v1 = @ptrCast(bucket);
    if (ctx.struct_size < @sizeOf(c.mln_plugin_frame_context_v1) or ctx.properties == null or ctx.property_count != properties.emitter_lanes.len or
        out.struct_size < bucket_size)
        return c.MLN_PLUGIN_STATUS_INVALID_ARGUMENT;
    const frame = record.Frame.fromContext(ctx);
    if (!frame.valid()) return c.MLN_PLUGIN_STATUS_INVALID_ARGUMENT;
    // valid() rejects NaN, so equal frames compare equal.
    const same_frame = if (table.frame) |previous| std.meta.eql(previous, frame) else false;
    if (table.consumed or ctx.time_seconds != table.time or !same_frame) startTable(ctx.time_seconds, frame);

    const emitter = record.pack(ctx.properties[0..ctx.property_count], frame) catch return c.MLN_PLUGIN_STATUS_INVALID_ARGUMENT;
    if (!emitter.visible) return emptyBucket(out);
    if (table.count == max_rows) {
        // The host logs the failure every frame; the debug summary counts it.
        table.rejected += 1;
        return c.MLN_PLUGIN_STATUS_CALLBACK_ERROR;
    }
    const row = table.count;
    pools[row].output(row, emitter.pool, out);
    table.block.rows[@as(usize, row) * row_vec4s ..][0..row_vec4s].* = emitter.row;
    table.pools[row] = emitter.pool;
    table.count += 1;
    return c.MLN_PLUGIN_STATUS_OK;
}

/// Once per drawn layer per frame, after every build_frame of the frame:
/// each layer's LAYER block gets the whole table.
pub fn updateUniformBlock(context: [*c]const c.mln_plugin_uniform_context_v1, uniform_id: u32, output: [*c]u8, output_size: usize) callconv(.c) c.mln_plugin_status {
    if (context == null or output == null or context.*.struct_size < @sizeOf(c.mln_plugin_uniform_context_v1) or
        uniform_id != shaders.emitter_uniform_id or output_size != @sizeOf(properties.TableUBO))
        return c.MLN_PLUGIN_STATUS_INVALID_ARGUMENT;
    // Drawables with no row this frame would read another layer's row.
    if (table.count == 0) {
        debug.print("uniform update with an empty table: CALLBACK_ERROR", .{});
        return c.MLN_PLUGIN_STATUS_CALLBACK_ERROR;
    }
    const ctx = context.*;
    const header = &table.block.header;
    header[@intFromEnum(Header.clock)][2] = @floatFromInt(table.count);
    header[@intFromEnum(Header.screen)] = .{ ctx.pixels_to_gl_units[0], ctx.pixels_to_gl_units[1], @floatFromInt(ctx.viewport_width), @floatFromInt(ctx.viewport_height) };
    header[@intFromEnum(Header.view)][0] = ctx.camera_to_center_distance;
    header[@intFromEnum(Header.view)][1] = ctx.pixel_ratio;
    @memcpy(output[0..output_size], std.mem.asBytes(&table.block));
    if (!table.consumed) debug.frame();
    table.consumed = true;
    return c.MLN_PLUGIN_STATUS_OK;
}

/// Always animating. The host asks only while the layer is evaluated, and
/// a zoom change never re-evaluates a plugin layer, so a layer that stopped
/// while zoomed out of its effect would stay frozen.
pub fn shouldAnimate(_: [*c]const c.mln_plugin_property_value_v1, _: usize) callconv(.c) u8 {
    return 1;
}

// ---------------------------------------------------------------------------
// Vertex bytes.
// ---------------------------------------------------------------------------

/// Segments of one row's pool: its quads (the tint quad plus up to 16384
/// particles) in runs of at most properties.segment_quads.
const max_segments = (record.max_pool + 1 + properties.segment_quads - 1) / properties.segment_quads;

/// Vertices of the largest pool: the tint quad and 16384 particles.
const max_vertices = 4 * (record.max_pool + 1);

/// Every table row's vertex bytes, shared by all render threads:
/// a_particle = (v, row) for the tint quad (vertices 0-3) and then each
/// particle's quad. They depend only on (v, row) and a smaller pool is a
/// prefix of a larger one, so each row is filled once, up to the largest
/// pool any thread has handed out, and never written again: views handed to
/// the host stay valid while another thread extends the row. Zero-fill pages
/// no pool reaches cost no memory, so the process keeps at most 512 KiB per
/// row used, however many render threads come and go.
var row_vertices: [max_rows][max_vertices][2]f32 = @splat(@splat(@splat(0)));
/// How many of each row's vertices are written. Read with acquire, so a
/// thread that sees a count also sees those vertices.
var row_filled: [max_rows]std.atomic.Value(u32) = @splat(.init(0));
/// Held while extending a row. A spin lock: rows grow only when a pool
/// first reaches a power of two, in well under a millisecond.
var row_fill_lock = std.atomic.Value(bool).init(false);

/// The first `vertex_count` vertices of `row`, written if no thread has yet.
fn rowVertices(row: u8, vertex_count: u32) []const [2]f32 {
    const filled = &row_filled[row];
    if (filled.load(.acquire) < vertex_count) {
        while (row_fill_lock.cmpxchgWeak(false, true, .acquire, .monotonic) != null) std.atomic.spinLoopHint();
        defer row_fill_lock.store(false, .release);
        const from = filled.load(.monotonic);
        if (from < vertex_count) {
            for (row_vertices[row][from..vertex_count], from..) |*vertex, v| vertex.* = .{ @floatFromInt(v), @floatFromInt(row) };
            filled.store(vertex_count, .release);
        }
    }
    return row_vertices[row][0..vertex_count];
}

/// One table row's bucket on this thread: the descriptors pointing at a
/// prefix of the row's shared vertices. Every segment indexes the shared
/// quad pattern (properties.quad_indices) from its own vertex offset.
const Pool = struct {
    /// The pool size last handed to the host for this row (0: none yet).
    size: u32 = 0,
    segments: [max_segments]c.mln_plugin_segment_v1 = undefined,
    stream: c.mln_plugin_vertex_stream_v1 = undefined,
    drawable: c.mln_plugin_drawable_descriptor_v1 = undefined,

    /// Points `bucket` (at least bucket_size bytes) at `size` particles of
    /// this row. The views stay valid until the next call for this row on
    /// this thread.
    fn output(pool: *Pool, row: u8, size: u32, bucket: *c.mln_plugin_bucket_v1) void {
        const quads: u32 = size + 1;
        const vertex_count: u32 = 4 * quads;
        const vertices = rowVertices(row, vertex_count);
        if (pool.size != size) {
            debug.print("pool rebuilt N={d}, row={d}", .{ size, row });
            pool.size = size;
        }
        var segment_count: usize = 0;
        var first: u32 = 0;
        while (first < quads) : (first += properties.segment_quads) {
            // Typed, or @min narrows to the comptime bound's u14.
            const length: u32 = @min(properties.segment_quads, quads - first);
            pool.segments[segment_count] = .{ .struct_size = @sizeOf(c.mln_plugin_segment_v1), .vertex_offset = 4 * first, .index_offset = 0, .vertex_length = 4 * length, .index_length = 6 * length };
            segment_count += 1;
        }
        pool.stream = .{ .struct_size = @sizeOf(c.mln_plugin_vertex_stream_v1), .stream_id = 0, .data = @ptrCast(vertices.ptr), .data_size = @as(usize, vertex_count) * @sizeOf([2]f32), .vertex_count = vertex_count, .stride = @sizeOf([2]f32) };
        pool.drawable = .{ .struct_size = @sizeOf(c.mln_plugin_drawable_descriptor_v1), .drawable_key = 1, .shader_id = str(shaders.emitter_shader_id), .attributes = &shaders.emitter_vertex_bindings, .attribute_count = shaders.emitter_vertex_bindings.len, .segments = &pool.segments, .segment_count = segment_count };
        const indexed_quads: u32 = @min(quads, properties.segment_quads);
        properties.clearBucket(bucket);
        bucket.vertex_streams = &pool.stream;
        bucket.vertex_stream_count = 1;
        bucket.indices = &properties.quad_indices;
        bucket.index_count = 6 * @as(usize, indexed_quads);
        bucket.drawables = &pool.drawable;
        bucket.drawable_count = 1;
    }
};

threadlocal var pools: [max_rows]Pool = [_]Pool{.{}} ** max_rows;

// ---------------------------------------------------------------------------
// MLN_PARTICLES_DEBUG
// ---------------------------------------------------------------------------

const debug = struct {
    const variable = "MLN_PARTICLES_DEBUG";
    const unread = 0;
    const off = 1;
    const on = 2;
    var state = std.atomic.Value(u8).init(unread);

    /// Set and neither empty nor "0". Read once; racing first readers store
    /// the same answer.
    fn enabled() bool {
        var s = state.load(.acquire);
        if (s == unread) {
            const value: []const u8 = if (std.c.getenv(variable)) |v| std.mem.sliceTo(v, 0) else "";
            s = if (value.len == 0 or std.mem.eql(u8, value, "0")) off else on;
            state.store(s, .release);
        }
        return s == on;
    }

    fn print(comptime format: []const u8, args: anytype) void {
        if (enabled()) std.debug.print("[particles] " ++ format ++ "\n", args);
    }

    /// The last frame layout logged on this thread.
    threadlocal var logged: struct { count: u8 = 0, rejected: u32 = 0, pools: [max_rows]u32 = @splat(0) } = .{};

    /// Logs the frame's rows when they differ from the last logged frame's.
    fn frame() void {
        if (!enabled()) return;
        const pools_now = table.pools[0..table.count];
        if (logged.count == table.count and logged.rejected == table.rejected and std.mem.eql(u32, logged.pools[0..logged.count], pools_now)) return;
        logged = .{ .count = table.count, .rejected = table.rejected, .pools = table.pools };
        const f = table.frame orelse return;
        const h = table.block.header;
        const eye = h[@intFromEnum(Header.eye)];
        const view = h[@intFromEnum(Header.view)];
        const weights = h[@intFromEnum(Header.weights)];
        std.debug.print("[particles] frame table: {d} rows, pools {any}, {d} rejected; zoom {d:.3}, pitch {d:.2} deg, eye ({d:.1}, {d:.1}) px {d:.1} m, ppm {d:.6}, weights ({d:.3}, {d:.3})\n", .{ table.count, pools_now, table.rejected, f.zoom, std.math.radiansToDegrees(f.pitch), eye[0], eye[1], eye[2], view[2], weights[0], weights[1] });
    }
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

const testing = record.testing;
const Paint = testing.Paint;
const expectEqual = std.testing.expectEqual;
const OK: c.mln_plugin_status = c.MLN_PLUGIN_STATUS_OK;

test {
    _ = record;
}

fn build(paint: *const Paint, frame: record.Frame, time: f64, bucket: *c.mln_plugin_bucket_v1) c.mln_plugin_status {
    const context = testing.context(paint, frame, time);
    bucket.* = std.mem.zeroes(c.mln_plugin_bucket_v1);
    bucket.struct_size = @sizeOf(c.mln_plugin_bucket_v1);
    return buildFrame(&context, bucket);
}

fn uniformContext() c.mln_plugin_uniform_context_v1 {
    var context = std.mem.zeroes(c.mln_plugin_uniform_context_v1);
    context.struct_size = @sizeOf(c.mln_plugin_uniform_context_v1);
    context.pixels_to_gl_units = .{ 2.0 / 800.0, -2.0 / 600.0 };
    context.viewport_width = 800;
    context.viewport_height = 600;
    context.camera_to_center_distance = 779.4229;
    context.pixel_ratio = 2;
    // Source-free drawables get an identity tile matrix.
    context.tile_matrix = .{ 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1 };
    return context;
}

fn update(block: *properties.TableUBO) c.mln_plugin_status {
    const context = uniformContext();
    return updateUniformBlock(&context, shaders.emitter_uniform_id, std.mem.asBytes(block), @sizeOf(properties.TableUBO));
}

/// A fresh thread state, as on a new render thread.
fn resetThread() void {
    table = .{};
}

/// The header an update wrote for a table of `rows` rows at frame `f`: the
/// camera parts record.header gives for `f`, the clock, and the uniform
/// context's screen and view.
fn expectHeader(block: properties.TableUBO, f: record.Frame, rows: f32) !void {
    const expected = record.header(f);
    for (0..properties.header_vec4s) |h| {
        switch (@as(Header, @enumFromInt(h))) {
            .clock => {
                try std.testing.expect(block.header[h][0] >= 0 and block.header[h][0] < clock.wrap_seconds);
                try expectEqual([3]f32{ 4096, rows, 1 }, block.header[h][1..4].*);
            },
            .screen => try expectEqual([4]f32{ 2.0 / 800.0, -2.0 / 600.0, 800, 600 }, block.header[h]),
            .view => try expectEqual([4]f32{ 779.4229, 2, expected[h][2], expected[h][3] }, block.header[h]),
            else => try expectEqual(expected[h], block.header[h]),
        }
    }
}

/// The a_particle row the bucket's vertices carry.
fn bucketRow(bucket: c.mln_plugin_bucket_v1) f32 {
    const vertices: [*]const [2]f32 = @ptrCast(@alignCast(bucket.vertex_streams[0].data));
    return vertices[0][1];
}

/// The geometry the host keeps from a bucket (copyGeometry), compared
/// byte for byte to decide whether to rebuild the layer's drawables.
const Snapshot = struct {
    vertices: []u8,
    indices: []u16,
    segments: []c.mln_plugin_segment_v1,

    fn take(bucket: c.mln_plugin_bucket_v1) !Snapshot {
        const a = std.testing.allocator;
        const stream = bucket.vertex_streams[0];
        const drawable = bucket.drawables[0];
        return .{
            .vertices = try a.dupe(u8, stream.data[0..stream.data_size]),
            .indices = try a.dupe(u16, bucket.indices[0..bucket.index_count]),
            .segments = try a.dupe(c.mln_plugin_segment_v1, drawable.segments[0..drawable.segment_count]),
        };
    }

    fn eql(a: Snapshot, b: Snapshot) bool {
        return std.mem.eql(u8, a.vertices, b.vertices) and std.mem.eql(u16, a.indices, b.indices) and
            std.mem.eql(u8, std.mem.sliceAsBytes(a.segments), std.mem.sliceAsBytes(b.segments));
    }

    fn deinit(s: Snapshot) void {
        const a = std.testing.allocator;
        a.free(s.vertices);
        a.free(s.indices);
        a.free(s.segments);
    }
};

/// MapLibre Native's checks on a frame bucket (plugin_bucket.cpp
/// copyGeometry), plus the emitter's own layout: every drawn bucket has
/// indices (the host silently drops one without), segments start on a
/// quad and address at most 65536 vertices, and the tint quad is first.
fn expectAccepted(bucket: c.mln_plugin_bucket_v1, row: f32, pool: u32) !void {
    try std.testing.expect(bucket.struct_size >= @sizeOf(c.mln_plugin_bucket_v1));
    try std.testing.expect(std.math.isFinite(bucket.query_radius) and bucket.query_radius >= 0);
    try expectEqual(@as(usize, 1), bucket.vertex_stream_count);
    try expectEqual(@as(usize, 1), bucket.drawable_count);
    try expectEqual(@as(usize, 0), bucket.feature_vertex_range_count);
    try std.testing.expect(bucket.index_count > 0 and bucket.indices != null);
    const stream = bucket.vertex_streams[0];
    try std.testing.expect(stream.stride > 0 and stream.vertex_count > 0 and stream.data != null);
    try expectEqual(@as(usize, stream.stride) * stream.vertex_count, stream.data_size);
    try expectEqual(@as(u32, 4 * (pool + 1)), stream.vertex_count);
    const vertices: [*]const [2]f32 = @ptrCast(@alignCast(stream.data));
    for (0..stream.vertex_count) |v| try expectEqual([2]f32{ @floatFromInt(v), row }, vertices[v]);

    const drawable = bucket.drawables[0];
    const shader = shaders.emitter_shaders[0];
    try std.testing.expectEqualStrings(shaders.emitter_shader_id, drawable.shader_id.data[0..drawable.shader_id.size]);
    // The emitter shader has no host-fed binding attributes.
    try expectEqual(shader.attribute_count, drawable.attribute_count);
    for (drawable.attributes[0..drawable.attribute_count]) |binding| {
        try expectEqual(stream.stream_id, binding.stream_id);
        try std.testing.expect(binding.byte_offset + 8 <= stream.stride);
    }
    try std.testing.expect(drawable.segment_count > 0);
    var covered: u32 = 0;
    for (drawable.segments[0..drawable.segment_count]) |segment| {
        try std.testing.expect(segment.index_offset <= bucket.index_count and segment.index_length <= bucket.index_count - segment.index_offset);
        try std.testing.expect(segment.vertex_offset <= stream.vertex_count and segment.vertex_length <= stream.vertex_count - segment.vertex_offset);
        try expectEqual(covered, segment.vertex_offset);
        try expectEqual(@as(u32, 0), segment.vertex_offset % 4);
        try std.testing.expect(segment.vertex_length <= 65532);
        try expectEqual(segment.vertex_length / 4 * 6, segment.index_length);
        for (bucket.indices[segment.index_offset..][0..segment.index_length]) |index| try std.testing.expect(index < segment.vertex_length);
        covered += segment.vertex_length;
    }
    try expectEqual(stream.vertex_count, covered);
}

test "buckets pass the host's geometry checks at every pool size" {
    resetThread();
    const f = testing.frame(.{ .zoom = 14, .center = .{ 37.75, -122.45 }, .pitch = 45 });
    var paint = testing.defaults();
    var bucket: c.mln_plugin_bucket_v1 = undefined;
    for ([_]f32{ 0.5, 64, 600, 16383, 16384, 20000 }) |count| {
        testing.setFloat(&paint, "particle-count", count);
        try expectEqual(OK, build(&paint, f, count, &bucket));
        try expectAccepted(bucket, 0, record.poolSize(count, false));
    }
    // 16384 particles and the tint quad are 16385 quads: a second segment
    // takes the last two.
    try expectEqual(@as(usize, 2), bucket.drawables[0].segment_count);
    try expectEqual(@as(u32, 8), bucket.drawables[0].segments[1].vertex_length);
    try expectEqual(@as(usize, 6 * 16383), bucket.index_count);
    // Weather, on a later row.
    resetThread();
    testing.setEnum(&paint, "emitter-kind", "weather");
    for (0..6) |_| try expectEqual(OK, build(&paint, f, 1, &bucket));
    try expectAccepted(bucket, 5, 16384);
}

const HostBucket = properties.HostBucket;

test "build_frame checks the host's bucket size and writes only inside it" {
    const f = testing.frame(.{ .zoom = 14, .center = .{ 37.75, -122.45 }, .pitch = 45 });
    var paint = testing.defaults();
    testing.setFloat(&paint, "particle-count", 600);
    var hidden = testing.defaults();
    testing.setFloat(&hidden, "particle-count", 0);
    const context = testing.context(&paint, f, 1);
    const hidden_context = testing.context(&hidden, f, 1);
    // A host whose bucket ends before the frame features (a header before
    // them), one that ends right after the drawables, and one with a longer
    // bucket than this plugin knows: each gets the same drawable and nothing
    // past its size, and keeps its struct_size.
    for ([_]u32{ properties.bucketSize("feature_vertex_range_count"), bucket_size, @sizeOf(c.mln_plugin_bucket_v1) + 64 }) |size| {
        resetThread();
        var host = HostBucket.init(size);
        try expectEqual(OK, buildFrame(&context, host.bucket()));
        try host.expectWrittenWithin(size);
        const out = host.bucket().*;
        try expectEqual(@as(usize, 1), out.vertex_stream_count);
        try expectEqual(@as(usize, 1), out.drawable_count);
        try expectEqual(@as(u32, 4 * (record.poolSize(600, false) + 1)), out.vertex_streams[0].vertex_count);
        try std.testing.expect(out.index_count > 0 and out.indices != null);
        // A layer with nothing to draw clears only what fits.
        host = HostBucket.init(size);
        try expectEqual(OK, buildFrame(&hidden_context, host.bucket()));
        try host.expectWrittenWithin(size);
        try expectEqual(@as(usize, 0), host.bucket().drawable_count);
    }
    // One byte short of the drawables: refused, untouched, and no row taken.
    resetThread();
    var short = HostBucket.init(bucket_size - 1);
    try expectEqual(@as(c.mln_plugin_status, c.MLN_PLUGIN_STATUS_INVALID_ARGUMENT), buildFrame(&context, short.bucket()));
    try short.expectUntouchedFrom(bucket_size - 1, @sizeOf(@FieldType(c.mln_plugin_bucket_v1, "struct_size")));
    try expectEqual(@as(u8, 0), table.count);
}

test "two layers share one table per frame, each drawing its own row" {
    resetThread();
    var fire = testing.defaults();
    testing.setEnum(&fire, "emitter-kind", "circle");
    testing.setFloat(&fire, "particle-count", 600);
    testing.setColor(&fire, "particle-color", 1, 0.5, 0, 1);
    var snow = testing.defaults();
    testing.setEnum(&snow, "emitter-kind", "weather");
    testing.setFloat(&snow, "particle-count", 3500);
    var bucket: c.mln_plugin_bucket_v1 = undefined;
    var blocks: [2]properties.TableUBO = undefined;
    for (0..3) |i| {
        const zoom = 14 + 0.25 * @as(f64, @floatFromInt(i));
        const f = testing.frame(.{ .zoom = zoom, .center = .{ 37.75, -122.45 }, .pitch = 30 });
        testing.setPosition(&fire, 37.75, -122.45);
        testing.setPosition(&snow, 37.75, -122.45);
        const time = 100 + 0.016 * @as(f64, @floatFromInt(i));
        try expectEqual(OK, build(&fire, f, time, &bucket));
        try expectEqual(@as(f32, 0), bucketRow(bucket));
        try expectAccepted(bucket, 0, 1024);
        try expectEqual(OK, build(&snow, f, time, &bucket));
        try expectAccepted(bucket, 1, 8192);
        // Each layer's update writes the whole table.
        for (&blocks) |*block| try expectEqual(OK, update(block));
        try expectEqual(blocks[0], blocks[1]);
        const block = blocks[0];
        try expectHeader(block, f, 2);
        try expectEqual((try record.pack(&fire, f)).row, block.rows[0..row_vec4s].*);
        try expectEqual((try record.pack(&snow, f)).row, block.rows[row_vec4s .. 2 * row_vec4s].*);
        for (block.rows[2 * row_vec4s ..]) |vec| try expectEqual([4]f32{ 0, 0, 0, 0 }, vec);
    }
}

test "a hidden layer moves the rows after it, and the rows come back with it" {
    resetThread();
    const f = testing.frame(.{ .zoom = 16, .center = .{ 37.75, -122.45 } });
    var first = testing.defaults();
    var second = testing.defaults();
    testing.setPosition(&first, 37.75, -122.45);
    testing.setPosition(&second, 37.7501, -122.45);
    var bucket: c.mln_plugin_bucket_v1 = undefined;
    var block: properties.TableUBO = undefined;

    try expectEqual(OK, build(&first, f, 1, &bucket));
    try expectEqual(OK, build(&second, f, 1, &bucket));
    const shown = try Snapshot.take(bucket);
    defer shown.deinit();
    try expectEqual(OK, update(&block));
    // The first layer is hidden (no build_frame, no update): the second
    // takes row 0, so its bytes change once.
    try expectEqual(OK, build(&second, f, 2, &bucket));
    try expectEqual(@as(f32, 0), bucketRow(bucket));
    const moved = try Snapshot.take(bucket);
    defer moved.deinit();
    try std.testing.expect(!shown.eql(moved));
    try expectEqual(OK, update(&block));
    try expectEqual(@as(f32, 1), block.header[@intFromEnum(Header.clock)][2]);
    try expectEqual((try record.pack(&second, f)).row, block.rows[0..row_vec4s].*);
    // Shown again: the second layer's bytes are the ones it had before.
    try expectEqual(OK, build(&first, f, 3, &bucket));
    try expectEqual(OK, build(&second, f, 3, &bucket));
    const back = try Snapshot.take(bucket);
    defer back.deinit();
    try std.testing.expect(shown.eql(back));
}

test "a new table on consumed or on a new time, and none in between" {
    resetThread();
    const f = testing.frame(.{ .zoom = 16, .center = .{ 0, 0 } });
    var paint = testing.defaults();
    var bucket: c.mln_plugin_bucket_v1 = undefined;
    var block: properties.TableUBO = undefined;
    // A re-render of the same update (same time) after the table was read.
    try expectEqual(OK, build(&paint, f, 5, &bucket));
    try expectEqual(OK, update(&block));
    try expectEqual(OK, build(&paint, f, 5, &bucket));
    try expectEqual(@as(f32, 0), bucketRow(bucket));
    // A new frame time, although no update read the table.
    try expectEqual(OK, build(&paint, f, 6, &bucket));
    try expectEqual(@as(f32, 0), bucketRow(bucket));
    // The same time and no update: the same frame, so the next row.
    try expectEqual(OK, build(&paint, f, 6, &bucket));
    try expectEqual(@as(f32, 1), bucketRow(bucket));
}

test "two maps on one thread each get their own table" {
    resetThread();
    const near = testing.frame(.{ .zoom = 17, .center = .{ 37.75, -122.45 }, .pitch = 60 });
    const far = testing.frame(.{ .zoom = 3, .center = .{ 0, 0 } });
    var a = testing.defaults();
    var b = testing.defaults();
    testing.setPosition(&a, 37.75, -122.45);
    testing.setPosition(&b, 37.75, -122.45);
    testing.setFloat(&b, "particle-count", 2000);
    var bucket: c.mln_plugin_bucket_v1 = undefined;
    var block: properties.TableUBO = undefined;
    for (0..2) |i| {
        const time = 50 + 0.016 * @as(f64, @floatFromInt(i));
        // Map one: two layers.
        try expectEqual(OK, build(&a, near, time, &bucket));
        try expectEqual(OK, build(&b, near, time, &bucket));
        try expectEqual(@as(f32, 1), bucketRow(bucket));
        try expectEqual(OK, update(&block));
        try expectEqual(OK, update(&block));
        try expectEqual(@as(f32, 2), block.header[@intFromEnum(Header.clock)][2]);
        try expectEqual(record.header(near)[0], block.header[0]);
        // Map two, rendered next on the same thread at its own time.
        try expectEqual(OK, build(&b, far, time + 0.004, &bucket));
        try expectEqual(@as(f32, 0), bucketRow(bucket));
        try expectAccepted(bucket, 0, 4096);
        try expectEqual(OK, update(&block));
        try expectEqual(@as(f32, 1), block.header[@intFromEnum(Header.clock)][2]);
        try expectEqual(record.header(far)[0], block.header[0]);
        try expectEqual((try record.pack(&b, far)).row, block.rows[0..row_vec4s].*);
    }
}

test "still renders share one time_seconds, so a new camera starts a new table" {
    // MapMode::Static and Tile give every render of every map
    // time_point::max (map_impl.cpp onUpdate).
    const still: f64 = 9223372036.854776;
    resetThread();
    const far = testing.frame(.{ .zoom = 3, .center = .{ 0, 0 } });
    const near = testing.frame(.{ .zoom = 16, .center = .{ 37.7749, -122.4194 }, .pitch = 45 });
    var hidden = testing.defaults();
    testing.setFloat(&hidden, "particle-count", 0);
    var shown = testing.defaults();
    testing.setFloat(&shown, "particle-count", 100);
    testing.setPosition(&shown, 37.7749, -122.4194);
    var bucket: c.mln_plugin_bucket_v1 = undefined;
    var block: properties.TableUBO = undefined;

    // A render that draws no row, so no uniform update reads its table;
    // then the next render, of this map or another, at another camera.
    try expectEqual(OK, build(&hidden, far, still, &bucket));
    try expectEqual(@as(usize, 0), bucket.drawable_count);
    try expectEqual(OK, build(&shown, near, still, &bucket));
    try expectEqual(@as(f32, 0), bucketRow(bucket));
    try expectEqual(OK, update(&block));
    try expectHeader(block, near, 1);

    // Two layers of one still render share its table.
    try expectEqual(OK, build(&shown, far, still, &bucket));
    try expectEqual(OK, build(&shown, far, still, &bucket));
    try expectEqual(@as(f32, 1), bucketRow(bucket));
    try expectEqual(OK, update(&block));
    try expectHeader(block, far, 2);

    // A render whose rows no update read (its drawables failed), then
    // another map's render on this thread.
    try expectEqual(OK, build(&shown, near, still, &bucket));
    try expectEqual(OK, build(&shown, far, still, &bucket));
    try expectEqual(@as(f32, 0), bucketRow(bucket));
    try expectEqual(OK, update(&block));
    try expectHeader(block, far, 1);
    try expectEqual((try record.pack(&shown, far)).row, block.rows[0..row_vec4s].*);
}

test "at most 16 visible emitter layers per map" {
    resetThread();
    const f = testing.frame(.{ .zoom = 16, .center = .{ 0, 0 } });
    const paint = testing.defaults();
    var bucket: c.mln_plugin_bucket_v1 = undefined;
    for (0..max_rows) |i| {
        try expectEqual(OK, build(&paint, f, 9, &bucket));
        try expectEqual(@as(f32, @floatFromInt(i)), bucketRow(bucket));
    }
    try expectEqual(@as(c.mln_plugin_status, c.MLN_PLUGIN_STATUS_CALLBACK_ERROR), build(&paint, f, 9, &bucket));
    var block: properties.TableUBO = undefined;
    try expectEqual(OK, update(&block));
    try expectEqual(@as(f32, max_rows), block.header[@intFromEnum(Header.clock)][2]);
    // The next frame starts over.
    try expectEqual(OK, build(&paint, f, 10, &bucket));
    try expectEqual(@as(f32, 0), bucketRow(bucket));
}

test "an invisible layer gets no row and no drawables" {
    resetThread();
    const f = testing.frame(.{ .zoom = 16, .center = .{ 0, 0 } });
    var paint = testing.defaults();
    testing.setFloat(&paint, "particle-count", 0);
    var bucket: c.mln_plugin_bucket_v1 = undefined;
    try expectEqual(OK, build(&paint, f, 1, &bucket));
    try expectEqual(@as(usize, 0), bucket.drawable_count);
    try expectEqual(@as(usize, 0), bucket.vertex_stream_count);
    try expectEqual(@as(usize, 0), bucket.index_count);
    try expectEqual(@as(u8, 0), table.count);
    // Nothing to update: drawables left over from another frame would read
    // someone else's row.
    var block: properties.TableUBO = undefined;
    try expectEqual(@as(c.mln_plugin_status, c.MLN_PLUGIN_STATUS_CALLBACK_ERROR), update(&block));
    // The next visible layer takes row 0.
    testing.setFloat(&paint, "particle-count", 10);
    try expectEqual(OK, build(&paint, f, 1, &bucket));
    try expectEqual(@as(f32, 0), bucketRow(bucket));
}

test "malformed contexts and other uniform blocks are rejected" {
    resetThread();
    const invalid: c.mln_plugin_status = c.MLN_PLUGIN_STATUS_INVALID_ARGUMENT;
    const f = testing.frame(.{ .zoom = 16, .center = .{ 0, 0 } });
    const paint = testing.defaults();
    var bucket: c.mln_plugin_bucket_v1 = undefined;
    try expectEqual(invalid, buildFrame(null, &bucket));
    var context = testing.context(&paint, f, 1);
    try expectEqual(invalid, buildFrame(&context, null));
    context.property_count = 34;
    try expectEqual(invalid, buildFrame(&context, &bucket));
    context = testing.context(&paint, f, 1);
    context.camera_to_center_distance = 0;
    try expectEqual(invalid, buildFrame(&context, &bucket));
    context = testing.context(&paint, f, 1);
    context.proj_matrix[5] = std.math.nan(f64);
    try expectEqual(invalid, buildFrame(&context, &bucket));
    try expectEqual(@as(u8, 0), table.count);

    try expectEqual(OK, build(&paint, f, 1, &bucket));
    var block: properties.TableUBO = undefined;
    const uniform = uniformContext();
    try expectEqual(invalid, updateUniformBlock(&uniform, 1, std.mem.asBytes(&block), @sizeOf(properties.TableUBO)));
    try expectEqual(invalid, updateUniformBlock(&uniform, shaders.emitter_uniform_id, std.mem.asBytes(&block), 272));
    try expectEqual(invalid, updateUniformBlock(null, shaders.emitter_uniform_id, std.mem.asBytes(&block), @sizeOf(properties.TableUBO)));
    try expectEqual(OK, update(&block));
}

test "vertex bytes stay the same while the camera, the paint and the emitter move" {
    resetThread();
    var paint = testing.defaults();
    testing.setEnum(&paint, "emitter-kind", "circle");
    testing.setFloat(&paint, "particle-count", 600);
    testing.setPosition(&paint, 37.75, -122.45);
    var bucket: c.mln_plugin_bucket_v1 = undefined;
    var block: properties.TableUBO = undefined;
    const start = testing.frame(.{ .zoom = 12, .center = .{ 37.75, -122.45 } });
    try expectEqual(OK, build(&paint, start, 0, &bucket));
    try expectEqual(OK, update(&block));
    const first = try Snapshot.take(bucket);
    defer first.deinit();
    const first_row = block.rows[0..row_vec4s].*;

    const cameras = [_]testing.Camera{
        .{ .zoom = 12, .center = .{ 37.76, -122.44 } },
        .{ .zoom = 19, .center = .{ 37.75, -122.45 }, .pitch = 60, .bearing = 45 },
        .{ .zoom = 15.5, .center = .{ 37.7, -122.5 }, .pitch = 30, .bearing = -45 },
    };
    for (cameras, 1..) |camera, i| {
        const t: f32 = @floatFromInt(i);
        // A color mid-transition, a moving emitter and a count the same
        // pool holds.
        testing.setColor(&paint, "particle-color", 1, 1 - 0.2 * t, 0.2 * t, 1);
        testing.setPosition(&paint, 37.75 + 0.001 * t, -122.45);
        testing.setFloat(&paint, "particle-count", 600 + 100 * t);
        try expectEqual(OK, build(&paint, testing.frame(camera), @floatFromInt(i), &bucket));
        try expectEqual(OK, update(&block));
        const next = try Snapshot.take(bucket);
        defer next.deinit();
        try std.testing.expect(first.eql(next));
        try std.testing.expect(!std.meta.eql(first_row, block.rows[0..row_vec4s].*));
    }
    // A count whose ramp needs the next power of two changes them.
    testing.setFloat(&paint, "particle-count", 1025);
    try expectEqual(OK, build(&paint, start, 10, &bucket));
    const bigger = try Snapshot.take(bucket);
    defer bigger.deinit();
    try std.testing.expect(!first.eql(bigger));
    // So does shrinking back, though it reuses the larger array.
    testing.setFloat(&paint, "particle-count", 600);
    try expectEqual(OK, build(&paint, start, 11, &bucket));
    const again = try Snapshot.take(bucket);
    defer again.deinit();
    try std.testing.expect(first.eql(again));
}

/// Forgets every row's vertices, as in a fresh process. Only while no other
/// thread builds frames.
fn resetRows() void {
    for (&row_vertices, &row_filled) |*vertices, *filled| {
        @memset(vertices[0..filled.load(.monotonic)], .{ 0, 0 });
        filled.store(0, .monotonic);
    }
}

/// A render thread that draws two emitter layers, rows 0 and 1.
const Worker = struct {
    counts: [2]f32,
    ok: bool = false,
    data: [2][*c]const u8 = .{ null, null },

    fn run(worker: *Worker, f: record.Frame) void {
        worker.ok = worker.layers(f) catch false;
    }

    fn layers(worker: *Worker, f: record.Frame) !bool {
        var bucket: c.mln_plugin_bucket_v1 = undefined;
        for (worker.counts, 0..) |count, row| {
            var paint = testing.defaults();
            testing.setFloat(&paint, "particle-count", count);
            if (build(&paint, f, 1, &bucket) != OK) return false;
            try expectAccepted(bucket, @floatFromInt(row), record.poolSize(count, false));
            worker.data[row] = bucket.vertex_streams[0].data;
        }
        return true;
    }
};

test "render threads share one copy of each row's vertex bytes" {
    resetRows();
    const f = testing.frame(.{ .zoom = 14, .center = .{ 0, 0 } });
    // Eight new render threads race to fill rows 0 and 1 to different pool
    // sizes; each checks every vertex it was handed.
    var workers: [8]Worker = undefined;
    var threads: [8]std.Thread = undefined;
    for (&workers, &threads, 0..) |*worker, *thread, i| {
        const n: f32 = @floatFromInt(i);
        worker.* = .{ .counts = .{ 32 * @exp2(n), 16384 - 1000 * n } };
        thread.* = try std.Thread.spawn(.{}, Worker.run, .{ worker, f });
    }
    for (threads) |thread| thread.join();
    for (workers) |worker| {
        try std.testing.expect(worker.ok);
        try expectEqual(workers[0].data, worker.data);
    }
    // The rows hold the largest pool handed out, no more, and this thread
    // reads the same bytes.
    try expectEqual(@as(u32, 4 * (8192 + 1)), row_filled[0].load(.monotonic));
    try expectEqual(@as(u32, 4 * (16384 + 1)), row_filled[1].load(.monotonic));
    resetThread();
    var paint = testing.defaults();
    testing.setFloat(&paint, "particle-count", 16384);
    var bucket: c.mln_plugin_bucket_v1 = undefined;
    try expectEqual(OK, build(&paint, f, 1, &bucket));
    try expectAccepted(bucket, 0, 16384);
    try expectEqual(workers[0].data[0], bucket.vertex_streams[0].data);
}
