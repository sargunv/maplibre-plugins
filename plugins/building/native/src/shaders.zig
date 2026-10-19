//! Shader sources and the shader descriptor of the building layer. The shared
//! code (../../shaders/*.glsl) compiles unchanged as GLSL ES 3.00 (OpenGL),
//! GLSL 450 (Vulkan) and MSL (Metal, fast-math); this file only wraps it per
//! backend, as ../../README.md ("Where the code goes") describes:
//!
//!   1. the type names (GLSL), BUILDING_ATTRIBUTE and BUILDING_ATTR;
//!   2. attributes.glsl, inside the stage_in struct on Metal;
//!   3. BuildingDrawableUBO around uniforms.glsl;
//!   4. building.glsl and properties.glsl;
//!   5. the vertex main around vertex.glsl, which projects o.position with
//!      u.tile_matrix and passes o.color on as the smooth varying v_color.
//!
//! The host prepends the MLN_PLUGIN_UNIFORM_0_BINDING, MLN_PLUGIN_COLOR_WRITE
//! and MLN_PLUGIN_PROPERTY_<NAME>_IS_UNIFORM macros. Only the fragment stage
//! reads MLN_PLUGIN_COLOR_WRITE, so the depth-only pass and the color passes
//! compute bit-identical positions (see vertex.glsl).

const std = @import("std");
const build_options = @import("build_options");
const c = @import("maplibre_native_c");

pub const shader_id = "building";
pub const uniform_id: u32 = 0;
pub const uniform_block_name = "BuildingDrawableUBO";
pub const metal_vertex_entry = "buildingVertexMain";
pub const metal_fragment_entry = "buildingFragmentMain";

fn str(comptime text: []const u8) c.mln_plugin_string {
    return .{ .data = text.ptr, .size = text.len };
}

// ---------------------------------------------------------------------------
// The uniform block (uniforms.glsl), attributes and host bindings.
// ---------------------------------------------------------------------------

/// BuildingDrawableUBO. uniforms.glsl declares the same members in the same
/// order; the tests below hold the two (and ../../fixtures/render/
/// contract.json) together.
pub const DrawableUBO = extern struct {
    /// Tile units (x, y) and meters (z) to clip space, translate included.
    tile_matrix: [16]f32,
    color: [4]f32,
    roof_color: [4]f32,
    /// rgb: the style light's color; a: its intensity.
    light_color: [4]f32,
    /// xyz: core's u_lightpos; w: 0.
    light_position: [4]f32,
    /// Binding factors: height, base, roof-height, roof-angle.
    interpolation0: [4]f32,
    /// Binding factors: color, roof-color, opacity, vertical-gradient.
    interpolation1: [4]f32,
    height: f32,
    base: f32,
    roof_height: f32,
    roof_angle: f32,
    opacity: f32,
    vertical_gradient: f32,
    meters_per_tile_unit: f32,
    pad0: f32,
};

comptime {
    std.debug.assert(@sizeOf(DrawableUBO) == 192);
    std.debug.assert(@offsetOf(DrawableUBO, "interpolation0") == 128);
    std.debug.assert(@offsetOf(DrawableUBO, "height") == 160);
    std.debug.assert(@offsetOf(DrawableUBO, "meters_per_tile_unit") == 184);
}

/// A host paint binding: the property, its encoding, where its uniform value
/// goes, its attributes (equal ids pack [min, max] into one float2) and its
/// slot among the interpolation factors.
pub const Binding = struct {
    property: []const u8,
    encoding: c.mln_plugin_property_encoding_v1,
    field: []const u8,
    minimum_attribute: u32,
    maximum_attribute: u32,
    /// Index k of u.interpolation<k / 4>.<xyzw[k % 4]>.
    factor: u32,
};

/// In spec.json paint order; building-translate and its anchor have none.
pub const bindings = [_]Binding{
    .{ .property = "building-height", .encoding = c.MLN_PLUGIN_PROPERTY_ENCODING_FLOAT, .field = "height", .minimum_attribute = 2, .maximum_attribute = 2, .factor = 0 },
    .{ .property = "building-base", .encoding = c.MLN_PLUGIN_PROPERTY_ENCODING_FLOAT, .field = "base", .minimum_attribute = 3, .maximum_attribute = 3, .factor = 1 },
    .{ .property = "building-roof-height", .encoding = c.MLN_PLUGIN_PROPERTY_ENCODING_FLOAT, .field = "roof_height", .minimum_attribute = 4, .maximum_attribute = 4, .factor = 2 },
    .{ .property = "building-roof-angle", .encoding = c.MLN_PLUGIN_PROPERTY_ENCODING_FLOAT, .field = "roof_angle", .minimum_attribute = 5, .maximum_attribute = 5, .factor = 3 },
    .{ .property = "building-color", .encoding = c.MLN_PLUGIN_PROPERTY_ENCODING_COLOR_RGBA8, .field = "color", .minimum_attribute = 6, .maximum_attribute = 7, .factor = 4 },
    .{ .property = "building-roof-color", .encoding = c.MLN_PLUGIN_PROPERTY_ENCODING_COLOR_RGBA8, .field = "roof_color", .minimum_attribute = 8, .maximum_attribute = 9, .factor = 5 },
    .{ .property = "building-opacity", .encoding = c.MLN_PLUGIN_PROPERTY_ENCODING_FLOAT, .field = "opacity", .minimum_attribute = 10, .maximum_attribute = 10, .factor = 6 },
    .{ .property = "building-vertical-gradient", .encoding = c.MLN_PLUGIN_PROPERTY_ENCODING_BOOLEAN_FLOAT, .field = "vertical_gradient", .minimum_attribute = 11, .maximum_attribute = 11, .factor = 7 },
};

