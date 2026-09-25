//! Animated vector icons for MapLibre Native's plugin ABI. Every point of the
//! layer's source becomes one quad (layout.zig) that shaders/place.glsl
//! spreads over the animation's anchor box like a point-symbol icon, picking
//! the frame from the plugin clock and the feature's speed, offset and mode;
//! shaders/icon.glsl then computes the coverage of that frame's quadratic
//! outlines analytically. The animations come from a baked `.mlvc` catalog
//! (catalog.zig, ../../catalog/FORMAT.md): all of its frames live in a
//! static RGBA32F texture, and a LAYER uniform block holds the clock and one
//! header per animation. The demo catalog is embedded; apps register their
//! own through mln_animated_icon_register_catalog. See ../../spec.json for
//! the contract this file shares with the maplibre-gl-js implementation.

const std = @import("std");
const builtin = @import("builtin");
const build_options = @import("build_options");
const c = @import("maplibre_native_c");
const catalog = @import("catalog");
const layout = @import("layout.zig");
const place = @import("place.zig");

pub const layer_type_name = "animated-icon";
pub const plugin_id = "org.maplibre.plugins.animated-icon";
pub const plugin_version = "0.2.0";

fn str(bytes: []const u8) c.mln_plugin_string {
    return .{ .data = bytes.ptr, .size = bytes.len };
}

fn slice(s: c.mln_plugin_string) []const u8 {
    return if (s.size == 0 or s.data == null) "" else s.data[0..s.size];
}

// ---------------------------------------------------------------------------
// Paint properties. Keep in sync with ../../spec.json; the "descriptors match
// the shared spec" test enforces it.
// ---------------------------------------------------------------------------

const PropertyKind = enum { float, rotation, color, float2, enumeration };

/// Which expressions a property accepts: camera (constants and zoom) or
/// data-driven (also feature, composite and feature-state).
const Expressions = enum { camera, data_driven };

const Property = struct {
    name: []const u8,
    kind: PropertyKind,
    default: [4]f32 = .{ 0, 0, 0, 0 },
    minimum: ?f32 = null,
    maximum: ?f32 = null,
    /// An enum's values, or null for the catalog's: "none" and then every
    /// animation name.
    values: ?[]const []const u8 = &.{},
    /// An enum's default value.
    default_value: []const u8 = "",
    expressions: Expressions = .data_driven,
    /// Whether a `<name>-transition` key is accepted; null is the default:
    /// numbers yes, enums no.
    transition: ?bool = null,
    /// Field in DrawableUBO the host writes the evaluated value into.
    field: []const u8,
};

const mode_values = [_][]const u8{ "loop", "alternate", "once" };

const properties = [_]Property{
    .{ .name = "icon-animation", .kind = .enumeration, .values = null, .default_value = "none", .field = "icon_animation" },
    .{ .name = "icon-size", .kind = .float, .default = .{ 1, 0, 0, 0 }, .minimum = 0, .field = "icon_size" },
    .{ .name = "icon-rotate", .kind = .rotation, .field = "icon_rotate" },
    .{ .name = "icon-opacity", .kind = .float, .default = .{ 1, 0, 0, 0 }, .minimum = 0, .maximum = 1, .field = "icon_opacity" },
    .{ .name = "icon-color", .kind = .color, .field = "icon_color" },
    .{ .name = "icon-offset", .kind = .float2, .field = "icon_offset" },
    .{ .name = "icon-anchor", .kind = .enumeration, .values = &place.anchor_values, .default_value = "center", .field = "icon_anchor" },
    .{ .name = "icon-rotation-alignment", .kind = .enumeration, .values = &place.alignment_values, .default_value = "auto", .expressions = .camera, .field = "icon_rotation_alignment" },
    .{ .name = "icon-pitch-alignment", .kind = .enumeration, .values = &place.alignment_values, .default_value = "auto", .expressions = .camera, .field = "icon_pitch_alignment" },
    // A constant change of speed interpolates over the style-wide
    // transition, which sweeps the playhead; the key lets styles turn that
    // off with a duration of 0.
    .{ .name = "icon-animation-speed", .kind = .float, .default = .{ 1, 0, 0, 0 }, .minimum = -4, .maximum = 4, .transition = true, .field = "icon_animation_speed" },
    .{ .name = "icon-animation-offset", .kind = .float, .field = "icon_animation_offset" },
    .{ .name = "icon-animation-mode", .kind = .enumeration, .values = &mode_values, .default_value = "loop", .field = "icon_animation_mode" },
};

fn propertyIndex(comptime name: []const u8) usize {
    for (properties, 0..) |property, i| {
        if (std.mem.eql(u8, property.name, name)) return i;
    }
    @compileError("unknown property " ++ name);
}

fn valueType(comptime kind: PropertyKind) c.mln_plugin_value_type {
    return switch (kind) {
        .float => c.MLN_PLUGIN_VALUE_FLOAT,
        .rotation => c.MLN_PLUGIN_VALUE_ROTATION,
        .color => c.MLN_PLUGIN_VALUE_COLOR,
        .float2 => c.MLN_PLUGIN_VALUE_FLOAT2,
        .enumeration => c.MLN_PLUGIN_VALUE_STRING,
    };
}

fn capabilities(comptime expressions: Expressions) u32 {
    return switch (expressions) {
        .camera => c.MLN_PLUGIN_EXPRESSION_CAMERA,
        .data_driven => c.MLN_PLUGIN_EXPRESSION_CAMERA | c.MLN_PLUGIN_EXPRESSION_FEATURE |
            c.MLN_PLUGIN_EXPRESSION_COMPOSITE | c.MLN_PLUGIN_EXPRESSION_FEATURE_STATE,
    };
}

fn supportsTransitions(comptime property: Property) bool {
    return property.transition orelse (property.kind != .enumeration);
}

/// A fixed enum's values, as static plugin strings.
fn staticStrings(comptime values: []const []const u8) []const c.mln_plugin_string {
    const S = struct {
        const list = blk: {
            var result: [values.len]c.mln_plugin_string = undefined;
            for (values, 0..) |v, i| result[i] = str(v);
            break :blk result;
        };
    };
    return &S.list;
}

fn descriptor(comptime property: Property, enum_values: []const c.mln_plugin_string) c.mln_plugin_property_descriptor_v1 {
    const value_type = valueType(property.kind);
    const d = property.default;
    return .{
        .struct_size = @sizeOf(c.mln_plugin_property_descriptor_v1),
        .name = str(property.name),
        .type = value_type,
        .default_value = .{
            .struct_size = @sizeOf(c.mln_plugin_value),
            .type = value_type,
            .data = switch (property.kind) {
                .float, .rotation => .{ .float_value = d[0] },
                .color => .{ .color_value = .{ .r = d[0], .g = d[1], .b = d[2], .a = d[3] } },
                .float2 => .{ .float2_value = .{ .x = d[0], .y = d[1] } },
                .enumeration => .{ .string_value = str(property.default_value) },
            },
        },
        .expression_capabilities = capabilities(property.expressions),
        // The host holds an enum's old value through a transition and then
        // switches (README limit 6); numbers interpolate, and data-driven
        // targets snap.
        .supports_transitions = @intFromBool(supportsTransitions(property)),
        .has_minimum = if (property.minimum != null) 1 else 0,
        .has_maximum = if (property.maximum != null) 1 else 0,
        .minimum = property.minimum orelse 0,
        .maximum = property.maximum orelse 0,
        .enum_values = if (enum_values.len == 0) null else enum_values.ptr,
        .enum_value_count = enum_values.len,
    };
}

/// The property descriptors; icon-animation takes `animation_values`, built
/// from the catalog at registration.
fn propertyDescriptors(animation_values: []const c.mln_plugin_string) [properties.len]c.mln_plugin_property_descriptor_v1 {
    var result: [properties.len]c.mln_plugin_property_descriptor_v1 = undefined;
    inline for (properties, 0..) |property, i| {
        const values = if (property.values) |fixed| staticStrings(fixed) else animation_values;
        result[i] = descriptor(property, if (property.kind == .enumeration) values else &.{});
    }
    return result;
}

// ---------------------------------------------------------------------------
// Uniform blocks. Block 0 (vertex stage, per drawable) carries the matrix and
// camera the plugin fills, then each bound paint property and its
// interpolation factor, which the host writes afterwards. Block 1 (per
// layer, declared by the vertex stage) is IconCatalogUBO: the clock and one
// header per catalog entry (catalog.zig writeHeaderBlock). Both layouts are
// std140 and mirrored by the shader declarations below.
// ---------------------------------------------------------------------------

const drawable_uniform_id = 0;
const catalog_uniform_id = 1;

const DrawableUBO = extern struct {
    matrix: [16]f32,
    /// pixels_to_gl_units (x, y), pixels_to_tile_units,
    /// camera_to_center_distance.
    camera: [4]f32,
    /// pixel_ratio, bearing in radians (the camera bearing negated), unused.
    view: [4]f32,
    icon_color: [4]f32,
    icon_offset: [2]f32,
    icon_animation: f32,
    icon_size: f32,
    icon_rotate: f32,
    icon_opacity: f32,
    icon_anchor: f32,
    icon_rotation_alignment: f32,
    icon_pitch_alignment: f32,
    icon_animation_speed: f32,
    icon_animation_offset: f32,
    icon_animation_mode: f32,
    /// One composite interpolation factor per property, in spec order.
    interpolation: [12]f32,
};

comptime {
    std.debug.assert(@sizeOf(DrawableUBO) == 208);
    std.debug.assert(@offsetOf(DrawableUBO, "matrix") == 0);
    std.debug.assert(@offsetOf(DrawableUBO, "camera") == 64);
    std.debug.assert(@offsetOf(DrawableUBO, "view") == 80);
    std.debug.assert(@offsetOf(DrawableUBO, "icon_color") == 96);
    std.debug.assert(@offsetOf(DrawableUBO, "icon_offset") == 112);
    std.debug.assert(@offsetOf(DrawableUBO, "icon_animation") == 120);
    std.debug.assert(@offsetOf(DrawableUBO, "icon_size") == 124);
    std.debug.assert(@offsetOf(DrawableUBO, "icon_rotate") == 128);
    std.debug.assert(@offsetOf(DrawableUBO, "icon_opacity") == 132);
    std.debug.assert(@offsetOf(DrawableUBO, "icon_anchor") == 136);
    std.debug.assert(@offsetOf(DrawableUBO, "icon_rotation_alignment") == 140);
    std.debug.assert(@offsetOf(DrawableUBO, "icon_pitch_alignment") == 144);
    std.debug.assert(@offsetOf(DrawableUBO, "icon_animation_speed") == 148);
    std.debug.assert(@offsetOf(DrawableUBO, "icon_animation_offset") == 152);
    std.debug.assert(@offsetOf(DrawableUBO, "icon_animation_mode") == 156);
    std.debug.assert(@offsetOf(DrawableUBO, "interpolation") == 160);
}

/// The members of IconDrawableUBO, as GLSL (OpenGL, Vulkan, WebGL2).
const drawable_ubo_fields =
    \\    mat4 matrix;                    //   0  tile matrix
    \\    vec4 camera;                    //  64  pixels_to_gl.x, pixels_to_gl.y, pixels_to_tile_units, camera_to_center_distance
    \\    vec4 view;                      //  80  pixel_ratio, bearing (radians, the host's sign), 0, 0
    \\    vec4 icon_color;                //  96
    \\    vec2 icon_offset;               // 112
    \\    float icon_animation;           // 120
    \\    float icon_size;                // 124
    \\    float icon_rotate;              // 128
    \\    float icon_opacity;             // 132
    \\    float icon_anchor;              // 136
    \\    float icon_rotation_alignment;  // 140
    \\    float icon_pitch_alignment;     // 144
    \\    float icon_animation_speed;     // 148
    \\    float icon_animation_offset;    // 152
    \\    float icon_animation_mode;      // 156
    \\    vec4 interpolation0;            // 160  properties 0-3
    \\    vec4 interpolation1;            // 176  properties 4-7
    \\    vec4 interpolation2;            // 192  properties 8-11
    \\
;

/// The members of IconCatalogUBO, as GLSL; ICON_ENTRY_COUNT comes from the
/// catalog's shader defines.
const catalog_ubo_fields =
    \\    highp vec4 clock;                          // x: seconds in [0, 4096)
    \\    highp vec4 entries[2 * ICON_ENTRY_COUNT];  // entry e: [2e] box, [2e + 1] (display_px, loop_rate, frame_count, frame_texel)
    \\
;

// ---------------------------------------------------------------------------
// Shaders. The shared property, placement and coverage code compiles as GLSL
// and MSL; each backend wraps it with its own declarations, following the
// host's conventions for attributes, uniform blocks, textures and varyings.
// The catalog's shader defines go first, so the sources are put together at
// registration. The OpenGL text carries the sections the WebGL2 twin shares
// verbatim, between `// begin:<name>` and `// end:<name>` markers; they are
// pinned by ../../fixtures/shaders/sections.glsl.
// ---------------------------------------------------------------------------

/// Vertex attribute IDs, equal to their locations: a_pos from the layout,
/// then the host's per-property attribute slots, used when a property is
/// data-driven. A scalar or enum packs both interpolation endpoints into one
/// float2 slot, a float2 into one float4; a color needs a float4 slot for
/// each endpoint.
const geometry_attribute_count = 1;

fn slotCount(comptime property: Property) usize {
    return if (property.kind == .color) 2 else 1;
}

fn slotType(comptime property: Property) c.mln_plugin_vertex_attribute_type {
    return switch (property.kind) {
        .float, .rotation, .enumeration => c.MLN_PLUGIN_VERTEX_FLOAT_X2,
        .float2, .color => c.MLN_PLUGIN_VERTEX_FLOAT_X4,
    };
}

/// The first attribute ID of a property's slot(s).
fn firstSlot(comptime index: usize) usize {
    comptime var id: usize = geometry_attribute_count;
    inline for (properties[0..index]) |property| id += slotCount(property);
    return id;
}

const paint_attribute_count = blk: {
    var count: usize = 0;
    for (properties) |property| count += slotCount(property);
    break :blk count;
};

fn upperName(comptime property: Property) []const u8 {
    return comptime blk: {
        @setEvalBranchQuota(10_000);
        var name: [property.name.len]u8 = undefined;
        for (property.name, 0..) |ch, i| name[i] = if (std.ascii.isAlphanumeric(ch)) std.ascii.toUpper(ch) else '_';
        const upper = name;
        break :blk &upper;
    };
}

/// The host's macro for a property: 1 when it arrives as a uniform.
fn propertyMacro(comptime property: Property) []const u8 {
    return "MLN_PLUGIN_PROPERTY_" ++ comptime upperName(property) ++ "_IS_UNIFORM";
}

/// Attribute names: `a_<name>` for a packed pair, `a_<name>_min` and
/// `a_<name>_max` for a color's two endpoints.
fn attributeName(comptime property: Property, comptime slot: usize) []const u8 {
    return comptime blk: {
        var name: [property.name.len]u8 = undefined;
        for (property.name, 0..) |ch, i| name[i] = if (ch == '-') '_' else ch;
        const snake = name;
        break :blk "a_" ++ snake ++ (if (property.kind == .color) (if (slot == 0) "_min" else "_max") else "");
    };
}

fn digits(comptime n: usize) []const u8 {
    return comptime std.fmt.comptimePrint("{d}", .{n});
}

