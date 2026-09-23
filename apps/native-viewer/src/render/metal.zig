const std = @import("std");
const objc = @import("objc");

const c = @import("../c.zig").c;
const diagnostics = @import("../diagnostics.zig");
const maplibre = @import("maplibre_native_ffi");
const session = @import("session.zig");
const types = @import("../types.zig");

extern "c" fn MTLCreateSystemDefaultDevice() objc.c.id;

const MTLPixelFormatBGRA8Unorm: u64 = 80;
const CGSize = extern struct { width: f64, height: f64 };

/// Renders straight into the window's CAMetalLayer.
pub const MetalRenderTarget = struct {
    pub const window_flags = c.SDL_WINDOW_METAL;

    view: c.SDL_MetalView,
    device: objc.Object,
    layer: objc.Object,
    session: session.Session = .{},

    pub fn init(_: std.mem.Allocator, window: *c.SDL_Window, viewport: types.Viewport) !MetalRenderTarget {
        const view = c.SDL_Metal_CreateView(window);
        if (view == null) return types.AppError.BackendSetupFailed;
        errdefer c.SDL_Metal_DestroyView(view);

        const device_id = MTLCreateSystemDefaultDevice();
        if (device_id == null) return types.AppError.BackendSetupFailed;
        const device = objc.Object.fromId(device_id);
        errdefer device.release();

        const layer_ptr = c.SDL_Metal_GetLayer(view) orelse return types.AppError.BackendSetupFailed;
        const layer = objc.Object.fromId(layer_ptr);
        layer.setProperty("device", device);
        layer.setProperty("pixelFormat", @as(u64, MTLPixelFormatBGRA8Unorm));
        layer.setProperty("drawableSize", drawableSize(viewport));
        return .{ .view = view, .device = device, .layer = layer };
    }

    /// Attaches the render session on this thread, which becomes its owner
    /// thread for the session's whole life.
    pub fn attach(self: *MetalRenderTarget, map: *maplibre.MapHandle, viewport: types.Viewport) !void {
        self.session.handle = maplibre.attachMetalSurface(map, .{
            .extent = session.extent(viewport),
            .context = .{ .device = maplibre.NativePointer.fromPtr(self.device.value.?) },
            .layer = maplibre.NativePointer.fromPtr(self.layer.value.?),
        }) catch |err| {
            diagnostics.logError("Metal surface attach failed", err, null);
            return types.AppError.SurfaceAttachFailed;
        };
    }

    pub fn deinit(self: *MetalRenderTarget) void {
        self.session.deinit();
        self.device.release();
        c.SDL_Metal_DestroyView(self.view);
    }

    pub fn resize(self: *MetalRenderTarget, viewport: types.Viewport) !void {
        self.layer.setProperty("drawableSize", drawableSize(viewport));
        try self.session.resize(viewport);
    }

    pub fn finishFrame(_: *MetalRenderTarget) !void {}

    pub fn renderUpdate(self: *MetalRenderTarget) !bool {
        return self.session.renderUpdate();
    }

    pub fn sessionHandle(self: *MetalRenderTarget) !*maplibre.RenderSessionHandle {
        return self.session.surfaceHandle();
    }
};

fn drawableSize(viewport: types.Viewport) CGSize {
    return .{ .width = @floatFromInt(viewport.physical_width), .height = @floatFromInt(viewport.physical_height) };
}
