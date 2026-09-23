const std = @import("std");

const c = @import("../c.zig").c;
const diagnostics = @import("../diagnostics.zig");
const maplibre = @import("maplibre_native_ffi");
const session = @import("session.zig");
const types = @import("../types.zig");

/// Renders straight into the window's Vulkan surface.
pub const VulkanRenderTarget = struct {
    pub const window_flags = c.SDL_WINDOW_VULKAN;

    allocator: std.mem.Allocator,
    instance: c.VkInstance = null,
    surface: c.VkSurfaceKHR = nullHandle(c.VkSurfaceKHR),
    physical_device: c.VkPhysicalDevice = null,
    device: c.VkDevice = null,
    queue: c.VkQueue = null,
    queue_family_index: u32 = 0,
    session: session.Session = .{},

    pub fn init(allocator: std.mem.Allocator, window: *c.SDL_Window, _: types.Viewport) !VulkanRenderTarget {
        var self = VulkanRenderTarget{ .allocator = allocator };
        errdefer self.deinit();
        try self.createInstance();
        try expectSdl(c.SDL_Vulkan_CreateSurface(window, self.instance, null, &self.surface));
        try self.pickDevice();
        try self.createDevice();
        return self;
    }

    pub fn attach(self: *VulkanRenderTarget, map: *maplibre.MapHandle, viewport: types.Viewport) !void {
        self.session.handle = maplibre.attachVulkanSurface(map, .{
            .extent = session.extent(viewport),
            .context = .{
                .instance = maplibre.NativePointer.fromPtr(@ptrCast(self.instance.?)),
                .physical_device = maplibre.NativePointer.fromPtr(@ptrCast(self.physical_device.?)),
                .device = maplibre.NativePointer.fromPtr(@ptrCast(self.device.?)),
                .graphics_queue = maplibre.NativePointer.fromPtr(@ptrCast(self.queue.?)),
                .graphics_queue_family_index = self.queue_family_index,
                .get_instance_proc_addr = maplibre.NativePointer.fromPtr(@ptrFromInt(@intFromPtr(&c.vkGetInstanceProcAddr))),
                .get_device_proc_addr = maplibre.NativePointer.fromPtr(@ptrFromInt(@intFromPtr(&c.vkGetDeviceProcAddr))),
            },
            .surface = vulkanHandle(self.surface),
        }) catch |err| {
            diagnostics.logError("Vulkan surface attach failed", err, null);
            return types.AppError.SurfaceAttachFailed;
        };
    }

    pub fn deinit(self: *VulkanRenderTarget) void {
        if (self.device != null) _ = c.vkDeviceWaitIdle(self.device);
        self.session.deinit();
        if (self.device != null) c.vkDestroyDevice(self.device, null);
        if (!isNullHandle(self.surface)) c.SDL_Vulkan_DestroySurface(self.instance, self.surface, null);
        if (self.instance != null) c.vkDestroyInstance(self.instance, null);
        self.* = .{ .allocator = self.allocator };
    }

    pub fn resize(self: *VulkanRenderTarget, viewport: types.Viewport) !void {
        try self.session.resize(viewport);
    }

    pub fn finishFrame(_: *VulkanRenderTarget) !void {}

    pub fn renderUpdate(self: *VulkanRenderTarget) !bool {
        return self.session.renderUpdate();
    }

    pub fn sessionHandle(self: *VulkanRenderTarget) !*maplibre.RenderSessionHandle {
        return self.session.surfaceHandle();
    }

    fn createInstance(self: *VulkanRenderTarget) !void {
        var sdl_extension_count: u32 = 0;
        const sdl_extensions = c.SDL_Vulkan_GetInstanceExtensions(&sdl_extension_count);
        if (sdl_extensions == null or sdl_extension_count == 0) return types.AppError.BackendSetupFailed;
        const needs_portability = try self.hasInstanceExtension(c.VK_KHR_PORTABILITY_ENUMERATION_EXTENSION_NAME);

        const extensions = try self.allocator.alloc([*c]const u8, sdl_extension_count + @intFromBool(needs_portability));
        defer self.allocator.free(extensions);
        for (extensions[0..sdl_extension_count], 0..) |*extension, index| extension.* = sdl_extensions[index];
        if (needs_portability) extensions[sdl_extension_count] = c.VK_KHR_PORTABILITY_ENUMERATION_EXTENSION_NAME;

        const app_info = c.VkApplicationInfo{
            .sType = c.VK_STRUCTURE_TYPE_APPLICATION_INFO,
            .pNext = null,
            .pApplicationName = "native-viewer",
            .applicationVersion = 1,
            .pEngineName = "native-viewer",
            .engineVersion = 1,
            .apiVersion = c.VK_API_VERSION_1_0,
        };
        const create_info = c.VkInstanceCreateInfo{
            .sType = c.VK_STRUCTURE_TYPE_INSTANCE_CREATE_INFO,
            .pNext = null,
            .flags = if (needs_portability) c.VK_INSTANCE_CREATE_ENUMERATE_PORTABILITY_BIT_KHR else 0,
            .pApplicationInfo = &app_info,
            .enabledLayerCount = 0,
            .ppEnabledLayerNames = null,
            .enabledExtensionCount = @intCast(extensions.len),
            .ppEnabledExtensionNames = extensions.ptr,
        };
        try expectVk(c.vkCreateInstance(&create_info, null, &self.instance));
    }

    fn hasInstanceExtension(self: *VulkanRenderTarget, name: [*c]const u8) !bool {
        var count: u32 = 0;
        try expectVk(c.vkEnumerateInstanceExtensionProperties(null, &count, null));
        const properties = try self.allocator.alloc(c.VkExtensionProperties, count);
        defer self.allocator.free(properties);
        try expectVk(c.vkEnumerateInstanceExtensionProperties(null, &count, properties.ptr));
        return hasExtension(properties[0..count], std.mem.span(name));
    }

    fn pickDevice(self: *VulkanRenderTarget) !void {
        var count: u32 = 0;
        try expectVk(c.vkEnumeratePhysicalDevices(self.instance, &count, null));
        if (count == 0) return types.AppError.BackendSetupFailed;
        const devices = try self.allocator.alloc(c.VkPhysicalDevice, count);
        defer self.allocator.free(devices);
        try expectVk(c.vkEnumeratePhysicalDevices(self.instance, &count, devices.ptr));
        for (devices) |device| {
            var family_count: u32 = 0;
            c.vkGetPhysicalDeviceQueueFamilyProperties(device, &family_count, null);
            const families = try self.allocator.alloc(c.VkQueueFamilyProperties, family_count);
            defer self.allocator.free(families);
            c.vkGetPhysicalDeviceQueueFamilyProperties(device, &family_count, families.ptr);
            for (families, 0..) |family, index| {
                if ((family.queueFlags & c.VK_QUEUE_GRAPHICS_BIT) == 0) continue;
                if (!c.SDL_Vulkan_GetPresentationSupport(self.instance, device, @intCast(index))) continue;
                self.physical_device = device;
                self.queue_family_index = @intCast(index);
                return;
            }
        }
        return types.AppError.BackendSetupFailed;
    }

    fn hasDeviceExtension(self: *VulkanRenderTarget, name: []const u8) !bool {
        var count: u32 = 0;
        try expectVk(c.vkEnumerateDeviceExtensionProperties(self.physical_device, null, &count, null));
        const properties = try self.allocator.alloc(c.VkExtensionProperties, count);
        defer self.allocator.free(properties);
        try expectVk(c.vkEnumerateDeviceExtensionProperties(self.physical_device, null, &count, properties.ptr));
        return hasExtension(properties[0..count], name);
    }

    fn createDevice(self: *VulkanRenderTarget) !void {
        var priority: f32 = 1.0;
        const queue_info = c.VkDeviceQueueCreateInfo{
            .sType = c.VK_STRUCTURE_TYPE_DEVICE_QUEUE_CREATE_INFO,
            .pNext = null,
            .flags = 0,
            .queueFamilyIndex = self.queue_family_index,
            .queueCount = 1,
            .pQueuePriorities = &priority,
        };
        // A device that exposes the portability subset requires enabling it.
        const extensions = [_][*:0]const u8{ c.VK_KHR_SWAPCHAIN_EXTENSION_NAME, "VK_KHR_portability_subset" };
        const extension_count: u32 = if (try self.hasDeviceExtension("VK_KHR_portability_subset")) 2 else 1;
        var features = std.mem.zeroes(c.VkPhysicalDeviceFeatures);
        c.vkGetPhysicalDeviceFeatures(self.physical_device, &features);
        const create_info = c.VkDeviceCreateInfo{
            .sType = c.VK_STRUCTURE_TYPE_DEVICE_CREATE_INFO,
            .pNext = null,
            .flags = 0,
            .queueCreateInfoCount = 1,
            .pQueueCreateInfos = &queue_info,
            .enabledLayerCount = 0,
            .ppEnabledLayerNames = null,
            .enabledExtensionCount = extension_count,
            .ppEnabledExtensionNames = &extensions,
            .pEnabledFeatures = &features,
        };
        try expectVk(c.vkCreateDevice(self.physical_device, &create_info, null, &self.device));
        c.vkGetDeviceQueue(self.device, self.queue_family_index, 0, &self.queue);
    }
};

