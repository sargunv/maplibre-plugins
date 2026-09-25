// Shared paint-property resolution for animated icons: one macro per paint
// property that reads the value the host bound for this draw, either from
// the drawable uniform block or, for a data-driven value, from the vertex
// attribute and the block's interpolation factor. The same source compiles
// as GLSL (OpenGL, Vulkan, WebGL2) and MSL; only the vertex stage includes
// it.
//
// A host defines, before this file:
//   MLN_PLUGIN_PROPERTY_<NAME>_IS_UNIFORM
//                       1 when the property arrives in the uniform block, 0
//                       when it arrives in its attribute (the MapLibre Native
//                       host always defines each one; the WebGL2 twin
//                       prints them from its attribute layout)
//   ICON_ATTR(name)     the attribute `name`: `name` in GLSL, `in.name` in
//                       MSL
//   u                   the IconDrawableUBO block, in scope where the macros
//                       are used
//
// It provides, for each property of ../spec.json in order: ICON_ANIMATION,
// ICON_SIZE, ICON_ROTATE, ICON_OPACITY, ICON_COLOR, ICON_OFFSET,
// ICON_ANCHOR, ICON_ROTATION_ALIGNMENT, ICON_PITCH_ALIGNMENT,
// ICON_ANIMATION_SPEED, ICON_ANIMATION_OFFSET and ICON_ANIMATION_MODE.
//
// A data-driven value carries both ends of a composite expression's zoom
// stop, [min, max]: numbers and rotations pack them into one float2
// attribute (x, y) and icon-offset into one float4 (xy, zw); icon-color has
// two float4 attributes. The property's slot of u.interpolation<i/4> holds
// the factor between them. Enums are indices and never interpolate: they use
// the min end, which is also what the host's factor of 0 selects for step
// curves. The alignments are camera-only, so they always take the uniform;
// their attribute branches only keep the pattern uniform.

#if MLN_PLUGIN_PROPERTY_ICON_ANIMATION_IS_UNIFORM
#define ICON_ANIMATION (u.icon_animation)
#else
#define ICON_ANIMATION (ICON_ATTR(a_icon_animation).x)
#endif

#if MLN_PLUGIN_PROPERTY_ICON_SIZE_IS_UNIFORM
#define ICON_SIZE (u.icon_size)
#else
#define ICON_SIZE (mix(ICON_ATTR(a_icon_size).x, ICON_ATTR(a_icon_size).y, u.interpolation0.y))
#endif

#if MLN_PLUGIN_PROPERTY_ICON_ROTATE_IS_UNIFORM
#define ICON_ROTATE (u.icon_rotate)
#else
#define ICON_ROTATE (mix(ICON_ATTR(a_icon_rotate).x, ICON_ATTR(a_icon_rotate).y, u.interpolation0.z))
#endif

#if MLN_PLUGIN_PROPERTY_ICON_OPACITY_IS_UNIFORM
#define ICON_OPACITY (u.icon_opacity)
#else
#define ICON_OPACITY (mix(ICON_ATTR(a_icon_opacity).x, ICON_ATTR(a_icon_opacity).y, u.interpolation0.w))
#endif

#if MLN_PLUGIN_PROPERTY_ICON_COLOR_IS_UNIFORM
#define ICON_COLOR (u.icon_color)
#else
#define ICON_COLOR (mix(ICON_ATTR(a_icon_color_min), ICON_ATTR(a_icon_color_max), u.interpolation1.x))
#endif

#if MLN_PLUGIN_PROPERTY_ICON_OFFSET_IS_UNIFORM
#define ICON_OFFSET (u.icon_offset)
#else
#define ICON_OFFSET (mix(ICON_ATTR(a_icon_offset).xy, ICON_ATTR(a_icon_offset).zw, u.interpolation1.y))
#endif

#if MLN_PLUGIN_PROPERTY_ICON_ANCHOR_IS_UNIFORM
#define ICON_ANCHOR (u.icon_anchor)
#else
#define ICON_ANCHOR (ICON_ATTR(a_icon_anchor).x)
#endif

#if MLN_PLUGIN_PROPERTY_ICON_ROTATION_ALIGNMENT_IS_UNIFORM
#define ICON_ROTATION_ALIGNMENT (u.icon_rotation_alignment)
#else
#define ICON_ROTATION_ALIGNMENT (ICON_ATTR(a_icon_rotation_alignment).x)
#endif

#if MLN_PLUGIN_PROPERTY_ICON_PITCH_ALIGNMENT_IS_UNIFORM
#define ICON_PITCH_ALIGNMENT (u.icon_pitch_alignment)
#else
#define ICON_PITCH_ALIGNMENT (ICON_ATTR(a_icon_pitch_alignment).x)
#endif

#if MLN_PLUGIN_PROPERTY_ICON_ANIMATION_SPEED_IS_UNIFORM
#define ICON_ANIMATION_SPEED (u.icon_animation_speed)
#else
#define ICON_ANIMATION_SPEED (mix(ICON_ATTR(a_icon_animation_speed).x, ICON_ATTR(a_icon_animation_speed).y, u.interpolation2.y))
#endif

#if MLN_PLUGIN_PROPERTY_ICON_ANIMATION_OFFSET_IS_UNIFORM
#define ICON_ANIMATION_OFFSET (u.icon_animation_offset)
#else
#define ICON_ANIMATION_OFFSET (mix(ICON_ATTR(a_icon_animation_offset).x, ICON_ATTR(a_icon_animation_offset).y, u.interpolation2.z))
#endif

#if MLN_PLUGIN_PROPERTY_ICON_ANIMATION_MODE_IS_UNIFORM
#define ICON_ANIMATION_MODE (u.icon_animation_mode)
#else
#define ICON_ANIMATION_MODE (ICON_ATTR(a_icon_animation_mode).x)
#endif
