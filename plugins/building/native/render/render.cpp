// Offscreen renders of the building layer through the public FFI API, for
// render.py: each case renders a style at a camera to a PNG, then runs
// rendered-feature queries and prints what they hit. macOS only. The install's
// render backend picks the session: Metal by default, Vulkan through MoltenVK
// with -DRENDER_VULKAN, OpenGL ES through ANGLE's EGL with -DRENDER_OPENGL.
//
//   render <plugin library> <entry symbol> <job file>
//
// The job file is line based; render.py writes it:
//   style <style.json>
//   size <width> <height> <pixel ratio>
//   camera <lat> <lon> <zoom> <bearing> <pitch>
//   out <file.png>
//   query <x> <y>                  a logical screen pixel
//   query-at <lat> <lon> <dy>      the pixel of a ground point, dy pixels lower
//   sample-at <lat> <lon> <dy>     the premultiplied RGBA8 there, likewise
//   query-grid <step> <r> <g> <b>  queries the center of every step-th pixel;
//                                  a pixel not within 6 of the background
//                                  color r g b is drawn (a building)
//   render                         renders the case so far and runs its queries
// Each query prints one line, `query <x> <y> <count> <id>...`, and each
// sample one, `sample <x> <y> <r> <g> <b> <a>`, and each grid one,
// `grid <points> <drawn> <drawn but not hit> <hit but not drawn>`, in job
// order.
#include <maplibre_native_c.h>
#include <maplibre_native_c/plugin.h>
#include <CoreFoundation/CoreFoundation.h>
#include <CoreGraphics/CoreGraphics.h>
#include <ImageIO/ImageIO.h>
#include <dlfcn.h>
#include <algorithm>
#include <chrono>
#include <cmath>
#include <cstdlib>
#include <cstdio>
#include <fstream>
#include <iostream>
#include <sstream>
#include <stdexcept>
#include <string>
#include <thread>
#include <vector>

#if defined(RENDER_VULKAN)
#include <vulkan/vulkan.h>
#elif defined(RENDER_OPENGL)
#include <EGL/egl.h>
#include <EGL/eglext.h>
#include <EGL/eglext_angle.h>
#else
extern "C" void* MTLCreateSystemDefaultDevice();
#endif

static void check(mln_status status, const char* what) {
    if (status != MLN_STATUS_OK) throw std::runtime_error(std::string(what) + ": FFI status " + std::to_string(status));
}

static uint32_t logRecord(void*, uint32_t severity, uint32_t, int64_t, const char* message) {
    // Warnings and errors: shader compile failures and rejected layers.
    if (severity >= MLN_LOG_SEVERITY_WARNING) std::fprintf(stderr, "[native] %s\n", message);
    return 1;
}

static std::string readFile(const std::string& path) {
    std::ifstream input(path);
    if (!input) throw std::runtime_error("cannot read " + path);
    std::stringstream content;
    content << input.rdbuf();
    return content.str();
}

static void writePng(const std::string& path, const std::vector<uint8_t>& pixels, const mln_texture_image_info& info) {
    CGColorSpaceRef space = CGColorSpaceCreateWithName(kCGColorSpaceSRGB);
    CGDataProviderRef provider = CGDataProviderCreateWithData(nullptr, pixels.data(), size_t(info.stride) * info.height, nullptr);
    CGImageRef image = CGImageCreate(info.width, info.height, 8, 32, info.stride, space,
                                     CGBitmapInfo(kCGImageAlphaPremultipliedLast), provider, nullptr,
                                     false, kCGRenderingIntentDefault);
    CFStringRef string = CFStringCreateWithCString(nullptr, path.c_str(), kCFStringEncodingUTF8);
    CFURLRef url = CFURLCreateWithFileSystemPath(nullptr, string, kCFURLPOSIXPathStyle, false);
    CGImageDestinationRef destination = CGImageDestinationCreateWithURL(url, CFSTR("public.png"), 1, nullptr);
    if (!destination) throw std::runtime_error("cannot write " + path);
    CGImageDestinationAddImage(destination, image, nullptr);
    const bool written = CGImageDestinationFinalize(destination);
    CFRelease(destination);
    CFRelease(url);
    CFRelease(string);
    CGImageRelease(image);
    CGDataProviderRelease(provider);
    CGColorSpaceRelease(space);
    if (!written) throw std::runtime_error("cannot write " + path);
}

// ---------------------------------------------------------------------------
// The graphics context a texture session borrows: one per process, created
// the way the FFI's C API tests create theirs.
// ---------------------------------------------------------------------------