/// Paint bindings that may depend on the feature: the shader variants the host
/// compiles differ only in these (opacity and vertical-gradient are camera
/// only, so always uniform).
pub const data_driven = [_][]const u8{
    "building-height",
    "building-base",
    "building-roof-height",
    "building-roof-angle",
    "building-color",
    "building-roof-color",
};

pub fn interpolationOffset(comptime binding: Binding) u32 {
    return @offsetOf(DrawableUBO, "interpolation0") + binding.factor * @sizeOf(f32);
}

/// Attribute ids, equal to locations, as attributes.glsl declares them.
pub const Attribute = struct { name: []const u8, type: c.mln_plugin_vertex_attribute_type };

pub const attribute_table = [_]Attribute{
    .{ .name = "a_pos", .type = c.MLN_PLUGIN_VERTEX_FLOAT_X3 },
    .{ .name = "a_roof", .type = c.MLN_PLUGIN_VERTEX_FLOAT_X4 },
    .{ .name = "a_height", .type = c.MLN_PLUGIN_VERTEX_FLOAT_X2 },
    .{ .name = "a_base", .type = c.MLN_PLUGIN_VERTEX_FLOAT_X2 },
    .{ .name = "a_roof_height", .type = c.MLN_PLUGIN_VERTEX_FLOAT_X2 },
    .{ .name = "a_roof_angle", .type = c.MLN_PLUGIN_VERTEX_FLOAT_X2 },
    .{ .name = "a_color_min", .type = c.MLN_PLUGIN_VERTEX_UINT8_X4_NORMALIZED },
    .{ .name = "a_color_max", .type = c.MLN_PLUGIN_VERTEX_UINT8_X4_NORMALIZED },
    .{ .name = "a_roof_color_min", .type = c.MLN_PLUGIN_VERTEX_UINT8_X4_NORMALIZED },
    .{ .name = "a_roof_color_max", .type = c.MLN_PLUGIN_VERTEX_UINT8_X4_NORMALIZED },
    .{ .name = "a_opacity", .type = c.MLN_PLUGIN_VERTEX_FLOAT_X2 },
    .{ .name = "a_vertical_gradient", .type = c.MLN_PLUGIN_VERTEX_FLOAT_X2 },
};

/// The two layout attributes in stream 0; the host feeds the rest.
pub const pos_attribute: u32 = 0;
pub const roof_attribute: u32 = 1;

// ---------------------------------------------------------------------------
// Backend wrappers.
// ---------------------------------------------------------------------------

const Backend = enum { gl, vulkan, metal };

const glsl_types =
    \\#define float2 vec2
    \\#define float3 vec3
    \\#define float4 vec4
    \\#define float4x4 mat4
    \\
;

const shared_core = build_options.building_glsl ++ "\n" ++ build_options.properties_glsl ++ "\n";

fn glslVertex(comptime backend: Backend) []const u8 {
    const vk = backend == .vulkan;
    return glsl_types ++
        "#define BUILDING_ATTRIBUTE(l, t, n) layout(location = l) in t n;\n" ++
        "#define BUILDING_ATTR(n) n\n" ++
        build_options.attributes_glsl ++ "\n" ++
        (if (vk) "layout(std140, set = DRAWABLE_UBO_SET_INDEX, binding = MLN_PLUGIN_UNIFORM_0_BINDING) " else "layout(std140) ") ++
        "uniform " ++ uniform_block_name ++ " {\n" ++ build_options.uniforms_glsl ++ "} u;\n" ++
        (if (vk) "layout(location = 0) " else "") ++ "out vec4 v_color;\n" ++
        shared_core ++
        "void main() {\n" ++ build_options.vertex_glsl ++
        "    gl_Position = u.tile_matrix * float4(o.position, 1.0);\n" ++
        "    v_color = o.color;\n" ++
        (if (vk) "    applySurfaceTransform();\n" else "") ++ "}\n";
}

