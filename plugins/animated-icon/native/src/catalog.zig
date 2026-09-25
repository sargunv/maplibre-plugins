//! Reader for the `.mlvc` vector flipbook catalog, version 2
//! (../../catalog/FORMAT.md). Twin of ../../js/src/catalog.ts: both reject
//! malformed catalogs with the same messages, write the same header block
//! and shader defines, and pick the same frames, checked against the shared
//! fixtures in ../../fixtures/catalog. Needs only std. A Catalog is a
//! validated view of the caller's bytes; parsing allocates only temporaries.

const std = @import("std");
const builtin = @import("builtin");

pub const magic = "MLVCAT\x00\x00";
pub const version: u32 = 2;
pub const max_animations: u32 = 510;
pub const max_ops: u32 = 64;
/// Seconds after which the animation clock wraps to 0.
pub const clock_period: f64 = 4096;
pub const max_bands: u32 = 16;
pub const max_band_entries: u32 = 1024;
pub const max_stops: u32 = 8;
pub const max_texture_size: u32 = 2048;
pub const header_bytes = 64;
pub const record_bytes = 64;
pub const texel_bytes = 16;
/// Integer fields stay below it, where f32 is exact, and float record
/// fields stay at or below it in magnitude.
pub const max_magnitude = 16777216;

const name_pattern = "[a-z0-9][a-z0-9_#-]*";

/// Receives the message of a rejected catalog; the message names the field.
pub const Diagnostic = struct {
    buffer: [256]u8 = undefined,
    len: usize = 0,

    pub fn message(self: *const Diagnostic) []const u8 {
        return self.buffer[0..self.len];
    }
};

pub const ParseError = error{ InvalidCatalog, OutOfMemory };

/// icon-animation-mode.
pub const Mode = enum(u32) { loop = 0, alternate = 1, once = 2 };

/// One animation record; record `i` is enum index `i + 1`.
pub const Animation = struct {
    /// Slices Catalog.bytes.
    name: []const u8,
    /// Anchor box `x0, y0, x1, y1` in canvas pixels (y down).
    box: [4]f32,
    /// Logical pixels of the box's longer side at `icon-size` 1.
    display_px: f32,
    fps: f32,
    frame_count: u32,
    /// Texel of the animation's first frame record.
    frame_texel: u32,
    /// Lottie canvas width and height in canvas pixels.
    canvas: [2]f32,
    /// Loops per second on the playhead: f32(f64(fps) / f64(frame_count)).
    loop_rate: f32,
};