#if defined(RENDER_VULKAN)
static const char* const backendName = "Vulkan";

struct Graphics {
    mln_vulkan_context_descriptor context{};
};

static Graphics createGraphics() {
    VkApplicationInfo app{VK_STRUCTURE_TYPE_APPLICATION_INFO};
    app.pApplicationName = "building-render-test";
    app.apiVersion = VK_API_VERSION_1_1;
    const char* instanceExtensions[] = {VK_KHR_PORTABILITY_ENUMERATION_EXTENSION_NAME};
    VkInstanceCreateInfo instanceInfo{VK_STRUCTURE_TYPE_INSTANCE_CREATE_INFO};
    instanceInfo.pApplicationInfo = &app;
    instanceInfo.flags = VK_INSTANCE_CREATE_ENUMERATE_PORTABILITY_BIT_KHR;
    instanceInfo.enabledExtensionCount = 1;
    instanceInfo.ppEnabledExtensionNames = instanceExtensions;
    VkInstance instance{};
    if (vkCreateInstance(&instanceInfo, nullptr, &instance) != VK_SUCCESS)
        throw std::runtime_error("vkCreateInstance failed (is VK_DRIVER_FILES set to MoltenVK's ICD?)");
    uint32_t count = 0;
    vkEnumeratePhysicalDevices(instance, &count, nullptr);
    std::vector<VkPhysicalDevice> physical(count);
    vkEnumeratePhysicalDevices(instance, &count, physical.data());
    for (auto candidate : physical) {
        uint32_t queueCount = 0;
        vkGetPhysicalDeviceQueueFamilyProperties(candidate, &queueCount, nullptr);
        std::vector<VkQueueFamilyProperties> queues(queueCount);
        vkGetPhysicalDeviceQueueFamilyProperties(candidate, &queueCount, queues.data());
        for (uint32_t family = 0; family < queueCount; ++family) {
            if (!(queues[family].queueFlags & VK_QUEUE_GRAPHICS_BIT)) continue;
            const float priority = 1.0f;
            VkDeviceQueueCreateInfo queueInfo{VK_STRUCTURE_TYPE_DEVICE_QUEUE_CREATE_INFO};
            queueInfo.queueFamilyIndex = family;
            queueInfo.queueCount = 1;
            queueInfo.pQueuePriorities = &priority;
            VkPhysicalDeviceFeatures supported{};
            vkGetPhysicalDeviceFeatures(candidate, &supported);
            VkPhysicalDeviceFeatures features{};
            features.samplerAnisotropy = supported.samplerAnisotropy;
            features.wideLines = supported.wideLines;
            uint32_t extensionCount = 0;
            vkEnumerateDeviceExtensionProperties(candidate, nullptr, &extensionCount, nullptr);
            std::vector<VkExtensionProperties> extensions(extensionCount);
            vkEnumerateDeviceExtensionProperties(candidate, nullptr, &extensionCount, extensions.data());
            const char* portability[] = {"VK_KHR_portability_subset"};
            const bool hasPortability = std::any_of(extensions.begin(), extensions.end(), [&](const VkExtensionProperties& e) {
                return std::string(e.extensionName) == portability[0];
            });
            VkDeviceCreateInfo deviceInfo{VK_STRUCTURE_TYPE_DEVICE_CREATE_INFO};
            deviceInfo.queueCreateInfoCount = 1;
            deviceInfo.pQueueCreateInfos = &queueInfo;
            deviceInfo.enabledExtensionCount = hasPortability ? 1 : 0;
            deviceInfo.ppEnabledExtensionNames = hasPortability ? portability : nullptr;
            deviceInfo.pEnabledFeatures = &features;
            VkDevice device{};
            if (vkCreateDevice(candidate, &deviceInfo, nullptr, &device) != VK_SUCCESS) continue;
            VkQueue queue{};
            vkGetDeviceQueue(device, family, 0, &queue);
            Graphics graphics;
            graphics.context.size = sizeof(graphics.context);
            graphics.context.instance = instance;
            graphics.context.physical_device = candidate;
            graphics.context.device = device;
            graphics.context.graphics_queue = queue;
            graphics.context.graphics_queue_family_index = family;
            graphics.context.get_instance_proc_addr = reinterpret_cast<void*>(&vkGetInstanceProcAddr);
            graphics.context.get_device_proc_addr = reinterpret_cast<void*>(&vkGetDeviceProcAddr);
            return graphics;
        }
    }
    throw std::runtime_error("no Vulkan device with a graphics queue");
}