/// The fragment stage only interpolates the per-vertex lighting, as core
/// fill-extrusion does. GL ES fragment shaders default to mediump, so the
/// OpenGL source asks for highp.
fn glslFragment(comptime backend: Backend) []const u8 {
    const vk = backend == .vulkan;
    return (if (vk) "" else "precision highp float;\n") ++
        (if (vk) "layout(location = 0) " else "") ++ "in vec4 v_color;\n" ++
        (if (vk) "layout(location = 0) out vec4 fragColor;\n" else "") ++
        "void main() {\n" ++
        "#if MLN_PLUGIN_COLOR_WRITE\n" ++
        "    fragColor = v_color;\n" ++
        "#else\n" ++
        "    fragColor = vec4(0.0);\n" ++
        "#endif\n" ++
        "}\n";
}

const metal_source = "#define BUILDING_ATTRIBUTE(l, t, n) t n [[attribute(l)]];\n" ++
    "#define BUILDING_ATTR(n) in.n\n" ++
    "struct alignas(16) " ++ uniform_block_name ++ " {\n" ++ build_options.uniforms_glsl ++ "};\n" ++
    "struct BuildingAttributes {\n" ++ build_options.attributes_glsl ++ "};\n" ++
    "struct BuildingVaryings {\n    float4 position [[position]];\n    float4 v_color;\n};\n" ++
    shared_core ++
    "vertex BuildingVaryings " ++ metal_vertex_entry ++ "(BuildingAttributes in [[stage_in]], constant " ++ uniform_block_name ++
    "& u [[buffer(MLN_PLUGIN_UNIFORM_0_BINDING)]]) {\n" ++ build_options.vertex_glsl ++
    "    BuildingVaryings out;\n" ++
    "    out.position = u.tile_matrix * float4(o.position, 1.0);\n" ++
    "    out.v_color = o.color;\n" ++
    "    return out;\n}\n" ++
    "fragment float4 " ++ metal_fragment_entry ++ "(BuildingVaryings in [[stage_in]]) {\n" ++
    "#if MLN_PLUGIN_COLOR_WRITE\n" ++
    "    return in.v_color;\n" ++
    "#else\n" ++
    "    return float4(0.0);\n" ++
    "#endif\n" ++
    "}\n";

pub const Program = struct {
    gl_vertex: []const u8,
    gl_fragment: []const u8,
    vulkan_vertex: []const u8,
    vulkan_fragment: []const u8,
    metal: []const u8,
};

pub const program = Program{
    .gl_vertex = glslVertex(.gl),
    .gl_fragment = glslFragment(.gl),
    .vulkan_vertex = glslVertex(.vulkan),
    .vulkan_fragment = glslFragment(.vulkan),
    .metal = metal_source,
};

// ---------------------------------------------------------------------------
// Descriptor.
// ---------------------------------------------------------------------------

const sources = [_]c.mln_plugin_shader_source_v1{
    .{ .struct_size = @sizeOf(c.mln_plugin_shader_source_v1), .backend = c.MLN_PLUGIN_BACKEND_OPENGL, .vertex_source = str(program.gl_vertex), .fragment_source = str(program.gl_fragment) },
    .{ .struct_size = @sizeOf(c.mln_plugin_shader_source_v1), .backend = c.MLN_PLUGIN_BACKEND_VULKAN, .vertex_source = str(program.vulkan_vertex), .fragment_source = str(program.vulkan_fragment) },
    .{ .struct_size = @sizeOf(c.mln_plugin_shader_source_v1), .backend = c.MLN_PLUGIN_BACKEND_METAL, .vertex_source = str(program.metal), .vertex_entry_point = str(metal_vertex_entry), .fragment_entry_point = str(metal_fragment_entry) },
};

pub const attributes = blk: {
    var result: [attribute_table.len]c.mln_plugin_shader_attribute_v1 = undefined;
    for (attribute_table, 0..) |attribute, id| {
        result[id] = .{ .struct_size = @sizeOf(c.mln_plugin_shader_attribute_v1), .attribute_id = id, .location = id, .name = str(attribute.name), .type = attribute.type };
    }
    break :blk result;
};

pub const uniform_blocks = [_]c.mln_plugin_uniform_block_descriptor_v1{.{
    .struct_size = @sizeOf(c.mln_plugin_uniform_block_descriptor_v1),
    .uniform_id = uniform_id,
    .name = str(uniform_block_name),
    .byte_size = @sizeOf(DrawableUBO),
    .stage_mask = c.MLN_PLUGIN_SHADER_STAGE_VERTEX,
    .scope = c.MLN_PLUGIN_UNIFORM_DRAWABLE,
}};

