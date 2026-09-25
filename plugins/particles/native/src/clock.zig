//! The plugin clock. The host gives tile-driven layers no timestamp and no
//! layer gets one in its uniform callback, so both particle types animate from
//! a monotonic clock of their own, wrapped every W = 4096 s so it keeps
//! sub-millisecond precision as a float. The particle model is periodic in W,
//! so the wrap is seamless. MLN_PARTICLES_TIME=<seconds> freezes the clock for
//! deterministic frames (tests, screenshots).

const std = @import("std");
const builtin = @import("builtin");

/// The model's period W in seconds (PARTICLE_W in shaders/particle.glsl).
pub const wrap_seconds: f64 = 4096;

pub const override_variable = "MLN_PARTICLES_TIME";

/// Seconds from a monotonic clock. On Windows that is the performance
/// counter, read through ntdll as std.Io does (Zig 0.16's kernel32 bindings
/// no longer declare QueryPerformanceCounter).
pub fn monotonicSeconds() f64 {
    if (builtin.os.tag == .windows) {
        const ntdll = std.os.windows.ntdll;
        var counter: std.os.windows.LARGE_INTEGER = 0;
        var frequency: std.os.windows.LARGE_INTEGER = 0;
        if (!ntdll.RtlQueryPerformanceCounter(&counter).toBool() or
            !ntdll.RtlQueryPerformanceFrequency(&frequency).toBool() or frequency <= 0) return 0;
        return @as(f64, @floatFromInt(counter)) / @as(f64, @floatFromInt(frequency));
    }
    var ts: std.c.timespec = undefined;
    if (std.c.clock_gettime(.MONOTONIC, &ts) != 0) return 0;
    return @as(f64, @floatFromInt(ts.sec)) + @as(f64, @floatFromInt(ts.nsec)) / 1e9;
}

/// Seconds in [0, W).
pub fn wrap(seconds: f64) f64 {
    const wrapped = @mod(seconds, wrap_seconds);
    return if (wrapped < wrap_seconds) wrapped else 0;
}

/// The time every particle layer animates at: MLN_PARTICLES_TIME when set,
/// else the monotonic clock, in [0, W).
pub fn pluginTime() f64 {
    return wrap(override() orelse monotonicSeconds());
}

/// A finite number of seconds, or null (unset, empty or malformed).
pub fn parseOverride(text: []const u8) ?f64 {
    const trimmed = std.mem.trim(u8, text, " \t\r\n");
    if (trimmed.len == 0) return null;
    const seconds = std.fmt.parseFloat(f64, trimmed) catch return null;
    return if (std.math.isFinite(seconds)) seconds else null;
}

// The environment is read once. Two NaN payloads parseOverride never returns
// mark "not read yet" and "not set"; any other bits are the override.
const unread: u64 = 0x7ff8_0000_7ea0_0001;
const unset: u64 = 0x7ff8_0000_7ea0_0002;
var cached = std.atomic.Value(u64).init(unread);

fn override() ?f64 {
    var bits = cached.load(.acquire);
    if (bits == unread) {
        const seconds = if (std.c.getenv(override_variable)) |value| parseOverride(std.mem.sliceTo(value, 0)) else null;
        bits = if (seconds) |s| @bitCast(s) else unset;
        // Racing first readers compute the same value, so either store wins.
        cached.store(bits, .release);
    }
    return if (bits == unset) null else @as(f64, @bitCast(bits));
}

test "the clock wraps into [0, W)" {
    try std.testing.expectEqual(@as(f64, 12.5), wrap(12.5));
    try std.testing.expectEqual(@as(f64, 12.5), wrap(wrap_seconds + 12.5));
    try std.testing.expectEqual(@as(f64, wrap_seconds - 1), wrap(-1));
    try std.testing.expectEqual(@as(f64, 0), wrap(wrap_seconds));
    // The largest double below a multiple of W rounds to W under @mod.
    try std.testing.expect(wrap(-std.math.floatMin(f64)) < wrap_seconds);
    const now = pluginTime();
    try std.testing.expect(now >= 0 and now < wrap_seconds);
    try std.testing.expect(monotonicSeconds() > 0);
}

test "MLN_PARTICLES_TIME parses to finite seconds" {
    try std.testing.expectEqual(@as(?f64, 12.5), parseOverride("12.5"));
    try std.testing.expectEqual(@as(?f64, 5000), parseOverride(" 5000\n"));
    try std.testing.expectEqual(@as(?f64, -3), parseOverride("-3"));
    try std.testing.expectEqual(@as(?f64, null), parseOverride(""));
    try std.testing.expectEqual(@as(?f64, null), parseOverride("soon"));
    try std.testing.expectEqual(@as(?f64, null), parseOverride("nan"));
    try std.testing.expectEqual(@as(?f64, null), parseOverride("inf"));
    // Neither sentinel is a value parseOverride can return.
    try std.testing.expect(std.math.isNan(@as(f64, @bitCast(unread))) and std.math.isNan(@as(f64, @bitCast(unset))));
}
