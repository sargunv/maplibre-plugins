//! The layout table of ../../spec.json as Zig types, the twin of the
//! layout half of ../../js/src/spec.ts. The test below fails when the two
//! drift. The paint table's parity test comes with plugin.zig, which
//! registers the properties with the host.

const std = @import("std");

pub const layer_type = "building";

/// Tile-local coordinate range the layout works in, matching MapLibre Native.
pub const extent: u32 = 8192;

/// StreetComplete's roof:shape values, in its quest's order.
pub const RoofShape = enum {
    flat,
    gabled,
    hipped,
    @"half-hipped",
    pyramidal,
    skillion,
    gambrel,
    round,
    double_saltbox,
    saltbox,
    mansard,
    dome,
    quadruple_saltbox,
    round_gabled,
    onion,
    cone,
    many,
};

pub const RoofOrientation = enum { along, across };

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

const build_options = @import("build_options");

fn expectEnumValues(comptime E: type, property: std.json.ObjectMap, default: []const u8) !void {
    const values = property.get("values").?.array.items;
    const fields = @typeInfo(E).@"enum".fields;
    try std.testing.expectEqual(fields.len, values.len);
    inline for (fields, 0..) |field, i| try std.testing.expectEqualStrings(field.name, values[i].string);
    try std.testing.expectEqualStrings("enum", property.get("type").?.string);
    try std.testing.expectEqualStrings(default, property.get("default").?.string);
}

fn expectLayoutOnly(property: std.json.ObjectMap) !void {
    try std.testing.expectEqualStrings("data-driven", property.get("expressions").?.string);
    try std.testing.expectEqual(false, property.get("featureState").?.bool);
    try std.testing.expectEqual(false, property.get("transition").?.bool);
}

test "the layout table matches spec.json" {
    var parsed = try std.json.parseFromSlice(std.json.Value, std.testing.allocator, build_options.spec_json, .{});
    defer parsed.deinit();
    const spec = parsed.value.object;
    try std.testing.expectEqualStrings(layer_type, spec.get("layerType").?.string);
    const layout = spec.get("layout").?.object;
    try std.testing.expectEqual(3, layout.count());

    const shape = layout.get("building-roof-shape").?.object;
    try expectEnumValues(RoofShape, shape, "flat");
    try expectLayoutOnly(shape);

    const orientation = layout.get("building-roof-orientation").?.object;
    try expectEnumValues(RoofOrientation, orientation, "along");
    try expectLayoutOnly(orientation);

    const direction = layout.get("building-roof-direction").?.object;
    try std.testing.expectEqualStrings("float", direction.get("type").?.string);
    try std.testing.expectEqual(-1, direction.get("default").?.integer);
    try std.testing.expectEqual(-1, direction.get("minimum").?.integer);
    try std.testing.expectEqual(360, direction.get("maximum").?.integer);
    try expectLayoutOnly(direction);
}