pub const property_bindings = blk: {
    var result: [bindings.len]c.mln_plugin_shader_property_binding_v1 = undefined;
    for (bindings, 0..) |binding, i| {
        result[i] = .{
            .struct_size = @sizeOf(c.mln_plugin_shader_property_binding_v1),
            .property_name = str(binding.property),
            .encoding = binding.encoding,
            .uniform_id = uniform_id,
            .uniform_byte_offset = @offsetOf(DrawableUBO, binding.field),
            .minimum_attribute_id = binding.minimum_attribute,
            .maximum_attribute_id = binding.maximum_attribute,
            .interpolation_uniform_id = uniform_id,
            .interpolation_uniform_byte_offset = interpolationOffset(binding),
        };
    }
    break :blk result;
};

pub const descriptors = [_]c.mln_plugin_shader_descriptor_v1{.{
    .struct_size = @sizeOf(c.mln_plugin_shader_descriptor_v1),
    .shader_id = str(shader_id),
    .sources = &sources,
    .source_count = sources.len,
    .attributes = &attributes,
    .attribute_count = attributes.len,
    .uniform_blocks = &uniform_blocks,
    .uniform_block_count = uniform_blocks.len,
    .property_bindings = &property_bindings,
    .property_binding_count = property_bindings.len,
}};

// ---------------------------------------------------------------------------
// Offline shader check (`zig build dump-shaders -- <dir>`, see
// dump_shaders.zig): every program as the host would compile it.
// ---------------------------------------------------------------------------

/// Replicas of the host's shader preludes, which the host prepends before
/// the plugin's #defines and source.
pub const HostPreludes = struct {
    gl_vertex: []const u8,
    gl_fragment: []const u8,
    vulkan_vertex: []const u8,
    vulkan_fragment: []const u8,
    metal: []const u8,
};

/// Which of `data_driven` (bit i) arrive as attributes in a variant.
pub const Mask = u6;

fn propertyMacro(comptime name: []const u8) []const u8 {
    return comptime blk: {
        var upper: [name.len]u8 = undefined;
        for (name, 0..) |ch, i| upper[i] = if (std.ascii.isAlphanumeric(ch)) std.ascii.toUpper(ch) else '_';
        const final = upper;
        break :blk "MLN_PLUGIN_PROPERTY_" ++ &final ++ "_IS_UNIFORM";
    };
}

fn isDataDriven(name: []const u8, mask: Mask) bool {
    for (data_driven, 0..) |candidate, i| {
        if (std.mem.eql(u8, candidate, name)) return (mask >> @intCast(i)) & 1 == 1;
    }
    return false;
}

/// The #defines the host puts between its prelude and the plugin source
/// (plugin_shader.cpp resourcePrelude and propertyPrelude). Binding numbers
/// are representative; the shaders only pass them through.
pub fn pluginPrelude(writer: *std.Io.Writer, backend: Backend, mask: Mask, color_write: bool) !void {
    try writer.writeAll("#define MLN_PLUGIN_INSTANCED 0\n");
    if (backend == .metal) try writer.writeAll("#define MLN_PLUGIN_DRAWABLE_INDEX_BINDING 1\n");
    const binding: u32 = switch (backend) {
        .gl => 1,
        .vulkan => 4,
        .metal => 2,
    };
    try writer.print("#define MLN_PLUGIN_UNIFORM_0_BINDING {d}\n#define MLN_PLUGIN_UNIFORM_0_IS_ARRAY 0\n", .{binding});
    try writer.print("#define MLN_PLUGIN_COLOR_WRITE {d}\n#define MLN_PLUGIN_HAS_PATTERN 0\n", .{@intFromBool(color_write)});
    inline for (bindings) |b| {
        try writer.print("#define {s} {d}\n", .{ comptime propertyMacro(b.property), @intFromBool(!isDataDriven(b.property, mask)) });
    }
}

pub fn variantName(allocator: std.mem.Allocator, mask: Mask, color_write: bool) ![]const u8 {
    var name: std.ArrayList(u8) = .empty;
    errdefer name.deinit(allocator);
    try name.appendSlice(allocator, if (color_write) "color" else "depth");
    if (mask == 0) try name.appendSlice(allocator, "-uniform");
    for (data_driven, 0..) |property, i| {
        if ((mask >> @intCast(i)) & 1 == 0) continue;
        try name.append(allocator, '-');
        try name.appendSlice(allocator, property["building-".len..]);
    }
    return name.toOwnedSlice(allocator);
}