#elif defined(RENDER_OPENGL)
static const char* const backendName = "OpenGL";

struct Graphics {
    mln_opengl_context_descriptor context{};
};

static Graphics createGraphics() {
    // ANGLE on Metal, headless: a pbuffer keeps the host context current.
    const EGLAttrib attributes[] = {EGL_PLATFORM_ANGLE_TYPE_ANGLE, EGL_PLATFORM_ANGLE_TYPE_METAL_ANGLE,
                                    EGL_PLATFORM_ANGLE_DEVICE_TYPE_ANGLE, EGL_PLATFORM_ANGLE_DEVICE_TYPE_HARDWARE_ANGLE,
                                    EGL_NONE};
    EGLDisplay display = eglGetPlatformDisplay(EGL_PLATFORM_ANGLE_ANGLE, nullptr, attributes);
    if (display == EGL_NO_DISPLAY || !eglInitialize(display, nullptr, nullptr))
        throw std::runtime_error("ANGLE EGL display unavailable");
    if (!eglBindAPI(EGL_OPENGL_ES_API)) throw std::runtime_error("eglBindAPI failed");
    const EGLint configAttributes[] = {EGL_SURFACE_TYPE, EGL_PBUFFER_BIT, EGL_RENDERABLE_TYPE, EGL_OPENGL_ES3_BIT,
                                       EGL_RED_SIZE, 8, EGL_GREEN_SIZE, 8, EGL_BLUE_SIZE, 8, EGL_ALPHA_SIZE, 8,
                                       EGL_DEPTH_SIZE, 24, EGL_STENCIL_SIZE, 8, EGL_NONE};
    EGLConfig config{};
    EGLint configCount = 0;
    if (!eglChooseConfig(display, configAttributes, &config, 1, &configCount) || configCount == 0)
        throw std::runtime_error("no EGL config for OpenGL ES 3 pbuffers");
    const EGLint contextAttributes[] = {EGL_CONTEXT_CLIENT_VERSION, 3, EGL_NONE};
    EGLContext context = eglCreateContext(display, config, EGL_NO_CONTEXT, contextAttributes);
    const EGLint surfaceAttributes[] = {EGL_WIDTH, 8, EGL_HEIGHT, 8, EGL_NONE};
    EGLSurface surface = eglCreatePbufferSurface(display, config, surfaceAttributes);
    if (context == EGL_NO_CONTEXT || surface == EGL_NO_SURFACE || !eglMakeCurrent(display, surface, surface, context))
        throw std::runtime_error("cannot make an EGL context current");
    Graphics graphics;
    graphics.context.size = sizeof(graphics.context);
    graphics.context.platform = MLN_OPENGL_CONTEXT_PLATFORM_EGL;
    graphics.context.ownership = MLN_OPENGL_CONTEXT_OWNERSHIP_SHARED;
    graphics.context.data.egl.size = sizeof(graphics.context.data.egl);
    graphics.context.data.egl.display = display;
    graphics.context.data.egl.config = config;
    graphics.context.data.egl.share_context = context;
    return graphics;
}

#else
static const char* const backendName = "Metal";

struct Graphics {
    void* device = nullptr;
};

static Graphics createGraphics() {
    Graphics graphics;
    graphics.device = MTLCreateSystemDefaultDevice();
    if (!graphics.device) throw std::runtime_error("Metal device unavailable");
    return graphics;
}
#endif

/// The top-level "id" of each queried GeoJSON feature, as text.
static std::string featureId(const mln_buffer_view& feature) {
    const std::string text(reinterpret_cast<const char*>(feature.data), feature.size);
    const auto key = text.find("\"id\":");
    if (key == std::string::npos) return "?";
    auto start = key + 5;
    auto end = text.find_first_of(",}", start);
    return text.substr(start, end - start);
}

struct Query {
    bool geographic = false;
    bool sample = false;
    bool grid = false;
    double x = 0, y = 0, dy = 0;
    int step = 0, background[3] = {0, 0, 0};
};

struct Case {
    std::string style, out;
    double width = 800, height = 600, ratio = 1;
    double lat = 0, lon = 0, zoom = 0, bearing = 0, pitch = 0;
    std::vector<Query> queries;
};