/// A validated catalog: a view of the bytes it was parsed from, which the
/// caller keeps alive and unchanged.
pub const Catalog = struct {
    bytes: []const u8,
    animation_count: u32,
    texture_width: u32,
    texture_height: u32,
    texel_count: u32,
    texels_offset: u32,
    animations_offset: u32,
    names_offset: u32,

    /// Validates `bytes` (FORMAT.md "Validation"). On failure, `diagnostic`
    /// receives a message naming the offending field. `gpa` holds the
    /// visit marks only, freed before returning.
    pub fn parse(gpa: std.mem.Allocator, bytes: []const u8, diagnostic: ?*Diagnostic) ParseError!Catalog {
        return parseCatalog(gpa, bytes, diagnostic);
    }

    /// Entries of the icon-animation enum: `none` plus the animations.
    pub fn entryCount(self: Catalog) u32 {
        return self.animation_count + 1;
    }

    /// Record `record` (enum index `record + 1`).
    pub fn animation(self: Catalog, record: u32) Animation {
        const at = self.bytes[@as(usize, self.animations_offset) + @as(usize, record) * record_bytes ..][0..record_bytes];
        const name_start = @as(usize, self.names_offset) + readU32(at, 32);
        const fps = readF32(at, 20);
        const frame_count = readU32(at, 24);
        return .{
            .name = self.bytes[name_start..][0..readU32(at, 36)],
            .box = .{ readF32(at, 0), readF32(at, 4), readF32(at, 8), readF32(at, 12) },
            .display_px = readF32(at, 16),
            .fps = fps,
            .frame_count = frame_count,
            .frame_texel = readU32(at, 28),
            .canvas = .{ readF32(at, 40), readF32(at, 44) },
            .loop_rate = @floatCast(@as(f64, fps) / @as(f64, @floatFromInt(frame_count))),
        };
    }

    /// The `icon-animation` enum values: "none", then every name in order.
    /// The names point into the catalog bytes; the caller frees the slice.
    pub fn enumValues(self: Catalog, allocator: std.mem.Allocator) std.mem.Allocator.Error![]const []const u8 {
        const values = try allocator.alloc([]const u8, self.entryCount());
        values[0] = "none";
        for (0..self.animation_count) |i| values[i + 1] = self.animation(@intCast(i)).name;
        return values;
    }

    /// Bytes of the IconCatalogUBO block: the clock, then 32 per entry.
    pub fn headerBlockSize(self: Catalog) usize {
        return 16 + 32 * @as(usize, self.entryCount());
    }

    /// Writes the IconCatalogUBO block (FORMAT.md "Header block") as native
    /// f32: the clock, then per entry its box and (display_px, loop_rate,
    /// frame_count, frame_texel), with entry 0 (`none`) all zero. A clock
    /// outside [0, 4096), such as 4096 itself, is written as 0.
    pub fn writeHeaderBlock(self: Catalog, clock: f32, out: []u8) void {
        std.debug.assert(out.len == self.headerBlockSize());
        @memset(out, 0);
        writeNative(out, 0, if (clock >= 0 and clock < clock_period) clock else 0);
        for (0..self.animation_count) |i| {
            const a = self.animation(@intCast(i));
            const at = 16 + 32 * (i + 1);
            for (a.box, 0..) |v, k| writeNative(out, at + 4 * k, v);
            writeNative(out, at + 16, a.display_px);
            writeNative(out, at + 20, a.loop_rate);
            writeNative(out, at + 24, @floatFromInt(a.frame_count));
            writeNative(out, at + 28, @floatFromInt(a.frame_texel));
        }
    }

    /// log2 of the texture width: 10 or 11.
    pub fn artShift(self: Catalog) u5 {
        return if (self.texture_width == 2048) 11 else 10;
    }

    /// Bytes of the `u_art` texture: texture_width × texture_height RGBA32F.
    pub fn textureBytes(self: Catalog) usize {
        return @as(usize, self.texture_width) * self.texture_height * texel_bytes;
    }

    /// The texel section, texel_count × 16 bytes of little-endian f32.
    /// It ends the file, so a copy of the file followed by
    /// textureBytes() - texel_count × 16 zero bytes holds the whole texture
    /// data at texels_offset.
    pub fn texelBytes(self: Catalog) []const u8 {
        return self.bytes[self.texels_offset..][0 .. @as(usize, self.texel_count) * texel_bytes];
    }

    /// The defines every shader stage starts with (FORMAT.md "Header
    /// block"); the text matches catalog.ts byte for byte.
    pub fn writeShaderDefines(self: Catalog, writer: *std.Io.Writer) std.Io.Writer.Error!void {
        try writer.print("#define ICON_ENTRY_COUNT {d}\n", .{self.entryCount()});
        try writer.print("#define ICON_ART_SHIFT {d}\n", .{self.artShift()});
        try writer.print("#define ICON_ART_ROWS {d}\n", .{self.texture_height});
    }

    /// The shader defines as an allocated string the caller frees.
    pub fn shaderDefines(self: Catalog, allocator: std.mem.Allocator) std.mem.Allocator.Error![]u8 {
        var out: std.Io.Writer.Allocating = .init(allocator);
        defer out.deinit();
        self.writeShaderDefines(&out.writer) catch return error.OutOfMemory;
        return out.toOwnedSlice();
    }
};

/// The frame an animation shows (FORMAT.md "Timing"), in f32 as the vertex
/// shader computes it, with no fused multiply-add: `clock` on the plugin's
/// wrapped clock, `speed` and `offset` the icon-animation-speed and -offset
/// values. Returns the frame within the entry, 0 when the playhead is not
/// finite.
pub fn frameAt(a: Animation, clock: f32, speed: f32, offset: f32, mode: Mode) u32 {
    // A clamp that lets NaN through, as the GPU may.
    const sp: f32 = if (speed < -4) -4 else if (speed > 4) 4 else speed;
    const s = clock * sp + offset;
    const u = s * a.loop_rate;
    if (!std.math.isFinite(u)) return 0;
    const p: f32 = switch (mode) {
        .alternate => 1 - @abs(1 - 2 * fract(u * 0.5)),
        .once => std.math.clamp(u, 0, 1),
        .loop => fract(u),
    };
    const count: f32 = @floatFromInt(a.frame_count);
    const frame = @floor(p * count);
    if (frame <= 0) return 0;
    return @min(@as(u32, @intFromFloat(frame)), a.frame_count - 1);
}

fn fract(x: f32) f32 {
    return x - @floor(x);
}

/// Wraps seconds onto the animation clock, [0, 4096): t − 4096·floor(t /
/// 4096) in f64; 0 for a non-finite t or when rounding reaches 4096.
pub fn wrapClock(seconds: f64) f64 {
    if (!std.math.isFinite(seconds)) return 0;
    const wrapped = seconds - clock_period * @floor(seconds / clock_period);
    return if (wrapped >= 0 and wrapped < clock_period) wrapped else 0;
}

fn readU32(bytes: []const u8, offset: usize) u32 {
    return std.mem.readInt(u32, bytes[offset..][0..4], .little);
}

fn readF32(bytes: []const u8, offset: usize) f32 {
    return @bitCast(readU32(bytes, offset));
}

fn writeNative(out: []u8, offset: usize, value: f32) void {
    std.mem.writeInt(u32, out[offset..][0..4], @bitCast(value), builtin.cpu.arch.endian());
}