fn writeSource(allocator: std.mem.Allocator, io: std.Io, dir: std.Io.Dir, name: []const u8, prelude: []const u8, backend: Backend, mask: Mask, color_write: bool, source: []const u8) !void {
    var text: std.Io.Writer.Allocating = .init(allocator);
    defer text.deinit();
    try text.writer.writeAll(prelude);
    try pluginPrelude(&text.writer, backend, mask, color_write);
    try text.writer.writeAll(source);
    try dir.writeFile(io, .{ .sub_path = name, .data = text.written() });
}

fn dumpVariant(allocator: std.mem.Allocator, io: std.Io, dir: std.Io.Dir, host: HostPreludes, mask: Mask, color_write: bool) !usize {
    const stem = try variantName(allocator, mask, color_write);
    defer allocator.free(stem);
    const files = [_]struct { suffix: []const u8, prelude: []const u8, backend: Backend, source: []const u8 }{
        .{ .suffix = ".gles.vert", .prelude = host.gl_vertex, .backend = .gl, .source = program.gl_vertex },
        .{ .suffix = ".gles.frag", .prelude = host.gl_fragment, .backend = .gl, .source = program.gl_fragment },
        .{ .suffix = ".vulkan.vert", .prelude = host.vulkan_vertex, .backend = .vulkan, .source = program.vulkan_vertex },
        .{ .suffix = ".vulkan.frag", .prelude = host.vulkan_fragment, .backend = .vulkan, .source = program.vulkan_fragment },
        .{ .suffix = ".metal", .prelude = host.metal, .backend = .metal, .source = program.metal },
    };
    for (files) |file| {
        const name = try std.mem.concat(allocator, u8, &.{ stem, file.suffix });
        defer allocator.free(name);
        try writeSource(allocator, io, dir, name, file.prelude, file.backend, mask, color_write, file.source);
    }
    return files.len;
}

