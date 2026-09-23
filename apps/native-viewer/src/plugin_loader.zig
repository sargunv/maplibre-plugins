//! Loads a plugin shared library and registers it with the host's process-wide
//! register function. The plugin binary never links maplibre-native-c; this is
//! the same contract the FFI's language bindings use.

const std = @import("std");
const c = @import("c.zig").c;
const types = @import("types.zig");

const EntryPoint = *const fn (c.mln_plugin_register_function_v1, [*c]u8, usize) callconv(.c) c.mln_plugin_status;

pub fn load(path: []const u8, entry_point: []const u8) !void {
    var library = std.DynLib.open(path) catch |err| {
        std.debug.print("cannot open plugin library {s}: {s}\n", .{ path, @errorName(err) });
        return types.AppError.PluginLoadFailed;
    };
    // Registration retains the plugin's callbacks for the process lifetime, so
    // the library is never closed.
    var name_buffer: [256]u8 = undefined;
    const name = std.fmt.bufPrintZ(&name_buffer, "{s}", .{entry_point}) catch return types.AppError.PluginLoadFailed;
    const entry = library.lookup(EntryPoint, name) orelse {
        std.debug.print("plugin library {s} has no symbol {s}\n", .{ path, entry_point });
        return types.AppError.PluginLoadFailed;
    };
    var message: [512]u8 = [_]u8{0} ** 512;
    const status = entry(c.mln_plugin_get_register_function_v1(), &message, message.len);
    if (status != c.MLN_PLUGIN_STATUS_OK and status != c.MLN_PLUGIN_STATUS_ALREADY_REGISTERED) {
        std.debug.print("plugin registration failed ({d}): {s}\n", .{ status, std.mem.sliceTo(&message, 0) });
        return types.AppError.PluginLoadFailed;
    }
    std.debug.print("loaded plugin {s} ({s})\n", .{ path, entry_point });
}
