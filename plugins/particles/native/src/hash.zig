//! The particle model's integer hashes, for CPU-side layout (polygon cell
//! jitter): the Zig twin of particleHash, particleUnit and particleWeyl in
//! shaders/particle.glsl and of js/src/hash.ts. All three are exact, so every
//! implementation agrees bit for bit; ../../fixtures/hash.json holds the
//! shared vectors.

const std = @import("std");
const build_options = @import("build_options");

/// pcg3d (Jarzynski and Olano, JCGT 2020): three well-mixed u32 from three.
pub fn pcg3d(input: [3]u32) [3]u32 {
    var x = input[0] *% 1664525 +% 1013904223;
    var y = input[1] *% 1664525 +% 1013904223;
    var z = input[2] *% 1664525 +% 1013904223;
    x +%= y *% z;
    y +%= z *% x;
    z +%= x *% y;
    x ^= x >> 16;
    y ^= y >> 16;
    z ^= z >> 16;
    x +%= y *% z;
    y +%= z *% x;
    z +%= x *% y;
    return .{ x, y, z };
}

/// The top 24 bits of a hash as a float in [0, 1), exact.
pub fn unit(h: u32) f32 {
    return @as(f32, @floatFromInt(h >> 8)) * (1.0 / 16777216.0);
}

/// The k-th term of the golden-ratio Weyl sequence in [0, 1), exact.
pub fn weyl(k: u32) f32 {
    return unit(k *% 0x9E3779B9);
}

test "pcg3d, unit and weyl match independent reference values" {
    // Computed with arbitrary-precision integers masked to 32 bits.
    const cases = [_]struct { in: [3]u32, out: [3]u32 }{
        .{ .in = .{ 0, 0, 0 }, .out = .{ 0x9bafd7c6, 0xa8e88a6b, 0x3f15482c } },
        .{ .in = .{ 1, 2, 3 }, .out = .{ 0xfa9f79a6, 0x48f2f44c, 0x596f5ab1 } },
        .{ .in = .{ 7, 42, 0x5EED }, .out = .{ 0x9b546d80, 0x4c0239b7, 0x113c3c2a } },
        .{ .in = .{ 0xffffffff, 0xffffffff, 0xffffffff }, .out = .{ 0xa5f48f40, 0xa4533e83, 0x515b8a62 } },
        .{ .in = .{ 123456789, 987654321, 0x6A09 }, .out = .{ 0xfa7013b4, 0xa8d51883, 0xcc38cc31 } },
    };
    for (cases) |case| try std.testing.expectEqual(case.out, pcg3d(case.in));
    try std.testing.expectEqual(@as(f32, 0), unit(0xff));
    try std.testing.expectEqual(@as(f32, 0.5), unit(0x80000000));
    try std.testing.expectEqual(@as(f32, 1.0 - 1.0 / 16777216.0), unit(0xffffffff));
    try std.testing.expectEqual(@as(f32, 0), weyl(0));
    try std.testing.expectEqual(unit(0x9e3779b9), weyl(1));
    try std.testing.expectEqual(unit(0x61c88647), weyl(0xffffffff));
}

fn jsonU32(value: std.json.Value) !u32 {
    return switch (value) {
        .integer => |i| std.math.cast(u32, i) orelse error.OutOfRange,
        else => error.NotAnInteger,
    };
}

fn jsonF32(value: std.json.Value) !f32 {
    return switch (value) {
        .integer => |i| @floatFromInt(i),
        .float => |f| @floatCast(f),
        else => error.NotANumber,
    };
}

test "hashes match the shared fixture" {
    var parsed = try std.json.parseFromSlice(std.json.Value, std.testing.allocator, build_options.fixture_hash, .{});
    defer parsed.deinit();
    const fixture = parsed.value.object;
    // {"cases": [{"input": [a, b, c], "hash": [x, y, z], "unit": [ux, uy, uz]}],
    //  "weyl": [{"k": k, "value": w}]}
    const cases = fixture.get("cases").?.array.items;
    try std.testing.expect(cases.len > 0);
    for (cases) |case| {
        const in = case.object.get("input").?.array.items;
        const actual = pcg3d(.{ try jsonU32(in[0]), try jsonU32(in[1]), try jsonU32(in[2]) });
        for (case.object.get("hash").?.array.items, actual) |expected, a| try std.testing.expectEqual(try jsonU32(expected), a);
        for (case.object.get("unit").?.array.items, actual) |expected, a| try std.testing.expectEqual(try jsonF32(expected), unit(a));
    }
    const terms = fixture.get("weyl").?.array.items;
    try std.testing.expect(terms.len > 0);
    for (terms) |term| try std.testing.expectEqual(try jsonF32(term.object.get("value").?), weyl(try jsonU32(term.object.get("k").?)));
}
