// The shader sections the OpenGL sources of the native plugin
// (native/src/plugin.zig) and the WebGL2 sources of the JS layer
// (js/src/shaders.ts) carry verbatim, each between its begin and end
// markers. Both test suites check their sources against this file, so a
// change to a section changes both twins and this file together.
// plugin.zig generates it: `zig build test` prints the expected text when
// it differs.

// begin:attributes
layout(location=0) in vec2 a_pos;
#if !MLN_PLUGIN_PROPERTY_ICON_ANIMATION_IS_UNIFORM
layout(location=1) in vec2 a_icon_animation;
#endif
#if !MLN_PLUGIN_PROPERTY_ICON_SIZE_IS_UNIFORM
layout(location=2) in vec2 a_icon_size;
#endif
#if !MLN_PLUGIN_PROPERTY_ICON_ROTATE_IS_UNIFORM
layout(location=3) in vec2 a_icon_rotate;
#endif
#if !MLN_PLUGIN_PROPERTY_ICON_OPACITY_IS_UNIFORM
layout(location=4) in vec2 a_icon_opacity;
#endif
#if !MLN_PLUGIN_PROPERTY_ICON_COLOR_IS_UNIFORM
layout(location=5) in vec4 a_icon_color_min;
layout(location=6) in vec4 a_icon_color_max;
#endif
#if !MLN_PLUGIN_PROPERTY_ICON_OFFSET_IS_UNIFORM
layout(location=7) in vec4 a_icon_offset;
#endif
#if !MLN_PLUGIN_PROPERTY_ICON_ANCHOR_IS_UNIFORM
layout(location=8) in vec2 a_icon_anchor;
#endif
#if !MLN_PLUGIN_PROPERTY_ICON_ROTATION_ALIGNMENT_IS_UNIFORM
layout(location=9) in vec2 a_icon_rotation_alignment;
#endif
#if !MLN_PLUGIN_PROPERTY_ICON_PITCH_ALIGNMENT_IS_UNIFORM
layout(location=10) in vec2 a_icon_pitch_alignment;
#endif
#if !MLN_PLUGIN_PROPERTY_ICON_ANIMATION_SPEED_IS_UNIFORM
layout(location=11) in vec2 a_icon_animation_speed;
#endif
#if !MLN_PLUGIN_PROPERTY_ICON_ANIMATION_OFFSET_IS_UNIFORM
layout(location=12) in vec2 a_icon_animation_offset;
#endif
#if !MLN_PLUGIN_PROPERTY_ICON_ANIMATION_MODE_IS_UNIFORM
layout(location=13) in vec2 a_icon_animation_mode;
#endif
// end:attributes

// begin:drawable-ubo
layout(std140) uniform IconDrawableUBO {
    mat4 matrix;                    //   0  tile matrix
    vec4 camera;                    //  64  pixels_to_gl.x, pixels_to_gl.y, pixels_to_tile_units, camera_to_center_distance
    vec4 view;                      //  80  pixel_ratio, bearing (radians, the host's sign), 0, 0
    vec4 icon_color;                //  96
    vec2 icon_offset;               // 112
    float icon_animation;           // 120
    float icon_size;                // 124
    float icon_rotate;              // 128
    float icon_opacity;             // 132
    float icon_anchor;              // 136
    float icon_rotation_alignment;  // 140
    float icon_pitch_alignment;     // 144
    float icon_animation_speed;     // 148
    float icon_animation_offset;    // 152
    float icon_animation_mode;      // 156
    vec4 interpolation0;            // 160  properties 0-3
    vec4 interpolation1;            // 176  properties 4-7
    vec4 interpolation2;            // 192  properties 8-11
} u;
// end:drawable-ubo

// begin:catalog-ubo
layout(std140) uniform IconCatalogUBO {
    highp vec4 clock;                          // x: seconds in [0, 4096)
    highp vec4 entries[2 * ICON_ENTRY_COUNT];  // entry e: [2e] box, [2e + 1] (display_px, loop_rate, frame_count, frame_texel)
} catalog;
// end:catalog-ubo

// begin:varyings-out
out vec2 v_uv;
flat out vec4 v_icon;
flat out vec4 v_color;
// end:varyings-out

// begin:varyings-in
in vec2 v_uv;
flat in vec4 v_icon;
flat in vec4 v_color;
// end:varyings-in

// begin:vertex-main
void main() {
    IconVertex v = iconPlace(a_pos,
        float4(ICON_ANIMATION, ICON_SIZE, ICON_ROTATE, ICON_OPACITY),
        float4(ICON_ANCHOR, ICON_ROTATION_ALIGNMENT, ICON_PITCH_ALIGNMENT, 0.0),
        ICON_OFFSET,
        float4(ICON_ANIMATION_SPEED, ICON_ANIMATION_OFFSET, ICON_ANIMATION_MODE, 0.0),
        u.camera, u.view.xy ICON_PLACE_ARG);
    gl_Position = v.position;
    v_uv = v.uv;
    v_icon = vec4(v.frame, ICON_OPACITY, 0.0, 0.0);
    v_color = ICON_COLOR;
}
// end:vertex-main

// begin:fragment-main
void main() {
    fragColor = iconShade(v_uv, v_icon.x, v_color, vec4(0.0), v_icon.y ICON_ART_ARG);
}
// end:fragment-main
