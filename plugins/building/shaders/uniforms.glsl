// The members of BuildingDrawableUBO, uniform id 0: one block per drawable
// (MLN_PLUGIN_UNIFORM_DRAWABLE), vertex stage only, 192 bytes. Wrappers put
// this text inside their declaration:
//   OpenGL, WebGL 2  layout(std140) uniform BuildingDrawableUBO { ... } u;
//   Vulkan           layout(std140, set = DRAWABLE_UBO_SET_INDEX,
//                       binding = MLN_PLUGIN_UNIFORM_0_BINDING)
//                       uniform BuildingDrawableUBO { ... } u;
//   Metal            struct alignas(16) BuildingDrawableUBO { ... };, bound as
//                    constant BuildingDrawableUBO& u
//                       [[buffer(MLN_PLUGIN_UNIFORM_0_BINDING)]]
// Every member is a float4x4, a float4 or a float, so std140 and MSL lay it
// out alike. Byte offsets, which the host's property bindings and both twins'
// tests use, are in the comments and in ../fixtures/render/contract.json.
//
// update_uniform_block (or the web twin, per tile) writes tile_matrix,
// light_color, light_position and meters_per_tile_unit and zeroes the rest;
// the host's binders then write every property's uniform value and
// interpolation factor.
    float4x4 tile_matrix;        //   0  tile units (x, y) and meters (z) to clip space,
                                 //      translate included (host-applied)
    float4 color;                //  64  building-color, when uniform (premultiplied)
    float4 roof_color;           //  80  building-roof-color, when uniform
    float4 light_color;          //  96  rgb: style light color; a: light intensity
    float4 light_position;       // 112  xyz: core's u_lightpos; w: 0
    float4 interpolation0;       // 128  factors: height, base, roof-height, roof-angle
    float4 interpolation1;       // 144  factors: color, roof-color, opacity, vertical-gradient
    float height;                // 160  building-height, when uniform
    float base;                  // 164  building-base
    float roof_height;           // 168  building-roof-height
    float roof_angle;            // 172  building-roof-angle
    float opacity;               // 176  building-opacity (camera only)
    float vertical_gradient;     // 180  building-vertical-gradient, 0 or 1 (camera only)
    float meters_per_tile_unit;  // 184  at the tile's center latitude
    float pad0;                  // 188
