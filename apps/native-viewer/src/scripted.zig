//! Scripted input (`--hover-at`, `--click-at`, `--exit-after`) for runs with
//! no one at the mouse. Each input becomes the SDL events a real one makes, so
//! it takes the same path through input.Controller and the render loop.

const std = @import("std");
const c = @import("c.zig").c;
const types = @import("types.zig");

pub const Script = struct {
    /// Sorted by time.
    inputs: []const types.ScriptedInput,
    exit_after_seconds: ?f64,
    next: usize = 0,
    first_frame: ?std.Io.Timestamp = null,

    /// Starts the script's clock at the first rendered frame.
    pub fn frameRendered(self: *Script, io: std.Io) void {
        if (self.first_frame == null) self.first_frame = std.Io.Clock.awake.now(io);
    }

    /// Queues the events of every input now due; false once the run should end.
    pub fn fire(self: *Script, io: std.Io, window: *c.SDL_Window, viewport: types.Viewport) bool {
        const first_frame = self.first_frame orelse return true;
        const nanoseconds = first_frame.durationTo(std.Io.Clock.awake.now(io)).toNanoseconds();
        const elapsed = @as(f64, @floatFromInt(nanoseconds)) / std.time.ns_per_s;
        while (self.next < self.inputs.len and self.inputs[self.next].seconds <= elapsed) : (self.next += 1) {
            const input = self.inputs[self.next];
            std.debug.print("scripted {s} at ({d:.0}, {d:.0})\n", .{ @tagName(input.kind), input.x, input.y });
            const window_id = c.SDL_GetWindowID(window);
            const x = windowCoordinate(input.x, viewport.window_width, viewport.logical_width);
            const y = windowCoordinate(input.y, viewport.window_height, viewport.logical_height);
            switch (input.kind) {
                .hover => {
                    var event = std.mem.zeroes(c.SDL_Event);
                    event.motion.type = c.SDL_EVENT_MOUSE_MOTION;
                    event.motion.windowID = window_id;
                    event.motion.x = x;
                    event.motion.y = y;
                    push(&event);
                },
                .click => for ([_]bool{ true, false }) |down| {
                    var event = std.mem.zeroes(c.SDL_Event);
                    event.button.type = if (down) c.SDL_EVENT_MOUSE_BUTTON_DOWN else c.SDL_EVENT_MOUSE_BUTTON_UP;
                    event.button.windowID = window_id;
                    event.button.button = c.SDL_BUTTON_LEFT;
                    event.button.down = down;
                    event.button.clicks = 1;
                    event.button.x = x;
                    event.button.y = y;
                    push(&event);
                },
            }
        }
        const exit_after = self.exit_after_seconds orelse return true;
        if (elapsed < exit_after) return true;
        std.debug.print("exiting {d}s after the first frame (--exit-after)\n", .{exit_after});
        return false;
    }
};

/// Parses `<x>,<y>@<seconds>`.
pub fn parseInput(kind: @FieldType(types.ScriptedInput, "kind"), value: []const u8) !types.ScriptedInput {
    const at = std.mem.indexOfScalar(u8, value, '@') orelse return error.InvalidScriptedInput;
    const point = value[0..at];
    const comma = std.mem.indexOfScalar(u8, point, ',') orelse return error.InvalidScriptedInput;
    const seconds = try parseFinite(value[at + 1 ..]);
    if (seconds < 0) return error.InvalidScriptedInput;
    return .{
        .kind = kind,
        .x = try parseFinite(point[0..comma]),
        .y = try parseFinite(point[comma + 1 ..]),
        .seconds = seconds,
    };
}

pub fn parseFinite(text: []const u8) !f64 {
    const value = try std.fmt.parseFloat(f64, text);
    if (!std.math.isFinite(value)) return error.InvalidScriptedInput;
    return value;
}

/// Sorts inputs by time, keeping the command-line order of simultaneous ones.
pub fn sort(inputs: []types.ScriptedInput) void {
    std.sort.insertion(types.ScriptedInput, inputs, {}, struct {
        fn lessThan(_: void, a: types.ScriptedInput, b: types.ScriptedInput) bool {
            return a.seconds < b.seconds;
        }
    }.lessThan);
}

fn push(event: *c.SDL_Event) void {
    if (!c.SDL_PushEvent(event)) std.debug.print("SDL_PushEvent failed: {s}\n", .{std.mem.span(c.SDL_GetError())});
}

/// The inverse of input.logicalPoint: SDL events carry window coordinates.
fn windowCoordinate(value: f64, window_size: u32, logical_size: u32) f32 {
    if (logical_size == 0) return @floatCast(value);
    return @floatCast(value * @as(f64, @floatFromInt(window_size)) / @as(f64, @floatFromInt(logical_size)));
}
