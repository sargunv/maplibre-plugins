//! Shader sources and descriptors of both particle layer types. The shared
//! core (../../shaders/particle.glsl for the vertex stage, shape.glsl for the
//! fragment stage) compiles as GLSL ES 3.00 (OpenGL), GLSL 450 (Vulkan) and
//! MSL (Metal); each backend wraps it with its own declarations, and the
//! wrappers' bodies are shared text written against float2/float4 names that
//! GLSL #defines.
//!
//! particle-emitter reads its row of the frame table (properties.TableUBO)
//! and builds the frame from the header with particleEmitterFrame
//! (../../shaders/emitter.glsl). particle-features reads each paint
//! value from its host binding: the uniform block, or the binding's vertex
//! attributes when the value depends on the feature. Properties the features
//! type does not list take their spec defaults, generated here as #defines.

const std = @import("std");
const build_options = @import("build_options");
const c = @import("maplibre_native_c");
const properties = @import("properties.zig");

const str = properties.str;
const FeatureBinding = properties.FeatureBinding;
const feature_bindings = properties.feature_bindings;
const Lane = properties.Lane;
const Header = properties.Header;

pub const emitter_shader_id = "particle-emitter";
pub const features_shader_id = "particle-features";
pub const emitter_uniform_id: u32 = 0;
pub const features_uniform_id: u32 = 1;

/// Upstream MapLibre Native maps each active OpenGL attribute by its linked
/// location, used as an index into the shader's attribute list with the
/// uniform-delivered paint attributes removed (plugin_shader.cpp,
/// shader_program_gl.cpp). While this is true the GL source picks every
/// data-driven attribute's literal location from the other data-driven
/// properties' _IS_UNIFORM macros so it equals that index. Patch 0008
/// (patches/maplibre-native-ffi) matches active attributes by name instead,
/// and the ladder's locations are then ordinary explicit ones, so the ladder
/// is correct on both hosts. Set it to false only once every host carries
/// that fix.
pub const gl_location_ladder = true;

const Backend = enum { gl, vulkan, metal };

fn digits(comptime n: anytype) []const u8 {
    return std.fmt.comptimePrint("{d}", .{n});
}

/// A GLSL/MSL float literal: 1.0, 0.5, -10000.0.
fn float(comptime x: anytype) []const u8 {
    const value: f64 = switch (@typeInfo(@TypeOf(x))) {
        .int, .comptime_int => @floatFromInt(x),
        else => x,
    };
    const text = std.fmt.comptimePrint("{d}", .{value});
    return if (std.mem.indexOfAny(u8, text, ".e") == null) text ++ ".0" else text;
}

fn upperSnake(comptime name: []const u8) []const u8 {
    return comptime blk: {
        @setEvalBranchQuota(100_000);
        var result: [name.len]u8 = undefined;
        for (name, 0..) |ch, i| result[i] = if (std.ascii.isAlphanumeric(ch)) std.ascii.toUpper(ch) else '_';
        const final = result;
        break :blk &final;
    };
}

/// The macro the host defines to 1 when a bound property arrives in the
/// uniform block and to 0 when it arrives in its attributes.
pub fn propertyMacro(comptime name: []const u8) []const u8 {
    return "MLN_PLUGIN_PROPERTY_" ++ upperSnake(name) ++ "_IS_UNIFORM";
}

// ---------------------------------------------------------------------------
// Pieces shared by both shaders.
// ---------------------------------------------------------------------------

const glsl_types =
    \\#define float2 vec2
    \\#define float3 vec3
    \\#define float4 vec4
    \\#define float4x4 mat4
    \\#define uint3 uvec3
    \\#define PARTICLE_ATAN2(y, x) atan(y, x)
    \\
;

/// The GLSL vertex core: type names, the near plane, then particle.glsl.
fn glslCore(comptime backend: Backend) []const u8 {
    return glsl_types ++
        (if (backend == .vulkan) "#define PARTICLE_Z_NEAR 0.0\n" else "#define PARTICLE_Z_NEAR (-1.0)\n") ++
        build_options.particle_glsl ++ "\n";
}

/// MSL: both core files in one unit, before the entry points.
const metal_core = "#define PARTICLE_ATAN2(y, x) atan2(y, x)\n#define PARTICLE_Z_NEAR 0.0\n" ++
    build_options.particle_glsl ++ "\n" ++ build_options.shape_glsl ++ "\n";

/// The three varyings: quad coordinates interpolate; color and look are the
/// same at every corner of a particle, so they are flat.
fn glslVaryings(comptime backend: Backend, comptime direction: []const u8) []const u8 {
    const vk = backend == .vulkan;
    return (if (vk) "layout(location=0) " else "") ++ direction ++ " vec4 v_uv;\n" ++
        (if (vk) "layout(location=1) " else "") ++ "flat " ++ direction ++ " vec4 v_color;\n" ++
        (if (vk) "layout(location=2) " else "") ++ "flat " ++ direction ++ " vec4 v_look;\n";
}

const glsl_output =
    \\    gl_Position = o.position;
    \\    v_uv = o.uv;
    \\    v_color = o.color;
    \\    v_look = o.look;
    \\
;

/// Both shaders share the fragment stage.
fn glslFragment(comptime backend: Backend) []const u8 {
    return (if (backend == .gl) "precision highp float;\n" else "") ++ glsl_types ++
        build_options.shape_glsl ++ "\n" ++ glslVaryings(backend, "in") ++
        (if (backend == .vulkan) "layout(location=0) out vec4 fragColor;\n" else "") ++
        "void main() {\n    fragColor = particleFragment(v_uv, v_color, v_look);\n}\n";
}

const metal_varyings =
    \\struct ParticleVaryings {
    \\    float4 position [[position]];
    \\    float4 v_uv;
    \\    float4 v_color [[flat]];
    \\    float4 v_look [[flat]];
    \\};
    \\
;

const metal_output =
    \\    ParticleVaryings out;
    \\    out.position = o.position;
    \\    out.v_uv = o.uv;
    \\    out.v_color = o.color;
    \\    out.v_look = o.look;
    \\    return out;
    \\
;

fn metalFragment(comptime entry: []const u8) []const u8 {
    return "fragment float4 " ++ entry ++ "(ParticleVaryings in [[stage_in]]) {\n" ++
        "    return particleFragment(in.v_uv, in.v_color, in.v_look);\n}\n";
}

fn blockDeclaration(comptime backend: Backend, comptime uniform_id: u32, comptime name: []const u8, comptime members: []const u8, comptime instance: []const u8) []const u8 {
    return switch (backend) {
        .gl => "layout(std140) uniform " ++ name ++ " {\n" ++ members ++ "} " ++ instance ++ ";\n",
        .vulkan => "layout(std140, set = DRAWABLE_UBO_SET_INDEX, binding = MLN_PLUGIN_UNIFORM_" ++ digits(uniform_id) ++
            "_BINDING) uniform " ++ name ++ " {\n" ++ members ++ "} " ++ instance ++ ";\n",
        .metal => "struct alignas(16) " ++ name ++ " {\n" ++ members ++ "};\n",
    };
}

