//! `zig build dump-shaders -- <dir>` writes every shader program the host can
//! compile (shaders.dump: the emitter, and the features shader in all 16
//! data-driven variants) behind replicas of the host preludes, so the
//! shader-check task can compile them offline: `*.gles.vert`/`*.gles.frag`
//! as GLSL ES 3.00 (OpenGL), `*.vulkan.vert`/`*.vulkan.frag` as GLSL 450
//! (Vulkan), and `*.metal` as MSL 2.4 with fast-math (Metal).

const std = @import("std");
const shaders = @import("shaders.zig");

// ---------------------------------------------------------------------------
// Host prelude replicas. They declare every name the real preludes put in the
// plugin's namespace (MapLibre Native include/mln/shaders/{gl/prelude.hpp,
// vulkan/common.hpp, mtl/common.hpp}), so a clash fails here as it would on
// the host. Bodies are simplified.
// ---------------------------------------------------------------------------

/// OpenGL vertex: `#version 300 es`, highp, and a global `const float PI`.
pub const gl_vertex_prelude =
    \\#version 300 es
    \\#ifdef GL_ES
    \\precision highp float;
    \\#endif
    \\const float PI = 3.141592653589793;
    \\vec2 unpack_float(const float packedValue) { return vec2(packedValue); }
    \\vec2 unpack_opacity(const float packedOpacity) { return vec2(packedOpacity); }
    \\vec4 decode_color(const vec2 encodedColor) { return vec4(encodedColor, encodedColor); }
    \\float unpack_mix_vec2(const vec2 packedValue, const float t) { return mix(packedValue[0], packedValue[1], t); }
    \\vec4 unpack_mix_color(const vec4 packedColors, const float t) { return packedColors * t; }
    \\vec2 get_pattern_pos(const vec2 u, const vec2 l, const vec2 s, const float k, const vec2 p) { return u + l + s + k * p; }
    \\
;

/// OpenGL fragment: mediump by default, and the output variable.
pub const gl_fragment_prelude =
    \\#version 300 es
    \\#ifdef GL_ES
    \\precision mediump float;
    \\#endif
    \\out highp vec4 fragColor;
    \\
;

const vulkan_common_prelude =
    \\#version 450
    \\#define M_PI 3.1415926535897932384626433832795
    \\#define SDF_PX 8.0
    \\#define GLOBAL_SET_INDEX 0
    \\#define LAYER_SET_INDEX 1
    \\#define DRAWABLE_UBO_SET_INDEX 2
    \\#define DRAWABLE_IMAGE_SET_INDEX 3
    \\#define layerSSBOStartId 0
    \\#define layerUBOStartId 3
    \\#define drawableSSBOStartId 0
    \\#define drawableUBOStartId 4
    \\#define idDrawableReservedVertexOnlyUBO layerSSBOStartId
    \\#define idDrawableReservedFragmentOnlyUBO idDrawableReservedVertexOnlyUBO + 1
    \\#define drawableReservedUBOCount idDrawableReservedFragmentOnlyUBO + 1
    \\layout(set = GLOBAL_SET_INDEX, binding = 0) uniform GlobalPaintParamsUBO {
    \\    vec2 pattern_atlas_texsize;
    \\    vec2 units_to_pixels;
    \\    vec2 world_size;
    \\    float camera_to_center_distance;
    \\    float symbol_fade_change;
    \\    float aspect_ratio;
    \\    float pixel_ratio;
    \\    float map_zoom;
    \\    float pad1;
    \\} paintParams;
    \\
;

/// Vulkan vertex: `#version 450`, the set indices, the global paint block
/// and applySurfaceTransform (which also flips y).
pub const vulkan_vertex_prelude = vulkan_common_prelude ++
    \\#define LINE_NORMAL_SCALE (1.0 / (127 / 2))
    \\#define MAX_LINE_DISTANCE 32767.0
    \\vec2 unpack_float(const float packedValue) { return vec2(packedValue); }
    \\vec2 unpack_opacity(const float packedOpacity) { return vec2(packedOpacity); }
    \\vec4 decode_color(const vec2 encodedColor) { return vec4(encodedColor, encodedColor); }
    \\float unpack_mix_float(const vec2 packedValue, const float t) { return mix(packedValue[0], packedValue[1], t); }
    \\vec4 unpack_mix_color(const vec4 packedColors, const float t) { return packedColors * t; }
    \\vec2 get_pattern_pos(const vec2 u, const vec2 l, const vec2 s, const float k, const vec2 p) { return u + l + s + k * p; }
    \\vec2 unpack_int(int value) { return vec2(value); }
    \\vec2 unpack_uint(uint value) { return vec2(value); }
    \\void applySurfaceTransform() { gl_Position.y *= -1.0; }
    \\
;

/// Vulkan fragment: the same defines and global paint block.
pub const vulkan_fragment_prelude = vulkan_common_prelude;