// ---------------------------------------------------------------------------
// Parsing. The checks and their order mirror catalog.ts exactly: the first
// failing check names the error.
// ---------------------------------------------------------------------------

fn fail(diagnostic: ?*Diagnostic, comptime format: []const u8, args: anytype) error{InvalidCatalog} {
    if (diagnostic) |d| {
        const text = std.fmt.bufPrint(&d.buffer, format, args) catch &d.buffer;
        d.len = text.len;
    }
    return error.InvalidCatalog;
}

/// An integer field: finite, whole, in [0, 2^24).
fn isInteger(value: f32) bool {
    return value >= 0 and value < @as(f32, max_magnitude) and @floor(value) == value;
}

fn isPositive(value: f32) bool {
    return value > 0 and value <= @as(f32, max_magnitude);
}

fn isUnit(value: f32) bool {
    return value >= 0 and value <= 1;
}

fn isFinite4(v: [4]f32) bool {
    for (v) |x| if (!std.math.isFinite(x)) return false;
    return true;
}

fn isUnit4(v: [4]f32) bool {
    for (v) |x| if (!isUnit(x)) return false;
    return true;
}

fn isNameByte(byte: u8, first: bool) bool {
    const lower = byte >= 'a' and byte <= 'z';
    const digit = byte >= '0' and byte <= '9';
    if (first) return lower or digit;
    return lower or digit or byte == '_' or byte == '#' or byte == '-';
}

fn parseCatalog(gpa: std.mem.Allocator, bytes: []const u8, diagnostic: ?*Diagnostic) ParseError!Catalog {
    const size: u64 = bytes.len;
    if (size < header_bytes) return fail(diagnostic, "header: the file is {d} bytes, shorter than the {d}-byte header", .{ size, header_bytes });
    if (!std.mem.eql(u8, bytes[0..magic.len], magic)) return fail(diagnostic, "magic: not an .mlvc catalog", .{});
    const file_version = readU32(bytes, 8);
    if (file_version == 1) return fail(diagnostic, "unsupported catalog version 1; rebake it with the M1 baker", .{});
    if (file_version != version) return fail(diagnostic, "unsupported catalog version {d}", .{file_version});
    const flags = readU32(bytes, 28);
    if (flags != 0) return fail(diagnostic, "flags: got {d}, expected 0", .{flags});
    const animation_count = readU32(bytes, 12);
    if (animation_count > max_animations) return fail(diagnostic, "animation_count: got {d}, expected at most {d}", .{ animation_count, max_animations });
    const width = readU32(bytes, 16);
    if (width != 1024 and width != 2048) return fail(diagnostic, "texture_width: got {d}, expected 1024 or 2048", .{width});
    const height = readU32(bytes, 20);
    const texel_count = readU32(bytes, 24);
    const capacity = @as(u64, width) * max_texture_size;
    if (texel_count > capacity)
        return fail(diagnostic, "texel_count: got {d}, more than the {d} texels of a {d}-wide texture with {d} rows", .{ texel_count, capacity, width, max_texture_size });
    const rows = @max(1, std.math.divCeil(u32, texel_count, width) catch unreachable);
    if (height != rows) return fail(diagnostic, "texture_height: got {d}, expected {d} for {d} texels {d} wide", .{ height, rows, texel_count, width });
    const animations_offset = try section(bytes, diagnostic, "animations_offset", 32);
    const names_offset = try section(bytes, diagnostic, "names_offset", 36);
    const names_size = readU32(bytes, 40);
    const texels_offset = try section(bytes, diagnostic, "texels_offset", 44);
    if (@as(u64, animations_offset) + @as(u64, animation_count) * record_bytes > texels_offset)
        return fail(diagnostic, "animation_count: {d} records of {d} bytes at {d} run past the texel section at {d}", .{ animation_count, record_bytes, animations_offset, texels_offset });
    if (@as(u64, names_offset) + names_size > texels_offset)
        return fail(diagnostic, "names_size: {d} bytes at {d} run past the texel section at {d}", .{ names_size, names_offset, texels_offset });
    const texels_end = @as(u64, texels_offset) + @as(u64, texel_count) * texel_bytes;
    if (texels_end != size)
        return fail(diagnostic, "texel_count: {d} texels of {d} bytes at {d} end at byte {d}, but the file has {d} bytes", .{ texel_count, texel_bytes, texels_offset, texels_end, size });

    const catalog: Catalog = .{
        .bytes = bytes,
        .animation_count = animation_count,
        .texture_width = width,
        .texture_height = height,
        .texel_count = texel_count,
        .texels_offset = texels_offset,
        .animations_offset = animations_offset,
        .names_offset = names_offset,
    };

    for (0..animation_count) |i| {
        const record = bytes[@as(usize, animations_offset) + i * record_bytes ..][0..record_bytes];
        const name_offset: u64 = readU32(record, 32);
        const name_length: u64 = readU32(record, 36);
        if (name_offset + name_length > names_size)
            return fail(diagnostic, "animation {d}: name: bytes {d}..{d} run past the {d}-byte names section", .{ i, name_offset, name_offset + name_length, names_size });
        if (name_length == 0) return fail(diagnostic, "animation {d}: name: empty", .{i});
        const name = bytes[@intCast(names_offset + name_offset)..][0..@intCast(name_length)];
        for (name, 0..) |byte, k| {
            if (!isNameByte(byte, k == 0)) return fail(diagnostic, "animation {d}: name: must match " ++ name_pattern, .{i});
        }
        if (std.mem.eql(u8, name, "none")) return fail(diagnostic, "animation {d}: name: \"none\" is reserved", .{i});
        for (0..i) |j| {
            if (std.mem.eql(u8, catalog.animation(@intCast(j)).name, name)) return fail(diagnostic, "animation {d}: name: repeats animation {d}", .{ i, j });
        }

        const box = [4]f32{ readF32(record, 0), readF32(record, 4), readF32(record, 8), readF32(record, 12) };
        var within = true;
        for (box) |v| within = within and @abs(v) <= @as(f32, max_magnitude);
        if (!(within and box[0] < box[2] and box[1] < box[3]))
            return fail(diagnostic, "animation {d} \"{s}\": box: expected finite x0 < x1 and y0 < y1, each at most {d} in magnitude", .{ i, name, max_magnitude });
        if (!isPositive(readF32(record, 16))) return fail(diagnostic, "animation {d} \"{s}\": display_px: expected a finite number in (0, {d}]", .{ i, name, max_magnitude });
        if (!isPositive(readF32(record, 20))) return fail(diagnostic, "animation {d} \"{s}\": fps: expected a finite number in (0, {d}]", .{ i, name, max_magnitude });
        const frame_count = readU32(record, 24);
        if (frame_count < 1 or frame_count >= max_magnitude)
            return fail(diagnostic, "animation {d} \"{s}\": frame_count: got {d}, expected 1 to {d}", .{ i, name, frame_count, max_magnitude - 1 });
        const frame_texel: u64 = readU32(record, 28);
        if (frame_texel + frame_count > texel_count)
            return fail(diagnostic, "animation {d} \"{s}\": frame_texel: frames at texels {d}..{d} run past the {d} texels", .{ i, name, frame_texel, frame_texel + frame_count, texel_count });
        if (!(isPositive(readF32(record, 40)) and isPositive(readF32(record, 44))))
            return fail(diagnostic, "animation {d} \"{s}\": canvas: expected finite sizes in (0, {d}]", .{ i, name, max_magnitude });
    }

    const marks = try gpa.alloc(u8, texel_count);
    defer gpa.free(marks);
    @memset(marks, 0);
    var validator: Validator = .{ .catalog = catalog, .marks = marks, .diagnostic = diagnostic };
    try validator.run();
    return catalog;
}