// ---------------------------------------------------------------------------
// particle-emitter: a_particle = (vertex index, table row).
// ---------------------------------------------------------------------------

const table_members = "    float4 header[" ++ digits(properties.header_vec4s) ++ "];\n" ++
    "    float4 rows[" ++ digits(properties.max_rows * properties.row_vec4s) ++ "];\n";

fn header(comptime h: Header) []const u8 {
    return "t.header[" ++ digits(@intFromEnum(h)) ++ "]";
}

fn row(comptime lane: Lane) []const u8 {
    return "t.rows[b + " ++ digits(@intFromEnum(lane)) ++ "u]";
}

/// particleEmitterFrame, which the emitter's main calls: the shared text of
/// ../../shaders/emitter.glsl, after the core in every backend.
const emitter_functions = build_options.emitter_glsl ++ "\n";

const params_from_row = blk: {
    var result: []const u8 = "            ParticleParams P;\n";
    for (@intFromEnum(properties.first_params_lane)..@intFromEnum(properties.last_params_lane) + 1) |i| {
        const lane: Lane = @enumFromInt(i);
        result = result ++ "            P." ++ lane.member() ++ " = " ++ row(lane) ++ ";\n";
    }
    break :blk result;
};

/// Expects `particle` (the a_particle value) and the table `t`; leaves `o`.
const emitter_body = "    ParticleVertex o = particleCollapsed();\n" ++
    "    uint v = uint(particle.x + 0.5);\n" ++
    "    uint r = uint(particle.y + 0.5);\n" ++
    "    float4 clock = " ++ header(.clock) ++ ";\n" ++
    "    if (float(r) < clock.z) {\n" ++
    "        uint b = r * " ++ digits(properties.row_vec4s) ++ "u;\n" ++
    "        if (v < 4u) {\n" ++
    "            o = particleTint(" ++ row(.tint) ++ ", " ++ row(.extra) ++ ".x, float(v));\n" ++
    "        } else {\n" ++
    params_from_row ++
    "            P = particleClampParams(P);\n" ++
    "            float4 identity = particleIdentity(P.emission.w);\n" ++
    "            ParticleFrame F = particleEmitterFrame(" ++ header(.p_rel0) ++ ", " ++ header(.p_rel1) ++ ", " ++ header(.p_rel2) ++ ", " ++
    header(.p_rel3) ++ ", " ++ header(.screen) ++ ", " ++ header(.view) ++ ", " ++ header(.eye) ++ ", " ++ row(.placement) ++ ", identity.z, identity.w);\n" ++
    "            ParticleWeather W;\n" ++
    "            W.eye = float4(0.0, 0.0, 0.0, 0.0);\n" ++
    "            W.pool0 = W.eye;\n" ++
    "            W.pool1 = W.eye;\n" ++
    "            W.weights = W.eye;\n" ++
    "            if (identity.w > 1.5) {\n" ++
    "                W.eye = " ++ header(.eye) ++ ";\n" ++
    "                W.pool0 = " ++ header(.pool0) ++ ";\n" ++
    "                W.pool1 = " ++ header(.pool1) ++ ";\n" ++
    "                W.weights = " ++ header(.weights) ++ ";\n" ++
    "            }\n" ++
    "            ParticleSeed S = particleEmitterSeed(P, float((v - 4u) >> 2u), float(v & 3u));\n" ++
    "            o = particleVertex(P, F, W, S, clock.x);\n" ++
    "        }\n" ++
    "    }\n";

fn emitterGlslVertex(comptime backend: Backend) []const u8 {
    return glslCore(backend) ++
        "layout(location=0) in vec2 a_particle;\n" ++
        blockDeclaration(backend, emitter_uniform_id, "ParticleTableUBO", table_members, "t") ++
        glslVaryings(backend, "out") ++ emitter_functions ++
        "void main() {\n    float2 particle = a_particle;\n" ++ emitter_body ++ glsl_output ++
        (if (backend == .vulkan) "    applySurfaceTransform();\n" else "") ++ "}\n";
}

const emitter_metal = metal_core ++
    blockDeclaration(.metal, emitter_uniform_id, "ParticleTableUBO", table_members, "t") ++
    "struct ParticleEmitterAttributes {\n    float2 a_particle [[attribute(0)]];\n};\n" ++
    metal_varyings ++ emitter_functions ++
    "vertex ParticleVaryings particleEmitterVertex(ParticleEmitterAttributes in [[stage_in]], constant ParticleTableUBO& t [[buffer(MLN_PLUGIN_UNIFORM_" ++
    digits(emitter_uniform_id) ++ "_BINDING)]]) {\n    float2 particle = in.a_particle;\n" ++ emitter_body ++ metal_output ++ "}\n" ++
    metalFragment("particleEmitterFragment");

// ---------------------------------------------------------------------------
// particle-features: a_emit plus the host bindings.
// ---------------------------------------------------------------------------

const Member = struct { type: []const u8, name: []const u8 };

/// ParticleFeatureUBO as GLSL and MSL declare it; the test below lays it out
/// under std140 and compares it with properties.FeatureUBO.
const feature_members = [_]Member{
    .{ .type = "float4x4", .name = "matrix" },
    .{ .type = "float4", .name = "camera" },
    .{ .type = "float4", .name = "screen" },
    .{ .type = "float4", .name = "color" },
    .{ .type = "float2", .name = "size" },
    .{ .type = "float2", .name = "lifetime" },
    .{ .type = "float2", .name = "speed" },
    .{ .type = "float2", .name = "direction" },
    .{ .type = "float2", .name = "spread" },
    .{ .type = "float2", .name = "wander" },
    .{ .type = "float2", .name = "fade" },
    .{ .type = "float2", .name = "additive" },
    .{ .type = "float2", .name = "twinkle" },
    .{ .type = "float", .name = "density" },
    .{ .type = "float", .name = "shape" },
    .{ .type = "float", .name = "gravity" },
    .{ .type = "float", .name = "stretch" },
    .{ .type = "float2", .name = "pad" },
    // Four vec4s, not float[16]: std140 pads float array elements to 16 B.
    .{ .type = "float4", .name = "interpolation0" },
    .{ .type = "float4", .name = "interpolation1" },
    .{ .type = "float4", .name = "interpolation2" },
    .{ .type = "float4", .name = "interpolation3" },
};

const feature_members_text = blk: {
    var result: []const u8 = "";
    for (feature_members) |member| result = result ++ "    " ++ member.type ++ " " ++ member.name ++ ";\n";
    break :blk result;
};