static mln_render_session attach(mln_map map, const Graphics& graphics, const Case& c) {
    mln_render_session session{};
#if defined(RENDER_VULKAN)
    auto descriptor = mln_vulkan_owned_texture_descriptor_default();
    descriptor.context = graphics.context;
#elif defined(RENDER_OPENGL)
    auto descriptor = mln_opengl_owned_texture_descriptor_default();
    descriptor.context = graphics.context;
#else
    auto descriptor = mln_metal_owned_texture_descriptor_default();
    descriptor.context.device = graphics.device;
#endif
    descriptor.extent.width = uint32_t(c.width);
    descriptor.extent.height = uint32_t(c.height);
    descriptor.extent.scale_factor = c.ratio;
#if defined(RENDER_VULKAN)
    check(mln_vulkan_owned_texture_attach(map, &descriptor, &session), "texture attach");
#elif defined(RENDER_OPENGL)
    check(mln_opengl_owned_texture_attach(map, &descriptor, &session), "texture attach");
#else
    check(mln_metal_owned_texture_attach(map, &descriptor, &session), "texture attach");
#endif
    return session;
}

static void renderCase(mln_runtime runtime, const Graphics& graphics, const Case& c) {
    auto options = mln_map_options_default();
    options.width = uint32_t(c.width);
    options.height = uint32_t(c.height);
    options.scale_factor = c.ratio;
    options.map_mode = MLN_MAP_MODE_STATIC;
    mln_map map{};
    check(mln_map_create(runtime, &options, &map), "map create");
    mln_render_session session = attach(map, graphics, c);
    const auto style = readFile(c.style);
    check(mln_map_set_style_json(map, {reinterpret_cast<const uint8_t*>(style.data()), style.size()}), "style");
    auto camera = mln_camera_options_default();
    camera.fields = MLN_CAMERA_OPTION_CENTER | MLN_CAMERA_OPTION_ZOOM | MLN_CAMERA_OPTION_PITCH | MLN_CAMERA_OPTION_BEARING;
    camera.latitude = c.lat;
    camera.longitude = c.lon;
    camera.zoom = c.zoom;
    camera.pitch = c.pitch;
    camera.bearing = c.bearing;
    check(mln_map_jump_to(map, &camera), "camera");
    check(mln_runtime_pump(runtime, 0, 10), "pump");
    check(mln_map_request_still_image(map), "still image");
    bool rendered = false;
    for (int i = 0; i < 3000 && !rendered; ++i) {
        check(mln_runtime_pump(runtime, 0, 10), "pump");
        mln_render_result result;
        bool repaint;
        check(mln_render_session_render_update(session, &result, &repaint), "render");
        rendered = result == MLN_RENDER_RESULT_RENDERED;
        if (!rendered) std::this_thread::sleep_for(std::chrono::milliseconds(2));
    }
    if (!rendered) throw std::runtime_error("render timed out: " + c.out);

    auto info = mln_texture_image_info_default();
    std::vector<uint8_t> pixels(size_t(c.width * c.ratio) * size_t(c.height * c.ratio) * 4);
    check(mln_texture_read_premultiplied_rgba8(session, pixels.data(), pixels.size(), &info), "read pixels");
    writePng(c.out, pixels, info);
    std::cout << "image " << c.out << std::endl;

    mln_map_projection projection{};
    check(mln_map_projection_create(map, &projection), "projection");
    // The ids of the features the rendered-feature query hits at a point.
    const auto query = [&](mln_screen_point point) {
        auto geometry = mln_rendered_query_geometry_point(point);
        mln_queried_feature_list list{};
        check(mln_render_session_query_rendered_features(session, &geometry, nullptr, &list), "query");
        size_t count = 0;
        check(mln_queried_feature_list_count(list, &count), "query count");
        std::vector<std::string> ids;
        for (size_t i = 0; i < count; ++i) {
            auto feature = mln_queried_feature_default();
            check(mln_queried_feature_list_get(list, i, &feature), "query get");
            ids.push_back(featureId(feature.feature));
        }
        mln_queried_feature_list_destroy(list);
        return ids;
    };
    for (const auto& q : c.queries) {
        if (q.grid) {
            size_t points = 0, drawn = 0, missed = 0, extra = 0;
            for (size_t py = size_t(q.step) / 2; py < info.height; py += size_t(q.step)) {
                for (size_t px = size_t(q.step) / 2; px < info.width; px += size_t(q.step)) {
                    const auto* rgba = &pixels[py * info.stride + px * 4];
                    const int distance = std::abs(rgba[0] - q.background[0]) + std::abs(rgba[1] - q.background[1]) +
                                         std::abs(rgba[2] - q.background[2]);
                    const bool isDrawn = distance > 6;
                    const bool isHit = !query({(double(px) + 0.5) / c.ratio, (double(py) + 0.5) / c.ratio}).empty();
                    ++points;
                    drawn += isDrawn;
                    missed += isDrawn && !isHit;
                    extra += isHit && !isDrawn;
                }
            }
            std::cout << "grid " << points << " " << drawn << " " << missed << " " << extra << std::endl;
            continue;
        }
        mln_screen_point point{q.x, q.y};
        if (q.geographic) {
            check(mln_map_projection_pixel_for_lat_lng(projection, {q.x, q.y}, &point), "pixel for lat/lng");
            point.y += q.dy;
        }
        if (q.sample) {
            const auto px = std::min<size_t>(info.width - 1, size_t(std::max(0.0, std::round(point.x * c.ratio))));
            const auto py = std::min<size_t>(info.height - 1, size_t(std::max(0.0, std::round(point.y * c.ratio))));
            const auto* rgba = &pixels[py * info.stride + px * 4];
            std::cout << "sample " << point.x << " " << point.y << " " << int(rgba[0]) << " " << int(rgba[1]) << " "
                      << int(rgba[2]) << " " << int(rgba[3]) << std::endl;
            continue;
        }
        const auto ids = query(point);
        std::cout << "query " << point.x << " " << point.y << " " << ids.size();
        for (const auto& id : ids) std::cout << " " << id;
        std::cout << std::endl;
    }
    check(mln_map_projection_destroy(projection), "projection destroy");
    check(mln_render_session_destroy(session), "session destroy");
    check(mln_map_destroy(map), "map destroy");
}

