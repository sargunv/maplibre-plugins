// The vertex attributes of the building shader, ids equal to locations, 12 of
// the 16 the plugin ABI allows. Each wrapper defines before it:
//   BUILDING_ATTRIBUTE(l, t, n)
//     GLSL (OpenGL, Vulkan, WebGL 2):  layout(location = l) in t n;
//     MSL, inside the stage_in struct: t n [[attribute(l)]];
// and the MLN_PLUGIN_PROPERTY_<NAME>_IS_UNIFORM macros (the native host
// prepends them; the WebGL 2 twin prints them for each program variant).
// A property that arrives in the uniform block has no attribute, so its
// declaration is compiled out.
//
// a_pos and a_roof come from the layout's vertex stream (7 float32: a_pos at
// byte 0, a_roof at byte 12). The rest are the host's paint bindings: a
// number packs [min, max] into one float2; a color has two UINT8_X4_NORMALIZED
// attributes (MLN_PLUGIN_PROPERTY_ENCODING_COLOR_RGBA8), min and max, which
// the shader reads as float4 in [0, 1]. building-opacity and
// building-vertical-gradient are camera only, so they are always uniform;
// their attributes exist because every host binding names one.

BUILDING_ATTRIBUTE(0, float3, a_pos)
BUILDING_ATTRIBUTE(1, float4, a_roof)
#if !MLN_PLUGIN_PROPERTY_BUILDING_HEIGHT_IS_UNIFORM
BUILDING_ATTRIBUTE(2, float2, a_height)
#endif
#if !MLN_PLUGIN_PROPERTY_BUILDING_BASE_IS_UNIFORM
BUILDING_ATTRIBUTE(3, float2, a_base)
#endif
#if !MLN_PLUGIN_PROPERTY_BUILDING_ROOF_HEIGHT_IS_UNIFORM
BUILDING_ATTRIBUTE(4, float2, a_roof_height)
#endif
#if !MLN_PLUGIN_PROPERTY_BUILDING_ROOF_ANGLE_IS_UNIFORM
BUILDING_ATTRIBUTE(5, float2, a_roof_angle)
#endif
#if !MLN_PLUGIN_PROPERTY_BUILDING_COLOR_IS_UNIFORM
BUILDING_ATTRIBUTE(6, float4, a_color_min)
BUILDING_ATTRIBUTE(7, float4, a_color_max)
#endif
#if !MLN_PLUGIN_PROPERTY_BUILDING_ROOF_COLOR_IS_UNIFORM
BUILDING_ATTRIBUTE(8, float4, a_roof_color_min)
BUILDING_ATTRIBUTE(9, float4, a_roof_color_max)
#endif
#if !MLN_PLUGIN_PROPERTY_BUILDING_OPACITY_IS_UNIFORM
BUILDING_ATTRIBUTE(10, float2, a_opacity)
#endif
#if !MLN_PLUGIN_PROPERTY_BUILDING_VERTICAL_GRADIENT_IS_UNIFORM
BUILDING_ATTRIBUTE(11, float2, a_vertical_gradient)
#endif
