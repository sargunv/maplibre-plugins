// Generates packages/paint/fixtures/binder/expected.json from cases.json by
// running each case through MapLibre Native's own plugin property code:
// convertPluginPropertyValue, PluginPropertyValue::evaluate (with and without
// a feature), interpolationFactor, isDataDriven/isZoomConstant/
// usesFeatureState, PluginTransitioningPropertyValue, and
// PluginPaintPropertyBinder for the encoded vertex and uniform floats.
//
// Built as a gtest against an FFI build's static libraries (see README.md
// next to the fixtures). Environment:
//   BINDER_CASES     path to cases.json
//   BINDER_EXPECTED  path to write expected.json

#include <mln/renderer/buckets/plugin_bucket.hpp>
#include <mln/style/plugin_property.hpp>
#include <mln/style/rapidjson_conversion.hpp>
#include <mln/tile/geojson_tile_data.hpp>
#include <mln/util/feature.hpp>
#include <gtest/gtest.h>

#include <cmath>
#include <cstdio>
#include <cstdlib>
#include <fstream>
#include <sstream>
#include <string>
#include <vector>

using namespace mln;

namespace {

// ---- JSON output -----------------------------------------------------------

std::string quote(const std::string& text) {
    std::string out = "\"";
    for (const char c : text) {
        switch (c) {
            case '"':
                out += "\\\"";
                break;
            case '\\':
                out += "\\\\";
                break;
            case '\n':
                out += "\\n";
                break;
            default:
                if (static_cast<unsigned char>(c) < 0x20) {
                    char buffer[8];
                    std::snprintf(buffer, sizeof buffer, "\\u%04x", c);
                    out += buffer;
                } else {
                    out += c;
                }
        }
    }
    return out + "\"";
}

std::string number(double value) {
    if (std::isnan(value)) return "\"NaN\"";
    if (std::isinf(value)) return value > 0 ? "\"Infinity\"" : "\"-Infinity\"";
    if (value == 0) return std::signbit(value) ? "-0" : "0";
    char buffer[40];
    if (value == std::floor(value) && std::fabs(value) < 1e15) {
        std::snprintf(buffer, sizeof buffer, "%.0f", value);
        return buffer;
    }
    std::snprintf(buffer, sizeof buffer, "%.17g", value);
    // Shorten to the fewest digits that still round-trip.
    for (int precision = 1; precision <= 17; ++precision) {
        char shorter[40];
        std::snprintf(shorter, sizeof shorter, "%.*g", precision, value);
        if (std::strtod(shorter, nullptr) == value) return shorter;
    }
    return buffer;
}

std::string numbers(const float* values, std::size_t count) {
    std::string out = "[";
    for (std::size_t i = 0; i < count; ++i) out += (i ? "," : "") + number(values[i]);
    return out + "]";
}

std::string pluginValue(const mln_plugin_value& value) {
    switch (value.type) {
        case MLN_PLUGIN_VALUE_FLOAT:
        case MLN_PLUGIN_VALUE_ROTATION:
            return number(value.data.float_value);
        case MLN_PLUGIN_VALUE_FLOAT2:
            return "[" + number(value.data.float2_value.x) + "," + number(value.data.float2_value.y) + "]";
        case MLN_PLUGIN_VALUE_DOUBLE2:
            return "[" + number(value.data.double2_value.x) + "," + number(value.data.double2_value.y) + "]";
        case MLN_PLUGIN_VALUE_COLOR:
            return "[" + number(value.data.color_value.r) + "," + number(value.data.color_value.g) + "," +
                   number(value.data.color_value.b) + "," + number(value.data.color_value.a) + "]";
        case MLN_PLUGIN_VALUE_STRING:
            return quote(std::string(value.data.string_value.data, value.data.string_value.size));
    }
    return "null";
}

// ---- JSON input ------------------------------------------------------------

const JSValue* member(const JSValue& object, const char* name) {
    if (!object.IsObject()) return nullptr;
    const auto it = object.FindMember(name);
    return it == object.MemberEnd() ? nullptr : &it->value;
}

// GeoJSON property values, as mapbox::geojson parses them for a GeoJSON
// source: unsigned and signed integers stay integers, other numbers are
// doubles.
mln::Value featureValue(const JSValue& json) {
    if (json.IsNull()) return mln::Value{};
    if (json.IsBool()) return mln::Value{json.GetBool()};
    if (json.IsString()) return mln::Value{std::string(json.GetString(), json.GetStringLength())};
    if (json.IsNumber()) {
        if (json.IsUint64()) return mln::Value{json.GetUint64()};
        if (json.IsInt64()) return mln::Value{json.GetInt64()};
        return mln::Value{json.GetDouble()};
    }
    if (json.IsArray()) {
        mapbox::base::ValueArray array;
        for (const auto& item : json.GetArray()) array.push_back(featureValue(item));
        return mln::Value{std::move(array)};
    }
    mapbox::base::ValueObject object;
    for (const auto& entry : json.GetObject()) {
        object.emplace(std::string(entry.name.GetString(), entry.name.GetStringLength()), featureValue(entry.value));
    }
    return mln::Value{std::move(object)};
}

PropertyMap propertyMap(const JSValue* json) {
    PropertyMap map;
    if (!json || !json->IsObject()) return map;
    for (const auto& entry : json->GetObject()) {
        map.emplace(std::string(entry.name.GetString(), entry.name.GetStringLength()), featureValue(entry.value));
    }
    return map;
}

plugin::PropertyDefinition definition(const JSValue& json) {
    plugin::PropertyDefinition result;
    result.name = member(json, "name")->GetString();
    const std::string type = member(json, "type")->GetString();
    const auto& fallback = *member(json, "default");
    const auto f32 = [](const JSValue& value) { return static_cast<double>(static_cast<float>(value.GetDouble())); };
    if (type == "float" || type == "rotation") {
        result.type = type == "float" ? MLN_PLUGIN_VALUE_FLOAT : MLN_PLUGIN_VALUE_ROTATION;
        result.defaultValue = f32(fallback);
    } else if (type == "float2" || type == "color") {
        result.type = type == "float2" ? MLN_PLUGIN_VALUE_FLOAT2 : MLN_PLUGIN_VALUE_COLOR;
        mapbox::base::ValueArray array;
        for (const auto& item : fallback.GetArray()) array.emplace_back(f32(item));
        result.defaultValue = std::move(array);
    } else if (type == "double2") {
        result.type = MLN_PLUGIN_VALUE_DOUBLE2;
        mapbox::base::ValueArray array;
        for (const auto& item : fallback.GetArray()) array.emplace_back(item.GetDouble());
        result.defaultValue = std::move(array);
    } else {
        result.type = MLN_PLUGIN_VALUE_STRING;
        result.defaultValue = std::string(fallback.GetString());
        for (const auto& value : member(json, "values")->GetArray()) result.enumValues.emplace_back(value.GetString());
    }
    if (const auto* minimum = member(json, "minimum")) result.minimum = static_cast<float>(minimum->GetDouble());
    if (const auto* maximum = member(json, "maximum")) result.maximum = static_cast<float>(maximum->GetDouble());
    const auto* expressions = member(json, "expressions");
    const bool dataDriven = expressions && std::string(expressions->GetString()) == "data-driven";
    result.expressionCapabilities = dataDriven ? (MLN_PLUGIN_EXPRESSION_CAMERA | MLN_PLUGIN_EXPRESSION_FEATURE |
                                                  MLN_PLUGIN_EXPRESSION_COMPOSITE | MLN_PLUGIN_EXPRESSION_FEATURE_STATE)
                                               : MLN_PLUGIN_EXPRESSION_CAMERA;
    return result;
}

mln_plugin_property_encoding_v1 encoding(const plugin::PropertyDefinition& definition) {
    switch (definition.type) {
        case MLN_PLUGIN_VALUE_FLOAT2:
            return MLN_PLUGIN_PROPERTY_ENCODING_FLOAT2;
        case MLN_PLUGIN_VALUE_COLOR:
            return MLN_PLUGIN_PROPERTY_ENCODING_COLOR;
        case MLN_PLUGIN_VALUE_STRING:
            return MLN_PLUGIN_PROPERTY_ENCODING_ENUM_FLOAT;
        default:
            return MLN_PLUGIN_PROPERTY_ENCODING_FLOAT;
    }
}

// A single-feature GeoJSON tile layer, the way a GeoJSON source hands point,
// line and polygon features to a plugin bucket.
std::unique_ptr<GeoJSONTileLayer> featureLayer(const JSValue& json) {
    auto collection = std::make_shared<mapbox::feature::feature_collection<int16_t>>();
    const auto* typeJson = member(json, "type");
    const int type = typeJson ? typeJson->GetInt() : 1;
    mapbox::feature::feature<int16_t> feature;
    if (type == 2) {
        feature.geometry = mapbox::geometry::line_string<int16_t>{{0, 0}, {10, 10}};
    } else if (type == 3) {
        feature.geometry = mapbox::geometry::polygon<int16_t>{{{0, 0}, {10, 0}, {10, 10}, {0, 0}}};
    } else {
        feature.geometry = mapbox::geometry::point<int16_t>(10, 20);
    }
    if (const auto* id = member(json, "id")) {
        if (id->IsString()) {
            feature.id = std::string(id->GetString());
        } else if (id->IsUint64()) {
            feature.id = id->GetUint64();
        } else if (id->IsInt64()) {
            feature.id = id->GetInt64();
        } else {
            feature.id = id->GetDouble();
        }
    }
    const auto properties = propertyMap(member(json, "properties"));
    for (const auto& [key, value] : properties) feature.properties.emplace(key, value);
    collection->push_back(std::move(feature));
    return std::make_unique<GeoJSONTileLayer>(collection);
}

std::optional<style::PluginPropertyValue> convert(const plugin::PropertyDefinition& definition,
                                                  const JSValue& value,
                                                  std::string& message) {
    style::conversion::Error error;
    auto result = style::convertPluginPropertyValue(definition, style::conversion::Convertible(&value), error);
    if (!result) message = error.message;
    return result;
}

std::string transitions(const plugin::PropertyDefinition& definition, const JSValue& scripts) {
    std::string out = "[";
    bool firstScript = true;
    for (const auto& script : scripts.GetArray()) {
        out += firstScript ? "[" : ",[";
        firstScript = false;
        std::vector<style::PluginPropertyValue> sets;
        std::string message;
        auto initial = convert(definition, *member(script, "initial"), message);
        EXPECT_TRUE(initial) << message;
        sets.push_back(*initial);
        style::PluginTransitioningPropertyValue value(*initial);
        const auto start = TimePoint{};
        bool firstSample = true;
        for (const auto& step : member(script, "steps")->GetArray()) {
            const auto now = start + std::chrono::duration_cast<Duration>(
                                         std::chrono::duration<double, std::milli>(member(step, "now")->GetDouble()));
            if (const auto* set = member(step, "set")) {
                auto next = convert(definition, *set, message);
                EXPECT_TRUE(next) << message;
                style::TransitionOptions options;
                options.duration = std::chrono::duration_cast<Duration>(
                    std::chrono::duration<double, std::milli>(member(step, "duration")->GetDouble()));
                options.delay = std::chrono::duration_cast<Duration>(
                    std::chrono::duration<double, std::milli>(member(step, "delay")->GetDouble()));
                sets.push_back(*next);
                value = style::PluginTransitioningPropertyValue(*next, std::move(value), options, now);
                continue;
            }
            const auto zoom = static_cast<float>(member(step, "zoom")->GetDouble());
            const auto evaluated = value.evaluate(zoom, definition, now);
            out += firstSample ? "" : ",";
            firstSample = false;
            if (evaluated.isDataDriven()) {
                int which = -1;
                for (std::size_t i = 0; i < sets.size(); ++i) {
                    if (sets[i] == evaluated) which = static_cast<int>(i);
                }
                out += "{\"kind\":\"feature\",\"which\":" + std::to_string(which) + "}";
            } else {
                style::PluginPropertyValue::EvaluationStorage storage;
                out += "{\"kind\":\"uniform\",\"value\":" +
                       pluginValue(evaluated.evaluate(zoom, definition, storage)) + "}";
            }
        }
        out += "]";
    }
    return out + "]";
}

std::string runCase(const JSValue& testCase) {
    const std::string name = member(testCase, "name")->GetString();
    const auto definition = ::definition(*member(testCase, "property"));
    std::string out = "{\"name\":" + quote(name);
    std::string message;
    const auto parsed = convert(definition, *member(testCase, "value"), message);
    if (!parsed) return out + ",\"parse\":{\"error\":" + quote(message) + "}}";
    const auto& value = *parsed;
    out += ",\"parse\":{\"ok\":true}";
    out += std::string(",\"dataDriven\":") + (value.isDataDriven() ? "true" : "false");
    out += std::string(",\"zoomConstant\":") + (value.isZoomConstant() ? "true" : "false");
    out += std::string(",\"usesFeatureState\":") + (value.usesFeatureState() ? "true" : "false");

    const plugin::ShaderPropertyBindingDefinition binding{definition.name, encoding(definition), 0, 0, 1, 1, 0, 16};
    const auto components = definition.type == MLN_PLUGIN_VALUE_COLOR    ? 4
                            : definition.type == MLN_PLUGIN_VALUE_FLOAT2 ? 2
                                                                         : 1;

    out += ",\"evaluations\":[";
    bool first = true;
    if (const auto* evaluations = member(testCase, "evaluations")) {
        for (const auto& evaluation : evaluations->GetArray()) {
            out += first ? "{" : ",{";
            first = false;
            const auto zoom = static_cast<float>(member(evaluation, "zoom")->GetDouble());
            style::PluginPropertyValue::EvaluationStorage storage;
            out += "\"without\":" + pluginValue(value.evaluate(zoom, definition, storage));
            if (!value.isDataDriven() && definition.type != MLN_PLUGIN_VALUE_DOUBLE2) {
                // The binder's uniform: the camera value encoded as the shader sees it.
                auto empty = std::make_shared<const PluginFeatureData>(
                    std::vector<PluginFeatureVertexRange>{},
                    std::make_unique<GeoJSONTileLayer>(
                        std::make_shared<mapbox::feature::feature_collection<int16_t>>()));
                PluginPaintPropertyBinder binder(definition, binding, value, zoom, 1, 0, empty);
                float uniform[4 + 4]{};
                binder.writeUniform(zoom, 0, reinterpret_cast<uint8_t*>(uniform), sizeof uniform);
                out += ",\"uniform\":" + numbers(uniform, components);
            }
            const auto* featureJson = member(evaluation, "feature");
            if (!featureJson) {
                out += "}";
                continue;
            }
            auto layer = featureLayer(*featureJson);
            const auto feature = layer->getFeature(0);
            const auto state = propertyMap(member(evaluation, "state"));
            out += ",\"value\":" + pluginValue(value.evaluate(zoom, *feature, state, definition, storage));
            if (value.isDataDriven() && definition.type != MLN_PLUGIN_VALUE_DOUBLE2) {
                // The binder's vertex floats with the evaluation zoom as the
                // bucket zoom: [min..., max...].
                const auto idString = featureIDtoString(feature->getID()).value_or(std::string{});
                const GeoJSONTileLayer copy = *layer;
                auto data = std::make_shared<const PluginFeatureData>(
                    std::vector<PluginFeatureVertexRange>{{0, 1, 0, 1}}, std::move(layer));
                PluginPaintPropertyBinder binder(definition, binding, value, zoom, 1, 1, data);
                if (!state.empty()) binder.update(FeatureStates{{idString, state}}, copy);
                const auto* floats = static_cast<const float*>(binder.getVertexVector()->getRawData());
                out += ",\"encoded\":" + numbers(floats, components * 2);
            }
            out += "}";
        }
    }
    out += "]";

    out += ",\"factors\":[";
    first = true;
    if (const auto* factors = member(testCase, "factors")) {
        for (const auto& factor : factors->GetArray()) {
            const auto bucketZoom = static_cast<float>(member(factor, "bucketZoom")->GetDouble());
            const auto zoom = static_cast<float>(member(factor, "zoom")->GetDouble());
            // PluginPaintPropertyBinder::interpolationFactor: 0 unless data-driven.
            out += (first ? "" : ",") + number(value.isDataDriven() ? value.interpolationFactor(bucketZoom, zoom) : 0.0f);
            first = false;
        }
    }
    out += "]";

    if (const auto* scripts = member(testCase, "transitions")) {
        out += ",\"transitions\":" + transitions(definition, *scripts);
    }
    return out + "}";
}

} // namespace

TEST(BinderProbe, Generate) {
    const char* casesPath = std::getenv("BINDER_CASES");
    const char* expectedPath = std::getenv("BINDER_EXPECTED");
    ASSERT_TRUE(casesPath && expectedPath);
    std::ifstream input(casesPath);
    std::stringstream text;
    text << input.rdbuf();
    JSDocument document;
    document.Parse(text.str().c_str());
    ASSERT_FALSE(document.HasParseError());
    std::string out =
        "{\"$comment\":\"Generated by fixtures/binder/probe.cpp from cases.json through MapLibre Native's plugin "
        "property code. Numbers are the host's values; non-finite ones are the strings NaN, Infinity and "
        "-Infinity.\",\"source\":\"probe\",\"cases\":[";
    bool first = true;
    for (const auto& testCase : member(document, "cases")->GetArray()) {
        out += (first ? "" : ",") + runCase(testCase);
        first = false;
    }
    out += "]}\n";
    std::ofstream(expectedPath) << out;
}
