const maplibre = @import("maplibre_native_ffi");
const diagnostics = @import("../diagnostics.zig");
const types = @import("../types.zig");

/// A native-surface render session, or none before attach and after close.
pub const Session = struct {
    handle: ?maplibre.RenderSessionHandle = null,

    pub fn deinit(self: *Session) void {
        if (self.handle) |*handle| handle.close() catch {};
        self.handle = null;
    }

    pub fn resize(self: *Session, viewport: types.Viewport) !void {
        const handle = &(self.handle orelse return types.AppError.SurfaceResizeFailed);
        handle.resize(extent(viewport)) catch |err| {
            diagnostics.logError("surface resize failed", err, null);
            return types.AppError.SurfaceResizeFailed;
        };
    }

    pub fn renderUpdate(self: *Session) !bool {
        const handle = &(self.handle orelse return false);
        const update = handle.renderUpdate() catch |err| {
            diagnostics.logError("surface render failed", err, null);
            return types.AppError.SurfaceRenderFailed;
        };
        return update.result == .rendered;
    }

    pub fn surfaceHandle(self: *Session) !*maplibre.RenderSessionHandle {
        return if (self.handle) |*handle| handle else types.AppError.SurfaceAttachFailed;
    }
};

pub fn extent(viewport: types.Viewport) maplibre.RenderTargetExtent {
    return .{
        .width = viewport.logical_width,
        .height = viewport.logical_height,
        .scale_factor = viewport.scale_factor,
    };
}