/// A shared section between its markers.
fn section(comptime name: []const u8, comptime body: []const u8) []const u8 {
    return "// begin:" ++ name ++ "\n" ++ body ++ "// end:" ++ name ++ "\n";
}

/// The attribute declarations, each paint attribute guarded so it only
/// exists for data-driven properties. The explicit locations are what Vulkan
/// needs; OpenGL matches attributes by name (patch 0008), so the same text
/// serves both.
const glsl_attributes = blk: {
    @setEvalBranchQuota(100_000);
    var result: []const u8 = "layout(location=0) in vec2 a_pos;\n";
    for (properties, 0..) |property, i| {
        result = result ++ "#if !" ++ propertyMacro(property) ++ "\n";
        for (0..slotCount(property)) |slot| {
            result = result ++ "layout(location=" ++ digits(firstSlot(i) + slot) ++ ") in " ++
                (if (slotType(property) == c.MLN_PLUGIN_VERTEX_FLOAT_X4) "vec4 " else "vec2 ") ++ attributeName(property, slot) ++ ";\n";
        }
        result = result ++ "#endif\n";
    }
    break :blk result;
};

fn metalPaintAttributes() []const u8 {
    return comptime blk: {
        @setEvalBranchQuota(100_000);
        var result: []const u8 = "";
        for (properties, 0..) |property, i| {
            result = result ++ "#if !" ++ propertyMacro(property) ++ "\n";
            for (0..slotCount(property)) |slot| {
                result = result ++ "    " ++ (if (slotType(property) == c.MLN_PLUGIN_VERTEX_FLOAT_X4) "float4 " else "float2 ") ++ attributeName(property, slot) ++ " [[attribute(" ++ digits(firstSlot(i) + slot) ++ ")]];\n";
            }
            result = result ++ "#endif\n";
        }
        break :blk result;
    };
}

/// Canvas position (interpolated), then (frame record texel, icon-opacity)
/// and the premultiplied icon-color, constant over the quad.
fn glslVaryings(comptime vulkan: bool, comptime direction: []const u8) []const u8 {
    return comptime (if (vulkan) "layout(location=0) " else "") ++ direction ++ " vec2 v_uv;\n" ++
        (if (vulkan) "layout(location=1) " else "") ++ "flat " ++ direction ++ " vec4 v_icon;\n" ++
        (if (vulkan) "layout(location=2) " else "") ++ "flat " ++ direction ++ " vec4 v_color;\n";
}

const glsl_vertex_macros =
    \\#define float2 vec2
    \\#define float4 vec4
    \\#define PROJECT(p) (u.matrix * vec4(p, 0.0, 1.0))
    \\#define ICON_PLACE_PARAM
    \\#define ICON_PLACE_ARG
    \\#define ICON_CLOCK (catalog.clock.x)
    \\#define ICON_ENTRY(i) (catalog.entries[i])
    \\#define ICON_ATTR(name) name
    \\
;

// FETCH keeps every read inside the texture whatever int it gets: the mask
// wraps x (two's complement included) and the clamp holds the row.
const glsl_fragment_macros =
    \\#define float2 vec2
    \\#define float4 vec4
    \\#define DX(v) dFdx(v)
    \\#define DY(v) dFdy(v)
    \\#define FETCH(i) texelFetch(u_art, ivec2((i) & ((1 << ICON_ART_SHIFT) - 1), clamp((i) >> ICON_ART_SHIFT, 0, ICON_ART_ROWS - 1)), 0)
    \\#define ICON_ART_PARAM
    \\#define ICON_ART_ARG
    \\
;

