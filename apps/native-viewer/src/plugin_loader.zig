//! Loads a plugin shared library and registers it with the host's process-wide
//! register function. The plugin binary never links maplibre-native-c; this is
//! the same contract the FFI's language bindings use.

const std = @import("std");
const c = @import("c.zig").c;
const types = @import("types.zig");

const EntryPoint = *const fn (c.mln_plugin_register_function_v1, [*c]u8, usize) callconv(.c) c.mln_plugin_status;
const CatalogEntryPoint = *const fn (c.mln_plugin_register_function_v1, [*c]const u8, usize, [*c]u8, usize) callconv(.c) c.mln_plugin_status;

/// A plugin's exported clock (seconds, `double(void)`).
pub const Clock = *const fn () callconv(.c) f64;

/// Catalog bytes for a plugin that takes an app catalog, borrowed for the
/// registration call: the plugin copies what it keeps.
pub const Catalog = struct {
    path: []const u8,
    bytes: []const u8,
    entry_point: []const u8,
};

/// Registers the plugin through `entry_point`, or through the catalog's entry
/// point with its bytes, and returns the clock when `clock_symbol` is set.
pub fn load(path: []const u8, entry_point: []const u8, catalog: ?Catalog, clock_symbol: ?[]const u8) !?Clock {
    var library = std.DynLib.open(path) catch |err| {
        std.debug.print("cannot open plugin library {s}: {s}\n", .{ path, @errorName(err) });
        return types.AppError.PluginLoadFailed;
    };
    // Registration retains the plugin's callbacks for the process lifetime, so
    // the library is never closed; that also keeps the clock pointer valid.
    const clock = if (clock_symbol) |symbol| try lookup(&library, Clock, path, symbol) else null;
    var message: [512]u8 = [_]u8{0} ** 512;
    const register_fn = c.mln_plugin_get_register_function_v1();
    const status = if (catalog) |app_catalog| status: {
        const entry = try lookup(&library, CatalogEntryPoint, path, app_catalog.entry_point);
        break :status entry(register_fn, app_catalog.bytes.ptr, app_catalog.bytes.len, &message, message.len);
    } else status: {
        const entry = try lookup(&library, EntryPoint, path, entry_point);
        break :status entry(register_fn, &message, message.len);
    };
    if (status != c.MLN_PLUGIN_STATUS_OK and status != c.MLN_PLUGIN_STATUS_ALREADY_REGISTERED) {
        std.debug.print("plugin registration failed ({d}): {s}\n", .{ status, std.mem.sliceTo(&message, 0) });
        return types.AppError.PluginLoadFailed;
    }
    if (catalog) |app_catalog| {
        std.debug.print("loaded plugin {s} ({s}) with catalog {s} ({d} bytes)\n", .{ path, app_catalog.entry_point, app_catalog.path, app_catalog.bytes.len });
    } else {
        std.debug.print("loaded plugin {s} ({s})\n", .{ path, entry_point });
    }
    return clock;
}

fn lookup(library: *std.DynLib, comptime T: type, path: []const u8, symbol: []const u8) !T {
    var name_buffer: [256]u8 = undefined;
    const name = std.fmt.bufPrintZ(&name_buffer, "{s}", .{symbol}) catch return types.AppError.PluginLoadFailed;
    return library.lookup(T, name) orelse {
        std.debug.print("plugin library {s} has no symbol {s}\n", .{ path, symbol });
        return types.AppError.PluginLoadFailed;
    };
}