/// Bindings in declared-location order.
const bindings_by_location = blk: {
    @setEvalBranchQuota(100_000);
    var result: [feature_bindings.len]FeatureBinding = undefined;
    var n = 0;
    for (1..properties.feature_attribute_count) |location| {
        for (feature_bindings) |binding| {
            if (binding.attribute == location) {
                result[n] = binding;
                n += 1;
            }
        }
    }
    std.debug.assert(n == feature_bindings.len);
    break :blk result;
};

/// The data-driven bindings in declared-location order: the GL ladder.
const ladder = blk: {
    @setEvalBranchQuota(100_000);
    var result: [properties.features_data_driven.len]FeatureBinding = undefined;
    var n = 0;
    for (bindings_by_location) |binding| {
        if (binding.dataDriven()) {
            result[n] = binding;
            n += 1;
        }
    }
    break :blk result;
};

fn glslAttributeType(comptime binding: FeatureBinding) []const u8 {
    return if (binding.attributeType() == c.MLN_PLUGIN_VERTEX_FLOAT_X2) "vec2" else "vec4";
}

fn attributeDeclarations(comptime backend: Backend, comptime binding: FeatureBinding, comptime first_location: u32) []const u8 {
    return comptime blk: {
        var result: []const u8 = "";
        for (0..binding.slots()) |slot| {
            const location = digits(first_location + slot);
            const name = binding.attributeName(slot);
            result = result ++ switch (backend) {
                .gl, .vulkan => "layout(location=" ++ location ++ ") in " ++ glslAttributeType(binding) ++ " " ++ name ++ ";\n",
                .metal => "    " ++ (if (binding.attributeType() == c.MLN_PLUGIN_VERTEX_FLOAT_X2) "float2 " else "float4 ") ++ name ++
                    " [[attribute(" ++ location ++ ")]];\n",
            };
        }
        break :blk result;
    };
}

/// GL: the location of ladder[index] is 1 plus the slots of the data-driven
/// properties before it, chosen by nested #if on their macros (GLSL ES 3.00
/// needs a literal location).
fn ladderBranches(comptime index: usize, comptime predecessor: usize, comptime base: u32) []const u8 {
    if (predecessor == index) return attributeDeclarations(.gl, ladder[index], base);
    const previous = ladder[predecessor];
    return "#if " ++ propertyMacro(previous.name) ++ "\n" ++
        ladderBranches(index, predecessor + 1, base) ++
        "#else\n" ++
        ladderBranches(index, predecessor + 1, base + previous.slots()) ++
        "#endif\n";
}

/// Every binding's attributes exist only while the host delivers them as
/// attributes. Camera- and constant-only properties are always uniform, so
/// their declarations never compile.
fn featureAttributes(comptime backend: Backend) []const u8 {
    return comptime blk: {
        @setEvalBranchQuota(1_000_000);
        var result: []const u8 = if (backend == .metal) "    float4 a_emit [[attribute(0)]];\n" else "layout(location=0) in vec4 a_emit;\n";
        for (bindings_by_location) |binding| {
            result = result ++ "#if !" ++ propertyMacro(binding.name) ++ "\n";
            const ladder_index: ?usize = for (ladder, 0..) |step, i| {
                if (std.mem.eql(u8, step.name, binding.name)) break i;
            } else null;
            if (backend == .gl and gl_location_ladder and ladder_index != null) {
                result = result ++ ladderBranches(ladder_index.?, 0, 1);
            } else {
                result = result ++ attributeDeclarations(backend, binding, binding.attribute);
            }
            result = result ++ "#endif\n";
        }
        break :blk result;
    };
}

fn localName(comptime binding: FeatureBinding) []const u8 {
    return "p_" ++ binding.field;
}

/// Binding k's interpolation factor: u.interpolation<k / 4>.<xyzw[k % 4]>.
fn interpolation(comptime k: usize) []const u8 {
    return "u.interpolation" ++ digits(k / 4) ++ "." ++ &[_]u8{"xyzw"[k % 4]};
}

/// Each value from the uniform block, or from its attributes: floats and
/// colors interpolate by the binding's factor, enums select.
fn featureFetch(comptime attribute_prefix: []const u8) []const u8 {
    return comptime blk: {
        @setEvalBranchQuota(1_000_000);
        var result: []const u8 = "";
        for (feature_bindings, 0..) |binding, k| {
            const a = attribute_prefix ++ binding.attributeName(0);
            const t = interpolation(k);
            const Fetch = struct { type: []const u8, mixed: []const u8 };
            const fetch: Fetch = switch (binding.property().type) {
                .float => .{ .type = "float", .mixed = "mix(" ++ a ++ ".x, " ++ a ++ ".y, " ++ t ++ ")" },
                .enumeration => .{ .type = "float", .mixed = "(" ++ t ++ " < 0.5 ? " ++ a ++ ".x : " ++ a ++ ".y)" },
                .float2 => .{ .type = "float2", .mixed = "mix(" ++ a ++ ".xy, " ++ a ++ ".zw, " ++ t ++ ")" },
                .color => .{ .type = "float4", .mixed = "mix(" ++ a ++ ", " ++ attribute_prefix ++ binding.attributeName(1) ++ ", " ++ t ++ ")" },
                .double2 => unreachable,
            };
            result = result ++ "    " ++ fetch.type ++ " " ++ localName(binding) ++ " = u." ++ binding.field ++ ";\n" ++
                "#if !" ++ propertyMacro(binding.name) ++ "\n    " ++ localName(binding) ++ " = " ++ fetch.mixed ++ ";\n#endif\n";
        }
        break :blk result;
    };
}

fn defaultMacro(comptime name: []const u8) []const u8 {
    return "PARTICLE_DEFAULT_" ++ upperSnake(name);
}

/// A property's spec default as a shader value (colors premultiplied, as the
/// host delivers them; enums as their index).
fn defaultLiteral(comptime property: properties.Property) []const u8 {
    const d = property.default;
    return switch (property.type) {
        .float, .enumeration => float(d[0]),
        .float2, .double2 => "float2(" ++ float(d[0]) ++ ", " ++ float(d[1]) ++ ")",
        .color => "float4(" ++ float(d[0] * d[3]) ++ ", " ++ float(d[1] * d[3]) ++ ", " ++ float(d[2] * d[3]) ++ ", " ++ float(d[3]) ++ ")",
    };
}

/// #defines for every property the features type does not list.
const feature_defaults = blk: {
    @setEvalBranchQuota(100_000);
    var result: []const u8 = "// Spec defaults of the properties particle-features does not list.\n";
    for (properties.canonical) |property| {
        if (properties.contains(&properties.features_names, property.name)) continue;
        result = result ++ "#define " ++ defaultMacro(property.name) ++ " " ++ defaultLiteral(property) ++ "\n";
    }
    break :blk result;
};

fn findBinding(comptime name: []const u8) ?FeatureBinding {
    for (feature_bindings) |binding| {
        if (std.mem.eql(u8, binding.name, name)) return binding;
    }
    return null;
}

/// A property's value in the features shader: the fetched local, or its
/// default.
fn featureValue(comptime name: []const u8) []const u8 {
    return if (findBinding(name)) |binding| localName(binding) else defaultMacro(name);
}