/// Metal: metal_stdlib, the helper functions and the global paint block.
/// Fast-math and MSL 2.4 are compile options, set by the checker.
pub const metal_prelude =
    \\#include <metal_stdlib>
    \\using namespace metal;
    \\#define LINE_NORMAL_SCALE (1.0 / (127 / 2))
    \\#define MAX_LINE_DISTANCE 32767.0
    \\#define SDF_PX 8.0
    \\template <typename T1, typename T2>
    \\inline auto glMod(T1 x, T2 y) { return x - y * metal::floor(x/y); }
    \\inline float radians(float degrees) { return M_PI_F * degrees / 180.0; }
    \\float2 unpack_float(const float packedValue) { return float2(packedValue); }
    \\float2 unpack_opacity(const float packedOpacity) { return float2(packedOpacity); }
    \\float4 decode_color(const float2 encoded) { return float4(encoded, encoded); }
    \\float unpack_mix_float(const float2 packedValue, const float t) { return mix(packedValue[0], packedValue[1], t); }
    \\float4 unpack_mix_color(const float4 packedColors, const float t) { return packedColors * t; }
    \\float2 get_pattern_pos(const float2 u, const float2 l, const float2 s, const float k, const float2 p) { return u + l + s + k * p; }
    \\float interpolationFactor(float base, float rangeMin, float rangeMax, float z) { return (z - rangeMin) / (rangeMax - rangeMin) * base; }
    \\template<class ForwardIt, class T>
    \\ForwardIt upper_bound(ForwardIt first, ForwardIt last, thread const T& value) { return first; }
    \\constant const int maxExprStops = 16;
    \\struct alignas(16) GPUExpression { float inputs[maxExprStops]; };
    \\struct alignas(16) GlobalPaintParamsUBO {
    \\    float2 pattern_atlas_texsize;
    \\    float2 units_to_pixels;
    \\    float2 world_size;
    \\    float camera_to_center_distance;
    \\    float symbol_fade_change;
    \\    float aspect_ratio;
    \\    float pixel_ratio;
    \\    float map_zoom;
    \\    float pad1;
    \\};
    \\enum { idGlobalPaintParamsUBO, idGlobalUBOIndex, globalUBOCount };
    \\enum { idDrawableReservedVertexOnlyUBO = globalUBOCount, idDrawableReservedFragmentOnlyUBO, drawableReservedUBOCount };
    \\
;

pub const host_preludes = shaders.HostPreludes{
    .gl_vertex = gl_vertex_prelude,
    .gl_fragment = gl_fragment_prelude,
    .vulkan_vertex = vulkan_vertex_prelude,
    .vulkan_fragment = vulkan_fragment_prelude,
    .metal = metal_prelude,
};

pub fn main(init: std.process.Init) !void {
    const args = try init.minimal.args.toSlice(init.arena.allocator());
    if (args.len != 2) {
        std.debug.print("usage: zig build dump-shaders -- <output-dir>\n", .{});
        std.process.exit(2);
    }
    var dir = try std.Io.Dir.cwd().createDirPathOpen(init.io, args[1], .{});
    defer dir.close(init.io);
    const count = try shaders.dump(init.arena.allocator(), init.io, dir, host_preludes);
    std.debug.print("wrote {d} shader sources to {s}\n", .{ count, args[1] });
}

test "dump writes every program behind the host prelude and the plugin's defines" {
    const io = std.testing.io;
    const allocator = std.testing.allocator;
    var tmp = std.testing.tmpDir(.{ .iterate = true });
    defer tmp.cleanup();
    try std.testing.expectEqual(@as(usize, 5 * 17), try shaders.dump(allocator, io, tmp.dir, host_preludes));

    var files: usize = 0;
    var it = tmp.dir.iterate();
    while (try it.next(io)) |entry| {
        files += 1;
        const text = try tmp.dir.readFileAlloc(io, entry.name, allocator, .limited(1 << 22));
        defer allocator.free(text);
        errdefer std.debug.print("{s}\n", .{entry.name});
        const metal = std.mem.endsWith(u8, entry.name, ".metal");
        const fragment = std.mem.endsWith(u8, entry.name, ".frag");
        const features = std.mem.startsWith(u8, entry.name, "features-");
        // Host prelude, then the plugin's #defines, then the source.
        const prelude_end = std.mem.indexOf(u8, text, "#define MLN_PLUGIN_UNIFORM_").?;
        const source_start = std.mem.indexOf(u8, text, "#define float2 vec2") orelse std.mem.indexOf(u8, text, "#define PARTICLE_ATAN2").?;
        try std.testing.expect(prelude_end < source_start);
        try std.testing.expectEqual(features, std.mem.indexOf(u8, text[0..source_start], "_IS_UNIFORM ") != null);
        // Each unit carries the part of the core its stage runs, once.
        const core = std.mem.count(u8, text, "ParticleVertex particleVertex(");
        const shape = std.mem.count(u8, text, "float4 particleFragment(");
        try std.testing.expectEqual(@as(usize, if (fragment) 0 else 1), core);
        try std.testing.expectEqual(@as(usize, if (fragment or metal) 1 else 0), shape);
    }
    try std.testing.expectEqual(@as(usize, 5 * 17), files);
}
