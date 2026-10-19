// Offscreen Metal renders of the building layer through the public FFI API,
// for render.py: each case renders a style at a camera to a PNG, then runs
// rendered-feature queries and prints what they hit. macOS only.
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
//   render                         renders the case so far and runs its queries
// Each query prints one line, `query <x> <y> <count> <id>...`, and each
// sample one, `sample <x> <y> <r> <g> <b> <a>`, in job order.
#include <maplibre_native_c.h>
#include <maplibre_native_c/plugin.h>
#include <CoreFoundation/CoreFoundation.h>
#include <CoreGraphics/CoreGraphics.h>
#include <ImageIO/ImageIO.h>
#include <dlfcn.h>
#include <algorithm>
#include <chrono>
#include <cmath>
#include <cstdio>
#include <fstream>
#include <iostream>
#include <sstream>
#include <stdexcept>
#include <string>
#include <thread>
#include <vector>

extern "C" void* MTLCreateSystemDefaultDevice();

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
    double x = 0, y = 0, dy = 0;
};

struct Case {
    std::string style, out;
    double width = 800, height = 600, ratio = 1;
    double lat = 0, lon = 0, zoom = 0, bearing = 0, pitch = 0;
    std::vector<Query> queries;
};

static void renderCase(mln_runtime runtime, void* device, const Case& c) {
    auto options = mln_map_options_default();
    options.width = uint32_t(c.width);
    options.height = uint32_t(c.height);
    options.scale_factor = c.ratio;
    options.map_mode = MLN_MAP_MODE_STATIC;
    mln_map map{};
    check(mln_map_create(runtime, &options, &map), "map create");
    auto descriptor = mln_metal_owned_texture_descriptor_default();
    descriptor.extent.width = uint32_t(c.width);
    descriptor.extent.height = uint32_t(c.height);
    descriptor.extent.scale_factor = c.ratio;
    descriptor.context.device = device;
    mln_render_session session{};
    check(mln_metal_owned_texture_attach(map, &descriptor, &session), "texture attach");
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
    for (const auto& q : c.queries) {
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
        auto geometry = mln_rendered_query_geometry_point(point);
        mln_queried_feature_list list{};
        check(mln_render_session_query_rendered_features(session, &geometry, nullptr, &list), "query");
        size_t count = 0;
        check(mln_queried_feature_list_count(list, &count), "query count");
        std::cout << "query " << point.x << " " << point.y << " " << count;
        for (size_t i = 0; i < count; ++i) {
            auto feature = mln_queried_feature_default();
            check(mln_queried_feature_list_get(list, i, &feature), "query get");
            std::cout << " " << featureId(feature.feature);
        }
        std::cout << std::endl;
        mln_queried_feature_list_destroy(list);
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
    void* device = MTLCreateSystemDefaultDevice();
    if (!device) throw std::runtime_error("Metal device unavailable");
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
        } else if (command == "render") {
            renderCase(runtime, device, current);
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
