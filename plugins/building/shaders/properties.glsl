// Paint-property resolution: one macro per bound paint property of
// ../spec.json, in spec order, reading the value the host bound for this
// draw, either from BuildingDrawableUBO or, for a data-driven value, from its
// attribute and the block's interpolation factor. Only the vertex stage
// includes it. A wrapper defines before it:
//   MLN_PLUGIN_PROPERTY_<NAME>_IS_UNIFORM   (see attributes.glsl)
//   BUILDING_ATTR(n)   the attribute n: `n` in GLSL, `in.n` in MSL
//   u                  the BuildingDrawableUBO block, in scope where the
//                      macros expand
//
// Composite expressions carry both ends of the zoom stop, [min, max], mixed
// by the factor. Source expressions write min = max. The booleans never
// interpolate: an attribute boolean would take max once its factor reaches 1,
// as #4685's fill-extrusion does, but vertical-gradient is camera only, so its
// branch only keeps the pattern uniform.

#if MLN_PLUGIN_PROPERTY_BUILDING_HEIGHT_IS_UNIFORM
#define BUILDING_HEIGHT (u.height)
#else
#define BUILDING_HEIGHT (mix(BUILDING_ATTR(a_height).x, BUILDING_ATTR(a_height).y, u.interpolation0.x))
#endif

#if MLN_PLUGIN_PROPERTY_BUILDING_BASE_IS_UNIFORM
#define BUILDING_BASE (u.base)
#else
#define BUILDING_BASE (mix(BUILDING_ATTR(a_base).x, BUILDING_ATTR(a_base).y, u.interpolation0.y))
#endif

#if MLN_PLUGIN_PROPERTY_BUILDING_ROOF_HEIGHT_IS_UNIFORM
#define BUILDING_ROOF_HEIGHT (u.roof_height)
#else
#define BUILDING_ROOF_HEIGHT (mix(BUILDING_ATTR(a_roof_height).x, BUILDING_ATTR(a_roof_height).y, u.interpolation0.z))
#endif

#if MLN_PLUGIN_PROPERTY_BUILDING_ROOF_ANGLE_IS_UNIFORM
#define BUILDING_ROOF_ANGLE (u.roof_angle)
#else
#define BUILDING_ROOF_ANGLE (mix(BUILDING_ATTR(a_roof_angle).x, BUILDING_ATTR(a_roof_angle).y, u.interpolation0.w))
#endif

#if MLN_PLUGIN_PROPERTY_BUILDING_COLOR_IS_UNIFORM
#define BUILDING_COLOR (u.color)
#else
#define BUILDING_COLOR (mix(BUILDING_ATTR(a_color_min), BUILDING_ATTR(a_color_max), u.interpolation1.x))
#endif

#if MLN_PLUGIN_PROPERTY_BUILDING_ROOF_COLOR_IS_UNIFORM
#define BUILDING_ROOF_COLOR (u.roof_color)
#else
#define BUILDING_ROOF_COLOR (mix(BUILDING_ATTR(a_roof_color_min), BUILDING_ATTR(a_roof_color_max), u.interpolation1.y))
#endif

#if MLN_PLUGIN_PROPERTY_BUILDING_OPACITY_IS_UNIFORM
#define BUILDING_OPACITY (u.opacity)
#else
#define BUILDING_OPACITY (mix(BUILDING_ATTR(a_opacity).x, BUILDING_ATTR(a_opacity).y, u.interpolation1.z))
#endif

#if MLN_PLUGIN_PROPERTY_BUILDING_VERTICAL_GRADIENT_IS_UNIFORM
#define BUILDING_VERTICAL_GRADIENT (u.vertical_gradient)
#else
#define BUILDING_VERTICAL_GRADIENT (u.interpolation1.w < 1.0 ? BUILDING_ATTR(a_vertical_gradient).x : BUILDING_ATTR(a_vertical_gradient).y)
#endif
