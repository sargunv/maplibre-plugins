//! The source JSON of a `--geojson` source: the file inlined as `data`, with
//! the GeoJSON source options of `--geojson-options` (a source.json such as
//! `{"type": "geojson", "maxzoom": 15, "buffer": 256}`) when given.

const std = @import("std");

pub const Error = error{ InvalidSourceOptions, OutOfMemory };

/// `{<options>, "data": <data>}`. The options must be a JSON object without
/// `data`, whose `type`, if set, is "geojson"; `type` defaults to it.
pub fn compose(allocator: std.mem.Allocator, data: []const u8, options_json: ?[]const u8) Error![]u8 {
    const text = options_json orelse return std.mem.concat(allocator, u8, &.{ "{\"type\":\"geojson\",\"data\":", data, "}" });
    var parsed = std.json.parseFromSlice(std.json.Value, allocator, text, .{}) catch return Error.InvalidSourceOptions;
    defer parsed.deinit();
    const object = switch (parsed.value) {
        .object => |o| o,
        else => return Error.InvalidSourceOptions,
    };
    if (object.contains("data")) return Error.InvalidSourceOptions;
    if (object.get("type")) |source_type| {
        if (source_type != .string or !std.mem.eql(u8, source_type.string, "geojson")) return Error.InvalidSourceOptions;
    }
    var out: std.Io.Writer.Allocating = .init(allocator);
    defer out.deinit();
    const writer = &out.writer;
    writer.writeAll(if (object.contains("type")) "{" else "{\"type\":\"geojson\",") catch return Error.OutOfMemory;
    var it = object.iterator();
    while (it.next()) |entry| {
        std.json.Stringify.value(entry.key_ptr.*, .{}, writer) catch return Error.OutOfMemory;
        writer.writeByte(':') catch return Error.OutOfMemory;
        std.json.Stringify.value(entry.value_ptr.*, .{}, writer) catch return Error.OutOfMemory;
        writer.writeByte(',') catch return Error.OutOfMemory;
    }
    writer.writeAll("\"data\":") catch return Error.OutOfMemory;
    writer.writeAll(data) catch return Error.OutOfMemory;
    writer.writeByte('}') catch return Error.OutOfMemory;
    return out.toOwnedSlice() catch Error.OutOfMemory;
}

test "without options the data is a bare GeoJSON source" {
    const json = try compose(std.testing.allocator, "{\"type\":\"FeatureCollection\",\"features\":[]}", null);
    defer std.testing.allocator.free(json);
    try std.testing.expectEqualStrings("{\"type\":\"geojson\",\"data\":{\"type\":\"FeatureCollection\",\"features\":[]}}", json);
}

test "source options go in beside the data" {
    const allocator = std.testing.allocator;
    const json = try compose(allocator, "{}", "{ \"type\": \"geojson\", \"maxzoom\": 15, \"buffer\": 256 }\n");
    defer allocator.free(json);
    try std.testing.expectEqualStrings("{\"type\":\"geojson\",\"maxzoom\":15,\"buffer\":256,\"data\":{}}", json);
    const typed = try compose(allocator, "{}", "{\"tolerance\": 0}");
    defer allocator.free(typed);
    try std.testing.expectEqualStrings("{\"type\":\"geojson\",\"tolerance\":0,\"data\":{}}", typed);
}

test "options that are not GeoJSON source options are refused" {
    const allocator = std.testing.allocator;
    try std.testing.expectError(Error.InvalidSourceOptions, compose(allocator, "{}", "[1]"));
    try std.testing.expectError(Error.InvalidSourceOptions, compose(allocator, "{}", "{\"data\": {}}"));
    try std.testing.expectError(Error.InvalidSourceOptions, compose(allocator, "{}", "{\"type\": \"vector\"}"));
    try std.testing.expectError(Error.InvalidSourceOptions, compose(allocator, "{}", "{"));
}