comptime {
    // Features draw like a ground-space emitter at scale 1 with no end color
    // and full opacity; the frame and the colorEnd lane below rely on it.
    std.debug.assert(properties.find("particle-scale").default[0] == 1);
    std.debug.assert(std.mem.eql(u8, properties.find("particle-space").values[@intFromFloat(properties.find("particle-space").default[0])], "ground"));
    std.debug.assert(properties.find("particle-color-end").default[3] == 0);
    std.debug.assert(properties.find("particle-opacity").default[0] == 1);
    std.debug.assert(!properties.contains(&properties.features_names, "particle-color-end"));
    std.debug.assert(!properties.contains(&properties.features_names, "particle-opacity"));
    std.debug.assert(!properties.contains(&properties.features_names, "emitter-kind"));
}

/// ParticleParams from the lane map (properties.emitter_lanes), so the
/// features shader fills every lane exactly as the emitter's row does.
fn featureParams() []const u8 {
    return comptime blk: {
        @setEvalBranchQuota(1_000_000);
        var result: []const u8 = "    ParticleParams P;\n";
        for (@intFromEnum(properties.first_params_lane)..@intFromEnum(properties.last_params_lane) + 1) |i| {
            const lane: Lane = @enumFromInt(i);
            var pieces: []const u8 = "";
            var width = 0;
            for (0..4) |component| {
                for (properties.emitter_lanes) |entry| {
                    if (entry.lane != lane or entry.component != component) continue;
                    const Piece = struct { text: []const u8, width: usize };
                    const piece: Piece = switch (entry.use) {
                        .raw, .clamped => .{ .text = featureValue(entry.name), .width = properties.find(entry.name).width() },
                        // colorEnd over color with a transparent end is color;
                        // the opacity default of 1 leaves both unchanged.
                        .color => .{ .text = featureValue("particle-color"), .width = 4 },
                        // Four properties share the identity component.
                        .identity => if (entry.weight == 1) .{ .text = "packedIdentity", .width = 1 } else continue,
                        .opacity, .position => continue,
                    };
                    pieces = pieces ++ (if (width == 0) "" else ", ") ++ piece.text;
                    width += piece.width;
                }
            }
            if (width != 4) @compileError("lane " ++ @tagName(lane) ++ " is not fully covered");
            const expression = if (std.mem.indexOfScalar(u8, pieces, ',') == null) pieces else "float4(" ++ pieces ++ ")";
            result = result ++ "    P." ++ lane.member() ++ " = " ++ expression ++ ";\n";
        }
        break :blk result ++ "    P = particleClampParams(P);\n";
    };
}

/// The packed identity: features are kind 3 with the shape they fetch (or
/// its default) and every other identity part at its default.
fn featureIdentity() []const u8 {
    return comptime blk: {
        var terms: []const u8 = "";
        for (properties.emitter_lanes) |entry| {
            if (entry.use != .identity) continue;
            const property = properties.find(entry.name);
            const value = if (std.mem.eql(u8, entry.name, "emitter-kind"))
                float(properties.identity.feature_kind)
            else if (property.type == .enumeration and findBinding(entry.name) != null)
                "clamp(floor(" ++ featureValue(entry.name) ++ " + 0.5), 0.0, " ++ float(property.values.len - 1) ++ ")"
            else
                featureValue(entry.name);
            terms = terms ++ (if (terms.len == 0) "" else " + ") ++ (if (entry.weight == 1) value else float(entry.weight) ++ " * " ++ value);
        }
        break :blk "    float packedIdentity = " ++ terms ++ ";\n";
    };
}

/// Expects `emit` (a_emit), the fetched values and the block `u`; leaves `o`.
const features_body = featureIdentity() ++ featureParams() ++
    \\    float ptu = u.camera.x;
    \\    ParticleFrame F;
    \\    F.C = u.matrix * float4(emit.xy, 0.0, 1.0);
    \\    F.X = u.matrix[0] * ptu;
    \\    F.Y = -u.matrix[1] * ptu;
    \\    F.Z = float4(0.0, -u.screen.y * u.camera.w, 0.0, 0.0);
    \\    F.screen = u.screen;
    \\    F.view = float4(u.camera.w, u.camera.y, 1.0, 1.0);
    \\    ParticleWeather W;
    \\    W.eye = float4(0.0, 0.0, 0.0, 0.0);
    \\    W.pool0 = W.eye;
    \\    W.pool1 = W.eye;
    \\    W.weights = W.eye;
    \\
++ "    ParticleSeed S = particleFeatureSeed(emit, " ++ featureValue("particle-density") ++ ", ptu);\n" ++
    "    ParticleVertex o = particleVertex(P, F, W, S, u.camera.z);\n";

fn featuresGlslVertex(comptime backend: Backend) []const u8 {
    return glslCore(backend) ++ feature_defaults ++ featureAttributes(backend) ++
        blockDeclaration(backend, features_uniform_id, "ParticleFeatureUBO", feature_members_text, "u") ++
        glslVaryings(backend, "out") ++
        "void main() {\n    float4 emit = a_emit;\n" ++ featureFetch("") ++ features_body ++ glsl_output ++
        (if (backend == .vulkan) "    applySurfaceTransform();\n" else "") ++ "}\n";
}

const features_metal = metal_core ++ feature_defaults ++
    blockDeclaration(.metal, features_uniform_id, "ParticleFeatureUBO", feature_members_text, "u") ++
    "struct ParticleFeaturesAttributes {\n" ++ featureAttributes(.metal) ++ "};\n" ++ metal_varyings ++
    "vertex ParticleVaryings particleFeaturesVertex(ParticleFeaturesAttributes in [[stage_in]], constant ParticleFeatureUBO& u [[buffer(MLN_PLUGIN_UNIFORM_" ++
    digits(features_uniform_id) ++ "_BINDING)]]) {\n    float4 emit = in.a_emit;\n" ++ featureFetch("in.") ++ features_body ++ metal_output ++ "}\n" ++
    metalFragment("particleFeaturesFragment");

// ---------------------------------------------------------------------------
// Descriptors.
// ---------------------------------------------------------------------------

/// Sources per backend, in the order dump() and the tests use them.
pub const Program = struct {
    gl_vertex: []const u8,
    gl_fragment: []const u8,
    vulkan_vertex: []const u8,
    vulkan_fragment: []const u8,
    metal: []const u8,
    metal_vertex_entry: []const u8,
    metal_fragment_entry: []const u8,

    fn sources(comptime self: Program) [3]c.mln_plugin_shader_source_v1 {
        return .{
            .{ .struct_size = @sizeOf(c.mln_plugin_shader_source_v1), .backend = c.MLN_PLUGIN_BACKEND_OPENGL, .vertex_source = str(self.gl_vertex), .fragment_source = str(self.gl_fragment) },
            .{ .struct_size = @sizeOf(c.mln_plugin_shader_source_v1), .backend = c.MLN_PLUGIN_BACKEND_VULKAN, .vertex_source = str(self.vulkan_vertex), .fragment_source = str(self.vulkan_fragment) },
            .{ .struct_size = @sizeOf(c.mln_plugin_shader_source_v1), .backend = c.MLN_PLUGIN_BACKEND_METAL, .vertex_source = str(self.metal), .vertex_entry_point = str(self.metal_vertex_entry), .fragment_entry_point = str(self.metal_fragment_entry) },
        };
    }
};

