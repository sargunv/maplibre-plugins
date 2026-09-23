const std = @import("std");
const builtin = @import("builtin");

const c = @import("../c.zig").c;
const diagnostics = @import("../diagnostics.zig");
const maplibre = @import("maplibre_native_ffi");
const session = @import("session.zig");
const types = @import("../types.zig");

const Platform = union(enum) {
    wgl: struct { device_context: *anyopaque },
    egl: struct { display: *anyopaque, config: *anyopaque, surface: *anyopaque },
};

/// Renders straight into the window's EGL (Linux, macOS via ANGLE) or WGL
/// (Windows) surface.
pub const OpenGLRenderTarget = struct {
    pub const window_flags = c.SDL_WINDOW_OPENGL;

    window: *c.SDL_Window,
    context: c.SDL_GLContext,
    platform: Platform,
    session: session.Session = .{},

    pub fn init(_: std.mem.Allocator, window: *c.SDL_Window, _: types.Viewport) !OpenGLRenderTarget {
        const context = c.SDL_GL_CreateContext(window) orelse {
            logSdlError("SDL_GL_CreateContext failed");
            return types.AppError.BackendSetupFailed;
        };
        errdefer _ = c.SDL_GL_DestroyContext(context);
        if (!c.SDL_GL_MakeCurrent(window, context)) {
            logSdlError("SDL_GL_MakeCurrent failed");
            return types.AppError.BackendSetupFailed;
        }
        return .{ .window = window, .context = context, .platform = try platformContext(window) };
    }

    pub fn attach(self: *OpenGLRenderTarget, map: *maplibre.MapHandle, viewport: types.Viewport) !void {
        self.session.handle = maplibre.attachOpenGLSurface(map, .{
            .extent = session.extent(viewport),
            .context = self.descriptor(),
            .surface = self.surface(),
        }) catch |err| {
            diagnostics.logError("OpenGL surface attach failed", err, null);
            return types.AppError.SurfaceAttachFailed;
        };
    }

    pub fn deinit(self: *OpenGLRenderTarget) void {
        self.session.deinit();
        _ = c.SDL_GL_MakeCurrent(self.window, null);
        _ = c.SDL_GL_DestroyContext(self.context);
    }

    /// Follows a resized window. When SDL hands back a different EGL window
    /// surface, the live session takes the replacement.
    pub fn resize(self: *OpenGLRenderTarget, viewport: types.Viewport) !void {
        const previous = self.surface();
        self.platform = platformContext(self.window) catch |err| {
            if (self.session.surfaceHandle()) |handle| handle.detach() catch {} else |_| {}
            diagnostics.logError("OpenGL surface refresh failed", err, null);
            return types.AppError.SurfaceAttachFailed;
        };
        if (std.meta.eql(self.surface(), previous)) {
            try self.session.resize(viewport);
            return;
        }
        const handle = try self.session.surfaceHandle();
        handle.setOpenGLSurfaceTarget(.{
            .extent = session.extent(viewport),
            .context = self.descriptor(),
            .surface = self.surface(),
        }) catch |err| {
            handle.detach() catch {};
            diagnostics.logError("OpenGL surface set target failed", err, null);
            return types.AppError.SurfaceAttachFailed;
        };
    }

    pub fn finishFrame(self: *OpenGLRenderTarget) !void {
        if (!c.SDL_GL_MakeCurrent(self.window, self.context)) {
            logSdlError("SDL_GL_MakeCurrent failed");
            return types.AppError.BackendSetupFailed;
        }
    }

    pub fn renderUpdate(self: *OpenGLRenderTarget) !bool {
        return self.session.renderUpdate();
    }

    pub fn sessionHandle(self: *OpenGLRenderTarget) !*maplibre.RenderSessionHandle {
        return self.session.surfaceHandle();
    }

    fn descriptor(self: *const OpenGLRenderTarget) maplibre.OpenGLContextDescriptor {
        return switch (self.platform) {
            .wgl => |wgl| .{ .wgl = .{
                .device_context = maplibre.NativePointer.fromPtr(@ptrCast(wgl.device_context)),
                .share_context = maplibre.NativePointer.fromPtr(@ptrCast(self.context)),
                .get_proc_address = null,
            } },
            .egl => |egl| .{ .egl = .{
                .display = maplibre.NativePointer.fromPtr(@ptrCast(egl.display)),
                .config = maplibre.NativePointer.fromPtr(@ptrCast(egl.config)),
                .share_context = maplibre.NativePointer.fromPtr(@ptrCast(self.context)),
                .get_proc_address = null,
            } },
        };
    }

    fn surface(self: *const OpenGLRenderTarget) maplibre.NativePointer {
        return switch (self.platform) {
            .wgl => |wgl| maplibre.NativePointer.fromPtr(@ptrCast(wgl.device_context)),
            .egl => |egl| maplibre.NativePointer.fromPtr(@ptrCast(egl.surface)),
        };
    }
};

fn platformContext(window: *c.SDL_Window) !Platform {
    switch (builtin.os.tag) {
        .windows => {
            const properties = c.SDL_GetWindowProperties(window);
            if (properties == 0) {
                logSdlError("SDL_GetWindowProperties failed");
                return types.AppError.BackendSetupFailed;
            }
            const device_context = c.SDL_GetPointerProperty(properties, c.SDL_PROP_WINDOW_WIN32_HDC_POINTER, null) orelse
                return types.AppError.BackendSetupFailed;
            return .{ .wgl = .{ .device_context = device_context } };
        },
        .linux, .macos => {
            const display = c.SDL_EGL_GetCurrentDisplay() orelse {
                logSdlError("SDL_EGL_GetCurrentDisplay failed");
                return types.AppError.BackendSetupFailed;
            };
            const config = c.SDL_EGL_GetCurrentConfig() orelse {
                logSdlError("SDL_EGL_GetCurrentConfig failed");
                return types.AppError.BackendSetupFailed;
            };
            const window_surface = c.SDL_EGL_GetWindowSurface(window) orelse {
                logSdlError("SDL_EGL_GetWindowSurface failed");
                return types.AppError.BackendSetupFailed;
            };
            return .{ .egl = .{ .display = display, .config = config, .surface = window_surface } };
        },
        else => return types.AppError.BackendSetupFailed,
    }
}

fn logSdlError(message: []const u8) void {
    const err = c.SDL_GetError();
    std.debug.print("{s}: {s}\n", .{ message, if (err == null) "" else std.mem.span(err) });
}