fn hasExtension(properties: []const c.VkExtensionProperties, name: []const u8) bool {
    for (properties) |property| {
        if (std.mem.eql(u8, std.mem.span(@as([*:0]const u8, @ptrCast(&property.extensionName))), name)) return true;
    }
    return false;
}

fn nullHandle(comptime Handle: type) Handle {
    return std.mem.zeroes(Handle);
}

fn isNullHandle(handle: anytype) bool {
    return std.meta.eql(handle, nullHandle(@TypeOf(handle)));
}

fn vulkanHandle(handle: anytype) maplibre.VulkanHandle {
    const bits: u64 = switch (@typeInfo(@TypeOf(handle))) {
        .optional => if (handle) |value| @intFromPtr(value) else 0,
        .pointer => @intFromPtr(handle),
        .int => @intCast(handle),
        else => @compileError("unsupported Vulkan handle type"),
    };
    return @enumFromInt(bits);
}

fn expectVk(result: c.VkResult) !void {
    if (result != c.VK_SUCCESS) {
        std.debug.print("Vulkan call failed: {d}\n", .{result});
        return types.AppError.BackendSetupFailed;
    }
}

fn expectSdl(ok: bool) !void {
    if (!ok) {
        std.debug.print("SDL Vulkan call failed: {s}\n", .{std.mem.span(c.SDL_GetError())});
        return types.AppError.BackendSetupFailed;
    }
}