/// Checks a header field that holds a section offset.
fn section(bytes: []const u8, diagnostic: ?*Diagnostic, comptime field: []const u8, at: usize) error{InvalidCatalog}!u32 {
    const value = readU32(bytes, at);
    if (value % 16 != 0) return fail(diagnostic, field ++ ": got {d}, expected a multiple of 16", .{value});
    if (value < header_bytes) return fail(diagnostic, field ++ ": got {d}, which points into the header", .{value});
    return value;
}

// Bits of the per-texel visit marks: each frame record, op and shape is
// validated once however many records name it. A gradient's mark is the
// largest stop count it was validated for (those checks cover every
// smaller count too).
const frame_done: u8 = 1;
const op_done: u8 = 2;
const shape_done: u8 = 4;
const stops_shift = 4;

/// The location prefix of a message: `animation i "name": frame f: op k`.
const Where = struct {
    record: usize,
    name: []const u8,
    frame: usize,
    op: ?usize = null,

    pub fn format(self: Where, writer: *std.Io.Writer) std.Io.Writer.Error!void {
        try writer.print("animation {d} \"{s}\": frame {d}", .{ self.record, self.name, self.frame });
        if (self.op) |k| try writer.print(": op {d}", .{k});
    }
};

/// Checks every texel record reachable from the animations, depth first:
/// frame records, their ops, each op's paint and shape. After this, no
/// valid catalog makes the shader read past the texel section.
const Validator = struct {
    catalog: Catalog,
    marks: []u8,
    diagnostic: ?*Diagnostic,

    fn texel(self: Validator, index: u64) [4]f32 {
        const at = self.catalog.bytes[self.catalog.texels_offset + @as(usize, @intCast(index)) * texel_bytes ..];
        return .{ readF32(at, 0), readF32(at, 4), readF32(at, 8), readF32(at, 12) };
    }

    fn isIndex(self: Validator, v: f32) bool {
        return isInteger(v) and v < @as(f32, @floatFromInt(self.catalog.texel_count));
    }

    fn isCurve(self: Validator, v: f32) bool {
        return isInteger(v) and @as(u64, @intFromFloat(v)) + 1 < self.catalog.texel_count;
    }

    fn run(self: *Validator) error{InvalidCatalog}!void {
        const count = self.catalog.texel_count;
        for (0..self.catalog.animation_count) |i| {
            const a = self.catalog.animation(@intCast(i));
            for (0..a.frame_count) |f| {
                const frame_index = @as(usize, a.frame_texel) + f;
                if (self.marks[frame_index] & frame_done != 0) continue;
                self.marks[frame_index] |= frame_done;
                var where: Where = .{ .record = i, .name = a.name, .frame = f };
                const frame = self.texel(frame_index);
                if (!(isInteger(frame[0]) and frame[0] <= @as(f32, max_ops)))
                    return fail(self.diagnostic, "{f}: op_count: expected an integer from 0 to {d}", .{ where, max_ops });
                if (!isInteger(frame[1])) return fail(self.diagnostic, "{f}: op_texel: expected an integer", .{where});
                const op_count: u64 = @intFromFloat(frame[0]);
                const op_texel: u64 = @intFromFloat(frame[1]);
                if (op_texel + 4 * op_count > count)
                    return fail(self.diagnostic, "{f}: op_texel: ops at texels {d}..{d} run past the {d} texels", .{ where, op_texel, op_texel + 4 * op_count, count });
                for (0..@intCast(op_count)) |k| {
                    const o: usize = @intCast(op_texel + 4 * k);
                    if (self.marks[o] & op_done != 0) continue;
                    self.marks[o] |= op_done;
                    where.op = k;
                    try self.op(where, o);
                }
            }
        }
    }

    fn op(self: *Validator, where: Where, o: usize) error{InvalidCatalog}!void {
        const bbox = self.texel(o);
        if (!(isFinite4(bbox) and bbox[0] <= bbox[2] and bbox[1] <= bbox[3]))
            return fail(self.diagnostic, "{f}: bbox: expected finite x0 <= x1 and y0 <= y1", .{where});
        if (!isFinite4(self.texel(o + 1))) return fail(self.diagnostic, "{f}: linear part: expected finite values", .{where});
        const place = self.texel(o + 2);
        if (!(std.math.isFinite(place[0]) and std.math.isFinite(place[1])))
            return fail(self.diagnostic, "{f}: translation: expected finite values", .{where});
        if (!self.isIndex(place[2])) return fail(self.diagnostic, "{f}: shape: expected a texel index", .{where});
        if (!(isInteger(place[3]) and place[3] < 32))
            return fail(self.diagnostic, "{f}: style: expected an integer made of bits 0 to 4", .{where});
        const style: u32 = @intFromFloat(place[3]);
        const slot = style & 3;
        const kind = (style >> 3) & 3;
        if (slot == 3) return fail(self.diagnostic, "{f}: style: slot 3 is not 0, 1 or 2", .{where});
        if (kind == 3) return fail(self.diagnostic, "{f}: style: paint kind 3 is not 0, 1 or 2", .{where});
        if (kind != 0 and slot != 0) return fail(self.diagnostic, "{f}: style: a gradient paint must use slot 0", .{where});
        const paint = self.texel(o + 3);
        if (kind == 0) {
            if (!isUnit4(paint)) return fail(self.diagnostic, "{f}: color: expected finite premultiplied values in [0, 1]", .{where});
        } else {
            try self.gradient(where, paint);
        }
        const shape: usize = @intFromFloat(place[2]);
        if (self.marks[shape] & shape_done == 0) {
            self.marks[shape] |= shape_done;
            try self.shapeRecord(where, shape);
        }
    }

    fn gradient(self: *Validator, where: Where, paint: [4]f32) error{InvalidCatalog}!void {
        const count = self.catalog.texel_count;
        if (!self.isIndex(paint[0])) return fail(self.diagnostic, "{f}: gradient: expected a texel index", .{where});
        if (!(isInteger(paint[1]) and paint[1] >= 2 and paint[1] <= @as(f32, max_stops)))
            return fail(self.diagnostic, "{f}: gradient: stop_count: expected an integer from 2 to {d}", .{ where, max_stops });
        if (!isUnit(paint[2])) return fail(self.diagnostic, "{f}: gradient: opacity: expected a number in [0, 1]", .{where});
        const g: usize = @intFromFloat(paint[0]);
        const stops: u8 = @intFromFloat(paint[1]);
        if (@as(u64, g) + 3 + stops > count)
            return fail(self.diagnostic, "{f}: gradient: records at texels {d}..{d} run past the {d} texels", .{ where, g, @as(u64, g) + 3 + stops, count });
        if (self.marks[g] >> stops_shift >= stops) return;
        self.marks[g] = (self.marks[g] & 15) | (stops << stops_shift);
        if (!isFinite4(self.texel(g))) return fail(self.diagnostic, "{f}: gradient: endpoints: expected finite values", .{where});
        const offsets = self.texel(g + 1) ++ self.texel(g + 2);
        for (0..stops) |k| {
            if (!isUnit(offsets[k])) return fail(self.diagnostic, "{f}: gradient: offset {d}: expected a number in [0, 1]", .{ where, k });
            if (k > 0 and offsets[k] < offsets[k - 1]) return fail(self.diagnostic, "{f}: gradient: offset {d}: below offset {d}", .{ where, k, k - 1 });
        }
        for (0..stops) |k| {
            if (!isUnit4(self.texel(g + 3 + k))) return fail(self.diagnostic, "{f}: gradient: stop {d}: expected a color in [0, 1]", .{ where, k });
        }
    }

    fn shapeRecord(self: *Validator, where: Where, s: usize) error{InvalidCatalog}!void {
        const count = self.catalog.texel_count;
        const counts = self.texel(s);
        const bands = @as(f32, max_bands);
        if (!(isInteger(counts[0]) and isInteger(counts[1]) and counts[0] >= 1 and counts[0] <= bands and counts[1] >= 1 and counts[1] <= bands))
            return fail(self.diagnostic, "{f}: shape: band counts: expected integers from 1 to {d}", .{ where, max_bands });
        const h: usize = @intFromFloat(counts[0]);
        const v: usize = @intFromFloat(counts[1]);
        if (@as(u64, s) + 2 + h + v > count)
            return fail(self.diagnostic, "{f}: shape: band headers at texels {d}..{d} run past the {d} texels", .{ where, s, @as(u64, s) + 2 + h + v, count });
        if (!isFinite4(self.texel(s + 1))) return fail(self.diagnostic, "{f}: shape: band transform: expected finite values", .{where});
        for (0..h + v) |b| {
            const band: Band = if (b < h) .{ .direction = "horizontal", .index = b } else .{ .direction = "vertical", .index = b - h };
            const header = self.texel(s + 2 + b);
            if (!std.math.isFinite(header[0])) return fail(self.diagnostic, "{f}: shape: {f}: split: expected a finite number", .{ where, band });
            if (!(isInteger(header[1]) and header[1] <= @as(f32, max_band_entries)))
                return fail(self.diagnostic, "{f}: shape: {f}: count: expected an integer from 0 to {d}", .{ where, band, max_band_entries });
            if (!self.isIndex(header[2])) return fail(self.diagnostic, "{f}: shape: {f}: list_texel: expected a texel index", .{ where, band });
            const entries: usize = @intFromFloat(header[1]);
            const list: usize = @intFromFloat(header[2]);
            const list_end = @as(u64, list) + (entries + 1) / 2;
            if (list_end > count)
                return fail(self.diagnostic, "{f}: shape: {f}: list at texels {d}..{d} runs past the {d} texels", .{ where, band, list, list_end, count });
            for (0..entries) |e| {
                const pair = self.texel(list + e / 2);
                const half = (e & 1) * 2;
                if (!self.isCurve(pair[half])) return fail(self.diagnostic, "{f}: shape: {f}: list entry {d} is not a curve index", .{ where, band, e });
                if (!self.isCurve(pair[half + 1]))
                    return fail(self.diagnostic, "{f}: shape: {f}: list entry {d} (negative ray) is not a curve index", .{ where, band, e });
            }
        }
    }
};