pub const emitter_program = Program{
    .gl_vertex = emitterGlslVertex(.gl),
    .gl_fragment = glslFragment(.gl),
    .vulkan_vertex = emitterGlslVertex(.vulkan),
    .vulkan_fragment = glslFragment(.vulkan),
    .metal = emitter_metal,
    .metal_vertex_entry = "particleEmitterVertex",
    .metal_fragment_entry = "particleEmitterFragment",
};

pub const features_program = Program{
    .gl_vertex = featuresGlslVertex(.gl),
    .gl_fragment = glslFragment(.gl),
    .vulkan_vertex = featuresGlslVertex(.vulkan),
    .vulkan_fragment = glslFragment(.vulkan),
    .metal = features_metal,
    .metal_vertex_entry = "particleFeaturesVertex",
    .metal_fragment_entry = "particleFeaturesFragment",
};

fn attribute(comptime id: u32, comptime name: []const u8, comptime attribute_type: c.mln_plugin_vertex_attribute_type) c.mln_plugin_shader_attribute_v1 {
    return .{ .struct_size = @sizeOf(c.mln_plugin_shader_attribute_v1), .attribute_id = id, .location = id, .name = str(name), .type = attribute_type };
}

fn vertexBinding(comptime id: u32) c.mln_plugin_attribute_binding_v1 {
    return .{ .struct_size = @sizeOf(c.mln_plugin_attribute_binding_v1), .attribute_id = id, .stream_id = 0, .byte_offset = 0 };
}

const emitter_sources = emitter_program.sources();
const emitter_attributes = [_]c.mln_plugin_shader_attribute_v1{attribute(0, "a_particle", c.MLN_PLUGIN_VERTEX_FLOAT_X2)};
const emitter_blocks = [_]c.mln_plugin_uniform_block_descriptor_v1{.{
    .struct_size = @sizeOf(c.mln_plugin_uniform_block_descriptor_v1),
    .uniform_id = emitter_uniform_id,
    .name = str("ParticleTableUBO"),
    .byte_size = @sizeOf(properties.TableUBO),
    .stage_mask = c.MLN_PLUGIN_SHADER_STAGE_VERTEX,
    .scope = c.MLN_PLUGIN_UNIFORM_LAYER,
}};

pub const emitter_shaders = [_]c.mln_plugin_shader_descriptor_v1{.{
    .struct_size = @sizeOf(c.mln_plugin_shader_descriptor_v1),
    .shader_id = str(emitter_shader_id),
    .sources = &emitter_sources,
    .source_count = emitter_sources.len,
    .attributes = &emitter_attributes,
    .attribute_count = emitter_attributes.len,
    .uniform_blocks = &emitter_blocks,
    .uniform_block_count = emitter_blocks.len,
    .property_bindings = null,
    .property_binding_count = 0,
}};

/// The emitter drawable's one stream: a_particle = (v, row) as two f32.
pub const emitter_vertex_bindings = [_]c.mln_plugin_attribute_binding_v1{vertexBinding(0)};

const features_sources = features_program.sources();

const features_attributes = blk: {
    @setEvalBranchQuota(100_000);
    var result: [properties.feature_attribute_count]c.mln_plugin_shader_attribute_v1 = undefined;
    result[0] = attribute(0, "a_emit", c.MLN_PLUGIN_VERTEX_FLOAT_X4);
    for (feature_bindings) |binding| {
        for (0..binding.slots()) |slot| result[binding.attribute + slot] = attribute(binding.attribute + slot, binding.attributeName(slot), binding.attributeType());
    }
    break :blk result;
};

const features_blocks = [_]c.mln_plugin_uniform_block_descriptor_v1{.{
    .struct_size = @sizeOf(c.mln_plugin_uniform_block_descriptor_v1),
    .uniform_id = features_uniform_id,
    .name = str("ParticleFeatureUBO"),
    .byte_size = @sizeOf(properties.FeatureUBO),
    .stage_mask = c.MLN_PLUGIN_SHADER_STAGE_VERTEX,
    .scope = c.MLN_PLUGIN_UNIFORM_DRAWABLE,
}};

const features_bindings = blk: {
    @setEvalBranchQuota(100_000);
    var result: [feature_bindings.len]c.mln_plugin_shader_property_binding_v1 = undefined;
    for (feature_bindings, 0..) |binding, k| {
        result[k] = .{
            .struct_size = @sizeOf(c.mln_plugin_shader_property_binding_v1),
            .property_name = str(binding.name),
            .encoding = binding.encoding(),
            .uniform_id = features_uniform_id,
            .uniform_byte_offset = @offsetOf(properties.FeatureUBO, binding.field),
            .minimum_attribute_id = binding.attribute,
            .maximum_attribute_id = binding.attribute + binding.slots() - 1,
            .interpolation_uniform_id = features_uniform_id,
            .interpolation_uniform_byte_offset = properties.interpolationOffset(k),
        };
    }
    break :blk result;
};

pub const features_shaders = [_]c.mln_plugin_shader_descriptor_v1{.{
    .struct_size = @sizeOf(c.mln_plugin_shader_descriptor_v1),
    .shader_id = str(features_shader_id),
    .sources = &features_sources,
    .source_count = features_sources.len,
    .attributes = &features_attributes,
    .attribute_count = features_attributes.len,
    .uniform_blocks = &features_blocks,
    .uniform_block_count = features_blocks.len,
    .property_bindings = &features_bindings,
    .property_binding_count = features_bindings.len,
}};

/// The features drawable's one stream: a_emit as four f32. The host feeds
/// the binding attributes itself.
pub const features_vertex_bindings = [_]c.mln_plugin_attribute_binding_v1{vertexBinding(0)};

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

/// Which of properties.features_data_driven (bit i) are data-driven in a
/// features shader variant.
pub const Mask = u4;

