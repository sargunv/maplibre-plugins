//! Hover and click play-once (`--play-once <source>`). The render loop queries
//! the rendered features under the pointer; this picks the feature to restart
//! and remembers the hovered one, so a hover restarts a feature only when the
//! pointer reaches it. The gallery picks the same way, so both restart the same
//! feature.

const std = @import("std");

/// A feature id as the host keys feature state: `text` is the string id, or
/// the number's decimal form.
pub const FeatureId = struct {
    /// Null for a string id.
    number: ?f64,
    text: []const u8,

    pub fn deinit(self: FeatureId, allocator: std.mem.Allocator) void {
        allocator.free(self.text);
    }

    /// Numbers before strings, numbers in numeric order, strings in byte
    /// order; equal numbers fall back to their text.
    pub fn lessThan(self: FeatureId, other: FeatureId) bool {
        if (self.number) |a| {
            const b = other.number orelse return true;
            if (a != b) return a < b;
        } else if (other.number != null) {
            return false;
        }
        return std.mem.order(u8, self.text, other.text) == .lt;
    }
};

/// The `"id"` of a GeoJSON Feature, or null when it has none (or is not a
/// number or string). The caller owns the result.
pub fn parseFeatureId(allocator: std.mem.Allocator, feature_json: []const u8) !?FeatureId {
    var parsed = std.json.parseFromSlice(std.json.Value, allocator, feature_json, .{}) catch |err| switch (err) {
        error.OutOfMemory => return error.OutOfMemory,
        else => return null,
    };
    defer parsed.deinit();
    const object = switch (parsed.value) {
        .object => |o| o,
        else => return null,
    };
    return switch (object.get("id") orelse return null) {
        .integer => |n| .{ .number = @floatFromInt(n), .text = try std.fmt.allocPrint(allocator, "{d}", .{n}) },
        .float => |n| .{ .number = n, .text = try std.fmt.allocPrint(allocator, "{d}", .{n}) },
        // Integers beyond i64 keep their digits.
        .number_string => |s| .{ .number = std.fmt.parseFloat(f64, s) catch return null, .text = try allocator.dupe(u8, s) },
        .string => |s| .{ .number = null, .text = try allocator.dupe(u8, s) },
        else => null,
    };
}

/// The feature to restart among query hits: the smallest id among the hits
/// from `source_id`. Each hit has `source_id: ?[]const u8` and `feature` (a
/// GeoJSON Feature). The caller owns the result.
pub fn pick(allocator: std.mem.Allocator, hits: anytype, source_id: []const u8) !?FeatureId {
    var best: ?FeatureId = null;
    errdefer if (best) |id| id.deinit(allocator);
    for (hits) |hit| {
        const hit_source = hit.source_id orelse continue;
        if (!std.mem.eql(u8, hit_source, source_id)) continue;
        const id = try parseFeatureId(allocator, hit.feature) orelse continue;
        if (best) |current| {
            if (!id.lessThan(current)) {
                id.deinit(allocator);
                continue;
            }
            current.deinit(allocator);
        }
        best = id;
    }
    return best;
}

pub const HoverChange = enum { unchanged, entered, left };

/// The hovered feature, remembered between pointer moves.
pub const Hover = struct {
    allocator: std.mem.Allocator,
    id: ?[]u8 = null,

    pub fn deinit(self: *Hover) void {
        if (self.id) |id| self.allocator.free(id);
        self.id = null;
    }

    /// Remembers the feature now under the pointer. `entered` means a new
    /// feature to restart; `left` means the pointer left every feature.
    pub fn update(self: *Hover, picked: ?[]const u8) !HoverChange {
        if (self.id) |current| {
            if (picked) |next| {
                if (std.mem.eql(u8, current, next)) return .unchanged;
            }
        } else if (picked == null) {
            return .unchanged;
        }
        const next = if (picked) |text| try self.allocator.dupe(u8, text) else null;
        if (self.id) |current| self.allocator.free(current);
        self.id = next;
        return if (next != null) .entered else .left;
    }
};

const TestHit = struct { source_id: ?[]const u8, feature: []const u8 };

test "pick takes the smallest id from the source, numbers before strings" {
    const allocator = std.testing.allocator;
    const hits = [_]TestHit{
        .{ .source_id = "stations", .feature = "{\"type\":\"Feature\",\"id\":\"b\",\"properties\":{}}" },
        .{ .source_id = "other", .feature = "{\"type\":\"Feature\",\"id\":1,\"properties\":{}}" },
        .{ .source_id = "stations", .feature = "{\"type\":\"Feature\",\"id\":12,\"properties\":{}}" },
        .{ .source_id = null, .feature = "{\"type\":\"Feature\",\"id\":0,\"properties\":{}}" },
        .{ .source_id = "stations", .feature = "{\"type\":\"Feature\",\"id\":9,\"properties\":{}}" },
        .{ .source_id = "stations", .feature = "{\"type\":\"Feature\",\"properties\":{}}" },
        .{ .source_id = "stations", .feature = "{\"type\":\"Feature\",\"id\":\"a\",\"properties\":{}}" },
    };
    const id = (try pick(allocator, &hits, "stations")).?;
    defer id.deinit(allocator);
    try std.testing.expectEqualStrings("9", id.text);

    const strings = [_]TestHit{
        .{ .source_id = "stations", .feature = "{\"id\":\"b\"}" },
        .{ .source_id = "stations", .feature = "{\"id\":\"a\"}" },
    };
    const string_id = (try pick(allocator, &strings, "stations")).?;
    defer string_id.deinit(allocator);
    try std.testing.expectEqualStrings("a", string_id.text);

    try std.testing.expectEqual(@as(?FeatureId, null), try pick(allocator, hits[1..2], "stations"));
}

test "feature ids keep the host's text" {
    const allocator = std.testing.allocator;
    const cases = [_]struct { json: []const u8, text: []const u8, number: ?f64 }{
        .{ .json = "{\"id\":240}", .text = "240", .number = 240 },
        .{ .json = "{\"id\":-3}", .text = "-3", .number = -3 },
        .{ .json = "{\"id\":1.5}", .text = "1.5", .number = 1.5 },
        .{ .json = "{\"id\":18446744073709551615}", .text = "18446744073709551615", .number = 18446744073709551615.0 },
        .{ .json = "{\"id\":\"x-1\"}", .text = "x-1", .number = null },
    };
    for (cases) |case| {
        const id = (try parseFeatureId(allocator, case.json)).?;
        defer id.deinit(allocator);
        try std.testing.expectEqualStrings(case.text, id.text);
        try std.testing.expectEqual(case.number, id.number);
    }
    try std.testing.expectEqual(@as(?FeatureId, null), try parseFeatureId(allocator, "{\"id\":null}"));
    try std.testing.expectEqual(@as(?FeatureId, null), try parseFeatureId(allocator, "not json"));
}

test "hover restarts only on reaching a new feature" {
    var hover = Hover{ .allocator = std.testing.allocator };
    defer hover.deinit();
    try std.testing.expectEqual(HoverChange.unchanged, try hover.update(null));
    try std.testing.expectEqual(HoverChange.entered, try hover.update("5"));
    try std.testing.expectEqual(HoverChange.unchanged, try hover.update("5"));
    try std.testing.expectEqual(HoverChange.entered, try hover.update("7"));
    try std.testing.expectEqual(HoverChange.left, try hover.update(null));
    try std.testing.expectEqual(HoverChange.unchanged, try hover.update(null));
    try std.testing.expectEqual(HoverChange.entered, try hover.update("7"));
}