const Band = struct {
    direction: []const u8,
    index: usize,

    pub fn format(self: Band, writer: *std.Io.Writer) std.Io.Writer.Error!void {
        try writer.print("{s} band {d}", .{ self.direction, self.index });
    }
};

// ---------------------------------------------------------------------------
// Tests. The shared fixtures come from ../../fixtures/catalog through the
// build; ../../js/src/catalog.test.ts runs the same checks on the JS twin.
// ---------------------------------------------------------------------------

const fixtures = @import("catalog_fixtures");

fn fixture(name: []const u8) []const u8 {
    for (fixtures.names, fixtures.files) |n, file| {
        if (std.mem.eql(u8, n, name)) return file;
    }
    std.debug.panic("missing fixture {s}", .{name});
}

const Manifest = struct {
    valid: []const struct {
        file: []const u8,
        texture: [2]u32,
        texel_count: u32,
        defines: []const u8,
        animations: []const struct {
            name: []const u8,
            box: [4]f32,
            display_px: f32,
            fps: f32,
            frame_count: u32,
            frame_texel: u32,
            canvas: [2]f32,
            loop_rate: f32,
        },
        header_block: []const f64,
    },
    samples: []const struct {
        file: []const u8,
        entry: []const u8,
        clock: f64,
        speed: std.json.Value,
        offset: std.json.Value,
        mode: []const u8,
        frame: u32,
        exact: bool,
    },
    malformed: []const struct { file: []const u8, message: []const u8 },
};

