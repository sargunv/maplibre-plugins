//! Watches the layer JSON file by polling its contents. Any change (or a
//! manual reload) is queued for the runtime loop as apply_layer_json.

const std = @import("std");
const channel = @import("channel.zig");

pub const Watcher = struct {
    allocator: std.mem.Allocator,
    io: std.Io,
    path: []const u8,
    last: ?[]const u8 = null,
    last_check: ?std.Io.Timestamp = null,

    pub fn init(allocator: std.mem.Allocator, io: std.Io, path: []const u8) Watcher {
        return .{ .allocator = allocator, .io = io, .path = path };
    }

    pub fn deinit(self: *Watcher) void {
        if (self.last) |last| self.allocator.free(last);
    }

    /// Reads the file and queues it when it differs from the last read, or
    /// always when `force` is set. Polls at most every 250 ms unless forced.
    pub fn poll(self: *Watcher, commands: *channel.CommandQueue, force: bool) !bool {
        const now = std.Io.Clock.awake.now(self.io);
        if (!force) {
            if (self.last_check) |last| {
                if (last.durationTo(now).toNanoseconds() < 250 * std.time.ns_per_ms) return false;
            }
        }
        self.last_check = now;
        const contents = std.Io.Dir.cwd().readFileAlloc(self.io, self.path, self.allocator, .limited(1 << 20)) catch |err| {
            // Editors often replace files non-atomically; a transient miss is
            // not worth a message, a permanent one is.
            if (self.last == null) std.debug.print("cannot read {s}: {s}\n", .{ self.path, @errorName(err) });
            return false;
        };
        if (!force) {
            if (self.last) |last| {
                if (std.mem.eql(u8, last, contents)) {
                    self.allocator.free(contents);
                    return false;
                }
            }
        }
        if (self.last) |last| self.allocator.free(last);
        self.last = contents;
        commands.push(.{ .apply_layer_json = .{ .json = try commands.allocator.dupe(u8, contents) } });
        return true;
    }
};