fn glslVertexMain(comptime vulkan: bool) []const u8 {
    return
    \\void main() {
    \\    IconVertex v = iconPlace(a_pos,
    \\        float4(ICON_ANIMATION, ICON_SIZE, ICON_ROTATE, ICON_OPACITY),
    \\        float4(ICON_ANCHOR, ICON_ROTATION_ALIGNMENT, ICON_PITCH_ALIGNMENT, 0.0),
    \\        ICON_OFFSET,
    \\        float4(ICON_ANIMATION_SPEED, ICON_ANIMATION_OFFSET, ICON_ANIMATION_MODE, 0.0),
    \\        u.camera, u.view.xy ICON_PLACE_ARG);
    \\    gl_Position = v.position;
    \\    v_uv = v.uv;
    \\    v_icon = vec4(v.frame, ICON_OPACITY, 0.0, 0.0);
    \\    v_color = ICON_COLOR;
    \\
    ++ (if (vulkan) "    applySurfaceTransform();\n" else "") ++ "}\n";
}

const glsl_fragment_main =
    \\void main() {
    \\    fragColor = iconShade(v_uv, v_icon.x, v_color, vec4(0.0), v_icon.y ICON_ART_ARG);
    \\}
    \\
;

/// The OpenGL sections the WebGL2 twin shares verbatim, in source order.
const Section = struct { name: []const u8, body: []const u8 };
const gl_sections = [_]Section{
    .{ .name = "attributes", .body = glsl_attributes },
    .{ .name = "drawable-ubo", .body = "layout(std140) uniform IconDrawableUBO {\n" ++ drawable_ubo_fields ++ "} u;\n" },
    .{ .name = "catalog-ubo", .body = "layout(std140) uniform IconCatalogUBO {\n" ++ catalog_ubo_fields ++ "} catalog;\n" },
    .{ .name = "varyings-out", .body = glslVaryings(false, "out") },
    .{ .name = "varyings-in", .body = glslVaryings(false, "in") },
    .{ .name = "vertex-main", .body = glslVertexMain(false) },
    .{ .name = "fragment-main", .body = glsl_fragment_main },
};

fn glSection(comptime name: []const u8) []const u8 {
    inline for (gl_sections) |s| {
        if (comptime std.mem.eql(u8, s.name, name)) return section(s.name, s.body);
    }
    @compileError("unknown section " ++ name);
}

/// The text of ../../fixtures/shaders/sections.glsl.
const shader_sections_text = blk: {
    var result: []const u8 =
        \\// The shader sections the OpenGL sources of the native plugin
        \\// (native/src/plugin.zig) and the WebGL2 sources of the JS layer
        \\// (js/src/shaders.ts) carry verbatim, each between its begin and end
        \\// markers. Both test suites check their sources against this file, so a
        \\// change to a section changes both twins and this file together.
        \\// plugin.zig generates it: `zig build test` prints the expected text when
        \\// it differs.
        \\
    ;
    for (gl_sections) |s| result = result ++ "\n" ++ section(s.name, s.body);
    break :blk result;
};

const property_glsl = build_options.properties_glsl;
const place_glsl = build_options.place_glsl;
const icon_glsl = build_options.icon_glsl;

/// The OpenGL and Vulkan vertex source after the catalog's defines.
fn glslVertex(comptime vulkan: bool) []const u8 {
    const attributes_text = if (vulkan) glsl_attributes else glSection("attributes");
    const blocks = if (vulkan)
        "layout(std140, set = DRAWABLE_UBO_SET_INDEX, binding = MLN_PLUGIN_UNIFORM_0_BINDING) uniform IconDrawableUBO {\n" ++ drawable_ubo_fields ++ "} u;\n" ++
            "layout(std140, set = DRAWABLE_UBO_SET_INDEX, binding = MLN_PLUGIN_UNIFORM_1_BINDING) uniform IconCatalogUBO {\n" ++ catalog_ubo_fields ++ "} catalog;\n"
    else
        glSection("drawable-ubo") ++ glSection("catalog-ubo");
    const varyings = if (vulkan) glslVaryings(true, "out") else glSection("varyings-out");
    const main = if (vulkan) glslVertexMain(true) else glSection("vertex-main");
    return attributes_text ++ blocks ++ varyings ++ glsl_vertex_macros ++ property_glsl ++ "\n" ++ place_glsl ++ "\n" ++ main;
}

/// The OpenGL and Vulkan fragment source after the catalog's defines. The
/// OpenGL host's prelude declares fragColor; GLSL ES defaults fragment
/// floats to mediump and samplers to lowp, both too coarse here.
fn glslFragment(comptime vulkan: bool) []const u8 {
    if (vulkan) return glslVaryings(true, "in") ++
        "layout(location=0) out vec4 fragColor;\n" ++
        "layout(set = DRAWABLE_IMAGE_SET_INDEX, binding = MLN_PLUGIN_TEXTURE_0_BINDING) uniform highp sampler2D u_art;\n" ++
        glsl_fragment_macros ++ icon_glsl ++ "\n" ++ glsl_fragment_main;
    return "precision highp float;\nprecision highp int;\n" ++ glSection("varyings-in") ++
        "uniform highp sampler2D u_art;\n" ++
        glsl_fragment_macros ++ icon_glsl ++ "\n" ++ glSection("fragment-main");
}

/// The Metal source after the catalog's defines.
const metal_source =
    \\struct alignas(16) IconDrawableUBO {
    \\    float4x4 matrix;
    \\    float4 camera;
    \\    float4 view;
    \\    float4 icon_color;
    \\    float2 icon_offset;
    \\    float icon_animation;
    \\    float icon_size;
    \\    float icon_rotate;
    \\    float icon_opacity;
    \\    float icon_anchor;
    \\    float icon_rotation_alignment;
    \\    float icon_pitch_alignment;
    \\    float icon_animation_speed;
    \\    float icon_animation_offset;
    \\    float icon_animation_mode;
    \\    float4 interpolation0;
    \\    float4 interpolation1;
    \\    float4 interpolation2;
    \\};
    \\struct IconCatalogUBO {
    \\    float4 clock;
    \\    float4 entries[2 * ICON_ENTRY_COUNT];
    \\};
    \\struct VertexIn {
    \\    float2 a_pos [[attribute(0)]];
    \\
++ metalPaintAttributes() ++
    \\};
    \\struct VertexOut {
    \\    float4 position [[position]];
    \\    float2 v_uv;
    \\    float4 v_icon [[flat]];
    \\    float4 v_color [[flat]];
    \\};
    \\#define PROJECT(p) (u.matrix * float4(p, 0.0, 1.0))
    \\#define ICON_PLACE_PARAM , constant IconDrawableUBO& u, constant IconCatalogUBO& catalog
    \\#define ICON_PLACE_ARG , u, catalog
    \\#define ICON_CLOCK (catalog.clock.x)
    \\#define ICON_ENTRY(i) (catalog.entries[i])
    \\#define ICON_ATTR(name) in.name
    \\#define DX(v) dfdx(v)
    \\#define DY(v) dfdy(v)
    \\#define FETCH(i) art.read(uint2(uint((i) & ((1 << ICON_ART_SHIFT) - 1)), uint(clamp((i) >> ICON_ART_SHIFT, 0, ICON_ART_ROWS - 1))))
    \\#define ICON_ART_PARAM , texture2d<float, access::read> art
    \\#define ICON_ART_ARG , art
    \\
++ property_glsl ++ "\n" ++ place_glsl ++ "\n" ++ icon_glsl ++
    \\
    \\vertex VertexOut iconVertex(VertexIn in [[stage_in]],
    \\                            constant IconDrawableUBO& u [[buffer(MLN_PLUGIN_UNIFORM_0_BINDING)]],
    \\                            constant IconCatalogUBO& catalog [[buffer(MLN_PLUGIN_UNIFORM_1_BINDING)]]) {
    \\    IconVertex v = iconPlace(in.a_pos,
    \\        float4(ICON_ANIMATION, ICON_SIZE, ICON_ROTATE, ICON_OPACITY),
    \\        float4(ICON_ANCHOR, ICON_ROTATION_ALIGNMENT, ICON_PITCH_ALIGNMENT, 0.0),
    \\        ICON_OFFSET,
    \\        float4(ICON_ANIMATION_SPEED, ICON_ANIMATION_OFFSET, ICON_ANIMATION_MODE, 0.0),
    \\        u.camera, u.view.xy ICON_PLACE_ARG);
    \\    VertexOut out;
    \\    out.position = v.position;
    \\    out.v_uv = v.uv;
    \\    out.v_icon = float4(v.frame, ICON_OPACITY, 0.0, 0.0);
    \\    out.v_color = ICON_COLOR;
    \\    return out;
    \\}
    \\fragment float4 iconFragment(VertexOut in [[stage_in]],
    \\                             texture2d<float, access::read> art [[texture(MLN_PLUGIN_TEXTURE_0_BINDING)]]) {
    \\    return iconShade(in.v_uv, in.v_icon.x, in.v_color, float4(0.0), in.v_icon.y ICON_ART_ARG);
    \\}
    \\
;

const attributes = blk: {
    var result: [geometry_attribute_count + paint_attribute_count]c.mln_plugin_shader_attribute_v1 = undefined;
    result[0] = .{ .struct_size = @sizeOf(c.mln_plugin_shader_attribute_v1), .attribute_id = 0, .location = 0, .name = str("a_pos"), .type = c.MLN_PLUGIN_VERTEX_FLOAT_X2 };
    for (properties, 0..) |property, i| {
        for (0..slotCount(property)) |slot| {
            const id = firstSlot(i) + slot;
            result[id] = .{ .struct_size = @sizeOf(c.mln_plugin_shader_attribute_v1), .attribute_id = id, .location = id, .name = str(attributeName(property, slot)), .type = slotType(property) };
        }
    }
    break :blk result;
};

fn encoding(comptime kind: PropertyKind) c.mln_plugin_property_encoding_v1 {
    return switch (kind) {
        .float, .rotation => c.MLN_PLUGIN_PROPERTY_ENCODING_FLOAT,
        .color => c.MLN_PLUGIN_PROPERTY_ENCODING_COLOR,
        .float2 => c.MLN_PLUGIN_PROPERTY_ENCODING_FLOAT2,
        .enumeration => c.MLN_PLUGIN_PROPERTY_ENCODING_ENUM_FLOAT,
    };
}

const property_bindings = blk: {
    var result: [properties.len]c.mln_plugin_shader_property_binding_v1 = undefined;
    for (properties, 0..) |property, i| {
        result[i] = .{
            .struct_size = @sizeOf(c.mln_plugin_shader_property_binding_v1),
            .property_name = str(property.name),
            .encoding = encoding(property.kind),
            .uniform_id = drawable_uniform_id,
            .uniform_byte_offset = @offsetOf(DrawableUBO, property.field),
            .minimum_attribute_id = firstSlot(i),
            .maximum_attribute_id = firstSlot(i) + slotCount(property) - 1,
            .interpolation_uniform_id = drawable_uniform_id,
            .interpolation_uniform_byte_offset = @offsetOf(DrawableUBO, "interpolation") + i * @sizeOf(f32),
        };
    }
    break :blk result;
};

// ---------------------------------------------------------------------------
// The registered catalog. A process holds one: the host registers one
// descriptor per plugin id and layer type, and the render and layout
// callbacks, which get no layer identity, read it through `active`.
// ---------------------------------------------------------------------------

/// A registered catalog and what the callbacks precompute from it. The
/// catalog is a view of `bytes`, the plugin's copy of the file followed by
/// the zero texels that pad it to the texture's size: the texel section ends
/// the file, so the texture data is `bytes[texels_offset..]`.
const Active = struct {
    bytes: []u8,
    file_size: usize,
    catalog: catalog.Catalog,
    /// IconCatalogUBO with the clock at 0.
    header_block: []u8,
    /// The entries' names and placement geometry, by enum index; entry 0 is
    /// none.
    entries: EntryTable,
    /// The largest entry radius at icon-size 1, the layout's query radius.
    max_entry_radius: f32,

    fn create(bytes: []const u8, diagnostic: *catalog.Diagnostic) (catalog.ParseError)!*Active {
        const gpa = std.heap.c_allocator;
        // Validate the caller's bytes first: that sizes the retained copy.
        const probe = try catalog.Catalog.parse(gpa, bytes, diagnostic);
        const padded = probe.texels_offset + probe.textureBytes();
        std.debug.assert(padded >= bytes.len);
        const copy = try gpa.alloc(u8, padded);
        errdefer gpa.free(copy);
        @memcpy(copy[0..bytes.len], bytes);
        @memset(copy[bytes.len..], 0);
        // The same bytes parsed a moment ago, now in the plugin's copy.
        const parsed = try catalog.Catalog.parse(gpa, copy[0..bytes.len], diagnostic);
        const header_block = try gpa.alloc(u8, parsed.headerBlockSize());
        errdefer gpa.free(header_block);
        parsed.writeHeaderBlock(0, header_block);
        var entries = try EntryTable.fromCatalog(gpa, parsed);
        errdefer entries.deinit(gpa);
        const self = try gpa.create(Active);
        self.* = .{
            .bytes = copy,
            .file_size = bytes.len,
            .catalog = parsed,
            .header_block = header_block,
            .entries = entries,
            .max_entry_radius = @floatCast(entries.maxRadius(0, entries.names.len)),
        };
        return self;
    }

    fn destroy(self: *Active) void {
        const gpa = std.heap.c_allocator;
        gpa.free(self.bytes);
        gpa.free(self.header_block);
        self.entries.deinit(gpa);
        gpa.destroy(self);
    }

    /// The texture data the texture descriptor points to: W·H texels.
    fn texture(self: *const Active) []const u8 {
        return self.bytes[self.catalog.texels_offset..][0..self.catalog.textureBytes()];
    }
};

/// Entry names and placement geometry by enum index (0 is none), for hit
/// testing and the query radius.
const EntryTable = struct {
    names: []const []const u8,
    entries: []const place.Entry,
    /// place.entryRadius of each entry; 0 for none.
    radii: []const f64,

    fn fromCatalog(gpa: std.mem.Allocator, cat: catalog.Catalog) std.mem.Allocator.Error!EntryTable {
        const count = cat.entryCount();
        const names = try gpa.alloc([]const u8, count);
        errdefer gpa.free(names);
        const entries = try gpa.alloc(place.Entry, count);
        errdefer gpa.free(entries);
        const radii = try gpa.alloc(f64, count);
        names[0] = "none";
        entries[0] = .{ .box = .{ 0, 0, 1, 1 }, .display_px = 0 };
        radii[0] = 0;
        for (1..count) |i| {
            const a = cat.animation(@intCast(i - 1));
            names[i] = a.name;
            entries[i] = .{ .box = .{ a.box[0], a.box[1], a.box[2], a.box[3] }, .display_px = a.display_px };
            radii[i] = place.entryRadius(entries[i]);
        }
        return .{ .names = names, .entries = entries, .radii = radii };
    }

    fn deinit(self: *EntryTable, gpa: std.mem.Allocator) void {
        gpa.free(self.names);
        gpa.free(self.entries);
        gpa.free(self.radii);
    }

    /// The enum index of an animation name; 0 (none) when the name is
    /// unknown, which is how the shader draws it too.
    fn index(self: EntryTable, name: []const u8) u32 {
        for (self.names[1..], 1..) |candidate, i| {
            if (std.mem.eql(u8, candidate, name)) return @intCast(i);
        }
        return 0;
    }

    /// The enum index of a string value: 0 for none, null for a name the
    /// catalog lacks or a value that is not a string.
    fn rangeIndex(self: EntryTable, value: c.mln_plugin_value) ?u32 {
        if (value.type != c.MLN_PLUGIN_VALUE_STRING) return null;
        const name = slice(value.data.string_value);
        if (std.mem.eql(u8, name, "none")) return 0;
        const i = self.index(name);
        return if (i == 0) null else i;
    }

    /// The largest radius among entries first..end (clamped to the table).
    fn maxRadius(self: EntryTable, first: usize, end: usize) f64 {
        var result: f64 = 0;
        for (self.radii[@min(first, self.radii.len)..@min(end, self.radii.len)]) |r| result = @max(result, r);
        return result;
    }
};

var active: std.atomic.Value(?*Active) = .init(null);

/// Serialises the entry points. Registration is rare and short, so a spin
/// lock does; std's mutexes want an Io the plugin does not have.
var registration_lock: std.atomic.Mutex = .unlocked;

fn lockRegistration() void {
    while (!registration_lock.tryLock()) std.atomic.spinLoopHint();
}

// ---------------------------------------------------------------------------
// Registration. The descriptors are built from the catalog; the host copies
// them during the register call (the texture bytes included), so they are
// freed after it.
// ---------------------------------------------------------------------------

const Registration = struct {
    properties: [properties.len]c.mln_plugin_property_descriptor_v1,
    sources: [3]c.mln_plugin_shader_source_v1,
    uniform_blocks: [2]c.mln_plugin_uniform_block_descriptor_v1,
    textures: [1]c.mln_plugin_texture_descriptor_v1,
    shaders: [1]c.mln_plugin_shader_descriptor_v1,
    layer_type: c.mln_plugin_layer_type_v1,
    descriptor: c.mln_plugin_descriptor_v1,

    /// Fills `self` in place, since its descriptors point into each other.
    /// Strings and arrays go to `arena`, which must outlive the register
    /// call. `texture` is the texture data: the catalog's texels padded with
    /// zeros to W·H texels.
    fn init(self: *Registration, arena: std.mem.Allocator, cat: catalog.Catalog, texture: []const u8) std.mem.Allocator.Error!void {
        std.debug.assert(texture.len == cat.textureBytes());
        const names = try cat.enumValues(arena);
        const animation_values = try arena.alloc(c.mln_plugin_string, names.len);
        for (names, animation_values) |name, *v| v.* = str(name);
        self.properties = propertyDescriptors(animation_values);

        const defines = try cat.shaderDefines(arena);
        const source_size = @sizeOf(c.mln_plugin_shader_source_v1);
        self.sources = .{
            .{
                .struct_size = source_size,
                .backend = c.MLN_PLUGIN_BACKEND_OPENGL,
                .vertex_source = str(try std.mem.concat(arena, u8, &.{ defines, comptime glslVertex(false) })),
                .fragment_source = str(try std.mem.concat(arena, u8, &.{ defines, comptime glslFragment(false) })),
            },
            .{
                .struct_size = source_size,
                .backend = c.MLN_PLUGIN_BACKEND_VULKAN,
                .vertex_source = str(try std.mem.concat(arena, u8, &.{ defines, comptime glslVertex(true) })),
                .fragment_source = str(try std.mem.concat(arena, u8, &.{ defines, comptime glslFragment(true) })),
            },
            .{
                .struct_size = source_size,
                .backend = c.MLN_PLUGIN_BACKEND_METAL,
                .vertex_source = str(try std.mem.concat(arena, u8, &.{ defines, metal_source })),
                .vertex_entry_point = str("iconVertex"),
                .fragment_entry_point = str("iconFragment"),
            },
        };
        self.uniform_blocks = .{
            .{
                .struct_size = @sizeOf(c.mln_plugin_uniform_block_descriptor_v1),
                .uniform_id = drawable_uniform_id,
                .name = str("IconDrawableUBO"),
                .byte_size = @sizeOf(DrawableUBO),
                .stage_mask = c.MLN_PLUGIN_SHADER_STAGE_VERTEX,
                .scope = c.MLN_PLUGIN_UNIFORM_DRAWABLE,
            },
            // Both stages, so it takes a stage slot of its own next to the
            // vertex-only block; only the vertex shader declares it.
            .{
                .struct_size = @sizeOf(c.mln_plugin_uniform_block_descriptor_v1),
                .uniform_id = catalog_uniform_id,
                .name = str("IconCatalogUBO"),
                .byte_size = @intCast(cat.headerBlockSize()),
                .stage_mask = c.MLN_PLUGIN_SHADER_STAGE_VERTEX | c.MLN_PLUGIN_SHADER_STAGE_FRAGMENT,
                .scope = c.MLN_PLUGIN_UNIFORM_LAYER,
            },
        };
        self.textures = .{.{
            .struct_size = @sizeOf(c.mln_plugin_texture_descriptor_v1),
            .texture_id = 0,
            .name = str("u_art"),
            .format = c.MLN_PLUGIN_TEXTURE_RGBA32F,
            .width = cat.texture_width,
            .height = cat.texture_height,
            .data = texture.ptr,
            .data_size = texture.len,
        }};
        self.shaders = .{.{
            .struct_size = @sizeOf(c.mln_plugin_shader_descriptor_v1),
            .shader_id = str("icon"),
            .sources = &self.sources,
            .source_count = self.sources.len,
            .attributes = &attributes,
            .attribute_count = attributes.len,
            .uniform_blocks = &self.uniform_blocks,
            .uniform_block_count = self.uniform_blocks.len,
            .property_bindings = &property_bindings,
            .property_binding_count = property_bindings.len,
            .textures = &self.textures,
            .texture_count = self.textures.len,
        }};
        self.layer_type = .{
            .struct_size = @sizeOf(c.mln_plugin_layer_type_v1),
            .layer_type = str(layer_type_name),
            .backend_mask = c.MLN_PLUGIN_BACKEND_OPENGL | c.MLN_PLUGIN_BACKEND_VULKAN | c.MLN_PLUGIN_BACKEND_METAL,
            .properties = &self.properties,
            .property_count = self.properties.len,
            .geometry_type_mask = c.MLN_PLUGIN_GEOMETRY_POINT,
            .shaders = &self.shaders,
            .shader_count = self.shaders.len,
            .create_layout = createLayout,
            .layout_feature = layoutFeature,
            .finish_layout = finishLayout,
            .destroy_layout = destroyLayout,
            .query_feature = queryFeature,
            .update_uniform_block = updateUniformBlock,
            .get_query_radius = getQueryRadius,
            .should_animate = shouldAnimate,
            .source_free = 0,
            .build_frame = null,
        };
        self.descriptor = .{
            .struct_size = @sizeOf(c.mln_plugin_descriptor_v1),
            .abi_version = c.MLN_PLUGIN_ABI_VERSION_1,
            .plugin_id = str(plugin_id),
            .plugin_version = str(plugin_version),
            .minimum_host_abi = c.MLN_PLUGIN_ABI_VERSION_1,
            .maximum_host_abi = c.MLN_PLUGIN_ABI_VERSION_1,
            .layer_types = &self.layer_type,
            .layer_type_count = 1,
        };
    }
};

fn writeError(buffer: [*c]u8, capacity: usize, message: []const u8) void {
    if (buffer == null or capacity == 0) return;
    const count = @min(message.len, capacity - 1);
    @memcpy(buffer[0..count], message[0..count]);
    buffer[count] = 0;
}

/// Builds the descriptors of `current` and hands them to the host.
fn registerActive(current: *const Active, register_fn: *const fn ([*c]const c.mln_plugin_descriptor_v1, [*c]u8, usize) callconv(.c) c.mln_plugin_status, error_message: [*c]u8, error_message_capacity: usize) c.mln_plugin_status {
    var arena = std.heap.ArenaAllocator.init(std.heap.c_allocator);
    defer arena.deinit();
    const registration = arena.allocator().create(Registration) catch return outOfMemory(error_message, error_message_capacity);
    registration.init(arena.allocator(), current.catalog, current.texture()) catch return outOfMemory(error_message, error_message_capacity);
    return register_fn(&registration.descriptor, error_message, error_message_capacity);
}

fn outOfMemory(error_message: [*c]u8, error_message_capacity: usize) c.mln_plugin_status {
    writeError(error_message, error_message_capacity, "animated-icon: out of memory while building the descriptors");
    return c.MLN_PLUGIN_STATUS_CALLBACK_ERROR;
}

fn registerCatalog(register_fn: c.mln_plugin_register_function_v1, bytes: []const u8, error_message: [*c]u8, error_message_capacity: usize) c.mln_plugin_status {
    const register_impl = register_fn orelse {
        writeError(error_message, error_message_capacity, "animated-icon: register_fn is null");
        return c.MLN_PLUGIN_STATUS_INVALID_ARGUMENT;
    };
    lockRegistration();
    defer registration_lock.unlock();
    if (active.load(.acquire)) |current| {
        // Equal bytes build the same descriptors, which the host reports as
        // ALREADY_REGISTERED; the host keeps one descriptor per layer type.
        if (!std.mem.eql(u8, current.bytes[0..current.file_size], bytes)) {
            writeError(error_message, error_message_capacity, "animated-icon: a different catalog is already registered in this process");
            return c.MLN_PLUGIN_STATUS_CONFLICT;
        }
        return registerActive(current, register_impl, error_message, error_message_capacity);
    }
    var diagnostic: catalog.Diagnostic = .{};
    const created = Active.create(bytes, &diagnostic) catch |err| switch (err) {
        error.InvalidCatalog => {
            var buffer: [320]u8 = undefined;
            const message = std.fmt.bufPrint(&buffer, "animated-icon catalog: {s}", .{diagnostic.message()}) catch &buffer;
            writeError(error_message, error_message_capacity, message);
            return c.MLN_PLUGIN_STATUS_INVALID_ARGUMENT;
        },
        error.OutOfMemory => return outOfMemory(error_message, error_message_capacity),
    };
    // Callbacks may run as soon as the host publishes the layer type, so the
    // catalog is published first.
    active.store(created, .release);
    const status = registerActive(created, register_impl, error_message, error_message_capacity);
    if (status != c.MLN_PLUGIN_STATUS_OK and status != c.MLN_PLUGIN_STATUS_ALREADY_REGISTERED) {
        active.store(null, .release);
        created.destroy();
    }
    return status;
}

/// The plugin's entry point for the embedded demo catalog. The host resolves
/// this symbol from the shared library and passes its own register
/// function, so the plugin binary never links maplibre-native-c.
export fn mln_animated_icon_register(
    register_fn: c.mln_plugin_register_function_v1,
    error_message: [*c]u8,
    error_message_capacity: usize,
) c.mln_plugin_status {
    return registerCatalog(register_fn, build_options.catalog_mlvc, error_message, error_message_capacity);
}

/// The entry point for an app's catalog: `catalog_size` bytes of a `.mlvc`
/// version 2 file, borrowed for the call; the plugin keeps a copy for the
/// process. A process holds one catalog: call this instead of
/// mln_animated_icon_register, not after it.
export fn mln_animated_icon_register_catalog(
    register_fn: c.mln_plugin_register_function_v1,
    catalog_bytes: [*c]const u8,
    catalog_size: usize,
    error_message: [*c]u8,
    error_message_capacity: usize,
) c.mln_plugin_status {
    if (catalog_bytes == null and catalog_size != 0) {
        writeError(error_message, error_message_capacity, "animated-icon: catalog is null");
        return c.MLN_PLUGIN_STATUS_INVALID_ARGUMENT;
    }
    const bytes: []const u8 = if (catalog_size == 0) &.{} else catalog_bytes[0..catalog_size];
    return registerCatalog(register_fn, bytes, error_message, error_message_capacity);
}

// ---------------------------------------------------------------------------
// The clock. Tile-driven layers get no timestamp from the host, so the
// plugin reads a monotonic clock, counted from its first reading and wrapped
// at 4096 s so an f32 keeps millisecond steps (FORMAT.md, "Timing"). Apps
// read the same clock to restart icons, and tests pin it.
// ---------------------------------------------------------------------------

/// Seconds from a monotonic clock.
fn monotonicSeconds() f64 {
    if (builtin.os.tag == .windows) {
        const windows = std.os.windows;
        var counter: windows.LARGE_INTEGER = 0;
        var frequency: windows.LARGE_INTEGER = 1;
        _ = windows.kernel32.QueryPerformanceCounter(&counter);
        _ = windows.kernel32.QueryPerformanceFrequency(&frequency);
        return @as(f64, @floatFromInt(counter)) / @as(f64, @floatFromInt(frequency));
    }
    var ts: std.c.timespec = undefined;
    if (std.c.clock_gettime(.MONOTONIC, &ts) != 0) return 0;
    return @as(f64, @floatFromInt(ts.sec)) + @as(f64, @floatFromInt(ts.nsec)) / 1e9;
}

/// Bits of an f64 no clock value takes (a NaN): the origin before the first
/// reading, and the pin when the clock is live.
const unset_bits: u64 = std.math.maxInt(u64);
var clock_origin: std.atomic.Value(u64) = .init(unset_bits);
var clock_pin: std.atomic.Value(u64) = .init(unset_bits);

/// The animation clock: seconds in [0, 4096) since the first reading, or the
/// pinned value.
fn clockSeconds() f64 {
    const pin = clock_pin.load(.acquire);
    if (pin != unset_bits) return @bitCast(pin);
    const now = monotonicSeconds();
    var origin = clock_origin.load(.acquire);
    if (origin == unset_bits) {
        origin = clock_origin.cmpxchgStrong(unset_bits, @bitCast(now), .acq_rel, .acquire) orelse @bitCast(now);
    }
    return catalog.wrapClock(now - @as(f64, @bitCast(origin)));
}

/// The clock as IconCatalogUBO stores it: an f32 below 4096, so a value that
/// rounds up to the period wraps to 0.
fn blockClock(seconds: f64) f32 {
    const value: f32 = @floatCast(seconds);
    return if (value >= catalog.clock_period) 0 else value;
}

/// The animation clock the plugin writes into IconCatalogUBO: seconds in
/// [0, 4096), monotonic since the plugin's first clock read, wrapped.
/// Subtract it from later readings (for example as a feature-state "start")
/// to restart animations. Thread-safe.
export fn mln_animated_icon_clock_seconds() f64 {
    return clockSeconds();
}

/// Pins the clock at the wrapped value of `seconds` when it is finite; NaN
/// (or any non-finite value) restores the live clock. For deterministic
/// renders: tests and screenshots. Thread-safe.
export fn mln_animated_icon_set_clock(seconds: f64) void {
    if (std.math.isFinite(seconds)) {
        clock_pin.store(@bitCast(catalog.wrapClock(seconds)), .release);
    } else {
        clock_pin.store(unset_bits, .release);
    }
}

/// Test-only: unpublishes and frees the registered catalog, unpins the clock
/// and forgets its origin, so tests of the entry points and the clock are
/// independent of their order. Never exported: the host keeps callbacks that
/// read the catalog for the process.
pub fn resetForTesting() void {
    lockRegistration();
    defer registration_lock.unlock();
    if (active.swap(null, .acq_rel)) |current| current.destroy();
    clock_pin.store(unset_bits, .release);
    clock_origin.store(unset_bits, .release);
}

// ---------------------------------------------------------------------------
// Layout callbacks (tile workers).
// ---------------------------------------------------------------------------

const attribute_bindings = [_]c.mln_plugin_attribute_binding_v1{
    .{ .struct_size = @sizeOf(c.mln_plugin_attribute_binding_v1), .attribute_id = 0, .stream_id = 0, .byte_offset = @offsetOf(layout.Vertex, "x") },
};

/// One tile's layout: the geometry builder plus the C views handed back to
/// the host in finish_layout, which must outlive the callback until destroy.
const TileLayout = struct {
    geometry: layout.Layout,
    points: std.ArrayList(layout.Point) = .empty,
    segments: std.ArrayList(c.mln_plugin_segment_v1) = .empty,
    ranges: std.ArrayList(c.mln_plugin_feature_vertex_range_v1) = .empty,
    stream: c.mln_plugin_vertex_stream_v1 = undefined,
    drawable: c.mln_plugin_drawable_descriptor_v1 = undefined,

    fn deinit(self: *TileLayout) void {
        const a = self.geometry.allocator;
        self.geometry.deinit();
        self.points.deinit(a);
        self.segments.deinit(a);
        self.ranges.deinit(a);
    }
};

const allocator = std.heap.c_allocator;

fn createLayout(context: [*c]const c.mln_plugin_layout_context_v1, instance: [*c]?*anyopaque) callconv(.c) c.mln_plugin_status {
    if (context == null or instance == null or context.*.struct_size < @sizeOf(c.mln_plugin_layout_context_v1) or context.*.extent == 0) return c.MLN_PLUGIN_STATUS_INVALID_ARGUMENT;
    const tile = allocator.create(TileLayout) catch return c.MLN_PLUGIN_STATUS_CALLBACK_ERROR;
    tile.* = .{ .geometry = layout.Layout.init(allocator, context.*.extent) };
    instance.* = tile;
    return c.MLN_PLUGIN_STATUS_OK;
}

fn layoutFeature(instance: ?*anyopaque, feature: [*c]const c.mln_plugin_feature_v1) callconv(.c) c.mln_plugin_status {
    const tile: *TileLayout = @ptrCast(@alignCast(instance orelse return c.MLN_PLUGIN_STATUS_INVALID_ARGUMENT));
    if (feature == null or feature.*.struct_size < @sizeOf(c.mln_plugin_feature_v1)) return c.MLN_PLUGIN_STATUS_INVALID_ARGUMENT;
    const f = feature.*;
    if (f.geometry_type != c.MLN_PLUGIN_GEOMETRY_POINT or f.point_count == 0) return c.MLN_PLUGIN_STATUS_OK;
    if (f.points == null) return c.MLN_PLUGIN_STATUS_INVALID_ARGUMENT;
    // A MultiPoint arrives as one path per point; every point is an anchor.
    tile.points.clearRetainingCapacity();
    tile.points.ensureTotalCapacity(allocator, f.point_count) catch return c.MLN_PLUGIN_STATUS_CALLBACK_ERROR;
    for (f.points[0..f.point_count]) |p| tile.points.appendAssumeCapacity(.{ .x = p.x, .y = p.y });
    tile.geometry.addPoints(tile.points.items, f.feature_index) catch return c.MLN_PLUGIN_STATUS_CALLBACK_ERROR;
    return c.MLN_PLUGIN_STATUS_OK;
}

fn finishLayout(instance: ?*anyopaque, bucket: [*c]c.mln_plugin_bucket_v1) callconv(.c) c.mln_plugin_status {
    const tile: *TileLayout = @ptrCast(@alignCast(instance orelse return c.MLN_PLUGIN_STATUS_INVALID_ARGUMENT));
    if (bucket == null or bucket.*.struct_size < @sizeOf(c.mln_plugin_bucket_v1)) return c.MLN_PLUGIN_STATUS_INVALID_ARGUMENT;
    const geometry = &tile.geometry;
    geometry.finish() catch return c.MLN_PLUGIN_STATUS_CALLBACK_ERROR;
    tile.segments.clearRetainingCapacity();
    tile.ranges.clearRetainingCapacity();
    for (geometry.segments.items) |segment| {
        tile.segments.append(allocator, .{ .struct_size = @sizeOf(c.mln_plugin_segment_v1), .vertex_offset = segment.vertex_offset, .index_offset = segment.index_offset, .vertex_length = segment.vertex_length, .index_length = segment.index_length }) catch return c.MLN_PLUGIN_STATUS_CALLBACK_ERROR;
    }
    for (geometry.ranges.items) |range| {
        tile.ranges.append(allocator, .{ .struct_size = @sizeOf(c.mln_plugin_feature_vertex_range_v1), .feature_index = range.feature_index, .drawable_key = 1, .first_vertex = range.first_vertex, .vertex_count = range.vertex_count }) catch return c.MLN_PLUGIN_STATUS_CALLBACK_ERROR;
    }
    const vertices = geometry.vertices.items;
    tile.stream = .{ .struct_size = @sizeOf(c.mln_plugin_vertex_stream_v1), .stream_id = 0, .data = @ptrCast(vertices.ptr), .data_size = vertices.len * @sizeOf(layout.Vertex), .vertex_count = @intCast(vertices.len), .stride = @sizeOf(layout.Vertex) };
    tile.drawable = .{ .struct_size = @sizeOf(c.mln_plugin_drawable_descriptor_v1), .drawable_key = 1, .shader_id = str("icon"), .attributes = &attribute_bindings, .attribute_count = attribute_bindings.len, .segments = tile.segments.items.ptr, .segment_count = tile.segments.items.len };
    const empty = vertices.len == 0;
    // get_query_radius replaces this once the host has paint values.
    const query_radius: f32 = if (active.load(.acquire)) |current| current.max_entry_radius else 0;
    bucket.* = .{
        .struct_size = @sizeOf(c.mln_plugin_bucket_v1),
        .vertex_streams = if (empty) null else &tile.stream,
        .vertex_stream_count = if (empty) 0 else 1,
        .indices = geometry.indices.items.ptr,
        .index_count = if (empty) 0 else geometry.indices.items.len,
        .drawables = if (empty) null else &tile.drawable,
        .drawable_count = if (empty) 0 else 1,
        .query_radius = query_radius,
        .feature_vertex_ranges = if (empty) null else tile.ranges.items.ptr,
        .feature_vertex_range_count = if (empty) 0 else tile.ranges.items.len,
    };
    return c.MLN_PLUGIN_STATUS_OK;
}

fn destroyLayout(instance: ?*anyopaque) callconv(.c) void {
    const tile: *TileLayout = @ptrCast(@alignCast(instance orelse return));
    tile.deinit();
    allocator.destroy(tile);
}

// ---------------------------------------------------------------------------
// Render-thread callbacks.
// ---------------------------------------------------------------------------

fn updateUniformBlock(context: [*c]const c.mln_plugin_uniform_context_v1, uniform_id: u32, output: [*c]u8, output_size: usize) callconv(.c) c.mln_plugin_status {
    if (context == null or context.*.struct_size < @sizeOf(c.mln_plugin_uniform_context_v1) or output == null) return c.MLN_PLUGIN_STATUS_INVALID_ARGUMENT;
    const ctx = context.*;
    switch (uniform_id) {
        drawable_uniform_id => {
            if (output_size != @sizeOf(DrawableUBO)) return c.MLN_PLUGIN_STATUS_INVALID_ARGUMENT;
            var block = std.mem.zeroes(DrawableUBO);
            block.matrix = ctx.tile_matrix;
            block.camera = .{ ctx.pixels_to_gl_units[0], ctx.pixels_to_gl_units[1], ctx.pixels_to_tile_units, ctx.camera_to_center_distance };
            block.view = .{ ctx.pixel_ratio, @floatCast(ctx.bearing), 0, 0 };
            @memcpy(output[0..output_size], std.mem.asBytes(&block));
        },
        catalog_uniform_id => {
            const current = active.load(.acquire) orelse return c.MLN_PLUGIN_STATUS_CALLBACK_ERROR;
            if (output_size != current.header_block.len) return c.MLN_PLUGIN_STATUS_INVALID_ARGUMENT;
            @memcpy(output[0..output_size], current.header_block);
            std.mem.writeInt(u32, output[0..4], @bitCast(blockClock(clockSeconds())), .little);
        },
        else => return c.MLN_PLUGIN_STATUS_INVALID_ARGUMENT,
    }
    return c.MLN_PLUGIN_STATUS_OK;
}

fn findValue(props: []const c.mln_plugin_property_value_v1, name: []const u8) ?*const c.mln_plugin_property_value_v1 {
    for (props) |*property| {
        if (property.struct_size >= @sizeOf(c.mln_plugin_property_value_v1) and std.mem.eql(u8, slice(property.name), name)) return property;
    }
    return null;
}

fn floatValue(props: []const c.mln_plugin_property_value_v1, comptime name: []const u8) f64 {
    const default = comptime properties[propertyIndex(name)].default[0];
    const property = findValue(props, name) orelse return default;
    const v = property.value;
    if (v.type != c.MLN_PLUGIN_VALUE_FLOAT and v.type != c.MLN_PLUGIN_VALUE_ROTATION) return default;
    return v.data.float_value;
}

/// An enum value's index in `values`, or `default` when it is missing or
/// unknown: the host passes enum values as raw strings, unchecked.
fn enumValue(props: []const c.mln_plugin_property_value_v1, name: []const u8, values: []const []const u8) u32 {
    const property = findValue(props, name) orelse return 0;
    if (property.value.type != c.MLN_PLUGIN_VALUE_STRING) return 0;
    return place.enumIndex(values, slice(property.value.data.string_value));
}

/// The paint values of one feature, as the host evaluated them for a query.
fn resolve(props: []const c.mln_plugin_property_value_v1, entries: EntryTable) place.Resolved {
    const animation = if (findValue(props, "icon-animation")) |p|
        (if (p.value.type == c.MLN_PLUGIN_VALUE_STRING) entries.index(slice(p.value.data.string_value)) else 0)
    else
        0;
    var offset = [2]f64{ 0, 0 };
    if (findValue(props, "icon-offset")) |p| {
        if (p.value.type == c.MLN_PLUGIN_VALUE_FLOAT2) offset = .{ p.value.data.float2_value.x, p.value.data.float2_value.y };
    }
    return .{
        .animation = animation,
        .size = floatValue(props, "icon-size"),
        .rotate = floatValue(props, "icon-rotate"),
        .opacity = floatValue(props, "icon-opacity"),
        .offset = offset,
        .anchor = enumValue(props, "icon-anchor", &place.anchor_values),
        .rotation_alignment = enumValue(props, "icon-rotation-alignment", &place.alignment_values),
        .pitch_alignment = enumValue(props, "icon-pitch-alignment", &place.alignment_values),
    };
}

/// Tile units of the host's tile coordinates.
const tile_extent = 8192;

/// Whether the query geometry hits the feature's icons. Everything arrives
/// evaluated: camera values transitioned at the render zoom, data-driven
/// values at the tile's zoom with the feature's state.
fn queryHit(feature: c.mln_plugin_feature_v1, query: []const c.mln_plugin_tile_point_v1, ctx: c.mln_plugin_query_context_v1, props: []const c.mln_plugin_property_value_v1, entries: EntryTable) bool {
    const resolved = resolve(props, entries);
    if (resolved.animation == 0 or !(resolved.size > 0) or !(resolved.opacity > 0)) return false;
    if (query.len == 0 or feature.points == null or feature.point_count == 0) return false;
    const view = place.View{
        .matrix = ctx.tile_matrix,
        .viewport = .{ @floatFromInt(ctx.viewport_width), @floatFromInt(ctx.viewport_height) },
        .pixel_ratio = 1,
        .camera_to_center_distance = ctx.camera_to_center_distance,
        .pixels_to_tile_units = ctx.pixels_to_tile_units,
        .bearing = ctx.bearing,
    };
    // The query geometry on the screen; points behind the camera drop out.
    var stack: [16][2]f64 = undefined;
    const buffer = if (query.len <= stack.len) stack[0..query.len] else allocator.alloc([2]f64, query.len) catch return false;
    defer if (query.len > stack.len) allocator.free(buffer);
    var count: usize = 0;
    for (query) |q| {
        buffer[count] = place.project(view, .{ @floatFromInt(q.x), @floatFromInt(q.y) }) orelse continue;
        count += 1;
    }
    const polygon = buffer[0..count];
    if (polygon.len == 0) return false;
    const entry = entries.entries[resolved.animation];
    for (feature.points[0..feature.point_count]) |point| {
        // The layout's anchor ownership: a tile draws only its own points.
        if (point.x < 0 or point.y < 0 or point.x >= tile_extent or point.y >= tile_extent) continue;
        const quad = place.corners(.{ @floatFromInt(point.x), @floatFromInt(point.y) }, resolved, entry, view) orelse continue;
        const hit = if (query.len == 1) place.hitPoint(quad, polygon[0]) else place.hitPolygon(quad, polygon);
        if (hit) return true;
    }
    return false;
}

fn queryFeature(
    feature: [*c]const c.mln_plugin_feature_v1,
    query: [*c]const c.mln_plugin_tile_point_v1,
    query_count: usize,
    context: [*c]const c.mln_plugin_query_context_v1,
    props: [*c]const c.mln_plugin_property_value_v1,
    prop_count: usize,
) callconv(.c) u8 {
    if (feature == null or feature.*.struct_size < @sizeOf(c.mln_plugin_feature_v1)) return 0;
    if (context == null or context.*.struct_size < @sizeOf(c.mln_plugin_query_context_v1)) return 0;
    if (query == null or query_count == 0 or props == null) return 0;
    const current = active.load(.acquire) orelse return 0;
    return @intFromBool(queryHit(feature.*, query[0..query_count], context.*, props[0..prop_count], current.entries));
}

fn findStatistics(stats: []const c.mln_plugin_property_statistics_v1, name: []const u8) ?*const c.mln_plugin_property_statistics_v1 {
    for (stats) |*s| {
        if (s.struct_size >= @sizeOf(c.mln_plugin_property_statistics_v1) and std.mem.eql(u8, slice(s.property_name), name)) return s;
    }
    return null;
}

/// The screen radius around an anchor that holds its icon, in logical
/// pixels: twice the largest size times the reach of the largest possible
/// entry plus the offset, plus 2 px. Data-driven properties give their
/// statistics (for icon-animation, the names at the lowest and highest enum
/// index), the others their camera values.
fn queryRadius(stats: []const c.mln_plugin_property_statistics_v1, camera: []const c.mln_plugin_property_value_v1, entries: EntryTable) f32 {
    var max_size: f64 = floatValue(camera, "icon-size");
    if (findStatistics(stats, "icon-size")) |s| max_size = if (s.maximum.type == c.MLN_PLUGIN_VALUE_FLOAT) s.maximum.data.float_value else std.math.nan(f64);
    // Nothing is drawn: no size, a zero one, or NaN (NaN > 0 is false).
    if (!(max_size > 0)) return 0;

    // The entries between the lowest and highest enum index; a name the
    // catalog lacks (never sent by the host) opens the whole range.
    var first: ?u32 = 0;
    var last: ?u32 = 0;
    if (findStatistics(stats, "icon-animation")) |s| {
        first = entries.rangeIndex(s.minimum);
        last = entries.rangeIndex(s.maximum);
    } else if (findValue(camera, "icon-animation")) |p| {
        first = entries.rangeIndex(p.value);
        last = first;
    }
    const reach = if (first == null or last == null)
        entries.maxRadius(0, entries.names.len)
    else
        entries.maxRadius(@min(first.?, last.?), @as(usize, @max(first.?, last.?)) + 1);

    var offset = [2]f64{ 0, 0 };
    if (findStatistics(stats, "icon-offset")) |s| {
        if (s.minimum.type == c.MLN_PLUGIN_VALUE_FLOAT2 and s.maximum.type == c.MLN_PLUGIN_VALUE_FLOAT2) {
            offset = .{
                @max(@abs(s.minimum.data.float2_value.x), @abs(s.maximum.data.float2_value.x)),
                @max(@abs(s.minimum.data.float2_value.y), @abs(s.maximum.data.float2_value.y)),
            };
        }
    } else if (findValue(camera, "icon-offset")) |p| {
        if (p.value.type == c.MLN_PLUGIN_VALUE_FLOAT2) offset = .{ @abs(p.value.data.float2_value.x), @abs(p.value.data.float2_value.y) };
    }
    const radius = 2 * max_size * (reach + std.math.hypot(offset[0], offset[1])) + 2;
    // An infinite size or offset, or one past f32, means some icon reaches
    // arbitrarily far. 0 would hide every other icon of the tile from the
    // host's grid query, and the host discards a non-finite radius, so give
    // the largest finite one: the host caps the padding at one tile extent
    // (FeatureIndex::query). NaN (inf * 0) takes the cap too.
    const cap: f32 = std.math.floatMax(f32);
    return if (radius <= cap) @floatCast(radius) else cap;
}

fn getQueryRadius(
    statistics: [*c]const c.mln_plugin_property_statistics_v1,
    statistics_count: usize,
    camera_properties: [*c]const c.mln_plugin_property_value_v1,
    camera_property_count: usize,
) callconv(.c) f32 {
    const current = active.load(.acquire) orelse return 0;
    const stats: []const c.mln_plugin_property_statistics_v1 = if (statistics == null) &.{} else statistics[0..statistics_count];
    const camera: []const c.mln_plugin_property_value_v1 = if (camera_properties == null) &.{} else camera_properties[0..camera_property_count];
    return queryRadius(stats, camera, current.entries);
}

/// Whether the map keeps repainting for this layer: whenever it sets
/// icon-animation at all. The host evaluates data-driven values without a
/// feature here, which yields their defaults ("none", or a hover-gated
/// speed of 0), and the plugin cannot tell those from constants, so no other
/// value is a safe reason to stop (README limit 5).
fn shouldAnimate(props: [*c]const c.mln_plugin_property_value_v1, count: usize) callconv(.c) u8 {
    if (props == null or count == 0) return 0;
    const animation = findValue(props[0..count], "icon-animation") orelse return 0;
    return @intFromBool(animation.explicitly_set != 0);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

test {
    _ = layout;
    _ = place;
}

const demo_bytes = build_options.catalog_mlvc;

fn parseForTest(bytes: []const u8) !catalog.Catalog {
    var diagnostic: catalog.Diagnostic = .{};
    return catalog.Catalog.parse(std.testing.allocator, bytes, &diagnostic) catch |err| {
        std.debug.print("catalog: {s}\n", .{diagnostic.message()});
        return err;
    };
}

/// The texture data of a parsed catalog: its texels padded with zeros.
fn paddedTexture(arena: std.mem.Allocator, cat: catalog.Catalog) ![]u8 {
    const texture = try arena.alloc(u8, cat.textureBytes());
    const texels = cat.texelBytes();
    @memcpy(texture[0..texels.len], texels);
    @memset(texture[texels.len..], 0);
    return texture;
}

/// Builds the registration the entry points would hand the host for a
/// catalog, without registering it.
fn testRegistration(arena: *std.heap.ArenaAllocator, cat: catalog.Catalog) !*Registration {
    const registration = try arena.allocator().create(Registration);
    try registration.init(arena.allocator(), cat, try paddedTexture(arena.allocator(), cat));
    return registration;
}

/// A catalog fixture's bytes by file name.
fn catalogFixture(name: []const u8) []const u8 {
    const fixtures = @import("catalog_fixtures");
    for (fixtures.names, fixtures.files) |n, bytes| {
        if (std.mem.eql(u8, n, name)) return bytes;
    }
    std.debug.panic("no catalog fixture {s}", .{name});
}

fn jsonNumber(v: std.json.Value) f64 {
    return place.Fixture.number(v);
}

test "the embedded demo catalog parses at run time" {
    const cat = try parseForTest(demo_bytes);
    const values = try cat.enumValues(std.testing.allocator);
    defer std.testing.allocator.free(values);
    try std.testing.expectEqualStrings("none", values[0]);
    try std.testing.expectEqualStrings("pulse", values[1]);
    try std.testing.expectEqualStrings("pin", values[2]);
}

test "descriptors match the shared spec" {
    var arena = std.heap.ArenaAllocator.init(std.testing.allocator);
    defer arena.deinit();
    const cat = try parseForTest(demo_bytes);
    const registration = try testRegistration(&arena, cat);
    var parsed = try std.json.parseFromSlice(std.json.Value, std.testing.allocator, build_options.spec_json, .{});
    defer parsed.deinit();
    const spec = parsed.value.object;
    try std.testing.expectEqualStrings(layer_type_name, spec.get("layerType").?.string);
    try std.testing.expectEqualStrings("point", spec.get("geometry").?.string);
    try std.testing.expectEqualStrings("catalog/demo.mlvc", spec.get("catalog").?.string);
    const native = spec.get("native").?.object;
    try std.testing.expectEqualStrings(plugin_id, native.get("pluginId").?.string);
    try std.testing.expectEqualStrings(plugin_version, native.get("pluginVersion").?.string);
    try std.testing.expectEqualStrings("maplibre-animated-icon", native.get("library").?.string);
    try std.testing.expectEqualStrings("mln_animated_icon_register", native.get("entryPoint").?.string);
    try std.testing.expectEqualStrings("mln_animated_icon_register_catalog", native.get("catalogEntryPoint").?.string);
    try std.testing.expectEqualStrings("mln_animated_icon_clock_seconds", native.get("clockSymbol").?.string);
    // The symbols the spec names exist with the C signatures apps call.
    const register_catalog: *const fn (c.mln_plugin_register_function_v1, [*c]const u8, usize, [*c]u8, usize) callconv(.c) c.mln_plugin_status = &mln_animated_icon_register_catalog;
    const clock: *const fn () callconv(.c) f64 = &mln_animated_icon_clock_seconds;
    _ = register_catalog;
    _ = clock;
    try std.testing.expectEqualStrings(layer_type_name, slice(registration.layer_type.layer_type));
    try std.testing.expectEqualStrings(plugin_id, slice(registration.descriptor.plugin_id));

    const paint = spec.get("paint").?.object;
    try std.testing.expectEqual(paint.count(), registration.properties.len);
    const data_driven = c.MLN_PLUGIN_EXPRESSION_CAMERA | c.MLN_PLUGIN_EXPRESSION_FEATURE | c.MLN_PLUGIN_EXPRESSION_COMPOSITE | c.MLN_PLUGIN_EXPRESSION_FEATURE_STATE;
    // Declaration order is the host's property order; keep it identical.
    var it = paint.iterator();
    var index: usize = 0;
    while (it.next()) |entry| : (index += 1) {
        const d = registration.properties[index];
        try std.testing.expectEqualStrings(entry.key_ptr.*, slice(d.name));
        try std.testing.expectEqual(d.type, d.default_value.type);
        const property = entry.value_ptr.object;
        const type_name = property.get("type").?.string;
        const default = property.get("default").?;
        const is_enum = std.mem.eql(u8, type_name, "enum");
        // "expressions": absent means camera.
        const expressions = if (property.get("expressions")) |e| e.string else "camera";
        const expected_capabilities: u32 = if (std.mem.eql(u8, expressions, "data-driven"))
            data_driven
        else if (std.mem.eql(u8, expressions, "camera"))
            c.MLN_PLUGIN_EXPRESSION_CAMERA
        else
            return error.UnknownSpecExpressions;
        try std.testing.expectEqual(expected_capabilities, d.expression_capabilities);
        // "transition": absent means true for numbers, false for enums.
        const transition = if (property.get("transition")) |t| t.bool else !is_enum;
        try std.testing.expectEqual(@as(u8, @intFromBool(transition)), d.supports_transitions);
        if (is_enum) {
            try std.testing.expect(!transition);
            try std.testing.expectEqual(@as(c_uint, c.MLN_PLUGIN_VALUE_STRING), d.type);
            try std.testing.expectEqualStrings(default.string, slice(d.default_value.data.string_value));
            const values = d.enum_values[0..d.enum_value_count];
            switch (property.get("values").?) {
                .string => |source| {
                    try std.testing.expectEqualStrings("catalog", source);
                    const expected = try cat.enumValues(std.testing.allocator);
                    defer std.testing.allocator.free(expected);
                    try std.testing.expectEqual(expected.len, values.len);
                    for (expected, values) |e, v| try std.testing.expectEqualStrings(e, slice(v));
                },
                .array => |expected| {
                    try std.testing.expectEqual(expected.items.len, values.len);
                    for (expected.items, values) |e, v| try std.testing.expectEqualStrings(e.string, slice(v));
                },
                else => return error.UnknownSpecValues,
            }
            continue;
        }
        try std.testing.expectEqual(@as(usize, 0), d.enum_value_count);
        if (std.mem.eql(u8, type_name, "float") or std.mem.eql(u8, type_name, "rotation")) {
            try std.testing.expectEqual(@as(c_uint, if (type_name[0] == 'f') c.MLN_PLUGIN_VALUE_FLOAT else c.MLN_PLUGIN_VALUE_ROTATION), d.type);
            try std.testing.expectEqual(@as(f32, @floatCast(jsonNumber(default))), d.default_value.data.float_value);
        } else if (std.mem.eql(u8, type_name, "float2")) {
            try std.testing.expectEqual(@as(c_uint, c.MLN_PLUGIN_VALUE_FLOAT2), d.type);
            try std.testing.expectEqual(@as(f32, @floatCast(jsonNumber(default.array.items[0]))), d.default_value.data.float2_value.x);
            try std.testing.expectEqual(@as(f32, @floatCast(jsonNumber(default.array.items[1]))), d.default_value.data.float2_value.y);
        } else if (std.mem.eql(u8, type_name, "color")) {
            try std.testing.expectEqual(@as(c_uint, c.MLN_PLUGIN_VALUE_COLOR), d.type);
            const rgba = default.array.items;
            const actual = d.default_value.data.color_value;
            for ([_]f32{ actual.r, actual.g, actual.b, actual.a }, rgba) |a, e| try std.testing.expectEqual(@as(f32, @floatCast(jsonNumber(e))), a);
        } else return error.UnknownSpecType;
        const minimum = property.get("minimum");
        const maximum = property.get("maximum");
        try std.testing.expectEqual(@as(u8, if (minimum != null) 1 else 0), d.has_minimum);
        try std.testing.expectEqual(@as(u8, if (maximum != null) 1 else 0), d.has_maximum);
        if (minimum) |v| try std.testing.expectEqual(@as(f32, @floatCast(jsonNumber(v))), d.minimum);
        if (maximum) |v| try std.testing.expectEqual(@as(f32, @floatCast(jsonNumber(v))), d.maximum);
    }
}

test "property bindings cover every property with distinct uniform ranges" {
    var covered = std.mem.zeroes([@sizeOf(DrawableUBO)]u8);
    inline for (properties, 0..) |property, i| {
        const binding = property_bindings[i];
        try std.testing.expectEqualStrings(property.name, slice(binding.property_name));
        const size: usize = switch (property.kind) {
            .color => 16,
            .float2 => 8,
            else => 4,
        };
        // The host's alignment rule: a range starts on a multiple of its size.
        try std.testing.expectEqual(@as(u32, 0), binding.uniform_byte_offset % @as(u32, @intCast(size)));
        for (binding.uniform_byte_offset..binding.uniform_byte_offset + size) |j| {
            try std.testing.expectEqual(@as(u8, 0), covered[j]);
            covered[j] = 1;
        }
        // Interpolation factors in spec order, from byte 160.
        try std.testing.expectEqual(@as(u32, 160 + 4 * i), binding.interpolation_uniform_byte_offset);
        for (binding.interpolation_uniform_byte_offset..binding.interpolation_uniform_byte_offset + 4) |j| {
            try std.testing.expectEqual(@as(u8, 0), covered[j]);
            covered[j] = 1;
        }
        try std.testing.expect(binding.maximum_attribute_id < attributes.len);
        // Colors need two endpoint attributes; the rest pack both into one:
        // float2 slots for 4-byte values, float4 slots for float2 values.
        try std.testing.expectEqual(@as(u32, if (property.kind == .color) 1 else 0), binding.maximum_attribute_id - binding.minimum_attribute_id);
        const minimum = attributes[binding.minimum_attribute_id];
        try std.testing.expectEqualStrings(attributeName(property, 0), slice(minimum.name));
        try std.testing.expectEqual(@as(c_uint, if (size == 4) c.MLN_PLUGIN_VERTEX_FLOAT_X2 else c.MLN_PLUGIN_VERTEX_FLOAT_X4), minimum.type);
        try std.testing.expectEqual(@as(u32, drawable_uniform_id), binding.interpolation_uniform_id);
    }
    // The plugin-owned fields stay clear of the host's ranges, and the
    // ranges fill the rest of the block.
    for (0..@offsetOf(DrawableUBO, "icon_color")) |i| try std.testing.expectEqual(@as(u8, 0), covered[i]);
    for (@offsetOf(DrawableUBO, "icon_color")..@sizeOf(DrawableUBO)) |i| try std.testing.expectEqual(@as(u8, 1), covered[i]);
}

test "attributes, uniform blocks and the texture fit every backend" {
    // Vertex attributes: a_pos plus 13 property slots, IDs equal to their
    // contiguous locations, two below the portable limit of 16.
    try std.testing.expectEqual(@as(usize, 14), attributes.len);
    try std.testing.expect(attributes.len <= c.MLN_PLUGIN_MAX_VERTEX_ATTRIBUTES);
    for (attributes, 0..) |attribute, i| {
        try std.testing.expectEqual(@as(u32, @intCast(i)), attribute.attribute_id);
        try std.testing.expectEqual(@as(u32, @intCast(i)), attribute.location);
    }
    var arena = std.heap.ArenaAllocator.init(std.testing.allocator);
    defer arena.deinit();
    for ([_][]const u8{ demo_bytes, catalogFixture("wide.mlvc"), catalogFixture("empty.mlvc") }) |bytes| {
        const cat = try parseForTest(bytes);
        const registration = try testRegistration(&arena, cat);
        const shader = registration.shaders[0];
        // Two blocks in distinct stage slots (Vulkan takes at most two;
        // OpenGL and Metal one per slot), each within 16 KiB.
        try std.testing.expectEqual(@as(usize, 2), shader.uniform_block_count);
        const drawable = shader.uniform_blocks[0];
        const header = shader.uniform_blocks[1];
        try std.testing.expectEqual(@as(c_uint, c.MLN_PLUGIN_UNIFORM_DRAWABLE), drawable.scope);
        try std.testing.expectEqual(@as(u32, c.MLN_PLUGIN_SHADER_STAGE_VERTEX), drawable.stage_mask);
        try std.testing.expectEqual(@as(u32, @sizeOf(DrawableUBO)), drawable.byte_size);
        try std.testing.expectEqual(@as(c_uint, c.MLN_PLUGIN_UNIFORM_LAYER), header.scope);
        try std.testing.expectEqual(@as(u32, c.MLN_PLUGIN_SHADER_STAGE_VERTEX | c.MLN_PLUGIN_SHADER_STAGE_FRAGMENT), header.stage_mask);
        try std.testing.expectEqual(@as(u32, 16 + 32 * (cat.animation_count + 1)), header.byte_size);
        for (shader.uniform_blocks[0..2]) |block| {
            try std.testing.expectEqual(@as(u32, 0), block.byte_size % 16);
            try std.testing.expect(block.byte_size <= 16384);
        }
        // One RGBA32F texture holding the texels, padded to W·H.
        try std.testing.expectEqual(@as(usize, 1), shader.texture_count);
        const texture = shader.textures[0];
        try std.testing.expectEqual(@as(u32, @sizeOf(c.mln_plugin_texture_descriptor_v1)), texture.struct_size);
        try std.testing.expectEqual(@as(u32, 0), texture.texture_id);
        try std.testing.expectEqualStrings("u_art", slice(texture.name));
        try std.testing.expectEqual(@as(c_uint, c.MLN_PLUGIN_TEXTURE_RGBA32F), texture.format);
        try std.testing.expectEqual(cat.texture_width, texture.width);
        try std.testing.expectEqual(cat.texture_height, texture.height);
        try std.testing.expect(texture.width <= c.MLN_PLUGIN_MAX_TEXTURE_SIZE and texture.height <= c.MLN_PLUGIN_MAX_TEXTURE_SIZE);
        try std.testing.expectEqual(@as(usize, texture.width) * texture.height * 16, texture.data_size);
        const data: [*]const u8 = @ptrCast(texture.data.?);
        const texels = cat.texelBytes();
        try std.testing.expectEqualSlices(u8, texels, data[0..texels.len]);
        for (data[texels.len..texture.data_size]) |byte| try std.testing.expectEqual(@as(u8, 0), byte);
    }
}

fn expectContains(haystack: c.mln_plugin_string, needle: []const u8) !void {
    if (std.mem.indexOf(u8, slice(haystack), needle) == null) {
        std.debug.print("missing: {s}\n", .{needle});
        return error.TestExpectedSubstring;
    }
}

fn expectLacks(haystack: c.mln_plugin_string, needle: []const u8) !void {
    if (std.mem.indexOf(u8, slice(haystack), needle) != null) {
        std.debug.print("unexpected: {s}\n", .{needle});
        return error.TestUnexpectedSubstring;
    }
}

test "shader sources declare the expected interface" {
    var arena = std.heap.ArenaAllocator.init(std.testing.allocator);
    defer arena.deinit();
    const cat = try parseForTest(demo_bytes);
    const registration = try testRegistration(&arena, cat);
    const sources = registration.sources;
    const defines = try cat.shaderDefines(arena.allocator());
    for (sources) |source| {
        try std.testing.expect(std.mem.startsWith(u8, slice(source.vertex_source), defines));
        if (source.fragment_source.size > 0) try std.testing.expect(std.mem.startsWith(u8, slice(source.fragment_source), defines));
    }

    const gl = sources[0];
    try std.testing.expectEqual(@as(c_uint, c.MLN_PLUGIN_BACKEND_OPENGL), gl.backend);
    try expectContains(gl.vertex_source, "layout(std140) uniform IconDrawableUBO");
    try expectContains(gl.vertex_source, "layout(std140) uniform IconCatalogUBO");
    try expectLacks(gl.fragment_source, "IconCatalogUBO");
    try expectContains(gl.vertex_source, "#if !MLN_PLUGIN_PROPERTY_ICON_ANIMATION_IS_UNIFORM\nlayout(location=1) in vec2 a_icon_animation;");
    try expectContains(gl.vertex_source, "layout(location=5) in vec4 a_icon_color_min;\nlayout(location=6) in vec4 a_icon_color_max;");
    try expectContains(gl.vertex_source, "layout(location=13) in vec2 a_icon_animation_mode;");
    try expectContains(gl.vertex_source, "IconVertex iconPlace(");
    try expectContains(gl.vertex_source, "#define ICON_ANIMATION_SPEED");
    try expectContains(gl.fragment_source, "precision highp float;");
    try expectContains(gl.fragment_source, "uniform highp sampler2D u_art;");
    try expectLacks(gl.fragment_source, "out vec4 fragColor");
    try expectContains(gl.fragment_source, "Copyright 2017, by Eric Lengyel.");

    const vk = sources[1];
    try std.testing.expectEqual(@as(c_uint, c.MLN_PLUGIN_BACKEND_VULKAN), vk.backend);
    try expectContains(vk.vertex_source, "layout(std140, set = DRAWABLE_UBO_SET_INDEX, binding = MLN_PLUGIN_UNIFORM_0_BINDING) uniform IconDrawableUBO");
    try expectContains(vk.vertex_source, "layout(std140, set = DRAWABLE_UBO_SET_INDEX, binding = MLN_PLUGIN_UNIFORM_1_BINDING) uniform IconCatalogUBO");
    try expectLacks(vk.fragment_source, "IconCatalogUBO");
    try expectContains(vk.vertex_source, "layout(location=5) in vec4 a_icon_color_min;\nlayout(location=6) in vec4 a_icon_color_max;");
    try expectContains(vk.vertex_source, "applySurfaceTransform();");
    try expectContains(vk.fragment_source, "layout(set = DRAWABLE_IMAGE_SET_INDEX, binding = MLN_PLUGIN_TEXTURE_0_BINDING) uniform highp sampler2D u_art;");
    try expectContains(vk.fragment_source, "layout(location=0) out vec4 fragColor;");
    try expectContains(vk.fragment_source, "layout(location=1) flat in vec4 v_icon;");

    const mtl = sources[2];
    try std.testing.expectEqual(@as(c_uint, c.MLN_PLUGIN_BACKEND_METAL), mtl.backend);
    try std.testing.expectEqual(@as(usize, 0), mtl.fragment_source.size);
    try std.testing.expectEqualStrings("iconVertex", slice(mtl.vertex_entry_point));
    try std.testing.expectEqualStrings("iconFragment", slice(mtl.fragment_entry_point));
    try expectContains(mtl.vertex_source, "constant IconDrawableUBO& u [[buffer(MLN_PLUGIN_UNIFORM_0_BINDING)]]");
    try expectContains(mtl.vertex_source, "constant IconCatalogUBO& catalog [[buffer(MLN_PLUGIN_UNIFORM_1_BINDING)]]");
    try expectContains(mtl.vertex_source, "texture2d<float, access::read> art [[texture(MLN_PLUGIN_TEXTURE_0_BINDING)]]");
    try expectContains(mtl.vertex_source, "float4 a_icon_color_min [[attribute(5)]];\n    float4 a_icon_color_max [[attribute(6)]];");
    try expectContains(mtl.vertex_source, "float4 a_icon_offset [[attribute(7)]];");
    try expectContains(mtl.vertex_source, "float2 a_icon_animation_mode [[attribute(13)]];");
    try expectContains(mtl.vertex_source, "float4 v_icon [[flat]];");
    try expectContains(mtl.vertex_source, "Copyright 2017, by Eric Lengyel.");
}

/// The text between `// begin:<name>` and `// end:<name>`, markers included.
fn findSection(text: []const u8, name: []const u8) ?[]const u8 {
    var begin_buffer: [64]u8 = undefined;
    var end_buffer: [64]u8 = undefined;
    const begin = std.fmt.bufPrint(&begin_buffer, "// begin:{s}\n", .{name}) catch return null;
    const end = std.fmt.bufPrint(&end_buffer, "// end:{s}\n", .{name}) catch return null;
    const start = std.mem.indexOf(u8, text, begin) orelse return null;
    const stop = std.mem.indexOfPos(u8, text, start, end) orelse return null;
    return text[start .. stop + end.len];
}

test "the OpenGL sources carry the shared sections verbatim" {
    if (!std.mem.eql(u8, build_options.shader_sections, shader_sections_text)) {
        std.debug.print("fixtures/shaders/sections.glsl is stale; expected:\n{s}", .{shader_sections_text});
        return error.TestStaleSections;
    }
    var arena = std.heap.ArenaAllocator.init(std.testing.allocator);
    defer arena.deinit();
    const registration = try testRegistration(&arena, try parseForTest(demo_bytes));
    const gl = registration.sources[0];
    for (gl_sections) |s| {
        const pinned = findSection(build_options.shader_sections, s.name) orelse return error.TestMissingSection;
        const in_vertex = findSection(slice(gl.vertex_source), s.name);
        const in_fragment = findSection(slice(gl.fragment_source), s.name);
        // Each section is in exactly one stage.
        try std.testing.expect((in_vertex == null) != (in_fragment == null));
        try std.testing.expectEqualStrings(pinned, in_vertex orelse in_fragment.?);
    }
}

test "properties.glsl defines every property's macro both ways" {
    inline for (properties) |property| {
        const macro = "#define " ++ comptime upperName(property) ++ " (";
        try std.testing.expectEqual(@as(usize, 2), std.mem.count(u8, property_glsl, macro));
        const guard = comptime "#if " ++ propertyMacro(property) ++ "\n";
        try std.testing.expect(std.mem.indexOf(u8, property_glsl, guard) != null);
    }
}

test "layout callbacks build a bucket the host accepts" {
    const context = c.mln_plugin_layout_context_v1{ .struct_size = @sizeOf(c.mln_plugin_layout_context_v1), .zoom = 12, .extent = 8192 };
    var instance: ?*anyopaque = null;
    try std.testing.expectEqual(@as(c.mln_plugin_status, c.MLN_PLUGIN_STATUS_OK), createLayout(&context, &instance));
    defer destroyLayout(instance);
    // A Point, a MultiPoint with one point in the neighbour's buffer, and a
    // polygon the point-only mask would never send but that is ignored.
    const point = [_]c.mln_plugin_tile_point_v1{.{ .x = 4000, .y = 6000 }};
    const multi = [_]c.mln_plugin_tile_point_v1{ .{ .x = 100, .y = 200 }, .{ .x = -50, .y = 300 }, .{ .x = 7000, .y = 100 } };
    const square = [_]c.mln_plugin_tile_point_v1{ .{ .x = 0, .y = 0 }, .{ .x = 10, .y = 0 }, .{ .x = 10, .y = 10 }, .{ .x = 0, .y = 0 } };
    try std.testing.expectEqual(@as(c.mln_plugin_status, c.MLN_PLUGIN_STATUS_OK), layoutFeature(instance, &testFeature(c.MLN_PLUGIN_GEOMETRY_POINT, &point, &.{ 0, 1 }, 3)));
    try std.testing.expectEqual(@as(c.mln_plugin_status, c.MLN_PLUGIN_STATUS_OK), layoutFeature(instance, &testFeature(c.MLN_PLUGIN_GEOMETRY_POINT, &multi, &.{ 0, 1, 2, 3 }, 8)));
    try std.testing.expectEqual(@as(c.mln_plugin_status, c.MLN_PLUGIN_STATUS_OK), layoutFeature(instance, &testFeature(c.MLN_PLUGIN_GEOMETRY_POLYGON, &square, &.{ 0, 4 }, 9)));

    var bucket = std.mem.zeroes(c.mln_plugin_bucket_v1);
    bucket.struct_size = @sizeOf(c.mln_plugin_bucket_v1);
    try std.testing.expectEqual(@as(c.mln_plugin_status, c.MLN_PLUGIN_STATUS_OK), finishLayout(instance, &bucket));
    try std.testing.expectEqual(@as(usize, 1), bucket.vertex_stream_count);
    try std.testing.expectEqual(@as(usize, 1), bucket.drawable_count);
    const stream = bucket.vertex_streams[0];
    try std.testing.expectEqual(@as(u32, 3 * 4), stream.vertex_count);
    try std.testing.expectEqual(@as(usize, stream.vertex_count * @sizeOf(layout.Vertex)), stream.data_size);
    try std.testing.expectEqual(@as(u32, @sizeOf(layout.Vertex)), stream.stride);
    // Sorted by y: (7000, 100) and (100, 200) of the MultiPoint, then the Point.
    const vertices: [*]const layout.Vertex = @ptrCast(@alignCast(stream.data));
    try std.testing.expectEqual(layout.Vertex{ .x = 14000, .y = 200 }, vertices[0]);
    try std.testing.expectEqual(layout.Vertex{ .x = 201, .y = 401 }, vertices[7]);
    try std.testing.expectEqual(layout.Vertex{ .x = 8000, .y = 12000 }, vertices[8]);
    // One range per anchor covers every vertex once.
    try std.testing.expectEqual(@as(usize, 3), bucket.feature_vertex_range_count);
    const expected_features = [_]u64{ 8, 8, 3 };
    for (bucket.feature_vertex_ranges[0..3], expected_features, 0..) |range, feature, i| {
        try std.testing.expectEqual(feature, range.feature_index);
        try std.testing.expectEqual(@as(u64, 1), range.drawable_key);
        try std.testing.expectEqual(@as(u32, @intCast(i * 4)), range.first_vertex);
        try std.testing.expectEqual(@as(u32, 4), range.vertex_count);
    }
    const drawable = bucket.drawables[0];
    try std.testing.expectEqualStrings("icon", slice(drawable.shader_id));
    try std.testing.expectEqual(@as(usize, 1), drawable.segment_count);
    try std.testing.expectEqual(stream.vertex_count, drawable.segments[0].vertex_length);
    try std.testing.expectEqual(@as(usize, drawable.segments[0].index_length), bucket.index_count);
    for (bucket.indices[0..bucket.index_count]) |index| try std.testing.expect(index < drawable.segments[0].vertex_length);
    // The host requires the drawable's attributes plus the bound property
    // slots to be every declared attribute.
    try std.testing.expectEqual(attributes.len, drawable.attribute_count + paint_attribute_count);
    try std.testing.expect(std.math.isFinite(bucket.query_radius) and bucket.query_radius >= 0);

    // A tile with no owned points reports no drawables rather than empty streams.
    var empty_instance: ?*anyopaque = null;
    try std.testing.expectEqual(@as(c.mln_plugin_status, c.MLN_PLUGIN_STATUS_OK), createLayout(&context, &empty_instance));
    defer destroyLayout(empty_instance);
    const outside = [_]c.mln_plugin_tile_point_v1{.{ .x = 8192, .y = 10 }};
    try std.testing.expectEqual(@as(c.mln_plugin_status, c.MLN_PLUGIN_STATUS_OK), layoutFeature(empty_instance, &testFeature(c.MLN_PLUGIN_GEOMETRY_POINT, &outside, &.{ 0, 1 }, 0)));
    var empty = std.mem.zeroes(c.mln_plugin_bucket_v1);
    empty.struct_size = @sizeOf(c.mln_plugin_bucket_v1);
    try std.testing.expectEqual(@as(c.mln_plugin_status, c.MLN_PLUGIN_STATUS_OK), finishLayout(empty_instance, &empty));
    try std.testing.expectEqual(@as(usize, 0), empty.drawable_count);
    try std.testing.expectEqual(@as(usize, 0), empty.vertex_stream_count);
    try std.testing.expectEqual(@as(usize, 0), empty.feature_vertex_range_count);
}

fn testFeature(geometry_type: c.mln_plugin_geometry_type, points: []const c.mln_plugin_tile_point_v1, offsets: []const u32, index: u64) c.mln_plugin_feature_v1 {
    return .{
        .struct_size = @sizeOf(c.mln_plugin_feature_v1),
        .geometry_type = geometry_type,
        .feature_index = index,
        .points = points.ptr,
        .point_count = points.len,
        .path_offsets = offsets.ptr,
        .path_count = offsets.len - 1,
    };
}

/// A fake host: checks the descriptor the way the registry does at the
/// struct level, and answers like the registry's one-descriptor-per-type
/// rule: OK for a new registration, ALREADY_REGISTERED for identical
/// descriptors, CONFLICT for different ones; `fail` makes it reject.
const FakeHost = struct {
    var calls: usize = 0;
    var fail = false;
    /// A digest of the registered descriptors (texture bytes and enum names).
    var registered: ?u64 = null;
    var last_texture: ?c.mln_plugin_texture_descriptor_v1 = null;

    fn reset() void {
        calls = 0;
        fail = false;
        registered = null;
        last_texture = null;
    }

    fn register(descriptor_ptr: [*c]const c.mln_plugin_descriptor_v1, message: [*c]u8, capacity: usize) callconv(.c) c.mln_plugin_status {
        calls += 1;
        const d = descriptor_ptr.*;
        if (d.struct_size != @sizeOf(c.mln_plugin_descriptor_v1) or d.layer_type_count != 1) return c.MLN_PLUGIN_STATUS_INVALID_ARGUMENT;
        const layer = d.layer_types[0];
        if (layer.property_count != properties.len or layer.shader_count != 1 or layer.update_uniform_block == null or layer.query_feature == null or layer.get_query_radius == null or layer.should_animate == null) return c.MLN_PLUGIN_STATUS_INVALID_ARGUMENT;
        const shader = layer.shaders[0];
        if (shader.source_count != 3 or shader.attribute_count != 14 or shader.uniform_block_count != 2 or shader.property_binding_count != properties.len or shader.texture_count != 1) return c.MLN_PLUGIN_STATUS_INVALID_ARGUMENT;
        const texture = shader.textures[0];
        if (texture.data == null or texture.data_size != @as(usize, texture.width) * texture.height * 16) return c.MLN_PLUGIN_STATUS_INVALID_ARGUMENT;
        last_texture = texture;
        if (fail) {
            writeError(message, capacity, "fake host: rejected");
            return c.MLN_PLUGIN_STATUS_INVALID_ARGUMENT;
        }
        var hasher = std.hash.Wyhash.init(0);
        hasher.update(@as([*]const u8, @ptrCast(texture.data.?))[0..texture.data_size]);
        const animation = layer.properties[0];
        for (animation.enum_values[0..animation.enum_value_count]) |v| hasher.update(slice(v));
        const digest = hasher.final();
        writeError(message, capacity, "");
        if (registered) |previous| return if (previous == digest) c.MLN_PLUGIN_STATUS_ALREADY_REGISTERED else c.MLN_PLUGIN_STATUS_CONFLICT;
        registered = digest;
        return c.MLN_PLUGIN_STATUS_OK;
    }
};

fn messageOf(buffer: []const u8) []const u8 {
    return buffer[0 .. std.mem.indexOfScalar(u8, buffer, 0) orelse buffer.len];
}

test "the entry points register one catalog per process" {
    resetForTesting();
    defer resetForTesting();
    FakeHost.reset();
    var message: [512]u8 = undefined;

    // The embedded demo.
    try std.testing.expectEqual(@as(c.mln_plugin_status, c.MLN_PLUGIN_STATUS_OK), mln_animated_icon_register(FakeHost.register, &message, message.len));
    try std.testing.expectEqual(@as(usize, 1), FakeHost.calls);
    try std.testing.expect(active.load(.acquire) != null);
    try std.testing.expectEqual(@as(c.mln_plugin_status, c.MLN_PLUGIN_STATUS_INVALID_ARGUMENT), mln_animated_icon_register(null, &message, message.len));

    // An app catalog, after a reset.
    resetForTesting();
    FakeHost.reset();
    const app = catalogFixture("frames.mlvc");
    try std.testing.expectEqual(@as(c.mln_plugin_status, c.MLN_PLUGIN_STATUS_OK), mln_animated_icon_register_catalog(FakeHost.register, app.ptr, app.len, &message, message.len));
    const cat = try parseForTest(app);
    try std.testing.expectEqual(cat.texture_width, FakeHost.last_texture.?.width);
    // The caller's bytes are borrowed: the texture points into the plugin's copy.
    const texture_address = @intFromPtr(FakeHost.last_texture.?.data.?);
    try std.testing.expect(texture_address < @intFromPtr(app.ptr) or texture_address >= @intFromPtr(app.ptr) + app.len);

    // The same bytes again reach the host, which reports them registered.
    const copy = try std.testing.allocator.dupe(u8, app);
    defer std.testing.allocator.free(copy);
    try std.testing.expectEqual(@as(c.mln_plugin_status, c.MLN_PLUGIN_STATUS_ALREADY_REGISTERED), mln_animated_icon_register_catalog(FakeHost.register, copy.ptr, copy.len, &message, message.len));
    try std.testing.expectEqual(@as(usize, 2), FakeHost.calls);

    // A different catalog, the demo included, conflicts without reaching
    // the host.
    const other = catalogFixture("circle.mlvc");
    try std.testing.expectEqual(@as(c.mln_plugin_status, c.MLN_PLUGIN_STATUS_CONFLICT), mln_animated_icon_register_catalog(FakeHost.register, other.ptr, other.len, &message, message.len));
    try std.testing.expectEqualStrings("animated-icon: a different catalog is already registered in this process", messageOf(&message));
    try std.testing.expectEqual(@as(c.mln_plugin_status, c.MLN_PLUGIN_STATUS_CONFLICT), mln_animated_icon_register(FakeHost.register, &message, message.len));
    try std.testing.expectEqual(@as(usize, 2), FakeHost.calls);

    // Null bytes with a size are an argument error.
    try std.testing.expectEqual(@as(c.mln_plugin_status, c.MLN_PLUGIN_STATUS_INVALID_ARGUMENT), mln_animated_icon_register_catalog(FakeHost.register, null, 4, &message, message.len));
}

test "a malformed catalog is rejected with its diagnostic" {
    resetForTesting();
    defer resetForTesting();
    FakeHost.reset();
    var parsed = try std.json.parseFromSlice(std.json.Value, std.testing.allocator, catalogFixture("manifest.json"), .{});
    defer parsed.deinit();
    const malformed = parsed.value.object.get("malformed").?.array.items;
    try std.testing.expect(malformed.len > 0);
    var message: [512]u8 = undefined;
    for (malformed) |item| {
        const file = item.object.get("file").?.string;
        const bytes = catalogFixture(file);
        try std.testing.expectEqual(@as(c.mln_plugin_status, c.MLN_PLUGIN_STATUS_INVALID_ARGUMENT), mln_animated_icon_register_catalog(FakeHost.register, bytes.ptr, bytes.len, &message, message.len));
        var expected: [512]u8 = undefined;
        const text = try std.fmt.bufPrint(&expected, "animated-icon catalog: {s}", .{item.object.get("message").?.string});
        try std.testing.expectEqualStrings(text, messageOf(&message));
    }
    try std.testing.expectEqual(@as(usize, 0), FakeHost.calls);
    try std.testing.expect(active.load(.acquire) == null);
    // An empty buffer is a malformed catalog too.
    try std.testing.expectEqual(@as(c.mln_plugin_status, c.MLN_PLUGIN_STATUS_INVALID_ARGUMENT), mln_animated_icon_register_catalog(FakeHost.register, null, 0, &message, message.len));
}

test "a failed host registration clears the active catalog" {
    resetForTesting();
    defer resetForTesting();
    FakeHost.reset();
    var message: [512]u8 = undefined;
    FakeHost.fail = true;
    try std.testing.expectEqual(@as(c.mln_plugin_status, c.MLN_PLUGIN_STATUS_INVALID_ARGUMENT), mln_animated_icon_register(FakeHost.register, &message, message.len));
    try std.testing.expect(active.load(.acquire) == null);
    // Another catalog then registers: nothing is left to conflict with.
    FakeHost.fail = false;
    const app = catalogFixture("frames.mlvc");
    try std.testing.expectEqual(@as(c.mln_plugin_status, c.MLN_PLUGIN_STATUS_OK), mln_animated_icon_register_catalog(FakeHost.register, app.ptr, app.len, &message, message.len));
    try std.testing.expect(active.load(.acquire) != null);
}

fn uniformContext() c.mln_plugin_uniform_context_v1 {
    var context = std.mem.zeroes(c.mln_plugin_uniform_context_v1);
    context.struct_size = @sizeOf(c.mln_plugin_uniform_context_v1);
    context.pixels_to_gl_units = .{ 0.01, -0.02 };
    context.pixels_to_tile_units = 16;
    context.camera_to_center_distance = 700;
    context.pixel_ratio = 2;
    context.bearing = -0.5;
    for (0..16) |i| context.tile_matrix[i] = @floatFromInt(i);
    return context;
}

test "the uniform callbacks fill both blocks" {
    resetForTesting();
    defer resetForTesting();
    FakeHost.reset();
    var message: [256]u8 = undefined;
    try std.testing.expectEqual(@as(c.mln_plugin_status, c.MLN_PLUGIN_STATUS_OK), mln_animated_icon_register(FakeHost.register, &message, message.len));
    const context = uniformContext();

    var drawable: [@sizeOf(DrawableUBO)]u8 align(16) = undefined;
    try std.testing.expectEqual(@as(c.mln_plugin_status, c.MLN_PLUGIN_STATUS_OK), updateUniformBlock(&context, drawable_uniform_id, &drawable, drawable.len));
    const block: *const DrawableUBO = @ptrCast(@alignCast(&drawable));
    try std.testing.expectEqual(@as(f32, 5), block.matrix[5]);
    try std.testing.expectEqual([4]f32{ 0.01, -0.02, 16, 700 }, block.camera);
    try std.testing.expectEqual([4]f32{ 2, -0.5, 0, 0 }, block.view);
    // Property fields stay zero for the host to fill.
    try std.testing.expectEqual(@as(f32, 0), block.icon_size);

    // The header block is the catalog's, with the pinned clock.
    const cat = try parseForTest(demo_bytes);
    const size = cat.headerBlockSize();
    const header = try std.testing.allocator.alloc(u8, size);
    defer std.testing.allocator.free(header);
    const expected = try std.testing.allocator.alloc(u8, size);
    defer std.testing.allocator.free(expected);
    mln_animated_icon_set_clock(12.5);
    try std.testing.expectEqual(@as(c.mln_plugin_status, c.MLN_PLUGIN_STATUS_OK), updateUniformBlock(&context, catalog_uniform_id, header.ptr, size));
    cat.writeHeaderBlock(12.5, expected);
    try std.testing.expectEqualSlices(u8, expected, header);

    try std.testing.expectEqual(@as(c.mln_plugin_status, c.MLN_PLUGIN_STATUS_INVALID_ARGUMENT), updateUniformBlock(&context, 2, &drawable, drawable.len));
    try std.testing.expectEqual(@as(c.mln_plugin_status, c.MLN_PLUGIN_STATUS_INVALID_ARGUMENT), updateUniformBlock(&context, drawable_uniform_id, &drawable, drawable.len - 16));
    try std.testing.expectEqual(@as(c.mln_plugin_status, c.MLN_PLUGIN_STATUS_INVALID_ARGUMENT), updateUniformBlock(&context, catalog_uniform_id, header.ptr, size - 16));
}

test "the clock pins, wraps and stays below the period in the block" {
    resetForTesting();
    defer resetForTesting();
    // Live: monotonic from the first reading.
    const first = mln_animated_icon_clock_seconds();
    try std.testing.expect(first >= 0 and first < 1);
    try std.testing.expect(mln_animated_icon_clock_seconds() >= first);
    // Pinned, wrapped; NaN unpins.
    mln_animated_icon_set_clock(42.25);
    try std.testing.expectEqual(@as(f64, 42.25), mln_animated_icon_clock_seconds());
    mln_animated_icon_set_clock(4096 * 3 + 1.5);
    try std.testing.expectEqual(@as(f64, 1.5), mln_animated_icon_clock_seconds());
    mln_animated_icon_set_clock(-1);
    try std.testing.expectEqual(@as(f64, 4095), mln_animated_icon_clock_seconds());
    mln_animated_icon_set_clock(std.math.nan(f64));
    const live = mln_animated_icon_clock_seconds();
    try std.testing.expect(live >= first and live < 60);
    mln_animated_icon_set_clock(std.math.inf(f64));
    try std.testing.expect(mln_animated_icon_clock_seconds() < 60);

    // A time just below the period rounds to 4096 in f32, which the block
    // stores as 0.
    try std.testing.expectEqual(@as(f32, 0), blockClock(4095.99999999));
    try std.testing.expectEqual(@as(f32, 4095.5), blockClock(4095.5));
    FakeHost.reset();
    var message: [256]u8 = undefined;
    try std.testing.expectEqual(@as(c.mln_plugin_status, c.MLN_PLUGIN_STATUS_OK), mln_animated_icon_register(FakeHost.register, &message, message.len));
    mln_animated_icon_set_clock(4095.99999999);
    const current = active.load(.acquire).?;
    const header = try std.testing.allocator.alloc(u8, current.header_block.len);
    defer std.testing.allocator.free(header);
    const context = uniformContext();
    try std.testing.expectEqual(@as(c.mln_plugin_status, c.MLN_PLUGIN_STATUS_OK), updateUniformBlock(&context, catalog_uniform_id, header.ptr, header.len));
    try std.testing.expectEqual(@as(u32, 0), std.mem.readInt(u32, header[0..4], .little));
}

/// The query geometry for a screen point: the ground point under it, in the
/// fixture tile's int16 units, as the host computes it from the screen.
fn queryPoint(view: place.View, p: [2]f64) c.mln_plugin_tile_point_v1 {
    const m = view.matrix;
    const nx = 2 * p[0] / view.viewport[0] - 1;
    const ny = 1 - 2 * p[1] / view.viewport[1];
    const a = m[0] - nx * m[3];
    const b = m[4] - nx * m[7];
    const cc = m[1] - ny * m[3];
    const d = m[5] - ny * m[7];
    const e = -(m[12] - nx * m[15]);
    const f = -(m[13] - ny * m[15]);
    const det = a * d - b * cc;
    return .{ .x = @intFromFloat(@round((e * d - b * f) / det)), .y = @intFromFloat(@round((a * f - e * cc) / det)) };
}

fn stringValue(name: []const u8, text: []const u8) c.mln_plugin_property_value_v1 {
    return .{ .struct_size = @sizeOf(c.mln_plugin_property_value_v1), .name = str(name), .value = .{ .struct_size = @sizeOf(c.mln_plugin_value), .type = c.MLN_PLUGIN_VALUE_STRING, .data = .{ .string_value = str(text) } }, .explicitly_set = 1 };
}

fn floatProperty(name: []const u8, value_type: c.mln_plugin_value_type, number: f64) c.mln_plugin_property_value_v1 {
    return .{ .struct_size = @sizeOf(c.mln_plugin_property_value_v1), .name = str(name), .value = .{ .struct_size = @sizeOf(c.mln_plugin_value), .type = value_type, .data = .{ .float_value = @floatCast(number) } }, .explicitly_set = 1 };
}

fn float2Property(name: []const u8, x: f64, y: f64) c.mln_plugin_property_value_v1 {
    return .{ .struct_size = @sizeOf(c.mln_plugin_property_value_v1), .name = str(name), .value = .{ .struct_size = @sizeOf(c.mln_plugin_value), .type = c.MLN_PLUGIN_VALUE_FLOAT2, .data = .{ .float2_value = .{ .x = @floatCast(x), .y = @floatCast(y) } } }, .explicitly_set = 1 };
}

/// The entry table of a placement fixture's entries.
fn fixtureEntries(arena: std.mem.Allocator, fixture: place.Fixture) !EntryTable {
    const items = fixture.entries();
    const names = try arena.alloc([]const u8, items.len + 1);
    const entries = try arena.alloc(place.Entry, items.len + 1);
    const radii = try arena.alloc(f64, items.len + 1);
    names[0] = "none";
    entries[0] = .{ .box = .{ 0, 0, 1, 1 }, .display_px = 0 };
    radii[0] = 0;
    for (items, 1..) |item, i| {
        names[i] = item.object.get("name").?.string;
        entries[i] = fixture.entry(names[i]).entry;
        radii[i] = place.entryRadius(entries[i]);
    }
    return .{ .names = names, .entries = entries, .radii = radii };
}

test "query_feature hits the placement fixtures' icons" {
    const fixtures = @import("place_fixtures");
    var checked: usize = 0;
    for (fixtures.names, fixtures.files) |name, bytes| {
        if (!std.mem.endsWith(u8, name, ".json")) continue;
        var arena = std.heap.ArenaAllocator.init(std.testing.allocator);
        defer arena.deinit();
        var fixture = try place.Fixture.parse(std.testing.allocator, bytes);
        defer fixture.deinit();
        const view = fixture.view();
        const entries = try fixtureEntries(arena.allocator(), fixture);
        var context = std.mem.zeroes(c.mln_plugin_query_context_v1);
        context.struct_size = @sizeOf(c.mln_plugin_query_context_v1);
        context.pixels_to_tile_units = view.pixels_to_tile_units;
        context.camera_to_center_distance = view.camera_to_center_distance;
        context.bearing = view.bearing;
        context.tile_matrix = view.matrix;
        context.viewport_width = @intFromFloat(view.viewport[0]);
        context.viewport_height = @intFromFloat(view.viewport[1]);
        for (fixture.cases(), 0..) |item, case_index| {
            errdefer std.debug.print("{s} case {d}\n", .{ name, case_index });
            const case = item.object;
            const props_json = case.get("properties").?.object;
            // Enum values by name, as the host passes them.
            const props = [_]c.mln_plugin_property_value_v1{
                stringValue("icon-animation", props_json.get("icon-animation").?.string),
                floatProperty("icon-size", c.MLN_PLUGIN_VALUE_FLOAT, place.Fixture.number(props_json.get("icon-size").?)),
                floatProperty("icon-rotate", c.MLN_PLUGIN_VALUE_ROTATION, place.Fixture.number(props_json.get("icon-rotate").?)),
                floatProperty("icon-opacity", c.MLN_PLUGIN_VALUE_FLOAT, place.Fixture.number(props_json.get("icon-opacity").?)),
                float2Property("icon-offset", place.Fixture.vec2(props_json.get("icon-offset").?)[0], place.Fixture.vec2(props_json.get("icon-offset").?)[1]),
                stringValue("icon-anchor", props_json.get("icon-anchor").?.string),
                stringValue("icon-rotation-alignment", props_json.get("icon-rotation-alignment").?.string),
                stringValue("icon-pitch-alignment", props_json.get("icon-pitch-alignment").?.string),
            };
            const anchor = place.Fixture.vec2(case.get("anchor").?);
            const points = [_]c.mln_plugin_tile_point_v1{.{ .x = @intFromFloat(anchor[0]), .y = @intFromFloat(anchor[1]) }};
            const feature = testFeature(c.MLN_PLUGIN_GEOMETRY_POINT, &points, &.{ 0, 1 }, 0);
            for ([_][]const u8{ "hits", "misses" }) |key| {
                for (case.get(key).?.array.items) |p| {
                    const query = [_]c.mln_plugin_tile_point_v1{queryPoint(view, place.Fixture.vec2(p))};
                    try std.testing.expectEqual(key[0] == 'h', queryHit(feature, &query, context, &props, entries));
                    checked += 1;
                }
            }
            for ([_][]const u8{ "ring_hits", "ring_misses" }) |key| {
                for (case.get(key).?.array.items) |ring_json| {
                    var query: [16]c.mln_plugin_tile_point_v1 = undefined;
                    const ring_items = ring_json.array.items;
                    for (ring_items, 0..) |p, i| query[i] = queryPoint(view, place.Fixture.vec2(p));
                    try std.testing.expectEqual(key[5] == 'h', queryHit(feature, query[0..ring_items.len], context, &props, entries));
                    checked += 1;
                }
            }
            // A feature point the tile does not own never hits.
            if (case.get("hits").?.array.items.len > 0) {
                const hit = case.get("hits").?.array.items[0];
                const query = [_]c.mln_plugin_tile_point_v1{queryPoint(view, place.Fixture.vec2(hit))};
                const outside = [_]c.mln_plugin_tile_point_v1{ .{ .x = -1, .y = @intFromFloat(anchor[1]) }, points[0] };
                const buffered = testFeature(c.MLN_PLUGIN_GEOMETRY_POINT, outside[0..1], &.{ 0, 1 }, 0);
                try std.testing.expect(!queryHit(buffered, &query, context, &props, entries));
                const multi = testFeature(c.MLN_PLUGIN_GEOMETRY_POINT, &outside, &.{ 0, 1, 2 }, 0);
                try std.testing.expect(queryHit(multi, &query, context, &props, entries));
            }
        }
    }
    try std.testing.expect(checked > 500);
}

fn statisticsOf(name: []const u8, minimum: c.mln_plugin_value, maximum: c.mln_plugin_value) c.mln_plugin_property_statistics_v1 {
    return .{ .struct_size = @sizeOf(c.mln_plugin_property_statistics_v1), .property_name = str(name), .minimum = minimum, .maximum = maximum };
}

test "the query radius covers the largest icon, from camera values or statistics" {
    var arena = std.heap.ArenaAllocator.init(std.testing.allocator);
    defer arena.deinit();
    const cat = try parseForTest(demo_bytes);
    var entries = try EntryTable.fromCatalog(std.testing.allocator, cat);
    defer entries.deinit(std.testing.allocator);
    const pin = entries.index("pin");
    const pulse = entries.index("pulse");
    try std.testing.expect(pin != 0 and pulse != 0);

    // Camera values: one entry, the size and the offset.
    var camera = [_]c.mln_plugin_property_value_v1{
        stringValue("icon-animation", "pin"),
        floatProperty("icon-size", c.MLN_PLUGIN_VALUE_FLOAT, 2),
        float2Property("icon-offset", 3, -4),
    };
    const expected_pin: f32 = @floatCast(2 * 2 * (entries.radii[pin] + 5) + 2);
    try std.testing.expectApproxEqRel(expected_pin, queryRadius(&.{}, &camera, entries), 1e-6);
    // none, or no size, reaches nothing beyond the margin.
    camera[0] = stringValue("icon-animation", "none");
    try std.testing.expectApproxEqRel(@as(f32, 2 * 2 * 5 + 2), queryRadius(&.{}, &camera, entries), 1e-6);
    camera[1] = floatProperty("icon-size", c.MLN_PLUGIN_VALUE_FLOAT, 0);
    try std.testing.expectEqual(@as(f32, 0), queryRadius(&.{}, &camera, entries));

    // Statistics win over camera values: every entry between the lowest and
    // highest enum index, the largest size and the largest offset per axis.
    const value = struct {
        fn float(number: f32) c.mln_plugin_value {
            return .{ .struct_size = @sizeOf(c.mln_plugin_value), .type = c.MLN_PLUGIN_VALUE_FLOAT, .data = .{ .float_value = number } };
        }
        fn float2(x: f32, y: f32) c.mln_plugin_value {
            return .{ .struct_size = @sizeOf(c.mln_plugin_value), .type = c.MLN_PLUGIN_VALUE_FLOAT2, .data = .{ .float2_value = .{ .x = x, .y = y } } };
        }
        fn string(text: []const u8) c.mln_plugin_value {
            return .{ .struct_size = @sizeOf(c.mln_plugin_value), .type = c.MLN_PLUGIN_VALUE_STRING, .data = .{ .string_value = str(text) } };
        }
    };
    const last = entries.names[entries.names.len - 1];
    var stats = [_]c.mln_plugin_property_statistics_v1{
        statisticsOf("icon-animation", value.string("none"), value.string(last)),
        statisticsOf("icon-size", value.float(0.5), value.float(3)),
        statisticsOf("icon-offset", value.float2(-6, 1), value.float2(2, 8)),
    };
    const reach = entries.maxRadius(0, entries.names.len);
    const expected_all: f32 = @floatCast(2 * 3 * (reach + std.math.hypot(@as(f64, 6), 8)) + 2);
    try std.testing.expectApproxEqRel(expected_all, queryRadius(&stats, &camera, entries), 1e-6);
    // The result is always finite. A NaN or zero largest size draws nothing
    // and reaches nothing; an infinite or overflowing radius (one bad
    // feature) takes the largest finite one, so the tile's other icons stay
    // queryable.
    const cap = std.math.floatMax(f32);
    stats[1] = statisticsOf("icon-size", value.float(0.5), value.float(std.math.nan(f32)));
    try std.testing.expectEqual(@as(f32, 0), queryRadius(&stats, &camera, entries));
    stats[1] = statisticsOf("icon-size", value.float(0), value.float(0));
    try std.testing.expectEqual(@as(f32, 0), queryRadius(&stats, &camera, entries));
    stats[1] = statisticsOf("icon-size", value.float(0.5), value.float(std.math.inf(f32)));
    try std.testing.expectEqual(cap, queryRadius(&stats, &camera, entries));
    stats[1] = statisticsOf("icon-size", value.float(0.5), value.float(3));
    stats[2] = statisticsOf("icon-offset", value.float2(-6, 1), value.float2(std.math.inf(f32), 8));
    try std.testing.expectEqual(cap, queryRadius(&stats, &camera, entries));
    stats[2] = statisticsOf("icon-offset", value.float2(0, 0), value.float2(0, 0));
    stats[1] = statisticsOf("icon-size", value.float(0.5), value.float(3e38));
    try std.testing.expectEqual(cap, queryRadius(&stats, &camera, entries));
}

test "the map animates exactly while icon-animation is set" {
    var props = [_]c.mln_plugin_property_value_v1{
        stringValue("icon-animation", "none"),
        floatProperty("icon-opacity", c.MLN_PLUGIN_VALUE_FLOAT, 0),
    };
    // Set, even to a constant none or with opacity 0: data-driven values
    // reach should_animate as defaults, so no value is a safe stop.
    try std.testing.expectEqual(@as(u8, 1), shouldAnimate(&props, props.len));
    props[0] = stringValue("icon-animation", "pulse");
    try std.testing.expectEqual(@as(u8, 1), shouldAnimate(&props, props.len));
    // Unset: the default none, nothing to draw.
    props[0].explicitly_set = 0;
    try std.testing.expectEqual(@as(u8, 0), shouldAnimate(&props, props.len));
    try std.testing.expectEqual(@as(u8, 0), shouldAnimate(props[1..], 1));
    try std.testing.expectEqual(@as(u8, 0), shouldAnimate(&props, 0));
    try std.testing.expectEqual(@as(u8, 0), shouldAnimate(null, 2));
}