fn parseManifest() !std.json.Parsed(Manifest) {
    return std.json.parseFromSlice(Manifest, std.testing.allocator, fixture("manifest.json"), .{ .ignore_unknown_fields = true });
}

fn parseFixture(name: []const u8) !Catalog {
    var diagnostic: Diagnostic = .{};
    return Catalog.parse(std.testing.allocator, fixture(name), &diagnostic) catch |err| {
        std.debug.print("{s}: {s}\n", .{ name, diagnostic.message() });
        return err;
    };
}

/// A manifest number, which may be the string "NaN", "Infinity" or "-Infinity".
fn jsonNumber(value: std.json.Value) !f32 {
    return switch (value) {
        .integer => |v| @floatFromInt(v),
        .float => |v| @floatCast(v),
        .string => |s| if (std.mem.eql(u8, s, "NaN"))
            std.math.nan(f32)
        else if (std.mem.eql(u8, s, "Infinity"))
            std.math.inf(f32)
        else if (std.mem.eql(u8, s, "-Infinity"))
            -std.math.inf(f32)
        else
            error.UnexpectedNumber,
        else => error.UnexpectedNumber,
    };
}

test "valid fixtures parse into the manifest's model" {
    const manifest = try parseManifest();
    defer manifest.deinit();
    try std.testing.expect(manifest.value.valid.len >= 12);
    for (manifest.value.valid) |valid| {
        errdefer std.debug.print("fixture {s}\n", .{valid.file});
        const catalog = try parseFixture(valid.file);
        try std.testing.expectEqual(valid.texture, [2]u32{ catalog.texture_width, catalog.texture_height });
        try std.testing.expectEqual(valid.texel_count, catalog.texel_count);
        try std.testing.expectEqual(valid.animations.len, catalog.animation_count);
        try std.testing.expectEqual(catalog.textureBytes(), @as(usize, valid.texture[0]) * valid.texture[1] * 16);
        try std.testing.expectEqual(@as(usize, catalog.texel_count) * 16, catalog.texelBytes().len);
        try std.testing.expectEqual(@as(u5, if (valid.texture[0] == 2048) 11 else 10), catalog.artShift());
        const values = try catalog.enumValues(std.testing.allocator);
        defer std.testing.allocator.free(values);
        try std.testing.expectEqualStrings("none", values[0]);
        for (valid.animations, 0..) |expected, i| {
            const a = catalog.animation(@intCast(i));
            try std.testing.expectEqualStrings(expected.name, a.name);
            try std.testing.expectEqualStrings(expected.name, values[i + 1]);
            try std.testing.expectEqual(expected.box, a.box);
            try std.testing.expectEqual(expected.display_px, a.display_px);
            try std.testing.expectEqual(expected.fps, a.fps);
            try std.testing.expectEqual(expected.frame_count, a.frame_count);
            try std.testing.expectEqual(expected.frame_texel, a.frame_texel);
            try std.testing.expectEqual(expected.canvas, a.canvas);
            try std.testing.expectEqual(expected.loop_rate, a.loop_rate);
        }
    }
}

