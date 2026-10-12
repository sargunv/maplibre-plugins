// Optional real-host regression: render the fixture cameras to a Metal texture
// and check pixels and rendered-feature queries through the public FFI API.
#include <maplibre_native_c.h>
#include <maplibre_native_c/plugin.h>
#include <rapidjson/document.h>
#include <rapidjson/ostreamwrapper.h>
#include <rapidjson/writer.h>
#include <dlfcn.h>
#include <cmath>
#include <fstream>
#include <iostream>
#include <sstream>
#include <stdexcept>
#include <thread>
#include <vector>
extern "C" void* MTLCreateSystemDefaultDevice();
static void check(mln_status status) {
    if (status != MLN_STATUS_OK) throw std::runtime_error("FFI status " + std::to_string(status));
}
static size_t query(mln_render_session session, double x, double y) {
    mln_rendered_query_geometry geometry{};
    geometry.size = sizeof(geometry);
    geometry.type = MLN_RENDERED_QUERY_GEOMETRY_TYPE_POINT;
    geometry.data.point = {x, y};
    mln_queried_feature_list list{};
    check(mln_render_session_query_rendered_features(session, &geometry, nullptr, &list));
    size_t count; check(mln_queried_feature_list_count(list, &count));
    mln_queried_feature_list_destroy(list);
    return count;
}
int main(int argc, char** argv) {
    if (argc != 3) throw std::runtime_error("pass plugin library and geographic.json");
    void* library = dlopen(argv[1], RTLD_NOW);
    if (!library) throw std::runtime_error(dlerror());
    auto entry = reinterpret_cast<mln_plugin_status (*)(mln_plugin_register_function_v1, char*, size_t)>(dlsym(library, "mln_location_puck_register"));
    char error[512]{};
    if (!entry || entry(mln_plugin_get_register_function_v1(), error, sizeof(error)) != MLN_PLUGIN_STATUS_OK)
        throw std::runtime_error(error);
    std::ifstream input(argv[2]); std::stringstream content; content << input.rdbuf();
    rapidjson::Document document; document.Parse(content.str().c_str());
    void* device = MTLCreateSystemDefaultDevice();
    if (!device) throw std::runtime_error("Metal device unavailable");
    auto runtimeOptions = mln_runtime_options_default();
    mln_runtime runtime{}; check(mln_runtime_create(&runtimeOptions, &runtime));
    for (const auto& c : document["cases"].GetArray()) {
        std::cout << c["name"].GetString() << std::endl;
        const auto& frame = c["frame"];
        const double ratio = frame["pixelRatio"].GetDouble();
        auto options = mln_map_options_default();
        options.width = 800; options.height = 600; options.scale_factor = ratio;
        options.map_mode = MLN_MAP_MODE_STATIC;
        mln_map map{}; check(mln_map_create(runtime, &options, &map));
        auto descriptor = mln_metal_owned_texture_descriptor_default();
        descriptor.extent.width = 800; descriptor.extent.height = 600; descriptor.extent.scale_factor = ratio;
        descriptor.context.device = device;
        mln_render_session session{}; check(mln_metal_owned_texture_attach(map, &descriptor, &session));
        std::ostringstream json; rapidjson::OStreamWrapper stream(json); rapidjson::Writer<rapidjson::OStreamWrapper> writer(stream);
        writer.StartObject(); writer.Key("version"); writer.Int(8); writer.Key("sources"); writer.StartObject(); writer.EndObject();
        writer.Key("layers"); writer.StartArray(); writer.StartObject(); writer.Key("id"); writer.String("puck");
        writer.Key("type"); writer.String("location-puck"); writer.Key("paint"); c["paint"].Accept(writer);
        writer.EndObject(); writer.EndArray(); writer.EndObject();
        const auto style = json.str(); check(mln_map_set_style_json(map, {style.data(), style.size()}));
        auto camera = mln_camera_options_default();
        camera.fields = MLN_CAMERA_OPTION_CENTER | MLN_CAMERA_OPTION_ZOOM | MLN_CAMERA_OPTION_PITCH | MLN_CAMERA_OPTION_BEARING;
        camera.latitude = frame["center"][0].GetDouble(); camera.longitude = frame["center"][1].GetDouble();
        camera.zoom = frame["zoom"].GetDouble(); camera.pitch = frame["pitch"].GetDouble() * 180 / M_PI;
        camera.bearing = -frame["bearing"].GetDouble() * 180 / M_PI;
        check(mln_map_jump_to(map, &camera));
        // Apply attach/style/camera work before requesting the static frame.
        check(mln_runtime_pump(runtime, 0, 10)); check(mln_map_request_still_image(map));
        bool rendered = false;
        for (int i = 0; i < 500 && !rendered; ++i) {
            check(mln_runtime_pump(runtime, 0, 10));
            mln_render_result result; bool repaint;
            check(mln_render_session_render_update(session, &result, &repaint));
            rendered = result == MLN_RENDER_RESULT_RENDERED;
            if (!rendered) std::this_thread::sleep_for(std::chrono::milliseconds(2));
        }
        if (!rendered) throw std::runtime_error("render timed out");
        const auto& polygon = c["queryPolygons"][c["queryPolygons"].Size() - 1];
        double x = (polygon[0][0].GetDouble() + polygon[2][0].GetDouble()) / 2;
        double y = (polygon[0][1].GetDouble() + polygon[2][1].GetDouble()) / 2;
        const auto& m = frame["matrix"];
        const double w = m[3].GetDouble() * x + m[7].GetDouble() * y + m[15].GetDouble();
        const double sx = (1 + (m[0].GetDouble() * x + m[4].GetDouble() * y + m[12].GetDouble()) / w) * 400;
        const double sy = (1 - (m[1].GetDouble() * x + m[5].GetDouble() * y + m[13].GetDouble()) / w) * 300;
        if (query(session, sx, sy) != 1 || query(session, 0, 0) != 0) throw std::runtime_error("puck hit/miss mismatch");
        auto image = mln_texture_image_info_default();
        std::vector<uint8_t> pixels(size_t(800 * ratio) * size_t(600 * ratio) * 4);
        check(mln_texture_read_premultiplied_rgba8(session, pixels.data(), pixels.size(), &image));
        const auto alpha = pixels[size_t(std::round(sy * ratio)) * image.stride + size_t(std::round(sx * ratio)) * 4 + 3];
        if (alpha == 0) throw std::runtime_error("puck center has no rendered coverage");
        const double latitude = c["paint"]["position"][0].GetDouble();
        double longitude = c["paint"]["position"][1].GetDouble();
        longitude += 360 * std::round((frame["center"][1].GetDouble() - longitude) / 360);
        const double worldSize = 512 * std::exp2(frame["zoom"].GetDouble());
        const double originX = (longitude + 180) / 360 * worldSize;
        const double originY = (0.5 - std::log(std::tan(M_PI / 4 + latitude * M_PI / 360)) / (2 * M_PI)) * worldSize;
        for (size_t i = 0; i < 72; i += 18) {
            const auto& boundary = c["boundary"][i]["world"];
            const double px = originX + .65 * (boundary[0].GetDouble() - originX);
            const double py = originY + .65 * (boundary[1].GetDouble() - originY);
            const double pw = m[3].GetDouble() * px + m[7].GetDouble() * py + m[15].GetDouble();
            const double sampleX = (1 + (m[0].GetDouble() * px + m[4].GetDouble() * py + m[12].GetDouble()) / pw) * 400;
            const double sampleY = (1 - (m[1].GetDouble() * px + m[5].GetDouble() * py + m[13].GetDouble()) / pw) * 300;
            if (pw <= 0 || sampleX < 1 || sampleX >= 799 || sampleY < 1 || sampleY >= 599) continue;
            const size_t offset = size_t(std::round(sampleY * ratio)) * image.stride + size_t(std::round(sampleX * ratio)) * 4;
            if (pixels[offset + 3] == 0) throw std::runtime_error("accuracy circle has no rendered coverage");
        }

        check(mln_render_session_destroy(session)); check(mln_map_destroy(map));
    }
    check(mln_runtime_destroy(runtime));
    std::cout << "8 Metal frames: pixels and rendered queries passed\n";
    // Keep the registered plugin code loaded for the process lifetime.
}
