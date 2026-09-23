const build_options = @import("build_options");

/// The window's native-surface render target for the installed backend. The
/// map renders straight to the window; nothing is composited by the viewer.
pub const RenderTarget = if (build_options.supports_metal)
    @import("metal.zig").MetalRenderTarget
else if (build_options.supports_opengl)
    @import("opengl.zig").OpenGLRenderTarget
else if (build_options.supports_vulkan)
    @import("vulkan.zig").VulkanRenderTarget
else
    @compileError("native-viewer supports Metal, OpenGL, and Vulkan installs");