/// The #defines the host puts between its prelude and the plugin source
/// (plugin_shader.cpp resourcePrelude and propertyPrelude). Binding numbers
/// are representative; the shaders only pass them through.
pub fn pluginPrelude(writer: *std.Io.Writer, backend: Backend, uniform_id: u32, mask: ?Mask) !void {
    if (backend == .metal) try writer.writeAll("#define MLN_PLUGIN_DRAWABLE_INDEX_BINDING 1\n");
    const binding: u32 = switch (backend) {
        .gl => 1,
        .vulkan => 4,
        .metal => 2,
    };
    try writer.print("#define MLN_PLUGIN_UNIFORM_{d}_BINDING {d}\n#define MLN_PLUGIN_UNIFORM_{d}_IS_ARRAY 0\n", .{ uniform_id, binding, uniform_id });
    const bits = mask orelse return;
    inline for (feature_bindings) |b| {
        const data_driven = inline for (properties.features_data_driven, 0..) |name, i| {
            if (comptime std.mem.eql(u8, name, b.name)) break (bits >> i) & 1 == 1;
        } else false;
        try writer.print("#define {s} {d}\n", .{ comptime propertyMacro(b.name), @intFromBool(!data_driven) });
    }
}

pub fn maskName(allocator: std.mem.Allocator, mask: Mask) ![]const u8 {
    if (mask == 0) return allocator.dupe(u8, "none");
    var name: std.ArrayList(u8) = .empty;
    errdefer name.deinit(allocator);
    for (properties.features_data_driven, 0..) |property, i| {
        if ((mask >> @intCast(i)) & 1 == 0) continue;
        if (name.items.len > 0) try name.append(allocator, '-');
        try name.appendSlice(allocator, property["particle-".len..]);
    }
    return name.toOwnedSlice(allocator);
}

fn writeSource(allocator: std.mem.Allocator, io: std.Io, dir: std.Io.Dir, name: []const u8, prelude: []const u8, backend: Backend, uniform_id: u32, mask: ?Mask, source: []const u8) !void {
    var text: std.Io.Writer.Allocating = .init(allocator);
    defer text.deinit();
    try text.writer.writeAll(prelude);
    try pluginPrelude(&text.writer, backend, uniform_id, mask);
    try text.writer.writeAll(source);
    try dir.writeFile(io, .{ .sub_path = name, .data = text.written() });
}

fn dumpProgram(allocator: std.mem.Allocator, io: std.Io, dir: std.Io.Dir, host: HostPreludes, stem: []const u8, program: Program, uniform_id: u32, mask: ?Mask) !usize {
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
        try writeSource(allocator, io, dir, name, file.prelude, file.backend, uniform_id, mask, file.source);
    }
    return files.len;
}