test "shader defines and the header block match the JS twin" {
    const manifest = try parseManifest();
    defer manifest.deinit();
    for (manifest.value.valid) |valid| {
        errdefer std.debug.print("fixture {s}\n", .{valid.file});
        const catalog = try parseFixture(valid.file);
        const defines = try catalog.shaderDefines(std.testing.allocator);
        defer std.testing.allocator.free(defines);
        try std.testing.expectEqualStrings(valid.defines, defines);

        const block = try std.testing.allocator.alloc(u8, catalog.headerBlockSize());
        defer std.testing.allocator.free(block);
        @memset(block, 0xa5);
        catalog.writeHeaderBlock(0, block);
        try std.testing.expectEqual(valid.header_block.len * 4, block.len);
        for (valid.header_block, 0..) |expected, k| {
            const actual: f32 = @bitCast(std.mem.readInt(u32, block[4 * k ..][0..4], builtin.cpu.arch.endian()));
            try std.testing.expectEqual(@as(f32, @floatCast(expected)), actual);
        }
    }
}

test "the header block writes the clock, and 0 for 4096 or out of range" {
    const catalog = try parseFixture("frames.mlvc");
    var block: [16 + 32 * 5]u8 = undefined;
    const clock = struct {
        fn at(bytes: []const u8) f32 {
            return @bitCast(std.mem.readInt(u32, bytes[0..4], builtin.cpu.arch.endian()));
        }
    };
    catalog.writeHeaderBlock(1234.5, &block);
    try std.testing.expectEqual(@as(f32, 1234.5), clock.at(&block));
    catalog.writeHeaderBlock(@floatCast(wrapClock(4095.99999999)), &block);
    try std.testing.expectEqual(@as(f32, 0), clock.at(&block));
    catalog.writeHeaderBlock(4096, &block);
    try std.testing.expectEqual(@as(f32, 0), clock.at(&block));
    catalog.writeHeaderBlock(std.math.nan(f32), &block);
    try std.testing.expectEqual(@as(f32, 0), clock.at(&block));
    catalog.writeHeaderBlock(-1, &block);
    try std.testing.expectEqual(@as(f32, 0), clock.at(&block));
}