int main(int argc, char** argv) try {
    if (argc != 4) throw std::runtime_error("usage: render <plugin library> <entry symbol> <job file>");
    check(mln_log_set_callback(logRecord, nullptr), "log callback");
    void* library = dlopen(argv[1], RTLD_NOW);
    if (!library) throw std::runtime_error(dlerror());
    auto entry = reinterpret_cast<mln_plugin_status (*)(mln_plugin_register_function_v1, char*, size_t)>(dlsym(library, argv[2]));
    char error[512]{};
    if (!entry) throw std::runtime_error(std::string("no entry point ") + argv[2]);
    const auto status = entry(mln_plugin_get_register_function_v1(), error, sizeof(error));
    if (status != MLN_PLUGIN_STATUS_OK && status != MLN_PLUGIN_STATUS_ALREADY_REGISTERED)
        throw std::runtime_error(std::string("registration failed: ") + error);
    const Graphics graphics = createGraphics();
    std::cerr << "render backend: " << backendName << std::endl;
    auto runtimeOptions = mln_runtime_options_default();
    mln_runtime runtime{};
    check(mln_runtime_create(&runtimeOptions, &runtime), "runtime");

    std::ifstream job(argv[3]);
    if (!job) throw std::runtime_error(std::string("cannot read ") + argv[3]);
    Case current;
    std::string line;
    while (std::getline(job, line)) {
        std::istringstream words(line);
        std::string command;
        if (!(words >> command)) continue;
        if (command == "style") {
            words >> current.style;
        } else if (command == "size") {
            words >> current.width >> current.height >> current.ratio;
        } else if (command == "camera") {
            words >> current.lat >> current.lon >> current.zoom >> current.bearing >> current.pitch;
        } else if (command == "out") {
            words >> current.out;
        } else if (command == "query") {
            Query q;
            words >> q.x >> q.y;
            current.queries.push_back(q);
        } else if (command == "query-at") {
            Query q;
            q.geographic = true;
            words >> q.x >> q.y >> q.dy;
            current.queries.push_back(q);
        } else if (command == "sample-at") {
            Query q;
            q.geographic = true;
            q.sample = true;
            words >> q.x >> q.y >> q.dy;
            current.queries.push_back(q);
        } else if (command == "query-grid") {
            Query q;
            q.grid = true;
            words >> q.step >> q.background[0] >> q.background[1] >> q.background[2];
            if (q.step <= 0) throw std::runtime_error("query-grid needs a positive step: " + line);
            current.queries.push_back(q);
        } else if (command == "render") {
            renderCase(runtime, graphics, current);
            current.queries.clear();
        } else {
            throw std::runtime_error("unknown job line: " + line);
        }
    }
    check(mln_runtime_destroy(runtime), "runtime destroy");
    // Keep the registered plugin code loaded for the process lifetime.
    return 0;
} catch (const std::exception& e) {
    std::cerr << "render: " << e.what() << std::endl;
    return 1;
}