/// Writes the emitter program and the features program in all 16
/// data-driven variants, per backend: `<stem>.gles.vert`/`.gles.frag`
/// (GLSL ES 3.00), `.vulkan.vert`/`.vulkan.frag` (GLSL 450) and `.metal`
/// (MSL 2.4). Returns the number of files written.
pub fn dump(allocator: std.mem.Allocator, io: std.Io, dir: std.Io.Dir, host: HostPreludes) !usize {
    var count = try dumpProgram(allocator, io, dir, host, "emitter", emitter_program, emitter_uniform_id, null);
    for (0..16) |bits| {
        const mask: Mask = @intCast(bits);
        const name = try maskName(allocator, mask);
        defer allocator.free(name);
        const stem = try std.mem.concat(allocator, u8, &.{ "features-", name });
        defer allocator.free(stem);
        count += try dumpProgram(allocator, io, dir, host, stem, features_program, features_uniform_id, mask);
    }
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

test "shader sources declare the host interface" {
    const e = emitter_program;
    try expectContains(e.gl_vertex, "layout(location=0) in vec2 a_particle;");
    try expectContains(e.gl_vertex, "layout(std140) uniform ParticleTableUBO {\n    float4 header[12];\n    float4 rows[240];\n} t;");
    try expectContains(e.gl_vertex, "#define PARTICLE_Z_NEAR (-1.0)");
    try expectContains(e.vulkan_vertex, "layout(std140, set = DRAWABLE_UBO_SET_INDEX, binding = MLN_PLUGIN_UNIFORM_0_BINDING) uniform ParticleTableUBO");
    try expectContains(e.vulkan_vertex, "#define PARTICLE_Z_NEAR 0.0");
    try expectContains(e.vulkan_vertex, "    applySurfaceTransform();\n}\n");
    try expectContains(e.metal, "struct alignas(16) ParticleTableUBO {\n    float4 header[12];\n    float4 rows[240];\n};");
    try expectContains(e.metal, "constant ParticleTableUBO& t [[buffer(MLN_PLUGIN_UNIFORM_0_BINDING)]]");
    try expectContains(e.metal, "float2 a_particle [[attribute(0)]];");
    try expectContains(e.metal, "vertex ParticleVaryings particleEmitterVertex(");
    try expectContains(e.metal, "fragment float4 particleEmitterFragment(");
    // The emitter reads its row at the lanes of properties.Lane.
    try expectContains(e.gl_vertex, "o = particleTint(t.rows[b + 13u], t.rows[b + 14u].x, float(v));");
    try expectContains(e.gl_vertex, "P.color = t.rows[b + 1u];");
    try expectContains(e.gl_vertex, "P.area = t.rows[b + 12u];");
    try expectContains(e.gl_vertex, "float4 clock = t.header[4];");

    const f = features_program;
    try expectContains(f.gl_vertex, "layout(location=0) in vec4 a_emit;");
    try expectContains(f.gl_vertex, "layout(std140) uniform ParticleFeatureUBO {\n    float4x4 matrix;");
    try expectContains(f.vulkan_vertex, "layout(std140, set = DRAWABLE_UBO_SET_INDEX, binding = MLN_PLUGIN_UNIFORM_1_BINDING) uniform ParticleFeatureUBO");
    try expectContains(f.vulkan_vertex, "#if !MLN_PLUGIN_PROPERTY_PARTICLE_STRETCH_IS_UNIFORM\nlayout(location=15) in vec2 a_particle_stretch;\n#endif\n");
    try expectContains(f.metal, "constant ParticleFeatureUBO& u [[buffer(MLN_PLUGIN_UNIFORM_1_BINDING)]]");
    try expectContains(f.metal, "#if !MLN_PLUGIN_PROPERTY_PARTICLE_COLOR_IS_UNIFORM\n    float4 a_particle_color_min [[attribute(1)]];\n    float4 a_particle_color_max [[attribute(2)]];\n#endif\n");
    try expectContains(f.metal, "    float2 a_particle_stretch [[attribute(15)]];");
    try expectContains(f.metal, "vertex ParticleVaryings particleFeaturesVertex(");
    // Value fetches: binding k's factor is interpolation<k / 4>.<xyzw[k % 4]>.
    try expectContains(f.gl_vertex, "    float4 p_color = u.color;\n#if !MLN_PLUGIN_PROPERTY_PARTICLE_COLOR_IS_UNIFORM\n    p_color = mix(a_particle_color_min, a_particle_color_max, u.interpolation2.z);\n#endif\n");
    try expectContains(f.gl_vertex, "    p_shape = (u.interpolation1.w < 0.5 ? a_particle_shape.x : a_particle_shape.y);");
    try expectContains(f.gl_vertex, "    p_size = mix(a_particle_size.xy, a_particle_size.zw, u.interpolation2.x);");
    try expectContains(f.gl_vertex, "    p_density = mix(a_particle_density.x, a_particle_density.y, u.interpolation0.x);");
    try expectContains(f.metal, "    p_color = mix(in.a_particle_color_min, in.a_particle_color_max, u.interpolation2.z);");
    // Lanes follow the emitter row; unlisted properties take their defaults.
    try expectContains(f.gl_vertex, "#define PARTICLE_DEFAULT_PARTICLE_GROWTH 1.0\n");
    try expectContains(f.gl_vertex, "#define PARTICLE_DEFAULT_PARTICLE_SIZE_CLAMP float2(0.5, 128.0)\n");
    try expectContains(f.gl_vertex, "    P.color = p_color;\n    P.colorEnd = p_color;\n");
    try expectContains(f.gl_vertex, "    P.size = float4(p_size, PARTICLE_DEFAULT_PARTICLE_GROWTH, p_stretch);\n");
    try expectContains(f.gl_vertex, "    P.emission = float4(PARTICLE_DEFAULT_PARTICLE_COUNT, PARTICLE_DEFAULT_PARTICLE_EXPLOSIVENESS, PARTICLE_DEFAULT_PARTICLE_BURST_GROUPS, packedIdentity);\n");
    try expectContains(f.gl_vertex, "    float packedIdentity = 4194304.0 * 3.0 + 1048576.0 * PARTICLE_DEFAULT_PARTICLE_SPACE + PARTICLE_DEFAULT_PARTICLE_SEED + 65536.0 * clamp(floor(p_shape + 0.5), 0.0, 9.0);\n");
    try expectContains(f.gl_vertex, "    ParticleSeed S = particleFeatureSeed(emit, p_density, ptu);\n    ParticleVertex o = particleVertex(P, F, W, S, u.camera.z);\n");

    inline for (.{ emitter_program, features_program }) |program| {
        try expectContains(program.gl_fragment, "precision highp float;\n");
        try expectContains(program.gl_fragment, "flat in vec4 v_color;");
        try expectLacks(program.gl_fragment, "out vec4 fragColor");
        try expectContains(program.vulkan_fragment, "layout(location=0) out vec4 fragColor;");
        try expectContains(program.vulkan_fragment, "layout(location=2) flat in vec4 v_look;");
        try expectContains(program.vulkan_vertex, "layout(location=2) flat out vec4 v_look;");
        try expectContains(program.metal, "float4 v_color [[flat]];");
        // MSL: the core comes before the entry points.
        const core = std.mem.indexOf(u8, program.metal, "ParticleVertex particleVertex(").?;
        const shape = std.mem.indexOf(u8, program.metal, "float4 particleFragment(").?;
        const entry = std.mem.indexOf(u8, program.metal, "\nvertex ").?;
        try std.testing.expect(core < entry and shape < entry);
        // Every name the host preludes own stays free, and the vertex id
        // (which includes Metal's base vertex) is never used.
        inline for (.{ program.gl_vertex, program.gl_fragment, program.vulkan_vertex, program.vulkan_fragment, program.metal }) |source| {
            try expectLacks(source, "const float PI");
            try expectLacks(source, "gl_VertexID");
            try expectLacks(source, "vertex_id");
            try expectLacks(source, "#version");
        }
    }
}

/// Lays out `members` under std140 (and MSL, which agrees for these types).
fn std140Offsets(comptime members: []const Member) [members.len + 1]u32 {
    var result: [members.len + 1]u32 = undefined;
    var offset: u32 = 0;
    for (members, 0..) |member, i| {
        const Layout = struct { size: u32, alignment: u32 };
        const layout: Layout = if (std.mem.eql(u8, member.type, "float4x4"))
            .{ .size = 64, .alignment = 16 }
        else if (std.mem.eql(u8, member.type, "float4"))
            .{ .size = 16, .alignment = 16 }
        else if (std.mem.eql(u8, member.type, "float2"))
            .{ .size = 8, .alignment = 8 }
        else if (std.mem.eql(u8, member.type, "float"))
            .{ .size = 4, .alignment = 4 }
        else
            unreachable;
        offset = std.mem.alignForward(u32, offset, layout.alignment);
        result[i] = offset;
        offset += layout.size;
    }
    result[members.len] = std.mem.alignForward(u32, offset, 16);
    return result;
}

test "the shader block declarations match the Zig layouts" {
    const offsets = comptime std140Offsets(&feature_members);
    try std.testing.expectEqual(@as(u32, @sizeOf(properties.FeatureUBO)), offsets[feature_members.len]);
    inline for (feature_members, 0..) |member, i| {
        const expected = if (comptime std.mem.startsWith(u8, member.name, "interpolation"))
            @offsetOf(properties.FeatureUBO, "interpolation") + 16 * @as(usize, member.name[member.name.len - 1] - '0')
        else
            @offsetOf(properties.FeatureUBO, member.name);
        try std.testing.expectEqual(@as(u32, expected), offsets[i]);
    }
    // The table's members are vec4 arrays, whose std140 stride is 16.
    try std.testing.expectEqual(@as(usize, @offsetOf(properties.TableUBO, "rows")), 16 * properties.header_vec4s);
    try std.testing.expectEqual(@as(usize, 16 * (properties.header_vec4s + properties.max_rows * properties.row_vec4s)), @sizeOf(properties.TableUBO));
}

/// A tiny preprocessor for the generated wrapper text: #if NAME, #if !NAME,
/// #ifdef, #ifndef, #else and #endif with every macro 0 or 1. Returns the
/// lines that survive.
fn preprocess(allocator: std.mem.Allocator, text: []const u8, macros: std.StringHashMapUnmanaged(bool)) ![]const []const u8 {
    var result: std.ArrayList([]const u8) = .empty;
    errdefer result.deinit(allocator);
    var stack: std.ArrayList(struct { active: bool, parent: bool }) = .empty;
    defer stack.deinit(allocator);
    var active = true;
    var lines = std.mem.splitScalar(u8, text, '\n');
    while (lines.next()) |line| {
        const trimmed = std.mem.trim(u8, line, " ");
        if (std.mem.startsWith(u8, trimmed, "#if") or std.mem.startsWith(u8, trimmed, "#ifdef") or std.mem.startsWith(u8, trimmed, "#ifndef")) {
            var tokens = std.mem.tokenizeScalar(u8, trimmed, ' ');
            const directive = tokens.next().?;
            var name = tokens.next() orelse return error.MalformedDirective;
            if (tokens.next() != null) return error.UnsupportedDirective;
            var negate = std.mem.eql(u8, directive, "#ifndef");
            if (std.mem.eql(u8, directive, "#if") and name[0] == '!') {
                negate = true;
                name = name[1..];
            }
            const value = if (std.mem.eql(u8, directive, "#if"))
                macros.get(name) orelse return error.UndefinedMacro
            else
                macros.contains(name);
            try stack.append(allocator, .{ .active = value != negate, .parent = active });
            active = active and (value != negate);
        } else if (std.mem.eql(u8, trimmed, "#else")) {
            const top = &stack.items[stack.items.len - 1];
            top.active = !top.active;
            active = top.parent and top.active;
        } else if (std.mem.eql(u8, trimmed, "#endif")) {
            const top = stack.pop() orelse return error.UnbalancedEndif;
            active = top.parent;
        } else if (std.mem.startsWith(u8, trimmed, "#")) {
            return error.UnsupportedDirective;
        } else if (active and trimmed.len > 0) {
            try result.append(allocator, trimmed);
        }
    }
    if (stack.items.len != 0) return error.UnterminatedIf;
    return result.toOwnedSlice(allocator);
}

const Declaration = struct { location: u32, name: []const u8 };

/// `layout(location=N) in T name;` or `T name [[attribute(N)]];`.
fn parseDeclaration(line: []const u8) !Declaration {
    if (std.mem.startsWith(u8, line, "layout(location=")) {
        const close = std.mem.indexOfScalar(u8, line, ')').?;
        const location = try std.fmt.parseInt(u32, line["layout(location=".len..close], 10);
        var tokens = std.mem.tokenizeAny(u8, line[close + 1 ..], " ;");
        if (!std.mem.eql(u8, tokens.next().?, "in")) return error.NotAnInput;
        _ = tokens.next();
        return .{ .location = location, .name = tokens.next().? };
    }
    const open = std.mem.indexOf(u8, line, "[[attribute(") orelse return error.NotADeclaration;
    const close = std.mem.indexOfPos(u8, line, open, ")").?;
    var tokens = std.mem.tokenizeScalar(u8, line[0..open], ' ');
    _ = tokens.next();
    return .{ .location = try std.fmt.parseInt(u32, line[open + "[[attribute(".len .. close], 10), .name = tokens.next().? };
}

test "attribute locations match the host's mapping for every data-driven mask" {
    const allocator = std.testing.allocator;
    for (0..16) |bits| {
        const mask: Mask = @intCast(bits);
        var macros: std.StringHashMapUnmanaged(bool) = .empty;
        defer macros.deinit(allocator);
        // The host's attribute list, filtered of the uniform-delivered
        // attributes (the GL mapping), and the declared ids (Vulkan, Metal).
        var filtered: std.ArrayList([]const u8) = .empty;
        defer filtered.deinit(allocator);
        try filtered.append(allocator, "a_emit");
        inline for (bindings_by_location) |binding| {
            const index: ?usize = comptime for (properties.features_data_driven, 0..) |name, i| {
                if (std.mem.eql(u8, name, binding.name)) break i;
            } else null;
            const data_driven = if (index) |i| (mask >> i) & 1 == 1 else false;
            try macros.put(allocator, comptime propertyMacro(binding.name), !data_driven);
            if (data_driven) {
                inline for (0..comptime binding.slots()) |slot| try filtered.append(allocator, comptime binding.attributeName(slot));
            }
        }
        inline for (.{ Backend.gl, Backend.vulkan, Backend.metal }) |backend| {
            const lines = try preprocess(allocator, featureAttributes(backend), macros);
            defer allocator.free(lines);
            errdefer std.debug.print("{s}, mask {b:0>4}\n", .{ @tagName(backend), bits });
            // Exactly the attributes the host delivers compile: the
            // camera-only ones never do.
            try std.testing.expectEqual(filtered.items.len, lines.len);
            for (lines) |line| {
                const declaration = try parseDeclaration(line);
                const expected = if (backend == .gl)
                    // GL: the location is the index in the filtered list.
                    declaration.location
                else for (features_attributes) |a| {
                    // Vulkan and Metal: the declared location.
                    if (std.mem.eql(u8, a.name.data[0..a.name.size], declaration.name)) break a.location;
                } else return error.UnknownAttribute;
                try std.testing.expectEqual(expected, declaration.location);
                if (backend == .gl) try std.testing.expectEqualStrings(filtered.items[declaration.location], declaration.name);
                var found = false;
                for (filtered.items) |name| found = found or std.mem.eql(u8, name, declaration.name);
                try std.testing.expect(found);
            }
        }
    }
    // The GL expectations encode an upstream host, which maps by filtered
    // index; a host with patch 0008 maps by name and takes these locations
    // too. Switching the ladder off drops hosts without 0008.
    try std.testing.expect(gl_location_ladder);
}

test "the fetched attributes are the declared ones in every mask" {
    const allocator = std.testing.allocator;
    const fetch = featureFetch("");
    for (0..16) |bits| {
        var macros: std.StringHashMapUnmanaged(bool) = .empty;
        defer macros.deinit(allocator);
        inline for (feature_bindings) |binding| {
            const index: ?usize = comptime for (properties.features_data_driven, 0..) |name, i| {
                if (std.mem.eql(u8, name, binding.name)) break i;
            } else null;
            const data_driven = if (index) |i| (bits >> i) & 1 == 1 else false;
            try macros.put(allocator, comptime propertyMacro(binding.name), !data_driven);
        }
        const declared = try preprocess(allocator, featureAttributes(.gl), macros);
        defer allocator.free(declared);
        const used = try preprocess(allocator, fetch, macros);
        defer allocator.free(used);
        for (used) |line| {
            var start: usize = 0;
            while (std.mem.indexOfPos(u8, line, start, "a_particle_")) |at| {
                var end = at;
                while (end < line.len and (std.ascii.isAlphanumeric(line[end]) or line[end] == '_')) end += 1;
                var found = false;
                for (declared) |d| found = found or std.mem.eql(u8, (try parseDeclaration(d)).name, line[at..end]);
                errdefer std.debug.print("{s} used but not declared, mask {b:0>4}\n", .{ line[at..end], bits });
                try std.testing.expect(found);
                start = end;
            }
        }
    }
}

test "plugin prelude and mask names" {
    const allocator = std.testing.allocator;
    var text: std.Io.Writer.Allocating = .init(allocator);
    defer text.deinit();
    try pluginPrelude(&text.writer, .metal, features_uniform_id, 0b0001);
    try expectContains(text.written(), "#define MLN_PLUGIN_UNIFORM_1_BINDING 2\n#define MLN_PLUGIN_UNIFORM_1_IS_ARRAY 0\n");
    try expectContains(text.written(), "#define MLN_PLUGIN_PROPERTY_PARTICLE_DENSITY_IS_UNIFORM 0\n#define MLN_PLUGIN_PROPERTY_PARTICLE_LIFETIME_IS_UNIFORM 1\n");
    try expectContains(text.written(), "#define MLN_PLUGIN_PROPERTY_PARTICLE_COLOR_IS_UNIFORM 1\n");
    const all = try maskName(allocator, 0b1111);
    defer allocator.free(all);
    try std.testing.expectEqualStrings("density-shape-size-color", all);
    const none = try maskName(allocator, 0);
    defer allocator.free(none);
    try std.testing.expectEqualStrings("none", none);
}