test "frameAt picks every sample's frame, non-finite playheads included" {
    const manifest = try parseManifest();
    defer manifest.deinit();
    try std.testing.expect(manifest.value.samples.len >= 40);
    for (manifest.value.samples) |sample| {
        errdefer std.debug.print("sample {s} {s} clock {d}\n", .{ sample.entry, sample.mode, sample.clock });
        const catalog = try parseFixture(sample.file);
        var found: ?Animation = null;
        for (0..catalog.animation_count) |i| {
            const a = catalog.animation(@intCast(i));
            if (std.mem.eql(u8, a.name, sample.entry)) found = a;
        }
        const mode = std.meta.stringToEnum(Mode, sample.mode) orelse return error.UnknownMode;
        const frame = frameAt(found orelse return error.MissingEntry, @floatCast(sample.clock), try jsonNumber(sample.speed), try jsonNumber(sample.offset), mode);
        try std.testing.expectEqual(sample.frame, frame);
    }
}

test "malformed fixtures fail with the shared messages" {
    const manifest = try parseManifest();
    defer manifest.deinit();
    try std.testing.expect(manifest.value.malformed.len >= 35);
    for (manifest.value.malformed) |malformed| {
        errdefer std.debug.print("fixture {s}\n", .{malformed.file});
        var diagnostic: Diagnostic = .{};
        try std.testing.expectError(error.InvalidCatalog, Catalog.parse(std.testing.allocator, fixture(malformed.file), &diagnostic));
        try std.testing.expectEqualStrings(malformed.message, diagnostic.message());
    }
}

test "version 1 catalogs are rejected with the rebake message" {
    var bytes: [64]u8 = @splat(0);
    @memcpy(bytes[0..8], magic);
    std.mem.writeInt(u32, bytes[8..12], 1, .little);
    var diagnostic: Diagnostic = .{};
    try std.testing.expectError(error.InvalidCatalog, Catalog.parse(std.testing.allocator, &bytes, &diagnostic));
    try std.testing.expectEqualStrings("unsupported catalog version 1; rebake it with the M1 baker", diagnostic.message());
}

test "parsing reports running out of memory" {
    var failing: std.testing.FailingAllocator = .init(std.testing.allocator, .{ .fail_index = 0 });
    try std.testing.expectError(error.OutOfMemory, Catalog.parse(failing.allocator(), fixture("square.mlvc"), null));
}

test "frameAt follows the timing rules" {
    const catalog = try parseFixture("frames.mlvc");
    const f7 = catalog.animation(1);
    try std.testing.expectEqualStrings("f7", f7.name);
    try std.testing.expectEqual(@as(f32, @floatCast(10.0 / 7.0)), f7.loop_rate);
    // 0.35 s at 10 fps is frame 3; speed 0 holds the offset's frame.
    try std.testing.expectEqual(@as(u32, 3), frameAt(f7, 0.35, 1, 0, .loop));
    try std.testing.expectEqual(@as(u32, 3), frameAt(f7, 1000, 0, 0.35, .loop));
    // Speeds clamp to ±4, and negative speeds play backwards.
    try std.testing.expectEqual(frameAt(f7, 0.05, 4, 0, .loop), frameAt(f7, 0.05, 100, 0, .loop));
    try std.testing.expectEqual(@as(u32, 6), frameAt(f7, 0.05, -1, 0, .loop));
    // Once holds frame 0 before the start and the last frame after one loop.
    try std.testing.expectEqual(@as(u32, 0), frameAt(f7, 1, 1, -5, .once));
    try std.testing.expectEqual(@as(u32, 6), frameAt(f7, 1, 1, 5, .once));
    // Alternate plays forward, then backward.
    try std.testing.expectEqual(@as(u32, 6), frameAt(f7, 0.65, 1, 0, .alternate));
    try std.testing.expectEqual(@as(u32, 5), frameAt(f7, 0.85, 1, 0, .alternate));
    // Non-finite playheads pick frame 0.
    try std.testing.expectEqual(@as(u32, 0), frameAt(f7, 1, std.math.nan(f32), 0, .loop));
    try std.testing.expectEqual(@as(u32, 0), frameAt(f7, 1, 1, std.math.inf(f32), .once));
    try std.testing.expectEqual(@as(u32, 0), frameAt(f7, 1, 1, -std.math.inf(f32), .alternate));
}

test "wrapClock wraps onto [0, 4096)" {
    try std.testing.expectEqual(@as(f64, 0), wrapClock(0));
    try std.testing.expectEqual(@as(f64, 5), wrapClock(4101));
    try std.testing.expectEqual(@as(f64, 4095), wrapClock(-1));
    try std.testing.expectEqual(@as(f64, 0), wrapClock(-1e-20));
    try std.testing.expectEqual(@as(f64, 0), wrapClock(std.math.nan(f64)));
    try std.testing.expectEqual(@as(f64, 0), wrapClock(std.math.inf(f64)));
    try std.testing.expectEqual(@as(f64, 0), wrapClock(-std.math.inf(f64)));
}
