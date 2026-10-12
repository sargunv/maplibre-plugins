// Native reference: real TransformState matrices and the host's CheapRuler
// destinations, passed to the plugin through its ordinary registration ABI.
#include <mln/map/transform_state.hpp>
#include <mln/plugin/plugin_api.h>
#include <mapbox/cheap_ruler.hpp>
#include <rapidjson/ostreamwrapper.h>
#include <rapidjson/writer.h>
#include <dlfcn.h>
#include <cmath>
#include <iostream>
#include <stdexcept>
#include <string_view>
#include <vector>

using Writer = rapidjson::Writer<rapidjson::OStreamWrapper>;
static const mln_plugin_layer_type_v1* layer;
static mln_plugin_status capture(const mln_plugin_descriptor_v1* descriptor, char*, size_t) {
    layer = descriptor->layer_types;
    return MLN_PLUGIN_STATUS_OK;
}
static void project(const mln_plugin_frame_context_v1* context, double lat, double lon, double* x, double* y) {
    const auto& state = *static_cast<const mln::TransformState*>(context->project_state);
    auto position = mln::LatLng(lat, lon).wrapped();
    position.unwrapForShortestPath(state.getLatLng(mln::LatLng::Wrapped));
    const auto point = mln::Projection::project(position, state.getScale());
    *x = point.x;
    *y = point.y;
}
static void destination(const mln_plugin_frame_context_v1*, double lat, double lon, double meters,
                        double bearing, double* outLat, double* outLon) {
    const mapbox::cheap_ruler::CheapRuler ruler(lat, mapbox::cheap_ruler::CheapRuler::Meters);
    const auto point = ruler.destination({lon, lat}, meters, bearing);
    *outLat = point.y;
    *outLon = point.x;
}
struct Vertex { float position[4], point[2], style[4], fill[4], border[4]; };
struct Case {
    const char* name;
    double lat, lon, centerLat, centerLon, zoom, pitch, bearing, radius, ratio, displacement;
};
static const Case cases[] = {
    {"equator-millimeter", 0, 0, 0, 0, 22, 0, 0, .001, 1, 0},
    {"san-francisco", 37.7749, -122.4194, 37.7749, -122.4194, 16, 0, 0, 80, 1, 0},
    {"large-pitched-offset", 37.78, -122.41, 37.7749, -122.4194, 12, 45, 30, 5000, 2, 10},
    {"arctic-pitch", 80, 20, 80, 20, 13.5, 60, -70, 150, 2, 8},
    {"southern-latitude", -45, 170, -45.002, 170.003, 15, 30, 110, 150, 1.5, 5},
    {"antimeridian-east", 10, 179.9999, 10, -179.9998, 17, 50, 45, 80, 2, 10},
    {"antimeridian-west", 10, -179.9999, 10, 179.9998, 17, 50, -45, 80, 1, 10},
    {"high-zoom-tilt", 60, 10, 60.00001, 10.00002, 20, 70, 175, 5, 2, 12},
};
static void pair(Writer& w, double x, double y) { w.StartArray(); w.Double(x); w.Double(y); w.EndArray(); }
int main(int argc, char** argv) {
    if (argc != 2) throw std::runtime_error("pass the built location-puck library");
    void* library = dlopen(argv[1], RTLD_NOW);
    if (!library) throw std::runtime_error(dlerror());
    auto entry = reinterpret_cast<mln_plugin_status (*)(mln_plugin_register_function_v1, char*, size_t)>(
        dlsym(library, "mln_location_puck_register"));
    if (!entry || entry(capture, nullptr, 0) != MLN_PLUGIN_STATUS_OK) throw std::runtime_error("registration failed");
    rapidjson::OStreamWrapper stream(std::cout);
    Writer w(stream);
    w.StartObject();
    w.Key("cases"); w.StartArray();
    for (const auto& c : cases) {
        mln::TransformState state;
        state.setSize({800, 600});
        state.setLatLngZoom({c.centerLat, c.centerLon}, c.zoom);
        state.setPitch(c.pitch * M_PI / 180);
        state.setBearing(-c.bearing * M_PI / 180);
        mln_plugin_frame_context_v1 context{};
        context.struct_size = sizeof(context);
        context.zoom = state.getZoom();
        context.center_latitude = state.getLatLng().latitude();
        context.center_longitude = state.getLatLng().longitude();
        context.pitch = state.getPitch();
        context.bearing = state.getBearing();
        context.viewport_width = 800; context.viewport_height = 600;
        context.pixel_ratio = c.ratio;
        context.camera_to_center_distance = state.getCameraToCenterDistance();
        context.project_state = &state;
        context.project_mercator = project; context.destination = destination;
        mln::mat4 matrix; state.getProjMatrix(matrix);
        std::copy(matrix.begin(), matrix.end(), context.proj_matrix);
        std::vector<mln_plugin_property_value_v1> properties;
        for (size_t i = 0; i < layer->property_count; ++i) {
            const auto& definition = layer->properties[i];
            properties.push_back({sizeof(mln_plugin_property_value_v1), definition.name, definition.default_value, 1});
            auto& value = properties.back().value;
            const std::string_view name(definition.name.data, definition.name.size);
            if (name == "position") value.data.double2_value = {c.lat, c.lon};
            if (name == "accuracy-radius") value.data.float_value = c.radius;
            if (name == "accuracy-border-width") value.data.float_value = 2;
            if (name == "bearing-visible") value.data.float_value = 1;
            if (name == "bearing") value.data.float_value = 35;
            if (name == "shadow-radius") value.data.float_value = 12;
            if (name == "tilt-displacement") value.data.float_value = c.displacement;
        }
        context.properties = properties.data(); context.property_count = properties.size();
        mln_plugin_bucket_v1 bucket{}; bucket.struct_size = sizeof(bucket);
        if (layer->build_frame(&context, &bucket) != MLN_PLUGIN_STATUS_OK) throw std::runtime_error(c.name);
        w.StartObject(); w.Key("name"); w.String(c.name);
        w.Key("paint"); w.StartObject();
        w.Key("position"); pair(w, c.lat, c.lon);
        for (const auto& p : properties) {
            const std::string_view name(p.name.data, p.name.size);
            if (name == "accuracy-radius" || name == "accuracy-border-width" || name == "bearing-visible" ||
                name == "bearing" || name == "shadow-radius" || name == "tilt-displacement") {
                w.Key(p.name.data, p.name.size); w.Double(p.value.data.float_value);
            }
        }
        w.EndObject();
        w.Key("frame"); w.StartObject();
        w.Key("center"); pair(w, context.center_latitude, context.center_longitude);
        w.Key("zoom"); w.Double(context.zoom);
        w.Key("pitch"); w.Double(context.pitch); w.Key("bearing"); w.Double(context.bearing);
        w.Key("pixelRatio"); w.Double(context.pixel_ratio);
        w.Key("viewport"); pair(w, 800, 600);
        w.Key("cameraToCenterDistance"); w.Double(context.camera_to_center_distance);
        w.Key("matrix"); w.StartArray(); for (double x : matrix) w.Double(x); w.EndArray();
        w.EndObject();
        // Store the helper's inputs/outputs, independently of JS's destination.
        w.Key("boundary"); w.StartArray();
        double radius = 0; for (const auto& p : properties)
            if (std::string_view(p.name.data, p.name.size) == "accuracy-radius") radius = p.value.data.float_value;
        for (int i = 0; i <= 72; ++i) {
            double lat, lon, x, y; destination(&context, c.lat, c.lon, radius * 1.15, i * 5., &lat, &lon);
            project(&context, lat, lon, &x, &y);
            w.StartObject(); w.Key("latLng"); pair(w, lat, lon); w.Key("world"); pair(w, x, y); w.EndObject();
        }
        w.EndArray();
        w.Key("vertices"); w.StartArray();
        const auto& vertexStream = bucket.vertex_streams[0];
        if (vertexStream.stride != sizeof(Vertex)) throw std::runtime_error("unexpected vertex format");
        const auto* vertices = reinterpret_cast<const Vertex*>(vertexStream.data);
        for (size_t i = 0; i < vertexStream.vertex_count; ++i) {
            const auto& p = vertices[i].position;
            pair(w, (p[0] / double(p[3]) + 1) * 400, (1 - p[1] / double(p[3])) * 300);
        }
        w.EndArray();
        w.Key("queryPolygons"); w.StartArray();
        for (size_t p = 0; p < bucket.frame_features[0].polygon_count; ++p) {
            const auto& polygon = bucket.frame_features[0].polygons[p];
            w.StartArray(); for (size_t i = 0; i < polygon.point_count; ++i) pair(w, polygon.points[i].x, polygon.points[i].y); w.EndArray();
        }
        w.EndArray(); w.EndObject();
    }
    w.EndArray(); w.EndObject(); std::cout << '\n';
    // Registration pointers remain live until process exit.
}