/// Writes the building program in every data-driven variant the host can
/// compile with color writes, and in the all-uniform and all-attribute
/// variants of the depth-only pass, per backend: `<variant>.gles.vert`/
/// `.gles.frag` (GLSL ES 3.00), `.vulkan.vert`/`.vulkan.frag` (GLSL 450) and
/// `.metal` (MSL 2.4). Returns the number of files written.
pub fn dump(allocator: std.mem.Allocator, io: std.Io, dir: std.Io.Dir, host: HostPreludes) !usize {
    var count: usize = 0;
    for (0..1 << data_driven.len) |bits| count += try dumpVariant(allocator, io, dir, host, @intCast(bits), true);
    count += try dumpVariant(allocator, io, dir, host, 0, false);
    count += try dumpVariant(allocator, io, dir, host, std.math.maxInt(Mask), false);
    return count;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

fn expectContains(haystack: []const u8, needle: []const u8) !void {
    if (std.mem.indexOf(u8, haystack, needle) == null) {
        std.debug.print("missing: {s}\n", .{needle});
        return error.TestExpectedSubstring;
    }
}

fn expectLacks(haystack: []const u8, needle: []const u8) !void {
    if (std.mem.indexOf(u8, haystack, needle) != null) {
        std.debug.print("unexpected: {s}\n", .{needle});
        return error.TestUnexpectedSubstring;
    }
}

test "shader sources wrap the shared code for every backend" {
    const p = program;
    try expectContains(p.gl_vertex, "#define BUILDING_ATTRIBUTE(l, t, n) layout(location = l) in t n;\n");
    try expectContains(p.gl_vertex, "layout(std140) uniform BuildingDrawableUBO {\n// The members of BuildingDrawableUBO");
    try expectContains(p.gl_vertex, "    float4x4 tile_matrix;");
    try expectContains(p.gl_vertex, "out vec4 v_color;\n");
    try expectContains(p.gl_vertex, "    gl_Position = u.tile_matrix * float4(o.position, 1.0);\n    v_color = o.color;\n}\n");
    try expectContains(p.vulkan_vertex, "layout(std140, set = DRAWABLE_UBO_SET_INDEX, binding = MLN_PLUGIN_UNIFORM_0_BINDING) uniform BuildingDrawableUBO {");
    try expectContains(p.vulkan_vertex, "layout(location = 0) out vec4 v_color;\n");
    try expectContains(p.vulkan_vertex, "    applySurfaceTransform();\n}\n");
    try expectContains(p.gl_fragment, "precision highp float;\nin vec4 v_color;\n");
    try expectLacks(p.gl_fragment, "out vec4 fragColor");
    try expectContains(p.vulkan_fragment, "layout(location = 0) in vec4 v_color;\nlayout(location = 0) out vec4 fragColor;\n");
    try expectContains(p.metal, "struct alignas(16) BuildingDrawableUBO {\n// The members of BuildingDrawableUBO");
    try expectContains(p.metal, "#define BUILDING_ATTRIBUTE(l, t, n) t n [[attribute(l)]];\n#define BUILDING_ATTR(n) in.n\n");
    try expectContains(p.metal, "constant BuildingDrawableUBO& u [[buffer(MLN_PLUGIN_UNIFORM_0_BINDING)]]");
    try expectContains(p.metal, "vertex BuildingVaryings buildingVertexMain(BuildingAttributes in [[stage_in]]");
    try expectContains(p.metal, "fragment float4 buildingFragmentMain(BuildingVaryings in [[stage_in]])");
    inline for (.{ p.gl_vertex, p.vulkan_vertex, p.metal }) |vertex| {
        // The shared core, once, before the main that calls it.
        try std.testing.expectEqual(@as(usize, 1), std.mem.count(u8, vertex, "BuildingVertex buildingVertex("));
        const core = std.mem.indexOf(u8, vertex, "BuildingVertex buildingVertex(").?;
        const main = std.mem.indexOf(u8, vertex, "BuildingVertex o = buildingVertex(").?;
        try std.testing.expect(core < main);
    }
    inline for (.{ p.gl_vertex, p.gl_fragment, p.vulkan_vertex, p.vulkan_fragment, p.metal }) |source| {
        try expectLacks(source, "#version");
        try expectLacks(source, "const float PI");
        try expectLacks(source, "gl_VertexID");
    }
    // Only the fragment stage reads the pass's color-write macro.
    inline for (.{ p.gl_vertex, p.vulkan_vertex }) |vertex| try expectLacks(vertex, "#if MLN_PLUGIN_COLOR_WRITE");
    try std.testing.expectEqual(@as(usize, 1), std.mem.count(u8, p.metal, "#if MLN_PLUGIN_COLOR_WRITE"));
    try std.testing.expect(std.mem.indexOf(u8, p.metal, "#if MLN_PLUGIN_COLOR_WRITE").? > std.mem.indexOf(u8, p.metal, "fragment float4").?);
    inline for (.{ p.gl_vertex, p.vulkan_vertex, p.metal }) |source| {
        var lines = std.mem.splitScalar(u8, source, '\n');
        while (lines.next()) |line| {
            if (std.mem.startsWith(u8, std.mem.trim(u8, line, " "), "#") and std.mem.indexOf(u8, line, "MLN_PLUGIN_COLOR_WRITE") != null)
                try std.testing.expectEqualStrings("#if MLN_PLUGIN_COLOR_WRITE", line);
        }
    }
}

const Member = struct { type: []const u8, name: []const u8, offset: u32 };

/// The members uniforms.glsl declares, laid out under std140 (MSL agrees for
/// float4x4, float4 and float).
fn parseMembers(allocator: std.mem.Allocator) ![]Member {
    var members: std.ArrayList(Member) = .empty;
    errdefer members.deinit(allocator);
    var offset: u32 = 0;
    var lines = std.mem.splitScalar(u8, build_options.uniforms_glsl, '\n');
    while (lines.next()) |line| {
        const code = std.mem.trim(u8, line[0 .. std.mem.indexOf(u8, line, "//") orelse line.len], " ");
        if (code.len == 0) continue;
        var tokens = std.mem.tokenizeAny(u8, code, " ;");
        const type_name = tokens.next().?;
        const name = tokens.next().?;
        const size: u32, const alignment: u32 = if (std.mem.eql(u8, type_name, "float4x4"))
            .{ 64, 16 }
        else if (std.mem.eql(u8, type_name, "float4"))
            .{ 16, 16 }
        else if (std.mem.eql(u8, type_name, "float"))
            .{ 4, 4 }
        else
            return error.UnexpectedMemberType;
        offset = std.mem.alignForward(u32, offset, alignment);
        try members.append(allocator, .{ .type = type_name, .name = name, .offset = offset });
        offset += size;
    }
    try std.testing.expectEqual(@as(u32, @sizeOf(DrawableUBO)), std.mem.alignForward(u32, offset, 16));
    return members.toOwnedSlice(allocator);
}

test "uniforms.glsl matches the Zig block" {
    const members = try parseMembers(std.testing.allocator);
    defer std.testing.allocator.free(members);
    const fields = @typeInfo(DrawableUBO).@"struct".fields;
    try std.testing.expectEqual(fields.len, members.len);
    inline for (fields, 0..) |field, i| {
        try std.testing.expectEqualStrings(field.name, members[i].name);
        try std.testing.expectEqual(@as(u32, @offsetOf(DrawableUBO, field.name)), members[i].offset);
    }
}

test "the shader tables match the rendering contract" {
    var parsed = try std.json.parseFromSlice(std.json.Value, std.testing.allocator, build_options.render_contract_json, .{});
    defer parsed.deinit();
    const contract = parsed.value.object;
    try std.testing.expectEqualStrings(shader_id, contract.get("shaderId").?.string);

    const attribute_types = std.StaticStringMap(c.mln_plugin_vertex_attribute_type).initComptime(.{
        .{ "VERTEX_FLOAT_X2", c.MLN_PLUGIN_VERTEX_FLOAT_X2 },
        .{ "VERTEX_FLOAT_X3", c.MLN_PLUGIN_VERTEX_FLOAT_X3 },
        .{ "VERTEX_FLOAT_X4", c.MLN_PLUGIN_VERTEX_FLOAT_X4 },
        .{ "VERTEX_UINT8_X4_NORMALIZED", c.MLN_PLUGIN_VERTEX_UINT8_X4_NORMALIZED },
    });
    const expected_attributes = contract.get("attributes").?.array.items;
    try std.testing.expectEqual(expected_attributes.len, attributes.len);
    for (expected_attributes, attributes) |expected, actual| {
        const object = expected.object;
        try std.testing.expectEqual(object.get("id").?.integer, actual.attribute_id);
        try std.testing.expectEqual(actual.attribute_id, actual.location);
        try std.testing.expectEqualStrings(object.get("name").?.string, actual.name.data[0..actual.name.size]);
        try std.testing.expectEqual(attribute_types.get(object.get("type").?.string).?, actual.type);
    }

    const block = contract.get("uniformBlock").?.object;
    try std.testing.expectEqual(block.get("id").?.integer, uniform_id);
    try std.testing.expectEqualStrings(uniform_block_name, block.get("name").?.string);
    try std.testing.expectEqual(block.get("byteSize").?.integer, @sizeOf(DrawableUBO));
    try std.testing.expectEqualStrings("UNIFORM_DRAWABLE", block.get("scope").?.string);
    try std.testing.expectEqual(@as(u32, c.MLN_PLUGIN_UNIFORM_DRAWABLE), uniform_blocks[0].scope);
    try std.testing.expectEqual(@as(u32, c.MLN_PLUGIN_SHADER_STAGE_VERTEX), uniform_blocks[0].stage_mask);
    const members = try parseMembers(std.testing.allocator);
    defer std.testing.allocator.free(members);
    const expected_members = block.get("members").?.array.items;
    try std.testing.expectEqual(expected_members.len, members.len);
    for (expected_members, members) |expected, actual| {
        try std.testing.expectEqualStrings(expected.object.get("name").?.string, actual.name);
        try std.testing.expectEqualStrings(expected.object.get("type").?.string, actual.type);
        try std.testing.expectEqual(expected.object.get("offset").?.integer, actual.offset);
    }

    const encodings = std.StaticStringMap(c.mln_plugin_property_encoding_v1).initComptime(.{
        .{ "PROPERTY_ENCODING_FLOAT", c.MLN_PLUGIN_PROPERTY_ENCODING_FLOAT },
        .{ "PROPERTY_ENCODING_COLOR_RGBA8", c.MLN_PLUGIN_PROPERTY_ENCODING_COLOR_RGBA8 },
        .{ "PROPERTY_ENCODING_BOOLEAN_FLOAT", c.MLN_PLUGIN_PROPERTY_ENCODING_BOOLEAN_FLOAT },
    });
    const expected_bindings = contract.get("bindings").?.array.items;
    try std.testing.expectEqual(expected_bindings.len, property_bindings.len);
    for (expected_bindings, property_bindings) |expected, actual| {
        const object = expected.object;
        try std.testing.expectEqualStrings(object.get("property").?.string, actual.property_name.data[0..actual.property_name.size]);
        try std.testing.expectEqual(encodings.get(object.get("encoding").?.string).?, actual.encoding);
        try std.testing.expectEqual(object.get("uniformOffset").?.integer, actual.uniform_byte_offset);
        try std.testing.expectEqual(object.get("minimumAttribute").?.integer, actual.minimum_attribute_id);
        try std.testing.expectEqual(object.get("maximumAttribute").?.integer, actual.maximum_attribute_id);
        try std.testing.expectEqual(object.get("interpolationOffset").?.integer, actual.interpolation_uniform_byte_offset);
        try std.testing.expectEqual(uniform_id, actual.uniform_id);
        try std.testing.expectEqual(uniform_id, actual.interpolation_uniform_id);
    }
}

/// A tiny preprocessor for the shared text: #if NAME, #if !NAME, #else and
/// #endif with every macro 0 or 1; other directives pass through. Returns
/// the lines that survive.
fn preprocess(allocator: std.mem.Allocator, text: []const u8, macros: std.StringHashMapUnmanaged(bool)) ![]const []const u8 {
    var result: std.ArrayList([]const u8) = .empty;
    errdefer result.deinit(allocator);
    var stack: std.ArrayList(struct { active: bool, parent: bool }) = .empty;
    defer stack.deinit(allocator);
    var active = true;
    var lines = std.mem.splitScalar(u8, text, '\n');
    while (lines.next()) |line| {
        const trimmed = std.mem.trim(u8, line, " ");
        if (std.mem.startsWith(u8, trimmed, "#if ")) {
            var name = std.mem.trim(u8, trimmed["#if ".len..], " ");
            const negate = name[0] == '!';
            if (negate) name = name[1..];
            const value = macros.get(name) orelse return error.UndefinedMacro;
            try stack.append(allocator, .{ .active = value != negate, .parent = active });
            active = active and (value != negate);
        } else if (std.mem.eql(u8, trimmed, "#else")) {
            const top = &stack.items[stack.items.len - 1];
            top.active = !top.active;
            active = top.parent and top.active;
        } else if (std.mem.eql(u8, trimmed, "#endif")) {
            const top = stack.pop() orelse return error.UnbalancedEndif;
            active = top.parent;
        } else if (active and trimmed.len > 0 and !std.mem.startsWith(u8, trimmed, "//")) {
            try result.append(allocator, trimmed);
        }
    }
    if (stack.items.len != 0) return error.UnterminatedIf;
    return result.toOwnedSlice(allocator);
}

test "every variant declares exactly the attributes the host binds and the shader reads" {
    const allocator = std.testing.allocator;
    for (0..1 << data_driven.len) |bits| {
        const mask: Mask = @intCast(bits);
        var macros: std.StringHashMapUnmanaged(bool) = .empty;
        defer macros.deinit(allocator);
        inline for (bindings) |b| try macros.put(allocator, comptime propertyMacro(b.property), !isDataDriven(b.property, mask));
        const declared = try preprocess(allocator, build_options.attributes_glsl, macros);
        defer allocator.free(declared);
        // The layout's two, plus each data-driven binding's attributes.
        var expected: usize = 2;
        for (bindings) |b| {
            if (isDataDriven(b.property, mask)) expected += b.maximum_attribute - b.minimum_attribute + 1;
        }
        try std.testing.expectEqual(expected, declared.len);
        for (declared) |line| {
            // BUILDING_ATTRIBUTE(l, t, n): the location is the attribute's id.
            var tokens = std.mem.tokenizeAny(u8, line["BUILDING_ATTRIBUTE(".len..], " ,()");
            const location = try std.fmt.parseInt(u32, tokens.next().?, 10);
            _ = tokens.next();
            const name = tokens.next().?;
            try std.testing.expectEqualStrings(attribute_table[location].name, name);
        }
        // Every attribute the property macros read is declared.
        const used = try preprocess(allocator, build_options.properties_glsl, macros);
        defer allocator.free(used);
        for (used) |line| {
            var start: usize = 0;
            while (std.mem.indexOfPos(u8, line, start, "BUILDING_ATTR(")) |at| {
                const open = at + "BUILDING_ATTR(".len;
                const close = std.mem.indexOfScalarPos(u8, line, open, ')').?;
                var found = false;
                for (declared) |d| found = found or std.mem.indexOf(u8, d, line[open..close]) != null;
                errdefer std.debug.print("{s} read but not declared, mask {b:0>6}\n", .{ line[open..close], bits });
                try std.testing.expect(found);
                start = close;
            }
        }
    }
}

test "plugin prelude and variant names" {
    const allocator = std.testing.allocator;
    var text: std.Io.Writer.Allocating = .init(allocator);
    defer text.deinit();
    try pluginPrelude(&text.writer, .metal, 0b100001, false);
    try expectContains(text.written(), "#define MLN_PLUGIN_UNIFORM_0_BINDING 2\n");
    try expectContains(text.written(), "#define MLN_PLUGIN_COLOR_WRITE 0\n");
    try expectContains(text.written(), "#define MLN_PLUGIN_PROPERTY_BUILDING_HEIGHT_IS_UNIFORM 0\n#define MLN_PLUGIN_PROPERTY_BUILDING_BASE_IS_UNIFORM 1\n");
    try expectContains(text.written(), "#define MLN_PLUGIN_PROPERTY_BUILDING_COLOR_IS_UNIFORM 1\n#define MLN_PLUGIN_PROPERTY_BUILDING_ROOF_COLOR_IS_UNIFORM 0\n");
    try expectContains(text.written(), "#define MLN_PLUGIN_PROPERTY_BUILDING_VERTICAL_GRADIENT_IS_UNIFORM 1\n");
    const name = try variantName(allocator, 0b100001, false);
    defer allocator.free(name);
    try std.testing.expectEqualStrings("depth-height-roof-color", name);
    const uniform = try variantName(allocator, 0, true);
    defer allocator.free(uniform);
    try std.testing.expectEqualStrings("color-uniform", uniform);
}
